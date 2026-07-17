// Geist — "Zero Power: The Blackest Night" undying rule.
//
// Skill (Actor.UYAabJiUZJ1uKers.Item.xc1wLkLVukf7ouTD): when Geist is reduced
// to 0 HP with his Zero Power full, he sacrifices part of his soul — spends
// ALL his ZP and rises again. Each revival restores him only up to a cap that
// decays multiplicatively (70% → 49% → 34% → …). His max-HP ceiling is never
// touched (his low-HP damage passive keys off the ratio). MP restores in
// full. ZP regeneration is owned elsewhere (Zero Trigger: Adversity); this
// rule only gates on "ZP full" and spends it to zero.
//
// Geist is the fight's battle-ender: his adds live and die with him. On EVERY
// death (revive trigger or true death) the remaining enemy-side combatants
// collapse — which is also what latches checkSideWipe and walks the FSM into
// the REAL victory pipeline that the cinematic then interrupts. See
// undying.js for the full flow.
//
// Intentionally boss-specific (mirrors wandering-flame-ambush.js): ids are
// pinned, tuning defaults live here and can be overridden from the skill
// item's props without touching code:
//   undying_zp_cost        (default 6)
//   undying_restore_decay  (default 0.7 — cap fraction multiplier per trigger)
//
// Per-battle escalation counter lives on director.ctx (_undyingTriggers) —
// battle-scoped by construction, no stale-state cleanup needed. Known v1
// edge: an F5 between revives loses the counter, so the NEXT revive restores
// at 70% again (favors the boss, GM can correct via the pending claim's
// triggerIndex). The pending claim itself IS F5-safe (world setting).

import { log, warn } from "../../logger.js";
import { STATES } from "../../states.js";
import {
  registerUndyingRule,
  getPendingClaim,
  setPendingClaim,
  clearPendingClaim,
  isForceCinematic,
} from "./undying.js";
import { playBlackestNightCinematic } from "./blackest-night-cinematic.js";
// The healing system's live-verified debuff detector (matches "debuff" across
// system.tags / e.tags / module + CSB flag tags; skips disabled AEs and
// equipment-managed permanents) — the revive cleanses exactly what a
// Turbo Tonic would.
import { isDebuffEffect } from "../../../healing-system/healing-cleanse.js";

export const RULE_ID = "geist-blackest-night";

const NS             = "fabula-ultima-companion";
const GEIST_ACTOR_ID = "UYAabJiUZJ1uKers";     // world Actor id; synthetic token
                                               // actors keep the same id (ActorDelta)
const SKILL_ITEM_ID  = "xc1wLkLVukf7ouTD";     // Zero Power: The Blackest Night
const SKILL_NAME_RX  = /blackest\s+night/i;    // fallback if the id ever changes

const DEFAULT_ZP_COST = 6;
const DEFAULT_DECAY   = 0.7;

const PATH_HP     = "system.props.current_hp";
const PATH_MAX_HP = "system.props.max_hp";
const PATH_MP     = "system.props.current_mp";
const PATH_MAX_MP = "system.props.max_mp";
const PATH_ZP     = "system.props.zero_power_value";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function get(obj, path, fallback = undefined) {
  try { return foundry.utils.getProperty(obj, path) ?? fallback; }
  catch { return fallback; }
}

// Tuning knobs off the skill item, with hard defaults so an unconfigured
// item still works.
function readSkillTuning(actor) {
  const item =
    actor?.items?.get?.(SKILL_ITEM_ID) ??
    actor?.items?.find?.((i) => SKILL_NAME_RX.test(i?.name ?? "")) ??
    null;
  const p = item?.system?.props ?? {};
  const cost  = num(p.undying_zp_cost);
  const decay = num(p.undying_restore_decay);
  return {
    item,
    zpCost: (cost != null && cost > 0) ? Math.floor(cost) : DEFAULT_ZP_COST,
    decay:  (decay != null && decay > 0 && decay < 1) ? decay : DEFAULT_DECAY,
  };
}

// Sim / automated-playtest battles skip the BATTLE_ENDING cinematic pipeline
// entirely, so the revive must land inline there (no cinematic, no claim).
function isLeanMode(director) {
  const payload = director?.ctx?.payload;
  return !!(payload?.options?.devMode || payload?.context?.lean);
}

function findGeistCombatant(director) {
  return (director?.dCombat?.combatants ?? [])
    .find((c) => c.side === "enemy" && c.actorDoc?.id === GEIST_ACTOR_ID) ?? null;
}

