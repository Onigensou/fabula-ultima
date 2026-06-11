/**
 * Migration: 2026-06-12-dungeon-burninghand-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Burning Hand" monster's skills to match descriptions.
 * Theme: grapple → burn the grappled → detonate. All fixes are config (existing
 * effect_kinds / formula identifiers / targeting sources) — no new primitives.
 *
 *   Grabby Hand (Active, DL13 DEX+INS opposed check → Grappled on failure) —
 *     already correct: isCheck:true + applies Grappled on `hit_action_targets`
 *     (= targets that failed to resist, the Pounce pattern). No change.
 *
 *   Burning Grasp (Passive — "at end of turn, +1 Burn on creatures Grappled by
 *     you") — two fixes:
 *       - charge-as-stack: apply Burn with `add_charges` + `ae_initial_charges:1`
 *         so it adds exactly +1 stack/turn (was `stack`, which spawned a whole new
 *         Burn AE each turn; default add would use the template's 3).
 *       - target the creatures THIS monster is grappling: targeting source
 *         `grappled_by_self` (was combat+enemy+filter_has_ae:Grappled = grappled
 *         by anyone).
 *     Reaction (turn_end / self / on → grasp_burn_chain) unchanged.
 *
 *   Fling (Attack — "also deal the same damage to your grappled creature, then
 *     remove Grappled") — was MISSING its core effect (only a no-op `grant`
 *     remove). Rebuilt onto `post_damage_effect_ref` (fires once after the attack
 *     damage, exposing HP_DEALT):
 *       - fling_dup_damage: deal_damage to `grappled_by_self`, amount `HP_DEALT`
 *         (the damage just dealt to the primary target = "the same damage"),
 *         `damage_ignore_affinity:true` so it lands the exact same number,
 *         cause "damage".
 *       - fling_remove_grappled: remove_tagged_ae grappled from `grappled_by_self`.
 *     Self-gates: `grappled_by_self` is empty when not grappling. The old
 *     creature_deals_damage reaction is dropped (post_damage fire-point replaces it).
 *
 *   Exploders Hand (Active — "Fire to all grappled-by-you; Blaze: consume each
 *     target's Burn, +Burn Stack ×10; remove Grappled") —
 *       - exploder_fire_damage: grant → deal_damage, `15 + AE_CHARGES_BURN * 10`.
 *         deal_damage builds a PER-TARGET resolver (actor = victim), so
 *         AE_CHARGES_BURN reads each grappled target's OWN Burn → the per-target
 *         ×10 Blaze (was ×5; no TARGET_ prefix needed). cause "damage".
 *       - exploder_consume_burn: ADDED — remove_tagged_ae burn on the targets
 *         ("Consume all Burn stacks on the target"), AFTER the damage reads them.
 *       - exploder_remove_grappled: grant → remove_tagged_ae.
 *       - targeting → `grappled_by_self` (was combat+enemy+filter_has_ae).
 *
 * Systemic `grant` mis-typing (rows authored as grant carrying damage/removal
 * fields → silent no-op) corrected throughout via deal_damage / remove_tagged_ae.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Burning Hand is a
 * co-dev world actor; co-dev sharing is via WORLD-DATA PUSH (this migration tracks
 * our intended data). See feedback_world_data_sharing_hazard.
 */

export const key = "2026-06-12-dungeon-burninghand-author";
export const description =
  "Fix Burning Hand dungeon skills: Burning Grasp +1 Burn/turn (add_charges + " +
  "ae_initial_charges:1) on grappled_by_self; rebuild Fling's missing dup-damage " +
  "(HP_DEALT → grappled_by_self) + retype removal; Exploders grant→deal_damage " +
  "(Blaze 15+AE_CHARGES_BURN*10), add Burn consume, retype removal, target " +
  "grappled_by_self. Grabby Hand already correct (isCheck).";

const ACTOR_NAME = "Burning Hand";

