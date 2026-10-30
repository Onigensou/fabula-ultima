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
 * - The GM's prompt is a Continue button in the event's status chip, on every GM
 *   client. Players see no prompt; their screen stays as the last row left it.
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

  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing EventRegistry or Client. Check load order.");
    return;
  }

  const KIND_OPEN = "pause.open";
  const KIND_CLOSE = "pause.close";
  const REQUEST = "pause";

  const flow = () => window.oni.EventSystem.Flow;
  const chip = () => window.oni.EventSystem.GmChip;

  // GM running the event: sourceId -> resolve
  const pending = new Map();

  function buildPanel(sourceId, note) {
    const wrap = document.createElement("div");

    const title = document.createElement("div");
    title.className = "oni-chip-panel-title";
    title.textContent = note || "Paused. Continue when the table is ready.";
    wrap.appendChild(title);

    const buttons = document.createElement("div");
    buttons.className = "oni-chip-panel-buttons";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "oni-chip-btn";
    btn.textContent = "Continue";
    btn.addEventListener("click", () => flow()?.request?.(REQUEST, { sourceId }));
    buttons.appendChild(btn);

    wrap.appendChild(buttons);
    return wrap;
  }

  Client.register(KIND_OPEN, (data, info) => {
    if (!game.user?.isGM) return;
    chip()?.setPanel?.(info.sourceId, buildPanel(info.sourceId, data.note));
    Client.setMarker(info.sourceId, "pause", "waiting for the GM");
    ui.notifications?.info?.("Event paused. Press Continue on the event panel when the table is ready.");
    Client.addCleanup(info.sourceId, "pause", () => chip()?.setPanel?.(info.sourceId, null));
  });

  Client.register(KIND_CLOSE, (data, info) => {
    if (!game.user?.isGM) return;
    chip()?.setPanel?.(info.sourceId, null);
    Client.setMarker(info.sourceId, "pause", null);
    Client.removeCleanup(info.sourceId, "pause");
  });

  Hooks.once("ready", () => flow()?.onRequest?.(REQUEST, (data, userId) => {
    if (game.users?.get(userId)?.isGM !== true) return;
    pending.get(String(data?.sourceId || ""))?.();
  }));

  EventRegistry.register({
    type: "pauseForGM",
    label: "Pause for GM",
    category: "Flow",
    defaultData: { type: "pauseForGM", note: "" },
    summary: (row) => String(row?.note ?? "").trim(),
    execute: async (row, context) => {
      const f = flow();
      const id = String(context?.tileId || "");
      if (!id || !f) return { ok: false, type: "pauseForGM", reason: "noFlow" };

      f.hold(id);
      const offAbort = { off: null };
      await new Promise((resolve) => {
        pending.set(id, resolve);
        offAbort.off = f.onAbort(id, resolve);
        Client.run(id, KIND_OPEN, { note: String(row?.note ?? "").trim() });
      });

      offAbort.off?.();
      pending.delete(id);
      f.release(id);
      Client.run(id, KIND_CLOSE);

      return { ok: true, type: "pauseForGM" };
    },
    buildFields: (row, kit) => kit.fields(
      kit.field(
        "Note for the GM",
        `<input type="text" class="oni-event-row-pause-note" value="${kit.escapeHTML(row.note ?? "")}" placeholder="Roleplay the confrontation" />`,
        "Shown beside the Continue button. Players don't see it. The event waits here with no time limit."
      )
    ),
    collectFields: (rowEl, kit) => ({
      note: kit.readText(rowEl, ".oni-event-row-pause-note", "").trim()
    })
  });

  window.oni.EventSystem.RowsPause = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
