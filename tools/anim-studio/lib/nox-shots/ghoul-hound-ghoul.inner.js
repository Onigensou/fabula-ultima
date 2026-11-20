// ── Nox Ghoul: Grave Claw / Poison Blade / Counter when enemy Healed (mockup part-ghoul-hound.js + r2: no monster
// growls). cfg.move = 'graveclaw' | 'poisonblade' | 'counterheal'; cfg.t = the beat schedule (ms) from the signatures
// file (the same numbers set the damage gate there). Not ported (the game draws them): damage numbers, the Bleed /
// Poisoned status beat icons, the target's hurt flinch, the Envenomed tint loop, Keren's heal beat (Counter).
// Counter when enemy Healed is the TELL only (smell / glint / glow, undim, back to idle): its passive chain is
// [play_animation Counter when enemy Healed, free_action Grave Claw], and the free Grave Claw plays its own animation.
const MOVE = cfg.move, tt = cfg.t || {};
const tk = FOES[0];
if (!tk && MOVE !== 'counterheal' && MOVE !== 'onthehunt') { oni.fireDone(); return; }   // the tells play without a target too
const BLOOD = '170,20,28', VENOM = '120,220,90', JADE = '95,224,180';
let total = 0, gate = 0;
const POST = [];   // fx / particles placed after finishBody() (they read the body's position)

// mockup graveClawOn(t, { fast }): c = the claw's schedule (start, dash, hop, rock, rockMs, swing, hit, back, end)
function graveClaw(c) {
  moveTo(c.start, c.dash, frontOf(tk, 78), X.quad, c.hop);
  ROT.push([c.rock, c.rockMs, L(-9), X.out], [c.swing, 90, L(12), X.out], [c.back, 160, 0, X.out]);
  POST.push(() => {
    S_(c.swing, 'swingC', 0.45);
    const dt = dT(tk);
    pxfx('pxfx_nox_claw', c.swing, { x: TOK[tk].x - 6 * DIR * KP * dt, y: OYt(tk) - TOK[tk].h * 0.25 }, 1.5, { flip: DIR < 0 });
    // land(): the slash sound + the game's hit feedback (its number / flinch are the game's)
    S_(c.hit, 'slashL', 0.5); once(c.hit, () => oni.hit()); S_(c.hit, 'blowM', 0.35);
    const b = tbox(tk);
    for (let i = 0; i < 12; i++) { const r = rnd(1.5, 3);
      part({ t0: c.hit, life: rnd(500, 800), x: b.x + rnd(-12, 12) * KP, y: b.bot - b.h * rnd(0.4, 0.6), vx: rnd(0.05, 0.22) * DIR, vy: -rnd(0.05, 0.18), g: 0.0011, layer: 'field', comp: 'source-over',
        draw: (g, x, y, u) => { g.fillStyle = 'rgba(' + BLOOD + ',' + (1 - u) + ')'; g.beginPath(); g.arc(x, y, r * KP, 0, 6.2832); g.fill(); } }); }
  });
}
// mockup bleedCue(t): Darkness1 + the wound keeps dripping (the status beat icon is the game's)
function bleedCue(at) { S_(at, 'darkness1', 0.3, 1.2); drip(at, () => tbox(tk), BLOOD, 12, 900); }

if (MOVE === 'graveclaw') {
  graveClaw(tt.claw);
  moveTo(tt.home, 520, kf, X.quad, 10);
  finishBody(); for (const f of POST) f();
  bleedCue(tt.bleed);
  gate = tt.gate; total = tt.end + 600;
}

if (MOVE === 'poisonblade') {
  // the mockup's 'Target already Poisoned?' toggle = the target's real status when the shot starts
  const env = cfg.pois != null ? cfg.pois === 1 : hasStatus(targets[0], ['poisoned', 'poison', 'envenomed']);
  const home = tt.status + (env ? 1300 : 900);
  // venom wells: glow, drips off the blade, a slow squash
  FILT.push([0, glowF(VENOM, 6)], [tt.status, '']);
  SX.push([0, 500, 0.96, X.sine], [tt.rock, 100, 1, X.out]); SY.push([0, 500, 1.05, X.sine], [tt.rock, 100, 1, X.out]);
  // lunge (green afterimages), then the overhead chop
  moveTo(tt.lunge, 360, frontOf(tk, 80), X.quad, 0);
  ROT.push([tt.rock, 160, L(-16), X.out], [tt.swing, 90, L(18), X.out], [tt.back, 200, 0, X.out]);
  moveTo(home, 520, kf, X.quad, 10);
  finishBody();
  S_(0, 'liquid', 0.45); S_(0, 'poison', 0.3);
  drip(0, cbox, VENOM, 14, 1100);
  S_(tt.lunge, 'swingC', 0.45); afterimages(tt.lunge, tt.rock, 45, 0.45, 120);
  S_(tt.swing, 'sword5', 0.5);
  crescent(tt.swing, center(tk), { ang: 1.25, len: 150, w: 22, rgb: VENOM, ms: 300 });
  pxfx('pxfx_nox_acid', tt.hit, floorOf(tk), 1.4);
  fx('059_poison', tt.hit, center(tk), 0.8);
  S_(tt.hit, 'slashL', 0.5); once(tt.hit, () => oni.hit()); S_(tt.hit, 'water3', 0.4); shake(tt.hit, 8, 260);
  // Poisoned / Envenomed (the status icon and the Envenomed tint are the game's)
  S_(tt.status, 'cpoison', 0.4);
  if (env) {
    const hold = 1300 + 500;
    pxfx('pxfx_nox_puddle', tt.status, floorOf(tk), 1.1, { under: true, loop: true, hold, alpha: (u) => { const e = u * hold; return e < 1300 ? 1 : 1 - X.sine(clamp01((e - 1300) / 500)); } });
    fx('059_poison', tt.status, center(tk), 1);
  } else fumes(tt.status, tbox(tk), VENOM, 10);
  gate = tt.gate; total = home + 520 + 600;
}

if (MOVE === 'counterheal') {
  // TELL ONLY. Chain: [play_animation Counter when enemy Healed, free_action Grave Claw]; the free Grave Claw plays
  // its own animation right after this gate. tk = the healed enemy (only used to face it). No strike, no oni.hit.
  // it smells it: dim, squash, head snaps round, jade glint in the eye socket + jade glow; then undim, back to idle
  dimLevel(tw(0, [[0, 250, 0.25, X.sine], [tt.undim, 400, 0, X.sine]]), tt.end);
  SX.push([0, 90, 1.06, X.out], [tt.undim, 400, 1, X.out]); SY.push([0, 90, 0.94, X.out], [tt.undim, 400, 1, X.out]);
  ROT.push([0, 90, L(-6), X.out], [90, 90, L(4), X.out], [180, 120, 0, X.out]);
  FILT.push([90, glowF(JADE, 5)], [tt.end, '']);
  finishBody();
  twinkles(90, headOf(cbox(90)), { n: 3, r: 6, rgb: JADE });
  gate = tt.end; total = tt.end;
}

await runShot(total, gate);
