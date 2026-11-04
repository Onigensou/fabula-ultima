// ============================================================================
// Default action animations — script builder harness.
//
//     node scripts/battle-director/action-anim-script.test.mjs
//
// The generated script is code that only ever runs inside Foundry, so these
// checks stand in for the first live run: the house storage guards (exactly two
// backticks, nothing that ends the String.raw early), the outer compiling the
// way director-animation compiles it, and the INNER actually executed against
// stubbed oni / canvas / PIXI on every branch — attack, crit, miss, ranged,
// Chain N, composer beats — asserting the hooks the director waits on fire.
// ============================================================================
import assert from "node:assert/strict";
import { buildDefaultScript, innerBody } from "./action-anim-script.js";
import { pickAttack, composeBeats, resolveBeats } from "./action-anim-rules.js";

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ── a stub world just big enough for the inner ──────────────────────────
function stubEnv({ strikes = [], targets = 1, casterDisp = 1 } = {}) {
  const log = [];
  const hooks = new Map();
  const Hooks = {
    callAll: (name, d) => { log.push("hook:" + name); for (const h of hooks.get(name) ?? []) h(d); },
    on: (name, h) => { hooks.set(name, [...(hooks.get(name) ?? []), h]); return h; },
    off: (name, h) => hooks.set(name, (hooks.get(name) ?? []).filter((x) => x !== h)),
  };
  const pt = () => ({ x: 0, y: 0, set(x, y) { this.x = x; this.y = y; }, copyFrom() {} });
  class Sprite { constructor() { this.anchor = pt(); this.scale = pt(); this.position = pt(); this.destroyed = false; } destroy() { this.destroyed = true; } }
  class Graphics extends Sprite { lineStyle() {} moveTo() {} lineTo() {} beginFill() {} endFill() {} drawStar() {} drawCircle() {} }
  class ColorMatrixFilter { hue() {} saturate() {} brightness() {} }
  const PIXI = { Sprite, Graphics, ColorMatrixFilter, BLEND_MODES: { ADD: 1 } };
  const tick = new Set();
  const canvas = { dimensions: { sceneWidth: 3364 }, stage: { addChild() {}, sortableChildren: false }, app: { ticker: { add: (f) => tick.add(f), remove: (f) => tick.delete(f) } } };
  const mkTok = (id, x, disp) => ({ id, center: { x, y: 300 }, x: x - 50, y: 250, w: 100, h: 100,
    mesh: { x, y: 300, texture: {}, anchor: pt(), scale: pt(), angle: 0 }, document: { uuid: "Scene.s.Token." + id, disposition: disp } });
  const caster = mkTok("caster", 1300, casterDisp);
  const tgts = Array.from({ length: targets }, (_, i) => mkTok("t" + i, 300 + i * 50, -1));
  const oni = {
    EASE: { inOutQuad: (v) => v, outQuad: (v) => v, linear: (v) => v },
    tween: async ({ onUpdate }) => { onUpdate?.(0.5); onUpdate?.(1); },
    cloneToken: () => new Sprite(),
    hideToken: () => () => log.push("restore"),
    vfx: async (url) => { log.push("vfx:" + url.split("/").pop()); return { sprite: new Sprite(), ended: Promise.resolve() }; },
    sfx: (url) => log.push("sfx:" + String(url).split("/").pop()),
    hit: () => log.push("hit"),
    screenshake: () => log.push("shake"),
    radialTexture: () => ({}),
  };
  const wait = async () => {};
  const ctx = { casterToken: caster, targetTokens: tgts, params: { doneHook: "done", readyHook: "ready", cfg: null, strikes } };
  return { log, Hooks, PIXI, canvas, oni, wait, ctx, tick };
}

