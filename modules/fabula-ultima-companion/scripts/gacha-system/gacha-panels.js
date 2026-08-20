// ============================================================================
// Gacha System — Panels (Details / Shop / Exchange)
// ----------------------------------------------------------------------------
// Modal panels over the overlay shell. One file because they share a frame,
// dismissal behaviour, tooltip layer and request plumbing.
//
// Each panel declares its own WIDTH. The first build gave every panel the same
// ~1000px frame, which is why "buy N coupons" rendered a full-width input, wrapped
// its flex row, and stretched the Purchase button across the whole modal. Panels
// are sized to their content, and .gc-btn never stretches.
//
// GIFT EXCHANGE is a set board: one tab per gacha set, every piece of that set
// listed, and only pieces the party actually holds are live. Icons only, with a
// hover tooltip for detail — a grid of names does not fit and does not read.
// ============================================================================

import { GACHA, RARITY, TICKET_NAME, TICKET_ITEM_UUID, COUPON_ITEM_UUID } from "./gacha-const.js";
import { getPoolTable, resolveTableItems, groupBySet, imgOf, FALLBACK_IMG } from "./gacha-banners.js";
import { listSetBoard } from "./gacha-exchange.js";
import { request } from "./gacha-net.js";
import { ensureTheme } from "./gacha-theme.js";

const PANEL_ID   = "gacha-panel";
const TIP_ID     = "gacha-tip";
const CONFIRM_ID = "gacha-confirm";
const STYLE_ID   = "gacha-panel-style";

// The house Zenit coin, shared with the shop, sell and refinement windows so
// currency reads identically everywhere. Icon only — never a "z" suffix.
const COIN_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";
const COIN_ICON    = `<img class="gp-coin" src="${COIN_SRC}" alt="Zenit">`;

// The prinny stands for the PARTY STASH, distinct from a character's own purse.
const STASH_SRC  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/prin.png";
const STASH_ICON = `<img class="gp-coin is-stash" src="${STASH_SRC}" alt="Party stash">`;

// Hako himself, for the confirmation when the party's money is on the line.
const HAKO_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Character/Hako/Hako%20Standard.png";

/**
 * Tween an integer readout, for the purse ticking down on a purchase.
 *
 * rAF drives it, but a timeout guarantees the final value lands even if the
 * frame loop is throttled — a background tab would otherwise leave the number
 * frozen mid-count, showing a balance that was never real.
 */
function rollNumber(el, from, to, ms = 600) {
  if (!el) return;
  if (from === to || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    el.textContent = to.toLocaleString();
    return;
  }

  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);   // decelerate, like a counter settling
  let done = false;

  const settle = () => { if (done) return; done = true; el.textContent = to.toLocaleString(); };

  const step = (now) => {
    if (done) return;
    // Clamp the LOW end too. rAF hands back the frame's start time, which can
    // predate the performance.now() sampled moments earlier — a negative t runs
    // the easing backwards and flashes a wildly wrong figure before settling.
    const t = Math.min(1, Math.max(0, (now - t0) / ms));
    el.textContent = Math.round(from + (to - from) * ease(t)).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
    else settle();
  };

  requestAnimationFrame(step);
  setTimeout(settle, ms + 250);
}

