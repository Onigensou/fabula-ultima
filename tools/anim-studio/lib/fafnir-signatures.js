"use strict";
// ============================================================================
// ⭐ Fafnir — bespoke action shots (Valley of the Dragon).
//
// Same storage rules as dungeon-templates.js: exactly two backticks per
// generated file, and NEVER a backtick anywhere inside the inner — one in a
// comment closes the String.raw template early and breaks the outer parse.
//
// Same pacing rule as the rest of the corpus: slow and smooth, quad/sine
// easing. easeInOutCubic reads as a whoosh at any duration.
//
// A dim and a curtain are DIFFERENT TOOLS at different depths:
//   oni.sceneDim  — darkens the SCENE to spotlight the subject. Above the
//                   background and tiles, BELOW tokens and VFX.
//   oni.domFlash  — whiteout / impact curtain, above essentially everything.
// Using a DOM sheet as a dim buries the very thing the shot is about.
//
// Camera moves route through oni.camera, which clamps to the artwork. The zoom
// argument is a MULTIPLE OF REST SCALE and rest framing already contains the
// whole stage, so zoom 1 is a no-op — every pan beat must push past 1 to read.
// ============================================================================

const { shell, inner } = require("./dungeon-templates.js");

/* ── Summon Elemental Drake ──────────────────────────────────────────────── */
//
// EFFORT: low, by direction. The drakes do not exist on the board yet when this
// plays (the summon resolves after the animation gate), so there is nothing to
// animate INTO — the shot is two arrival poofs flanking her, one fire-tinted
// and one bolt-tinted, which is exactly the information the table needs.

