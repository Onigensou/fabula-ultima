// Party Menu — Bestiary view.
//
// The Monster Encyclopedia (encyclopedia-core.js: one journal page per creature
// the party has met, filled in by Study checks and by watching it act) drawn as
// a game bestiary instead of a journal: a portrait wall on the left, the entry
// on the right in four pages (Profile · Resistances · Actions · Loot).
//
// Everything shown comes from FUCompanion.api.encyclopedia.listEntries(), which
// applies the journal's own reveal rules (Identity ≥ 7, Stats ≥ 8, Details ≥ 13,
// actions once witnessed). This view never decides what a player may see. A GM
// can switch on "Reveal all", which marks what the party has NOT unlocked yet.
//
// Interactive bits the journal cannot do: search; filter by study progress
// (Tab); sort (S button); and "Weak to…" — pick an element and the wall keeps
// only creatures the party KNOWS are vulnerable to it.

import { esc, safeHtml, play, SND, img, gridStep } from "./party-menu-ui.js";

const ELEMENTS = [
  ["physical", "Physical", "fa-hand-fist"], ["air", "Air", "fa-wind"], ["bolt", "Bolt", "fa-bolt"],
  ["dark", "Dark", "fa-moon"], ["earth", "Earth", "fa-mountain"], ["fire", "Fire", "fa-fire"],
  ["ice", "Ice", "fa-snowflake"], ["light", "Light", "fa-sun"], ["poison", "Poison", "fa-skull-crossbones"],
];
const GRADE = { VU: "Vulnerable", RS: "Resistant", IM: "Immune", AB: "Absorbs", NA: "Normal" };
const WEAPON_ICON = {
  arcane: "fa-book", bow: "fa-bullseye", brawling: "fa-hand-fist", dagger: "fa-khanda", firearm: "fa-gun",
  flail: "fa-gavel", heavy: "fa-hammer", spear: "fa-location-arrow", sword: "fa-khanda", thrown: "fa-bomb",
};
const KIND = { attack: ["Attack", "fa-khanda"], skill: ["Skill", "fa-burst"], spell: ["Spell", "fa-wand-sparkles"], passive: ["Passive", "fa-shield-halved"] };
const FILTERS = [
  { id: "all", label: "All", icon: "fa-layer-group" },
  { id: "studied", label: "Studied", icon: "fa-book-open" },
  { id: "unstudied", label: "Unstudied", icon: "fa-question" },
  { id: "complete", label: "Complete", icon: "fa-crown" },
];
const SORTS = [
  { id: "rank", label: "Rank" },
  { id: "name", label: "Name" },
  { id: "recent", label: "Recent" },
];
const PAGES = [
  { id: "profile", label: "Profile", icon: "fa-id-card" },
  { id: "resist", label: "Resistances", icon: "fa-shield-halved" },
  { id: "actions", label: "Actions", icon: "fa-burst" },
  { id: "loot", label: "Loot", icon: "fa-sack-dollar" },
];
const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1).toLowerCase() : "");

// ── data (cached; any journal page or actor change drops it) ──
let _cache = null;
for (const h of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage",
  "createActor", "updateActor", "deleteActor", "updateItem"]) {
  Hooks.on(h, () => { _cache = null; });
}

function entriesFor(reveal) {
  if (_cache?.reveal === reveal) return _cache.list;
  const enc = globalThis.FUCompanion?.api?.encyclopedia;
  let list = [];
  try { list = enc?.listEntries?.({ reveal }) ?? []; } catch (e) { console.warn("[PartyMenu] bestiary read failed", e); }
  // Party members get studied too (by enemies); they are not creatures to catalogue.
  // A page whose actor was deleted (old test dummies) has nothing left to show.
  list = list.filter((e) => { const a = e.actorId ? game.actors?.get(e.actorId) : null; return a && !a.hasPlayerOwner; });
  _cache = { reveal, list };
  return list;
}

const tierCount = (e) => (e.tiers.details ? 3 : e.tiers.stats ? 2 : e.tiers.identity ? 1 : 0);

