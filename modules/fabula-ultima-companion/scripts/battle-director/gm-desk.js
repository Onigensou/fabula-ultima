// gm-desk.js — the GM Battle Desk.
//
// Every control the GM has in a battle, gathered into one desk at the bottom of
// the GM's screen (approved mockup v15, claude.ai/artifact/FG3n9ZEqL5S4L1WwDXsCUg,
// 2026-10-13). PORT ONLY: each part stands in for something the GM could
// already do; nothing here adds a rule.
//
//   ┌─ Units ────────────────────────────┐┌─ Console ──────────────────────────┐
//   │ Enemies          │ Party           ││ who / what is being decided        │
//   │ ● Bandit A 45/45 │ ● Keren  96/96  ││ commands │ options │ detail        │
//   │ …                │ …   ⚡1 Your call││ footer: summary · Back · Confirm   │
//   └────────────────────────────────────┘└────────────────────────────────────┘
//   battle bar (top LEFT, under the scene navigation — the top right belongs
//   to the Event Clocks): AI · Summons · Turn · Round · Rewind · End
//
//   ROSTER    every combatant (both sides, guests, summons) — replaces the GM's
//             compact party cards. A creature with an open reaction menu gets a
//             ⚡ cell; one that may take the turn gets a ▶.
//   CONSOLE   where every GM decision is made. It hosts the same drawer views a
//             player's plate does (drawer-views.js) — the command window, lists,
//             targets, numbers, die swaps — plus two things only the GM has:
//             Take Turn tiles (turn-picker.js, instead of pills on the tokens)
//             and the reaction menus of every creature (reaction-menu.js,
//             instead of blades by the tokens), answered in order (flow B).
//   LOCK      Watch | Act, per GM. A player's own decision (their turn, their
//             reaction, their Take Turn) is shown live but locked in Watch; Act
//             lets the GM answer for them, first answer wins as before.
//
// The ACTION CARD is untouched and stays above the desk: while it is open the
// console steps aside and Enter / Esc belong to the card.
//
// Per GM (this browser): desk size S / M / L, folded to its header strips
// (it unfolds by itself when a decision needs this GM), and a held key that
// makes the whole desk see-through ("peek", Configure Controls). Two GMs see
// which line / tile the other one has open (presence), first answer wins.
//
// Layers: the console shows ONE layer at a time — "step" (the compose chain and
// any picker), "take" (Take Turn tiles) or "react" (reaction menus) — the one
// opened most recently that still has something in it. A player's step can be
// replaced by a live MIRROR of that player's own drawer (sent by their client).

import { log, warn } from "./logger.js";
import { playUiHoverSfx, playUiClickSfx, playUiOpenSfx, playUiBackSfx } from "./director-ui-sfx.js";
import { ensureDrawerStyles, escapeHtml as esc, pickDocked } from "./drawer-views.js";
import { rightEdgeReserve, hudScale, readUnitInfo } from "./director-player-hud.js";
import { tabAlert, tabAlertClear } from "./tab-alert.js";
import { setGmFocus, focusState, setFocusPart, setFocusAll, FOCUS_PARTS, FOCUS_TOOLS, toolAvailable, openTool } from "./battle-focus.js";

const MODULE_ID = "fabula-ultima-companion";
const STYLE_ID = "fud-gm-desk-style";
const ROOT_ID = "fud-gm-desk";
const ACTION_MIRROR = "FU_GMD_MIRROR";   // player → GMs: their drawer, live
const ACTION_CMD = "FU_GMD_CMD";         // secondary GM → host GM: a battle-bar command
const ACTION_PRESENCE = "FU_GMD_PRESENCE"; // GM → other GMs: the line / tile I have open
const ACTION_LOG = "FU_GMD_LOG";         // host GM → other GMs: an action resolved (Recent)
const LOCK_KEY = "fu-gmdesk-locked";
const OFF_KEY = "fu-gmdesk-off";
const SIZE_KEY = "fu-gmdesk-size";
const FOLD_KEY = "fu-gmdesk-folded";
// Desk size, a multiplier on the HUD's own scale. Capped so the desk always
// fits: MIN_SPAN stage px for the two panels (roster 2 columns + console 3).
const SIZES = { s: 0.85, m: 1, l: 1.2 };
const MIN_SPAN = 1500;
const LOG_MAX = 8;

// Stage layout at 1920×1080 (the mockup's numbers). The whole desk scales with
// the HUD (hudScale) so a smaller screen gets the same layout, smaller.
const L = { left: 20, gap: 10, height: 290, minH: 210, base: 20, rosterShare: 870 / 1726, barTop: 14, barW: 64 };
const HOTKEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const DONE_MS = 4000;          // how long "Applied / Passed" stays on a roster line
const CLOSE_GRACE_MS = 160;    // a reaction menu re-opens after a Use: keep its line selected

// ── state ─────────────────────────────────────────────────────────────────────
const D = {
  root: null, bar: null, roster: null, con: null, chd: null, cbody: null,
  layers: {}, offFns: [], placeKey: "",
  party: new Set(),          // HUD party actor ids (party extras on their lines)
  units: null,               // last turn-actions snapshot (all combatants)
  rows: new Map(),           // unit id → row record
  turnStatus: null,
  locked: true,
  cardOpen: false,
  z: { step: 0, take: 0, react: 0 }, seq: 0,
  take: null,                // { entries, pick, cur, side }
  rx: new Map(),             // key → reaction entry
  rxOrder: [],
  rxCur: null,
  done: new Map(),           // tokenId → { text, until }
  step: null,                // { cmdsEl, workEl, detailEl, holds, holdActorId, overlay, under, crumb, card, budget }
  mirror: new Map(),         // actorId → { html, crumb, card, open, userId, at }
  ring: null,
  ctx: null,                 // { actorId, tokenId, at }: whose follow-up a picker without its own actor belongs to
  size: "m", folded: false, foldShown: false, peek: false,
  hover: null,               // roster row id under the pointer (its token gets the ring)
  ringLit: null,             // { uid, until }: a clicked line's ring glows for a moment
  presence: new Map(),       // other GM's userId → { tokenId, what, at }
  focusSig: "",
  aiPrev: { key: "", data: null, busy: false },
  swapSig: null,             // what the console showed last (its content fades in when this changes)
  hoverKey: null,            // the bar / header control under the pointer (hover cue)
};
const CTX_MS = 20000;        // a reaction / card pill's follow-up pickers open within this
let _units = null;           // survives a desk rebuild (snapshot arrives on every client)
let _socket = null;
let _log = [];               // Recent: { round, who, action, rows } newest first
let _ap = null;              // { a: enemy-autopilot, s: summon-autopilot } once loaded

export function deskActive() { return !!D.root?.isConnected; }
export function deskEnabled() {
  if (!game.user?.isGM) return false;
  try { return localStorage.getItem(OFF_KEY) !== "1"; } catch { return true; }
}

// ── small helpers ─────────────────────────────────────────────────────────────
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pctOf = (v, m) => `${(clamp(m > 0 ? v / m : 0, 0, 1) * 100).toFixed(2)}%`;
const isVideo = (u) => /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(String(u ?? ""));
function bump(layer) { D.z[layer] = ++D.seq; }
function tokenOf(u) {
  let doc = null;
  try { if (u?.tokenUuid) doc = fromUuidSync(u.tokenUuid); } catch { /* */ }
  if (!doc && u?.tokenId) doc = canvas?.tokens?.get(u.tokenId)?.document ?? null;
  return doc;
}
function baseActorOf(actor) {
  if (!actor) return null;
  return game.actors?.get(actor.id) ?? actor;
}
// The player who decides for this creature: the one whose character it is, else
// an EXPLICIT owner (default ownership makes every player own Zarg).
export function playerOwnerOf(actor) {
  const base = baseActorOf(actor);
  if (!base) return null;
  // Same answer as the battle routing (spectators never decide).
  const S = globalThis.FUCompanion?.api?.Spectator;
  if (S?.deciderUserIdForActor) {
    const id = S.deciderUserIdForActor(base, { requireActive: false });
    return id ? game.users?.get(id) ?? null : null;
  }
  const users = (game.users?.contents ?? []).filter((u) => !u.isGM);
  return users.find((u) => u.character?.id === base.id)
    ?? users.find((u) => (base.ownership?.[u.id] ?? 0) >= 3) ?? null;
}
// Only an ONLINE player can be deciding; an away player's creature is the GM's.
function liveOwnerOf(actor) {
  const u = playerOwnerOf(actor);
  return u?.active ? u : null;
}
function lockedFor(actor) { return !!(D.locked && liveOwnerOf(actor)); }

// ── motion ────────────────────────────────────────────────────────────────────
// The desk arrives and leaves with a short move instead of appearing in one
// frame, and the console's content fades in when it changes. Presentation only
// (WAAPI on opacity / translate, nothing left behind once a move has played);
// a client that asks for reduced motion gets the desk as it was.
const MOTION = { in: 420, out: 280, swap: 220, tile: 260, tileGap: 60, fold: 260 };
const EASE = "cubic-bezier(.2,.8,.2,1)";
const RISE = [{ opacity: 0, translate: "0 28px" }, { opacity: 1, translate: "0 0" }];
const DROP = [{ opacity: 0, translate: "0 -18px" }, { opacity: 1, translate: "0 0" }];
let _ghost = null;           // the desk that was just destroyed, until it is known to stay gone
function motionOk() {
  try { return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return true; }
}
function move(el, frames, opts) {
  try { return el?.animate?.(frames, { easing: EASE, ...opts }) ?? null; } catch { return null; }
}
// The bar drops in from the top, the two panels rise from the bottom. Behind
// the battle-start glass nobody would see it, so it waits for the glass.
function enterDesk() {
  const root = D.root;
  if (!root) return;
  const run = () => {
    if (D.root !== root) return;
    if (document.body.classList.contains("fuc-shatter-active")) { setTimeout(run, 100); return; }
    root.style.visibility = "";
    playUiOpenSfx();
    if (!motionOk()) return;
    move(D.bar, DROP, { duration: MOTION.in, fill: "backwards" });
    move(D.roster, RISE, { duration: MOTION.in, delay: 60, fill: "backwards" });
    move(D.con, RISE, { duration: MOTION.in, delay: 130, fill: "backwards" });
  };
  if (document.body.classList.contains("fuc-shatter-active")) root.style.visibility = "hidden";
  run();
}
// A HUD rebuild destroys the desk and builds it again in one go: the old desk
// is kept for that moment and only one that stays gone plays its exit.
function leaveDesk(root) {
  root.removeAttribute("id");
  root.inert = true;
  const ghost = { root, t: 0 };
  ghost.t = setTimeout(() => {
    if (_ghost === ghost) _ghost = null;
    if (root.style.visibility === "hidden") { root.remove(); return; }
    playUiBackSfx();
    if (!motionOk()) { root.remove(); return; }
    const out = (frames) => [frames[1], frames[0]];
    const opts = { duration: MOTION.out, easing: "ease-in", fill: "forwards" };
    move(root.querySelector(".gmd-bar"), out(DROP), opts);
    move(root.querySelector(".gmd-roster"), out(RISE), opts);
    move(root.querySelector(".gmd-con"), out(RISE), { ...opts, delay: 50 });
    setTimeout(() => root.remove(), MOTION.out + 80);
  }, 0);
  _ghost = ghost;
}
function dropGhost() {
  const g = _ghost;
  if (!g) return false;
  _ghost = null;
  clearTimeout(g.t);
  g.root.remove();
  return true;
}
function swapConsole(mine) {
  if (mine) playUiOpenSfx();
  if (motionOk()) move(D.cbody, [{ opacity: 0, translate: "0 6px" }, { opacity: 1, translate: "0 0" }], { duration: MOTION.swap });
}
function popTiles() {
  if (!motionOk()) return;
  D.layers.take?.querySelectorAll(".gmd-tile").forEach((el, i) => move(el,
    [{ opacity: 0, scale: ".94", translate: "0 8px" }, { opacity: 1, scale: "1", translate: "0 0" }],
    { duration: MOTION.tile, delay: i * MOTION.tileGap, fill: "backwards" }));
}

// ── styles ────────────────────────────────────────────────────────────────────
function ensureStyles() {
  ensureDrawerStyles();
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
.gmd { position: fixed; left: 0; top: 0; z-index: 70; pointer-events: none; transform-origin: top left;
  --p-top: #f6f1e6; --p-bot: #ebe3d0; --stroke: #7a6a55; --gold-1: #d5b67a; --gold-2: #b7935a;
  --tx: #3a3228; --tx-soft: #6a5d4c; --tx-dim: #9a8d76; --hair: rgba(122,106,85,.32);
  --red: #b3261e; --pc: #2e7bd6; --pc-ink: #1f5aa0; --pc-bg: rgba(46,123,214,.13);
  --cta-a: #c4473a; --cta-b: #8e2219; --cta-c: #741a14; --cta-ink: #fff3e6; --cta-rim: #e2c27e;
  --dhv-cta-a: #c4473a; --dhv-cta-b: #8e2219; --dhv-cta-c: #741a14; --dhv-cta-ink: #fff3e6; --dhv-cta-rim: #e2c27e;
  font-family: "Signika", "Segoe UI", system-ui, sans-serif; color: var(--tx); }
.gmd * { box-sizing: border-box; }
.gmd-panel { position: absolute; pointer-events: auto; border-radius: 12px; background: linear-gradient(180deg, var(--p-top), var(--p-bot));
  border: 2px solid var(--stroke); box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 10px 26px rgba(0,0,0,.45); display: flex; flex-direction: column; overflow: hidden; }
.gmd-panel::before { content: ""; position: absolute; inset: 4px; border: 1px solid var(--gold-1); border-radius: 8px; pointer-events: none; z-index: 3; }
.gmd-cap { font: 700 10px "Signika", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--stroke); white-space: nowrap; }
.gmd-cap.foe { color: var(--red); } .gmd-cap.pc { color: var(--pc-ink); }
.gmd-grow { flex: 1; }

/* ── battle bar ── */
/* the GM's command column, top left (Foundry's scene tools step away in battle) */
.gmd-bar { position: absolute; top: ${L.barTop}px; left: 14px; width: ${L.barW}px; display: flex; flex-direction: column; align-items: stretch; pointer-events: auto; border-radius: 10px; overflow: hidden;
  background: linear-gradient(180deg, var(--p-top), var(--p-bot)); border: 2px solid var(--stroke); box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 8px 20px rgba(0,0,0,.4); }
.gmd-bar > * { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 7px 2px 6px; border-top: 1px solid var(--hair);
  font: 700 9.5px "Signika", sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--tx-soft); white-space: nowrap; cursor: pointer; user-select: none; }
.gmd-bar > *:first-child { border-top: 0; }
.gmd-bar > .gmd-bsep { border-top: 2px solid rgba(122,106,85,.55); padding: 0; cursor: default; }
.gmd-bar > [data-cmd]:hover, .gmd-bar > [data-cmd].open { background: rgba(58,50,40,.07); color: var(--tx); }
.gmd-bar svg { width: 18px; height: 18px; color: #9c763a; flex: none; }
.gmd-bar .gmd-bico { font-size: 16px; line-height: 17px; height: 17px; letter-spacing: 0; filter: saturate(.75); }
.gmd-bar .end, .gmd-bar .end svg { color: var(--red); }
.gmd-bar > [data-cmd].off { opacity: .4; cursor: not-allowed; }
.gmd-bar > [data-cmd].off:hover { background: none; }
/* Undecided action-card reactions are answered in the console (syncCardRx);
   on the card they show as icons (data-gmd-rx, action-card.js). */
/* ...and the card steps aside off the console meanwhile (placeCardAside). */
#fud-battlefield-card-root[data-gmd-aside]:not(.is-resolving):not(.is-hidden-during-pick) {
  transition: transform 220ms cubic-bezier(.2,.7,.2,1), opacity 220ms ease-out, top 260ms cubic-bezier(.2,.7,.2,1), left 260ms cubic-bezier(.2,.7,.2,1); }
