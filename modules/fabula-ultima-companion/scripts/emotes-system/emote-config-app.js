/**
 * emote-config-app.js
 * Fabula Ultima Companion - Emote System Config App
 * Foundry VTT v12
 *
 * Purpose:
 * - Provide a configuration window for Emote hotkey slots
 * - Let each client assign emotes to Alt + 1~0
 * - Save the mapping through EmoteStore
 *
 * Notes:
 * - This is a client-local configuration window
 * - It does not play emotes directly
 * - It does not install the chat button itself
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_CONFIG_APP__
 *
 * API:
 *   FUCompanion.api.EmoteConfigApp
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_CONFIG_APP__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const STYLE_ID = "oni-emote-config-app-style";

  const state = {
    installed: true,
    ready: false,
    activeDialog: null,
    lastPosition: {
      width: 760,
      height: "auto",
      left: null,
      top: null
    }
  };

  function getDebug() {
    const dbg = globalThis.__ONI_EMOTE_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  function getData() {
    return globalThis.__ONI_EMOTE_DATA__
      ?? globalThis.FUCompanion?.api?.EmoteData
      ?? null;
  }

  function getStore() {
    return globalThis.__ONI_EMOTE_STORE__
      ?? globalThis.FUCompanion?.api?.EmoteStore
      ?? null;
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function deepClone(value) {
    try {
      return foundry.utils.deepClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-emote-config {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .oni-emote-config .oni-emote-config-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .oni-emote-config .oni-emote-config-hint {
        font-size: 12px;
        opacity: 0.85;
        line-height: 1.45;
      }

      .oni-emote-config .oni-emote-config-reset {
        flex: 0 0 auto;
        appearance: none;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px;
        padding: 6px 10px;
        cursor: pointer;
        background: rgba(0,0,0,0.15);
      }

      .oni-emote-config .oni-emote-config-reset:hover {
        filter: brightness(1.06);
      }

      .oni-emote-config .oni-emote-config-grid {
        display: grid;
        grid-template-columns: 110px minmax(240px, 1fr) 90px 140px;
        gap: 8px 10px;
        align-items: center;
      }

      .oni-emote-config .oni-emote-config-head {
        font-weight: 700;
        opacity: 0.9;
        padding-bottom: 4px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
      }

      .oni-emote-config .oni-emote-slot-label {
        font-weight: 700;
      }

      .oni-emote-config .oni-emote-slot-select {
        width: 100%;
      }

      .oni-emote-config .oni-emote-slot-kind {
        font-size: 12px;
        opacity: 0.8;
      }

      .oni-emote-config .oni-emote-slot-url {
        font-size: 11px;
        opacity: 0.72;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

            .oni-emote-config .oni-emote-slot-preview {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .oni-emote-config .oni-emote-preview-media {
        width: 96px;
        height: 64px;
        object-fit: contain;
        border-radius: 6px;
        border: 1px solid rgba(0,0,0,0.15);
        background: rgba(0,0,0,0.06);
        display: block;
      }

      .oni-emote-config .oni-emote-preview-empty {
        width: 96px;
        height: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        opacity: 0.7;
        border-radius: 6px;
        border: 1px dashed rgba(0,0,0,0.15);
        background: rgba(0,0,0,0.04);
      }

      .oni-emote-config .oni-emote-config-footer-note {
        font-size: 11px;
        opacity: 0.72;
      }

      @media (max-width: 760px) {
        .oni-emote-config .oni-emote-config-grid {
          grid-template-columns: 1fr;
        }

        .oni-emote-config .oni-emote-config-head {
          display: none;
        }

        .oni-emote-config .oni-emote-slot-label {
          padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function kindLabel(kind) {
    const clean = cleanString(kind).toLowerCase();
    if (clean === "default") return "Default";
    if (clean === "spare") return "Spare";
    return "Unknown";
  }

  function buildOptionLabel(option) {
    const label = cleanString(option?.label) || "Unknown";
    const kind = kindLabel(option?.kind);
    return `[${kind}] ${label}`;
  }

  function isVideoPreviewUrl(url) {
  const clean = cleanString(url).split("?")[0].toLowerCase();
  return clean.endsWith(".webm") || clean.endsWith(".mp4");
}

function buildPreviewHtml(url, label = "Preview") {
  const cleanUrl = cleanString(url);
  const cleanLabel = cleanString(label) || "Preview";

  if (!cleanUrl) {
    return `<div class="oni-emote-preview-empty">No Preview</div>`;
  }

  if (isVideoPreviewUrl(cleanUrl)) {
    return `
      <video
        class="oni-emote-preview-media"
        src="${escapeHtml(cleanUrl)}"
        autoplay
        loop
        muted
        playsinline
        preload="auto"
        title="${escapeHtml(cleanUrl)}"
      ></video>
    `;
  }

  return `
    <img
      class="oni-emote-preview-media"
      src="${escapeHtml(cleanUrl)}"
      alt="${escapeHtml(cleanLabel)}"
      title="${escapeHtml(cleanUrl)}"
    />
  `;
}

  function buildOptionsHtml(currentUrl, options) {
    const cleanCurrent = cleanString(currentUrl);

    return (options ?? []).map(option => {
      const url = cleanString(option?.url);
      const selected = url === cleanCurrent ? "selected" : "";
      const text = buildOptionLabel(option);

      return `<option value="${escapeHtml(url)}" ${selected}>${escapeHtml(text)}</option>`;
    }).join("");
  }

function buildRowsHtml(slotRows, options) {
  return (slotRows ?? []).map(row => {
    const slot = cleanString(row?.slot);
    const slotLabel = cleanString(row?.slotLabel) || `Alt + ${slot}`;
    const url = cleanString(row?.url);
    const emoteLabel = cleanString(row?.emoteLabel) || "Preview";
    const emoteKind = kindLabel(row?.emoteKind);
    const optionHtml = buildOptionsHtml(url, options);

    return `
      <div class="oni-emote-slot-label">${escapeHtml(slotLabel)}</div>
      <div>
        <select class="oni-emote-slot-select" data-slot="${escapeHtml(slot)}">
          ${optionHtml}
        </select>
      </div>
      <div class="oni-emote-slot-kind" data-slot-kind="${escapeHtml(slot)}">
        ${escapeHtml(emoteKind)}
      </div>
      <div class="oni-emote-slot-preview" data-slot-preview="${escapeHtml(slot)}">
        ${buildPreviewHtml(url, emoteLabel)}
      </div>
    `;
  }).join("");
}

  function buildContent({ slotRows, options }) {
    return `
      <div class="oni-emote-config">
        <div class="oni-emote-config-topbar">
          <div class="oni-emote-config-hint">
            Assign which emote is used for each hotkey.<br/>
            Hotkeys supported: <b>Alt + 1</b> through <b>Alt + 0</b>.
          </div>
          <button type="button" class="oni-emote-config-reset">
            Reset to Default
          </button>
        </div>

        <div class="oni-emote-config-grid">
          <div class="oni-emote-config-head">Hotkey</div>
          <div class="oni-emote-config-head">Assigned Emote</div>
          <div class="oni-emote-config-head">Pool</div>
          <div class="oni-emote-config-head">Preview</div>

          ${buildRowsHtml(slotRows, options)}
        </div>

        <div class="oni-emote-config-footer-note">
          This configuration is saved per client and will persist across game restarts.
        </div>
      </div>
    `;
  }

  async function getViewModel() {
    const data = getData();
    const store = getStore();

    if (!data?.getConfigOptions || !store?.getSlotRows) {
      return {
        ok: false,
        reason: "dependenciesUnavailable",
        slotRows: [],
        options: []
      };
    }

    const [slotRows, options] = await Promise.all([
      store.getSlotRows(),
      Promise.resolve(data.getConfigOptions())
    ]);

    return {
      ok: true,
      reason: "loaded",
      slotRows: deepClone(slotRows ?? []),
      options: deepClone(options ?? [])
    };
  }

  function buildDefaultUrlMap() {
    const data = getData();
    return data?.getDefaultHotkeyMap ? data.getDefaultHotkeyMap() : {};
  }

  function buildOptionMap(options) {
    const map = new Map();

    for (const option of (options ?? [])) {
      const url = cleanString(option?.url);
      if (!url) continue;
      map.set(url, deepClone(option));
    }

    return map;
  }

function refreshRowMeta(html, optionMap) {
  const root = html instanceof jQuery ? html : $(html);

  root.find(".oni-emote-slot-select").each((_, el) => {
    const select = el;
    const slot = cleanString(select.dataset.slot);
    const url = cleanString(select.value);
    const option = optionMap.get(url) ?? null;

    const kind = kindLabel(option?.kind);
    const previewCell = root.find(`[data-slot-preview="${slot}"]`);
    const kindCell = root.find(`[data-slot-kind="${slot}"]`);

    kindCell.text(kind);
    previewCell.html(buildPreviewHtml(url, option?.label ?? "Preview"));

    // Best-effort: force preview videos to start playing
    const videoEl = previewCell.find("video").get(0);
    if (videoEl) {
      videoEl.muted = true;
      videoEl.loop = true;
      videoEl.playsInline = true;
      try {
        videoEl.currentTime = 0;
      } catch (_) {}
      try {
        const playPromise = videoEl.play?.();
        if (playPromise?.catch) {
          playPromise.catch(() => {});
        }
      } catch (_) {}
    }
  });
}

  function applyDefaultSelections(html, optionMap) {
    const root = html instanceof jQuery ? html : $(html);
    const defaults = buildDefaultUrlMap();

    root.find(".oni-emote-slot-select").each((_, el) => {
      const select = el;
      const slot = cleanString(select.dataset.slot);
      const defaultUrl = cleanString(defaults?.[slot]);

      if (!defaultUrl) return;

      const hasMatch = Array.from(select.options ?? []).some(opt => cleanString(opt.value) === defaultUrl);
      if (hasMatch) {
        select.value = defaultUrl;
      }
    });

    refreshRowMeta(root, optionMap);
  }

  function collectHotkeyMapFromHtml(html) {
    const root = html instanceof jQuery ? html : $(html);
    const map = {};

    root.find(".oni-emote-slot-select").each((_, el) => {
      const slot = cleanString(el.dataset.slot);
      const url = cleanString(el.value);

      if (!slot) return;
      map[slot] = url;
    });

    return map;
  }

  async function saveFromHtml(html) {
    const store = getStore();

    if (!store?.setHotkeyMap) {
      ui.notifications?.error?.("Emote config save failed: store is unavailable.");
      return { ok: false, reason: "storeUnavailable" };
    }

    const map = collectHotkeyMapFromHtml(html);

    DBG.groupCollapsed("Config", "Saving Emote config hotkey map", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      map
    });

    const result = await store.setHotkeyMap(map, {
      reason: "configSave"
    });

    if (result?.ok) {
      ui.notifications?.info?.("Emote hotkeys saved.");
    } else {
      ui.notifications?.error?.("Failed to save Emote hotkeys. Check console.");
    }

    return result;
  }

  function captureDialogPosition(dialog) {
    if (!dialog?.position) return;

    state.lastPosition = {
      width: dialog.position.width ?? 760,
      height: dialog.position.height ?? "auto",
      left: dialog.position.left ?? null,
      top: dialog.position.top ?? null
    };
  }

  async function open(options = {}) {
    ensureStyles();

    const viewModel = await getViewModel();
    if (!viewModel.ok) {
      DBG.warn("Config", "Cannot open Emote config because dependencies are unavailable", viewModel);
      ui.notifications?.warn?.("Emote configuration is not available yet.");
      return null;
    }

    try {
      if (state.activeDialog) {
        try {
          captureDialogPosition(state.activeDialog);
          state.activeDialog.close();
        } catch (_) {}
        state.activeDialog = null;
      }
    } catch (_) {}

    const optionMap = buildOptionMap(viewModel.options);
    const content = buildContent(viewModel);

    let dialog = null;

    dialog = new Dialog(
      {
        title: "Emote Configuration",
        content,
        buttons: {
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: "Cancel"
          },
          save: {
            icon: '<i class="fas fa-save"></i>',
            label: "Save",
            callback: async (html) => {
              await saveFromHtml(html);
            }
          }
        },
        default: "save",
        render: (html) => {
          const root = html instanceof jQuery ? html : $(html);

          refreshRowMeta(root, optionMap);

          root.on("change", ".oni-emote-slot-select", () => {
            refreshRowMeta(root, optionMap);
          });

          root.on("click", ".oni-emote-config-reset", (ev) => {
            ev.preventDefault();
            applyDefaultSelections(root, optionMap);
          });

          DBG.verbose("Config", "Rendered Emote config dialog", {
            userId: game.user?.id ?? null,
            userName: game.user?.name ?? null,
            slotCount: viewModel.slotRows.length
          });
        },
        close: () => {
          captureDialogPosition(dialog);
          if (state.activeDialog === dialog) {
            state.activeDialog = null;
          }

          DBG.verbose("Config", "Closed Emote config dialog", {
            userId: game.user?.id ?? null,
            userName: game.user?.name ?? null,
            lastPosition: state.lastPosition
          });
        }
      },
      {
        width: options.width ?? state.lastPosition.width ?? 760,
        height: options.height ?? state.lastPosition.height ?? "auto",
        left: options.left ?? state.lastPosition.left ?? undefined,
        top: options.top ?? state.lastPosition.top ?? undefined,
        resizable: true
      }
    );

    state.activeDialog = dialog;
    dialog.render(true);
    return dialog;
  }

  async function show(options = {}) {
    return await open(options);
  }

  function render(force = true, options = {}) {
    return open({ ...(options ?? {}), force });
  }

  function close() {
    if (!state.activeDialog) return false;

    try {
      captureDialogPosition(state.activeDialog);
      state.activeDialog.close();
      state.activeDialog = null;
      return true;
    } catch (err) {
      DBG.warn("Config", "Failed to close active Emote config dialog", {
        error: err?.message ?? err
      });
      return false;
    }
  }

  function getSnapshot() {
    return {
      installed: true,
      ready: state.ready,
      hasActiveDialog: !!state.activeDialog,
      lastPosition: deepClone(state.lastPosition),
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    open,
    show,
    render,
    close,

    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteConfigApp = api;
    } catch (err) {
      console.warn("[Emote:Config] Failed to attach API to FUCompanion.api", err);
    }

    state.ready = true;

    DBG.verbose("Bootstrap", "emote-config-app.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      snapshot: getSnapshot()
    });
  });
})();