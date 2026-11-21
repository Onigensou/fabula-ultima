// ── Nox Guillotine (approved: part-r2 blade + part-r4 camera/Slash clip + part-r5 v3 stance). FULL TAKEOVER (camera).
// Float in (camera follows), raise (Slash wind-up, soul-fire on the raised blade, camera closes in), a jade guillotine
// blade hangs over the target with its shadow (camera creeps in), the sword comes down: smear frame -> top-to-bottom
// tapered stroke + the blade drops; contact frame -> camera punch, impact frame, crack, shards (the damage gate);
// she buckles (Cripple) and it floats home while the camera eases out.
const C = cfg.t;
const tk = FOES[0];
if (!tk) { oni.fireDone(); return; }
const OXb = OXk(tk), OYb = OYk(tk), Hb = hgtk(tk), Sb = sOf(tk);
const total = C.total;
await loadPoses(tk, ['hurt']);

// ── Beat 1: Float in, the camera follows ──
const s0 = bodyAt(0);
const stance = slashStance(s0, tk, cfg.stanceCx, 6);
camFollow(0, C.b2, 1.15);
heavyStep(0, stance, 1000);

// ── Beat 2: Raise + blade fire ──
S_(C.b2, 'shing', 0.4);
{ const s = bodyAt(C.b2); camTo(C.b2, { x: lerp(s.x, OXb, 0.5), y: OYb - Hb * 0.9, z: cfg.zin }, 600, X.sine); }
playPose(C.b2, 'slash', { to: 2, hold: true, speed: cfg.pspd });
const fireAt = C.b3;                          // raisedFire2(.9) once the wind-up frame is up
{ const s = bodyAt(fireAt); const p = poseAt(s, cfg.raised.x, cfg.raised.y); pxfx('pxfx_nox_soulfire', fireAt, { x: p.x, y: p.y + 40 * KP }, s.d * 0.9, { loop: true, until: C.b4, fade: 120, z: 22 }); }
fdim(fireAt, 0.35, 300);

// ── Beat 3: The blade hangs (camera creeps in; the jade guillotine blade + its shadow) ──
camTo(C.b3, { z: cfg.zin * 1.07 }, cfg.hold + 300, X.sine);
S_(C.b3, 'magic4', 0.35, 0.7);
const topY = OYb - Hb * 1.18, L = 120 * Sb * KP;
const dropTo = OYb - Hb * 0.35, dropEnd = C.b4 + 70;
const bladeY = (t) => (t < C.b4 ? topY : lerp(topY, dropTo, X.inCubic(clamp01((t - C.b4) / 70))));
part({ t0: C.b3, life: dropEnd - C.b3, x: OXb, y: topY, layer: 'hit', pos: () => ({ x: OXb, y: topY }), draw: (g, x, y, u, age, p, t) => {
  const k = 0.82 + 0.18 * Math.sin(age / 70), gg = X.outCubic(clamp01(age / 160)), yy = bladeY(t);
  taperBlade(g, OXb - L * gg * DIR, yy + 12 * gg * KP, OXb + L * gg * DIR, yy - 12 * gg * KP, cfg.bw * k * KP, JADE, 0.9); } });
floorShadow(C.b3, dropEnd, feetk(tk), { r: 70, s: Sb, to: 0.45, grow: 400 });

// ── Beat 4: The drop (smear: stroke + the blade drops; contact: punch, impact frame, crack, shards = DAMAGE GATE) ──
playPose(C.b4, 'slash', { from: 3, speed: cfg.pspd, on: {
  smear: (t) => { S_(t, 'swingC', 0.55); screenStroke(t, { x: OXb + 6 * KP * DIR, y: OYb - Hb * 2.4 }, { x: OXb - 6 * KP * DIR, y: OYb + 10 * KP }, { w: cfg.sw, ms: 560 }); },
  contact: (t) => {
    camTo(t, { x: OXb, y: OYb - Hb * 0.55, z: cfg.punch }, 90, X.outCubic);
    impactFrame(t, [{ k: tk }]);
    HIT(t); flinchOn(tk, t, 'normal', true, total); S_(t, 'crit', 0.55); S_(t, 'slashL', 0.5);
    crack(t, feetk(tk), Sb); shards(t, centerk(tk), JADE_HOT, 16, 0.45); shake(t, 14, 360);
  },
} });

// ── Beat 5: Cripple + back (she buckles, camera eases out, it floats home) ──
camHome(C.b5, 900);
const SX = tw(1, [[C.b5, 220, 1.06, X.out], [C.b5 + 220, 600, 1, X.out]]), SY = tw(1, [[C.b5, 220, 0.88, X.out], [C.b5 + 220, 600, 1, X.out]]);
tokTrack(tk, total, (q, t) => { if (t >= C.b5) { q.sx *= SX(t); q.sy *= SY(t); } });
fdim(C.b5 + 220, 0, 400);
heavyStep(C.b5 + 220, { x: HB.x, y: HB.y }, 900);

await runShot(total, C.gate);
