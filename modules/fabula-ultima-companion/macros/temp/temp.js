/**
 * One-shot migration: split reaction_config_table into a trigger table
 * + sibling reaction_effect_table on _Skill Template, and migrate any
 * existing grant data on player skill items into the new structure.
 *
 * Schema changes on _Skill Template:
 *   - reaction_config_table.rowLayout: remove 3 columns
 *       (reaction_grant_resource, reaction_grant_amount, reaction_grant_target)
 *     and add 1 column (reaction_effect_ref, formula-driven select).
 *   - Add a new sibling dynamicTable: reaction_effect_table with columns
 *       effect_label, effect_kind, grant_resource, grant_amount, grant_target.
 *
 * Data migration on every world item with reaction_config_table rows that
 * carry grant fields:
 *   - For each trigger row with reaction_grant_resource set, ensure an
 *     entry exists in reaction_effect_table (auto-named "effect-1", "-2",...).
 *     Set the trigger row's reaction_effect_ref to that label, then clear the
 *     legacy reaction_grant_* fields.
 *
 * After this runs, click CSB's "reload from template" on _Skill Template to
 * propagate the new rowLayout to existing skill items.
 *
 * Idempotent and safe to re-run.
 *
 * To use: paste into a Foundry macro (script type) and execute.
 */
