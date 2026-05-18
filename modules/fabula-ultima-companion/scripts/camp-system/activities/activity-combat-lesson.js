// ============================================================================
// Camp Activity — Combat Lesson
// Target: One ally
//
// Minigame:
//   Teacher rolls MIG+INS, target rolls INS+MIG (both silent via CheckRequester).
//   The proximity of the two totals determines a bonus (+1–+5) granted to the
//   target as a "may use" Active Effect (campRestCharges: 1).
//
// Bonus formula (|teacher − target| → bonus):
//   0–1  → +5 | 2–3  → +4 | 4–6  → +3 | 7–10 → +2 | 11+ → +1
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][CombatLesson]";

  const LESSON_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Elesis/Chivalry.png";

  // ---------------------------------------------------------------------------
  // Bonus formula
  // ---------------------------------------------------------------------------
  function _calcBonus(teacherTotal, targetTotal) {
    const d = Math.abs(teacherTotal - targetTotal);
    if (d <= 1)  return 5;
    if (d <= 3)  return 4;
    if (d <= 6)  return 3;
    if (d <= 10) return 2;
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("combat_lesson", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Resolve party; build allies list (exclude teacher)
        const party = await CAMP.Party.resolve();
        const allies = party
          .filter(e => e.actorId !== actor.id)
          .map(e => ({
            id:  e.actorId,
            name: e.actor.name,
            img: _getTokenImg(e.actor),
          }));

        if (!allies.length) {
          ui.notifications?.warn("Combat Lesson: no other party members to teach.");
          return;
        }

        // 2 — Broadcast START; GM sees it directly
        CAMP.Socket.broadcast(CAMP.MSG.COMBAT_LESSON_START, {
          actorId:   actor.id,
          actorName: actor.name,
          allies,
        });
        CAMP.CombatLessonUI?.show(actor.id, allies);

        await new Promise(r => setTimeout(r, 300));

        // 3 — Wait for owner to pick a target
        const targetActorId = await _waitForTarget(actor);
        const targetActor   = game.actors?.get(targetActorId);
        if (!targetActor) {
          console.warn(TAG, "Target actor not found:", targetActorId);
          return;
        }

        // 4 — Broadcast rolling phase (IDs only — numbers not yet computed)
        CAMP.Socket.broadcast(CAMP.MSG.COMBAT_LESSON_RESULT, {
          actorId:       actor.id,
          targetActorId: targetActorId,
        });
        CAMP.CombatLessonUI?.showRolling(actor.id, targetActorId);

        // 5 — Silent rolls (GM-side): teacher MIG+INS, target INS+MIG
        const CR = globalThis.ONI?.CheckRequester;
        let teacherTotal, targetTotal;
        if (CR) {
          const [tr, tg] = await Promise.all([
            CR.requestOne(actor,       { mode: "silent", attrA: "MIG", attrB: "INS", postChat: false }),
            CR.requestOne(targetActor, { mode: "silent", attrA: "INS", attrB: "MIG", postChat: false }),
          ]);
          teacherTotal = tr?.total ?? 0;
          targetTotal  = tg?.total ?? 0;
        } else {
          // Fallback: raw dice if CheckRequester isn't loaded yet
          console.warn(TAG, "CheckRequester not available — using raw Roll fallback.");
          const rollTwo = async (attr1, attr2, a) => {
            const props = a.system?.props ?? {};
            const dA = parseInt(props[`${attr1.toLowerCase()}_current`]) || 8;
            const dB = parseInt(props[`${attr2.toLowerCase()}_current`]) || 8;
            const rA = (await (new Roll(`1d${dA}`)).evaluate()).total;
            const rB = (await (new Roll(`1d${dB}`)).evaluate()).total;
            return rA + rB;
          };
          [teacherTotal, targetTotal] = await Promise.all([
            rollTwo("MIG", "INS", actor),
            rollTwo("INS", "MIG", targetActor),
          ]);
        }

        // Small pause so clients finish transition to rolling stage
        await new Promise(r => setTimeout(r, 800));

        // 6 — Compute bonus
        const bonus = _calcBonus(teacherTotal, targetTotal);
        console.debug(TAG, `Teacher: ${teacherTotal}, Target: ${targetTotal}, Bonus: +${bonus}`);

        // 7 — Broadcast full result; GM applies directly
        CAMP.Socket.broadcast(CAMP.MSG.COMBAT_LESSON_RESULT, {
          actorId:       actor.id,
          targetActorId: targetActorId,
          teacherTotal,
          targetTotal,
          bonus,
        });
        CAMP.CombatLessonUI?.applyResult(actor.id, targetActorId, teacherTotal, targetTotal, bonus);

        // 8 — Apply AE to target (remove any stale one first)
        const existing = targetActor.effects.find(
          e => e.flags?.[MODULE_ID]?.combatLessonBonus != null
        );
        if (existing) await existing.delete();

        await targetActor.createEmbeddedDocuments("ActiveEffect", [{
          name:        "Combat Lesson",
          img:         LESSON_ICON,
          description: `Once before the next rest, after making an Accuracy Check or a Magic Check for an offensive spell, you may add +${bonus} to the Result of the Check.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:       1,
              combatLessonBonus:     bonus,
              combatLessonTeacherId: actor.id,
            },
          },
        }]);

        // 9 — Chat announcement
        await _postChatResult(actor, targetActor, teacherTotal, targetTotal, bonus);

        // 10 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 11 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.COMBAT_LESSON_DONE, { actorId: actor.id });
        CAMP.CombatLessonUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForTarget — GM awaits owner's target selection
  // ---------------------------------------------------------------------------
  function _waitForTarget(actor) {
    return new Promise(resolve => {
      CAMP.CombatLessonUI ??= {};
      CAMP.CombatLessonUI.targetResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.CombatLessonUI.targetResolvers[actor.id]) {
          console.warn(TAG, "Target timeout — auto-picking first ally for", actor.name);
          delete CAMP.CombatLessonUI.targetResolvers[actor.id];
          const party = CAMP.Party.resolve().then(p => {
            const ally = p.find(e => e.actorId !== actor.id);
            resolve(ally?.actorId ?? "");
          });
        }
      }, 60_000);

      CAMP.CombatLessonUI.targetResolvers[actor.id] = (targetActorId) => {
        clearTimeout(timer);
        resolve(targetActorId);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForProceed — GM awaits owner's "Click to Proceed"
  // ---------------------------------------------------------------------------
  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.CombatLessonUI ??= {};
      CAMP.CombatLessonUI.proceedResolvers ??= {};
      CAMP.CombatLessonUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Token image helper (mirrors CheckRequester)
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
  async function _postChatResult(teacher, target, teacherTotal, targetTotal, bonus) {
    const bonusColor = bonus >= 4 ? "#c8a84b" : bonus >= 3 ? "#3a7a35" : "#7a5010";
    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${LESSON_ICON}" style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${teacher.name} — Combat Lesson
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Teaching <strong>${target.name}</strong>
            </div>
            <div style="font-size:.85em;margin-top:3px;opacity:.85;">
              ${teacher.name} rolled <strong>${teacherTotal}</strong> &nbsp;·&nbsp;
              ${target.name} rolled <strong>${targetTotal}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${bonusColor};">
              Combat Lesson Bonus: +${bonus}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              Once before the next rest, ${target.name} may add +${bonus} to an Accuracy or
              offensive Magic Check result.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-cl-chat-${msg.id}`;
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

  console.debug(TAG, "Combat Lesson activity loaded.");
})();
