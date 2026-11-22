"use strict";
// Game runtime DRY RUN in Node, on a stub board shaped exactly like the mockup's stage, compared with the mockup's trace.
//   node test/mockup-clock.js --gpu --json out/clock.json   (the mockup side: traces + stage geometry)
//   node test/game-dry.js [moveKey] [--tune k=v ...]
// Same move files the page runs (moves/sonic-katar + the page's own part), same shared parts; the game host instead of the
// mockup engine. Expect: identical event times / keys / volumes / scales; positions equal (same geometry).
// --result hit|miss|crit[:total]  hand the move a GAME outcome (BD's payload.outcomes) instead of its page sliders
const fs = require("fs");
const path = require("path");
const GB = require("../build/game-build.js");
const LF = require("./lib-files.js");

const args = process.argv.slice(2);
const KEY = args[0] && !args[0].startsWith("--") ? args[0] : "gb_sword";
const TUNE = { gb_sword: { roll: 1 }, gb_gun: { roll: 1 }, gb_tf: { dir: 0 }, sonicblow: { result: 1 }, sk_attack: { result: 1 } }[KEY] || {};
args.forEach((a, i) => { if (a === "--tune") { const [k, v] = args[i + 1].split("="); TUNE[k] = Number(v); } });
const RES = (() => { const i = args.indexOf("--result"); if (i < 0) return null; const [kind, tot] = args[i + 1].split(":");
  return { tokenUuid: "t0", hit: kind !== "miss", crit: kind === "crit", total: tot == null ? null : Number(tot), fumble: false }; })();
const VARIANT = (() => { const i = args.indexOf("--variant"); return i < 0 ? null : args[i + 1]; })();
// --strikes hit,miss,crit,…[,perfect]: a Chain plan in BD's shape ({ index, outcomes: [{ tokenUuid, kind, amount, isCrit }], perfect? })
const STRIKES = (() => { const i = args.indexOf("--strikes"); if (i < 0) return null;
  return args[i + 1].split(",").map((k, n) => k === "perfect" ? { index: n + 1, roll: null, perfect: true, mult: 1.5, outcomes: [{ tokenUuid: "t0", kind: "hit", amount: 29, isCrit: true }] }
    : { index: n + 1, roll: { total: 10 }, outcomes: [{ tokenUuid: "t0", kind: k === "crit" ? "hit" : k, amount: k === "miss" ? 0 : 4, isCrit: k === "crit" }] }); })();
const MOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "out", "clock.json"), "utf8"));
const files = LF.filesFor(KEY);

const chk = GB.checkMoveSource(files);
const inner = GB.innerSource({ files, key: KEY, playOpts: { tune: TUNE, variantTune: { gun: { dir: 0 }, sword: { dir: 1 } } } });

// ── stub board: mockup px = board px (KP 1, origin 0), the mockup's two battlers, the mockup's perspective
const P = MOCK.preset;
const tokenScaleAt = (y) => { const den = P.refRow - P.horizon, num = Math.max(y - P.horizon, den * .05); return Math.min(P.maxScale, Math.max(P.minScale, Math.pow(num / den, P.strength))); };
const tokOf = (a) => { const h = a.hb * a.s, w = a.wb * a.s; return { x: a.x, y: a.y - h / 2, w, h, foot: 1, flip: 1, token: {} }; };
const TOK = { k: tokOf(MOCK.actors.keren), t0: tokOf(MOCK.actors.orc) };
const TL = { STAGE: { x: 0, y: 0, w: 1682, h: 788 }, TOK, POSE: {}, load: async () => {}, feet: (T) => ({ x: T.x, y: T.y - T.h / 2 + T.h * T.foot }),
  art: () => null, depthS: (x, y) => tokenScaleAt(y), depthRatio: (a, b) => tokenScaleAt(b.y) / tokenScaleAt(a.y),
  mk: (T) => ({ clip(key, t0, o) { T.push({ t0, t1: t0 + 1000, clip: {}, o }); return {}; }, flash() {}, shake() {}, hold(t0, t1, fn) { T.push({ t0, t1, fn }); } }) };
