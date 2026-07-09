/**
 * [BD][RewindButton] Floating GM button + history panel + confirm modal
 * -----------------------------------------------------------------------------
 * Installs a bottom-right floating button (sidebar-aware via CSS var) that
 * is only visible while a Battle Director combat is running. Click opens
 * a panel listing the 50 most-recent history entries (newest first);
 * clicking an entry opens a confirmation modal; confirming calls
 * `FUCompanion.api.experimental.battleDirector.rewindTo(snapshotId)`.
 *
 * Design + UX choices locked in [[director-rewind-tool-plan]].
 *
 * Joins the family of floating buttons at right=313 (sidebar-aware) /
 * bottom=N. Existing stack: CheckRoller=38, Combat=110, expAwarder=180,
 * ActiveEffect=254, CheckRequester=322 — Rewind lands at 390 (above
 * the stack so it stays clear of the others when it appears mid-combat).
 *
 * Classic script (not an esmodule). Wrapped in IIFE inside
 * Hooks.once("ready") so a load-order quirk can't break the rest of the
 * module's boot. Accesses the director API via globalThis at click time;
 * by then the esmodule has long since registered it.
 */

Hooks.once("ready", () => {
  (() => {
    const TAG = "[BD][RewindButton]";

    const CFG = {
      moduleId: "fabula-ultima-companion",
      gmOnly: true,
      // Position (above the CheckRequester button at 322).
      offsetRightPx: 313,
      offsetBottomPx: 430,
      sizePx: 52,
      zIndex: 81,
      // The panel + confirm modal must lay ABOVE the Battle Director action
      // card (z-index 95) so they're never hidden behind it — same intent as
      // the action card sitting above the battlefield. The corner BUTTON stays
      // at the floating-GM-button family z (81); only the openable surfaces are
      // raised. Kept below the round banner (z 100000) and the card's hover
      // tooltip so those still win.
      panelZIndex: 200,
      modalZIndex: 210,
      iconText: "⏪",
      tipLabel: "Rewind Battle Director",
    };

    const DOM = {
      ROOT_ID: "fud-rewindbtn-root",
      BTN_ID: "fud-rewindbtn",
      STYLE_ID: "fud-rewindbtn-style",
      PANEL_ID: "fud-rewindbtn-panel",
      MODAL_ID: "fud-rewindbtn-modal",
    };

    if (CFG.gmOnly && !game.user?.isGM) return;

    // ─── Helpers ───────────────────────────────────────────────────────

    const getApi = () =>
      globalThis.FUCompanion?.api?.experimental?.battleDirector ?? null;

    const isRunning = () => !!(getApi()?.isRunning?.());

    // "12s ago" / "4m ago" / "2h ago" / absolute past 1d.
    const formatRelative = (timestamp) => {
      if (!timestamp) return "";
      const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
      if (diffSec < 5) return "just now";
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      try {
        return new Date(timestamp).toLocaleString();
      } catch {
        return "";
      }
    };

    // ─── Styles (singleton) ────────────────────────────────────────────

    const ensureStyle = () => {
      if (document.getElementById(DOM.STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = DOM.STYLE_ID;
      style.textContent = [
        "#" + DOM.ROOT_ID + " {",
        "  position: fixed;",
        "  right: var(--fu-sidebar-anchor-right, " + CFG.offsetRightPx + "px);",
        "  bottom: " + CFG.offsetBottomPx + "px;",
        "  z-index: " + CFG.zIndex + ";",
        "  pointer-events: none;",
        "}",
        "#" + DOM.ROOT_ID + ".is-hidden { display: none; }",
        "#" + DOM.BTN_ID + " {",
        "  pointer-events: auto;",
        "  width: " + CFG.sizePx + "px;",
        "  height: " + CFG.sizePx + "px;",
        "  border-radius: 999px;",
        "  border: 1px solid rgba(255,255,255,0.22);",
        "  background: rgba(18, 18, 22, 0.86);",
        "  box-shadow: 0 10px 24px rgba(0,0,0,0.35), 0 2px 0 rgba(255,255,255,0.06) inset;",
        "  display: grid;",
        "  place-items: center;",
        "  cursor: pointer;",
        "  user-select: none;",
        "  -webkit-user-select: none;",
        "  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;",
        "  position: relative;",
        "}",
        "#" + DOM.BTN_ID + ":hover {",
        "  transform: translateY(-1px) scale(1.02);",
        "  background: rgba(28, 28, 34, 0.92);",
        "  border-color: rgba(255, 200, 100, 0.45);",
        "}",
        "#" + DOM.BTN_ID + ":active { transform: translateY(0) scale(0.99); }",
        "#" + DOM.BTN_ID + " .icon {",
        "  font-size: 22px;",
        "  line-height: 1;",
        "  filter: drop-shadow(0 2px 2px rgba(0,0,0,0.45));",
        "  color: rgba(255, 230, 180, 0.95);",
        "}",
        "#" + DOM.BTN_ID + " .tip {",
        "  position: absolute;",
        "  right: 0;",
        "  bottom: calc(100% + 10px);",
        "  background: rgba(10,10,12,0.92);",
        "  border: 1px solid rgba(255,255,255,0.18);",
        "  border-radius: 10px;",
        "  padding: 8px 10px;",
        "  font-size: 12px;",
        "  color: rgba(255,255,255,0.9);",
        "  white-space: nowrap;",
        "  opacity: 0;",
        "  transform: translateY(4px);",
        "  transition: opacity 120ms ease, transform 120ms ease;",
        "  pointer-events: none;",
        "  box-shadow: 0 10px 24px rgba(0,0,0,0.35);",
        "}",
        "#" + DOM.BTN_ID + ":hover .tip { opacity: 1; transform: translateY(0); }",

        // Panel — fixed height so it doesn't reshape as entries pile up.
        // The list area scrolls; the empty-state placeholder centers
        // inside the same fixed box. `min()` caps to viewport-height on
        // small screens so the panel never extends past the top edge.
        "#" + DOM.PANEL_ID + " {",
        "  position: fixed;",
        "  right: calc(var(--fu-sidebar-anchor-right, " + CFG.offsetRightPx + "px) + 70px);",
        "  bottom: " + CFG.offsetBottomPx + "px;",
        "  width: 380px;",
        "  height: min(440px, calc(100vh - " + (CFG.offsetBottomPx + 40) + "px));",
        "  background: rgba(16, 16, 20, 0.96);",
        "  border: 1px solid rgba(255, 200, 100, 0.32);",
        "  border-radius: 10px;",
        "  box-shadow: 0 20px 48px rgba(0,0,0,0.55);",
        "  z-index: " + CFG.panelZIndex + ";",
        "  pointer-events: auto;",
        "  display: flex;",
        "  flex-direction: column;",
        "  font-family: var(--font-primary, Signika, sans-serif);",
        "  color: rgba(255,255,255,0.92);",
        "  overflow: hidden;",
        "}",
        "#" + DOM.PANEL_ID + " .header {",
        "  padding: 10px 12px;",
        "  border-bottom: 1px solid rgba(255,255,255,0.12);",
        "  display: flex;",
        "  align-items: center;",
        "  justify-content: space-between;",
        "  background: rgba(0,0,0,0.25);",
        "}",
        "#" + DOM.PANEL_ID + " .header .title {",
        "  font-weight: 700;",
        "  font-size: 13px;",
        "  letter-spacing: 1px;",
        "  text-transform: uppercase;",
        "  color: rgba(255, 220, 160, 0.95);",
        "}",
        "#" + DOM.PANEL_ID + " .header .closeBtn {",
        "  cursor: pointer;",
        "  color: rgba(255,255,255,0.6);",
        "  font-size: 16px;",
        "  line-height: 1;",
        "  padding: 2px 6px;",
        "  border-radius: 4px;",
        "  transition: background 120ms ease, color 120ms ease;",
        "}",
        "#" + DOM.PANEL_ID + " .header .closeBtn:hover { background: rgba(255,255,255,0.08); color: white; }",
        "#" + DOM.PANEL_ID + " .list { overflow-y: auto; padding: 4px 0; flex: 1; min-height: 0; }",
        "#" + DOM.PANEL_ID + " .empty {",
        "  height: 100%;",
        "  display: flex;",
        "  align-items: center;",
        "  justify-content: center;",
        "  padding: 24px 16px;",
        "  text-align: center;",
        "  color: rgba(255,255,255,0.55);",
        "  font-size: 12px;",
        "  font-style: italic;",
        "}",
        "#" + DOM.PANEL_ID + " .entry {",
        "  padding: 10px 12px;",
        "  border-bottom: 1px solid rgba(255,255,255,0.05);",
        "  cursor: pointer;",
        "  display: grid;",
        "  grid-template-columns: 22px 1fr auto;",
        "  gap: 8px;",
        "  align-items: start;",
        "  transition: background 120ms ease;",
        "}",
        "#" + DOM.PANEL_ID + " .entry:hover { background: rgba(255, 200, 100, 0.10); }",
        "#" + DOM.PANEL_ID + " .entry:last-child { border-bottom: none; }",
        "#" + DOM.PANEL_ID + " .entry.is-latest .ord { color: rgba(120, 220, 140, 0.9); }",
        "#" + DOM.PANEL_ID + " .entry .ord {",
        "  font-size: 11px;",
        "  color: rgba(255,255,255,0.4);",
        "  font-variant-numeric: tabular-nums;",
        "  padding-top: 1px;",
        "}",
        "#" + DOM.PANEL_ID + " .entry .label {",
        "  font-size: 13px;",
        "  font-weight: 600;",
        "  color: rgba(255,255,255,0.95);",
        "  line-height: 1.3;",
        "}",
        "#" + DOM.PANEL_ID + " .entry .desc {",
        "  font-size: 11px;",
        "  color: rgba(255,255,255,0.65);",
        "  line-height: 1.3;",
        "  margin-top: 2px;",
        "}",
        "#" + DOM.PANEL_ID + " .entry .time {",
        "  font-size: 10px;",
        "  color: rgba(255,255,255,0.45);",
        "  white-space: nowrap;",
        "  padding-top: 2px;",
        "  font-variant-numeric: tabular-nums;",
        "}",
        "#" + DOM.PANEL_ID + " .entry .resolved {",
        "  display: inline-block;",
        "  font-size: 9px;",
        "  letter-spacing: 0.5px;",
        "  color: rgba(255, 180, 100, 0.85);",
        "  background: rgba(255, 180, 100, 0.12);",
        "  border: 1px solid rgba(255, 180, 100, 0.25);",
        "  border-radius: 3px;",
        "  padding: 0 4px;",
        "  margin-left: 6px;",
        "  vertical-align: middle;",
        "}",

        // Modal
        "#" + DOM.MODAL_ID + " {",
        "  position: fixed;",
        "  inset: 0;",
        "  background: rgba(0,0,0,0.55);",
        "  z-index: " + CFG.modalZIndex + ";",
        "  display: grid;",
        "  place-items: center;",
        "  pointer-events: auto;",
        "}",
        "#" + DOM.MODAL_ID + " .modal-box {",
        "  width: 420px;",
        "  max-width: 90vw;",
        "  background: rgba(20, 20, 26, 0.98);",
        "  border: 1px solid rgba(255, 200, 100, 0.35);",
        "  border-radius: 12px;",
        "  box-shadow: 0 24px 60px rgba(0,0,0,0.6);",
        "  color: rgba(255,255,255,0.9);",
        "  font-family: var(--font-primary, Signika, sans-serif);",
        "  overflow: hidden;",
        "}",
        "#" + DOM.MODAL_ID + " .modal-head {",
        "  padding: 14px 18px;",
        "  border-bottom: 1px solid rgba(255,255,255,0.12);",
        "  font-size: 14px;",
        "  font-weight: 700;",
        "  letter-spacing: 1px;",
        "  text-transform: uppercase;",
        "  color: rgba(255, 220, 160, 0.95);",
        "  background: rgba(0,0,0,0.3);",
        "}",
        "#" + DOM.MODAL_ID + " .modal-body { padding: 18px; font-size: 13px; line-height: 1.5; }",
        "#" + DOM.MODAL_ID + " .modal-body .target {",
        "  font-weight: 600;",
        "  color: rgba(255, 230, 180, 0.95);",
        "  margin-bottom: 4px;",
        "}",
        "#" + DOM.MODAL_ID + " .modal-body .target-desc {",
        "  font-size: 12px;",
        "  color: rgba(255,255,255,0.65);",
        "  margin-bottom: 12px;",
        "}",
        "#" + DOM.MODAL_ID + " .modal-body .warning {",
        "  font-size: 12px;",
        "  color: rgba(255, 180, 100, 0.85);",
        "  background: rgba(255, 180, 100, 0.08);",
        "  border: 1px solid rgba(255, 180, 100, 0.2);",
        "  border-radius: 6px;",
        "  padding: 8px 10px;",
        "}",
        "#" + DOM.MODAL_ID + " .modal-foot {",
        "  display: flex;",
        "  gap: 8px;",
        "  justify-content: flex-end;",
        "  padding: 12px 14px;",
        "  background: rgba(0,0,0,0.18);",
        "  border-top: 1px solid rgba(255,255,255,0.08);",
        "}",
        "#" + DOM.MODAL_ID + " button {",
        "  padding: 6px 16px;",
        "  border-radius: 6px;",
        "  border: 1px solid rgba(255,255,255,0.18);",
        "  background: rgba(40, 40, 48, 0.9);",
        "  color: rgba(255,255,255,0.9);",
        "  font-size: 13px;",
        "  cursor: pointer;",
        "  font-family: inherit;",
        "  transition: background 120ms ease, border-color 120ms ease;",
        "}",
        "#" + DOM.MODAL_ID + " button:hover { background: rgba(60, 60, 70, 0.95); border-color: rgba(255,255,255,0.32); }",
        "#" + DOM.MODAL_ID + " button.confirm {",
        "  background: rgba(180, 90, 40, 0.85);",
        "  border-color: rgba(255, 180, 100, 0.45);",
        "}",
        "#" + DOM.MODAL_ID + " button.confirm:hover { background: rgba(200, 110, 50, 0.95); }",
      ].join("\n");
      document.head.appendChild(style);
    };

    // ─── Modal ────────────────────────────────────────────────────────

    const closeModal = () => {
      try { document.getElementById(DOM.MODAL_ID)?.remove(); } catch {}
    };

    const openConfirmModal = (entry) => {
      closeModal();
      const overlay = document.createElement("div");
      overlay.id = DOM.MODAL_ID;
      const box = document.createElement("div");
      box.className = "modal-box";
      box.innerHTML = [
        '<div class="modal-head">Rewind Battle Director</div>',
        '<div class="modal-body">',
        '  <div class="target"></div>',
        '  <div class="target-desc"></div>',
        '  <div class="warning">All actions taken since this checkpoint will be undone. Actor HP / MP / IP / equipment / Active Effects will be restored to the saved state. Consumables used since then will be put back.</div>',
        '</div>',
        '<div class="modal-foot">',
        '  <button class="cancel" type="button">Cancel</button>',
        '  <button class="confirm" type="button">Rewind</button>',
        '</div>',
      ].join("");
      box.querySelector(".target").textContent = entry.label || "(unnamed checkpoint)";
      const descEl = box.querySelector(".target-desc");
      if (entry.description) descEl.textContent = entry.description;
      else descEl.style.display = "none";

      box.querySelector(".cancel").addEventListener("click", closeModal);
      box.querySelector(".confirm").addEventListener("click", async () => {
        closeModal();
        closePanel();
        const api = getApi();
        if (!api?.rewindTo) {
          ui.notifications?.error?.("Battle Director API not available.");
          return;
        }
        try {
          const result = await api.rewindTo(entry.id);
          if (!result?.ok) {
            console.warn(TAG, "rewindTo returned not-ok:", result);
          }
        } catch (e) {
          console.error(TAG, "rewindTo threw:", e);
          ui.notifications?.error?.("Rewind failed. See console.");
        }
      });

      // Click outside the box to cancel.
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) closeModal();
      });

      overlay.appendChild(box);
      document.body.appendChild(overlay);
    };

    // ─── Panel ────────────────────────────────────────────────────────

    const closePanel = () => {
      try { document.getElementById(DOM.PANEL_ID)?.remove(); } catch {}
      document.removeEventListener("mousedown", onDocMousedown, true);
    };

    const onDocMousedown = (ev) => {
      const panel = document.getElementById(DOM.PANEL_ID);
      const btn = document.getElementById(DOM.BTN_ID);
      if (!panel) return;
      if (panel.contains(ev.target)) return;
      if (btn && btn.contains(ev.target)) return;
      closePanel();
    };

    const openPanel = () => {
      // Toggle: clicking the button while open closes the panel.
      if (document.getElementById(DOM.PANEL_ID)) {
        closePanel();
        return;
      }

      const api = getApi();
      const entries = api?.history?.() ?? [];

      const panel = document.createElement("div");
      panel.id = DOM.PANEL_ID;

      const header = document.createElement("div");
      header.className = "header";
      header.innerHTML =
        '<div class="title">Battle Rewind</div>' +
        '<div class="closeBtn" title="Close">✕</div>';
      header.querySelector(".closeBtn").addEventListener("click", closePanel);
      panel.appendChild(header);

      const list = document.createElement("div");
      list.className = "list";

      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No checkpoints yet — the first save lands when the battle starts.";
        list.appendChild(empty);
      } else {
        for (const entry of entries) {
          const row = document.createElement("div");
          row.className = "entry" + (entry.isLatest ? " is-latest" : "");
          row.innerHTML = [
            '<div class="ord">' + entry.ordinal + '.</div>',
            '<div class="body">',
            '  <div class="label"></div>',
            '  <div class="desc"></div>',
            '</div>',
            '<div class="time"></div>',
          ].join("");
          const labelEl = row.querySelector(".label");
          labelEl.textContent = entry.label || "(unnamed)";
          if (entry.currentTurnResolved) {
            const pill = document.createElement("span");
            pill.className = "resolved";
            pill.textContent = "RESOLVED";
            labelEl.appendChild(pill);
          }
          const descEl = row.querySelector(".desc");
          if (entry.description) descEl.textContent = entry.description;
          else descEl.style.display = "none";
          row.querySelector(".time").textContent = formatRelative(entry.savedAt);
          row.addEventListener("click", () => openConfirmModal(entry));
          list.appendChild(row);
        }
      }
      panel.appendChild(list);

      document.body.appendChild(panel);
      // Defer to next tick so the click that opened the panel doesn't
      // immediately trigger the outside-click handler.
      setTimeout(() => {
        document.addEventListener("mousedown", onDocMousedown, true);
      }, 0);
    };

    // ─── Button ───────────────────────────────────────────────────────

    const ensureRoot = () => {
      let root = document.getElementById(DOM.ROOT_ID);
      if (!root) {
        root = document.createElement("div");
        root.id = DOM.ROOT_ID;
        document.body.appendChild(root);
      }
      return root;
    };

    const refreshVisibility = () => {
      const root = document.getElementById(DOM.ROOT_ID);
      if (!root) return;
      if (isRunning()) root.classList.remove("is-hidden");
      else {
        root.classList.add("is-hidden");
        // Close panel/modal if combat ended while they were open.
        closePanel();
        closeModal();
      }
    };

    const buildButton = () => {
      const root = ensureRoot();
      root.innerHTML = "";

      const btn = document.createElement("div");
      btn.id = DOM.BTN_ID;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-label", CFG.tipLabel);
      btn.innerHTML =
        '<div class="tip"></div>' +
        '<div class="icon">' + CFG.iconText + '</div>';
      btn.querySelector(".tip").textContent = CFG.tipLabel;

      const onClick = (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        openPanel();
      };
      const onKeyDown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") onClick(ev);
      };
      btn.addEventListener("click", onClick);
      btn.addEventListener("keydown", onKeyDown);
      root.appendChild(btn);
    };

    // ─── Install ──────────────────────────────────────────────────────

    ensureStyle();
    buildButton();
    refreshVisibility();

    Hooks.on("fu-director-started", refreshVisibility);
    Hooks.on("fu-director-stopped", refreshVisibility);
    Hooks.on("canvasReady", refreshVisibility);
  })();
});
