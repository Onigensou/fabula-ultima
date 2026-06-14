/**
 * Migration: 2026-06-15-reaction-self-scope-source-skill
 * ---------------------------------------------------------------------------
 * Companion to the engine change that REMOVED the `skillActionPassiveApplies`
 * item-level gate (skill-effects.js, 2026-06-15). That gate used an item's
 * `skill_type` to decide whether its reaction rows were "ambient" (fire on any
 * of the owner's matching actions) or "self-scoped" (fire only when that very
 * skill/weapon is the acting one). `skill_type` is the wrong lever — it
 * conflates "is this skill invokable?" with reaction scope — and it silently
 * hid ambient reaction skills (Warning Shot / Gadgets / Barrage, all
 * skill_type "Active") on basic attacks.
 *
 * Self-scoping is now a PER-ROW config concern via `reaction_source_skill`
 * (matched against payload.sourceSkillName in passesMatchFilters). To PRESERVE
 * the prior behaviour of genuine self-riders after the gate is gone, this
 * migration stamps `reaction_source_skill = <own item name>` onto every
 * currently-gated reaction row that fires on an attack-class trigger — EXCEPT
 * the handful of ambient reaction skills, which must stay blank so they fire on
 * any qualifying action.
 *
 * Inclusion rule (a "self-rider" today):
 *   - skill_type is set AND not "passive"   (i.e. the row was uuid-gated before)
 *   - item_type is NOT "weapon"             (weapons are scoped by weaponReactionInPlay)
 *   - trigger ∈ ATTACK_TRIGGERS
 *   - reaction_source is "self" or empty
 *   - reaction_source_skill not already set
 *   - item name NOT in AMBIENT_EXCLUDE
 *
 * AMBIENT_EXCLUDE are the reactions that SHOULD fire on the owner's other
 * actions (Sharpshooter / Tinkerer / Spiritist "when you …" reactions); they
 * are intentionally left unscoped.
 *
 * Affects committed monster skills (Centimare, Centuaros, Dryad, Fire Slime,
 * Hellhound, Inferex, Marigold, Salamander) + any embedded copies. Patches
 * world items AND every actor's items. Drift-safe + idempotent in effect
 * (only stamps the field when absent; never overwrites an explicit value).
 *
 * RUN ONCE (not manifest-tagged idempotent). Touches co-dev world data →
 * delivery = WORLD-DATA PUSH (USER says when).
 */

export const key = "2026-06-15-reaction-self-scope-source-skill";
export const description =
  "Stamp reaction_source_skill = own item name onto currently-gated self-rider " +
  "reaction rows (replaces the removed skill_type item-gate); leaves ambient " +
  "reaction skills (Warning Shot/Gadgets/Barrage/Thermokinesis/Life Transference) blank.";

// Triggers that fire as a by-product of the owner taking an action — the ones
// where a self-rider vs. ambient distinction matters.
const ATTACK_TRIGGERS = new Set([
  "creature_will_deal_damage",
  "creature_deals_damage",
  "creature_performs_action",
  "creature_completes_attack",
  "creature_completes_spell",
  "creature_uses_item",
]);

// Reaction skills that MUST stay ambient (fire on any of the owner's qualifying
// actions). Lower-cased for comparison.
const AMBIENT_EXCLUDE = new Set([
  "warning shot",
  "gadgets",
  "barrage",
  "thermokinesis",
  "life transference",
]);

function rowEntries(rct) {
  if (!rct || typeof rct !== "object") return [];
  return Array.isArray(rct)
    ? rct.map((r, i) => [String(i), r])
    : Object.entries(rct);
}

// Returns a flat update map of dotted paths → item.name for each self-rider row
// that needs stamping, or null if the item needs no change.
function buildItemUpdate(item) {
  const p = item.system?.props ?? {};
  const skillType = String(p.skill_type ?? "").trim().toLowerCase();
  if (!skillType || skillType === "passive") return null;          // was never gated → leave ambient
  if (String(p.item_type ?? "").trim().toLowerCase() === "weapon") return null; // weaponReactionInPlay scopes it
  if (AMBIENT_EXCLUDE.has(String(item.name ?? "").trim().toLowerCase())) return null;

  const rct = p.reaction_config_table;
  const entries = rowEntries(rct);
  if (!entries.length) return null;

  const isArray = Array.isArray(rct);
  const updates = {};
  for (const [k, row] of entries) {
    if (!row || row.$deleted) continue;
    const trig = String(row.reaction_trigger ?? "").trim();
    if (!ATTACK_TRIGGERS.has(trig)) continue;
    const src = String(row.reaction_source ?? "").trim().toLowerCase();
    if (src && src !== "self") continue;                            // only owner-sourced riders
    if (String(row.reaction_source_skill ?? "").trim()) continue;   // already scoped — never overwrite
    if (isArray) {
      // Array-backed table: dotted-array updates are unsafe — rebuild whole.
      const next = rct.map((r) => ({ ...r }));
      next[Number(k)].reaction_source_skill = item.name;
      updates._wholeTable = next; // sentinel; handled by caller
    } else {
      updates[`system.props.reaction_config_table.${k}.reaction_source_skill`] = item.name;
    }
  }
  if (updates._wholeTable) {
    return { "system.props.reaction_config_table": updates._wholeTable };
  }
  return Object.keys(updates).length ? updates : null;
}

async function patchCollection(items, log, stats) {
  for (const item of items) {
    const update = buildItemUpdate(item);
    if (!update) continue;
    await item.update(update);
    stats.rows += Object.keys(update).filter((k) => k !== "system.props.reaction_config_table").length
      || 1;
    stats.items++;
    const owner = item.parent?.name ? `${item.parent.name} / ` : "";
    log(`  [${owner}${item.name}] stamped reaction_source_skill="${item.name}"`);
  }
}

export async function migrate(game, log = () => {}) {
  const stats = { items: 0, rows: 0 };

  // World items (hub templates / loose copies).
  await patchCollection(game.items?.contents ?? [], log, stats);

  // Every actor's embedded items (monster attack/spell skills live here).
  for (const actor of game.actors?.contents ?? []) {
    await patchCollection(actor.items?.contents ?? [], log, stats);
  }

  return {
    applied: true,
    summary: `Self-rider reactions scoped: ${stats.items} item(s), ${stats.rows} row-write(s)`,
  };
}
