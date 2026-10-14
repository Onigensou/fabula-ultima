// @desc Crysta Mirage Strike: she dissolves, vanishes, and re-forms at her target (oni)
"use strict";
// BD runs the OUTER script as a non-async new Function("payload","targets"), so
// the whole body is an async IIFE.
//
// DAMAGE TIMING (verified in director-animation.js waitForDamageMoment):
// with animation_damage_timing_options = "default" the damage gate IS the
// oni:animationEnd hook. So we fire it at the instant she reappears in front of
// the target -- that is the beat the damage number pops on. The dissolve-home
// tail runs AFTER the gate and is purely cosmetic.
//
// Beats: hand off to a stand-in | fade out | wait | fade in in front of target |
//        DAMAGE | hold | dissolve, token is back home.
//
// ---------------------------------------------------------------------------
// FOUR THINGS THAT ARE EASY TO GET WRONG HERE, ALL MEASURED 2026-09-01
//
// 1. NEVER BUILD A SECOND <video> FOR ART THE TOKEN ALREADY SHOWS.
//    oni.webmSprite creates a fresh <video> and re-fetches the file, which is
//    seconds of network + decode before anything can happen on screen. But the
//    token's mesh texture IS that webm, already decoded and playing, and
//    oni.cloneToken hands back a sprite sharing it. So when the chosen art
//    matches the token art the CLONE IS HER IMAGE: nothing to load, nothing to
//    seek, and the cinematic starts on the frame you press play. A second
//    sprite is built only when the art genuinely differs (sprite_standard).
//    Sharing is safe -- we render the shared texture, never mutate it, and
//    never seek or pause the token's video.
//
// 2. THE FLOAT IS INSIDE THE WEBM. Crysta is a flying creature that bobs in
//    place, but nothing animates the token: sampled over 1.5 s her center.y and
//    mesh.position.y are both pinned at 385.0, swing 0. The bob is baked into
//    Crysta_Battler001.webm. That is why a freshly-created <video> (which starts
//    at t=0) jumped at the hand-off, and why a single sampled frame is a
//    phase-dependent, unreliable thing to measure. Sharing the token's own
//    texture makes phase a non-issue by construction.
//
// 3. LOAD BEFORE YOU HIDE. Any decode wait must happen before hideToken(), or
//    the stall lands mid-cinematic. It is now moot on the default path.
//
// 4. SIZE MATCHES CONTENT, NOT FRAME. Battler webm: 226x292 frame, 176x268
//    opaque (91.8% of height, 1.7% pad below her feet). Standard PNG: 180x256
//    frame, 168x256 opaque (100%, no pad). Matching frame heights draws her ~9%
//    too tall with her feet ~3 px low, so we match character-to-character and
//    align the two FEET lines when landing on the target.
// ---------------------------------------------------------------------------
(async () => {
  const CFG = {
    // Which actor prop supplies "her image".
    // sprite_battle (Crysta_Battler001.webm) is her ANIMATED battler AND her
    // token art, so the stand-in is free and instant (see note 1) and she keeps
    // moving for the whole cinematic. sprite_standard is the static portrait
    // PNG: it costs a load and gives a visible token -> portrait morph.
    spriteProp: "sprite_battle",

    // 1 = her stand-in renders the SAME CHARACTER HEIGHT as her token (and, on
    // the shared-texture path, an exact frame-for-frame match). Raise for a
    // larger-than-life mirage; her feet stay planted either way.
    imageScale: 1,
    revealScale: 1,        // extra multiplier once she reappears (1 = no loom)
    imageYOffset: 0,       // px nudge, + is down. Feet are auto-aligned.
    autoFace: true,        // mirror the art when the target is to her right

    // Only used when the art DIFFERS from the token (a real morph to draw).
    // On the default shared-texture path there is nothing to cross-fade, so
    // she begins dissolving immediately.
    morphMs: 260,
    fadeOutMs: 320,        // she dissolves
    waitMs: 1000,          // the beat where she is simply gone
    fadeInMs: 240,         // she resolves in front of the target
    holdMs: 260,           // beat on the strike before leaving
    returnMs: 300,         // dissolve at the target, token is back home

    frontOffset: 130,      // px in FRONT of the target, on the side she came from
    driftPx: 26,           // slight upward drift while dissolving
    tint: "#bcd8ff",       // moonlight shimmer behind the reappearance
    shimmerSize: 260,
    outSfx: "",            // manifest name, blank = silent (oni.sfx resolves)
    inSfx: "",
    volume: 0.8,

    // Fallbacks used ONLY if a runtime alpha scan cannot read pixels.
    tokenContentRatio: 0.9178, tokenBottomPad: 0.0171,
    imageContentRatio: 0.9178, imageBottomPad: 0.0171,
  };

  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);

  // Resolve her artwork OUTER-side: the inner runs on every client and a token
  // delta may not carry the actor, so hand it a plain URL.
  let imageUrl = "";
  try {
    const casterDoc = await fromUuid(casterUuid);
    const props = casterDoc?.actor?.system?.props ?? {};
    imageUrl = props[CFG.spriteProp] || props.sprite_battle || props.sprite_standard || "";
  } catch (e) { console.warn("[CrystaMirage] could not resolve caster art", e); }

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  Hooks.callAll("oni:animationStart", { local: true, world: false });

  // INNER (runs on every client). No backticks and no dollar-brace in here --
  // it is a String.raw template and both would be eaten by the outer.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const url = ctx.params.imageUrl;
    const caster = oni.caster;
    const target = oni.targets[0] || null;
    if (!caster) { oni.fireDone(); return; }

    // No target => nowhere to blink to, and she re-materialises where she
    // started. Say so out loud: silently landing at home reads as a
    // positioning bug when it is really an empty target list (a client reload
    // clears targeting, and the Bench re-reads targets on every Run).
    if (!target) {
      console.warn('[CrystaMirage] no target - she will re-materialise at her own position.');
      try { ui.notifications.warn('Mirage Strike: no target selected, so Crysta reappears in place.'); } catch (e) {}
    }

    const layer = oni.layer({ zIndex: 95000 });

    // ---- geometry helpers ---------------------------------------------------

    const meshH = (spr) => {
      const m = spr && spr.mesh;
      const h = m && m.height ? Math.abs(m.height) : 0;
      return h || (spr && spr.h) || 100;
    };
    // Rendered position. Equals the document centre unless something offsets the
    // mesh. Crysta's float is in the webm, not here, but reading the mesh is
    // correct in both cases.
    const renderX = (spr) => {
      const m = spr && spr.mesh;
      return (m && m.position && typeof m.position.x === 'number') ? m.position.x : spr.center.x;
    };
    const renderY = (spr) => {
      const m = spr && spr.mesh;
      return (m && m.position && typeof m.position.y === 'number') ? m.position.y : spr.center.y;
    };
    const frameBottomOf = (spr) => renderY(spr) + meshH(spr) / 2;

    // Vertical extent of the OPAQUE pixels, as ratios of the frame.
    const scanBox = (src, w, h) => {
      if (!src || !w || !h) return null;
      try {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(src, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        let minY = h, maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 12) {
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              break;
            }
          }
        }
        if (maxY < 0) return null;
        return { hRatio: (maxY - minY + 1) / h, botPad: (h - 1 - maxY) / h };
      } catch (e) { return null; }
    };

    const sourceOf = (tex) => {
      const r = tex && tex.baseTexture && tex.baseTexture.resource;
      return (r && (r.source || r.data)) || null;
    };
    const naturalOf = (tex) => {
      const bt = tex && tex.baseTexture;
      return {
        w: (bt && (bt.realWidth || bt.width)) || (tex && tex.width) || 0,
        h: (bt && (bt.realHeight || bt.height)) || (tex && tex.height) || 0,
      };
    };
    const boxOfPlaceable = (spr) => {
      const tex = spr && spr.mesh && spr.mesh.texture;
      const n = naturalOf(tex);
      return scanBox(sourceOf(tex), n.w, n.h);
    };

    // ---- 1. Measure the caster ---------------------------------------------

    const casterH = meshH(caster);
    const casterBox = boxOfPlaceable(caster);
    const tokRatio = casterBox ? casterBox.hRatio : cfg.tokenContentRatio;
    const tokBot   = casterBox ? casterBox.botPad : cfg.tokenBottomPad;
    const feetOf = (spr, botPad) => frameBottomOf(spr) - meshH(spr) * botPad;

    const tokMesh = caster.mesh || null;
    const tokSrc = (caster.document && caster.document.texture && caster.document.texture.src) || '';
    const sameArt = !!(tokSrc && url && tokSrc === url);
    const homeX = renderX(caster);
    const homeY = renderY(caster);
    const homeFacing = target ? (target.center.x <= homeX) : true;

    // ---- 2. Hand off. Instant: the clone shares the token's live texture. ---

    const clone = oni.cloneToken(caster, { parent: layer });
    const restore = oni.hideToken(caster);

    // ---- 3. Her stand-in ----------------------------------------------------
    // Same art as the token (default)? The clone already IS her animated
    // battler, live and in phase. Reuse it: no <video>, no fetch, no decode
    // wait, no phase sync -- this is what makes it start instantly.

    let img = null;
    let vid = null;
    let morphed = false;
    let imgRatio = tokRatio;
    let imgBot = tokBot;
    let frameH = casterH;
    let aspect = 1;

    if (clone) {
      // Re-anchor the clone to bottom-centre so every later move plants her feet.
      const ch = Math.abs(clone.height) || casterH;
      const cw = Math.abs(clone.width) || casterH;
      aspect = cw / (ch || 1);
      frameH = ch;
      clone.anchor.set(0.5, 1);
      clone.position.set(homeX, homeY + ch / 2);
    }

    if (sameArt || !url) {
      img = clone;
    } else {
      // Genuinely different art -- build it, and pay the load BEFORE anything
      // visible depends on it.
      if (/[.]webm([?#]|$)/i.test(url)) {
        const made = oni.webmSprite(url, { loop: true, parent: layer });
        img = made.sprite; vid = made.video;
      } else {
        img = new PIXI.Sprite(PIXI.Texture.from(url));
        layer.addChild(img);
      }
      img.anchor.set(0.5, 1);
      img.alpha = 0;

      const settle = async (spr, video, ms) => {
        if (video) {
          await new Promise((res) => {
            let fired = false;
            const fin = () => { if (fired) return; fired = true; res(); };
            if (video.readyState >= 2 && video.videoWidth > 0) return fin();
            try { video.addEventListener('loadeddata', fin, { once: true }); } catch (e) { fin(); }
            setTimeout(fin, ms);
          });
        }
        const bt = spr && spr.texture && spr.texture.baseTexture;
        if (!bt || bt.valid) return;
        await new Promise((res) => {
          let fired = false;
          const fin = () => { if (fired) return; fired = true; res(); };
          try { bt.once('loaded', fin); bt.once('update', fin); } catch (e) { fin(); }
          setTimeout(fin, ms);
        });
      };
      await settle(img, vid, 2500);

      const n = naturalOf(img.texture);
      const box = scanBox(sourceOf(img.texture), n.w, n.h);
      if (box) { imgRatio = box.hRatio; imgBot = box.botPad; }
      aspect = (n.w || 1) / (n.h || 1);
      frameH = (casterH * tokRatio * cfg.imageScale) / (imgRatio || 1);
      morphed = true;
    }

    // Size + face + plant the feet at a given ground line.
    const place = (spr, x, feetY, faceLeft, mult) => {
      if (!spr) return;
      const h = frameH * (mult || 1);
      spr.height = h;
      spr.width = h * aspect;
      // Order matters: setting width/height rewrites scale and wipes a mirror sign.
      if (cfg.autoFace) spr.scale.x = Math.abs(spr.scale.x) * (faceLeft ? 1 : -1);
      spr.position.set(x, feetY + h * imgBot + cfg.imageYOffset);
    };

    const homeFeet = feetOf(caster, tokBot);

    // ---- 4. Token -> image, ONLY when there is actually a change to show ----

    if (morphed) {
      place(img, homeX, homeFeet, homeFacing, 1);
      await oni.tween({
        duration: cfg.morphMs, ease: oni.EASE.outQuad,
        onUpdate: (v) => { img.alpha = v; if (clone) clone.alpha = 1 - v; },
      });
      if (clone) clone.alpha = 0;
    } else if (img && cfg.imageScale !== 1) {
      // Shared texture but deliberately rescaled -- resize in place, no fade.
      place(img, homeX, homeFeet, homeFacing, 1);
    }

    // ---- 5. Dissolve, drifting up a touch -----------------------------------

    if (cfg.outSfx) oni.sfx(cfg.outSfx, { volume: cfg.volume });
    if (img) {
      const y0 = img.position.y;
      await oni.tween({
        duration: cfg.fadeOutMs, ease: oni.EASE.inQuad,
        onUpdate: (v) => { img.alpha = 1 - v; img.position.y = y0 - cfg.driftPx * v; },
      });
      img.alpha = 0;
    }

    // ---- 6. Gone ------------------------------------------------------------

    await oni.wait(cfg.waitMs);

    // ---- 7. Resolve in FRONT of the target ----------------------------------

    let landX = homeX;
    let landFeet = homeFeet;
    if (target) {
      const side = (homeX >= target.center.x) ? 1 : -1;
      landX = renderX(target) + cfg.frontOffset * side;
      const tBox = boxOfPlaceable(target);
      landFeet = feetOf(target, tBox ? tBox.botPad : 0);
    }
    if (img) {
      place(img, landX, landFeet, target ? (renderX(target) <= landX) : true, cfg.revealScale);
    }

    const shimmer = new PIXI.Sprite(oni.radialTexture(cfg.tint, 'rgba(0,0,0,0)', { size: 256 }));
    shimmer.anchor.set(0.5);
    shimmer.blendMode = PIXI.BLEND_MODES.ADD;
    shimmer.position.set(landX, landFeet - (casterH * tokRatio * cfg.imageScale * cfg.revealScale) / 2);
    shimmer.alpha = 0;
    layer.addChild(shimmer);

    if (cfg.inSfx) oni.sfx(cfg.inSfx, { volume: cfg.volume });
    await oni.tween({
      duration: cfg.fadeInMs, ease: oni.EASE.outCubic,
      onUpdate: (v) => {
        if (img) img.alpha = v;
        shimmer.width = shimmer.height = cfg.shimmerSize * v;
        shimmer.alpha = 1 - v;
      },
    });
    if (img) img.alpha = 1;
    shimmer.alpha = 0;

    // ---- 8. DAMAGE MOMENT ---------------------------------------------------
    // Under timing mode "default" this is the gate the Battle Director applies
    // damage on, so the number pops here.
    oni.fireDone();

    // ---- 9. Cosmetic tail, runs after the gate ------------------------------
    // She dissolves at the target and the real token is simply back home --
    // symmetric with her vanishing act, and it needs no second sprite.

    await oni.wait(cfg.holdMs);
    if (img) {
      await oni.tween({
        duration: cfg.returnMs, ease: oni.EASE.inQuad,
        onUpdate: (v) => { img.alpha = 1 - v; },
      });
      img.alpha = 0;
    }
    restore();
  `;

  game.ONI.pseudo.play({
    scriptId: "crysta/mirage-strike",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG, imageUrl },
  });

  // Wait for the reappearance, then open the damage gate.
  const preImpact = CFG.morphMs + CFG.fadeOutMs + CFG.waitMs + CFG.fadeInMs;
  await onceHook(doneHook, preImpact + 6000);
  // sourceTokenId scopes the emit so a concurrent cinematic cannot resolve our
  // gate (see playSkillAnimation's onEnd filter).
  Hooks.callAll("oni:animationEnd", {
    local: true, world: false,
    sourceTokenId: String(casterUuid || "").split(".Token.").pop() || null,
  });
})();