const CSS = `
#${PANEL_ID} {
  position: fixed; inset: 0; z-index: 70; pointer-events: auto;
  background: rgba(46,32,14,.55); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  font-family: 'Lucida Console', 'Courier New', monospace; color: var(--gc-ink);
  animation: gp-fade .16s ease-out both;
}
@keyframes gp-fade { from { opacity: 0; } }
#${PANEL_ID} * { box-sizing: border-box; }
#${PANEL_ID} img { border: 0 !important; outline: 0 !important; background: transparent; }

.gp-stack { display: flex; flex-direction: column; align-items: stretch; }
.gp-frame {
  width: var(--gp-w, 900px); max-width: 94vw; max-height: 88vh;
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel-2));
  border: 2px solid var(--gc-line-3); border-radius: var(--gc-radius-lg);
  box-shadow: var(--gc-shadow);
}

/* Mode tabs that sit ABOVE the window, right-aligned, like folder tabs. The
   active one drops its bottom edge so it reads as continuous with the panel. */
.gp-toptabs {
  display: flex; gap: 6px; justify-content: flex-end;
  padding-right: 22px; margin-bottom: -2px; position: relative; z-index: 2;
}
.gp-toptab {
  padding: 9px 20px 10px; cursor: pointer;
  font-family: inherit; font-size: 12px; letter-spacing: 1px;
  color: var(--gc-ink-3);
  background: linear-gradient(180deg, var(--gc-panel-2), var(--gc-panel));
  border: 2px solid var(--gc-line-3); border-bottom: none;
  border-radius: var(--gc-radius) var(--gc-radius) 0 0;
  transform: translateY(2px);
  transition: background .12s, color .12s, transform .12s;
}
.gp-toptab:hover { background: #fffaec; color: var(--gc-ink); }
.gp-toptab.is-on {
  background: var(--gc-parch); color: var(--gc-title); font-weight: 700;
  transform: translateY(0);
  box-shadow: 0 -3px 10px -6px rgba(40,26,10,.6);
}
.gp-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 2px solid var(--gc-line-2);
  background: linear-gradient(180deg, var(--gc-panel), var(--gc-panel-2));
  border-radius: 10px 10px 0 0;
}
.gp-title {
  font-size: 15px; letter-spacing: 4px; text-transform: uppercase;
  color: var(--gc-title); font-weight: 700;
}
.gp-x {
  cursor: pointer; width: 32px; height: 30px; font-size: 16px; line-height: 1;
  border-radius: var(--gc-radius); border: 1px solid var(--gc-line-3);
  background: var(--gc-parch); color: var(--gc-ink);
}
.gp-x:hover { background: #fffaec; border-color: var(--gc-gold); }
.gp-body { padding: 16px 18px; overflow-y: auto; overflow-x: hidden; }
/* Actions sit bottom-RIGHT; any status text is pushed left of them. */
.gp-foot {
  padding: 12px 18px; border-top: 2px solid var(--gc-line-2);
  display: flex; justify-content: flex-end; align-items: center; gap: 14px;
  background: var(--gc-panel);
  border-radius: 0 0 10px 10px;
}
.gp-foot > .gp-pick { margin-right: auto; }

/* ── shared item chip ───────────────────────────────────────────────────── */
.gp-chip {
  width: 62px; height: 62px; flex: 0 0 auto; cursor: pointer; position: relative;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--gc-radius); border: 2px solid var(--gc-line);
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-sunk));
  transition: transform .12s, border-color .12s, box-shadow .12s, filter .12s;
}
.gp-chip img { width: 46px; height: 46px; object-fit: contain; }
.gp-chip:hover { transform: translateY(-2px); border-color: var(--gc-gold); }
.gp-chip.is-dim { filter: grayscale(.85) opacity(.4); cursor: default; }
.gp-chip.is-dim:hover { transform: none; border-color: var(--gc-line); }
.gp-chip.is-own { border-color: var(--gc-gold); box-shadow: 0 0 0 2px var(--gc-gold-soft); }
.gp-chip.r5 { border-color: var(--gc-r5); }
.gp-chip.r4 { border-color: var(--gc-r4); }
.gp-chip.r3 { border-color: var(--gc-r3); }

/* ── details ───────────────────────────────────────────────────────────── */
.gp-set { margin-bottom: 18px; }
.gp-set-name {
  font-size: 12px; letter-spacing: 3px; text-transform: uppercase;
  color: var(--gc-title); margin-bottom: 9px; padding-bottom: 6px;
  border-bottom: 1px solid var(--gc-line);
}
.gp-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.gp-cell { width: 104px; text-align: center; }
.gp-cell .gp-chip { width: 104px; height: 84px; }
.gp-cell .gp-chip img { width: 60px; height: 60px; }
.gp-cell-name { font-size: 10px; line-height: 1.25; margin-top: 4px; word-break: break-word; }

.gp-fold { margin-top: 8px; }
.gp-fold summary {
  cursor: pointer; font-size: 12px; letter-spacing: 2px; padding: 8px 0;
  color: var(--gc-ink-3);
}
.gp-note { font-size: 12px; color: var(--gc-ink-3); line-height: 1.65; margin-top: 12px; }
.gp-note b { color: var(--gc-ink); }
.gp-empty { font-size: 13px; color: var(--gc-ink-3); padding: 26px 0; text-align: center; }

/* ── shop ──────────────────────────────────────────────────────────────── */
/* Same coin art the shop, sell and refinement windows use, so Zenit reads the
   same everywhere. Icon only — never a "z" suffix. */
.gp-coin {
  width: 20px; height: 20px; object-fit: contain; vertical-align: middle;
  border: none !important; box-shadow: none !important; background: transparent;
}
.gp-coin.is-lg { width: 30px; height: 30px; }

.gp-coin.is-stash { width: 30px; height: 30px; }

/* Quantity row — icon, stepper, price. No prose. */
.gp-shoprow {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 12px 18px; border-radius: var(--gc-radius);
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel));
  border: 1px solid var(--gc-line-2);
}
.gp-coupon-icon {
  width: 46px; height: 46px; object-fit: contain; flex: 0 0 auto;
  border: none !important; box-shadow: none !important; background: transparent;
}
.gp-stepper { display: flex; align-items: center; gap: 8px; }
.gp-step {
  width: 30px; height: 30px; cursor: pointer; line-height: 1; font-size: 12px;
  border-radius: 50%; border: 1px solid var(--gc-line-3);
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel));
  color: var(--gc-ink-2);
}
.gp-step:hover { background: #fffaec; border-color: var(--gc-gold); }

/* Balances + action, one line. */
.gp-balances {
  display: flex; align-items: center; gap: 18px;
  padding: 14px 18px 2px;
}
.gp-bal {
  display: flex; align-items: center; gap: 8px;
  font-size: 22px; font-weight: 700; color: var(--gc-ink);
  font-variant-numeric: tabular-nums;
  transition: color .2s, opacity .2s;
}
.gp-bal[data-stash-box] { opacity: .5; }
.gp-bal[data-stash-box].is-tapped { opacity: 1; color: var(--gc-title); }
.gp-bal.is-spending { color: #a8412f; }
.gp-balances .gc-btn { margin-left: auto; }
/* Explicit and scoped: this panel is appended to document.body, so Foundry's
   global input rules apply and will otherwise take the field to 100%. */
#${PANEL_ID} input.gp-qty {
  width: 92px; flex: 0 0 auto; text-align: center;
  padding: 9px 10px; font-family: inherit; font-size: 15px;
  background: var(--gc-parch); color: var(--gc-ink);
  border: 1px solid var(--gc-line-3); border-radius: var(--gc-radius);
}
.gp-total {
  display: flex; align-items: center; gap: 5px; min-width: 96px;
  font-size: 17px; font-weight: 700; color: var(--gc-title);
  font-variant-numeric: tabular-nums;
}


/* ── exchange board ────────────────────────────────────────────────────── */
/* Bookmark rail down the left edge; the active tab merges into the board so it
   reads as a page tab rather than a button. */
.gp-exchange { display: flex; gap: 0; align-items: stretch; min-height: 460px; }
.gp-marks {
  flex: 0 0 200px; display: flex; flex-direction: column; gap: 5px;
  padding-right: 0; margin-right: -1px; z-index: 2;
}
.gp-mark {
  text-align: left; padding: 10px 12px; cursor: pointer;
  font-family: inherit; font-size: 11.5px; letter-spacing: .5px;
  color: var(--gc-ink-3);
  background: var(--gc-panel-2);
  border: 1px solid var(--gc-line-2);
  border-right-color: var(--gc-line-2);
  border-radius: var(--gc-radius) 0 0 var(--gc-radius);
  transition: background .12s, color .12s, transform .12s;
}
.gp-mark:hover { background: #fffaec; color: var(--gc-ink); transform: translateX(-3px); }
.gp-mark.is-active {
  background: var(--gc-parch); color: var(--gc-title); font-weight: 700;
  border-right-color: var(--gc-parch);
  transform: translateX(-5px);
}
.gp-mark .n { float: right; opacity: .6; font-weight: 400; }
.gp-mark.is-sep { margin-top: 10px; }

/* Fixed height, not content height: switching between a 3-piece and a 4-piece
   set was making the whole window jump. The rows scroll inside instead. */
.gp-board {
  flex: 1 1 auto; min-width: 0; padding: 14px 16px;
  display: flex; flex-direction: column; height: 468px;
  border: 1px solid var(--gc-line-2); border-radius: 0 var(--gc-radius) var(--gc-radius) var(--gc-radius);
  background: var(--gc-parch);
}
.gp-board-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 12px; padding-bottom: 7px;
  border-bottom: 1px solid var(--gc-line);
}
.gp-board-title {
  font-size: 12px; letter-spacing: 3px; text-transform: uppercase;
  color: var(--gc-title);
}
.gp-board-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 4px; }
.gp-redeem-name { align-self: center; font-size: 12px; color: var(--gc-ink-2); }

/* How many tickets the party HOLDS. Deliberately a footer badge rather than a
   caption under each row's ticket icon: sitting beneath the source chip it
   read as a PRICE ("this costs 2 tickets"), when every redemption costs one. */
.gp-ticketcount {
  display: flex; align-items: center; gap: 9px;
  padding: 6px 16px 6px 8px; border-radius: 999px;
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel));
  border: 1px solid var(--gc-gold);
  font-size: 20px; font-weight: 700; color: var(--gc-ink);
}
.gp-ticketcount img { width: 34px; height: 34px; object-fit: contain; }
.gp-chip.is-picked {
  border-color: var(--gc-title);
  box-shadow: 0 0 0 3px rgba(92,31,46,.22);
  transform: translateY(-2px);
}
.gp-pick {
  font-size: 12px; color: var(--gc-ink-2);
  display: flex; align-items: center; gap: 8px;
}
.gp-pick b { color: var(--gc-title); }
.gp-pick .none { color: var(--gc-ink-soft); font-style: italic; }

.gp-swaprow {
  display: flex; align-items: center; gap: 14px; padding: 10px 12px;
  border: 1px solid var(--gc-line); border-radius: var(--gc-radius);
  background: var(--gc-parch); margin-bottom: 8px;
}
.gp-swaprow.is-locked { background: var(--gc-sunk); opacity: .72; }
.gp-swaprow-src { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 96px; flex: 0 0 auto; }
.gp-swaprow-src .cap { font-size: 9px; color: var(--gc-ink-3); letter-spacing: 1px; }
.gp-arrow { flex: 0 0 auto; font-size: 20px; color: var(--gc-line-3); }
.gp-swaprow-dst { display: flex; gap: 8px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; }

/* One line, always. Wrapping a warning to three lines eats the panel. */
.gp-warn {
  flex: 1 1 100%; min-width: 0; margin-top: 6px;
  font-size: 11px; color: #8a4b16;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-warn.is-block { color: #7c2718; }

/* ── confirmation modal ────────────────────────────────────────────────── */
/* Ours, not Foundry's Dialog. A core dialog drops a grey Windows-ish frame in
   the middle of a parchment screen and breaks the illusion; this keeps every
   surface in the system on the same material. */
#${CONFIRM_ID} {
  position: fixed; inset: 0; z-index: 95; pointer-events: auto;
  background: rgba(30,20,8,.55); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  font-family: 'Lucida Console', 'Courier New', monospace; color: var(--gc-ink);
  animation: gp-fade .14s ease-out both;
}
#${CONFIRM_ID} * { box-sizing: border-box; }
#${CONFIRM_ID} img { border: 0 !important; outline: 0 !important; background: transparent; }
.gcf-frame {
  width: min(520px, 92vw); display: flex; flex-direction: column;
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel-2));
  border: 2px solid var(--gc-line-3); border-radius: var(--gc-radius-lg);
  box-shadow: var(--gc-shadow);
  animation: gcf-in .18s cubic-bezier(.2,.8,.3,1) both;
}
@keyframes gcf-in { from { opacity: 0; transform: scale(.95) translateY(8px); } }
.gcf-head {
  padding: 13px 18px; border-bottom: 2px solid var(--gc-line-2);
  background: linear-gradient(180deg, var(--gc-panel), var(--gc-panel-2));
  border-radius: 10px 10px 0 0;
  font-size: 13px; letter-spacing: 4px; text-transform: uppercase;
  color: var(--gc-title); font-weight: 700;
}
.gcf-body { padding: 16px 18px; }
.gcf-foot {
  padding: 12px 18px; border-top: 2px solid var(--gc-line-2);
  background: var(--gc-panel); border-radius: 0 0 10px 10px;
  display: flex; justify-content: flex-end; gap: 10px;
}

/* ── purchase confirmation body ────────────────────────────────────────── */
.gh-confirm { color: var(--gc-ink); }
.gh-head { font-size: 14px; margin-bottom: 10px; }
.gh-head b, .gh-line b { color: var(--gc-title); }
.gh-line {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 13px; padding: 4px 0;
}
.gh-line.is-stash { color: #8a4b16; }
.gh-confirm .gp-coin { width: 18px; height: 18px; object-fit: contain; vertical-align: middle; }
.gh-confirm .gp-coin.is-stash { width: 22px; height: 22px; }

.gh-hako {
  display: flex; align-items: flex-start; gap: 10px; margin-top: 14px;
}
.gh-hako-img {
  width: 92px; flex: 0 0 auto; object-fit: contain;
  border: 0 !important; background: transparent;
  filter: drop-shadow(0 4px 10px rgba(60,40,14,.4));
}
.gh-bubble {
  position: relative; flex: 1 1 auto;
  padding: 11px 14px; border-radius: 10px;
  background: var(--gc-parch); border: 2px solid var(--gc-line-3);
  font-size: 12px; line-height: 1.6; color: var(--gc-ink);
}
.gh-bubble b { color: var(--gc-title); }
/* Tail pointing back at Hako. */
.gh-bubble::before,
.gh-bubble::after {
  content: ""; position: absolute; top: 22px; width: 0; height: 0;
  border-style: solid;
}
.gh-bubble::before {
  left: -12px; border-width: 8px 12px 8px 0;
  border-color: transparent var(--gc-line-3) transparent transparent;
}
.gh-bubble::after {
  left: -9px; border-width: 6px 10px 6px 0;
  border-color: transparent var(--gc-parch) transparent transparent;
}

/* ── tooltip ───────────────────────────────────────────────────────────── */
#${TIP_ID} {
  position: fixed; z-index: 90; pointer-events: none;
  padding: 8px 12px; max-width: 280px;
  border-radius: var(--gc-radius); border: 1px solid var(--gc-line-3);
  background: var(--gc-parch); color: var(--gc-ink);
  box-shadow: 0 10px 26px -12px rgba(40,26,10,.8);
  font-family: 'Lucida Console', 'Courier New', monospace; font-size: 12px;
  opacity: 0; transition: opacity .1s;
}
#${TIP_ID}.is-on { opacity: 1; }
#${TIP_ID} .t { font-weight: 700; margin-bottom: 3px; }
#${TIP_ID} .s { font-size: 10.5px; color: var(--gc-ink-3); letter-spacing: 1px; text-transform: uppercase; }
`;

