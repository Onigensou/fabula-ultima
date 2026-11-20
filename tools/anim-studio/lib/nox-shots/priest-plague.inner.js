// ── Zombie Plague (spec zombieplague.md): the tome opens, a miasma rolls across the floor, the check (grave hands on who
// fails, a pale ring on who resists), the fog thins. LIVE board.
// Who fails: the save (DL13 MIG+WLP) is rolled AFTER the animation (zp_save, interactive), so the shot cannot know. It
// plays the mockup's default branch: the targets in cfg.failIdx (party order; mockup "Zarg + Keren" = 2nd and 3rd).
// A target that is ALREADY Zombie'd counts as failing too. The Zombie tint itself is the game's status, not drawn here.
// Beat 1: fdim .4 / 500, Spook + Darkness3, rite (jade) 800
S_(0, 'spook', 0.4); S_(0, 'darkness3', 0.35);
const T2 = rite(0, JADE, 800);
// Beat 2: four waves of pixelfx miasma from the Priest to the party (380 ms apart), haze puffs; two more patches at the feet of
// the two targets the waves reach least (mockup: Zarg and Blanche), then 500 ms
const c = PARTY_C();
S_(T2, 'wind4', 0.35, 0.7);
const FOG = [];
const fogAt = (at, p, scale, op) => FOG.push({ at, p, scale, op });
const waves = [];
for (let i = 0; i < 4; i++) { const u = (i + 1) / 4; const p = { x: lerp(kf.x + DIR * 80 * KP, c.x, u), y: lerp(kf.y, c.y, u) + 20 * KP }; const s = depthAt(p.x, p.y);
  waves.push(p); fogAt(T2 + i * 380, p, s * 2.2, 0.95); haze(T2 + i * 380, p, { s }); }
const T2b = T2 + 4 * 380;
const far = FOES.map((k) => { const f = ftOf(k); return { k, d: Math.min.apply(null, waves.map((w) => Math.hypot(w.x - f.x, w.y - f.y))) }; }).sort((a, b) => b.d - a.d).slice(0, 2);
for (const o of far) { const s = sOf(o.k); fogAt(T2b, ftOf(o.k), s * 1.8, 0.9); haze(T2b, ftOf(o.k), { s, n: 6 }); }
const T3 = T2b + 500;
// Beat 3: the check, target by target: fail = grave hands (pixelfx, Nox jade) + Water1 (x.8), 380 ms later Darkness2; pass = a
// pale ring + Evasion1. 220 ms between targets; the gate after the last one.
const FAIL = new Set((cfg.failIdx || []).map((i) => FOES[i]).filter(Boolean));
FOES.forEach((k, i) => { if (hasStatus(RAW[i], 'zombie')) FAIL.add(k); });
let t = T3;
for (const k of FOES) {
  const f = ftOf(k), s = sOf(k);
  if (FAIL.has(k)) { pxClip('pxfx_nox_hands', t, f, { scale: s * 1.25, z: 1002 }); S_(t, 'water1', 0.3, 0.8); t += 380; S_(t, 'darkness2', 0.35); }
  else { ring(t, f, { rgb: '235,245,255', r0: 20, r1: 110 * s, ms: 500, w: 4 }); S_(t, 'evade', 0.3); }
  t += 220;
}
const GATE = t, T4 = GATE + 700;
// Beat 4: the fog fades over 900, dim out 800, glow off, lean home 300, 700
for (const fg of FOG) pxClip('pxfx_nox_miasma', fg.at, fg.p, { scale: fg.scale, sy: 2.4, loop: true, z: 3, opacity: fg.op, fadeAt: T4, fadeMs: 900 });
dimTrack(tw(0, [[0, 500, 0.4, X.sine], [T4, 800, 0, X.sine]]), T4 + 800);
glowOff(T4);
ROT = tw(0, [[0, 800, leanDeg(-5), X.sine], [T4, 300, 0, X.out]]);
const END = Math.max(T4 + 1000, T4 + 900, GATE + 2800);
await runShot(END, GATE);
