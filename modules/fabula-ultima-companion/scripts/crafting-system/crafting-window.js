// scripts/crafting-system/crafting-window.js
//
// THE CRAFTING WINDOW — Shop skin (shopWindow-app.js palette, Signika, gold /
// parchment), custom DOM, never a Foundry Dialog.
//
//   CraftPanel   the list + preview + Craft button. Reused by Camp Forge
//                (camp-forge.js embeds it in its own window, read-only for
//                spectators, mirrored over the camp-forge socket).
//   CraftWindow  the standalone window around a panel, for a Crafter NPC
//                (place "npc") or a crafting table Region (place "table").
//
// Sounds are the Shop's (open / tab / select / cancel) plus the Alchemist's
// "working" and "done" cues; all local to the person at the window.

import { TAG, CATEGORIES, MAX_QTY, ZENIT_ICON, esc, playSfx, rarityColor, readZenit, readIp } from "./crafting-const.js";
import { readConfig, getBook, evaluate, maxQty, outputView, blueprintTitle, categoryOf, isUnlocked, partyStash, reasonText } from "./crafting-data.js";
import { craft, craftFailText } from "./crafting-craft.js";
import { markLocalDone } from "./crafting-feedback.js";

const STYLE_ID = "fu-craft-style";
const WIN_ID = "fu-craft-window";
const MIN_WORK_MS = 1100;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const zimg = `<img class="fu-craft-zi" src="${ZENIT_ICON}" alt="Zenit">`;
const stripHtml = (h) => { const d = document.createElement("div"); d.innerHTML = String(h ?? ""); return (d.textContent ?? "").replace(/\s+/g, " ").trim(); };
const syncDoc = (uuid) => { try { return uuid ? fromUuidSync(uuid) : null; } catch { return null; } };

// ── Panel ────────────────────────────────────────────────────────────────────
export class CraftPanel {
  // opts: { root, place, bookId, actor, readOnly, onCraft(blueprintId, qty), onChange(state), campDone }
  constructor(opts) {
    this.o = opts;
    this.tab = "all";
    this.onlyReady = false;
    this.sel = null;
    this.qty = 1;
    this.phase = "pick";          // pick | working | result
    this.result = null;
    this.stash = null;
    injectStyles();
  }

  get book() { return getBook(this.o.bookId, readConfig()); }
  get actor() { return this.o.actor ? (game.actors?.get(this.o.actor.id) ?? this.o.actor) : null; }
  ctx() { return { actor: this.actor, stash: this.stash, book: this.book, place: this.o.place, campDone: !!this.o.campDone }; }
  state() { return { tab: this.tab, onlyReady: this.onlyReady, sel: this.sel, qty: this.qty }; }

  async refresh() {
    this.stash = await partyStash();
    this.render();
  }

  // Spectator: take the operator's view.
  mirror(s = {}) {
    const before = this.sel, beforeTab = this.tab;
    if (s.tab) this.tab = s.tab;
    if (typeof s.onlyReady === "boolean") this.onlyReady = s.onlyReady;
    if ("sel" in s) this.sel = s.sel;
    if (s.qty) this.qty = s.qty;
    if (this.tab !== beforeTab) playSfx("tab");
    else if (this.sel !== before) playSfx("select");
    this.render();
  }

  changed() { try { this.o.onChange?.(this.state()); } catch {} }

