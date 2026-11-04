// ============================================================================
// Barrage (Self-Buff) - Sequencer (Pipeline Version)
// - Uses __PAYLOAD from your Action System when available
// - Emits oni:animationStart / oni:animationEnd so your pipeline can track it
//
// Flow
// 1) Play Boon FX ABOVE the caster + SFX
// ============================================================================
(async () => {
  const TAG = "[Barrage]";
  try {
    if (!game.modules.get("sequencer")?.active) {
      ui.notifications.error("Sequencer module is not active.");
      return;
    }
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
    // --- MAIN SEQUENCE ---
    const seq = new Sequence()
      .sound()
      .file(SFX)
      .volume(0.95)
      // FX above caster
      .effect()
      .file(FX_BOON)
      .atLocation(sourceToken, { offset: { x: 0, y: -80 } }) // "above" (tweak if needed)
      .scaleToObject(1.7)
      .opacity(1.0)
      .belowTokens(false)
      .waitUntilFinished();
    await seq.play();
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