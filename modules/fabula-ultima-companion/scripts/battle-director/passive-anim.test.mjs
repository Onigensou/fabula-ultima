// node scripts/battle-director/passive-anim.test.mjs
// The passive fallback's inner script, executed against stubbed oni / canvas / PIXI.
import assert from "node:assert/strict";
import { passiveInnerBody, buildPassiveCfg } from "./passive-anim.js";

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

function env() {
  const log = [];
  const pt = () => ({ x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } });
  class Sprite { constructor() { this.anchor = pt(); this.position = pt(); this.destroyed = false; } destroy() { this.destroyed = true; log.push("destroy"); } }
  class Graphics extends Sprite { clear() {} lineStyle() {} moveTo() {} lineTo() { log.push("arc-seg"); } }
  const PIXI = { Sprite, Graphics, Texture: { from: () => ({}) }, BLEND_MODES: { ADD: 1 } };
  const stage = { children: [], sortableChildren: false, addChild(c) { this.children.push(c); } };
  const canvas = { dimensions: { sceneWidth: 2560 }, stage };
  const toks = {
    "Scene.s.Token.owner": { center: { x: 400, y: 300 }, x: 350, y: 250, w: 100, h: 100 },
    "Scene.s.Token.a": { center: { x: 1500, y: 300 }, x: 1450, y: 250, w: 100, h: 100 },
    "Scene.s.Token.b": { center: { x: 1500, y: 500 }, x: 1450, y: 450, w: 100, h: 100 },
  };
  globalThis.fromUuidSync = (u) => (toks[u] ? { object: toks[u] } : null);
  globalThis.document = { createElement: () => ({ getContext: () => ({ createLinearGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) };
  const oni = {
    EASE: { inOutQuad: (v) => v, outQuad: (v) => v, linear: (v) => v },
    tween: async ({ onUpdate }) => { onUpdate?.(0.5); onUpdate?.(1); },
    vfx: async (url) => { log.push("vfx:" + url.split("/").pop()); return { sprite: new Sprite(), ended: Promise.resolve() }; },
    sfx: (url) => log.push("sfx:" + url.split("/").pop()),
  };
  return { log, PIXI, canvas, oni, stage };
}
async function run(cfg, e) {
  const fn = new Function("ctx", "canvas", "PIXI", "FAudioHelper", "loadTexture", "fromUuid", "wait", "foundry", "oni", "Sequence",
    `"use strict"; return (async () => {\n${passiveInnerBody()}\n})();`);
  await fn({ params: { cfg } }, e.canvas, e.PIXI, null, null, null, async () => {}, null, e.oni, undefined);
  return e.log;
}

t("inner body: no backtick, no ${", () => {
  const b = passiveInnerBody();
  assert.ok(b.length > 300);
  assert.equal(/`/.test(b), false);
  assert.equal(b.includes("${"), false);
});
t("Lightning Charge: MP lines + the recovery sound, all sprites cleaned up", async () => {
  const e = env();
  const log = await run(buildPassiveCfg({ ownerTokenUuid: "Scene.s.Token.owner", beats: [{ k: "mp", recipients: ["Scene.s.Token.owner"] }] }), e);
  assert.ok(log.includes("sfx:Recovery.ogg"));
  assert.equal(log.filter((x) => x === "destroy").length >= 10, true);
  assert.equal(e.stage.children.every((c) => c.destroyed), true);
});
t("Earthen Wire: an arc from the owner, then the bolt hit on the new target — no hit sound", async () => {
  const e = env();
  const log = await run(buildPassiveCfg({ ownerTokenUuid: "Scene.s.Token.owner", beats: [{ k: "redirect", recipients: ["Scene.s.Token.a"], element: "bolt" }] }), e);
  assert.ok(log.includes("arc-seg"));
  assert.ok(log.includes("vfx:005_hit_thunder.webm"));
  assert.equal(log.some((x) => x.startsWith("sfx:")), false);
});
t("damage on two targets: two hit clips; debuff lines then", async () => {
  const e = env();
  const log = await run(buildPassiveCfg({ ownerTokenUuid: "Scene.s.Token.owner", beats: [
    { k: "damage", recipients: ["Scene.s.Token.a", "Scene.s.Token.b"], element: "fire" },
    { k: "debuff", recipients: ["Scene.s.Token.a"] },
  ] }), e);
  assert.equal(log.filter((x) => x === "vfx:003_hit_fire.webm").length, 2);
  assert.ok(log.includes("sfx:Down2.ogg"));
});
t("a recipient no longer on the canvas is skipped, nothing throws", async () => {
  const e = env();
  const log = await run(buildPassiveCfg({ ownerTokenUuid: "Scene.s.Token.gone", beats: [{ k: "redirect", recipients: ["Scene.s.Token.gone"], element: "bolt" }] }), e);
  assert.equal(log.length, 0);
});

for (const [name, fn] of tests) { await fn(); n++; console.log("  ok", name); }
console.log(`\n${n} passed`);
