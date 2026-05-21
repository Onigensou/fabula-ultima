/**
 * Migration: 2026-05-20-skills-to-unified-targeting
 * ---------------------------------------------------------------------------
 * Skill-data side of the unified-targeting refactor (Phase F). Rewrites the
 * three live declarative skills (Painful Lesson / Heart of Darkness / Drain
 * Spirit) to use the new `effect_kind: "targeting"` + `target_ref` pattern
 * and removes their now-defunct legacy targeting fields.
 *
 * Companion to:
 *   - `2026-05-20-effect-targeting-columns.js` (template-side editor surgery)
 *   - The `effect-targeting-resolver.js` runtime
 *   - The handler refactors in `reaction-grant.js` that read `target_ref`
 *
 * Must run AFTER the handler refactors ship — handlers no longer read
 * `grant_target` / `target_lock`, so a skill still carrying them but not
 * yet carrying `target_ref` silently fails at fire time. This migration
 * closes that gap.
 *
 * SCOPE:
 *   - Painful Lesson   — open_action_menu, target_lock="damage_source"
 *     → add `pl_attacker` row (candidate_source: trigger_actor, mode: exact, count: 1)
 *     → set pl_free_study.target_ref = "pl_attacker"
 *     → remove pl_free_study.target_lock
 *   - Heart of Darkness — apply_ae, grant_target="self"
 *     → add `hod_self` row (candidate_source: self)
 *     → set hod_arm.target_ref = "hod_self"
 *     → remove hod_arm.{grant_target, ae_target}
 *   - Drain Spirit     — grant, grant_target="self"
 *     → add `ds_self` row (candidate_source: self)
 *     → set drain_recover.target_ref = "ds_self"
 *     → remove drain_recover.grant_target
 *
 * Touches BOTH world master items (`game.items`) and actor-embedded copies
 * (`actor.items`). Idempotent: skips a skill whose effect_table already
 * contains a `targeting` row matching the expected `effect_label`.
 */

export const key = "2026-05-20-skills-to-unified-targeting";
export const description =
  "Migrate Painful Lesson / Heart of Darkness / Drain Spirit effect_tables " +
  "to the unified targeting system: add `targeting` rows, set `target_ref`, " +
  "remove legacy grant_target / target_lock / ae_target fields. Master + " +
  "actor copies.";

// Per-skill migration recipe. Each entry describes the consumer mutations
// (which existing row gets a target_ref / destination_ref + which legacy
// fields to strip from it) and the new targeting rows to append.
//
// COMMON_STRIP_LEGACY is applied uniformly — these are all the deprecated
// fields the new handlers no longer read. Stripping them all from every
// consumer row leaves the row clean regardless of original kind.
const COMMON_STRIP_LEGACY = [
  "grant_target",
  "target_lock",
  "target_select",
  "ae_target",
  "charge_target",
  "target_source",
  "target_category",
  "target_mode",
  "target_count"
];

const TARGETING_DEFAULTS = {
  auto_confirm_when_obvious: true,
  skip_when_passive: true,
  iteration_mode: "together"
};

function targetingRow(spec) {
  return {
    effect_kind: "targeting",
    category: "",
    ...TARGETING_DEFAULTS,
    ...spec
  };
}

const RECIPES = [
  {
    name: "Painful Lesson",
    consumers: [
      { label: "pl_free_study", targetRef: "pl_attacker" }
    ],
    targetingRows: [
      targetingRow({
        effect_label: "pl_attacker",
        candidate_source: "trigger_actor",
        mode: "exact",
        count: 1
      })
    ]
  },
  {
    name: "Heart of Darkness",
    consumers: [
      { label: "hod_arm", targetRef: "hod_self" }
    ],
    targetingRows: [
      targetingRow({
        effect_label: "hod_self",
        candidate_source: "self",
        mode: "exact",
        count: 1
      })
    ]
  },
  {
    name: "Drain Spirit",
    consumers: [
      { label: "drain_recover", targetRef: "ds_self" }
    ],
    targetingRows: [
      targetingRow({
        effect_label: "ds_self",
        candidate_source: "self",
        mode: "exact",
        count: 1
      })
    ]
  },
  {
    // Protect uses TWO targeting rows: self (for the gate's consume_charge,
    // the refill's apply_ae, and the redirect destination) + action_targets
    // (which slot of the incoming action to redirect).
    name: "Protect",
    masterId: "gTXdzJjV4Lmwfm7i",       // skip the empty-stub Protect item
    consumers: [
      { label: "protect_gate",     targetRef: "protect_self" },
      { label: "protect_refill",   targetRef: "protect_self" },
      { label: "protect_redirect", targetRef: "protect_incoming", destinationRef: "protect_self" }
    ],
    targetingRows: [
      targetingRow({
        effect_label: "protect_self",
        candidate_source: "self",
        mode: "exact",
        count: 1
      }),
      targetingRow({
        effect_label: "protect_incoming",
        candidate_source: "action_targets",
        mode: "exact",
        count: 1
      })
    ]
  }
];

