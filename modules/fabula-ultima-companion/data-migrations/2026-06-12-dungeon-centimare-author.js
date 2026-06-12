/**
 * Migration: 2026-06-12-dungeon-centimare-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Centimare" monster's skills to match descriptions.
 *
 *   ⚔️ Sting (Fire + inflict Oil) — apply_oil stack→replace (Oil is binary;
 *     Oil now grants Fire VU via the affinity AE — see dryad migration).
 *   ⚔️ Bite (Poison; 70% Envenomed, else Burn if already Envenomed) — Envenomed
 *     stack→replace + ae_initial_charges 1 (REQUIRED: the chance-gated branches
 *     read TARGET_AE_CHARGES_ENVENOMED, so Envenomed must carry a charge; also
 *     lets Scythe consume it). Burn stack→add_charges/3.
 *   Hellfire (Fire to all; inflict Burn) — Burn stack→add_charges/3.
 *   ⚔️ Scythe (Physical, Chain 2; detonate Envenomed/Burn) —
 *     - Detonation: per hit, if the target has Envenomed/Burn, deal the status's
 *       effect-damage AND consume 1 charge. Per the Journal: Envenomed = 15 flat
 *       poison; Burn = 10% Max HP fire. grant→deal_damage; chain each detonation
 *       with adjust_charges <status> subtract 1 (deletes the AE at 0).
 *     - Chain 2: a 2nd strike via free_action (action_ref "self", chain:true) —
 *       gated to fire exactly once by a "Scythe Lock" marker AE (creature_completes_
 *       attack / AE_COUNT_SCYTHE_LOCK==0 → apply lock + free_action restrike;
 *       round_end clears the lock). chain:true marks it a CHAIN strike (NOT a free
 *       attack) so it bypasses preventFreeAttack. No target_ref → the restrike
 *       re-targets per the Chain keyword (own accuracy check, may hit a different
 *       creature). Requires the chain-field engine (free_action chain flag +
 *       freeActions preventFreeAttack bypass) + adjust_charges — cross-module,
 *       hard refresh to go live.
 *
 * RUN ONCE (NOT manifest-tagged idempotent). Centimare is a co-dev world actor;
 * sharing is via WORLD-DATA PUSH (feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-12-dungeon-centimare-author";
export const description =
  "Fix Centimare dungeon skills: Sting Oil replace; Bite Envenomed replace+1charge / Burn add_charges/3; " +
  "Hellfire Burn add_charges/3; Scythe detonate Envenomed(15 poison)/Burn(10% MaxHP fire) + consume 1 charge, " +
  "Chain 2 via free_action(chain) one-shot restrike.";

const ACTOR_NAME = "Centimare";
const NS = "fabula-ultima-companion";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

const TABLES = {
  "Sting": {
    effect_table: {
      "0": { effect_label: "apply_oil", effect_kind: "apply_ae", ae_template_ref: "Oil", target_ref: "hit_action_targets", ae_duplicate_mode: "replace" },
    },
    reaction_config_table: {
      "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", reaction_effect_ref: "apply_oil" },
    },
  },
  "Bite": {
    effect_table: {
      "0": { effect_label: "apply_envenomed", effect_kind: "apply_ae", ae_template_ref: "Envenomed", target_ref: "trigger_subject", ae_duplicate_mode: "replace", ae_initial_charges: "1" },
      "1": { effect_label: "bite_burn_branch", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "trigger_subject", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
    },
    reaction_config_table: {
      "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "chance(70) && TARGET_AE_CHARGES_ENVENOMED == 0", reaction_effect_ref: "apply_envenomed" },
      "1": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "chance(70) && TARGET_AE_CHARGES_ENVENOMED > 0", reaction_effect_ref: "bite_burn_branch" },
    },
  },
  "Hellfire": {
    effect_table: {
      "0": { effect_label: "apply_burn", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "hit_action_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
    },
    reaction_config_table: {
      "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", reaction_effect_ref: "apply_burn" },
    },
  },
  "Scythe": {
    effect_table: {
      "0": { effect_label: "scythe_env_chain", effect_kind: "chain", chain_steps: "scythe_env_dot,scythe_env_consume" },
      "1": { effect_label: "scythe_env_dot", effect_kind: "deal_damage", damage_element: "poison", damage_amount: "15", target_ref: "trigger_subject", damage_cause: "damage", attacker_name: "Scythe" },
      "2": { effect_label: "scythe_env_consume", effect_kind: "adjust_charges", charge_ae_name: "Envenomed", charge_operation: "subtract", charge_amount: "1", target_ref: "trigger_subject" },
      "3": { effect_label: "scythe_burn_chain", effect_kind: "chain", chain_steps: "scythe_burn_dot,scythe_burn_consume" },
      "4": { effect_label: "scythe_burn_dot", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "round(MAX_HP * 0.1)", target_ref: "trigger_subject", damage_cause: "damage", attacker_name: "Scythe" },
      "5": { effect_label: "scythe_burn_consume", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "subtract", charge_amount: "1", target_ref: "trigger_subject" },
      "6": { effect_label: "scythe_chain2", effect_kind: "chain", chain_steps: "scythe_lock,scythe_restrike" },
      "7": { effect_label: "scythe_lock", effect_kind: "apply_ae", ae_template_ref: "Scythe Lock", target_ref: "self", ae_duplicate_mode: "replace" },
      "8": { effect_label: "scythe_restrike", effect_kind: "free_action", action_ref: "self", chain: true },
      "9": { effect_label: "scythe_lock_clear", effect_kind: "remove_tagged_ae", filter_tag: "scythe_lock", target_ref: "self" },
    },
    reaction_config_table: {
      "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "TARGET_AE_CHARGES_ENVENOMED > 0", reaction_effect_ref: "scythe_env_chain" },
      "1": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "TARGET_AE_CHARGES_BURN > 0", reaction_effect_ref: "scythe_burn_chain" },
      "2": { reaction_trigger: "creature_completes_attack", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "AE_COUNT_SCYTHE_LOCK == 0", reaction_effect_ref: "scythe_chain2" },
      "3": { reaction_trigger: "round_end", reaction_source: "", reaction_passive_mode: "on", reaction_effect_ref: "scythe_lock_clear" },
    },
  },
};

// "Scythe Lock" marker AE (embedded on Scythe) — gates Chain 2 to one restrike.
const SCYTHE_LOCK_AE = {
  name: "Scythe Lock",
  img: "icons/svg/sword.svg",
  transfer: false,
  system: { tags: ["scythe_lock"] },
  flags: { [NS]: { directorPermanent: true } },
};

function findItem(actor, name) {
  return actor.items.find((i) => i.name === name) || actor.items.find((i) => i.name.includes(name));
}

async function patchActor(actor, log) {
  let changed = 0;
  for (const [name, spec] of Object.entries(TABLES)) {
    const it = findItem(actor, name);
    if (!it) { log(`  [${actor.name}] "${name}": not found — skipped`); continue; }
    if (!deepEqual(it.system?.props?.effect_table ?? {}, spec.effect_table)) {
      await it.update({ "system.props.-=effect_table": null });
      await it.update({ "system.props.effect_table": spec.effect_table });
      log(`  [${actor.name}] ${it.name}.effect_table replaced`); changed++;
    }
    if (spec.reaction_config_table && !deepEqual(it.system?.props?.reaction_config_table ?? {}, spec.reaction_config_table)) {
      await it.update({ "system.props.-=reaction_config_table": null });
      await it.update({ "system.props.reaction_config_table": spec.reaction_config_table });
      log(`  [${actor.name}] ${it.name}.reaction_config_table replaced`); changed++;
    }
  }
  // Ensure the Scythe Lock marker AE exists on Scythe.
  const scythe = findItem(actor, "Scythe");
  if (scythe && !scythe.effects.some((e) => e.name === "Scythe Lock")) {
    await scythe.createEmbeddedDocuments("ActiveEffect", [SCYTHE_LOCK_AE]);
    log(`  [${actor.name}] Scythe: created "Scythe Lock" marker AE`); changed++;
  }
  return changed;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) changed += await patchActor(actor, log);
  return { applied: true, summary: `Centimare skills patched (changes: ${changed})` };
}
