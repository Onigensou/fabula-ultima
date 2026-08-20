// ============================================================================
// Gacha System — Overlay shell
// ----------------------------------------------------------------------------
// The screen itself: banner tabs, featured art, currency counters, the wish
// buttons and the three panels (Details / Shop / Exchange).
//
// Opens for EVERYONE standing on a gacha-mode scene, because spectating is the
// point of a gacha screen. Only party-member clients get the interactive
// controls — a spectator sees the counters, the banners and every animation,
// but no button they cannot press. That split (participation is gated,
// visibility is not) is the house rule for every system here.
//
// Banner selection is LOCAL view state. The old system stored one global
// `gacha_banner` on the database actor and round-tripped a socket to the GM to
// change it, which meant one player switching banners silently switched it for
// everybody. A wish request carries its own bannerId instead, so two players
// can browse different banners at once.
// ============================================================================

import { GACHA, RARITY, PITY_FIVE, log } from "./gacha-const.js";
import { listBanners } from "./gacha-banners.js";
import { partyActor, readPool, readPity, isPartyMemberClient, couponCost } from "./gacha-state.js";
import { request } from "./gacha-net.js";
import { renderPanel } from "./gacha-panels.js";

const ROOT_ID  = "gacha-ui";
const STYLE_ID = "gacha-ui-style";

