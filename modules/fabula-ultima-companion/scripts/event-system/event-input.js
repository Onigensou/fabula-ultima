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
 * - Hands a press to whichever system is currently listening
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

  // Returns true when a listener used the press.
  // While the game is paused nothing listens, as on a console: the press falls
  // through, so the GM's Spacebar always reaches core and resumes.
  function dispatch(action, source = "key") {
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
    } catch (e) {
      console.error(INSTALL_TAG, "Failed to register keybindings.", e);
    }
  }

  window.oni.Input = {
    installed: true,
    ACTIONS,
    listen,
    dispatch,
    hasListeners: () => listeners.length > 0
  };

  Hooks.once("init", registerKeybindings);

  console.debug(INSTALL_TAG, "Installed. API: window.oni.Input");
})();
