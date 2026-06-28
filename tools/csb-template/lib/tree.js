"use strict";

// CsbTree — a DOM-like editor over a CSB template's component tree.
//
// A CSB template document keeps its sheet definition in `system.body` and
// `system.header`, each a root `panel` node whose `contents[]` nest the rest.
// Editing a template is therefore exactly like editing a DOM: query nodes,
// insert/remove/replace, set "attributes" (config), then serialize back.
//
// This class wraps the WHOLE document object and mutates it in place. When you
// are done, `patch()` returns a Foundry-shaped update that writes the WHOLE
// changed top-level field(s) (never dotted array paths — deepMerge can't splice
// arrays) and bumps templateSystemUniqueVersion. That patch goes to safeEdit
// (game closed) or doc.update via the bridge (game open).
//
// NOTE on compile semantics: writing the tree persists it, but a template
// master caches its parsed component tree for the session (TemplateSystem
// prepareData only rebuilds `customBody` when it is undefined, and a raw update
// does not clear it). So a NEW top-level field / table only renders after a full
// page reload (F5). See the csb-template README + the project memories.

const {
  SPEC,
  KEY_PATTERN,
  childFieldOf,
  ownsProp,
  isKnownType,
} = require("./component-spec");

class CsbTree {
  constructor(doc) {
    if (!doc || typeof doc !== "object") throw new Error("CsbTree: doc object required");
    if (!doc.system) throw new Error("CsbTree: doc.system missing (not a CSB document?)");
    this.doc = doc;
  }

  get system() { return this.doc.system; }
  get body() { return this.doc.system.body; }
  get header() { return this.doc.system.header; }

  // The present roots, each tagged with the top-level field that holds it.
  roots() {
    const out = [];
    if (this.header && typeof this.header === "object") out.push({ field: "header", node: this.header });
    if (this.body && typeof this.body === "object") out.push({ field: "body", node: this.body });
    return out;
  }

  // ── traversal ─────────────────────────────────────────────────────────────
  // Visit every component node. cb({ node, parent, parentField, index, path, field }).
  // `path` is an array of keys/indices from the doc root (for human-readable
  // locations). `field` is "body" | "header". Recurses through `contents`
  // (incl. static-table 2D grids) and `rowLayout` (dynamic-table columns).
  walk(cb) {
    for (const { field, node } of this.roots()) {
      this._walk(node, null, null, null, ["system", field], field, false, cb);
    }
  }

  // `inRowLayout` is true once we have descended through a table's rowLayout —
  // such nodes are COLUMN defs whose keys are row-scoped (system.props.<table>.
  // <row>.<col>), not global field keys. Lint uses this to avoid false key
  // collisions between a top-level field and a same-named table column.
  _walk(node, parent, parentField, index, path, field, inRowLayout, cb) {
    if (!node || typeof node !== "object") return;
    cb({ node, parent, parentField, index, path, field, inRowLayout });

    if (Array.isArray(node.contents)) {
      node.contents.forEach((child, i) => {
        if (Array.isArray(child)) {
          // static table row -> array of cells
          child.forEach((cell, j) =>
            this._walk(cell, node, "contents", [i, j], [...path, "contents", i, j], field, inRowLayout, cb));
        } else {
          this._walk(child, node, "contents", i, [...path, "contents", i], field, inRowLayout, cb);
        }
      });
    }
    if (Array.isArray(node.rowLayout)) {
      node.rowLayout.forEach((col, i) =>
        this._walk(col, node, "rowLayout", i, [...path, "rowLayout", i], field, true, cb));
    }
  }

  // ── queries (querySelector-ish) ────────────────────────────────────────────
  findByKey(key) {
    let hit = null;
    this.walk((ctx) => { if (!hit && ctx.node.key === key) hit = ctx; });
    return hit;
  }
  findAllByKey(key) {
    const out = [];
    this.walk((ctx) => { if (ctx.node.key === key) out.push(ctx); });
    return out;
  }
  findByType(type) {
    const out = [];
    this.walk((ctx) => { if (ctx.node.type === type) out.push(ctx); });
    return out;
  }
  // The first dynamicTable / itemContainer with this key.
  findTable(tableKey) {
    let hit = null;
    this.walk((ctx) => {
      if (hit) return;
      if (ctx.node.key === tableKey && Array.isArray(ctx.node.rowLayout)) hit = ctx;
    });
    return hit;
  }

