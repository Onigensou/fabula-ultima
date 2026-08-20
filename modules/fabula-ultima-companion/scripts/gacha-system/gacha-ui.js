// ============================================================================
// Gacha System — Overlay shell
// ----------------------------------------------------------------------------
// The screen itself: a horizontal banner RAIL, a code-built banner card, the
// currency console, and the action buttons.
//
// The rail replaces the old fixed tab strip because the banner roster only ever
// grows — arrows and the mouse wheel move the SELECTION, and the rail scrolls
// itself to keep that selection in view. Changing selection cross-fades and
// slides the card in the direction you scrolled.
//
// The card is composed in script from the banner's own items (see
// gacha-banners.js) rather than a hand-made PNG. Text is laid over that art
// using the Level-Up window's stroke+glow treatment, because item icons vary
// wildly and cannot be designed around.
//
// Opens for EVERYONE on a gacha-mode scene — spectating is the point of a gacha
// screen. Only party members (and the GM) get the interactive controls.
// ============================================================================

import { GACHA, RARITY, log } from "./gacha-const.js";
import { listBanners, imgOf, FALLBACK_IMG } from "./gacha-banners.js";
import { partyActor, readPool, isPartyMemberClient, couponCost } from "./gacha-state.js";
import { request, announceStart } from "./gacha-net.js";
import { beginReveal, stop as stopFx } from "./gacha-fx.js";
import { renderPanel } from "./gacha-panels.js";
import { ensureTheme } from "./gacha-theme.js";

const ROOT_ID  = "gacha-ui";
const STYLE_ID = "gacha-ui-style";

const SFX_SCROLL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_3.wav";
const sfx = (src) => { try { AudioHelper?.play({ src, volume: 0.5, loop: false }, false); } catch {} };

const THUMB_W = 96;    // thumbnail + gap, used to centre the rail strip
const THUMB_GAP = 10;

// Small-print parody, filling the column under the banner copy. Deliberately
// static and shared by every banner — it is set dressing, not banner data. If
// it ever wants to be per-banner, it belongs in a RollTable field next to the
// epithet rather than here.
const FILLER_COPY = `
  Wishes made upon the Wonderous Gachapon are final and non-refundable. Hako
  Coupons carry no monetary value outside this machine and may not be redeemed
  for zenit, favours, or emotional support. Hako is not responsible for
  duplicate pieces, which are a feature of fortune rather than a defect of the
  machine. Hako is likewise not responsible for oaths sworn, debts incurred,
  bonds strained, or party funds spent in pursuit of a complete set. Hako
  reminds patrons that the machine has never once been wrong, only unlucky.
  Complaints regarding the machine may be submitted to Hako, who will consider
  them carefully and at length. Participation implies acceptance that fortune
  is a fickle patron and Hako is a worse one. Void where prohibited by
  narrative causality.`;

