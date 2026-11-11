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
//                      over into the exposed round (true)
//   holdConflictEvent  the scene's conflict event skips its round-end beat from the
//                      fall to the return (true; Soul Tithe neither locks nor Calls)
//   clearStatusesOnDown  the boss's buffs / debuffs are cleansed on the fall (true)
//   onDown             { conflictEventAction } run when the boss's hold breaks
//   returnHp / returnMp  "full" | "keep" (full)
//   roundLabel         the round banner's name for an exposed round ("")
//   transition         { first, repeat, return } named shows (boss-cycle-styles.js)
//   stage              what BOSS_STAGE reads ("core-hp-quarters")
//   voidWhileExposed   the arena goes pitch black from the fall to the return (false)
//
// While the boss fights, the core stands OUT OF PLAY (out-of-play.js: hidden,
// untargetable, no turns) but alive, so the side is never wiped by the boss's
// fall. The boss at 0 HP → at the END of that turn (the action and its
// reactions have settled) the transition plays; the boss goes out of play, the
// core comes into play; the round is cut; the next round is exposed. At the
// last exposed round's end (round_end reactions as usual) the boss returns at
// once (v1; transition.return later) and the core goes out of play again.
// The core broken → its own defeat (style) → victory. The core pays no rewards
// of its own if its actor carries noRewards.
//
// State: an AE on the core ("Boss Cycle", flags.<ns>.bossCycleState =
// { phase, cycle, exposedLeft }) — survives F5, rewinds with the actor,
// replicates; every client reads it for the void.
//   active ─(boss at 0, at a boundary)─► falling ─(hidden beat)─► down
//   down ─(ROUND_START)─► exposed ─(after exposeRounds, ROUND_START)─► active (cycle + 1)
// ============================================================================

import { log, warn } from "../logger.js";
import { registerBossRule } from "./boss-rules.js";
import { isOutOfPlay, setOutOfPlay } from "../out-of-play.js";
import { bossCycleTransition, bossCycleStageReader } from "./boss-cycle-styles.js";

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
  };
}

/** The boss is at 0 HP at a turn boundary: does its fall play now? */
export const fallsNow = (phase, down) => !!down && (phase === "active" || phase === "falling");
export const fallVariant = (cycle) => ((Number(cycle) || 0) === 0 ? "first" : "repeat");
/**
 * The round boundary (ROUND_START, before turns are dealt): what happens.
 * -> { state, act: "expose" | "stay" | "return" | null, label }
 */
export function atRoundBoundary(state, cfg) {
  const s = state ?? { phase: "active", cycle: 0, exposedLeft: 0 };
  if (s.phase === "down") return { state: { ...s, phase: "exposed", exposedLeft: cfg.exposeRounds }, act: "expose", label: cfg.roundLabel || null };
  if (s.phase === "exposed") {
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

const stateAe = (actor) => (actor?.effects?.contents ?? []).find((e) => flagsOf(e)[STATE_FLAG]) ?? null;
export function readState(actor) {
  const s = flagsOf(stateAe(actor))[STATE_FLAG];
  return s ? { phase: PHASES.includes(s.phase) ? s.phase : "active", cycle: Number(s.cycle) || 0, exposedLeft: Number(s.exposedLeft) || 0 } : null;
}
async function writeState(actor, next) {
  const ae = stateAe(actor), state = { phase: next.phase, cycle: Number(next.cycle) || 0, exposedLeft: Number(next.exposedLeft) || 0 };
  if (ae) await ae.update({ [`flags.${NS}.${STATE_FLAG}`]: state });
  else {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: STATE_AE_NAME, img: "icons/svg/clockwork.svg", disabled: false, transfer: false, changes: [],
      // never ticked, but it belongs to this battle (the scene-end sweep takes it)
      flags: { [NS]: { [STATE_FLAG]: state, directorPermanent: true, conflictScoped: true } },
    }]);
  }
  log(`boss-cycle: phase ${state.phase} (cycle ${state.cycle}${state.phase === "exposed" ? `, ${state.exposedLeft} exposed round(s) left` : ""})`);
}
const phaseOf = (director) => readState(coreOf(director)?.actorDoc)?.phase ?? null;

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
  const feet = { x: td.x + (td.width * g) / 2, y: td.y + td.height * g };
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

