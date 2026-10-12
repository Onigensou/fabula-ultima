// ============================================================================
// ONI — Chat Button Final Layout Manager (Foundry VTT v12)
// ----------------------------------------------------------------------------
// Purpose:
// - Final authoritative layout pass for all custom chat-bar buttons
// - Prevent rare edge cases where separate auto-dock scripts collapse together
// - Especially helpful on GM client where extra GM-only buttons exist
//
// How it works:
// - Runs AFTER the individual button scripts
// - Finds all known chat buttons by ID
// - Repositions them in one deterministic shared pass
// - Recomputes #chat-message padding-right from the final arrangement
//
// Important:
// - Load this script AFTER all chat button scripts in module.json
// ============================================================================

(() => {
  const GLOBAL_KEY = "__ONI_CHAT_BUTTON_FINAL_LAYOUT__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const CFG = {
    DEBUG: false,

    SIZE_PX: 30,
    GAP_PX: 6,
    BASE_RIGHT_PX: 6,
    BASE_BOTTOM_PX: 6,
    MAX_COLS: 12,
    MAX_ROWS: 4,

    // Final deterministic order, left-to-right from the user's perspective
    BUTTONS: [
      { id: "oni-chat-open-character-btn", order: 10, gmOnly: false },
      { id: "oni-chat-open-party-btn", order: 20, gmOnly: false },
      { id: "oni-chat-open-trade-btn", order: 30, gmOnly: false },
      { id: "oni-chat-emote-config-btn", order: 40, gmOnly: false },
      { id: "oni-chat-scene-network-btn", order: 50, gmOnly: true }
    ]
  };

  const state = {
    installed: true,
    ready: false,
    destroyed: false,

    timer: null,
    chatObserver: null,
    bodyObserver: null,
    observedChatForm: null,
    resizeHandler: null,

    layoutRunCount: 0,
    lastSchedule: null,
    lastApply: null,
    lastSnapshot: null
  };

  const LOG_TAG = "[ONI ChatBtnFinalLayout]";
  const DBG_TAG = "[ONI ChatBtnFinalLayout][DBG]";

  const log = (...args) => console.log(LOG_TAG, ...args);
  const debugLog = (...args) => {
    if (!CFG.DEBUG) return;
    console.log(DBG_TAG, ...args);
  };
  const debugWarn = (...args) => {
    if (!CFG.DEBUG) return;
    console.warn(DBG_TAG, ...args);
  };
  const errorLog = (...args) => console.error(LOG_TAG, ...args);

  function getChatForm() {
    return document.querySelector("#chat-form");
  }

  function getChatMessage() {
    return document.querySelector("#chat-message");
  }

  function rectsOverlap(a, b) {
    return !(
      a.right <= b.left ||
      a.left >= b.right ||
      a.bottom <= b.top ||
      a.top >= b.bottom
    );
  }

  function candidateRect(chatFormRect, rightPx, bottomPx, sizePx) {
    const left = chatFormRect.right - rightPx - sizePx;
    const top = chatFormRect.bottom - bottomPx - sizePx;

    return {
      left,
      top,
      right: left + sizePx,
      bottom: top + sizePx,
      width: sizePx,
      height: sizePx
    };
  }

  function rectToPlain(rect) {
    if (!rect) return null;
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function isElementVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden") return false;
    if (el.hidden) return false;
    return true;
  }

  function nodeMatchesChatLayoutWatch(node) {
  if (!(node instanceof HTMLElement)) return false;

  if (node.id === "chat-form") return true;
  if (node.id === "chat-message") return true;

  if (getManagedIds().has(node.id)) return true;

  if (node.querySelector?.("#chat-form")) return true;
  if (node.querySelector?.("#chat-message")) return true;

  for (const id of getManagedIds()) {
    if (node.querySelector?.(`#${CSS.escape(id)}`)) return true;
  }

  return false;
}

function mutationsCouldAffectChatLayout(mutations = []) {
  for (const m of mutations) {
    if (nodeMatchesChatLayoutWatch(m.target)) return true;

    for (const node of Array.from(m.addedNodes ?? [])) {
      if (nodeMatchesChatLayoutWatch(node)) return true;
    }

    for (const node of Array.from(m.removedNodes ?? [])) {
      if (nodeMatchesChatLayoutWatch(node)) return true;
    }
  }

  return false;
}

  function getManagedIds() {
    return new Set(CFG.BUTTONS.map(b => b.id));
  }

  function getExternalObstacles(chatForm, ignoreIds = new Set()) {
    const obstacles = [];
    const formRect = chatForm.getBoundingClientRect();
    const all = Array.from(chatForm.querySelectorAll("*"));

    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (ignoreIds.has(el.id)) continue;
      if (el.id === "chat-message") continue;
      if (!isElementVisible(el)) continue;

      const cs = getComputedStyle(el);
      if (cs.position !== "absolute") continue;

      const r = el.getBoundingClientRect();
      const w = r.width;
      const h = r.height;

      if (w < 18 || h < 18) continue;
      if (w > 120 || h > 120) continue;

      const nearRight = (formRect.right - r.right) < 280;
      const nearBottom = (formRect.bottom - r.bottom) < 240;
      if (!nearRight || !nearBottom) continue;

      obstacles.push({ el, rect: r });
    }

    return obstacles;
  }

  function getActiveManagedButtons() {
    return CFG.BUTTONS
      .filter(def => {
        if (def.gmOnly && !game.user?.isGM) return false;

        const el = document.getElementById(def.id);
        if (!el) return false;
        if (!isElementVisible(el)) return false;

        return true;
      })
      .map(def => ({
        ...def,
        el: document.getElementById(def.id)
      }))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return String(a.id).localeCompare(String(b.id));
      });
  }

  function findPlacedOverlaps(placedRects) {
    const overlaps = [];

    for (let i = 0; i < placedRects.length; i++) {
      for (let j = i + 1; j < placedRects.length; j++) {
        const a = placedRects[i];
        const b = placedRects[j];

        if (!a?.rect || !b?.rect) continue;
        if (!rectsOverlap(a.rect, b.rect)) continue;

        overlaps.push({
          a: {
            id: a.id,
            row: a.row,
            col: a.col
          },
          b: {
            id: b.id,
            row: b.row,
            col: b.col
          }
        });
      }
    }

    return overlaps;
  }

  function buildSnapshot(extra = {}) {
    const chatForm = getChatForm();
    const chatMessage = getChatMessage();
    const activeManagedButtons = getActiveManagedButtons();

    return {
      installed: true,
      ready: state.ready,
      destroyed: state.destroyed,

      chatFormPresent: !!chatForm,
      chatFormId: chatForm?.id ?? null,
      chatMessagePresent: !!chatMessage,
      chatMessageId: chatMessage?.id ?? null,

      observedChatFormId: state.observedChatForm?.id ?? null,
      hasChatObserver: !!state.chatObserver,
      hasBodyObserver: !!state.bodyObserver,
      hasResizeHandler: !!state.resizeHandler,
      timerPending: !!state.timer,

      layoutRunCount: state.layoutRunCount,
      lastSchedule: state.lastSchedule ? { ...state.lastSchedule } : null,
      lastApply: state.lastApply ? { ...state.lastApply } : null,

      activeManagedButtons: activeManagedButtons.map(entry => ({
        id: entry.id,
        order: entry.order,
        gmOnly: !!entry.gmOnly,
        present: !!entry.el,
        right: entry.el?.style?.right ?? null,
        bottom: entry.el?.style?.bottom ?? null
      })),

      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      isGM: !!game.user?.isGM,

      ...extra
    };
  }

  function updateSnapshot(extra = {}) {
    state.lastSnapshot = buildSnapshot(extra);
    return state.lastSnapshot;
  }

  function getSnapshot() {
    return state.lastSnapshot ?? updateSnapshot();
  }

  function applyFinalLayout(meta = {}) {
    const runId = state.layoutRunCount + 1;
    state.layoutRunCount = runId;

    const reason = String(meta.reason ?? "directApply");
    const startedAt = Date.now();

    const chatForm = getChatForm();
    const chatMessage = getChatMessage();

    if (!chatForm || !chatMessage) {
      state.lastApply = {
        runId,
        reason,
        ok: false,
        why: "missingChatFormOrMessage",
        startedAt,
        finishedAt: Date.now()
      };

      const snapshot = updateSnapshot();
      debugWarn("Layout skipped because chat form or chat message was missing.", snapshot);
      return false;
    }

    const managedButtons = getActiveManagedButtons();
    if (!managedButtons.length) {
      state.lastApply = {
        runId,
        reason,
        ok: false,
        why: "noManagedButtons",
        startedAt,
        finishedAt: Date.now()
      };

      const snapshot = updateSnapshot();
      debugWarn("Layout skipped because no active managed buttons were found.", snapshot);
      return false;
    }

    const chatFormRect = chatForm.getBoundingClientRect();

    // Reserve space for non-managed absolute UI that may also live in chat-form
    const externalObstacles = getExternalObstacles(chatForm, getManagedIds()).map(o => o.rect);

    debugLog("Layout run starting.", {
      runId,
      reason,
      managedButtons: managedButtons.map(entry => ({
        id: entry.id,
        order: entry.order
      })),
      externalObstacleCount: externalObstacles.length
    });

    const takenRects = [...externalObstacles];
    const placedRects = [];

    for (const entry of managedButtons) {
      const btn = entry.el;
      let chosen = null;

      for (let row = 0; row < CFG.MAX_ROWS && !chosen; row++) {
        for (let col = 0; col < CFG.MAX_COLS && !chosen; col++) {
          const rightPx = CFG.BASE_RIGHT_PX + col * (CFG.SIZE_PX + CFG.GAP_PX);
          const bottomPx = CFG.BASE_BOTTOM_PX + row * (CFG.SIZE_PX + CFG.GAP_PX);
          const cand = candidateRect(chatFormRect, rightPx, bottomPx, CFG.SIZE_PX);

          const overlaps = takenRects.some(r => rectsOverlap(cand, r));
          if (!overlaps) {
            chosen = { rightPx, bottomPx, row, col, rect: cand };
          }
        }
      }

      if (!chosen) {
        const rightPx = CFG.BASE_RIGHT_PX;
        const bottomPx = CFG.BASE_BOTTOM_PX + (CFG.SIZE_PX + CFG.GAP_PX);
        chosen = {
          rightPx,
          bottomPx,
          row: 1,
          col: 0,
          rect: candidateRect(chatFormRect, rightPx, bottomPx, CFG.SIZE_PX)
        };

        debugWarn("No free slot found. Using fallback slot.", {
          runId,
          buttonId: entry.id,
          fallback: {
            rightPx,
            bottomPx,
            row: 1,
            col: 0
          }
        });
      }

      btn.style.right = `${chosen.rightPx}px`;
      btn.style.bottom = `${chosen.bottomPx}px`;
      btn.style.zIndex = "20";

      takenRects.push(chosen.rect);
      placedRects.push({
        id: entry.id,
        order: entry.order,
        row: chosen.row,
        col: chosen.col,
        rightPx: chosen.rightPx,
        bottomPx: chosen.bottomPx,
        rect: chosen.rect
      });
    }

    // Final authoritative input padding
    const inputRect = chatMessage.getBoundingClientRect();
    let neededInset = 0;

    for (const r of takenRects) {
      const verticalOverlap = !(
        r.bottom <= inputRect.top ||
        r.top >= inputRect.bottom
      );
      if (!verticalOverlap) continue;

      const inset = chatFormRect.right - r.left;
      if (inset > neededInset) neededInset = inset;
    }

    const paddingRightPx = neededInset > 0 ? Math.ceil(neededInset + 8) : 0;

    if (paddingRightPx > 0) {
      chatMessage.style.setProperty(
        "padding-right",
        `${paddingRightPx}px`,
        "important"
      );
    }

    const overlapsAfterLayout = findPlacedOverlaps(placedRects);

    state.lastApply = {
      runId,
      reason,
      ok: true,
      startedAt,
      finishedAt: Date.now(),
      managedButtonCount: managedButtons.length,
      externalObstacleCount: externalObstacles.length,
      paddingRightPx,
      overlapsAfterLayout,
      placedRects: placedRects.map(r => ({
        id: r.id,
        order: r.order,
        row: r.row,
        col: r.col,
        rightPx: r.rightPx,
        bottomPx: r.bottomPx,
        rect: rectToPlain(r.rect)
      }))
    };

    const snapshot = updateSnapshot();

    if (overlapsAfterLayout.length > 0) {
      debugWarn("Overlap detected after final layout.", {
        runId,
        reason,
        overlapsAfterLayout
      });
    }

    debugLog("Final layout applied.", snapshot);
    return true;
  }

  function scheduleLayout(delay = 0, meta = {}) {
    if (state.destroyed) {
      debugWarn("scheduleLayout ignored because manager is destroyed.", {
        delay,
        meta
      });
      return false;
    }

    const cleanDelay = Math.max(0, Number(delay) || 0);
    const reason = String(meta.reason ?? "scheduled");

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;

      debugLog("Cleared previous pending layout timer before rescheduling.", {
        reason,
        delay: cleanDelay
      });
    }

    state.lastSchedule = {
      reason,
      delay: cleanDelay,
      scheduledAt: Date.now()
    };
    updateSnapshot();

    debugLog("Layout scheduled.", state.lastSchedule);

    state.timer = setTimeout(() => {
      state.timer = null;
      applyFinalLayout({ reason });
    }, cleanDelay);

    return true;
  }

  function requestLayout(reason = "manual", delay = 0) {
    return scheduleLayout(delay, { reason });
  }

  function observeChatForm() {
    const chatForm = getChatForm();
    if (!chatForm) {
      debugWarn("observeChatForm could not find #chat-form.");
      return false;
    }

    if (state.observedChatForm === chatForm && state.chatObserver) {
      return true;
    }

    if (state.chatObserver) {
      try {
        state.chatObserver.disconnect();
      } catch (_) {}
      state.chatObserver = null;
    }

    state.observedChatForm = chatForm;

    state.chatObserver = new MutationObserver((mutations) => {
      debugLog("Chat form mutation observed.", {
        mutationCount: mutations?.length ?? 0
      });
      requestLayout("chatFormMutation", 20);
    });

    state.chatObserver.observe(chatForm, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"]
    });

    debugLog("Attached chat form observer.", {
      chatFormId: chatForm.id ?? null
    });

    updateSnapshot();
    return true;
  }

  function observeBodyForChatReplacement() {
    if (state.bodyObserver) return true;

    state.bodyObserver = new MutationObserver((mutations) => {
  const currentChatForm = getChatForm();
  const observedStillValid =
    !!state.observedChatForm &&
    state.observedChatForm.isConnected &&
    currentChatForm === state.observedChatForm;

  // Normal case: chat-form is still the same live element.
  // Ignore unrelated body churn from other modules/apps.
  if (observedStillValid) {
    const relevant = mutationsCouldAffectChatLayout(mutations);
    if (!relevant) return;

    debugLog("Relevant body mutation observed for chat layout.", {
      mutationCount: mutations?.length ?? 0
    });

    requestLayout("bodyRelevantMutation", 40);
    return;
  }

  // Only when chat-form is missing/replaced do we use body observer
  // as a recovery path.
  debugLog("Body observer detected possible chat-form replacement.", {
    mutationCount: mutations?.length ?? 0,
    hadObservedChatForm: !!state.observedChatForm,
    observedConnected: !!state.observedChatForm?.isConnected,
    currentChatFormId: currentChatForm?.id ?? null
  });

  const attached = observeChatForm();
  if (attached) {
    requestLayout("bodyChatFormRecovered", 40);
  }
});

    state.bodyObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    debugLog("Attached body observer for chat replacement.");
    updateSnapshot();
    return true;
  }

  function installResizeListener() {
    if (state.resizeHandler) return true;

    state.resizeHandler = () => {
      debugLog("Window resize observed.");
      requestLayout("windowResize", 30);
    };

    window.addEventListener("resize", state.resizeHandler, { passive: true });

    debugLog("Attached window resize listener.");
    updateSnapshot();
    return true;
  }

  function destroy() {
    state.destroyed = true;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    try {
      state.chatObserver?.disconnect();
    } catch (_) {}

    try {
      state.bodyObserver?.disconnect();
    } catch (_) {}

    if (state.resizeHandler) {
      try {
        window.removeEventListener("resize", state.resizeHandler);
      } catch (_) {}
    }

    state.chatObserver = null;
    state.bodyObserver = null;
    state.resizeHandler = null;
    state.observedChatForm = null;

    updateSnapshot();
    debugLog("Final layout manager destroyed.");
  }

  const api = {
    installed: true,
    CFG,

    applyFinalLayout,
    scheduleLayout,
    requestLayout,

    observeChatForm,
    observeBodyForChatReplacement,

    getSnapshot,
    destroy
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    observeChatForm();
    observeBodyForChatReplacement();
    installResizeListener();

    requestLayout("readyImmediate", 0);
    requestLayout("readyWarmup100", 100);
    requestLayout("readyWarmup300", 300);

    state.ready = true;
    updateSnapshot();

    log("Ready.");
    debugLog("Ready snapshot.", getSnapshot());
  });

  Hooks.on("renderSidebarTab", (app) => {
    debugLog("renderSidebarTab observed.", {
      appId: app?.id ?? app?.options?.id ?? null
    });

    observeChatForm();
    requestLayout("renderSidebarTab30", 30);
    requestLayout("renderSidebarTab120", 120);
  });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();