// Party Menu — Equip and Status views.
//
// Equip: the five worn slots on the left; Enter on a slot lists what the
// character carries for it on the right, unwearable entries dimmed with
// canEquip's own reason. While a candidate is under the hand, the left window
// compares the character's stats before → after (party-menu-gear-preview.js),
// and every candidate row carries an FF-style ▲ / ▼ for its overall effect.
// Commits go through setEquipSlot → applyEquipmentSwap.
// Only gear the character CARRIES is offered: something in the Party Bag is
// moved over from the Item view first.
//
// Status: read-only — attributes, defenses, affinities, classes, bonds and the
// effects currently applied, split Temporary / Permanent / Inactive, with a
// detail card per effect (lifetime, per-source amounts, description; data in
// party-menu-effects.js).

import {
  equipSlotsOf, equipCandidates, equipRefusal, setEquipSlot, itemSummary, statusOf,
} from "./party-menu-inventory.js";
import { esc, plain, safeHtml, play, SND, img, STAT } from "./party-menu-ui.js";
import { effectRowsOf } from "./party-menu-effects.js";
import { previewEquip, peekPreview } from "./party-menu-gear-preview.js";
import { vitalsOf } from "./party-menu-core.js";

const EQUIP_REASONS = {
  "not-granted": "The GM hasn't opened the Equip menu to players.",
  "no-actor": "That character is gone.",
  "cannot-equip": "That can't be worn there.",
  "not-owner": "Only this character's player or the GM can change their gear.",
  "in-combat": "Gear is changed with the Equipment action during a conflict.",
  "not-a-candidate": "That isn't carried by this character.",
  "no-such-slot": "No such slot.",
};

export function who(ctx, actor, title) {
  const v = vitalsOf(actor);
  return `
    <div class="pm-ability-top">
      <div class="pm-win pm-title"><span class="pm-pill">${esc(title)}</span></div>
      <div class="pm-win pm-who">
        <span class="pm-arrow pm-hit" data-action="prev-char" title="Previous (Q)">◀</span>
        <div class="pm-portrait sm">${img(actor.img)}</div>
        <div class="pm-who-body">
          <div class="pm-member-top"><span class="pm-name">${esc(actor.name)}</span><span class="pm-lv"><em>LV</em>${v.level}</span></div>
          <div class="pm-stat">${STAT.hp}<b>${v.hp}</b><span>/</span><b>${v.maxHp}</b>
                               ${STAT.mp}<b>${v.mp}</b><span>/</span><b>${v.maxMp}</b></div>
        </div>
        <span class="pm-arrow pm-hit" data-action="next-char" title="Next (E)">▶</span>
      </div>
    </div>`;
}

function itemDetail(item, extra = "") {
  if (!item) return `<div class="pm-empty">Nothing worn here.</div>`;
  const s = itemSummary(item);
  return `
    <div class="pm-detail-head">${img(s.img)}<div><div class="pm-detail-name">${esc(s.name)}</div></div></div>
    ${extra}
    <dl class="pm-facts">${s.facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join("")}</dl>
    <div class="pm-desc">${safeHtml(s.description) || "<p><em>No description.</em></p>"}
    ${s.setDescription ? `<div class="pm-label">Set bonus</div>${safeHtml(s.setDescription)}` : ""}</div>`;
}

function defenseLine(actor) {
  const st = statusOf(actor);
  const n = (x) => (Number.isFinite(x) ? x : "—");
  return `<div class="pm-defline"><span><em>DEF</em><b>${n(st.def)}</b></span><span><em>M.DEF</em><b>${n(st.mdef)}</b></span>`
    + `<span><em>INIT</em><b>${st.init >= 0 ? "+" : ""}${st.init}</b></span></div>`;
}

// ── Equip ─────────────────────────────────────────────────────────────────────

const NET = {
  up: ["▲", "Better overall"], down: ["▼", "Worse overall"], mixed: ["▲▼", "Better in some ways, worse in others"],
};
function netMark(pv) {
  const m = pv?.ok ? NET[pv.net] : null;
  return m ? `<span class="pm-net is-${pv.net}" title="${esc(m[1])}">${m[0]}</span>` : "";
}