// ─── Add collapse ─────────────────────────────────────────────────────────
// Zero every other live enemy-side combatant. Each zeroed add gets a normal
// hp-loss ledger event queued into the settle loop, so the builtin defeat
// reactor handles it exactly like a real kill next pass (creature_defeated
// emit, death animation, Soldier/Elite removal, Champion KO). The HP writes
// also fire the director's updateActor side-wipe watcher — the last one
// latches dCombat.end(), which is what routes the FSM to BATTLE_ENDING.
async function collapseAdds(director, cause) {
  const adds = (director?.dCombat?.combatants ?? []).filter((c) =>
    c.side === "enemy" && c.actorDoc?.id !== GEIST_ACTOR_ID && !c.isDefeatedLive()
  );
  let dropped = 0;
  for (const c of adds) {
    const a = c.actorDoc;
    const hp = num(get(a, PATH_HP)) ?? 0;
    if (!a || hp <= 0) continue;
    try {
      await a.update({ [PATH_HP]: 0 });
      if (!Array.isArray(director.ctx._postResolveTriggers)) director.ctx._postResolveTriggers = [];
      director.ctx._postResolveTriggers.push({
        casterActor: a,
        trigger: "creature_lose_resource",
        payload: {
          resource: "hp",
          amount: hp,
          direction: "loss",
          cause,
          element: null,
          originLabel: "The Blackest Night",
          originUuid: null,
          sourceActorUuid: a.uuid,
          sourceTokenUuid: c.tokenUuid ?? null,
          subjectActorUuid: a.uuid,
          subjectTokenUuid: c.tokenUuid ?? null,
        },
      });
      dropped++;
    } catch (e) { warn(`[BlackestNight] collapse of ${a?.name ?? "add"} threw`, e); }
  }
  if (dropped) log(`[BlackestNight] ${dropped} add(s) collapsed (${cause})`);
  return dropped;
}

// ─── Restore (the "rise" beat) ───────────────────────────────────────────
// Atomic revive: spend ALL ZP, HP up to the decayed cap, MP in full, KO
// marker cleared. Works on the combatant's live actorDoc (the synthetic
// token actor in combat) so the write lands where the damage did.
// Deliberately posts NO chat message — the cinematic does the storytelling.
export async function applyBlackestNightRestore(director, claim) {
  const actor =
    findGeistCombatant(director)?.actorDoc ??
    (claim?.actorUuid ? await fromUuid(claim.actorUuid).catch(() => null) : null) ??
    game.actors?.get?.(GEIST_ACTOR_ID) ?? null;
  if (!actor) { warn("[BlackestNight] restore: Geist actor not found"); return null; }

  const { decay } = readSkillTuning(actor);
  const maxHp = num(get(actor, PATH_MAX_HP)) ?? 0;
  const maxMp = num(get(actor, PATH_MAX_MP)) ?? 0;
  const n     = Math.max(1, num(claim?.triggerIndex) ?? 1);
  const hp    = Math.max(1, Math.floor(maxHp * Math.pow(decay, n)));

  await actor.update({
    [PATH_HP]: hp,
    [PATH_MP]: maxMp,
    [PATH_ZP]: 0,
  });

  // Clear the defeat reactor's KO marker AE(s) — same filter it reconciles on
  // — AND cleanse every debuff (v2): the sacrifice burns his afflictions away
  // with the rest. Buffs and untagged AEs survive. One delete call.
  const effects = actor.effects?.contents ?? [];
  const removeIds = [...new Set([
    ...effects.filter((e) => e?.flags?.[NS]?.bdDefeated === true).map((e) => e.id),
    ...effects.filter(isDebuffEffect).map((e) => e.id),
  ])].filter(Boolean);
  if (removeIds.length) {
    try { await actor.deleteEmbeddedDocuments("ActiveEffect", removeIds); }
    catch (e) { warn("[BlackestNight] KO/debuff clear threw", e); }
  }

  log(`[BlackestNight] restore #${n}: hp ${hp}/${maxHp}, mp full, zp spent, ${removeIds.length} AE(s) cleared`);
  return { hp, maxHp, triggerIndex: n };
}