function visible(ctx) {
  const v = ctx.S.v;
  let list = entriesFor(!!v.reveal);
  if (v.filter === "studied") list = list.filter((e) => e.tiers.identity);
  else if (v.filter === "unstudied") list = list.filter((e) => !e.tiers.identity);
  else if (v.filter === "complete") list = list.filter((e) => e.tiers.details);
  if (v.weak) {
    const i = ELEMENTS.findIndex(([id]) => id === v.weak);
    list = list.filter((e) => e.details?.affinities?.[i]?.code === "VU");
  }
  const q = v.query.trim().toLowerCase();
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
  const byName = (a, b) => a.name.replace(/^\W+/, "").localeCompare(b.name.replace(/^\W+/, ""));
  const sorted = [...list];
  if (v.sort === "name") sorted.sort(byName);
  else if (v.sort === "recent") sorted.sort((a, b) => b.lastUpdated - a.lastUpdated || byName(a, b));
  else sorted.sort((a, b) => a.sort.rank - b.sort.rank || a.sort.level - b.sort.level || byName(a, b));
  return sorted;
}

// ── pieces ──
const lock = (what, n) => `<div class="pm-blk-lock"><i class="fas fa-lock"></i><b>${esc(what)}</b><span>Study ${n}+ to reveal</span></div>`;
const hiddenMark = (x) => (x?.hidden ? ` <i class="fas fa-eye-slash pm-gmhidden" title="Not unlocked by the party — shown because Reveal all is on"></i>` : "");

function tierMeter(e) {
  const steps = [["identity", "Identity", "fa-id-card"], ["stats", "Stats", "fa-dice-d20"], ["details", "Details", "fa-book-open"]].map(([k, label, icon]) =>
    `<span class="pm-tstep ${e.tiers[k] ? "is-on" : ""}" title="${label}: revealed by a Study check of ${e.thresholds[k]}+">
      <i class="fas ${e.tiers[k] ? icon : "fa-lock"}"></i>${label}<em>${e.thresholds[k]}+</em></span>`).join(`<i class="fas fa-chevron-right pm-tsep"></i>`);
  return `<div class="pm-tier"><div class="pm-tsteps">${steps}</div>
      <div class="pm-sub">${e.best ? `Best Study check <b>${e.best}</b>${e.bestBy ? ` by ${esc(e.bestBy)}` : ""}` : "Not studied yet — use Study in battle."}</div>
    </div>`;
}

function profile(e) {
  const id = e.identity;
  const meta = id ? [id.level && `Lv ${id.level}`, cap(id.rank), [cap(id.species), cap(id.subtype)].filter(Boolean).join(" / "), id.attribute && cap(id.attribute)]
    .filter(Boolean).join(" · ") : "Level, rank and type unknown";
  const vit = id
    ? `<div class="pm-bvit">${[["HP", id.hp, "hp"], ["MP", id.mp, "mp"], ["DEF", id.def, ""], ["M.DEF", id.mdef, ""]].map(([k, val, c]) =>
      `<div><em class="${c}">${k}</em><b>${esc(val ?? "—")}</b></div>`).join("")}</div>`
    : lock("Vital statistics", e.thresholds.identity);
  const st = e.stats
    ? `<div class="pm-attrs">${["MIG", "DEX", "INS", "WLP"].map((k) => `<div class="pm-attr"><em>${k}</em><b>d${esc(e.stats[k] ?? "?")}</b></div>`).join("")}</div>`
    : lock("Attributes", e.thresholds.stats);
  return `
    <div class="pm-bxhead">
      <div class="pm-portrait ${e.tiers.identity ? "" : "is-unknown"}">${img(e.img)}</div>
      <div class="pm-bxtitle">
        <div class="pm-detail-name">${esc(e.name)}</div>
        <div class="pm-sub">${esc(meta)}${hiddenMark(id)}</div>
        ${id?.traits ? `<div class="pm-btraits">${esc(id.traits)}</div>` : ""}
      </div>
    </div>
    ${tierMeter(e)}
    <div class="pm-label">Vital statistics${hiddenMark(id)}</div>${vit}
    <div class="pm-label">Attributes${hiddenMark(e.stats)}</div>${st}
    ${id?.description ? `<div class="pm-desc">${safeHtml(id.description)}</div>` : ""}`;
}

