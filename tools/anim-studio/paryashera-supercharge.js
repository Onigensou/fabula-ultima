// @desc Supercharge form change: sparks rush into the body, it flares white, and the new form bursts out in a purple shockwave
"use strict";
(async () => {
  const CFG = {
    GGS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Guilty%20Gear%20Strive/webm/",
    gatherMs: 1150,        // sparks rush in, the body brightens
    bursts: ["burst_anim02.webm", "burst_anim05.webm"],
    burstTint: 0xc98cff,
    sparkTint: 0xe2bcff,
    tailMs: 950,
    gatherSfx: "PowerUp2",
    burstSfx: "Thunder10",
    burstSfx2: "Explosion1",
    volume: 0.85,
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
    const E = oni.EASE;
    const caster = oni.caster;
    const mesh = caster && caster.mesh;
    if (!mesh) { oni.fireDone(); return; }
    const cx = caster.center.x, cy = caster.center.y;
    const bw = Math.abs(mesh.width), bh = Math.abs(mesh.height);
    const layer = oni.layer({ zIndex: 96000 });

    // A white copy of the body over the real one: only it fades, so the art swap
    // underneath happens at full brightness and is never seen.
    const flare = new PIXI.Sprite(mesh.texture);
    flare.anchor.set(0.5);
    flare.width = bw; flare.height = bh;
    flare.scale.x = Math.abs(flare.scale.x) * (Math.sign(mesh.scale.x || 1) || 1);
    flare.position.set(cx, cy);
    flare.blendMode = PIXI.BLEND_MODES.ADD;
    flare.alpha = 0;
    layer.addChild(flare);

    oni.sfx(cfg.gatherSfx, { volume: cfg.volume });
    oni.particles({ x: cx, y: cy, count: 56, color: 0xd29aff, size: 22, radius: bw * 0.95, life: cfg.gatherMs, lifeJitter: 0.2, stagger: cfg.gatherMs * 0.35, mode: 'gather', blend: PIXI.BLEND_MODES.ADD, parent: layer });
    oni.particles({ x: cx, y: cy, count: 26, color: 0xffffff, size: 13, radius: bw * 0.7, life: cfg.gatherMs * 0.9, stagger: cfg.gatherMs * 0.4, mode: 'gather', blend: PIXI.BLEND_MODES.ADD, parent: layer });

    // Arcs snapping toward the core, faster as it builds.
    const arcs = new PIXI.Graphics();
    arcs.blendMode = PIXI.BLEND_MODES.ADD;
    layer.addChild(arcs);
    await oni.tween({ from: 0, to: 1, duration: cfg.gatherMs, ease: E.inQuad, onUpdate: (v) => {
      flare.alpha = v * 0.9;
      arcs.clear();
      const n = Math.round(1 + v * 6);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        let x = cx + Math.cos(a) * bw * 0.62, y = cy + Math.sin(a) * bh * 0.62;
        arcs.lineStyle(i % 2 ? 3 : 5, i % 2 ? 0xc070ff : 0xffffff, 0.9).moveTo(x, y);
        for (let s = 0; s < 5; s++) {
          x += (cx - x) * 0.3 + (Math.random() - 0.5) * 34;
          y += (cy - y) * 0.3 + (Math.random() - 0.5) * 34;
          arcs.lineTo(x, y);
        }
      }
    } });
    arcs.clear();

    // Peak: the effect lands now, so the Supercharged art arrives under the flare.
    oni.fireDone();
    oni.sfx(cfg.burstSfx, { volume: cfg.volume });
    oni.sfx(cfg.burstSfx2, { volume: cfg.volume * 0.8 });
    oni.screenshake({ duration: 700, intensity: 15 });
    oni.domFlash?.({ color: '#e6b8ff', alpha: 0.55, fadeIn: 30, fadeOut: 420 });
    cfg.bursts.forEach((clip, i) => {
      oni.vfx(cfg.GGS + clip, { x: cx, y: cy, size: bw * (2.1 + i * 0.5), zIndex: 96500 + i, blend: PIXI.BLEND_MODES.ADD }).then((fx) => { if (fx) { fx.sprite.tint = cfg.burstTint; try { fx.video.playbackRate = 0.7; } catch (e) {} } });
    });
    oni.particles({ x: cx, y: cy, count: 70, color: 0xd29aff, size: 24, radius: bw * 1.25, life: cfg.tailMs, mode: 'burst', gravity: 60, blend: PIXI.BLEND_MODES.ADD, parent: layer });
    oni.particles({ x: cx, y: cy, count: 30, color: 0xffffff, size: 13, radius: bw * 0.95, life: cfg.tailMs * 0.8, mode: 'burst', blend: PIXI.BLEND_MODES.ADD, parent: layer });
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      oni.vfx(cfg.GGS + "spark_anim01.webm", { x: cx + Math.cos(a) * bw * 0.35, y: cy + Math.sin(a) * bh * 0.35, size: bw * 0.8, zIndex: 96400, blend: PIXI.BLEND_MODES.ADD, angle: Math.random() * 360 }).then((fx) => { if (fx) fx.sprite.tint = cfg.sparkTint; });
    }

    await oni.tween({ from: flare.alpha, to: 0, duration: cfg.tailMs * 0.75, ease: E.inOutQuad, onUpdate: (v) => { flare.alpha = v; } });
    await oni.wait(cfg.tailMs * 0.3);
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/paryashera-supercharge",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: [],
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.gatherMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