// ─── Builtin reactor (registered alongside crisis/defeat in director-boot) ─
// Fires per hp ledger event during settle. Detects Geist at 0 HP; splits on
// the ZP gate: full ZP → register claim + collapse adds (fake-out path);
// short ZP → true death, adds still collapse (Geist alone ends the battle).
export async function blackestNightReactor(director, cfg, extra) {
  try {
    if (!game.user?.isGM) return;
    if (!director?.ctx || !director?.dCombat?.started) return;
    if (String(cfg?.payload?.resource ?? "").toLowerCase() !== "hp") return;

    const actor = cfg?.casterActor;
    if (!actor || actor.id !== GEIST_ACTOR_ID) return;
    const hp = num(get(actor, PATH_HP));
    if (hp == null || hp > 0) return;

    // Dedup: once per settle (multi-hit kills emit several hp events) and
    // once per pending claim (a stray event while awaiting BATTLE_ENDING).
    const key = `undying:${RULE_ID}`;
    if (extra?.firedKeys?.has?.(key)) return;
    extra?.firedKeys?.add?.(key);
    if (getPendingClaim()?.ruleId === RULE_ID) return;

    const { zpCost } = readSkillTuning(actor);
    const zp = num(get(actor, PATH_ZP)) ?? 0;

    if (zp < zpCost) {
      // TRUE death — ZP not full. The adds die with him; side-wipe latches
      // and the normal victory pipeline runs untouched.
      log(`[BlackestNight] Geist falls with ZP ${zp}/${zpCost} — true death`);
      director.ctx._undyingTriggers = 0;
      await collapseAdds(director, "geist_true_death");
      return;
    }

    const n = (num(director.ctx._undyingTriggers) ?? 0) + 1;
    director.ctx._undyingTriggers = n;

    if (isLeanMode(director) && !isForceCinematic()) {
      // Sim path: restore inline, un-latch a side-wipe that may have raced
      // in (e.g. adds were already dead), keep the battle running.
      log(`[BlackestNight] lean mode — inline revive #${n}`);
      await applyBlackestNightRestore(director, { triggerIndex: n, actorUuid: actor.uuid });
      if (director.dCombat?.ended) director.dCombat.ended = false;
      director.ctx.endOfCombat = false;
      return;
    }

    // Fake-out path. Claim FIRST (so BATTLE_ENDING sees it even if the
    // collapse below throws), then drop the adds — the last add's HP→0
    // latches the side-wipe and the FSM walks into the real victory
    // pipeline, which evaluateUndying() intercepts.
    await setPendingClaim({
      ruleId:       RULE_ID,
      actorUuid:    actor.uuid,
      tokenUuid:    cfg?.payload?.subjectTokenUuid ?? cfg?.payload?.sourceTokenUuid ?? null,
      triggerIndex: n,
      registeredAt: Date.now(),
    });
    await collapseAdds(director, "the_blackest_night");
    log(`[BlackestNight] claim #${n} registered (ZP ${zp}/${zpCost}) — awaiting BATTLE_ENDING`);
  } catch (e) {
    warn("[BlackestNight] reactor threw", e);
  }
}

// ─── The undying rule (consumed by evaluateUndying at BATTLE_ENDING) ──────
export const blackestNightUndyingRule = {
  id: RULE_ID,
  label: "Geist — Zero Power: The Blackest Night",

  async run(endCtx, claim) {
    const director = endCtx?.director;
    const dc = director?.dCombat;
    if (!dc) { warn("[BlackestNight] run: no dCombat"); return null; }

    const geist = findGeistCombatant(director);
    if (!geist) {
      warn("[BlackestNight] run: Geist not among combatants — cannot resume");
      return null;   // evaluateUndying clears the claim and falls through
    }

    // First revival this battle gets the full fake-out; later ones the short
    // "refuses to die" beat.
    const mode = (num(claim?.triggerIndex) ?? 1) <= 1 ? "full" : "short";

    let restored = null;
    await playBlackestNightCinematic({
      mode,
      director,
      endCtx,
      bossTokenUuid: geist.tokenUuid ?? claim?.tokenUuid ?? null,
      // The restore lands exactly at the cinematic's rise beat.
      onRise: async () => {
        restored = await applyBlackestNightRestore(director, claim);
      },
    });
    // Failsafe: a cinematic that aborted before its rise beat must not eat
    // the revive.
    if (!restored) restored = await applyBlackestNightRestore(director, claim);
    await clearPendingClaim();

    // Un-latch the side-wipe and advance past the killer's turn (TURN_END's
    // nextTurn() early-returned while `ended` was latched). Geist is alive
    // again, so he's eligible in the advance.
    dc.ended = false;
    let r = null;
    try { r = dc.nextTurn(); }
    catch (e) { warn("[BlackestNight] resume nextTurn threw", e); }
    director.ctx.endOfCombat = false;
    director.ctx.endOfRound  = false;

    // BATTLE_ENDING.onEnter destroyed the player HUD — rebuild it (mirrors
    // the in-place reinforce init). Fire-and-forget, like PREP.
    try {
      const scene = dc.scene ?? canvas?.scene ?? null;
      const entries = dc.combatants
        .filter((c) => c.side === "party")
        .map((c) => ({ actor: c.actorDoc, token: c.tokenDoc }))
        .filter((e) => e.actor && e.token);
      const { buildDirectorHud } = await import("../../director-player-hud.js");
      buildDirectorHud(entries, scene)
        .catch((e) => warn("[BlackestNight] buildDirectorHud threw", e));
    } catch (e) { warn("[BlackestNight] HUD rebuild dispatch threw", e); }

    // Hand the FSM its resume target; states.js routes INTERNAL_DONE here.
    director.ctx.pendingUndying = {
      ruleId:   RULE_ID,
      resumeAt: r?.wrappedRound ? STATES.ROUND_START : STATES.TURN_START,
    };
    return { handled: true, restored };
  },
};

export function registerBlackestNight() {
  registerUndyingRule(blackestNightUndyingRule);
}
