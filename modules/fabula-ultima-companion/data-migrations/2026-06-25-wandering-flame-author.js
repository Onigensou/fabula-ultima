/**
 * Migration: 2026-06-25-wandering-flame-author
 * ---------------------------------------------------------------------------
 * Author the Current Dungeon "⭐️ Wandering Flame" champion's skills to match
 * their descriptions. Built skill-by-skill; grows as each skill is finished +
 * verified. The actor shipped from the co-dev with flavor-text-only skills
 * (empty effect_table / reaction_config_table) — this wires the mechanics.
 *
 *   Spitblaze (Attack — Multi 2 Fire, DEX+INS vs MDEF) — DONE. Base HR+10 Fire
 *     via the NPC-attack pseudo-weapon profile (unchanged). On hit, inflict Oil
 *     to the hit targets: a self-scoped on-hit rider (creature_deals_damage /
 *     self / on, scoped by reaction_source_skill "Spitblaze" + TRIGGER_IS_SELF)
 *     → apply_ae Oil, ae_duplicate_mode "replace" (Oil is a binary status — the
 *     hub "Oil" AE carries affinity_6=VU, i.e. Fire vulnerability). Exact mirror
 *     of Dryad/Mustard Bomb's verified apply_oil.
 *
 *   Flamethrower (Active — Multi 3 Fire, DEX+INS vs MDEF, 30 MP) — DONE. Base
 *     HR+20 Fire via the spell/active profile; 30 MP via the legacy cost field.
 *     On hit, inflict Burn — or +3 stack if already Burning: a self-scoped
 *     on-hit rider (creature_deals_damage / self / on, scoped by
 *     reaction_source_skill "Flamethrower" + TRIGGER_IS_SELF) → apply_ae Burn,
 *     ae_duplicate_mode "add_charges" + ae_initial_charges "3" (fresh apply =
 *     3 charges / hub default; already present = +3). Mirror of Fire Slime/
 *     Fire Shot + Dryad/Ignis Finis verified apply_burn.
 *
 *   Flame Claw (Attack — DEX+MIG vs DEF, +10 Fire) — DONE. Base attack via the
 *     NPC-attack pseudo-weapon profile (unchanged). On hit vs a BURNING target,
 *     "consume 1 Burn stack and trigger its Burn effect": a self-scoped on-hit
 *     rider (creature_deals_damage / self / on, scoped by reaction_source_skill
 *     "Flame Claw" + TRIGGER_IS_SELF, gated by TARGET_AE_CHARGES_BURN >= 1) →
 *     chain [trigger = deal_damage fire ceil(MAX_HP*0.1) (one Burn DoT tick),
 *     consume = adjust_charges Burn -1] on the hit target. Mirrors Marigold/
 *     Blazing Tether's verified detonate (deal_damage + adjust_charges Burn -1);
 *     the DoT uses ceil (round up the 10% max-HP tick), per the boss design.
 *
 *   Overblaze (Active — Overflow Fire to all creatures + double every target's
 *     Burn, 30 MP) — DONE. Base 15 Fire to All Creature via the no-check Overflow
 *     profile (auto-hits all, single roll) + 30 MP via the legacy cost field. On
 *     activation, double each target's Burn: on_activate_effect_ref →
 *     overblaze_double_burn (adjust_charges Burn "multiply" 2 on action_targets).
 *     Exact mirror of Dryad/Enkindle's verified double-Burn. adjust_charges only
 *     touches targets that already carry Burn (it can't create) — others untouched.
 *
 *   Rising Fire (Passive) — DONE. Two reaction rows, no AE:
 *     1. round_start / force (lifecycle, reaction_source "") → rising_apply_burn:
 *        apply_ae Burn add_charges/3 to a targeting row (candidate_source "combat",
 *        mode "all", exclude_self FALSE, skip_when_passive) → Burn on ALL creatures
 *        incl. the Wandering Flame itself (it absorbs Fire, so its own Burn heals it
 *        + feeds the bonus below). Fire Slime burst pattern.
 *     2. creature_will_deal_damage / self / force (AMBIENT — no reaction_source_skill,
 *        so it boosts EVERY action) → rising_self_bonus: adjust_damage "add"
 *        "AE_CHARGES_BURN * 5" outgoing = +5 damage per Burn stack the WF holds.
 *        Salamander/Berserk adjust_damage rail. Verified: 4 stacks → +20.
 *
 *   Explosive Entrance (Passive — Unleash) — DONE. EXACT mirror of Fafnir's
 *     verified Dreadwyrm Descent so the DL save flows through the BD reaction-pill →
 *     action-card → Check UI (running save_check directly in the lifecycle reaction
 *     leaves players unable to react — no card). conflict_start / force / source ""
 *     → explosive_autocast (free_action, action_ref "self") AUTO-CASTS the skill as
 *     a real action (skill_target "All Enemy" → spawns a card); the card's
 *     on_activate_effect_ref "explosive_unleash" runs the chain: save_check (DEX+MIG
 *     vs DL 13, default interactive) on action_targets → on FAIL deal 30 Fire +
 *     apply Burn (add_charges/3) to save_failed_targets. Sets on_activate_effect_ref
 *     + skill_target in addition to the two tables.
 *
 *   Deferred (NOT in this migration):
 *   - Diving Blaze Kick — "remove 1 Burn stack and this skill gains Overflow."
 *     Overflow = an action-wide damage style ("hit all enemies, single accuracy
 *     roll"); granting it mid-attack to a single-target skill has no existing
 *     knob, and the Burn-removal is only that upgrade's COST. Blocked on a
 *     design decision; base damage already works untouched.
 *   - Zero Power: Meteor Impact / Zero Trigger: Ignition / Zero Power: Overblaze
 *     — later tiers (Burn trigger-all/consume, resource economy).
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Wandering Flame is
 * a co-dev world actor; sharing is via WORLD-DATA PUSH, not the migration
 * (feedback_world_data_sharing_hazard) — the USER decides when to push.
 */

