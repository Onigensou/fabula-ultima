// State handlers — the per-state onEnter / onExit / onAbort logic.
//
// For v1 prototype, only Attack and Guard are fully wired. Other commands
// log a "not implemented in director v1" notice and return the FSM to
// DECLARE so the user can pick again.
//
// Damage / accuracy computation lives here too (kept simple — full Fabula
// rules require equipped-weapon lookup, status effects, affinities, etc.,
// which are deliberately out of scope for the prototype).

import { log, warn, err } from "./logger.js";
import { STATES } from "./states.js";
import { INTENTS } from "./intents.js";
import { snapshotCombatant, snapshotDirectorCombatant, snapshotEligibleTargets, snapshotEligibleTargetsFromDCombat, readPropNum, attrDieSize, freezeActionResult, applyAffinityToDamage, applyAttackRangeGate } from "./snapshot.js";
import { TurnUI } from "./turn-ui.js";
import { TurnPicker } from "./turn-picker.js";
import { requestTargeting } from "./target-picker.js";
import { postActionCard, BattlefieldActionCard } from "./action-card.js";
import { pickWeaponMode, WeaponModePicker } from "./weapon-mode-picker.js";
import { pickAttributePair, AttributePairPicker } from "./attribute-pair-picker.js";
import { runDirectorInit } from "./director-init.js";
import { playStudyVfx, playActionNamecard, playMissVfx, playResourceSpendVfx } from "./director-vfx.js";
import { playCritCutin } from "./director-cutin.js";
import { playRoundBanner } from "./director-round-banner.js";
import { applyEquipmentSwap } from "./equipment-swap.js";
import { gatherConsumables, gatherCreatables, readActorIp, consumeOne, spendIp } from "./item-resource.js";
import { saveDirectorState, installItemDeletionTracker, clearAllDirectorStateFlags } from "./persistence.js";
// Phase B.1 Skill engine
import { pickSkill, SkillPicker } from "./skill-picker.js";
import { OptionPicker } from "./option-picker.js";
// Player-driven input: client-local compose chain runner.
import { composeAction, makeCancelToken } from "./compose-action.js";
import { buildPseudoWeaponFromNpcAttack } from "./actor-shape.js";
import { parseSkillCost, resolveCost, checkAffordable, debitCost } from "./skill-cost.js";
import { evaluateFormula, buildSkillResolver } from "./skill-formulas.js";
import { freeActions } from "./free-actions.js";
import { makeChainContext } from "./skill-targeting.js";
import { fireActivationEffect, firePostDamageEffect, tickDirectorAEsForApplier, firePassiveTriggers, applyDamageToTarget, resolveDamageElementOverride } from "./skill-effects.js";
// Standalone-reaction dispatcher — runs at FSM transitions for triggers
// that aren't tied to an action card (conflict_start, turn_start, etc.).
// Spawns the token-anchored reaction menu via [[reaction-menu-on-token]].
import { dispatchStandaloneTrigger, clearAllStandaloneMenus } from "./standalone-reactions.js";
import { pushFrame, popFrame, peekTop, topIsFreeAction, topIsSrwDetour, stackDepth, rewindPhaseLabel } from "./continuation-stack.js";

// findPassiveCandidates + firePreAcceptedCandidate are dynamically
// imported (with one-shot cache-bust on first call) so this module
// loads cleanly against module caches that pre-date these exports.
// Without this, a fresh state-handlers (e.g. harness cache-bust) would
// fail to load whenever skill-effects.js was already in the boot-time
// cache without the new symbols.
let _seExtraModule = null;
async function getSkillEffectsExtras() {
  if (_seExtraModule) return _seExtraModule;
  _seExtraModule = await import("./skill-effects.js?cb=" + Date.now());
  return _seExtraModule;
}
import { getRuntimeSkillView } from "./skill-recipes.js";
import { classifyActionIntent } from "./skill-intent.js";

// Install a director-scoped watcher that releases Guard / Covered AEs
// when their associated actor drops to 0 HP. RAW Core p.70:
//   - Guarder dies / leaves / falls unconscious → Guard ends AND Cover
//     also ends (the guarder can't protect anyone while down).
//   - Covered ally dies → Cover ends (Guard on the guarder is unaffected).
//
// Hook is owned by `director.hooks` so it auto-disposes on director.stop().
// GM-only — the AE deletes need GM authority, and the director is GM-only
// in v1 anyway.
export function installGuardHpWatcher(director) {
  director.hooks.on("updateActor", async (actor, change /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      const newHp = foundry.utils.getProperty(change, "system.props.current_hp");
      if (newHp === undefined || newHp === null) return;
      if (Number(newHp) > 0) return;

      const dc = director.dCombat;
      if (!dc?.activeGuards?.length) return;

      // Find all entries this dying actor participates in.
      const matches = [];
      for (const g of dc.activeGuards) {
        if (g.guarderActorUuid === actor.uuid) matches.push({ entry: g, role: "guarder" });
        else if (g.coveredActorUuid === actor.uuid) matches.push({ entry: g, role: "covered" });
      }
      if (!matches.length) return;

      const toRemove = new Set();
      for (const m of matches) {
        try {
          if (m.role === "guarder") {
            // Guarder fell → release Guard on them + Covered on ally.
            if (m.entry.guarderEffectId) {
              const eff = actor.effects?.get?.(m.entry.guarderEffectId);
              if (eff) await eff.delete();
            }
            if (m.entry.coveredActorUuid && m.entry.coveredEffectId) {
              const covered = await fromUuid(m.entry.coveredActorUuid);
              if (covered) {
                const ceff = covered.effects?.get?.(m.entry.coveredEffectId);
                if (ceff) await ceff.delete();
              }
            }
            toRemove.add(m.entry);
            log(`Guard cleared: ${actor.name} fell to 0 HP`);
          } else {
            // Covered ally fell → release only Covered; Guard on guarder persists.
            if (m.entry.coveredEffectId) {
              const ceff = actor.effects?.get?.(m.entry.coveredEffectId);
              if (ceff) await ceff.delete();
            }
            m.entry.coveredActorUuid = null;
            m.entry.coveredEffectId = null;
            log(`Cover cleared: covered ally ${actor.name} fell to 0 HP (guarder's Guard persists)`);
          }
        } catch (e) { warn("Guard HP watcher: AE release failed", e); }
      }
      if (toRemove.size > 0) {
        dc.activeGuards = dc.activeGuards.filter((g) => !toRemove.has(g));
      }
    } catch (e) {
      warn("Guard HP watcher threw", e);
    }
  }, { label: "guard-hp-watcher" });
  log("Guard HP watcher installed");
}

// Build a short, human-readable description of an actionResult for the
// rewind history list. Lives here (not in persistence.js) because the
// actionResult shape is owned by this file — keeping the formatter
// next to the source guarantees they stay in sync when new kinds land.
//
// Returns an empty string when the kind isn't recognized; the rewind UI
// shows just the label in that case (no detail line).
// Convert a Map<resource, amount> into a plain object for freezing onto
// actionResult. (freezeActionResult deep-walks and Map iteration would
// not survive — turn it into a {resource: amount} dict.)
function serializeCostMap(costMap) {
  const out = {};
  if (!costMap?.entries) return out;
  for (const [k, v] of costMap.entries()) out[k] = v;
  return out;
}

// Resolve a Skill action. Pulled out as a top-level helper so the
// Item action can fire a linked skill via the same path (D.5 closure).
//
// Side effects (in order):
//   1. Debit cost.
//   2. Fire `on_activate_effect_ref` (skill's pre-damage hook).
//   3. For each hit target: apply HP delta (damage or AB-heal).
//   4. For each damaged target: fire `post_damage_effect_ref` with
//      per-target payload so `HP_DEALT`/`MP_DEALT` formulas resolve.
//   5. Toast.
//
// If `opts.skipCost` is true, debit is bypassed — used when the cost
// has already been paid out-of-band (e.g. Item.use consumed an item
// instead of paying MP).
// D.5 closure — fire a skill linked to an item (consumable use or
// recipe creation). Cost is skipped (the item itself was the cost).
// Targets default to the caster (self) for B.1; cross-actor item use
// lands in B.2.
//
// Builds the same actionResult shape resolveSkillAction expects, then
// delegates so the linked skill goes through the full pipeline (cost
// gate bypassed, effect_table fires, post_damage_effect_ref hooks, etc.).
async function fireLinkedSkillFromItem({ director, casterSnap, casterActor, skillUuid, sourceItemUuid = null }) {
  const skill = await fromUuid(skillUuid).catch(() => null);
  if (!skill) {
    warn(`fireLinkedSkillFromItem: skill ${skillUuid} not resolvable`);
    return;
  }
  // Cap targets to self for B.1. The skill's own `skill_target` may
  // suggest otherwise, but cross-actor item use needs a target picker
  // (B.2).
  const ar = {
    kind: "Skill",
    attacker: casterSnap,
    attackerActorRef: casterSnap.actorUuid,
    skillUuid: skill.uuid,
    skillName: skill.name,
    skillImg: skill.img,
    skillType: String(skill.system?.props?.skill_type ?? ""),
    defenseTargetType: String(skill.system?.props?.defense_target_type ?? "").toLowerCase(),
    isCheck: false,  // linked-item skills bypass the Check (auto-hit)
    rolledA1: "",
    rolledA2: "",
    checkBonus: 0,
    damageBonus: skill.system?.props?.damage_bonus ?? 0,
    damageType: String(skill.system?.props?.type_damage ?? ""),
    skillRange: String(skill.system?.props?.skill_range ?? ""),
    skillTarget: String(skill.system?.props?.skill_target ?? "").toLowerCase(),
    sourceItemUuid,
    descriptionHtml: String(skill.system?.props?.description ?? ""),
    targets: [casterSnap],
    costSerialized: {},
    rawCost: "",
    actionIntent: classifyActionIntent(skill),
    perTargetResults: [],   // built below if the skill deals damage
    hasDamage: false,
  };
  // If the skill deals damage, build perTargetResults so resolveSkillAction
  // applies the damage. Auto-hit (no Check) — uses HR=0 (item-cast skills
  // skip the roll, RAW-ish for B.1).
  const damageType = String(ar.damageType ?? "").toLowerCase();
  const hasDamage = !!damageType && !["", "none", "healing", "heal", "hp", "mp", "recovery"].includes(damageType);
  if (hasDamage) {
    const resolver = buildSkillResolver({
      actor: casterActor,
      payload: null,
      skill,
      round: director.dCombat?.round ?? 0,
    });
    const damageBonus = evaluateFormula(ar.damageBonus, resolver, 0);
    for (const t of ar.targets) {
      const tActor = await fromUuid(t.actorUuid).catch(() => null);
      const affinityCode = tActor?.system?.props?.[`affinity_${damageElementIndex(damageType)}`] ?? "NE";
      const rawDamage = damageBonus;  // HR=0 for item-cast
      const damage = applyAffinityToDamage(rawDamage, String(affinityCode).toUpperCase());
      ar.perTargetResults.push({
        tokenUuid: t.tokenUuid,
        actorUuid: t.actorUuid,
        name: t.name,
        tokenImg: t.tokenImg,
        disposition: t.disposition,
        defense: t.defense ?? 0,
        hit: true,
        crit: false,
        rawDamage,
        damage,
        affinity: String(affinityCode).toUpperCase(),
        studied: true,
      });
    }
    ar.hasDamage = true;
  }
  await resolveSkillAction(director, ar, { skipCost: true });
}

// Map a damage type to its affinity_N prop slot (mirrors Attack flow's
// `physical→1, air→2, bolt→3, dark→4, earth→5, fire→6, ice→7, light→8,
// poison→9` lookup).
function damageElementIndex(type) {
  switch (String(type ?? "").toLowerCase()) {
    case "physical": return 1;
    case "air":      return 2;
    case "bolt":     return 3;
    case "dark":     return 4;
    case "earth":    return 5;
    case "fire":     return 6;
    case "ice":      return 7;
    case "light":    return 8;
    case "poison":   return 9;
    default: return null;
  }
}

async function resolveSkillAction(director, ar, opts = {}) {
  const skipCost = !!opts.skipCost;
  const casterActor = await fromUuid(ar.attackerActorRef).catch(() => null);
  if (!casterActor) { warn("Skill resolve: caster actor not found", ar.attackerActorRef); return; }
  const skill = await fromUuid(ar.skillUuid).catch(() => null);
  if (!skill) { warn("Skill resolve: skill item not found", ar.skillUuid); return; }

  // 1. Debit cost (unless an outer flow paid out-of-band).
  if (!skipCost) {
    const costMap = new Map(Object.entries(ar.costSerialized ?? {}));
    if (costMap.size > 0) {
      try {
        const debitRes = await debitCost(casterActor, costMap);
        // Spend float over the caster's token, one per resource actually
        // debited — so skill/spell casting costs animate like reaction costs.
        if (debitRes?.ok) {
          const payerTokenUuid = ar.attacker?.tokenUuid;
          for (const [resource, amount] of Object.entries(debitRes.debited ?? {})) {
            if (Number(amount) > 0) playResourceSpendVfx({ tokenUuid: payerTokenUuid, resource, amount: Number(amount) });
          }
        }
      }
      catch (e) { warn("Skill resolve: debitCost threw", e); }
    }
  }

  // 2. Build the chain ctx (recipe-merged effect_table + fire-points).
  //    `payload` carries the cast's roll-derived state so HR / CRIT /
  //    FUMBLE / TOTAL identifiers resolve correctly in on_activate
  //    formulas (e.g. Heal's recipe_amount: "HR + 5"). For no-Check
  //    skills `ar.roll` is null → identifiers fold to 0 and author
  //    formulas like "HR + 5" cleanly evaluate to the additive part.
  const view = getRuntimeSkillView(skill);
  const reactorToken = canvas?.tokens?.get(ar.attacker?.tokenId)?.document ?? null;
  // Hit list. For no-Check skills `hitTokenUuids` mirrors all action
  // targets (COMPUTE stamps it that way). For Checks it's the strict
  // subset that passed vs DEF/MDEF (or all on a Crit). Drives the
  // `hit_action_targets` target_ref resolver.
  const allActionTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
  const hitTokenUuids = Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : allActionTargetUuids;
  const chainPayload = {
    targets: allActionTargetUuids,
    hitTargets: hitTokenUuids,
    hr: ar.roll?.hr ?? 0,
    isCrit: !!ar.roll?.isCrit,
    isFumble: !!ar.roll?.isFumble,
    total: ar.roll?.total ?? 0,
    actionIntent: ar.actionIntent,
    // Surfaces Vismagus's HP-alt-payment flag to chain consumers so the
    // grant effect can suppress caster self-heal.
    vismagusHpPaid: !!ar.vismagusHpPaid,
  };
  const ctx = makeChainContext({
    reactorActor: casterActor,
    reactorToken,
    skill,
    dCombat: director.dCombat,
    payload: chainPayload,
    actionTargetUuids: allActionTargetUuids,
    hitActionTargetUuids: hitTokenUuids,
    isPassive: false,
    runtimeEffectTable: view.effect_table,
    firePoints: view.fire_points,
    // Test-harness opt-in — `_harnessPicks` lives on the synthetic ar
    // built by FUCompanion.api.test.runDirectorSkillSimulate and lets
    // it auto-resolve open_action_menu prompts. Always null in live play.
    harnessPicks: ar?._harnessPicks ?? null,
  });

  // 3. Fire on_activate effect (pre-damage, no damage payload).
  try {
    const r = await fireActivationEffect(skill, ctx);
    if (r?.abort) {
      log(`Skill resolve: on_activate aborted chain — skipping damage + post_damage`);
      return;
    }
  } catch (e) { warn("Skill resolve: fireActivationEffect threw", e); }

  // 4. Apply damage per target (mirrors Attack RESOLVE) + fire
  //    post_damage_effect_ref with per-target payload so HP_DEALT etc.
  //    formula identifiers resolve correctly.
  //
  //    Resource branch: HP damage takes the regular affinity-aware
  //    path (with AB → heal flip). MP damage burns current_mp on hit
  //    with NE affinity (set in COMPUTE — no elemental mutation).
  //    The post_damage payload's `valueType` is set per-branch so
  //    HP_DEALT vs MP_DEALT resolve correctly in formulas.
  const dmgResource = ar.damageResource ?? "hp";
  const hits = (ar.perTargetResults ?? []);
  if (ar.hasDamage && hits.length) {
    for (const r of hits) {
      if (!r.hit) { playMissVfx({ tokenUuid: r.tokenUuid }); continue; }
      try {
        const targetActor = await fromUuid(r.actorUuid).catch(() => null);
        if (!targetActor) { warn("Skill resolve: target actor not found", r.actorUuid); continue; }

        // Vismagus self-heal suppression — if the caster paid HP for the
        // spell via Vismagus, they do NOT recover HP from this spell
        // (other targets unaffected). Per RAW Spiritist p.182.
        if (ar.vismagusHpPaid && r.actorUuid === ar.attackerActorRef) {
          log(`Skill ${ar.skillName}: Vismagus suppresses caster self-heal for ${r.name}`);
          continue;
        }

        // Shared damage-write path. Handles MP-resource, AB → heal flip,
        // resolveDamageReactions (Mercy + future clamp/cap AEs), and the
        // log line. See applyDamageToTarget in skill-effects.js.
        const dmgRes = await applyDamageToTarget({
          target: targetActor,
          damage: r.damage,
          affinity: r.affinity,
          resource: dmgResource,
          targetName: r.name,
          tokenUuid: r.tokenUuid,
          logPrefix: `Skill ${ar.skillName}:`,
        });
        const finalValue = dmgRes.finalValue;
        const valueType = dmgRes.resource;
        const valueDirection = dmgRes.valueDirection;
        const damageTypeForPayload = valueDirection === "recover" ? "healing" : ar.damageType;

        // Per-target post_damage payload — HP_DEALT / MP_DEALT resolve
        // here. Roll-derived identifiers (HR / CRIT / FUMBLE / TOTAL)
        // carry through too so post_damage formulas can reference both
        // the damage just dealt AND the cast roll that produced it.
        const damagePayload = {
          targets: [r.actorUuid],
          targetUuid: r.actorUuid,
          targetTokenUuid: r.tokenUuid,
          sourceTokenUuid: ar.attacker?.tokenUuid,
          sourceActorUuid: ar.attackerActorRef,
          finalValue,
          valueType,
          valueDirection,
          damageType: damageTypeForPayload,
          actionIntent: ar.actionIntent,
          hr: ar.roll?.hr ?? 0,
          isCrit: !!ar.roll?.isCrit,
          isFumble: !!ar.roll?.isFumble,
          total: ar.roll?.total ?? 0,
        };
        try { await firePostDamageEffect(skill, ctx, damagePayload); }
        catch (e) { warn("Skill resolve: firePostDamageEffect threw", e); }
      } catch (e) {
        err("Skill resolve: damage application failed", r, e);
      }
    }
  }

  // 5b. Miss VFX for Check-only skills (no damage — e.g. Zarg's Soul Steal).
  //     These skip the damage loop above (it's gated on ar.hasDamage), so a
  //     failed Check would otherwise show no whiff. Fire the Miss flourish for
  //     each non-hit target. Gated on ar.isCheck because non-check skills
  //     auto-hit (every perTargetResults entry is hit:true) — nothing to miss.
  if (!ar.hasDamage && ar.isCheck && hits.length) {
    for (const r of hits) {
      if (!r.hit) playMissVfx({ tokenUuid: r.tokenUuid });
    }
  }

  // 6. Pre-resolve accepted passives — fire any pill-accepted passives
  //    the CONFIRM step stamped on the actionResult (Healing Power /
  //    Support Magic / future "during action card" reactions). These
  //    were evaluated BEFORE the player clicked Confirm so they
  //    manipulate the action's effective result. The post-resolve
  //    `creature_completes_spell` dispatch below skips any candidate
  //    already evaluated here to avoid double-fire.
  const _hitList = Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : (ar.targets ?? []).map((t) => t.tokenUuid);
  const payloadForPassives = {
    spellUuid: skill.uuid,
    spellName: skill.name,
    targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
    hitTargetTokenUuids: _hitList,
    // `hitTargets` is the canonical key that skill-targeting.js's
    // `hit_action_targets` resolver reads — needed for reactions like
    // Vanish that target each hit creature via target_ref.
    hitTargets: _hitList,
    targets: (ar.targets ?? []).map((t) => t.tokenUuid),
    sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
    sourceActorUuid: ar.attackerActorRef,
    actionIntent: ar.actionIntent,
  };
  const accepted = Array.isArray(ar.acceptedPrePassives) ? ar.acceptedPrePassives : [];
  if (accepted.length) {
    const { firePreAcceptedCandidate } = await getSkillEffectsExtras();
    for (const cand of accepted) {
      try {
        await firePreAcceptedCandidate({
          director, casterActor, candidate: cand, payload: payloadForPassives,
        });
      } catch (e) { warn(`Skill resolve: prePassive "${cand?.carrierName}" threw`, e); }
    }
  }

  // 6b. Post-damage passive trigger — `creature_deals_damage` fires once
  //     per Skill cast with the hit-target list. Reactor is the caster;
  //     reactions filter by `reaction_source: "self"`. Used by Vanish-
  //     style "after dealing damage" reactions that apply AEs to each
  //     hit creature via target_ref: "hit_action_targets". Gated on
  //     ar.hasDamage so non-damage skills (Heal, Reinforce) don't fire it.
  //
  // QUEUED, not fired, so the trigger runs AFTER RESOLVE's actor-snapshot
  // save site. Otherwise reaction-applied AEs (e.g. Vanish) land BEFORE
  // the "After X's Action" rewind anchor, requiring two rewinds to
  // undo them. See [[reaction-architecture]].
  if (ar.hasDamage && hits.some((r) => r.hit)) {
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_deals_damage",
      payload: payloadForPassives,
    });
  }

  // 7. Post-resolve creature_completes_spell dispatch (legacy fallback
  //    + any candidates that weren't evaluated pre-resolve — e.g. an
  //    "off"-mode passive that the pre-eval correctly auto-rejected but
  //    that a player wants to keep available if they flip the mode mid-
  //    session). We pass `skipEvaluated` so firePassiveTriggers can
  //    suppress candidates already handled. Spell-only: non-Spell
  //    actions don't fire this trigger. Queued for post-save firing
  //    same as creature_deals_damage.
  if (String(skill.system?.props?.skill_type ?? "").toLowerCase() === "spell") {
    const evaluated = Array.isArray(ar.evaluatedPrePassives) ? ar.evaluatedPrePassives : [];
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_completes_spell",
      payload: payloadForPassives,
      skipEvaluated: evaluated,
    });
  }
}

// Stash a passive-trigger config in ctx so RESOLVE.onEnter's tail can
// fire it AFTER the actor-snapshot save site. Per-action queue —
// cleared at the end of RESOLVE. Each entry is the same shape that
// `firePassiveTriggers` accepts (minus the director arg).
function queuePostResolveTrigger(director, config) {
  if (!director?.ctx) return;
  if (!Array.isArray(director.ctx._postResolveTriggers)) {
    director.ctx._postResolveTriggers = [];
  }
  director.ctx._postResolveTriggers.push(config);
}