const CSS = `
#${ROOT_ID} {
  position: fixed;
  top: var(--gu-top, 0px); right: var(--gu-right, 0px);
  bottom: var(--gu-bottom, 0px); left: var(--gu-left, 0px);
  z-index: 60; pointer-events: none;
  font-family: 'Lucida Console', 'Courier New', monospace;
  color: var(--gc-ink); user-select: none;
}
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .gu-on { pointer-events: auto; }
#${ROOT_ID} img { border: 0 !important; outline: 0 !important; background: transparent; }

/* ── banner rail ────────────────────────────────────────────────────────── */
.gu-rail {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: var(--gc-radius-lg);
  background: linear-gradient(180deg, rgba(247,240,223,.93), rgba(226,211,182,.93));
  border: 1px solid var(--gc-line-2);
  box-shadow: 0 10px 26px -12px rgba(40,26,10,.7);
  /* Reserve the corners so the centred rail can never crowd the currency
     console on the right — which it did once the sidebar was expanded and the
     overlay narrowed. */
  max-width: calc(100% - 420px);
}
.gu-arrow {
  flex: 0 0 auto; width: 32px; height: 62px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--gc-radius); border: 1px solid var(--gc-line-2);
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel));
  color: var(--gc-ink-2); font-size: 22px; line-height: 1;
  transition: background .13s, border-color .13s, opacity .13s;
}
.gu-arrow:hover { background: #fffaec; border-color: var(--gc-gold); }
.gu-arrow.is-off { opacity: .3; cursor: default; }

.gu-rail-view { overflow: hidden; }
.gu-rail-strip {
  display: flex; gap: ${THUMB_GAP}px;
  transition: transform .34s cubic-bezier(.22,.61,.36,1);
}
/* No label: the set name is the headline of the card below, and repeating it
   here only crowded the rail. The lead item's icon is the identifier. */
.gu-thumb {
  flex: 0 0 auto; width: ${THUMB_W - THUMB_GAP}px; height: 62px;
  cursor: pointer; position: relative; overflow: hidden;
  border-radius: var(--gc-radius); border: 2px solid var(--gc-line);
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-sunk));
  display: flex; align-items: center; justify-content: center;
  transition: border-color .15s, transform .15s, box-shadow .15s, filter .15s;
  filter: saturate(.55) brightness(.96);
}
.gu-thumb:hover { transform: translateY(-2px); filter: none; }
.gu-thumb.is-active {
  border-color: var(--gc-gold); filter: none;
  box-shadow: 0 0 0 2px var(--gc-gold-soft), 0 6px 16px -8px rgba(60,40,14,.7);
  transform: translateY(-2px);
}
.gu-thumb img { width: 46px; height: 46px; object-fit: contain; }

/* ── console (wallet + pity) ────────────────────────────────────────────── */
.gu-console {
  position: absolute; top: 0; right: 0;
  display: flex; flex-direction: column; align-items: flex-end; gap: 7px;
}
.gu-wallet { display: flex; gap: 9px; align-items: center; }
.gu-coin {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 15px 7px 9px; border-radius: 999px;
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel));
  border: 1px solid var(--gc-line-2); color: var(--gc-ink);
  font-size: 16px; letter-spacing: 1px;
}
.gu-coin img { width: 28px; height: 28px; object-fit: contain; }
.gu-coin.is-ticket { border-color: var(--gc-gold); color: var(--gc-title); }
.gu-buy {
  width: 30px; height: 30px; border-radius: 50%; cursor: pointer;
  border: 1px solid var(--gc-line-3); background: var(--gc-parch);
  color: var(--gc-ink-2); font-size: 18px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  transition: background .13s, border-color .13s;
}
.gu-buy:hover { background: #fffaec; border-color: var(--gc-gold); }
.gu-pity {
  font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--gc-ink-3); text-align: right;
  padding: 5px 12px; border-radius: 999px;
  background: rgba(247,240,223,.8); border: 1px solid var(--gc-line);
}
.gu-pity b { color: var(--gc-title); font-weight: 700; }

/* ── banner card ────────────────────────────────────────────────────────── */
/* Top inset leaves clear air under the rail — the two must not run tangent.
   Bottom inset clears the action row. */
.gu-stage { position: absolute; inset: 128px 0 118px 0; display: flex; }
.gu-card {
  flex: 1 1 auto; display: flex; overflow: hidden;
  border-radius: var(--gc-radius-lg);
  border: 2px solid var(--gc-line-2);
  /* Flat, not a 135deg gradient: the diagonal drew a visible seam straight
     across the middle of the card. */
  background: var(--gc-parch);
  box-shadow: var(--gc-shadow);
}
.gu-card.in-right { animation: gu-in-right .34s cubic-bezier(.22,.61,.36,1) both; }
.gu-card.in-left  { animation: gu-in-left  .34s cubic-bezier(.22,.61,.36,1) both; }
@keyframes gu-in-right { from { opacity: 0; transform: translateX(46px); } to { opacity: 1; transform: none; } }
@keyframes gu-in-left  { from { opacity: 0; transform: translateX(-46px); } to { opacity: 1; transform: none; } }

/* The text column sits on flat parchment, NOT over artwork, so it takes plain
   high-contrast ink. The gc-over stroke is for labels floating on top of an
   item icon; used here it just eats the glyphs and washes the text out. */
/* Title block sits TOP-left; the column no longer centres its content. */
/* No divider: the card should read as one surface, not two panes. */
.gu-card-text {
  flex: 0 0 38%; padding: 34px 32px; display: flex; flex-direction: column;
  justify-content: flex-start; gap: 12px; min-width: 0; z-index: 2;
}
.gu-epithet {
  font-size: 14px; letter-spacing: 4px; text-transform: uppercase;
  color: var(--gc-gold); font-weight: 700;
}
.gu-title {
  font-size: 44px; line-height: 1.04; font-weight: 800; font-style: italic;
  color: var(--gc-title); word-break: break-word;
  text-shadow: 0 1px 0 rgba(255,255,255,.5);
}
/* The banner headline only — a short highlighted bar, as Genshin does it. The
   guarantee wording sits outside it, as plain body copy. */
.gu-promo {
  align-self: flex-start; margin-top: 4px;
  padding: 8px 16px; border-radius: var(--gc-radius);
  background: linear-gradient(180deg, var(--gc-panel), var(--gc-sunk));
  border-left: 4px solid var(--gc-gold);
  font-size: 14px; font-weight: 700; letter-spacing: 1px; color: var(--gc-title);
}
.gu-guarantee { font-size: 13px; line-height: 1.7; color: var(--gc-ink-2); }
.gu-guarantee b { color: var(--gc-title); }

.gu-setline { font-size: 13px; color: var(--gc-ink-3); line-height: 1.8; }
.gu-setline b { color: var(--gc-ink); }

.gu-filler {
  font-size: 11px; line-height: 1.75; color: var(--gc-ink-soft);
  padding-top: 6px; margin-top: 4px;
}
.gu-hint {
  margin-top: auto; font-size: 12px; font-style: italic; color: var(--gc-ink-soft);
}

.gu-card-art {
  flex: 1 1 auto; min-width: 0; padding: 20px 26px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 18px;
  background:
    radial-gradient(ellipse at 50% 42%, rgba(255,252,242,.9) 0%, rgba(247,240,223,0) 62%),
    var(--gc-parch);
}
/* A framed plate around the lead item. Many item icons are opaque white-
   background art rather than transparent PNGs, and a bare <img> renders as a
   white rectangle floating on parchment. Framing it makes that read as a
   deliberate card instead of a mistake. */
/* The plate drives the size, not the image.
   Item icons range from ~130px to full illustrations, and width:auto renders
   them at intrinsic size — which scales DOWN but never UP, so a small icon sat
   as a postage stamp in the middle of the card. Fix the plate and let the image
   contain itself into it. */
/* Plate and stars share one block so the stars can hang directly under the
   name. Anchoring them to the art COLUMN instead pushed them out to its far
   right edge, well clear of the name they belong to. */
.gu-lead-block {
  flex: 0 0 auto; width: min(50vh, 430px);
  display: flex; flex-direction: column;
}
.gu-lead-plate {
  flex: 0 0 auto; position: relative;
  width: 100%; height: min(50vh, 430px);
  display: flex; align-items: center; justify-content: center;
  padding: 10px; border-radius: var(--gc-radius-lg);
  border: 2px solid var(--gc-line-2);
  background: linear-gradient(180deg, #fffdf6, var(--gc-sunk));
  box-shadow: 0 14px 30px -14px rgba(60,40,14,.6), inset 0 0 0 1px rgba(255,255,255,.7);
  animation: gu-float 6s ease-in-out infinite;
}
.gu-lead {
  width: 100%; height: 100%; object-fit: contain;
  border-radius: 6px; transition: opacity .16s;
}
/* Item art is a mix of small pixel sprites and large painted illustrations.
   Bilinear upscaling turns the sprites to mush, so anything under 256px native
   is snapped to nearest-neighbour instead. */
.gu-lead.is-pixel { image-rendering: pixelated; }
@keyframes gu-float { 0%,100% { transform: translateY(-5px); } 50% { transform: translateY(5px); } }

/* Name rides the bottom of the plate, over the art — this IS the case the
   Level-Up stroke treatment exists for. */
/* Softens the bottom edge of the art into the card instead of ending on a hard
   line. Sits above the image, below the name. */
.gu-lead-plate::after {
  content: ""; position: absolute; left: 10px; right: 10px; bottom: 10px;
  height: 38%; z-index: 2; pointer-events: none; border-radius: 0 0 6px 6px;
  background: linear-gradient(to bottom,
    rgba(255,253,246,0) 0%, rgba(255,253,246,.72) 62%, rgba(255,253,246,.96) 100%);
}

/* Rides the bottom of the plate, offset RIGHT of centre.
   Outlined with layered text-shadows rather than -webkit-text-stroke: a stroke
   is drawn centred on the glyph outline and eats inward, which on a thin
   italic face at this size consumed the fill entirely and left ghost text.
   Shadows sit strictly OUTSIDE the glyph, so the dark fill stays solid over
   both pale and busy artwork. */
.gu-lead-name {
  position: absolute; left: 12%; right: -30px; bottom: -14px; text-align: right;
  font-family: "Trebuchet MS", "Segoe UI", Verdana, sans-serif;
  font-size: 42px; font-weight: 800; font-style: italic; letter-spacing: .5px;
  color: var(--gc-ink); pointer-events: none; z-index: 3;
  -webkit-text-stroke: 0;
  text-shadow:
    -2px -2px 0 #fffdf6,  2px -2px 0 #fffdf6,
    -2px  2px 0 #fffdf6,  2px  2px 0 #fffdf6,
     0   -2px 0 #fffdf6,  0    2px 0 #fffdf6,
    -2px  0   0 #fffdf6,  2px  0   0 #fffdf6,
     0    4px 8px rgba(60,40,14,.45);
}
/* Directly beneath the name — same right edge, so the two read as one label.
   The -30px matches .gu-lead-name's right offset. */
.gu-lead-stars {
  margin: 26px -30px 0 0; text-align: right;
  font-size: 30px; letter-spacing: 5px; color: var(--gc-r5);
  text-shadow: 0 1px 2px rgba(90,60,20,.4);
}

/* The overlay root is pointer-events:none so the canvas stays usable, and
   children opt back in. These chips are hover targets, so they must opt in —
   without it the hover preview silently never fires for a real cursor (a
   synthetic mouseenter still "works", which is exactly how it passed a test
   while being broken in the game). */
.gu-support {
  display: flex; gap: 9px; flex-wrap: wrap; justify-content: center;
  max-width: 100%; pointer-events: auto;
}
.gu-support img {
  width: 58px; height: 58px; object-fit: contain; padding: 4px; cursor: pointer;
  border-radius: var(--gc-radius); border: 2px solid var(--gc-line);
  background: rgba(255,253,246,.9);
  transition: transform .13s, border-color .13s, box-shadow .13s;
}
.gu-support img:hover {
  transform: translateY(-3px); border-color: var(--gc-gold);
  box-shadow: 0 6px 14px -6px rgba(60,40,14,.7);
}
.gu-support img.is-showing { border-color: var(--gc-gold); box-shadow: 0 0 0 2px var(--gc-gold-soft); }
.gu-support img.is-filler { width: 48px; height: 48px; opacity: .82; }

/* ── actions ────────────────────────────────────────────────────────────── */
/* Side by side, not stacked. */
.gu-actions {
  position: absolute; right: 0; bottom: 0;
  display: flex; flex-direction: row; gap: 14px; align-items: center;
}
.gu-wish {
  min-width: 250px; padding: 15px 28px; cursor: pointer;
  border-radius: 999px; border: 2px solid var(--gc-line-3);
  background: linear-gradient(180deg, var(--gc-deep), var(--gc-deep-2));
  color: var(--gc-deep-ink); font-family: inherit; font-size: 17px;
  letter-spacing: 3px; text-transform: uppercase;
  display: flex; align-items: center; justify-content: center; gap: 14px;
  transition: filter .14s, transform .14s, box-shadow .14s;
  box-shadow: 0 8px 20px -10px rgba(40,26,10,.85);
}
.gu-wish:hover:not(.is-off) {
  filter: brightness(1.15); transform: translateY(-2px);
  box-shadow: 0 12px 26px -10px rgba(40,26,10,.9);
  border-color: var(--gc-gold);
}
.gu-wish.is-off { opacity: .4; cursor: default; filter: saturate(.35); }
.gu-wish small {
  font-size: 14px; letter-spacing: 1px; text-transform: none;
  display: flex; align-items: center; gap: 5px; opacity: .92;
}
.gu-wish small img { width: 22px; height: 22px; }

.gu-nav { position: absolute; left: 0; bottom: 0; display: flex; gap: 10px; }
.gu-nav-btn {
  padding: 13px 26px; cursor: pointer; border-radius: var(--gc-radius);
  border: 1px solid var(--gc-line-3);
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel));
  color: var(--gc-ink); font-family: inherit; font-size: 14px;
  letter-spacing: 2px; text-transform: uppercase;
  transition: background .13s, border-color .13s, transform .13s;
}
.gu-nav-btn:hover {
  background: #fffaec; border-color: var(--gc-gold); transform: translateY(-1px);
}

.gu-toast {
  position: absolute; left: 50%; bottom: 92px; transform: translateX(-50%);
  padding: 11px 22px; border-radius: var(--gc-radius); font-size: 13px;
  background: var(--gc-parch); border: 1px solid var(--gc-line-3); color: var(--gc-ink);
  box-shadow: var(--gc-shadow);
}
.gu-toast.is-bad { border-color: #a8412f; color: #7c2718; }
`;

