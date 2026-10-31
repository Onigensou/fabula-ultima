// @desc Fulgimite reveal: the Crystal shakes and whitens, turns into a Fulgimite and, given a target, drops a violet bolt on it. With no target it is the reveal alone. Played from the Crystal token
"use strict";
(async () => {
  const CFG = {
    MV: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/RPG%20Maker%20MV/",
    D4: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Disgaea%204/webm/",
    S: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/",
    art: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Fulgimite_Standard.png",
    scale: 1,              // the actor's token scale: the shot ends on the pose the real token starts in
    beatMs: 520,
    shakeMs: 620,
    shakePx: 7,
    popMs: 640,
    hopPx: 110,
    counterBeatMs: 380,
    anchorY: 0.858,        // the bolt clip's ground point
    hue: 225,              // yellow to violet, same as Thunder Vent
    boltSize: 620,
    boltRate: 0.7,
    fireAfterMs: 190,
    paraDelayMs: 420,
    paraSize: 420,
    tailMs: 900,
    ringSize: 190,
    ringRate: 0.6,
    holdForSwapMs: 15000,  // the swap normally ends this much sooner
    volume: 0.65,
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
    const target = oni.targets[0] ?? null;
    if (!caster || !caster.mesh) { oni.fireDone(); return; }
    const sfx = (f, k = 1) => oni.sfx(cfg.S + f, { volume: cfg.volume * k });

    const load = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
    const tex = await load(cfg.art);

    // Everything the swap must not reveal lives OUTSIDE the script's own layer,
    // because the script ends before the event swaps the tokens. This holds the
    // finished Fulgimite in place and the Crystal hidden until the Crystal token is
    // actually gone, by which point the real token is already drawn beneath it.
    const stay = new PIXI.Container();
    stay.zIndex = 95400;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(stay);
    const mesh = caster.mesh;
    const body = new PIXI.Sprite(mesh.texture);
    body.anchor.set(0.5);
    body.width = mesh.width;
    body.height = mesh.height;
    body.scale.x = Math.abs(body.scale.x) * (Math.sign(mesh.scale?.x || 1) || 1);
    body.position.set(caster.center.x, caster.center.y);
    stay.addChild(body);
    const hx = body.x, hy = body.y;
    const hold = canvas.app.ticker;
    const giveUpAt = performance.now() + cfg.holdForSwapMs;
    const guard = () => {
      const gone = caster.destroyed;
      if (!gone && performance.now() < giveUpAt) {
        caster.renderable = false;
        if (caster.mesh) caster.mesh.renderable = false;
        return;
      }
      hold.remove(guard);
      if (!gone) { caster.renderable = true; if (caster.mesh) caster.mesh.renderable = true; }
      try { stay.destroy({ children: true }); } catch (e) {}
    };
    hold.add(guard);

    // Shake and whiten.
    await oni.wait(cfg.beatMs);
    sfx("HitElectric.ogg", 0.8);
    const white = new PIXI.ColorMatrixFilter();
    body.filters = [white];
    await oni.tween({ from: 0, to: 1, duration: cfg.shakeMs, ease: E.inQuad, onUpdate: (v) => {
      body.x = hx + (Math.random() - 0.5) * 2 * cfg.shakePx;
      white.brightness(1 + 2.4 * v, false);
    } });
    body.x = hx;

    // Into the creature. Contain-fit in the token's box, same as Foundry draws it.
    oni.vfx(cfg.D4 + "flash_ring_white.webm", { x: hx, y: hy, size: cfg.ringSize, zIndex: 96100, blend: PIXI.BLEND_MODES.ADD, alpha: 0.85 }).then((fx) => { if (fx) try { fx.video.playbackRate = cfg.ringRate; } catch (e) {} });
    body.texture = tex;
    const box = canvas.grid.size;
    const fit = Math.min(box / tex.width, box / tex.height) * cfg.scale;
    const flip = Math.sign(caster.mesh.scale.x || -1) || -1;
    sfx("Soundboard/Jump1.ogg");
    await oni.tween({ from: 0, to: 1, duration: cfg.popMs, ease: E.linear, onUpdate: (u) => {
      white.brightness(1 + 2.4 * (1 - E.outQuad(Math.min(1, u * 1.6))), false);
      const q = E.outQuad(u);
      body.scale.set(flip * fit * (1.25 - 0.25 * q), fit * (0.35 + 0.65 * q + Math.sin(u * Math.PI) * 0.18));
      body.y = hy - 4 * cfg.hopPx * u * (1 - u);
    } });
    body.filters = null;
    body.scale.set(flip * fit, fit);
    body.position.set(hx, hy);
    sfx("Soundboard/Earth3.ogg", 0.7);

    if (!target) { oni.fireDone(); await oni.wait(cfg.tailMs); return; }

    // The counter.
    await oni.wait(cfg.counterBeatMs);
    const hue = new PIXI.ColorMatrixFilter();
    hue.hue(cfg.hue, false);
    sfx("Thunder7.ogg", 1.15);
    oni.vfx(cfg.MV + "076_thunder_one_1.webm", { x: target.center.x, y: target.y + target.h, size: cfg.boltSize, zIndex: 96200 }).then((b) => {
      if (!b) return;
      b.sprite.anchor.set(0.5, cfg.anchorY);
      b.sprite.filters = [hue];
      try { b.video.playbackRate = cfg.boltRate; } catch (e) {}
    });
    await oni.wait(cfg.fireAfterMs);
    oni.hit();
    oni.fireDone();
    oni.screenshake({ duration: 420, intensity: 8 });
    await oni.wait(cfg.paraDelayMs);
    sfx("Soundboard/Paralyze1.ogg", 0.9);
    oni.vfx(cfg.MV + "064_paralyze.webm", { x: target.center.x, y: target.center.y, size: cfg.paraSize, zIndex: 96300 }).then((p) => {
      if (p) p.sprite.filters = [hue];
    });
    await oni.wait(cfg.tailMs);
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/fulgimite-reveal",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.beatMs + CFG.shakeMs + CFG.popMs + 8000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
