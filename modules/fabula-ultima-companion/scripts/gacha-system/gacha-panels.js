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

import { GACHA, RARITY } from "./gacha-const.js";
import { getPoolTable, resolveTableItems, groupBySet, imgOf, FALLBACK_IMG } from "./gacha-banners.js";
import { listSetBoard, redeemCatalogue } from "./gacha-exchange.js";
import { request } from "./gacha-net.js";
import { ensureTheme } from "./gacha-theme.js";

const PANEL_ID = "gacha-panel";
const TIP_ID   = "gacha-tip";
const STYLE_ID = "gacha-panel-style";

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

.gp-frame {
  width: var(--gp-w, 900px); max-width: 94vw; max-height: 88vh;
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel-2));
  border: 2px solid var(--gc-line-3); border-radius: var(--gc-radius-lg);
  box-shadow: var(--gc-shadow);
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
.gp-foot {
  padding: 12px 18px; border-top: 2px solid var(--gc-line-2);
  display: flex; justify-content: center; gap: 10px;
  background: var(--gc-panel);
  border-radius: 0 0 10px 10px;
}

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
.gp-buy { display: flex; align-items: center; justify-content: center; gap: 14px; }
.gp-buy label { font-size: 13px; }
/* Explicit and scoped: this panel is appended to document.body, so Foundry's
   global input rules apply and will otherwise take the field to 100%. */
#${PANEL_ID} input.gp-qty {
  width: 92px; flex: 0 0 auto; text-align: center;
  padding: 9px 10px; font-family: inherit; font-size: 15px;
  background: var(--gc-parch); color: var(--gc-ink);
  border: 1px solid var(--gc-line-3); border-radius: var(--gc-radius);
}
.gp-total { font-size: 16px; font-weight: 700; color: var(--gc-title); min-width: 96px; }

