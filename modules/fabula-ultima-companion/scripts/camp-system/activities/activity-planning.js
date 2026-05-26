// ============================================================================
// Camp Activity — Planning
// Target: One ally
//
// Minigame: Pairing Quiz
//   Both the performer and target secretly pick one of two battle-strategy
//   choices for 3 questions, then reveal and score how many matched.
//
// Effect: Once before the next rest, after the target performs a Group Check
//         as leader or a Check to examine someone/something, they may add a
//         bonus to the Result based on how many choices matched.
//   0 matches: +3
//   1 match:   +4
//   2 matches: +5
//   3 matches: +6
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Planning]";

  const PLANNING_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Add/MastermindPassive2.png";

  const QUESTIONS = [
    { a: "Stealth",          b: "Frontal Assault"    },
    { a: "Range",            b: "Melee"              },
    { a: "Offense",          b: "Defense"            },
    { a: "Magic",            b: "Brawn"              },
    { a: "Sword",            b: "Shield"             },
    { a: "Strike First",     b: "Wait"               },
    { a: "Teamwork",         b: "Solo"               },
    { a: "Speed",            b: "Power"              },
    { a: "High Ground",      b: "Low Ground"         },
    { a: "Bait",             b: "Ambush"             },
    { a: "Scout Ahead",      b: "Press Forward"      },
    { a: "Guard One",        b: "Cover All"          },
    { a: "Magic Defense",    b: "Physical Defense"   },
    { a: "Precision",        b: "Force"              },
    { a: "Retreat",          b: "Hold Ground"        },
  ];

  function _pickQuestions(n) {
    const pool = [...QUESTIONS];
    const picked = [];
    for (let i = 0; i < n && pool.length; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked;
  }

  function _calcBonus(matchCount) {
    return matchCount + 3; // 0→3, 1→4, 2→5, 3→6
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    console.log(TAG, "ready hook fired — registering planning");
    CAMP.ActivityRegistry?.register("planning", {
      async execute(actor, _scene) {
        console.log(TAG, "execute() called for", actor?.name);
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
          ui.notifications?.warn("Planning: no other party members to target.");
          return;
        }

        // 2 — Play activity-start SFX
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // 3 — Broadcast START; GM shows directly
        CAMP.Socket.broadcast(CAMP.MSG.PLANNING_START, {
          actorId:   actor.id,
          actorName: actor.name,
          allies,
        });
        CAMP.PlanningUI?.show(actor.id, actor.name, allies);

        await new Promise(r => setTimeout(r, 300));

        // 4 — Wait for owner to pick target
        const targetActorId = await _waitForTarget(actor);
        const targetActor   = game.actors?.get(targetActorId);
        if (!targetActor) {
          console.warn(TAG, "Target actor not found:", targetActorId);
          return;
        }

        // 5 — Pick 3 random questions
        const questions = _pickQuestions(3);
        console.debug(TAG, "Questions selected:", questions.map(q => `${q.a} or ${q.b}`));

        // 6 — Broadcast ARENA; GM shows directly
        CAMP.Socket.broadcast(CAMP.MSG.PLANNING_ARENA, {
          actorId:         actor.id,
          actorName:       actor.name,
          targetActorId,
          targetActorName: targetActor.name,
          targetImg:       _getTokenImg(targetActor),
          ownerImg:        _getTokenImg(actor),
        });
        CAMP.PlanningUI?.showArena(
          actor.id, actor.name,
          targetActorId, targetActor.name,
          _getTokenImg(targetActor), _getTokenImg(actor),
        );

        await new Promise(r => setTimeout(r, 300));

        // 7 — Guessing Phase: collect both picks per round without revealing
        const ownerPicks  = [];
        const targetPicks = [];

        for (let q = 0; q < 3; q++) {
          const question = questions[q];

          CAMP.Socket.broadcast(CAMP.MSG.PLANNING_QUESTION, {
            actorId: actor.id,
            targetActorId,
            q,
            question,
          });
          CAMP.PlanningUI?.showQuestion(actor.id, targetActorId, q, question);

          await new Promise(r => setTimeout(r, 300));

          // Wait for both players to lock in (parallel, hidden from each other)
          const [ownerChoice, targetChoice] = await Promise.all([
            _waitForOwnerPick(actor),
            _waitForTargetPick(targetActor),
          ]);
          ownerPicks.push(ownerChoice);
          targetPicks.push(targetChoice);

          console.debug(TAG, `Q${q + 1}: owner=${ownerChoice}, target=${targetChoice}`);

          await new Promise(r => setTimeout(r, 500));
        }

        // 8 — Reveal Phase: sequential reveal with animations
        let matchCount = 0;

        for (let q = 0; q < 3; q++) {
          const match = ownerPicks[q] === targetPicks[q];
          if (match) matchCount++;

          CAMP.Socket.broadcast(CAMP.MSG.PLANNING_REVEAL, {
            actorId:      actor.id,
            targetActorId,
            q,
            question:     questions[q],
            ownerChoice:  ownerPicks[q],
            targetChoice: targetPicks[q],
            match,
            score:        matchCount,
          });
          CAMP.PlanningUI?.showReveal(
            actor.id, targetActorId,
            q, questions[q],
            ownerPicks[q], targetPicks[q],
            match, matchCount,
          );

          await new Promise(r => setTimeout(r, 2200));
        }

        // 9 — Compute bonus
        const bonus = _calcBonus(matchCount);
        console.debug(TAG, `Final: ${matchCount}/3 matches → +${bonus}`);

        // 10 — Apply / replace AE on target
        const existing = targetActor.effects.find(
          e => e.flags?.[MODULE_ID]?.planningBonus != null
        );
        if (existing) await existing.delete();

        await targetActor.createEmbeddedDocuments("ActiveEffect", [{
          name:        "Planning",
          img:         PLANNING_ICON,
          description: `Once before the next rest, after you perform a Group Check as leader or a Check to examine someone/something, you may add +${bonus} to the Result.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:  1,
              planningBonus:    bonus,
              planningCasterId: actor.id,
            },
          },
        }]);

        // 11 — Broadcast final result; GM shows directly
        CAMP.Socket.broadcast(CAMP.MSG.PLANNING_RESULT, {
          actorId:         actor.id,
          actorName:       actor.name,
          targetActorId,
          targetActorName: targetActor.name,
          matchCount,
          bonus,
        });
        CAMP.PlanningUI?.applyResult(actor.id, targetActorId, matchCount, bonus);

        // 12 — Post chat announcement
        await _postChatResult(actor, targetActor, matchCount, bonus);

        // 13 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 14 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.PLANNING_DONE, { actorId: actor.id });
        CAMP.PlanningUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Pending resolver helpers
  // ---------------------------------------------------------------------------

  function _waitForTarget(actor) {
    return new Promise(resolve => {
      CAMP.PlanningUI ??= {};
      CAMP.PlanningUI.targetResolvers ??= {};
      CAMP.PlanningUI.targetResolvers[actor.id] = resolve;
    });
  }

  function _waitForOwnerPick(actor) {
    return new Promise(resolve => {
      CAMP.PlanningUI ??= {};
      CAMP.PlanningUI.ownerPickResolvers ??= {};
      CAMP.PlanningUI.ownerPickResolvers[actor.id] = resolve;
    });
  }

  function _waitForTargetPick(targetActor) {
    return new Promise(resolve => {
      CAMP.PlanningUI ??= {};
      CAMP.PlanningUI.targetPickResolvers ??= {};
      CAMP.PlanningUI.targetPickResolvers[targetActor.id] = resolve;
    });
  }

  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.PlanningUI ??= {};
      CAMP.PlanningUI.proceedResolvers ??= {};
      CAMP.PlanningUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
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
  async function _postChatResult(caster, target, matchCount, bonus) {
    const stars =
      matchCount === 3 ? "★★★" :
      matchCount === 2 ? "★★☆" :
      matchCount === 1 ? "★☆☆" :
                         "☆☆☆";

    const gradeColor =
      matchCount === 3 ? "#c8a84b" :
      matchCount === 2 ? "#3a7a35" :
      matchCount === 1 ? "#3a5a7a" :
                         "#7a5010";

    const flavorLine =
      matchCount === 3 ? "A perfect read — you think alike." :
      matchCount === 2 ? "Mostly on the same page." :
      matchCount === 1 ? "At least one instinct aligned." :
                         "Different minds… perhaps that's fine too.";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${PLANNING_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${caster.name} — Planning
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Target: <strong>${target.name}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${gradeColor};">
              ${stars}  ${matchCount}/3 Matches — +${bonus} to Check
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              ${flavorLine}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              Once before the next rest, ${target.name} may add +${bonus} to a qualifying Group Check or Examine Check.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-pl-chat-${msg.id}`;
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

  console.debug(TAG, "Planning activity loaded.");
})();