function tableToArray(tbl) {
  if (!tbl) return [];
  if (Array.isArray(tbl)) return tbl.slice();
  // Object form keyed by row id. Preserve key order so the editor's row
  // ordering matches the new array index after migration.
  return Object.keys(tbl).map(k => tbl[k]);
}

function arrayToObjectTable(arr) {
  const out = {};
  arr.forEach((row, i) => { out[String(i)] = row; });
  return out;
}

function applyRecipeToTable(tbl, recipe) {
  const rows = tableToArray(tbl);
  let modified = false;

  // For every declared consumer: locate by label, set target_ref +
  // optional destination_ref, strip legacy fields.
  const consumersTouched = [];
  for (const consumerSpec of recipe.consumers ?? []) {
    const consumer = rows.find(r => r && r.effect_label === consumerSpec.label);
    if (!consumer) continue;

    if (consumer.target_ref !== consumerSpec.targetRef) {
      consumer.target_ref = consumerSpec.targetRef;
      modified = true;
    }
    if (consumerSpec.destinationRef && consumer.destination_ref !== consumerSpec.destinationRef) {
      consumer.destination_ref = consumerSpec.destinationRef;
      modified = true;
    }
    for (const legacyKey of COMMON_STRIP_LEGACY) {
      if (Object.prototype.hasOwnProperty.call(consumer, legacyKey)) {
        delete consumer[legacyKey];
        modified = true;
      }
    }
    consumersTouched.push(consumer);
  }

  // If no consumer row matched at all, this isn't the right item — bail
  // (caller will skip writing).
  if (!consumersTouched.length) return { rows, modified: false };

  // Strip legacy fields from every other row too (chain rows etc.) — they
  // don't read them, but the user wants the config strictly clean. Skip
  // targeting rows (they were just authored fresh).
  for (const row of rows) {
    if (!row || row.effect_kind === "targeting") continue;
    if (consumersTouched.includes(row)) continue; // already stripped above
    for (const legacyKey of COMMON_STRIP_LEGACY) {
      if (Object.prototype.hasOwnProperty.call(row, legacyKey)) {
        delete row[legacyKey];
        modified = true;
      }
    }
  }

  // Append every targeting row that isn't already there.
  for (const tRow of recipe.targetingRows ?? []) {
    const exists = rows.some(r =>
      r && r.effect_label === tRow.effect_label && r.effect_kind === "targeting"
    );
    if (!exists) {
      rows.push({ $deleted: false, ...tRow });
      modified = true;
    }
  }

  return { rows, modified };
}

async function migrateItem(item, log) {
  const props = item.system?.props ?? {};
  const tbl = props.effect_table;
  if (!tbl) return false;

  const recipe = RECIPES.find(r => r.name === item.name);
  if (!recipe) return false;

  // Recipe may pin to a specific masterId — used to disambiguate when the
  // world has duplicate-named items (e.g. an empty Protect stub alongside
  // the real Protect). Match by item id (master itself) OR system.uniqueId
  // (actor copies link via uniqueId per the skill template-link contract).
  if (recipe.masterId) {
    const matches = item.id === recipe.masterId
                 || item.system?.uniqueId === recipe.masterId;
    if (!matches) return false;
  }

  // Find every consumer row's original key (object form) so we can target
  // explicit legacy-field removals at the right paths.
  const isArray = Array.isArray(tbl);
  const originalKeys = isArray ? tbl.map((_, i) => String(i)) : Object.keys(tbl);
  const keyByLabel = new Map();
  for (const k of originalKeys) {
    const r = isArray ? tbl[Number(k)] : tbl[k];
    if (r?.effect_label) keyByLabel.set(r.effect_label, k);
  }

  const { rows, modified } = applyRecipeToTable(tbl, recipe);
  if (!modified) return false;

  // Foundry's `update()` deep-merges. Writing the new effect_table alone
  // would leave any legacy fields present in the old row at the same key.
  // Emit explicit `-=` removals at EVERY original row's key for every
  // legacy field. Idempotent: `-=` of a non-existent key is a no-op.
  const newTable = arrayToObjectTable(rows);
  const patch = { "system.props.effect_table": newTable };
  for (const k of keyByLabel.values()) {
    for (const legacyKey of COMMON_STRIP_LEGACY) {
      patch[`system.props.effect_table.${k}.-=${legacyKey}`] = null;
    }
  }
  await item.update(patch);
  log(`migrated "${item.name}" [${item.id}] — ${rows.length} rows, consumers=[${(recipe.consumers ?? []).map(c => c.label).join(", ")}]`);
  return true;
}

export async function migrate(game, log) {
  let migrated = 0;

  // Phase 1: world master items.
  for (const item of game.items?.contents ?? []) {
    try {
      if (await migrateItem(item, log)) migrated++;
    } catch (e) {
      log(`master "${item.name}" [${item.id}] failed: ${e?.message ?? e}`);
    }
  }

  // Phase 2: actor-embedded copies.
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      try {
        if (await migrateItem(item, log)) migrated++;
      } catch (e) {
        log(`actor "${actor.name}" item "${item.name}" [${item.id}] failed: ${e?.message ?? e}`);
      }
    }
  }

  return {
    applied: true,
    summary: `${migrated} item${migrated === 1 ? "" : "s"} migrated to unified targeting`
  };
}
