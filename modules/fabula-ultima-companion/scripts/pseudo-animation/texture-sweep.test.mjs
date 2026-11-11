// Node checks for the animation-script texture sweep. No game, a fake PIXI.
// Run: node scripts/pseudo-animation/texture-sweep.test.mjs
import { sweepAllowed, scopedPixi, basesInUse, sweepWhenUnused } from "./texture-sweep.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

// ---- fake PIXI: Texture.from caches per element id, like PIXI 7
let uid = 0;
class BaseTexture {
  constructor(src) { this.resource = { source: src }; this.destroyed = false; }
  destroy() { this.destroyed = true; }
  static from(src) { if (!src._pixiId) src._pixiId = `pixiid_${++uid}`; return (src.__bt ??= new BaseTexture(src)); }
}
class Texture {
  constructor(b) { this.baseTexture = b; }
  static from(src) { return new Texture(typeof src === "string" ? (URLS[src] ??= new BaseTexture({ url: src })) : BaseTexture.from(src)); }
}
class Sprite { constructor(t) { this.texture = t; this.children = []; } static from(src) { return new Sprite(Texture.from(src)); } }
const URLS = {};
const P = { Texture, BaseTexture, Sprite, BLEND_MODES: { ADD: 1 } };
const el = (tag) => ({ tagName: tag, isConnected: false, paused: false, src: "x", pause() { this.paused = true; }, removeAttribute() { this.src = ""; }, load() {} });

// ---- sweepAllowed
ok(sweepAllowed("const t = PIXI.Texture.from(cv); globalThis.__TARGETS; globalThis.FUCompanion.api"), "read-only globals are fine");
ok(!sweepAllowed("globalThis.__ZP_TEX ??= PIXI.Texture.from(cv)"), "a global texture cache opts out");
ok(!sweepAllowed("window.__ONI_RW_SPRITES.set(id, s)"), "a global sprite store opts out");
ok(!sweepAllowed("globalThis[key] = 1"), "computed global writes opt out");
ok(!sweepAllowed("// oni:keep-textures\nPIXI.Texture.from(cv)"), "the explicit marker opts out");

// ---- scopedPixi notes only element textures this call created
const made = new Set();
const S = scopedPixi(P, made);
const cv = el("CANVAS"), vid = el("VIDEO"), owned = el("VIDEO");
BaseTexture.from(owned);                       // someone else's (a token's video) — known to PIXI already
const tCv = S.Texture.from(cv), sVid = S.Sprite.from(vid);
S.Texture.from("modules/x/fire.webm");          // URL: Foundry's shared file
S.Texture.from(owned);
ok(made.size === 2 && made.has(tCv.baseTexture) && made.has(sVid.texture.baseTexture), `notes 2 element textures, got ${made.size}`);
ok(S.BLEND_MODES.ADD === 1 && new S.Texture(tCv.baseTexture) instanceof Texture, "the rest of the namespace passes through");
ok(new S.Sprite(tCv) instanceof Sprite, "constructors still work");

// ---- basesInUse sees sprites, masks and filter uniforms
const root = { children: [{ texture: tCv, children: [] }, { children: [], mask: { texture: sVid.texture, children: [] } }] };
const used = basesInUse(root);
ok(used.has(tCv.baseTexture) && used.has(sVid.texture.baseTexture), "stage, mask and child textures count as in use");

// ---- sweepWhenUnused frees only what nothing shows, and stops a video
const delay = () => Promise.resolve();
let r = await sweepWhenUnused(made, { root: () => root, every: 0, tries: 2, delay });
ok(r.freed === 0 && r.left === 2, "still shown -> kept");
root.children = [];                              // the tail ended
r = await sweepWhenUnused(made, { root: () => root, every: 0, tries: 2, delay });
ok(r.freed === 2 && tCv.baseTexture.destroyed && sVid.texture.baseTexture.destroyed, "unused -> destroyed");
ok(vid.paused && vid.src === "", "the video was stopped and emptied");
ok(!owned.__bt.destroyed && !URLS["modules/x/fire.webm"].destroyed, "someone else's and URL textures untouched");

const m2 = new Set([BaseTexture.from(Object.assign(el("VIDEO"), { isConnected: true }))]);
r = await sweepWhenUnused(m2, { root: () => ({ children: [] }), every: 0, tries: 1, delay });
ok(r.freed === 0, "a video element shown in the page is left alone");

console.log(`texture-sweep: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
