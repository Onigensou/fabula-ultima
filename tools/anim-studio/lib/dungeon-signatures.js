"use strict";
// ============================================================================
// Dungeon SIGNATURE animations — the bespoke shots.
//
// Same storage rules as dungeon-templates.js (exactly two backticks per file,
// no backtick anywhere in the inner). Same pacing rule: slow, quad/sine.
//
// A dim and a curtain are DIFFERENT TOOLS at different depths:
//   oni.sceneDim  — darkens the scene to spotlight the subject. Sits above the
//                   background and tiles but BELOW tokens and VFX, so the thing
//                   being highlighted stays lit. Never use a DOM sheet for this:
//                   DOM is above the whole canvas and buries the clones and VFX
//                   the dim exists to emphasise.
//   oni.domFlash  — whiteout / blackout / impact flash. A transition curtain, so
//                   it is meant to sit above essentially everything.
// World-anchored art uses oni.screenLive(), which re-reads the transform per
// access, so nothing slides off during a pan.
//
// Camera moves route through oni.camera, which clamps to the artwork. NOTE the
// zoom argument is a MULTIPLE OF REST SCALE, and rest framing already contains
// the whole stage — so zoom 1 is a no-op and every pan beat must zoom in past 1
// to read at all.
// ============================================================================

const { shell, inner } = require("./dungeon-templates.js");

/* ── Asura · Quad-Elemental Slash ────────────────────────────────────────── */
//
// Zoom in hard, dim, gather the four elements, beat, eye-flash, then the whole
// screen is slashes; whiteout with every combatant reduced to a black
// silhouette taking the hit; full white; hold; return.
//
// The whiteout is PIXI, not DOM, precisely because the silhouettes have to
// render ON TOP of it — DOM sits above the entire canvas, so a DOM sheet would
// bury them. The camera is parked by then, so world space is safe.

function quadElementalSlash(opts = {}) {
  const cfg = Object.assign({
    // Wide on purpose (see Rail Stream) — the user asked to keep the pull-back
    // on this shot. <1 is a zoom OUT from rest framing.
    camZoom: 0.85, camInMs: 1300, camOutMs: 1100,
    dimTo: 0.72, dimMs: 900,
    gatherMs: 1500, gatherPerElement: 22, gatherRadius: 300,
    elements: [0xffe75a, 0xff8a3d, 0x8fe2ff, 0xc6ffe4],
    beatMs: 650,
    eyeFlashMs: 260, eyeColor: 0xffffff, eyeSize: 46,
    slashCount: 14, slashWindowMs: 1500, slashFadeMs: 420, slashWidth: 12,
    whiteFadeMs: 320, whiteHoldMs: 900, whiteOutMs: 900,
    silhouetteAlpha: 1,
    screenshakeMs: 900, screenshakeAmp: 11,
    sfxCharge: null, sfxChargeVol: 0.6,
    sfxSlash: null, sfxSlashVol: 0.55,
    sfxImpact: null, sfxImpactVol: 0.8,
    totalTimeoutMs: 26000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 96000 });",
    "",
    "// 1. Push in on the Asura and drop the lights.",
    "const camming = oni.camera.focus({ point: home, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "const dimmer = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "await camming;",
    "",
    "// 2. Four elements spiral in, one colour per blade.",
    "playSfx('sfxCharge', 'sfxChargeVol');",
    "const gathers = cfg.elements.map((col, i) => wait(i * 140).then(() => oni.particles({",
    "  x: home.x, y: home.y, count: cfg.gatherPerElement, color: col, size: 15,",
    "  radius: S.wLen(cfg.gatherRadius), life: cfg.gatherMs - i * 140, mode: 'gather',",
    "  stagger: 500, blend: PIXI.BLEND_MODES.ADD, parent: host, ease: E.inOutQuad,",
    "})));",
    "await Promise.all(gathers);",
    "",
    "// 3. The beat before it moves.",
    "await wait(cfg.beatMs);",
    "",
    "// 4. Eyes flare.",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "const eye = new PIXI.Sprite(glow);",
    "eye.anchor.set(0.5);",
    "eye.tint = cfg.eyeColor;",
    "eye.blendMode = PIXI.BLEND_MODES.ADD;",
    "eye.position.set(home.x, home.y);",
    "eye.width = eye.height = 0;",
    "host.addChild(eye);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.eyeFlashMs, ease: E.outQuad, onUpdate: (v) => {",
    "  eye.width = eye.height = S.wLen(cfg.eyeSize) * v;",
    "  eye.alpha = v;",
    "} });",
    "",
    "// 5. Slashes cover the screen. Anchored via screenLive so they fill the",
    "//    viewport at whatever zoom the camera settled on.",
    "playSfx('sfxSlash', 'sfxSlashVol');",
    "oni.screenshake({ duration: cfg.screenshakeMs, intensity: cfg.screenshakeAmp });",
    "const perSlash = cfg.slashWindowMs / Math.max(1, cfg.slashCount);",
    "const slashRuns = [];",
    "for (let i = 0; i < cfg.slashCount; i++) {",
    "  const col = cfg.elements[i % cfg.elements.length];",
    "  const a = (Math.random() * 0.9 - 0.45) + (i % 2 ? Math.PI / 4 : -Math.PI / 4);",
    "  const cx = 0.15 + Math.random() * 0.7, cy = 0.15 + Math.random() * 0.7;",
    "  const c = S.S2W(cx, cy);",
    "  const L = S.hPx(0.9);",
    "  const g = streak(c.x - Math.cos(a) * L, c.y - Math.sin(a) * L,",
    "                   c.x + Math.cos(a) * L, c.y + Math.sin(a) * L,",
    "                   col, S.wLen(cfg.slashWidth), host);",
    "  g.alpha = 0;",
    "  slashRuns.push(wait(i * perSlash).then(() => oni.tween({",
    "    from: 0, to: 1, duration: cfg.slashFadeMs, ease: E.outQuad,",
    "    onUpdate: (v) => { g.alpha = v < 0.3 ? v / 0.3 : 1 - (v - 0.3) / 0.7; },",
    "    onComplete: () => { try { g.destroy(); } catch (e) {} },",
    "  })));",
    "}",
    "await wait(cfg.slashWindowMs * 0.8);",
    "",
    "// 6. White sheet + everyone as a silhouette taking the hit. PIXI, so the",
    "//    silhouettes can sit above the sheet.",
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "const sheet = new PIXI.Graphics();",
    "const tl = S.S2W(0, 0);",
    "sheet.beginFill(0xffffff, 1).drawRect(tl.x, tl.y, S.wLen(S.W), S.wLen(S.H)).endFill();",
    "sheet.alpha = 0;",
    "sheet.zIndex = 99000;",
    "host.addChild(sheet);",
    "",
    "const sils = [];",
    "const restores = [];",
    "for (const tk of (canvas.tokens?.placeables || [])) {",
    "  if (!tk || tk.destroyed || !tk.mesh) continue;",
    "  const sp = oni.cloneToken(tk, { parent: host });",
    "  if (!sp) continue;",
    "  sp.tint = 0x000000;",
    "  sp.zIndex = 99500;",
    "  sp.alpha = 0;",
    "  sils.push({ sp, base: { x: tk.center.x, y: tk.center.y } });",
    "  restores.push(oni.hideToken(tk));",
    "}",
    "host.sortableChildren = true;",
    "",
    "await oni.tween({ from: 0, to: 1, duration: cfg.whiteFadeMs, ease: E.outQuad, onUpdate: (v) => {",
    "  sheet.alpha = v;",
    "  for (const s of sils) { s.sp.alpha = v * cfg.silhouetteAlpha; s.sp.position.set(s.base.x + (Math.random() * 2 - 1) * S.wLen(5), s.base.y + (Math.random() * 2 - 1) * S.wLen(5)); }",
    "} });",
    "",
    "// Damage lands on the impact, per the guide — the rest is a cosmetic tail.",
    "done();",
    "await wait(cfg.whiteHoldMs);",
    "",
    "// 7. Blow to pure white (silhouettes wash out), hold, then come back.",
    "await oni.tween({ from: 1, to: 0, duration: cfg.whiteOutMs * 0.4, ease: E.inOutQuad, onUpdate: (v) => {",
    "  for (const s of sils) s.sp.alpha = v * cfg.silhouetteAlpha;",
    "} });",
    "await wait(cfg.whiteOutMs * 0.3);",
    "for (const r of restores) { try { r(); } catch (e) {} }",
    "await oni.tween({ from: 1, to: 0, duration: cfg.whiteOutMs, ease: E.inOutQuad, onUpdate: (v) => { sheet.alpha = v; } });",
    "",
    "await Promise.all([dimmer.fadeOut({ duration: cfg.camOutMs }), oni.camera.restore({ duration: cfg.camOutMs })]);",
    "await Promise.all(slashRuns);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 30000 });
}

