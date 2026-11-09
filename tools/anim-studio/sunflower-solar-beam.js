// @desc Sunflower Staff Solar Beam: a sun swells at the staff, a fixed horizontal beam of sunlight swells across the field until the screen whites out to the enemies' silhouettes (pixelfx originals)
"use strict";
// Solar Beam (Sunflower Staff, All Enemy, 75 Light at 5 Solar Charge, split). Approved on the review mockup
// 2026-11-09/10 (rounds 3-5). Our own pixel effects: fu/solar-charge (pxfx_light_solar_charge) and
// fu/solar-cannon (pxfx_light_solar_cannon: one 1920x400 clip, the beam swells and burns white).
//
// Beats: sun swells at the staff | the beam fires straight across toward the enemies (fixed horizontal, not
// aimed) and keeps swelling, the field rumbles | the screen slowly whites out, every enemy left as a black
// silhouette — DAMAGE lands at full white | the white drains away.
//
// DAMAGE TIMING: "default" → gate = oni:animationEnd, fired at full white (oni.fireDone()).
(async () => {
  const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
  const PX = FORGE + "Animation/pixelfx/";
  const CFG = {
    S: FORGE + "Sound/",
    charge: { base: PX + "pxfx_light_solar_charge", width: 256, anchor: { x: 0.5, y: 0.5 } },
    cannon: { base: PX + "pxfx_light_solar_cannon", width: 1920, anchor: { x: 0.0167, y: 0.5 } },
    chargeK: 0.85,      // charge sun size on top of the caster's depth scale
    chargePeakMs: 1150, // the charge clip's peak: the beam fires here
    whiteAtMs: 1700,    // after the beam fires, the screen starts whiting out
    whiteMs: 1150,      // slow whiteout
    silFrom: 0.5,       // silhouettes appear from this whiteness
    holdMs: 650,        // full white + silhouettes
    backMs: 700,        // white drains away
    chest: 0.55, staffFwd: 22,
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

  // INNER (every client). No backticks and no dollar-brace inside.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const caster = oni.caster;
    const targets = oni.targets || [];
    if (!caster) { oni.fireDone(); return; }
    const st = globalThis.__ONI_BATTLE_STAGE_3D__;
    const bounds = (t) => { const b = st && st.drawnMeshBounds ? st.drawnMeshBounds(t) : null; return b && Number.isFinite(b.x) ? b : null; };
    const drawn = (t) => {
      const b = bounds(t);
      if (b) {
        const W = canvas.stage.worldTransform;
        const feet = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y + b.height));
        const top = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y));
        return { feet: feet, chest: { x: feet.x, y: feet.y + (top.y - feet.y) * cfg.chest }, m: b.width / Math.abs(t.mesh.width || b.width) };
      }
      return { feet: { x: t.center.x, y: t.y + t.h }, chest: { x: t.center.x, y: t.center.y }, m: 1 };
    };
    const A = drawn(caster);
    // which way the enemies are: the average of the targets (party fires left, enemies fire right)
    let tx = 0; for (const t of targets) tx += drawn(t).chest.x;
    const dir = targets.length ? ((tx / targets.length) >= A.chest.x ? 1 : -1) : -1, mirror = dir < 0;
    const sx = A.chest.x + dir * cfg.staffFwd * A.m, sy = A.chest.y;

    // 1. The sun swells at the staff.
    oni.sfx(cfg.S + 'Soundboard/Absorb1.ogg', { volume: cfg.volume * 0.4 });
    const charge = await oni.pxfx(cfg.charge, { x: sx, y: sy, k: cfg.chargeK * A.m });
    await oni.wait(cfg.chargePeakMs);

    // 2. The beam: fixed horizontal from the staff, sized to reach past the far edge of the screen.
    const sc = oni.screen();
    const left = sc.S2W(0, 0).x, right = sc.S2W(1, 0).x;
    const far = dir < 0 ? sx - left : right - sx;
    const k = Math.max(1, (far * 1.08) / (cfg.cannon.width * (1 - cfg.cannon.anchor.x)));
    oni.sfx(cfg.S + 'Soundboard/Saint5.ogg', { volume: cfg.volume * 0.5 });
    const cannon = await oni.pxfx(cfg.cannon, { x: sx, y: sy, mirror: mirror, k: k });
    setTimeout(() => { for (const f of (charge.parts || [])) { try { f.sprite.destroy(); } catch (e) {} } }, 300);
    oni.screenshake({ duration: cfg.whiteAtMs + cfg.whiteMs, intensity: 4 });
    await oni.wait(240);
    oni.sfx(cfg.S + 'Soundboard/Flash1.ogg', { volume: cfg.volume * 0.45 });
    await oni.wait(Math.max(0, cfg.whiteAtMs - 240));

    // 3. Whiteout: a screen-locked white sheet, the enemies as black silhouettes over it.
    const L = oni.layer({ zIndex: 100000 });
    const white = new PIXI.Graphics();
    const tl = sc.S2W(0, 0);
    white.beginFill(0xffffff, 1).drawRect(tl.x, tl.y, sc.wLen(sc.W), sc.wLen(sc.H)).endFill();
    white.alpha = 0; L.addChild(white);
    const sils = [];
    for (const t of targets) {
      const b = bounds(t), mesh = t.mesh;
      if (!mesh || !mesh.texture) continue;
      const spr = new PIXI.Sprite(mesh.texture);
      spr.tint = 0x000000; spr.alpha = 0; spr.zIndex = 10;
      if (b) {
        const p0 = canvas.stage.worldTransform.applyInverse(new PIXI.Point(b.x, b.y));
        spr.position.set(p0.x, p0.y); spr.width = b.width / sc.zoom; spr.height = b.height / sc.zoom;
      } else {
        spr.anchor.set(0.5, 0.5); spr.position.set(mesh.x, mesh.y); spr.width = Math.abs(mesh.width); spr.height = Math.abs(mesh.height);
      }
      if ((mesh.scale && mesh.scale.x) < 0) { spr.anchor.x = 1 - spr.anchor.x; spr.scale.x *= -1; if (b) spr.x += 0; }
      L.addChild(spr); sils.push(spr);
    }
    await oni.tween({ duration: cfg.whiteMs, ease: (u) => u * u, onUpdate: (u) => {
      white.alpha = u;
      const s = Math.max(0, (u - cfg.silFrom) / (1 - cfg.silFrom));
      for (const spr of sils) spr.alpha = s;
    } });

    // full white: the damage lands; the beam is gone when it drains
    oni.sfx(cfg.S + 'Soundboard/Flash1.ogg', { volume: cfg.volume * 0.5 });
    oni.fireDone();
    for (const f of (cannon.parts || [])) { try { f.video.pause(); f.sprite.destroy(); } catch (e) {} }
    await oni.wait(cfg.holdMs);

    // 4. The white drains away.
    await oni.tween({ duration: cfg.backMs, ease: (u) => 1 - (1 - u) * (1 - u), onUpdate: (u) => {
      white.alpha = 1 - u;
      for (const spr of sils) spr.alpha = Math.max(0, 1 - u * 2);
    } });
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/sunflower-solar-beam",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.chargePeakMs + CFG.whiteAtMs + CFG.whiteMs + 8000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
