// ============================================================================
// Conflict Event System — the panel players read in battle.
//
//   emblem      a parchment seal (a four-point star in a ring) above the dice
//               button, in the event's colour. Hover shows the event's name.
//   label       the emblem's name + one line, eased in for 5 s after the
//               Battle Start plate — only when conflict-event-intro.js says so
//               (first time per dungeon trip, or a Champion battle).
//   tutorial    I or a click dims the screen and shows the event's rules in the
//               middle, one page per rule, each with a shot of it happening.
//   pulse       the emblem swells once when the event does something
//               (pulseConflictEventEmblem, called by the event's own FX code).
//
// Every client builds its own view from data it already has: the battle
// scene's flags (the selection and the saved director state, whose payload
// carries any sim / Test Battle override) and, at battle start, the plate's
// broadcast. No socket of its own, no writes — except the GM's trip memory in
// planConflictEventIntro. An event with no `ruling` shows nothing at all.
//
// Opening it never pauses the battle and the battle never closes it: only this
// player's screen dims, and only they close it.
// ============================================================================

import { getConflictEvent } from "./conflict-event-registry.js";
import { resolveConflictEventId } from "./conflict-event-binding.js";
import { normalizeTrip, stepTrip, decideIntro, isChampionActor } from "./conflict-event-intro.js";
import { playSfx, preloadSfx } from "../battle-director/director-sfx.js";
import { hudScale } from "../battle-director/director-player-hud.js";

