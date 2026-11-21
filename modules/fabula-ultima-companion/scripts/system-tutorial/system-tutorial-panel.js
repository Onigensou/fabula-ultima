// ============================================================================
// System Tutorial — the shared "how it works" card.
//
// A dimmed screen with one centred parchment card: a header (sigil, small
// kicker, title), a screenshot, one sentence, and a footer (Back, page dots,
// Next / Done). One page per idea. First used by the Conflict Event panel
// (conflict-event-panel.js) and pulled out here so any system or event can
// show its own pages (system-tutorial.js keeps the list, event row "Show
// Tutorial" opens one for everyone).
//
//   openTutorialPanel({ kicker, title, accent, pages, aspect, closeKeys, onClose })
//     pages    [{ image, text }]   text: plain, **bold** = highlighted words
//     aspect   CSS aspect-ratio of the screenshot box (default "16 / 9")
//     closeKeys extra key codes that close it (Conflict Event uses KeyI)
//     onClose(reason)   "done" (Next on the last page) | "closed" (X, Esc,
//                        a click on the dim, right-click) | "replaced" | "forced"
//   closeTutorialPanel({ silent, reason })   isTutorialPanelOpen()
//
// Keys: Z / Enter / → / D next, ← / A back, X / Esc close. Each key is consumed
// here so whatever sits underneath (turn menu, walking) never sees it.
// One card at a time: opening another closes the first ("replaced").
// ============================================================================

import { playSfx, preloadSfx } from "../battle-director/director-sfx.js";
import { hudScale } from "../battle-director/director-player-hud.js";

const VEIL_ID = "fu-tut-veil";
const STYLE_ID = "fu-tut-style";
const SOUND_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
export const TUTORIAL_SFX = { open: SOUND_BASE + "BattleCursor_3.wav", nav: SOUND_BASE + "BattleCursor_4.wav", volume: 0.5 };
export const TUTORIAL_SIGIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="M12 4.2 13.7 10.3 19.8 12 13.7 13.7 12 19.8 10.3 13.7 4.2 12 10.3 10.3z"/></svg>';

const S = { open: false, page: 0, cfg: null, decoded: new Map(), sfxLoaded: false };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
/** Page text: plain text, with **bold** marking the words to highlight. */
export const tutorialMarkup = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<em>$1</em>");
const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

export const isTutorialPanelOpen = () => S.open;

/** Decode the pages' screenshots ahead of time, so the first page turn never waits. */
export function preloadTutorialImages(pages) {
  for (const p of pages ?? []) {
    if (!p.image || S.decoded.has(p.image)) continue;
    const im = new Image();
    im.src = p.image;
    S.decoded.set(p.image, im.decode().catch(() => {}));
  }
}

