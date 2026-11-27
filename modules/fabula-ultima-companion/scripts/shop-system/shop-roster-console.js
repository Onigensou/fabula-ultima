// ============================================================================
// Shop Roster — GM console (Pool / Roll rules / History)
//
// Opens from the restock whisper ("Open console"), the GM-only "Roster" button
// on a roster shop's window, or FUCompanion.shopRosterConsole.open(actor).
// Every edit writes the shop actor's shopRoster flag straight away; odds are
// re-simulated after each change.
// ============================================================================
import { EQUIP_TYPES, RARITIES, DEFAULT_CONFIG } from "./shop-roster-engine.js";

const TAG = "[ShopRoster][Console]";
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = () => globalThis.FUCompanion?.shopRoster;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const open = new Map(); // actorId -> console

const FILTERS = [
  ["all", "All"], ["ok", "Can appear"], ["own", "Owned (fallback)"], ["auth", "Needs authoring"], ["blk", "Never rolls"], ["now", "On sale"],
];

const CSS = `<style id="fu-roster-console-style">
.fu-rc { background:#f0e6cc; color:#2c1f0e; display:flex; flex-direction:column; gap:10px; padding:6px; font-size:13px; }
.fu-rc-top { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.fu-rc-top .fu-rc-status { flex:1 1 260px; color:#5a3800; }
.fu-rc button.fu-rc-btn { width:auto; flex:0 0 auto; line-height:24px; padding:0 10px; font-size:12px; }
.fu-rc-tabs { display:flex; gap:2px; border-bottom:2px solid #b89940; }
.fu-rc-tab { padding:5px 12px; cursor:pointer; border-radius:4px 4px 0 0; color:#7a5a20; font-weight:600; }
.fu-rc-tab.active { background:#b89940; color:#fff; }
.fu-rc-sum { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
.fu-rc-sum div { background:#f8f0dc; border:1px solid #d4bd80; border-radius:5px; padding:5px 7px; font-size:11px; color:#6a5530; }
.fu-rc-sum b { display:block; font-size:14px; color:#2c1f0e; }
.fu-rc-sum b.short { color:#a8461a; }
.fu-rc-filters { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.fu-rc-chip { border:1px solid #c8a84b; border-radius:99px; padding:2px 9px; cursor:pointer; font-size:11px; background:#f8f0dc; }
.fu-rc-chip.on { background:#5a3800; color:#f0e6cc; border-color:#5a3800; }
.fu-rc-filters input[type=search] { width:180px; height:24px; }
.fu-rc-tbl { max-height:430px; overflow:auto; border:1px solid #d4bd80; border-radius:5px; background:#fbf6ea; }
.fu-rc-tbl table { margin:0; border:0; background:none; }
.fu-rc-tbl th { position:sticky; top:0; background:#e6d6ae; font-size:10px; text-transform:uppercase; letter-spacing:.04em; padding:4px; z-index:1; }
.fu-rc-tbl td { padding:3px 4px; border-bottom:1px solid #eadfc2; vertical-align:middle; }
.fu-rc-tbl tr.dim td { opacity:.55; }
.fu-rc-tbl img { width:26px; height:26px; border:0; background:#c8a84b; border-radius:3px; object-fit:contain; }
.fu-rc-tbl input.fu-rc-price { width:64px; height:22px; text-align:right; }
.fu-rc-sub { font-size:10px; color:#7a6a4a; }
.fu-rc-rar { font-size:11px; font-weight:700; }
.fu-rc-rar.Legendary { color:#a87400; } .fu-rc-rar.Rare { color:#2f6fb3; } .fu-rc-rar.Uncommon { color:#3f8a52; } .fu-rc-rar.Common { color:#7a7266; }
.fu-rc-st { font-size:10px; font-weight:700; border-radius:99px; padding:1px 7px; white-space:nowrap; }
.fu-rc-st.ok { background:#d6ead9; color:#2f6a40; } .fu-rc-st.own { background:#f1dfc0; color:#8a5210; }
.fu-rc-st.blk { background:#f0d2cc; color:#922f22; } .fu-rc-st.pin { background:#d3def0; color:#2c4f80; }
.fu-rc-st.sale { background:#5a3800; color:#f0e6cc; margin-left:4px; }
.fu-rc-bar { display:inline-block; width:56px; height:7px; background:#e3d6b4; border-radius:4px; overflow:hidden; vertical-align:middle; margin-right:4px; }
.fu-rc-bar i { display:block; height:100%; background:#b8860b; }
.fu-rc-tg { font-size:10px; line-height:18px; padding:0 6px; width:auto; border-radius:4px; }
.fu-rc-tg.on { background:#3c5f91; color:#fff; } .fu-rc-tg.off.on { background:#a33a2a; }
.fu-rc-drop { border:2px dashed #c8a84b; border-radius:6px; padding:8px; text-align:center; color:#7a5a20; font-size:12px; }
.fu-rc-drop.hover { background:#f3e4bb; }
.fu-rc-rules { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.fu-rc-box { background:#f8f0dc; border:1px solid #d4bd80; border-radius:6px; padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
.fu-rc-box h3 { margin:0; border:0; font-size:13px; color:#5a3800; }
.fu-rc-box p { margin:0; font-size:11px; color:#6a5530; }
.fu-rc-row { display:grid; grid-template-columns:110px 70px 1fr; gap:8px; align-items:center; }
.fu-rc-row input[type=number] { height:24px; }
.fu-rc-row .fu-rc-sub { text-align:left; }
.fu-rc-hist { display:flex; flex-direction:column; gap:6px; max-height:470px; overflow:auto; }
.fu-rc-hist div { background:#f8f0dc; border:1px solid #d4bd80; border-radius:5px; padding:5px 8px; font-size:12px; }
</style>`;

