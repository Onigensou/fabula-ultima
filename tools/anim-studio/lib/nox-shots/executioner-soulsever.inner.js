// ── Soul Sever (approved: part-r2 build + part-r4 Slash clip/Sever + part-r5 + part-r6 "Run it through" without the
// impact frame). FULL TAKEOVER. It floats to the Soul Fragment it eats (the largest that has Called, a real token) as the
// screen darkens; the camera closes in as it runs the fragment through (shards, a flash on it, a shake); the fragment
// boils away into jade flame, soul-light streams up the raised blade and circles the knight (camera creeps); the camera
// snaps wide, the smear frame swings with a giant jade sword-slash and a jade crescent sweeps over the party: X-cut +
// acid on each player as it passes (one oni.hit each); the gate when the sweep ends. Jade embers rain, it floats home.
// No fragment found: the fragment parts are skipped (it floats to where one would stand, the rest plays).
const C = cfg.t;
const total = C.total;
const HAS_FR = !!TOK.fr;
// the fragment: painted here (its token look: the owner's art in the Sealed Cavern green, alpha .9), hidden as a token
const FRp = HAS_FR ? { x: OXk('fr'), y: OYk('fr') } : { x: HB.x + DIR * 250 * KP, y: HB.y };
const FRh = HAS_FR ? hgtk('fr') : K.h, FRs = HAS_FR ? sOf('fr') : 1;
const frBody = () => ({ x: FRp.x, y: FRp.y - FRh * 0.5 });
const party = FOES.slice();

if (HAS_FR) fragPaint(total, tw(1, [[C.b3, cfg.charge * 0.6, 0, X.sine]]), { flinchAt: C.b2 + 220, tier: 'strong', flashAt: C.b2 + 220, flashCol: '#bfffe6' });

// ── Beat 1: Float to the fragment (screen darkens) ──
fdim(0, 0.5, 700); vignette(0, 0.35, 700);
heavyStep(0, { x: FRp.x - 150 * KP * DIR, y: FRp.y }, 900);

// ── Beat 2: Run it through (camera closes in, the fragment shatters) ──
{ const s = bodyAt(C.b2); camTo(C.b2, { x: lerp(s.x, FRp.x, 0.55), y: FRp.y - FRh * 0.6, z: cfg.zoom }, 450, X.outCubic); }
lean(C.b2, -8, 220, X.out); lean(C.b2 + 220, 12, 90, X.out);
S_(C.b2 + 220, 'sword5', 0.55);
if (HAS_FR) { S_(C.b2 + 220, 'break', 0.5); shards(C.b2 + 220, frBody(), JADE_HOT, 26, 0.5); }
shake(C.b2 + 220, 10, 300);

// ── Beat 3: The soul pours into the blade (fragment burns away, soul-light circles the knight, wind-up held) ──
const ms = cfg.charge;
S_(C.b3, 'darkness3', 0.45); S_(C.b3, 'absorb2', 0.4); rumble(C.b3, C.s4, 3);
if (HAS_FR) pxfx('pxfx_nox_soulfire', C.b3, { x: FRp.x, y: FRp.y - 4 * KP }, FRs * 1.9, { z: 22 });
fdim(C.b3, 0.65, 600);
playPose(C.b3, 'slash', { to: 2, hold: true, speed: cfg.pspd });
const t3 = C.b3 + 250;
const sT = bodyAt(t3), tip = poseAt(sT, cfg.raised.x, cfg.raised.y);
if (HAS_FR) soulStream(t3, frBody(), tip, { n: 48, ms: ms * 0.7, arc: 60, spread: 40 });
pxfx('pxfx_nox_soulfire', t3, { x: tip.x, y: tip.y + 40 * KP }, sT.d * 1.5, { loop: true, until: C.s4, fade: 100, z: 22 });
for (let e = 0; e < ms; e += 30) { const an = rnd(0, 6.2832), r = rnd(80, 150) * sT.d * KP;
  homing(t3 + e, { x: sT.x + Math.cos(an) * r, y: sT.y - boxH(sT) * 0.5 + Math.sin(an) * r * 0.45 }, tip, JADE_HOT, { ms: 700, arc: 90, r: rnd(2, 4) }); }
