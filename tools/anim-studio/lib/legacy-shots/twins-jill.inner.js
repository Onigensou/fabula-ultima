// ── Jill: Zero Power: Temper Tantrum, Pulverize, Heavy Axe ──
// Port of the approved legacy boss mockup (part-b2.js + round 3 "Fuming" beat + round 4: one monster
// sound only, the eruption is the pixelfx fire pillar). cfg.move = 'tantrum' | 'pulverize' | 'heavyaxe'.
// The berserk aura here is the cinematic beat only: it fades at the end of the shot and leaves no tint
// on the token (the lasting look is the Berserk status cue in world data). No backticks in this file.
const MOVE = cfg.move;
let total = 0;

if (MOVE === 'tantrum') {
  // Cut-in (her sprite, pixel art)
  const S0 = cutinPx(0, 'cut');
  // Stomps: cracks, dust, stones lift
  fdim(S0, 400, 0.5);
  for (let i = 0; i < 2; i++) { const t0 = S0 + i * cfg.stomp, hit = t0 + 110;
    squash(t0, 110, 1.14, 0.84); SX(hit, 'earth5', 0.5); SX(hit, 'blowL', 0.4); m.shake(hit, 220, 8 * KP);
    crack(hit, { x: KF.x + (i ? 18 : -18) * KP * DIR, y: KF.y }); dustBurst(hit, KF, { n: 10 }); squash(hit, 140, 1, 1); }
  const RK = S0 + 2 * cfg.stomp;
  const ROCKS = { blast: false, list: [] };
  spawn(RK, () => { for (let i = 0; i < 9; i++) { const a0 = rnd(0, 6.283);
    const p = { x: KF.x + Math.cos(a0) * rnd(50, 110) * KP, y: KF.y + Math.sin(a0) * 20 * KP, life: 6000, s: rnd(5, 11), r: rnd(0, 6), lift: 0, comp: 'source-over',
      update: (q, dt) => { if (!ROCKS.blast) q.lift = Math.min(q.lift + dt * 0.05 * KP, (60 + q.s * 3) * KP); else { q.x += q.vx * dt * KP; q.y += q.vy * dt * KP; q.vy += 0.0015 * dt; q.r += 0.02 * dt; } },
      draw: (g, q) => { const s = q.s * KP; g.translate(q.x, q.y - q.lift); g.rotate(q.r); g.fillStyle = '#6b5a49'; g.beginPath(); g.moveTo(-s, -s * 0.4); g.lineTo(-s * 0.2, -s); g.lineTo(s, -s * 0.3); g.lineTo(s * 0.6, s * 0.7); g.lineTo(-s * 0.7, s * 0.6); g.closePath(); g.fill(); } };
    addP('field', p); ROCKS.list.push(p); } });
  // Fuming: rapid side-to-side sway, comic dust at the feet, steam off the head (silent: round 4)
  const F0 = RK, D = cfg.fume, TAU = Math.PI * 2;
  const ph = (u) => u * D / 1000 * 7 * TAU;
  keyFn(BODY.dx, F0, D, (u) => Math.sin(ph(u)) * 14 * KP * DIR); keyFn(BODY.hop, F0, D, (u) => Math.abs(Math.sin(ph(u))) * 6 * KP); keyFn(BODY.rot, F0, D, (u) => Math.sin(ph(u)) * 9);
  key(BODY.dx, F0 + D, 0, 0); key(BODY.hop, F0 + D, 0, 0); key(BODY.rot, F0 + D, 0, 0);
  for (let k = 0; k * 140 < D; k++) { const at = F0 + k * 140, ox = valAt(BODY.dx, at);
    comicPuff(at, { x: KF.x + ox + (k % 2 ? 26 : -26) * KP, y: KF.y }, { s: 0.9, n: 3 });
    if (k % 2) comicPuff(at, { x: KF.x + ox + rnd(-12, 12) * KP, y: KF.y - HB('k') * 0.95 }, { s: 0.55, up: 0.1, n: 2 }); }
  // Eruption: the pixelfx fire pillar, embers, three red afterimages
  const E0 = F0 + D, ER = cfg.erupt;
  SX(E0, 'berserker', 0.6); lean(E0, 300, 6);
  pxClip('pillar', E0, KF, 1.15);
  for (let t = E0; t < E0 + ER; t += 40) spawn(t, () => { for (let i = 0; i < 4; i++) ember('field', KF.x + rnd(-40, 40) * KP, KF.y - rnd(0, 40) * KP, '255,70,40', { vy: -rnd(0.18, 0.35), r: rnd(3, 7), life: rnd(500, 900) }); });
  const RED = ghostImg({ filter: 'sepia(1) saturate(9) hue-rotate(-40deg) brightness(1.1)' });
  for (let i = 0; i < 3; i++) { const at = E0 + Math.round(i * ER / 3); m.hold(at, at + 600, (e, S) => { const u = EZ.out(Math.min(1, e / 600)); S.world.push({ z: 4, draw: (g) => drawCopy(g, RED, pose(at), 0.7 * (1 - u), 1 + u * 0.6) }); }); }
  // Roar: shockwave, red flash frame, the stones blast out (the one monster sound)
  const R0 = E0 + ER;
  SX(R0, 'explosion2', 0.6); SX(R0, 'monster3', 0.45); squash(R0, 120, 1.08, 0.94); lean(R0, 120, -4);
  ring(R0, KF, { r1: 700, ms: 700, w: 12, rgb: '255,90,60' });
  ring(R0, bodyAt(R0), { layer: 'field', r1: 900, ms: 700, sy: 0.5, w: 8, rgb: '255,140,110', ref: KF });
  once(R0, () => { ROCKS.blast = true; for (const p of ROCKS.list) { const a = Math.atan2(p.y - p.lift - KF.y + 40 * KP, p.x - KF.x); p.vx = Math.cos(a) * rnd(0.4, 0.7); p.vy = Math.sin(a) * rnd(0.3, 0.5) - 0.3; p.y -= p.lift; p.lift = 0; p.life = p.t + 900; } });
  m.flash(R0, 30, 220, '#ff3020', 0.55); m.shake(R0, 420, 16 * KP);
  // Berserk aura: a pulsing red glow round her for the cinematic, embers; the gate opens here
  const A0 = R0 + 450, AU = 2200;
  fdim(A0, 500, 0); lean(A0, 300, 0); gateAt(A0);
  const conv = KP * ((ART && (ART.naturalHeight || ART.videoHeight || ART.height)) || K.h) / K.h;   // mockup px -> art px
  const pad = Math.ceil(10 * conv * 3) + 4;
  const glowOf = (k) => bake('drop-shadow(0 0 ' + ((4 + 6 * k) * conv).toFixed(1) + 'px rgba(255,40,30,.95)) drop-shadow(0 0 ' + (2 * conv).toFixed(1) + 'px rgba(255,120,80,' + (0.6 + 0.4 * k) + '))', pad);
  const G0 = glowOf(0), G1 = glowOf(1);
  m.hold(A0, A0 + AU + 250, (e, S) => { const k = 0.5 + 0.5 * Math.sin(Math.min(1, e / AU) * Math.PI * 7), fade = e > AU ? 1 - (e - AU) / 250 : 1; const p = pose(A0 + e);
    S.world.push({ z: 4, draw: (g) => { drawCopy(g, G0, p, (1 - k) * fade); drawCopy(g, G1, p, k * fade); } }); });
  for (let t = A0; t < A0 + AU; t += 66) spawn(t, () => ember('field', KF.x + rnd(-25, 25) * KP, KF.y - rnd(0, HB('k') * 0.8), '255,60,40', { vy: -rnd(0.06, 0.12), r: rnd(2, 4) }));
  squash(A0 + AU, 200, 1, 1);
  BODY_END = A0 + AU + 250;
  total = Math.max(BODY_END + 1200, E0 + (CL.pillar_front ? CL.pillar_front.dur : 0));
} else {
  if (!FOES.length) { oni.fireDone(); return; }
  const TK = FOES[0];
  if (MOVE === 'pulverize') {
    // Arc jump onto the target, overhead smash with the Divine Smite clip, flash, crack, slide back
    SX(0, 'jump2', 0.5); moveTo(0, 520, front(TK, 80), EZ.quad, { hop: 140 });
    lean(520, 120, -10); const H = lean(640, 80, 14);
    clipAt('smite', H, tFeet(TK), 1.2, { z: 42 }); m.flash(H, 30, 160, '#ffffff', 0.45); m.shake(H, 340, 14 * KP); crack(H, tFeet(TK));
    land(H, TK, { s: 'hitslashb', vol: 0.6 }); statusBeat(H, TK); gateAt(H);
    lean(H + 350, 160, 0); BODY_END = goHome(H + 510, 520);
    total = Math.max(BODY_END + 300, H + (CL.smite ? CL.smite.dur : 0));
  } else {
    // Heavy Axe: dash, wind-up, one big swing, Stagger beat, back
    moveTo(0, 380, front(TK, 90), EZ.quad, { trail: true });
    lean(380, 220, -14); SX(600, 'swingF', 0.5); const H = lean(600, 90, 16);
    clipAt('slash_phys', H, tCenter(TK), 1.5, { z: 42 }); land(H, TK, { s: 'blowL', vol: 0.6 }); m.shake(H, 260, 10 * KP);
    statusBeat(H + 80, TK); gateAt(H + 80);
    lean(H + 380, 160, 0); BODY_END = goHome(H + 540, 440, { hop: 20 });
    total = BODY_END + 600;
  }
}
await runShot(total);
