/**
 * Migration: 2026-06-26-wandering-flame-tier2
 * ---------------------------------------------------------------------------
 * Second batch of "⭐️ Wandering Flame" champion skills, building on the
 * 2026-06-25-wandering-flame-author tier. Wires three more skills + removes a
 * duplicate. Continues the "author skill-by-skill, verify via harness" flow.
 *
 *   Zero Trigger: Ignition (Passive) — DONE. "Whenever a creature's Burn effect
 *     triggers, the Wandering Flame recovers 10 MP and gains 1 Zero Power."
 *     Implemented WITHOUT a Burn-specific engine event: the Burn DoT already
 *     fires the post-commit `creature_lose_resource` ledger event carrying the
 *     damage SOURCE (payload.originLabel = "Burn", the carrier AE name). A new
 *     GENERIC row filter `reaction_origin_filter` (skill-effects passesMatchFilters)
 *     lets a reaction scope to that source. So Ignition =
 *     creature_lose_resource / source "" / force, filtered resource "hp" +
 *     origin "Burn" → grant 10 MP + 1 Zero Power to self. Observer-aware
 *     (creature_lose_resource is in instance-settle's LEDGER_FAMILY), so it
 *     reacts to ANY creature's Burn. Fires once per Burn DAMAGE EVENT (i.e. per
 *     afflicted creature, not per stack) — the natural turn-start tick, plus
 *     Flame Claw / Meteor's explicit triggers (which now label their detonation
 *     origin "Burn", below). NOTE: a creature that ABSORBS/immunes Fire takes no
 *     HP loss → no event → no Ignition gain (incl. the Wandering Flame's own
 *     Fire-absorbed self-Burn); that's the intended "Burn did damage" semantics.
 *
 *   Zero Power: Meteor Impact (6 Zero Power, All Enemy) — DONE. Base 10 Fire to
 *     all enemies via the no-check profile (damage_bonus 10, unchanged; the
 *     6-ZP cost is auto-debited from the `cost` field). on_activate_effect_ref →
 *     meteor_unleash chain: (1) meteor_detonate — "trigger ALL Burn stacks": one
 *     Burn tick PER stack = deal_damage fire `AE_CHARGES_BURN * ceil(MAX_HP*0.1)`
 *     to action_targets (per-victim resolver: AE_CHARGES_BURN + MAX_HP read the
 *     victim; non-burning targets evaluate 0 and are skipped). Labelled
 *     attacker_name "Burn" so each detonation counts as a Burn trigger (feeds
 *     Ignition). (2) meteor_halve — remove HALF the stacks, round up: adjust_charges
 *     Burn multiply 0.5 (floored next → leaves floor(N/2), i.e. removes ceil(N/2)).
 *     Detonate reads the full stack count BEFORE the halve (chain order). Mirrors
 *     Flame Claw's detonate + Overblaze's adjust_charges.
 *
 *   Diving Blaze Kick (Active, DEX+MIG, 15 MP, One Creature) — DONE base + rider.
 *     Base Fire damage via the Check profile (damage_bonus 50, unchanged). On hit
 *     vs a BURNING target, "remove 1 Burn stack and this skill gains Overflow":
 *     a self-scoped on-hit rider (creature_deals_damage / self / on, scoped by
 *     reaction_source_skill + TRIGGER_IS_SELF, gated TARGET_AE_CHARGES_BURN >= 1)
 *     → chain (1) blaze_remove_burn — adjust_charges Burn -1 on the hit target;
 *     (2) blaze_overflow — Overflow spillover: deal the SAME dealt Fire damage
 *     (DAMAGE_DEALT, affinity-flat so every enemy takes the identical number) to
 *     all OTHER enemies (targeting category enemy, exclude_self + exclude_action_
 *     targets). Mirrors Flame Claw's scoping; the spillover is the "gains Overflow"
 *     upgrade, the Burn-removal its cost.
 *
 *   Flame Claw — re-labelled. Its flameclaw_trigger_burn detonation now carries
 *     attacker_name "Burn" (was "Flame Claw") so its triggered tick reads as a
 *     Burn trigger (origin "Burn") and feeds Ignition, consistent with Meteor.
 *
 *   Heat Up (Passive) — REMOVED. A blank-description duplicate of Rising Fire
 *     ("Heat Rise"), per the user. It is a skill_passive_list display entry with
 *     NO backing item, so removal = delete the list key (KLfFgAnL5FlRcx3B).
 *
 *   Zero Power: Overblaze — REMOVED. An orphan skill_active_list entry
 *     (oeF9j3TxXtuGZJLP) the co-dev authored but never built a backing item for;
 *     the user opted to drop the phantom rather than build it. Removal = delete
 *     the list key. (The regular "Overblaze" Active skill is separate + stays.)
 *
 * Requires the engine additions shipped alongside: reaction_origin_filter
 * (passesMatchFilters, for Ignition) + the skill creature_deals_damage payload
 * carrying finalValue (state-handlers, so Diving Blaze's DAMAGE_DEALT spillover
 * resolves). RUN ONCE (NOT manifest-tagged
 * idempotent) so it won't re-apply over a co-dev's later edits; patch logic is
 * still drift-safe if re-run. Wandering Flame is co-dev world data — delivery is
 * via WORLD-DATA PUSH (feedback_world_data_sharing_hazard), the USER's call.
 */