// Pull CFG out of a generated script and run its inner in the stub.
async function runInner(script, env) {
  const m = script.match(/^const CFG = (.*);$/m);
  env.ctx.params.cfg = JSON.parse(m[1]);
  const inner = script.slice(script.indexOf("String.raw`") + "String.raw`".length, script.lastIndexOf("`;"));
  const fn = new Function("ctx", "canvas", "PIXI", "FAudioHelper", "loadTexture", "fromUuid", "wait", "foundry", "oni", "Sequence", "Hooks",
    `"use strict"; return (async () => {\n${inner}\n})();`);
  await fn(env.ctx, env.canvas, env.PIXI, null, null, null, env.wait, null, env.oni, undefined, env.Hooks);
  return env.log;
}

const attackScript = (o, extra = {}) => buildDefaultScript({ mode: "attack", key: "test", attack: pickAttack(o), ...extra });
const beatsScript = (props, { outcome = "hit", element = "Physical", intent = "harmful", attackLike = false } = {}) =>
  buildDefaultScript({ mode: "beats", key: "test", attackLike,
    beats: resolveBeats(composeBeats(props, { intent, aeTagOf: (x) => (x === "Poison" ? "debuff" : null) }).beats, { outcome, element, attackLike }) });

// ── storage guards ──────────────────────────────────────────────────────
t("the inner body has no backtick and no ${ (it lives in a String.raw)", () => {
  const body = innerBody();
  assert.ok(body.length > 500);
  assert.equal(/`/.test(body), false);
  assert.equal(body.includes("${"), false);
});
t("every generated script has exactly two backticks", () => {
  for (const s of [attackScript({ category: "Sword" }), attackScript({ category: "Bow", outcome: "crit" }), beatsScript({ type_damage: "Fire", action_keywords: "drain" })]) {
    assert.equal((s.match(/`/g) || []).length, 2);
  }
});
t("the outer compiles the way director-animation compiles it", () => {
  for (const s of [attackScript({ category: "Firearm", element: "Ice" }), beatsScript({ type_damage: "Healing" }, { intent: "aid" })]) {
    new Function("payload", "targets", '"use strict";\n' + s);
  }
});
t("the script names every clip and sound URL it plays (so staging preloads them)", () => {
  const s = attackScript({ category: "Sword", element: "Fire" });
  assert.match(s, /RPG%20Maker%20MV\/008_slash_fire\.webm/);
  assert.match(s, /SE_BTL_HitSlashS\.ogg/);
  assert.match(s, /SE_BTL_HitFire\.ogg/);
});
t("the same plan always builds the same text (the director caches by text)", () => {
  assert.equal(attackScript({ category: "Spear" }), attackScript({ category: "Spear" }));
});

