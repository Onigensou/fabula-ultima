/**
 * Migration: 2026-06-05-weapon-onhit-convert
 * ---------------------------------------------------------------------------
 * Weapons-as-skill-shaped-items (Option B), step 3 of 3 — legacy on-hit
 * conversion + skill_target defaults.
 *
 * Runs AFTER the template surgery (step 1) has been live for a boot, so the
 * new columns are baked into weapon derivation and writes to them STICK
 * (the step-2 backfill's same-boot skill_target write was stripped by the
 * classic CSB surgery-then-write ordering — this step, a separate boot, sets
 * it for real).
 *
 * Converts each weapon's legacy `active_effect_config_table` on-hit row into
 * the modern BD shape: a `creature_deals_damage` reaction_config_table row
 * (auto-firing passive, reaction_source "self") whose reaction_effect_ref
 * points at an `effect_table` apply_ae row targeting the struck creature
 * (target_ref "trigger_subject"). The AE is referenced by the name of the
 * weapon's EMBEDDED ActiveEffect (resolveAeTemplate finds it via
 * ctx.skill.effects at fire time).
 *
 * Gate per apply_mode (semantics confirmed with the designer 2026-06-05):
 *   - "conquer"    → condition_formula "HIT_MARGIN >= <dl>"   (accuracy total
 *                    beat the target's DEF/MDEF by at least <dl>). Uses the new
 *                    HIT_MARGIN identifier + per-target hitMargin payload.
 *   - "percentage" → condition_formula "chance(<percent>)"    (N% chance).
 *                    Uses the new chance() formula function.
 *
 * Converted legacy rows are MOVED (marked $deleted in
 * active_effect_config_table) for a single source of truth. Rows whose
 * apply_mode has no converter, or whose active_effect_id doesn't resolve to a
 * named embedded AE, are LEFT intact and REPORTED — never silently faked.
 *
 * IDEMPOTENT: a weapon already carrying the converted reaction row (matched by
 * the stable effect_label) is skipped.
 */

export const key = "2026-06-05-weapon-onhit-convert";
export const description =
  "Convert weapon legacy active_effect_config_table on-hit rows to BD " +
  "creature_deals_damage reaction + apply_ae (conquer→HIT_MARGIN>=N, " +
  "percentage→chance(N)); MOVE converted rows; default skill_target.";

const DEFAULT_TARGET = "One Enemy";
const ON_HIT_TRIGGERS = new Set(["on_hit", "on_attack"]);

