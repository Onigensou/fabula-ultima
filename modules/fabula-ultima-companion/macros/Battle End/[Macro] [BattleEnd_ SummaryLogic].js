// ============================================================================
// [BattleEnd: SummaryLogic] • Foundry VTT v12
// ----------------------------------------------------------------------------
// Victory-only.
// - Applies EXP gains to party Actors (writes to Actor sheet)
// - Computes Level Ups:
//     * EXP starts at 1
//     * Level Up when EXP reaches 10
//     * On Level Up: EXP becomes (1 + overflow)
//     * Supports multiple level-ups in one award (overflow chain)
// - Records snapshots for SummaryUI pseudo-animation:
//     beforeExp -> afterExp, beforeLevel -> afterLevel, segments[] for tick-up bars
//
// UPDATE (Zenit Award):
// - Applies Zenit gains to party Actors (writes to Actor sheet)
// - Zenit is stored at: system.props.zenit
// - Reads awards from payload.battleEnd.prompt.zenitByActorId
//
// Reads/Writes canonical payload at SceneFlag: world.battleInit.latestPayload
// (Same source-scene locating strategy as your [BattleEnd: Prompt].)
//
// IMPORTANT CONFIG (edit if your sheet uses different fields):
//   EXP_PATH   = where EXP is stored on the actor
//   LEVEL_PATH = where Level is stored on the actor
//   ZENIT_PATH = where Zenit is stored on the actor
//
// Default LEVEL_PATH matches your BattleInit Record Writer helper: system.props.level
// ============================================================================

