// Node checks: Nidhogg's battle opening clock + camera plan (pure). Run: node nidhogg-awakening.test.mjs
import { AWAKENING, SHOTS, WING_SHOT, awakeningSfx, awakeningPlan, awakeningBeats, coverAt, cameraAt, pointOnRect, viewFor, blendView, flippedShot, screenAt, solvePlaced } from "./nidhogg-awakening.js";
import { resolvePreset, buildCamera, buildProjector, rigCamera } from "../battle-director/battle-stage-3d-rules.js";
import { pickBattleOpening, battleOpeningFromFlags, registerBattleOpening, unregisterBattleOpening, battleOpeningStyle } from "../battle-director/battle-opening-styles.js";
import { RigAnimator } from "../creature-rig/rig-motions.js";
import { cueStart } from "../shared/sfx-cues.js";
import { returnSfx, returnPlan } from "./nidhogg-return.js";

let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL", m); } else console.log("ok  ", m); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const P = awakeningPlan();
// ── the clock ──
ok(near(P.claw0, 4.0), "the claw shot comes 4 s after the eyes (the user: '4 seconds after')");
ok(P.claw0 < P.wing0 && P.wing0 < P.black0 && P.black0 < P.smoke0 && P.smoke0 < P.roar0 && P.roar0 < P.pierce && P.pierce < P.roarEnd && P.roarEnd < P.back0 && P.back0 < P.arrive, "beats in order");
ok(near(P.back0 - P.roarEnd, 1.0), "the camera leaves 1 s after the roar ends (the user: '1 second after its roar ends')");
ok(near(P.pierce - P.roar0, AWAKENING.roarPeak), "the rig's jaw snap lands on the pierce (the smoke's blast)");
ok(near(P.roarLen, 0.8 + 0.3 + AWAKENING.roarHold + 1.1), "roar length = the rig roar's (rig-motions.js) at hold 1.6");
{ // the rig's own roar timing agrees with the plan's numbers
  const A = new RigAnimator(); A.idleOn = false; A.idleK = 0; const h = A.play("roar", { hold: AWAKENING.roarHold }, 0);
  let done = null; h.done.then((r) => { done = r; });
  A.sample(P.roarLen - 0.02); await Promise.resolve(); await Promise.resolve(); const early = done;
  A.sample(P.roarLen + 0.02); await Promise.resolve(); await Promise.resolve();
  ok(early === null && done?.ok === true, `the rig's roar ends at the plan's roarEnd (${P.roarLen.toFixed(2)} s after roar0)`);
}
ok(P.spreadAt > P.wing0 && P.spreadAt < P.black0, "the wing spreads inside the wing shot");
ok(near(P.total, P.fadeEnd) && P.fadeEnd > P.arrive, "total = until the party's fade-in is over");
ok(awakeningBeats(P).length === 10 && awakeningBeats(P).every(([t], i, a) => i === 0 || t >= a[i - 1][0]), "beat list in order");
ok(near(awakeningPlan({ afterEyes: 2 }).claw0, 2), "lengths can be overridden");

// ── the sound ──
{
  const S = awakeningSfx(P), st = (c) => cueStart(c), end = (c, len) => st(c) + len;
  const LEN = { "Soundboard/Growl.ogg": 4.4, "Soundboard/Wind5.ogg": 1.29, "Soundboard/SE_SWINGF.wav": 0.53, "Soundboard/Monster4.ogg": 1.6, "Soundboard/Darkness5.ogg": 1.91 };
  ok(S.every((c) => LEN[c.file] && c.vol > 0 && c.vol <= 0.8), "every cue names a measured game sound and a sane volume");
  const at = (f) => S.find((c) => c.file === f);
  ok(st(at("Soundboard/Growl.ogg")) >= P.claw0 - 0.5 && st(at("Soundboard/Growl.ogg")) < P.claw0 + 0.6, "the rumble starts with the claw shot");
  ok(at("Soundboard/Wind5.ogg").beat > P.spreadAt && at("Soundboard/Wind5.ogg").beat < P.spreadAt + 1.2, "the whoosh peaks as the wing opens (rise 1.1 s)");
  ok(!S.some((c) => /Absorb2/.test(c.file)), "the deep breath (Absorb2) is cut (the user, 2026-11-19)");
  const roar = at("Soundboard/Monster4.ogg"), rp = returnPlan(), rr = returnSfx(rp).find((c) => c.file === roar.file);
  ok(roar.owner === "return" && rr && rr.beat === rp.pierce && rr.peak === roar.peak && rr.vol === roar.vol, "the roar is the return smoke's own cue on its pierce (listed, not doubled)");
  ok(at("Soundboard/Darkness5.ogg").beat > P.pierce && at("Soundboard/Darkness5.ogg").beat < P.roarEnd, "the swell comes as he is revealed");
  // silence on the blacks: nothing sounds over the first black, the black before the roar, or the cut
  const sounding = (t) => S.filter((c) => t >= st(c) && t <= end(c, LEN[c.file]));
  ok([0.5, 2, 3.4].every((t) => sounding(t).length === 0), "the black after the eyes is silent");
  ok(sounding(P.black0 + 0.3).length === 0 && sounding(P.smoke0 + 0.2).length === 0, "the black before the roar is silent");
}

