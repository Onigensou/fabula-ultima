// ⭐ Wandering Flame — random-encounter ambush follow-up rule.
//
// Story event: while active, beating a RANDOM encounter has an escalating
// chance to be interrupted by the Wandering Flame crashing down — the won
// fight ends and a brand-new conflict (round reset, conflict_start re-fires
// so the boss's beginning-of-conflict ability triggers) begins in place, on
// the same scene, with the same (worn-down) party.
//
// Activation is external game state (world setting), toggled from a story
// macro/quest step:
//   FUCompanion.api.experimental.battleDirector.followups.setActive(
//     "wandering-flame-ambush", true)   // ...and false when the segment ends
//
// Chance escalates via a pity counter (see CHANCE_TABLE): low at first,
// guaranteed by the 5th miss, reset when the boss appears. E[battles until
// spawn] ≈ 2.98 → roughly once every 3 random encounters.

import {
  registerFollowupRule,
  buildFollowupBattlePayload,
  isFollowupActive,
} from "../battle-followup.js";
import { playWanderingFlameEntrance } from "./wandering-flame-entrance.js";

export const RULE_ID = "wandering-flame-ambush";

// Tweak these without touching logic.
const BOSS_ACTOR_ID   = "KygETN50UthluNPl";    // world Actor id (primary lookup)
const BOSS_ACTOR_NAME = "⭐ Wandering Flame";  // name fallback if the id ever changes
const BOSS_BGM        = "Draconic Battle";     // boss track (playlist sound name, any playlist)

// Resolve the boss actor robustly: by id first, then by name. Returns an
// encounter pick with a concrete actorUuid when found (so resolveEncounter's
// manual path can't fail on an emoji-in-name mismatch), else a name-only pick.
function bossEnemyPick() {
  const boss =
    game.actors?.get?.(BOSS_ACTOR_ID) ??
    game.actors?.getName?.(BOSS_ACTOR_NAME) ??
    null;
  return boss ? { actorUuid: boss.uuid, quantity: 1 } : { name: BOSS_ACTOR_NAME, quantity: 1 };
}

// Spawn chance indexed by consecutive non-spawn random wins (the pity counter).
// Clamps to the last entry, so index 4+ → 100% (certain).
const CHANCE_TABLE = [0.10, 0.25, 0.50, 0.80, 1.00];

function chanceForPity(pity) {
  const i = Math.max(0, Math.min(CHANCE_TABLE.length - 1, Math.floor(pity || 0)));
  return CHANCE_TABLE[i];
}

export const wanderingFlameAmbushRule = {
  id: RULE_ID,
  label: "⭐ Wandering Flame — random-encounter ambush",
  priority: 100,
  outcomes: ["victory"],

  // Story gate — only live while the event is switched on.
  isActive: () => isFollowupActive(RULE_ID),

  // Fires after ANY battle type while active — EXCEPT a battle this rule itself
  // spawned (the ambush boss-fight), so it never chains into itself.
  isEligible: (endCtx) => endCtx?.followupRuleId !== RULE_ID,

  chance: (ctx) => chanceForPity(ctx?.pity ?? 0),

  // In-place "new conflict" hand-off. The entrance hook is carried on the
  // payload and invoked by the in-place reinforce init.
  resolve: (endCtx) => ({
    kind: "battle",
    payload: buildFollowupBattlePayload(endCtx, {
      enemies:        [bossEnemyPick()],
      bgm:            BOSS_BGM,
      isBoss:         true,
      battleType:     "boss",
      spawnedByRuleId: RULE_ID,
      followup:       { entrance: playWanderingFlameEntrance },
    }),
  }),
};

export function registerWanderingFlameAmbush() {
  registerFollowupRule(wanderingFlameAmbushRule);
}
