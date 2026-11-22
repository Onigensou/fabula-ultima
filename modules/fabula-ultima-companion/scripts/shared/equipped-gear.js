// ============================================================================
// Shared — Equipped gear: which item is worn in each slot, by ITEM ID.
//
// Why this exists (2026-11-22, Zarg's bow): the hand / accessory slots used to
// be NAME strings only (`system.props.main_hand` = "+5 Zarg's Bow"). Refining
// renames the item ("+6 Zarg's Bow"), the slot kept the old name, and every
// system that looked the weapon up by name (BD attack, Barrage's ranged gate,
// equipment swap, reconcileEquip, the party menu, damage breakdown) found
// nothing. The slot also held COPIES of the weapon's stats taken at equip time
// (`weapon1_base_damage`, …), so the refine's extra damage never reached the
// attack until a re-equip.
//
// The model now:
//   - IDENTITY: `flags.fabula-ultima-companion.equipSlots.{main,off,acc1,acc2}`
//     holds the worn item's id. Flags, not CSB props, so a template reload can
//     never strip them.
//   - LABEL: the old name props stay, for display (the CSB sheet and its roll
//     messages read them) and as the fallback for actors with no item behind
//     the slot (most NPCs carry a bare typed name).
//   - CACHE: the copied stats stay too — the CSB sheet's own formulas can only
//     read actor props — but ONE writer owns them: slotStamp() below, used by
//     the equipment swap and by the GM sync (battle-director/equip-sync.js),
//     which re-stamps whenever a worn item changes (refine, rename, GM edit).
//
// Resolution order for one slot (resolveWornSlots):
//   0. empty label            → nothing worn (every writer clears the label to unequip)
//   1. id's item, name == label → it (the normal, fully-synced case; also picks
//                                 the exact copy when two items share a name)
//   2. an item named like the label → it (a writer that only knows names set it:
//                                 the legacy Equipment macro, a save restore, a GM
//                                 typing on the sheet). The GM sync re-stamps the id.
//   3. id's item (label stale)  → it (an item was renamed and the GM sync has not
//                                 caught up yet — the refine case)
//   4. nothing.
// ============================================================================

export const EQUIP_FLAG_NS = "fabula-ultima-companion";
export const EQUIP_SLOTS_FLAG = "equipSlots";

/** Slot keys → the label prop and the slot family. */
export const EQUIP_SLOT_DEFS = Object.freeze({
  main: Object.freeze({ labelProp: "main_hand",       family: "hand" }),
  off:  Object.freeze({ labelProp: "off_hand",        family: "hand" }),
  acc1: Object.freeze({ labelProp: "accessory_name",  family: "accessory" }),
  acc2: Object.freeze({ labelProp: "accessory2_name", family: "accessory" }),
});
export const EQUIP_SLOT_KEYS = Object.freeze(Object.keys(EQUIP_SLOT_DEFS));
export const EQUIP_LABEL_PROPS = Object.freeze(EQUIP_SLOT_KEYS.map((k) => EQUIP_SLOT_DEFS[k].labelProp));

/** Item fields the slot cache copies — a change to any of them on a worn item needs a re-stamp. */
export const EQUIP_CACHED_ITEM_PROPS = Object.freeze([
  "item_type", "rolled_atr1", "rolled_atr2", "check_bonus", "damage_bonus",
  "item_def_bonus", "item_mdef_bonus", "type_damage", "description",
]);

const typeOf = (it) => String(it?.system?.props?.item_type ?? "").trim().toLowerCase();
const nameOf = (it) => String(it?.name ?? it?.system?.props?.name ?? "");
const itemsOf = (actor) => actor?.items?.contents ?? (Array.isArray(actor?.items) ? actor.items : Array.from(actor?.items ?? []));

export const isHandItem = (it) => typeOf(it) === "weapon" || typeOf(it) === "shield";
export const isAccessoryItem = (it) => typeOf(it) === "accessory";
export const isHiddenGear = (it) => !!it?.flags?.[EQUIP_FLAG_NS]?.hiddenUntilBattleEnd;

/** The stored slot ids: { main, off, acc1, acc2 } (missing keys = no id). */
export function slotIdsOf(actor) {
  const raw = actor?.flags?.[EQUIP_FLAG_NS]?.[EQUIP_SLOTS_FLAG];
  return (raw && typeof raw === "object") ? raw : {};
}