// ── the cover: black at every cut, the vignette on the close-ups ──
ok(coverAt(0, P).black === 1 && coverAt(P.claw0 - 0.01, P).black === 1, "black until the claw shot");
ok(coverAt(P.claw0 + AWAKENING.claw.fadeIn + 0.1, P).black === 0 && coverAt(P.claw0 + 1, P).vignette === 1, "the claw shot is up, seen out of the dark (vignette)");
ok(coverAt(P.wing0 - 0.001, P).black > 0.99 && coverAt(P.wing0, P).black === 1, "fully black at the claw -> wing cut");
ok(coverAt(P.wing0 + 1.5, P).black === 0, "the wing shot is up");
ok(coverAt(P.black0 + 0.01, P).black === 1 && coverAt(P.smoke0, P).black === 1, "black before the roar");
ok(coverAt(P.pierce, P).black === 0 && coverAt(P.pierce, P).vignette === 0, "the cover is off the smoke's veil before the roar");
ok(coverAt(P.pierce + 1, P).vignette > 0.45 && coverAt(P.pierce + 1, P).black === 0, "the reveal is framed out of a soft dark (vignette, no black)");
ok(coverAt(P.arrive, P).vignette === 0 && coverAt(P.back0, P).vignette > 0.45, "the dark lifts as the camera moves back");
{ let jump = 0; for (let t = P.claw0; t < P.black0; t += 0.005) { const a = coverAt(t, P).black, b = coverAt(t + 0.005, P).black; if (Math.abs(a - b) > jump && Math.abs(t + 0.005 - P.wing0) > 0.006) jump = Math.abs(a - b); } ok(jump < 0.05, `the cover only fades (no pops) inside the shots (max step ${jump.toFixed(3)})`); }

