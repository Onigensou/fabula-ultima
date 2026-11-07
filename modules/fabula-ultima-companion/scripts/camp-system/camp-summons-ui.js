// scripts/camp-system/camp-summons-ui.js
//
// The camp Summon button and its picker (see camp-summons-core.js).
//
// Button: the bottom-left camp row, after whichever of Upgrade, Inner
// Wellspring and Stubborn Scion this client shows (98 + 74 × n). Shown to a
// player whose character has something to call, in free time, on the active
// camp. Not to the GM (GMs drag summons) or a spectator.
//   · nothing out → 🔮 Summon, opens the picker;
//   · a summon out → its face, Dismiss; the Q keycap says Q swaps who you walk.
//
// Picker: floating bubbles rising from the button, one per summon (a group is
// one bubble), sprite + name only. Click a bubble to call it at once. Arrows /
// WASD move the cursor, Z or Enter calls, X or Escape closes. The cursor opens
// on the last summon this browser called. Walking is held while it is open.

import {
  MOD, campSummonsOf, flagOf, isCampScene, ownerFor, request, summonTokensOf, summonsOpen,
} from "./camp-summons-core.js";

const TAG = "[CampSummons][UI]";
const BTN_ID = "fu-summon-campbtn";
const PICK_CLASS = "fu-summon-pick";
const STYLE_ID = "fu-summon-style";
const ROW_BEFORE = ["fu-upgrade-campbtn", "fu-iw-campbtn", "fu-scion-campbtn"];
const LOCK_ID = "campSummonPicker";
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SFX = {
  open: [`${ASSET}Sound/BattleCursor_4.wav`, 0.45],
  move: [`${ASSET}Sound/BattleCursor_1.wav`, 0.35],
  back: [`${ASSET}Sound/cursor_back2.wav`, 0.5],
};
const REASON = {
  closed: "Summons can only come out during free time at camp.",
  already_out: "You already have a summon out.",
  not_owner: "Only your own character's summons can be called.",
  unknown_summon: "That summon isn't available to your character any more.",
  no_room: "There's no room next to your character.",
  busy: "Still handling your last request.",
  timeout: "The GM didn't answer. Try again in a moment.",
  error: "Something went wrong calling your summon.",
};

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isVideo = (src) => /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(String(src ?? ""));
const runtime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
const isSpectator = () => !!globalThis.FUCompanion?.api?.Spectator?.isSpectator?.();
function sfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}
const lastKeyFor = (actorId) => `fu.campSummon.last.${actorId}`;
function readLast(actorId) { try { return localStorage.getItem(lastKeyFor(actorId)); } catch { return null; } }
function writeLast(actorId, key) { try { localStorage.setItem(lastKeyFor(actorId), key); } catch {} }

// Sprite art for a bubble or the button face. Tall art shows its head and
// shoulders; squat art (a Gorger, a crystal) shows whole.
function spriteHtml(src) {
  const s = esc(src);
  const fit = "this.classList.add(this.naturalHeight / Math.max(1, this.naturalWidth) > 1.15 ? 'is-tall' : 'is-squat')";
  if (isVideo(src)) return `<video class="is-tall" src="${s}" muted autoplay loop playsinline></video>`;
  return `<img src="${s}" alt="" onload="${fit}">`;
}

// ── state ───────────────────────────────────────────────────────────────────
let _owner = null;
let _groups = [];
let _sending = false;
let _pick = null;   // { el, focus }

// ── button ──────────────────────────────────────────────────────────────────
function placeButton(btn) {
  const before = ROW_BEFORE.filter((id) => document.getElementById(id)?.classList.contains("is-shown")).length;
  btn.style.left = `${98 + 74 * before}px`;
  if (_pick?.el) _pick.el.style.left = btn.style.left;
}

let _placeTimer = null;
function keepPlaced(btn) {
  clearInterval(_placeTimer);
  // The other row buttons come and go on their own hooks; follow them.
  _placeTimer = setInterval(() => {
    if (!btn.isConnected || !btn.classList.contains("is-shown")) { clearInterval(_placeTimer); return; }
    placeButton(btn);
  }, 600);
}

function hideButton() {
  document.getElementById(BTN_ID)?.classList.remove("is-shown");
  closePicker(false);
}