  render() {
    const root = this.o.root;
    if (!root?.isConnected) return;
    const book = this.book;
    if (!book) { root.innerHTML = `<div class="fu-craft fu-craft-empty">No Blueprint book is set up here yet.</div>`; return; }
    const ctx = this.ctx();
    const all = book.blueprints;
    const cats = CATEGORIES.filter((c) => c.key === "all" || all.some((bp) => categoryOf(bp) === c.key));
    if (!cats.some((c) => c.key === this.tab)) this.tab = "all";
    const rows = all
      .filter((bp) => this.tab === "all" || categoryOf(bp) === this.tab)
      .filter((bp) => !this.onlyReady || evaluate(bp, ctx, 1).ok);
    if (!this.sel || !all.some((b) => b.id === this.sel)) this.sel = rows[0]?.id ?? all[0]?.id ?? null;
    const ready = all.filter((bp) => evaluate(bp, ctx, 1).ok).length;
    const ro = !!this.o.readOnly;

    root.innerHTML = `
      <div class="fu-craft${ro ? " is-ro" : ""}">
        <div class="fu-craft-body">
          <div class="fu-craft-tabs" role="tablist" aria-label="Category">${cats.map((c) => `
            <button type="button" class="fu-craft-tab${c.key === this.tab ? " active" : ""}" role="tab" aria-selected="${c.key === this.tab}"
              data-tab="${c.key}" data-tooltip="${esc(c.label)}" aria-label="${esc(c.label)}" ${ro ? "disabled" : ""}><i class="${c.icon}"></i></button>`).join("")}
          </div>
          <div class="fu-craft-listwrap">
            <div class="fu-craft-filters">
              <label><input type="checkbox" class="fu-craft-ready" ${this.onlyReady ? "checked" : ""} ${ro ? "disabled" : ""}> Craftable only</label>
              <span class="fu-craft-count">${ready} ready</span>
            </div>
            <div class="fu-craft-list">${rows.length ? rows.map((bp) => this.rowHtml(bp, ctx)).join("") : `<div class="fu-craft-empty">Nothing here yet.</div>`}</div>
          </div>
        </div>
        <div class="fu-craft-prev">${this.previewHtml(ctx)}</div>
        ${this.phase !== "pick" ? `<div class="fu-craft-ovl">${this.overlayHtml()}</div>` : ""}
      </div>`;
    if (!ro) this.bind(root);
    else root.querySelectorAll(".fu-craft-link").forEach((b) => b.addEventListener("click", (ev) => this.openItem(ev, b.dataset.uuid)));
  }

  rowHtml(bp, ctx) {
    const known = isUnlocked(bp);
    const ev = evaluate(bp, ctx, 1);
    const out = bp.outputs[0] ? outputView(bp.outputs[0]) : null;
    const title = known ? blueprintTitle(bp) : "???";
    const single = bp.outputs.length === 1 && out?.qty > 1 ? out.qty : 0;
    const mats = bp.materials.map((m, i) => {
      const e = ev.mats[i];
      return `<span class="fu-craft-m${e.ok ? "" : " no"}"><img src="${esc(m.img || "icons/svg/item-bag.svg")}" alt="">${known ? `${e.bag + e.stash}/${e.per}` : "?"}</span>`;
    }).join("");
    const cost = !known ? "" : [ev.unit.zenit ? `<span>${zimg}${ev.unit.zenit.toLocaleString()}</span>` : "", ev.unit.ip ? `<span class="ip">${ev.unit.ip} IP</span>` : "",
      !ev.unit.zenit && !ev.unit.ip ? `<span class="free">Free</span>` : ""].join("");
    const state = !known ? `<span class="fu-craft-state">Unknown</span>` : ev.ok ? `<span class="fu-craft-state ok">Ready</span>` : `<span class="fu-craft-state no">Missing</span>`;
    return `<button type="button" class="fu-craft-row${bp.id === this.sel ? " sel" : ""}${ev.ok ? "" : " short"}${known ? "" : " locked"}" data-bp="${esc(bp.id)}">
      <span class="fu-craft-ic">${out && known ? `<img src="${esc(out.img)}" alt="">` : `<i class="fas fa-question"></i>`}${single ? `<span class="q">×${single}</span>` : ""}</span>
      <span class="fu-craft-rmid"><span class="fu-craft-rname">${esc(title)}</span><span class="fu-craft-mats">${mats}</span>
        ${!known && bp.hint ? `<span class="fu-craft-hint">${esc(bp.hint)}</span>` : ""}</span>
      <span class="fu-craft-rcost">${cost}${state}</span>
    </button>`;
  }

