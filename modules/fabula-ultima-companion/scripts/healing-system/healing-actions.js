// ============================================================================
// Out-of-Combat Healing — action enumeration.
//
// gatherHealingActions(actor) walks the actor's inventory and returns the
// healing actions it can use, grouped into Skill / Spell / Item categories for
// the HUD tabs. Three sources:
//
//   1. OWNED skills/spells   — actor.items with a skill_type (Active → Skill
//                              tab, Spell → Spell tab).
//   2. EQUIPMENT-GRANTED     — actions linked from a weapon/armor/accessory via
//                              item_skill_active / related_item_list. Included
//                              REGARDLESS of whether the item is equipped (the
//                              player would just equip→use→re-equip otherwise).
//                              Categorised by the granted action's skill_type.
//   3. CONSUMABLES           — item_type "consumable" carriers; the heal lives
//                              in the carrier's effect_table (or the linked
//                              action's type_damage). → Item tab.
//
// An entry is kept only if it actually restores HP/MP/IP (resolveHealAction
// yields grants) AND classifies as aid intent — so offensive spells, MP-burn,
// drains, and flavour consumables are filtered out.
//
// Returned descriptors are PLAIN data (no live Item docs / circular refs): they
// carry the uuids the GM handler re-resolves from, plus display strings.
// ============================================================================

import { HEAL_TAG, HEAL_CATEGORY } from "./healing-const.js";
import { classifyActionIntent } from "../battle-director/skill-intent.js";
import { resolveHealAction, formatCostMap, formatGrants } from "./healing-resolve.js";

function asEntries(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

function entryUuid(entry) {
  return entry?.uuid ?? entry?.skillUuid ?? entry?.skill_uuid ?? entry?.itemUuid ?? null;
}

// Union of an item's linked-action entries (the embedded healing action).
function grantedActionUuids(item) {
  const p = item?.system?.props ?? {};
  const uuids = [
    ...asEntries(p.item_skill_active),
    ...asEntries(p.related_item_list),
    ...asEntries(p.active_skill_list),
    ...asEntries(p.skill_active_list),
  ].map(entryUuid).filter(Boolean);
  return [...new Set(uuids)];
}

function categoryForSkillType(skillType) {
  const st = String(skillType ?? "").trim().toLowerCase();
  if (st === "spell") return HEAL_CATEGORY.SPELL;
  if (st === "active") return HEAL_CATEGORY.SKILL;
  return null; // passive / other / item-only carriers handled elsewhere
}

function stripHtml(html) {
  if (!html) return "";
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    return (tmp.textContent ?? tmp.innerText ?? "").trim();
  } catch {
    return String(html).replace(/<[^>]*>/g, "").trim();
  }
}

// Build a display descriptor from a resolved heal. Returns null when the action
// doesn't heal (no grants).
function buildDescriptor({ caster, category, displayItem, effectItem, costItem, source, sourceItemName = null, consumableUuid = null, quantity = null }) {
  const resolved = resolveHealAction({ caster, effectItem, costItem, targetCount: 1 });
  if (!resolved.ok) return null;

  const p = displayItem.system?.props ?? {};
  return {
    category,
    name: displayItem.name ?? p.name ?? "(unnamed)",
    img: displayItem.img ?? "icons/svg/heal.svg",
    descriptionHtml: String(p.description ?? p.skill_description ?? ""),
    descriptionText: stripHtml(p.description ?? p.skill_description ?? ""),
    // uuids the GM re-resolves from:
    effectItemUuid: effectItem.uuid,
    costItemUuid: (costItem ?? effectItem).uuid,
    consumableUuid,
    source,                 // "actor" | "equipment" | "consumable"
    sourceItemName,         // granting equipment / carrier name (for the ⚔ tag)
    quantity,               // consumable count (null = not a consumable / unique)
    // display:
    healLabel: formatGrants(resolved.grants),
    costLabel: consumableUuid ? "1 Use" : formatCostMap(resolved.costMap),
    affordable: resolved.affordable && (quantity == null || quantity > 0),
    skillTarget: String(p.skill_target ?? "").trim(),
  };
}