const NS = "fabula-ultima-companion";
const TAG = "[FU][ConflictEventPanel]";
const log = (...a) => console.debug(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

/** World setting: the GM's per-trip memory of which events were introduced. */
export const TRIP_SETTING = "conflictEventTrip";
/** Fired locally on every client once the Battle Start plate has closed. */
export const PLATE_CLOSED_HOOK = "fu-battle-start-closed";

const SOUND_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
const SFX = {
  open: SOUND_BASE + "BattleCursor_3.wav",
  nav: SOUND_BASE + "BattleCursor_4.wav",
  volume: 0.5,
};

const LABEL_MS = 5000;          // how long the battle-start label stays out
const PULSE_MERGE_MS = 1000;    // triggers closer than this pulse once
const PLACE_EVERY_MS = 400;     // the emblem follows the dice / desk while shown
const HIDDEN_HOLD_MS = 30000;   // a hidden tab keeps the label this long for its return

const ROOT_ID = "fu-cep-emblem";
const VEIL_ID = "fu-cep-veil";
const STYLE_ID = "fu-cep-style";

const SIGIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="M12 4.2 13.7 10.3 19.8 12 13.7 13.7 12 19.8 10.3 13.7 4.2 12 10.3 10.3z"/></svg>';

const S = {
  eventId: null,     // the event the emblem is showing
  ruling: null,
  name: "",
  plate: null,       // { sceneId, eventId } from the last Battle Start plate on this client
  sawLive: false,    // the director state for that battle has been seen (so its absence = battle over)
  open: false,
  page: 0,
  placeTimer: null,
  labelTimer: null,
  lastPulse: 0,
  decoded: new Map(),
  hooksOn: false,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
/** Page text: plain text, with **bold** marking the words to highlight. */
const markup = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<em>$1</em>");
const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

// ── Settings + keybinding (init) ────────────────────────────────────────────

/** Call from an `init` hook. */
export function registerConflictEventPanelSettings() {
  game.settings.register(NS, TRIP_SETTING, {
    scope: "world", config: false, type: Object,
    default: { inDungeon: false, trip: 0, shown: [], lastBattleAt: 0 },
  });
  game.keybindings.register(NS, "openConflictEventPanel", {
    name: "Open Conflict Event",
    hint: "In battle, show the rules of the scene's Conflict Event.",
    editable: [{ key: "KeyI" }],
    onDown: () => {
      if (S.open || !S.ruling) return false;
      openTutorial();
      return true;
    },
  });
}

// ── GM: trip memory + the battle-start decision ─────────────────────────────

function isActiveGM() {
  return !!game.user?.isGM && (game.users?.activeGM?.id ?? game.user.id) === game.user.id;
}

function readTrip() {
  try { return normalizeTrip(game.settings.get(NS, TRIP_SETTING)); }
  catch { return normalizeTrip(null); }
}

function sceneModeOf(scene) {
  return scene?.flags?.[NS]?.oniFabula?.general?.sceneMode ?? "none";
}

/**
 * Called by director-init (on the director host) just before the Battle Start
 * plate. Returns what every client needs to show the emblem and, maybe, the
 * label — or null when the scene's event has nothing for players to read.
 */
export async function planConflictEventIntro({ battleScene = null, payload = null, enemyTokens = [] } = {}) {
  const { id } = resolveConflictEventId({ scene: battleScene, payload });
  const event = getConflictEvent(id);
  if (!event?.ruling) return null;
  const champion = (enemyTokens ?? []).some((t) => isChampionActor(t?.actor));
  const { introduce, state } = decideIntro(readTrip(), { eventId: id, champion });
  if (game.user?.isGM) {
    try { await game.settings.set(NS, TRIP_SETTING, state); }
    catch (e) { warn("trip memory write failed", e); }
  }
  log(`battle start — ${id}: ${introduce ? "introduce" : "already introduced this trip"}${champion ? " (Champion)" : ""}`);
  return { eventId: id, introduce, champion };
}

function onSceneActivated(scene, changes) {
  if (changes?.active !== true || !isActiveGM()) return;
  const before = readTrip();
  const after = stepTrip(before, sceneModeOf(scene));
  if (after === before || JSON.stringify(after) === JSON.stringify(before)) return;
  if (after.trip !== before.trip) log(`new dungeon trip (#${after.trip}) — ${scene?.name}`);
  game.settings.set(NS, TRIP_SETTING, after).catch((e) => warn("trip memory write failed", e));
}

// ── Which event, if any, this screen should show ────────────────────────────

function liveState(scene) {
  let st = null;
  try { st = scene?.getFlag?.(NS, "directorState") ?? null; } catch { st = null; }
  const live = !!(st?.dCombat?.started && !st.dCombat.ended && st.dCombat.combatants?.length);
  return live ? st : null;
}

function currentEventId() {
  const scene = canvas?.scene ?? null;
  if (!scene) return null;
  const st = liveState(scene);
  if (st) {
    if (S.plate?.sceneId === scene.id) S.sawLive = true;
    return resolveConflictEventId({ scene, payload: st.payload ?? null }).id;
  }
  // Between the plate and the director's first save there is no state yet.
  if (S.plate?.sceneId === scene.id && !S.sawLive) return S.plate.eventId;
  if (S.plate?.sceneId === scene.id) { S.plate = null; S.sawLive = false; }
  return null;
}

function reconcile() {
  try {
    const id = currentEventId();
    const event = id ? getConflictEvent(id) : null;
    if (!event?.ruling) return hideAll();
    if (S.eventId === id && document.getElementById(ROOT_ID)) return;
    showEmblem(id, event);
  } catch (e) { warn("reconcile threw", e); }
}

let _reconcileQueued = false;
function queueReconcile() {
  if (_reconcileQueued) return;
  _reconcileQueued = true;
  setTimeout(() => { _reconcileQueued = false; reconcile(); }, 60);
}

// ── Emblem ──────────────────────────────────────────────────────────────────

function isShown(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
}

/** Above the GM desk's right end, else above the dice button, else bottom right. */
function place() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const SIZE = 46;
  const desk = document.getElementById("fud-gm-desk");
  const deskBox = desk && isShown(desk) ? desk.getBoundingClientRect() : null;
  const dice = document.getElementById("oni-cr-button");
  let left, top;
  if (deskBox && deskBox.height > 40) {
    left = deskBox.right - SIZE - 6;
    top = deskBox.top - SIZE - 10;
  } else if (dice && isShown(dice)) {
    const r = dice.getBoundingClientRect();
    left = r.left + r.width / 2 - SIZE / 2;
    top = r.top - SIZE - 8;
  } else {
    left = window.innerWidth - 330 - SIZE;
    top = window.innerHeight - 110 - SIZE;
  }
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
}

function showEmblem(id, event) {
  ensureStyle();
  hideAll();
  S.eventId = id;
  S.ruling = event.ruling;
  S.name = String(event.label ?? id);
  const root = document.createElement("button");
  root.id = ROOT_ID;
  root.type = "button";
  root.style.setProperty("--accent", event.ruling.color);
  root.setAttribute("aria-label", `${S.name}: open Conflict Event`);
  root.setAttribute("aria-expanded", "false");
  root.innerHTML = `<span class="gem"></span><span class="glyph">${SIGIL}</span>`
    + `<span class="hint"><b>${esc(S.name)}</b><kbd>I</kbd>${event.ruling.line ? `<span class="line">${esc(event.ruling.line)}</span>` : ""}</span>`;
  root.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.open ? closeTutorial() : openTutorial(); });
  document.body.appendChild(root);
  place();
  S.placeTimer = setInterval(place, PLACE_EVERY_MS);
  preloadPages();
  log(`emblem up — ${id}`);
}

