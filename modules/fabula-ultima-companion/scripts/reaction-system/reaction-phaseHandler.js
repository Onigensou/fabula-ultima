/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * This file is safe to load automatically from a module (runs once per client).
 * Generated: 2026-01-09T07:27:00
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.PhaseHandler";
    if (globalThis[KEY]) {
      console.log("[PhaseHandler] Already installed.");
      return;
    }
    globalThis[KEY] = true;

  /**
   * Macro: [DEMO] Phase Handler
   * Id: 7elGzvbTWt87mnD6
   * Folder: Reaction System
   * Type: script
   * Author: GM
   * Exported: 2026-01-09T07:11:26.456Z
   */
  // ============================================================================
  // PhaseHandler – ONI Reaction Phase broadcaster + logger (Foundry V12)
  // ============================================================================
  //
  // PURPOSE
  // -------
  // This script defines the "lifecycle phases" of combat for Oni's Reaction
  // System. It listens to Foundry's combat hooks, converts them into simple,
  // high-level phase events, and broadcasts them as:
  //
  //   ONI.emit("oni:reactionPhase", { trigger: "<phase_name>", ... })
  //
  // The goal is to give other scripts (like a future ReactionHandler) a clean
  // and consistent API for knowing WHERE in the round/turn flow the game is.
  //
  // ---------------------------------------------------------------------------
  // PHASES EMITTED BY THIS SCRIPT
  // ---------------------------------------------------------------------------
  //
  // All phases are emitted using the same event name:
  //
  //   eventName: "oni:reactionPhase"
  //   payload.trigger: one of the strings listed below
  //
  // 1) "start_of_conflict"
  //    --------------------
  //    - When it fires:
  //        * When combat first starts.
  //    - Foundry hook used:
  //        * Hooks.on("combatStart", ...)
  //    - Payload highlights:
  //        * combatId
  //        * sceneId
  //        * round (usually 1 at start)
  //        * turn  (whatever the system sets)
  //
  //    This marks the beginning of the entire battle. Useful for Reactions like
  //    "At the start of conflict, do X".
  //
  //
  // 2) "start_of_round"
  //    -----------------
  //    - When it fires:
  //        * At the beginning of EACH round (Round 1, Round 2, Round 3, ...).
  //    - Foundry hook used:
  //        * Hooks.on("combatRound", ...)
  //    - Payload highlights:
  //        * combatId
  //        * sceneId
  //        * round (the current round number)
  //        * turn  (whatever the system sets)
  //
  //    This marks the start of a round. Useful for Reactions like
  //    "At the start of the round, gain a buff".
  //
  //
  // 3) "end_of_round"
  //    ---------------
  //    - IMPORTANT: This is NOT tied directly to round number changes.
  //      Instead, it is computed based on Lancer Initiative activations.
  //
  //    - System assumptions:
  //        * The module "lancer-initiative" is active.
  //        * Each combatant may have flags:
  //            - flags["lancer-initiative"]["activations.max"]
  //            - flags["lancer-initiative"]["activations.value"]
  //          where:
  //            - "max"   = total actions/activations granted this round
  //            - "value" = remaining activations this round
  //
  //    - Logic for "end_of_round":
  //        1) Only consider rounds > 0.
  //        2) Look at ALL combatants that use Lancer activations (max > 0).
  //        3) If ANY of them still has value > 0  → round is NOT over.
  //        4) If ANY combatant is "currently acting" → round is NOT over.
  //             * "currently acting" is determined via:
  //                 - const turns = combat.turns
  //                 - const turnIndex = combat.turn
  //                 - const currentTurnId = turns[turnIndex].id
  //                 - isCurrent = (currentTurnId === combatant.id)
  //        5) ONLY when:
  //             * at least one combatant uses Lancer activations, AND
  //             * no one has remaining activations (value === 0 for all), AND
  //             * no one is currently acting
  //           → the round is considered finished, and "end_of_round" is emitted.
  //        6) We only emit "end_of_round" ONCE per round per combat
  //           (tracked by ONI_LAST_ENDED_ROUND).
  //
  //    - When it fires in code:
  //        * After any turn-change (inside updateCombat), we call:
  //              checkAndEmitEndOfRound(combat, userId)
  //
  //    - Payload highlights:
  //        * combatId
  //        * sceneId
  //        * roundEnded (the round we just finished)
  //        * roundNext  (roundEnded + 1)
  //
  //    This is the "true" end of the round for systems that behave like Lancer:
  //    everyone has spent their activation(s) AND nobody is currently taking a turn.
  //    Useful for Reactions like "At the end of the round, heal 5 HP".
  //    NOTE: There is NO "end_of_round" for Round 0, and we do NOT emit
  //    end_of_round at combat start.
  //
  //
  // 4) "start_of_turn"
  //    ----------------
  //    - When it fires:
  //        * Whenever the currently active combatant changes AND there IS a
  //          new active combatant.
  //    - Foundry hook used:
  //        * Hooks.on("updateCombat", ...) with "turn" in changed
  //          and using combat.combatant after the update.
  //    - Detection rule:
  //        * In updateCombat:
  //            - if "turn" changed AND combat.combatant is not null,
  //              we treat that as "start_of_turn" for that combatant.
  //
  //    - The script does NOT try to track "who ended" in this phase; it only
  //      cares that a new owner has the turn.
  //
  //    - Payload highlights:
  //        * combatId
  //        * sceneId
  //        * round
  //        * turn           (current turn index)
  //        * combatantId
  //        * combatantName
  //        * actorId / actorUuid
  //        * tokenId / tokenUuid
  //
  //    This is the clean signal to use for Reactions like
  //    "At the start of your turn, do X".
  //
  //
  // 5) "end_of_turn"
  //    --------------
  //    - When it fires:
  //        * Whenever "turn" changes and there is NO active combatant.
  //        * For example, in Lancer, when the X button is pressed and the actor
  //          finishes their turn, the module often clears the active combatant.
  //    - Foundry hook used:
  //        * Hooks.on("updateCombat", ...) with "turn" in changed
  //          and combat.combatant is null after the update.
  //
  //    - Note:
  //        * Because we are designing this to be generic, "end_of_turn" only
  //          guarantees that "someone's turn just ended, and now no one owns
  //          the turn". It does NOT always know exactly who that actor was.
  //        * (If needed in the future, we could extend this with more bookkeeping
  //           to identify the previous owner.)
  //
  //    - Payload highlights:
  //        * combatId
  //        * sceneId
  //        * round
  //        * (all combatant-related fields are null in the generic version)
  //
  //    This phase is useful for Reactions like
  //    "At the end of any turn, resolve lingering effects", or for detecting
  //    when the round might be ready to end (combined with activations logic).
  //
  //
  // ---------------------------------------------------------------------------
  // RELATIONSHIP TO OTHER REACTION TRIGGERS
  // ---------------------------------------------------------------------------
  //
  // This PhaseHandler ONLY emits the "lifecycle" phases listed above:
  //   - start_of_conflict
  //   - start_of_round
  //   - end_of_round
  //   - start_of_turn
  //   - end_of_turn
  //
  // Other parts of the system (e.g. CreateActionCard / CreateDamageCard)
  // also emit "oni:reactionPhase" events for combat-related triggers like:
  //   - "creature_performs_check"
  //   - "creature_is_targeted"
  //   - "creature_deals_damage"
  //   - "creature_takes_damage"
  //   - "creature_recovers_hp"
  //   - "creature_lose_mp"
  //   - "creature_recovers_mp"
  //
  // All of these share the SAME event name ("oni:reactionPhase") but have
  // different trigger strings. A future ReactionHandler can listen once:
  //
  //   Hooks.on("oni:reactionPhase", payload => {
  //     switch (payload.trigger) {
  //       case "start_of_turn":
  //       case "start_of_round":
  //       case "creature_deals_damage":
  //       case "creature_recovers_hp":
  //       case "creature_lose_mp":
  //       case "creature_recovers_mp":
  //         // etc...
  //     }
  //   });
  //
  //
  // ---------------------------------------------------------------------------
  // HOW TO USE THIS SCRIPT
  // ---------------------------------------------------------------------------
  //
  // 1) Load it as a world script or module script so it runs once when Foundry
  //    starts up.
  // 2) It installs:
  //      - The ONI.emit helper (if not already present).
  //      - All the combat hooks for the phases above.
  //      - A debug logger that prints EVERY oni:reactionPhase to the console.
  // 3) You can watch the Console in your browser while you:
  //      - Start combat
  //      - Advance rounds
  //      - Activate/deactivate turns (Lancer-style)
  //    to see a clear timeline of phases and verify everything is correct.
  // 4) Later, when you build the real ReactionHandler, you can treat this file
  //    as the "truth" for when each lifecycle phase begins and ends.
  //
  // NOTE (2026 update): combat-result triggers are now more specific on the
  // resource side as well. Other scripts may emit:
  //   - creature_takes_damage   (HP loss)
  //   - creature_recovers_hp    (HP gain)
  //   - creature_lose_mp        (MP loss)
  //   - creature_recovers_mp    (MP gain)
  // This PhaseHandler still only owns lifecycle phases; it does not emit those
  // combat-result triggers directly.
  //
  // ============================================================================


  // --- 1) ONI Custom Event Helper (from ONI_Custom_Events_HowTo) ---
  globalThis.ONI = globalThis.ONI ?? {};

  if (!ONI.emit) {
    /**
     * ONI.emit(eventName, payload?, options?)
     * By default sends both locally and across the world socket.
     */
    ONI.emit = function (eventName, payload = {}, { local = true, world = true } = {}) {
      if (local) Hooks.callAll(eventName, payload); // local subscribers
      if (world) game.socket.emit("world", { action: eventName, payload }); // broadcast
    };

    // Generic socket receiver to re-fan into Hooks
    if (!ONI._worldRx) {
      ONI._worldRx = (data) => {
        if (!data?.action) return;
        Hooks.callAll(data.action, data.payload);
      };
      game.socket.on("world", ONI._worldRx);
    }
  }

  // Small helper: build & emit a reactionPhase payload
  function emitReactionPhase(trigger, extra = {}) {
    if (!globalThis.ONI?.emit) return;

    // IMPORTANT (Module Mode):
    // - Only the GM should broadcast reaction phases.
    //   (Non-GM clients ignore phases and wait for GM offers via socket.)
    if (!game.user?.isGM) return;

    const payload = {
      trigger, // e.g. "start_of_round"
      timestamp: Date.now(),
      fromUserId: game.user.id,
      ...extra,
    };

    // Emit locally on the GM only (no world broadcast).
    // This avoids duplicate processing and reduces network spam.
    ONI.emit("oni:reactionPhase", payload, { local: true, world: false });
  }

  // ============================================================================
  // End-of-round bookkeeping for Lancer Initiative
  // - We will only emit "end_of_round" once per round per combat.
  // ============================================================================
  const ONI_LAST_ENDED_ROUND = {}; // { [combatId]: lastRoundNumber }

  /**
   * Check Lancer Initiative flags to see if the ROUND is truly over.
   *
   * Lancer fields (per combatant):
   *   - flags["lancer-initiative"]["activations.max"]   = max activations this round
   *   - flags["lancer-initiative"]["activations.value"] = remaining activations
   *
   * Round is considered ended when:
   *   * round > 0
   *   * At least one combatant uses Lancer activations (max > 0)
   *   * No combatant has value > 0  (no remaining activations)
   *   * No combatant is "currently acting"
   *       (based on combat.turn / combat.turns -> currentTurnId)
   */
  function checkAndEmitEndOfRound(combat, userId) {
    const MODULE = "lancer-initiative";
    const combatId = combat.id;
    const round = combat.round ?? 0;

    if (round <= 0) return; // round 0 isn't a "real" round yet

    const lastEnded = ONI_LAST_ENDED_ROUND[combatId] ?? 0;
    if (lastEnded >= round) {
      // We've already emitted end_of_round for this round.
      return;
    }

    // Determine who is "currently acting" based on combat.turn / combat.turns
    const turns = combat.turns ?? [];
    const turnIndex = Number.isInteger(combat.turn) ? combat.turn : -1;
    const currentTurnId =
      turnIndex >= 0 && turns[turnIndex] ? turns[turnIndex].id : null;

    let anyUsesLancer = false;
    let anyRemainingActivations = false;
    let anyCurrentlyActing = false;

    for (const c of combat.combatants) {
      const max = Number(c.getFlag(MODULE, "activations.max") ?? 0);
      const value = Number(c.getFlag(MODULE, "activations.value") ?? 0);
      const isCurrent = currentTurnId !== null && currentTurnId === c.id;

      // If this combatant doesn't use Lancer activations, skip for EOR logic.
      if (max <= 0) continue;

      anyUsesLancer = true;

      // If ANY combatant still has remaining activations this round, the round is not over.
      if (value > 0) {
        anyRemainingActivations = true;
      }

      // If ANY combatant is currently acting, the round is not over yet.
      if (isCurrent) {
        anyCurrentlyActing = true;
      }

      if (anyRemainingActivations || anyCurrentlyActing) {
        // No need to keep scanning; we already know the round is not over.
        break;
      }
    }

    // If no one uses Lancer Initiative activations at all, do nothing here.
    if (!anyUsesLancer) return;

    // If there's still at least one combatant with remaining activations,
    // or someone is currently acting, the round is not over.
    if (anyRemainingActivations) return;
    if (anyCurrentlyActing) return;

    // Otherwise: all Lancer-activation users are out of actions AND
    // no one is currently acting -> round is over.
    ONI_LAST_ENDED_ROUND[combatId] = round;

    console.log(
      "%c[PhaseHandler] DETECTED END OF ROUND via Lancer activations (no remaining + no one acting)",
      "color:#ffa726;font-weight:bold;",
      { combatId, round, userId }
    );

    emitReactionPhase("end_of_round", {
      kind: "lifecycle",
      phase: "end_of_round",
      combatId,
      sceneId: combat.scene?.id ?? combat.sceneId ?? null,
      roundEnded: round,
      roundNext: round + 1,
      userId,
    });
  }

  // ---------------------------------------------------------------------------
  // 2) Broadcasters for conflict / round / turn phases
  // ---------------------------------------------------------------------------

  // Start of conflict (when combat starts)
  Hooks.on("combatStart", (combat, ...args) => {
    try {
      emitReactionPhase("start_of_conflict", {
        kind: "lifecycle",
        phase: "start_of_conflict",
        combatId: combat.id,
        sceneId: combat.scene?.id ?? combat.sceneId ?? null,
        round: combat.round,
        turn: combat.turn,
      });
    } catch (err) {
      console.warn("[PhaseHandler] Error in combatStart broadcaster:", err);
    }
  });

  // Start of each round
  Hooks.on("combatRound", (combat, ...args) => {
    try {
      emitReactionPhase("start_of_round", {
        kind: "lifecycle",
        phase: "start_of_round",
        combatId: combat.id,
        sceneId: combat.scene?.id ?? combat.sceneId ?? null,
        round: combat.round,
        turn: combat.turn,
      });
    } catch (err) {
      console.warn("[PhaseHandler] Error in combatRound broadcaster:", err);
    }
  });

  // NOTE: We still do NOT use combatTurn for turn phases.
  // We rely entirely on updateCombat + combat.combatant, like your Turn-Change demo.

  // Start-of-turn / End-of-turn via updateCombat.
  Hooks.on("updateCombat", (combat, changed, options, userId) => {
    try {
      const hasRoundChange = Object.prototype.hasOwnProperty.call(changed, "round");
      const hasTurnChange = Object.prototype.hasOwnProperty.call(changed, "turn");

      // If neither round nor turn changed, nothing for us to do here.
      if (!hasTurnChange && !hasRoundChange) return;

      // --- Start / End of Turn (turn change via combat.combatant) -----------
      if (hasTurnChange) {
        const c = combat;
        const cmbt = c.combatant; // current turn owner after the update

        // If there *is* a combatant, we treat this as START OF TURN.
        if (cmbt) {
          const turnIndex = c.turn ?? 0;
          const round = c.round ?? 1;
          const name = cmbt.name ?? "(Unknown)";

          const actor = cmbt.actor;
          const tokenDoc = cmbt.token;
          const tokenId = tokenDoc?.id ?? cmbt.tokenId ?? null;
          const actorId = actor?.id ?? null;
          const actorUuid = actor?.uuid ?? null;
          const tokenUuid = tokenDoc?.uuid ?? tokenDoc?.document?.uuid ?? null;

          console.log(
            "%c[PhaseHandler] ENTER PHASE: start_of_turn",
            "color: #4caf50; font-weight: bold;",
            {
              combatId: c.id,
              round,
              turnIndex,
              combatantId: cmbt.id ?? null,
              combatantName: name,
              actorId,
              actorUuid,
              tokenId,
              tokenUuid,
              userId,
            }
          );

          emitReactionPhase("start_of_turn", {
            kind: "lifecycle",
            phase: "start_of_turn",
            combatId: c.id,
            sceneId: c.scene?.id ?? c.sceneId ?? null,
            round,
            turn: turnIndex,
            combatantId: cmbt.id ?? null,
            combatantName: name,
            actorId,
            actorUuid,
            tokenId,
            tokenUuid,
            userId,
          });
        }
        // If there is NO combatant (e.g. Lancer X button -> turn cleared),
        // we treat this as END OF TURN.
        else {
          const round = combat.round ?? 1;

          console.log(
            "%c[PhaseHandler] ENTER PHASE: end_of_turn",
            "color: #f44336; font-weight: bold;",
            {
              combatId: combat.id,
              round,
              // We don't really know "who ended" here generically, only that
              // there is now no active combatant.
              combatantId: null,
              combatantName: null,
              actorId: null,
              actorUuid: null,
              tokenId: null,
              tokenUuid: null,
              userId,
            }
          );

          emitReactionPhase("end_of_turn", {
            kind: "lifecycle",
            phase: "end_of_turn",
            combatId: combat.id,
            sceneId: combat.scene?.id ?? combat.sceneId ?? null,
            round,
            combatantId: null,
            combatantName: null,
            actorId: null,
            actorUuid: null,
            tokenId: null,
            tokenUuid: null,
            userId,
          });
        }

        // After any turn change, check whether the ROUND is now fully spent
        // according to Lancer Initiative activations + "no one currently acting".
        checkAndEmitEndOfRound(combat, userId);
      }
    } catch (err) {
      console.warn("[PhaseHandler] Error in updateCombat broadcaster:", err);
    }
  });

  // ---------------------------------------------------------------------------
  // 3) Debug listener: log ALL oni:reactionPhase events
  // ---------------------------------------------------------------------------
  if (!globalThis._oniPhaseLoggerInstalled) {
    globalThis._oniPhaseLoggerInstalled = true;

    Hooks.on("oni:reactionPhase", (payload) => {
      const trig = payload?.trigger ?? "unknown_trigger";
      console.log(
        `%c[PhaseHandler] Game entering reaction phase: ${trig}`,
        "color:#4fb3ff;font-weight:bold;",
        payload
      );
    });

    console.log("[PhaseHandler] oni:reactionPhase logger installed.");
  }
  })();
});