function ensureStyle() {
  ensureTheme();
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

// ── Confirmation modal ──────────────────────────────────────────────────────

/**
 * A yes/no gate in the system's own material.
 *
 * Replaces Dialog.confirm everywhere in the gacha system: a core Foundry dialog
 * drops a grey application frame into the middle of a parchment screen, which
 * breaks the illusion at exactly the moment the player is being asked to commit
 * to something irreversible.
 *
 * @returns {Promise<boolean>}
 */
function confirmModal({ title, body, yes = "Confirm", no = "Cancel" }) {
  ensureStyle();
  document.getElementById(CONFIRM_ID)?.remove();

  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.id = CONFIRM_ID;
    el.innerHTML = `
      <div class="gcf-frame">
        <div class="gcf-head">${esc(title)}</div>
        <div class="gcf-body">${body}</div>
        <div class="gcf-foot">
          <button class="gc-btn" data-no>${esc(no)}</button>
          <button class="gc-btn is-primary" data-yes>${esc(yes)}</button>
        </div>
      </div>`;

    document.body.appendChild(el);

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey, true);
      el.remove();
      resolve(v);
    };

    // The panel underneath also listens for Escape on window. Capture phase
    // alone is not enough: a listener registered on window still fires
    // AT_TARGET for anything dispatched directly at window, where phase no
    // longer orders them. stopImmediatePropagation covers both cases, so
    // Escape dismisses this prompt without closing the panel behind it.
    const onKey = (ev) => {
      if (ev.key !== "Escape" && ev.key !== "Enter") return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      done(ev.key === "Enter");
    };
    window.addEventListener("keydown", onKey, true);

    el.addEventListener("click", (ev) => { if (ev.target === el) done(false); });
    el.querySelector("[data-no]").addEventListener("click", () => done(false));
    el.querySelector("[data-yes]").addEventListener("click", () => done(true));
    el.querySelector("[data-yes]").focus();
  });
}

