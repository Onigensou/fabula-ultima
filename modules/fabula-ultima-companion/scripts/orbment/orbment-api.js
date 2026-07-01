// scripts/orbment/orbment-api.js
//
// Public API for the Equipment Orbment system, exposed at
//   FUCompanion.api.orbment.{ install, remove, recompile, list, listAugments, openWindow }
//
// v1 is GM-driven: install/remove mutate world item flags + recompile, so they
// require a GM. Read paths (list/listAugments) are open. The compiler does the
// heavy lifting; this layer is validation + a thin ergonomic surface for the UI.

import { FLAG_NS, ORBMENT_FLAG, readOrbment, slotCountOf, itemKindOf } from "./orbment-const.js";
import { getAugment, augmentsForItemType, resolveAugment } from "./augment-registry.js";
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

// Read/clamp an actor's Zenit (currency lives at system.props.zenit).
function readZenit(actor) { return Math.max(0, Number(actor?.system?.props?.zenit ?? 0)); }

// ── install(itemOrUuid, slotIndex, augmentId, options?) ───────────────────────
// options.deductZenit (default TRUE): charge the augment's RAW cost from the
// carrying actor's Zenit, blocking if they can't afford it — the NORMAL gameplay
// path (shop / game system). Pass `{ deductZenit: false }` for the GM MANUAL
// backstage edit: modify orbment freely without touching actor Zenit.
export async function install(itemOrUuid, slotIndex, augmentId, options = {}) {
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
  if (augment.pending)
    throw new Error(`Orbment: "${augment.label}" is in the catalog but its automation isn't wired yet.`);

  // Parameterized augments ("choose one") require a valid param value.
  let param = options.param ?? null;
  if (augment.param) {
    const valid = augment.param.options.some((o) => o.value === param);
    if (!valid) throw new Error(`Orbment: "${augment.label}" needs a choice — pick one of its options.`);
  } else {
    param = null; // ignore any stray param on a non-parameterized augment
  }
  const view = resolveAugment(augmentId, param);

  const orb = readOrbment(item);
  // Disallow the exact same augment+choice in two slots (RAW: an item can't gain
  // a Quality it already has). Different choices of the same augment are allowed
  // (e.g. Resistance: Fire and Resistance: Ice).
  const dupeSlot = orb.slots.findIndex((s, i) => s && s.id === augmentId && (s.param ?? null) === param && i !== idx);
  if (dupeSlot !== -1)
    throw new Error(`Orbment: "${view.label}" is already installed in slot ${dupeSlot + 1}.`);

  // Zenit economy. Default = deduct (normal gameplay); GM manual passes false.
  const deductZenit = options.deductZenit !== false;
  const actor = item.parent;
  const cost = Math.max(0, Number(augment.cost ?? 0));
  if (deductZenit && cost > 0) {
    const have = readZenit(actor);
    if (have < cost)
      throw new Error(`Orbment: ${actor.name} can't afford ${augment.label} (need ${cost} z, have ${have} z).`);
  }

  const slots = orb.slots.slice();
  slots[idx] = { id: augmentId, param };
  const res = await setSlotsAndCompile(item, slots);

  // Charge AFTER a successful compile so a failed install never bills the actor.
  if (deductZenit && cost > 0) {
    try { await actor.update({ "system.props.zenit": readZenit(actor) - cost }); }
    catch (e) { console.warn(TAG, "zenit deduct failed", e); }
  }

  try {
    const note = deductZenit && cost > 0 ? ` (−${cost} z)` : " (no charge)";
    ui.notifications?.info(`Installed ${view.label} into ${item.name}, slot ${idx + 1}${note}.`);
  } catch {}
  console.debug(TAG, "install", { item: item.name, idx, augmentId, param, deductZenit, cost, res });
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
    const v = prev ? resolveAugment(prev.id, prev.param) : null;
    if (v) ui.notifications?.info(`Removed ${v.label} from ${item.name} (slot ${idx + 1}).`);
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
    actorName: item.parent?.name ?? "",
    actorZenit: readZenit(item.parent),
    slotCount: slotCountOf(item),
    slots: orb.slots.map((slot) => {
      if (!slot) return null;
      const v = resolveAugment(slot.id, slot.param);
      return v ? { id: v.id, param: v.param, label: v.label, icon: v.icon, summary: v.summary, cost: v.cost } : null;
    }),
    linkGroup: orb.linkGroup ?? [item.id],
    available: augmentsForItemType(kind).map((a) => ({
      id: a.id, label: a.label, icon: a.icon, summary: a.summary, cost: a.cost,
      category: a.category ?? "", pending: !!a.pending,
      // Parameterized augments expose their picker options ("choose one").
      param: a.param ? { prompt: a.param.prompt, options: a.param.options } : null,
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