function ensureStyle() {
  ensureTheme();
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ── Chrome-aware insets ─────────────────────────────────────────────────────

function applyInsets() {
  if (!S.el) return;
  const vw = window.innerWidth, vh = window.innerHeight, pad = 14;

  const rect = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return (r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden") ? r : null;
  };

  const top = rect("#ui-top"), left = rect("#ui-left");
  const right = rect("#sidebar") ?? rect("#ui-right");
  const bottom = rect("#ui-bottom");

  // The module parks its own round buttons against the right edge. They are not
  // Foundry chrome, so find them by the id="oni-*" convention rather than by
  // name — the list changes as systems are added.
  let rightEdge = right ? right.left : vw;
  for (const n of document.querySelectorAll('[id^="oni-"]')) {
    if (n.closest(`#${ROOT_ID}`)) continue;
    const r = n.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.left < vw * 0.7) continue;
    rightEdge = Math.min(rightEdge, r.left);
  }

  S.el.style.setProperty("--gu-top",    `${Math.max(pad, (top?.bottom ?? 0) + pad)}px`);
  S.el.style.setProperty("--gu-left",   `${Math.max(pad, (left?.right ?? 0) + pad)}px`);
  S.el.style.setProperty("--gu-right",  `${Math.max(pad, vw - rightEdge + pad)}px`);
  S.el.style.setProperty("--gu-bottom", `${Math.max(pad, bottom ? vh - bottom.top + pad : pad)}px`);

  layoutRail();
}

