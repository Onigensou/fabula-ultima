// ============================================================================
// [BattleEnd: RankComputation] • Foundry VTT v12 (GM-only)
// ----------------------------------------------------------------------------
// Computes a JRPG-style Rank (F–S) using BattleLog + Summary totals.
//
// Runs AFTER:
//   - [BattleEnd: SummaryLogic] (needs combatTotals: totalDamage / totalHealing)
// Runs BEFORE:
//   - [BattleEnd: SummaryUI] (so UI can display Rank)
//
// Reads (canonical payload):
//   - payload.battleEnd.prompt.combat.round        (Total Rounds)
//   - payload.battleEnd.results.combatTotals       (TotalDamage/TotalHealing)
//   - payload.step4.battleScene.id                 (active battle scene id)
//   - payload.battlePlan.isBoss OR battlePlan.type (boss vs normal)
//
// Reads (Database Actor via FUCompanion DB resolver):
//   - dbActor.system.props.battle_log_table        (rows with attacker/target/apply_mode/value/value_type/affinity/efficiency)
//
// Writes:
//   - payload.battleEnd.results.rank               (score + letter + breakdown + counts)
//   - payload.phases.battleEnd.rankComputation     (status marker for Manager polling)
//
// Notes:
// - Uses party roster from Database (member_name_1..4) PLUS any Friendly tokens (disposition=1) in the current scene
//   to include summoned allies as "party" without counting Neutral/Hostile units.
// - String matching is case-insensitive for: "Vulnerable", "Resisted", "Absorb", "Immune", "Neutral", "Damage", "Healing", "Miss".
// - Efficiency is treated as a percentage string like "100%". >100 = good, <100 = bad.
// ============================================================================

