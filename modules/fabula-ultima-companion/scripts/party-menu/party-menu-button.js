// Party Menu — entry points.
//
// The chat-bar Party button (custom-ui/chat-party-button.js) opens this menu;
// GMs Shift-click it for the old CSB Party Sheet. This file registers the
// keybinding, C by default, rebindable under Configure Controls.

import { openPartyMenu, isPartyMenuOpen, closePartyMenu } from "./party-menu-app.js";

const MODULE_ID = "fabula-ultima-companion";

// A locked event (dialogue, a cutscene) is running on this scene. Read on
// every client from the event flow; keyboard-interact.js listens on Input
// permanently, so Input.hasListeners() cannot tell this apart from free roam.
function eventInProgress() {
  const active = window.oni?.EventSystem?.Flow?.state?.active;
  if (!active?.size) return false;
  for (const e of active.values()) if (e?.locked) return true;
  return false;
}

Hooks.once("init", () => {
  game.keybindings.register(MODULE_ID, "openPartyMenu", {
    name: "Open Party Menu",
    hint: "Toggle the FF9-style Party Menu.",
    // Not Enter: Enter is Confirm (talk, doors, dialogue), and a key that
    // means two things depending on where you stand is hard to trust.
    editable: [{ key: "KeyC" }],
    // Ahead of Foundry's own C (Toggle Character Sheet), and the key is always
    // taken, so the native sheet never opens from it.
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
    onDown: () => {
      if (isPartyMenuOpen()) closePartyMenu();
      else if (!eventInProgress()) openPartyMenu();
      return true;
    },
  });
});