// ── State ───────────────────────────────────────────────────────────────────

const S = {
  el: null, opening: false,
  banners: [], index: 0,
  actor: null, canPlay: false,
  pool: { coupons: 0, tickets: 0 },
  cost: 200, busy: false,
};

const current = () => S.banners[S.index] ?? null;

// ── Open / close ────────────────────────────────────────────────────────────

export async function open() {
  // Re-entrancy guard, not just "already open": open() awaits before assigning
  // S.el, and install() + canvasReady both fire on boot. Without this, two
  // overlays get appended and the screen renders doubled.
  if (S.el || S.opening) return;
  S.opening = true;
  try { await build(); } finally { S.opening = false; }
}

async function build() {
  S.actor = await partyActor();
  if (!S.actor) return;

  S.banners = listBanners();
  if (!S.banners.length) { ui.notifications?.warn("Gacha: no banner tables found."); return; }

  S.index   = 0;
  S.canPlay = isPartyMemberClient(S.actor) || game.user.isGM;
  S.pool    = readPool(S.actor);
  S.cost    = await couponCost();

  ensureStyle();
  document.querySelectorAll(`#${ROOT_ID}`).forEach((n) => n.remove());

  S.el = document.createElement("div");
  S.el.id = ROOT_ID;
  S.el.innerHTML = shellHTML();
  document.body.appendChild(S.el);

  bindShell();
  paintRail();
  paintStage(0);
  paintConsole();
  paintActions();
  applyInsets();

  log("Overlay open —", S.canPlay ? "participant" : "spectator");
}