// Extract a formula-evaluable target count from a free-text
// `skill_target` field.
//
// Examples (after caller has already classified mode by the presence of
// "up to" / "all" / etc):
//   "Up to SL creatures"   isUpTo=true  → resolver(SL)
//   "up to 3 creatures"    isUpTo=true  → 3
//   "SL enemies"           isUpTo=false → resolver(SL)
//   "One creature"         isUpTo=false → 1   (via the "one"/"an" alias)
//   "3 allies"             isUpTo=false → 3
//
// On any parse failure → 1 (the safe default). Final value is clamped
// to ≥1 and floored to an integer; non-integer formulas (rare) round
// down so author intent of "SL/2" reads as "half SL targets".
//
// The noun list is generous — it strips trailing keywords like
// `creature(s) / enemy(ies) / ally/allies / target(s) / foe(s) /
// opponent(s)` so the formula lifted out is just the math expression.
export function extractTargetCountFromText(text, { isUpTo, resolver }) {
  if (!text) return 1;
  let expr = isUpTo
    ? String(text).replace(/^.*?up\s+to\s+/i, "")
    : String(text);
  // Strip a trailing noun phrase so "SL creatures" → "SL" and "3
  // enemies" → "3". If nothing matches, the whole string is kept and
  // evaluated as-is (handles bare "SL" or "3").
  expr = expr.replace(/\s+(creatures?|enemies|enemy|allies|ally|targets?|foes?|opponents?)\b.*$/i, "").trim();
  // Common English number-word aliases used in skill text. RAW often
  // writes "Up to three creatures" or "One creature" — treat the word
  // forms as their numeric values. Anything beyond ten (rare in FU) the
  // author can spell as a literal digit.
  const wordNum = {
    one: 1, single: 1, a: 1, an: 1,
    two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const lookup = wordNum[expr.toLowerCase()];
  if (lookup != null) return lookup;
  if (!expr) return 1;
  const n = evaluateFormula(expr, resolver, 1);
  return Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
}

function describeActionForRewind(ar) {
  if (!ar) return "";
  const attName = ar.attacker?.name ?? "?";
  switch (ar.kind) {
    case "Attack": {
      const wep = ar.weapon?.name ?? "weapon";
      const passTag = (ar.totalPasses ?? 1) > 1
        ? `pass ${ar.passIndex}/${ar.totalPasses} `
        : "";
      const hits = (ar.perTargetResults ?? []).filter((r) => r.hit);
      if (!hits.length) {
        const names = (ar.targets ?? []).map((t) => t.name).join(", ") || "target";
        if (ar.roll?.isFumble) return `${attName} fumbled ${wep} on ${names}`;
        return `${attName} ${passTag}missed ${names} with ${wep}`;
      }
      const dmgParts = hits.map((r) => {
        const tag = r.affinity === "AB" ? `+${r.damage} HP` : `${r.damage} dmg`;
        return `${r.name} ${tag}${r.crit ? "!" : ""}`;
      });
      return `${attName} ${passTag}attacked with ${wep} — ${dmgParts.join(", ")}`;
    }
    case "Guard":
      return ar.coverTarget
        ? `${attName} guarded (covering ${ar.coverTarget.name})`
        : `${attName} guarded`;
    case "Equipment":
      return `${attName} swapped equipment`;
    case "Item": {
      const sel = ar.itemSelection;
      if (!sel) return `${attName} (Item, no selection)`;
      if (sel.mode === "use") {
        const cand = (ar.itemCandidates?.use ?? []).find((c) => c.id === sel.key);
        return `${attName} used ${cand?.name ?? "an item"}`;
      }
      if (sel.mode === "create") {
        const cand = (ar.itemCandidates?.create ?? []).find((c) => c.key === sel.key);
        return `${attName} crafted ${cand?.name ?? "an item"}`;
      }
      return `${attName} (Item)`;
    }
    case "Hinder":
      if (!ar.success) return `${attName} failed to Hinder ${ar.target?.name ?? "target"}`;
      return `${attName} inflicted ${ar.statusValue ?? "status"} on ${ar.target?.name ?? "target"}`;
    case "Study":
      if (ar.roll?.isFumble) return `${attName} fumbled Study on ${ar.target?.name ?? "target"}`;
      return `${attName} studied ${ar.target?.name ?? "target"} (${ar.tier?.name ?? "?"})`;
    case "Skill": {
      const skillName = ar.skillName ?? "Skill";
      const targetNames = (ar.targets ?? []).map((t) => t.name).join(", ") || "target";
      if (ar.hasDamage && Array.isArray(ar.perTargetResults) && ar.perTargetResults.length) {
        const hits = ar.perTargetResults.filter((r) => r.hit);
        if (!hits.length) {
          if (ar.roll?.isFumble) return `${attName} fumbled ${skillName} on ${targetNames}`;
          return `${attName} missed ${targetNames} with ${skillName}`;
        }
        const dmgParts = hits.map((r) => {
          const tag = r.affinity === "AB" ? `+${r.damage} HP` : `${r.damage} dmg`;
          return `${r.name} ${tag}${r.crit ? "!" : ""}`;
        });
        return `${attName} cast ${skillName} — ${dmgParts.join(", ")}`;
      }
      return `${attName} cast ${skillName} on ${targetNames}`;
    }
    default:
      return `${attName} (${ar.kind ?? "?"})`;
  }
}

// ─── PREP ──────────────────────────────────────────────────────────────
// Runs the full pre-combat pipeline: curtain raise, encounter / party
// resolution, scene activate, layout, hidden token spawn, asset preload,
// curtain drop, entrance animation, Combat doc create + combatant add +
// initiative roll + startCombat.
//
// On success, sets director.dCombat (via _setDirectorCombat) and
// INTERNAL_DONE transitions to ROUND_START. No Foundry Combat doc is created
// in director mode — dCombat is the sole authority.
//
// On failure (resolveScene fails, both party + enemies empty, network
// timeout during preload, etc.), sets ctx.abortReason and dispatches
// ABORT. The transition table routes ABORTED → STOPPED when combat
// hasn't started, so the boot's cleanup runs without trying to advance
// any turns.
const Prep = {
  async onEnter(director) {
    const payload = director.ctx.payload;
    if (!payload) {
      warn("PREP entered without a payload — aborting");
      director.ctx.abortReason = "no payload";
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    log("PREP: running director-owned battle init");
    let result = null;
    try {
      result = await runDirectorInit(payload);
    } catch (e) {
      err("PREP: runDirectorInit threw", e);
      director.ctx.abortReason = `prep threw: ${e?.message ?? e}`;
      ui.notifications?.error?.(`Battle Director prep failed: ${e?.message ?? e}`);
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    if (!result?.dCombat) {
      warn("PREP: runDirectorInit returned no dCombat");
      director.ctx.abortReason = "no dCombat produced";
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Hand the director-owned DirectorCombat to the FSM. From this point
    // forward all turn/round/current decisions read `director.dCombat`.
    director._setDirectorCombat(result.dCombat);
    // Install lifecycle watchers that need dCombat in place. Owned by
    // director.hooks → auto-disposed on director.stop().
    installGuardHpWatcher(director);
    // Rewind tool: buffer item deletions between snapshots so the
    // rewind UI can recreate consumed items. See [[director-rewind-tool-plan]].
    installItemDeletionTracker(director);
    log(`PREP done: dCombat ${result.dCombat.id} with ${result.partyTokens} party + ${result.enemyTokens} enemies, sourceScene=${result.dCombat?.sourceSceneId ?? "(none)"}`);
    // Clear any leftover state/history from a prior battle that didn't
    // shut down cleanly. The director's stop() + the BattleEnd Cleanup
    // macro both clear these flags, but if BOTH were bypassed (crash,
    // legacy-flow BattleEnd while director was running, etc.) the new
    // battle would prepend its first save onto stale rewind history
    // from a dead battle. Sweep here before checkpoint #1 to guarantee
    // a clean slate. Await so the save below races nothing.
    try { await clearAllDirectorStateFlags(); }
    catch (e) { warn("PREP: clearAllDirectorStateFlags threw", e); }

    // Persistence checkpoint #1 — first save once dCombat is built.
    // Fire-and-forget; a failed write logs but doesn't abort the FSM.
    // Label describes the state the GM will land IN on rewind: the
    // very first turn-picker (or auto-pick → DECLARE) for round 1.
    saveDirectorState(director, {
      label: `Battle Start`,
      description: `${result.partyTokens} party vs ${result.enemyTokens} enem${result.enemyTokens === 1 ? "y" : "ies"} — choose first turn`,
    }).catch((e) => warn("PREP: saveDirectorState failed", e));

    // Hand off to STANDALONE_REACTION_WINDOW for conflict_start dispatch.
    // The new state owns the dispatch + idempotency persistence so PREP
    // doesn't directly block on menus — clean state separation per the
    // A+B retrospective. After standalone resolves, FSM proceeds to
    // ROUND_START.
    director.ctx.standaloneTrigger = "conflict_start";
    director.ctx.standaloneAfter   = STATES.ROUND_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ROUND_START ───────────────────────────────────────────────────────
// In v1 nothing happens here; we just advance. Real implementation would
// drain round-start reaction triggers.
const RoundStart = {
  async onEnter(director) {
    director.ctx.endOfRound = false;
    director.ctx.endOfCombat = false;
    // First-round bump. dCombat.start() leaves round=0 (the pre-combat
    // / conflict_start phase). The first ROUND_START transitions us
    // into Round 1; subsequent ROUND_STARTs (after a wrap) see round
    // already incremented by nextTurn() and leave it alone.
    if (director.dCombat && (director.dCombat.round ?? 0) === 0) {
      director.dCombat.round = 1;
    }
    const roundNo = director.dCombat?.round ?? director.combat?.round ?? 0;
    log(`ROUND_START — round ${roundNo}`);

    // Start-of-round cinematic banner ("ROUND N" + Critical_1 SFX). Fire-and-
    // forget so the ~2.5s flourish overlays the next state rather than
    // blocking the FSM. Broadcasts to all clients.
    if (roundNo > 0) playRoundBanner({ round: roundNo });

    // Hand off to STANDALONE_REACTION_WINDOW for round_start. The
    // transition rule branches on endOfCombat: if combat is over,
    // skip reactions and go straight to STOPPED. Otherwise, route
    // through STANDALONE_REACTION_WINDOW which lands at TURN_START.
    director.ctx.standaloneTrigger = "round_start";
    director.ctx.standaloneAfter   = STATES.TURN_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── TURN_START ────────────────────────────────────────────────────────
// In Phase 2 this state is responsible for *resolving who acts* on the
// current side via the turn picker. nextTurn() (in TURN_END) only flips the
// side and clears currentCombatantId; here we either auto-pick (single
// eligible) or prompt (multiple eligible) via TurnPicker.
const TurnStart = {
  async onEnter(director) {
    // Authoritative path — DirectorCombat owns turn order.
    let snap = null;
    if (director.dCombat) {
      const dc = director.dCombat;
      // Resolve current via picker if not already set (the normal path: a
      // prior TURN_END cleared it).
      if (!dc.currentCombatantId) {
        let eligible = dc.eligibleOnSide(dc.currentSide);
        // Defensive: if the active side has no eligible, try the other side
        // (handles unusual mid-combat defeats not yet seen by nextTurn).
        if (eligible.length === 0) {
          const other = dc._otherSide(dc.currentSide);
          const otherE = dc.eligibleOnSide(other);
          if (otherE.length > 0) {
            warn(`TURN_START: ${dc.currentSide} side has no eligible, swapping to ${other}`);
            dc.currentSide = other;
            eligible = otherE;
          }
        }
        if (eligible.length === 0) {
          warn("TURN_START: no eligible combatants on either side — ending combat");
          director.ctx.endOfCombat = true;
          director.enqueue({ type: INTENTS.INTERNAL_DONE });
          return;
        }
        if (eligible.length === 1) {
          dc.currentCombatantId = eligible[0].id;
          log(`TURN_START: auto-picked ${eligible[0].name} (only eligible on ${dc.currentSide})`);
        } else {
          log(`TURN_START: ${eligible.length} eligible on ${dc.currentSide} — prompting picker`);

          // GM-local picker (always spawned — fallback for unowned
          // combatants AND so the GM can pick on behalf of an offline
          // player). Pills appear over ALL eligible.
          const localPromise = TurnPicker.show({ director, eligible });

          // Per-user broadcast: each online non-GM user gets a MENU_OPEN
          // with ONLY the eligible combatants they own. Players see pills
          // only over their own PCs. Owner-less combatants (NPC allies on
          // the party side, etc.) are GM-only.
          const channel = director.intentChannel;
          const onlinePlayers = (game.users?.contents ?? []).filter((u) => u.active && !u.isGM);
          const sceneUuid = director.dCombat?.scene?.uuid ?? null;
          const broadcastedUserIds = [];
          log(`TURN_START: ${onlinePlayers.length} online non-GM user(s); channel=${channel ? "attached" : "MISSING"}`);
          if (channel) {
            for (const u of onlinePlayers) {
              // Filter eligible to ones this user has OWNER permission on.
              // Use the live actorDoc on the combatant — it was resolved
              // either at PREP/RECONSTRUCT time. Falling back to fromUuid
              // is a defensive fallback in case actorDoc went stale.
              const myEligible = [];
              for (const dc2 of eligible) {
                try {
                  let actor = dc2.actorDoc ?? null;
                  if (!actor && dc2.actorUuid) {
                    actor = await fromUuid(dc2.actorUuid).catch(() => null);
                  }
                  if (!actor) {
                    log(`TURN_START owner-filter[${u.name}]: ${dc2.name} — no actor doc`);
                    continue;
                  }
                  const owns = actor.testUserPermission?.(u, "OWNER");
                  log(`TURN_START owner-filter[${u.name}]: ${dc2.name} (${actor.uuid}) → owns=${owns}`);
                  if (owns) {
                    myEligible.push({
                      combatantId: dc2.id,
                      name: dc2.name,
                      side: dc2.side,
                      tokenUuid: dc2.tokenUuid ?? null,
                      tokenId: dc2.tokenId ?? null,
                    });
                  }
                } catch (e) { warn("TURN_START: owner check threw", e); }
              }
              if (!myEligible.length) {
                log(`TURN_START: no owned eligible for ${u.name} — skipping broadcast`);
                continue;
              }
              try {
                channel.broadcastMenuOpen({
                  targetUserId: u.id,
                  menuSpec: {
                    kind: "turn-picker",
                    combatId: director.combatId,
                    eligible: myEligible,
                    sceneUuid,
                  },
                });
                broadcastedUserIds.push(u.id);
                log(`TURN_START: broadcast turn-picker to ${u.name} (${myEligible.length} pills)`);
              } catch (e) { warn(`TURN_START: broadcast to ${u.name} threw`, e); }
            }
          }

          // Remote await — single channel for ANY user's TURN_COMBATANT_PICKED.
          let remoteAwait = null;
          if (channel && broadcastedUserIds.length > 0) {
            remoteAwait = channel.awaitIntent(INTENTS.TURN_COMBATANT_PICKED, {
              timeoutMs: 30 * 60 * 1000,
            });
          }

          // Race
          let pickedId = null;
          try {
            const result = await Promise.race([
              localPromise.then((id) => ({ source: "local", id })),
              remoteAwait
                ? remoteAwait.then((intent) => ({ source: "remote", id: intent?.body?.combatantId ?? null }))
                : new Promise(() => {}),
            ]);
            pickedId = result.id;

            // Cancel the loser side's UI.
            if (result.source === "local") {
              try { remoteAwait?.abort?.("local-won"); } catch {}
              // Close player mirrors.
              for (const uid of broadcastedUserIds) {
                try {
                  channel?.broadcastMenuClose({
                    targetUserId: uid,
                    kind: "turn-picker",
                    reason: "local-won",
                  });
                } catch {}
              }
            } else {
              // Remote won — close GM's local picker.
              try { TurnPicker.despawn({ director }); } catch {}
              // Also close any OTHER player's mirror (only one combatant
              // is picked; everyone else's picker should go).
              for (const uid of broadcastedUserIds) {
                try {
                  channel?.broadcastMenuClose({
                    targetUserId: uid,
                    kind: "turn-picker",
                    reason: "remote-won",
                  });
                } catch {}
              }
            }
          } catch (e) {
            warn("TURN_START: turn-picker race threw", e);
            try { remoteAwait?.abort?.("error"); } catch {}
          }

          if (!pickedId) {
            warn("TURN_START: picker cancelled — aborting turn");
            director.ctx.abortReason = "no combatant picked";
            director.enqueue({ type: INTENTS.ABORT });
            return;
          }
          dc.currentCombatantId = pickedId;
        }
      }
      const current = dc.current;
      if (!current) {
        warn("TURN_START: dCombat has no current combatant after pick — ending combat");
        director.ctx.endOfCombat = true;
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
      snap = snapshotDirectorCombatant(current);
    } else {
      // Manual-fallback path (no PREP, no dCombat — direct attach to an
      // existing Foundry combat). Read from Foundry combat.combatant.
      const combat = director.combat;
      if (!combat || combat.combatant == null) {
        warn("TURN_START with no current combatant (Foundry path) — ending combat");
        director.ctx.endOfCombat = true;
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
      snap = snapshotCombatant(combat);
    }
    if (!snap) {
      warn("TURN_START: failed to snapshot combatant");
      director.ctx.endOfCombat = true;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    director.ctx.turnSnapshot = snap;
    director.ctx.declaredCommand = null;
    director.ctx.actionResult = null;
    log(`TURN_START — ${snap.name}`);

    // Homebrew rule: AEs the current combatant applied decrement their
    // `turnsRemaining` at the start of THIS combatant's turn (the
    // "applier"); expired AEs are deleted. See [[ae-default-3-turn-duration]].
    // Runs before the Guard release below so a Guard AE the combatant
    // applied to themselves (rare) still resolves on the normal Guard path.
    try {
      const applierUuid = snap?.actorUuid;
      if (applierUuid) {
        await tickDirectorAEsForApplier(applierUuid);
      }
    } catch (e) { warn("TURN_START: AE tick threw", e); }

    // Release any Guard / Covered AEs whose guarder is this combatant.
    // RAW Core p.70: Guard ends at the start of the guarder's next turn.
    // dCombat.activeGuards is the authoritative ledger (see director-combat.js).
    //
    // Batched the same way director-boot.stop() does it: group effect ids by
    // owning actor, run actors in parallel. Avoids the per-AE stutter that
    // sequential awaits produce when both Guard and Covered need to clear.
    if (director.dCombat && snap?.actorId) {
      try {
        const expiring = director.dCombat.popActiveGuardsFor(snap.actorId);
        if (expiring.length) {
          const deletesByActor = new Map();
          for (const g of expiring) {
            if (g.guarderActorUuid && g.guarderEffectId) {
              let set = deletesByActor.get(g.guarderActorUuid);
              if (!set) { set = new Set(); deletesByActor.set(g.guarderActorUuid, set); }
              set.add(g.guarderEffectId);
            }
            if (g.coveredActorUuid && g.coveredEffectId) {
              let set = deletesByActor.get(g.coveredActorUuid);
              if (!set) { set = new Set(); deletesByActor.set(g.coveredActorUuid, set); }
              set.add(g.coveredEffectId);
            }
          }
          await Promise.all(Array.from(deletesByActor.entries()).map(async ([actorUuid, ids]) => {
            try {
              const actor = await fromUuid(actorUuid);
              if (!actor) return;
              const existing = Array.from(ids).filter((id) => !!actor.effects?.get?.(id));
              if (!existing.length) return;
              await actor.deleteEmbeddedDocuments("ActiveEffect", existing);
            } catch (e) { warn(`TURN_START: AE release failed for ${actorUuid}`, e); }
          }));
          const coveredCount = expiring.filter((g) => g.coveredActorUuid).length;
          log(`Released Guard from ${snap.name}${coveredCount ? ` (+${coveredCount} Cover)` : ""}`);
        }
      } catch (e) { warn("TURN_START: guard release loop threw", e); }
    }

    // Persistence checkpoint #2 — turn picker has resolved + Guards have
    // expired; this is the resume-safe state for reload survival.
    // Mid-action states (DECLARE/TARGET/COMPUTE/CONFIRM) are NOT
    // persisted; if the GM F5s during one of those, we rewind to this
    // saved TURN_START and they re-click their command. A fresh turn
    // starts un-resolved; the RESOLVE checkpoint flips this true after
    // the action commits to actor docs.
    if (director.dCombat) director.dCombat.currentTurnResolved = false;
    // Label describes what the GM lands at on rewind: this combatant's
    // DECLARE menu (TURN_START re-auto-picks the saved id and routes
    // through to DECLARE). Subtitle records the situational context.
    const tsDc = director.dCombat;
    const tsName = tsDc?.current?.name ?? snap?.name ?? "?";
    const tsSide = tsDc?.currentSide === "enemy" ? "Enemies" : "Party";
    saveDirectorState(director, {
      label: `Round ${tsDc?.round ?? 0} · ${tsName}'s Turn`,
      description: `${tsSide} acting — pick action`,
    }).catch((e) => warn("TURN_START: saveDirectorState failed", e));

    // Hand off to STANDALONE_REACTION_WINDOW for turn_start. Dispatched
    // across every combatant — reactions like "when ANY turn starts"
    // (Sentinel-style) surface too; the row-side filter controls whose
    // turn matches. Payload carries the acting actor's uuid for those
    // filters. After standalone resolves → DECLARE.
    director.ctx.standaloneTrigger = "turn_start";
    director.ctx.standaloneAfter   = STATES.DECLARE;
    director.ctx.standalonePayload = {
      actingActorUuid: snap?.actorUuid,
      actingTokenUuid: snap?.tokenUuid,
    };
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// Resolve the actor-owner user that should drive an interactive surface
// for `actor`. Returns the userId of the first ACTIVE non-GM owner, or
// null if no eligible owner is online. Deterministic on multi-owner
// actors (sort by userId).
//
// "Owner" means OWNER-level Foundry permission (level 3) — same threshold
// Foundry uses for sheet-edit access. NPCs typically have no non-GM
// owner; PCs have exactly one.
function resolveActingOwnerForActor(actor) {
  if (!actor) return null;
  const candidates = (game.users?.contents ?? []).filter((u) => {
    if (u.isGM) return false;
    if (!u.active) return false;
    try { return actor.testUserPermission?.(u, "OWNER"); }
    catch { return false; }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates[0].id;
}

// ─── DECLARE ───────────────────────────────────────────────────────────
// Run the compose chain (Octopath → per-command pickers) on whichever
// client is fastest. Two chains run in parallel:
//
//   1. GM-local: composeAction() runs on the GM client (fallback path —
//      ensures the GM always has the UI even when no PC owns the actor,
//      AND lets the GM take over if the owner is unresponsive).
//
//   2. Remote:   if the acting actor has an active non-GM owner, the GM
//      also broadcasts MENU_OPEN to that client. The player runs an
//      identical composeAction locally and emits ACTION_COMPOSED when
//      they finish.
//
// Whoever finishes first wins. We cancel the loser, populate ctx from
// the winning bundle, and dispatch DECLARE_COMMAND to move into TARGET.
// Downstream states (TARGET, WEAPON_MODE skip-checks below) read the
// pre-populated ctx fields and skip their pickers when bundle data is
// available.
//
// See [[director-player-driven-input]] for the design.
const Declare = {
  async onEnter(director) {
    const snap = director.ctx.turnSnapshot;
    if (!snap) {
      warn("DECLARE entered without turnSnapshot");
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Clear any multi-pass state from a prior cancelled attack. Without
    // this, cancelling card 1 of a two-weapon attack would leave
    // pendingPasses populated; the next CLEANUP would loop into the
    // second pass automatically — not the user's intent.
    director.ctx.attackMode = null;
    director.ctx.weaponsUsed = null;
    director.ctx.pendingPasses = null;
    director.ctx.currentWeapon = null;
    director.ctx.totalPasses = 0;
    director.ctx.passIndex = 0;
    director.ctx.pickedTargetUuids = null;
    director.ctx.hinderCheckConfig = null;
    director.ctx._composedBundle = null;

    const token = canvas?.tokens?.get(snap.tokenId);
    if (!token) {
      warn("DECLARE: token not on canvas", snap.tokenId);
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }

    // Resolve owner. fromUuid is async but cheap; on error, only GM runs.
    let actor = null;
    try { actor = await fromUuid(snap.actorUuid); } catch {}
    const ownerUserId = resolveActingOwnerForActor(actor);

    // Pre-bake eligible target snapshots. We do this here (with full
    // dCombat access) so the player's client doesn't have to recompute —
    // they get the list via menuSpec. Used by both sides' composeAction.
    const eligibleEnemies = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "enemy" })
      : snapshotEligibleTargets(director.combat, snap, { category: "enemy" });
    const eligibleAllies = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "ally" })
      : snapshotEligibleTargets(director.combat, snap, { category: "ally" });

    // GM-local compose chain. The cancel token lets us tear it down when
    // the player wins the race.
    const cancelToken = makeCancelToken();
    director.ctx._composeCancelToken = cancelToken;
    const localCompose = composeAction({
      director,
      snap,
      token,
      eligible: { enemies: eligibleEnemies, allies: eligibleAllies },
      cancelSentinel: cancelToken.promise,
      combatId: director.combatId,
      actorUuid: snap.actorUuid,
    }).catch((e) => {
      warn("DECLARE: local composeAction threw", e);
      return { cancelled: true, reason: "exception" };
    });

    // Remote chain (if owner is online): broadcast MENU_OPEN + await
    // ACTION_COMPOSED. The player's composeAction emits this when they
    // finish.
    let remoteAwait = null;
    if (ownerUserId) {
      log(`DECLARE: broadcasting compose-action to player ${ownerUserId} (${snap.name})`);
      // Free-action grant — the registry is GM-side memory. Plumb the
      // grant fields into the menuSpec so the player's composeAction
      // applies the Octopath filter + budget label without needing the
      // local freeActions singleton populated.
      const freeActionGrant = freeActions.get(snap.actorId) ?? null;
      try {
        director.intentChannel?.broadcastMenuOpen({
          targetUserId: ownerUserId,
          menuSpec: {
            kind: "compose-action",
            combatId: director.combatId,
            tokenUuid: token.document.uuid,
            actorUuid: snap.actorUuid,
            snap,
            eligible: { enemies: eligibleEnemies, allies: eligibleAllies },
            freeActionGrant,
          },
        });
        // 30-minute timeout — practically forever. The race will resolve
        // sooner via GM-local OR the player will eventually act.
        remoteAwait = director.intentChannel.awaitIntent(INTENTS.ACTION_COMPOSED, {
          fromUserId: ownerUserId,
          timeoutMs: 30 * 60 * 1000,
        });
        director.ctx._activeRemoteMenu = { kind: "compose-action", targetUserId: ownerUserId };
      } catch (e) {
        warn("DECLARE: broadcast/await setup threw, GM-local only", e);
        remoteAwait = null;
      }
    }

    // Mirror of [[reaction-architecture]] Rule 1 stage 2 for turn-action
    // composition: every active player who is NOT the action owner sees a
    // dimmed "Hina taking action…" indicator over the acting token while
    // composeAction is open. Reuses the reaction-indicator MENU_OPEN
    // surface ("turn-action-indicator" kind) which the player-side handler
    // in reaction-menu-player.js renders via ReactionIndicator.spawn.
    // Owner-tracked turn (no human owner — NPC) sends to every active
    // player so the table still sees what the GM is composing.
    const turnActionIndicatorRecipients = (game.users?.contents ?? [])
      .filter((u) => !u.isGM && u.active && u.id !== ownerUserId)
      .map((u) => u.id);
    const turnActorName = ownerUserId
      ? `${game.users.get(ownerUserId)?.name ?? "Player"} taking action…`
      : `${snap?.name ?? "Combatant"} taking action…`;
    const turnActionIndicatorSpec = {
      kind: "turn-action-indicator",
      combatId: director.combatId,
      tokenUuid: token.document.uuid,
      actorUuid: snap.actorUuid,
      label: turnActorName,
      trigger: "turn-action",
    };
    function broadcastTurnActionIndicatorOpen() {
      if (!director.intentChannel) return;
      for (const uid of turnActionIndicatorRecipients) {
        try {
          director.intentChannel.broadcastMenuOpen({
            targetUserId: uid,
            menuSpec: turnActionIndicatorSpec,
          });
        } catch (e) { warn("DECLARE: broadcastMenuOpen(turn-action-indicator) threw", e); }
      }
    }
    function broadcastTurnActionIndicatorClose() {
      if (!director.intentChannel) return;
      for (const uid of turnActionIndicatorRecipients) {
        try {
          director.intentChannel.broadcastMenuClose({
            targetUserId: uid,
            kind: "turn-action-indicator",
            reason: "compose-resolved",
            data: { tokenUuid: token.document.uuid, combatId: director.combatId },
          });
        } catch (e) { warn("DECLARE: broadcastMenuClose(turn-action-indicator) threw", e); }
      }
    }
    broadcastTurnActionIndicatorOpen();
    director.ctx._closeTurnActionIndicator = broadcastTurnActionIndicatorClose;

    // Race. If only GM is running (no remote), the remote side is a
    // never-resolving Promise so localCompose alone determines the
    // winner.
    let winnerSource = null;
    let winnerBundle = null;
    // Wrap the remote await so we can abort it on local-wins. Without
    // this, an unresolved awaitIntent for ACTION_COMPOSED would linger
    // in _pendingAwaits and the NEXT turn's emit would resolve the
    // stale entry first (Map insertion order). See [[director-player-driven-input]].
    try {
      const result = await Promise.race([
        localCompose.then((r) => ({ source: "local", result: r })),
        remoteAwait
          ? remoteAwait.then((intent) => ({ source: "remote", result: { cancelled: !intent?.body?.bundle, bundle: intent?.body?.bundle ?? null } }))
          : new Promise(() => {}),
      ]);
      winnerSource = result.source;

      // Cancel the loser.
      if (winnerSource === "local") {
        // Abort the dangling remote awaitIntent so it doesn't leak.
        try { remoteAwait?.abort?.("local-won"); } catch {}
        if (ownerUserId) {
          try {
            director.intentChannel?.broadcastMenuClose({
              targetUserId: ownerUserId,
              kind: "compose-action",
              reason: "local-won",
            });
          } catch (e) { warn("DECLARE: broadcastMenuClose (local-won) threw", e); }
          director.ctx._activeRemoteMenu = null;
        }
      } else {
        // Remote won — cancel GM's local compose so its overlays close.
        cancelToken.cancel("remote-won");
        // Wait for local to actually unwind so its UI is gone before we
        // move to TARGET (avoids dangling Octopath).
        try { await localCompose; } catch {}
      }

      if (result.result.cancelled) {
        log(`DECLARE: compose cancelled (winner=${winnerSource})`);
        // Bounce back to TURN_END so the FSM can move on or End Battle.
        director.enqueue({ type: INTENTS.TIMEOUT });
        return;
      }

      winnerBundle = result.result.bundle;
    } catch (e) {
      warn("DECLARE: compose race threw", e);
      director.enqueue({ type: INTENTS.ABORT });
      return;
    } finally {
      director.ctx._composeCancelToken = null;
    }

    if (!winnerBundle || !winnerBundle.command) {
      warn("DECLARE: race winner produced no bundle", winnerBundle);
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }

    log(`DECLARE: winner=${winnerSource}, command=${winnerBundle.command}`);

    // Apply bundle to ctx — sets up pre-populated picks so TARGET state
    // can skip its pickers when data is already provided. For
    // "_commandOnly" bundles (Skill/Spell/Item — not yet supported by
    // composeAction beyond the Octopath click), the GM still runs its
    // normal pickers in TARGET state.
    if (!winnerBundle._commandOnly) {
      // Generic marker that any branch can read for "did the player
      // pre-compose this?" — set to the full bundle for fine-grained
      // dispatch in per-command branches below.
      director.ctx._composedBundle = winnerBundle;

      if (winnerBundle.command === "Attack") {
        if (winnerBundle.attackMode) director.ctx.attackMode = winnerBundle.attackMode;
        if (Array.isArray(winnerBundle.targetUuids)) {
          director.ctx.pickedTargetUuids = [...winnerBundle.targetUuids];
        }
      } else if (winnerBundle.command === "Study" || winnerBundle.command === "Hinder") {
        // Both share the same shape — a single enemy target.
        if (Array.isArray(winnerBundle.targetUuids)) {
          director.ctx.pickedTargetUuids = [...winnerBundle.targetUuids];
        }
      } else if (winnerBundle.command === "Skill" || winnerBundle.command === "Spell") {
        // Skill/Spell carries the picked skill + sourceItem + targets.
        // TARGET's Skill branch reads ctx._composedBundle to skip
        // pickSkill / requestTargeting; the affordability check +
        // Vismagus + actionResult build stay GM-authority.
        if (Array.isArray(winnerBundle.targetUuids)) {
          director.ctx.pickedTargetUuids = [...winnerBundle.targetUuids];
        }
      }
      // Guard: bundle.coverTokenUuid (null = skip, string = ally) is
      //   consumed by TARGET's Guard branch via ctx._composedBundle.
      // Equipment: no extra ctx — TARGET branch already needs nothing
      //   beyond declaredCommand.
    } else {
      director.ctx._composedBundle = null;
    }
    director.ctx.declaredCommand = winnerBundle.command;

    // Advance the FSM. TARGET's per-command branches read ctx and skip
    // their pickers when pre-populated.
    director.dispatch({
      type: INTENTS.DECLARE_COMMAND,
      body: { command: winnerBundle.command },
    });
  },

  async onExit(director) {
    TurnUI.despawn({ director });
    // Cancel any in-flight local compose (defensive — race usually
    // resolves before onExit fires).
    try { director.ctx._composeCancelToken?.cancel("state-exit"); } catch {}
    // Tell the player's client to close its compose UI if it's still up.
    const remote = director.ctx._activeRemoteMenu;
    if (remote) {
      try {
        director.intentChannel?.broadcastMenuClose({
          targetUserId: remote.targetUserId,
          kind: remote.kind,
          reason: "state-exit",
        });
      } catch (e) { warn("DECLARE.onExit: broadcastMenuClose threw", e); }
      director.ctx._activeRemoteMenu = null;
    }
    // Tear down the turn-action ally indicator (set up at onEnter).
    try { director.ctx._closeTurnActionIndicator?.(); } catch {}
    director.ctx._closeTurnActionIndicator = null;
  },

  async onAbort(director, { reason } = {}) {
    TurnUI.despawn({ director });
    try { director.ctx._composeCancelToken?.cancel(`abort:${reason ?? "unknown"}`); } catch {}
    const remote = director.ctx._activeRemoteMenu;
    if (remote) {
      try {
        director.intentChannel?.broadcastMenuClose({
          targetUserId: remote.targetUserId,
          kind: remote.kind,
          reason: `abort:${reason ?? "unknown"}`,
        });
      } catch (e) { warn("DECLARE.onAbort: broadcastMenuClose threw", e); }
      director.ctx._activeRemoteMenu = null;
    }
    try { director.ctx._closeTurnActionIndicator?.(); } catch {}
    director.ctx._closeTurnActionIndicator = null;
  },
};

// ─── TARGET ────────────────────────────────────────────────────────────
const Target = {
  async onEnter(director, { triggerIntent }) {
    const command = triggerIntent?.body?.command ?? director.ctx.declaredCommand;
    director.ctx.declaredCommand = command;
    log(`TARGET — command: ${command}`);

    // ─── Guard (RAW Core p.70) ────────────────────────────────────────
    // Always grants Resistance + Opposed Check +2 to the guarder until the
    // start of their next turn. Optionally, the guarder may also Cover
    // another creature — that creature cannot be targeted by melee
    // attacks until the same release point.
    //
    // Target step: ally-picker with a "Skip Cover" secondary action so
    // the player can mouse-only Guard alone OR Guard + Cover an ally.
    if (command === "Guard") {
      const attackerSnap = director.ctx.turnSnapshot;
      // Eligible cover targets: same-side combatants on the scene,
      // excluding self (Guard is self-applied implicitly).
      const allies = director.dCombat
        ? snapshotEligibleTargetsFromDCombat(director.dCombat, attackerSnap, { category: "ally" })
        : snapshotEligibleTargets(director.combat, attackerSnap, { category: "ally" });
      const coverEligible = (allies ?? []).filter((a) => a.tokenUuid !== attackerSnap.tokenUuid);
      director.ctx.eligibleTargets = coverEligible;

      // Pre-composed by player? composeGuard's bundle carries
      // coverTokenUuid (null = skip cover, uuid = picked ally). Skip
      // the local picker and feed the choice through directly.
      const composedGuard = director.ctx._composedBundle;
      let coverTarget;
      if (composedGuard && composedGuard.command === "Guard" && "coverTokenUuid" in composedGuard) {
        log(`TARGET (Guard): using pre-composed coverTokenUuid=${composedGuard.coverTokenUuid ?? "none"}`);
        coverTarget = composedGuard.coverTokenUuid
          ? coverEligible.find((t) => t.tokenUuid === composedGuard.coverTokenUuid) ?? null
          : null;
      } else {
        const result = await requestTargeting({
          director,
          eligible: coverEligible,
          mode: "exact",
          count: 1,
          titleText: `${attackerSnap.name}: pick an ally to Cover (optional)`,
          cancelLabel: "Cancel Guard",
          secondaryAction: { label: "Skip Cover", value: "skip" },
        });
        if (!result.ok) {
          // Cancel Guard entirely → bounce back to DECLARE.
          director.dispatch({ type: result.cancelled ? INTENTS.TARGET_BACK : INTENTS.ABORT });
          return;
        }
        coverTarget = (result.skipped || result.tokenUuids.length === 0)
          ? null
          : coverEligible.find((t) => t.tokenUuid === result.tokenUuids[0]) ?? null;
      }

      director.ctx.actionResult = freezeActionResult({
        kind: "Guard",
        attacker: attackerSnap,
        coverTarget,
        // `targets` keeps a compat shape for the card portrait picker etc.
        targets: coverTarget ? [coverTarget] : [attackerSnap],
      });
      director.dispatch({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: coverTarget ? [coverTarget.tokenUuid] : [attackerSnap.tokenUuid] },
      });
      return;
    }

    // ─── Equipment (RAW Core p.70) ────────────────────────────────────
    // "You may store any number of your equipped items in your backpack,
    // and you may take any number of items from your backpack and equip
    // them. The only thing you can't equip or put away is armor."
    //
    // Director-side this is a no-targeting, no-roll action — the player
    // makes the actual swaps on the actor sheet. The card just records the
    // declared action, surfaces an "Open Sheet" button for convenience,
    // and ends the turn when the player confirms.
    if (command === "Equipment") {
      director.ctx.actionResult = freezeActionResult({
        kind: "Equipment",
        attacker: director.ctx.turnSnapshot,
        attackerActorRef: director.ctx.turnSnapshot.actorUuid,
        targets: [director.ctx.turnSnapshot],
      });
      director.enqueue({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: [director.ctx.turnSnapshot.tokenUuid] },
      });
      return;
    }

    // ─── Study (RAW Core p.74) ────────────────────────────────────────
    // Open Check (default INS + INS) against a chosen creature. The
    // total determines what tier of info gets revealed on the Monster
    // Encyclopedia journal page (Identity ≥ 7, Stats ≥ 8, Details ≥ 13
    // per `scripts/encyclopedia/encyclopedia-core.js`).
    //
    // For v1 we restrict targets to enemies. Per RAW the action targets
    // "an item, a person, a creature or even a location," but in combat
    // the typical case is studying an enemy. Allies / objects are a
    // future scope decision.
    if (command === "Study") {
      const attackerSnap = director.ctx.turnSnapshot;
      const eligible = director.dCombat
        ? snapshotEligibleTargetsFromDCombat(director.dCombat, attackerSnap, { category: "enemy" })
        : snapshotEligibleTargets(director.combat, attackerSnap, { category: "enemy" });
      director.ctx.eligibleTargets = eligible;
      if (eligible.length === 0) {
        ui.notifications?.warn("No creatures to Study.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      // Pre-composed targets from player's composeStudy?
      let tokenUuids;
      if (director.ctx.pickedTargetUuids?.length) {
        log(`TARGET (Study): using pre-composed targets=${director.ctx.pickedTargetUuids.join(",")}`);
        tokenUuids = [...director.ctx.pickedTargetUuids];
      } else {
        const result = await requestTargeting({
          director,
          eligible,
          mode: "exact",
          count: 1,
          titleText: `${attackerSnap.name}: pick a creature to Study`,
        });
        if (!result.ok) {
          director.dispatch({ type: result.cancelled ? INTENTS.TARGET_BACK : INTENTS.ABORT });
          return;
        }
        tokenUuids = [...result.tokenUuids];
        director.ctx.pickedTargetUuids = tokenUuids;
      }
      director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: tokenUuids } });
      return;
    }

    // ─── Hinder (RAW Core p.71) ───────────────────────────────────────
    // Force an opponent into a disadvantageous position. Check vs DL 10
    // (NOT against the target's DEF). RAW: "the Game Master will determine
    // the relevant Attributes based on your description" — for v1 we
    // hardcode DEX+INS (the most common feint-style pair); an attribute
    // picker is a future polish.
    //
    // On success, the player picks ONE status from {dazed, shaken, slow,
    // weak} via the card buttons — that pick IS the commit.
    if (command === "Hinder") {
      const attackerSnap = director.ctx.turnSnapshot;
      const eligible = director.dCombat
        ? snapshotEligibleTargetsFromDCombat(director.dCombat, attackerSnap, { category: "enemy" })
        : snapshotEligibleTargets(director.combat, attackerSnap, { category: "enemy" });
      director.ctx.eligibleTargets = eligible;
      if (eligible.length === 0) {
        ui.notifications?.warn("No opponents to Hinder.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      // Pre-composed targets from player's composeHinder? The target is
      // the player's call but the attribute pair stays GM-side per RAW.
      let targetTokenUuids;
      if (director.ctx.pickedTargetUuids?.length) {
        log(`TARGET (Hinder): using pre-composed targets=${director.ctx.pickedTargetUuids.join(",")}`);
        targetTokenUuids = [...director.ctx.pickedTargetUuids];
      } else {
        const targetResult = await requestTargeting({
          director,
          eligible,
          mode: "exact",
          count: 1,
          titleText: `${attackerSnap.name}: pick an opponent to Hinder`,
        });
        if (!targetResult.ok) {
          director.dispatch({ type: targetResult.cancelled ? INTENTS.TARGET_BACK : INTENTS.ABORT });
          return;
        }
        targetTokenUuids = [...targetResult.tokenUuids];
      }

      // Per RAW Core p.71, the GM picks the attribute pair AFTER the
      // player describes their approach. Surface that on the GM client
      // now — the player is committed to the target but waits for the GM
      // to call the check. Default DL is 10 (the fixed RAW value) but the
      // GM can adjust for situational difficulty.
      const targetSnap = eligible.find((t) => t.tokenUuid === targetTokenUuids[0]) ?? null;
      const targetName = targetSnap?.name ?? "target";
      const checkConfig = await pickAttributePair({
        director,
        titleText: `Hinder ${targetName}: configure the Check`,
        subtitle: `Pick the attribute pair the GM thinks matches the player's described approach. DL default ${10} per RAW Core p.71.`,
        defaults: { A1: "DEX", A2: "INS" },
        includeDL: true,
        defaultDL: 10,
      });
      if (!checkConfig.ok) {
        // GM cancelled the configure step → cancel Hinder, back to DECLARE.
        director.dispatch({ type: INTENTS.TARGET_BACK });
        return;
      }
      director.ctx.pickedTargetUuids = targetTokenUuids;
      director.ctx.hinderCheckConfig = {
        A1: checkConfig.A1,
        A2: checkConfig.A2,
        dl: checkConfig.dl ?? 10,
      };
      director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids } });
      return;
    }

    // ─── Skill / Spell (Phase B.1) ────────────────────────────────────
    // Skill picker → targeting → optional check roll → damage/effects.
    // The skill data lives on Item docs with `system.props.*` (CSB-defined
    // schema, see docs/reaction-config-schema.md). We READ that data here
    // and execute via director-native effect engine — no legacy macros.
    //
    // Both Skill and Spell commands route through this branch. They
    // differ only in the picker's skill_type filter:
    //   Skill → skill_type === "Active"
    //   Spell → skill_type === "Spell"
    if (command === "Skill" || command === "Spell") {
      const isSpellAction = command === "Spell";
      const attackerSnap = director.ctx.turnSnapshot;
      let attackerActor = null;
      try { attackerActor = await fromUuid(attackerSnap.actorUuid); } catch {}
      if (!attackerActor) {
        ui.notifications?.warn(`Couldn't read your ${command.toLowerCase()}s — actor not found.`);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }

      // Pre-composed by player? Bundle carries skillUuid + sourceItemUuid
      // + targetUuids. Skip pickSkill on this client.
      const composedSpell = director.ctx._composedBundle;
      const usingPreComposed = !!(composedSpell
        && (composedSpell.command === "Skill" || composedSpell.command === "Spell")
        && composedSpell.skillUuid);

      // 1) Pick from the actor's roster (+ equipped-item grants).
      //    Spell action filters to skill_type=Spell; Skill action to Active.
      let pick;
      if (usingPreComposed) {
        log(`TARGET (${command}): using pre-composed skillUuid=${composedSpell.skillUuid}`);
        pick = {
          skillUuid: composedSpell.skillUuid,
          sourceItemUuid: composedSpell.sourceItemUuid ?? null,
        };
      } else {
        pick = await pickSkill({
          director,
          actor: attackerActor,
          allowedSkillTypes: isSpellAction ? ["spell"] : ["active"],
          titleText: isSpellAction ? "Choose a Spell" : "Choose a Skill",
          emptyMessage: isSpellAction
            ? `${attackerActor.name ?? "Combatant"} knows no spells.`
            : `${attackerActor.name ?? "Combatant"} has no Active skills available.`,
        });
        if (!pick) {
          director.dispatch({ type: INTENTS.TARGET_BACK });
          return;
        }
      }
      let skill = null;
      try { skill = await fromUuid(pick.skillUuid); } catch {}
      if (!skill) {
        ui.notifications?.error("Picked skill could not be resolved.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }

      // 2) Determine targeting from skill_target prop.
      //    "Self" / blank-with-no-damage → caster; "all enemies" → all
      //    eligible enemies (no picker); "one creature"/"one enemy"/etc →
      //    enemy picker; "ally" → ally picker. Best-effort parse from the
      //    free-text field — author can pin via explicit override later.
      const skillTargetText = String(skill.system?.props?.skill_target ?? "").trim().toLowerCase();
      const intent = classifyActionIntent(skill);
      const isSelf = !skillTargetText || /^self$/.test(skillTargetText);

      let targets = [];
      let targetUuids = [];

      if (isSelf) {
        targets = [attackerSnap];
        targetUuids = [attackerSnap.tokenUuid];
      } else {
        // Pick category.
        // "creature/creatures" keyword → any (ally + enemy both valid per RAW).
        // "ally/allies" keyword OR aid intent → ally only.
        // Default → enemy.
        //
        // "creature" takes priority over intent: Capote / Cross-Guard / etc.
        // say "One Creature" and genuinely allow either ally or enemy.
        // Hostile non-damage Active skills (NPC Steal *, Hinder, Provoke)
        // need `action_intent: "harmful"` on the item — the classifier's
        // step-8 "Active without damage → aid" default would otherwise
        // route them to allies. See the 2026-06-03 migration.
        const wantsCreature = /creature|creatures/i.test(skillTargetText);
        const wantsAlly = !wantsCreature && (/ally|allies/i.test(skillTargetText) || intent === "aid");
        const category = wantsCreature ? "any" : (wantsAlly ? "ally" : "enemy");
        const eligibleRaw = director.dCombat
          ? snapshotEligibleTargetsFromDCombat(director.dCombat, attackerSnap, { category })
          : snapshotEligibleTargets(director.combat, attackerSnap, { category });

        // Pick mode + count from text. "all X" → all. "up to N" → up_to N.
        // "N X" → exact N. Default → exact 1.
        //
        // Count accepts a FORMULA (not just a literal): "up to SL
        // creatures" / "SL enemies" / "up to SL+1 allies" all
        // evaluate `SL` (and friends) via the skill resolver. Lets
        // RAW Ignis / Stormblade / Magical Artillery declare scaling
        // target counts directly in `skill_target`. Identifier values
        // come from the firing skill's level via `SL` in the resolver
        // (see skill-formulas.js).
        let mode = "exact";
        let count = 1;
        const targetCountResolver = buildSkillResolver({
          actor: attackerActor,
          payload: null,
          skill,
          round: director.dCombat?.round ?? 0,
        });
        if (/\ball\b/i.test(skillTargetText)) { mode = "all"; count = eligibleRaw.length; }
        else if (/up\s+to/i.test(skillTargetText)) {
          mode = "up_to";
          count = extractTargetCountFromText(skillTargetText, { isUpTo: true, resolver: targetCountResolver });
        } else {
          count = extractTargetCountFromText(skillTargetText, { isUpTo: false, resolver: targetCountResolver });
        }

        const categoryLabel = category === "any" ? "creatures" : `${category}s`;
        if (mode === "all") {
          if (!eligibleRaw.length) {
            ui.notifications?.warn(`No eligible ${categoryLabel} on this scene.`);
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          targets = eligibleRaw;
          targetUuids = eligibleRaw.map((e) => e.tokenUuid);
        } else {
          if (!eligibleRaw.length) {
            ui.notifications?.warn(`No eligible ${categoryLabel} on this scene.`);
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          director.ctx.eligibleTargets = eligibleRaw;
          // Pre-composed targets from player's composeSkill?
          let result;
          if (usingPreComposed && Array.isArray(composedSpell.targetUuids) && composedSpell.targetUuids.length) {
            log(`TARGET (${command}): using pre-composed targets=${composedSpell.targetUuids.join(",")}`);
            result = { ok: true, cancelled: false, tokenUuids: [...composedSpell.targetUuids] };
          } else {
            const titleText = `${attackerSnap.name}: pick target${count > 1 ? "s" : ""} for ${skill.name}`;
            result = await requestTargeting({
              director,
              eligible: eligibleRaw,
              mode,
              count,
              titleText,
            });
          }
          if (!result.ok) {
            director.dispatch({ type: result.cancelled ? INTENTS.TARGET_BACK : INTENTS.ABORT });
            return;
          }
          targetUuids = [...result.tokenUuids];
          targets = eligibleRaw.filter((e) => targetUuids.includes(e.tokenUuid));
        }
      }

      // 3) Re-check affordability with the actual target count (×T tokens).
      const parsedCost = parseSkillCost(String(skill.system?.props?.cost ?? ""));
      let costMap = resolveCost(parsedCost, { actor: attackerActor, targetCount: targets.length });
      let gate = checkAffordable(attackerActor, costMap);

      // ── Short-on-MP reactions (Vismagus + future cost-swap traits) ──
      //
      // When the cost gate fails ONLY on MP, fire the
      // `caster_short_on_mp` reaction trigger. Carriers (Vismagus item,
      // any future "spend X instead of MP" class trait) author a
      // `substitute_cost` effect_table row that rewrites `costMap` in
      // place. After dispatch, re-check affordability against the new
      // map. The dispatcher is generic: no skill name / class flag
      // hardcoding lives here.
      //
      // The substitute_cost effect stamps `payload.vismagusHpPaid` (and
      // `payload.suppressSelfGrantOf`) when it mutates the map, so
      // RESOLVE's self-heal suppression continues to work for Vismagus.
      let vismagusHpPaid = false;
      const onlyMpMissing = !gate.ok && gate.missing.every(
        (m) => String(m.resource ?? m.label ?? "").toLowerCase() === "mp"
      );
      const skillIsSpell = String(skill.system?.props?.skill_type ?? "").toLowerCase() === "spell";
      if (!gate.ok && onlyMpMissing && skillIsSpell) {
        const reactionPayload = {
          sourceActorUuid: attackerActor.uuid,
          actorUuid:       attackerActor.uuid,
          skillUuid:       skill.uuid,
          skillName:       skill.name,
          skillType:       "Spell",
          costMap,
          mpNeeded:        Number(costMap.get?.("mp") ?? costMap.mp ?? 0) || 0,
          curHp:           Number(attackerActor.system?.props?.current_hp ?? 0) || 0,
        };
        // Use the shared multi-client reaction-menu dispatcher (same
        // surface as standalone triggers — player-broadcast + ally
        // indicator come for free). Cancel button instead of Pass since
        // declining means the spell isn't affordable; we return the
        // player to the action picker.
        const casterToken = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === attackerActor.uuid)
          ?? null;
        if (casterToken) {
          const stMod = await import("./standalone-reactions.js?cb=" + Date.now());
          let decision;
          try {
            decision = await stMod.dispatchReactionMenu({
              director,
              reactor: attackerActor,
              token: casterToken,
              trigger: "caster_short_on_mp",
              payload: reactionPayload,
              label: `Can't afford ${skill.name}`,
              passLabel: "Cancel",
            });
          } catch (e) {
            warn("caster_short_on_mp dispatchReactionMenu threw", e);
            decision = { cancelled: false, fired: [] };
          }
          if (decision.cancelled) {
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          gate = checkAffordable(attackerActor, costMap);
          vismagusHpPaid = !!reactionPayload.vismagusHpPaid;
        } else {
          warn("caster_short_on_mp: caster token not on canvas — gate fails through");
        }
      }
      if (!gate.ok) {
        const missing = gate.missing.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", ");
        ui.notifications?.warn(`Can't cast ${skill.name} — missing ${missing}.`);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }

      // Display cost — defaults to the CSB raw cost string ("10 MP").
      // When Vismagus (or any future substitute_cost reaction) fired,
      // rewrite it to surface the resource that ACTUALLY got paid so
      // the action card subtitle reflects reality ("20 HP · Vismagus").
      let displayCost = String(skill.system?.props?.cost ?? "");
      if (vismagusHpPaid) {
        const hpPaid = Number(costMap.get?.("hp") ?? costMap.hp ?? 0) || 0;
        if (hpPaid > 0) displayCost = `${hpPaid} HP · Vismagus`;
      }

      // 4) Build actionResult. We deliberately do NOT freeze the live
      //    skill doc (circular item.parent refs blow the freeze walk);
      //    only uuids + scalar fields. RESOLVE re-fetches via fromUuid.
      director.ctx.actionResult = freezeActionResult({
        kind: "Skill",
        attacker: attackerSnap,
        attackerActorRef: attackerSnap.actorUuid,
        skillUuid: skill.uuid,
        skillName: skill.name,
        skillImg: skill.img,
        skillType: String(skill.system?.props?.skill_type ?? ""),
        defenseTargetType: String(skill.system?.props?.defense_target_type ?? "").toLowerCase(),
        isCheck: !!skill.system?.props?.isCheck,
        rolledA1: String(skill.system?.props?.rolled_atr1 ?? "").toUpperCase(),
        rolledA2: String(skill.system?.props?.rolled_atr2 ?? "").toUpperCase(),
        checkBonus: Number(skill.system?.props?.check_bonus ?? 0) || 0,
        damageBonus: skill.system?.props?.damage_bonus ?? 0,
        damageType: String(skill.system?.props?.type_damage ?? ""),
        skillRange: String(skill.system?.props?.skill_range ?? ""),
        skillTarget: skillTargetText,
        sourceItemUuid: pick.sourceItemUuid ?? null,
        descriptionHtml: String(skill.system?.props?.description ?? ""),
        targets,
        costSerialized: serializeCostMap(costMap),
        rawCost: displayCost,
        actionIntent: intent,
        // Vismagus alt-cost flag — resolveSkillAction reads this and
        // suppresses self-heal when the spell would heal the caster
        // (RAW: "you instead recover no HP, the spell still works on
        // other targets").
        vismagusHpPaid,
      });
      director.ctx.pickedTargetUuids = targetUuids;
      director.dispatch({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: targetUuids },
      });
      return;
    }

    // ─── Item (RAW Core p.71) ────────────────────────────────────────
    // Use a consumable or craft one from a known recipe. Director-side
    // this is a self-target menu action: TARGET pre-fetches the actor's
    // consumable list + creatable recipes (via legacy itemCreate API for
    // recipes) and stages them on actionResult so the card body can
    // render them synchronously. COMPUTE is a pass-through (no roll for
    // the resource step). RESOLVE debits the right resource and toasts.
    //
    // v1 scope: resource accounting only. Actually invoking the item's
    // active skill is deferred to Phase B (Skills). The card surfaces
    // the linked skill names so the player knows what's *coming*, and
    // the commit toast notes the deferred status.
    if (command === "Item") {
      const attackerSnap = director.ctx.turnSnapshot;
      let attackerActor = null;
      try { attackerActor = await fromUuid(attackerSnap.actorUuid); } catch {}
      if (!attackerActor) {
        ui.notifications?.warn("Couldn't read your inventory — actor not found.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      const [useList, createList] = await Promise.all([
        gatherConsumables(attackerActor),
        gatherCreatables(attackerActor),
      ]);
      if (!useList.length && !createList.length) {
        ui.notifications?.warn("No consumables to use and no recipes to create.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      const ip = readActorIp(attackerActor);
      director.ctx.actionResult = freezeActionResult({
        kind: "Item",
        attacker: attackerSnap,
        attackerActorRef: attackerSnap.actorUuid,
        targets: [attackerSnap],
        itemCandidates: { use: useList, create: createList },
        ip,
      });
      director.enqueue({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: [attackerSnap.tokenUuid] },
      });
      return;
    }

    if (command !== "Attack") {
      // Stub: any other command shows a notification and returns to DECLARE
      ui.notifications?.info(`"${command}" is not implemented in Director v1. Pick Attack, Guard, Study, Hinder, Equipment, Item, Skill, or Spell.`);
      director.enqueue({ type: INTENTS.TARGET_BACK });
      return;
    }

    // Multi-pass re-entry detection. When CLEANUP loops back here for the
    // second pass of a two-weapon attack, attackMode is already set and
    // pendingPasses still has weapons to roll. Skip the weapon-mode picker
    // and the queue setup — just re-pick targets for the next weapon.
    // Both two-weapon variants ("two-weapon" main-first, "two-weapon-off-first")
    // count.
    const attacker = director.ctx.turnSnapshot;
    const isTwoWeaponAny = String(director.ctx.attackMode ?? "").startsWith("two-weapon");
    const isMultiPassReEntry = isTwoWeaponAny
      && Array.isArray(director.ctx.pendingPasses)
      && director.ctx.pendingPasses.length > 0
      && (director.ctx.passIndex ?? 0) >= 1;

    if (!isMultiPassReEntry) {
      // NPC branch — single pass, pseudo-weapon built from the chosen
      // Attack Item (`composeAttackNpc` passed its UUID in the bundle).
      // No weapon-mode picker (NPCs don't dual-wield in BD).
      if (director.ctx.attackMode === "npc") {
        const itemUuid = director.ctx._composedBundle?.npcAttackItemUuid
          ?? director.ctx.npcAttackItemUuid
          ?? null;
        let item = null;
        try { item = itemUuid ? await fromUuid(itemUuid) : null; } catch {}
        if (!item) {
          ui.notifications?.warn(`${attacker.name} has no usable Attack.`);
          warn("TARGET Attack (NPC): could not resolve attack item", itemUuid);
          director.enqueue({ type: INTENTS.TARGET_BACK });
          return;
        }
        const pseudo = buildPseudoWeaponFromNpcAttack(item);
        if (!pseudo) {
          ui.notifications?.warn(`${attacker.name}'s Attack is missing attribute or damage data.`);
          warn("TARGET Attack (NPC): buildPseudoWeapon returned null", item.name);
          director.enqueue({ type: INTENTS.TARGET_BACK });
          return;
        }
        director.ctx.weaponsUsed = [pseudo];
        director.ctx.pendingPasses = [pseudo];
        director.ctx.totalPasses = 1;
        director.ctx.passIndex = 0;
        director.ctx.npcAttackItemUuid = itemUuid;
        log(`TARGET (Attack/NPC): pseudo-weapon "${pseudo.name}" (${pseudo.A1}/${pseudo.A2}, +${pseudo.checkBonus}/+${pseudo.damageBonus} ${pseudo.damageType})`);
      } else {
      // First entry — weapon-mode picker + pendingPasses setup.
      // RAW Core p.69 + house policy:
      //   - Both hands equipped → picker appears (Main + Off; Two-Weapon
      //     option only when same Category per RAW). Off-Hand always
      //     available when off-hand is equipped.
      //   - Only main equipped → no picker; main is used.
      //   - Only off equipped → no picker; off is used.
      const hasMain = !!attacker.weapon;
      const hasOff = !!attacker.offWeapon;
      if (!hasMain && !hasOff) {
        ui.notifications?.warn(`${attacker.name} has no usable weapon.`);
        warn("TARGET Attack: no weapon equipped", attacker.name);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      let attackMode = "main";
      // Pre-populated by composeAction's bundle (player- or GM-driven
      // race winner). When set, skip the weapon-mode picker — the
      // decision was already made client-side.
      if (director.ctx.attackMode) {
        attackMode = director.ctx.attackMode;
        log(`TARGET (Attack): using pre-composed attackMode=${attackMode}`);
      } else if (hasMain && hasOff) {
        const picked = await pickWeaponMode({
          director,
          mainWeapon: attacker.weapon,
          offWeapon: attacker.offWeapon,
          allowTwoWeapon: !!attacker.canTwoWeaponFight,
        });
        if (!picked) {
          director.enqueue({ type: INTENTS.TARGET_BACK });
          return;
        }
        attackMode = picked;
      } else if (hasOff && !hasMain) {
        attackMode = "off";
      }
      // Two-weapon: each pass is its OWN action card (separate confirm +
      // resolve + reaction window + target pick) so reactions can fire
      // between passes and the player can pick different targets per RAW.
      // The picker offers two variants of Two-Weapon — main-first
      // ("two-weapon") and off-first ("two-weapon-off-first") — because
      // RAW lets the player choose order (Core p.69: "you perform the two
      // attacks in any order you prefer").
      const weaponsUsed = (attackMode === "two-weapon")
        ? [attacker.weapon, attacker.offWeapon]
        : (attackMode === "two-weapon-off-first")
          ? [attacker.offWeapon, attacker.weapon]
          : (attackMode === "off" ? [attacker.offWeapon] : [attacker.weapon]);
      director.ctx.attackMode = attackMode;
      director.ctx.weaponsUsed = weaponsUsed;
      director.ctx.pendingPasses = [...weaponsUsed];   // shifted by COMPUTE
      director.ctx.totalPasses = weaponsUsed.length;
      director.ctx.passIndex = 0;
      } // end PC weapon-mode branch
    }

    // Both first-entry and multi-pass re-entry: re-snapshot eligible
    // targets (defeated enemies from pass 1 are excluded automatically by
    // the hp <= 0 filter inside the snapshot helpers) and run the target
    // picker for the next weapon in the queue.
    const eligibleRaw = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, director.ctx.turnSnapshot, { category: "enemy" })
      : snapshotEligibleTargets(director.combat, director.ctx.turnSnapshot, { category: "enemy" });

    // RAW Core p.70 — Covered creatures can't be melee-targeted. Route
    // through `applyAttackRangeGate` so `.excluded` (Vanish overlay
    // etc.) survives the filtering: Covered creatures join the excluded
    // list with reason "Covered" instead of vanishing from the canvas.
    const currentWeaponForRange = director.ctx.pendingPasses?.[0];
    const eligible = applyAttackRangeGate(eligibleRaw, currentWeaponForRange);
    director.ctx.eligibleTargets = eligible;
    if (eligible.length === 0) {
      // Edge case for multi-pass: if pass 1 wiped the targets, the
      // off-hand has nothing to hit. Clear the queue + return through
      // ABORT so the FSM finishes the turn cleanly. Distinguish the
      // "all-Covered" case so the GM knows why melee is blocked.
      const allCovered = isMeleeAttack && eligibleRaw.length > 0 && eligible.length === 0;
      const message = allCovered
        ? "All eligible enemies are Covered — switch to a ranged weapon or pick a different action."
        : isMultiPassReEntry
          ? "No targets remaining for the second attack."
          : "No eligible enemy targets on this scene.";
      ui.notifications?.warn(message);
      director.ctx.pendingPasses = [];
      director.dispatch({ type: isMultiPassReEntry ? INTENTS.ABORT : INTENTS.TARGET_BACK,
        body: { reason: isMultiPassReEntry ? "second pass: no targets left" : "no targets" } });
      return;
    }

    // Title — for multi-pass, show pass number + weapon so the player
    // knows which hand they're aiming. The current weapon is the head of
    // the pendingPasses queue (COMPUTE shifts it after this state).
    // Read the hand label from `weapon.hand` (set by resolveAttackerWeapon)
    // rather than inferring from passIndex — passIndex==1 isn't always
    // "Main Hand" anymore now that two-weapon-off-first exists.
    const currentWeapon = director.ctx.pendingPasses?.[0];
    const totalPasses = director.ctx.totalPasses ?? 1;
    const currentPassNum = (director.ctx.passIndex ?? 0) + 1;
    let titleText;
    let cancelLabel;
    if (totalPasses > 1) {
      const hand = currentWeapon?.hand === "off" ? "Off-Hand" : "Main Hand";
      titleText = `${attacker.name}'s ${currentWeapon?.name ?? "weapon"} — ${hand} (${currentPassNum}/${totalPasses})`;
      // First pass: Cancel returns to DECLARE (action discarded entirely).
      // Pass 2+: pass 1 already resolved; "Cancel" really means "Skip" —
      // make the label honest.
      cancelLabel = isMultiPassReEntry ? "Skip Second Attack" : "Cancel";
    } else {
      titleText = `Pick a target for ${attacker.name}'s Attack`;
      cancelLabel = "Cancel";
    }

    // Pre-populated target check (first pass only). composeAction's
    // bundle already provided pickedTargetUuids for pass 1; skip the
    // picker and feed those straight through. Multi-pass re-entry
    // (pass 2 of two-weapon) always re-prompts because pass 1's
    // targets shouldn't auto-carry over and the player needs to
    // re-decide (per RAW: "both aimed at the same target or different").
    let result;
    if (!isMultiPassReEntry && director.ctx.pickedTargetUuids?.length) {
      log(`TARGET (Attack): using pre-composed targets=${director.ctx.pickedTargetUuids.join(",")}`);
      result = {
        ok: true,
        cancelled: false,
        tokenUuids: [...director.ctx.pickedTargetUuids],
      };
      // Cleared so pass 2 (if any) re-prompts via the picker.
      director.ctx.pickedTargetUuids = null;
    } else {
      result = await requestTargeting({
        director,
        eligible,
        mode: "exact",
        count: 1,
        titleText,
        cancelLabel,
      });
    }
    if (!result.ok) {
      if (isMultiPassReEntry && result.cancelled) {
        // Skip the remaining passes; let CLEANUP → TURN_END finish the
        // turn. ABORTED will route through CLEANUP correctly because the
        // first pass already started combat resolution.
        director.ctx.pendingPasses = [];
        director.ctx.abortReason = "two-weapon: second pass skipped by player";
        director.dispatch({ type: INTENTS.ABORT });
        return;
      }
      director.dispatch({ type: result.cancelled ? INTENTS.TARGET_BACK : INTENTS.ABORT });
      return;
    }
    director.ctx.pickedTargetUuids = [...result.tokenUuids];
    director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: result.tokenUuids } });
  },
};

// ─── COMPUTE ───────────────────────────────────────────────────────────
// Roll accuracy + damage. Build an immutable actionResult.
const Compute = {
  async onEnter(director, { triggerIntent }) {
    const command = director.ctx.declaredCommand;
    const attacker = director.ctx.turnSnapshot;
    // Multi-pass attacks (Two-Weapon Fighting): the SECOND COMPUTE is
    // triggered by CLEANUP→INTERNAL_DONE which has no body. Fall back to
    // the ctx-persisted target UUIDs that TARGET stamped.
    const tokenUuids = (triggerIntent?.body?.targetTokenUuids?.length
      ? triggerIntent.body.targetTokenUuids
      : director.ctx.pickedTargetUuids ?? []);

    if (command === "Guard" || command === "Equipment" || command === "Item") {
      // Guard/Equipment/Item actionResult was already shaped in TARGET —
      // all three are no-roll menu declarations. Pass through to CONFIRM
      // where the card collects the player's pick (cover target /
      // equipment slots / item to use or create).
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    if (command === "Skill" || command === "Spell") {
      // Skill / Spell COMPUTE: roll the Check (if isCheck), compute
      // per-target damage (if type_damage set), per-target affinity
      // routing. Skill effects (on_activate / post_damage) fire in
      // RESOLVE. Both commands share this branch — the actionResult
      // built in TARGET carries `kind: "Skill"` for both, so RESOLVE
      // doesn't need a separate Spell branch either.
      const ar = director.ctx.actionResult;
      const targetSnaps = (director.ctx.eligibleTargets ?? ar.targets ?? [])
        .filter((e) => tokenUuids.includes(e.tokenUuid));
      const allTargets = targetSnaps.length ? targetSnaps : (ar.targets ?? []);

      // Resolve damage_bonus formula now (uses caster's SL / actor state).
      const casterActor = await fromUuid(ar.attackerActorRef).catch(() => null);
      const skill = await fromUuid(ar.skillUuid).catch(() => null);
      const resolver = buildSkillResolver({
        actor: casterActor,
        payload: null,
        skill,
        round: director.dCombat?.round ?? 0,
      });
      const damageBonus = evaluateFormula(ar.damageBonus, resolver, 0);
      const nativeDamageType = String(ar.damageType ?? "").toLowerCase();
      // Resource the damage burns through. Default is HP (regular
      // elemental damage); `mp` routes the same hit/crit pipeline but
      // writes to current_mp instead and skips elemental affinity (no
      // sheet supports "Vulnerable to MP damage"). Heal-style strings
      // ("healing", "recovery", "hp" as a bare type, "") are still
      // excluded from the damage path — those are recipe-driven grants.
      const isMpDamage = nativeDamageType === "mp";
      // Spell-damage element override — applies the caster's
      // override_spell_damage_type (or override_all_damage_type
      // fallback). Only flips for ELEMENTAL damage; MP / heal-style
      // strings ignore the override since they aren't an element. See
      // resolveDamageElementOverride in skill-effects.js.
      const damageType = isMpDamage
        ? nativeDamageType
        : String(resolveDamageElementOverride({
            actor: casterActor,
            scope: "spell",
            native: nativeDamageType,
          }) ?? nativeDamageType).toLowerCase();
      const isElementalDamage = !!damageType
        && !["", "none", "healing", "heal", "hp", "recovery"].includes(damageType)
        && !isMpDamage;
      const hasDamage = isMpDamage || isElementalDamage;
      const damageResource = isMpDamage ? "mp" : "hp";

      let roll = null;
      if (ar.isCheck) {
        const A1 = ar.rolledA1 || "INS";
        const A2 = ar.rolledA2 || "INS";
        const dA = attacker.attributes?.[A1] ?? 8;
        const dB = attacker.attributes?.[A2] ?? 8;
        const checkBonus = ar.checkBonus | 0;
        // Per-source breakdown for the Check tooltip. Skills/Spells get
        // their bonus from `skill.system.props.check_bonus` only — no
        // free-action grant consumer here today (see
        // [[free-action-grant-bonus-consumers]]). When the consumer
        // ships, append the grant entry the same way Attack/Hinder do.
        const checkBonusParts = [];
        if (checkBonus !== 0) {
          checkBonusParts.push({
            source: ar.skillName || "Skill",
            amount: checkBonus,
          });
        }
        const fumbleThr = Math.max(1, attacker.fumbleThreshold ?? 1);
        const rollObj = await new Roll(`1d${dA} + 1d${dB}`).roll();
        const dice = rollObj.dice.map((d) => d.results?.[0]?.result ?? 0);
        const rA = dice[0] ?? 0;
        const rB = dice[1] ?? 0;
        const total = (rA + rB + checkBonus) | 0;
        const hr = Math.max(rA, rB);
        const isFumble = (rA <= fumbleThr && rB <= fumbleThr);
        const isCrit = (rA === rB) && !isFumble && rA >= 6;
        roll = { A1, A2, dA, dB, rA, rB, checkBonus, checkBonusParts, total, hr, isCrit, isFumble, opportunities: isCrit && !isFumble };
      }

      // Defense selection — Spells always vs MDEF (RAW; the 111 live
      // Spell items leave the CSB `defense_target_type` column at its
      // template default of "def", so the column on Spells is unreliable
      // and we ignore it there). Non-Spell skills can opt in to MDEF
      // resolution via `defense_target_type: "mdef"` — needed for
      // Skill-kind opposed Checks that resolve vs Magic Defense per RAW
      // (Soul Steal / Pillage / Draconic Roar / Entangle roll vs MDEF
      // despite being Skill-kind for cost/typing). Mirrors the accuracy
      // widget's Strike-vs-Magic icon choice in action-card.js.
      const isSpell = String(ar.skillType ?? "").toLowerCase() === "spell";
      const dtt = String(ar.defenseTargetType ?? "").toLowerCase();
      const vsMDef = isSpell || dtt === "mdef";
      const pickDefStat = (e) => vsMDef ? (e.magicDefense ?? 0) : (e.defense ?? 0);

      // Encyclopedia studied-gate (mirrors Attack COMPUTE). A player
      // attacker shouldn't see an enemy's MDEF / damage outcome /
      // affinity until the party has Studied them to Identity tier
      // (Study result ≥ 7). The card uses `studied` to mask DEF + the
      // hit/miss verdict + the affinity tag with "???" when the player
      // hasn't earned that knowledge yet. Friendly targets and
      // non-friendly attackers (GM-controlled enemy spells) always
      // pass-through — nothing to hide.
      const skillEncApi = globalThis.FUCompanion?.api?.encyclopedia;
      const TIER_IDENTITY = 7;
      const attackerIsFriendly = (attacker.disposition === 1);
      const checkStudied = (target) => {
        if (!attackerIsFriendly) return true;
        if (target.disposition !== -1) return true;
        if (!skillEncApi?.getPageForActor) return true;
        const candidates = [target.worldActorUuid, target.actorUuid].filter(Boolean);
        for (const uuid of candidates) {
          try {
            const page = skillEncApi.getPageForActor(uuid);
            if (!page) continue;
            const flag = page.getFlag?.("fabula-ultima-companion", "encyclopedia");
            const best = Number(flag?.bestResult ?? 0) || 0;
            if (best >= TIER_IDENTITY) return true;
          } catch (_) { /* try next */ }
        }
        return false;
      };

      // Build per-target rows for any Skill/Spell with a Check (or any
      // damage skill). Status-only offensive spells (Torpor / Hallucination
      // / Enrage — isCheck:true + no type_damage) get the same per-target
      // hit/miss row layout as damage spells, just with damage fields at
      // zero. This is what surfaces "which targets got the status" on the
      // action card.
      const perTargetResults = [];
      if (hasDamage || ar.isCheck) {
        const effectiveHr = roll?.isFumble ? 0 : (roll?.hr ?? 0);
        for (const e of allTargets) {
          // Skills without isCheck always hit. Skills with isCheck resolve
          // hit vs DEF / MDEF — see vsMDef derivation above.
          const defStat = pickDefStat(e);
          let hit = !roll;
          if (roll) {
            if (roll.isFumble) hit = false;
            else if (roll.isCrit) hit = true;
            else hit = roll.total >= defStat;
          }
          const rawDamage = (hasDamage && hit) ? (effectiveHr + damageBonus) : 0;
          // MP damage skips elemental affinity (no sheet declares
          // "Vulnerable to MP damage"); everything resolves as NE.
          // Status-only Checks also use NE since there's no damage
          // type to route through affinity.
          const affinityCode = (!hasDamage)
            ? "NE"
            : isMpDamage
              ? "NE"
              : (e.affinities?.[damageType] ?? "NE");
          const damage = (hasDamage && hit) ? applyAffinityToDamage(rawDamage, affinityCode) : 0;
          perTargetResults.push({
            tokenUuid: e.tokenUuid,
            actorUuid: e.actorUuid,
            name: e.name,
            tokenImg: e.tokenImg,
            disposition: e.disposition,
            defense: defStat,
            hit,
            crit: !!roll?.isCrit && hit,
            rawDamage,
            damage,
            affinity: affinityCode,
            // Per-row resource hint so the action card's per-target
            // label can read "12 MP" instead of "12 dmg" for MP-burn
            // skills. Matches `ar.damageResource` upstream.
            resource: damageResource,
            // Studied gate — masks MDEF / hit / damage / affinity from
            // the player attacker's view when the target hasn't been
            // Studied to Identity tier yet. Same rule the Attack
            // pipeline already uses.
            studied: checkStudied(e),
          });
        }
      }

      const effectiveHr = roll?.isFumble ? 0 : (roll?.hr ?? 0);
      const damageObj = hasDamage
        ? {
            base: damageBonus,
            element: damageType,
            // Mark the card so the Damage panel can label it correctly
            // ("MP" instead of an element name) and skip the +HR pill
            // logic appropriately for MP-burn skills.
            resource: damageResource,
            ignoreHR: !roll,
            finalIfHit: effectiveHr + damageBonus,
          }
        : null;

      // Hit-list for the chain ctx. Damage spells populate perTargetResults
      // with hit/miss above and we derive from that. Status-only Check
      // spells (Torpor / Hallucination / Enrage — offensive Spiritist
      // spells with no `type_damage`) need the same Check resolved
      // separately so `target_ref: "hit_action_targets"` in their
      // effect_table can filter apply_ae to only HIT targets per RAW
      // ("each target hit by this spell"). No-Check skills (Heal,
      // Reinforce, Cleanse) → all targets count as hit.
      let hitTokenUuids;
      if (!ar.isCheck) {
        hitTokenUuids = allTargets.map((e) => e.tokenUuid);
      } else if (hasDamage) {
        hitTokenUuids = perTargetResults.filter((r) => r.hit).map((r) => r.tokenUuid);
      } else {
        hitTokenUuids = [];
        for (const e of allTargets) {
          const defStat = pickDefStat(e);
          let hit = false;
          if (roll) {
            if (roll.isFumble) hit = false;
            else if (roll.isCrit) hit = true;
            else hit = roll.total >= defStat;
          }
          if (hit) hitTokenUuids.push(e.tokenUuid);
        }
      }

      // Heal / grant preview — for skills using the recipe sugar
      // (`recipe: heal_target` etc.) where the COMPUTE branch above
      // doesn't fire because there's no elemental/MP damage. We mirror
      // damage's per-target row + preview-panel UX so the player sees
      // exactly how much each target will recover.
      let healingObj = null;
      if (!hasDamage) {
        const view = getRuntimeSkillView(skill);
        // Find the first grant row in the runtime view (recipe-synthesized
        // OR author-authored on_activate_effect_ref).
        let grantRow = null;
        const fireLabel = String(view?.fire_points?.on_activate_effect_ref ?? "").trim();
        const tbl = view?.effect_table ?? {};
        for (const k of Object.keys(tbl)) {
          const row = tbl[k];
          if (!row || row.$deleted) continue;
          if (row.effect_kind !== "grant") continue;
          // Prefer the row referenced by on_activate; else first grant.
          if (fireLabel && row.effect_label === fireLabel) { grantRow = row; break; }
          if (!grantRow) grantRow = row;
        }
        if (grantRow) {
          const grantResource = String(grantRow.grant_resource ?? "").toLowerCase();
          const grantAmount = evaluateFormula(grantRow.grant_amount, resolver, 0);
          if (grantAmount > 0 && ["hp", "mp"].includes(grantResource)) {
            // Build per-target rows for each action target. No Check, no
            // affinity — every target receives the same amount (clamped
            // at write time by max-resource).
            for (const e of allTargets) {
              const tActor = await fromUuid(e.actorUuid).catch(() => null);
              const cur = Number(tActor?.system?.props?.[grantResource === "mp" ? "current_mp" : "current_hp"] ?? 0) || 0;
              const max = Number(tActor?.system?.props?.[grantResource === "mp" ? "max_mp" : "max_hp"] ?? 0) || 0;
              // Vismagus self-heal suppression: RAW Spiritist p.182 —
              // "you instead recover no HP" when the caster paid HP for
              // a healing spell. Mirrors RESOLVE's `continue` skip
              // (state-handlers.js:343) at the display layer so the
              // card doesn't lie about heal landing on the caster.
              const isCasterSelf = e.actorUuid === ar.attackerActorRef;
              const vismagusSuppress =
                !!ar.vismagusHpPaid && isCasterSelf && grantResource === "hp";
              perTargetResults.push({
                tokenUuid: e.tokenUuid,
                actorUuid: e.actorUuid,
                name: e.name,
                tokenImg: e.tokenImg,
                disposition: e.disposition,
                defense: 0,
                hit: true,
                crit: false,
                grantAmount: vismagusSuppress ? 0 : grantAmount,
                grantResource,
                resourceCur: cur,
                resourceMax: max,
                affinity: "NE",
                studied: true,
                vismagusSuppressed: vismagusSuppress || undefined,
              });
            }
            // Damage-shaped object so the card's existing damage preview
            // panel renders correctly. `declaresHealing: true` flips the
            // label to "Heal" + tooltip wording. Color is decided by
            // the panel — green for HP, blue for MP.
            healingObj = {
              base: grantAmount,
              element: grantResource === "mp" ? "mp" : "healing",
              resource: grantResource,
              ignoreHR: true,
              finalIfHit: grantAmount,
              declaresHealing: grantResource === "hp",
              isHealing: true,
            };
          }
        }
      }

      director.ctx.actionResult = freezeActionResult({
        ...ar,
        roll,
        damageComputed: damageBonus,
        damage: damageObj ?? healingObj,
        hasDamage,
        hasHealing: !!healingObj,
        damageResource,
        perTargetResults,
        hitTokenUuids,
        targets: allTargets,
      });
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    if (command === "Attack") {
      // Pop the next weapon to roll for from the ctx queue. The queue was
      // set up in TARGET. For single-weapon attacks there's one entry; for
      // two-weapon there are two and CLEANUP loops back here for the
      // second pass.
      //
      // RAW Core p.69 — two-weapon HR=0 for BOTH passes.
      const queue = director.ctx.pendingPasses ?? [attacker.weapon];
      const weapon = queue.shift();
      if (!weapon) {
        ui.notifications?.warn(`${attacker.name} has no usable weapon.`);
        warn("COMPUTE Attack: no weapon in queue", attacker.name);
        director.enqueue({ type: INTENTS.ABORT });
        return;
      }
      // Both two-weapon variants (main-first + off-first) trigger HR=0.
      const isTwoWeapon = String(director.ctx.attackMode ?? "").startsWith("two-weapon");
      director.ctx.pendingPasses = queue;          // keep mutated remainder for CLEANUP branch
      director.ctx.currentWeapon = weapon;
      director.ctx.passIndex = (director.ctx.passIndex ?? 0) + 1;
      const fumbleThr = Math.max(1, attacker.fumbleThreshold ?? 1);

      // Encyclopedia studied-check: a player attacker shouldn't see an
      // enemy's DEF / MDEF until the party has Studied them to Identity tier
      // (Study result ≥ 7). The card uses `studied` to decide whether to
      // mask the DEF number with "???".
      // Reads the live JournalEntryPage flag via the encyclopedia API;
      // falls back to "studied=true" for friendly targets (no masking) and
      // for any lookup error.
      const encApi = globalThis.FUCompanion?.api?.encyclopedia;
      const TIER_IDENTITY = 7;
      const attackerIsFriendly = (attacker.disposition === 1);
      const checkStudied = (target) => {
        if (!attackerIsFriendly) return true;
        if (target.disposition !== -1) return true;
        if (!encApi?.getPageForActor) return true;
        const candidates = [target.worldActorUuid, target.actorUuid].filter(Boolean);
        for (const uuid of candidates) {
          try {
            const page = encApi.getPageForActor(uuid);
            if (!page) continue;
            const flag = page.getFlag?.("fabula-ultima-companion", "encyclopedia");
            const best = Number(flag?.bestResult ?? 0) || 0;
            if (best >= TIER_IDENTITY) return true;
          } catch (_) { /* try next */ }
        }
        return false;
      };

      // Per-target hit/damage resolution. Base damage = HR + weapon damageBonus
      // on hit, then the target's affinity to the weapon's damage type
      // mutates it: VU 2x, RS 0.5x (ceil), IM 0, AB heals instead of damages.
      // Status-forced VU (Wet+bolt, Oil+fire, Petrify+earth, Hypothermia+ice,
      // Turbulence+air, Zombie+light) overrides the sheet affinity. Mirrors
      // legacy AdvanceDamage line 588-597.
      const FORCED_VU_BY_STATUS = {
        Wet: "bolt", Oil: "fire", Petrify: "earth",
        Hypothermia: "ice", Turbulence: "air", Zombie: "light",
      };
      // Defend against eligibleTargets being null (shouldn't happen on the
      // first pass since TARGET sets it; the multi-pass loop preserves it
      // in CLEANUP, but defend anyway).
      const targetSnapshots = (director.ctx.eligibleTargets ?? [])
        .filter((e) => tokenUuids.includes(e.tokenUuid));
      if (targetSnapshots.length === 0 && tokenUuids.length > 0) {
        warn("COMPUTE Attack: tokenUuids provided but no matches in eligibleTargets",
             { tokenUuids, eligibleCount: (director.ctx.eligibleTargets ?? []).length });
      }

      // Single-pass roll for the weapon we just shifted from the queue.
      const dA = attacker.attributes?.[weapon.A1] ?? 8;
      const dB = attacker.attributes?.[weapon.A2] ?? 8;
      let checkBonus = weapon.checkBonus ?? 0;
      let damageBonus = weapon.damageBonus ?? 0;
      // Per-source breakdown — surfaced in the action-card Check tooltip
      // so the player sees WHERE each +N came from. Weapon contribution
      // is `weapon.checkBonus` which already aggregates the actor's
      // bonus_accuracy_check / attack_accuracy_mod_* AEs via CSB's
      // derived stat (so a future per-AE breakdown would need to walk
      // the actor's AE list — out of scope here; we surface "Weapon"
      // as the umbrella).
      const checkBonusParts = [];
      if (Number(weapon.checkBonus) !== 0) {
        checkBonusParts.push({ source: weapon.name || "Weapon", amount: Number(weapon.checkBonus) || 0 });
      }
      // Free-action grant — read + consume. Adds the grant's check /
      // damage bonus to this attack's roll. The clear-on-consume here
      // (rather than on RESOLVE success) means a CONFIRM cancel still
      // consumes the grant, matching the user's commitment-on-pick
      // model: once they posted the action card, the free action was
      // used. Use case driver: High Speed's "perform a free attack with
      // +SL bonus". See [[free-actions]].
      const attackerActorIdForGrant = attacker?.actorId ?? null;
      const attackGrant = attackerActorIdForGrant ? freeActions.get(attackerActorIdForGrant) : null;
      if (attackGrant) {
        const grantCb = Number(attackGrant.checkBonus) || 0;
        const grantDb = Number(attackGrant.damageBonus) || 0;
        checkBonus += grantCb;
        damageBonus += grantDb;
        if (grantCb !== 0) {
          checkBonusParts.push({
            source: attackGrant.sourceLabel || "Free Action",
            amount: grantCb,
          });
        }
        log(`Attack COMPUTE: applied ${attackGrant.sourceLabel} grant (+${attackGrant.checkBonus ?? 0} check / +${attackGrant.damageBonus ?? 0} dmg)`);
        freeActions.clear(attackerActorIdForGrant);
      }

      // V12+: Roll#evaluate is always async; the legacy `{async: true}`
      // option emits a compat warning. Just await the roll directly.
      const rollObj = await new Roll(`1d${dA} + 1d${dB}`).roll();
      const dice = rollObj.dice.map((d) => d.results?.[0]?.result ?? 0);
      const rA = dice[0] ?? 0;
      const rB = dice[1] ?? 0;
      const total = (rA + rB + checkBonus) | 0;
      const hr = Math.max(rA, rB);
      const isFumble = (rA <= fumbleThr && rB <= fumbleThr);
      const isCrit = (rA === rB) && !isFumble && rA >= 6;
      // Two-Weapon Fighting: HR=0 for both passes (RAW Core p.69).
      const ignoreHR = isTwoWeapon;
      const effectiveHr = ignoreHR ? 0 : hr;
      // Damage-element override (3 scopes; see
      // resolveDamageElementOverride in skill-effects.js):
      //   override_attack_damage_type → applies here (attack scope)
      //   override_all_damage_type    → fallback catch-all
      //   weapon.damageType           → native, lowest priority
      // Soul Weapon writes the attack-scope key; future class traits
      // can write the all-scope key. Spell damage uses scope="spell"
      // separately in the Skill COMPUTE branch.
      const liveAttacker = await fromUuid(attacker.actorUuid).catch(() => null);
      const overriddenElement = resolveDamageElementOverride({
        actor: liveAttacker,
        scope: "attack",
        native: weapon.damageType,
      });
      const elementKey = String(overriddenElement ?? "Physical").toLowerCase();

      const perTargetResults = [];
      for (const e of targetSnapshots) {
        let hit = false;
        let rawDamage = 0;
        if (isFumble) {
          hit = false;
        } else if (isCrit) {
          hit = true;
          rawDamage = effectiveHr + damageBonus;
        } else if (total >= e.defense) {
          hit = true;
          rawDamage = effectiveHr + damageBonus;
        }

        // Effective affinity = sheet value + forced-VU from active conditions.
        let affinityCode = e.affinities?.[elementKey] ?? "NE";
        for (const cond of (e.conditions ?? [])) {
          if (FORCED_VU_BY_STATUS[cond] === elementKey) { affinityCode = "VU"; break; }
        }
        // Guard (RAW Core p.70): the guarder gains Resistance to ALL damage
        // types "regardless of their source". IM and AB still trump — those
        // are inherent traits, Guard is a temporary action. Everything else
        // (sheet RS/VU/NE + forced-VU) collapses to RS while Guard is up.
        if ((e.conditions ?? []).includes("Guard") && affinityCode !== "IM" && affinityCode !== "AB") {
          affinityCode = "RS";
        }

        const damage = hit ? applyAffinityToDamage(rawDamage, affinityCode) : 0;

        perTargetResults.push({
          tokenUuid: e.tokenUuid,
          actorUuid: e.actorUuid,
          name: e.name,
          tokenImg: e.tokenImg,
          disposition: e.disposition,
          defense: e.defense,
          hit,
          crit: isCrit && hit,
          rawDamage,
          damage,
          affinity: affinityCode,
          studied: checkStudied(e),
        });
      }

      director.ctx.actionResult = freezeActionResult({
        kind: "Attack",
        attacker,
        attackerActorRef: attacker.actorUuid,
        weapon,
        attackMode: director.ctx.attackMode ?? "main",
        passIndex: director.ctx.passIndex,
        totalPasses: director.ctx.totalPasses,
        targets: targetSnapshots,
        roll: {
          A1: weapon.A1, A2: weapon.A2,
          dA, dB, rA, rB, checkBonus, checkBonusParts, total, hr,
          isCrit, isFumble,
          // Crit generates Opportunities (RAW Core p.68). Visual only here;
          // mechanical handling is GM-narrated for v1.
          opportunities: isCrit && !isFumble,
        },
        damage: {
          base: damageBonus,
          // Use the overridden element (set by Spiritist Soul Weapon and
          // any future damage-type override AE) instead of the weapon's
          // raw type — so the action card label + affinity routing on
          // the per-target rows agree. Falls through to the weapon's
          // native type when no override is active.
          element: overriddenElement ?? weapon.damageType,
          ignoreHR,
          finalIfHit: effectiveHr + damageBonus,
        },
        perTargetResults,
        // Free-action grant audit — when High Speed (or any other grant
        // source) bakes a bonus into this attack, stamp the source label
        // + bonus amounts on the ar for card display + rewind history.
        ...(attackGrant ? { freeActionGrant: { sourceLabel: attackGrant.sourceLabel, checkBonus: attackGrant.checkBonus ?? 0, damageBonus: attackGrant.damageBonus ?? 0 } } : {}),
      });
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    if (command === "Hinder") {
      // Check vs DL set by the GM (default 10 per RAW Core p.71). The GM
      // also chose the attribute pair via the pickAttributePair prompt in
      // TARGET — ctx.hinderCheckConfig carries those choices. If TARGET
      // somehow skipped the picker (manual ABORT recovery, etc.) we fall
      // back to the RAW defaults so nothing crashes.
      const targetUuid = tokenUuids[0];
      const targetSnap = (director.ctx.eligibleTargets ?? []).find((e) => e.tokenUuid === targetUuid);
      if (!targetSnap) {
        warn("COMPUTE Hinder: target not found in eligibleTargets", targetUuid);
        director.enqueue({ type: INTENTS.ABORT });
        return;
      }

      const cfg = director.ctx.hinderCheckConfig ?? {};
      const A1 = cfg.A1 ?? "DEX";
      const A2 = cfg.A2 ?? "INS";
      const DL = Math.max(1, Number(cfg.dl) || 10);
      const dA = attacker.attributes?.[A1] ?? 8;
      const dB = attacker.attributes?.[A2] ?? 8;
      const fumbleThr = Math.max(1, attacker.fumbleThreshold ?? 1);

      // Free-action grant — add checkBonus to Hinder's roll if a grant
      // is pending and the player elected Hinder. damageBonus n/a (no
      // damage stage for Hinder). Same consume-on-pick semantics as
      // Attack.
      const hinderActorIdForGrant = attacker?.actorId ?? null;
      const hinderGrant = hinderActorIdForGrant ? freeActions.get(hinderActorIdForGrant) : null;
      const hinderCheckBonus = hinderGrant ? Number(hinderGrant.checkBonus) || 0 : 0;
      const hinderCheckBonusParts = [];
      if (hinderGrant && hinderCheckBonus !== 0) {
        hinderCheckBonusParts.push({
          source: hinderGrant.sourceLabel || "Free Action",
          amount: hinderCheckBonus,
        });
      }
      if (hinderGrant) {
        log(`Hinder COMPUTE: applied ${hinderGrant.sourceLabel} grant (+${hinderGrant.checkBonus ?? 0} check)`);
        freeActions.clear(hinderActorIdForGrant);
      }

      const rollObj = await new Roll(`1d${dA} + 1d${dB}`).roll();
      const dice = rollObj.dice.map((d) => d.results?.[0]?.result ?? 0);
      const rA = dice[0] ?? 0;
      const rB = dice[1] ?? 0;
      const total = (rA + rB + hinderCheckBonus) | 0;
      const hr = Math.max(rA, rB);
      const isFumble = (rA <= fumbleThr && rB <= fumbleThr);
      const isCrit = (rA === rB) && !isFumble && rA >= 6;
      // Success: crit always succeeds, fumble always fails, otherwise vs DL.
      const success = isCrit ? true : isFumble ? false : (total >= DL);

      director.ctx.actionResult = freezeActionResult({
        kind: "Hinder",
        attacker,
        attackerActorRef: attacker.actorUuid,
        target: targetSnap,
        targets: [targetSnap],
        roll: {
          A1, A2,
          dA, dB, rA, rB, checkBonus: hinderCheckBonus, checkBonusParts: hinderCheckBonusParts, total, hr,
          isCrit, isFumble,
          opportunities: isCrit && !isFumble,
        },
        dl: DL,
        success,
        // statusValue is filled in by the card click (one of dazed /
        // shaken / slow / weak) before RESOLVE runs. See Confirm.onEnter.
        statusValue: null,
        ...(hinderGrant ? { freeActionGrant: { sourceLabel: hinderGrant.sourceLabel, checkBonus: hinderGrant.checkBonus ?? 0, damageBonus: 0 } } : {}),
      });
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    if (command === "Study") {
      // Open Check (RAW Core p.46-47): roll the attribute pair, no defense
      // comparison. INS+INS is the default for Study; situational variants
      // like INS+WLP for inquiry are a future picker — v1 hardcodes INS+INS.
      // The total maps to encyclopedia tiers (Identity ≥7 / Stats ≥8 /
      // Details ≥13, per `scripts/encyclopedia/encyclopedia-core.js`).
      const targetUuid = tokenUuids[0];
      const targetSnap = (director.ctx.eligibleTargets ?? []).find((e) => e.tokenUuid === targetUuid);
      if (!targetSnap) {
        warn("COMPUTE Study: target not found in eligibleTargets", targetUuid);
        director.enqueue({ type: INTENTS.ABORT });
        return;
      }

      const dA = attacker.attributes?.INS ?? 8;
      const dB = attacker.attributes?.INS ?? 8;
      const fumbleThr = Math.max(1, attacker.fumbleThreshold ?? 1);

      const rollObj = await new Roll(`1d${dA} + 1d${dB}`).roll();
      const dice = rollObj.dice.map((d) => d.results?.[0]?.result ?? 0);
      const rA = dice[0] ?? 0;
      const rB = dice[1] ?? 0;
      const total = (rA + rB) | 0;
      const hr = Math.max(rA, rB);
      const isFumble = (rA <= fumbleThr && rB <= fumbleThr);
      const isCrit = (rA === rB) && !isFumble && rA >= 6;

      // Encyclopedia tier classification — labels and thresholds come from
      // [[reference_game_flow_map]] / encyclopedia-core.js, NOT from RAW's
      // Basic/Complete/Detailed/Encyclopedic. The journal page is what
      // actually surfaces the reveal; using its names keeps the card and
      // the page in sync.
      let tierName = "None";
      let tierThreshold = 0;
      if (total >= 13)      { tierName = "Details";  tierThreshold = 13; }
      else if (total >= 8)  { tierName = "Stats";    tierThreshold = 8;  }
      else if (total >= 7)  { tierName = "Identity"; tierThreshold = 7;  }
      const tierFumble = isFumble;

      // Look up the current best result for the target so the card can
      // tell the player whether this Study improved on what's known.
      const encApi = globalThis.FUCompanion?.api?.encyclopedia;
      let previousBest = 0;
      if (encApi?.getPageForActor) {
        const candidates = [targetSnap.worldActorUuid, targetSnap.actorUuid].filter(Boolean);
        for (const uuid of candidates) {
          try {
            const page = encApi.getPageForActor(uuid);
            if (!page) continue;
            const flag = page.getFlag?.("fabula-ultima-companion", "encyclopedia");
            const best = Number(flag?.bestResult ?? 0) || 0;
            if (best > previousBest) previousBest = best;
          } catch (_) { /* try next candidate */ }
        }
      }

      director.ctx.actionResult = freezeActionResult({
        kind: "Study",
        attacker,
        attackerActorRef: attacker.actorUuid,
        target: targetSnap,
        targets: [targetSnap],
        roll: {
          A1: "INS", A2: "INS",
          dA, dB, rA, rB, checkBonus: 0, total, hr,
          isCrit, isFumble,
          opportunities: isCrit && !isFumble,
        },
        tier: {
          name: tierName,
          threshold: tierThreshold,
          fumbled: tierFumble,
        },
        previousBest,
        improved: !isFumble && total > previousBest,
      });
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Unknown command — shouldn't happen if TARGET filtered correctly.
    warn("COMPUTE: unknown command", command);
    director.enqueue({ type: INTENTS.ABORT });
  },
};

// ─── CONFIRM ───────────────────────────────────────────────────────────
const Confirm = {
  async onEnter(director) {
    const ar = director.ctx.actionResult;
    if (!ar) {
      warn("CONFIRM with no actionResult");
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Resolve the attacker actor for the chat speaker
    let attackerActor = null;
    try { attackerActor = await fromUuid(ar.attackerActorRef ?? ar.attacker.actorUuid); } catch {}

    // Persistence checkpoint — "Action Posted / Card Live".
    //
    // Two reasons we save here for ALL kinds (not just Skill):
    //   1. Rewind: this is the no-go-back point for reactable cards
    //      (Attack/Skill/Spell) — once visible, passive reactions can
    //      fire (Phase F+). The label "{Name} · {kind} posted" lets the
    //      GM jump back here before the card was committed.
    //   2. Reload survival: stamps `pendingAction` (actionResult + a
    //      slim ctx subset) on the survival flag so an F5 mid-card
    //      lands the GM back on the SAME card via resumeFromSavedState
    //      → transitionTo(CONFIRM), instead of dumping them back at the
    //      action picker. Cleared the moment the card resolves below.
    //
    // When we re-entered CONFIRM via resumeFromSavedState, the survival
    // flag already holds the exact same payload from the pre-reload
    // save. Re-saving would duplicate the rewind history entry, so the
    // resume path sets a one-shot flag and we skip the save.
    if (director.ctx._resumedFromPendingAction) {
      delete director.ctx._resumedFromPendingAction;
    } else {
      const dc = director.dCombat;
      const passTag = (ar.totalPasses ?? 1) > 1
        ? ` (pass ${ar.passIndex}/${ar.totalPasses})`
        : "";
      const verbForKind = ar.kind === "Skill" ? "cast" : "posted";
      const kindLabel = ar.kind === "Skill"
        ? (ar.skillName ?? "Skill")
        : ar.kind;
      const cnfPhase = rewindPhaseLabel(director.ctx, dc?.round);
      saveDirectorState(director, {
        label: `${cnfPhase} · ${ar.attacker?.name ?? "?"} · ${kindLabel} ${verbForKind}${passTag}`,
        description: describeActionForRewind(ar),
        pendingAction: {
          actionResult: ar,
          // Slim ctx subset — only the fields downstream handlers
          // (RESOLVE / CLEANUP / next-pass COMPUTE) need to behave
          // identically to the un-reloaded path. We exclude
          // eligibleTargets (re-derived) and turnSnapshot (resume
          // re-derives via dCombat.current).
          ctx: {
            passIndex: director.ctx.passIndex ?? 0,
            totalPasses: director.ctx.totalPasses ?? 0,
            attackMode: director.ctx.attackMode ?? null,
            pendingPasses: director.ctx.pendingPasses ?? null,
            pickedTargetUuids: director.ctx.pickedTargetUuids ?? null,
            currentWeapon: director.ctx.currentWeapon ?? null,
            hinderCheckConfig: director.ctx.hinderCheckConfig ?? null,
            declaredCommand: director.ctx.declaredCommand ?? null,
          },
        },
      }).catch((e) => warn("CONFIRM: saveDirectorState failed", e));

      // Action namecard — JRPG title banner for the freshly-posted action.
      // Fire-and-forget so the ~2s banner plays alongside the action card
      // rather than blocking the FSM. Only on the first pass: a multi-pass
      // action (e.g. double attack) re-enters CONFIRM per pass, and we want
      // one banner per declared action, not one per pass. Lives inside this
      // `else` (the fresh-post path) so an F5-resume into CONFIRM
      // (_resumedFromPendingAction) does NOT re-fire a banner that already
      // played pre-reload. See director-vfx.js for the port rationale.
      if ((ar.passIndex ?? 1) <= 1) {
        playActionNamecard(ar).catch((e) => warn("CONFIRM: playActionNamecard threw", e));
      }
    }

    // Pre-resolve passive evaluation — "during action card" reactions
    // that manipulate the active action's values (Healing Power,
    // Support Magic, etc.). Each candidate gets a pill on the action
    // card so the player can opt in/out BEFORE Confirm. The decisions
    // are stashed in actionResult.acceptedPrePassives, and RESOLVE
    // applies them via firePreAcceptedCandidate. The post-resolve
    // `creature_completes_spell` dispatcher at line ~387 then skips
    // any candidate already evaluated here (no double-fire).
    //
    // Currently scoped to Spell-type actions whose trigger matches
    // `creature_completes_spell` (the only canonically pre-resolve
    // trigger in the system today). The classification should grow to
    // a trigger-phase registry as more pre-resolve triggers land
    // (caster_short_on_mp is already pre-resolve via the cost gate;
    // start_of_turn etc. are standalone, no card).
    let prePassives = [];

    // Spell-side dispatch — creature_completes_spell. Action-level (not
    // per-target). Healing Power + Support Magic chain off this.
    if (ar.kind === "Skill" && ar.skillType?.toLowerCase() === "spell" && attackerActor) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        prePassives = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_completes_spell",
          payload: {
            spellUuid: ar.skillUuid ?? null,
            spellName: ar.skillName ?? null,
            targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
            hitTargetTokenUuids: Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : (ar.targets ?? []).map((t) => t.tokenUuid),
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            sourceActorUuid: ar.attackerActorRef,
            actionIntent: ar.actionIntent,
          },
        });
      } catch (e) {
        warn("CONFIRM: findPassiveCandidates threw", e);
      }
    }

    // Phase 3: creature_will_deal_damage — single-fire-per-action,
    // pre-resolve base-damage modification hook. Fires for Attack-kind
    // and damage-dealing Skill-kind (isOffensive + hasDamage).
    //
    // RAW rule (per playtest 2026-05-31): a single action triggers a
    // reaction at most ONCE, even if it hits N targets. The reaction's
    // EFFECT can vary per-target (e.g. Cheap Shot's +5 damage only on
    // targets with ≥2 statuses), but the OFFER is once. We evaluate the
    // row's gates per-target during matching (filters can be per-target
    // — damage_type, condition_formula referencing TARGET_STATUS_COUNT,
    // etc.) and AGGREGATE the candidates by (rowKey, carrierUuid). Each
    // aggregated candidate carries `appliesToTargetUuids` listing every
    // target for which the row matched; the sender-side accumulator
    // iterates that list on apply.
    const fireWillDealDamage =
      attackerActor &&
      Array.isArray(ar.perTargetResults) &&
      (ar.kind === "Attack" || (ar.kind === "Skill" && ar.hasDamage));
    if (fireWillDealDamage) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
        const hitTargetUuids = ar.perTargetResults
          .filter((r) => r?.hit)
          .map((r) => {
            if (r?.tokenUuid) return r.tokenUuid;
            const matchedTarget = (ar.targets ?? []).find((t) => t?.actorUuid === r?.actorUuid);
            return matchedTarget?.tokenUuid ?? null;
          })
          .filter(Boolean);

        // Aggregate per (rowKey, carrierUuid). Per-target matchers may
        // accept the row for some targets and reject for others — the
        // pill surfaces if ANY target matched.
        const byKey = new Map();
        for (let i = 0; i < ar.perTargetResults.length; i++) {
          const entry = ar.perTargetResults[i];
          if (!entry?.hit) continue;  // misses never reach the damage stage
          const subjectActorUuid = entry.actorUuid;
          if (!subjectActorUuid) continue;
          const matchedTarget = (ar.targets ?? []).find((t) => t?.actorUuid === subjectActorUuid);
          const subjectTokenUuid = entry.tokenUuid ?? matchedTarget?.tokenUuid ?? null;

          const payloadForTrigger = {
            subjectActorUuid,
            subjectTokenUuid,
            targets: allTargetUuids,
            hitTargets: hitTargetUuids,
            rawDamage: entry.rawDamage,
            damageType: ar.damageType ?? ar.damage?.element ?? null,
            weaponType: ar.weapon?.weaponType ?? null,
            affinity: entry.affinity,
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            sourceActorUuid: ar.attackerActorRef,
            actionIntent: ar.actionIntent,
            targetTokenUuids: allTargetUuids,
            hitTargetTokenUuids: hitTargetUuids,
          };

          let cands;
          try {
            cands = await findPassiveCandidates({
              casterActor: attackerActor,
              trigger: "creature_will_deal_damage",
              payload: payloadForTrigger,
            });
          } catch (e) {
            warn(`CONFIRM: will_deal_damage findPassiveCandidates threw for ${entry?.name}`, e);
            continue;
          }
          for (const cand of cands ?? []) {
            const key = `${cand.rowKey}::${cand.carrierUuid}`;
            let agg = byKey.get(key);
            if (!agg) {
              // First match — keep this candidate as the aggregate.
              // payloadAtFire references the FIRST matching target's
              // payload; action-level fields (damageType, hitTargets,
              // damage_amount formula context) are identical across
              // targets, so first-target is a safe reference for the
              // accumulator's formula resolver.
              agg = {
                ...cand,
                appliesToTargetUuids: [],
                appliesToTokenUuids: [],
                payloadAtFire: payloadForTrigger,
              };
              byKey.set(key, agg);
            }
            agg.appliesToTargetUuids.push(subjectActorUuid);
            if (subjectTokenUuid) agg.appliesToTokenUuids.push(subjectTokenUuid);
          }
        }
        for (const cand of byKey.values()) {
          prePassives.push(cand);
        }
      } catch (e) {
        warn("CONFIRM: will_deal_damage dispatch threw", e);
      }
    }

    // Critical-hit cut-in — fire it AS the action card (with the roll result)
    // appears, NOT at RESOLVE. Fire-and-forget so the ~2s cinematic plays
    // alongside the card while the player reads the crit roll and confirms.
    // No-ops unless ar.roll.isCrit; the renderer skips silently if the
    // attacker has no cut_in_critical art. Per pass: each pass shows its own
    // card + roll, so a crit on any pass still gets its cinematic.
    playCritCutin(ar);

    const result = await postActionCard({
      director,
      kind: ar.kind,
      payload: {
        attacker: ar.attacker,
        attackerActor,
        weapon: ar.weapon,
        targets: ar.targets,
        roll: ar.roll,
        damage: ar.damage,
        perTargetResults: ar.perTargetResults,
        attackMode: ar.attackMode,
        passIndex: ar.passIndex,
        totalPasses: ar.totalPasses,
        prePassives,
        // Guard-specific:
        coverTarget: ar.coverTarget,
        // Study-specific:
        target: ar.target,
        tier: ar.tier,
        previousBest: ar.previousBest,
        improved: ar.improved,
        // Hinder-specific:
        dl: ar.dl,
        success: ar.success,
        // Item-specific:
        itemCandidates: ar.itemCandidates,
        ip: ar.ip,
        // Skill-specific:
        skillName: ar.skillName,
        skillImg: ar.skillImg,
        skillType: ar.skillType,
        defenseTargetType: ar.defenseTargetType,
        skillRange: ar.skillRange,
        skillTarget: ar.skillTarget,
        damageType: ar.damageType,
        hasDamage: ar.hasDamage,
        hasHealing: ar.hasHealing,
        rawCost: ar.rawCost,
        costSerialized: ar.costSerialized,
        descriptionHtml: ar.descriptionHtml,
      },
    });

    // Hinder's status pick (dazed/shaken/slow/weak) arrives via the card's
    // button click. Merge it back into actionResult so RESOLVE can apply
    // the right AE. actionResult is frozen — re-freeze through a shallow
    // spread that keeps everything else identical.
    if (result.statusValue) {
      director.ctx.actionResult = freezeActionResult({
        ...ar,
        statusValue: result.statusValue,
      });
    }
    // Equipment card collects per-slot dropdowns and ships them as
    // { main, off, accessory1, accessory2 } → null|itemId. Merge so RESOLVE
    // can apply the swap via applyEquipmentSwap.
    if (result.equipmentSelections) {
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        equipmentSelections: result.equipmentSelections,
      });
    }
    // Item card forwards the picked {mode, key, cost} for RESOLVE to
    // turn into a consume / spendIp commit.
    if (result.itemSelection) {
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        itemSelection: result.itemSelection,
      });
    }
    // Pre-resolve passive decisions — only "apply" entries are stamped
    // so RESOLVE can fire them via firePreAcceptedCandidate. The
    // post-resolve creature_completes_spell dispatcher reads the same
    // list to skip already-evaluated candidates (avoid double-fire).
    //
    // Phase 2 (Cheap Shot): after stamping accepted decisions, recompute
    // perTargetResults from any accepted `add_damage` candidates so the
    // damage values RESOLVE applies match what the player chose. The
    // sender-side accumulator sums base-damage bonuses per subject; the
    // recompute reapplies affinity over (rawDamage + bonus). This makes
    // affinity multiply once over the combined total — the user's
    // "base damage, affinity applied once" rule.
    if (Array.isArray(result.reactionDecisions) && result.reactionDecisions.length) {
      const applied = result.reactionDecisions.filter((d) => d?.decision === "apply");
      const evaluated = result.reactionDecisions.map((d) => ({
        carrierUuid: d.carrierUuid,
        rowKey: d.rowKey,
      }));
      // Recompute per-target damage if any add_damage candidates landed.
      // Spell + Attack RESOLVE both read ar.perTargetResults; updating
      // it here is the single point of truth.
      let recomputedPerTargets = ar.perTargetResults ?? null;
      try {
        const { computeSenderDamageBonuses, recomputePerTargetDamages } = await getSkillEffectsExtras();
        const bonusMap = await computeSenderDamageBonuses({
          casterActor: attackerActor,
          acceptedPrePassives: applied,
          dCombat: director.dCombat,
        });
        if (bonusMap.size > 0 && Array.isArray(ar.perTargetResults)) {
          const { applyAffinityToDamage } = await import("./snapshot.js");
          recomputedPerTargets = recomputePerTargetDamages(
            ar.perTargetResults, bonusMap, applyAffinityToDamage,
          );
          log(`CONFIRM: add_damage recompute applied — ${bonusMap.size} subject(s) modified`);
        }
      } catch (e) { warn("CONFIRM: add_damage recompute threw", e); }
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        perTargetResults: recomputedPerTargets,
        acceptedPrePassives: applied,
        evaluatedPrePassives: evaluated,
      });
    }
    // Drop the survival-flag pendingAction the moment the card resolves
    // (confirm or cancel). Without this, an F5 between here and the
    // next FSM save site (RESOLVE for confirm, or TURN_END/TURN_START
    // for cancel) would still see the stale pendingAction and re-spawn
    // the card the GM just decided on. `skipHistory: true` avoids
    // adding a second rewind entry for the same action — the original
    // "card posted" entry stays in history.
    //
    // We AWAIT this clear (rather than fire-and-forget) on purpose:
    // RESOLVE.onEnter saves at its tail with `currentTurnResolved=true`,
    // and we need the clear-save to land first. If both were in flight,
    // the clear (currentTurnResolved=false, pendingAction=null) could
    // overtake RESOLVE's save and overwrite currentTurnResolved=true →
    // an F5 right after would resume into CONFIRM and double-apply
    // already-committed damage when the user re-clicks.
    try {
      await saveDirectorState(director, {
        pendingAction: null,
        skipHistory: true,
      });
    } catch (e) {
      warn("CONFIRM: pendingAction-clear save failed", e);
    }

    director.dispatch({ type: result.confirmed ? INTENTS.CONFIRM_ACTION : INTENTS.CANCEL_ACTION });
  },
};

// ─── RESOLVE ───────────────────────────────────────────────────────────
// Apply damage / AE / etc. directly to live docs. GM-side, serialized by
// dispatch lock.
const Resolve = {
  async onEnter(director) {
    const ar = director.ctx.actionResult;
    if (!ar) {
      warn("RESOLVE with no actionResult");
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // (Critical-hit cut-in now fires in CONFIRM, as the action card with the
    // roll result appears — see Confirm.onEnter. Not replayed here.)

    if (ar.kind === "Attack") {
      // Single-pass damage application. Multi-pass two-weapon attacks
      // loop back through COMPUTE → CONFIRM → RESOLVE per pass via the
      // CLEANUP→COMPUTE branch in the transition table, so each pass
      // resolves on its own card.
      const passLabel = ar.totalPasses > 1 ? ` (pass ${ar.passIndex}/${ar.totalPasses})` : "";
      const hitTokenUuids = [];
      for (const r of (ar.perTargetResults ?? [])) {
        if (!r.hit) { playMissVfx({ tokenUuid: r.tokenUuid }); continue; }
        try {
          const actor = await fromUuid(r.actorUuid);
          if (!actor) { warn("RESOLVE: actor not found", r.actorUuid); continue; }
          // Shared damage path — same helper Skill RESOLVE uses, so any
          // damage-time reaction AE (Mercy + family) fires uniformly
          // regardless of source. Attack is always HP-resource.
          await applyDamageToTarget({
            target: actor,
            damage: r.damage,
            affinity: r.affinity,
            resource: "hp",
            targetName: r.name,
            tokenUuid: r.tokenUuid,
            logSuffix: passLabel,
          });
          hitTokenUuids.push(r.tokenUuid);
        } catch (e) {
          err("RESOLVE: failed to apply damage", r, e);
        }
      }
      // Post-damage passive trigger — fires once per Attack action with
      // the list of hit targets so reactions like Vanish (apply AE to
      // each hit creature) can resolve via target_ref: "hit_action_targets".
      //
      // QUEUED, not fired — runs after the RESOLVE save site so reaction-
      // applied AEs (Vanish AE on the hit target) don't end up in the
      // "After X's Action" rewind snapshot. Without queueing the user
      // needs two rewinds to undo a Vanish that just fired.
      if (hitTokenUuids.length) {
        const attackerActor = await fromUuid(ar.attackerActorRef).catch(() => null);
        if (attackerActor) {
          const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
          queuePostResolveTrigger(director, {
            casterActor: attackerActor,
            trigger: "creature_deals_damage",
            payload: {
              // Belt + suspenders — both naming conventions present so
              // the chain's `hit_action_targets` resolver picks the
              // list up via either path (ctx.hitActionTargetUuids OR
              // ctx.payload.hitTargets).
              targets: allTargetUuids,
              targetTokenUuids: allTargetUuids,
              hitTargets: hitTokenUuids,
              hitTargetTokenUuids: hitTokenUuids,
              actionIntent: ar.actionIntent,
              weaponUuid: ar.weapon?.uuid ?? null,
              sourceActorUuid: ar.attackerActorRef,
              sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            },
          });
        }
      }
    } else if (ar.kind === "Guard") {
      // RAW Core p.70: until the start of the guarder's next turn:
      //   - Guarder gains Resistance to all damage types
      //   - Guarder gains +2 to Opposed Checks
      //   - Optional Cover target cannot be targeted by melee attacks
      // We materialize this as Active Effects (one on the guarder, one on
      // the covered ally if any) so:
      //   1. Other systems can read them (cards, target filters, future AE
      //      manager extensions).
      //   2. The guarder's player sees a status badge on their token.
      //   3. Removal is data-driven (delete the AE → effect's gone).
      //
      // The release point (next-turn-start of the guarder) is owned by
      // TURN_START.onEnter which consults dCombat.activeGuards.
      const att = ar.attacker;
      const cov = ar.coverTarget;
      const round = director.dCombat?.round ?? 0;
      const NS = "fabula-ultima-companion";

      const buildEffectData = ({ name, statusId, iconUrl, role, guarderActorUuid, guarderActorId }) => ({
        name,
        icon: iconUrl,
        origin: guarderActorUuid,
        flags: {
          [NS]: {
            directorGuard: {
              role,                          // "guard" | "covered"
              guarderActorUuid,
              guarderActorId,
              appliedAtRound: round,
            },
          },
          core: { statusId },
        },
        duration: {
          startRound: round,
          startTurn: 0,
        },
        // Cover (role="covered"): declare AE-config target-side block so
        // `applyAttackRangeGate` excludes the covered ally from melee
        // pickers via the same mechanism Vanish uses on the attacker
        // side. Render reason in the picker overlay = this AE's name
        // ("Covered"). Guarder AE (role="guard") carries no targeting
        // block — its mechanical effects (Resistance to all damage,
        // +2 Opposed Check) attach at COMPUTE time, not at target pick.
        // Mode 5 = OVERRIDE (string value, not arithmetic).
        changes: role === "covered"
          ? [{ key: "cannot_be_targeted_by", value: "melee", mode: 5, priority: 0 }]
          : [],
      });

      let guarderEffectId = null;
      let coveredEffectId = null;
      let coveredActorUuid = null;
      let guarderActorId = null;

      try {
        const guarderActor = await fromUuid(att.actorUuid);
        if (!guarderActor) {
          warn("RESOLVE Guard: guarder actor not found", att.actorUuid);
        } else {
          guarderActorId = guarderActor.id;
          const data = buildEffectData({
            name: "Guard",
            statusId: "guard",
            iconUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/shield_oath.png",
            role: "guard",
            guarderActorUuid: att.actorUuid,
            guarderActorId,
          });
          const [created] = await guarderActor.createEmbeddedDocuments("ActiveEffect", [data]);
          guarderEffectId = created?.id ?? null;
          log(`Guard applied to ${att.name} (effect ${guarderEffectId})`);
        }
      } catch (e) {
        warn("RESOLVE Guard: failed to apply Guard AE", e);
      }

      if (cov) {
        try {
          const coveredActor = await fromUuid(cov.actorUuid);
          if (!coveredActor) {
            warn("RESOLVE Guard: covered actor not found", cov.actorUuid);
          } else {
            coveredActorUuid = cov.actorUuid;
            const data = buildEffectData({
              name: "Covered",
              statusId: "covered",
              iconUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/intervene.png",
              role: "covered",
              guarderActorUuid: att.actorUuid,
              guarderActorId,
            });
            const [created] = await coveredActor.createEmbeddedDocuments("ActiveEffect", [data]);
            coveredEffectId = created?.id ?? null;
            log(`Cover applied to ${cov.name} by ${att.name} (effect ${coveredEffectId})`);
          }
        } catch (e) {
          warn("RESOLVE Guard: failed to apply Covered AE", e);
        }
      }

      // Register with dCombat so TURN_START / director.stop can release
      // the AEs at the right time. Skip if dCombat absent (manual fallback
      // path) — AEs still apply, just won't auto-remove.
      if (director.dCombat && guarderActorId) {
        director.dCombat.addActiveGuard({
          guarderActorUuid: att.actorUuid,
          guarderActorId,
          guarderEffectId,
          coveredActorUuid,
          coveredEffectId,
          appliedAtRound: round,
        });
      }
    } else if (ar.kind === "Equipment") {
      // Apply the swap collected from the card's per-slot dropdowns.
      // applyEquipmentSwap mirrors the legacy [Macro] Equipment.js commit
      // logic — actor.system.props.* writes + per-item isEquipped toggles
      // + per-item Active Effect disabled toggles. Order: items, AEs,
      // actor (legacy comment in the source explains why).
      //
      // Player feedback uses ui.notifications (toast) rather than a chat
      // message — the director's policy is to keep the chat log clean and
      // surface action confirmations in-UI. The card's fade-out + the
      // toast together are the "yes, this happened" cue.
      const selections = ar.equipmentSelections ?? null;
      if (!selections) {
        log(`Equipment: no slot selections (card didn't surface dropdowns?), no-op`);
      } else {
        try {
          const targetActor = await fromUuid(ar.attackerActorRef ?? ar.attacker?.actorUuid);
          if (!targetActor) {
            warn("RESOLVE Equipment: actor not found for swap", ar.attackerActorRef);
          } else {
            const result = await applyEquipmentSwap(targetActor, selections);
            if (result?.skipped) {
              log(`Equipment: no changes for ${ar.attacker?.name ?? "?"}`);
            } else {
              log(`Equipment swap committed for ${ar.attacker?.name ?? "?"}: ${result.changes.length} change(s)`);
            }
          }
        } catch (e) {
          warn("RESOLVE Equipment: swap failed", e);
        }
      }
    } else if (ar.kind === "Item") {
      // Debit the chosen resource — quantity for Use, IP for Create.
      // ar.itemSelection = { mode, key, cost } from the card. Look up the
      // candidate in ar.itemCandidates (set in TARGET so we don't re-
      // fetch). Skill execution is deferred to Phase B — for now the
      // toast spells that out explicitly.
      const sel = ar.itemSelection ?? null;
      if (!sel) {
        log(`Item: no selection on actionResult (cancelled or skipped)`);
      } else {
        try {
          const targetActor = await fromUuid(ar.attackerActorRef ?? ar.attacker?.actorUuid);
          if (!targetActor) {
            warn("RESOLVE Item: actor not found", ar.attackerActorRef);
          } else if (sel.mode === "use") {
            const cand = (ar.itemCandidates?.use ?? []).find((c) => c.id === sel.key);
            // Re-fetch the live Item doc here (candidate stripped it to
            // avoid freezeActionResult recursing through Foundry's
            // circular doc refs at CONFIRM time).
            const liveItem = cand?.uuid ? await fromUuid(cand.uuid).catch(() => null) : null;
            if (!cand || !liveItem) {
              warn("RESOLVE Item: use candidate not resolvable", sel.key, cand?.uuid);
            } else {
              const r = await consumeOne(targetActor, liveItem);
              if (r?.ok) {
                log(`Item used: ${cand.name} by ${ar.attacker?.name ?? "?"} (deleted=${!!r.deleted}, after=${r.after})`);
                // Phase B.1 D.5 closure — fire the item's linked
                // active skill(s) via the director-native skill pipeline.
                // The item was the cost, so the skill fires with no MP
                // debit (skipCost=true). Targets default to the user
                // (self) for B.1; cross-actor item use lands in B.2.
                for (const skillUuid of (cand.skillUuids ?? [])) {
                  try {
                    await fireLinkedSkillFromItem({
                      director,
                      casterSnap: ar.attacker,
                      casterActor: targetActor,
                      skillUuid,
                      sourceItemUuid: cand.uuid,
                    });
                  } catch (e) {
                    warn(`RESOLVE Item: linked skill ${skillUuid} threw`, e);
                  }
                }
              } else {
                warn("RESOLVE Item use: consume failed", r);
                ui.notifications?.warn(`Couldn't use ${cand.name}.`);
              }
            }
          } else if (sel.mode === "create") {
            const cand = (ar.itemCandidates?.create ?? []).find((c) => c.key === sel.key);
            if (!cand) {
              warn("RESOLVE Item: create candidate not resolvable", sel.key);
            } else {
              const cost = Number(sel.cost ?? cand.ipCost ?? 0) || 0;
              const r = await spendIp(targetActor, cost);
              if (r?.ok) {
                log(`Item created: ${cand.name} by ${ar.attacker?.name ?? "?"} (-${cost} IP)`);
                const ipSpent = Number(r.spent ?? cost) || 0;
                if (ipSpent > 0) playResourceSpendVfx({ tokenUuid: ar.attacker?.tokenUuid, resource: "ip", amount: ipSpent });
                // D.5 closure — crafted items can also carry an active
                // skill (the recipe casts the item's effect on creation
                // in some classes, e.g. Tinkerer Magisphere "free spell").
                // Fire linked skills with cost-already-paid (the IP was
                // the cost).
                for (const skillUuid of (cand.skillUuids ?? [])) {
                  try {
                    await fireLinkedSkillFromItem({
                      director,
                      casterSnap: ar.attacker,
                      casterActor: targetActor,
                      skillUuid,
                      sourceItemUuid: cand.itemUuid,
                    });
                  } catch (e) {
                    warn(`RESOLVE Item: linked skill ${skillUuid} threw`, e);
                  }
                }
              } else {
                warn("RESOLVE Item create: IP spend failed", r);
                ui.notifications?.warn(`Couldn't create ${cand.name}.`);
              }
            }
          } else {
            warn("RESOLVE Item: unknown mode", sel.mode);
          }
        } catch (e) {
          warn("RESOLVE Item: commit threw", e);
        }
      }
    } else if (ar.kind === "Skill") {
      // Resolve a Skill cast: debit cost → fire on_activate effect →
      // apply damage per target (if any) + fire post_damage per target.
      // Skill effects (apply_ae / grant / consume_charge / chain) run
      // through the director-native effect engine (skill-effects.js).
      await resolveSkillAction(director, ar);
    } else if (ar.kind === "Hinder") {
      // Apply the chosen status AE to the target. The pick (dazed /
      // shaken / slow / weak) was made by the card's button click and
      // merged into actionResult.statusValue by Confirm. On failure or
      // fumble, no AE applies.
      if (!ar.success) {
        log(`Hinder failed against ${ar.target?.name ?? "?"} (roll ${ar.roll?.total ?? "?"} vs DL ${ar.dl})`);
        // Failed opposed check — no status lands. Show the Miss flourish on
        // the target, same as a whiffed attack/spell.
        playMissVfx({ tokenUuid: ar.target?.tokenUuid });
      } else {
        const statusKey = String(ar.statusValue ?? "").toLowerCase();
        const STATUS_NAMES = { dazed: "Dazed", shaken: "Shaken", slow: "Slow", weak: "Weak" };
        const statusName = STATUS_NAMES[statusKey];
        if (!statusName) {
          warn("RESOLVE Hinder: no/unknown statusValue, skipping AE", ar.statusValue);
        } else {
          // Pull the canonical "Weak" / "Slow" / "Dazed" / "Shaken" AE
          // data from the FUCompanion AE registry. The registry entries
          // are the SAME effectData the legacy [Macro] Hinder + manual
          // sheet drops apply — carrying the proper status id,
          // `system.tags: ["debuff"]`, mechanical changes (e.g.
          // bonus_mig -2 for Weak), and the `effectmacro.onCreate /
          // onDelete` toggles for `system.props.isWeak` etc.
          //
          // We deliberately bypass `aem.applyEffects(...)` here: its
          // duplicate detection matches by shared canonical IDs, and
          // all four debuffs are stored as ActiveEffects on the same
          // world Item ("Debuff", Item.XVOWOq9oUmEECGrU). That parent
          // Item id is in every applied debuff's canonical-id set, so
          // applying Slow with `duplicateMode: "replace"` matches the
          // existing Weak AE on the target and replaces it. RAW Hinder
          // allows multiple distinct statuses to coexist (Weak + Slow
          // together is fine), so we route through the registry's
          // effectData directly and dedupe only against same-status
          // duplicates (name + statuses[]).
          try {
            const aem = globalThis.FUCompanion?.api?.activeEffectManager;
            const regApi = aem?._internal?.getRegistryApi?.();
            const targetActor = await fromUuid(ar.target?.actorUuid).catch(() => null);
            if (!regApi?.findByName) {
              warn("RESOLVE Hinder: AE registry API unavailable — status not applied");
            } else if (!targetActor) {
              warn("RESOLVE Hinder: target actor not found", ar.target?.actorUuid);
            } else {
              // Pick the world-item-effect entry (priority 100) when
              // available — that's the full canonical AE with changes,
              // effectmacro, etc. The fallback "config-status-effect"
              // entry (priority 80) is a status-only stub.
              const entries = regApi.findByName(statusName) ?? [];
              const entry = entries.find((e) => e?.sourceType === "world-item-effect") ?? entries[0];
              const sourceData = entry?.effectData;
              if (!sourceData) {
                warn(`RESOLVE Hinder: registry has no effectData for "${statusName}"`);
              } else {
                // Same-status dedup. Match against AEs that share the
                // CANONICAL Foundry status id (from sourceData.statuses[0])
                // or the literal name — distinguishes Weak from Slow even
                // though both share a parent Item.
                const canonicalStatuses = new Set(
                  (Array.isArray(sourceData.statuses) ? sourceData.statuses : [])
                    .map((s) => String(s).toLowerCase())
                );
                const existing = (targetActor.effects?.contents ?? []).find((eff) => {
                  if (eff.disabled) return false;
                  const effStatuses = eff.statuses ? Array.from(eff.statuses) : [];
                  if (effStatuses.some((s) => canonicalStatuses.has(String(s).toLowerCase()))) return true;
                  if (String(eff.name ?? "").toLowerCase() === statusName.toLowerCase()) return true;
                  return false;
                });
                if (existing) {
                  try { await existing.delete(); }
                  catch (e) { warn("RESOLVE Hinder: failed to delete prior same-status AE", e); }
                }
                const aeData = foundry.utils.deepClone(sourceData);
                delete aeData._id;
                // 3-round Hinder duration override + attribution.
                aeData.duration = { ...(aeData.duration ?? {}), rounds: 3, turns: 0 };
                aeData.origin = ar.attacker?.actorUuid ?? aeData.origin ?? null;
                aeData.disabled = false;
                aeData.transfer = false;
                try {
                  const [eff] = await targetActor.createEmbeddedDocuments("ActiveEffect", [aeData]);
                  log(`Hinder: ${statusName} applied to ${ar.target.name} (eff ${eff?.id ?? "?"})`);
                } catch (e) {
                  warn("RESOLVE Hinder: createEmbeddedDocuments threw", e);
                }
              }
            }
          } catch (e) {
            warn("RESOLVE Hinder: registry-driven apply threw", e);
          }
        }
      }
    } else if (ar.kind === "Study") {
      // Record the Open Check result on the Monster Encyclopedia journal
      // page. The encyclopedia tracks the party-wide best result; lower
      // rolls don't downgrade an existing better record.
      // Per RAW Core p.74 a Fumble = "no information gained" — explicitly
      // skip the record so a fumble doesn't accidentally count.
      if (ar.roll?.isFumble) {
        log(`Study fumbled by ${ar.attacker.name} on ${ar.target?.name ?? "?"} — no record.`);
        // Fumble = no information gained (RAW) — show the Miss flourish.
        playMissVfx({ tokenUuid: ar.target?.tokenUuid });
      } else {
        const encApi = globalThis.FUCompanion?.api?.encyclopedia;
        if (!encApi?.recordResult) {
          warn("RESOLVE Study: encyclopedia.recordResult not available");
        } else {
          const candidates = [ar.target?.worldActorUuid, ar.target?.actorUuid].filter(Boolean);
          let recordedUuid = null;
          for (const uuid of candidates) {
            try {
              const result = await encApi.recordResult({
                actorUuid: uuid,
                total: ar.roll.total,
                studierActorId: ar.attacker?.actorId ?? null,
                isCrit: !!ar.roll.isCrit,
                isFumble: !!ar.roll.isFumble,
              });
              recordedUuid = uuid;
              if (result?.changed) {
                log(`Study: encyclopedia updated for ${ar.target?.name ?? uuid} — ${result.previousBest} → ${result.newBest}`);
              } else {
                log(`Study: no improvement for ${ar.target?.name ?? uuid} (roll ${ar.roll.total}, best ${result?.previousBest ?? "?"})`);
              }
              break;  // first successful uuid wins; don't double-record
            } catch (e) {
              warn("RESOLVE Study: recordResult threw on", uuid, e);
            }
          }

          // Token VFX. A Study below the lowest reveal tier (Identity = 7)
          // learns nothing — show the Miss flourish instead of the green
          // "studied" marker, so a useless roll reads as a whiff. A Crit
          // auto-promotes to full reveal regardless of total, so it's never
          // treated as below-bar. Above the bar: the green marker, then the
          // encyclopedia opens AFTER it settles (asset URLs are preloaded so
          // first use during a battle is lag-free).
          const STUDY_LOWEST_BAR = 7; // TIER_IDENTITY in encyclopedia-core.js
          const studyTotal = Number(ar.roll?.total ?? 0) || 0;
          const studyBelowBar = !ar.roll?.isCrit && studyTotal < STUDY_LOWEST_BAR;
          try {
            if (studyBelowBar) {
              log(`Study below lowest bar (${studyTotal} < ${STUDY_LOWEST_BAR}) — Miss VFX.`);
              playMissVfx({ tokenUuid: ar.target?.tokenUuid });
            } else {
              await playStudyVfx({ targetTokenUuid: ar.target?.tokenUuid, durationMs: 2500 });
            }
          } catch (e) {
            warn("RESOLVE Study: study/miss VFX threw", e);
          }

          // Open the encyclopedia at the studied target's page on the GM
          // client, then socket-broadcast so player views also open it.
          //
          // The unlock animation (slide-in + glow on newly-revealed tier
          // sections) is queued inside recordResult() with a 30s TTL; the
          // encyclopedia's own renderJournalSheet hook calls
          // flushPendingUnlocks() on render, so opening the sheet here
          // automatically plays the animation if a tier was crossed. No
          // extra call needed from us.
          if (recordedUuid && encApi.openEncyclopediaForActor) {
            try {
              await encApi.openEncyclopediaForActor(recordedUuid);
            } catch (e) {
              warn("RESOLVE Study: openEncyclopediaForActor failed", e);
            }
            try {
              game.socket?.emit?.("module.fabula-ultima-companion", {
                type: "encyclopedia:open",
                actorUuid: recordedUuid,
              });
            } catch (e) {
              warn("RESOLVE Study: encyclopedia:open socket emit failed", e);
            }
          }
        }
      }
    }

    // Persistence checkpoint #4 — RESOLVE has applied the action's
    // damage / AE / equipment / item-consume to actor docs. From this
    // point on a reload must NOT rewind to TURN_START (the action
    // already committed; re-doing it would double-apply). Mark the
    // turn resolved + write the flag. The resume path reads this and
    // routes to TURN_END instead of TURN_START.
    //
    // Multi-pass attacks (Two-Weapon): set true on every RESOLVE so a
    // reload mid-second-pass skips the rest of the turn. Trade-off: the
    // second weapon's attack is lost on resume. The opposite trade
    // (double-applying the first pass) is strictly worse.
    //
    // Free-action gate: a free action's RESOLVE must NOT mark the turn
    // resolved. The pipeline detours REACTION_WINDOW → FAW (skipping
    // TURN_END), so without this gate `currentTurnResolved=true` would
    // persist after the free action completes. On the next F5/reload,
    // the resume sees it and routes to TURN_END — which advances the
    // turn, flipping currentSide. The previously-observed "monster
    // side starts after my free action" and "no turn picker after
    // rewind" symptoms both trace back here. The marker for "we're
    // mid-free-action" is the continuation stack: top frame is a
    // `freeAction:*` while the sub-flow is in flight.
    if (director.dCombat && !topIsFreeAction(director.ctx)) {
      director.dCombat.currentTurnResolved = true;
    }
    // Label describes what the GM lands at on rewind: a checkpoint
    // AFTER this action's commit — resume routes via TURN_END → next
    // turn picker. For multi-pass attacks, distinguish the pass so
    // pass-1 vs pass-2 checkpoints are unambiguous in the list.
    const rvDc = director.dCombat;
    // For a free action, name the actor who actually just acted (the
    // reactor whose snapshot was swapped in). dCombat.current still
    // points at the original turn-owner — fall through to ar.attacker
    // so the rewind label reads "After Hina's Action" during her HS
    // free Attack instead of "After Wolf's Action".
    const rvName = topIsFreeAction(director.ctx)
      ? (ar?.attacker?.name ?? director.ctx.turnSnapshot?.name ?? "?")
      : (rvDc?.current?.name ?? ar?.attacker?.name ?? "?");
    const rvPassTag = (ar?.totalPasses ?? 1) > 1
      ? ` (Pass ${ar.passIndex}/${ar.totalPasses})`
      : "";
    const rvPhase = rewindPhaseLabel(director.ctx, rvDc?.round);
    await saveDirectorState(director, {
      label: `${rvPhase} · After ${rvName}'s Action${rvPassTag}`,
      description: describeActionForRewind(ar),
    }).catch((e) => warn("RESOLVE: saveDirectorState failed", e));

    // Drain any post-action passive triggers queued during the body of
    // this RESOLVE (e.g. `creature_deals_damage` → Vanish). Firing them
    // AFTER the save above means their AEs aren't captured in this
    // checkpoint's actor snapshot — rewinding to "After X's Action"
    // restores pre-reaction state, so one rewind undoes the latest
    // Vanish (and the AE it added). Without this re-ordering the
    // reaction-applied AE landed in the snapshot and required two
    // rewinds to remove.
    const queued = Array.isArray(director.ctx?._postResolveTriggers)
      ? director.ctx._postResolveTriggers : [];
    director.ctx._postResolveTriggers = [];
    for (const cfg of queued) {
      try {
        await firePassiveTriggers({ director, ...cfg });
      } catch (e) {
        warn(`RESOLVE: post-save passive trigger "${cfg?.trigger}" threw`, e);
      }
    }

    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── REACTION_WINDOW ───────────────────────────────────────────────────
// v1 stub: no reactions fire. Just pass through.
// A real implementation runs MATCH → PASSIVE → MANUAL → DRAIN here.
const ReactionWindow = {
  async onEnter(director) {
    log("REACTION_WINDOW — v1 stub, no reactions in prototype");
    // Tiny delay to demonstrate the FSM is genuinely waiting in this state.
    // Routes through director.timers so stop() guarantees cleanup.
    director.timers.setTimeout(
      () => director.dispatch({ type: INTENTS.INTERNAL_DONE }),
      100,
      { label: "reactionWindow:stubDelay" }
    );
  },
};

// ─── CLEANUP ───────────────────────────────────────────────────────────
// Per-turn cleanup. Releases any transient state that shouldn't survive.
const Cleanup = {
  async onEnter(director) {
    director.ctx.actionResult = null;
    director.ctx.currentWeapon = null;
    director.ctx.pendingTriggers.length = 0;
    director.ctx.reactionDepth = 0;

    // Multi-pass attacks (Two-Weapon Fighting): if more passes remain in
    // the queue, we keep declaredCommand / eligibleTargets / attackMode
    // alive so COMPUTE can roll the next weapon as a fresh card.
    // The transition table (states.js) branches CLEANUP → COMPUTE on
    // INTERNAL_DONE when ctx.pendingPasses still has entries.
    const moreToRoll = Array.isArray(director.ctx.pendingPasses) && director.ctx.pendingPasses.length > 0;
    if (!moreToRoll) {
      director.ctx.declaredCommand = null;
      director.ctx.eligibleTargets = null;
      director.ctx.attackMode = null;
      director.ctx.weaponsUsed = null;
      director.ctx.pendingPasses = null;
      director.ctx.totalPasses = 0;
      director.ctx.passIndex = 0;
      director.ctx.pickedTargetUuids = null;
      director.ctx.hinderCheckConfig = null;
      log("CLEANUP done");
    } else {
      log(`CLEANUP done (multi-pass — ${director.ctx.pendingPasses.length} remaining, looping back to COMPUTE)`);
    }
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── TURN_END ──────────────────────────────────────────────────────────
// Bumps the turn counter + flips side if needed (per Fabula side-based
// alternation). Does NOT pick the next combatant — that's TURN_START's job
// (via the picker). Does NOT mirror to Foundry — mirroring happens in
// TURN_START once `currentCombatantId` is resolved.
const TurnEnd = {
  async onEnter(director) {
    // Defense-in-depth guard — TURN_END must never run mid-free-action.
    // REACTION_WINDOW + CLEANUP transitions both gate on `topIsFreeAction`
    // (states.js) so this branch should be unreachable. If it fires,
    // route through FAW directly so the stack can pop its frame and the
    // sub-flow completes cleanly.
    if (topIsFreeAction(director.ctx)) {
      warn(
        `TURN_END misroute guard fired — free action on stack (depth ${stackDepth(director.ctx)}, top "${peekTop(director.ctx)?.reason}"). Skipping nextTurn() and routing to FREE_ACTION_WINDOW.`,
        { ctx_keys: Object.keys(director.ctx ?? {}).sort() }
      );
      // Force-transition to FAW (skipping the SRW dance). FAW.onEnter
      // sees the free-action frame on top, pops it, and continues the
      // drain/exit logic.
      await director.transitionTo(STATES.FREE_ACTION_WINDOW);
      return;
    }
    if (director.dCombat) {
      // Capture the "just acted" name + round + actor BEFORE nextTurn
      // (nextTurn clears currentCombatantId and may advance the round
      // on a wrap). The captured actor uuid threads into the standalone
      // reaction payload so turn_end reactions can read currentActorUuid.
      const teJustActedName = director.dCombat.current?.name
        ?? director.ctx.turnSnapshot?.name ?? "?";
      const teRoundEnded = director.dCombat.round ?? 0;
      const endingActorUuid  = director.dCombat?.current?.actorUuid ?? null;
      const endingTokenUuid  = director.dCombat?.current?.tokenUuid ?? null;

      try {
        const r = director.dCombat.nextTurn();
        director.ctx.endOfRound = !!r.wrappedRound;
        director.ctx.endOfCombat = !!r.ended;
        log(`TURN_END (dCombat) → round ${r.round}, currentSide=${r.currentSide}, eligible=${r.eligibleIds.length}${r.wrappedRound ? " [wrapped round]" : ""}${r.ended ? " [ended]" : ""}`);
      } catch (e) {
        warn("TURN_END: dCombat.nextTurn threw", e);
        director.ctx.endOfCombat = true;
      }
      // The turn we just wrapped up is now in the past — clear the
      // resolved-flag so a reload/rewind to THIS save site routes
      // through TURN_START (next turn's picker), not back into TURN_END
      // (which would re-run nextTurn and incorrectly flip currentSide
      // a second time, e.g. "Enemies Pick Next Turn" snapshot rewinds
      // into a party-side picker).
      director.dCombat.currentTurnResolved = false;
      // Persistence checkpoint #3 — round / currentSide / turnsRemaining
      // have been advanced. Saving here means a reload between TURN_END
      // and the NEXT TURN_START still resumes at the right turn.
      // Label describes the state the GM lands at on rewind: the
      // next-turn picker (or auto-pick → DECLARE if only one eligible).
      // Use the POST-nextTurn round/side so the label reflects what the
      // GM will actually see, not the round that just ended.
      const teNewRound = director.dCombat.round ?? 0;
      const teNewSide = director.dCombat.currentSide === "enemy" ? "Enemies" : "Party";
      const teDescParts = [`${teJustActedName}'s turn ended`];
      if (director.ctx.endOfRound) teDescParts.push(`Round ${teRoundEnded} wrapped`);
      if (director.ctx.endOfCombat) teDescParts.push(`Combat ended`);
      saveDirectorState(director, {
        label: director.ctx.endOfCombat
          ? `Combat Ended`
          : `Round ${teNewRound} · ${teNewSide} Pick Next Turn`,
        description: teDescParts.join(" · "),
      }).catch((e) => warn("TURN_END: saveDirectorState failed", e));

      // Hand off to STANDALONE_REACTION_WINDOW for turn_end. The
      // payload uses the BEFORE-nextTurn actor (the actor whose turn
      // is ending) so end-of-turn reactions can read which turn ended.
      // standaloneAfter branches on endOfRound (ROUND_END vs TURN_START)
      // — the same routing the prior transition function did inline.
      director.ctx.standaloneTrigger = "turn_end";
      director.ctx.standaloneAfter   = director.ctx.endOfRound ? STATES.ROUND_END : STATES.TURN_START;
      director.ctx.standalonePayload = {
        actingActorUuid: endingActorUuid,
        actingTokenUuid: endingTokenUuid,
      };
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Manual-fallback path: no dCombat, drive the Foundry combat directly.
    // No standalone reactions in this path — manual fallback predates the
    // declarative reaction system and isn't worth threading the new state
    // through. The transition still routes via STANDALONE_REACTION_WINDOW
    // (which no-ops on zero reactors) → next state.
    const combat = director.combat;
    if (!combat) {
      director.ctx.endOfCombat = true;
      director.ctx.standaloneTrigger = "turn_end";
      director.ctx.standaloneAfter   = STATES.STOPPED;
      director.ctx.standalonePayload = null;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    const wasRound = combat.round;
    try {
      await combat.nextTurn();
    } catch (e) {
      warn("TURN_END: combat.nextTurn() threw", e);
      director.ctx.endOfCombat = true;
      director.ctx.standaloneTrigger = "turn_end";
      director.ctx.standaloneAfter   = STATES.STOPPED;
      director.ctx.standalonePayload = null;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    director.ctx.endOfRound = (combat.round !== wasRound);
    director.ctx.standaloneTrigger = "turn_end";
    director.ctx.standaloneAfter   = director.ctx.endOfRound ? STATES.ROUND_END : STATES.TURN_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ROUND_END ─────────────────────────────────────────────────────────
const RoundEnd = {
  async onEnter(director) {
    log(`ROUND_END`);

    // Hand off to STANDALONE_REACTION_WINDOW for round_end. The transition
    // rule branches on endOfCombat (combat over → STOPPED, otherwise →
    // STANDALONE_REACTION_WINDOW → ROUND_START).
    director.ctx.standaloneTrigger = "round_end";
    director.ctx.standaloneAfter   = STATES.ROUND_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── STANDALONE_REACTION_WINDOW ────────────────────────────────────────
// Inserted between FSM transitions to host standalone-trigger reactions
// (conflict_start, round_start, turn_start, turn_end, round_end). The
// predecessor state sets ctx.standaloneTrigger + standaloneAfter +
// standalonePayload; this handler dispatches the trigger (blocking until
// every reactor menu closes) and then enqueues INTERNAL_DONE so the
// transition reader picks up standaloneAfter. ABORT/TIMEOUT during the
// reaction phase route to ABORTED cleanly (the FSM sees them as a real
// state, not a parked handler), and idempotency persistence inside
// dispatch survives F5 mid-reaction.
const StandaloneReactionWindow = {
  async onEnter(director) {
    const ctx = director.ctx;

    // Re-entry detection: top of stack is an `srwDetour:` frame we
    // pushed on a prior entry when we detoured through FAW. Pop it
    // now; the snapshot restores standaloneTrigger / standaloneAfter /
    // standalonePayload to the values they had pre-detour, so the
    // dispatch + queue-check loop below runs on the same trigger.
    // The pop fires regardless of save/resume — the routing target
    // (top.resumeAt = SRW) is what brought us back here.
    if (topIsSrwDetour(ctx)) {
      popFrame(director);
    }

    const trigger = ctx.standaloneTrigger ?? null;
    const finalTarget = ctx.standaloneAfter ?? null;
    const payload = ctx.standalonePayload ?? null;
    if (!trigger || !finalTarget) {
      warn(`STANDALONE_REACTION_WINDOW: missing trigger/finalTarget (trigger=${trigger}, final=${finalTarget}); passing through`);
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    log(`STANDALONE_REACTION_WINDOW: ${trigger} (final target ${finalTarget}, depth ${stackDepth(ctx)})`);
    try {
      const spawned = await dispatchStandaloneTrigger({ director, trigger, payload });
      if (spawned) log(`STANDALONE_REACTION_WINDOW: ${trigger} dispatched ${spawned} reactor menu(s)`);
    } catch (e) {
      warn(`STANDALONE_REACTION_WINDOW: ${trigger} dispatch threw`, e);
    }
    // If any reaction enqueued a free-action grant (open_action_menu
    // free_mode), push a continuation frame capturing where we'll
    // resume after the queue drains, then route to FAW. FAW's exit
    // (queue empty + free-action frame popped) reads `top.resumeAt`
    // and transitions back here, where the pop above restores our
    // captured trigger/after/payload. Loop terminates when dispatch
    // produces no new menus AND the queue is empty → SRW exits via
    // INTERNAL_DONE → ctx.standaloneAfter (the original final target).
    try {
      const { freeActionQueue } = await import("./free-action-queue.js");
      if (!freeActionQueue.isEmpty()) {
        log(`STANDALONE_REACTION_WINDOW: ${freeActionQueue.size()} free-action request(s) pending → detour through FREE_ACTION_WINDOW → resume here on completion`);
        // PUSH the detour frame BEFORE mutating standaloneAfter. The
        // snapshot captures the CURRENT (pre-mutation) standaloneAfter
        // so the pop restores it to the original final target. Without
        // the snapshot, the FSM would have no record of where SRW was
        // supposed to exit to.
        pushFrame(director, {
          reason: `srwDetour:${trigger}`,
          resumeAt: STATES.STANDALONE_REACTION_WINDOW,
          fieldsToSnapshot: ["standaloneTrigger", "standaloneAfter", "standalonePayload"],
        });
        // Re-point standaloneAfter at FAW so the state machine's
        // INTERNAL_DONE → standaloneAfter rule routes us through the
        // free-action drain. The push above already captured the
        // original; pop will restore on re-entry.
        ctx.standaloneAfter = STATES.FREE_ACTION_WINDOW;
        // F5-survival checkpoint. The save sites at PREP / TURN_START /
        // CONFIRM / RESOLVE / TURN_END never fire between SRW's dispatch
        // and the player picking their free action — without this explicit
        // save, F5 mid-pipeline restores to a pre-SRW state where
        // standaloneFired already records the click (filtering HS) AND
        // the queue is empty (no FAW branch fires). The player's free
        // action is then lost on resume.
        //
        // Now we save WITH the detour frame on the stack, so resume
        // sees the frame and routes to top.resumeAt = SRW (after FAW
        // handles its own re-entry detection). Same end state as the
        // live flow.
        try {
          const peek = freeActionQueue.peek();
          const reactorName = peek?.sourceLabel
            ? `${peek.sourceLabel}`
            : "free action";
          // This save fires AFTER the srwDetour frame is pushed (line
          // above), so rewindPhaseLabel walks the stack and sees the
          // conflict_start frame — labels "Conflict Start · …" when
          // the originating trigger was conflict_start, "Round N · …"
          // otherwise (turn_start etc.).
          const sawPhase = rewindPhaseLabel(director.ctx, director.dCombat?.round);
          await saveDirectorState(director, {
            label: `${sawPhase} · ${reactorName} pending`,
            description: `${freeActionQueue.size()} free action(s) queued; awaiting player choice`,
          });
        } catch (e) {
          warn("STANDALONE_REACTION_WINDOW: pre-FAW save failed", e);
        }
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
    } catch (e) {
      warn("STANDALONE_REACTION_WINDOW: free-action queue check threw", e);
    }
    // No pending actions — all reactors decided (or none matched). Exit
    // to the original final target. standaloneAfter is already correct
    // (the pop above restored it if we re-entered after a FAW drain).
    log(`STANDALONE_REACTION_WINDOW: ${trigger} loop complete → ${finalTarget}`);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── FREE_ACTION_WINDOW ─────────────────────────────────────────────────
// Drains the FreeActionQueue produced by reaction chains' free_mode
// effect. Each request runs through the full DECLARE → ... → RESOLVE
// pipeline with the reactor's turn snapshot temporarily swapped in.
//
// onEnter has two modes, distinguished by what's on top of the
// continuation stack:
//   - Top is a `freeAction:*` frame → re-entering after RESOLVE /
//     REACTION_WINDOW. Pop the frame (which restores the original
//     turnSnapshot + actionResult) and clear the freeActions singleton
//     for that reactor, then fall through to the dequeue path so the
//     next request (or exit) is handled.
//   - Top is anything else (srwDetour, empty) → first entry. Dequeue
//     if available; if the queue is empty, exit to top.resumeAt (or
//     TURN_START fallback). If non-empty, push a `freeAction:*` frame
//     snapshotting turnSnapshot+actionResult, install the freeActions
//     singleton, swap in the reactor's view, and route to DECLARE.
//
// See [[free-actions]] for the queue contract + [[continuation-stack]]
// for the frame shape.
const FreeActionWindow = {
  async onEnter(director) {
    const ctx = director.ctx;
    const { freeActionQueue } = await import("./free-action-queue.js");
    const { freeActions } = await import("./free-actions.js");

    // Re-entry after a completed free action — pop the frame to restore
    // the original turnSnapshot + actionResult, and clear the freeActions
    // singleton entry for this reactor. The frame's `extra` carries the
    // request + reactorActorId so we can identify whom to clear.
    if (topIsFreeAction(ctx)) {
      const popped = popFrame(director);
      const reactorId = popped?.extra?.reactorActorId
        ?? popped?.extra?.request?.reactorActorId
        ?? null;
      log(`FREE_ACTION_WINDOW: free action complete (${popped?.reason ?? "?"}) — popped + snapshot restored`);
      if (reactorId) freeActions.clear(reactorId);
    }

    // Drain the next request, or exit.
    if (freeActionQueue.isEmpty()) {
      // Exit target = whatever's now on top of the stack, or TURN_START
      // when the stack is empty (e.g. queue drained at top level with
      // no SRW detour frame underneath). The state-machine rule for
      // FAW's INTERNAL_DONE reads this same predicate.
      const nextTarget = peekTop(ctx)?.resumeAt ?? STATES.TURN_START;
      log(`FREE_ACTION_WINDOW: queue empty — routing to ${nextTarget}`);
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    const req = freeActionQueue.dequeue();
    if (!req) {
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Resolve the reactor's token + actor.
    const reactorActor = await fromUuid(req.reactorActorUuid).catch(() => null);
    const reactorTokenDoc = req.reactorTokenUuid
      ? await fromUuid(req.reactorTokenUuid).catch(() => null)
      : null;
    if (!reactorActor || !reactorTokenDoc) {
      warn(`FREE_ACTION_WINDOW: reactor lookup failed (actor=${!!reactorActor}, token=${!!reactorTokenDoc}); skipping request "${req.sourceLabel}"`);
      // Re-enter to drain next or exit. No push happened, so re-entry
      // sees no `freeAction:*` frame on top and falls through to the
      // dequeue path again.
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Install the freeActions singleton from the request — COMPUTE reads
    // this to bake checkBonus / damageBonus into the action's roll and
    // composeAction reads `enabledLabels` to filter the Octopath.
    freeActions.set(req.reactorActorId, {
      enabledLabels:    req.enabledLabels,
      checkBonus:       req.checkBonus,
      damageBonus:      req.damageBonus,
      sourceLabel:      req.sourceLabel,
      sourceItemUuid:   req.sourceItemUuid,
    });

    // PUSH the free-action frame BEFORE mutating turnSnapshot+actionResult.
    // The snapshot captures the OLD values (original turn-owner's view)
    // so the pop on re-entry restores them. `extra` carries the request
    // so we can read reactorActorId + sourceLabel after pop, and so
    // diagnostic surfaces (rewind list, logs) can name the frame.
    pushFrame(director, {
      reason: `freeAction:${req.sourceLabel ?? "?"}`,
      resumeAt: STATES.FREE_ACTION_WINDOW,
      fieldsToSnapshot: ["turnSnapshot", "actionResult"],
      extra: { request: req, reactorActorId: req.reactorActorId },
    });

    // Swap in the reactor's view. Pop will restore the originals.
    try {
      const combatant = director.dCombat?.combatants?.find?.((c) => c.actorUuid === req.reactorActorUuid);
      if (combatant) {
        ctx.turnSnapshot = snapshotDirectorCombatant(combatant);
      } else {
        // Reactor isn't in dCombat (e.g. summon mid-battle). Fall back
        // to snapshotCombatant from the token.
        ctx.turnSnapshot = snapshotCombatant({ actor: reactorActor, tokenDoc: reactorTokenDoc });
      }
    } catch (e) {
      warn("FREE_ACTION_WINDOW: snapshot threw", e);
      // Pop's snapshot still holds the pre-push value; leave turnSnapshot
      // as-is for now (will be restored on pop).
    }
    ctx.actionResult = null;

    log(`FREE_ACTION_WINDOW: starting free action "${req.sourceLabel}" for ${reactorActor.name} (${req.enabledLabels.join(", ") || "any"})`);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ABORTED ───────────────────────────────────────────────────────────
const Aborted = {
  async onEnter(director, { triggerIntent }) {
    const reason = director.ctx.abortReason ?? triggerIntent?.body?.reason ?? "aborted";
    log(`ABORTED — ${reason}`);
    ui.notifications?.warn(`Director: action aborted (${reason})`);
    director.ctx.abortReason = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── STOPPED ───────────────────────────────────────────────────────────
const Stopped = {
  async onEnter(director) {
    log("STOPPED");
    TurnUI.despawn({ director });
    TurnPicker.despawn({ director });
    WeaponModePicker.despawn({ director });
    AttributePairPicker.despawn({ director });
    SkillPicker.despawn({ director });
    OptionPicker.despawnAll();
    BattlefieldActionCard.despawn({ director });
    // Drop any reaction menus left over from earlier in the battle.
    // conflict_end has no dispatch site yet — it needs a pre-STOPPED
    // hook (last turn's RESOLVE? a CLEANUP_AFTER state?) so the player
    // can react before tokens get wiped. Tracked in
    // [[reaction-menu-on-token]] as next-iteration work.
    try { await clearAllStandaloneMenus(); } catch (e) { warn("STOPPED: clearAllStandaloneMenus threw", e); }
  },
};

export const STATE_HANDLERS = Object.freeze({
  [STATES.PREP]:            Prep,
  [STATES.ROUND_START]:     RoundStart,
  [STATES.TURN_START]:      TurnStart,
  [STATES.DECLARE]:         Declare,
  [STATES.TARGET]:          Target,
  [STATES.COMPUTE]:         Compute,
  [STATES.CONFIRM]:         Confirm,
  [STATES.RESOLVE]:         Resolve,
  [STATES.REACTION_WINDOW]: ReactionWindow,
  [STATES.CLEANUP]:         Cleanup,
  [STATES.TURN_END]:        TurnEnd,
  [STATES.ROUND_END]:       RoundEnd,
  [STATES.STANDALONE_REACTION_WINDOW]: StandaloneReactionWindow,
  [STATES.FREE_ACTION_WINDOW]: FreeActionWindow,
  [STATES.ABORTED]:         Aborted,
  [STATES.STOPPED]:         Stopped,
});
