// @desc King Gorger — Elemental Overflow: the companion shakes and flares white
// (its new element colour fading in under the white), then the white drops away
// in under half a second as a Wellspring wave rings out past the screen edge,
// coloured by the element it just belched onto the Field. (Its body tint is NOT this script — that is the AE
// tokenTint on the Field AE, so it lasts exactly as long as the Wellspring.)
//
// Chain order is eo_spend, eo_surge, eo_wave: by the time this plays, the
// Field already holds the freshly applied "Elemental Overflow (X)" AE, so the
// OUTER (GM) script reads the element + colour off that AE and hands them to
// every client through params. Fallback palette below only covers a Field
// with no such AE (a Preview Bench run outside combat → random element demo).
"use strict";
(async () => {
  const CFG = {
    // ── charge: the body shakes and goes white while the new colour fades in
    //    underneath (the tokenTint AE was applied one chain step earlier) ──
    chargeMs: 900,         // shake + brighten to a white silhouette (room for the charge cue)
    holdMs: 80,            // beat at full white
    releaseMs: 400,        // white drops away (< 0.5 s) revealing the recoloured body
    shakePx: 7,            // peak jitter, world px
    whiteGlowSize: 2.4,    // x token size
    // ── release: the wave leaves the body on the same frame the white starts to drop ──
    ringMs: 1500,          // main wave: token-sized ring -> past the screen corners
    ringFadeFrom: 0.55,    // fraction of ringMs where the ring starts fading
    echoDelayMs: 220,      // second, thinner ring trailing the first
    echoMs: 1400,
    glowMs: 700,           // caster flash at launch
    glowSize: 2.6,         // x token size
    gateAt: 0.62,          // fireDone when the wave has crossed most of the screen
    // ── audio: ONE cue — the release whoosh as the white drops and the ring
    //    leaves. The charge is silent on purpose (every charge cue tried was
    //    either too sharp or inaudible under a 0.9 s window, 2026-09-22).
    //    rate < 1 pitches down (rounder). Manifest name — audition in Anim
    //    Studio → SFX Browser.
    sfxCharge:  null,
    sfxRelease: { name: "Wind2",        volume: 0.55, rate: 0.9,  fadeAfter: 900, fadeMs: 500 },
    fallbackColor: "#ffffff",
    // Ring colours — deeper than the body tint: the ring draws in ADD blend and a
    // pastel washes to white over a warm floor. The Field AE's own waveColor wins.
    palette: { fire: "#e8603c", ice: "#2f8fe0", earth: "#9a5a1a", bolt: "#e8c93c", air: "#20c4a8" },
  };

  const NS = "fabula-ultima-companion";
  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const doneHook = "oni:done:" + foundry.utils.randomID(8);
  // Scope the start/end emits to THIS caster (sibling convention, see
  // crysta-mirage-strike.js): an unscoped animationEnd is accepted by every
  // armed end-watch, and this wave can fire mid-settle of ANOTHER creature's
  // action (creature_gain_resource) — it must not settle that one's tail.
  const sourceTokenId = String(casterUuid ?? "").split(".Token.").pop() || null;

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  // ── which Wellspring? read the Field AE this caster just applied ──
  let elem = null, color = null;
  try {
    const casterDoc = casterUuid ? await fromUuid(casterUuid) : null;
    const casterActorUuid = casterDoc?.actor?.uuid ?? null;
    const field = game.actors.find((a) => a.flags?.[NS]?.isField);
    for (const e of field?.effects ?? []) {
      const f = e.flags?.[NS] ?? {};
      if (f.aeFamily !== "elemental-overflow") continue;
      const by = f.directorAppliedBy?.reactorActorUuid ?? null;
      if (casterActorUuid && by && by !== casterActorUuid) continue;
      elem = String(f.wellspring ?? "").toLowerCase() || null;
      color = f.waveColor ?? null;
      break;
    }
  } catch (e) { console.warn("[KG Overflow anim] Field read threw", e); }
  // No Wellspring on the Field (Preview Bench / Test Anim outside combat): demo a
  // random element so the preview still shows a coloured wave. In play the
  // Field AE always exists by the time this step runs. (The body tint is the AE's,
  // so a bare preview shows the wave only.)
  if (!elem) { const ks = Object.keys(CFG.palette); elem = ks[Math.floor(Math.random() * ks.length)]; }
  color = color ?? CFG.palette[elem] ?? CFG.fallbackColor;

  Hooks.callAll("oni:animationStart", { local: true, world: false, sourceTokenId });

  // INNER (every client) — oni helper library; no backticks allowed in here.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const color = ctx.params.color;
    const caster = oni.caster;
    if (!caster) { oni.fireDone(); return; }
    const cx = caster.center.x, cy = caster.center.y;
    const tokenSize = Math.max(caster.w || 100, caster.h || 100);
    const layer = oni.layer({ zIndex: 94000 });

    // ── charge rig: hide the real token, draw a clone of the body (it carries the
    //    tokenTint filter, so the new colour fades in on the clone too) plus a pure
    //    WHITE silhouette of the same sprite above it. Silhouette alpha 0 -> 1 is
    //    the "turns bright" beat; both are shaken together. A white radial glow
    //    behind them sells the charge.
    const bodyLayer = oni.layer({ zIndex: 93000 });
    oni.hideToken(caster);
    const body = oni.cloneToken(caster, { parent: bodyLayer });
    const silhouette = oni.cloneToken(caster, { parent: bodyLayer });
    if (silhouette) {
      const whiteMatrix = new PIXI.ColorMatrixFilter();
      whiteMatrix.matrix = [0,0,0,0,1,  0,0,0,0,1,  0,0,0,0,1,  0,0,0,1,0];
      silhouette.filters = [whiteMatrix];
      silhouette.alpha = 0;
    }
    const whiteGlow = new PIXI.Sprite(oni.radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', { size: 256 }));
    whiteGlow.anchor.set(0.5);
    whiteGlow.blendMode = PIXI.BLEND_MODES.ADD;
    whiteGlow.position.set(cx, cy);
    whiteGlow.width = whiteGlow.height = tokenSize * cfg.whiteGlowSize;
    whiteGlow.alpha = 0;
    bodyLayer.addChildAt(whiteGlow, 0);
    const home = body ? { x: body.x, y: body.y } : { x: cx, y: cy };
    // The body clone does NOT share the real mesh's tokenTint filter: the real
    // tint has usually finished fading in before this script even starts (the
    // AE landed one chain step earlier), which would show the new colour BEFORE
    // the white. Instead the clone gets its own copy of that filter, held at
    // strength 0 through the charge and snapped to 1 at the white peak, so the
    // colour switch happens under the white and is revealed by the release.
    // Re-synced every frame because on a player client the AE (and so the
    // filter) can arrive after the animation broadcast.
    let ownTint = null, reveal = 0;
    const syncBody = () => {
      if (!body) return;
      const f = caster.mesh?.filters ?? [];
      const src = f.find((x) => x && x.fudTokenTint);
      if (src && !ownTint) {
        try { ownTint = new src.constructor(); ownTint.uniforms.uSatFloor = src.uniforms.uSatFloor; } catch (e) { ownTint = null; }
      }
      if (ownTint && src) { ownTint.uniforms.uTint = src.uniforms.uTint; ownTint.uniforms.uStrength = reveal; }
      const want = f.filter((x) => !(x && x.fudTokenTint));
      if (ownTint) want.push(ownTint);
      const cur = body.filters ?? [];
      const same = cur.length === want.length && cur.every((x, i) => x === want[i]);
      if (!same) body.filters = want.length ? want : null;
    };
    const jitter = (amp) => {
      syncBody();
      const dx = (Math.random() - 0.5) * 2 * amp, dy = (Math.random() - 0.5) * 2 * amp;
      for (const spr of [body, silhouette]) if (spr) spr.position.set(home.x + dx, home.y + dy);
    };

    // How far is the farthest visible screen corner from the caster (world px)?
    // The ring's band sits at 80-90% of its texture radius, so scale the sprite
    // until that band clears the corner.
    const S = oni.screen();
    const corners = [S.S2W(0, 0), S.S2W(1, 0), S.S2W(0, 1), S.S2W(1, 1)];
    const maxR = Math.max(...corners.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    const endDiameter = (maxR / 0.82) * 2;
    const startDiameter = tokenSize * 0.7;

    // Ring texture: transparent core, a soft coloured band, transparent rim.
    const ringTexture = (bandInner, bandPeak, bandOuter, peakAlpha) => {
      const size = 512;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      const rgba = (a) => {
        const col = foundry.utils.Color.from(color);
        return 'rgba(' + Math.round(col.r * 255) + ',' + Math.round(col.g * 255) + ',' + Math.round(col.b * 255) + ',' + a + ')';
      };
      grad.addColorStop(0, rgba(0));
      grad.addColorStop(bandInner, rgba(0));
      grad.addColorStop(bandPeak, rgba(peakAlpha));
      grad.addColorStop(bandOuter, rgba(peakAlpha * 0.35));
      grad.addColorStop(1, rgba(0));
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      return PIXI.Texture.from(c);
    };

    // Both rings draw ADD: the bright glow look the user picked (2026-09-22) over a
    // NORMAL-blend ring that keeps truer colour on a bright floor. Trade-off: over
    // a warm bright map the cool rings (Ice / Air) wash toward white — accepted.
    const mkRing = (tex, blend) => {
      const s = new PIXI.Sprite(tex);
      s.anchor.set(0.5);
      s.blendMode = blend;
      s.position.set(cx, cy);
      s.width = s.height = startDiameter;
      s.alpha = 0;
      layer.addChild(s);
      return s;
    };
    const wave = mkRing(ringTexture(0.62, 0.82, 0.92, 0.9), PIXI.BLEND_MODES.ADD);
    const echo = mkRing(ringTexture(0.72, 0.84, 0.90, 0.5), PIXI.BLEND_MODES.ADD);

    // Caster flash — the body lights up as the wave leaves it.
    const glow = new PIXI.Sprite(oni.radialTexture(color, 'rgba(0,0,0,0)', { size: 256 }));
    glow.anchor.set(0.5);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.position.set(cx, cy);
    glow.width = glow.height = tokenSize * cfg.glowSize;
    glow.alpha = 0;
    layer.addChild(glow);

    const cue = (c) => { if (c && c.name) oni.sfx(c.name, { volume: c.volume, rate: c.rate, offset: c.offset || 0, fadeAfter: c.fadeAfter, fadeMs: c.fadeMs }); };
    // Warm the browser cache for both cues so the first play does not wait on the CDN.
    for (const c of [cfg.sfxCharge, cfg.sfxRelease]) { try { const u = c && c.name && oni.sfxUrl(c.name); if (u) { const a = new Audio(); a.preload = 'auto'; a.src = u; } } catch (e) {} }
    cue(cfg.sfxCharge);

    // ── CHARGE: shake grows, silhouette + white glow ramp up (ease-in so the
    //    first frames are near-normal and the tint fade underneath stays hidden) ──
    await oni.tween({
      from: 0, to: 1, duration: cfg.chargeMs, ease: oni.EASE.inQuad,
      onUpdate: (v) => {
        jitter(cfg.shakePx * Math.min(1, v * 1.4));
        if (silhouette) silhouette.alpha = v;
        whiteGlow.alpha = v * 0.95;
      },
    });
    jitter(cfg.shakePx);
    reveal = 1;              // the colour switch — hidden under the full white
    syncBody();
    await oni.wait(cfg.holdMs);
    cue(cfg.sfxRelease);

    // ── RELEASE: white drops away fast, body settles home; the rings launch on
    //    this same frame (below), so the wave "leaves" as the colour is revealed ──
    const release = oni.tween({
      from: 1, to: 0, duration: cfg.releaseMs, ease: oni.EASE.outCubic,
      onUpdate: (v) => {
        if (silhouette) silhouette.alpha = v;
        whiteGlow.alpha = v * 0.95;
        jitter(cfg.shakePx * v);
      },
      onComplete: () => { for (const spr of [body, silhouette]) if (spr) spr.position.set(home.x, home.y); },
    });

    let fired = false;
    const runRing = (spr, ms, delay) => new Promise(async (resolve) => {
      if (delay) await oni.wait(delay);
      await oni.tween({
        from: 0, to: 1, duration: ms, ease: oni.EASE.outQuad,
        onUpdate: (v) => {
          const d = startDiameter + (endDiameter - startDiameter) * v;
          spr.width = spr.height = d;
          spr.alpha = v < cfg.ringFadeFrom ? Math.min(1, v / 0.08) : Math.max(0, 1 - (v - cfg.ringFadeFrom) / (1 - cfg.ringFadeFrom));
          if (spr === wave && !fired && v >= cfg.gateAt) { fired = true; oni.fireDone(); }
        },
      });
      resolve();
    });

    await Promise.all([
      release,
      runRing(wave, cfg.ringMs, 0),
      runRing(echo, cfg.echoMs, cfg.echoDelayMs),
      oni.tween({
        from: 0, to: 1, duration: cfg.glowMs, ease: oni.EASE.outQuad,
        onUpdate: (v) => {
          glow.alpha = Math.sin(v * Math.PI) * 0.9;
          const d = tokenSize * cfg.glowSize * (0.6 + 0.6 * v);
          glow.width = glow.height = d;
        },
      }),
    ]);
    if (!fired) oni.fireDone();
    // The ring textures are canvas-backed and not oni-tracked — free them here
    // (sprite + texture + baseTexture) so each fire does not leak GPU memory.
    for (const spr of [wave, echo]) { try { spr.destroy({ texture: true, baseTexture: true }); } catch (e) {} }
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/king-gorger-elemental-overflow",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: [],
    params: { doneHook, cfg: CFG, color, elem },
  });

  await onceHook(doneHook, CFG.ringMs + 4000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false, sourceTokenId });
})();