class RosterConsole {
  constructor(actor) {
    this.actor = actor;
    this.tab = "pool";
    this.filter = "all";
    this.q = "";
    this.data = null;
    this.busy = false;
  }

  async refresh() {
    this.data = await api().inspect(this.actor);
    this.paint();
  }

  // ── markup ─────────────────────────────────────────────────────────────
  statusLine() {
    const { state, cfg } = this.data;
    const last = Number(state?.lastRestockAt || 0);
    const hrs = last ? (Date.now() - last) / 3600e3 : Infinity;
    const when = last ? new Date(last).toLocaleString() : "never";
    const next = state?.locked ? "Next Rest keeps this roster (locked)" : hrs < cfg.cooldownHours ? `Next Rest keeps it (cooldown ${cfg.cooldownHours} h)` : "Next Rest rerolls it";
    return `Last restock: <b>${esc(when)}</b> · ${next}`;
  }

  rowStatus(r) {
    if (r.block) return { k: "blk", t: r.block };
    if (r.pin) return { k: "pin", t: "Pinned" };
    if (r.owned.length) return { k: "own", t: `Owned · ${r.owned.join(", ")}` };
    return { k: "ok", t: "Can appear" };
  }

  poolHtml() {
    const { rows, cfg, missing } = this.data;
    const sum = EQUIP_TYPES.map((t) => {
      const live = rows.filter((r) => r.type === t && !r.block);
      const fresh = live.filter((r) => !r.owned.length).length, own = live.length - fresh, q = cfg.quota[t];
      return `<div><b class="${fresh < q ? "short" : ""}">${fresh} new / ${q} slots</b>${cap(t)} · ${own} owned as fallback</div>`;
    }).join("");
    const q = this.q.toLowerCase();
    const list = rows.filter((r) => {
      const k = this.rowStatus(r).k;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      switch (this.filter) {
        case "ok": return k === "ok" || k === "pin";
        case "own": return k === "own";
        case "auth": return r.needsAuthoring;
        case "blk": return k === "blk";
        case "now": return r.onSale;
        default: return true;
      }
    }).sort((a, b) => EQUIP_TYPES.indexOf(a.type) - EQUIP_TYPES.indexOf(b.type) || RARITIES.indexOf(a.rarity) - RARITIES.indexOf(b.rarity) || a.name.localeCompare(b.name));
    const trs = list.map((r) => {
      const st = this.rowStatus(r);
      const odds = st.k === "blk" ? `<span class="fu-rc-sub">—</span>` : `<span class="fu-rc-bar"><i style="width:${Math.round(r.odds * 100)}%"></i></span>${r.odds > 0 && r.odds < 0.005 ? "<1" : Math.round(r.odds * 100)}%`;
      return `<tr class="${st.k === "blk" ? "dim" : ""}" data-id="${r.id}">
        <td><img src="${esc(r.img)}" alt=""></td>
        <td><b>${esc(r.name)}</b>${r.onSale ? `<span class="fu-rc-st sale">On sale</span>` : ""}<div class="fu-rc-sub">${esc(r.type)}${r.category ? " · " + esc(r.category) : ""}</div></td>
        <td><span class="fu-rc-rar ${r.rarity}" title="${r.rawRarity ? "" : "No rarity set: rolls as Uncommon"}">${r.rarity}${r.rawRarity ? "" : " ?"}</span></td>
        <td><input class="fu-rc-price" type="number" min="0" step="50" value="${r.price}" data-act="price"></td>
        <td><span class="fu-rc-st ${st.k}">${esc(st.t)}</span></td>
        <td style="white-space:nowrap">${odds}</td>
        <td><button type="button" class="fu-rc-tg ${r.pin ? "on" : ""}" data-act="pin">Pin</button>
            <button type="button" class="fu-rc-tg off ${r.off ? "on" : ""}" data-act="off">Off</button>
            ${r.isSet && r.setName ? `<button type="button" class="fu-rc-tg ${cfg.allowedSets.includes(r.setName) ? "on" : ""}" data-act="allowset" data-set="${esc(r.setName)}" title="Allow every piece of ${esc(r.setName)} to roll here (each piece rolls on its own)">Allow set</button>` : ""}
            ${r.needsAuthoring ? `<button type="button" class="fu-rc-tg" data-act="authored" title="Mark as authored: it can roll from now on">Authored ✓</button>` : ""}
            <button type="button" class="fu-rc-tg" data-act="remove" title="Remove from the pool">✕</button></td></tr>`;
    }).join("");
    return `<div class="fu-rc-sum">${sum}</div>
      <div class="fu-rc-filters">${FILTERS.map(([k, l]) => `<span class="fu-rc-chip ${this.filter === k ? "on" : ""}" data-filter="${k}">${l}</span>`).join("")}
        <input type="search" placeholder="Search" value="${esc(this.q)}" data-act="search"></div>
      <div class="fu-rc-tbl"><table><thead><tr><th></th><th>Item</th><th>Rarity</th><th>Price</th><th>Status</th><th>Next roll</th><th></th></tr></thead><tbody>${trs || `<tr><td colspan="7">Nothing matches.</td></tr>`}</tbody></table></div>
      <div class="fu-rc-drop" data-drop>Drop a world item (weapon, armor, shield, accessory) here to add it to the pool.${missing.length ? ` · ${missing.length} pool entr${missing.length > 1 ? "ies point" : "y points"} at deleted items.` : ""}</div>`;
  }

