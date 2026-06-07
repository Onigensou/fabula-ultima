// Equipment swap — director-native helpers.
//
// Mirrors the legacy `[Macro] Equipment.js` data shape and commit logic
// so an actor swapped via the director's Equipment card has identical
// downstream state to a swap done through the legacy dialog:
//
//   - actor.system.props.main_hand / off_hand / accessory_name /
//     accessory2_name (display strings)
//   - actor.system.props.main_attrib_1/2 + off_attrib_1/2 (attribute pair
//     the Attack action will read from snapshot)
//   - actor.system.props.weapon1_base_mod / weapon1_base_damage / off_base_mod_1/2
//     (BASE check + damage; CSB recomputes the displayed weapon1_mod /
//     off_mod_1 from these + actor-level buffs)
//   - actor.system.props.weapon1_damagetype / weapon2_damagetype
//   - actor.system.props.main_details / off_details (description for sheet)
//   - actor.system.props.accessory_details / accessory2_details
//   - per-item `system.props.isEquipped` toggle (for items that appear in
//     the equipment selector to know what's worn)
//   - per-item Active Effects' `disabled` flag (items grant stat bonuses
//     via embedded AEs; toggling disabled syncs the bonus to equip state)
//
// Armor is intentionally NOT swappable here — RAW Core p.70: "you can't
// equip or put away [armor] -- there's simply not enough time for that
// during a single action." Legacy macro hides armor mid-combat too.

import { log, warn } from "./logger.js";

const UNARM_STRIKE_ITEM_ID = "bwqZvS4NXw7bCrmV";

const ITEM_TYPE_WEAPON    = "weapon";
const ITEM_TYPE_SHIELD    = "shield";
const ITEM_TYPE_ACCESSORY = "accessory";

// RAW Core p.???: shields can only be equipped in the OFF-hand slot.
// Dual Shieldbearer (Guardian Skill) relaxes this — owners may equip a
// shield in the main hand as well. Author-side gate read on both the
// UI (filter main-slot candidates) and the apply-side (reject stale
// submissions). Defaults to "no" → main-hand-shield blocked unless the
// actor owns the named skill.
const DSB_SKILL_NAME = "Dual Shieldbearer";
function actorOwnsDualShieldbearer(actor) {
  const items = actor?.items?.contents ?? (Array.isArray(actor?.items) ? actor.items : []);
  for (const item of items) {
    if (String(item?.name ?? "").trim() === DSB_SKILL_NAME) return true;
  }
  return false;
}

// Pull every equipment-relevant item off the actor, grouped by category.
function partitionInventory(actor) {
  const all = Array.from(actor?.items ?? []);
  return {
    weapons:     all.filter((i) => i?.system?.props?.item_type === ITEM_TYPE_WEAPON),
    shields:     all.filter((i) => i?.system?.props?.item_type === ITEM_TYPE_SHIELD),
    accessories: all.filter((i) => i?.system?.props?.item_type === ITEM_TYPE_ACCESSORY),
  };
}

// Find the index of the currently-equipped item by name match against
// `actor.system.props[propName]`. Returns -1 if not found.
function indexByEquippedName(items, equippedName) {
  if (!equippedName) return -1;
  return items.findIndex((it) => it?.system?.props?.name === equippedName);
}

