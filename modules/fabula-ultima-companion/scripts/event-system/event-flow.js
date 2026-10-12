/**
 * [ONI] Event System — Flow (movement lock + text advance)
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-flow.js
 *
 * What this does:
 * - Holds the party in place while an event runs, unless the event says not to
 * - Lets the main controller (and the GM) advance the text:
 *     press while a line is typing  -> the line completes
 *     press when the line is complete -> on to the next line
 *   and keeps every client on the same line while they do
 * - Adds the "Set Movement" event action (Locked / Free), for an event that
 *   wants to change the lock partway through
 *
 * How it fits together:
 * - The GM client that runs an event is the authority. A press on any other
 *   client is sent to it; it completes or closes the bubble for everyone
 *   through FU.DialogUI.control().
 * - Every client locks its own walk input when an event starts and frees it
 *   when the event ends. Only the main controller can walk the party, so that
 *   is the client the lock matters on; the GM is never locked.
 * - Movement is always freed when an event ends, fails or times out and when
 *   the scene changes, whatever its rows did.
 *
 * An event with no lockMovement setting counts as locked.
 *   Locked: each line waits for a press (and gives up after a safety timeout).
 *   Free:   each line closes on its own timer, as it always did.
 *
 * Exposes API to:
 *   window.oni.EventSystem.Flow
 *
 * Requires:
 * - event-constants.js, event-eventRegistry.js, event-input.js
 * - scripts/dialog-system/dialog-ui.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][Flow]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Flow?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!C || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Constants or EventRegistry. Check load order.");
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_FLOW = "ONI_EVENT_FLOW_V1";

  const LOCK_FLAG = "lockMovement";
  const ROW_TYPE_MOVEMENT = "setMovement";

  // A line that waits for a press moves on by itself after this long.
  const LINE_MAX_WAIT_MS = 30000;

  // However an event ends, or fails to, its lock does not outlive this.
  const LOCK_MAX_MS = 5 * 60 * 1000;

  // Presses closer together than this count as one (a held key, a double click).
  const PRESS_GAP_MS = 120;

  const state = {
    // GM, events this client is running: sourceId -> { sceneId, locked, bubbleId }
    running: new Map(),
    // Every client, events in progress on this scene: sourceId -> { locked, timer }
    active: new Map(),

    stopInput: null,
    pointerHandler: null,
    lastPressAt: 0
  };

  function walkRuntime() {
    return globalThis.__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__ ?? null;
  }

  function lockId(sourceId) {
    return `event:${sourceId}`;
  }

  // ------------------------------------------------------------
  // Who may start and advance events
  // ------------------------------------------------------------
  // The main controller is the player holding the controller: whoever
  // currently walks the party. Where the game has no controller at all,
  // nobody is shut out.
  function isLocalUserInteractor() {
    if (game.user?.isGM) return true;

    const rt = walkRuntime()?.state;
    if (!rt) return true;
    if (!rt.cachedCurrentControllerUserId) return true;
    return !!rt.cachedIsMainController;
  }

  async function isUserInteractor(userId) {
    const user = game.users?.get(userId);
    if (!user) return false;
    if (user.isGM) return true;

    try {
      const controller = await globalThis.FUCompanion?.api?.MovementControl?.getCurrentControllerUser?.();
      if (!controller?.userId) return true;
      return controller.userId === userId;
    } catch {
      return true;
    }
  }

  // ------------------------------------------------------------
  // Reading the event's own setting
  // ------------------------------------------------------------
  function findSource(sourceId) {
    const scene = canvas?.scene;
    if (!scene || !sourceId) return null;
    return scene.tokens?.get(sourceId) ?? scene.tiles?.get(sourceId) ?? null;
  }

  function eventStartsLocked(sourceDoc) {
    // The core knows where on the document the event data sits.
    const read = window.oni.EventSystem.Core?.readEventData?.(sourceDoc)?._raw;
    const scope = C.FLAG_SCOPE || "oni-event-system";
    const value = (read ?? sourceDoc?.flags?.[scope])?.[LOCK_FLAG];
    return !(value === false || value === "false" || value === 0);
  }

  // ------------------------------------------------------------
  // Movement lock (every client)
  // ------------------------------------------------------------
  function applyLock(sourceId, locked) {
    const rt = walkRuntime();
    if (!rt) return;

    if (locked) rt.lockMovement?.(lockId(sourceId));
    else rt.unlockMovement?.(lockId(sourceId));
  }

  function setActive(sourceId, locked) {
    let entry = state.active.get(sourceId);
    if (!entry) {
      entry = { locked: false, timer: null };
      state.active.set(sourceId, entry);
      entry.timer = setTimeout(() => endActive(sourceId), LOCK_MAX_MS);
    }

    entry.locked = !!locked;
    applyLock(sourceId, entry.locked);
    syncInput();
  }

  function endActive(sourceId) {
    const entry = state.active.get(sourceId);
    if (!entry) return;

    if (entry.timer) clearTimeout(entry.timer);
    state.active.delete(sourceId);
    applyLock(sourceId, false);
    syncInput();
  }

  function endAllActive() {
    for (const sourceId of [...state.active.keys()]) endActive(sourceId);
  }

  function onExecuteStart({ sceneId, sourceId } = {}) {
    if (!sourceId || !canvas?.scene || sceneId !== canvas.scene.id) return;

    const locked = eventStartsLocked(findSource(sourceId));

    // Stop a walk still in progress before the lock goes on, so the party is
    // standing where it was when the event began.
    if (locked) walkRuntime()?.haltWalk?.();

    setActive(sourceId, locked);
  }

  function onExecuteDone({ sourceId } = {}) {
    endActive(sourceId);
  }

  // ------------------------------------------------------------
  // Advancing the text
  // ------------------------------------------------------------
  // GM: act on the line this client is showing for an event it runs.
  function advanceRunning(sourceId = null) {
    const ui = globalThis.FU?.DialogUI;
    if (!ui?.control) return false;

    let used = false;
    for (const [id, run] of state.running) {
      if (sourceId && id !== sourceId) continue;
      if (!run.bubbleId || !ui.isShowing?.(run.bubbleId)) continue;

      ui.control(run.bubbleId, ui.isDone(run.bubbleId) ? "close" : "complete");
      used = true;
    }
    return used;
  }

  function press() {
    if (!state.active.size) return false;
    if (!isLocalUserInteractor()) return false;

    const now = performance.now();
    if ((now - state.lastPressAt) < PRESS_GAP_MS) return true;
    state.lastPressAt = now;

    // The GM running the event acts directly; anyone else asks that GM.
    if (state.running.size) {
      advanceRunning();
      return true;
    }

    try {
      game.socket.emit(SOCKET_CHANNEL, {
        type: MSG_FLOW,
        payload: {
          action: "advance",
          sceneId: canvas?.scene?.id ?? null,
          sourceIds: [...state.active.keys()],
          userId: game.user?.id ?? null
        }
      });
    } catch (e) {
      console.warn(INSTALL_TAG, "Failed to send an advance request.", e);
    }
    return true;
  }

  // Listen for presses only while an event is in progress here.
  function syncInput() {
    const want = state.active.size > 0;

    if (want && !state.stopInput) {
      state.stopInput = window.oni.Input?.listen?.(() => press()) ?? (() => {});

      // A left-click on the map advances too. Not for the GM, who clicks the
      // map for other reasons; the GM uses the keys or clicks the bubble.
      if (!game.user?.isGM) {
        state.pointerHandler = (ev) => {
          if (ev.button !== 0) return;
          if (ev.target !== canvas?.app?.view) return;
          press();
        };
        window.addEventListener("pointerdown", state.pointerHandler, true);
      }
    } else if (!want && state.stopInput) {
      state.stopInput();
      state.stopInput = null;

      if (state.pointerHandler) {
        window.removeEventListener("pointerdown", state.pointerHandler, true);
        state.pointerHandler = null;
      }
    }
  }

  // ------------------------------------------------------------
  // GM side: the events this client is running
  // ------------------------------------------------------------
  function begin(sourceId, sceneId, sourceDoc) {
    state.running.set(String(sourceId), {
      sceneId: String(sceneId || ""),
      locked: eventStartsLocked(sourceDoc),
      bubbleId: null
    });
  }

  function end(sourceId) {
    state.running.delete(String(sourceId));
  }

  function shouldWaitForInput(sourceId) {
    return state.running.get(String(sourceId))?.locked === true;
  }

  function setActiveBubble(sourceId, bubbleId) {
    const run = state.running.get(String(sourceId));
    if (run) run.bubbleId = bubbleId || null;
  }

  // The "Set Movement" action: change the lock for the rest of the event.
  function setMovement(sourceId, locked) {
    const id = String(sourceId || "");
    const run = state.running.get(id);
    if (run) run.locked = !!locked;

    setActive(id, !!locked);

    try {
      game.socket.emit(SOCKET_CHANNEL, {
        type: MSG_FLOW,
        payload: {
          action: "movement",
          sceneId: canvas?.scene?.id ?? null,
          sourceId: id,
          locked: !!locked
        }
      });
    } catch (e) {
      console.warn(INSTALL_TAG, "Failed to broadcast a movement change.", e);
    }
  }

  async function onSocket(data) {
    try {
      if (!data || data.type !== MSG_FLOW) return;

      const payload = data.payload ?? {};
      if (!canvas?.scene || payload.sceneId !== canvas.scene.id) return;

      if (payload.action === "movement") {
        if (state.active.has(payload.sourceId)) setActive(payload.sourceId, !!payload.locked);
        return;
      }

      if (payload.action === "advance") {
        if (!game.user?.isGM || !state.running.size) return;
        if (!(await isUserInteractor(payload.userId))) return;

        for (const sourceId of payload.sourceIds ?? []) advanceRunning(String(sourceId));
      }
    } catch (e) {
      console.warn(INSTALL_TAG, "Socket handler error.", e);
    }
  }

  // ------------------------------------------------------------
  // The "Set Movement" event action
  // ------------------------------------------------------------
  EventRegistry.register({
    type: ROW_TYPE_MOVEMENT,
    label: "Set Movement",
    category: "Flow",
    supportsSequentialWait: false,
    defaultData: {
      type: ROW_TYPE_MOVEMENT,
      state: "locked"
    },
    execute: async (row, context) => {
      const locked = String(row?.state ?? "locked") !== "free";
      setMovement(context?.tileId, locked);
      return { ok: true, type: ROW_TYPE_MOVEMENT, locked };
    }
  });

  window.oni.EventSystem.Flow = {
    installed: true,
    state,
    LOCK_FLAG,
    ROW_TYPE_MOVEMENT,
    LINE_MAX_WAIT_MS,

    isLocalUserInteractor,
    isUserInteractor,
    eventStartsLocked,

    begin,
    end,
    shouldWaitForInput,
    setActiveBubble,
    setMovement,
    press
  };

  Hooks.on("oniEventExecuteStart", onExecuteStart);
  Hooks.on("oniEventExecuteDone", onExecuteDone);
  Hooks.on("fuDialogBubblePress", () => { press(); });
  Hooks.on("canvasTearDown", endAllActive);

  Hooks.once("ready", () => {
    try {
      game.socket.on(SOCKET_CHANNEL, onSocket);
    } catch (e) {
      console.error(INSTALL_TAG, "Failed to install the socket listener.", e);
    }
  });

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.Flow");
})();
