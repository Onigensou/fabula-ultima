// ── Zero Power: Rebellious Wing (mockup b1 + r3 energy wings + r4 dragon/bat wings and float frames + r6 afterimages,
// motion blur and the 16-pose wing blur). Cut-in, white flash into the void (everyone else fades, the field near-black),
// she leaps into her mid-air pose (reach), curls in while green strands gather, dragon-bat energy wings unfold in one
// smooth spread, she snaps open on the flare, one big wing beat, flash: the winged battler takes over. FULL-TAKEOVER
// timeline (cfg.live = false): the camera starts on the whole stage, tracks her leap with a lag while pushing in to
// cfg.zoom, holds on her through the wings, and pulls back to the stage on the way back to the field.
// The lasting winged form is NOT painted here: it is the status sprite (poseArt) on the real token after the run.
const C = cfg.t, WING = cfg.wingRgb || '120,255,140';
const G = 'brightness(1.3) sepia(1) hue-rotate(80deg) saturate(3)';
// ── her body ──
const poseT = steps('idle', [[C.leap, 'jump'], [C.reach, 'reach'], [C.strands, 'curl'], [C.flare, 'release'], [C.form, 'winged']]);
const airT = tw(0, [[C.leap, cfg.leapMs, 330, X.outCubic], [C.leap + cfg.leapMs, cfg.follow, 210, X.sine], [C.back, 520, cfg.hover, X.sine],
  [C.gate, 500, cfg.hover + 8, X.sine], [C.gate + 500, 500, cfg.hover, X.sine], [C.gate + 1000, 500, cfg.hover + 8, X.sine], [C.gate + 1500, 500, cfg.hover, X.sine],
  [C.gate + 2000, cfg.settle, 0, X.sine]]);
const sxT = tw(1, [[C.squash, 140, 1.1, X.out], [C.leap, 160, 1, X.out], [C.flare, 160, 1.06, X.out], [C.beat, cfg.beat, 1.08, X.out], [C.form, 10, 1, X.out]]);
const syT = tw(1, [[C.squash, 140, 0.85, X.out], [C.leap, 160, 1, X.out], [C.flare, 160, 0.96, X.out], [C.beat, cfg.beat, 0.9, X.out], [C.form, 10, 1, X.out]]);
// the green glow builds over the strands and stays until the form flash; motion blur on the launch and the beat
const glowT = (t) => (t >= C.form ? 0 : X.sine(seg(t, C.strands, C.strands + 700)));
BODY = (t) => {
  const k = glowT(t); let f = '';
  if (k > 0.001) f += 'drop-shadow(0 0 {' + (10 * k).toFixed(2) + '} rgba(' + WING + ',.9)) brightness(' + (1 - 0.25 * k).toFixed(3) + ')';
  if ((t >= C.leap && t < C.leap + cfg.leapMs)) f += ' blur({1.2})';
  else if (t >= C.beat && t < C.beat + cfg.beat + 60) f += ' blur({1.5})';
  return { air: airT(t) * KP, pose: poseT(t), sx: sxT(t), sy: syT(t), filter: f.trim() };
};
afterimages(C.leap, C.leap + cfg.leapMs, 35, 0.55, 420, G);
afterimages(C.leap + cfg.leapMs, C.leap + cfg.leapMs + cfg.follow, 110, 0.25, 600, G);
afterimages(C.unfold, C.unfold + cfg.unfold, 90, 0.3, 500, G);
afterimages(C.beat, C.back, 30, 0.55, 360, G);

// ── screen: white flash into the void, near-black field, everyone else fades; back to the field at the end ──
const total = C.total;
cutin(0, 'cutin');
S_(0, 'burstmax', 0.5); S_(0, 'overdrive', 0.9);
whiteLevel(tw(0, [[C.cutEnd, 120, 1, X.sine], [C.void, 380, 0, X.sine], [C.beat + cfg.beat, 90, 0.85, X.sine], [C.form, 260, 0, X.sine]]), total);
dimLevel(tw(0, [[C.void, 0, 0.95], [C.leap, cfg.leapMs + cfg.follow, 0.6, X.sine], [C.back, 500, 0, X.sine]]), total);
focus(C.void, 10, C.back, 500);

