// ============================================================================
// Camp Activity — Sleep Soundly
// Target: Yourself
// Effect: Once before the next rest, you may perform an additional action on
//         your turn during a conflict scene (Equipment, Hinder, or Inventory).
//         Score ≥ 241 → 3 charges | ≥ 161 → 2 charges | else → 1 charge.
// Minigame: Radial Dream Protector (15 s click game)
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][SleepSoundly]";

  const SLEEP_SOUNDLY_ICON =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Chung/DivinePhanesPassive2.png";

  function _calcCharges(score) {
    if (score >= 241) return 3;
    if (score >= 161) return 2;
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Pending resolver helpers
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.SleepSoundlyUI ??= {};
      CAMP.SleepSoundlyUI.scoreResolvers ??= {};
      // Timeout: 90 s covers Click-to-Begin + countdown + 15 s game
      const timer = setTimeout(() => {
        if (CAMP.SleepSoundlyUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting to 0 for", actor.name);
          delete CAMP.SleepSoundlyUI.scoreResolvers[actor.id];
          resolve(0);
        }
      }, 90_000);
      CAMP.SleepSoundlyUI.scoreResolvers[actor.id] = (val) => {
        clearTimeout(timer);
        resolve(val);
      };
    });
  }

  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.SleepSoundlyUI ??= {};
      CAMP.SleepSoundlyUI.proceedResolvers ??= {};
      CAMP.SleepSoundlyUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Chat result post
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, score, charges) {
    const rank =
      charges >= 3 ? "Perfect Slumber" :
      charges >= 2 ? "Sweet Dreams" :
      score  >= 81 ? "Cozy Sleep" :
      score  >= 1  ? "Light Sleep" : "Restless Night";

    const flavor =
      charges >= 3 ? "A night of perfect rest. Dreams couldn't have been sweeter." :
      charges >= 2 ? "Slept well. Woke up feeling refreshed and ready." :
                     "Got some rest, at least. The nightmares weren't too bad.";

    const chargesText = charges === 1 ? "1 charge" : `${charges} charges`;
    const chargeColor =
      charges >= 3 ? "#c8a84b" :
      charges >= 2 ? "#3a7a35" : "#7a5010";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${SLEEP_SOUNDLY_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${actor.name} — Sleep Soundly
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              ${rank} — Score: <strong>${score}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${chargeColor};">
              Extra Action Charges: ${chargesText}
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              ${flavor}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              ${actor.name} may perform an additional <strong>Equipment</strong>,
              <strong>Hinder</strong>, or <strong>Inventory</strong> action during a
              conflict scene ${chargesText === "1 charge" ? "once" : `up to ${charges} times`} before the next rest.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-ss-chat-${msg.id}`;
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

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("sleep_soundly", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Broadcast START; GM shows UI directly (broadcast doesn't echo)
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);
        CAMP.Socket.broadcast(CAMP.MSG.SLEEP_SOUNDLY_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.SleepSoundlyUI?.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 2 — Await owner's final score
        const score   = await _waitForScore(actor);
        const charges = _calcCharges(score);
        console.debug(TAG, `Score: ${score} → ${charges} charge(s)`);

        // 3 — Apply AE (replace stale one if it exists)
        const existing = actor.effects.find(
          e => e.flags?.[MODULE_ID]?.sleepSoundlyActive === true
        );
        if (existing) await existing.delete();

        const chargesWord = charges === 1 ? "once" : charges === 2 ? "twice" : "three times";
        await actor.createEmbeddedDocuments("ActiveEffect", [{
          name:        "Sleep Soundly",
          img:         SLEEP_SOUNDLY_ICON,
          description: `${chargesWord.charAt(0).toUpperCase() + chargesWord.slice(1)} before the next rest, you may perform an additional Equipment, Hinder, or Inventory action during a conflict scene.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:     1,
              sleepSoundlyActive:  true,
              sleepSoundlyCharges: charges,
            },
          },
        }]);

        // 4 — Broadcast full result to all clients
        CAMP.Socket.broadcast(CAMP.MSG.SLEEP_SOUNDLY_RESULT, {
          actorId: actor.id,
          score,
          charges,
        });
        CAMP.SleepSoundlyUI?.applyResult(actor.id, score, charges);

        // 5 — Post chat announcement
        await _postChatResult(actor, score, charges);

        // 6 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 7 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.SLEEP_SOUNDLY_DONE, { actorId: actor.id });
        CAMP.SleepSoundlyUI?.hide();
      },
    });

    // Public API called by camp-socket.js (GM-side)
    CAMP.SleepSoundlyUI ??= {};

    CAMP.SleepSoundlyUI.resolveScore = function(actorId, score) {
      const resolver = CAMP.SleepSoundlyUI.scoreResolvers?.[actorId];
      if (!resolver) return;
      delete CAMP.SleepSoundlyUI.scoreResolvers[actorId];
      resolver(score);
    };

    CAMP.SleepSoundlyUI.resolveProceed = function(actorId) {
      const resolver = CAMP.SleepSoundlyUI.proceedResolvers?.[actorId];
      if (!resolver) return;
      delete CAMP.SleepSoundlyUI.proceedResolvers[actorId];
      resolver();
    };
  });
})();
