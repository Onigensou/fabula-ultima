// Battle End Rank Computation — JRPG-style F–S rank from battle_log_table.
//
// Reads totalRounds from endCtx.totalRounds (dCombat.round),
// combat totals from endCtx.summaryResults.combatTotals (set by SummaryLogic),
// and per-hit stats from the DB battle_log_table.
// Writes endCtx.rank = { score, letter, inputs, sub, counts, rates }.

import { log, warn } from "../logger.js";

const CFG = {
  normal: {
    Rbest: 2, k: 0.25,
    W_SPEED: 50, W_DAMAGE: 20, W_DAMAGE_OVER: 7, W_HEAL: 9,
    W_TACTICS: 35, W_MISTAKES: 30,
    Dbad: 10, Dsuper: 140, Hstd: 25, Hgood: 120,
    DAMAGE_OVER_SCALE: 20,
    MPHealCap: 100, MPBurnCap: 100, W_MP_HEAL: 3, W_MP_BURN: 3,
    HIT_BONUS: 0.22, MISS_PENALTY: 0.3, VULN_BONUS: 2,
    RESIST_PENALTY: 1.0, ABSORB_PENALTY: 3, IMMUNE_PENALTY: 2,
    EFFGOOD_BONUS: 0.35, EFFBAD_PENALTY: 0.55, DODGE_BONUS: 0.45,
    SCORE_MIN: 0, SCORE_MAX: 100,
  },
  boss: {
    Rbest: 5, k: 0.30,
    W_SPEED: 42, W_DAMAGE: 18, W_DAMAGE_OVER: 6, W_HEAL: 13,
    W_TACTICS: 35, W_MISTAKES: 30,
    Dbad: 20, Dsuper: 200, Hstd: 40, Hgood: 180,
    DAMAGE_OVER_SCALE: 18,
    MPHealCap: 140, MPBurnCap: 140, W_MP_HEAL: 3, W_MP_BURN: 3,
    HIT_BONUS: 0.18, MISS_PENALTY: 0.3, VULN_BONUS: 2,
    RESIST_PENALTY: 1, ABSORB_PENALTY: 3, IMMUNE_PENALTY: 2,
    EFFGOOD_BONUS: 0.35, EFFBAD_PENALTY: 0.55, DODGE_BONUS: 0.45,
    SCORE_MIN: 0, SCORE_MAX: 100,
  },
};

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function clamp01(n) { return clamp(Number(n) || 0, 0, 1); }
function safeNum(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}
function safeInt(v, fallback = 0) { return Math.floor(safeNum(v, fallback)); }
function safeDiv(a, b) { return (b && Number.isFinite(b) && b !== 0) ? (a / b) : 0; }
function normStr(v) { return String(v ?? "").trim().toLowerCase(); }

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

async function resolveDbActor() {
  try {
    const api = globalThis.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      const out = await api.getCurrentGameDb();
      return out?.dbActor ?? out?.db ?? out?.actor ?? null;
    }
  } catch (_) {}
  return null;
}