function resist(e, v) {
  const d = e.details;
  if (!d) {
    // Before Details, elements the party HIT it with are already known (learn-by-hitting).
    const learned = (e.affinityRow ?? []).filter((a) => a.known);
    if (!learned.length) return lock("Affinities, weapon efficiency and status resistances", e.thresholds.details);
    const row = (e.affinityRow ?? []).map((a, i) => {
      const [, , icon] = ELEMENTS[i];
      return a.known
        ? `<div class="pm-aff aff-${esc(String(a.code).toLowerCase())}" title="${esc(`${a.el}: ${GRADE[a.code] ?? a.code} (learned by hitting it)`)}"><i class="fas ${icon}"></i><b>${a.code === "NA" ? "—" : esc(a.code)}</b></div>`
        : `<div class="pm-aff" title="${esc(`${a.el}: unknown`)}"><i class="fas ${icon}" style="opacity:.35"></i><b>?</b></div>`;
    }).join("");
    return `
    <div class="pm-label">Affinities</div>
    <div class="pm-affs">${row}</div>
    <div class="pm-sub pm-bnote">${learned.length} learned by hitting it in battle. Study ${e.thresholds.details}+ reveals the rest.</div>
    ${lock("Weapon efficiency and status resistances", e.thresholds.details)}`;
  }
  const aff = d.affinities.map((a, i) => {
    const [id, , icon] = ELEMENTS[i];
    return `<div class="pm-aff aff-${esc(a.code.toLowerCase())} pm-hit ${v.weak === id ? "is-on" : ""}" data-action="bx-weak" data-id="${id}"
      title="${esc(`${a.el}: ${GRADE[a.code] ?? a.code}`)}"><i class="fas ${icon}"></i><b>${a.code === "NA" ? "—" : esc(a.code)}</b></div>`;
  }).join("");
  // Only what differs from 100% is worth a row; the rest is one line.
  const odd = d.weapons.filter((w) => w.pct !== 100);
  const wep = odd.map((w) => {
    const off = w.pct - 100;
    const width = Math.min(50, Math.abs(off) / 2);
    return `<div class="pm-bwep ${off > 0 ? "is-weak" : "is-tough"}" title="${esc(cap(w.type))}: ${w.pct}% damage">
      <i class="fas ${WEAPON_ICON[w.type] ?? "fa-khanda"}"></i><span>${esc(cap(w.type))}</span>
      <div class="pm-bwbar"><i style="${off >= 0 ? "left:50%" : "right:50%"};width:${width}%"></i></div><b>${w.pct}%</b></div>`;
  }).join("") + `<div class="pm-sub pm-bwrest">${odd.length ? "Every other weapon: 100%" : "Every weapon deals normal (100%) damage."}</div>`;
  const cond = d.conditions.length
    ? d.conditions.map((c) => `<span class="pm-bcond aff-${esc(c.code.toLowerCase())}">${esc(cap(c.name))} <b>${esc(c.code)}</b></span>`).join("")
    : `<span class="pm-sub">No special status resistances.</span>`;
  return `
    <div class="pm-label">Affinities${hiddenMark(d)}</div>
    <div class="pm-affs">${aff}</div>
    <div class="pm-sub pm-bnote">Click an element to list every creature known to be weak to it.</div>
    <div class="pm-label">Weapon efficiency</div>
    <div class="pm-bweps">${wep}</div>
    <div class="pm-label">Status resistances</div>
    <div class="pm-bconds">${cond}</div>`;
}

function actions(e, v) {
  if (!e.actions.length) return `<div class="pm-empty">No actions recorded for this creature.</div>`;
  const seen = e.actions.filter((a) => !a.hidden).length;
  const rows = e.actions.map((a, i) => {
    const [kind, icon] = KIND[a.kind] ?? ["Action", "fa-burst"];
    if (!a.known) {
      return `<div class="pm-bact is-unknown"><div class="pm-bacticon"><i class="fas fa-question"></i></div>
        <div><div class="pm-bactname">??? <span class="pm-bkind"><i class="fas ${icon}"></i>${kind}</span></div>
        <div class="pm-sub">Not seen in battle yet.</div></div></div>`;
    }
    const open = v.act === i;
    return `<div class="pm-bact pm-hit ${open ? "is-open" : ""}" data-action="bx-act" data-index="${i}">
      ${img(a.img, "pm-bacticon")}
      <div><div class="pm-bactname">${esc(a.name)}${hiddenMark(a)} <span class="pm-bkind"><i class="fas ${icon}"></i>${kind}</span>${a.meta ? `<span class="pm-bmeta">${esc(a.meta)}</span>` : ""}</div>
      ${a.description ? `<div class="pm-desc ${open ? "" : "is-clamped"}">${safeHtml(a.description)}</div>` : ""}</div></div>`;
  }).join("");
  return `<div class="pm-sub pm-bnote"><b>${seen}</b> of <b>${e.actions.length}</b> actions seen. Each one is added when the party watches it used. Click one to read it in full.</div>${rows}`;
}

