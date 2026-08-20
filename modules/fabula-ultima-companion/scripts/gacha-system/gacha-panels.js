// ============================================================================
// Gacha System — Panels (Details / Shop / Exchange)
// ----------------------------------------------------------------------------
// Modal panels layered over the overlay shell. Kept in one file because they
// share the same frame, the same escape/backdrop behaviour and the same
// request plumbing; splitting them would duplicate all three.
//
// DETAILS  banner contents grouped by SET, not a flat list. A banner routinely
//          carries two sets, and the Gift Exchange's boundary is the set — so
//          showing the grouping here is what makes that rule look deliberate
//          rather than arbitrary when a player meets it later.
// SHOP     buy coupons with the buyer's own Zenit into the shared pool.
// EXCHANGE Gift Exchange (free, within-set swap) + Ticket Redemption.
// ============================================================================

import { GACHA, RARITY, log } from "./gacha-const.js";
import { getPoolTable, resolveTableItems, groupBySet } from "./gacha-banners.js";
import { listSwappable, redeemCatalogue } from "./gacha-exchange.js";
import { request } from "./gacha-net.js";

const PANEL_ID = "gacha-panel";
const STYLE_ID = "gacha-panel-style";

const CSS = `
#${PANEL_ID} {
  position: fixed; inset: 0; z-index: 70; pointer-events: auto;
  background: rgba(4,6,14,.72); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  font-family: 'Lucida Console', 'Courier New', monospace; color: #e9edf7;
  animation: gp-fade .16s ease-out both;
}
@keyframes gp-fade { from { opacity: 0; } }
.gp-frame {
  width: min(1000px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: linear-gradient(180deg, rgba(20,24,40,.98), rgba(10,12,22,.98));
  border: 1px solid rgba(150,165,200,.32); border-radius: 12px;
  box-shadow: 0 24px 70px -18px rgba(0,0,0,.9);
}
.gp-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid rgba(150,165,200,.2);
}
.gp-title { font-size: 13px; letter-spacing: 4px; text-transform: uppercase; color: #f2d98a; }
.gp-x {
  cursor: pointer; border: 1px solid rgba(150,165,200,.35); background: rgba(30,36,56,.9);
  color: #dfe6f5; border-radius: 6px; width: 30px; height: 28px; font-size: 15px; line-height: 1;
}
.gp-x:hover { background: rgba(58,70,104,.95); color: #fff; }
.gp-body { padding: 16px 18px; overflow-y: auto; overflow-x: hidden; }

.gp-set { margin-bottom: 18px; }
.gp-set-name {
  font-size: 11px; letter-spacing: 3px; text-transform: uppercase;
  color: #b9c2d8; margin-bottom: 8px; padding-bottom: 5px;
  border-bottom: 1px solid rgba(150,165,200,.18);
}
.gp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 10px; }
.gp-item {
  text-align: center; padding: 9px 5px; border-radius: 8px; cursor: pointer;
  background: rgba(30,36,56,.5); border: 1px solid var(--cc, rgba(150,165,200,.25));
  transition: background .13s, transform .13s;
}
.gp-item:hover { background: rgba(52,64,96,.7); transform: translateY(-2px); }
.gp-item.is-sel { background: rgba(70,88,132,.85); border-color: #e6c060; }
.gp-item img {
  width: 58px; height: 58px; object-fit: contain; display: block; margin: 0 auto 6px;
  border: 0 !important; outline: 0 !important; background: transparent;
}
.gp-item-name { font-size: 10px; line-height: 1.25; word-break: break-word; }
.gp-item-sub { font-size: 9px; opacity: .6; margin-top: 3px; }
.gp-stars { font-size: 10px; margin-top: 3px; color: var(--cc); }

.gp-fold { margin-top: 6px; }
.gp-fold summary { cursor: pointer; font-size: 11px; letter-spacing: 2px; color: #9fb0d4; padding: 6px 0; }

.gp-tabs { display: flex; gap: 8px; margin-bottom: 14px; }
.gp-tab {
  padding: 7px 15px; cursor: pointer; border-radius: 6px; font-size: 11px;
  letter-spacing: 2px; text-transform: uppercase; font-family: inherit;
  border: 1px solid rgba(150,165,200,.3); background: rgba(16,20,34,.8); color: #c3cce0;
}
.gp-tab.is-active { border-color: #e6c060; color: #ffe9a8; background: rgba(60,48,20,.7); }

.gp-row {
  display: flex; align-items: center; gap: 12px; padding: 10px;
  border: 1px solid rgba(150,165,200,.2); border-radius: 8px; margin-bottom: 8px;
  background: rgba(24,30,48,.6);
}
.gp-row img {
  width: 46px; height: 46px; object-fit: contain;
  border: 0 !important; outline: 0 !important; background: transparent;
}
.gp-row-main { flex: 1; min-width: 0; }
.gp-row-name { font-size: 12px; }
.gp-row-sub { font-size: 10px; opacity: .65; margin-top: 3px; }
.gp-warn { font-size: 10px; color: #ffcf8a; margin-top: 4px; line-height: 1.5; }
.gp-block { font-size: 10px; color: #ff9d9d; margin-top: 4px; }

.gp-btn {
  padding: 8px 16px; cursor: pointer; border-radius: 6px; font-family: inherit;
  font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
  border: 1px solid rgba(226,196,120,.5); color: #ffeec0;
  background: linear-gradient(180deg, rgba(84,62,26,.95), rgba(52,38,16,.95));
}
.gp-btn:hover:not(:disabled) { filter: brightness(1.2); }
.gp-btn:disabled { opacity: .35; cursor: default; filter: grayscale(.6); }
.gp-btn.is-plain {
  border-color: rgba(150,165,200,.35); color: #d6ddee;
  background: rgba(30,36,56,.9);
}

.gp-buy { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.gp-qty {
  width: 78px; padding: 7px 9px; font-family: inherit; font-size: 13px;
  background: rgba(10,13,24,.9); color: #e9edf7;
  border: 1px solid rgba(150,165,200,.35); border-radius: 6px;
}
.gp-note { font-size: 11px; opacity: .72; line-height: 1.6; margin-top: 12px; }
.gp-empty { font-size: 12px; opacity: .6; padding: 24px 0; text-align: center; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

let _ctx = null;

// ── Frame ───────────────────────────────────────────────────────────────────

export function closePanel() {
  document.getElementById(PANEL_ID)?.remove();
  if (_ctx?.onKey) window.removeEventListener("keydown", _ctx.onKey);
  _ctx = null;
}

function frame(title, bodyHTML) {
  closePanel();
  ensureStyle();

  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.innerHTML = `
    <div class="gp-frame">
      <div class="gp-head">
        <div class="gp-title">${esc(title)}</div>
        <button class="gp-x" data-close>×</button>
      </div>
      <div class="gp-body">${bodyHTML}</div>
    </div>`;

  document.body.appendChild(el);

  el.addEventListener("click", (ev) => { if (ev.target === el) closePanel(); });
  el.querySelector("[data-close]").addEventListener("click", closePanel);

  const onKey = (ev) => { if (ev.key === "Escape") closePanel(); };
  window.addEventListener("keydown", onKey);
  _ctx = { onKey };

  return el.querySelector(".gp-body");
}

// ── Router ──────────────────────────────────────────────────────────────────

export async function renderPanel(kind, ctx) {
  if (kind === "details")  return details(ctx);
  if (kind === "shop")     return shop(ctx);
  if (kind === "exchange") return exchange(ctx);
  if (kind === "buy")      return shop(ctx);
}

// ── Details ─────────────────────────────────────────────────────────────────

function itemCard(e, rarity) {
  const c = RARITY[rarity];
  return `
    <div class="gp-item" data-uuid="${e.uuid}" style="--cc:${c.color}">
      <img src="${e.img}" alt="">
      <div class="gp-item-name">${esc(e.name)}</div>
      <div class="gp-stars">${"★".repeat(c.stars)}</div>
    </div>`;
}

function details({ banner }) {
  const five = resolveTableItems(banner.table);
  const sets = groupBySet(five);

  const poolHTML = (key, label) => {
    const t = getPoolTable(key);
    const entries = t ? resolveTableItems(t) : [];
    if (!entries.length) return "";
    return `
      <details class="gp-fold">
        <summary>${label} pool — ${entries.length} items</summary>
        <div class="gp-grid" style="margin-top:8px">
          ${entries.sort((a, b) => a.name.localeCompare(b.name)).map((e) => itemCard(e, key)).join("")}
        </div>
      </details>`;
  };

  const body = frame(`${banner.name} — Contents`, `
    ${sets.map((g) => `
      <div class="gp-set">
        <div class="gp-set-name">${RARITY.five.label} · ${esc(g.setName === "—" ? "Unsorted" : g.setName)}</div>
        <div class="gp-grid">${g.entries.map((e) => itemCard(e, "five")).join("")}</div>
      </div>`).join("")}
    ${poolHTML("four", RARITY.four.label)}
    ${poolHTML("three", RARITY.three.label)}
    <div class="gp-note">
      Pieces are grouped by set. The Gift Exchange lets you trade any piece for
      another <b>in the same set</b> — sets never cross, even when they share a banner.
    </div>
  `);

  body.querySelectorAll("[data-uuid]").forEach((n) =>
    n.addEventListener("click", async () => {
      const doc = await fromUuid(n.dataset.uuid).catch(() => null);
      doc?.sheet?.render(true);
    })
  );
}

// ── Shop ────────────────────────────────────────────────────────────────────

async function shop({ state, refresh }) {
  const buyer = game.user?.character;
  const zenit = Math.max(0, Number(buyer?.system?.props?.zenit ?? 0));
  const cost  = state.cost;

  const body = frame("Buy Hako Coupons", `
    <div class="gp-buy">
      <span>Quantity</span>
      <input class="gp-qty" type="number" min="1" max="99" value="10" data-qty>
      <span data-total>= ${cost * 10}z</span>
      <button class="gp-btn" data-confirm>Purchase</button>
    </div>
    <div class="gp-note">
      Paying from <b>${esc(buyer?.name ?? "—")}</b> — your own Zenit (<b>${zenit}</b>z),
      at ${cost}z each.<br>
      The coupons go into the <b>shared party pool</b>, not your inventory:
      spending is personal, the currency is the party's.
    </div>
  `);

  const qty     = body.querySelector("[data-qty]");
  const total   = body.querySelector("[data-total]");
  const confirm = body.querySelector("[data-confirm]");

  const sync = () => {
    const n = Math.max(1, Math.floor(Number(qty.value) || 1));
    total.textContent = `= ${cost * n}z`;
    confirm.disabled = !buyer || cost * n > zenit;
  };
  qty.addEventListener("input", sync);
  sync();

  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    const n = Math.max(1, Math.floor(Number(qty.value) || 1));

    const res = await request(GACHA.MSG.BUY_REQ, {
      buyerActorUuid: buyer.uuid,
      quantity: n,
      requesterUserId: game.user.id,
    });

    if (res?.ok) {
      ui.notifications?.info(`Bought ${res.quantity} coupon(s) for ${res.totalCost}z.`);
      refresh?.(res.pool);
      closePanel();
    } else {
      ui.notifications?.warn(`Purchase failed: ${res?.reason ?? "unknown"}`);
      confirm.disabled = false;
    }
  });
}

// ── Exchange ────────────────────────────────────────────────────────────────

async function exchange(ctx) {
  const body = frame("Exchange", `
    <div class="gp-tabs">
      <button class="gp-tab is-active" data-tab="swap">Gift Exchange</button>
      <button class="gp-tab" data-tab="redeem">Ticket Redemption</button>
    </div>
    <div data-panel></div>
  `);

  const panel = body.querySelector("[data-panel]");
  const tabs  = body.querySelectorAll("[data-tab]");

  const show = async (which) => {
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === which));
    panel.innerHTML = `<div class="gp-empty">Loading…</div>`;
    if (which === "swap") await swapView(panel, ctx);
    else await redeemView(panel, ctx);
  };

  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab)));
  await show("swap");
}

async function swapView(panel, ctx) {
  const owned = await listSwappable();

  if (!owned.length) {
    panel.innerHTML = `<div class="gp-empty">
      No swappable set pieces yet. Win a 5★ and any piece of its set becomes tradeable.
    </div>`;
    return;
  }

  panel.innerHTML = `
    ${owned.map((o, i) => `
      <div class="gp-row">
        <img src="${o.img}" alt="">
        <div class="gp-row-main">
          <div class="gp-row-name">${esc(o.name)}</div>
          <div class="gp-row-sub">${esc(o.setName)} · held by ${esc(o.ownerName)}</div>
          ${o.blocking.map((b) => `<div class="gp-block">⛔ ${esc(b)}</div>`).join("")}
          ${o.warnings.map((w) => `<div class="gp-warn">⚠ ${esc(w)}</div>`).join("")}
        </div>
        <button class="gp-btn${o.blocking.length ? "" : ""}" data-swap="${i}"
          ${o.blocking.length ? "disabled" : ""}>Trade</button>
      </div>`).join("")}
    <div class="gp-note">
      A trade is free and one-for-one, within the same set only.
      <b>The piece you trade in is destroyed</b> — there is no vault, and any
      refinement or installed orbment augments go with it.
    </div>`;

  panel.querySelectorAll("[data-swap]").forEach((b) =>
    b.addEventListener("click", () => chooseTarget(panel, owned[Number(b.dataset.swap)], ctx))
  );
}

function chooseTarget(panel, entry, ctx) {
  panel.innerHTML = `
    <div class="gp-set">
      <div class="gp-set-name">Trade “${esc(entry.name)}” for…</div>
      <div class="gp-grid">
        ${entry.alternatives.map((a) => `
          <div class="gp-item" data-target="${a.uuid}" style="--cc:${RARITY.five.color}">
            <img src="${a.img}" alt="">
            <div class="gp-item-name">${esc(a.name)}</div>
          </div>`).join("")}
      </div>
    </div>
    ${entry.warnings.length ? `
      <div class="gp-warn" style="font-size:11px">
        ⚠ ${entry.warnings.map(esc).join("<br>⚠ ")}<br>
        This cannot be undone.
      </div>` : ""}
    <div style="margin-top:14px"><button class="gp-btn is-plain" data-back>Back</button></div>`;

  panel.querySelector("[data-back]").addEventListener("click", () => swapView(panel, ctx));

  panel.querySelectorAll("[data-target]").forEach((n) =>
    n.addEventListener("click", async () => {
      const targetItemUuid = n.dataset.target;

      if (entry.warnings.length) {
        const ok = await Dialog.confirm({
          title: "Destroy this piece?",
          content: `<p>${entry.warnings.map(esc).join("<br>")}</p>
                    <p><b>“${esc(entry.name)}” will be destroyed permanently.</b> Continue?</p>`,
          defaultYes: false,
        });
        if (!ok) return;
      }

      const res = await request(GACHA.MSG.SWAP_REQ, {
        ownerActorUuid: entry.ownerActorUuid,
        itemId: entry.itemId,
        targetItemUuid,
        confirmed: true,
        requesterUserId: game.user.id,
      });

      if (res?.ok) {
        ui.notifications?.info(`Traded ${res.from} → ${res.to}.`);
        log("swap ok", res);
        swapView(panel, ctx);
      } else {
        ui.notifications?.warn(`Trade failed: ${res?.reason ?? "unknown"}`);
      }
    })
  );
}

async function redeemView(panel, { state, refresh }) {
  const tickets = state.pool.tickets ?? 0;
  const cat = redeemCatalogue();

  panel.innerHTML = `
    <div class="gp-note" style="margin:0 0 12px">
      You hold <b>${tickets}</b> 5-Star Exchange Ticket${tickets === 1 ? "" : "s"}.
      A ticket may be redeemed for <b>any</b> 5★ on <b>any</b> banner.
    </div>
    ${tickets < 1
      ? `<div class="gp-empty">No tickets. They are handed out for events and holidays.</div>`
      : `<div class="gp-grid">
          ${cat.map((e) => `
            <div class="gp-item" data-redeem="${e.uuid}" style="--cc:${RARITY.five.color}">
              <img src="${e.img}" alt="">
              <div class="gp-item-name">${esc(e.name)}</div>
              <div class="gp-item-sub">${esc(e.setName || e.bannerName)}</div>
            </div>`).join("")}
        </div>`}`;

  panel.querySelectorAll("[data-redeem]").forEach((n) =>
    n.addEventListener("click", async () => {
      const ok = await Dialog.confirm({
        title: "Redeem ticket?",
        content: `<p>Spend one 5-Star Exchange Ticket on this item?</p>`,
      });
      if (!ok) return;

      const res = await request(GACHA.MSG.REDEEM_REQ, {
        targetItemUuid: n.dataset.redeem,
        requesterUserId: game.user.id,
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
}