// ── camera (mockup FCAM): per-frame lag follow of her body during the leap + catch-up (the mockup's lerp per frame,
// replayed at 60 fps so every client gets the same path), zoom eased in log space from 1 to cfg.zoom, a 200 ms settle
// onto her, a hold through the wings, a 320 ms pull back to the stage from the return beat ---
const REST = { cx: tl.REST.cx, cy: tl.REST.cy };
const LF = cfg.leapMs + cfg.follow, FR = 1000 / 60, z1 = cfg.zoom, lz = (a, b, e) => Math.exp(lerp(Math.log(a), Math.log(b), e));
const CAMF = [];
{ let cx = REST.cx, cy = REST.cy;
  for (let e = 0; e <= LF + FR; e += FR) { const t = C.leap + Math.min(e, LF), b = bodyMid(bodyAt(t)); cx = lerp(cx, b.x, cfg.lag); cy = lerp(cy, b.y, cfg.lag);
    const zu = X.sine(clamp01((Math.min(e, LF) - cfg.leapMs * 0.4) / (LF - cfg.leapMs * 0.4))); CAMF.push({ cx, cy, zoom: lz(1, z1, zu) }); } }
const CAM_END = CAMF[CAMF.length - 1], HOLD = (() => { const b = bodyMid(bodyAt(C.leap + LF)); return { cx: b.x, cy: b.y, zoom: z1 }; })();
const camAt = (t) => {
  if (t < C.leap) return { cx: REST.cx, cy: REST.cy, zoom: 1 };
  if (t < C.leap + LF) return CAMF[Math.min(CAMF.length - 1, Math.floor((t - C.leap) / FR))];
  if (t < C.leap + LF + 200) { const e = X.out(seg(t, C.leap + LF, C.leap + LF + 200)); return { cx: lerp(CAM_END.cx, HOLD.cx, e), cy: lerp(CAM_END.cy, HOLD.cy, e), zoom: lz(CAM_END.zoom, z1, e) }; }
  if (t < C.back) return HOLD;
  const e = X.outCubic(seg(t, C.back, C.back + 320)); return { cx: lerp(HOLD.cx, REST.cx, e), cy: lerp(HOLD.cy, REST.cy, e), zoom: lz(z1, 1, e) };
};
m.hold(0, total, (t, S) => { S.cam = camAt(t); });

// ── leap ──
S_(C.leap, 'jump2', 0.5); dustBurst(C.leap, kf, { n: 8 });
// ── energy strands (kept from the shipped script: green strands + ChargingA) ──
S_(C.strands, 'charging', 0.5);
fx('strand', C.strands, bodyMid(bodyAt(C.strands)), 1.3, { z: 22 });

