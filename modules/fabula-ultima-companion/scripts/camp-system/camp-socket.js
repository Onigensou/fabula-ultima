// ============================================================================
// Camp System — Socket Handler
//
// All camp messages share the raw game.socket channel used by other systems
// (module.fabula-ultima-companion). Camp messages are identified by their
// CAMP_* type prefix so they don't collide with DP system messages.
//
// Architecture:
//  - Players emit requests to the GM (TOGGLE_READY, LOCK_ACTIVITY, etc.)
//  - GM processes requests, updates world settings, Foundry broadcasts
//    updateSetting to all clients automatically.
//  - Hover state is ephemeral: broadcast to all directly (no persistence).
// ============================================================================
(() => {
  const CAMP    = globalThis.CampSystem ??= {};
  const TAG     = "[CampSystem][Socket]";
  const GUARD   = "__ONI_CAMP_SOCKET__";

  CAMP.Socket = {
    // ── Emit a request to the GM ──────────────────────────────────────────
    emit(type, payload = {}) {
      game.socket.emit(CAMP.SOCKET_CH, { type, payload });
    },

    // ── Broadcast to all clients (GM only) ───────────────────────────────
    broadcast(type, payload = {}) {
      if (!game.user?.isGM) return;
      game.socket.emit(CAMP.SOCKET_CH, { type, payload });
    },

    // ── Install listener (called on ready) ───────────────────────────────
    setup() {
      if (window[GUARD]) return;
      window[GUARD] = true;

      game.socket.on(CAMP.SOCKET_CH, async (msg) => {
        const { type, payload } = msg ?? {};
        if (!type?.startsWith("CAMP_")) return; // not our message

        // ── Ephemeral: hover (any client, processed by all) ──────────────
        if (type === CAMP.MSG.HOVER_ACTIVITY) {
          CAMP.ActivitySelectUI?.onRemoteHover?.(payload?.actorId, payload?.activityKey);
          return;
        }

        // ── Exploration roulette (any client, processed by all) ──────────
        if (type === CAMP.MSG.EXPLORATION_START) {
          CAMP.ExplorationUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.EXPLORATION_DONE) {
          CAMP.ExplorationUI?.hide(payload?.actorId);
          return;
        }
        // Result processed on all clients — syncs GM spectator view
        if (type === CAMP.MSG.EXPLORATION_RESULT) {
          CAMP.ExplorationUI?.applyResult(payload?.actorId, payload?.roll);
          if (game.user?.isGM) CAMP.ExplorationUI?.resolveRoll(payload?.actorId, payload?.roll);
          return;
        }
        // Owner signals ready to dismiss — GM only resolves the proceed gate
        if (type === CAMP.MSG.EXPLORATION_PROCEED) {
          if (game.user?.isGM) CAMP.ExplorationUI?.resolveProceed(payload?.actorId);
          return;
        }

        // ── Cartography Snake minigame (GM → all, owner → all/GM) ───────
        if (type === CAMP.MSG.CARTOGRAPHY_START) {
          CAMP.CartographyUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.CARTOGRAPHY_BEGIN) {
          CAMP.CartographyUI?.spectateBegin(payload?.actorId);
          return;
        }
        if (type === CAMP.MSG.CARTOGRAPHY_TICK) {
          CAMP.CartographyUI?.onTick(payload);
          return;
        }
        if (type === CAMP.MSG.CARTOGRAPHY_RESULT && payload?.charges != null) {
          CAMP.CartographyUI?.applyResult(payload.actorId, payload.score, payload.hits, payload.charges);
          return;
        }
        if (type === CAMP.MSG.CARTOGRAPHY_DONE) {
          CAMP.CartographyUI?.hide();
          return;
        }

        // ── Daydream minigame (GM → all, owner → GM) ─────────────────────
        if (type === CAMP.MSG.DAYDREAM_START) {
          CAMP.DaydreamUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.DAYDREAM_BEGIN) {
          CAMP.DaydreamUI?.spectateBegin(payload?.actorId);
          return;
        }
        if (type === CAMP.MSG.DAYDREAM_HIT) {
          CAMP.DaydreamUI?.onHit(payload?.success);
          return;
        }
        if (type === CAMP.MSG.DAYDREAM_RESULT && payload?.reduction != null) {
          // Full result from GM — reveal phase
          CAMP.DaydreamUI?.applyResult(payload.actorId, payload.score, payload.reduction);
          return;
        }
        if (type === CAMP.MSG.DAYDREAM_DONE) {
          CAMP.DaydreamUI?.hide();
          return;
        }

        // ── Combat Lesson minigame (GM → all, owner → GM) ────────────────
        if (type === CAMP.MSG.COMBAT_LESSON_START) {
          CAMP.CombatLessonUI?.show(payload?.actorId, payload?.allies);
          return;
        }
        if (type === CAMP.MSG.COMBAT_LESSON_RESULT) {
          if (payload?.bonus != null) {
            // Full result — reveal phase
            CAMP.CombatLessonUI?.applyResult(
              payload.actorId, payload.targetActorId,
              payload.teacherTotal, payload.targetTotal, payload.bonus
            );
          } else {
            // IDs only — rolling phase
            CAMP.CombatLessonUI?.showRolling(payload?.actorId, payload?.targetActorId);
          }
          return;
        }
        if (type === CAMP.MSG.COMBAT_LESSON_DONE) {
          CAMP.CombatLessonUI?.hide();
          return;
        }

        // ── Magic Lesson minigame (GM → all, owner → GM) ─────────────────
        if (type === CAMP.MSG.MAGIC_LESSON_START) {
          CAMP.MagicLessonUI?.show(payload?.actorId, payload?.allies);
          return;
        }
        if (type === CAMP.MSG.MAGIC_LESSON_RESULT) {
          if (payload?.usages != null) {
            // Full result — reveal phase
            CAMP.MagicLessonUI?.applyResult(
              payload.actorId, payload.targetActorId,
              payload.spellName, payload.spellImg,
              payload.teacherTotal, payload.targetTotal, payload.usages
            );
          } else if (payload?.spellName != null) {
            // Spell chosen — rolling phase
            CAMP.MagicLessonUI?.showRolling(
              payload.actorId, payload.targetActorId, payload.spellName, payload.spellImg
            );
          } else {
            // Target chosen — spell-pick phase
            CAMP.MagicLessonUI?.showSpellPick(payload?.actorId, payload?.targetActorId, payload?.spells);
          }
          return;
        }
        if (type === CAMP.MSG.MAGIC_LESSON_DONE) {
          CAMP.MagicLessonUI?.hide();
          return;
        }

        // ── Double Portion minigame (GM → all, owner → GM) ───────────────
        if (type === CAMP.MSG.DOUBLE_PORTION_START) {
          CAMP.DoublePortionUI?.show(payload?.actorId, payload?.allies);
          return;
        }
        if (type === CAMP.MSG.DOUBLE_PORTION_MINIGAME) {
          CAMP.DoublePortionUI?.showArena(payload?.actorId, payload?.targetActorId);
          return;
        }
        if (type === CAMP.MSG.DOUBLE_PORTION_GAME_STATE) {
          CAMP.DoublePortionUI?.onGameState(payload);
          return;
        }
        if (type === CAMP.MSG.DOUBLE_PORTION_RESULT && payload?.grade != null) {
          // Full result from GM — reveal phase
          CAMP.DoublePortionUI?.applyResult(
            payload.actorId, payload.targetActorId, payload.grade, payload.multiplier
          );
          return;
        }
        if (type === CAMP.MSG.DOUBLE_PORTION_DONE) {
          CAMP.DoublePortionUI?.hide();
          return;
        }

        // ── Massage minigame (GM → all, owner → GM) ──────────────────────
        if (type === CAMP.MSG.MASSAGE_START) {
          CAMP.MassageUI?.show(payload?.actorId, payload?.allies);
          return;
        }
        if (type === CAMP.MSG.MASSAGE_MINIGAME) {
          CAMP.MassageUI?.showArena(payload?.actorId, payload?.targetActorId);
          return;
        }
        if (type === CAMP.MSG.MASSAGE_BEGIN) {
          CAMP.MassageUI?.spectateBegin(payload?.actorId);
          return;
        }
        if (type === CAMP.MSG.MASSAGE_HIT) {
          CAMP.MassageUI?.onHit(payload);
          return;
        }
        if (type === CAMP.MSG.MASSAGE_RESULT && payload?.reduction != null) {
          CAMP.MassageUI?.applyResult(payload.actorId, payload.score, payload.reduction);
          return;
        }
        if (type === CAMP.MSG.MASSAGE_DONE) {
          CAMP.MassageUI?.hide();
          return;
        }

        // ── Training minigame (Timing Gauge) ─────────────────────────────
        if (type === CAMP.MSG.TRAINING_START) {
          CAMP.TrainingUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.TRAINING_BEGIN) {
          CAMP.TrainingUI?.spectateBegin(payload?.actorId);
          return;
        }
        if (type === CAMP.MSG.TRAINING_HIT) {
          CAMP.TrainingUI?.onHit(payload);
          return;
        }
        if (type === CAMP.MSG.TRAINING_RESULT && payload?.charges != null) {
          CAMP.TrainingUI?.applyResult(payload.actorId, payload.score, payload.charges);
          return;
        }
        if (type === CAMP.MSG.TRAINING_DONE) {
          CAMP.TrainingUI?.hide();
          return;
        }
        if (type === CAMP.MSG.TRAINING_CHOICE_REQUEST) {
          CAMP.TrainingUI?.onChoiceRequest(payload);
          return;
        }

        // ── Sleep Soundly minigame (Radial Dream Protector) ──────────────
        if (type === CAMP.MSG.SLEEP_SOUNDLY_START) {
          CAMP.SleepSoundlyUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.SLEEP_SOUNDLY_BEGIN) {
          CAMP.SleepSoundlyUI?.spectateBegin(payload);
          return;
        }
        if (type === CAMP.MSG.SLEEP_SOUNDLY_HIT) {
          CAMP.SleepSoundlyUI?.onHit(payload);
          return;
        }
        if (type === CAMP.MSG.SLEEP_SOUNDLY_RESULT && payload?.charges != null) {
          CAMP.SleepSoundlyUI?.applyResult(payload.actorId, payload.score, payload.charges);
          return;
        }
        if (type === CAMP.MSG.SLEEP_SOUNDLY_DONE) {
          CAMP.SleepSoundlyUI?.hide();
          return;
        }

        // ── Gathering minigame (4×4 grid ingredient collector) ────────────
        if (type === CAMP.MSG.GATHERING_START) {
          CAMP.GatheringUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.GATHERING_BEGIN) {
          CAMP.GatheringUI?.spectateBegin(payload?.actorId);
          return;
        }
        if (type === CAMP.MSG.GATHERING_GAME_STATE) {
          CAMP.GatheringUI?.onGameState(payload);
          return;
        }
        if (type === CAMP.MSG.GATHERING_RESULT && payload?.grade != null) {
          // Full result from GM — reveal phase
          CAMP.GatheringUI?.applyResult(payload.actorId, payload.grade, payload.taste ?? null);
          return;
        }
        if (type === CAMP.MSG.GATHERING_DONE) {
          CAMP.GatheringUI?.hide();
          return;
        }

        // ── Midnight Oil minigame (Lamp Keeper) ──────────────────────────
        if (type === CAMP.MSG.MIDNIGHT_OIL_START) {
          CAMP.MidnightOilUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.MIDNIGHT_OIL_BEGIN) {
          CAMP.MidnightOilUI?.spectateBegin(payload);
          return;
        }
        if (type === CAMP.MSG.MIDNIGHT_OIL_STATE) {
          CAMP.MidnightOilUI?.onLampState(payload);
          return;
        }
        if (type === CAMP.MSG.MIDNIGHT_OIL_RESULT && payload?.label != null) {
          // Full result from GM — reveal phase
          CAMP.MidnightOilUI?.applyResult(
            payload.actorId, payload.score,
            payload.perfectRelights, payload.lampEverExtinguished,
          );
          return;
        }
        if (type === CAMP.MSG.MIDNIGHT_OIL_DONE) {
          CAMP.MidnightOilUI?.hide();
          return;
        }

        // ── Pep Talk minigame (Pop Quiz) ──────────────────────────────────
        if (type === CAMP.MSG.PEP_TALK_START) {
          CAMP.PepTalkUI?.show(payload?.actorId, payload?.actorName, payload?.allies);
          return;
        }
        if (type === CAMP.MSG.PEP_TALK_QUIZ_BUILD) {
          CAMP.PepTalkUI?.showQuizBuild(
            payload?.actorId, payload?.actorName,
            payload?.targetActorId, payload?.targetActorName,
            payload?.targetImg, payload?.ownerImg,
          );
          return;
        }
        if (type === CAMP.MSG.PEP_TALK_QUESTION) {
          CAMP.PepTalkUI?.showQuestion(
            payload?.actorId, payload?.targetActorId, payload?.q, payload?.topic,
          );
          return;
        }
        if (type === CAMP.MSG.PEP_TALK_Q_RESULT) {
          CAMP.PepTalkUI?.showQResult(
            payload?.actorId, payload?.targetActorId,
            payload?.q, payload?.answerIdx, payload?.pts, payload?.totalScore,
          );
          return;
        }
        if (type === CAMP.MSG.PEP_TALK_RESULT) {
          CAMP.PepTalkUI?.applyResult(
            payload?.actorId, payload?.targetActorId, payload?.totalScore, payload?.grade,
          );
          return;
        }
        if (type === CAMP.MSG.PEP_TALK_DONE) {
          CAMP.PepTalkUI?.hide();
          return;
        }
        if (type === CAMP.MSG.PEP_TALK_CHOICE_REQUEST) {
          CAMP.PepTalkUI?.onChoiceRequest(payload);
          return;
        }

        // ── Martial Practice minigame (Fruit Ninja) ──────────────────────
        if (type === CAMP.MSG.MARTIAL_PRACTICE_START) {
          CAMP.MartialPracticeUI?.show(payload?.actorId, payload?.actorName);
          return;
        }
        if (type === CAMP.MSG.MARTIAL_PRACTICE_BEGIN) {
          CAMP.MartialPracticeUI?.spectateBegin(payload);
          return;
        }
        if (type === CAMP.MSG.MARTIAL_PRACTICE_SLASH) {
          CAMP.MartialPracticeUI?.onSlash(payload);
          return;
        }
        if (type === CAMP.MSG.MARTIAL_PRACTICE_RESULT && payload?.multiValue != null) {
          CAMP.MartialPracticeUI?.applyResult(payload.actorId, payload.score, payload.multiValue);
          return;
        }
        if (type === CAMP.MSG.MARTIAL_PRACTICE_DONE) {
          CAMP.MartialPracticeUI?.hide();
          return;
        }

        // ── Fishing minigame (two-phase: Cast + Battle) ───────────────────
        if (type === CAMP.MSG.FISHING_START) {
          CAMP.FishingUI?.show(payload?.actorId, payload?.actorName, payload?.stats);
          return;
        }
        if (type === CAMP.MSG.FISHING_BEGIN) {
          CAMP.FishingUI?.spectateBegin(payload?.actorId);
          return;
        }
        if (type === CAMP.MSG.FISHING_CAST) {
          CAMP.FishingUI?.onCast(payload);
          return;
        }
        if (type === CAMP.MSG.FISHING_HIT) {
          CAMP.FishingUI?.onHit(payload);
          return;
        }
        if (type === CAMP.MSG.FISHING_RESULT && payload?.round != null) {
          // Full result from GM — round reveal
          CAMP.FishingUI?.applyResult(payload.actorId, payload.round, payload.fishName ?? null, payload.catches ?? []);
          return;
        }
        if (type === CAMP.MSG.FISHING_NEXT_ROUND) {
          CAMP.FishingUI?.beginRound(payload?.actorId, payload?.round, payload?.totalRounds);
          return;
        }
        if (type === CAMP.MSG.FISHING_DONE) {
          CAMP.FishingUI?.hide();
          return;
        }

        // ── Planning minigame (Pairing Quiz) ─────────────────────────────
        if (type === CAMP.MSG.PLANNING_START) {
          CAMP.PlanningUI?.show(payload?.actorId, payload?.actorName, payload?.allies);
          return;
        }
        if (type === CAMP.MSG.PLANNING_ARENA) {
          CAMP.PlanningUI?.showArena(
            payload?.actorId, payload?.actorName,
            payload?.targetActorId, payload?.targetActorName,
            payload?.targetImg, payload?.ownerImg,
          );
          return;
        }
        if (type === CAMP.MSG.PLANNING_QUESTION) {
          CAMP.PlanningUI?.showQuestion(payload?.actorId, payload?.targetActorId, payload?.q, payload?.question);
          return;
        }
        if (type === CAMP.MSG.PLANNING_REVEAL) {
          CAMP.PlanningUI?.showReveal(
            payload?.actorId, payload?.targetActorId,
            payload?.q, payload?.question,
            payload?.ownerChoice, payload?.targetChoice,
            payload?.match, payload?.score,
          );
          return;
        }
        if (type === CAMP.MSG.PLANNING_RESULT) {
          CAMP.PlanningUI?.applyResult(
            payload?.actorId, payload?.targetActorId, payload?.matchCount, payload?.bonus,
          );
          return;
        }
        if (type === CAMP.MSG.PLANNING_DONE) {
          CAMP.PlanningUI?.hide();
          return;
        }

        // ── GM-only: state mutation requests ────────────────────────────
        if (!game.user?.isGM) return;

        switch (type) {
          case CAMP.MSG.TOGGLE_READY:
            await _handleToggleReady(payload);
            break;

          case CAMP.MSG.LOCK_ACTIVITY:
            await _handleLockActivity(payload);
            break;

          case CAMP.MSG.UNLOCK_ACTIVITY:
            await _handleUnlockActivity(payload);
            break;

          case CAMP.MSG.CONFIRM_BOND:
            await _handleConfirmBond(payload);
            break;

          case CAMP.MSG.UNCONFIRM_BOND:
            await _handleUnconfirmBond(payload);
            break;

          case CAMP.MSG.ACTIVITY_DONE:
            await _handleActivityDone(payload);
            break;

          case CAMP.MSG.TOGGLE_SLEEP:
            await _handleToggleSleep(payload);
            break;

          case CAMP.MSG.TOGGLE_SET_OUT:
            await _handleToggleSetOut(payload);
            break;

          case CAMP.MSG.CARTOGRAPHY_RESULT:   // owner → GM: score submitted
            CAMP.CartographyUI?.resolveScore(payload?.actorId, payload?.score ?? 0, payload?.hits ?? 3);
            break;

          case CAMP.MSG.CARTOGRAPHY_PROCEED:
            CAMP.CartographyUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.DAYDREAM_RESULT:   // owner → GM: score submitted
            CAMP.DaydreamUI?.resolveScore(payload?.actorId, payload?.score);
            break;

          case CAMP.MSG.DAYDREAM_PROCEED:
            CAMP.DaydreamUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.COMBAT_LESSON_TARGET:
            CAMP.CombatLessonUI?.resolveTarget(payload?.actorId, payload?.targetActorId);
            break;

          case CAMP.MSG.COMBAT_LESSON_PROCEED:
            CAMP.CombatLessonUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.MAGIC_LESSON_TARGET:
            CAMP.MagicLessonUI?.resolveTarget(payload?.actorId, payload?.targetActorId);
            break;

          case CAMP.MSG.MAGIC_LESSON_SPELL:
            CAMP.MagicLessonUI?.resolveSpell(
              payload?.actorId, payload?.spellUuid, payload?.spellName, payload?.spellImg
            );
            break;

          case CAMP.MSG.MAGIC_LESSON_PROCEED:
            CAMP.MagicLessonUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.DOUBLE_PORTION_TARGET:
            CAMP.DoublePortionUI?.resolveTarget(payload?.actorId, payload?.targetActorId);
            break;

          case CAMP.MSG.DOUBLE_PORTION_RESULT:   // owner → GM: score submitted
            CAMP.DoublePortionUI?.resolveScore(payload?.actorId, {
              score: payload?.score ?? 0,
              wrong: payload?.wrong ?? 0,
            });
            break;

          case CAMP.MSG.DOUBLE_PORTION_PROCEED:
            CAMP.DoublePortionUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.MASSAGE_TARGET:
            CAMP.MassageUI?.resolveTarget(payload?.actorId, payload?.targetActorId);
            break;

          case CAMP.MSG.MASSAGE_RESULT:   // owner → GM: score submitted
            CAMP.MassageUI?.resolveScore(payload?.actorId, payload?.score ?? 0);
            break;

          case CAMP.MSG.MASSAGE_PROCEED:
            CAMP.MassageUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.TRAINING_RESULT:   // owner → GM: score submitted
            CAMP.TrainingUI?.resolveScore(payload?.actorId, payload?.score ?? 0);
            break;

          case CAMP.MSG.TRAINING_PROCEED:
            CAMP.TrainingUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.TRAINING_CHOICE_RESPONSE:
            CAMP.TrainingUI?.resolveChoice(payload?.requestId, payload?.prevent ?? false);
            break;

          case CAMP.MSG.SLEEP_SOUNDLY_RESULT:   // owner → GM: score submitted
            CAMP.SleepSoundlyUI?.resolveScore(payload?.actorId, payload?.score ?? 0);
            break;

          case CAMP.MSG.SLEEP_SOUNDLY_PROCEED:
            CAMP.SleepSoundlyUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.GATHERING_RESULT:   // owner → GM: score + taste submitted
            CAMP.GatheringUI?.resolveScore(payload?.actorId, {
              score: payload?.score ?? 0,
              taste: payload?.taste ?? null,
            });
            break;

          case CAMP.MSG.GATHERING_PROCEED:
            CAMP.GatheringUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.MIDNIGHT_OIL_RESULT:   // owner → GM: score data submitted
            CAMP.MidnightOilUI?.resolveScore(payload?.actorId, {
              score:               payload?.score ?? 0,
              perfectRelights:     payload?.perfectRelights ?? 0,
              lampEverExtinguished: payload?.lampEverExtinguished ?? true,
            });
            break;

          case CAMP.MSG.MIDNIGHT_OIL_PROCEED:
            CAMP.MidnightOilUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.PEP_TALK_TARGET:
            CAMP.PepTalkUI?.resolveTarget(payload?.actorId, payload?.targetActorId);
            break;

          case CAMP.MSG.PEP_TALK_QUIZ_READY:
            CAMP.PepTalkUI?.resolveQuizReady(payload?.actorId, payload?.topics);
            break;

          case CAMP.MSG.PEP_TALK_ANSWER:
            CAMP.PepTalkUI?.resolveAnswer(payload?.actorId, payload?.answerIdx);
            break;

          case CAMP.MSG.PEP_TALK_PROCEED:
            CAMP.PepTalkUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.PEP_TALK_CHOICE_RESPONSE: {
            const { actorId, aeId, boostedDelta, accepted, originalNewMp, maxMp, currentMp } = payload ?? {};
            if (!actorId) break;
            const _ptActor = game.actors?.get(actorId);
            if (!_ptActor) break;
            if (accepted) {
              const finalMp = Math.min((currentMp ?? 0) + (boostedDelta ?? 0), maxMp ?? 9999);
              await _ptActor.update({ "system.props.current_mp": String(finalMp) });
            } else if (originalNewMp !== undefined) {
              await _ptActor.update({ "system.props.current_mp": String(originalNewMp) });
            }
            const _ptAe = _ptActor.effects.get(aeId);
            if (_ptAe) await _ptAe.delete();
            break;
          }

          case CAMP.MSG.MARTIAL_PRACTICE_RESULT:   // owner → GM: score submitted
            CAMP.MartialPracticeUI?.resolveScore(payload?.actorId, payload?.score ?? 0);
            break;

          case CAMP.MSG.MARTIAL_PRACTICE_PROCEED:
            CAMP.MartialPracticeUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.FISHING_RESULT:   // owner → GM: round result submitted
            CAMP.FishingUI?.resolveRound(payload?.actorId, { fishName: payload?.fishName ?? null });
            break;

          case CAMP.MSG.FISHING_PROCEED:
            CAMP.FishingUI?.resolveProceed(payload?.actorId);
            break;

          case CAMP.MSG.PLANNING_TARGET:
            CAMP.PlanningUI?.resolveTarget(payload?.actorId, payload?.targetActorId);
            break;

          case CAMP.MSG.PLANNING_PICK_OWNER:
            CAMP.PlanningUI?.resolveOwnerPick(payload?.actorId, payload?.choiceIdx);
            break;

          case CAMP.MSG.PLANNING_PICK_TARGET:
            CAMP.PlanningUI?.resolveTargetPick(payload?.targetActorId, payload?.choiceIdx);
            break;

          case CAMP.MSG.PLANNING_PROCEED:
            CAMP.PlanningUI?.resolveProceed(payload?.actorId);
            break;

          // EXPLORATION_RESULT is handled in the all-clients section above
        }
      });

      console.debug(TAG, "Socket listener installed.");
    },
  };

  // ---------------------------------------------------------------------------
  // GM-side handlers
  // ---------------------------------------------------------------------------

  async function _handleToggleReady({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.toggleReady(userId);

    // In ACTIVITY_SELECT: auto-advance when all active players have confirmed
    if (CAMP.State.getPhase() === CAMP.PHASE.ACTIVITY_SELECT) {
      const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      const readyMap    = CAMP.State.getReady();
      if (activeUsers.length > 0 && activeUsers.every(u => readyMap[u.id])) {
        await CAMP.State.clearReady();
        await CAMP.State.setPhase(CAMP.PHASE.ACTIVITY_RESOLVE);
      }
    }
  }

  async function _handleLockActivity({ actorId, activityKey } = {}) {
    if (!actorId || !activityKey) return;
    const res = await CAMP.State.setLocked(actorId, activityKey);
    if (!res.ok) return; // taken by another actor
    // Check if all party members have locked
    const party    = await CAMP.Party.resolve();
    const actorIds = party.map(e => e.actorId);
    if (CAMP.State.isAllLocked(actorIds)) {
      await CAMP.State.setPhase(CAMP.PHASE.ACTIVITY_RESOLVE);
    }
  }

  async function _handleUnlockActivity({ actorId } = {}) {
    if (!actorId) return;
    await CAMP.State.clearLocked(actorId);
  }

  async function _handleUnconfirmBond({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.clearBondConfirmedForUser(userId);
    // Refresh the GM lobby dots
    const dots = document.getElementById("oni-camp-bond-wait-dots");
    if (dots) {
      const confirmed   = CAMP.State.getBondConfirmed();
      const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      dots.innerHTML = activeUsers.map(u => {
        const r = !!confirmed[u.id];
        return `<div class="oni-camp-lobby-dot ${r ? "ready" : ""}" title="${u.name}"></div>`;
      }).join("");
    }
  }

  async function _handleConfirmBond({ userId, summary } = {}) {
    if (!userId) return;
    await CAMP.State.setBondConfirmed(userId, summary);

    // Refresh the GM lobby dots if the wait overlay is showing
    const dots = document.getElementById("oni-camp-bond-wait-dots");
    if (dots) {
      const confirmed   = CAMP.State.getBondConfirmed?.() ?? {};
      const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      dots.innerHTML = activeUsers.map(u => {
        const r = !!confirmed[u.id];
        return `<div class="oni-camp-lobby-dot ${r ? "ready" : ""}" title="${u.name}"></div>`;
      }).join("");
    }

    // Auto-advance when all active players have confirmed
    const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
    if (activeUsers.length === 0 || CAMP.State.isAllBondConfirmed(activeUsers.map(u => u.id))) {
      await CAMP.State.setPhase(CAMP.PHASE.BOND_SUMMARY);
    }
  }

  async function _handleActivityDone({ actorId } = {}) {
    if (!actorId) return;
    await CAMP.State.markResolved(actorId);
    // Use the locked actor IDs from selections as the source of truth
    const sel = CAMP.State.getSelections();
    const lockedActorIds = Object.keys(sel).filter(id => sel[id]?.locked);
    if (lockedActorIds.length > 0 && CAMP.State.isAllResolved(lockedActorIds)) {
      await CAMP.State.clearResolved();
      await CAMP.State.setPhase(CAMP.PHASE.BOND_UPDATE);
    }
  }

  async function _handleToggleSleep({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.toggleSleepReady(userId);
  }

  async function _handleToggleSetOut({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.toggleSetOutReady(userId);
  }

  // Install on ready
  Hooks.once("ready", () => CAMP.Socket.setup());

  console.debug(TAG, "Socket module loaded.");
})();
