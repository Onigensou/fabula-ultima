// scripts/orbment/orbment-api.js
//
// Public API for the Equipment Orbment system, exposed at
//   FUCompanion.api.orbment.{ install, remove, recompile, list, listAugments, openWindow }
//
// v1 is GM-driven: install/remove mutate world item flags + recompile, so they
// require a GM. Read paths (list/listAugments) are open. The compiler does the
// heavy lifting; this layer is validation + a thin ergonomic surface for the UI.

import { FLAG_NS, ORBMENT_FLAG, readOrbment, slotCountOf, itemKindOf } from "./orbment-const.js";
import { getAugment, augmentsForItemType } from "./augment-registry.js";
import { recompileOrbment } from "./orbment-compiler.js";

const TAG = "[Orbment]";

const EQUIPPABLE_KINDS = new Set(["weapon", "armor", "shield"]);

async function resolveItem(itemOrUuid) {
  if (itemOrUuid && typeof itemOrUuid === "object" && itemOrUuid.documentName === "Item") return itemOrUuid;
  const doc = await fromUuid(String(itemOrUuid)).catch(() => null);
  return doc?.documentName === "Item" ? doc : null;
}

function assertGM() {
  if (!game.user?.isGM) throw new Error("Orbment: GM only (v1).");
}

function validateItem(item) {
  if (!item) throw new Error("Orbment: item not found.");
  if (!item.parent) throw new Error("Orbment: item must belong to an actor.");
  const kind = itemKindOf(item);
  if (!EQUIPPABLE_KINDS.has(kind)) throw new Error(`Orbment: "${item.name}" is not equippable (item_type="${kind}").`);
  return kind;
}

// Persist a new slots array on the item then recompile (which mirrors + projects).
async function setSlotsAndCompile(item, slots) {
  await item.update({ [`flags.${FLAG_NS}.${ORBMENT_FLAG}.slots`]: slots });
  return recompileOrbment(item);
}

// ── install(itemOrUuid, slotIndex, augmentId) ─────────────────────────────────
export async function install(itemOrUuid, slotIndex, augmentId) {
  assertGM();
  const item = await resolveItem(itemOrUuid);
  const kind = validateItem(item);

  const idx = Number(slotIndex);
  const count = slotCountOf(item);
  if (!Number.isInteger(idx) || idx < 0 || idx >= count)
    throw new Error(`Orbment: slot ${slotIndex} out of range (item has ${count} slot(s)).`);

  const augment = getAugment(augmentId);
  if (!augment) throw new Error(`Orbment: unknown augment "${augmentId}".`);
  if (!augment.appliesTo.includes(kind))
    throw new Error(`Orbment: "${augment.label}" cannot go on a ${kind}.`);

  const orb = readOrbment(item);
  // Disallow the same augment in two slots (RAW: an item can't gain a Quality it
  // already has). Re-installing into its OWN slot is a no-op-ish refresh.
  const dupeSlot = orb.slots.findIndex((s, i) => s === augmentId && i !== idx);
  if (dupeSlot !== -1)
    throw new Error(`Orbment: "${augment.label}" is already installed in slot ${dupeSlot + 1}.`);

  const slots = orb.slots.slice();
  slots[idx] = augmentId;
  const res = await setSlotsAndCompile(item, slots);
  try { ui.notifications?.info(`Installed ${augment.label} into ${item.name} (slot ${idx + 1}).`); } catch {}
  console.debug(TAG, "install", { item: item.name, idx, augmentId, res });
  return res;
}

// ── remove(itemOrUuid, slotIndex) ─────────────────────────────────────────────
export async function remove(itemOrUuid, slotIndex) {
  assertGM();
  const item = await resolveItem(itemOrUuid);
  validateItem(item);
  const idx = Number(slotIndex);
  const orb = readOrbment(item);
  if (!Number.isInteger(idx) || idx < 0 || idx >= orb.slots.length)
    throw new Error(`Orbment: slot ${slotIndex} out of range.`);

  const prev = orb.slots[idx];
  const slots = orb.slots.slice();
  slots[idx] = null;
  const res = await setSlotsAndCompile(item, slots);
  try {
    const a = getAugment(prev);
    if (a) ui.notifications?.info(`Removed ${a.label} from ${item.name} (slot ${idx + 1}).`);
  } catch {}
  return res;
}

// ── recompile(itemOrUuid) — force a reconcile (repair / after rarity change) ──
export async function recompile(itemOrUuid) {
  assertGM();
  const item = await resolveItem(itemOrUuid);
  validateItem(item);
  return recompileOrbment(item);
}

// ── list(itemOrUuid) — full state for the UI (read-only, no GM gate) ──────────
export async function list(itemOrUuid) {
  const item = await resolveItem(itemOrUuid);
  if (!item) return null;
  const kind = itemKindOf(item);
  const orb = readOrbment(item);
  return {
    itemId: item.id,
    itemUuid: item.uuid,
    itemName: item.name,
    itemType: kind,
    rarity: String(item.system?.props?.item_rarity ?? ""),
    slotCount: slotCountOf(item),
    slots: orb.slots.map((id) => {
      const a = getAugment(id);
      return a ? { id: a.id, label: a.label, icon: a.icon, summary: a.summary, cost: a.cost } : null;
    }),
    linkGroup: orb.linkGroup ?? [item.id],
    available: augmentsForItemType(kind).map((a) => ({
      id: a.id, label: a.label, icon: a.icon, summary: a.summary, cost: a.cost, kind: a.props ? "prop" : a.rider ? "rider" : "stat",
    })),
  };
}

// ── listAugments(itemType) — registry slice ───────────────────────────────────
export function listAugments(itemType) {
  return augmentsForItemType(itemType).map((a) => ({
    id: a.id, label: a.label, icon: a.icon, summary: a.summary, ruleText: a.ruleText, cost: a.cost,
    appliesTo: a.appliesTo.slice(),
  }));
}

// ── openWindow(itemOrUuid) — lazy-load the UI ─────────────────────────────────
export async function openWindow(itemOrUuid) {
  const item = await resolveItem(itemOrUuid);
  if (!item) { ui.notifications?.warn("Orbment: item not found."); return null; }
  const mod = await import("./orbment-window.js");
  return mod.OrbmentWindow.open(item.uuid);
}

// Register onto FUCompanion.api.orbment (idempotent).
export function registerOrbmentApi() {
  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  const api = (root.api = root.api ?? {});
  api.orbment = { install, remove, recompile, list, listAugments, openWindow };
  console.debug(TAG, "API registered at FUCompanion.api.orbment");
  return api.orbment;
}
