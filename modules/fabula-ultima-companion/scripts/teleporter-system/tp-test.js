// ============================================================================
// Teleporter System — Diagnostics & Test API
//
// Exposes: globalThis.TeleporterSystem.test
//
// Two usage paths:
//
// ── PATH A: Test Bridge (recommended, Claude-driven) ─────────────────────────
//   Requires the FUCompanion test bridge to be active.
//   Activate once with: FUCompanion.api.testBridge.activate()
//   (game reloads; bridge stays armed)
//
//   Claude writes evalGM requests to the inbox; this API is what those
//   requests call.  Examples:
//
//     // Static diagnostics — no game session needed:
//     return await TeleporterSystem.test.runDiagnostics();
//
//     // Begin runtime log capture before a play session:
//     TeleporterSystem.test.startCapture();
//     return "capture started";
//
//     // After testing, collect the captured log:
//     return TeleporterSystem.test.collectLog();
//
// ── PATH B: Standalone (no bridge, manual) ───────────────────────────────────
//   Writes results to modules/fabula-ultima-companion/tp-test-results.json
//   so Claude can read the file directly with the Read tool.
//
//     // In browser console (GM only):
//     await TeleporterSystem.test.runDiagnosticsToFile();
//     await TeleporterSystem.test.flushLogToFile();
//
// GM only for all operations.
// ============================================================================
(() => {
  const TP        = globalThis.TeleporterSystem ??= {};
  const MODULE_ID = TP.MODULE_ID ?? "fabula-ultima-companion";
  const TAG       = "[TeleporterSystem][Test]";

  // ── In-memory log capture ─────────────────────────────────────────────────────
  // Intercepts console.debug calls tagged [TeleporterSystem] so runtime
  // teleport flow is captured without modifying any production code.

  const _log = [];
  let _origDebug = null;

  function startCapture() {
    if (_origDebug) return; // already capturing
    _origDebug = console.debug.bind(console);
    console.debug = (...args) => {
      _origDebug(...args);
      const str = args.map(a => {
        try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
        catch { return String(a); }
      }).join(" ");
      if (str.includes("[TeleporterSystem]")) {
        _log.push({ t: Date.now(), msg: str });
      }
    };
    console.debug(TAG, "Log capture started — [TeleporterSystem] output will be recorded.");
  }

  function stopCapture() {
    if (!_origDebug) return;
    console.debug = _origDebug;
    _origDebug = null;
  }

  function collectLog() {
    return { captured: _log.length, entries: _log.slice() };
  }

  function clearLog() {
    _log.length = 0;
  }

  // ── File output (PATH B) ──────────────────────────────────────────────────────

  async function writeToFile(filename, data) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const file = new File([blob], filename, { type: "application/json" });
    try {
      await FilePicker.upload("user", `modules/${MODULE_ID}`, file, {}, { notify: false });
      console.debug(TAG, `Results written → Data/modules/${MODULE_ID}/${filename}`);
      return true;
    } catch (e) {
      console.error(TAG, "writeToFile failed:", e);
      return false;
    }
  }

  // ── Static diagnostics ────────────────────────────────────────────────────────
  // Inspects the current scene's teleporter tile configuration and system state.
  // Safe to call at any time — no world mutations.

  async function runDiagnostics() {
    const scene = canvas?.scene;
    const DP    = globalThis.DungeonPathing;
    const dp    = globalThis.__ONI_DUNGEON_PATHING__;

    const report = {
      timestamp:    new Date().toISOString(),
      scene: {
        id:   scene?.id ?? null,
        name: scene?.name ?? null,
        mode: TP.api?.getSceneMode?.() ?? "unknown",
      },
      dungeon: {
        active:       dp?.state?.active  ?? false,
        busy:         dp?.state?.busy    ?? false,
        currentNode:  dp?.state?.currentNode?.nodeId ?? null,
        partyTokenId: dp?.state?.partyToken?.document?.id ?? null,
        graphNodes:   dp?.state?.graph?.nodes?.length ?? null,
      },
      api: {
        teleportToken:         typeof TP.api?.teleportToken         === "function",
        getSceneMode:          typeof TP.api?.getSceneMode          === "function",
        isTeleporterEnabled:   typeof TP.api?.isTeleporterEnabled   === "function",
        resolveDestination:    typeof TP.api?.resolveDestination     === "function",
        executeCrossScene:     typeof TP.api?.executeCrossSceneTeleport === "function",
      },
      cooldowns: {
        // Expose internal state for debugging without breaking encapsulation
        active: (() => {
          try {
            const bs = window.__ONI_TP_BOOTSTRAP__;
            return bs ? "guard present" : "no guard — bootstrap not loaded";
          } catch { return "unknown"; }
        })(),
      },
      tiles: [],
    };

    // Scan all tiles for teleporter flags
    for (const tileDoc of (scene?.tiles ?? [])) {
      const flags = TP.api?.getFlags?.(tileDoc) ?? tileDoc?.flags?.[MODULE_ID]?.teleporter ?? null;
      if (!flags) continue; // skip tiles with no teleporter flags at all

      const entry = {
        id:          tileDoc.id,
        enabled:     flags.enabled,
        confirmMode: flags.confirmMode,
        twoWay:      flags.twoWay,
        sfxUrl:      flags.sfxUrl ?? null,
        destination: flags.destination ?? null,
        bounds:      { x: tileDoc.x, y: tileDoc.y, w: tileDoc.width, h: tileDoc.height },
        issues:      [],
        destResolved: null,
      };

      // Validate destination
      const dest = flags.destination;
      if (flags.enabled && !dest) {
        entry.issues.push("enabled_but_no_destination");
      } else if (dest) {
        if (dest.type === "tile") {
          const destSceneId = dest.sceneId ?? scene?.id;
          const destScene   = game.scenes.get(destSceneId);
          if (!destScene) {
            entry.issues.push(`dest_scene_not_found:${destSceneId}`);
          } else {
            const destTile = destScene.tiles.get(dest.tileId);
            if (!destTile) {
              entry.issues.push(`dest_tile_not_found:${dest.tileId}`);
            } else {
              entry.destResolved = {
                sceneId: destSceneId,
                x: destTile.x + destTile.width  / 2,
                y: destTile.y + destTile.height / 2,
                tileEnabled: TP.api?.isTeleporterEnabled?.(destTile) ?? null,
              };
              // Check if 2-way link is symmetric
              if (flags.twoWay) {
                const backFlags = TP.api?.getFlags?.(destTile);
                const backDest  = backFlags?.destination;
                const isSymmetric = backDest?.type === "tile" && backDest?.tileId === tileDoc.id;
                if (!isSymmetric) entry.issues.push("two_way_not_symmetric");
              }
            }
          }
        } else if (dest.type === "coords") {
          entry.destResolved = { x: dest.x, y: dest.y, sceneId: dest.sceneId ?? scene?.id };
          if (dest.sceneId && !game.scenes.get(dest.sceneId)) {
            entry.issues.push(`dest_scene_not_found:${dest.sceneId}`);
          }
        } else {
          entry.issues.push(`unknown_dest_type:${dest.type}`);
        }
      }

      // Check if this tile is on a DP graph node (dungeon mode check)
      if (dp?.state?.graph?.nodeMap && flags.enabled) {
        const onGraph = dp.state.graph.nodeMap.has(tileDoc.id);
        if (!onGraph && report.scene.mode === "dungeon") {
          entry.issues.push("not_on_dp_graph");
        }
        entry.onDpGraph = onGraph;
      }

      report.tiles.push(entry);
    }

    report.summary = {
      total:    report.tiles.length,
      enabled:  report.tiles.filter(t => t.enabled).length,
      withIssues: report.tiles.filter(t => t.issues.length > 0).length,
    };

    return report;
  }

  // ── PATH B helpers ────────────────────────────────────────────────────────────

  async function runDiagnosticsToFile() {
    if (!game.user?.isGM) { console.warn(TAG, "GM only."); return null; }
    const report = await runDiagnostics();
    await writeToFile("tp-test-results.json", { type: "diagnostics", ...report });
    return report;
  }

  async function flushLogToFile() {
    if (!game.user?.isGM) { console.warn(TAG, "GM only."); return null; }
    const data = { type: "log", timestamp: new Date().toISOString(), ...collectLog() };
    await writeToFile("tp-test-results.json", data);
    return data;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  TP.test = {
    // Log capture (for runtime flow tracing)
    startCapture,
    stopCapture,
    collectLog,
    clearLog,

    // Diagnostics (static — safe to call at any time)
    runDiagnostics,

    // Standalone file-based output (PATH B)
    runDiagnosticsToFile,
    flushLogToFile,
  };

  console.debug(TAG, "Test API loaded at TeleporterSystem.test");
  console.debug(TAG, "  .runDiagnostics()        — static config check (returns object)");
  console.debug(TAG, "  .startCapture()           — begin recording [TeleporterSystem] logs");
  console.debug(TAG, "  .collectLog()             — return captured log entries");
  console.debug(TAG, "  .runDiagnosticsToFile()   — write diagnostics to tp-test-results.json");
  console.debug(TAG, "  .flushLogToFile()         — write captured log to tp-test-results.json");
})();
