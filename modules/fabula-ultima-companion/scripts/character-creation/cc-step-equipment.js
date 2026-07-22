/**
 * Character Creation — step 4: Starting Equipment.
 *
 * The character buys gear against a zenit budget derived from the starting
 * level (`budgetForLevel`). Only the world's "Basic Weapon" / "Basic Armor" /
 * "Basic Shield" folders are offered, which is what the rulebook's starting
 * equipment tables cover.
 *
 * Presented as the shop is presented — vertical category tabs, icon rows with
 * name and description, a zenit figure at the top, a green pill to buy —
 * because it is a shop, and the one the players already know. The differences
 * are that the purse is a creation budget rather than the character's money,
 * and that there is no vendor to socket a purchase through: the picks are
 * collected here and granted at finalize.
 *
 * FOLDER RESOLUTION
 * -----------------
 * Depth is NOT fixed in this world — weapons sit at
 * `⚔️ Equipments / Weapon / Basic Weapon / <Category>` while armour sits at
 * `⚔️ Equipments / Armor / Basic Armor`. Matching therefore walks the folder
 * ancestry looking for the `Basic *` name rather than assuming a level, so
 * adding or removing an intermediate folder cannot silently empty the picker.
 *
 * MARTIAL GEAR IS NOT BLOCKED
 * ---------------------------
 * A class grants martial melee / ranged / armour / shield rights. Buying gear
 * you lack the training for is allowed — you own it, you simply cannot equip
 * it — so the picker flags it instead of refusing. That keeps the step honest
 * when the player goes back and changes class, which would otherwise
 * retroactively invalidate a purchase. Finalize equips only what is legal.
 */

import { CC, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import { draftBudget, draftSpend, draftBudgetLeft, draftMartial } from "./cc-draft.js";
import { resolveClass } from "../levelup-system/class-registry.js";

/** The shop's own zenit mark, so the two windows count money the same way. */
const GP_ICON =
  `<img class="cc-eq-zicon" src="https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png" alt="z">`;

/** Tabs, in the shop's order and with the shop's emoji. */
const TABS = Object.freeze([
  { key: "weapon", emoji: "⚔️", label: "Weapon" },
  { key: "armor", emoji: "🥋", label: "Armor" },
  { key: "shield", emoji: "🛡️", label: "Shield" },
]);

// ── catalogue ──────────────────────────────────────────────────────────────

/** Walk a folder's ancestry; return the matching `Basic *` slot, or null. */
function slotOf(folder) {
  const want = CC.EQUIP_FOLDERS;                       // { weapon, armor, shield }
  let f = folder, guard = 0;
  while (f && guard++ < 12) {
    for (const [slot, name] of Object.entries(want)) if (f.name === name) return slot;
    f = f.folder ?? null;
  }
  return null;
}

/** Normalise a CSB equipment item into what the picker needs. */
export function readEquip(item, slot) {
  const p = item.system?.props ?? {};
  return {
    uuid: item.uuid,
    id: item.id,
    name: item.name,
    img: item.img,
    slot,                                              // weapon | armor | shield
    cost: num(p.item_cost, 0),                         // stored as a STRING in CSB
    isMartial: p.isMartial === true,
    itemType: p.item_type ?? slot,
    handSlots: p.hand_slots ?? "",
    range: p.weapon_range ?? "",                       // Melee | Ranged — weapons only
    // Armour and shields all carry category "Arcane", which is an unset
    // default rather than a fact. Only weapons are grouped by it.
    category: slot === "weapon" ? (p.category ?? "Uncategorised") : "",
    description: p.description ?? "",
  };
}

let _catalog = null;
/** All basic equipment, grouped by slot. Cached for the window's lifetime. */
export function catalog() {
  if (_catalog) return _catalog;
  const out = { weapon: [], armor: [], shield: [] };
  try {
    for (const item of game.items ?? []) {
      const slot = slotOf(item.folder);
      if (slot) out[slot].push(readEquip(item, slot));
    }
  } catch (e) {
    console.error("[ONI][CharCreate] equipment catalogue failed:", e);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (a.category || "").localeCompare(b.category || "") ||
                          a.cost - b.cost || a.name.localeCompare(b.name));
  }
  _catalog = out;
  return out;
}
export const resetCatalog = () => { _catalog = null; };

