// Damage-number audition tool — a GM dev-tools panel that fires every
// affinity / crit / element / kind combination of the floating damage number
// on the currently-controlled token (or the first token on the canvas), so the
// Persona-style look can be iterated WITHOUT running a live battle.
//
// Renders LOCAL-ONLY (renderDamageNumberLocal, not emitDamageNumber) so
// auditioning never broadcasts test numbers to players.
//
// Registers into the shared Developer Tools launcher, exactly like
// sfx-audition.js. Imported by director-boot.js + initialised on its ready hook,
// so it loads on a normal hard-reload with no Setup-relaunch.

import { log, warn } from "../logger.js";
import { registerDevTool } from "../dev-tools-menu.js";
import { renderDamageNumberLocal } from "./director-damage-numbers.js";

const PANEL_ID = "fud-dmgnum-audition-panel";
const STYLE_ID = "fud-dmgnum-audition-style";

// Each row → a payload (minus tokenUuid, filled at fire time). `burst` fires
// several in a row to exercise the multi-hit stagger.
const CASES = [
  { label: "Hit — physical 48",        payload: { kind: "loss", resource: "hp", amount: 48, element: "physical" } },
  { label: "Hit — fire 120",           payload: { kind: "loss", resource: "hp", amount: 120, element: "fire" } },
  { label: "Hit — ice 76",             payload: { kind: "loss", resource: "hp", amount: 76, element: "ice" } },
  { label: "Hit — bolt 340 (big)",     payload: { kind: "loss", resource: "hp", amount: 340, element: "bolt" } },
  { label: "WEAK! — fire 120",         payload: { kind: "loss", resource: "hp", amount: 120, element: "fire", affinity: "VU" } },
  { label: "RESIST — ice 30",          payload: { kind: "loss", resource: "hp", amount: 30, element: "ice", affinity: "RS" } },
  { label: "IMMUNE",                   payload: { kind: "immune", resource: "hp", amount: 0 } },
  { label: "ABSORB +64",               payload: { kind: "absorb", resource: "hp", amount: 64 } },
  { label: "CRITICAL — dark 210",      payload: { kind: "loss", resource: "hp", amount: 210, element: "dark", isCrit: true } },
  { label: "CRITICAL + WEAK! 260",     payload: { kind: "loss", resource: "hp", amount: 260, element: "fire", affinity: "VU", isCrit: true } },
  { label: "PIERCE — fire 80",         payload: { kind: "loss", resource: "hp", amount: 80, element: "fire", pierce: true } },
  { label: "MISS",                     payload: { kind: "miss" } },
  { label: "MP loss 22",               payload: { kind: "loss", resource: "mp", amount: 22 } },
  { label: "Shield −35",               payload: { kind: "loss", resource: "shield", amount: 35 } },
  { label: "Heal +88",                 payload: { kind: "gain", resource: "hp", amount: 88 } },
  { label: "MP gain +30",              payload: { kind: "gain", resource: "mp", amount: 30 } },
  { label: "Spend MP −15",             payload: { kind: "spend", resource: "mp", amount: 15 } },
  { label: "Multi-hit burst ×5",       burst: [40, 35, 60, 28, 90] },
];

let _booted = false;

function targetTokenUuid() {
  const controlled = canvas?.tokens?.controlled ?? [];
  const tok = controlled[0] ?? canvas?.tokens?.placeables?.[0] ?? null;
  return tok?.document?.uuid ?? null;
}

function fireCase(c) {
  const tokenUuid = targetTokenUuid();
  if (!tokenUuid) {
    ui.notifications?.warn("Damage Numbers: no token on canvas to anchor on.");
    return;
  }
  if (Array.isArray(c.burst)) {
    for (const amount of c.burst) {
      renderDamageNumberLocal({ kind: "loss", resource: "hp", amount, element: "physical", tokenUuid });
    }
    return;
  }
  renderDamageNumberLocal({ ...c.payload, tokenUuid });
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${PANEL_ID} {
  position: fixed; left: 70px; bottom: 70px; z-index: 100003;
  width: 240px; max-height: 70vh; overflow-y: auto;
  padding: 10px; border-radius: 10px;
  background: rgba(20,22,28,.96); border: 1px solid rgba(255,255,255,.12);
  box-shadow: 0 10px 30px rgba(0,0,0,.5); color: #e7eaf0;
  font-family: "Inter","Segoe UI",system-ui,sans-serif;
}
#${PANEL_ID} h4 { margin: 0 0 8px; font-size: 13px; letter-spacing: .3px; }
#${PANEL_ID} .fud-dmgnum-hint { font-size: 10px; opacity: .7; margin-bottom: 8px; }
#${PANEL_ID} button {
  display: block; width: 100%; text-align: left; margin: 3px 0;
  padding: 6px 9px; border-radius: 6px; cursor: pointer;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
  color: #e7eaf0; font-size: 12px;
}
#${PANEL_ID} button:hover { background: rgba(255,255,255,.14); }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function togglePanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) { existing.remove(); return; }
  ensureStyle();
  const panel = document.createElement("div");
  panel.id = PANEL_ID;

  const h = document.createElement("h4");
  h.textContent = "💥 Damage Numbers";
  panel.appendChild(h);

  const hint = document.createElement("div");
  hint.className = "fud-dmgnum-hint";
  hint.textContent = "Fires on your selected token (or the first on canvas). Local-only.";
  panel.appendChild(hint);

  for (const c of CASES) {
    const b = document.createElement("button");
    b.textContent = c.label;
    b.addEventListener("click", () => fireCase(c));
    panel.appendChild(b);
  }

  document.body.appendChild(panel);
}

export function initDamageNumberAudition() {
  if (_booted) return;
  try {
    registerDevTool({ id: "damage-numbers", icon: "💥", label: "Damage Numbers", onClick: togglePanel });
    _booted = true;
    log("damage-number-audition: registered as dev tool");
  } catch (e) {
    warn("initDamageNumberAudition threw", e);
  }
}
