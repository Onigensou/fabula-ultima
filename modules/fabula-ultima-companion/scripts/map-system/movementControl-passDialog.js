/**
 * movementControl-passDialog.js
 * Fabula Ultima Companion - Movement Control Pass Controller Fan-Out UI
 * Foundry VTT v12
 *
 * Purpose:
 * - Mount a small "Pass" button beside the controller badge
 * - Remove the old dialog window flow entirely
 * - Fan out vertically from the controller badge using badge-style buttons
 * - Dynamically choose upward or downward fan direction based on screen space
 * - Let the current Main Controller or GM override click a player badge to pass control
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_PASS_DIALOG__
 *
 * API:
 *   FUCompanion.api.MovementControlPassDialog
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_PASS_DIALOG__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";

  const STYLE_ID = "oni-movement-control-pass-dialog-style";
  const BUTTON_ID = "oni-movement-control-pass-button";
  const MENU_ID = "oni-movement-control-pass-menu";

  const state = {
    installed: true,
    ready: false,
    destroyed: false,

    button: null,
    menu: null,
    mountedHost: null,
    mountedRoot: null,

    isOpen: false,
    currentDirection: "down",
    passInFlight: false,

    refreshTimer: null,
    boundDocPointerDown: null,
    boundKeyDown: null
  };

  function shouldFreezeMenuRefresh(reason = "scheduled") {
    if (!state.isOpen) return false;

    const allowedReasons = new Set([
      "performPassSuccess",
      "performPassFailed",
      "performPassException",
      "inactive",
      "destroy"
    ]);

    return !allowedReasons.has(String(reason || ""));
  }

  function getDebug() {
    const dbg = globalThis.__ONI_MOVEMENT_CONTROL_DEBUG__;
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

  function getMovementAPI() {
    return globalThis.__ONI_MOVEMENT_CONTROL_API__
      ?? globalThis.FUCompanion?.api?.MovementControl
      ?? null;
  }

  function getBadgeAPI() {
    return globalThis.__ONI_MOVEMENT_CONTROL_CONTROLLER_BADGE__
      ?? globalThis.FUCompanion?.api?.MovementControlControllerBadge
      ?? null;
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function safeGet(obj, path, fallback = undefined) {
    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  function getSceneCameraFollowEnabled(scene) {
    const fab = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];
    const raw = safeGet(fab, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);

    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }

    return false;
  }

  function isActiveForScene() {
    return !!canvas?.ready && !!canvas?.scene && getSceneCameraFollowEnabled(canvas.scene);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.16);
        background:
          linear-gradient(180deg, rgba(94, 88, 46, 0.98) 0%, rgba(71, 65, 31, 0.98) 100%);
        color: #fff8dc;
        min-height: 32px;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1;
        cursor: pointer;
        box-shadow:
          0 6px 16px rgba(0,0,0,0.24),
          inset 0 1px 0 rgba(255,255,255,0.08);
        pointer-events: auto;
        transition:
          transform 100ms ease,
          filter 100ms ease,
          opacity 100ms ease;
      }

      #${BUTTON_ID}:hover {
        filter: brightness(1.08);
        transform: translateY(-1px);
      }

      #${BUTTON_ID}:active {
        transform: translateY(0);
        filter: brightness(0.98);
      }

      #${BUTTON_ID}.is-open {
        filter: brightness(1.08);
      }

      #${BUTTON_ID}[hidden] {
        display: none !important;
      }

      #${MENU_ID} {
        position: absolute;
        left: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: max-content;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        z-index: 1;
      }

      #${MENU_ID}.fan-down {
        top: calc(100% + 8px);
        bottom: auto;
      }

      #${MENU_ID}.fan-up {
        bottom: calc(100% + 8px);
        top: auto;
      }

      #${MENU_ID}.is-open {
        pointer-events: auto;
        opacity: 1;
        visibility: visible;
      }

      #${MENU_ID} .oni-mc-pass-option {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.16);
        background:
          linear-gradient(180deg, rgba(41, 153, 86, 0.98) 0%, rgba(23, 112, 60, 0.98) 100%);
        color: #f4fff7;
        min-height: 32px;
        padding: 6px 12px;
        border-radius: 999px;
        box-shadow:
          0 6px 16px rgba(0,0,0,0.28),
          inset 0 1px 0 rgba(255,255,255,0.10);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1;
        white-space: nowrap;
        text-align: left;
        text-shadow: 0 1px 1px rgba(0,0,0,0.35);
        backdrop-filter: blur(2px);
        cursor: pointer;
        pointer-events: auto;
        opacity: 0;
        transform: translateY(var(--mc-offset, 8px)) scale(0.985);
        transition:
          opacity 150ms ease,
          transform 170ms ease,
          filter 100ms ease;
        transition-delay: calc(var(--mc-index, 0) * 26ms);
      }

      #${MENU_ID}.fan-up .oni-mc-pass-option {
        --mc-offset: 8px;
      }

      #${MENU_ID}.fan-down .oni-mc-pass-option {
        --mc-offset: -8px;
      }

      #${MENU_ID}.is-open .oni-mc-pass-option {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      #${MENU_ID} .oni-mc-pass-option:hover {
        filter: brightness(1.08);
      }

      #${MENU_ID} .oni-mc-pass-option:active {
        filter: brightness(0.98);
      }

      /* Connected open/close animation for the main controller row */
      #oni-movement-control-badge-root .mc-controller-row {
        transition:
          transform 180ms ease,
          filter 180ms ease;
        transform-origin: left center;
      }

      #oni-movement-control-badge-root.mc-pass-menu-open .mc-controller-row {
        transform: translateY(var(--mc-row-shift, 0px));
        filter: drop-shadow(0 4px 10px rgba(0,0,0,0.18));
      }

      #oni-movement-control-badge-root .mc-controller-badge {
        transition:
          transform 180ms ease,
          box-shadow 180ms ease,
          filter 180ms ease;
        transform-origin: left center;
      }

      #oni-movement-control-badge-root.mc-pass-menu-open .mc-controller-badge {
        transform: scale(1.02);
        box-shadow:
          0 8px 18px rgba(0,0,0,0.30),
          inset 0 1px 0 rgba(255,255,255,0.10),
          0 0 0 1px rgba(255,255,255,0.06);
        filter: brightness(1.03);
      }

      #oni-movement-control-badge-root .mc-controller-slot {
        transition: transform 180ms ease;
        transform-origin: left center;
      }

      #oni-movement-control-badge-root.mc-pass-menu-open .mc-controller-slot {
        transform: translateX(2px);
      }
    `;
    document.head.appendChild(style);
  }

  function ensureButton() {
    ensureStyles();

    if (state.button?.isConnected) return state.button;

    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();

    const button = document.createElement("button");
    button.type = "button";
    button.id = BUTTON_ID;
    button.textContent = "Pass";
    button.hidden = true;
    button.addEventListener("click", onPassButtonClick);

    state.button = button;
    return button;
  }

  function ensureMenu() {
    ensureStyles();

    if (state.menu?.isConnected) return state.menu;

    const existing = document.getElementById(MENU_ID);
    if (existing) existing.remove();

    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.className = "fan-down";
    menu.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
    });

    state.menu = menu;
    return menu;
  }

  function mountUi() {
    const badgeAPI = getBadgeAPI();
    const host = badgeAPI?.getHostElement?.() ?? null;
    const root = badgeAPI?.getRootElement?.() ?? null;

    const button = ensureButton();
    const menu = ensureMenu();

    if (!host || !root) {
      return false;
    }

    if (state.mountedHost !== host || !button.isConnected) {
      host.appendChild(button);
      state.mountedHost = host;
    }

    if (state.mountedRoot !== root || !menu.isConnected) {
      root.appendChild(menu);
      state.mountedRoot = root;
    }

    return true;
  }

  function unmountUi() {
    try { state.button?.remove(); } catch (_) {}
    try { state.menu?.remove(); } catch (_) {}
    state.mountedHost = null;
    state.mountedRoot = null;
  }

  function setButtonVisible(visible) {
    const button = ensureButton();
    button.hidden = !visible;
  }

  function setButtonEnabled(enabled) {
    const button = ensureButton();
    button.disabled = !enabled;
    button.style.opacity = enabled ? "1" : "0.65";
    button.style.cursor = enabled ? "pointer" : "default";
  }

  async function getUiState() {
    const api = getMovementAPI();
    if (!api) {
      return {
        active: false,
        canPass: false,
        canPassReason: "apiUnavailable",
        currentController: null,
        eligibleControllers: []
      };
    }

    if (!isActiveForScene()) {
      return {
        active: false,
        canPass: false,
        canPassReason: "sceneInactive",
        currentController: null,
        eligibleControllers: []
      };
    }

    try {
      const currentController = await api.getCurrentControllerUser();
      const canPass = await api.canCurrentUserPassControl();
      const eligibleControllers = await api.getEligibleControllers({
        onlineOnly: true,
        includeGM: false
      });

      const filteredEligible = (eligibleControllers ?? []).filter(row => {
        return cleanString(row?.userId) !== cleanString(currentController?.userId);
      });

      return {
        active: true,
        canPass: !!canPass?.ok,
        canPassReason: canPass?.reason ?? "unknown",
        currentController,
        eligibleControllers: filteredEligible
      };
    } catch (err) {
      DBG.warn("PassDialog", "Failed to build UI state", {
        error: err?.message ?? err
      });

      return {
        active: true,
        canPass: false,
        canPassReason: "uiStateError",
        currentController: null,
        eligibleControllers: []
      };
    }
  }

  function clearMenuItems() {
    const menu = ensureMenu();
    menu.innerHTML = "";
  }

  function setMainBadgeOpenVisual(isOpen) {
    const badgeAPI = getBadgeAPI();
    const root = badgeAPI?.getRootElement?.() ?? null;

    if (!root) return;

    const direction = state.currentDirection === "up" ? "up" : "down";

    // Small opposite nudge so the row feels like it is "making space"
    root.style.setProperty("--mc-row-shift", direction === "up" ? "2px" : "-2px");
    root.classList.toggle("mc-pass-menu-open", !!isOpen);
  }

  function closeMenu(reason = "manual") {
    const menu = ensureMenu();
    const button = ensureButton();

    state.isOpen = false;
    menu.classList.remove("is-open");
    button.classList.remove("is-open");
    setMainBadgeOpenVisual(false);

    DBG.verbose("PassDialog", "Fan-out menu closed", { reason });
  }

  function updateMenuDirection(estimatedMenuHeight = 0) {
    const badgeAPI = getBadgeAPI();
    const menu = ensureMenu();

    const direction = badgeAPI?.getFanDirection?.(estimatedMenuHeight) ?? "down";
    state.currentDirection = direction;

    menu.classList.remove("fan-up", "fan-down");
    menu.classList.add(direction === "up" ? "fan-up" : "fan-down");
  }

  function buildOptionLabel(row) {
    return cleanString(row?.userName) || "Unknown";
  }

  function renderMenuItems(uiState) {
    const menu = ensureMenu();
    clearMenuItems();

    const rows = Array.isArray(uiState?.eligibleControllers) ? uiState.eligibleControllers : [];

    rows.forEach((row, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oni-mc-pass-option";
      btn.style.setProperty("--mc-index", String(index));
      btn.textContent = buildOptionLabel(row);
      btn.title = buildOptionLabel(row);

      btn.addEventListener("pointerdown", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        if (state.passInFlight) {
          DBG.verbose("PassDialog", "Ignoring option press because a pass is already in flight", {
            targetUserId: row?.userId ?? null,
            targetUserName: row?.userName ?? null
          });
          return;
        }

        DBG.verbose("PassDialog", "Pass option pressed", {
          targetUserId: row?.userId ?? null,
          targetUserName: row?.userName ?? null
        });

        state.passInFlight = true;

        try {
          closeMenu("optionSelected");
          await performPass(row?.userId);
        } finally {
          state.passInFlight = false;
        }
      });

      menu.appendChild(btn);
    });

    return rows.length;
  }

  async function openMenu() {
    const mounted = mountUi();
    if (!mounted) return;

    const uiState = await getUiState();
    if (!uiState.active || !uiState.canPass) {
      closeMenu("openDenied");
      return;
    }

    if (!Array.isArray(uiState.eligibleControllers) || uiState.eligibleControllers.length === 0) {
      ui.notifications?.warn("No other eligible player is available to receive control.");
      closeMenu("noTargets");
      return;
    }

    const menu = ensureMenu();
    const button = ensureButton();

    renderMenuItems(uiState);

    updateMenuDirection(0);
    menu.classList.add("is-open");
    button.classList.add("is-open");

    const measuredHeight = menu.offsetHeight || 0;
    updateMenuDirection(measuredHeight);

    state.isOpen = true;
    setMainBadgeOpenVisual(true);

    DBG.verbose("PassDialog", "Fan-out menu opened", {
      direction: state.currentDirection,
      targetCount: uiState.eligibleControllers.length
    });
  }

  async function toggleMenu() {
    if (state.isOpen) {
      closeMenu("toggleClose");
      return;
    }
    await openMenu();
  }

  async function performPass(targetUserId) {
    const api = getMovementAPI();
    if (!api) {
      ui.notifications?.warn("Movement Control API is not available.");
      return { ok: false, reason: "apiUnavailable" };
    }

    const cleanTargetUserId = cleanString(targetUserId);
    if (!cleanTargetUserId) {
      ui.notifications?.warn("Please choose a target player.");
      return { ok: false, reason: "missingTargetUserId" };
    }

    DBG.verbose("PassDialog", "performPass started", {
      targetUserId: cleanTargetUserId,
      currentUserId: game.user?.id ?? null,
      currentUserName: game.user?.name ?? null,
      isGM: !!game.user?.isGM
    });

    try {
      let result = null;

      if (game.user?.isGM) {
        result = await api.forceSetController(cleanTargetUserId, {
          source: "passFanMenuGM"
        });
      } else {
        result = await api.requestPassController(cleanTargetUserId, {
          source: "passFanMenuPlayer"
        });
      }

      if (!result?.ok) {
        const reason = cleanString(result?.reason) || "requestFailed";
        ui.notifications?.warn(`Could not pass control. (${reason})`);

        DBG.warn("PassDialog", "performPass failed", {
          targetUserId: cleanTargetUserId,
          result
        });

        scheduleRefresh("performPassFailed", 120);
        return result;
      }

      if (game.user?.isGM) {
        ui.notifications?.info("Main Controller updated.");
      } else {
        ui.notifications?.info("Controller pass request sent.");
      }

      DBG.verbose("PassDialog", "performPass succeeded", {
        targetUserId: cleanTargetUserId,
        result
      });

      scheduleRefresh("performPassSuccess", 150);
      return result;
    } catch (err) {
      ui.notifications?.error("Failed to pass control.");
      DBG.error("PassDialog", "performPass threw an error", {
        targetUserId: cleanTargetUserId,
        error: err?.message ?? err
      });

      scheduleRefresh("performPassException", 150);
      return { ok: false, reason: "exception", error: err };
    }
  }

  async function onPassButtonClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    DBG.verbose("PassDialog", "Pass button pressed", {
      isOpen: state.isOpen
    });

    await toggleMenu();
  }

  function installGlobalListeners() {
    if (!state.boundDocPointerDown) {
      state.boundDocPointerDown = (ev) => {
        if (!state.isOpen) return;

        const target = ev.target;
        if (state.button?.contains(target)) return;
        if (state.menu?.contains(target)) return;

        closeMenu("outsideClick");
      };

      document.addEventListener("pointerdown", state.boundDocPointerDown, true);
    }

    if (!state.boundKeyDown) {
      state.boundKeyDown = (ev) => {
        if (!state.isOpen) return;
        if (ev.key === "Escape") {
          closeMenu("escape");
        }
      };

      document.addEventListener("keydown", state.boundKeyDown, true);
    }
  }

  function removeGlobalListeners() {
    if (state.boundDocPointerDown) {
      document.removeEventListener("pointerdown", state.boundDocPointerDown, true);
      state.boundDocPointerDown = null;
    }

    if (state.boundKeyDown) {
      document.removeEventListener("keydown", state.boundKeyDown, true);
      state.boundKeyDown = null;
    }
  }

  async function refresh({ reason = "manual" } = {}) {
    if (state.destroyed) return;

    const mounted = mountUi();
    if (!mounted) {
      setButtonVisible(false);
      closeMenu("mountFailed");
      return;
    }

    const uiState = await getUiState();

    if (!uiState.active) {
      setButtonVisible(false);
      closeMenu("inactive");
      return;
    }

    const shouldShow = uiState.canPass;
    const hasTargets = (uiState.eligibleControllers?.length ?? 0) > 0;

    setButtonVisible(shouldShow);
    setButtonEnabled(shouldShow && hasTargets);

    if (state.button) {
      if (!hasTargets && shouldShow) {
        state.button.title = "No other eligible player is available right now.";
      } else if (uiState.canPassReason === "gmOverride") {
        state.button.title = "GM override: pass control to another eligible player.";
      } else {
        state.button.title = "Pass main controller status to another eligible player.";
      }
    }

    if (state.isOpen) {
      if (!shouldShow || !hasTargets) {
        closeMenu("refreshInvalidated");
      } else {
        DBG.verbose("PassDialog", "Menu refresh skipped while open to prevent DOM rebuild", {
          reason,
          eligibleCount: uiState.eligibleControllers?.length ?? 0
        });
      }
      return;
    }

    DBG.verbose("PassDialog", "Pass fan-out UI refreshed", {
      reason,
      shouldShow,
      hasTargets,
      currentDirection: state.currentDirection,
      eligibleCount: uiState.eligibleControllers?.length ?? 0
    });
  }

  function scheduleRefresh(reason = "scheduled", delay = 0) {
    if (state.destroyed) return;

    if (shouldFreezeMenuRefresh(reason)) {
      DBG.verbose("PassDialog", "Skipping scheduled refresh because fan menu is open", {
        reason
      });
      return;
    }

    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      refresh({ reason });
    }, Math.max(0, Number(delay) || 0));
  }

  function destroy() {
    state.destroyed = true;

    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;

    closeMenu("destroy");
    setMainBadgeOpenVisual(false);
    removeGlobalListeners();
    unmountUi();

    state.button = null;
    state.menu = null;
    state.mountedHost = null;
    state.mountedRoot = null;

    DBG.verbose("PassDialog", "Pass fan-out UI destroyed");
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    refresh,
    scheduleRefresh,
    openMenu,
    closeMenu,
    destroy
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlPassDialog = api;
    } catch (err) {
      console.warn("[MovementControl:PassDialog] Failed to attach API to FUCompanion.api", err);
    }

    installGlobalListeners();

    state.ready = true;
    scheduleRefresh("ready", 100);

    DBG.verbose("PassDialog", "movementControl-passDialog.js ready", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });

  Hooks.on("canvasReady", () => {
    scheduleRefresh("canvasReady", 80);
  });

  Hooks.on("renderPlayerList", () => {
    scheduleRefresh("renderPlayerList", 40);
  });

  Hooks.on("updateScene", (scene) => {
    if (scene?.id !== canvas?.scene?.id) return;
    scheduleRefresh("updateScene", 40);
  });

  Hooks.on("updateActor", () => {
    scheduleRefresh("updateActor", 40);
  });

  Hooks.on("updateUser", () => {
    scheduleRefresh("updateUser", 40);
  });

  Hooks.on("controlToken", () => {
    scheduleRefresh("controlToken", 40);
  });

  window.addEventListener("resize", () => {
    scheduleRefresh("windowResize", 20);
  });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();