(async () => {
  const TAG = "[skill-effect-table-restructure]";
  const TEMPLATE_NAME = "_Skill Template";
  const TEMPLATE_TYPE = "_equippableItemTemplate";

  const VISIBILITY_GRANT_KIND = 'equalText(sameRow("effect_kind",\'\'), "grant")';

  // ---------------------------------------------------------------------------
  // Column definitions used to rebuild the trigger row + new effect table.
  // ---------------------------------------------------------------------------
  const COL_EFFECT_REF = {
    key: "reaction_effect_ref",
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "Pick an effect (by label) from the Effects table below to fire when this trigger matches. Leave blank to fire only the chosen reaction skill itself.",
    visibilityFormula: "",
    type: "select",
    size: "full-size",
    label: "",
    defaultValue: "",
    selectedOptionType: "formula",
    options: [],
    formulaKeyOptions:
      "${%{const t=entity.entity.system.props.reaction_effect_table; const rows=t==null?[]:(Array.isArray(t)?t:Object.values(t)); return [''].concat(rows.map(r=>r&&r.effect_label).filter(s=>typeof s==='string'&&s.length>0));}%}$",
    formulaLabelOptions:
      "${%{const t=entity.entity.system.props.reaction_effect_table; const rows=t==null?[]:(Array.isArray(t)?t:Object.values(t)); return ['—'].concat(rows.map(r=>r&&r.effect_label).filter(s=>typeof s==='string'&&s.length>0));}%}$",
    align: "left",
    colName: "Effect",
    readonlyPredefined: false
  };

  const EFFECT_ROW_LAYOUT = [
    {
      key: "effect_label",
      colSpan: 1,
      rowSpan: 1,
      cssClass: "",
      role: 0,
      editRole: 0,
      permission: 0,
      tooltip: "Unique label for this effect. The trigger table's Effect column lists these.",
      visibilityFormula: "",
      type: "textField",
      size: "full-size",
      label: "",
      defaultValue: "",
      align: "left",
      colName: "Label",
      readonlyPredefined: false
    },
    {
      key: "effect_kind",
      colSpan: 1,
      rowSpan: 1,
      cssClass: "",
      role: 0,
      editRole: 0,
      permission: 0,
      tooltip: "What kind of effect this row produces.",
      visibilityFormula: "",
      type: "select",
      size: "full-size",
      label: "",
      defaultValue: "grant",
      selectedOptionType: "custom",
      options: [
        { key: "grant", value: "Grant Resource" }
      ],
      align: "left",
      colName: "Kind",
      readonlyPredefined: false
    },
    {
      key: "grant_resource",
      colSpan: 1,
      rowSpan: 1,
      cssClass: "",
      role: 0,
      editRole: 0,
      permission: 0,
      tooltip: "Resource to grant. Leave blank to disable this effect.",
      visibilityFormula: VISIBILITY_GRANT_KIND,
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
      colName: "Resource",
      readonlyPredefined: false
    },
    {
      key: "grant_amount",
      colSpan: 1,
      rowSpan: 1,
      cssClass: "",
      role: 0,
      editRole: 0,
      permission: 0,
      tooltip: "Amount to grant. Negative values drain. Empty or 0 disables this effect.",
      visibilityFormula: VISIBILITY_GRANT_KIND,
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
    },
    {
      key: "grant_target",
      colSpan: 1,
      rowSpan: 1,
      cssClass: "",
      role: 0,
      editRole: 0,
      permission: 0,
      tooltip: "Who receives the grant (relative to the reactor). Default: self. Ally includes the reactor.",
      visibilityFormula: VISIBILITY_GRANT_KIND,
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
    }
  ];

  function makeEffectTableField() {
    return {
      key: "reaction_effect_table",
      colSpan: 1,
      rowSpan: 1,
      cssClass: "",
      role: 0,
      editRole: 0,
      permission: 0,
      tooltip: "Effects fired by trigger rows that reference an entry here by label. Each row defines one effect.",
      visibilityFormula: "",
      type: "dynamicTable",
      contents: [],
      rowLayout: foundry.utils.deepClone(EFFECT_ROW_LAYOUT),
      head: true,
      deleteWarning: true,
      predefinedLines: [
        {
          $deleted: true,
          effect_label: "",
          $predefinedIdx: 0,
          $deletionDisabled: false
        }
      ],
      canPlayerAdd: true,
      hiddenColumns: [],
      sortOption: "manual",
      sortPredicates: []
    };
  }

  // ---------------------------------------------------------------------------
  // Schema patcher: rebuild reaction_config_table.rowLayout and add
  // reaction_effect_table sibling. Returns whether anything changed.
  // ---------------------------------------------------------------------------
  function patchSchemaAtParent(parentContents, configTableIdx) {
    const configTable = parentContents[configTableIdx];
    if (!configTable || !Array.isArray(configTable.rowLayout)) return false;

    let changed = false;

    // 1. Remove legacy grant_* columns from trigger rowLayout.
    const LEGACY_KEYS = new Set([
      "reaction_grant_resource",
      "reaction_grant_amount",
      "reaction_grant_target"
    ]);
    const before = configTable.rowLayout.length;
    configTable.rowLayout = configTable.rowLayout.filter(c => !LEGACY_KEYS.has(c?.key));
    if (configTable.rowLayout.length !== before) changed = true;

    // 2. Add reaction_effect_ref if missing. Anchor before reaction_isPassive.
    const hasEffectRef = configTable.rowLayout.some(c => c?.key === "reaction_effect_ref");
    if (!hasEffectRef) {
      const passiveIdx = configTable.rowLayout.findIndex(c => c?.key === "reaction_isPassive");
      const insertAt = passiveIdx >= 0 ? passiveIdx : configTable.rowLayout.length;
      configTable.rowLayout.splice(insertAt, 0, foundry.utils.deepClone(COL_EFFECT_REF));
      changed = true;
    }

    // 3. Add reaction_effect_table as a sibling if missing.
    const hasEffectTable = parentContents.some(c => c?.key === "reaction_effect_table");
    if (!hasEffectTable) {
      parentContents.splice(configTableIdx + 1, 0, makeEffectTableField());
      changed = true;
    }

    return changed;
  }

  function patchSchemaWalker(node) {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) {
      let any = false;
      for (let i = 0; i < node.length; i++) {
        if (node[i]?.key === "reaction_config_table" && Array.isArray(node[i]?.rowLayout)) {
          if (patchSchemaAtParent(node, i)) any = true;
        } else if (patchSchemaWalker(node[i])) any = true;
      }
      return any;
    }
    let any = false;
    for (const k of Object.keys(node)) {
      if (patchSchemaWalker(node[k])) any = true;
    }
    return any;
  }

  // ---------------------------------------------------------------------------
  // Data migration: move grant_* fields out of trigger rows and into
  // reaction_effect_table, linked by reaction_effect_ref.
  // ---------------------------------------------------------------------------
  function readTableObj(tbl) {
    if (!tbl) return { rows: [], shape: "missing" };
    if (Array.isArray(tbl)) return { rows: tbl, shape: "array" };
    if (typeof tbl === "object") return { rows: Object.values(tbl), shape: "object" };
    return { rows: [], shape: "unknown" };
  }

  function migrateItemData(sys) {
    const props = sys?.props ?? sys;
    if (!props || typeof props !== "object") return false;
    const triggerTbl = props.reaction_config_table;
    if (!triggerTbl) return false;

    const triggerInfo = readTableObj(triggerTbl);
    if (!triggerInfo.rows.length) return false;

    let changed = false;

    // Build a working copy of the effect table (object form, since CSB
    // typically stores as object).
    let effectTbl = props.reaction_effect_table;
    let effectShape = "object";
    if (Array.isArray(effectTbl)) effectShape = "array";
    if (effectTbl == null) {
      effectTbl = {};
      effectShape = "object";
    }

    function existingEffectLabels() {
      const out = new Set();
      const rows = readTableObj(effectTbl).rows;
      for (const r of rows) {
        const lbl = (r?.effect_label ?? "").toString().trim();
        if (lbl) out.add(lbl);
      }
      return out;
    }

    function nextEffectKey() {
      // Object keys: prefer numeric sequential, like CSB's row keys.
      if (effectShape === "array") return null;
      let i = 0;
      while (Object.prototype.hasOwnProperty.call(effectTbl, String(i))) i++;
      return String(i);
    }

    function addEffectRow(row) {
      if (effectShape === "array") {
        effectTbl.push(row);
      } else {
        effectTbl[nextEffectKey()] = row;
      }
    }

    function uniqueLabel(seedBase) {
      const used = existingEffectLabels();
      let n = 1;
      let candidate = `${seedBase}-${n}`;
      while (used.has(candidate)) {
        n++;
        candidate = `${seedBase}-${n}`;
      }
      return candidate;
    }

    // For each trigger row, migrate grant_* if present and effect_ref blank.
    for (const row of triggerInfo.rows) {
      if (!row || typeof row !== "object") continue;
      const existingRef = (row.reaction_effect_ref ?? "").toString().trim();
      const grantResource = (row.reaction_grant_resource ?? "").toString().trim();

      // Already-migrated row: ref present. Just clean stale legacy fields.
      if (existingRef) {
        if ("reaction_grant_resource" in row || "reaction_grant_amount" in row || "reaction_grant_target" in row) {
          delete row.reaction_grant_resource;
          delete row.reaction_grant_amount;
          delete row.reaction_grant_target;
          changed = true;
        }
        continue;
      }

      // No grant data either: nothing to migrate.
      if (!grantResource) {
        if ("reaction_grant_amount" in row || "reaction_grant_target" in row) {
          delete row.reaction_grant_amount;
          delete row.reaction_grant_target;
          changed = true;
        }
        continue;
      }

      // Migrate: create an effect row, set ref, clear legacy fields.
      const label = uniqueLabel("effect");
      const effectRow = {
        effect_label: label,
        effect_kind: "grant",
        grant_resource: grantResource,
        grant_amount: row.reaction_grant_amount ?? "",
        grant_target: (row.reaction_grant_target ?? "self").toString().trim() || "self"
      };
      addEffectRow(effectRow);

      row.reaction_effect_ref = label;
      delete row.reaction_grant_resource;
      delete row.reaction_grant_amount;
      delete row.reaction_grant_target;
      changed = true;
    }

    if (changed) {
      props.reaction_effect_table = effectTbl;
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Phase A: schema update on _Skill Template
  // ---------------------------------------------------------------------------
  const templates = game.items.filter(i => i.name === TEMPLATE_NAME && i.type === TEMPLATE_TYPE);
  if (templates.length === 0) {
    ui.notifications.error(`${TAG} No "${TEMPLATE_NAME}" (type ${TEMPLATE_TYPE}) found in world`);
    return;
  }
  if (templates.length > 1) {
    const ids = templates.map(c => c.id).join(", ");
    ui.notifications.error(`${TAG} Multiple "${TEMPLATE_NAME}" items found (${templates.length}: ${ids}); aborting.`);
    return;
  }
  const template = templates[0];

  const newTemplateSys = foundry.utils.deepClone(template.system);
  const schemaChanged = patchSchemaWalker(newTemplateSys);

  // Also migrate any data on the template item itself (defensive).
  const templateDataChanged = migrateItemData(newTemplateSys);

  if (schemaChanged || templateDataChanged) {
    await template.update({ system: newTemplateSys });
    console.log(`${TAG} _Skill Template updated`, { schemaChanged, templateDataChanged });
  } else {
    console.log(`${TAG} _Skill Template already restructured`);
  }

  // ---------------------------------------------------------------------------
  // Phase B: data migration on every world item that has trigger rows
  // ---------------------------------------------------------------------------
  let itemsScanned = 0;
  let itemsMigrated = 0;
  for (const item of game.items) {
    if (item === template) continue;
    const props = item.system?.props;
    if (!props || !props.reaction_config_table) continue;
    itemsScanned++;
    const sysCopy = foundry.utils.deepClone(item.system);
    if (migrateItemData(sysCopy)) {
      await item.update({ system: sysCopy });
      itemsMigrated++;
    }
  }

  ui.notifications.info(
    `${TAG} done. Template ${(schemaChanged || templateDataChanged) ? "updated" : "ok"}. ` +
    `Scanned ${itemsScanned} item(s); migrated ${itemsMigrated}. ` +
    `Now click CSB's reload-from-template on _Skill Template.`
  );
  console.log(`${TAG} done`, { schemaChanged, templateDataChanged, itemsScanned, itemsMigrated });
})();