async function refreshButton() {
  const scene = canvas?.scene;
  const show = !game.user?.isGM && !isSpectator() && scene && isCampScene(scene) && summonsOpen(scene);
  _owner = show ? await ownerFor(game.user.id) : null;
  _groups = _owner ? await campSummonsOf(_owner) : [];
  const mine = scene ? summonTokensOf(scene, game.user.id) : [];
  if (!_owner || (!_groups.length && !mine.length)) { hideButton(); return; }

  injectStyles();
  let btn = document.getElementById(BTN_ID);
  if (!btn) {
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.addEventListener("pointerdown", (ev) => { ev.preventDefault(); onButton(); });
    btn.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onButton(); } });
    document.body.appendChild(btn);
  }
  const out = mine.sort((a, b) => (flagOf(a)?.order ?? 0) - (flagOf(b)?.order ?? 0));
  btn.classList.toggle("is-on", out.length > 0);
  btn.classList.toggle("is-sending", _sending);
  if (out.length) {
    const names = out.map((t) => t.actor?.name ?? t.name).join(" & ");
    const face = out[0].texture?.src ?? "";
    btn.innerHTML = `<span class="fu-summon-face">${spriteHtml(face)}</span><span class="fu-summon-lbl">Dismiss</span>`
      + `<span class="fu-summon-key" aria-hidden="true">Q</span>`;
    btn.dataset.tooltip = `Dismiss ${names}. Q swaps who you walk.`;
    closePicker(false);
  } else {
    btn.innerHTML = `<span class="fu-summon-em" aria-hidden="true">🔮</span><span class="fu-summon-lbl">Summon</span>`;
    btn.dataset.tooltip = "Call a summon to camp";
  }
  btn.setAttribute("aria-label", btn.dataset.tooltip);
  placeButton(btn);
  setTimeout(() => placeButton(btn), 500);
  requestAnimationFrame(() => btn.classList.add("is-shown"));
  keepPlaced(btn);
}

async function send(op, opts) {
  if (_sending) return;
  _sending = true;
  document.getElementById(BTN_ID)?.classList.add("is-sending");
  const res = await request(op, opts);
  _sending = false;
  document.getElementById(BTN_ID)?.classList.remove("is-sending");
  if (!res?.ok) ui.notifications?.warn(REASON[res?.reason] ?? REASON.error);
  refreshSoon();
}

function onButton() {
  if (_sending) return;
  if (_pick) { sfx("back"); closePicker(); return; }
  const mine = summonTokensOf(canvas?.scene, game.user.id);
  if (mine.length) { send("dismiss"); return; }
  openPicker();
}

// ── picker ──────────────────────────────────────────────────────────────────
function openPicker() {
  if (!_owner || !_groups.length) return;
  injectStyles();
  const btn = document.getElementById(BTN_ID);
  const last = readLast(_owner.id);
  const focus = Math.max(0, _groups.findIndex((g) => g.key === last));
  const el = document.createElement("div");
  el.className = PICK_CLASS;
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "Summon");
  el.style.left = btn?.style.left || "98px";
  el.innerHTML = _groups.map((g, i) => `
    <button type="button" class="fu-summon-item" role="menuitem" data-i="${i}" style="animation-delay:${i * 45}ms" aria-label="Summon ${esc(g.name)}">
      <span class="fu-summon-orb${g.sprites.length > 1 ? " is-group" : ""}">${g.sprites.map(spriteHtml).join("")}</span>
      <span class="fu-summon-name">${esc(g.name)}</span>
    </button>`).join("");
  document.body.appendChild(el);
  _pick = { el, focus };
  el.querySelectorAll(".fu-summon-item").forEach((b) => {
    b.addEventListener("pointerenter", () => setFocus(+b.dataset.i));
    b.addEventListener("pointerdown", (ev) => { ev.preventDefault(); setFocus(+b.dataset.i, false); confirmPicker(); });
  });
  drawFocus();
  runtime()?.lockMovement?.(LOCK_ID);
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("keydown", onPickKey, true);
  sfx("open");
}

function setFocus(i, sound = true) {
  if (!_pick || i === _pick.focus) return;
  _pick.focus = i;
  drawFocus();
  if (sound) sfx("move");
}
function drawFocus() {
  _pick?.el.querySelectorAll(".fu-summon-item").forEach((b, i) => b.classList.toggle("is-focus", i === _pick.focus));
}