  previewHtml(ctx) {
    const bp = this.book?.blueprints.find((b) => b.id === this.sel);
    if (!bp) return `<div class="fu-craft-empty">Pick a Blueprint.</div>`;
    const known = isUnlocked(bp);
    const camp = this.o.place === "camp";
    const top = maxQty(bp, ctx, MAX_QTY);
    if (camp) this.qty = 1;
    else this.qty = Math.max(1, Math.min(this.qty, top));
    const ev = evaluate(bp, ctx, this.qty);
    const outs = bp.outputs.map(outputView);
    const first = outs[0] ? syncDoc(outs[0].uuid) : null;
    const value = Number(first?.system?.props?.item_cost) || 0;
    const desc = known ? stripHtml(first?.system?.props?.description).slice(0, 240) : (bp.hint || "You don't know this Blueprint yet.");
    const outsHtml = known ? outs.map((o) => `<span class="fu-craft-out"><span class="fu-craft-ic"><img src="${esc(o.img)}" alt=""></span>
        <span><button type="button" class="fu-craft-link" data-uuid="${esc(o.uuid)}" style="--c:${rarityColor(o.rarity)}">${esc(o.name)}</button>
        <span class="fu-craft-yield">×${o.qty * this.qty}</span></span></span>`).join("")
      : `<span class="fu-craft-out"><span class="fu-craft-ic"><i class="fas fa-question"></i></span><b>Unknown Blueprint</b></span>`;
    const mats = bp.materials.map((m, i) => {
      const e = ev.mats[i];
      return `<div class="fu-craft-mline${e.ok ? "" : " no"}"><span class="fu-craft-ic sm"><img src="${esc(m.img || "icons/svg/item-bag.svg")}" alt=""></span>
        <span class="fu-craft-mtxt"><span class="nm">${known ? esc(m.name) : "???"}</span><span class="src">Bag ${e.bag} · Stash ${e.stash}</span></span>
        <span class="hn">${e.bag + e.stash} / ${e.need}</span></div>`;
    }).join("") || `<div class="fu-craft-empty sm">No materials needed.</div>`;
    const costBits = [];
    if (known && ev.cost.zenit) costBits.push(`<span>Fee <span class="v${ev.cost.zenit > ev.zenit ? " no" : ""}">${zimg}${ev.cost.zenit.toLocaleString()}</span></span>`);
    if (known && ev.cost.ip) costBits.push(`<span>IP <span class="v ipv${ev.cost.ip > ev.ip.cur ? " no" : ""}">${ev.cost.ip} of ${ev.ip.cur}</span></span>`);
    if (known && !ev.cost.zenit && !ev.cost.ip) costBits.push(`<span class="free">No fee</span>`);
    const ro = !!this.o.readOnly;
    const qtyHtml = camp ? `<span class="fu-craft-pill1">1 item</span>`
      : `<span class="fu-craft-qty"><button type="button" class="fu-craft-q" data-d="-1" aria-label="Less" ${this.qty <= 1 || ro ? "disabled" : ""}>−</button>
          <output>${this.qty}</output><button type="button" class="fu-craft-q" data-d="1" aria-label="More" ${this.qty >= top || ro ? "disabled" : ""}>+</button></span>`;
    return `
      <div class="fu-craft-pl">
        <div class="fu-craft-outs">${outsHtml}</div>
        <div class="fu-craft-pills">${known && outs[0] ? `<span class="fu-craft-pill"><b>Type</b><span>${esc(outs[0].type || "item")}</span></span>` : ""}
          ${known && value ? `<span class="fu-craft-pill"><b>Shop value</b><span>${value.toLocaleString()} z</span></span>` : ""}</div>
        <div class="fu-craft-desc">${esc(desc)}</div>
      </div>
      <div class="fu-craft-pr">
        <div class="fu-craft-h4">Materials</div>
        <div class="fu-craft-mgrid">${mats}</div>
        <div class="fu-craft-costline">${costBits.join("")}</div>
        <div class="fu-craft-act">${qtyHtml}
          <button type="button" class="fu-craft-go" ${ev.ok && !ro && this.phase === "pick" ? "" : "disabled"}>Craft</button>
          ${ev.ok ? "" : `<span class="fu-craft-why">${esc(reasonText(ev, this.actor?.name))}</span>`}
        </div>
      </div>`;
  }

  overlayHtml() {
    if (this.phase === "working") {
      return `<div class="fu-craft-card"><div class="fu-craft-hammer"><i class="fas fa-hammer"></i></div>
        <div>${esc(this.actor?.name ?? "")} is crafting…</div><div class="fu-craft-bar"><i></i></div></div>`;
    }
    const r = this.result;
    if (!r?.ok) return "";
    const icons = r.outputs.map((o) => `<span class="fu-craft-ic lg"><img src="${esc(o.img)}" alt="">${o.qty > 1 ? `<span class="q">×${o.qty}</span>` : ""}</span>`).join("");
    const names = r.outputs.map((o) => `<b>${esc(o.name)}${o.qty > 1 ? ` ×${o.qty}` : ""}</b>`).join(" + ");
    return `<div class="fu-craft-card done"><div class="fu-craft-big">${icons}</div><div>Crafted ${names}</div>
      <div class="fu-craft-sub">Added to ${esc(r.actorName)}'s bag.</div>
      ${this.o.readOnly || this.o.place === "camp" ? "" : `<button type="button" class="fu-craft-ok">OK</button>`}</div>`;
  }

