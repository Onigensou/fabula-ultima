// ============================================================================
// Camp Activity — Pep Talk
// Target: One ally
//
// Minigame: Pop Quiz
//   The target builds 3 custom topics (each with 3 answer tiers).
//   The owner picks an answer for each topic. Score drives the MP multiplier.
//
// Effect: Once before the next rest, when the target recovers MP, they may
//         multiply the amount recovered based on minigame performance.
//   Low  (0–2 pts): × 1.5  (base + 50% bonus)
//   Std  (3–4 pts): × 2
//   High (5–6 pts): × 3
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][PepTalk]";

  const PEP_TALK_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Ain/EEPassive1.png";

  // Grade thresholds (max score: 6)
  function _calcGrade(score) {
    if (score >= 5) return "high";
    if (score >= 3) return "standard";
    return "low";
  }

  function _gradeMultiplier(grade) {
    if (grade === "high")     return 3;
    if (grade === "standard") return 2;
    return 1.5;
  }

  function _gradeLabel(grade) {
    if (grade === "high")     return "They felt completely understood!";
    if (grade === "standard") return "They felt genuinely heard.";
    return "They appreciated the effort…";
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    console.log(TAG, "ready hook fired — registering pep_talk");
    CAMP.ActivityRegistry?.register("pep_talk", {
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
          ui.notifications?.warn("Pep Talk: no other party members to target.");
          return;
        }

        // 2 — Play activity-start SFX
        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // 3 — Broadcast START (ally picker); GM shows directly
        CAMP.Socket.broadcast(CAMP.MSG.PEP_TALK_START, {
          actorId:   actor.id,
          actorName: actor.name,
          allies,
        });
        CAMP.PepTalkUI?.show(actor.id, actor.name, allies);

        await new Promise(r => setTimeout(r, 300));

        // 4 — Wait for owner to pick target
        const targetActorId = await _waitForTarget(actor);
        const targetActor   = game.actors?.get(targetActorId);
        if (!targetActor) {
          console.warn(TAG, "Target actor not found:", targetActorId);
          return;
        }

        // 5 — Broadcast QUIZ_BUILD; GM shows quiz-builder state directly
        CAMP.Socket.broadcast(CAMP.MSG.PEP_TALK_QUIZ_BUILD, {
          actorId:         actor.id,
          actorName:       actor.name,
          targetActorId,
          targetActorName: targetActor.name,
          targetImg:       _getTokenImg(targetActor),
          ownerImg:        _getTokenImg(actor),
        });
        CAMP.PepTalkUI?.showQuizBuild(actor.id, actor.name, targetActorId, targetActor.name, _getTokenImg(targetActor), _getTokenImg(actor));

        await new Promise(r => setTimeout(r, 300));

        // 6 — Wait for the target's player to build and submit 3 topics
        const topics = await _waitForQuizReady(actor);
        console.debug(TAG, "Quiz received:", topics);

        // 7 — Run 3 questions
        let totalScore = 0;
        for (let q = 0; q < 3; q++) {
          const topic = topics[q];

          // Broadcast question to all; GM shows directly
          CAMP.Socket.broadcast(CAMP.MSG.PEP_TALK_QUESTION, {
            actorId:   actor.id,
            targetActorId,
            q,
            topic,
          });
          CAMP.PepTalkUI?.showQuestion(actor.id, targetActorId, q, topic);

          await new Promise(r => setTimeout(r, 300));

          // Wait for owner's answer
          const answerIdx = await _waitForAnswer(actor);
          const pts       = topic.skip ? 0 : (topic.choices?.[answerIdx]?.pts ?? 0);
          totalScore += pts;

          console.debug(TAG, `Q${q + 1}: answer=${answerIdx}, pts=${pts}, total=${totalScore}`);

          // Broadcast per-question result to all; GM shows directly
          CAMP.Socket.broadcast(CAMP.MSG.PEP_TALK_Q_RESULT, {
            actorId:      actor.id,
            targetActorId,
            q,
            answerIdx,
            pts,
            totalScore,
          });
          CAMP.PepTalkUI?.showQResult(actor.id, targetActorId, q, answerIdx, pts, totalScore);

          // Let reaction animation breathe before next question
          await new Promise(r => setTimeout(r, 2200));
        }

        // 8 — Compute grade
        const grade = _calcGrade(totalScore);
        console.debug(TAG, `Final score: ${totalScore}/6, grade: ${grade}`);

        // 9 — Apply / replace AE on target
        const existing = targetActor.effects.find(
          e => e.flags?.[MODULE_ID]?.pepTalkGrade != null
        );
        if (existing) await existing.delete();

        const multiplier = _gradeMultiplier(grade);
        await targetActor.createEmbeddedDocuments("ActiveEffect", [{
          name:        "Pep Talk",
          img:         PEP_TALK_ICON,
          description: `Once before the next rest, when you recover Mind Points, you may multiply the amount recovered by ${multiplier === 1.5 ? "1.5" : multiplier}.`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges: 1,
              pepTalkGrade:    grade,
              pepTalkCasterId: actor.id,
            },
          },
        }]);

        // 10 — Broadcast final result to all clients
        CAMP.Socket.broadcast(CAMP.MSG.PEP_TALK_RESULT, {
          actorId:         actor.id,
          actorName:       actor.name,
          targetActorId,
          targetActorName: targetActor.name,
          totalScore,
          grade,
        });
        CAMP.PepTalkUI?.applyResult(actor.id, targetActorId, totalScore, grade);

        // 11 — Post chat announcement
        await _postChatResult(actor, targetActor, totalScore, grade);

        // 12 — Wait for owner to click "Click to Proceed"
        await _waitForProceed(actor);

        // 13 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.PEP_TALK_DONE, { actorId: actor.id });
        CAMP.PepTalkUI?.hide();
      },
    });

    // -------------------------------------------------------------------------
    // In-combat MP recovery intercept
    // When the target's MP increases and a pepTalkGrade AE is present,
    // cancel the update and ask the target's owner if they want the bonus.
    // -------------------------------------------------------------------------
    Hooks.on("preUpdateActor", (actor, changes, _options, _userId) => {
      if (!game.user?.isGM) return;
      if (!changes.system?.props) return;

      const newMpRaw = changes.system.props.current_mp;
      if (newMpRaw === undefined) return;

      const newMp  = parseInt(newMpRaw);
      const oldMp  = parseInt(actor.system?.props?.current_mp) || 0;
      const delta  = newMp - oldMp;
      if (delta <= 0) return;

      const ae = actor.effects.find(e => e.flags?.[MODULE_ID]?.pepTalkGrade != null);
      if (!ae) return;

      const grade      = ae.flags[MODULE_ID].pepTalkGrade;
      const multiplier = _gradeMultiplier(grade);
      const maxMp      = actor.system?.props?.max_mp ?? 9999;

      const ownerUserId = _getOwnerUserId(actor);
      const targetId    = ownerUserId ?? game.users?.find(u => u.isGM && u.active)?.id;
      if (!targetId) return;

      const choicePayload = {
        actorId:       actor.id,
        actorName:     actor.name,
        delta,
        grade,
        multiplier,
        aeId:          ae.id,
        targetUserId:  targetId,
        originalNewMp: newMp,
        maxMp,
        currentMp:     oldMp,
      };

      // Cancel original update; dialog callback applies the appropriate one
      CAMP.Socket.emit(CAMP.MSG.PEP_TALK_CHOICE_REQUEST, choicePayload);
      // emit doesn't echo back to GM — call directly if GM is the owner
      if (targetId === game.user?.id) {
        _handleChoiceRequestLocally(choicePayload);
      }

      return false; // cancel the original preUpdateActor
    });
  });

  // ---------------------------------------------------------------------------
  // In-combat choice — called on the GM client when GM owns the target actor
  // ---------------------------------------------------------------------------
  function _handleChoiceRequestLocally({ actorId, delta, multiplier, aeId, originalNewMp, maxMp, currentMp }) {
    const actor   = game.actors?.get(actorId);
    if (!actor) return;
    const boosted = Math.floor(delta * multiplier);
    const label   = multiplier === 1.5 ? "×1.5" : `×${multiplier}`;
    const cap     = maxMp ?? actor.system?.props?.max_mp ?? 9999;
    const cur     = currentMp ?? (parseInt(actor.system?.props?.current_mp) || 0);

    Dialog.confirm({
      title:   "Pep Talk",
      content: `<p><strong>${actor.name}</strong> is about to recover <strong>${delta} MP</strong>.<br>Use <strong>Pep Talk</strong> to multiply that by <strong>${label}</strong>, recovering <strong>${boosted} MP</strong> instead?</p>`,
      yes: async () => {
        const finalMp = Math.min(cur + boosted, cap);
        await actor.update({ "system.props.current_mp": String(finalMp) });
        const ae = actor.effects.get(aeId);
        if (ae) await ae.delete();
      },
      no: async () => {
        // Re-apply the original update that was cancelled
        if (originalNewMp !== undefined) {
          await actor.update({ "system.props.current_mp": String(originalNewMp) });
        }
        const ae = actor.effects.get(aeId);
        if (ae) await ae.delete();
      },
      defaultYes: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Pending resolver helpers
  // ---------------------------------------------------------------------------

  function _waitForTarget(actor) {
    return new Promise(resolve => {
      CAMP.PepTalkUI ??= {};
      CAMP.PepTalkUI.targetResolvers ??= {};
      CAMP.PepTalkUI.targetResolvers[actor.id] = resolve;
    });
  }

  function _waitForQuizReady(actor) {
    return new Promise(resolve => {
      CAMP.PepTalkUI ??= {};
      CAMP.PepTalkUI.quizReadyResolvers ??= {};
      CAMP.PepTalkUI.quizReadyResolvers[actor.id] = resolve;
    });
  }

  function _waitForAnswer(actor) {
    return new Promise(resolve => {
      CAMP.PepTalkUI ??= {};
      CAMP.PepTalkUI.answerResolvers ??= {};
      CAMP.PepTalkUI.answerResolvers[actor.id] = resolve;
    });
  }

  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.PepTalkUI ??= {};
      CAMP.PepTalkUI.proceedResolvers ??= {};
      CAMP.PepTalkUI.proceedResolvers[actor.id] = resolve;
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

  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(caster, target, totalScore, grade) {
    const multiplier = _gradeMultiplier(grade);
    const multLabel  = multiplier === 1.5 ? "×1.5 (50% bonus)" : `×${multiplier}`;
    const gradeColor =
      grade === "high"     ? "#c8a84b" :
      grade === "standard" ? "#3a7a35" :
                             "#7a5010";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${PEP_TALK_ICON}"
               style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${caster.name} — Pep Talk
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Target: <strong>${target.name}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${gradeColor};">
              Score: ${totalScore}/6 — MP Multiplier: ${multLabel}
            </div>
            <div style="font-size:.8em;margin-top:2px;opacity:.7;font-style:italic;">
              ${_gradeLabel(grade)}
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              Once before the next rest, ${target.name} may multiply their MP recovery by ${multiplier === 1.5 ? "1.5" : multiplier}.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-pt-chat-${msg.id}`;
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

  console.debug(TAG, "Pep Talk activity loaded.");
})();