export function close() {
  document.querySelectorAll(`#${ROOT_ID}`).forEach((n) => n.remove());
  S.el = null;
  S.busy = false;
}

export const isOpen = () => !!S.el;
export const partyActorId = () => S.actor?.id ?? null;
export function relayout() { applyInsets(); }

/** Currency changed somewhere — repaint only what shows it. */
export function refreshPool(pool) {
  if (pool) S.pool = pool;
  else if (S.actor) S.pool = readPool(S.actor);
  if (!S.el) return;
  paintConsole();
  paintActions();
}

// ── Shell ───────────────────────────────────────────────────────────────────

function shellHTML() {
  return `
    <div class="gu-rail gu-on">
      <div class="gu-arrow" data-nav="-1">‹</div>
      <div class="gu-rail-view"><div class="gu-rail-strip"></div></div>
      <div class="gu-arrow" data-nav="1">›</div>
    </div>
    <div class="gu-console gu-on"></div>
    <div class="gu-stage"></div>
    <div class="gu-nav gu-on">
      <button class="gu-nav-btn" data-act="details">Details</button>
      <button class="gu-nav-btn" data-act="exchange">Exchange</button>
      ${S.canPlay ? `<button class="gu-nav-btn" data-act="shop">Shop</button>` : ""}
    </div>
    ${S.canPlay ? `<div class="gu-actions gu-on"></div>` : ""}
  `;
}

