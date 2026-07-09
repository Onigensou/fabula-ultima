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

import { HEAL_TAG, HEAL_CATEGORY, HEAL_CREATE_PRESETS } from "./healing-const.js";
import { classifyActionIntent } from "../battle-director/skill-intent.js";
import { resolveHealAction, formatCostMap, formatGrants } from "./healing-resolve.js";
import { getCleanseInfoForItem } from "./healing-cleanse.js";
import { isPotionItem } from "./potion-rain.js";
import { parseJRPGTargetingText } from "../jrpg-targeting-system/jrpg-targeting-parser.js";

// Targeting mode for an action: "self" | "single" | "all".
// Cleanse actions pin it via the registry (tonics have no skill_target); heals
// parse skill_target. Per design, "up to N" / "exact N" collapse to single.
function resolveTargeting(item, cleanseInfo) {
  if (cleanseInfo) return cleanseInfo.target === "all" ? "all" : "single";
  const raw = String(item?.system?.props?.skill_target ?? "");
  try {
    const r = parseJRPGTargetingText(raw);
    if (r.mode === "self") return "self";
    if (r.mode === "all") return "all";
  } catch (e) { warnTargeting(raw, e); }
  return "single";
}
function warnTargeting(raw, e) { console.warn(HEAL_TAG, "targeting parse failed", raw, e); }

function entryUuid(entry) {
  return entry?.uuid ?? entry?.skillUuid ?? entry?.skill_uuid ?? entry?.itemUuid ?? null;
}

