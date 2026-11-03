// A whole hands-free battle through the sim runner (FUCompanion.api.experimental.sim), with
// what happened recorded in a comparable form. Runs in the runner (run.mjs --eval) AND in
// the Staging World (referee-staging.mjs --eval), so the real engine referees it.
// Profile: --profile battle (Training Ground + the party + Hellhound + Imp).
//
// Options: globalThis.__SIM_OPTS (prepend `globalThis.__SIM_OPTS = {...};` in a wrapper
// file to vary them), defaults below. `seed` pins Math.random AND the dice
// (CONFIG.Dice.randomUniform) for the whole fight, so two engines can be asked to play the
// SAME battle; null leaves both random.
const O = Object.assign({
  caster: "Blanche", skill: "Provoke", enemy: "Hellhound", targets: "enemy", once: true,
  startingZp: 0, maxRounds: 3, expectedRounds: 3, seed: 1,
}, globalThis.__SIM_OPTS ?? {});
const sim = FUCompanion.api.experimental?.sim;
if (!sim?.testSkill) return { error: "sim runner not registered" };
if (game.paused) await game.togglePause(false, true);   // a paused world parks the director
// The Field reseeds its scene effects for the viewed scene after the canvas loads (the copies on
// disk belong to whatever scene was active last). Unsettled, that reseed landed INSIDE the battle
// window on the Staging World and not in the runner: 5 "Wellspring" creates only one side recorded.
{
  const sceneId = canvas.scene?.id;
  const settled = () => game.actors.filter((a) => a.flags?.["fabula-ultima-companion"]?.isField)
    .every((f) => f.effects.contents.every((e) => e.flags?.["fabula-ultima-companion"]?.fieldOrigin !== "scene" || e.flags["fabula-ultima-companion"].fieldSceneId === sceneId));
  for (let i = 0; i < 60 && !settled(); i++) await new Promise((r) => setTimeout(r, 250));
}
const enemy = game.actors.getName(O.enemy);
if (!enemy) return { error: `no enemy actor ${O.enemy}` };