/* ── Mist Dragon · Phantom Shift ─────────────────────────────────────────── */
//
// The Mist Dragon takes the SHAPE of whatever it copied — half-transparent,
// because it is a phantom of that creature and not the creature.
//
// Route (a) from the plan: purely in-animation. The real token is hidden and a
// half-alpha sprite of the copied monster stands in for the duration of the
// shot, then everything is put back. Nothing is written to the token document,
// so there is no persistent state to revert and no way for a crash mid-shot to
// strand the Mist Dragon wearing someone else's face.
//
// The copy source is fixed per item (Thunder Strike = Skizzik, Venomstone
// Spines = Obsidrax, Mana Stinger = Mana Ray), so the art is a build-time
// constant — no runtime lookup.

function phantomShift(opts = {}) {
  const cfg = Object.assign({
    shiftInMs: 700, shiftHoldMs: 260, shiftOutMs: 700,
    phantomAlpha: 0.5, phantomTint: 0xd8f2ff, scaleBoost: 1,
    mistCount: 26, mistRadius: 150, mistColor: 0xc6ffe4,
    attack: "ranged",
    color: 0xc6ffe4,
    travelMs: 640, orbSize: 32, impactCount: 22, impactRadius: 140,
    lungeMs: 460, returnMs: 560, standoff: 0.62, slashWidth: 10,
    staggerMs: 150, shakeMs: 420, shakeAmp: 8,
    sfxShift: null, sfxShiftVol: 0.5, sfx: null, sfxVol: 0.6,
    sfxImpact: null, sfxImpactVol: 0.6,
    totalTimeoutMs: 18000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !tgts.length) { done(); return; }",
    "const host = oni.layer({ zIndex: 93000 });",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "",
    "// --- shift: dissolve the dragon into mist, re-form as the copied shape ---",
    "playSfx('sfxShift', 'sfxShiftVol');",
    "const selfClone = oni.cloneToken(caster, { parent: host });",
    "const restoreCaster = oni.hideToken(caster);",
    "oni.particles({ x: home.x, y: home.y, count: cfg.mistCount, color: cfg.mistColor,",
    "  size: 20, radius: S.wLen(cfg.mistRadius), life: cfg.shiftInMs + 300,",
    "  blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "",
    "let phantom = null;",
    "try {",
    "  const tex = await loadTexture(A.phantomArt);",
    "  if (tex) {",
    "    phantom = new PIXI.Sprite(tex);",
    "    phantom.anchor.set(0.5);",
    // Match the Mist Dragon's own rendered footprint rather than the copied
    // monster's, so a 2.32x Obsidrax does not suddenly loom over the board.
    "    const mw = caster.mesh ? caster.mesh.width : 200;",
    "    const ratio = (tex.orig && tex.orig.width) ? tex.orig.height / tex.orig.width : 1;",
    "    phantom.width = mw * cfg.scaleBoost;",
    "    phantom.height = mw * ratio * cfg.scaleBoost;",
    "    phantom.position.set(home.x, home.y);",
    "    phantom.alpha = 0;",
    "    phantom.tint = cfg.phantomTint;",
    "    host.addChild(phantom);",
    "  }",
    "} catch (e) { console.warn('[PhantomShift] art load failed', e); }",
    "",
    "await oni.tween({ from: 0, to: 1, duration: cfg.shiftInMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (selfClone) selfClone.alpha = 1 - v;",
    "  if (phantom) phantom.alpha = v * cfg.phantomAlpha;",
    "} });",
    "if (selfClone) { try { selfClone.destroy(); } catch (e) {} }",
    "await wait(cfg.shiftHoldMs);",
    "",
    "// --- the copied attack, recast in Air ---",
    "const body_ = phantom;",
    "playSfx('sfx', 'sfxVol');",
    "const shakes = [];",
    "if (cfg.attack === 'melee') {",
    "  const t = ctr(prime);",
    "  const land = { x: home.x + (t.x - home.x) * cfg.standoff, y: home.y + (t.y - home.y) * cfg.standoff };",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.lungeMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "    if (body_) body_.position.set(home.x + (land.x - home.x) * v, home.y + (land.y - home.y) * v);",
    "  } });",
    "  playSfx('sfxImpact', 'sfxImpactVol');",
    "  const perp = Math.atan2(t.y - home.y, t.x - home.x) + Math.PI / 2;",
    "  const L = S.wLen(95);",
    "  const g = streak(t.x + Math.cos(perp) * L, t.y + Math.sin(perp) * L,",
    "                   t.x - Math.cos(perp) * L, t.y - Math.sin(perp) * L,",
    "                   cfg.color, S.wLen(cfg.slashWidth), host);",
    "  oni.tween({ from: 1, to: 0, duration: 340, ease: E.inQuad, onUpdate: (v) => { g.alpha = v; } });",
    "  oni.particles({ x: t.x, y: t.y, count: cfg.impactCount, color: cfg.color, size: 12,",
    "    radius: S.wLen(cfg.impactRadius), life: 760, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "  shakes.push(shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp)));",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.returnMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "    if (body_) body_.position.set(land.x + (home.x - land.x) * v, land.y + (home.y - land.y) * v);",
    "  } });",
    "} else {",
    "  for (let i = 0; i < tgts.length; i++) {",
    "    const tk = tgts[i];",
    "    const t = ctr(tk);",
    "    const orb = new PIXI.Sprite(glow);",
    "    orb.anchor.set(0.5);",
    "    orb.width = orb.height = S.wLen(cfg.orbSize);",
    "    orb.tint = cfg.color;",
    "    orb.blendMode = PIXI.BLEND_MODES.ADD;",
    "    orb.position.set(home.x, home.y);",
    "    host.addChild(orb);",
    "    const run = oni.tween({ from: 0, to: 1, duration: cfg.travelMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "      orb.position.set(home.x + (t.x - home.x) * v, home.y + (t.y - home.y) * v);",
    "    } }).then(() => {",
    "      try { orb.destroy(); } catch (e) {}",
    "      playSfx('sfxImpact', 'sfxImpactVol');",
    "      oni.particles({ x: t.x, y: t.y, count: cfg.impactCount, color: cfg.color, size: 12,",
    "        radius: S.wLen(cfg.impactRadius), life: 760, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "      return shakeTarget(tk, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "    });",
    "    shakes.push(run);",
    "    if (i < tgts.length - 1) await wait(cfg.staggerMs);",
    "  }",
    "}",
    "await Promise.all(shakes);",
    "",
    "// --- shift back ---",
    "const back = oni.cloneToken(caster, { parent: host });",
    "if (back) back.alpha = 0;",
    "oni.particles({ x: home.x, y: home.y, count: cfg.mistCount, color: cfg.mistColor,",
    "  size: 20, radius: S.wLen(cfg.mistRadius), life: cfg.shiftOutMs + 200,",
    "  blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "await oni.tween({ from: 0, to: 1, duration: cfg.shiftOutMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (phantom) phantom.alpha = (1 - v) * cfg.phantomAlpha;",
    "  if (back) back.alpha = v;",
    "} });",
    "restoreCaster();",
    "if (back) { try { back.destroy(); } catch (e) {} }",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, assets: opts.assets || {}, inner: inner(body), timeout: 22000 });
}

