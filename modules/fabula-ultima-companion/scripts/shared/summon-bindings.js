// Summon bindings — "which actor does THIS character's summon call?"
//
// A summon skill is authored once (ClassTemplate) and copied onto every
// character who learns it, so an actor named on the skill ROW is the same for
// everyone: every Illusionist who took Create Phantasm: Numen summoned Crysta.
// A binding is the per-character answer, and there are two shapes of it:
//
//   "fixed"      — a `summon` row that spawns a named actor (`summon_actor`).
//                  The binding lives on the character's own copy of the skill:
//                  flags.<ns>.summonBindings[<effect_label>] = "Actor.<id>".
//                  The engine reads it in applySummonEffect and falls back to
//                  the authored `summon_actor` when it is absent or dangling.
//
//   "persistent" — a skill that ACTS ON a standing creature through
//                  `own_persistent_summons_<kind>` / `own_summon_tokens_<kind>`
//                  without creating it (Faithful Companion's companion). That
//                  creature is found by flags on the CREATURE's actor
//                  (isPersistentSummon + summonOwnerActorUuid + persistentSummonKind),
//                  so binding one means re-stamping those flags. The refs and
//                  reAddPersistentSummons need no change to honour it.
//
// A kind that one of the owner's skills CREATES by cloning (Birth of the
// Cruel's "minion") is never bindable: those actors are engine-made clones with
// their own lifecycle, and re-pointing the owner flags would orphan one.
//
// Pure functions over plain document data — no Foundry globals at import time,
// so the engine can import this without dragging in any UI.

const FLAG_NS = "fabula-ultima-companion";
export const SUMMON_BINDINGS_FLAG = "summonBindings";

// Same suffix alphabet skill-targeting accepts, so `own_persistent_summons_fire_spirit`
// binds kind "fire_spirit", not "fire".
const PERSISTENT_REF_RE = /\bown_(?:persistent_summons|summon_tokens)_([a-z0-9_]+)/gi;

const truthy = (v) => v === true || String(v ?? "").trim().toLowerCase() === "true";

function liveRows(table) {
  if (!table || typeof table !== "object") return [];
  return Object.values(table).filter((r) => r && typeof r === "object" && !r.$deleted);
}

/** The bound actor ref for a skill's fixed summon row, or "" when unbound. */
export function boundSummonRef(skillItem, effectLabel) {
  const label = String(effectLabel ?? "").trim();
  if (!label) return "";
  const map = skillItem?.flags?.[FLAG_NS]?.[SUMMON_BINDINGS_FLAG];
  if (!map || typeof map !== "object") return "";
  return String(map[label] ?? "").trim();
}

/** Kinds this skill CREATES by cloning — never bindable (see header). */
export function clonedKindsOf(skillItem) {
  const out = new Set();
  for (const r of liveRows(skillItem?.system?.props?.effect_table)) {
    if (r.effect_kind !== "summon" || !truthy(r.summon_clone_target)) continue;
    const k = String(r.summon_kind ?? "").trim().toLowerCase();
    if (k) out.add(k);
  }
  return out;
}

/**
 * The bindable summon slots on one skill.
 *
 * @param {Item} skillItem
 * @param {Set<string>} [ownerClonedKinds]  kinds ANY of the owner's skills create
 *        by cloning — pass it so a kind made by one skill and referenced by
 *        another is still excluded.
 * @returns {Array<{type:"fixed",label:string,defaultRef:string,summonType:string}
 *                 |{type:"persistent",kind:string}>}
 */
export function summonSlotsOf(skillItem, ownerClonedKinds = null) {
  const props = skillItem?.system?.props ?? {};
  const slots = [];
  for (const r of liveRows(props.effect_table)) {
    if (r.effect_kind !== "summon" || truthy(r.summon_clone_target)) continue;
    const label = String(r.effect_label ?? "").trim();
    if (!label) continue;
    slots.push({
      type: "fixed",
      label,
      defaultRef: String(r.summon_actor ?? "").trim(),
      summonType: String(r.summon_type ?? "").trim().toLowerCase(),
    });
  }

  const cloned = new Set([...(ownerClonedKinds ?? []), ...clonedKindsOf(skillItem)]);
  const kinds = new Set();
  const blob = JSON.stringify([props.effect_table ?? {}, props.reaction_config_table ?? {}]);
  for (const m of blob.matchAll(PERSISTENT_REF_RE)) {
    const k = m[1].toLowerCase();
    if (!cloned.has(k)) kinds.add(k);
  }
  for (const kind of kinds) slots.push({ type: "persistent", kind });
  return slots;
}

/** Actors currently standing as `owner`'s persistent summon of `kind`. */
export function persistentHoldersOf(actors, ownerUuid, kind) {
  const k = String(kind ?? "").toLowerCase();
  return (actors ?? []).filter((a) => {
    const f = a?.flags?.[FLAG_NS] ?? {};
    return f.isPersistentSummon
      && String(f.summonOwnerActorUuid ?? "") === ownerUuid
      && String(f.persistentSummonKind ?? "").toLowerCase() === k;
  });
}
