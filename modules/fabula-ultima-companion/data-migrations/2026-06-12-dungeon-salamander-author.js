/**
 * Migration: 2026-06-12-dungeon-salamander-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Salamander" monster's skills so they behave per
 * their in-game descriptions. Salamander is a Fire/Burn bruiser whose kit
 * revolves around its own Burn stacks (Blaze). Three corrections, all on the
 * confirmed-systemic dungeon bugs:
 *
 *   1. `grant` mis-typing on the Blaze CONSUME rows. Both Salamander Breath's
 *      `blaze_consume` and Pyrophagy's `pyrophagy_consume` are authored as
 *      `effect_kind: "grant"` carrying removal fields (`filter_tag: "burn"`,
 *      `count: "all"`) and an EMPTY `grant_resource`. The `grant` handler only
 *      reads grant_resource/grant_amount → it returns "unknown-resource" and
 *      does nothing, so the Burn stacks are NEVER consumed. Retype both to
 *      `remove_tagged_ae` (the dedicated handler that reads filter_tag/count and
 *      deletes the matching AEs). This is the same fix Hellhound's Pounce needed,
 *      one handler over. Without it: Salamander Breath's "Consume all Burn stacks"
 *      and Pyrophagy's "Remove all Burn stack" are inert — the bonus/heal can be
 *      re-collected every action because nothing is spent.
 *
 *   2. Burn-stack COUNTING uses the wrong identifier on Salamander Breath.
 *      Per the locked design decision (2026-06-12): **one Burn stack = one
 *      charge** (`AE_CHARGES_BURN`), NOT one AE instance (`AE_COUNT_BURN`).
 *      Pyrophagy's heal already reads `AE_CHARGES_BURN * 5` (correct).
 *      Salamander Breath's `blaze_damage` reads `AE_COUNT_BURN * 4`, which counts
 *      AE INSTANCES (always 1 for a single merged Burn) → bonus capped at 4
 *      regardless of stacks. Retarget it to `AE_CHARGES_BURN * 4` so the bonus
 *      scales with stacks ("Burn Stack × 4 for each stack removed").
 *
 *   3. Heat Up applies Burn with `ae_duplicate_mode: "stack"`, which spawns a
 *      SEPARATE Burn AE each time (skill-effects.js: "stack falls through to
 *      create a new one"). Under the charge-as-stack model that fragments Burn
 *      into multiple instances (multiple token badges, multiple independent
 *      10%-Max-HP ticks). Switch to `add_charges` so re-applied Burn MERGES into
 *      one AE and grows its charge count — keeping a single Burn whose charges =
 *      the stack count the formulas read.
 *
 *   4. Pyrophagy's turn_start reaction was mode `ask` (prompt each turn).
 *      Switch to `on` so the Salamander AUTO-converts its own Burn into healing
 *      at the start of its turn (it self-inflicts Burn via Heat Up, then Burn
 *      ticks 10% Max-HP/turn — Pyrophagy auto-fires to spend those stacks for
 *      HP). `on` = auto-fire + visible (not hidden like `force`).
 *
 * Tongue Lash (plain Physical attack) needs no change.
 *
 * CROSS-CUTTING NOTE: the charge-as-stack model means every "apply Burn" row in
 * the dungeon (Flame Breath, Hellfire, Fire Shot, Mustard Bomb, Ignis Finis,
 * Enkindle, etc.) should likewise use `add_charges`, and every "Burn Stack × N"
 * formula should read `AE_CHARGES_BURN`. Those live in their own per-monster
 * migrations; this one owns ONLY Salamander.
 *
 * RUN ONCE: NOT manifest-tagged `idempotent`, so it runs a single time then stays
 * in the world's appliedMigrations ledger — it will NOT re-apply over a co-dev's
 * later edits to these skills. Co-dev delivery is via WORLD-DATA PUSH, not this
 * migration (see feedback_world_data_sharing_hazard). The patch logic is still
 * drift-safe (checks desired value, no-ops if already correct) if it does re-run.
 *
 * NOTE: Salamander is a CO-DEV-owned world actor (Current Dungeon). This
 * migration is the durable carrier for these fixes — do not hand-edit the same
 * rows on the sheet once this owns them.
 */