function bindShell() {
  const el = S.el;

  el.querySelectorAll("[data-nav]").forEach((n) =>
    n.addEventListener("click", () => step(Number(n.dataset.nav)))
  );

  el.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () =>
      renderPanel(b.dataset.act, { banner: current(), state: S, refresh: refreshPool })
    )
  );

  // Wheel anywhere over the screen moves the selection. passive:false so the
  // canvas underneath does not also zoom.
  el.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const now = performance.now();
    if (now - (S._lastWheel ?? 0) < 140) return;   // one banner per gesture, not per tick
    S._lastWheel = now;
    step(ev.deltaY > 0 ? 1 : -1);
  }, { passive: false });
}

// ── Rail ────────────────────────────────────────────────────────────────────

function paintRail() {
  const strip = S.el.querySelector(".gu-rail-strip");
  strip.innerHTML = S.banners
    .map((b, i) => `
      <div class="gu-thumb${i === S.index ? " is-active" : ""}" data-i="${i}" title="${esc(b.title)}">
        <img src="${imgOf(b.lead)}" alt="" data-fallback>
      </div>`)
    .join("");

  strip.querySelectorAll(".gu-thumb").forEach((n) =>
    n.addEventListener("click", () => {
      const i = Number(n.dataset.i);
      if (i !== S.index) select(i, Math.sign(i - S.index));
    })
  );
  bindFallbacks(strip);
  layoutRail();
  paintArrows();
}

/** Slide the strip so the active thumbnail is centred in the viewport. */
function layoutRail() {
  if (!S.el) return;
  const view  = S.el.querySelector(".gu-rail-view");
  const strip = S.el.querySelector(".gu-rail-strip");
  if (!view || !strip) return;

  // Show as many whole thumbnails as fit, capped by the roster size.
  //
  // Measured against the OVERLAY's width, not the rail's own. The rail is
  // sized by its content, so reading its width here would be circular: a
  // narrow view makes a narrow rail, which then computes an even narrower
  // view. After a sidebar toggle that collapsed the rail to one thumbnail.
  // RESERVE matches the rail's max-width clamp, which keeps it clear of the
  // currency console.
  const ARROWS = 2 * 32, GAPS = 16, PAD = 20, RESERVE = 420;
  const avail = Math.max(THUMB_W, S.el.clientWidth - RESERVE - ARROWS - GAPS - PAD);
  const fit = Math.max(1, Math.min(S.banners.length, Math.floor(avail / THUMB_W)));
  view.style.width = `${fit * THUMB_W - THUMB_GAP}px`;

  const maxOffset = Math.max(0, S.banners.length - fit);
  const desired = S.index - Math.floor((fit - 1) / 2);
  const offset = Math.max(0, Math.min(maxOffset, desired));
  strip.style.transform = `translateX(${-offset * THUMB_W}px)`;
}

function paintArrows() {
  const [prev, next] = S.el.querySelectorAll("[data-nav]");
  prev?.classList.toggle("is-off", S.index <= 0);
  next?.classList.toggle("is-off", S.index >= S.banners.length - 1);
}

function step(dir) {
  const i = S.index + dir;
  if (i < 0 || i >= S.banners.length) return;
  select(i, dir);
}

function select(i, dir) {
  S.index = i;
  sfx(SFX_SCROLL);

  S.el.querySelectorAll(".gu-thumb").forEach((n) =>
    n.classList.toggle("is-active", Number(n.dataset.i) === i)
  );
  layoutRail();
  paintArrows();
  paintStage(dir);
  paintConsole();
}

