// Party Menu — Item view.
//
// One list per bag: the party's shared bag and each character's own items.
// Q/E walk the bags, or click one in the portrait row; Enter on an item opens
// "Move to…", then a quantity for stacks. Reading is open to everyone in the
// party; moving follows moveRefusal (party-menu-inventory.js).

import {
  ITEM_TYPES, ITEM_FILTERS, itemType, sortedInventory, itemSummary, quantityOf, isWorn,
  bagsOf, moveRefusal, moveItem, useRefusal, useItem,
} from "./party-menu-inventory.js";
import { esc, safeHtml, play, SND, img, gridStep, portraitStrip, overlayFoot, kbd } from "./party-menu-ui.js";

const REASONS = {
  "same-bag": "It's already there.",
  "not-in-party": "Only party bags can trade items here.",
  "item-gone": "That item is gone.",
  "not-an-item": "That can't be moved on its own.",
  equipped: "Unequip it first.",
  "in-combat": "Not during a conflict.",
  "not-yours": "That isn't yours to give away.",
  "no-transfer-core": "Item transfer isn't loaded.",
  timeout: "No GM answered. A GM must be online to move items.",
  "not-granted": "The GM hasn't opened the Item menu to players.",
  "in-party-bag": "Move it to a character to use it.",
  "not-active": "Only characters in the active party can use items here.",
  "in-combat-use": "Use items with the Item action during a conflict.",
  "none-left": "There are none left.",
  "battle-only": "This item is used in battle, with the Item action.",
  "no-healing-hud": "The healing menu isn't loaded.",
  "no-bag": "That bag is gone.",
  "transfer-failed": "The move failed — the item may have changed. Try again.",
  sender_quantity_zero_or_negative: "There are none left to move.",
  unregistered_request: "The Party Menu isn't loaded on the GM's client.",
};
export const moveReason = (r) => REASONS[r] ?? `Could not move it (${r}).`;

function bags(ctx) { return bagsOf(ctx.roster()); }
function bagActor(ctx) {
  const v = ctx.S.v;
  return bags(ctx).find((b) => b.actor.id === v.bag)?.actor ?? bags(ctx)[0]?.actor ?? null;
}
function list(ctx) { return sortedInventory(bagActor(ctx), ctx.S.v.filter); }
/** The item a Move overlay was opened for — pinned by id, so a re-sort can't swap it. */
function pinned(ctx) {
  const v = ctx.S.v;
  return v.itemId ? bagActor(ctx)?.items?.get(v.itemId) ?? null : null;
}
function current(ctx) {
  if (ctx.S.v.focus !== "list") return pinned(ctx);
  const l = list(ctx);
  if (!l.length) return null;
  ctx.S.v.idx = Math.max(0, Math.min(ctx.S.v.idx, l.length - 1));
  return l[ctx.S.v.idx];
}

/** Destinations for `item`, each with its refusal ("" = allowed). */
function destinations(ctx, item) {
  const src = bagActor(ctx);
  const roster = ctx.roster();
  return bags(ctx).filter((b) => b.actor.id !== src?.id).map((b) => ({
    ...b, refusal: moveRefusal({ user: game.user, item, src, dst: b.actor, roster }),
  }));
}

