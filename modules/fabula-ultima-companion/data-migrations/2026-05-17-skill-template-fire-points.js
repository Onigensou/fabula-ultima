/**
 * Migration: 2026-05-17-skill-template-fire-points
 * ---------------------------------------------------------------------------
 * Phase D template surgery (Path A): extend the CSB `_Skill Template` so the
 * new declarative skill-side props persist on skill items.
 *
 * CSB enforces template-column gating on `system.props.*` writes: any prop
 * whose key isn't declared as a column in the item's template is silently
 * stripped on save. Phase D added `effect_table`, `post_damage_effect_ref`,
 * and `on_activate_effect_ref` to the runtime, but skill items can't carry
 * the data without these template columns existing.
 *
 * THIS MIGRATION:
 *   1. Renames `reaction_effect_table` column → `effect_table` in the
 *      `_Skill Template` body (the only template that hosts skill items).
 *   2. Updates the `reaction_effect_ref` dropdown formula strings (4 refs)
 *      that previously read `system.props.reaction_effect_table` to read
 *      `effect_table` first with legacy fallback.
 *   3. Adds two new `textField` columns after the table:
 *      `post_damage_effect_ref` and `on_activate_effect_ref`.
 *   4. Migrates data: every item (world master AND actor-embedded copy)
 *      whose `system.props.reaction_effect_table` has rows gets its data
 *      copied to `system.props.effect_table` and the legacy key cleared.
 *
 * IDEMPOTENT: each step gated on observable state ("is the column already
 * named effect_table?", "is system.props.effect_table populated?", etc.).
 * Safe to re-run.
 *
 * SCOPE: touches only the `_Skill Template` (id j0F5Msw5RZ8aIB3j) body
 * layout + items with populated reaction_effect_table data. Does NOT touch
 * `_Skill Template (Copy)` (a dev backup, not the active template).
 */

export const key = "2026-05-17-skill-template-fire-points";
export const description =
  "CSB template surgery: rename reaction_effect_table column to effect_table, " +
  "add post_damage_effect_ref + on_activate_effect_ref text fields, " +
  "migrate item data to new prop key.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

const NEW_REF_FIELDS = [
  {
    key: "post_damage_effect_ref",
    label: "Post-Damage Effect Ref",
    tooltip: "An effect_label from the table above. Fires per-target after Create Damage Card resolves — payload context (finalValue, valueType) is available to formula identifiers like MP_DEALT."
  },
  {
    key: "on_activate_effect_ref",
    label: "On-Activate Effect Ref",
    tooltip: "RESERVED — pipeline hook pending. Will fire when the skill body activates."
  }
];

function makeTextFieldComponent(spec) {
  return {
    key: spec.key,
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: spec.tooltip ?? "",
    visibilityFormula: "",
    type: "textField",
    size: "full-size",
    label: spec.label ?? spec.key,
    defaultValue: "",
    charList: "",
    maxLength: null,
    autocomplete: ""
  };
}

// Replace formula string `system.props.reaction_effect_table` → use new key
// with legacy fallback. Idempotent: if already updated, returns input.
function patchFormulaToNewKey(formulaStr) {
  if (typeof formulaStr !== "string" || !formulaStr.length) return formulaStr;
  // Already patched form:
  if (formulaStr.includes("system.props.effect_table ?? entity.entity.system.props.reaction_effect_table")) {
    return formulaStr;
  }
  // Replace bare reference. The original reads:
  //   const t=entity.entity.system.props.reaction_effect_table;
  // We rewrite it to read effect_table with fallback to legacy key.
  return formulaStr.replace(
    /entity\.entity\.system\.props\.reaction_effect_table/g,
    "(entity.entity.system.props.effect_table ?? entity.entity.system.props.reaction_effect_table)"
  );
}

function findReactionConfigPanel(sys) {
  return sys?.body?.contents?.[0]?.contents?.[0]?.contents?.[3] ?? null;
}

