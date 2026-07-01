// scripts/orbment/orbment-bootstrap.js
//
// Wires the Equipment Orbment system into the running client:
//   1. registers FUCompanion.api.orbment
//   2. injects a "🔮 Orbment" button onto equippable ITEM sheets (weapon/armor/
//      shield), so the GM can inspect/manage slots with no scripting.
//
// Loaded via a dynamic import from director-boot's ready hook (so it needs no
// module.json esmodules entry → a hard reload picks it up, no Setup relaunch).

import { registerOrbmentApi, openWindow } from "./orbment-api.js";
import { itemKindOf } from "./orbment-const.js";

const TAG = "[Orbment]";
const BTN_CLASS = "fu-orbment-btn";
const EQUIPPABLE = new Set(["weapon", "armor", "shield"]);

let _installed = false;

function eligible(item) {
  return !!item && game.user?.isGM && EQUIPPABLE.has(itemKindOf(item));
}

// v1 (classic Application) header-button hook.
function onGetItemHeaderButtons(sheet, buttons) {
  const item = sheet?.item ?? sheet?.document;
  if (!eligible(item)) return;
  if (buttons.some((b) => b.class === BTN_CLASS)) return;
  buttons.unshift({
    label: "Orbment",
    class: BTN_CLASS,
    icon: "fa-solid fa-gem",
    onclick: () => openWindow(item.uuid),
  });
}

// v2 (ApplicationV2 / CSB DOM) header injection.
function injectHeaderButton(rootEl, item) {
  if (!rootEl || !eligible(item)) return;
  if (rootEl.querySelector(`.${BTN_CLASS}`)) return;
  const headerBar = rootEl.querySelector(".window-header");
  if (!headerBar) return;
  const closeBtn = headerBar.querySelector('button[data-action="close"], a.header-button.close, .close');
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `header-control fa-solid fa-gem ${BTN_CLASS}`;
  btn.dataset.tooltip = "Manage equipment orbment slots";
  btn.setAttribute("aria-label", "Orbment");
  btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); openWindow(item.uuid); });
  if (closeBtn) headerBar.insertBefore(btn, closeBtn);
  else headerBar.appendChild(btn);
}

function onRenderItemSheet(sheet, html) {
  const item = sheet?.item ?? sheet?.document;
  const el = (html instanceof HTMLElement) ? html : html?.[0];
  const root = el?.closest?.(".window-app, .application") || el;
  injectHeaderButton(root, item);
}

export function initOrbment() {
  if (_installed) return;
  _installed = true;
  registerOrbmentApi();
  // Cover both classic + V2 sheet hooks; CSB's item sheet may fire either.
  Hooks.on("getItemSheetHeaderButtons", onGetItemHeaderButtons);
  Hooks.on("renderItemSheet",   onRenderItemSheet);
  Hooks.on("renderItemSheetV2", onRenderItemSheet);
  console.debug(TAG, "Equipment Orbment system ready.");
}