// Name fallback with the distinct-copy rule: two items can share a name (a pair
// of daggers, Kiki's three Wakizashi). Prefer a copy flagged isEquipped and never
// hand a second slot the copy the first slot took while another copy exists.
function pickByName(pool, name, taken) {
  const matches = pool.filter((it) => nameOf(it) === name);
  if (!matches.length) return null;
  const free = matches.filter((it) => !taken.has(it.id));
  const list = free.length ? free : matches;
  return list.find((it) => it?.system?.props?.isEquipped === true) ?? list[0] ?? null;
}

function resolveOne(actor, slot, pool, taken, ids) {
  const props = actor?.system?.props ?? actor?.system ?? {};
  const label = String(props[EQUIP_SLOT_DEFS[slot].labelProp] ?? "").trim();
  if (!label) return { item: null, via: "empty" };
  const id = ids[slot] ? String(ids[slot]) : "";
  const byId = id ? (pool.find((it) => it?.id === id) ?? null) : null;
  if (byId && nameOf(byId).trim() === label) return { item: byId, via: "id" };
  const named = pickByName(pool, label, taken);
  if (named) return { item: named, via: "name" };
  if (byId) return { item: byId, via: "id-stale-label" };
  return { item: null, via: "none" };
}

/**
 * The item worn in each slot.
 * @param {Actor} actor
 * @param {object} [opts]
 * @param {Item[]} [opts.handPool]       candidate hand items (default: weapons + shields, hidden excluded)
 * @param {Item[]} [opts.accessoryPool]  candidate accessories (default: accessories, hidden excluded)
 * @param {boolean} [opts.includeHidden] include `hiddenUntilBattleEnd` items in the default pools
 * @returns {{main, off, acc1, acc2, via:{main,off,acc1,acc2}}}
 */
export function resolveWornSlots(actor, opts = {}) {
  const out = { main: null, off: null, acc1: null, acc2: null, via: {} };
  if (!actor) return out;
  const all = itemsOf(actor).filter((it) => opts.includeHidden || !isHiddenGear(it));
  const handPool = opts.handPool ?? all.filter(isHandItem);
  const accPool = opts.accessoryPool ?? all.filter(isAccessoryItem);
  const ids = slotIdsOf(actor);

  const handTaken = new Set();
  for (const slot of ["main", "off"]) {
    const r = resolveOne(actor, slot, handPool, handTaken, ids);
    out[slot] = r.item; out.via[slot] = r.via;
    if (r.item) handTaken.add(r.item.id);
  }
  const accTaken = new Set();
  for (const slot of ["acc1", "acc2"]) {
    const r = resolveOne(actor, slot, accPool, accTaken, ids);
    out[slot] = r.item; out.via[slot] = r.via;
    if (r.item) accTaken.add(r.item.id);
  }
  return out;
}

/** The item worn in one slot ("main" | "off" | "acc1" | "acc2"), or null. */
export function wornItem(actor, slot, opts) {
  return resolveWornSlots(actor, opts)[slot] ?? null;
}

/** The slot a given item is worn in, or null. */
export function slotOfItem(actor, item, opts) {
  if (!actor || !item) return null;
  const worn = resolveWornSlots(actor, opts);
  return EQUIP_SLOT_KEYS.find((k) => worn[k]?.id === item.id) ?? null;
}

/**
 * The full actor update that says "`item` is worn in `slot`" (item null = empty):
 * the id flag, the label, and the cached stats. The ONE place the field mapping
 * lives — the equipment swap and the GM sync both write through it, so they can
 * never disagree (it mirrors the legacy Equipment macro's applyHand / accessory
 * writes, which the CSB sheet formulas expect).
 */