// ── pure model (exported for tests) ────────────────────────────────────────

export const picks = (d) => d?.equipment?.picks ?? [];
export const countIn = (d, slot) => picks(d).filter((p) => p.slot === slot).length;
export const hasPick = (d, uuid) => picks(d).some((p) => p.uuid === uuid);

/** One body, one suit of armour, one shield. Weapons may stack. */
export const SLOT_LIMIT = Object.freeze({ weapon: Infinity, armor: 1, shield: 1 });

/**
 * May this item be added?
 * Budget is deliberately NOT a blocker — going over is shown as an issue so the
 * player can rearrange, rather than having the picker go dead with no reason.
 */
export function canAdd(d, rec) {
  if (hasPick(d, rec.uuid)) return { ok: false, reason: "Already chosen." };
  const limit = SLOT_LIMIT[rec.slot] ?? Infinity;
  if (countIn(d, rec.slot) >= limit) {
    return { ok: false, reason: `Only ${limit} ${rec.slot} may be carried at creation.` };
  }
  return { ok: true };
}

export function addPick(d, rec) {
  d.equipment.picks.push({
    uuid: rec.uuid, id: rec.id, name: rec.name, img: rec.img,
    slot: rec.slot, cost: rec.cost, isMartial: rec.isMartial,
    itemType: rec.itemType, handSlots: rec.handSlots,
    range: rec.range, category: rec.category,
  });
}

export function removePick(d, uuid) {
  const i = picks(d).findIndex((p) => p.uuid === uuid);
  if (i < 0) return false;
  d.equipment.picks.splice(i, 1);
  return true;
}

/**
 * Which martial right does this item need?
 * Weapons split on range; armour and shields have their own flags.
 */
export function martialNeed(rec) {
  if (!rec.isMartial) return null;
  if (rec.slot === "armor") return "armor";
  if (rec.slot === "shield") return "shield";
  return String(rec.range).toLowerCase() === "ranged" ? "ranged" : "melee";
}

const NEED_LABEL = {
  melee: "martial melee weapons", ranged: "martial ranged weapons",
  armor: "martial armor", shield: "martial shields",
};

/**
 * Advisories about the current picks. Not validation — these do not block
 * finalize; they explain what will and will not be equipped.
 */
export function advisories(d, martial) {
  const out = [];
  for (const p of picks(d)) {
    const need = martialNeed(p);
    if (need && !martial[need]) {
      out.push(`${p.name} needs ${NEED_LABEL[need]} — it will be carried, not equipped.`);
    }
  }
  if (!countIn(d, "weapon")) out.push("No weapon chosen — the character will fight unarmed.");
  if (!countIn(d, "armor")) out.push("No armor chosen — defense will use the DEX die alone.");
  const twoH = picks(d).filter((p) => p.slot === "weapon" && /two/i.test(p.handSlots));
  if (twoH.length && countIn(d, "shield")) {
    out.push(`${twoH[0].name} is two-handed — it cannot be used together with a shield.`);
  }
  return out;
}

// ── view state ─────────────────────────────────────────────────────────────

let _tab = "weapon";
let _filter = "";
export const resetUiState = () => { _tab = "weapon"; _filter = ""; resetCatalog(); };

