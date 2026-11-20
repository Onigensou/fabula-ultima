/**
 * [ONI] Event System — Show Tutorial
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-tutorial.js
 *
 * What this does:
 * - Registers the "Show Tutorial" event action: a System Tutorial card (the
 *   Conflict Event rules card, shared) opens on every connected screen, one
 *   page per idea. With "Wait" on, the event goes on when the Main Controller
 *   closes theirs (Done on the last page, or Close); everyone else's closes
 *   with it. If the Main Controller is offline, the GM's own card counts.
 * - Tutorials are registered by their systems (FUCompanion.api.systemTutorial,
 *   e.g. "fabula-arcana" from scripts/fabula-arcana/fa-boot.js).
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-flow.js
 * - scripts/system-tutorial/system-tutorial.js (looked up when used)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsTutorial]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsTutorial?.installed) return;

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const flow = () => window.oni.EventSystem.Flow;
  const api = () => globalThis.FUCompanion?.api?.systemTutorial;

  async function mainControllerUserId() {
    try { return (await globalThis.FUCompanion?.api?.MovementControl?.getCurrentControllerUser?.())?.userId ?? null; } catch { return null; }
  }

  EventRegistry.register({
    type: "showTutorial",
    label: "Show Tutorial",
    category: "Flow",
    defaultData: { type: "showTutorial", tutorial: "fabula-arcana", wait: true },
    prepare: (row) => { row.tutorial = String(row.tutorial ?? "").trim(); row.wait = row.wait !== false; },
    summary: (row) => {
      const t = api()?.get?.(row?.tutorial);
      return `${t?.title ?? row?.tutorial ?? "?"}${t ? ` (${t.pages.length} pages)` : " (unknown)"}${row?.wait === false ? "" : " · waits for the Main Controller"}`;
    },
    execute: async (row, context) => {
      const T = api();
      if (!T?.showToEveryone) return { ok: false, type: "showTutorial", reason: "noTutorialSystem" };
      if (!T.get(row?.tutorial)) {
        ui.notifications?.warn?.(`Show Tutorial: no tutorial called "${row?.tutorial}".`);
        return { ok: false, type: "showTutorial", reason: "unknownTutorial" };
      }
      const shown = T.showToEveryone(row.tutorial, { waitFor: await mainControllerUserId() });
      if (row?.wait === false) return { ok: true, type: "showTutorial", waited: false };

      const f = flow();
      const id = String(context?.tileId || "");
      if (id) f?.hold?.(id);
      const offAbort = id ? f?.onAbort?.(id, () => T.closeEverywhere()) : null;
      let res = null;
      try { res = await shown; }
      catch (e) { console.error(INSTALL_TAG, e); return { ok: false, type: "showTutorial", reason: "threw", stop: true }; }
      finally { offAbort?.(); if (id) f?.release?.(id); }
      if (id && f?.isAborted?.(id)) return { ok: true, type: "showTutorial", aborted: true };
      return { ok: true, type: "showTutorial", waited: true, reason: res?.reason ?? null };
    },
    buildFields: (row, kit) => {
      const list = api()?.list?.() ?? [];
      const known = list.some((t) => t.id === row.tutorial);
      const opts = list.map((t) => `<option value="${kit.escapeHTML(t.id)}" ${row.tutorial === t.id ? "selected" : ""}>${kit.escapeHTML(t.title)}</option>`).join("")
        + (!known && row.tutorial ? `<option value="${kit.escapeHTML(row.tutorial)}" selected>${kit.escapeHTML(row.tutorial)} (not loaded)</option>` : "");
      return kit.fields(
        kit.field("Tutorial", `<select class="oni-event-row-tut-id">${opts}</select>`,
          "The same card as the Conflict Event rules: one page per idea, a screenshot and one sentence. Opens on every connected screen."),
        kit.field("Wait", `<label><input type="checkbox" class="oni-event-row-tut-wait" ${row.wait !== false ? "checked" : ""} /> wait until the Main Controller closes it</label>`,
          "Everyone else's card closes with theirs. If the Main Controller is offline, closing yours continues.")
      );
    },
    collectFields: (rowEl, kit) => ({
      tutorial: kit.readText(rowEl, ".oni-event-row-tut-id", "").trim(),
      wait: !!rowEl.querySelector(".oni-event-row-tut-wait")?.checked
    })
  });

  window.oni.EventSystem.RowsTutorial = { installed: true };
})();