  openItem(ev, uuid) {
    if (!uuid) return;
    ev.preventDefault(); ev.stopPropagation();
    try { globalThis.FULinkedText?.openItem?.(uuid, { x: ev.clientX - 160, y: ev.clientY + 24 }); } catch (e) { console.warn(TAG, e); }
  }

  bind(root) {
    root.querySelectorAll(".fu-craft-tab").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.tab === this.tab) return;
      this.tab = b.dataset.tab; playSfx("tab"); this.changed(); this.render();
    }));
    root.querySelector(".fu-craft-ready")?.addEventListener("change", (e) => {
      this.onlyReady = e.target.checked; playSfx("tab"); this.changed(); this.render();
    });
    root.querySelectorAll(".fu-craft-row").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.bp === this.sel) return;
      this.sel = b.dataset.bp; this.qty = 1; playSfx("select"); this.changed(); this.render();
    }));
    root.querySelectorAll(".fu-craft-q").forEach((b) => b.addEventListener("click", () => {
      this.qty = Math.max(1, this.qty + Number(b.dataset.d)); playSfx("select"); this.changed(); this.render();
    }));
    root.querySelectorAll(".fu-craft-link").forEach((b) => b.addEventListener("click", (ev) => this.openItem(ev, b.dataset.uuid)));
    root.querySelector(".fu-craft-go")?.addEventListener("click", () => {
      if (this.phase !== "pick" || !this.sel) return;
      this.o.onCraft?.(this.sel, this.qty);
    });
    root.querySelector(".fu-craft-ok")?.addEventListener("click", () => { this.phase = "pick"; this.result = null; playSfx("select"); this.refresh(); });
  }

  toWorking() { this.phase = "working"; playSfx("craft"); this.render(); }
  toPick() { this.phase = "pick"; this.result = null; this.render(); }
  toResult(res) {
    this.phase = "result";
    this.result = res;
    markLocalDone();
    playSfx("done");
    this.render();
    const card = this.o.root.querySelector(".fu-craft-card.done");
    if (card) burst(card);
  }
}

function burst(card) {
  const GLYPH = ["✦", "★", "✧"];
  for (let i = 0; i < 14; i++) {
    const s = document.createElement("span");
    s.className = "fu-craft-spark";
    s.textContent = GLYPH[i % 3];
    const a = (i / 14) * Math.PI * 2;
    s.style.setProperty("--dx", `${Math.cos(a) * 90}px`);
    s.style.setProperty("--dy", `${Math.sin(a) * 60}px`);
    card.appendChild(s);
    setTimeout(() => s.remove(), 1000);
  }
}

// ── Standalone window (NPC / table) ──────────────────────────────────────────
export class CraftWindow {
  static _cur = null;

  // opts: { place: "npc"|"table", bookId, actor (the crafter), title, portrait, quote, sourceName }
  static open(opts) {
    this._cur?.close(true);
    const w = new CraftWindow(opts);
    this._cur = w;
    w.build();
    return w;
  }
  static get current() { return this._cur; }

  constructor(opts) { this.o = opts; this._hooks = []; }

