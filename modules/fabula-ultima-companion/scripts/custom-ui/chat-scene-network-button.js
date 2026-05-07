// ============================================================================
// ONI — Chat Sidebar "Scene Network Switch" Button (Foundry VTT v12) — Module Script
// ----------------------------------------------------------------------------
// Adds a GM-only icon button to the bottom-right of the chat input bar.
// Click => opens "Scene Network Switcher" dialog (reads current scene links).
//
// Refactor note:
// - This file NO LONGER performs self-layout
// - Shared positioning is handled only by chat-button-final-layout.js
// ============================================================================

(() => {
  const GLOBAL_KEY = "__ONI_CHAT_SCENE_NETWORK_BUTTON__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const CFG = {
    DEBUG: false,

    MODULE_ID: "fabula-ultima-companion",

    BUTTON_ID: "oni-chat-scene-network-btn",
    STYLE_ID: "oni-chat-scene-network-btn-style",

    IMG_URL: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/door.png",

    SIZE_PX: 30,
    BASE_RIGHT_PX: 6,
    BASE_BOTTOM_PX: 6,

    USE_PRELOAD: true,
    PRELOAD_NOTIFY: false,
    PRELOAD_PAUSE_MS: 150,

    DIALOG_WIDTH: 980,
    GRID_MAX_HEIGHT: 680
  };

  const state = {
    installed: true,
    ready: false
  };

  const LOG_TAG = "[ONI SceneNetBtn]";
  const DBG_TAG = "[ONI SceneNetBtn][DBG]";

  const log = (...args) => console.log(LOG_TAG, ...args);
  const debugLog = (...args) => {
    if (!CFG.DEBUG) return;
    console.log(DBG_TAG, ...args);
  };
  const debugWarn = (...args) => {
    if (!CFG.DEBUG) return;
    console.warn(DBG_TAG, ...args);
  };

  function getChatForm() {
    return document.querySelector("#chat-form");
  }

  function getLayoutManager() {
    return globalThis.__ONI_CHAT_BUTTON_FINAL_LAYOUT__ ?? null;
  }

  function requestSharedLayout(reason = "manual", delay = 0) {
    const manager = getLayoutManager();

    if (!manager) {
      debugWarn("Shared layout manager not found.", { reason, delay });
      return false;
    }

    if (typeof manager.requestLayout === "function") {
      debugLog("Requesting shared layout via requestLayout().", { reason, delay });
      return manager.requestLayout(reason, delay);
    }

    if (typeof manager.scheduleLayout === "function") {
      debugLog("Requesting shared layout via scheduleLayout().", { reason, delay });
      return manager.scheduleLayout(delay, { reason });
    }

    debugWarn("Shared layout manager found, but no request API was available.", {
      reason,
      delay,
      managerKeys: Object.keys(manager)
    });

    return false;
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) {
      debugLog("CSS already present.");
      return;
    }

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Scene Network Button (GM only) ========== */
#chat-form { position: relative; }

#${CFG.BUTTON_ID} {
  width: ${CFG.SIZE_PX}px;
  height: ${CFG.SIZE_PX}px;
  min-width: ${CFG.SIZE_PX}px;
  min-height: ${CFG.SIZE_PX}px;

  position: absolute;
  right: ${CFG.BASE_RIGHT_PX}px;
  bottom: ${CFG.BASE_BOTTOM_PX}px;
  z-index: 20;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  padding: 0;
  margin: 0;

  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(0,0,0,0.35);
  box-shadow: 0 1px 2px rgba(0,0,0,0.35);
  cursor: pointer;
}

#${CFG.BUTTON_ID}:hover {
  filter: brightness(1.12);
  background: rgba(0,0,0,0.48);
}

#${CFG.BUTTON_ID}:active {
  transform: translateY(1px);
}

