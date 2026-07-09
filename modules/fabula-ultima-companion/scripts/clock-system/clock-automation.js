// ============================================================================
// Clock System — Battle Director automation bridge.
//
// A clock's `automation` array is DATA, not code. Each row says "when the
// director fires this trigger, and these filters pass, move this clock":
//
//     automation: [
//       { trigger: "creature_defeated", subject: "enemy", side: "players", sections: 1 },
//       { trigger: "round_end",         side: "gm",       sections: 1, cause: "the ritual advances" },
//       { trigger: "creature_fumbles_check", side: "gm",  sections: 2, once: true },
//     ]
//
// The full 26-trigger vocabulary from director-triggers.js is available; see
// that file for what each one means and what its payload carries.
//
// ── How the events arrive ───────────────────────────────────────────────────
// Battle Director dispatches its triggers only to reaction rows. Phase 7 added
// ONE additive line to firePassiveTriggers that re-broadcasts each trigger as
// `fu-director-trigger`. That is the entire BD footprint of this feature, and
// any future subsystem gets the same observation seam.
//
// ── Dedupe ──────────────────────────────────────────────────────────────────
// The hook fires on the client running the director. We additionally gate on
// `isActiveGM()` so that a two-GM table cannot double-apply a row, and so the
// rule can never be relayed back over the socket from a non-writer. This is
// the standard idiom — see [[project_gm_host_dedupe_pattern]].
// ============================================================================

import { CLOCK_TAG, CLOCK_HOOK, CLOCK_STATE, SIDE } from "./clock-const.js";
import * as store from "./clock-store.js";

// ── Conditions ──────────────────────────────────────────────────────────────
//
// Deliberately NOT a formula language. BD already has one, and reimplementing
// its identifiers here would be a second dialect to keep in sync. Instead a row
// may name a predicate registered by whoever authored the content:
//
//     FUCompanion.api.clocks.automation.registerCondition(
//       "bossIsBloodied", ({ casterActor }) => hpFraction(casterActor) < 0.5);
//
//     { trigger: "turn_end", condition: "bossIsBloodied", side: "gm", sections: 1 }

const _conditions = new Map();

export function registerCondition(name, fn) {
  if (typeof fn !== "function") throw new Error("[FU][Clock] condition must be a function");
  _conditions.set(String(name), fn);
}

export function hasCondition(name) { return _conditions.has(String(name)); }

function _conditionPasses(row, event) {
  if (!row.condition) return true;
  const fn = _conditions.get(String(row.condition));
  if (!fn) {
    console.warn(CLOCK_TAG, `automation row names unknown condition "${row.condition}" — row skipped`);
    return false;
  }
  try { return Boolean(fn(event)); }
  catch (e) { console.warn(CLOCK_TAG, `condition "${row.condition}" threw — row skipped`, e); return false; }
}

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * `subject`: whose event was it? BD normalizes disposition, so player-ownership
 * is the reliable read (the same gate the enemy autopilot uses).
 */
function _subjectMatches(row, casterActor) {
  const want = row.subject ?? "any";
  if (want === "any") return true;
  const isPlayer = Boolean(casterActor?.hasPlayerOwner);
  return want === "player" ? isPlayer : !isPlayer;
}

/** `skill`: match a named skill carried on the payload (creature_completes_skill et al.). */
function _skillMatches(row, payload) {
  if (!row.skill) return true;
  const name = payload?.skillName ?? payload?.actionName ?? null;
  return String(name ?? "").toLowerCase() === String(row.skill).toLowerCase();
}

/** A stable cause string, also used as the `once` fingerprint. */
function _causeFor(row, index) {
  return row.cause ?? `auto:${row.trigger}:${index}`;
}

/** `once`: has a row with this cause already moved this clock? */
function _alreadyFired(clock, cause) {
  return clock.history.some((h) => h.cause === cause);
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** Exported for the headless matcher tests. Pure: no store, no Foundry. */
export function rowApplies(clock, row, index, event) {
  if (row.trigger !== event.trigger) return false;
  if (!_subjectMatches(row, event.casterActor)) return false;
  if (!_skillMatches(row, event.payload)) return false;
  if (row.once && _alreadyFired(clock, _causeFor(row, index))) return false;
  if (!_conditionPasses(row, event)) return false;
  return true;
}

/**
 * Apply one row. A row that names a `side` pushes toward that side's pole; a
 * row with an explicit `direction` moves the axis regardless of ownership.
 *
 * `mode: "check"` re-uses the RAW advancement rules when the payload carries a
 * check — the sections come from the margin instead of the row.
 */
async function _applyRow(clock, row, index, event) {
  const cause = _causeFor(row, index);

  if (row.mode === "check") {
    const p = event.payload ?? {};
    const result = p.checkResult ?? p.result ?? null;
    const difficulty = p.difficulty ?? p.dl ?? null;
    if (result == null || (difficulty == null && p.opposedResult == null)) {
      console.warn(CLOCK_TAG, `row mode:"check" on trigger "${row.trigger}" but the payload carries no check`);
      return;
    }
    await store.check(clock.id, {
      result, difficulty, opposedResult: p.opposedResult ?? null,
      isCritical: Boolean(p.isCrit ?? p.isCritical),
      isFumble: Boolean(p.isFumble),
      spendOpportunity: Boolean(row.spendOpportunity),
      side: row.side, cause,
    });
    return;
  }

  await store.advance(clock.id, {
    side: row.side ?? SIDE.GM,
    sections: Number(row.sections ?? 1),
    direction: row.direction ?? null,
    cause,
    actorUuid: event.casterActor?.uuid ?? null,
  });
}

async function _onDirectorTrigger(event) {
  // One writer. Without this, a second GM would apply every row a second time.
  if (!store.isActiveGM()) return;

  for (const clock of store.list({ state: CLOCK_STATE.ACTIVE })) {
    if (!clock.automation?.length) continue;

    for (const [index, row] of clock.automation.entries()) {
      if (!rowApplies(clock, row, index, event)) continue;
      try {
        await _applyRow(clock, row, index, event);
      } catch (e) {
        console.warn(CLOCK_TAG, `automation row ${index} on "${clock.name}" failed`, e);
      }
      // Re-read: the row we just applied may have resolved the clock, and a
      // resolved clock must not take a second row from the same event.
      const fresh = store.get(clock.id);
      if (fresh?.state !== CLOCK_STATE.ACTIVE) break;
    }
  }
}

let _wired = false;

export function wireClockAutomation() {
  if (_wired) return;
  _wired = true;

  Hooks.on(CLOCK_HOOK.DIRECTOR_TRIGGER, (event) => {
    _onDirectorTrigger(event).catch((e) => console.warn(CLOCK_TAG, "automation dispatch threw", e));
  });

  console.debug(CLOCK_TAG, "automation wired to fu-director-trigger");
}

// Guarded so the matcher above can be imported by the headless harness, which
// has no Foundry globals.
if (typeof Hooks !== "undefined") {
  Hooks.once("ready", () => {
    try {
      wireClockAutomation();
      const a = globalThis.FUCompanion?.api?.clocks;
      if (a) a.automation = { registerCondition, hasCondition };
    } catch (e) {
      console.warn(CLOCK_TAG, "automation bootstrap failed", e);
    }
  });
}
