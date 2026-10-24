// ============================================================================
// Camp System — Set Out (return the party to where it entered camp)
//
//   entry ──► campReturnPoint recorded, camp loop reset to FREE_ROAM
//     · dungeon camp tile      (dungeonPathing.campStart)
//     · teleport into a camp-mode scene from a non-camp one — which is also
//       how an innkeeper's Rest gets there (teleporter.crossScene)
//
//   SET_OUT_LOBBY ──(GM Start)──► [no usable point? the GM picks one]
//                 ──► SETTING_OUT: everyone fades to black; the primary GM
//                     activates the scene, or teleports the party token back
//                 ──► destination active → camp state reset (silent by then)
//
// The point is a world setting, so campState saves it: Rest → save → title →
// load → Set Out still returns to the lobby/dungeon the party left.
// Design: docs/inn-camp-set-out-design.md
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const MOD  = CAMP.MODULE_ID;
  const TAG  = "[CampSystem][SetOut]";

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const sceneModeOf = (scene) => scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode ?? null;
  const isCampScene = (scene) => sceneModeOf(scene) === "camp";

  // The party token is the database actor's token (same rule as DP's
  // resolvePartyToken and camera-authority's findPartyToken).
  async function _partyActorIds() {
    try {
      const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
      return [res?.db?.id, res?.source?.id].filter(Boolean);
    } catch { return []; }
  }

  function _tokenCentre(tokenDoc) {
    const g = tokenDoc?.parent?.grid?.size ?? 100;
    return {
      x: Math.round((tokenDoc?.x ?? 0) + (tokenDoc?.width  ?? 1) * g / 2),
      y: Math.round((tokenDoc?.y ?? 0) + (tokenDoc?.height ?? 1) * g / 2),
    };
  }

  // Where to put the party on a scene nothing was recorded for.
  function _defaultSpot(scene) {
    const i = scene?.initial;
    if (Number.isFinite(i?.x) && Number.isFinite(i?.y)) return { x: i.x, y: i.y };
    const d = scene?.dimensions;
    return { x: Math.round((d?.width ?? scene?.width ?? 0) / 2), y: Math.round((d?.height ?? scene?.height ?? 0) / 2) };
  }

  function _networkOf(scene) {
    try {
      const raw = scene?.flags?.[MOD]?.oniFabula?.sceneNetwork;
      const list = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw ?? []);
      return list
        .map(n => ({ name: n?.name, scene: game.scenes.get(String(n?.id ?? "").replace(/^Scene\./, "")) }))
        .filter(n => n.scene && n.scene.id !== scene?.id);
    } catch { return []; }
  }

  async function _waitForActiveScene(sceneId, maxMs = 6000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (canvas?.scene?.id === sceneId && canvas?.ready) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return canvas?.scene?.id === sceneId;
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /**
   * Record where the party entered camp from, and start the loop fresh — a
   * camp abandoned mid-cycle earlier must not resume half-finished.
   * Primary GM only; noteEntry() routes here from any client.
   */
  async function recordEntry(point) {
    // A hand-activated camp has no place it came from: it records only which
    // camp it is (sceneId absent → getReturnPoint() null → Set Out's picker).
    if (!isPrimaryGM() || !point?.campSceneId) return;
    if (!point.sceneId && point.via !== "gm_activate") return;
    await CAMP.State.reset();
    await CAMP.State.setReturnPoint({ ...point, at: Date.now() });
    console.debug(TAG, `Return point recorded (${point.via}):`, point);
    // Spawn the party into the camp before it draws, so nobody pops in.
    await CAMP.Members?.ensure(game.scenes.get(point.campSceneId));
  }

  function noteEntry(point) {
    if (isPrimaryGM()) return recordEntry(point);
    CAMP.Socket?.emit?.(CAMP.MSG.RECORD_RETURN, { point });
  }

  // Dungeon camp tile. The party token stays on the dungeon scene; Set Out
  // only has to activate it again. Fires on whichever client used the tile.
  Hooks.on("dungeonPathing.campStart", (tileDoc, tokenDoc, scene, _uuid, campScene) => {
    if (!scene || !campScene) return;
    noteEntry({
      sceneId:     scene.id,
      ..._tokenCentre(tokenDoc),
      actorId:     tokenDoc?.actorId ?? null,
      tileId:      tileDoc?.id ?? null,
      via:         "dungeon_camp_tile",
      campSceneId: campScene.id,
    });
  });

  // A teleport into a camp scene from a non-camp one (inn Rest included).
  // Fired by TeleporterSystem on the primary GM, before any token moves.
  Hooks.on("teleporter.crossScene", ({ actorId, fromSceneId, toSceneId, from } = {}) => {
    const fromScene = game.scenes.get(fromSceneId);
    const toScene   = game.scenes.get(toSceneId);
    if (!isCampScene(toScene) || !fromScene || isCampScene(fromScene)) return;
    const spot = from ?? _defaultSpot(fromScene);
    recordEntry({
      sceneId: fromScene.id, x: spot.x, y: spot.y,
      actorId: actorId ?? null, via: "teleport", campSceneId: toScene.id,
    });
  });

  // A camp scene becoming ACTIVE. Two jobs:
  //  - The GM activated it by hand (a story camp like Sunset Camp): nothing
  //    recorded this entry, so the loop would inherit the last camp's phase.
  //    When the stored point belongs to a different camp, start fresh and
  //    record a hand entry. Inn / dungeon / teleport entries record BEFORE
  //    activating, and a loaded save restores its own campState after the
  //    scene, so neither is touched.
  //  - Spawn the members even when the GM was already viewing the scene:
  //    activating the scene you are looking at does not redraw the canvas, so
  //    camp-bootstrap's canvasReady pass never runs.
  Hooks.on("updateScene", async (scene, changes) => {
    if (changes?.active !== true || !isPrimaryGM() || !isCampScene(scene)) return;
    let raw = {};
    try { raw = JSON.parse(game.settings.get(MOD, CAMP.SETTING.RETURN_POINT) || "{}"); } catch {}
    if (raw?.campSceneId !== scene.id) {
      await recordEntry({ campSceneId: scene.id, via: "gm_activate" });
    } else {
      await CAMP.Members?.ensure(scene);
    }
  });

  // ---------------------------------------------------------------------------
  // Fallback: no usable return point — the GM chooses
  // ---------------------------------------------------------------------------
  function _pickDestination(campScene) {
    const options = _networkOf(campScene);
    return new Promise(resolve => {
      const buttons = {};
      options.forEach((o, i) => {
        buttons[`s${i}`] = {
          icon: '<i class="fas fa-shoe-prints"></i>',
          label: o.name || o.scene.navName || o.scene.name,
          callback: () => resolve(o.scene),
        };
      });
      buttons.stay = {
        icon: '<i class="fas fa-campground"></i>',
        label: "Stay at camp",
        callback: () => resolve(null),
      };
      new Dialog({
        title: "Set Out — where to?",
        content: `<p>This camp has no recorded return point (an older save, or the camp was opened by hand).</p>
                  <p>${options.length ? "Choose where the party sets out to:" : "No linked scenes in this camp's Scene Network."}</p>`,
        buttons,
        default: options.length ? "s0" : "stay",
        close: () => resolve(undefined),
      }).render(true);
    });
  }

  // ---------------------------------------------------------------------------
  // Departure (primary GM, inside SETTING_OUT — screen already black)
  // ---------------------------------------------------------------------------
  let _busy = false;

  async function _depart() {
    if (_busy) return;
    _busy = true;
    const campScene = canvas?.scene;
    try {
      const rp   = CAMP.State.getReturnPoint();
      const dest = game.scenes.get(rp?.sceneId);
      if (!dest) throw new Error("return point scene not found");

      // The rest scheduled a camp-BGM resume up to 35s out; it would start the
      // camp playlist over the destination's music.
      CAMP.RestAPI?.cancelBgmResume?.();

      const ids     = await _partyActorIds();
      const actorId = rp.actorId ?? ids[0] ?? null;
      const waiting = dest.tokens?.find?.(t => t.actorId === actorId || ids.includes(t.actorId));
      const spot    = (Number.isFinite(rp.x) && Number.isFinite(rp.y)) ? { x: rp.x, y: rp.y } : _defaultSpot(dest);

      console.log(TAG, `Setting out to "${dest.name}" (${rp.via ?? "?"})${waiting ? " — party token already there" : ""}.`);

      if (waiting || !actorId) {
        await dest.activate();
      } else {
        const TP = globalThis.TeleporterSystem?.api;
        if (!TP?.executeCrossSceneTeleport) throw new Error("TeleporterSystem unavailable");
        await TP.executeCrossSceneTeleport(actorId, campScene?.id, dest.id, spot.x, spot.y);
      }

      if (!(await _waitForActiveScene(dest.id))) throw new Error("destination scene did not activate");

      // Every client has torn camp down by now (canvasReady → deactivateCamp),
      // so the reset below is silent — no flash of the camp scene fading in.
      await new Promise(r => setTimeout(r, 600));
      await CAMP.State.reset();
      // The camp is empty again until the next entry spawns the party.
      await CAMP.Members?.clear(campScene);
    } catch (e) {
      console.error(TAG, "Set Out failed:", e);
      ui.notifications?.error?.(`Set Out failed: ${e.message}. The return point is kept — try again.`);
      // Back to the lobby (fades the camp scene back in); keep the point.
      if (canvas?.scene && isCampScene(canvas.scene)) {
        await CAMP.State.clearSetOutReady();
        await CAMP.State.setPhase(CAMP.PHASE.SET_OUT_LOBBY);
      }
    } finally {
      _busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.SetOut = {
    recordEntry,
    noteEntry,

    /** GM pressed Start in SET_OUT_LOBBY. */
    async begin() {
      if (!game.user?.isGM) return;
      await CAMP.State.clearSetOutReady();

      const rp = CAMP.State.getReturnPoint();
      if (!game.scenes.get(rp?.sceneId)) {
        const pick = await _pickDestination(canvas?.scene);
        if (pick === undefined) return;               // dialog dismissed — stay in the lobby
        if (pick === null) { await CAMP.State.reset(); return; }   // "Stay at camp" — loop restarts
        const ids = await _partyActorIds();
        const waiting = pick.tokens?.find?.(t => ids.includes(t.actorId));
        const spot = waiting ? _tokenCentre(waiting) : _defaultSpot(pick);
        await CAMP.State.setReturnPoint({
          sceneId: pick.id, ...spot, actorId: waiting?.actorId ?? ids[0] ?? null,
          via: "gm_pick", campSceneId: canvas?.scene?.id ?? null, at: Date.now(),
        });
      }
      await CAMP.State.setPhase(CAMP.PHASE.SETTING_OUT);
    },

    /** Entering SETTING_OUT — every client fades; the primary GM moves the party. */
    async run() {
      await CAMP.SleepUI.fadeOut();
      if (isPrimaryGM()) await _depart();
    },
  };

  console.debug(TAG, "Set Out loaded.");
})();
