/**
 * [ONI] Reaction System — Manager (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Refactored 2026-05:
 *   - Phase-bucket map is now read from oni.ReactionTriggers (registry).
 *   - DOM cleanup, ownership resolution, and window-state machinery moved to
 *     oni.ReactionManagerHelpers.
 *   - Manager only orchestrates: receives oni:reactionPhase, splits passives,
 *     merges into windows, fans out to socket / GM UI.
 *
 * Behaviour preserved:
 *   - Reactions clear when the larger PHASE BUCKET changes.
 *   - Multiple low-level triggers in the same bucket coexist for the same token.
 *   - GM is authoritative; players receive offers via the module socket.
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  const KEY = "oni.ReactionManager";
  if (window[KEY]) {
    console.log("[ReactionManager] Already installed.");
    return;
  }

  const registry = window["oni.ReactionTriggers"];
  const helpers  = window["oni.ReactionManagerHelpers"];

  if (!registry) {
    console.error("[ReactionManager] oni.ReactionTriggers registry not loaded.");
    return;
  }
  if (!helpers) {
    console.error("[ReactionManager] oni.ReactionManagerHelpers not loaded.");
    return;
  }

  const {
    hardNukeReactionButtons,
    getOwningUserIdsForToken,
    makeWindowKey,
    uniqueStrings,
    emptyWindowState,
    mergeMatchIntoWindow,
    buildCtxFromWindow,
    buildSocketOfferFromWindow,
    buildPassiveSourceEvent
  } = helpers;

  const MODULE_ID = "fabula-ultima-companion";
  const CHANNEL = `module.${MODULE_ID}`;

  // ---------------------------------------------------------------------------
  // Module-local state
  // ---------------------------------------------------------------------------

  let _currentPhaseBucket = null;

  // GM-authoritative same-bucket windows, keyed by `${phaseBucket}::${tokenId}`.
  const _gmReactionWindows = new Map();

  // Optional local mirror for socket-built contexts on non-GM clients.
  const _localReactionWindows = new Map();

  // Player → GM socket request de-dupe (action/check/target events spam-refresh
  // the same UI window otherwise).
  const _recentSocketPhaseRequests = new Map();

  // ---------------------------------------------------------------------------
  // GM election (the primary GM is the one whose user-id sorts first)
  // ---------------------------------------------------------------------------

  function getPrimaryActiveGM() {
    const users = Array.from(game.users?.contents ?? game.users ?? []);
    const activeGMs = users
      .filter(u => u?.active && u?.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return activeGMs[0] ?? null;
  }

  function isPrimaryReactionGM() {
    if (!game.user?.isGM) return false;
    const primary = getPrimaryActiveGM();
    return !primary || primary.id === game.user.id;
  }

  // ---------------------------------------------------------------------------
  // Socket-request de-dupe
  // ---------------------------------------------------------------------------

  function makeSocketPhaseRequestKey(payload = {}) {
    return [
      payload?.actionCardId ?? payload?.actionId ?? "(no-action)",
      payload?.trigger ?? "(no-trigger)",
      payload?.targetUuid ?? "(no-target)",
      payload?.requestedByUserId ?? "(no-user)"
    ].map(v => String(v ?? "")).join("::");
  }

  function shouldProcessSocketPhaseRequest(payload = {}) {
    const now = Date.now();
    for (const [key, time] of _recentSocketPhaseRequests.entries()) {
      if (now - time > 2500) _recentSocketPhaseRequests.delete(key);
    }
    const key = makeSocketPhaseRequestKey(payload);
    if (_recentSocketPhaseRequests.has(key)) return false;
    _recentSocketPhaseRequests.set(key, now);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase-bucket bookkeeping
  // ---------------------------------------------------------------------------

  function clearAllReactionWindows() {
    _gmReactionWindows.clear();
    _localReactionWindows.clear();
  }

  function clearForNewPhaseBucket(phaseBucket, triggerKey) {
    console.log("[ReactionManager] (GM) Phase bucket changed; clearing all Reaction buttons.", {
      from: _currentPhaseBucket,
      to: phaseBucket,
      triggerKey
    });

    _currentPhaseBucket = phaseBucket;
    clearAllReactionWindows();

    if (game.socket) {
      game.socket.emit(CHANNEL, {
        type: "OniReactionClear",
        payload: { phaseBucket, triggerKey, fromUserId: game.user.id }
      });
    } else {
      console.warn("[ReactionManager] (GM) game.socket is not available when emitting OniReactionClear.");
    }

    hardNukeReactionButtons("GM-phase-change");
  }

  // ---------------------------------------------------------------------------
  // Main event listener — reacts to oni:reactionPhase
  // ---------------------------------------------------------------------------

  Hooks.on("oni:reactionPhase", async (payload) => {
    const triggerApi = window["oni.ReactionTriggerCore"];
    if (!triggerApi) {
      console.error("[ReactionManager] oni:reactionPhase fired, but oni.ReactionTriggerCore is not installed.");
      ui.notifications?.error?.("[Reaction] Internal error: ReactionTriggerCore not loaded.");
      return;
    }

    const rawTrigger = payload?.trigger;
    const triggerKey = triggerApi.mapIncomingTrigger(rawTrigger);

    if (!triggerApi.isValidTriggerKey(triggerKey)) {
      console.log("[ReactionManager] Ignoring oni:reactionPhase; invalid or unsupported triggerKey.", {
        rawTrigger,
        triggerKey
      });
      return;
    }

    if (!game.user.isGM) {
      console.log("[ReactionManager] Non-GM client ignoring oni:reactionPhase; waiting for GM offers via socket.", {
        rawTrigger,
        triggerKey
      });
      return;
    }

    const phaseBucket = registry.bucketFor(triggerKey);

    console.log("[ReactionManager] (GM) Received reaction trigger:", {
      rawTrigger,
      triggerKey,
      phaseBucket
    });

    const uiApi = window["oni.ReactionButtonUI"];
    const dialogApi = window["oni.ReactionChooseSkill"];

    if (!uiApi || typeof uiApi.spawnButton !== "function") {
      ui.notifications?.error?.("[Reaction] ReactionButtonUI script not installed (GM).");
      console.error("[ReactionManager] (GM) Missing oni.ReactionButtonUI API.");
    }
    if (!dialogApi || typeof dialogApi.openReactionDialog !== "function") {
      ui.notifications?.error?.("[Reaction] ReactionChooseSkill script not installed (GM).");
      console.error("[ReactionManager] (GM) Missing oni.ReactionChooseSkill.openReactionDialog.");
    }

    // 1) Phase bucket change -> tell everyone to clear.
    if (phaseBucket !== _currentPhaseBucket) {
      clearForNewPhaseBucket(phaseBucket, triggerKey);
    }

    // 2) Compute matching candidates.
    const matches = triggerApi.collectReactionsForTrigger(triggerKey, payload);
    if (!Array.isArray(matches) || matches.length === 0) {
      console.log("[ReactionManager] (GM) No matching reactions for trigger", triggerKey);
      return;
    }

    // 3) Enrich with ownership info.
    for (const ctx of matches) {
      const tokenDoc = ctx.token?.document;
      const actor    = ctx.actor;
      ctx.ownerUserIds = (tokenDoc && actor)
        ? (getOwningUserIdsForToken(tokenDoc, actor) ?? [])
        : [];
    }

    const filteredMatches = matches.filter(m =>
      Array.isArray(m.ownerUserIds) && m.ownerUserIds.length > 0
    );
    if (filteredMatches.length === 0) {
      console.log("[ReactionManager] (GM) No reaction candidates with resolved owners.", { triggerKey });
      return;
    }

    // 4) Split passive rows away from manual Reaction rows BEFORE any UI.
    let manualMatches = filteredMatches;
    const autoPassiveApi = window["oni.AutoPassiveManager"]
      ?? globalThis.FUCompanion?.api?.autoPassiveManager
      ?? null;

    if (autoPassiveApi?.processMatches) {
      try {
        const passiveSourceEvent = buildPassiveSourceEvent({
          rawTrigger,
          triggerKey,
          phaseBucket,
          payload
        });

        const passiveProcessing = await autoPassiveApi.processMatches({
          matches: filteredMatches,
          triggerKey,
          phaseBucket,
          rawTrigger,
          phasePayload: payload,
          phasePayloadByTrigger: { [triggerKey]: foundry.utils.deepClone(payload ?? {}) },
          sourceEvent: passiveSourceEvent
        });

        manualMatches = Array.isArray(passiveProcessing?.manualMatches)
          ? passiveProcessing.manualMatches
          : [];
      } catch (err) {
        console.error("[ReactionManager] (GM) AutoPassiveManager.processMatches failed; falling back to manual flow.", {
          triggerKey,
          err
        });
        manualMatches = filteredMatches;
      }
    } else {
      console.warn("[ReactionManager] (GM) AutoPassiveManager API not found; passive rows will behave like manual reactions until loaded.", {
        triggerKey
      });
    }

    if (!Array.isArray(manualMatches) || manualMatches.length === 0) {
      console.log("[ReactionManager] (GM) No manual Reaction rows remain after passive split.", { triggerKey });
      return;
    }

    // 5) Merge each manual match into its token's same-bucket window and refresh UI.
    for (const ctx of manualMatches) {
      const token = ctx.token;
      const tokenId = token?.id ?? ctx.combatant?.tokenId ?? null;
      const actorUuid = ctx.actor?.uuid ?? null;
      const ownerUserIds = Array.isArray(ctx.ownerUserIds) ? ctx.ownerUserIds : [];
      if (!tokenId || !ownerUserIds.length) continue;

      const windowKey = makeWindowKey(phaseBucket, tokenId);
      const windowState = _gmReactionWindows.get(windowKey) ?? emptyWindowState(phaseBucket, tokenId);

      mergeMatchIntoWindow(windowState, ctx, triggerKey, payload);
      windowState.actorUuid = actorUuid ?? windowState.actorUuid;
      _gmReactionWindows.set(windowKey, windowState);

      const mergedCtx = buildCtxFromWindow(windowState);
      const gmId = game.user.id;

      // 5A) GM local UI
      if (ownerUserIds.includes(gmId) && uiApi && dialogApi) {
        uiApi.spawnButton(token, mergedCtx, (clickedCtx) => {
          dialogApi.openReactionDialog(clickedCtx);
        });
      }

      // 5B) Player offers via socket
      for (const targetUserId of ownerUserIds) {
        if (targetUserId === gmId) continue;
        const payloadOut = buildSocketOfferFromWindow(windowState, targetUserId);

        if (game.socket) {
          game.socket.emit(CHANNEL, { type: "OniReactionOffer", payload: payloadOut });
        } else {
          console.warn("[ReactionManager] (GM) game.socket is not available when emitting OniReactionOffer.");
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Module socket listener — Player→GM phase request + GM→Player clear/offers
  // ---------------------------------------------------------------------------

  function handleModuleMessage(data) {
    if (!data || typeof data !== "object") return;

    // ---- Player → GM phase request --------------------------------------
    if (data.type === "OniReactionPhaseRequest") {
      const payload = data.payload || {};
      if (!game.user?.isGM) return;

      if (!isPrimaryReactionGM()) {
        console.log("[ReactionManager] OniReactionPhaseRequest ignored on non-primary GM.", {
          localUserId: game.user.id,
          primaryGmId: getPrimaryActiveGM()?.id ?? null,
          trigger: payload?.trigger
        });
        return;
      }

      if (!shouldProcessSocketPhaseRequest(payload)) {
        console.log("[ReactionManager] Duplicate OniReactionPhaseRequest ignored.", {
          trigger: payload?.trigger,
          actionCardId: payload?.actionCardId ?? null,
          targetUuid: payload?.targetUuid ?? null
        });
        return;
      }

      const clonedPayload = foundry.utils.deepClone(payload);
      console.log("[ReactionManager] Primary GM received OniReactionPhaseRequest.", {
        trigger: clonedPayload?.trigger,
        requestedByUserId: clonedPayload?.requestedByUserId ?? null
      });

      Hooks.callAll("oni:reactionPhase", { ...clonedPayload, fromSocketRequest: true });
      return;
    }

    // ---- GM → all: clear ------------------------------------------------
    if (data.type === "OniReactionClear") {
      const { phaseBucket, triggerKey, fromUserId } = data.payload || {};
      console.log("[ReactionManager] Socket OniReactionClear on user", game.user.id, {
        phaseBucket,
        triggerKey,
        fromUserId
      });

      clearAllReactionWindows();
      hardNukeReactionButtons("socket");
      _currentPhaseBucket = phaseBucket ?? null;
      return;
    }

    // ---- GM → specific user: offer button ------------------------------
    if (data.type === "OniReactionOffer") {
      const payload = data.payload || {};
      const {
        targetUserId,
        triggerKey,
        latestTriggerKey,
        triggerKeys,
        phaseBucket,
        actorUuid,
        tokenId,
        itemUuids,
        itemGroups,
        phasePayload,
        latestPhasePayload,
        phasePayloadByTrigger
      } = payload;

      if (!targetUserId || targetUserId !== game.user.id) return;

      const uiApi = window["oni.ReactionButtonUI"];
      if (!uiApi || typeof uiApi.spawnButton !== "function") {
        ui.notifications?.error?.("[Reaction] ReactionButtonUI script not installed (socket offer).");
        console.error("[ReactionManager] Missing oni.ReactionButtonUI API for OniReactionOffer.");
        return;
      }

      if (phaseBucket && phaseBucket !== _currentPhaseBucket) {
        clearAllReactionWindows();
        hardNukeReactionButtons("socket-phase-change");
        _currentPhaseBucket = phaseBucket;
      }

      const triggerCore = window["oni.ReactionTriggerCore"];
      const token = triggerCore?.byIdOnCanvas?.(tokenId) ?? canvas?.tokens?.get(tokenId) ?? null;
      if (!token) {
        console.warn("[ReactionManager] OniReactionOffer: token not found on this canvas.", { tokenId });
        return;
      }

      let actor = null;
      try {
        actor = actorUuid ? fromUuidSync(actorUuid) : token.actor;
      } catch (err) {
        console.warn("[ReactionManager] OniReactionOffer: error resolving actor from uuid.", actorUuid, err);
        actor = token.actor;
      }
      if (!actor) {
        console.warn("[ReactionManager] OniReactionOffer: no actor found.", { tokenId, actorUuid });
        return;
      }

      const reactions = [];
      const uniqueIds = new Set();
      const itemGroupMap = new Map();

      if (Array.isArray(itemGroups)) {
        for (const g of itemGroups) {
          if (!g?.itemUuid) continue;
          itemGroupMap.set(g.itemUuid, {
            itemUuid: g.itemUuid,
            triggers: uniqueStrings(g.triggers ?? [])
          });
        }
      }

      const uuidsToResolve = Array.isArray(itemUuids)
        ? itemUuids
        : Array.from(itemGroupMap.keys());

      for (const u of uuidsToResolve) {
        if (!u) continue;

        let item = null;
        try { item = fromUuidSync(u); } catch (_err) {}

        if (!item && actor.items) {
          const match = u.match(/Item\.([A-Za-z0-9]+)$/);
          const idGuess = match ? match[1] : null;
          if (idGuess) item = actor.items.get(idGuess);
        }

        if (!item || uniqueIds.has(item.id)) continue;
        uniqueIds.add(item.id);

        const triggerInfo = itemGroupMap.get(u);
        reactions.push({
          item,
          triggers: uniqueStrings(triggerInfo?.triggers ?? []),
          rows: []
        });
      }

      if (!reactions.length) {
        console.warn("[ReactionManager] OniReactionOffer: no valid Item documents resolved.", itemUuids);
        return;
      }

      const resolvedTriggerKey = latestTriggerKey ?? triggerKey ?? "(unknown_trigger)";
      const resolvedTriggerKeys = uniqueStrings(triggerKeys ?? reactions.flatMap(r => r?.triggers ?? []));

      const ctx = {
        combatant: null,
        actor,
        token,
        reactions,
        triggerKey: resolvedTriggerKey,
        latestTriggerKey: resolvedTriggerKey,
        triggerKeys: resolvedTriggerKeys,
        phasePayload: foundry.utils.deepClone(latestPhasePayload ?? phasePayload ?? {}),
        latestPhasePayload: foundry.utils.deepClone(latestPhasePayload ?? phasePayload ?? {}),
        phasePayloadByTrigger: foundry.utils.deepClone(phasePayloadByTrigger ?? {}),
        triggerEntries: resolvedTriggerKeys.map(k => ({
          triggerKey: k,
          phasePayload: foundry.utils.deepClone((phasePayloadByTrigger ?? {})[k] ?? {}),
          reactions: reactions.filter(r => Array.isArray(r?.triggers) && r.triggers.includes(k))
        })),
        phaseBucket: phaseBucket ?? null,
        ownerUserIds: [targetUserId]
      };

      _localReactionWindows.set(makeWindowKey(phaseBucket, tokenId), foundry.utils.deepClone({
        phaseBucket,
        tokenId,
        triggerKey: resolvedTriggerKey,
        triggerKeys: resolvedTriggerKeys
      }));

      uiApi.spawnButton(token, ctx, (clickedCtx) => {
        const dialogApi = window["oni.ReactionChooseSkill"];
        if (!dialogApi || typeof dialogApi.openReactionDialog !== "function") {
          ui.notifications?.error?.("[Reaction] ReactionChooseSkill script not installed (socket offer).");
          console.error("[ReactionManager] Missing oni.ReactionChooseSkill.openReactionDialog for OniReactionOffer.");
          return;
        }
        dialogApi.openReactionDialog(clickedCtx);
      });
    }
  }

  if (game.socket) {
    game.socket.on(CHANNEL, handleModuleMessage);
    console.log("[ReactionManager] Module socket listener attached on", CHANNEL, "for user", game.user.id);
  } else {
    console.warn("[ReactionManager] game.socket not available; GM→Player Reaction offers will not work.");
  }

  // ---------------------------------------------------------------------------
  // Hard cleanup when combat ends
  // ---------------------------------------------------------------------------

  Hooks.on("combatEnd", (combat) => {
    console.log("[ReactionManager] combatEnd detected – nuking all Reaction buttons.", {
      combatId: combat?.id,
      isGM: game.user.isGM
    });
    clearAllReactionWindows();
    hardNukeReactionButtons("combatEnd");
    _currentPhaseBucket = null;
  });

  Hooks.on("deleteCombat", (combat) => {
    console.log("[ReactionManager] deleteCombat detected – nuking all Reaction buttons.", {
      combatId: combat?.id,
      isGM: game.user.isGM
    });
    clearAllReactionWindows();
    hardNukeReactionButtons("deleteCombat");
    _currentPhaseBucket = null;
  });

  console.log("[ReactionManager] Installed (registry-driven, helpers-extracted). Listening for oni:reactionPhase.");

  // ---------------------------------------------------------------------------
  // Debug API
  // ---------------------------------------------------------------------------
  window[KEY] = {
    collectReactionsForTrigger(triggerKey, phasePayload) {
      const triggerApi = window["oni.ReactionTriggerCore"];
      if (!triggerApi?.collectReactionsForTrigger) {
        console.error("[ReactionManager] Debug collectReactionsForTrigger: ReactionTriggerCore not available.");
        return [];
      }
      return triggerApi.collectReactionsForTrigger(triggerKey, phasePayload);
    },

    getCurrentPhaseBucket() {
      return _currentPhaseBucket;
    },

    debugListGMReactionWindows() {
      return Array.from(_gmReactionWindows.entries()).map(([key, ws]) => ({
        key,
        phaseBucket: ws.phaseBucket,
        tokenId: ws.tokenId,
        actorName: ws.actor?.name,
        tokenName: ws.token?.name,
        latestTriggerKey: ws.latestTriggerKey,
        triggerKeys: [...(ws.triggerKeys ?? [])],
        ownerUserIds: [...(ws.ownerUserIds ?? [])],
        numReactionItems: ws.reactionGroupsByItemUuid?.size ?? 0
      }));
    },

    async processPassiveDebug(matches, triggerKey, phasePayload, options = {}) {
      const autoPassiveApi = window["oni.AutoPassiveManager"]
        ?? globalThis.FUCompanion?.api?.autoPassiveManager
        ?? null;
      if (!autoPassiveApi?.processMatches) {
        console.warn("[ReactionManager] processPassiveDebug: AutoPassiveManager not available.");
        return { ok: false, reason: "auto_passive_manager_missing" };
      }

      const phaseBucket = options?.phaseBucket ?? registry.bucketFor(triggerKey);
      const rawTrigger = options?.rawTrigger ?? triggerKey;
      const normalizedPayload = phasePayload ?? {};
      const sourceEvent = options?.sourceEvent ?? buildPassiveSourceEvent({
        rawTrigger,
        triggerKey,
        phaseBucket,
        payload: normalizedPayload
      });

      return autoPassiveApi.processMatches({
        matches: Array.isArray(matches) ? matches : [],
        triggerKey,
        phaseBucket,
        rawTrigger,
        phasePayload: normalizedPayload,
        phasePayloadByTrigger: { [triggerKey]: foundry.utils.deepClone(normalizedPayload) },
        sourceEvent
      });
    }
  };
});
