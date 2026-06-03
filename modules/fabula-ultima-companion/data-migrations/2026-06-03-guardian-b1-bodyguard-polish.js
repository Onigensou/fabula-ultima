/**
 * Migration: 2026-06-03-guardian-b1-bodyguard-polish
 * ---------------------------------------------------------------------------
 * Three live-test polish items on the freshly-wired Bodyguard:
 *
 *   1. AE icon — use the Bodyguard skill item's `img` so the token icon
 *      ring shows the skill's image instead of Foundry's default empty
 *      icon. statuses[] is already populated ("fud-bodyguard") for V12
 *      token-ring rendering.
 *
 *   2. AE duration — set `duration.rounds = 1` so the global director-AE
 *      tick (`tickDirectorAEsForApplier`, homebrew rule
 *      [[ae-default-3-turn-duration]]) decrements to 0 at the guarder's
 *      next TurnStart and batch-deletes the AE. Mirrors the refactored
 *      Guard / Cover lifecycle.
 *
 *   3. reaction_passive_mode → "force" — Bodyguard always fires per RAW
 *      ("the covered creature gains Resistance"); the player has no
 *      decision, so per force-mode-canonical-rows the reaction shouldn't
 *      surface a pill / menu entry. The applied AE on the covered ally
 *      is still visible via its token icon — Force hides only the
 *      reaction-UI surface on the guarder side.
 *
 * Scope: BD-tree masters + actor copies matched by name + template id.
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-03-guardian-b1-bodyguard-polish";
export const description =
  "Bodyguard polish — AE icon = skill img, duration.rounds = 1 (global " +
  "tick handles expiry), reaction_passive_mode → 'force'.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

async function patchBodyguardItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};
  const skillImg = item.img ?? null;

  // 1. reaction_passive_mode → "force".
  const rct = p.reaction_config_table ?? {};
  let rctNext = null;
  for (const [k, row] of Object.entries(rct)) {
    if (!row || typeof row !== "object") continue;
    if (row.reaction_trigger !== "creature_guards") continue;
    if (row.reaction_passive_mode === "force") continue;
    if (!rctNext) rctNext = foundry.utils.duplicate(rct);
    rctNext[k] = { ...row, reaction_passive_mode: "force" };
  }
  if (rctNext) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": rctNext });
    log(`  ${ownerLabel} Bodyguard: reaction_passive_mode → force`);
    touched = true;
  }

  // 2. AE template — icon + duration.rounds.
  const existing = item.effects?.contents?.find((e) => e.name === "Bodyguard");
  if (!existing) {
    log(`  ${ownerLabel} Bodyguard: no AE template — skipping AE polish`);
    return touched;
  }

  const aeUpdates = {};

  const wantIcon = skillImg;
  if (wantIcon && existing.icon !== wantIcon) {
    aeUpdates.icon = wantIcon;
  }

  const currentRounds = existing.duration?.rounds;
  if (currentRounds !== 1) {
    aeUpdates.duration = {
      ...(existing.duration ?? {}),
      rounds: 1,
      // Keep other duration fields null/default — the global tick reads
      // turnsRemaining (stamped at apply-time), not these.
      turns:  existing.duration?.turns  ?? null,
      type:   "rounds",
    };
  }

  if (Object.keys(aeUpdates).length) {
    await existing.update(aeUpdates);
    const what = [];
    if (aeUpdates.icon) what.push(`icon=skill.img`);
    if (aeUpdates.duration) what.push(`duration.rounds=1`);
    log(`  ${ownerLabel} Bodyguard AE: ${what.join(", ")}`);
    touched = true;
  }

  return touched;
}

export async function migrate(game, log) {
  let masters = 0;
  let copies = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Bodyguard") continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    if (await patchBodyguardItem(item, log, "master")) masters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Bodyguard") continue;
      if (!templateMatches(item)) continue;
      if (await patchBodyguardItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Bodyguard polish: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
