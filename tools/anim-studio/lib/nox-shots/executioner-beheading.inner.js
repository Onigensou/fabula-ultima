// ── Beheading (passive, round end; approved: part-exec + part-r4 Slash clip + part-r5 stance + part-r6 "the slash is the
// KO" + part-r7 Down1 once). FULL TAKEOVER. Played by a play_animation row in the passive's round-end chain: caster =
// the Executioner, target = the marked player being beheaded. The mockup's first beat (the jade flame "mark" over her)
// was the Beheading status stand-in, so the shot starts at the round end: dark, everyone else fades, the camera closes
// on her, Down1 once. It fades out, is just there BEHIND her facing back, sword up (wind-up), soul-fire on the blade,
// silence. The cut: smear -> Execution + a jade crescent; contact = the KO burst, all on one frame (the gate): impact
// frame, white flash, jade skull (MV 065_death), crit starburst, shards, sparks, ring, her Soul Fragment going out.
// Her KO pose itself is the game's. Back: it fades out, home, fades in; the camera and the others come back.
const C = cfg.t;
const tk = FOES[0];
if (!tk) { oni.fireDone(); return; }
const total = C.total;
const OXk0 = OXk(tk), OYk0 = OYk(tk), Hk = hgtk(tk), Sk = sOf(tk);
const HAS_FR = !!TOK.fr;

// ── cast focus: everyone but the Executioner, her and her fragment fades (600 ms), back from beat 5 (600 ms) ──
const keep = new Set(['k', tk, 'fr']);
const FOC = tw(1, [[0, 600, 0, X.sine], [C.b5, 600, 1, X.sine]]);
m.hold(0, total, (t, S) => { const a = FOC(t); if (a >= 0.999) return; for (const k in S.tok) { if (keep.has(k)) continue; const q = S.tok[k]; if (a <= 0.001) q.hidden = true; else q.alpha *= a; } });
// she stands in front of the knight behind her: painted by the shot over its body (z 21), her token hidden;
// from the contact frame her KO art (sprite_ko, played once from its first frame, then held) - the slash IS the KO
await loadPoses(tk, ['ko']);
paintTarget(tk, total, { z: 21, always: true });
if (HAS_FR) fragPaint(total, tw(1, [[C.gate, 500, 0, X.sine]]));

// ── Beat 2 (first here): Round end ──
fdim(0, 0.7, 700);
camTo(0, { x: OXk0 - 60 * KP * DIR, y: OYk0 - 110 * KP, z: 1.35 }, 900, X.sine);
S_(0, 'down1', 0.3, 0.6);

// ── Beat 3: Behind her (fade out, turn, stand behind her, fade in, wind-up, soul-fire, silence) ──
fadeEx(C.b3, 0, 200);
const flipAt = C.b3 + 200;
BFLIP.add(flipAt, -FLIP0);
{ const s = bodyAt(flipAt); s.flip = -FLIP0; teleport(flipAt, slashStance(s, tk, cfg.stanceCx, -4)); }
fadeEx(flipAt, 1, 250);
S_(flipAt + 250, 'shing', 0.45);
const upEnd = playPose(flipAt + 250, 'slash', { to: 2, hold: true, speed: cfg.pspd });
{ const s = bodyAt(upEnd); const p = poseAt(s, cfg.raised.x, cfg.raised.y); pxfx('pxfx_nox_soulfire', upEnd, { x: p.x, y: p.y + 40 * KP }, s.d * 0.8, { loop: true, until: C.b4, fade: 100, z: 22 }); }

// ── Beat 4: The cut (smear: Execution + crescent; contact: the KO burst = DAMAGE GATE) ──
const P = cfg.parts;
playPose(C.b4, 'slash', { from: 3, speed: cfg.pspd, on: {
  smear: (t) => { S_(t, 'execution', 0.5); crescent(t, { x: OXk0, y: OYk0 - Hk * 0.8 }, { ang: 0.1, len: 220, w: 18, rgb: JADE_HOT, ms: 320 }); },
  contact: (t) => { const b = centerk(tk);
    HIT(t); impactFrame(t, [{ k: tk }]); poseOn(tk, t, 'ko', total);
    S_(t, 'collapse4', 0.45);
    whiteTo(t, 0.8, 50); whiteTo(t + 50, 0, 420);
    fx('065_death', t, b, Sk * 0.7, { z: 26, flip: false, filter: 'hue-rotate(110deg) saturate(1.4)' });
    pxfx('pxfx_nox_crithit', t, { x: b.x, y: b.y + 20 * KP }, Sk * 1.1 * P, { z: 46 });
    shards(t, b, JADE_HOT, Math.round(34 * P), 0.6); shards(t, b, '255,255,255', Math.round(12 * P), 0.5);
    ring(t, b, { rgb: JADE, r0: 20, r1: 230 * Sk * P, ms: 520, w: 6 });
    for (let k = 0; k < 40 * P; k++) { const an = rnd(0, 6.2832), v = rnd(0.25, 0.7), r = rnd(1.5, 3.2);
      part({ t0: t, life: rnd(500, 1100), x: b.x, y: b.y, vx: Math.cos(an) * v, vy: Math.sin(an) * v - 0.15, g: 0.0011, drag: 0.985, layer: 'hit', draw: (g, x, y, u) => glw(g, x, y, r * 4 * KP, JADE_HOT, 1 - u) }); }
    if (HAS_FR) shards(t, { x: OXk('fr'), y: OYk('fr') - hgtk('fr') * 0.5 }, JADE_HOT, 14, 0.4);
    shake(t, 16, 420); },
} });

// ── Beat 5: Back (camera home, dim off, the others return; fade out, home, fade in) ──
camHome(C.b5, 700); fdim(C.b5, 0, 700);
fadeEx(C.b5, 0, 200);
BFLIP.add(C.b5 + 200, FLIP0); teleport(C.b5 + 200, { x: HB.x, y: HB.y }); lean(C.b5 + 200, 0, 10, X.out);
fadeEx(C.b5 + 200, 1, 300);

await runShot(total, C.gate);
