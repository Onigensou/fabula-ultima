/**
 * One-shot migration: add the debuff_count row filter to _Skill Template's
 * reaction_config_table.
 *
 * Inserts two new columns after `reaction_damage_amount`:
 *   - reaction_debuff_count_target  (select: ""/self/ally/enemy/all)
 *   - reaction_debuff_count_min     (numberField: blank or 0 = filter off)
 *
 * Both columns share a visibility formula that shows them only on triggers
 * that consult the filter:
 *   turn_start, turn_end, round_start, round_end, creature_status_applied
 *
 * After this runs, use CSB's "reload from template" button on _Skill Template
 * to propagate the schema change to existing skill items.
 *
 * Idempotent and safe to re-run.
 *
 * To use: paste into a Foundry macro (script type) and execute.
 */
(async () => {
  const TAG = "[skill-debuff-count-add]";
  const TEMPLATE_NAME = "_Skill Template";
  const TEMPLATE_TYPE = "_equippableItemTemplate";

  const VISIBILITY_FORMULA =
    'or(or(or(or(equalText(sameRow("reaction_trigger",\'\'), "turn_start"),' +
    ' equalText(sameRow("reaction_trigger",\'\'), "turn_end")),' +
    ' equalText(sameRow("reaction_trigger",\'\'), "round_start")),' +
    ' equalText(sameRow("reaction_trigger",\'\'), "round_end")),' +
    ' equalText(sameRow("reaction_trigger",\'\'), "creature_status_applied"))';

  const COL_TARGET = {
    key: "reaction_debuff_count_target",
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "Whose tokens to scan for debuffs (relative to the reactor). Leave blank to disable.",
    visibilityFormula: VISIBILITY_FORMULA,
    type: "select",
    size: "full-size",
    label: "",
    defaultValue: "",
    selectedOptionType: "custom",
    options: [
      { key: "",      value: "—" },
      { key: "self",  value: "Self" },
      { key: "ally",  value: "Ally" },
      { key: "enemy", value: "Enemy" },
      { key: "all",   value: "All" }
    ],
    align: "left",
    colName: "Debuff Group",
    readonlyPredefined: false
  };

  const COL_MIN = {
    key: "reaction_debuff_count_min",
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "Minimum total debuffs across the chosen group (blank = filter off)",
    visibilityFormula: VISIBILITY_FORMULA,
    type: "numberField",
    size: "full-size",
    label: "",
    defaultValue: "",
    allowDecimal: false,
    minVal: "0",
    maxVal: "",
    allowRelative: false,
    showControls: false,
    controlsStyle: "hover",
    controlsCustomIncrements: "",
    inputStyle: "text",
    align: "left",
    colName: "Min Debuffs",
    readonlyPredefined: false
  };

  const candidates = game.items.filter(i => i.name === TEMPLATE_NAME && i.type === TEMPLATE_TYPE);
  if (candidates.length === 0) {
    ui.notifications.error(`${TAG} No item named "${TEMPLATE_NAME}" (type ${TEMPLATE_TYPE}) found in world`);
    return;
  }
  if (candidates.length > 1) {
    const ids = candidates.map(c => c.id).join(", ");
    ui.notifications.error(`${TAG} Multiple "${TEMPLATE_NAME}" items found (${candidates.length}: ${ids}). Cannot proceed.`);
    return;
  }
  const item = candidates[0];
  console.log(`${TAG} resolved template ->`, { id: item.id, name: item.name });

  const sys = foundry.utils.deepClone(item.system);
  let tablesPatched = 0;
  let columnsAdded = 0;

  function patchRowLayout(rowLayout) {
    const hasTarget = rowLayout.some(c => c?.key === "reaction_debuff_count_target");
    const hasMin    = rowLayout.some(c => c?.key === "reaction_debuff_count_min");
    if (hasTarget && hasMin) return;

    // Anchor: insert after reaction_damage_amount; fall back to before
    // reaction_isPassive; fall back to end of layout.
    let insertAt = rowLayout.findIndex(c => c?.key === "reaction_damage_amount");
    if (insertAt >= 0) insertAt += 1;
    else {
      const passiveIdx = rowLayout.findIndex(c => c?.key === "reaction_isPassive");
      insertAt = passiveIdx >= 0 ? passiveIdx : rowLayout.length;
    }

    const toInsert = [];
    if (!hasTarget) toInsert.push(foundry.utils.deepClone(COL_TARGET));
    if (!hasMin)    toInsert.push(foundry.utils.deepClone(COL_MIN));
    rowLayout.splice(insertAt, 0, ...toInsert);
    columnsAdded += toInsert.length;
  }

  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.key === "reaction_config_table" && Array.isArray(node.rowLayout)) {
      patchRowLayout(node.rowLayout);
      tablesPatched++;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(sys);

  if (tablesPatched === 0) {
    ui.notifications.error(`${TAG} No reaction_config_table found on _Skill Template`);
    return;
  }

  if (columnsAdded === 0) {
    ui.notifications.info(`${TAG} Already up to date — both columns present`);
    console.log(`${TAG} no-op`, { tablesPatched, columnsAdded });
    return;
  }

  await item.update({ system: sys });
  ui.notifications.info(
    `${TAG} Added ${columnsAdded} column(s) to _Skill Template. ` +
    `Now click CSB's reload-from-template on _Skill Template to propagate.`
  );
  console.log(`${TAG} done`, { tablesPatched, columnsAdded });
})();
