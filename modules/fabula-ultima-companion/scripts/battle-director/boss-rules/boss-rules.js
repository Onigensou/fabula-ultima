// ============================================================================
// Boss rules — a boss's own fight rules, pinned to the boss, read by the engine
// at a few fixed seams. Generic: nothing here names a boss (like undying.js).
// First user: the Boss Cycle (boss-cycle.js — a boss with a core; Nidhogg's crystal).
//
// Why not a conflict event: the conflict-event slot is the scene's, and events
// do not stack (Nidhogg's arena already runs Soul Tithe). A boss rule rides on
// top of whatever event the scene runs.
//
// A rule: {
//   id,
//   claims(director)               -> true when this battle is this rule's
//   ownsFall?(actor, director)     -> true: the rule plays this actor's fall itself
//                                     (defeat-reactor skips the Champion fall + KO
//                                     status; on-defeat reactions still fire)
//   onConflictStart?(director)     -> awaited once, at conflict start (GM)
//   pendingBeat?(director, where)  -> awaited at a state boundary: where =
//                                     "turn_end" (before nextTurn) | "turn_start" |
//                                     "round_start"; returns { cut: true } when it
//                                     ended the round early (every turn spent), or null
//   roundEndTrigger?(director)     -> "none" to fire no round_end reactions this time
//   skipsRoundEndSweep?(director)  -> true: "until end of round" effects carry over
//   holdsConflictEvent?(director)  -> true: the conflict event's round-end beat is
//                                     skipped at this boundary
//   roundBoundary?(director)       -> awaited at ROUND_START before the new round's
//                                     turns are dealt; may return { label } for the
//                                     round banner
//   stage?(director)               -> the fight's stage as a number (sync), read by
//                                     the BOSS_STAGE formula identifier — a boss kit
//                                     escalates on it (Nidhogg: his crystal's cracks)
// }
// Every seam is `rule?.x(...) ?? <the old value>`: with no rule claiming the
// battle, nothing changes. A rule that throws is logged and ignored.
// ============================================================================

import { warn } from "../logger.js";

const RULES = new Map();

export function registerBossRule(rule) {
  if (!rule?.id || typeof rule.claims !== "function") { warn("boss-rules: a rule needs an id and claims()"); return; }
  RULES.set(rule.id, rule);
}
export const bossRuleIds = () => [...RULES.keys()];

/** The rules claiming this battle. */
export function activeBossRules(director) {
  const out = [];
  for (const r of RULES.values()) {
    try { if (r.claims(director)) out.push(r); } catch (e) { warn(`boss-rules: ${r.id}.claims threw`, e); }
  }
  return out;
}

const some = (director, fn, name) => {
  for (const r of activeBossRules(director)) {
    if (typeof r[name] !== "function") continue;
    try { if (fn(r)) return true; } catch (e) { warn(`boss-rules: ${r.id}.${name} threw`, e); }
  }
  return false;
};

/** Does a boss rule play this actor's fall itself? */
export function bossRuleOwnsFall(actor, director) {
  if (!actor || !director) return false;
  for (const r of activeBossRules(director)) {
    if (typeof r.ownsFall !== "function") continue;
    try { if (r.ownsFall(actor, director)) return true; } catch (e) { warn(`boss-rules: ${r.id}.ownsFall threw`, e); }
  }
  return false;
}

export async function runBossConflictStart(director) {
  for (const r of activeBossRules(director)) {
    if (typeof r.onConflictStart !== "function") continue;
    try { await r.onConflictStart(director); } catch (e) { warn(`boss-rules: ${r.id}.onConflictStart threw — the battle goes on without it`, e); }
  }
}

/** Run every claiming rule's pending beat at this boundary. -> { cut } */
export async function runBossPendingBeat(director, where) {
  let cut = false;
  for (const r of activeBossRules(director)) {
    if (typeof r.pendingBeat !== "function") continue;
    try { const res = await r.pendingBeat(director, where); if (res?.cut) cut = true; }
    catch (e) { warn(`boss-rules: ${r.id}.pendingBeat (${where}) threw — the battle goes on`, e); }
  }
  return { cut };
}

/** The round_end trigger a rule wants this time, or null (the engine's own). */
export function bossRoundEndTrigger(director) {
  for (const r of activeBossRules(director)) {
    if (typeof r.roundEndTrigger !== "function") continue;
    try { const t = r.roundEndTrigger(director); if (t) return t; } catch (e) { warn(`boss-rules: ${r.id}.roundEndTrigger threw`, e); }
  }
  return null;
}
export const bossSkipsRoundEndSweep = (director) => some(director, (r) => r.skipsRoundEndSweep(director), "skipsRoundEndSweep");
export const bossHoldsConflictEvent = (director) => some(director, (r) => r.holdsConflictEvent(director), "holdsConflictEvent");

/** The fight's stage (BOSS_STAGE): the highest any claiming rule reports, 0 with none. Sync, never throws. */
export function bossStage(director) {
  if (!director) return 0;
  let best = 0;
  for (const r of activeBossRules(director)) {
    if (typeof r.stage !== "function") continue;
    try { const n = Number(r.stage(director)); if (Number.isFinite(n) && n > best) best = n; }
    catch (e) { warn(`boss-rules: ${r.id}.stage threw`, e); }
  }
  return best;
}

/** At ROUND_START, before the turns are dealt. -> { label } | null */
export async function runBossRoundBoundary(director) {
  let label = null;
  for (const r of activeBossRules(director)) {
    if (typeof r.roundBoundary !== "function") continue;
    try { const res = await r.roundBoundary(director); if (res?.label) label = res.label; }
    catch (e) { warn(`boss-rules: ${r.id}.roundBoundary threw`, e); }
  }
  return label ? { label } : null;
}
