/**
 * [ONI] Event System — Flow and state actions
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-flow.js
 *
 * What this does:
 * - Registers the event actions that steer an event or change progress:
 *     Wait            pause for a number of seconds
 *     Condition       run one list of events or another
 *     End Event       stop here
 *     Erase Event     this event's prompt never appears again for this party
 *     Set Switch      a story switch, or one of this event's own (A-D)
 *     Set Variable    set / add / subtract / random
 *
 * Requires:
 * - event-constants.js, event-logic.js, event-eventRegistry.js
 * - event-flow.js, event-gameState.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsFlow]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsFlow?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const flow = () => window.oni.EventSystem.Flow;
  const gameState = () => window.oni.EventSystem.GameState;

  const WAIT_MAX_SECONDS = 120;

  // ------------------------------------------------------------
  // Wait
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "wait",
    label: "Wait",
    category: "Flow",
    defaultData: { type: "wait", seconds: 1 },
    summary: (row) => `${Logic.toNumber(row?.seconds, 1)} s`,
    execute: async (row, context) => {
      const seconds = Math.min(WAIT_MAX_SECONDS, Math.max(0, Logic.toNumber(row?.seconds, 1)));
      await flow()?.wait?.(context?.tileId, seconds * 1000);
      return { ok: true, type: "wait", seconds };
    },
    buildFields: (row, kit) => kit.fields(
      kit.field(
        "Seconds",
        kit.numberInput("oni-event-row-seconds", Logic.toNumber(row.seconds, 1), { min: 0, max: WAIT_MAX_SECONDS, step: 0.1 }),
        "A pause before the next event. A press does not skip it."
      )
    ),
    collectFields: (rowEl, kit) => ({
      seconds: Math.min(WAIT_MAX_SECONDS, Math.max(0, kit.readNumber(rowEl, ".oni-event-row-seconds", 1)))
    })
  });

  // ------------------------------------------------------------
  // Condition
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "condition",
    label: "Condition",
    category: "Flow",
    defaultData: {
      type: "condition",
      condition: { kind: Logic.CONDITION_KINDS.SWITCH, name: "", want: "on" },
      thenRows: [],
      elseRows: []
    },
    prepare: (row) => {
      row.condition = Logic.normalizeCondition(row.condition);
      if (!Array.isArray(row.thenRows)) row.thenRows = [];
      if (!Array.isArray(row.elseRows)) row.elseRows = [];
    },
    childLists: (row) => [
      { label: "Then", rows: row.thenRows },
      { label: "Else", rows: row.elseRows }
    ],
    summary: (row) => Logic.describeCondition(row?.condition),
    execute: async (row, context) => {
      const reader = gameState()?.readerFor?.(context?.sceneId, context?.tileId);
      const passed = reader ? Logic.evalCondition(row?.condition, reader) : true;

      const result = await context.runRows(passed ? row.thenRows : row.elseRows);
      return { ...result, type: "condition", passed };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field("If", `<div class="oni-event-cond-host"></div>`)
      );
      body.querySelector(".oni-event-cond-host").appendChild(kit.conditionEditor(row.condition, { allowAlways: false }));
      body.appendChild(kit.subList("then", "Then", row.thenRows));
      body.appendChild(kit.subList("else", "Else", row.elseRows));
      return body;
    },
    collectFields: (rowEl, kit) => ({
      condition: kit.readCondition(kit.own(rowEl, ".oni-cond")),
      thenRows: kit.readSubList(rowEl, "then"),
      elseRows: kit.readSubList(rowEl, "else")
    })
  });

  // ------------------------------------------------------------
  // End Event
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "endEvent",
    label: "End Event",
    category: "Flow",
    defaultData: { type: "endEvent" },
    execute: async () => ({ ok: true, type: "endEvent", stop: true }),
    buildFields: (row, kit) => kit.fields(
      `<div class="oni-event-row-notes">The event stops here. Nothing below this runs.</div>`
    ),
    collectFields: () => ({})
  });

  // ------------------------------------------------------------
  // Erase Event
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "eraseEvent",
    label: "Erase Event",
    category: "Flow",
    defaultData: { type: "eraseEvent" },
    execute: async (row, context) => {
      const done = await gameState()?.erase?.(context?.sceneId, context?.tileId);
      return { ok: !!done, type: "eraseEvent" };
    },
    buildFields: (row, kit) => kit.fields(
      `<div class="oni-event-row-notes">
         From now on this event's prompt no longer appears for the current party. The rest of the
         sequence still runs. "Reset this event's memory" brings it back.
       </div>`
    ),
    collectFields: () => ({})
  });

  // ------------------------------------------------------------
  // Set Switch
  // ------------------------------------------------------------
  const SWITCH_VALUES = [["on", "On"], ["off", "Off"], ["toggle", "Toggle"]];

  function switchValue(raw) {
    if (raw === "toggle") return "toggle";
    return raw === "off" ? false : true;
  }

  EventRegistry.register({
    type: "setSwitch",
    label: "Set Switch",
    category: "State",
    defaultData: { type: "setSwitch", scope: "story", name: "", slot: "A", value: "on" },
    summary: (row) => (row?.scope === "self" ? `This event ${row?.slot ?? "A"}` : String(row?.name ?? "")) + ` → ${row?.value ?? "on"}`,
    execute: async (row, context) => {
      const state = gameState();
      if (!state) return { ok: false, reason: "noGameState" };

      const value = switchValue(row?.value);
      const result = row?.scope === "self"
        ? await state.setSelf(context?.sceneId, context?.tileId, row?.slot, value)
        : await state.setSwitch(row?.name, value);

      return { ok: result !== null && result !== undefined, type: "setSwitch", value: result };
    },
    buildFields: (row, kit) => {
      const isSelf = row.scope === "self";
      const body = kit.fields(
        kit.field(
          "Switch",
          `<div class="oni-event-inline-row">
             <select class="oni-event-row-switch-scope">${kit.options([["story", "Story switch"], ["self", "This event's switch"]], isSelf ? "self" : "story")}</select>
             <span class="oni-event-row-switch-story oni-event-inline-row oni-grow" ${isSelf ? "hidden" : ""}>
               ${kit.nameInput("oni-event-row-switch-name", row.name, "switch")}
             </span>
             <span class="oni-event-row-switch-self oni-event-inline-row" ${isSelf ? "" : "hidden"}>
               <select class="oni-event-row-switch-slot">${kit.options(Logic.SELF_SLOTS.map(s => [s, s]), row.slot ?? "A")}</select>
             </span>
             <select class="oni-event-row-switch-value">${kit.options(SWITCH_VALUES, row.value ?? "on")}</select>
           </div>`,
          `A story switch is kept on the party's database sheet and any event can test it.
           This event's own switches (A-D) belong to this one event.`
        )
      );

      const scopeEl = body.querySelector(".oni-event-row-switch-scope");
      scopeEl.addEventListener("change", () => {
        body.querySelector(".oni-event-row-switch-story").hidden = scopeEl.value === "self";
        body.querySelector(".oni-event-row-switch-self").hidden = scopeEl.value !== "self";
      });

      return body;
    },
    collectFields: (rowEl, kit) => ({
      scope: kit.readText(rowEl, ".oni-event-row-switch-scope", "story") === "self" ? "self" : "story",
      name: kit.readText(rowEl, ".oni-event-row-switch-name", "").trim(),
      slot: kit.readText(rowEl, ".oni-event-row-switch-slot", "A"),
      value: kit.readText(rowEl, ".oni-event-row-switch-value", "on")
    })
  });

  // ------------------------------------------------------------
  // Set Variable
  // ------------------------------------------------------------
  const VARIABLE_OPS = [["set", "Set to"], ["add", "Add"], ["sub", "Subtract"], ["random", "Random between"]];

  EventRegistry.register({
    type: "setVariable",
    label: "Set Variable",
    category: "State",
    defaultData: { type: "setVariable", name: "", op: "set", value: 0, max: 0 },
    summary: (row) => `${row?.name ?? ""} ${row?.op ?? "set"} ${row?.value ?? 0}`,
    execute: async (row, context) => {
      const state = gameState();
      if (!state) return { ok: false, reason: "noGameState" };

      let op = String(row?.op || "set");
      let value = Logic.toNumber(row?.value, 0);

      if (op === "random") {
        const low = Math.ceil(Math.min(value, Logic.toNumber(row?.max, value)));
        const high = Math.floor(Math.max(value, Logic.toNumber(row?.max, value)));
        value = low + Math.floor(Math.random() * ((high - low) + 1));
        op = "set";
      }

      const result = await state.setVariable(row?.name, op, value);
      return { ok: result !== null && result !== undefined, type: "setVariable", value: result };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Variable",
          `<div class="oni-event-inline-row">
             ${kit.nameInput("oni-event-row-variable-name", row.name, "variable")}
             <select class="oni-event-row-variable-op">${kit.options(VARIABLE_OPS, row.op ?? "set")}</select>
             ${kit.numberInput("oni-event-row-variable-value", Logic.toNumber(row.value, 0))}
             <span class="oni-event-row-variable-max-wrap oni-event-inline-row" ${row.op === "random" ? "" : "hidden"}>
               <span>and</span>
               ${kit.numberInput("oni-event-row-variable-max", Logic.toNumber(row.max, 0))}
             </span>
           </div>`,
          "Kept on the party's database sheet. A variable that does not exist yet starts at 0."
        )
      );

      const opEl = body.querySelector(".oni-event-row-variable-op");
      opEl.addEventListener("change", () => {
        body.querySelector(".oni-event-row-variable-max-wrap").hidden = opEl.value !== "random";
      });

      return body;
    },
    collectFields: (rowEl, kit) => ({
      name: kit.readText(rowEl, ".oni-event-row-variable-name", "").trim(),
      op: kit.readText(rowEl, ".oni-event-row-variable-op", "set"),
      value: kit.readNumber(rowEl, ".oni-event-row-variable-value", 0),
      max: kit.readNumber(rowEl, ".oni-event-row-variable-max", 0)
    })
  });

  window.oni.EventSystem.RowsFlow = { installed: true };

  console.debug(INSTALL_TAG, "Installed.");
})();
