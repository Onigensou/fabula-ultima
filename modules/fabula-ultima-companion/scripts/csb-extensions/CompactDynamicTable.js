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
        fieldsEl.append(chipEl);
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
    `;
    document.head.appendChild(style);
  }

  console.debug(`${TAG} Installed component type "compactDynamicTable".`);
});
