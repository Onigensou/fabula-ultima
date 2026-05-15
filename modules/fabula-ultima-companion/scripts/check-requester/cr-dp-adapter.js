// ============================================================================
// Check Requester — Dungeon Pathing Adapter
//
// Thin wrapper around ONI.CheckRequester (cr-api.js).
// Translates tile-effect config fields into CheckRequester options and
// exposes DP.TileSkillCheck.request() for dp-tile-effect-engine.js.
//
// Physically part of the check-requester system; logically bridges into
// dungeon-pathing-system so it registers under the DP namespace.
// ============================================================================

(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[ONI][CheckRequester:DPAdapter]";

  DP.TileSkillCheck = {
    /**
     * Called by runSkillCheckGate() in dp-tile-effect-engine.js.
     * @param {Actor[]}  actors
     * @param {object}   cfg     — tile effect config (checkAttrA/B, checkDl, checkApplyOn)
     * @param {object}   context — { tileLabel }
     * @returns {Promise<{actorUuid: string, pass: boolean}[]>}
     */
    async request(actors, cfg, context = {}) {
      if (!game.user?.isGM)
        throw new Error(`${TAG} request() must be called on the GM client.`);

      const CR = globalThis.ONI?.CheckRequester;
      if (!CR?.request) {
        console.warn(TAG, "ONI.CheckRequester not loaded — skipping check, all actors fail.");
        return actors.map(a => ({ actorUuid: a.uuid, pass: false }));
      }

      return CR.request(actors, {
        attrA:        cfg.checkAttrA   ?? "DEX",
        attrB:        cfg.checkAttrB   ?? "MIG",
        dl:           cfg.checkDl      ?? 10,
        label:        context.tileLabel ?? "",
        mode:         "interactive",
        allowInvokes: true,
        postChat:     true,
      });
    },
  };

  console.debug(TAG, "TileSkillCheck adapter ready (delegates to ONI.CheckRequester).");
})();
