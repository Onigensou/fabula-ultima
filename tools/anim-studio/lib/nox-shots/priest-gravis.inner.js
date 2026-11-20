// ── Gravis (spec gravis.md): rite, a void orb over the party pulling the floor in, the collapse (gate), release. LIVE. ──
const HOLD = cfg.hold == null ? 1100 : cfg.hold;
const VIOLET = '160,110,255';
// Beat 1: fdim .45 / 500, Darkness4, rite 700
S_(0, 'darkness4', 0.45);
const ORB = rite(0, VIOLET, 700);
// Beat 2: the void orb (pixelfx gravorb, no back layer, looping) 200 px over the party; rings pulled in + grit, every 180 ms
const c = PARTY_C(), top = { x: c.x, y: c.y - 200 * KP };
const COLL = ORB + HOLD;
S_(ORB, 'charging', 0.45);
rumble(ORB, COLL, 2);
pxClip('pxfx_nox_gravorb', ORB, top, { scale: 2.6, loop: true, back: false, z: 6000, fadeAt: COLL, fadeMs: 200 });
for (let at = ORB + 180; at < COLL; at += 180) {
  ring(at, c, { rgb: '170,130,255', r0: 360, r1: 30, ms: 700, sy: 0.32, w: 5 });
  for (let i = 0; i < 4; i++) { const an = rnd(0, 6.28); homing(at, { x: c.x + Math.cos(an) * 300 * KP, y: c.y + Math.sin(an) * 90 * KP }, top, '190,160,255', { ms: 650, arc: 40, r: 2 }); }
}
// Beat 3: the collapse: Darkness5 + Collapse2, the dark implosion (violet), 260 ms later shake + flash + everyone crushed flat
S_(COLL, 'darkness5', 0.55); S_(COLL, 'collapse2', 0.45);
pxClip('pxfx_dark_implosion', COLL, { x: c.x, y: c.y - 60 * KP }, { scale: 2.4, filter: 'hue-rotate(-85deg) saturate(1.2)' });
const CRUSH = COLL + 260, REL = CRUSH + 420, END = REL + 400 + 300;
shake(CRUSH, 12, 380);
flashC(CRUSH, '#b090ff', 0.35, 30, 260);
for (const k of FOES) {
  // squash(a, 1.14, .8, 90) then back to 1 with outBack over 500 (Beat 4)
  squashTrack(k, [[CRUSH, 90, 1.14, X.out], [REL, 500, 1, X.outBack]], [[CRUSH, 90, 0.8, X.out], [REL, 500, 1, X.outBack]], CRUSH, REL + 500);
  dustBurst(CRUSH, ftOf(k), { n: 6, s: sOf(k) });
}
// one contact: the 25% lands on everyone at once (the game draws the numbers)
once(CRUSH, () => oni.hit());
// Beat 4: release: dim out 600, glow off, lean home 400, wait 300
dimTrack(tw(0, [[0, 500, 0.45, X.sine], [REL, 600, 0, X.sine]]), END);
glowOff(REL);
ROT = tw(0, [[0, 700, leanDeg(-5), X.sine], [REL, 400, 0, X.out]]);
await runShot(Math.max(END, COLL + 1700), CRUSH);
