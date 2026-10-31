// @desc Fulgimite Bite: crouch, one leap to the target, two claw marks crossing, hop home. Simple on purpose, it is chaff
"use strict";
(async () => {
  const CFG = {
    MV: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/RPG%20Maker%20MV/",
    S: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/",
    windupMs: 420,
    leapMs: 560,
    leapArc: 130,
    holdMs: 260,
    returnMs: 720,
    stopShort: 150,    // stands this far from the target's centre
    clawSize: 400,
    clawRate: 0.8,
    hitSize: 300,
    volume: 0.7,
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
    const body = oni.cloneToken(caster, { parent: layer });
    const restore = oni.hideToken(caster);
    const hx = body.x, hy = body.y;
    const sx = body.scale.x, sy = body.scale.y;
    const dir = target.center.x >= hx ? 1 : -1;
    const tx = target.center.x - dir * cfg.stopShort, ty = target.center.y;

    // Crouch.
    await oni.tween({ from: 0, to: 1, duration: cfg.windupMs, ease: E.inOutQuad, onUpdate: (v) => {
      body.scale.set(sx * (1 + 0.12 * v), sy * (1 - 0.22 * v));
    } });

    // One leap.
    oni.sfx(cfg.S + "Soundboard/Jump1.ogg", { volume: cfg.volume * 0.7 });
    await oni.jump(body, { height: cfg.leapArc, duration: cfg.leapMs, to: { x: tx, y: ty }, onUpdate: (u) => {
      const k = u < 0.3 ? 0.78 + 0.5 * (u / 0.3) : 1.28 - 0.28 * ((u - 0.3) / 0.7);
      body.scale.set(sx, sy * k);
    } });
    body.scale.set(sx, sy);

    // The bite: two claw marks crossing.
    oni.hit();
    oni.fireDone();
    oni.sfx(cfg.S + "HitBlowS.ogg", { volume: cfg.volume });
    const cx = target.center.x, cy = target.center.y;
    const claw = cfg.MV + "016_claw_physical.webm";
    oni.vfx(claw, { x: cx, y: cy, size: cfg.clawSize, zIndex: 96000 }).then((fx) => { if (fx) try { fx.video.playbackRate = cfg.clawRate; } catch (e) {} });
    oni.vfx(claw, { x: cx, y: cy, size: cfg.clawSize, zIndex: 96000, mirror: true }).then((fx) => { if (fx) try { fx.video.playbackRate = cfg.clawRate; } catch (e) {} });
    oni.vfx(cfg.MV + "001_hit_physical.webm", { x: cx, y: cy, size: cfg.hitSize, zIndex: 96100 });
    await oni.wait(cfg.holdMs);

    // Hop home.
    oni.sfx(cfg.S + "Soundboard/Jump1.ogg", { volume: cfg.volume * 0.4 });
    await oni.jump(body, { height: cfg.leapArc * 0.6, duration: cfg.returnMs, to: { x: hx, y: hy } });
    await oni.tween({ from: 0, to: 1, duration: 240, ease: E.inOutQuad, onUpdate: (v) => {
      body.scale.set(sx, sy * (0.86 + 0.14 * v));
    } });
    restore();
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/fulgimite-bite",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.windupMs + CFG.leapMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
