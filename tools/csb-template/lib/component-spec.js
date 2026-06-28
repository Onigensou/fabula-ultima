"use strict";

// Knowledge of Custom System Builder (CSB 4.8.5) component types — the "schema"
// behind a template's component tree (system.body / system.header).
//
// Source of truth: systems/custom-system-builder/module/sheets/components/*.
// A CSB template is a DOM-like tree of component nodes. Each node has a `type`
// discriminator and (for most) a `key`. Containers nest children under
// `contents` (panel/tab/tabbedPanel/table) or `rowLayout` (dynamicTable/
// itemContainer — there the children are COLUMN definitions, not data rows).
//
// What we encode here, per type:
//   ownsProp     — an instance stores system.props.<key> for this component, so
//                  its key must be GLOBALLY UNIQUE (a dup silently clobbers).
//   requiresKey  — CSB needs a valid key (/^[a-zA-Z0-9_]+$/) on this node.
//   childField   — the array holding child component nodes (for edit helpers).
//   required     — config keys that must be present beyond the common set.

const KEY_PATTERN = /^[a-zA-Z0-9_]+$/;

const SPEC = {
  // ── input components (each owns one system.props.<key>) ──────────────────
  textField:   { ownsProp: true,  requiresKey: true },
  numberField: { ownsProp: true,  requiresKey: true },
  checkbox:    { ownsProp: true,  requiresKey: true, required: ["defaultChecked"] },
  select:      { ownsProp: true,  requiresKey: true, required: ["selectedOptionType"] },
  radioButton: { ownsProp: true,  requiresKey: true },
  textArea:    { ownsProp: true,  requiresKey: true },

  // ── display-only (no prop, key optional) ─────────────────────────────────
  label:       { ownsProp: false, requiresKey: false },
  picture:     { ownsProp: false, requiresKey: false },
  meter:       { ownsProp: false, requiresKey: false },

  // ── layout containers (no prop) ──────────────────────────────────────────
  panel:       { ownsProp: false, requiresKey: false, childField: "contents" },
  tabbedPanel: { ownsProp: false, requiresKey: false, childField: "contents" },
  tab:         { ownsProp: false, requiresKey: false, childField: "contents" },
  table:       { ownsProp: false, requiresKey: false, childField: "contents" }, // static 2D grid

  // ── keyed containers / data holders (own a prop key) ─────────────────────
  // NB: a table's ROW data is stored at system.props.<tableKey>.<rowIdx>.<colKey>,
  // so its rowLayout column keys are SCOPED to the table — they do NOT collide
  // with top-level field keys of the same name (the linter accounts for this).
  dynamicTable:           { ownsProp: true, requiresKey: true, childField: "rowLayout" },
  compactDynamicTable:    { ownsProp: true, requiresKey: true, childField: "rowLayout" }, // module/CSB extension
  itemContainer:          { ownsProp: true, requiresKey: true, childField: "rowLayout" },
  activeEffectContainer:  { ownsProp: true, requiresKey: true },
  conditionalModifierList:{ ownsProp: true, requiresKey: true },
};

// Types valid in a tree but NOT registered in componentFactory because a parent
// parses them itself (a `tab` is consumed by its `tabbedPanel`, never by the
// factory). These must be treated as known even though createOneComponent would
// reject them in isolation.
const PARENT_PARSED_TYPES = ["tab"];

// All table-like containers whose children are rowLayout COLUMN defs.
const ROWLAYOUT_TABLE_TYPES = ["dynamicTable", "compactDynamicTable", "itemContainer"];

const KNOWN_TYPES = Object.keys(SPEC);

function specOf(type) {
  return SPEC[type] || null;
}
function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(SPEC, type);
}
function isContainer(type) {
  const s = SPEC[type];
  return !!(s && s.childField);
}
function childFieldOf(type) {
  const s = SPEC[type];
  return s ? s.childField || null : null;
}
function ownsProp(type) {
  const s = SPEC[type];
  return !!(s && s.ownsProp);
}

function isRowLayoutTable(type) {
  return ROWLAYOUT_TABLE_TYPES.includes(type);
}

module.exports = {
  KEY_PATTERN,
  SPEC,
  KNOWN_TYPES,
  PARENT_PARSED_TYPES,
  ROWLAYOUT_TABLE_TYPES,
  specOf,
  isKnownType,
  isContainer,
  isRowLayoutTable,
  childFieldOf,
  ownsProp,
};