function isWeapon(item) {
  return String(item?.system?.props?.item_type ?? "").toLowerCase() === "weapon";
}
function liveEntries(table) {
  if (!table || typeof table !== "object") return [];
  return Object.entries(table).filter(([, r]) => r && !r.$deleted);
}
function nextKey(table) {
  let n = 0;
  while (Object.prototype.hasOwnProperty.call(table, String(n))) n++;
  return n;
}
function slug(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Build the {effectRow, reactionRow, label} for one legacy row, or null if
// the mode/AE can't be converted (caller reports it).
function convertRow(legacyRow, weaponItem) {
  const mode = String(legacyRow.active_effect_apply_mode ?? "").toLowerCase().trim();
  const aeId = String(legacyRow.active_effect_id ?? "").trim();
  const ae = aeId ? weaponItem.effects?.get?.(aeId) : null;
  const aeName = ae?.name ?? null;
  if (!aeName) return { error: `active_effect_id "${aeId}" → no named embedded AE` };

  let condition_formula = null;
  let labelSuffix = null;
  if (mode === "conquer") {
    const dl = Number(legacyRow.active_effect_dl ?? 0) || 0;
    condition_formula = `HIT_MARGIN >= ${dl}`;
    labelSuffix = `m${dl}`;
  } else if (mode === "percentage") {
    const pct = Number(legacyRow.active_effect_percent ?? 0) || 0;
    condition_formula = `chance(${pct})`;
    labelSuffix = `p${pct}`;
  } else {
    return { error: `no converter for apply_mode "${mode}"` };
  }

  const label = `onhit_${slug(aeName)}_${labelSuffix}`;
  return {
    label,
    effectRow: {
      effect_label: label,
      effect_kind: "apply_ae",
      ae_template_ref: aeName,
      target_ref: "trigger_subject",
      ae_duplicate_mode: "replace",
    },
    reactionRow: {
      reaction_trigger: "creature_deals_damage",
      reaction_source: "self",
      reaction_isPassive: true,
      reaction_passive_mode: "on",
      reaction_effect_ref: label,
      condition_formula,
    },
  };
}

function planWeapon(item) {
  const props = item.system?.props ?? {};
  const out = { update: {}, report: [], convertedLabels: [], targetSet: false };

  // skill_target default.
  if (!String(props.skill_target ?? "").trim()) {
    out.update["system.props.skill_target"] = DEFAULT_TARGET;
    out.targetSet = true;
  }

  const legacy = liveEntries(props.active_effect_config_table);
  if (!legacy.length) return out;

  const effect = foundry.utils.duplicate(props.effect_table ?? {});
  const reaction = foundry.utils.duplicate(props.reaction_config_table ?? {});
  const legacyTbl = foundry.utils.duplicate(props.active_effect_config_table ?? {});

  // Set of effect_labels already present (idempotency).
  const existingLabels = new Set(liveEntries(effect).map(([, r]) => r.effect_label));
  let converted = 0;

  for (const [legacyKey, row] of legacy) {
    const trig = String(row.active_effect_trigger ?? "").toLowerCase().trim();
    if (!ON_HIT_TRIGGERS.has(trig)) {
      out.report.push({ weapon: item.name, reason: `trigger "${trig}" not on-hit; left intact` });
      continue;
    }
    const built = convertRow(row, item);
    if (built.error) {
      out.report.push({ weapon: item.name, mode: row.active_effect_apply_mode, reason: built.error });
      continue;
    }
    if (existingLabels.has(built.label)) {
      // Already converted in a prior run — just ensure the legacy row is gone.
      legacyTbl[legacyKey] = { $deleted: true };
      continue;
    }
    effect[String(nextKey(effect))] = built.effectRow;
    reaction[String(nextKey(reaction))] = built.reactionRow;
    legacyTbl[legacyKey] = { $deleted: true }; // MOVE
    existingLabels.add(built.label);
    out.convertedLabels.push(built.label);
    converted++;
  }

  if (converted > 0) {
    out.update["system.props.effect_table"] = effect;
    out.update["system.props.reaction_config_table"] = reaction;
    out.update["system.props.active_effect_config_table"] = legacyTbl;
  }
  return out;
}

export async function migrate(game, log) {
  const report = [];
  let targetDefaulted = 0;
  let weaponsConverted = 0;
  let rowsConverted = 0;

  let refreshed = 0;
  async function run(items) {
    for (const item of items) {
      if (!isWeapon(item)) continue;
      let plan;
      try { plan = planWeapon(item); }
      catch (e) { log(`plan failed "${item.name}" [${item.id}]: ${e?.message ?? e}`); continue; }
      report.push(...plan.report);
      if (plan.targetSet) targetDefaulted++;
      if (plan.convertedLabels.length) { weaponsConverted++; rowsConverted += plan.convertedLabels.length; }
      if (Object.keys(plan.update).length) {
        try { await item.update(plan.update); }
        catch (e) { log(`update failed "${item.name}" [${item.id}]: ${e?.message ?? e}`); }
        // Refresh the item from its (surgically-extended) template so the new
        // skill_target / effect_table / reaction_config_table columns RENDER on
        // the weapon sheet (the GM can then see/edit on-hit effects). CSB's
        // reloadTemplate preserves existing prop values — the rows we just
        // wrote survive — and only fills newly-added columns. Gated on "had an
        // update" so idempotent re-runs (nothing changed) don't re-refresh all
        // 458 weapons every boot. The runtime pipeline reads stored props
        // directly and doesn't need this; it's purely for the editor sheet.
        try { await item.templateSystem?.reloadTemplate?.(); refreshed++; }
        catch (e) { log(`reloadTemplate failed "${item.name}" [${item.id}]: ${e?.message ?? e}`); }
      }
    }
  }

  await run(game.items?.contents ?? []);
  for (const actor of game.actors?.contents ?? []) await run(actor.items?.contents ?? []);

  if (report.length) {
    log(`weapon on-hit rows NOT converted (${report.length}) — left intact:`);
    for (const r of report) log(`  • ${r.weapon}: ${r.reason}${r.mode ? ` (mode=${r.mode})` : ""}`);
  }

  return {
    applied: true,
    summary: `converted ${rowsConverted} on-hit row(s) on ${weaponsConverted} weapon(s); ` +
      `skill_target defaulted on ${targetDefaulted}; ${refreshed} weapon(s) template-refreshed; ` +
      `${report.length} row(s) reported.`,
  };
}
