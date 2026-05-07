// ============================================================================
// BattleInit — Battle Gate (Step 2) (Foundry VTT v12)
// ----------------------------------------------------------------------------
// Purpose:
// - Load payload from Scene Flag: world.battleInit.latestPayload
// - Validate required battle data
// - Pull Party members from Game Database via DB resolver:
//     source.system.props.member_id_1..member_id_4
// - Write back updated payload + gate status
//
// REQUIRED for battle to proceed:
// - Battle Map (battleSceneUuid)
// - Battle Type (battlePlan.type)
// - Enemy Setting (encounterPlan.mode)
// - Enemy source depending on mode:
//     - rollEncounterTable: encounterTableUuid must resolve to RollTable
//     - manual: manualPicks must have at least 1 entry
//
// OPTIONAL:
// - BGM (payload.battleConfig.bgm) can be empty (play none)
//
// NOTE:
// - We intentionally IGNORE SkillCheckEvent / ClockEvent etc.
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const log = (...args) => DEBUG && console.log("[BattleInit:BattleGate:Step2]", ...args);

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Battle Gate is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene.");
    return;
  }

  const scene = canvas.scene;

  // -----------------------------
  // Load payload
  // -----------------------------
  const payload = scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
  if (!payload) {
    ui.notifications?.error?.("BattleInit: No payload found. Run Step 1 (Battle Prompt) first.");
    console.error("[BattleInit:BattleGate:Step2] Missing payload flag:", `${PAYLOAD_SCOPE}.${PAYLOAD_KEY}`);
    return;
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  async function safeFromUuid(uuid) {
    const u = String(uuid ?? "").trim();
    if (!u) return null;
    try {
      return await fromUuid(u);
    } catch (err) {
      console.warn("[BattleInit:BattleGate:Step2] fromUuid failed:", u, err);
      return null;
    }
  }

  function nowIso() { return new Date().toISOString(); }

  function pushTrace(note, extra = {}) {
    if (!payload?.meta?.debug?.enabled) return;
    payload.meta.debug.trace ??= [];
    payload.meta.debug.trace.push({ phase: "gate", at: nowIso(), note, ...extra });
  }

  // -----------------------------
  // Gate validation
  // -----------------------------
  const errors = [];
  const warnings = [];

  const battleSceneUuid = String(payload?.battleConfig?.battleSceneUuid ?? payload?.context?.battleSceneUuid ?? "").trim();
  const encounterTableUuid = String(payload?.battleConfig?.encounterTableUuid ?? "").trim();

  const battleType = String(payload?.battlePlan?.type ?? "").trim();
  const enemySetting = String(payload?.encounterPlan?.mode ?? "").trim();

  log("Loaded payload core:", { battleSceneUuid, encounterTableUuid, battleType, enemySetting });

  // --- Validate Battle Type ---
  const allowedBattleTypes = new Set(["default", "random", "boss"]);
  if (!battleType || !allowedBattleTypes.has(battleType)) {
    errors.push(`Battle Type is missing/invalid. Expected one of: ${Array.from(allowedBattleTypes).join(", ")}`);
  }

  // --- Validate Enemy Setting ---
  // Allow older naming too, just in case (safe)
  const allowedEnemySettings = new Set(["rollEncounterTable", "manual", "rollRevealTable"]);
  if (!enemySetting || !allowedEnemySettings.has(enemySetting)) {
    errors.push(`Enemy Setting is missing/invalid. Expected one of: rollEncounterTable, manual`);
  }

  // --- Validate Battle Map Scene ---
  if (!battleSceneUuid) {
    errors.push("Battle Map is missing (battleSceneUuid).");
  } else {
    const battleSceneDoc = await safeFromUuid(battleSceneUuid);
    if (!battleSceneDoc || battleSceneDoc.documentName !== "Scene") {
      errors.push(`Battle Map UUID does not resolve to a Scene: ${battleSceneUuid}`);
    } else {
      payload.context ??= {};
      payload.context.battleSceneUuid = battleSceneDoc.uuid;
      payload.context.battleSceneId = battleSceneDoc.id;
      payload.context.battleSceneName = battleSceneDoc.name;
    }
  }

  // --- Validate enemy source depending on mode ---
  const normalizedEnemySetting = (enemySetting === "rollRevealTable") ? "rollEncounterTable" : enemySetting;

  if (normalizedEnemySetting === "rollEncounterTable") {
    if (!encounterTableUuid) {
      errors.push("Encounter Table is required when Enemy Setting = Roll Encounter Table.");
    } else {
      const rt = await safeFromUuid(encounterTableUuid);
      if (!rt || rt.documentName !== "RollTable") {
        errors.push(`Encounter Table UUID does not resolve to a RollTable: ${encounterTableUuid}`);
      }
    }
  }

  if (normalizedEnemySetting === "manual") {
    const picks = Array.isArray(payload?.encounterPlan?.manualPicks) ? payload.encounterPlan.manualPicks : [];
    const usable = picks.filter(p => String(p?.name ?? "").trim() !== "");
    if (!usable.length) {
      errors.push("Manual List requires at least 1 selected enemy slot.");
    }
  }

  // --- BGM is optional ---
  const bgm = String(payload?.battleConfig?.bgm ?? "").trim();
  if (!bgm) {
    warnings.push("BGM is empty. Battle will start with no music (this is OK).");
  }

    // -----------------------------
  // Party List from payload (required)
  // -----------------------------
  const partyMembers = Array.isArray(payload?.party?.members) ? payload.party.members : [];
  if (!partyMembers.length) {
    errors.push("Party List is missing in payload. Re-run Step 1 (Battle Prompt) and make sure your Global DB has member_id_1..member_id_4 set.");
  } else {
    // Optional: verify at least 1 member still resolves to a real Actor
    let resolvedCount = 0;
    for (const m of partyMembers) {
      const u = String(m?.actorUuid ?? "").trim();
      if (!u) {
        warnings.push(`Party member slot ${m?.slot ?? "?"} is missing actorUuid in payload.`);
        continue;
      }
      const doc = await safeFromUuid(u);
      if (!doc || doc.documentName !== "Actor") {
        warnings.push(`Party member slot ${m?.slot ?? "?"} no longer resolves: ${u}`);
        continue;
      }
      resolvedCount++;
    }

    if (resolvedCount < 1) {
      errors.push("Party List exists in payload, but none of the members resolve to real Actors anymore.");
    }
  }

  // -----------------------------
  // Finalize gate result
  // -----------------------------
  payload.phases ??= {};
  payload.phases.gate = {
    status: errors.length ? "blocked" : "ok",
    at: nowIso(),
    errors,
    warnings
  };

  pushTrace(errors.length ? "Gate blocked" : "Gate passed", { errors, warnings });

  // Always write back payload (so you can see why it blocked)
  await scene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

    // -----------------------------
  // Report to GM (Notifications)
  // -----------------------------
  if (errors.length) {
    ui.notifications?.error?.(`BattleInit Gate BLOCKED: ${errors.length} issue(s).`);
  }

})();
