/**
 * [ONI] CompactDynamicTable — CSB component
 * ---------------------------------------------------------------------------
 * A dynamicTable replacement that renders rows as horizontal flex chips
 * instead of an HTML <table>. Cells whose `visibilityFormula` evaluates
 * false take ZERO space (not just `display:none` in a fixed-width column).
 *
 * Use it in any CSB template by setting `"type": "compactDynamicTable"`.
 * Everything else — `rowLayout`, per-cell `visibilityFormula`, `colName`,
 * `predefinedLines`, `canPlayerAdd`, `sortOption`, `head` — works exactly
 * like the built-in dynamicTable.
 *
 * Inherits from CSB's DynamicTable so add/delete/sort/save/predefined-line
 * sync are reused as-is. We only override:
 *   - `getTechnicalName()`        → "compactDynamicTable"
 *   - `getPrettyName()`           → editor label
 *   - `fromJSON()`                → instantiate this class
 *   - `_getElement()`             → custom render in applied mode
 *
 * Builder mode (template editor) defers to DynamicTable's table-style UI
 * so authors edit the rowLayout schema with the existing controls.
 *
 * Storage shape unchanged: rows live at
 *   entity.system.props.<tableKey>.<rowKey> = { fieldA: v, ... }
 * with numeric rowKeys (matching CSB's _createRow convention).
 */