export const itemView = {
  id: "item",
  title: "Item",

  enter(ctx, actor) {
    const all = bags(ctx);
    const start = all.find((b) => b.actor.id === actor?.id) ?? all.find((b) => b.actor.isOwner && b.kind !== "party") ?? all[0];
    ctx.S.v = { bag: start?.actor.id ?? null, filter: "all", idx: 0, focus: "list", dest: 0, qty: null };
  },

  nav(ctx) {
    const v = ctx.S.v;
    const bag = bagActor(ctx);
    const crumbs = [`Item · ${bag?.id === ctx.roster().db?.id ? "Party Bag" : bag?.name ?? ""}`];
    const actions = [];
    const it = v.focus === "list" ? current(ctx) : null;
    if (it) {
      if (itemType(it) === "consumable" && !useRefusal({ item: it, roster: ctx.roster() })) actions.push({ key: "u", label: "Use", icon: "fa-hand-sparkles" });
      if (destinations(ctx, it).some((d) => !d.refusal)) actions.push({ key: "Enter", label: "Move to…", icon: "fa-right-left" });
    }
    return { crumbs, actions };
  },

  render(ctx) {
    const v = ctx.S.v;
    const bag = bagActor(ctx);
    if (!bag) return `<div class="pm-win pm-empty">No bags.</div>`;
    const roster = ctx.roster();
    const items = list(ctx);
    // The item a Move overlay was open for went away (moved by someone else).
    if (v.focus !== "list" && !pinned(ctx)) Object.assign(v, { focus: "list", itemId: null, qty: null });
    const sel = current(ctx);
    const isParty = bag.id === roster.db?.id;

    const tabs = ITEM_FILTERS.map((f) => `
      <span class="pm-tab pm-hit ${v.filter === f.id ? "is-on" : ""}" data-action="it-filter" data-id="${f.id}"><i class="fas ${f.icon}"></i>${esc(f.label)}</span>`).join("");

    let last = null;
    const counts = new Map();
    for (const it of items) counts.set(itemType(it), (counts.get(itemType(it)) ?? 0) + 1);
    const rows = items.map((it, i) => {
      const t = itemType(it);
      const head = t === last ? "" : `<div class="pm-section"><i class="fas ${ITEM_TYPES[t].icon}"></i><span>${esc(ITEM_TYPES[t].label)}</span><b>${counts.get(t)}</b></div>`;
      last = t;
      const worn = isWorn(it, roster);
      const qty = quantityOf(it);
      const cursor = v.focus === "list" && v.idx === i;
      const held = v.focus !== "list" && it.id === v.itemId;
      return `${head}
        <div class="pm-skill pm-hit ${cursor ? "is-cursor" : ""} ${held ? "is-held" : ""}" data-action="it-row" data-index="${i}">
          ${img(it.img || "icons/svg/item-bag.svg")}
          <span class="pm-skill-name">${esc(it.name)}${worn ? `<i class="pm-badge pm-worn" title="Equipped">E</i>` : ""}</span>
          <span class="pm-skill-cost pm-qty">${qty > 1 || t === "consumable" ? `×${qty}` : ""}</span>
        </div>`;
    }).join("") || `<div class="pm-empty">Nothing under this filter.</div>`;

    const sub = isParty
      ? `Shared by the party · ${items.length} shown`
      : `${game.user.isGM ? "Bag" : bag.isOwner ? "Your bag" : "Teammate's bag"} · <i class="fas fa-coins"></i> ${Number(bag.system?.props?.zenit ?? 0).toLocaleString()} z`;

    // Party Bag first, then each character's own bag — one click switches.
    const chips = bags(ctx).map((b) => ({
      id: b.actor.id, name: b.label, img: b.actor.img, icon: b.kind === "party" ? "fa-sack-dollar" : "", reserve: b.kind === "reserve",
    }));
    const info = `<div class="pm-member-top"><span class="pm-name">${esc(isParty ? "Party Bag" : bag.name)}</span></div>
      <div class="pm-sub">${sub}</div>`;

    return `
      <div class="pm-ability">
        ${ctx.nav()}
        <div class="pm-ability-top">
          <div class="pm-win pm-title"><span class="pm-pill">Item</span></div>
          ${portraitStrip(chips, bag.id, "it-bag-pick", info)}
        </div>
        <div class="pm-ability-body">
          <div class="pm-win pm-skills">
            <div class="pm-tabs">${tabs}${kbd("Tab")}</div>
            <div class="pm-skill-list">${rows}</div>
          </div>
          <div class="pm-win pm-detail"><div class="pm-scroll" data-key="${esc(sel?.uuid ?? "")}">${sel ? this.detail(ctx, sel) : ""}</div></div>
        </div>
      </div>
      ${v.focus === "dest" && sel ? this.renderDest(ctx, sel) : ""}
      ${v.focus === "qty" && sel ? this.renderQty(ctx, sel) : ""}`;
  },

  detail(ctx, item) {
    const s = itemSummary(item);
    const dests = destinations(ctx, item);
    const allowed = dests.filter((d) => !d.refusal);
    const why = allowed.length ? "" : (dests.map((d) => d.refusal).find((r) => r !== "same-bag") ?? "");
    const useWhy = itemType(item) === "consumable" ? useRefusal({ item, roster: ctx.roster() }) : "not-consumable";
    const useBtn = useWhy ? "" : `<button type="button" class="pm-btn pm-hit" data-action="it-use"><i class="fas fa-hand-sparkles"></i> Use</button>`;
    const moveBtn = allowed.length ? `<button type="button" class="pm-btn pm-hit" data-action="it-move"><i class="fas fa-right-left"></i> Move to…</button>` : "";
    const notes = [
      !allowed.length && why ? moveReason(why) : "",
      ["in-party-bag", "in-combat-use", "not-active"].includes(useWhy) ? moveReason(useWhy) : "",
    ].filter(Boolean);
    return `
      <div class="pm-detail-head">
        ${img(s.img)}
        <div><div class="pm-detail-name">${esc(s.name)}</div>
        <div class="pm-sub">${esc(ITEM_TYPES[s.type].label.replace(/s$/, ""))}${s.qty > 1 ? ` · ×${s.qty}` : ""}${isWorn(item, ctx.roster()) ? " · Equipped" : ""}</div></div>
      </div>
      ${useBtn || moveBtn ? `<div class="pm-actions">${useBtn}${moveBtn}</div>` : ""}
      ${notes.map((n) => `<div class="pm-locked"><i class="fas fa-circle-info"></i> ${esc(n)}</div>`).join("")}
      <dl class="pm-facts">${s.facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join("")}</dl>
      <div class="pm-desc">${safeHtml(s.description) || "<p><em>No description.</em></p>"}
      ${s.setDescription ? `<div class="pm-label">Set bonus</div>${safeHtml(s.setDescription)}` : ""}</div>`;
  },

  renderDest(ctx, item) {
    const v = ctx.S.v;
    const dests = destinations(ctx, item);
    v.dest = Math.max(0, Math.min(v.dest, dests.length - 1));
    const rows = dests.map((d, i) => `
      <div class="pm-pick pm-hit ${v.dest === i ? "is-cursor" : ""} ${d.refusal ? "is-locked" : ""}" data-action="it-dest" data-index="${i}"
           title="${esc(d.refusal ? moveReason(d.refusal) : "")}">
        <div class="pm-portrait xs">${d.kind === "party" ? `<i class="fas fa-sack-dollar pm-bagicon"></i>` : img(d.actor.img)}</div>
        <span>${esc(d.label)}</span>${d.refusal ? `<em class="pm-why">${esc(moveReason(d.refusal))}</em>` : ""}
      </div>`).join("");
    return `
      <div class="pm-picker-veil"></div>
      <div class="pm-win pm-picker">
        <div class="pm-picker-head"><span class="pm-label">Move ${esc(item.name)} to…</span></div>
        <div class="pm-picker-list">${rows || `<div class="pm-empty">Nowhere to move it.</div>`}</div>
        ${overlayFoot("↑↓ choose · Enter confirm · Esc cancel")}
      </div>`;
  },

  renderQty(ctx, item) {
    const q = ctx.S.v.qty;
    return `
      <div class="pm-picker-veil"></div>
      <div class="pm-win pm-picker pm-qtybox">
        <div class="pm-picker-head"><span class="pm-label">Move ${esc(item.name)} to ${esc(q.label)}</span></div>
        <div class="pm-qtyrow">
          <button type="button" class="pm-btn pm-hit" data-action="it-qty" data-delta="-1">−</button>
          <span class="pm-qtyval">${q.n}</span><span class="pm-sub">/ ${q.max}</span>
          <button type="button" class="pm-btn pm-hit" data-action="it-qty" data-delta="1">+</button>
          <button type="button" class="pm-btn pm-hit" data-action="it-qty" data-delta="max">All</button>
        </div>
        <div class="pm-actions"><button type="button" class="pm-btn pm-hit" data-action="it-qty-ok">Move</button></div>
        ${overlayFoot("←→ amount · Enter move · Esc back")}
      </div>`;
  },

  // ── actions ──
  cycleBag(ctx, delta) {
    const all = bags(ctx);
    if (all.length < 2) return;
    const i = all.findIndex((b) => b.actor.id === bagActor(ctx)?.id);
    ctx.S.v.bag = all[(i + delta + all.length) % all.length].actor.id;
    ctx.S.v.idx = 0; ctx.S.v.focus = "list";
    ctx.resetScroll();
    ctx.animate("switch");
    play(SND.move, 0.45);
    ctx.render();
  },

  pickBag(ctx, id) {
    if (id === bagActor(ctx)?.id || !bags(ctx).some((b) => b.actor.id === id)) return;
    Object.assign(ctx.S.v, { bag: id, idx: 0, focus: "list" });
    ctx.resetScroll();
    ctx.animate("switch");
    play(SND.move, 0.45);
    ctx.render();
  },

  setFilter(ctx, id) {
    Object.assign(ctx.S.v, { filter: id, idx: 0, focus: "list" });
    ctx.resetScroll();
    play(SND.move, 0.45);
    ctx.render();
  },

  openDest(ctx) {
    const it = current(ctx);
    if (!it || !destinations(ctx, it).some((d) => !d.refusal)) { play(SND.buzz, 0.5); return; }
    const dests = destinations(ctx, it);
    ctx.S.v.itemId = it.id;
    ctx.S.v.focus = "dest";
    ctx.S.v.dest = Math.max(0, dests.findIndex((d) => !d.refusal));
    play(SND.ok);
    ctx.render();
  },

  async chooseDest(ctx, i) {
    const it = current(ctx);
    const d = it ? destinations(ctx, it)[i] : null;
    if (!d) return;
    if (d.refusal) { play(SND.buzz, 0.5); ctx.toast(moveReason(d.refusal)); return; }
    const max = quantityOf(it);
    if (max > 1) {
      ctx.S.v.qty = { n: 1, max, dstId: d.actor.id, label: d.label };
      ctx.S.v.focus = "qty";
      play(SND.ok);
      ctx.render();
      return;
    }
    await this.commit(ctx, it, d.actor, 1, d.label);
  },

  /** Hand the selected consumable to the Healing HUD (it owns targeting and the GM write). */
  async use(ctx) {
    const it = current(ctx);
    if (!it) return;
    ctx.setBusy(true);
    let res;
    try { res = await useItem(it); }
    catch (e) { console.error("[PartyMenu] use failed", e); res = { ok: false, reason: "battle-only" }; }
    finally { ctx.setBusy(false); }
    if (!res?.ok) { play(SND.buzz, 0.5); ctx.toast(moveReason(res?.reason)); return; }
    if (!ctx.isOpen()) return;   // the menu was closed while we looked the item up
    play(SND.ok);
    ctx.close();   // the HUD is its own full-screen overlay
    res.open();
  },

  stepQty(ctx, delta) {
    const q = ctx.S.v.qty;
    if (!q) return;
    q.n = delta === "max" ? q.max : Math.max(1, Math.min(q.max, q.n + delta));
    play(SND.move, 0.4);
    ctx.render();
  },

  async commitQty(ctx) {
    const q = ctx.S.v.qty;
    const it = current(ctx);
    const dst = q ? game.actors.get(q.dstId) : null;
    if (!it || !dst) {
      Object.assign(ctx.S.v, { focus: "list", qty: null, itemId: null });
      play(SND.buzz, 0.5); ctx.toast(moveReason(it ? "no-bag" : "item-gone"));
      return;
    }
    await this.commit(ctx, it, dst, q.n, q.label);
  },

  async commit(ctx, item, dst, n, label) {
    const src = bagActor(ctx);
    ctx.setBusy(true);
    let res;
    try { res = await moveItem(item, src, dst, n); }
    catch (e) { console.error("[PartyMenu] move failed", e); res = { ok: false, reason: e?.message ?? "error" }; }
    finally { ctx.setBusy(false); }
    if (ctx.S.v) Object.assign(ctx.S.v, { focus: "list", qty: null, itemId: null });
    if (res?.ok) { play(SND.done, 0.5); ctx.toast(`${res.qty}× ${res.name} → ${label}`); }
    else { play(SND.buzz, 0.5); ctx.toast(moveReason(res?.reason)); }
  },

  // ── input ──
  key(ctx, k, ev) {
    const v = ctx.S.v;
    if (v.focus === "qty") {
      if (k === "ArrowLeft" || k === "ArrowDown") this.stepQty(ctx, -1);
      else if (k === "ArrowRight" || k === "ArrowUp") this.stepQty(ctx, 1);
      else if (k === "Enter") this.commitQty(ctx);
      else if (k === "Escape") { v.focus = "dest"; v.qty = null; play(SND.back); ctx.render(); }
      return;
    }
    if (v.focus === "dest") {
      const it = current(ctx);
      const n = it ? destinations(ctx, it).length : 0;
      if (k === "ArrowUp" && n) { v.dest = (v.dest - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "ArrowDown" && n) { v.dest = (v.dest + 1) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "Enter") this.chooseDest(ctx, v.dest);
      else if (k === "Escape") { v.focus = "list"; v.itemId = null; play(SND.back); ctx.render(); }
      return;
    }
    if (k === "q" || k === "Q" || k === "PageUp") return this.cycleBag(ctx, -1);
    if (k === "e" || k === "E" || k === "PageDown") return this.cycleBag(ctx, 1);
    if (k === "Tab") {
      const i = ITEM_FILTERS.findIndex((f) => f.id === v.filter);
      return this.setFilter(ctx, ITEM_FILTERS[(i + (ev.shiftKey ? -1 : 1) + ITEM_FILTERS.length) % ITEM_FILTERS.length].id);
    }
    if (k === "Escape") return ctx.back();
    const n = list(ctx).length;
    if (!n) return;
    if (k.startsWith("Arrow")) {
      const next = gridStep(ctx.root(), ".pm-skill-list .pm-skill", v.idx, k);
      if (next !== null && next >= 0 && next < n) { v.idx = next; play(SND.move, 0.45); ctx.render(); }
    } else if (k === "Enter") this.openDest(ctx);
    else if (k === "u" || k === "U") this.use(ctx);
  },

  async click(ctx, a, el) {
    const v = ctx.S.v;
    const i = Number(el.dataset.index);
    switch (a) {
      case "it-filter": if (v.focus === "list") this.setFilter(ctx, el.dataset.id); break;
      case "it-bag-pick": if (v.focus === "list") this.pickBag(ctx, el.dataset.id); break;
      case "it-row":
        if (v.focus !== "list") break;
        if (v.idx === i) this.openDest(ctx);
        else { v.idx = i; play(SND.move, 0.4); ctx.render(); }
        break;
      case "it-move": if (v.focus === "list") this.openDest(ctx); break;
      case "it-use": if (v.focus === "list") await this.use(ctx); break;
      case "it-dest": await this.chooseDest(ctx, i); break;
      case "it-qty": this.stepQty(ctx, el.dataset.delta === "max" ? "max" : Number(el.dataset.delta)); break;
      case "it-qty-ok": await this.commitQty(ctx); break;
      default: break;
    }
  },

  hover(ctx, a, i) {
    const v = ctx.S.v;
    if (a === "it-row" && v.focus === "list" && v.idx !== i) { v.idx = i; return true; }
    if (a === "it-dest" && v.focus === "dest" && v.dest !== i) { v.dest = i; return true; }
    return false;
  },
};
