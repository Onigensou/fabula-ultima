// ============================================================================
// Camp Activity — Training
// Target: Yourself
//
// Minigame: Timing Gauge
//   The owner stops an oscillating pointer inside a sweet spot on a gauge.
//   Score determines how many status-prevention charges are granted (1–3).
//
// Effect: Once before the next rest, if you are about to suffer one or more
//         status effects from the same source, you may choose to suffer none.
//         Up to 3 charges earned by minigame performance.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Training]";

  const TRAINING_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Els/LordKnightPassive3.png";

  // Score (0–100%) → charges (1–3)
  function _calcCharges(scorePercent) {
    if (scorePercent >= 85) return 3;
    if (scorePercent >= 60) return 2;
    return 1;
  }

  // ---------------------------------------------------------------------------
  // In-combat status-effect interception (GM only, registered once on ready)
  // ---------------------------------------------------------------------------
  // When an actor with a trainingShieldActive AE is about to receive a status,
  // ask the owner whether to prevent it. Returning false from preCreateActiveEffect
  // cancels the effect creation.
  //
  // We track pending choice requests so we can resolve them from socket responses.
  // ---------------------------------------------------------------------------
  const _choiceResolvers = {};  // { [requestId]: resolve(bool) }

  function _awaitChoice(requestId) {
    return new Promise(resolve => {
      _choiceResolvers[requestId] = (prevent) => {
        delete _choiceResolvers[requestId];
        resolve(prevent);
      };
      // Timeout after 30s — assume "no" (don't prevent)
      setTimeout(() => {
        if (_choiceResolvers[requestId]) {
          delete _choiceResolvers[requestId];
          resolve(false);
        }
      }, 30_000);
    });
  }

  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _registerInterceptHook() {
    Hooks.on("preCreateActiveEffect", async (effect, _data, _opts) => {
      if (!game.user?.isGM) return;

      const targetActor = effect.parent instanceof Actor ? effect.parent : null;
      if (!targetActor) return;

      const shieldEffect = targetActor.effects.find(
        e => e.flags?.[MODULE_ID]?.trainingShieldActive === true
      );
      if (!shieldEffect) return;

      // Only intercept actual status effects (debuffs have statuses set)
      const statuses = Array.isArray(effect.statuses) ? effect.statuses : [];
      if (!statuses.length) return;

      const charges = Number(shieldEffect.flags?.[MODULE_ID]?.trainingCharges ?? 0);
      if (charges <= 0) {
        await shieldEffect.delete();
        return; // no charges — don't intercept, let effect apply
      }

      // Build a unique request ID to match response
      const requestId = `training-${targetActor.id}-${Date.now()}`;
      const effectName = effect.name ?? "Status Effect";
      const statusList = statuses.join(", ");

      const ownerUserId = _getOwnerUserId(targetActor);
      let prevent = false;

      if (ownerUserId && ownerUserId !== game.user?.id) {
        // Send dialog request to the owner's client
        CAMP.Socket.emit(CAMP.MSG.TRAINING_CHOICE_REQUEST, {
          requestId,
          actorId:    targetActor.id,
          actorName:  targetActor.name,
          effectName,
          statusList,
          charges,
          targetUserId: ownerUserId,
        });
        prevent = await _awaitChoice(requestId);
      } else {
        // GM is the owner (or solo) — show dialog locally
        prevent = await _showLocalChoiceDialog(targetActor.name, effectName, statusList, charges);
      }

      if (prevent) {
        const newCharges = charges - 1;
        if (newCharges <= 0) {
          await shieldEffect.delete();
        } else {
          await shieldEffect.setFlag(MODULE_ID, "trainingCharges", newCharges);
        }
        return false; // cancel effect creation
      }
    });
  }

  function _showLocalChoiceDialog(actorName, effectName, statusList, charges) {
    return new Promise(resolve => {
      new Dialog({
        title: "Training — Status Prevention",
        content: `
          <div style="padding:6px 0;">
            <p><strong>${actorName}</strong> is about to suffer
               <strong>${effectName}</strong> (${statusList}).</p>
            <p>Use a Training charge to prevent all status effects from this source?</p>
            <p style="font-size:.85em;opacity:.7;">Charges remaining: ${charges}</p>
          </div>
        `,
        buttons: {
          yes: {
            icon:  '<i class="fas fa-shield-alt"></i>',
            label: "Prevent",
            callback: () => resolve(true),
          },
          no: {
            icon:  '<i class="fas fa-times"></i>',
            label: "Allow",
            callback: () => resolve(false),
          },
        },
        default: "yes",
        close: () => resolve(false),
      }, { width: 380 }).render(true);
    });
  }

  // Public: called from camp-socket.js when owner responds
  CAMP.TrainingUI ??= {};
  CAMP.TrainingUI.resolveChoice = function(requestId, prevent) {
    const resolver = _choiceResolvers[requestId];
    if (resolver) resolver(prevent);
  };

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    _registerInterceptHook();

    CAMP.ActivityRegistry?.register("training", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Play activity-start SFX
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // 2 — Broadcast START; GM shows UI directly (broadcast doesn't echo)
        CAMP.Socket.broadcast(CAMP.MSG.TRAINING_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.TrainingUI?.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 3 — Wait for owner to finish the minigame and submit their score
        const scorePercent = await _waitForScore(actor);
        console.debug(TAG, `Score received: ${scorePercent}%`);

        // 4 — Compute charges
        const charges = _calcCharges(scorePercent);
        console.debug(TAG, `Charges: ${charges}`);

        // 5 — Apply AE (replace stale one if it exists)
        const existing = actor.effects.find(
          e => e.flags?.[MODULE_ID]?.trainingShieldActive === true
        );
        const chargesLabel = charges === 1 ? "once" : charges === 2 ? "twice" : "three times";
        // Refresh in place rather than delete+create: under CSB every document
        // write forces a full actor re-derivation, so replacing cost two cycles.
        // Equivalent because this payload fully specifies the effect and writes
        // the same flag key set the stale one carries.
        const effectData = {
          name:        "Training",
          img:         TRAINING_ICON,
          description: `${chargesLabel.charAt(0).toUpperCase() + chargesLabel.slice(1)} before the next rest, if you are about to suffer one or more status effects from the same source, you may instead choose not to suffer any of them.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:      1,
              trainingCharges:      charges,
              trainingShieldActive: true,
            },
          },
        };
        if (existing) await existing.update(effectData);
        else await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);

        // 6 — Broadcast full result to all clients
        CAMP.Socket.broadcast(CAMP.MSG.TRAINING_RESULT, {
          actorId: actor.id,
          score:   scorePercent,
          charges,
        });
        CAMP.TrainingUI?.applyResult(actor.id, scorePercent, charges);

        // 7 — Post chat announcement
        await _postChatResult(actor, scorePercent, charges);

        // 8 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 9 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.TRAINING_DONE, { actorId: actor.id });
        CAMP.TrainingUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForScore — GM awaits owner's submitted score
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.TrainingUI ??= {};
      CAMP.TrainingUI.scoreResolvers ??= {};

      // Timeout: 90s covers "Click to Begin" + countdown + 15s game
      const timer = setTimeout(() => {
        if (CAMP.TrainingUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting to 0 for", actor.name);
          delete CAMP.TrainingUI.scoreResolvers[actor.id];
          resolve(0);
        }
      }, 90_000);

      CAMP.TrainingUI.scoreResolvers[actor.id] = (score) => {
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
      CAMP.TrainingUI ??= {};
      CAMP.TrainingUI.proceedResolvers ??= {};
      CAMP.TrainingUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, scorePercent, charges) {
    const chargeColor =
      charges >= 3 ? "#c8a84b" :
      charges >= 2 ? "#3a7a35" :
                     "#7a5010";

    const label =
      charges >= 3 ? "Flawless technique! Body and mind in perfect harmony." :
      charges >= 2 ? "Solid training. Good muscle memory built." :
                     "Went through the motions. Better than nothing.";

    const chargesText = charges === 1 ? "1 charge" : `${charges} charges`;

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${TRAINING_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${actor.name} — Training
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Score: <strong>${scorePercent}%</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${chargeColor};">
              Prevention Charges: ${chargesText}
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              ${label}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              ${actor.name} may prevent status effects from a single source ${chargesText === "1 charge" ? "once" : `up to ${charges} times`} before the next rest.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-tr-chat-${msg.id}`;
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

  console.debug(TAG, "Training activity loaded.");
})();
