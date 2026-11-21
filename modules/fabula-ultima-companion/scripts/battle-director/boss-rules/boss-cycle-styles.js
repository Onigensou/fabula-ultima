// ============================================================================
// Boss Cycle — the named pieces a cycle's settings point at (leaf, no imports).
//
//   Transitions: the show that plays when the boss goes down, and when it
//   returns. A presentation module registers one by name; the boss's settings
//   name it (bossCycle.transition.first / .repeat / .return). The cycle's rules
//   follow the show's beats on the GM's wall clock, and run at once when there
//   is no show (sim / lean / nobody watching / unknown name): skip the show,
//   never the rules.
//
//     registerBossCycleTransition(name, {
//       present(spec) -> { at(s), done } | null   // GM: start it on every client
//         spec = { variant: "first" | "repeat" | "return", sceneId, bossTokenId, coreTokenId }
//       beats(spec)   -> seconds on that clock. A FALL (variant first / repeat):
//         down   = the boss's hold breaks (onDown runs: e.g. every Soul Fragment destroyed)
//         hidden = the boss is gone (goes out of play)
//         reveal = the core is in play (targetable)
//       A RETURN (variant "return", at the ROUND_START after the last exposed round):
//         hidden = the core is gone (goes out of play)
//         reveal = the boss is back: full HP / MP (returnHp / returnMp), in play, KO +
//                  Crisis reconciled, the cycle's next phase (active, cycle + 1)
//         (`down` unused). The new round (its banner, its turns) starts after `done`.
//       prepare(spec) -> release()   // optional, EVERY client: the battle's core is on this canvas, the next
//         fall plays this transition (spec.variant); warm up for it (Nidhogg's fall: its smoke painters rehearse).
//         Called once per battle; release() when the battle ends or the canvas goes (boss-cycle.js syncPrepares).
//         The battle's transition.return is prepared too (spec.variant "return"; Nidhogg's return: phase 2's
//         still pieces made ahead).
//     })
//
//   Registered: "nidhogg-fall-first" / "nidhogg-fall-repeat" (sealing-crystal/
//   nidhogg-fall-show.js), "nidhogg-return" (sealing-crystal/nidhogg-return-show.js,
//   clock nidhogg-return.js: hidden = the core gone 3.6 s, reveal = the roar 11.35 s).
//
//   Stage readers: what BOSS_STAGE reads for this boss (bossCycle.stage). Sync.
//     registerBossCycleStage(name, (ctx) => number)   ctx = { boss, core, cfg, state }
//   Built in: "core-hp-quarters" (0 intact, 1 / 2 / 3 at or below 75 / 50 / 25 %
//   of the core's HP), "cycle" (how many times the boss has gone down), "none".
// ============================================================================

const TRANSITIONS = new Map();
const STAGES = new Map();

export function registerBossCycleTransition(name, t) {
  if (!name || typeof t?.present !== "function") return;
  TRANSITIONS.set(String(name), t);
}
export const bossCycleTransition = (name) => (name ? TRANSITIONS.get(String(name)) ?? null : null);
export const bossCycleTransitionNames = () => [...TRANSITIONS.keys()];

export function registerBossCycleStage(name, fn) {
  if (!name || typeof fn !== "function") return;
  STAGES.set(String(name), fn);
}
export const bossCycleStageReader = (name) => STAGES.get(String(name ?? "")) ?? null;
export const bossCycleStageNames = () => [...STAGES.keys()];

/** 0 intact, 1 / 2 / 3 at or below 75 / 50 / 25 % (the Sealing Crystal's cracks read the same rule). */
export function hpQuarterStage(hp, max) {
  hp = Number(hp); max = Number(max);
  if (!(max > 0) || !Number.isFinite(hp)) return 0;
  const r = hp / max;
  return r <= 0.25 ? 3 : r <= 0.5 ? 2 : r <= 0.75 ? 1 : 0;
}

/**
 * S3: the floor the crack stage never drops below: the Oath's `stageBefore`, read off the core's "Boss Cycle" state AE
 * (flags.<ns>.bossCycleState.oath.stageBefore). The Oath raises the core's HP and Max together, which would lift the
 * fraction and close a crack; the cracks never close.
 */
export function crackFloorOf(actor) {
  for (const e of actor?.effects?.contents ?? []) {
    const st = e?.flags?.["fabula-ultima-companion"]?.bossCycleState;
    if (st) return Math.max(0, Math.min(3, Math.round(Number(st.oath?.stageBefore)) || 0));
  }
  return 0;
}

registerBossCycleStage("core-hp-quarters", ({ core, state }) => {
  const p = core?.system?.props ?? {};
  return Math.max(hpQuarterStage(p.current_hp, p.max_hp), Number(state?.oath?.stageBefore) || 0);
});
registerBossCycleStage("cycle", ({ state }) => Number(state?.cycle) || 0);
registerBossCycleStage("none", () => 0);
