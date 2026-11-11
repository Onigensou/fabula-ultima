// scripts/crafting-system/crafting-data.js
//
// BLUEPRINT DATA — the crafting config, read on every client, written by a GM.
//
// Everything lives in ONE world Item, "_Crafting Config", in its flag
// flags.fabula-ultima-companion.craftingConfig:
//
//   {
//     version: 1,
//     campBookId: "<book id>" | "",          // the book Camp Forge → Craft uses
//     books: [{
//       id, name,
//       costRule: { npc: { zenit: 1, ip: 1 }, table: {...}, camp: {...} },   // multipliers
//       blueprints: [{
//         id, name,                            // name optional: defaults to the outputs
//         outputs:   [{ uuid, name, img, qty }],
//         materials: [{ name, uuid, img, qty }],   // matched BY NAME in the bag / stash
//         cost:      { zenit, ip },            // the default cost of one craft
//         placeCost: { npc?: { zenit, ip }, table?: {...}, camp?: {...} },  // exact override
//         unlockSwitch: "",                    // story switch that must be ON ("" = always known)
//         hint: "",                            // shown on the "???" row while locked
//       }],
//     }],
//   }
//
// Books and Blueprints are ARRAYS on purpose: a document update replaces an
// array whole, so a deleted book really goes (an object would deep-merge and
// keep it). Players read the item (default ownership Observer); only a GM writes.
//
// "Blueprint" is its own keyword. Recipe items (item_type "recipe", in-battle
// Item → Create with IP) are a different system and are never read here.

import { TAG, MODULE_ID, CONFIG_ITEM_NAME, CONFIG_FLAG, PLACES, int, readZenit, readIp } from "./crafting-const.js";

// ── Config item ────────────────────────────────────────────────────────────────
export function getConfigItem() {
  return game.items?.find?.((i) => i.name === CONFIG_ITEM_NAME) ?? null;
}

const clampQty = (v) => Math.max(1, Math.min(999, int(v, 1)));
const cleanCost = (c) => ({ zenit: Math.max(0, int(c?.zenit, 0)), ip: Math.max(0, int(c?.ip, 0)) });
const cleanMult = (m) => {
  const z = Number(m?.zenit), i = Number(m?.ip);
  return { zenit: Number.isFinite(z) && z >= 0 ? z : 1, ip: Number.isFinite(i) && i >= 0 ? i : 1 };
};
const newId = () => foundry.utils.randomID(12);

export function normalizeBlueprint(bp = {}) {
  const placeCost = {};
  for (const p of PLACES) if (bp.placeCost?.[p]) placeCost[p] = cleanCost(bp.placeCost[p]);
  return {
    id: String(bp.id || newId()),
    name: String(bp.name ?? "").trim(),
    outputs: (Array.isArray(bp.outputs) ? bp.outputs : [])
      .filter((o) => o?.uuid || o?.name)
      .map((o) => ({ uuid: String(o.uuid ?? ""), name: String(o.name ?? ""), img: String(o.img ?? ""), qty: clampQty(o.qty) })),
    materials: (Array.isArray(bp.materials) ? bp.materials : [])
      .filter((m) => String(m?.name ?? "").trim())
      .map((m) => ({ name: String(m.name).trim(), uuid: String(m.uuid ?? ""), img: String(m.img ?? ""), qty: clampQty(m.qty) })),
    cost: cleanCost(bp.cost),
    placeCost,
    unlockSwitch: String(bp.unlockSwitch ?? "").trim(),
    hint: String(bp.hint ?? "").trim(),
  };
}

export function normalizeBook(b = {}) {
  const costRule = {};
  for (const p of PLACES) costRule[p] = cleanMult(b.costRule?.[p]);
  return {
    id: String(b.id || newId()),
    name: String(b.name ?? "").trim() || "Untitled book",
    costRule,
    blueprints: (Array.isArray(b.blueprints) ? b.blueprints : []).map(normalizeBlueprint),
  };
}

export function normalizeConfig(raw = {}) {
  const books = (Array.isArray(raw.books) ? raw.books : []).map(normalizeBook);
  const campBookId = books.some((b) => b.id === raw.campBookId) ? String(raw.campBookId) : "";
  return { version: 1, campBookId, books };
}

export function readConfig() {
  return normalizeConfig(getConfigItem()?.getFlag?.(MODULE_ID, CONFIG_FLAG) ?? {});
}

