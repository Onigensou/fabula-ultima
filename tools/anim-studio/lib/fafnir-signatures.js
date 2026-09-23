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
    // The stand-ins must match the tokens that are about to replace them, so
    // their size is DERIVED the way Foundry derives a token's, not guessed as a
    // fraction of hers. Each entry is the drake's prototype token: `w` in grid
    // units and `scale` its texture scale. A guessed fraction had them ~60%
    // oversized, and the handoff to the real token was a visible shrink.
    fireTok: { w: 1, scale: 1.95 },
    boltTok: { w: 1, scale: 1.80 },

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
    "const dx = halfW * cfg.flankFrac;",
    "const dy = -halfW * cfg.riseFrac;",
    "const spotFire = { x: home.x - dx, y: home.y + dy };",
    "const spotBolt = { x: home.x + dx, y: home.y + dy };",
    "",
    "// Reproduce Foundry's own token sizing so the stand-in is the size of the",
    "// token that replaces it: CONTAIN the texture into the grid frame, then",
    "// apply the texture scale. Anything else shows as a pop at the handoff.",
    "const grid = (canvas.scene && canvas.scene.grid ? canvas.scene.grid.size : 100);",
    "async function drakeSprite(url, tok) {",
    "  if (!url) return null;",
    "  let tex = null;",
    "  try { tex = await loadTexture(url); } catch (e) { return null; }",
    "  if (!tex || !tex.width || !tex.height) return null;",
    "  const frame = grid * ((tok && tok.w) || 1);",
    "  const fit = Math.min(frame / tex.width, frame / tex.height);",
    "  const sc = (tok && tok.scale) || 1;",
    "  const sp = new PIXI.Sprite(tex);",
    "  sp.anchor.set(0.5);",
    "  sp.width = tex.width * fit * sc;",
    "  sp.height = tex.height * fit * sc;",
    "  sp.alpha = 0;",
    "  host.addChild(sp);",
    "  return sp;",
    "}",
    "",
    "const fire = await drakeSprite(A.fireDrake, cfg.fireTok);",
    "const bolt = await drakeSprite(A.boltDrake, cfg.boltTok);",
    "// Motion distances key off each drake's own width, so a re-scaled token",
    "// keeps the same stride and arc rather than drifting out of proportion.",
    "const fireW = fire ? fire.width : grid;",
    "const boltW = bolt ? bolt.width : grid;",
    "",
    "playSfx('sfx', 'sfxVol');",
    "",
    "// ── Flame Drake: heavy stepped walk, left to right ──",
    "async function walkIn() {",
    "  if (!fire) return;",
    "  const from = { x: spotFire.x - fireW * cfg.walkFromFrac, y: spotFire.y };",
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
    "                        from.y - Math.sin(v * Math.PI) * fireW * cfg.walkBobFrac);",
    "    } });",
    "    // Settle: the weight comes down before the next stride.",
    "    if (i < cfg.walkSteps - 1) {",
    "      await oni.tween({ from: 0, to: 1, duration: cfg.walkSettleMs, ease: E.inOutQuad, onUpdate: function (v) {",
    "        if (!fire) return;",
    "        fire.position.set(fire.position.x, from.y + Math.sin(v * Math.PI) * fireW * 0.012);",
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
    "  const over = { x: spotBolt.x + boltW * cfg.flyOvershootFrac, y: spotBolt.y - boltW * 0.05 };",
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

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: cfg.totalTimeoutMs });
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
    //
    // Sized as a fraction of HER sprite width and nothing else. The first pass
    // took the LARGER of a fixed px size and a multiple of her half-width,
    // which on a sprite as big as hers meant the multiple always won and the
    // effect swallowed her. A single fraction cannot run away like that.
    healWebm: null, healWidthFrac: 0.62, healMs: 1600,
    holdMs: 500,
    // Ordered, not overlapped: the water drop is the CUE, then the effect and
    // its chime arrive together as the result. `dropLeadMs` is the gap that
    // lets the drop finish being a separate sound before the heal lands on it.
    sfxCue: null, sfxCueVol: 0.55,
    dropLeadMs: 620,
    sfxHeal: null, sfxHealVol: 0.6,
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
    "// The drop is the cue and lands alone.",
    "playSfx('sfxCue', 'sfxCueVol');",
    "await wait(cfg.dropLeadMs);",
    "",
    "// Then the effect and its chime arrive TOGETHER — the chime is the sound of",
    "// the heal, so firing it on a different beat reads as two unrelated events.",
    "const spriteW = (caster.mesh && caster.mesh.width ? caster.mesh.width : (caster.w || 100));",
    "playSfx('sfxHeal', 'sfxHealVol');",
    "const fx = await fxWebm(cfg.healWebm, home.x, home.y, {",
    "  size: spriteW * cfg.healWidthFrac, parent: host, z: 95000 });",
    "",
    "// The recovery lands with the effect, not after it.",
    "done();",
    "await wait(cfg.healMs);",
    "",
    "try { if (fx && fx.sprite) fx.sprite.destroy(); } catch (e) {}",
    "await wait(cfg.holdMs);",
    "await Promise.all([",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "]);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Condemn ─────────────────────────────────────────────────────────────── */