// Public: gather everything the Equipment card needs to render the
// 4 slots (Main, Off, Acc 1, Acc 2) with current selection + candidates.
//
// Shape:
//   {
//     slots: [
//       { key: "main"|"off"|"accessory1"|"accessory2",
//         label: "Main Hand"|...,
//         currentItemId: string|null,
//         currentName: string,
//         candidates: [
//           { id, name, img, typeIcon, category: "weapon"|"shield"|"accessory",
//             element: string|null,     // damage type (Fire/Physical/…) — weapons only
//             weaponType: string|null,  // sword/bow/brawling/… — weapons only
//             attackStat: string|null,  // "DEX+INS" — weapons only
//             defenseLine: string|null, // "DEF +1 • MDEF +1" — shields only
//             isTwoHanded: bool,        // true when hand_slots === "Two-handed"
//             checkBonus: number,       // weapons only — accuracy modifier
//             damageBonus: number,      // weapons only — damage modifier
//             description: string       // raw HTML, surfaced via tooltip
//           }, ...
//         ]
//       }, ...
//     ],
//     hasUnarmed: bool,
//   }
function buildHandCandidate(it) {
  const p = it.system?.props ?? {};
  const isShield = p.item_type === ITEM_TYPE_SHIELD;
  // `hand_slots` is a string ("One-handed" / "Two-handed") per the
  // [Item] template — see Game Object/Template/[Item] Blazing Sword.json.
  // Match case-insensitively + on the substring "two" so any locale or
  // capitalisation variant still trips the flag.
  const handSlotsRaw = String(p.hand_slots ?? "").trim();
  const isTwoHanded = !isShield && handSlotsRaw.toLowerCase().includes("two");
  const base = {
    id: it.id,
    name: p.name ?? it.name ?? "(unnamed)",
    img: it.img ?? null,
    category: p.item_type ?? "weapon",
    typeIcon: isShield ? "🛡️" : "⚔️",
    element: null,
    weaponType: null,
    weaponRange: null,
    handSlots: null,
    isMartial: false,
    rarity: null,
    attackStat: null,
    defenseLine: null,
    isTwoHanded,
    checkBonus: 0,
    damageBonus: 0,
    description: String(p.description ?? ""),
  };
  if (isShield) {
    const def  = Number(p.item_def_bonus ?? 0)  || 0;
    const mdef = Number(p.item_mdef_bonus ?? 0) || 0;
    base.defenseLine = `DEF ${def >= 0 ? "+" : ""}${def} • MDEF ${mdef >= 0 ? "+" : ""}${mdef}`;
    base.handSlots = handSlotsRaw || null;
    base.rarity    = String(p.item_rarity ?? "") || null;
  } else {
    base.element     = String(p.type_damage ?? "Physical");
    // CSB stores weapon class in `category` (Arcane / Bow / Spear / Sword …);
    // legacy world data sometimes has `weapon_type` or `type` instead.
    base.weaponType  = String(p.category ?? p.weapon_type ?? p.type ?? "");
    base.weaponRange = String(p.weapon_range ?? "") || null;
    base.handSlots   = handSlotsRaw || null;
    base.isMartial   = !!p.isMartial;
    base.rarity      = String(p.item_rarity ?? "") || null;
    base.checkBonus  = Number(p.check_bonus ?? 0)  || 0;
    base.damageBonus = Number(p.damage_bonus ?? 0) || 0;
    const a1 = String(p.rolled_atr1 ?? "").toUpperCase();
    const a2 = String(p.rolled_atr2 ?? "").toUpperCase();
    base.attackStat = a1 && a2 ? `${a1} + ${a2}` : (a1 || a2 || null);
  }
  return base;
}
function buildAccCandidate(it) {
  const p = it.system?.props ?? {};
  return {
    id: it.id,
    name: p.name ?? it.name ?? "(unnamed)",
    img: it.img ?? null,
    category: "accessory",
    typeIcon: "🔮",
    element: null,
    weaponType: null,
    attackStat: null,
    defenseLine: null,
    isTwoHanded: false,
    description: String(p.description ?? ""),
  };
}