/** Open the card. Returns false if there is nothing to show. */
export function openTutorialPanel({ kicker = "Tutorial", title = "", accent = "#b3261e", pages = [], aspect = "16 / 9", closeKeys = [], onClose = null } = {}) {
  pages = (pages ?? []).filter((p) => p && (p.text || p.image));
  if (!pages.length) return false;
  if (S.open) closeTutorialPanel({ silent: true, reason: "replaced" });
  ensureStyle();
  if (!S.sfxLoaded) { S.sfxLoaded = true; preloadSfx([TUTORIAL_SFX.open, TUTORIAL_SFX.nav]).catch(() => {}); }
  preloadTutorialImages(pages);
  S.cfg = { kicker, title, accent, pages, aspect, closeKeys, onClose };
  S.open = true;
  S.page = 0;
  const veil = document.createElement("div");
  veil.id = VEIL_ID;
  veil.style.setProperty("--accent", accent);
  veil.style.setProperty("--shot-aspect", aspect);
  veil.innerHTML = `<div class="tut" role="dialog" aria-label="${esc(title)}" style="transform:scale(${hudScale().toFixed(3)})">
    <div class="t-head"><span class="t-sigil">${TUTORIAL_SIGIL}</span><div><small>${esc(kicker)}</small><b>${esc(title)}</b></div></div>
    <div class="t-shot">${pages[0].image ? `<img src="${esc(pages[0].image)}" alt="">` : ""}</div>
    <p class="t-text">${tutorialMarkup(pages[0].text)}</p>
    <div class="t-foot">
      <button type="button" data-prev disabled><kbd>◀</kbd>Back</button>
      <span class="dots">${pages.map((_, i) => `<i class="${i === 0 ? "on" : ""}">◆</i>`).join("")}</span>
      <button type="button" data-next><kbd>Z</kbd><span class="t-next">${pages.length > 1 ? "Next" : "Done"}</span></button>
      <button type="button" data-close><kbd>X</kbd>Close</button>
    </div></div>`;
  veil.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-close]")) return closeTutorialPanel({ reason: "closed" });
    if (ev.target.closest("[data-next]")) return flip(1);
    if (ev.target.closest("[data-prev]")) return flip(-1);
    if (ev.target === veil) closeTutorialPanel({ reason: "closed" });
  });
  veil.addEventListener("contextmenu", (ev) => { ev.preventDefault(); closeTutorialPanel({ reason: "closed" }); });
  document.body.appendChild(veil);
  window.addEventListener("keydown", onKey, true);
  playSfx(TUTORIAL_SFX.open, TUTORIAL_SFX.volume);
  return true;
}

export function closeTutorialPanel({ silent = false, reason = "forced" } = {}) {
  if (!S.open && !document.getElementById(VEIL_ID)) return;
  const cb = S.cfg?.onClose;
  S.open = false;
  S.cfg = null;
  window.removeEventListener("keydown", onKey, true);
  const veil = document.getElementById(VEIL_ID);
  if (veil) {
    veil.id = "";   // a new card may open while this one fades
    if (silent || reducedMotion()) veil.remove();
    else { veil.classList.add("fu-tut-veil", "leaving"); setTimeout(() => veil.remove(), 180); }
  }
  try { cb?.(reason); } catch (e) { console.error("[FU][SystemTutorial] onClose", e); }
}

/** A page turn updates the open card in place, so nothing replays or flickers. */
async function flip(d) {
  const pages = S.cfg?.pages ?? [];
  const next = S.page + d;
  if (next >= pages.length) return closeTutorialPanel({ reason: "done" });
  if (next < 0) return;
  S.page = next;
  playSfx(TUTORIAL_SFX.nav, TUTORIAL_SFX.volume);
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
  setTimeout(() => { if (S.page === next) { text.innerHTML = tutorialMarkup(p.text); text.classList.remove("swap"); } }, 160);
  veil.querySelectorAll(".dots i").forEach((dot, i) => dot.classList.toggle("on", i === next));
  veil.querySelector("[data-prev]").disabled = next === 0;
  veil.querySelector(".t-next").textContent = next < pages.length - 1 ? "Next" : "Done";
}