function loot(e) {
  if (!e.steal) return lock("Loot", e.thresholds.identity);
  if (!e.steal.length) return `<div class="pm-empty">Nothing worth stealing.</div>`;
  return `<div class="pm-label">Can be stolen${hiddenMark(e.identity)}</div>` + e.steal.map((s) => `
    <div class="pm-bact">${img(s.img, "pm-bacticon")}<div><div class="pm-bactname">${esc(s.name)}</div>
    ${s.description ? `<div class="pm-desc">${safeHtml(s.description)}</div>` : ""}</div></div>`).join("");
}

function tile(e, i, v, cur) {
  const n = tierCount(e);
  const weakI = v.weak ? ELEMENTS.findIndex(([id]) => id === v.weak) : -1;
  return `<div class="pm-btile pm-hit ${cur ? "is-cursor" : ""} ${n ? "" : "is-unknown"}" data-action="bx-entry" data-index="${i}" title="${esc(e.name)}">
      <div class="pm-btimg">${img(e.img)}${weakI >= 0 ? `<span class="pm-btweak"><i class="fas ${ELEMENTS[weakI][2]}"></i>VU</span>` : ""}</div>
      <div class="pm-btname">${esc(e.name)}</div>
      <div class="pm-btstars" title="${esc(e.tier)}">${[0, 1, 2].map((k) => `<i class="fas fa-diamond ${k < n ? "on" : ""}"></i>`).join("")}</div>
    </div>`;
}