function summonDrakes(opts = {}) {
  const cfg = Object.assign({
    flankFrac: 0.62,          // how far out the poofs sit, as a fraction of her sprite width
    riseFrac: 0.10,
    easeInMs: 520,
    poofGapMs: 180,
    poofMs: 760,
    ringSize: 150,
    fireColor: 0xff8a3d, boltColor: 0xb46bff,
    particles: 26, particleRadius: 130, particleSize: 12,
    sfx: null, sfxVol: 0.55,
    totalTimeoutMs: 12000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 94000 });",
    "",
    "// Flank her own sprite rather than the grid square: her token is scaled",
    "// well past 1, so a grid-based offset would drop the poofs on top of her.",
    "const halfW = (caster.mesh && caster.mesh.width ? caster.mesh.width : (caster.w || 100)) * 0.5;",
    "const dx = halfW * cfg.flankFrac;",
    "const dy = -halfW * cfg.riseFrac;",
    "const spots = [",
    "  { x: home.x - dx, y: home.y + dy, color: cfg.fireColor },",
    "  { x: home.x + dx, y: home.y + dy, color: cfg.boltColor },",
    "];",
    "",
    "playSfx('sfx', 'sfxVol');",
    "",
    "async function poof(spot) {",
    "  const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "  const ring = new PIXI.Sprite(glow);",
    "  ring.anchor.set(0.5);",
    "  ring.tint = spot.color;",
    "  ring.blendMode = PIXI.BLEND_MODES.ADD;",
    "  ring.position.set(spot.x, spot.y);",
    "  ring.width = ring.height = 1;",
    "  host.addChild(ring);",
    "  const full = S.wLen(cfg.ringSize);",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.easeInMs, ease: E.outQuad, onUpdate: (v) => {",
    "    ring.width = ring.height = full * v;",
    "    ring.alpha = 0.25 + v * 0.75;",
    "  } });",
    "  oni.particles({ x: spot.x, y: spot.y, count: cfg.particles, color: spot.color,",
    "    size: cfg.particleSize, radius: S.wLen(cfg.particleRadius), life: cfg.poofMs,",
    "    blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "  await oni.tween({ from: 1, to: 0, duration: cfg.poofMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "    ring.alpha = v;",
    "    ring.width = ring.height = full * (1 + (1 - v) * 0.5);",
    "  } });",
    "  try { ring.destroy(); } catch (e) {}",
    "}",
    "",
    "// Staggered, not simultaneous — two poofs on the same frame read as one.",
    "const a = poof(spots[0]);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.poofGapMs, ease: E.linear, onUpdate: () => {} });",
    "const b = poof(spots[1]);",
    "await Promise.all([a, b]);",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Storm Calm ──────────────────────────────────────────────────────────── */
//
// She breaks off and gathers the storm back into herself. Dim the scene, drift
// the camera onto her, then a blue gather-burst reading as MP returning.

function stormCalm(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.55, camInMs: 1500, camOutMs: 1200,
    dimTo: 0.55, dimMs: 900,
    beatMs: 420,
    gatherMs: 1400, gatherCount: 54, gatherRadius: 320,
    color: 0x5fa8ff, glowColor: 0xbfe0ff,
    pulseMs: 700, pulseSize: 240,
    holdMs: 500,
    sfx: null, sfxVol: 0.5,
    totalTimeoutMs: 18000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 94500 });",
    "",
    "// sceneDim, not a DOM sheet: her sprite has to stay lit, it is the subject.",
    "const dim = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "await oni.camera.focus({ point: home, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "await wait(cfg.beatMs);",
    "",
    "playSfx('sfx', 'sfxVol');",
    "",
    "// Motes converge INWARD onto her — the storm coming back, not going out.",
    "oni.particles({ x: home.x, y: home.y, count: cfg.gatherCount, color: cfg.color,",
    "  size: 13, radius: S.wLen(cfg.gatherRadius), life: cfg.gatherMs,",
    "  blend: PIXI.BLEND_MODES.ADD, parent: host, mode: 'gather' });",
    "",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "const halo = new PIXI.Sprite(glow);",
    "halo.anchor.set(0.5);",
    "halo.tint = cfg.glowColor;",
    "halo.blendMode = PIXI.BLEND_MODES.ADD;",
    "halo.position.set(home.x, home.y);",
    "halo.width = halo.height = 0;",
    "halo.alpha = 0;",
    "host.addChild(halo);",
    "",
    "await oni.tween({ from: 0, to: 1, duration: cfg.gatherMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  halo.alpha = v * 0.75;",
    "  halo.width = halo.height = S.wLen(cfg.pulseSize) * (0.35 + v * 0.65);",
    "} });",
    "",
    "// The recovery lands here, so the number appears on the pulse.",
    "done();",
    "",
    "await oni.tween({ from: 1, to: 0, duration: cfg.pulseMs, ease: E.outQuad, onUpdate: (v) => {",
    "  halo.alpha = v * 0.75;",
    "  halo.width = halo.height = S.wLen(cfg.pulseSize) * (1 + (1 - v) * 0.7);",
    "} });",
    "try { halo.destroy(); } catch (e) {}",
    "",
    "await wait(cfg.holdMs);",
    "await Promise.all([",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "]);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Condemn ─────────────────────────────────────────────────────────────── */
//
// A crucifixion cross of dark light scales in over the target, hangs, then
// detonates. Drawn rather than sourced from an asset so the proportions can be
// tuned to the shot and it tints cleanly to the element.

function condemn(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.7, camInMs: 1100, camOutMs: 1000,
    dimTo: 0.5, dimMs: 700,
    crossH: 300, crossW: 190, armFrac: 0.30, thickness: 26,
    color: 0x9d4dff, coreColor: 0xf0e2ff,
    scaleInMs: 900, hangMs: 620,
    detonateMs: 520, shardCount: 26, shardRadius: 300,
    flashColor: "#b98cff", flashAlpha: 0.5, flashInMs: 140, flashOutMs: 700,
    shakeMs: 520, shakeAmp: 10,
    sfxCast: null, sfxCastVol: 0.5, sfxImpact: null, sfxImpactVol: 0.75,
    totalTimeoutMs: 20000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 95500 });",
    "const t = ctr(prime);",
    "",
    "const dim = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "await oni.camera.focus({ point: t, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "playSfx('sfxCast', 'sfxCastVol');",
    "",
    "// Two bars, additive, with a brighter core bar laid over each so the cross",
    "// reads as light rather than as a flat drawn shape.",
    "function bar(w, h, color, alpha) {",
    "  const g = new PIXI.Graphics();",
    "  g.beginFill(color, alpha).drawRoundedRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.4).endFill();",
    "  g.blendMode = PIXI.BLEND_MODES.ADD;",
    "  return g;",
    "}",
    "const cross = new PIXI.Container();",
    "cross.position.set(t.x, t.y);",
    "host.addChild(cross);",
    "const H = S.wLen(cfg.crossH), W = S.wLen(cfg.crossW), TH = S.wLen(cfg.thickness);",
    "const vert = bar(TH, H, cfg.color, 0.95);",
    "const horz = bar(W, TH, cfg.color, 0.95);",
    "horz.position.set(0, -H * (0.5 - cfg.armFrac));",
    "const vertCore = bar(TH * 0.38, H * 0.96, cfg.coreColor, 1);",
    "const horzCore = bar(W * 0.96, TH * 0.38, cfg.coreColor, 1);",
    "horzCore.position.set(0, -H * (0.5 - cfg.armFrac));",
    "cross.addChild(vert, horz, vertCore, horzCore);",
    "",
    "cross.scale.set(0.05);",
    "cross.alpha = 0;",
    "await oni.tween({ from: 0, to: 1, duration: cfg.scaleInMs, ease: E.outQuad, onUpdate: (v) => {",
    "  cross.scale.set(0.05 + v * 0.95);",
    "  cross.alpha = v;",
    "  cross.rotation = (1 - v) * 0.35;",
    "} });",
    "",
    "// Hold: the sentence is passed before it is carried out.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.hangMs, ease: E.linear, onUpdate: (v) => {",
    "  const p = 1 + Math.sin(v * Math.PI * 4) * 0.02;",
    "  cross.scale.set(p);",
    "} });",
    "",
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "oni.particles({ x: t.x, y: t.y, count: cfg.shardCount, color: cfg.color, size: 15,",
    "  radius: S.wLen(cfg.shardRadius), life: 900, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "",
    "const blowing = oni.tween({ from: 1, to: 0, duration: cfg.detonateMs, ease: E.outQuad, onUpdate: (v) => {",
    "  cross.alpha = v;",
    "  cross.scale.set(1 + (1 - v) * 1.4);",
    "} });",
    "const flashing = oni.domFlash({ color: cfg.flashColor, alpha: cfg.flashAlpha,",
    "  fadeIn: cfg.flashInMs, hold: 80, fadeOut: cfg.flashOutMs, onPeak: () => done() });",
    "const shaking = shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "await Promise.all([blowing, flashing, shaking]);",
    "try { cross.destroy({ children: true }); } catch (e) {}",
    "",
    "await Promise.all([",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "]);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Torment ─────────────────────────────────────────────────────────────── */
//
// No damage — this is pure dread. Dim, drift onto the victim, a leering face
// swells overhead, laughs, then sinks INTO them and they shudder.

function torment(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.8, camInMs: 1600, camOutMs: 1200,
    dimTo: 0.62, dimMs: 900,
    beatMs: 380,
    faceSize: 260, faceColor: 0xb46bff, eyeColor: 0xff2f4a,
    riseFrac: 0.85,
    scaleInMs: 1000, leerMs: 900,
    descendMs: 760,
    shakeMs: 700, shakeAmp: 9,
    sfxLaugh: null, sfxLaughVol: 0.7,
    totalTimeoutMs: 22000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 95500 });",
    "const t = ctr(prime);",
    "",
    "const dim = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "await oni.camera.focus({ point: t, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "await wait(cfg.beatMs);",
    "",
    "// A leering mask, drawn: two slit eyes and a jagged grin over a dark head.",
    "const face = new PIXI.Container();",
    "const halfH = (prime.mesh && prime.mesh.height ? prime.mesh.height : (prime.h || 100)) * 0.5;",
    "const above = { x: t.x, y: t.y - halfH * cfg.riseFrac };",
    "face.position.set(above.x, above.y);",
    "host.addChild(face);",
    "const R = S.wLen(cfg.faceSize) * 0.5;",
    "",
    "const head = new PIXI.Graphics();",
    "head.beginFill(0x120019, 0.92).drawEllipse(0, 0, R * 0.92, R).endFill();",
    "head.lineStyle({ width: S.wLen(5), color: cfg.faceColor, alpha: 0.9 });",
    "head.drawEllipse(0, 0, R * 0.92, R);",
    "face.addChild(head);",
    "",
    "function eye(sx) {",
    "  const g = new PIXI.Graphics();",
    "  g.beginFill(cfg.eyeColor, 1);",
    "  g.moveTo(sx * R * 0.18, -R * 0.22);",
    "  g.lineTo(sx * R * 0.62, -R * 0.36);",
    "  g.lineTo(sx * R * 0.60, -R * 0.10);",
    "  g.closePath();",
    "  g.endFill();",
    "  g.blendMode = PIXI.BLEND_MODES.ADD;",
    "  return g;",
    "}",
    "face.addChild(eye(-1), eye(1));",
    "",
    "const grin = new PIXI.Graphics();",
    "grin.lineStyle({ width: S.wLen(7), color: cfg.eyeColor, alpha: 0.95 });",
    "grin.moveTo(-R * 0.55, R * 0.20);",
    "for (let i = 1; i <= 8; i++) {",
    "  const gx = -R * 0.55 + (R * 1.10) * (i / 8);",
    "  const gy = R * 0.20 + ((i % 2 === 0) ? R * 0.16 : -R * 0.04);",
    "  grin.lineTo(gx, gy);",
    "}",
    "grin.blendMode = PIXI.BLEND_MODES.ADD;",
    "face.addChild(grin);",
    "",
    "face.scale.set(0.05);",
    "face.alpha = 0;",
    "playSfx('sfxLaugh', 'sfxLaughVol');",
    "await oni.tween({ from: 0, to: 1, duration: cfg.scaleInMs, ease: E.outQuad, onUpdate: (v) => {",
    "  face.scale.set(0.05 + v * 0.95);",
    "  face.alpha = v;",
    "} });",
    "",
    "// Leer — it breathes and rocks while the laugh plays out.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.leerMs, ease: E.linear, onUpdate: (v) => {",
    "  face.scale.set(1 + Math.sin(v * Math.PI * 3) * 0.05);",
    "  face.rotation = Math.sin(v * Math.PI * 2) * 0.06;",
    "} });",
    "",
    "// Sink INTO them: shrink and slide down onto the victim, not just fade.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.descendMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  face.position.set(above.x + (t.x - above.x) * v, above.y + (t.y - above.y) * v);",
    "  face.scale.set(1 - v * 0.82);",
    "  face.alpha = 1 - v * 0.85;",
    "} });",
    "try { face.destroy({ children: true }); } catch (e) {}",
    "",
    "// The debuffs land as it goes in.",
    "done();",
    "await shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "",
    "await Promise.all([",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "]);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Searing Brand ───────────────────────────────────────────────────────── */
//
// The cast that plants the mark. The PERSISTENT badge is not this script's job
// — battle-director/brand-mark.js draws it off the AE and carries it when the
// mark is passed. This is only the moment it lands.

function searingBrand(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.5, camInMs: 900, camOutMs: 900,
    markSize: 220, color: 0xff3b30, coreColor: 0xffd9c9,
    travelMs: 700,
    slamMs: 420, ringMs: 700, ringSize: 260,
    emberCount: 24, emberRadius: 200,
    shakeMs: 380, shakeAmp: 7,
    sfxCast: null, sfxCastVol: 0.5, sfxImpact: null, sfxImpactVol: 0.7,
    totalTimeoutMs: 16000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 95500 });",
    "const t = ctr(prime);",
    "",
    "await oni.camera.focus({ point: t, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "playSfx('sfxCast', 'sfxCastVol');",
    "",
    "// A downward chevron, matching the placeholder the persistent badge draws,",
    "// so the thing that lands and the thing that stays are the same sign.",
    "const mark = new PIXI.Container();",
    "const R = S.wLen(cfg.markSize) * 0.5;",
    "function chev(color, w, alpha) {",
    "  const g = new PIXI.Graphics();",
    "  g.lineStyle({ width: w, color: color, alpha: alpha, cap: 'round', join: 'round' });",
    "  g.moveTo(-R * 0.62, -R * 0.30);",
    "  g.lineTo(0, R * 0.34);",
    "  g.lineTo(R * 0.62, -R * 0.30);",
    "  g.blendMode = PIXI.BLEND_MODES.ADD;",
    "  return g;",
    "}",
    "mark.addChild(chev(cfg.color, S.wLen(26), 0.95), chev(cfg.coreColor, S.wLen(10), 1));",
    "const start = { x: home.x, y: home.y };",
    "mark.position.set(start.x, start.y);",
    "mark.scale.set(0.35);",
    "mark.alpha = 0;",
    "host.addChild(mark);",
    "",
    "// Thrown from her to the victim, growing as it crosses.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.travelMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  mark.position.set(start.x + (t.x - start.x) * v, start.y + (t.y - start.y) * v - Math.sin(v * Math.PI) * S.wLen(70));",
    "  mark.scale.set(0.35 + v * 0.95);",
    "  mark.alpha = Math.min(1, v * 2.2);",
    "  mark.rotation = (1 - v) * -0.5;",
    "} });",
    "",
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "oni.particles({ x: t.x, y: t.y, count: cfg.emberCount, color: cfg.color, size: 12,",
    "  radius: S.wLen(cfg.emberRadius), life: 800, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "",
    "// Brand slam: overshoot then settle, so it reads as being burned ON.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.slamMs, ease: E.outQuad, onUpdate: (v) => {",
    "  mark.scale.set(1.3 - v * 0.3);",
    "} });",
    "",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "const ring = new PIXI.Sprite(glow);",
    "ring.anchor.set(0.5);",
    "ring.tint = cfg.color;",
    "ring.blendMode = PIXI.BLEND_MODES.ADD;",
    "ring.position.set(t.x, t.y);",
    "host.addChild(ring);",
    "",
    "// The AE lands here — the persistent badge takes over from this point.",
    "done();",
    "",
    "await Promise.all([",
    "  shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp)),",
    "  oni.tween({ from: 0, to: 1, duration: cfg.ringMs, ease: E.outQuad, onUpdate: (v) => {",
    "    ring.width = ring.height = S.wLen(cfg.ringSize) * v;",
    "    ring.alpha = 0.8 * (1 - v);",
    "    mark.alpha = 1 - v * 0.9;",
    "  } }),",
    "]);",
    "try { ring.destroy(); mark.destroy({ children: true }); } catch (e) {}",
    "await oni.camera.restore({ duration: cfg.camOutMs });",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Draconic Domination ─────────────────────────────────────────────────── */
//
// A vast eye opens over the whole frame and the world buckles. The warp is a
// PIXI DisplacementFilter on the stage; if the filter is unavailable the shot
// degrades to the eye plus a pulse rather than failing, because losing the
// animation must never cost the action.

function draconicDomination(opts = {}) {
  const cfg = Object.assign({
    dimTo: 0.5, dimMs: 800,
    eyeW: 0.92, eyeH: 0.46,     // fractions of the VIEWPORT, this is a full-frame shot
    scleraColor: 0x1a0430, irisColor: 0xb46bff, pupilColor: 0x12001c,
    veinColor: 0x7a2fd0,
    openMs: 1100, holdMs: 1400, closeMs: 800,
    warpAmp: 26, warpHz: 0.55,
    shakeMs: 600,
    sfx: null, sfxVol: 0.65,
    totalTimeoutMs: 24000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 96500 });",
    "const dim = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "playSfx('sfx', 'sfxVol');",
    "",
    "// Screen-space: this is a full-frame shot, so it is anchored to the",
    "// viewport and rebuilt from the live transform rather than to the world.",
    "const cen = S.S2W(0.5, 0.5);",
    "const EW = S.hPx(cfg.eyeW * (S.W / S.H));",
    "const EH = S.hPx(cfg.eyeH);",
    "",
    "const eye = new PIXI.Container();",
    "eye.position.set(cen.x, cen.y);",
    "host.addChild(eye);",
    "",
    "const sclera = new PIXI.Graphics();",
    "sclera.beginFill(cfg.scleraColor, 0.96);",
    "sclera.moveTo(-EW / 2, 0);",
    "sclera.quadraticCurveTo(0, -EH / 2, EW / 2, 0);",
    "sclera.quadraticCurveTo(0, EH / 2, -EW / 2, 0);",
    "sclera.endFill();",
    "eye.addChild(sclera);",
    "",
    "const iris = new PIXI.Graphics();",
    "iris.beginFill(cfg.irisColor, 0.95).drawCircle(0, 0, EH * 0.42).endFill();",
    "iris.blendMode = PIXI.BLEND_MODES.ADD;",
    "eye.addChild(iris);",
    "",
    "const pupil = new PIXI.Graphics();",
    "pupil.beginFill(cfg.pupilColor, 1).drawEllipse(0, 0, EH * 0.10, EH * 0.40).endFill();",
    "eye.addChild(pupil);",
    "",
    "// Veins crawling out of the iris — cheap, and they sell it as ALIVE.",
    "const veins = new PIXI.Graphics();",
    "veins.lineStyle({ width: S.wLen(3), color: cfg.veinColor, alpha: 0.75 });",
    "for (let i = 0; i < 14; i++) {",
    "  const a = (Math.PI * 2 / 14) * i + 0.3;",
    "  const r0 = EH * 0.45;",
    "  const r1 = EH * (0.6 + Math.random() * 0.35);",
    "  veins.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * 0.55);",
    "  veins.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 * 0.55);",
    "}",
    "eye.addChild(veins);",
    "",
    "// Warp. PIXI 7 exposes DisplacementFilter at the top level; older builds",
    "// put it under .filters. Neither existing is survivable — the eye alone",
    "// still reads — so this is attempted, never required.",
    "let warp = null, warpSprite = null, prevFilters = null;",
    "try {",
    "  const DF = (PIXI.DisplacementFilter) || (PIXI.filters && PIXI.filters.DisplacementFilter);",
    "  if (DF) {",
    "    const tex = oni.radialTexture('rgba(255,0,255,1)', 'rgba(0,255,0,0)', { size: 256 });",
    "    warpSprite = new PIXI.Sprite(tex);",
    "    warpSprite.anchor.set(0.5);",
    "    warpSprite.position.set(cen.x, cen.y);",
    "    warpSprite.width = warpSprite.height = S.hPx(1.6);",
    "    host.addChild(warpSprite);",
    "    warp = new DF(warpSprite);",
    "    warp.scale.x = 0; warp.scale.y = 0;",
    "    prevFilters = canvas.stage.filters;",
    "    canvas.stage.filters = (prevFilters || []).concat([warp]);",
    "  }",
    "} catch (e) { warp = null; }",
    "",
    "// Open: the lid parts and the world starts to buckle.",
    "eye.scale.set(1, 0.02);",
    "eye.alpha = 0;",
    "await oni.tween({ from: 0, to: 1, duration: cfg.openMs, ease: E.outQuad, onUpdate: (v) => {",
    "  eye.scale.set(1, 0.02 + v * 0.98);",
    "  eye.alpha = Math.min(1, v * 1.6);",
    "  if (warp) { warp.scale.x = cfg.warpAmp * v; warp.scale.y = cfg.warpAmp * v; }",
    "} });",
    "",
    "oni.screenshake({ duration: cfg.shakeMs });",
    "",
    "// Hold the chaos: the pupil hunts, the warp breathes.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.holdMs, ease: E.linear, onUpdate: (v) => {",
    "  const s = Math.sin(v * Math.PI * 2 * cfg.warpHz * 2);",
    "  pupil.position.set(EW * 0.06 * s, 0);",
    "  pupil.scale.set(1 + s * 0.12, 1);",
    "  if (warpSprite) warpSprite.rotation = v * Math.PI * 0.5;",
    "  if (warp) {",
    "    const a = cfg.warpAmp * (0.75 + Math.sin(v * Math.PI * 6) * 0.25);",
    "    warp.scale.x = a; warp.scale.y = a;",
    "  }",
    "} });",
    "",
    "// The save resolves as the eye shuts on them.",
    "done();",
    "",
    "await oni.tween({ from: 1, to: 0, duration: cfg.closeMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  eye.scale.set(1, 0.02 + v * 0.98);",
    "  eye.alpha = v;",
    "  if (warp) { warp.scale.x = cfg.warpAmp * v; warp.scale.y = cfg.warpAmp * v; }",
    "} });",
    "",
    "// Restore the stage filters to EXACTLY what was there, never to [].",
    "try { canvas.stage.filters = prevFilters; } catch (e) {}",
    "try { if (warpSprite) warpSprite.destroy(); } catch (e) {}",
    "try { eye.destroy({ children: true }); } catch (e) {}",
    "await dim.fadeOut({ duration: cfg.closeMs });",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Zero Power · Cruel Ultimatum ────────────────────────────────────────── */
//
// EFFORT: highest. She climbs out of frame, hangs, then breathes ruin down from
// above. Element and target spread come from cfg, so the Fire branch (one
// chosen victim) and the Bolt branch (everyone) are the SAME shot with
// different numbers — which is the point, since the players pick between them
// and the two outcomes should feel like one weapon.

function cruelUltimatum(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.35, camInMs: 900, camOutMs: 1300,
    dimTo: 0.58, dimMs: 900,
    riseMs: 1500, riseFrac: 1.25,     // how far above the viewport she climbs
    hangMs: 900,
    breathMs: 1500,
    beamThickness: 0.42,
    color: 0xff8a3d, coreColor: 0xfff0d0,
    impactCount: 34, impactRadius: 320,
    flashColor: "#ffd9a0", flashAlpha: 0.6, flashInMs: 160, flashOutMs: 800,
    shakeMs: 900, shakeAmp: 13,
    spread: "one",                     // "one" | "all"
    beamWebm: null,
    sfxRise: null, sfxRiseVol: 0.55,
    sfxBreath: null, sfxBreathVol: 0.8,
    totalTimeoutMs: 30000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 96000 });",
    "const victims = cfg.spread === 'all' ? tgts.slice() : (prime ? [prime] : []);",
    "if (!victims.length) { done(); return; }",
    "",
    "const dim = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "await oni.camera.focus({ point: home, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "",
    "// She leaves the board: clone her, hide the real token, fly the clone out",
    "// of the top of the frame. hideToken re-asserts every tick, because a cull",
    "// pass will otherwise flip the token back on mid-shot.",
    "const clone = oni.cloneToken(caster, { parent: host });",
    "const restoreCaster = oni.hideToken(caster);",
    "playSfx('sfxRise', 'sfxRiseVol');",
    "",
    "const skyY = home.y - S.hPx(cfg.riseFrac);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.riseMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (!clone) return;",
    "  clone.position.set(home.x, home.y + (skyY - home.y) * v);",
    "  clone.alpha = 1 - v * 0.25;",
    "} });",
    "",
    "await wait(cfg.hangMs);",
    "playSfx('sfxBreath', 'sfxBreathVol');",
    "",
    "// One breath column per victim, all struck on the same beat.",
    "const from = { x: home.x, y: skyY };",
    "const cols = [];",
    "for (const v of victims) {",
    "  const c = ctr(v);",
    "  if (cfg.beamWebm) {",
    "    const r = await fxBeam(cfg.beamWebm, from, c, { parent: host, thickness: cfg.beamThickness, z: 96000 });",
    "    if (r && r.sprite) cols.push(r.sprite);",
    "    continue;",
    "  }",
    "  const g = streak(from.x, from.y, c.x, c.y, cfg.color, S.wLen(64), host);",
    "  const core = streak(from.x, from.y, c.x, c.y, cfg.coreColor, S.wLen(22), host);",
    "  cols.push(g, core);",
    "}",
    "for (const c of cols) c.alpha = 0;",
    "",
    "await oni.tween({ from: 0, to: 1, duration: cfg.breathMs * 0.35, ease: E.outQuad, onUpdate: (v) => {",
    "  for (const c of cols) c.alpha = v;",
    "} });",
    "",
    "for (const v of victims) {",
    "  const c = ctr(v);",
    "  oni.particles({ x: c.x, y: c.y, count: cfg.impactCount, color: cfg.color, size: 16,",
    "    radius: S.wLen(cfg.impactRadius), life: 1000, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "}",
    "",
    "const flashing = oni.domFlash({ color: cfg.flashColor, alpha: cfg.flashAlpha,",
    "  fadeIn: cfg.flashInMs, hold: 120, fadeOut: cfg.flashOutMs, onPeak: () => done() });",
    "const shaking = Promise.all(victims.map((v) => shakeTarget(v, cfg.shakeMs, S.wLen(cfg.shakeAmp))));",
    "const fading = oni.tween({ from: 1, to: 0, duration: cfg.breathMs * 0.65, ease: E.inOutQuad, onUpdate: (v) => {",
    "  for (const c of cols) c.alpha = v;",
    "} });",
    "await Promise.all([flashing, shaking, fading]);",
    "for (const c of cols) { try { c.destroy(); } catch (e) {} }",
    "",
    "// She drops back onto her own square before the token is handed back.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.camOutMs * 0.6, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (!clone) return;",
    "  clone.position.set(home.x, skyY + (home.y - skyY) * v);",
    "  clone.alpha = 0.75 + v * 0.25;",
    "} });",
    "restoreCaster();",
    "try { if (clone) clone.destroy(); } catch (e) {}",
    "",
    "await Promise.all([",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "]);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

module.exports = {
  summonDrakes,
  stormCalm,
  condemn,
  torment,
  searingBrand,
  draconicDomination,
  cruelUltimatum,
};
