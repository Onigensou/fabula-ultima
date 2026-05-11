// ============================================================================
// Dungeon Pathing System — Tile State Tracker
//
// Stores per-tile state in Scene flags so it persists across refreshes.
// Flag path: flags.<MODULE_ID>.dungeonPathing.tileStates
//
// Each entry:
//   { initialType, currentType, initialTexture }
//
// Developer API:
//   DungeonPathing.TileState.resetDungeon(scene)        - reset all to initial
//   DungeonPathing.TileState.clearTile(scene, tileId)   - mark tile as blank
//   DungeonPathing.TileState.mutateTile(scene, tileId, newType, newTexture)
//   DungeonPathing.TileState.getCurrentType(scene, tileId)
//   DungeonPathing.TileState.getInitialType(scene, tileId)
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][TileState]";

  function getStates(scene) {
    return scene?.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY]?.tileStates ?? {};
  }

  async function setStates(scene, states) {
    await scene.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.tileStates`, states);
  }

  function getVisited(scene) {
    return scene?.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY]?.visitedTiles ?? {};
  }

  async function setVisited(scene, visited) {
    await scene.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.visitedTiles`, visited);
  }

  // Infer tile type from name + texture path (legacy fallback, same as prototype)
  function inferType(tileDoc) {
    const name    = String(tileDoc?.name ?? "").toLowerCase();
    const texSrc  = String(tileDoc?.texture?.src ?? "");
    let   texBase = "";
    try {
      texBase = decodeURIComponent(texSrc.split("?")[0]).split("/").pop().toLowerCase();
    } catch {}

    const raw = `${name} ${texBase}`;

    const KNOWN = [
      "random_battle", "random battle", "battle",
      "gold", "blank", "stealth", "chaos", "advantage", "event", "final",
      "story", "fishing", "freeze", "gathering", "hazard", "healing",
      "jump", "poison", "recipe", "settlement", "obstacle", "skill check",
      "skillcheck", "slippery", "trap", "camp", "alert", "door", "treasure",
      "item", "weapon", "armor", "accessory", "consumable",
    ];

    // Map display-name fragments to canonical type keys
    const ALIAS = {
      "random_battle": DP.TILE_TYPES.RANDOM_BATTLE,
      "random battle": DP.TILE_TYPES.RANDOM_BATTLE,
      "battle":        DP.TILE_TYPES.RANDOM_BATTLE,
      "skill check":   DP.TILE_TYPES.SKILL_CHECK,
      "skillcheck":    DP.TILE_TYPES.SKILL_CHECK,
    };

    const hit = KNOWN.find(k => raw.includes(k));
    if (!hit) return DP.TILE_TYPES.UNKNOWN;

    return ALIAS[hit] ?? hit.replace(/\s+/g, "_");
  }

  DP.TileState = {
    /**
     * Ensure a tile has a state entry.  Call this when the graph is first built.
     * Must run as GM (writes scene flags).
     */
    async ensure(scene, tileDoc) {
      if (!game.user?.isGM) return;
      if (!scene || !tileDoc) return;

      const states = getStates(scene);
      const id = tileDoc.id;
      if (states[id]) return;

      const inferredType = inferType(tileDoc);
      const initialTexture = tileDoc.texture?.src ?? null;

      const updated = {
        ...states,
        [id]: {
          initialType:    inferredType,
          currentType:    inferredType,
          initialTexture,
        }
      };

      await setStates(scene, updated).catch(e => console.warn(TAG, "ensure failed", e));
    },

    /** Get the CURRENT type of a tile (after any mutations). */
    getCurrentType(scene, tileId) {
      return getStates(scene)[tileId]?.currentType ?? null;
    },

    /** Get the INITIAL type of a tile (as it was when the dungeon was set up). */
    getInitialType(scene, tileId) {
      return getStates(scene)[tileId]?.initialType ?? null;
    },

    /**
     * Mutate a tile to a new type, optionally updating its texture.
     * Must run as GM.
     */
    async mutateTile(scene, tileId, newType, newTexture = null) {
      if (!game.user?.isGM) return;
      if (!scene || !tileId) return;

      const states  = getStates(scene);
      const current = states[tileId] ?? {};
      const updated = {
        ...states,
        [tileId]: { ...current, currentType: String(newType) }
      };

      await setStates(scene, updated).catch(e => console.warn(TAG, "mutateTile setFlag failed", e));

      if (newTexture) {
        const tileDoc = scene.tiles.get(tileId);
        if (tileDoc) await tileDoc.update({ "texture.src": newTexture }).catch(() => {});
      }
    },

    /**
     * Mark a tile as blank (event consumed).  Optionally updates the visual texture.
     * Must run as GM.
     */
    async clearTile(scene, tileId, { updateTexture = true } = {}) {
      await this.mutateTile(scene, tileId, DP.TILE_TYPES.BLANK);

      if (updateTexture) {
        const tileDoc = scene.tiles.get(tileId);
        if (tileDoc) {
          await tileDoc.update({ "texture.src": DP.BLANK_TILE_SRC }).catch(() => {});
        }
      }
    },

    /**
     * Reset ALL tiles back to their initial state.
     * Restores textures as well.  Intended as a developer tool.
     * Must run as GM.
     */
    async resetDungeon(scene) {
      if (!game.user?.isGM) {
        ui.notifications?.warn?.("Dungeon reset must be run as GM.");
        return;
      }
      if (!scene) return;

      const states = getStates(scene);
      const updated = {};

      for (const [id, entry] of Object.entries(states)) {
        updated[id] = {
          ...entry,
          currentType: entry.initialType,
        };

        if (entry.initialTexture) {
          const tileDoc = scene.tiles.get(id);
          if (tileDoc) await tileDoc.update({ "texture.src": entry.initialTexture }).catch(() => {});
        }
      }

      await setStates(scene, updated).catch(e => console.warn(TAG, "resetDungeon setFlag failed", e));
      await setVisited(scene, {}).catch(e => console.warn(TAG, "resetDungeon clearVisited failed", e));
      ui.notifications?.info?.("Dungeon tiles reset to initial state.");
    },

    /**
     * Mark a tile as visited by the party (enables fast travel eligibility).
     * Must run as GM.
     */
    async markVisited(scene, tileId) {
      if (!game.user?.isGM) return;
      if (!scene || !tileId) return;
      const visited = getVisited(scene);
      if (visited[tileId]) return;
      await setVisited(scene, { ...visited, [tileId]: true })
        .catch(e => console.warn(TAG, "markVisited failed", e));
    },

    /** Returns true if the party has previously stepped on this tile. */
    isVisited(scene, tileId) {
      return !!getVisited(scene)[tileId];
    },

    /** Returns all tileIds the party has visited. */
    getVisitedTileIds(scene) {
      return Object.keys(getVisited(scene));
    },

    /** Raw dump of all tile states for debugging. */
    dump(scene) {
      return { states: getStates(scene), visited: getVisited(scene) };
    }
  };
})();
