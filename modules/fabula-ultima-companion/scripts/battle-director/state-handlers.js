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
import { snapshotCombatant, snapshotDirectorCombatant, snapshotEligibleTargets, snapshotEligibleTargetsFromDCombat, readPropNum, attrDieSize, freezeActionResult, applyAffinityToDamage } from "./snapshot.js";
import { TurnUI } from "./turn-ui.js";
import { TurnPicker } from "./turn-picker.js";
import { requestTargeting } from "./target-picker.js";
import { postActionCard, BattlefieldActionCard } from "./action-card.js";
import { pickWeaponMode, WeaponModePicker } from "./weapon-mode-picker.js";
import { pickAttributePair, AttributePairPicker } from "./attribute-pair-picker.js";
import { runDirectorInit } from "./director-init.js";
import { playStudyVfx } from "./director-vfx.js";
import { applyEquipmentSwap } from "./equipment-swap.js";
import { gatherConsumables, gatherCreatables, readActorIp, consumeOne, spendIp } from "./item-resource.js";
import { saveDirectorState, installItemDeletionTracker, clearAllDirectorStateFlags } from "./persistence.js";
// Phase B.1 Skill engine
import { pickSkill, SkillPicker } from "./skill-picker.js";
import { OptionPicker } from "./option-picker.js";
import { parseSkillCost, resolveCost, checkAffordable, debitCost } from "./skill-cost.js";
import { evaluateFormula, buildSkillResolver } from "./skill-formulas.js";
import { makeChainContext } from "./skill-targeting.js";
import { fireActivationEffect, firePostDamageEffect, tickDirectorAEsForApplier, firePassiveTriggers, applyMercyClamp, applySoulWeaponElementOverride } from "./skill-effects.js";
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
      try { await debitCost(casterActor, costMap); }
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
  });

  // 3. Fire on_activate effect (pre-damage, no damage payload).
  try {
    const r = await fireActivationEffect(skill, ctx);
    if (r?.abort) {
      log(`Skill resolve: on_activate aborted chain — skipping damage + post_damage`);
      ui.notifications?.info(`${ar.attacker?.name ?? "Caster"} began ${ar.skillName} but it was interrupted.`);
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
      if (!r.hit) continue;
      try {
        const targetActor = await fromUuid(r.actorUuid).catch(() => null);
        if (!targetActor) { warn("Skill resolve: target actor not found", r.actorUuid); continue; }

        let finalValue = 0;
        let valueType = dmgResource;
        let valueDirection = "loss";
        let damageTypeForPayload = ar.damageType;

        // Vismagus self-heal suppression — if the caster paid HP for the
        // spell via Vismagus, they do NOT recover HP from this spell
        // (other targets unaffected). Per RAW Spiritist p.182.
        if (ar.vismagusHpPaid && r.actorUuid === ar.attackerActorRef) {
          log(`Skill ${ar.skillName}: Vismagus suppresses caster self-heal for ${r.name}`);
          continue;
        }
        if (dmgResource === "mp") {
          // MP damage path — Drain Spirit / future MP-burn spells.
          // No AB flip (MP absorb isn't an RAW affinity). Apply the
          // raw post-affinity damage (always NE for MP) directly.
          if (r.damage > 0) {
            const curMp = readPropNum(targetActor, ["current_mp", "mp"]);
            const newMp = Math.max(0, curMp - r.damage);
            await targetActor.update({ "system.props.current_mp": newMp });
            log(`Skill ${ar.skillName}: applied ${r.damage} MP damage to ${r.name}: ${curMp} → ${newMp}`);
          }
          finalValue = r.damage;
          valueType = "mp";
        } else {
          // HP damage path — full affinity rules (incl AB → heal flip).
          const curHp = readPropNum(targetActor, ["current_hp", "hp"]);
          const maxHp = readPropNum(targetActor, ["max_hp"], curHp);
          if (r.affinity === "AB") {
            const healed = Math.max(0, r.damage);
            if (healed > 0) {
              const newHp = Math.min(maxHp, curHp + healed);
              await targetActor.update({ "system.props.current_hp": newHp });
              log(`Skill ${ar.skillName}: absorbed ${healed} on ${r.name}: ${curHp} → ${newHp} (heal)`);
            }
            finalValue = healed;
            valueDirection = "recover";
            damageTypeForPayload = "healing";
          } else if (r.damage > 0) {
            const { newHp, mercyFired } = await applyMercyClamp(targetActor, curHp, r.damage);
            await targetActor.update({ "system.props.current_hp": newHp });
            log(`Skill ${ar.skillName}: applied ${r.damage} dmg [${r.affinity}] to ${r.name}: ${curHp} → ${newHp}${mercyFired ? " (Mercy clamped at 1 HP)" : ""}`);
            // Report the effective HP loss, not the raw damage — Mercy
            // clamps to 1, so finalValue reflects what actually came off.
            finalValue = Math.max(0, curHp - newHp);
          }
          valueType = "hp";
        }

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

  // 5. Toast — director never posts to chat for action confirmation.
  const targetNames = (ar.targets ?? []).map((t) => t.name).join(", ") || "no target";
  ui.notifications?.info(`${ar.attacker?.name ?? "?"} cast ${ar.skillName} on ${targetNames}.`);

  // 6. Passive triggers — fire any caster-side passives whose
  //    `passive_trigger` matches "spell_complete". Examples: Spiritist's
  //    Healing Power (post-spell SL×BOND_COUNT heal grant) and Support
  //    Magic (post-spell bond-bonus on a chosen ally's next Check).
  //
  //    Spell-only: skill_type !== "Spell" actions don't fire spell-tagged
  //    passives. Other triggers (attack_complete, damage_taken, etc.)
  //    will get their own hook sites as we ship more passives.
  if (String(skill.system?.props?.skill_type ?? "").toLowerCase() === "spell") {
    try {
      await firePassiveTriggers({
        director,
        casterActor,
        trigger: "spell_complete",
        payload: {
          spellUuid: skill.uuid,
          spellName: skill.name,
          targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
          hitTargetTokenUuids: Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : (ar.targets ?? []).map((t) => t.tokenUuid),
          sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
          sourceActorUuid: ar.attackerActorRef,
          actionIntent: ar.actionIntent,
        },
      });
    } catch (e) { warn("Skill resolve: firePassiveTriggers threw", e); }
  }
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
function extractTargetCountFromText(text, { isUpTo, resolver }) {
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
    log(`ROUND_START — round ${director.dCombat?.round ?? director.combat?.round ?? "?"}`);
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
          const pickedId = await TurnPicker.show({ director, eligible });
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

    // No-op for triggers in v1. Pass through.
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── DECLARE ───────────────────────────────────────────────────────────
// Spawn the Octopath buttons over the current combatant's token. Wait for
// the user to click a command.
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

    const token = canvas?.tokens?.get(snap.tokenId);
    if (!token) {
      warn("DECLARE: token not on canvas", snap.tokenId);
      // For NPC turns the GM still needs the UI somewhere; bail to TURN_END.
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }
    TurnUI.spawn({ director, token });
  },

  async onExit(director) {
    TurnUI.despawn({ director });
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

      const coverTarget = (result.skipped || result.tokenUuids.length === 0)
        ? null
        : coverEligible.find((t) => t.tokenUuid === result.tokenUuids[0]) ?? null;

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
      director.ctx.pickedTargetUuids = [...result.tokenUuids];
      director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: result.tokenUuids } });
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

      // Per RAW Core p.71, the GM picks the attribute pair AFTER the
      // player describes their approach. Surface that on the GM client
      // now — the player is committed to the target but waits for the GM
      // to call the check. Default DL is 10 (the fixed RAW value) but the
      // GM can adjust for situational difficulty.
      const targetSnap = eligible.find((t) => t.tokenUuid === targetResult.tokenUuids[0]) ?? null;
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
      director.ctx.pickedTargetUuids = [...targetResult.tokenUuids];
      director.ctx.hinderCheckConfig = {
        A1: checkConfig.A1,
        A2: checkConfig.A2,
        dl: checkConfig.dl ?? 10,
      };
      director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: targetResult.tokenUuids } });
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

      // 1) Pick from the actor's roster (+ equipped-item grants).
      //    Spell action filters to skill_type=Spell; Skill action to Active.
      const pick = await pickSkill({
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
        // Pick category. "ally" keywords + aid intent → ally; default → enemy.
        const wantsAlly = /ally|allies/i.test(skillTargetText) || intent === "aid";
        const category = wantsAlly ? "ally" : "enemy";
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

        if (mode === "all") {
          if (!eligibleRaw.length) {
            ui.notifications?.warn(`No eligible ${category}s on this scene.`);
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          targets = eligibleRaw;
          targetUuids = eligibleRaw.map((e) => e.tokenUuid);
        } else {
          if (!eligibleRaw.length) {
            ui.notifications?.warn(`No eligible ${category}s on this scene.`);
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          director.ctx.eligibleTargets = eligibleRaw;
          const titleText = `${attackerSnap.name}: pick target${count > 1 ? "s" : ""} for ${skill.name}`;
          const result = await requestTargeting({
            director,
            eligible: eligibleRaw,
            mode,
            count,
            titleText,
          });
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
      // Vismagus alt-cost: when the caster CAN'T pay the MP, but has the
      // Vismagus passive AND would survive paying 2× the MP cost as HP
      // instead, offer the swap. On accept the costMap is rewritten so
      // debitCost burns HP. RAW: paying HP MUST leave the caster with
      // ≥1 HP — we gate on `curHp > 2*mpNeed`.
      let vismagusHpPaid = false;
      if (!gate.ok) {
        const skillIsSpell = String(skill.system?.props?.skill_type ?? "").toLowerCase() === "spell";
        const hasVismagus = (attackerActor.items?.contents ?? []).some((it) =>
          it.name === "Vismagus" && it.system?.props?.vismagus_passive === true
        );
        const mpNeed = Number(costMap.get?.("mp") ?? costMap.mp ?? 0) || 0;
        const curHp = Number(attackerActor.system?.props?.current_hp ?? 0) || 0;
        const onlyMpMissing = gate.missing.every((m) => String(m.resource ?? m.label ?? "").toLowerCase() === "mp");
        if (skillIsSpell && hasVismagus && mpNeed > 0 && onlyMpMissing && curHp > mpNeed * 2) {
          const accept = await new Promise((resolve) => {
            if (typeof Dialog !== "function") return resolve(false);
            new Dialog({
              title: "Vismagus — pay HP instead?",
              content: `<p><strong>${attackerActor.name}</strong> can't afford <strong>${skill.name}</strong> (${gate.missing.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", ")}).</p><p>Vismagus lets them pay <strong>${mpNeed * 2} HP</strong> instead of <strong>${mpNeed} MP</strong>. Their HP would drop from ${curHp} to ${curHp - mpNeed * 2}.</p><p><em>If this spell would heal you, you recover no HP (it still works on other targets).</em></p>`,
              buttons: {
                pay:    { label: `Pay ${mpNeed * 2} HP`, callback: () => resolve(true) },
                cancel: { label: "Cancel",               callback: () => resolve(false) },
              },
              default: "pay",
              close: () => resolve(false),
            }).render(true);
          });
          if (accept) {
            const newMap = new Map();
            for (const [k, v] of costMap.entries?.() ?? Object.entries(costMap ?? {})) {
              if (String(k).toLowerCase() === "mp") continue;
              newMap.set(k, v);
            }
            newMap.set("hp", (Number(newMap.get?.("hp") ?? 0) || 0) + mpNeed * 2);
            costMap = newMap;
            gate = checkAffordable(attackerActor, costMap);
            vismagusHpPaid = true;
          }
        }
      }
      if (!gate.ok) {
        const missing = gate.missing.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", ");
        ui.notifications?.warn(`Can't cast ${skill.name} — missing ${missing}.`);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
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
        rawCost: String(skill.system?.props?.cost ?? ""),
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
      if (hasMain && hasOff) {
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
    }

    // Both first-entry and multi-pass re-entry: re-snapshot eligible
    // targets (defeated enemies from pass 1 are excluded automatically by
    // the hp <= 0 filter inside the snapshot helpers) and run the target
    // picker for the next weapon in the queue.
    const eligibleRaw = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, director.ctx.turnSnapshot, { category: "enemy" })
      : snapshotEligibleTargets(director.combat, director.ctx.turnSnapshot, { category: "enemy" });

    // RAW Core p.70 — a Covered creature "cannot be targeted by melee
    // attacks until the start of [the guarder's] next turn". Filter them
    // out when the current weapon's range is Melee. Ranged weapons see
    // them normally.
    const currentWeaponForRange = director.ctx.pendingPasses?.[0];
    const isMeleeAttack = String(currentWeaponForRange?.range ?? "").trim().toLowerCase() === "melee";
    const eligible = isMeleeAttack
      ? eligibleRaw.filter((e) => !(e.conditions ?? []).includes("Covered"))
      : eligibleRaw;
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

    const result = await requestTargeting({
      director,
      eligible,
      mode: "exact",
      count: 1,
      titleText,
      cancelLabel,
    });
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
      const damageType = String(ar.damageType ?? "").toLowerCase();
      // Resource the damage burns through. Default is HP (regular
      // elemental damage); `mp` routes the same hit/crit pipeline but
      // writes to current_mp instead and skips elemental affinity (no
      // sheet supports "Vulnerable to MP damage"). Heal-style strings
      // ("healing", "recovery", "hp" as a bare type, "") are still
      // excluded from the damage path — those are recipe-driven grants.
      const isMpDamage = damageType === "mp";
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
        const fumbleThr = Math.max(1, attacker.fumbleThreshold ?? 1);
        const rollObj = await new Roll(`1d${dA} + 1d${dB}`).roll();
        const dice = rollObj.dice.map((d) => d.results?.[0]?.result ?? 0);
        const rA = dice[0] ?? 0;
        const rB = dice[1] ?? 0;
        const total = (rA + rB + checkBonus) | 0;
        const hr = Math.max(rA, rB);
        const isFumble = (rA <= fumbleThr && rB <= fumbleThr);
        const isCrit = (rA === rB) && !isFumble && rA >= 6;
        roll = { A1, A2, dA, dB, rA, rB, checkBonus, total, hr, isCrit, isFumble, opportunities: isCrit && !isFumble };
      }

      // Spells compare vs the target's Magic Defense (MDEF), other
      // skills vs regular Defense (DEF). Mirrors the accuracy widget's
      // Strike-vs-Magic icon choice in action-card.js.
      const isSpell = String(ar.skillType ?? "").toLowerCase() === "spell";

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
          // hit vs DEF (Skill) or MDEF (Spell).
          const defStat = isSpell
            ? (e.magicDefense ?? 0)
            : (e.defense ?? 0);
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
          const defStat = isSpell ? (e.magicDefense ?? 0) : (e.defense ?? 0);
          let hit = false;
          if (roll) {
            if (roll.isFumble) hit = false;
            else if (roll.isCrit) hit = true;
            else hit = roll.total >= defStat;
          }
          if (hit) hitTokenUuids.push(e.tokenUuid);
        }
      }

      director.ctx.actionResult = freezeActionResult({
        ...ar,
        roll,
        damageComputed: damageBonus,
        damage: damageObj,
        hasDamage,
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
      const checkBonus = weapon.checkBonus ?? 0;
      const damageBonus = weapon.damageBonus ?? 0;

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
      // Soul Weapon override: if the attacker carries a `soulWeaponElement`
      // AE flag (Spiritist Soul Weapon spell), its declared element
      // replaces the weapon's native damageType for this Attack. Looked
      // up on the live actor doc — falls through to the weapon's native
      // element when no override is active.
      const liveAttacker = await fromUuid(ar.attackerActorRef).catch(() => null);
      const overriddenElement = applySoulWeaponElementOverride(liveAttacker, weapon.damageType);
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
          dA, dB, rA, rB, checkBonus, total, hr,
          isCrit, isFumble,
          // Crit generates Opportunities (RAW Core p.68). Visual only here;
          // mechanical handling is GM-narrated for v1.
          opportunities: isCrit && !isFumble,
        },
        damage: {
          base: damageBonus,
          element: weapon.damageType,
          ignoreHR,
          finalIfHit: effectiveHr + damageBonus,
        },
        perTargetResults,
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

      const rollObj = await new Roll(`1d${dA} + 1d${dB}`).roll();
      const dice = rollObj.dice.map((d) => d.results?.[0]?.result ?? 0);
      const rA = dice[0] ?? 0;
      const rB = dice[1] ?? 0;
      const total = (rA + rB) | 0;
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
          dA, dB, rA, rB, checkBonus: 0, total, hr,
          isCrit, isFumble,
          opportunities: isCrit && !isFumble,
        },
        dl: DL,
        success,
        // statusValue is filled in by the card click (one of dazed /
        // shaken / slow / weak) before RESOLVE runs. See Confirm.onEnter.
        statusValue: null,
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
      saveDirectorState(director, {
        label: `Round ${dc?.round ?? 0} · ${ar.attacker?.name ?? "?"} · ${kindLabel} ${verbForKind}${passTag}`,
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
    }

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
        skillRange: ar.skillRange,
        skillTarget: ar.skillTarget,
        damageType: ar.damageType,
        hasDamage: ar.hasDamage,
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

    if (ar.kind === "Attack") {
      // Single-pass damage application. Multi-pass two-weapon attacks
      // loop back through COMPUTE → CONFIRM → RESOLVE per pass via the
      // CLEANUP→COMPUTE branch in the transition table, so each pass
      // resolves on its own card.
      const passLabel = ar.totalPasses > 1 ? ` (pass ${ar.passIndex}/${ar.totalPasses})` : "";
      for (const r of (ar.perTargetResults ?? [])) {
        if (!r.hit) continue;
        try {
          const actor = await fromUuid(r.actorUuid);
          if (!actor) { warn("RESOLVE: actor not found", r.actorUuid); continue; }
          const curHp = readPropNum(actor, ["current_hp", "hp"]);
          const maxHp = readPropNum(actor, ["max_hp"], curHp);
          if (r.affinity === "AB") {
            const healed = Math.max(0, r.damage);
            if (healed === 0) continue;
            const newHp = Math.min(maxHp, curHp + healed);
            await actor.update({ "system.props.current_hp": newHp });
            log(`Absorbed ${healed} ${r.name}${passLabel}: ${curHp} → ${newHp} (heal)`);
          } else if (r.damage > 0) {
            const { newHp, mercyFired } = await applyMercyClamp(actor, curHp, r.damage);
            await actor.update({ "system.props.current_hp": newHp });
            log(`Applied ${r.damage} dmg to ${r.name} [${r.affinity}]${passLabel}: ${curHp} → ${newHp}${mercyFired ? " (Mercy clamped at 1 HP)" : ""}`);
          } else {
            log(`No HP change for ${r.name} [${r.affinity}]${passLabel} (damage was ${r.damage})`);
          }
        } catch (e) {
          err("RESOLVE: failed to apply damage", r, e);
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
        changes: [],
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
              ui.notifications?.info(`${ar.attacker?.name ?? "Combatant"}: no equipment changes.`);
            } else {
              // Toast summary: 1-line per change. Foundry truncates long
              // notifications gracefully so don't worry about wrapping.
              const summary = (result?.changes ?? []).map((c) =>
                `${c.icon} ${c.slot}: ${c.fromName} → ${c.toName}`
              ).join("  •  ");
              ui.notifications?.info(`${ar.attacker?.name ?? "Combatant"} swapped equipment — ${summary}`);
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
                const qtyNote = r.skipped
                  ? ` [unique]`
                  : (r.deleted ? ` [last one consumed]` : ` [now x${r.after}]`);
                ui.notifications?.info(
                  `${ar.attacker?.name ?? "Combatant"} used ${cand.name}${qtyNote}`
                );
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
                ui.notifications?.info(
                  `${ar.attacker?.name ?? "Combatant"} crafted ${cand.name} (−${cost} IP, ${r.after}/${(ar.ip?.max ?? "?")} left)`
                );
                log(`Item created: ${cand.name} by ${ar.attacker?.name ?? "?"} (-${cost} IP)`);
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
      } else {
        const statusKey = String(ar.statusValue ?? "").toLowerCase();
        // Status definitions mirror HINDER_STATUSES in action-card.js.
        // Icons fall back to Foundry's built-in svg statuses; if a richer
        // pack is installed those overlay automatically.
        const STATUSES = {
          dazed:  { name: "Dazed",  iconUrl: "icons/svg/daze.svg",     attrShort: "INS" },
          shaken: { name: "Shaken", iconUrl: "icons/svg/terror.svg",   attrShort: "WLP" },
          slow:   { name: "Slow",   iconUrl: "icons/svg/clockwork.svg", attrShort: "DEX" },
          weak:   { name: "Weak",   iconUrl: "icons/svg/degen.svg",    attrShort: "MIG" },
        };
        const status = STATUSES[statusKey];
        if (!status) {
          warn("RESOLVE Hinder: no/unknown statusValue, skipping AE", ar.statusValue);
        } else {
          try {
            const targetActor = await fromUuid(ar.target?.actorUuid);
            if (!targetActor) {
              warn("RESOLVE Hinder: target actor not found", ar.target?.actorUuid);
            } else {
              const aeData = {
                name: status.name,
                icon: status.iconUrl,
                origin: ar.attacker?.actorUuid ?? null,
                flags: {
                  core: { statusId: statusKey },
                  "fabula-ultima-companion": {
                    directorHinder: {
                      sourceActorUuid: ar.attacker?.actorUuid ?? null,
                      penalisedAttribute: status.attrShort,
                      appliedAtRound: director.dCombat?.round ?? 0,
                    },
                  },
                },
                duration: {
                  startRound: director.dCombat?.round ?? 0,
                  startTurn: 0,
                },
                // No `changes` yet — actual −2 to opposed checks involving
                // the penalised attribute lands when we wire Opposed Checks
                // (Phase D.7 Objective, or earlier if Guard's +2 needs it).
                changes: [],
              };
              const [eff] = await targetActor.createEmbeddedDocuments("ActiveEffect", [aeData]);
              log(`Hinder: ${status.name} applied to ${ar.target.name} (effect ${eff?.id ?? "?"})`);
              ui.notifications?.info(`${ar.target.name} is now ${status.name}.`);
            }
          } catch (e) {
            warn("RESOLVE Hinder: failed to apply status AE", e);
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
                ui.notifications?.info(`Encyclopedia updated: ${ar.target?.name ?? "target"} (${result.previousBest} → ${result.newBest})`);
              } else {
                log(`Study: no improvement for ${ar.target?.name ?? uuid} (roll ${ar.roll.total}, best ${result?.previousBest ?? "?"})`);
              }
              break;  // first successful uuid wins; don't double-record
            } catch (e) {
              warn("RESOLVE Study: recordResult threw on", uuid, e);
            }
          }

          // Token VFX (green marker + audio cue) — mirrors the legacy
          // encyclopedia VFX so the flavor lines up. Awaits the duration so
          // the encyclopedia opens AFTER the marker has settled. Asset URLs
          // are in the director's preload list, so first use during a
          // battle is lag-free.
          try {
            await playStudyVfx({ targetTokenUuid: ar.target?.tokenUuid, durationMs: 2500 });
          } catch (e) {
            warn("RESOLVE Study: playStudyVfx threw", e);
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
    if (director.dCombat) director.dCombat.currentTurnResolved = true;
    // Label describes what the GM lands at on rewind: a checkpoint
    // AFTER this action's commit — resume routes via TURN_END → next
    // turn picker. For multi-pass attacks, distinguish the pass so
    // pass-1 vs pass-2 checkpoints are unambiguous in the list.
    const rvDc = director.dCombat;
    const rvName = rvDc?.current?.name ?? ar?.attacker?.name ?? "?";
    const rvPassTag = (ar?.totalPasses ?? 1) > 1
      ? ` (Pass ${ar.passIndex}/${ar.totalPasses})`
      : "";
    saveDirectorState(director, {
      label: `Round ${rvDc?.round ?? 0} · After ${rvName}'s Action${rvPassTag}`,
      description: describeActionForRewind(ar),
    }).catch((e) => warn("RESOLVE: saveDirectorState failed", e));

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
    if (director.dCombat) {
      // Capture the "just acted" name + round BEFORE nextTurn so the
      // rewind label reflects whose turn ended (nextTurn clears
      // currentCombatantId and may advance the round on a wrap).
      const teJustActedName = director.dCombat.current?.name
        ?? director.ctx.turnSnapshot?.name ?? "?";
      const teRoundEnded = director.dCombat.round ?? 0;
      try {
        const r = director.dCombat.nextTurn();
        director.ctx.endOfRound = !!r.wrappedRound;
        director.ctx.endOfCombat = !!r.ended;
        log(`TURN_END (dCombat) → round ${r.round}, currentSide=${r.currentSide}, eligible=${r.eligibleIds.length}${r.wrappedRound ? " [wrapped round]" : ""}${r.ended ? " [ended]" : ""}`);
      } catch (e) {
        warn("TURN_END: dCombat.nextTurn threw", e);
        director.ctx.endOfCombat = true;
      }
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
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Manual-fallback path: no dCombat, drive the Foundry combat directly.
    const combat = director.combat;
    if (!combat) {
      director.ctx.endOfCombat = true;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    const wasRound = combat.round;
    try {
      await combat.nextTurn();
    } catch (e) {
      warn("TURN_END: combat.nextTurn() threw", e);
      director.ctx.endOfCombat = true;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    director.ctx.endOfRound = (combat.round !== wasRound);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ROUND_END ─────────────────────────────────────────────────────────
const RoundEnd = {
  async onEnter(director) {
    log(`ROUND_END`);
    // v1 just passes through. Real implementation drains round-end triggers.
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
  [STATES.ABORTED]:         Aborted,
  [STATES.STOPPED]:         Stopped,
});
