// ============================================================================
// Gacha System — Watch party
// ----------------------------------------------------------------------------
// Browsing is private, the pull is public. Anyone can open the machine on
// their own; the moment someone presses Wish, the reveal goes out to the whole
// table. This module decides what a client that does NOT have the machine open
// does when that happens:
//
//   auto (default)  a call-out slides in, then after a short countdown the
//                   reveal takes over. Any key skips to the summary; dismissing
//                   it returns the player to the map, music restored.
//   ask             the call-out waits for Watch / Not now.
//   card            no takeover; a results card appears when the reveal ends.
//
// BUSY clients (battle, an event running, a card duel open) are never taken
// over: they get the results card, with Watch replay.
//
// The Spectator account (stream) follows every reveal with no call-out.
//
// Clients that DO have the machine open play the reveal in place; that path
// lives in gacha-bootstrap.js. The cheer / groan badges here serve both.
// ============================================================================

import { GACHA, log } from "./gacha-const.js";
const MODULE_ID_SAFE = GACHA.MODULE_ID;
import { beginReveal, playReveal, activeRoot, isPlaying, stop as stopFx } from "./gacha-fx.js";
import { sendCheer } from "./gacha-net.js";
import * as Audio from "./gacha-audio.js";

const CALLOUT_ID = "gacha-callout";
const CARD_ID = "gacha-result-card";
const STYLE_ID = "gacha-watch-style";
const LOCK_ID = "gacha-watch";

// ── busy tracking ───────────────────────────────────────────────────────────
const events = new Set();
let inBattle = false;
let duelOpen = false;
Hooks.on("oniEventExecuteStart", ({ sourceId } = {}) => events.add(sourceId || "?"));
Hooks.on("oniEventExecuteDone", ({ sourceId } = {}) => { events.delete(sourceId || "?"); });
Hooks.on("fuBattleFocusChanged", (b) => { inBattle = !!b; });
Hooks.on("fabulaArcanaWindow", ({ open } = {}) => { duelOpen = !!open; });
Hooks.on("canvasReady", () => events.clear());

export function busyReason() {
  if (inBattle) return "battle";
  if (events.size) return "event";
  if (duelOpen) return "duel";
  return null;
}

const isSpectator = () => globalThis.FUCompanion?.api?.Spectator?.isSpectator?.() === true;

export function watchMode() {
  if (isSpectator()) return "follow";
  try { return game.settings.get(MODULE_ID_SAFE, GACHA.WATCH_SETTING) || "auto"; } catch { return "auto"; }
}

export function registerSettings() {
  try {
    if (game.settings.settings.has(`${MODULE_ID_SAFE}.${GACHA.WATCH_SETTING}`)) return;
    game.settings.register(MODULE_ID_SAFE, GACHA.WATCH_SETTING, {
      name: "Gachapon: when someone else wishes",
      hint: "What your screen does when a party member wishes at Hako's Gachapon and you don't have the machine open.",
      scope: "client", config: true, type: String, default: "auto",
      choices: { auto: "Join the reveal after a short countdown", ask: "Ask me first", card: "Only show a results card" },
    });
  } catch (e) { console.warn("[FU][Gacha] watch setting", e); }
}

// ── state ───────────────────────────────────────────────────────────────────
// phase: idle | callout | watching | card
const W = { phase: "idle", byUserId: null, count: 0, bannerName: "", payload: null, timer: null };

const runtime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
const lockMove = (on) => { try { on ? runtime()?.lockMovement?.(LOCK_ID) : runtime()?.unlockMovement?.(LOCK_ID); } catch {} };

function reset() {
  clearTimeout(W.timer);
  removeCallout();
  W.phase = "idle"; W.byUserId = null; W.payload = null; W.count = 0; W.bannerName = "";
}

// ── entry points (called by bootstrap for clients WITHOUT the machine open) ─