const CSS = `
  .cc-eq { display: flex; flex-direction: column; min-height: 0; margin: 0 -16px -14px; }
  .cc-eq-zicon { width: 17px; height: 17px; object-fit: contain; vertical-align: middle;
    border: none !important; box-shadow: none !important; background: transparent; }

  /* ── purse bar ── */
  .cc-eq-bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px;
    background: linear-gradient(to bottom, #e8d5a3, #dfc890);
    border-top: 1px solid #b89940; border-bottom: 2px solid #b89940; flex-shrink: 0; }
  .cc-eq-purse { display: flex; align-items: baseline; gap: 4px; font-weight: 800;
    font-size: 16px; color: #5a3800; font-variant-numeric: tabular-nums; }
  .cc-eq-purse.is-over { color: #a3453a; }
  .cc-eq-purse .k { font-size: 11px; font-weight: 700; opacity: .75; }
  .cc-eq-track { flex: 1 1 auto; height: 8px; border-radius: 5px; overflow: hidden;
    background: rgba(90,56,0,.15); border: 1px solid #b89940; }
  .cc-eq-fill { height: 100%; background: linear-gradient(90deg,#c8a84b,#8b6914); }
  .cc-eq-fill.is-over { background: linear-gradient(90deg,#c9736a,#a3453a); }
  .cc-eq-spent { font-size: 11.5px; font-weight: 700; color: #5a3800; white-space: nowrap; }

  /* ── body: vertical tabs + list + cart ── */
  .cc-eq-body { display: flex; flex: 1 1 auto; min-height: 0; }
  .cc-eq-tabs { display: flex; flex-direction: column; gap: 2px; padding: 8px 4px;
    background: #e0c87a; border-right: 2px solid #b89940; flex-shrink: 0; }
  .cc-eq-tab { width: 36px; height: 36px; border-radius: 8px; display: flex;
    align-items: center; justify-content: center; font-size: 18px; cursor: pointer;
    border: 1px solid transparent; background: transparent; position: relative; flex-shrink: 0; }
  .cc-eq-tab:hover { background: rgba(139,105,20,.18); border-color: rgba(139,105,20,.35); }
  .cc-eq-tab.active { background: #c8a84b; border-color: #8b6914;
    box-shadow: inset 0 1px 2px rgba(0,0,0,.25); }
  .cc-eq-tab::after { content: attr(data-tooltip); position: absolute; left: calc(100% + 6px);
    top: 50%; transform: translateY(-50%); background: rgba(30,20,10,.92); color: #ffeebb;
    font-size: 11px; font-weight: 700; white-space: nowrap; padding: 3px 8px; border-radius: 6px;
    pointer-events: none; opacity: 0; transition: opacity .15s; z-index: 9999; }
  .cc-eq-tab:hover::after { opacity: 1; }
  .cc-eq-count { position: absolute; top: -2px; right: -2px; min-width: 15px; height: 15px;
    border-radius: 8px; background: #3f7a30; color: #fff; font-size: 10px; font-weight: 800;
    display: grid; place-items: center; border: 1px solid #2f6b2f; padding: 0 3px; }

  .cc-eq-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  .cc-eq-search { margin: 7px 8px 0; }
  .cc-eq-list { overflow-y: auto; padding: 6px 8px; display: flex; flex-direction: column;
    gap: 4px; flex: 1 1 auto; }
  .cc-eq-list::-webkit-scrollbar { width: 5px; }
  .cc-eq-list::-webkit-scrollbar-track { background: rgba(0,0,0,.06); }
  .cc-eq-list::-webkit-scrollbar-thumb { background: #b89940; border-radius: 3px; }
  .cc-eq-grp { font-size: 10.5px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase;
    color: #8b6914; padding: 5px 2px 1px; }

  .cc-eq-row { display: grid; grid-template-columns: 36px 1fr auto auto; align-items: center;
    gap: 8px; padding: 6px 8px; border-radius: 8px;
    background: rgba(255,255,255,.55); border: 1px solid rgba(184,153,64,.35); }
  .cc-eq-row:hover { background: rgba(255,255,255,.80); }
  .cc-eq-row.is-owned { background: rgba(200,168,75,.28); border-color: #b89940; }
  .cc-eq-iconwrap { width: 34px; height: 34px; border-radius: 6px; border: 1px solid rgba(184,153,64,.5);
    background: #e8d5a3; flex-shrink: 0; overflow: hidden; display: flex;
    align-items: center; justify-content: center; }
  .cc-eq-iconwrap img { width: 100%; height: 100%; object-fit: contain; display: block;
    border: 0 !important; outline: 0 !important; }
  .cc-eq-inner { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .cc-eq-name { font-size: 13px; font-weight: 700; color: #3a2408; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .cc-eq-meta { font-size: 11px; color: #6b4c2a; opacity: .85; line-height: 1.35;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cc-eq-cost { font-size: 12px; font-weight: 700; color: #8b4513; white-space: nowrap;
    text-align: right; min-width: 62px; display: flex; align-items: center;
    justify-content: flex-end; gap: 3px; }
  .cc-eq-cost.free { color: #3a7a3a; }
  .cc-eq-buy { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700;
    cursor: pointer; white-space: nowrap; min-width: 58px; font-family: inherit;
    border: 1px solid #5a8a5a; background: #7ab87a; color: #fff;
    text-shadow: 0 1px 0 rgba(0,0,0,.25); }
  .cc-eq-buy:hover:not(:disabled) { background: #5a9a5a; }
  .cc-eq-buy:active:not(:disabled) { transform: scale(.96); }
  .cc-eq-buy:disabled { opacity: .38; cursor: default; background: #c8b89a;
    border-color: #a89870; color: #6b4c2a; text-shadow: none; }
  .cc-eq-buy.drop { background: #c9736a; border-color: #a3453a; }
  .cc-eq-buy.drop:hover { background: #b3574d; }
  .cc-eq-untrained { font-size: 10px; font-weight: 700; color: #8c3a24;
    background: rgba(165,42,26,.12); border: 1px solid rgba(165,42,26,.3);
    border-radius: 9px; padding: 0 6px; }

  /* ── cart ── */
  .cc-eq-cart { flex: 0 0 auto; width: 216px; padding: 8px 10px; background: #e6dabd;
    border-left: 1px solid #b79c72; display: flex; flex-direction: column; gap: 6px;
    overflow-y: auto; }
  .cc-eq-h { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    opacity: .65; }
  .cc-eq-cartrow { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #3b2a17;
    padding: 4px 7px; border-radius: 7px; background: #f7f0df; border: 1px solid #cbb890; }
  .cc-eq-cartrow img { width: 18px; height: 18px; border-radius: 4px; object-fit: contain;
    border: 0 !important; }
  .cc-eq-cartrow span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cc-eq-x { margin-left: auto; font-family: inherit; cursor: pointer; font-size: 13px;
    line-height: 1; color: #8a6c45; background: none; border: none; padding: 0 2px; }
  .cc-eq-x:hover { color: #a3453a; }
  .cc-eq-note { font-size: 11px; line-height: 1.4; color: #6b4a1c; padding-left: 12px;
    position: relative; }
  .cc-eq-note::before { content: "!"; position: absolute; left: 2px; font-weight: 800; color: #b8862a; }
  .cc-eq-none { font-size: 12px; opacity: .6; font-style: italic; }
`;

