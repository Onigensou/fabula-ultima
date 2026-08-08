// ============================================================================
// Camp Activity — Massage
// Target: One ally
//
// Minigame: Hot-and-Cold (3×3 grid, 15 s)
//   Owner clicks cells to locate the hidden "perfect spot".
//   Proximity feedback: Perfect (Red, +5) / Close (Yellow, +2) /
//   Near (Green, +1) / Miss (Blue, 0). Perfect hit generates a new spot.
//
// Effect: Once before the next rest, when the target is about to pay an MP
//         cost, they may reduce that cost by X% (min 0). Not for Rituals.
//   X = 25% + (score / 50) * 50% → range 25–75%.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Massage]";

  const MASSAGE_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Aisha/MysticAlchemistSkill5.png";

  const MAX_SCORE = 50; // theoretical ceiling; matches activity-massage-ui.js

  function _calcReduction(score) {
    const ratio = Math.max(0, Math.min(1, score / MAX_SCORE));
    return Math.round(25 + ratio * 50);
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("massage", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Resolve party; build allies list (exclude self)
        const party  = await CAMP.Party.resolve();
        const allies = party
          .filter(e => e.actorId !== actor.id)
          .map(e => ({
            id:   e.actorId,
            name: e.actor.name,
            img:  _getTokenImg(e.actor),
          }));

        if (!allies.length) {
          ui.notifications?.warn("Massage: no other party members to target.");
          return;
        }

        // 2 — Play activity-start SFX
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // 3 — Broadcast START; GM shows picker directly
        CAMP.Socket.broadcast(CAMP.MSG.MASSAGE_START, {
          actorId:   actor.id,
          actorName: actor.name,
          allies,
        });
        CAMP.MassageUI?.show(actor.id, allies);

        await new Promise(r => setTimeout(r, 300));

        // 4 — Wait for owner to pick a target
        const targetActorId = await _waitForTarget(actor);
        const targetActor   = game.actors?.get(targetActorId);
        if (!targetActor) {
          console.warn(TAG, "Target actor not found:", targetActorId);
          return;
        }

        // 5 — Broadcast MINIGAME phase; GM shows arena directly
        CAMP.Socket.broadcast(CAMP.MSG.MASSAGE_MINIGAME, {
          actorId:       actor.id,
          targetActorId,
        });
        CAMP.MassageUI?.showArena(actor.id, targetActorId);

        await new Promise(r => setTimeout(r, 300));

        // 6 — Wait for owner to finish the minigame
        const score = await _waitForScore(actor);
        console.debug(TAG, `Score received: ${score}`);

        // 7 — Compute reduction
        const reduction = _calcReduction(score);
        console.debug(TAG, `Reduction: ${reduction}%`);

        // 8 — Apply AE to target (remove stale one first)
        const existing = targetActor.effects.find(
          e => e.flags?.[MODULE_ID]?.massageReduction != null
        );
        // Refresh in place rather than delete+create: under CSB every document
        // write forces a full actor re-derivation, so replacing cost two cycles.
        // Equivalent because this payload fully specifies the effect and writes
        // the same flag key set the stale one carries.
        const effectData = {
          name:        "Massage",
          img:         MASSAGE_ICON,
          description: `Once before the next rest, when you are about to pay an MP cost, you may reduce that cost by ${reduction}% (minimum 0). Cannot apply to a Ritual's MP cost.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:  1,
              massageReduction: reduction,
              massageCasterId:  actor.id,
            },
          },
        };
        if (existing) await existing.update(effectData);
        else await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);

        // 9 — Broadcast result to all clients
        CAMP.Socket.broadcast(CAMP.MSG.MASSAGE_RESULT, {
          actorId:       actor.id,
          targetActorId,
          score,
          reduction,
        });
        CAMP.MassageUI?.applyResult(actor.id, score, reduction);

        // 10 — Post chat announcement
        await _postChatResult(actor, targetActor, score, reduction);

        // 11 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 12 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.MASSAGE_DONE, { actorId: actor.id });
        CAMP.MassageUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForTarget — GM awaits owner's ally selection
  // ---------------------------------------------------------------------------
  function _waitForTarget(actor) {
    return new Promise(resolve => {
      CAMP.MassageUI ??= {};
      CAMP.MassageUI.targetResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.MassageUI.targetResolvers[actor.id]) {
          console.warn(TAG, "Target timeout — auto-picking first ally for", actor.name);
          delete CAMP.MassageUI.targetResolvers[actor.id];
          CAMP.Party.resolve().then(p => {
            const ally = p.find(e => e.actorId !== actor.id);
            resolve(ally?.actorId ?? "");
          });
        }
      }, 60_000);

      CAMP.MassageUI.targetResolvers[actor.id] = (targetActorId) => {
        clearTimeout(timer);
        resolve(targetActorId);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForScore — GM awaits owner's submitted score (90 s covers begin + countdown + game)
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.MassageUI ??= {};
      CAMP.MassageUI.scoreResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.MassageUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting to 0 for", actor.name);
          delete CAMP.MassageUI.scoreResolvers[actor.id];
          resolve(0);
        }
      }, 90_000);

      CAMP.MassageUI.scoreResolvers[actor.id] = (score) => {
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
      CAMP.MassageUI ??= {};
      CAMP.MassageUI.proceedResolvers ??= {};
      CAMP.MassageUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Token image helper
  // ---------------------------------------------------------------------------
  function _getTokenImg(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(caster, target, score, reduction) {
    const rank =
      score >= 41 ? "Master"  :
      score >= 26 ? "Skilled" :
      score >= 11 ? "Decent"  :
                    "Clumsy";

    const reductionColor =
      reduction >= 65 ? "#c8a84b" :
      reduction >= 50 ? "#3a7a35" :
                        "#7a5010";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${MASSAGE_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${caster.name} — Massage
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Target: <strong>${target.name}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${reductionColor};">
              ${rank} — MP Reduction: ${reduction}%
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              Score: ${score} / ${MAX_SCORE}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              Once before the next rest, ${target.name} may reduce an MP cost by ${reduction}%.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-ms-chat-${msg.id}`;
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

  console.debug(TAG, "Massage activity loaded.");
})();