function hideAll() {
  closeTutorial({ silent: true });
  if (S.placeTimer) { clearInterval(S.placeTimer); S.placeTimer = null; }
  if (S.labelTimer) { clearTimeout(S.labelTimer); S.labelTimer = null; }
  document.getElementById(ROOT_ID)?.remove();
  S.eventId = null;
  S.ruling = null;
}

/** The battle-start label: eased in on the emblem already on screen, then out. */
function showLabel() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const run = () => {
    const el = document.getElementById(ROOT_ID);
    if (!el) return;
    el.classList.remove("unfurl");
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("unfurl")));
    if (S.labelTimer) clearTimeout(S.labelTimer);
    S.labelTimer = setTimeout(() => { el.classList.remove("unfurl"); S.labelTimer = null; }, LABEL_MS);
  };
  // A hidden tab (the player alt-tabbed) keeps it for their return instead of
  // spending it on nobody.
  if (!document.hidden) return run();
  const until = Date.now() + HIDDEN_HOLD_MS;
  const onVis = () => {
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", onVis);
    if (Date.now() <= until) run();
  };
  document.addEventListener("visibilitychange", onVis);
}

/** One swell + ring in the event's colour. Called by an event's FX on every client. */
export function pulseConflictEventEmblem() {
  const el = document.getElementById(ROOT_ID);
  if (!el || reducedMotion()) return;
  const now = performance.now();
  if (now - S.lastPulse < PULSE_MERGE_MS) return;
  S.lastPulse = now;
  el.classList.remove("fire");
  void el.offsetWidth;
  el.classList.add("fire");
}

// ── Tutorial screen ─────────────────────────────────────────────────────────

function preloadPages() {
  for (const p of S.ruling?.pages ?? []) {
    if (!p.image || S.decoded.has(p.image)) continue;
    const im = new Image();
    im.src = p.image;
    S.decoded.set(p.image, im.decode().catch(() => {}));
  }
}

function openTutorial() {
  if (!S.ruling || S.open) return;
  preloadPages();
  S.open = true;
  S.page = 0;
  const pages = S.ruling.pages;
  const veil = document.createElement("div");
  veil.id = VEIL_ID;
  veil.style.setProperty("--accent", S.ruling.color);
  veil.innerHTML = `<div class="tut" role="dialog" aria-label="${esc(S.name)}" style="transform:scale(${hudScale().toFixed(3)})">
    <div class="t-head"><span class="t-sigil">${SIGIL}</span><div><small>Conflict Event</small><b>${esc(S.name)}</b></div></div>
    <div class="t-shot">${pages[0].image ? `<img src="${esc(pages[0].image)}" alt="">` : ""}</div>
    <p class="t-text">${markup(pages[0].text)}</p>
    <div class="t-foot">
      <button type="button" data-prev disabled><kbd>◀</kbd>Back</button>
      <span class="dots">${pages.map((_, i) => `<i class="${i === 0 ? "on" : ""}">◆</i>`).join("")}</span>
      <button type="button" data-next><kbd>Z</kbd><span class="t-next">${pages.length > 1 ? "Next" : "Done"}</span></button>
      <button type="button" data-close><kbd>X</kbd>Close</button>
    </div></div>`;
  veil.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-close]")) return closeTutorial();
    if (ev.target.closest("[data-next]")) return flip(1);
    if (ev.target.closest("[data-prev]")) return flip(-1);
    if (ev.target === veil) closeTutorial();
  });
  veil.addEventListener("contextmenu", (ev) => { ev.preventDefault(); closeTutorial(); });
  document.body.appendChild(veil);
  document.getElementById(ROOT_ID)?.setAttribute("aria-expanded", "true");
  window.addEventListener("keydown", onKey, true);
  playSfx(SFX.open, SFX.volume);
}

