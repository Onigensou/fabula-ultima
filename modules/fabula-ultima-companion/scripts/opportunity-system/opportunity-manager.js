/**
 * [ONI] Opportunity System — Manager
 * Core API for the Opportunity system. Installed at globalThis.ONI.OpportunitySystem.
 *
 * Trigger paths:
 *   - Action pipeline: opportunity-action-hook.js calls offer() on the attacker-owner's client
 *   - CheckRequester: cr-api.js calls processCheckCrits() on the GM client (awaited before reactions)
 *
 * Socket messages (OPP_ prefix on module.fabula-ultima-companion channel):
 *   OPP_OFFER     GM → all (targetUserId filter) — ask player to show picker
 *   OPP_PICKED    player → all (GM processes)    — player chose an option
 *   OPP_CANCELLED player → all (GM processes)    — player declined
 */
(() => {
  const TAG       = "[ONI][OpportunitySystem]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const GUARD     = "__ONI_OPPORTUNITY_MANAGER__";

  if (window[GUARD]) { console.debug(TAG, "Already installed."); return; }
  window[GUARD] = true;

  const MSG_OFFER     = "OPP_OFFER";
  const MSG_PICKED    = "OPP_PICKED";
  const MSG_CANCELLED = "OPP_CANCELLED";

  // ── Dependency shortcuts ─────────────────────────────────────────────────────
  const getConfig  = () => window["oni.OpportunityConfig"];
  const getDialog  = () => window["oni.OpportunityDialog"];
  const getChatCard = () => window["oni.OpportunityChatCard"];
  const getEffects = () => window["oni.OpportunityEffects"];

  // ── In-flight offer tracking ─────────────────────────────────────────────────
  // Key: offerKey, Value: { resolve, reject, actorUuid }
  const _pending = new Map();

  function makeOfferKey(actorUuid, actionCardId) {
    return `${actionCardId ?? actorUuid}-${Date.now()}`;
  }

  // ── Actor owner resolution ────────────────────────────────────────────────────
  /**
   * Resolve the userId that owns the actor. Returns null if GM-owned or unknown.
   * Checks world actors, then scene tokens.
   */
  function resolveOwnerUserId(actorUuid) {
    if (!actorUuid) return null;
    const shortId = String(actorUuid).replace(/^Actor\./, "").replace(/^.*\.Actor\./, "");

    // World actor
    const worldActor = game.actors?.get(shortId);
    if (worldActor) {
      for (const [userId, level] of Object.entries(worldActor.ownership ?? {})) {
        if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
          const user = game.users?.get(userId);
          if (user && !user.isGM) return userId;
        }
      }
      return null; // GM-owned
    }

    // Token actor (linked or unlinked)
    for (const t of (canvas?.tokens?.placeables ?? [])) {
      if (t.actor?.uuid === actorUuid || t.document?.actorId === shortId) {
        const actor = t.actor;
        if (!actor) continue;
        for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
          if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
            const user = game.users?.get(userId);
            if (user && !user.isGM) return userId;
          }
        }
        return null; // GM-owned token
      }
    }
    return null;
  }

  // ── Local dialog flow ────────────────────────────────────────────────────────
  async function showDialogLocally({ actorName, offerKey }) {
    const cfg = getConfig();
    if (!cfg) { console.error(TAG, "OpportunityConfig not loaded"); return { cancelled: true }; }

    const dialog = getDialog();
    if (!dialog) { console.error(TAG, "OpportunityDialog not loaded"); return { cancelled: true }; }

    return dialog.showPicker({
      actorName,
      options: cfg.OPTIONS,
      canDecline: true,
    });
  }

  // ── Apply effect + post chat card ───────────────────────────────────────────
  async function applyAndAnnounce({ actorUuid, actorName, optionId, context }) {
    const cfg     = getConfig();
    const effects = getEffects();
    const chatCard = getChatCard();

    const option = cfg?.OPTIONS?.find(o => o.id === optionId);
    if (!option) { console.warn(TAG, `Unknown option id: ${optionId}`); return; }

    // Run placeholder effect handler
    const handler = effects?.[optionId];
    if (typeof handler === "function") {
      await handler({ actorUuid, actorName, optionId, option, context }).catch(e =>
        console.error(TAG, `Effect handler error (${optionId}):`, e)
      );
    }

    // Post chat card
    if (chatCard?.postOpportunityCard) {
      await chatCard.postOpportunityCard({ actorUuid, actorName, optionId, option, context });
    }
  }

  // ── Core offer() API ─────────────────────────────────────────────────────────
  /**
   * Offer the opportunity picker for a given actor.
   * Routes: local dialog if I'm the owner (or GM with no player-owner), socket if GM→player.
   *
   * @param {object} opts
   * @param {string}  opts.actorUuid    UUID of the actor who scored the crit
   * @param {string}  opts.actorName    Display name
   * @param {string}  [opts.source]     "action" | "check"
   * @param {string}  [opts.actionCardId] Action card ID (used for dedup key)
   * @param {object}  [opts.context]    Caller metadata
   *
   * @returns {Promise<{ optionId: string, cancelled?: boolean }>}
   */
  async function offer({ actorUuid, actorName, source, actionCardId, context = {} }) {
    const ownerUserId = resolveOwnerUserId(actorUuid);
    const amOwner     = !ownerUserId || game.user.id === ownerUserId;
    const amGM        = game.user?.isGM ?? false;

    // Case 1: I am the owner (player or GM-owned) — show dialog directly
    if (amOwner) {
      const offerKey = makeOfferKey(actorUuid, actionCardId);
      const result   = await showDialogLocally({ actorName, offerKey });

      if (!result?.cancelled && result?.optionId) {
        // If I'm a player, send result to GM for application; if I'm GM, apply directly
        if (amGM) {
          await applyAndAnnounce({ actorUuid, actorName, optionId: result.optionId, context });
        } else {
          game.socket.emit(SOCKET_CH, {
            type: MSG_PICKED,
            payload: { offerKey, actorUuid, actorName, optionId: result.optionId, context },
          });
        }
      } else {
        if (!amGM) {
          game.socket.emit(SOCKET_CH, {
            type: MSG_CANCELLED,
            payload: { offerKey, actorUuid },
          });
        }
      }

      return result ?? { cancelled: true };
    }

    // Case 2: I am GM, actor is owned by a player — route via socket and await response
    if (amGM) {
      return new Promise((resolve) => {
        const offerKey = makeOfferKey(actorUuid, actionCardId);
        _pending.set(offerKey, { resolve, actorUuid });

        game.socket.emit(SOCKET_CH, {
          type: MSG_OFFER,
          payload: { offerKey, actorUuid, actorName, context, targetUserId: ownerUserId },
        });

        // Safety timeout: resolve cancelled after 120 s if player never responds
        setTimeout(() => {
          if (!_pending.has(offerKey)) return;
          _pending.delete(offerKey);
          console.warn(TAG, `offer() timed out for key=${offerKey}`);
          resolve({ cancelled: true });
        }, 120_000);
      });
    }

    // Case 3: I'm a player but not the owner — nothing to do
    return { cancelled: true };
  }

  // ── processCheckCrits() — CR path ────────────────────────────────────────────
  /**
   * Called by cr-api.js (GM only) after postGroupedChatCard, before emitCheckReactions.
   * Serially offers the picker for each crit actor so dialogs don't stack.
   *
   * @param {Array} critPayloads  Subset of CR confirmPayloads where isCrit && !isFumble
   */
  async function processCheckCrits(critPayloads) {
    if (!game.user?.isGM) return;
    if (!Array.isArray(critPayloads) || !critPayloads.length) return;

    for (const cp of critPayloads) {
      await offer({
        actorUuid: cp.actorUuid,
        actorName: cp.actorName,
        source: "check",
        context: { checkResult: cp },
      }).catch(e => console.error(TAG, "processCheckCrits offer error:", e));
    }
  }

  // ── Socket listener ───────────────────────────────────────────────────────────
  function setupSocket() {
    if (window["__ONI_OPP_SOCKET__"]) return;
    window["__ONI_OPP_SOCKET__"] = true;

    game.socket.on(SOCKET_CH, async msg => {
      if (!msg?.type?.startsWith("OPP_")) return;

      // ── OPP_OFFER: targeted at this specific player ──────────────────────
      if (msg.type === MSG_OFFER) {
        const { offerKey, actorUuid, actorName, context, targetUserId } = msg.payload ?? {};
        if (game.user.id !== targetUserId) return;

        const result = await showDialogLocally({ actorName, offerKey }).catch(e => {
          console.error(TAG, "Socket offer dialog error:", e);
          return { cancelled: true };
        });

        if (!result?.cancelled && result?.optionId) {
          game.socket.emit(SOCKET_CH, {
            type: MSG_PICKED,
            payload: { offerKey, actorUuid, actorName, optionId: result.optionId, context },
          });
        } else {
          game.socket.emit(SOCKET_CH, {
            type: MSG_CANCELLED,
            payload: { offerKey, actorUuid },
          });
        }
        return;
      }

      // ── OPP_PICKED: GM receives and applies ─────────────────────────────
      if (msg.type === MSG_PICKED && game.user?.isGM) {
        const { offerKey, actorUuid, actorName, optionId, context } = msg.payload ?? {};
        await applyAndAnnounce({ actorUuid, actorName, optionId, context })
          .catch(e => console.error(TAG, "applyAndAnnounce error:", e));

        const pending = _pending.get(offerKey);
        if (pending) {
          _pending.delete(offerKey);
          pending.resolve({ optionId });
        }
        return;
      }

      // ── OPP_CANCELLED: GM resolves the pending offer ─────────────────────
      if (msg.type === MSG_CANCELLED && game.user?.isGM) {
        const { offerKey } = msg.payload ?? {};
        const pending = _pending.get(offerKey);
        if (pending) {
          _pending.delete(offerKey);
          pending.resolve({ cancelled: true });
        }
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  const api = {
    offer,
    processCheckCrits,
    get OPTIONS() { return getConfig()?.OPTIONS ?? []; },
  };

  globalThis.ONI = globalThis.ONI ?? {};
  globalThis.ONI.OpportunitySystem = api;

  Hooks.once("ready", () => {
    setupSocket();
    console.log(`${TAG} Ready.`);
  });
})();
