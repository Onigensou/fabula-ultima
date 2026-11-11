// scripts/crafting-system/blueprint-editor.js
//
// BLUEPRINT EDITOR — the GM tool for everything crafting, made so the game can
// be run without editing data by hand (user, 2026-11-12: "if I hand off the
// template to a friend without Claude they should be able to use it").
//
// Open: Game Settings → Configure Settings → Fabula Ultima Companion →
// "Blueprint Editor", or FUCompanion.api.crafting.openEditor().
//
// Tabs
//   Books     books (new / duplicate / delete / camp book), each book's cost
//             rules per place, its Blueprints, and the selected Blueprint's
//             form: outputs, materials (drag items in, or type a name), cost,
//             per-place cost, unlock switch, hint. "Save" writes the
//             _Crafting Config item; nothing is written before that.
//   Crafters  NPC actors that craft: drag an actor in, pick its book, its
//             greeting. These save at once (they are actor flags).
//   Help      how the pieces fit.

import { TAG, MODULE_ID, PLACES, PLACE_LABEL, CRAFTER_FLAG, CRAFTER_BOOK_FLAG, CRAFTER_QUOTE_FLAG, ZENIT_ICON, esc, gp, playSfx } from "./crafting-const.js";
import { readConfig, saveConfig, normalizeBook, normalizeBlueprint, blueprintTitle, outputView, categoryOf } from "./crafting-data.js";
import { setCrafter, isCrafterActor, resolveCrafter } from "./crafting-open.js";
import { CraftWindow } from "./crafting-window.js";

const WIN_ID = "fu-bp-editor";
const STYLE_ID = "fu-bp-editor-style";
const LIST_ID = "fu-bp-itemnames";
const clone = (o) => foundry.utils.deepClone(o);
const newId = () => foundry.utils.randomID(12);

// World items a Blueprint can name: never a CSB sub-item (same-named shells
// live in the embedded-items folder), never the config itself.
function pickableItems() {
  return (game.items?.contents ?? []).filter((i) => !i.system?.container && !i.name.startsWith("_"));
}
// A recipe item can share its name with the item it makes ("Remedy"): prefer the real item.
function findItemByName(name) {
  const n = String(name ?? "").trim().toLowerCase();
  const all = pickableItems().filter((i) => i.name.toLowerCase() === n);
  return all.find((i) => String(i.system?.props?.item_type ?? "").toLowerCase() !== "recipe") ?? all[0] ?? null;
}

export class BlueprintEditor {
  static _cur = null;
  static open() {
    if (!game.user?.isGM) return ui.notifications?.warn("The Blueprint Editor is for the GM.");
    if (this._cur?.el) { this._cur.el.querySelector(".fu-bp-win")?.focus(); return this._cur; }
    const ed = new BlueprintEditor();
    this._cur = ed;
    ed.build();
    return ed;
  }

  constructor() {
    this.cfg = clone(readConfig());
    this.tab = "books";
    this.bookId = this.cfg.books[0]?.id ?? null;
    this.bpId = this.book()?.blueprints[0]?.id ?? null;
    this.dirty = false;
  }

  book() { return this.cfg.books.find((b) => b.id === this.bookId) ?? null; }
  bp() { return this.book()?.blueprints.find((b) => b.id === this.bpId) ?? null; }
  touch() { this.dirty = true; this.renderBar(); }

  build() {
    injectStyles();
    const el = document.createElement("div");
    el.id = WIN_ID;
    el.innerHTML = `
      <div class="fu-bp-win" tabindex="-1" role="dialog" aria-label="Blueprint Editor">
        <div class="fu-bp-title"><span><i class="fas fa-compass-drafting"></i> Blueprint Editor</span>
          <span class="fu-bp-tabs">${[["books", "Blueprint books"], ["crafters", "Crafter NPCs"], ["help", "Help"]]
            .map(([k, l]) => `<button type="button" data-tab="${k}">${l}</button>`).join("")}</span>
          <button type="button" class="fu-bp-x" aria-label="Close"><i class="fas fa-xmark"></i></button></div>
        <div class="fu-bp-main"></div>
        <div class="fu-bp-bar"></div>
      </div>
      <datalist id="${LIST_ID}">${[...new Set(pickableItems().map((i) => i.name))].sort().map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`;
    document.body.appendChild(el);
    this.el = el;
    el.querySelector(".fu-bp-x").addEventListener("click", () => this.close());
    el.querySelectorAll(".fu-bp-tabs button").forEach((b) => b.addEventListener("click", () => { this.tab = b.dataset.tab; playSfx("tab"); this.render(); }));
    this.render();
  }

  close() {
    if (this.dirty && !window.confirm?.("Close without saving your Blueprint changes?")) return;
    this.el?.remove();
    this.el = null;
    if (BlueprintEditor._cur === this) BlueprintEditor._cur = null;
  }

