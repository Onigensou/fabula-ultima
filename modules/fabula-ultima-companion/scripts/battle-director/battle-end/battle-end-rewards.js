// Battle End Rewards — pre-computes EXP and Zenit at PREP time.
//
// Called once when dCombat is first set up (all enemy tokens guaranteed live),
// result stored in a world setting and read at BATTLE_ENDING to pre-fill the
// GM prompt.
//
// The EXP half is no longer implemented here. The v1.2 formula used to exist
// twice — this file and the "BattleInit – Battle Record Writer" macro it was
// ported from — which is two copies free to drift apart on the next balance
// pass. It now lives once, in shared/exp-core.js, and this file supplies the
// party and enemy actors. Zenit stays here: it is battle-only, it rolls dice,
// and nothing else wants it.
//
// EXP formula (per PC), for reference — see exp-core for the implementation:
//   EXP = clamp( P_i × G × Σ(weight_k × B_rank × clamp(2^((E_j−L_i)/10), 0.25, 5)) × beta, 1, 15 )
//
// Zenit formula (per PC):
//   zenitFinal = floor( Σ randInt(enemy.min, enemy.max) × ZG × ZP )

import { log, warn } from "../logger.js";
import { computeExpAward } from "../../shared/exp-core.js";

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

  const partyActors = partyCombatants.map(c => c.actorDoc);
  const enemyActors = enemyCombatants.map(c => c.actorDoc);

  // --- EXP: the shared v1.2 formula ---
  // Rank multipliers, the global multiplier and the boss premium are all read
  // from the Current Game DB inside exp-core, so a balance change is still a
  // DB edit rather than a code edit. A normal battle takes the default mult,
  // floor and cap; only a discounted source (a stealth takedown) overrides them.
  const { expByActorId: expMap } = await computeExpAward({
    partyActors,
    enemyActors,
    isBoss: !!isBoss,
  });
  Object.assign(expByActorId, expMap);

  // --- Zenit: battle-only, rolled once for the whole group ---
  // The same rolled sum is applied to every PC; each PC's personal multiplier
  // scales their individual share.
  let ZG = 1.0;
  try {
    const api = globalThis.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      const { source: db } = await api.getCurrentGameDb();
      if (db) ZG = getNum(db, "system.props.zenit_global_multiplier", 1.0);
    }
  } catch (e) {
    warn("[BattleEnd:Rewards] Zenit DB read failed — using fallback multiplier:", e);
  }

  const sumEnemyZenitRolls = enemyActors.reduce((acc, a) => acc + randIntInclusive(
    getNum(a, "system.props.zenit_reward_min", 0),
    getNum(a, "system.props.zenit_reward_max", 0),
  ), 0);

  for (const a of partyActors) {
    const actorId = a?.id;
    if (!actorId) continue;
    const ZP = getNum(a, "system.props.character_zenit_multiplier", 1.0);
    zenitByActorId[actorId] = Math.floor(sumEnemyZenitRolls * ZG * ZP);
  }

  log("[BattleEnd:Rewards] Snapshot computed", { expByActorId, zenitByActorId });
  return { expByActorId, zenitByActorId };
}