const el = () => ({ setAttribute() {}, style: {}, getContext: () => null, appendChild() {}, innerHTML: "" });
globalThis.document = { getElementById: () => null, createElementNS: el, createElement: el, body: { appendChild() {} }, querySelector: () => null };
globalThis.Hooks = { callAll() {} };
const ctx = { casterToken: { center: {} }, targetTokens: [{ center: {} }], params: { cfg: { dryOnly: true, trace: true, seed: 2611 }, assets: { clips: {}, sfx: {} }, outcomes: RES ? [RES] : null, strikes: STRIKES || [], variant: VARIANT } };
// every clip key the move names, so the runtime records them (sizes are irrelevant to the trace)
const meta = JSON.parse(fs.readFileSync("E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation/Sonic Katar/src/assets/meta.json", "utf8"));
const A = GB.assetsFromMeta(meta, {}); ctx.params.assets = { clips: A.clips, sfx: A.sfx };
const oni = { timeline: () => TL, fireDone() {}, hit() {}, sfx() {} };
const canvas = { tokens: { placeables: [] }, app: null };

(async () => {
  const fn = new Function("ctx", "canvas", "PIXI", "FAudioHelper", "loadTexture", "fromUuid", "wait", "foundry", "oni", "Sequence", '"use strict"; return (async () => {\n' + inner + "\n})();");
  const rep = await fn(ctx, canvas, {}, null, null, null, null, {}, oni, undefined);
  const game = rep.trace, mock = MOCK.runs[KEY] && MOCK.runs[KEY][0];
  console.log("move " + KEY + " · build check: " + (chk.errors.length ? chk.errors.join("; ") : "ok") + (chk.warnings.length ? " · warnings: " + chk.warnings.join("; ") : ""));
  console.log("game dry run: " + rep.dryMs + " ms real, " + game.length + " events, move ends at " + rep.end + " ms, gate " + rep.gate + " ms, warnings: " + (rep.warnings.join("; ") || "none"));
  // a game outcome / variant run: show what the move chose (no mockup trace to compare against)
  if (RES || VARIANT || STRIKES) { console.log("gate " + rep.gate + " (markGate " + rep.markGate + ", first hit " + rep.firstHit + ") · result " + JSON.stringify(rep.result) + " · variant " + rep.variant);
    for (const e of game) if (["clip", "sfx", "hit", "gate", "beat"].includes(e.type)) console.log("  GAME " + String(e.at).padStart(6) + " " + e.type + " " + (e.key || e.name || e.kind || ""));
    process.exit(0); }
  if (!mock) { console.log("(no mockup trace for " + KEY + " in out/clock.json)"); process.exit(0); }
  // compare event by event (the mockup does not trace hit cues / namecard / beat ends: skip those types on both sides)
  const SKIP = new Set(["hit", "namecard", "critCutin", "end", "num"]);
  // events before the first beat are the page resetting (rumble(false), speed lines off), not the move
  const fromBeat = (tr) => tr.slice(Math.max(0, tr.findIndex((e) => e.type === "beat")));
  const g = fromBeat(game).filter((e) => !SKIP.has(e.type)), m = fromBeat(mock).filter((e) => !SKIP.has(e.type));
  const fields = ["type", "key", "name", "vol", "rate", "scale", "px", "ms", "to", "peak", "inMs", "outMs"];
  let bad = 0; const n = Math.max(g.length, m.length);
  for (let i = 0; i < n; i++) { const a = m[i], b = g[i]; const diffs = [];
    if (!a || !b) diffs.push("missing on " + (a ? "game" : "mockup") + " side");
    else { if (Math.abs(a.at - b.at) > 0.5) diffs.push("at " + a.at + " vs " + b.at);
      for (const f of fields) if (a[f] !== b[f] && !(typeof a[f] === "number" && Math.abs(a[f] - b[f]) < 1e-3)) diffs.push(f + " " + a[f] + " vs " + b[f]);
      if ((a.list || b.list) && String(a.list) !== String(b.list)) diffs.push("result " + a.list + " vs " + b.list);
      if (a.at2 && b.at2 && (Math.abs(a.at2.x - b.at2.x) > 1 || Math.abs(a.at2.y - b.at2.y) > 1)) diffs.push("pos " + JSON.stringify(a.at2) + " vs " + JSON.stringify(b.at2)); }
    if (diffs.length) bad++;
    console.log((diffs.length ? "✗ " : "  ") + String(a ? a.at : "").padStart(7) + " " + String(b ? b.at : "").padStart(7) + "  " + ((a || b).type + " " + ((a || b).key || (a || b).name || "")).padEnd(34) + (diffs.length ? diffs.join(" · ") : ""));
  }
  console.log("\n" + (bad ? bad + " of " + n + " events differ" : "all " + n + " events match (time, key, volume, scale, position)"));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