  render() {
    if (!this.el) return;
    this.el.querySelectorAll(".fu-bp-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    const main = this.el.querySelector(".fu-bp-main");
    if (this.tab === "books") this.renderBooks(main);
    else if (this.tab === "crafters") this.renderCrafters(main);
    else this.renderHelp(main);
    this.renderBar();
  }

  renderBar() {
    const bar = this.el?.querySelector(".fu-bp-bar");
    if (!bar) return;
    bar.innerHTML = this.tab === "books"
      ? `<span class="fu-bp-status">${this.dirty ? "Unsaved changes" : "All changes saved"}</span>
         <button type="button" class="fu-bp-btn ghost" data-act="try" ${this.book() ? "" : "disabled"}><i class="fas fa-play"></i> Try this book</button>
         <button type="button" class="fu-bp-btn ghost" data-act="revert" ${this.dirty ? "" : "disabled"}>Revert</button>
         <button type="button" class="fu-bp-btn" data-act="save" ${this.dirty ? "" : "disabled"}><i class="fas fa-floppy-disk"></i> Save</button>`
      : `<span class="fu-bp-status">${this.tab === "crafters" ? "Crafter changes save as you make them." : ""}</span>`;
    bar.querySelector('[data-act="save"]')?.addEventListener("click", () => this.save());
    bar.querySelector('[data-act="revert"]')?.addEventListener("click", () => { this.cfg = clone(readConfig()); this.dirty = false; this.fixSel(); this.render(); });
    bar.querySelector('[data-act="try"]')?.addEventListener("click", () => this.tryBook());
  }

  fixSel() {
    if (!this.book()) this.bookId = this.cfg.books[0]?.id ?? null;
    if (!this.bp()) this.bpId = this.book()?.blueprints[0]?.id ?? null;
  }

  async save() {
    try {
      this.cfg = clone(await saveConfig(this.cfg));
      this.dirty = false;
      this.fixSel();
      playSfx("done");
      ui.notifications?.info("Blueprints saved.");
      this.render();
    } catch (e) {
      console.error(TAG, e);
      ui.notifications?.error(`Saving Blueprints failed: ${e.message}`);
    }
  }

  async tryBook() {
    if (this.dirty) return ui.notifications?.warn("Save first, then try the book.");
    const actor = await resolveCrafter();
    if (!actor) return ui.notifications?.warn("No party member to craft with.");
    CraftWindow.open({ place: "npc", bookId: this.bookId, actor, title: `Try — ${this.book().name}`, sourceName: this.book().name, portrait: null,
      quote: "GM preview. Crafting here is real: it uses the crafter's materials and money." });
  }

  // ── Books tab ──────────────────────────────────────────────────────────────
  renderBooks(main) {
    const book = this.book();
    const bp = this.bp();
    main.innerHTML = `
      <div class="fu-bp-cols">
        <section class="fu-bp-col books">
          <h3>Books</h3>
          <div class="fu-bp-list">${this.cfg.books.map((b) => `
            <button type="button" class="fu-bp-li${b.id === this.bookId ? " on" : ""}" data-book="${esc(b.id)}">
              <span class="fu-bp-li-name">${esc(b.name)}</span>
              <span class="fu-bp-li-sub">${b.blueprints.length} Blueprint${b.blueprints.length === 1 ? "" : "s"}${b.id === this.cfg.campBookId ? " · <b>Camp</b>" : ""}</span>
            </button>`).join("") || `<p class="fu-bp-empty">No books yet.</p>`}</div>
          <div class="fu-bp-row-btns">
            <button type="button" class="fu-bp-btn sm" data-act="book-new"><i class="fas fa-plus"></i> New</button>
            <button type="button" class="fu-bp-btn sm ghost" data-act="book-dup" ${book ? "" : "disabled"}>Duplicate</button>
            <button type="button" class="fu-bp-btn sm danger" data-act="book-del" ${book ? "" : "disabled"}>Delete</button>
          </div>
        </section>
        <section class="fu-bp-col bookcfg">${book ? this.bookHtml(book) : `<p class="fu-bp-empty">Make a book first. A book is one list of Blueprints: a Crafter NPC, a crafting table or the camp each use one book.</p>`}</section>
        <section class="fu-bp-col bpcfg">${bp ? this.bpHtml(book, bp) : book ? `<p class="fu-bp-empty">Add a Blueprint to this book.</p>` : ""}</section>
      </div>`;
    this.bindBooks(main);
  }

  bookHtml(book) {
    const rule = PLACES.map((p) => `
      <tr><th>${PLACE_LABEL[p]}</th>
        <td><input type="number" min="0" step="0.05" data-rule="${p}.zenit" value="${book.costRule[p].zenit}"></td>
        <td><input type="number" min="0" step="0.05" data-rule="${p}.ip" value="${book.costRule[p].ip}"></td></tr>`).join("");
    const bps = book.blueprints.map((b, i) => {
      const out = b.outputs[0] ? outputView(b.outputs[0]) : null;
      const bad = !b.outputs.length || b.outputs.some((o) => outputView(o).missing);
      return `<div class="fu-bp-li bp${b.id === this.bpId ? " on" : ""}" data-bp="${esc(b.id)}" role="button" tabindex="0">
        <span class="fu-bp-ic">${out ? `<img src="${esc(out.img)}" alt="">` : `<i class="fas fa-question"></i>`}</span>
        <span class="fu-bp-li-name">${esc(blueprintTitle(b))}${bad ? ` <i class="fas fa-triangle-exclamation warn" title="Missing output item"></i>` : ""}${b.unlockSwitch ? ` <i class="fas fa-lock" title="Locked until ${esc(b.unlockSwitch)}"></i>` : ""}</span>
        <span class="fu-bp-li-sub">${b.cost.zenit ? `${b.cost.zenit} z` : ""}${b.cost.zenit && b.cost.ip ? " · " : ""}${b.cost.ip ? `${b.cost.ip} IP` : ""}${!b.cost.zenit && !b.cost.ip ? "Free" : ""}</span>
        <span class="fu-bp-move"><button type="button" data-mv="-1" data-i="${i}" title="Move up" ${i === 0 ? "disabled" : ""}><i class="fas fa-chevron-up"></i></button><button type="button" data-mv="1" data-i="${i}" title="Move down" ${i === book.blueprints.length - 1 ? "disabled" : ""}><i class="fas fa-chevron-down"></i></button></span>
      </div>`;
    }).join("");
    return `
      <h3>Book</h3>
      <label class="fu-bp-field"><span>Name</span><input type="text" data-k="book.name" value="${esc(book.name)}"></label>
      <label class="fu-bp-check"><input type="checkbox" data-k="book.camp" ${book.id === this.cfg.campBookId ? "checked" : ""}> Camp book (Camp Forge → Craft uses this one)</label>
      <div class="fu-bp-sub">Cost rules <span class="fu-bp-hint">Each Blueprint's cost × this number at each place. 1 = full, 0.5 = half, 0 = free. A Blueprint can set its own exact cost per place instead.</span></div>
      <table class="fu-bp-rule"><thead><tr><th></th><th>Zenit ×</th><th>IP ×</th></tr></thead><tbody>${rule}</tbody></table>
      <div class="fu-bp-sub">Blueprints</div>
      <div class="fu-bp-list bps">${bps || `<p class="fu-bp-empty">No Blueprints yet.</p>`}</div>
      <div class="fu-bp-row-btns">
        <button type="button" class="fu-bp-btn sm" data-act="bp-new"><i class="fas fa-plus"></i> New Blueprint</button>
        <button type="button" class="fu-bp-btn sm ghost" data-act="bp-dup" ${this.bp() ? "" : "disabled"}>Duplicate</button>
        <button type="button" class="fu-bp-btn sm danger" data-act="bp-del" ${this.bp() ? "" : "disabled"}>Delete</button>
      </div>`;
  }

  entryRows(list, kind) {
    return list.map((e, i) => {
      const v = kind === "out" ? outputView(e) : { name: e.name, img: e.img, missing: !findItemByName(e.name) };
      return `<div class="fu-bp-entry${v.missing ? " missing" : ""}">
        <span class="fu-bp-ic sm"><img src="${esc(v.img || "icons/svg/item-bag.svg")}" alt=""></span>
        <span class="fu-bp-entry-name" title="${esc(v.missing ? "No world item with this name" : v.name)}">${esc(v.name)}${v.missing ? ` <i class="fas fa-triangle-exclamation warn"></i>` : ""}</span>
        <label class="fu-bp-qty">×<input type="number" min="1" max="999" data-${kind}-qty="${i}" value="${e.qty}"></label>
        <button type="button" class="fu-bp-del" data-${kind}-del="${i}" title="Remove"><i class="fas fa-xmark"></i></button>
      </div>`;
    }).join("");
  }

  bpHtml(book, bp) {
    const switches = (() => { try { return window.oni?.GameState?.switchNames?.() ?? []; } catch { return []; } })();
    const places = PLACES.map((p) => {
      const own = bp.placeCost?.[p];
      const auto = { zenit: Math.round(bp.cost.zenit * book.costRule[p].zenit), ip: Math.round(bp.cost.ip * book.costRule[p].ip) };
      return `<tr><th>${PLACE_LABEL[p]}</th>
        <td><label class="fu-bp-check"><input type="checkbox" data-own="${p}" ${own ? "checked" : ""}> Own cost</label></td>
        <td><input type="number" min="0" data-pc="${p}.zenit" value="${own ? own.zenit : auto.zenit}" ${own ? "" : "disabled"}></td>
        <td><input type="number" min="0" data-pc="${p}.ip" value="${own ? own.ip : auto.ip}" ${own ? "" : "disabled"}></td></tr>`;
    }).join("");
    return `
      <h3>Blueprint <span class="fu-bp-cat">${esc(categoryOf(bp))}</span></h3>
      <label class="fu-bp-field"><span>Name</span><input type="text" data-k="bp.name" value="${esc(bp.name)}" placeholder="${esc(bp.outputs.length ? blueprintTitle({ ...bp, name: "" }) : "Shown as the output's name")}"></label>
      <div class="fu-bp-sub">Makes <span class="fu-bp-hint">The item(s) the crafter receives. Drag items from the Items sidebar, or type a name.</span></div>
      <div class="fu-bp-drop" data-drop="out">${this.entryRows(bp.outputs, "out") || `<p class="fu-bp-empty sm">Drop an item here.</p>`}
        <div class="fu-bp-add"><input type="text" list="${LIST_ID}" data-add="out" placeholder="Item name…"><button type="button" class="fu-bp-btn sm ghost" data-add-btn="out">Add</button></div></div>
      <div class="fu-bp-sub">Materials <span class="fu-bp-hint">Taken from the crafter's bag first, then the party stash. Matched by item name.</span></div>
      <div class="fu-bp-drop" data-drop="mat">${this.entryRows(bp.materials, "mat") || `<p class="fu-bp-empty sm">Drop a material here.</p>`}
        <div class="fu-bp-add"><input type="text" list="${LIST_ID}" data-add="mat" placeholder="Material name…"><button type="button" class="fu-bp-btn sm ghost" data-add-btn="mat">Add</button></div></div>
      <div class="fu-bp-sub">Cost of one craft</div>
      <div class="fu-bp-cost">
        <label class="fu-bp-field inline"><span><img src="${ZENIT_ICON}" alt=""> Zenit</span><input type="number" min="0" data-k="bp.zenit" value="${bp.cost.zenit}"></label>
        <label class="fu-bp-field inline"><span>IP</span><input type="number" min="0" data-k="bp.ip" value="${bp.cost.ip}"></label>
      </div>
      <table class="fu-bp-rule"><thead><tr><th>Place</th><th></th><th>Zenit</th><th>IP</th></tr></thead><tbody>${places}</tbody></table>
      <p class="fu-bp-hint">Without "Own cost" a place uses the cost above × the book's rule (shown greyed).</p>
      <div class="fu-bp-sub">Unlock</div>
      <label class="fu-bp-field"><span>Story switch</span><input type="text" list="fu-bp-switches" data-k="bp.unlockSwitch" value="${esc(bp.unlockSwitch)}" placeholder="Empty = always known">
        <datalist id="fu-bp-switches">${switches.map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist></label>
      <label class="fu-bp-field"><span>Hint</span><input type="text" data-k="bp.hint" value="${esc(bp.hint)}" placeholder="Shown on the ??? row while locked"></label>`;
  }

  bindBooks(main) {
    const book = this.book();
    main.querySelectorAll("[data-book]").forEach((b) => b.addEventListener("click", () => {
      this.bookId = b.dataset.book; this.bpId = this.book()?.blueprints[0]?.id ?? null; playSfx("select"); this.render();
    }));
    main.querySelectorAll(".fu-bp-li.bp").forEach((b) => b.addEventListener("click", (ev) => {
      if (ev.target.closest(".fu-bp-move")) return;
      this.bpId = b.dataset.bp; playSfx("select"); this.render();
    }));
    main.querySelectorAll("[data-mv]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const i = Number(b.dataset.i), j = i + Number(b.dataset.mv), arr = book.blueprints;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      this.touch(); this.render();
    }));
    const act = (name, fn) => main.querySelector(`[data-act="${name}"]`)?.addEventListener("click", fn);
    act("book-new", () => {
      const b = normalizeBook({ name: "New book" });
      this.cfg.books.push(b); this.bookId = b.id; this.bpId = null; this.touch(); this.render();
    });
    act("book-dup", () => {
      const b = normalizeBook({ ...clone(book), id: newId(), name: `${book.name} (copy)`, blueprints: book.blueprints.map((x) => ({ ...clone(x), id: newId() })) });
      this.cfg.books.push(b); this.bookId = b.id; this.bpId = b.blueprints[0]?.id ?? null; this.touch(); this.render();
    });
    act("book-del", () => {
      if (!window.confirm?.(`Delete the book "${book.name}" and its ${book.blueprints.length} Blueprint(s)? NPCs and spots using it will show an empty list.`)) return;
      this.cfg.books = this.cfg.books.filter((b) => b.id !== book.id);
      if (this.cfg.campBookId === book.id) this.cfg.campBookId = "";
      this.bookId = null; this.fixSel(); this.touch(); this.render();
    });
    act("bp-new", () => {
      const b = normalizeBlueprint({});
      book.blueprints.push(b); this.bpId = b.id; this.touch(); this.render();
    });
    act("bp-dup", () => {
      const src = this.bp();
      const b = normalizeBlueprint({ ...clone(src), id: newId(), name: src.name ? `${src.name} (copy)` : "" });
      book.blueprints.splice(book.blueprints.indexOf(src) + 1, 0, b); this.bpId = b.id; this.touch(); this.render();
    });
    act("bp-del", () => {
      const src = this.bp();
      book.blueprints = book.blueprints.filter((b) => b !== src);
      this.bpId = book.blueprints[0]?.id ?? null; this.touch(); this.render();
    });

