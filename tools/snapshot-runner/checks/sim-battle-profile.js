// Where does a sim battle's wall time go? Wraps checks/sim-battle.js (fetched from the runner
// server, so the battle is the very one the referee compared) with in-page meters:
//   - time per Battle Director FSM state (polled every 50 ms)
//   - canvas render: ms inside renderer.render, frames, the ticker rate
//   - CSB data prep: ms inside Actor#prepareData (CSB recomputes formulas here)
//   - long tasks (> 50 ms main-thread blocks) and event-loop lag (a 100 ms timer's lateness)
// Optional globalThis.__PROF_OPTS: { lowRes: true } drops the renderer to 0.25 resolution
// (the known SwiftShader fix), { skipAnim: true } skips every director presentation.
const P = globalThis.__PROF_OPTS ?? {};
const now = () => performance.now();
const meters = { renderMs: 0, frames: 0, prepMs: 0, preps: 0, longTasks: 0, longMs: 0, lagMs: 0, lagSamples: 0, lagMax: 0 };

if (P.lowRes && canvas?.app?.renderer) { canvas.app.renderer.resolution = 0.25; canvas.app.renderer.resize(innerWidth, innerHeight); }

const renderer = canvas.app.renderer;
const realRender = renderer.render;
renderer.render = function (...a) { const t = now(); try { return realRender.apply(this, a); } finally { meters.renderMs += now() - t; meters.frames++; } };
const AP = CONFIG.Actor.documentClass.prototype;
const realPrep = AP.prepareData;
AP.prepareData = function (...a) { const t = now(); try { return realPrep.apply(this, a); } finally { meters.prepMs += now() - t; meters.preps++; } };
const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { meters.longTasks++; meters.longMs += e.duration; } });
try { po.observe({ entryTypes: ["longtask"] }); } catch {}
let lagLast = now();
const lagTimer = setInterval(() => { const t = now(); const lag = Math.max(0, t - lagLast - 100); meters.lagMs += lag; meters.lagSamples++; meters.lagMax = Math.max(meters.lagMax, lag); lagLast = t; }, 100);

const states = {}; let curState = null, curSince = now();
const bd = FUCompanion.api.experimental.battleDirector;
const stTimer = setInterval(() => {
  const st = bd?.status?.()?.running ? bd.status().state : "(not running)";
  if (st !== curState) { if (curState) states[curState] = (states[curState] ?? 0) + (now() - curSince); curState = st; curSince = now(); }
  if (P.skipAnim && bd?.status?.()?.running) { try { bd.skipAnimation?.(); } catch {} }
}, 50);

const src = await (await fetch("/tools/snapshot-runner/checks/sim-battle.js", { cache: "no-store" }).catch(() => null))?.text?.();
let r;
const t0 = now();
try {
  if (!src) throw new Error("could not fetch checks/sim-battle.js from the server");
  r = await (new Function(`return (async () => { ${src}\n})()`))();
} finally {
  if (curState) states[curState] = (states[curState] ?? 0) + (now() - curSince);
  clearInterval(stTimer); clearInterval(lagTimer); po.disconnect();
  renderer.render = realRender; AP.prepareData = realPrep;
}
const wall = now() - t0;
const round = (x) => Math.round(x);
return {
  opts: P, wallMs: round(wall), outcome: r?.outcome, rounds: r?.rounds, actions: r?.counts?.act, err: r?.err ?? r?.error ?? null,
  canvasMode: globalThis.__testCanvasMode ?? null, events: r?.events ?? [], partyHpRemaining: r?.partyHpRemaining ?? null,
  states: Object.fromEntries(Object.entries(states).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v)])),
  render: { ms: round(meters.renderMs), frames: meters.frames, msPerFrame: meters.frames ? +(meters.renderMs / meters.frames).toFixed(1) : null, fps: +(meters.frames / (wall / 1000)).toFixed(1), shareOfWall: +(meters.renderMs / wall).toFixed(3) },
  csbPrepare: { ms: round(meters.prepMs), calls: meters.preps, msPerCall: meters.preps ? +(meters.prepMs / meters.preps).toFixed(1) : null, shareOfWall: +(meters.prepMs / wall).toFixed(3) },
  longTasks: { n: meters.longTasks, ms: round(meters.longMs), shareOfWall: +(meters.longMs / wall).toFixed(3) },
  eventLoopLag: { avgMs: meters.lagSamples ? +(meters.lagMs / meters.lagSamples).toFixed(1) : null, maxMs: round(meters.lagMax) },
};
