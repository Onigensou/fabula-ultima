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

  function getRevealed(scene) {
    return scene?.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY]?.fogRevealed ?? {};
  }

  // Infer tile type from name + texture path (legacy fallback, same as prototype)
  function inferType(tileDoc) {
    const name    = String(tileDoc?.name ?? "").toLowerCase();
    const texSrc  = String(tileDoc?.texture?.src ?? "");
    let   texBase = "";
    try {
      texBase = decodeURIComponent(texSrc.split("?")[0]).split("/").pop().toLowerCase();
    } catch {}

    const KNOWN = [
      "random_battle", "random battle", "battle",
      "gold", "blank", "stealth", "chaos", "advantage", "event", "final",
      "story", "fishing", "freeze", "gathering", "hazard", "healing",
      // Force Move — explicit naming variants
      "force_move", "force move", "forcemove",
      // Force Move — double/triple directional tile naming conventions
      "doubledown", "doubleup", "doubleleft", "doubleright",
      "doublenorth", "doublesouth", "doubleeast", "doublewest",
      "doublenortheast", "doublenorthwest", "doublesoutheast", "doublesouthwest",
      "tripledown", "tripleup", "tripleleft", "tripleright",
      "triplenorth", "triplesouth", "tripleeast", "triplewest",
      "triplenortheast", "triplenorthwest", "triplesoutheast", "triplesouthwest",
      // backward-compat: old "jump" key → force_move
      "jump",
      "poison", "recipe", "settlement", "obstacle", "skill check",
      "skillcheck", "slippery", "trap", "camp", "alert", "door", "treasure",
      "item", "weapon", "armor", "accessory", "consumable",
      "dirt", "gusty", "vertigo",
    ];

    // Map display-name fragments to canonical type keys
    const ALIAS = {
      "random_battle": DP.TILE_TYPES.RANDOM_BATTLE,
      "random battle": DP.TILE_TYPES.RANDOM_BATTLE,
      "battle":        DP.TILE_TYPES.RANDOM_BATTLE,
      "skill check":   DP.TILE_TYPES.SKILL_CHECK,
      "skillcheck":    DP.TILE_TYPES.SKILL_CHECK,
      // Force Move
      "force_move":          DP.TILE_TYPES.FORCE_MOVE,
      "force move":          DP.TILE_TYPES.FORCE_MOVE,
      "forcemove":           DP.TILE_TYPES.FORCE_MOVE,
      "jump":                DP.TILE_TYPES.FORCE_MOVE,
      "doubledown":          DP.TILE_TYPES.FORCE_MOVE,
      "doubleup":            DP.TILE_TYPES.FORCE_MOVE,
      "doubleleft":          DP.TILE_TYPES.FORCE_MOVE,
      "doubleright":         DP.TILE_TYPES.FORCE_MOVE,
      "doublenorth":         DP.TILE_TYPES.FORCE_MOVE,
      "doublesouth":         DP.TILE_TYPES.FORCE_MOVE,
      "doubleeast":          DP.TILE_TYPES.FORCE_MOVE,
      "doublewest":          DP.TILE_TYPES.FORCE_MOVE,
      "doublenortheast":     DP.TILE_TYPES.FORCE_MOVE,
      "doublenorthwest":     DP.TILE_TYPES.FORCE_MOVE,
      "doublesoutheast":     DP.TILE_TYPES.FORCE_MOVE,
      "doublesouthwest":     DP.TILE_TYPES.FORCE_MOVE,
      "tripledown":          DP.TILE_TYPES.FORCE_MOVE,
      "tripleup":            DP.TILE_TYPES.FORCE_MOVE,
      "tripleleft":          DP.TILE_TYPES.FORCE_MOVE,
      "tripleright":         DP.TILE_TYPES.FORCE_MOVE,
      "triplenorth":         DP.TILE_TYPES.FORCE_MOVE,
      "triplesouth":         DP.TILE_TYPES.FORCE_MOVE,
      "tripleeast":          DP.TILE_TYPES.FORCE_MOVE,
      "triplewest":          DP.TILE_TYPES.FORCE_MOVE,
      "triplenortheast":     DP.TILE_TYPES.FORCE_MOVE,
      "triplenorthwest":     DP.TILE_TYPES.FORCE_MOVE,
      "triplesoutheast":     DP.TILE_TYPES.FORCE_MOVE,
      "triplesouthwest":     DP.TILE_TYPES.FORCE_MOVE,
    };

    // Prefer the tile NAME over its texture. A configured tile's name declares
    // its type ("Weapon Tile"), while its texture is often Blank_Tile.png by
    // design (hidden-surprise loot). Matching name+texture together mis-read
    // such tiles as "blank" because "blank" precedes "weapon"/etc. in KNOWN.
    // Fall back to the texture basename only when the name yields no known type.
    const hit = KNOWN.find(k => name.includes(k))
             ?? KNOWN.find(k => texBase.includes(k));
    if (!hit) return DP.TILE_TYPES.UNKNOWN;

    return ALIAS[hit] ?? hit.replace(/\s+/g, "_");
  }

  // Resolve a tile's type purely from its name + texture (legacy name-string
  // matching).  Kept as a thin wrapper around inferType() so callers and the
  // public API don't need to change.
  function resolveType(tileDoc) {
    return inferType(tileDoc);
  }

  // Restoring a tile to its initial type re-arms it, so the spent stamp has to go
  // with it — otherwise ensure() would blank the tile again on the next rebuild.
  async function unstampConsumed(scene, tileId) {
    const td = scene?.tiles?.get(tileId);
    if (!td?.getFlag?.(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`)) return;
    await td.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`).catch(() => {});
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

      const inferredType = resolveType(tileDoc);

      // A tile the party already spent must not come back to life. clearTile
      // stamps `consumed` on the TILE DOCUMENT, which survives the scene flag
      // going missing. Without it, ensure() re-infers the type from the tile's
      // Monk's name — which clearTile deliberately leaves alone ("Consumable
      // Tile" on a blanked tile) and inferType prefers over the texture — so a
      // spent loot tile pays out a second time. Reproduced live 2026-08-28: drop
      // the state entry, rebuild, and currentType came back as `consumable`.
      const consumedRaw = tileDoc.getFlag?.(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`);
      const isConsumed  = consumedRaw === true || consumedRaw === "true";
      const initialTexture = tileDoc.texture?.src ?? null;

      // Write only this tile's entry — avoids broadcasting the full 129-tile object.
      await scene.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.tileStates.${id}`, {
        initialType:    inferredType,
        currentType:    isConsumed ? DP.TILE_TYPES.BLANK : inferredType,
        initialTexture,
      }).catch(e => console.warn(TAG, "ensure failed", e));
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
      // Write only this tile's entry — avoids broadcasting the full 129-tile object.
      await scene.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.tileStates.${tileId}`, {
        ...current, currentType: String(newType)
      }).catch(e => console.warn(TAG, "mutateTile setFlag failed", e));

      // Explicitly retyping a tile to something live re-arms it.
      if (String(newType) !== DP.TILE_TYPES.BLANK) {
        const td = scene.tiles.get(tileId);
        if (td?.getFlag?.(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`)) {
          await td.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`).catch(() => {});
        }
      }

      if (newTexture) {
        const tileDoc = scene.tiles.get(tileId);
        if (tileDoc) await tileDoc.update({ "texture.src": newTexture }, { dungeonPathing: true }).catch(() => {});
      }
    },

    /**
     * Mark a tile as blank (event consumed).  Optionally updates the visual texture.
     * Must run as GM.
     */
    async clearTile(scene, tileId, { updateTexture = true } = {}) {
      await this.mutateTile(scene, tileId, DP.TILE_TYPES.BLANK);

      // Durable, per-tile record that this one is spent — see ensure() above.
      const spentDoc = scene.tiles.get(tileId);
      if (spentDoc) {
        await spentDoc.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`, true)
          .catch(e => console.warn(TAG, "clearTile: consumed stamp failed", e));
      }

      if (updateTexture) {
        const tileDoc = scene.tiles.get(tileId);
        if (tileDoc) {
          await tileDoc.update({ "texture.src": DP.BLANK_TILE_SRC }, { dungeonPathing: true }).catch(() => {});
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

      const states  = getStates(scene);
      const visited = getVisited(scene);
      const stateCount   = Object.keys(states).length;
      const visitedCount = Object.keys(visited).length;
      console.log(TAG, `resetDungeon — scene: ${scene.name} (${scene.id})`);
      console.log(TAG, `resetDungeon — tile states: ${stateCount}, visited tiles: ${visitedCount}`);

      // Restore tile states + textures
      const updated = {};
      for (const [id, entry] of Object.entries(states)) {
        updated[id] = { ...entry, currentType: entry.initialType };
        await unstampConsumed(scene, id);
        if (entry.initialTexture) {
          const tileDoc = scene.tiles.get(id);
          if (tileDoc) await tileDoc.update({ "texture.src": entry.initialTexture }).catch(() => {});
        }
      }
      await setStates(scene, updated).catch(e => console.warn(TAG, "resetDungeon — setStates failed:", e));
      console.log(TAG, `resetDungeon — tile states restored to initial (${stateCount} tile(s)).`);

      // Clear visited — setFlag with {} is a no-op due to Foundry's mergeObject semantics
      // (merging {} into {tile1:true} leaves tile1 untouched).  unsetFlag sends a
      // -=visitedTiles deletion instruction which actually removes the key.
      await scene.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.visitedTiles`)
        .catch(e => console.warn(TAG, "resetDungeon — clearVisited failed:", e));
      console.log(TAG, `resetDungeon — visited cleared. Post-reset visited:`, getVisited(scene));

      // Clear fog reveals so fog tiles are hidden again after reset.
      await scene.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fogRevealed`)
        .catch(e => console.warn(TAG, "resetDungeon — clearFogRevealed failed:", e));
      DP.Fog?.destroyAll?.();
      console.log(TAG, "resetDungeon — fog reveals cleared.");

      ui.notifications?.info?.("Dungeon reset: all tiles restored and visited flags cleared.");
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
      // Write only this tile's entry — avoids broadcasting the full visited-tiles object.
      await scene.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.visitedTiles.${tileId}`, true)
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

    /**
     * Unmark a tile as visited. Must run as GM.
     */
    async unmarkVisited(scene, tileId) {
      if (!game.user?.isGM) return;
      if (!scene || !tileId) return;
      const visited = getVisited(scene);
      if (!visited[tileId]) return;
      await scene.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.visitedTiles.${tileId}`)
        .catch(e => console.warn(TAG, "unmarkVisited failed", e));
    },

    /**
     * Mark a fog tile as revealed (its overlay should be removed on all clients).
     * Must run as GM — scene flag writes require GM authority.
     */
    async markFogRevealed(scene, tileId) {
      if (!game.user?.isGM) return;
      if (!scene || !tileId) return;
      const revealed = getRevealed(scene);
      if (revealed[tileId]) return;
      await scene.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fogRevealed.${tileId}`, true)
        .catch(e => console.warn(TAG, "markFogRevealed failed", e));
    },

    /** Returns true if this fog tile has already been revealed. */
    isFogRevealed(scene, tileId) {
      return !!getRevealed(scene)[tileId];
    },

    /**
     * Un-reveal a single shroud tile, restoring its fog overlay.
     * Must run as GM.
     */
    async unmarkFogRevealed(scene, tileId) {
      if (!game.user?.isGM) return;
      if (!scene || !tileId) return;
      const revealed = getRevealed(scene);
      if (!revealed[tileId]) return;
      await scene.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fogRevealed.${tileId}`)
        .catch(e => console.warn(TAG, "unmarkFogRevealed failed", e));
    },

    /**
     * Reset tile states and visited flags only — does not touch fog/shroud reveals.
     * Must run as GM.
     */
    async resetTiles(scene) {
      if (!game.user?.isGM) {
        ui.notifications?.warn?.("Dungeon reset must be run as GM.");
        return;
      }
      if (!scene) return;

      const states     = getStates(scene);
      const stateCount = Object.keys(states).length;
      console.log(TAG, `resetTiles — scene: ${scene.name} (${scene.id}), tile states: ${stateCount}`);

      const updated = {};
      for (const [id, entry] of Object.entries(states)) {
        updated[id] = { ...entry, currentType: entry.initialType };
        await unstampConsumed(scene, id);
        if (entry.initialTexture) {
          const tileDoc = scene.tiles.get(id);
          if (tileDoc) await tileDoc.update({ "texture.src": entry.initialTexture }).catch(() => {});
        }
      }
      await setStates(scene, updated).catch(e => console.warn(TAG, "resetTiles — setStates failed:", e));
      await scene.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.visitedTiles`)
        .catch(e => console.warn(TAG, "resetTiles — clearVisited failed:", e));

      console.log(TAG, `resetTiles — done (${stateCount} tile(s) restored).`);
      ui.notifications?.info?.("Tile states and visited tiles reset.");
    },

    /**
     * Reset only tiles flagged "Reset on rest" back to their initial state
     * (currentType → initialType, texture → initialTexture).  Scans EVERY scene
     * because a rest is performed on a camp scene while the dungeon tiles live
     * on a different (non-active) scene.  Also clears each reset tile's visited
     * flag so it can be re-triggered.  Must run as GM.
     *
     * Triggered automatically by the "fabula.restPerformed" hook (see bottom).
     */
    async resetOnRestTiles() {
      if (!game.user?.isGM) return;

      let total = 0;
      for (const scene of game.scenes ?? []) {
        const states = getStates(scene);
        if (!Object.keys(states).length) continue;

        const updated   = { ...states };
        const visited   = { ...getVisited(scene) };
        let   touched   = false;
        let   visitedHit = false;

        for (const [id, entry] of Object.entries(states)) {
          const tileDoc = scene.tiles.get(id);
          const onRest  = tileDoc?.getFlag?.(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.resetOnRest`);
          if (!(onRest === true || onRest === "true")) continue;

          // Nothing to do if the tile is already at its initial state.
          if (entry.currentType === entry.initialType) {
            if (visited[id]) { delete visited[id]; visitedHit = true; }
            continue;
          }

          updated[id] = { ...entry, currentType: entry.initialType };
          await unstampConsumed(scene, id);
          touched = true;
          total++;
          if (entry.initialTexture && tileDoc) {
            await tileDoc.update({ "texture.src": entry.initialTexture }, { dungeonPathing: true })
              .catch(() => {});
          }
          if (visited[id]) { delete visited[id]; visitedHit = true; }
        }

        if (touched) {
          await setStates(scene, updated)
            .catch(e => console.warn(TAG, "resetOnRestTiles — setStates failed:", e));
        }
        if (visitedHit) {
          await scene.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.visitedTiles`, visited)
            .catch(e => console.warn(TAG, "resetOnRestTiles — visited update failed:", e));
        }
      }

      if (total) console.debug(TAG, `resetOnRestTiles — ${total} tile(s) reset on rest.`);
    },

    /**
     * Clear ALL shroud reveals for a scene without touching tile states or visited tiles.
     * Use when setting up for a fresh group.  Must run as GM.
     */
    async resetAllFogRevealed(scene) {
      if (!game.user?.isGM) return;
      if (!scene) return;
      await scene.unsetFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fogRevealed`)
        .catch(e => console.warn(TAG, "resetAllFogRevealed failed", e));
    },

    /**
     * Back-fill the `consumed` stamp onto tiles that were spent BEFORE the stamp
     * existed — any tile whose state says blank while its initial type was
     * something live. Those are exactly the tiles that would resurrect if their
     * scene-flag entry were ever lost. Idempotent; safe to run repeatedly.
     * Pass no scene to sweep every scene in the world. Must run as GM.
     */
    async repairConsumedStamps(scene = null) {
      if (!game.user?.isGM) return { scanned: 0, stamped: 0 };
      const scenes = scene ? [scene] : [...game.scenes];
      let scanned = 0, stamped = 0;
      const details = [];
      for (const sc of scenes) {
        const states = getStates(sc);
        for (const [id, st] of Object.entries(states)) {
          scanned++;
          if (!st || st.currentType !== DP.TILE_TYPES.BLANK) continue;
          if (!st.initialType || st.initialType === DP.TILE_TYPES.BLANK) continue;
          const td = sc.tiles.get(id);
          if (!td) continue;
          const raw = td.getFlag?.(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`);
          if (raw === true || raw === "true") continue;
          await td.setFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.consumed`, true)
            .catch(e => console.warn(TAG, "repairConsumedStamps failed", e));
          stamped++;
          details.push({ scene: sc.name, tileId: id, was: st.initialType });
        }
      }
      if (stamped) console.log(TAG, `repairConsumedStamps — stamped ${stamped} spent tile(s)`, details);
      return { scanned, stamped, details };
    },

    /** Resolve a tile's type (explicit flag, else name/texture inference). */
    resolveType(tileDoc) { return resolveType(tileDoc); },

    /** Raw dump of all tile states for debugging. */
    dump(scene) {
      return { states: getStates(scene), visited: getVisited(scene), fogRevealed: getRevealed(scene) };
    }
  };

  // ── Reset-on-rest: restore flagged tiles when the party rests ───────────────
  // RestAPI.perform() fires this hook after restoring the party (GM context).
  Hooks.on("fabula.restPerformed", () => {
    DP.TileState.resetOnRestTiles()
      .catch(e => console.warn(TAG, "resetOnRestTiles (rest hook) failed:", e));
  });
})();
