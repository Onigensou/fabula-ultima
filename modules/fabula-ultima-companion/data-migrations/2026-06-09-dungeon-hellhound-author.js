/**
 * Migration: 2026-06-09-dungeon-hellhound-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Hellhound" monster's skills so they behave per
 * their in-game descriptions. Three authoring corrections (the first two are
 * systemic across more dungeon monsters; this migration owns ONLY Hellhound):
 *
 *   1. `grant` mis-typing — damage rows authored as `effect_kind: "grant"`
 *      but carrying deal_damage fields (damage_element / damage_amount).
 *      `grant` only reads grant_resource / grant_amount, so those rows are a
 *      silent no-op. Retype them to `deal_damage` (which reads exactly those
 *      fields), so the damage actually lands.
 *        - Pounce → pounce_damage (20 Physical on a failed Opposed Check)
 *
 *   2. On the Hunt is a FREE ACTION grant, not flat damage. RAW: "Whenever an
 *      enemy enters Crisis, you may perform a Free Attack on that creature,
 *      treating your High Roll (HR) as 0 when calculating damage." This is NOT
 *      "deal 40 damage" — the Hellhound actually takes a free Attack action
 *      (its own roll, target, on-hit riders). Author `hunt_free_attack` as
 *      `open_action_menu` + `free_mode: true` (enqueues a free-action grant +
 *      mini-turn restricted to Attack via `allowed_types`) + `free_hr_as_zero:
 *      true` (the granted attack zeroes HR for damage — same knob as Hawkeye
 *      option b). The reaction (creature_enter_crisis / source enemy / mode
 *      ask) is already correct — "may" → the GM is prompted to take it.
 *      LIMITATION: the engine does not yet lock the free attack's target to the
 *      crisis creature (freeActionQueue.lockedTargetTokenUuid is a future hook),
 *      so the GM targets that creature manually during the mini-turn.
 *
 *   3. Unscoped on-hit riders — reactions on `creature_deals_damage` /
 *      `creature_will_deal_damage` with `reaction_source: "self"` and NO skill
 *      gate fire on EVERY damaging action the monster takes, not just their
 *      own skill (cross-contamination — confirmed live on Centimare). Scope
 *      them with the new `TRIGGER_IS_SELF == 1` formula gate (added to
 *      skill-formulas.js) so the rider only fires for its own carrier skill.
 *        - Flame Breath → apply_burn  : "chance(50)"
 *            → "TRIGGER_IS_SELF == 1 && chance(50)"
 *        - Bite → bite_grappled_bonus : "TARGET_AE_CHARGES_GRAPPLED > 0"
 *            → "TRIGGER_IS_SELF == 1 && TARGET_GRAPPLED_BY_SELF == 1"
 *          Two corrections: (1) TRIGGER_IS_SELF scopes the rider to Bite (the
 *          real cross-fire bug). (2) the RAW says "Grappled BY YOU", so the gate
 *          is grappled-BY-SELF (TARGET_GRAPPLED_BY_SELF reads the grappler
 *          stamped on the target's Grappled AE), not grappled-by-anyone. The old
 *          CHARGES read happened to work (the status carries charges:1) but
 *          checked mere presence, ignoring who did the grappling.
 *
 *   4. Flame Breath's embedded "Burn" template missing its charge count. The
 *      skill carries its OWN "Burn" ActiveEffect, and resolveAeTemplate prefers
 *      a skill-local effect over the world "Debuff" master — so THIS copy is what
 *      gets cloned onto the target. Without `charges`, the applied Burn lands
 *      with no stacks: it can't tick its 10%-Max-HP fire down to 0, and shows no
 *      count badge on the token. Stamp the canonical `charges: 3` (matching the
 *      master) and clear any badge-suppressing `chargesMax: 1`. This is world
 *      data (worlds/ is never committed), so the migration is the only way it
 *      reaches a co-dev's Hellhound.
 *
 * IDEMPOTENT: each patch is checked against the desired value and only writes
 * on drift; a fully-migrated Hellhound re-runs as a no-op. Tagged
 * `"idempotent": true` in _manifest.json so a pulled co-dev world self-heals
 * on boot (see feedback_pulled_world_stale_author_migration).
 *
 * NOTE: Hellhound is a CO-DEV-owned world actor (Current Dungeon). This
 * migration is the durable carrier for these fixes — do not hand-edit the
 * same rows on the sheet once this owns them.
 */

