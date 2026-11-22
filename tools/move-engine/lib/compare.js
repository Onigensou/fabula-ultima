"use strict";
// Trace comparison: the mockup's trace against the game's, event by event, from each side's first beat.
//   exact (dry run): times within 0.5 ms, sizes within 0.1 %, positions within 1 px
//   tolerant (playback): times within tol.ms (20), sizes within tol.size (5 %)
// Skipped on both sides: events only one host draws (hit cues, namecard, crit cut-in, numbers, beat ends) and the page's
// own reset before the first beat. "allowed" lists differences that are expected by design (named, never silent).
const SKIP = new Set(["hit", "namecard", "critCutin", "end", "num", "cutin", "unsupported"]);
const FIELDS = ["type", "key", "name", "vol", "rate", "px", "ms", "to", "peak", "inMs", "outMs", "color", "filter"];

const fromBeat = (tr) => tr.slice(Math.max(0, tr.findIndex((e) => e.type === "beat")));
// a Chain's result list: the game's plan also lists its Perfect strike (the page implies it from 8/8): compare without it
const resultKey = (e) => (e.list || []).filter((x) => !/\+perfect/.test(x)).join(" ");

function compareTraces(mock, game, { ms = 0.5, size = 0.001, px = 1 } = {}) {
  const m = fromBeat(mock).filter((e) => !SKIP.has(e.type)), g = fromBeat(game).filter((e) => !SKIP.has(e.type));
  const rows = []; let bad = 0; const allowed = [];
  const n = Math.max(m.length, g.length);
  for (let i = 0; i < n; i++) {
    const a = m[i], b = g[i], diffs = [];
    if (!a || !b) diffs.push("missing on the " + (a ? "game" : "mockup") + " side");
    else {
      if (Math.abs(a.at - b.at) > ms) diffs.push("time " + a.at + " vs " + b.at + " ms");
      for (const f of FIELDS) { const x = a[f], y = b[f]; if (x === y || (x == null && y == null)) continue;
        if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= Math.max(1e-3, Math.abs(x) * (f === "vol" ? 0 : size))) continue;
        diffs.push(f + " " + x + " vs " + y); }
      if (a.scale != null || b.scale != null) { if (Math.abs((a.scale || 0) - (b.scale || 0)) > Math.max(1e-3, Math.abs(a.scale || 0) * size)) diffs.push("scale " + a.scale + " vs " + b.scale); }
      if (a.type === "result" || b.type === "result") {
        if (resultKey(a) !== resultKey(b)) diffs.push("result " + (a.list || []).join(" ") + " vs " + (b.list || []).join(" "));
        else if (String(a.list) !== String(b.list)) allowed.push("result at " + a.at + " ms: the game's plan also lists its Perfect strike (" + (b.list || []).join(" ") + ")");
      }
      if (a.at2 && b.at2 && (Math.abs(a.at2.x - b.at2.x) > px || Math.abs(a.at2.y - b.at2.y) > px)) diffs.push("position " + JSON.stringify(a.at2) + " vs " + JSON.stringify(b.at2));
    }
    if (diffs.length) bad++;
    rows.push({ mockAt: a ? a.at : null, gameAt: b ? b.at : null, what: (a || b).type + " " + ((a || b).key || (a || b).name || ""), diffs });
  }
  return { ok: bad === 0, bad, total: n, rows, allowed };
}
module.exports = { compareTraces, SKIP };