async function playFall(director, where) {
  const dc = director.dCombat, boss = bossOf(director), core = coreOf(director, boss);
  if (!boss || !core) return null;
  const { cfg } = boss, bossActor = boss.c.actorDoc;
  const st = readState(core.actorDoc) ?? { phase: "active", cycle: 0, exposedLeft: 0 };
  const variant = fallVariant(st.cycle);
  log(`boss-cycle: ${bossActor?.name} falls (${variant}, at ${where})`);
  await writeState(core.actorDoc, { ...st, phase: "falling" });

  if (cfg.clearStatusesOnDown) {
    try { const { cleanseBuffsDebuffsOnKO } = await import("../defeat-reactor.js"); await cleanseBuffsDebuffsOnKO(bossActor); }
    catch (e) { warn("boss-cycle: the cleanse threw", e); }
  }

  const t = bossCycleTransition(cfg.transition[variant]);
  const spec = { variant, sceneId: dc.scene?.id ?? null, bossTokenId: boss.c.tokenDoc?.id ?? null, coreTokenId: core.tokenDoc?.id ?? null };
  let show = null, beats = { down: 0, hidden: 0, reveal: 0 };
  if (t) {
    try { show = t.present(spec); beats = { ...beats, ...(t.beats?.(spec) ?? {}) }; }
    catch (e) { warn(`boss-cycle: the "${cfg.transition[variant]}" transition could not start — the rules run without it`, e); show = null; }
  } else if (cfg.transition[variant]) warn(`boss-cycle: no transition named "${cfg.transition[variant]}" is registered — the rules run without a show`);
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

/* ── The return (v1: an instant swap at the round boundary) ──────────────── */

async function returnBoss(director, boss, core, next) {
  const { cfg } = boss, a = boss.c.actorDoc, p = a?.system?.props ?? {};
  await setOutOfPlay(core.actorDoc, true, { reason: RULE_ID });
  const upd = {};
  if (cfg.returnHp === "full" && Number.isFinite(Number(p.max_hp))) upd["system.props.current_hp"] = Number(p.max_hp);
  if (cfg.returnMp === "full" && Number.isFinite(Number(p.max_mp))) upd["system.props.current_mp"] = Number(p.max_mp);
  if (Object.keys(upd).length) await a.update(upd);
  await setOutOfPlay(a, false);
  try { const { settleRevive } = await import("../defeat-reactor.js"); await settleRevive(a); } catch (e) { warn("boss-cycle: the KO reconcile threw", e); }
  try { const { evaluateCrisis } = await import("../crisis-reactor.js"); await evaluateCrisis(a); } catch (e) { warn("boss-cycle: the Crisis reconcile threw", e); }
  await writeState(core.actorDoc, next);
  log(`boss-cycle: ${a?.name} returns (cycle ${next.cycle})`);
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
    await spawnCore(director);
  },
  async pendingBeat(director, where) {
    if (!game.user?.isGM) return null;
    const boss = bossOf(director), core = coreOf(director, boss);
    if (!boss || !core) return null;
    const phase = readState(core.actorDoc)?.phase ?? "active";
    if (!fallsNow(phase, isDown(boss.c.actorDoc))) return null;
    // a fall at round_start (a round_end DoT): that round already ended in full; nothing is cut
    const res = await playFall(director, where);
    return where === "round_start" ? null : res;
  },
  roundEndTrigger: (director) => roundEndTriggerFor(phaseOf(director), bossOf(director)?.cfg),
  skipsRoundEndSweep: (director) => skipsSweepFor(phaseOf(director), bossOf(director)?.cfg),
  holdsConflictEvent: (director) => holdsEventFor(phaseOf(director), bossOf(director)?.cfg),
  stage: (director) => {
    const boss = bossOf(director);
    if (!boss) return 0;
    const core = coreOf(director, boss);
    const fn = bossCycleStageReader(boss.cfg.stage);
    return fn ? Number(fn({ boss: boss.c.actorDoc, core: core?.actorDoc ?? null, cfg: boss.cfg, state: readState(core?.actorDoc) })) || 0 : 0;
  },
  async roundBoundary(director) {
    if (!game.user?.isGM) return null;
    const boss = bossOf(director), core = coreOf(director, boss);
    const st = readState(core?.actorDoc);
    if (!boss || !st) return null;
    const { state, act, label } = atRoundBoundary(st, boss.cfg);
    if (act === "expose" || act === "stay") await writeState(core.actorDoc, state);
    else if (act === "return") await returnBoss(director, boss, core, state);
    return label ? { label } : null;
  },
};

registerBossRule(BossCycle);

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
  // a battle that ended any way at all leaves no core behind (GM)
  Hooks.on("fu-director-stopped", () => {
    if (!game.user?.isGM) return;
    for (const scene of game.scenes ?? []) {
      if ((scene.tokens?.contents ?? []).some((td) => isCoreToken(td) && flagsOf(td).conflictSpawned)) sweepStrayCores(scene);
    }
  });
}

/** Rigs / console. */
export const bossCycleDebug = { bossOf, coreOf, readState, phaseOf, isOutOfPlay, readCycleConfig };