export const key = "2026-06-25-wandering-flame-author";
export const description =
  "Author Wandering Flame dungeon skills: Spitblaze on-hit Oil (apply_ae Oil " +
  "replace, self-scoped); Flamethrower on-hit Burn (apply_ae Burn add_charges/3, " +
  "self-scoped); Flame Claw on-hit-vs-Burning trigger+consume Burn (deal_damage " +
  "ceil(MAX_HP*0.1) + adjust_charges Burn -1); Overblaze on_activate double all " +
  "targets' Burn (adjust_charges Burn multiply 2); Rising Fire round_start Burn-all " +
  "(targeting combat/all incl. self) + ambient +5 dmg/Burn-stack (adjust_damage " +
  "AE_CHARGES_BURN*5); Explosive Entrance conflict_start save (DEX+MIG DL13, enemies) " +
  "→ 30 Fire + Burn on failers. Diving Blaze Kick deferred (Overflow grant undefined).";

const NS = "fabula-ultima-companion";

function isWanderingFlame(a) {
  return String(a?.name ?? "").includes("Wandering Flame");
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

const SPITBLAZE_REACTION_TABLE = {
  "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "TRIGGER_IS_SELF == 1", reaction_effect_ref: "apply_oil", reaction_source_skill: "Spitblaze" },
};
const SPITBLAZE_EFFECT_TABLE = {
  "0": { effect_label: "apply_oil", effect_kind: "apply_ae", ae_template_ref: "Oil", target_ref: "hit_action_targets", ae_duplicate_mode: "replace" },
};

const FLAMETHROWER_REACTION_TABLE = {
  "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "TRIGGER_IS_SELF == 1", reaction_effect_ref: "apply_burn", reaction_source_skill: "Flamethrower" },
};
const FLAMETHROWER_EFFECT_TABLE = {
  "0": { effect_label: "apply_burn", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "hit_action_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
};

const FLAME_CLAW_REACTION_TABLE = {
  "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "TRIGGER_IS_SELF == 1 && TARGET_AE_CHARGES_BURN >= 1", reaction_effect_ref: "flameclaw_blaze", reaction_source_skill: "Flame Claw" },
};
const FLAME_CLAW_EFFECT_TABLE = {
  "0": { effect_label: "flameclaw_blaze", effect_kind: "chain", chain_steps: "flameclaw_trigger_burn,flameclaw_consume_burn" },
  "1": { effect_label: "flameclaw_trigger_burn", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "ceil(MAX_HP * 0.1)", target_ref: "hit_action_targets", damage_cause: "damage", attacker_name: "Flame Claw", damage_verbosity: "full" },
  "2": { effect_label: "flameclaw_consume_burn", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "subtract", charge_amount: "1", target_ref: "hit_action_targets" },
};

// Overblaze — no reaction table; fired from on_activate_effect_ref (set below).
const OVERBLAZE_ON_ACTIVATE = "overblaze_double_burn";
const OVERBLAZE_EFFECT_TABLE = {
  "0": { effect_label: "overblaze_double_burn", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "multiply", charge_amount: "2", target_ref: "action_targets" },
};

const RISING_FIRE_REACTION_TABLE = {
  "0": { reaction_trigger: "round_start", reaction_source: "", reaction_passive_mode: "force", reaction_effect_ref: "rising_apply_burn" },
  "1": { reaction_trigger: "creature_will_deal_damage", reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: "rising_self_bonus" },
};
const RISING_FIRE_EFFECT_TABLE = {
  "0": { effect_label: "rising_targets", effect_kind: "targeting", candidate_source: "combat", mode: "all", exclude_self: false, skip_when_passive: true },
  "1": { effect_label: "rising_apply_burn", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "rising_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
  "2": { effect_label: "rising_self_bonus", effect_kind: "adjust_damage", damage_operation: "add", damage_amount: "AE_CHARGES_BURN * 5", damage_stage: "outgoing" },
};

// Explosive Entrance mirrors Fafnir/Dreadwyrm Descent's verified pattern so the
// DL save flows through the BD reaction-pill → action-card → Check UI: the
// conflict_start reaction fires a free_action (action_ref "self") that AUTO-CASTS
// the skill as a real action (spawning a card), and the card's on_activate chain
// (set below) runs the save_check on the action's targets. Running save_check
// directly in the lifecycle reaction (no card) leaves players unable to react.
const EXPLOSIVE_ENTRANCE_ON_ACTIVATE = "explosive_unleash";
const EXPLOSIVE_ENTRANCE_SKILL_TARGET = "All Enemy";
const EXPLOSIVE_ENTRANCE_REACTION_TABLE = {
  "0": { reaction_trigger: "conflict_start", reaction_source: "", reaction_passive_mode: "force", reaction_effect_ref: "explosive_autocast" },
};
const EXPLOSIVE_ENTRANCE_EFFECT_TABLE = {
  "0": { effect_label: "explosive_unleash", effect_kind: "chain", chain_steps: "explosive_save,explosive_damage,explosive_burn" },
  "1": { effect_label: "explosive_autocast", effect_kind: "free_action", action_ref: "self", chain: false },
  "2": { effect_label: "explosive_save", effect_kind: "save_check", target_ref: "action_targets", save_attr1: "dex", save_attr2: "mig", save_dl: "13" },
  "3": { effect_label: "explosive_damage", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "30", target_ref: "save_failed_targets", damage_cause: "damage", attacker_name: "Explosive Entrance", damage_verbosity: "full" },
  "4": { effect_label: "explosive_burn", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "save_failed_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
};

async function patchSkillTable(item, effTable, reactTable, log, label) {
  let changed = 0;
  if (effTable && !deepEqual(item.system?.props?.effect_table ?? {}, effTable)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": effTable });
    log(`  [${label}] effect_table replaced`);
    changed++;
  }
  if (reactTable && !deepEqual(item.system?.props?.reaction_config_table ?? {}, reactTable)) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": reactTable });
    log(`  [${label}] reaction_config_table replaced`);
    changed++;
  }
  return changed;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter(isWanderingFlame);
  if (!actors.length) return { applied: false, summary: `No "Wandering Flame" actor found` };
  let changed = 0;
  for (const actor of actors) {
    const sp = actor.items.find((i) => i.name === "Spitblaze");
    if (sp) changed += await patchSkillTable(sp, SPITBLAZE_EFFECT_TABLE, SPITBLAZE_REACTION_TABLE, log, `${actor.name}/Spitblaze`);
    const fl = actor.items.find((i) => i.name === "Flamethrower");
    if (fl) changed += await patchSkillTable(fl, FLAMETHROWER_EFFECT_TABLE, FLAMETHROWER_REACTION_TABLE, log, `${actor.name}/Flamethrower`);
    const fc = actor.items.find((i) => i.name === "Flame Claw");
    if (fc) changed += await patchSkillTable(fc, FLAME_CLAW_EFFECT_TABLE, FLAME_CLAW_REACTION_TABLE, log, `${actor.name}/Flame Claw`);
    const ob = actor.items.find((i) => i.name === "Overblaze");
    if (ob) {
      changed += await patchSkillTable(ob, OVERBLAZE_EFFECT_TABLE, null, log, `${actor.name}/Overblaze`);
      if (ob.system?.props?.on_activate_effect_ref !== OVERBLAZE_ON_ACTIVATE) {
        await ob.update({ "system.props.on_activate_effect_ref": OVERBLAZE_ON_ACTIVATE });
        log(`  [${actor.name}/Overblaze] on_activate_effect_ref → ${OVERBLAZE_ON_ACTIVATE}`); changed++;
      }
    }
    const rf = actor.items.find((i) => i.name === "Rising Fire");
    if (rf) changed += await patchSkillTable(rf, RISING_FIRE_EFFECT_TABLE, RISING_FIRE_REACTION_TABLE, log, `${actor.name}/Rising Fire`);
    const ee = actor.items.find((i) => i.name === "Explosive Entrance");
    if (ee) {
      changed += await patchSkillTable(ee, EXPLOSIVE_ENTRANCE_EFFECT_TABLE, EXPLOSIVE_ENTRANCE_REACTION_TABLE, log, `${actor.name}/Explosive Entrance`);
      if (ee.system?.props?.on_activate_effect_ref !== EXPLOSIVE_ENTRANCE_ON_ACTIVATE) {
        await ee.update({ "system.props.on_activate_effect_ref": EXPLOSIVE_ENTRANCE_ON_ACTIVATE });
        log(`  [${actor.name}/Explosive Entrance] on_activate_effect_ref → ${EXPLOSIVE_ENTRANCE_ON_ACTIVATE}`); changed++;
      }
      if (ee.system?.props?.skill_target !== EXPLOSIVE_ENTRANCE_SKILL_TARGET) {
        await ee.update({ "system.props.skill_target": EXPLOSIVE_ENTRANCE_SKILL_TARGET });
        log(`  [${actor.name}/Explosive Entrance] skill_target → ${EXPLOSIVE_ENTRANCE_SKILL_TARGET}`); changed++;
      }
    }
  }
  return { applied: true, summary: `Wandering Flame skills patched (changes: ${changed}) — Spitblaze + Flamethrower + Flame Claw + Overblaze + Rising Fire + Explosive Entrance` };
}