export const key = "2026-06-26-wandering-flame-tier2";
export const description =
  "Wandering Flame tier 2: Zero Trigger Ignition (creature_lose_resource + " +
  "reaction_origin_filter \"Burn\" → +10 MP +1 ZP); Zero Power Meteor Impact " +
  "(per-stack Burn detonate + halve stacks); Diving Blaze Kick (on-hit-vs-Burn " +
  "remove 1 Burn + Overflow spillover). Flame Claw detonation re-labelled origin " +
  "\"Burn\". Heat Up + Zero Power: Overblaze phantom list entries removed.";

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

// ── Zero Trigger: Ignition ────────────────────────────────────────────────
const IGNITION_REACTION_TABLE = {
  "0": {
    reaction_trigger: "creature_lose_resource",
    reaction_source: "",
    reaction_passive_mode: "force",
    reaction_resource_filter: "hp",
    reaction_origin_filter: "Burn",
    reaction_effect_ref: "ignition_gain",
  },
};
const IGNITION_EFFECT_TABLE = {
  "0": { effect_label: "ignition_gain", effect_kind: "chain", chain_steps: "ignition_mp,ignition_zp" },
  "1": { effect_label: "ignition_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: "10", target_ref: "self" },
  "2": { effect_label: "ignition_zp", effect_kind: "grant", grant_resource: "zero_power", grant_amount: "1", target_ref: "self" },
};

// ── Zero Power: Meteor Impact ─────────────────────────────────────────────
const METEOR_ON_ACTIVATE = "meteor_unleash";
const METEOR_EFFECT_TABLE = {
  "0": { effect_label: "meteor_unleash", effect_kind: "chain", chain_steps: "meteor_detonate,meteor_halve" },
  // Trigger ALL Burn stacks: one tick per stack = N × ceil(10% Max HP). Per-victim
  // resolver — AE_CHARGES_BURN + MAX_HP read each target; 0 stacks → 0 → skipped.
  // attacker_name "Burn" so it reads as a Burn trigger (feeds Ignition).
  "1": { effect_label: "meteor_detonate", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "AE_CHARGES_BURN * ceil(MAX_HP * 0.1)", target_ref: "action_targets", damage_cause: "damage", attacker_name: "Burn", damage_verbosity: "full" },
  // Remove half the stacks, round up: multiply 0.5 → floor leaves floor(N/2).
  "2": { effect_label: "meteor_halve", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "multiply", charge_amount: "0.5", target_ref: "action_targets" },
};

// ── Diving Blaze Kick ─────────────────────────────────────────────────────
const DIVING_REACTION_TABLE = {
  "0": {
    reaction_trigger: "creature_deals_damage",
    reaction_source: "self",
    reaction_passive_mode: "on",
    condition_formula: "TRIGGER_IS_SELF == 1 && TARGET_AE_CHARGES_BURN >= 1",
    reaction_effect_ref: "blaze_on_hit",
    reaction_source_skill: "Diving Blaze Kick",
  },
};
const DIVING_EFFECT_TABLE = {
  "0": { effect_label: "blaze_on_hit", effect_kind: "chain", chain_steps: "blaze_remove_burn,blaze_overflow" },
  "1": { effect_label: "blaze_remove_burn", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "subtract", charge_amount: "1", target_ref: "hit_action_targets" },
  // "Gains Overflow" = spill the SAME dealt Fire damage onto every OTHER enemy.
  // DAMAGE_DEALT = the primary hit's post-affinity value; ignore_affinity so each
  // other enemy takes the identical number (Overflow = the one hit spread to all).
  "2": { effect_label: "blaze_overflow", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "DAMAGE_DEALT", target_ref: "blaze_other_enemies", damage_cause: "damage", damage_ignore_affinity: true, attacker_name: "Diving Blaze Kick", damage_verbosity: "full" },
  "3": { effect_label: "blaze_other_enemies", effect_kind: "targeting", candidate_source: "combat", category: "enemy", mode: "all", exclude_self: true, exclude_action_targets: true, skip_when_passive: true },
};

// ── Flame Claw re-label (detonation origin → "Burn") ──────────────────────
const FLAME_CLAW_EFFECT_TABLE = {
  "0": { effect_label: "flameclaw_blaze", effect_kind: "chain", chain_steps: "flameclaw_trigger_burn,flameclaw_consume_burn" },
  "1": { effect_label: "flameclaw_trigger_burn", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "ceil(MAX_HP * 0.1)", target_ref: "hit_action_targets", damage_cause: "damage", attacker_name: "Burn", damage_verbosity: "full" },
  "2": { effect_label: "flameclaw_consume_burn", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "subtract", charge_amount: "1", target_ref: "hit_action_targets" },
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
    // Zero Trigger: Ignition — reaction only (no base damage).
    const ig = actor.items.find((i) => i.name === "Zero Trigger: Ignition");
    if (ig) changed += await patchSkillTable(ig, IGNITION_EFFECT_TABLE, IGNITION_REACTION_TABLE, log, `${actor.name}/Ignition`);

    // Zero Power: Meteor Impact — on_activate chain.
    const me = actor.items.find((i) => i.name === "Zero Power: Meteor Impact");
    if (me) {
      changed += await patchSkillTable(me, METEOR_EFFECT_TABLE, null, log, `${actor.name}/Meteor Impact`);
      if (me.system?.props?.on_activate_effect_ref !== METEOR_ON_ACTIVATE) {
        await me.update({ "system.props.on_activate_effect_ref": METEOR_ON_ACTIVATE });
        log(`  [${actor.name}/Meteor Impact] on_activate_effect_ref → ${METEOR_ON_ACTIVATE}`); changed++;
      }
    }

    // Diving Blaze Kick — on-hit rider (base damage unchanged).
    const db = actor.items.find((i) => i.name === "Diving Blaze Kick");
    if (db) changed += await patchSkillTable(db, DIVING_EFFECT_TABLE, DIVING_REACTION_TABLE, log, `${actor.name}/Diving Blaze Kick`);

    // Flame Claw — re-label detonation origin to "Burn" (feed Ignition). Reaction
    // table unchanged; only the effect_table's attacker_name moved to "Burn".
    const fc = actor.items.find((i) => i.name === "Flame Claw");
    if (fc) changed += await patchSkillTable(fc, FLAME_CLAW_EFFECT_TABLE, null, log, `${actor.name}/Flame Claw`);

    // Heat Up — remove the list-only display entry (no backing item): a blank
    // duplicate of Rising Fire.
    const passiveList = actor.system?.props?.skill_passive_list ?? {};
    for (const [k, v] of Object.entries(passiveList)) {
      if (String(v?.name ?? "").trim() === "Heat Up") {
        await actor.update({ [`system.props.skill_passive_list.-=${k}`]: null });
        log(`  [${actor.name}] removed Heat Up list entry (${k})`);
        changed++;
      }
    }

    // Zero Power: Overblaze — remove the orphan skill_active_list display entry.
    // It points to a non-existent backing item (oeF9j3TxXtuGZJLP) — a phantom the
    // co-dev authored but never built; the user opted to drop it (the regular
    // "Overblaze" Active skill is separate and stays).
    const activeList = actor.system?.props?.skill_active_list ?? {};
    for (const [k, v] of Object.entries(activeList)) {
      if (String(v?.name ?? "").trim() === "Zero Power: Overblaze") {
        await actor.update({ [`system.props.skill_active_list.-=${k}`]: null });
        log(`  [${actor.name}] removed Zero Power: Overblaze phantom entry (${k})`);
        changed++;
      }
    }
  }
  return {
    applied: true,
    summary: `Wandering Flame tier 2 patched (changes: ${changed}) — Ignition + Meteor Impact + Diving Blaze Kick + Flame Claw relabel + Heat Up removal`,
  };
}