/* ── exchange board ────────────────────────────────────────────────────── */
.gp-tabs { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.gp-tab {
  padding: 9px 16px; cursor: pointer; border-radius: var(--gc-radius);
  font-family: inherit; font-size: 12px; letter-spacing: 1px;
  border: 1px solid var(--gc-line-2); background: var(--gc-parch); color: var(--gc-ink-3);
}
.gp-tab:hover { background: #fffaec; border-color: var(--gc-gold); }
.gp-tab.is-active {
  background: linear-gradient(180deg, var(--gc-deep), var(--gc-deep-2));
  color: var(--gc-deep-ink); border-color: var(--gc-deep-2);
}
.gp-tab .n { opacity: .65; margin-left: 6px; }

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

function frame(title, bodyHTML, { width = 900, foot = "" } = {}) {
  closePanel();
  ensureStyle();

  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.innerHTML = `
    <div class="gp-frame" style="--gp-w:${width}px">
      <div class="gp-head">
        <div class="gp-title">${esc(title)}</div>
        <button class="gp-x" data-close>×</button>
      </div>
      <div class="gp-body">${bodyHTML}</div>
      ${foot ? `<div class="gp-foot">${foot}</div>` : ""}
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
      <details class="gp-fold">
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
  const cost  = state.cost;

  if (!buyer) {
    frame("Buy Hako Coupons", `
      <div class="gp-empty">
        No character is assigned to this client, so there is no Zenit to spend.<br>
        Coupons are bought by a party member from their own purse.
      </div>`, { width: 460 });
    return;
  }

  const zenit = Math.max(0, Number(buyer.system?.props?.zenit ?? 0));

  const body = frame("Buy Hako Coupons", `
    <div class="gp-buy">
      <label for="gp-qty">Quantity</label>
      <input id="gp-qty" class="gp-qty" type="number" min="1" max="99" value="10" data-qty>
      <span class="gp-total" data-total>${cost * 10}z</span>
    </div>
    <div class="gp-note">
      Paying from <b>${esc(buyer.name)}</b> — your own Zenit (<b>${zenit}z</b>), at ${cost}z each.<br>
      The coupons go to the <b>shared party pool</b>, not your inventory:
      spending is personal, the currency is the party's.
    </div>`, {
      width: 480,
      foot: `<button class="gc-btn is-primary" data-confirm>Purchase</button>`,
    });

  const root    = body.closest(".gp-frame");
  const qty     = root.querySelector("[data-qty]");
  const total   = root.querySelector("[data-total]");
  const confirm = root.querySelector("[data-confirm]");

  const sync = () => {
    const n = Math.max(1, Math.floor(Number(qty.value) || 1));
    total.textContent = `${cost * n}z`;
    confirm.disabled = cost * n > zenit;
  };
  qty.addEventListener("input", sync);
  sync();

  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    const n = Math.max(1, Math.floor(Number(qty.value) || 1));
    const res = await request(GACHA.MSG.BUY_REQ, {
      buyerActorUuid: buyer.uuid, quantity: n, requesterUserId: game.user.id,
    });

    if (res?.ok) {
      ui.notifications?.info(`Bought ${res.quantity} coupon(s) for ${res.totalCost}z.`);
      refresh?.(res.pool);
      closePanel();
    } else {
      ui.notifications?.warn(`Purchase failed: ${res?.reason ?? "unknown"}`);
      sync();
    }
  });
}

// ── Exchange ────────────────────────────────────────────────────────────────

async function exchange(ctx) {
  const body = frame("Exchange", `
    <div class="gp-tabs" data-mode>
      <button class="gp-tab is-active" data-mode-tab="swap">Gift Exchange</button>
      <button class="gp-tab" data-mode-tab="redeem">Ticket Redemption</button>
    </div>
    <div data-panel><div class="gp-empty">Loading…</div></div>
  `, { width: 1000 });

  const panel = body.querySelector("[data-panel]");
  const tabs  = body.querySelectorAll("[data-mode-tab]");

  const show = async (which) => {
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.modeTab === which));
    panel.innerHTML = `<div class="gp-empty">Loading…</div>`;
    if (which === "swap") await swapView(panel, ctx);
    else await redeemView(panel, ctx);
  };

  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.modeTab)));
  await show("swap");
}

async function swapView(panel, ctx) {
  const board = await listSetBoard();
  if (!board.length) {
    panel.innerHTML = `<div class="gp-empty">No gacha sets found.</div>`;
    return;
  }

  const state = { set: board[0].setName };

  const paint = () => {
    const set = board.find((s) => s.setName === state.set) ?? board[0];

    panel.innerHTML = `
      <div class="gp-tabs">
        ${board.map((s) => `
          <button class="gp-tab${s.setName === set.setName ? " is-active" : ""}" data-set="${esc(s.setName)}">
            ${esc(s.setName)}<span class="n">${s.ownedCount}/${s.pieces.length}</span>
          </button>`).join("")}
      </div>
      ${set.pieces.map((p) => rowHTML(set, p)).join("")}
      <div class="gp-note">
        A trade is free and one-for-one, <b>within the same set only</b>.
        The piece you trade in is <b>destroyed</b> — refinement and installed orbment augments go with it.
      </div>`;

    panel.querySelectorAll("[data-set]").forEach((t) =>
      t.addEventListener("click", () => { state.set = t.dataset.set; paint(); })
    );

    panel.querySelectorAll("[data-swap]").forEach((n) =>
      n.addEventListener("click", () => doSwap(n.dataset.swap, n.dataset.target, set, panel, ctx, paint))
    );

    bindTips(panel);
    bindFallbacks(panel);
  };

  paint();
}

function rowHTML(set, piece) {
  const owned = piece.owned;
  const blocked = owned?.blocking?.length ? owned.blocking[0] : "";
  const warned  = owned?.warnings?.length ? owned.warnings.join(" ") : "";

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
        ${targets.map((t) => `
          <div class="gp-chip${owned && !blocked ? "" : " is-dim"}"
               ${owned && !blocked ? `data-swap="${esc(piece.name)}" data-target="${esc(t.name)}"` : ""}
               data-tip="${esc(t.name)}"
               data-tip-sub="${esc(owned && !blocked ? `trade ${piece.name} for this` : "unavailable")}">
            <img src="${t.img}" alt="">
          </div>`).join("")}
        ${blocked ? `<div class="gp-warn is-block">⛔ ${esc(blocked)}</div>`
                  : warned ? `<div class="gp-warn">⚠ ${esc(warned)}</div>` : ""}
      </div>
    </div>`;
}

async function doSwap(srcName, dstName, set, panel, ctx, repaint) {
  const src = set.pieces.find((p) => p.name === srcName);
  const dst = set.pieces.find((p) => p.name === dstName);
  if (!src?.owned || !dst) return;

  if (src.owned.warnings?.length) {
    const ok = await Dialog.confirm({
      title: "Destroy this piece?",
      content: `<p>${src.owned.warnings.map(esc).join("<br>")}</p>
                <p><b>“${esc(src.name)}” will be destroyed permanently.</b> Continue?</p>`,
      defaultYes: false,
    });
    if (!ok) return;
  }

  const res = await request(GACHA.MSG.SWAP_REQ, {
    ownerActorUuid: src.owned.ownerActorUuid,
    itemId: src.owned.itemId,
    targetItemUuid: dst.uuid,
    confirmed: true,
    requesterUserId: game.user.id,
  });

  if (res?.ok) {
    ui.notifications?.info(`Traded ${res.from} → ${res.to}.`);
    await swapView(panel, ctx);      // rebuild from fresh state
  } else {
    ui.notifications?.warn(`Trade failed: ${res?.reason ?? "unknown"}`);
  }
}

async function redeemView(panel, { state, refresh }) {
  const tickets = state.pool.tickets ?? 0;
  const cat = redeemCatalogue();

  panel.innerHTML = `
    <div class="gp-note" style="margin:0 0 14px">
      You hold <b>${tickets}</b> ${RARITY.five.label} Exchange Ticket${tickets === 1 ? "" : "s"}.
      A ticket may be redeemed for <b>any</b> ${RARITY.five.label} on <b>any</b> banner.
    </div>
    ${tickets < 1
      ? `<div class="gp-empty">No tickets. They are handed out for events and holidays.</div>`
      : `<div class="gp-grid">
          ${cat.map((e) => `
            <div class="gp-cell">
              <div class="gp-chip r5" data-redeem="${e.uuid}"
                   data-tip="${esc(e.name)}" data-tip-sub="${esc(e.setName || e.bannerName)}">
                <img src="${imgOf(e)}" alt="">
              </div>
              <div class="gp-cell-name">${esc(e.name)}</div>
            </div>`).join("")}
        </div>`}`;

  panel.querySelectorAll("[data-redeem]").forEach((n) =>
    n.addEventListener("click", async () => {
      const ok = await Dialog.confirm({
        title: "Redeem ticket?",
        content: `<p>Spend one ${RARITY.five.label} Exchange Ticket on this item?</p>`,
      });
      if (!ok) return;

      const res = await request(GACHA.MSG.REDEEM_REQ, {
        targetItemUuid: n.dataset.redeem, requesterUserId: game.user.id,
      });

      if (res?.ok) {
        ui.notifications?.info(`Redeemed → ${res.itemName}.`);
        refresh?.(res.pool);
        closePanel();
      } else {
        ui.notifications?.warn(`Redemption failed: ${res?.reason ?? "unknown"}`);
      }
    })
  );

  bindTips(panel);
  bindFallbacks(panel);
}
