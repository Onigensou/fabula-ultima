/**
 * Fabula Ledger — villain status on the actor sheet
 *
 * File: scripts/fabula-ledger/fl-sheet.js
 *
 * The status (Auto / Villain / Hidden / Never) is set where monsters are made:
 * a small dropdown right of the Rank field on an NPC's sheet. A sheet whose
 * template has no Rank field gets it in the title bar instead. GM only, so a
 * player opening an NPC sheet never sees it (no spoilers).
 *
 * Why here (user, 2026-11-05): the module may be handed to friends as a
 * template for their own games, set up without Claude. Someone building a
 * monster would never find a label that only lives in the ledger panel.
 *
 * Nothing is stored on the sheet or in the template: the dropdown reads and
 * writes the same actor flag as the rest of the ledger (fl-ledger.js).
 */
(() => {
  const TAG = "[FabulaLedger][Sheet]";
  const MODULE_ID = "fabula-ultima-companion";
  const STYLE_ID = "fl-sheet-style";
  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  const I = () => FL._internal;

  const OPTIONS = [["auto", "☆ Auto"], ["villain", "★ Villain"], ["hidden", "◐ Hidden"], ["never", "✕ Never"]];
  const HELP = [
    "Villain status (Fabula Points), GM only:",
    "☆ Auto: not decided. A Champion makes the GM prompt ask the first time they appear.",
    "★ Villain: appearing pays the party +1 (once per map); a fight pays the boss point.",
    "◐ Hidden: a villain the players don't know yet. Nothing until you Reveal them.",
    "✕ Never: never pays, never asks (friendly Champions, training dummies)."
  ].join("\n");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
select.fl-villain-status { margin-left: 6px; width: auto; min-width: 7.5em; flex: 0 0 auto; font-weight: 600; }
select.fl-villain-status[data-s="villain"] { color: #a1362a; }
select.fl-villain-status[data-s="hidden"] { color: #5b4a8a; }
select.fl-villain-status[data-s="never"] { color: #6b6b6b; }
.window-header select.fl-villain-status {
  height: 22px; font-size: 12px; margin: 0 6px; background: rgba(255,255,255,0.9); color: #3a1e06; border-radius: 3px;
}`;
    document.head.appendChild(s);
  }

  function makeSelect(actor, template) {
    const sel = document.createElement("select");
    sel.className = `fl-villain-status ${template?.className ?? ""}`.trim();
    sel.title = HELP;
    sel.setAttribute("aria-label", "Villain status");
    // No name attribute: the sheet's own form submit must not pick it up.
    const cur = FL.api.getStatus(actor);
    sel.innerHTML = OPTIONS.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("");
    sel.dataset.s = cur;
    // The sheet's form listens for "change" and would submit; keep it to us.
    sel.addEventListener("change", async (ev) => {
      ev.stopPropagation();
      const v = sel.value;
      sel.dataset.s = v;
      await FL.api.setStatus(actor, v);
      try { await I()?.note?.(`${actor.name}: ${OPTIONS.find(o => o[0] === v)?.[1].slice(2) ?? v} (sheet)`); } catch { /* log is optional */ }
    });
    return sel;
  }

  Hooks.on("renderActorSheet", (app, html) => {
    try {
      if (!game.user?.isGM || !FL.api || !I()) return;
      const actor = app.actor;
      if (!actor || !I().isNpc(actor)) return;
      const root = html?.[0] ?? html;
      if (!root?.querySelector) return;
      const win = root.closest?.(".window-app") ?? app.element?.[0] ?? root;
      win.querySelectorAll("select.fl-villain-status").forEach(e => e.remove());
      ensureStyle();

      const rank = root.querySelector('[name="system.props.npc_rank"]');
      if (rank) {
        rank.insertAdjacentElement("afterend", makeSelect(actor, rank));
        return;
      }
      // Template without a Rank field: put it in the title bar, before the buttons.
      const header = win.querySelector(".window-header");
      const firstBtn = header?.querySelector("a.header-button, .header-button");
      if (header) header.insertBefore(makeSelect(actor, null), firstBtn ?? null);
    } catch (e) {
      console.warn(TAG, "could not add the villain status control", e);
    }
  });

  console.debug(TAG, "installed");
})();
