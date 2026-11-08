// @desc Hina Lunar Bow attack: moon-dust gathers at the bow, a moonlight arrow flies, a crescent moon blooms on the hit (pixelfx, original)
"use strict";
// Lunar Bow (Hina's weapon, Light). Every visual here is original pixel-art code,
// written with the pixelfx method (E:\...\Animation\pixelfx\src\fx\fu\lunar-arrow.js
// and lunar-impact.js), exported as 3-layer clips and played with oni.pxfx.
//
// Beats: moon-dust gathers at the bow | loose: the arrow flies chest to chest |
//        HIT: crescent impact + damage + hitstop | MISS: the arrow streaks past and fades.
//
// DAMAGE TIMING: animation_damage_timing_options = "default", so the damage gate is
// oni:animationEnd. The outer fires it when the inner calls oni.fireDone() at contact.
(async () => {
  const PX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/pixelfx/";
  const CFG = {
    S: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/",
    arrow: { base: PX + "pxfx_light_lunar_arrow", width: 256, anchor: { x: 0.8125, y: 0.5 } },
    impact: { base: PX + "pxfx_light_lunar_impact", width: 352, anchor: { x: 0.5, y: 0.875 } },
    gatherMs: 320,      // moon-dust drawn into the bow
    flyMs: 380,         // arrow flight, whatever the distance (reads as one quick shot)
    arrowK: 1.0,        // arrow size on top of its depth scale
    impactK: 1.5,       // the crescent reads small at board zoom at 1.0
    impactSkipMs: 60,   // the impact clip's own streak overlaps the arrow; start it here
    hitstopMs: 70,
    chest: 0.45,        // aim point, as a fraction of the drawn body height from the feet
    missPastPx: 260,    // a miss carries on this far past the target, fading
    volume: 0.8,
    previewOutcome: "hit",
  };

  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);

  // Did it land? payload.outcomes (stamped after the accuracy roll), else the live director.
  let outcome = null;
  try {
    const pick = (rows) => (Array.isArray(rows) && rows.length ? rows.find((r) => r && r.tokenUuid === targetUuids[0]) ?? rows[0] : null);
    let row = pick(P.outcomes);
    if (!row) row = pick(globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.()?.ctx?.actionResult?.perTargetResults);
    if (row && row.hit !== null && row.hit !== undefined) outcome = row.hit ? "hit" : "miss";
  } catch (e) { /* bench / no battle: previewOutcome */ }

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  Hooks.callAll("oni:animationStart", { local: true, world: false });

  // INNER (every client). No backticks and no dollar-brace inside.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const outcome = ctx.params.outcome || cfg.previewOutcome || 'hit';
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
    const bowX = A.chest.x + dir * 18 * A.m, bowY = A.chest.y;

    // 1. Draw: moon-dust gathers into the bow.
    oni.particles({ x: bowX, y: bowY, mode: 'gather', count: 18, color: 0xd8dcf4, size: 7, radius: 70 * A.m, life: cfg.gatherMs, stagger: 60, blend: PIXI.BLEND_MODES.ADD });
    oni.sfx(cfg.S + 'Soundboard/Starlight.ogg', { volume: cfg.volume * 0.25 });
    await oni.wait(cfg.gatherMs);

    // 2. Loose.
    oni.sfx(cfg.S + 'Soundboard/Crossbow.ogg', { volume: cfg.volume * 0.45 });
    const arrow = await oni.pxfx(cfg.arrow, { x: bowX, y: bowY, mirror: mirror, k: cfg.arrowK * A.m });
    for (const f of arrow.parts) { f.video.loop = true; f.sprite.rotation = ang; }
    const fly = (x0, y0, x1, y1, ms, fadeOut) => oni.tween({ duration: ms, ease: (u) => u * u * 0.35 + u * 0.65, onUpdate: (u) => {
      const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u;
      for (const f of arrow.parts) { f.sprite.position.set(x, y); if (fadeOut) f.sprite.alpha = 1 - u; }
    } });
    const endArrow = () => { for (const f of arrow.parts) { try { f.video.loop = false; f.video.pause(); f.sprite.destroy(); } catch (e) {} } };

    if (outcome === 'miss') {
      // it passes just over the target and carries on, fading
      const lift = -14 * B.m;
      await fly(bowX, bowY, B.chest.x, B.chest.y + lift, cfg.flyMs, false);
      oni.fireDone();
      const slope = (B.chest.y - A.chest.y) / ((B.chest.x - A.chest.x) || 1);
      const px = B.chest.x + dir * cfg.missPastPx * B.m, py = B.chest.y + lift + slope * (px - B.chest.x);
      await fly(B.chest.x, B.chest.y + lift, px, py, cfg.flyMs * 0.7, true);
      endArrow();
      return;
    }

    await fly(bowX, bowY, B.chest.x, B.chest.y, cfg.flyMs, false);
    endArrow();

    // 3. Hit: the crescent blooms where it lands; damage on the flash.
    const hit = await oni.pxfx(cfg.impact, { token: target, mirror: mirror, k: cfg.impactK });
    try { for (const f of hit.parts) f.video.currentTime = cfg.impactSkipMs / 1000; } catch (e) {}
    oni.sfx(cfg.S + 'Hit_Piercing.wav', { volume: cfg.volume * 0.45 });
    oni.sfx(cfg.S + 'Soundboard/Starlight.ogg', { volume: cfg.volume * 0.35 });
    oni.hit();
    oni.fireDone();
    await oni.hitstop(cfg.hitstopMs);
    // the crescent and its dust outlive the script (oni.vfx clips are not disposed)
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/hina-lunar-bow",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG, outcome },
  });

  await onceHook(doneHook, CFG.gatherMs + CFG.flyMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
