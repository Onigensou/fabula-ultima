// Cutscene port · parity: does the game play the same rows, in the same order, for the same time, as the mockup did?
//   node tools/cutscene-port/parity.mjs install --port 9226          start recording rows on the GM page (before the event starts)
//   node tools/cutscene-port/parity.mjs read --port 9226 --out game-trace.json
//   node tools/cutscene-port/parity.mjs diff --mock mock-timeline.json --game game-trace.json --event <id>.event.json
// mock-timeline.json = RowsPlayer.timeline() from the mockup page, played with the same choices.
// Timed rows (Wait, Camera Pan / Screen Effect that wait, Set Token fades, Move Token) are compared by duration;
// lines, menus and GM pauses depend on the reader, so only their order is compared.
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate } from "./run-gm.mjs";

const [cmd, ...argv] = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = +opt("--port", 9226);

// executeRow is the single door every row goes through (event-eventRegistry.js); wrap it on the GM running the event
const INSTALL = `(() => {
  const R = window.oni?.EventSystem?.EventRegistry; if (!R?.executeRow) return "no EventRegistry.executeRow";
  globalThis.__csTrace = [];
  if (!R.__csWrapped) { const orig = R.executeRow.bind(R); R.__csWrapped = orig;
    R.executeRow = async (row, ctx) => { const e = { type: row?.type, t0: performance.now(), text: row?.type === "showText" ? String(row.text || "").slice(0, 40) : undefined };
      globalThis.__csTrace?.push(e); try { return await orig(row, ctx); } finally { e.t1 = performance.now(); } }; }
  return "recording";
})()`;
const READ = `(globalThis.__csTrace || []).map((e, i, a) => ({ type: e.type, t0: Math.round(e.t0 - a[0].t0), ms: e.t1 == null ? null : Math.round(e.t1 - e.t0), text: e.text }))`;

const TIMED = new Set(["wait", "cameraPan", "screenEffect", "setToken", "moveToken", "showEmote", "stopBGM"]);
function diff(mock, game, ev) {
  const skip = new Set(ev?.skipped || []);
  const m = mock.filter((e) => !skip.has(e.path));
  const out = [], n = Math.max(m.length, game.length); let orderBad = 0, timeBad = 0;
  for (let i = 0; i < n; i++) {
    const a = m[i], b = game[i];
    if (!a || !b || a.type !== b.type) { orderBad++; out.push({ i, verdict: "ORDER", mock: a ? `${a.path} ${a.type}` : "-", game: b ? b.type : "-" }); continue; }
    if (TIMED.has(a.type) && a.ms != null && b.ms != null) {
      const d = b.ms - a.ms, tol = Math.max(150, a.ms * 0.08);
      if (Math.abs(d) > tol) { timeBad++; out.push({ i, verdict: "TIME", mock: `${a.path} ${a.type} ${a.ms} ms`, game: `${b.ms} ms (${d > 0 ? "+" : ""}${d})` }); }
    }
  }
  return { compared: Math.min(m.length, game.length), mockRows: m.length, gameRows: game.length, orderMismatches: orderBad, timingMismatches: timeBad, rows: out };
}

if (cmd === "install") console.log(await evaluate(port, INSTALL));
else if (cmd === "read") { const t = await evaluate(port, READ); const f = opt("--out"); if (f) writeFileSync(f, JSON.stringify(t, null, 2)); console.log(`${t.length} rows recorded${f ? " → " + f : ""}`); }
else if (cmd === "diff") {
  const mock = JSON.parse(readFileSync(opt("--mock"), "utf8")), game = JSON.parse(readFileSync(opt("--game"), "utf8"));
  const ev = opt("--event") ? JSON.parse(readFileSync(opt("--event"), "utf8")) : null;
  const r = diff(mock, game, ev);
  console.log(`compared ${r.compared} rows (mockup ${r.mockRows}, game ${r.gameRows}): ${r.orderMismatches} out of order, ${r.timingMismatches} off in time`);
  for (const x of r.rows) console.log(`  #${x.i} ${x.verdict}  mockup: ${x.mock}  |  game: ${x.game}`);
  process.exitCode = r.orderMismatches || r.timingMismatches ? 1 : 0;
} else { console.error("usage: parity.mjs install|read|diff …"); process.exit(2); }
export { diff };
