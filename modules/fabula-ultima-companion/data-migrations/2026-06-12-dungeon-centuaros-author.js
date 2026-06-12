/**
 * Migration: 2026-06-12-dungeon-centuaros-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Centuaros" monster's skills to match descriptions.
 * Built skill-by-skill; this file grows as each skill is finished + verified.
 *
 *   Fiery Onslaught (Active, Overflow — Fire to all enemy; Blaze: per target
 *     remove all Burn, +5×stacks removed bonus damage) — DONE.
 *       - blaze_consume was typed `grant` (the systemic mistyping → silent
 *         no-op), so Burn was never consumed. Retype → `remove_tagged_ae`
 *         (filter_tag burn, count all, hit_action_targets); strip the stray
 *         grant_resource/grant_amount fields.
 *       - The Blaze reaction (creature_will_deal_damage / self → blaze_chain)
 *         was passive_mode `ask`; an NPC's engine-mandatory Blaze should auto-
 *         fire → `on` (matches Blast Breath / Salamander Breath).
 *     Base Fire damage already emits via the action profile (isCheck:false +
 *     damage_bonus 10 + type_damage Fire → effectiveHr 0 + damageBonus). The
 *     per-target +5×each-target's-own-Burn relies on the multi-target outgoing
 *     fix in computeSenderDamageBonuses (evaluate ops PER SUBJECT) shipped in
 *     the same change — a script edit, not data.
 *
 *   Blazing Sweep (Attack — Multi 3 Physical + Burn; if already Burning, +3
 *     rounds; if all hit, may repeat at -50% dmg / -1 acc, compounding) — DONE.
 *       - repeat_sweep: open_action_menu(free_mode) → the new `free_action`
 *         effect_kind with action_ref "self" (re-perform Blazing Sweep directly,
 *         no 1-item menu). Keeps the compounding bonus formulas
 *         (check -(AE_CHARGES_BLAZING_SWEEP_LOCK), damage floor(38*pow(0.5,N))-38).
 *         The all-hit reaction re-fires each repeat → another lock + another
 *         free_action, so the compounding is automatic. Requires the free_action
 *         engine (skill-effects.js + DECLARE preset + FREE_ACTION_WINDOW) — cross
 *         module, needs a hard refresh to go live.
 *       - sweep_cleanup: grant (silent no-op) → remove_tagged_ae (filter_tag
 *         sweep_lock, self) so the repeat-lock counter actually clears at round
 *         end (else next turn's sweep starts pre-penalized).
 *       - repeat_lock: ae_duplicate_mode "stack" → "add_charges" (+1) so the lock
 *         is ONE growing AE/badge (charge-as-stack), matching the Chomp Kill-
 *         Frenzy pattern; AE_CHARGES_BLAZING_SWEEP_LOCK reads the same total.
 *
 *   Prepare to Charge (Active — remove Slow OR, if none, gain Swift; next turn,
 *     +1 action) — DONE. Two effects:
 *       1. pc_apply_swift (apply common "Swift" buff, gated condition_formula
 *          "AE_COUNT_SLOW == 0" — evaluated BEFORE removal) + pc_remove_slow
 *          (remove_tagged_ae "slow"). Relies on the NEW effect-row condition gate
 *          in applyEffectRow (script edit) + the Slow AE being tagged "slow".
 *       2. pc_charge: apply a UNIQUE "Prepare to Charge" AE (change
 *          system.props.bonus_activation +1, duration 1 round) — readActivations
 *          folds bonus_activation into next round's turn count → +1 action; the AE
 *          ticks off at the owner's next turn start (after the round-start reset
 *          reads it), so the extra activation lands then the AE clears. ZERO new
 *          engine primitive for the extra action — pure data on an existing seam.
 *     Also tags the shared Debuff-hub "Slow" AE with "slow" (shipped with only
 *     "debuff") so remove_tagged_ae can target it — reusable for any "remove Slow".
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Centuaros is a
 * co-dev world actor; sharing is via WORLD-DATA PUSH (feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-12-dungeon-centuaros-author";
export const description =
  "Fix Centuaros dungeon skills: Fiery Onslaught blaze_consume grant→remove_tagged_ae " +
  "(consume Burn) + Blaze reaction ask→on; Blazing Sweep repeat_sweep open_action_menu→free_action " +
  "(action_ref self), sweep_cleanup grant→remove_tagged_ae, repeat_lock stack→add_charges; " +
  "Prepare to Charge built (remove Slow / gain Swift conditional + unique +1-activation AE); " +
  "tag shared Debuff 'Slow' AE with 'slow'.";

const ACTOR_NAME = "Centuaros";
const NS = "fabula-ultima-companion";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// Fiery Onslaught — clone+patch the effect_table; return it or null if no drift.
function buildFieryEffectTable(item) {
  const src = item.system?.props?.effect_table;
  if (!src || typeof src !== "object") return null;
  const table = foundry.utils.deepClone(src);
  for (const row of Object.values(table)) {
    if (row?.effect_label === "blaze_consume") {
      row.effect_kind = "remove_tagged_ae";
      row.filter_tag = "burn";
      row.count = "all";
      row.target_ref = "hit_action_targets";
      delete row.grant_resource;
      delete row.grant_amount;
    }
  }
  return table;
}

function buildFieryReactionTable(item) {
  const src = item.system?.props?.reaction_config_table;
  if (!src || typeof src !== "object") return null;
  const table = foundry.utils.deepClone(src);
  for (const row of Object.values(table)) {
    if (row?.reaction_effect_ref === "blaze_chain" && row.reaction_passive_mode !== "on") {
      row.reaction_passive_mode = "on";
    }
  }
  return table;
}

async function patchFieryOnslaught(actor, log) {
  const item = actor.items.find((i) => i.name === "Fiery Onslaught");
  if (!item) { log(`  [${actor.name}] "Fiery Onslaught": item not found — skipped`); return 0; }
  let changed = 0;

  const et = buildFieryEffectTable(item);
  if (et && !deepEqual(item.system?.props?.effect_table ?? {}, et)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": et });
    log(`  [${actor.name}] Fiery Onslaught.effect_table: blaze_consume grant→remove_tagged_ae`);
    changed++;
  }

  const rt = buildFieryReactionTable(item);
  if (rt && !deepEqual(item.system?.props?.reaction_config_table ?? {}, rt)) {
    await item.update({ "system.props.reaction_config_table": rt });
    log(`  [${actor.name}] Fiery Onslaught.reaction: Blaze ask→on`);
    changed++;
  }
  return changed;
}

// Blazing Sweep — clone+patch the effect_table:
//   repeat_sweep  open_action_menu(free_mode) → free_action(action_ref "self")
//   sweep_cleanup grant → remove_tagged_ae (clear the repeat-lock at round end)
//   repeat_lock   stack → add_charges (+1) — one growing lock AE/badge
function buildBlazingSweepEffectTable(item) {
  const src = item.system?.props?.effect_table;
  if (!src || typeof src !== "object") return null;
  const table = foundry.utils.deepClone(src);
  for (const row of Object.values(table)) {
    if (row?.effect_label === "repeat_sweep") {
      row.effect_kind = "free_action";
      row.action_ref = "self";
      // free_action keeps the compounding bonus formulas + cost cap.
      // Drop the open_action_menu/free_mode-specific fields.
      delete row.allowed_types;
      delete row.free_mode;
      delete row.rebuild_card;
      delete row.count;
      delete row.target_ref;
      delete row.grant_resource;
      delete row.grant_amount;
    }
    if (row?.effect_label === "sweep_cleanup") {
      row.effect_kind = "remove_tagged_ae";
      row.filter_tag = "sweep_lock";
      row.count = "all";
      row.target_ref = "self";
      delete row.grant_resource;
      delete row.grant_amount;
    }
    if (row?.effect_label === "repeat_lock") {
      row.ae_duplicate_mode = "add_charges";
      row.ae_initial_charges = "1";
    }
  }
  return table;
}

async function patchBlazingSweep(actor, log) {
  const item = actor.items.find((i) => i.name === "Blazing Sweep");
  if (!item) { log(`  [${actor.name}] "Blazing Sweep": item not found — skipped`); return 0; }
  const et = buildBlazingSweepEffectTable(item);
  if (et && !deepEqual(item.system?.props?.effect_table ?? {}, et)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": et });
    log(`  [${actor.name}] Blazing Sweep.effect_table: repeat_sweep→free_action, sweep_cleanup→remove_tagged_ae, repeat_lock→add_charges`);
    return 1;
  }
  return 0;
}

// Tag the shared Debuff-hub "Slow" AE with "slow" (shipped with only "debuff") so
// remove_tagged_ae can target it. Standard debuffs self-tag by status name; this
// is reusable for any "remove Slow" / Slow-detonation skill.
async function tagSlowStatus(game, log) {
  for (const it of (game.items?.contents ?? [])) {
    const ae = (it.effects ?? []).find((e) => e.name === "Slow");
    if (!ae) continue;
    const tags = Array.isArray(ae.system?.tags) ? [...ae.system.tags] : [];
    if (tags.includes("slow")) return 0;
    tags.push("slow");
    await ae.update({ "system.tags": tags });
    log(`  [world/${it.name}] Slow AE → tags ${tags.join(", ")}`);
    return 1;
  }
  return 0;
}

const PTC_EFFECT_TABLE = {
  "0": { effect_label: "pc_chain", effect_kind: "chain", chain_steps: "pc_apply_swift,pc_remove_slow,pc_charge" },
  // Swift only if NOT Slowed — condition evaluated BEFORE the removal step.
  "1": { effect_label: "pc_apply_swift", effect_kind: "apply_ae", ae_template_ref: "Swift", target_ref: "self", ae_duplicate_mode: "replace", condition_formula: "AE_COUNT_SLOW == 0" },
  "2": { effect_label: "pc_remove_slow", effect_kind: "remove_tagged_ae", filter_tag: "slow", count: "all", target_ref: "self" },
  "3": { effect_label: "pc_charge", effect_kind: "apply_ae", ae_template_ref: "Prepare to Charge", target_ref: "self", ae_duplicate_mode: "replace" },
};

// Unique "+1 activation next turn" AE. bonus_activation is folded by
// director-combat readActivations into next round's turn count; duration 1 round
// ticks the AE off at the owner's next turn start (after the round-start reset
// has already read it), so the extra activation lands once then clears.
const PTC_AE_DATA = {
  name: "Prepare to Charge",
  img: "icons/svg/upgrade.svg",
  duration: { rounds: 1 },
  transfer: false,
  system: { tags: ["buff"] },
  changes: [{ key: "system.props.bonus_activation", mode: 2, value: "1", priority: 20 }],
  description: "<p><em>Prepare to Charge:</em> +1 action on your next turn.</p>",
  flags: { [NS]: {} },
};

async function patchPrepareToCharge(actor, log) {
  const item = actor.items.find((i) => i.name === "Prepare to Charge");
  if (!item) { log(`  [${actor.name}] "Prepare to Charge": item not found — skipped`); return 0; }
  let changed = 0;

  // Ensure the unique AE template exists (create if missing; leave a co-dev's
  // existing copy alone on re-run). V12 drops create-time `statuses`, so set the
  // token-icon status via a follow-up update.
  if (!item.effects.some((e) => e.name === "Prepare to Charge")) {
    const [created] = await item.createEmbeddedDocuments("ActiveEffect", [PTC_AE_DATA]);
    if (created) await created.update({ statuses: ["fud-prepare-to-charge"] });
    log(`  [${actor.name}] Prepare to Charge: created unique +1-activation AE`);
    changed++;
  }

  if (!deepEqual(item.system?.props?.effect_table ?? {}, PTC_EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": PTC_EFFECT_TABLE });
    log(`  [${actor.name}] Prepare to Charge.effect_table: built (Slow/Swift + charge)`);
    changed++;
  }
  if (item.system?.props?.on_activate_effect_ref !== "pc_chain") {
    await item.update({ "system.props.on_activate_effect_ref": "pc_chain" });
    log(`  [${actor.name}] Prepare to Charge.on_activate_effect_ref → pc_chain`);
    changed++;
  }
  return changed;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  changed += await tagSlowStatus(game, log);
  for (const actor of actors) {
    changed += await patchFieryOnslaught(actor, log);
    changed += await patchBlazingSweep(actor, log);
    changed += await patchPrepareToCharge(actor, log);
  }
  return { applied: true, summary: `Centuaros skills patched (changes: ${changed})` };
}
