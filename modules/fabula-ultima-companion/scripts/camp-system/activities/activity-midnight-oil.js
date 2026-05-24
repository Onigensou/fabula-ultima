// ============================================================================
// Camp Activity — Midnight Oil
// Target: Yourself
//
// Minigame: Lamp Keeper
//   Owner must keep an oil lamp burning for 15 seconds by relighting it
//   before it flickers out. Timing a perfect relight awards bonus points.
//
// Reward: Chat message prompting GM to award 3 Project Progress Points to
//         a project of the player's choice (no automated project update).
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][MidnightOil]";

  const ACTIVITY_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Noah/StellarCasterTPassive2.png";

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("midnight_oil", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Play activity-start SFX
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // 2 — Broadcast START; GM shows UI directly (broadcast doesn't echo)
        CAMP.Socket.broadcast(CAMP.MSG.MIDNIGHT_OIL_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.MidnightOilUI?.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 3 — Wait for owner to finish the minigame and submit score data
        const result = await _waitForScore(actor);
        console.debug(TAG, "Score received:", result);

        // 4 — Broadcast full result to all clients (triggers reveal stage)
        const label = _calcLabel(result.score);
        CAMP.Socket.broadcast(CAMP.MSG.MIDNIGHT_OIL_RESULT, {
          actorId:             actor.id,
          score:               result.score,
          perfectRelights:     result.perfectRelights,
          lampEverExtinguished: result.lampEverExtinguished,
          label,
        });
        CAMP.MidnightOilUI?.applyResult(
          actor.id, result.score, result.perfectRelights, result.lampEverExtinguished,
        );

        // 5 — Post chat announcement (reward info — GM applies manually)
        await _postChatResult(actor, result, label);

        // 6 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 7 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.MIDNIGHT_OIL_DONE, { actorId: actor.id });
        CAMP.MidnightOilUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForScore — GM awaits owner's submitted score data
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.MidnightOilUI ??= {};
      CAMP.MidnightOilUI.scoreResolvers ??= {};

      // 90 s covers "Click to Begin" wait + 3.7 s countdown + 15 s game
      const timer = setTimeout(() => {
        if (CAMP.MidnightOilUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting for", actor.name);
          delete CAMP.MidnightOilUI.scoreResolvers[actor.id];
          resolve({ score: 0, perfectRelights: 0, lampEverExtinguished: true });
        }
      }, 90_000);

      CAMP.MidnightOilUI.scoreResolvers[actor.id] = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForProceed — GM awaits owner's "Click to Proceed"
  // ---------------------------------------------------------------------------
  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.MidnightOilUI ??= {};
      CAMP.MidnightOilUI.proceedResolvers ??= {};
      CAMP.MidnightOilUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Score label
  // ---------------------------------------------------------------------------
  function _calcLabel(score) {
    if (score >= 250) return "Brilliant focus. The flame never wavered in your heart.";
    if (score >= 200) return "A long, productive night of study.";
    if (score >= 140) return "Focused work. The lamp served you well.";
    if (score >= 80)  return "Some good progress made tonight.";
    return "The night was a struggle, but you persisted.";
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, result, label) {
    const { score, perfectRelights, lampEverExtinguished } = result;

    const bonusLines = [];
    if (perfectRelights > 0)
      bonusLines.push(`✨ Perfect Relight ×${perfectRelights}: +${perfectRelights * 30} pts`);
    if (!lampEverExtinguished)
      bonusLines.push(`🔥 Lamp Never Went Out: +50 pts`);

    const scoreColor =
      score >= 220 ? "#c8a84b" :
      score >= 150 ? "#3a7a35" :
                     "#7a5010";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${ACTIVITY_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${actor.name} — Midnight Oil
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Score: <strong style="color:${scoreColor};">${score} pts</strong>
            </div>
            ${bonusLines.map(l =>
              `<div style="font-size:.8em;margin-top:2px;color:#3a7a35;">${l}</div>`
            ).join("")}
            <div style="font-size:.8em;margin-top:4px;opacity:.75;font-style:italic;">${label}</div>
            <div style="font-size:.82em;margin-top:6px;padding:6px 8px;
                        background:rgba(200,168,75,.12);border-left:3px solid #c8a84b;
                        border-radius:0 4px 4px 0;">
              📚 <strong>Reward:</strong> ${actor.name} earns
              <strong>3 Project Progress Points</strong>.<br>
              <span style="opacity:.7;">GM: apply to a project of ${actor.name}'s choice.</span>
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-mo-chat-${msg.id}`;
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

  console.debug(TAG, "Midnight Oil activity loaded.");
})();