// ── Stage ───────────────────────────────────────────────────────────────────

function paintStage(dir) {
  const stage = S.el.querySelector(".gu-stage");
  const b = current();
  if (!b) { stage.innerHTML = ""; return; }

  const anim = dir > 0 ? "in-right" : dir < 0 ? "in-left" : "";
  const mainCount = b.mainSet?.entries?.length ?? 0;
  const fillerNames = b.fillerSets.map((g) => g.setName).join(", ");

  // Every piece the card can feature, lead first. Index 0 is the resting state.
  const showable = [b.lead, ...(b.mainSet?.entries ?? []).slice(1),
                    ...b.fillerSets.flatMap((g) => g.entries)].filter(Boolean);

  stage.innerHTML = `
    <div class="gu-card ${anim}">
      <div class="gu-card-text">
        ${b.epithet ? `<div class="gu-epithet">${esc(b.epithet)}</div>` : ""}
        <div class="gu-title">${esc(b.title)}</div>
        <div class="gu-promo">Probability increased!</div>
        <div class="gu-guarantee">
          Every 10 wishes is guaranteed to include at least one
          <b>${RARITY.four.label} or higher</b> item.
        </div>
        <div class="gu-setline">
          Featured set — <b>${esc(b.mainSet?.setName ?? b.title)}</b> (${mainCount} pieces)
          ${fillerNames ? `<br>Also featuring — <b>${esc(fillerNames)}</b>` : ""}
        </div>
        <div class="gu-filler">${FILLER_COPY}</div>
        <div class="gu-hint">View Details for more…</div>
      </div>
      <div class="gu-card-art">
        <div class="gu-lead-block">
          <div class="gu-lead-plate">
            <img class="gu-lead" src="${imgOf(b.lead)}" alt="" data-fallback>
            <div class="gu-lead-name gc-over">${esc(b.lead?.name ?? "")}</div>
          </div>
          <div class="gu-lead-stars">${"★".repeat(RARITY.five.stars)}</div>
        </div>
        <div class="gu-support">
          ${showable.slice(1).map((e, i) => {
            const filler = i >= mainCount - 1;
            return `<img class="${filler ? "is-filler" : ""}" data-show="${i + 1}"
                         src="${imgOf(e)}" alt="" data-fallback>`;
          }).join("")}
        </div>
      </div>
    </div>`;

  bindFallbacks(stage);
  markPixel(stage.querySelector(".gu-lead"));
  bindFeaturePreview(stage, showable);
  cardIntro(stage);
}

/** Snap small sprites to nearest-neighbour once their natural size is known. */
function markPixel(img) {
  if (!img) return;
  const apply = () => img.classList.toggle("is-pixel", img.naturalWidth > 0 && img.naturalWidth < 256);
  if (img.complete) apply();
  else img.addEventListener("load", apply, { once: true });
}

/**
 * Hovering a set piece promotes it into the big plate; leaving the row restores
 * the lead. Preview only — nothing is selected and nothing is committed.
 */
function bindFeaturePreview(stage, showable) {
  const img  = stage.querySelector(".gu-lead");
  const name = stage.querySelector(".gu-lead-name");
  const row  = stage.querySelector(".gu-support");
  if (!img || !row) return;

  const show = (i) => {
    const e = showable[i];
    if (!e) return;
    img.src = imgOf(e);
    markPixel(img);
    if (name) name.textContent = e.name;
    row.querySelectorAll("[data-show]").forEach((n) =>
      n.classList.toggle("is-showing", Number(n.dataset.show) === i)
    );
  };

  row.querySelectorAll("[data-show]").forEach((n) =>
    n.addEventListener("mouseenter", () => show(Number(n.dataset.show)))
  );
  // Restore on leaving the whole row, not each chip — per-chip restore flickers
  // as the cursor crosses the gaps.
  row.addEventListener("mouseleave", () => show(0));
}

/**
 * Entrance: the art lands first, then the text assembles in reading order.
 *
 * Same two-beat shape as the Level-Up class page (previewIntro in
 * levelup-fx.js), including its rapid-scroll guard — without it, spinning the
 * rail restarts the sequence every time and the text, which waits on the art,
 * never gets to appear at all.
 */
