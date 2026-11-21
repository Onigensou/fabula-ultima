// ============================================================================
// Boss Cycle — a boss with a CORE: defeat the boss to expose the core for a
// round (or more), break the core to win; the boss returns if the core survives.
// General: the whole loop is driven by DATA on the boss actor. First user:
// Nidhogg (docs/nidhogg-boss-design.md §1–§3, §6, §6f): the dragon is the boss,
// his crystal body is the core.
//
// The boss actor's settings (flags.<ns>.bossCycle; readCycleConfig normalises):
//   core               world actor id of the core (spawned at conflict start)
//   coreStandsAt       "boss" — the core's feet on the boss's feet (only option today)
//   exposeRounds       rounds the core stays exposed (1)
//   cutRound           the round the boss fell in ends at once: every turn left is
//                      lost, no round_end reactions (true)
//   carryRoundEffects  with cutRound: "until the end of the round" effects carry
//                      over into the exposed round (true) — except AEs flagged
//                      endsOnCutRound, which end at the fall (shared/round-end-sweep.js)
//   holdConflictEvent  the scene's conflict event skips its round-end beat from the
//                      fall to the return (true; Soul Tithe neither locks nor Calls)
//   clearStatusesOnDown  the boss's buffs / debuffs are cleansed on the fall (true)
//   onDown             { conflictEventAction } run when the boss's hold breaks
//   returnHp / returnMp  "full" | "keep" (full)
//   roundLabel         the round banner's name for an exposed round ("")
//   transition         { first, repeat, return } named shows (boss-cycle-styles.js)
//   stage              what BOSS_STAGE reads ("core-hp-quarters")
//   voidWhileExposed   the arena goes pitch black from the fall to the return (false)
//   permanentExpose    { whenEveryPcHas, coreGainFraction, transition } or absent (off).
//                      The moment EVERY player character of the battle carries an enabled AE
//                      with flags.<ns>[whenEveryPcHas] === true (Nidhogg: "noxServant", the
//                      Oath of Servitude, docs §4c item 8), the boss withdraws (HP 0, the
//                      ordinary fall, or transition when set), the core's current AND max HP
//                      rise by floor(boss HP left * coreGainFraction), and the core stays
//                      exposed until the battle ends: the boss never returns.
//
// While the boss fights, the core stands OUT OF PLAY (out-of-play.js: hidden,
// untargetable, no turns) but alive, so the side is never wiped by the boss's
// fall. The boss at 0 HP → at the END of that turn (the action and its
// reactions have settled) the transition plays; the boss goes out of play, the
// core comes into play; the round is cut; the next round is exposed. At the
// last exposed round's end (round_end reactions as usual), at the next ROUND_START,
// the boss returns: through transition.return when set (the core out of play at
// its hidden beat, the boss back at its reveal, the new round after its end),
// else at once; the core goes out of play again.
// The core broken → its own defeat (style) → victory. The core pays no rewards
// of its own if its actor carries noRewards.
//
// State: an AE on the core ("Boss Cycle", flags.<ns>.bossCycleState =
// { phase, cycle, exposedLeft, permanent, oath, ascTickRound, ascended }) — survives
// F5, rewinds with the actor, replicates; every client reads it for the void.
//   active ─(boss at 0, at a boundary)─► falling ─(hidden beat)─► down
//   down ─(ROUND_START)─► exposed ─(after exposeRounds, ROUND_START; reveal beat)─► active (cycle + 1)
//   active ─(every PC has whenEveryPcHas, at a boundary: Oath record, core gain, boss HP 0)─► falling ─► down
//   down ─(permanent)─► exposed ─► exposed ─► exposed …   (never "return"; breaking the core wins)
// Every PC down during a Crystal Round (down / exposed, not permanent): the party's side wipe is HELD until the return,
// which binds them as Nox Servants (then the Oath). The rounds still pass: nobody can act → the round is cut
// (holdsSideWipe + pendingBeat "turn_start"; user ruling 2026-11-21). Breaking the core still wins.
// ============================================================================

import { log, warn } from "../logger.js";
import { registerBossRule, runBossActorUpdate } from "./boss-rules.js";
import { isOutOfPlay, setOutOfPlay } from "../out-of-play.js";
import { bossCycleTransition, bossCycleStageReader, hpQuarterStage } from "./boss-cycle-styles.js";
import { isRoundEndSwept } from "../../shared/round-end-sweep.js";
import { baseFeetOf } from "../battle-stand.js";
import { SimMode } from "../sim/sim-mode.js";

const NS = "fabula-ultima-companion";
export const RULE_ID = "boss-cycle";
export const CONFIG_FLAG = "bossCycle";
const STATE_FLAG = "bossCycleState";
const CORE_FLAG = "bossCycleCore";        // token flag on the spawned core
const CORE_OF_FLAG = "bossCycleOf";       // token flag: the boss's world actor id
const STATE_AE_NAME = "Boss Cycle";
export const PHASES = Object.freeze(["active", "falling", "down", "exposed"]);

/* ── Pure: the settings and the phase machine ────────────────────────────── */

const str = (v) => (v == null ? "" : String(v).trim());
/** The boss's cycle settings, normalised, or null when it has none. */
export function readCycleConfig(actor) {
  const raw = actor?.flags?.[NS]?.[CONFIG_FLAG];
  if (!raw || typeof raw !== "object" || !str(raw.core)) return null;
  const tr = raw.transition && typeof raw.transition === "object" ? raw.transition : {};
  return {
    core: str(raw.core),
    coreStandsAt: "boss",
    exposeRounds: Math.max(1, Math.floor(Number(raw.exposeRounds) || 1)),
    cutRound: raw.cutRound !== false,
    carryRoundEffects: raw.carryRoundEffects !== false,
    holdConflictEvent: raw.holdConflictEvent !== false,
    clearStatusesOnDown: raw.clearStatusesOnDown !== false,
    onDown: { conflictEventAction: str(raw.onDown?.conflictEventAction) || null },
    returnHp: raw.returnHp === "keep" ? "keep" : "full",
    returnMp: raw.returnMp === "keep" ? "keep" : "full",
    roundLabel: str(raw.roundLabel),
    transition: { first: str(tr.first) || null, repeat: str(tr.repeat) || null, return: str(tr.return) || null },
    stage: str(raw.stage) || "core-hp-quarters",
    voidWhileExposed: raw.voidWhileExposed === true,
    permanentExpose: readPermanentExpose(raw.permanentExpose),
  };
}
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
/** permanentExpose settings, normalised, or null (absent / no key = the feature is off). */
function readPermanentExpose(raw) {
  if (!raw || typeof raw !== "object" || !str(raw.whenEveryPcHas)) return null;
  return { whenEveryPcHas: str(raw.whenEveryPcHas), coreGainFraction: clamp01(Number(raw.coreGainFraction)), transition: str(raw.transition) || null };
}

