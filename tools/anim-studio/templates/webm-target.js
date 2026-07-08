// @desc WebM on target: optional white pre-flash, play a .webm effect, screenshake (oni)
"use strict";
(async () => {
  const CFG = {
    // Full URL or a Forge asset path. Put a .webm effect here.
    webmUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Effects/Explosion_01_Orange.webm",
    size: 320,            // px width of the webm sprite
    anchor: "target",     // "target" | "caster"
    preFlash: true,       // white silhouette flash before the hit
    flashMs: 120,
    castSfx: "Fire2",
    hitSfx: "Explosion",
    volume: 0.85,
    shakeMs: 260,
    shakeIntensity: 6,
    fireDoneAt: 200,      // ms into the webm to land damage
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
    const caster = oni.caster;
    const anchor = cfg.anchor === 'caster' ? caster : (oni.targets[0] || caster);
    if (!anchor) { oni.fireDone(); return; }

    oni.sfx(cfg.castSfx, { volume: cfg.volume });

    if (cfg.preFlash) {
      const layer = oni.layer({ zIndex: 96000 });
      const flash = new PIXI.Sprite(oni.radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)', { size: 256 }));
      flash.anchor.set(0.5);
      flash.blendMode = PIXI.BLEND_MODES.ADD;
      flash.width = flash.height = cfg.size;
      flash.position.set(anchor.center.x, anchor.center.y);
      layer.addChild(flash);
      await oni.tween({ from: 1, to: 0, duration: cfg.flashMs, ease: oni.EASE.outQuad, onUpdate: (v) => (flash.alpha = v) });
    }

    const { sprite, video } = oni.webmSprite(cfg.webmUrl, { loop: false });
    sprite.width = sprite.height = cfg.size;
    sprite.position.set(anchor.center.x, anchor.center.y);
    sprite.zIndex = 96500;

    oni.sfx(cfg.hitSfx, { volume: cfg.volume });
    oni.screenshake({ duration: cfg.shakeMs, intensity: cfg.shakeIntensity });

    // Land damage a beat into the effect.
    await oni.wait(cfg.fireDoneAt);
    oni.fireDone();

    // Hold until the webm finishes (or a safety cap).
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      video.addEventListener('ended', fin, { once: true });
      setTimeout(fin, 4000);
    });
  `;

  game.ONI.pseudo.play({
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.fireDoneAt + 5000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