const metaOf = (rec) => {
  const bits = [];
  if (rec.slot === "weapon") {
    if (rec.range) bits.push(rec.range);
    if (rec.handSlots) bits.push(rec.handSlots);
    if (rec.category) bits.push(rec.category);
  }
  if (rec.isMartial) bits.push("Martial");
  return bits.join(" · ");
};

function listHTML(d, martial) {
  const all = catalog()[_tab] ?? [];
  const list = _filter
    ? all.filter((r) => r.name.toLowerCase().includes(_filter.toLowerCase()))
    : all;

  if (!list.length) {
    return `<div class="cc-eq-none" style="padding:20px;text-align:center">${
      all.length ? "Nothing matches that search."
                 : `No items found in "${esc(CC.EQUIP_FOLDERS[_tab])}".`}</div>`;
  }

  let html = "", group = null;
  for (const rec of list) {
    if (_tab === "weapon" && rec.category !== group) {
      group = rec.category;
      html += `<div class="cc-eq-grp">${esc(group)}</div>`;
    }
    const owned = hasPick(d, rec.uuid);
    const gate = canAdd(d, rec);
    const need = martialNeed(rec);
    const untrained = need && !martial[need];

    html += `
      <div class="cc-eq-row ${owned ? "is-owned" : ""}">
        <div class="cc-eq-iconwrap"><img src="${esc(rec.img || CC.DEFAULT_IMG)}" alt=""></div>
        <div class="cc-eq-inner">
          <div class="cc-eq-name">${esc(rec.name)}${
            untrained ? ` <span class="cc-eq-untrained" title="No training — carried, not equipped">untrained</span>` : ""}</div>
          <div class="cc-eq-meta">${esc(metaOf(rec))}</div>
        </div>
        <div class="cc-eq-cost ${rec.cost ? "" : "free"}">${
          rec.cost ? `${GP_ICON}${rec.cost}` : "free"}</div>
        ${owned
          ? `<button class="cc-eq-buy drop" data-drop="${esc(rec.uuid)}">Return</button>`
          : `<button class="cc-eq-buy" data-take="${esc(rec.uuid)}" ${gate.ok ? "" : "disabled"}
                     title="${esc(gate.ok ? "Buy" : gate.reason)}">Buy</button>`}
      </div>`;
  }
  return html;
}