export const key = "2026-06-12-dungeon-salamander-author";
export const description =
  "Fix Salamander dungeon skills: retype the no-op `grant` Blaze-consume rows " +
  "(Salamander Breath blaze_consume, Pyrophagy pyrophagy_consume) to " +
  "remove_tagged_ae so Burn is actually consumed; retarget Salamander Breath's " +
  "Blaze bonus from AE_COUNT_BURN to AE_CHARGES_BURN (charge = stack); switch " +
  "Heat Up's Burn application from `stack` to `add_charges` so Burn merges into " +
  "one charge-bearing AE; flip Pyrophagy's turn_start reaction from `ask` to " +
  "`on` so it auto-converts Burn to healing.";

const ACTOR_NAME = "Salamander";

// Per-skill patch spec. `effect_kind` retypes/patches rows matched by
// effect_label; `kind` may equal the row's current kind (then only `fields`
// are applied — used to patch a formula/option column without a retype).
const PATCHES = {
  "Salamander Breath": {
    effect_kind: [
      // charge = stack: bonus scales with total Burn charges, not instance count.
      { label: "blaze_damage", kind: "adjust_damage", fields: { damage_amount: "AE_CHARGES_BURN * 4" } },
      // no-op `grant` → real removal. filter_tag/count already on the row;
      // strip the leftover empty grant_* fields from the old `grant` shape.
      { label: "blaze_consume", kind: "remove_tagged_ae", fields: { filter_tag: "burn", count: "all" }, remove: ["grant_resource", "grant_amount"] },
    ],
  },
  "Pyrophagy": {
    effect_kind: [
      // Heal (AE_CHARGES_BURN * 5) is already correct; only the consume is a no-op grant.
      { label: "pyrophagy_consume", kind: "remove_tagged_ae", fields: { filter_tag: "burn", count: "all" }, remove: ["grant_resource", "grant_amount"] },
    ],
    // Auto-fire at turn start (eat own Burn → heal) instead of prompting.
    reaction_row_set: [{ ref: "pyrophagy_chain", set: { reaction_passive_mode: "on" } }],
  },
  "Heat Up": {
    effect_kind: [
      // `stack` spawns duplicate Burn AEs; `add_charges` merges into one AE and
      // grows its charge (= stack) count.
      { label: "heat_up_apply_burn", kind: "apply_ae", fields: { ae_duplicate_mode: "add_charges" } },
    ],
  },
};

// Apply a list of effect_kind retypes/field-sets to a cloned effect_table.
// Returns { table, changed, notes } — table is null when the source is missing.
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

// Apply field-sets to reaction_config_table rows matched by reaction_effect_ref
// (re-point a reaction's trigger / source / mode / filters). Returns
// { table, changed, notes }.
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
          else notes.push(`${ref}.${k} already "${v}"`);
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

async function patchActor(actor, log) {
  let totalChanged = 0;
  for (const [skillName, spec] of Object.entries(PATCHES)) {
    const items = actor.items.filter((i) => i.name === skillName);
    if (!items.length) { log(`  [${actor.name}] "${skillName}": item not found — skipped`); continue; }
    for (const item of items) {
      let touched = false;
      // effect_table is written via delete-then-rewrite so REMOVED keys actually
      // disappear (a plain merge can't delete a row field). Idempotent: only
      // writes when the desired table differs from the live one.
      if (spec.effect_kind) {
        const { table, changed, notes } = patchEffectKinds(item, spec.effect_kind);
        log(`  [${actor.name}] "${skillName}".effect_table: ${notes.join("; ")}`);
        if (changed && table && !deepEqual(item.system?.props?.effect_table ?? {}, table)) {
          await item.update({ "system.props.-=effect_table": null });
          await item.update({ "system.props.effect_table": table });
          touched = true;
        }
      }
      // reaction_config_table only ever has fields SET (no key removal), so a
      // merge write is sufficient.
      if (spec.reaction_row_set) {
        const { table, changed, notes } = patchReactionRow(item, spec.reaction_row_set);
        log(`  [${actor.name}] "${skillName}".reaction-row: ${notes.join("; ")}`);
        if (changed && table) { await item.update({ "system.props.reaction_config_table": table }); touched = true; }
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
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) changed += await patchActor(actor, log);
  return { applied: true, summary: `Salamander skills patched (items updated: ${changed})` };
}
