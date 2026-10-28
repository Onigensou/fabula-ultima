/**
 * [ONI] Input — Confirm / Cancel
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-input.js
 *
 * What this does:
 * - Gives the module one shared set of inputs, the way a game controller has
 *   two face buttons and a direction pad: Confirm, Cancel, Up, Down
 * - Registers them as Foundry keybindings, so they show in Configure Controls
 *   and each person can rebind them
 *     Confirm: Z, Enter (not Spacebar: that stays the GM's pause key)
 *     Cancel:  X
 *     Up:      Arrow Up, W
 *     Down:    Arrow Down, S
 *     Walk:    the four arrows (held)
 *     Run:     X (held, while walking; X is Cancel whenever something wants it)
 * - Hands a press to whichever system is currently listening
 * - Hands the held arrows to the walker (exploration walking) when no menu
 *   took them first
 * - Tracks whether the player last used the keyboard or the mouse, so
 *   keyboard-only hints show only to someone playing on the keyboard
 *
 * A key does nothing here unless a listener takes it. With no listener, while
 * the game is paused, or when the listener declines, the key falls through to whatever it normally
 * does (Spacebar still pauses for the GM, the arrows and W / S still pan the
 * map). Foundry itself ignores these keys while the cursor is in a text field.
 *
 * Exposes API to:
 *   window.oni.Input
 *
 * Usage:
 *   const stop = window.oni.Input.listen(({ action }) => {
 *     // action is "confirm", "cancel", "up" or "down";
 *     // return true when the press was used
 *   });
 *   stop(); // when finished
 *
 *   window.oni.Input.setWalker((direction, pressed) => {
 *     // direction is "up", "down", "left", "right" or "run"; pressed is false on release.
 *     // Return true when the key belongs to the walk.
 *   });
 *
 *   window.oni.Input.mode          // "key" or "pointer"
 *   Hooks.on("oniInputMode", (mode) => { ... })
 */

