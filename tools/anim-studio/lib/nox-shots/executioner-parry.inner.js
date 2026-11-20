// ── Parry (passive: even Accuracy result, half damage; approved: part-exec + part-r4 Parry clip + part-r5 size pin).
// LIVE board (no camera work). Played by a play_animation row in the passive's chain: caster = the Executioner (the
// parry's owner); target (optional) = the attacker, only to face the shield toward it. The Executioner's part only:
// the Parry clip (shield thrust forward over the body, knock-back + edge flash on the blow, hold, settle) and, on its
// 'impact' frame, the jade pixelfx parry (X-flash + fan of sparks) at the shield face + Parry and Guard sounds (the gate).
// The mockup's arrow (the stand-in attacker, its shot / glance) and the halved number are not part of this shot.
const C = cfg.t;
const total = C.total;
playPose(0, 'parry', { speed: cfg.pspd, on: {
  impact: (t) => { const s = bodyAt(t); const p = poseAt(s, cfg.shield.x, cfg.shield.y);
    pxfx('pxfx_nox_parry', t, { x: p.x, y: p.y + 30 * KP }, s.d * 0.9, { z: 40 });
    S_(t, 'parry', 0.5); S_(t, 'guard', 0.35); },
} });

await runShot(total, C.gate);
