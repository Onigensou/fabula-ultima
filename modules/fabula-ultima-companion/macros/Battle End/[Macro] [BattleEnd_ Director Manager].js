// ============================================================================
// BattleEnd — Director Manager  •  Foundry VTT v12
// ----------------------------------------------------------------------------
// Counterpart to BattleInit's Director Manager. Runs when the End-Battle
// button is pressed while a director-mode battle is active. With the
// no-Foundry-Combat-doc rework, detection is via the director API
// (`isRunning()`) — there is no Combat document to inspect.
//
// Responsibilities:
//   1. Stop the Battle Director (auto-cleans spawned tokens, restores legacy
//      hook listeners, removes Octopath UI + picker pills).
//   2. Return the canvas to the source scene (read from
//      `api.getSourceSceneId()` before stop() clears the dCombat ref).
// ============================================================================

(async () => {
  const tag = "[BattleEnd:DirectorManager]";
  const log = (...a) => console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);
  const err = (...a) => console.error(tag, ...a);

  if (!game.user?.isGM) {
    ui.notifications?.warn?.("Director Battle End: GM only.");
    return;
  }

  const api = globalThis.FUCompanion?.api?.experimental?.battleDirector;
  if (!api?.isRunning?.()) {
    warn("No director running. Nothing to end on the director side.");
    return;
  }

  // Capture source scene id BEFORE stop() — once stop() runs, the dCombat
  // ref is gone and getSourceSceneId() returns null.
  const sourceSceneId = api.getSourceSceneId?.() ?? null;
  log("Ending director battle", { sourceSceneId });

  // 1. Stop the director (cleans up spawned tokens + restores legacy hooks).
  // Idempotent — if it already self-stopped, this no-ops.
  try {
    log("Stopping Battle Director…");
    await api.stop?.({ reason: "battle-end-manager" });
  } catch (e) {
    warn("director.stop threw (continuing with scene return)", e);
  }

  // 2. Return to source scene if one was stamped.
  if (sourceSceneId) {
    const source = game.scenes?.get(sourceSceneId);
    if (source && canvas.scene?.id !== source.id) {
      log(`Returning to source scene: ${source.name}`);
      try {
        await source.activate();
      } catch (e) {
        warn("source.activate threw", e);
        ui.notifications?.error?.(`Director Battle End: failed to return to source scene (${e?.message ?? e}).`);
      }
    } else if (!source) {
      warn(`Source scene ${sourceSceneId} not found (it may have been deleted).`);
    }
  } else {
    log("No source scene stamped on director — staying on current scene.");
  }

  ui.notifications?.info?.("Battle Director: combat ended, scene restored.");
  log("Director battle end complete");
})();