// Register on `customSystemBuilderInit` (NOT plain `init` or `ready`) so:
//   1. CSB has already added its built-in components (Panel, DynamicTable,
//      etc.) — needed because we extend dynamicTable. Listening on `init`
//      directly is unsafe because Foundry runs hook listeners in registration
//      order, and a module's init listener may fire BEFORE the active
//      system's, leaving `componentFactory.getComponentClass("dynamicTable")`
//      undefined.
//   2. Registration still completes BEFORE `TemplateSystem.prepareData()`
//      walks each template's body via Panel.fromJSON →
//      componentFactory.createOneComponent. If that walk hits a
//      `type: "compactDynamicTable"` node before our class is registered, the
//      factory throws "Unrecognized component type", the throw cascades up
//      the fromJSON chain, customBody ends up undefined, and a subsequent
//      saveTemplate can wipe `system.body` to an empty panel.
//
// `customSystemBuilderInit` is fired by CSB at the tail end of its own init
// hook (after all built-in addComponentType calls), still during world boot,
// well before document prepareData runs.
Hooks.once("customSystemBuilderInit", () => {
  const TAG = "[CompactDynamicTable]";

  if (typeof globalThis.componentFactory?.getComponentClass !== "function") {
    console.warn(`${TAG} CSB componentFactory unavailable on customSystemBuilderInit; skipping registration.`);
    return;
  }
  if (typeof globalThis.TemplateSystem?.isBuilderTemplateSystem !== "function") {
    console.warn(`${TAG} CSB TemplateSystem unavailable on customSystemBuilderInit; skipping registration.`);
    return;
  }

  let DynamicTableBase;
  try {
    DynamicTableBase = globalThis.componentFactory.getComponentClass("dynamicTable");
  } catch (e) {
    console.warn(`${TAG} dynamicTable class not found.`, e);
    return;
  }

  // ---------------------------------------------------------------------------
  // Row collapse — the reason this exists
  // ---------------------------------------------------------------------------
  // Measured over the authored corpus: an effect_table row renders 13.6 chips
  // and fills 4.9 of them; a reaction_config_table row renders 20.4 and fills
  // 4.8. So three quarters of what an author reads on a row is blank.
  //
  // Gating cannot fix it. A field that several kinds read (condition_formula,
  // menu_label, consume_self) has no per-row formula that admits it, so it must
  // render on EVERY row or be uneditable — and un-gating those, correctly, is
  // what pushed effect_table from 12.3 to 13.6.
  //
  // So: render everything as before, but fold the chips that carry nothing into
  // a `+N` toggle. Nothing is removed, nothing becomes uneditable, and the
  // collapse is pure CSS over already-rendered DOM — no re-render, no data
  // write, no persisted per-user state (a persisted collapse flag OVERRIDES the
  // template default and reads as "the setting didn't work").
  //
  // Always kept visible when collapsed:
  //   - the row's IDENTITY chips (see IDENTITY_KEYS)
  //   - every chip that has a value
  //   - a field the ENGINE REQUIRES for this row's kind but that is EMPTY —
  //     the one blank worth showing, because it means the row silently does
  //     nothing. Highlighted rather than merely shown.
  //
  // Identity is pinned BY KEY, not by position. "the first two rendered chips"
  // is right for effect_table (every row leads with effect_label, effect_kind,
  // both ungated) and wrong for reaction_config_table, whose layout order puts
  // reaction_source / reaction_debuff_count_target second on 479 of 538 rows
  // while reaction_effect_ref — the field naming what the reaction DOES — is
  // 11th and would fold away on the 41 rows where it is blank.
  const IDENTITY_KEYS = new Set([
    "effect_label", "effect_kind",              // effect_table
    "reaction_trigger", "reaction_effect_ref",  // reaction_config_table
  ]);
  // Fallback for any other compactDynamicTable: keep the first two rendered
  // chips, which is the old rule and better than keeping none.
  const FALLBACK_CORE_CHIPS = 2;

  const chipBlank = (v) =>
    v === undefined || v === null || v === "" || v === false ||
    (Array.isArray(v) && v.length === 0);

  // Populated asynchronously from the registry; an empty map only costs the
  // required-field highlight, never correctness of the collapse itself.
  // Kept as a PROMISE and awaited before the first render. A floating import
  // whose result is only read later fails silently and totally: any 404/rename
  // leaves the map empty forever, requiredKeysFor returns null for every kind,
  // and not one row is ever flagged — with a single console.warn as the tell.
  // Awaiting is free after the first resolve and removes the race outright.
  let REQUIRED_BY_KIND = {};
  const REQUIRED_READY = import(
    foundry.utils.getRoute("/modules/fabula-ultima-companion/scripts/battle-director/template-field-registry.js")
  )
    .then((m) => { REQUIRED_BY_KIND = m.REQUIRED_FIELDS_BY_KIND ?? {}; })
    .catch((e) => console.warn(`${TAG} required-field map unavailable; collapse will not highlight unset requirements.`, e));

  const requiredKeysFor = (row) => {
    const kind = String(row?.effect_kind ?? "").trim();
    const spec = REQUIRED_BY_KIND[kind];
    if (!spec) return null;
    // Handlers with an escape hatch return BEFORE the guard, so nothing is
    // required on those rows.
    const isTrueLoose = (v) => v === true || String(v ?? "").trim().toLowerCase() === "true";
    if ((spec.unlessTrue ?? []).some((k) => isTrueLoose(row?.[k]))) return new Set();
    if ((spec.unlessTrueStrict ?? []).some((k) => row?.[k] === true)) return new Set();
    if ((spec.unlessSet ?? []).some((k) => !chipBlank(row?.[k]))) return new Set();
    const out = new Set(spec.all ?? []);
    // An `either` group is satisfied by ANY member; only flag the whole group
    // when none of them is set, so a row using filter_tag is not nagged about
    // ae_template_ref.
    for (const group of spec.either ?? []) {
      if (!group.some((k) => !chipBlank(row?.[k]))) group.forEach((k) => out.add(k));
    }
    return out;
  };

  // ---------------------------------------------------------------------------
  // Class
  // ---------------------------------------------------------------------------
  class CompactDynamicTable extends DynamicTableBase {
    static getTechnicalName() { return "compactDynamicTable"; }
    static getPrettyName()    { return "Compact Dynamic Table (FU)"; }

    static fromJSON(json, templateAddress, parent) {
      const rowContents = [];
      const rowLayout = {};
      const instance = new CompactDynamicTable({
        ...json,
        contents: rowContents,
        rowLayout,
        parent,
        templateAddress
      });
      for (const [index, componentDesc] of (json.rowLayout ?? []).entries()) {
        const c = globalThis.componentFactory.createOneComponent(
          componentDesc,
          templateAddress + "-rowLayout-" + index,
          instance
        );
        rowContents.push(c);
        rowLayout[c.key] = {
          align: componentDesc.align,
          colName: componentDesc.colName,
          readonlyPredefined: componentDesc.readonlyPredefined
        };
      }
      return instance;
    }

    async _getElement(entity, isEditable = true, options = {}) {
      // In template-builder mode, fall back to the standard table editor
      // so authors still configure rowLayout / sort / predefined lines
      // with the existing CSB UI.
      if (TemplateSystem.isBuilderTemplateSystem(entity)) {
        return super._getElement(entity, isEditable, options);
      }
      return this._renderCompact(entity, isEditable, options);
    }

    async _renderCompact(entity, isEditable, options) {
      // Per-instance fold memory; see the note at the fold-state read below.
      this._foldState ??= new Map();
      // Guarantee the required-field map is in before the first row is built,
      // so the very first render can flag unset requirements.
      await REQUIRED_READY;

      // Mirror DynamicTable's predefined-line sync.
      if (typeof this._synchronizePredefinedLines === "function") {
        try { await this._synchronizePredefinedLines(entity); }
        catch (e) { console.warn(`${TAG} _synchronizePredefinedLines failed`, e); }
      }

      // Build the wrapper Component._getElement would have built
      // (we can't call the grand-parent through `super` directly).
      const wrapper = $('<div></div>');
      wrapper.addClass('custom-system-component-contents');
      wrapper.addClass(this.key ?? '');
      wrapper.addClass('oni-compact-wrapper');

      const tableEl = $('<div class="oni-compact-table"></div>');

      const dynamicProps = foundry.utils.getProperty(entity.system.props, this.key) ?? {};
      const rowOrder = this._sortRows(dynamicProps, entity);

      // Sample row used by the "+ Add row" button. Mirrors DynamicTable
      // logic: input components contribute their defaultValue. We duck-type
      // since InputComponent isn't accessible from outside CSB's ESM.
      const sampleNewRow = { $deleted: false };
      for (const component of this._contents) {
        if (component && component.defaultValue !== undefined) {
          sampleNewRow[component.key] = component.defaultValue;
        }
      }

      if (rowOrder.length === 0) {
        const empty = $('<div class="oni-compact-empty">No rows yet.</div>');
        tableEl.append(empty);
      } else {
        for (const line of rowOrder) {
          // Defensive: skip rows that don't actually exist in storage
          // (can happen if random-keyed rows were created before the
          // dynamicTable → compactDynamicTable migration).
          if (!dynamicProps[line]) continue;

          const rowEl = await this._renderCompactRow(
            entity,
            isEditable,
            options,
            line,
            dynamicProps,
            rowOrder
          );
          tableEl.append(rowEl);
        }
      }

      // Table-level toggle: reveal every foldable chip at once. Useful when
      // hunting a field across rows instead of editing one row.
      const anyFoldable = tableEl.find('.oni-compact-more').length > 0;
      if (anyFoldable) {
        const allBtn = $('<a class="oni-compact-expand-all custom-system-clickable"></a>');
        const syncAll = () => {
          const anyCollapsed = tableEl.find('.oni-compact-row--collapsed').length > 0;
          allBtn.text(anyCollapsed ? 'Show all fields' : 'Hide unset fields');
        };
        allBtn.on('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const rows = tableEl.find('.oni-compact-row');
          const anyCollapsed = tableEl.find('.oni-compact-row--collapsed').length > 0;
          rows.toggleClass('oni-compact-row--collapsed', !anyCollapsed);
          // Each row's own +N/− label is stale after a bulk toggle, and the
          // fold memory has to follow or the next re-render undoes this.
          rows.each((_i, r) => {
            const $r = $(r);
            const collapsed = $r.hasClass('oni-compact-row--collapsed');
            const key = $r.attr('data-row-key');
            if (key !== undefined) this._foldState.set(String(key), collapsed);
            const $m = $r.find('.oni-compact-more');
            if (!$m.length) return;
            $m.text(collapsed ? `+${$r.find('.oni-compact-chip--extra').length}` : '−');
          });
          syncAll();
        });
        // A per-ROW toggle changes whether any row is collapsed, so this
        // button's label goes stale unless it re-derives. Without this, opening
        // every row by hand leaves the button reading "Show all fields" while
        // clicking it would COLLAPSE them — the opposite of what it says.
        tableEl.on('oni:foldchanged', syncAll);
        syncAll();
        tableEl.append(allBtn);
      }

      if (isEditable && this.canPlayerAdd) {
        const addBtn = $('<button type="button" class="oni-compact-add"><i class="fas fa-plus-circle"></i> Add row</button>');
        addBtn.on('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          await this._createRow(entity, sampleNewRow);
        });
        tableEl.append(addBtn);
      }

      wrapper.append(tableEl);
      return wrapper;
    }

    async _renderCompactRow(entity, isEditable, options, line, dynamicProps, rowOrder) {
      const rowEl = $('<div class="oni-compact-row"></div>');
      rowEl.attr('data-row-key', String(line));

      const fieldsEl = $('<div class="oni-compact-fields"></div>');

      const rowValues = dynamicProps[line] ?? {};
      const requiredKeys = requiredKeysFor(rowValues);
      const chips = [];

      for (const component of this.contents) {
        const newCompJson = component.toJSON();
        newCompJson.key = `${this.key}.${line}.${component.key}`;

        let canEdit = isEditable;
        if (dynamicProps[line].$predefinedIdx !== undefined) {
          canEdit = canEdit && !this._rowLayout[component.key]?.readonlyPredefined;
        }

        const newComponent = globalThis.componentFactory.createOneComponent(newCompJson);
        const renderOptions = { ...options, reference: `${this.key}.${line}` };

        const visible = newComponent.canBeRendered(entity, renderOptions);
        if (!visible) continue;

        const inputEl = await newComponent.render(entity, canEdit, renderOptions);

        const chipEl = $('<div class="oni-compact-chip"></div>');
        chipEl.attr('data-field', component.key);
        const colName = this._rowLayout[component.key]?.colName ?? '';
        if (colName && this._head) {
          chipEl.append($('<label class="oni-compact-label"></label>').text(colName + ':'));
        }
        chipEl.append(inputEl);

        const filled = !chipBlank(rowValues[component.key]);
        chips.push({
          el: chipEl,
          key: component.key,
          filled,
          // requiredKeys === null means "no contract known for this kind", which
          // must not read as "nothing is required" — leave the highlight off
          // rather than assert a requirement the engine may not have.
          neededEmpty: !filled && requiredKeys !== null && requiredKeys.has(component.key),
        });
      }

      // Classify AFTER the loop: "core" is the first two chips that actually
      // rendered, which is stable regardless of how the layout is ordered or
      // which columns a given row's gates admit.
      const hasNamedIdentity = chips.some((c) => IDENTITY_KEYS.has(c.key));
      const isIdentity = (c, idx) =>
        hasNamedIdentity ? IDENTITY_KEYS.has(c.key) : idx < FALLBACK_CORE_CHIPS;

      let extras = 0;
      let filledBeyondIdentity = false;
      chips.forEach((c, idx) => {
        const identity = isIdentity(c, idx);
        if (!identity && c.filled) filledBeyondIdentity = true;
        if (c.neededEmpty) c.el.addClass('oni-compact-chip--needed');
        if (identity || c.filled || c.neededEmpty) { /* always visible */ }
        else { c.el.addClass('oni-compact-chip--extra'); extras++; }
        fieldsEl.append(c.el);
      });

      if (extras > 0) {
        const moreEl = $('<a class="oni-compact-more custom-system-clickable"></a>');
        const sync = () => {
          const collapsed = rowEl.hasClass('oni-compact-row--collapsed');
          moreEl.text(collapsed ? `+${extras}` : '−');
          moreEl.attr('title', collapsed
            ? `Show ${extras} more field(s) available on this row`
            : 'Hide the fields that are not set');
        };
        moreEl.on('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const collapsed = !rowEl.hasClass('oni-compact-row--collapsed');
          rowEl.toggleClass('oni-compact-row--collapsed', collapsed);
          this._foldState.set(String(line), collapsed);
          sync();
          // The handler stops propagation (a bare click here must not reach
          // CSB's row handlers), so a delegated listener on the table never
          // sees it. Notify the table explicitly instead, or its "Show all
          // fields" label goes stale and ends up doing the opposite.
          rowEl.closest('.oni-compact-table').trigger('oni:foldchanged');
        });

        // CSB sheets run submitOnChange, so editing ANY chip re-renders the
        // whole sheet and rebuilds this DOM. Without a memory the row re-folds
        // after every keystroke-commit, and filling three fields costs three
        // +N clicks. This Map lives on the component instance, not on the
        // document and not on a user flag — it survives re-render and dies with
        // the sheet, which is the distinction the header comment is drawing.
        const remembered = this._foldState.get(String(line));
        // A row with nothing filled past its identity chips is NEW — start it
        // open, otherwise there is no field to type into.
        const collapsed = remembered ?? filledBeyondIdentity;
        rowEl.toggleClass('oni-compact-row--collapsed', collapsed);
        sync();
        fieldsEl.append(moreEl);
      }

      rowEl.append(fieldsEl);

      // Row controls: sort up/down + delete (lifted from DynamicTable).
      const controlsEl = $('<div class="oni-compact-controls"></div>');

      // CSB stores TABLE_SORT_OPTION.MANUAL as the string "manual".
      if (isEditable && this._sortOption === "manual") {
        if (line !== rowOrder[0]) {
          const upBtn = $('<a class="oni-compact-sort custom-system-clickable" title="Move up"><i class="fas fa-chevron-up"></i></a>');
          upBtn.on('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._swapElements(entity, line - 1, line);
          });
          controlsEl.append(upBtn);
        }
        if (line !== rowOrder[rowOrder.length - 1]) {
          const downBtn = $('<a class="oni-compact-sort custom-system-clickable" title="Move down"><i class="fas fa-chevron-down"></i></a>');
          downBtn.on('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._swapElements(entity, line + 1, line);
          });
          controlsEl.append(downBtn);
        }
      }

      if (isEditable) {
        const delBtn = $('<a class="oni-compact-del custom-system-clickable" title="Delete row"><i class="fas fa-trash"></i></a>');
        if (this._deleteWarning) {
          delBtn.on('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const ok = await foundry.applications.api.DialogV2.confirm({
              window: { title: "Delete row?", icon: "fas fa-trash" },
              content: "<p>Delete this row?</p>",
              defaultYes: false,
              modal: true,
              rejectClose: true
            }).catch(() => false);
            if (ok) this._deleteRow(entity, line);
          });
        } else {
          delBtn.on('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._deleteRow(entity, line);
          });
        }
        controlsEl.append(delBtn);
      }

      rowEl.append(controlsEl);
      return rowEl;
    }
  }

  // ---------------------------------------------------------------------------
  // Register with CSB
  // ---------------------------------------------------------------------------
  globalThis.componentFactory.addComponentType(CompactDynamicTable);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const STYLE_ID = "oni-compact-table-style";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-compact-wrapper { width: 100%; }
      .oni-compact-table {
        display: flex;
        flex-direction: column;
        gap: .4rem;
        margin: .25rem 0 .5rem 0;
      }
      .oni-compact-row {
        display: flex;
        align-items: flex-start;
        gap: .5rem;
        padding: .35rem .5rem;
        border: 1px solid #c8b78a;
        border-radius: 6px;
        background: rgba(0,0,0,.04);
      }
      .oni-compact-fields {
        display: flex;
        flex-wrap: wrap;
        gap: .35rem .5rem;
        flex: 1 1 auto;
        align-items: center;
      }
      .oni-compact-chip {
        display: inline-flex;
        align-items: center;
        gap: .3rem;
        padding: .15rem .35rem;
        background: rgba(255,255,255,.6);
        border: 1px solid #d6c896;
        border-radius: 4px;
        font-size: .85rem;
      }
      .oni-compact-chip .oni-compact-label {
        font-weight: 600;
        opacity: .8;
        white-space: nowrap;
      }
      /* Tighten CSB inputs inside chips. */
      .oni-compact-chip .custom-system-component-contents {
        margin: 0;
        padding: 0;
        display: inline-flex;
        align-items: center;
      }
      .oni-compact-chip select,
      .oni-compact-chip input[type="text"],
      .oni-compact-chip input[type="number"] {
        height: 1.6rem;
        line-height: 1.4rem;
        padding: 0 .25rem;
        font-size: .85rem;
        max-width: 16rem;
      }
      .oni-compact-chip input[type="number"] { width: 4.8rem; }
      .oni-compact-chip textarea {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: .75rem;
        min-width: 22rem;
        max-width: 36rem;
      }
      .oni-compact-controls {
        display: inline-flex;
        align-items: center;
        gap: .35rem;
        padding-top: .15rem;
      }
      .oni-compact-sort,
      .oni-compact-del {
        cursor: pointer;
        opacity: .7;
      }
      .oni-compact-sort:hover,
      .oni-compact-del:hover { opacity: 1; }
      .oni-compact-add {
        align-self: flex-start;
        padding: .25rem .6rem;
        font-size: .85rem;
        cursor: pointer;
      }
      .oni-compact-empty {
        font-style: italic;
        opacity: .7;
        font-size: .85rem;
        padding: .25rem .5rem;
      }

      /* --- row collapse ------------------------------------------------- */
      /* The fold is CSS-only over already-rendered DOM: toggling costs no
         re-render and cannot touch data. */
      .oni-compact-row--collapsed .oni-compact-chip--extra { display: none; }

      .oni-compact-more {
        cursor: pointer;
        font-size: .8rem;
        line-height: 1;
        padding: .15rem .4rem;
        border: 1px dashed #a99a72;
        border-radius: 999px;
        opacity: .75;
        white-space: nowrap;
        align-self: center;
      }
      .oni-compact-more:hover { opacity: 1; background: rgba(0,0,0,.06); }

      /* A field the engine REQUIRES for this row's kind that is still empty:
         the row will silently do nothing, so it must not read as ordinary. */
      .oni-compact-chip--needed {
        outline: 1px solid #b4553d;
        outline-offset: 1px;
        border-radius: 4px;
        background: rgba(180, 85, 61, .08);
      }

      .oni-compact-expand-all {
        align-self: flex-start;
        cursor: pointer;
        font-size: .8rem;
        opacity: .7;
        margin-top: .1rem;
      }
      .oni-compact-expand-all:hover { opacity: 1; text-decoration: underline; }
    `;
    document.head.appendChild(style);
  }

  console.debug(`${TAG} Installed component type "compactDynamicTable".`);
});