  build() {
    injectStyles();
    const o = this.o;
    const el = document.createElement("div");
    el.id = WIN_ID;
    el.innerHTML = `
      <div class="fu-craft-win" role="dialog" aria-label="${esc(o.title ?? "Craft")}">
        <div class="fu-craft-titlebar"><span><i class="fas fa-screwdriver-wrench"></i> ${esc(o.title ?? "Craft")}</span>
          <button type="button" class="fu-craft-x" aria-label="Close"><i class="fas fa-xmark"></i></button></div>
        <div class="fu-craft-head"></div>
        <div class="fu-craft-who"></div>
        <div class="fu-craft-host"></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.panel = new CraftPanel({ root: el.querySelector(".fu-craft-host"), place: o.place, bookId: o.bookId, actor: o.actor,
      onCraft: (id, qty) => this.doCraft(id, qty) });
    el.querySelector(".fu-craft-x").addEventListener("click", () => this.close());
    this._onKey = (ev) => { if (ev.key === "Escape" && this.panel.phase !== "working") { ev.stopPropagation(); this.close(); } };
    document.addEventListener("keydown", this._onKey, true);
    this.drag(el.querySelector(".fu-craft-titlebar"), el.querySelector(".fu-craft-win"));
    this.watch();
    this.renderHead();
    this.panel.refresh();
    requestAnimationFrame(() => el.classList.add("is-open"));
    playSfx("open");
  }

  renderHead() {
    const o = this.o, a = this.panel?.actor ?? o.actor;
    const ip = readIp(a);
    this.el.querySelector(".fu-craft-head").innerHTML = `
      ${o.portrait ? `<img class="fu-craft-portrait" src="${esc(o.portrait)}" alt="">` : `<span class="fu-craft-portrait ph"><i class="fas fa-screwdriver-wrench"></i></span>`}
      <div class="fu-craft-hinfo">
        <div class="fu-craft-hname">${esc(o.sourceName ?? "")} <span class="fu-craft-tagpill">${o.place === "npc" ? "Crafter" : "Crafting spot"}</span></div>
        ${o.quote ? `<div class="fu-craft-quote">${esc(o.quote)}</div>` : ""}
        <div class="fu-craft-wallet"><span>Zenit <span class="v">${zimg}${readZenit(a).toLocaleString()}</span></span><span>IP <span class="v ipv">${ip.cur} / ${ip.max}</span></span></div>
      </div>`;
    this.el.querySelector(".fu-craft-who").innerHTML = `<span>Crafter</span>
      <span class="fu-craft-chip"><img src="${esc(a?.img ?? "")}" alt="">${esc(a?.name ?? "?")}</span>
      <span class="fu-craft-note">Materials come from ${esc(a?.name ?? "the crafter")}'s bag, then the party stash.</span>`;
  }

  // Live numbers: re-render when the crafter, the stash or their items change.
  watch() {
    let t = null;
    const kick = () => { clearTimeout(t); t = setTimeout(() => { if (!this.el) return; this.renderHead(); if (this.panel.phase === "pick") this.panel.refresh(); }, 120); };
    const mine = (actor) => actor && (actor.id === this.o.actor?.id || actor.id === this.panel?.stash?.id);
    const on = (hook, fn) => this._hooks.push([hook, Hooks.on(hook, fn)]);
    on("updateActor", (a) => { if (mine(a)) kick(); });
    for (const h of ["createItem", "updateItem", "deleteItem"]) on(h, (i) => { if (mine(i?.parent)) kick(); });
    on("updateItem", (i) => { if (i?.name === "_Crafting Config") kick(); });
  }

  async doCraft(blueprintId, qty) {
    const p = this.panel;
    p.toWorking();
    const [res] = await Promise.all([
      craft({ bookId: this.o.bookId, blueprintId, place: this.o.place, actorId: this.o.actor.id, qty }),
      wait(MIN_WORK_MS),
    ]);
    if (!this.el) return;
    if (res?.ok) { p.toResult(res); this.renderHead(); }
    else {
      playSfx("cancel");
      ui.notifications?.warn(`Crafting | ${craftFailText(res)}`);
      p.toPick();
      p.refresh();
    }
  }

  drag(handle, box) {
    let sx = 0, sy = 0, dx = 0, dy = 0, ox = 0, oy = 0, on = false;
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("button")) return;
      on = true; sx = ev.clientX; sy = ev.clientY; ox = dx; oy = dy;
      handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!on) return;
      dx = Math.round(ox + ev.clientX - sx); dy = Math.round(oy + ev.clientY - sy);
      box.style.translate = `${dx}px ${dy}px`;
    });
    handle.addEventListener("pointerup", () => { on = false; });
  }

  close(instant = false) {
    const el = this.el;
    if (!el) return;
    this.el = null;
    for (const [h, id] of this._hooks) Hooks.off(h, id);
    this._hooks = [];
    document.removeEventListener("keydown", this._onKey, true);
    if (CraftWindow._cur === this) CraftWindow._cur = null;
    if (!instant) playSfx("cancel");
    if (instant) { el.remove(); return; }
    el.classList.remove("is-open");
    setTimeout(() => el.remove(), 200);
  }
}

