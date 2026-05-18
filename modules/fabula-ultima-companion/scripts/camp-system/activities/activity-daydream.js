// ============================================================================
// Camp Activity — Daydream
// Target: Yourself
//
// Minigame: Counting Sheep
//   The owner watches sheep jump over a fence and presses Spacebar at the
//   right time.  Score → damage reduction percentage (25%–75%) applied as a
//   "you may" Active Effect (campRestCharges: 1).
//
// Effect: Once before the next rest, when you lose Hit Points for any reason,
//         you may choose to reduce that HP loss by X%.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Daydream]";

  const DAYDREAM_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Laby/ShiningRomanticaSkill3.png";

  const MAX_SCORE = 7; // must match activity-daydream-ui.js

  // ---------------------------------------------------------------------------
  // Reduction formula: score 0/7 → 25%, 7/7 → 75%
  // ---------------------------------------------------------------------------
  function _calcReduction(score) {
    const ratio = Math.max(0, Math.min(1, score / MAX_SCORE));
    return Math.round(25 + ratio * 50);
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("daydream", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Play activity-start SFX (same as all other activities)
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // 2 — Broadcast START; GM shows UI directly (broadcast doesn't echo)
        CAMP.Socket.broadcast(CAMP.MSG.DAYDREAM_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.DaydreamUI?.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 3 — Wait for owner to finish the minigame and submit their score
        const score = await _waitForScore(actor);
        console.debug(TAG, `Score received: ${score}/${MAX_SCORE}`);

        // 4 — Compute reduction
        const reduction = _calcReduction(score);
        console.debug(TAG, `Reduction: ${reduction}%`);

        // 5 — Apply AE to actor (replace stale one if it exists)
        const existing = actor.effects.find(
          e => e.flags?.[MODULE_ID]?.daydreamReduction != null
        );
        if (existing) await existing.delete();

        await actor.createEmbeddedDocuments("ActiveEffect", [{
          name:        "Daydream",
          img:         DAYDREAM_ICON,
          description: `Once before the next rest, when you lose HP for any reason, you may choose to reduce that HP loss by ${reduction}%.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:   1,
              daydreamReduction: reduction,
            },
          },
        }]);

        // 6 — Broadcast full result to all clients (triggers reveal stage in UI)
        CAMP.Socket.broadcast(CAMP.MSG.DAYDREAM_RESULT, {
          actorId: actor.id,
          score,
          reduction,
        });
        CAMP.DaydreamUI?.applyResult(actor.id, score, reduction);

        // 7 — Post chat announcement
        await _postChatResult(actor, score, reduction);

        // 8 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 9 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.DAYDREAM_DONE, { actorId: actor.id });
        CAMP.DaydreamUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForScore — GM awaits owner's submitted score
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.DaydreamUI ??= {};
      CAMP.DaydreamUI.scoreResolvers ??= {};

      // Timeout: 90 s covers "Click to Begin" wait + 3.7 s countdown + 15 s game
      const timer = setTimeout(() => {
        if (CAMP.DaydreamUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting to 0 for", actor.name);
          delete CAMP.DaydreamUI.scoreResolvers[actor.id];
          resolve(0);
        }
      }, 90_000);

      CAMP.DaydreamUI.scoreResolvers[actor.id] = (score) => {
        clearTimeout(timer);
        resolve(score);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForProceed — GM awaits owner's "Click to Proceed"
  // ---------------------------------------------------------------------------
  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.DaydreamUI ??= {};
      CAMP.DaydreamUI.proceedResolvers ??= {};
      CAMP.DaydreamUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, score, reduction) {
    const reductionColor =
      reduction >= 65 ? "#c8a84b" :
      reduction >= 50 ? "#3a7a35" :
                        "#7a5010";

    const label =
      reduction >= 70 ? "Perfect rhythm! Sweet dreams!" :
      reduction >= 55 ? "Peaceful slumber." :
      reduction >= 40 ? "Counted a few sheep." :
                        "Restless sleep…";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${DAYDREAM_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${actor.name} — Daydream
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Score: <strong>${score}/${MAX_SCORE}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${reductionColor};">
              Damage Reduction: ${reduction}%
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              ${label}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              Once before the next rest, ${actor.name} may reduce an HP loss by ${reduction}%.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-dd-chat-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display:none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top:6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin:0 !important; }
      `;
      document.head.appendChild(style);
    }
  }

  console.debug(TAG, "Daydream activity loaded.");
})();
