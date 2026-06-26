/**
 * Migration: 2026-06-27-wandering-flame-burn-trigger-unify
 * ---------------------------------------------------------------------------
 * Close two gaps in the tier-2 "Burn triggered" wiring (2026-06-26-wandering-
 * flame-tier2) by moving from the HP-loss/origin-filter signal to the decoupled
 * `creature_status_triggered` event + the `trigger_status` effect_kind:
 *
 *   GAP 1 — a Fire-ABSORBING creature's Burn tick HEALS (creature_gain_resource),
 *     and an IMMUNE creature's deals 0, so the old Ignition (creature_lose_resource
 *     + reaction_origin_filter "Burn") never fired for them — incl. the Wandering
 *     Flame's own self-Burn. The decoupled event is emitted by the Burn tick
 *     regardless of HP direction (see 2026-06-27-burn-emit-status-trigger), so it
 *     fires for absorb/immune too.
 *   GAP 2 — Flame Claw / Meteor "trigger Burn" with a hand-copied look-alike
 *     deal_damage; they didn't run the real tick and only matched Ignition by a
 *     fragile attacker_name label. They now use `trigger_status`, which replays
 *     the REAL Burn tick (formula read from the Burn AE — DRY) and emits the same
 *     signal a natural tick does.
 *
 * Changes (on the WF actor):
 *   - Zero Trigger: Ignition — reaction now `creature_status_triggered` +
 *     reaction_status_filter "Burn" (was creature_lose_resource + origin "Burn").
 *     Grant chain (ignition_gain: +10 MP +1 Zero Power) unchanged.
 *   - Flame Claw — flameclaw_blaze is now a single `trigger_status` Burn,
 *     trigger_count 1, consume_charges true (replaces the deal_damage +
 *     adjust_charges -1 pair). Same net effect; runs the real tick + emits.
 *   - Zero Power: Meteor Impact — meteor_detonate is now `trigger_status` Burn,
 *     trigger_count "AE_CHARGES_BURN" (all stacks), consume_charges false; the
 *     meteor_halve adjust_charges and the base 10-Fire profile are unchanged.
 *     BATCHED: one N×tick deal_damage per target, so Ignition counts PER-CREATURE
 *     (one event/creature), not per-stack.
 *
 * Requires the engine additions shipped alongside: the creature_status_triggered
 * trigger (registry + LEDGER_FAMILY), emit_trigger/emit_status on deal_damage,
 * and the trigger_status effect_kind. RUN ONCE (NOT manifest-tagged idempotent);
 * patch logic is drift-safe if re-run. WF is co-dev world data — delivery via
 * WORLD-DATA PUSH (feedback_world_data_sharing_hazard), the USER's call.
 */

export const key = "2026-06-27-wandering-flame-burn-trigger-unify";
export const description =
  "WF Burn-trigger unify: Ignition -> creature_status_triggered + status_filter " +
  "\"Burn\" (fires on absorb/immune ticks too); Flame Claw + Meteor detonations -> " +
  "trigger_status (replay the REAL Burn tick, DRY + same signal). Meteor batched -> " +
  "Ignition per-creature.";

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

// ── Zero Trigger: Ignition — decoupled status-triggered event ──────────────
const IGNITION_REACTION_TABLE = {
  "0": {
    reaction_trigger: "creature_status_triggered",
    reaction_source: "",
    reaction_passive_mode: "force",
    reaction_status_filter: "Burn",
    reaction_effect_ref: "ignition_gain",
  },
};
const IGNITION_EFFECT_TABLE = {
  "0": { effect_label: "ignition_gain", effect_kind: "chain", chain_steps: "ignition_mp,ignition_zp" },
  "1": { effect_label: "ignition_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: "10", target_ref: "self" },
  "2": { effect_label: "ignition_zp", effect_kind: "grant", grant_resource: "zero_power", grant_amount: "1", target_ref: "self" },
};

// ── Flame Claw — trigger 1 Burn + consume 1 (single trigger_status) ────────
const FLAME_CLAW_EFFECT_TABLE = {
  "0": { effect_label: "flameclaw_blaze", effect_kind: "trigger_status", status_name: "Burn", trigger_count: "1", consume_charges: true, target_ref: "hit_action_targets" },
};

// ── Zero Power: Meteor Impact — trigger ALL Burn (no consume) + halve ──────
const METEOR_EFFECT_TABLE = {
  "0": { effect_label: "meteor_unleash", effect_kind: "chain", chain_steps: "meteor_detonate,meteor_halve" },
  "1": { effect_label: "meteor_detonate", effect_kind: "trigger_status", status_name: "Burn", trigger_count: "AE_CHARGES_BURN", consume_charges: false, target_ref: "action_targets" },
  "2": { effect_label: "meteor_halve", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "multiply", charge_amount: "0.5", target_ref: "action_targets" },
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
    const ig = actor.items.find((i) => i.name === "Zero Trigger: Ignition");
    if (ig) changed += await patchSkillTable(ig, IGNITION_EFFECT_TABLE, IGNITION_REACTION_TABLE, log, `${actor.name}/Ignition`);
    const fc = actor.items.find((i) => i.name === "Flame Claw");
    if (fc) changed += await patchSkillTable(fc, FLAME_CLAW_EFFECT_TABLE, null, log, `${actor.name}/Flame Claw`);
    const me = actor.items.find((i) => i.name === "Zero Power: Meteor Impact");
    if (me) changed += await patchSkillTable(me, METEOR_EFFECT_TABLE, null, log, `${actor.name}/Meteor Impact`);
  }
  return {
    applied: true,
    summary: `Wandering Flame Burn-trigger unify (changes: ${changed}) — Ignition (status_triggered) + Flame Claw/Meteor (trigger_status)`,
  };
}
