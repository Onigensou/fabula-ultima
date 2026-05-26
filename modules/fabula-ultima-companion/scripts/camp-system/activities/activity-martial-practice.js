// ============================================================================
// Camp Activity — Martial Practice
// Target: Yourself
// Effect: Once before the next rest, when you perform an attack, you may grant
//         that attack multi (2) or increase its multi property by one.
//         Score ≥ 200 → 3 uses | ≥ 100 → 2 uses | else → 1 use.
// Minigame: Fruit Ninja (15 s cursor-slash game)
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][MartialPractice]";

  const ICON =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Chung/DivinePhanesPassive2.png";

  function _calcUses(score) {
    if (score >= 200) return 3;
    if (score >= 100) return 2;
    return 1;
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
  async function _postChatResult(actor, score, uses) {
    const rank =
      uses >= 3 ? "Master Swordsman" :
      uses >= 2 ? "Skilled Warrior"  : "Diligent Trainee";

    const flavor =
      uses >= 3 ? "Precise, relentless, unstoppable. The blade moves as an extension of the will." :
      uses >= 2 ? "A solid session. The sword arm is sharper for it."                              :
                  "Practice makes progress. One more rep tomorrow.";

    const usesText = uses === 1 ? "1 use" : `${uses} uses`;
    const usesColor =
      uses >= 3 ? "#c8a84b" :
      uses >= 2 ? "#3a7a35" : "#7a5010";

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
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${usesColor};">
              Multi Charge: ${usesText}
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              ${flavor}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              ${actor.name} may grant an attack <strong>multi (2)</strong> or increase
              its <strong>multi</strong> by one — ${usesText} before the next rest.
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
        const score = await _waitForScore(actor);
        const uses  = _calcUses(score);
        console.debug(TAG, `Score: ${score} → ${uses} use(s)`);

        // 3 — Apply AE (replace stale one if present)
        const existing = actor.effects.find(
          e => e.flags?.[MODULE_ID]?.martialPracticeActive === true
        );
        if (existing) await existing.delete();

        const usesWord = uses === 1 ? "once" : uses === 2 ? "twice" : "three times";
        await actor.createEmbeddedDocuments("ActiveEffect", [{
          name:        "Martial Practice",
          img:         ICON,
          description: `${usesWord.charAt(0).toUpperCase() + usesWord.slice(1)} before the next rest, when you perform an attack you may grant that attack multi (2) or increase its multi property by one.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:        1,
              martialPracticeActive:  true,
              martialPracticeUses:    uses,
            },
          },
        }]);

        // 4 — Broadcast full result to all clients
        CAMP.Socket.broadcast(CAMP.MSG.MARTIAL_PRACTICE_RESULT, {
          actorId: actor.id,
          score,
          uses,
        });
        CAMP.MartialPracticeUI?.applyResult(actor.id, score, uses);

        // 5 — Post chat announcement
        await _postChatResult(actor, score, uses);

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
