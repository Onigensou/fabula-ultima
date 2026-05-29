// ============================================================================
// Opportunity Effect — Advantage
//
// Effect: The next Check performed by the chosen ally receives a +4 bonus.
//
// Implementation: GM picks an ally via the JRPG Targeting UI. A charged AE
// (charges=1, chargeKey="opportunityAdvantage") is placed on the target.
// A PIXI ring animation plays on the token as visual feedback.
// The CheckRoller "opportunity-advantage" pipeline step (registered in
// opportunity-action-hook.js) consumes the charge before compute and injects
// +4 into payload.check.modifier.parts.
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Advantage]";
  const MODULE_ID = "fabula-ultima-companion";

  const AE_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Elesis/DAS.png";
  const AE_DESC = "The next Check made by this creature receives a +4 bonus. Consumed automatically when a Check is rolled.";

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

      // ease-out quad: fast start, gentle finish
      const eased = 1 - (1 - t) * (1 - t);
      // alpha: snap to full at t=0.25 then fade out
      const alpha = t < 0.25 ? t / 0.25 : 1 - ((t - 0.25) / 0.75);
      // ring grows from 0.55× to 1.45× base radius
      const r = baseRadius * (0.55 + eased * 0.9);

      gfx.clear();

      // Outer ring (gold)
      gfx.lineStyle(2.5, GOLD, alpha * 0.9);
      gfx.drawCircle(0, 0, r);

      // Inner ring (white, slightly smaller)
      gfx.lineStyle(1.5, WHITE, alpha * 0.4);
      gfx.drawCircle(0, 0, r * 0.72);

      // Four cardinal sparks — short lines that stretch as the ring expands
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

  // ── Effect handler ────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("advantage", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { pickToken } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      // Step 1: pick target ally
      console.debug(TAG, "[step 1] opening ally target picker...");
      const token = await pickToken({
        title:           "Advantage — Choose Target",
        skillTarget:     "One Ally",
        sourceActorUuid: ctx.actorUuid,
      });
      console.debug(TAG, "[step 1] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
      if (!token) { console.debug(TAG, "[exit] target picker cancelled"); return; }

      // Step 2: apply charged AE to the target
      const targetActor = token.actor;
      console.debug(TAG, "[step 2] applying Advantage AE to:", targetActor.name);

      const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [{
        name:        "Advantage",
        label:       "Advantage",
        description: AE_DESC,
        icon:        AE_ICON,
        flags: {
          [MODULE_ID]: {
            charges:    1,
            chargesMax: 1,
            chargeKey:  "opportunityAdvantage",
          },
        },
      }]).catch(e => { console.error(TAG, "[step 2] AE creation failed:", e); return null; });

      console.debug(TAG, "[step 2] AE created:", created ? created.map(e => e.id) : "FAILED");
      if (!created) return;

      // Step 3: visual feedback on the token
      console.debug(TAG, "[step 3] playing buff FX on token:", token.name);
      playBuffFX(token);

      console.debug(TAG, "[done]");
    });
  });
})();
