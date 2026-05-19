// ============================================================================
// Save System — Domain Extractors
//
// Each extractor is registered in apply order:
//   1.  databasePointer     – which party database is active
//   2.  partyActorData      – full props of the party/database actor
//   3.  partyData           – individual member + bench character props
//   4.  npcData             – linked NPCs/bosses matching NPC template
//   5.  activeScene         – which scene is currently active
//   6.  sceneBackgrounds    – background image per scene (story progression)
//   7.  dungeonTileData     – DungeonPathing flags (tileStates + visitedTiles)
//   8.  sceneTileVisibility – tile.hidden per scene (treasure chests etc.)
//   9.  campState           – CampSystem world settings
//   10. encyclopediaData    – Monster Encyclopedia journal page flags + content
//   11. journalOwnership    – ownership map of every journal entry
//
// To add a new domain in future: call SS.registerExtractor({ key, label, extract, apply })
// anywhere that runs before the first save.
// ============================================================================
(() => {
  const SS  = globalThis.SaveSystem ??= {};
  const MOD = SS.MODULE_ID;
  const TAG = "[SaveSystem][Extractors]";

  // fromUuid inside module IIFEs can fail silently; use game.actors.get() directly
  // for world actors which are always already in memory.
  function actorFromUuid(uuid) {
    if (!uuid || typeof uuid !== "string") return null;
    const rawId = uuid.startsWith("Actor.") ? uuid.slice(6) : uuid;
    return game.actors.get(rawId) ?? null;
  }

  // ── 1. Database Pointer ────────────────────────────────────────────────────
  SS.registerExtractor({
    key:   "databasePointer",
    label: "Database Pointer",

    async extract({ currentGame }) {
      if (!currentGame) return null;
      return {
        gameActorUuid: currentGame.uuid,
        gameId:        currentGame.system?.props?.game_id ?? null,
      };
    },

    async apply(ctx, data) {
      if (!data?.gameId) return;
      const cg = SS.Core.findCurrentGameActor();
      if (!cg) { console.warn(TAG, "databasePointer apply: Current Game actor not found"); return; }
      const props = foundry.utils.deepClone(cg.system?.props ?? {});
      props.game_id = data.gameId;
      await cg.update({ "system.props": props });
    },
  });

  // ── 2. Party Actor (Database) Props ───────────────────────────────────────
  SS.registerExtractor({
    key:   "partyActorData",
    label: "Party Actor",

    async extract({ partyActor }) {
      if (!partyActor) return null;
      return {
        uuid:  partyActor.uuid,
        props: foundry.utils.deepClone(partyActor.system?.props ?? {}),
      };
    },

    async apply(ctx, data) {
      if (!data?.uuid) return;
      const pa = actorFromUuid(data.uuid);
      if (!pa) { console.warn(TAG, "partyActorData apply: not found", data.uuid); return; }
      await pa.update({ "system.props": data.props });
    },
  });

  // ── 3. Party Members & Bench Characters ───────────────────────────────────
  SS.registerExtractor({
    key:   "partyData",
    label: "Party Members",

    async extract({ memberUuids }) {
      const result = {};
      for (const uuid of memberUuids) {
        const actor = actorFromUuid(uuid);
        if (!actor) continue;
        result[uuid] = {
          name:  actor.name,
          props: foundry.utils.deepClone(actor.system?.props ?? {}),
        };
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      for (const [uuid, { props }] of Object.entries(data)) {
        const actor = actorFromUuid(uuid);
        if (!actor) { console.warn(TAG, "partyData apply: not found", uuid); continue; }
        await actor.update({ "system.props": props });
      }
    },
  });

  // ── 4. Linked NPCs & Bosses ────────────────────────────────────────────────
  // Detection: system.template === npcTemplateId AND prototypeToken.actorLink === true
  // Unlinked actors (generic random-encounter monsters) are excluded — they
  // spawn fresh each encounter and their data does not persist.
  SS.registerExtractor({
    key:   "npcData",
    label: "Linked NPCs & Bosses",

    async extract({ memberUuids }) {
      const npcTemplateId = SS.Storage.getNpcTemplateId();
      const memberSet     = new Set(memberUuids);
      const result = {};

      for (const actor of game.actors.contents) {
        if (actor.system?.template !== npcTemplateId) continue;
        if (!actor.prototypeToken?.actorLink) continue;
        if (memberSet.has(actor.uuid)) continue; // already captured in partyData
        result[actor.uuid] = {
          name:  actor.name,
          props: foundry.utils.deepClone(actor.system?.props ?? {}),
        };
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      for (const [uuid, { props }] of Object.entries(data)) {
        const actor = actorFromUuid(uuid);
        if (!actor) { console.warn(TAG, "npcData apply: not found", uuid); continue; }
        await actor.update({ "system.props": props });
      }
    },
  });

  // ── 5. Active Scene ────────────────────────────────────────────────────────
  SS.registerExtractor({
    key:   "activeScene",
    label: "Active Scene",

    async extract() {
      const s = game.scenes.active;
      return s ? { sceneId: s.id, sceneName: s.name } : null;
    },

    async apply(ctx, data) {
      if (!data?.sceneId) return;
      const scene = game.scenes.get(data.sceneId);
      if (scene) await scene.activate();
    },
  });

  // ── 6. Scene Backgrounds ──────────────────────────────────────────────────
  // Captures the background image for every scene — scenes can gain new
  // background images as story progresses and need to be restored per-save.
  SS.registerExtractor({
    key:   "sceneBackgrounds",
    label: "Scene Backgrounds",

    async extract() {
      const result = {};
      for (const scene of game.scenes.contents) {
        const bg = scene.background?.src;
        if (bg) result[scene.id] = bg;
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      await Promise.all(
        Object.entries(data).map(([id, bg]) => {
          const scene = game.scenes.get(id);
          if (!scene || scene.background?.src === bg) return null;
          return scene.update({ "background.src": bg });
        }).filter(Boolean)
      );
    },
  });

  // ── 7. Dungeon Tile States (DungeonPathing flags) ─────────────────────────
  // Saves tileStates (currentType/initialType) and visitedTiles per dungeon scene.
  SS.registerExtractor({
    key:   "dungeonTileData",
    label: "Dungeon Tile States",

    async extract() {
      const DP_KEY = "dungeonPathing";
      const result = {};
      for (const scene of game.scenes.contents) {
        const dp = scene.flags?.[MOD]?.[DP_KEY];
        if (!dp || (!dp.tileStates && !dp.visitedTiles)) continue;
        result[scene.id] = {
          tileStates:   foundry.utils.deepClone(dp.tileStates   ?? {}),
          visitedTiles: foundry.utils.deepClone(dp.visitedTiles ?? {}),
        };
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      const DP_KEY = "dungeonPathing";
      for (const [sceneId, { tileStates, visitedTiles }] of Object.entries(data)) {
        const scene = game.scenes.get(sceneId);
        if (!scene) continue;
        await scene.setFlag(MOD, `${DP_KEY}.tileStates`, tileStates);
        // unsetFlag first to clear old visited map (mergeObject semantics won't delete keys)
        await scene.unsetFlag(MOD, `${DP_KEY}.visitedTiles`).catch(() => {});
        if (Object.keys(visitedTiles).length > 0) {
          await scene.setFlag(MOD, `${DP_KEY}.visitedTiles`, visitedTiles);
        }
      }
    },
  });

  // ── 8. Scene Tile Visibility ───────────────────────────────────────────────
  // Saves tile.hidden for every tile in every scene.
  // Treasure chests opened (hidden) in session A must be visible again in session B.
  SS.registerExtractor({
    key:   "sceneTileVisibility",
    label: "Scene Tile Visibility",

    async extract() {
      const result = {};
      for (const scene of game.scenes.contents) {
        if (!scene.tiles?.size) continue;
        const states = {};
        for (const tile of scene.tiles.values()) {
          states[tile.id] = tile.hidden ?? false;
        }
        result[scene.id] = states;
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      await Promise.all(
        Object.entries(data).map(async ([sceneId, tileStates]) => {
          const scene = game.scenes.get(sceneId);
          if (!scene) return;
          const updates = Object.entries(tileStates)
            .filter(([id, hidden]) => {
              const tile = scene.tiles.get(id);
              return tile && tile.hidden !== hidden;
            })
            .map(([id, hidden]) => ({ _id: id, hidden }));
          if (updates.length) await scene.updateEmbeddedDocuments("Tile", updates);
        })
      );
    },
  });

  // ── 9. Camp State ──────────────────────────────────────────────────────────
  // Captures all CampSystem world settings (phase, selections, bonds, etc.)
  SS.registerExtractor({
    key:   "campState",
    label: "Camp State",

    async extract() {
      const CAMP = globalThis.CampSystem;
      if (!CAMP?.SETTING) return null;
      const result = {};
      for (const key of Object.values(CAMP.SETTING)) {
        try { result[key] = game.settings.get(MOD, key); }
        catch { /* not yet registered — skip */ }
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data || !game.user?.isGM) return;
      for (const [key, value] of Object.entries(data)) {
        try { await game.settings.set(MOD, key, value); }
        catch { /* setting may not exist in this world */ }
      }
    },
  });

  // ── 10. Monster Encyclopedia ───────────────────────────────────────────────
  // Saves the study result flags and rendered content for every encyclopedia page.
  SS.registerExtractor({
    key:   "encyclopediaData",
    label: "Monster Encyclopedia",

    async extract() {
      const api   = globalThis.FUCompanion?.api?.encyclopedia;
      const entry = api?.getEntry?.();
      if (!entry) return null;
      const pages = [];
      for (const page of entry.pages.values()) {
        const encFlag = page.flags?.[MOD]?.encyclopedia;
        if (!encFlag?.actorUuid) continue;
        pages.push({
          actorUuid: encFlag.actorUuid,
          encFlag:   foundry.utils.deepClone(encFlag),
          content:   page.text?.content ?? "",
        });
      }
      return { pages };
    },

    async apply(ctx, data) {
      if (!data || !game.user?.isGM) return;
      const api   = globalThis.FUCompanion?.api?.encyclopedia;
      const entry = api?.getEntry?.();
      if (!entry) return;
      for (const { actorUuid, encFlag, content } of data.pages) {
        const page = [...entry.pages.values()].find(
          p => p.flags?.[MOD]?.encyclopedia?.actorUuid === actorUuid
        );
        if (!page) continue;
        await page.update({
          [`flags.${MOD}.encyclopedia`]: encFlag,
          "text.content": content,
        });
      }
    },
  });

  // ── 11. Journal Ownership ──────────────────────────────────────────────────
  // Journals revealed in session A should remain hidden when loading session B.
  SS.registerExtractor({
    key:   "journalOwnership",
    label: "Journal Ownership",

    async extract() {
      const result = {};
      for (const entry of game.journal.contents) {
        result[entry.id] = foundry.utils.deepClone(entry.ownership ?? {});
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data || !game.user?.isGM) return;
      await Promise.all(
        Object.entries(data).map(([id, ownership]) => {
          const entry = game.journal.get(id);
          if (!entry) return null;
          if (JSON.stringify(entry.ownership) === JSON.stringify(ownership)) return null;
          return entry.update({ ownership });
        }).filter(Boolean)
      );
    },
  });

  console.debug(TAG, "Extractors registered:", SS._extractors.map(e => e.key).join(", "));
})();