/* ── Pure: "every player character carries X" (permanentExpose) ─────────── */

const effsOf = (a) => a?.effects?.contents ?? (Array.isArray(a?.effects) ? a.effects : []);
/** The actor carries an ENABLED AE with flags.<ns>[key] === true. */
export const hasFlaggedEffect = (actor, key) => !!key && effsOf(actor).some((e) => !e?.disabled && e?.flags?.[NS]?.[key] === true);
/** A player character of this battle: the SAME test as soul-tithe.js players() (no guests, objects, summons, NPC ranks). */
export function isCyclePc(c) {
  if (c?.side !== "party") return false;
  const a = c.actorDoc;
  if (!a) return false;
  const f = a.flags?.[NS] ?? {};
  if (f.bdGuest || f.bdObject || f.isPersistentSummon) return false;
  const t = c.tokenDoc?.flags?.[NS] ?? {};
  if (t.isSummon || t.isPhantasm || t.summonedBy) return false;
  return !str(a.system?.props?.npc_rank);
}
/** At least one PC, and every PC has the flag (on its actor or its token's actor). */
export function everyPcHas(combatants, key) {
  const pcs = (combatants ?? []).filter(isCyclePc);
  return pcs.length > 0 && pcs.every((c) => hasFlaggedEffect(c.actorDoc, key) || hasFlaggedEffect(c.tokenDoc?.actor, key));
}
/** The core's gain at the Oath: floor(boss HP left * fraction), never negative. */
export const oathGain = (bossHp, fraction) => Math.max(0, Math.floor(Math.max(0, Number(bossHp) || 0) * (Number(fraction) || 0)));
/** Does the permanent exposure begin now? Only from a fighting boss (phase active), once. */
export const permanentDue = (state, cfg, combatants) =>
  !!cfg?.permanentExpose?.whenEveryPcHas && !state?.permanent && (state?.phase ?? "active") === "active"
  && everyPcHas(combatants, cfg.permanentExpose.whenEveryPcHas);

/** The boss is at 0 HP at a turn boundary: does its fall play now? */
export const fallsNow = (phase, down) => !!down && (phase === "active" || phase === "falling");
export const fallVariant = (cycle) => ((Number(cycle) || 0) === 0 ? "first" : "repeat");
/**
 * The round boundary (ROUND_START, before turns are dealt): what happens.
 * -> { state, act: "expose" | "stay" | "return" | null, label }
 */
export function atRoundBoundary(state, cfg) {
  const s = state ?? { phase: "active", cycle: 0, exposedLeft: 0 };
  if (s.phase === "down") return { state: { ...s, phase: "exposed", exposedLeft: s.permanent ? 0 : cfg.exposeRounds }, act: "expose", label: cfg.roundLabel || null };
  if (s.phase === "exposed") {
    // permanentExpose: the core stays exposed until the battle ends (never "return")
    if (s.permanent) return { state: s, act: "stay", label: cfg.roundLabel || null };
    const left = (Number(s.exposedLeft) || 1) - 1;
    if (left > 0) return { state: { ...s, exposedLeft: left }, act: "stay", label: cfg.roundLabel || null };
    return { state: { phase: "active", cycle: (Number(s.cycle) || 0) + 1, exposedLeft: 0 }, act: "return", label: null };
  }
  return { state: s, act: null, label: null };
}
export const roundEndTriggerFor = (phase, cfg) => (phase === "down" && cfg?.cutRound ? "none" : null);
export const skipsSweepFor = (phase, cfg) => phase === "down" && !!cfg?.cutRound && !!cfg?.carryRoundEffects;
export const holdsEventFor = (phase, cfg) => !!cfg?.holdConflictEvent && !!phase && phase !== "active";
export const voidFor = (phase, cfg) => !!cfg?.voidWhileExposed && (phase === "down" || phase === "exposed");

/* ── Who is who ─────────────────────────────────────────────────────────── */

const flagsOf = (doc) => doc?.flags?.[NS] ?? {};
function baseActorOf(c) {
  const td = c?.tokenDoc;
  return (td?.actorId && game.actors?.get?.(td.actorId)) || c?.actorDoc || null;
}
/** The battle's cycle boss: { c, base, cfg } or null. */
function bossOf(director) {
  for (const c of director?.dCombat?.combatants ?? []) {
    if (c.side !== "enemy") continue;
    const base = baseActorOf(c), cfg = readCycleConfig(base) ?? readCycleConfig(c.actorDoc);
    if (cfg) return { c, base: base ?? c.actorDoc, cfg };
  }
  return null;
}
const isCoreToken = (td) => flagsOf(td)[CORE_FLAG] === true;
function coreOf(director, boss = bossOf(director)) {
  if (!boss) return null;
  return (director?.dCombat?.combatants ?? []).find((c) => isCoreToken(c.tokenDoc) && flagsOf(c.tokenDoc)[CORE_OF_FLAG] === boss.base?.id) ?? null;
}
const hpOf = (a) => Number(a?.system?.props?.current_hp);
const isDown = (a) => Number.isFinite(hpOf(a)) && hpOf(a) <= 0;

/* ── The state (an AE on the core) ─────────────────────────────────────── */