let _lastIntro = 0;
function cardIntro(stage) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;

  const now = performance.now();
  const rapid = now - _lastIntro < 320;
  _lastIntro = now;
  if (rapid) return;

  const ART_MS = 520;
  const art = stage.querySelector(".gu-card-art");
  art?.animate(
    [{ opacity: 0, transform: "translateX(38px)" }, { opacity: 1, transform: "none" }],
    { duration: ART_MS, easing: "cubic-bezier(.16,.84,.3,1)", fill: "both" }
  );

  const blocks = Array.from(stage.querySelector(".gu-card-text")?.children ?? []);
  const start = ART_MS - 260;   // overlaps the art's last moments
  blocks.forEach((el, i) => {
    el.animate(
      [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }],
      { duration: 280, delay: start + i * 75, easing: "cubic-bezier(.2,.8,.3,1)", fill: "both" }
    );
  });
}

// ── Console + actions ───────────────────────────────────────────────────────

function paintConsole() {
  const box = S.el.querySelector(".gu-console");

  // Currency only. The pity readout moved into the banner card's promo block,
  // where it reads as part of the offer rather than as a stray HUD number.
  box.innerHTML = `
    <div class="gu-wallet">
      <div class="gu-coin">
        <img src="${couponImgSrc()}" alt="" data-fallback> ${S.pool.coupons}
        ${S.canPlay ? `<div class="gu-buy" data-act="buy" title="Buy Hako Coupons">+</div>` : ""}
      </div>
      ${S.pool.tickets > 0 ? `<div class="gu-coin is-ticket">★ ${S.pool.tickets}</div>` : ""}
    </div>`;

  box.querySelector('[data-act="buy"]')?.addEventListener("click", () =>
    renderPanel("shop", { banner: current(), state: S, refresh: refreshPool })
  );
  bindFallbacks(box);
}

function paintActions() {
  const box = S.el.querySelector(".gu-actions");
  if (!box) return;
  const img = couponImgSrc();

  box.innerHTML = [1, 10].map((n) => {
    const off = S.pool.coupons < n || S.busy;
    return `
      <button class="gu-wish${off ? " is-off" : ""}" data-wish="${n}">
        Wish ×${n}
        <small><img src="${img}" alt="" data-fallback>×${n}</small>
      </button>`;
  }).join("");

  box.querySelectorAll("[data-wish]").forEach((b) =>
    b.addEventListener("click", () => wish(Number(b.dataset.wish)))
  );
  bindFallbacks(box);
}

// ── Wish ────────────────────────────────────────────────────────────────────

async function wish(count) {
  if (S.busy || S.pool.coupons < count) return;
  S.busy = true;
  paintActions();

  // Launch the streak on the click, not on the answer — the engine spends a
  // couple of seconds writing documents and the stars fly grey until it lands.
  beginReveal(count);
  announceStart(count);

  const res = await request(GACHA.MSG.WISH_REQ, {
    bannerId: current()?.id,
    count,
    requesterUserId: game.user.id,
  });

  S.busy = false;

  if (!res?.ok) {
    stopFx();
    toast(failureText(res), true);
  } else if (res.pool) {
    S.pool = res.pool;
  }

  paintActions();
  paintConsole();
  paintStage(0);   // repaint the card against the new pool state
}

function failureText(res) {
  switch (res?.reason) {
    case "insufficient_coupons": return `Not enough coupons (${res.have}/${res.need}).`;
    case "timeout":              return "No GM responded — is one connected?";
    case "banner_not_found":     return "That banner no longer exists.";
    case "party_actor_missing":  return "Party sheet could not be resolved.";
    default:                     return `Wish failed (${res?.reason ?? "unknown"}).`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Any item may be authored without art; fall back rather than show a broken box. */
function bindFallbacks(root) {
  root.querySelectorAll("img[data-fallback]").forEach((img) =>
    img.addEventListener("error", () => { img.src = FALLBACK_IMG; }, { once: true })
  );
}

function couponImgSrc() {
  return S.actor?.items?.find((i) => i.name === "Hako Coupon")?.img ?? FALLBACK_IMG;
}

export function toast(text, bad = false) {
  if (!S.el) return;
  S.el.querySelector(".gu-toast")?.remove();
  const t = document.createElement("div");
  t.className = `gu-toast${bad ? " is-bad" : ""}`;
  t.textContent = text;
  S.el.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