  // Set of every prop-owning key in the tree (what reloadTemplate will keep;
  // anything authored into system.props but absent here is "data-only" and gets
  // stripped on reload).
  propOwningKeys() {
    const keys = new Set();
    this.walk(({ node, inRowLayout }) => {
      // rowLayout column keys are row-scoped, not standalone system.props fields
      if (node.key && !inRowLayout && ownsProp(node.type)) keys.add(node.key);
    });
    return keys;
  }

  // ── mutation (DOM-like) ─────────────────────────────────────────────────────
  // Insert a child node into the container identified by parentKey.
  // opts: { index } absolute position, or { before:<key> } / { after:<key> }.
  insertChild(parentKey, childNode, opts = {}) {
    const parent = this.findByKey(parentKey);
    if (!parent) throw new Error(`insertChild: parent "${parentKey}" not found`);
    const cf = childFieldOf(parent.node.type) || "contents";
    if (!Array.isArray(parent.node[cf])) parent.node[cf] = [];
    const arr = parent.node[cf];
    let at = arr.length;
    if (typeof opts.index === "number") at = opts.index;
    else if (opts.before) { const i = arr.findIndex((c) => c && c.key === opts.before); if (i >= 0) at = i; }
    else if (opts.after) { const i = arr.findIndex((c) => c && c.key === opts.after); if (i >= 0) at = i + 1; }
    arr.splice(at, 0, childNode);
    return this;
  }

  // Remove the first node with this key (and its subtree). Returns true if removed.
  remove(key) {
    const hit = this.findByKey(key);
    if (!hit || !hit.parent) return false;
    const arr = hit.parent[hit.parentField];
    if (!Array.isArray(arr)) return false;
    // index may be [i,j] for static tables; only support flat arrays for remove.
    if (Array.isArray(hit.index)) throw new Error(`remove: "${key}" lives in a static table cell — edit it manually`);
    arr.splice(hit.index, 1);
    return true;
  }

  // Replace the first node with this key.
  replace(key, newNode) {
    const hit = this.findByKey(key);
    if (!hit || !hit.parent) throw new Error(`replace: "${key}" not found / has no parent`);
    if (Array.isArray(hit.index)) throw new Error(`replace: "${key}" is a static-table cell`);
    hit.parent[hit.parentField][hit.index] = newNode;
    return this;
  }

  // Shallow-merge config onto an existing node ("set attributes").
  setConfig(key, patch) {
    const hit = this.findByKey(key);
    if (!hit) throw new Error(`setConfig: "${key}" not found`);
    Object.assign(hit.node, patch);
    return this;
  }

  // ── dynamic-table helpers ───────────────────────────────────────────────────
  addColumn(tableKey, columnNode, opts = {}) {
    const t = this.findTable(tableKey);
    if (!t) throw new Error(`addColumn: table "${tableKey}" not found`);
    const arr = t.node.rowLayout;
    if (arr.some((c) => c && c.key === columnNode.key))
      throw new Error(`addColumn: column "${columnNode.key}" already present in "${tableKey}"`);
    let at = arr.length;
    if (typeof opts.index === "number") at = opts.index;
    else if (opts.before) { const i = arr.findIndex((c) => c && c.key === opts.before); if (i >= 0) at = i; }
    else if (opts.after) { const i = arr.findIndex((c) => c && c.key === opts.after); if (i >= 0) at = i + 1; }
    arr.splice(at, 0, columnNode);
    return this;
  }
  removeColumn(tableKey, columnKey) {
    const t = this.findTable(tableKey);
    if (!t) throw new Error(`removeColumn: table "${tableKey}" not found`);
    const i = t.node.rowLayout.findIndex((c) => c && c.key === columnKey);
    if (i < 0) return false;
    t.node.rowLayout.splice(i, 1);
    return true;
  }

  // Add an option to a custom select (by select key, or a select column inside a table).
  addOption(selectKey, option) {
    const hit = this.findByKey(selectKey);
    if (!hit) throw new Error(`addOption: select "${selectKey}" not found`);
    if (hit.node.type !== "select") throw new Error(`addOption: "${selectKey}" is ${hit.node.type}, not select`);
    if (!Array.isArray(hit.node.options)) hit.node.options = [];
    if (hit.node.options.some((o) => o && o.key === option.key)) return this; // idempotent
    hit.node.options.push(option);
    return this;
  }