(async () => {
  const DEBUG = true;
  const STORE_SCOPE = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";

  const tag = "[BattleEnd:RankComputation]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  function nowIso() { return new Date().toISOString(); }
  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function clamp01(n) { return clamp(Number(n) || 0, 0, 1); }
  function safeNum(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : fallback;
  }
  function safeInt(v, fallback = 0) { return Math.floor(safeNum(v, fallback)); }
  function safeDiv(a, b) { return (b && Number.isFinite(b) && b !== 0) ? (a / b) : 0; }

  function normStr(v) { return String(v ?? "").trim().toLowerCase(); }

  // --------------------------------------------------------------------------
  // Tunables (edit freely)
  // --------------------------------------------------------------------------
  const CFG = {
    normal: {
      // Speed curve (more lenient than before)
      Rbest: 2,
      k: 0.25,

      // Weights (total score still clamped 0..100)
      W_SPEED: 50,

      // CHANGED: Damage weight down, tactics cap up (tactics matters more than damage)
      W_DAMAGE: 20,
      W_DAMAGE_OVER: 7,

      W_HEAL: 9,

      // CHANGED: proportionally higher cap so tactics can influence rank more
      W_TACTICS: 35,
      W_MISTAKES: 30,

      // Damage / Heal thresholds (tune per your game)
      Dbad: 10,
      Dsuper: 140,
      Hstd: 25,
      Hgood: 120,

      // Damage overflow curve (bigger = harder to cap the overflow bonus)
      DAMAGE_OVER_SCALE: 20,

      // MP bonus caps + weights (optional)
      MPHealCap: 100,
      MPBurnCap: 100,
      W_MP_HEAL: 3,
      W_MP_BURN: 3,

      // Flat bonus / penalty points per event (NOT rate-based, NOT dependent on each other)
      HIT_BONUS: 0.22,
      MISS_PENALTY: 0.3,
      VULN_BONUS: 2,

      // Existing penalty
      RESIST_PENALTY: 1.0,

      // NEW: Absorb / Immune penalties (heavier than Resisted)
      ABSORB_PENALTY: 3,
      IMMUNE_PENALTY: 2,

      EFFGOOD_BONUS: 0.35,
      EFFBAD_PENALTY: 0.55,
      DODGE_BONUS: 0.45,

      SCORE_MIN: 0,
      SCORE_MAX: 100
    },

    boss: {
      // Speed curve (boss is naturally longer; keep lenient)
      Rbest: 5,
      k: 0.30,

      W_SPEED: 42,

      // CHANGED: Damage weight down, tactics cap up (tactics matters more than damage)
      W_DAMAGE: 18,
      W_DAMAGE_OVER: 6,

      W_HEAL: 13,

      // CHANGED: proportionally higher cap so tactics can influence rank more
      W_TACTICS: 35,
      W_MISTAKES: 30,

      // Thresholds (defaults; tune per boss HP pools)
      Dbad: 20,
      Dsuper: 200,
      Hstd: 40,
      Hgood: 180,

      DAMAGE_OVER_SCALE: 18,

      MPHealCap: 140,
      MPBurnCap: 140,
      W_MP_HEAL: 3,
      W_MP_BURN: 3,

      HIT_BONUS: 0.18,
      MISS_PENALTY: 0.3,
      VULN_BONUS: 2,
      RESIST_PENALTY: 1,

      // NEW: Absorb / Immune penalties (heavier than Resisted)
      ABSORB_PENALTY: 3,
      IMMUNE_PENALTY: 2,

      EFFGOOD_BONUS: 0.35,
      EFFBAD_PENALTY: 0.55,
      DODGE_BONUS: 0.45,

      SCORE_MIN: 0,
      SCORE_MAX: 100
    }
  };

  function scoreToLetter(score) {
    const s = safeNum(score, 0);
    if (s >= 90) return "S";
    if (s >= 80) return "A";
    if (s >= 70) return "B";
    if (s >= 60) return "C";
    if (s >= 50) return "D";
    if (s >= 40) return "E";
    return "F";
  }

  // --------------------------------------------------------------------------
  // Locate canonical payload scene (source scene) while we're on battle scene
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

      if (!best || createdAtMs > best.createdAtMs) best = { scene: s, payload: p, createdAtMs };
    }
    return best;
  }

  function locateSourceSceneAndPayloadForThisBattle() {
    const activeBattleSceneId = canvas.scene?.id;
    let bestMatch = null;
    let bestMatchMs = 0;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const battleSceneIdInPayload = p?.step4?.battleScene?.id ?? null;
      if (battleSceneIdInPayload && activeBattleSceneId && battleSceneIdInPayload === activeBattleSceneId) {
        const ms = parseIsoToMs(p?.meta?.createdAt) || Number(p?.step4?.transitionedAt ?? 0) || 0;
        if (!bestMatch || ms > bestMatchMs) {
          bestMatch = { scene: s, payload: p, from: "scene-scan-match-step4.battleScene.id" };
          bestMatchMs = ms;
        }
      }
    }

    if (bestMatch) return bestMatch;

    const local = canvas.scene?.getFlag?.(STORE_SCOPE, CANONICAL_KEY);
    if (local) return { scene: canvas.scene, payload: local, from: "current-scene" };

    const best = pickLatestPayloadAcrossScenes();
    if (best) return { scene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  // --------------------------------------------------------------------------
  // DB resolver (matches your existing pattern)
  // --------------------------------------------------------------------------
  async function resolveDbActor() {
    const api = globalThis.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      const out = await api.getCurrentGameDb();
      const dbActor = out?.dbActor ?? out?.db ?? out?.actor ?? null;
      if (dbActor) return { dbActor, via: "FUCompanion.api.getCurrentGameDb" };
    }

    const r = globalThis.DB_resolver;
    if (typeof r === "function") {
      const dbActor = await r();
      if (dbActor) return { dbActor, via: "DB_resolver()" };
    }

    return { dbActor: null, via: "missing" };
  }

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: RankComputation is GM-only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd: No active scene.");
    return;
  }

  const located = locateSourceSceneAndPayloadForThisBattle();
  if (!located?.payload || !located?.scene) {
    ui.notifications?.error?.(`BattleEnd RankComputation: No canonical payload found at ${STORE_SCOPE}.${CANONICAL_KEY}.`);
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

  // Must be victory
  const mode = normStr(payload?.battleEnd?.meta?.mode);
  if (mode !== "victory") {
    ui.notifications?.info?.("BattleEnd RankComputation skipped (not Victory).");
    return;
  }

  // Must have SummaryLogic
  const summaryLogicStatus = normStr(payload?.phases?.battleEnd?.summaryLogic?.status);
  if (summaryLogicStatus !== "ok") {
    ui.notifications?.warn?.("BattleEnd RankComputation: SummaryLogic not complete yet.");
    return;
  }

  // --------------------------------------------------------------------------
  // Determine battle type (normal vs boss)
  // --------------------------------------------------------------------------
  const isBoss =
    Boolean(payload?.battlePlan?.isBoss) ||
    (normStr(payload?.battlePlan?.type) === "boss");

  const cfg = isBoss ? CFG.boss : CFG.normal;

  // --------------------------------------------------------------------------
  // Input totals (Rounds, Damage, Healing)
  // --------------------------------------------------------------------------
  const R = safeInt(payload?.battleEnd?.prompt?.combat?.round, 0);
  const combatTotals = payload?.battleEnd?.results?.combatTotals ?? {};
  const D = safeInt(combatTotals?.totalDamage, 0);
  const H = safeInt(combatTotals?.totalHealing, 0);

  // --------------------------------------------------------------------------
  // Build Party roster (member_name_1..4 + SummaryLogic expApplied list)
  // + Friendly tokens (disposition=1) for summoned allies
  // --------------------------------------------------------------------------
  const { dbActor, via: dbVia } = await resolveDbActor();
  if (!dbActor) {
    ui.notifications?.error?.("BattleEnd RankComputation: Could not resolve Database Actor.");
    return;
  }

  const props = dbActor?.system?.props ?? {};
  const partyNames = new Set();

  for (let i = 1; i <= 4; i++) {
    const nm = String(props?.[`member_name_${i}`] ?? "").trim();
    if (nm) partyNames.add(nm.toLowerCase());
  }

  const expApplied = payload?.battleEnd?.results?.expApplied;
  if (Array.isArray(expApplied)) {
    for (const row of expApplied) {
      const nm = String(row?.actorName ?? "").trim();
      if (nm) partyNames.add(nm.toLowerCase());
    }
  }

  const friendlyTokenNames = new Set();
  try {
    for (const t of (canvas.tokens?.placeables ?? [])) {
      const disp = Number(t?.document?.disposition ?? 0);
      if (disp !== 1) continue;
      const nm = String(t?.name ?? t?.document?.name ?? "").trim();
      if (nm) friendlyTokenNames.add(nm.toLowerCase());
    }
  } catch {}

  function isPartyName(name) {
    const n = String(name ?? "").trim().toLowerCase();
    if (!n) return false;
    return partyNames.has(n) || friendlyTokenNames.has(n);
  }

  // --------------------------------------------------------------------------
  // Read Battle Log Table
  // --------------------------------------------------------------------------
  const table = props?.battle_log_table ?? {};
  const rows = Object.values(table).filter(r => r && r.$deleted !== true);

  // Counters for tactics
  let partyHits = 0;
  let partyMiss = 0;

  let weakHits = 0;
  let resistHits = 0;

  // NEW: absorb/immune counts (treated as heavier penalties)
  let absorbHits = 0;
  let immuneHits = 0;

  let effGood = 0;
  let effBad = 0;

  let enemyAttacksOnParty = 0;
  let enemyMissOnParty = 0;

  // MP metrics
  let mpHealed = 0;
  let mpBurned = 0;

  function parseEffPct(v) {
    const n = safeNum(v, NaN);
    return Number.isFinite(n) ? n : NaN;
  }

  function modeIsDamage(m) { return normStr(m).includes("damage"); }
  function modeIsHeal(m)   { return normStr(m).includes("healing"); }
  function modeIsMiss(m)   { return normStr(m).includes("miss"); }

  for (const r of rows) {
    const attacker = String(r?.attacker ?? "").trim();
    const target = String(r?.attack_target ?? "").trim();
    const applyMode = String(r?.apply_mode ?? "");
    const valueType = normStr(r?.value_type ?? "");
    const affinity = normStr(r?.affinity ?? "");
    const effPct = parseEffPct(r?.efficiency);

    const attackerIsParty = isPartyName(attacker);
    const targetIsParty = isPartyName(target);

    // -------- Party attack stats (hits / miss / affinity / efficiency)
    if (attackerIsParty) {
      if (modeIsMiss(applyMode)) {
        partyMiss += 1;
      }

      if (modeIsDamage(applyMode)) {
        if (valueType === "hp") {
          partyHits += 1;

          if (affinity.includes("vulner")) weakHits += 1;
          if (affinity.includes("resist")) resistHits += 1;

          // NEW: Absorb / Immune are treated as penalties (worse than Resisted)
          if (affinity.includes("absorb")) absorbHits += 1;
          if (affinity.includes("immune")) immuneHits += 1;

          if (Number.isFinite(effPct)) {
            if (effPct > 100) effGood += 1;
            if (effPct < 100) effBad += 1;
          }
        }

        if (valueType === "mp") {
          const v = safeInt(r?.value, 0);
          if (v > 0) mpBurned += v;
        }
      }

      if (modeIsHeal(applyMode)) {
        if (valueType === "mp") {
          const v = safeInt(r?.value, 0);
          if (v > 0) mpHealed += v;
        }
      }
    }

    // -------- Enemy attacks on party (dodge rate)
    if (!attackerIsParty && targetIsParty) {
      if (modeIsDamage(applyMode) || modeIsMiss(applyMode)) {
        enemyAttacksOnParty += 1;
        if (modeIsMiss(applyMode)) enemyMissOnParty += 1;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Normalize scores
  // --------------------------------------------------------------------------
  let speed01 = 0;
  if (R > 0) {
    if (R <= cfg.Rbest) speed01 = 1;
    else speed01 = clamp01(Math.exp(-cfg.k * (R - cfg.Rbest)));
  }

  const damage01 = (cfg.Dsuper > cfg.Dbad)
    ? clamp01((D - cfg.Dbad) / (cfg.Dsuper - cfg.Dbad))
    : 0;

  const heal01 = (cfg.Hgood > cfg.Hstd)
    ? clamp01((H - cfg.Hstd) / (cfg.Hgood - cfg.Hstd))
    : 0;

  const mpHeal01 = cfg.MPHealCap > 0 ? clamp01(mpHealed / cfg.MPHealCap) : 0;
  const mpBurn01 = cfg.MPBurnCap > 0 ? clamp01(mpBurned / cfg.MPBurnCap) : 0;

  // Rates (for reporting / tuning visibility)
  const missRate = safeDiv(partyMiss, Math.max(1, partyHits + partyMiss));
  const dodgeRate = safeDiv(enemyMissOnParty, Math.max(1, enemyAttacksOnParty));
  const weakRate = safeDiv(weakHits, Math.max(1, partyHits));
  const resistRate = safeDiv(resistHits, Math.max(1, partyHits));
  const absorbRate = safeDiv(absorbHits, Math.max(1, partyHits));
  const immuneRate = safeDiv(immuneHits, Math.max(1, partyHits));
  const effRate = safeDiv((effGood - effBad), Math.max(1, partyHits));

  // --------------------------------------------------------------------------
  // Flat tactics / mistakes (points, capped)
  // --------------------------------------------------------------------------
  const tacticsRaw =
    (partyHits * cfg.HIT_BONUS) +
    (weakHits * cfg.VULN_BONUS) +
    (effGood * cfg.EFFGOOD_BONUS) +
    (enemyMissOnParty * cfg.DODGE_BONUS);

  const mistakesRaw =
    (partyMiss * cfg.MISS_PENALTY) +
    (resistHits * cfg.RESIST_PENALTY) +
    (absorbHits * cfg.ABSORB_PENALTY) +
    (immuneHits * cfg.IMMUNE_PENALTY) +
    (effBad * cfg.EFFBAD_PENALTY);

  const tacticsScore = clamp(tacticsRaw, 0, cfg.W_TACTICS);
  const mistakePenalty = clamp(mistakesRaw, 0, cfg.W_MISTAKES);

  const tactics01 = cfg.W_TACTICS > 0 ? clamp01(tacticsScore / cfg.W_TACTICS) : 0;
  const mistakes01 = cfg.W_MISTAKES > 0 ? clamp01(mistakePenalty / cfg.W_MISTAKES) : 0;

  // --------------------------------------------------------------------------
  // Damage overflow bonus
  // --------------------------------------------------------------------------
  const overRatio = Math.max(0, D - cfg.Dsuper) / Math.max(1, cfg.Dsuper);
  const damageOver01 = (cfg.DAMAGE_OVER_SCALE > 0)
    ? clamp01(Math.log1p(overRatio) / Math.log1p(cfg.DAMAGE_OVER_SCALE))
    : 0;

  // --------------------------------------------------------------------------
  // Final score
  // --------------------------------------------------------------------------
  const speedScore      = cfg.W_SPEED      * speed01;
  const damageScore     = cfg.W_DAMAGE     * damage01;
  const damageOverScore = cfg.W_DAMAGE_OVER * damageOver01;
  const healScore       = cfg.W_HEAL       * heal01;
  const mpHealScore     = cfg.W_MP_HEAL    * mpHeal01;
  const mpBurnScore     = cfg.W_MP_BURN    * mpBurn01;

  let rankScore =
    speedScore +
    damageScore +
    damageOverScore +
    healScore +
    mpHealScore +
    mpBurnScore +
    tacticsScore -
    mistakePenalty;

  rankScore = clamp(rankScore, cfg.SCORE_MIN, cfg.SCORE_MAX);

  const rankLetter = scoreToLetter(rankScore);

  // --------------------------------------------------------------------------
  // Write to payload
  // --------------------------------------------------------------------------
  payload.battleEnd ??= {};
  payload.battleEnd.results ??= {};

  payload.battleEnd.results.rank = {
    at: nowIso(),
    isBoss,
    score: Math.round(rankScore * 10) / 10,
    letter: rankLetter,
    inputs: {
      totalRounds: R,
      totalDamage: D,
      totalHealing: H,
      mpHealed,
      mpBurned
    },
    sub: {
      speed01, damage01, damageOver01, heal01, mpHeal01, mpBurn01, tactics01, mistakes01,
      speedScore, damageScore, damageOverScore, healScore, mpHealScore, mpBurnScore,
      tacticsRaw, mistakesRaw,
      tacticsScore, mistakePenalty
    },
    counts: {
      partyHits,
      partyMiss,
      weakHits,
      resistHits,
      absorbHits,
      immuneHits,
      effGood,
      effBad,
      enemyAttacksOnParty,
      enemyMissOnParty
    },
    rates: {
      missRate,
      dodgeRate,
      weakRate,
      resistRate,
      absorbRate,
      immuneRate,
      effRate
    }
  };

  payload.phases ??= {};
  payload.phases.battleEnd ??= {};
  payload.phases.battleEnd.rankComputation = {
    status: "ok",
    at: nowIso(),
    details: {
      via: dbVia,
      rows: rows.length,
      isBoss,
      rankLetter,
      rankScore: Math.round(rankScore * 10) / 10
    }
  };

  await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);

  log("Rank computed ✅", payload.battleEnd.results.rank);
  ui.notifications?.info?.(`BattleEnd: Rank computed (${rankLetter}) ✅`);
})();