export const getBook = (bookId, cfg = readConfig()) => cfg.books.find((b) => b.id === bookId) ?? null;
export const campBook = (cfg = readConfig()) => getBook(cfg.campBookId, cfg);
export const findBlueprint = (book, blueprintId) => book?.blueprints?.find((b) => b.id === blueprintId) ?? null;

// GM: create the config item when it doesn't exist yet. It needs a valid CSB
// item body, so it's cloned from an existing "misc" equippable item (the
// _Cooking Config first) and stripped down to a plain data holder.
export async function ensureConfigItem() {
  const have = getConfigItem();
  if (have) return have;
  if (!game.user?.isGM) throw new Error("Only a GM can create the crafting config.");
  const src = game.items.find((i) => i.name === "_Cooking Config")
    ?? game.items.find((i) => i.type === "equippableItem" && i.system?.props?.item_type === "misc" && !i.system?.container)
    ?? game.items.find((i) => i.type === "equippableItem" && !i.system?.container);
  let data;
  if (src) {
    data = src.toObject();
    delete data._id;
    delete data.system?.uniqueId;
    data.flags = {};
    data.effects = [];
    if (data.system?.props) {
      data.system.props.item_type = "misc";
      data.system.props.item_cost = "0";
      data.system.props.description = "<p>Crafting System data: every Blueprint book. Edit it with the Blueprint Editor (Game Settings → Blueprint Editor), not by hand.</p>";
      data.system.props.name = CONFIG_ITEM_NAME;
      data.system.props.img = "icons/svg/book.svg";
    }
  } else {
    data = { type: Object.keys(CONFIG?.Item?.dataModels ?? {})[0] ?? "equippableItem", system: {} };
  }
  data.name = CONFIG_ITEM_NAME;
  data.img = "icons/svg/book.svg";
  data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
  data.folder = src?.folder?.id ?? src?.folder ?? null;
  data.flags = { [MODULE_ID]: { [CONFIG_FLAG]: normalizeConfig({}) } };
  const [item] = await Item.createDocuments([data]);
  // A clone carries the source's own id in its props; point them at itself.
  if (item?.system?.props && "id" in item.system.props) {
    await item.update({ "system.uniqueId": item.id, "system.props.id": item.id, "system.props.uuid": `Item.${item.id}` }).catch(() => {});
  }
  console.log(TAG, "Created", CONFIG_ITEM_NAME, item?.uuid);
  return item;
}

// GM: write the whole config (normalized). Replaces the flag outright.
export async function saveConfig(cfg) {
  if (!game.user?.isGM) throw new Error("Only a GM can edit Blueprints.");
  const item = await ensureConfigItem();
  const clean = normalizeConfig(cfg);
  await item.update({ [`flags.${MODULE_ID}.-=${CONFIG_FLAG}`]: null });
  await item.update({ [`flags.${MODULE_ID}.${CONFIG_FLAG}`]: clean });
  return clean;
}

// ── Reading a Blueprint ──────────────────────────────────────────────────────
const syncDoc = (uuid) => { try { return uuid ? fromUuidSync(uuid) : null; } catch { return null; } };

// The output's live world item (name / img / type follow the item if it was edited).
export function outputView(o) {
  const doc = syncDoc(o.uuid);
  return {
    uuid: doc?.uuid ?? o.uuid, name: doc?.name ?? o.name ?? "(missing item)", img: doc?.img ?? o.img ?? "icons/svg/item-bag.svg",
    qty: o.qty, rarity: doc?.system?.props?.item_rarity ?? "", type: String(doc?.system?.props?.item_type ?? "").toLowerCase(),
    missing: !doc,
  };
}

export function blueprintTitle(bp) {
  if (bp.name) return bp.name;
  const outs = bp.outputs.map(outputView);
  return outs.length ? outs.map((o) => o.name).join(" + ") : "Empty Blueprint";
}

export function categoryOf(bp) {
  const t = bp.outputs.length ? outputView(bp.outputs[0]).type : "";
  if (t === "weapon") return "weapon";
  if (t === "armor" || t === "shield") return "armor";
  if (t === "accessory") return "accessory";
  if (t === "consumable") return "item";
  return "other";
}

export function isUnlocked(bp) {
  if (!bp.unlockSwitch) return true;
  try { return !!(window.oni?.GameState ?? window.oni?.EventSystem?.GameState)?.getSwitch?.(bp.unlockSwitch); }
  catch { return false; }
}