  rulesHtml() {
    const { cfg, perRarity } = this.data;
    const num = (path, v, step = 1, min = 0) => `<input type="number" data-cfg="${path}" value="${v}" step="${step}" min="${min}">`;
    return `<div class="fu-rc-rules">
      <div class="fu-rc-box"><h3>Slots per category</h3><p>Listings per tab.</p>
        ${EQUIP_TYPES.map((t) => `<div class="fu-rc-row"><span>${cap(t)}</span>${num(`quota.${t}`, cfg.quota[t])}<span></span></div>`).join("")}</div>
      <div class="fu-rc-box"><h3>Rarity weights</h3><p>Each slot picks a rarity by weight, then an item of it. Right: average per roster.</p>
        ${RARITIES.map((r) => `<div class="fu-rc-row"><span class="fu-rc-rar ${r}">${r}</span>${num(`weights.${r}`, cfg.weights[r])}<span class="fu-rc-sub">${perRarity[r].toFixed(1)} per roster</span></div>`).join("")}</div>
      <div class="fu-rc-box"><h3>Signature &amp; cap</h3>
        <label><input type="checkbox" data-cfg="signature" ${cfg.signature ? "checked" : ""}> Guarantee one unowned Legendary per roster</label>
        <div class="fu-rc-row"><span>Legendary cap</span>${num("legendaryCap", cfg.legendaryCap)}<span></span></div></div>
      <div class="fu-rc-box"><h3>Variety &amp; rules</h3>
        <div class="fu-rc-row"><span>Repeat weight</span>${num("repeatWeight", cfg.repeatWeight, 0.05)}<span class="fu-rc-sub">for items in the roster being replaced</span></div>
        <div class="fu-rc-row"><span>Cooldown (h)</span>${num("cooldownHours", cfg.cooldownHours)}<span class="fu-rc-sub">one restock per Rest within this window</span></div>
        <label><input type="checkbox" data-cfg="stockRules" ${cfg.stockRules ? "checked" : ""}> Skip monster-stealable items and items another shop sells now</label>
        <div class="fu-rc-row"><span>Allowed sets</span><span class="fu-rc-sub">${cfg.allowedSets.length ? cfg.allowedSets.map(esc).join(", ") : "none: set pieces never roll"}</span><span></span></div>
        <button type="button" class="fu-rc-btn" data-act="defaults">Reset rules to defaults</button></div></div>`;
  }