export function closeConfirm() { document.getElementById(CONFIRM_ID)?.remove(); }

let _ctx = null;

// ── Tooltip ─────────────────────────────────────────────────────────────────

function tipEl() {
  let t = document.getElementById(TIP_ID);
  if (!t) {
    t = document.createElement("div");
    t.id = TIP_ID;
    document.body.appendChild(t);
  }
  return t;
}

/** Wire every [data-tip] under root to the shared floating tooltip. */
function bindTips(root) {
  const t = tipEl();
  root.querySelectorAll("[data-tip]").forEach((n) => {
    n.addEventListener("mouseenter", () => {
      t.innerHTML = `<div class="t">${esc(n.dataset.tip)}</div>` +
                    (n.dataset.tipSub ? `<div class="s">${esc(n.dataset.tipSub)}</div>` : "");
      t.classList.add("is-on");
    });
    n.addEventListener("mousemove", (ev) => {
      const pad = 16;
      const w = t.offsetWidth, h = t.offsetHeight;
      t.style.left = `${Math.min(window.innerWidth - w - pad, ev.clientX + pad)}px`;
      t.style.top  = `${Math.max(pad, ev.clientY - h - pad)}px`;
    });
    n.addEventListener("mouseleave", () => t.classList.remove("is-on"));
  });
}

const hideTip = () => document.getElementById(TIP_ID)?.classList.remove("is-on");

// ── Frame ───────────────────────────────────────────────────────────────────

export function closePanel() {
  document.getElementById(PANEL_ID)?.remove();
  hideTip();
  if (_ctx?.onKey) window.removeEventListener("keydown", _ctx.onKey);
  _ctx = null;
}

