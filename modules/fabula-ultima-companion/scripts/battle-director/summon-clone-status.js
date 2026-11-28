// Statuses baked onto a summon CLONE (summon_clone_statuses).
//
// Birth of the Cruel raises a corpse as a standing Minion that is Undead by
// species. A species carries no token cue, so a healer had no way to see that
// the Minion turns heals into damage. The user's call (2026-11-28): the raised
// Minion wears a PERMANENT Zombie status, which brings the Zombie cue (tint +
// miasma) and the card's Zombie pill with it.
//
// A baked status is a copy of the canonical template (the status library's
// `activeEffectContainer` items, matched by name or status id) with:
//   - no turn counter (charges / duration stripped): it never ticks off;
//   - directorPermanent: the battle-end transient sweep, Rest and Cleanse skip it;
//   - uncleansable: a "*" / tag dispel never takes it (only a row naming it);
//   - bakedSummonStatus: marks it as ours (migrations / debugging).
// The clone ACTOR carries the effect, so it persists with the Minion across
// battles; the clone is deleted when the Minion is destroyed.
//
// Shared by skill-effects.js (clone path) and the data migration that bakes the
// status onto Minions raised before this existed. Reads only loaded world Items.

const NS = "fabula-ultima-companion";

/** "Zombie, Slow" → ["Zombie", "Slow"]. */
export function parseCloneStatuses(raw) {
  return String(raw ?? "").split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
}

function statusIdsOf(eff) {
  const st = eff?.statuses;
  if (!st) return [];
  if (typeof st.has === "function") return Array.from(st).map(String);
  return Array.isArray(st) ? st.map(String) : [];
}

/** The canonical template AE for a status, by AE name or status id (null if none). */
export function findStatusTemplate(ref, items = globalThis.game?.items) {
  const want = String(ref ?? "").trim();
  if (!want) return null;
  const lower = want.toLowerCase();
  for (const it of items ?? []) {
    if (it?.type !== "activeEffectContainer") continue;
    for (const eff of it.effects ?? []) {
      if (String(eff?.name ?? "").trim().toLowerCase() === lower || statusIdsOf(eff).includes(want)) return eff;
    }
  }
  return null;
}

/** Plain AE data for a baked (permanent, uncleansable) copy of `template`. */
export function bakedStatusData(template) {
  const src = typeof template?.toObject === "function" ? template.toObject() : structuredClone(template ?? {});
  delete src._id;
  src.disabled = false;
  src.transfer = false;
  src.duration = {};
  const fu = { ...(src.flags?.[NS] ?? {}) };
  delete fu.charges;
  delete fu.chargesMax;
  delete fu.lifetimeMode;
  delete fu.directorAppliedBy;
  src.flags = { ...(src.flags ?? {}), [NS]: { ...fu, directorPermanent: true, uncleansable: true, bakedSummonStatus: true } };
  if (src.flags.statuscounter) src.flags.statuscounter = { ...src.flags.statuscounter, visible: false };
  return src;
}

/** True when `effects` (AE docs or plain data) already carry the template's status. */
export function hasStatusOf(effects, template) {
  const ids = statusIdsOf(template);
  const name = String(template?.name ?? "").toLowerCase();
  for (const e of effects ?? []) {
    if (!e) continue;
    if (ids.length && statusIdsOf(e).some((s) => ids.includes(s))) return true;
    if (!ids.length && String(e.name ?? "").toLowerCase() === name) return true;
  }
  return false;
}

/**
 * AE data to add for `raw` ("Zombie"), skipping statuses `existing` already has.
 * Returns { add: [aeData], missing: [ref] } — missing = no template found.
 */
export function bakedStatusesFor(raw, existing = [], items = globalThis.game?.items) {
  const add = [], missing = [];
  for (const ref of parseCloneStatuses(raw)) {
    const tpl = findStatusTemplate(ref, items);
    if (!tpl) { missing.push(ref); continue; }
    if (hasStatusOf(existing, tpl) || hasStatusOf(add, tpl)) continue;
    add.push(bakedStatusData(tpl));
  }
  return { add, missing };
}