(async () => {
  const DEBUG = true;

  // -----------------------------
  // Storage (canonical payload)
  // -----------------------------
  const STORE_SCOPE = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";

  // -----------------------------
  // SYSTEM CONFIG (EDIT IF NEEDED)
  // -----------------------------
  const EXP_PATH = "system.props.experience";     // <-- If your EXP field differs, change this
  const LEVEL_PATH = "system.props.level"; // <-- Confirmed used in your Record Writer
  const ZENIT_PATH = "system.props.zenit"; // <-- Your Zenit storage
  const EXP_START = 1;
  const LEVEL_UP_AT = 10;

  // If you want: match your EXP snapshot DECIMALS (Step8 uses DECIMALS=2)
  const FALLBACK_DECIMALS = 2;

  const tag = "[BattleEnd:SummaryLogic]";
  const log = (...args) => DEBUG && console.log(tag, ...args);
  const warn = (...args) => console.warn(tag, ...args);
  const error = (...args) => console.error(tag, ...args);

  const gp = foundry.utils.getProperty;

  function nowIso() {
    return new Date().toISOString();
  }

  function safeNumber(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : fallback;
  }

  function safeInt(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
  }

  function roundTo(x, decimals) {
    const p = Math.pow(10, decimals);
    return Math.round(x * p) / p;
  }

  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  // --------------------------------------------------------------------------
  // Locate canonical payload scene (source scene) while we're on battle scene
  // (copied in spirit from your [BattleEnd: Prompt])
  // --------------------------------------------------------------------------
  function pickLatestPayloadAcrossScenes() {
    let best = null;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const createdAtMs =
        parseIsoToMs(p?.meta?.createdAt) ||
        Number(p?.step4?.transitionedAt ?? 0) ||
        0;

      if (!best || createdAtMs > best.createdAtMs) {
        best = { scene: s, payload: p, createdAtMs };
      }
    }
    return best; // can be null
  }

  function locateSourceSceneAndPayloadForThisBattle() {
    const activeBattleSceneId = canvas.scene?.id;

    // 1) Best match: payload whose step4.battleScene.id matches ACTIVE scene id
    let bestMatch = null;
    let bestMatchMs = 0;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const battleSceneIdInPayload = p?.step4?.battleScene?.id ?? null;
      if (battleSceneIdInPayload && activeBattleSceneId && battleSceneIdInPayload === activeBattleSceneId) {
        const ms =
          parseIsoToMs(p?.meta?.createdAt) ||
          Number(p?.step4?.transitionedAt ?? 0) ||
          0;

        if (!bestMatch || ms > bestMatchMs) {
          bestMatch = { scene: s, payload: p, from: "scene-scan-match-step4.battleScene.id" };
          bestMatchMs = ms;
        }
      }
    }

    if (bestMatch) return bestMatch;

    // 2) If you run on the source scene, read local
    const local = canvas.scene?.getFlag?.(STORE_SCOPE, CANONICAL_KEY);
    if (local) return { scene: canvas.scene, payload: local, from: "current-scene" };

    // 3) Fallback: newest payload anywhere
    const best = pickLatestPayloadAcrossScenes();
    if (best) return { scene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: SummaryLogic is GM-only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd: No active scene.");
    return;
  }

  const located = locateSourceSceneAndPayloadForThisBattle();
  if (!located?.payload || !located?.scene) {
    ui.notifications?.error?.(
      `BattleEnd: No canonical payload found anywhere at SceneFlag ${STORE_SCOPE}.${CANONICAL_KEY}.`
    );
    log("Missing canonical payload across all scenes.", {
      activeScene: { id: canvas.scene?.id, name: canvas.scene?.name }
    });
    return;
  }

  const sourceScene = located.scene;
  const payload = located.payload;

  log("Located canonical payload ✅", {
    from: located.from,
    sourceScene: { id: sourceScene.id, name: sourceScene.name },
    activeScene: { id: canvas.scene.id, name: canvas.scene.name },
    battleId: payload?.meta?.battleId ?? "(missing)"
  });

  // Ensure structures exist (append-only)
  payload.phases = payload.phases ?? {};
  payload.phases.battleEnd = payload.phases.battleEnd ?? {};
  payload.battleEnd = payload.battleEnd ?? {};
  payload.battleEnd.meta = payload.battleEnd.meta ?? {};
  payload.battleEnd.prompt = payload.battleEnd.prompt ?? {};
  payload.battleEnd.results = payload.battleEnd.results ?? {};

  // -----------------------------
  // Respect Gate
  // -----------------------------
  const gateStatus = String(payload?.phases?.battleEnd?.gate?.status ?? "").toLowerCase();
  if (gateStatus === "blocked") {
    ui.notifications?.error?.("BattleEnd: Gate is BLOCKED. SummaryLogic will not run.");
    
payload.phases.battleEnd.summaryLogic = {
      status: "skipped",
      at: nowIso(),
      reason: "gate-blocked"
    };
    await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
    return;
  }

  // -----------------------------
  // Victory-only
  // -----------------------------
  const mode = String(payload?.battleEnd?.meta?.mode ?? "victory").toLowerCase();
  if (mode !== "victory") {
    payload.phases.battleEnd.summaryLogic = {
      status: "skipped",
      at: nowIso(),
      reason: `mode=${mode}`
    };
    await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
    return;
  }

  // -----------------------------
  // Read awards from Prompt
  // -----------------------------
  const expByActorId = payload?.battleEnd?.prompt?.expByActorId ?? {};
  if (!expByActorId || typeof expByActorId !== "object" || Array.isArray(expByActorId)) {
    payload.phases.battleEnd.summaryLogic = {
      status: "error",
      at: nowIso(),
      error: "Missing or invalid payload.battleEnd.prompt.expByActorId"
    };
    await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
    ui.notifications?.error?.("BattleEnd: SummaryLogic missing expByActorId (Prompt data).");
    return;
  }

  const zenitByActorId = payload?.battleEnd?.prompt?.zenitByActorId ?? {};
  const zenitMapIsValid = (zenitByActorId && typeof zenitByActorId === "object" && !Array.isArray(zenitByActorId));

  // Try to follow your Step8 DECIMALS if present
  const decimalsFromSnapshot = safeNumber(payload?.record?.step8?.expSnapshot?.constants?.DECIMALS, NaN);
  const DECIMALS = Number.isFinite(decimalsFromSnapshot) ? decimalsFromSnapshot : FALLBACK_DECIMALS;

  // -----------------------------
  // Level-up math + segments builder
  // -----------------------------
  function computeExpAndLevel(beforeExpRaw, beforeLevelRaw, gainedRaw) {
    const beforeLevel = Math.max(1, Math.floor(safeNumber(beforeLevelRaw, 1)));

    // Clamp/normalize EXP
    let beforeExp = safeNumber(beforeExpRaw, EXP_START);
    if (!Number.isFinite(beforeExp)) beforeExp = EXP_START;

    // If someone somehow has 0 or negative, normalize to EXP_START
    if (beforeExp < EXP_START) beforeExp = EXP_START;

    // If someone somehow is already >= LEVEL_UP_AT, normalize back into range.
    // We do NOT auto-level here (that would be surprising); we just clamp for safety.
    if (beforeExp >= LEVEL_UP_AT) beforeExp = EXP_START;

    const gained = Math.max(0, safeNumber(gainedRaw, 0));

    // segments are for SummaryUI tick animation
    // Each segment represents a continuous fill:
    // - from: starting EXP
    // - to: ending EXP
    // - levelUp: whether this segment ends by hitting LEVEL_UP_AT
    const segments = [];

    let runningLevel = beforeLevel;
    let runningExp = beforeExp;

    // Total exp (conceptual) we are processing in a chain
    let total = runningExp + gained;

    // No gain -> single "flat" segment
    if (gained <= 0) {
      segments.push({
        from: roundTo(runningExp, DECIMALS),
        to: roundTo(runningExp, DECIMALS),
        levelUp: false
      });

      return {
        beforeLevel,
        afterLevel: runningLevel,
        levelsGained: 0,
        beforeExp: roundTo(beforeExp, DECIMALS),
        afterExp: roundTo(runningExp, DECIMALS),
        gained: roundTo(gained, DECIMALS),
        segments
      };
    }

    let levelsGained = 0;

    // While we reach/overflow the level-up cap
    while (total >= LEVEL_UP_AT) {
      // Segment: fill to 10
      segments.push({
        from: roundTo(runningExp, DECIMALS),
        to: roundTo(LEVEL_UP_AT, DECIMALS),
        levelUp: true
      });

      // Apply the level-up:
      // exp becomes EXP_START + overflow
      total = EXP_START + (total - LEVEL_UP_AT);
      runningLevel += 1;
      levelsGained += 1;

      // new level starts at EXP_START
      runningExp = EXP_START;
    }

    // Final segment: fill from EXP_START (or original exp if no level-up) to final
    segments.push({
      from: roundTo(runningExp, DECIMALS),
      to: roundTo(total, DECIMALS),
      levelUp: false
    });

    return {
      beforeLevel,
      afterLevel: runningLevel,
      levelsGained,
      beforeExp: roundTo(beforeExp, DECIMALS),
      afterExp: roundTo(total, DECIMALS),
      gained: roundTo(gained, DECIMALS),
      segments
    };
  }

  // -----------------------------
  // Apply EXP to Actors + record results
  // -----------------------------
  const results = [];
  const errors = [];

  const actorIds = Object.keys(expByActorId);

  if (!actorIds.length) {
    warn("No actorIds found in expByActorId. Nothing to apply.");
  }

  for (const actorId of actorIds) {
    const actor = game.actors?.get?.(actorId) ?? null;
    const award = expByActorId[actorId];

    if (!actor) {
      errors.push(`Missing Actor in world collection: ${actorId}`);
      continue;
    }

    const beforeExp = gp(actor, EXP_PATH);
    const beforeLevel = gp(actor, LEVEL_PATH);

    const calc = computeExpAndLevel(beforeExp, beforeLevel, award);

    // Write to actor sheet (EXP + Level)
    const updateData = {};
    updateData[EXP_PATH] = calc.afterExp;
    updateData[LEVEL_PATH] = calc.afterLevel;

    try {
      await actor.update(updateData);

      results.push({
        actorId,
        actorName: actor.name ?? "",
        exp: {
          before: calc.beforeExp,
          gained: calc.gained,
          after: calc.afterExp
        },
        level: {
          before: calc.beforeLevel,
          after: calc.afterLevel,
          gained: calc.levelsGained,
          leveledUp: calc.levelsGained > 0
        },
        segments: calc.segments
      });

      log("Applied EXP ✅", {
        actor: actor.name,
        exp: `${calc.beforeExp} + ${calc.gained} => ${calc.afterExp}`,
        level: `${calc.beforeLevel} => ${calc.afterLevel}`,
        segments: calc.segments
      });
    } catch (e) {
      errors.push(`Failed to update Actor ${actor.name} (${actorId}): ${String(e?.message ?? e)}`);
      error("Actor update failed", { actorId, actorName: actor.name, e });
    }
  }

  // -----------------------------
  // Apply ZENIT to Actors + record results
  // -----------------------------
  const zenitResults = [];
  const zenitErrors = [];

  if (!zenitMapIsValid) {
    warn("zenitByActorId missing or invalid. Zenit will be skipped.");
  } else {
    for (const actorId of actorIds) {
      const actor = game.actors?.get?.(actorId) ?? null;

      if (!actor) {
        zenitErrors.push(`Missing Actor in world collection: ${actorId}`);
        continue;
      }

      const gainedZenit = safeInt(zenitByActorId[actorId], 0);

      const beforeZenitRaw = gp(actor, ZENIT_PATH);
      const beforeZenit = safeInt(beforeZenitRaw, 0);
      const afterZenit = beforeZenit + Math.max(0, gainedZenit);

      const updateData = {};
      updateData[ZENIT_PATH] = afterZenit;

      try {
        await actor.update(updateData);

        zenitResults.push({
          actorId,
          actorName: actor.name ?? "",
          zenit: {
            before: beforeZenit,
            gained: Math.max(0, gainedZenit),
            after: afterZenit
          }
        });

        log("Applied Zenit ✅", {
          actor: actor.name,
          zenit: `${beforeZenit} + ${Math.max(0, gainedZenit)} => ${afterZenit}`
        });
      } catch (e) {
        zenitErrors.push(`Failed to update Actor ${actor.name} (${actorId}): ${String(e?.message ?? e)}`);
        error("Actor zenit update failed", { actorId, actorName: actor.name, e });
      }
    }
  }

  
  // -----------------------------
  // Combat Totals (Total Damage / Total Healing) — from Database Battle Log
  // -----------------------------
  async function resolveDbActorForCombatTotals() {
    // Preferred: module API (if you expose one)
    try {
      const mod = game.modules?.get?.("fabula-ultima-companion");
      const api = mod?.api;
      if (api?.getCurrentGameDb) {
        const maybe = await api.getCurrentGameDb();
        if (maybe) return maybe;
      }
      if (api?.DB_resolver) {
        const maybe = await api.DB_resolver();
        if (maybe) return typeof maybe === "string" ? await fromUuid(maybe) : maybe;
      }
    } catch (_) {}

    // If you have a global DB_resolver(), try it (unknown signature, best-effort)
    try {
      if (typeof DB_resolver === "function") {
        const maybe = await DB_resolver();
        if (maybe) return typeof maybe === "string" ? await fromUuid(maybe) : maybe;
      }
    } catch (_) {}

    // Fallback: resolve via "Current Game" actor → system.props.game_id (same as BattleLog_Append)
    try {
      const currentGameActor = await fromUuid("Actor.DMpK5Bi119jIrCFZ");
      const gameDbUuid = currentGameActor?.system?.props?.game_id;
      if (gameDbUuid) {
        const dbActor = await fromUuid(gameDbUuid);
        if (dbActor) return dbActor;
      }
    } catch (_) {}

    return null;
  }

  function normNameForCombatTotals(s) {
    return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function extractBattleLogRows(battleLogTable) {
    if (!battleLogTable) return [];
    if (Array.isArray(battleLogTable)) return battleLogTable;
    if (typeof battleLogTable === "object") return Object.values(battleLogTable);
    return [];
  }

  try {
    const dbActor = await resolveDbActorForCombatTotals();

    // Build a party-name set (match Battle Log "attacker" → party member)
    const partyNameSet = new Set();

    // 1) From computed EXP results (actor names in-session)
    for (const r of (results ?? [])) {
      const n = normNameForCombatTotals(r?.actorName);
      if (n) partyNameSet.add(n);
    }

    // 2) From payload party members (if present)
    for (const m of (payload?.party?.members ?? [])) {
      const n = normNameForCombatTotals(m?.name ?? m?.actorName ?? "");
      if (n) partyNameSet.add(n);
    }

    // 3) From DB (member_name_1..N)
    const dbProps = dbActor?.system?.props ?? {};
    if (dbProps && typeof dbProps === "object") {
      for (const [k, v] of Object.entries(dbProps)) {
        if (String(k).startsWith("member_name_")) {
          const n = normNameForCombatTotals(v);
          if (n) partyNameSet.add(n);
        }
      }
    }

    let totalDamage = 0;
    let totalHealing = 0;

    const battleLogTable = dbActor?.system?.props?.battle_log_table;
    const rows = extractBattleLogRows(battleLogTable);

    let scanned = 0;
    let used = 0;

    // Small helper: allow "attacker" to contain extra text (e.g. "Hina (Player)")
    const isPartyAttacker = (attackerNorm) => {
      if (!attackerNorm) return false;
      if (partyNameSet.has(attackerNorm)) return true;
      for (const n of partyNameSet) {
        if (n && attackerNorm.includes(n)) return true;
      }
      return false;
    };

    for (const row of rows) {
      if (!row || typeof row !== "object") continue;

      // Some table libs mark rows deleted
      if (row.$deleted === true || String(row.$deleted).toLowerCase() === "true") continue;

      scanned += 1;

      const attacker = normNameForCombatTotals(row.attacker);
      if (!isPartyAttacker(attacker)) continue;

      const valueType = normNameForCombatTotals(row.value_type);
      if (valueType !== "hp") continue;

      const applyMode = normNameForCombatTotals(row.apply_mode);
      const rawVal = safeNumber(row.value, 0);
      const val = Math.max(0, rawVal);

      if (val <= 0) continue;

      if (applyMode.includes("damage")) {
        totalDamage += val;
        used += 1;
      } else if (applyMode.includes("healing") || applyMode.includes("heal")) {
        totalHealing += val;
        used += 1;
      }
    }

    payload.battleEnd.results.combatTotals = {
      totalDamage: Math.floor(totalDamage),
      totalHealing: Math.floor(totalHealing),
      source: "db.system.props.battle_log_table",
      rowsScanned: scanned,
      rowsUsed: used,
      partyNamesCount: partyNameSet.size,
      at: nowIso()
    };

    log("Computed combat totals ✅", payload.battleEnd.results.combatTotals);
  } catch (err) {
    warn("Combat totals compute failed; leaving totals at 0.", err);
    payload.battleEnd.results.combatTotals = {
      totalDamage: 0,
      totalHealing: 0,
      source: "db.system.props.battle_log_table",
      error: String(err?.message ?? err),
      at: nowIso()
    };
  }

// -----------------------------
  // Write back into payload (append-only)
  // -----------------------------
  payload.battleEnd.results.expApplied = results;
  payload.battleEnd.results.expRule = {
    expStart: EXP_START,
    levelUpAt: LEVEL_UP_AT,
    decimals: DECIMALS,
    expPath: EXP_PATH,
    levelPath: LEVEL_PATH
  };

  payload.battleEnd.results.zenitApplied = zenitResults;
  payload.battleEnd.results.zenitRule = {
    zenitPath: ZENIT_PATH
  };

  const allErrors = [...errors, ...zenitErrors];
  if (allErrors.length) {
    payload.battleEnd.results.errors = allErrors;
  }

  payload.phases.battleEnd.summaryLogic = {
    status: allErrors.length ? "ok-with-errors" : "ok",
    at: nowIso(),
    appliedCount: results.length,
    zenitAppliedCount: zenitResults.length,
    errorCount: allErrors.length
  };

  await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);

  // -----------------------------
  // UI feedback
  // -----------------------------
  if (allErrors.length) {
    ui.notifications?.warn?.(`BattleEnd: SummaryLogic applied with ${allErrors.length} issue(s). Check console.`);
  } else {
    // (Removed: success confirmation toast)
  }
})();
