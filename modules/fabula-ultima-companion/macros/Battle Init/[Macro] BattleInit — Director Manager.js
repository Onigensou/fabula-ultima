// ============================================================================
// BattleInit — Director Manager  •  Foundry VTT v12
// ----------------------------------------------------------------------------
// Replaces the legacy Manager pipeline when payload.options.battleSystem ===
// "director". Reads the payload created by the legacy Battle Prompt (the
// only shared surface in director mode) and runs a director-native init
// flow that does NOT invoke any of:
//   - BattleInit — Battle Gate / Resolver / Transition / Layout / Spawner /
//     Preload / Entrance / Initiator / Unleash / Record
//   - turn-ui-manager, reaction-system, fabula-initiative-controller,
//     applyDamage-button, etc.
//
// Calling FUCompanion.api.experimental.battleDirector.start() also installs
// the legacy-listener suppressor, so once we're in director mode the legacy
// modules' Foundry hooks are neutralized for the duration of combat.
//
// Completion contract: writes payload.phases.directorManager = { status, at,
// reason? }.
// ============================================================================

(async () => {
  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY = "battleInit.latestPayload";

  const tag = "[BattleInit:DirectorManager]";
  const log = (...a) => console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);
  const err = (...a) => console.error(tag, ...a);

  const nowIso = () => new Date().toISOString();

  function findPayload() {
    // Prefer current scene (the GM is still on the source scene at this
    // point), then scan others.
    const local = canvas.scene?.getFlag?.(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) return { payload: local, sourceScene: canvas.scene };
    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;
      return { payload: p, sourceScene: s };
    }
    return null;
  }

  async function writePhase(sourceScene, status, extra = {}) {
    try {
      const p = (await sourceScene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY)) ?? {};
      p.phases ??= {};
      p.phases.directorManager = { status, at: nowIso(), ...extra };
      // Mirror as manager.status so the legacy Manager sees us done if it ever
      // re-checks (it doesn't, but defensive).
      p.manager ??= {};
      p.manager.status = status === "ok" ? "ok" : "blocked";
      p.manager.stoppedAt = nowIso();
      await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, p);
    } catch (e) { warn("writePhase failed", e); }
  }

  if (!game.user?.isGM) { warn("GM only."); return; }

  const found = findPayload();
  if (!found) {
    err("No payload found.");
    ui.notifications?.error?.("BattleInit Director Manager: no payload found.");
    return;
  }
  const { payload, sourceScene } = found;

  const battleSystem = payload?.options?.battleSystem ?? "legacy";
  if (battleSystem !== "director") {
    log(`battleSystem=${battleSystem} — skipping (legacy mode).`);
    await writePhase(sourceScene, "skipped", { reason: `battleSystem=${battleSystem}` });
    return;
  }

  const api = globalThis.FUCompanion?.api?.experimental?.battleDirector;
  if (!api?.start) {
    err("Battle Director API not loaded. Did you Setup-relaunch?");
    ui.notifications?.error?.("Battle Director: API not loaded. Setup-relaunch the world to pick up the new module entry.");
    await writePhase(sourceScene, "blocked", { reason: "API not loaded" });
    return;
  }

  // Hand the payload to the director. The FSM enters PREP, runs the full
  // pre-combat pipeline (curtain, encounter resolution, scene activate,
  // spawn, preload, entrance animation, combat create + add combatants +
  // initiative + startCombat), then transitions to ROUND_START → TURN_START
  // → DECLARE where the player can act. No separate runDirectorInit call.
  log("Starting director with payload — FSM enters PREP");
  let started = null;
  try {
    started = await api.start({ payload });
  } catch (e) {
    err("Director.start threw", e);
    await writePhase(sourceScene, "blocked", { reason: `start threw: ${e?.message ?? e}` });
    ui.notifications?.error?.(`Battle Director failed to start: ${e?.message ?? e}`);
    return;
  }

  if (!started) {
    warn("Director.start returned null");
    await writePhase(sourceScene, "blocked", { reason: "start returned null" });
    return;
  }

  // Note: api.start awaits the FIRST dispatch only (IDLE → PREP). PREP runs
  // asynchronously after this returns. To know whether prep succeeded the
  // caller would need to poll status() or listen for a hook — for now, we
  // optimistically record the launch as ok. PREP failures surface via the
  // standard ui.notifications.error path and the [BD] console log.
  log("Director launched. Current state:", started.state);

  await writePhase(sourceScene, "ok", {
    initialState: started.state,
    note: "PREP runs asynchronously after this; check FUCompanion.api.experimental.battleDirector.status() for progress.",
  });

  ui.notifications?.info?.("Battle Director launched. PREP phase running — black curtain will lift once preload completes.");
})();