function closeTutorial({ silent = false } = {}) {
  if (!S.open && !document.getElementById(VEIL_ID)) return;
  S.open = false;
  window.removeEventListener("keydown", onKey, true);
  const veil = document.getElementById(VEIL_ID);
  document.getElementById(ROOT_ID)?.setAttribute("aria-expanded", "false");
  if (!veil) return;
  if (silent || reducedMotion()) { veil.remove(); return; }
  veil.classList.add("leaving");
  setTimeout(() => veil.remove(), 180);
}

/** A page turn updates the open card in place, so nothing replays or flickers. */
async function flip(d) {
  const pages = S.ruling?.pages ?? [];
  const next = S.page + d;
  if (next >= pages.length) return closeTutorial();
  if (next < 0) return;
  S.page = next;
  playSfx(SFX.nav, SFX.volume);
  const veil = document.getElementById(VEIL_ID);
  const box = veil?.querySelector(".t-shot");
  const text = veil?.querySelector(".t-text");
  if (!box || !text) return;
  const p = pages[next];
  if (p.image) await S.decoded.get(p.image);
  if (S.page !== next || !S.open) return;   // turned again while this one decoded
  box.style.setProperty("--dx", `${d * 36}px`);
  box.querySelectorAll("img").forEach((old) => {
    old.classList.remove("in");
    old.classList.add("out");
    old.addEventListener("animationend", () => old.remove(), { once: true });
    setTimeout(() => old.remove(), 600);
  });
  if (p.image) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = p.image;
    img.className = "in";
    box.appendChild(img);
  }
  text.classList.add("swap");
  setTimeout(() => { if (S.page === next) { text.innerHTML = markup(p.text); text.classList.remove("swap"); } }, 160);
  veil.querySelectorAll(".dots i").forEach((dot, i) => dot.classList.toggle("on", i === next));
  veil.querySelector("[data-prev]").disabled = next === 0;
  veil.querySelector(".t-next").textContent = next < pages.length - 1 ? "Next" : "Done";
}

// One key, one meaning, consumed here so the turn menu underneath never sees it.
function onKey(ev) {
  if (!S.open) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
  const act = {
    KeyI: closeTutorial, Escape: closeTutorial, KeyX: closeTutorial,
    KeyZ: () => flip(1), Enter: () => flip(1), ArrowRight: () => flip(1), KeyD: () => flip(1),
    ArrowLeft: () => flip(-1), KeyA: () => flip(-1),
  }[ev.code];
  if (!act) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (!ev.repeat) act();
}

// ── Boot ────────────────────────────────────────────────────────────────────

/** Idempotent — called on every client from director-boot's ready hook. */
export function initConflictEventPanel() {
  if (S.hooksOn) return;
  S.hooksOn = true;
  preloadSfx([SFX.open, SFX.nav]).catch(() => {});

  Hooks.on(PLATE_CLOSED_HOOK, (payload) => {
    const ci = payload?.conflictIntro;
    if (!ci?.eventId) return;
    S.plate = { sceneId: canvas?.scene?.id ?? null, eventId: ci.eventId };
    S.sawLive = false;
    reconcile();
    if (ci.introduce) showLabel();
  });
  Hooks.on("canvasReady", () => queueReconcile());
  Hooks.on("updateScene", (scene, changes) => {
    onSceneActivated(scene, changes);
    if (scene?.id === canvas?.scene?.id && changes?.flags?.[NS]) queueReconcile();
  });
  window.addEventListener("resize", () => place());

  reconcile();   // an F5 or a late join mid-battle
  log("ready");
}