const mulberry = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const real = { random: Math.random, uniform: CONFIG.Dice.randomUniform };
// traceDraws: who drew each random number (the first non-wrapper stack frame), so two runs
// that diverge can be lined up draw by draw to find the first call one engine made and the other didn't.
const draws = [];
const caller = () => {
  const lines = String(new Error().stack).split("\n").slice(2);
  const f = lines.find((l) => !/sim-battle|mulberry|<anonymous>/.test(l)) ?? ("anon " + lines.slice(0, 3).join(" | "));
  return f.replace(/^\s*at\s+/, "").replace(/https?:\/\/localhost:\d+\//, "").replace(/\?[^:]*/, "").slice(0, 160);
};
// Seeding Math.random as a whole is not enough: visual code draws from it too (pseudo-animations,
// the theme, Sequencer, damage numbers, pixi emitters, Token._draw), as often as it renders, and
// rendering follows the frame clock. A traced run (2026-11-03) had 377 draws, ~250 of them visual,
// interleaved with the engine's (weightedPick, enemy-autopilot, initiative, apply_ae pools), so two
// engines given the same seed fell out of step after a few actions. Visual callers get their own
// unseeded stream; the battle logic gets the seeded one.
// Tested against the WHOLE stack: animation scripts run through eval (runDynamicScript), so their
// own frames are <anonymous>; and the real client also renders the 3D stage (three.js), which a
// headless runner page did not, 156 draws in one lab battle.
// Core / vendor files sit on nearly every stack (Hooks.callAll, document writes), so those count
// only as the drawing frame itself; our own visual modules count anywhere on the stack.
const VISUAL_FRAME = /themes\/|sequencer|pixi|scripts\/foundry\.js|tokenmagic|token-variants/;
const VISUAL_STACK = /pseudo-animation|pseudoAnimation|runDynamicScript|damage-numbers|anim-studio|action-animation|animation-stage|three-r\d+|assets\/vendor\/|battle-stage/;
if (O.seed != null) {
  const r = mulberry(O.seed), d = mulberry(O.seed + 7919);
  Math.random = () => {
    const who = caller();
    const visual = VISUAL_FRAME.test(who) || VISUAL_STACK.test(String(new Error().stack).split("\n").slice(2).join("\n"));
    if (O.traceDraws && draws.length < 20000) draws.push(`${visual ? "v" : "M"} ${who}`);
    return visual ? real.random() : r();
  };
  CONFIG.Dice.randomUniform = () => { if (O.traceDraws && draws.length < 20000) draws.push("D " + caller()); return d(); };
}

// ---- what happened, in engine terms (names, not ids: ids are minted per run)
const ev = [];
const nm = (a) => String(a?.name ?? "?").replace(/ \[SIM\]$/, "");
const hooks = [];
const on = (name, fn) => hooks.push([name, Hooks.on(name, fn)]);
on("fu-director-action", (p) => ev.push({ k: "act", by: String(p.actorName ?? "?").replace(/ \[SIM\]$/, ""), kind: p.actionKind, name: p.actionName, el: p.element, to: (p.targetNames ?? []).map((n) => String(n ?? "?").replace(/ \[SIM\]$/, "")) }));
on("updateActor", (a, ch) => {
  const p = ch?.system?.props ?? {};
  for (const key of ["current_hp", "current_mp", "current_ip"]) if (key in p) ev.push({ k: "res", who: nm(a), key, v: p[key] });
});
on("createActiveEffect", (e) => ev.push({ k: "ae+", who: nm(e.parent), name: e.name }));
on("deleteActiveEffect", (e) => ev.push({ k: "ae-", who: nm(e.parent), name: e.name }));
on("fu-director-stopped", (p) => ev.push({ k: "stop", reason: p?.reason ?? null }));

const t0 = Date.now();
let res = null, err = null;
try {
  res = await sim.testSkill({
    caster: O.caster, skill: O.skill, enemy: enemy.uuid, targets: O.targets, once: O.once,
    startingZp: O.startingZp, maxRounds: O.maxRounds, expectedRounds: O.expectedRounds, pace: "fast", reactions: "apply",
  });
} catch (e) { err = String(e?.message ?? e); }
finally {
  for (const [n, id] of hooks) Hooks.off(n, id);
  Math.random = real.random; CONFIG.Dice.randomUniform = real.uniform;
}
const leftover = {
  directorState: game.scenes.filter((s) => s.getFlag("fabula-ultima-companion", "directorState")).map((s) => s.name),
  simClones: game.actors.filter((a) => / \[SIM\]$/.test(a.name)).map((a) => a.name),
  running: !!FUCompanion.api.experimental.battleDirector?.isRunning?.(),
};
const count = (k) => ev.filter((e) => e.k === k).length;
return {
  opts: O, ms: Date.now() - t0, err,
  outcome: res?.outcome ?? null, verdict: res?.verdict ?? null, rounds: res?.rounds ?? null, partyHpRemaining: res?.partyHpRemaining ?? null,
  combatants: (res?.combatants ?? []).map((c) => ({ name: String(c.name ?? "?").replace(/ \[SIM\]$/, ""), hp: c.hp ?? c.currentHp ?? null, defeated: c.defeated ?? null })),
  transcript: (res?.transcript ?? []).map((t) => (typeof t === "string" ? t : JSON.stringify(t)).replace(/ \[SIM\]/g, "")),
  counts: { act: count("act"), res: count("res"), "ae+": count("ae+"), "ae-": count("ae-") },
  events: ev, leftover, draws: O.traceDraws ? draws : undefined,
  runner: globalThis.__runner ? { unknown: __runner.unknown, errors: __runner.errors, writes: __runner.writes.length } : null,
};