export function gatherEquipmentSlots(actor) {
  if (!actor) return { slots: [], hasUnarmed: false };

  const { weapons, shields, accessories } = partitionInventory(actor);
  const handItems = [...weapons, ...shields];

  const props = actor.system?.props ?? {};
  const mainEquipped = props.main_hand ?? "";
  const offEquipped  = props.off_hand ?? "";
  const acc1Equipped = props.accessory_name ?? "";
  const acc2Equipped = props.accessory2_name ?? "";

  // Main-hand-shield gate. RAW: shields are off-hand by default; the
  // Dual Shieldbearer skill relaxes the rule for owners. UI hides
  // shields from the main slot's candidate list when the actor doesn't
  // own the skill. applyEquipmentSwap repeats the check authoritatively.
  const allowShieldInMain = actorOwnsDualShieldbearer(actor);
  const mainHandItems = allowShieldInMain
    ? handItems
    : handItems.filter((i) => i?.system?.props?.item_type !== ITEM_TYPE_SHIELD);
  const mainHandCandidates = mainHandItems.map(buildHandCandidate);
  const offHandCandidates  = handItems.map(buildHandCandidate);
  const accCandidates      = accessories.map(buildAccCandidate);

  const mainIdx = indexByEquippedName(handItems, mainEquipped);
  const offIdx  = indexByEquippedName(handItems, offEquipped);
  const acc1Idx = indexByEquippedName(accessories, acc1Equipped);
  const acc2Idx = indexByEquippedName(accessories, acc2Equipped);

  return {
    slots: [
      {
        key: "main", label: "Main Hand",
        currentItemId: mainIdx >= 0 ? handItems[mainIdx].id : null,
        currentName: mainIdx >= 0 ? handItems[mainIdx].system?.props?.name : "Unarmed",
        candidates: mainHandCandidates,
      },
      {
        key: "off", label: "Off Hand",
        currentItemId: offIdx >= 0 ? handItems[offIdx].id : null,
        currentName: offIdx >= 0 ? handItems[offIdx].system?.props?.name : "Unarmed",
        candidates: offHandCandidates,
      },
      {
        key: "accessory1", label: "Accessory",
        currentItemId: acc1Idx >= 0 ? accessories[acc1Idx].id : null,
        currentName: acc1Idx >= 0 ? accessories[acc1Idx].system?.props?.name : "—",
        candidates: accCandidates,
      },
      {
        key: "accessory2", label: "Accessory 2",
        currentItemId: acc2Idx >= 0 ? accessories[acc2Idx].id : null,
        currentName: acc2Idx >= 0 ? accessories[acc2Idx].system?.props?.name : "—",
        candidates: accCandidates,
      },
    ],
    hasUnarmed: true,
  };
}

// ─── Active Effect sync helpers (mirrors legacy queueItemEffectState) ──

function unpackContainer(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [];
}

function getConfiguredItemEffectRefs(item) {
  return [
    ...unpackContainer(item?.system?.props?.item_activeEffect),
    ...unpackContainer(item?.system?.item_activeEffect),
    ...unpackContainer(item?.item_activeEffect),
  ].filter(Boolean);
}

function findOwnedEffectMatch(item, ref) {
  const all = item?.effects?.contents ?? [];
  if (!all.length || !ref) return null;
  const directId = ref._id ?? ref.id ?? null;
  if (directId && item.effects?.get(directId)) return item.effects.get(directId);

  const refFlags = ref.flags?.["custom-system-builder"] ?? {};
  const refOriginalId   = refFlags.originalId   ?? ref.originalId   ?? null;
  const refOriginalUuid = refFlags.originalUuid ?? ref.originalUuid ?? null;
  if (refOriginalId) {
    const m = all.find((fx) => (fx.flags?.["custom-system-builder"]?.originalId ?? null) === refOriginalId);
    if (m) return m;
  }
  if (refOriginalUuid) {
    const m = all.find((fx) => (fx.flags?.["custom-system-builder"]?.originalUuid ?? null) === refOriginalUuid);
    if (m) return m;
  }
  const refName = String(ref.name ?? "").trim().toLowerCase();
  if (refName) {
    const m = all.find((fx) => String(fx.name ?? "").trim().toLowerCase() === refName);
    if (m) return m;
  }
  return null;
}

function resolveItemEffectDocs(item) {
  const owned = item?.effects?.contents ?? [];
  if (!owned.length) return [];
  const refs = getConfiguredItemEffectRefs(item);
  if (!refs.length) return owned;
  const out = new Map();
  for (const ref of refs) {
    const live = findOwnedEffectMatch(item, ref);
    if (live) out.set(live.id, live);
  }
  return out.size ? [...out.values()] : owned;
}

// ─── Public: apply the swap ─────────────────────────────────────────