// ── Style ───────────────────────────────────────────────────────────────────

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#${ROOT_ID} { all: unset; position: fixed; z-index: 85; width: 46px; height: 46px; display: grid; place-items: center; cursor: pointer; --accent: #b3261e; }
#${ROOT_ID} .gem { position: absolute; width: 31px; height: 31px; transform: rotate(45deg); border-radius: 6px; border: 2px solid #7a6a55;
  background: radial-gradient(circle at 35% 30%, #fffaf0, #f6f1e6 45%, #ebe3d0);
  box-shadow: inset 0 0 0 1.5px rgba(213,182,122,.95), inset 0 -3px 5px rgba(122,106,85,.22), 0 3px 8px rgba(0,0,0,.5);
  transition: transform 160ms ease, box-shadow 160ms ease; }
#${ROOT_ID} .glyph { position: relative; width: 19px; height: 19px; color: var(--accent); filter: drop-shadow(0 1px 0 rgba(255,255,255,.7)); }
#${ROOT_ID} .glyph svg { width: 100%; height: 100%; display: block; }
#${ROOT_ID}:hover .gem, #${ROOT_ID}:focus-visible .gem { transform: rotate(45deg) scale(1.07);
  box-shadow: inset 0 0 0 1.5px #f0d9a4, inset 0 -3px 5px rgba(122,106,85,.22), 0 0 0 2px rgba(240,217,164,.55), 0 4px 10px rgba(0,0,0,.5); }
#${ROOT_ID}[aria-expanded="true"] .gem { background: linear-gradient(180deg, #f0d9a4, #d5b67a); }
#${ROOT_ID}::after { content: ""; position: absolute; width: 31px; height: 31px; transform: rotate(45deg); border-radius: 6px; border: 2px solid var(--accent); opacity: 0; pointer-events: none; }
#${ROOT_ID}.fire::after { animation: fu-cep-ring 760ms cubic-bezier(.2,.7,.3,1); }
#${ROOT_ID}.fire .gem { animation: fu-cep-swell 520ms cubic-bezier(.3,1.6,.5,1); }
#${ROOT_ID}.fire .glyph { animation: fu-cep-glint 760ms ease-out; }
@keyframes fu-cep-ring { 0% { opacity: .85; transform: rotate(45deg) scale(1); } 100% { opacity: 0; transform: rotate(45deg) scale(1.9); } }
@keyframes fu-cep-swell { 0% { transform: rotate(45deg) scale(1); } 40% { transform: rotate(45deg) scale(1.16); } 100% { transform: rotate(45deg) scale(1); } }
@keyframes fu-cep-glint { 0% { filter: drop-shadow(0 0 0 var(--accent)) brightness(1); } 30% { filter: drop-shadow(0 0 6px var(--accent)) brightness(1.5); } 100% { filter: drop-shadow(0 1px 0 rgba(255,255,255,.7)) brightness(1); } }
#${ROOT_ID} .hint { position: absolute; right: 2px; bottom: calc(100% + 4px); display: flex; align-items: center; gap: 8px; padding: 7px 9px;
  color: #f6ecd6; background: #1f1a14; border: 1px solid #d5b67a; border-radius: 6px; white-space: nowrap; font: 400 15px/1.25 "Signika", sans-serif;
  opacity: 0; visibility: hidden; transform: translateY(8px) scale(.96); transform-origin: 100% 100%; pointer-events: none;
  transition: opacity 160ms ease-in, transform 160ms ease-in, visibility 0s linear 160ms; }
#${ROOT_ID}:hover .hint, #${ROOT_ID}:focus-visible .hint, #${ROOT_ID}.unfurl .hint { opacity: 1; visibility: visible; transform: none;
  transition: opacity 320ms cubic-bezier(.22,.8,.3,1), transform 380ms cubic-bezier(.22,.8,.3,1), visibility 0s; }
#${ROOT_ID} .hint kbd { font: 600 11px/1 "Signika", sans-serif; color: #1f1a14; background: #f6f1e6; border-radius: 3px; padding: 3px 6px; }
#${ROOT_ID} .hint .line { display: none; color: #e9dfc9; }
#${ROOT_ID}.unfurl .hint { width: 340px; flex-wrap: wrap; white-space: normal; }
#${ROOT_ID}.unfurl .hint .line { display: block; order: 3; }