// The cost of ONE craft at a place: the Blueprint's exact override for that
// place if it has one, else its default cost × the book's rule for the place.
export function costFor(book, bp, place) {
  const own = bp.placeCost?.[place];
  if (own) return { zenit: own.zenit, ip: own.ip };
  const m = book?.costRule?.[place] ?? { zenit: 1, ip: 1 };
  return { zenit: Math.max(0, Math.round(bp.cost.zenit * m.zenit)), ip: Math.max(0, Math.round(bp.cost.ip * m.ip)) };
}

// ── Materials ────────────────────────────────────────────────────────────────
const norm = (s) => String(s ?? "").trim().toLowerCase();
export function itemQty(item) {
  const n = Number(item?.system?.props?.item_quantity);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1;
}
const isEquipped = (item) => {
  const v = item?.system?.props?.isEquipped;
  return v === true || v === "true";
};

// Stacks of a material (by name) on an actor; equipped gear never counts.
export function stacksOf(actor, name) {
  const want = norm(name);
  if (!actor || !want) return [];
  return (actor.items?.contents ?? [])
    .filter((i) => norm(i.name) === want && !i.system?.container && !isEquipped(i))
    .map((item) => ({ item, qty: itemQty(item) }))
    .filter((s) => s.qty > 0);
}
const sum = (stacks) => stacks.reduce((t, s) => t + s.qty, 0);

// The party stash (the current game's database actor), or null.
export async function partyStash() {
  try {
    const r = await window.FUCompanion?.api?.getCurrentGameDb?.();
    return r?.db ?? null;
  } catch { return null; }
}

// Everything the window and the GM need to know about crafting `bp` `qty` times.
//   ctx: { actor, stash, book, place, campDone }
export function evaluate(bp, ctx, qty = 1) {
  const { actor, stash, book, place, campDone = false } = ctx;
  const q = Math.max(1, int(qty, 1));
  const unlocked = isUnlocked(bp);
  const unit = costFor(book, bp, place);
  const cost = { zenit: unit.zenit * q, ip: unit.ip * q };
  const mats = bp.materials.map((m) => {
    const bag = sum(stacksOf(actor, m.name)), st = sum(stacksOf(stash, m.name));
    const need = m.qty * q;
    return { name: m.name, img: m.img, uuid: m.uuid, per: m.qty, need, bag, stash: st, ok: bag + st >= need };
  });
  const zenit = readZenit(actor), ip = readIp(actor);
  let reason = null;
  if (!unlocked) reason = "locked";
  else if (!bp.outputs.length || bp.outputs.some((o) => outputView(o).missing)) reason = "bad_output";
  else if (place === "camp" && campDone) reason = "camp_done";
  else if (place === "camp" && q > 1) reason = "camp_one";
  else if (mats.some((m) => !m.ok)) reason = "materials";
  else if (cost.zenit > zenit) reason = "zenit";
  else if (cost.ip > ip.cur) reason = "ip";
  return { ok: !reason, reason, qty: q, unit, cost, mats, zenit, ip, unlocked };
}

// The most this actor could craft right now (1 at camp).
export function maxQty(bp, ctx, cap = 99) {
  if (ctx.place === "camp") return 1;
  if (!evaluate(bp, ctx, 1).ok) return 1;
  let q = 1;
  while (q < cap && evaluate(bp, ctx, q + 1).ok) q++;
  return q;
}

export function reasonText(ev, actorName = "") {
  const who = actorName || "You";
  switch (ev?.reason) {
    case "locked": return "This Blueprint hasn't been learned yet.";
    case "bad_output": return "This Blueprint's item is missing. Ask the GM to fix it.";
    case "camp_done": return "Already crafted at this camp.";
    case "camp_one": return "Camp crafting makes one at a time.";
    case "materials": { const m = ev.mats.find((x) => !x.ok); return m ? `Not enough ${m.name} (${m.bag + m.stash} / ${m.need}).` : "Missing materials."; }
    case "zenit": return `${who} needs ${ev.cost.zenit} Zenit (has ${ev.zenit}).`;
    case "ip": return `${who} needs ${ev.cost.ip} IP (has ${ev.ip.cur}).`;
    default: return ev?.reason ? `Can't craft (${ev.reason}).` : "";
  }
}
