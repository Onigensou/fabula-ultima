// Equip-locked effects: "can't be cleansed WHILE this item is equipped".
//
// An ActiveEffect may carry
//
//   flags.fabula-ultima-companion.equipLock = "<item name>"
//
// together with `uncleansable` / `directorPermanent`. Those two hold only while
// the bearer has an item of that name EQUIPPED. Once it is not (unequipped,
// dropped, moved to another actor), this hook clears both flags and the lock
// itself, so the effect STAYS but is an ordinary status from then on: Cleanse,
// Rest and the battle-end sweep treat it like any other copy of that status.
// Re-equipping re-applies the locked version through the item's own passive.
//
// First user: Muramasa's self-Doom (2026-11-21-hako-ch4-leftovers migration).
//
// Fires on every equip change, not only in combat (equipping happens at camp
// too), on item delete, and once on ready (self-heal for a world saved with a
// stale lock). Active-GM only, a single writer; waits for a BD-managed equip
// flow to finish before judging, like set-bonus-hooks.js.

import { isManagedEquip } from "./set-bonus.js";
import { log, warn } from "./logger.js";

const NS = "fabula-ultima-companion";

const isResponsibleGM = () => {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM;
  return !activeGM || activeGM.id === game.user.id;
};

const lockOf = (eff) => {
  const v = eff?.flags?.[NS]?.equipLock;
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
};

const wields = (actor, name) => (actor?.items?.contents ?? Array.from(actor?.items ?? [])).some((i) =>
  !String(i.system?.container ?? "").trim()
  && String(i.name ?? "").trim().toLowerCase() === name
  && i.system?.props?.isEquipped === true);

/** Clear the lock on every effect of `actor` whose item is no longer equipped. Returns the count. */
export async function releaseEquipLocks(actor, reason = "") {
  if (!actor?.effects) return 0;
  const stale = actor.effects.filter((e) => {
    const name = lockOf(e);
    return name && !wields(actor, name);
  });
  if (!stale.length) return 0;
  const items = [...new Set(stale.map((e) => e.flags[NS].equipLock))].join(", ");
  const names = stale.map((e) => e.name).join(", ");
  await actor.updateEmbeddedDocuments("ActiveEffect", stale.map((e) => ({
    _id: e.id,
    [`flags.${NS}.uncleansable`]: false,
    [`flags.${NS}.directorPermanent`]: false,
    [`flags.${NS}.-=equipLock`]: null,
  })));
  log(`equip-lock: ${actor.name} no longer wields ${items} — ${names} can be cleansed now (${reason})`);
  return stale.length;
}

const pending = new Map();
function schedule(actor, reason, tries = 0) {
  if (!actor?.id) return;
  if (!actor.effects?.some?.((e) => lockOf(e))) return;
  const key = actor.uuid;
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    // A BD equip flow is mid-swap (old item off, new item not yet on): judge after it.
    if (isManagedEquip(actor.id) && tries < 40) { schedule(actor, reason, tries + 1); return; }
    releaseEquipLocks(actor, reason).catch((e) => warn(`equip-lock: release failed for ${actor.name}`, e));
  }, 150));
}

const touchesEquip = (changes) =>
  Object.prototype.hasOwnProperty.call(foundry.utils.getProperty(changes, "system.props") ?? {}, "isEquipped");

export function installEquipLockRelease() {
  Hooks.on("updateItem", (item, changes) => {
    if (!isResponsibleGM() || !item?.parent || item.parent.documentName !== "Actor") return;
    if (!touchesEquip(changes)) return;
    schedule(item.parent, `unequip ${item.name}`);
  });
  Hooks.on("deleteItem", (item) => {
    if (!isResponsibleGM() || !item?.parent || item.parent.documentName !== "Actor") return;
    schedule(item.parent, `removed ${item.name}`);
  });
  Hooks.once("ready", () => {
    if (!isResponsibleGM()) return;
    for (const actor of game.actors?.contents ?? []) schedule(actor, "ready sweep");
  });
}

installEquipLockRelease();
