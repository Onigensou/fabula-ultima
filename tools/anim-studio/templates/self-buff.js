// @desc Self-buff: warm radial glow + rising embers on the caster (oni, no target)
"use strict";
(async () => {
  const CFG = {
    color: "rgba(255,180,90,0.9)",
    glowSize: 200,        // px
    glowMs: 900,          // total glow rise+fall
    emberCount: 18,
    emberRiseMs: 1100,
    emberSize: 14,
    sfx: "Heal3",
    volume: 0.7,
  };

  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const doneHook = "oni:done:" + foundry.utils.randomID(8);

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  Hooks.callAll("oni:animationStart", { local: true, world: false });

  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const caster = oni.caster;
    if (!caster) { oni.fireDone(); return; }
    const cx = caster.center.x, cy = caster.center.y;
    const layer = oni.layer({ zIndex: 94000 });

    oni.sfx(cfg.sfx, { volume: cfg.volume });

    // glow
    const glow = new PIXI.Sprite(oni.radialTexture(cfg.color, 'rgba(0,0,0,0)', { size: 256 }));
    glow.anchor.set(0.5);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.width = glow.height = cfg.glowSize;
    glow.position.set(cx, cy);
    glow.alpha = 0;
    layer.addChild(glow);

    // embers
    const embers = [];
    for (let i = 0; i < cfg.emberCount; i++) {
      const e = new PIXI.Sprite(oni.radialTexture(cfg.color, 'rgba(0,0,0,0)', { size: 64 }));
      e.anchor.set(0.5);
      e.blendMode = PIXI.BLEND_MODES.ADD;
      e.width = e.height = cfg.emberSize * (0.6 + Math.random() * 0.8);
      e._x0 = cx + (Math.random() - 0.5) * cfg.glowSize;
      e._y0 = cy + cfg.glowSize * 0.3;
      e._drift = (Math.random() - 0.5) * 40;
      e._delay = Math.random() * 0.4;
      e.position.set(e._x0, e._y0);
      layer.addChild(e);
      embers.push(e);
    }

    // fire the gate at the peak of the glow (buff "lands")
    let fired = false;
    await Promise.all([
      oni.tween({
        from: 0, to: 1, duration: cfg.glowMs, ease: oni.EASE.inOutQuad,
        onUpdate: (v) => {
          glow.alpha = Math.sin(v * Math.PI);
          if (!fired && v >= 0.5) { fired = true; oni.fireDone(); }
        },
      }),
      oni.tween({
        from: 0, to: 1, duration: cfg.emberRiseMs, ease: oni.EASE.outQuad,
        onUpdate: (v) => {
          for (const e of embers) {
            const t = Math.max(0, (v - e._delay) / (1 - e._delay));
            e.position.set(e._x0 + e._drift * t, e._y0 - cfg.glowSize * t);
            e.alpha = Math.sin(t * Math.PI);
          }
        },
      }),
    ]);
    if (!fired) oni.fireDone();
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/self-buff",   // required — pseudo.play blocks calls without one
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: [],
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.glowMs + 4000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