function closePicker(animated = true) {
  if (!_pick) return;
  const { el } = _pick;
  _pick = null;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("keydown", onPickKey, true);
  runtime()?.unlockMovement?.(LOCK_ID);
  if (!animated) { el.remove(); return; }
  el.classList.add("is-out");
  setTimeout(() => el.remove(), 200);
}

function confirmPicker() {
  if (!_pick || !_owner) return;
  const g = _groups[_pick.focus];
  closePicker();
  if (!g) return;
  writeLast(_owner.id, g.key);
  send("summon", { ownerActorId: _owner.id, key: g.key });
}

function onOutside(ev) {
  if (ev.target.closest?.(`.${PICK_CLASS}, #${BTN_ID}`)) return;
  sfx("back");
  closePicker();
}

function onPickKey(ev) {
  if (!_pick) return;
  const n = _groups.length;
  const k = ev.code;
  let used = true;
  if (["ArrowLeft", "KeyA", "ArrowUp", "KeyW"].includes(k)) setFocus((_pick.focus + n - 1) % n);
  else if (["ArrowRight", "KeyD", "ArrowDown", "KeyS"].includes(k)) setFocus((_pick.focus + 1) % n);
  else if (k === "KeyZ" || k === "Enter" || k === "NumpadEnter") confirmPicker();
  else if (k === "KeyX" || k === "Escape") { sfx("back"); closePicker(); }
  else used = false;
  if (used) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); }
}

// ── install ─────────────────────────────────────────────────────────────────
let refreshSoon = () => {};
let _installed = false;
export function initCampSummonsUI() {
  if (_installed) return;
  _installed = true;
  refreshSoon = foundry.utils.debounce(() => refreshButton().catch((e) => console.warn(TAG, "refresh", e)), 150);
  Hooks.on("updateSetting", (s) => { if (String(s?.key ?? "").startsWith(`${MOD}.`)) refreshSoon(); });
  Hooks.on("canvasReady", () => { closePicker(false); refreshSoon(); });
  for (const h of ["createToken", "deleteToken"]) Hooks.on(h, (doc) => { if (flagOf(doc)) refreshSoon(); });
  for (const h of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(h, (item) => { if (_owner && item?.parent?.id === _owner.id) refreshSoon(); });
  }
  Hooks.on("userConnected", () => refreshSoon());
  refreshSoon();
  // Safety net: a first join can miss the first refresh (seen once in the
  // sandbox, behind the client-settings sync prompt; not reproduced on reload).
  setTimeout(() => refreshSoon(), 3000);
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
/* Camp row button (camp-ui-button.js: left 20, bottom 80, 64px; the row continues at 98, 172, 246, 320). */
#${BTN_ID} { position: fixed; z-index: 99998; left: 98px; bottom: 80px; width: 64px; height: 64px; border-radius: 50%; margin: 0; padding: 0; line-height: normal;
  border: 2px solid rgba(200,160,80,0.65); background: radial-gradient(circle at 40% 35%, rgba(90,65,30,0.92) 0%, rgba(45,32,14,0.96) 100%);
  box-shadow: 0 0 14px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12);
  color: #e8c870; text-shadow: 0 0 8px rgba(0,0,0,0.9);
  display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; user-select: none;
  opacity: 0; transform: scale(.6) translateY(10px); pointer-events: none;
  transition: opacity 250ms cubic-bezier(.4,0,.2,1), transform 250ms cubic-bezier(.4,0,.2,1), filter 180ms ease, left 180ms ease, border-color 180ms ease, box-shadow 180ms ease; }
#${BTN_ID}.is-shown { opacity: 1; transform: none; pointer-events: auto; }
#${BTN_ID}:hover { filter: brightness(1.18); }
#${BTN_ID}:active { filter: brightness(.9); }
#${BTN_ID}:focus-visible { outline: 2px solid #ffd27a; outline-offset: 3px; }
#${BTN_ID} .fu-summon-em { font-size: 26px; line-height: 1; margin-bottom: 1px; }
#${BTN_ID} .fu-summon-lbl { font-size: 8.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; opacity: .75; color: #e8c870; font-family: "Signika","Noto Sans",system-ui,sans-serif; }
#${BTN_ID}.is-on { border-color: rgba(244,212,136,.95); box-shadow: 0 0 18px rgba(244,212,136,.45), 0 2px 6px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.12); }
#${BTN_ID}.is-on .fu-summon-lbl { color: #f4d488; opacity: .95; }
#${BTN_ID} .fu-summon-face { width: 46px; height: 34px; border-radius: 50% 50% 40% 40%; overflow: hidden; display: flex; justify-content: center; align-items: flex-start; }
#${BTN_ID} .fu-summon-face img, #${BTN_ID} .fu-summon-face video { width: auto; max-width: none; border: 0; }
#${BTN_ID} .fu-summon-face .is-tall { height: 74px; margin-top: 2px; }
#${BTN_ID} .fu-summon-face .is-squat { height: 34px; }
#${BTN_ID} .fu-summon-key { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 5px;
  background: #f6ebd3; color: #3b2a19; border: 1px solid #8d5f38; font: 700 10.5px/16px "Signika","Noto Sans",system-ui,sans-serif; text-align: center; text-shadow: none; }
