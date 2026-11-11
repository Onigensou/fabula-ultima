// ============================================================================
// Boss Cycle — the named pieces a cycle's settings point at (leaf, no imports).
//
//   Transitions: the show that plays when the boss goes down (and, later, when
//   it returns). A presentation module registers one by name; the boss's
//   settings name it (bossCycle.transition.first / .repeat / .return). The
//   cycle's rules follow the show's beats on the GM's wall clock, and run at
//   once when there is no show (sim / lean / nobody watching / unknown name):
//   skip the show, never the rules.
//
//     registerBossCycleTransition(name, {
//       present(spec) -> { at(s), done } | null   // GM: start it on every client
//         spec = { variant: "first" | "repeat" | "return", sceneId, bossTokenId, coreTokenId }
//       beats(spec)   -> { down, hidden, reveal } // seconds on that clock:
//         down   = the boss's hold breaks (onDown runs: e.g. every Soul Fragment destroyed)
//         hidden = the boss is gone (goes out of play)
//         reveal = the core is in play (targetable)
//     })
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

registerBossCycleStage("core-hp-quarters", ({ core }) => {
  const p = core?.system?.props ?? {};
  return hpQuarterStage(p.current_hp, p.max_hp);
});
registerBossCycleStage("cycle", ({ state }) => Number(state?.cycle) || 0);
registerBossCycleStage("none", () => 0);
