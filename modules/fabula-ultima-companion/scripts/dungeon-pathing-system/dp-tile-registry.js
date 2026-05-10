// ============================================================================
// Dungeon Pathing System — Tile Type Registry
// Tracks what tile types exist, what their handlers are, and whether the tile
// clears itself after triggering.  New tile types are added by calling:
//   DungeonPathing.TileEventRegistry.register(typeKey, config)
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  const _registry = new Map();

  DP.TileEventRegistry = {
    /**
     * Register a tile event type.
     * @param {string} typeKey   - Unique key, e.g. "random_battle"
     * @param {object} config
     * @param {string}   config.label              - Display name
     * @param {Function} config.handler            - async (tileDoc, tokenDoc, scene) => void
     * @param {boolean}  [config.clearAfterTrigger=true]
     *   When true, the tile becomes "blank" after handler resolves.
     *   Set false for tiles that should remain active (e.g. random_battle repeats).
     */
    register(typeKey, { label, handler, clearAfterTrigger = true } = {}) {
      if (!typeKey || typeof handler !== "function") {
        console.warn("[DungeonPathing][TileEventRegistry] register() requires typeKey + handler function.");
        return;
      }
      _registry.set(String(typeKey), { label: String(label ?? typeKey), handler, clearAfterTrigger });
    },

    /** Get config for a tile type key.  Returns null if not registered. */
    get(typeKey) {
      return _registry.get(String(typeKey ?? "")) ?? null;
    },

    /** All registered types as an array of { typeKey, label, clearAfterTrigger } */
    list() {
      return Array.from(_registry.entries()).map(([typeKey, cfg]) => ({
        typeKey,
        label: cfg.label,
        clearAfterTrigger: cfg.clearAfterTrigger
      }));
    },

    /**
     * Dispatch the event for a given tile type.
     * Returns { ok, cleared } where cleared=true means the tile should become blank.
     */
    async dispatch(typeKey, tileDoc, tokenDoc, scene) {
      const cfg = this.get(typeKey);
      if (!cfg) {
        console.warn(`[DungeonPathing][TileEventRegistry] Unknown tile type: "${typeKey}". No handler found.`);
        return { ok: false, cleared: false };
      }

      try {
        await cfg.handler(tileDoc, tokenDoc, scene);
        return { ok: true, cleared: cfg.clearAfterTrigger };
      } catch (e) {
        console.error(`[DungeonPathing][TileEventRegistry] Handler error for "${typeKey}":`, e);
        return { ok: false, cleared: false };
      }
    }
  };
})();
