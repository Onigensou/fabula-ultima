// Equip sync — keeps each actor's equip-slot LABEL + CACHED STATS in step with
// the item actually worn (identity = the item id in the equipSlots flag; see
// shared/equipped-gear.js for the model).
//
// Why (2026-11-22): refining renamed Zarg's bow "+5" → "+6" and raised its
// damage, but the actor's main_hand label and weapon1_base_damage copy stayed on
// the old values. Lookups by name then lost the weapon, and the sheet / attack
// kept the old damage until a re-equip. The BD now resolves by id and reads the
// item's own stats, but the CSB sheet's formulas and roll messages can only read
// actor props — so those props are a cache, and this module is its single
// background writer (the equipment swap writes the same stamp in its own commit).
//
// Triggers (GM-only, one primary GM — Idiom A of the GM host pattern):
//   - updateItem on a worn hand/accessory item that renames it or changes a
//     cached stat (refine, orbment, a GM edit on the item sheet);
//   - updateActor that writes a slot LABEL without the id (the legacy Equipment
//     macro, a GM typing on the sheet, a save restore) → the id follows the label:
//     stamped when the label names an owned item, cleared when it names none (a
//     bare typed name must not snap back to the item an old id points at).
// Writes are diff-only (nothing to write = no update), debounced per actor, and
// stand down while a BD-managed equip flow is driving the actor (it stamps
// itself). Slots that resolve to no item (NPC bare names) are never touched.

import { planEquipSync, EQUIP_CACHED_ITEM_PROPS, EQUIP_FLAG_NS, EQUIP_SLOTS_FLAG,
  isHandItem, isAccessoryItem, isArmorItem, wornArmorOf, resolveWornSlots, planLabelWrite, EQUIP_SLOT_DEFS } from "../shared/equipped-gear.js";
import { isManagedEquip } from "./set-bonus.js";
import { log, warn } from "./logger.js";

const SYNC_OPTION = "fuEquipSync";
const DEBOUNCE_MS = 60;

const isPrimaryGM = () => {
  const shared = globalThis.FUCompanion?.isPrimaryGM;
  if (typeof shared === "function") return shared();
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM;
  return !activeGM || activeGM.id === game.user.id;
};

/**
 * Apply the planned sync to one actor. `labelSlots` = slots whose LABEL was just
 * written without an id: their ids follow the label first (planLabelWrite), then
 * every slot that resolves to an item is re-stamped. Returns the slots re-stamped.
 */
export async function syncEquipped(actor, reason = "manual", labelSlots = []) {
  if (!actor || actor.pack) return [];
  try {
    if (labelSlots.length) {
      const clears = planLabelWrite(actor, labelSlots);
      if (Object.keys(clears).length) {
        await actor.update(clears, { [SYNC_OPTION]: true });
        log(`equip-sync: ${actor.name} cleared ${Object.keys(clears).length} slot id(s) no longer named by their label (${reason})`);
      }
    }
    const { update, slots } = planEquipSync(actor);
    if (!slots.length) return [];
    await actor.update(update, { [SYNC_OPTION]: true });
    log(`equip-sync: ${actor.name} re-stamped ${slots.join(", ")} (${reason})`);
    return slots;
  } catch (e) {
    warn(`equip-sync: update failed for ${actor?.name} (${reason})`, e);
    return [];
  }
}

const MANAGED_RETRY_MAX = 100;   // × DEBOUNCE_MS = 6 s; a managed equip never runs that long
const _pending = new Map();      // actor uuid → { timer, reasons:Set, labelSlots:Set, retries }
function queueSync(actor, reason, labelSlots = []) {
  if (!actor?.id || actor.pack) return;
  const key = actor.uuid ?? actor.id;
  let entry = _pending.get(key);
  if (!entry) { entry = { reasons: new Set(), labelSlots: new Set(), timer: null, retries: 0 }; _pending.set(key, entry); }
  entry.reasons.add(reason);
  for (const s of labelSlots) entry.labelSlots.add(s);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    // A BD-managed swap in flight stamps the slots itself; wait for it to end.
    if (isManagedEquip(actor.id) && entry.retries < MANAGED_RETRY_MAX) {
      entry.retries++;
      queueSync(actor, reason);
      return;
    }
    _pending.delete(key);
    syncEquipped(actor, [...entry.reasons].join(" + "), [...entry.labelSlots]);
  }, DEBOUNCE_MS);
}

