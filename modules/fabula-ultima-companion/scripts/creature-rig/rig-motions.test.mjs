// Node checks: creature-rig motions + animator (pure). Run: node rig-motions.test.mjs
import { RigAnimator, motionNames, defineMotion, idle, CHANNELS } from "./rig-motions.js";
import { motionTiming } from "./rig-api-core.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL", m); } else console.log("ok  ", m); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

ok(["roar", "flinch", "snarl"].every((n) => motionNames().includes(n)), "built-in motions registered");
// roar starts and ends at rest, peaks at the jaw snap with the full gape
{
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0;
  const h = A.play("roar", {}, 0); let peaked = false, done = null; h.peak.then((v) => peaked = v); h.done.then((r) => done = r);
  const p0 = A.sample(0.0001); ok(Math.abs(p0.jaw) < 0.1, "roar starts at rest");
  const p1 = A.sample(1.6); ok(p1.jaw > 28 && p1.lift > 12 && p1.wings < -12, `roar holds a full gape (jaw ${p1.jaw.toFixed(1)}, lift ${p1.lift.toFixed(1)})`);
  A.sample(3.4); A.sample(3.85);
  await Promise.resolve(); await Promise.resolve();
  ok(peaked === true, "peak resolved true");
  ok(done && done.ok === true && done.reason === "ended", "done resolved ended");
  const p2 = A.sample(3.9); ok(CHANNELS.every((c) => Math.abs(p2[c]) < 1e-6), "back at rest after the roar");
}
// hold lengthens the roar
{
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0; A.play("roar", { hold: 4 }, 0);
  ok(A.sample(4.5).jaw > 28, "hold:4 still roaring at 4.5 s");
}
// rest() cancels motions and pulls everything to zero; release() lets idle back
{
  const A = new RigAnimator(); const h = A.play("roar", {}, 0); let r = null; h.done.then((x) => r = x);
  A.sample(1.5); A.rest(100); for (let t = 1.5; t < 2.5; t += 0.05) A.sample(t);
  await Promise.resolve();
  ok(r && r.reason === "rest", "rest() cancels the running motion");
  ok(CHANNELS.every((c) => Math.abs(A.sample(2.5)[c]) < 1e-3), "rest() holds the painted pose");
  ok(A.resting, "resting flag");
  A.release(100); let p; for (let t = 2.5; t < 4; t += 0.05) p = A.sample(t);
  ok(Math.abs(p.breath) > 0.01 || Math.abs(p.tail) > 0.01, "release() brings the idle back");
}
// unknown motion resolves ok:false, never throws
{
  const A = new RigAnimator(); const h = A.play("nope"); const r = await h.done; ok(r.ok === false && r.reason === "unknown-motion", "unknown motion -> ok:false");
}
// a replaced motion resolves 'replaced'
{
  const A = new RigAnimator(); const h1 = A.play("snarl", {}, 0); let r1; h1.done.then((x) => r1 = x); A.play("snarl", { restart: true }, 0.1); await Promise.resolve();
  ok(r1 && r1.reason === "replaced", "restart replaces the running one");
}
// custom motion + speed
{
  defineMotion("test-nod", { duration: () => 1, sample: (t) => ({ lift: 10 * Math.sin(Math.PI * t) }) });
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0; A.play("test-nod", { speed: 2 }, 0);
  ok(A.sample(0.25).lift > 9, "speed 2 reaches the custom motion's middle at 0.25 s");
}
// review 2026-11-17: a replaced / cancelled motion must STOP contributing (it used to keep summing: jaw 30 -> 60)
{
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0;
  const h1 = A.play("roar", {}, 0); A.sample(1.0); const h2 = A.play("roar", {}, 1.0);
  const p = A.sample(2.6); ok(p.jaw < 36 && A.active.length === 1 && h2.joined && h2.done === h1.done, `second roar joins the first (jaw ${p.jaw.toFixed(1)}, active ${A.active.length})`);
  const A2 = new RigAnimator(); A2.idleOn = false; A2.idleK = 0; A2.play("roar", {}, 0); A2.sample(1.0); A2.play("roar", { restart: true }, 1.0);
  ok(A2.active.length === 1 && Math.abs(A2.sample(1.01).jaw) < 1, "restart:true starts over (one motion)");
  const B = new RigAnimator(); B.idleOn = false; B.idleK = 0; const h = B.play("roar", {}, 0); B.sample(1.5); h.cancel();
  const q = B.sample(1.6); ok(Math.abs(q.jaw) < 1e-6 && !B.busy, "cancel() stops the motion at once");
  const C = new RigAnimator(); C.idleOn = false; C.idleK = 0; C.play("roar", {}, 0); C.sample(1.5); C.rest(50); for (let t = 1.5; t < 2; t += 0.05) C.sample(t); C.release(50);
  let r; for (let t = 2; t < 2.6; t += 0.05) r = C.sample(t); ok(Math.abs(r.jaw) < 1e-6, "rest() then release() does not pop back into the roar");
}
// wingSpread (battle opening, 2026-11-19): the wings open slightly (not the roar's full flare), hold, settle to rest
{
  ok(motionNames().includes("wingSpread"), "wingSpread registered");
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0;
  const h = A.play("wingSpread", {}, 0); let peaked = false, done = null; h.peak.then((v) => peaked = v); h.done.then((r) => done = r);
  ok(Math.abs(A.sample(0.0001).wings) < 0.1, "wingSpread starts at rest");
  const mid = A.sample(0.55).wings, open = A.sample(1.1).wings, held = A.sample(1.8).wings;
  ok(mid < 0 && mid > open, `opens steadily (${mid.toFixed(1)} -> ${open.toFixed(1)})`);
  ok(open <= -13 && open >= -18, `opens SLIGHTLY: about -14, never past the roar's -18 (${open.toFixed(1)})`);
  ok(held < open && held > -18, `held open with a small drift, still under the roar's flare (${held.toFixed(1)})`);
  ok(Math.abs(A.sample(1.8).jaw) < 1e-9, "the jaw stays shut");
  A.sample(3.0); A.sample(3.49); await Promise.resolve(); await Promise.resolve();
  ok(peaked === true && done === null, "peak at full spread, still running before its end");
  A.sample(3.55); await Promise.resolve(); await Promise.resolve();
  ok(done && done.ok === true, "done after rise + hold + fall (3.5 s)");
  ok(CHANNELS.every((c) => Math.abs(A.sample(3.6)[c]) < 1e-6), "back at rest after the spread");
  const B = new RigAnimator(); B.idleOn = false; B.idleK = 0; B.play("wingSpread", { spread: -8, hold: 3 }, 0);
  ok(near(B.sample(1.1).wings, -8, 1e-6) && B.sample(3.5).wings < -7, "spread / hold options");
}
// clawSwipe + tailStrike (Nidhogg's Claw / Tail Stab, 2026-11-19): start and end at rest, the peak is the blow
{
  ok(motionNames().includes("clawSwipe") && motionNames().includes("tailStrike"), "clawSwipe + tailStrike registered");
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0;
  const h = A.play("clawSwipe", {}, 0); let peaked = false, done = null; h.peak.then((v) => peaked = v); h.done.then((r) => done = r);
  ok(CHANNELS.every((c) => Math.abs(A.sample(0.0001)[c]) < 0.1), "clawSwipe starts at rest");
  const rear = A.sample(0.38), slam = A.sample(0.55);
  ok(rear.lift > 8 && rear.wings < -10, `rears up first (lift ${rear.lift.toFixed(1)}, wings ${rear.wings.toFixed(1)})`);
  ok(slam.lift < -6 && slam.jaw > 14, `slams the head down, jaw open at the peak (lift ${slam.lift.toFixed(1)}, jaw ${slam.jaw.toFixed(1)})`);
  A.sample(1.2); await Promise.resolve(); await Promise.resolve();
  ok(peaked === true && done === null, "clawSwipe peak resolved, still settling at 1.2 s");
  A.sample(1.3); await Promise.resolve(); await Promise.resolve();
  ok(done && done.ok === true, "clawSwipe done at 1.25 s");
  ok(CHANNELS.every((c) => Math.abs(A.sample(1.35)[c]) < 1e-6), "back at rest after clawSwipe");

  const B = new RigAnimator(); B.idleOn = false; B.idleK = 0;
  const g = B.play("tailStrike", {}, 0); let pk = false, dn = null; g.peak.then((v) => pk = v); g.done.then((r) => dn = r);
  ok(CHANNELS.every((c) => Math.abs(B.sample(0.0001)[c]) < 0.1), "tailStrike starts at rest");
  const coil = B.sample(0.5).tail, hit = B.sample(0.62).tail, held = B.sample(0.8).tail;
  ok(coil < -15, `coils back first (tail ${coil.toFixed(1)})`);
  ok(hit > 30 && held > 30, `snaps forward and holds the reach (tail ${hit.toFixed(1)} -> ${held.toFixed(1)})`);
  B.sample(1.4); await Promise.resolve(); await Promise.resolve();
  ok(pk === true && dn === null, "tailStrike peak resolved, still settling at 1.4 s");
  B.sample(1.55); await Promise.resolve(); await Promise.resolve();
  ok(dn && dn.ok === true, "tailStrike done at 1.52 s");
  ok(CHANNELS.every((c) => Math.abs(B.sample(1.6)[c]) < 1e-6), "back at rest after tailStrike");
  const Cc = new RigAnimator(); Cc.idleOn = false; Cc.idleK = 0; Cc.play("tailStrike", { hold: 0.6, reach: 20 }, 0);
  const lateHold = Cc.sample(1.15).tail;
  ok(lateHold > 18 && lateHold < 22, `hold / reach options (tail ${lateHold.toFixed(1)} at 1.15 s with hold 0.6, reach 20)`);
}
// beamBreath (Nidhogg's Wailing Breath, 2026-11-19): the jaw opens slowly through the charge, snaps wide at the
// peak with the head thrown forward, holds, and settles to rest
{
  ok(motionNames().includes("beamBreath"), "beamBreath registered");
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0;
  const h = A.play("beamBreath", {}, 0); let peaked = false, done = null; h.peak.then((v) => peaked = v); h.done.then((r) => done = r);
  ok(CHANNELS.every((c) => Math.abs(A.sample(0.0001)[c]) < 0.1), "beamBreath starts at rest");
  const a = A.sample(0.6), b = A.sample(1.6);
  ok(a.jaw > 0 && b.jaw > a.jaw && b.jaw < 22 && b.lift > 7, `charge: jaw opens slowly, head reared (jaw ${a.jaw.toFixed(1)} -> ${b.jaw.toFixed(1)}, lift ${b.lift.toFixed(1)})`);
  const r = A.sample(2.2), late = A.sample(5.0);
  ok(r.jaw > 30 && r.lift < -5 && late.jaw > 30, `release: jaw wide, head thrust down, held (jaw ${r.jaw.toFixed(1)}, lift ${r.lift.toFixed(1)}, at 5 s ${late.jaw.toFixed(1)})`);
  A.sample(6.0); await Promise.resolve(); await Promise.resolve();
  ok(peaked === true && done === null, "beamBreath peak resolved, still settling at 6.0 s");
  A.sample(6.15); await Promise.resolve(); await Promise.resolve();
  ok(done && done.ok === true, "beamBreath done at 6.12 s");
  ok(CHANNELS.every((c) => Math.abs(A.sample(6.2)[c]) < 1e-6), "back at rest after beamBreath");
  const B = new RigAnimator(); B.idleOn = false; B.idleK = 0; B.play("beamBreath", { charge: 1.0, hold: 1.0 }, 0);
  ok(B.sample(1.5).jaw > 30 && Math.abs(B.sample(3.1).jaw) < 1e-6, "charge / hold options");
  const S = new RigAnimator(); S.idleOn = false; S.idleK = 0; S.play("beamBreath", { slam: 3.0 }, 0);
  const s0 = S.sample(2.9), s1 = S.sample(3.07), s2 = S.sample(3.9);
  ok(s1.lift < s0.lift - 3 && s1.jaw > s0.jaw + 3 && Math.abs(s2.lift - s0.lift) < 1.8, `slam: a second thrust that settles (lift ${s0.lift.toFixed(1)} -> ${s1.lift.toFixed(1)} -> ${s2.lift.toFixed(1)})`);
}
// inhale (Nidhogg's Soul Devour, 2026-11-20): jaw opens wide and holds, head pulls back, SNAPS shut at `swallow`, settles
{
  ok(motionNames().includes("inhale"), "inhale registered");
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0;
  const h = A.play("inhale", {}, 0); let peaked = false, done = null; h.peak.then((v) => peaked = v); h.done.then((r) => done = r);
  ok(CHANNELS.every((c) => Math.abs(A.sample(0.0001)[c]) < 0.1), "inhale starts at rest");
  const mid = A.sample(1.2), pre = A.sample(2.45);
  ok(mid.jaw > 8 && mid.jaw < pre.jaw && mid.lift > 3, `jaw opens progressively, head pulled back (jaw ${mid.jaw.toFixed(1)} -> ${pre.jaw.toFixed(1)}, lift ${mid.lift.toFixed(1)})`);
  ok(pre.jaw >= 28 && pre.lift > 8 && pre.wings < -4, `held wide just before the swallow (jaw ${pre.jaw.toFixed(1)}, lift ${pre.lift.toFixed(1)})`);
  const sn = A.sample(2.62), post = A.sample(2.7);
  ok(sn.jaw < 3 && sn.lift < -4, `at swallow+0.2 the jaw is shut, head thrust forward (jaw ${post.jaw.toFixed(1)}, lift ${sn.lift.toFixed(1)})`);
  ok(post.jaw < 3, "jaw < 3 at swallow+0.2");
  A.sample(3.4); await Promise.resolve(); await Promise.resolve();
  ok(peaked === true && done === null, "inhale peak resolved, still settling at 3.4 s");
  A.sample(3.55); await Promise.resolve(); await Promise.resolve();
  ok(done && done.ok === true, "inhale done at 3.52 s");
  ok(CHANNELS.every((c) => Math.abs(A.sample(3.6)[c]) < 1e-6), "back at rest after inhale");
  const tm = motionTiming("inhale");
  ok(tm && tm.peakMs === 2500 && tm.durationMs === 3520, `timing("inhale") peakMs 2500 / durationMs 3520 (${JSON.stringify(tm)})`);
  ok(motionTiming("inhale", { swallow: 1.5 })?.peakMs === 1500, "swallow option moves the peak");
  const B = new RigAnimator(); B.idleOn = false; B.idleK = 0; B.play("inhale", { swallow: 1.5, jaw: 20 }, 0);
  const b1 = B.sample(1.45); ok(b1.jaw >= 18 && B.sample(1.72).jaw < 3, "jaw option and swallow option");
  // the other motions are untouched: pinned samples (values taken before inhale was added)
  const pin = (name, t, ch, want) => { const P = new RigAnimator(); P.idleOn = false; P.idleK = 0; P.play(name, {}, 0); ok(near(P.sample(t)[ch], want, 1e-3), `${name} @${t} ${ch} unchanged (${want})`); };
  pin("roar", 1.6, "jaw", 31.0305);
  pin("roar", 0.5, "breath", 0.8203);
  pin("snarl", 0.6, "jaw", 11.8756);
  pin("flinch", 0.08, "lift", -7);
  pin("beamBreath", 1, "jaw", 6.9204);
  pin("beamBreath", 2.2, "lift", -6.724);
  pin("clawSwipe", 0.55, "lift", -10);
  pin("tailStrike", 0.62, "tail", 33.51);
  pin("wingSpread", 1.1, "wings", -14);
}
// hurl (Nidhogg's Soul Strike, 2026-11-28): rear back with the jaw part-open (the ball in the mouth), hold, SNAP
// forward and down with the jaw wide at the peak, follow through, settle to rest
{
  ok(motionNames().includes("hurl"), "hurl registered");
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0;
  const h = A.play("hurl", {}, 0); let peaked = false, done = null; h.peak.then((v) => peaked = v); h.done.then((r) => done = r);
  ok(CHANNELS.every((c) => Math.abs(A.sample(0.0001)[c]) < 0.1), "hurl starts at rest");
  const rear = A.sample(0.6), held = A.sample(1.12);
  ok(rear.lift > 8 && rear.jaw > 9 && rear.jaw < 18, `rears back with the jaw part-open (lift ${rear.lift.toFixed(1)}, jaw ${rear.jaw.toFixed(1)})`);
  ok(held.lift > rear.lift && held.jaw > 13 && held.jaw < 18, `holds it, winding up before the release (lift ${held.lift.toFixed(1)}, jaw ${held.jaw.toFixed(1)})`);
  const snap = A.sample(1.27), follow = A.sample(1.4);
  ok(snap.lift < -7 && snap.jaw > 26, `snaps forward and down, jaw wide (lift ${snap.lift.toFixed(1)}, jaw ${snap.jaw.toFixed(1)})`);
  ok(follow.lift < -6 && follow.jaw > 22, `follows through (lift ${follow.lift.toFixed(1)}, jaw ${follow.jaw.toFixed(1)})`);
  A.sample(1.85); await Promise.resolve(); await Promise.resolve();
  ok(peaked === true && done === null, "hurl peak resolved, still settling at 1.85 s");
  A.sample(1.95); await Promise.resolve(); await Promise.resolve();
  ok(done && done.ok === true, "hurl done at 1.92 s");
  ok(CHANNELS.every((c) => Math.abs(A.sample(2.0)[c]) < 1e-6), "back at rest after hurl");
  const tm = motionTiming("hurl");
  ok(tm && tm.peakMs === 1150 && tm.durationMs === 1920, `timing("hurl") peakMs 1150 / durationMs 1920 (${JSON.stringify(tm)})`);
  ok(motionTiming("hurl", { peak: 0.9 })?.peakMs === 900, "peak option moves the peak");
  // no pops: at 240 Hz no channel jumps more than 2.5 deg in one step, except across the snap itself
  const C = new RigAnimator(); C.idleOn = false; C.idleK = 0; C.play("hurl", {}, 0);
  let prev = C.sample(0), worst = 0, worstAt = 0;
  for (let t = 1 / 240; t < 1.95; t += 1 / 240) { const p = C.sample(t); if (t < 1.14 || t > 1.3) for (const c of CHANNELS) { const d = Math.abs(p[c] - prev[c]); if (d > worst) { worst = d; worstAt = t; } } prev = p; }
  ok(worst < 2.5, `hurl is continuous outside the snap (worst step ${worst.toFixed(2)} deg at ${worstAt.toFixed(3)} s)`);
  const B = new RigAnimator(); B.idleOn = false; B.idleK = 0; B.play("hurl", { jaw: 20, thrust: -4, rear: 6 }, 0);
  const b1 = B.sample(1.27); ok(b1.jaw > 18 && b1.jaw < 23 && b1.lift < -3 && b1.lift > -5.5 && B.sample(0.6).lift < 7, `jaw / thrust / rear options (jaw ${b1.jaw.toFixed(1)}, lift ${b1.lift.toFixed(1)})`);
}
ok(near(idle(0, 0).jaw, 0), "idle weight 0 is still");
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