export async function runBattleEndRank(endCtx) {
  const { isBoss, totalRounds, summaryResults } = endCtx;
  const cfg = isBoss ? CFG.boss : CFG.normal;

  const R = totalRounds;
  const { totalDamage: D, totalHealing: H } = summaryResults?.combatTotals ?? {};

  const dbActor = await resolveDbActor();
  if (!dbActor) {
    warn("[BattleEnd:Rank] Could not resolve DB actor — rank will be computed from totals only");
  }

  // Build party name set (DB member names + expApplied actor names)
  const partyNames = new Set();
  const friendlyTokenNames = new Set();

  if (dbActor) {
    const props = dbActor.system?.props ?? {};
    for (let i = 1; i <= 4; i++) {
      const nm = normStr(props[`member_name_${i}`] ?? ""); if (nm) partyNames.add(nm);
    }
  }
  for (const row of (summaryResults?.expApplied ?? [])) {
    const nm = normStr(row?.actorName ?? ""); if (nm) partyNames.add(nm);
  }
  try {
    for (const t of (canvas.tokens?.placeables ?? [])) {
      if (Number(t?.document?.disposition ?? 0) === 1) {
        const nm = normStr(t?.name ?? ""); if (nm) friendlyTokenNames.add(nm);
      }
    }
  } catch (_) {}

  function isPartyName(name) {
    const n = normStr(name);
    if (!n) return false;
    return partyNames.has(n) || friendlyTokenNames.has(n);
  }

  // Parse battle_log_table
  const table = dbActor?.system?.props?.battle_log_table ?? {};
  const rows  = Object.values(table).filter(r => r && r.$deleted !== true);

  let partyHits = 0, partyMiss = 0;
  let weakHits = 0, resistHits = 0, absorbHits = 0, immuneHits = 0;
  let effGood = 0, effBad = 0;
  let enemyAttacksOnParty = 0, enemyMissOnParty = 0;
  let mpHealed = 0, mpBurned = 0;

  const modeIsDamage = m => normStr(m).includes("damage");
  const modeIsHeal   = m => normStr(m).includes("heal");
  const modeIsMiss   = m => normStr(m).includes("miss");
  const parseEffPct  = v => { const n = safeNum(v, NaN); return Number.isFinite(n) ? n : NaN; };

  for (const r of rows) {
    const attacker      = String(r?.attacker ?? "").trim();
    const target        = String(r?.attack_target ?? "").trim();
    const applyMode     = String(r?.apply_mode ?? "");
    const valueType     = normStr(r?.value_type ?? "");
    const affinity      = normStr(r?.affinity ?? "");
    const effPct        = parseEffPct(r?.efficiency);
    const attackerIsParty = isPartyName(attacker);
    const targetIsParty   = isPartyName(target);

    if (attackerIsParty) {
      if (modeIsMiss(applyMode)) partyMiss += 1;
      if (modeIsDamage(applyMode) && valueType === "hp") {
        partyHits += 1;
        if (affinity.includes("vulner")) weakHits   += 1;
        if (affinity.includes("resist")) resistHits += 1;
        if (affinity.includes("absorb")) absorbHits += 1;
        if (affinity.includes("immune")) immuneHits += 1;
        if (Number.isFinite(effPct)) {
          if (effPct > 100) effGood += 1;
          if (effPct < 100) effBad  += 1;
        }
      }
      if (modeIsDamage(applyMode) && valueType === "mp") {
        const v = safeInt(r?.value, 0); if (v > 0) mpBurned += v;
      }
      if (modeIsHeal(applyMode) && valueType === "mp") {
        const v = safeInt(r?.value, 0); if (v > 0) mpHealed += v;
      }
    }
    if (!attackerIsParty && targetIsParty) {
      if (modeIsDamage(applyMode) || modeIsMiss(applyMode)) {
        enemyAttacksOnParty += 1;
        if (modeIsMiss(applyMode)) enemyMissOnParty += 1;
      }
    }
  }

  // Normalize
  let speed01 = 0;
  if (R > 0) speed01 = R <= cfg.Rbest ? 1 : clamp01(Math.exp(-cfg.k * (R - cfg.Rbest)));

  const damage01     = cfg.Dsuper > cfg.Dbad ? clamp01((D - cfg.Dbad) / (cfg.Dsuper - cfg.Dbad)) : 0;
  const heal01       = cfg.Hgood > cfg.Hstd  ? clamp01((H - cfg.Hstd)  / (cfg.Hgood - cfg.Hstd))  : 0;
  const mpHeal01     = cfg.MPHealCap > 0 ? clamp01(mpHealed / cfg.MPHealCap) : 0;
  const mpBurn01     = cfg.MPBurnCap > 0 ? clamp01(mpBurned / cfg.MPBurnCap) : 0;

  const overRatio    = Math.max(0, D - cfg.Dsuper) / Math.max(1, cfg.Dsuper);
  const damageOver01 = cfg.DAMAGE_OVER_SCALE > 0
    ? clamp01(Math.log1p(overRatio) / Math.log1p(cfg.DAMAGE_OVER_SCALE)) : 0;

  const missRate    = safeDiv(partyMiss, Math.max(1, partyHits + partyMiss));
  const dodgeRate   = safeDiv(enemyMissOnParty, Math.max(1, enemyAttacksOnParty));
  const weakRate    = safeDiv(weakHits,   Math.max(1, partyHits));
  const resistRate  = safeDiv(resistHits, Math.max(1, partyHits));
  const absorbRate  = safeDiv(absorbHits, Math.max(1, partyHits));
  const immuneRate  = safeDiv(immuneHits, Math.max(1, partyHits));
  const effRate     = safeDiv((effGood - effBad), Math.max(1, partyHits));

  const tacticsRaw  = (partyHits * cfg.HIT_BONUS) + (weakHits * cfg.VULN_BONUS) +
                      (effGood * cfg.EFFGOOD_BONUS) + (enemyMissOnParty * cfg.DODGE_BONUS);
  const mistakesRaw = (partyMiss * cfg.MISS_PENALTY) + (resistHits * cfg.RESIST_PENALTY) +
                      (absorbHits * cfg.ABSORB_PENALTY) + (immuneHits * cfg.IMMUNE_PENALTY) +
                      (effBad * cfg.EFFBAD_PENALTY);

  const tacticsScore   = clamp(tacticsRaw,  0, cfg.W_TACTICS);
  const mistakePenalty = clamp(mistakesRaw, 0, cfg.W_MISTAKES);
  const tactics01      = cfg.W_TACTICS  > 0 ? clamp01(tacticsScore / cfg.W_TACTICS)   : 0;
  const mistakes01     = cfg.W_MISTAKES > 0 ? clamp01(mistakePenalty / cfg.W_MISTAKES) : 0;

  let rankScore =
    (cfg.W_SPEED      * speed01) +
    (cfg.W_DAMAGE     * damage01) +
    (cfg.W_DAMAGE_OVER * damageOver01) +
    (cfg.W_HEAL       * heal01) +
    (cfg.W_MP_HEAL    * mpHeal01) +
    (cfg.W_MP_BURN    * mpBurn01) +
    tacticsScore - mistakePenalty;

  rankScore = clamp(rankScore, cfg.SCORE_MIN, cfg.SCORE_MAX);
  const rankLetter = scoreToLetter(rankScore);

  endCtx.rank = {
    isBoss, score: Math.round(rankScore * 10) / 10, letter: rankLetter,
    inputs: { totalRounds: R, totalDamage: D, totalHealing: H, mpHealed, mpBurned },
    sub: {
      speed01, damage01, damageOver01, heal01, mpHeal01, mpBurn01, tactics01, mistakes01,
      speedScore: cfg.W_SPEED * speed01, damageScore: cfg.W_DAMAGE * damage01,
      damageOverScore: cfg.W_DAMAGE_OVER * damageOver01, healScore: cfg.W_HEAL * heal01,
      mpHealScore: cfg.W_MP_HEAL * mpHeal01, mpBurnScore: cfg.W_MP_BURN * mpBurn01,
      tacticsRaw, mistakesRaw, tacticsScore, mistakePenalty,
    },
    counts: { partyHits, partyMiss, weakHits, resistHits, absorbHits, immuneHits, effGood, effBad, enemyAttacksOnParty, enemyMissOnParty },
    rates:  { missRate, dodgeRate, weakRate, resistRate, absorbRate, immuneRate, effRate },
  };

  log(`[BattleEnd:Rank] ${rankLetter} (${rankScore.toFixed(1)}) — R=${R} D=${D} H=${H}`);
}