function frame(title, bodyHTML, { width = 900, foot = "", topTabs = "" } = {}) {
  closePanel();
  ensureStyle();

  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.innerHTML = `
    <div class="gp-stack" style="--gp-w:${width}px">
      ${topTabs ? `<div class="gp-toptabs">${topTabs}</div>` : ""}
      <div class="gp-frame" style="--gp-w:${width}px">
        <div class="gp-head">
          <div class="gp-title">${esc(title)}</div>
          <button class="gp-x" data-close>×</button>
        </div>
        <div class="gp-body">${bodyHTML}</div>
        ${foot ? `<div class="gp-foot">${foot}</div>` : ""}
      </div>
    </div>`;

  document.body.appendChild(el);
  el.addEventListener("click", (ev) => { if (ev.target === el) closePanel(); });
  el.querySelector("[data-close]").addEventListener("click", closePanel);

  const onKey = (ev) => { if (ev.key === "Escape") closePanel(); };
  window.addEventListener("keydown", onKey);
  _ctx = { onKey };

  return el.querySelector(".gp-body");
}

function bindFallbacks(root) {
  root.querySelectorAll("img").forEach((img) =>
    img.addEventListener("error", () => { img.src = FALLBACK_IMG; }, { once: true })
  );
}

// ── Router ──────────────────────────────────────────────────────────────────

export async function renderPanel(kind, ctx) {
  if (kind === "details")  return details(ctx);
  if (kind === "shop" || kind === "buy") return shop(ctx);
  if (kind === "exchange") return exchange(ctx);
}

// ── Details ─────────────────────────────────────────────────────────────────

function cellHTML(e, rarityKey) {
  const c = RARITY[rarityKey];
  const type = String(e.item?.system?.props?.item_type ?? "").trim();
  return `
    <div class="gp-cell">
      <div class="gp-chip r${c.stars}" data-uuid="${e.uuid}"
           data-tip="${esc(e.name)}" data-tip-sub="${esc([type, c.label].filter(Boolean).join(" · "))}">
        <img src="${imgOf(e)}" alt="">
      </div>
      <div class="gp-cell-name">${esc(e.name)}</div>
    </div>`;
}

function details({ banner }) {
  if (!banner) return;
  const sets = groupBySet(banner.entries).filter((g) => g.setName !== "—");

  const poolHTML = (key, label) => {
    const t = getPoolTable(key);
    const entries = t ? resolveTableItems(t) : [];
    if (!entries.length) return "";
    return `
      <details class="gp-fold" open>
        <summary>${label} pool — ${entries.length} items</summary>
        <div class="gp-grid" style="margin-top:10px">
          ${entries.sort((a, b) => a.name.localeCompare(b.name)).map((e) => cellHTML(e, key)).join("")}
        </div>
      </details>`;
  };

  const body = frame(`${banner.title} — Contents`, `
    ${sets.map((g) => `
      <div class="gp-set">
        <div class="gp-set-name">
          ${RARITY.five.label} · ${esc(g.setName)}${g === banner.mainSet ? " — featured" : ""}
        </div>
        <div class="gp-grid">${g.entries.map((e) => cellHTML(e, "five")).join("")}</div>
      </div>`).join("")}
    ${poolHTML("four", RARITY.four.label)}
    ${poolHTML("three", RARITY.three.label)}
    <div class="gp-note">
      Pieces are grouped by set. The Gift Exchange trades any piece for another
      <b>in the same set</b> — sets never cross, even when they share a banner.
    </div>`, { width: 940 });

  body.querySelectorAll("[data-uuid]").forEach((n) =>
    n.addEventListener("click", async () => {
      const doc = await fromUuid(n.dataset.uuid).catch(() => null);
      doc?.sheet?.render(true);
    })
  );
  bindTips(body);
  bindFallbacks(body);
}

// ── Shop ────────────────────────────────────────────────────────────────────

