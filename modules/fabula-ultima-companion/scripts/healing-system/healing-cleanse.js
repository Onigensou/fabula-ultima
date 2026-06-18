// ============================================================================
// Out-of-Combat Healing — debuff cleanse registry (HARDCODED, interim).
//
// The game has no universal "this action cleanses a debuff" API yet, so we
// recognise specific known cleansing actions by id/name here.
//
//   TODO: when a universal cleanse-definition API exists (e.g. an effect-table
//   `cleanse` kind, or a skill flag), replace this whole registry with a lookup
//   against that API and delete the hardcoded list.
//
// scope:  "one" → removes a single status (debuff picker; auto-resolves when the
//                  target has exactly one). "all" → removes every debuff.
// target: "single" | "all"  (tonics carry no skill_target, so it's pinned here;
//          the Cleanse spell is "up to three" but we treat up-to as single).
// ============================================================================

import { HEAL_TAG } from "./healing-const.js";

const _DEFS = [
  { uuid: "Item.ZO0vkyhHeR2pR4QH", name: "Tonic",       scope: "one", target: "single" },
  { uuid: "Item.ky7HMdQIZBJxlPqx", name: "Super Tonic", scope: "all", target: "single" },
  { uuid: "Item.a9elI6g2FZ6qPY51", name: "Turbo Tonic", scope: "all", target: "all" },
  { uuid: "Item.u2lw7vPFH9QikB7X", name: "Cleanse",     scope: "one", target: "single" },
];

export const CLEANSE_REGISTRY = new Map(_DEFS.map((d) => [d.uuid, d]));
const CLEANSE_BY_NAME = new Map(_DEFS.map((d) => [d.name.toLowerCase(), d]));

// Resolve cleanse info for an item (live doc OR a uuid string). Owned consumable
// copies have actor-scoped uuids that differ from the world-item ids, so we also
// match by core.sourceId and by name.
export function getCleanseInfoForItem(item) {
  if (!item) return null;
  if (typeof item === "string") return CLEANSE_REGISTRY.get(item) ?? null;
  const byUuid = CLEANSE_REGISTRY.get(item.uuid);
  if (byUuid) return byUuid;
  const src = item.flags?.core?.sourceId ?? item._stats?.compendiumSource ?? null;
  if (src && CLEANSE_REGISTRY.get(src)) return CLEANSE_REGISTRY.get(src);
  const byName = CLEANSE_BY_NAME.get(String(item.name ?? "").trim().toLowerCase());
  return byName ?? null;
}

export function isCleanseAction(item) {
  return !!getCleanseInfoForItem(item);
}

// ── Debuff detection (shared by the HUD + GM apply) ─────────────────────────
// An ActiveEffect is a debuff when any tag source contains "debuff" (verified
// live: Dazed carries system.tags + tags === ["debuff"]). Disabled effects skip.
export function isDebuffEffect(e) {
  if (!e || e.disabled) return false;
  const f = e.flags ?? {};
  const tags = [
    ...(Array.isArray(e.system?.tags) ? e.system.tags : []),
    ...(Array.isArray(e.tags) ? e.tags : []),
    ...(Array.isArray(f["fabula-ultima-companion"]?.tags) ? f["fabula-ultima-companion"].tags : []),
    ...(Array.isArray(f["custom-system-builder"]?.tags) ? f["custom-system-builder"].tags : []),
  ].map((t) => String(t).toLowerCase());
  return tags.includes("debuff");
}

export function actorDebuffs(actor) {
  return (actor?.effects?.contents ?? actor?.effects ?? []).filter(isDebuffEffect);
}

console.debug(HEAL_TAG, `cleanse registry loaded (${_DEFS.length} hardcoded actions)`);
