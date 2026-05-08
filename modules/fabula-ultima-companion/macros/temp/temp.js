/**
 * One-shot migration: add the declarative resource-grant columns to
 * _Skill Template's reaction_config_table.
 *
 * Inserts three new columns after `reaction_debuff_count_min`:
 *   - reaction_grant_resource  (select: ""/hp/mp/ip/zero_power/zenit/enmity)
 *   - reaction_grant_amount    (numberField; negative drains; blank/0 = off)
 *   - reaction_grant_target    (select: self/ally/enemy/all; default self)
 *
 * The amount and target columns are gated by visibilityFormula to only show
 * when reaction_grant_resource is set.
 *
 * After this runs, use CSB's "reload from template" button on _Skill Template
 * to propagate the schema change to existing skill items.
 *
 * Idempotent and safe to re-run.
 *
 * To use: paste into a Foundry macro (script type) and execute.
 */
(async () => {
  const TAG = "[skill-grant-cols-add]";
  const TEMPLATE_NAME = "_Skill Template";
  const TEMPLATE_TYPE = "_equippableItemTemplate";

  const VISIBILITY_GATED =
    'not(equalText(sameRow("reaction_grant_resource",\'\'), ""))';

  const COL_RESOURCE = {
    key: "reaction_grant_resource",
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "Resource to grant when this reaction fires (independent of the chosen skill's effects). Leave blank to disable.",
    visibilityFormula: "",
    type: "select",
    size: "full-size",
    label: "",
    defaultValue: "",
    selectedOptionType: "custom",
    options: [
      { key: "",           value: "—" },
      { key: "hp",         value: "HP" },
      { key: "mp",         value: "MP" },
      { key: "ip",         value: "IP" },
      { key: "zero_power", value: "Zero Power" },
      { key: "zenit",      value: "Zenit" },
      { key: "enmity",     value: "Enmity" }
    ],
    align: "left",
    colName: "Grant",
    readonlyPredefined: false
  };

  const COL_AMOUNT = {
    key: "reaction_grant_amount",
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "Amount to grant. Negative values drain. Empty or 0 disables the grant.",
    visibilityFormula: VISIBILITY_GATED,
    type: "numberField",
    size: "full-size",
    label: "",
    defaultValue: "",
    allowDecimal: false,
    minVal: "",
    maxVal: "",
    allowRelative: false,
    showControls: false,
    controlsStyle: "hover",
    controlsCustomIncrements: "",
    inputStyle: "text",
    align: "left",
    colName: "Amount",
    readonlyPredefined: false
  };

  const COL_TARGET = {
    key: "reaction_grant_target",
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "Who receives the grant (relative to the reactor). Default: self. Ally includes the reactor.",
    visibilityFormula: VISIBILITY_GATED,
    type: "select",
    size: "full-size",
    label: "",
    defaultValue: "self",
    selectedOptionType: "custom",
    options: [
      { key: "self",  value: "Self" },
      { key: "ally",  value: "Ally" },
      { key: "enemy", value: "Enemy" },
      { key: "all",   value: "All" }
    ],
    align: "left",
    colName: "Recipient",
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
    const has = key => rowLayout.some(c => c?.key === key);
    const hasResource = has("reaction_grant_resource");
    const hasAmount   = has("reaction_grant_amount");
    const hasTarget   = has("reaction_grant_target");
    if (hasResource && hasAmount && hasTarget) return;

    // Anchor: insert after reaction_debuff_count_min if present, else after
    // reaction_damage_amount, else before reaction_isPassive, else end.
    const anchorPriority = ["reaction_debuff_count_min", "reaction_damage_amount"];
    let insertAt = -1;
    for (const k of anchorPriority) {
      const idx = rowLayout.findIndex(c => c?.key === k);
      if (idx >= 0) { insertAt = idx + 1; break; }
    }
    if (insertAt < 0) {
      const passiveIdx = rowLayout.findIndex(c => c?.key === "reaction_isPassive");
      insertAt = passiveIdx >= 0 ? passiveIdx : rowLayout.length;
    }

    const toInsert = [];
    if (!hasResource) toInsert.push(foundry.utils.deepClone(COL_RESOURCE));
    if (!hasAmount)   toInsert.push(foundry.utils.deepClone(COL_AMOUNT));
    if (!hasTarget)   toInsert.push(foundry.utils.deepClone(COL_TARGET));
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
    ui.notifications.info(`${TAG} Already up to date — all 3 grant columns present`);
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
