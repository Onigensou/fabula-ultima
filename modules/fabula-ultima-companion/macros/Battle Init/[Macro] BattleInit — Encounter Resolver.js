// ============================================================================
// BattleInit — Encounter Resolver (Step 3) (Foundry VTT v12)
// ----------------------------------------------------------------------------
// Reads payload from Scene Flag: world.battleInit.latestPayload
// Requires Gate PASSED
//
// Resolves enemies in 3 paths:
//
// A) Manual List (Enemy Setting = manual)
//    - Uses payload.encounterPlan.manualPicks (names)
//    - Each slot = 1 enemy (quantity ignored; if legacy qty exists, we expand it)
//
// B) Randomize (Battle Type = random)
//    - Builds 3–5 enemies by drawing from Enemies Table
//
// C) Fixed encounter (default/boss)
//    - Draw 1 result from Encounter Table
//    - Parse Result text by comma: "Slime, Random, Hawk"
//    - "Random" keyword draws from Enemies Table
//
// Stores output to payload.encounterResolved.enemies
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const log = (...args) => DEBUG && console.log("[BattleInit:EncounterResolver:Step3]", ...args);

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Encounter Resolver is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene.");
    return;
  }

  const scene = canvas.scene;
  const payload = scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);

  if (!payload) {
    ui.notifications?.error?.("BattleInit: No payload found. Run Step 1 first.");
    return;
  }

  const gateStatus = payload?.phases?.gate?.status ?? payload?.phases?.gate?.status;
  if (gateStatus && gateStatus !== "ok") {
    ui.notifications?.error?.("BattleInit: Gate has not passed. Run Step 2 (Battle Gate) and fix errors first.");
    log("Blocked: gateStatus =", gateStatus, payload?.phases?.gate);
    return;
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  const nowIso = new Date().toISOString();

  function pushTrace(note, extra = {}) {
    if (!payload?.meta?.debug?.enabled) return;
    payload.meta.debug.trace ??= [];
    payload.meta.debug.trace.push({ phase: "resolve", at: nowIso, note, ...extra });
  }

  async function safeFromUuid(uuid) {
    const u = String(uuid ?? "").trim();
    if (!u) return null;
    try {
      return await fromUuid(u);
    } catch (err) {
      console.warn("[BattleInit:EncounterResolver:Step3] fromUuid failed:", u, err);
      return null;
    }
  }

  function splitCommaList(text) {
    return String(text ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  function isRandomKeyword(s) {
    return String(s ?? "").trim().toLowerCase() === "random";
  }

  function clampInt(n, min, max) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

  function pickRandomInt(min, max) {
    // inclusive
    const a = Math.min(min, max);
    const b = Math.max(min, max);
    return a + Math.floor(Math.random() * (b - a + 1));
  }

    function resolveActorByName(name) {
    const n = String(name ?? "").trim();
    if (!n) return null;
    return game.actors?.getName?.(n) ?? (game.actors?.contents?.find?.(a => a.name === n) ?? null);
  }

  function normalizeNpcRank(v) {
    return String(v ?? "").trim().toLowerCase();
  }

  function getNpcRankFromActor(actor) {
    // Your expected field: actor.system.props.npc_rank
    // (We keep this tolerant in case of minor schema differences.)
    const rank =
      actor?.system?.props?.npc_rank ??
      actor?.system?.props?.npcRank ??
      actor?.system?.npc_rank ??
      actor?.system?.npcRank ??
      null;

    return normalizeNpcRank(rank);
  }

  function isChampionActor(actor) {
    return getNpcRankFromActor(actor) === "champion";
  }

  async function drawNonChampionFromEnemiesTable(enemiesTableDoc, opts = {}) {
    const maxTries = Number.isFinite(Number(opts?.maxTries)) ? Number(opts.maxTries) : 25;
    const warnContext = String(opts?.warnContext ?? "").trim();

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const { text } = await drawOneTextResult(enemiesTableDoc);
      const name = String(text ?? "").trim();

      if (!name) {
        warnings.push(`Enemies Table draw returned empty text${warnContext ? ` (${warnContext})` : ""}; retrying (${attempt}/${maxTries}).`);
        continue;
      }

      const actor = resolveActorByName(name);

      // If actor exists and is champion => skip (boss-only via Manual)
      if (actor && isChampionActor(actor)) {
        warnings.push(`Skipped champion (boss) "${name}" from Enemies Table${warnContext ? ` (${warnContext})` : ""}. Manual spawn only.`);
        continue;
      }

      // Either:
      // - actor is non-champion
      // - OR actor not found (can't rank-check) -> allow it through as a normal entry
      return { name, actor };
    }

    return null;
  }

  async function drawOneTextResult(rollTableDoc) {
    // Foundry v12 RollTable draw
    const draw = await rollTableDoc.draw({ displayChat: false });
    const results = draw?.results ?? draw?.results?.contents ?? [];
    const first = Array.isArray(results) ? results[0] : null;

    // In v12, result.text is the text for "Text" results
    const text = first?.text ?? first?.getFlag?.("core", "sourceText") ?? first?.document?.text ?? first?.document?.getFlag?.("core", "sourceText") ?? "";
    return {
      draw,
      result: first,
      text: String(text ?? "").trim()
    };
  }

  // -----------------------------
  // Pull needed UUIDs
  // -----------------------------
  const encounterTableUuid = String(payload?.battleConfig?.encounterTableUuid ?? "").trim();
  const enemiesTableUuid   = String(payload?.battleConfig?.enemiesTableUuid ?? "").trim();

  const battleType   = String(payload?.battlePlan?.type ?? "").trim();           // "default" | "random" | "boss"
  const enemySetting = String(payload?.encounterPlan?.mode ?? "").trim();        // "rollEncounterTable" | "manual"

  log("Input:", { battleType, enemySetting, encounterTableUuid, enemiesTableUuid });

  const errors = [];
  const warnings = [];

  // We always need Enemies Table for:
  // - Random keyword in fixed encounter
  // - Randomize mode
  // - Manual list dropdown came from Enemies Table (but might still resolve without it)
  const enemiesTableDoc = enemiesTableUuid ? await safeFromUuid(enemiesTableUuid) : null;
  if (enemiesTableUuid && (!enemiesTableDoc || enemiesTableDoc.documentName !== "RollTable")) {
    errors.push(`Enemies Table UUID does not resolve to a RollTable: ${enemiesTableUuid}`);
  }

  const encounterTableDoc = encounterTableUuid ? await safeFromUuid(encounterTableUuid) : null;
  if (enemySetting !== "manual" && battleType !== "random") {
    // Fixed encounter uses Encounter Table
    if (!encounterTableUuid) {
      errors.push("Encounter Table UUID is missing (required for fixed encounter).");
    } else if (!encounterTableDoc || encounterTableDoc.documentName !== "RollTable") {
      errors.push(`Encounter Table UUID does not resolve to a RollTable: ${encounterTableUuid}`);
    }
  }

  if (errors.length) {
    payload.phases ??= {};
    payload.phases.resolve = { status: "blocked", at: nowIso, errors, warnings };
    pushTrace("Resolver blocked (pre-check errors)", { errors, warnings });
    await scene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);
    ui.notifications?.error?.(`BattleInit: Encounter Resolver BLOCKED (${errors.length} error(s)).`);
    console.error("[BattleInit:EncounterResolver:Step3] BLOCKED", errors);
    return;
  }

  // -----------------------------
  // Resolve enemies
  // -----------------------------
  const resolved = [];
  let modeUsed = "";

  // A) Manual List
  if (enemySetting === "manual") {
    modeUsed = "manual";
    const picks = Array.isArray(payload?.encounterPlan?.manualPicks) ? payload.encounterPlan.manualPicks : [];

    if (!picks.length) {
      errors.push("Manual mode selected, but manualPicks is empty.");
    } else {
      for (const p of picks) {
        const name = String(p?.name ?? "").trim();
        if (!name) continue;

        // Back-compat: if old payload has quantity, expand it; otherwise treat as 1
        const qty = clampInt(p?.quantity ?? 1, 1, 99);

        for (let i = 0; i < qty; i++) {
          const actor = resolveActorByName(name);
          resolved.push({
            name,
            actorUuid: actor?.uuid ?? null,
            actorId: actor?.id ?? null,
            source: "manual",
            wasRandom: false
          });
          if (!actor) warnings.push(`Manual pick actor not found by name: "${name}"`);
        }
      }
    }
  }

    // B) Randomize mode (Battle Type = random)
  else if (battleType === "random") {
    modeUsed = "randomize";
    if (!enemiesTableDoc) {
      errors.push("Randomize mode requires Enemies Table, but enemiesTableUuid is empty or invalid.");
    } else {
      const count = pickRandomInt(3, 5);
      for (let i = 0; i < count; i++) {
        const pick = await drawNonChampionFromEnemiesTable(enemiesTableDoc, {
          maxTries: 25,
          warnContext: `Randomize slot ${i + 1}`
        });

        if (!pick) {
          warnings.push(`Enemies Table could not produce a non-champion result after 25 tries (Randomize slot ${i + 1}); skipping one slot.`);
          continue;
        }

        const name = String(pick.name ?? "").trim();
        const actor = pick.actor ?? resolveActorByName(name);

        resolved.push({
          name,
          actorUuid: actor?.uuid ?? null,
          actorId: actor?.id ?? null,
          source: "enemiesTable",
          wasRandom: true
        });

        if (!actor) warnings.push(`Randomize actor not found by name: "${name}"`);
      }
    }
  }

  // C) Fixed encounter: roll Encounter Table + replace "Random" using Enemies Table
  else {
    modeUsed = "fixedEncounter";
    if (!encounterTableDoc) {
      errors.push("Fixed encounter mode requires Encounter Table, but encounterTableUuid is empty or invalid.");
    } else {
      const drawA = await drawOneTextResult(encounterTableDoc);
      const rawEncounterText = drawA.text;

      if (!rawEncounterText) {
        errors.push("Encounter Table draw returned empty text.");
      } else {
        const slots = splitCommaList(rawEncounterText);

        if (!slots.length) {
          errors.push(`Encounter Table result could not be parsed: "${rawEncounterText}"`);
        } else {
          for (const slot of slots) {
                        if (isRandomKeyword(slot)) {
              if (!enemiesTableDoc) {
                errors.push(`Encounter contains "Random" but Enemies Table is missing.`);
                continue;
              }

              const pick = await drawNonChampionFromEnemiesTable(enemiesTableDoc, {
                maxTries: 25,
                warnContext: `Encounter Random slot`
              });

              if (!pick) {
                warnings.push('Enemies Table could not produce a non-champion result for "Random" slot after 25 tries; skipping.');
                continue;
              }

              const name = String(pick.name ?? "").trim();
              const actor = pick.actor ?? resolveActorByName(name);

              resolved.push({
                name,
                actorUuid: actor?.uuid ?? null,
                actorId: actor?.id ?? null,
                source: "enemiesTable",
                wasRandom: true,
                fromEncounterSlot: "Random"
              });

              if (!actor) warnings.push(`Random slot actor not found by name: "${name}"`);
                        } else {
              const name = String(slot ?? "").trim();
              const actor = resolveActorByName(name);

              // If this is a champion, we block it: boss spawns must be Manual List only
              if (actor && isChampionActor(actor)) {
                errors.push(`Boss (champion) enemy "${name}" cannot be spawned from Encounter Table. Use Manual List.`);
                continue;
              }

              resolved.push({
                name,
                actorUuid: actor?.uuid ?? null,
                actorId: actor?.id ?? null,
                source: "encounterTable",
                wasRandom: false
              });

              if (!actor) warnings.push(`Fixed slot actor not found by name: "${name}"`);
            }
          }

          // Save the raw draw data for debugging
          payload.encounterPlan ??= {};
          payload.encounterPlan.roll ??= {};
          payload.encounterPlan.roll.encounterTable = {
            tableUuid: encounterTableDoc.uuid,
            tableName: encounterTableDoc.name,
            rawText: rawEncounterText,
            at: nowIso
          };
        }
      }
    }
  }

  // Block if no enemies resolved
  if (!errors.length && (!resolved.length)) {
    errors.push("No enemies were resolved (result list is empty).");
  }

  // -----------------------------
  // Store results back into payload
  // -----------------------------
  payload.encounterResolved ??= {};
  payload.encounterResolved.mode = modeUsed;
  payload.encounterResolved.at = nowIso;
  payload.encounterResolved.enemies = resolved;

  payload.phases ??= {};
  payload.phases.resolve = {
    status: errors.length ? "blocked" : "ok",
    at: nowIso,
    errors,
    warnings
  };

  pushTrace(errors.length ? "Resolver blocked" : "Resolver ok", {
    modeUsed,
    enemyCount: resolved.length,
    errors,
    warnings
  });

  await scene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

    if (errors.length) {
    ui.notifications?.error?.(`BattleInit Resolver BLOCKED: ${errors.length} error(s).`);
    console.error("[BattleInit:EncounterResolver:Step3] BLOCKED", { errors, warnings });
  } else {
    // (Removed: success confirmation popup)
    log("Resolved enemies:", resolved);
  }
})();
