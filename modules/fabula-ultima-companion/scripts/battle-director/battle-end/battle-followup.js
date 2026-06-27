// Battle-End Follow-up registry — generic "what happens after a battle ends"
// rules. The ⭐ Wandering Flame ambush is one registered rule; the registry
// itself knows nothing about that boss.
//
// A rule decides three things, all data the rule owns:
//   isActive(endCtx)  → is this event live right now? (story gating)
//   chance(ctx)       → 0..1 probability (ctx.pity = escalation counter)
//   resolve(endCtx)   → what to do → { kind:"battle", payload } | { kind:"custom", run }
//
// evaluateFollowups() is called from the Battle-End orchestrator BEFORE the
// victory cinematic. If a rule fires it returns the resolved action; the
// orchestrator stashes the follow-up battle payload and the FSM routes
// BATTLE_ENDING → PREP (an in-place "new conflict") instead of STOPPED.
//
// Activation + pity counters persist in world settings (registered in
// director-boot.js): bdActiveFollowups { id:bool }, bdFollowupPity { id:int }.

import { log, warn } from "../logger.js";

const MODULE_ID     = "fabula-ultima-companion";
const SETTING_ACTIVE = "bdActiveFollowups";
const SETTING_PITY   = "bdFollowupPity";

// id → rule. Registered once at boot (director-boot.js `ready`).
const _rules = new Map();

export function registerFollowupRule(rule) {
  if (!rule || !rule.id) { warn("[Followup] registerFollowupRule: rule needs an id"); return; }
  _rules.set(rule.id, rule);
  log(`[Followup] registered rule "${rule.id}"`);
}
export function unregisterFollowupRule(id) { _rules.delete(id); }
export function listFollowupRules() { return Array.from(_rules.values()); }
export function clearFollowupRules() { _rules.clear(); }

// ─── Gating (world-setting map) ──────────────────────────────────────────

function readMap(key) {
  try { return foundry.utils.duplicate(game.settings.get(MODULE_ID, key) ?? {}); }
  catch { return {}; }
}
async function writeMap(key, map) {
  try { await game.settings.set(MODULE_ID, key, map); }
  catch (e) { warn(`[Followup] set ${key} failed`, e); }
}

export function isFollowupActive(id) { return !!readMap(SETTING_ACTIVE)[id]; }
export async function setFollowupActive(id, on) {
  const m = readMap(SETTING_ACTIVE);
  m[id] = !!on;
  await writeMap(SETTING_ACTIVE, m);
  log(`[Followup] "${id}" active=${!!on}`);
  return !!on;
}
export function listActiveFollowups() {
  const m = readMap(SETTING_ACTIVE);
  return Object.keys(m).filter((k) => m[k]);
}

// ─── Pity (escalation counter) ───────────────────────────────────────────

export function getFollowupPity(id) {
  return Math.max(0, Math.floor(Number(readMap(SETTING_PITY)[id] ?? 0) || 0));
}
async function setFollowupPity(id, n) {
  const m = readMap(SETTING_PITY);
  m[id] = Math.max(0, Math.floor(n));
  await writeMap(SETTING_PITY, m);
}
export async function resetFollowupPity(id) { await setFollowupPity(id, 0); }

// ─── Payload builder ─────────────────────────────────────────────────────
//
// Builds a director payload for an in-place "new conflict" follow-up, reusing
// the manual-encounter path of runDirectorInit. Same battle scene + same party
// by default; swaps in the given enemies (the boss). The party roster is
// rebuilt from the actors that just fought, so HP/MP/buffs carry over (the
// in-place init adopts the live party tokens — it does not re-spawn them).

