// @desc Fulgimite Resonance: it trembles and glows, three violet sparks jump to the Crystal, a ring on arrival. The gate fires there, so the count drops on impact
"use strict";
(async () => {
  const CFG = {
    GGS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Guilty%20Gear%20Strive/webm/",
    D4: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Disgaea%204/webm/",
    S: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/",
    chargeMs: 800,
    sparkGapMs: 180,
    sparkSize: 300,
    sparkRate: 0.7,
    ringSize: 190,
    ringRate: 0.6,
    tailMs: 900,
    tint: 0xc79aff,
    glowColor: "rgba(199,154,255,1)",
    glowEdge: "rgba(120,40,220,0)",
    tremble: 3,
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
    const E = oni.EASE;
    const caster = oni.caster;
    const target = oni.targets[0];
    if (!caster || !caster.mesh || !target) { oni.fireDone(); return; }

    const layer = oni.layer({ zIndex: 95500 });
    const glow = new PIXI.Sprite(oni.radialTexture(cfg.glowColor, cfg.glowEdge, { size: 256 }));
    glow.anchor.set(0.5);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.position.set(caster.center.x, caster.center.y);
    layer.addChild(glow);
    const body = oni.cloneToken(caster, { parent: layer });
    const restore = oni.hideToken(caster);
    const hx = body.x, cw = Math.abs(caster.mesh.width) * 1.8;

    // Tremble and charge.
    oni.sfx(cfg.S + "HitElectric.ogg", { volume: cfg.volume * 0.8 });
    await oni.tween({ from: 0, to: 1, duration: cfg.chargeMs, ease: E.inOutQuad, onUpdate: (v) => {
      body.x = hx + (Math.random() - 0.5) * 2 * cfg.tremble;
      glow.width = glow.height = cw * (0.4 + 0.6 * v);
      glow.alpha = v;
    } });
    body.x = hx;

    // Three sparks along the path.
    const ax = caster.center.x, ay = caster.center.y, bx = target.center.x, by = target.center.y;
    const spark = (x, y, size, angle) => oni.vfx(cfg.GGS + "spark_anim01.webm", { x, y, size, angle, zIndex: 96000, blend: PIXI.BLEND_MODES.ADD }).then((fx) => {
      if (!fx) return;
      fx.sprite.tint = cfg.tint;
      try { fx.video.playbackRate = cfg.sparkRate; } catch (e) {}
    });
    for (const f of [0.22, 0.55, 0.88]) {
      spark(ax + (bx - ax) * f, ay + (by - ay) * f, cfg.sparkSize, f * 115);
      await oni.wait(cfg.sparkGapMs);
    }
    oni.tween({ from: 1, to: 0, duration: 460, ease: E.inOutQuad, onUpdate: (v) => { glow.alpha = v; } });

    // Arrival.
    oni.fireDone();
    oni.sfx(cfg.S + "System_Tick.mp3", { volume: cfg.volume });
    spark(bx, by, cfg.sparkSize * 1.2, 0);
    oni.vfx(cfg.D4 + "flash_ring_white.webm", { x: bx, y: by, size: cfg.ringSize, zIndex: 96100, blend: PIXI.BLEND_MODES.ADD, alpha: 0.85 }).then((fx) => {
      if (!fx) return;
      fx.sprite.tint = cfg.tint;
      try { fx.video.playbackRate = cfg.ringRate; } catch (e) {}
    });
    await oni.wait(cfg.tailMs);
    restore();
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/fulgimite-resonance",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.chargeMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
