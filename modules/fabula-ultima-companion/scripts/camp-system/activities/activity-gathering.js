// ============================================================================
// Camp Activity — Gathering
// Target: Yourself
//
// Minigame: Ingredient Collector (keyboard-driven 4×4 grid, 15 s)
//   Owner moves their token with arrow keys / WASD to collect good ingredients
//   (+1 each) and avoid poisonous ones (-1, floor 0). Ingredients spawn every
//   ~1.5–2 s and expire after ~3.5–5 s with a visual telegraph.
//
// Grade formula:
//   score >= 6  → "exceptional"  → 3 ingredients, player's choice of taste
//   score >= 3  → "good"         → 3 ingredients, random tastes
//   else        → "standard"     → 2 ingredients, random tastes
//
// Chat posts the result; taste guidance for random-taste tiers directs the
// player to roll 1d6 per ingredient (1=Bitter 2=Salty 3=Sour 4=Sweet 5=Umami).
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Gathering]";

  const GATHERING_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rose/RoseSkill2.png";

  // ---------------------------------------------------------------------------
  // Grade helpers
  // ---------------------------------------------------------------------------
  function _calcGrade(score) {
    if (score >= 8) return "exceptional";
    if (score >= 4) return "good";
    return "standard";
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("gathering", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Broadcast START; GM shows UI directly
        CAMP.Socket.broadcast(CAMP.MSG.GATHERING_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.GatheringUI?.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 2 — Wait for owner to finish the minigame (90 s: Begin gate + 15 s game)
        const { score, taste } = await _waitForScore(actor);
        console.debug(TAG, `Score: ${score}, Taste: ${taste}`);

        // 3 — Compute grade
        const grade = _calcGrade(score);
        console.debug(TAG, `Grade: ${grade}`);

        // 4 — Chat announcement
        await _postChatResult(actor, grade, taste);

        // 5 — Broadcast result to all clients; GM applies reveal directly
        CAMP.Socket.broadcast(CAMP.MSG.GATHERING_RESULT, {
          actorId: actor.id,
          grade,
          taste,
        });
        CAMP.GatheringUI?.applyResult(actor.id, grade, taste);

        // 6 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 7 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.GATHERING_DONE, { actorId: actor.id });
        CAMP.GatheringUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForScore — GM awaits owner's submitted score + taste
  // 90 s covers "Click to Begin" wait + 3.7 s countdown + 15 s game
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.GatheringUI ??= {};
      CAMP.GatheringUI.scoreResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.GatheringUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting to standard for", actor.name);
          delete CAMP.GatheringUI.scoreResolvers[actor.id];
          resolve({ score: 0, taste: null });
        }
      }, 90_000);

      CAMP.GatheringUI.scoreResolvers[actor.id] = (data) => {
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
      CAMP.GatheringUI ??= {};
      CAMP.GatheringUI.proceedResolvers ??= {};
      CAMP.GatheringUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, grade, taste) {
    const ingCount = grade === "standard" ? 2 : 3;
    const gradeColor =
      grade === "exceptional" ? "#c8a84b" :
      grade === "good"        ? "#3a7a35" :
                                "#8a3a20";
    const gradeLabel =
      grade === "exceptional" ? "Exceptional Haul!" :
      grade === "good"        ? "Looks Tasty!"       :
                                "Will These Be Okay?";
    const tasteDesc =
      grade === "exceptional" && taste
        ? `with <strong>${taste}</strong> taste`
        : "with random tastes";
    const tasteHint =
      grade !== "exceptional"
        ? `<div style="font-size:.78em;margin-top:3px;opacity:.7;font-style:italic;">Roll 1d6 per ingredient for taste — 1 Bitter · 2 Salty · 3 Sour · 4 Sweet · 5 Umami.</div>`
        : "";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <div style="font-size:2rem;flex-shrink:0;line-height:1;">🌿</div>
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${actor.name} — Gathering
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${gradeColor};">
              ${gradeLabel}
            </div>
            <div style="font-size:.85em;margin-top:3px;color:#5a3010;">
              Found <strong>${ingCount}</strong> ingredient${ingCount > 1 ? "s" : ""} ${tasteDesc}.
            </div>
            ${tasteHint}
          </div>
        </div>
      `,
    });

    const styleId = `oni-gt-chat-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id    = styleId;
      style.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display:none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top:6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin:0 !important; }
      `;
      document.head.appendChild(style);
    }
  }

  console.debug(TAG, "Gathering activity loaded.");
})();