export function slotStamp(slot, item) {
  const def = EQUIP_SLOT_DEFS[slot];
  if (!def) throw new Error(`slotStamp: unknown slot "${slot}"`);
  const np = item?.system?.props ?? {};
  const label = item ? nameOf(item) : "";
  const out = { [`flags.${EQUIP_FLAG_NS}.${EQUIP_SLOTS_FLAG}.${slot}`]: item?.id ?? null };
  if (def.family === "hand") {
    const isWeapon = typeOf(item) === "weapon";
    const P = (k) => `system.props.${k}`;
    if (slot === "main") {
      Object.assign(out, {
        [P("main_hand")]:           label,
        [P("main_attrib_1")]:       isWeapon ? (np.rolled_atr1 ?? "DEX") : "SHI",
        [P("main_attrib_2")]:       isWeapon ? (np.rolled_atr2 ?? "DEX") : "SHI",
        [P("weapon1_base_mod")]:    isWeapon ? (np.check_bonus ?? 0)  : (np.item_def_bonus ?? 0),
        [P("weapon1_base_damage")]: isWeapon ? (np.damage_bonus ?? 0) : (np.item_mdef_bonus ?? 0),
        [P("weapon1_damagetype")]:  isWeapon ? (np.type_damage ?? "Physical") : "-",
        [P("main_details")]:        np.description ?? "",
      });
    } else {
      Object.assign(out, {
        [P("off_hand")]:            label,
        [P("off_attrib_1")]:        isWeapon ? (np.rolled_atr1 ?? "DEX") : "SHI",
        [P("off_attrib_2")]:        isWeapon ? (np.rolled_atr2 ?? "DEX") : "SHI",
        [P("off_base_mod_1")]:      isWeapon ? (np.check_bonus ?? 0)  : (np.item_def_bonus ?? 0),
        [P("off_base_mod_2")]:      isWeapon ? (np.damage_bonus ?? 0) : (np.item_mdef_bonus ?? 0),
        [P("weapon2_damagetype")]:  isWeapon ? (np.type_damage ?? "Physical") : "-",
        [P("off_details")]:         np.description ?? "",
      });
    }
  } else {
    const base = slot === "acc1" ? "accessory" : "accessory2";
    out[`system.props.${base}_name`] = label;
    out[`system.props.${base}_details`] = np.description ?? "";
  }
  return out;
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (a, b) => (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");

/**
 * What a sync would write: for each slot that resolves to an item, the fields of
 * slotStamp() that differ from the actor's SOURCE data. Slots that resolve to
 * nothing are left alone (an NPC's bare typed name and its hand-set stats are
 * not ours to touch). Pure — the migration and the tests use it as a dry run.
 * @returns {{update:object, slots:string[]}}
 */
export function planEquipSync(actor) {
  const update = {};
  const slots = [];
  if (!actor) return { update, slots };
  const worn = resolveWornSlots(actor);
  const src = actor._source ?? actor;
  for (const slot of EQUIP_SLOT_KEYS) {
    const item = worn[slot];
    if (!item) continue;
    let touched = false;
    for (const [path, value] of Object.entries(slotStamp(slot, item))) {
      if (!same(getPath(src, path), value)) { update[path] = value; touched = true; }
    }
    if (touched) slots.push(slot);
  }
  return { update, slots };
}

/**
 * Damage / accuracy bonus for an attack with `item` in `hand`, read from the ITEM
 * plus the actor-level buffs CSB layers on top of the cached base (the computed
 * `weapon1_mod` − `weapon1_base_mod`, etc.). Correct even while the cache is a
 * beat behind the item (the GM sync writes asynchronously). null when the actor
 * has no cached base to diff against.
 */
export function itemAttackBonuses(actor, item, hand = "main") {
  const p = actor?.system?.props ?? {};
  const ip = item?.system?.props ?? {};
  const k = hand === "off"
    ? { acc: "off_mod_1", accBase: "off_base_mod_1", dmg: "off_mod_2", dmgBase: "off_base_mod_2" }
    : { acc: "weapon1_mod", accBase: "weapon1_base_mod", dmg: "weapon1_damage", dmgBase: "weapon1_base_damage" };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const acc = num(p[k.acc]), accBase = num(p[k.accBase]);
  const dmg = num(p[k.dmg]), dmgBase = num(p[k.dmgBase]);
  if (acc === null || accBase === null || dmg === null || dmgBase === null) return null;
  return {
    checkBonus:  (num(ip.check_bonus) ?? 0)  + (acc - accBase),
    damageBonus: (num(ip.damage_bonus) ?? 0) + (dmg - dmgBase),
  };
}
