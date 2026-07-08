// @desc Projectile: glowing bolt caster→target, impact flash + screenshake (oni)
"use strict";
// NOTE: BD runs the OUTER script as a non-async new Function("payload","targets").
// Wrap the whole body in an async IIFE (not returned) so await works; the
// oni:animationEnd hook is BD's damage sync point. See the authoring guide.
(async () => {
  const CFG = {
    color: "#ff8a3d",     // bolt / burst tint
    boltSize: 90,         // px
    travelMs: 420,        // caster → target flight time
    fireSfx: "Fire2",     // manifest name (oni.sfx resolves)
    hitSfx: "Explosion",
    volume: 0.8,
    shakeMs: 300,
    shakeIntensity: 7,
    burstMs: 320,
    burstSize: 260,
  };

  // ── resolve caster/targets, broadcast the inner, gate on impact ──
  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  Hooks.callAll("oni:animationStart", { local: true, world: false });

  // INNER (every client): uses the oni helper library. No backticks allowed here.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const caster = oni.caster;
    const target = oni.targets[0] || null;
    if (!caster || !target) { oni.fireDone(); return; }

    const layer = oni.layer({ zIndex: 95000 });
    const bolt = new PIXI.Sprite(oni.radialTexture(cfg.color, 'rgba(0,0,0,0)', { size: 128 }));
    bolt.anchor.set(0.5);
    bolt.blendMode = PIXI.BLEND_MODES.ADD;
    bolt.width = bolt.height = cfg.boltSize;
    bolt.position.set(caster.center.x, caster.center.y);
    layer.addChild(bolt);

    oni.sfx(cfg.fireSfx, { volume: cfg.volume });
    await oni.tween({
      duration: cfg.travelMs, ease: oni.EASE.inQuad,
      onUpdate: (v) => bolt.position.set(
        caster.center.x + (target.center.x - caster.center.x) * v,
        caster.center.y + (target.center.y - caster.center.y) * v
      ),
    });

    // Impact — fire the damage gate the instant the bolt lands.
    oni.sfx(cfg.hitSfx, { volume: cfg.volume });
    oni.screenshake({ duration: cfg.shakeMs, intensity: cfg.shakeIntensity });
    oni.fireDone();

    const burst = new PIXI.Sprite(oni.radialTexture(cfg.color, 'rgba(0,0,0,0)', { size: 256 }));
    burst.anchor.set(0.5);
    burst.blendMode = PIXI.BLEND_MODES.ADD;
    burst.position.set(target.center.x, target.center.y);
    layer.addChild(burst);
    await oni.tween({
      from: 0, to: 1, duration: cfg.burstMs, ease: oni.EASE.outCubic,
      onUpdate: (v) => { burst.width = burst.height = cfg.burstSize * v; burst.alpha = 1 - v; },
    });
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/projectile",   // required — pseudo.play blocks calls without one
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  // Sync on the inner's impact signal, then fire the damage gate.
  await onceHook(doneHook, CFG.travelMs + 4000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
