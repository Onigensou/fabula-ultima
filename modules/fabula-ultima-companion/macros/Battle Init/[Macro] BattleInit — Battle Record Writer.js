// ============================================================================
// BattleInit — Battle Record Writer (Step 8) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Computes and records EXP snapshot for later Victory step.
// Uses your EXP formula spec (v1.2) and dynamic multipliers from DB resolver.
// ---------------------------------------------------------------------------
// EXP Spec reference: ONI — EXP Formula (v1.2)
// - Per PC, per enemy scaling
// - Rank weights (Soldier/Elite/Champion) are dynamic from DB in this script
// - Boss premium multiplier is dynamic from DB and applied if:
//     (battleType === "boss") OR (any Champion enemy exists)
// - Diminishing weights list is constant (tuned values from doc)
//
// UPDATE (Zenit Award):
// - Computes and records Zenit snapshot for later BattleEnd steps.
//   ZenitForPlayer = floor( (Σ randInt(enemyMin, enemyMax)) * GlobalMult * PersonalMult )
// - Enemy min/max from: enemy.actor.system.props.zenit_reward_min / zenit_reward_max
// - PC zenit multiplier from: pc.actor.system.props.character_zenit_multiplier
// - Global zenit multiplier from DB: dbSource.system.props.zenit_global_multiplier
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const tag = "[BattleInit:RecordWriter:Step8]";
  const log  = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);
  const error = (...a) => console.error(tag, ...a);

  const nowIso = () => new Date().toISOString();
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const uniq = (arr) => [...new Set((arr ?? []).filter(Boolean))];

  // -----------------------------
  // EXP constants (hard-coded)
  // -----------------------------
  const a = 10;              // level scaling denominator inside exponent
  const m_min = 0.25;        // clamp min for level multiplier
  const m_max = 5.0;         // clamp max for level multiplier
  const EXP_min = 1;         // min awarded per fight
  const EXP_max = 15;        // max awarded per fight
  const DECIMALS = 2;        // display rounding

  // Diminishing weights (tail repeats last)
  const WEIGHTS = [1.00, 0.70, 0.55, 0.45, 0.40];

  // -----------------------------
  // Helpers: payload finder (same pattern as Step 6/7)
  // -----------------------------
  function findBattleInitPayloadForThisBattleScene() {
    const currentSceneId = canvas.scene?.id;
    if (!currentSceneId) return null;

    // 1) current scene
    const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) return { payload: local, sourceScene: canvas.scene, from: "current-scene" };

    // 2) search other scenes that "own" the payload
    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;

      const transitionedBattleId =
        p?.step4?.battleScene?.id ??
        p?.step4?.battleSceneId ??
        p?.layout?.step5a?.battleScene?.id ??
        null;

      if (transitionedBattleId && transitionedBattleId === currentSceneId) {
        return { payload: p, sourceScene: s, from: "scene-search" };
      }
    }
    return null;
  }

  // -----------------------------
  // Helpers: data getters (robust)
  // -----------------------------
  const gp = foundry.utils.getProperty;

  function getNumber(obj, path, fallback) {
    const v = gp(obj, path);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

    function getLevel(actor) {
    // Your confirmed key:
    // _token.actor.system.props.level  → actor.system.props.level
    const n = getNumber(actor, "system.props.level", NaN);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);

    // fallback safety (should almost never happen)
    return 1;
  }

 function getEnemyRank(actor) {
  // NEW path:
  // _token.actor.system.props.npc_rank  → actor.system.props.npc_rank
  const npcRank = String(gp(actor, "system.props.npc_rank") ?? "").toLowerCase().trim();

  // Expected exact values: "soldier" | "elite" | "champion"
  if (npcRank === "champion") return "champion";
  if (npcRank === "elite") return "elite";
  if (npcRank === "soldier") return "soldier";

  // Backward-compatible fallbacks (older data)
  const rankStr = String(gp(actor, "system.props.rank") ?? "").toLowerCase().trim();
  if (rankStr.includes("champ")) return "champion";
  if (rankStr.includes("elite")) return "elite";
  if (rankStr.includes("sold")) return "soldier";

  if (gp(actor, "system.props.champion")) return "champion";
  if (gp(actor, "system.props.elite")) return "elite";
  if (gp(actor, "system.props.soldier")) return "soldier";

  // Default
  return "soldier";
}

  function weightAt(kIndex1Based) {
    if (kIndex1Based <= 0) return WEIGHTS[0];
    const idx0 = kIndex1Based - 1;
    if (idx0 < WEIGHTS.length) return WEIGHTS[idx0];
    return WEIGHTS[WEIGHTS.length - 1];
  }

  function roundDisplay(x) {
    const p = Math.pow(10, DECIMALS);
    return Math.round(x * p) / p;
  }

  function randIntInclusive(min, max) {
    const a = Math.floor(Number(min));
    const b = Math.floor(Number(max));
    const lo = Number.isFinite(a) ? a : 0;
    const hi = Number.isFinite(b) ? b : 0;
    const mn = Math.min(lo, hi);
    const mx = Math.max(lo, hi);
    if (mx <= mn) return mn;
    return Math.floor(mn + Math.random() * (mx - mn + 1));
  }

    function esc(str) {
  const s = String(str ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit Step 8: GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit Step 8: No active scene.");
    return;
  }

  const found = findBattleInitPayloadForThisBattleScene();
  if (!found) {
    ui.notifications?.error?.("BattleInit Step 8: No payload found. Run Step 1–7 first.");
    return;
  }

  const { payload, sourceScene, from } = found;
  log("Payload found ✅", { from, sourceScene: { id: sourceScene.id, name: sourceScene.name } });

  const spawnInfo = payload?.spawn?.step5b;
  if (!spawnInfo) {
    ui.notifications?.error?.("BattleInit Step 8: Missing payload.spawn.step5b. Run Step 5b first.");
    return;
  }

  const partyTokenIds = uniq(spawnInfo.partyTokenIds);
  const enemyTokenIds = uniq(spawnInfo.enemyTokenIds);

  if (!partyTokenIds.length) {
    ui.notifications?.error?.("BattleInit Step 8: No partyTokenIds in payload (Step 5b).");
    return;
  }
  if (!enemyTokenIds.length) {
    ui.notifications?.error?.("BattleInit Step 8: No enemyTokenIds in payload (Step 5b).");
    return;
  }

  // -----------------------------
  // Resolve DB multipliers (dynamic)
  // -----------------------------
  const api = window.FUCompanion?.api;
  if (!api?.getCurrentGameDb) {
    ui.notifications?.error?.("BattleInit Step 8: DB Resolver API not found (window.FUCompanion.api.getCurrentGameDb).");
    return;
  }

  const { source: dbSource, gameName } = await api.getCurrentGameDb();
  if (!dbSource) {
    ui.notifications?.error?.("BattleInit Step 8: Could not resolve current game DB.");
    return;
  }

  // From your DB token actor: _token.actor.system.props.(key)
  const G = getNumber(dbSource, "system.props.exp_global_multiplier", 1.0);
  const B_soldier  = getNumber(dbSource, "system.props.exp_soldier_multiplier", 1.0);
  const B_elite    = getNumber(dbSource, "system.props.exp_elite_multiplier", 1.5);
  const B_champion = getNumber(dbSource, "system.props.exp_champion_multiplier", 3.0);
  const BossMult   = getNumber(dbSource, "system.props.exp_boss_multiplier", 1.6);

  const ZG = getNumber(dbSource, "system.props.zenit_global_multiplier", 1.0);

  log("DB multipliers:", { gameName, G, B_soldier, B_elite, B_champion, BossMult, ZG });

  // -----------------------------
  // Resolve token docs on THIS battle scene
  // -----------------------------
  const tokenDocs = canvas.scene.tokens?.contents ?? [];

  const partyTokenDocs = partyTokenIds
    .map(id => tokenDocs.find(t => t.id === id))
    .filter(Boolean);

  const enemyTokenDocs = enemyTokenIds
    .map(id => tokenDocs.find(t => t.id === id))
    .filter(Boolean);

  if (!partyTokenDocs.length) {
    ui.notifications?.error?.("BattleInit Step 8: Party token IDs were not found on this scene. Are you on the battle scene?");
    return;
  }
  if (!enemyTokenDocs.length) {
    ui.notifications?.error?.("BattleInit Step 8: Enemy token IDs were not found on this scene. Are you on the battle scene?");
    return;
  }

  // -----------------------------
  // Build enemy snapshot (levels + ranks + zenit range)
  // -----------------------------
  const enemies = enemyTokenDocs.map(t => {
    const aDoc = t.actor;
    const level = aDoc ? getLevel(aDoc) : 1;
    const rank = aDoc ? getEnemyRank(aDoc) : "soldier";

    const B_rank = (rank === "champion") ? B_champion
                : (rank === "elite") ? B_elite
                : B_soldier;

    const zenitRewardMin = aDoc ? getNumber(aDoc, "system.props.zenit_reward_min", 0) : 0;
    const zenitRewardMax = aDoc ? getNumber(aDoc, "system.props.zenit_reward_max", 0) : 0;

    return {
      tokenId: t.id,
      actorId: t.actorId,
      name: t.name,
      level,
      rank,
      B_rank,
      zenitRewardMin,
      zenitRewardMax
    };
  });

  const anyChampion = enemies.some(e => e.rank === "champion");

  // Boss premium rule for this script:
  // Apply if battleType is boss OR any Champion exists.
  const battleType = String(payload?.battleConfig?.battleType ?? payload?.context?.battleType ?? "default").toLowerCase();
  const bossPremiumApplied = (battleType === "boss") || anyChampion;
  const beta = bossPremiumApplied ? BossMult : 1.0;

  // -----------------------------
  // Compute EXP per PC (formula)
  // -----------------------------
  const pcResults = [];

  for (const t of partyTokenDocs) {
    const pcActor = t.actor;
    if (!pcActor) continue;

    const L_i = getLevel(pcActor);
    const P_i = getNumber(pcActor, "system.props.character_exp_multiplier", 1.0);

    // Step 1/2: contributions list c_ij = B_j * clamp(2^((E_j - L_i)/a), m_min, m_max)
    const contribs = enemies.map(e => {
      const E_j = e.level;
      const exponent = (E_j - L_i) / a;
      const m_ij = clamp(Math.pow(2, exponent), m_min, m_max);
      const c_ij = e.B_rank * m_ij;
      return {
        enemyName: e.name,
        enemyLevel: E_j,
        enemyRank: e.rank,
        B_rank: e.B_rank,
        m_ij,
        c_ij
      };
    });

    // Step 3: sort descending
    contribs.sort((x, y) => y.c_ij - x.c_ij);

    // Step 4: diminishing sum
    let R_i = 0;
    for (let k = 1; k <= contribs.length; k++) {
      const w = weightAt(k);
      R_i += w * contribs[k - 1].c_ij;
    }

    // Step 5: apply multipliers + clamp
    const EXPraw_i = P_i * G * R_i * beta;
    const EXP_i = clamp(EXPraw_i, EXP_min, EXP_max);

    pcResults.push({
      tokenId: t.id,
      actorId: t.actorId,
      name: t.name,
      level: L_i,
      personalMultiplier: P_i,
      R_i,
      EXPraw: EXPraw_i,
      EXPfinal: EXP_i,
      EXPdisplay: roundDisplay(EXP_i),
      sortedContribs: contribs
    });
  }

  if (!pcResults.length) {
    ui.notifications?.error?.("BattleInit Step 8: No party actors resolved from party tokens.");
    return;
  }

  // -----------------------------
  // Compute ZENIT snapshot (group roll → per-PC multipliers)
  // -----------------------------
  // Step A: roll once per enemy
  const enemyZenitRolls = enemies.map(e => {
    const min = Number.isFinite(Number(e.zenitRewardMin)) ? Number(e.zenitRewardMin) : 0;
    const max = Number.isFinite(Number(e.zenitRewardMax)) ? Number(e.zenitRewardMax) : 0;
    const roll = randIntInclusive(min, max);
    return {
      tokenId: e.tokenId,
      actorId: e.actorId,
      name: e.name,
      min,
      max,
      roll
    };
  });

  const sumEnemyZenitRolls = enemyZenitRolls.reduce((acc, r) => acc + (Number.isFinite(Number(r.roll)) ? Number(r.roll) : 0), 0);

  // Step B: per PC apply global + personal and floor
  const pcZenitResults = [];

  for (const t of partyTokenDocs) {
    const pcActor = t.actor;
    if (!pcActor) continue;

    const ZP = getNumber(pcActor, "system.props.character_zenit_multiplier", 1.0);
    const zenitRaw = sumEnemyZenitRolls * ZG * ZP;
    const zenitFinal = Math.floor(zenitRaw);

    pcZenitResults.push({
      tokenId: t.id,
      actorId: t.actorId,
      name: t.name,
      personalMultiplier: ZP,
      globalMultiplier: ZG,
      sumEnemyRolls: sumEnemyZenitRolls,
      zenitRaw,
      zenitFinal
    });
  }

  // -----------------------------
  // Store snapshots into payload
  // -----------------------------
  payload.record ??= {};
  payload.record.step8 ??= {};

  payload.record.step8.expSnapshot = {
    at: nowIso(),
    gameName: gameName ?? null,
    battleScene: { id: canvas.scene.id, name: canvas.scene.name, uuid: canvas.scene.uuid },
    battleType,
    bossPremiumApplied,
    beta,
    constants: { a, m_min, m_max, EXP_min, EXP_max, DECIMALS, weights: WEIGHTS },
    dbMultipliers: { G, B_soldier, B_elite, B_champion, BossMult },
    enemies,
    pcs: pcResults.map(p => ({
      tokenId: p.tokenId,
      actorId: p.actorId,
      name: p.name,
      level: p.level,
      personalMultiplier: p.personalMultiplier,
      R_i: p.R_i,
      EXPraw: p.EXPraw,
      EXPfinal: p.EXPfinal,
      EXPdisplay: p.EXPdisplay
    }))
  };

  payload.record.step8.zenitSnapshot = {
    at: payload.record.step8.expSnapshot.at,
    gameName: gameName ?? null,
    battleScene: { id: canvas.scene.id, name: canvas.scene.name, uuid: canvas.scene.uuid },
    battleType,
    formula: "ZenitForPlayer = floor( (Σ randInt(enemyMin, enemyMax)) * GlobalMult * PersonalMult )",
    dbMultipliers: { ZG },
    enemyRolls: enemyZenitRolls,
    sumEnemyRolls: sumEnemyZenitRolls,
    pcs: pcZenitResults.map(p => ({
      tokenId: p.tokenId,
      actorId: p.actorId,
      name: p.name,
      personalMultiplier: p.personalMultiplier,
      globalMultiplier: p.globalMultiplier,
      sumEnemyRolls: p.sumEnemyRolls,
      zenitRaw: p.zenitRaw,
      zenitFinal: p.zenitFinal
    }))
  };

  payload.phases ??= {};
  payload.phases.recordWriter = { status: "ok", at: payload.record.step8.expSnapshot.at };

  await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

  log("EXP snapshot stored at payload.record.step8.expSnapshot", payload.record.step8.expSnapshot);
  log("Zenit snapshot stored at payload.record.step8.zenitSnapshot", payload.record.step8.zenitSnapshot);
})();