  // ── serialization / write ───────────────────────────────────────────────────
  // A new random u32, exactly how CSB stamps templateSystemUniqueVersion.
  static newVersion() {
    return (Math.random() * 0x100000000) >>> 0;
  }

  // Produce a Foundry update patch. Always rewrites the whole body/header fields
  // (the only safe way to persist array edits) and, by default, bumps the
  // version so copies re-derive after reload.
  patch({ bumpVersion = true } = {}) {
    const p = {};
    if (this.body) p["system.body"] = this.body;
    if (this.header) p["system.header"] = this.header;
    if (bumpVersion) p["system.templateSystemUniqueVersion"] = CsbTree.newVersion();
    return p;
  }
}

// ── node builders ─────────────────────────────────────────────────────────────
// Emit correctly-shaped component nodes (matching real CSB templates) so a hand-
// built field/table won't be rejected. All accept an `extra` object merged last.

const COMMON = (key, type, o = {}) => ({
  key,
  colSpan: o.colSpan ?? 1,
  rowSpan: o.rowSpan ?? 1,
  cssClass: o.cssClass ?? "",
  role: o.role ?? 0,
  editRole: o.editRole ?? 0,
  permission: o.permission ?? 0,
  tooltip: o.tooltip ?? "",
  visibilityFormula: o.visibilityFormula ?? "",
  type,
});

const INPUT = (key, type, o = {}) => ({
  ...COMMON(key, type, o),
  size: o.size ?? "full-size",
  label: o.label ?? "",
});

const build = {
  textField(key, o = {}) {
    return {
      ...INPUT(key, "textField", o),
      defaultValue: o.defaultValue ?? "",
      charList: o.charList ?? "",
      maxLength: o.maxLength ?? null,
      autocomplete: o.autocomplete ?? "",
      ...(o.extra || {}),
    };
  },
  numberField(key, o = {}) {
    return {
      ...INPUT(key, "numberField", o),
      defaultValue: o.defaultValue ?? "",
      allowDecimal: o.allowDecimal ?? false,
      minVal: o.minVal ?? null,
      maxVal: o.maxVal ?? null,
      allowRelative: o.allowRelative ?? false,
      ...(o.extra || {}),
    };
  },
  checkbox(key, o = {}) {
    return {
      ...INPUT(key, "checkbox", o),
      defaultChecked: o.defaultChecked ?? false,
      ...(o.extra || {}),
    };
  },
  textArea(key, o = {}) {
    return {
      ...INPUT(key, "textArea", o),
      defaultValue: o.defaultValue ?? "",
      maxLength: o.maxLength ?? null,
      style: o.style ?? "anywhere",
      ...(o.extra || {}),
    };
  },
  select(key, o = {}) {
    return {
      ...INPUT(key, "select", o),
      defaultValue: o.defaultValue ?? "",
      selectedOptionType: o.selectedOptionType ?? "custom",
      options: o.options ?? [],
      ...(o.extra || {}),
    };
  },
  panel(key, o = {}) {
    return {
      ...COMMON(key, "panel", o),
      contents: o.contents ?? [],
      flow: o.flow ?? "vertical",
      align: o.align ?? "left",
      collapsible: o.collapsible ?? false,
      defaultCollapsed: o.defaultCollapsed ?? false,
      ...(o.extra || {}),
    };
  },
  // A dynamic-table COLUMN node (a component plus align/colName/readonlyPredefined).
  column(key, type, o = {}) {
    const baseBuilder = build[type];
    const base = baseBuilder ? baseBuilder(key, o) : INPUT(key, type, o);
    return {
      ...base,
      align: o.align ?? "left",
      colName: o.colName ?? "",
      readonlyPredefined: o.readonlyPredefined ?? false,
    };
  },
  dynamicTable(key, o = {}) {
    return {
      ...COMMON(key, "dynamicTable", o),
      contents: [],
      rowLayout: o.rowLayout ?? [],
      head: o.head ?? true,
      deleteWarning: o.deleteWarning ?? true,
      predefinedLines: o.predefinedLines ?? [],
      canPlayerAdd: o.canPlayerAdd ?? true,
      hiddenColumns: o.hiddenColumns ?? [],
      sortOption: o.sortOption ?? "disabled",
      sortPredicates: o.sortPredicates ?? [],
      ...(o.extra || {}),
    };
  },
};

module.exports = { CsbTree, build };
