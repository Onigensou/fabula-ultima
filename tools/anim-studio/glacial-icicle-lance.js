// @desc Glacial Staff Icicle Lance: frost gathers at the staff, a needle-sharp glacier lance flies at the target, the standard Ice hit lands (pixelfx original + MV 004_hit_ice)
"use strict";
// Icicle Lance (Glacial Staff, single target, Pierce). Approved on the review mockup 2026-11-09/10:
// the projectile is our own pixel effect (E:\...\Animation\pixelfx\src\fx\fu\glacial-lance.js, exported as
// pxfx_ice_glacial_lance); the impact is the game's STANDARD Ice hit (RPG Maker MV 004_hit_ice at the default
// action clip size, SE_BTL_HitIce) — the user rejected a custom impact.
//
// Beats: frost motes gather at the staff | the lance flies chest to chest | contact: standard Ice hit + damage.
// A Pierce miss still lands (half damage), so hit and miss play the same.
//
// DAMAGE TIMING: animation_damage_timing_options = "default" → the gate is oni:animationEnd, fired by the
// outer when the inner calls oni.fireDone() at contact.
(async () => {
  const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
  const CFG = {
    S: FORGE + "Sound/",
    lance: { base: FORGE + "Animation/pixelfx/pxfx_ice_glacial_lance", width: 336, anchor: { x: 0.869, y: 0.5 } },
    hit: { url: FORGE + "Animation/RPG%20Maker%20MV/004_hit_ice.webm", w: 528, anchor: { x: 0.5, y: 0.5227 } },
    clipScale: 0.65,    // action-anim-script.js CLIP_SCALE: the default action clip size
    gatherMs: 360,      // frost drawn into the staff
    flyMs: 420,         // lance flight, whatever the distance
    lanceK: 0.9,        // lance size on top of its depth scale
    hitstopMs: 70,
    chest: 0.45,        // aim point, as a fraction of the drawn body height from the feet
    staffFwd: 20,       // the staff's head, px in front of the caster's chest (x depth)
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
    const target = oni.targets[0] || null;
    if (!caster || !target) { oni.fireDone(); return; }

    // Where a body is DRAWN (3D stage aware): feet, chest, depth scale.
    const drawn = (t) => {
      const st = globalThis.__ONI_BATTLE_STAGE_3D__;
      const b = st && st.drawnMeshBounds ? st.drawnMeshBounds(t) : null;
      if (b && Number.isFinite(b.x)) {
        const W = canvas.stage.worldTransform;
        const feet = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y + b.height));
        const top = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y));
        return { feet: feet, chest: { x: feet.x, y: feet.y + (top.y - feet.y) * cfg.chest }, m: b.width / Math.abs(t.mesh.width || b.width) };
      }
      return { feet: { x: t.center.x, y: t.y + t.h }, chest: { x: t.center.x, y: t.center.y }, m: 1 };
    };
    const A = drawn(caster), B = drawn(target);
    const dir = (B.chest.x - A.chest.x) >= 0 ? 1 : -1, mirror = dir < 0;
    const ang = Math.atan2(B.chest.y - A.chest.y, Math.abs(B.chest.x - A.chest.x)) * dir;
    const sx = A.chest.x + dir * cfg.staffFwd * A.m, sy = A.chest.y;

    // 1. Frost gathers into the staff.
    oni.particles({ x: sx, y: sy, mode: 'gather', count: 18, color: 0xbfeaff, size: 6, radius: 70 * A.m, life: cfg.gatherMs, stagger: 50, blend: PIXI.BLEND_MODES.ADD });
    oni.sfx(cfg.S + 'Soundboard/Magic1.ogg', { volume: cfg.volume * 0.3 });
    await oni.wait(cfg.gatherMs);

    // 2. The lance flies.
    oni.sfx(cfg.S + 'Soundboard/Ice1.ogg', { volume: cfg.volume * 0.25 });
    const lance = await oni.pxfx(cfg.lance, { x: sx, y: sy, mirror: mirror, k: cfg.lanceK * A.m });
    for (const f of lance.parts) { f.video.loop = true; f.sprite.rotation = ang; }
    await oni.tween({ duration: cfg.flyMs, ease: (u) => u * u * 0.35 + u * 0.65, onUpdate: (u) => {
      const x = sx + (B.chest.x - sx) * u, y = sy + (B.chest.y - sy) * u;
      for (const f of lance.parts) f.sprite.position.set(x, y);
    } });
    for (const f of lance.parts) { try { f.video.loop = false; f.video.pause(); f.sprite.destroy(); } catch (e) {} }

    // 3. Contact: the standard Ice hit, at the default action clip size, on the body.
    oni.vfx(cfg.hit.url, { x: B.chest.x, y: B.chest.y, size: cfg.hit.w * cfg.clipScale * B.m, zIndex: 95500 })
      .then((r) => { if (r && r.sprite) r.sprite.anchor.set(cfg.hit.anchor.x, cfg.hit.anchor.y); });
    oni.sfx(cfg.S + 'Soundboard/SE_BTL_HitIce_1.mp3', { volume: cfg.volume * 0.4 });
    oni.hit();
    oni.fireDone();
    await oni.hitstop(cfg.hitstopMs);
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/glacial-icicle-lance",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, CFG.gatherMs + CFG.flyMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
