// ── Nox Hound: Rending Fangs / Zombie Bite / On the Hunt (mockup part-ghoul-hound.js + r2 / r4: Rending Fangs and
// Zombie Bite bite with Monster1, On the Hunt keeps the dog bark; no growls). cfg.move = 'rendingfangs' |
// 'zombiebite' | 'onthehunt'; cfg.t = the beat schedule (ms) from the signatures file. Not ported (the game draws
// them): damage numbers, the Zombie status beat + corpse-green tint, the target's hurt flinch, On the Hunt's
// stand-in "Zarg drops into Crisis" beat. On the Hunt is the TELL only (howl / lean / red glint): its passive chain is
// [play_animation On the Hunt, free_action Rending Fangs], and the free Rending Fangs plays its own animation.
const MOVE = cfg.move, tt = cfg.t || {};
const tk = FOES[0];
if (!tk && MOVE !== 'counterheal' && MOVE !== 'onthehunt') { oni.fireDone(); return; }   // the tells play without a target too
const VENOM = '120,220,90';
let total = 0, gate = 0;

// mockup bite(t, { s, rgb }): the bark / Monster1 + the drawn jaw snap, 130 ms later MV 011 pierce + the hit, 70 ms hitstop
function bite(at, k, o) { o = o || {};
  if (o.dog) S_(at, 'dog', 0.35, 1.1); else S_(at, 'monster1', 0.4);
  jawSnap(at, center(k), { s: (o.s || 1) * dT(k), glowRgb: o.rgb || '255,255,255' });
  fx('011_pierce_physical', at + 130, center(k), 0.7);
  S_(at + 130, 'hitpierceb', 0.45); once(at + 130, () => oni.hit());
  return at + 200;
}

if (MOVE === 'rendingfangs') {
  // Chain 2: first target, then the second (the AI's two picks); one target only = both bites on it
  const t1 = FOES[0], t2 = FOES[1] || FOES[0], d = cfg.dash;
  SX.push([0, 260, 1.1, X.out], [tt.dash1, 90, 0.9, X.out], [tt.bite1, 80, 1, X.out]);
  SY.push([0, 260, 0.86, X.out], [tt.dash1, 90, 1.08, X.out], [tt.bite1, 80, 1, X.out]);
  moveTo(tt.dash1, d, frontOf(t1, 70), X.quad, 0);
  moveTo(tt.spring, d + 80, frontOf(t2, 70), X.quad, 46);
  moveTo(tt.gate, 460, kf, X.quad, 34);
  finishBody();
  dustBurst(260, { x: kf.x, y: kf.y - 4 * KP }, { n: 6, s: 1 });
  S_(tt.dash1, 'evade', 0.4); afterimages(tt.dash1, tt.bite1, 35, 0.5, 150);
  bite(tt.bite1, t1);
  S_(tt.spring, 'jump1', 0.35); afterimages(tt.spring, tt.bite2, 35, 0.5, 150);
  bite(tt.bite2, t2);
  gate = tt.gate; total = tt.end + 600;
}

if (MOVE === 'zombiebite') {
  // stalk in low and slow, drooling; latch, head shake while rot seeps in; let go
  SX.push([0, 300, 1.06, X.out], [tt.bite, 80, 1, X.out]); SY.push([0, 300, 0.9, X.out], [tt.bite, 80, 1, X.out]);
  moveTo(0, 900, frontOf(tk, 70), X.quad, 0);
  // the shake: the mockup added sin(u * 10 PI) * 2.5 px to the hound's x every frame (60 fps) for 600 ms
  const J0 = tt.latch, J1 = tt.latch + 600, FR = 1000 / 60;
  JIT = (t) => { if (t < J0 || t >= J1) return 0; const n = Math.floor((t - J0) / FR); let s = 0; for (let i = 1; i <= n; i++) s += Math.sin(Math.min(1, i * FR / 600) * Math.PI * 10); return s * 2.5 * KP * DIR; };
  moveTo(tt.zombie, 520, kf, X.quad, 20);
  finishBody();
  drip(0, cbox, VENOM, 8, 900);
  bite(tt.bite, tk, { s: 1.15, rgb: VENOM });
  fx('059_poison', tt.latch, center(tk), 0.8); S_(tt.latch, 'absorb1', 0.35);
  // the bitten one is shaken with the jaws (choreography, not the hurt flinch)
  m.hold(J0, J1, (e, S) => { const q = S.tok[tk]; if (q) q.dx += Math.sin((e / 600) * Math.PI * 10 + 1) * 3 * KP * DIR; });
  // Zombie: Darkness2 + grave motes rising off them (the status beat and the corpse-green tint are the game's)
  S_(tt.zombie, 'darkness2', 0.4);
  if (cfg.motes !== false) soulRise(tt.zombie, tbox(tk), '130,220,150', 26, 1400);
  gate = tt.gate; total = tt.end + 600;
}

if (MOVE === 'onthehunt') {
  // TELL ONLY. Chain: [play_animation On the Hunt, free_action Rending Fangs]; the free Rending Fangs plays its own
  // animation right after this gate. tk = the enemy that entered Crisis (only used to face it). No strike, no oni.hit.
  // scent + howl: head comes up, red glint, howl (it rings on into the attack and fades 1300 ms in, as in the mockup)
  ROT.push([0, 300, L(-8), X.out], [tt.lookBack, 150, 0, X.out]);
  finishBody();
  S_long(0, 'howl', 0.35, 1.15, 1300);
  twinkles(0, headOf(cbox(0)), { n: 3, r: 6, rgb: '255,70,60' });
  gate = tt.end; total = tt.end;
}

await runShot(total, gate);
