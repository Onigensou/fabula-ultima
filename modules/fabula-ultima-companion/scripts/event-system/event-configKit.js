/**
 * [ONI] Event System — Config Kit
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-configKit.js
 *
 * What this does:
 * - The building blocks of the Event Config window, shared by every action:
 *     a list of event rows (add, remove, reorder, change type)
 *     lists inside rows (the branches of a choice or a condition)
 *     small field helpers (labelled field, wait checkbox, file picker,
 *     switch / variable name, condition editor)
 * - An action builds its own fields with these in its registry entry, so the
 *   window itself knows nothing about any one action.
 *
 * Exposes API to:
 *   window.oni.EventSystem.ConfigKit
 *
 * Requires:
 * - event-constants.js, event-logic.js
 * - event-eventRegistry.js (looked up when a list is built, not at load)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ConfigKit]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.ConfigKit?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const Logic = window.oni.EventSystem.Logic;
  if (!C || !Logic) {
    console.error(INSTALL_TAG, "Missing Constants or Logic. Check load order.");
    return;
  }

  const STYLE_ID = "oni-event-config-kit-style";
  const SWITCH_LIST_ID = "oni-event-switch-names";
  const VARIABLE_LIST_ID = "oni-event-variable-names";

  // Dropdown groups, in this order; anything else follows alphabetically.
  const CATEGORY_ORDER = ["Dialogue", "Flow", "Camera", "Audio", "Screen", "State"];

  const registry = () => window.oni.EventSystem.EventRegistry;

  // ------------------------------------------------------------
  // CSS
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-event-list-rows {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 10px;
      }

      .oni-event-list-rows:empty::before {
        content: "No events here yet.";
        display: block;
        border: 1px dashed var(--color-border-light-primary, #9993);
        border-radius: 8px;
        padding: 10px 12px;
        opacity: .8;
        font-size: 12px;
        background: rgba(0,0,0,0.02);
      }

      .oni-event-list-actions {
        margin-top: 8px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .oni-event-list-actions button {
        width: auto;
        flex: 0 0 auto;
      }

      .oni-event-row {
        border: 1px solid var(--color-border-light-primary, #9993);
        border-radius: 10px;
        padding: 10px;
        background: rgba(0,0,0,0.02);
      }

      .oni-event-row-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .oni-event-row-head button {
        width: auto;
        flex: 0 0 auto;
        line-height: 24px;
      }

      .oni-event-row-index {
        min-width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        font-weight: 800;
        background: rgba(0,0,0,0.08);
      }

      .oni-event-row-type {
        min-width: 220px;
      }

      .oni-event-row-spacer {
        flex: 1 1 auto;
      }

      .oni-event-row-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .oni-event-inline-grid {
        display: grid;
        grid-template-columns: 160px 1fr;
        gap: 10px;
        align-items: start;
      }

      .oni-event-inline-grid > label {
        font-weight: 700;
        padding-top: 6px;
      }

      .oni-event-inline-grid input[type="text"],
      .oni-event-inline-grid input[type="number"],
      .oni-event-inline-grid select,
      .oni-event-inline-grid textarea {
        width: 100%;
      }

      .oni-event-inline-row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      .oni-event-inline-row > * {
        flex: 0 1 auto;
        width: auto !important;
      }

      .oni-event-inline-row > .oni-grow {
        flex: 1 1 160px;
      }

      .oni-event-inline-row input[type="number"] {
        max-width: 110px;
      }

      .oni-event-inline-row button {
        line-height: 24px;
      }

      .oni-event-textarea {
        min-height: 120px;
        resize: vertical;
      }

      .oni-event-row-notes {
        font-size: 12px;
        opacity: .82;
        line-height: 1.4;
      }

      .oni-event-mini-note {
        margin-top: 6px;
        font-size: 12px;
        opacity: .8;
      }

      /* A list that belongs to a row: one branch of a choice or a condition */
      .oni-event-sublist {
        margin-top: 4px;
        padding: 6px 0 6px 12px;
        border-left: 3px solid rgba(122, 78, 32, 0.45);
      }

      .oni-event-sublist-label {
        font-weight: 700;
        font-size: 13px;
      }

      .oni-event-option {
        border: 1px dashed var(--color-border-light-primary, #9993);
        border-radius: 8px;
        padding: 8px;
      }

      /* Fields shown for one choice of a dropdown only; "hidden" must win
         over the flex / grid display these wrappers carry. */
      .oni-cond [data-kind][hidden],
      .oni-event-row [hidden] {
        display: none !important;
      }
    `;

    document.head.appendChild(style);
  }

  // ------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------
  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Rows sit inside rows, so a plain querySelector on a row would also find
  // the fields of the rows nested in it. These only return a row's own.
  function ownAll(rowEl, selector) {
    return Array.from(rowEl?.querySelectorAll?.(selector) ?? [])
      .filter(el => el.closest(".oni-event-row") === rowEl);
  }

  function own(rowEl, selector) {
    return ownAll(rowEl, selector)[0] ?? null;
  }

  function notify(el) {
    el?.dispatchEvent?.(new Event("change", { bubbles: true }));
  }

  function selected(value, current) {
    return String(value) === String(current) ? "selected" : "";
  }

  function options(pairs, current) {
    return pairs
      .map(([value, label]) => `<option value="${escapeHTML(value)}" ${selected(value, current)}>${escapeHTML(label)}</option>`)
      .join("");
  }

  // ------------------------------------------------------------
  // Fields
  // ------------------------------------------------------------
  function field(label, controlHTML, note = "") {
    return `
      <div class="oni-event-inline-grid">
        <label>${escapeHTML(label)}</label>
        <div>
          ${controlHTML}
          ${note ? `<div class="oni-event-mini-note">${note}</div>` : ""}
        </div>
      </div>
    `;
  }

  // A row body made of field HTML strings and/or elements (sub-lists).
  function fields(...parts) {
    const wrapper = document.createElement("div");
    wrapper.className = "oni-event-row-body";

    for (const part of parts.flat()) {
      if (!part) continue;
      if (part instanceof HTMLElement) {
        wrapper.appendChild(part);
      } else {
        const holder = document.createElement("div");
        holder.innerHTML = String(part);
        wrapper.append(...holder.children);
      }
    }

    return wrapper;
  }

  function waitField(row, defaultOn = true, note = "On: the next event waits until this one has finished. Off: it starts straight away.") {
    const on = row?.wait === undefined ? defaultOn : row.wait !== false;
    return field(
      "Wait for completion",
      `<input type="checkbox" class="oni-event-row-wait" ${on ? "checked" : ""} />`,
      note
    );
  }

  function readWait(rowEl, defaultOn = true) {
    const el = own(rowEl, ".oni-event-row-wait");
    return el ? !!el.checked : defaultOn;
  }

  function numberInput(cls, value, { min = "", max = "", step = "any", placeholder = "" } = {}) {
    return `<input type="number" class="${cls}" value="${escapeHTML(value ?? "")}"
      min="${min}" max="${max}" step="${step}" placeholder="${escapeHTML(placeholder)}" />`;
  }

  function readNumber(rowEl, selector, fallback = 0) {
    const raw = own(rowEl, selector)?.value;
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    return Logic.toNumber(raw, fallback);
  }

  function readText(rowEl, selector, fallback = "") {
    const el = own(rowEl, selector);
    return el ? String(el.value ?? "") : fallback;
  }

  // A path with a Browse button. pickerType: "audio" | "imagevideo".
  function fileInput(cls, value, pickerType, placeholder = "") {
    const preview = pickerType === "audio"
      ? `<button type="button" class="oni-event-file-preview" data-target="${cls}" title="Play it here">
           <i class="fas fa-play"></i>
         </button>`
      : "";

    return `
      <div class="oni-event-inline-row">
        <input type="text" class="${cls} oni-grow" value="${escapeHTML(value ?? "")}"
          placeholder="${escapeHTML(placeholder)}" />
        <button type="button" class="oni-event-file-browse" data-target="${cls}"
          data-picker-type="${escapeHTML(pickerType)}" title="Browse files">
          <i class="fas fa-file-import"></i>
        </button>
        ${preview}
      </div>
    `;
  }

  // ------------------------------------------------------------
  // Switch / variable names
  // ------------------------------------------------------------
  // One datalist of the names already on the party database sheet, so a name
  // is picked rather than retyped.
  function refreshNameLists() {
    const state = window.oni.EventSystem.GameState;

    const fill = (id, names) => {
      let list = document.getElementById(id);
      if (!list) {
        list = document.createElement("datalist");
        list.id = id;
        document.body.appendChild(list);
      }
      list.innerHTML = (names ?? []).map(n => `<option value="${escapeHTML(n)}"></option>`).join("");
    };

    fill(SWITCH_LIST_ID, state?.switchNames?.() ?? []);
    fill(VARIABLE_LIST_ID, state?.variableNames?.() ?? []);
  }

  function nameInput(cls, value, kind) {
    const listId = kind === "variable" ? VARIABLE_LIST_ID : SWITCH_LIST_ID;
    return `<input type="text" class="${cls} oni-grow" list="${listId}"
      value="${escapeHTML(value ?? "")}" placeholder="${kind === "variable" ? "Variable name" : "Switch name"}" />`;
  }

  // ------------------------------------------------------------
  // Condition editor
  // ------------------------------------------------------------
  function conditionEditor(rawCond, { allowAlways = true } = {}) {
    const K = Logic.CONDITION_KINDS;
    const cond = Logic.normalizeCondition(rawCond);
    if (!allowAlways && cond.kind === K.NONE) cond.kind = K.SWITCH;

    const kinds = [
      ...(allowAlways ? [[K.NONE, "Always"]] : []),
      [K.SWITCH, "Switch"],
      [K.VARIABLE, "Variable"],
      [K.SELF, "This event's switch"],
      [K.HAS_RUN, "This event has run"]
    ];

    const el = document.createElement("div");
    el.className = "oni-cond oni-event-inline-row";
    el.innerHTML = `
      <select class="oni-cond-kind">${options(kinds, cond.kind)}</select>

      <span data-kind="${K.SWITCH}" class="oni-event-inline-row oni-grow">
        ${nameInput("oni-cond-switch-name", cond.kind === K.SWITCH ? cond.name : "", "switch")}
        <span>is</span>
        <select class="oni-cond-switch-want">${options([["on", "On"], ["off", "Off"]], cond.want ?? "on")}</select>
      </span>

      <span data-kind="${K.VARIABLE}" class="oni-event-inline-row oni-grow">
        ${nameInput("oni-cond-variable-name", cond.kind === K.VARIABLE ? cond.name : "", "variable")}
        <select class="oni-cond-variable-op">${options(Logic.COMPARE_OPS.map(op => [op, op]), cond.op ?? "=")}</select>
        ${numberInput("oni-cond-variable-value", cond.kind === K.VARIABLE ? cond.value : 0)}
      </span>

      <span data-kind="${K.SELF}" class="oni-event-inline-row">
        <select class="oni-cond-self-slot">${options(Logic.SELF_SLOTS.map(s => [s, s]), cond.slot ?? "A")}</select>
        <span>is</span>
        <select class="oni-cond-self-want">${options([["on", "On"], ["off", "Off"]], cond.want ?? "on")}</select>
      </span>

      <span data-kind="${K.HAS_RUN}" class="oni-event-inline-row">
        <select class="oni-cond-run-want">${options([["yes", "at least once"], ["no", "never"]], cond.want ?? "yes")}</select>
      </span>
    `;

    const kindEl = el.querySelector(".oni-cond-kind");
    const sync = () => {
      for (const part of el.querySelectorAll(":scope > [data-kind]")) {
        part.hidden = part.dataset.kind !== kindEl.value;
      }
    };
    kindEl.addEventListener("change", sync);
    sync();

    return el;
  }

  function readCondition(condEl) {
    if (!condEl) return { kind: Logic.CONDITION_KINDS.NONE };
    const get = (sel) => condEl.querySelector(sel)?.value;
    const K = Logic.CONDITION_KINDS;
    const kind = get(".oni-cond-kind");

    switch (kind) {
      case K.SWITCH:
        return Logic.normalizeCondition({ kind, name: get(".oni-cond-switch-name"), want: get(".oni-cond-switch-want") });
      case K.VARIABLE:
        return Logic.normalizeCondition({
          kind,
          name: get(".oni-cond-variable-name"),
          op: get(".oni-cond-variable-op"),
          value: get(".oni-cond-variable-value")
        });
      case K.SELF:
        return Logic.normalizeCondition({ kind, slot: get(".oni-cond-self-slot"), want: get(".oni-cond-self-want") });
      case K.HAS_RUN:
        return Logic.normalizeCondition({ kind, want: get(".oni-cond-run-want") });
      default:
        return { kind: K.NONE };
    }
  }

  // ------------------------------------------------------------
  // File buttons (one listener per list root)
  // ------------------------------------------------------------
  function onFileButton(ev) {
    const browse = ev.target?.closest?.(".oni-event-file-browse");
    const preview = ev.target?.closest?.(".oni-event-file-preview");
    const btn = browse || preview;
    if (!btn) return;

    ev.preventDefault();
    const input = btn.parentElement?.querySelector?.(`input.${btn.dataset.target}`);
    if (!input) return;

    if (preview) {
      const src = String(input.value || "").trim();
      // The same player the action uses, so the preview is what players hear.
      const volume = Logic.toNumber(btn.closest(".oni-event-row")?.querySelector(".oni-event-row-sound-volume")?.value, 0.6);
      if (src) {
        window.oni.EventSystem.RowsMedia?.playSound?.(src, volume)?.catch?.((e) => {
          ui.notifications?.warn?.(`Could not play "${src}".`);
          console.warn(INSTALL_TAG, "Preview failed.", e);
        });
      }
      return;
    }

    try {
      new FilePicker({
        type: btn.dataset.pickerType || "any",
        current: String(input.value || ""),
        callback: (path) => {
          input.value = path;
          notify(input);
        }
      }).render(true);
    } catch (e) {
      console.warn(INSTALL_TAG, "Could not open the file picker.", e);
    }
  }

  // ------------------------------------------------------------
  // Row lists
  // ------------------------------------------------------------
  function rowsHostOf(listEl) {
    return listEl?.querySelector?.(":scope > .oni-event-list-rows") ?? null;
  }

  function updateIndices(listEl) {
    const host = rowsHostOf(listEl);
    if (!host) return;
    Array.from(host.children).forEach((rowEl, index) => {
      const bubble = rowEl.querySelector(":scope > .oni-event-row-head > .oni-event-row-index");
      if (bubble) bubble.textContent = String(index + 1);
    });
  }

  function buildTypeSelect(currentType) {
    const select = document.createElement("select");
    select.className = "oni-event-row-type";

    const groups = new Map();
    for (const opt of registry()?.getDropdownOptions?.() ?? []) {
      const key = opt.category || "General";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(opt);
    }

    const rank = (name) => {
      const i = CATEGORY_ORDER.indexOf(name);
      return i < 0 ? CATEGORY_ORDER.length : i;
    };
    const ordered = [...groups.keys()].sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b));

    for (const name of ordered) {
      const group = document.createElement("optgroup");
      group.label = name;
      for (const opt of groups.get(name)) {
        const option = document.createElement("option");
        option.value = String(opt.value);
        option.textContent = String(opt.label);
        if (String(opt.value) === String(currentType)) option.selected = true;
        group.appendChild(option);
      }
      select.appendChild(group);
    }

    // A type nobody registered: keep it selectable so saving does not change it.
    if (!registry()?.has?.(currentType)) {
      const option = document.createElement("option");
      option.value = String(currentType);
      option.textContent = `(unknown) ${currentType}`;
      option.selected = true;
      select.prepend(option);
    }

    return select;
  }

  function buildFieldsFor(row) {
    const def = registry()?.peek?.(row.type);

    if (!def) {
      return fields(`
        <div class="oni-event-row-notes">
          This event type is not recognized by the current registry, so it is skipped when the event runs.
          It is kept as written.<br>
          Type: <code>${escapeHTML(String(row.type || ""))}</code>
        </div>
      `);
    }

    if (!def.buildFields) {
      return fields(`<div class="oni-event-row-notes">This event has no settings.</div>`);
    }

    return def.buildFields(row, Kit);
  }

  function createRowElement(rowData, listEl) {
    const reg = registry();
    const row = reg?.normalizeRows?.([rowData])?.[0] ?? rowData;

    const rowEl = document.createElement("div");
    rowEl.className = "oni-event-row";
    rowEl.dataset.rowId = String(row.id);
    // Kept for a row whose type is unknown, so it is written back untouched.
    rowEl._rawRow = Logic.clone(row);

    const head = document.createElement("div");
    head.className = "oni-event-row-head";

    const indexBubble = document.createElement("div");
    indexBubble.className = "oni-event-row-index";
    indexBubble.textContent = "?";

    const typeSelect = buildTypeSelect(row.type);

    const spacer = document.createElement("div");
    spacer.className = "oni-event-row-spacer";

    const makeButton = (cls, html, title) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = cls;
      btn.title = title;
      btn.innerHTML = html;
      return btn;
    };

    const upBtn = makeButton("oni-event-row-up", `<i class="fas fa-arrow-up"></i>`, "Move up");
    const downBtn = makeButton("oni-event-row-down", `<i class="fas fa-arrow-down"></i>`, "Move down");
    const removeBtn = makeButton("oni-event-row-remove", `<i class="fas fa-trash"></i> Remove`, "Remove this event");

    head.append(indexBubble, typeSelect, spacer, upBtn, downBtn, removeBtn);

    const fieldsHost = document.createElement("div");
    fieldsHost.className = "oni-event-row-fields-host";
    fieldsHost.appendChild(buildFieldsFor(row));

    rowEl.append(head, fieldsHost);

    typeSelect.addEventListener("change", (ev) => {
      ev.stopPropagation();
      const nextType = String(typeSelect.value || C.DEFAULT_ROW_TYPE || "showText");
      const rebuilt = reg.makeDefaultRow(nextType);
      rebuilt.id = rowEl.dataset.rowId;

      rowEl._rawRow = Logic.clone(rebuilt);
      fieldsHost.replaceChildren(buildFieldsFor(rebuilt));
      notify(listEl);
    });

    upBtn.addEventListener("click", () => {
      const prev = rowEl.previousElementSibling;
      if (!prev) return;
      rowEl.parentElement.insertBefore(rowEl, prev);
      updateIndices(listEl);
      notify(listEl);
    });

    downBtn.addEventListener("click", () => {
      const next = rowEl.nextElementSibling;
      if (!next) return;
      rowEl.parentElement.insertBefore(next, rowEl);
      updateIndices(listEl);
      notify(listEl);
    });

    removeBtn.addEventListener("click", () => {
      rowEl.remove();
      updateIndices(listEl);
      notify(listEl);
    });

    return rowEl;
  }

  // A list of rows with its own Add button. makeRow() builds the row that
  // Add creates (default: a Show Text row).
  function buildList(rows, { addLabel = "Add Event", makeRow = null } = {}) {
    ensureStyle();

    const listEl = document.createElement("div");
    listEl.className = "oni-event-list";
    listEl.innerHTML = `
      <div class="oni-event-list-rows"></div>
      <div class="oni-event-list-actions">
        <button type="button" class="oni-event-add-row"><i class="fas fa-plus"></i> ${escapeHTML(addLabel)}</button>
      </div>
    `;

    const host = rowsHostOf(listEl);
    for (const row of Array.isArray(rows) ? rows : []) {
      host.appendChild(createRowElement(row, listEl));
    }
    updateIndices(listEl);

    listEl.querySelector(":scope > .oni-event-list-actions > .oni-event-add-row").addEventListener("click", () => {
      const row = typeof makeRow === "function"
        ? makeRow()
        : registry().makeDefaultRow(C.DEFAULT_ROW_TYPE || "showText");
      host.appendChild(createRowElement(row, listEl));
      updateIndices(listEl);
      notify(listEl);
    });

    listEl.addEventListener("click", onFileButton);

    return listEl;
  }

  function collectList(listEl) {
    const host = rowsHostOf(listEl);
    if (!host) return [];

    const rows = [];
    for (const rowEl of Array.from(host.children)) {
      if (!rowEl.classList.contains("oni-event-row")) continue;

      const typeEl = rowEl.querySelector(":scope > .oni-event-row-head > .oni-event-row-type");
      const type = String(typeEl?.value || C.DEFAULT_ROW_TYPE || "showText");
      const id = String(rowEl.dataset.rowId || foundry.utils.randomID());
      const def = registry()?.peek?.(type);

      if (!def) {
        rows.push({ ...(rowEl._rawRow ?? {}), id, type });
        continue;
      }

      rows.push({ id, type, ...(def.collectFields?.(rowEl, Kit) ?? {}) });
    }

    return rows;
  }

  // A labelled list inside a row. key tells the branches of one row apart.
  function subList(key, label, rows, listOptions = {}) {
    const wrap = document.createElement("div");
    wrap.className = "oni-event-sublist";
    wrap.dataset.listKey = String(key);

    if (label) {
      const title = document.createElement("div");
      title.className = "oni-event-sublist-label";
      title.textContent = String(label);
      wrap.appendChild(title);
    }

    wrap.appendChild(buildList(rows, listOptions));
    return wrap;
  }

  function readSubList(rowEl, key) {
    const wrap = ownAll(rowEl, ".oni-event-sublist").find(el => el.dataset.listKey === String(key));
    return collectList(wrap?.querySelector(":scope > .oni-event-list"));
  }

  const Kit = {
    installed: true,

    ensureStyle,
    escapeHTML,
    own,
    ownAll,
    notify,
    options,

    field,
    fields,
    waitField,
    readWait,
    numberInput,
    readNumber,
    readText,
    fileInput,

    refreshNameLists,
    nameInput,
    conditionEditor,
    readCondition,

    buildList,
    collectList,
    subList,
    readSubList
  };

  window.oni.EventSystem.ConfigKit = Kit;

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.ConfigKit");
})();
