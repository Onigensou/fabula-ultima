// ============================================================================
// Stealth Mode — handing off to the Battle Director.
//
// Built on the same payload shape dp-random-battle.js uses, because that file
// is a complete worked example of "a map event became a fight": resolve the
// group, set the engagement, build the payload, start the Director, return to
// the source scene afterwards.
//
// ── The one thing this adds ────────────────────────────────────────────────
// The engagement is not rolled, it is READ off the alert tier:
//
//   Stealth → advantage   the party acts first in round 1
//   Neutral → normal      initiative as usual
//   Alert   → ambush      the enemies act first
//
// battlePlan.engagement is already fully implemented in director-combat.js,
// including the round-one forced-side rule and the banner flash, so the three
// tiers cost nothing to honour.
// ============================================================================

import { TAG } from "./sm-constants.js";
import { engagementFor, pushLog } from "./sm-state.js";

const BATTLE_MAP_KEY = "battleMap";

/** The battle scene + BGM this map sends fights to, from the dungeon config. */
function readBattleConfig(scene) {
  const d = scene?.flags?.["fabula-ultima-companion"]?.oniDungeon ?? {};
  return {
    battleMap:  d[BATTLE_MAP_KEY] ?? null,
    battleBGM:  String(d.battleBGM ?? ""),
    bossBGM:    String(d.bossBGM ?? ""),
  };
}

/**
 * Build the Battle Director payload for a stealth contact.
 *
 * `manualPicks` are the enemies that actually joined, so a lone guard is a
 * lone fight and a corridor chase drags the whole pursuit in — the join radius
 * decides which, in sm-enemy-ai.conflictParticipants().
 */
export function buildConflictPayload({ sm, scene, participants, cfg }) {
  const picks = participants
    .map((e) => {
      const tokenDoc = scene?.tokens?.get?.(e.tokenId);
      const actor = tokenDoc?.actor ?? game.actors?.get?.(tokenDoc?.actorId);
      if (!actor) return null;
      return { uuid: actor.uuid, name: actor.name, id: actor.id, count: 1 };
    })
    .filter(Boolean);

  return {
    context: {
      battleSceneUuid: cfg.battleMap,
      sourceSceneId:   scene?.id,
      sourceSceneUuid: scene?.uuid,
      return:          { enabled: true },
    },
    // We already know exactly who is fighting, so the Director takes the
    // deterministic manual branch rather than re-rolling an encounter.
    encounterPlan: { mode: "manual", manualPicks: picks },
    party:         { members: [] },
    battlePlan: {
      type: "default",
      isBoss: false,
      initiativeMode: "rolled",
      engagement: engagementFor(sm.alert),
    },
    battleConfig: { bgm: cfg.battleBGM, battleSceneUuid: cfg.battleMap },
    options:      { battleSystem: "director" },
    meta: {
      source: "stealth-contact",
      sceneId: scene?.id,
      alert: sm.alert,
      round: sm.round,
    },
  };
}

/**
 * Launch the conflict. GM-side.
 *
 * Degrades loudly rather than silently: a stealth scene with no battle map
 * configured is an authoring mistake, and swallowing it would look like the
 * contact simply did nothing.
 */
export async function launchConflict({ sm, tune, scene, participants, atCell }) {
  const cfg = readBattleConfig(scene);

  if (!cfg.battleMap) {
    ui.notifications?.error?.(
      `Stealth: no Battle Map configured on "${scene?.name}" — cannot start the conflict.`,
    );
    pushLog(sm, "Conflict aborted: no battle map configured");
    return { ok: false, reason: "no-battle-map" };
  }

  if (!participants?.length) {
    pushLog(sm, "Conflict aborted: no participants resolved");
    return { ok: false, reason: "no-participants" };
  }

  const payload = buildConflictPayload({ sm, scene, participants, cfg });

  const api = globalThis.FUCompanion?.api?.experimental?.battleDirector;
  if (!api?.start) {
    ui.notifications?.error?.("Stealth: Battle Director unavailable.");
    return { ok: false, reason: "no-director" };
  }

  console.debug(TAG, `launching conflict — engagement=${payload.battlePlan.engagement}`, payload);
  await api.start({ payload });

  return { ok: true, engagement: payload.battlePlan.engagement, count: participants.length };
}
