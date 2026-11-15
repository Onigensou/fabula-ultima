// ── Geist · Torcleaver (the SHIPPED script, CFG as shipped, + upkeep and the approved changes) ──
// Dash 22 % toward the target (160 ms, outCubic; depth-scaled by the engine) -> the JB2A TrailAttack05 slash
// beside him -> the crescent (pixelfx pxfx_dark_crescent, ~2.2x the shipped lune) flies to the target turned
// along its path (360 ms, inQuad, alpha 1 -> .7) -> impact: small pxfx_dark_plasma, the shipped particle
// burst, shake, the target's hurt + flinch + clone jitter -> dash home (300 ms). Gate at the END, as shipped.
// Sounds (added, none in the original): SwingA on the dash; SwingF + HitSlashL on the cut; Wind7 in flight;
// Darkness4 + HitBlowL on impact.
const tk = FOES[0];
const c0 = center('k'), tc = center(tk), tf = feet(TOK[tk]);
const DASH = cfg.dashMs, FLY = DASH + cfg.waveTravelMs, HOME = FLY + cfg.shakeMs, BACK = HOME + cfg.homeMs;
const dF = { x: lerp(kf.x, tf.x, cfg.dashFrac), y: lerp(kf.y, tf.y, cfg.dashFrac) };
const d = { x: lerp(c0.x, tc.x, cfg.dashFrac), y: lerp(c0.y, tc.y, cfg.dashFrac) };
KMOVE = pathOf([
  { t0: 0, t1: DASH, from: kf, to: dF, ease: E.outC },
  { t0: HOME, t1: BACK, from: dF, to: kf, ease: E.outQ },
]);
S_(0, 'swingA', 0.45);
// slash flourish beside him (toward the target side), square-stretched as the shipped playWebm did
fx('trail05', DASH, { x: d.x + DIR * cfg.slashSideDist, y: d.y }, cfg.slashSize, { z: 40, sy: 800 / 600 });
S_(DASH, 'swingF', 0.55); S_(DASH, 'slashL', 0.4); S_(DASH + 60, 'wind7', 0.45);
// the crescent: front + light layers, looping, moved and rotated toward the target
const ang = Math.atan2(tc.y - d.y, tc.x - d.x);
const crW = CL.pxfx_dark_crescent_front ? CL.pxfx_dark_crescent_front.w * cfg.crescentScale * 0.55 : 0;
const crLive = () => (tt) => { const v = E.inQ(Math.min(1, tt / cfg.waveTravelMs)); return { x: lerp(d.x, tc.x, v), y: lerp(d.y, tc.y, v), w: crW, rot: ang }; };
const crAlpha = (u) => 1 - 0.3 * u * u;
fx('pxfx_dark_crescent_front', DASH, d, crW, { z: 44, loop: true, hold: cfg.waveTravelMs, live: crLive(), alpha: crAlpha });
fx('pxfx_dark_crescent_light', DASH, d, crW, { z: 45, loop: true, hold: cfg.waveTravelMs, live: crLive(), alpha: crAlpha, add: true, filter: LUMA_FILTER });
// impact
S_(FLY, 'darkness4', 0.55); S_(FLY, 'blowL', 0.45);
pxfx('pxfx_dark_plasma', FLY, tc, (CL.pxfx_dark_plasma_front ? CL.pxfx_dark_plasma_front.w : 672) * 0.55 * cfg.plasmaScale);
burst(FLY, tc, cfg.hitParticles, cfg.particleSpread, cfg.particleMs, '190,90,255');
m.shake(FLY, cfg.shakeMs, cfg.shakeIntensity);
hurtOn(tk, FLY, 'strong', { hold: 700, jitter: 12, jitterMs: cfg.shakeMs });
once(FLY, () => oni.hit({ numbersOnly: true }));
const total = Math.max(BACK + 400, FLY + (CL.pxfx_dark_plasma_front ? CL.pxfx_dark_plasma_front.dur : 0), DASH + (CL.trail05 ? CL.trail05.dur : 0));
await go(total, cfg.gateAtContact ? FLY : BACK);