/* ── Kirin · Rail Stream ─────────────────────────────────────────────────── */
//
// Everything the Kirin has been hoarding leaves the horn at once: dim to the
// Kirin and its targets, push in, gather blue charge, fire a column straight up
// out of frame, and bring it back down across the whole screen as a rain of
// bolts, with a real impact on each target.

function railStream(opts = {}) {
  const cfg = Object.assign({
    // <1 pulls OUT (zoom is a multiple of rest scale). Deliberate: this shot
    // wants the whole battlefield, not the Kirin.
    camZoom: 0.82, camInMs: 1400, camOutMs: 1100,
    rainWebm: null, rainWebmScale: 3, rainWebmAngle: 90,
    dimTo: 0.66, dimMs: 900,
    gatherMs: 1600, gatherCount: 46, gatherRadius: 260, color: 0x8ec5ff,
    coreColor: 0xffffff,
    columnMs: 800, columnWidth: 46, columnFadeMs: 500,
    rainCount: 26, rainWindowMs: 2900, rainFallMs: 480, rainWidth: 10,
    rainChaos: 0.75, rainSizeJitter: 0.45, rainSpeedJitter: 0.4,
    impactCount: 24, impactRadius: 150,
    shakeMs: 620, shakeAmp: 10, screenshakeMs: 1500, screenshakeAmp: 9,
    flashAlpha: 0.5, flashColor: "#cfe6ff",
    sfxCharge: null, sfxChargeVol: 0.6,
    sfxFire: null, sfxFireVol: 0.7,
    sfxImpact: null, sfxImpactVol: 0.5,
    totalTimeoutMs: 26000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 95000 });",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "",
    "const camming = oni.camera.focus({ point: home, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "const dimmer = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "await camming;",
    "",
    "playSfx('sfxCharge', 'sfxChargeVol');",
    "await oni.particles({ x: home.x, y: home.y, count: cfg.gatherCount, color: cfg.color,",
    "  size: 16, radius: S.wLen(cfg.gatherRadius), life: cfg.gatherMs, mode: 'gather',",
    "  stagger: 700, blend: PIXI.BLEND_MODES.ADD, parent: host, ease: E.inOutQuad });",
    "",
    "// The column: straight up out of frame, drawn in screen fractions so it",
    "// always clears the top edge whatever the zoom.",
    "playSfx('sfxFire', 'sfxFireVol');",
    "oni.screenshake({ duration: cfg.screenshakeMs, intensity: cfg.screenshakeAmp });",
    "const topY = S.S2W(0, -0.15).y;",
    "const col = new PIXI.Graphics();",
    "col.blendMode = PIXI.BLEND_MODES.ADD;",
    "host.addChild(col);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.columnMs, ease: E.outQuad, onUpdate: (v) => {",
    "  const y = home.y + (topY - home.y) * v;",
    "  col.clear();",
    "  col.lineStyle({ width: S.wLen(cfg.columnWidth), color: cfg.color, alpha: 0.85, cap: 'round' });",
    "  col.moveTo(home.x, home.y); col.lineTo(home.x, y);",
    "  col.lineStyle({ width: S.wLen(cfg.columnWidth * 0.4), color: cfg.coreColor, alpha: 1, cap: 'round' });",
    "  col.moveTo(home.x, home.y); col.lineTo(home.x, y);",
    "} });",
    "oni.tween({ from: 1, to: 0, duration: cfg.columnFadeMs, ease: E.inQuad, onUpdate: (v) => { col.alpha = v; },",
    "  onComplete: () => { try { col.destroy(); } catch (e) {} } });",
    "",
    "// Rain across the entire screen.",
    "oni.domFlash({ color: cfg.flashColor, alpha: cfg.flashAlpha, fadeIn: 140, hold: 80, fadeOut: 620 });",
    "// Chaotic schedule, not a metronome: a power-curve random delay clumps the",
    "// strikes and leaves gaps, which is what makes it read as a storm rather",
    "// than one sheet of lightning dropping at once.",
    "const boltDelay = (i) => Math.pow(Math.random(), cfg.rainChaos) * cfg.rainWindowMs;",
    "const rain = [];",
    "for (let i = 0; i < cfg.rainCount; i++) {",
    "  const fx = 0.04 + Math.random() * 0.92;",
    "  const top = S.S2W(fx, -0.1);",
    "  const bot = S.S2W(fx, 0.7 + Math.random() * 0.35);",
    "  if (cfg.rainWebm) {",
    "    rain.push(wait(boltDelay(i)).then(async () => {",
    "      const jit = 1 + (Math.random() * 2 - 1) * cfg.rainSizeJitter;",
    "      const L = S.hPx(0.5) * cfg.rainWebmScale * jit;",
    "      const r = await oni.webm(cfg.rainWebm, { size: L, x: top.x, y: (top.y + bot.y) / 2,",
    "        parent: host, zIndex: 95000, angle: cfg.rainWebmAngle });",
    "      if (r && r.video) { try { r.video.playbackRate = 1 + (Math.random() * 2 - 1) * cfg.rainSpeedJitter; } catch (e) {} }",
    "      return r ? r.ended : null;",
    "    }));",
    "    continue;",
    "  }",
    "  const g = new PIXI.Graphics();",
    "  g.blendMode = PIXI.BLEND_MODES.ADD;",
    "  host.addChild(g);",
    "  rain.push(wait(boltDelay(i)).then(() => oni.tween({",
    "    from: 0, to: 1, duration: cfg.rainFallMs, ease: E.inQuad, onUpdate: (v) => {",
    "      const y = top.y + (bot.y - top.y) * Math.min(1, v * 1.6);",
    "      g.clear();",
    "      g.lineStyle({ width: S.wLen(cfg.rainWidth), color: cfg.color, alpha: 1 - Math.max(0, (v - 0.6) / 0.4), cap: 'round' });",
    "      g.moveTo(top.x, top.y); g.lineTo(top.x, y);",
    "      g.lineStyle({ width: S.wLen(cfg.rainWidth * 0.35), color: cfg.coreColor, alpha: 1 - Math.max(0, (v - 0.6) / 0.4), cap: 'round' });",
    "      g.moveTo(top.x, top.y); g.lineTo(top.x, y);",
    "    },",
    "    onComplete: () => { try { g.destroy(); } catch (e) {} },",
    "  })));",
    "}",
    "",
    "// Every target actually gets hit, staggered inside the same window.",
    "const hits = [];",
    "for (let i = 0; i < tgts.length; i++) {",
    "  const tk = tgts[i];",
    "  hits.push(wait(cfg.rainWindowMs * 0.25 + i * 190).then(() => {",
    "    const c = ctr(tk);",
    "    const top = S.S2W((c.x - S.S2W(0, 0).x) / Math.max(1, S.wLen(S.W)), -0.1);",
    "    const g = new PIXI.Graphics();",
    "    g.blendMode = PIXI.BLEND_MODES.ADD;",
    "    host.addChild(g);",
    "    return oni.tween({ from: 0, to: 1, duration: cfg.rainFallMs, ease: E.inQuad, onUpdate: (v) => {",
    "      g.clear();",
    "      g.lineStyle({ width: S.wLen(cfg.rainWidth * 1.6), color: cfg.coreColor, alpha: 1 - Math.max(0, (v - 0.7) / 0.3), cap: 'round' });",
    "      g.moveTo(c.x, top.y); g.lineTo(c.x, top.y + (c.y - top.y) * Math.min(1, v * 1.5));",
    "    }, onComplete: () => {",
    "      try { g.destroy(); } catch (e) {}",
    "      playSfx('sfxImpact', 'sfxImpactVol');",
    "      oni.particles({ x: c.x, y: c.y, count: cfg.impactCount, color: cfg.color, size: 14,",
    "        radius: S.wLen(cfg.impactRadius), life: 820, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "      shakeTarget(tk, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "    } });",
    "  }));",
    "}",
    "",
    "await Promise.all(hits);",
    "done();",
    "await Promise.all(rain);",
    "await Promise.all([dimmer.fadeOut({ duration: cfg.camOutMs }), oni.camera.restore({ duration: cfg.camOutMs })]);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 30000 });
}

/* ── Drakoza · Thrash ────────────────────────────────────────────────────── */
//
// All the banked Fury goes out at once as raw motion: the Drakoza whips side to
// side hard enough to shake the screen, throwing up dust, then slams the target.

function thrash(opts = {}) {
  const cfg = Object.assign({
    swayCount: 7, swayMs: 1500, swayAmp: 62, swayTilt: 16,
    screenshakeMs: 1700, screenshakeAmp: 12,
    smokeCount: 46, smokeRadius: 230, smokeColor: 0x9a8f80, smokeSize: 34, smokeLife: 1500,
    lungeMs: 380, returnMs: 620, standoff: 0.6,
    impactCount: 30, impactRadius: 190, impactColor: 0xffe1b0,
    shakeMs: 620, shakeAmp: 13,
    sfxThrash: null, sfxThrashVol: 0.6, sfxImpact: null, sfxImpactVol: 0.8,
    totalTimeoutMs: 18000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 93000 });",
    "const clone = oni.cloneToken(caster, { parent: host });",
    "const restoreCaster = oni.hideToken(caster);",
    "const baseAngle = clone ? clone.angle : 0;",
    "",
    "playSfx('sfxThrash', 'sfxThrashVol');",
    "oni.screenshake({ duration: cfg.screenshakeMs, intensity: cfg.screenshakeAmp });",
    "oni.particles({ x: home.x, y: home.y, count: cfg.smokeCount, color: cfg.smokeColor,",
    "  size: cfg.smokeSize, radius: S.wLen(cfg.smokeRadius), life: cfg.smokeLife,",
    "  stagger: 800, gravity: S.wLen(-30), parent: host, alphaFrom: 0.75 });",
    "",
    "// Sway with a decaying envelope so it settles instead of stopping dead.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.swayMs, ease: E.linear, onUpdate: (v) => {",
    "  if (!clone) return;",
    "  const decay = 0.35 + 0.65 * (1 - v);",
    "  const ph = v * Math.PI * 2 * cfg.swayCount;",
    "  clone.position.set(home.x + Math.sin(ph) * S.wLen(cfg.swayAmp) * decay, home.y + Math.cos(ph * 2) * S.wLen(cfg.swayAmp * 0.22) * decay);",
    "  clone.angle = baseAngle + Math.sin(ph) * cfg.swayTilt * decay;",
    "} });",
    "if (clone) clone.angle = baseAngle;",
    "",
    "// No rush-in: the thrashing itself is the attack. The target still takes a",
    "// visible hit so the damage has somewhere to land.",
    "if (prime) {",
    "  const t = ctr(prime);",
    "  playSfx('sfxImpact', 'sfxImpactVol');",
    "  oni.screenshake({ duration: 520, intensity: cfg.screenshakeAmp + 4 });",
    "  oni.particles({ x: t.x, y: t.y, count: cfg.impactCount, color: cfg.impactColor, size: 15,",
    "    radius: S.wLen(cfg.impactRadius), life: 900, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "  await shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "}",
    "restoreCaster();",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 20000 });
}

