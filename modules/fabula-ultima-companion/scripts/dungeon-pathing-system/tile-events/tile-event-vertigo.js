// ============================================================================
// Dungeon Pathing — Tile Event: Vertigo
//
// The floor tilts and the light goes out. Landing here afflicts the party with
// Vertigo for N confirmed dungeon steps (default DP.UI.VERTIGO.DEFAULT_MOVES):
// vision collapses to a single tile, Scan Mode locks, and every further move
// auto-confirms with no way back. See dp-vertigo.js for the state machine.
//
// The Blind debuff itself is NOT applied here — it comes from the tile's own
// effectConfig (Apply Active Effect → Blind), which the tile effect engine runs
// immediately after this handler returns. One authority per concern: the tile
// config owns WHICH debuff lands and for how long, dp-vertigo owns the
// exploration-mode consequences. Set the AE's "Duration (dungeon turns)" to
// match the tile's Vertigo duration so the two expire together.
//
// Keep that AE referenced as a CONFIG status ("status:…"), not as the world
// Debuff item's AE uuid — see the BLIND_STATUS_ID note in dp-vertigo.js. The
// item form arrives with an "Item." origin and never turn-ticks, which would
// make Blind permanent.
//
// Per-tile override: flags.<MODULE>.dungeonPathing.vertigoMoves (number).
//
// This tile does NOT clear after triggering — a disorienting stretch of dungeon
// stays disorienting, the same way Gusty and Scorched do.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const MOD = DP?.MODULE_ID ?? "fabula-ultima-companion";
  const TAG = "[DungeonPathing][TileEvent][vertigo]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.VERTIGO, {
    label:             "Vertigo",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      const raw      = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.vertigoMoves`);
      const override = Number(raw);
      const moves    = (Number.isFinite(override) && override > 0)
        ? Math.floor(override)
        : (DP.UI?.VERTIGO?.DEFAULT_MOVES ?? 5);

      const already = DP.Vertigo?.isActive?.() ?? false;

      // Refresh rather than stack — re-entering resets the counter to full.
      await DP.Vertigo?.apply?.(scene ?? canvas?.scene, tileDoc?.id ?? null, moves);

      console.debug(TAG, `${already ? "refreshed" : "applied"} — ${moves} move(s)`);

      // The darkness sting and the overlay are driven by the scene flag landing,
      // so every client reacts in sync (see dp-vertigo.sync). Nothing to play here.
      ui.notifications?.info?.(
        already
          ? `The darkness deepens — Vertigo refreshed (${moves} moves).`
          : `The world tilts and the light dies — Vertigo for ${moves} moves.`
      );
    },
  });
})();