// ── dragon / bat energy wings: arm (shoulder, elbow, wrist), four finger bones, a scalloped membrane; translucent energy
// with bright bones; every pose of the last 16 frames is drawn softer behind (motion blur) ──
const D = cfg.unfold;
const wingAt = (t) => {
  const te = X.sine(seg(t, C.unfold, C.unfold + D));
  return { g: X.outCubic(Math.min(1, te * 1.15)), open: X.sine(clamp01((te - 0.1) / 0.9)), solid: X.out(seg(t, C.flare, C.flare + 260)), beat: X.in(seg(t, C.beat, C.beat + cfg.beat)) };
};
function drawWings(g, s, st, k) {
  const b = boxOf(s), Sc = b.h / 170 * 1.45 * st.g; if (Sc < 0.02) return; const L0 = st.solid;
  for (const side of [-1, 1]) {
    const sh = { x: b.x + side * b.w * 0.08, y: b.bottom - b.h * 0.66 };
    const up = lerp(-1.25, -0.55, st.open) + st.beat * 0.95, spread = lerp(0.15, 1, st.open);
    const rot = (ang) => ({ x: Math.cos(ang) * side, y: Math.sin(ang) });
    const e1 = rot(up), el = { x: sh.x + e1.x * 46 * Sc, y: sh.y + e1.y * 46 * Sc };
    const e2 = rot(up - 0.5 * spread + st.beat * 0.3), wr = { x: el.x + e2.x * 54 * Sc, y: el.y + e2.y * 54 * Sc };
    const fingers = [0, 1, 2, 3].map((i) => { const ang = up - 0.7 * spread + i * (0.55 + 0.2 * spread) * spread + 0.35 + st.beat * (0.4 + i * 0.1); const L = [92, 104, 86, 62][i] * Sc * lerp(0.55, 1, spread); const d = rot(ang); return { x: wr.x + d.x * L, y: wr.y + d.y * L }; });
    const root = { x: sh.x - side * 4 * Sc, y: sh.y + 58 * Sc };
    g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = k;
    g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(el.x, el.y); g.lineTo(wr.x, wr.y); g.lineTo(fingers[0].x, fingers[0].y);
    for (let i = 1; i < 4; i++) { const p0 = fingers[i - 1], p1 = fingers[i]; const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2; g.quadraticCurveTo(lerp(mx, wr.x, 0.35), lerp(my, wr.y, 0.35), p1.x, p1.y); }
    const pl = fingers[3]; g.quadraticCurveTo(lerp((pl.x + root.x) / 2, wr.x, 0.3), lerp((pl.y + root.y) / 2, wr.y, 0.3), root.x, root.y); g.closePath();
    const gr = g.createRadialGradient(wr.x, wr.y, 4 * KP, wr.x, wr.y, 120 * Sc); gr.addColorStop(0, 'rgba(210,255,220,' + (0.24 + 0.22 * L0) + ')'); gr.addColorStop(0.55, 'rgba(' + WING + ',' + (0.14 + 0.14 * L0) + ')'); gr.addColorStop(1, 'rgba(' + WING + ',.05)');
    g.fillStyle = gr; g.shadowColor = 'rgba(' + WING + ',1)'; g.shadowBlur = fpx(g, 18 + 16 * L0); g.fill();
    g.strokeStyle = 'rgba(' + WING + ',' + (0.5 + 0.3 * L0) + ')'; g.lineWidth = 1.3 * KP; g.stroke();
    g.shadowBlur = 0; g.strokeStyle = 'rgba(230,255,235,' + (0.55 + 0.4 * L0) + ')'; g.lineWidth = 2.2 * KP; g.lineCap = 'round'; g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(el.x, el.y); g.lineTo(wr.x, wr.y); g.stroke();
    g.lineWidth = 1.3 * KP; for (const f of fingers) { g.beginPath(); g.moveTo(wr.x, wr.y); g.lineTo(f.x, f.y); g.stroke(); }
    glw(g, wr.x, wr.y, 10 * Sc + 4 * KP, '220,255,230', 0.7); g.restore();
  }
}
// behind her: the ground layer (under the real tokens; she is painted above it)
m.hold(C.unfold, C.form, (e, S) => { const t = e + C.unfold; S.world.push({ z: 3, draw: (g) => {
  for (let i = 15; i >= 1; i--) { const th = t - i * 16.7; if (th < C.unfold) continue; drawWings(g, bodyAt(th), wingAt(th), 0.2 * Math.pow(1 - i / 16, 1.5)); }
  drawWings(g, bodyAt(t), wingAt(t), 1); } }); });
S_(C.unfold, 'wind7', 0.45);
for (let kk = 1; kk <= 8; kk++) { const te = 0.12 * kk + 0.001; if (te >= 1) break; const at = C.unfold + D * Math.acos(1 - 2 * te) / Math.PI; twinkles(at, bodyMid(bodyAt(at)), { n: 2, r: 90 * X.outCubic(Math.min(1, te * 1.15)) + 20, rgb: WING }); }
S_(C.unfold + D * Math.acos(1 - 2 * 0.7) / Math.PI, 'magic4', 0.4);
// ── flare: arms flung wide, the energy brightens ──
twinkles(C.flare, bodyMid(bodyAt(C.flare)), { n: 18, r: 150, rgb: WING }); S_(C.flare, 'flash2', 0.35);
// ── wing beat -> form ──
S_(C.beat, 'wind1', 0.6);
const BH = C.beat + cfg.beat;
feathersOut(BH, bodyMid(bodyAt(BH)), { n: 22, rgb: '210,255,220', spread: 0.5 }); twinkles(BH, bodyMid(bodyAt(BH)), { n: 16, r: 200, rgb: WING });
shake(BH, 8, 300); S_(BH, 'execution', 0.6);

await runShot(total, C.gate);