/* ── Carlbero · Stinky Breath ────────────────────────────────────────────── */
//
// Slow build, fast payoff. The camera drifts in on the Carlbero while poison
// pools in its mouth, then whips to the party exactly as the breath lands, so
// the cut sells the hit rather than the spray.

function stinkyBreath(opts = {}) {
  const cfg = Object.assign({
    dimTo: 0.7, dimMs: 1100,
    // Pull OUT rather than in (user preference on review): this shot plays
    // better showing the whole field getting covered. <1 is wider than rest.
    camZoomIn: 0.88, camInMs: 2200,
    camZoomParty: 0.82, camWhipMs: 520,
    coneWebm: null, coneWebmScale: 3, coneWebmThickness: 1, coneHoldMs: 1600,
    buildMs: 2000, buildCount: 54, buildRadius: 200,
    color: 0x9fd45f, darkColor: 0x5c7a2a,
    sprayMs: 2200, sprayCount: 150, sprayStagger: 1000,
    coneSpread: 0.62, reach: 1.35, particleSize: 30,
    puffCount: 24, puffRadius: 170, shakeMs: 620, shakeAmp: 9,
    camOutMs: 1200,
    sfxBuild: null, sfxBuildVol: 0.5, sfxSpray: null, sfxSprayVol: 0.7,
    totalTimeoutMs: 30000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !tgts.length) { done(); return; }",
    "const host = oni.layer({ zIndex: 94000 });",
    "const mid = centroid(tgts);",
    "",
    "const dimmer = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "await oni.camera.focus({ point: home, zoom: cfg.camZoomIn, duration: cfg.camInMs });",
    "",
    "// Poison pools at the mouth.",
    "playSfx('sfxBuild', 'sfxBuildVol');",
    "const ang = Math.atan2(mid.y - home.y, mid.x - home.x);",
    "const mouth = { x: home.x + Math.cos(ang) * S.wLen(46), y: home.y + Math.sin(ang) * S.wLen(46) };",
    "await oni.particles({ x: mouth.x, y: mouth.y, count: cfg.buildCount, color: cfg.color,",
    "  size: 18, radius: S.wLen(cfg.buildRadius), life: cfg.buildMs, mode: 'gather',",
    "  stagger: 900, blend: PIXI.BLEND_MODES.ADD, parent: host, ease: E.inOutQuad });",
    "",
    "// Spew, and whip the camera onto the party at the same instant.",
    "playSfx('sfxSpray', 'sfxSprayVol');",
    "const dist = Math.hypot(mid.x - home.x, mid.y - home.y) * cfg.reach;",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 96 });",
    "const puffs = [];",
    "// The cone asset replaces the procedural spray — running both reads as two",
    "// overlapping breaths.",
    "if (cfg.coneWebm) {",
    "  const L = dist * cfg.coneWebmScale;",
    "  const r = await oni.webm(cfg.coneWebm, { size: L, x: mouth.x, y: mouth.y, parent: host, zIndex: 95000 });",
    "  if (r && r.sprite) {",
    "    r.sprite.anchor.set(0, 0.5);",
    "    r.sprite.width = L;",
    "    r.sprite.height = L * cfg.coneWebmThickness;",
    "    r.sprite.position.set(mouth.x, mouth.y);",
    "    r.sprite.rotation = ang;",
    "    puffs.push(r.ended);",
    "  }",
    "} else",
    "for (let i = 0; i < cfg.sprayCount; i++) {",
    "  const a = ang + (Math.random() * 2 - 1) * cfg.coneSpread;",
    "  const reach = dist * (0.5 + Math.random() * 0.7);",
    "  const p = new PIXI.Sprite(glow);",
    "  p.anchor.set(0.5);",
    "  p.tint = Math.random() < 0.35 ? cfg.darkColor : cfg.color;",
    "  p.position.set(mouth.x, mouth.y);",
    "  p.alpha = 0;",
    "  host.addChild(p);",
    "  const life = cfg.sprayMs * (0.65 + Math.random() * 0.55);",
    "  const delay = Math.random() * cfg.sprayStagger;",
    "  const sz = S.wLen(cfg.particleSize) * (0.5 + Math.random() * 1.1);",
    "  puffs.push(wait(delay).then(() => oni.tween({",
    "    from: 0, to: 1, duration: life, ease: E.outQuad, onUpdate: (v) => {",
    "      p.position.set(mouth.x + Math.cos(a) * reach * v, mouth.y + Math.sin(a) * reach * v);",
    "      p.width = p.height = sz * (0.3 + v * 1.8);",
    "      p.alpha = (v < 0.2 ? v / 0.2 : (1 - (v - 0.2) / 0.8)) * 0.8;",
    "    },",
    "    onComplete: () => { try { p.destroy(); } catch (e) {} },",
    "  })));",
    "}",
    "",
    "await wait(260);",
    "await oni.camera.focus({ point: mid, zoom: cfg.camZoomParty, duration: cfg.camWhipMs });",
    "",
    "const shakes = [];",
    "for (const tk of tgts) {",
    "  const c = ctr(tk);",
    "  oni.particles({ x: c.x, y: c.y, count: cfg.puffCount, color: cfg.color, size: 22,",
    "    radius: S.wLen(cfg.puffRadius), life: 1100, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "  shakes.push(shakeTarget(tk, cfg.shakeMs, S.wLen(cfg.shakeAmp)));",
    "}",
    "await Promise.all(shakes);",
    "done();",
    "",
    "// Hold until the breath itself has finished, as directed.",
    "await Promise.all(puffs);",
    "await Promise.all([dimmer.fadeOut({ duration: cfg.camOutMs }), oni.camera.restore({ duration: cfg.camOutMs })]);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 34000 });
}

