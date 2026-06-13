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
 *      option b). The reaction is re-pointed onto the BD crisis cascade:
 *      `creature_status_applied` (status "Crisis") / source enemy / mode `on`
 *      (auto-grant; GM-customizable). The legacy `creature_enter_crisis` trigger
 *      had no BD consumer.
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
 *   5. Actor-level `system.props.activation` baked as "0". The Battle Director
 *      reads activation as actions-per-round and HONORS an explicit "0" (an AE
 *      can set it to 0 to skip a turn — readBaseActivation in director-combat.js),
 *      so a Hellhound with base "0" gets NO turn in combat, regardless of the
 *      "Only main player acts" toggle — it never becomes an eligible combatant.
 *      Every other NPC in the world (incl. soldier-rank peers) carries "1"; this
 *      is anomalous data on the Hellhound base actor. Heal it to "1" when the
 *      live value is falsy/0. Like #4 this is world data, so the migration is the
 *      only durable carrier to a co-dev's Hellhound.
 *
 *   6. Flame Breath's `apply_burn` row used `ae_duplicate_mode: "stack"` — which
 *      makes apply_ae spawn a NEW Burn AE on every application (two hits → two
 *      independent 3-charge Burns ticking in parallel). Canonical Burn stacking
 *      is `add_charges`: one Burn that POOLS charges (3 → 6 → …), matching the
 *      master design (2026-06-06-burn-status-tick / -default-charges-3). Retype
 *      the dup-mode to `add_charges` (effect_kind stays apply_ae). World data, so
 *      this migration is the durable carrier to a co-dev's Hellhound.
 *
 * RUN ONCE: NOT manifest-tagged `idempotent` (changed 2026-06-12), so it runs a
 * single time then stays in the appliedMigrations ledger — it will NOT re-apply
 * over a co-dev's later edits to these skills. Co-dev delivery is via WORLD-DATA
 * PUSH (see feedback_world_data_sharing_hazard). The patch logic is still
 * drift-safe (checks desired value, no-ops if already correct) if it does re-run.
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
  "Burn template so applied Burns carry stacks (tick + count badge); retype " +
  "apply_burn's dup-mode stack→add_charges (Burn pools charges, not parallel AEs); " +
  "heal the actor's activation from a turn-skipping \"0\" to \"1\".";

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
    // Re-point the reaction off the dead legacy `creature_enter_crisis` (no BD
    // consumer) onto the BD-native crisis cascade: the built-in crisis reactor
    // emits `creature_status_applied` (status "Crisis") when a creature drops to
    // its crisis threshold; On the Hunt watches an ENEMY gain it. mode `on` =
    // auto-grant the free attack (GM can switch to ask). Was: creature_enter_crisis
    // / enemy / ask.
    reaction_row_set: [{
      ref: "hunt_free_attack",
      set: {
        reaction_trigger:        "creature_status_applied",
        reaction_source:         "enemy",
        reaction_passive_mode:   "on",
        reaction_status_filter:  "Crisis",
      },
    }],
  },
  "Flame Breath": {
    reaction_cond: [{ ref: "apply_burn", cond: "TRIGGER_IS_SELF == 1 && chance(50)" }],
    // apply_burn was authored `ae_duplicate_mode: "stack"`, which in apply_ae
    // creates a SEPARATE Burn AE per application (two hits → two coexisting
    // 3-charge Burns, each ticking independently). Canonical Burn stacking is
    // `add_charges` — one Burn that POOLS charges (3 → 6 → …), per the
    // burn-status-tick / burn-default-charges-3 master design. Retype to match
    // (effect_kind unchanged = apply_ae; only the dup-mode field drifts).
    effect_kind: [{ label: "apply_burn", kind: "apply_ae", fields: { ae_duplicate_mode: "add_charges" } }],
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

// Apply field-sets to reaction_config_table rows matched by reaction_effect_ref
// — used to re-point a reaction's trigger / source / mode / filters. Returns
// { table, changed, notes }. (If a skill ALSO uses reaction_cond, both write the
// reaction_config_table from the live item independently — keep them on
// separate skills, or chain them, to avoid clobbering. On the Hunt uses only
// this one.)
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

// Deep-equality (key-order-insensitive) for idempotent drift detection.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// Heal the actor's actions-per-round. The Battle Director honors an explicit
// "0" activation as "skip this creature's turn" (readBaseActivation), so a base
// "0" makes the Hellhound never act. Normalize a falsy/0 value to "1". Idempotent:
// writes only when the live value is 0/blank — a Hellhound already at "1" (or any
// positive value) is left untouched.
async function healActivation(actor, log) {
  const raw = actor.system?.props?.activation;
  const n = Number(String(raw ?? "").replace(/[^0-9.\-]/g, ""));
  if (Number.isFinite(n) && n >= 1) {
    log(`  [${actor.name}] activation: already ${JSON.stringify(raw)} — ok`);
    return 0;
  }
  await actor.update({ "system.props.activation": "1" });
  log(`  [${actor.name}] activation: ${JSON.stringify(raw)} → "1" (was turn-skipping)`);
  return 1;
}

async function patchActor(actor, log) {
  let totalChanged = await healActivation(actor, log);
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
      if (spec.reaction_row_set) {
        const { table, changed, notes } = patchReactionRow(item, spec.reaction_row_set);
        log(`  [${actor.name}] "${skillName}".reaction-row: ${notes.join("; ")}`);
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