/** S3: a crack stage never reads lower than the floor the state recorded (the Oath's stageBefore). */
export const stageNeverLower = (computed, state) => Math.max(Number(computed) || 0, Number(state?.oath?.stageBefore) || 0);
const stateAe = (actor) => (actor?.effects?.contents ?? []).find((e) => flagsOf(e)[STATE_FLAG]) ?? null;
// The fields are WHITELISTED here and in writeState: a field missing from either is dropped by the next write.
//   permanent / oath    the Oath (permanentExpose) — oath = { bossHp, gain, coreHpBefore, coreMaxBefore, round, stageBefore }
//   ascTickRound / ascended   the Ascension (B11): the round the last Zero Power tick ran for, and "the party has lost"
const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
function normState(s) {
  return {
    phase: PHASES.includes(s.phase) ? s.phase : "active", cycle: Number(s.cycle) || 0, exposedLeft: Number(s.exposedLeft) || 0,
    permanent: s.permanent === true,
    oath: s.oath && typeof s.oath === "object" ? {
      bossHp: Number(s.oath.bossHp) || 0, gain: Number(s.oath.gain) || 0,
      coreHpBefore: Number(s.oath.coreHpBefore) || 0, coreMaxBefore: Number(s.oath.coreMaxBefore) || 0, round: numOrNull(s.oath.round),
      stageBefore: Math.max(0, Math.min(3, Math.round(Number(s.oath.stageBefore)) || 0)),
    } : null,
    ascTickRound: numOrNull(s.ascTickRound),
    ascended: s.ascended === true,
  };
}
export function readState(actor) {
  const s = flagsOf(stateAe(actor))[STATE_FLAG];
  return s ? normState(s) : null;
}
async function writeState(actor, next) {
  const ae = stateAe(actor), state = normState(next ?? {});
  if (ae) await ae.update({ [`flags.${NS}.${STATE_FLAG}`]: state });
  else {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: STATE_AE_NAME, img: "icons/svg/clockwork.svg", disabled: false, transfer: false, changes: [],
      // never ticked, but it belongs to this battle (the scene-end sweep takes it)
      flags: { [NS]: { [STATE_FLAG]: state, directorPermanent: true, conflictScoped: true } },
    }]);
  }
  log(`boss-cycle: phase ${state.phase} (cycle ${state.cycle}${state.permanent ? ", exposed for good" : state.phase === "exposed" ? `, ${state.exposedLeft} exposed round(s) left` : ""})`);
}
const phaseOf = (director) => readState(coreOf(director)?.actorDoc)?.phase ?? null;
/** The Oath has fired: the core stays exposed for the rest of the battle (B11's Ascension reads this). */
export const isPermanentExposed = (director) => readState(coreOf(director)?.actorDoc)?.permanent === true;

async function save(director) {
  try {
    const { saveDirectorState } = await import("../persistence.js");
    await saveDirectorState(director, { skipHistory: true });
  } catch (e) { warn("boss-cycle: save threw", e); }
}

/* ── Conflict start: the core, out of play, where the boss stands ─────────── */

async function sweepStrayCores(scene, keep = null) {
  const ids = (scene?.tokens?.contents ?? []).filter((td) => isCoreToken(td) && flagsOf(td).conflictSpawned && td.id !== keep).map((td) => td.id);
  if (ids.length) { try { await scene.deleteEmbeddedDocuments("Token", ids); log(`boss-cycle: swept ${ids.length} stray core token(s)`); } catch (e) { warn("boss-cycle: stray core sweep threw", e); } }
}

async function spawnCore(director) {
  const dc = director.dCombat, boss = bossOf(director), scene = dc?.scene;
  if (!boss || !scene) return null;
  const have = coreOf(director, boss);
  if (have) return have;
  const base = game.actors?.get?.(boss.cfg.core);
  if (!base) { warn(`boss-cycle: ${boss.base?.name}'s core actor ${boss.cfg.core} is not in this world — the fight has no core (its fall will end nothing)`); return null; }
  await sweepStrayCores(scene);
  // coreStandsAt "boss": the core's feet on the boss's feet
  const g = scene.grid?.size ?? canvas.grid?.size ?? 110, td = boss.c.tokenDoc;
  // the boss's UN-offset spot: the crystal does not follow his battleStand (ruling 2026-11-20)
  const feet = baseFeetOf(td, NS, g);
  const ch = (base.prototypeToken?.height ?? 1) * g;
  const flags = { [CORE_FLAG]: true, [CORE_OF_FLAG]: boss.base.id, turnsPerRound: 0, conflictSpawned: true };
  const { spawnLiveDirectorTokens } = await import("../director-init.js");
  const [tokenDoc] = await spawnLiveDirectorTokens({
    scene, actorUuids: [base.uuid], disposition: -1, exactCenter: { x: feet.x, y: feet.y - ch / 2 },
    tokenData: { hidden: true, flags: { [NS]: flags } },
  });
  if (!tokenDoc) { warn("boss-cycle: the core spawn produced no token"); return null; }
  await tokenDoc.update(Object.fromEntries(Object.entries(flags).map(([k, v]) => [`flags.${NS}.${k}`, v])));
  // out of play and in its first phase BEFORE anyone can see it
  await setOutOfPlay(tokenDoc.actor, true, { reason: RULE_ID });
  await writeState(tokenDoc.actor, { phase: "active", cycle: 0, exposedLeft: 0 });
  await tokenDoc.update({ hidden: false });
  const c = dc.addCombatant({ tokenDoc, actorDoc: tokenDoc.actor, side: "enemy", disposition: -1 });
  c.turnsPerRound = 0; c.turnsRemaining = 0;
  try { const { refreshTurnActions } = await import("../director-round-banner.js"); refreshTurnActions?.(dc); } catch { /* the bar catches up */ }
  log(`boss-cycle: ${base.name} stands where ${boss.base.name} stands (out of play), ${tokenDoc.id}`);
  return c;
}

/* ── The fall ───────────────────────────────────────────────────────────── */

