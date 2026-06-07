// ============================================================================
// Dungeon Pathing — Tile Event: Gusty
//
// A windy area that may blow the party backward when they step on it.
//
// Flow:
//   1. Party lands → confirm dialog (normal behaviour)
//   2. Check Gate fires — default: Group Check (DEX + MIG, DL 10)
//      Players resolve the check via the Check Requester UI.
//   3. Success → notification "The wind subsides — the party holds their ground."
//      Nothing further happens.
//   4. Failure → token is pushed back one tile in the exact reverse of the
//      direction the party entered from (PUSH_BACK logic), then
//      processArrivalAt fires for the destination tile.
//
// The GM may override check type, attributes, DL, and trigger condition
// via the tile config "Check Gate" section.
//
// This tile does NOT clear after triggering — gusty areas are permanent.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][gusty]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // ── Party member resolution (mirrors dp-tile-effect-engine pattern) ────────
  async function resolvePartyMembers() {
    const api = window.FUCompanion?.api;
    let partyActor = null;
    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb().catch(() => null);
      partyActor = res?.db ?? null;
    }
    if (!partyActor) { console.warn(TAG, "Party actor not resolved."); return []; }

    const props   = partyActor.system?.props ?? {};
    const members = [];
    for (let i = 1; i <= 4; i++) {
      const rawId = String(props[`member_id_${i}`] ?? "").trim();
      if (!rawId) continue;
      let actor = null;
      try {
        actor = /^Actor\./i.test(rawId)
          ? await fromUuid(rawId)
          : (game.actors.get(rawId) ?? await fromUuid(`Actor.${rawId}`).catch(() => null));
      } catch {}
      if (actor) members.push(actor);
    }
    return members;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.GUSTY, {
    label:             "Gusty",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      // ── 1. Read check gate config (defaults: group, DEX+MIG, DL 10, on failure) ──
      const cfg = DP.TileCheckGate?.readConfig(tileDoc) ?? {
        enabled:    true,
        mode:       "group",
        leaderMode: "players_choose",
        attrA:      "DEX",
        attrB:      "MIG",
        dl:         10,
        triggerOn:  "failure",
        label:      "",
      };

      // Force enabled for Gusty — the check is the tile's core mechanic.
      cfg.enabled   = true;
      cfg.triggerOn = cfg.triggerOn || "failure";
      if (!cfg.label) cfg.label = tileDoc?.name || "Resist the Wind";

      // ── 2. Resolve party members ────────────────────────────────────────────
      const actors = await resolvePartyMembers();
      if (!actors.length) {
        console.warn(TAG, "No party members found — skipping Gusty check.");
        return;
      }

      // ── 3. Run the check gate ───────────────────────────────────────────────
      if (!DP.TileCheckGate?.request) {
        console.warn(TAG, "DP.TileCheckGate not available — skipping check.");
        return;
      }

      const { triggered } = await DP.TileCheckGate.request(actors, cfg);

      // ── 4a. Success — party holds ground ───────────────────────────────────
      if (!triggered) {
        ui.notifications?.info("The wind subsides — the party holds their ground.");
        return;
      }

      // ── 4b. Failure — push the token back ──────────────────────────────────
      const graph = globalThis.__ONI_DUNGEON_PATHING__?.graph;
      if (!graph) { console.warn(TAG, "Graph not available."); return; }

      const gustyNode = graph.nodeMap.get(tileDoc.id);
      if (!gustyNode) { console.warn(TAG, "Gusty tile node not in graph:", tileDoc.id); return; }

      const token = canvas.tokens?.get(tokenDoc.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === tokenDoc.id);
      if (!token) { console.warn(TAG, "Token placeable not found:", tokenDoc.id); return; }

      const entryDir = DP.Direction?.lastEntryDirection;
      if (!entryDir || !DP.Direction?.DIRS?.[entryDir]) {
        ui.notifications?.warn("Gusty | No entry direction known — cannot push back.");
        return;
      }

      const reverseDir = DP.Direction.reverseDirection(entryDir);
      if (!reverseDir) {
        ui.notifications?.warn(`Gusty | Cannot reverse direction "${entryDir}".`);
        return;
      }

      // Walk one step in the reverse direction (supports branching paths).
      const candidates = DP.Direction.getNeighborsInDirection(gustyNode, reverseDir, graph);
      if (!candidates.length) {
        ui.notifications?.warn("Gusty | No tile behind the party — they brace against a wall!");
        return;
      }
      const destNode = candidates[Math.floor(Math.random() * candidates.length)];

      console.debug(TAG, `Blown back | "${gustyNode.name}" → "${destNode.name}" (${DP.Direction.label(reverseDir)})`);

      // Update direction state so any chained tiles know which way the party arrived.
      DP.Direction.lastEntryDirection = reverseDir;

      const _bState = globalThis.__ONI_DUNGEON_PATHING__?.state;
      if (_bState) _bState.forcedNodeId = destNode.nodeId;

      await DP.Movement.moveToNode(token, destNode);

      const bootstrap = globalThis.__ONI_DUNGEON_PATHING__;
      if (bootstrap?.processArrivalAt) {
        await bootstrap.processArrivalAt(destNode, token, scene, gustyNode);
      }
    },
  });
})();
