// Equipment SET BONUSES — generic, data-driven.
//
// Some gear belongs to a "set" and grants an extra bonus once you wear enough
// pieces (e.g. the aquatic set: Swimsuit + Diver Goggle → 2-piece "you're always
// Wet"). This engine is the single mechanism behind all such bonuses.
//
// Two pieces of data, no per-set engine code:
//   1. MEMBERSHIP — authored entirely in CSB on the item sheet: tick `isSet` and
//      type the set's name into `set_name` (e.g. "Swift Swimmers"). The engine
//      groups equipped pieces by that name. ("<Set Name>" is the CSB empty
//      sentinel and is ignored.) No flags, no code — just the item sheet.
//   2. BONUSES — SET_BONUS_REGISTRY below maps the CSB `set_name` →
//      { <pieceCount>: <aeSpec> }. (CSB only stores the human-readable
//      `set_description`; the structured EFFECT — threshold + statuses/changes —
//      lives here.) Adding a set = author set_name/isSet on its items + add one
//      registry entry keyed by the same set_name string.
//
// On every equip reconcile (applyEquipmentSwap / reconcileEquip),
// `reconcileSetBonuses(actor)` counts equipped pieces per set and applies/removes
// a MANAGED bonus AE for each met threshold. Managed AEs are tagged
// flags["fabula-ultima-companion"].setBonus = "<setId>:<pieces>" so they are
// synced idempotently (never duplicated, removed the moment the threshold drops).
// The bonus AE is a normal actor AE — its `statuses` apply conditions (Wet) and
// its `changes` feed the same derivation as any other AE, so existing
// Wet-conditional gear (Swift Swimmer, Diver Goggle's +3 Acc) lights up for free.

import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";

// The CSB `set_name` empty-field sentinel — ignore items still showing it.
const SET_NAME_EMPTY = "<Set Name>";

// CSB `set_name` → { pieceThreshold: aeSpec }. aeSpec = { name, statuses?, changes? }.
// `statuses` apply a condition (e.g. "wet"); `changes` are standard AE changes.
// Key MUST match the item sheet's `set_name` exactly.
export const SET_BONUS_REGISTRY = {
  // Swift Swimmers: Swimsuit (armor) + Diver Goggle (accessory). 2-piece → Wet.
  "Swift Swimmers": {
    2: { name: "Swift Swimmers (2-Piece)", statuses: ["wet"], changes: [] },
  },
};

// Count equipped pieces per CSB set_name for one actor (gated by isSet).
function countEquippedSetPieces(actor) {
  const counts = {};
  for (const it of actor.items ?? []) {
    if (it.type !== "equippableItem") continue;
    const p = it.system?.props ?? {};
    if (!p.isEquipped || !p.isSet) continue;
    const name = String(p.set_name ?? "").trim();
    if (!name || name === SET_NAME_EMPTY) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

// Reconcile an actor's managed set-bonus AEs to its currently-equipped pieces.
// Idempotent: creates missing bonus AEs whose threshold is met, deletes managed
// bonus AEs whose threshold is no longer met, leaves everything else untouched.
// Safe to call on any actor (no set pieces → no-op). Returns a small summary.
export async function reconcileSetBonuses(actor) {
  if (!actor?.items) return { counts: {}, created: 0, deleted: 0 };

  const counts = countEquippedSetPieces(actor);

  // Tags that SHOULD exist now (every met threshold across every set).
  const wanted = new Map(); // tag -> aeSpec
  for (const [setId, thresholds] of Object.entries(SET_BONUS_REGISTRY)) {
    const have = counts[setId] ?? 0;
    for (const [pieces, spec] of Object.entries(thresholds)) {
      if (have >= Number(pieces)) wanted.set(`${setId}:${pieces}`, spec);
    }
  }

  // Managed bonus AEs that currently exist on the actor.
  const existing = (actor.effects?.contents ?? []).filter(
    (e) => e.flags?.[FLAG_NS]?.setBonus,
  );

  const toDelete = [];
  const present = new Set();
  for (const e of existing) {
    const tag = e.flags[FLAG_NS].setBonus;
    if (wanted.has(tag)) present.add(tag); // still qualifies → keep
    else toDelete.push(e.id);              // no longer qualifies → remove
  }

  const toCreate = [];
  for (const [tag, spec] of wanted) {
    if (present.has(tag)) continue;
    toCreate.push({
      name: spec.name ?? tag,
      disabled: false,
      statuses: spec.statuses ?? [],
      changes: spec.changes ?? [],
      flags: { [FLAG_NS]: { setBonus: tag } },
    });
  }

  if (toDelete.length) {
    try { await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete); }
    catch (e) { warn("reconcileSetBonuses: delete failed", e); }
  }
  if (toCreate.length) {
    try { await actor.createEmbeddedDocuments("ActiveEffect", toCreate); }
    catch (e) { warn("reconcileSetBonuses: create failed", e); }
  }
  if (toCreate.length || toDelete.length) {
    log(`reconcileSetBonuses: ${actor.name} +${toCreate.length}/-${toDelete.length} (counts ${JSON.stringify(counts)})`);
  }
  return { counts, created: toCreate.length, deleted: toDelete.length };
}
