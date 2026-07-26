/**
 * movementControl-controllerBadge.js
 * Fabula Ultima Companion - Movement Control Controller Badge UI
 * Foundry VTT v12
 *
 * Purpose:
 * - Show the current Main Controller as a small green badge
 * - Position the badge above the Foundry Player tab at bottom-left
 * - Reposition when the Player tab rerenders, resizes, or moves
 * - Expose root/layout helpers for other UI layers like the pass menu
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_CONTROLLER_BADGE__
 *
 * API:
 *   FUCompanion.api.MovementControlControllerBadge
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_CONTROLLER_BADGE__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";
  const SCENE_MODE_KEY = "sceneMode";

  const ROOT_ID = "oni-movement-control-badge-root";
  const STYLE_ID = "oni-movement-control-badge-style";

  const state = {
    installed: true,
    ready: false,

    root: null,
    row: null,
    badge: null,
    label: null,
    slot: null,

    resizeObserver: null,
    mutationObserver: null,
    observedPlayerEl: null,

    refreshTimer: null,
    positionTimer: null,
    destroyed: false,

    // True while the badge is docked above the dungeon/exploration control row
    // (fixed bottom-left slot) instead of anchored to the #players list. Used to
    // force the Pass fan-out to open upward into the empty canvas.
    docked: false
  };

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
    return globalThis.__ONI_MOVEMENT_CONTROL_API__ ?? globalThis.FUCompanion?.api?.MovementControl ?? null;
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

    const sceneMode = safeGet(fab, `${GENERAL_KEY}.${SCENE_MODE_KEY}`, null);
    if (sceneMode === "dungeon")     return false;
    if (sceneMode === "exploration") return true;
    if (sceneMode === "none")        return false;

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

  // Whether the Main Controller concept (badge + pass hand-off) is active for a
  // scene. This is broader than camera-follow: it is true for BOTH exploration
  // and dungeon modes. Camera-follow / right-click movement remains exploration
  // only (see getSceneCameraFollowEnabled), but the controller badge and the
  // pass-control flow apply in dungeons too.
  function isMainControllerSceneMode(scene) {
    const fab = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];

    const sceneMode = safeGet(fab, `${GENERAL_KEY}.${SCENE_MODE_KEY}`, null);
    if (sceneMode === "dungeon")     return true;
    if (sceneMode === "exploration") return true;
    if (sceneMode === "none")        return false;

    // Legacy fallback: the old cameraFollowToken boolean implied exploration.
    return getSceneCameraFollowEnabled(scene);
  }

  function isBadgeActiveForScene() {
    return !!canvas?.ready && !!canvas?.scene && isMainControllerSceneMode(canvas.scene);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 61;
        pointer-events: none;
        opacity: 0;
        transform: translateY(2px);
        transition: opacity 140ms ease, transform 140ms ease;
      }

      #${ROOT_ID}.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${ROOT_ID} .mc-controller-row {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        max-width: min(70vw, 700px);
        pointer-events: none;
      }

      #${ROOT_ID} .mc-controller-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.16);
        background:
          linear-gradient(180deg, rgba(41, 153, 86, 0.98) 0%, rgba(23, 112, 60, 0.98) 100%);
        color: #f4fff7;
        box-shadow:
          0 6px 16px rgba(0,0,0,0.28),
          inset 0 1px 0 rgba(255,255,255,0.10);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1;
        white-space: nowrap;
        text-shadow: 0 1px 1px rgba(0,0,0,0.35);
        backdrop-filter: blur(2px);
      }

      #${ROOT_ID} .mc-controller-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #d6ffe3;
        box-shadow:
          0 0 0 2px rgba(255,255,255,0.12),
          0 0 10px rgba(214,255,227,0.45);
        flex: 0 0 auto;
      }

      #${ROOT_ID} .mc-controller-text {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      #${ROOT_ID} .mc-controller-prefix {
        opacity: 0.92;
        font-weight: 600;
      }

      #${ROOT_ID} .mc-controller-name {
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 32ch;
      }

      #${ROOT_ID} .mc-controller-slot {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        pointer-events: auto;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureRoot() {
    if (state.root?.isConnected) return state.root;

    ensureStyles();

    const existing = document.getElementById(ROOT_ID);
    if (existing) existing.remove();

    const root = document.createElement("div");
    root.id = ROOT_ID;

    root.innerHTML = `
      <div class="mc-controller-row">
        <div class="mc-controller-badge" aria-live="polite" aria-label="Current Main Controller">
          <span class="mc-controller-dot"></span>
          <span class="mc-controller-text">
            <span class="mc-controller-prefix">Controller</span>
            <span class="mc-controller-name">—</span>
          </span>
        </div>
        <div class="mc-controller-slot"></div>
      </div>
    `;

    document.body.appendChild(root);

    state.root = root;
    state.row = root.querySelector(".mc-controller-row");
    state.badge = root.querySelector(".mc-controller-badge");
    state.label = root.querySelector(".mc-controller-name");
    state.slot = root.querySelector(".mc-controller-slot");

    DBG.verbose("ControllerBadge", "Created controller badge root");
    return root;
  }

  function getPlayerListElement() {
    const appElement = ui.players?.element?.[0] ?? ui.players?.element ?? null;
    if (appElement instanceof HTMLElement) return appElement;

    return document.getElementById("players") || document.querySelector("#players") || null;
  }

  function stopObservers() {
    try {
      state.resizeObserver?.disconnect();
    } catch (_) {}
    try {
      state.mutationObserver?.disconnect();
    } catch (_) {}

    state.resizeObserver = null;
    state.mutationObserver = null;
    state.observedPlayerEl = null;
  }

  function schedulePosition(delay = 0) {
    if (state.destroyed) return;
    if (state.positionTimer) clearTimeout(state.positionTimer);
    state.positionTimer = setTimeout(() => {
      state.positionTimer = null;
      reposition();
    }, Math.max(0, Number(delay) || 0));
  }

  function observePlayerListElement() {
    const playerEl = getPlayerListElement();

    if (!playerEl) {
      stopObservers();
      schedulePosition(0);
      return;
    }

    if (state.observedPlayerEl === playerEl && state.resizeObserver && state.mutationObserver) {
      return;
    }

    stopObservers();

    state.observedPlayerEl = playerEl;

    state.resizeObserver = new ResizeObserver(() => {
      schedulePosition(0);
    });
    state.resizeObserver.observe(playerEl);

    state.mutationObserver = new MutationObserver(() => {
      schedulePosition(0);
    });
    state.mutationObserver.observe(playerEl, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style", "hidden"]
    });

    DBG.verbose("ControllerBadge", "Attached player list observers", {
      hasPlayerElement: !!playerEl
    });
  }

  function setVisible(visible) {
    const root = ensureRoot();
    root.classList.toggle("is-visible", !!visible);
  }

  function hide() {
    const root = ensureRoot();
    root.style.left = "-9999px";
    root.style.top = "-9999px";
    setVisible(false);
  }

  function reposition() {
    const root = ensureRoot();
    const row = state.row;
    if (!root || !row) return;

    // Dungeon / exploration: the bottom-left and top-left corners are occupied
    // by the dungeon control UI (the round button row + the party status HUD),
    // and the #players anchor lands inconsistently across clients (top-left on
    // players, atop the button row on the GM). Dock the badge in a fixed slot
    // directly above the dungeon button row instead, so the controller badge +
    // Pass read as one coherent bottom-left control stack. Geometry is read
    // defensively from the Dungeon Pathing UI constants (button row at
    // BOTTOM=80, SIZE=64), with the same fallbacks dp-scan-mode.js uses.
    if (isMainControllerSceneMode(canvas?.scene)) {
      const btn       = globalThis.DungeonPathing?.UI?.SCAN_BUTTON;
      const btnBottom = Number(btn?.BOTTOM ?? 80);
      const btnSize   = Number(btn?.SIZE   ?? 64);
      const gapAbove  = 10;

      // The unspent Skill Point badge, when present, takes the slot directly
      // above the button row and pushes this badge up by its height. It is
      // absent whenever the character has nothing to spend, and this badge
      // then falls back to its usual slot — hence measuring the live element
      // rather than reserving space for it. The level-up badge calls
      // reposition() on show/hide so the stack settles immediately.
      // Two advancement badges can sit between the button row and this one:
      // unspent Skill Points and unspent Attribute Points. Either, both or
      // neither may be present, so each is MEASURED rather than reserved for.
      // Both call reposition() on show/hide so the stack settles immediately.
      const stacked = ["oni-levelup-badge", "oni-attribute-badge"]
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .reduce((h, el) => h + Math.round(el.getBoundingClientRect().height) + gapAbove, 0);

      root.style.left   = "20px";
      root.style.top    = "auto"; // override the stylesheet's top:0 so bottom anchors
      root.style.bottom = `${btnBottom + btnSize + gapAbove + stacked}px`;
      state.docked = true;
      return;
    }
    state.docked = false;

    const playerEl = getPlayerListElement();

    if (!playerEl) {
      root.style.left = "12px";
      root.style.bottom = "";
      root.style.top = `${Math.max(12, window.innerHeight - 84)}px`;
      return;
    }

    const playerRect = playerEl.getBoundingClientRect();
    const rootRect = row.getBoundingClientRect();

    const gap = 8;
    const viewportPad = 8;

    let left = playerRect.left;
    let top = playerRect.top - rootRect.height - gap;

    left = Math.max(viewportPad, Math.min(left, window.innerWidth - rootRect.width - viewportPad));
    top = Math.max(viewportPad, top);

    root.style.bottom = ""; // clear any dock anchor from a previous scene
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  async function computeControllerName() {
    const api = getMovementAPI();
    if (!api) {
      DBG.warn("ControllerBadge", "Movement Control API unavailable while computing controller name");
      return null;
    }

    try {
      if (typeof api.resolveSnapshotUsingStoredPreference === "function") {
        await api.resolveSnapshotUsingStoredPreference({
          onlineOnly: true,
          includeGM: false
        });
      }

      if (typeof api.getCurrentControllerUser === "function") {
        const controller = await api.getCurrentControllerUser();
        return cleanString(controller?.userName) || null;
      }
    } catch (err) {
      DBG.warn("ControllerBadge", "Failed to compute controller name", {
        error: err?.message ?? err
      });
    }

    return null;
  }

  async function refresh({ reason = "manual" } = {}) {
    if (state.destroyed) return;

    ensureRoot();
    observePlayerListElement();

    if (!isBadgeActiveForScene()) {
      hide();
      DBG.verbose("ControllerBadge", "Badge hidden because scene camera-follow mode is inactive", { reason });
      return;
    }

    const controllerName = await computeControllerName();

    if (!controllerName) {
      hide();
      DBG.verbose("ControllerBadge", "Badge hidden because no controller was resolved", { reason });
      return;
    }

    state.label.textContent = controllerName;
    setVisible(true);
    schedulePosition(0);

    DBG.verbose("ControllerBadge", "Badge refreshed", {
      reason,
      controllerName
    });
  }

  function scheduleRefresh(reason = "scheduled", delay = 0) {
    if (state.destroyed) return;
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      refresh({ reason });
    }, Math.max(0, Number(delay) || 0));
  }

  function getHostElement() {
    ensureRoot();
    return state.slot;
  }

  function getRootElement() {
    ensureRoot();
    return state.root;
  }

  function getRowElement() {
    ensureRoot();
    return state.row;
  }

  function getBadgeElement() {
    ensureRoot();
    return state.badge;
  }

  function getLayoutInfo(estimatedMenuHeight = 0) {
    ensureRoot();

    const rootRect = state.root?.getBoundingClientRect?.() ?? null;
    const rowRect = state.row?.getBoundingClientRect?.() ?? null;
    const badgeRect = state.badge?.getBoundingClientRect?.() ?? null;

    if (!rootRect) {
      return {
        direction: "down",
        spaceAbove: 0,
        spaceBelow: 0,
        rootRect: null,
        rowRect: null,
        badgeRect: null
      };
    }

    const viewportPad = 8;
    const spaceAbove = Math.max(0, rootRect.top - viewportPad);
    const spaceBelow = Math.max(0, window.innerHeight - rootRect.bottom - viewportPad);

    let direction = "down";

    if (estimatedMenuHeight > 0) {
      if (spaceBelow >= estimatedMenuHeight) direction = "down";
      else if (spaceAbove >= estimatedMenuHeight) direction = "up";
      else direction = spaceBelow >= spaceAbove ? "down" : "up";
    } else {
      direction = spaceBelow >= spaceAbove ? "down" : "up";
    }

    // When docked above the dungeon button row, the space "below" the badge is
    // occupied by that row and the #players list — always fan upward into the
    // open canvas so the pass menu never overlaps the controls.
    if (state.docked) direction = "up";

    return {
      direction,
      spaceAbove,
      spaceBelow,
      rootRect,
      rowRect,
      badgeRect
    };
  }

  function getFanDirection(estimatedMenuHeight = 0) {
    return getLayoutInfo(estimatedMenuHeight).direction;
  }

  function clearHostElement() {
    ensureRoot();
    if (state.slot) state.slot.innerHTML = "";
  }

  function destroy() {
    state.destroyed = true;

    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    if (state.positionTimer) clearTimeout(state.positionTimer);

    state.refreshTimer = null;
    state.positionTimer = null;

    stopObservers();

    try {
      state.root?.remove();
    } catch (_) {}

    state.root = null;
    state.row = null;
    state.badge = null;
    state.label = null;
    state.slot = null;

    DBG.verbose("ControllerBadge", "Controller badge destroyed");
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    refresh,
    scheduleRefresh,
    reposition,

    getHostElement,
    getRootElement,
    getRowElement,
    getBadgeElement,
    getLayoutInfo,
    getFanDirection,

    clearHostElement,
    destroy
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlControllerBadge = api;
    } catch (err) {
      console.warn("[MovementControl:ControllerBadge] Failed to attach API to FUCompanion.api", err);
    }

    state.ready = true;
    scheduleRefresh("ready", 50);

    DBG.verbose("ControllerBadge", "movementControl-controllerBadge.js ready", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });

  Hooks.on("canvasReady", () => {
    scheduleRefresh("canvasReady", 50);
  });

  Hooks.on("renderPlayerList", () => {
    observePlayerListElement();
    scheduleRefresh("renderPlayerList", 10);
  });

  Hooks.on("updateScene", (scene) => {
    if (scene?.id !== canvas?.scene?.id) return;
    scheduleRefresh("updateScene", 10);
  });

  Hooks.on("updateActor", () => {
    scheduleRefresh("updateActor", 10);
  });

  Hooks.on("updateUser", () => {
    scheduleRefresh("updateUser", 10);
  });

  window.addEventListener("resize", () => {
    schedulePosition(0);
  });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();
