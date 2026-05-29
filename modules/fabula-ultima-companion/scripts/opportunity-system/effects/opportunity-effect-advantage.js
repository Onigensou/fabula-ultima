// ============================================================================
// Opportunity Effect — Advantage
//
// Effect: The next Check performed by the chosen ally receives a +4 bonus.
//
// Flow (pre/post):
//   pre  — targeting step; runs BEFORE the banner animation so the user picks
//          their ally while the picker UI is still the active overlay.
//          Returns { tokenId, tokenUuid } (serializable for socket transport).
//   post — applies the charged AE to the target and plays visual + audio FX.
//          Receives the pre-result so it can resolve the live token/actor.
//
// Implementation: GM picks an ally via the JRPG Targeting UI. A charged AE
// (charges=1, chargeKey="opportunityAdvantage") is placed on the target.
// A PIXI ring animation + Up1.ogg play as visual/audio feedback.
// The CheckRoller "opportunity-advantage" pipeline step (registered in
// opportunity-action-hook.js) consumes the charge before compute and injects
// +4 into payload.check.modifier.parts.
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Advantage]";
  const MODULE_ID = "fabula-ultima-companion";

  const AE_ICON  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Elesis/DAS.png";
  const AE_DESC  = "The next Check made by this creature receives a +4 bonus. Consumed automatically when a Check is rolled.";
  const SFX_APPLY = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Up1.ogg";

  function playSound(url, vol = 0.65) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, false); }
    catch (_) {}
  }

  // ── PIXI buff ring ────────────────────────────────────────────────────────────
  // Lightweight canvas-only animation: two concentric rings expand outward from
  // the token centre while fading out. No Sequencer, no DB writes, ~700 ms.
  function playBuffFX(token) {
    if (!canvas?.app?.ticker || !token) return;

    const gridSize = canvas.scene?.grid?.size ?? 100;
    const tw = (token.document?.width  ?? 1) * gridSize;
    const th = (token.document?.height ?? 1) * gridSize;
    const cx = (token.x ?? 0) + tw / 2;
    const cy = (token.y ?? 0) + th / 2;
    const baseRadius = Math.max(tw, th) * 0.54;

    const container = new PIXI.Container();
    container.position.set(cx, cy);
    canvas.tokens.addChild(container);

    const gfx = new PIXI.Graphics();
    container.addChild(gfx);

    const GOLD        = 0xFCD470;
    const WHITE       = 0xFFFFFF;
    const DURATION_MS = 720;
    let   elapsed     = 0;
    const { ticker }  = canvas.app;

    function tick() {
      elapsed += ticker.deltaMS;
      const t = Math.min(elapsed / DURATION_MS, 1);

      const eased = 1 - (1 - t) * (1 - t);
      const alpha = t < 0.25 ? t / 0.25 : 1 - ((t - 0.25) / 0.75);
      const r = baseRadius * (0.55 + eased * 0.9);

      gfx.clear();

      gfx.lineStyle(2.5, GOLD, alpha * 0.9);
      gfx.drawCircle(0, 0, r);

      gfx.lineStyle(1.5, WHITE, alpha * 0.4);
      gfx.drawCircle(0, 0, r * 0.72);

      const sp = r * 0.48;
      gfx.lineStyle(1.5, GOLD, alpha * 0.65);
      gfx.moveTo(-sp, 0); gfx.lineTo(sp, 0);
      gfx.moveTo(0, -sp); gfx.lineTo(0, sp);

      if (t >= 1) {
        ticker.remove(tick);
        container.parent?.removeChild(container);
        container.destroy({ children: true });
      }
    }

    ticker.add(tick);
  }

  // ── Effect handler (pre/post split) ──────────────────────────────────────────
  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("advantage", {

      // ── Pre phase: targeting (runs BEFORE the banner) ─────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        console.debug(TAG, "[pre] opening ally target picker...");
        const token = await pickToken({
          title:           "Advantage — Choose Target",
          skillTarget:     "One Ally",
          sourceActorUuid: ctx.actorUuid,
          includeSource:   true,
        });

        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }
        console.debug(TAG, "[pre] token picked:", `${token.name} (id=${token.id})`);

        // Return serializable reference (safe for socket transport)
        return { tokenId: token.id, tokenUuid: token.document?.uuid ?? null };
      },

      // ── Post phase: AE application + FX (runs AFTER the banner) ──────────
      async post(ctx, preResult) {
        const { tokenId, tokenUuid } = preResult ?? {};

        // Resolve live PlaceableToken from the pre-phase reference
        const token = (canvas?.tokens?.placeables ?? []).find(t =>
          (tokenUuid && t.document?.uuid === tokenUuid) || t.id === tokenId
        );
        if (!token) { console.error(TAG, "[post] token not found on canvas", { tokenId, tokenUuid }); return; }

        const targetActor = token.actor;
        if (!targetActor) { console.error(TAG, "[post] token has no actor"); return; }

        console.debug(TAG, "[post] applying Advantage AE to:", targetActor.name);

        // Pre-stamp all CSB flags so _onCreateOperation skips its 4 setFlag calls,
        // preventing 4 extra actor prepareData cycles.
        const effectId   = foundry.utils.randomID();
        const effectUuid = `${targetActor.uuid}.ActiveEffect.${effectId}`;

        const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [{
          _id:         effectId,
          name:        "Advantage",
          label:       "Advantage",
          description: AE_DESC,
          icon:        AE_ICON,
          flags: {
            [MODULE_ID]: {
              charges:    1,
              chargesMax: 1,
              chargeKey:  "opportunityAdvantage",
              activeEffectManager: { optimizedCreate: true },
              showTokenIcon: true,
            },
            "custom-system-builder": {
              originalParentId: targetActor.id,
              originalId:       effectId,
              originalUuid:     effectUuid,
              isFromTemplate:   false,
            },
          },
        }]).catch(e => { console.error(TAG, "[post] AE creation failed:", e); return null; });

        if (!created) return;
        console.debug(TAG, "[post] AE created:", created.map(e => e.id));

        // Audio + visual feedback
        playSound(SFX_APPLY, 0.8);
        playBuffFX(token);

        console.debug(TAG, "[done]");
      },
    });
  });
})();
