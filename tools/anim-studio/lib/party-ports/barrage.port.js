// ── PORT shim (party-ports/_port-shim.js): PORT.sound / PORT.effect / PORT.wait ──
// GM-side helpers; sound via Foundry AudioHelper (broadcast), effects via game.ONI.pseudo.play.
const PORT = (() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function sound(src, volume) {
    if (!src) return;
    try {
      const AH = (foundry && foundry.audio && foundry.audio.AudioHelper) || globalThis.AudioHelper;
      AH.play({ src: src, volume: volume == null ? 0.8 : volume, autoplay: true, loop: false }, true);
    } catch (e) { console.warn('[PORT] sound failed', src, e); }
  }
  const INNER = [
    "const p = ctx.params || {};",
    "const vid = document.createElement('video'); vid.src = p.file; vid.muted = true; vid.playsInline = true; vid.crossOrigin = 'anonymous';",
    "let tex; try { tex = await loadTexture(p.file); } catch (e) { tex = null; }",
    "if (!tex) return;",
    "const v = tex.baseTexture && tex.baseTexture.resource && tex.baseTexture.resource.source;",
    "const spr = new PIXI.Sprite(tex); spr.anchor.set(0.5, 0.5);",
    "const nw = (v && v.videoWidth) || tex.width || 100, nh = (v && v.videoHeight) || tex.height || 100;",
    "const k = (p.scale || 1) * (canvas.grid.size / (p.fileGrid || 200));",
    "spr.width = nw * k; spr.height = nh * k; if (p.mirrorX) spr.scale.x *= -1; if (p.mirrorY) spr.scale.y *= -1;",
    "spr.angle = -(p.rotate || 0); spr.x = p.x; spr.y = p.y; spr.alpha = p.fadeIn ? 0 : (p.opacity == null ? 1 : p.opacity);",
    "spr.zIndex = p.below ? 50 : 100500; canvas.stage.sortableChildren = true; canvas.stage.addChild(spr); canvas.stage.sortChildren();",
    "const op = p.opacity == null ? 1 : p.opacity;",
    "if (v) { try { v.loop = false; v.currentTime = 0; v.playbackRate = p.rate || 1; await v.play(); } catch (e) {} }",
    "const dur = p.duration || ((v && isFinite(v.duration) ? v.duration * 1000 / (p.rate || 1) : 1000));",
    "const t0 = performance.now();",
    "await new Promise((res) => { const tick = () => { const e = performance.now() - t0; let a = op; if (p.fadeIn && e < p.fadeIn) a = op * e / p.fadeIn; if (p.fadeOut && e > dur - p.fadeOut) a = op * Math.max(0, (dur - e) / p.fadeOut); spr.alpha = a; if (e >= dur) { canvas.app.ticker.remove(tick); res(); } }; canvas.app.ticker.add(tick); });",
    "try { spr.destroy(); } catch (e) {} try { if (v) v.pause(); } catch (e) {}",
  ].join("\n");
  function fileGrid() { return 100; } // raw file path default: native px x scale x (scene grid / 100)
  async function effect(o) {
    let x = 0, y = 0;
    const at = o.at && o.at.center ? o.at.center : (o.at || { x: 0, y: 0 });
    x = at.x + ((o.offset && o.offset.x) || 0); y = at.y + ((o.offset && o.offset.y) || 0);
    const params = { file: o.file, x, y, scale: o.scale, mirrorX: !!o.mirrorX, mirrorY: !!o.mirrorY, rotate: o.rotate || 0, fadeIn: o.fadeIn || 0, fadeOut: o.fadeOut || 0, below: !!o.below, opacity: o.opacity, duration: o.duration || 0, rate: o.rate || 1, fileGrid: o.fileGrid || fileGrid(o.file) };
    try { await game.ONI.pseudo.play({ scriptId: 'port.effect', scriptSource: INNER, casterTokenUuid: null, targetTokenUuids: [], params }); } catch (e) { console.warn('[PORT] effect failed', o.file, e); }
  }
  return { sound, effect, wait };
})();
// ============================================================================
// Barrage (Self-Buff) - PORT (Pipeline Version)
// - Uses __PAYLOAD from your Action System when available
// - Emits oni:animationStart / oni:animationEnd so your pipeline can track it
//
// Flow
// 1) Play Boon FX ABOVE the caster + SFX
// ============================================================================
(async () => {
  const TAG = "[Barrage]";
  try {
    // Minimal ONI.emit helper
    globalThis.ONI = globalThis.ONI ?? {};
    if (!ONI.emit) {
      ONI.emit = function (eventName, payload = {}, options = {}) {
        const { local = true, world = false } = options;
        if (local) Hooks.callAll(eventName, payload);
        if (world) game.socket.emit("world", { action: eventName, payload });
      };
    }
    // --- Payload ---
    const payload = globalThis.__PAYLOAD ?? {};
    // --- Helpers ---
    const isUuid = (v) => typeof v === "string" && v.includes(".");
    async function resolveToken(ref) {
      if (!ref) return null;
      if (ref?.document && ref?.object) return ref;
      if (ref?.id && canvas.tokens?.get(ref.id)) return canvas.tokens.get(ref.id);
      if (isUuid(ref)) {
        const doc = await fromUuid(ref);
        if (!doc) return null;
        if (doc.object) return doc.object;
        if (doc.document?.object) return doc.document.object;
        return null;
      }
      if (typeof ref === "string") return canvas.tokens.get(ref) ?? null;
      return null;
    }
    // --- Resolve caster from pipeline ---
    const sourceRef =
      payload.sourceTokenUuid ??
      payload.sourceTokenId ??
      payload.casterTokenUuid ??
      payload.casterTokenId ??
      payload.attackerTokenUuid ??
      payload.attackerTokenId ??
      null;
    // Fallback for testing
    const fallbackSource = canvas.tokens.controlled?.[0] ?? null;
    const sourceToken = (await resolveToken(sourceRef)) ?? fallbackSource;
    if (!sourceToken) {
      ui.notifications.warn("Barrage: No caster token (payload missing and nothing selected).");
      return;
    }
    // --- Broadcast start ---
    ONI.emit(
      "oni:animationStart",
      {
        type: "skillBarrage",
        sourceTokenId: sourceToken.id,
        targetTokenIds: [sourceToken.id], // self-buff
        sceneId: canvas.scene?.id ?? null,
        timestamp: Date.now(),
      },
      { local: true, world: false }
    );
    // --- Assets ---
    const FX_BOON =
      "modules/JB2A_DnD5e/Library/Generic/Conditions/Boon02/ConditionBoon02_001_Refraction_600x600.webm";
    const SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/EXSkill.ogg";
    // --- MAIN (ported off the old player: same SFX, same FX, same wait) ---
    PORT.sound(SFX, 0.95);
    // FX above caster. scaleToObject(1.7) = effect width = 1.7 x token width.
    // FX_BOON is 600x600, so with fileGrid 600 the drawn width is scale x grid:
    // scale = 1.7 x token width in grid units.
    const BOON_SCALE = 1.7 * ((sourceToken.w || canvas.grid.size) / canvas.grid.size);
    await PORT.effect({
      file: FX_BOON,
      at: sourceToken,
      offset: { x: 0, y: -80 }, // "above" (tweak if needed)
      scale: BOON_SCALE,
      fileGrid: 600,
      opacity: 1.0,
      below: false,
    });
    // --- Broadcast end ---
    ONI.emit(
      "oni:animationEnd",
      {
        type: "skillBarrage",
        sourceTokenId: sourceToken.id,
        targetTokenIds: [sourceToken.id],
        sceneId: canvas.scene?.id ?? null,
        timestamp: Date.now(),
      },
      { local: true, world: false }
    );
    console.log(TAG, "END");
  } catch (err) {
    console.error(`${TAG} Animation crashed:`, err);
    // Still emit animationEnd so pipeline won't hang
    try {
      globalThis.ONI?.emit?.(
        "oni:animationEnd",
        { type: "skillBarrage", error: true, timestamp: Date.now() },
        { local: true }
      );
    } catch (_) {}
  }
})();