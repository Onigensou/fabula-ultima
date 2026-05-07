/**
 * [ONI] Reaction System — Manager Helpers (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Helpers extracted from reaction-manager.js so the orchestrator stays small:
 *   - DOM nuke for floating Reaction blades
 *   - Per-token reaction-window state machinery
 *   - Owner-user resolution (which players + GMs see a given token's button)
 *
 * Exposed on:  window["oni.ReactionManagerHelpers"]
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  const KEY = "oni.ReactionManagerHelpers";
  if (window[KEY]) {
    console.log("[ReactionManagerHelpers] Already installed.");
    return;
  }

  // ===========================================================================
  // 1) DOM cleanup ("hard nuke") for floating Reaction buttons
  // ===========================================================================

  /**
   * Try to remove ALL floating Reaction buttons on THIS client.
   *
   * 1) Calls ReactionButtonUI.clearAll() if available.
   * 2) Direct DOM cleanup as a safety net (only if step 1 didn't fire).
   */
  function hardNukeReactionButtons(source) {
    console.log("[ReactionManagerHelpers] hardNukeReactionButtons invoked.", {
      source,
      localUserId: game.user?.id,
      localUserName: game.user?.name,
      isGM: game.user?.isGM
    });

    const uiApi = window["oni.ReactionButtonUI"];
    let usedOfficialClear = false;

    if (uiApi && typeof uiApi.clearAll === "function") {
      try {
        uiApi.clearAll();
        usedOfficialClear = true;
      } catch (err) {
        console.error("[ReactionManagerHelpers] Error calling ReactionButtonUI.clearAll().", err);
      }
    } else {
      console.warn("[ReactionManagerHelpers] ReactionButtonUI API not available on this client.");
    }

    // If the official UI API handled the buttons, do not also schedule raw DOM
    // removals. That can delete a button that spawnButton just revived.
    if (usedOfficialClear) return;

    try {
      const elementsToAnimate = new Set();

      const root = document.getElementById("oni-reaction-root");
      if (root) {
        for (const el of root.querySelectorAll(".oni-reaction-item")) elementsToAnimate.add(el);
      }
      for (const el of document.querySelectorAll(".oni-reaction-item")) elementsToAnimate.add(el);

      for (const el of elementsToAnimate) {
        try {
          const existingTransition = el.style.transition || "";
          const extraTransition = "opacity 0.25s ease-out, transform 0.25s ease-out";
          el.style.transition = existingTransition
            ? `${existingTransition}, ${extraTransition}`
            : extraTransition;

          if (!el.style.opacity)   el.style.opacity = "1";
          if (!el.style.transform) el.style.transform = "translateY(0px)";

          // Force reflow so the browser applies the starting values.
          // eslint-disable-next-line no-unused-expressions
          el.offsetWidth;

          el.style.opacity = "0";
          el.style.transform = "translateY(-8px)";

          setTimeout(() => {
            if (el.isConnected) el.remove();
          }, 260);
        } catch (_err) {}
      }
    } catch (err) {
      console.error("[ReactionManagerHelpers] Error during DOM cleanup.", err);
    }
  }

  // ===========================================================================
  // 2) Owner-user resolution
  // ===========================================================================

  function isFriendly(tokenDoc) {
    return (tokenDoc?.disposition ?? 0) === 1;
  }

  /**
   * Decide which user(s) should see Reaction buttons for a given token.
   *
   * Rules:
   *   - Friendly PCs  -> all non-GM owners (players) + all GMs.
   *   - Monsters/NPCs -> all GMs.
   */
  function getOwningUserIdsForToken(tokenDoc, actor) {
    if (!tokenDoc || !actor) return [];

    const friendly = isFriendly(tokenDoc);
    const allUsers = game.users?.contents ?? game.users ?? [];
    const ownerUsers = [];

    for (const u of allUsers) {
      try {
        if (actor.testUserPermission?.(u, "OWNER")) ownerUsers.push(u);
      } catch (_err) {}
    }

    const result = new Set();

    if (friendly) {
      for (const u of ownerUsers) if (!u.isGM) result.add(u.id);
      for (const u of allUsers)   if (u.isGM)  result.add(u.id);
    } else {
      for (const u of allUsers)   if (u.isGM)  result.add(u.id);
    }

    return Array.from(result);
  }

  // ===========================================================================
  // 3) Reaction-window state machinery
  // ===========================================================================
  //
  // Per-token window keyed by `${phaseBucket}::${tokenId}`. Multiple low-level
  // triggers in the same bucket (e.g. takes_damage + enter_crisis + defeated)
  // merge into one window so the player sees a single Reaction button with
  // every applicable trigger context attached.

  function makeWindowKey(phaseBucket, tokenId) {
    return `${phaseBucket}::${tokenId ?? "(no-token)"}`;
  }

  function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const v of values ?? []) {
      const s = String(v ?? "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function cloneReactionGroup(group) {
    return {
      item: group?.item ?? null,
      triggers: uniqueStrings(group?.triggers ?? []),
      rows: Array.isArray(group?.rows) ? [...group.rows] : []
    };
  }

  function emptyWindowState(phaseBucket, tokenId) {
    return {
      windowKey: makeWindowKey(phaseBucket, tokenId),
      phaseBucket,
      tokenId,
      combatant: null,
      actor: null,
      token: null,
      actorUuid: null,
      ownerUserIds: [],
      latestTriggerKey: null,
      latestPhasePayload: {},
      triggerKeys: [],
      phasePayloadByTrigger: {},
      triggerHistory: [],
      reactionGroupsByItemUuid: new Map()
    };
  }

  function mergeReactionGroupIntoWindow(windowState, group) {
    const item = group?.item ?? null;
    if (!item) return;

    const mapKey = item.uuid ?? item.id ?? item.name ?? `${Date.now()}-${Math.random()}`;
    const existing = windowState.reactionGroupsByItemUuid.get(mapKey);

    if (!existing) {
      windowState.reactionGroupsByItemUuid.set(mapKey, cloneReactionGroup(group));
      return;
    }

    existing.triggers = uniqueStrings([
      ...(existing.triggers ?? []),
      ...(group?.triggers ?? [])
    ]);

    const existingRows = Array.isArray(existing.rows) ? existing.rows : [];
    const incomingRows = Array.isArray(group?.rows) ? group.rows : [];
    existing.rows = [...existingRows, ...incomingRows];
  }

  function mergeMatchIntoWindow(windowState, ctx, triggerKey, phasePayload) {
    windowState.combatant = ctx?.combatant ?? windowState.combatant;
    windowState.actor     = ctx?.actor     ?? windowState.actor;
    windowState.token     = ctx?.token     ?? windowState.token;
    windowState.actorUuid = ctx?.actor?.uuid ?? windowState.actorUuid;

    windowState.ownerUserIds = uniqueStrings([
      ...(windowState.ownerUserIds ?? []),
      ...(ctx?.ownerUserIds ?? [])
    ]);

    windowState.latestTriggerKey = triggerKey;
    windowState.latestPhasePayload = phasePayload && typeof phasePayload === "object"
      ? foundry.utils.deepClone(phasePayload)
      : {};

    windowState.triggerKeys = uniqueStrings([
      ...(windowState.triggerKeys ?? []),
      triggerKey
    ]);

    windowState.phasePayloadByTrigger[triggerKey] = phasePayload && typeof phasePayload === "object"
      ? foundry.utils.deepClone(phasePayload)
      : {};

    windowState.triggerHistory.push({ triggerKey, at: Date.now() });

    for (const group of ctx?.reactions ?? []) {
      mergeReactionGroupIntoWindow(windowState, group);
    }
  }

  function buildTriggerEntriesForWindow(windowState) {
    const triggerKeys = Array.isArray(windowState?.triggerKeys) ? windowState.triggerKeys : [];
    const allGroups = Array.from(windowState?.reactionGroupsByItemUuid?.values?.() ?? []);

    return triggerKeys.map(triggerKey => ({
      triggerKey,
      phasePayload: foundry.utils.deepClone(windowState?.phasePayloadByTrigger?.[triggerKey] ?? {}),
      reactions: allGroups
        .filter(group => Array.isArray(group?.triggers) && group.triggers.includes(triggerKey))
        .map(group => ({
          item: group?.item ?? null,
          triggers: uniqueStrings(group?.triggers ?? []),
          rows: Array.isArray(group?.rows) ? [...group.rows] : []
        }))
    }));
  }

  function buildCtxFromWindow(windowState) {
    const reactionGroups = Array.from(windowState?.reactionGroupsByItemUuid?.values?.() ?? []).map(group => ({
      item: group?.item ?? null,
      triggers: uniqueStrings(group?.triggers ?? []),
      rows: Array.isArray(group?.rows) ? [...group.rows] : []
    }));

    return {
      combatant: windowState?.combatant ?? null,
      actor: windowState?.actor ?? null,
      token: windowState?.token ?? null,
      reactions: reactionGroups,
      triggerKey: windowState?.latestTriggerKey ?? "(unknown_trigger)",
      latestTriggerKey: windowState?.latestTriggerKey ?? "(unknown_trigger)",
      triggerKeys: uniqueStrings(windowState?.triggerKeys ?? []),
      phasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
      latestPhasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
      phasePayloadByTrigger: foundry.utils.deepClone(windowState?.phasePayloadByTrigger ?? {}),
      triggerEntries: buildTriggerEntriesForWindow(windowState),
      phaseBucket: windowState?.phaseBucket ?? null,
      ownerUserIds: uniqueStrings(windowState?.ownerUserIds ?? [])
    };
  }

  function buildSocketOfferFromWindow(windowState, targetUserId) {
    const reactionGroups = Array.from(windowState?.reactionGroupsByItemUuid?.values?.() ?? []);
    const itemGroups = reactionGroups
      .map(group => ({
        itemUuid: group?.item?.uuid ?? null,
        triggers: uniqueStrings(group?.triggers ?? [])
      }))
      .filter(g => !!g.itemUuid);

    return {
      targetUserId,
      triggerKey: windowState?.latestTriggerKey ?? null,
      latestTriggerKey: windowState?.latestTriggerKey ?? null,
      triggerKeys: uniqueStrings(windowState?.triggerKeys ?? []),
      phaseBucket: windowState?.phaseBucket ?? null,
      actorUuid: windowState?.actorUuid ?? null,
      tokenId: windowState?.tokenId ?? null,
      itemUuids: itemGroups.map(g => g.itemUuid),
      itemGroups,
      phasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
      latestPhasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
      phasePayloadByTrigger: foundry.utils.deepClone(windowState?.phasePayloadByTrigger ?? {}),
      triggerHistory: Array.isArray(windowState?.triggerHistory) ? [...windowState.triggerHistory] : []
    };
  }

  // ===========================================================================
  // 4) Passive event-stamp + source-event helpers (used to dedupe passive runs)
  // ===========================================================================

  function pickPassiveEventStamp(payload = {}) {
    return String(
      payload?.meta?.passiveOrigin?.rootTimestamp ??
      payload?.passiveOrigin?.rootTimestamp ??
      payload?.timestamp ??
      payload?.eventTimestamp ??
      payload?.meta?.timestamp ??
      payload?.meta?.eventTimestamp ??
      payload?.meta?.runId ??
      `${Date.now()}`
    );
  }

  function buildPassiveSourceEvent({ rawTrigger, triggerKey, phaseBucket, payload }) {
    return {
      rawTrigger: rawTrigger ?? null,
      triggerKey: triggerKey ?? null,
      phaseBucket: phaseBucket ?? null,
      timestamp: Date.now(),
      eventStamp: pickPassiveEventStamp(payload),
      payloadTimestamp: payload?.timestamp ?? payload?.eventTimestamp ?? payload?.meta?.timestamp ?? null,
      attackerUuid: payload?.attacker_uuid ?? payload?.attackerUuid ?? payload?.meta?.attackerUuid ?? null,
      targetUuid: payload?.target_uuid ?? payload?.targetUuid ?? payload?.meta?.targetUuid ?? null,
      targetUuids: Array.isArray(payload?.targets) ? [...payload.targets] : [],
      actionName: payload?.skill_name ?? payload?.skillName ?? payload?.itemName ?? payload?.meta?.passiveItemName ?? null,
      passiveOrigin: foundry.utils.deepClone(payload?.meta?.passiveOrigin ?? payload?.passiveOrigin ?? {})
    };
  }

  // ===========================================================================
  // Export
  // ===========================================================================
  window[KEY] = {
    hardNukeReactionButtons,
    isFriendly,
    getOwningUserIdsForToken,
    makeWindowKey,
    uniqueStrings,
    cloneReactionGroup,
    emptyWindowState,
    mergeReactionGroupIntoWindow,
    mergeMatchIntoWindow,
    buildTriggerEntriesForWindow,
    buildCtxFromWindow,
    buildSocketOfferFromWindow,
    pickPassiveEventStamp,
    buildPassiveSourceEvent
  };

  console.log("[ReactionManagerHelpers] Installed.");
});