// ── Styles (Shop palette) ────────────────────────────────────────────────────
export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${WIN_ID} { position: fixed; inset: 0; z-index: 9990; display: grid; place-items: center; pointer-events: none; opacity: 0; transition: opacity .2s ease; }
#${WIN_ID}.is-open { opacity: 1; }
#${WIN_ID} img { border: none !important; box-shadow: none; }
.fu-craft-win { pointer-events: auto; width: min(640px, 96vw); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden;
  background: #f0e6cc; color: #2c1f0e; border-radius: 10px; font-family: "Signika", sans-serif;
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 18px 44px rgba(0,0,0,.55); transform: translateY(10px); transition: transform .22s cubic-bezier(.2,.9,.2,1); }
#${WIN_ID}.is-open .fu-craft-win { transform: none; }
.fu-craft-titlebar { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: linear-gradient(180deg,#7a4e20,#5c3818); color: #fff6dd; font-size: 13px; cursor: move; user-select: none; }
.fu-craft-titlebar i { margin-right: 6px; }
.fu-craft-x { width: 26px !important; height: 26px; line-height: 1; padding: 0; border: 0; background: transparent; color: #fff6dd; cursor: pointer; flex: 0 0 auto; }
.fu-craft-x:hover { color: #ffd27a; }
.fu-craft-head { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; background: linear-gradient(to bottom,#e8d5a3,#dfc890); border-bottom: 2px solid #b89940; }
.fu-craft-portrait { width: 72px; height: 72px; border-radius: 8px; object-fit: contain; object-position: top; border: 2px solid #b89940 !important; background: #c8a84b; flex-shrink: 0; }
.fu-craft-portrait.ph { display: grid; place-items: center; font-size: 30px; color: #5a3800; }
.fu-craft-hinfo { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.fu-craft-hname { font-size: 15px; font-weight: 700; color: #5a3800; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.fu-craft-tagpill, .fu-craft-pill1 { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 10px; background: rgba(90,56,0,.12); color: #5a3800; border: 1px solid rgba(184,153,64,.55); }
.fu-craft-quote { font-size: 12px; font-style: italic; color: #5a3800; opacity: .9; border-left: 3px solid #b89940; background: rgba(255,255,255,.3); border-radius: 0 6px 6px 0; padding: 4px 8px; line-height: 1.4; }
.fu-craft-wallet { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; font-weight: 700; color: #5a3800; align-items: center; }
.fu-craft-wallet .v, .fu-craft-costline .v { color: #8b4513; display: inline-flex; gap: 3px; align-items: center; }
.fu-craft-wallet .ipv, .fu-craft-costline .ipv { color: #3d6fb0; }
.fu-craft-zi { width: 18px; height: 18px; object-fit: contain; vertical-align: middle; }
.fu-craft-who { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 12px; background: rgba(255,255,255,.35); border-bottom: 1px solid rgba(184,153,64,.55); font-size: 12px; color: #5a3800; }
.fu-craft-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px 2px 2px; border-radius: 20px; background: #c8a84b; border: 1px solid #8b6914; color: #2b1a05; font-weight: 600; }
.fu-craft-chip img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; object-position: top; }
.fu-craft-note { opacity: .75; }
.fu-craft-host { min-height: 0; overflow-y: auto; }

.fu-craft { position: relative; display: flex; flex-direction: column; background: #f0e6cc; color: #2c1f0e; font-family: "Signika", sans-serif; }
.fu-craft button { font-family: inherit; }
.fu-craft-body { display: flex; min-width: 0; }
.fu-craft-tabs { display: flex; flex-direction: column; gap: 2px; padding: 8px 4px; background: #e0c87a; border-right: 2px solid #b89940; flex-shrink: 0; }
.fu-craft-tab { width: 36px !important; height: 36px; padding: 0; border-radius: 8px; display: grid; place-items: center; font-size: 16px; cursor: pointer; border: 1px solid transparent; background: transparent; color: #5a3800; }
.fu-craft-tab:hover:not(:disabled) { background: rgba(139,105,20,.18); border-color: rgba(139,105,20,.35); }
.fu-craft-tab.active { background: #c8a84b; border-color: #8b6914; box-shadow: inset 0 1px 2px rgba(0,0,0,.25); }
.fu-craft-tab:disabled { cursor: default; }
.fu-craft-listwrap { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fu-craft-filters { display: flex; gap: 10px; align-items: center; padding: 6px 10px 0; font-size: 12px; color: #6b4c2a; }
.fu-craft-filters label { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.fu-craft-filters input { margin: 0; }
.fu-craft-count { margin-left: auto; }
.fu-craft-list { overflow-y: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; max-height: 262px; min-height: 120px; }
.fu-craft-list::-webkit-scrollbar { width: 5px; } .fu-craft-list::-webkit-scrollbar-thumb { background: #b89940; border-radius: 3px; }
.fu-craft-row { display: grid; grid-template-columns: 36px minmax(0,1fr) auto; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; width: 100%; height: auto; line-height: 1.3;
  background: rgba(255,255,255,.55); border: 1px solid rgba(184,153,64,.35); cursor: pointer; text-align: left; color: inherit; margin: 0; }
.fu-craft-row:hover { background: rgba(255,255,255,.8); }
.fu-craft-row.sel { background: rgba(200,168,75,.28); border-color: #b89940; outline: 1px solid rgba(184,153,64,.6); }
.fu-craft-row.short .fu-craft-rname { color: #6b4c2a; }
.fu-craft-row.locked { opacity: .75; }
.fu-craft-ic { position: relative; width: 34px; height: 34px; border-radius: 6px; border: 1px solid rgba(184,153,64,.5); background: #e8d5a3; display: grid; place-items: center; overflow: hidden; flex-shrink: 0; color: #5a3800; }
.fu-craft-ic img { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: pixelated; }
.fu-craft-ic.sm { width: 24px; height: 24px; border-radius: 4px; }
.fu-craft-ic.lg { width: 52px; height: 52px; border-radius: 10px; border-width: 2px; }
.fu-craft-ic .q { position: absolute; right: 1px; bottom: 0; font-size: 10px; font-weight: 700; color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000; }
.fu-craft-rmid { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fu-craft-rname { font-size: 13px; font-weight: 700; color: #3a2408; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fu-craft-hint { font-size: 11px; font-style: italic; color: #6b4c2a; }
.fu-craft-mats { display: flex; gap: 6px; flex-wrap: wrap; }
.fu-craft-m { display: inline-flex; gap: 2px; align-items: center; font-size: 11px; color: #6b4c2a; }
.fu-craft-m img { width: 16px; height: 16px; object-fit: contain; image-rendering: pixelated; }
.fu-craft-m.no { color: #b03a22; font-weight: 700; }
.fu-craft-rcost { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; font-size: 12px; font-weight: 700; color: #8b4513; white-space: nowrap; }
.fu-craft-rcost span { display: inline-flex; align-items: center; gap: 2px; }
.fu-craft-rcost .ip { color: #3d6fb0; } .fu-craft-rcost .free, .fu-craft .free { color: #3a7a3a; }
.fu-craft-state { font-size: 10px; letter-spacing: .03em; text-transform: uppercase; color: #6b4c2a; }
.fu-craft-state.ok { color: #3a7a3a; } .fu-craft-state.no { color: #b03a22; }
.fu-craft-empty { padding: 24px 12px; text-align: center; font-style: italic; color: #6b4c2a; opacity: .75; font-size: 13px; }
.fu-craft-empty.sm { padding: 6px; font-size: 12px; }

.fu-craft-prev { border-top: 2px solid #b89940; background: rgba(255,255,255,.35); padding: 10px 12px; display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 12px; }
.fu-craft-outs { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.fu-craft-out { display: flex; gap: 8px; align-items: center; font-size: 14px; }
.fu-craft-link { font: inherit; font-weight: 700; background: none; border: 0; padding: 0 2px; border-radius: 4px; cursor: pointer; display: inline; width: auto; height: auto; line-height: inherit;
  color: var(--c, #3a2408); text-decoration: underline dotted; text-underline-offset: 3px; }
.fu-craft-link:hover { background: rgba(201,164,74,.28); }
.fu-craft-yield { font-size: 12px; font-weight: 700; color: #8b4513; margin-left: 4px; }
.fu-craft-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.fu-craft-pill { display: flex; border-radius: 20px; overflow: hidden; border: 1px solid rgba(184,153,64,.6); font-size: 11px; }
.fu-craft-pill b { background: #d4b04a; color: #3a2408; padding: 2px 7px; font-weight: 700; }
.fu-craft-pill span { background: rgba(255,255,255,.7); color: #5a3800; padding: 2px 7px; font-weight: 700; text-transform: capitalize; }
.fu-craft-desc { font-size: 11.5px; color: #5a3800; line-height: 1.5; }
.fu-craft-h4 { font-size: 10px; font-weight: 800; color: #5a3800; letter-spacing: .06em; text-transform: uppercase; opacity: .7; margin-bottom: 5px; }
.fu-craft-mgrid { display: flex; flex-direction: column; gap: 4px; }
.fu-craft-mline { display: grid; grid-template-columns: 26px minmax(0,1fr) auto; gap: 7px; align-items: center; padding: 3px 6px; border-radius: 6px; background: rgba(255,255,255,.6); border: 1px solid rgba(184,153,64,.35); }
.fu-craft-mline.no { border-color: rgba(176,58,34,.45); background: #fbe9e2; }
.fu-craft-mtxt { display: flex; flex-direction: column; min-width: 0; }
.fu-craft-mtxt .nm { font-size: 12px; color: #3a2408; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fu-craft-mtxt .src { font-size: 10.5px; color: #6b4c2a; }
.fu-craft-mline .hn { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; color: #3a7a3a; }
.fu-craft-mline.no .hn { color: #b03a22; }
.fu-craft-costline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: #5a3800; font-weight: 600; }
.fu-craft-costline .v.no { color: #b03a22 !important; }
.fu-craft-act { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.fu-craft-qty { display: inline-flex; align-items: center; border: 1px solid #b89940; border-radius: 20px; overflow: hidden; background: rgba(255,255,255,.6); }
.fu-craft-qty button { width: 26px !important; height: 26px; padding: 0; line-height: 1; border: 0; background: transparent; font-size: 15px; cursor: pointer; color: #5a3800; }
.fu-craft-qty button:disabled { opacity: .3; cursor: default; }
.fu-craft-qty output { min-width: 30px; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
.fu-craft-go, .fu-craft-ok { width: auto !important; height: auto; line-height: 1.3; padding: 5px 18px; border-radius: 20px; font-size: 13px; font-weight: 700; cursor: pointer;
  border: 1px solid #5a8a5a; background: #7ab87a; color: #fff; text-shadow: 0 1px 0 rgba(0,0,0,.25); flex: 0 0 auto; }
.fu-craft-go:hover:not(:disabled), .fu-craft-ok:hover { background: #5a9a5a; }
.fu-craft-go:active:not(:disabled) { transform: scale(.96); }
.fu-craft-go:disabled { opacity: .45; cursor: default; background: #c8b89a; border-color: #a89870; color: #6b4c2a; text-shadow: none; }
.fu-craft-why { font-size: 11px; color: #b03a22; }
.fu-craft.is-ro .fu-craft-row, .fu-craft.is-ro .fu-craft-tab { cursor: default; }

.fu-craft-ovl { position: absolute; inset: 0; background: rgba(40,28,10,.5); display: grid; place-items: center; z-index: 5; }
.fu-craft-card { position: relative; background: linear-gradient(#f8f0d4,#ede0b0); border-radius: 12px; padding: 18px 24px; min-width: min(300px, 86%); text-align: center; color: #3a1e06; font-size: 15px;
  box-shadow: 0 0 0 2px #c9a44a, 0 0 0 4px #7a4e20, 0 0 0 6px #b8865a, 0 16px 30px rgba(0,0,0,.5); animation: fu-craft-in .3s ease-out; }
.fu-craft-card b { font-weight: 700; }
.fu-craft-big { display: flex; gap: 8px; justify-content: center; margin: 2px 0 10px; }
.fu-craft-sub { font-size: 12px; font-style: italic; color: #5a3800; margin-top: 6px; }
.fu-craft-card .fu-craft-ok { margin-top: 12px; }
.fu-craft-hammer { font-size: 24px; color: #5a3800; display: inline-block; animation: fu-craft-knock .33s steps(2,end) infinite; transform-origin: 70% 70%; }
.fu-craft-bar { height: 10px; width: 220px; max-width: 100%; margin: 12px auto 2px; border-radius: 6px; background: rgba(0,0,0,.12); border: 1px solid rgba(184,153,64,.55); overflow: hidden; }
.fu-craft-bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#d4b04a,#f7e09a); animation: fu-craft-fill ${MIN_WORK_MS}ms steps(8,end) forwards; }
.fu-craft-spark { position: absolute; left: 50%; top: 40px; font-size: 14px; color: #e8b830; pointer-events: none; animation: fu-craft-burst .9s ease-out forwards; }
@keyframes fu-craft-in { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: none; } }
@keyframes fu-craft-knock { 50% { transform: rotate(-28deg); } }
@keyframes fu-craft-fill { to { width: 100%; } }
@keyframes fu-craft-burst { from { opacity: 1; transform: translate(0,0) scale(.6); } to { opacity: 0; transform: translate(var(--dx),var(--dy)) scale(1.2); } }
@media (max-width: 620px) { .fu-craft-prev { grid-template-columns: minmax(0,1fr); } }
@media (prefers-reduced-motion: reduce) { .fu-craft *, #${WIN_ID} * { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition: none !important; } }
`;
  document.head.appendChild(s);
}
