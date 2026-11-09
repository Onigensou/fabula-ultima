// Bare-Node checks for the Soul Tithe HP-bar burn (no Foundry, no DOM).
//   node scripts/conflict-event/soul-fx/soul-hp-burn.test.mjs
// The model: which change each sequence of HUD reads becomes (Tithe, Calling, a refund
// in either write order, the end of the fight, a first read after an F5), and where
// each lands. The flame options the bar relies on: cover, a live wind, the trail.
// client-options.js registers its settings on Foundry's init at import: give it a stand-in
globalThis.Hooks ??= { once() {}, on() {}, callAll() {} };
const { SoulBurnModel, BURN, move } = await import("./soul-hp-burn.js");
import { createFrame, clearFrame, painterFor } from "../../battle-director/pixel-entrance/pixelfx/core/index.js";
import { makeSil, makeSoulFlame, makeFlameMotion } from "./soul-fx-lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.error(`FAIL ${name} ${extra}`); } };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

/** Run the model to time `to` in 60 Hz steps; the renderer's only duty is to disperse on breakNow. */
function run(m, from, to, log = null) {
  for (let t = from; t <= to + 1e-9; t += 1 / 60) {
    m.step(t);
    if (log) log.push({ t, split: m.split, k: m.k, breakNow: m.breakNow });
    if (m.breakNow) { if (log) log.at(-1).broke = true; m.dispersed(); }
  }
  return to;
}

// ── a first read (page load, F5) shows the bar as it is ──
{
  const m = new SoulBurnModel();
  ok("init returns init", m.sync({ v: 90, m: 90, stolen: 30 }, 0, true) === "init");
  ok("init split", near(m.split, 0.75), m.split);
  ok("init lit", m.k === 1 && !m.out);
  ok("init no animation", !m.busy());
  const z = new SoulBurnModel();
  z.sync({ v: 90, m: 120, stolen: 0 }, 0, true);
  ok("init nothing taken: no fire", z.k === 0 && z.split === 1);
}

// ── Tithe, then Calling ──
{
  const m = new SoulBurnModel();
  m.sync({ v: 90, m: 120, stolen: 0 }, 0, true);
  ok("tithe", m.sync({ v: 90, m: 90, stolen: 30 }, 1, false) === "tithe");
  const log = [];
  run(m, 1, 1.7, log);
  ok("tithe lands", near(m.split, 0.75), m.split);
  ok("tithe lit", near(m.k, 1));
  const at = log.find((r) => r.t >= 1.1 - 1e-9);   // 0.1 s into 0.5 s
  ok("tithe ease out: over half the way at a fifth of the time", (1 - at.split) / 0.25 > 0.5, at.split);
  ok("calling", m.sync({ v: 60, m: 60, stolen: 60 }, 2, false) === "calling");
  ok("calling keeps the fire lit", m.k === 1);
  run(m, 2, 3.1);
  ok("calling lands", near(m.split, 0.5), m.split);
  ok("calling no anims left", !m.busy());
}

// ── refund, Max first (the player ends in Crisis): the Max waits for its HP ──
{
  const m = new SoulBurnModel();
  m.sync({ v: 60, m: 60, stolen: 60 }, 0, true);
  ok("refund max-first waits", m.sync({ v: 60, m: 120, stolen: 0 }, 5, false) === "pending");
  m.step(5.05);
  ok("refund max-first still waiting at 50 ms", m.pending != null && m.mode !== "end");
  ok("refund max-first starts on the HP", m.sync({ v: 120, m: 120, stolen: 0 }, 5.08, false) === "refund");
  const log = [];
  run(m, 5.08, 5.9, log);
  const broke = log.find((r) => r.broke);
  ok("refund disperses", !!broke);
  ok("refund disperses at speed, not at the end", broke && broke.t - 5.08 < BURN.REST_DUR * 0.6 && broke.split < 1, broke && `${(broke.t - 5.08).toFixed(3)} s, split ${broke.split}`);
  ok("refund disperses after 90% of the way", broke && (broke.split - 0.5) / 0.5 >= BURN.BREAK_AT - 1e-6);
  ok("refund lands full", near(m.split, 1) && m.k === 0 && m.out);
  const flashes = m.events.filter((e) => e.kind === "flash");
  ok("refund flashes the regrown fill", flashes.length > 0 && flashes.every((e) => e.to <= 1 + 1e-9 && e.to >= e.from - 1e-9));
}

// ── refund, HP first (the player ends clear of Crisis) ──
{
  const m = new SoulBurnModel();
  m.sync({ v: 60, m: 60, stolen: 60 }, 0, true);
  m.sync({ v: 120, m: 60, stolen: 60 }, 3, false);   // the HP lands first, over the Max for a moment
  ok("refund hp-first starts at once", m.sync({ v: 120, m: 120, stolen: 0 }, 3.03, false) === "refund");
  run(m, 3.03, 3.8);
  ok("refund hp-first lands full", near(m.split, 1) && m.out);
}

// ── the end of the fight: Max back, HP stays → the fire goes out and the char cools ──
{
  const m = new SoulBurnModel();
  m.sync({ v: 60, m: 60, stolen: 60 }, 0, true);
  m.sync({ v: 60, m: 120, stolen: 0 }, 2, false);
  const log = [];
  run(m, 2, 2 + BURN.REFUND_WAIT + 0.02, log);
  ok("end after the wait", m.mode === "end", m.mode);
  ok("end keeps the split while it cools", m.split < 0.6, m.split);
  ok("end bursts sparks", m.events.some((e) => e.kind === "burst"));
  run(m, 2.3, 3.6);
  ok("end: fire out, char gone", m.k === 0 && m.cool === 0 && near(m.split, 1) && m.out);
  ok("end never dispersed", !log.some((r) => r.broke));
  // a refund while the owner is KO'd pays Max only: the same as an end
  const ko = new SoulBurnModel();
  ko.sync({ v: 0, m: 40, stolen: 80 }, 0, true);
  ko.sync({ v: 0, m: 120, stolen: 0 }, 1, false);
  run(ko, 1, 1.4);
  ok("KO'd owner's refund cools, no disperse", ko.mode === "end");
}

