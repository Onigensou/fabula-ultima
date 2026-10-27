// @desc Smoke Bomb: grey smoke puffs swallow the target (Guilty Gear smoke clips, tinted), Obscure lands as the smoke closes
"use strict";
(async () => {
  const CFG = {
    GGS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Guilty%20Gear%20Strive/webm/",
    puffClip: "smoke_anim12.webm",   // round billowing puff, 0.7 s, white mask
    plumeClip: "smoke_anim14.webm",  // rising plume, 0.8 s, white mask
    puffCount: 6,
    puffSizeFrac: 1.9,     // puff width as a fraction of the target token width
    puffSpread: 0.5,       // horizontal scatter as a fraction of token width
    puffStaggerMs: 220,    // delay between puffs
    puffRate: 0.4,         // video playbackRate (slower = heavier smoke)
    plumeSizeFrac: 2.6,
    plumeRate: 0.5,
    tint: 0x9a9aa0,        // grey smoke
    tintPlume: 0xb0b0b6,
    puffAlpha: 1,
    cloudSizeFrac: 3.2,    // lingering soft cloud behind the puffs
    cloudColor: 'rgba(120,120,128,0.95)',
    cloudInMs: 700,
    cloudHoldMs: 1400,
    cloudOutMs: 1800,
    cloudAlpha: 0.9,
    fireDoneAtMs: 900,     // Obscure lands as the puffs close over the target
    castSfx: "SmokeBomb",
    volume: 0.8,
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
    const cx = target.center.x, feetY = target.y + th;
    const layer = oni.layer({ zIndex: 95500 });

    // soft grey cloud that lingers after the clips are gone
    const cloud = new PIXI.Sprite(oni.radialTexture(cfg.cloudColor, 'rgba(120,120,128,0)', { size: 256 }));
    cloud.anchor.set(0.5);
    cloud.width = cloud.height = tw * cfg.cloudSizeFrac;
    cloud.position.set(cx, feetY - th * 0.45);
    cloud.alpha = 0;
    layer.addChild(cloud);

    oni.sfx(cfg.castSfx, { volume: cfg.volume });

    const tails = [];
    const puff = async (i) => {
      const side = (i % 2 === 0 ? -1 : 1) * (0.25 + Math.random() * 0.75);
      const x = cx + side * tw * cfg.puffSpread;
      const y = feetY - th * (0.25 + Math.random() * 0.5);
      const fx = await oni.vfx(cfg.GGS + cfg.puffClip, {
        x, y, size: tw * cfg.puffSizeFrac * (0.85 + Math.random() * 0.3),
        alpha: cfg.puffAlpha, angle: (Math.random() - 0.5) * 40, mirror: Math.random() < 0.5,
        zIndex: 96000 + i,
      });
      if (!fx) return;
      fx.sprite.tint = cfg.tint;
      try { fx.video.playbackRate = cfg.puffRate; } catch (e) {}
      tails.push(fx.ended);
    };

    // cloud rises while the puffs arrive
    const cloudIn = oni.tween({ from: 0, to: cfg.cloudAlpha, duration: cfg.cloudInMs, ease: oni.EASE.outQuad, onUpdate: (v) => (cloud.alpha = v) });

    let fired = false;
    const gate = setTimeout(() => { if (!fired) { fired = true; oni.fireDone(); } }, cfg.fireDoneAtMs);

    for (let i = 0; i < cfg.puffCount; i++) {
      await puff(i);
      await oni.wait(cfg.puffStaggerMs);
    }
    // the plume rises out of the middle once the puffs have closed in
    const plume = await oni.vfx(cfg.GGS + cfg.plumeClip, {
      x: cx, y: feetY - th * 0.9, size: tw * cfg.plumeSizeFrac, alpha: 0.85, zIndex: 95900,
    });
    if (plume) { plume.sprite.tint = cfg.tintPlume; try { plume.video.playbackRate = cfg.plumeRate; } catch (e) {} tails.push(plume.ended); }

    await cloudIn;
    if (!fired) { fired = true; clearTimeout(gate); oni.fireDone(); }
    await oni.wait(cfg.cloudHoldMs);
    await Promise.all([
      oni.tween({ from: cloud.alpha, to: 0, duration: cfg.cloudOutMs, ease: oni.EASE.inOutQuad, onUpdate: (v) => (cloud.alpha = v) }),
      Promise.all(tails),
    ]);
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/smoke-bomb",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.fireDoneAtMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
