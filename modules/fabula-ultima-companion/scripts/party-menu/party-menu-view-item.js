// Party Menu — Item view.
//
// One list per bag: the party's shared bag and each character's own items.
// Q/E walk the bags, or click one in the portrait row; Enter on an item opens
// "Move to…", then a quantity for stacks. Reading is open to everyone in the
// party; moving follows moveRefusal (party-menu-inventory.js).

import {
  ITEM_TYPES, visibleItemFilters, itemType, sortedInventory, itemSummary, quantityOf, isWorn,
  bagsOf, moveRefusal, moveItem, useRefusal, useItem, orbmentOf,
  zenitMembersOf, zenitRefusal, moveZenit, conflictLive,
} from "./party-menu-inventory.js";
import { esc, safeHtml, play, SND, img, gridStep, portraitStrip, overlayFoot, kbd, zenitIcon, ZENIT_ICON } from "./party-menu-ui.js";
import { setBonusHTML } from "../linked-text/lt-setbonus.js";

const REASONS = {
  "same-bag": "It's already there.",
  "not-in-party": "Only party bags can trade items here.",
  "item-gone": "That item is gone.",
  "not-an-item": "That can't be moved on its own.",
  equipped: "Unequip it first.",
  "in-combat": "Items can't change hands during a conflict.",
  "not-yours": "That isn't yours to give away.",
  "carry-limit": "Already carrying one. Keep extras in the Party Bag.",
  carry_limit: "Already carrying one. Keep extras in the Party Bag.",
  "no-transfer-core": "Item transfer isn't loaded.",
  timeout: "No GM answered. A GM must be online to move items.",
  "not-granted": "The GM hasn't opened the Item menu to players.",
  "in-party-bag": "Move it to a character to use it.",
  "not-active": "Only characters in the active party can use items here.",
  "in-combat-use": "Use items with the Item action during a conflict.",
  "none-left": "There are none left.",
  "battle-only": "This item is used in battle, with the Item action.",
  "polymorph-form-missing": "That form isn't available yet.",
  "terrarium-not-dungeon": "Terrariums only work inside a dungeon.",
  "terrarium-not-controller": "Only the main controller can use a Terrarium.",
  "terrarium-in-combat": "Terrariums can't be used during a conflict.",
  "terrarium-missing": "The Terrarium system isn't loaded.",
  "no-healing-hud": "The healing menu isn't loaded.",
  "no-bag": "That bag is gone.",
  "transfer-failed": "The move failed — the item may have changed. Try again.",
  sender_quantity_zero_or_negative: "There are none left to move.",
  unregistered_request: "The Party Menu isn't loaded on the GM's client.",
  "in-combat-zenit": "Zenit can't change hands during a conflict.",
  "zenit-none": "Choose an amount first.",
  "zenit-short": "There isn't that much zenit to move.",
};
export const moveReason = (r) => REASONS[r] ?? `Could not move it (${r}).`;

// Orbment sockets as small gems (category colour; outlined = empty). The list
// hides them by default — they crowd it fast; O toggles a quick view of every
// item's sockets. The detail pane always lists them.
let _orbPips = false;
function orbPips(orb) {
  if (!orb?.length) return "";
  return `<span class="pm-orbpips">${orb.map((o, i) => `<i class="pm-gem ${o ? `is-${esc(o.category)}` : "is-empty"}" title="${esc(`Slot ${i + 1}: ${o ? o.label : "empty"}`)}"></i>`).join("")}</span>`;
}

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

// ── Zenit box: the Party Stash ⇄ a member's wallet (mockup v2, approved 2026-11-24) ──
// Port of https://claude.ai/artifact/5J7MVprV87fBkELxpB1zdR — same markup, keys and
// sounds. Rules live in zenitRefusal (party-menu-inventory.js).
const Z = {
  DIGITS: 5,            // 99,999 shown; widens when a wallet holds more
  START_DIGIT: 1,       // the thousands digit is under the cursor on open (DIGITS - 4)
  FLASH_MS: 900,        // the bag line's gold flash after a move (pmz-flash)
  SND_DONE_VOL: 0.55,
  HINT: "←→ digit · ↑↓ change · 0–9 type · Tab in/out · Q/E who · Z/Enter confirm · X/Esc cancel",
};
const fmtZ = (n) => Math.floor(Number(n) || 0).toLocaleString("en-US");
const zOf = (a) => Math.max(0, Math.floor(Number(a?.system?.props?.zenit) || 0));
const ownsActor = (a) => !!a?.testUserPermission?.(game.user, "OWNER");

