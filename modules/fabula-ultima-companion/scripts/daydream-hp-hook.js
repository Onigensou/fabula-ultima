// ============================================================================
// Daydream HP Hook — "You May" HP-loss interception
//
// When an actor that carries the Daydream AE (daydreamReduction flag) is
// about to lose HP, the update is cancelled synchronously and a dialog is
// shown to the actor's owner.  The owner decides whether to apply the
// percentage reduction.  Afterward the update is re-submitted with the
// final HP value and the AE is consumed.
//
// Cross-client:
//   - If the GM initiates the damage AND a player owns the actor, the GM
//     sends CAMP_DAYDREAM_CHOICE_REQUEST via socket.  The player-client
//     shows the dialog and responds with CAMP_DAYDREAM_CHOICE_RESPONSE.
//   - If the owner's client initiates the damage (or owns the actor
//     without a separate GM initiating), the dialog appears locally.
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DaydreamHook]";
  const SOCKET_CH = `module.${MODULE_ID}`;

  const MSG_REQUEST  = "CAMP_DAYDREAM_CHOICE_REQUEST";
  const MSG_RESPONSE = "CAMP_DAYDREAM_CHOICE_RESPONSE";

  // Pending resolvers keyed by actorId (GM side only)
  const _choiceResolvers = new Map();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _readHp(src) {
    const v = foundry.utils.getProperty(src, "system.props.current_hp");
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function _getOwnerUserId(actor) {
    const hit = Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    });
    return hit?.[0] ?? null;
  }

  function _isActorOwner(actor) {
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ---------------------------------------------------------------------------
  // Core async handler (called after return false cancels the original update)
  // ---------------------------------------------------------------------------
  async function _handleInterception(actor, originalNewHp, ae) {
    const oldHp     = _readHp(actor);
    if (oldHp === null) return;

    const loss        = oldHp - originalNewHp;
    const reduction   = ae.flags?.[MODULE_ID]?.daydreamReduction ?? 50;
    const reducedLoss = Math.ceil(loss * (1 - reduction / 100));
    const reducedHp   = oldHp - reducedLoss;

    let accepted = false;

    if (_isActorOwner(actor)) {
      // Current client owns the actor — show dialog here
      accepted = await Dialog.confirm({
        title: "💭 Daydream",
        content: `
          <p style="margin:0 0 6px">
            <strong>${actor.name}</strong> is about to lose
            <strong>${loss}</strong> HP.
          </p>
          <p style="margin:0">
            Use <strong>Daydream</strong> to reduce the loss by
            <strong>${reduction}%</strong>
            &nbsp;(${loss} → ${reducedLoss} HP lost)?
          </p>
        `,
        defaultYes: true,
      });
    } else if (game.user?.isGM) {
      // GM initiated the damage but a player owns the actor
      const ownerUid  = _getOwnerUserId(actor);
      const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? "the player") : "the player";

      ui.notifications?.info(
        `Daydream: waiting for ${ownerName} to decide…`,
        { permanent: false, console: false }
      );

      game.socket.emit(SOCKET_CH, {
        type:    MSG_REQUEST,
        payload: { actorId: actor.id, loss, reduction, reducedLoss },
      });

      // Wait up to 30 s for player response
      accepted = await new Promise(resolve => {
        _choiceResolvers.set(actor.id, resolve);
        setTimeout(() => {
          if (_choiceResolvers.has(actor.id)) {
            _choiceResolvers.delete(actor.id);
            console.warn(TAG, "Choice timeout — defaulting to decline for", actor.name);
            resolve(false);
          }
        }, 30_000);
      });
    }
    // If neither owner nor GM (e.g., a random client), let through unmodified
    else {
      await actor.update(
        { "system.props.current_hp": originalNewHp },
        { daydreamProcessed: true }
      );
      return;
    }

    const finalHp = accepted ? reducedHp : originalNewHp;
    await actor.update(
      { "system.props.current_hp": finalHp },
      { daydreamProcessed: true }
    );

    // Consume the AE regardless of choice
    await ae.delete().catch(err => console.warn(TAG, "Could not delete AE:", err));
  }

  // ---------------------------------------------------------------------------
  // preUpdateActor hook
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {

    Hooks.on("preUpdateActor", (actor, change, options) => {
      // Skip our own re-submitted update
      if (options?.daydreamProcessed) return;

      const newHpRaw = foundry.utils.getProperty(change, "system.props.current_hp");
      if (newHpRaw === undefined) return;

      const oldHp = _readHp(actor);
      const newHp = Number(newHpRaw);
      if (!Number.isFinite(newHp) || oldHp === null || newHp >= oldHp) return;

      const ae = Array.from(actor.effects ?? []).find(
        e => e.flags?.[MODULE_ID]?.daydreamReduction != null
      );
      if (!ae) return;

      // Capture values before the hook frame expires
      const capturedActor = actor;
      const capturedNewHp = newHp;
      const capturedAE    = ae;

      // Async handling starts in the next microtask (after return false)
      Promise.resolve().then(() =>
        _handleInterception(capturedActor, capturedNewHp, capturedAE)
          .catch(err => console.error(TAG, "Interception error:", err))
      );

      return false; // cancel the original update synchronously
    });

    // ── Socket listener (choice request / response) ───────────────────────
    const GUARD = "__ONI_DAYDREAM_HOOK_SOCKET__";
    if (!window[GUARD]) {
      window[GUARD] = true;

      game.socket.on(SOCKET_CH, (msg) => {
        const { type, payload } = msg ?? {};
        if (!type) return;

        // Player receives choice request from GM
        if (type === MSG_REQUEST) {
          if (game.user?.isGM) return; // GM doesn't handle its own request
          const actor = game.actors?.get(payload?.actorId);
          if (!actor || !_isActorOwner(actor)) return;

          const { loss, reduction, reducedLoss } = payload ?? {};

          Dialog.confirm({
            title: "💭 Daydream",
            content: `
              <p style="margin:0 0 6px">
                <strong>${actor.name}</strong> is about to lose
                <strong>${loss}</strong> HP.
              </p>
              <p style="margin:0">
                Use <strong>Daydream</strong> to reduce the loss by
                <strong>${reduction}%</strong>
                &nbsp;(${loss} → ${reducedLoss} HP lost)?
              </p>
            `,
            defaultYes: true,
          }).then(accepted => {
            game.socket.emit(SOCKET_CH, {
              type:    MSG_RESPONSE,
              payload: { actorId: payload.actorId, accepted: !!accepted },
            });
          });
          return;
        }

        // GM receives player's choice response
        if (type === MSG_RESPONSE && game.user?.isGM) {
          const resolver = _choiceResolvers.get(payload?.actorId);
          if (resolver) {
            _choiceResolvers.delete(payload.actorId);
            resolver(!!payload.accepted);
          }
          return;
        }
      });
    }

    console.debug(TAG, "Daydream HP hook loaded.");
  });
})();
