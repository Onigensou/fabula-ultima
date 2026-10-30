/**
 * [ONI] Event System — Pause for GM
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-pause.js
 *
 * What this does:
 * - Registers the "Pause for GM" event action: the event stops at this row for
 *   as long as the table needs (roleplay), and only a GM can send it on.
 * - "GM can't end the event here" hides the status chip's End for as long as
 *   this pause is open, for a moment with no way back. Continue is always there,
 *   so it cannot get stuck, and End returns when the event moves on.
 * - With no GM choices, the GM's prompt is one Continue button. With choices,
 *   it is one button per choice, and the events under the chosen one run before
 *   the event carries on. This is for a table that does what the writer did not
 *   expect: "they get away" / "the party stops them".
 * - The prompt is in the event's status chip, on every GM client. Players see
 *   no prompt; their screen stays as the last row left it.
 *
 * How it fits together:
 * - The event's safety timers are held meanwhile (Flow.hold), as for a choice
 *   menu, so a long scene is not timed out. The chip's End still cuts it.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 * - event-gmChip.js (looked up when used)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsPause]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsPause?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const KIND_OPEN = "pause.open";
  const KIND_CLOSE = "pause.close";
  const REQUEST = "pause";
  const MAX_CHOICES = 6;

  const flow = () => window.oni.EventSystem.Flow;
  const chip = () => window.oni.EventSystem.GmChip;

  // GM running the event: sourceId -> resolve(index of the choice, or null)
  const pending = new Map();

  function buildPanel(sourceId, note, labels) {
    const wrap = document.createElement("div");

    const title = document.createElement("div");
    title.className = "oni-chip-panel-title";
    title.textContent = note || (labels.length ? "Paused. What happens next?" : "Paused. Continue when the table is ready.");
    wrap.appendChild(title);

    const buttons = document.createElement("div");
    buttons.className = "oni-chip-panel-buttons";

    const add = (label, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oni-chip-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => flow()?.request?.(REQUEST, { sourceId, index }));
      buttons.appendChild(btn);
    };

    if (labels.length) labels.forEach((label, index) => add(label || `Choice ${index + 1}`, index));
    else add("Continue", null);

    wrap.appendChild(buttons);
    return wrap;
  }

  Client.register(KIND_OPEN, (data, info) => {
    if (!game.user?.isGM) return;
    chip()?.setPanel?.(info.sourceId, buildPanel(info.sourceId, data.note, data.labels ?? []));
    chip()?.setEndHidden?.(info.sourceId, data.noEnd === true);
    Client.setMarker(info.sourceId, "pause", "waiting for the GM");
    ui.notifications?.info?.("Event paused. Answer on the event panel when the table is ready.");
    Client.addCleanup(info.sourceId, "pause", () => chip()?.setPanel?.(info.sourceId, null));
  });

  Client.register(KIND_CLOSE, (data, info) => {
    if (!game.user?.isGM) return;
    chip()?.setPanel?.(info.sourceId, null);
    chip()?.setEndHidden?.(info.sourceId, false);
    Client.setMarker(info.sourceId, "pause", null);
    Client.removeCleanup(info.sourceId, "pause");
  });

  Hooks.once("ready", () => flow()?.onRequest?.(REQUEST, (data, userId) => {
    if (game.users?.get(userId)?.isGM !== true) return;
    const index = Number.isInteger(data?.index) ? data.index : null;
    pending.get(String(data?.sourceId || ""))?.(index);
  }));

  function prepare(row) {
    row.note = String(row.note ?? "");
    row.noEnd = row.noEnd === true;
    row.choices = (Array.isArray(row.choices) ? row.choices : []).slice(0, MAX_CHOICES).map((raw) => ({
      id: String(raw?.id || Logic.makeId()),
      label: String(raw?.label ?? ""),
      rows: Array.isArray(raw?.rows) ? raw.rows : []
    }));
  }

  // One GM choice in the config window: its label and its events.
  function buildChoiceElement(choice, kit, onChange) {
    const el = document.createElement("div");
    el.className = "oni-event-option";
    el.dataset.choiceId = choice.id;
    el.innerHTML = `
      <div class="oni-event-inline-row">
        <input type="text" class="oni-pause-choice-label oni-grow" value="${kit.escapeHTML(choice.label)}" placeholder="Button text for the GM" />
        <button type="button" class="oni-pause-choice-remove" title="Remove this choice"><i class="fas fa-trash"></i></button>
      </div>
    `;
    el.appendChild(kit.subList(`choice:${choice.id}`, "", choice.rows));

    el.querySelector(".oni-pause-choice-remove").addEventListener("click", () => {
      const host = el.parentElement;
      el.remove();
      onChange(host);
    });

    return el;
  }

  EventRegistry.register({
    type: "pauseForGM",
    label: "Pause for GM",
    category: "Flow",
    defaultData: { type: "pauseForGM", note: "", noEnd: false, choices: [] },
    prepare,
    childLists: (row) => (row.choices ?? []).map(c => ({ label: c.label, rows: c.rows })),
    summary: (row) => String(row?.note ?? "").trim() || (row?.choices ?? []).map(c => c.label).join(" / "),
    execute: async (row, context) => {
      const f = flow();
      const id = String(context?.tileId || "");
      if (!id || !f) return { ok: false, type: "pauseForGM", reason: "noFlow" };

      const choices = row?.choices ?? [];

      f.hold(id);
      let offAbort = null;
      const picked = await new Promise((resolve) => {
        pending.set(id, resolve);
        offAbort = f.onAbort(id, () => resolve(null));
        Client.run(id, KIND_OPEN, { note: String(row?.note ?? "").trim(), labels: choices.map(c => c.label), noEnd: row?.noEnd === true });
      });

      offAbort?.();
      pending.delete(id);
      f.release(id);
      Client.run(id, KIND_CLOSE);

      if (f.isAborted?.(id)) return { ok: true, type: "pauseForGM", aborted: true };

      const choice = picked === null ? null : choices[picked];
      if (!choice) return { ok: true, type: "pauseForGM", picked: null };

      const result = await context.runRows(choice.rows ?? []);
      return { ...result, type: "pauseForGM", picked: choice.id };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Note for the GM",
          `<input type="text" class="oni-event-row-pause-note" value="${kit.escapeHTML(row.note ?? "")}" placeholder="Roleplay the confrontation" />`,
          "Shown beside the buttons. Players don't see it. The event waits here with no time limit."
        ),
        kit.field(
          "End button",
          `<label><input type="checkbox" class="oni-event-row-pause-noend" ${row.noEnd === true ? "checked" : ""} /> GM can't end the event here</label>`,
          "Hides End while this pause is open, for a moment with no way back. It returns when the event moves on."
        ),
        kit.field(
          "GM choices",
          `<div class="oni-pause-choices oni-event-row-body"></div>
           <div class="oni-event-list-actions">
             <button type="button" class="oni-pause-choice-add"><i class="fas fa-plus"></i> Add choice</button>
           </div>`,
          `Optional. With none, the GM gets one Continue button. With some, the GM picks one, its
           events run, and the event carries on with the rows after this one.`
        )
      );

      const host = body.querySelector(".oni-pause-choices");
      const addBtn = body.querySelector(".oni-pause-choice-add");
      const onChange = (el) => {
        addBtn.disabled = host.children.length >= MAX_CHOICES;
        kit.notify(el ?? host);
      };

      for (const choice of row.choices ?? []) host.appendChild(buildChoiceElement(choice, kit, onChange));
      addBtn.disabled = host.children.length >= MAX_CHOICES;

      addBtn.addEventListener("click", () => {
        if (host.children.length >= MAX_CHOICES) return;
        host.appendChild(buildChoiceElement({ id: Logic.makeId(), label: "", rows: [] }, kit, onChange));
        onChange(host);
      });

      return body;
    },
    collectFields: (rowEl, kit) => ({
      note: kit.readText(rowEl, ".oni-event-row-pause-note", "").trim(),
      noEnd: !!kit.own(rowEl, ".oni-event-row-pause-noend")?.checked,
      choices: kit.ownAll(rowEl, ".oni-event-option").map((choiceEl) => {
        const id = String(choiceEl.dataset.choiceId || Logic.makeId());
        return {
          id,
          label: String(choiceEl.querySelector(":scope > .oni-event-inline-row .oni-pause-choice-label")?.value ?? "").trim(),
          rows: kit.readSubList(rowEl, `choice:${id}`)
        };
      })
    })
  });

  window.oni.EventSystem.RowsPause = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