(() => {
  const INSTALL_TAG = "[ONI][Input]";
  const MODULE_ID = "fabula-ultima-companion";

  window.oni = window.oni || {};
  if (window.oni.Input?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const ACTIONS = Object.freeze({ CONFIRM: "confirm", CANCEL: "cancel", UP: "up", DOWN: "down" });

  // Most recent listener first: a menu opened over a dialogue gets the press.
  const listeners = [];

  function listen(handler) {
    if (typeof handler !== "function") return () => {};
    listeners.unshift(handler);
    return () => {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  // The exploration walk. One at a time; the movement runtime sets it.
  let walker = null;

  function setWalker(fn) {
    walker = typeof fn === "function" ? fn : null;
  }

  function walk(direction, pressed) {
    if (!walker) return false;
    try {
      return walker(direction, pressed) === true;
    } catch (e) {
      console.warn(INSTALL_TAG, "The walker threw.", e);
      return false;
    }
  }

  // Keyboard or mouse, whichever was used last.
  let mode = "pointer";
  let pointerTravel = 0;

  function setMode(next) {
    pointerTravel = 0;
    if (next === mode) return;
    mode = next;
    window.oni.Input.mode = mode;
    Hooks.callAll("oniInputMode", mode);
  }

  // A mouse that is merely nudged (a desk bump) should not take over from the
  // keyboard; a click, or a real move, does.
  const POINTER_TAKEOVER_PX = 24;

  function installPointerWatch() {
    window.addEventListener("pointerdown", () => setMode("pointer"), { capture: true, passive: true });
    window.addEventListener("pointermove", (ev) => {
      if (mode !== "key") return;
      pointerTravel += Math.abs(ev.movementX || 0) + Math.abs(ev.movementY || 0);
      if (pointerTravel >= POINTER_TAKEOVER_PX) setMode("pointer");
    }, { capture: true, passive: true });
  }

  // Returns true when a listener used the press.
  // While the game is paused nothing listens, as on a console: the press falls
  // through, so the GM's Spacebar always reaches core and resumes.
  function dispatch(action, source = "key") {
    if (source === "key") setMode("key");
    if (globalThis.game?.paused) return false;
    for (const handler of [...listeners]) {
      try {
        if (handler({ action, source }) === true) return true;
      } catch (e) {
        console.warn(INSTALL_TAG, "An input listener threw.", e);
      }
    }
    return false;
  }

  function registerKeybindings() {
    try {
      game.keybindings.register(MODULE_ID, "oniConfirm", {
        name: "Confirm",
        hint: "Advance dialogue and confirm prompts. Only acts while something is asking for it.",
        editable: [{ key: "KeyZ" }, { key: "Enter" }],
        onDown: () => dispatch(ACTIONS.CONFIRM, "key"),
        restricted: false,
        precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY
      });

      game.keybindings.register(MODULE_ID, "oniCancel", {
        name: "Cancel",
        hint: "Cancel or go back. In dialogue it advances, like Confirm. Only acts while something is asking for it.",
        editable: [{ key: "KeyX" }],
        onDown: () => dispatch(ACTIONS.CANCEL, "key"),
        restricted: false,
        precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY
      });

      game.keybindings.register(MODULE_ID, "oniUp", {
        name: "Menu Up",
        hint: "Move up in a choice menu. Only acts while a menu is asking for it.",
        editable: [{ key: "ArrowUp" }, { key: "KeyW" }],
        onDown: () => dispatch(ACTIONS.UP, "key"),
        restricted: false,
        precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY
      });

      game.keybindings.register(MODULE_ID, "oniDown", {
        name: "Menu Down",
        hint: "Move down in a choice menu. Only acts while a menu is asking for it.",
        editable: [{ key: "ArrowDown" }, { key: "KeyS" }],
        onDown: () => dispatch(ACTIONS.DOWN, "key"),
        restricted: false,
        precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY
      });

      // Walking. Registered after Menu Up / Down on purpose: Foundry runs
      // bindings of equal precedence in the order they were registered, so an
      // open menu takes the arrow first and the walk only gets it when nothing
      // did. Held keys do not repeat; the walker keeps going until the release.
      const WALK_KEYS = [
        ["oniWalkUp", "Walk Up", "up", "ArrowUp"],
        ["oniWalkDown", "Walk Down", "down", "ArrowDown"],
        ["oniWalkLeft", "Walk Left", "left", "ArrowLeft"],
        ["oniWalkRight", "Walk Right", "right", "ArrowRight"]
      ];
      for (const [action, name, direction, key] of WALK_KEYS) {
        game.keybindings.register(MODULE_ID, action, {
          name,
          hint: "Walk the party on exploration maps (your own character in camp) while held. Elsewhere the key does what it normally does.",
          editable: [{ key }],
          onDown: () => {
            setMode("key");
            return walk(direction, true);
          },
          onUp: () => walk(direction, false),
          restricted: false,
          precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY
        });
      }

      // Run while held. Registered after Cancel on the same key: a menu or
      // dialogue that wants Cancel gets X first; only an X nothing else
      // takes reaches the walker (as direction "run").
      game.keybindings.register(MODULE_ID, "oniRun", {
        name: "Run (hold)",
        hint: "Hold while walking on an exploration map or in camp to run. Menus and dialogue still take it as Cancel.",
        editable: [{ key: "KeyX" }],
        onDown: () => {
          setMode("key");
          return walk("run", true);
        },
        onUp: () => walk("run", false),
        restricted: false,
        precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY
      });
    } catch (e) {
      console.error(INSTALL_TAG, "Failed to register keybindings.", e);
    }
  }

  window.oni.Input = {
    installed: true,
    ACTIONS,
    listen,
    dispatch,
    hasListeners: () => listeners.length > 0,
    setWalker,
    mode
  };

  Hooks.once("init", registerKeybindings);
  installPointerWatch();

  console.debug(INSTALL_TAG, "Installed. API: window.oni.Input");
})();
