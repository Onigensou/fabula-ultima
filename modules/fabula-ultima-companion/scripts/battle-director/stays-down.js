// Stays down — `creature_stays_down` ("When a creature is reduced to 0 HP and not revived").
//
// The defeat reactor (defeat-reactor.js) fires this for a creature still at 0 HP after
// every immediate revive had its say: an onlooker's `creature_defeated` heal, and the
// creature's own `creature_knocked_out` Auto-Life / Reraise. Observers only: the fallen
// creature's own rows never answer it. First consumer: Nidhogg's Zero Trigger "Nox
// Servant" (docs/nidhogg-boss-design.md §4c item 7), which raises the fallen player.
//
// That reaction can save the LAST standing member of a side, so the side wipe has to
// wait for it. The wipe is checked at the HP write (state-handlers installSideWipeWatcher),
// BEFORE the settle runs the defeat reactor, so state-handlers sideIsWiped asks
// `holdsStaysDown` (sync, structural, like holdsKnockoutRevive). Three states per actor:
//   - not begun, no KO marker yet  → the reactor has not reached it: hold (if a live
//     onlooker carries a matching stays-down row);
//   - in flight (beginStaysDown…endStaysDown) → hold, same condition;
//   - settled (markStaysDownSettled: the emit ran and it is still down) → no hold.
// A creature with its KO marker and nothing in flight is not held either: that covers a
// creature that started the fight at 0, or was set to 0 off the ledger, so the hold can
// never block a real wipe forever. Both sets are in memory (like knockout-revive's
// `_tried`); after an F5 the hold falls back to "KO marker present → no hold" (fail-safe).
//
// Leaf module: no imports, Node-testable (stays-down.test.mjs).

export const STAYS_DOWN_TRIGGER = "creature_stays_down";
const NS = "fabula-ultima-companion";

const _inFlight = new Map();   // actor uuid → how many defeat reactors are between "down" and "settled" (a counter: overlapping falls must not release each other)
// actor uuid → the battle (dCombat) in which this fall's stays-down emit ran, still down.
// Scoped to the battle: a PC who ended one fight down and was raised off the ledger (a
// rest writes HP straight) must not count as settled in the next fight, or its next fall
// would neither hold the wipe nor emit.
const _settled = new Map();

export function beginStaysDown(actor) { if (actor?.uuid) _inFlight.set(actor.uuid, (_inFlight.get(actor.uuid) ?? 0) + 1); }
export function endStaysDown(actor) {
  if (!actor?.uuid) return;
  const n = (_inFlight.get(actor.uuid) ?? 0) - 1;
  if (n > 0) _inFlight.set(actor.uuid, n); else _inFlight.delete(actor.uuid);
}
export function markStaysDownSettled(actor, dc = null) { if (actor?.uuid) _settled.set(actor.uuid, dc ?? null); }
export function clearStaysDownSettled(actor) { if (actor?.uuid) _settled.delete(actor.uuid); }
/** Has this fall's stays-down emit already run in battle `dc` (and the creature is still down)? Once-per-fall gate. */
export function isStaysDownSettled(actor, dc = null) {
  return !!actor?.uuid && _settled.has(actor.uuid) && _settled.get(actor.uuid) === (dc ?? null);
}
/** Test hook: forget every mark. */
export function _resetStaysDown() { _inFlight.clear(); _settled.clear(); }

const list = (c) => (Array.isArray(c) ? c : (c?.contents ?? (c ? Object.values(c) : [])));

// Live stays-down rows in a reaction blob (item reaction_config_table / AE reactionConfig).
// Same walk as knockout-revive.hasKnockoutRow: a row object holds `reaction_trigger`.
function collectRows(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 3) return out;
  if (String(node.reaction_trigger ?? "").trim() === STAYS_DOWN_TRIGGER) {
    if (!node.$deleted && String(node.reaction_passive_mode ?? "").trim().toLowerCase() !== "off") {
      out.push({ source: String(node.reaction_source ?? "").trim().toLowerCase() });
    }
    return out;
  }
  for (const v of Object.values(node)) collectRows(v, out, depth + 1);
  return out;
}

/** Live, non-off rows on `creature_stays_down` in an actor's items + applied AEs → [{ source }]. */
export function staysDownRowsOf(actor) {
  const out = [];
  if (!actor) return out;
  try {
    for (const it of list(actor.items)) collectRows(it?.system?.props?.reaction_config_table, out);
    for (const ae of list(actor.appliedEffects ?? actor.effects)) {
      if (ae?.disabled) continue;
      collectRows(ae?.flags?.[NS]?.reactionConfig, out);
    }
  } catch { return []; }
  return out;
}

// Would a row with `reaction_source` `source` on a reactor at `reactorSide` match a subject at
// `subjectSide`? Side-based mirror of skill-effects subjectMatchesSource (dispositions there):
// party/hostile are absolute (the subject's side), ally/enemy are relative. An unknown value
// matches (as there): a generous guess only holds a little longer, the settle releases it.
export function sourceCovers(source, reactorSide, subjectSide) {
  const s = String(source ?? "").trim().toLowerCase();
  if (!s || s === "all") return true;
  if (s === "self" || s === "neutral") return false;   // observers only; no neutral side in dCombat
  if (s === "party") return subjectSide === "party";
  if (s === "hostile") return subjectSide === "enemy";
  if (s === "ally") return reactorSide === subjectSide;
  if (s === "enemy") return !!reactorSide && !!subjectSide && reactorSide !== subjectSide;
  return true;
}

// The KO marker (defeat-reactor isKoAE): an enabled AE flagged bdDefeated.
function hasKoMarker(actor) {
  try {
    return list(actor?.effects).some((e) => e && e.disabled !== true && e.flags?.[NS]?.bdDefeated === true);
  } catch { return false; }
}

function isDown(c) {
  return !!(c?.defeated || (typeof c?.isDefeatedLive === "function" && c.isDefeatedLive()));
}

/** Sync, for sideIsWiped: is downed combatant `c` still waiting on an onlooker's stays-down row? */
export function holdsStaysDown(dc, c) {
  const a = c?.actorDoc;
  if (!a?.uuid || isStaysDownSettled(a, dc)) return false;
  // Nothing pending: its KO landed and no defeat reactor is mid-flight on it.
  if (!_inFlight.has(a.uuid) && hasKoMarker(a)) return false;
  return hasStaysDownReactor(dc, c);
}

/** Does a live (not downed) onlooker of `c` carry a stays-down row that covers `c`'s side? Structural, sync. */
export function hasStaysDownReactor(dc, c) {
  const a = c?.actorDoc;
  if (!a?.uuid) return false;
  const all = Array.isArray(dc?.combatants) ? dc.combatants : Object.values(dc?.combatants ?? {});
  return all.some((o) => o && o !== c && o.actorDoc && o.actorDoc.uuid !== a.uuid && !isDown(o)
    && staysDownRowsOf(o.actorDoc).some((r) => sourceCovers(r.source, o.side, c.side)));
}