export const key = "2026-06-09-dungeon-hellhound-author";
export const description =
  "Fix Hellhound dungeon skills: retype Pounce's no-op grant to deal_damage; " +
  "rebuild On the Hunt as a free-action grant (free Attack, HR as 0); scope " +
  "on-hit riders (Flame Breath Burn, Bite grappled bonus) to their own skill " +
  "via TRIGGER_IS_SELF; stamp the canonical charges:3 on Flame Breath's embedded " +
  "Burn template so applied Burns carry stacks (tick + count badge).";

const ACTOR_NAME = "Hellhound";
const NS = "fabula-ultima-companion";

// Per-skill patch spec.
//   `effect_kind`          — retype rows matched by effect_label (+ optional
//                            `fields` map to set extra columns on the row).
//   `effect_table_replace` — wholesale-replace the skill's effect_table with a
//                            clean object (use when the row SHAPE changes, not
//                            just a field — mirrors Hawkeye's -=table / write).
//   `reaction_cond`        — patch condition_formula on rows matched by
//                            reaction_effect_ref in the reaction_config_table.
const PATCHES = {
  "Pounce": {
    // Retype + explicitly RESPECT affinity (rules-correct for plain "20 Physical
    // damage" — RS halves it, etc.). damage_ignore_affinity:false is set
    // explicitly so it drift-heals away an earlier mistaken `true` on every
    // world (incl. co-dev pulls).
    effect_kind: [{ label: "pounce_damage", kind: "deal_damage", fields: { damage_ignore_affinity: false } }],
  },
  "On the Hunt": {
    // "you may perform a Free Attack on that creature, treating HR as 0" — a
    // free-action GRANT, not flat damage. free_mode enqueues the grant + a
    // mini-turn restricted to Attack; free_hr_as_zero zeroes HR for the
    // granted attack's damage (Hawkeye option-b knob). Wholesale-replaced (the
    // old row was a deal_damage/grant — different shape, so clear it cleanly).
    effect_table_replace: {
      "0": {
        effect_label:    "hunt_free_attack",
        effect_kind:     "open_action_menu",
        free_mode:       true,
        allowed_types:   "Attack",
        free_hr_as_zero: true,
      },
    },
  },
  "Flame Breath": {
    reaction_cond: [{ ref: "apply_burn", cond: "TRIGGER_IS_SELF == 1 && chance(50)" }],
    // Flame Breath carries its OWN embedded "Burn" template, and a skill-local
    // effect WINS over the world "Debuff" master in resolveAeTemplate — so this
    // embedded copy is what gets cloned onto the target. It must carry the
    // canonical Burn charge count (charges:3, matching the master) or the applied
    // Burn lands with no stacks: it can't tick down and shows no count badge on
    // the token. chargesMax stays unset (Burn stacks uncapped); a stray
    // chargesMax:1 is cleared because it ALSO suppresses the badge.
    embedded_ae: [{ name: "Burn", set: { charges: 3 }, clearIfSuppressingMax: true }],
  },
  "Bite": {
    // "deals 50% more damage on a creature Grappled BY YOU" — grappled-by-self,
    // not merely grappled-by-anyone (TARGET_GRAPPLED_BY_SELF reads the grappler
    // stamped on the target's Grappled AE). Scoped to Bite via TRIGGER_IS_SELF.
    reaction_cond: [{ ref: "bite_grappled_bonus", cond: "TRIGGER_IS_SELF == 1 && TARGET_GRAPPLED_BY_SELF == 1" }],
  },
};

// Apply a list of effect_kind retypes to a cloned effect_table. Returns
// { table, changed, notes } — table is null when the source table is missing.
function patchEffectKinds(item, specs) {
  const src = item.system?.props?.effect_table;
  if (!src || typeof src !== "object") return { table: null, changed: false, notes: ["no effect_table"] };
  const table = foundry.utils.deepClone(src);
  let changed = false;
  const notes = [];
  for (const { label, kind, fields } of specs) {
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
      }
    }
    if (!found) notes.push(`${label}: ROW NOT FOUND`);
  }
  return { table, changed, notes };
}