const PATCHES = {
  "Burning Grasp": {
    effect_table_replace: {
      "0": { effect_label: "grasp_burn_chain", effect_kind: "chain", chain_steps: "grasp_apply_burn" },
      "1": { effect_label: "grasp_apply_burn", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "grasp_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "1" },
      "2": { effect_label: "grasp_targets", effect_kind: "targeting", candidate_source: "grappled_by_self", mode: "all" },
    },
  },
  "Fling": {
    props_set: { post_damage_effect_ref: "fling_chain" },
    effect_table_replace: {
      "0": { effect_label: "fling_chain", effect_kind: "chain", chain_steps: "fling_dup_damage,fling_remove_grappled" },
      "1": { effect_label: "fling_dup_damage", effect_kind: "deal_damage", damage_element: "physical", damage_amount: "HP_DEALT", target_ref: "fling_grappled", damage_cause: "damage", damage_ignore_affinity: true, attacker_name: "Fling" },
      "2": { effect_label: "fling_remove_grappled", effect_kind: "remove_tagged_ae", filter_tag: "grappled", count: "all", target_ref: "fling_grappled" },
      "3": { effect_label: "fling_grappled", effect_kind: "targeting", candidate_source: "grappled_by_self", mode: "all" },
    },
    reaction_table_replace: {},
  },
  "Exploders Hand": {
    effect_table_replace: {
      "0": { effect_label: "exploder_chain", effect_kind: "chain", chain_steps: "exploder_fire_damage,exploder_consume_burn,exploder_remove_grappled" },
      "1": { effect_label: "exploder_fire_damage", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "15 + AE_CHARGES_BURN * 10", target_ref: "all_grappled_enemies", damage_cause: "damage", attacker_name: "Exploders Hand" },
      "2": { effect_label: "exploder_consume_burn", effect_kind: "remove_tagged_ae", filter_tag: "burn", count: "all", target_ref: "all_grappled_enemies" },
      "3": { effect_label: "exploder_remove_grappled", effect_kind: "remove_tagged_ae", filter_tag: "grappled", count: "all", target_ref: "all_grappled_enemies" },
      "4": { effect_label: "all_grappled_enemies", effect_kind: "targeting", candidate_source: "grappled_by_self", mode: "all" },
    },
  },
};

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

async function patchActor(actor, log) {
  let totalChanged = 0;
  for (const [skillName, spec] of Object.entries(PATCHES)) {
    const items = actor.items.filter((i) => i.name === skillName);
    if (!items.length) { log(`  [${actor.name}] "${skillName}": item not found — skipped`); continue; }
    for (const item of items) {
      let touched = false;

      if (spec.props_set) {
        const updates = {};
        for (const [k, v] of Object.entries(spec.props_set)) {
          if (item.system?.props?.[k] !== v) updates[`system.props.${k}`] = v;
        }
        if (Object.keys(updates).length) {
          await item.update(updates);
          log(`  [${actor.name}] "${skillName}".props: ${Object.keys(spec.props_set).join(", ")} set`);
          touched = true;
        }
      }

      if (spec.effect_table_replace) {
        const want = spec.effect_table_replace;
        if (!deepEqual(item.system?.props?.effect_table ?? {}, want)) {
          await item.update({ "system.props.-=effect_table": null });
          await item.update({ "system.props.effect_table": want });
          log(`  [${actor.name}] "${skillName}".effect_table: REPLACED`);
          touched = true;
        } else {
          log(`  [${actor.name}] "${skillName}".effect_table: already canonical`);
        }
      }

      if (spec.reaction_table_replace) {
        const want = spec.reaction_table_replace;
        if (!deepEqual(item.system?.props?.reaction_config_table ?? {}, want)) {
          await item.update({ "system.props.-=reaction_config_table": null });
          await item.update({ "system.props.reaction_config_table": want });
          log(`  [${actor.name}] "${skillName}".reaction_config_table: REPLACED (${Object.keys(want).length} rows)`);
          touched = true;
        }
      }

      if (touched) { totalChanged++; log(`  [${actor.name}] "${skillName}": UPDATED`); }
    }
  }
  return totalChanged;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) changed += await patchActor(actor, log);
  return { applied: true, summary: `Burning Hand skills patched (items updated: ${changed})` };
}