/* ── Succubus · Charm ────────────────────────────────────────────────────── */
//
// The camera goes to the Succubus, a heart leaves her, and the camera RIDES it
// all the way in — so the table watches the thing arrive rather than watching a
// number change. Panning per frame with the clamped snap (not animatePan) is
// what makes the follow smooth instead of a series of lurches.

function charm(opts = {}) {
  const cfg = Object.assign({
    // Push IN on the Succubus as she casts, then ride the heart across at the
    // same closeness. >1 is closer than rest framing.
    camZoom: 1.75, camInMs: 1100, camOutMs: 1000,
    beatMs: 420,
    heartSize: 54, heartColor: 0xff5fa8, heartGlow: 0xffb3d9,
    travelMs: 2400, bobAmp: 26, bobHz: 1.6, spinDeg: 14,
    impactCount: 30, impactRadius: 160,
    flashColor: "#ff8ec4", flashAlpha: 0.55, flashInMs: 160, flashOutMs: 700,
    shakeMs: 460, shakeAmp: 8,
    sfxCast: null, sfxCastVol: 0.55, sfxImpact: null, sfxImpactVol: 0.7,
    totalTimeoutMs: 24000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 95000 });",
    "const t = ctr(prime);",
    "",
    "await oni.camera.focus({ point: home, zoom: cfg.camZoom, duration: cfg.camInMs });",
    "await wait(cfg.beatMs);",
    "",
    "playSfx('sfxCast', 'sfxCastVol');",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "const halo = new PIXI.Sprite(glow);",
    "halo.anchor.set(0.5);",
    "halo.tint = cfg.heartGlow;",
    "halo.blendMode = PIXI.BLEND_MODES.ADD;",
    "halo.width = halo.height = S.wLen(cfg.heartSize * 2.6);",
    "host.addChild(halo);",
    "",
    "const heart = new PIXI.Graphics();",
    "host.addChild(heart);",
    "function drawHeart(g, r, color) {",
    "  g.clear();",
    "  g.beginFill(color, 1);",
    "  g.moveTo(0, r * 0.75);",
    "  g.bezierCurveTo(-r * 1.5, -r * 0.35, -r * 0.55, -r * 1.35, 0, -r * 0.42);",
    "  g.bezierCurveTo(r * 0.55, -r * 1.35, r * 1.5, -r * 0.35, 0, r * 0.75);",
    "  g.endFill();",
    "}",
    "drawHeart(heart, S.wLen(cfg.heartSize), cfg.heartColor);",
    "",
    "// Ride the heart in. panSnap goes through the camera clamp, so the follow",
    "// can never drift off the artwork even at the far end of the board.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.travelMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  const bob = Math.sin(v * Math.PI * 2 * cfg.bobHz) * S.wLen(cfg.bobAmp);",
    "  const x = home.x + (t.x - home.x) * v;",
    "  const y = home.y + (t.y - home.y) * v + bob;",
    "  heart.position.set(x, y);",
    "  heart.angle = Math.sin(v * Math.PI * 2 * cfg.bobHz) * cfg.spinDeg;",
    "  halo.position.set(x, y);",
    "  halo.alpha = 0.55 + Math.sin(v * Math.PI * 6) * 0.2;",
    "  oni.camera.snap({ point: { x: x, y: y }, zoom: cfg.camZoom });",
    "} });",
    "",
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "try { heart.destroy(); halo.destroy(); } catch (e) {}",
    "oni.particles({ x: t.x, y: t.y, count: cfg.impactCount, color: cfg.heartColor, size: 16,",
    "  radius: S.wLen(cfg.impactRadius), life: 950, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "const flashing = oni.domFlash({ color: cfg.flashColor, alpha: cfg.flashAlpha,",
    "  fadeIn: cfg.flashInMs, hold: 90, fadeOut: cfg.flashOutMs, onPeak: () => done() });",
    "const shaking = shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "",
    "await Promise.all([flashing, shaking]);",
    "await oni.camera.restore({ duration: cfg.camOutMs });",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 28000 });
}

/* ── Death Gazer · Death Gaze ────────────────────────────────────────────── */
//
// A roulette. The camera SNAPS between combatants at random — no panning, the
// cut is the whole point — decelerating until it lands on whoever the gaze
// actually chose. Nobody at the table knows who it stopped on until it stops.

function deathGaze(opts = {}) {
  const cfg = Object.assign({
    camZoom: 1.85, camInMs: 700, camOutMs: 1000,
    dimTo: 0.55, dimMs: 700,
    snapCount: 16, snapFirstMs: 110, snapLastMs: 620,
    landHoldMs: 900,
    eyeColor: 0x9d4dff, eyeSize: 90, eyeMs: 700,
    beamCount: 34, beamRadius: 190,
    flashColor: "#2a0a3d", flashAlpha: 0.75,
    shakeMs: 620, shakeAmp: 11,
    sfxTick: null, sfxTickVol: 0.35, sfxLand: null, sfxLandVol: 0.8,
    totalTimeoutMs: 28000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 95000 });",
    "const dimmer = await oni.sceneDim({ to: cfg.dimTo, fadeIn: cfg.dimMs });",
    "",
    "// Roulette pool: every token on the board, so the snap can land anywhere",
    "// and the reveal is genuinely a reveal.",
    "const pool = (canvas.tokens?.placeables || []).filter(t => t && !t.destroyed && t.center);",
    "const spin = pool.length ? pool : [caster];",
    "",
    "// Decelerate from snapFirstMs to snapLastMs on a quad curve — an even ramp",
    "// reads as mechanical, the ease reads as the wheel losing momentum.",
    "for (let i = 0; i < cfg.snapCount; i++) {",
    "  const p = i / Math.max(1, cfg.snapCount - 1);",
    "  const pick = spin[Math.floor(Math.random() * spin.length)];",
    "  oni.camera.snap({ point: ctr(pick), zoom: cfg.camZoom });",
    "  playSfx('sfxTick', 'sfxTickVol');",
    "  await wait(cfg.snapFirstMs + (cfg.snapLastMs - cfg.snapFirstMs) * E.inOutQuad(p));",
    "}",
    "",
    "// Land on the real target.",
    "const t = ctr(prime);",
    "oni.camera.snap({ point: t, zoom: cfg.camZoom });",
    "playSfx('sfxLand', 'sfxLandVol');",
    "await wait(cfg.landHoldMs);",
    "",
    "// The gaze itself.",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "const eye = new PIXI.Sprite(glow);",
    "eye.anchor.set(0.5);",
    "eye.tint = cfg.eyeColor;",
    "eye.blendMode = PIXI.BLEND_MODES.ADD;",
    "eye.position.set(t.x, t.y);",
    "eye.width = eye.height = 0;",
    "host.addChild(eye);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.eyeMs, ease: E.outQuad, onUpdate: (v) => {",
    "  eye.width = eye.height = S.wLen(cfg.eyeSize) * v;",
    "  eye.alpha = v < 0.7 ? v / 0.7 : 1;",
    "} });",
    "oni.particles({ x: t.x, y: t.y, count: cfg.beamCount, color: cfg.eyeColor, size: 15,",
    "  radius: S.wLen(cfg.beamRadius), life: 950, mode: 'gather', blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "const shaking = shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "await oni.domFlash({ color: cfg.flashColor, alpha: cfg.flashAlpha, fadeIn: 200, hold: 160, fadeOut: 700, onPeak: () => done() });",
    "",
    "await shaking;",
    "await Promise.all([dimmer.fadeOut({ duration: cfg.camOutMs }), oni.camera.restore({ duration: cfg.camOutMs })]);",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 32000 });
}