/** May this user open the Zenit box from this bag? (the Party Bag, your own bag; the GM: any party bag) */
function zenitHere(ctx) {
  const bag = bagActor(ctx);
  const roster = ctx.roster();
  if (!bag) return false;
  if (bag.id === roster.db?.id) return game.user.isGM || zenitMembersOf(roster).some(ownsActor);
  return zenitMembersOf(roster).some((a) => a.id === bag.id) && (game.user.isGM || ownsActor(bag));
}
const zMember = (ctx) => game.actors?.get(ctx.S.v.z?.who) ?? null;
const zWhy = (ctx, member, dir) => zenitRefusal({ user: game.user, member, dir, roster: ctx.roster() });
function zSource(ctx) {
  const z = ctx.S.v.z;
  return z.dir === "deposit" ? zOf(zMember(ctx)) : zOf(ctx.roster().db);
}
const zDigits = (ctx) => Math.max(Z.DIGITS, String(zSource(ctx)).length);

function renderZenit(ctx) {
  const v = ctx.S.v, z = v.z, roster = ctx.roster();
  const m = zMember(ctx);
  if (!m) return "";
  const DIG = zDigits(ctx);
  const max = zSource(ctx);
  const amt = Math.min(z.amt, max);
  const digits = String(amt).padStart(DIG, "0").split("");
  const firstLit = digits.findIndex((d) => d !== "0");
  const digHtml = digits.map((d, i) => `${i > 0 && (DIG - i) % 3 === 0 ? `<span class="pm-zcomma">,</span>` : ""}<div class="pm-zdig ${i === z.dig ? "is-sel" : ""} ${firstLit !== -1 && i >= firstLit ? "is-lit" : ""}">
      <button type="button" class="pm-hit" data-action="z-dig" data-i="${i}" data-d="1" aria-label="Up">▲</button><span data-action="z-sel" data-i="${i}" class="pm-hit">${d}</span>
      <button type="button" class="pm-hit" data-action="z-dig" data-i="${i}" data-d="-1" aria-label="Down">▼</button></div>`).join("");
  const mz = zOf(m), sz = zOf(roster.db);
  const cls = (after, before) => (after > before ? "up" : after < before ? "down" : "");
  const memberPocket = (after) => `<div class="pm-zpocket"><div class="pm-portrait xs">${img(m.img)}</div><div style="min-width:0">
      <div class="pm-zname">${esc(m.name)}</div><div class="pm-znums">${fmtZ(mz)} → <b class="${cls(after, mz)}">${fmtZ(after)}</b> z</div></div></div>`;
  const stashPocket = (after) => `<div class="pm-zpocket"><div class="pm-portrait xs"><i class="fas fa-sack-dollar pm-bagicon"></i></div><div style="min-width:0">
      <div class="pm-zname">Party Stash</div><div class="pm-znums">${fmtZ(sz)} → <b class="${cls(after, sz)}">${fmtZ(after)}</b> z</div></div></div>`;
  const flow = z.dir === "deposit"
    ? `${memberPocket(mz - amt)}<i class="fas fa-arrow-right pm-zarrow"></i>${stashPocket(sz + amt)}`
    : `${stashPocket(sz - amt)}<i class="fas fa-arrow-right pm-zarrow"></i>${memberPocket(mz + amt)}`;
  const chips = zenitMembersOf(roster).map((x) => {
    const why = zWhy(ctx, x, z.dir);
    const reserve = roster.reserve.some((r) => r.id === x.id);
    return `<span class="pm-pchip pm-hit ${x.id === z.who ? "is-on" : ""} ${why ? "is-no" : ""} ${reserve ? "is-reserve" : ""}" data-action="z-who" data-id="${x.id}" title="${esc(why ? `${x.name}: ${moveReason(why)}` : x.name)}">${img(x.img)}</span>`;
  }).join("");
  const srcName = z.dir === "deposit" ? m.name : "The Party Stash";
  const note = z.capped ? `<div class="pm-locked"><i class="fas fa-circle-info"></i> ${esc(srcName)} only has ${fmtZ(max)} z.</div>` : "";
  const label = z.dir === "deposit" ? "Put in" : "Take out";
  return `<div class="pm-picker-veil"></div>
    <div class="pm-win pm-picker pm-zbox">
      <div class="pm-picker-head"><span class="pm-label">Zenit</span>
        <div class="pm-ztabs"><span class="pm-tab pm-hit ${z.dir === "deposit" ? "is-on" : ""}" data-action="z-dir" data-dir="deposit"><i class="fas fa-arrow-down"></i>Put in</span>
        <span class="pm-tab pm-hit ${z.dir === "withdraw" ? "is-on" : ""}" data-action="z-dir" data-dir="withdraw"><i class="fas fa-arrow-up"></i>Take out</span>${kbd("Tab")}</div></div>
      <div class="pm-zwho">${kbd("q")}${chips}${kbd("e")}</div>
      <div class="pm-zflow">${flow}</div>
      <div class="pm-zamt is-cursor"><div class="pm-zdigits">${digHtml}<span class="pm-zunit">&nbsp;z</span></div>
        <div class="pm-zquick"><button type="button" class="pm-btn pm-hit" data-action="z-max">All ${kbd("A")}</button><button type="button" class="pm-btn pm-hit" data-action="z-clear">Clear</button></div></div>
      ${note}
      <div class="pm-pickfoot"><span class="pm-hint">${esc(Z.HINT)}</span>
        <button type="button" class="pm-btn pm-hit" data-action="z-cancel">Cancel</button>
        <button type="button" class="pm-btn pm-hit is-go" data-action="z-go"${amt > 0 ? "" : " disabled"}>${label}</button></div>
    </div>`;
}

