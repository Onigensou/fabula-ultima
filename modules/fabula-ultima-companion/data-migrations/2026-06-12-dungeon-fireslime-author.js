/**
 * Migration: 2026-06-12-dungeon-fireslime-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Fire Slime" monster's skills to match descriptions.
 *
 *   Tackle (plain HR+10 Physical) — correct as-is, no change.
 *
 *   Fire Shot — "Deal HR+10 Fire, 50% chance Burn". Two config fixes:
 *     - SCOPE the Burn rider. Its reaction (creature_deals_damage / source self)
 *       has no skill gate → it fires on EVERY damaging action the slime takes,
 *       so Tackle would also inflict Burn. Add `TRIGGER_IS_SELF == 1 &&` to the
 *       chance gate (the Hellhound/Salamander pattern).
 *     - Burn charge model: `ae_duplicate_mode: stack` → `add_charges` so Burn
 *       merges into one charge-bearing AE (charge-as-stack model).
 *     - Embedded Burn template was CHARGELESS. A skill's own embedded "Burn" wins
 *       over the canonical Debuff-hub Burn (charges 3) in resolveAeTemplate, and
 *       apply_burn carries no ae_initial_charges → applied Burn had 0 charges (AE
 *       present but 0 stacks: no tick, never a valid Blazing Tether giver). Stamp
 *       the embedded Burn to charges 3 to match Hellhound/Salamander + the hub.
 *
 *   Flame Burst — "When reduced to 0 HP by NON-Ice damage, deal Fire to all
 *   creatures". Rebuilt:
 *     - TRIGGER. As authored it used `creature_takes_damage`, which is DECLARED
 *       but never EMITTED to the general reaction dispatch (its only consumer is
 *       the narrow Mercy-style incoming-damage resolver) → the skill never fired.
 *       Re-point to the EMITTED `creature_lose_resource` (fired post-HP-write on
 *       the creature whose HP changed), filtered to resource `hp` + cause `damage`,
 *       source `self`.
 *     - "reduced to 0 by non-Ice": condition `CUR_HP <= 0 && TRIGGER_DAMAGE_IS_ICE
 *       == 0`. CUR_HP reads the victim post-damage; TRIGGER_DAMAGE_IS_ICE reads
 *       the killing blow's element off the (now enriched) resource-change payload.
 *       Non-Ice matters: the slime is Fire-ABSORB / Ice-VULNERABLE, so Ice is its
 *       natural killer and is explicitly excluded from the burst.
 *     - EFFECT. `death_burst` was a no-op `grant` carrying damage fields → retype
 *       to `deal_damage` (20 Fire). Target via a new `targeting` row
 *       `burst_targets` (candidate_source `combat`, `exclude_self: true`,
 *       `mode: "all"`): hits ALL combatants — allies + enemies — EXCEPT the slime
 *       itself, with NO target prompt (mode "all" auto-takes the whole pool; the
 *       default mode "exact"/count 1 would wrongly prompt for a pick). Self is
 *       excluded because the slime ABSORBS Fire: including it would heal/revive
 *       the creature that just died.
 *
 * Requires engine identifier `TRIGGER_DAMAGE_IS_<ELEMENT>` (skill-formulas.js)
 * and the enriched creature_lose_resource payload carrying `element`
 * (skill-effects.js emitter + state-handlers.js attack site). Cross-module — a
 * hard refresh (Ctrl+Shift+R) is needed for those to go live.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Fire Slime is a
 * co-dev world actor; this migration tracks our intended data — co-dev sharing is
 * via WORLD-DATA PUSH (see feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-12-dungeon-fireslime-author";
export const description =
  "Fix Fire Slime dungeon skills: scope Fire Shot's Burn rider (TRIGGER_IS_SELF) " +
  "+ stack→add_charges + stamp its chargeless embedded Burn template to charges 3; " +
  "rebuild Flame Burst — re-point its dead creature_takes_damage " +
  "trigger to creature_lose_resource (hp/damage, CUR_HP<=0, non-Ice via " +
  "TRIGGER_DAMAGE_IS_ICE==0), retype death_burst grant→deal_damage, and add a " +
  "combat/exclude_self targeting row so the burst hits all allies+enemies but not " +
  "the (fire-absorbing) slime itself.";

const ACTOR_NAME = "Fire Slime";

const PATCHES = {
  "Fire Shot": {
    effect_kind: [
      { label: "apply_burn", kind: "apply_ae", fields: { ae_duplicate_mode: "add_charges" } },
    ],
    reaction_row_set: [
      { ref: "apply_burn", set: { condition_formula: "TRIGGER_IS_SELF == 1 && chance(50)" } },
    ],
    // Fire Shot's embedded "Burn" AE template shipped CHARGELESS — and a skill's
    // own embedded template wins over the canonical Debuff-hub Burn (charges 3) in
    // resolveAeTemplate. With apply_burn carrying no ae_initial_charges, applied
    // Burn ended up with 0 charges (AE present but 0 stacks → no tick, never a
    // valid Blazing Tether giver). Stamp charges 3 to match Hellhound Flame Breath
    // / Salamander Heat Up / the hub. (Other monsters' embedded Burns are already 3.)
    embedded_ae_charges: [
      { aeName: "Burn", charges: 3, chargeKey: "burn" },
    ],
  },
  "Flame Burst": {
    effect_table_replace: {
      "0": {
        effect_label: "death_burst",
        effect_kind: "deal_damage",
        damage_element: "fire",
        damage_amount: "20",
        target_ref: "burst_targets",
        damage_verbosity: "full",
      },
      "1": {
        effect_label: "burst_targets",
        effect_kind: "targeting",
        candidate_source: "combat",
        exclude_self: true,
        mode: "all",
      },
    },
    reaction_row_set: [
      { ref: "death_burst", set: {
        reaction_trigger: "creature_lose_resource",
        reaction_source: "self",
        reaction_passive_mode: "on",
        condition_formula: "CUR_HP <= 0 && TRIGGER_DAMAGE_IS_ICE == 0",
        reaction_resource_filter: "hp",
        reaction_cause_filter: "damage",
      } },
    ],
  },
};

// ── helpers (shared shape with the Salamander author migration) ──────────────
function patchEffectKinds(item, specs) {
  const src = item.system?.props?.effect_table;
  if (!src || typeof src !== "object") return { table: null, changed: false, notes: ["no effect_table"] };
  const table = foundry.utils.deepClone(src);
  let changed = false;
  const notes = [];
  for (const { label, kind, fields, remove } of specs) {
    let found = false;
    for (const row of Object.values(table)) {
      if (!row || row.$deleted) continue;
      if (row.effect_label === label) {
        found = true;
        if (row.effect_kind !== kind) { row.effect_kind = kind; changed = true; notes.push(`${label}: →${kind}`); }
        else notes.push(`${label}: already ${kind}`);
        for (const [k, v] of Object.entries(fields ?? {})) {
          if (row[k] !== v) { row[k] = v; changed = true; notes.push(`${label}.${k}=${v}`); }
        }
        for (const k of remove ?? []) {
          if (k in row) { delete row[k]; changed = true; notes.push(`${label}.-${k}`); }
        }
      }
    }
    if (!found) notes.push(`${label}: ROW NOT FOUND`);
  }
  return { table, changed, notes };
}

function patchReactionRow(item, specs) {
  const src = item.system?.props?.reaction_config_table;
  if (!src || typeof src !== "object") return { table: null, changed: false, notes: ["no reaction_config_table"] };
  const table = foundry.utils.deepClone(src);
  let changed = false;
  const notes = [];
  for (const { ref, set } of specs) {
    let found = false;
    for (const row of Object.values(table)) {
      if (!row || row.$deleted) continue;
      if (row.reaction_effect_ref === ref) {
        found = true;
        for (const [k, v] of Object.entries(set ?? {})) {
          if (row[k] !== v) { row[k] = v; changed = true; notes.push(`${ref}.${k}→"${v}"`); }
        }
      }
    }
    if (!found) notes.push(`${ref}: REACTION ROW NOT FOUND`);
  }
  return { table, changed, notes };
}

// Stamp charges (+ chargeKey) onto an embedded AE template by name — fixes a
// chargeless scaffold so apply_ae produces a real charge-bearing status.
async function patchEmbeddedAeCharges(item, specs, actorName, skillName, log) {
  const NS = "fabula-ultima-companion";
  let touched = false;
  for (const { aeName, charges, chargeKey } of specs) {
    const ae = (item.effects?.contents ?? []).find((e) => e.name === aeName);
    if (!ae) { log(`  [${actorName}] "${skillName}": embedded AE "${aeName}" not found`); continue; }
    const cur = ae.flags?.[NS] ?? {};
    const update = {};
    if (Number(cur.charges ?? NaN) !== charges) update[`flags.${NS}.charges`] = charges;
    if (chargeKey && cur.chargeKey !== chargeKey) update[`flags.${NS}.chargeKey`] = chargeKey;
    if (Object.keys(update).length) {
      await ae.update(update);
      log(`  [${actorName}] "${skillName}": embedded "${aeName}" → charges ${charges}`);
      touched = true;
    } else {
      log(`  [${actorName}] "${skillName}": embedded "${aeName}" already charges ${charges}`);
    }
  }
  return touched;
}

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

      // effect_table: in-place field patches (delete-then-rewrite so removals stick).
      if (spec.effect_kind) {
        const { table, changed, notes } = patchEffectKinds(item, spec.effect_kind);
        log(`  [${actor.name}] "${skillName}".effect_table: ${notes.join("; ")}`);
        if (changed && table && !deepEqual(item.system?.props?.effect_table ?? {}, table)) {
          await item.update({ "system.props.-=effect_table": null });
          await item.update({ "system.props.effect_table": table });
          touched = true;
        }
      }

      // effect_table: wholesale replace (row SHAPE changes / new rows). Delete-then-write.
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

      // reaction_config_table: field-sets by reaction_effect_ref (merge write).
      if (spec.reaction_row_set) {
        const { table, changed, notes } = patchReactionRow(item, spec.reaction_row_set);
        log(`  [${actor.name}] "${skillName}".reaction-row: ${notes.join("; ")}`);
        if (changed && table) { await item.update({ "system.props.reaction_config_table": table }); touched = true; }
      }

      // embedded AE charge stamps (fix chargeless Burn scaffold).
      if (spec.embedded_ae_charges) {
        if (await patchEmbeddedAeCharges(item, spec.embedded_ae_charges, actor.name, skillName, log)) touched = true;
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
  return { applied: true, summary: `Fire Slime skills patched (items updated: ${changed})` };
}