// Is this action aid-intent? Cheap pre-filter before the (heavier) heal resolve.
function isAid(item) {
  try { return classifyActionIntent(item) === "aid"; } catch { return false; }
}

export async function gatherHealingActions(actor) {
  const out = { [HEAL_CATEGORY.SKILL]: [], [HEAL_CATEGORY.SPELL]: [], [HEAL_CATEGORY.ITEM]: [] };
  if (!actor) return out;

  const items = Array.from(actor.items ?? []);
  const seenEffect = new Set();   // dedupe by effect-item uuid across all sources

  const push = (desc) => {
    if (!desc) return;
    if (seenEffect.has(desc.effectItemUuid)) return;
    seenEffect.add(desc.effectItemUuid);
    out[desc.category].push(desc);
  };

  for (const item of items) {
    const p = item.system?.props ?? {};
    const skillType = String(p.skill_type ?? "").trim();
    const itemType = String(p.item_type ?? "").trim().toLowerCase();

    // 1. OWNED skill / spell.
    if (skillType) {
      const category = categoryForSkillType(skillType);
      if (!category) continue;        // passive / other
      if (!isAid(item)) continue;
      push(buildDescriptor({
        caster: actor, category, displayItem: item, effectItem: item, costItem: item, source: "actor",
      }));
      continue;
    }

    // 2. CONSUMABLE carrier.
    if (itemType === "consumable") {
      const isUnique = !!p.isUnique;
      const qty = isUnique ? null : (Number(p.item_quantity ?? 0) || 0);
      if (!isUnique && qty <= 0) continue;

      // Heal lives on the carrier's effect_table, or on the linked action's
      // type_damage. Resolve against whichever yields grants.
      const linkedUuids = grantedActionUuids(item);
      let linked = null;
      for (const u of linkedUuids) { linked = await fromUuid(u).catch(() => null); if (linked) break; }

      // Carrier OR linked action must read as aid (carrier via effect_table grants,
      // linked via type_damage Heal). Skip clearly-non-aid consumables.
      const aid = isAid(item) || (linked && isAid(linked));
      if (!aid) continue;

      // Prefer the carrier when it has a heal effect_table; else the linked action.
      let desc = buildDescriptor({
        caster: actor, category: HEAL_CATEGORY.ITEM, displayItem: item, effectItem: item,
        costItem: item, source: "consumable", sourceItemName: item.name, consumableUuid: item.uuid, quantity: qty,
      });
      if (!desc && linked) {
        desc = buildDescriptor({
          caster: actor, category: HEAL_CATEGORY.ITEM, displayItem: item, effectItem: linked,
          costItem: item, source: "consumable", sourceItemName: item.name, consumableUuid: item.uuid, quantity: qty,
        });
      }
      push(desc);
      continue;
    }

    // 3. EQUIPMENT (weapon / armor / accessory) that grants an action — include
    //    even when NOT equipped.
    const linkedUuids = grantedActionUuids(item);
    if (!linkedUuids.length) continue;
    for (const u of linkedUuids) {
      const linked = await fromUuid(u).catch(() => null);
      if (!linked) continue;
      const category = categoryForSkillType(linked.system?.props?.skill_type);
      if (!category) continue;
      if (!isAid(linked)) continue;
      push(buildDescriptor({
        caster: actor, category, displayItem: linked, effectItem: linked, costItem: linked,
        source: "equipment", sourceItemName: item.name,
      }));
    }
  }

  // Stable sort within each category: affordable first, then alphabetic.
  for (const cat of Object.keys(out)) {
    out[cat].sort((a, b) => {
      if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
      return a.name.localeCompare(b.name, game.i18n?.lang);
    });
  }

  console.debug(HEAL_TAG, `gathered heals — Skill:${out.Skill.length} Spell:${out.Spell.length} Item:${out.Item.length}`);
  return out;
}
