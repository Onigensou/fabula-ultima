// Battle End Summary Logic — applies EXP + Zenit gains, computes combat totals.
//
// Reads awards from endCtx.promptResult.{expByActorId, zenitByActorId}.
// Writes results to endCtx.summaryResults for use by RankComputation + SummaryUI.
// Only runs on victory; skipped on defeat (endCtx is untouched).

import { log, warn } from "../logger.js";

const EXP_PATH   = "system.props.experience";
const LEVEL_PATH = "system.props.level";
const ZENIT_PATH = "system.props.zenit";
const EXP_START  = 1;
const LEVEL_UP_AT = 10;
const DECIMALS   = 2;

const gp = foundry.utils.getProperty;

function safeNumber(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(v, fallback = 0) {
  return Math.floor(safeNumber(v, fallback));
}

function roundTo(x, dec) {
  const p = Math.pow(10, dec);
  return Math.round(x * p) / p;
}

function computeExpAndLevel(beforeExpRaw, beforeLevelRaw, gainedRaw) {
  const beforeLevel = Math.max(1, Math.floor(safeNumber(beforeLevelRaw, 1)));
  let beforeExp = safeNumber(beforeExpRaw, EXP_START);
  if (!Number.isFinite(beforeExp) || beforeExp < EXP_START) beforeExp = EXP_START;
  if (beforeExp >= LEVEL_UP_AT) beforeExp = EXP_START;

  const gained = Math.max(0, safeNumber(gainedRaw, 0));
  const segments = [];

  let runningLevel = beforeLevel;
  let runningExp   = beforeExp;
  let total        = runningExp + gained;

  if (gained <= 0) {
    segments.push({ from: roundTo(runningExp, DECIMALS), to: roundTo(runningExp, DECIMALS), levelUp: false });
    return { beforeLevel, afterLevel: runningLevel, levelsGained: 0,
             beforeExp: roundTo(beforeExp, DECIMALS), afterExp: roundTo(runningExp, DECIMALS),
             gained: roundTo(gained, DECIMALS), segments };
  }

  let levelsGained = 0;
  while (total >= LEVEL_UP_AT) {
    segments.push({ from: roundTo(runningExp, DECIMALS), to: roundTo(LEVEL_UP_AT, DECIMALS), levelUp: true });
    total = EXP_START + (total - LEVEL_UP_AT);
    runningLevel += 1;
    levelsGained += 1;
    runningExp = EXP_START;
  }
  segments.push({ from: roundTo(runningExp, DECIMALS), to: roundTo(total, DECIMALS), levelUp: false });

  return { beforeLevel, afterLevel: runningLevel, levelsGained,
           beforeExp: roundTo(beforeExp, DECIMALS), afterExp: roundTo(total, DECIMALS),
           gained: roundTo(gained, DECIMALS), segments };
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

function normName(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function extractBattleLogRows(battleLogTable) {
  if (!battleLogTable) return [];
  if (Array.isArray(battleLogTable)) return battleLogTable;
  if (typeof battleLogTable === "object") return Object.values(battleLogTable);
  return [];
}

export async function runBattleEndSummaryLogic(endCtx) {
  const { promptResult, partyActorIds } = endCtx;
  const { expByActorId, zenitByActorId } = promptResult;

  // --- Apply EXP ---
  const expApplied = [];
  const expErrors  = [];

  for (const actorId of Object.keys(expByActorId)) {
    const actor = game.actors?.get?.(actorId);
    if (!actor) { expErrors.push(`Missing actor: ${actorId}`); continue; }

    const beforeExp   = gp(actor, EXP_PATH);
    const beforeLevel = gp(actor, LEVEL_PATH);
    const calc = computeExpAndLevel(beforeExp, beforeLevel, expByActorId[actorId]);

    try {
      await actor.update({ [EXP_PATH]: calc.afterExp, [LEVEL_PATH]: calc.afterLevel });
      expApplied.push({
        actorId, actorName: actor.name ?? "",
        exp:   { before: calc.beforeExp, gained: calc.gained, after: calc.afterExp },
        level: { before: calc.beforeLevel, after: calc.afterLevel, gained: calc.levelsGained, leveledUp: calc.levelsGained > 0 },
        segments: calc.segments,
      });
      log(`[BattleEnd:SummaryLogic] EXP applied: ${actor.name} ${calc.beforeExp}+${calc.gained}→${calc.afterExp} Lv${calc.beforeLevel}→${calc.afterLevel}`);
    } catch (e) {
      expErrors.push(`EXP update failed for ${actor.name}: ${e?.message ?? e}`);
      warn("[BattleEnd:SummaryLogic] EXP update threw:", e);
    }
  }

  // --- Apply Zenit ---
  const zenitApplied = [];
  const zenitErrors  = [];

  for (const actorId of Object.keys(zenitByActorId)) {
    const actor = game.actors?.get?.(actorId);
    if (!actor) { zenitErrors.push(`Missing actor: ${actorId}`); continue; }

    const gained      = Math.max(0, safeInt(zenitByActorId[actorId], 0));
    const beforeZenit = safeInt(gp(actor, ZENIT_PATH), 0);
    const afterZenit  = beforeZenit + gained;

    try {
      await actor.update({ [ZENIT_PATH]: afterZenit });
      zenitApplied.push({
        actorId, actorName: actor.name ?? "",
        zenit: { before: beforeZenit, gained, after: afterZenit },
      });
      log(`[BattleEnd:SummaryLogic] Zenit applied: ${actor.name} ${beforeZenit}+${gained}→${afterZenit}`);
    } catch (e) {
      zenitErrors.push(`Zenit update failed for ${actor.name}: ${e?.message ?? e}`);
      warn("[BattleEnd:SummaryLogic] Zenit update threw:", e);
    }
  }

  // --- Combat Totals from DB battle_log_table ---
  let combatTotals = { totalDamage: 0, totalHealing: 0 };

  try {
    const dbActor = await resolveDbActor();
    if (dbActor) {
      const partyNameSet = new Set();
      for (const r of expApplied) { const n = normName(r.actorName); if (n) partyNameSet.add(n); }
      for (const id of partyActorIds) {
        const nm = normName(game.actors?.get?.(id)?.name ?? "");
        if (nm) partyNameSet.add(nm);
      }
      const dbProps = dbActor.system?.props ?? {};
      for (const [k, v] of Object.entries(dbProps)) {
        if (String(k).startsWith("member_name_")) {
          const n = normName(v); if (n) partyNameSet.add(n);
        }
      }

      const isPartyAttacker = (attackerNorm) => {
        if (!attackerNorm) return false;
        if (partyNameSet.has(attackerNorm)) return true;
        for (const n of partyNameSet) { if (n && attackerNorm.includes(n)) return true; }
        return false;
      };

      let totalDamage = 0, totalHealing = 0;
      const rows = extractBattleLogRows(dbProps.battle_log_table);

      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        if (row.$deleted === true || String(row.$deleted).toLowerCase() === "true") continue;

        const attacker  = normName(row.attacker);
        if (!isPartyAttacker(attacker)) continue;

        const valueType = normName(row.value_type ?? "");
        if (valueType !== "hp") continue;

        const applyMode = normName(row.apply_mode ?? "");
        const val = Math.max(0, safeNumber(row.value, 0));
        if (val <= 0) continue;

        if (applyMode.includes("damage")) totalDamage += val;
        else if (applyMode.includes("heal")) totalHealing += val;
      }

      combatTotals = { totalDamage: Math.floor(totalDamage), totalHealing: Math.floor(totalHealing) };
    }
  } catch (e) {
    warn("[BattleEnd:SummaryLogic] Combat totals failed (continuing):", e);
  }

  endCtx.summaryResults = {
    expApplied,
    zenitApplied,
    combatTotals,
    expRule: { expStart: EXP_START, levelUpAt: LEVEL_UP_AT, decimals: DECIMALS, expPath: EXP_PATH, levelPath: LEVEL_PATH },
    zenitRule: { zenitPath: ZENIT_PATH },
    errors: [...expErrors, ...zenitErrors],
  };

  if (expErrors.length || zenitErrors.length) {
    ui.notifications?.warn?.(`BattleEnd: SummaryLogic applied with ${expErrors.length + zenitErrors.length} issue(s). Check console.`);
  }
}
