// battle-focus.js — a quieter screen while a battle runs.
//
// 1. GM CHROME (GM client, while the GM desk is up): Foundry's scene tools,
//    scene list, logo, Players list and macro bar step away, and so do the
//    floating right-edge buttons (their tools are on the desk's command column)
//    and the dev-tools launcher. Each one can be brought back from the column's
//    "More" menu (remembered per browser); "Show everything" brings all of them
//    back until the battle ends. Nothing is removed: plain CSS on <body>.
//
// 2. QUIET TOKENS (every client, while a battle runs on this scene): token
//    effect icons show only what matters mid-fight: real statuses (the status
//    hub's conditions), anything tagged buff / debuff, and anything with a
//    duration. Permanent markers (camp results, meals, passive "ready" flags…)
//    hide. Hold Alt to see every icon. The filter wraps Token#_drawEffects:
//    a token's FIRST draw calls _drawEffects directly, not drawEffects.
//    Token status plan "G + E" (2026-10-27): in a battle NO token draws core
//    effect icons. Player characters' statuses live in their HUD card;
//    NPCs and monsters wear the status strip under their feet
//    (npc-status-strip.js), which listens to "fuBattleFocusChanged".

import { log } from "./logger.js";

const NS = "fabula-ultima-companion";
const STYLE_ID = "fud-battle-focus-style";
const SHOW_KEY = "fu-battlefocus-show";

// What the GM can bring back, and what each hides.
export const FOCUS_PARTS = [
  { key: "controls", label: "Scene tools", sel: ["#controls", "#logo"] },
  { key: "nav", label: "Scene list", sel: ["#navigation"] },
  { key: "players", label: "Players list", sel: ["#players"] },
  { key: "hotbar", label: "Macro bar", sel: ["#hotbar"] },
  { key: "devtools", label: "Developer tools", sel: ["#fud-devtools-btn", "#fud-devtools-children"] },
];
// The right-edge column. Clocks / Check / Roller / Effects are on the command
// column, Rewind / End on it too, EXP in its More menu, Start Battle is moot.
const RIGHT_EDGE = ["fud-rewindbtn-root", "oni-clock-gm-root", "oni-combatbtn-root", "oni-aem-button-root",
  "oni-creq-button-root", "oni-cr-button-root", "oni-expbtn-root"];

// The tools the command column opens: each is the existing button, clicked.
export const FOCUS_TOOLS = {
  clocks: { root: "oni-clock-gm-root", label: "Clocks", tip: "Clocks" },
  check: { root: "oni-creq-button-root", label: "Check", tip: "Request a check" },
  roll: { root: "oni-cr-button-root", label: "Roll", tip: "Check Roller" },
  effects: { root: "oni-aem-button-root", label: "Effects", tip: "Active Effect Manager" },
  exp: { root: "oni-expbtn-root", label: "EXP Awarder", tip: "EXP Awarder" },
};

const F = { on: false, all: false, show: {} };

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const hideAll = (sels) => sels.map((s) => `body.fud-bf-on:not(.fud-bf-all) ${s}`).join(",\n");
  const parts = FOCUS_PARTS.map((p) => p.sel.map((s) => `body.fud-bf-on:not(.fud-bf-all):not(.fud-bf-show-${p.key}) ${s}`).join(",\n")).join(",\n");
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `${hideAll(RIGHT_EDGE.map((id) => `#${id}`))},\n${parts} { display: none !important; }`;
  document.head.appendChild(st);
}

