/**
 * Migration: 2026-06-13-dungeon-marigold-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Marigold" monster's skills to match descriptions.
 *
 *   Thorn Whip (Attack — light Physical) — NO CHANGE. Already a plain Attack
 *     (Physical, damage_bonus 40, empty effect/reaction tables) = "Deal light
 *     Physical damage to a target." Listed here only for completeness.
 *
 *   Ignis Finis (Spell — Firestorm HR+43 Fire to two; Opportunity: Burn) — DONE.
 *     Mirrors Dryad's verified Ignis Finis. Base HR+43 Fire via the spell profile
 *     (damage_bonus is 43; the description text said HR+35, synced to 43). The
 *     Opportunity (Burn) is gated on a CRITICAL hit — the canonical FU Opportunity
 *     trigger — via the reaction's condition_formula "CRIT == 1" (creature_deals_
 *     damage / self / on → ignis_opportunity_burn). The prior 1-"up" cost chain
 *     was dropped: Marigold has 0 ultima points, so it would have always aborted.
 *     Burn applies add_charges/3 (Burn pools charges) to the hit targets.
 *
 *   Blazing Tether (Spell — move Burn between two creatures, then trigger Burn on
 *     both) — DONE. Reworked onto generic engine primitives (no bespoke logic):
 *       - target_sequence "tether_giver,tether_receiver" drives the two picks at
 *         the TARGET phase, in order, each cancelable back to the Action Menu — so
 *         casting immediately prompts giver then receiver (no target-self step).
 *         skill_target stays "Two Creature" (descriptive); the sequence
 *         short-circuits the normal skill_target picker.
 *       - tether_giver (targeting / combat) gated by target_filter
 *         "AE_CHARGES_BURN >= 1" — the giver MUST carry Burn.
 *       - tether_receiver (targeting / combat) with exclude "tether_giver" — can't
 *         be the same creature. The picks are carried to RESOLVE and the chain's
 *         give/take/detonate rows reuse them by ref (no re-prompt).
 *       - tether_amount (prompt_number) — the caster enters how many Burn stacks to
 *         move, 0..giver's Burn (prompt_max "AE_CHARGES_BURN", prompt_max_ref
 *         tether_giver). Stored as VAR_MOVE_AMOUNT.
 *       - Move: receiver += VAR_MOVE_AMOUNT via apply_ae Burn add_charges (CREATES
 *         the AE if the receiver has none — adjust_charges can't), giver -= same
 *         via adjust_charges subtract (the giver is guaranteed to carry Burn).
 *       - Detonate BOTH (target_ref "tether_giver,tether_receiver" union): one Burn
 *         tick each — deal_damage min(AE_CHARGES_BURN,1)*round(MAX_HP*0.1) (per
 *         victim; 0 = skipped, so a 0-Burn creature is untouched) + adjust_charges
 *         Burn -1 (the normal "Burn ticked" charge consumption).
 *     The two targeting rows lead the chain so the picks resolve in order (giver
 *     first), and later rows reuse the memoized picks with no re-prompt.
 *
 * Engine added for this skill (all generic, registry-backed, self-heal on boot):
 *   - target_ref accepts a comma list → union (resolveTargetRef).
 *   - targeting `target_filter` (per-candidate keep-if-truthy formula) +
 *     `exclude` (membership exclusion by ref) — resolveTargetingRow.
 *   - `prompt_number` effect_kind + ctx chainVars + VAR_<NAME> formula identifier.
 *   - apply_ae `ae_initial_charges` / `_max` are now FORMULA-aware (so the give
 *     can add VAR_MOVE_AMOUNT charges, creating the AE if absent).
 *   - `target_sequence` skill prop — multi-step TARGET-phase picking that resolves
 *     a list of targeting rows in order (cancel → Action Menu), carried to RESOLVE.
 *   Cross-module → live needs a hard refresh.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Marigold is a co-dev
 * world actor; sharing is via WORLD-DATA PUSH (feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-13-dungeon-marigold-author";
export const description =
  "Fix Marigold dungeon skills: Ignis Finis Opportunity Burn gated on CRIT " +
  "(drop the 0-up cost chain), desc HR+35→43, Burn add_charges/3 (mirrors Dryad); " +
  "Blazing Tether reworked — skill_target Self, giver (target_filter has-Burn) → " +
  "receiver (exclude giver) → prompt_number amount → move via 2 adjust_charges → " +
  "detonate both (union target_ref) one Burn tick + -1 charge.";

const ACTOR_NAME = "Marigold";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// ── Ignis Finis (mirror Dryad's verified pattern) ──────────────────────────
const IGNIS_EFFECT_TABLE = {
  "0": { effect_label: "ignis_opportunity_burn", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "hit_action_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
};
const IGNIS_REACTION_TABLE = {
  "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "CRIT == 1", reaction_effect_ref: "ignis_opportunity_burn" },
};

// ── Blazing Tether (move Burn between two, then trigger Burn on both) ───────
const TETHER_EFFECT_TABLE = {
  "0": { effect_label: "tether_giver", effect_kind: "targeting", candidate_source: "combat", target_filter: "AE_CHARGES_BURN >= 1", mode: "exact", count: "1", auto_target: "confirm" },
  "1": { effect_label: "tether_receiver", effect_kind: "targeting", candidate_source: "combat", exclude: "tether_giver", mode: "exact", count: "1", auto_target: "confirm" },
  "2": { effect_label: "tether_amount", effect_kind: "prompt_number", prompt_var: "move_amount", prompt_label: "Burn stacks to move?", prompt_min: "0", prompt_max: "AE_CHARGES_BURN", prompt_max_ref: "tether_giver" },
  "3": { effect_label: "tether_chain", effect_kind: "chain", chain_steps: "tether_amount,tether_give,tether_take,tether_dot,tether_consume" },
  "4": { effect_label: "tether_give", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "tether_receiver", ae_duplicate_mode: "add_charges", ae_initial_charges: "VAR_MOVE_AMOUNT" },
  "5": { effect_label: "tether_take", effect_kind: "adjust_charges", charge_ae_name: "Burn", target_ref: "tether_giver", charge_operation: "subtract", charge_amount: "VAR_MOVE_AMOUNT" },
  "6": { effect_label: "tether_dot", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "min(AE_CHARGES_BURN, 1) * round(MAX_HP * 0.1)", target_ref: "tether_giver,tether_receiver", damage_cause: "damage", attacker_name: "Blazing Tether" },
  "7": { effect_label: "tether_consume", effect_kind: "adjust_charges", charge_ae_name: "Burn", target_ref: "tether_giver,tether_receiver", charge_operation: "subtract", charge_amount: "1" },
};

async function patchSkillTable(item, effTable, reactTable, descFn, log, label) {
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
  if (descFn) {
    const cur = String(item.system?.props?.description ?? "");
    const next = descFn(cur);
    if (next !== cur) { await item.update({ "system.props.description": next }); log(`  [${label}] description updated`); changed++; }
  }
  return changed;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) {
    const ig = actor.items.find((i) => i.name === "Ignis Finis");
    if (ig) changed += await patchSkillTable(ig, IGNIS_EFFECT_TABLE, IGNIS_REACTION_TABLE, (d) => d.replace(/HR\s*\+\s*35/gi, "HR + 43").replace(/】\s*35/g, "】43"), log, `${actor.name}/Ignis Finis`);

    const bt = actor.items.find((i) => i.name === "Blazing Tether");
    if (bt) {
      changed += await patchSkillTable(bt, TETHER_EFFECT_TABLE, null, null, log, `${actor.name}/Blazing Tether`);
      if (bt.system?.props?.on_activate_effect_ref !== "tether_chain") {
        await bt.update({ "system.props.on_activate_effect_ref": "tether_chain" });
        log(`  [${actor.name}/Blazing Tether] on_activate_effect_ref → tether_chain`); changed++;
      }
      // target_sequence drives the two picks at the TARGET phase (giver must
      // carry Burn → receiver excludes the giver), cancelable back to the menu.
      // skill_target stays descriptive ("Two Creature") — the sequence
      // short-circuits the normal skill_target picker (no target-self).
      if (bt.system?.props?.target_sequence !== "tether_giver,tether_receiver") {
        await bt.update({ "system.props.target_sequence": "tether_giver,tether_receiver" });
        log(`  [${actor.name}/Blazing Tether] target_sequence → tether_giver,tether_receiver`); changed++;
      }
      if (bt.system?.props?.skill_target !== "Two Creature") {
        await bt.update({ "system.props.skill_target": "Two Creature" });
        log(`  [${actor.name}/Blazing Tether] skill_target → Two Creature`); changed++;
      }
    }
  }
  return { applied: true, summary: `Marigold skills patched (changes: ${changed}) — Ignis Finis + Blazing Tether (Thorn Whip unchanged)` };
}
