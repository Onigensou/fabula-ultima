"use strict";
// Game side, part 1: the game runtime's DRY RUN in Node, on a stub board shaped exactly like the mockup's stage (mockup px =
// board px, the mockup's two battlers, the mockup's perspective). Same move files + shared parts as the page; the game host
// instead of the mockup engine. Returns the runtime's report (trace at virtual ms, gate, result, …).
// Note: the runtime keeps a MessageChannel open, so a CLI that uses this must process.exit() when done.
const GB = require("../build/game-build.js");

// a Chain plan in BD's shape from a short list: "hit" | "miss" | "crit" | "perfect"
function strikesFrom(list, tokenUuid = "t0") {
  return list.map((k, n) => k === "perfect"
    ? { index: n + 1, roll: null, perfect: true, mult: 1.5, outcomes: [{ tokenUuid, kind: "hit", amount: 29, isCrit: true }] }
    : { index: n + 1, roll: null, outcomes: [{ tokenUuid, kind: k === "crit" ? "hit" : k, amount: k === "miss" ? 0 : 4, isCrit: k === "crit" }] });
}

async function dryRun({ key, files, actors, preset, assets, tune = {}, outcome = null, strikes = null, variant = null, playOpts = {}, seed = 2611 }) {
  const P = preset;
  const tokenScaleAt = (y) => { const den = P.refRow - P.horizon, num = Math.max(y - P.horizon, den * .05); return Math.min(P.maxScale, Math.max(P.minScale, Math.pow(num / den, P.strength))); };
  const tokOf = (a) => { const h = a.hb * a.s, w = a.wb * a.s; return { x: a.x, y: a.y - h / 2, w, h, foot: 1, flip: 1, token: {} }; };
  const TL = { STAGE: { x: 0, y: 0, w: 1682, h: 788 }, TOK: { k: tokOf(actors.caster), t0: tokOf(actors.target) }, POSE: {}, load: async () => {},
    feet: (T) => ({ x: T.x, y: T.y - T.h / 2 + T.h * T.foot }), art: () => null, depthS: (x, y) => tokenScaleAt(y), depthRatio: (a, b) => tokenScaleAt(b.y) / tokenScaleAt(a.y),
    mk: (T) => ({ clip(k, t0, o) { T.push({ t0, t1: t0 + 1000, clip: {}, o }); return {}; }, flash() {}, shake() {}, hold(t0, t1, fn) { T.push({ t0, t1, fn }); } }) };
  const el = () => ({ setAttribute() {}, style: {}, getContext: () => null, appendChild() {}, innerHTML: "" });
  globalThis.document = globalThis.document || { getElementById: () => null, createElementNS: el, createElement: el, body: { appendChild() {} }, querySelector: () => null };
  globalThis.Hooks = globalThis.Hooks || { callAll() {} };
  const inner = GB.innerSource({ files, key, playOpts: { tune, ...playOpts } });
  const ctx = { casterToken: { center: {} }, targetTokens: [{ center: {} }],
    params: { cfg: { dryOnly: true, trace: true, seed }, assets, outcomes: outcome ? [{ tokenUuid: "t0", ...outcome }] : null, strikes: strikes || [], variant } };
  const oni = { timeline: () => TL, fireDone() {}, hit() {}, sfx() {} };
  const fn = new Function("ctx", "canvas", "PIXI", "FAudioHelper", "loadTexture", "fromUuid", "wait", "foundry", "oni", "Sequence", '"use strict"; return (async () => {\n' + inner + "\n})();");
  const rep = await fn(ctx, { tokens: { placeables: [] }, app: null }, {}, null, null, null, null, {}, oni, undefined);
  return { ...rep, check: GB.checkMoveSource(files) };
}
module.exports = { dryRun, strikesFrom };