    // Plain fields: update the working copy; re-render only what shows them.
    main.querySelectorAll("[data-k]").forEach((inp) => inp.addEventListener("change", () => {
      const bp = this.bp(), k = inp.dataset.k;
      if (k === "book.name") book.name = inp.value.trim() || "Untitled book";
      else if (k === "book.camp") this.cfg.campBookId = inp.checked ? book.id : (this.cfg.campBookId === book.id ? "" : this.cfg.campBookId);
      else if (k === "bp.name") bp.name = inp.value.trim();
      else if (k === "bp.zenit") bp.cost.zenit = Math.max(0, Math.floor(Number(inp.value) || 0));
      else if (k === "bp.ip") bp.cost.ip = Math.max(0, Math.floor(Number(inp.value) || 0));
      else if (k === "bp.unlockSwitch") bp.unlockSwitch = inp.value.trim();
      else if (k === "bp.hint") bp.hint = inp.value.trim();
      this.touch(); this.render();
    }));
    main.querySelectorAll("[data-rule]").forEach((inp) => inp.addEventListener("change", () => {
      const [p, k] = inp.dataset.rule.split(".");
      const n = Number(inp.value);
      book.costRule[p][k] = Number.isFinite(n) && n >= 0 ? n : 1;
      this.touch(); this.render();
    }));
    main.querySelectorAll("[data-own]").forEach((cb) => cb.addEventListener("change", () => {
      const bp = this.bp(), p = cb.dataset.own;
      bp.placeCost ??= {};
      if (cb.checked) bp.placeCost[p] = { zenit: Math.round(bp.cost.zenit * book.costRule[p].zenit), ip: Math.round(bp.cost.ip * book.costRule[p].ip) };
      else delete bp.placeCost[p];
      this.touch(); this.render();
    }));
    main.querySelectorAll("[data-pc]").forEach((inp) => inp.addEventListener("change", () => {
      const [p, k] = inp.dataset.pc.split(".");
      const bp = this.bp();
      if (bp.placeCost?.[p]) bp.placeCost[p][k] = Math.max(0, Math.floor(Number(inp.value) || 0));
      this.touch();
    }));