function readShow() {
  try { const v = JSON.parse(localStorage.getItem(SHOW_KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function paintBody() {
  const b = document.body;
  if (!b) return;
  b.classList.toggle("fud-bf-on", F.on);
  b.classList.toggle("fud-bf-all", F.on && F.all);
  for (const p of FOCUS_PARTS) b.classList.toggle(`fud-bf-show-${p.key}`, !!F.show[p.key]);
}

/** GM desk built / destroyed. Turning focus off also ends "Show everything". */
export function setGmFocus(on) {
  ensureStyle();
  F.on = !!on;
  if (!F.on) F.all = false;
  F.show = readShow();
  paintBody();
  log(`[BattleFocus] GM focus ${F.on ? "on" : "off"}`);
}
export function focusState() { return { on: F.on, all: F.all, show: { ...F.show } }; }
export function setFocusPart(key, shown) {
  if (!FOCUS_PARTS.some((p) => p.key === key)) return;
  F.show = { ...readShow(), [key]: !!shown };
  try { localStorage.setItem(SHOW_KEY, JSON.stringify(F.show)); } catch { /* */ }
  paintBody();
  // Opening the dev tools from the menu opens its stack too.
  if (key === "devtools" && shown && !document.getElementById("fud-devtools-children")) document.getElementById("fud-devtools-btn")?.click();
}
export function setFocusAll(on) { F.all = !!on; paintBody(); }

export function toolAvailable(name) { return !!document.getElementById(FOCUS_TOOLS[name]?.root ?? ""); }
/** Open a right-edge tool by clicking its (hidden) button. */
export function openTool(name) {
  const root = document.getElementById(FOCUS_TOOLS[name]?.root ?? "");
  const btn = root?.querySelector("button") ?? root?.firstElementChild;
  if (!btn) { ui.notifications?.warn(`${FOCUS_TOOLS[name]?.label ?? name} is not available right now.`); return false; }
  btn.click();
  return true;
}

// ── quiet tokens ─────────────────────────────────────────────────────────────
let _alt = false;
let _battle = false;

function battleHere() {
  try {
    const st = canvas?.scene?.getFlag?.(NS, "directorState");
    if (st?.dCombat?.started && !st.dCombat.ended && st.dCombat.combatants?.length) return true;
  } catch { /* */ }
  try { return !!globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.(); } catch { return false; }
}

let _statusIds = null;
function statusIds() {
  if (_statusIds) return _statusIds;
  const ids = new Set((CONFIG.statusEffects ?? []).map((s) => s?.id).filter(Boolean));
  ids.delete("permanent");   // camp / meal markers use it only to survive a rest
  _statusIds = ids;
  return ids;
}

/** Does this effect keep its token icon during a battle? */
export function isLoudEffect(e) {
  const tags = (Array.isArray(e?.system?.tags) ? e.system.tags : []).map((t) => String(t).toLowerCase());
  if (tags.includes("debuff") || tags.includes("buff")) return true;
  const d = e?.duration ?? {};
  if ((Number(d.rounds) || 0) > 0 || (Number(d.turns) || 0) > 0 || (Number(d.seconds) || 0) > 0) return true;
  const ids = statusIds();
  for (const s of e?.statuses ?? []) if (ids.has(s)) return true;
  return false;
}

/**
 * Does this effect keep its core token icon during a battle? Never: PCs show
 * statuses in their HUD card, NPCs in the status strip. Kept as a function so
 * a future exception has one place to live.
 */
export function keepIconInBattle(_actor, _e) { return false; }

/** Is a battle running on this scene (as Battle Focus sees it)? */
export function battleActive() { return _battle; }

function quietOn() { return _battle && !_alt; }
export function iconState() { return { battle: _battle, alt: _alt, here: battleHere() }; }

// Foundry reads actor.temporaryEffects synchronously at the top of
// _drawEffects, so the filtered list is an own property for exactly that
// synchronous slice and is restored before anything else can read it.
function wrapDrawEffects() {
  const proto = (CONFIG.Token?.objectClass ?? globalThis.Token)?.prototype;
  const orig = proto?._drawEffects;
  if (typeof orig !== "function" || orig.__fuQuiet) return;
  const wrapped = function (...args) {
    const actor = this.actor;
    if (!actor || !quietOn()) return orig.apply(this, args);
    let all;
    try { all = actor.temporaryEffects; } catch { return orig.apply(this, args); }
    const kept = all.filter((e) => keepIconInBattle(actor, e));
    if (kept.length === all.length) return orig.apply(this, args);
    const prev = Object.getOwnPropertyDescriptor(actor, "temporaryEffects");
    Object.defineProperty(actor, "temporaryEffects", { value: kept, configurable: true });
    try { return orig.apply(this, args); }
    finally { try { if (prev) Object.defineProperty(actor, "temporaryEffects", prev); else delete actor.temporaryEffects; } catch { /* */ } }
  };
  wrapped.__fuQuiet = true;
  proto._drawEffects = wrapped;
}

function redrawIcons() {
  for (const t of canvas?.tokens?.placeables ?? []) {
    try { t.renderFlags.set({ redrawEffects: true }); } catch { /* */ }
  }
}
function syncBattle() {
  const now = battleHere();
  if (now === _battle) return;
  _battle = now;
  redrawIcons();
  Hooks.callAll("fuBattleFocusChanged", _battle);
}
function typing(ev) {
  const t = ev.target;
  return !!t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName ?? ""));
}
function setAlt(on) {
  if (_alt === on) return;
  _alt = on;
  if (_battle) redrawIcons();
}

Hooks.once("ready", () => {
  wrapDrawEffects();
  _battle = battleHere();
  Hooks.callAll("fuBattleFocusChanged", _battle);
  window.addEventListener("keydown", (ev) => { if (ev.key === "Alt" && !ev.repeat && !typing(ev)) setAlt(true); }, true);
  window.addEventListener("keyup", (ev) => { if (ev.key === "Alt") setAlt(false); }, true);
  window.addEventListener("blur", () => setAlt(false));
  // The scene's tokens drew BEFORE canvasReady fires, with the previous scene's
  // battle state: a battle scene must redraw them quiet.
  Hooks.on("canvasReady", () => {
    _statusIds = null; _battle = battleHere();
    if (_battle) redrawIcons();
    Hooks.callAll("fuBattleFocusChanged", _battle);
  });
  Hooks.on("updateScene", (scene, change) => { if (scene?.id === canvas?.scene?.id && change?.flags?.[NS] !== undefined) syncBattle(); });
  Hooks.on("fu-director-started", () => syncBattle());
  Hooks.on("fu-director-stopped", () => syncBattle());
  // The hooks above can run before the director reports itself running (and a
  // player sees only the scene flag), so a cheap poll catches every start / end.
  setInterval(syncBattle, 1000);
  if (_battle) redrawIcons();
});