const CSS = `
#${ROOT_ID} {
  position: fixed; inset: 0; z-index: 60;
  pointer-events: none;
  font-family: 'Lucida Console', 'Courier New', monospace;
  color: #e9edf7; user-select: none;
}
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .gu-on { pointer-events: auto; }

/* ── tabs ───────────────────────────────────────────────────────────────── */
.gu-tabs {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 8px; padding: 6px;
  background: rgba(8,10,20,.55); border-radius: 10px;
  backdrop-filter: blur(3px);
}
.gu-tab {
  width: 92px; height: 58px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(150,165,200,.28);
  background: rgba(20,24,38,.75) center/cover no-repeat;
  position: relative; overflow: hidden;
  transition: border-color .14s, box-shadow .14s, transform .14s;
}
.gu-tab:hover { transform: translateY(-2px); border-color: rgba(220,200,140,.7); }
.gu-tab.is-active {
  border-color: #e6c060;
  box-shadow: 0 0 16px -2px rgba(230,192,96,.65), inset 0 0 20px -8px rgba(230,192,96,.8);
}
.gu-tab-label {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 4px;
  font-size: 9px; line-height: 1.15; text-align: center;
  background: linear-gradient(to top, rgba(0,0,0,.88), transparent);
  text-shadow: 0 1px 2px #000;
}

/* ── currency ───────────────────────────────────────────────────────────── */
.gu-wallet {
  position: absolute; top: 18px; right: 20px;
  display: flex; gap: 10px; align-items: center;
}
.gu-coin {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 13px 6px 8px; border-radius: 999px;
  background: rgba(8,10,20,.72); border: 1px solid rgba(150,165,200,.3);
  font-size: 14px; letter-spacing: 1px;
}
.gu-coin img {
  width: 24px; height: 24px; object-fit: contain;
  border: 0 !important; outline: 0 !important; background: transparent;
}
.gu-coin.is-ticket { border-color: rgba(230,192,96,.5); color: #f2d98a; }
.gu-buy {
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
  border: 1px solid rgba(150,165,200,.45); background: rgba(30,36,56,.9);
  color: #dfe6f5; font-size: 15px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  transition: background .14s, border-color .14s;
}
.gu-buy:hover { background: rgba(58,70,104,.95); border-color: #e6c060; color: #ffe9a8; }

/* ── pity ───────────────────────────────────────────────────────────────── */
.gu-pity {
  position: absolute; top: 84px; right: 20px;
  font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
  color: rgba(200,210,232,.7); text-align: right;
  text-shadow: 0 1px 4px rgba(0,0,0,.9);
}
.gu-pity b { color: #f2d98a; font-weight: 600; }

/* ── actions ────────────────────────────────────────────────────────────── */
.gu-actions {
  position: absolute; right: 26px; bottom: 30px;
  display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
}
.gu-wish {
  min-width: 232px; padding: 11px 22px; cursor: pointer;
  border-radius: 999px; border: 1px solid rgba(226,196,120,.55);
  background: linear-gradient(180deg, rgba(84,62,26,.95), rgba(52,38,16,.95));
  color: #ffeec0; font-family: inherit; font-size: 13px; letter-spacing: 3px;
  text-transform: uppercase; text-align: center;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  transition: filter .14s, transform .14s, box-shadow .14s;
  text-shadow: 0 1px 3px rgba(0,0,0,.85);
}
.gu-wish:hover:not(.is-off) {
  filter: brightness(1.18); transform: translateY(-1px);
  box-shadow: 0 0 20px -4px rgba(230,192,96,.6);
}
.gu-wish.is-off { opacity: .38; cursor: default; filter: grayscale(.6); }
.gu-wish small {
  font-size: 11px; letter-spacing: 1px; text-transform: none;
  opacity: .85; display: flex; align-items: center; gap: 4px;
}
.gu-wish small img {
  width: 15px; height: 15px; border: 0 !important; outline: 0 !important;
  background: transparent;
}

/* ── nav ────────────────────────────────────────────────────────────────── */
.gu-nav { position: absolute; left: 26px; bottom: 30px; display: flex; gap: 8px; }
.gu-nav-btn {
  padding: 9px 18px; cursor: pointer; border-radius: 6px;
  border: 1px solid rgba(150,165,200,.32); background: rgba(10,13,24,.78);
  color: #d6ddee; font-family: inherit; font-size: 11px; letter-spacing: 2px;
  text-transform: uppercase; transition: background .14s, border-color .14s, color .14s;
}
.gu-nav-btn:hover { background: rgba(40,50,76,.9); border-color: #9fb0d4; color: #fff; }

/* ── banner art ─────────────────────────────────────────────────────────── */
.gu-stage {
  position: absolute; inset: 88px 26px 92px 26px;
  display: flex; align-items: center; justify-content: center;
}
.gu-art {
  max-width: 100%; max-height: 100%; object-fit: contain;
  border: 0 !important; outline: 0 !important; background: transparent;
  filter: drop-shadow(0 10px 30px rgba(0,0,0,.6));
  animation: gu-in .32s ease-out both;
}
.gu-sets {
  position: absolute; left: 26px; top: 92px;
  font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
  color: rgba(200,210,232,.72); text-shadow: 0 1px 4px rgba(0,0,0,.9);
  line-height: 1.7;
}
@keyframes gu-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }

.gu-toast {
  position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%);
  padding: 9px 18px; border-radius: 6px; font-size: 12px; letter-spacing: 1px;
  background: rgba(10,13,24,.92); border: 1px solid rgba(150,165,200,.35);
  animation: gu-in .18s ease-out both;
}
.gu-toast.is-bad { border-color: rgba(220,110,110,.7); color: #ffc9c9; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ── State ───────────────────────────────────────────────────────────────────

const S = {
  el: null,
  banners: [],
  bannerId: null,
  actor: null,
  canPlay: false,
  pool: { coupons: 0, tickets: 0 },
  cost: 200,
  busy: false,
};

// ── Open / close ────────────────────────────────────────────────────────────

export async function open() {
  if (S.el) return;

  S.actor = await partyActor();
  if (!S.actor) return;

  S.banners = listBanners();
  if (!S.banners.length) {
    ui.notifications?.warn("Gacha: no banner tables found.");
    return;
  }

  S.bannerId = S.banners[0].id;
  // Party members participate; spectators watch. A GM is not a party member but
  // still needs the controls to demo, test and roll on the table's behalf.
  S.canPlay  = isPartyMemberClient(S.actor) || game.user.isGM;
  S.pool     = readPool(S.actor);
  S.cost     = await couponCost();

  ensureStyle();
  S.el = document.createElement("div");
  S.el.id = ROOT_ID;
  document.body.appendChild(S.el);

  render();
  log("Overlay open —", S.canPlay ? "participant" : "spectator");
}

export function close() {
  S.el?.remove();
  S.el = null;
  S.busy = false;
}

export const isOpen = () => !!S.el;

/** Party actor id, so hooks can scope themselves to documents that matter. */
export const partyActorId = () => S.actor?.id ?? null;

/** Called by the socket layer when the pool changes anywhere. */
export function refreshPool(pool) {
  if (pool) S.pool = pool;
  else if (S.actor) S.pool = readPool(S.actor);
  if (S.el) render();
}

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
  if (!S.el) return;

  const banner = S.banners.find((b) => b.id === S.bannerId) ?? S.banners[0];
  const pity = readPity(S.actor, banner.id);
  const remaining = Math.max(0, PITY_FIVE - pity.five);

  const couponImg = couponImgSrc();

  S.el.innerHTML = `
    <div class="gu-tabs gu-on">
      ${S.banners.map((b) => `
        <div class="gu-tab${b.id === banner.id ? " is-active" : ""}"
             data-banner="${b.id}" style="background-image:url('${b.art}')">
          <div class="gu-tab-label">${esc(b.name)}</div>
        </div>`).join("")}
    </div>

    <div class="gu-wallet gu-on">
      <div class="gu-coin">
        <img src="${couponImg}" alt=""> ${S.pool.coupons}
        ${S.canPlay ? `<div class="gu-buy" data-act="buy" title="Buy Hako Coupons">+</div>` : ""}
      </div>
      ${S.pool.tickets > 0 ? `<div class="gu-coin is-ticket">★ ${S.pool.tickets}</div>` : ""}
    </div>

    <div class="gu-pity">
      ${RARITY.five.label} guaranteed within <b>${remaining}</b> ·
      ${RARITY.four.label} floor every 10
    </div>

    <div class="gu-stage">
      <img class="gu-art" src="${banner.art}" alt="${esc(banner.name)}">
    </div>

    <div class="gu-nav gu-on">
      <button class="gu-nav-btn" data-act="details">Details</button>
      <button class="gu-nav-btn" data-act="exchange">Exchange</button>
      ${S.canPlay ? `<button class="gu-nav-btn" data-act="shop">Shop</button>` : ""}
    </div>

    ${S.canPlay ? `
      <div class="gu-actions gu-on">
        ${wishBtn(1, couponImg)}
        ${wishBtn(10, couponImg)}
      </div>` : ""}
  `;

  bind(banner);
}

function wishBtn(n, couponImg) {
  const off = S.pool.coupons < n || S.busy;
  return `
    <button class="gu-wish${off ? " is-off" : ""}" data-wish="${n}">
      Wish ×${n}
      <small><img src="${couponImg}" alt="">×${n}</small>
    </button>`;
}

function bind(banner) {
  const el = S.el;

  el.querySelectorAll(".gu-tab").forEach((t) =>
    t.addEventListener("click", () => {
      S.bannerId = t.dataset.banner;
      render();
    })
  );

  el.querySelectorAll("[data-wish]").forEach((b) =>
    b.addEventListener("click", () => wish(Number(b.dataset.wish)))
  );

  el.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => renderPanel(b.dataset.act, { banner, state: S, refresh: refreshPool }))
  );
}

// ── Wish ────────────────────────────────────────────────────────────────────

async function wish(count) {
  if (S.busy || S.pool.coupons < count) return;
  S.busy = true;
  render();

  const res = await request(GACHA.MSG.WISH_REQ, {
    bannerId: S.bannerId,
    count,
    requesterUserId: game.user.id,
  });

  S.busy = false;

  if (!res?.ok) {
    toast(failureText(res), true);
  } else if (res.pool) {
    S.pool = res.pool;
  }

  render();
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

function couponImgSrc() {
  const item = S.actor?.items?.find((i) => i.name === "Hako Coupon");
  return item?.img ?? "icons/svg/coins.svg";
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