#${VEIL_ID} { position: fixed; inset: 0; z-index: 9000; background: rgba(8,6,4,.74); display: grid; place-items: center; animation: fu-cep-veil 200ms ease-out; --accent: #b3261e; }
#${VEIL_ID}.leaving { opacity: 0; transition: opacity 160ms ease-in; }
@keyframes fu-cep-veil { from { opacity: 0; } to { opacity: 1; } }
#${VEIL_ID} .tut { width: 720px; color: #3a3228; background: linear-gradient(180deg, #f6f1e6, #ebe3d0); border: 2px solid #7a6a55; border-radius: 10px;
  box-shadow: 0 0 0 1px rgba(213,182,122,.6) inset, 0 18px 44px rgba(0,0,0,.6); overflow: hidden; font-family: "Signika", sans-serif; }
#${VEIL_ID} .tut > * { animation: fu-cep-rise 260ms cubic-bezier(.2,.8,.3,1) both; }
@keyframes fu-cep-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
#${VEIL_ID} .t-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: linear-gradient(180deg, #2b241b, #1f1a14); color: #f6ecd6; }
#${VEIL_ID} .t-sigil { width: 26px; height: 26px; color: var(--accent); flex: none; filter: drop-shadow(0 0 3px rgba(255,255,255,.25)); }
#${VEIL_ID} .t-sigil svg { width: 100%; height: 100%; display: block; }
#${VEIL_ID} .t-head small { display: block; font: 600 11px/1.2 "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #d5b67a; }
#${VEIL_ID} .t-head b { font: 600 24px/1.15 "Cinzel", Georgia, serif; letter-spacing: .02em; }
#${VEIL_ID} .t-shot { margin: 16px 40px 0; position: relative; border: 2px solid #7a6a55; border-radius: 6px; overflow: hidden; background: #000;
  box-shadow: 0 0 0 1px rgba(213,182,122,.8), 0 4px 10px rgba(0,0,0,.3); aspect-ratio: 16 / 9; }
#${VEIL_ID} .t-shot img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
#${VEIL_ID} .t-shot img.in { animation: fu-cep-shot-in 360ms cubic-bezier(.22,.8,.3,1) both; }
#${VEIL_ID} .t-shot img.out { animation: fu-cep-shot-out 360ms ease both; }
@keyframes fu-cep-shot-in { from { opacity: 0; transform: translateX(var(--dx, 36px)); } to { opacity: 1; transform: none; } }
@keyframes fu-cep-shot-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(calc(var(--dx, 36px) * -0.6)); } }
#${VEIL_ID} .t-text { margin: 14px 40px 0; min-height: 3.1em; font: 400 21px/1.42 "Signika", sans-serif; text-wrap: pretty; transition: opacity 160ms ease, transform 160ms ease; }
#${VEIL_ID} .t-text.swap { opacity: 0; transform: translateY(4px); }
#${VEIL_ID} .t-text em { font-style: normal; font-weight: 600; color: #7d4f12; }
#${VEIL_ID} .t-foot { display: flex; align-items: center; gap: 14px; margin-top: 14px; padding: 10px 16px; border-top: 1px solid rgba(122,106,85,.45);
  background: rgba(213,182,122,.18); font: 500 14px/1 "Signika", sans-serif; color: #6d6152; }
#${VEIL_ID} .t-foot .dots { flex: 1; display: flex; gap: 7px; justify-content: center; font-size: 12px; color: #9c7a3a; }
#${VEIL_ID} .t-foot .dots i { font-style: normal; opacity: .35; transition: opacity 200ms ease; }
#${VEIL_ID} .t-foot .dots i.on { opacity: 1; }
#${VEIL_ID} .t-foot kbd { font: 600 12px/1 "Signika", sans-serif; color: #f6ecd6; background: #1f1a14; border-radius: 3px; padding: 4px 7px; }
#${VEIL_ID} .t-foot button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; color: #6d6152; }
#${VEIL_ID} .t-foot button:hover { color: #3a3228; }
#${VEIL_ID} .t-foot button[disabled] { opacity: .3; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  #${VEIL_ID}, #${VEIL_ID} .tut > *, #${VEIL_ID} .t-shot img.in, #${VEIL_ID} .t-shot img.out, #${ROOT_ID}.fire::after, #${ROOT_ID}.fire .gem { animation: none; }
  #${VEIL_ID} .t-text { transition: none; }
}`;
  document.head.appendChild(st);
}