/* The card's reactions in the console: a section per creature, Skip / Apply on each */
.gmd .gmd-crx > .dhv-main { display: block; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--gold-2) transparent; }
.gmd-crx-sec { display: flex; align-items: center; gap: 7px; margin: 8px 0 4px; font: 700 12.5px "Signika", sans-serif; color: var(--tx); }
.gmd-crx-sec:first-child { margin-top: 0; }
.gmd-crx-sec .dhv-ic { width: 20px; height: 20px; border-radius: 5px; }
.gmd-crx-sec .gmd-crx-lbl { margin-left: auto; font: 700 9.5px "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--tx-dim); }
.gmd-crx-grid { display: grid; grid-template-columns: minmax(0,1fr); column-gap: 14px; row-gap: 3px; padding-left: 4px; }
@container (min-width: 460px) { .gmd-crx-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } }
.gmd-crx-row { display: grid; grid-template-columns: 20px minmax(0,1fr) auto; align-items: center; column-gap: 7px; height: 28px; padding: 0 4px 0 5px; border-radius: 6px; }
.gmd-crx-row.is-cur { background: rgba(156,118,58,.12); box-shadow: inset 0 0 0 1px rgba(156,118,58,.35); }
.gmd-crx-row.is-off { opacity: .6; }
/* a decided reaction keeps its line, with the verdict the card shows */
.gmd-crx-st { display: inline-flex; align-items: center; height: 19px; padding: 0 8px; border-radius: 999px; font: 700 10.5px "Signika", sans-serif; letter-spacing: .02em; white-space: nowrap; }
.gmd-crx-st.ok { color: #2f6b2a; background: rgba(140,220,130,.30); box-shadow: inset 0 0 0 1px rgba(60,140,60,.55); }
.gmd-crx-st.no { color: var(--tx-soft); background: rgba(220,220,220,.45); box-shadow: inset 0 0 0 1px rgba(140,140,140,.45); }
.gmd-crx-st.wait { color: var(--tx-soft); background: rgba(255,255,255,.4); box-shadow: inset 0 0 0 1px rgba(122,106,85,.4); font-style: italic; }
/* every reaction answered, card still open: the list stays as the record */
.gmd-crx-done { grid-area: main; min-height: 0; overflow-y: auto; padding: 10px 14px; container-type: inline-size; scrollbar-width: thin; scrollbar-color: var(--gold-2) transparent; }
.gmd-crx-row .nm { font: 600 12.5px "Signika", sans-serif; color: var(--tx); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gmd-crx-row .dhv-ic { width: 20px; height: 20px; border-radius: 5px; }
.gmd-crx-btns { display: inline-flex; gap: 4px; }
.gmd-crx-b { display: inline-flex; align-items: center; height: 21px; padding: 0 9px; border-radius: 5px; cursor: pointer; user-select: none;
  font: 800 10px "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; }
.gmd-crx-b.skip { color: #6a5d4c; box-shadow: inset 0 0 0 1.5px rgba(122,106,85,.55); background: rgba(255,255,255,.4); }
.gmd-crx-b.skip:hover { color: #3a3228; box-shadow: inset 0 0 0 1.5px #7a6a55; }
.gmd-crx-b.apply { color: var(--cta-ink); background: linear-gradient(180deg, var(--cta-a), var(--cta-b)); }
.gmd-crx-b.apply:hover { filter: brightness(1.08); }
/* the column's More menu */
.gmd-more { position: absolute; z-index: 5; pointer-events: auto; min-width: 230px; padding: 6px 0; border-radius: 10px;
  background: linear-gradient(180deg, var(--p-top), var(--p-bot)); border: 2px solid var(--stroke); box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 12px 28px rgba(0,0,0,.5);
  font: 500 13px "Signika", sans-serif; color: var(--tx); user-select: none; }
.gmd-more .h { font: 700 9.5px "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--tx-dim); padding: 6px 14px 3px; }
.gmd-more .it { display: flex; align-items: center; gap: 10px; padding: 6px 14px; cursor: pointer; }
.gmd-more .it:hover { background: rgba(58,50,40,.07); }
.gmd-more .it small { margin-left: auto; color: var(--tx-dim); font-size: 11px; }
.gmd-more .ck { width: 14px; height: 14px; border-radius: 3px; box-shadow: inset 0 0 0 1.5px rgba(122,106,85,.7); flex: none; position: relative; }
.gmd-more .ck.on { background: var(--tx); box-shadow: none; }
.gmd-more .ck.on::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid var(--p-top); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.gmd-more hr { border: 0; border-top: 1px solid var(--hair); margin: 5px 0; }
.gmd-more .gmd-size { margin-left: auto; }
.gmd-sw { width: 30px; height: 16px; border-radius: 8px; background: rgba(58,50,40,.18); position: relative; flex: none; }
.gmd-sw::after { content: ""; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.gmd-sw.on { background: linear-gradient(180deg, var(--cta-a), var(--cta-b)); } .gmd-sw.on::after { left: 16px; }

/* ── roster ── */
.gmd-ph { flex: none; height: 30px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--hair); }
.gmd-cols { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0,1fr) 1px minmax(0,1fr); gap: 0 12px; padding: 0 12px 10px; }
.gmd-vr { background: linear-gradient(180deg, transparent, var(--gold-2) 15%, var(--gold-2) 85%, transparent); margin-top: 8px; }
.gmd-rcol { position: relative; min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; padding-right: 4px; scrollbar-width: thin; scrollbar-color: var(--gold-2) transparent; }
.gmd-rcol > .gmd-cap { position: sticky; top: 0; z-index: 2; padding: 6px 4px 4px; background: linear-gradient(180deg, var(--p-top) 80%, transparent); }
.gmd-ur { position: relative; flex: none; display: grid; grid-template-columns: 14px 22px minmax(0,1fr) 54px 28px auto; align-items: start; column-gap: 6px;
  height: 38px; padding: 4px 6px 0 4px; border-radius: 6px; font: 700 13px "Signika", sans-serif; white-space: nowrap; cursor: default; }
.gmd-ur.hasrx { cursor: pointer; }
.gmd-ur:hover { background: rgba(58,50,40,.05); }
.gmd-ur > * { line-height: 22px; }
.gmd-ur .face { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; object-position: 50% 18%; box-shadow: 0 0 0 1.5px rgba(58,50,40,.55); background: #d9c9a8; border: 0 !important; }
.gmd-ur .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gmd-ur .nm small { font: 600 10.5px "Signika", sans-serif; color: var(--tx-dim); margin-left: 5px; }
.gmd-ur .hp { font: 700 11.5px "Signika", sans-serif; text-align: right; font-variant-numeric: tabular-nums; }
.gmd-ur .mp { font: 700 11px "Signika", sans-serif; text-align: right; color: var(--pc-ink); font-variant-numeric: tabular-nums; }
.gmd-ur .bar { position: absolute; left: 47px; width: 120px; bottom: 7px; height: 4px; border-radius: 2px; background: rgba(58,50,40,.14); overflow: hidden; }
.gmd-ur .bar i { position: absolute; left: 0; top: 0; bottom: 0; }
.gmd-ur .bar .tr { background: #e2a24a; transition: width 900ms ease-in 350ms; }
.gmd-ur .bar .fl { background: #2fbf71; transition: width 200ms ease-out; }
.gmd-ur .x2 { position: absolute; left: 176px; right: 6px; bottom: 3px; height: 12px; display: flex; align-items: center; gap: 8px; font: 700 9.5px "Signika", sans-serif; color: var(--tx-soft); line-height: 12px; overflow: hidden; }
.gmd-ur .x2 .ipd { display: flex; gap: 2px; } .gmd-ur .x2 .ipd i { width: 6px; height: 6px; border-radius: 50%; background: rgba(58,50,40,.18); } .gmd-ur .x2 .ipd i.on { background: #e8a43a; }
.gmd-ur .x2 .zp { color: #8a4a08; }
.gmd-ur .x2 .clk { display: inline-flex; align-items: center; gap: 2px; } .gmd-ur .x2 .clk svg { width: 11px; height: 11px; }
.gmd-ur .stamp { position: absolute; left: 150px; bottom: 1px; font: 900 8.5px "Cinzel", Georgia, serif; letter-spacing: .1em; text-transform: uppercase; padding: 0 4px; line-height: 11px;
  border-radius: 3px; color: #b3261e; border: 1.5px solid rgba(179,38,30,.8); background: rgba(255,238,228,.9); transform: rotate(-4deg); display: none; }
.gmd-ur.is-crisis .stamp, .gmd-ur.is-ko .stamp { display: block; }
.gmd-ur.is-ko .stamp { color: #fff; background: #5a1410; border-color: #5a1410; }
.gmd-ur.is-ko .face { filter: grayscale(1); }
.gmd-ur.is-ko .nm, .gmd-ur.is-ko .hp { color: rgba(58,50,40,.5); }
.gmd-ur.is-acting { background: linear-gradient(90deg, rgba(196,71,58,.18), rgba(196,71,58,.03)); box-shadow: inset 3px 0 0 var(--cta-a); }
.gmd-dot { justify-self: center; margin-top: 7px; width: 8px; height: 8px; border-radius: 50%; background: var(--gold-2); }
.gmd-dot.acted { background: #cfc4ad; } .gmd-dot.noturn { background: transparent; box-shadow: inset 0 0 0 1.5px var(--tx-dim); }
.gmd-dot.acting { background: #d0402a; box-shadow: 0 0 6px 2px rgba(208,64,42,.5); }
.gmd-tt { display: grid; place-items: center; width: 14px; height: 14px; margin-top: 4px; border-radius: 4px; font-size: 8px; line-height: 1; cursor: pointer;
  color: var(--cta-ink); background: linear-gradient(180deg, var(--cta-a), var(--cta-b)); }
.gmd-tt.off { background: rgba(58,50,40,.15); color: var(--tx-dim); cursor: default; }
.gmd-rxc { display: flex; align-items: center; justify-content: flex-end; gap: 5px; min-width: 0; }
.gmd-rxc.isdone { opacity: .65; }
.gmd-cnt { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font: 700 10px/16px "Signika", sans-serif; color: var(--p-top); background: var(--cta-b); }
.gmd-chip { display: inline-flex; align-items: center; gap: 4px; font: 700 10px/18px "Signika", sans-serif; letter-spacing: .06em; text-transform: uppercase; padding: 0 7px; border-radius: 4px; white-space: nowrap; }
.gmd-chip.you { color: var(--cta-ink); background: linear-gradient(180deg, var(--cta-a), var(--cta-b)); }
.gmd-chip.pl { color: var(--pc-ink); background: var(--pc-bg); text-transform: none; letter-spacing: .02em; font-size: 11px; }
.gmd-chip.done { color: #2f7d4f; background: rgba(47,125,79,.12); }
.gmd-chip.foe { color: var(--red); background: rgba(179,38,30,.12); }
.gmd-chip.ai { color: #7a5418; background: rgba(183,147,90,.2); }
.gmd-chip.plain { color: var(--tx); background: rgba(58,50,40,.09); }
.gmd-live { display: inline-flex; align-items: center; gap: 5px; font: 700 10px "Signika", sans-serif; font-style: normal; letter-spacing: .14em; text-transform: uppercase; color: var(--pc-ink); }
.gmd-live i { width: 7px; height: 7px; border-radius: 50%; background: var(--pc); animation: gmdLive 1.7s ease-in-out infinite alternate; }
@keyframes gmdLive { from { box-shadow: 0 0 0 0 rgba(46,123,214,.55); } to { box-shadow: 0 0 6px 3px rgba(46,123,214,.35); } }
.gmd-ur.hasrx:not(.rxsel) { background: rgba(196,71,58,.05); }
.gmd-ur.rxsel { background: linear-gradient(180deg, #fef5dc, #ebd9a6); box-shadow: 0 0 0 1px rgba(90,62,28,.55) inset, inset 3px 0 0 var(--gold-2); }
.gmd-ban { display: inline-flex; align-items: center; gap: 7px; min-width: 0; padding: 0 9px; height: 22px; border-radius: 11px; background: rgba(196,71,58,.1);
  box-shadow: inset 0 0 0 1px rgba(196,71,58,.4); font: 600 11.5px "Signika", sans-serif; white-space: nowrap; overflow: hidden; }
.gmd-ban b { overflow: hidden; text-overflow: ellipsis; }
.gmd-ban .k { font: 700 9.5px "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--tx-dim); }
.gmd-empty { font: italic 600 12px "Signika", sans-serif; color: var(--tx-dim); padding: 4px; }
.gmd-chip.gmp { color: #5b3a8c; background: rgba(110,70,170,.14); text-transform: none; letter-spacing: .02em; font-size: 11px; }
.gmd-tile .gmd-chip.gmp { position: absolute; top: 6px; right: 8px; }
.gmd-ur { cursor: pointer; }

/* roster header: size S/M/L and fold */
.gmd-hctl { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.gmd-size { display: inline-flex; border-radius: 6px; overflow: hidden; box-shadow: inset 0 0 0 1.5px rgba(122,106,85,.6); cursor: pointer; user-select: none; }
.gmd-size span { font: 700 10px/20px "Signika", sans-serif; letter-spacing: .1em; padding: 0 7px; color: var(--tx-dim); }
.gmd-size span.on { background: var(--tx); color: var(--p-top); }
.gmd-size span:not(.on):hover { color: var(--tx); background: rgba(58,50,40,.08); }
.gmd-fold { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 6px; font: 700 10px "Signika", sans-serif; letter-spacing: .1em;
  text-transform: uppercase; color: var(--tx-soft); box-shadow: inset 0 0 0 1.5px rgba(122,106,85,.6); cursor: pointer; user-select: none; white-space: nowrap; }
.gmd-fold:hover { color: var(--tx); background: rgba(58,50,40,.08); }

/* Fold: a drawer tab standing on the panels' top edge, over the gap between them */
.gmd-foldtab { position: absolute; z-index: 3; pointer-events: auto; transform: translate(-100%, -100%); display: flex; align-items: center; gap: 4px;
  height: 20px; padding: 0 10px 1px; border-radius: 9px 9px 0 0; cursor: pointer; user-select: none; white-space: nowrap;
  background: linear-gradient(180deg, var(--p-top), var(--p-bot)); border: 2px solid var(--stroke); border-bottom: 0;
  box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 -3px 10px rgba(0,0,0,.25);
  font: 700 9.5px "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--tx-soft); }
.gmd-foldtab svg { width: 13px; height: 13px; color: #9c763a; }
.gmd-foldtab:hover { color: var(--tx); background: linear-gradient(180deg, #fffaf0, var(--p-top)); }
.gmd.is-folding .gmd-foldtab { transition: top ${MOTION.fold}ms ${EASE}; }
.gmd.is-peek .gmd-foldtab { opacity: .1; pointer-events: none !important; }
/* folded: both panels shrink to their header strips */
.gmd.is-folded .gmd-cols, .gmd.is-folded .gmd-cbody { display: none; }
.gmd.is-folded .gmd-chd { border-bottom: 0; cursor: pointer; }
.gmd.is-folded .gmd-ph { border-bottom: 0; }
/* folding / unfolding: the panels glide to their new size (only while it happens) */
.gmd.is-folding .gmd-panel { transition: top ${MOTION.fold}ms ${EASE}, height ${MOTION.fold}ms ${EASE}; }
@media (prefers-reduced-motion: reduce) { .gmd.is-folding .gmd-panel { transition: none; } }
/* peek: hold the key and the desk lets you see and click what is under it */
.gmd.is-peek .gmd-panel, .gmd.is-peek .gmd-bar, .gmd.is-peek .gmd-more { opacity: .1; pointer-events: none !important; }

/* idle console: Recent · Enemy order · AI next */
.gmd-idlegrid { grid-area: main; display: grid; grid-template-columns: minmax(0,1.3fr) minmax(0,.9fr) minmax(0,1fr); min-height: 0; }
.gmd-idlegrid > div { position: relative; min-width: 0; min-height: 0; padding: 8px 12px; display: flex; flex-direction: column; gap: 3px; overflow: hidden; }
.gmd-idlegrid > div + div::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 1px; background: linear-gradient(180deg, transparent, var(--gold-2) 15%, var(--gold-2) 85%, transparent); }
.gmd-idlegrid .gmd-cap { margin-bottom: 3px; }
.gmd-lg { display: grid; grid-template-columns: 26px minmax(0,1fr); column-gap: 6px; font: 600 12px/1.35 "Signika", sans-serif; color: var(--tx-soft); }
.gmd-lg .r { color: var(--tx-dim); font-variant-numeric: tabular-nums; }
.gmd-lg .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gmd-lg b { color: var(--tx); } .gmd-lg .dm { color: var(--red); font-weight: 700; } .gmd-lg .hl { color: #1f8a4c; font-weight: 700; }
.gmd-ord { display: grid; grid-template-columns: 18px 22px minmax(0,1fr) auto; align-items: center; column-gap: 7px; height: 26px; font: 700 12.5px "Signika", sans-serif; }
.gmd-ord .k { width: 17px; height: 17px; border-radius: 50%; display: grid; place-items: center; font: 700 10px "Signika", sans-serif; background: var(--tx); color: var(--p-top); }
.gmd-ord.next .k { background: var(--cta-a); }
.gmd-ord img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; object-position: 50% 18%; box-shadow: 0 0 0 1.5px rgba(58,50,40,.55); border: 0 !important; }
.gmd-ord .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gmd-ord .x { color: var(--tx-dim); font-weight: 600; font-size: 11px; }
.gmd-aiw { border-radius: 8px; padding: 6px 10px; background: rgba(183,147,90,.14); box-shadow: inset 0 0 0 1px rgba(183,147,90,.5); display: grid; gap: 3px; font: 600 12.5px "Signika", sans-serif; color: var(--tx-soft); }
.gmd-aiw > div { display: grid; grid-template-columns: minmax(0,1fr) auto; column-gap: 8px; } .gmd-aiw b { color: var(--tx); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gmd-note { font: italic 600 11.5px/1.35 "Signika", sans-serif; color: var(--tx-dim); }

/* ── console ── */
.gmd-chd { flex: none; min-height: 46px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--hair); }
.gmd-who { display: flex; align-items: center; gap: 9px; min-width: 0; }
.gmd-who img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; object-position: 50% 18%; box-shadow: 0 0 0 1.5px rgba(58,50,40,.55); border: 0 !important; flex: none; }
.gmd-who .n { font: 700 16px "Signika", sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gmd-who .s { font: 600 11px "Signika", sans-serif; color: var(--tx-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gmd-who .s .c { color: var(--tx-dim); }
.gmd-res { display: flex; gap: 8px; font: 700 11.5px "Signika", sans-serif; white-space: nowrap; }
.gmd-res .h { color: #1f8a4c; } .gmd-res .m { color: var(--pc-ink); }
.gmd-next { font: italic 600 11px "Signika", sans-serif; color: var(--tx-dim); white-space: nowrap; }
.gmd-lock { display: inline-flex; flex: none; border-radius: 8px; overflow: hidden; box-shadow: inset 0 0 0 1.5px rgba(122,106,85,.6); background: rgba(255,255,255,.45); cursor: pointer; user-select: none; }
.gmd-lock span { display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; font: 700 11px "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--tx-dim); }
.gmd-lock svg { width: 13px; height: 13px; }
.gmd-lock span.on.w { color: #fff; background: #2c5f9e; }
.gmd-lock span.on.a { color: var(--cta-ink); background: linear-gradient(180deg, var(--cta-a), var(--cta-b)); }

.gmd-cbody { flex: 1 1 auto; min-height: 0; display: grid; position: relative;
  grid-template-areas: "fbar fbar fbar" "cmds main detail" "foot foot foot";
  grid-template-columns: 0px minmax(0,1fr) 0px; grid-template-rows: auto minmax(0,1fr) 44px; }
.gmd-cbody.l-step.has-cmds { grid-template-columns: 222px minmax(0,1fr) 320px; }
.gmd-con.is-narrow .gmd-cbody.l-step.has-cmds { grid-template-columns: 200px minmax(0,1fr) 250px; }
.gmd-con.is-narrow .gmd-cbody.l-step:not(.has-cmds), .gmd-con.is-narrow .gmd-cbody.l-react { grid-template-columns: 0px minmax(0,1fr) 300px; }
.gmd-cbody.l-step:not(.has-cmds), .gmd-cbody.l-react { grid-template-columns: 0px minmax(0,1fr) 380px; }
.gmd-cbody.l-step.has-cmds:has(.gmd-layer[data-layer="step"] .gmd-work .dhv-tcols), .gmd-cbody.l-step.has-cmds.has-targets { grid-template-columns: 0px minmax(0,1fr) 280px; }
.gmd-cbody.l-step:has(.gmd-layer[data-layer="step"] .gmd-work .dhv-tcols) .gmd-layer[data-layer="step"] .gmd-cmds, .gmd-cbody.l-step.has-targets .gmd-cmds { display: none; }
.gmd .dhv-trow { grid-template-columns: 14px 22px minmax(0,1fr) 54px; font-size: 12.5px; height: 24px; }
.gmd .dhv-thp { font-size: 9.5px; }
.gmd-cbody.l-take, .gmd-cbody.l-idle, .gmd-cbody.l-card { grid-template-columns: 0px minmax(0,1fr) 0px; }
.gmd-layer { display: contents; }
.gmd-layer.is-off { display: none; }
.gmd-layer.is-locked > * { pointer-events: none; }
.gmd-layer.is-locked .gmd-work, .gmd-layer.is-locked .gmd-cmds { opacity: .55; }
.gmd-cmds { display: contents; }
.gmd .gmd-cmds .cmd-body { grid-area: cmds; min-width: 0; min-height: 0; padding: 8px 8px 6px 12px; align-self: start; }
.gmd-steph { grid-area: main; display: grid; place-items: center; padding: 12px; text-align: center; font: italic 600 13px/1.5 "Signika", sans-serif; color: var(--tx-dim); }
.gmd-cbody.has-view .gmd-steph, .gmd-cbody:not(.has-cmds) .gmd-steph { display: none; }
.gmd-main { grid-area: main; min-width: 0; min-height: 0; }
.gmd-work, .gmd-work > .dhv-view { display: contents; }
.gmd .dhv-view > .dhv-main { grid-area: main; min-width: 0; min-height: 0; padding: 8px 12px 6px; position: relative; }
.gmd-cbody.has-cmds .dhv-view > .dhv-main::before, .gmd-detail::before, .gmd-cmds + .gmd-main::before {
  content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 1px; background: linear-gradient(180deg, transparent, var(--gold-2) 15%, var(--gold-2) 85%, transparent); }
.gmd .dhv-view > .dhv-foot, .gmd-foot { grid-area: foot; height: 44px; padding: 0 12px 0 14px; border-top: 1px solid var(--hair); display: flex; align-items: center; gap: 8px; min-width: 0; }
.gmd .dhv-list { grid-template-columns: minmax(0,1fr); max-width: none; }
/* A wide console lays a long list out in two columns (arrow keys move by
   position, so Left/Right cross between them). */
.gmd .dhv-view > .dhv-main { container-type: inline-size; }
/* 460 = two ~220 px columns: 1440p (about 518 px here, beside the commands and
   the detail card) gets them, 1080p (about 360) keeps one. Short lists too
   (the drawer's is-one, 3 rows or fewer): every console list reads the same
   way at a given width (user, 2026-10-22). */
@container (min-width: 460px) { .gmd .dhv-list, .gmd .dhv-list.is-one { grid-template-columns: repeat(2, minmax(0,1fr)); column-gap: 18px; } }
.gmd .dhv-list.is-one { max-width: none; }
.gmd .dhv-row { height: 25px; font-size: 12.5px; }
.gmd .dhv-tiles { align-content: center; }
.gmd-detail { grid-area: detail; position: relative; min-width: 0; min-height: 0; padding: 10px 12px 8px 14px; display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
.gmd-detail:empty { display: none; }
.gmd-detail .dn { display: flex; align-items: center; gap: 8px; font: 700 15px/1.2 "Signika", sans-serif; }
.gmd-detail .dn .dhv-ic { width: 26px; height: 26px; border-radius: 6px; }
.gmd-detail .dc { display: flex; gap: 4px; flex-wrap: wrap; }
.gmd-detail .gmd-from { font: 700 9.5px "Signika", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--tx-dim); margin-bottom: -4px; }
.gmd-detail .why { font: 700 11.5px/1.3 "Signika", sans-serif; color: var(--red); padding: 3px 7px; border-radius: 5px; background: rgba(179,38,30,.08); }
.gmd-detail .dd { flex: 1 1 auto; min-height: 0; overflow-y: auto; font: 400 12.5px/17px "Signika", sans-serif; color: #4b4338; padding-right: 4px; scrollbar-width: thin; scrollbar-color: var(--gold-2) transparent; }
.gmd-detail .dd p { margin: 0 0 5px; } .gmd-detail .dd .enh { font-style: italic; color: var(--tx-soft); font-size: 11.5px; }
.gmd-fbar { grid-area: fbar; display: flex; align-items: center; gap: 8px; margin: 5px 12px 0; padding: 3px 9px; border-radius: 7px; background: rgba(196,71,58,.1);
  box-shadow: inset 0 0 0 1px rgba(196,71,58,.45); font: 600 12px "Signika", sans-serif; }
.gmd-fbar svg { width: 14px; height: 14px; color: var(--cta-a); flex: none; }
.gmd-fbar:empty { display: none; }
.gmd-idle { grid-area: main; display: grid; place-items: center; text-align: center; padding: 14px; font: italic 600 13px/1.5 "Signika", sans-serif; color: var(--tx-soft); }
.gmd-idle b { font-style: normal; color: var(--tx); }
.gmd-sum { flex: 1 1 auto; min-width: 0; font: italic 600 12.5px "Signika", sans-serif; color: var(--tx-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gmd-sum b { color: var(--tx); font-style: normal; }
.gmd-cta { height: 32px; min-width: 128px; padding: 0 14px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; flex: none;
  font: 700 13px "Signika", sans-serif; letter-spacing: .12em; text-transform: uppercase; cursor: default;
  color: #8a7d68; background: linear-gradient(180deg, #ece5d5, #ddd3bf); border: 2px solid rgba(122,106,85,.6); box-shadow: 0 0 0 1px rgba(255,255,255,.55) inset; }

/* The command window inside the console: one 2-column grid, keys never move. */
.gmd .fud-octopath.is-docked .cmd-window { padding: 0; display: contents; }
.gmd .fud-octopath.is-docked { display: contents; }
.gmd .fud-octopath.is-docked .cmd-body { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(6, 24px); grid-auto-flow: column; gap: 3px 4px; height: auto; }
.gmd .fud-octopath.is-docked .cmd-col { display: contents; }
.gmd .fud-octopath.is-docked .cmd-sep { display: none; }
.gmd .fud-octopath.is-docked .item::before { display: none !important; }
.gmd .fud-octopath.is-docked .blade, .gmd .fud-octopath.is-docked .blade.is-primary { height: 24px; font-size: 11px; font-weight: 800; letter-spacing: .02em; column-gap: 4px; padding: 0 3px 0 2px; grid-template-columns: 8px minmax(0,1fr) auto; }
.gmd .fud-octopath.is-docked .blade .cursor, .gmd .fud-octopath.is-docked .blade.is-primary .cursor { font-size: 9px; }
.gmd .fud-octopath.is-docked .blade .key, .gmd .fud-octopath.is-docked .blade.is-primary .key { min-width: 16px; height: 16px; font-size: 9.5px; padding: 0 3px; border-radius: 4px; }
.gmd .fud-octopath.is-docked .item > .blade-stamp { font-size: 9px; padding: 0 4px; }
.gmd .fud-octopath.is-docked .cmd-foot { grid-area: foot; height: 44px; padding: 0 12px 0 14px; border-top: 1px solid var(--hair); }
.gmd .fud-octopath.is-docked .cmd-foot .cmd-help { font-size: 12.5px; }
.gmd .fud-octopath.is-docked[inert] .cmd-foot { display: none; }
.gmd-cbody.has-view .fud-octopath.is-docked .cmd-foot { display: none; }
.gmd .fud-octopath { opacity: 1; }
.gmd .fud-octopath .cmd-window { opacity: 1; transform: none; transition: none; }

/* Take Turn tiles */
.gmd-tiles { grid-area: main; display: grid; gap: 12px; padding: 10px 14px; align-content: center; overflow-y: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--gold-2) transparent; }
.gmd-tiles.mid, .gmd-tiles.small { gap: 8px; }
.gmd-tile { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.45); box-shadow: inset 0 0 0 1px rgba(122,106,85,.45); cursor: pointer; min-width: 0; }
.gmd-tile.on { background: linear-gradient(180deg, #fef5dc, #ebd9a6); box-shadow: inset 0 0 0 1.5px rgba(90,62,28,.6), 0 0 0 2px var(--gold-1); }
.gmd-tile.off { cursor: default; }
.gmd-tile .l1 { display: flex; align-items: center; gap: 10px; min-width: 0; }
.gmd-tile .l1 img { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; object-position: 50% 18%; box-shadow: 0 0 0 1.5px rgba(58,50,40,.55); border: 0 !important; flex: none; }
.gmd-tile .tn { display: grid; min-width: 0; line-height: 1.2; } .gmd-tile .tn b { font: 700 15px "Signika", sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gmd-tile .tn small { font: 600 11px "Signika", sans-serif; color: var(--pc-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .gmd-tile .tn small.gm { color: var(--red); }
.gmd-tile .bars { display: grid; grid-template-columns: minmax(0,1fr) auto; column-gap: 8px; row-gap: 3px; align-items: center; }
.gmd-tile .bars span { height: 6px; border-radius: 3px; background: rgba(58,50,40,.15); overflow: hidden; } .gmd-tile .bars span i { display: block; height: 100%; }
.gmd-tile .hpf { background: linear-gradient(90deg, #6bd66b, #2fbf71); } .gmd-tile .mpf { background: linear-gradient(90deg, #5aa8ff, #2e7bd6); }
.gmd-tile .bars em { font: 700 10.5px "Signika", sans-serif; font-style: normal; color: var(--tx-soft); font-variant-numeric: tabular-nums; }
.gmd-tbtn { height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 10px; font: 700 12px "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase;
  color: var(--cta-ink); background: linear-gradient(180deg, var(--cta-a), var(--cta-b) 60%, var(--cta-c)); border: 2px solid var(--cta-rim); text-shadow: 0 1px 0 rgba(60,8,4,.6); box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset; white-space: nowrap; overflow: hidden; }
.gmd-tbtn kbd { font: 700 9.5px "Signika", sans-serif; background: var(--cta-ink); color: var(--cta-c); border-radius: 3px; padding: 1px 4px; border: 0; text-shadow: none; box-shadow: none; }
.gmd-tile.on .gmd-tbtn:not(.off) { animation: gmdBreath 3.4s ease-in-out infinite alternate; }
.gmd-tbtn.off { color: #8a7d68; background: linear-gradient(180deg, #ece5d5, #ddd3bf); border-color: rgba(122,106,85,.6); text-shadow: none; }
@keyframes gmdBreath { from { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 10px 1px rgba(222,66,46,.42); } to { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 18px 4px rgba(232,72,50,.62); } }
.gmd-tile.md { gap: 6px; padding: 8px 10px; } .gmd-tile.md .l1 img { width: 30px; height: 30px; } .gmd-tile.md .tn b { font-size: 13.5px; }
.gmd-tile.md .mrow { display: grid; grid-template-columns: minmax(0,1fr) auto auto; align-items: center; column-gap: 8px; }
.gmd-tile.md .mrow span { height: 6px; border-radius: 3px; background: rgba(58,50,40,.15); overflow: hidden; } .gmd-tile.md .mrow span i { display: block; height: 100%; }
.gmd-tile.md .mrow em { font: 700 10.5px "Signika", sans-serif; font-style: normal; color: var(--tx-soft); }
.gmd-tile.md .gmd-tbtn { height: 26px; font-size: 11px; }
.gmd-tile.sm { display: grid; grid-template-columns: 24px minmax(0,1fr) auto; align-items: center; column-gap: 8px; height: 50px; padding: 0 8px; flex-direction: row; }
.gmd-tile.sm img { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; object-position: 50% 18%; border: 0 !important; }
.gmd-tile.sm .tn b { font-size: 12.5px; } .gmd-tile.sm .tn small { color: var(--tx-soft); }
.gmd-tile.sm .gmd-tbtn { height: 26px; padding: 0 7px; font-size: 10px; }

/* An overlay that predates the drawer views (attribute pair, passive manager)
   adopted into the console as it is. */
.gmd .gmd-adopt { position: static !important; transform: none !important; opacity: 1 !important; z-index: auto !important; pointer-events: auto !important;
  grid-row: 2; grid-column: 2 / 4; min-height: 0; overflow-y: auto; padding: 8px 14px; scrollbar-width: thin; scrollbar-color: var(--gold-2) transparent; transition: none !important; }
.gmd-cbody:not(.has-cmds) .gmd-adopt { grid-column: 1 / 4; }
.gmd-cbody.has-adopt:not(.cmds-live) .gmd-adopt { grid-row: 2 / 4; }
.gmd-cbody.has-adopt .gmd-detail, .gmd-cbody.has-adopt .gmd-steph { display: none; }
.gmd .gmd-adopt > * { width: auto !important; max-width: none !important; max-height: none !important; border: 0 !important; box-shadow: none !important; background: none !important; padding: 0 !important; }
.gmd .gmd-adopt .fud-app-card { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; align-items: start; }
.gmd .gmd-adopt .fud-app-card > .fud-app-tag, .gmd .gmd-adopt .fud-app-card > .fud-app-title, .gmd .gmd-adopt .fud-app-card > .fud-app-hint,
.gmd .gmd-adopt .fud-app-card > .fud-app-dl-row, .gmd .gmd-adopt .fud-app-card > .fud-app-btn-row { grid-column: 1 / -1; }
.gmd .gmd-adopt .fud-app-card > .fud-app-tag { justify-self: start; }
.gmd .gmd-adopt .fud-app-title { text-align: left; padding-bottom: 4px; margin-bottom: 6px; border-bottom-width: 1px; }
.gmd .gmd-adopt .fud-app-attr-btn { padding: 4px; flex-direction: row; gap: 6px; }
.gmd .gmd-adopt .fud-app-dl-row { flex-direction: row; align-items: center; gap: 10px; }
.gmd .gmd-adopt .fud-app-btn-row { justify-content: flex-end; }
.gmd .gmd-adopt .fud-passive-mgr-list { max-height: none !important; overflow: visible !important; }

/* A player's menu, live (Watch). */
.gmd-mirror .is-cur, .gmd-mirror .is-cursor { background: linear-gradient(180deg, #eef5ff, #d3e4fb) !important; box-shadow: 0 0 0 1px rgba(31,90,160,.5) inset, inset 3px 0 0 var(--pc) !important; }
.gmd-mirror .dhv-foot .dhv-btn, .gmd-mirror .dhv-foot .dhv-hints, .gmd-mirror .cmd-foot { display: none !important; }
.gmd-mirror * { pointer-events: none !important; animation: none !important; }
.gmd-mirror .dhv-view > .dhv-foot { display: none; }

/* A view with nothing to describe (choice tiles without text) takes the detail column too. */
.gmd-cbody.l-step:has(> .gmd-layer:not(.is-off):is([data-layer="step"], [data-layer="mirror"]) > .gmd-detail:empty),
.gmd-cbody.l-react:has(> .gmd-layer:not(.is-off):is([data-layer="react"], [data-layer="mirror"]) > .gmd-detail:empty) { grid-template-columns: 0px minmax(0,1fr) 0px; }
.gmd-cbody.l-step.has-cmds:not(.has-targets):not(:has(.dhv-tcols)):has(> .gmd-layer:not(.is-off):is([data-layer="step"], [data-layer="mirror"]) > .gmd-detail:empty) { grid-template-columns: 222px minmax(0,1fr) 0px; }
.gmd .dhv-tile .t { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.2; }
/* The number wheel stacks (value over strip): the middle column is narrower than the plate's drawer. */
.gmd .dhv-num { grid-template-columns: minmax(0,1fr); row-gap: 8px; align-content: center; }
.gmd .dhv-nlab { max-width: none; }
.gmd .dhv-strip { min-width: 0; }
.gmd .dhv-nums { min-width: 0; overflow: hidden; padding: 0 4px; }
.gmd .dhv-nums span { min-width: 22px; }
/* The card's hover description must not stay over the console while the card steps aside for a pick. */
body:has(#fud-battlefield-card-root.is-hidden-during-pick) .fud-bf-desc-tip { display: none !important; }

/* soft dashed ring under the highlighted Take Turn tile's token */
.gmd-ring { position: fixed; z-index: 30; pointer-events: none; border-radius: 50%; border: 3px dashed rgba(255,214,120,.95); box-shadow: 0 0 12px 2px rgba(255,200,90,.45); transform: translate(-50%, -50%); }
.gmd-ring.pc { border-color: rgba(156,202,255,.95); box-shadow: 0 0 12px 2px rgba(90,168,255,.4); }
.gmd-ring.lit { box-shadow: 0 0 20px 7px rgba(255,200,90,.8); }
.gmd-ring.pc.lit { box-shadow: 0 0 20px 7px rgba(90,168,255,.75); }
`;
  document.head.appendChild(st);
}

const SVG = {
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l10 7-10 7z" fill="currentColor"/><rect x="16" y="5" width="3" height="14" fill="currentColor"/></svg>',
  round: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M21 3v5h-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rewind: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M3 3v5h5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  end: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4M6 4h11l-2.5 4L17 12H6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  swords: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l9 9M20 4l-9 9M6 15l3 3M18 15l-3 3M4 20l3-3M20 20l-3-3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  summon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.4 5.8.4-4.5 3.7 1.5 5.7L12 15.1l-5 3.1 1.5-5.7L4 8.8l5.8-.4z" fill="currentColor"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>',
  die: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z" fill="currentColor"/><path d="M18.5 15.5c.3 2 1 2.7 3 3-2 .3-2.7 1-3 3-.3-2-1-2.7-3-3 2-.3 2.7-1 3-3z" fill="currentColor"/></svg>',
  fold: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l6 6 6-6M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  unfold: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18l6-6 6 6M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="18.5" cy="12" r="2" fill="currentColor"/></svg>',
};

// ── build / destroy ───────────────────────────────────────────────────────────
/**
 * Build the desk on this GM client (director-player-hud.js buildLocally, in
 * place of the compact party cards). `partyIds` are the HUD's party actors.
 */
export function buildDesk(partyIds = []) {
  if (!deskEnabled()) return false;
  destroyDesk();
  const rebuilt = dropGhost();
  ensureStyles();
  ensureSocket();
  try { D.locked = localStorage.getItem(LOCK_KEY) !== "0"; } catch { D.locked = true; }
  try { D.size = SIZES[localStorage.getItem(SIZE_KEY)] ? localStorage.getItem(SIZE_KEY) : "m"; } catch { D.size = "m"; }
  try { D.folded = localStorage.getItem(FOLD_KEY) === "1"; } catch { D.folded = false; }
  D.foldShown = false; D.peek = false; D.hover = null; D.ringLit = null; D.focusSig = ""; D.barW = null; D.swapSig = null; D.hoverKey = null;
  D.party = new Set(partyIds.map(String));
  D.units = _units;
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.className = "gmd";
  root.innerHTML = `
    <div class="gmd-bar"></div>
    <div class="gmd-foldtab" role="button" tabindex="-1"></div>
    <section class="gmd-panel gmd-roster">
      <div class="gmd-ph"><span class="gmd-cap">Units</span><span class="gmd-banwrap" style="display:contents"></span><span class="gmd-grow"></span><span class="gmd-hctl"></span></div>
      <div class="gmd-cols"><div class="gmd-rcol" data-side="enemy"><span class="gmd-cap foe">Enemies</span></div><div class="gmd-vr"></div><div class="gmd-rcol" data-side="party"><span class="gmd-cap pc">Party</span></div></div>
    </section>
    <section class="gmd-panel gmd-con">
      <div class="gmd-chd"></div>
      <div class="gmd-cbody l-idle">
        <div class="gmd-fbar"></div>
        <div class="gmd-layer is-off" data-layer="step"><div class="gmd-cmds"></div><div class="gmd-steph">Pick a command · keys 1–9, 0 · arrows + Enter</div><div class="gmd-work"></div><div class="gmd-detail"></div></div>
        <div class="gmd-layer is-off" data-layer="take"></div>
        <div class="gmd-layer is-off" data-layer="react"><div class="gmd-work"></div><div class="gmd-detail"></div></div>
        <div class="gmd-layer gmd-mirror is-off" data-layer="mirror"></div>
        <div class="gmd-layer" data-layer="idle"></div>
      </div>
    </section>`;
  document.body.appendChild(root);
  D.root = root;
  D.moreOpen = false; D.more = null;
  setGmFocus(true);
  D.bar = root.querySelector(".gmd-bar");
  D.roster = root.querySelector(".gmd-roster");
  D.con = root.querySelector(".gmd-con");
  D.chd = root.querySelector(".gmd-chd");
  D.cbody = root.querySelector(".gmd-cbody");
  for (const el of root.querySelectorAll(".gmd-layer")) D.layers[el.dataset.layer] = el;
  const s = D.layers.step;
  D.step = { cmdsEl: s.querySelector(".gmd-cmds"), workEl: s.querySelector(".gmd-work"), detailEl: s.querySelector(".gmd-detail"),
    holds: 0, holdActorId: null, overlay: null, under: null, crumb: null, card: null, budget: null, graceT: null };
  D.rows.clear();

  D.bar.addEventListener("click", onBarClick);
  D.foldTab = root.querySelector(".gmd-foldtab");
  D.foldTab.addEventListener("click", (e) => { e.stopPropagation(); playUiClickSfx(); setFolded(!D.folded); });
  paintFoldTab();
  D.roster.addEventListener("click", onRosterClick);
  D.roster.addEventListener("dblclick", onRosterDblClick);
  D.roster.addEventListener("pointerover", onRosterOver);
  D.roster.addEventListener("pointerleave", () => { if (D.hover) { D.hover = null; positionRing(true); } });
  let autoRaf = requestAnimationFrame(function autoLoop(t) {
    try { autoScrollDetails(t); } catch (e) { warn("[GmDesk] description auto-scroll failed", e); }
    autoRaf = requestAnimationFrame(autoLoop);
  });
  D.offFns.push(() => cancelAnimationFrame(autoRaf));
  D.chd.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-lock]")) { toggleLock(); return; }
    // A folded console strip opens the desk again.
    if (D.foldShown) setFolded(false);
  });
  const onBlur = () => setPeek(false);
  window.addEventListener("blur", onBlur);
  D.offFns.push(() => window.removeEventListener("blur", onBlur));
  D.layers.take.addEventListener("click", onTakeClick);
  D.layers.take.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[data-ti]");
    if (t && D.take && Number(t.dataset.ti) !== D.take.cur) { D.take.cur = Number(t.dataset.ti); playUiHoverSfx(); paintTake(); }
  });
  root.addEventListener("pointerover", onDeskOver);
  window.addEventListener("keydown", onDeskKey, true);
  D.offFns.push(() => window.removeEventListener("keydown", onDeskKey, true));
  document.addEventListener("pointerdown", onCardPointer, true);
  D.offFns.push(() => document.removeEventListener("pointerdown", onCardPointer, true));
  document.addEventListener("pointerdown", onDocPointer, true);
  D.offFns.push(() => document.removeEventListener("pointerdown", onDocPointer, true));

  const refresh = () => scheduleRows();
  const hooks = [
    ["updateActor", refresh], ["updateToken", refresh], ["createActiveEffect", refresh], ["updateActiveEffect", refresh], ["deleteActiveEffect", refresh],
    ["updateSetting", () => paintBar()],
    // The 3D camera moves the drawn battlers every frame: the ring follows them
    // then, not on the 250 ms tick.
    ["fu-stage3d-drawn", () => { if (D.ring) positionRing(); }],
    ["userConnected", (user, connected) => { if (!connected && user?.id) D.presence.delete(user.id); scheduleRows(); render(); }],
  ];
  for (const [h, fn] of hooks) { const id = Hooks.on(h, fn); D.offFns.push(() => Hooks.off(h, id)); }
  const timer = setInterval(tick, 250);
  D.offFns.push(() => clearInterval(timer));
  const onResize = () => { D.placeKey = ""; place(); };
  window.addEventListener("resize", onResize);
  D.offFns.push(() => window.removeEventListener("resize", onResize));

  paintBar();
  paintHeaderControls();
  paintRoster();
  render();
  place();
  if (!rebuilt) enterDesk();
  log(`[GmDesk] built (party ${D.party.size}, units ${D.units?.length ?? 0}, size ${D.size}${D.folded ? ", folded" : ""})`);
  return true;
}

export function destroyDesk() {
  if (!D.root) return;
  for (const fn of D.offFns) { try { fn(); } catch { /* */ } }
  D.offFns.length = 0;
  hideRing();
  tabAlertClear("gm-desk");
  D.presence.clear();
  // Pending reaction records must not dangle; their owners clean them up.
  clearCardRx();
  D.rx.clear(); D.rxOrder = []; D.rxCur = null; D.take = null;
  D.ctx = null;
  D.moreOpen = false; D.more = null;
  setGmFocus(false);
  try { leaveDesk(D.root); } catch { try { D.root.remove(); } catch { /* */ } }
  D.root = null; D.foldTab = null; D.layers = {}; D.rows.clear(); D.placeKey = "";
  log("[GmDesk] destroyed");
}

// ── placement ─────────────────────────────────────────────────────────────────
function isShown(el) {
  if (!el) return false;
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  return el.offsetParent !== null;
}
function rectOf(id) {
  const el = document.getElementById(id);
  if (!el || !isShown(el)) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}
// The desk's scale: the HUD's own, times this GM's size (S / M / L) — but never
// so big that the two panels stop fitting the window (or take over half its
// height). Whatever the size setting, the layout below always has MIN_SPAN.
function deskScale() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const want = hudScale() * (SIZES[D.size] ?? 1);
  const dev = rectOf("fud-devtools-btn");
  const leftPx = dev ? dev.right + 10 : L.left * want;
  const avail = vw - leftPx - rightEdgeReserve() - 10;
  return Math.max(0.45, Math.min(want, avail / MIN_SPAN, (vh * 0.45) / (L.height + L.base)));
}
function place() {
  if (!D.root) return;
  const s = deskScale();
  const vw = window.innerWidth, vh = window.innerHeight;
  const W = vw / s, H = vh / s;
  const dev = rectOf("fud-devtools-btn");
  const right = Math.round(rightEdgeReserve() / s);
  // Where a panel must end: above Foundry's Players list / hotbar when one shows under it.
  const baseFor = (x0, x1) => {
    let b = L.base;
    for (const id of ["players", "hotbar"]) {
      const el = document.getElementById(id);
      if (!el || !isShown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right / s <= x0 || r.left / s >= x1) continue;
      b = Math.max(b, Math.round(H - r.top / s + 8));
    }
    return b;
  };
  const layout = (left) => {
    const span = Math.max(600, W - left - right);
    const rw = Math.round((span - L.gap) * L.rosterShare), cw = span - L.gap - rw;
    const rx = left, cx = left + rw + L.gap;
    const rb = baseFor(rx, rx + rw), cb = baseFor(cx, cx + cw);
    // Both panels keep ONE top line (the mockup's, clear of the lowest tokens);
    // a panel with Foundry's list / hotbar under it ends above them — its rows
    // scroll — but never shorter than L.minH: then the line rises (the spec's
    // "rises over Players"), or the roster showed barely two rows a side.
    const top = Math.min(H - L.base - L.height, H - rb - L.minH, H - cb - L.minH);
    return { rw, cw, rx, cx, rb, cb, top };
  };
  const bar = placeBar(s);
  let P = layout(dev ? Math.max(20, Math.round(dev.right / s + 10)) : L.left);
  // A short window: the command column reaches the panels' top line, so the
  // roster starts right of it instead of under it.
  if (bar.y + bar.h + 8 > (D.foldShown ? H - P.rb - 40 : P.top) && P.rx < bar.x + bar.w + 10) P = layout(bar.x + bar.w + 10);
  const { rw, cw, rx, cx, rb, cb, top } = P;
  const key = [s.toFixed(3), W, H, rx, rw, cx, cw, rb, cb, D.foldShown ? 1 : 0, bar.x, bar.y, bar.h].join("|");
  if (key === D.placeKey) return;
  D.placeKey = key;
  Object.assign(D.root.style, { width: `${W}px`, height: `${H}px`, transform: s === 1 ? "none" : `scale(${s})` });
  Object.assign(D.bar.style, { left: `${bar.x}px`, top: `${bar.y}px`, right: "" });
  placeMore();
  // The Fold tab hangs off the console's top edge at its right corner (user,
  // 2026-10-23), clear of the rounded corner.
  const tabAt = (y) => { if (D.foldTab) Object.assign(D.foldTab.style, { left: `${Math.round(cx + cw - 14)}px`, top: `${y}px` }); };
  if (D.foldShown) {
    // Folded: each panel is its header strip, sitting on its own base line.
    const rh = (D.roster.querySelector(".gmd-ph")?.offsetHeight ?? 30) + 4;
    const ch = (D.chd?.offsetHeight ?? 46) + 4;
    Object.assign(D.roster.style, { left: `${rx}px`, width: `${rw}px`, top: `${H - rb - rh}px`, height: `${rh}px` });
    Object.assign(D.con.style, { left: `${cx}px`, width: `${cw}px`, top: `${H - cb - ch}px`, height: `${ch}px` });
    tabAt(H - cb - ch);
    return;
  }
  Object.assign(D.roster.style, { left: `${rx}px`, width: `${rw}px`, top: `${top}px`, height: `${Math.max(150, H - rb - top)}px` });
  Object.assign(D.con.style, { left: `${cx}px`, width: `${cw}px`, top: `${top}px`, height: `${Math.max(150, H - cb - top)}px` });
  tabAt(top);
  // A narrow console (small window): the side columns give the list room.
  D.con.classList.toggle("is-narrow", cw < 860);
}

// The command column sits top LEFT, where Foundry's scene tools were (they
// step away in battle, battle-focus.js). Brought back, the tools / scene list
// push it right / down. Nothing else lives on the left edge, so it never meets
// the turn-order bar (top centre) or the Event Clocks (top right).
function placeBar(s) {
  const ctl = rectOf("controls"), nav = rectOf("navigation"), logo = rectOf("logo");
  const x = ctl || logo ? Math.round(Math.max(ctl?.right ?? 0, logo?.right ?? 0) / s + 10) : 14;
  const y = Math.max(L.barTop, Math.round(Math.max(nav?.bottom ?? 0, ctl ? 0 : logo?.bottom ?? 0) / s + 8));
  return { x, y, w: D.bar.offsetWidth || L.barW, h: D.bar.offsetHeight || 0 };
}

function tick() {
  if (!D.root?.isConnected) return;
  place();
  if (D.ringLit && D.ringLit.until < Date.now()) D.ringLit = null;
  if (D.hover || D.ringLit) positionRing();
  // The action card (above the desk) owns Enter / Esc while it is open.
  const card = document.getElementById("fud-battlefield-card-root");
  const open = !!card && card.classList.contains("is-visible") && !card.classList.contains("is-hidden-during-pick") && !!card.querySelector(".fud-bf-card");
  if (open !== D.cardOpen) { D.cardOpen = open; D.root.classList.toggle("is-card", open); render(); }
  try { syncCardRx(); } catch (e) { warn("[GmDesk] card reactions sync failed", e); }
  try { placeCardAside(); } catch (e) { warn("[GmDesk] card step-aside failed", e); }
  // Done chips expire.
  const now = Date.now();
  let expired = false;
  for (const [k, v] of D.done) if (v.until < now) { D.done.delete(k); expired = true; }
  if (expired) paintRxCells();
  if (D.take) positionRing();
}

// ── battle bar ────────────────────────────────────────────────────────────────
function settingOn(key) { try { return game.settings.get(MODULE_ID, key) === true; } catch { return false; } }
async function autopilotModules() {
  if (_ap) return _ap;
  const [a, s] = await Promise.all([import("./enemy-autopilot.js"), import("./summon-autopilot.js")]);
  _ap = { a, s };
  return _ap;
}
// A side choosing who acts: forcing a turn / round end there broke the turn
// order (director-boot.js refuses it too) — the buttons wait for the pick.
function skipBlocked() { return D.turnStatus?.phase === "picking" || !!D.take; }
const SKIP_BLOCKED_TIP = "Pick who acts first. Skipping during the pick would break the turn order.";
let _apState = { ai: false, summons: false };
function paintBar() {
  if (!D.bar) return;
  autopilotModules().then(({ a, s }) => {
    _apState = { ai: a.isAutopilotEnabled(), summons: s.isSummonAutopilotEnabled() };
    if (!D.bar) return;
    const blocked = skipBlocked();
    // The right-edge tools step away in battle (battle-focus.js); each is here
    // when its button exists on this client.
    const tool = (k, svg) => (toolAvailable(k) ? `<span data-cmd="tool" data-tool="${k}" title="${FOCUS_TOOLS[k].tip}">${svg}<span class="lbl">${FOCUS_TOOLS[k].label}</span></span>` : "");
    const tools = tool("clocks", SVG.clock) + tool("check", SVG.target) + tool("roll", SVG.die) + tool("effects", SVG.spark);
    const h = `<span data-cmd="ai" title="Enemy autopilot (same switch as the dev tools)"><span class="gmd-sw${_apState.ai ? " on" : ""}"></span><span class="lbl">AI</span></span>
      <span data-cmd="summons" title="Summon autopilot (same switch as the dev tools)"><span class="gmd-sw${_apState.summons ? " on" : ""}"></span><span class="lbl">Summons</span></span>
      <span class="gmd-bsep"></span>
      <span data-cmd="turn"${blocked ? ' class="off"' : ""} title="${blocked ? SKIP_BLOCKED_TIP : "Next Turn — skip the current turn"}">${SVG.next}<span class="lbl">Turn</span></span>
      <span data-cmd="round"${blocked ? ' class="off"' : ""} title="${blocked ? SKIP_BLOCKED_TIP : "Next Round — end this round"}">${SVG.round}<span class="lbl">Round</span></span>
      <span data-cmd="rewind" title="Rewind to a checkpoint">${SVG.rewind}<span class="lbl">Rewind</span></span>
      <span data-cmd="end" class="end" title="End the battle">${SVG.end}<span class="lbl">End</span></span>
      ${tools ? `<span class="gmd-bsep"></span>${tools}` : ""}
      <span class="gmd-bsep"></span>
      <span data-cmd="more"${D.moreOpen ? ' class="open"' : ""} title="EXP, developer tools, desk size, and bringing back what battle hid">${SVG.more}<span class="lbl">More</span></span>`;
    if (D.bar._h === h) return;
    D.bar._h = h;
    D.bar.innerHTML = h;
    D.placeKey = "";
    place();
  }).catch((e) => warn("[GmDesk] battle bar paint failed", e));
}
async function onBarClick(e) {
  const b = e.target.closest?.("[data-cmd]");
  if (!b) return;
  e.stopPropagation();
  if (b.classList.contains("off") && (b.dataset.cmd === "turn" || b.dataset.cmd === "round")) { ui.notifications?.info(SKIP_BLOCKED_TIP); return; }
  playUiClickSfx();
  const cmd = b.dataset.cmd;
  try {
    if (cmd === "ai" || cmd === "summons") {
      const { a, s } = await autopilotModules();
      if (cmd === "ai") await a.setAutopilotEnabled(!a.isAutopilotEnabled());
      else await s.setSummonAutopilotEnabled(!s.isSummonAutopilotEnabled());
      paintBar();
    } else if (cmd === "turn" || cmd === "round") {
      if (skipBlocked()) { ui.notifications?.info(SKIP_BLOCKED_TIP); return; }
      await runOnHost(cmd);
    } else if (cmd === "rewind") {
      const btn = document.getElementById("fud-rewindbtn");
      if (btn) btn.click(); else ui.notifications?.warn("Rewind is not available right now.");
    } else if (cmd === "end") {
      const api = globalThis.FUCompanion?.api;
      const endBtn = document.querySelector('#oni-combatbtn[data-mode="end"]');
      if (endBtn) endBtn.click();
      else if (typeof api?.battleEndManager === "function") await api.battleEndManager();
      else ui.notifications?.warn("The Battle End manager is not available.");
    } else if (cmd === "tool") {
      openTool(b.dataset.tool);
    } else if (cmd === "more") {
      setMoreOpen(!D.moreOpen);
    }
  } catch (err) { warn(`[GmDesk] battle bar "${cmd}" failed`, err); }
}

// ── More menu: EXP, dev tools, desk size, bring back what battle hid ─────────
function setMoreOpen(on) {
  D.moreOpen = !!on;
  if (!D.moreOpen) { D.more?.remove(); D.more = null; }
  else {
    if (!D.more) {
      D.more = document.createElement("div");
      D.more.className = "gmd-more";
      D.more.addEventListener("click", onMoreClick);
      D.root.appendChild(D.more);
    }
    paintMore();
  }
  D.bar?.querySelector('[data-cmd="more"]')?.classList.toggle("open", D.moreOpen);
  placeMore();
}
function paintMore() {
  if (!D.more) return;
  const f = focusState();
  const ck = (on) => `<span class="ck${on ? " on" : ""}"></span>`;
  const parts = FOCUS_PARTS.filter((p) => p.key !== "devtools");
  D.more.innerHTML = `
    ${toolAvailable("exp") ? `<div class="it" data-mi="exp">EXP Awarder<small>after victory</small></div>` : ""}
    <div class="it" data-mi="part" data-key="devtools">${ck(f.show.devtools)}Developer tools</div>
    <div class="it" style="cursor:default">Desk size<span class="gmd-size" data-size title="Desk size (this browser)">${Object.keys(SIZES).map((k) => `<span data-sz="${k}" class="${k === D.size ? "on" : ""}">${k.toUpperCase()}</span>`).join("")}</span></div>
    <hr><div class="h">Bring back during battle</div>
    ${parts.map((p) => `<div class="it" data-mi="part" data-key="${p.key}">${ck(f.show[p.key])}${p.label}</div>`).join("")}
    <hr><div class="it" data-mi="all">${ck(f.all)}Show everything<small>until battle ends</small></div>`;
}
function placeMore() {
  if (!D.more || !D.bar) return;
  const b = D.bar.querySelector('[data-cmd="more"]');
  const top = D.bar.offsetTop + (b ? b.offsetTop : 0);
  Object.assign(D.more.style, { left: `${D.bar.offsetLeft + D.bar.offsetWidth + 8}px`, top: `${Math.max(8, top - 8)}px` });
  // Keep it inside the window: the desk root is the window in stage px.
  const H = D.root.offsetHeight || window.innerHeight;
  const over = D.more.offsetTop + D.more.offsetHeight - (H - 8);
  if (over > 0) D.more.style.top = `${Math.max(8, D.more.offsetTop - over)}px`;
}
function onMoreClick(e) {
  e.stopPropagation();
  if (e.target.closest?.("[data-size]")) { onSizeClick(e); paintMore(); return; }
  const it = e.target.closest?.("[data-mi]");
  if (!it) return;
  playUiClickSfx();
  const mi = it.dataset.mi;
  if (mi === "exp") { setMoreOpen(false); openTool("exp"); return; }
  if (mi === "part") setFocusPart(it.dataset.key, !focusState().show[it.dataset.key]);
  else if (mi === "all") setFocusAll(!focusState().all);
  paintMore();
  D.placeKey = "";
  place();
}
function onDocPointer(e) {
  if (!D.moreOpen) return;
  if (D.more?.contains(e.target) || D.bar?.querySelector('[data-cmd="more"]')?.contains(e.target)) return;
  setMoreOpen(false);
}

// Turn / Round drive the FSM, which lives on the host (first) GM: a secondary
// GM's click is sent there, like its other battle input.
async function runOnHost(cmd) {
  const primary = globalThis.FUCompanion?.isPrimaryGM?.() ?? true;
  if (primary) return runCmd(cmd);
  const host = globalThis.FUCompanion?.primaryGM?.();
  if (!host || !ensureSocket()) { ui.notifications?.warn("The host GM is not connected."); return; }
  return _socket.executeAsUser(ACTION_CMD, host.id, { cmd });
}
async function runCmd(cmd) {
  const bd = globalThis.FUCompanion?.api?.experimental?.battleDirector;
  const res = cmd === "turn" ? await bd?.forceNextTurn?.() : cmd === "round" ? await bd?.forceNextRound?.() : null;
  if (res && res.ok === false) ui.notifications?.warn(`${cmd === "turn" ? "Next Turn" : "Next Round"}: ${res.error}`);
  return res ?? null;
}

// ── roster ────────────────────────────────────────────────────────────────────
/** Every client gets the turn-actions snapshot (director-round-banner.js). */
export function deskUnits(list) {
  _units = Array.isArray(list) ? list : null;
  if (!D.root) return;
  D.units = _units;
  paintRoster();
  render();
}
function unitList() {
  if (D.units?.length) return D.units;
  // Before the first snapshot: the party, from the HUD.
  return [...D.party].map((id) => {
    const a = game.actors?.get(id);
    const t = canvas?.tokens?.placeables?.find((p) => p.document?.actorId === id);
    return a ? { id: `party-${id}`, side: "party", name: t?.name ?? a.name, img: a.img, tokenUuid: t?.document?.uuid ?? null, tokenId: t?.id ?? null, actorId: id, turnsRemaining: 1, turnsPerRound: 1 } : null;
  }).filter(Boolean);
}
function unitActor(u) { return tokenOf(u)?.actor ?? (u.actorId ? game.actors?.get(u.actorId) : null); }
function unitFace(u, actor) {
  const t = u.img && !isVideo(u.img) ? u.img : null;
  return t || actor?.img || "icons/svg/mystery-man.svg";
}
function controllerOf(u, actor) {
  if (u.side === "enemy") return { text: "GM", gm: true };
  const p = playerOwnerOf(actor);
  if (!p) return { text: "GM", gm: true };
  return { text: p.active ? p.name : `${p.name} (away)`, gm: !p.active, user: p };
}

let _rowsQueued = false;
function scheduleRows() {
  if (_rowsQueued || !D.root) return;
  _rowsQueued = true;
  setTimeout(() => { _rowsQueued = false; paintRows(); if (D.take) paintTake(); }, 120);
}

function paintRoster() {
  if (!D.roster) return;
  const list = unitList();
  const cols = { enemy: D.roster.querySelector('[data-side="enemy"]'), party: D.roster.querySelector('[data-side="party"]') };
  const want = new Set(list.map((u) => u.id));
  for (const [id, r] of D.rows) if (!want.has(id)) { r.el.remove(); D.rows.delete(id); }
  for (const u of list) {
    let r = D.rows.get(u.id);
    if (!r) {
      const el = document.createElement("div");
      el.className = "gmd-ur";
      el.dataset.uid = u.id;
      el.innerHTML = `<span class="st"></span><img class="face" alt=""><span class="nm"></span><span class="hp"></span><span class="mp"></span><span class="gmd-rxc"></span>`
        + `<span class="bar"><i class="tr"></i><i class="fl"></i></span><span class="x2"></span><span class="stamp"></span>`;
      r = { el, u, q: (s) => el.querySelector(s) };
      D.rows.set(u.id, r);
    }
    r.u = u;
    const col = cols[u.side === "enemy" ? "enemy" : "party"];
    if (r.el.parentElement !== col) col.appendChild(r.el);
  }
  // Keep each column in snapshot order.
  for (const side of ["enemy", "party"]) {
    const col = cols[side];
    for (const u of list.filter((x) => (x.side === "enemy" ? "enemy" : "party") === side)) col.appendChild(D.rows.get(u.id).el);
    const n = list.filter((x) => (x.side === "enemy" ? "enemy" : "party") === side).length;
    col.querySelector(".gmd-cap").textContent = `${side === "enemy" ? "Enemies" : "Party"} · ${n}`;
  }
  paintRows();
}

function paintRows() {
  for (const r of D.rows.values()) paintRow(r);
  paintRxCells();
}
function clockSVG(v, m) {
  const f = m > 0 ? clamp(v / m, 0, 1) : 1;
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="rgba(58,50,40,.2)" stroke-width="3"/><circle cx="10" cy="10" r="8" fill="none" stroke="#ff8a1e" stroke-width="3" stroke-dasharray="${(50.3 * f).toFixed(1)} 60" transform="rotate(-90 10 10)"/></svg>`;
}
function paintRow(r) {
  const u = r.u, actor = unitActor(u);
  const info = actor ? readUnitInfo(actor) : null;
  const hp = info?.hp, mp = info?.mp;
  const ctl = controllerOf(u, actor);
  const face = unitFace(u, actor);
  const img = r.q(".face");
  if (img.getAttribute("src") !== face) img.setAttribute("src", face);
  const nmHTML = `${esc(u.name)}<small>${esc(ctl.text)}</small>`;
  if (r._nm !== nmHTML) { r.q(".nm").innerHTML = nmHTML; r._nm = nmHTML; }
  r.q(".hp").textContent = hp ? `${Math.round(hp.v)}/${Math.round(hp.m)}` : "–";
  r.q(".mp").textContent = mp ? `${Math.round(mp.v)}` : "";
  r.q(".mp").title = mp ? `MP ${Math.round(mp.v)} / ${Math.round(mp.m)}` : "";
  const fl = r.q(".bar .fl"), tr = r.q(".bar .tr");
  const w = hp ? pctOf(hp.v, hp.m) : "0%";
  fl.style.width = w;
  const prevW = parseFloat(tr.style.width || "0");
  // The trail drops slowly behind a loss and jumps up with a heal.
  if (!tr.style.width || parseFloat(w) >= prevW) { tr.style.transition = "none"; tr.style.width = w; void tr.offsetWidth; tr.style.transition = ""; }
  else tr.style.width = w;
  const ko = !!(hp && hp.v <= 0) || !!u.defeated;
  const crisis = !ko && !!(hp && hp.v <= hp.m / 2);
  r.el.classList.toggle("is-ko", ko);
  r.el.classList.toggle("is-crisis", crisis);
  r.q(".stamp").textContent = ko ? "KO" : crisis ? "Crisis" : "";
  // Party extras (what the GM's party cards showed): IP pips, ZP, Clocks.
  let x2 = "";
  if (info && (D.party.has(String(u.actorId)) || D.party.has(String(actor?.id)))) {
    const ip = info.ip;
    if (ip) x2 += `<span class="ipd" title="IP ${ip.v} / ${ip.m}">${Array.from({ length: Math.min(ip.m, 12) }, (_, i) => `<i class="${i < ip.v ? "on" : ""}"></i>`).join("")}</span>`;
    if (info.zp && info.zpName) x2 += `<span class="zp" title="${esc(info.zpName)}">ZP ${info.zp.v}/${info.zp.m}</span>`;
  }
  for (const c of info?.clocks ?? []) x2 += `<span class="clk" title="${esc(c.name)} ${c.v}${c.m ? ` / ${c.m}` : ""}">${clockSVG(c.v, c.m ?? 0)}${c.m ? `${c.v}/${c.m}` : `✦${c.v}`}</span>`;
  if (r._x2 !== x2) { r.q(".x2").innerHTML = x2; r._x2 = x2; }
  // Status slot: ▶ when this unit may take the turn now, else the dot.
  const st = r.q(".st");
  const ti = D.take ? D.take.entries.findIndex((e) => e.combatantId === u.id) : -1;
  const acting = !!u.active;
  r.el.classList.toggle("is-acting", acting);
  if (ti >= 0) {
    const ok = takeEnabled(D.take.entries[ti]);
    const html = `<span class="gmd-tt${ok ? "" : " off"}" data-take="${ti}" title="${ok ? "Take Turn" : `${esc(D.take.entries[ti].owner?.name ?? "The player")} chooses`}">▶</span>`;
    if (st._h !== html) { st.innerHTML = html; st._h = html; }
  } else {
    const cls = acting ? "acting" : (Number(u.turnsPerRound) === 0 ? "noturn" : Number(u.turnsRemaining) > 0 ? "" : "acted");
    const html = `<span class="gmd-dot ${cls}" title="${acting ? "Acting" : cls === "noturn" ? "No turn of its own" : cls === "acted" ? "Acted this round" : "Can act"}"></span>`;
    if (st._h !== html) { st.innerHTML = html; st._h = html; }
  }
}

function rowForToken(tokenId) {
  for (const r of D.rows.values()) if (r.u.tokenId === tokenId || (r.u.tokenUuid && r.u.tokenUuid.endsWith(`.${tokenId}`))) return r;
  return null;
}
/** Apply on a card pill: its follow-up pickers belong to that reactor (console header). */
function onCardPointer(e) {
  const pill = e.target?.closest?.('#fud-battlefield-card-root [data-fud-reaction-action="apply"]')?.closest?.(".fud-bf-reaction-pill");
  const uuid = pill?.getAttribute("data-fud-reactor-uuid");
  if (!uuid) return;
  let actor = null;
  try { actor = fromUuidSync(uuid); } catch { /* */ }
  if (actor) noteContext(actor, /Token\.([^.]+)/.exec(uuid)?.[1] ?? null);
}
function paintRxCells() {
  if (!D.root) return;
  const byRow = new Map();
  for (const e of D.rx.values()) { const r = rowForToken(e.tokenId); if (r) byRow.set(r, e); }
  for (const r of D.rows.values()) {
    const e = byRow.get(r);
    const cell = r.q(".gmd-rxc");
    let html = "";
    const done = D.done.get(r.u.tokenId);
    if (e) {
      const n = e.candidates.filter((c) => c?.mode !== "on" && c?.mode !== "done").length;
      const names = e.candidates.filter((c) => c?.mode !== "on" && c?.mode !== "done").map((c) => c.carrierName).join(" · ");
      const on = D.rxCur === e.key;
      const owner = liveOwnerOf(e.actor);
      const state = !owner ? `<span class="gmd-chip you">${on ? "Answering" : "Your call"}</span>`
        : on && !D.locked ? `<span class="gmd-chip you">Answering</span>`
        : `<span class="gmd-chip pl"><span class="gmd-live"><i></i></span>${D.locked ? "Deciding" : "Or you"}</span>`;
      html = `<span class="gmd-rxc-in" title="${esc(names)}" style="display:contents"><span class="gmd-cnt">⚡${n}</span>${state}</span>`;
    } else if (done) {
      html = `<span class="gmd-chip done">${esc(done.text)}</span>`;
    }
    const others = presenceOn(r.u.tokenId);
    if (others.length) html = `<span class="gmd-chip gmp" title="${esc(others.join(", "))} has this open">${esc(others.join(", "))}</span>` + html;
    if (cell._h !== html) { cell.innerHTML = html; cell._h = html; }
    cell.classList.toggle("isdone", !e && !!done);
    r.el.classList.toggle("hasrx", !!e);
    r.el.classList.toggle("rxsel", !!e && D.rxCur === e.key);
  }
  // Header banner: the open trigger.
  const wrap = D.roster.querySelector(".gmd-banwrap");
  const open = [...D.rx.values()];
  let ban = "";
  if (open.length) {
    const total = open.reduce((s, e) => s + e.candidates.filter((c) => c?.mode !== "on" && c?.mode !== "done").length, 0);
    const label = open[0].label ?? "Reaction";
    const kind = open.length > 1 ? `${open.length} menus at once` : "one at a time";
    ban = `<span class="gmd-ban"><span class="gmd-cnt">⚡${total}</span><b>${esc(label)}</b><span class="k">${esc(kind)}</span></span>`;
  }
  if (wrap._h !== ban) { wrap.innerHTML = ban; wrap._h = ban; }
}

function onRosterClick(e) {
  if (e.target.closest?.("[data-size]")) { onSizeClick(e); return; }
  if (e.target.closest?.("[data-fold]")) { e.stopPropagation(); playUiClickSfx(); setFolded(!D.folded); return; }
  const tt = e.target.closest?.("[data-take]");
  if (tt) { e.stopPropagation(); pickTile(Number(tt.dataset.take)); return; }
  const row = e.target.closest?.(".gmd-ur");
  if (!row) return;
  const r = D.rows.get(row.dataset.uid);
  if (!r) return;
  // Every line shows its creature on the field; a line with a reaction menu
  // also opens that menu in the console.
  const entry = [...D.rx.values()].find((x) => rowForToken(x.tokenId) === r);
  playUiClickSfx();
  if (entry) selectRx(entry.key, { user: true });
  showOnField(r);
}
function onRosterDblClick(e) {
  const row = e.target.closest?.(".gmd-ur");
  const r = row ? D.rows.get(row.dataset.uid) : null;
  if (!r || e.target.closest?.("[data-take]")) return;
  const actor = unitActor(r.u);
  try { actor?.sheet?.render(true); } catch (err) { warn("[GmDesk] open sheet failed", err); }
}
function onRosterOver(e) {
  const row = e.target.closest?.(".gmd-ur");
  const uid = row?.dataset.uid ?? null;
  if (uid === D.hover) return;
  D.hover = uid;
  positionRing(true);
}
// The camera glides to the creature (through the battle camera, so it stays in
// the play area) and its ring glows for a moment. Never while the battle is
// moving the camera itself.
async function showOnField(r) {
  D.ringLit = { uid: r.u.id, until: Date.now() + 1600 };
  positionRing(true);
  const tok = tokenOf(r.u)?.object;
  if (!tok || !canvas?.ready) return;
  try {
    const ca = await import("./camera-authority.js");
    if (ca.isCameraSuspended?.()) return;
    const cam = await import("./director-camera.js");
    await cam.panTo({ x: tok.center.x, y: tok.center.y, scale: canvas.stage.scale.x }, { duration: 450 });
  } catch (err) { warn("[GmDesk] show on field failed", err); }
}

// ── size S / M / L, fold, peek ────────────────────────────────────────────────
function paintHeaderControls() {
  const el = D.roster?.querySelector(".gmd-hctl");
  if (!el) return;
  // Desk size lives in the command column's More menu; Fold is the drawer tab
  // on the panels' top edge (paintFoldTab).
  const h = "";
  paintFoldTab();
  if (el._h !== h) { el.innerHTML = h; el._h = h; }
}
function paintFoldTab() {
  const t = D.foldTab;
  if (!t) return;
  const h = `${D.folded ? SVG.unfold : SVG.fold}<span>${D.folded ? "Show" : "Fold"}</span>`;
  if (t._h !== h) { t.innerHTML = h; t._h = h; }
  t.title = D.folded ? "Show the whole desk" : "Fold the desk down to its header strips. A new decision for you opens it again.";
}
// What is waiting on this GM right now — the fold remembers it, so folding over
// an open decision sticks until a different one arrives.
function decisionSig() {
  const layer = activeLayer();
  if (layer === "react") return `react|${D.rxCur ?? ""}`;
  if (layer === "take") return `take|${(D.take?.entries ?? []).map((e) => e.combatantId).join(",")}`;
  if (layer === "step") return `step|${D.step?.holdActorId ?? ""}`;
  return layer;
}
function onSizeClick(e) {
  const k = e.target.closest?.("[data-sz]")?.dataset.sz;
  e.stopPropagation();
  if (!k || !SIZES[k] || k === D.size) return;
  playUiClickSfx();
  D.size = k;
  try { localStorage.setItem(SIZE_KEY, k); } catch { /* */ }
  paintHeaderControls();
  D.placeKey = "";
  place();
  positionRing(true);
}
function setFolded(on) {
  D.folded = !!on;
  try { localStorage.setItem(FOLD_KEY, D.folded ? "1" : "0"); } catch { /* */ }
  // A click always folds now: a decision already waiting for this GM no longer
  // holds the desk open (only a NEW one re-opens it — see render()).
  D.foldAck = D.folded ? decisionSig() : null;
  paintHeaderControls();
  render();
}
function setPeek(on) {
  if (!D.root || D.peek === !!on) return;
  D.peek = !!on;
  D.root.classList.toggle("is-peek", D.peek);
}
function scrollRosterTo(tokenId) {
  const r = rowForToken(tokenId);
  if (!r) return;
  const col = r.el.parentElement;
  const head = col.querySelector(".gmd-cap")?.offsetHeight ?? 26;
  if (r.el.offsetTop < col.scrollTop + head || r.el.offsetTop + r.el.offsetHeight > col.scrollTop + col.clientHeight) col.scrollTop = Math.max(0, r.el.offsetTop - head - 2);
}

// ── lock ──────────────────────────────────────────────────────────────────────
function toggleLock() {
  D.locked = !D.locked;
  try { localStorage.setItem(LOCK_KEY, D.locked ? "1" : "0"); } catch { /* */ }
  playUiClickSfx();
  paintRows();
  if (D.take) paintTake();
  render();
}
const lockHTML = () => `<span class="gmd-lock" data-lock title="Watch: the player decides. Act: answer for them."><span class="w${D.locked ? " on" : ""}">${SVG.lock}Watch</span><span class="a${D.locked ? "" : " on"}">${SVG.unlock}Act</span></span>`;

// ── console: which layer, header, footer ──────────────────────────────────────
function stepLive() {
  const s = D.step;
  if (!s) return false;
  if (s.holds > 0) return !!(s.cmdsEl.childElementCount || s.workEl.childElementCount);
  return [...s.cmdsEl.children, ...s.workEl.children].some((n) => !n.inert);
}
function reactLive() { return !!D.rxCur && D.rx.has(D.rxCur); }
function activeLayer() {
  const cands = [];
  if (stepLive()) cands.push(["step", D.z.step]);
  if (D.take) cands.push(["take", D.z.take]);
  if (reactLive()) cands.push(["react", D.z.react]);
  if (!cands.length) return D.cardOpen ? "card" : "idle";
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0][0];
}
function stepActor() {
  const id = D.step?.holdActorId ?? null;
  if (id) return game.actors?.get(id) ?? null;
  return null;
}
/** The creature a picker without an actor of its own answers for: a reaction's
 *  user, a card pill's carrier, else whoever is acting. */
function contextActorId() {
  if (D.ctx && Date.now() - D.ctx.at < CTX_MS) return D.ctx;
  const ts = D.turnStatus;
  if (ts?.phase === "acting" && ts.actorId) {
    const u = unitList().find((x) => x.active);
    return { actorId: ts.actorId, tokenId: u?.actorId === ts.actorId ? u.tokenId : null };
  }
  return null;
}
function noteContext(actor, tokenId = null) {
  const id = baseActorOf(actor)?.id ?? actor?.id ?? null;
  D.ctx = id ? { actorId: String(id), tokenId: tokenId ?? null, at: Date.now() } : null;
}

function render() {
  if (!D.root) return;
  const layer = activeLayer();
  const cb = D.cbody;
  let locked = false, mirrorFor = null, forPlayer = null;
  if (layer === "step") {
    const a = stepActor();
    const owner = liveOwnerOf(a);
    if (owner) { locked = D.locked; if (locked) mirrorFor = a?.id; else forPlayer = owner; }
  } else if (layer === "react") {
    const e = D.rx.get(D.rxCur);
    const owner = liveOwnerOf(e?.actor);
    if (owner) { locked = D.locked; if (locked) mirrorFor = baseActorOf(e.actor)?.id; else forPlayer = owner; }
  }
  const mirror = mirrorFor ? D.mirror.get(mirrorFor) : null;
  const showMirror = !!(mirror?.open && mirror.html);
  for (const [k, el] of Object.entries(D.layers)) {
    const on = k === "mirror" ? showMirror : k === "idle" ? (layer === "idle" || layer === "card") : k === layer && !showMirror;
    el.classList.toggle("is-off", !on);
    el.classList.toggle("is-locked", k === layer && locked);
  }
  if (showMirror) paintMirror(mirror);
  cb.className = `gmd-cbody l-${layer === "card" ? "card" : layer}`;
  if (layer === "step") {
    const hasCmds = !!D.step.cmdsEl.childElementCount;
    cb.classList.toggle("has-cmds", hasCmds);
    cb.classList.toggle("has-view", !!D.step.workEl.querySelector(".dhv-view"));
    cb.classList.toggle("has-targets", !!D.step.workEl.querySelector(".dhv-tcols"));
    cb.classList.toggle("has-adopt", !!D.step.workEl.querySelector(".gmd-adopt:not([inert])"));
    cb.classList.toggle("cmds-live", !!D.step.cmdsEl.querySelector(".fud-octopath:not([inert])"));
  }
  if (showMirror) {
    cb.classList.toggle("has-cmds", /fud-octopath/.test(mirror.html) || !!mirror.cmds);
    cb.classList.toggle("has-view", /dhv-view/.test(mirror.html));
    cb.classList.toggle("has-targets", /dhv-tcols/.test(mirror.html));
  }
  // Red bar: answering for a player.
  const fbar = cb.querySelector(".gmd-fbar");
  const fb = forPlayer ? `${SVG.unlock}<span>You are answering for <b>${esc(forPlayer.name)}</b>. Their menu closes as soon as you answer.</span>` : "";
  if (fbar._h !== fb) { fbar.innerHTML = fb; fbar._h = fb; }
  paintHeader(layer, { locked, forPlayer, mirror: showMirror ? mirror : null });
  if (layer === "idle" || layer === "card") paintIdle(layer);
  if (layer === "react") paintRxDetail();
  // A decision for THIS GM: the desk unfolds by itself, and an away window's tab calls.
  const mine = (layer === "take" && D.take?.entries.some((e) => takeEnabled(e)))
    || (layer === "react" && !locked) || (layer === "step" && !locked);
  const fold = D.folded && (!mine || D.foldAck === decisionSig());
  if (fold !== D.foldShown) {
    const root = D.root;
    root.classList.add("is-folding");
    clearTimeout(root._foldT);
    root._foldT = setTimeout(() => root.classList.remove("is-folding"), MOTION.fold + 60);
    D.foldShown = fold; root.classList.toggle("is-folded", fold); D.placeKey = ""; place();
  }
  // New content in the console (another layer, the next reaction menu) fades in.
  const sig = `${showMirror ? "mirror" : layer === "card" ? "idle" : layer}|${layer === "react" ? D.rxCur ?? "" : ""}`;
  if (sig !== D.swapSig) { const first = D.swapSig == null; D.swapSig = sig; if (!first) swapConsole(mine); }
  if (mine) tabAlert("gm-desk", layer === "take" ? "★ Take Turn" : layer === "react" ? "★ Your call" : D.step?.cmdsEl?.querySelector(".fud-octopath:not([inert])") ? "★ Your turn" : "★ Your pick");
  else tabAlertClear("gm-desk");
  sendPresence(layer, locked);
}

// ── two GMs: who has what open ────────────────────────────────────────────────
// Each GM tells the others which creature its console is on (a reaction line,
// the highlighted Take Turn tile, the unit it composes for). Nothing is locked:
// first answer still wins; the chip just stops two GMs starting the same one.
function otherGmIds() { return (game.users?.contents ?? []).filter((u) => u.isGM && u.active && u.id !== game.user?.id).map((u) => u.id); }
function focusOf(layer, locked) {
  if (layer === "react") { const e = D.rx.get(D.rxCur); return e ? { tokenId: e.tokenId, what: "reaction" } : null; }
  if (layer === "take") { const e = D.take?.entries?.[D.take.cur]; const id = e?.token?.id ?? e?.token?.document?.id; return id ? { tokenId: id, what: "take" } : null; }
  if (layer === "step" && !locked) { const a = stepActor(); const u = a ? unitForActorId(a.id) : null; return u?.tokenId ? { tokenId: u.tokenId, what: "turn" } : null; }
  return null;
}
function sendPresence(layer, locked) {
  const f = focusOf(layer, locked);
  const sig = f ? `${f.tokenId}|${f.what}` : "";
  if (sig === D.focusSig) return;
  D.focusSig = sig;
  const ids = otherGmIds();
  if (!ids.length || !ensureSocket()) return;
  try { _socket.executeForUsers(ACTION_PRESENCE, ids, { userId: game.user?.id, tokenId: f?.tokenId ?? null, what: f?.what ?? null }); }
  catch (e) { warn("[GmDesk] presence send failed", e); }
}
function receivePresence(p) {
  if (!game.user?.isGM || !p?.userId || p.userId === game.user.id) return;
  if (p.tokenId) D.presence.set(p.userId, { tokenId: p.tokenId, what: p.what ?? null, at: Date.now() });
  else D.presence.delete(p.userId);
  if (!D.root) return;
  paintRxCells();
  if (D.take) paintTake();
  render();
}
/** Names of the other GMs whose console is on this token. */
function presenceOn(tokenId) {
  if (!tokenId) return [];
  const out = [];
  for (const [uid, pr] of D.presence) {
    const u = game.users?.get(uid);
    if (pr.tokenId === tokenId && u?.active) out.push(u.name);
  }
  return out;
}

function whoHTML({ img, name, sub, actor }) {
  const info = actor ? readUnitInfo(actor) : null;
  const res = info?.hp ? `<span class="gmd-res"><span class="h">HP ${Math.round(info.hp.v)}/${Math.round(info.hp.m)}</span>${info.mp ? `<span class="m">MP ${Math.round(info.mp.v)}/${Math.round(info.mp.m)}</span>` : ""}</span>` : "";
  return `<div class="gmd-who">${img ? `<img src="${esc(img)}" alt="">` : ""}<div style="min-width:0"><div class="n">${esc(name)}</div><div class="s">${sub}</div></div>${res}</div>`;
}
// Unlinked tokens (three Bandits) share one actor id: prefer the named token,
// then the unit acting now, then the first.
function unitForActorId(actorId, tokenId = null) {
  const list = unitList().filter((u) => u.actorId === actorId);
  return (tokenId && list.find((u) => u.tokenId === tokenId)) || list.find((u) => u.active) || list[0] || null;
}
function paintHeader(layer, { locked, forPlayer, mirror }) {
  let h = "";
  const ts = D.turnStatus;
  if (layer === "step") {
    const held = stepActor();
    // A picker opened by a reaction or a card pill holds no actor: name whose it is.
    const ctx = held ? null : contextActorId();
    const a = held ?? (ctx ? game.actors?.get(ctx.actorId) ?? null : null);
    const owner = liveOwnerOf(held);
    const u = a ? unitForActorId(a.id, held ? null : ctx?.tokenId) : null;
    const crumb = mirror?.crumb || D.step.crumb || "Turn Action";
    const ctl = owner ? `${esc(owner.name)}'s ${locked ? "menu" : "turn"}` : "GM";
    h = a ? whoHTML({ img: unitFace(u ?? {}, a), name: u?.name ?? a.name, sub: `${esc(crumb)} <span class="c">· ${ctl}</span>`, actor: unitActor(u ?? {}) ?? a })
      : `<div class="gmd-who"><div><div class="n">${esc(crumb)}</div><div class="s">GM</div></div></div>`;
    h += `<span class="gmd-grow"></span>${owner ? lockHTML() : ""}`;
  } else if (layer === "take") {
    const t = D.take;
    const party = t.side !== "enemy";
    const players = t.entries.some((e) => e.owner?.active);
    const round = Number(ts?.round) || null;
    h = `<div class="gmd-who"><div><div class="n">${party ? "Party's turn" : "Enemies' turn"}</div><div class="s">${t.entries.length} can act${round ? ` · Round ${round}` : ""}</div></div></div><span class="gmd-grow"></span>`
      + (players ? lockHTML() : `<span class="gmd-cap" style="color:var(--tx-dim)">Keys 1–${Math.min(t.entries.length, 9)}${t.entries.length > 9 ? ", 0" : ""} · arrows + Enter</span>`);
  } else if (layer === "react") {
    const e = D.rx.get(D.rxCur);
    const owner = liveOwnerOf(e.actor);
    const next = nextGmEntry(e.key);
    h = whoHTML({ img: e.img, name: `${e.name} · Reactions`, sub: `${esc(e.label ?? "Reaction")} <span class="c">· ${owner ? `${esc(owner.name)}'s menu` : "the GM decides"}</span>`, actor: e.actor })
      + `<span class="gmd-grow"></span>` + (next && !owner ? `<span class="gmd-next">${esc(next.name)} opens next by itself</span>` : "")
      + (owner ? lockHTML() : `<span class="gmd-chip foe">GM decides</span>`);
  } else {
    if (ts?.phase === "acting") {
      const a = ts.actorId ? game.actors?.get(ts.actorId) : null;
      const u = unitList().find((x) => x.active) ?? (a ? unitForActorId(a.id) : null);
      const auto = ts.side !== "party" && _apState.ai;
      h = whoHTML({ img: unitFace(u ?? {}, a) || ts.img, name: u?.name ?? ts.name ?? a?.name ?? "Acting", sub: `${ts.side === "party" ? "Party" : "Enemies"} · ${auto ? "autopilot" : "acting"}`, actor: unitActor(u ?? {}) ?? a });
      h += `<span class="gmd-grow"></span>${layer === "card" ? `<span class="gmd-chip plain">Action card open</span>` : auto ? `<span class="gmd-chip ai">Autopilot</span>` : ""}`;
    } else {
      h = `<div class="gmd-who"><div><div class="n">${layer === "card" ? "Action card" : "Battle"}</div><div class="s">${ts?.phase === "picking" ? `${ts.side === "party" ? "Party" : "Enemies"} choosing who acts` : "Between turns"}</div></div></div><span class="gmd-grow"></span>`
        + (layer === "card" ? `<span class="gmd-chip plain">Action card open</span>` : "");
    }
  }
  const f = focusOf(layer, locked);
  const same = f ? presenceOn(f.tokenId) : [];
  if (same.length) h += `<span class="gmd-chip gmp">${esc(same.join(", "))} has this open · first answer wins</span>`;
  if (D.chd._h !== h) { D.chd.innerHTML = h; D.chd._h = h; }
}
function paintIdle(layer) {
  const el = D.layers.idle;
  let h;
  if (layer === "card") {
    const answered = _crxSecs.length ? crxListHTML(_crxSecs).html : "";
    if (answered) {
      h = `<div class="gmd-crx-done"><div class="gmd-crx-list">${answered}</div></div><div class="gmd-foot"><span class="gmd-sum">Reactions answered. Press <b>Confirm</b> on the card. While the card is open, Enter and Esc belong to the card.</span></div>`;
    } else {
      const body = `The action card is open.<br>Answer its reactions and press <b>Confirm</b> on the card, as before.`;
      h = `<div class="gmd-idle"><div>${body}</div></div><div class="gmd-foot"><span class="gmd-sum">While the card is open, Enter and Esc belong to the card.</span></div>`;
    }
  } else {
    const ts = D.turnStatus;
    const waiting = [...D.rx.values()].length;
    let foot;
    if (waiting) foot = `<b>${waiting} reaction menu${waiting === 1 ? " is" : "s are"} open</b>: players are deciding. Click a line marked ⚡ to look.`;
    else if (ts?.phase === "acting") foot = `<b>${esc(ts.name || "Someone")}</b> ${ts.side === "party" ? "is taking their turn" : "is acting"}. Nothing is waiting on you.`;
    else foot = "Nothing to decide right now. The next decision opens here by itself.";
    h = `<div class="gmd-idlegrid">${idleRecentHTML()}${idleOrderHTML()}${idleAiHTML()}</div><div class="gmd-foot"><span class="gmd-sum">${foot}</span></div>`;
  }
  if (el._h !== h) { el.innerHTML = h; el._h = h; }
}
function idleRecentHTML() {
  const rows = _log.slice(0, 6).map((e) => {
    const res = (e.rows ?? []).slice(0, 3).map((r) => {
      const t = esc(r.target ?? "");
      const mode = String(r.mode ?? "");
      if (/miss/i.test(mode)) return `${t} · missed`;
      if (/no targets/i.test(mode)) return "no targets";
      const v = r.value == null || r.value === "" ? NaN : Number(r.value);
      if (!Number.isFinite(v)) return t ? `${t} · no effect` : "";
      const unit = r.type && r.type !== "HP" ? ` ${esc(r.type)}` : "";
      return /heal/i.test(mode) ? `${t} <span class="hl">+${v}${unit}</span>` : `${t} <span class="dm">−${v}${unit}</span>`;
    }).filter(Boolean);
    const more = (e.rows?.length ?? 0) > 3 ? ` +${e.rows.length - 3}` : "";
    return `<div class="gmd-lg"><span class="r">${e.round ? `R${e.round}` : ""}</span><span class="t"><b>${esc(e.who)}</b> ${esc(e.action ?? "")}${res.length ? ` → ${res.join(", ")}${more}` : ""}</span></div>`;
  }).join("");
  return `<div><span class="gmd-cap">Recent</span>${rows || `<span class="gmd-note">Actions appear here as they resolve.</span>`}</div>`;
}
// Enemies still to act this round. With the AI on, in the AI's own order
// (its initiative score, highest first); two within 2 points may swap, since
// the AI adds a small random factor ("≈").
function enemiesToAct() {
  const list = unitList().filter((u) => u.side === "enemy" && !u.defeated && Number(u.turnsRemaining) > 0);
  const score = (u) => { try { return _ap?.a?.enemyInitiativeScore?.(unitActor(u)) ?? 0; } catch { return 0; } };
  if (!_apState.ai) return list.map((u) => ({ u, close: false }));
  const scored = list.map((u) => ({ u, sc: score(u) })).sort((a, b) => b.sc - a.sc);
  return scored.map((x, i) => ({ u: x.u, close: (i > 0 && Math.abs(scored[i - 1].sc - x.sc) <= 2) || (i < scored.length - 1 && Math.abs(scored[i + 1].sc - x.sc) <= 2) }));
}
function idleOrderHTML() {
  const list = enemiesToAct();
  const acting = unitList().find((u) => u.active);
  const rows = list.slice(0, 6).map(({ u, close }, i) => {
    const nextUp = i === 0 && _apState.ai;
    const x = acting?.id === u.id ? "acting" : nextUp ? "next" : close ? "≈" : "";
    return `<div class="gmd-ord${nextUp ? " next" : ""}"><span class="k">${i + 1}</span><img src="${esc(unitFace(u, unitActor(u)))}" alt=""><span class="nm">${esc(u.name)}</span><span class="x">${x}</span></div>`;
  }).join("");
  const cap = _apState.ai ? "Enemy order · AI" : "Enemies left to act";
  return `<div><span class="gmd-cap foe">${cap}</span>${rows || `<span class="gmd-note">No enemy has a turn left this round.</span>`}</div>`;
}
function idleAiHTML() {
  if (!_apState.ai) return `<div><span class="gmd-cap">AI next</span><span class="gmd-note">AI autopilot is off: you choose each enemy's action.</span></div>`;
  const first = enemiesToAct()[0]?.u ?? null;
  if (!first?.tokenId) return `<div><span class="gmd-cap">AI next</span><span class="gmd-note">No enemy is waiting to act.</span></div>`;
  refreshAiPreview(first);
  const pv = D.aiPrev;
  const odds = pv.key.startsWith(`${first.tokenId}|`) ? pv.data : null;
  const body = odds?.length
    ? `<div class="gmd-aiw">${odds.slice(0, 5).map((o) => `<div><b>${esc(o.name)}</b><span>${o.pct}%</span></div>`).join("")}</div><span class="gmd-note">Rolled when its turn starts. Switch AI off to choose yourself.</span>`
    : `<span class="gmd-note">${pv.busy ? "Reading its action table…" : "No action pattern to preview: the GM chooses this one."}</span>`;
  return `<div><span class="gmd-cap">AI next · ${esc(first.name)}</span>${body}</div>`;
}
// Read-only: the same ActionReader stages as a real AI turn, nothing written.
function refreshAiPreview(u) {
  const key = `${u.tokenId}|${u.turnsRemaining}|${D.turnStatus?.phase ?? ""}|${D.turnStatus?.actorId ?? ""}`;
  if (D.aiPrev.key === key || D.aiPrev.busy) return;
  D.aiPrev = { key, data: null, busy: true };
  const director = globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.() ?? null;
  autopilotModules()
    .then(({ a }) => a.previewEnemyActionOdds?.({ tokenId: u.tokenId, director }))
    .then((data) => { if (D.aiPrev.key === key) D.aiPrev = { key, data: data ?? null, busy: false }; })
    .catch((e) => { warn("[GmDesk] AI preview failed", e); if (D.aiPrev.key === key) D.aiPrev = { key, data: null, busy: false }; })
    .finally(() => { if (D.root && D.aiPrev.key === key) render(); });
}

/** Host GM: an action resolved (state-handlers.js resolveAction). */
function addLog(p) {
  if (!p) return;
  let who = p.attackerName ?? "Someone";
  try { if (p.attackerTokenUuid) who = fromUuidSync(p.attackerTokenUuid)?.name ?? who; } catch { /* */ }
  _log.unshift({ round: p.round ?? null, who, action: p.actionName ?? null, rows: Array.isArray(p.rows) ? p.rows.slice(0, 8) : [] });
  _log = _log.slice(0, LOG_MAX);
}

// ── hover cue: battle bar commands, size / fold, Watch | Act ──────────────────
// Keyed by what the control is, not by its element: a repaint under a resting
// pointer swaps the element and would play the cue again.
const HOVER_SEL = ".gmd-bar > [data-cmd]:not(.off), .gmd-size [data-sz]:not(.on), [data-fold], [data-lock]";
// A description too long for its box scrolls itself (user, 2026-10-22): the
// wheel only reaches it with the mouse over it, far right of a two-column list.
// After a few seconds on an item the text drifts down slowly, rests at the end,
// goes back to the top and starts over. It holds while the mouse is on it, and
// once you scroll it yourself it is yours until the next item.
const AUTO_WAIT_MS = 3000;     // on an item before it starts moving
const AUTO_PX_PER_S = 14;      // slow enough to read along
const AUTO_REST_MS = 2500;     // at the end, before going back up
const _autoDd = new WeakMap(); // .dd element → { sig, phase, at, pos, manual }
function autoScrollDetails(now) {
  if (!D.root?.isConnected) return;
  for (const dd of D.root.querySelectorAll(".gmd-layer:not(.is-off) .gmd-detail .dd")) {
    const text = dd.textContent ?? "";
    const sig = `${text.length}:${text.slice(0, 60)}`;
    let st = _autoDd.get(dd);
    if (!st) {
      st = { sig: null };
      _autoDd.set(dd, st);
      const mine = () => { st.manual = true; };
      dd.addEventListener("wheel", mine, { passive: true });
      dd.addEventListener("pointerdown", mine);
    }
    if (st.sig !== sig) {        // another item (the node is reused): start over
      Object.assign(st, { sig, phase: "wait", at: now, pos: 0, manual: false });
      dd.scrollTop = 0;
    }
    const max = dd.scrollHeight - dd.clientHeight;
    if (st.manual || max <= 1) continue;
    if (dd.matches(":hover")) { st.at = now; continue; }   // reading it: hold
    if (st.phase === "wait") {
      if (now - st.at >= AUTO_WAIT_MS) { st.phase = "down"; st.at = now; st.pos = dd.scrollTop; }
    } else if (st.phase === "down") {
      st.pos = Math.min(max, st.pos + (AUTO_PX_PER_S * Math.min(100, now - st.at)) / 1000);
      st.at = now;
      dd.scrollTop = st.pos;
      if (st.pos >= max) st.phase = "rest";
    } else if (st.phase === "rest" && now - st.at >= AUTO_REST_MS) {
      dd.scrollTo({ top: 0, behavior: "smooth" });
      Object.assign(st, { phase: "wait", at: now, pos: 0 });
    }
  }
}
function onDeskOver(e) {
  const el = e.target.closest?.(HOVER_SEL) ?? null;
  const key = !el ? null : el.dataset.cmd ? `cmd:${el.dataset.cmd}` : el.dataset.sz ? `sz:${el.dataset.sz}` : el.hasAttribute("data-fold") ? "fold" : "lock";
  if (key === D.hoverKey) return;
  D.hoverKey = key;
  if (key) playUiHoverSfx();
}

// ── keys (Take Turn tiles) ────────────────────────────────────────────────────
function onDeskKey(e) {
  // Esc closes the More menu before anything else sees it.
  if (D.moreOpen && e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setMoreOpen(false); return; }
  if (!D.root || D.cardOpen || activeLayer() !== "take" || !D.take) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key, t = D.take, n = t.entries.length;
  const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  const hk = HOTKEYS.indexOf(k);
  if (hk >= 0 && hk < n) { swallow(); t.cur = hk; paintTake(); pickTile(hk); return; }
  const perRow = t.perRow || n;
  if (k === "ArrowRight" || k === "ArrowLeft") { swallow(); t.cur = (t.cur + (k === "ArrowRight" ? 1 : -1) + n) % n; playUiHoverSfx(); paintTake(); return; }
  if (k === "ArrowDown" || k === "ArrowUp") { swallow(); const j = t.cur + (k === "ArrowDown" ? perRow : -perRow); if (j >= 0 && j < n) { t.cur = j; playUiHoverSfx(); paintTake(); } return; }
  if (k === "Enter" || k === "z" || k === "Z") { swallow(); pickTile(t.cur); }
}

// ── Take Turn tiles (turn-picker.js) ──────────────────────────────────────────
function takeEnabled(entry) { return !(entry.owner?.active && D.locked); }
/**
 * Turn picker, GM side: the console shows one tile per unit that may act
 * instead of pills by the tokens. Returns { release() } or null (no desk).
 * @param {Array<{combatantId, actorId, name, side, token}>} entries
 * @param {(combatantId: string) => void} pick
 */
export function deskArmTakeTurn(entries, pick) {
  if (!deskActive() || !entries?.length) return null;
  const list = entries.map((e) => {
    const actor = e.token?.actor ?? (e.actorId ? game.actors?.get(e.actorId) : null);
    const owner = e.side === "enemy" ? null : playerOwnerOf(actor);
    return { ...e, actor, owner };
  });
  const cur = Math.max(0, list.findIndex((e) => takeEnabled(e)));
  const token = { entries: list, pick, cur, side: list[0]?.side ?? "party", perRow: 0 };
  D.take = token;
  bump("take");
  paintTake();
  popTiles();
  paintRows();
  const first = list.find((e) => takeEnabled(e)) ?? list[0];
  const fr = first ? D.rows.get(first.combatantId) : null;
  if (fr) scrollRosterTo(fr.u.tokenId);
  render();
  log(`[GmDesk] Take Turn: ${list.length} tile(s)`);
  return {
    release() {
      if (D.take !== token) return;
      D.take = null;
      hideRing();
      if (D.layers.take) { D.layers.take.innerHTML = ""; D.layers.take._h = null; }
      paintRows();
      render();
    },
  };
}
function pickTile(i) {
  const t = D.take;
  const e = t?.entries?.[i];
  if (!e || !takeEnabled(e)) return;
  playUiClickSfx();
  const pick = t.pick;
  try { pick(e.combatantId); } catch (err) { warn("[GmDesk] Take Turn pick threw", err); }
}
function onTakeClick(e) {
  const t = e.target.closest?.("[data-ti]");
  if (!t) return;
  e.stopPropagation();
  pickTile(Number(t.dataset.ti));
}
function paintTake() {
  const t = D.take, el = D.layers.take;
  if (!t || !el) return;
  const n = t.entries.length;
  const dens = n <= 4 ? "big" : n <= 6 ? "mid" : "small";
  const cols = dens === "big" ? Math.max(3, n) : dens === "mid" ? 3 : 4;
  t.perRow = cols;
  const tiles = t.entries.map((e, i) => {
    const actor = e.token?.actor ?? e.actor;
    const info = actor ? readUnitInfo(actor) : null;
    const hp = info?.hp ?? { v: 0, m: 1 }, mp = info?.mp;
    const ok = takeEnabled(e), k = HOTKEYS[i] ?? "";
    const gm = !e.owner;
    const u = unitList().find((x) => x.id === e.combatantId);
    const face = unitFace(u ?? { img: e.token?.document?.texture?.src }, actor);
    const sub = gm ? (e.side === "enemy" ? "GM · Enemy" : "GM") : e.owner.active ? e.owner.name : `${e.owner.name} (away)`;
    const label = !ok ? `${esc(e.owner.name)}'s choice` : (gm || n > 3 ? "Take Turn" : `Take Turn for ${esc(e.owner.name)}`);
    const btn = `<span class="gmd-tbtn${ok ? "" : " off"}">${label}${ok && k ? `<kbd>${k}</kbd>` : ""}</span>`;
    const on = i === t.cur ? " on" : "";
    const off = ok ? "" : " off";
    const name = esc(e.token?.name ?? e.name ?? "?");
    const pres = presenceOn(e.token?.id ?? e.token?.document?.id);
    const presChip = pres.length ? `<span class="gmd-chip gmp">${esc(pres.join(", "))}</span>` : "";
    if (dens === "small") return `<div class="gmd-tile sm${on}${off}" data-ti="${i}">${presChip}<img src="${esc(face)}" alt=""><div class="tn"><b>${name}</b><small>${Math.round(hp.v)}/${Math.round(hp.m)} HP</small></div><span class="gmd-tbtn${ok ? "" : " off"}">▶${ok && k ? `<kbd>${k}</kbd>` : ""}</span></div>`;
    if (dens === "mid") return `<div class="gmd-tile md${on}${off}" data-ti="${i}">${presChip}<div class="l1"><img src="${esc(face)}" alt=""><div class="tn"><b>${name}</b><small class="${gm ? "gm" : ""}">${esc(sub)}</small></div></div>`
      + `<div class="mrow"><span><i class="hpf" style="width:${pctOf(hp.v, hp.m)}"></i></span><em>${Math.round(hp.v)}/${Math.round(hp.m)}</em>${btn}</div></div>`;
    return `<div class="gmd-tile${on}${off}" data-ti="${i}">${presChip}<div class="l1"><img src="${esc(face)}" alt=""><div class="tn"><b>${name}</b><small class="${gm ? "gm" : ""}">${esc(sub)}</small></div></div>`
      + `<div class="bars"><span><i class="hpf" style="width:${pctOf(hp.v, hp.m)}"></i></span><em>${Math.round(hp.v)}/${Math.round(hp.m)}</em>`
      + (mp ? `<span><i class="mpf" style="width:${pctOf(mp.v, mp.m)}"></i></span><em>${Math.round(mp.v)}/${Math.round(mp.m)}</em>` : "") + `</div>${btn}</div>`;
  }).join("");
  const cur = t.entries[t.cur];
  const players = t.entries.filter((e) => e.owner?.active);
  const foot = D.locked && players.length && players.length === n
    ? `<span class="gmd-sum"><span class="gmd-live"><i></i>Live</span> ${esc(players.map((e) => e.owner.name).join(", "))} take the turn from their own screens</span><span class="gmd-cta">Players choose</span>`
    : `<span class="gmd-sum"><b>${esc(cur?.token?.name ?? cur?.name ?? "")}</b> is highlighted on the field${cur?.owner?.active && !D.locked ? ` · starting it takes the turn from ${esc(cur.owner.name)}` : ""}</span>`;
  const h = `<div class="gmd-tiles ${dens}" style="grid-template-columns:repeat(${cols}, minmax(0, 1fr))">${tiles}</div><div class="gmd-foot">${foot}</div>`;
  if (el._h !== h) { el.innerHTML = h; el._h = h; }
  positionRing(true);
  // The highlighted tile moved: the other GMs see which one this GM is on.
  if (activeLayer() === "take") { sendPresence("take", false); paintHeader("take", { locked: false, forPlayer: null, mirror: null }); }
}

// Soft dashed ring on a token: the roster line under the pointer (or just
// clicked), else the highlighted Take Turn tile. A pointer, not a button.
function ringTarget() {
  const lineTok = (uid) => {
    const r = uid ? D.rows.get(uid) : null;
    const tok = r ? tokenOf(r.u)?.object : null;
    return tok && !tok.destroyed ? { tok, pc: r.u.side !== "enemy", lit: D.ringLit?.uid === uid } : null;
  };
  const hov = lineTok(D.hover) ?? (D.ringLit ? lineTok(D.ringLit.uid) : null);
  if (hov) return hov;
  const t = D.take;
  const e = t?.entries?.[t.cur];
  const tok = e?.token && !e.token.destroyed ? e.token : null;
  if (tok && activeLayer() === "take") return { tok, pc: !!e.owner, lit: false };
  return null;
}
function positionRing(force = false) {
  const tgt = ringTarget();
  const tok = tgt?.tok ?? null;
  if (!tok || !canvas?.stage) { hideRing(); return; }
  if (!D.ring) { D.ring = document.createElement("div"); D.ring.className = "gmd-ring"; document.body.appendChild(D.ring); }
  try {
    const wt = canvas.stage.worldTransform, rect = canvas.app.view.getBoundingClientRect();
    const c = tok.center, p = new PIXI.Point();
    wt.apply({ x: c.x, y: c.y }, p);
    // Under the 3D camera token.center is already the drawn body; match its size too.
    const drawn = globalThis.__ONI_BATTLE_STAGE_3D__?.drawnBox?.(tok);
    const d = Math.max(tok.w, tok.h) * (drawn?.is3d ? drawn.scale : 1) * 0.92 * wt.a;
    const key = `${Math.round(p.x)}|${Math.round(p.y)}|${Math.round(d)}|${tgt.pc ? 1 : 0}|${tgt.lit ? 1 : 0}`;
    if (!force && D.ring._k === key) return;
    D.ring._k = key;
    D.ring.classList.toggle("pc", !!tgt.pc);
    D.ring.classList.toggle("lit", !!tgt.lit);
    Object.assign(D.ring.style, { left: `${rect.left + p.x}px`, top: `${rect.top + p.y + 4}px`, width: `${d}px`, height: `${d}px`, display: "" });
  } catch { hideRing(); }
}
function hideRing() { if (D.ring) { D.ring.remove(); D.ring = null; } }

// ── reaction menus (reaction-menu.js) ─────────────────────────────────────────
/**
 * ReactionMenu.spawn on a GM client with the desk: the menu is listed on the
 * reactor's roster line and answered in the console instead of as blades by its
 * token. Same record contract: { cleanup, updateDisabledLabels, root }.
 * Returns null when there is no desk (the caller falls back to blades).
 */
export function deskSpawnReaction({ key, token, candidates, onPick, onPass, label, passLabel, disabledLabels }) {
  if (!deskActive() || !token) return null;
  const actor = token.actor ?? null;
  const prev = D.rx.get(key);
  const owner = liveOwnerOf(actor);
  const entry = {
    key, tokenId: token.id ?? token.document?.id, actor, name: token.name ?? actor?.name ?? "Reactor",
    img: actor?.img ?? token.document?.texture?.src ?? null,
    candidates: candidates ?? [], label: label ?? "Reaction", node: null, card: null, crumb: null, rec: null, closed: false,
  };
  clearTimeout(prev?._closeT);
  D.rx.set(key, entry);
  if (!D.rxOrder.includes(key)) D.rxOrder.push(key);
  // Start of conflict / round / turn reactions share ONE sectioned view with
  // the card's (user, 2026-10-23): a section per creature, Skip / Apply on each
  // reaction. A Use re-opens the creature's menu with what is left, so its
  // record (what was applied, what was skipped) carries over from `prev`.
  Object.assign(entry, {
    srx: true, node: srxView(), onPick, onPass: typeof onPass === "function" ? onPass : null,
    passLabel: passLabel ?? "Pass", disabled: new Map(Object.entries(disabledLabels ?? {})),
    // The Use in flight landed if its reaction is no longer offered; one still
    // offered was cancelled (its target pick) or aborted, and stays answerable.
    history: prev?.srx ? [...prev.history, ...(prev.pending && !(candidates ?? []).some((c) => srxKeyOf(c) === srxKeyOf(prev.pending))
      ? [{ c: prev.pending, status: "Applied" }] : [])] : [],
    skipped: prev?.srx ? prev.skipped : new Set(), busy: false, pending: null,
  });
  _srxDone.delete(key);
  entry.rec = {
    root: entry.node,
    cleanup: () => closeSrxEntry(entry),
    updateDisabledLabels(next) { entry.disabled = new Map(Object.entries(next ?? {})); paintSrxView(); },
  };
  paintSrxView();
  // Flow B: the first creature waiting on the GM opens by itself; a re-opened
  // menu (after a Use) keeps its selection. Player lines never open on their
  // own unless only players are deciding.
  if (prev && D.rxCur === key) selectRx(key);
  else autoSelectRx();
  paintRxCells();
  render();
  scrollRosterTo(entry.tokenId);
  return entry.rec;
}
// ── start of conflict / round / turn reactions: the sectioned view ──────────
// One view for every creature whose standalone reaction menu is open, laid out
// like the card's reactions: a section per creature, Skip and Apply on each.
// The menus underneath are unchanged (reaction-menu.js → standalone-reactions):
// Apply is the menu's Use of that reaction; Skip only marks it here, and once
// every reaction of a creature that it could use is skipped, the creature
// passes — the menu's own Pass, which covers all of them for this window.
let _srxView = null;
let _srxDone = new Map(); // key → a closed creature's section, kept while others still decide
let _srxHover = null;   // "entryKey|carrier::row" whose description the detail card shows
const srxKeyOf = (c) => `${c?.carrierUuid}::${c?.rowKey}`;
function srxView() {
  if (_srxView) return _srxView;
  const v = document.createElement("div");
  v.className = "dhv-view gmd-crx";
  v.dataset.gmd = "1";
  v.addEventListener("click", onSrxClick);
  v.addEventListener("pointerover", (ev) => {
    const row = ev.target.closest?.(".gmd-crx-row");
    if (!row) return;
    const k = `${row.dataset.r}|${row.dataset.k}`;
    if (k === _srxHover) return;
    _srxHover = k;
    playUiHoverSfx();
    paintSrxDetail();
  });
  _srxView = v;
  return v;
}
function srxEntries() { return D.rxOrder.map((k) => D.rx.get(k)).filter((e) => e?.srx && !e.closed); }
// What a creature can still answer: not automatic, not unusable, not skipped.
function srxOpenRows(e) {
  return (e.candidates ?? []).filter((c) => c?.mode !== "on" && !e.disabled.get(srxKeyOf(c)) && !e.skipped.has(srxKeyOf(c)));
}
function paintSrxView() {
  const v = srxView();
  let open = 0;
  const secs = srxEntries().map((e) => {
    const owner = liveOwnerOf(e.actor);
    const theirs = !!owner && D.locked;
    const face = e.img ? `<span class="dhv-ic"><img src="${esc(e.img)}" alt=""></span>` : "";
    const who = owner ? `<span class="gmd-chip ${theirs ? "pl" : "you"}">${theirs ? `${esc(owner.name)} decides` : `For ${esc(owner.name)}`}</span>` : "";
    const icon = (c) => c?.carrierImg ? `<span class="dhv-ic"><img src="${esc(c.carrierImg)}" alt=""></span>` : `<span class="dhv-ic"></span>`;
    const row = (c, tail, cls = "") => `<div class="gmd-crx-row${cls}" data-k="${esc(srxKeyOf(c))}" data-r="${esc(e.key)}">${icon(c)}<span class="nm">${esc(c?.carrierName ?? "Reaction")}</span>${tail}</div>`;
    const done = e.history.map((h) => row(h.c, `<span class="gmd-crx-st ${h.status === "Applied" ? "ok" : "no"}">${esc(h.status)}</span>`, h.status === "Applied" ? "" : " is-off"));
    const live = (e.candidates ?? []).map((c) => {
      const k = srxKeyOf(c), why = e.disabled.get(k);
      if (e.skipped.has(k)) return row(c, `<span class="gmd-crx-st no">Skipped</span>`, " is-off");
      if (why) return row(c, `<span class="dhv-chip t-danger">${esc(why)}</span>`, " is-off");
      if (c?.mode === "on") return row(c, `<span class="dhv-chip t-tag">Auto</span>`, " is-off");
      if (theirs) return row(c, `<span class="dhv-chip t-tag">Waiting</span>`);
      if (e.pending && srxKeyOf(e.pending) === k) return row(c, `<span class="gmd-crx-st wait">Applying…</span>`);
      if (e.busy) return row(c, `<span class="gmd-crx-st wait">…</span>`);
      open++;
      const skip = e.onPass ? `<span class="gmd-crx-b skip" role="button" data-a="skip">Skip</span>` : "";
      return row(c, `<span class="gmd-crx-btns">${skip}<span class="gmd-crx-b apply" role="button" data-a="apply">Apply</span></span>`);
    });
    return `<div class="gmd-crx-sec">${face}<b>${esc(e.name)}</b>${who}<span class="gmd-crx-lbl">${esc(e.label ?? "")}</span></div><div class="gmd-crx-grid">${[...done, ...live].join("")}</div>`;
  }).join("") + [..._srxDone.values()].map((d) => {
    const face = d.img ? `<span class="dhv-ic"><img src="${esc(d.img)}" alt=""></span>` : "";
    const rows = d.rows.map(({ c, status, ok }) => `<div class="gmd-crx-row${ok ? "" : " is-off"}" data-k="${esc(srxKeyOf(c))}" data-r="${esc(d.key)}">`
      + `${c?.carrierImg ? `<span class="dhv-ic"><img src="${esc(c.carrierImg)}" alt=""></span>` : `<span class="dhv-ic"></span>`}<span class="nm">${esc(c?.carrierName ?? "Reaction")}</span>`
      + `<span class="gmd-crx-st ${ok ? "ok" : "no"}">${esc(status)}</span></div>`).join("");
    return `<div class="gmd-crx-sec">${face}<b>${esc(d.name)}</b><span class="gmd-crx-lbl">${esc(d.label ?? "")}</span></div><div class="gmd-crx-grid">${rows}</div>`;
  }).join("");
  v.innerHTML = `<div class="dhv-main"><div class="gmd-crx-list">${secs}</div></div>`
    + `<div class="dhv-foot"><span class="dhv-ftxt"><span class="cnt">Reactions</span> · ${open} to answer · Skip or Apply each</span>`
    + (open ? `<span class="dhv-btn back" role="button" data-a="skipall">Skip all<span class="k">${open}</span></span>` : "") + `</div>`;
  const keys = [...srxEntries().flatMap((e) => (e.candidates ?? []).map((c) => `${e.key}|${srxKeyOf(c)}`)),
    ...[..._srxDone.values()].flatMap((d) => d.rows.map((r) => `${d.key}|${srxKeyOf(r.c)}`))];
  if (!keys.includes(_srxHover)) _srxHover = keys[0] ?? null;
  paintSrxDetail();
}
function paintSrxDetail() {
  const [ek, ck] = String(_srxHover ?? "").split("|");
  const live = D.rx.get(ek);
  const e = live?.srx ? live : null;
  const d = e ? null : _srxDone.get(ek);
  const c = e?.candidates?.find((x) => srxKeyOf(x) === ck) ?? d?.rows.find((r) => srxKeyOf(r.c) === ck)?.c ?? null;
  const why = c && e ? e.disabled.get(ck) : null;
  const card = c ? {
    key: `srx|${_srxHover}`, name: c.carrierName ?? "Reaction", kind: (e ?? d)?.label ?? "Reaction", img: c.carrierImg ?? null, from: (e ?? d)?.name,
    chips: [{ text: c.mode === "on" ? "Auto" : c.kind === "manual" ? "Manual" : "Asks", tone: "tag" }],
    body: htmlToText(c.carrierDescription ?? ""), reason: why || (c.mode === "on" ? "This one happens on its own; it is listed so you can see it." : null),
  } : null;
  for (const x of srxEntries()) x.card = card;
  _srxView?.querySelectorAll(".gmd-crx-row").forEach((el) => el.classList.toggle("is-cur", `${el.dataset.r}|${el.dataset.k}` === _srxHover));
  if (D.rx.get(D.rxCur)?.srx) paintRxDetail();
}
function srxPass(e) {
  if (!e.onPass || e.closed) return;
  e.lastAction = e.passLabel && /cancel/i.test(e.passLabel) ? "Cancelled" : "Passed";
  for (const c of srxOpenRows(e)) e.skipped.add(srxKeyOf(c));
  try { e.onPass(); } catch (err) { warn("[GmDesk] reaction pass threw", err); }
}
function onSrxClick(ev) {
  const b = ev.target.closest?.("[data-a]");
  if (!b) return;
  ev.stopPropagation();
  playUiClickSfx();
  if (b.dataset.a === "skipall") {
    for (const e of srxEntries()) if (!(liveOwnerOf(e.actor) && D.locked) && !e.busy) srxPass(e);
    return;
  }
  const row = b.closest(".gmd-crx-row");
  const e = row ? D.rx.get(row.dataset.r) : null;
  const c = e?.candidates?.find((x) => srxKeyOf(x) === row.dataset.k);
  if (!e?.srx || e.closed || e.busy || !c) return;
  if (b.dataset.a === "skip") {
    e.skipped.add(srxKeyOf(c));
    // Nothing left this creature could use: that is its Pass.
    if (!srxOpenRows(e).length) srxPass(e);
    else paintSrxView();
    return;
  }
  // Apply = the menu's Use. It re-opens with what is left (or closes).
  e.busy = true;
  e.pending = c;
  e.lastAction = "Applied";
  noteContext(e.actor, e.tokenId);
  paintSrxView();
  try { e.onPick?.(c); } catch (err) { warn("[GmDesk] reaction pick threw", err); }
}
// What a creature's section says once its menu has closed: every reaction with
// the decision taken on it (the user, 2026-10-22: decided reactions stay listed).
function srxDoneRecord(e) {
  const passed = e.lastAction === "Passed" || e.lastAction === "Cancelled";
  // A Use the menu closed on (its last reaction, or one that opens an action).
  const history = e.pending ? [...e.history, { c: e.pending, status: "Applied" }] : e.history;
  const rows = history.map((h) => ({ c: h.c, status: h.status, ok: h.status === "Applied" }));
  for (const c of e.candidates ?? []) {
    if (history.some((h) => srxKeyOf(h.c) === srxKeyOf(c))) continue;
    const why = e.disabled.get(srxKeyOf(c));
    const status = c?.mode === "on" ? "Auto" : why ? why : e.skipped.has(srxKeyOf(c)) ? "Skipped" : passed ? e.lastAction : "Closed";
    rows.push({ c, status, ok: c?.mode === "on" });
  }
  return { key: e.key, name: e.name, img: e.img, label: e.label, rows };
}
function closeSrxEntry(entry) {
  if (D.rx.get(entry.key) !== entry) return;
  entry.closed = true;
  _srxDone.set(entry.key, srxDoneRecord(entry));
  paintSrxView();
  // A Use re-opens the same menu straight away: wait a moment before letting go.
  entry._closeT = setTimeout(() => {
    if (D.rx.get(entry.key) !== entry) return;
    D.rx.delete(entry.key);
    D.rxOrder = D.rxOrder.filter((k) => k !== entry.key);
    D.done.set(entry.tokenId, { text: entry.lastAction ?? "Answered", until: Date.now() + DONE_MS });
    // The window is over once nobody is left deciding: the record goes with it.
    if (!srxEntries().length) { try { _srxView?.remove(); } catch { /* */ } _srxView = null; _srxHover = null; _srxDone = new Map(); }
    else paintSrxView();
    if (D.rxCur === entry.key) { D.rxCur = null; autoSelectRx(); }
    paintRxCells();
    render();
  }, CLOSE_GRACE_MS);
}
function closeRxEntry(entry) {
  if (D.rx.get(entry.key) !== entry) return;
  entry.closed = true;
  if (entry.node) { try { entry.node.remove(); } catch { /* */ } }
  entry.node = null;
  // A Use re-opens the same menu straight away: wait a moment before letting go.
  entry._closeT = setTimeout(() => {
    if (D.rx.get(entry.key) !== entry) return;
    D.rx.delete(entry.key);
    D.rxOrder = D.rxOrder.filter((k) => k !== entry.key);
    D.done.set(entry.tokenId, { text: entry.lastAction ?? "Answered", until: Date.now() + DONE_MS });
    if (D.rxCur === entry.key) { D.rxCur = null; autoSelectRx(); }
    paintRxCells();
    render();
  }, CLOSE_GRACE_MS);
}
function gmEntries() { return D.rxOrder.map((k) => D.rx.get(k)).filter((e) => e && !e.closed && !liveOwnerOf(e.actor)); }
function nextGmEntry(exceptKey) { return gmEntries().find((e) => e.key !== exceptKey) ?? null; }
function autoSelectRx() {
  if (D.rxCur && D.rx.has(D.rxCur) && !D.rx.get(D.rxCur).closed) return;
  const gm = gmEntries()[0];
  const any = D.rxOrder.map((k) => D.rx.get(k)).find((e) => e && !e.closed);
  const pick = gm ?? any ?? null;
  if (pick) selectRx(pick.key);
}
function selectRx(key, { user = false } = {}) {
  if (!D.rx.has(key)) return;
  const was = D.rxCur;
  D.rxCur = key;
  bump("react");
  showRxNode();
  if (user || was !== key) { paintRxCells(); render(); }
}
function showRxNode() {
  const work = D.layers.react?.querySelector(".gmd-work");
  if (!work) return;
  const e = D.rx.get(D.rxCur);
  const node = e?.node ?? null;
  if (node && node.parentElement !== work) work.replaceChildren(node);
  else if (!node) work.replaceChildren();
  // Re-label the CTA for the lock (the view paints it once per change).
  paintRxDetail();
  render();
}
function paintRxDetail() {
  const det = D.layers.react?.querySelector(".gmd-detail");
  if (!det) return;
  const e = D.rx.get(D.rxCur);
  const h = e?.card ? cardHTML(e.card) : "";
  if (det._h !== h) { det.innerHTML = h; det._h = h; }
  // The Use button names the player when the GM answers for them.
  const go = e?.node?.querySelector('.dhv-btn.go .gl');
  if (go) { const want = rxGoLabel(e); if (go.textContent !== want) go.textContent = want; }
}
function rxGoLabel(e) {
  const owner = liveOwnerOf(e?.actor);
  return owner && !D.locked ? `Use for ${owner.name}` : owner ? `${owner.name} decides` : "Use";
}

// ── action-card reactions in the console ─────────────────────────────────────
// The reactions still undecided on the open action card are answered here, in
// the same reaction menu as start-of-conflict / round / turn reactions: one
// line per reacting creature on the roster, its reactions in the console. The
// card's pills stay the single source of truth — this is a VIEW over them, as
// the players' reaction hand is: Use clicks the pill's Apply, Pass clicks Skip
// on every pill of that creature still open. The card itself only hides the
// undecided pills (body.gmd-card-rx); used, skipped, automatic and unusable
// ones stay on it as the record of what happened.
const CARD_RX = "card|";
const _cardRx = new Map();   // group key → its D.rx entry
function cardPillGroups() {
  const root = document.getElementById("fud-battlefield-card-root");
  const card = root?.classList.contains("is-visible") ? root.querySelector(".fud-bf-card:not(.fud-gm-edit-card)") : null;
  const groups = new Map();
  if (!card) return groups;
  for (const p of card.querySelectorAll(".fud-bf-reaction-pill")) {
    // The action-taker's own pills have no reactor uuid: the card names them.
    const reactor = p.dataset.fudReactorUuid || card.dataset.fudActorUuid || "self";
    const pending = p.classList.contains("is-ask") && p.dataset.fudReactionPending === "1" && p.dataset.fudReactionMoot !== "1";
    // Decided (or on its way) keeps its line with the card's verdict (user,
    // 2026-10-22): Applied / Skipped, or Forced / Suppressed for a GM's call.
    const sending = p.classList.contains("is-submitting");
    const done = !pending && (sending || p.classList.contains("is-resolved"));
    const auto = !done && p.classList.contains("is-auto");
    const off = !done && (p.classList.contains("is-unavailable") || p.dataset.fudReactionMoot === "1");
    if (!pending && !auto && !off && !done) continue;
    const g = groups.get(reactor) ?? { reactor, rows: [], pending: 0 };
    if (pending) g.pending++;
    const reason = off ? (p.querySelector(".fud-bf-reaction-reason, [data-fud-reaction-moot-chip='1']")?.textContent?.trim() || "No longer applies") : "";
    const status = !done ? ""
      : sending ? "Sending…"
      : p.querySelector(".fud-bf-reaction-status")?.textContent?.trim() || (p.classList.contains("is-applied") ? "Applied" : "Skipped");
    g.rows.push({
      rowKey: p.dataset.fudReactionKey ?? "", carrierUuid: p.dataset.fudReactionCarrier ?? "",
      carrierName: p.querySelector(".fud-bf-reaction-name")?.textContent?.trim() || "Reaction",
      carrierImg: p.querySelector("img")?.getAttribute("src") ?? null,
      carrierDescription: p.dataset.fudEquipDesc ?? "",
      mode: done ? "done" : auto ? "on" : "ask", reason,
      status, applied: done && !sending && p.classList.contains("is-applied"),
    });
    groups.set(reactor, g);
  }
  return groups;
}
function cardPill(rowKey, carrierUuid) {
  return document.getElementById("fud-battlefield-card-root")?.querySelector(
    `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(rowKey)}"][data-fud-reaction-carrier="${CSS.escape(carrierUuid)}"]`) ?? null;
}
function clickPill(rowKey, carrierUuid, action) {
  cardPill(rowKey, carrierUuid)?.querySelector(`[data-fud-reaction-action="${action}"]`)?.click();
}
function cardRxToken(reactor) {
  const toks = canvas?.tokens?.placeables ?? [];
  if (reactor === "self") {
    const id = D.turnStatus?.phase === "acting" ? D.turnStatus.actorId : null;
    return id ? toks.find((t) => t.actor?.id === id || t.document?.actorId === id) ?? null : null;
  }
  return toks.find((t) => t.actor?.uuid === reactor)
    // A linked actor's uuid ("Actor.x") vs the token's synthetic one: match by id too.
    ?? toks.find((t) => t.document?.actorLink && `Actor.${t.document.actorId}` === reactor) ?? null;
}
// The GM answers every card reaction in ONE view (user, 2026-10-22): a section
// per reacting creature, each reaction with its own Skip and Apply, laid out in
// two columns when the console is wide. Every reactor still has its own entry in
// D.rx — that is what lights its roster line, counts it in the banner and leaves
// the "Applied / Passed" chip — but they all show the same shared view.
let _crxView = null;
let _crxSecs = [];      // every reactor on the card, answered ones included
let _crxSig = "";
let _crxHover = null;   // "rowKey:carrier" whose description the detail card shows
function syncCardRx() {
  const groups = D.root ? cardPillGroups() : new Map();
  document.body.classList.toggle("gmd-card-rx", !!D.root);
  const secs = [];
  for (const [reactor, g] of groups) {
    const token = cardRxToken(reactor);
    if (!token) continue;
    const actor = token.actor ?? null;
    secs.push({ ...g, token, key: CARD_RX + reactor, actor,
      name: token.name ?? actor?.name ?? "Reactor", img: actor?.img ?? token.document?.texture?.src ?? null });
  }
  _crxSecs = secs;
  // Only a creature with something still to answer is an open reaction (its
  // roster line, the banner count); answered ones stay in the view as a record.
  const live = secs.filter((g) => g.pending);
  for (const g of live) {
    const e = _cardRx.get(g.key) ?? openCardRxEntry(g);
    e.candidates = g.rows;
  }
  for (const [key, e] of [..._cardRx]) if (!live.some((g) => g.key === key)) closeCardRxEntry(e);
  const sig = secs.map((g) => `${g.key}=${g.rows.map((r) => `${r.rowKey}:${r.carrierUuid}:${r.mode}:${r.reason}:${r.status}`).join(",")}`).join("|")
    + `|L${D.locked ? 1 : 0}|${live.length}`;
  if (sig !== _crxSig) {
    _crxSig = sig;
    if (live.length) paintCardRxView(secs);
    paintRxCells();
    if (!live.length && D.cardOpen) render();   // the answered list, in the card layer
  }
  // Hide on the card exactly the pills the console now offers — re-stamped every
  // pass, since the card re-renders its pills. A pill whose creature could not be
  // found on the canvas keeps its Apply/Skip on the card.
  for (const [reactor, g] of groups) {
    const shown = _cardRx.has(CARD_RX + reactor);
    for (const r of g.rows) {
      const p = cardPill(r.rowKey, r.carrierUuid);
      if (!p) continue;
      if (shown && r.mode === "ask" && !r.reason) p.dataset.gmdRx = "1";
      else delete p.dataset.gmdRx;
    }
  }
}
function crxView() {
  if (_crxView) return _crxView;
  const v = document.createElement("div");
  v.className = "dhv-view gmd-crx";
  v.dataset.gmd = "1";
  v.addEventListener("click", onCrxClick);
  v.addEventListener("pointerover", (ev) => {
    const row = ev.target.closest?.(".gmd-crx-row");
    if (!row) return;
    const k = `${row.dataset.k}:${row.dataset.c}`;
    if (k === _crxHover) return;
    _crxHover = k;
    playUiHoverSfx();
    paintCrxDetail();
  });
  _crxView = v;
  return v;
}
function openCardRxEntry(g) {
  const actor = g.token.actor ?? null;
  const entry = {
    key: g.key, tokenId: g.token.id, actor, name: g.token.name ?? actor?.name ?? "Reactor",
    img: actor?.img ?? g.token.document?.texture?.src ?? null,
    candidates: g.rows, label: "Reaction", node: crxView(), card: null, crumb: null, rec: null, closed: false, cardRx: true,
  };
  D.rx.set(g.key, entry);
  if (!D.rxOrder.includes(g.key)) D.rxOrder.push(g.key);
  _cardRx.set(g.key, entry);
  // The card's reactions arrive together: open the view once, on the first.
  if (!D.rxCur || !D.rx.has(D.rxCur) || D.rx.get(D.rxCur)?.closed) autoSelectRx();
  scrollRosterTo(entry.tokenId);
  return entry;
}
function closeCardRxEntry(e) {
  _cardRx.delete(e.key);
  if (D.rx.get(e.key) !== e) return;
  e.closed = true;
  D.rx.delete(e.key);
  D.rxOrder = D.rxOrder.filter((k) => k !== e.key);
  D.done.set(e.tokenId, { text: e.lastAction ?? "Answered", until: Date.now() + DONE_MS });
  if (!_cardRx.size) { try { _crxView?.remove(); } catch { /* */ } _crxView = null; _crxSig = ""; _crxHover = null; }
  if (D.rxCur === e.key) { D.rxCur = null; autoSelectRx(); }
  paintRxCells();
  render();
}
function crxRows() {
  const out = [];
  for (const g of _crxSecs) for (const r of g.rows ?? []) out.push({ e: _cardRx.get(g.key) ?? g, r });
  return out;
}
function crxListHTML(secs) {
  let open = 0;
  const html = secs.map((g) => {
    const owner = liveOwnerOf(g.actor);
    const theirs = !!owner && D.locked;
    const face = g.img ? `<span class="dhv-ic"><img src="${esc(g.img)}" alt=""></span>` : "";
    const who = owner && g.pending ? `<span class="gmd-chip ${theirs ? "pl" : "you"}">${theirs ? `${esc(owner.name)} decides` : `For ${esc(owner.name)}`}</span>` : "";
    const rows = g.rows.map((r) => {
      const ask = r.mode === "ask" && !r.reason;
      if (ask && !theirs) open++;
      const icon = r.carrierImg ? `<span class="dhv-ic"><img src="${esc(r.carrierImg)}" alt=""></span>` : `<span class="dhv-ic"></span>`;
      const sending = r.status === "Sending…";
      const tail = r.mode === "done"
        ? `<span class="gmd-crx-st ${r.applied ? "ok" : sending ? "wait" : "no"}">${esc(r.status)}</span>`
        : !ask ? `<span class="dhv-chip ${r.reason ? "t-danger" : "t-tag"}">${esc(r.reason || "Auto")}</span>`
        : theirs ? `<span class="dhv-chip t-tag">Waiting</span>`
        : `<span class="gmd-crx-btns"><span class="gmd-crx-b skip" role="button" data-a="skip">Skip</span><span class="gmd-crx-b apply" role="button" data-a="apply">Apply</span></span>`;
      // Applied stays at full strength, as on the card; Skipped fades with the rest.
      const dim = !ask && !(r.mode === "done" && (r.applied || sending));
      return `<div class="gmd-crx-row${dim ? " is-off" : ""}" data-k="${esc(r.rowKey)}" data-c="${esc(r.carrierUuid)}" data-r="${esc(g.key)}">${icon}<span class="nm">${esc(r.carrierName)}</span>${tail}</div>`;
    }).join("");
    return `<div class="gmd-crx-sec">${face}<b>${esc(g.name ?? "Reactor")}</b>${who}</div><div class="gmd-crx-grid">${rows}</div>`;
  }).join("");
  return { html, open };
}
function paintCardRxView(secs) {
  const v = crxView();
  const { html, open } = crxListHTML(secs);
  v.innerHTML = `<div class="dhv-main"><div class="gmd-crx-list">${html}</div></div>`
    + `<div class="dhv-foot"><span class="dhv-ftxt"><span class="cnt">Reactions</span> · ${open} to answer · Skip or Apply each</span>`
    + (open ? `<span class="dhv-btn back" role="button" data-a="skipall">Skip all<span class="k">${open}</span></span>` : "") + `</div>`;
  if (!_crxHover || !crxRows().some(({ r }) => `${r.rowKey}:${r.carrierUuid}` === _crxHover)) {
    const first = crxRows().find(({ r }) => r.mode === "ask" && !r.reason) ?? crxRows()[0];
    _crxHover = first ? `${first.r.rowKey}:${first.r.carrierUuid}` : null;
  }
  paintCrxDetail();
}
function paintCrxDetail() {
  const hit = crxRows().find(({ r }) => `${r.rowKey}:${r.carrierUuid}` === _crxHover);
  const card = hit ? {
    key: `crx|${_crxHover}`, name: hit.r.carrierName, kind: "Reaction", img: hit.r.carrierImg, from: hit.e.name,
    chips: [{ text: hit.r.mode === "done" ? hit.r.status : hit.r.mode === "on" ? "Auto" : "Asks", tone: "tag" }],
    body: htmlToText(hit.r.carrierDescription), reason: hit.r.reason || null,
  } : null;
  for (const e of _cardRx.values()) e.card = card;
  _crxView?.querySelectorAll(".gmd-crx-row").forEach((el) => el.classList.toggle("is-cur", `${el.dataset.k}:${el.dataset.c}` === _crxHover));
  if (D.rx.get(D.rxCur)?.cardRx) paintRxDetail();
}
function htmlToText(html) {
  const d = document.createElement("div");
  d.innerHTML = String(html ?? "").replace(/<\/(p|li|div)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  d.querySelectorAll(".fud-bf-reaction-tip-foot").forEach((n) => n.remove());
  return (d.textContent ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}
function onCrxClick(ev) {
  const b = ev.target.closest?.("[data-a]");
  if (!b) return;
  ev.stopPropagation();
  playUiClickSfx();
  if (b.dataset.a === "skipall") {
    for (const { e, r } of crxRows()) {
      if (r.mode !== "ask" || r.reason || (liveOwnerOf(e.actor) && D.locked)) continue;
      e.lastAction = "Passed";
      clickPill(r.rowKey, r.carrierUuid, "skip");
    }
    return;
  }
  const row = b.closest(".gmd-crx-row");
  const e = row ? _cardRx.get(row.dataset.r) : null;
  if (!row || !e) return;
  e.lastAction = b.dataset.a === "apply" ? "Applied" : "Passed";
  if (b.dataset.a === "apply") noteContext(e.actor, e.tokenId);
  clickPill(row.dataset.k, row.dataset.c, b.dataset.a);
}
function clearCardRx() {
  for (const e of [..._cardRx.values()]) closeCardRxEntry(e);
  _cardRx.clear();
  try { _crxView?.remove(); } catch { /* */ }
  _crxView = null; _crxSig = ""; _crxHover = null; _crxSecs = [];
  document.body.classList.remove("gmd-card-rx");
  placeCardAside();
}
// The action card sits mid-screen, which on a short window is over the
// console's top rows — exactly where its own reactions are answered (user,
// 2026-10-22). While the console shows them the card steps aside: up into the
// clear canvas above the panels when it fits there, else left over the roster,
// clear of the console. It goes back to the centre once they are answered.
function placeCardAside() {
  const root = document.getElementById("fud-battlefield-card-root");
  if (!root) return;
  const reset = () => {
    if (!root.hasAttribute("data-gmd-aside")) return;
    root.removeAttribute("data-gmd-aside");
    root.style.top = ""; root.style.left = "";
  };
  if (!D.root || !_cardRx.size || !D.cardOpen || D.foldShown || !D.con) return reset();
  const m = 12;
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = root.offsetWidth, h = root.offsetHeight;
  const con = D.con.getBoundingClientRect(), ros = D.roster?.getBoundingClientRect();
  const line = Math.min(con.top, ros?.top ?? con.top);
  let x = vw / 2, y = vh / 2;
  if (y + h / 2 + m <= con.top) return reset();             // already clear of the console
  if (h + 2 * m <= line) y = Math.min(y, line - m - h / 2);
  else if (w + 2 * m <= con.left) { x = Math.min(x, con.left - m - w / 2); y = Math.max(h / 2 + m, Math.min(y, vh - h / 2 - m)); }
  else y = h / 2 + m;                                        // no clear spot: as high as it goes
  root.setAttribute("data-gmd-aside", "1");
  root.style.top = `${Math.round(y)}px`; root.style.left = `${Math.round(x)}px`;
}

// ── the step host: command window + every picker (drawer views) ──────────────
function cardHTML(e) {
  const ic = e.img ? `<span class="dhv-ic"><img src="${esc(e.img)}" alt=""></span>` : (e.iconHTML ? `<span class="dhv-ic">${e.iconHTML}</span>` : "");
  const seen = new Set();
  const chips = (e.chips ?? []).filter((c) => c?.text && !seen.has(c.text) && seen.add(c.text))
    .map((c) => `<span class="dhv-chip t-${esc(c.tone || "tag")}">${esc(c.text)}</span>`).join("");
  const paras = String(e.body || "").split("\n").filter(Boolean).map((l) => `<p${/^Skill Enhancement/i.test(l) ? ' class="enh"' : ""}>${esc(l)}</p>`).join("");
  const from = e.from ? `<span class="gmd-from">From ${esc(e.from)}</span>` : "";
  return `${from}<div class="dn">${ic}<span>${esc(e.name)}</span></div>${chips ? `<div class="dc">${chips}</div>` : ""}${e.reason ? `<div class="why">${esc(e.reason)}</div>` : ""}<div class="dd">${paras || `<p class="enh">No description.</p>`}</div>`;
}
function paintStepDetail() {
  const det = D.step?.detailEl;
  if (!det) return;
  const h = D.step.card ? cardHTML(D.step.card) : "";
  if (det._h !== h) { det.innerHTML = h; det._h = h; }
}
function clearStepIfIdle() {
  const s = D.step;
  if (!s || s.holds > 0) return;
  const live = [...s.cmdsEl.children, ...s.workEl.children].some((n) => !n.inert);
  if (live) return;
  s.cmdsEl.replaceChildren(); s.workEl.replaceChildren();
  s.overlay = null; s.under = null; s.card = null; s.crumb = null; s.holdActorId = null;
  paintStepDetail();
  render();
}
function stepActorSide() {
  const a = stepActor();
  if (!a) return null;
  const u = unitForActorId(a.id);
  if (u) return u.side === "enemy" ? "enemy" : "party";
  const tok = canvas?.tokens?.placeables?.find((p) => p.document?.actorId === a.id);
  return (tok?.document?.disposition ?? 1) === -1 ? "enemy" : "party";
}
function deskStepHost() {
  const s = D.step;
  const host = {
    get actorId() { return s.holdActorId; },
    get actorSide() { return stepActorSide(); },
    relativeSides: true, unit: D.con, pcard: null,
    mount(node) {
      clearTimeout(s.graceT);
      node.dataset.gmd = "1";
      if (s.overlay) s.overlay = node;
      s.workEl.replaceChildren(node);
      bump("step");
      render();
    },
    mountOverlay(node) {
      clearTimeout(s.graceT);
      node.dataset.gmd = "1";
      if (!s.overlay) s.under = { nodes: [...s.workEl.children], card: s.card, crumb: s.crumb };
      s.overlay = node;
      s.workEl.replaceChildren(node);
      bump("step");
      render();
      return () => {
        if (s.overlay !== node) return;
        const under = s.under;
        s.overlay = null; s.under = null;
        node.inert = true;
        const keep = (under?.nodes ?? []).filter((n) => !n.inert);
        if (keep.length) { s.workEl.replaceChildren(...keep); s.card = under.card; s.crumb = under.crumb; paintStepDetail(); }
        render();
        if (!keep.length) clearStepIfIdle();
      };
    },
    setCrumb(t) { s.crumb = t ? String(t) : null; render(); },
    pushCrumb(step) {
      const prev = s.crumb && !/›/.test(s.crumb) ? s.crumb : String(s.crumb ?? "").split("›")[0].trim();
      s.crumb = prev ? `${prev} › ${step}` : String(step);
      render();
    },
    setCard(entry) { s.card = entry ?? null; paintStepDetail(); },
    setHint() {},
    release: () => {},
  };
  return host;
}
/** Hold the console's step layer open for this actor until release() runs (composeAction). */
export function deskHold(actorId) {
  if (!deskActive()) return null;
  const s = D.step;
  s.holds += 1;
  if (actorId) s.holdActorId = String(actorId);
  clearTimeout(s.graceT);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    s.holds = Math.max(0, s.holds - 1);
    if (s.holds > 0) return;
    // A skill's menus often come one after another: don't flash shut between them.
    clearTimeout(s.graceT);
    s.graceT = setTimeout(() => { clearStepIfIdle(); render(); }, 600);
  };
}
/** A picker's host on a GM client with the desk (plateDrawerHost). */
export function deskDrawerHost() {
  if (!deskActive()) return null;
  const host = deskStepHost();
  const release = deskHold(null);
  host.release = release ?? (() => {});
  return host;
}
/**
 * The command window (turn-ui.js) docks into the console's command column.
 * Same contract as openPlateDrawer: { setHint, setCrumb, close } or null.
 */
export function deskOpenDrawer(actorId, { el, budgetText = "Turn Action" } = {}) {
  if (!deskActive() || !el) return null;
  const s = D.step;
  clearTimeout(s.graceT);
  if (actorId) s.holdActorId = String(actorId);
  el.dataset.gmd = "1";
  // A fresh command window: whatever the last command opened is finished.
  for (const n of [...s.workEl.children]) if (n.inert) n.remove();
  s.cmdsEl.replaceChildren(el);
  s.crumb = budgetText ?? "Turn Action";
  s.card = null;
  paintStepDetail();
  bump("step");
  render();
  return {
    setHint() {},
    setCrumb(label) { s.crumb = label ? `${budgetText ?? "Turn Action"} › ${label}` : budgetText; render(); },
    close() {
      el.inert = true;
      if (s.holds > 0) { render(); return; }
      if (el.parentElement === s.cmdsEl) el.remove();
      clearStepIfIdle();
      render();
    },
  };
}

/**
 * An overlay with its own markup and keys (attribute pair, passive manager)
 * moves into the console as it is; it leaves when its own code removes it.
 * Returns true when adopted (GM with the desk).
 */
export function deskAdopt(root, { crumb = null, actorId = null } = {}) {
  if (!deskActive() || !root) return false;
  const host = deskStepHost();
  const release = deskHold(actorId);
  root.classList.add("gmd-adopt");
  const unmount = host.mountOverlay(root);
  if (crumb) host.setCrumb(crumb);
  const mo = new MutationObserver(() => {
    if (root.isConnected && !root.classList.contains("is-resolving")) return;
    mo.disconnect();
    root.inert = true;
    try { unmount(); } catch { /* */ }
    release?.();
  });
  mo.observe(D.step.workEl, { childList: true });
  mo.observe(root, { attributes: true, attributeFilter: ["class"] });
  return true;
}

/**
 * skill-effects.js confirm rows (gate: OK / Cancel; branch: one button per
 * effect) as tiles in the console. Resolves the chosen key, null on Cancel,
 * or undefined when there is no desk (the caller shows its own dialog).
 */
export function deskConfirm({ title, message, buttons, cancelLabel }) {
  if (!deskActive()) return undefined;
  const host = deskDrawerHost();
  const tip = { name: String(title ?? "Confirm"), body: String(message ?? "") };
  const items = [...(buttons ?? []).map((b) => ({ primary: esc(b.label), value: b.key, tooltip: tip })),
    { primary: esc(cancelLabel ?? "Cancel"), value: "__cancel__", tooltip: tip }];
  const { promise } = pickDocked(host, { title: tip.name, crumb: tip.name, groups: [{ items }], cancelLabel: cancelLabel ?? "Cancel", onDone: () => host.release() });
  return promise.then((v) => (v == null || v === "__cancel__" ? null : v));
}

// ── turn status (director-player-hud.js applyTurnStatus) ──────────────────────
export function deskTurnStatus(status) {
  D.turnStatus = status ?? null;
  if (!D.root) return;
  paintBar();
  render();
}

// ── live mirror of a player's drawer ──────────────────────────────────────────
// The player's client sends its plate drawer (HTML it drew itself) whenever it
// changes; the GM shows it, inert, in Watch. Sanitised: no scripts, no inline
// handlers, no javascript: URLs.
function sanitize(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html ?? "");
  for (const bad of tpl.content.querySelectorAll("script, iframe, object, embed, link, meta, style, form, input, textarea, button")) bad.remove();
  for (const el of tpl.content.querySelectorAll("*")) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
  return tpl.content;
}
function paintMirror(m) {
  const el = D.layers.mirror;
  const key = `${m.at}`;
  if (el._k === key) return;
  el._k = key;
  const frag = sanitize(m.html);
  const cmds = document.createElement("div"); cmds.className = "gmd-cmds";
  if (m.cmds) {
    const old = sanitize(m.cmds).querySelector(".fud-octopath");
    if (old) {
      // The list replaced the commands before the cursor's last move was sent:
      // put the cursor on the command the list belongs to ("Spell" → SPELL).
      const want = String(m.crumb ?? "").split("›")[0].trim().toLowerCase();
      const hit = [...old.querySelectorAll(".blade")].find((b) => b.querySelector(".label")?.textContent.trim().toLowerCase() === want);
      if (hit) { for (const b of old.querySelectorAll(".blade.is-cursor")) b.classList.remove("is-cursor"); hit.classList.add("is-cursor"); }
      cmds.appendChild(old);
    }
  }
  const work = document.createElement("div"); work.className = "gmd-work";
  for (const n of [...frag.childNodes]) {
    if (n.nodeType !== 1) continue;
    (n.classList.contains("fud-octopath") ? cmds : work).appendChild(n);
  }
  const det = document.createElement("div"); det.className = "gmd-detail";
  if (m.card) det.appendChild(sanitize(`<div class="gmd-mcard">${m.card}</div>`));
  const who = game.users?.get(m.userId)?.name ?? "The player";
  const foot = document.createElement("div"); foot.className = "gmd-foot";
  foot.innerHTML = `<span class="gmd-sum"><span class="gmd-live"><i></i>Live</span> ${esc(who)} is choosing${m.crumb ? `: <b>${esc(m.crumb)}</b>` : ""}</span><span class="gmd-cta">${esc(who)} decides</span>`;
  el.replaceChildren(...(cmds.childElementCount ? [cmds] : []), work, det, foot);
  // The drawer's skill card markup → the detail column's look.
  const face = det.querySelector(".gmd-mcard");
  if (face) {
    const name = face.querySelector(".dhv-sname")?.textContent ?? "";
    const body = face.querySelector(".dhv-sbody")?.innerHTML ?? "";
    const chips = face.querySelector(".dhv-schips")?.innerHTML ?? "";
    const ic = face.querySelector(".dhv-ic")?.outerHTML ?? "";
    const why = face.querySelector(".dhv-swhy")?.textContent ?? "";
    const from = face.querySelector(".dhv-sfrom")?.textContent ?? "";
    det.innerHTML = `${from ? `<span class="gmd-from">${esc(from)}</span>` : ""}<div class="dn">${ic}<span>${esc(name)}</span></div>${chips ? `<div class="dc">${chips}</div>` : ""}${why ? `<div class="why">${esc(why)}</div>` : ""}<div class="dd">${body}</div>`;
  }
}
/** Player client → GMs (director-player-hud.js). */
export function sendDeskMirror(payload) {
  const sock = ensureSocket();
  if (!sock) return;
  const gms = (game.users?.contents ?? []).filter((u) => u.isGM && u.active).map((u) => u.id);
  if (!gms.length) return;
  try { sock.executeForUsers(ACTION_MIRROR, gms, payload); } catch (e) { warn("[GmDesk] mirror send failed", e); }
}
function receiveMirror(p) {
  if (!game.user?.isGM || !p?.actorId) return;
  const prev = D.mirror.get(String(p.actorId));
  const html = p.open ? String(p.html ?? "").slice(0, 200000) : "";
  // The command window leaves the player's drawer when a list replaces it; keep
  // the last one (cursor on the picked command) beside the list, as the GM's
  // own compose does. A closed drawer forgets it.
  const hasCmds = /fud-octopath/.test(html);
  const cmds = !p.open ? null : hasCmds ? null : (prev?.open ? (prev.cmds ?? (/fud-octopath/.test(prev.html) ? prev.html : null)) : null);
  D.mirror.set(String(p.actorId), { html, cmds, crumb: p.crumb ?? "", card: p.card ?? null, open: !!p.open, userId: p.userId ?? null, at: Date.now() });
  if (D.root) render();
}

// ── socket ────────────────────────────────────────────────────────────────────
function ensureSocket() {
  if (_socket) return _socket;
  if (!game.modules?.get("socketlib")?.active || !window.socketlib) return null;
  try {
    _socket = window.socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_MIRROR, (p) => { try { receiveMirror(p); } catch (e) { warn("[GmDesk] mirror receive failed", e); } });
    _socket.register(ACTION_CMD, async ({ cmd } = {}) => {
      if (!game.user?.isGM) return null;
      try { return await runCmd(cmd); } catch (e) { warn("[GmDesk] remote command failed", e); return { ok: false, error: String(e?.message ?? e) }; }
    });
    _socket.register(ACTION_PRESENCE, (p) => { try { receivePresence(p); } catch (e) { warn("[GmDesk] presence receive failed", e); } });
    _socket.register(ACTION_LOG, (p) => {
      try { if (game.user?.isGM) { addLog(p); if (D.root) { D.layers.idle._h = null; render(); } } }
      catch (e) { warn("[GmDesk] log receive failed", e); }
    });
  } catch (e) { warn("[GmDesk] socket registration failed", e); _socket = null; }
  return _socket;
}

// ── API ───────────────────────────────────────────────────────────────────────
function deskState() {
  return {
    active: deskActive(), layer: D.root ? activeLayer() : null, locked: D.locked, cardOpen: D.cardOpen,
    units: unitList().length, reactions: [...D.rx.values()].map((e) => ({ key: e.key, name: e.name, n: e.candidates.length, current: e.key === D.rxCur, owner: liveOwnerOf(e.actor)?.name ?? null })),
    take: D.take ? D.take.entries.map((e) => ({ name: e.token?.name ?? e.name, owner: e.owner?.name ?? null, enabled: takeEnabled(e) })) : null,
    mirrors: [...D.mirror.keys()],
    rects: D.root ? Object.fromEntries(["gmd-bar", "gmd-roster", "gmd-con"].map((c) => { const r = D.root.querySelector(`.${c}`)?.getBoundingClientRect(); return [c, r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null]; })) : null,
    size: D.size, scale: D.root ? Number(deskScale().toFixed(3)) : null, folded: D.folded, foldShown: D.foldShown, peek: D.peek,
    focus: focusState(), skipBlocked: skipBlocked(),
    presence: [...D.presence].map(([uid, p]) => ({ user: game.users?.get(uid)?.name ?? uid, tokenId: p.tokenId, what: p.what })),
    recent: _log.map((e) => ({ ...e })), aiPreview: D.aiPrev.data, hover: D.hover,
  };
}
// Peek: hold the key and the desk turns see-through and lets clicks reach the
// tokens under it. A normal Foundry binding (Configure Controls), GM only.
Hooks.once("init", () => {
  try {
    game.keybindings.register(MODULE_ID, "gmDeskPeek", {
      name: "GM Battle Desk: hold to see under it",
      hint: "While held, the GM Battle Desk turns see-through and clicks reach the tokens under it.",
      editable: [{ key: "KeyH" }],
      restricted: true,
      onDown: () => { if (!deskActive()) return false; setPeek(true); return true; },
      onUp: () => { if (!deskActive()) return false; setPeek(false); return true; },
    });
  } catch (e) { warn("[GmDesk] peek key binding failed", e); }
});
// Recent: the host runs the battle, so it hears each resolved action and
// passes it on to the other GMs.
Hooks.on("fuBattleActionResolved", (p) => {
  if (!game.user?.isGM) return;
  addLog(p);
  if (D.root) { D.layers.idle._h = null; render(); }
  const ids = otherGmIds();
  if (ids.length && ensureSocket()) { try { _socket.executeForUsers(ACTION_LOG, ids, p); } catch (e) { warn("[GmDesk] log send failed", e); } }
});
Hooks.once("ready", () => {
  ensureSocket();
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.gmDesk = Object.freeze({
    state: deskState,
    setLocked(b) { if (!!b !== D.locked) toggleLock(); return D.locked; },
    setSize(k) { if (SIZES[k]) { D.size = k; try { localStorage.setItem(SIZE_KEY, k); } catch { /* */ } paintHeaderControls(); D.placeKey = ""; place(); } return D.size; },
    setFolded(b) { setFolded(!!b); return D.folded; },
    setPeek(b) { setPeek(!!b); return D.peek; },
    // Kill switch (this browser only): back to the compact cards + token pills.
    setEnabled(on) { try { localStorage.setItem(OFF_KEY, on ? "0" : "1"); } catch { /* */ } return deskEnabled(); },
  });
});