// `selections` = { main: itemIdOrNull, off: itemIdOrNull,
//                  accessory1: itemIdOrNull, accessory2: itemIdOrNull }
//
// Compares against the actor's current equipped state, builds the same
// three commit batches the legacy macro does (item updates, item-AE
// updates, actor update), and applies them in the legacy's safe order:
// items → AEs → actor.
//
// Returns a summary { changes: [...], skipped: bool }.
export async function applyEquipmentSwap(actor, selections) {
  if (!actor) { warn("applyEquipmentSwap: no actor"); return { changes: [], skipped: true }; }
  if (!selections || typeof selections !== "object") {
    warn("applyEquipmentSwap: no selections");
    return { changes: [], skipped: true };
  }

  const { weapons, shields, accessories } = partitionInventory(actor);
  const handItems = [...weapons, ...shields];

  const findById = (list, id) => id ? list.find((it) => it.id === id) ?? null : null;

  // Resolve the desired items per slot from the IDs supplied by the card.
  // Null = nothing equipped in that slot (empty hand / no accessory).
  let wantMain = findById(handItems, selections.main);
  const wantOff  = findById(handItems, selections.off);
  const wantAcc1 = findById(accessories, selections.accessory1);
  const wantAcc2 = findById(accessories, selections.accessory2);

  // Main-hand-shield gate. Authoritative rejection: even if the UI
  // somehow let a stale client submit a shield for the main slot, only
  // Dual Shieldbearer owners may actually equip one there. Drop the
  // attempt + notify; the swap proceeds with main untouched (curMain
  // stays equipped).
  if (wantMain?.system?.props?.item_type === ITEM_TYPE_SHIELD
      && !actorOwnsDualShieldbearer(actor)) {
    warn(`applyEquipmentSwap: ${actor.name} cannot equip shield "${wantMain.name}" in main hand without Dual Shieldbearer — dropped.`);
    try { ui.notifications?.warn(`${actor.name} cannot equip a shield in the main hand without the Dual Shieldbearer skill.`); } catch {}
    wantMain = findById(handItems, indexByEquippedName(handItems, actor.system?.props?.main_hand) >= 0
      ? handItems[indexByEquippedName(handItems, actor.system?.props?.main_hand)].id
      : null);
  }

  const props = actor.system?.props ?? {};
  const curMain = findById(handItems, indexByEquippedName(handItems, props.main_hand) >= 0 ? handItems[indexByEquippedName(handItems, props.main_hand)].id : null);
  const curOff  = findById(handItems, indexByEquippedName(handItems, props.off_hand)  >= 0 ? handItems[indexByEquippedName(handItems, props.off_hand)].id  : null);
  const curAcc1 = findById(accessories, indexByEquippedName(accessories, props.accessory_name)  >= 0 ? accessories[indexByEquippedName(accessories, props.accessory_name)].id  : null);
  const curAcc2 = findById(accessories, indexByEquippedName(accessories, props.accessory2_name) >= 0 ? accessories[indexByEquippedName(accessories, props.accessory2_name)].id : null);

  const actorUpdates = {};
  const itemUpdateMap = new Map();   // itemId → { _id, ...patch }
  const aeUpdateMap   = new Map();   // itemId → Map(effectId → { _id, disabled })
  const changes = [];

  const addItemPatch = (id, key, value) => {
    if (!id) return;
    const cur = itemUpdateMap.get(id) ?? { _id: id };
    cur[key] = value;
    itemUpdateMap.set(id, cur);
  };
  const queueEffectSync = (item, shouldEnable) => {
    if (!item?.id) return;
    const docs = resolveItemEffectDocs(item);
    if (!docs.length) return;
    const desiredDisabled = !shouldEnable;
    let bucket = aeUpdateMap.get(item.id);
    for (const fx of docs) {
      if (!!fx.disabled === desiredDisabled) continue;
      if (!bucket) { bucket = new Map(); aeUpdateMap.set(item.id, bucket); }
      const cur = bucket.get(fx.id) ?? { _id: fx.id };
      cur.disabled = desiredDisabled;
      bucket.set(fx.id, cur);
    }
  };

  // Per-slot diff + actor-level field writes (mirrors legacy applyHand /
  // accessory slot loop in [Macro] Equipment.js).
  const applyHandSlot = ({ slotName, curItem, newItem, isMain }) => {
    if ((curItem?.id ?? null) === (newItem?.id ?? null)) return;
    const isWeapon = newItem?.system?.props?.item_type === ITEM_TYPE_WEAPON;
    const np = newItem?.system?.props ?? {};
    if (isMain) {
      actorUpdates["system.props.main_hand"]            = np.name ?? "";
      actorUpdates["system.props.main_attrib_1"]        = isWeapon ? (np.rolled_atr1 ?? "DEX") : "SHI";
      actorUpdates["system.props.main_attrib_2"]        = isWeapon ? (np.rolled_atr2 ?? "DEX") : "SHI";
      actorUpdates["system.props.weapon1_base_mod"]     = isWeapon ? (np.check_bonus ?? 0)  : (np.item_def_bonus ?? 0);
      actorUpdates["system.props.weapon1_base_damage"]  = isWeapon ? (np.damage_bonus ?? 0) : (np.item_mdef_bonus ?? 0);
      actorUpdates["system.props.weapon1_damagetype"]   = isWeapon ? (np.type_damage ?? "Physical") : "-";
      actorUpdates["system.props.main_details"]         = np.description ?? "";
    } else {
      actorUpdates["system.props.off_hand"]             = np.name ?? "";
      actorUpdates["system.props.off_attrib_1"]         = isWeapon ? (np.rolled_atr1 ?? "DEX") : "SHI";
      actorUpdates["system.props.off_attrib_2"]         = isWeapon ? (np.rolled_atr2 ?? "DEX") : "SHI";
      actorUpdates["system.props.off_base_mod_1"]       = isWeapon ? (np.check_bonus ?? 0)  : (np.item_def_bonus ?? 0);
      actorUpdates["system.props.off_base_mod_2"]       = isWeapon ? (np.damage_bonus ?? 0) : (np.item_mdef_bonus ?? 0);
      actorUpdates["system.props.weapon2_damagetype"]   = isWeapon ? (np.type_damage ?? "Physical") : "-";
      actorUpdates["system.props.off_details"]          = np.description ?? "";
    }
    changes.push({
      slot: slotName,
      fromName: curItem?.system?.props?.name ?? "Unarmed",
      toName:   newItem?.system?.props?.name ?? "Unarmed",
      icon: isWeapon ? "⚔️" : (newItem ? "🛡️" : "✋"),
    });
  };
  const applyAccSlot = ({ slotName, curItem, newItem, propBase }) => {
    if ((curItem?.id ?? null) === (newItem?.id ?? null)) return;
    const np = newItem?.system?.props ?? {};
    actorUpdates[`system.props.${propBase}_name`]    = np.name ?? "";
    actorUpdates[`system.props.${propBase}_details`] = np.description ?? "";
    changes.push({
      slot: slotName,
      fromName: curItem?.system?.props?.name ?? "—",
      toName:   newItem?.system?.props?.name ?? "—",
      icon: "🔮",
    });
  };

  applyHandSlot({ slotName: "Main Hand",   curItem: curMain, newItem: wantMain, isMain: true  });
  applyHandSlot({ slotName: "Off Hand",    curItem: curOff,  newItem: wantOff,  isMain: false });
  applyAccSlot({  slotName: "Accessory",   curItem: curAcc1, newItem: wantAcc1, propBase: "accessory"  });
  applyAccSlot({  slotName: "Accessory 2", curItem: curAcc2, newItem: wantAcc2, propBase: "accessory2" });

  // isEquipped toggles + AE sync — mirrors legacy. Each item that's now
  // worn gets isEquipped=true; each item no longer worn gets false.
  const desiredHandIds = new Set([wantMain?.id, wantOff?.id].filter(Boolean));
  for (const item of handItems) {
    const cur = !!item.system?.props?.isEquipped;
    const next = desiredHandIds.has(item.id);
    if (cur !== next) addItemPatch(item.id, "system.props.isEquipped", next);
    queueEffectSync(item, next);
  }
  const desiredAccIds = new Set([wantAcc1?.id, wantAcc2?.id].filter(Boolean));
  for (const acc of accessories) {
    const cur = !!acc.system?.props?.isEquipped;
    const next = desiredAccIds.has(acc.id);
    if (cur !== next) addItemPatch(acc.id, "system.props.isEquipped", next);
    queueEffectSync(acc, next);
  }

  if (!changes.length) {
    return { changes: [], skipped: true };
  }

  // Commit order matters (legacy comment at top of macro): items first
  // so isEquipped is in place when AE-disabled flips read it; effects
  // second so the actor-update finds the new derived stats; actor third.
  try {
    const embeddedItemUpdates = Array.from(itemUpdateMap.values());
    if (embeddedItemUpdates.length) {
      await actor.updateEmbeddedDocuments("Item", embeddedItemUpdates);
    }
  } catch (e) {
    warn("applyEquipmentSwap: item updates failed", e);
  }
  for (const [itemId, fxMap] of aeUpdateMap) {
    const item = actor.items?.get?.(itemId);
    if (!item) continue;
    try {
      await item.updateEmbeddedDocuments("ActiveEffect", [...fxMap.values()]);
    } catch (e) {
      warn(`applyEquipmentSwap: AE updates failed for ${item.name}`, e);
    }
  }
  if (Object.keys(actorUpdates).length) {
    try {
      await actor.update(actorUpdates);
    } catch (e) {
      warn("applyEquipmentSwap: actor.update failed", e);
    }
  }

  log(`Equipment swap applied (${changes.length} change${changes.length === 1 ? "" : "s"}) for ${actor.name}`);
  return { changes, skipped: false };
}