// ── the camera (plan) ──
const c0 = cameraAt(P.claw0, P), c1 = cameraAt(P.wing0 - 1e-6, P);
ok(c0.shot === "claw" && c0.bearing === SHOTS.claw.bearing[0] && near(c1.bearing, SHOTS.claw.bearing[1], 1e-3), "the claw shot drifts round him (bearing moves across the shot)");
ok(c1.at.x < c0.at.x, "claw: the subject drifts left on screen (the camera pans right)");
ok(cameraAt(P.claw0 - 2, P).shot === "claw" && cameraAt(P.claw0 - 2, P).u === 0, "the claw shot stands ready in the black before it");
const w0 = cameraAt(P.wing0, P), w1 = cameraAt(P.black0 - 1e-6, P);
ok(w0.shot === "wing", "then the wing shot");
ok(w0.flip === true && c0.flip === false, "the wing shot's IMAGE is flipped horizontally; the claw shot's is not");
ok(near(w0.at.x, c0.at.x) && near(w1.at.x, c1.at.x, 1e-4) && w0.bearing === c0.bearing, "composed exactly like the claw shot (a similar shot)");
const sc0 = screenAt(c0), sc1 = screenAt(c1), sw0 = screenAt(w0), sw1 = screenAt(w1);
ok(sc0.x < 0.4 && sc1.x < 0.4 && sw0.x > 0.6 && sw1.x > 0.6, `on screen: claw on the LEFT third (${sc0.x.toFixed(2)}..${sc1.x.toFixed(2)}), wing on the RIGHT third (${sw0.x.toFixed(2)}..${sw1.x.toFixed(2)})`);
ok(sc1.x < sc0.x && sw1.x > sw0.x, "and the pans run opposite ways on screen (claw drifts left, wing drifts right)");
ok(Math.abs(sc1.x - sc0.x) >= 0.1, `the pan is big enough to read (${(sc0.x - sc1.x).toFixed(2)} of the screen)`);
ok(flippedShot(SHOTS.claw, { uv: { u: 0.5, v: 0.5 } }).flip === true && screenAt({ at: { x: 0.3, y: 0.5 }, flip: true }).x === 0.7, "flippedShot / screenAt");
const r = cameraAt(P.pierce, P);
ok(r.shot === "reveal" && r.heading === 35, "the reveal: the camera at 35 degrees (its yaw), toward his face (his front)");
ok(cameraAt(P.black0 + 0.01, P).shot === "reveal", "the reveal camera stands ready in the black before the roar");
ok(cameraAt(P.roarEnd + 0.99, P).shot === "reveal" && cameraAt(P.back0 + 0.01, P).shot === "back", "holds the reveal until 1 s after the roar");
ok(near(cameraAt(P.back0, P).stand, 1) && near(cameraAt(P.arrive - 1e-9, P).stand, 0, 1e-6) && cameraAt(P.arrive, P).shot === "rest", "hands back to the battle camera (stand 1 -> 0) by the arrival");

// ── the camera (solved through the real rig, the Great Seal preset, 1920 x 1080) ──
{
  const STAGE = { x: 439, y: 241, w: 1682, h: 788 }, grid = 110;
  const cfg = resolvePreset("https://x/Valley_Battlemap003.webp");
  const camB = buildCamera(cfg, STAGE, grid), PP = buildProjector(cfg, camB, STAGE);
  const scale = 1920 / STAGE.w, rest = { x: STAGE.x + STAGE.w / 2, y: STAGE.y + STAGE.h / 2, scale };
  const screen = { w: 1920 / scale, h: 1080 / scale }, model = { P: PP, cfg, rest };
  // the dragon as spawned on the Great Seal (left, facing right = mirrored), a 825 x 804 card
  const feet = { x: STAGE.x + 360, y: STAGE.y + 600 }, rect = { x: feet.x - 412, y: feet.y - 804, w: 825, h: 804 };
  const toScreen = (q) => ({ x: (q.x - rest.x) * scale + 960, y: (q.y - rest.y) * scale + 540 });
  for (const [name, cm] of [["claw start", c0], ["claw end", c1], ["wing start", w0], ["wing end", w1], ["reveal", r]]) {
    const S = solvePlaced({ model, feet, rect, mirrored: true, screen, cam: cm });
    const sp = toScreen(S.drawn), want = { x: cm.at.x * 1920, y: cm.at.y * 1080 }, hPx = S.size * scale;
    const wantH = (cm.fit ?? cm.span) * 1080;
    ok(Math.hypot(sp.x - want.x, sp.y - want.y) < 3 && Math.abs(hPx - wantH) < 3, `${name}: subject at (${sp.x.toFixed(0)}, ${sp.y.toFixed(0)}) want (${want.x.toFixed(0)}, ${want.y.toFixed(0)}); drawn ${hPx.toFixed(0)} px want ${wantH.toFixed(0)}`);
    ok(S.shot.stand === 1 && S.shot.lens > 0 && Number.isFinite(S.shot.lookX) && S.dist >= 2.2, `${name}: a placed shot (lens ${S.shot.lens.toFixed(2)}, ${S.dist.toFixed(1)} m out, eye ${S.eye.toFixed(2)} m)`);
    if (name === "reveal") {
      // the camera stands on his FACE side: further right (+X, toward the party) than straight-on
      const S0 = solvePlaced({ model, feet, rect, mirrored: true, screen, cam: { ...cm, heading: null, bearing: 0 } });
      ok(S.shot.standX > S0.shot.standX, `reveal: the camera stands on his face side (x ${S.shot.standX.toFixed(0)} vs straight-on ${S0.shot.standX.toFixed(0)})`);
      const rig = rigCamera({ view: rest, rest, shot: S.shot, sway: false }, PP, cfg);
      ok(Math.abs(rig.yaw - 35) < 0.1, `reveal: the camera's yaw is 35 degrees (${rig.yaw.toFixed(2)}; bearing round him ${S.bearing.toFixed(1)})`);
    }
  }
  // the reveal (v3): the camera much closer than v1's (26 m), his painting 1.5 screen heights: past every edge
  const Sr = solvePlaced({ model, feet, rect, mirrored: true, screen, cam: r });
  ok(Sr.dist < 20 && r.span >= 1.4, `reveal: the camera closer (${Sr.dist.toFixed(1)} m), his body ${r.span} screen heights tall`);
  ok(Sr.size * scale > 1080 * 1.4, "reveal: his drawn painting overflows the screen top to bottom (he has the whole screen)");
  ok(Math.abs(r.at.y - 0.5) < 1e-9 && r.at.x >= 0.55 && r.at.x <= 0.6 && r.uv.u < 0.3 && r.uv.v > 0.45 && r.uv.v < 0.65, "reveal: aimed at his FACE, at the screen's vertical centre, 55-60 % across (the user, v4)");
}

