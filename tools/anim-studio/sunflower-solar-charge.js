// @desc Sunflower Staff Solar Charge +1: light streams from the creature that took Light damage into Hina's staff; the five-petal sunflower over her lights its next petal
"use strict";
// Played by the staff passive's chain (apply_ae Solar Charge, then play_animation) whenever one action deals
// Light damage to any creature. Caster = the staff's wearer, target = the creature that took the Light damage.
// Approved on the review mockup 2026-11-09 ("Solar Charge +1").
//
// Not an action of Hina's, so it never holds the battle up: the gate fires at once (oni.fireDone() first)
// and the stream + sunflower play out over the next ~1.8 s.
(async () => {
  const CFG = {
    S: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/",
    motes: 14, streamMs: 750, holdMs: 800, foldMs: 350,
    petalR: 30,          // the sunflower's radius, px at depth 1
    chest: 0.5, staffFwd: 22,
    volume: 0.8,
    maxCharge: 5,
  };
  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  // how many charges Hina holds now (the chain applied the new one first)
  let charges = 1;
  try {
    const tok = casterUuid ? fromUuidSync(casterUuid) : null;
    const eff = tok?.actor?.effects?.find((e) => e.name === "Solar Charge");
    charges = Number(eff?.flags?.["fabula-ultima-companion"]?.charges ?? 1) || 1;
  } catch (e) {}
  const doneHook = "oni:done:" + foundry.utils.randomID(8);
  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });
  Hooks.callAll("oni:animationStart", { local: true, world: false });

  // INNER (every client). No backticks and no dollar-brace inside.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const n = Math.max(1, Math.min(cfg.maxCharge, ctx.params.charges || 1));
    oni.fireDone();
    const caster = oni.caster, src = oni.targets[0] || null;
    if (!caster) return;
    const st = globalThis.__ONI_BATTLE_STAGE_3D__;
    const drawn = (t) => {
      const b = st && st.drawnMeshBounds ? st.drawnMeshBounds(t) : null;
      if (b && Number.isFinite(b.x)) {
        const W = canvas.stage.worldTransform;
        const feet = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y + b.height));
        const top = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y));
        return { feet: feet, top: top, chest: { x: feet.x, y: feet.y + (top.y - feet.y) * cfg.chest }, m: b.width / Math.abs(t.mesh.width || b.width) };
      }
      return { feet: { x: t.center.x, y: t.y + t.h }, top: { x: t.center.x, y: t.y }, chest: { x: t.center.x, y: t.center.y }, m: 1 };
    };
    const A = drawn(caster);
    const dir = src ? (drawn(src).chest.x >= A.chest.x ? 1 : -1) : -1;
    const sx = A.chest.x + dir * cfg.staffFwd * A.m, sy = A.chest.y;
    const L = oni.layer({ zIndex: 95200 });

    // 1. Light streams from the creature that was hit into the staff.
    oni.sfx(cfg.S + 'Soundboard/Absorb1.ogg', { volume: cfg.volume * 0.3 });
    if (src && src !== caster) {
      const B = drawn(src);
      for (let i = 0; i < cfg.motes; i++) {
        const g = new PIXI.Graphics(); g.beginFill(0xffd76a, 1).drawRect(-2, -2, 4, 4).endFill();
        g.blendMode = PIXI.BLEND_MODES.ADD; g.alpha = 0; L.addChild(g);
        const x0 = B.chest.x + (Math.random() - 0.5) * 40 * B.m, y0 = B.chest.y + (Math.random() - 0.5) * 50 * B.m;
        const cx = (x0 + sx) / 2 + (Math.random() - 0.5) * 120, cy = Math.min(y0, sy) - 40 - Math.random() * 90;
        const delay = Math.random() * 300;
        setTimeout(() => oni.tween({ duration: cfg.streamMs * (0.85 + Math.random() * 0.3), onUpdate: (u) => {
          const e = u * u, v = 1 - e;
          g.x = v * v * x0 + 2 * v * e * cx + e * e * sx; g.y = v * v * y0 + 2 * v * e * cy + e * e * sy;
          g.alpha = Math.sin(u * Math.PI) * 0.9 + 0.1;
        } }).then(() => { try { g.destroy(); } catch (e) {} }), delay);
      }
      await oni.wait(cfg.streamMs + 200);
    }
    oni.particles({ x: sx, y: sy, mode: 'burst', count: 10, color: 0xfff0a0, size: 5, radius: 24 * A.m, life: 450, blend: PIXI.BLEND_MODES.ADD });

    // 2. The sunflower over her head: five petals, the stored ones lit, the new one pops.
    const R = cfg.petalR * A.m, hx = A.top.x, hy = A.top.y - R - 14 * A.m;
    const flower = new PIXI.Container(); flower.position.set(hx, hy); flower.alpha = 0; flower.scale.set(0.6); L.addChild(flower);
    const petals = [];
    for (let i = 0; i < 5; i++) {
      const p = new PIXI.Graphics(); p.rotation = (i * 72 - 90) * Math.PI / 180;
      p.paint = (lit) => { p.clear(); p.lineStyle(2 * A.m, lit ? 0xfff6d4 : 0xd4bb5f, 1).beginFill(lit ? 0xf6cf3e : 0x3c280a, lit ? 1 : 0.55).drawEllipse(R * 0.62, 0, R * 0.5, R * 0.24).endFill(); };
      p.paint(i < n - 1); flower.addChild(p); petals.push(p);
    }
    const core = new PIXI.Graphics(); core.lineStyle(2 * A.m, 0xf2dc8a, 1).beginFill(0x5a3e10, 1).drawCircle(0, 0, R * 0.3).endFill(); flower.addChild(core);
    await oni.tween({ duration: 260, onUpdate: (u) => { flower.alpha = Math.min(1, u * 1.4); flower.scale.set(0.6 + 0.4 * u + 0.12 * Math.sin(u * Math.PI)); } });
    flower.scale.set(1);
    const np = petals[n - 1]; np.paint(true);
    oni.sfx(cfg.S + 'Soundboard/Starlight.ogg', { volume: cfg.volume * 0.35 });
    await oni.tween({ duration: 260, onUpdate: (u) => np.scale.set(1 + 0.35 * Math.sin(u * Math.PI)) });
    await oni.wait(cfg.holdMs);
    await oni.tween({ duration: cfg.foldMs, onUpdate: (u) => { flower.alpha = 1 - u; flower.scale.set(1 - 0.15 * u); } });
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/sunflower-solar-charge",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG, charges },
  });
  await onceHook(doneHook, 3000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