// ─── Public: reconcile isEquipped to the slots ──────────────────────────
//
// Repair helper for the equip dual-source-of-truth. The actor's hand/accessory
// SLOT props (main_hand / off_hand / accessory_name / accessory2_name) are the
// source of truth for "what's worn" — resolveAttackerWeapon + the sheet read
// them. The per-item `isEquipped` boolean is a SEPARATE flag that loadout
// formula gates read (HAS_RANGED_WEAPON / HAS_SHIELD / HAS_MARTIAL_ARMOR / …).
// They DESYNC whenever equip state is mutated outside applyEquipmentSwap —
// cloning an actor, bulk item add (the Test Battle dev tool), raw writes,
// migrations — which silently breaks those gates (e.g. a worn-by-slot weapon
// whose isEquipped is false → HAS_RANGED_WEAPON returns 0).
//
// This drives isEquipped (+ item-resident AE enable) FROM the slots WITHOUT
// changing the slots, healing the drift. Idempotent; returns { changed }. Run
// on actor create/clone, after bulk item edits, or as a repair sweep. (To
// CHANGE what's worn, call applyEquipmentSwap instead — this only reconciles.)
export async function reconcileEquip(actor) {
  if (!actor) return { changed: 0 };
  const { weapons, shields, accessories } = partitionInventory(actor);
  const handItems = [...weapons, ...shields];
  const props = actor.system?.props ?? {};

  const wornHandIds = new Set();
  for (const slot of ["main_hand", "off_hand"]) {
    const idx = indexByEquippedName(handItems, props[slot]);
    if (idx >= 0) wornHandIds.add(handItems[idx].id);
  }
  const wornAccIds = new Set();
  for (const slot of ["accessory_name", "accessory2_name"]) {
    const idx = indexByEquippedName(accessories, props[slot]);
    if (idx >= 0) wornAccIds.add(accessories[idx].id);
  }

  const itemUpdates = [];
  const aeWork = [];
  const sync = (item, worn) => {
    if (!!item.system?.props?.isEquipped !== worn) {
      itemUpdates.push({ _id: item.id, "system.props.isEquipped": worn });
      aeWork.push({ itemId: item.id, enable: worn });
    }
  };
  for (const it of handItems) sync(it, wornHandIds.has(it.id));
  for (const ac of accessories) sync(ac, wornAccIds.has(ac.id));

  if (!itemUpdates.length) return { changed: 0 };
  try { await actor.updateEmbeddedDocuments("Item", itemUpdates); }
  catch (e) { warn("reconcileEquip: item updates failed", e); }

  // Item-resident AE enable/disable, mirroring applyEquipmentSwap's sync.
  for (const { itemId, enable } of aeWork) {
    const item = actor.items?.get?.(itemId);
    if (!item) continue;
    const docs = resolveItemEffectDocs(item);
    const fxUpdates = docs
      .filter((fx) => !!fx.disabled === enable)   // currently wrong-way → flip
      .map((fx) => ({ _id: fx.id, disabled: !enable }));
    if (fxUpdates.length) {
      try { await item.updateEmbeddedDocuments("ActiveEffect", fxUpdates); }
      catch (e) { warn(`reconcileEquip: AE sync failed for ${item.name}`, e); }
    }
  }
  log(`reconcileEquip: synced ${itemUpdates.length} item(s) to slots on ${actor.name}`);
  return { changed: itemUpdates.length };
}
