// @desc Invisibility Potion: a faint shimmer, then the target sprite fades to translucent and eases back; Hidden lands at the faintest point
"use strict";
(async () => {
  const CFG = {
    shimmerColor: "rgba(200,230,255,0.85)",
    shimmerSizeFrac: 1.6,   // glow width as a fraction of the target token width
    shimmerMs: 900,
    fadeOutMs: 1400,        // full → translucent
    minAlpha: 0.25,
    holdMs: 800,
    fadeInMs: 1200,         // translucent → full
    sparkCount: 14,
    sparkSize: 10,
    sfx: "Magic2",
    volume: 0.6,
  };

  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  Hooks.callAll("oni:animationStart", { local: true, world: false });

  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const target = oni.targets[0] || oni.caster;
    if (!target) { oni.fireDone(); return; }
    const tw = target.w || 100, th = target.h || 100;
    const cx = target.center.x, cy = target.center.y;
    const layer = oni.layer({ zIndex: 94500 });

    oni.sfx(cfg.sfx, { volume: cfg.volume });

    // faint shimmer over the body
    const glow = new PIXI.Sprite(oni.radialTexture(cfg.shimmerColor, 'rgba(0,0,0,0)', { size: 256 }));
    glow.anchor.set(0.5);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.width = glow.height = tw * cfg.shimmerSizeFrac;
    glow.position.set(cx, cy);
    glow.alpha = 0;
    layer.addChild(glow);

    // a few sparks drifting upward through the body
    const sparks = [];
    for (let i = 0; i < cfg.sparkCount; i++) {
      const s = new PIXI.Sprite(oni.radialTexture(cfg.shimmerColor, 'rgba(0,0,0,0)', { size: 64 }));
      s.anchor.set(0.5);
      s.blendMode = PIXI.BLEND_MODES.ADD;
      s.width = s.height = cfg.sparkSize * (0.6 + Math.random() * 0.8);
      s._x0 = cx + (Math.random() - 0.5) * tw * 0.8;
      s._y0 = cy + th * 0.4;
      s._rise = th * (0.6 + Math.random() * 0.5);
      s._delay = Math.random() * 0.5;
      s.alpha = 0;
      s.position.set(s._x0, s._y0);
      layer.addChild(s);
      sparks.push(s);
    }

    // The token's sprite alpha. Foundry re-stamps mesh.alpha from the document
    // on refresh, so hold the tweened value on the ticker for the whole run.
    const mesh = target.mesh;
    let held = null;
    const guard = () => { if (held != null && mesh && !mesh.destroyed) mesh.alpha = held; };
    canvas.app.ticker.add(guard);
    const release = () => { canvas.app.ticker.remove(guard); held = null; if (mesh && !mesh.destroyed) mesh.alpha = 1; try { target.renderFlags.set({ refreshMesh: true, refreshState: true }); } catch (e) {} };

    try {
      const shimmer = oni.tween({
        from: 0, to: 1, duration: cfg.shimmerMs + cfg.fadeOutMs, ease: oni.EASE.inOutQuad,
        onUpdate: (v) => {
          glow.alpha = Math.sin(v * Math.PI) * 0.9;
          for (const s of sparks) {
            const t = Math.max(0, Math.min(1, (v - s._delay) / (1 - s._delay)));
            s.position.set(s._x0, s._y0 - s._rise * t);
            s.alpha = Math.sin(t * Math.PI);
          }
        },
      });
      await oni.wait(cfg.shimmerMs);
      await oni.tween({ from: 1, to: cfg.minAlpha, duration: cfg.fadeOutMs, ease: oni.EASE.inOutQuad, onUpdate: (v) => (held = v) });
      oni.fireDone();
      await oni.wait(cfg.holdMs);
      await oni.tween({ from: cfg.minAlpha, to: 1, duration: cfg.fadeInMs, ease: oni.EASE.inOutQuad, onUpdate: (v) => (held = v) });
      await shimmer;
    } finally {
      release();
    }
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/invisibility-potion",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.shimmerMs + CFG.fadeOutMs + 5000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
