// @desc Thunder Vent: the belly vents flare, then a purple bolt drops on each target (RPG Maker Thunder One 1, hue-shifted)
"use strict";
(async () => {
  const CFG = {
    clip: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/RPG%20Maker%20MV/076_thunder_one_1.webm",
    GGS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Guilty%20Gear%20Strive/webm/",
    anchorY: 0.858,        // the clip's ground point
    hue: 225,              // yellow bolt to violet
    boltSize: 620,
    boltRate: 0.7,         // 0.47 s clip, slowed a little
    volleys: 2,            // each target is struck this many times
    volleyGapMs: 300,
    staggerMs: 110,        // between targets
    chargeMs: 620,
    fireAfterMs: 190,      // damage lands this long after the first bolt
    tailMs: 750,
    glowColor: 'rgba(214,150,255,1)',
    glowEdge: 'rgba(120,40,220,0)',
    sparkTint: 0xd8a4ff,
    chargeSfx: "PowerUp",
    boltSfx: "Thunder7",
    boltSfx2: "Thunder10",
    volume: 0.85,
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
    const targets = oni.targets;
    const layer = oni.layer({ zIndex: 95500 });
    if (!caster || !targets.length) { oni.fireDone(); return; }

    // Charge: the vents flare and gather sparks.
    oni.sfx(cfg.chargeSfx, { volume: cfg.volume * 0.7 });
    const cw = Math.abs(caster.mesh?.width || caster.w);
    const glow = new PIXI.Sprite(oni.radialTexture(cfg.glowColor, cfg.glowEdge, { size: 256 }));
    glow.anchor.set(0.5);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.position.set(caster.center.x, caster.center.y + (caster.mesh?.height || caster.h) * 0.1);
    layer.addChild(glow);
    oni.particles({ x: glow.x, y: glow.y, count: 26, color: 0xd29aff, size: 15, radius: cw * 0.75, life: cfg.chargeMs, mode: 'gather', blend: PIXI.BLEND_MODES.ADD, parent: layer });
    await oni.tween({ from: 0, to: 1, duration: cfg.chargeMs, ease: E.inQuad, onUpdate: (v) => {
      glow.width = glow.height = cw * (0.25 + 0.75 * v);
      glow.alpha = v;
    } });

    // A bolt drops on every target, feet on the token's ground point.
    oni.sfx(cfg.boltSfx, { volume: cfg.volume });
    oni.sfx(cfg.boltSfx2, { volume: cfg.volume * 0.7, delay: cfg.volleyGapMs });
    oni.tween({ from: 1, to: 0, duration: 380, ease: E.outQuad, onUpdate: (v) => { glow.alpha = v; } });
    const hue = new PIXI.ColorMatrixFilter();
    hue.hue(cfg.hue, false);
    const strike = async (t, delay) => {
      await oni.wait(delay);
      const b = await oni.vfx(cfg.clip, { x: t.center.x, y: t.y + t.h, size: cfg.boltSize, zIndex: 96200 });
      if (!b) return;
      b.sprite.anchor.set(0.5, cfg.anchorY);
      b.sprite.filters = [hue];
      try { b.video.playbackRate = cfg.boltRate; } catch (e) {}
    };
    targets.forEach((t, i) => {
      for (let v = 0; v < cfg.volleys; v++) strike(t, i * cfg.staggerMs + v * cfg.volleyGapMs);
    });
    await oni.wait(cfg.fireAfterMs);

    oni.fireDone();
    oni.screenshake({ duration: 620, intensity: 11 });
    oni.domFlash?.({ color: '#e6b8ff', alpha: 0.3, fadeIn: 30, fadeOut: 240 });
    for (const t of targets) {
      oni.vfx(cfg.GGS + "spark_anim01.webm", { x: t.center.x, y: t.center.y, size: Math.max(t.w, 150) * 1.8, zIndex: 96300, blend: PIXI.BLEND_MODES.ADD, angle: Math.random() * 360 }).then((s) => { if (s) s.sprite.tint = cfg.sparkTint; });
    }
    await oni.wait(cfg.tailMs);
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/paryashera-thunder-vent",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.chargeMs + CFG.fireAfterMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
