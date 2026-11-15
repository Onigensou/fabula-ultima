// ── Jump / Skyfall Dive / Dragonfire Dive: guest Kalina's dive code and numbers (GUEST cfg, mockup r3), mirrored for
// her side, with the new sprites (r4: dive-landing on the way down and on impact, the float pose on the arc home;
// r6: her battle sprite again the moment she touches down, then the slide). cfg.move = 'jump' | 'skyfall' | 'dragonfire'.
// The token contract kept from the shipped Jump / Skyfall Dive: Jump leaves her token at alpha 0 (hidden while Flying,
// persisted on the TokenDocument by one GM); Skyfall Dive starts hidden and sets it back to 1 when she lands.
const MOVE = cfg.move, G = cfg.guest;
const top = viewTop();
const liftOff = (y) => (y - top) + 340 * KP;                 // mockup OY(t) + 340: from her floor row to above the frame
let total = 0, gate = 0;

if (MOVE === 'jump') {
  // a quick crouch (squash to 80 %), then she launches off the top of the frame
  const C0 = G.squashMs, C1 = C0 + G.holdMs, C2 = C1 + G.releaseMs, UP = C2 + G.upMs;
  const syT = tw(1, [[0, G.squashMs, G.squash, X.outCubic], [C1, G.releaseMs, 1, X.inCubic]]);
  const airT = tw(0, [[C2, G.upMs, liftOff(kf.y), X.outCubic]]);
  BODY = (t) => ({ sy: syT(t), air: airT(t), hidden: t >= UP });
  S_(C2, 'jump2', 0.5); dustBurst(C2, kf, { n: 8 });
  // hidden while Flying: every client drops its mesh to 0 as she leaves the frame, one GM persists it
  once(UP, () => tokenAlpha(caster, 0));
  gate = UP; total = UP + 400;
}

if (MOVE === 'skyfall' || MOVE === 'dragonfire') {
  const winged = MOVE === 'dragonfire';
  const tk = FOES[0] || null;
  // Skyfall: she is already up there (hidden since Jump), a hold in the sky. Dragonfire: take off in the winged form first.
  let D0 = G.peakMs, airUp = null;
  if (winged) { const up = tw(0, [[0, G.upMs, liftOff(kf.y), X.outCubic]]); airUp = (t) => up(t); D0 = G.upMs + Math.round(G.peakMs * 0.6); S_(0, 'wind1', 0.5); }
  if (!tk) {
    // no target: nothing to dive at; bring her back as she is
    BODY = (t) => (winged ? { pose: 'winged', air: airUp(t), hidden: t >= G.upMs } : { hidden: true });
    if (!winged) once(0, () => tokenAlpha(caster, 1));
    total = winged ? G.upMs + 300 : 300; gate = total;
  } else {
    const tf = ftOf(tk), home = { x: kf.x, y: kf.y };
    const startX = tf.x - DIR * G.lateral * KP, hitX = tf.x - DIR * 30 * KP;
    const IMP = D0 + G.diveMs, BACK0 = IMP + 140, LAND = BACK0 + G.backMs, SLID = LAND + G.slideMs, STOP = SLID + G.ghosts * G.lagMs + 60;
    const landX = lerp(tf.x, home.x, G.landFrac), l0 = liftOff(tf.y);
    const pDown = winged ? 'winged' : 'diveland', pBack = winged ? 'winged' : 'jump', pLand = winged ? 'winged' : 'idle';
    BODY = (t) => {
      if (t < D0) return winged ? { pose: 'winged', air: airUp(t), hidden: t >= G.upMs } : { hidden: true };
      if (t < IMP) { const u = X.inCubic(seg(t, D0, IMP)); return { pose: pDown, x: lerp(startX, hitX, u), y: tf.y, air: lerp(l0, 0, u) }; }
      if (t < BACK0) return { pose: pDown, x: hitX, y: tf.y };
      if (t < LAND) { const u = seg(t, BACK0, LAND); return { pose: pBack, x: lerp(hitX, landX, u), y: lerp(tf.y, home.y, u), air: G.apex * 4 * u * (1 - u) * KP }; }
      return { pose: pLand, x: lerp(landX, home.x, X.outCubic(seg(t, LAND, SLID))), y: home.y };
    };
    // five-ghost blue-to-black trail from the dive start until she settles
    TRAILS.push({ t0: D0, t1: SLID, n: G.ghosts, lag: G.lagMs, op: G.ghostA, pose: pDown });
    S_(D0, 'wind7', 0.5);
    const tc = center(tk);
    if (!winged) {
      fx('impact10', IMP, tc, 1.4, { z: 40 }); S_(IMP, 'hitslashb', 0.7); shake(IMP, 10, 300);
    } else {
      const tb = boxB(tk), th = TOK[tk].h;
      fx('fireball', IMP, { x: tf.x, y: tb - th * 0.35 }, 1.5, { z: 40 });
      fx('bomb', IMP, tf, 1.2, { z: 41, add: true });
      fx('bombBottom', IMP, tf, 1.2, { z: 3, add: true });
      flashC(IMP, '#ffb060', 0.5, 30, 260); shake(IMP, 22, 520); ring(IMP, tf, { rgb: '255,160,60', r1: 320, w: 12, ms: 700 });
      for (let i = 0; i < 26; i++) ember(IMP, tf.x + rnd(-120, 120) * KP, tf.y - rnd(0, 120) * KP, '255,140,50', { vy: -rnd(0.1, 0.3), r: rnd(3, 7) });
      S_(IMP, 'explosion2', 0.7); S_(IMP, 'fire3', 0.5);
    }
    // the contact: the game shows the hurt, the flinch and the numbers (splash targets included)
    once(IMP, () => oni.hit());
    // feet on the ground: battle sprite again, a puff of dust, then the slide home; Skyfall hands her back to the token
    dustBurst(LAND, { x: landX, y: home.y }, { n: 6 });
    if (!winged) once(LAND, () => tokenAlpha(caster, 1));
    gate = STOP; total = STOP + (winged ? 500 : 300);
  }
}

await runShot(total, gate);
