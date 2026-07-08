// Armor equip-gating hook.
//
// The BD equip system (applyEquipmentSwap / reconcileEquip) toggles per-item AE
// `disabled` for WEAPONS / SHIELDS / ACCESSORIES so their stat-granting effects
// track equip state. Armor is deliberately excluded from that slot-driven flow
// (RAW Core p.70: armor can't be changed mid-action; it's equipped out of combat
// on the CSB sheet, with no hand/accessory slot). That left armor-borne transfer
// AEs — e.g. the Ghostly Sheet's immune-to-strike + 200%-damage effect — applying
// whenever the armor is CARRIED rather than WORN, because a plain `transfer:true`
// AE contributes to the actor as long as it isn't `disabled`.
//
// This ambient hook closes the gap: when an armor item's `isEquipped` flips on the
// sheet, its resident AEs enable/disable to match. GM-only (a single writer); it
// stands down while a BD-managed equip flow drives the actor. Mirrors the
// structure of set-bonus-hooks.js.

import { syncItemEffectsToEquip } from "./equipment-swap.js";
import { isManagedEquip } from "./set-bonus.js";
import { log, warn } from "./logger.js";

const isResponsibleGM = () => {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM;
  return !activeGM || activeGM.id === game.user.id;
};

const isArmor = (item) =>
  String(item?.system?.props?.item_type ?? "").trim().toLowerCase() === "armor";

const touchesEquip = (changes) =>
  Object.prototype.hasOwnProperty.call(
    foundry.utils.getProperty(changes, "system.props") ?? {},
    "isEquipped",
  );

async function syncArmor(item, reason) {
  if (!item?.id) return;
  // Stand down while a BD-controlled equip flow drives this actor — it reconciles
  // armor itself (reconcileEquip), so the hook can't race it.
  if (item.parent && isManagedEquip(item.parent.id)) return;
  try {
    const n = await syncItemEffectsToEquip(item);
    if (n) log(`armor-equip-gate: synced ${n} effect(s) on ${item.name} (${reason})`);
  } catch (e) {
    warn(`armor-equip-gate: sync failed for ${item?.name} (${reason})`, e);
  }
}

export function installArmorEquipGate() {
  // Live equip/unequip on the CSB sheet.
  Hooks.on("updateItem", (item, changes) => {
    if (!isResponsibleGM()) return;
    if (!item?.parent || !isArmor(item)) return;
    if (!touchesEquip(changes)) return;
    syncArmor(item, "updateItem");
  });

  // Newly added / moved armor arrives carrying its own `isEquipped` — heal its
  // AE state to match rather than trusting whatever `disabled` shipped with it.
  Hooks.on("createItem", (item) => {
    if (!isResponsibleGM()) return;
    if (item?.parent && isArmor(item)) syncArmor(item, "createItem");
  });

  // Load/reload sweep: reconcile every owned armor's AE state to `isEquipped`, so
  // a world predating this gate (e.g. an unworn Ghostly Sheet whose AE was left
  // enabled) self-heals. No-op for armor without resident effects or already in
  // sync, so it costs nothing on a healthy world.
  Hooks.once("ready", () => {
    if (!isResponsibleGM()) return;
    for (const actor of game.actors?.contents ?? []) {
      for (const item of actor.items ?? []) {
        if (isArmor(item)) syncArmor(item, "ready sweep");
      }
    }
  });
}

installArmorEquipGate();