// One key, one meaning, consumed here so the turn menu underneath never sees it.
function onKey(ev) {
  if (!S.open) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
  const close = () => closeTutorialPanel({ reason: "closed" });
  const act = {
    Escape: close, KeyX: close,
    KeyZ: () => flip(1), Enter: () => flip(1), ArrowRight: () => flip(1), KeyD: () => flip(1),
    ArrowLeft: () => flip(-1), KeyA: () => flip(-1),
  }[ev.code] ?? ((S.cfg?.closeKeys ?? []).includes(ev.code) ? close : null);
  if (!act) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (!ev.repeat) act();
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  const V = `#${VEIL_ID}, .fu-tut-veil`;
  const sel = (rest) => V.split(", ").map((v) => `${v} ${rest}`).join(", ");
  st.textContent = `
${V} { position: fixed; inset: 0; z-index: 9000; background: rgba(8,6,4,.74); display: grid; place-items: center; animation: fu-tut-veil 200ms ease-out; --accent: #b3261e; }
.fu-tut-veil.leaving { opacity: 0; transition: opacity 160ms ease-in; }
@keyframes fu-tut-veil { from { opacity: 0; } to { opacity: 1; } }
${sel(".tut")} { width: 720px; color: #3a3228; background: linear-gradient(180deg, #f6f1e6, #ebe3d0); border: 2px solid #7a6a55; border-radius: 10px;
  box-shadow: 0 0 0 1px rgba(213,182,122,.6) inset, 0 18px 44px rgba(0,0,0,.6); overflow: hidden; font-family: "Signika", sans-serif; }
${sel(".tut > *")} { animation: fu-tut-rise 260ms cubic-bezier(.2,.8,.3,1) both; }
@keyframes fu-tut-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
${sel(".t-head")} { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: linear-gradient(180deg, #2b241b, #1f1a14); color: #f6ecd6; }
${sel(".t-sigil")} { width: 26px; height: 26px; color: var(--accent); flex: none; filter: drop-shadow(0 0 3px rgba(255,255,255,.25)); }
${sel(".t-sigil svg")} { width: 100%; height: 100%; display: block; }
${sel(".t-head small")} { display: block; font: 600 11px/1.2 "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #d5b67a; }
${sel(".t-head b")} { font: 600 24px/1.15 "Cinzel", Georgia, serif; letter-spacing: .02em; }
${sel(".t-shot")} { margin: 16px 40px 0; position: relative; border: 2px solid #7a6a55; border-radius: 6px; overflow: hidden; background: #000;
  box-shadow: 0 0 0 1px rgba(213,182,122,.8), 0 4px 10px rgba(0,0,0,.3); aspect-ratio: var(--shot-aspect, 16 / 9); }
${sel(".t-shot img")} { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
${sel(".t-shot img.in")} { animation: fu-tut-shot-in 360ms cubic-bezier(.22,.8,.3,1) both; }
${sel(".t-shot img.out")} { animation: fu-tut-shot-out 360ms ease both; }
@keyframes fu-tut-shot-in { from { opacity: 0; transform: translateX(var(--dx, 36px)); } to { opacity: 1; transform: none; } }
@keyframes fu-tut-shot-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(calc(var(--dx, 36px) * -0.6)); } }
${sel(".t-text")} { margin: 14px 40px 0; min-height: 3.1em; font: 400 21px/1.42 "Signika", sans-serif; text-wrap: pretty; transition: opacity 160ms ease, transform 160ms ease; }
${sel(".t-text.swap")} { opacity: 0; transform: translateY(4px); }
${sel(".t-text em")} { font-style: normal; font-weight: 600; color: #7d4f12; }
${sel(".t-foot")} { display: flex; align-items: center; gap: 14px; margin-top: 14px; padding: 10px 16px; border-top: 1px solid rgba(122,106,85,.45);
  background: rgba(213,182,122,.18); font: 500 14px/1 "Signika", sans-serif; color: #6d6152; }
${sel(".t-foot .dots")} { flex: 1; display: flex; gap: 7px; justify-content: center; font-size: 12px; color: #9c7a3a; }
${sel(".t-foot .dots i")} { font-style: normal; opacity: .35; transition: opacity 200ms ease; }
${sel(".t-foot .dots i.on")} { opacity: 1; }
${sel(".t-foot kbd")} { font: 600 12px/1 "Signika", sans-serif; color: #f6ecd6; background: #1f1a14; border-radius: 3px; padding: 4px 7px; }
${sel(".t-foot button")} { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; color: #6d6152; }
${sel(".t-foot button:hover")} { color: #3a3228; }
${sel(".t-foot button[disabled]")} { opacity: .3; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  ${V}, ${sel(".tut > *")}, ${sel(".t-shot img.in")}, ${sel(".t-shot img.out")} { animation: none; }
  ${sel(".t-text")} { transition: none; }
}`;
  document.head.appendChild(st);
}
