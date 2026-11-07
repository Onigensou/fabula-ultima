// ============================================================================
// Party Talk — keys
// ----------------------------------------------------------------------------
//   T  open the text box            (oniTalkOpen)
//   /  open it with "/" typed        (oniTalkSlash)
//   L  open / close the talk log     (oniTalkLog)
//
// Foundry keybindings match the PHYSICAL key (KeyboardEvent.code), so they
// work on a Thai layout, where T types "ะ", / types "ฝ" and L types "ส".
// Enter is not used: it is already Confirm (event-input.js).
//
// Each handler returns true only when it acted, so outside talk maps (battle,
// conflict, cutscenes) the key falls through to whatever else wants it. While
// the text box has focus Foundry skips keybindings and the box takes the keys.
// ============================================================================

import { MODULE_ID } from "./party-talk-core.js";
import { openPrompt, toggleLog, canTalk } from "./party-talk-ui.js";

Hooks.once("init", () => {
  try {
    game.keybindings.register(MODULE_ID, "oniTalkOpen", {
      name: "Party Talk",
      hint: "Open the Party Talk box on exploration, dungeon and camp maps. Enter sends, Esc closes.",
      editable: [{ key: "KeyT" }],
      onDown: () => openPrompt(""),
      restricted: false,
      precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    });
    game.keybindings.register(MODULE_ID, "oniTalkSlash", {
      name: "Party Talk (command)",
      hint: "Open the Party Talk box with / typed, for /y (shout), /t (think) or /me (action).",
      editable: [{ key: "Slash" }],
      onDown: () => (canTalk() ? openPrompt("/") : false),
      restricted: false,
      precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    });
    game.keybindings.register(MODULE_ID, "oniTalkLog", {
      name: "Party Talk log",
      hint: "Show the last 30 Party Talk lines.",
      editable: [{ key: "KeyL" }],
      onDown: () => toggleLog(),
      restricted: false,
      precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    });
  } catch (e) {
    console.error("[ONI][PartyTalk]", "Failed to register keybindings.", e);
  }
});
