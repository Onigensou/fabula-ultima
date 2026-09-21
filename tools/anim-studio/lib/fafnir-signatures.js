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
// EFFORT: high. The first pass was two particle poofs, which said "something
// happened here" without saying WHAT. This shows the drakes themselves arriving.
//
// They do not exist on the board yet — the summon resolves after the animation
// gate — so these are their SPRITES flown into the spots they are about to
// occupy, then handed off as the real tokens appear. Each moves in character:
//
//   Flame Drake      walks. A stepped left-to-right slide, three heavy strides
//                    with a settle between each, so it reads as weight.
//   Lightning Drake  flies. In from off-frame left on a curve that falls from
//                    high-left to its spot, overshooting and snapping back.
//
// Both at once, because they are one summon and not two.

function summonDrakes(opts = {}) {
  const cfg = Object.assign({
    // Where they land, as fractions of HER sprite half-width — her token is
    // scaled well past 1, so a grid-based offset would drop them on top of her.
    flankFrac: 0.95,
    riseFrac: 0.08,
    // Drake sprite size, as a fraction of her sprite width.
    drakeScale: 0.42,

    // Flame Drake — three strides, each a push then a settle.
    walkSteps: 3,
    walkStepMs: 300, walkSettleMs: 170,
    walkFromFrac: 1.05,        // start offset left of its spot, x its own width
    walkBobFrac: 0.05,

    // Lightning Drake — off-frame left, curving down to its spot.
    flyMs: 1250,
    flyFromXFrac: -0.28,       // viewport fraction: negative = off the left edge
    flyFromYFrac: 0.12,        // viewport fraction from the top
    flyOvershootFrac: 0.16,    // past the spot, as a fraction of its own width
    flySettleMs: 380,
    flyTiltDeg: 14,

    fadeInMs: 520,
    holdMs: 320,
    sfx: null, sfxVol: 0.6,
    totalTimeoutMs: 16000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 94000 });",
    "",
    "const halfW = (caster.mesh && caster.mesh.width ? caster.mesh.width : (caster.w || 100)) * 0.5;",
    "const dropW = halfW * 2 * cfg.drakeScale;",
    "const dx = halfW * cfg.flankFrac;",
    "const dy = -halfW * cfg.riseFrac;",
    "const spotFire = { x: home.x - dx, y: home.y + dy };",
    "const spotBolt = { x: home.x + dx, y: home.y + dy };",
    "",
    "// Build a sprite for a drake, sized off her own token so the pair stay in",
    "// proportion on any scene. A missing asset is survivable: the shot simply",
    "// plays without that drake rather than throwing.",
    "async function drakeSprite(url, flip) {",
    "  if (!url) return null;",
    "  let tex = null;",
    "  try { tex = await loadTexture(url); } catch (e) { return null; }",
    "  if (!tex) return null;",
    "  const sp = new PIXI.Sprite(tex);",
    "  sp.anchor.set(0.5);",
    "  const ratio = (tex.height && tex.width) ? (tex.height / tex.width) : 1;",
    "  sp.width = dropW;",
    "  sp.height = dropW * ratio;",
    "  if (flip) sp.scale.x = -Math.abs(sp.scale.x);",
    "  sp.alpha = 0;",
    "  host.addChild(sp);",
    "  return sp;",
    "}",
    "",
    "const fire = await drakeSprite(A.fireDrake, false);",
    "const bolt = await drakeSprite(A.boltDrake, false);",
    "",
    "playSfx('sfx', 'sfxVol');",
    "",
    "// ── Flame Drake: heavy stepped walk, left to right ──",
    "async function walkIn() {",
    "  if (!fire) return;",
    "  const from = { x: spotFire.x - dropW * cfg.walkFromFrac, y: spotFire.y };",
    "  fire.position.set(from.x, from.y);",
    "  oni.tween({ from: 0, to: 1, duration: cfg.fadeInMs, ease: E.outQuad,",
    "    onUpdate: function (v) { if (fire) fire.alpha = v; } });",
    "  for (let i = 0; i < cfg.walkSteps; i++) {",
    "    const a = i / cfg.walkSteps;",
    "    const b = (i + 1) / cfg.walkSteps;",
    "    // Push: the body drives forward and lifts a little.",
    "    await oni.tween({ from: 0, to: 1, duration: cfg.walkStepMs, ease: E.outQuad, onUpdate: function (v) {",
    "      if (!fire) return;",
    "      const p = a + (b - a) * v;",
    "      fire.position.set(from.x + (spotFire.x - from.x) * p,",
    "                        from.y - Math.sin(v * Math.PI) * dropW * cfg.walkBobFrac);",
    "    } });",
    "    // Settle: the weight comes down before the next stride.",
    "    if (i < cfg.walkSteps - 1) {",
    "      await oni.tween({ from: 0, to: 1, duration: cfg.walkSettleMs, ease: E.inOutQuad, onUpdate: function (v) {",
    "        if (!fire) return;",
    "        fire.position.set(fire.position.x, from.y + Math.sin(v * Math.PI) * dropW * 0.012);",
    "      } });",
    "    }",
    "  }",
    "  if (fire) { fire.position.set(spotFire.x, spotFire.y); fire.alpha = 1; }",
    "}",
    "",
    "// ── Lightning Drake: curving flight in from off-frame left ──",
    "async function flyIn() {",
    "  if (!bolt) return;",
    "  const from = S.S2W(cfg.flyFromXFrac, cfg.flyFromYFrac);",
    "  const over = { x: spotBolt.x + dropW * cfg.flyOvershootFrac, y: spotBolt.y - dropW * 0.05 };",
    "  bolt.position.set(from.x, from.y);",
    "  oni.tween({ from: 0, to: 1, duration: cfg.fadeInMs, ease: E.outQuad,",
    "    onUpdate: function (v) { if (bolt) bolt.alpha = v; } });",
    "  // Quadratic bezier with the control point high and to the RIGHT of the",
    "  // start, which is what bends the path from high-left down into the spot",
    "  // instead of running straight at it.",
    "  const ctrl = { x: from.x + (over.x - from.x) * 0.72, y: from.y - Math.abs(over.y - from.y) * 0.35 };",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.flyMs, ease: E.inOutQuad, onUpdate: function (v) {",
    "    if (!bolt) return;",
    "    const u = 1 - v;",
    "    const x = u * u * from.x + 2 * u * v * ctrl.x + v * v * over.x;",
    "    const y = u * u * from.y + 2 * u * v * ctrl.y + v * v * over.y;",
    "    bolt.position.set(x, y);",
    "    bolt.angle = cfg.flyTiltDeg * (1 - v);",
    "  } });",
    "  // Overshoot, then pull back onto the mark.",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.flySettleMs, ease: E.outQuad, onUpdate: function (v) {",
    "    if (!bolt) return;",
    "    bolt.position.set(over.x + (spotBolt.x - over.x) * v, over.y + (spotBolt.y - over.y) * v);",
    "    bolt.angle = cfg.flyTiltDeg * 0.35 * (1 - v);",
    "  } });",
    "  if (bolt) { bolt.position.set(spotBolt.x, spotBolt.y); bolt.angle = 0; bolt.alpha = 1; }",
    "}",
    "",
    "await Promise.all([walkIn(), flyIn()]);",
    "await wait(cfg.holdMs);",
    "",
    "// The real tokens are created after this gate, so hand off rather than",
    "// cutting: the stand-ins fade as the summon resolves underneath them.",
    "done();",
    "await oni.tween({ from: 1, to: 0, duration: 380, ease: E.inOutQuad, onUpdate: function (v) {",
    "  if (fire) fire.alpha = v;",
    "  if (bolt) bolt.alpha = v;",
    "} });",
    "try { if (fire) fire.destroy(); } catch (e) {}",
    "try { if (bolt) bolt.destroy(); } catch (e) {}",
  ].join("\n");

  return shell({
    key: opts.key, name: opts.name, cfg,
    assets: opts.assets || {},
    inner: inner(body), timeout: cfg.totalTimeoutMs,
  });
}

/* ── Rend (heavy claw) ───────────────────────────────────────────────────
 *
 * The generic `melee` template walks the caster most of the way to its victim.
 * That shape is built for a person-sized token; on a sprite as large as
 * Fafnir's it reads as the whole dragon teleporting across the arena, and at
 * her scale she covers the target completely on arrival.
 *
 * So she does not travel. She leans in — a short shove along the line to the
 * target, far enough to read as a strike and nowhere near far enough to leave
 * her square — and the claw lands at range.
 *
 * Kept here rather than added to `melee` as an option: that template is shared
 * by the whole dungeon roster and its lunge is the approved look for all of
 * them. This is a big-creature variant, and any other oversized monster should
 * reuse THIS.
 */
function heavyClaw(opts = {}) {
  const cfg = Object.assign({
    // Fraction of the caster's own sprite half-width, NOT of the distance to
    // the target: the lean has to look the same whether the victim is adjacent
    // or across the arena.
    nudgeFrac: 0.22,
    windupMs: 260, nudgeMs: 200, holdMs: 220, returnMs: 520,
    clawWebm: null, clawSize: 460,
    slashColor: 0xd9c7ff, slashWidth: 10, slashCount: 2, slashGapMs: 110, slashFadeMs: 320,
    particles: 22, particleRadius: 140, particleSize: 12, color: 0xffe9c4,
    shakeMs: 480, shakeAmp: 10,
    sfx: null, sfxVol: 0.6,
    totalTimeoutMs: 12000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 93000 });",
    "const t = ctr(prime);",
    "",
    "// Direction to the victim, but the DISTANCE comes from her own size.",
    "const dx = t.x - home.x, dy = t.y - home.y;",
    "const len = Math.hypot(dx, dy) || 1;",
    "const halfW = (caster.mesh && caster.mesh.width ? caster.mesh.width : (caster.w || 100)) * 0.5;",
    "const reach = halfW * cfg.nudgeFrac;",
    "const lean = { x: home.x + (dx / len) * reach, y: home.y + (dy / len) * reach };",
    "",
    "const clone = oni.cloneToken(caster, { parent: host });",
    "const restoreCaster = oni.hideToken(caster);",
    "",
    "// Pull BACK a touch first — the wind-up is what makes the shove read as",
    "// weight rather than a twitch.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.windupMs, ease: E.outQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(home.x - (dx / len) * reach * 0.35 * v, home.y - (dy / len) * reach * 0.35 * v);",
    "} });",
    "",
    "playSfx('sfx', 'sfxVol');",
    "await oni.tween({ from: 0, to: 1, duration: cfg.nudgeMs, ease: E.outQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(",
    "    home.x - (dx / len) * reach * 0.35 * (1 - v) + (lean.x - home.x) * v,",
    "    home.y - (dy / len) * reach * 0.35 * (1 - v) + (lean.y - home.y) * v);",
    "} });",
    "",
    "// The claw lands at the TARGET, at range — she never goes there.",
    "if (cfg.clawWebm) await fxWebm(cfg.clawWebm, t.x, t.y, { size: S.wLen(cfg.clawSize), parent: host });",
    "const perp = Math.atan2(dy, dx) + Math.PI / 2;",
    "const half = S.wLen(90);",
    "for (let i = 0; i < cfg.slashCount; i++) {",
    "  const off = (i - (cfg.slashCount - 1) / 2) * S.wLen(34);",
    "  const ox = Math.cos(perp) * off, oy = Math.sin(perp) * off;",
    "  const g = streak(t.x - Math.cos(perp) * half + ox, t.y - Math.sin(perp) * half + oy,",
    "                   t.x + Math.cos(perp) * half + ox, t.y + Math.sin(perp) * half + oy,",
    "                   cfg.slashColor, S.wLen(cfg.slashWidth), host);",
    "  oni.tween({ from: 1, to: 0, duration: cfg.slashFadeMs, ease: E.outQuad,",
    "    onUpdate: (v) => { g.alpha = v; } }).then(() => { try { g.destroy(); } catch (e) {} });",
    "  if (i < cfg.slashCount - 1) await wait(cfg.slashGapMs);",
    "}",
    "",
    "oni.particles({ x: t.x, y: t.y, count: cfg.particles, color: cfg.color, size: cfg.particleSize,",
    "  radius: S.wLen(cfg.particleRadius), life: 850, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "",
    "done();",
    "await Promise.all([",
    "  shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp)),",
    "  wait(cfg.holdMs),",
    "]);",
    "",
    "await oni.tween({ from: 0, to: 1, duration: cfg.returnMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(lean.x + (home.x - lean.x) * v, lean.y + (home.y - lean.y) * v);",
    "} });",
    "restoreCaster();",
    "try { if (clone) clone.destroy(); } catch (e) {}",
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
    // The recovery now reads off a healing WEBM rather than a particle gather:
    // an authored asset says "restored" far more plainly than motes do.
    healWebm: null, healSize: 520, healMs: 1600,
    holdMs: 500,
    // Two cues, deliberately at different beats: the water drop lands WITH the
    // effect, the heal chime lands AFTER it, so the cast and its result are not
    // one undifferentiated noise.
    sfxDuring: null, sfxDuringVol: 0.55,
    sfxAfter: null, sfxAfterVol: 0.6,
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
    "playSfx('sfxDuring', 'sfxDuringVol');",
    "",
    "// The healing asset plays ON her, sized off her sprite rather than a fixed",
    "// px so it reads the same on any token scale.",
    "const halfW = (caster.mesh && caster.mesh.width ? caster.mesh.width : (caster.w || 100)) * 0.5;",
    "const fx = await fxWebm(cfg.healWebm, home.x, home.y, {",
    "  size: Math.max(S.wLen(cfg.healSize), halfW * 2.2), parent: host, z: 95000 });",
    "",
    "await wait(cfg.healMs);",
    "",
    "// The recovery lands with the effect, not after it.",
    "done();",
    "playSfx('sfxAfter', 'sfxAfterVol');",
    "",
    "try { if (fx && fx.sprite) fx.sprite.destroy(); } catch (e) {}",
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
// A sentence carried out. The arena empties to leave only the accuser and the
// accused, the victim is hauled off the ground, pinned by spears thrown from
// every corner of the frame, and the cross that named them detonates.
//
// The cross is DRAWN rather than sourced so its proportions tune to the shot
// and it tints cleanly; the explosion is an authored asset, because a drawn one
// never looks like enough.

function condemn(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.75, camInMs: 1200, camOutMs: 1100,
    dimTo: 0.62, dimMs: 800,
    // Everyone who is not the accuser or the accused fades out of the frame.
    bystanderFadeMs: 700, bystanderTo: 0.0,
    // The victim is hauled off the ground and struggles.
    liftFrac: 0.42, liftMs: 700, struggleMs: 900, struggleAmp: 9,
    // Cross opens larger than the frame and closes onto them.
    crossH: 300, crossW: 190, armFrac: 0.30, thickness: 26,
    crossStartFrac: 1.8, crossInMs: 900,
    color: 0x9d4dff, coreColor: 0xf0e2ff,
    // Spears thrown in from the edges of the screen.
    spearCount: 7, spearFlightMs: 260, spearGapMs: 150,
    spearLenFrac: 0.30, spearWidth: 16, spearJolt: 13,
    // Detonation.
    boomWebm: null, boomSize: 1.5,   // fraction of viewport height
    detonateMs: 620,
    flashColor: "#b98cff", flashAlpha: 0.55, flashInMs: 140, flashOutMs: 760,
    shakeMs: 820,
    sfxCast: null, sfxCastVol: 0.5,
    sfxStab: null, sfxStabVol: 0.6,
    sfxBoom: null, sfxBoomVol: 0.85,
    totalTimeoutMs: 30000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 95500 });",
    "const t = ctr(prime);",
    "",
    "const dim = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "",
    "// Clear the stage of everyone who is not part of this. Their mesh alpha is",
    "// re-asserted every tick because Foundry refreshes tokens on its own",
    "// schedule and would otherwise fade them straight back in mid-shot.",
    "const keep = new Set([caster.id].concat(tgts.map(function (x) { return x.id; })));",
    "const bystanders = (canvas.tokens.placeables || []).filter(function (x) { return x && !keep.has(x.id); });",
    "const bystanderAlpha = new Map();",
    "for (const b of bystanders) { bystanderAlpha.set(b.id, (b.mesh && b.mesh.alpha != null) ? b.mesh.alpha : 1); }",
    "let bystanderHold = 1;",
    "const holdBystanders = function () {",
    "  for (const b of bystanders) { if (b && b.mesh && !b.destroyed) b.mesh.alpha = bystanderHold; }",
    "};",
    "PIXI.Ticker.shared.add(holdBystanders);",
    "const restoreBystanders = function () {",
    "  try { PIXI.Ticker.shared.remove(holdBystanders); } catch (e) {}",
    "  for (const b of bystanders) {",
    "    if (!b || b.destroyed) continue;",
    "    const a = bystanderAlpha.has(b.id) ? bystanderAlpha.get(b.id) : 1;",
    "    try { if (b.mesh) b.mesh.alpha = a; } catch (e) {}",
    "    try { b.renderFlags.set({ refreshVisibility: true, refreshMesh: true }); } catch (e) {}",
    "  }",
    "};",
    "",
    "await Promise.all([",
    "  oni.camera.focus({ point: t, zoom: cfg.camZoom, duration: cfg.camInMs }),",
    "  oni.tween({ from: 1, to: cfg.bystanderTo, duration: cfg.bystanderFadeMs, ease: E.inOutQuad,",
    "    onUpdate: function (v) { bystanderHold = v; } }),",
    "]);",
    "",
    "playSfx('sfxCast', 'sfxCastVol');",
    "",
    "// Hauled off the ground. The real token is hidden and a clone is flown, so",
    "// nothing fights Foundry's own placeable refresh.",
    "const vicHalfH = (prime.mesh && prime.mesh.height ? prime.mesh.height : (prime.h || 100)) * 0.5;",
    "const lifted = { x: t.x, y: t.y - vicHalfH * cfg.liftFrac };",
    "const vic = oni.cloneToken(prime, { parent: host });",
    "const restoreVictim = oni.hideToken(prime);",
    "",
    "await oni.tween({ from: 0, to: 1, duration: cfg.liftMs, ease: E.outQuad, onUpdate: function (v) {",
    "  if (vic) vic.position.set(t.x, t.y + (lifted.y - t.y) * v);",
    "} });",
    "",
    "// Struggling: a fast irregular tremor, not a clean oscillation. joltX/joltY",
    "// are driven by the spear hits below and ride on top of it.",
    "let joltX = 0, joltY = 0;",
    "const struggling = oni.tween({ from: 0, to: 1, duration: cfg.struggleMs, ease: E.linear, onUpdate: function (v) {",
    "  if (!vic) return;",
    "  const amp = S.wLen(cfg.struggleAmp);",
    "  vic.position.set(lifted.x + (Math.random() * 2 - 1) * amp + joltX,",
    "                   lifted.y + (Math.random() * 2 - 1) * amp * 0.6 + joltY);",
    "  vic.rotation = (Math.random() * 2 - 1) * 0.03;",
    "} });",
    "",
    "// The cross opens larger than the frame and closes onto them.",
    "function bar(w, h, color, alpha) {",
    "  const g = new PIXI.Graphics();",
    "  g.beginFill(color, alpha).drawRoundedRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.4).endFill();",
    "  g.blendMode = PIXI.BLEND_MODES.ADD;",
    "  return g;",
    "}",
    "const cross = new PIXI.Container();",
    "cross.position.set(lifted.x, lifted.y);",
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
    "const bigScale = S.hPx(cfg.crossStartFrac) / Math.max(1, H);",
    "cross.scale.set(bigScale);",
    "cross.alpha = 0;",
    "await oni.tween({ from: 0, to: 1, duration: cfg.crossInMs, ease: E.inOutQuad, onUpdate: function (v) {",
    "  cross.scale.set(bigScale + (1 - bigScale) * v);",
    "  cross.alpha = Math.min(1, v * 2.2);",
    "  cross.rotation = (1 - v) * 0.28;",
    "} });",
    "",
    "// Spears thrown from the EDGES of the frame, each one jolting them. Screen",
    "// anchors, so they always come from off-frame whatever the camera is doing.",
    "const anchors = [",
    "  S.S2W(0, 0), S.S2W(1, 0), S.S2W(0, 1), S.S2W(1, 1),",
    "  S.S2W(0.5, 0), S.S2W(0, 0.5), S.S2W(1, 0.5), S.S2W(0.5, 1),",
    "];",
    "for (let i = 0; i < cfg.spearCount; i++) {",
    "  const from = anchors[i % anchors.length];",
    "  const ang = Math.atan2(lifted.y - from.y, lifted.x - from.x);",
    "  const reach = S.hPx(cfg.spearLenFrac);",
    "  const sx = lifted.x - Math.cos(ang) * reach;",
    "  const sy = lifted.y - Math.sin(ang) * reach;",
    "  const shaft = streak(from.x, from.y, from.x, from.y, cfg.color, S.wLen(cfg.spearWidth), host);",
    "  const tipG = streak(from.x, from.y, from.x, from.y, cfg.coreColor, S.wLen(cfg.spearWidth * 0.38), host);",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.spearFlightMs, ease: E.inQuad, onUpdate: function (v) {",
    "    const hx = from.x + (lifted.x - from.x) * v;",
    "    const hy = from.y + (lifted.y - from.y) * v;",
    "    const tx = from.x + (sx - from.x) * v;",
    "    const ty = from.y + (sy - from.y) * v;",
    "    shaft.clear();",
    "    shaft.lineStyle({ width: S.wLen(cfg.spearWidth), color: cfg.color, alpha: 1, cap: 'round' });",
    "    shaft.moveTo(tx, ty); shaft.lineTo(hx, hy);",
    "    tipG.clear();",
    "    tipG.lineStyle({ width: S.wLen(cfg.spearWidth * 0.38), color: cfg.coreColor, alpha: 1, cap: 'round' });",
    "    tipG.moveTo(tx, ty); tipG.lineTo(hx, hy);",
    "  } });",
    "  playSfx('sfxStab', 'sfxStabVol');",
    "  // The hit knocks them: a decaying kick along the spear's own line.",
    "  const kick = S.wLen(cfg.spearJolt);",
    "  oni.tween({ from: 1, to: 0, duration: cfg.spearGapMs * 1.4, ease: E.outQuad, onUpdate: function (v) {",
    "    joltX = Math.cos(ang) * kick * v; joltY = Math.sin(ang) * kick * v;",
    "  } });",
    "  oni.tween({ from: 1, to: 0, duration: 420, ease: E.outQuad, onUpdate: function (v) {",
    "    shaft.alpha = v; tipG.alpha = v;",
    "  } }).then(function () { try { shaft.destroy(); tipG.destroy(); } catch (e) {} });",
    "  await wait(cfg.spearGapMs);",
    "}",
    "",
    "await struggling;",
    "joltX = 0; joltY = 0;",
    "",
    "// The cross detonates.",
    "playSfx('sfxBoom', 'sfxBoomVol');",
    "if (cfg.boomWebm) fxWebm(cfg.boomWebm, lifted.x, lifted.y, { size: S.hPx(cfg.boomSize), parent: host, z: 96000 });",
    "oni.screenshake({ duration: cfg.shakeMs, intensity: 11 });",
    "",
    "const blowing = oni.tween({ from: 1, to: 0, duration: cfg.detonateMs, ease: E.outQuad, onUpdate: function (v) {",
    "  cross.alpha = v;",
    "  cross.scale.set(1 + (1 - v) * 1.5);",
    "} });",
    "const flashing = oni.domFlash({ color: cfg.flashColor, alpha: cfg.flashAlpha,",
    "  fadeIn: cfg.flashInMs, hold: 90, fadeOut: cfg.flashOutMs, onPeak: function () { done(); } });",
    "await Promise.all([blowing, flashing]);",
    "try { cross.destroy({ children: true }); } catch (e) {}",
    "",
    "// Set them back down before the real token is handed back.",
    "await oni.tween({ from: 0, to: 1, duration: 420, ease: E.inOutQuad, onUpdate: function (v) {",
    "  if (vic) vic.position.set(lifted.x + (t.x - lifted.x) * v, lifted.y + (t.y - lifted.y) * v);",
    "} });",
    "restoreVictim();",
    "try { if (vic) vic.destroy(); } catch (e) {}",
    "",
    "await Promise.all([",
    "  oni.tween({ from: cfg.bystanderTo, to: 1, duration: cfg.camOutMs, ease: E.inOutQuad,",
    "    onUpdate: function (v) { bystanderHold = v; } }),",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "]);",
    "restoreBystanders();",
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
    // It no longer flies in from her: it CONDEMNS from above, filling the frame
    // and closing onto the victim. `startScreenFrac` is its opening size as a
    // fraction of viewport height, so it starts larger than the screen.
    startScreenFrac: 1.5, travelMs: 900,
    // Where it settles: a fraction of the victim's sprite half-height ABOVE
    // their centre, so it hangs over them rather than covering them.
    overheadFrac: 0.78,
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
    "",
    "// It hangs OVER the victim, not on them — the badge that persists after",
    "// this sits overhead too, so the two agree.",
    "const halfH = (prime.mesh && prime.mesh.height ? prime.mesh.height : (prime.h || 100)) * 0.5;",
    "const seat = { x: t.x, y: t.y - halfH * cfg.overheadFrac };",
    "",
    "// Opens larger than the frame and closes onto them. The scale is derived",
    "// from the viewport so it fills the screen at any zoom.",
    "const bigScale = S.hPx(cfg.startScreenFrac) / Math.max(1, S.wLen(cfg.markSize));",
    "mark.position.set(seat.x, seat.y);",
    "mark.scale.set(bigScale);",
    "mark.alpha = 0;",
    "host.addChild(mark);",
    "",
    "await oni.tween({ from: 0, to: 1, duration: cfg.travelMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  mark.scale.set(bigScale + (1 - bigScale) * v);",
    "  mark.alpha = Math.min(1, v * 2.4);",
    "  mark.rotation = (1 - v) * -0.35;",
    "} });",
    "",
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "oni.particles({ x: seat.x, y: seat.y, count: cfg.emberCount, color: cfg.color, size: 12,",
    "  radius: S.wLen(cfg.emberRadius), life: 800, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "",
    "// Brand slam: overshoot then settle, so it reads as being burned ON.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.slamMs, ease: E.outQuad, onUpdate: (v) => {",
    "  mark.scale.set(1.25 - v * 0.25);",
    "} });",
    "",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "const ring = new PIXI.Sprite(glow);",
    "ring.anchor.set(0.5);",
    "ring.tint = cfg.color;",
    "ring.blendMode = PIXI.BLEND_MODES.ADD;",
    "ring.position.set(seat.x, seat.y);",
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
  heavyClaw,
  stormCalm,
  condemn,
  torment,
  searingBrand,
  draconicDomination,
  cruelUltimatum,
};