  histHtml() {
    const h = [...(this.data.state?.history ?? [])].reverse();
    return `<div class="fu-rc-hist">${h.map((e) => `<div><b>${esc(new Date(e.at).toLocaleString())} · ${esc(e.reason)}</b>${e.seed != null ? ` <span class="fu-rc-sub">seed ${Number(e.seed).toString(16)}</span>` : ""}${e.repeats ? ` <span class="fu-rc-sub">· ${e.repeats} repeat(s)</span>` : ""}<br>${(e.names ?? []).map(esc).join(" · ")}</div>`).join("") || "No restocks yet."}</div>`;
  }

  html() {
    const s = this.data.state;
    return `<div class="fu-rc">${CSS}
      <div class="fu-rc-top"><span class="fu-rc-status">${this.statusLine()}</span>
        <button type="button" class="fu-rc-btn" data-act="reroll">🎲 Reroll now</button>
        <button type="button" class="fu-rc-btn" data-act="undo" ${s?.previous ? "" : "disabled"}>↩ Undo last roll</button>
        <button type="button" class="fu-rc-btn" data-act="lock">${s?.locked ? "🔓 Unlock" : "🔒 Lock roster"}</button></div>
      <div class="fu-rc-tabs">${[["pool", "Pool"], ["rules", "Roll rules"], ["hist", "History"]].map(([k, l]) => `<div class="fu-rc-tab ${this.tab === k ? "active" : ""}" data-tab="${k}">${l}</div>`).join("")}</div>
      <div class="fu-rc-body">${this.tab === "pool" ? this.poolHtml() : this.tab === "rules" ? this.rulesHtml() : this.histHtml()}</div></div>`;
  }

  root() { return this.dlg?.element?.[0]?.querySelector?.(".fu-rc-host") ?? null; }

  paint() {
    const host = this.root();
    if (!host) return;
    const scroll = host.querySelector(".fu-rc-tbl")?.scrollTop ?? 0;
    host.innerHTML = this.html();
    const tbl = host.querySelector(".fu-rc-tbl");
    if (tbl) tbl.scrollTop = scroll;
  }

  // ── edits ──────────────────────────────────────────────────────────────
  async run(fn) {
    if (this.busy) return;
    this.busy = true;
    try { await fn(); } catch (e) { console.error(TAG, e); ui.notifications?.error?.(`Roster: ${e.message}`); }
    finally { this.busy = false; }
    await this.refresh();
  }

  async editPool(id, change) {
    const state = api().getState(this.actor);
    const pool = (state.pool ?? []).map((e) => (e.id === id ? change(e) : e)).filter(Boolean);
    await api().patchState(this.actor, { pool });
  }

