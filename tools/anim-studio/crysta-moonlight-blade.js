// @desc Crysta Moonlight Blade: mirage strike, then a tinted crescent slash on the target (oni)
"use strict";
// Moonlight Blade = the Mirage Strike hand-off/vanish/re-form cinematic, plus a
// crescent slash one beat after she materialises.
//
// Beats: hand off to a stand-in | fade out | wait | fade in in front of target |
//        a beat | CRESCENT SLASH + DAMAGE | hold | travel home, token restored.
//
// DAMAGE TIMING (verified in director-animation.js waitForDamageMoment):
// with animation_damage_timing_options = "default" the damage gate IS the
// oni:animationEnd hook. It fires at the moment the crescent CONNECTS, not when
// she appears -- so the number lands on the hit.
//
// ---------------------------------------------------------------------------
// FIVE THINGS THAT ARE EASY TO GET WRONG HERE, ALL MEASURED 2026-09-01
//
// 1. NEVER BUILD A SECOND <video> FOR ART THE TOKEN ALREADY SHOWS.
//    oni.webmSprite creates a fresh <video> and re-fetches the file, which is
//    seconds of network + decode before anything can happen on screen. The
//    token's mesh texture IS her battler webm, already decoded and playing, and
//    oni.cloneToken hands back a sprite sharing it. So when the chosen art
//    matches the token art the CLONE IS HER IMAGE: nothing to load, nothing to
//    seek, and the cinematic starts on the frame you press play.
//
// 2. THE SLASH MUST NOT BE MEASURED AT RUNTIME. Seeking to a measure frame
//    (~850 ms) plus one 800x600 alpha scan (~625 ms) is ~1.5 s of dead air,
//    and with waitMs and slashDelayMs both 0 there is no idle beat left to
//    hide it behind. The eight content boxes are measured offline and baked
//    into CFG.slashBoxes; the runtime only waits for the video to decode,
//    which the fades cover. An unlisted asset still falls back to a scan.
//
// 3. THE FLOAT IS INSIDE THE WEBM. Crysta bobs in place, but nothing animates
//    the token: sampled over 1.5 s her center.y and mesh.position.y are both
//    pinned at 385.0, swing 0. Sharing the token's own texture makes the loop
//    phase a non-issue by construction.
//
// 4. LOAD BEFORE YOU HIDE. Any decode wait must happen before hideToken(), or
//    the stall lands mid-cinematic.
//
// 5. SIZE MATCHES CONTENT, NOT FRAME. Battler webm: 226x292 frame, 176x268
//    opaque (91.8% of height, 1.7% pad below her feet). Matching frame heights
//    draws her ~9% too tall with her feet ~3 px low, so we match
//    character-to-character and align FEET lines when landing on the target.
// ---------------------------------------------------------------------------
(async () => {
  const CFG = {
    // ---- her stand-in ----
    spriteProp: "sprite_battle",
    imageScale: 1,
    revealScale: 1,
    imageYOffset: 0,
    autoFace: true,

    morphMs: 260,          // only used when spriteProp art DIFFERS from the token
    fadeOutMs: 520,
    waitMs: 0,
    fadeInMs: 420,
    holdMs: 260,
    returnMs: 480,

    frontOffset: 130,
    // Travel reads in the FADES rather than as a separate slide: she carries
    // forward as she dissolves, and keeps carrying forward as she re-forms, so
    // each vanish/appear is one continuous move instead of two stills. The
    // return trip mirrors it, travelling the other way.
    departPx: 70,          // how far she slides onward while fading OUT
    arrivePx: 70,          // how far short of her mark she starts while fading IN
    outSfx: "",
    inSfx: "",
    volume: 0.8,

    // ---- the crescent slash ----
    slashDelayMs: 0,       // beat between her materialising and the strike
    // GenericSlash02, Blue -- the only asset in the free library that is
    // unambiguously a CRESCENT (peak-frame rendered and compared 2026-09-01;
    // the Scimitar01 family this first used is an impact STARBURST, ~214x144 of
    // its frame, which is why it read small and shapeless). Two sweep groups x
    // four variants = 8 distinct crescents, drawn at random per cast.
    slashAssets: [
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_001_001_Blue_800x600.webm",
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_001_002_Blue_800x600.webm",
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_001_003_Blue_800x600.webm",
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_001_004_Blue_800x600.webm",
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_002_001_Blue_800x600.webm",
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_002_002_Blue_800x600.webm",
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_002_003_Blue_800x600.webm",
      "modules/JB2A_DnD5e/Library/Generic/Weapon_Attacks/Melee/Slash02/GenericSlash02_002_004_Blue_800x600.webm",
    ],
    // NO TINT. PIXI's tint MULTIPLIES every channel, so a white-hot core
    // (255,255,255) becomes the tint colour and the highlight-to-edge contrast
    // collapses -- it washes the effect out. This asset already ships in her
    // blue, so there is nothing to gain. "#ffffff" = as shipped.
    slashTint: "#ffffff",
    slashBlend: "add",     // "add" glows, "normal" stays solid
    // The VISIBLE crescent's width as a multiple of the target's largest
    // rendered side -- measured from the asset's opaque content box at runtime,
    // NOT the frame. The crescent fills only ~41% of its 800x600 frame, so
    // sizing by the frame (what the old slashScale did) drew it less than half
    // the intended size.
    slashScale: 1.4,
    // Content boxes measured offline (2026-09-01, union of frames 0.15-0.50 of
    // each clip) so the RUNTIME never seeks or scans. That work cost ~850 ms to
    // seek plus ~625 ms to scan an 800x600 frame -- ~1.5 s of stall sitting
    // exactly where the pre-attack delay was meant to be removed. The variants
    // differ a lot (width .29-.49, height .53-.87), so one constant will not do.
    // Keyed by file name; an unlisted asset falls back to a runtime scan.
    slashBoxes: {
      "GenericSlash02_001_001_Blue_800x600.webm": { x: 0.3000, y: 0.2433, w: 0.4163, h: 0.5367 },
      "GenericSlash02_001_002_Blue_800x600.webm": { x: 0.3275, y: 0.0967, w: 0.4138, h: 0.8683 },
      "GenericSlash02_001_003_Blue_800x600.webm": { x: 0.4163, y: 0.1183, w: 0.3013, h: 0.7217 },
      "GenericSlash02_001_004_Blue_800x600.webm": { x: 0.2263, y: 0.1567, w: 0.4875, h: 0.6133 },
      "GenericSlash02_002_001_Blue_800x600.webm": { x: 0.3000, y: 0.2450, w: 0.4113, h: 0.5283 },
      "GenericSlash02_002_002_Blue_800x600.webm": { x: 0.3287, y: 0.0900, w: 0.4063, h: 0.8500 },
      "GenericSlash02_002_003_Blue_800x600.webm": { x: 0.4163, y: 0.1233, w: 0.2913, h: 0.7100 },
      "GenericSlash02_002_004_Blue_800x600.webm": { x: 0.2275, y: 0.1583, w: 0.4775, h: 0.6033 },
    },
    // Where the cut actually LANDS inside each clip, as frame fractions: the
    // alpha-weighted centroid of the arc at its impact frame (measured
    // 2026-09-01). The content box's geometric centre is NOT this point -- the
    // crescent's mass sits at 0.57-0.64 of its own box, never 0.5. Anchoring on
    // the box centre therefore threw the visible hit off by 30-55 px at a 400 px
    // crescent, and MIRRORING (she cuts left) flipped that mass to the left,
    // which is the drift. The anchor texel stays put under any scale sign, so
    // anchoring here lands the arc on the target both mirrored and not.
    slashHitPoints: {
      "GenericSlash02_001_001_Blue_800x600.webm": [0.5521, 0.5000],
      "GenericSlash02_001_002_Blue_800x600.webm": [0.5654, 0.4977],
      "GenericSlash02_001_003_Blue_800x600.webm": [0.5875, 0.4640],
      "GenericSlash02_001_004_Blue_800x600.webm": [0.5349, 0.4130],
      "GenericSlash02_002_001_Blue_800x600.webm": [0.5485, 0.4980],
      "GenericSlash02_002_002_Blue_800x600.webm": [0.5615, 0.4977],
      "GenericSlash02_002_003_Blue_800x600.webm": [0.5843, 0.4649],
      "GenericSlash02_002_004_Blue_800x600.webm": [0.5313, 0.4126],
    },
    // Manual trim, in frame fractions, applied on top. + moves the anchor right
    // / down, which slides the drawn arc left / up.
    slashHitNudge: [0, 0],
    slashMeasureFrac: 0.25, // fallback path only: where to measure an unlisted asset
    // JB2A melee assets are drawn as an attack travelling to the RIGHT. Crysta
    // stands on the target's right and cuts LEFT, so the crescent has to be
    // mirrored. Set false if you ever swap in art drawn the other way.
    slashAssetFacesRight: true,
    slashAngle: -15,       // degrees; leans with the swing direction
    // Playback speed of the crescent clip itself (it is 1.07 s at native rate).
    // 1 = native, 2 = twice as fast. slashImpactMs / slashHoldMs below are in
    // NATIVE clip time and are divided by this, so changing the speed alone
    // keeps the hit landing on the same frame of the animation.
    slashSpeed: 1.6,
    // Skip dead lead-in by starting partway into the clip (0 = from the top).
    // The arc's widest sweep runs from roughly 0.15 to 0.50 of the clip.
    slashStartFrac: 0.08,
    slashImpactMs: 200,    // NATIVE-time ms into the slash when the arc connects -> DAMAGE
    slashHoldMs: 420,      // NATIVE-time ms to let the rest of the arc play out
    // Silent by default: the damage pipeline already plays its own hit SFX and
    // the two stacked. Names if you ever want them back: Slash1-5, Sword1-5,
    // SE_SWINGA-H for the swing; HitSlashS/M, SE_BTL_HitSlashL/M/S for impact.
    swingSfx: "",
    hitSfx: "",
    slashShakeMs: 240,
    slashShakeIntensity: 6,

    // Fallbacks used ONLY if a runtime alpha scan cannot read pixels.
    tokenContentRatio: 0.9178, tokenBottomPad: 0.0171,
    imageContentRatio: 0.9178, imageBottomPad: 0.0171,
  };

  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);

  let imageUrl = "";
  try {
    const casterDoc = await fromUuid(casterUuid);
    const props = casterDoc?.actor?.system?.props ?? {};
    imageUrl = props[CFG.spriteProp] || props.sprite_battle || props.sprite_standard || "";
  } catch (e) { console.warn("[MoonlightBlade] could not resolve caster art", e); }

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

    if (!target) {
      console.warn('[MoonlightBlade] no target - she re-materialises in place and there is nothing to slash.');
      try { ui.notifications.warn('Moonlight Blade: no target selected.'); } catch (e) {}
    }

    const layer = oni.layer({ zIndex: 95000 });

    // ---- geometry helpers ---------------------------------------------------

    const meshH = (spr) => {
      const m = spr && spr.mesh;
      const h = m && m.height ? Math.abs(m.height) : 0;
      return h || (spr && spr.h) || 100;
    };
    const meshW = (spr) => {
      const m = spr && spr.mesh;
      const w = m && m.width ? Math.abs(m.width) : 0;
      return w || (spr && spr.w) || 100;
    };
    const renderX = (spr) => {
      const m = spr && spr.mesh;
      return (m && m.position && typeof m.position.x === 'number') ? m.position.x : spr.center.x;
    };
    const renderY = (spr) => {
      const m = spr && spr.mesh;
      return (m && m.position && typeof m.position.y === 'number') ? m.position.y : spr.center.y;
    };
    const frameBottomOf = (spr) => renderY(spr) + meshH(spr) / 2;

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

    // Full opaque bounding box as ratios of the frame. Unlike scanBox (which
    // only needs vertical extent and breaks out of each row early) this walks
    // every pixel, so it is used once, off the critical path.
    const contentBoxFull = (src, w, h) => {
      if (!src || !w || !h) return null;
      try {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(src, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 24) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return null;
        return {
          x: minX / w, y: minY / h,
          w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h,
        };
      } catch (e) { return null; }
    };

    const seekTo = (v, t) => new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; res(); };
      try { v.onseeked = fin; v.currentTime = t; } catch (e) { fin(); }
      setTimeout(fin, 1500);
    });

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

    // A texture from a URL is not measurable until it decodes. A VIDEO
    // additionally needs a decoded FRAME.
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

    const hexNum = (h) => {
      const s = String(h || '').replace('#', '');
      const n = parseInt(s, 16);
      return isFinite(n) ? n : 0xffffff;
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
    // Which way she travels on the way OUT (+1 right, -1 left). The return trip
    // is simply the negation, so the two legs mirror without special-casing.
    const dirOut = target ? ((renderX(target) >= homeX) ? 1 : -1) : 1;

    // ---- 2. Kick off the SLASH preload now, non-blocking --------------------
    // autoplay off so it does not burn through while it is still invisible; it
    // decodes during the 1 s she is gone, so the strike never stalls.

    let slash = null;
    let slashVid = null;
    let slashBox = null;
    let slashHit = null;
    let slashReady = Promise.resolve();
    if (target) {
      const list = Array.isArray(cfg.slashAssets) ? cfg.slashAssets : [cfg.slashAssets];
      const pick = list[Math.floor(Math.random() * list.length)];
      if (pick) {
        const made = oni.webmSprite(pick, { loop: false, parent: layer, autoplay: false });
        slash = made.sprite;
        slashVid = made.video;
        slash.alpha = 0;
        slash.tint = hexNum(cfg.slashTint);
        if (cfg.slashBlend === 'add') slash.blendMode = PIXI.BLEND_MODES.ADD;
        const baseName = String(pick).split('/').pop();
        const baked = (cfg.slashBoxes || {})[baseName] || null;
        slashHit = (cfg.slashHitPoints || {})[baseName] || null;
        slashReady = (async () => {
          await settle(slash, slashVid, 4000);
          // Baked box => no seek, no scan, nothing to wait for beyond the decode.
          if (baked) { slashBox = baked; return; }
          // Unlisted asset: measure once, then reuse for the rest of the session.
          globalThis.__ONI_SLASH_BOX__ = globalThis.__ONI_SLASH_BOX__ || {};
          const cachedBox = globalThis.__ONI_SLASH_BOX__[pick];
          if (cachedBox) { slashBox = cachedBox; return; }
          // Measure the CRESCENT, not the frame: it fills only ~41% of its
          // 800x600 canvas, so frame-based sizing draws it less than half the
          // intended size. Seek to a representative frame, measure, rewind.
          try {
            const dur = (slashVid && isFinite(slashVid.duration)) ? slashVid.duration : 0;
            if (dur > 0) await seekTo(slashVid, dur * cfg.slashMeasureFrac);
          } catch (e) {}
          const nn = naturalOf(slash.texture);
          slashBox = contentBoxFull(sourceOf(slash.texture), nn.w, nn.h);
          if (slashBox) globalThis.__ONI_SLASH_BOX__[pick] = slashBox;
          try { slashVid.currentTime = 0; } catch (e) {}
        })();
      }
    }

    // ---- 3. Hand off. Instant: the clone shares the token's live texture. ---

    const clone = oni.cloneToken(caster, { parent: layer });
    const restore = oni.hideToken(caster);

    let img = null;
    let vid = null;
    let morphed = false;
    let imgRatio = tokRatio;
    let imgBot = tokBot;
    let frameH = casterH;
    let aspect = 1;

    if (clone) {
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
      if (/[.]webm([?#]|$)/i.test(url)) {
        const made = oni.webmSprite(url, { loop: true, parent: layer });
        img = made.sprite; vid = made.video;
      } else {
        img = new PIXI.Sprite(PIXI.Texture.from(url));
        layer.addChild(img);
      }
      img.anchor.set(0.5, 1);
      img.alpha = 0;
      await settle(img, vid, 2500);
      const n = naturalOf(img.texture);
      const box = scanBox(sourceOf(img.texture), n.w, n.h);
      if (box) { imgRatio = box.hRatio; imgBot = box.botPad; }
      aspect = (n.w || 1) / (n.h || 1);
      frameH = (casterH * tokRatio * cfg.imageScale) / (imgRatio || 1);
      morphed = true;
    }

    const place = (spr, x, feetY, faceLeft, mult) => {
      if (!spr) return;
      const h = frameH * (mult || 1);
      spr.height = h;
      spr.width = h * aspect;
      if (cfg.autoFace) spr.scale.x = Math.abs(spr.scale.x) * (faceLeft ? 1 : -1);
      spr.position.set(x, feetY + h * imgBot + cfg.imageYOffset);
    };

    const homeFeet = feetOf(caster, tokBot);

    // ---- 4. Token -> image, ONLY when there is a change to show -------------

    if (morphed) {
      place(img, homeX, homeFeet, homeFacing, 1);
      await oni.tween({
        duration: cfg.morphMs, ease: oni.EASE.outQuad,
        onUpdate: (v) => { img.alpha = v; if (clone) clone.alpha = 1 - v; },
      });
      if (clone) clone.alpha = 0;
    } else if (img && cfg.imageScale !== 1) {
      place(img, homeX, homeFeet, homeFacing, 1);
    }

    // ---- 5. Dissolve, drifting up a touch -----------------------------------

    if (cfg.outSfx) oni.sfx(cfg.outSfx, { volume: cfg.volume });
    if (img) {
      const x0 = img.position.x;
      await oni.tween({
        duration: cfg.fadeOutMs, ease: oni.EASE.inQuad,
        onUpdate: (v) => { img.alpha = 1 - v; img.position.x = x0 + dirOut * cfg.departPx * v; },
      });
      img.alpha = 0;
    }

    // ---- 6. Gone (the slash finishes decoding in here) ----------------------

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
    const facingLeft = target ? (renderX(target) <= landX) : true;
    let inX0 = 0, inX1 = 0;
    if (img) {
      place(img, landX, landFeet, facingLeft, cfg.revealScale);
      inX1 = img.position.x;
      inX0 = inX1 - dirOut * cfg.arrivePx;   // short of the mark, still moving forward
      img.position.x = inX0;
    }


    if (cfg.inSfx) oni.sfx(cfg.inSfx, { volume: cfg.volume });
    await oni.tween({
      duration: cfg.fadeInMs, ease: oni.EASE.outCubic,
      onUpdate: (v) => {
        if (img) { img.alpha = v; img.position.x = inX0 + (inX1 - inX0) * v; }
      },
    });
    if (img) img.alpha = 1;

    // ---- 8. The beat, then the CRESCENT SLASH -------------------------------

    await oni.wait(cfg.slashDelayMs);

    if (slash && target) {
      await slashReady;

      // Size to the target so it reads the same on a rat or a dragon, and size
      // by the CRESCENT rather than by the frame it is painted in.
      const n = naturalOf(slash.texture);
      const ar = (n.w || 800) / (n.h || 600);
      const box = slashBox || { x: 0, y: 0, w: 1, h: 1 };
      const want = Math.max(meshW(target), meshH(target)) * cfg.slashScale;
      const fw = want / (box.w || 1);      // frame width that yields that crescent
      slash.width = fw;
      slash.height = fw / ar;
      // Anchor on the CONTENT centre, so the crescent lands centred on the
      // target and rotates about itself, whatever padding the frame carries.
      const nudge = cfg.slashHitNudge || [0, 0];
      const ax = (slashHit ? slashHit[0] : box.x + box.w / 2) + (nudge[0] || 0);
      const ay = (slashHit ? slashHit[1] : box.y + box.h / 2) + (nudge[1] || 0);
      slash.anchor.set(ax, ay);
      // Mirror the crescent to match the swing direction. The asset is drawn
      // cutting RIGHT; she cuts toward the target, so when the target is to her
      // LEFT the art has to be flipped.
      const assetRight = cfg.slashAssetFacesRight !== false;
      const mirror = assetRight ? facingLeft : !facingLeft;
      slash.scale.x = Math.abs(slash.scale.x) * (mirror ? -1 : 1);
      slash.angle = cfg.slashAngle * (mirror ? -1 : 1);
      slash.position.set(renderX(target), renderY(target));
      slash.alpha = 1;

      if (cfg.swingSfx) oni.sfx(cfg.swingSfx, { volume: cfg.volume });
      const spd = (cfg.slashSpeed > 0) ? cfg.slashSpeed : 1;
      try {
        slashVid.playbackRate = spd;
        const dur = isFinite(slashVid.duration) ? slashVid.duration : 0;
        slashVid.currentTime = dur > 0 ? dur * (cfg.slashStartFrac || 0) : 0;
        slashVid.play();
      } catch (e) {}

      // ---- 9. IMPACT. The damage gate. ------------------------------------
      await oni.wait(cfg.slashImpactMs / spd);
      if (cfg.hitSfx) oni.sfx(cfg.hitSfx, { volume: cfg.volume });
      oni.screenshake({ duration: cfg.slashShakeMs, intensity: cfg.slashShakeIntensity });
      oni.fireDone();

      // Let the rest of the arc play, then clear it.
      await oni.wait(cfg.slashHoldMs / spd);
      await oni.tween({
        duration: 160, ease: oni.EASE.outQuad,
        onUpdate: (v) => { slash.alpha = 1 - v; },
      });
      slash.alpha = 0;
    } else {
      // No target => no slash, but the gate must ALWAYS fire or the Battle
      // Director waits out its 35 s failsafe before applying damage.
      oni.fireDone();
    }

    // ---- 10. Cosmetic tail, runs after the gate -----------------------------

    await oni.wait(cfg.holdMs);
    const dirBack = -dirOut;
    if (img) {
      // Dissolve, carrying on toward home.
      const rx0 = img.position.x;
      await oni.tween({
        duration: cfg.returnMs, ease: oni.EASE.inQuad,
        onUpdate: (v) => { img.alpha = 1 - v; img.position.x = rx0 + dirBack * cfg.departPx * v; },
      });
      img.alpha = 0;
      // Re-form at her origin, sliding into place the same way she arrived.
      place(img, homeX, homeFeet, true, 1);
      const hx1 = img.position.x;
      const hx0 = hx1 - dirBack * cfg.arrivePx;
      img.position.x = hx0;
      await oni.tween({
        duration: cfg.returnMs, ease: oni.EASE.outCubic,
        onUpdate: (v) => { img.alpha = v; img.position.x = hx0 + (hx1 - hx0) * v; },
      });
      img.alpha = 1;
    }
    // The real token is at her origin and identical, so the swap is invisible.
    restore();
    if (img) img.alpha = 0;
  `;

  game.ONI.pseudo.play({
    scriptId: "crysta/moonlight-blade",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG, imageUrl },
  });

  // The gate now lands on the slash impact, so the wait has to cover it.
  const preImpact = CFG.morphMs + CFG.fadeOutMs + CFG.waitMs + CFG.fadeInMs
                  + CFG.slashDelayMs + CFG.slashImpactMs / (CFG.slashSpeed || 1);
  await onceHook(doneHook, preImpact + 6000);
  Hooks.callAll("oni:animationEnd", {
    local: true, world: false,
    sourceTokenId: String(casterUuid || "").split(".Token.").pop() || null,
  });
})();
