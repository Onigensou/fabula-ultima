/**
 * [ONI] Reaction Chain Tracker (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Tracks which reaction skills each actor has already used within a single
 * reaction chain. A "chain" begins when a top-level (non-reaction) action
 * card is created and ends when the entire cascade — its reactions, the
 * action cards those reactions create, and any further reactions on those
 * downstream cards — fully resolves. Within one chain, each actor may
 * fire each reaction skill at most once. This prevents infinite
 * Counterattack-style loops while still letting every reactor respond
 * once per chain.
 *
 * Chain id source of truth:
 *   - Top-level Create Damage Card.js mints a fresh id when it emits the
 *     first reaction trigger for a card whose payload carries no inherited
 *     chain id, then stuffs that id into every trigger payload it emits.
 *   - When a reaction is fired by reaction-chooseSkill.js, it forwards the
 *     chain id through ADF.execute via payload.meta.reactionChainId. The
 *     downstream Create Damage Card.js in that reaction's cascade reads
 *     it from actionContext.meta.reactionChainId and re-uses it instead
 *     of minting a new one.
 *   - The reaction manager pulls the id off incoming trigger payloads and
 *     stashes it in windowState, so the reaction menu's ctx exposes it and
 *     the "Used" stamp can render before the player picks.
 *
 * Lifecycle:
 *   - Lazy expiration: any chain idle > IDLE_TIMEOUT_MS is purged on next
 *     access. Catches paths that forget to clear (manager-level cleanup
 *     normally handles this, but the lazy backstop guarantees the map
 *     can't grow unbounded across long sessions).
 *   - clearAll() is invoked on combatEnd / deleteCombat and on scene
 *     change (canvasReady).
 *
 * Public API on globalThis.FUCompanion.api.reactionChainTracker:
 *   mintChainId()                              → string
 *   markUsed(chainId, actorId, skillUuid)      → void
 *   isUsed(chainId, actorId, skillUuid)        → boolean
 *   touch(chainId)                             → void
 *   clearAll()                                 → void
 *   debugDump()                                → array
 * ---------------------------------------------------------------------------
 */
(() => {
  const TAG = "[ReactionChainTracker]";
  const IDLE_TIMEOUT_MS = 60_000;

  if (globalThis.FUCompanion?.api?.reactionChainTracker?.__installed) {
    console.debug(`${TAG} Already installed.`);
    return;
  }

  // chainId -> { used: Map<actorId, Set<skillUuid>>, lastSeen: number }
  const _chains = new Map();

  function sweep() {
    const now = Date.now();
    for (const [chainId, entry] of _chains.entries()) {
      if (now - entry.lastSeen > IDLE_TIMEOUT_MS) {
        _chains.delete(chainId);
      }
    }
  }

  function mintChainId() {
    sweep();
    const id =
      (foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2)) +
      "-" + Date.now().toString(36);
    _chains.set(id, { used: new Map(), lastSeen: Date.now() });
    return id;
  }

  function getOrCreateEntry(chainId) {
    let entry = _chains.get(chainId);
    if (!entry) {
      entry = { used: new Map(), lastSeen: Date.now() };
      _chains.set(chainId, entry);
    } else {
      entry.lastSeen = Date.now();
    }
    return entry;
  }

  function touch(chainId) {
    if (!chainId) return;
    sweep();
    const entry = _chains.get(chainId);
    if (entry) entry.lastSeen = Date.now();
    else _chains.set(chainId, { used: new Map(), lastSeen: Date.now() });
  }

  function markUsed(chainId, actorId, skillUuid) {
    if (!chainId || !actorId || !skillUuid) return;
    sweep();
    const entry = getOrCreateEntry(chainId);
    let actorSet = entry.used.get(String(actorId));
    if (!actorSet) {
      actorSet = new Set();
      entry.used.set(String(actorId), actorSet);
    }
    actorSet.add(String(skillUuid));
    console.debug(`${TAG} markUsed`, { chainId, actorId: String(actorId), skillUuid: String(skillUuid) });
  }

  function isUsed(chainId, actorId, skillUuid) {
    if (!chainId || !actorId || !skillUuid) return false;
    sweep();
    const entry = _chains.get(chainId);
    if (!entry) return false;
    entry.lastSeen = Date.now();
    const actorSet = entry.used.get(String(actorId));
    return !!actorSet?.has(String(skillUuid));
  }

  // Erase a markUsed record so the actor can re-pick the same skill in this
  // chain. Intended for Undo flows that revert a reaction commit.
  function unmarkUsed(chainId, actorId, skillUuid) {
    if (!chainId || !actorId || !skillUuid) return false;
    sweep();
    const entry = _chains.get(chainId);
    if (!entry) return false;
    const actorSet = entry.used.get(String(actorId));
    if (!actorSet) return false;
    const removed = actorSet.delete(String(skillUuid));
    if (actorSet.size === 0) entry.used.delete(String(actorId));
    entry.lastSeen = Date.now();
    if (removed) {
      console.debug(`${TAG} unmarkUsed`, { chainId, actorId: String(actorId), skillUuid: String(skillUuid) });
    }
    return removed;
  }

  function clearAll() {
    if (_chains.size > 0) {
      console.debug(`${TAG} clearAll (${_chains.size} chains)`);
    }
    _chains.clear();
  }

  function debugDump() {
    const now = Date.now();
    return Array.from(_chains.entries()).map(([id, e]) => ({
      chainId: id,
      ageMs: now - e.lastSeen,
      actors: Array.from(e.used.entries()).map(([aid, skills]) => ({
        actorId: aid,
        skills: Array.from(skills)
      }))
    }));
  }

  Hooks.once("ready", () => {
    const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
    root.api = root.api ?? {};
    root.api.reactionChainTracker = {
      __installed: true,
      mintChainId,
      markUsed,
      isUsed,
      unmarkUsed,
      touch,
      clearAll,
      debugDump
    };

    // Scene change → clear. Reaction chains never span scenes.
    Hooks.on("canvasReady", () => clearAll());

    console.debug(`${TAG} Installed.`);
  });
})();
