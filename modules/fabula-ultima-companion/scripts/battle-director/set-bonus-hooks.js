// Equipment SET-BONUS self-heal hooks.
//
// `reconcileSetBonuses` (set-bonus.js) is called from the equip paths
// (applyEquipmentSwap / reconcileEquip), which covers equipping/unequipping on
// ONE actor. It does NOT cover the item-CRUD cases: MOVING a set piece between
// actors (delete on the source, create on the destination), bulk add/remove, or
// a GM live-editing the Equipment Set's `set_bonus_table`. Without these hooks
// the source actor keeps a stale grant and the destination never gains one.
//
// These debounced item-CRUD hooks close that gap. GM-only (active GM), so the
// reconcile writes happen exactly once. Mirrors matador-cape-crisis-def-solver.

import { reconcileSetBonuses, getEquipmentSets, isManagedEquip } from "./set-bonus.js";
import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";

const isResponsibleGM = () => {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM;
  return !activeGM || activeGM.id === game.user.id;
};

// Per-actor debounce so a burst of item edits coalesces into one reconcile.
const pending = new Map();
const scheduleActor = (actor, reason) => {
  if (!actor?.id) return;
  // Stand down while a BD-controlled equip flow drives this actor — BD reconciles
  // itself, on its own terms (see withManagedEquip in set-bonus.js).
  if (isManagedEquip(actor.id)) return;
  clearTimeout(pending.get(actor.id));
  pending.set(actor.id, setTimeout(() => {
    pending.delete(actor.id);
    if (isManagedEquip(actor.id)) return; // BD took over after scheduling — skip
    Promise.resolve(reconcileSetBonuses(actor)).catch((e) =>
      warn(`set-bonus-hooks: reconcile failed for ${actor.name} (${reason})`, e),
    );
  }, 100));
};

// A world-item edit to a Equipment Set affects every actor — reconcile all.
let pendingGlobal = null;
const scheduleAll = (reason) => {
  clearTimeout(pendingGlobal);
  pendingGlobal = setTimeout(() => {
    pendingGlobal = null;
    log(`set-bonus-hooks: global reconcile (${reason})`);
    for (const actor of game.actors?.contents ?? []) scheduleActor(actor, reason);
  }, 150);
};

// Is this item one we care about for an ACTOR-level reconcile? Either a set
// piece (CSB isSet) or a managed set-bonus grant we created (so deleting a grant
// by hand re-heals). Definitions live as world items (no parent actor).
const isSetRelevant = (item) =>
  !!item?.system?.props?.isSet ||
  !!item?.flags?.[FLAG_NS]?.setBonusSkill;

const touchesSetFields = (changes) => {
  const props = foundry.utils.getProperty(changes, "system.props") ?? {};
  return ["isEquipped", "isSet", "set_name", "set_bonus_table"].some((k) =>
    Object.prototype.hasOwnProperty.call(props, k),
  );
};

const isEquipmentSetDoc = (item) => {
  if (item?.parent) return false; // definitions are world items
  const rows = item?.system?.props?.set_bonus_table;
  return !!rows && typeof rows === "object" && Object.keys(rows).length > 0;
};

export function installSetBonusHooks() {
  Hooks.on("createItem", (item) => {
    if (!isResponsibleGM()) return;
    if (item?.parent && isSetRelevant(item)) scheduleActor(item.parent, "createItem");
  });

  Hooks.on("deleteItem", (item) => {
    if (!isResponsibleGM()) return;
    if (item?.parent) {
      if (isSetRelevant(item)) scheduleActor(item.parent, "deleteItem");
    } else if (isEquipmentSetDoc(item)) {
      scheduleAll("definition deleted");
    }
  });

  Hooks.on("updateItem", (item, changes) => {
    if (!isResponsibleGM()) return;
    if (item?.parent) {
      if (isSetRelevant(item) || touchesSetFields(changes)) {
        scheduleActor(item.parent, "updateItem");
      }
    } else if (isEquipmentSetDoc(item) || touchesSetFields(changes)) {
      // World-item Equipment Set edited (e.g. table changed) → reconcile all.
      scheduleAll("definition edited");
    }
  });

  // Startup scan: ensure grants reflect the data-authored definitions after a
  // reload (the redesign may have changed which grants are owed).
  Hooks.once("ready", () => {
    if (!isResponsibleGM()) return;
    if (!getEquipmentSets().size) return; // nothing authored → skip the sweep
    for (const actor of game.actors?.contents ?? []) scheduleActor(actor, "ready scan");
  });
}

installSetBonusHooks();