/* ── Imp · Strip Weapon / Strip Armor ────────────────────────────────────── */
//
// Shared by both, as directed. The Imp darts in, there is a metallic snatch,
// the stolen thing glints away with it, and it scampers home pleased.

function stripEquip(opts = {}) {
  const cfg = Object.assign({
    dashMs: 420, holdMs: 620, returnMs: 560, overlap: 0.7,
    glintColor: 0xfff3c4, glintMs: 520, glintLen: 120, glintWidth: 7,
    sparkCount: 18, sparkRadius: 110,
    grabWebm: null, grabWebmSize: 420,
    lootColor: 0xffe9a8, lootSize: 26, lootArcMs: 700, lootRise: 90,
    lootEmoji: null, lootEmojiSize: 54,
    shakeMs: 320, shakeAmp: 6,
    sfxDash: null, sfxDashVol: 0.5, sfxSnatch: null, sfxSnatchVol: 0.8,
    totalTimeoutMs: 16000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 93000 });",
    "const t = ctr(prime);",
    "const land = { x: home.x + (t.x - home.x) * cfg.overlap, y: home.y + (t.y - home.y) * cfg.overlap };",
    "const clone = oni.cloneToken(caster, { parent: host });",
    "const restoreCaster = oni.hideToken(caster);",
    "",
    "playSfx('sfxDash', 'sfxDashVol');",
    "await oni.tween({ from: 0, to: 1, duration: cfg.dashMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(home.x + (land.x - home.x) * v, home.y + (land.y - home.y) * v);",
    "} });",
    "",
    "// The snatch: the hand asset closes on them, then a hard metallic glint.",
    "if (cfg.grabWebm) await fxWebm(cfg.grabWebm, t.x, t.y, { size: S.wLen(cfg.grabWebmSize), parent: host });",
    "playSfx('sfxSnatch', 'sfxSnatchVol');",
    "const a = Math.atan2(t.y - land.y, t.x - land.x) + Math.PI / 2;",
    "const L = S.wLen(cfg.glintLen);",
    "const g = streak(t.x - Math.cos(a) * L, t.y - Math.sin(a) * L,",
    "                 t.x + Math.cos(a) * L, t.y + Math.sin(a) * L,",
    "                 cfg.glintColor, S.wLen(cfg.glintWidth), host);",
    "oni.tween({ from: 1, to: 0, duration: cfg.glintMs, ease: E.inQuad, onUpdate: (v) => { g.alpha = v; } });",
    "oni.particles({ x: t.x, y: t.y, count: cfg.sparkCount, color: cfg.glintColor, size: 10,",
    "  radius: S.wLen(cfg.sparkRadius), life: 620, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "const shaking = shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "",
    "// The stolen thing arcs off the victim and into the Imp's hands.",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 96 });",
    "// The stolen thing is shown as an emoji so it is unambiguous WHAT was taken",
    "// — a generic mote could be anything, and this move has two variants.",
    "let loot;",
    "if (cfg.lootEmoji) {",
    "  loot = new PIXI.Text(cfg.lootEmoji, { fontSize: 64, fill: 0xffffff, align: 'center' });",
    "  loot.anchor.set(0.5);",
    "  loot.scale.set(S.wLen(cfg.lootEmojiSize) / 64);",
    "} else {",
    "  loot = new PIXI.Sprite(glow);",
    "  loot.anchor.set(0.5);",
    "  loot.tint = cfg.lootColor;",
    "  loot.blendMode = PIXI.BLEND_MODES.ADD;",
    "  loot.width = loot.height = S.wLen(cfg.lootSize);",
    "}",
    "loot.position.set(t.x, t.y);",
    "host.addChild(loot);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.lootArcMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  loot.position.set(t.x + (land.x - t.x) * v, t.y + (land.y - t.y) * v - Math.sin(v * Math.PI) * S.wLen(cfg.lootRise));",
    "} });",
    "try { loot.destroy(); } catch (e) {}",
    "",
    "await wait(cfg.holdMs);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.returnMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(land.x + (home.x - land.x) * v, land.y + (home.y - land.y) * v);",
    "} });",
    "restoreCaster();",
    "await shaking;",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 20000 });
}

/* ── Skizzik · Thunder Strike ────────────────────────────────────────────── */
//
// Too fast to follow: it crosses the target, leaves the screen entirely, and
// comes back in from the far side. The afterimage trail is what sells the
// speed — without it this reads as a slide, not a strike.
//
// NOTE this same script is also driven by Chain Reaction (free Thunder Strike
// on any Bolt hit) and by the riposte item, so it can replay several times in
// one round. dashMs is the dial if that starts to drag.