/** Someone pressed Wish. */
export function onRemoteStart(payload) {
  if (!payload?.byUserId || payload.byUserId === game.user.id) return;
  // A new reveal supersedes whatever is still on screen — the last card, or the
  // last reveal's summary nobody dismissed yet. Close that reveal FIRST: its
  // teardown fires fuGachaRevealEnd, which resets the watch state, and it must
  // reset the OLD watch, not the one being set up below. (Sandbox 2026-11-23:
  // the Spectator, still on the previous summary, missed the next wish.)
  if (isPlaying()) stopFx();
  removeCard();
  reset();
  W.byUserId = payload.byUserId;
  W.count = payload.count ?? 1;
  W.bannerName = payload.bannerName ?? "";

  const mode = watchMode();
  const busy = busyReason();
  if (mode === "follow") { join(); return; }
  if (busy || mode === "card") { W.phase = "card"; log(`Watch: results card only (${busy ?? "setting"})`); return; }

  W.phase = "callout";
  showCallout({ auto: mode === "auto" });
  if (mode === "auto") W.timer = setTimeout(() => { if (W.phase === "callout") join(); }, GACHA.WATCH_COUNTDOWN_MS);
}

/** The decided outcome arrived. Returns true if this module consumed it. */
export function onRemoteReveal(payload) {
  if (!payload?.results?.length) return false;
  if (payload.byUserId === game.user.id) return false;
  if (W.byUserId && payload.byUserId !== W.byUserId) return false;

  if (W.phase === "watching") { playReveal(payload); decorate(payload.byUserId); return true; }
  if (W.phase === "callout" || W.phase === "card") { W.payload = payload; return true; }

  // Reveal with no WISH_START seen (this client joined mid-wish): card only,
  // unless this is the stream account.
  W.byUserId = payload.byUserId; W.payload = payload; W.count = payload.results.length; W.bannerName = payload.bannerName ?? "";
  if (watchMode() === "follow") { join(); return true; }
  W.phase = "card";
  return true;
}

/** The roller's reveal ended: the machine is free. */
export function onRemoteEnd(msg) {
  if (!W.byUserId || msg?.byUserId !== W.byUserId) return;
  if (W.phase === "callout") { removeCallout(); W.phase = "card"; }
  if (W.phase === "card") {
    if (W.payload) showCard(W.payload);
    reset();
  }
  // "watching": this client leaves on its own fuGachaRevealEnd (its own dismiss).
}

// ── join / leave ────────────────────────────────────────────────────────────

function join() {
  clearTimeout(W.timer);
  removeCallout();
  W.phase = "watching";
  Audio.hold("watch");
  lockMove(true);
  beginReveal(W.count || 1);
  decorate(W.byUserId);
  if (W.payload) playReveal(W.payload);
}

Hooks.on("fuGachaRevealEnd", () => {
  if (W.phase !== "watching") return;
  Audio.release("watch");
  lockMove(false);
  reset();
});

/** Watch a finished reveal again from its results card. */
export function replay(payload) {
  if (!payload?.results?.length || isPlaying()) return;
  removeCard();
  reset();
  W.byUserId = payload.byUserId; W.payload = payload; W.count = payload.results.length;
  join();
}

// ── cheer / groan ───────────────────────────────────────────────────────────

/**
 * Add the react buttons to the live reveal, for anyone but the roller and the
 * stream account. Called right after a reveal starts on this client.
 */
export function decorate(byUserId) {
  const root = activeRoot();
  if (!root || root.querySelector(".gfx-react")) return;
  if (!root.querySelector(".gfx-cheers")) {
    const box = document.createElement("div"); box.className = "gfx-cheers"; root.appendChild(box);
  }
  if (!byUserId || byUserId === game.user.id || isSpectator()) return;
  const bar = document.createElement("div");
  bar.className = "gfx-react";
  bar.innerHTML = `<button type="button" data-k="cheer" title="Cheer">✦</button>
                   <button type="button" class="is-groan" data-k="groan" title="Groan">💧</button>`;
  bar.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-k]"); if (!b) return;
    ev.stopPropagation();                 // never let it dismiss the summary
    const now = performance.now();
    if (now - (W.lastCheer ?? 0) < 700) return;   // no spam
    W.lastCheer = now;
    sendCheer(b.dataset.k);
  });
  // The summary dismisses on any click inside the reveal root; keep ours out of that.
  bar.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  root.appendChild(bar);
}