export const bestiaryView = {
  id: "bestiary",
  title: "Bestiary",

  enter(ctx) {
    ctx.S.v = { idx: 0, filter: "all", sort: "rank", query: "", weak: null, page: "profile", act: -1, reveal: false, picked: null };
  },

  nav(ctx) {
    const v = ctx.S.v;
    // Esc clears the search first, then the "Weak to" filter, then leaves.
    const clear = v.query ? "Clear search" : v.weak ? "Clear Weak to" : "";
    return { crumbs: ["Bestiary"], actions: clear ? [{ key: "Escape", label: clear, icon: "fa-xmark" }] : [] };
  },

  render(ctx) {
    const v = ctx.S.v;
    const all = entriesFor(!!v.reveal);
    const list = visible(ctx);
    // Keep the same creature under the hand across re-sorts and filters.
    if (v.picked) { const at = list.findIndex((e) => e.pageId === v.picked); if (at >= 0) v.idx = at; }
    v.idx = Math.max(0, Math.min(v.idx, Math.max(0, list.length - 1)));
    const sel = list[v.idx] ?? null;
    v.picked = sel?.pageId ?? null;

    const studied = all.filter((e) => e.tiers.identity).length;
    const complete = all.filter((e) => e.tiers.details).length;
    const acts = all.reduce((n, e) => n + e.actions.length, 0);
    const seenActs = all.reduce((n, e) => n + e.actions.filter((a) => !a.hidden).length, 0);
    const pct = all.length ? Math.round((complete / all.length) * 100) : 0;

    const filters = FILTERS.map((f) => `<span class="pm-tab pm-hit ${v.filter === f.id ? "is-on" : ""}" data-action="bx-filter" data-id="${f.id}"><i class="fas ${f.icon}"></i>${f.label}</span>`).join("");
    const weak = ELEMENTS.map(([id, label, icon]) => `<span class="pm-bweak pm-hit ${v.weak === id ? "is-on" : ""}" data-action="bx-weak" data-id="${id}" title="Weak to ${label}"><i class="fas ${icon}"></i></span>`).join("");
    const sortLabel = SORTS.find((s) => s.id === v.sort)?.label ?? "Rank";
    const tiles = list.map((e, i) => tile(e, i, v, v.idx === i)).join("")
      || `<div class="pm-empty">${v.weak ? `None known to be weak to ${esc(cap(v.weak))} yet.` : all.length ? "No creatures match." : "The party hasn't met any creatures yet."}</div>`;
    const pages = PAGES.map((p) => `<span class="pm-tab pm-hit ${v.page === p.id ? "is-on" : ""}" data-action="bx-page" data-id="${p.id}"><i class="fas ${p.icon}"></i>${p.label}</span>`).join("");
    const body = !sel ? `<div class="pm-empty">Nothing selected.</div>`
      : v.page === "resist" ? resist(sel, v) : v.page === "actions" ? actions(sel, v) : v.page === "loot" ? loot(sel) : profile(sel);

    return `
      <div class="pm-ability pm-bestiary">
        ${ctx.nav()}
        <div class="pm-ability-top">
          <div class="pm-win pm-title"><span class="pm-pill">Bestiary</span></div>
          <div class="pm-win pm-who pm-who-plain pm-bxbar">
            <div class="pm-bxstats">
              <div><b>${all.length}</b><span>met</span></div>
              <div><b>${studied}</b><span>studied</span></div>
              <div><b>${complete}</b><span>complete</span></div>
              <div><b>${seenActs}/${acts}</b><span>actions seen</span></div>
            </div>
            <div class="pm-bxprog" title="${pct}% complete"><i style="width:${pct}%"></i></div>
            <input type="text" class="pm-search pm-bxsearch" placeholder="Search…" value="${esc(v.query)}" aria-label="Search the bestiary">
            ${game.user?.isGM ? `<span class="pm-btn pm-hit pm-mini ${v.reveal ? "is-on" : ""}" data-action="bx-reveal" title="GM: show what the party has not unlocked">${v.reveal ? "Party view" : "Reveal all"}</span>` : ""}
          </div>
        </div>
        <div class="pm-ability-body pm-bxbody">
          <div class="pm-win pm-skills">
            <div class="pm-tabs">${filters}<span class="pm-tab pm-hit pm-bxsort" data-action="bx-sort" title="Change the order"><i class="fas fa-arrow-down-wide-short"></i>${sortLabel}</span></div>
            <div class="pm-bweakrow"><span class="pm-label">Weak to</span>${weak}</div>
            <div class="pm-skill-list pm-btiles">${tiles}</div>
          </div>
          <div class="pm-win pm-detail">
            <div class="pm-tabs pm-bxpages">${pages}</div>
            <div class="pm-scroll" data-key="bx|${esc(sel?.pageId ?? "")}|${v.page}">${body}</div>
          </div>
        </div>
      </div>`;
  },

  move(ctx, i) {
    const v = ctx.S.v;
    const list = visible(ctx);
    if (!list[i]) return;
    v.idx = i; v.picked = list[i].pageId; v.act = -1;
    play(SND.move, 0.4);
    ctx.render();
  },

  setPage(ctx, delta) {
    const v = ctx.S.v;
    const i = PAGES.findIndex((p) => p.id === v.page);
    v.page = PAGES[(i + delta + PAGES.length) % PAGES.length].id;
    v.act = -1;
    ctx.animate("page");
    play(SND.move, 0.45);
    ctx.render();
  },

  // render() keeps the same creature under the hand (v.picked) when it is still listed.
  refilter(ctx) { ctx.resetScroll(); ctx.render(); },

  key(ctx, k, ev) {
    const v = ctx.S.v;
    const typing = ev?.target?.classList?.contains("pm-search");
    if (k === "Escape") {
      if (typing || v.query) { v.query = ""; ev?.target?.blur?.(); play(SND.back); ctx.render(); return; }
      if (v.weak) { v.weak = null; play(SND.back); this.refilter(ctx); return; }
      return ctx.back();
    }
    if (k === "Tab") {
      const i = FILTERS.findIndex((f) => f.id === v.filter);
      v.filter = FILTERS[(i + (ev?.shiftKey ? -1 : 1) + FILTERS.length) % FILTERS.length].id;
      play(SND.move, 0.45);
      return this.refilter(ctx);
    }
    if (k === "q" || k === "Q" || k === "PageUp") return this.setPage(ctx, -1);
    if (k === "e" || k === "E" || k === "PageDown") return this.setPage(ctx, 1);
    if (k === "Enter") { if (typing) ev.target.blur(); return this.setPage(ctx, 1); }
    if (k.startsWith("Arrow")) {
      const next = gridStep(ctx.root(), ".pm-btiles .pm-btile", v.idx, k);
      if (next !== null && next >= 0) this.move(ctx, next);
    }
  },

  input(ctx, ev) {
    if (!ev.target.classList?.contains("pm-bxsearch")) return;
    ctx.S.v.query = ev.target.value;
    ctx.S.v.idx = 0; ctx.S.v.picked = null;
    ctx.focusSearch();
    ctx.render();
  },

  async click(ctx, a, el) {
    const v = ctx.S.v;
    if (a === "bx-entry") { const i = Number(el.dataset.index); if (i !== v.idx) this.move(ctx, i); }
    else if (a === "bx-filter") { v.filter = el.dataset.id; play(SND.move, 0.45); this.refilter(ctx); }
    else if (a === "bx-sort") {
      const i = SORTS.findIndex((s) => s.id === v.sort);
      v.sort = SORTS[(i + 1) % SORTS.length].id; play(SND.move, 0.45); this.refilter(ctx);
    } else if (a === "bx-weak") {
      v.weak = v.weak === el.dataset.id ? null : el.dataset.id;
      play(v.weak ? SND.ok : SND.back, 0.5);
      this.refilter(ctx);
    } else if (a === "bx-page") { if (v.page !== el.dataset.id) ctx.animate("page"); v.page = el.dataset.id; v.act = -1; play(SND.move, 0.45); ctx.render(); }
    else if (a === "bx-act") { const i = Number(el.dataset.index); v.act = v.act === i ? -1 : i; play(SND.move, 0.4); ctx.render(); }
    else if (a === "bx-reveal" && game.user?.isGM) { v.reveal = !v.reveal; _cache = null; play(SND.ok, 0.5); ctx.render(); }
  },

  hover(ctx, a, i) {
    const v = ctx.S.v;
    if (a === "bx-entry" && v.idx !== i) {
      const list = visible(ctx);
      if (!list[i]) return false;
      v.idx = i; v.picked = list[i].pageId; v.act = -1;
      return true;
    }
    return false;
  },
};