function thunderStrikeDash(opts = {}) {
  const cfg = Object.assign({
    windupMs: 420, windupCount: 20, windupRadius: 110, color: 0xffe75a,
    coreColor: 0xffffff,
    dashMs: 520, exitPadX: 0.35, offBeatMs: 260, reentryMs: 620,
    afterimageEvery: 26, afterimageLife: 380, afterimageAlpha: 0.55,
    boltCount: 3, boltLen: 150, boltWidth: 8, boltLife: 300,
    impactCount: 28, impactRadius: 165,
    shakeMs: 520, shakeAmp: 11, screenshakeMs: 420, screenshakeAmp: 8,
    sfxDash: null, sfxDashVol: 0.6, sfxImpact: null, sfxImpactVol: 0.75,
    totalTimeoutMs: 18000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 94000 });",
    "const t = ctr(prime);",
    "const clone = oni.cloneToken(caster, { parent: host });",
    "const restoreCaster = oni.hideToken(caster);",
    "const glow = oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 128 });",
    "",
    "await oni.particles({ x: home.x, y: home.y, count: cfg.windupCount, color: cfg.color,",
    "  size: 13, radius: S.wLen(cfg.windupRadius), life: cfg.windupMs, mode: 'gather',",
    "  blend: PIXI.BLEND_MODES.ADD, parent: host, ease: E.inQuad });",
    "",
    "// Screen edges in world space — where 'off screen' actually is at this zoom.",
    "const rightX = S.S2W(1 + cfg.exitPadX, 0.5).x;",
    "const leftX  = S.S2W(-cfg.exitPadX, 0.5).x;",
    "",
    "playSfx('sfxDash', 'sfxDashVol');",
    "let lastTrail = 0;",
    "let hitFired = false;",
    "await oni.tween({ from: 0, to: 1, duration: cfg.dashMs, ease: E.inQuad, onUpdate: (v) => {",
    "  if (!clone) return;",
    // Home -> through the target -> off the right edge, one continuous move.
    "  const x = home.x + (rightX - home.x) * v;",
    "  const y = home.y + (t.y - home.y) * Math.min(1, v * 2.2);",
    "  clone.position.set(x, y);",
    "  const now = performance.now();",
    "  if (now - lastTrail >= cfg.afterimageEvery) {",
    "    lastTrail = now;",
    "    const gh = new PIXI.Sprite(clone.texture);",
    "    gh.anchor.set(0.5);",
    "    gh.width = clone.width; gh.height = clone.height;",
    "    gh.scale.x = Math.abs(gh.scale.x) * Math.sign(clone.scale.x || 1);",
    "    gh.position.set(x, y);",
    "    gh.tint = cfg.color;",
    "    gh.alpha = cfg.afterimageAlpha;",
    "    gh.blendMode = PIXI.BLEND_MODES.ADD;",
    "    host.addChild(gh);",
    "    oni.tween({ from: cfg.afterimageAlpha, to: 0, duration: cfg.afterimageLife, ease: E.outQuad,",
    "      onUpdate: (a) => { gh.alpha = a; }, onComplete: () => { try { gh.destroy(); } catch (e) {} } });",
    "    const sp = new PIXI.Sprite(glow);",
    "    sp.anchor.set(0.5);",
    "    sp.width = sp.height = S.wLen(30);",
    "    sp.tint = cfg.coreColor;",
    "    sp.blendMode = PIXI.BLEND_MODES.ADD;",
    "    sp.position.set(x, y);",
    "    host.addChild(sp);",
    "    oni.tween({ from: 1, to: 0, duration: 280, ease: E.outQuad, onUpdate: (a) => { sp.alpha = a; },",
    "      onComplete: () => { try { sp.destroy(); } catch (e) {} } });",
    "  }",
    // Impact the moment the dash passes the target's x.
    "  if (!hitFired && ((home.x <= t.x && x >= t.x) || (home.x > t.x && x <= t.x))) {",
    "    hitFired = true;",
    "    playSfx('sfxImpact', 'sfxImpactVol');",
    "    oni.screenshake({ duration: cfg.screenshakeMs, intensity: cfg.screenshakeAmp });",
    "    for (let i = 0; i < cfg.boltCount; i++) {",
    "      const a = Math.random() * Math.PI * 2;",
    "      const L = S.wLen(cfg.boltLen) * (0.6 + Math.random() * 0.7);",
    "      const bg = streak(t.x, t.y, t.x + Math.cos(a) * L, t.y + Math.sin(a) * L, cfg.color, S.wLen(cfg.boltWidth), host);",
    "      oni.tween({ from: 1, to: 0, duration: cfg.boltLife, ease: E.inQuad, onUpdate: (al) => { bg.alpha = al; },",
    "        onComplete: () => { try { bg.destroy(); } catch (e) {} } });",
    "    }",
    "    oni.particles({ x: t.x, y: t.y, count: cfg.impactCount, color: cfg.color, size: 14,",
    "      radius: S.wLen(cfg.impactRadius), life: 820, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "    shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "  }",
    "} });",
    "",
    "// Beat off-screen, then back in from the opposite edge.",
    "await wait(cfg.offBeatMs);",
    "if (clone) clone.position.set(leftX, home.y);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.reentryMs, ease: E.outQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(leftX + (home.x - leftX) * v, home.y);",
    "} });",
    "restoreCaster();",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 22000 });
}

/* ── Gigas · Heavy Bodyslam ──────────────────────────────────────────────── */
//
// It commits, it trips, it lands on them. The 90-degree rotation is the joke —
// the Gigas does not slam so much as fall over onto someone, which is exactly
// why the move hurts the Gigas too.

function bodyslam(opts = {}) {
  const cfg = Object.assign({
    windupMs: 620, windupBackAmp: 34,
    rushMs: 620, standoff: 0.72,
    tripMs: 700, tripAngle: 90, tripArc: 70,
    impactCount: 40, impactRadius: 240, impactColor: 0xd8c39a,
    dustCount: 34,
    screenshakeMs: 900, screenshakeAmp: 15,
    shakeMs: 700, shakeAmp: 15,
    groundedMs: 900, returnMs: 900,
    sfxRush: null, sfxRushVol: 0.6, sfxSlam: null, sfxSlamVol: 0.9,
    totalTimeoutMs: 20000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !prime) { done(); return; }",
    "const host = oni.layer({ zIndex: 93000 });",
    "const t = ctr(prime);",
    "const clone = oni.cloneToken(caster, { parent: host });",
    "const restoreCaster = oni.hideToken(caster);",
    "const baseAngle = clone ? clone.angle : 0;",
    "const dirX = Math.sign(t.x - home.x) || 1;",
    "const land = { x: home.x + (t.x - home.x) * cfg.standoff, y: home.y + (t.y - home.y) * cfg.standoff };",
    "",
    "// Lean back before committing.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.windupMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(home.x - dirX * S.wLen(cfg.windupBackAmp) * v, home.y);",
    "} });",
    "",
    "playSfx('sfxRush', 'sfxRushVol');",
    "const start = { x: home.x - dirX * S.wLen(cfg.windupBackAmp), y: home.y };",
    "await oni.tween({ from: 0, to: 1, duration: cfg.rushMs, ease: E.inQuad, onUpdate: (v) => {",
    "  if (clone) clone.position.set(start.x + (land.x - start.x) * v, start.y + (land.y - start.y) * v);",
    "} });",
    "",
    "// The trip: rotate 90 degrees while arcing the last stretch onto the target.",
    "await oni.tween({ from: 0, to: 1, duration: cfg.tripMs, ease: E.inQuad, onUpdate: (v) => {",
    "  if (!clone) return;",
    "  clone.angle = baseAngle + cfg.tripAngle * dirX * v;",
    "  clone.position.set(land.x + (t.x - land.x) * v, land.y + (t.y - land.y) * v - Math.sin(v * Math.PI) * S.wLen(cfg.tripArc));",
    "} });",
    "",
    "playSfx('sfxSlam', 'sfxSlamVol');",
    "oni.screenshake({ duration: cfg.screenshakeMs, intensity: cfg.screenshakeAmp });",
    "oni.particles({ x: t.x, y: t.y, count: cfg.impactCount, color: cfg.impactColor, size: 18,",
    "  radius: S.wLen(cfg.impactRadius), life: 1100, gravity: S.wLen(-20), parent: host, alphaFrom: 0.85 });",
    "const shaking = shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "done();",
    "",
    "// It stays down a moment — it hurt itself too.",
    "await wait(cfg.groundedMs);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.returnMs, ease: E.inOutQuad, onUpdate: (v) => {",
    "  if (!clone) return;",
    "  clone.angle = baseAngle + cfg.tripAngle * dirX * (1 - v);",
    "  clone.position.set(t.x + (home.x - t.x) * v, t.y + (home.y - t.y) * v);",
    "} });",
    "restoreCaster();",
    "await shaking;",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 24000 });
}

/* ── Obsidrax · Tectonic Collapse ────────────────────────────────────────── */
//
// Boulders drop out of frame onto everyone, each one landing on its own beat so
// the screen keeps jolting rather than jolting once.