// Union of an item's linked-action entries (the embedded healing action).
// Each entry SHOULD carry a `uuid`, but CSB sometimes leaves it blank on world
// items while the entry's KEY is the linked item's id — fall back to `Item.<key>`
// in that case. (Actor-embedded carriers like Apple Juice have a populated,
// actor-scoped uuid, so the fallback never overrides a real link.)
function grantedActionUuids(item) {
  const p = item?.system?.props ?? {};
  const uuids = new Set();
  for (const tableKey of ["item_skill_active", "related_item_list", "active_skill_list", "skill_active_list"]) {
    const table = p[tableKey];
    if (!table || typeof table !== "object") continue;
    for (const [key, entry] of Object.entries(table)) {
      if (!entry || entry.$deleted) continue;
      let u = entryUuid(entry);
      if ((!u || !String(u).trim()) && /^[A-Za-z0-9]{16}$/.test(key)) u = `Item.${key}`;
      if (u) uuids.add(u);
    }
  }
  return [...uuids];
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

// Build a display descriptor. For a pure heal, returns null when the action
// restores nothing. For a cleanse action (cleanseInfo present), the heal grants
// are optional — cost/affordability still resolve from the cost string.
function buildDescriptor({ caster, category, displayItem, effectItem, costItem, source, sourceItemName = null, consumableUuid = null, quantity = null, cleanseInfo = null }) {
  const resolved = resolveHealAction({ caster, effectItem, costItem, targetCount: 1 });
  const isCleanse = !!cleanseInfo;
  if (!isCleanse && !resolved.ok) return null;   // pure heal must restore something

  const p = displayItem.system?.props ?? {};
  return {
    category,
    kind: isCleanse ? "cleanse" : "heal",
    cleanseScope: cleanseInfo?.scope ?? null,        // "one" | "all" | null
    targeting: resolveTargeting(displayItem, cleanseInfo),   // "self" | "single" | "all"
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
    // structured grants (resource + amount) — used to gate full targets:
    grants: resolved.grants,
    // display:
    healLabel: isCleanse ? (cleanseInfo.scope === "all" ? "Cleanse All" : "Cleanse") : formatGrants(resolved.grants),
    costLabel: consumableUuid ? "1 Use" : formatCostMap(resolved.costMap),
    affordable: resolved.affordable && (quantity == null || quantity > 0),
    skillTarget: String(p.skill_target ?? "").trim(),
    // Potion Rain eligibility: is this a "potion"? (shared tag def). Items act
    // through a linked action generally, so check the display carrier AND the
    // effect item — the tag may live on either.
    isPotion: isPotionItem(displayItem) || isPotionItem(effectItem),
  };
}

// Is this action aid-intent? Cheap pre-filter before the (heavier) heal resolve.
function isAid(item) {
  try { return classifyActionIntent(item) === "aid"; } catch { return false; }
}

// Inventory-Point creatables (Create tab). Each preset is a world item that is
// "crafted" on use: spend IP, apply its heal immediately, nothing is consumed
// from inventory. Heal source is the preset's linked action (or the carrier);
// cleanse presets (Tonic) are shown as a placeholder with no resource grant yet.
async function gatherCreateActions(caster) {
  const list = [];
  const casterIp = Number(caster?.system?.props?.current_ip ?? 0) || 0;

  for (const preset of HEAL_CREATE_PRESETS) {
    const carrier = await fromUuid(preset.uuid).catch(() => null);
    if (!carrier) { console.warn(HEAL_TAG, "create preset missing", preset.uuid); continue; }
    const ipCost = Number(carrier.system?.props?.ip_cost ?? 0) || 0;

    // Resolve the heal: try linked action(s) first, then the carrier itself.
    let effectItem = null, resolved = null;
    for (const u of grantedActionUuids(carrier)) {
      const li = await fromUuid(u).catch(() => null);
      if (!li) continue;
      const r = resolveHealAction({ caster, effectItem: li, costItem: li, targetCount: 1 });
      if (r.ok) { effectItem = li; resolved = r; break; }
    }
    if (!resolved) {
      const r = resolveHealAction({ caster, effectItem: carrier, costItem: carrier, targetCount: 1 });
      if (r.ok) { effectItem = carrier; resolved = r; }
    }
    if (!resolved) { effectItem = carrier; resolved = { grants: [] }; }  // cleanse / placeholder

    const cleanseInfo = getCleanseInfoForItem(carrier);   // Tonic → cleanse "one"
    const grants = resolved.grants ?? [];
    list.push({
      category: HEAL_CATEGORY.CREATE,
      mode: "create",
      kind: cleanseInfo ? "cleanse" : "heal",
      cleanseScope: cleanseInfo?.scope ?? null,
      targeting: resolveTargeting(carrier, cleanseInfo),
      name: carrier.name ?? "(unnamed)",
      img: carrier.img ?? "icons/svg/item-bag.svg",
      descriptionHtml: String(carrier.system?.props?.description ?? ""),
      descriptionText: stripHtml(carrier.system?.props?.description ?? ""),
      effectItemUuid: effectItem.uuid,
      costItemUuid: null,
      consumableUuid: null,
      carrierUuid: carrier.uuid,   // preset item — potion tag may live here (not the linked action)
      ipCost,
      source: "create",
      sourceItemName: null,
      quantity: null,
      grants,
      healLabel: cleanseInfo ? (cleanseInfo.scope === "all" ? "Cleanse All" : "Cleanse") : (grants.length ? formatGrants(grants) : ""),
      costLabel: `${ipCost} IP`,
      affordable: casterIp >= ipCost,
      skillTarget: String(effectItem.system?.props?.skill_target ?? carrier.system?.props?.skill_target ?? "").trim(),
      isPotion: isPotionItem(carrier) || isPotionItem(effectItem),
    });
  }
  list.sort((a, b) => (a.affordable !== b.affordable ? (a.affordable ? -1 : 1) : a.name.localeCompare(b.name, game.i18n?.lang)));
  return list;
}

export async function gatherHealingActions(actor) {
  const out = { [HEAL_CATEGORY.SKILL]: [], [HEAL_CATEGORY.SPELL]: [], [HEAL_CATEGORY.ITEM]: [], [HEAL_CATEGORY.CREATE]: [] };
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
      const cleanseInfo = getCleanseInfoForItem(item);
      if (cleanseInfo) {
        push(buildDescriptor({ caster: actor, category, displayItem: item, effectItem: item, costItem: item, source: "actor", cleanseInfo }));
        continue;
      }
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

      // Cleanse consumable (Super/Turbo Tonic) — hardcoded registry match.
      const cleanseInfo = getCleanseInfoForItem(item);
      if (cleanseInfo) {
        push(buildDescriptor({
          caster: actor, category: HEAL_CATEGORY.ITEM, displayItem: item, effectItem: item,
          costItem: item, source: "consumable", sourceItemName: item.name, consumableUuid: item.uuid, quantity: qty, cleanseInfo,
        }));
        continue;
      }

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
      const cleanseInfo = getCleanseInfoForItem(linked);
      if (!cleanseInfo && !isAid(linked)) continue;
      push(buildDescriptor({
        caster: actor, category, displayItem: linked, effectItem: linked, costItem: linked,
        source: "equipment", sourceItemName: item.name, cleanseInfo,
      }));
    }
  }

  // Create tab — IP-crafted items (independent of the actor's inventory walk).
  out[HEAL_CATEGORY.CREATE] = await gatherCreateActions(actor);

  // Stable sort within each category: affordable first, then alphabetic.
  for (const cat of Object.keys(out)) {
    out[cat].sort((a, b) => {
      if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
      return a.name.localeCompare(b.name, game.i18n?.lang);
    });
  }

  console.debug(HEAL_TAG, `gathered heals — Skill:${out.Skill.length} Spell:${out.Spell.length} Item:${out.Item.length} Create:${out.Create.length}`);
  return out;
}