// Round effects flagged endsOnCutRound (shared/round-end-sweep.js) end the moment
// the boss falls — Soul Master's strip, ruling 2026-11-19 — so they are not on
// during the fall's own beats, and a reload / rewind to a save after the fall
// (which resumes at ROUND_START, skipping ROUND_END) cannot carry them into the
// exposed round. ROUND_END's cut-round sweep stays as the backstop (idempotent).
// Every combatant's actor and its base world actor (linked or not).
async function sweepEndsOnFall(director) {
  const pool = new Map();
  for (const c of director?.dCombat?.combatants ?? []) {
    for (const a of [c?.actorDoc, c?.tokenDoc?.actor, baseActorOf(c)]) if (a && !pool.has(a.uuid ?? a)) pool.set(a.uuid ?? a, a);
  }
  const names = [];
  for (const actor of pool.values()) {
    const effs = actor?.effects?.contents ?? Array.from(actor?.effects ?? []);
    const ids = effs.filter((e) => isRoundEndSwept(e, { cutRound: true })).map((e) => e.id).filter(Boolean);
    if (!ids.length) continue;
    try { await actor.deleteEmbeddedDocuments("ActiveEffect", ids); names.push(`${actor.name} ×${ids.length}`); }
    catch (e) { warn(`boss-cycle: the fall's round-effect sweep failed for ${actor?.name}`, e); }
  }
  if (names.length) log(`boss-cycle: the fall ends ${names.join(", ")}`);
  return names;
}

async function playFall(director, where) {
  const dc = director.dCombat, boss = bossOf(director), core = coreOf(director, boss);
  if (!boss || !core) return null;
  const { cfg } = boss, bossActor = boss.c.actorDoc;
  const st = readState(core.actorDoc) ?? { phase: "active", cycle: 0, exposedLeft: 0 };
  const variant = fallVariant(st.cycle);
  log(`boss-cycle: ${bossActor?.name} falls (${variant}, at ${where})`);
  await writeState(core.actorDoc, { ...st, phase: "falling" });
  // "until the end of the round, or until the boss falls" effects end HERE, before
  // the hold breaks (onDown), the turn_end window and any save of the cut round.
  await sweepEndsOnFall(director);

  if (cfg.clearStatusesOnDown) {
    try { const { cleanseBuffsDebuffsOnKO } = await import("../defeat-reactor.js"); await cleanseBuffsDebuffsOnKO(bossActor); }
    catch (e) { warn("boss-cycle: the cleanse threw", e); }
  }

  // the Oath's fall plays permanentExpose.transition when set, else the ordinary first / repeat show (v1)
  const showName = (st.permanent && cfg.permanentExpose?.transition) || cfg.transition[variant];
  const t = bossCycleTransition(showName);
  const spec = { variant, sceneId: dc.scene?.id ?? null, bossTokenId: boss.c.tokenDoc?.id ?? null, coreTokenId: core.tokenDoc?.id ?? null };
  let show = null, beats = { down: 0, hidden: 0, reveal: 0 };
  if (t) {
    try { show = t.present(spec); beats = { ...beats, ...(t.beats?.(spec) ?? {}) }; }
    catch (e) { warn(`boss-cycle: the "${showName}" transition could not start — the rules run without it`, e); show = null; }
  } else if (showName) warn(`boss-cycle: no transition named "${showName}" is registered — the rules run without a show`);
  const at = (s) => (show ? show.at(s) : Promise.resolve());

  // the boss's hold breaks (Nidhogg: every Soul Fragment destroyed, refunds as usual)
  const onDown = cfg.onDown.conflictEventAction
    ? at(beats.down).then(async () => {
      const { runConflictEventAction } = await import("../../conflict-event/conflict-event-runtime.js");
      await runConflictEventAction(director, cfg.onDown.conflictEventAction, {});
    }).catch((e) => warn("boss-cycle: the onDown action threw", e))
    : Promise.resolve();

  // the boss is gone
  await at(beats.hidden);
  await setOutOfPlay(bossActor, true, { reason: RULE_ID });
  await writeState(core.actorDoc, { ...st, phase: "down" });
  // the core is in play (a show may still draw it until its end)
  await at(beats.reveal);
  await setOutOfPlay(core.actorDoc, false);

  await (show ? show.done : Promise.resolve());
  await onDown;

  // the round is cut: every turn left is lost
  if (cfg.cutRound) {
    for (const c of dc.combatants ?? []) c.turnsRemaining = 0;
    dc._notifyTurnActions?.();
  }
  await save(director);
  return { cut: cfg.cutRound };
}

/* ── The Oath (permanentExpose): every PC carries the flag ─────────────────── */

// Order (GM, inside pendingBeat, before the fall):
//   1. the record { permanent, oath } is written FIRST: an F5 after it replays the same numbers, never recomputes
//   2. the core's max AND current HP: ABSOLUTE writes (before + gain), so a replay cannot add the gain twice
//   3. the boss to HP 0 with fuReactionTriggersHandled (a withdrawal, not a defeat: no creature_defeated), so the
//      side wipe sees him down and breaking the core can win; then the ordinary fall plays (pendingBeat)
// The core is out of play until the fall's reveal, so nothing can damage it between the record and the writes.
async function beginPermanent(director, boss, core, st) {
  const bossHp = Math.max(0, hpOf(boss.c.actorDoc) || 0), cp = core.actorDoc?.system?.props ?? {};
  const oath = {
    bossHp, gain: oathGain(bossHp, boss.cfg.permanentExpose.coreGainFraction),
    coreHpBefore: Number(cp.current_hp) || 0, coreMaxBefore: Number(cp.max_hp) || 0, round: director?.dCombat?.round ?? null,
  };
  // S3: the cracks never close (the gain raises HP and Max together, which would lift the fraction)
  oath.stageBefore = hpQuarterStage(oath.coreHpBefore, oath.coreMaxBefore);
  const next = { ...st, permanent: true, oath };
  await writeState(core.actorDoc, next);
  await settleOath(boss, core, oath);
  log(`boss-cycle: every player character carries "${boss.cfg.permanentExpose.whenEveryPcHas}" — ${boss.base?.name} withdraws, the core stays exposed for good (+${oath.gain}: ${oath.coreHpBefore}/${oath.coreMaxBefore} → ${oath.coreHpBefore + oath.gain}/${oath.coreMaxBefore + oath.gain})`);
  await save(director);
  // a party of more than 4 PCs: Zero Power may already be at 6 when the Oath fires (check only, no tick)
  try { await ascensionCheck(director, { boss, core }); } catch (e) { warn("boss-cycle: ascensionCheck threw", e); }
  return readState(core.actorDoc) ?? next;
}
// Idempotent: the same absolute values every time (first run and any F5 replay).
async function settleOath(boss, core, oath) {
  const max = oath.coreMaxBefore + oath.gain, cur = oath.coreHpBefore + oath.gain, cp = core.actorDoc?.system?.props ?? {};
  if (Number(cp.max_hp) !== max || Number(cp.current_hp) !== cur) {
    await core.actorDoc.update({ "system.props.max_hp": max, "system.props.current_hp": cur });
  }
  if (hpOf(boss.c.actorDoc) > 0) await boss.c.actorDoc.update({ "system.props.current_hp": 0 }, { fuReactionTriggersHandled: true });
}