function cmpRow(r) {
  const dir = r.better ? "is-up" : r.worse ? "is-down" : "";
  const arrow = r.better ? "▲" : r.worse ? "▼" : "";
  return `<div class="pm-cmprow ${dir} ${r.changed ? "" : "is-same"}"><em>${esc(r.label)}</em><b>${esc(r.before)}</b>`
    + `<i class="fas fa-arrow-right"></i><b class="pm-cmpafter">${esc(r.after)}</b><span class="pm-cmparrow">${arrow}</span></div>`;
}

// Previews are computed OFF the render path: building the copy of a character
// takes a few hundred ms, so the list renders at once and fills in. The row under
// the hand goes first (shortly after the hand stops, so scrolling through a list
// does not build a copy per row), then the ▲ / ▼ of the other rows, one at a time
// while the hand rests. Anything that moves the hand re-arms the timer.
let _previewTimer = null;
function schedulePreviews(ctx, actor, slot, cands, under) {
  clearTimeout(_previewTimer);
  const ids = [
    ...(under ? [under.item.id] : slot.item ? [null] : []),
    ...cands.filter((c) => c.check.ok && c.item.id !== slot.item?.id).map((c) => c.item.id),
    ...(slot.item ? [null] : []),
  ];
  const next = ids.find((id) => !peekPreview(actor, slot.key, id));
  if (next === undefined) return;
  const first = next === ids[0];
  _previewTimer = setTimeout(() => {
    _previewTimer = null;
    const v = ctx.S.v;
    if (!ctx.isOpen() || ctx.S.view !== "equip" || v?.focus !== "cands" || ctx.actor()?.id !== actor.id) return;
    if (ctx.S.busy) { schedulePreviews(ctx, actor, slot, cands, under); return; }   // a write is in flight; try again
    if (equipSlotsOf(actor)[v.idx]?.key !== slot.key) return;
    previewEquip(actor, slot.key, next);
    ctx.render();
  }, first ? 120 : 350);
}

/** The before → after block shown under the slots while a candidate is highlighted. */
function compareBlock(actor, slot, item) {
  const pv = peekPreview(actor, slot.key, item?.id ?? null);
  const what = item ? `Equip ${item.name}` : slot.item ? `Remove ${slot.item.name}` : "No change";
  if (!item && !slot.item) return defenseLine(actor);   // "Remove" on an empty slot changes nothing
  if (!pv) return `<div class="pm-cmp"><div class="pm-label pm-cmphead">${esc(what)}</div><div class="pm-sub pm-cmpwait"><i class="fas fa-spinner fa-spin"></i> Comparing…</div></div>`;
  if (!pv.ok) return `<div class="pm-cmp"><div class="pm-label">${esc(what)}</div><div class="pm-sub">No comparison available.</div></div>`;
  const rows = pv.rows.filter((r, i) => i < 3 || r.changed).map(cmpRow).join("");
  const w = pv.weapon;
  const wl = w ? [["Accuracy", w.before?.accuracy, w.after?.accuracy], ["Damage", w.before?.damage, w.after?.damage]]
    .filter(([, a, b]) => (a || b) && a !== b)
    .map(([k, a, b]) => `<div class="pm-cmpnote"><em>${k}</em>${esc(a || "—")} <i class="fas fa-arrow-right"></i> ${esc(b || "—")}</div>`).join("") : "";
  const notes = [
    ...pv.also.map((t) => `<div class="pm-cmpnote"><i class="fas fa-right-left"></i>${esc(t)}</div>`),
    ...pv.gains.map((n) => `<div class="pm-cmpnote is-up"><i class="fas fa-plus"></i>Skill: ${esc(n)}</div>`),
    ...pv.loses.map((n) => `<div class="pm-cmpnote is-down"><i class="fas fa-minus"></i>Skill: ${esc(n)}</div>`),
    ...pv.setGained.map((n) => `<div class="pm-cmpnote is-up"><i class="fas fa-link"></i>Set bonus: ${esc(n)}</div>`),
    ...pv.setLost.map((n) => `<div class="pm-cmpnote is-down"><i class="fas fa-link-slash"></i>Set bonus lost: ${esc(n)}</div>`),
  ].join("");
  return `<div class="pm-cmp">
      <div class="pm-label pm-cmphead">${esc(what)}</div>
      <div class="pm-cmpbody">${rows}${wl}${notes}</div>
    </div>`;
}