#${BTN_ID}.is-sending { animation: fuSummonSending .7s ease infinite; }
@keyframes fuSummonSending { 0%,100% { border-color: rgba(200,160,80,.65); } 50% { border-color: rgba(255,240,190,1); box-shadow: 0 0 20px rgba(255,240,190,.6); } }

/* Picker: floating bubbles over the button. */
.${PICK_CLASS} { position: fixed; z-index: 99999; left: 98px; bottom: 160px; display: flex; gap: 12px; align-items: flex-end; pointer-events: auto; }
.${PICK_CLASS} .fu-summon-item { appearance: none; background: none; border: 0; padding: 0; margin: 0; width: auto; height: auto; line-height: normal; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 6px; font-family: "Signika","Noto Sans",system-ui,sans-serif;
  animation: fuSummonIn .26s cubic-bezier(.3,1.4,.5,1) both; }
.${PICK_CLASS} .fu-summon-item:focus, .${PICK_CLASS} .fu-summon-item:hover { box-shadow: none; outline: none; }
.${PICK_CLASS}.is-out .fu-summon-item { animation: fuSummonOut .18s ease both; }
@keyframes fuSummonIn { from { opacity: 0; transform: translateY(26px) scale(.6); } to { opacity: 1; transform: none; } }
@keyframes fuSummonOut { to { opacity: 0; transform: translateY(14px) scale(.8); } }
.${PICK_CLASS} .fu-summon-orb { width: 64px; height: 64px; border-radius: 50%; overflow: hidden; display: flex; justify-content: center; align-items: flex-start;
  border: 2px solid rgba(200,160,80,0.65); box-sizing: border-box;
  background: radial-gradient(circle at 40% 35%, rgba(90,65,30,0.92) 0%, rgba(45,32,14,0.96) 100%);
  box-shadow: 0 0 14px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12);
  transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
.${PICK_CLASS} .fu-summon-orb img, .${PICK_CLASS} .fu-summon-orb video { width: auto; max-width: none; border: 0; flex-shrink: 0; }
.${PICK_CLASS} .fu-summon-orb .is-tall { height: 118px; margin-top: 4px; }
.${PICK_CLASS} .fu-summon-orb .is-squat { height: 54px; margin-top: 5px; }
.${PICK_CLASS} .fu-summon-orb.is-group img, .${PICK_CLASS} .fu-summon-orb.is-group video { margin-left: -14px; margin-right: -14px; }
.${PICK_CLASS} .fu-summon-orb.is-group .is-tall { height: 104px; margin-top: 6px; }
.${PICK_CLASS} .fu-summon-name { font-size: 11px; font-weight: 700; letter-spacing: .3px; white-space: nowrap; padding: 2px 9px; border-radius: 999px;
  background: #f6ebd3; color: #3b2a19; border: 1px solid #8d5f38; box-shadow: 0 2px 6px rgba(0,0,0,.45); transition: background .15s ease; }
.${PICK_CLASS} .fu-summon-item:hover .fu-summon-orb, .${PICK_CLASS} .fu-summon-item.is-focus .fu-summon-orb {
  transform: translateY(-4px) scale(1.06); border-color: rgba(244,212,136,.95);
  box-shadow: 0 0 18px rgba(244,212,136,.5), 0 2px 6px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.12); }
.${PICK_CLASS} .fu-summon-item.is-focus .fu-summon-name { background: linear-gradient(180deg, #f4d488, #caa44d); color: #4b3517; }
@media (prefers-reduced-motion: reduce) { #${BTN_ID}, .${PICK_CLASS} .fu-summon-item { transition: none !important; animation: none !important; } }
`;
  document.head.appendChild(s);
}
