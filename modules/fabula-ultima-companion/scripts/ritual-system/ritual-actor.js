// ============================================================================
// Ritual System — who is performing, and what may they perform.
//
// ── Why detection is two-layered ────────────────────────────────────────────
// A skill granted to an actor is an embedded COPY of a world item, and the
// copies in this world do not agree on how they remember their origin. Probed
// live against every actor holding a ritual skill:
//
//   Ritual Spiritism (Cherry, Hina, Spiritist)  compendiumSource = null
//                                               duplicateSource  = null
//   Ritual Entropism (Hina)                     compendiumSource = 6HdBHEPi…
//                                               (a DUPLICATE world item, not
//                                                the id we were handed)
//   Curse Ritualism  (Hexer)                    compendiumSource = A7DaASy… ✔
//                                               duplicateSource  = XSy7MGg…
//                                               (Curse Magic — disagrees)
//   Ritual Arcanism (variant)                   duplicateSource  = NqgJHog… ✔
//                                               compendiumSource = x2HmuRV…
//
// So an id match alone finds no Spiritists at all, and a name match alone is
// unsafe: the world also holds "Ritual Seal", "Curse Magic", "Curse Collector"
// and "Curse Mallet", none of which grant a discipline. We take the union of
// an id allowlist and an exact-name allowlist. Neither layer is sufficient;
// together they cover every copy observed.
//
// `disciplinesForActorLike` is pure — it takes a plain shape, not an Actor —
// so the table above can be regression-tested headlessly.
// ============================================================================

import { DISCIPLINE_ORDER, disciplineById } from "./ritual-const.js";

/** Every id a copy might use to point back at its source item. */
function sourceIdsOf(item) {
  const raw = [
    item?._stats?.compendiumSource,
    item?._stats?.duplicateSource,
    item?.flags?.core?.sourceId,
  ];
  // Stored as "Item.<id>"; compare on the bare id so a compendium-qualified
  // path ("Compendium.pack.Item.<id>") still matches on its last segment.
  return raw.filter(Boolean).map((s) => String(s).split(".").pop());
}

/**
 * Normalise an item name for allowlist comparison: trim, and drop a single
 * trailing parenthetical so "Ritual Arcanism (variant)" matches "Ritual
 * Arcanism". Deliberately does not strip anything else — no prefix matching.
 */
function normaliseName(name) {
  return String(name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Resolve which disciplines an actor-like shape may perform.
 *
 * @param {{items: Array, classes: string[]}} actorLike
 * @returns {Array<{id, label, via: "item"|"class", reason?: string}>}
 */
export function disciplinesForActorLike(actorLike) {
  const items = Array.isArray(actorLike?.items) ? actorLike.items : [];
  const classes = new Set((actorLike?.classes ?? []).map(String));

  const heldIds = new Set();
  const heldNames = new Set();
  for (const it of items) {
    for (const id of sourceIdsOf(it)) heldIds.add(id);
    heldNames.add(normaliseName(it?.name));
  }

  const out = [];
  for (const id of DISCIPLINE_ORDER) {
    const d = disciplineById(id);
    if (!d) continue;

    if (d.classes?.length) {
      const hit = d.classes.find((c) => classes.has(c));
      if (hit) out.push({ id: d.id, label: d.label, via: "class", reason: hit });
      continue;
    }

    const byId = (d.itemIds ?? []).some((i) => heldIds.has(i));
    const byName = (d.itemNames ?? []).some((n) => heldNames.has(n));
    if (byId || byName) out.push({ id: d.id, label: d.label, via: "item" });
  }
  return out;
}

/** Why an actor CANNOT perform a discipline — shown greyed in the window. */
export function ineligibilityReason(disciplineId) {
  const d = disciplineById(disciplineId);
  if (!d) return "Unknown discipline.";
  if (d.classes?.length) return `Requires a ${d.classes.join(", ")} class.`;
  return `Requires the ${d.itemNames[0]} skill.`;
}

/** Flatten a CSB actor into the pure shape above. */
export function actorLikeOf(actor) {
  const classes = Object.values(actor?.system?.props?.class_list ?? {})
    .filter((r) => r && !r.$deleted)
    .map((r) => r.class_name)
    .filter(Boolean);
  const items = (actor?.items?.contents ?? actor?.items ?? []).map((i) => ({
    name: i?.name,
    _stats: i?._stats,
    flags: i?.flags,
  }));
  return { items, classes };
}

/** Disciplines a real Actor may perform. */
export function disciplinesForActor(actor) {
  if (!actor) return [];
  return disciplinesForActorLike(actorLikeOf(actor));
}

/**
 * The actor performing the ritual.
 *
 * Mirrors checkRoller-dialog.js: a GM performs as whatever token they have
 * selected; a player performs as the character linked to their user. A GM with
 * no token selected gets null, and the docked button greys out.
 *
 * @returns {{actor: Actor, uuid: string, name: string, img: string}|null}
 */
export function resolvePerformer() {
  if (game.user?.isGM) {
    const token = canvas?.tokens?.controlled?.[0] ?? null;
    const actor = token?.actor ?? null;
    if (!actor) return null;
    return {
      actor,
      uuid: token.document?.uuid ?? actor.uuid,
      name: token.name ?? actor.name,
      img: token.document?.texture?.src ?? actor.img ?? "",
    };
  }

  const actor = game.user?.character ?? null;
  if (!actor) return null;
  return { actor, uuid: actor.uuid, name: actor.name, img: actor.img ?? "" };
}

/**
 * True when the docked ritual button should be clickable for this client.
 *
 * A resolvable performer is not enough — they must know at least one
 * discipline. A GM selecting the party token ("EXFURSION Party", which holds
 * the group's shared inventory but no ritual skills) resolves a performer who
 * can perform nothing, and the button must say so by staying grey rather than
 * inviting a click that only produces a warning.
 */
export function canOpenRitual() {
  const performer = resolvePerformer();
  if (!performer) return false;
  return disciplinesForActor(performer.actor).length > 0;
}

/** Why the button is greyed, for its tooltip. Null when it is clickable. */
export function blockedReason() {
  const performer = resolvePerformer();
  if (!performer) {
    return game.user?.isGM
      ? "Ritual — select a token first"
      : "Ritual — no character assigned to your user";
  }
  if (!disciplinesForActor(performer.actor).length) {
    return `Ritual — ${performer.name} knows no ritual disciplines`;
  }
  return null;
}
