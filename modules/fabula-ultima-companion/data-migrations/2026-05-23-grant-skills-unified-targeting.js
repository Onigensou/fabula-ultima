/**
 * Migration: 2026-05-23-grant-skills-unified-targeting
 * ---------------------------------------------------------------------------
 * Sweep migration for the `grant` effect_kind skills missed by the original
 * 2026-05-20-skills-to-unified-targeting recipe (which only enumerated
 * Painful Lesson / Heart of Darkness / Drain Spirit / Protect).
 *
 * After Phase F, `applyGrantEffect` requires `target_ref` pointing at a
 * `targeting` row; missing it returns `{ ok: false, reason: "missing_target_ref" }`
 * and the skill silently does nothing. Three more skills shipped with the
 * same shape and never got migrated:
 *
 *   - Absorb MP                 (creature_takes_damage → grant MP "SL * 2")
 *   - Zero Trigger: Foresight   (creature_check_outcome_flipped → grant ZP 1)
 *   - Zero Trigger: Motivation  (creature_unleashes_zero_power → grant ZP 6)
 *
 * All three target the reactor (self). For each: add a `<prefix>_self`
 * targeting row (candidate_source: "self", mode: "exact", count: 1), set
 * `target_ref` on the existing grant row, and strip the deprecated targeting
 * fields (`grant_target`, `ae_target`, `target_select`, etc.) — same
 * cleanup the original Phase F migration did for the four it covered.
 *
 * Targeting-row naming follows the existing convention:
 *   - hod_self  (Heart of Darkness)
 *   - ds_self   (Drain Spirit)
 *   - pl_attacker (Painful Lesson)
 *   - amp_self / ztf_self / ztm_self  ← added here
 *
 * IDEMPOTENT: skips items whose grant row already has the right target_ref
 * AND the targeting row exists. Master + every actor copy.
 */

export const key = "2026-05-23-grant-skills-unified-targeting";
export const description =
  "Add `target_ref` + self-targeting row to Absorb MP / Zero Trigger: Foresight / " +
  "Zero Trigger: Motivation grant rows. Master + actor copies. Strip legacy " +
  "grant_target / ae_target / target_select etc.";

const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

// Same set the original Phase F migration stripped.
const LEGACY_STRIP = [
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

const TARGETING_DEFAULTS = Object.freeze({
  auto_confirm_when_obvious: true,
  skip_when_passive:         true,
  iteration_mode:            "together"
});

function targetingRow(label) {
  return {
    $deleted:         false,
    effect_kind:      "targeting",
    effect_label:     label,
    candidate_source: "self",
    category:         "",
    mode:             "exact",
    count:            1,
    exclude_self:     false,
    ...TARGETING_DEFAULTS
  };
}

// Per-skill recipe. The consumer label is the existing grant row's
// effect_label (preserved). The targeting label is freshly authored.
const RECIPES = [
  { name: "Absorb MP",                 consumerLabel: "absorb_mp_recover", targetingLabel: "amp_self" },
  { name: "Zero Trigger: Foresight",   consumerLabel: "ZP on Flip",        targetingLabel: "ztf_self" },
  { name: "Zero Trigger: Motivation",  consumerLabel: "ZP refill",         targetingLabel: "ztm_self" }
];

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

function tableToArray(tbl) {
  if (!tbl) return [];
  if (Array.isArray(tbl)) return tbl.slice();
  // Preserve declaration order to keep editor row indices stable.
  return Object.keys(tbl).map(k => tbl[k]);
}

function arrayToObject(arr) {
  const out = {};
  arr.forEach((row, i) => { out[String(i)] = row; });
  return out;
}

async function migrateOne(item, recipe, log, ownerLabel) {
  const props = item.system?.props ?? {};
  const tbl   = props.effect_table;
  if (!tbl || typeof tbl !== "object") return false;

  const rows = tableToArray(tbl);

  // Locate the grant row by either effect_label OR effect_kind.
  // (The label is the cleanest match; falling back to "first grant row"
  // would surprise authors who renamed it.)
  const grantRow = rows.find(r =>
    r && !r.$deleted &&
    String(r.effect_label ?? "") === recipe.consumerLabel &&
    String(r.effect_kind ?? "").trim().toLowerCase() === "grant"
  );
  if (!grantRow) {
    log(`  ${ownerLabel}: no grant row matching "${recipe.consumerLabel}" — skipping`);
    return false;
  }

  const hasTargeting   = rows.some(r => r && !r.$deleted && r.effect_label === recipe.targetingLabel && r.effect_kind === "targeting");
  const grantHasRef    = String(grantRow.target_ref ?? "") === recipe.targetingLabel;
  const grantHasLegacy = LEGACY_STRIP.some(k => Object.prototype.hasOwnProperty.call(grantRow, k));

  if (hasTargeting && grantHasRef && !grantHasLegacy) {
    log(`  ${ownerLabel}: already migrated — skip`);
    return false;
  }

  // Mutate rows in place: set target_ref, strip legacy, append targeting row.
  if (!grantHasRef) grantRow.target_ref = recipe.targetingLabel;
  for (const legacyKey of LEGACY_STRIP) {
    if (Object.prototype.hasOwnProperty.call(grantRow, legacyKey)) {
      delete grantRow[legacyKey];
    }
  }
  if (!hasTargeting) {
    rows.push(targetingRow(recipe.targetingLabel));
  }

  // Write. Deep-merge would leave legacy fields untouched on the row's
  // original key, so emit explicit `-=removal` paths for each original
  // row key × each legacy field. Idempotent.
  const isArray = Array.isArray(tbl);
  const originalKeys = isArray ? tbl.map((_, i) => String(i)) : Object.keys(tbl);
  const newTable = arrayToObject(rows);
  const patch = { "system.props.effect_table": newTable };
  for (const k of originalKeys) {
    for (const legacyKey of LEGACY_STRIP) {
      patch[`system.props.effect_table.${k}.-=${legacyKey}`] = null;
    }
  }
  await item.update(patch);
  log(`  ${ownerLabel}: linked "${recipe.consumerLabel}" → "${recipe.targetingLabel}" (legacy fields stripped)`);
  return true;
}

export async function migrate(game, log) {
  const byName = new Map(RECIPES.map(r => [r.name, r]));
  let touched = 0;

  // Phase 1: master items.
  for (const item of (game.items?.contents ?? [])) {
    if (!templateMatches(item)) continue;
    const recipe = byName.get(item.name);
    if (!recipe) continue;
    log(`master "${item.name}" [${item.id}]:`);
    try {
      if (await migrateOne(item, recipe, log, "master")) touched++;
    } catch (e) {
      log(`  master "${item.name}" [${item.id}] failed: ${e?.message ?? e}`);
    }
  }

  // Phase 2: actor-embedded copies.
  for (const actor of (game.actors?.contents ?? [])) {
    for (const item of (actor.items?.contents ?? [])) {
      if (!templateMatches(item)) continue;
      const recipe = byName.get(item.name);
      if (!recipe) continue;
      log(`actor "${actor.name}" "${item.name}" [${item.id}]:`);
      try {
        if (await migrateOne(item, recipe, log, `actor "${actor.name}"`)) touched++;
      } catch (e) {
        log(`  actor "${actor.name}" "${item.name}" [${item.id}] failed: ${e?.message ?? e}`);
      }
    }
  }

  return {
    applied: true,
    summary: `${touched} item${touched === 1 ? "" : "s"} migrated to unified targeting`
  };
}