//
// A sentence carried out. The arena empties to leave only the accuser and the
// accused, the victim is hauled off the ground and pinned by needles thrown
// from every edge of the frame, and then the whole thing goes off at once,
// dropping them.
//
// There is NO cross. An earlier pass hung one over the victim and scaled it in
// before the needles; the impalement already carries the image on its own, and
// the cross was a second symbol competing with it for the same beat. Removing
// it also gives the needles the time the cross was spending.

function condemn(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.75, camInMs: 1200, camOutMs: 1100,
    dimTo: 0.62, dimMs: 800,
    // Everyone who is not the accuser or the accused fades out of the frame.
    bystanderFadeMs: 700, bystanderTo: 0.0,
    // The victim is hauled off the ground and struggles — until the first
    // needle, after which they are pinned and held.
    liftFrac: 0.42, liftMs: 700, struggleAmp: 9, struggleSettleMs: 260,
    struggleHoldMs: 620,
    // Needles thrown in from the edges. They STAY in until the detonation.
    spearCount: 7, spearFlightMs: 260, spearGapMs: 150,
    spearLenFrac: 0.30, spearWidth: 20, spearJolt: 13,
    spearHitParticles: 16, spearHitRadius: 120,
    color: 0x9d4dff, coreColor: 0xf0e2ff,
    pinnedHoldMs: 620,
    // Detonation — the needles go off together.
    boomWebm: null, boomSize: 1.5,   // fraction of viewport height
    detonateMs: 620,
    burstParticles: 40, burstRadius: 320,
    // Dropped: they fall hard and hit the ground.
    dropMs: 300, dropShakeMs: 520, dropShakeAmp: 16,
    flashColor: "#b98cff", flashAlpha: 0.55, flashInMs: 140, flashOutMs: 760,
    shakeMs: 820,
    sfxCast: null, sfxCastVol: 0.5,
    sfxStab: null, sfxStabVol: 0.6,
    sfxBoom: null, sfxBoomVol: 0.85,
    totalTimeoutMs: 32000,
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
    "// Needles that have landed live in this rig, positioned RELATIVE to the",
    "// victim. Moving the rig with them is what lets them stay stuck in as the",
    "// body moves, instead of hanging in the air where they hit.",
    "const rig = new PIXI.Container();",
    "rig.position.set(lifted.x, lifted.y);",
    "host.addChild(rig);",
    "",
    "// One shared offset driver: the victim and the rig read the same values, so",
    "// anything pinned to them tracks exactly.",
    "let joltX = 0, joltY = 0;",
    "let struggling = true;",
    "// Amplitude of the thrash, dialled to 0 once the needles start: a body that",
    "// is already pinned should be HELD, and the only motion left is the kick",
    "// each hit delivers. Leaving the tremor running underneath made the impacts",
    "// unreadable, because everything was moving all the time.",
    "let ampNow = cfg.struggleAmp;",
    "const struggle = function () {",
    "  if (!struggling) return;",
    "  const amp = S.wLen(ampNow);",
    "  const ox = (Math.random() * 2 - 1) * amp + joltX;",
    "  const oy = (Math.random() * 2 - 1) * amp * 0.6 + joltY;",
    "  if (vic && !vic.destroyed) {",
    "    vic.position.set(lifted.x + ox, lifted.y + oy);",
    "    vic.rotation = (Math.random() * 2 - 1) * 0.03 * (ampNow / (cfg.struggleAmp || 1));",
    "  }",
    "  if (rig && !rig.destroyed) rig.position.set(lifted.x + ox, lifted.y + oy);",
    "};",
    "PIXI.Ticker.shared.add(struggle);",
    "",
    "// Let the struggling read on its own before anything hits them.",
    "await wait(cfg.struggleHoldMs);",
    "",
    "// Hold still from here. The struggle was for the helplessness BEFORE the",
    "// sentence; from the first needle they are pinned.",
    "const settleFrom = ampNow;",
    "await oni.tween({ from: 1, to: 0, duration: cfg.struggleSettleMs, ease: E.outQuad,",
    "  onUpdate: function (v) { ampNow = settleFrom * v; } });",
    "ampNow = 0;",
    "",
    "// Needles thrown from the EDGES of the frame. Screen anchors, so they come",
    "// from off-frame whatever the camera is doing.",
    "const anchors = [",
    "  S.S2W(0, 0), S.S2W(1, 0), S.S2W(0, 1), S.S2W(1, 1),",
    "  S.S2W(0.5, 0), S.S2W(0, 0.5), S.S2W(1, 0.5), S.S2W(0.5, 1),",
    "];",
    "",
    "// A needle: a long tapered spike, wide at the tail and sharp at the point.",
    "// Drawn as a polygon rather than a capped line, because a round cap gives a",
    "// blunt dowel and this has to read as something that PIERCES.",
    "function needle(len, w, color, alpha) {",
    "  const g = new PIXI.Graphics();",
    "  g.beginFill(color, alpha);",
    "  g.moveTo(0, 0);",
    "  g.lineTo(-len * 0.82, -w * 0.5);",
    "  g.lineTo(-len, 0);",
    "  g.lineTo(-len * 0.82, w * 0.5);",
    "  g.closePath();",
    "  g.endFill();",
    "  g.blendMode = PIXI.BLEND_MODES.ADD;",
    "  return g;",
    "}",
    "",
    "const pinned = [];",
    "for (let i = 0; i < cfg.spearCount; i++) {",
    "  const from = anchors[i % anchors.length];",
    "  const ang = Math.atan2(lifted.y - from.y, lifted.x - from.x);",
    "  const reach = S.hPx(cfg.spearLenFrac);",
    "  // Where on the body it lands — scattered, not all through one point.",
    "  const spread = S.wLen(cfg.struggleAmp) * 3.2;",
    "  const lx = (Math.random() * 2 - 1) * spread;",
    "  const ly = (Math.random() * 2 - 1) * spread * 0.8;",
    "  const spike = needle(reach, S.wLen(cfg.spearWidth), cfg.color, 0.95);",
    "  const core  = needle(reach * 0.9, S.wLen(cfg.spearWidth) * 0.38, cfg.coreColor, 1);",
    "  spike.rotation = ang; core.rotation = ang;",
    "  const flightFrom = { x: from.x - lifted.x, y: from.y - lifted.y };",
    "  spike.position.set(flightFrom.x, flightFrom.y);",
    "  core.position.set(flightFrom.x, flightFrom.y);",
    "  rig.addChild(spike, core);",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.spearFlightMs, ease: E.inQuad, onUpdate: function (v) {",
    "    const px = flightFrom.x + (lx - flightFrom.x) * v;",
    "    const py = flightFrom.y + (ly - flightFrom.y) * v;",
    "    spike.position.set(px, py); core.position.set(px, py);",
    "  } });",
    "  playSfx('sfxStab', 'sfxStabVol');",
    "  // Impact spray at the point of entry, in WORLD space so it does not ride",
    "  // the body afterwards.",
    "  oni.particles({ x: rig.position.x + lx, y: rig.position.y + ly,",
    "    count: cfg.spearHitParticles, color: cfg.coreColor, size: 11,",
    "    radius: S.wLen(cfg.spearHitRadius), life: 620, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "  // The hit knocks them: a decaying kick along the needle's own line.",
    "  const kick = S.wLen(cfg.spearJolt);",
    "  oni.tween({ from: 1, to: 0, duration: cfg.spearGapMs * 1.4, ease: E.outQuad, onUpdate: function (v) {",
    "    joltX = Math.cos(ang) * kick * v; joltY = Math.sin(ang) * kick * v;",
    "  } });",
    "  // They STAY IN. Nothing fades here — they all go at the detonation.",
    "  pinned.push(spike, core);",
    "  await wait(cfg.spearGapMs);",
    "}",
    "",
    "await wait(cfg.pinnedHoldMs);",
    "joltX = 0; joltY = 0;",
    "",
    "// ── Detonation: every needle goes off at once ──",
    "playSfx('sfxBoom', 'sfxBoomVol');",
    "if (cfg.boomWebm) fxWebm(cfg.boomWebm, rig.position.x, rig.position.y, { size: S.hPx(cfg.boomSize), parent: host, z: 96000 });",
    "oni.particles({ x: rig.position.x, y: rig.position.y, count: cfg.burstParticles,",
    "  color: cfg.color, size: 15, radius: S.wLen(cfg.burstRadius), life: 950,",
    "  blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "oni.screenshake({ duration: cfg.shakeMs, intensity: 11 });",
    "",
    "// The needles blow outward as they go, rather than simply vanishing.",
    "const blowing = oni.tween({ from: 0, to: 1, duration: cfg.detonateMs, ease: E.outQuad, onUpdate: function (v) {",
    "  for (const s of pinned) {",
    "    if (!s || s.destroyed) continue;",
    "    s.alpha = 1 - v;",
    "    s.scale.set(1 + v * 0.6);",
    "  }",
    "} });",
    "const flashing = oni.domFlash({ color: cfg.flashColor, alpha: cfg.flashAlpha,",
    "  fadeIn: cfg.flashInMs, hold: 90, fadeOut: cfg.flashOutMs, onPeak: function () { done(); } });",
    "await Promise.all([blowing, flashing]);",
    "for (const s of pinned) { try { s.destroy(); } catch (e) {} }",
    "",
    "// DROPPED. Nothing is holding them up any more and they fall hard.",
    "struggling = false;",
    "try { PIXI.Ticker.shared.remove(struggle); } catch (e) {}",
    "const fallFrom = { x: vic ? vic.position.x : lifted.x, y: vic ? vic.position.y : lifted.y };",
    "await oni.tween({ from: 0, to: 1, duration: cfg.dropMs, ease: E.inQuad, onUpdate: function (v) {",
    "  if (vic && !vic.destroyed) {",
    "    vic.position.set(fallFrom.x + (t.x - fallFrom.x) * v, fallFrom.y + (t.y - fallFrom.y) * v);",
    "    vic.rotation = 0.05 * v;",
    "  }",
    "} });",
    "// They hit the ground.",
    "oni.screenshake({ duration: cfg.dropShakeMs, intensity: 9 });",
    "await oni.tween({ from: 1, to: 0, duration: cfg.dropShakeMs, ease: E.outQuad, onUpdate: function (v) {",
    "  if (!vic || vic.destroyed) return;",
    "  const a = S.wLen(cfg.dropShakeAmp) * v;",
    "  vic.position.set(t.x + (Math.random() * 2 - 1) * a, t.y + (Math.random() * 2 - 1) * a * 0.5);",
    "  vic.rotation = 0.05 * v;",
    "} });",
    "if (vic && !vic.destroyed) { vic.position.set(t.x, t.y); vic.rotation = 0; }",
    "",
    "restoreVictim();",
    "try { if (vic) vic.destroy(); } catch (e) {}",
    "try { rig.destroy({ children: true }); } catch (e) {}",
    "",
    "await Promise.all([",
    "  oni.tween({ from: cfg.bystanderTo, to: 1, duration: cfg.camOutMs, ease: E.inOutQuad,",
    "    onUpdate: function (v) { bystanderHold = v; } }),",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "]);",
    "restoreBystanders();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Torment ─────────────────────────────────────────────────────────────── */
//
// No damage — this is pure dread. Dim, drift onto the victim, a leering face
// swells overhead, laughs, then sinks INTO them and they shudder.

function torment(opts = {}) {
  const cfg = Object.assign({
    // NO camera move. Torment is a standard action; a push-in and a pull-out
    // made it play like Draconic Domination, which is a Zero Power, and the
    // two should not feel the same size. The dim alone sets it apart from a
    // basic attack, which is all the weight this one needs.
    dimTo: 0.62, dimMs: 900, undimMs: 1200,
    beatMs: 380,

    // A single fear icon seated ABOVE the victim, which is the shape the
    // original mask had and the shape this arc wants: one thing hangs over
    // them, leers, and then goes in. The eye PAIR that briefly lived here was
    // Domination's, and flanking only makes sense when nothing has to sink.
    iconSize: 0.42,         // fraction of viewport HEIGHT
    riseFrac: 0.85,         // seats it above the token, off the sprite height
    breatheHz: 1.6, breatheDepth: 0.06,
    rockDepth: 0.06,        // radians of sway across the leer
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
    "await wait(cfg.beatMs);",
    "",
    "// A fear icon hung above the victim. Seated off the SPRITE height rather",
    "// than a screen fraction, because it has to end up going into the token:",
    "// the start of the move and the end of it both belong to them.",
    "const halfH = (prime.mesh && prime.mesh.height ? prime.mesh.height : (prime.h || 100)) * 0.5;",
    "const above = { x: t.x, y: t.y - halfH * cfg.riseFrac };",
    "const icon = await oni.webm(A.fearIcon, {",
    "  size: S.hPx(cfg.iconSize), x: above.x, y: above.y, parent: host,",
    "  loop: true, zIndex: 95600, alpha: 0,",
    "});",
    "const mark = (icon && icon.sprite) ? icon.sprite : null;",
    "// NO additive blend: the art is dark purple, and ADD over a dimmed scene",
    "// washes it out to nothing. It carries its own glow.",
    "// oni.webm sets width, which sets scale — capture it as the 1.0 the",
    "// breathe and the sink are measured against.",
    "const base = mark ? mark.scale.x : 1;",
    "",
    "playSfx('sfxLaugh', 'sfxLaughVol');",
    "await oni.tween({ from: 0, to: 1, duration: cfg.scaleInMs, ease: E.outQuad, onUpdate: (v) => {",
    "  if (!mark) return;",
    "  mark.scale.set(base * (0.05 + v * 0.95));",
    "  mark.alpha = v;",
    "} });",
    "",
    "// Leer — it breathes and rocks while the laugh plays out.",
    "const leer0 = performance.now();",
    "await oni.tween({ from: 0, to: 1, duration: cfg.leerMs, ease: E.linear, onUpdate: (v) => {",
    "  if (!mark) return;",
    "  const sw = Math.sin((performance.now() - leer0) / 1000 * cfg.breatheHz * Math.PI * 2);",
    "  mark.scale.set(base * (1 + sw * cfg.breatheDepth));",
    "  mark.rotation = Math.sin(v * Math.PI * 2) * cfg.rockDepth;",
    "} });",
    "",
    "// Sink INTO them: shrink and slide down onto the victim, not just fade.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.descendMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (!mark) return;",
    "  mark.position.set(above.x + (t.x - above.x) * v, above.y + (t.y - above.y) * v);",
    "  mark.scale.set(base * (1 - v * 0.82));",
    "  mark.rotation = mark.rotation * (1 - v);",
    "  mark.alpha = 1 - v * 0.85;",
    "} });",
    "try { if (mark) mark.destroy(); } catch (e) {}",
    "",
    "// The debuffs land as it goes in.",
    "done();",
    "await shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "",
    "// Nothing to restore: the camera never moved.",
    "await dim.fadeOut({ duration: cfg.undimMs });",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: cfg.totalTimeoutMs });
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
    // Impact assets, sized off the VICTIM's sprite so they read the same on a
    // mook and on a boss.
    shockWebm: null, shockWidthFrac: 2.2,
    dustWebm: null,  dustWidthFrac: 2.6,
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
    "// The authored sigil, matching what the persistent badge shows, so the",
    "// mark that LANDS and the mark that STAYS are the same sign. If the art",
    "// fails to load the drawn chevron takes over — the same fallback the badge",
    "// uses — because losing the asset must not cost the whole shot.",
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
    "// Sized by HEIGHT and given its own aspect, so a non-square sigil is not",
    "// squashed into the square the chevron happened to occupy.",
    "let markH = S.wLen(cfg.markSize);",
    "let sigil = null;",
    "if (A.markIcon) {",
    "  try {",
    "    const tex = await loadTexture(A.markIcon);",
    "    if (tex && tex.width && tex.height) {",
    "      sigil = new PIXI.Sprite(tex);",
    "      sigil.anchor.set(0.5);",
    "      sigil.height = markH;",
    "      sigil.width = markH * (tex.width / tex.height);",
    "      mark.addChild(sigil);",
    "    }",
    "  } catch (e) { sigil = null; }",
    "}",
    "if (!sigil) mark.addChild(chev(cfg.color, S.wLen(26), 0.95), chev(cfg.coreColor, S.wLen(10), 1));",
    "",
    "// It hangs OVER the victim, not on them — the badge that persists after",
    "// this sits overhead too, so the two agree.",
    "const halfH = (prime.mesh && prime.mesh.height ? prime.mesh.height : (prime.h || 100)) * 0.5;",
    "const seat = { x: t.x, y: t.y - halfH * cfg.overheadFrac };",
    "",
    "// Opens larger than the frame and closes onto them. The scale is derived",
    "// from the viewport so it fills the screen at any zoom.",
    "// Opening size is derived from the mark's real height, so the sigil and",
    "// the fallback chevron both start at the same fraction of the viewport.",
    "const bigScale = S.hPx(cfg.startScreenFrac) / Math.max(1, markH);",
    "mark.position.set(seat.x, seat.y);",
    "mark.scale.set(bigScale);",
    "mark.alpha = 0;",
    "host.addChild(mark);",
    "",
    "// Straight in, no spin — the rotation read as a flourish on something that",
    "// is meant to land like a verdict.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.travelMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  mark.scale.set(bigScale + (1 - bigScale) * v);",
    "  mark.alpha = Math.min(1, v * 2.4);",
    "} });",
    "",
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "// Impact assets land on the VICTIM, not on the mark's overhead seat — the",
    "// brand is burned onto them, so the burst belongs where they are.",
    "const vicW = (prime.mesh && prime.mesh.width ? prime.mesh.width : (prime.w || 100));",
    "if (cfg.shockWebm) fxWebm(cfg.shockWebm, t.x, t.y, { size: vicW * cfg.shockWidthFrac, parent: host, z: 95200 });",
    "if (cfg.dustWebm)  fxWebm(cfg.dustWebm,  t.x, t.y, { size: vicW * cfg.dustWidthFrac,  parent: host, z: 95100 });",
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

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: cfg.totalTimeoutMs });
}