// Apply a list of condition_formula patches to a cloned reaction_config_table,
// matching rows by reaction_effect_ref. Returns { table, changed, notes }.
function patchReactionConds(item, specs) {
  const src = item.system?.props?.reaction_config_table;
  if (!src || typeof src !== "object") return { table: null, changed: false, notes: ["no reaction_config_table"] };
  const table = foundry.utils.deepClone(src);
  let changed = false;
  const notes = [];
  for (const { ref, cond } of specs) {
    let found = false;
    for (const row of Object.values(table)) {
      if (!row || row.$deleted) continue;
      if (row.reaction_effect_ref === ref) {
        found = true;
        if (String(row.condition_formula ?? "") !== cond) { row.condition_formula = cond; changed = true; notes.push(`${ref}: cond→"${cond}"`); }
        else notes.push(`${ref}: cond already set`);
      }
    }
    if (!found) notes.push(`${ref}: REACTION ROW NOT FOUND`);
  }
  return { table, changed, notes };
}

// Deep-equality (key-order-insensitive) for idempotent drift detection.
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
      const updates = {};
      if (spec.effect_kind) {
        const { table, changed, notes } = patchEffectKinds(item, spec.effect_kind);
        log(`  [${actor.name}] "${skillName}".effect_table: ${notes.join("; ")}`);
        if (changed && table) updates["system.props.effect_table"] = table;
      }
      if (spec.reaction_cond) {
        const { table, changed, notes } = patchReactionConds(item, spec.reaction_cond);
        log(`  [${actor.name}] "${skillName}".reactions: ${notes.join("; ")}`);
        if (changed && table) updates["system.props.reaction_config_table"] = table;
      }
      if (Object.keys(updates).length) {
        await item.update(updates);
        touched = true;
      }
      // Wholesale effect_table replace (row-shape changes). Two-step -=delete /
      // write so stale keys can't survive Foundry's deep-merge. Idempotent:
      // only fires when the live table drifts from the desired object.
      if (spec.effect_table_replace) {
        const want = spec.effect_table_replace;
        if (!deepEqual(item.system?.props?.effect_table ?? {}, want)) {
          await item.update({ "system.props.-=effect_table": null });
          await item.update({ "system.props.effect_table": want });
          log(`  [${actor.name}] "${skillName}".effect_table: REPLACED (free-action grant)`);
          touched = true;
        } else {
          log(`  [${actor.name}] "${skillName}".effect_table: already free-action grant`);
        }
      }
      // Embedded status-template charge flags. A skill-local AE (e.g. Flame
      // Breath's own "Burn") is the template resolveAeTemplate clones onto
      // targets, so its charge count must be canonical. Idempotent: writes only
      // the flags that drift.
      if (spec.embedded_ae) {
        for (const aeSpec of spec.embedded_ae) {
          const ae = item.effects.find((e) => e.name === aeSpec.name);
          if (!ae) { log(`  [${actor.name}] "${skillName}"/${aeSpec.name}: embedded AE NOT FOUND`); continue; }
          const cur = ae.flags?.[NS] ?? {};
          const aeUpdate = {};
          for (const [k, v] of Object.entries(aeSpec.set ?? {})) {
            if (cur[k] !== v) aeUpdate[`flags.${NS}.${k}`] = v;
          }
          // Clear a chargesMax of exactly 1 — it suppresses the on-token stack
          // badge (a "1" reads as a pure on/off effect). Burn is uncapped, so
          // unset is canonical; leave any other max untouched.
          if (aeSpec.clearIfSuppressingMax && cur.chargesMax === 1) {
            aeUpdate[`flags.${NS}.-=chargesMax`] = null;
          }
          const changedKeys = Object.keys(aeUpdate);
          if (changedKeys.length) {
            await ae.update(aeUpdate);
            log(`  [${actor.name}] "${skillName}"/${aeSpec.name}: set ${changedKeys.join(", ")}`);
            touched = true;
          } else {
            log(`  [${actor.name}] "${skillName}"/${aeSpec.name}: charge flags already canonical`);
          }
        }
      }
      if (touched) {
        totalChanged++;
        log(`  [${actor.name}] "${skillName}": UPDATED`);
      }
    }
  }
  return totalChanged;
}

export async function migrate(game, log = () => {}) {
  // Patch every actor named Hellhound (base actor; unlinked-token overrides
  // inherit unless they shadow the item, which monster tokens don't).
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) changed += await patchActor(actor, log);
  return { applied: true, summary: `Hellhound skills patched (items updated: ${changed})` };
}
