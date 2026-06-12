/**
 * Migration: 2026-06-12-dungeon-dryad-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Dryad" monster's skills to match descriptions.
 * Built skill-by-skill; grows as each skill is finished + verified.
 *
 *   Oil status fix (prerequisite): the shared "Oil" advanced-debuff AE (world
 *     Debuff hub + Dryad/Mustard Bomb's embedded copy) shipped with NO changes,
 *     so it was mechanically inert. Per the Custom Rules journal Oil = "Gain
 *     vulnerability to Fire damage" → add change affinity_6 = "VU" (fire = slot 6,
 *     per snapshot.js ELEMENT→affinity map; mirrors Wet = affinity_3 Bolt VU).
 *
 *   Mustard Bomb (Spell — Fire + inflict Oil) — DONE. Base HR+40 Fire via the
 *     spell profile; apply_oil on hit (creature_deals_damage / self / on) →
 *     apply_ae Oil to hit targets, ae_duplicate_mode "replace" (was "stack";
 *     Oil is a binary status, don't stack duplicate copies).
 *
 *   Ignis Finis (Spell — Firestorm HR+43 Fire to up to 3; Opportunity: Burn) —
 *     DONE. Base HR+43 Fire via profile (description text synced 35→43). The
 *     Opportunity (Burn) is gated on a CRITICAL hit — the canonical FU Opportunity
 *     trigger — via the reaction's condition_formula "CRIT == 1" (creature_deals_
 *     damage / self / on → ignis_opportunity_burn). The prior 1-"up" cost chain
 *     was dropped: Dryad has 0 ultima points, so it would have always aborted.
 *     Burn applies add_charges/3 to hit targets.
 *
 *   Enkindle (Spell — double the target's Burn, then 5×(doubled) Fire) — DONE.
 *     enkindle_chain → enkindle_double_burn (NEW adjust_charges: Burn × 2 on
 *     action_targets) + enkindle_fire_damage (grant→deal_damage AE_CHARGES_BURN*5;
 *     deal_damage's per-target resolver reads the now-DOUBLED Burn → 5×doubled
 *     fire). on_activate fire-point. Requires the adjust_charges engine kind
 *     (cross-module → hard refresh to go live).
 *
 *   Dispel (Spell — cleanse Scene-duration SPELL effects) — DONE (forward-looking).
 *     Cleanse vs Dispel are differentiated by EXPLICIT category tags on AEs
 *     (author-judged per-AE, NOT auto-derived): "cleansable" (Cleanse removes) /
 *     "dispellable" (Dispel removes), orthogonal to debuff/buff. Dispel =
 *     remove_tagged_ae filter_tag "dispellable" (count omitted → ALL, the new
 *     remove_tagged_ae default). It removes nothing today — no spell effects are
 *     director-implemented + tagged "dispellable" yet; the convention is in place
 *     so scene-spell buffs become dispellable as they're authored. (Cleanse, when
 *     a skill needs it, = remove_tagged_ae "cleansable"; seed the Debuff hub
 *     "cleansable" at that point.) Was a no-op grant filter_tag "debuff".
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Dryad is a co-dev
 * world actor; sharing is via WORLD-DATA PUSH (feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-12-dungeon-dryad-author";
export const description =
  "Fix Dryad dungeon skills: Oil AE → affinity_6 VU (Fire vulnerability); " +
  "Mustard Bomb apply_oil stack→replace; Ignis Finis Opportunity Burn gated on " +
  "CRIT (drop the 0-up cost chain), desc 35→43, Burn add_charges/3; " +
  "Enkindle double-Burn via adjust_charges + deal_damage 5×doubled; " +
  "Dispel = remove_tagged_ae 'dispellable' (count default all).";

const ACTOR_NAME = "Dryad";
const NS = "fabula-ultima-companion";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

const FIRE_VU_CHANGE = { key: "affinity_6", value: "VU", mode: 0, priority: 1 };

// Add the Fire-VU change to every "Oil" AE that lacks it (world hub + actor copies).
async function fixOilStatus(game, actor, log) {
  let changed = 0;
  const targets = [];
  for (const it of (game.items?.contents ?? [])) for (const ae of (it.effects ?? [])) if (ae.name === "Oil") targets.push([ae, `world/${it.name}`]);
  for (const it of actor.items) for (const ae of it.effects) if (ae.name === "Oil") targets.push([ae, `${actor.name}/${it.name}`]);
  for (const [ae, where] of targets) {
    const changes = Array.isArray(ae.changes) ? foundry.utils.deepClone(ae.changes) : [];
    if (changes.some((c) => c.key === "affinity_6")) continue;
    changes.push({ ...FIRE_VU_CHANGE });
    await ae.update({ changes });
    log(`  [${where}] Oil AE → +affinity_6=VU (Fire vulnerability)`);
    changed++;
  }
  return changed;
}

const MUSTARD_BOMB_EFFECT_TABLE = {
  "0": { effect_label: "apply_oil", effect_kind: "apply_ae", ae_template_ref: "Oil", target_ref: "hit_action_targets", ae_duplicate_mode: "replace" },
};

const IGNIS_EFFECT_TABLE = {
  "0": { effect_label: "ignis_opportunity_burn", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "hit_action_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
};
const IGNIS_REACTION_TABLE = {
  "0": { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "on", condition_formula: "CRIT == 1", reaction_effect_ref: "ignis_opportunity_burn" },
};

const ENKINDLE_EFFECT_TABLE = {
  "0": { effect_label: "enkindle_chain", effect_kind: "chain", chain_steps: "enkindle_double_burn,enkindle_fire_damage" },
  "1": { effect_label: "enkindle_double_burn", effect_kind: "adjust_charges", charge_ae_name: "Burn", charge_operation: "multiply", charge_amount: "2", target_ref: "action_targets" },
  "2": { effect_label: "enkindle_fire_damage", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "AE_CHARGES_BURN * 5", target_ref: "action_targets", damage_cause: "damage", attacker_name: "Enkindle" },
};

// Dispel — remove the target's "dispellable" (Scene-duration spell) effects.
// count omitted → ALL (the remove_tagged_ae default). dispellable is author-
// applied per spell-effect AE; none exist yet, so this is forward-looking.
const DISPEL_EFFECT_TABLE = {
  "0": { effect_label: "dispel_remove", effect_kind: "remove_tagged_ae", filter_tag: "dispellable", target_ref: "action_targets" },
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
    changed += await fixOilStatus(game, actor, log);
    const mb = actor.items.find((i) => i.name === "Mustard Bomb");
    if (mb) changed += await patchSkillTable(mb, MUSTARD_BOMB_EFFECT_TABLE, null, null, log, `${actor.name}/Mustard Bomb`);
    const ig = actor.items.find((i) => i.name === "Ignis Finis");
    if (ig) changed += await patchSkillTable(ig, IGNIS_EFFECT_TABLE, IGNIS_REACTION_TABLE, (d) => d.replace(/HR\s*\+\s*35/gi, "HR + 43").replace(/】\s*35/g, "】43"), log, `${actor.name}/Ignis Finis`);
    const ek = actor.items.find((i) => i.name === "Enkindle");
    if (ek) {
      changed += await patchSkillTable(ek, ENKINDLE_EFFECT_TABLE, null, null, log, `${actor.name}/Enkindle`);
      if (ek.system?.props?.on_activate_effect_ref !== "enkindle_chain") {
        await ek.update({ "system.props.on_activate_effect_ref": "enkindle_chain" });
        log(`  [${actor.name}/Enkindle] on_activate_effect_ref → enkindle_chain`); changed++;
      }
    }
    const dp = actor.items.find((i) => i.name === "Dispel");
    if (dp) {
      changed += await patchSkillTable(dp, DISPEL_EFFECT_TABLE, null, null, log, `${actor.name}/Dispel`);
      if (dp.system?.props?.on_activate_effect_ref !== "dispel_remove") {
        await dp.update({ "system.props.on_activate_effect_ref": "dispel_remove" });
        log(`  [${actor.name}/Dispel] on_activate_effect_ref → dispel_remove`); changed++;
      }
    }
  }
  return { applied: true, summary: `Dryad skills patched (changes: ${changed}) — all 4 (Mustard Bomb, Ignis Finis, Enkindle, Dispel)` };
}