    // Outputs / materials: quantity, remove, add by name, drop.
    for (const kind of ["out", "mat"]) {
      const listOf = () => (kind === "out" ? this.bp().outputs : this.bp().materials);
      main.querySelectorAll(`[data-${kind}-qty]`).forEach((inp) => inp.addEventListener("change", () => {
        listOf()[Number(inp.dataset[`${kind}Qty`])].qty = Math.max(1, Math.min(999, Math.floor(Number(inp.value) || 1)));
        this.touch(); this.render();
      }));
      main.querySelectorAll(`[data-${kind}-del]`).forEach((b) => b.addEventListener("click", () => {
        listOf().splice(Number(b.dataset[`${kind}Del`]), 1); this.touch(); this.render();
      }));
      const inp = main.querySelector(`[data-add="${kind}"]`);
      const add = () => {
        const item = findItemByName(inp.value);
        if (!item) return ui.notifications?.warn(`No world item named "${inp.value}".`);
        this.addEntry(kind, item);
      };
      main.querySelector(`[data-add-btn="${kind}"]`)?.addEventListener("click", add);
      inp?.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
      const zone = main.querySelector(`[data-drop="${kind}"]`);
      zone?.addEventListener("dragover", (ev) => { ev.preventDefault(); zone.classList.add("over"); });
      zone?.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone?.addEventListener("drop", async (ev) => {
        ev.preventDefault(); zone.classList.remove("over");
        const data = TextEditor.getDragEventData(ev);
        if (data?.type !== "Item" || !data.uuid) return ui.notifications?.warn("Drop an Item here.");
        const item = await fromUuid(data.uuid);
        if (item) this.addEntry(kind, item);
      });
    }
  }

  addEntry(kind, item) {
    const bp = this.bp();
    const list = kind === "out" ? bp.outputs : bp.materials;
    const same = list.find((e) => (kind === "out" ? e.uuid === item.uuid : e.name.toLowerCase() === item.name.toLowerCase()));
    if (same) same.qty += 1;
    else list.push({ uuid: item.uuid, name: item.name, img: item.img, qty: 1 });
    playSfx("select");
    this.touch(); this.render();
  }

  // ── Crafters tab ───────────────────────────────────────────────────────────
  renderCrafters(main) {
    const crafters = (game.actors?.contents ?? []).filter(isCrafterActor).sort((a, b) => a.name.localeCompare(b.name));
    const books = this.cfg.books;
    main.innerHTML = `
      <div class="fu-bp-crafters">
        <p class="fu-bp-hint">A Crafter NPC shows a Craft button above its head when the party stands at its feet, next to Talk / Shop. Drag an NPC actor (from the Actors sidebar or a token's sheet) into the box below. Changes here save at once.</p>
        <div class="fu-bp-drop crafters" data-drop="actor">
          ${crafters.map((a) => {
            const cur = String(gp(a, `flags.${MODULE_ID}.${CRAFTER_BOOK_FLAG}`, "") ?? "");
            return `<div class="fu-bp-crafter" data-actor="${a.id}">
              <img src="${esc(a.img)}" alt=""><b>${esc(a.name)}</b>
              <label>Book <select data-cbook>${`<option value="">(none)</option>` + books.map((b) => `<option value="${esc(b.id)}" ${b.id === cur ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>
              <label class="grow">Greeting <input type="text" data-cquote value="${esc(gp(a, `flags.${MODULE_ID}.${CRAFTER_QUOTE_FLAG}`, "") ?? "")}" placeholder="Bring me the materials and a little coin, and I'll make it."></label>
              <button type="button" class="fu-bp-btn sm danger" data-cdel>Remove</button></div>`;
          }).join("") || `<p class="fu-bp-empty">No Crafter NPCs yet. Drop an NPC actor here.</p>`}
        </div>
        ${this.dirty ? `<p class="fu-bp-hint warn">You have unsaved book changes; new books show up here after you save them.</p>` : ""}
      </div>`;
    const zone = main.querySelector('[data-drop="actor"]');
    zone.addEventListener("dragover", (ev) => { ev.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", async (ev) => {
      ev.preventDefault(); zone.classList.remove("over");
      const data = TextEditor.getDragEventData(ev);
      const doc = data?.uuid ? await fromUuid(data.uuid) : null;
      const actor = doc?.documentName === "Actor" ? doc : doc?.actor ?? null;
      if (!actor) return ui.notifications?.warn("Drop an NPC actor here.");
      const target = actor.isToken ? game.actors.get(actor.id) ?? actor : actor;
      await setCrafter(target, { on: true, bookId: readConfig().books[0]?.id ?? "" });
      playSfx("select");
      this.render();
    });
    main.querySelectorAll(".fu-bp-crafter").forEach((row) => {
      const a = game.actors.get(row.dataset.actor);
      row.querySelector("[data-cbook]").addEventListener("change", (ev) => setCrafter(a, { on: true, bookId: ev.target.value }));
      row.querySelector("[data-cquote]").addEventListener("change", (ev) => setCrafter(a, { on: true, bookId: row.querySelector("[data-cbook]").value, quote: ev.target.value }));
      row.querySelector("[data-cdel]").addEventListener("click", async () => { await setCrafter(a, { on: false }); playSfx("cancel"); this.render(); });
    });
  }

  renderHelp(main) {
    main.innerHTML = `<div class="fu-bp-help">
      <h3>How crafting works</h3>
      <p>A <b>Blueprint</b> turns materials (plus Zenit and/or IP) into one or more items. Blueprints live in <b>books</b>. Each place that crafts uses one book:</p>
      <ul>
        <li><b>Crafter NPC</b>: Crafter NPCs tab. Drag the NPC in and pick its book. Party at its feet → Craft button.</li>
        <li><b>Crafting table</b>: draw a Region over the bench, open Region Config → Identity → <i>Crafting spot</i>, tick it and pick a book. The walker gets the usual "!".</li>
        <li><b>Camp</b>: tick "Camp book" on one book. Camp Forge (Merchant, Tinkerer, Pilot) → <i>Craft</i> makes one item from it, then the activity ends.</li>
      </ul>
      <h3>Who crafts and pays</h3>
      <p>The character who opens the window: on a walk map the party leader (Main Controller), in a camp the player's own character. Zenit and IP come from that character. Materials come from their bag first, then the party stash. Equipped gear is never used as a material.</p>
      <h3>Costs</h3>
      <p>Each Blueprint has a cost for one craft. A book's <b>cost rules</b> multiply it per place (for example camp Zenit × 0.5 = half price at camp). Tick <b>Own cost</b> on a Blueprint to set an exact cost for one place instead.</p>
      <h3>Locked Blueprints</h3>
      <p>Put a story switch name in <b>Unlock</b>. Until that switch is ON, the Blueprint shows as "???" with its hint.</p>
      <h3>Not the same as Recipes</h3>
      <p>Recipe items (Item → Create in battle, paid with IP) are a separate system. Blueprints never read them.</p>
    </div>`;
  }
}

export const openEditor = () => BlueprintEditor.open();

// Game Settings → "Blueprint Editor" button.
export function registerEditorMenu() {
  try {
    class BlueprintEditorMenu extends FormApplication {
      render() { BlueprintEditor.open(); return this; }
      async _updateObject() {}
    }
    game.settings.registerMenu(MODULE_ID, "blueprintEditor", {
      name: "Crafting: Blueprint Editor",
      label: "Blueprint Editor",
      hint: "Make Blueprint books, Crafter NPCs and costs for the Crafting system.",
      icon: "fas fa-compass-drafting",
      type: BlueprintEditorMenu,
      restricted: true,
    });
  } catch (e) { console.warn(TAG, "Blueprint Editor menu not registered", e); }
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${WIN_ID} { position: fixed; inset: 0; z-index: 9995; display: grid; place-items: center; background: rgba(12,8,4,.35); }
#${WIN_ID} img { border: none !important; }
.fu-bp-win { width: min(1180px, 97vw); height: min(780px, 94vh); display: flex; flex-direction: column; overflow: hidden; outline: none;
  background: #f0e6cc; color: #2c1f0e; border-radius: 10px; font-family: "Signika", sans-serif; font-size: 13px;
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 18px 44px rgba(0,0,0,.55); }
.fu-bp-win button { font-family: inherit; }
.fu-bp-title { display: flex; align-items: center; gap: 16px; padding: 6px 10px; background: linear-gradient(180deg,#7a4e20,#5c3818); color: #fff6dd; font-size: 14px; }
.fu-bp-title > span:first-child i { margin-right: 6px; }
.fu-bp-tabs { display: flex; gap: 4px; flex: 1; }
.fu-bp-tabs button { width: auto; height: auto; line-height: 1.3; padding: 4px 12px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: #f3e2b5; cursor: pointer; font-size: 13px; }
.fu-bp-tabs button.on { background: rgba(255,255,255,.16); border-color: #c9a44a; color: #fff; }
.fu-bp-x { width: 28px !important; height: 28px; line-height: 1; padding: 0; border: 0; background: transparent; color: #fff6dd; cursor: pointer; flex: 0 0 auto; }
.fu-bp-main { flex: 1; min-height: 0; overflow: hidden; }
.fu-bp-bar { display: flex; gap: 8px; align-items: center; justify-content: flex-end; padding: 8px 12px; border-top: 2px solid #b89940; background: linear-gradient(to bottom,#e8d5a3,#dfc890); }
.fu-bp-status { margin-right: auto; color: #5a3800; font-style: italic; }
.fu-bp-cols { display: grid; grid-template-columns: 220px minmax(0,1fr) minmax(0,1.25fr); height: 100%; }
.fu-bp-col { padding: 10px 12px; overflow-y: auto; border-right: 1px solid rgba(184,153,64,.55); display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.fu-bp-col.books { background: #e0c87a33; }
.fu-bp-col h3 { margin: 0; font-size: 15px; color: #5a3800; border: 0; display: flex; align-items: center; gap: 8px; }
.fu-bp-cat { font-size: 11px; font-weight: 600; text-transform: capitalize; padding: 1px 8px; border-radius: 10px; background: rgba(90,56,0,.12); border: 1px solid rgba(184,153,64,.55); }
.fu-bp-sub { font-weight: 700; color: #5a3800; margin-top: 6px; }
.fu-bp-hint { font-weight: 400; font-size: 11.5px; color: #6b4c2a; display: block; margin: 0; }
.fu-bp-hint.warn { color: #b03a22; }
.fu-bp-list { display: flex; flex-direction: column; gap: 4px; }
.fu-bp-li { display: grid; grid-template-columns: minmax(0,1fr); gap: 1px; text-align: left; width: 100%; height: auto; line-height: 1.3; margin: 0; padding: 6px 8px; border-radius: 8px; cursor: pointer;
  background: rgba(255,255,255,.55); border: 1px solid rgba(184,153,64,.35); color: inherit; }
.fu-bp-li.bp { grid-template-columns: 30px minmax(0,1fr) auto; grid-template-rows: auto auto; column-gap: 8px; align-items: center; }
.fu-bp-li.bp .fu-bp-ic { grid-row: 1 / 3; }
.fu-bp-li.bp .fu-bp-move { grid-row: 1 / 3; grid-column: 3; display: flex; flex-direction: column; }
.fu-bp-move button { width: 22px !important; height: 18px; line-height: 1; padding: 0; border: 0; background: transparent; color: #5a3800; cursor: pointer; font-size: 11px; }
.fu-bp-move button:disabled { opacity: .25; }
.fu-bp-li:hover { background: rgba(255,255,255,.85); }
.fu-bp-li.on { background: rgba(200,168,75,.32); border-color: #b89940; outline: 1px solid rgba(184,153,64,.6); }
.fu-bp-li-name { font-weight: 700; color: #3a2408; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fu-bp-li-sub { font-size: 11.5px; color: #6b4c2a; }
.fu-bp-ic { width: 30px; height: 30px; border-radius: 6px; border: 1px solid rgba(184,153,64,.5); background: #e8d5a3; display: grid; place-items: center; overflow: hidden; color: #5a3800; }
.fu-bp-ic img { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: pixelated; }
.fu-bp-ic.sm { width: 24px; height: 24px; }
.warn { color: #b03a22; }
.fu-bp-row-btns { display: flex; gap: 6px; flex-wrap: wrap; }
.fu-bp-btn { width: auto !important; height: auto; line-height: 1.3; padding: 5px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; cursor: pointer; flex: 0 0 auto;
  border: 1px solid #5a8a5a; background: #7ab87a; color: #fff; text-shadow: 0 1px 0 rgba(0,0,0,.25); }
.fu-bp-btn:hover:not(:disabled) { background: #5a9a5a; }
.fu-bp-btn:disabled { opacity: .45; cursor: default; }
.fu-bp-btn.sm { padding: 3px 10px; font-size: 12px; }
.fu-bp-btn.ghost { background: rgba(255,255,255,.6); border-color: #b89940; color: #5a3800; text-shadow: none; }
.fu-bp-btn.ghost:hover:not(:disabled) { background: #fff; }
.fu-bp-btn.danger { background: #c0634a; border-color: #8f3d2a; }
.fu-bp-btn.danger:hover:not(:disabled) { background: #a84b33; }
.fu-bp-field { display: grid; grid-template-columns: 110px minmax(0,1fr); gap: 8px; align-items: center; }
.fu-bp-field.inline { grid-template-columns: auto 90px; }
.fu-bp-field span { color: #5a3800; font-weight: 600; display: inline-flex; gap: 4px; align-items: center; }
.fu-bp-field span img { width: 16px; height: 16px; }
.fu-bp-win input[type="text"], .fu-bp-win input[type="number"], .fu-bp-win select { background: rgba(255,255,255,.75); border: 1px solid #b89940; border-radius: 6px; color: #2c1f0e; height: 26px; padding: 0 6px; }
.fu-bp-check { display: inline-flex; gap: 6px; align-items: center; color: #3a2408; }
.fu-bp-check input { margin: 0; }
.fu-bp-win input::placeholder { color: #a08a68; font-style: italic; opacity: 1; }
.fu-bp-rule { width: 100%; border-collapse: collapse; margin: 2px 0; background: transparent; border: 0; }
.fu-bp-rule thead, .fu-bp-rule tr, .fu-bp-rule tr:nth-child(odd), .fu-bp-rule tr:nth-child(even) { background: transparent !important; text-shadow: none; }
.fu-bp-rule thead th { border-bottom: 1px solid rgba(184,153,64,.55); }
.fu-bp-rule th, .fu-bp-rule td { padding: 3px 4px; text-align: left; border: 0; background: transparent; }
.fu-bp-rule thead th { font-size: 11px; color: #6b4c2a; font-weight: 600; }
.fu-bp-rule tbody th { color: #3a2408; font-weight: 600; white-space: nowrap; }
.fu-bp-rule input[type="number"] { width: 80px; }
.fu-bp-rule input:disabled { opacity: .5; }
.fu-bp-cost { display: flex; gap: 14px; flex-wrap: wrap; }
.fu-bp-drop { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 8px; border: 2px dashed rgba(184,153,64,.6); background: rgba(255,255,255,.35); }
.fu-bp-drop.over { border-color: #5a8a5a; background: rgba(122,184,122,.18); }
.fu-bp-entry { display: grid; grid-template-columns: 26px minmax(0,1fr) auto auto; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 6px; background: rgba(255,255,255,.7); border: 1px solid rgba(184,153,64,.35); }
.fu-bp-entry.missing { border-color: rgba(176,58,34,.5); background: #fbe9e2; }
.fu-bp-entry-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #3a2408; }
.fu-bp-qty { display: inline-flex; gap: 3px; align-items: center; color: #6b4c2a; }
.fu-bp-qty input { width: 60px; }
.fu-bp-del { width: 24px !important; height: 24px; line-height: 1; padding: 0; border: 0; background: transparent; color: #8f3d2a; cursor: pointer; }
.fu-bp-add { display: flex; gap: 6px; align-items: center; }
.fu-bp-add input { flex: 1; min-width: 0; }
.fu-bp-empty { color: #6b4c2a; font-style: italic; margin: 6px 0; }
.fu-bp-empty.sm { margin: 2px 4px; font-size: 12px; }
.fu-bp-crafters { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; height: 100%; overflow-y: auto; }
.fu-bp-drop.crafters { min-height: 120px; }
.fu-bp-crafter { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.7); border: 1px solid rgba(184,153,64,.35); }
.fu-bp-crafter img { width: 36px; height: 36px; object-fit: contain; border-radius: 6px; background: #e8d5a3; }
.fu-bp-crafter label { display: inline-flex; gap: 6px; align-items: center; color: #5a3800; }
.fu-bp-crafter label.grow { flex: 1; min-width: 220px; }
.fu-bp-crafter label.grow input { flex: 1; }
.fu-bp-help { padding: 14px 20px; overflow-y: auto; height: 100%; max-width: 760px; line-height: 1.5; }
.fu-bp-help h3 { margin: 12px 0 4px; font-size: 15px; color: #5a3800; border: 0; }
.fu-bp-help p, .fu-bp-help li { color: #3a2408; }
`;
  document.head.appendChild(s);
}