// The search box swallows typing; arrows/Enter/Escape still reach key() (party-menu-app onKey).
export const BESTIARY_CSS = `
#fud-party-menu .pm-bestiary { width: min(1180px, 100%); }
#fud-party-menu .pm-bxbody { grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); }
#fud-party-menu .pm-bxbar { display: flex; align-items: center; gap: 16px; }
#fud-party-menu .pm-bxstats { display: flex; gap: 18px; }
#fud-party-menu .pm-bxstats div { display: flex; flex-direction: column; align-items: center; line-height: 1.1; }
#fud-party-menu .pm-bxstats b { font-size: 20px; font-variant-numeric: tabular-nums; }
#fud-party-menu .pm-bxstats span { font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .06em; }
#fud-party-menu .pm-bxprog { flex: 1 1 auto; min-width: 60px; height: 8px; border-radius: 4px; overflow: hidden; background: rgba(59,42,25,.14);
  box-shadow: inset 0 1px 2px rgba(0,0,0,.25), 0 0 0 1px rgba(80,52,30,.35); }
#fud-party-menu .pm-bxprog i { display: block; height: 100%; background: linear-gradient(180deg, #f4d488, #caa44d); }
#fud-party-menu .pm-bxsearch { width: 170px; flex: 0 0 auto; }
#fud-party-menu .pm-btn.pm-mini.is-on { filter: hue-rotate(-25deg) saturate(1.3); }
#fud-party-menu .pm-bxsort { margin-left: auto; }
#fud-party-menu .pm-bweakrow { display: flex; align-items: center; gap: 4px; padding: 0 0 8px 24px; }
#fud-party-menu .pm-bweakrow .pm-label { margin-right: 6px; font-size: 11px; }
#fud-party-menu .pm-bweak { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
  color: var(--ink-soft); cursor: pointer; background: rgba(59,42,25,.05); box-shadow: inset 0 0 0 1px rgba(59,42,25,.15); }
#fud-party-menu .pm-bweak:hover { color: var(--accent); }
#fud-party-menu .pm-bweak.is-on { color: #fff; background: linear-gradient(#d65a4a, #9b2222); box-shadow: 0 0 8px rgba(200,60,60,.5); }
#fud-party-menu .pm-btiles { grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 10px; padding: 4px 18px 8px 36px; }
#fud-party-menu .pm-btile { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px; border-radius: 10px; cursor: pointer; min-width: 0; }
#fud-party-menu .pm-btile.is-cursor { background: linear-gradient(rgba(255,255,255,.55), rgba(255,255,255,.12) 70%);
  box-shadow: inset 0 0 0 1px rgba(154,122,43,.45), 0 0 10px var(--glow); }
#fud-party-menu .pm-btile.is-cursor::before { display: none; }
#fud-party-menu .pm-btile.is-cursor .pm-btimg { box-shadow: 0 0 0 2px var(--gold-2), 0 0 14px var(--glow), 0 3px 6px rgba(0,0,0,.25); }
#fud-party-menu .pm-btimg { position: relative; width: 72px; height: 72px; border-radius: 8px; overflow: hidden; background: var(--parchment-3);
  border: 2px solid var(--edge); box-shadow: 0 0 0 2px rgba(202,164,77,.45), 0 3px 6px rgba(0,0,0,.25); }
#fud-party-menu .pm-btimg img { width: 100%; height: 100%; object-fit: cover; object-position: top; border: 0; display: block; }
#fud-party-menu .pm-btile.is-unknown .pm-btimg img, #fud-party-menu .pm-portrait.is-unknown img { filter: grayscale(1) brightness(.55) contrast(1.1); }
#fud-party-menu .pm-btweak { position: absolute; right: 2px; bottom: 2px; font-size: 10px; font-weight: 700; color: #fff; padding: 0 4px; border-radius: 4px;
  background: rgba(155,34,34,.9); display: flex; gap: 3px; align-items: center; }
#fud-party-menu .pm-btname { font-size: 12.5px; font-weight: 700; max-width: 100%; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#fud-party-menu .pm-btstars { display: flex; gap: 3px; font-size: 8px; color: rgba(59,42,25,.22); }
#fud-party-menu .pm-btstars i.on { color: var(--gold-2); text-shadow: 0 0 4px var(--glow); }
#fud-party-menu .pm-bxpages { padding-left: 16px; }
#fud-party-menu .pm-bxhead { display: flex; gap: 14px; align-items: center; margin-bottom: 8px; }
#fud-party-menu .pm-bxtitle { min-width: 0; }
#fud-party-menu .pm-btraits { font-style: italic; color: var(--ink-soft); font-size: 13px; margin-top: 4px; }
#fud-party-menu .pm-tier { margin: 6px 0 12px; }
#fud-party-menu .pm-tsteps { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
#fud-party-menu .pm-tstep { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 13px; font-weight: 700;
  color: var(--ink-dim); background: rgba(59,42,25,.06); box-shadow: inset 0 0 0 1px rgba(59,42,25,.15); }
#fud-party-menu .pm-tstep em { margin: 0; font-size: 11px; opacity: .8; }
#fud-party-menu .pm-tstep.is-on { color: #5c421e; background: linear-gradient(#fff7d5, #e2c46e); box-shadow: inset 0 0 0 1px rgba(120,86,40,.5), 0 0 8px var(--glow); }
#fud-party-menu .pm-tsep { font-size: 10px; color: var(--ink-dim); }
#fud-party-menu .pm-bvit { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 4px 0 10px; }
#fud-party-menu .pm-bvit div { display: flex; flex-direction: column; align-items: center; padding: 6px 4px; border-radius: 8px;
  background: rgba(255,247,213,.55); box-shadow: inset 0 0 0 1px rgba(154,122,43,.45); }
#fud-party-menu .pm-bvit b { font-size: 20px; font-variant-numeric: tabular-nums; }
#fud-party-menu .pm-bvit em { margin: 0; }
#fud-party-menu .pm-blk-lock { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 4px 0 12px; padding: 12px; border-radius: 10px;
  color: #f1e3c4; background: linear-gradient(rgba(40,26,12,.82), rgba(20,12,4,.88)); box-shadow: inset 0 0 0 1px rgba(0,0,0,.4); }
#fud-party-menu .pm-blk-lock i { font-size: 18px; color: var(--gold-1); }
#fud-party-menu .pm-blk-lock span { font-size: 12px; opacity: .75; }
#fud-party-menu .pm-gmhidden { color: #8a5a00; font-size: 11px; margin-left: 4px; }
#fud-party-menu .pm-aff.pm-hit { cursor: pointer; }
#fud-party-menu .pm-aff.is-on { box-shadow: 0 0 0 2px rgba(155,34,34,.7); }
#fud-party-menu .pm-bnote { margin: 0 0 10px; }
#fud-party-menu .pm-bweps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 16px; margin: 4px 0 12px; }
#fud-party-menu .pm-bwep { display: grid; grid-template-columns: 16px 64px minmax(30px, 1fr) 42px; align-items: center; gap: 6px; font-size: 13px; }
#fud-party-menu .pm-bwep i.fas { color: var(--ink-soft); font-size: 12px; }
#fud-party-menu .pm-bwep b { text-align: right; font-variant-numeric: tabular-nums; }
#fud-party-menu .pm-bwrest { grid-column: 1 / -1; }
#fud-party-menu .pm-bwep.is-weak b { color: var(--low); } #fud-party-menu .pm-bwep.is-tough b { color: var(--mp); }
#fud-party-menu .pm-bwbar { position: relative; height: 6px; border-radius: 3px; background: rgba(59,42,25,.1); }
#fud-party-menu .pm-bwbar::after { content: ""; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: rgba(59,42,25,.35); }
#fud-party-menu .pm-bwbar i { position: absolute; top: 0; bottom: 0; border-radius: 3px; }
#fud-party-menu .pm-bwep.is-weak .pm-bwbar i { background: linear-gradient(90deg, #f26b5b, #c0261c); }
#fud-party-menu .pm-bwep.is-tough .pm-bwbar i { background: linear-gradient(90deg, #2443c8, #6b8cff); }
#fud-party-menu .pm-bconds { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
#fud-party-menu .pm-bcond { font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: rgba(59,42,25,.06); box-shadow: inset 0 0 0 1px rgba(59,42,25,.15); }
#fud-party-menu .pm-bcond.aff-vu b { color: var(--low); } #fud-party-menu .pm-bcond.aff-rs b { color: var(--mp); }
#fud-party-menu .pm-bcond.aff-im b { color: #4b3517; } #fud-party-menu .pm-bcond.aff-ab b { color: #2e7d32; }
#fud-party-menu .pm-bact { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; padding: 6px 4px; border-bottom: 1px dotted rgba(92,66,30,.25); }
#fud-party-menu .pm-bact.pm-hit { cursor: pointer; }
#fud-party-menu .pm-bact.pm-hit:hover { background: rgba(255,255,255,.3); }
#fud-party-menu .pm-bacticon { width: 34px; height: 34px; border-radius: 6px; border: 1px solid var(--edge); display: flex; align-items: center; justify-content: center; }
#fud-party-menu .pm-bact.is-unknown { opacity: .6; }
#fud-party-menu .pm-bact.is-unknown .pm-bacticon { background: rgba(59,42,25,.1); color: var(--ink-soft); }
#fud-party-menu .pm-bactname { font-weight: 700; font-size: 15px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
#fud-party-menu .pm-bkind { font-size: 11px; font-weight: 700; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .05em; }
#fud-party-menu .pm-bkind i { margin-right: 3px; }
#fud-party-menu .pm-bmeta { font-size: 12px; color: var(--mp); font-weight: 700; }
#fud-party-menu .pm-bact .pm-desc { border-top: 0; padding-top: 2px; font-size: 13px; }
#fud-party-menu .pm-desc.is-clamped { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
`;