function boulders(opts = {}) {
  const cfg = Object.assign({
    perTarget: 3, extraStray: 5,
    fallMs: 720, staggerMs: 260, spawnHeight: 0.85,
    rockSize: 54, rockSizeJitter: 0.45, rockColor: 0x6b5a48, rockEdge: 0x413628,
    spinDeg: 200,
    impactCount: 22, impactRadius: 150, impactColor: 0xa89478,
    screenshakeMs: 380, screenshakeAmp: 7,
    shakeMs: 460, shakeAmp: 9,
    sfxRumble: null, sfxRumbleVol: 0.6, sfxHit: null, sfxHitVol: 0.5,
    totalTimeoutMs: 20000,
  }, opts.cfg || {});

  const body = [
    "if (!caster || !tgts.length) { done(); return; }",
    "const host = oni.layer({ zIndex: 94000 });",
    "playSfx('sfxRumble', 'sfxRumbleVol');",
    "",
    "function rock(size) {",
    "  const g = new PIXI.Graphics();",
    "  const pts = [];",
    "  const n = 7;",
    "  for (let i = 0; i < n; i++) {",
    "    const a = (i / n) * Math.PI * 2;",
    "    const r = size * (0.62 + Math.random() * 0.45);",
    "    pts.push(Math.cos(a) * r, Math.sin(a) * r);",
    "  }",
    "  g.beginFill(cfg.rockColor, 1);",
    "  g.lineStyle({ width: Math.max(1, size * 0.08), color: cfg.rockEdge, alpha: 1 });",
    "  g.drawPolygon(pts);",
    "  g.endFill();",
    "  return g;",
    "}",
    "",
    "async function drop(x, groundY, delay, target) {",
    "  await wait(delay);",
    "  const size = S.wLen(cfg.rockSize) * (1 + (Math.random() * 2 - 1) * cfg.rockSizeJitter);",
    "  const g = rock(size);",
    "  const topY = S.S2W(0, -cfg.spawnHeight + 0.5).y;",
    "  g.position.set(x, topY);",
    "  host.addChild(g);",
    "  const spin = (Math.random() * 2 - 1) * cfg.spinDeg;",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.fallMs, ease: E.inQuad, onUpdate: (v) => {",
    "    g.position.set(x, topY + (groundY - topY) * v);",
    "    g.angle = spin * v;",
    "  } });",
    "  try { g.destroy(); } catch (e) {}",
    "  playSfx('sfxHit', 'sfxHitVol');",
    "  oni.screenshake({ duration: cfg.screenshakeMs, intensity: cfg.screenshakeAmp });",
    "  oni.particles({ x: x, y: groundY, count: cfg.impactCount, color: cfg.impactColor, size: 15,",
    "    radius: S.wLen(cfg.impactRadius), life: 900, gravity: S.wLen(-16), parent: host, alphaFrom: 0.8 });",
    "  if (target) return shakeTarget(target, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "}",
    "",
    "const runs = [];",
    "let beat = 0;",
    "for (const tk of tgts) {",
    "  const c = ctr(tk);",
    "  for (let i = 0; i < cfg.perTarget; i++) {",
    "    const jitter = (Math.random() * 2 - 1) * S.wLen(60);",
    "    runs.push(drop(c.x + (i === 0 ? 0 : jitter), c.y, beat * cfg.staggerMs, i === 0 ? tk : null));",
    "    beat++;",
    "  }",
    "}",
    "// A few that miss entirely, so the sky is falling rather than being aimed.",
    "for (let i = 0; i < cfg.extraStray; i++) {",
    "  const p = S.S2W(0.1 + Math.random() * 0.8, 0.45 + Math.random() * 0.4);",
    "  runs.push(drop(p.x, p.y, Math.random() * beat * cfg.staggerMs, null));",
    "}",
    "",
    "await wait(cfg.fallMs + beat * cfg.staggerMs * 0.6);",
    "done();",
    "await Promise.all(runs);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 24000 });
}

/* ── Ampere · bubbles ────────────────────────────────────────────────────── */
//
// Cute on purpose. Real bubbles: a ringed outline with an offset highlight,
// wobbling as they drift, popping on arrival. `spread` swaps between the beam
// (caster to one target) and the splash (radiating out at everyone).

function bubbles(opts = {}) {
  const cfg = Object.assign({
    spread: false,
    count: 22, size: 30, sizeJitter: 0.5,
    travelMs: 1300, staggerMs: 90, wobbleAmp: 20, wobbleHz: 2.2,
    color: 0x9fe4ff, rimColor: 0xffffff, rimWidth: 3,
    popCount: 12, popRadius: 90,
    radiateRadius: 420,
    shakeMs: 380, shakeAmp: 6,
    sfx: null, sfxVol: 0.5, sfxPop: null, sfxPopVol: 0.4,
    totalTimeoutMs: 16000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 93000 });",
    "playSfx('sfx', 'sfxVol');",
    "",
    "function bubble(r) {",
    "  const g = new PIXI.Graphics();",
    "  g.beginFill(cfg.color, 0.28);",
    "  g.lineStyle({ width: Math.max(1, S.wLen(cfg.rimWidth)), color: cfg.rimColor, alpha: 0.85 });",
    "  g.drawCircle(0, 0, r);",
    "  g.endFill();",
    "  g.beginFill(cfg.rimColor, 0.75);",
    "  g.drawEllipse(-r * 0.33, -r * 0.36, r * 0.2, r * 0.14);",
    "  g.endFill();",
    "  return g;",
    "}",
    "",
    "async function float(from, to, delay, target) {",
    "  await wait(delay);",
    "  const r = S.wLen(cfg.size) * 0.5 * (1 + (Math.random() * 2 - 1) * cfg.sizeJitter);",
    "  const g = bubble(r);",
    "  g.position.set(from.x, from.y);",
    "  host.addChild(g);",
    "  const perp = Math.atan2(to.y - from.y, to.x - from.x) + Math.PI / 2;",
    "  const amp = S.wLen(cfg.wobbleAmp) * (0.4 + Math.random());",
    "  const phase = Math.random() * Math.PI * 2;",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.travelMs * (0.8 + Math.random() * 0.45), ease: E.inOutQuad, onUpdate: (v) => {",
    "    const w = Math.sin(phase + v * Math.PI * 2 * cfg.wobbleHz) * amp * (1 - v * 0.4);",
    "    g.position.set(from.x + (to.x - from.x) * v + Math.cos(perp) * w,",
    "                   from.y + (to.y - from.y) * v + Math.sin(perp) * w);",
    "    g.scale.set(1 + Math.sin(phase + v * Math.PI * 4) * 0.08);",
    "  } });",
    "  try { g.destroy(); } catch (e) {}",
    "  playSfx('sfxPop', 'sfxPopVol');",
    "  oni.particles({ x: to.x, y: to.y, count: cfg.popCount, color: cfg.color, size: 9,",
    "    radius: S.wLen(cfg.popRadius), life: 560, blend: PIXI.BLEND_MODES.ADD, parent: host });",
    "  if (target) return shakeTarget(target, cfg.shakeMs, S.wLen(cfg.shakeAmp));",
    "}",
    "",
    "const runs = [];",
    "if (cfg.spread) {",
    "  // Radiate outward from the caster, and land real hits on the targets.",
    "  for (let i = 0; i < cfg.count; i++) {",
    "    const a = (i / cfg.count) * Math.PI * 2 + Math.random() * 0.3;",
    "    const R = S.wLen(cfg.radiateRadius) * (0.6 + Math.random() * 0.6);",
    "    runs.push(float(home, { x: home.x + Math.cos(a) * R, y: home.y + Math.sin(a) * R }, i * 40, null));",
    "  }",
    "  for (let i = 0; i < tgts.length; i++) {",
    "    runs.push(float(home, ctr(tgts[i]), 200 + i * cfg.staggerMs, tgts[i]));",
    "  }",
    "} else {",
    "  const list = tgts.length ? tgts : [];",
    "  for (let i = 0; i < list.length; i++) {",
    "    const t = ctr(list[i]);",
    "    for (let k = 0; k < cfg.count; k++) {",
    "      runs.push(float(home, t, i * cfg.staggerMs * 3 + k * cfg.staggerMs, k === 0 ? list[i] : null));",
    "    }",
    "  }",
    "}",
    "",
    "await wait(cfg.travelMs * 0.9);",
    "done();",
    "await Promise.all(runs);",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body), timeout: 20000 });
}

module.exports = {
  quadElementalSlash, phantomShift, railStream, thrash, stinkyBreath,
  charm, deathGaze, stripEquip, thunderStrikeDash, bodyslam, boulders, bubbles,
};
