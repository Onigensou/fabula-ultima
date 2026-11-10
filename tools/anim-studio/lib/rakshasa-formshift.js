"use strict";
//
// Rakshasa — Form Shift announcement.
//
// Split out of rakshasa-signatures.js when that file was refactored into shared
// fragments: Form Shift shares none of them. It draws no dash, clones no token
// and strikes nothing — it is a panel and a medallion, so it has its own file
// rather than sitting inside a library about combining melee shots.
//
// ⚠ NO BACKTICKS ANYWHERE IN THE INNER BODY — see rakshasa-signatures.js.

const { shell, inner } = require("./dungeon-templates.js");

// Two beats at once: the shared System Message Panel (FU.SystemMessage,
// modules/fabula-ultima-companion/scripts/shared/system-message.js) announces
// the switch, and the weapon's icon flashes over the Rakshasa's head. The panel
// is text-only here (user, 2026-11-10: icon over the head only). The icon is
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
function formShift(opts = {}) {
  const cfg = Object.assign({
    verb: "draws",
    // stance AE name -> [display name, icon url]. Filled by the build script.
    forms: {},
    // How long to wait for RESOLVE to apply the drawn stance.
    stanceWaitMs: 2500, stancePollMs: 50,
    medallionBg: 0x15111f, medallionRim: 0xffcf5c,
    iconSize: 128, iconRise: 62, iconInMs: 260, iconHoldMs: 620, iconOutMs: 320,
    iconBlinks: 3,
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
    "const formName = form.label;",
    "const formIcon = form.icon;",
    "const who = (caster.document && caster.document.name) || (caster.actor && caster.actor.name) || 'The Rakshasa';",
    "",
    "playSfx('sfx', 'sfxVol');",
    "",
    "// ── The line: the shared System Message Panel (FU.SystemMessage) ────────",
    "// Every client runs this script, so the line is shown locally. Each weapon",
    "// name is highlighted (a Dual label is two names joined by \"and\").",
    "const named = String(formName).split(' and ').map((w) => '{w:' + w + '}').join(' and ');",
    "try {",
    "  const SM = globalThis.FU && globalThis.FU.SystemMessage;",
    "  if (SM) SM.show(who + ' ' + cfg.verb + ' its ' + named + '!');",
    "} catch (e) {}",
    "",
    "// ── The weapon icon (PIXI, anchored over the head) ─────────────────────",
    "//",
    "// Drawn as a MEDALLION, not a bare sprite. Foundry's core weapon icons are",
    "// square art with an opaque dark background baked in, so pasting one on the",
    "// canvas reads as a stray screenshot. A circular mask plus a rim turns that",
    "// background into a deliberate frame.",
    "//",
    "// The icon field may be ONE path or an ARRAY. The Crisis shift arms two",
    "// weapons, and announcing that with a single medallion would show half of",
    "// what it drew — so a pair renders as two medallions side by side, sized",
    "// down to keep the group about as wide as one big one.",
    "let iconGroup = null;",
    "const iconList = Array.isArray(formIcon) ? formIcon.filter(Boolean) : (formIcon ? [formIcon] : []);",
    "if (iconList.length) {",
    "  try {",
    "    const many = iconList.length > 1;",
    "    const sz = S.wLen(cfg.iconSize) * (many ? 0.74 : 1);",
    "    const r = sz * 0.5;",
    "    const gap = sz * 1.06;",
    "    iconGroup = new PIXI.Container();",
    "    iconGroup.alpha = 0;",
    "    for (let i = 0; i < iconList.length; i++) {",
    "      let tex = null;",
    "      try { tex = await loadTexture(iconList[i]); } catch (e) { tex = null; }",
    "      if (!tex) continue;",
    "      const medal = new PIXI.Container();",
    "      medal.position.set((i - (iconList.length - 1) / 2) * gap, 0);",
    "",
    "      const backing = new PIXI.Graphics();",
    "      backing.beginFill(cfg.medallionBg, 0.92);",
    "      backing.drawCircle(0, 0, r);",
    "      backing.endFill();",
    "      medal.addChild(backing);",
    "",
    "      const sp = new PIXI.Sprite(tex);",
    "      sp.anchor.set(0.5);",
    "      sp.width = sz; sp.height = sz;",
    "      const mask = new PIXI.Graphics();",
    "      mask.beginFill(0xffffff); mask.drawCircle(0, 0, r * 0.94); mask.endFill();",
    "      sp.mask = mask;",
    "      medal.addChild(mask);",
    "      medal.addChild(sp);",
    "",
    "      const rim = new PIXI.Graphics();",
    "      rim.lineStyle({ width: Math.max(2, sz * 0.045), color: cfg.medallionRim, alpha: 1 });",
    "      rim.drawCircle(0, 0, r * 0.96);",
    "      medal.addChild(rim);",
    "",
    "      const glow = new PIXI.Graphics();",
    "      glow.lineStyle({ width: Math.max(2, sz * 0.10), color: cfg.medallionRim, alpha: 0.28 });",
    "      glow.drawCircle(0, 0, r * 1.06);",
    "      glow.blendMode = PIXI.BLEND_MODES.ADD;",
    "      medal.addChild(glow);",
    "",
    "      iconGroup.addChild(medal);",
    "    }",
    "    if (iconGroup.children.length) host.addChild(iconGroup);",
    "    else { iconGroup = null; }",
    "  } catch (e) { iconGroup = null; }",
    "}",
    "function placeIcon(lift) {",
    "  if (!iconGroup) return;",
    "  const b = caster.mesh ? caster.mesh.height : (caster.h || 100);",
    "  iconGroup.position.set(caster.center.x, caster.center.y - b * 0.5 - S.wLen(cfg.iconRise) * lift);",
    "}",
    "placeIcon(1);",
    "",
    "if (iconGroup) {",
    "  await oni.tween({ from: 0, to: 1, duration: cfg.iconInMs, ease: E.outCubic, onUpdate: (v) => {",
    "    iconGroup.alpha = v;",
    "    iconGroup.scale.set(0.72 + 0.28 * v);",
    "    placeIcon(0.65 + 0.35 * v);",
    "  } });",
    "  // Blink: alpha pulses without the medallion ever leaving, so it reads as a",
    "  // flash rather than a stutter.",
    "  const per = Math.max(80, Math.floor(cfg.iconHoldMs / Math.max(1, cfg.iconBlinks)));",
    "  for (let i = 0; i < cfg.iconBlinks; i++) {",
    "    await oni.tween({ from: 1, to: 0.3, duration: per / 2, ease: E.inOutQuad,",
    "      onUpdate: (v) => { iconGroup.alpha = v; placeIcon(1); } });",
    "    await oni.tween({ from: 0.3, to: 1, duration: per / 2, ease: E.inOutQuad,",
    "      onUpdate: (v) => { iconGroup.alpha = v; placeIcon(1); } });",
    "  }",
    "} else {",
    "  await wait(cfg.iconInMs + cfg.iconHoldMs);",
    "}",
    "",
    "if (iconGroup) {",
    "  await oni.tween({ from: 1, to: 0, duration: cfg.iconOutMs, ease: E.inQuad,",
    "    onUpdate: (v) => { iconGroup.alpha = v; placeIcon(1 + (1 - v) * 0.4); } });",
    "}",
    "",
    "try { if (iconGroup) iconGroup.destroy({ children: true }); } catch (e) {}",
    "done();",
  ].join("\n");

  return shell({ key: opts.key, name: opts.name, cfg, inner: inner(body) });
}


module.exports = { formShift };