async function shop({ state, refresh }) {
  const buyer = game.user?.character;
  const party = state?.actor ?? null;
  const cost  = state.cost;

  if (!buyer) {
    frame("Buy Hako Coupons", `
      <div class="gp-empty">
        No character is assigned to this client, so there is no Zenit to spend.
      </div>`, { width: 460 });
    return;
  }

  const couponImg = game.items?.get(COUPON_ITEM_UUID.replace(/^Item\./, ""))?.img ?? FALLBACK_IMG;

  // Local mirrors so both readouts can move the instant a purchase lands.
  let purse = Math.max(0, Number(buyer.system?.props?.zenit ?? 0));
  let stash = Math.max(0, Number(party?.system?.props?.zenit ?? 0));

  const body = frame("Buy Hako Coupons", `
    <div class="gp-shoprow">
      <img class="gp-coupon-icon" src="${couponImg}" alt="">
      <div class="gp-stepper">
        <button class="gp-step" data-step="-1">&#9664;</button>
        <input class="gp-qty" type="number" min="1" max="99" value="2" data-qty>
        <button class="gp-step" data-step="1">&#9654;</button>
      </div>
      <span class="gp-total">${COIN_ICON}<span data-total>${(cost * 2).toLocaleString()}</span></span>
    </div>

    <div class="gp-balances">
      <span class="gp-bal" data-purse-box>${COIN_ICON}<span data-purse>${purse.toLocaleString()}</span></span>
      <span class="gp-bal" data-stash-box>${STASH_ICON}<span data-stash>${stash.toLocaleString()}</span></span>
      <button class="gc-btn is-primary" data-confirm>Purchase</button>
    </div>`, { width: 520 });

  const root     = body.closest(".gp-frame");
  const qty      = root.querySelector("[data-qty]");
  const totalN   = root.querySelector("[data-total]");
  const purseN   = root.querySelector("[data-purse]");
  const stashN   = root.querySelector("[data-stash]");
  const purseBox = root.querySelector("[data-purse-box]");
  const stashBox = root.querySelector("[data-stash-box]");
  const confirm  = root.querySelector("[data-confirm]");

  const amount = () => Math.max(1, Math.min(99, Math.floor(Number(qty.value) || 1)));

  const sync = () => {
    const n = amount();
    qty.value = n;
    const total = cost * n;
    totalN.textContent = total.toLocaleString();

    // Preview which purses this would touch, so the split is visible before
    // the confirmation rather than only inside it.
    const fromBuyer = Math.min(purse, total);
    const fromStash = total - fromBuyer;
    stashBox.classList.toggle("is-tapped", fromStash > 0);
    confirm.disabled = fromStash > stash;
  };

  qty.addEventListener("input", sync);
  root.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => {
      qty.value = amount() + Number(b.dataset.step);
      sync();
      window.FUCompanion?.shopSound?.playItemSelect?.();
    })
  );
  sync();

  confirm.addEventListener("click", async () => {
    const n = amount();
    const total = cost * n;
    const fromBuyer = Math.min(purse, total);
    const fromStash = total - fromBuyer;

    const ok = await confirmPurchase({ n, total, fromBuyer, fromStash, buyerName: buyer.name });
    if (!ok) return;

    const label = confirm.textContent;
    confirm.disabled = true;
    confirm.textContent = "Buying…";

    const res = await request(GACHA.MSG.BUY_REQ, {
      buyerActorUuid: buyer.uuid, quantity: n, requesterUserId: game.user.id,
    });

    confirm.textContent = label;

    if (res?.ok) {
      window.FUCompanion?.shopSound?.playPurchase();

      const p0 = purse, s0 = stash;
      purse = Math.max(0, purse - (res.fromBuyer ?? 0));
      stash = Math.max(0, stash - (res.fromStash ?? 0));

      rollNumber(purseN, p0, purse, 620);
      if (s0 !== stash) rollNumber(stashN, s0, stash, 620);

      purseBox.classList.add("is-spending");
      if (s0 !== stash) stashBox.classList.add("is-spending");
      setTimeout(() => {
        purseBox.classList.remove("is-spending");
        stashBox.classList.remove("is-spending");
      }, 700);

      ui.notifications?.info(`Bought ${res.quantity} coupon(s) for ${res.totalCost}z.`);
      refresh?.(res.pool);
      sync();
      return;
    }

    ui.notifications?.warn(buyFailureText(res, cost, n));
    sync();
  });
}

/**
 * Second gate before any Zenit moves.
 *
 * When the party stash is being tapped, Hako turns up to say so. A split
 * payment spends money that is not only the buyer's, and that deserves more
 * than a number quietly changing colour.
 */
async function confirmPurchase({ n, total, fromBuyer, fromStash, buyerName }) {
  const lines = fromStash > 0
    ? `<div class="gh-line">${esc(buyerName)} pays ${COIN_ICON}<b>${fromBuyer.toLocaleString()}</b></div>
       <div class="gh-line is-stash">Party stash pays ${STASH_ICON}<b>${fromStash.toLocaleString()}</b></div>`
    : `<div class="gh-line">${esc(buyerName)} pays ${COIN_ICON}<b>${fromBuyer.toLocaleString()}</b></div>`;

  const hako = fromStash > 0 ? `
    <div class="gh-hako">
      <img class="gh-hako-img" src="${HAKO_SRC}" alt="Hako">
      <div class="gh-bubble">
        Ahh ― looks like that's more than you can afford, Hako will take the
        rest from the <b>party's</b> purse, yes? Everyone shares in the fortune!
      </div>
    </div>` : "";

  return confirmModal({
    title: "Confirm Purchase",
    yes: "Purchase",
    body: `
      <div class="gh-confirm">
        <div class="gh-head">Buy <b>${n}</b> Hako Coupon${n === 1 ? "" : "s"}
          for ${COIN_ICON}<b>${total.toLocaleString()}</b>?</div>
        ${lines}
        ${hako}
      </div>`,
  });
}

/** Human-readable purchase failures, mirroring the main shop's message map. */
function buyFailureText(res, cost, n) {
  switch (res?.reason) {
    case "insufficient_funds":
      return `Not enough Zenit — need ${res.needed ?? cost * n}, have ${res.have ?? 0} between purse and stash.`;
    case "buyer_not_found":         return "Your character could not be resolved.";
    case "party_actor_missing":     return "The party sheet could not be resolved.";
    case "coupon_template_missing": return "The Hako Coupon item is missing from the world.";
    case "transfer_core_missing":   return "Item transfer system is not ready yet.";
    case "not_primary_gm":          return "No GM is available to process the purchase.";
    case "timeout":                 return "Purchase timed out — is the GM online?";
    default:                        return `Purchase failed (${res?.reason ?? "unknown"}).`;
  }
}

// ── Exchange ────────────────────────────────────────────────────────────────

/**
 * The Exchange window.
 *
 * Navigation is a bookmark rail down the left: one mark per gacha set, then
 * Ticket Redemption at the bottom. The body shows one thing at a time.
 *
 * Trading is deliberately two-step — pick a target, then press Exchange, then
 * confirm. The previous build committed the moment you clicked an icon, which
 * is far too easy a way to destroy a refined piece by accident.
 */