export function buildFollowupBattlePayload(endCtx, {
  enemies = [],            // [{ actorUuid?, name?, quantity? }]
  battleSceneUuid = null,  // default: the current battle scene
  sourceSceneId = null,    // default: the original return (overworld) scene
  bgm = "",
  isBoss = true,
  battleType = "boss",
  spawnedByRuleId = null,  // tags meta.followupRuleId so a rule can't chain off its own battle
  followup = null,         // rule hook bag carried through to the entrance (e.g. { entrance })
} = {}) {
  const dc = endCtx?.director?.dCombat ?? null;
  const battleScene = dc?.scene ?? canvas?.scene ?? null;
  const resolvedBattleSceneUuid = battleSceneUuid ?? battleScene?.uuid ?? null;
  const resolvedSourceSceneId   = sourceSceneId ?? endCtx?.sourceSceneId ?? dc?.sourceSceneId ?? null;

  // Rebuild party.members (the shape resolveParty expects) from the actors
  // that fought the prior battle.
  const members = [];
  let slot = 1;
  for (const actorId of (endCtx?.partyActorIds ?? [])) {
    const actor = game.actors?.get?.(actorId);
    if (!actor) continue;
    members.push({
      actorUuid: actor.uuid,
      actorId:   actor.id,
      name:      actor.name,
      slot:      slot++,
      img:       actor.img ?? actor.prototypeToken?.texture?.src ?? null,
    });
  }

  // Manual encounter picks (resolveEncounter expands `quantity` itself).
  const manualPicks = (Array.isArray(enemies) ? enemies : [])
    .filter(Boolean)
    .map((e) => ({
      actorUuid: e.actorUuid ?? null,
      name:      e.name ?? null,
      quantity:  Math.max(1, Number(e.quantity ?? 1) | 0),
    }));

  return {
    options:       { battleSystem: "director" },
    battlePlan:    { type: battleType, isBoss: !!isBoss },
    encounterPlan: { mode: "manual", manualPicks },
    party:         { members },
    battleConfig:  { bgm: String(bgm ?? ""), battleSceneUuid: resolvedBattleSceneUuid },
    context: {
      battleSceneUuid:  resolvedBattleSceneUuid,
      sourceSceneId:    resolvedSourceSceneId,
      inPlaceReinforce: true,
    },
    // In-memory only — carries the rule's entrance hook to the in-place init.
    // JSON-serialised state (F5 survival) silently drops the function; that's
    // fine, the entrance is cosmetic and resume skips it.
    followup,
    meta: {
      followupOf:     dc?.id ?? null,
      followupRuleId: spawnedByRuleId ?? null,
      builtAt:        new Date().toISOString(),
    },
  };
}

// ─── Reward merge helper ─────────────────────────────────────────────────
//
// Sum two Battle-End reward snapshots ({ expByActorId, zenitByActorId }) per
// actor. Used to carry a won battle's rewards into the follow-up battle so the
// FINAL reward pool (after the boss fight) includes the original encounter too.
export function mergeRewardSnapshots(base, add) {
  const out = {
    expByActorId:   { ...(base?.expByActorId   ?? {}) },
    zenitByActorId: { ...(base?.zenitByActorId ?? {}) },
  };
  for (const [id, v] of Object.entries(add?.expByActorId ?? {})) {
    out.expByActorId[id] = (Number(out.expByActorId[id]) || 0) + (Number(v) || 0);
  }
  for (const [id, v] of Object.entries(add?.zenitByActorId ?? {})) {
    out.zenitByActorId[id] = (Number(out.zenitByActorId[id]) || 0) + (Number(v) || 0);
  }
  return out;
}

// ─── Evaluation ──────────────────────────────────────────────────────────
//
// Returns { rule, resolved } for the first firing rule, or null. Side effect:
// updates pity counters — reset to 0 on the rule that fires, +1 on each
// eligible rule that rolls and misses (escalation). Only rules whose
// `outcomes` include the battle outcome AND whose isActive()/isEligible()
// pass are considered, highest `priority` first.

export async function evaluateFollowups(endCtx) {
  if (!game.user?.isGM) return null;
  const outcome = endCtx?.outcome ?? "victory";

  const candidates = listFollowupRules()
    .filter((r) => {
      const outcomes = Array.isArray(r.outcomes) ? r.outcomes : ["victory"];
      if (!outcomes.includes(outcome)) return false;
      try { if (r.isActive && !r.isActive(endCtx)) return false; }
      catch (e) { warn(`[Followup] ${r.id}.isActive threw`, e); return false; }
      try { if (r.isEligible && !r.isEligible(endCtx)) return false; }
      catch (e) { warn(`[Followup] ${r.id}.isEligible threw`, e); return false; }
      return true;
    })
    .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0));

  for (const rule of candidates) {
    const pity = getFollowupPity(rule.id);
    let p = 0;
    try { p = Number(rule.chance ? rule.chance({ ...endCtx, pity }) : 0) || 0; }
    catch (e) { warn(`[Followup] ${rule.id}.chance threw`, e); p = 0; }
    p = Math.max(0, Math.min(1, p));

    const roll = Math.random();
    log(`[Followup] ${rule.id}: pity=${pity} chance=${Math.round(p * 100)}% roll=${roll.toFixed(3)}`);

    if (roll < p) {
      let resolved = null;
      try { resolved = await rule.resolve(endCtx); }
      catch (e) { warn(`[Followup] ${rule.id}.resolve threw`, e); resolved = null; }
      if (resolved) {
        await resetFollowupPity(rule.id); // reset on spawn
        log(`[Followup] "${rule.id}" FIRES`);
        return { rule, resolved };
      }
      // resolve produced nothing — escalate like a miss so it retries next time.
      await setFollowupPity(rule.id, pity + 1);
    } else {
      await setFollowupPity(rule.id, pity + 1); // miss → escalate
    }
  }
  return null;
}