camTo(t3, { x: sT.x + 60 * KP * DIR, y: sT.y - boxH(sT) * 0.55, z: cfg.zoom * 0.92 }, ms, X.sine);

// ── Beat 4: Sever (camera wide, flash, smear + giant jade slash, crescent sweep: X-cut + acid per player; DAMAGE GATE) ──
camTo(C.s4, { x: REST.x + 60 * KP * DIR, y: REST.y, z: 0.94 }, 220, X.outCubic);
flashC(C.s4, '#bfffe6', 0.45, 30, 260);
const sS = bodyAt(C.s4);
playPose(C.s4, 'slash', { from: 3, speed: cfg.pspd, on: {
  smear: (t) => { S_(t, 'swingC', 0.6); S_(t, 'wind7', 0.45); pxfx('pxfx_nox_swordslash', t, { x: sS.x + 40 * KP * DIR, y: sS.y + 20 * KP }, cfg.slash, { z: 41 }); },
} });
let yTop = Infinity, yBot = -Infinity, far = null; for (const k of party) { yTop = Math.min(yTop, OYk(k)); yBot = Math.max(yBot, OYk(k)); if (far == null || DIR * OXk(k) > DIR * far) far = OXk(k); }
if (!party.length) { yTop = yBot = HB.y; far = HB.x + DIR * 600 * KP; }
const ySw = lerp(yTop, yBot, 0.5) - 70 * KP, x0 = sS.x + 120 * KP * DIR, x1 = far + 320 * KP * DIR;
const sw0 = C.s4 + 120, swMs = cfg.sweep;
const swX = (e) => lerp(x0, x1, X.in(clamp01(e / swMs)));
pxMover('pxfx_nox_crescent', sw0, swMs, cfg.wave, 40, (e) => ({ x: swX(e), y: ySw }));
for (let e = 0; e < swMs; e += FRM) if (R() < 0.5) shards(sw0 + e, { x: swX(e) - 40 * KP * DIR, y: ySw + rnd(-90, 90) * KP }, JADE_HOT, 2, 0.25);
for (const k of party) {
  const frac = (OXk(k) - 30 * KP * DIR - x0) / (x1 - x0); const th = sw0 + swMs * Math.sqrt(clamp01(frac));
  const sk = sOf(k);
  pxfx('pxfx_nox_xslash', th, { x: OXk(k) - 30 * sk * KP * DIR, y: OYk(k) - hgtk(k) * 0.1 }, sk * cfg.x, { z: 42 });
  pxfx('pxfx_nox_acid', th, feetk(k), sk * 1.2, { z: 40 });
  S_(th, 'slashL', 0.35); HIT(th);
}
shake(C.gate, 16, 420);

// ── Beat 5: Embers + back (jade embers rain over the party, camera home, it floats back) ──
{ let cx = 0, cy = 0; for (const k of party) { cx += OXk(k) / party.length; cy += OYk(k) / party.length; } if (!party.length) { cx = x1; cy = ySw; }
  for (let i = 0; i < 50; i++) { const vy = rnd(0.03, 0.08), vx = rnd(-0.015, 0.015), r = rnd(1.5, 3.5);
    part({ t0: C.b5, life: rnd(1300, 2200), x: cx + rnd(-320, 320) * KP, y: cy - rnd(120, 440) * KP, vx, vy, layer: 'hit', draw: (g, x, y, u) => glw(g, x, y, r * 4 * KP, JADE, 0.85 * Math.sin(u * Math.PI)) }); } }
camHome(C.b5, 900); fdim(C.b5, 0, 900); vignette(C.b5, 0, 900);
lean(C.b5, 0, 300, X.out);
heavyStep(C.b5 + 300, { x: HB.x, y: HB.y }, 900);

await runShot(total, C.gate);
