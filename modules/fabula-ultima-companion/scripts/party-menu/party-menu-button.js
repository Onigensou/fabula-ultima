// Party Menu — entry points.
//
// A chat-bar button next to the existing Party Sheet button (which is left
// exactly as it was — the GM keeps the CSB sheet), plus an unbound keybinding
// players can assign under Configure Controls. Positioning is owned by the
// shared chat-button layout manager; this only creates the element.

import { openPartyMenu, isPartyMenuOpen, closePartyMenu } from "./party-menu-app.js";

const MODULE_ID = "fabula-ultima-companion";
const BUTTON_ID = "oni-chat-open-party-menu-btn";
const STYLE_ID = "oni-chat-open-party-menu-btn-style";
const SIZE = 30;

function injectCss() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
#chat-form { position: relative; }
#${BUTTON_ID} {
  width: ${SIZE}px; height: ${SIZE}px; min-width: ${SIZE}px; min-height: ${SIZE}px;
  position: absolute; right: 6px; bottom: 6px; z-index: 20;
  display: inline-flex; align-items: center; justify-content: center; padding: 0; margin: 0;
  border-radius: 6px; border: 1px solid rgba(255,255,255,0.18);
  background: linear-gradient(160deg, rgba(93,114,173,.75), rgba(22,29,69,.85));
  box-shadow: 0 1px 2px rgba(0,0,0,0.35); cursor: pointer; color: #f4f6ff; font-size: 14px;
}
#${BUTTON_ID}:hover { filter: brightness(1.15); }
#${BUTTON_ID}:active { transform: translateY(1px); }
#${BUTTON_ID} i { pointer-events: none; margin: 0; }
`;
  document.head.appendChild(el);
}

function requestLayout(reason, delay) {
  const m = globalThis.__ONI_CHAT_BUTTON_FINAL_LAYOUT__;
  if (typeof m?.requestLayout === "function") return m.requestLayout(reason, delay);
  if (typeof m?.scheduleLayout === "function") return m.scheduleLayout(delay, { reason });
  return false;
}

function ensureButton() {
  if (document.getElementById(BUTTON_ID)) return true;
  const form = document.querySelector("#chat-form");
  if (!form) return false;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = BUTTON_ID;
  btn.title = "Party Menu";
  btn.setAttribute("aria-label", "Party Menu");
  btn.innerHTML = `<i class="fas fa-hand-point-right"></i>`;
  btn.addEventListener("click", () => openPartyMenu());
  form.appendChild(btn);
  return true;
}

function install() {
  injectCss();
  if (!ensureButton()) return;
  requestLayout("partyMenuButton", 0);
  requestLayout("partyMenuButtonWarm", 150);
}

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

Hooks.once("ready", install);
Hooks.on("renderSidebarTab", install);