/* ── The Ascension (B11): +1 Zero Power at each Crystal Round's end after the Oath; at 6 the party loses ── */

export const ASCENSION_ZP = 6;
export const ASCENSION_TEXT = "The heroes succumb to the power of the dragon king. Now their soul is bound to their servitude, for eternity.";
const PATH_ZP = "system.props.zero_power_value";
const zpOf = (a) => Number(a?.system?.props?.zero_power_value) || 0;
/** Pure. Ascension is due: ZP at the cap, the Oath is on, not yet ascended, the battle not already ending. */
export const shouldAscend = (state, zp, ended = false) => Number(zp) >= ASCENSION_ZP && state?.permanent === true && state?.ascended !== true && !ended;
/**
 * Pure. One round-end tick. Gate: permanent && !ended && !freeRound && !ascended && ascTickRound !== round.
 * @returns {{ state: object, zp: number, ascend: boolean }} no-op = the same state + zp, ascend false
 */
export function ascensionTickFor(state, zp, round, { ended = false, freeRound = false } = {}) {
  const z = Number(zp) || 0;
  if (!state?.permanent || ended || freeRound || state.ascended === true || state.ascTickRound === round) return { state, zp: z, ascend: false };
  const next = Math.min(ASCENSION_ZP, z + 1);
  return { state: { ...state, ascTickRound: round }, zp: next, ascend: next >= ASCENSION_ZP };
}

const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch((e) => warn("boss-cycle: the Ascension cut-in threw", e)), new Promise((r) => setTimeout(r, ms))]);

/** Pure. The Ascension's flag is written but the battle never ended (an F5 between the flag and dc.end()): finish the loss. */
export const ascensionLatched = (state, ended = false) => state?.ascended === true && !ended;

