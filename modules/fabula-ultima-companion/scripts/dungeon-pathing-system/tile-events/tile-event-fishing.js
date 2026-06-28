// ============================================================================
// Dungeon Pathing — Tile Event: Fishing
//
// On landing, opens a participation lobby (ONI.FishingLobby) asking which party
// members want to fish. Each joined angler then plays the camp Fishing minigame
// ONCE, in sequence (the minigame UI is a singleton, so sessions can't overlap).
// After everyone has fished, the tile is cleared (blanked) to prevent an
// infinite-fish loop. Pair with the "Reset on rest" tile flag to let it refresh
// each expedition.
//
// Reuses the existing camp Fishing implementation verbatim:
//   CampSystem.ActivityRegistry.get("fishing").execute(actor)
// — which is fully self-contained and GM-orchestrated, so it runs identically
// outside a camp scene.
//
// GM routing mirrors tile-event-treasure: the minigame must be driven by the GM
// client (it broadcasts sockets + awaits owner input), so a player-triggered
// landing emits to the GM, who runs the whole flow. clearAfterTrigger:false —
// the GM clears the tile itself when the flow finishes.
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing;
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEvent][fishing]";
  const MSG_TYPE  = "DP_TRIGGER_FISHING";
  const SOCKET_CH = `module.${MODULE_ID}`;

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // Tiles whose fishing flow is currently running (re-entry guard, GM-side).
  const _busy = new Set();

  // ── Party resolution (member_id_1..4 on the DB actor) ──────────────────────
  async function resolvePartyMembers() {
    const api = window.FUCompanion?.api;
    let partyActor = null;
    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb().catch(() => null);
      partyActor = res?.source ?? res?.db ?? null;
    }
    if (!partyActor) { console.warn(TAG, "Party/DB actor not resolved."); return []; }

    const props   = partyActor.system?.props ?? {};
    const members = [];
    for (let i = 1; i <= 4; i++) {
      const rawId = String(props[`member_id_${i}`] ?? "").trim();
      if (!rawId) continue;
      let actor = game.actors.get(rawId) ?? null;
      if (!actor && rawId.includes(".")) actor = await fromUuid(rawId).catch(() => null);
      if (!actor) actor = await fromUuid(`Actor.${rawId}`).catch(() => null);
      if (actor) members.push(actor);
    }
    return members;
  }

  // ── Main flow (GM only) ────────────────────────────────────────────────────
  async function runFishing(scene, tileDoc) {
    if (!game.user?.isGM) return;
    if (!scene || !tileDoc) return;
    if (_busy.has(tileDoc.id)) { console.debug(TAG, "Already running for this tile; ignoring."); return; }
    _busy.add(tileDoc.id);

    try {
      const CAMP    = globalThis.CampSystem;
      const fishing = CAMP?.ActivityRegistry?.get("fishing");
      if (!fishing?.execute) {
        ui.notifications?.warn("Fishing | Camp Fishing activity not loaded.");
        return;
      }

      const members = await resolvePartyMembers();
      if (!members.length) {
        ui.notifications?.warn("Fishing | No party members found to fish.");
        return;
      }

      // Ask who wants to participate.
      let participants;
      try {
        participants = await ONI.FishingLobby.request({
          allActorUuids: members.map(a => a.uuid),
          label:         tileDoc?.name ?? "",
        });
      } catch (e) {
        console.debug(TAG, "Lobby cancelled — tile left active.", e?.message);
        return;   // cancelled → don't clear, party can step on it again
      }
      if (!participants?.length) return;

      // Each angler fishes ONE round, in sequence (the UI is a singleton).
      // 4 party members → 4 rounds total across the table.
      for (const actor of participants) {
        await fishing.execute(actor, null, { totalRounds: 1 })
          .catch(e => console.error(TAG, `Fishing session failed for ${actor?.name}:`, e));
      }

      // Done — blank the tile so it can't be re-fished (until a rest, if flagged).
      await DP.TileState.clearTile(scene, tileDoc.id)
        .catch(e => console.warn(TAG, "clearTile failed:", e));
    } finally {
      _busy.delete(tileDoc.id);
    }
  }

  // ── GM-side socket listener (player-triggered landings route here) ─────────
  function setupSocketListener() {
    const GUARD = "__ONI_DP_FISHING_SOCKET__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (msg?.type !== MSG_TYPE) return;
      if (!game.user?.isGM) return;
      // Multi-GM dedupe: both GMs receive the player's trigger. Gate to the
      // primary GM so only one fishing lobby opens (the _busy guard below is
      // per-client and does NOT prevent the second GM from opening its own).
      if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;

      const { sceneId, tileId } = msg.payload ?? {};
      const scene   = game.scenes.get(sceneId);
      const tileDoc = scene?.tiles.get(tileId);
      if (!scene || !tileDoc) {
        console.warn(TAG, "Could not resolve scene/tile from socket", { sceneId, tileId });
        return;
      }
      runFishing(scene, tileDoc);   // fire-and-forget; don't block the socket callback
    });

    console.debug(TAG, "GM socket listener installed.");
  }

  // ── Registration ───────────────────────────────────────────────────────────
  DP.TileEventRegistry.register(DP.TILE_TYPES.FISHING, {
    label:             "Fishing",
    clearAfterTrigger: false,   // GM clears the tile itself after the flow completes

    async handler(tileDoc, tokenDoc, scene) {
      // Fire-and-forget: the minigame is a full-screen overlay that runs
      // independently of the dungeon turn flow, so we never block dispatch.
      if (game.user?.isGM) {
        runFishing(scene, tileDoc);
      } else {
        game.socket.emit(SOCKET_CH, {
          type:    MSG_TYPE,
          payload: { sceneId: scene?.id, tileId: tileDoc?.id, tokenId: tokenDoc?.id },
        });
      }
    },
  });

  Hooks.once("ready", () => { setupSocketListener(); });
})();