// ── the inner, executed ─────────────────────────────────────────────────
const order = (log, ...items) => {
  let i = -1;
  for (const it of items) { const j = log.indexOf(it, i + 1); assert.ok(j > i, `expected ${it} after index ${i} in ${log.join(", ")}`); i = j; }
};
t("melee hit: ready → swing → clip → hit cue → actor restored → done", async () => {
  const log = await runInner(attackScript({ category: "Sword" }), stubEnv());
  order(log, "hook:ready", "sfx:SE_SWINGA.wav", "vfx:006_slash_physical.webm", "hit", "restore", "hook:done");
});
t("crit: special clip, shake, crit sound", async () => {
  const log = await runInner(attackScript({ category: "Sword", outcome: "crit" }), stubEnv());
  order(log, "vfx:023_slash_special_1.webm", "shake", "sfx:SE_BTL_HitCritical.ogg", "hook:done");
});
t("miss: a swing and a hit cue, no clip", async () => {
  const log = await runInner(attackScript({ category: "Spear", outcome: "miss" }), stubEnv());
  assert.equal(log.some((x) => x.startsWith("vfx:")), false);
  order(log, "sfx:SE_SWINGA.wav", "hit", "hook:done");
});
t("bow / thrown / gun fire from where they stand", async () => {
  order(await runInner(attackScript({ category: "Bow" }), stubEnv()), "sfx:Crossbow.ogg", "vfx:011_pierce_physical.webm", "hook:done");
  order(await runInner(attackScript({ category: "Thrown" }), stubEnv()), "sfx:SE_SWINGA.wav", "vfx:001_hit_physical.webm", "hook:done");
  order(await runInner(attackScript({ category: "Firearm" }), stubEnv()), "sfx:GunshotA.ogg", "vfx:111_shoot_normal.webm", "hook:done");
});
t("all targets get the clip", async () => {
  const log = await runInner(attackScript({ category: "Sword" }), stubEnv({ targets: 3 }));
  assert.equal(log.filter((x) => x === "vfx:006_slash_physical.webm").length, 3);
});
t("element tint: an Air hit still plays (filter applied, no throw)", async () => {
  order(await runInner(attackScript({ category: "Sword", element: "Air" }), stubEnv()), "vfx:007_slash_effect.webm", "hook:done");
});
t("Chain 3: one hit cue per strike; a missed strike swings", async () => {
  const strikes = [
    { outcomes: [{ tokenUuid: "Scene.s.Token.t0", kind: "hit" }] },
    { outcomes: [{ tokenUuid: "Scene.s.Token.t0", kind: "miss" }] },
    { outcomes: [{ tokenUuid: "Scene.s.Token.t0", kind: "hit", isCrit: true }] },
  ];
  const log = await runInner(attackScript({ category: "Sword" }), stubEnv({ strikes }));
  assert.equal(log.filter((x) => x === "hit").length, 3);
  assert.equal(log.filter((x) => x === "vfx:006_slash_physical.webm").length, 2);
  assert.ok(log.includes("shake"));
});
t("composer — Venom Bite hit: damage then poison on the target", async () => {
  const props = { type_damage: "Poison", effect_table: { 0: { effect_label: "p", effect_kind: "apply_ae", target_ref: "hit_action_targets", ae_template_ref: "Poison" } } };
  const log = await runInner(beatsScript(props, { element: "Poison", attackLike: true }), stubEnv());
  order(log, "hook:ready", "vfx:002_hit_effect.webm", "hit", "vfx:054_powerdown_1.webm", "restore", "hook:done");
});
t("composer — Venom Bite miss: no clip at all, the poison is dropped", async () => {
  const props = { type_damage: "Poison", effect_table: { 0: { effect_label: "p", effect_kind: "apply_ae", target_ref: "hit_action_targets", ae_template_ref: "Poison" } } };
  const log = await runInner(beatsScript(props, { outcome: "miss", element: "Poison" }), stubEnv());
  assert.equal(log.some((x) => x.startsWith("vfx:")), false);
  order(log, "hit", "hook:done");
});
t("composer — Life Drain: damage on the target, heal on the caster", async () => {
  const log = await runInner(beatsScript({ type_damage: "Dark", action_keywords: "drain" }, { element: "Dark" }), stubEnv());
  order(log, "vfx:002_hit_effect.webm", "vfx:041_heal_one_1.webm", "hook:done");
});
t("composer — heal skill: the heal beat plays with its own sound", async () => {
  const log = await runInner(beatsScript({ type_damage: "Healing" }, { intent: "aid" }), stubEnv());
  order(log, "sfx:Heal3.ogg", "vfx:041_heal_one_1.webm", "hook:done");
});
t("no caster on the canvas: still signals ready and done", async () => {
  const env = stubEnv(); env.ctx.casterToken = null;
  order(await runInner(attackScript({ category: "Sword" }), env), "hook:ready", "hook:done");
});
t("the follow ticker is removed at the end", async () => {
  const env = stubEnv();
  await runInner(attackScript({ category: "Sword" }), env);
  assert.equal(env.tick.size, 0);
});

for (const [name, fn] of tests) { await fn(); n++; console.log("  ok", name); }
console.log(`\n${n} passed`);
