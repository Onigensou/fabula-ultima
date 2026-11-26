/**
 * Migration: 2026-11-26-percent-stat-keys
 * ---------------------------------------------------------------------------
 * Registers the % stat fields as hidden computable props, so Active Effects on
 * them aggregate through CSB exactly like the existing flat columns (formulas,
 * `${isEquipped ? … }$`, aeWhen gates and all):
 *
 *   damage_outgoing_percentage_{all, melee, ranged, spell, <9 elements>}
 *       NEW — the Damage % family (scripts/shared/stat-rules.js rule 2).
 *   damage_receiving_percentage_{all, melee, range, <9 elements>}
 *       Already a column on the PC template; MISSING on the NPC template and
 *       every monster, where a damage-reduction % effect silently did nothing.
 *       Added only where absent.
 *
 * WHY system.hidden ON EVERY ACTOR (not the template): an actor instance renders
 * from its OWN stamped copy of the template (see 2026-07-21-actor-template-
 * skill-point), and reloadTemplate prunes ~200 props per actor. `system.hidden`
 * is a small, location-independent list CSB turns into computable props — the
 * same route bonus_hp / bonus_mp took (2026-05-21). Templates get it too, so
 * actors created later carry it.
 *
 * IDEMPOTENT — a key is skipped when the actor already has it as a prop, a
 * hidden entry or a header/body node. Scope: every `_template` and `character`
 * actor in the world (compendium packs untouched). Only `system.hidden` is
 * written; nothing is deleted.
 */

export const key = "2026-11-26-percent-stat-keys";
export const description =
  "Hidden % stat fields: damage_outgoing_percentage_* on every actor + template; " +
  "damage_receiving_percentage_* where missing (NPCs).";

const ELEMENTS = ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];
const KEYS = [
  "damage_outgoing_percentage_all", "damage_outgoing_percentage_melee", "damage_outgoing_percentage_ranged",
  "damage_outgoing_percentage_spell", ...ELEMENTS.map((e) => `damage_outgoing_percentage_${e}`),
  "damage_receiving_percentage_all", "damage_receiving_percentage_melee", "damage_receiving_percentage_range",
  ...ELEMENTS.map((e) => `damage_receiving_percentage_${e}`),
];

// Every node key under a template panel (header / body), collected once per actor.
function nodeKeys(root, out = new Set(), seen = new WeakSet()) {
  if (!root || typeof root !== "object" || seen.has(root)) return out;
  seen.add(root);
  if (typeof root.key === "string") out.add(root.key);
  for (const k of Object.keys(root)) {
    if (k === "_id" || k === "flags" || k === "ownership" || k === "permission") continue;
    nodeKeys(root[k], out, seen);
  }
  return out;
}

// Creatures only: an actor (or template) with a Max HP — PCs, monsters and their two
// templates. The database / layout / class sheets share the actor types but never fight.
function missingKeys(actor) {
  const s = actor.system ?? {};
  const props = s.props ?? {};
  const hidden = Array.isArray(s.hidden) ? s.hidden : [];
  const have = new Set([...hidden.map((h) => h?.name), ...Object.keys(props)]);
  const nodes = nodeKeys(s.header); nodeKeys(s.body, nodes);
  if (!have.has("max_hp") && !nodes.has("max_hp")) return [];
  return KEYS.filter((k) => !have.has(k) && !nodes.has(k));
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.type === "_template" || a.type === "character");
  const updates = [];
  let added = 0, templates = 0;
  for (const a of actors) {
    const missing = missingKeys(a);
    if (!missing.length) continue;
    const hidden = foundry.utils.duplicate(Array.isArray(a.system?.hidden) ? a.system.hidden : []);
    for (const k of missing) hidden.push({ name: k, value: "0" });
    updates.push({ _id: a.id, "system.hidden": hidden });
    added += missing.length;
    if (a.type === "_template") { templates++; log(`  • template "${a.name}": +${missing.length} hidden % fields`); }
  }
  for (let i = 0; i < updates.length; i += 50) {
    await Actor.updateDocuments(updates.slice(i, i + 50));
  }
  return {
    applied: true,
    summary: `${updates.length} actor${updates.length === 1 ? "" : "s"} (${templates} template${templates === 1 ? "" : "s"}) got ${added} hidden % stat field${added === 1 ? "" : "s"}`,
  };
}
