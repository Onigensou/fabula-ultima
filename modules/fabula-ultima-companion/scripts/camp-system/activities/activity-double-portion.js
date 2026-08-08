// ============================================================================
// Camp Activity — Double Portion
// Target: One ally
//
// Minigame: Food Order (drag-and-drop, 15 s)
//   Owner drags the correct food icons from a grid to the feed zone.
//   Correct delivery: score++ / Wrong delivery: score-- (min 0)
//
// Grade formula:
//   wrong == 0 && score > 0  → "perfect"  → ×3 HP recovery
//   score > 0                → "partial"  → ×2 HP recovery
//   else                     → "failure"  → low bonus (flat note)
//
// Effect (on TARGET):
//   Once before the next rest, if the target is about to recover HP,
//   they may [triple / double / gain a small bonus on] the amount recovered.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][DoublePortion]";

  const DP_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rose/RoseSkill2.png";

  // ---------------------------------------------------------------------------
  // Grade → multiplier
  // ---------------------------------------------------------------------------
  function _calcMultiplier(grade) {
    if (grade === "perfect") return 3;
    if (grade === "partial") return 2;
    return 1;
  }

  function _calcGrade(score, wrong) {
    if (score > 0 && wrong === 0) return "perfect";
    if (score > 0)                return "partial";
    return "failure";
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("double_portion", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Resolve party; build allies list (exclude self)
        const party = await CAMP.Party.resolve();
        const allies = party
          .filter(e => e.actorId !== actor.id)
          .map(e => ({
            id:   e.actorId,
            name: e.actor.name,
            img:  _getTokenImg(e.actor),
          }));

        if (!allies.length) {
          ui.notifications?.warn("Double Portion: no other party members to feed.");
          return;
        }

        // 2 — Broadcast START; GM shows picker directly
        CAMP.Socket.broadcast(CAMP.MSG.DOUBLE_PORTION_START, {
          actorId:   actor.id,
          actorName: actor.name,
          allies,
        });
        CAMP.DoublePortionUI?.show(actor.id, allies);

        await new Promise(r => setTimeout(r, 300));

        // 3 — Wait for owner to pick a target
        const targetActorId = await _waitForTarget(actor);
        const targetActor   = game.actors?.get(targetActorId);
        if (!targetActor) {
          console.warn(TAG, "Target actor not found:", targetActorId);
          return;
        }

        // 4 — Broadcast MINIGAME phase; GM shows arena directly
        CAMP.Socket.broadcast(CAMP.MSG.DOUBLE_PORTION_MINIGAME, {
          actorId:       actor.id,
          targetActorId,
        });
        CAMP.DoublePortionUI?.showArena(actor.id, targetActorId);

        await new Promise(r => setTimeout(r, 300));

        // 5 — Wait for owner to finish the minigame
        const { score, wrong } = await _waitForScore(actor);
        console.debug(TAG, `Score: ${score}, Wrong: ${wrong}`);

        // 6 — Compute grade and multiplier
        const grade      = _calcGrade(score, wrong);
        const multiplier = _calcMultiplier(grade);
        console.debug(TAG, `Grade: ${grade}, Multiplier: ×${multiplier}`);

        // 7 — Apply AE to target (remove stale one first)
        const existing = targetActor.effects.find(
          e => e.flags?.[MODULE_ID]?.doublePortionMultiplier != null
        );
        const effectDesc =
          multiplier === 3
            ? `Once before the next rest, if you are about to recover Hit Points, you may triple the amount recovered.`
            : multiplier === 2
            ? `Once before the next rest, if you are about to recover Hit Points, you may double the amount recovered.`
            : `Once before the next rest, when you recover Hit Points, you gain a small additional bonus (+5 HP).`;

        // Refresh in place rather than delete+create: under CSB every document
        // write forces a full actor re-derivation, so replacing cost two cycles.
        // Equivalent because this payload fully specifies the effect and writes
        // the same flag key set the stale one carries.
        const effectData = {
          name:        "Double Portion",
          img:         DP_ICON,
          description: effectDesc,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:         1,
              doublePortionGrade:      grade,
              doublePortionMultiplier: multiplier,
              doublePortionCasterId:   actor.id,
            },
          },
        };
        if (existing) await existing.update(effectData);
        else await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);

        // 8 — Broadcast full result; GM applies reveal directly
        CAMP.Socket.broadcast(CAMP.MSG.DOUBLE_PORTION_RESULT, {
          actorId:       actor.id,
          targetActorId,
          grade,
          multiplier,
        });
        CAMP.DoublePortionUI?.applyResult(actor.id, targetActorId, grade, multiplier);

        // 9 — Chat announcement
        await _postChatResult(actor, targetActor, grade, multiplier);

        // 10 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 11 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.DOUBLE_PORTION_DONE, { actorId: actor.id });
        CAMP.DoublePortionUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForTarget — GM awaits owner's ally selection
  // ---------------------------------------------------------------------------
  function _waitForTarget(actor) {
    return new Promise(resolve => {
      CAMP.DoublePortionUI ??= {};
      CAMP.DoublePortionUI.targetResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.DoublePortionUI.targetResolvers[actor.id]) {
          console.warn(TAG, "Target timeout — auto-picking first ally for", actor.name);
          delete CAMP.DoublePortionUI.targetResolvers[actor.id];
          CAMP.Party.resolve().then(p => {
            const ally = p.find(e => e.actorId !== actor.id);
            resolve(ally?.actorId ?? "");
          });
        }
      }, 60_000);

      CAMP.DoublePortionUI.targetResolvers[actor.id] = (targetActorId) => {
        clearTimeout(timer);
        resolve(targetActorId);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForScore — GM awaits owner's submitted score
  // 90 s covers "Click to Begin" wait + 3.7 s countdown + 15 s game
  // ---------------------------------------------------------------------------
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.DoublePortionUI ??= {};
      CAMP.DoublePortionUI.scoreResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.DoublePortionUI.scoreResolvers[actor.id]) {
          console.warn(TAG, "Score timeout — defaulting to failure for", actor.name);
          delete CAMP.DoublePortionUI.scoreResolvers[actor.id];
          resolve({ score: 0, wrong: 0 });
        }
      }, 90_000);

      CAMP.DoublePortionUI.scoreResolvers[actor.id] = (data) => {
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
      CAMP.DoublePortionUI ??= {};
      CAMP.DoublePortionUI.proceedResolvers ??= {};
      CAMP.DoublePortionUI.proceedResolvers[actor.id] = resolve;
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
  async function _postChatResult(caster, target, grade, multiplier) {
    const gradeColor =
      grade === "perfect" ? "#c8a84b" :
      grade === "partial" ? "#3a7a35" :
                            "#7a5010";
    const gradeLabel =
      grade === "perfect" ? "Perfect Meal!" :
      grade === "partial" ? "Good Enough!"  :
                            "Scraped By…";
    const effectShort =
      multiplier === 3 ? "Triple HP recovery"  :
      multiplier === 2 ? "Double HP recovery"  :
                         "Small HP bonus (+5)";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${DP_ICON}" style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${caster.name} — Double Portion
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Fed <strong>${target.name}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${gradeColor};">
              ${gradeLabel} — ${effectShort}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              ${multiplier >= 2
                ? `Once before the next rest, ${target.name} may ${multiplier === 3 ? "triple" : "double"} HP recovered.`
                : `Once before the next rest, ${target.name} gains a small HP bonus (+5) on recovery.`}
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-dp-chat-${msg.id}`;
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

  console.debug(TAG, "Double Portion activity loaded.");
})();