#${CFG.BUTTON_ID} img {
  width: 22px;
  height: 22px;
  display: block;
  pointer-events: none;
}
`;
    document.head.appendChild(style);
    debugLog("Injected CSS.");
  }

  // ---------------------------------------------------------------------------
  // Button injection (GM only)
  // ---------------------------------------------------------------------------
  function ensureButton() {
    if (!game.user?.isGM) {
      debugWarn("ensureButton() ignored because current user is not GM.");
      return false;
    }

    const existing = document.getElementById(CFG.BUTTON_ID);
    if (existing) {
      debugLog("Button already exists.");
      return true;
    }

    const chatForm = getChatForm();
    if (!chatForm) {
      debugWarn("ensureButton() failed because #chat-form was not found.");
      return false;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = CFG.BUTTON_ID;
    btn.title = "Scene Network";
    btn.setAttribute("aria-label", "Open Scene Network");

    const img = document.createElement("img");
    img.src = CFG.IMG_URL;
    img.alt = "Scene Network";

    btn.appendChild(img);
    btn.addEventListener("click", () => openSceneNetworkSwitcher());

    chatForm.appendChild(btn);

    debugLog("Button created and appended.", {
      buttonId: CFG.BUTTON_ID,
      chatFormId: chatForm.id ?? null
    });

    return true;
  }

  function installOrReattach() {
    if (!game.user?.isGM) return false;

    injectCss();

    const ok = ensureButton();
    if (!ok) {
      debugWarn("installOrReattach() aborted because button could not be ensured.");
      return false;
    }

    requestSharedLayout("sceneNetworkButtonInstallImmediate", 0);
    requestSharedLayout("sceneNetworkButtonInstallWarm50", 50);
    requestSharedLayout("sceneNetworkButtonInstallWarm150", 150);

    log("Button ready (shared-layout mode).");
    return true;
  }

  // ---------------------------------------------------------------------------
  // Scene Network Switcher (dialog)
  // ---------------------------------------------------------------------------
  async function openSceneNetworkSwitcher() {
    if (!game.user?.isGM) return;

    const currentScene = canvas?.scene;
    if (!currentScene) {
      ui.notifications?.error?.("Scene Network: No active scene found.");
      debugWarn("Open failed because there is no active scene.");
      return;
    }

    const fabulaData = await currentScene.getFlag(CFG.MODULE_ID, "oniFabula") || {};
    const rawNetwork = fabulaData.sceneNetwork ?? "[]";

    let links = [];
    try {
      links = Array.isArray(rawNetwork) ? rawNetwork : JSON.parse(String(rawNetwork || "[]"));
    } catch (e) {
      console.warn("[SceneNetworkSwitcher] Failed to parse sceneNetwork JSON:", rawNetwork, e);
      ui.notifications?.error?.("Scene Network: sceneNetwork data is invalid JSON.");
      return;
    }

    links = (links || [])
      .map(r => ({ name: String(r?.name ?? "").trim(), id: String(r?.id ?? "").trim() }))
      .filter(r => r.name || r.id);

    if (!links.length) {
      ui.notifications?.info?.("Scene Network: No linked scenes found on this scene.");
      debugLog("No linked scenes found for current scene.", {
        currentSceneId: currentScene.id ?? null,
        currentSceneName: currentScene.name ?? null
      });
      return;
    }

    async function resolveSceneById(idString) {
      const id = String(idString || "").trim();
      if (!id) return null;

      try {
        if (id.startsWith("Scene.") || id.includes(".")) {
          const doc = await fromUuid(id);
          if (doc?.documentName === "Scene") return doc;
        }
      } catch (_) {}

      const byId = game.scenes?.get(id);
      if (byId) return byId;

      const byName = game.scenes?.find(s => s?.name === id);
      if (byName) return byName;

      return null;
    }

    function sceneThumb(scene) {
      return scene?.thumb ?? scene?.thumbnail ?? scene?.img ?? "icons/svg/map.svg";
    }

    function escapeHtml(str) {
      return String(str ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    const resolved = [];
    for (const link of links) {
      const target = await resolveSceneById(link.id);
      resolved.push({
        displayName: link.name || target?.name || "(Unnamed)",
        idInput: link.id,
        scene: target,
        thumb: target ? sceneThumb(target) : "icons/svg/hazard.svg",
        ok: !!target
      });
    }

    debugLog("Resolved scene network entries.", {
      currentSceneId: currentScene.id ?? null,
      currentSceneName: currentScene.name ?? null,
      totalLinks: links.length,
      resolvedCount: resolved.filter(r => r.ok).length
    });

    if (!resolved.some(r => r.ok)) {
      ui.notifications?.error?.("Scene Network: None of the linked IDs match any Scene.");
      console.warn("[SceneNetworkSwitcher] All linked scenes missing:", resolved);
      return;
    }

    let selectedIndex = -1;

    function setSelected(htmlRoot, idx) {
      const items = htmlRoot.find(".oni-net-item");
      items.removeClass("selected").attr("aria-pressed", "false");

      const target = htmlRoot.find(`.oni-net-item[data-index="${idx}"]`);
      if (!target.length) return;

      target.addClass("selected").attr("aria-pressed", "true");
      selectedIndex = Number(idx);
    }

    function getSelectedEntry(htmlRoot) {
      if (selectedIndex >= 0 && resolved[selectedIndex]) return resolved[selectedIndex];

      const selectedEl = htmlRoot.find(".oni-net-item.selected").first();
      if (!selectedEl.length) return null;

      const idx = Number(selectedEl.attr("data-index"));
      if (Number.isNaN(idx)) return null;
      return resolved[idx] ?? null;
    }

    const style = `
      <style>
        .oni-net-dialog { display: flex; flex-direction: column; gap: 10px; }
        .oni-net-hint { opacity: .85; font-size: 12px; }

        .oni-net-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          max-height: ${CFG.GRID_MAX_HEIGHT}px;
          overflow: auto;
          padding-right: 4px;
        }

        .oni-net-item {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 10px;
          border-radius: 12px;
          border: 2px solid var(--color-border-light-primary, #9993);
          background: rgba(0,0,0,0.02);
          cursor: pointer;
          user-select: none;
          transition: filter 0.08s ease, box-shadow 0.08s ease;
        }

        .oni-net-item:hover { filter: brightness(1.03); }
        .oni-net-item:active { filter: brightness(0.98); }

        .oni-net-item.disabled {
          opacity: .45;
          filter: grayscale(0.6);
          cursor: not-allowed;
        }

        .oni-net-item.selected {
          border-color: var(--color-border-highlight, #d9d7cb);
          box-shadow: 0 0 0 2px var(--color-border-highlight, #d9d7cb) inset;
          background: rgba(217,215,203,0.10);
        }

        .oni-net-thumb {
          width: 100%;
          height: 170px;
          object-fit: cover;
          border-radius: 10px;
          border: 1px solid var(--color-border-light-primary, #9993);
          background: rgba(0,0,0,0.03);
        }

        .oni-net-name { font-weight: 700; line-height: 1.1; font-size: 14px; }
        .oni-net-sub  { opacity: .75; font-size: 11px; margin-top: 4px; word-break: break-all; }

        @media (max-width: 820px) {
          .oni-net-grid { grid-template-columns: 1fr; }
          .oni-net-thumb { height: 190px; }
        }
      </style>
    `;

    const itemsHtml = resolved.map((r, idx) => {
      const disabledClass = r.ok ? "" : "disabled";
      const label = escapeHtml(r.displayName);
      const idLine = escapeHtml(r.idInput || "(no id)");
      const thumb = escapeHtml(r.thumb);

      return `
        <div class="oni-net-item ${disabledClass}" data-index="${idx}" role="button" aria-pressed="false" tabindex="0">
          <img class="oni-net-thumb" src="${thumb}" />
          <div>
            <div class="oni-net-name">${label}</div>
            <div class="oni-net-sub">ID: ${idLine}${r.ok ? "" : " (not found)"}</div>
          </div>
        </div>
      `;
    }).join("");

    const content = `
      ${style}
      <div class="oni-net-dialog">
        <div class="oni-net-hint">
          Current Scene: <b>${escapeHtml(currentScene.name)}</b><br/>
          Click a scene card to select it, then press <b>Switch Scene</b>.
        </div>
        <div class="oni-net-grid">
          ${itemsHtml}
        </div>
      </div>
    `;

    const dlg = new Dialog({
      title: "Scene Network — Switch Scene",
      content,
      buttons: {
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" },
        go: {
          icon: '<i class="fas fa-exchange-alt"></i>',
          label: "Switch Scene",
          callback: async (html) => {
            const entry = getSelectedEntry(html);
            if (!entry) return ui.notifications?.warn?.("Pick a scene first.");
            if (!entry.scene) return ui.notifications?.error?.("That linked scene could not be found.");

            const targetScene = entry.scene;

            debugLog("Scene switch requested.", {
              fromSceneId: currentScene.id ?? null,
              fromSceneName: currentScene.name ?? null,
              targetSceneId: targetScene.id ?? null,
              targetSceneName: targetScene.name ?? null
            });

            if (CFG.USE_PRELOAD) {
              try {
                if (CFG.PRELOAD_NOTIFY) ui.notifications?.info?.(`Preloading: ${targetScene.name}…`);
                await game.scenes.preload(targetScene.id);
                await wait(CFG.PRELOAD_PAUSE_MS);
              } catch (e) {
                console.warn("[SceneNetworkSwitcher] Preload failed (continuing anyway):", e);
                ui.notifications?.warn?.("Preload failed (continuing). Check console if you see hitching.");
              }
            }

            try {
              await targetScene.activate();
              await targetScene.view();
              ui.notifications?.info?.(`Switched to: ${targetScene.name}`);

              debugLog("Scene switch completed.", {
                targetSceneId: targetScene.id ?? null,
                targetSceneName: targetScene.name ?? null
              });
            } catch (e) {
              console.error("[SceneNetworkSwitcher] Activate/View failed:", e);
              ui.notifications?.error?.("Failed to switch scenes. Check console.");
            }
          }
        }
      },
      default: "go",
      render: (html) => {
        const firstOkIndex = resolved.findIndex(r => r.ok);
        if (firstOkIndex >= 0) setSelected(html, firstOkIndex);

        html.on("click", ".oni-net-item", (ev) => {
          const el = $(ev.currentTarget);
          if (el.hasClass("disabled")) return;
          const idx = Number(el.attr("data-index"));
          if (!Number.isNaN(idx)) setSelected(html, idx);
        });

        html.on("keydown", ".oni-net-item", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          const el = $(ev.currentTarget);
          if (el.hasClass("disabled")) return;
          const idx = Number(el.attr("data-index"));
          if (!Number.isNaN(idx)) setSelected(html, idx);
        });
      }
    }, { width: CFG.DIALOG_WIDTH });

    dlg.render(true);
  }

  function destroy() {
    try {
      document.getElementById(CFG.BUTTON_ID)?.remove();
    } catch (_) {}

    debugLog("Button destroyed.");
  }

  function getSnapshot() {
    const btn = document.getElementById(CFG.BUTTON_ID);

    return {
      installed: true,
      ready: state.ready,
      isGM: !!game.user?.isGM,
      buttonPresent: !!btn,
      buttonId: CFG.BUTTON_ID,
      buttonRight: btn?.style?.right ?? null,
      buttonBottom: btn?.style?.bottom ?? null,
      hasLayoutManager: !!getLayoutManager()
    };
  }

  const api = {
    installed: true,
    CFG,

    installOrReattach,
    requestSharedLayout,
    openSceneNetworkSwitcher,
    destroy,
    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    if (!game.user?.isGM) return;

    installOrReattach();
    state.ready = true;

    window.oni = window.oni || {};
    window.oni.SceneNetworkSwitcher = { open: openSceneNetworkSwitcher };

    debugLog("Ready snapshot.", getSnapshot());
  });

  Hooks.on("renderSidebarTab", () => {
    if (!game.user?.isGM) return;
    installOrReattach();
  });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();