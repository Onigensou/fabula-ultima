// ============================================================================
// Camp Activity — Cartography
// Target: Yourself
//
// Minigame: Snake
//   Owner pilots a snake on a 15×15 grid for 15 seconds, collecting treasure
//   and avoiding hazards and their own trail.
//
// Scoring → campRestCharges (each charge = one Travel Roll reroll):
//   0 hits  → Perfect → 3 charges
//   1 hit   → Good    → 2 charges
//   2+ hits → Standard→ 1 charge
//
// Each charge is a separate AE so the TravelRoll API (which deletes one AE
// per use) can consume them individually without API changes.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Cartography]";

  const MAP_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20MainCommand%20(Others)/02_General/dig.png";

  function _calcCharges(hits) {
    if (hits === 0) return 3;
    if (hits === 1) return 2;
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("cartography", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // 1 — Show minigame overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.CARTOGRAPHY_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.CartographyUI?.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 2 — Wait for owner to finish the Snake minigame
        const { score, hits } = await _waitForScore(actor);
        console.debug(TAG, `Score: ${score}, Hits: ${hits}`);

        const charges = _calcCharges(hits);
        console.debug(TAG, `Charges granted: ${charges}`);

        // 3 — Clear any existing Cartography AEs (player chose this activity again)
        const existing = actor.effects.filter(
          e => e.flags?.[MODULE_ID]?.cartographyReroll === true
        );
        for (const e of existing) await e.delete();

        // 4 — Create a single AE with a cartographyCharges counter.
        //     TravelRoll API decrements the counter on each use, deleting the AE at 0.
        //     campRestCharges: 1 → survives the immediate rest, expires at the next one.
        const aeName = charges === 1 ? "Cartography" : `Cartography ×${charges}`;
        await actor.createEmbeddedDocuments("ActiveEffect", [{
          name:        aeName,
          img:         MAP_ICON,
          description: "Once before the next rest, when your group makes a Travel Roll, you may reroll the die and keep the new result.",
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:    1,
              cartographyReroll:  true,
              cartographyCharges: charges,
              cartographyActorId: actor.id,
            },
          },
        }]);

        // 5 — Broadcast result to all clients (triggers reveal panel in UI)
        CAMP.Socket.broadcast(CAMP.MSG.CARTOGRAPHY_RESULT, {
          actorId: actor.id,
          score,
          hits,
          charges,
        });
        CAMP.CartographyUI?.applyResult(actor.id, score, hits, charges);

        // 6 — Post chat announcement
        await _postChatResult(actor, score, hits, charges);

        // 7 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 8 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.CARTOGRAPHY_DONE, { actorId: actor.id });
        CAMP.CartographyUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForScore — GM awaits owner's submitted score
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.CartographyUI ??= {};
      CAMP.CartographyUI.scoreResolvers ??= {};

      // 90 s covers "Click to Begin" wait + countdown + 15 s game + buffer
      const timer = setTimeout(() => {
        if (CAMP.CartographyUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting for", actor.name);
          delete CAMP.CartographyUI.scoreResolvers[actor.id];
          resolve({ score: 0, hits: 3 });
        }
      }, 90_000);

      CAMP.CartographyUI.scoreResolvers[actor.id] = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForProceed — GM awaits owner's "Click to Proceed"
  // ---------------------------------------------------------------------------
  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.CartographyUI ??= {};
      CAMP.CartographyUI.proceedResolvers ??= {};
      CAMP.CartographyUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, score, hits, charges) {
    const gradeLabel =
      charges === 3 ? "Perfect charting — no errors!" :
      charges === 2 ? "Good work." :
                      "Standard mapping.";
    const gradeColor =
      charges === 3 ? "#c8a84b" :
      charges === 2 ? "#4caf50" :
                      "#888";
    const chargeLabel = charges === 1 ? "1 Charge" : `${charges} Charges`;

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${MAP_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#8a6f2e;">
              ${actor.name} — Cartography
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Score: <strong>${score}</strong> &middot; Errors: <strong>${hits}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${gradeColor};">
              ${gradeLabel} &rarr; ${chargeLabel}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              Once before the next rest, when your group makes a Travel Roll,
              you may reroll the die and keep the new result.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-carto-chat-${msg.id}`;
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

  console.debug(TAG, "Cartography activity loaded.");
})();
