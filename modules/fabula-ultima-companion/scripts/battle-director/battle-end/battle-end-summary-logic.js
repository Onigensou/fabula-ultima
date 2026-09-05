// Battle End Summary Logic — applies EXP + Zenit gains, computes combat totals.
//
// Reads awards from endCtx.promptResult.{expByActorId, zenitByActorId}.
// Writes results to endCtx.summaryResults for use by RankComputation + SummaryUI.
// Only runs on victory; skipped on defeat (endCtx is untouched).
//
// EXP is no longer applied here. This file used to own its own copy of the
// gauge maths, which is how it ended up NOT minting the Skill Point a gained
// level owes — that lived only in expAwarder, so every Director level-up left
// drift for a GM to clear by hand with `healPoints()`. The write now goes
// through shared/exp-core.js, the single owner of experience / level /
// skill_point, and the mint comes with it. Zenit and combat totals are still
// this file's own business.
//
// See [[exp-core]] and docs/exp-award-pipeline.md.

import { log, warn } from "../logger.js";
import { EXP_RULE, applyExpAward } from "../../shared/exp-core.js";

const ZENIT_PATH = "system.props.zenit";

const gp = foundry.utils.getProperty;

function safeNumber(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(v, fallback = 0) {
  return Math.floor(safeNumber(v, fallback));
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
  //
  // playUi is FALSE on purpose. The award panel that oni:expAwarded drives is
  // the standalone surface for an out-of-band grant; here the victory summary
  // screen IS the presentation, and it animates from the `segments` these
  // entries carry. Firing both would stack two EXP bars on top of each other.
  // The level-up badge picks the change up from `updateActor` regardless.
  const expResult = await applyExpAward({
    amountByActorId: expByActorId,
    source: "Battle Victory",
    playUi: false,
  });

  const expApplied = expResult.entries;
  const expErrors  = expResult.errors ?? [];

  for (const e of expApplied) {
    const minted = e.skillPointsMinted > 0 ? ` +${e.skillPointsMinted} SP` : "";
    log(`[BattleEnd:SummaryLogic] EXP applied: ${e.actorName} ${e.exp.before}+${e.exp.gained}→${e.exp.after} Lv${e.level.before}→${e.level.after}${minted}`);
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
    expRule: {
      expStart:  EXP_RULE.EXP_START,
      levelUpAt: EXP_RULE.LEVEL_UP_AT,
      decimals:  EXP_RULE.DECIMALS,
      expPath:   EXP_RULE.EXP_PATH,
      levelPath: EXP_RULE.LEVEL_PATH,
    },
    zenitRule: { zenitPath: ZENIT_PATH },
    errors: [...expErrors, ...zenitErrors],
  };

  if (expErrors.length || zenitErrors.length) {
    ui.notifications?.warn?.(`BattleEnd: SummaryLogic applied with ${expErrors.length + zenitErrors.length} issue(s). Check console.`);
  }
}