// ── geometry helpers ──
const rect = { x: 100, y: 200, w: 859, h: 837 };
const p = pointOnRect(rect, { u: 0.25, v: 0.5 });
ok(near(p.x, 100 + 0.25 * 859) && near(p.y, 200 + 0.5 * 837), "pointOnRect unmirrored");
ok(near(pointOnRect(rect, { u: 0.25, v: 0.5 }, true).x, 100 + 0.75 * 859), "pointOnRect mirrored");
ok(near(pointOnRect(rect, { u: 0.25, v: 0.5 }, false, 60).x, 100 + (0.5 - 0.125) * 859), "pointOnRect: a turned rig pulls the point toward the centre line (cos yaw)");
const v = viewFor({ x: 1000, y: 500 }, { x: 0.25, y: 0.5 }, 2, { w: 1920, h: 1080 });
ok(near((1000 - v.x) * 2 + 960, 0.25 * 1920) && near((500 - v.y) * 2 + 540, 540), "viewFor puts the point at the screen fraction");
const b = blendView({ x: 0, y: 0, scale: 1 }, { x: 10, y: 20, scale: 4 }, 0.5);
ok(near(b.x, 5) && near(b.y, 10) && near(b.scale, 2), "blendView (zoom blended in log space)");

// ── the registry (battle-opening-styles.js) ──
const NS = "fabula-ultima-companion";
registerBattleOpening("t-open", { play: () => ({ arrived: Promise.resolve(true), done: Promise.resolve(true) }), spanMs: () => 1000 });
ok(battleOpeningFromFlags({ [NS]: { battleOpening: " t-open " } }) === "t-open", "flag read (trimmed)");
ok(battleOpeningFromFlags({ [NS]: { battleOpening: "off" } }) === null && battleOpeningFromFlags({}) === null && battleOpeningFromFlags(null) === null, "no / off flag -> null");
const enc = [{ id: "a", flags: {} }, { id: "b", flags: { [NS]: { battleOpening: "nope" } } }, { id: "c", flags: { [NS]: { battleOpening: "t-open" } } }, { id: "d", flags: { [NS]: { battleOpening: "t-open" } } }];
ok(JSON.stringify(pickBattleOpening(enc)) === JSON.stringify({ key: "t-open", bossId: "c" }), "first enemy naming a REGISTERED style claims it (an unknown name is skipped)");
ok(pickBattleOpening([{ id: "a", flags: {} }]) === null && pickBattleOpening() === null, "no claim -> null (the usual start)");
let threw = false; try { registerBattleOpening("bad", { spanMs: () => 1 }); } catch { threw = true; }
ok(threw, "a style without play() is refused");
ok(battleOpeningStyle("t-open").crackOutMs === 0, "crackOutMs defaults to 0");
unregisterBattleOpening("t-open");
ok(pickBattleOpening(enc) === null, "unregistered -> the usual start");

console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