// ── found in the real game (2026-11-09) ──
{
  // the AE lands before its Max is re-derived: the first read has the old Max, the next the new one
  const m = new SoulBurnModel();
  m.sync({ v: 90, m: 120, stolen: 0 }, 0, true);
  ok("tithe on a stale Max", m.sync({ v: 90, m: 120, stolen: 30 }, 1, false) === "tithe");
  m.step(1.05);
  ok("the re-derived Max retargets the running move", m.sync({ v: 90, m: 90, stolen: 30 }, 1.06, false) === null);
  run(m, 1.06, 1.8);
  ok("the move lands on the re-derived Max", near(m.split, 0.75), m.split);
  // a bar made by a change: primed as whole-and-untaken, so it plays the Tithe
  const b = new SoulBurnModel(), s = { v: 90, m: 90, stolen: 30 };
  b.sync({ v: s.v, m: s.m + s.stolen, stolen: 0 }, 2, true);
  ok("a bar made by the Tithe plays it", b.sync(s, 2, false) === "tithe");
  // the scene end's sweep, then a touch with the same numbers: still an end, not a snap
  const e = new SoulBurnModel();
  e.sync({ v: 46, m: 46, stolen: 20 }, 0, true);
  e.sync({ v: 46, m: 66, stolen: 0 }, 1, false);
  ok("a touch while waiting is not a snap", e.sync({ v: 46, m: 66, stolen: 0 }, 1.02, false) === null && e.pending != null);
  run(e, 1.02, 2.4);
  ok("...and it ends", e.mode === "end" && near(e.split, 1) && e.k === 0);
}

// ── nothing changed: no new work ──
{
  const m = new SoulBurnModel();
  m.sync({ v: 90, m: 90, stolen: 30 }, 0, true);
  ok("same numbers again: nothing", m.sync({ v: 90, m: 90, stolen: 30 }, 1, false) === null && !m.busy());
  ok("move is an ease out", move(0) === 0 && move(1) === 1 && move(0.25) > 0.6);
}

// ── the flame options the bar uses ──
{
  const H = 6, W = 4;
  const mk = (o) => makeSoulFlame(makeSil({ x: 0, y: 0, w: W, h: H, mask: new Uint8Array(W * H).fill(1) }), { gpuGlow: true, smoke: false, wind: 0.5, k: 1.6, lift: 14, seed: 4, ...o });
  const frame = createFrame(160, 120, -78, -100);
  const draw = (fl, t, back = true) => { const p = painterFor(clearFrame(frame)); if (back) fl.drawBack(p, t, () => 0, 1, 0); fl.draw(p, t, () => 0, 1, 0, 1); return frame.color.slice(); };
  const insideSil = (buf) => { let n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (buf[(y + 100) * 160 + x + 78]) n++; return n; };
  // without cover the flame's body skips the silhouette (a creature's body hides it; only stray
  // puffs cross it); with cover the bar itself is a bed of fire
  let withC = 0, without = 0;
  for (let t = 0; t < 2; t += 0.1) { withC += insideSil(draw(mk({ cover: true }), t, false)); without += insideSil(draw(mk({}), t, false)); }
  ok("cover: the fire burns ON the bar", withC > without * 3 && withC > 200, `${withC} vs ${without}`);
  // a steady wind fed every frame draws exactly what a fixed wind draws
  const a = mk({ cover: true }), b = mk({ cover: true });
  let same = true;
  for (let t = 0; t < 1; t += 1 / 30) { b.setWind(0.5, t); const x = draw(a, t), y = draw(b, t); for (let i = 0; i < x.length && same; i++) if (x[i] !== y[i]) same = false; }
  ok("steady live wind = fixed wind", same);
  // a moving fire leaves its particles behind: moving left, the trail falls to the right
  const mo = makeFlameMotion(), mv = mk({ cover: true, motion: mo, trailPad: 74 }), still = mk({ cover: true });
  let right = 0, rightStill = 0;
  for (let t = 0; t < 0.6; t += 1 / 60) {
    mv.setOrigin(-200 * t, t);   // 200 px/s to the left
    const x = draw(mv, t), y = draw(still, t);
    if (t > 0.3) for (let j = 0; j < 120; j++) for (let i = 78 + W + 6; i < 160; i++) { if (x[j * 160 + i]) right++; if (y[j * 160 + i]) rightStill++; }
  }
  ok("a moving fire trails behind it", right > rightStill * 1.5, `${right} vs ${rightStill}`);
  // two flames sharing one motion: the second picks up the first's history (no jump on a hand-over)
  const shared = makeFlameMotion(), f1 = mk({ cover: true, motion: shared });
  for (let t = 0; t < 0.3; t += 1 / 60) { f1.setWind(-0.4, t); f1.setOrigin(10 * t, t); }
  const f2 = makeSoulFlame(makeSil({ x: 0, y: 0, w: 2, h: H, mask: new Uint8Array(2 * H).fill(1) }), { gpuGlow: true, smoke: false, cover: true, wind: 0.5, k: 1.6, lift: 14, seed: 4, motion: shared });
  ok("shared motion carries over", shared.wind.size > 10 && shared.origin.size > 10 && Number.isFinite(draw(f2, 0.31)[0]));
}

console.log(`soul-hp-burn: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
