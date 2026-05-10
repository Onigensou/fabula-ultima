// ============================================================================
// Dungeon Pathing System — Event Emitter
// All Hooks.callAll() emissions for the dungeon turn lifecycle.
// Developers can listen via:  Hooks.on("dungeonPathing.turnStart", handler)
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  DP.Events = {
    /** Fired at the start of a player's movement turn. */
    turnStart(tokenDoc, currentNode) {
      Hooks.callAll(DP.HOOKS.TURN_START, { tokenDoc, currentNode });
    },

    /** Fired after the token has moved to the destination (pre-confirmation). */
    tokenMoved(tokenDoc, fromNode, toNode) {
      Hooks.callAll(DP.HOOKS.TOKEN_MOVED, { tokenDoc, fromNode, toNode });
    },

    /** Fired when the player confirms landing on the destination tile. */
    turnConfirmed(tokenDoc, fromNode, toNode, tileDoc) {
      Hooks.callAll(DP.HOOKS.TURN_CONFIRMED, { tokenDoc, fromNode, toNode, tileDoc });
    },

    /** Fired when the player chooses to revert and go back. */
    turnReverted(tokenDoc, fromNode, toNode) {
      Hooks.callAll(DP.HOOKS.TURN_REVERTED, { tokenDoc, fromNode, toNode });
    },

    /** Fired just before the tile event handler runs. */
    tileEvent(tokenDoc, node, tileDoc, tileType) {
      Hooks.callAll(DP.HOOKS.TILE_EVENT, { tokenDoc, node, tileDoc, tileType });
    },

    /** Fired after the tile event has resolved and the turn is complete. */
    turnEnd(tokenDoc, node) {
      Hooks.callAll(DP.HOOKS.TURN_END, { tokenDoc, node });
    },

    /** Fired after the graph is rebuilt (scene change, tile update, etc). */
    graphRebuilt(graph, partyToken) {
      Hooks.callAll(DP.HOOKS.GRAPH_REBUILT, { graph, partyToken });
    }
  };
})();