/* ── Draconic Domination ─────────────────────────────────────────────────── */
//
// One creature is singled out and stared into submission. The arena empties
// down to them, the camera closes in, and a pair of draconic eyes opens in the
// air on either side of them inside a cage of speedlines.
//
// A single-target control effect, so the shot NAMES its victim: an earlier pass
// hung one eye at screen centre and never referenced the target at all, which
// played identically no matter who was being Charmed — on the one action where
// who got hit is the entire outcome.
//
// The eyes open SQUASHED and stretch vertically to full height, which is what
// makes them read as opening rather than fading in.

function draconicDomination(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.7, camInMs: 1200, camOutMs: 1600,
    dimTo: 0.66, dimMs: 800,
    // Everyone EXCEPT the victim leaves the frame — the caster included. This
    // is about the creature being looked at, not about who is looking.
    bystanderFadeMs: 700, bystanderTo: 0.0,

    // The curse plate is sized off the SCREEN, not the token: fxSize is a
    // fraction of viewport HEIGHT, so it holds its framing on any window
    // rather than scaling off a sprite whose size has nothing to do with the
    // shot.
    //
    // 1.15 is a chosen framing, not a fit. The JB2A art occupies only ~30% of
    // its own 600x600 frame and the rest is transparent padding, so this lands
    // the visible sigil at roughly a third of frame height with the victim
    // inside the pupil. Sizing the frame so the art ran edge to edge needed
    // ~3.0 and was tried and rejected: it cropped the sigil's crown and lower
    // point off the frame, and a ~5x upscale of a 600px source went soft.
    fxSize: 1.15,
    fxFrom: 0.72,           // scale it grows in FROM, so it arrives rather than cuts
    openMs: 900,

    // Idle: the stare holds while the eyes breathe and the lines keep tearing.
    idleMs: 3000, glowHz: 1.6, glowDepth: 0.22,

    // Speedlines around the border.
    lineCount: 132, lineColor: 0x140704, lineAlpha: 0.34,
    // The clear centre the lines stop short of. Radius in VIEWPORT-HEIGHT
    // units (0.5 = half the screen height), so the hole is a true circle in
    // pixels rather than something that stretches with the window.
    holeR: 0.34, holeSpread: 0.10,
    lineWidth: 0.016,                     // fraction of viewport height, at the rim
    lineChurnMs: 70,                      // how often the field is re-cast
    lineRampMs: 500,

    closeMs: 520,
    sfx: null, sfxVol: 0.65,
    sfxOpen: null, sfxOpenVol: 0.7,
    totalTimeoutMs: 34000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 96500 });",
    "const t = ctr(prime);",
    "",
    "const dim = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "",
    "// Clear the frame of EVERYONE but the victim — the caster too. Alpha is",
    "// re-asserted each tick because Foundry refreshes tokens on its own",
    "// schedule and would otherwise fade them back in mid-shot.",
    "const keep = new Set([prime.id]);",
    "const others = (canvas.tokens.placeables || []).filter(function (x) { return x && !keep.has(x.id); });",
    "const priorAlpha = new Map();",
    "for (const b of others) { priorAlpha.set(b.id, (b.mesh && b.mesh.alpha != null) ? b.mesh.alpha : 1); }",
    "let hold = 1;",
    "const holdOthers = function () {",
    "  for (const b of others) { if (b && b.mesh && !b.destroyed) b.mesh.alpha = hold; }",
    "};",
    "PIXI.Ticker.shared.add(holdOthers);",
    "const restoreOthers = function () {",
    "  try { PIXI.Ticker.shared.remove(holdOthers); } catch (e) {}",
    "  for (const b of others) {",
    "    if (!b || b.destroyed) continue;",
    "    const a = priorAlpha.has(b.id) ? priorAlpha.get(b.id) : 1;",
    "    try { if (b.mesh) b.mesh.alpha = a; } catch (e) {}",
    "    try { b.renderFlags.set({ refreshVisibility: true, refreshMesh: true }); } catch (e) {}",
    "  }",
    "};",
    "",
    "// Dim and empty the frame, THEN close on them — the pan should arrive on a",
    "// stage that is already theirs alone.",
    "await oni.tween({ from: 1, to: cfg.bystanderTo, duration: cfg.bystanderFadeMs, ease: E.inOutQuad,",
    "  onUpdate: function (v) { hold = v; } });",
    "await oni.camera.focus({ point: t, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "",
    "playSfx('sfx', 'sfxVol');",
    "",
    "// ── Speedlines ──",
    "// Slivers driven in from the rim of the frame toward a clear circular",
    "// centre. Re-cast on a timer rather than tweened, because the violence is",
    "// in the field CHANGING — a fixed set of lines just reads as a decorative",
    "// border.",
    "const lines = new PIXI.Graphics();",
    "host.addChild(lines);",
    "let lineGain = 0;",
    "let lastChurn = 0;",
    "const castLines = function () {",
    "  lines.clear();",
    "  if (lineGain <= 0.001) return;",
    "  const W = S.W, H = S.H;",
    "  for (let i = 0; i < cfg.lineCount; i++) {",
    "    // Polar, not per-edge. Anchoring lines to the four sides and pushing",
    "    // them along the edge normal builds a RECTANGLE by construction: the",
    "    // inner tips land on a box and the corners read as corners. Here every",
    "    // line rides a ray from the centre, so the negative space it leaves is",
    "    // round. The angle is stratified rather than uniform-random so the",
    "    // fringe stays dense instead of clumping and leaving bald arcs.",
    "    const AR = W / H;",
    "    const th = (i + Math.random()) / cfg.lineCount * Math.PI * 2;",
    "    const cs = Math.cos(th), sn = Math.sin(th);",
    "    // r is measured in viewport-HEIGHT units along the ray, so equal r is",
    "    // equal pixels in every direction: that is what makes the hole circular",
    "    // on a wide window instead of an ellipse.",
    "    const dxF = cs / AR, dyF = sn;",
    "    const rRim = Math.min(",
    "      Math.abs(dxF) > 1e-6 ? 0.5 / Math.abs(dxF) : 1e9,",
    "      Math.abs(dyF) > 1e-6 ? 0.5 / Math.abs(dyF) : 1e9);",
    "    const rHole = cfg.holeR + Math.random() * cfg.holeSpread;",
    "    if (rHole >= rRim) continue;",
    "    // Gain drives the tip inward from the rim, so the field grows in.",
    "    const rTip = rRim - (rRim - rHole) * lineGain;",
    "    const rOut = rRim * 1.06;",
    "    const halfW = cfg.lineWidth * (0.35 + Math.random() * 0.65) * 0.5;",
    "    const pxF = -sn / AR, pyF = cs;",
    "    // Screen-space points, converted to world so the field sits still under",
    "    // the parked camera and cannot drift if anything nudges it.",
    "    const at = function (r, w) { return { x: 0.5 + dxF * r + pxF * w, y: 0.5 + dyF * r + pyF * w }; };",
    "    const tipF = at(rTip, 0);",
    "    const aF = at(rOut, halfW);",
    "    const bF = at(rOut, -halfW);",
    "    const tip = S.S2W(tipF.x, tipF.y);",
    "    const a = S.S2W(aF.x, aF.y);",
    "    const b = S.S2W(bF.x, bF.y);",
    "    lines.beginFill(cfg.lineColor, cfg.lineAlpha * lineGain);",
    "    lines.moveTo(a.x, a.y); lines.lineTo(tip.x, tip.y); lines.lineTo(b.x, b.y);",
    "    lines.closePath(); lines.endFill();",
    "  }",
    "};",
    "const churn = function () {",
    "  const now = performance.now();",
    "  if (now - lastChurn < cfg.lineChurnMs) return;",
    "  lastChurn = now;",
    "  castLines();",
    "};",
    "PIXI.Ticker.shared.add(churn);",
    "oni.tween({ from: 0, to: 1, duration: cfg.lineRampMs, ease: E.outQuad,",
    "  onUpdate: function (v) { lineGain = v; } });",
    "",
    "// ── The curse field ──",
    "// FULL SCREEN, not pinned to the token. The shot has already emptied the",
    "// frame down to the victim and parked the camera on them, so the plate IS",
    "// the frame; sizing it off the sprite would undo all of that and make the",
    "// biggest beat in the action the smallest thing on screen.",
    "const fxAt = S.S2W(0.5, 0.5);",
    "const curse = await oni.webm(A.curseFx, {",
    "  size: S.hPx(cfg.fxSize), x: fxAt.x, y: fxAt.y, parent: host,",
    "  loop: true, zIndex: 96800, blend: PIXI.BLEND_MODES.ADD, alpha: 0,",
    "});",
    "const plate = (curse && curse.sprite) ? curse.sprite : null;",
    "// oni.webm sets width, which sets scale — capture that as the 1.0 the",
    "// grow-in and the breath are both measured against.",
    "const fxBase = plate ? plate.scale.x : 1;",
    "",
    "playSfx('sfxOpen', 'sfxOpenVol');",
    "// It arrives by growing into frame rather than cutting in.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.openMs, ease: E.outQuad, onUpdate: function (v) {",
    "  if (!plate) return;",
    "  plate.alpha = v;",
    "  plate.scale.set(fxBase * (cfg.fxFrom + (1 - cfg.fxFrom) * v));",
    "} });",
    "",
    "// The stare has landed — this is the moment the save is made against.",
    "done();",
    "",
    "// ── Idle hold: the field breathes, the lines keep tearing ──",
    "const t0 = performance.now();",
    "await oni.tween({ from: 0, to: 1, duration: cfg.idleMs, ease: E.linear, onUpdate: function () {",
    "  if (!plate) return;",
    "  const s = Math.sin((performance.now() - t0) / 1000 * cfg.glowHz * Math.PI * 2);",
    "  plate.scale.set(fxBase * (1 + s * cfg.glowDepth * 0.25));",
    "  plate.alpha = 0.8 + s * 0.2;",
    "} });",
    "",
    "// ── Cleanup, then return ──",
    "await oni.tween({ from: 1, to: 0, duration: cfg.closeMs, ease: E.inOutQuad, onUpdate: function (v) {",
    "  if (plate) plate.alpha = v;",
    "  lineGain = v;",
    "} });",
    "try { PIXI.Ticker.shared.remove(churn); } catch (e) {}",
    "try { lines.destroy(); } catch (e) {}",
    "try { if (plate) plate.destroy(); } catch (e) {}",
    "",
    "// Return it the way it came. These three used to run in sequence, which",
    "// meant the camera pulled out UNDER a 0.66 dim with nothing else moving —",
    "// the move was invisible, and the dim lifting afterwards revealed framing",
    "// that had already arrived. It read as a cut even though the pan was",
    "// tweened the whole way. Run together, the pull-out is what the eye is",
    "// following while the light and the cast come back up around it.",
    "await Promise.all([",
    "  oni.tween({ from: cfg.bystanderTo, to: 1, duration: cfg.camOutMs, ease: E.inOutQuad,",
    "    onUpdate: function (v) { hold = v; } }),",
    "  oni.camera.restore({ duration: cfg.camOutMs }),",
    "  dim.fadeOut({ duration: cfg.camOutMs }),",
    "]);",
    "// Only now — the ticker is what pins alpha to hold while that tween runs.",
    "restoreOthers();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: cfg.totalTimeoutMs });
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

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: cfg.totalTimeoutMs });
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
