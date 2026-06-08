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

  // ============================================================================
  // TileCheckGate — generic check gate for tile events
  //
  // Reads per-tile checkGate flags and runs the appropriate check type,
  // returning whether the gate "triggered" (i.e. the effect should fire).
  //
  // Modes:
  //   "individual"  — every actor rolls; triggered if ANY actor passes/fails
  //   "all_party"   — every actor rolls; triggered only if ALL pass/fail
  //   "group"       — Group Check with leader; triggered based on leaderPass
  //
  // triggerOn:
  //   "failure"  (default) — triggered when the check outcome is bad
  //   "success"            — triggered when the check outcome is good
  // ============================================================================

  /** Flag key root for checkGate settings. */
  const CG_KEY = `${DP.PATHING_ROOT_KEY}.checkGate`;

  DP.TileCheckGate = {
    /**
     * Read all checkGate flags from a tile document into a plain config object.
     * Provides safe defaults for every field.
     *
     * @param {TileDocument} tileDoc
     * @returns {{
     *   enabled:      boolean,
     *   mode:         string,
     *   leaderMode:   string,
     *   attrA:        string,
     *   attrB:        string,
     *   dl:           number,
     *   triggerOn:    string,
     *   label:        string,
     * }}
     */
    readConfig(tileDoc) {
      const MOD = DP.MODULE_ID;
      const get = (key, def) => tileDoc?.getFlag(MOD, `${CG_KEY}.${key}`) ?? def;
      return {
        enabled:    get("enabled",    false) === true || get("enabled", false) === "true",
        mode:       get("mode",       "group"),
        leaderMode: get("leaderMode", "players_choose"),
        attrA:      get("attrA",      "DEX"),
        attrB:      get("attrB",      "MIG"),
        dl:         Number(get("dl",  10)),
        triggerOn:  get("triggerOn",  "failure"),
        label:      get("label",      ""),
      };
    },

    /**
     * Run the check gate and return whether the configured event should fire.
     * Must be called on the GM client.
     *
     * @param {Actor[]}  actors  — party members to check
     * @param {object}   cfg     — from readConfig()
     * @returns {Promise<{ triggered: boolean, raw: object }>}
     */
    async request(actors, cfg) {
      if (!game.user?.isGM)
        throw new Error(`${TAG} TileCheckGate.request() must be called on the GM client.`);

      if (!actors.length) {
        console.warn(TAG, "TileCheckGate: no actors provided — gate skipped, not triggered.");
        return { triggered: false, raw: null };
      }

      const sharedOpts = {
        attrA:        cfg.attrA,
        attrB:        cfg.attrB,
        dl:           cfg.dl,
        label:        cfg.label || "Tile Check",
        mode:         "interactive",
        allowInvokes: true,
        postChat:     true,
      };

      let triggered = false;
      let raw       = null;

      if (cfg.mode === "group") {
        const GC = globalThis.ONI?.GroupCheck;
        if (!GC?.request) {
          console.warn(TAG, "ONI.GroupCheck not loaded — gate skipped.");
          return { triggered: false, raw: null };
        }
        raw = await GC.request({
          ...sharedOpts,
          leaderUuid:      null,
          participantMode: cfg.leaderMode === "players_choose" ? "open" : "designated",
          helperActorUuids: [],
          allActorUuids:   actors.map(a => a.uuid),
          helperDl:        cfg.dl,
          leaderDl:        cfg.dl,
          helperBonus:     1,
        });
        const leaderPassed = raw?.leaderPass ?? false;
        triggered = cfg.triggerOn === "success" ? leaderPassed : !leaderPassed;

      } else {
        const CR = globalThis.ONI?.CheckRequester;
        if (!CR?.request) {
          console.warn(TAG, "ONI.CheckRequester not loaded — gate skipped.");
          return { triggered: false, raw: null };
        }
        raw = await CR.request(actors, sharedOpts);
        const passes = (raw ?? []).filter(r => r.pass).length;
        const total  = actors.length;

        if (cfg.mode === "all_party") {
          const allPassed = passes === total;
          triggered = cfg.triggerOn === "success" ? allPassed : !allPassed;
        } else {
          // "individual" — any one actor determines the outcome
          const anyPassed = passes > 0;
          triggered = cfg.triggerOn === "success" ? anyPassed : !anyPassed;
        }
      }

      return { triggered, raw };
    },
  };

  console.debug(TAG, "TileCheckGate ready.");
})();