export const equipView = {
  id: "equip",
  title: "Equip",
  usesCharacter: true,

  enter(ctx) { ctx.S.v = { idx: 0, focus: "slots", cand: 0 }; },

  help(ctx) {
    const actor = ctx.actor();
    const v = ctx.S.v;
    const lock = equipRefusal(actor);
    if (lock) return EQUIP_REASONS[lock] ?? lock;
    if (v.focus === "cands") {
      const c = equipCandidates(actor, equipSlotsOf(actor)[v.idx]?.key)[v.cand - 1];
      return c ? (c.check.ok ? plain(itemSummary(c.item).description) || c.item.name : c.check.reason) : "Leave this slot empty.";
    }
    const it = equipSlotsOf(actor)[v.idx]?.item;
    return it ? plain(itemSummary(it).description) || it.name : "Nothing worn here.";
  },

  render(ctx) {
    const actor = ctx.actor();
    if (!actor) return `<div class="pm-win pm-empty">That character is gone.</div>`;
    const v = ctx.S.v;
    const slots = equipSlotsOf(actor);
    v.idx = Math.max(0, Math.min(v.idx, slots.length - 1));
    const lock = equipRefusal(actor);

    const rows = slots.map((s, i) => `
      <div class="pm-eqslot pm-hit ${v.focus === "slots" && v.idx === i ? "is-cursor" : ""} ${v.focus !== "slots" && v.idx === i ? "is-held" : ""}"
           data-action="eq-slot" data-index="${i}">
        <span class="pm-eqlabel"><i class="fas ${s.icon}"></i>${esc(s.label)}</span>
        ${s.item ? img(s.item.img) : `<span class="pm-eqnone"></span>`}
        <span class="pm-eqname ${s.item ? "" : "is-empty"}">${esc(s.item?.name ?? (s.key === "main" || s.key === "off" ? "Unarmed" : "—"))}</span>
      </div>`).join("");

    let right, compare = null;
    if (v.focus === "cands") {
      const slot = slots[v.idx];
      const cands = equipCandidates(actor, slot.key);
      v.cand = Math.max(0, Math.min(v.cand, cands.length));
      const under = v.cand > 0 ? cands[v.cand - 1] : null;
      // Compare what is under the hand; a locked candidate explains itself in its row instead.
      if (!under || under.check.ok) compare = compareBlock(actor, slot, under?.item ?? null);
      schedulePreviews(ctx, actor, slot, cands, under);
      const removeRow = `<div class="pm-pick pm-hit ${v.cand === 0 ? "is-cursor" : ""}" data-action="eq-cand" data-index="0">
        <div class="pm-portrait xs"></div><span>${slot.key === "main" || slot.key === "off" ? "Unarmed" : "Remove"}</span>
        ${slot.item ? netMark(peekPreview(actor, slot.key, null)) : ""}</div>`;
      const candRows = cands.map((c, i) => `
        <div class="pm-pick pm-hit ${v.cand === i + 1 ? "is-cursor" : ""} ${c.check.ok ? "" : "is-locked"}" data-action="eq-cand" data-index="${i + 1}" data-id="${esc(c.item.id)}"
             title="${esc(c.check.reason ?? "")}">
          <div class="pm-portrait xs">${img(c.item.img)}</div>
          <span>${esc(c.item.name)}${c.item.id === slot.item?.id ? ` <i class="pm-badge pm-worn">E</i>` : ""}</span>
          ${c.wornIn ? `<em class="pm-why">${esc(c.wornIn)}</em>` : c.check.reason ? `<em class="pm-why">${esc(c.check.reason)}</em>` : ""}
          ${c.check.ok && c.item.id !== slot.item?.id ? netMark(peekPreview(actor, slot.key, c.item.id)) : ""}
        </div>`).join("");
      right = `<div class="pm-label pm-candhead">${esc(slot.label)} — carried by ${esc(actor.name)}</div>
        <div class="pm-picker-list pm-candlist">${removeRow}${candRows || `<div class="pm-empty">Nothing carried for this slot.</div>`}</div>`;
    } else {
      right = itemDetail(slots[v.idx]?.item);
    }

    return `
      <div class="pm-ability">
        <div class="pm-win pm-help"><span>${esc(this.help(ctx))}</span></div>
        ${who(ctx, actor, "Equip")}
        <div class="pm-ability-body">
          <div class="pm-win pm-skills pm-eqwin">
            <div class="pm-eqlist">${rows}</div>
            ${lock ? `<div class="pm-locked"><i class="fas fa-lock"></i> ${esc(EQUIP_REASONS[lock] ?? lock)}</div>` : ""}
            ${compare ?? defenseLine(actor)}
          </div>
          <div class="pm-win pm-detail"><div class="pm-scroll">${right}</div></div>
        </div>
        <div class="pm-hint">${v.focus === "cands" ? "↑↓ choose (▲ better · ▼ worse) · Enter equip · Esc back" : "↑↓ slot · Enter change · Del remove · Q/E character · Esc back"}</div>
      </div>`;
  },

  openCands(ctx) {
    const actor = ctx.actor();
    const lock = equipRefusal(actor);
    if (lock) { play(SND.buzz, 0.5); ctx.toast(EQUIP_REASONS[lock] ?? lock); return; }
    const slot = equipSlotsOf(actor)[ctx.S.v.idx];
    const cands = equipCandidates(actor, slot.key);
    const at = slot.item ? cands.findIndex((c) => c.item.id === slot.item.id) : -1;
    Object.assign(ctx.S.v, { focus: "cands", cand: at >= 0 ? at + 1 : 0 });
    play(SND.ok);
    ctx.render();
  },

  /** `id` (from the clicked row) wins over the index: the list can re-sort under the pointer. */
  async pick(ctx, i, id = null) {
    const actor = ctx.actor();
    const slot = equipSlotsOf(actor)[ctx.S.v.idx];
    if (!slot) return;
    const cands = equipCandidates(actor, slot.key);
    const c = i > 0 ? (id ? cands.find((x) => x.item.id === id) : cands[i - 1]) : null;
    if (i > 0 && !c) return;
    if (c && !c.check.ok) { play(SND.buzz, 0.5); ctx.toast(c.check.reason); return; }
    await this.commit(ctx, actor, slot, c?.item ?? null);
  },

  async commit(ctx, actor, slot, item) {
    if ((slot.item?.id ?? null) === (item?.id ?? null)) { ctx.S.v.focus = "slots"; play(SND.back); ctx.render(); return; }
    ctx.setBusy(true);
    let res;
    try { res = await setEquipSlot(actor, slot.key, item?.id ?? null); }
    catch (e) { console.error("[PartyMenu] equip failed", e); res = { ok: false, reason: e?.message ?? "error" }; }
    finally { ctx.setBusy(false); }
    if (ctx.S.v) ctx.S.v.focus = "slots";
    if (res?.ok) { play(SND.done, 0.5); ctx.toast(item ? `${actor.name}: ${item.name} → ${slot.label}` : `${actor.name}: ${slot.label} emptied`); }
    else { play(SND.buzz, 0.5); ctx.toast(res?.detail ?? EQUIP_REASONS[res?.reason] ?? `Could not change it (${res?.reason}).`); }
  },

  key(ctx, k) {
    const v = ctx.S.v;
    const actor = ctx.actor();
    if (v.focus === "cands") {
      const n = equipCandidates(actor, equipSlotsOf(actor)[v.idx]?.key).length + 1;
      if (k === "ArrowUp") { v.cand = (v.cand - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "ArrowDown") { v.cand = (v.cand + 1) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "Enter") this.pick(ctx, v.cand);
      else if (k === "Escape") { v.focus = "slots"; play(SND.back); ctx.render(); }
      return;
    }
    if (k === "q" || k === "Q" || k === "PageUp") return ctx.cycleCharacter(-1);
    if (k === "e" || k === "E" || k === "PageDown") return ctx.cycleCharacter(1);
    const n = equipSlotsOf(actor).length;
    if (k === "ArrowUp" && n) { v.idx = (v.idx - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
    else if (k === "ArrowDown" && n) { v.idx = (v.idx + 1) % n; play(SND.move, 0.4); ctx.render(); }
    else if (k === "Enter" || k === "ArrowRight") this.openCands(ctx);
    else if (k === "Delete" || k === "Backspace") {
      const slot = equipSlotsOf(actor)[v.idx];
      if (slot?.item && !equipRefusal(actor)) this.commit(ctx, actor, slot, null);
    } else if (k === "Escape") ctx.back();
  },

  async click(ctx, a, el) {
    const v = ctx.S.v;
    const i = Number(el.dataset.index);
    if (a === "eq-slot") {
      if (v.focus === "slots" && v.idx === i) this.openCands(ctx);
      else { v.idx = i; v.focus = "slots"; play(SND.move, 0.4); ctx.render(); }
    } else if (a === "eq-cand") await this.pick(ctx, i, el.dataset.id || null);
  },

  hover(ctx, a, i) {
    const v = ctx.S.v;
    if (a === "eq-slot" && v.focus === "slots" && v.idx !== i) { v.idx = i; return true; }
    if (a === "eq-cand" && v.focus === "cands" && v.cand !== i) { v.cand = i; return true; }
    return false;
  },
};

// ── Status ────────────────────────────────────────────────────────────────────

const AFF_LABEL = { NA: "—", VU: "VU", RS: "RS", IM: "IM", AB: "AB" };
const ELEMENT_ICON = {
  physical: "fa-hand-fist", air: "fa-wind", bolt: "fa-bolt", dark: "fa-moon", earth: "fa-mountain",
  fire: "fa-fire", ice: "fa-snowflake", light: "fa-sun", poison: "fa-skull-crossbones",
};

const SOURCE_KIND = { gear: "gear", skill: "skill", item: "item", actor: "" };

// One stat chip: an element icon when the stat is element-typed, the stat in
// small muted caps, the change in bold — or an RS/VU/IM/AB badge for affinities.
function statChip(c) {
  const icon = c.el && ELEMENT_ICON[c.el] ? `<i class="fas ${ELEMENT_ICON[c.el]}" title="${esc(c.el)}"></i>` : "";
  const k = c.k ? `<em>${esc(c.k)}</em>` : "";
  const v = c.grade
    ? `<b class="pm-grade aff-${esc(c.grade.toLowerCase())}">${esc(AFF_LABEL[c.grade] ?? c.grade)}</b>`
    : `<b>${esc(c.v)}</b>`;
  return `<span class="pm-stat-chip ${c.bad ? "is-bad" : ""}">${icon}${k}${v}</span>`;
}

// What a row shows beside its name. Temporary: how long it lasts. A tracker: its
// counter. Otherwise: up to two stat chips, then "+N" (the card lists them all).
const MAX_CHIPS = 2;
function rowChips(r) {
  if (r.inactive) return "";
  if (r.temporary) return r.short ? `<span class="pm-effchip is-temp"><i class="fas fa-hourglass-half"></i>${esc(r.short)}</span>` : "";
  if (r.lifetime.counter) return `<span class="pm-effchip is-count">${esc(r.lifetime.counter)}</span>`;
  if (!r.chips.length) return "";
  const more = r.chips.length - MAX_CHIPS;
  const title = [...r.totals.map((t) => t.text), ...r.sources.flatMap((s) => s.amounts.filter((a) => a.active && typeof a.add !== "number").map((a) => a.text))];
  return `<span class="pm-effstats" title="${esc([...new Set(title)].join(" · "))}">${r.chips.slice(0, MAX_CHIPS).map(statChip).join("")}${more > 0 ? `<span class="pm-effmore">+${more}</span>` : ""}</span>`;
}

function lifeLine(life) {
  return life.temporary
    ? `<span class="pm-efflife is-temp"><i class="fas fa-hourglass-half"></i>Temporary · ${esc(life.label)}</span>`
    : `<span class="pm-efflife"><i class="fas fa-infinity"></i>Permanent · ${esc(life.label)}${life.counter ? ` (${esc(life.counter)})` : ""}</span>`;
}

function sourceName(src) {
  if (!src) return "";
  const kind = SOURCE_KIND[src.kind];
  return `${src.name}${kind ? ` (${kind})` : ""}${src.by ? `, cast by ${src.by}` : ""}`;
}

function effectCard(row) {
  // Per-source lifetimes only matter for temporary rows (two Wet with different turns left).
  const mixedLife = row.temporary && new Set(row.sources.map((s) => s.lifetime.label)).size > 1;
  const lines = row.sources.map((s) => {
    const amounts = s.amounts.filter((a) => a.active).map((a) => `<b class="${a.chip?.bad ? "is-bad" : ""}">${esc(a.text)}</b>`).join("");
    const from = s.source ? sourceName(s.source) : row.count > 1 ? "Unknown source" : "";
    if (!from && !amounts) return "";
    return `<li><span>${esc(from || "Effect")}${mixedLife ? `<em> · ${esc(s.lifetime.short || s.lifetime.label)}</em>` : ""}</span><span class="pm-effamts">${amounts}</span></li>`;
  }).filter(Boolean).join("");
  const total = row.count > 1 && row.totals.length
    ? `<li class="is-total"><span>Total</span><span class="pm-effamts">${row.totals.map((t) => `<b class="${t.chip?.bad ? "is-bad" : ""}">${esc(t.text)}</b>`).join("")}</span></li>` : "";
  const only = row.count === 1 ? row.sources[0].source : null;
  const desc = row.description
    ? safeHtml(row.description)
    : only?.description ? `<p class="pm-from">From ${esc(only.name)}:</p>${safeHtml(only.description)}` : "";
  return `
    <div class="pm-effcard-head">${img(row.img)}<div>
      <div class="pm-effcard-name">${esc(row.name)}${row.count > 1 ? ` <span class="pm-qty">×${row.count}</span>` : ""}</div>
      ${row.inactive ? `<span class="pm-efflife is-off"><i class="fas fa-power-off"></i>Inactive: it currently changes nothing</span>` : lifeLine(row.lifetime)}
    </div></div>
    ${lines || total ? `<ul class="pm-effsrc">${lines}${total}</ul>` : ""}
    ${desc ? `<div class="pm-desc">${desc}</div>` : lines ? "" : `<div class="pm-desc"><p><em>No description.</em></p></div>`}`;
}

export const statusView = {
  id: "status",
  title: "Status",
  usesCharacter: true,

  enter(ctx) { ctx.S.v = { eff: 0 }; },

  help(ctx) {
    const st = statusOf(ctx.actor());
    const row = effectRowsOf(ctx.actor())[ctx.S.v.eff];
    if (!row) return [st.identity, st.theme, st.origin].filter(Boolean).join(" · ") || "No effects.";
    const life = row.inactive ? "Inactive" : `${row.temporary ? "Temporary" : "Permanent"}: ${row.lifetime.label}`;
    const from = row.count > 1 ? `${row.count} sources` : row.sources[0]?.source ? `from ${sourceName(row.sources[0].source)}` : "";
    return [row.name, life, from].filter(Boolean).join(" — ");
  },

  render(ctx) {
    const actor = ctx.actor();
    if (!actor) return `<div class="pm-win pm-empty">That character is gone.</div>`;
    const st = statusOf(actor);
    const rows = effectRowsOf(actor);
    const v = ctx.S.v;
    v.eff = Math.max(0, Math.min(v.eff, Math.max(0, rows.length - 1)));
    const attrs = Object.entries(st.attrs).map(([k, a]) => `
      <div class="pm-attr"><em>${k}</em><b>d${a.cur}</b>${a.cur !== a.base ? `<span class="pm-sub">base d${a.base}</span>` : ""}</div>`).join("");
    const aff = st.affinities.map((x) => `
      <div class="pm-aff aff-${esc(x.v.toLowerCase())}" title="${esc(x.el)}"><i class="fas ${ELEMENT_ICON[x.el]}"></i><b>${esc(AFF_LABEL[x.v] ?? x.v)}</b></div>`).join("");
    const facts = [["Identity", st.identity], ["Theme", st.theme], ["Origin", st.origin],
      ["Classes", st.classes.map((c) => `${c.name} ${c.level}`).join(", ")], ["Bonds", st.bonds.join(", ")],
      ["Zenit", `${st.zenit.toLocaleString()} z`]].filter(([, x]) => x);
    const group = (r) => (r.inactive ? "off" : r.temporary ? "temp" : "perm");
    const HEAD = {
      temp: ["fa-hourglass-half", "Temporary"], perm: ["fa-infinity", "Permanent"], off: ["fa-power-off", "Inactive"],
    };
    const counts = {};
    for (const r of rows) counts[group(r)] = (counts[group(r)] ?? 0) + 1;
    let last = null;
    const list = rows.map((r, i) => {
      const g = group(r);
      const head = g !== last ? `<div class="pm-section"><i class="fas ${HEAD[g][0]}"></i>${HEAD[g][1]} <b>${counts[g]}</b></div>` : "";
      last = g;
      return `${head}
      <div class="pm-skill pm-hit pm-eff ${r.temporary ? "is-temp" : ""} ${r.inactive ? "is-locked" : ""} ${v.eff === i ? "is-cursor" : ""}" data-action="st-eff" data-index="${i}">
        ${img(r.img)}<span class="pm-skill-name">${esc(r.name)}${r.count > 1 ? ` <span class="pm-qty">×${r.count}</span>` : ""}</span>
        ${rowChips(r)}</div>`;
    }).join("") || `<div class="pm-empty">No active effects.</div>`;
    const sel = rows[v.eff];
    return `
      <div class="pm-ability">
        <div class="pm-win pm-help"><span>${esc(this.help(ctx))}</span></div>
        ${who(ctx, actor, "Status")}
        <div class="pm-ability-body pm-status-body">
          <div class="pm-win pm-detail"><div class="pm-scroll">
            <div class="pm-label">Attributes</div><div class="pm-attrs">${attrs}</div>
            ${defenseLine(actor)}
            <div class="pm-label">Affinities</div><div class="pm-affs">${aff}</div>
            <dl class="pm-facts pm-stfacts">${facts.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join("")}</dl>
          </div></div>
          <div class="pm-win pm-skills pm-effpanel">
            <div class="pm-label">Active effects</div>
            <div class="pm-skill-list pm-onecol pm-efflist">${list}</div>
            ${sel ? `<div class="pm-effcard" data-keep-scroll="eff|${esc(actor.id)}|${esc(sel.key)}">${effectCard(sel)}</div>` : ""}
          </div>
        </div>
        <div class="pm-hint">↑↓ effect · Q/E character · Esc back</div>
      </div>`;
  },

  key(ctx, k) {
    const v = ctx.S.v;
    if (k === "q" || k === "Q" || k === "PageUp" || k === "ArrowLeft") return ctx.cycleCharacter(-1);
    if (k === "e" || k === "E" || k === "PageDown" || k === "ArrowRight") return ctx.cycleCharacter(1);
    const n = effectRowsOf(ctx.actor()).length;
    if (k === "ArrowUp" && n) { v.eff = (v.eff - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
    else if (k === "ArrowDown" && n) { v.eff = (v.eff + 1) % n; play(SND.move, 0.4); ctx.render(); }
    else if (k === "Escape") ctx.back();
  },

  async click(ctx, a, el) {
    if (a === "st-eff") { ctx.S.v.eff = Number(el.dataset.index); play(SND.move, 0.4); ctx.render(); }
  },

  hover(ctx, a, i) {
    if (a === "st-eff" && ctx.S.v.eff !== i) { ctx.S.v.eff = i; return true; }
    return false;
  },
};
