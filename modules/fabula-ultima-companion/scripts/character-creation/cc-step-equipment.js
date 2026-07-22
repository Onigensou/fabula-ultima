/**
 * Character Creation — step 4: Starting Equipment.
 *
 * The character buys gear against a zenit budget derived from the starting
 * level (`budgetForLevel`). Only the world's "Basic Weapon" / "Basic Armor" /
 * "Basic Shield" folders are offered, which is what the rulebook's starting
 * equipment tables cover.
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
 *
 * WHAT THIS STEP DOES NOT DO
 * --------------------------
 * It collects picks and costs. Deciding main hand / off hand / armour slot and
 * writing `isEquipped` is finalize's job, since that needs the real Actor.
 */

import { CC, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import { draftBudget, draftSpend, draftBudgetLeft, draftMartial } from "./cc-draft.js";
import { resolveClass } from "../levelup-system/class-registry.js";

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

const TABS = [["weapon", "Weapons"], ["armor", "Armor"], ["shield", "Shields"]];

const CSS = `
  .cc-eq-bar {
    display: flex; align-items: center; gap: 16px; padding: 10px 14px; margin-bottom: 12px;
    border-radius: 3px; border: 1px solid rgba(140,90,30,0.35); background: rgba(201,164,74,0.16);
  }
  .cc-eq-fig { display: flex; align-items: baseline; gap: 6px; }
  .cc-eq-n { font-size: 19px; color: #3a1e06; }
  .cc-eq-n.is-over { color: #a52a1a; }
  .cc-eq-k { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #8a6432; }
  .cc-eq-track { flex: 1; height: 7px; border-radius: 4px; overflow: hidden;
    background: rgba(90,60,20,0.18); border: 1px solid rgba(140,90,30,0.3); }
  .cc-eq-fill { height: 100%; background: linear-gradient(90deg, #c9a44a, #a07818); }
  .cc-eq-fill.is-over { background: linear-gradient(90deg, #c2503a, #8f2a1a); }

  .cc-eq-wrap { display: grid; grid-template-columns: 1fr 240px; gap: 18px; min-height: 0; }
  .cc-eq-tabs { display: flex; gap: 5px; margin-bottom: 9px; }
  .cc-eq-tab {
    font-family: inherit; font-size: 10px; letter-spacing: 1px; padding: 5px 14px;
    border-radius: 2px; cursor: pointer; color: #5c3a12;
    background: rgba(255,252,240,0.7); border: 1px solid rgba(140,90,30,0.35);
  }
  .cc-eq-tab.is-on { background: #c9a22a; border-color: #a07818; color: #fff; }
  .cc-eq-list { display: flex; flex-direction: column; gap: 4px; max-height: 390px; overflow-y: auto; }
  .cc-eq-grp { font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: #8a6432; margin: 9px 0 2px; }
  .cc-eq-grp:first-child { margin-top: 0; }
  .cc-eq-row {
    display: grid; grid-template-columns: 26px 1fr auto auto; gap: 9px; align-items: center;
    padding: 6px 10px; border-radius: 3px;
    border: 1px solid rgba(140,90,30,0.24); background: rgba(255,252,240,0.5);
  }
  .cc-eq-row.is-picked { border-color: #c9a44a; background: rgba(201,164,74,0.22); }
  .cc-eq-row img { width: 26px; height: 26px; border-radius: 2px; object-fit: cover; }
  .cc-eq-nm { font-size: 11px; color: #3a1e06; }
  .cc-eq-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
  .cc-eq-cost { font-size: 11px; color: #7a5428; white-space: nowrap; }
  .cc-eq-cost.is-free { color: #9b7040; font-style: italic; }
  .cc-eq-btn {
    font-family: inherit; width: 24px; height: 24px; line-height: 1; font-size: 14px;
    border-radius: 2px; cursor: pointer; color: #3a1e06;
    background: linear-gradient(155deg, #fdf6e0 0%, #e8d8a4 100%); border: 1px solid #c4a260;
  }
  .cc-eq-btn:disabled { opacity: 0.3; cursor: default; }

  .cc-eq-side { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
  .cc-eq-sh { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #8a6432; }
  .cc-eq-cart { display: flex; flex-direction: column; gap: 3px; }
  .cc-eq-cartrow {
    display: flex; align-items: center; gap: 7px; font-size: 10px; color: #5c3a12;
    padding: 5px 8px; border-radius: 2px; background: rgba(255,252,240,0.6);
    border: 1px solid rgba(140,90,30,0.2);
  }
  .cc-eq-cartrow img { width: 18px; height: 18px; border-radius: 2px; object-fit: cover; }
  .cc-eq-cartrow .cc-eq-x {
    margin-left: auto; font-family: inherit; cursor: pointer; font-size: 12px; line-height: 1;
    color: #8a6432; background: none; border: none; padding: 0 2px;
  }
  .cc-eq-cartrow .cc-eq-x:hover { color: #a52a1a; }
  .cc-eq-adv { display: flex; flex-direction: column; gap: 4px; }
  .cc-eq-advrow { font-size: 9px; line-height: 1.4; color: #8a6432;
    padding-left: 11px; position: relative; }
  .cc-eq-advrow::before { content: "!"; position: absolute; left: 0; color: #b8862a; }
  .cc-eq-empty { font-size: 10px; color: #9b7040; font-style: italic; }
`;

function tagsFor(rec) {
  const t = [];
  if (rec.slot === "weapon") {
    if (rec.range) t.push(rec.range);
    if (rec.handSlots) t.push(rec.handSlots);
  }
  if (rec.isMartial) t.push("martial");
  return t.map((x) => `<span class="cc-tag">${esc(x)}</span>`).join("");
}

function listHTML(d, martial) {
  const all = catalog()[_tab] ?? [];
  const list = _filter
    ? all.filter((r) => r.name.toLowerCase().includes(_filter.toLowerCase()))
    : all;
  if (!list.length) {
    return `<div class="cc-eq-empty">${all.length ? "Nothing matches." :
      `No items found in "${esc(CC.EQUIP_FOLDERS[_tab])}".`}</div>`;
  }

  let html = "", group = null;
  for (const rec of list) {
    if (_tab === "weapon" && rec.category !== group) {
      group = rec.category;
      html += `<div class="cc-eq-grp">${esc(group)}</div>`;
    }
    const picked = hasPick(d, rec.uuid);
    const gate = canAdd(d, rec);
    const need = martialNeed(rec);
    const untrained = need && !martial[need];
    html += `
      <div class="cc-eq-row ${picked ? "is-picked" : ""}">
        <img src="${esc(rec.img || CC.DEFAULT_IMG)}" alt="">
        <div>
          <div class="cc-eq-nm">${esc(rec.name)}</div>
          <div class="cc-eq-tags">${tagsFor(rec)}${
            untrained ? `<span class="cc-tag" title="No training — carried, not equipped">untrained</span>` : ""}</div>
        </div>
        <div class="cc-eq-cost ${rec.cost ? "" : "is-free"}">${rec.cost ? `${rec.cost}z` : "free"}</div>
        ${picked
          ? `<button class="cc-eq-btn" data-drop="${esc(rec.uuid)}" title="Remove">−</button>`
          : `<button class="cc-eq-btn" data-take="${esc(rec.uuid)}" ${gate.ok ? "" : "disabled"}
                     title="${esc(gate.ok ? "Buy" : gate.reason)}">+</button>`}
      </div>`;
  }
  return html;
}

function cartHTML(d, martial) {
  const list = picks(d);
  const adv = advisories(d, martial);
  return `
    <div class="cc-eq-sh">Chosen (${list.length})</div>
    ${list.length
      ? `<div class="cc-eq-cart">${list.map((p) => `
          <div class="cc-eq-cartrow">
            <img src="${esc(p.img || CC.DEFAULT_IMG)}" alt="">
            <span>${esc(p.name)}</span>
            <button class="cc-eq-x" data-drop="${esc(p.uuid)}" title="Remove">×</button>
          </div>`).join("")}</div>`
      : `<div class="cc-eq-empty">Nothing bought yet.</div>`}
    ${adv.length ? `<div class="cc-eq-sh" style="margin-top:6px">Notes</div>
      <div class="cc-eq-adv">${adv.map((a) => `<div class="cc-eq-advrow">${esc(a)}</div>`).join("")}</div>` : ""}`;
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
    <div class="cc-eq-bar">
      <div class="cc-eq-fig">
        <span class="cc-eq-n ${over ? "is-over" : ""}">${left}</span>
        <span class="cc-eq-k">zenit left</span>
      </div>
      <div class="cc-eq-track"><div class="cc-eq-fill ${over ? "is-over" : ""}" style="width:${pct}%"></div></div>
      <div class="cc-eq-fig">
        <span class="cc-eq-k">${spent} spent of ${budget}</span>
      </div>
    </div>
    <div class="cc-eq-wrap">
      <div>
        <div class="cc-eq-tabs">
          ${TABS.map(([k, label]) =>
            `<button class="cc-eq-tab ${_tab === k ? "is-on" : ""}" data-tab="${k}">${esc(label)}</button>`).join("")}
          <input class="cc-search" data-search placeholder="Search…" value="${esc(_filter)}" style="margin-left:auto;width:130px">
        </div>
        <div class="cc-eq-list">${listHTML(d, martial)}</div>
      </div>
      <div class="cc-eq-side">${cartHTML(d, martial)}</div>
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