export const itemView = {
  id: "item",
  title: "Item",

  // ── Zenit box ──
  openZenit(ctx, { quiet = false } = {}) {
    const v = ctx.S.v;
    if (!zenitHere(ctx)) { play(SND.buzz, 0.5); return; }
    if (conflictLive()) { play(SND.buzz, 0.5); ctx.toast(moveReason("in-combat-zenit")); return; }
    const roster = ctx.roster();
    const bag = bagActor(ctx);
    const members = zenitMembersOf(roster);
    const fromStash = bag.id === roster.db?.id;
    const dir = fromStash ? "withdraw" : "deposit";
    const own = members.find((a) => a.id === game.user.character?.id) ?? members.find((a) => !game.user.isGM && ownsActor(a));
    let who = fromStash ? (game.user.isGM ? members[0] : own ?? members[0])?.id : bag.id;
    if (!who) { play(SND.buzz, 0.5); return; }
    if (zWhy(ctx, game.actors.get(who), dir)) who = members.find((a) => !zWhy(ctx, a, dir))?.id ?? who;
    v.z = { dir, who, amt: 0, dig: Z.START_DIGIT, capped: false };
    v.focus = "zenit";
    if (!quiet) play(SND.ok);
    ctx.render();
  },

  zSetAmt(ctx, n) {
    const z = ctx.S.v.z, max = zSource(ctx);
    n = Math.max(0, Math.floor(n));
    z.capped = n > max;
    z.amt = Math.min(n, max, 10 ** zDigits(ctx) - 1);
    if (z.capped) play(SND.buzz, 0.4);
  },

  zStep(ctx, i, d) {
    const place = 10 ** (zDigits(ctx) - 1 - i);
    const cur = Math.floor(ctx.S.v.z.amt / place) % 10;
    if (d < 0 && cur === 0) { play(SND.buzz, 0.4); return; }
    this.zSetAmt(ctx, ctx.S.v.z.amt + d * place);
    if (!ctx.S.v.z.capped) play(SND.move, 0.5);
  },

  zCycleWho(ctx, d) {
    const z = ctx.S.v.z;
    const ok = zenitMembersOf(ctx.roster()).filter((a) => !zWhy(ctx, a, z.dir));
    if (ok.length < 2) { play(SND.buzz, 0.4); return; }
    const i = ok.findIndex((a) => a.id === z.who);
    z.who = ok[(i + d + ok.length) % ok.length].id;
    this.zSetAmt(ctx, z.amt);
    play(SND.move);
  },

  zSetDir(ctx, dir) {
    const z = ctx.S.v.z;
    z.dir = dir;
    if (zWhy(ctx, zMember(ctx), dir)) z.who = zenitMembersOf(ctx.roster()).find((a) => !zWhy(ctx, a, dir))?.id ?? z.who;
    this.zSetAmt(ctx, z.amt);
    play(SND.move);
  },

  zClose(ctx) {
    Object.assign(ctx.S.v, { focus: "list", z: null });
  },

  async zConfirm(ctx) {
    const v = ctx.S.v, z = v.z;
    if (!z) return;
    const amt = Math.min(z.amt, zSource(ctx));
    if (amt <= 0) { play(SND.buzz, 0.5); return; }
    const member = zMember(ctx);
    ctx.setBusy(true);
    let res;
    try { res = await moveZenit(member, z.dir, amt); }
    catch (e) { console.error("[PartyMenu] zenit move failed", e); res = { ok: false, reason: e?.message ?? "error" }; }
    finally { ctx.setBusy(false); }
    if (!ctx.S.v) return;
    if (res?.ok) {
      play(SND.done, Z.SND_DONE_VOL);
      this.zClose(ctx);
      v.zflash = Date.now();
      ctx.render();
    } else {
      play(SND.buzz, 0.5);
      ctx.toast(moveReason(res?.reason));
    }
  },

  zKey(ctx, k) {
    const z = ctx.S.v.z;
    const DIG = zDigits(ctx);
    if (k === "ArrowLeft") { z.dig = Math.max(0, z.dig - 1); play(SND.move, 0.4); }
    else if (k === "ArrowRight") { z.dig = Math.min(DIG - 1, z.dig + 1); play(SND.move, 0.4); }
    else if (k === "ArrowUp") this.zStep(ctx, z.dig, 1);
    else if (k === "ArrowDown") this.zStep(ctx, z.dig, -1);
    else if (k === "Tab") this.zSetDir(ctx, z.dir === "deposit" ? "withdraw" : "deposit");
    else if (k === "q" || k === "Q" || k === "PageUp") this.zCycleWho(ctx, -1);
    else if (k === "e" || k === "E" || k === "PageDown") this.zCycleWho(ctx, 1);
    else if (k === "a" || k === "A") { this.zSetAmt(ctx, zSource(ctx)); z.capped = false; play(SND.move); }
    else if (/^[0-9]$/.test(k)) { this.zSetAmt(ctx, (z.amt * 10 + Number(k)) % 10 ** DIG); play(SND.move, 0.4); }
    else if (k === "Backspace") { z.amt = Math.floor(z.amt / 10); z.capped = false; play(SND.back, 0.4); }
    else if (k === "Enter") { this.zConfirm(ctx); return; }
    else if (k === "Escape") { this.zClose(ctx); play(SND.back); }
    else return;
    ctx.render();
  },

  /** Mouse wheel over a digit turns it (the mockup's wheel). */
  wheel(ctx, ev) {
    const d = ev.target?.closest?.(".pm-zdig");
    if (!d || ctx.S.v?.focus !== "zenit") return false;
    const i = [...d.parentElement.querySelectorAll(".pm-zdig")].indexOf(d);
    ctx.S.v.z.dig = i;
    this.zStep(ctx, i, ev.deltaY < 0 ? 1 : -1);
    ctx.render();
    return true;
  },

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
    if ((v.focus === "list" || v.focus === "zenit") && zenitHere(ctx)) {
      const why = conflictLive() ? moveReason("in-combat-zenit") : "";
      actions.push({ key: "g", label: "Zenit", img: ZENIT_ICON, disabled: !!why, title: why || "Put zenit in the Party Stash or take it out" });
    }
    if (v.focus === "list") actions.push({ key: "o", label: _orbPips ? "Hide Orbment" : "Show Orbment", icon: "fa-gem" });
    return { crumbs, actions };
  },

  render(ctx) {
    const v = ctx.S.v;
    const bag = bagActor(ctx);
    if (!bag) return `<div class="pm-win pm-empty">No bags.</div>`;
    const roster = ctx.roster();
    const items = list(ctx);
    // The item a Move overlay was open for went away (moved by someone else).
    if (v.focus !== "list" && v.focus !== "zenit" && !pinned(ctx)) Object.assign(v, { focus: "list", itemId: null, qty: null });
    // The Zenit box's member left the party (or the box may no longer open here).
    if (v.focus === "zenit" && (!zMember(ctx) || !zenitHere(ctx))) this.zClose(ctx);
    const sel = current(ctx);
    const isParty = bag.id === roster.db?.id;

    const filters = visibleItemFilters();
    if (!filters.some((f) => f.id === v.filter)) v.filter = "all";
    const tabs = filters.map((f) => `
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
          <span class="pm-skill-name">${esc(it.name)}${worn ? `<i class="pm-badge pm-worn" title="Equipped">E</i>` : ""}${_orbPips ? orbPips(orbmentOf(it)) : ""}</span>
          <span class="pm-skill-cost pm-qty">${qty > 1 || t === "consumable" ? `×${qty}` : ""}</span>
        </div>`;
    }).join("") || `<div class="pm-empty">Nothing under this filter.</div>`;

    // The bag line names the zenit there; where the Zenit box opens, the amount opens it.
    const zHere = zenitHere(ctx);
    const flash = v.zflash && Date.now() - v.zflash < Z.FLASH_MS ? "is-flash" : "";
    const zAmt = zHere
      ? `<span class="pm-subz pm-hit ${flash}" data-action="it-zenit" title="Open the Zenit box">${zenitIcon()} <b>${fmtZ(zOf(bag))}</b> z</span>`
      : `${zenitIcon()} ${fmtZ(zOf(bag))} z`;
    const sub = isParty
      ? `Shared by the party · ${zAmt} · ${items.length} shown`
      : `${game.user.isGM ? "Bag" : bag.isOwner ? "Your bag" : "Teammate's bag"} · ${zAmt}`;

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
      ${v.focus === "qty" && sel ? this.renderQty(ctx, sel) : ""}
      ${v.focus === "zenit" && v.z ? renderZenit(ctx) : ""}`;
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
      ${s.setDescription ? `<div class="pm-label">Set bonus</div>${safeHtml(setBonusHTML(item) || s.setDescription)}` : ""}
      ${s.orbment?.length ? `<div class="pm-label">Orbment · ${s.orbment.filter(Boolean).length}/${s.orbment.length}</div><div class="pm-orbs">${s.orbment.map((o, i) => `
        <div class="pm-orb" title="Slot ${i + 1}"><i class="pm-gem ${o ? `is-${esc(o.category)}` : "is-empty"}"></i>
          <span class="pm-orb-txt"><b>${esc(o ? o.label : "Empty")}</b>${o?.summary ? `<small>${esc(o.summary)}</small>` : ""}</span></div>`).join("")}</div>` : ""}</div>`;
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
        ${overlayFoot("↑↓ choose · Z/Enter confirm · X/Esc cancel")}
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
        ${overlayFoot("←→ amount · Z/Enter move · X/Esc back")}
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
    if (!it) { play(SND.buzz, 0.5); return; }
    const dests = destinations(ctx, it);
    if (!dests.some((d) => !d.refusal)) { play(SND.buzz, 0.5); if (dests[0]) ctx.toast(moveReason(dests[0].refusal)); return; }
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
    if (v.focus === "zenit") return this.zKey(ctx, k);
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
      const fs = visibleItemFilters(), i = fs.findIndex((f) => f.id === v.filter);
      return this.setFilter(ctx, fs[(i + (ev.shiftKey ? -1 : 1) + fs.length) % fs.length].id);
    }
    if (k === "Escape") return ctx.back();
    if (k === "o" || k === "O") { _orbPips = !_orbPips; play(SND.ok, 0.45); ctx.render(); return; }
    if (k === "g" || k === "G") return this.openZenit(ctx);
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
      case "it-zenit": if (v.focus === "list") this.openZenit(ctx); break;
      case "z-dir": if (v.z && v.z.dir !== el.dataset.dir) { this.zSetDir(ctx, el.dataset.dir); ctx.render(); } break;
      case "z-who": {
        if (!v.z) break;
        const m = game.actors?.get(el.dataset.id);
        if (!m || zWhy(ctx, m, v.z.dir)) { play(SND.buzz, 0.4); break; }
        v.z.who = m.id; this.zSetAmt(ctx, v.z.amt); play(SND.move); ctx.render();
        break;
      }
      case "z-dig": if (v.z) { v.z.dig = Number(el.dataset.i); this.zStep(ctx, v.z.dig, Number(el.dataset.d)); ctx.render(); } break;
      case "z-sel": if (v.z) { v.z.dig = Number(el.dataset.i); play(SND.move, 0.4); ctx.render(); } break;
      case "z-max": if (v.z) { this.zSetAmt(ctx, zSource(ctx)); v.z.capped = false; play(SND.move); ctx.render(); } break;
      case "z-clear": if (v.z) { v.z.amt = 0; v.z.capped = false; play(SND.back, 0.5); ctx.render(); } break;
      case "z-cancel": if (v.z) { this.zClose(ctx); play(SND.back); ctx.render(); } break;
      case "z-go": if (v.z) await this.zConfirm(ctx); break;
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
