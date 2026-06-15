// Battle End Rewards — pre-computes EXP and Zenit at PREP time.
//
// Called once when dCombat is first set up (all enemy tokens guaranteed live),
// result stored in a world setting and read at BATTLE_ENDING to pre-fill the
// GM prompt. Ports the formula from "BattleInit – Battle Record Writer" macro.
//
// EXP formula (per PC):
//   EXP = clamp( P_i × G × Σ(weight_k × B_rank × clamp(2^((E_j−L_i)/10), 0.25, 5)) × beta, 1, 15 )
//
// Zenit formula (per PC):
//   zenitFinal = floor( Σ randInt(enemy.min, enemy.max) × ZG × ZP )

import { log, warn } from "../logger.js";

const EXP_A     = 10;
const EXP_M_MIN = 0.25;
const EXP_M_MAX = 5.0;
const EXP_FLOOR = 1;
const EXP_CAP   = 15;
const WEIGHTS   = [1.00, 0.70, 0.55, 0.45, 0.40];

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function weightAt(k1) {
  const i = k1 - 1;
  return i < WEIGHTS.length ? WEIGHTS[i] : WEIGHTS[WEIGHTS.length - 1];
}

function randIntInclusive(min, max) {
  const lo = Math.min(Math.floor(Number(min)), Math.floor(Number(max)));
  const hi = Math.max(Math.floor(Number(min)), Math.floor(Number(max)));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  if (hi <= lo) return lo;
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

function getNum(obj, path, fallback = 0) {
  const v = foundry.utils.getProperty(obj, path);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getLevel(actorDoc) {
  const n = getNum(actorDoc, "system.props.level", NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function getEnemyRank(actorDoc) {
  const raw = String(actorDoc?.system?.props?.npc_rank ?? "").toLowerCase().trim();
  if (raw === "champion") return "champion";
  if (raw === "elite")    return "elite";
  return "soldier";
}

export async function computeBattleEndRewards(dCombat, isBoss) {
  const expByActorId   = {};
  const zenitByActorId = {};

  if (!dCombat) return { expByActorId, zenitByActorId };

  const partyCombatants = dCombat.combatants.filter(c => c.side === "party" && c.actorDoc);
  const enemyCombatants = dCombat.combatants.filter(c => c.side === "enemy" && c.actorDoc);

  if (!partyCombatants.length || !enemyCombatants.length) {
    warn("[BattleEnd:Rewards] Missing party or enemy combatants — snapshot will be empty");
    return { expByActorId, zenitByActorId };
  }

  // Read DB multipliers — fall back to sane defaults on failure
  let G = 1.0, B_soldier = 1.0, B_elite = 1.5, B_champion = 3.0, BossMult = 1.6, ZG = 1.0;
  try {
    const api = globalThis.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      const { source: db } = await api.getCurrentGameDb();
      if (db) {
        G          = getNum(db, "system.props.exp_global_multiplier",    1.0);
        B_soldier  = getNum(db, "system.props.exp_soldier_multiplier",   1.0);
        B_elite    = getNum(db, "system.props.exp_elite_multiplier",     1.5);
        B_champion = getNum(db, "system.props.exp_champion_multiplier",  3.0);
        BossMult   = getNum(db, "system.props.exp_boss_multiplier",      1.6);
        ZG         = getNum(db, "system.props.zenit_global_multiplier",  1.0);
      }
    }
  } catch (e) {
    warn("[BattleEnd:Rewards] DB read failed — using fallback multipliers:", e);
  }

  // Boss detection: explicit isBoss flag OR any champion-rank enemy
  const anyChampion = enemyCombatants.some(c => getEnemyRank(c.actorDoc) === "champion");
  const beta = (isBoss || anyChampion) ? BossMult : 1.0;

  // Build static enemy snapshot (level, rank, zenit range)
  const enemies = enemyCombatants.map(c => {
    const a    = c.actorDoc;
    const rank = getEnemyRank(a);
    return {
      level:    getLevel(a),
      rankMult: rank === "champion" ? B_champion : rank === "elite" ? B_elite : B_soldier,
      zenitMin: getNum(a, "system.props.zenit_reward_min", 0),
      zenitMax: getNum(a, "system.props.zenit_reward_max", 0),
    };
  });

  // Roll Zenit once for the whole group — same sum applied to every PC
  // (each PC's personal multiplier scales their individual share)
  const sumEnemyZenitRolls = enemies.reduce((acc, e) =>
    acc + randIntInclusive(e.zenitMin, e.zenitMax), 0);

  for (const c of partyCombatants) {
    const actorId = c.actorDoc?.id;
    if (!actorId) continue;
    const a  = c.actorDoc;
    const Li = getLevel(a);
    const Pi = getNum(a, "system.props.character_exp_multiplier",  1.0);
    const ZP = getNum(a, "system.props.character_zenit_multiplier", 1.0);

    // EXP: contribution per enemy, sorted descending, diminishing weights applied
    const contribs = enemies
      .map(e => e.rankMult * clamp(Math.pow(2, (e.level - Li) / EXP_A), EXP_M_MIN, EXP_M_MAX))
      .sort((a, b) => b - a);

    let Ri = 0;
    for (let k = 0; k < contribs.length; k++) Ri += weightAt(k + 1) * contribs[k];

    expByActorId[actorId]   = clamp(Pi * G * Ri * beta, EXP_FLOOR, EXP_CAP);
    zenitByActorId[actorId] = Math.floor(sumEnemyZenitRolls * ZG * ZP);
  }

  log("[BattleEnd:Rewards] Snapshot computed", { expByActorId, zenitByActorId });
  return { expByActorId, zenitByActorId };
}