async function exchange(ctx) {
  const board = await listSetBoard();
  const ticket = ticketEntry();

  const body = frame("Exchange", `
    <div class="gp-exchange">
      <div class="gp-marks"></div>
      <div class="gp-board"><div class="gp-empty">Loading…</div></div>
    </div>`, {
      width: 1020,
      topTabs: `
        <button class="gp-toptab" data-mode="swap">Gift Exchange</button>
        <button class="gp-toptab" data-mode="redeem">Redeem Ticket</button>`,
      foot: `<div class="gp-pick" data-pick></div>
             <div class="gp-ticketcount" data-ticketcount hidden></div>
             <button class="gc-btn is-primary" data-exchange disabled>Exchange</button>`,
    });

  const stack  = body.closest(".gp-stack");
  const root   = body.closest(".gp-frame");
  const marks  = body.querySelector(".gp-marks");
  const board_ = body.querySelector(".gp-board");
  const pickEl  = root.querySelector("[data-pick]");
  const countEl = root.querySelector("[data-ticketcount]");
  const goBtn   = root.querySelector("[data-exchange]");

  // MODE and SET are separate axes. Folding them into one field made "which set
  // am I looking at" unanswerable while redeeming — which is precisely what the
  // redeem board needs to know.
  const S = { mode: "swap", set: board[0]?.setName ?? null, src: null, dst: null, dstUuid: null };

  const currentSet = () => board.find((s) => s.setName === S.set) ?? board[0] ?? null;
  const tickets = () => ctx?.state?.pool?.tickets ?? 0;
  const clearPick = () => { S.src = S.dst = S.dstUuid = null; };

  stack.querySelectorAll("[data-mode]").forEach((t) =>
    t.addEventListener("click", () => {
      if (S.mode === t.dataset.mode) return;
      S.mode = t.dataset.mode;
      clearPick();
      paint();
    })
  );

  const paintMarks = () => {
    marks.innerHTML = board.map((s) => `
      <button class="gp-mark${S.set === s.setName ? " is-active" : ""}" data-view="${esc(s.setName)}">
        ${esc(s.setName)}<span class="n">${
          S.mode === "redeem" ? s.pieces.length : `${s.ownedCount}/${s.pieces.length}`
        }</span>
      </button>`).join("");
    marks.querySelectorAll("[data-view]").forEach((n) =>
      n.addEventListener("click", () => { S.set = n.dataset.view; clearPick(); paint(); })
    );
  };

  const paintFoot = () => {
    const redeeming = S.mode === "redeem";
    goBtn.textContent = redeeming ? "Redeem" : "Exchange";
    goBtn.disabled = redeeming ? !(S.dstUuid && tickets() > 0) : !(S.src && S.dst);

    countEl.hidden = !redeeming;
    if (redeeming) {
      countEl.innerHTML = `<img src="${ticket.img}" alt=""> ${tickets()}`;
    }

    if (redeeming) {
      pickEl.innerHTML = tickets() < 1
        ? `<span class="none">No tickets. They are handed out for events and holidays.</span>`
        : S.dst
          ? `Redeem <b>1 ${esc(TICKET_NAME)}</b> → <b>${esc(S.dst)}</b>`
          : `<span class="none">Select the piece you want to receive.</span>`;
      return;
    }
    pickEl.innerHTML = S.src && S.dst
      ? `Trade <b>${esc(S.src)}</b> → <b>${esc(S.dst)}</b>`
      : `<span class="none">Select the piece you want to receive.</span>`;
  };

  const paint = () => {
    paintMarks();
    stack.querySelectorAll("[data-mode]").forEach((t) =>
      t.classList.toggle("is-on", t.dataset.mode === S.mode)
    );

    const set = currentSet();
    const redeeming = S.mode === "redeem";

    board_.innerHTML = `
      <div class="gp-board-head">
        <div class="gp-board-title">${
          redeeming
            ? `${esc(set?.setName ?? "")} — ${tickets()} ticket${tickets() === 1 ? "" : "s"} held`
            : `${esc(set?.setName ?? "")} — ${set?.ownedCount ?? 0} of ${set?.pieces.length ?? 0} held`
        }</div>
      </div>
      <div class="gp-board-scroll"></div>`;

    const scroll = board_.querySelector(".gp-board-scroll");
    if (redeeming) paintRedeemBoard(scroll, set, S, ticket, tickets(), paintFoot);
    else paintSwapBoard(scroll, set, S, paintFoot);

    paintFoot();
  };

  goBtn.addEventListener("click", async () => {
    const set = currentSet();

    // ── Ticket redemption ────────────────────────────────────────────────
    if (S.mode === "redeem") {
      if (!S.dstUuid) return;
      const ok = await confirmModal({
        title: "Redeem Ticket",
        yes: "Redeem",
        body: `<div class="gh-confirm">
                 <div class="gh-head">Spend one <b>${esc(TICKET_NAME)}</b>
                   on <b>${esc(S.dst)}</b>?</div>
               </div>`,
      });
      if (!ok) return;

      goBtn.disabled = true;
      const res = await request(GACHA.MSG.REDEEM_REQ, {
        targetItemUuid: S.dstUuid, requesterUserId: game.user.id,
      });

      if (res?.ok) {
        ui.notifications?.info(`Redeemed → ${res.itemName}.`);
        ctx?.refresh?.(res.pool);
        closePanel();
        renderPanel("exchange", ctx);
      } else {
        ui.notifications?.warn(`Redemption failed: ${res?.reason ?? "unknown"}`);
        paintFoot();
      }
      return;
    }

    // ── Gift Exchange ────────────────────────────────────────────────────
    const src = set?.pieces.find((p) => p.name === S.src);
    const dst = set?.pieces.find((p) => p.name === S.dst);
    if (!src?.owned || !dst) return;

    const extra = src.owned.warnings?.length
      ? `<div class="gh-line is-stash">${src.owned.warnings.map(esc).join("<br>")}</div>` : "";

    const ok = await confirmModal({
      title: "Confirm Exchange",
      yes: "Exchange",
      body: `
        <div class="gh-confirm">
          <div class="gh-head">Trade <b>${esc(src.name)}</b> for <b>${esc(dst.name)}</b>?</div>
          ${extra}
          <div class="gh-line is-stash">
            “${esc(src.name)}” will be <b>destroyed permanently</b>. This cannot be undone.
          </div>
        </div>`,
    });
    if (!ok) return;

    goBtn.disabled = true;
    const res = await request(GACHA.MSG.SWAP_REQ, {
      ownerActorUuid: src.owned.ownerActorUuid,
      itemId: src.owned.itemId,
      targetItemUuid: dst.uuid,
      confirmed: true,
      requesterUserId: game.user.id,
    });

    if (res?.ok) {
      ui.notifications?.info(`Traded ${res.from} → ${res.to}.`);
      closePanel();
      renderPanel("exchange", ctx);      // reopen on fresh state
    } else {
      ui.notifications?.warn(`Trade failed: ${res?.reason ?? "unknown"}`);
      paintFoot();
    }
  });

  if (!board.length) { board_.innerHTML = `<div class="gp-empty">No gacha sets found.</div>`; return; }
  paint();
}

