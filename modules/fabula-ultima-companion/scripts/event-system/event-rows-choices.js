/**
 * [ONI] Event System — Show Choices
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-choices.js
 *
 * What this does:
 * - Registers the "Show Choices" event action: a menu of 2 to 4 answers,
 *   each with its own list of events, and (this being a tabletop game) one
 *   more answer that means "we would rather roleplay this out".
 *
 * How it fits together:
 * - The GM running the event is the authority, as for dialogue. Everyone on
 *   the scene sees the menu and the highlight; the main controller and the
 *   GM move it and choose. A move or a pick on another client is sent to
 *   that GM, who tells every client.
 * - The roleplay answer does not pick a branch. The menu gives way to a
 *   "roleplaying" marker, the party stays where it is, and the GM resolves
 *   it from the status chip: as any of the written answers, with no branch,
 *   or by ending the event.
 * - The GM can also take any answer directly at any time, for a table that
 *   talked it out before anyone pressed a button.
 * - While the menu or the roleplay is open the event's safety timers are
 *   held (event-flow.js): the table may take as long as it likes.
 * - The GM gets no menu over the map and no keys taken: their side is the
 *   panel in the status chip. A GM viewing as a player sees the menu too.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 * - event-input.js, event-gmChip.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsChoices]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsChoices?.installed) {
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

  const KIND_OPEN = "choice.open";
  const KIND_HIGHLIGHT = "choice.highlight";
  const KIND_ROLEPLAY = "choice.roleplay";
  const KIND_CLOSE = "choice.close";
  const REQUEST = "choice";

  const STYLE_ID = "oni-event-choice-style";
  const MENU_ID = "oni-event-choice";

  const MIN_OPTIONS = 2;
  const MAX_OPTIONS = 4;
  const DEFAULT_ROLEPLAY_LABEL = "Something else…";
  const MENU_OUT_MS = 280; // keep in step with #oni-event-choice.is-leaving

  // A menu takes no answer for this long after it opens. The press that
  // closed the line before it, or a player hammering Confirm through the
  // text, would otherwise pick the first answer before anyone has read it
  // (seen live, 2026-10-13). Moving the highlight is allowed at once.
  const settings = { pickGuardMs: 500 };

  const flow = () => window.oni.EventSystem.Flow;
  const chip = () => window.oni.EventSystem.GmChip;
  const gameState = () => window.oni.EventSystem.GameState;

  // GM, the menus this client is waiting on: sourceId -> { menu, row, highlight, roleplaying, resolve }
  const pending = new Map();
  // Every client, the menu on screen: sourceId -> { el, menu, highlight, stopInput }
  const shown = new Map();

  function withVariables(text) {
    const state = gameState();
    if (!state?.getVariable) return String(text ?? "");
    return Logic.substituteVars(text, (name) => state.getVariable(name));
  }

  // ------------------------------------------------------------
  // CSS — the Save / Load skin, as on the teleporter prompt
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${MENU_ID} {
  position: fixed;
  left: 50%;
  top: 44%;
  z-index: 9995;
  box-sizing: border-box;
  min-width: 380px;
  max-width: min(720px, 90vw);
  padding: 26px 34px 28px;
  border: 2px solid #c9a44a;
  border-radius: 14px;
  background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 0 28px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,245,200,0.70);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
  color: #3a1e06;
  user-select: none;
  pointer-events: auto;
  opacity: 0;
  transform: translate(calc(-50% - 32px), -50%);   /* enters from the left */
  transition: opacity 360ms cubic-bezier(.25,.46,.45,.94),
              transform 360ms cubic-bezier(.25,.46,.45,.94);
}
#${MENU_ID}::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 12px;
  background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
}
#${MENU_ID}.is-visible {
  opacity: 1;
  transform: translate(-50%, -50%);
}
#${MENU_ID}.is-leaving {
  opacity: 0;
  transform: translate(calc(-50% + 32px), -50%);   /* leaves to the right */
  transition: opacity 280ms cubic-bezier(.55,.085,.68,.53),
              transform 280ms cubic-bezier(.55,.085,.68,.53);
  pointer-events: none;
}
#${MENU_ID} .oni-choice-msg {
  position: relative;
  margin: 0 0 18px;
  padding: 0;
  text-align: center;
  font-size: 20px;
  font-weight: 400;
  line-height: 1.5;
  letter-spacing: .3px;
}
#${MENU_ID} .oni-choice-msg:empty { display: none; }
#${MENU_ID} .oni-choice-list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
#${MENU_ID} .oni-choice-btn {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  margin: 0;
  padding: 8px 26px;
  border: 1px solid #9b7040;
  border-radius: 8px;
  background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
  color: #f4e8c0;
  font-family: inherit;
  font-size: 16px;
  font-weight: 400;
  line-height: 1.3;
  letter-spacing: .4px;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.14);
  transition: border-color .12s, color .12s, background .12s, box-shadow .12s;
}
#${MENU_ID} .oni-choice-btn:focus { outline: none; }
#${MENU_ID} .oni-choice-btn.is-picked {
  border-color: #f4d488; color: #fff8e0;
  background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
  box-shadow: 0 0 0 2px #f4d488, 0 0 18px rgba(244,212,136,0.55), 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.22);
}
/* The roleplay answer is a way out of the menu, not one more branch */
#${MENU_ID} .oni-choice-btn.is-roleplay {
  margin-top: 6px;
  font-style: italic;
  background: linear-gradient(180deg, #6a5a44 0%, #4c3e2c 100%);
}
#${MENU_ID} .oni-choice-btn.is-roleplay.is-picked {
  background: linear-gradient(180deg, #8a7658 0%, #6a5840 100%);
}
/* Not the main controller: the menu is shown, but it is not theirs to press */
#${MENU_ID}.is-readonly .oni-choice-btn {
  pointer-events: none;
  cursor: default;
}
#${MENU_ID} .oni-choice-roleplaying {
  position: relative;
  margin: 0;
  text-align: center;
  font-size: 18px;
  font-style: italic;
  line-height: 1.5;
}
    `;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------
  // The menu on a player's screen
  // ------------------------------------------------------------
  function entryCount(menu) {
    return menu.options.length + (menu.roleplay ? 1 : 0);
  }

  function paintHighlight(view) {
    view.el?.querySelectorAll(".oni-choice-btn").forEach((btn, index) => {
      btn.classList.toggle("is-picked", index === view.highlight);
    });
  }

  function move(sourceId, index) {
    const view = shown.get(sourceId);
    if (!view) return;

    const count = entryCount(view.menu);
    const next = ((index % count) + count) % count;
    if (next === view.highlight) return;

    // Shown here at once; the GM then tells everyone else.
    view.highlight = next;
    paintHighlight(view);
    flow()?.request?.(REQUEST, { sourceId, op: "move", index: next });
  }

  function pick(sourceId, index) {
    flow()?.request?.(REQUEST, { sourceId, op: "pick", index });
  }

  function closeMenu(sourceId, { immediate = false } = {}) {
    const view = shown.get(sourceId);
    if (!view) return;
    shown.delete(sourceId);

    view.stopInput?.();
    const el = view.el;
    if (!el) return;

    if (immediate) {
      el.remove();
      return;
    }
    el.classList.remove("is-visible");
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), MENU_OUT_MS + 40);
  }

  function openMenu(sourceId, menu, highlight) {
    closeMenu(sourceId, { immediate: true });
    ensureStyle();

    const interactive = flow()?.isLocalUserInteractor?.() ?? true;

    const el = document.createElement("div");
    el.id = MENU_ID;
    el.setAttribute("role", "dialog");
    el.classList.toggle("is-readonly", !interactive);
    el.innerHTML = `<p class="oni-choice-msg"></p><div class="oni-choice-list"></div>`;
    el.querySelector(".oni-choice-msg").textContent = menu.prompt || "";

    const list = el.querySelector(".oni-choice-list");
    const labels = [
      ...menu.options.map(o => o.label),
      ...(menu.roleplay ? [menu.roleplayLabel || DEFAULT_ROLEPLAY_LABEL] : [])
    ];

    labels.forEach((label, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oni-choice-btn";
      if (menu.roleplay && index === labels.length - 1) btn.classList.add("is-roleplay");
      btn.textContent = label;
      btn.addEventListener("pointerenter", () => move(sourceId, index));
      btn.addEventListener("click", () => pick(sourceId, index));
      list.appendChild(btn);
    });

    // pointerdown is swallowed so the click never reaches the canvas underneath
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    const view = { el, menu, highlight: Number(highlight) || 0, stopInput: null };
    shown.set(sourceId, view);
    paintHighlight(view);

    if (interactive) {
      const A = window.oni.Input?.ACTIONS ?? {};
      view.stopInput = window.oni.Input?.listen?.(({ action }) => {
        if (!shown.has(sourceId)) return false;
        if (action === A.UP) move(sourceId, view.highlight - 1);
        else if (action === A.DOWN) move(sourceId, view.highlight + 1);
        else if (action === A.CONFIRM) pick(sourceId, view.highlight);
        else if (action === A.CANCEL) flow()?.request?.(REQUEST, { sourceId, op: "cancel" });
        else return false;
        return true;
      }) ?? null;
    }

    document.body.appendChild(el);
    // Two frames so the starting (hidden, offset) state is painted before the transition.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (shown.get(sourceId) === view) el.classList.add("is-visible");
    }));
  }

  function showRoleplaying(sourceId) {
    const view = shown.get(sourceId);
    if (!view?.el) return;

    view.stopInput?.();
    view.stopInput = null;

    const note = document.createElement("p");
    note.className = "oni-choice-roleplaying";
    note.textContent = "Roleplaying…";
    view.el.querySelector(".oni-choice-list")?.replaceWith(note);
  }

  // ------------------------------------------------------------
  // The GM's side, in the status chip
  // ------------------------------------------------------------
  function buildGmPanel(sourceId, menu, roleplaying) {
    const wrap = document.createElement("div");

    const title = document.createElement("div");
    title.className = "oni-chip-panel-title";
    title.textContent = roleplaying
      ? "The table is roleplaying. Resolve as:"
      : `Choice${menu.prompt ? `: ${menu.prompt}` : ""} — answer for them:`;
    wrap.appendChild(title);

    const buttons = document.createElement("div");
    buttons.className = "oni-chip-panel-buttons";

    const add = (label, how, optionId = null, tip = "") => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oni-chip-btn";
      btn.textContent = label;
      if (tip) btn.title = tip;
      btn.addEventListener("click", () => {
        flow()?.request?.(REQUEST, { sourceId, op: "resolve", how, optionId });
      });
      buttons.appendChild(btn);
    };

    for (const option of menu.options) add(option.label, "option", option.id);
    add("No branch", "none", null, "Close the menu and carry on with the event, taking none of the answers");

    wrap.appendChild(buttons);
    return wrap;
  }

  // ------------------------------------------------------------
  // On every client
  // ------------------------------------------------------------
  Client.register(KIND_OPEN, (data, info) => {
    const menu = data.menu;
    if (!menu?.options?.length) return;

    if (game.user?.isGM) chip()?.setPanel?.(info.sourceId, buildGmPanel(info.sourceId, menu, false));
    Client.setMarker(info.sourceId, "choice", "choosing");

    if (info.presents) openMenu(info.sourceId, menu, data.highlight);

    Client.addCleanup(info.sourceId, "choice", () => {
      closeMenu(info.sourceId, { immediate: true });
      chip()?.setPanel?.(info.sourceId, null);
    });
  });

  Client.register(KIND_HIGHLIGHT, (data, info) => {
    const view = shown.get(info.sourceId);
    if (!view) return;
    view.highlight = Number(data.index) || 0;
    paintHighlight(view);
  });

  Client.register(KIND_ROLEPLAY, (data, info) => {
    if (game.user?.isGM && data.menu) chip()?.setPanel?.(info.sourceId, buildGmPanel(info.sourceId, data.menu, true));
    Client.setMarker(info.sourceId, "choice", "roleplaying");
    showRoleplaying(info.sourceId);
  });

  Client.register(KIND_CLOSE, (data, info) => {
    const view = shown.get(info.sourceId);
    if (view && Number.isInteger(data.index)) {
      view.highlight = data.index;
      paintHighlight(view);
    }

    closeMenu(info.sourceId);
    chip()?.setPanel?.(info.sourceId, null);
    Client.setMarker(info.sourceId, "choice", null);
  });

  // ------------------------------------------------------------
  // On the GM running the event
  // ------------------------------------------------------------
  async function mayChoose(userId) {
    const user = game.users?.get(userId);
    if (!user) return false;
    if (user.isGM) return true;
    return !!(await flow()?.isUserInteractor?.(userId));
  }

  async function onRequest(data, userId) {
    const sourceId = String(data?.sourceId || "");
    const wait = pending.get(sourceId);
    if (!wait) return;

    const isGM = game.users?.get(userId)?.isGM === true;
    const count = entryCount(wait.menu);

    if (data.op === "resolve") {
      if (!isGM) return;
      if (data.how === "option") {
        const index = wait.menu.options.findIndex(o => o.id === data.optionId);
        if (index >= 0) wait.resolve({ kind: "option", index });
      } else if (data.how === "none") {
        wait.resolve({ kind: "none" });
      }
      return;
    }

    // Once the table is roleplaying, only the GM resolves it.
    if (wait.roleplaying) return;
    if (!(await mayChoose(userId))) return;
    if (!pending.has(sourceId)) return;

    const tooSoon = (Date.now() - wait.openedAt) < settings.pickGuardMs;

    if (data.op === "move") {
      const index = Number(data.index);
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      wait.highlight = index;
      Client.run(sourceId, KIND_HIGHLIGHT, { index });
      return;
    }

    if (data.op === "cancel") {
      if (tooSoon) return;
      const index = wait.menu.options.findIndex(o => o.cancel);
      if (index >= 0) wait.resolve({ kind: "option", index });
      return;
    }

    if (data.op === "pick") {
      const index = Number(data.index);
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      if (tooSoon) return;

      if (wait.menu.roleplay && index === count - 1) {
        wait.roleplaying = true;
        Client.run(sourceId, KIND_ROLEPLAY, { menu: wait.menu });
        return;
      }

      wait.resolve({ kind: "option", index });
    }
  }

  // event-flow.js loads first, but the handler is only needed once an event runs.
  Hooks.once("ready", () => flow()?.onRequest?.(REQUEST, onRequest));

  // ------------------------------------------------------------
  // The action
  // ------------------------------------------------------------
  function prepare(row) {
    let options = Array.isArray(row.options) ? row.options : [];
    options = options.slice(0, MAX_OPTIONS).map((raw) => ({
      id: String(raw?.id || Logic.makeId()),
      label: String(raw?.label ?? ""),
      cancel: raw?.cancel === true,
      rows: Array.isArray(raw?.rows) ? raw.rows : []
    }));

    while (options.length < MIN_OPTIONS) {
      options.push({ id: Logic.makeId(), label: options.length ? "No" : "Yes", cancel: false, rows: [] });
    }

    // One answer at most stands for Cancel.
    let seenCancel = false;
    for (const option of options) {
      if (option.cancel && seenCancel) option.cancel = false;
      if (option.cancel) seenCancel = true;
    }

    row.options = options;
    row.prompt = String(row.prompt ?? "");
    row.roleplay = row.roleplay !== false;
    row.roleplayLabel = String(row.roleplayLabel ?? "").trim() || DEFAULT_ROLEPLAY_LABEL;
  }

  async function execute(row, context) {
    const sourceId = String(context?.tileId || "");
    const f = flow();
    if (!sourceId || !f) return { ok: false, reason: "noFlow" };

    const menu = {
      prompt: withVariables(row.prompt),
      options: row.options.map(o => ({ id: o.id, label: withVariables(o.label) || "…", cancel: !!o.cancel })),
      roleplay: row.roleplay !== false,
      roleplayLabel: withVariables(row.roleplayLabel) || DEFAULT_ROLEPLAY_LABEL
    };

    let resolveAnswer;
    const answered = new Promise((resolve) => { resolveAnswer = resolve; });

    pending.set(sourceId, {
      menu,
      row,
      highlight: 0,
      roleplaying: false,
      openedAt: Date.now(),
      resolve: (answer) => resolveAnswer(answer)
    });

    f.hold(sourceId);
    const offAbort = f.onAbort(sourceId, () => resolveAnswer({ kind: "abort" }));
    Client.run(sourceId, KIND_OPEN, { menu, highlight: 0 });

    const answer = await answered;

    offAbort();
    pending.delete(sourceId);
    f.release(sourceId);
    Client.run(sourceId, KIND_CLOSE, { index: answer.kind === "option" ? answer.index : null });

    if (answer.kind === "abort") return { ok: true, type: "showChoices", aborted: true };

    // Let the menu leave before whatever the answer starts.
    await f.wait(sourceId, MENU_OUT_MS + 80);

    if (answer.kind !== "option") return { ok: true, type: "showChoices", picked: null };

    const option = row.options[answer.index];
    const result = await context.runRows(option?.rows ?? []);
    return { ...result, type: "showChoices", picked: option?.id ?? null };
  }

  // One answer in the config window: label, "Cancel picks this", its events.
  function buildOptionElement(option, kit, onChange) {
    const el = document.createElement("div");
    el.className = "oni-event-option";
    el.dataset.optionId = option.id;
    el.innerHTML = `
      <div class="oni-event-inline-row">
        <input type="text" class="oni-choice-label oni-grow" value="${kit.escapeHTML(option.label)}" placeholder="Answer text" />
        <label title="Pressing Cancel (X) picks this answer">
          <input type="checkbox" class="oni-choice-cancel" ${option.cancel ? "checked" : ""} /> Cancel picks this
        </label>
        <button type="button" class="oni-choice-remove" title="Remove this answer"><i class="fas fa-trash"></i></button>
      </div>
    `;
    el.appendChild(kit.subList(`option:${option.id}`, "", option.rows));

    el.querySelector(".oni-choice-remove").addEventListener("click", () => {
      const host = el.parentElement;
      if (host && host.children.length <= MIN_OPTIONS) return;
      el.remove();
      onChange(host);
    });

    // One answer at most stands for Cancel.
    const cancelEl = el.querySelector(".oni-choice-cancel");
    cancelEl.addEventListener("change", () => {
      if (!cancelEl.checked) return;
      for (const other of el.parentElement?.querySelectorAll(":scope > .oni-event-option > .oni-event-inline-row .oni-choice-cancel") ?? []) {
        if (other !== cancelEl) other.checked = false;
      }
    });

    return el;
  }

  EventRegistry.register({
    type: "showChoices",
    label: "Show Choices",
    category: "Dialogue",
    defaultData: {
      type: "showChoices",
      prompt: "",
      options: [
        { label: "Yes", cancel: false, rows: [] },
        { label: "No", cancel: true, rows: [] }
      ],
      roleplay: true,
      roleplayLabel: DEFAULT_ROLEPLAY_LABEL
    },
    prepare,
    childLists: (row) => (row.options ?? []).map(o => ({ label: o.label, rows: o.rows })),
    summary: (row) => String(row?.prompt || (row?.options ?? []).map(o => o.label).join(" / ")).slice(0, 40),
    execute,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Question",
          `<input type="text" class="oni-choice-prompt" value="${kit.escapeHTML(row.prompt ?? "")}" placeholder="Optional. Shown above the answers." />`
        ),
        kit.field(
          "Answers",
          `<div class="oni-choice-options oni-event-row-body"></div>
           <div class="oni-event-list-actions">
             <button type="button" class="oni-choice-add"><i class="fas fa-plus"></i> Add answer</button>
           </div>`,
          `${MIN_OPTIONS} to ${MAX_OPTIONS} answers. The events under an answer run when it is chosen.`
        ),
        kit.field(
          "Roleplay answer",
          `<div class="oni-event-inline-row">
             <input type="checkbox" class="oni-choice-roleplay" ${row.roleplay !== false ? "checked" : ""} />
             <input type="text" class="oni-choice-roleplay-label oni-grow" value="${kit.escapeHTML(row.roleplayLabel ?? DEFAULT_ROLEPLAY_LABEL)}" />
           </div>`,
          `One more answer, for a table that would rather play it out. It picks no branch:
           the GM resolves it from the event's status chip.`
        )
      );

      const host = body.querySelector(".oni-choice-options");
      const addBtn = body.querySelector(".oni-choice-add");
      const onChange = (el) => {
        addBtn.disabled = host.children.length >= MAX_OPTIONS;
        kit.notify(el ?? host);
      };

      for (const option of row.options ?? []) host.appendChild(buildOptionElement(option, kit, onChange));
      addBtn.disabled = host.children.length >= MAX_OPTIONS;

      addBtn.addEventListener("click", () => {
        if (host.children.length >= MAX_OPTIONS) return;
        host.appendChild(buildOptionElement({ id: Logic.makeId(), label: "", cancel: false, rows: [] }, kit, onChange));
        onChange(host);
      });

      return body;
    },
    collectFields: (rowEl, kit) => ({
      prompt: kit.readText(rowEl, ".oni-choice-prompt", "").trim(),
      options: kit.ownAll(rowEl, ".oni-event-option").map((optionEl) => {
        const id = String(optionEl.dataset.optionId || Logic.makeId());
        const head = optionEl.querySelector(":scope > .oni-event-inline-row");
        return {
          id,
          label: String(head?.querySelector(".oni-choice-label")?.value ?? "").trim(),
          cancel: !!head?.querySelector(".oni-choice-cancel")?.checked,
          rows: kit.readSubList(rowEl, `option:${id}`)
        };
      }),
      roleplay: !!kit.own(rowEl, ".oni-choice-roleplay")?.checked,
      roleplayLabel: kit.readText(rowEl, ".oni-choice-roleplay-label", DEFAULT_ROLEPLAY_LABEL).trim() || DEFAULT_ROLEPLAY_LABEL
    })
  });

  window.oni.EventSystem.RowsChoices = { installed: true, settings };

  console.debug(INSTALL_TAG, "Installed.");
})();
