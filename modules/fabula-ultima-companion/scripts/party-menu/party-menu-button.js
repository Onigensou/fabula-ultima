// Party Menu — entry points.
//
// The chat-bar Party button (custom-ui/chat-party-button.js) opens this menu;
// GMs Shift-click it for the old CSB Party Sheet. This file only registers an
// unbound keybinding players can assign under Configure Controls.

import { openPartyMenu, isPartyMenuOpen, closePartyMenu } from "./party-menu-app.js";

const MODULE_ID = "fabula-ultima-companion";

Hooks.once("init", () => {
  game.keybindings.register(MODULE_ID, "openPartyMenu", {
    name: "Open Party Menu",
    hint: "Toggle the FF9-style Party Menu.",
    editable: [],
    onDown: () => {
      if (isPartyMenuOpen()) closePartyMenu();
      else openPartyMenu();
      return true;
    },
  });
});