  async editConfig(path, value) {
    const state = api().getState(this.actor);
    const cfg = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONFIG), state.config ?? {}, { inplace: false });
    foundry.utils.setProperty(cfg, path, value);
    await api().patchState(this.actor, { config: cfg });
  }

  async addItem(uuid) {
    const it = await fromUuid(uuid);
    if (!it || it.documentName !== "Item") return ui.notifications?.warn?.("That isn't an item.");
    if (it.parent || it.pack) return ui.notifications?.warn?.("Drop the item from the Items sidebar (a world item), not from an actor or compendium.");
    if (!EQUIP_TYPES.includes(String(it.system?.props?.item_type ?? "").toLowerCase())) return ui.notifications?.warn?.("Only weapons, armor, shields and accessories roll; consumables and tackle stay fixed.");
    const state = api().getState(this.actor);
    if ((state.pool ?? []).some((e) => e.id === it.id)) return ui.notifications?.info?.(`${it.name} is already in the pool.`);
    await api().patchState(this.actor, { pool: [...(state.pool ?? []), { id: it.id }] });
    ui.notifications?.info?.(`${it.name} added to ${this.actor.name}'s pool.`);
  }

  bind(host) {
    host.addEventListener("click", (ev) => {
      const t = ev.target;
      const tab = t.closest("[data-tab]");
      if (tab) { this.tab = tab.dataset.tab; return this.paint(); }
      const chip = t.closest("[data-filter]");
      if (chip) { this.filter = chip.dataset.filter; return this.paint(); }
      const btn = t.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act, id = btn.closest("tr")?.dataset.id;
      if (act === "reroll") return this.run(() => api().reroll(this.actor, { reason: "Reroll", refill: false }));
      if (act === "undo") return this.run(() => api().undo(this.actor));
      if (act === "lock") return this.run(() => api().setLocked(this.actor, !api().getState(this.actor)?.locked));
      if (act === "defaults") return this.run(() => api().patchState(this.actor, { config: null }));
      if (act === "pin") return this.run(() => this.editPool(id, (e) => ({ ...e, pin: !e.pin })));
      if (act === "off") return this.run(() => this.editPool(id, (e) => ({ ...e, off: !e.off })));
      if (act === "allowset") {
        const name = btn.dataset.set;
        return this.run(() => {
          const cur = this.data.cfg.allowedSets;
          return this.editConfig("allowedSets", cur.includes(name) ? cur.filter((s) => s !== name) : [...cur, name]);
        });
      }
      if (act === "authored") return this.run(() => this.editPool(id, (e) => { const n = { ...e }; delete n.authoring; return n; }));
      if (act === "remove") return this.run(() => this.editPool(id, () => null));
    });
    host.addEventListener("change", (ev) => {
      const t = ev.target;
      if (t.dataset.act === "price") {
        const id = t.closest("tr")?.dataset.id, v = Math.max(0, Math.round(Number(t.value) || 0));
        return this.run(() => this.editPool(id, (e) => ({ ...e, price: v })));
      }
      if (t.dataset.cfg) {
        const v = t.type === "checkbox" ? t.checked : Number(t.value);
        if (t.type !== "checkbox" && !Number.isFinite(v)) return;
        return this.run(() => this.editConfig(t.dataset.cfg, v));
      }
    });
    host.addEventListener("input", (ev) => {
      if (ev.target.dataset.act !== "search") return;
      this.q = ev.target.value;
      const pos = ev.target.selectionStart;
      this.paint();
      const s = this.root()?.querySelector("[data-act=search]");
      if (s) { s.focus(); s.setSelectionRange(pos, pos); }
    });
    host.addEventListener("dragover", (ev) => { const d = ev.target.closest("[data-drop]"); if (d) { ev.preventDefault(); d.classList.add("hover"); } });
    host.addEventListener("dragleave", (ev) => ev.target.closest("[data-drop]")?.classList.remove("hover"));
    host.addEventListener("drop", (ev) => {
      const d = ev.target.closest("[data-drop]");
      if (!d) return;
      ev.preventDefault();
      d.classList.remove("hover");
      const data = TextEditor.getDragEventData(ev);
      if (data?.type !== "Item" || !data.uuid) return ui.notifications?.warn?.("Drop an Item.");
      this.run(() => this.addItem(data.uuid));
    });
  }

  async render() {
    this.data = await api().inspect(this.actor);
    this.dlg = new Dialog({
      title: `Roster — ${this.actor.name}`,
      content: `<div class="fu-rc-host">${this.html()}</div>`,
      buttons: { close: { icon: '<i class="fas fa-times"></i>', label: "Close" } },
      default: "close",
      render: (html) => {
        const host = (html instanceof jQuery ? html[0] : html).querySelector(".fu-rc-host");
        if (host) this.bind(host);
      },
      close: () => { open.delete(this.actor.id); Hooks.off("updateActor", this.hook); },
    }, { width: 860, height: "auto", resizable: true });
    // Another GM's edit (or a Rest) changes the flag: keep this view current.
    this.hook = Hooks.on("updateActor", (a, diff) => {
      if (a.id === this.actor.id && foundry.utils.hasProperty(diff, "flags.fabula-ultima-companion.shopRoster") && !this.busy) this.refresh();
    });
    this.dlg.render(true);
  }
}

export async function openConsole(actorOrId) {
  if (!game.user?.isGM) return ui.notifications?.warn?.("The roster console is GM-only.");
  const actor = typeof actorOrId === "string" ? game.actors.get(actorOrId) : actorOrId;
  if (!actor || !api()?.isRosterShop(actor)) return ui.notifications?.warn?.("That actor has no randomized roster.");
  const existing = open.get(actor.id);
  if (existing?.dlg?.rendered) { existing.dlg.bringToTop?.(); return existing; }
  const c = new RosterConsole(actor);
  open.set(actor.id, c);
  await c.render();
  return c;
}

globalThis.FUCompanion ??= {};
globalThis.FUCompanion.shopRosterConsole = { open: openConsole };