/** The 5-Star Exchange Ticket, as a display entry. */
function ticketEntry() {
  const id = TICKET_ITEM_UUID.replace(/^Item\./, "");
  const it = game.items?.get(id) ?? null;
  return { name: it?.name ?? TICKET_NAME, img: it?.img ?? FALLBACK_IMG, uuid: it?.uuid ?? TICKET_ITEM_UUID };
}

/**
 * Redemption, laid out like the Gift Exchange board: browsed by set, one row
 * per piece — but the row's source is always the ticket rather than something
 * the party holds.
 */
function paintRedeemBoard(host, set, S, ticket, tickets, onPick) {
  if (!set) { host.innerHTML = `<div class="gp-empty">Set not found.</div>`; return; }
  const live = tickets > 0;

  host.innerHTML = set.pieces.map((p) => `
    <div class="gp-swaprow${live ? "" : " is-locked"}">
      <div class="gp-swaprow-src">
        <div class="gp-chip${live ? " is-own" : " is-dim"}"
             data-tip="${esc(ticket.name)}"
             data-tip-sub="${esc(live ? "costs one ticket" : "none held")}">
          <img src="${ticket.img}" alt="">
        </div>
      </div>
      <div class="gp-arrow">→</div>
      <div class="gp-swaprow-dst">
        <div class="gp-chip r5${live ? "" : " is-dim"}${S.dst === p.name ? " is-picked" : ""}"
             ${live ? `data-redeem="${esc(p.name)}" data-uuid="${p.uuid}"` : ""}
             data-tip="${esc(p.name)}"
             data-tip-sub="${esc(live ? "redeem a ticket for this" : "no tickets held")}">
          <img src="${p.img}" alt="">
        </div>
        <div class="gp-redeem-name">${esc(p.name)}</div>
      </div>
    </div>`).join("");

  host.querySelectorAll("[data-redeem]").forEach((n) =>
    n.addEventListener("click", () => {
      const same = S.dst === n.dataset.redeem;
      host.querySelectorAll(".gp-chip").forEach((c) => c.classList.remove("is-picked"));
      if (same) { S.dst = null; S.dstUuid = null; }
      else { S.dst = n.dataset.redeem; S.dstUuid = n.dataset.uuid; n.classList.add("is-picked"); }
      onPick?.();
    })
  );

  bindTips(host);
  bindFallbacks(host);
}

function paintSwapBoard(host, set, S, onPick) {
  if (!set) { host.innerHTML = `<div class="gp-empty">Set not found.</div>`; return; }

  // No standing rules blurb. The destructive terms are shown on the pieces they
  // actually apply to (and again on the confirm dialog), the same way the
  // equipped block is — a permanent notice reads as chrome and gets ignored.
  host.innerHTML = set.pieces.map((p) => rowHTML(set, p, S)).join("");

  host.querySelectorAll("[data-pick-src]").forEach((n) =>
    n.addEventListener("click", () => {
      const same = S.src === n.dataset.pickSrc && S.dst === n.dataset.pickDst;
      host.querySelectorAll(".gp-chip").forEach((c) => c.classList.remove("is-picked"));

      if (same) {            // clicking the current pick clears it
        S.src = S.dst = null;
      } else {
        S.src = n.dataset.pickSrc;
        S.dst = n.dataset.pickDst;
        n.classList.add("is-picked");
      }
      onPick?.();
    })
  );

  bindTips(host);
  bindFallbacks(host);
}

function rowHTML(set, piece, S) {
  const owned = piece.owned;
  const blocked = owned?.blocking?.length ? owned.blocking[0] : "";
  const warned  = owned?.warnings?.length ? owned.warnings.join(" ") : "";
  const live = owned && !blocked;
  const targets = set.pieces.filter((t) => t.name !== piece.name);

  return `
    <div class="gp-swaprow${owned ? "" : " is-locked"}">
      <div class="gp-swaprow-src">
        <div class="gp-chip${owned ? " is-own" : " is-dim"}"
             data-tip="${esc(piece.name)}"
             data-tip-sub="${esc(owned ? `held by ${owned.ownerName}` : "not owned")}">
          <img src="${piece.img}" alt="">
        </div>
        <div class="cap">${owned ? esc(owned.ownerName) : "NOT OWNED"}</div>
      </div>
      <div class="gp-arrow">→</div>
      <div class="gp-swaprow-dst">
        ${targets.map((t) => {
          const picked = S?.src === piece.name && S?.dst === t.name;
          return `
          <div class="gp-chip${live ? "" : " is-dim"}${picked ? " is-picked" : ""}"
               ${live ? `data-pick-src="${esc(piece.name)}" data-pick-dst="${esc(t.name)}"` : ""}
               data-tip="${esc(t.name)}"
               data-tip-sub="${esc(live ? `receive this for ${piece.name}` : "unavailable")}">
            <img src="${t.img}" alt="">
          </div>`;
        }).join("")}
        ${blocked ? `<div class="gp-warn is-block">⛔ ${esc(blocked)}</div>`
                  : warned ? `<div class="gp-warn">⚠ ${esc(warned)}</div>` : ""}
      </div>
    </div>`;
}

