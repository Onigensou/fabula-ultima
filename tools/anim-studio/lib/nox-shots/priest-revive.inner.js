// ── Revive / Resurrection (spec revive.md): a mock blessing on the Zombie'd target: rite, a feather sinks onto it with a heal
// shimmer, then the light turns: white flash, white silhouette, the jade death skull (gate), its soul drifts up. LIVE board.
// Visual only: the game decides the outcome (Revive on a Zombie'd target defeats it) and draws the KO pose and the Zombie tint.
const tk = FOES[0];
if (!tk) { oni.fireDone(); return; }
const s = sOf(tk);
// Beat 1: dim .35 / 400, rite (warm white) 700
const T2 = rite(0, '255,240,200', 700);
// Beat 2: a puff of feathers above (pixelfx), Saint1, one feather sinks onto the head over 1300 (sine), then MV heal + Heal3, 700
const top = { x: OXk(tk), y: OYk(tk) - hgtK(tk) * 1.15 };
pxClip('pxfx_nox_feather', T2, top, { scale: s * 1.1 });
S_(T2, 'saint1', 0.35);
const LAND = fly(T2, top, headOf(tk), { ms: 1300, ease: X.sine, z: 45, draw: (g, age) => {
  g.globalCompositeOperation = 'source-over'; g.rotate(Math.sin(age / 260) * 0.6); g.fillStyle = '#fff6e0'; g.beginPath(); g.ellipse(0, 0, 14, 4, 0, 0, 7); g.fill();
  g.strokeStyle = 'rgba(200,160,90,.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-14, 0); g.lineTo(14, 0); g.stroke(); glw(g, 0, 0, 22, '255,230,170', 0.5); } });
fx('041_heal_one_1', LAND, ftOf(tk), { scale: s });
S_(LAND, 'heal3', 0.4);
const T3 = LAND + 700;
// Beat 3: Collapse4 + Darkness5, a 220 ms white flash on the body, then a flat white silhouette for 160 + 420 ms with the
// MV death skull (jade) 160 ms in; the shake and the gate when the silhouette drops; 40 soul motes rise over 1600 ms
S_(T3, 'collapse4', 0.5); S_(T3, 'darkness5', 0.45);
silhouette(tk, T3, 220, '#ffffff', (u) => 0.75 * (1 - X.out(u)));
const WHITE = T3 + 220, SKULL = WHITE + 160, GATE = SKULL + 420;
silhouette(tk, WHITE, GATE - WHITE, '#ffffff', () => 1);
fx('065_death', SKULL, centerOf(tk), { scale: s * 0.7, filter: 'hue-rotate(110deg) saturate(1.4)' });
shake(GATE, 6, 250);
once(GATE, () => oni.hit());
soulRise(GATE, tk, { n: 40, ms: 1600 });
const T4 = GATE + 1200, END = T4 + 600 + 300;
// Beat 4: dim out 600, glow off, lean home 300, 600
dimTrack(tw(0, [[0, 400, 0.35, X.sine], [T4, 600, 0, X.sine]]), T4 + 600);
glowOff(T4);
ROT = tw(0, [[0, 700, leanDeg(-5), X.sine], [T4, 300, 0, X.out]]);
await runShot(Math.max(END, GATE + 1600 + 1500), GATE);