async function migrateTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const panel = findReactionConfigPanel(sysClone);
  if (!panel || panel.key !== "reaction_config_panel") {
    log(`unexpected panel shape at body.contents[0].contents[0].contents[3]; skipping template`);
    return { ok: false, summary: "panel missing/moved" };
  }

  let needsWrite = false;

  // Step 1: rename reaction_effect_table -> effect_table on the table component.
  const contents = Array.isArray(panel.contents) ? panel.contents : [];
  const tableIdx = contents.findIndex(c => c?.key === "reaction_effect_table" || c?.key === "effect_table");
  if (tableIdx < 0) {
    log(`no effect-table component found in reaction_config_panel; aborting template surgery`);
    return { ok: false, summary: "table component missing" };
  }
  if (contents[tableIdx].key === "reaction_effect_table") {
    contents[tableIdx].key = "effect_table";
    needsWrite = true;
    log(`renamed table column reaction_effect_table -> effect_table`);
  }

  // Step 2: patch dropdown formulas (reaction_effect_ref's formulaKeyOptions /
  // formulaLabelOptions live in the reaction_config_table's rowLayout).
  const rct = contents.find(c => c?.key === "reaction_config_table");
  if (rct && Array.isArray(rct.rowLayout)) {
    for (const col of rct.rowLayout) {
      if (!col) continue;
      for (const fkey of ["formulaKeyOptions", "formulaLabelOptions"]) {
        const before = col[fkey];
        const after = patchFormulaToNewKey(before);
        if (after !== before) {
          col[fkey] = after;
          needsWrite = true;
          log(`patched ${col.key}.${fkey} to read effect_table with legacy fallback`);
        }
      }
    }
  }

  // Step 3: add the two new ref text fields (idempotent).
  for (const refSpec of NEW_REF_FIELDS) {
    if (contents.some(c => c?.key === refSpec.key)) continue;
    contents.push(makeTextFieldComponent(refSpec));
    needsWrite = true;
    log(`added column ${refSpec.key}`);
  }

  if (!needsWrite) {
    return { ok: true, summary: "template already migrated" };
  }

  await template.update({ system: sysClone });
  return { ok: true, summary: "template updated" };
}

async function migrateItemData(item, log) {
  const props = item.system?.props ?? {};
  const oldTable = props.reaction_effect_table;
  if (!oldTable || typeof oldTable !== "object") return false;

  // Has actual rows?
  const oldRowCount = Object.values(oldTable).filter(r => r && !r.$deleted).length;
  if (oldRowCount === 0) return false;

  const newTable = props.effect_table;
  const newHasRows =
    newTable && typeof newTable === "object" &&
    Object.values(newTable).filter(r => r && !r.$deleted).length > 0;

  if (newHasRows) {
    // Already migrated. Clear legacy if still present.
    if (Object.keys(oldTable).length > 0) {
      await item.update({ "system.props.-=reaction_effect_table": null });
      log(`cleared legacy reaction_effect_table on item "${item.name}" [${item.id}]`);
    }
    return false;
  }

  await item.update({
    "system.props.effect_table": foundry.utils.duplicate(oldTable),
    "system.props.-=reaction_effect_table": null
  });
  log(`migrated reaction_effect_table -> effect_table on item "${item.name}" [${item.id}] (${oldRowCount} rows)`);
  return true;
}

export async function migrate(game, log) {
  // Phase 1: template surgery.
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }
  const tplResult = await migrateTemplate(template, log);
  if (!tplResult.ok) {
    return { applied: false, summary: tplResult.summary };
  }

  // Phase 2: item data migration. Walk world masters AND actor-embedded copies.
  let migrated = 0;
  for (const item of game.items?.contents ?? []) {
    try {
      if (await migrateItemData(item, log)) migrated++;
    } catch (e) {
      log(`world item "${item.name}" [${item.id}] migration failed: ${e?.message ?? e}`);
    }
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      try {
        if (await migrateItemData(item, log)) migrated++;
      } catch (e) {
        log(`actor "${actor.name}" item "${item.name}" [${item.id}] migration failed: ${e?.message ?? e}`);
      }
    }
  }

  return {
    applied: true,
    summary: `${tplResult.summary}; ${migrated} item${migrated === 1 ? "" : "s"} data-migrated`
  };
}
