"use strict";
//
// Rakshasa — Form Shift announcement.
//
// Split out of rakshasa-signatures.js when that file was refactored into shared
// fragments: Form Shift shares none of them. It draws no dash, clones no token
// and strikes nothing — it is a panel line and a weapon over the head, so it
// has its own file rather than sitting inside a library about combining melee
// shots.
//
// ⚠ NO BACKTICKS ANYWHERE IN THE INNER BODY — see rakshasa-signatures.js.

const { shell, inner } = require("./dungeon-templates.js");

// Two beats at once: the shared System Message Panel (FU.SystemMessage,
// modules/fabula-ultima-companion/scripts/shared/system-message.js) announces
// the switch, and the weapon itself spins in over the Rakshasa's head.
//
// WEAPON DRAW = "Spin in" (user-approved mockup 2026-11-10,
// https://claude.ai/artifact/DxK4hxKR9CuB8weRHTW3Ey, v3). Replaces the old
// medallion (Foundry core icon in a dark gold-rimmed disc). The weapon sprite
// is real item art, held on a diagonal (cfg.tilt), spinning about the screen's
// vertical axis twice as it grows in, with a stance-coloured glow behind it and
// a few star sparks. A Dual shift shows both weapons leaning apart in a V; the
// Severing Verdict pair (sword + flail) is red and shakes once. The weapon is
// PIXI, because it is anchored to a token and must track it.
//
// Which weapon it announces is read from the ACTOR at run time (the stance AE
// Form Shift just applied), never passed in — the animation must not need to
// know which branch the pool drew. That is also why the SAME function serves
// both shifts: the Crisis one differs only in which stance names it maps.
//
// ⚠ TIMING. The Battle Director plays ANIMATION before RESOLVE, and RESOLVE is
// where the pool draw applies the stance AE. Reading the actor at the top of
// the script therefore sees the stance from BEFORE the shift — usually none,
// since the strike spends it — and the panel said "draws its weapon" (session
// 2026-11-09). So the script opens the gate FIRST (Form Shift deals no damage,
// nothing lands early), then waits for a stance that was not on the actor when
// it started, and only then announces it. If none appears it announces
// nothing: a generic or stale weapon name is a wrong telegraph.
//
// SIZES are fractions of the caster's mesh height, measured off the mockup
// (Rakshasa A drawn 14.4% of the stage width; e.g. a sword 8.2% → 0.57).
function formShift(opts = {}) {
  const cfg = Object.assign({
    verb: "draws",
    // stance AE name -> { label, weapons: [weapon key...], tint, verdict? }.
    // Filled by the build script.
    forms: {},
    // weapon key -> { img, base (deg the art is drawn at: 0 upright, 45 diagonal),
    //                 h (height as a fraction of mesh height), round (no lean) }
    weapons: {},
    // How long to wait for RESOLVE to apply the drawn stance.
    stanceWaitMs: 2500, stancePollMs: 50,
    // Look (mockup v3 defaults: tilt 45°, size 1.00×)
    tilt: 45, sizeScale: 1,
    liftFrac: 0.27,          // weapon centre above the mesh top, in mesh heights
    dualScale: 0.85, dualSpread: 0.167,
    spinMs: 620, spinTurns: 2, spinFromScale: 0.6, spinPeakScale: 1.05,
    holdUntilMs: 1380, outMs: 320, outRise: 0.139,
    glowSize: 0.83, glowMs: 1700, glowPeak: 0.9,
    weaponGlowStrength: 2, weaponGlowDistance: 10,
    sparkImg: null, sparkSize: 0.153, sparkLife: 420,
    sparks: [[-0.25, -0.18, 620], [0.236, -0.083, 700], [-0.167, 0.208, 780]],
    verdictShakeAt: 600, verdictShakeMs: 260, verdictShakeAmp: 0.017,
    sfx: null, sfxVol: 0.6,
    totalTimeoutMs: 12000,
  }, opts.cfg || {});

  const body = [
    "if (!caster) { done(); return; }",
    "const host = oni.layer({ zIndex: 94000 });",
    "",
    "// Which stance is the Rakshasa actually holding? Read it off the actor so",
    "// the animation follows the pool draw instead of duplicating it. The draw",
    "// is applied in RESOLVE, AFTER this script opens the gate, so: note what is",
    "// held now, open the gate, then wait for a stance that is NEW.",
    "function heldStances() {",
    "  const out = [];",
    "  try {",
    "    const eff = caster.actor && caster.actor.effects ? Array.from(caster.actor.effects) : [];",
    "    for (const e of eff) {",
    "      const nm = String((e && (e.name || e.label)) || '').trim();",
    "      if (nm && cfg.forms[nm]) out.push(nm);",
    "    }",
    "  } catch (e) {}",
    "  return out;",
    "}",
    "const before = heldStances();",
    "done();",
    "let formKey = null;",
    "const waitEnd = Date.now() + cfg.stanceWaitMs;",
    "while (!formKey) {",
    "  const fresh = heldStances().filter((nm) => before.indexOf(nm) < 0);",
    "  if (fresh.length) { formKey = fresh[0]; break; }",
    "  if (Date.now() >= waitEnd) break;",
    "  await wait(cfg.stancePollMs);",
    "}",
    "// No new stance = nothing trustworthy to announce. Stay silent rather than",
    "// name a weapon the Rakshasa is not holding.",
    "if (!formKey) { done(); return; }",
    "const form = cfg.forms[formKey];",
    "const who = (caster.document && caster.document.name) || (caster.actor && caster.actor.name) || 'The Rakshasa';",
    "",
    "playSfx('sfx', 'sfxVol');",
    "",
    "// ── The line: the shared System Message Panel (FU.SystemMessage) ────────",
    "// Every client runs this script, so the line is shown locally. Each weapon",
    "// name is highlighted (a Dual label is two names joined by \"and\").",
    "const named = String(form.label).split(' and ').map((w) => '{w:' + w + '}').join(' and ');",
    "try {",
    "  const SM = globalThis.FU && globalThis.FU.SystemMessage;",
    "  if (SM) SM.show(who + ' ' + cfg.verb + ' its ' + named + '!');",
    "} catch (e) {}",
    "",
    "// ── The weapon draw (Spin in) ───────────────────────────────────────────",
    "const meshH = caster.mesh ? caster.mesh.height : (caster.h || 100);",
    "const U = meshH * cfg.sizeScale;",
    "const tint = Number(form.tint) || 0xffffff;",
    "const keys = (form.weapons || []).filter((k) => cfg.weapons[k]);",
    "const dual = keys.length > 1;",
    "",
    "// group = everything, tracks the token. Children are in mesh-height units",
    "// scaled to pixels here, so the look keeps its proportions at any token size.",
    "const group = new PIXI.Container();",
    "host.addChild(group);",
    "let shakeX = 0;",
    "function place() {",
    "  group.position.set(caster.center.x + shakeX, caster.center.y - meshH * 0.5 - meshH * cfg.liftFrac);",
    "}",
    "place();",
    "",
    "// Soft stance-coloured glow behind the weapon: a radial gradient baked to a",
    "// canvas texture once, drawn additive.",
    "let glow = null;",
    "try {",
    "  const c = document.createElement('canvas'); c.width = c.height = 128;",
    "  const g2 = c.getContext('2d');",
    "  const r = (tint >> 16) & 255, gg = (tint >> 8) & 255, b = tint & 255;",
    "  const rg = g2.createRadialGradient(64, 64, 0, 64, 64, 64);",
    "  rg.addColorStop(0, 'rgba(' + r + ',' + gg + ',' + b + ',0.75)');",
    "  rg.addColorStop(0.4, 'rgba(' + r + ',' + gg + ',' + b + ',0.25)');",
    "  rg.addColorStop(0.7, 'rgba(' + r + ',' + gg + ',' + b + ',0)');",
    "  g2.fillStyle = rg; g2.fillRect(0, 0, 128, 128);",
    "  glow = new PIXI.Sprite(PIXI.Texture.from(c));",
    "  glow.anchor.set(0.5);",
    "  glow.width = glow.height = U * cfg.glowSize;",
    "  glow.blendMode = PIXI.BLEND_MODES.ADD;",
    "  glow.alpha = 0;",
    "  group.addChild(glow);",
    "} catch (e) { glow = null; }",
    "",
    "// Weapons: spin (screen-vertical axis, faked by scale.x = cos) > lean > art.",
    "const F = PIXI.filters || {};",
    "const pieces = [];",
    "for (let i = 0; i < keys.length; i++) {",
    "  const w = cfg.weapons[keys[i]];",
    "  let tex = null;",
    "  try { tex = await loadTexture(w.img); } catch (e) { tex = null; }",
    "  if (!tex) continue;",
    "  const spin = new PIXI.Container();",
    "  const lean = new PIXI.Container();",
    "  const sp = new PIXI.Sprite(tex);",
    "  sp.anchor.set(0.5);",
    "  const h = U * w.h * (dual ? cfg.dualScale : 1);",
    "  sp.height = h; sp.width = h * (tex.width / Math.max(1, tex.height));",
    "  // Dual: the left weapon is mirrored so the pair leans apart like a V.",
    "  const mirror = dual && i === 0;",
    "  const leanDeg = w.round ? 0 : (cfg.tilt - (w.base || 0)) * (mirror ? -1 : 1);",
    "  lean.rotation = leanDeg * Math.PI / 180;",
    "  if (mirror && !w.round) lean.scale.x = -1;",
    "  lean.addChild(sp);",
    "  spin.addChild(lean);",
    "  spin.x = dual ? (i ? 1 : -1) * U * cfg.dualSpread : 0;",
    "  spin.alpha = 0;",
    "  try {",
    "    if (typeof F.GlowFilter === 'function') spin.filters = [new F.GlowFilter({ distance: cfg.weaponGlowDistance, outerStrength: cfg.weaponGlowStrength, innerStrength: 0, color: tint, quality: 0.3 })];",
    "  } catch (e) {}",
    "  group.addChild(spin);",
    "  pieces.push(spin);",
    "}",
    "if (!pieces.length) { try { group.destroy({ children: true }); } catch (e) {} done(); return; }",
    "",
    "// Sparks (Disgaea 5 star, additive), staggered after the spin lands.",
    "let sparkTex = null;",
    "if (cfg.sparkImg) { try { sparkTex = await loadTexture(cfg.sparkImg); } catch (e) { sparkTex = null; } }",
    "function spark(fx, fy, delay) {",
    "  if (!sparkTex) return;",
    "  setTimeout(() => {",
    "    if (group.destroyed) return;",
    "    const s = new PIXI.Sprite(sparkTex);",
    "    s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.ADD;",
    "    const base = U * cfg.sparkSize / Math.max(1, sparkTex.width);",
    "    s.position.set(fx * U, fy * U); s.alpha = 0;",
    "    group.addChild(s);",
    "    oni.tween({ from: 0, to: 1, duration: cfg.sparkLife, ease: E.linear, onUpdate: (v) => {",
    "      if (s.destroyed) return;",
    "      const k = v < 0.4 ? v / 0.4 : 1 - (v - 0.4) / 0.6;",
    "      s.alpha = Math.max(0, k);",
    "      s.scale.set(base * (v < 0.4 ? 0.2 + 0.8 * (v / 0.4) : 1 - 0.5 * ((v - 0.4) / 0.6)));",
    "      s.rotation = v < 0.4 ? 0 : ((v - 0.4) / 0.6) * Math.PI / 3;",
    "    } }).then(() => { try { s.destroy(); } catch (e) {} });",
    "  }, delay);",
    "}",
    "for (const sp of cfg.sparks) spark(sp[0], sp[1], sp[2]);",
    "",
    "// Glow: 0 → peak at 50% → 0.3 at 80% → 0 over glowMs.",
    "if (glow) oni.tween({ from: 0, to: 1, duration: cfg.glowMs, ease: E.linear, onUpdate: (v) => {",
    "  if (glow.destroyed) return;",
    "  glow.alpha = v < 0.5 ? cfg.glowPeak * (v / 0.5) : v < 0.8 ? cfg.glowPeak + (0.3 - cfg.glowPeak) * ((v - 0.5) / 0.3) : 0.3 * (1 - (v - 0.8) / 0.2);",
    "  place();",
    "} });",
    "",
    "// Severing Verdict: one short shake once the pair has landed.",
    "if (form.verdict) setTimeout(() => {",
    "  if (group.destroyed) return;",
    "  const amp = U * cfg.verdictShakeAmp;",
    "  oni.tween({ from: 0, to: 1, duration: cfg.verdictShakeMs, ease: E.linear, onUpdate: (v) => {",
    "    shakeX = v < 0.25 ? amp * (v / 0.25) : v < 0.5 ? amp * (1 - 2 * ((v - 0.25) / 0.25)) : v < 0.75 ? -amp + 1.6 * amp * ((v - 0.5) / 0.25) : 0.6 * amp * (1 - (v - 0.75) / 0.25);",
    "    place();",
    "  } }).then(() => { shakeX = 0; place(); });",
    "}, cfg.verdictShakeAt);",
    "",
    "// Spin in: two full turns, scale 0.6 → 1.05 (at 75%) → 1, fading in by 75%.",
    "const t0 = Date.now();",
    "const spinIn = (v) => 1 - Math.pow(1 - v, 3);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.spinMs, ease: E.linear, onUpdate: (raw) => {",
    "  const v = spinIn(raw);",
    "  const s = v < 0.75 ? cfg.spinFromScale + (cfg.spinPeakScale - cfg.spinFromScale) * (v / 0.75) : cfg.spinPeakScale + (1 - cfg.spinPeakScale) * ((v - 0.75) / 0.25);",
    "  const th = v * cfg.spinTurns * Math.PI * 2;",
    "  for (const p of pieces) { p.scale.set(Math.cos(th) * s, s); p.alpha = Math.min(1, v / 0.75); }",
    "  place();",
    "} });",
    "for (const p of pieces) { p.scale.set(1, 1); p.alpha = 1; }",
    "",
    "// Hold, then rise and fade.",
    "const holdLeft = cfg.holdUntilMs - (Date.now() - t0);",
    "if (holdLeft > 0) await wait(holdLeft);",
    "const rise = U * cfg.outRise;",
    "const baseY = pieces.map((p) => p.y);",
    "await oni.tween({ from: 0, to: 1, duration: cfg.outMs, ease: E.inQuad, onUpdate: (v) => {",
    "  pieces.forEach((p, i) => { p.alpha = 1 - v; p.y = baseY[i] - rise * v; });",
    "  place();",
    "} });",
    "",
    "try { group.destroy({ children: true }); } catch (e) {}",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body) });
}


module.exports = { formShift };
