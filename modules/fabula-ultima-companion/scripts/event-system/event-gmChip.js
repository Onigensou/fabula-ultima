/**
 * [ONI] Event System — GM status chip
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-gmChip.js
 *
 * What this does:
 * - An event never takes the GM's screen (no camera pan, no fade), so the GM
 *   would lose track of what the players are seeing. This is the small panel
 *   that says it instead, on GM clients only:
 *     which event is running and what it is doing now
 *     what the players' screens are showing ("screen faded", "camera away")
 *     an End button, to cut a stuck or unwanted event at any time
 * - Hosts the GM's side of a choice menu (event-rows-choices.js), so the GM
 *   can answer or resolve a choice without a menu covering the map.
 *
 * Exposes API to:
 *   window.oni.EventSystem.GmChip
 *
 * Requires:
 * - event-client.js, event-flow.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][GmChip]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.GmChip?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const ROOT_ID = "oni-event-gm-chip";
  const STYLE_ID = "oni-event-gm-chip-style";

  const flow = () => window.oni.EventSystem.Flow;
  const client = () => window.oni.EventSystem.Client;

  // sourceId -> { el, panel }
  const entries = new Map();
  // Panels handed over before their event's entry exists.
  const pendingPanels = new Map();

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    // Same parchment / wood family as the Save and Load screens, kept small.
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        left: 124px;
        top: 96px;
        z-index: 95;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: 340px;
        pointer-events: none;
        font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
      }

      #${ROOT_ID} .oni-chip {
        pointer-events: auto;
        box-sizing: border-box;
        padding: 8px 10px 9px;
        border: 2px solid #c9a44a;
        border-radius: 8px;
        background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
        box-shadow: 0 0 0 2px #7a4e20, 0 4px 14px rgba(0,0,0,0.35);
        color: #3a1e06;
        font-size: 13px;
        line-height: 1.35;
      }

      #${ROOT_ID} .oni-chip-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #${ROOT_ID} .oni-chip-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${ROOT_ID} .oni-chip-title strong { font-weight: 700; }

      #${ROOT_ID} .oni-chip-now,
      #${ROOT_ID} .oni-chip-marks {
        margin-top: 3px;
        font-size: 12px;
        opacity: .85;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${ROOT_ID} .oni-chip-marks:empty,
      #${ROOT_ID} .oni-chip-now:empty,
      #${ROOT_ID} .oni-chip-panel:empty {
        display: none;
      }

      #${ROOT_ID} .oni-chip-panel {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(122,78,32,0.35);
      }

      #${ROOT_ID} button.oni-chip-btn {
        width: auto;
        flex: 0 0 auto;
        margin: 0;
        padding: 0 10px;
        height: 26px;
        line-height: 24px;
        border: 1px solid #9b7040;
        border-radius: 6px;
        background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
        color: #f4e8c0;
        font-family: inherit;
        font-size: 12px;
        cursor: pointer;
      }

      #${ROOT_ID} button.oni-chip-btn:hover {
        border-color: #f4d488;
        box-shadow: 0 0 0 1px #f4d488;
      }

      #${ROOT_ID} button.oni-chip-btn.is-end {
        background: linear-gradient(180deg, #7a2e18 0%, #5a1c08 100%);
      }

      #${ROOT_ID} .oni-chip-panel-title {
        margin-bottom: 6px;
      }

      #${ROOT_ID} .oni-chip-panel-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
    `;
    document.head.appendChild(style);
  }

  function root() {
    ensureStyle();
    let el = document.getElementById(ROOT_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = ROOT_ID;
      document.body.appendChild(el);
    }
    return el;
  }

  function sourceName(sourceId) {
    const scene = canvas?.scene;
    const token = scene?.tokens?.get(sourceId);
    if (token) return token.name || "NPC";

    const tile = scene?.tiles?.get(sourceId);
    return tile?.flags?.["fabula-ultima-companion"]?.draftName || "Event tile";
  }

  function add(sourceId) {
    if (!game.user?.isGM || entries.has(sourceId)) return;

    const el = document.createElement("div");
    el.className = "oni-chip";
    el.innerHTML = `
      <div class="oni-chip-head">
        <div class="oni-chip-title">Event: <strong></strong></div>
        <button type="button" class="oni-chip-btn is-end" title="End this event now, for everyone">End</button>
      </div>
      <div class="oni-chip-now"></div>
      <div class="oni-chip-marks"></div>
      <div class="oni-chip-panel"></div>
    `;
    el.querySelector("strong").textContent = sourceName(sourceId);
    el.querySelector(".is-end").addEventListener("click", () => flow()?.abort?.(sourceId));
    // A click on the chip must not reach the map under it.
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    root().appendChild(el);
    entries.set(sourceId, { el });

    setMarkers(sourceId, client()?.getMarkers?.(sourceId) ?? []);
    if (pendingPanels.has(sourceId)) {
      setPanel(sourceId, pendingPanels.get(sourceId));
      pendingPanels.delete(sourceId);
    }
  }

  function remove(sourceId) {
    pendingPanels.delete(sourceId);
    const entry = entries.get(sourceId);
    if (!entry) return;
    entry.el.remove();
    entries.delete(sourceId);
  }

  function removeAll() {
    for (const id of [...entries.keys()]) remove(id);
    pendingPanels.clear();
  }

  function setProgress(sourceId, { index, total, label, summary } = {}) {
    const now = entries.get(sourceId)?.el?.querySelector(".oni-chip-now");
    if (!now) return;

    const place = Number.isFinite(index) && Number.isFinite(total) ? `${index + 1}/${total} ` : "";
    now.textContent = `${place}${label ?? ""}${summary ? ` — ${summary}` : ""}`;
  }

  function setMarkers(sourceId, list) {
    const marks = entries.get(sourceId)?.el?.querySelector(".oni-chip-marks");
    if (marks) marks.textContent = (list ?? []).length ? `Players: ${list.join(", ")}` : "";
  }

  // An element shown inside this event's chip (the GM side of a choice), or
  // null to take it away.
  function setPanel(sourceId, panelEl) {
    const id = String(sourceId || "");
    const entry = entries.get(id);

    if (!entry) {
      if (panelEl) pendingPanels.set(id, panelEl);
      else pendingPanels.delete(id);
      return;
    }

    const host = entry.el.querySelector(".oni-chip-panel");
    if (panelEl) host.replaceChildren(panelEl);
    else host.replaceChildren();
  }

  // Takes the End button away for a moment with no way back (Pause for GM).
  function setEndHidden(sourceId, hidden) {
    const end = entries.get(String(sourceId || ""))?.el?.querySelector(".is-end");
    if (end) end.hidden = hidden === true;
  }

  Hooks.on("oniEventExecuteStart", ({ sceneId, sourceId } = {}) => {
    if (!sourceId || !canvas?.scene || sceneId !== canvas.scene.id) return;
    add(sourceId);
  });

  Hooks.on("oniEventExecuteDone", ({ sourceId } = {}) => remove(sourceId));
  Hooks.on("oniEventProgress", (info = {}) => setProgress(info.sourceId, info));
  Hooks.on("oniEventMarkers", ({ sourceId, markers } = {}) => setMarkers(sourceId, markers));
  Hooks.on("canvasTearDown", removeAll);

  window.oni.EventSystem.GmChip = {
    installed: true,
    setPanel,
    setEndHidden
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.GmChip");
})();