export function onCheer(msg) {
  const root = activeRoot();
  if (!root || !msg?.userId) return;
  let box = root.querySelector(".gfx-cheers");
  if (!box) { box = document.createElement("div"); box.className = "gfx-cheers"; root.appendChild(box); }
  const user = game.users?.get(msg.userId);
  const img = user?.character?.img ?? user?.avatar ?? "";
  const groan = msg.kind === "groan";
  const el = document.createElement("div");
  el.className = "gfx-cheer";
  el.style.setProperty("--sc", groan ? "#8fc4ff" : "#f2c35a");
  el.title = user?.character?.name ?? user?.name ?? "";
  el.innerHTML = `${img ? `<img src="${img}" alt="">` : ""}<span>${groan ? "💧" : "✦"}</span>`;
  box.appendChild(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  setTimeout(() => el.remove(), 2700);
}

// ── UI: call-out + results card ─────────────────────────────────────────────

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${CALLOUT_ID}, #${CARD_ID} {
  position: fixed; z-index: 150; font-family: "Signika", "Segoe UI", sans-serif; color: #3a1e06;
  border: 2px solid #c9a44a; background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 16px 40px rgba(0,0,0,.55);
  display: flex; align-items: center; gap: 14px; user-select: none;
}
#${CALLOUT_ID} { left: 50%; top: 70px; transform: translate(-50%, -180%); border-radius: 14px;
  padding: 10px 14px 10px 10px; min-width: 460px; transition: transform .35s cubic-bezier(.2,.9,.3,1.15); }
#${CALLOUT_ID}.is-on { transform: translate(-50%, 0); }
#${CALLOUT_ID} img.p, #${CARD_ID} img.p { width: 52px; height: 52px; border-radius: 50%; object-fit: cover;
  object-position: 50% 12%; border: 3px solid #c9a44a; background: #fff; flex: 0 0 auto; }
#${CALLOUT_ID} .t1 { font-size: 19px; } #${CALLOUT_ID} .t1 b { color: #5c1f2e; }
#${CALLOUT_ID} .t2 { font-size: 13px; color: #6b4c2a; }
#${CALLOUT_ID} .acts, #${CARD_ID} .acts { margin-left: auto; display: flex; gap: 8px; }
#${CALLOUT_ID} button, #${CARD_ID} button { width: auto !important; position: relative; overflow: hidden;
  padding: 7px 14px; border: 1px solid #9b7040; border-radius: 8px; cursor: pointer;
  background: linear-gradient(180deg, #7a5230, #5c3818); color: #f4e8c0; font: 15px "Signika", sans-serif; }
#${CALLOUT_ID} button:hover, #${CARD_ID} button:hover { border-color: #f4d488; }
#${CALLOUT_ID} button.is-main { border-color: #f4d488; box-shadow: 0 0 0 2px #f4d488; }
#${CALLOUT_ID} .cd { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; background: #f4d488; }
#${CALLOUT_ID} .cd.run { transition: width ${GACHA.WATCH_COUNTDOWN_MS}ms linear; width: 0; }
#${CARD_ID} { right: 24px; bottom: 90px; border-radius: 12px; padding: 9px 12px 9px 9px; max-width: 520px;
  transform: translateX(130%); transition: transform .4s cubic-bezier(.2,.9,.3,1.1); font-size: 15px; }
#${CARD_ID}.is-on { transform: none; }
#${CARD_ID} .best { font-weight: 600; } #${CARD_ID} .r5 { color: #b77a00; } #${CARD_ID} .r4 { color: #7d22c9; }
#${CARD_ID} img.i { width: 40px; height: 40px; object-fit: contain; image-rendering: pixelated; }
#${CARD_ID} .x { cursor: pointer; opacity: .6; padding: 0 4px; font-size: 18px; }
`;
  document.head.appendChild(s);
}

function who(userId) {
  const u = game.users?.get(userId);
  return { name: u?.character?.name ?? u?.name ?? "Someone", img: u?.character?.img ?? u?.avatar ?? "" };
}
const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

function showCallout({ auto }) {
  ensureStyle();
  removeCallout();
  const w = who(W.byUserId);
  const el = document.createElement("div");
  el.id = CALLOUT_ID;
  el.innerHTML = `
    ${w.img ? `<img class="p" src="${w.img}" alt="">` : ""}
    <div><div class="t1"><b>${esc(w.name)}</b> is wishing ×${W.count}!</div>
         <div class="t2">${esc(W.bannerName || "Hako's Gachapon")}</div></div>
    <div class="acts">
      <button type="button" class="is-main" data-watch>Watch${auto ? `<span class="cd"></span>` : ""}</button>
      <button type="button" data-skip>Not now</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector("[data-watch]").addEventListener("click", () => { if (W.phase === "callout") join(); });
  el.querySelector("[data-skip]").addEventListener("click", () => {
    if (W.phase !== "callout") return;
    clearTimeout(W.timer); removeCallout(); W.phase = "card";
  });
  const onKey = (ev) => {
    if (W.phase !== "callout") return;
    if (ev.key === "Enter") { ev.preventDefault(); join(); }
    else if (ev.key === "Escape") { ev.preventDefault(); clearTimeout(W.timer); removeCallout(); W.phase = "card"; }
  };
  window.addEventListener("keydown", onKey, true);
  el._off = () => window.removeEventListener("keydown", onKey, true);
  requestAnimationFrame(() => {
    el.classList.add("is-on");
    if (auto) requestAnimationFrame(() => el.querySelector(".cd")?.classList.add("run"));
  });
}

