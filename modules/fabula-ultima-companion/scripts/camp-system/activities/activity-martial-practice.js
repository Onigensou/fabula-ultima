// ============================================================================
// Camp Activity — Martial Practice
// Target: Yourself
// Effect: Once before the next rest, when you perform an attack, you may grant
//         that attack multi (X) or increase its multi property to X.
//         Score ≥ 200 → Multi 4 (exceptional) | ≥ 100 → Multi 3 (great) | else → Multi 2.
// Minigame: Fruit Ninja (15 s cursor-slash game)
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][MartialPractice]";

  const ICON =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Elesis/PatronaPassive3.png";

  function _calcMultiValue(score) {
    if (score >= 320) return 4;
    if (score >= 185) return 3;
    return 2;
  }

  // ---------------------------------------------------------------------------
  // Pending resolver helpers
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.MartialPracticeUI ??= {};
      CAMP.MartialPracticeUI.scoreResolvers ??= {};
      const timer = setTimeout(() => {
        if (CAMP.MartialPracticeUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting to 0 for", actor.name);
          delete CAMP.MartialPracticeUI.scoreResolvers[actor.id];
          resolve(0);
        }
      }, 90_000);
      CAMP.MartialPracticeUI.scoreResolvers[actor.id] = (val) => {
        clearTimeout(timer);
        resolve(val);
      };
    });
  }

  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.MartialPracticeUI ??= {};
      CAMP.MartialPracticeUI.proceedResolvers ??= {};
      CAMP.MartialPracticeUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Chat result
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, score, multiValue) {
    const rank =
      multiValue >= 4 ? "Master Swordsman" :
      multiValue >= 3 ? "Skilled Warrior"  : "Diligent Trainee";

    const flavor =
      multiValue >= 4 ? "Precise, relentless, unstoppable. The blade moves as an extension of the will." :
      multiValue >= 3 ? "A solid session. The sword arm is sharper for it."                               :
                        "Practice makes progress. One more rep tomorrow.";

    const multiColor =
      multiValue >= 4 ? "#c8a84b" :
      multiValue >= 3 ? "#3a7a35" : "#7a5010";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${ICON}" style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${actor.name} — Martial Practice
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              ${rank} — Score: <strong>${score}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${multiColor};">
              Multi Charge: Multi (${multiValue})
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              ${flavor}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              Once before the next rest, ${actor.name} may grant an attack
              <strong>multi (${multiValue})</strong> or increase its
              <strong>multi</strong> property to ${multiValue}.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-mp-chat-${msg.id}`;
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
    CAMP.ActivityRegistry?.register("martial_practice", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Broadcast START; GM shows UI directly (broadcast doesn't echo)
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);
        CAMP.Socket.broadcast(CAMP.MSG.MARTIAL_PRACTICE_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.MartialPracticeUI?.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 2 — Await owner's final score
        const score      = await _waitForScore(actor);
        const multiValue = _calcMultiValue(score);
        console.debug(TAG, `Score: ${score} → Multi(${multiValue})`);

        // 3 — Apply AE (replace stale one if present)
        const existing = actor.effects.find(
          e => e.flags?.[MODULE_ID]?.martialPracticeActive === true
        );
        // Refresh in place rather than delete+create: under CSB every document
        // write forces a full actor re-derivation, so replacing cost two cycles.
        // Equivalent because this payload fully specifies the effect and writes
        // the same flag key set the stale one carries.
        const effectData = {
          name:        "Martial Practice",
          img:         ICON,
          description: `Once before the next rest, when you perform an attack you may grant that attack multi (${multiValue}) or increase its multi property to ${multiValue}.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:       1,
              martialPracticeActive: true,
              martialPracticeMulti:  multiValue,
            },
          },
        };
        if (existing) await existing.update(effectData);
        else await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);

        // 4 — Broadcast full result to all clients
        CAMP.Socket.broadcast(CAMP.MSG.MARTIAL_PRACTICE_RESULT, {
          actorId: actor.id,
          score,
          multiValue,
        });
        CAMP.MartialPracticeUI?.applyResult(actor.id, score, multiValue);

        // 5 — Post chat announcement
        await _postChatResult(actor, score, multiValue);

        // 6 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 7 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.MARTIAL_PRACTICE_DONE, { actorId: actor.id });
        CAMP.MartialPracticeUI?.hide();
      },
    });

    // Public API called by camp-socket.js (GM-side resolver stubs)
    CAMP.MartialPracticeUI ??= {};

    CAMP.MartialPracticeUI.resolveScore = function(actorId, score) {
      const r = this.scoreResolvers?.[actorId];
      if (!r) return;
      delete this.scoreResolvers[actorId];
      r(score);
    };

    CAMP.MartialPracticeUI.resolveProceed = function(actorId) {
      const r = this.proceedResolvers?.[actorId];
      if (!r) return;
      delete this.proceedResolvers[actorId];
      r();
    };
  });
})();