function cartHTML(d, martial) {
  const list = picks(d);
  const notes = advisories(d, martial);
  return `
    <div class="cc-eq-h">Chosen (${list.length})</div>
    ${list.length
      ? list.map((p) => `
          <div class="cc-eq-cartrow">
            <img src="${esc(p.img || CC.DEFAULT_IMG)}" alt="">
            <span>${esc(p.name)}</span>
            <button class="cc-eq-x" data-drop="${esc(p.uuid)}" title="Return">×</button>
          </div>`).join("")
      : `<div class="cc-eq-none">Nothing bought yet.</div>`}
    ${notes.length
      ? `<div class="cc-eq-h" style="margin-top:4px">Notes</div>
         ${notes.map((n) => `<div class="cc-eq-note">${esc(n)}</div>`).join("")}`
      : ""}`;
}

function render(d) {
  const martial = draftMartial(d, resolveClass);
  const budget = draftBudget(d);
  const spent = draftSpend(d);
  const left = draftBudgetLeft(d);
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const over = left < 0;

  return `
    <style>${CSS}</style>
    <div class="cc-eq">
      <div class="cc-eq-bar">
        <span class="cc-eq-purse ${over ? "is-over" : ""}">${GP_ICON}${left}<span class="k">left</span></span>
        <div class="cc-eq-track"><div class="cc-eq-fill ${over ? "is-over" : ""}" style="width:${pct}%"></div></div>
        <span class="cc-eq-spent">${spent} of ${budget} spent</span>
      </div>

      <div class="cc-eq-body">
        <div class="cc-eq-tabs">
          ${TABS.map((t) => {
            const n = countIn(d, t.key);
            return `<button class="cc-eq-tab ${_tab === t.key ? "active" : ""}"
                      data-tab="${t.key}" data-tooltip="${esc(t.label)}">${t.emoji}${
                      n ? `<span class="cc-eq-count">${n}</span>` : ""}</button>`;
          }).join("")}
        </div>

        <div class="cc-eq-main">
          <input class="cc-search cc-eq-search" data-search placeholder="Search…" value="${esc(_filter)}">
          <div class="cc-eq-list">${listHTML(d, martial)}</div>
        </div>

        <div class="cc-eq-cart">${cartHTML(d, martial)}</div>
      </div>
    </div>`;
}

function bind(root, d, ctx) {
  root.querySelectorAll("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => { _tab = b.dataset.tab; ctx.refresh(); });
  });

  const search = root.querySelector("[data-search]");
  search?.addEventListener("input", () => {
    _filter = search.value;
    // Redraw the list alone so the search box keeps focus and the caret.
    const list = root.querySelector(".cc-eq-list");
    if (list) {
      list.innerHTML = listHTML(d, draftMartial(d, resolveClass));
      bindRows(root, d, ctx);
    }
  });

  bindRows(root, d, ctx);
}

function bindRows(root, d, ctx) {
  root.querySelectorAll("[data-take]").forEach((b) => {
    b.addEventListener("click", () => {
      const rec = (catalog()[_tab] ?? []).find((r) => r.uuid === b.dataset.take);
      if (!rec) return;
      const gate = canAdd(d, rec);
      if (!gate.ok) { ui.notifications?.warn(gate.reason); return; }
      ctx.edit((dd) => addPick(dd, rec));
    });
  });
  root.querySelectorAll("[data-drop]").forEach((b) => {
    b.addEventListener("click", () => ctx.edit((dd) => removePick(dd, b.dataset.drop)));
  });
}

STEP_RENDERERS.set("equipment", { render, bind, reset: resetUiState });