function itemChangeMatters(changes) {
  if (!changes || typeof changes !== "object") return false;
  if ("name" in changes) return true;
  const p = changes.system?.props;
  if (!p || typeof p !== "object") return false;
  return EQUIP_CACHED_ITEM_PROPS.some((k) => k in p);
}

/** The slots whose LABEL prop this actor update wrote. */
function labelSlotsTouched(changes) {
  const p = changes?.system?.props;
  if (!p || typeof p !== "object") return [];
  return SLOT_KEYS.filter((slot) => EQUIP_SLOT_DEFS[slot].labelProp in p);
}

const WORN_SLOT_OPTION = "fuEquipWornSlot";
const SLOT_KEYS = ["main", "off", "acc1", "acc2"];

export function installEquipSync() {
  // Before a RENAME, note which slot the item is worn in (resolved under its old
  // name) on the update's options — they travel with the update to every client.
  // That covers an actor whose slot has no id stamped yet (data predating the id
  // model that a migration missed): after the rename the label no longer names it.
  Hooks.on("preUpdateItem", (item, changes, options) => {
    try {
      if (!changes || !("name" in changes)) return;
      const actor = item?.parent;
      if (!actor || actor.documentName !== "Actor") return;
      if (!(isHandItem(item) || isAccessoryItem(item))) return;
      const worn = resolveWornSlots(actor);
      const slot = SLOT_KEYS.find((k) => worn[k]?.id === item.id);
      if (slot) options[WORN_SLOT_OPTION] = slot;
    } catch (e) { warn("equip-sync: preUpdateItem probe failed", e); }
  });

  Hooks.on("updateItem", async (item, changes, options) => {
    if (!isPrimaryGM()) return;
    const actor = item?.parent;
    if (!actor || actor.documentName !== "Actor") return;
    // A worn armor that was renamed (refined): only its sheet label follows.
    if (isArmorItem(item)) {
      if (changes && "name" in changes && wornArmorOf(actor)?.id === item.id) queueSync(actor, `armor "${item.name}" renamed`);
      return;
    }
    if (!(isHandItem(item) || isAccessoryItem(item))) return;
    if (!itemChangeMatters(changes)) return;
    // Only when this item is worn — a rename of a bag item has nothing to stamp.
    const worn = resolveWornSlots(actor);
    let isWorn = SLOT_KEYS.some((k) => worn[k]?.id === item.id);
    const notedSlot = options?.[WORN_SLOT_OPTION];
    if (!isWorn && SLOT_KEYS.includes(notedSlot)) {
      // Worn before the rename but unresolvable now (no id stamped): stamp the id.
      try {
        await actor.update({ [`flags.${EQUIP_FLAG_NS}.${EQUIP_SLOTS_FLAG}.${notedSlot}`]: item.id }, { [SYNC_OPTION]: true });
        isWorn = true;
      } catch (e) { warn(`equip-sync: id stamp failed for ${actor.name}`, e); }
    }
    if (!isWorn) return;
    queueSync(actor, `item "${item.name}" changed`);
  });

  Hooks.on("updateActor", (actor, changes, options) => {
    if (options?.[SYNC_OPTION]) return;
    if (!isPrimaryGM()) return;
    const touched = labelSlotsTouched(changes);
    if (!touched.length) return;
    // A slot whose id was written in the same update (the equipment swap, a
    // rewind, a save that carries ids) is already coherent; the rest are
    // label-only writes, and their ids must follow the label.
    const flagged = changes?.flags?.[EQUIP_FLAG_NS]?.[EQUIP_SLOTS_FLAG];
    const labelOnly = touched.filter((slot) => !(flagged && typeof flagged === "object" && slot in flagged));
    if (!labelOnly.length) return;
    queueSync(actor, "slot label written", labelOnly);
  });
}

// Console / migration / test handle.
function exposeApi() {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.equipSync = {
    plan: (actor) => planEquipSync(actor),
    sync: (actor) => syncEquipped(actor, "api"),
    worn: (actor) => resolveWornSlots(actor),
  };
}

installEquipSync();
exposeApi();