const _ascending = new WeakSet();
// dc -> the tick / Ascension in flight. Set BEFORE the tick's first write: the tick's own Zero Power write fires the
// updateActor watcher INSIDE the awaited update, and the watcher must stand down rather than win the race (the
// boundary caller is the one that awaits the loss). Any other caller waits for it, then looks again.
const _busy = new WeakMap();
/** The loss itself (outcomeOverride, not a side wipe: no hold can stop it). */
function stampLoss(director, dc) {
  dc.outcomeOverride = "defeat";
  if (director.ctx) director.ctx.battleEndStyle = { style: "dragon_ascension", label: "Dragon King's Ascension", quiet: true, text: ASCENSION_TEXT };
  dc.end();
}
/** The Dragon King's Ascension: the party loses at once. */
async function ascend(director, boss, core, st) {
  const dc = director?.dCombat, a = boss?.c?.actorDoc;
  if (!dc || dc.ended || st?.ascended === true || _ascending.has(dc)) return;
  _ascending.add(dc);
  try {
    // idempotency + F5: the flag is written FIRST (a reload after it finishes the loss: ascensionLatched)
    await writeState(core.actorDoc, { ...st, ascended: true });
    await ascensionShow(boss, a);
  } finally {
    _ascending.delete(dc);
    // the loss: ALWAYS reached once begun (a throwing state write or show included)
    if (!dc.ended) stampLoss(director, dc);
  }
}
async function ascensionShow(boss, a) {
  log(`boss-cycle: Zero Power ${ASCENSION_ZP}/${ASCENSION_ZP} — the Dragon King's Ascension: the party loses`);
  const tokenUuid = boss.c.tokenDoc?.uuid ?? null;
  try {
    const item = (a?.items?.contents ?? []).find((i) => /dragon king's ascension/i.test(i?.name ?? ""));
    globalThis.ONI?.emit?.("oni:reactionPhase", {
      kind: "creature_unleashes_zero_power", trigger: "creature_unleashes_zero_power", timestamp: Date.now(),
      actorUuid: a?.uuid ?? null, tokenUuid, sourceUuid: tokenUuid, subjectTokenUuid: tokenUuid, subjectActorUuid: a?.uuid ?? null,
      attackerUuid: tokenUuid, attackerActorUuid: a?.uuid ?? null, skillUuid: item?.uuid ?? null, skillName: item?.name ?? "Zero Power: Dragon King's Ascension",
      requestedByUserId: game.user?.id ?? null, requestedByUserName: game.user?.name ?? null,
    }, { local: true, world: false });
  } catch (e) { warn("boss-cycle: the Ascension emit threw", e); }
  // a cut-in cache miss (or a throw) must never block the loss; capped at 6 s
  try { if (tokenUuid) await withTimeout(globalThis.FUCompanion?.api?.cutinBroadcast?.({ tokenUuid, type: "zero_power" }), 6000); } catch (e) { warn("boss-cycle: the Ascension cut-in threw", e); }
  try { await ChatMessage.create({ content: `<p><em>${ASCENSION_TEXT}</em></p>`, speaker: { alias: "Dragon King's Ascension" } }); } catch (e) { warn("boss-cycle: the Ascension chat line threw", e); }
}

/**
 * Called at every round boundary that leaves a PERMANENT core exposed (a "stay"; the cut round's "expose" does not
 * tick, and a Crystal broken at round end already ended the battle before ROUND_START got here), and by anything that
 * sets the Oath / Zero Power. The tick (ctx.tick, the boundary only) is once per round (ascTickRound), then the check
 * at 6. ctx.watcher (the updateActor watcher) stands down while a tick / Ascension is in flight. A state already
 * `ascended` on a battle not ended (F5 mid-Ascension) finishes the loss. GM only.
 * @returns {Promise<null>}
 */
export async function ascensionCheck(director, ctx = {}) {
  if (!game.user?.isGM) return null;
  const dc = director?.dCombat;
  if (!dc) return null;
  const busy = _busy.get(dc);
  if (busy) {
    if (ctx.watcher) return null;
    await busy;
    return ascensionCheck(director, ctx);
  }
  let release;
  _busy.set(dc, new Promise((r) => { release = r; }));   // before any await: the guard is up before the tick's writes
  try { await checkNow(director, dc, ctx); }
  finally { _busy.delete(dc); release(); }
  return null;
}
async function checkNow(director, dc, ctx) {
  const boss = ctx.boss ?? bossOf(director), core = ctx.core ?? coreOf(director, boss);
  const a = boss?.c?.actorDoc;
  let st = readState(core?.actorDoc);
  if (!a || !st) return;
  if (st.ascended) {
    if (ascensionLatched(st, !!dc.ended) && !_ascending.has(dc)) {
      log("boss-cycle: the Ascension was written before a reload — the loss finishes now");
      stampLoss(director, dc);
    }
    return;
  }
  if (!st.permanent) return;
  const ended = !!dc.ended, zp0 = zpOf(a);
  const t = ctx.tick ? ascensionTickFor(st, zp0, dc.round ?? null, { ended, freeRound: !!dc.freeRound }) : { state: st, zp: zp0, ascend: false };
  if (t.state !== st) { st = t.state; await writeState(core.actorDoc, st); }   // ascTickRound FIRST
  if (t.zp !== zp0) { await a.update({ [PATH_ZP]: t.zp }); log(`boss-cycle: Zero Power ${t.zp}/${ASCENSION_ZP}`); }
  if (t.ascend || shouldAscend(st, t.zp, ended)) await ascend(director, boss, core, st);
}

/* ── The held side wipe (Q2 ruling): every PC down in a Crystal Round waits for the return ── */

/**
 * Pure. The party's wipe is held: the core is out for a cycle that WILL return (cut / exposed, not the Oath's
 * permanent exposure, not after the Ascension). Never forever: the phase moves on at every round boundary and the
 * return ends it; a broken core still ends the battle (the enemy side is wiped).
 */
export const wipeHeldFor = (state) => !!state && (state.phase === "down" || state.phase === "exposed") && state.permanent !== true && state.ascended !== true;
const anyTurnLeft = (dc) => (dc?.combatants ?? []).some((c) => !(c.isDefeatedLive?.() ?? isDown(c.actorDoc)) && Number(c.turnsRemaining) > 0);

/**
 * A sim run that charged this boss's Zero Power (sim-run.js chargeEnemyZp; SimMode.config.enemyZp = a number for every
 * enemy, or a map by uuid / id / name) keeps it: the conflict-start reset is for real play.
 */
export function simSeedsZp(actor, sim = SimMode) {
  if (!sim?.active || !actor) return false;
  const z = sim.config?.enemyZp;
  if (z == null) return false;
  if (typeof z === "number") return Number.isFinite(z);
  if (typeof z !== "object") return false;
  const name = String(actor.name ?? "").trim().toLowerCase();
  return [actor.uuid, actor.id].some((k) => k && z[k] != null) || Object.keys(z).some((k) => k.trim().toLowerCase() === name && z[k] != null);
}

/* ── The return (at the round boundary) ─────────────────────────────────── */

// With a transition.return show, the rules follow its beats on the GM's wall clock, as the fall does:
//   hidden — the core is gone (out of play); reveal — the boss is back (full HP / MP, in play, KO + Crisis
//   reconciled, the cycle's next phase); then the show's end (the round banner comes after it).
// No show (none set, unknown name, sim / lean / nobody watching): the instant swap, in the same order.
// F5 half-way: the state stays "exposed" until the reveal, and a reload with the wrap still deferred resumes
// at ROUND_START (director-boot), so the boundary runs again and the return replays from its start (the core
// already out of play is a no-op). After the reveal the state is "active": nothing replays, the rules are done.
async function returnBoss(director, boss, core, next) {
  const { cfg } = boss, a = boss.c.actorDoc, p = a?.system?.props ?? {};
  const dc = director?.dCombat, name = cfg.transition.return;
  const t = bossCycleTransition(name);
  const spec = { variant: "return", sceneId: dc?.scene?.id ?? null, bossTokenId: boss.c.tokenDoc?.id ?? null, coreTokenId: core.tokenDoc?.id ?? null };
  let show = null, beats = { hidden: 0, reveal: 0 };
  if (t) {
    try { show = t.present(spec); beats = { ...beats, ...(t.beats?.(spec) ?? {}) }; }
    catch (e) { warn(`boss-cycle: the "${name}" transition could not start — the return runs without it`, e); show = null; }
  } else if (name) warn(`boss-cycle: no transition named "${name}" is registered — the return runs without a show`);
  const at = (s) => (show ? show.at(s) : Promise.resolve());
  if (show) log(`boss-cycle: ${a?.name} returns (show "${name}", hidden ${beats.hidden} s, reveal ${beats.reveal} s)`);

  // the core is gone
  await at(beats.hidden);
  await setOutOfPlay(core.actorDoc, true, { reason: RULE_ID });
  // the boss is back
  await at(beats.reveal);
  const upd = {};
  if (cfg.returnHp === "full" && Number.isFinite(Number(p.max_hp))) upd["system.props.current_hp"] = Number(p.max_hp);
  if (cfg.returnMp === "full" && Number.isFinite(Number(p.max_mp))) upd["system.props.current_mp"] = Number(p.max_mp);
  if (Object.keys(upd).length) await a.update(upd);
  await setOutOfPlay(a, false);
  try { const { settleRevive } = await import("../defeat-reactor.js"); await settleRevive(a); } catch (e) { warn("boss-cycle: the KO reconcile threw", e); }
  try { const { evaluateCrisis } = await import("../crisis-reactor.js"); await evaluateCrisis(a); } catch (e) { warn("boss-cycle: the Crisis reconcile threw", e); }
  await writeState(core.actorDoc, next);
  log(`boss-cycle: ${a?.name} returns (cycle ${next.cycle})`);
  // B13 (docs §4c item 7/8): every PC still at 0 HP becomes a Nox Servant now (he is back at HP > 0, so his own
  // stays-down rows are live). If that binds every PC, the next pendingBeat (the first TURN_START of the round) catches
  // the Oath and plays its fall with the round cut: no extra round.
  // only a boss with the Oath (permanentExpose) binds the fallen on return; any other boss cycle is untouched
  if (boss?.cfg?.permanentExpose) try { await convertDownedPcs(director, boss); } catch (e) { warn("boss-cycle: the return conversion threw", e); }
  // the battle goes on once the show is over (its round banner after it)
  if (show) { try { await show.done; } catch (e) { warn("boss-cycle: the return show's end threw", e); } }
}

/** Test seam: replace the dynamic imports of emitStaysDown / checkSideWipe / clearStaysDownSettled. */
export const bossCycleDeps = { emitStaysDown: null, checkSideWipe: null, clearStaysDownSettled: null };
/** The PCs of this battle still at 0 HP (isCyclePc, HP finite and <= 0). */
export const downedPcs = (combatants) => (combatants ?? []).filter((c) => isCyclePc(c) && isDown(c.actorDoc));
async function convertDownedPcs(director, boss) {
  const dc = director?.dCombat, a = boss?.c?.actorDoc;
  const emit = bossCycleDeps.emitStaysDown ?? (await import("../defeat-reactor.js")).emitStaysDown;
  const clear = bossCycleDeps.clearStaysDownSettled ?? (await import("../stays-down.js")).clearStaysDownSettled;
  clear(a);   // his own mark: his reactors must read him as up
  const pcs = downedPcs(dc?.combatants);
  for (const c of pcs) {
    try {
      await emit(director, c.actorDoc, { subjectActorUuid: c.actorDoc.uuid, subjectTokenUuid: c.tokenDoc?.uuid ?? null }, new Set());
    } catch (e) { warn(`boss-cycle: stays-down for ${c.actorDoc?.name} threw`, e); }
  }
  if (pcs.length) log(`boss-cycle: the return binds ${pcs.length} fallen player character(s)`);
  const sw = bossCycleDeps.checkSideWipe ?? (await import("../state-handlers.js")).checkSideWipe;
  sw(director);
}

/* ── The rule ───────────────────────────────────────────────────────────── */

export const BossCycle = {
  id: RULE_ID,
  claims: (director) => !!bossOf(director),
  // the rule plays the boss's fall: no Champion fall, no Defeated status (on-defeat reactions still fire)
  ownsFall: (actor, director) => {
    const b = bossOf(director);
    return !!b && (actor?.uuid === b.c.actorDoc?.uuid || (!!actor?.id && actor.id === b.base?.id));
  },
  async onConflictStart(director) {
    if (!game.user?.isGM) return;
    // Zero Power starts the conflict at 0 for an Oath boss (the tick + the Ascension count from there)
    const boss = bossOf(director);
    if (boss?.cfg.permanentExpose && zpOf(boss.c.actorDoc) !== 0 && !simSeedsZp(boss.base)) {
      try { await boss.c.actorDoc.update({ [PATH_ZP]: 0 }); } catch (e) { warn("boss-cycle: the Zero Power reset threw", e); }
    }
    await spawnCore(director);
  },
  // Any other write that takes Zero Power to 6 once the Oath is on ascends at once. DARK until a watcher calls it
  // (runBossActorUpdate, called by the GM-only updateActor hook installed in initBossCycle).
  async onActorUpdate(director, actor, change) {
    if (!game.user?.isGM) return;
    const v = change?.system?.props?.zero_power_value ?? change?.[PATH_ZP];
    if (v == null || Number(v) < ASCENSION_ZP) return;
    const boss = bossOf(director);
    if (!boss || (actor?.uuid !== boss.c.actorDoc?.uuid && actor?.id !== boss.c.actorDoc?.id)) return;
    try { await ascensionCheck(director, { watcher: true }); } catch (e) { warn("boss-cycle: ascensionCheck threw", e); }
  },
  async pendingBeat(director, where) {
    if (!game.user?.isGM) return null;
    const boss = bossOf(director), core = coreOf(director, boss);
    if (!boss || !core) return null;
    let st = readState(core.actorDoc) ?? normState({ phase: "active" });
    // the Ascension written (in flight: wait for its loss; F5 before its end: finish it now). Nothing else plays.
    if (st.ascended) { await ascensionCheck(director, { boss, core }); return null; }
    // permanentExpose (the Oath): every PC carries the flag → the record, the core's gain, the boss to HP 0; then the fall
    if (permanentDue(st, boss.cfg, director.dCombat?.combatants)) {
      st = await beginPermanent(director, boss, core, st);
      if (director.dCombat?.ended) return null;   // Zero Power already at 6 (a party > 4): the Ascension, no fall
    }
    // F5 between the record and the fall's end: replay the same absolute writes (never re-gain)
    else if (st.permanent && st.oath && (st.phase === "active" || st.phase === "falling")) await settleOath(boss, core, st.oath);
    if (!fallsNow(st.phase, isDown(boss.c.actorDoc))) {
      // the held wipe (every PC down in a Crystal Round): nobody can act, so the round passes on toward the return
      if (where === "turn_start" && boss.cfg.permanentExpose && wipeHeldFor(st) && !anyTurnLeft(director.dCombat)) {
        log("boss-cycle: nobody can act while the party's fall is held — the round passes");
        return { cut: true };
      }
      return null;
    }
    // a fall at round_start (a round_end DoT): that round already ended in full; nothing is cut
    const res = await playFall(director, where);
    return where === "round_start" ? null : res;
  },
  roundEndTrigger: (director) => roundEndTriggerFor(phaseOf(director), bossOf(director)?.cfg),
  skipsRoundEndSweep: (director) => skipsSweepFor(phaseOf(director), bossOf(director)?.cfg),
  holdsConflictEvent: (director) => holdsEventFor(phaseOf(director), bossOf(director)?.cfg),
  // Q2 ruling: every PC down during a Crystal Round waits for the return (only a boss with permanentExpose: its return binds them)
  holdsSideWipe: (director, side) => {
    if (side !== "party" || director?.dCombat?.ended) return false;
    const boss = bossOf(director);
    return !!boss?.cfg.permanentExpose && wipeHeldFor(readState(coreOf(director, boss)?.actorDoc));
  },
  stage: (director) => {
    const boss = bossOf(director);
    if (!boss) return 0;
    const core = coreOf(director, boss);
    const fn = bossCycleStageReader(boss.cfg.stage);
    const state = readState(core?.actorDoc);
    return stageNeverLower(fn ? Number(fn({ boss: boss.c.actorDoc, core: core?.actorDoc ?? null, cfg: boss.cfg, state })) || 0 : 0, state);
  },
  async roundBoundary(director) {
    if (!game.user?.isGM) return null;
    const boss = bossOf(director), core = coreOf(director, boss);
    // a watcher's tick / Ascension in flight lands first (its state write must not race this boundary's)
    const inFlight = _busy.get(director?.dCombat);
    if (inFlight) await inFlight;
    const st = readState(core?.actorDoc);
    if (!boss || !st) return null;
    // the Ascension written but the battle not ended (F5 mid-Ascension): finish the loss, no boundary
    if (st.ascended) { await ascensionCheck(director, { boss, core }); return null; }
    const { state, act, label } = atRoundBoundary(st, boss.cfg);
    if (act === "expose" || act === "stay") await writeState(core.actorDoc, state);
    else if (act === "return") await returnBoss(director, boss, core, state);
    // the end of a Crystal Round after the Oath: the Zero Power tick + the Ascension
    if (act === "stay" && state.permanent) {
      try { await ascensionCheck(director, { boss, core, tick: true }); } catch (e) { warn("boss-cycle: ascensionCheck threw", e); }
    }
    return label ? { label } : null;
  },
};

registerBossRule(BossCycle);

/* ── Every client: the next fall's show warms up while its battle is on (prepare) ── */

// core token id -> release. One prepare per core token (= per battle): the transition the NEXT fall plays (first, or
// repeat after a reload mid-battle), released when the core leaves the scene (battle over) or the canvas goes.
const _prepared = new Map();
function syncPrepares() {
  const scene = canvas?.scene, live = new Set();
  const tokens = scene?.tokens?.contents ?? [];
  for (const td of tokens) {
    if (!isCoreToken(td)) continue;
    live.add(td.id);
    if (_prepared.has(td.id)) continue;
    const bossId = flagsOf(td)[CORE_OF_FLAG];
    const cfg = readCycleConfig(game.actors?.get?.(bossId));
    const bossTd = tokens.find((t) => t.actorId === bossId && !isCoreToken(t));
    const variant = fallVariant(readState(td.actor)?.cycle);
    const t = bossCycleTransition(cfg?.transition?.[variant]);
    const rels = [];
    if (typeof t?.prepare === "function" && bossTd) {
      try { rels.push(t.prepare({ variant, sceneId: scene.id, bossTokenId: bossTd.id, coreTokenId: td.id })); }
      catch (e) { warn(`boss-cycle: the "${cfg.transition[variant]}" transition's prepare threw`, e); }
    }
    // the return's show may warm up too (it plays later in the same battle: after the fall, on this canvas)
    const tr = bossCycleTransition(cfg?.transition?.return);
    if (tr && tr !== t && typeof tr.prepare === "function" && bossTd) {
      try { rels.push(tr.prepare({ variant: "return", sceneId: scene.id, bossTokenId: bossTd.id, coreTokenId: td.id })); }
      catch (e) { warn(`boss-cycle: the "${cfg.transition.return}" transition's prepare threw`, e); }
    }
    _prepared.set(td.id, () => { for (const r of rels) { if (typeof r === "function") { try { r(); } catch { /* gone */ } } } });
  }
  for (const [id, rel] of [..._prepared]) if (!live.has(id)) { _prepared.delete(id); try { rel(); } catch { /* gone */ } }
}
function releasePrepares() {
  for (const rel of _prepared.values()) { try { rel(); } catch { /* gone */ } }
  _prepared.clear();
}

/* ── Every client: the void while the core is exposed, from the state ────── */

let _hooked = false;
export function initBossCycle() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  import("../../sealing-crystal/arena-void.js").then(({ registerVoidSource }) => {
    registerVoidSource(() => {
      for (const t of canvas?.tokens?.placeables ?? []) {
        if (!isCoreToken(t.document)) continue;
        const cfg = readCycleConfig(game.actors?.get?.(flagsOf(t.document)[CORE_OF_FLAG]));
        if (voidFor(readState(t.actor)?.phase, cfg)) return true;
      }
      return false;
    });
  }).catch((e) => warn("boss-cycle: the void source could not register", e));
  // the next fall's transition may warm up while the battle's core is on this canvas (prepare, every client)
  const sync = () => { try { syncPrepares(); } catch (e) { warn("boss-cycle: prepare sync threw", e); } };
  Hooks.on("canvasReady", sync);
  Hooks.on("createToken", (td) => { if (isCoreToken(td)) setTimeout(sync, 0); });
  Hooks.on("deleteToken", (td) => { if (isCoreToken(td)) sync(); });
  Hooks.on("canvasTearDown", releasePrepares);
  // an outside write that takes Zero Power to 6 during the Oath ascends at once (GM; the rule's onActorUpdate gates it)
  Hooks.on("updateActor", (actor, change) => {
    try {
      if (!game.user?.isGM) return;
      if (change?.system?.props?.zero_power_value === undefined) return;
      const director = globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.();
      if (!director?.dCombat?.started || director.dCombat.ended) return;
      runBossActorUpdate(director, actor, change);
    } catch (e) { warn("boss-cycle: updateActor watcher threw", e); }
  });
  // a battle that ended any way at all leaves no core behind (GM)
  Hooks.on("fu-director-stopped", () => {
    if (!game.user?.isGM) return;
    for (const scene of game.scenes ?? []) {
      if ((scene.tokens?.contents ?? []).some((td) => isCoreToken(td) && flagsOf(td).conflictSpawned)) sweepStrayCores(scene);
    }
  });
}

/** Rigs / console. */
export const bossCycleDebug = { bossOf, coreOf, readState, phaseOf, isOutOfPlay, readCycleConfig, isPermanentExposed, permanentDue, everyPcHas, isCyclePc };
