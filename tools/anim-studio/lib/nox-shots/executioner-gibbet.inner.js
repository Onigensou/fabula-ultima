// ── Nox Gibbet (approved: part-exec chain/drop + part-r4 camera/Slash clip + part-r5 v3 stance and sync). FULL TAKEOVER.
// Float in (camera follows), a jade soul-chain hooks the target, he is hoisted 50 px (camera closes in) while the sword
// winds up; then the jade pixelfx sword-slash on his body, the scythe reap behind it and the sword's smear frame all
// start on the SAME frame (through his body); contact frame -> camera punch, impact frame, shards (the damage gate).
// Execute (the target already in Crisis, read from his HP now): bigger slash/reap, a flash, more shards and shake.
// The chain snaps, he drops, the camera eases out, it floats home.
const C = cfg.t;
const tk = FOES[0];
if (!tk) { oni.fireDone(); return; }
const OXz = OXk(tk), OYz = OYk(tk), Hz = hgtk(tk), Sz = sOf(tk);
const total = C.total;
await loadPoses(tk, ['hurt']);
// Execute: already in Crisis (HP <= half of max) before this hit lands
const ex = (() => { try { const p = targets[0].actor.system.props; const hp = Number(p.current_hp), mx = Number(p.max_hp); return hp > 0 && mx > 0 && hp * 2 <= mx; } catch (e) { return false; } })();

// his lift: hoisted 50 px (outCubic 420) on the wind-up, dropped (EASE.in 260) when the chain snaps
const ZL = tw(0, [[C.b2, 420, 50, X.outCubic], [C.b4, 260, 0, X.in]]);
const zLift = (t) => ZL(t) * KP;
tokTrack(tk, total, (q, t) => { const l = zLift(t); if (l > 0.01) q.air = (q.air || 0) + l; });

// ── Beat 1: Float + chain ──
const s0 = bodyAt(0);
camFollow(0, C.b1End, 1.12);
heavyStep(0, slashStance(s0, tk, cfg.stanceCx, 6), 800);
S_(C.b1End, 'shing', 0.4); S_(C.b1End, 'swingA', 0.4);
// the chain: hand -> his upper body, dashed jade line + a glow at the hook, until it snaps at beat 4
part({ t0: C.b1End, life: C.b4 - C.b1End, x: 0, y: 0, layer: 'hit', pos: () => ({ x: 0, y: 0 }), draw: (g, x, y, u, age, p, t) => {
  const a = handOf(bodyAt(t)), b = { x: OXz, y: OYz - zLift(t) - Hz * 0.78 };
  g.strokeStyle = 'rgba(' + JADE + ',.9)'; g.lineWidth = 3 * KP; g.setLineDash([9 * KP, 5 * KP]); g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo((a.x + b.x) / 2, Math.min(a.y, b.y) - 40 * KP, b.x, b.y); g.stroke(); g.setLineDash([]); glw(g, b.x, b.y, 18 * KP, JADE, 0.7); } });
flinchOn(tk, C.b2, 'normal', true, total);    // hitReact(ZARG) on the hook

// ── Beat 2: Hoist + wind-up ──
S_(C.b2, 'wind7', 0.3);
{ const s = bodyAt(C.b2); camTo(C.b2, { x: lerp(s.x, OXz, 0.6), y: OYz - 50 * KP - Hz * 0.6, z: cfg.zin }, 600, X.sine); }
const upEnd = playPose(C.b2, 'slash', { to: 2, hold: true, speed: cfg.pspd });
{ const s = bodyAt(upEnd); const p = poseAt(s, cfg.raised.x, cfg.raised.y); pxfx('pxfx_nox_soulfire', upEnd, { x: p.x, y: p.y + 40 * KP }, s.d * 0.7, { loop: true, until: C.b3, fade: 100, z: 22 }); }

// ── Beat 3: Slash through him (slash + reap + smear on one frame; contact = DAMAGE GATE) ──
const bodyZ = (t) => ({ x: OXz, y: OYz - zLift(t) - Hz * 0.5 });
{ const b0 = bodyZ(C.b3);
  pxfx('pxfx_nox_swordslash', C.b3, { x: b0.x - 60 * Sz * KP * DIR, y: b0.y + 40 * Sz * KP }, Sz * (ex ? 1.5 : 1.2), { z: 26 });
  pxfx('pxfx_nox_reap', C.b3, { x: OXz - 30 * KP * DIR, y: OYz - zLift(C.b3) + 20 * KP }, Sz * (ex ? 1.9 : 1.5), { z: 3, zBack: 2 }); }
playPose(C.b3, 'slash', { from: 3, speed: cfg.pspd, on: {
  smear: (t) => S_(t, 'swingC', 0.55),
  contact: (t) => { const b = bodyZ(t);
    camTo(t, { x: b.x, y: b.y, z: cfg.punch }, 90, X.outCubic);
    impactFrame(t, [{ k: tk, lift: zLift }]); if (ex) flashC(t, '#d8fff0', 0.4, 30, 250);
    HIT(t); flinchOn(tk, t, 'normal', true, total); S_(t, 'crit', 0.55); S_(t, 'slashL', 0.5);
    shards(t, b, JADE_HOT, ex ? 22 : 14, 0.45); shake(t, ex ? 16 : 10, 360); },
} });

// ── Beat 4: Drop + back (chain snaps, he drops, dust, camera eases out, it floats home) ──
camHome(C.b4, 900);
S_(C.b4, 'break', 0.35);
dustBurst(C.b4 + 260, feetk(tk), { n: 10, s: Sz }); S_(C.b4 + 260, 'downc', 0.4);
heavyStep(C.b4 + 260 + 300, { x: HB.x, y: HB.y }, 800);

await runShot(total, C.gate);