function removeCallout() {
  const el = document.getElementById(CALLOUT_ID);
  if (!el) return;
  el._off?.();
  el.classList.remove("is-on");
  setTimeout(() => el.remove(), 350);
}

function showCard(payload) {
  ensureStyle();
  removeCard();
  const w = who(payload.byUserId);
  const order = { five: 3, four: 2, three: 1 };
  const best = [...payload.results].sort((a, b) => order[b.rarity] - order[a.rarity])[0];
  const fives = payload.results.filter((r) => r.rarity === "five");
  const fours = payload.results.filter((r) => r.rarity === "four");
  const line = fives.length
    ? `<span class="best r5">5★ ${esc(fives.map((r) => r.name).join(", "))}</span>${fours.length ? ` + ${fours.length}× 4★` : ""}`
    : fours.length ? `<span class="best r4">4★ ${esc(fours.map((r) => r.name).join(", "))}</span>` : "no 4★ or better";
  const el = document.createElement("div");
  el.id = CARD_ID;
  el.innerHTML = `
    ${w.img ? `<img class="p" src="${w.img}" alt="">` : ""}
    <div><b>${esc(w.name)}</b> · Wish ×${payload.results.length}<br>${line}</div>
    ${best?.img ? `<img class="i" src="${best.img}" alt="">` : ""}
    <div class="acts"><button type="button" data-replay>▶ Watch replay</button><span class="x" data-x title="Close">×</span></div>`;
  document.body.appendChild(el);
  el.querySelector("[data-replay]").addEventListener("click", () => {
    if (busyReason()) { ui.notifications?.info("Finish what you're doing first, then watch the replay."); return; }
    replay(payload);
  });
  el.querySelector("[data-x]").addEventListener("click", removeCard);
  requestAnimationFrame(() => el.classList.add("is-on"));
  armCardTimer();
}

/**
 * The card is mostly for players who were BUSY when the wish happened, so it
 * must outlive whatever kept them busy: no countdown while a scene, battle or
 * duel is running; 20s once they are free. (Sandbox 2026-11-23: a fixed 20s
 * timer removed the card before a busy player could press Watch replay.)
 */
const CARD_LINGER_MS = 20_000;
function armCardTimer() {
  clearTimeout(W.cardTimer);
  W.cardTimer = null;
  if (!document.getElementById(CARD_ID)) return;
  if (busyReason()) return;               // re-armed by onBusyChanged below
  W.cardTimer = setTimeout(removeCard, CARD_LINGER_MS);
}
const onBusyChanged = () => setTimeout(armCardTimer, 0);   // after the busy flags update
Hooks.on("oniEventExecuteStart", onBusyChanged);
Hooks.on("oniEventExecuteDone", onBusyChanged);
Hooks.on("fuBattleFocusChanged", onBusyChanged);
Hooks.on("fabulaArcanaWindow", onBusyChanged);

function removeCard() {
  clearTimeout(W.cardTimer);
  W.cardTimer = null;
  const el = document.getElementById(CARD_ID);
  if (!el) return;
  el.classList.remove("is-on");
  setTimeout(() => el.remove(), 400);
}

export const watchDebug = () => ({ phase: W.phase, byUserId: W.byUserId, hasPayload: !!W.payload, busy: busyReason(), mode: watchMode() });
