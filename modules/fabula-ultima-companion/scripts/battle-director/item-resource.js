// Item / Inventory — director-native helpers.
//
// Mirrors the legacy [Macro] Item.js read paths + the resource side of
// the legacy action pipeline (action-execution-core consume + ResourceGate
// IP spend) so that picking + paying for an item in the director's
// Item card produces the same downstream state as the legacy flow.
//
// What this file DOES handle (Phase D.5):
//   • Read the actor's `consumable_list` and surface owned consumables
//     with live quantities + descriptions + linked active skills.
//   • Read creatable recipes via `FUCompanion.api.itemCreate` and surface
//     them with IP costs (already reduced by per-actor IP-reduction).
//   • Consume one unit of a non-unique consumable (delete the item if it
//     reaches 0) on commit.
//   • Spend IP on commit, clamping at 0 (gate is enforced at picker
//     time, not at write time).
//
// What this file does NOT handle (deferred to Phase B Skills):
//   • Actually invoking the item's active skill (rolling, damage,
//     effects). For v1 the director's Item action is a resource action
//     only — quantity / IP is debited and the player is told the action
//     happened. The skill effect ships when Phase B lands and we can
//     route the chosen skill through a director-native skill pipeline.
//
// Why no skill picker yet: without skill execution there's nothing to
// pick. When B lands, this file gets a `pickSkillForItem(item)` helper
// and the picker UX, but for now we only show the linked skill names in
// the item description for the player's awareness.

import { log, warn } from "./logger.js";

// ─── Public: gather owned consumables ───────────────────────────────

function asObjectValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

function stripTags(html) {
  if (!html) return "";
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    return (tmp.textContent ?? tmp.innerText ?? "").trim();
  } catch {
    return String(html).replace(/<[^>]*>/g, "").trim();
  }
}

function extractSkillEntries(item) {
  const p = item?.system?.props ?? {};
  return [
    ...asObjectValues(p.item_skill_active),
    ...asObjectValues(p.active_skill_list),
    ...asObjectValues(p.skill_active_list),
  ].filter((e) => e && (e.uuid || e.skillUuid || e.skill_uuid || e.itemUuid));
}

function skillEntryName(entry) {
  return entry?.name ?? entry?.skillName ?? entry?.itemName ?? null;
}

function skillEntryUuid(entry) {
  return entry?.uuid ?? entry?.skillUuid ?? entry?.skill_uuid ?? entry?.itemUuid ?? null;
}

// ─── Public: the consumable's linked activation skill ───────────────
//
// A consumable carries its activation as a linked skill (skill_type "Item")
// in `item_skill_active` (or the legacy `active_skill_list` / `skill_active_list`
// aliases). That skill IS the Battle Director action definition — it holds the
// targeting (`skill_target`) + effect (effect_table / on_activate_effect_ref /
// recipe, or legacy type_damage + damage_bonus). The consumable itself is just
// the carrier + cost. The Item action resolves this skill and routes it through
// the shared Skill pipeline (see compose-action.js composeItem +
// state-handlers.js Item TARGET branch).
//
// Returns the first resolvable linked-skill uuid, else null (already-skill-
// shaped consumables that authored their effect onto the item have no link —
// callers fall back to the item itself).
export function getLinkedSkillUuid(item) {
  for (const entry of extractSkillEntries(item)) {
    const uuid = skillEntryUuid(entry);
    if (uuid) return uuid;
  }
  return null;
}

// Shape per candidate:
//   {
//     mode: "use",
//     id: string,                 // item id
//     uuid: string,               // item uuid
//     name: string,
//     img: string,
//     quantity: number|null,      // null when isUnique
//     isUnique: bool,
//     descriptionHtml: string,    // raw HTML for tooltip
//     skillNames: string[],       // for player awareness
//   }
//
// Note: deliberately does NOT carry the live Foundry Item document.
// `freezeActionResult` does a deep walk + freeze of everything on
// `actionResult`, and Foundry docs have circular references through
// actor.items → item.parent → actor → ... that blow the stack. RESOLVE
// re-fetches via `fromUuid(c.uuid)` instead.
export async function gatherConsumables(actor) {
  if (!actor) return [];
  const list = actor.system?.props?.consumable_list ?? {};
  const entries = asObjectValues(list);
  if (!entries.length) return [];

  const candidates = [];
  for (const entry of entries) {
    const uuid = entry?.uuid;
    if (!uuid) continue;
    let item = null;
    try { item = await fromUuid(uuid); }
    catch (e) { warn("gatherConsumables: fromUuid failed", uuid, e); continue; }
    if (!item) continue;

    const ip = item.system?.props ?? {};
    if (ip.item_type !== "consumable") continue;

    const isUnique = !!ip.isUnique;
    let quantity = null;
    if (!isUnique) {
      const live = Number(ip.item_quantity ?? NaN);
      const cached = Number(entry.quantity ?? NaN);
      quantity = Number.isFinite(live) ? live : (Number.isFinite(cached) ? cached : 0);
    }
    if (!isUnique && (quantity ?? 0) <= 0) continue;

    const skillEntries = extractSkillEntries(item);
    const skillNames = skillEntries.map(skillEntryName).filter(Boolean);
    const skillUuids = skillEntries.map(skillEntryUuid).filter(Boolean);

    candidates.push({
      mode: "use",
      id: item.id,
      uuid: item.uuid,
      name: entry.name ?? ip.name ?? item.name ?? "(unnamed)",
      img: item.img ?? "icons/svg/potion.svg",
      quantity,
      isUnique,
      descriptionHtml: String(entry.consume_description ?? ip.description ?? ""),
      skillNames,
      skillUuids,
    });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name, game.i18n?.lang));
  return candidates;
}

// ─── Public: gather creatable items (Inventory Points) ─────────────

function getItemCreateApi() {
  return (
    globalThis.FUCompanion?.api?.itemCreate ??
    game.modules?.get("fabula-ultima-companion")?.api?.itemCreate ??
    null
  );
}

// Shape per candidate:
//   {
//     mode: "create",
//     key: string,                // recipe key from API
//     name: string,
//     img: string,
//     ipCost: number,
//     baseIpCost: number,
//     recipeName: string,
//     descriptionHtml: string,
//     skillNames: string[],
//     itemUuid: string|null,      // for re-fetching the live doc in Phase B
//   }
//
// Note: deliberately does NOT carry the live Foundry Item document
// embedded in the upstream API result (`candidate.item`). Same reason
// as `gatherConsumables` — `freezeActionResult` deep-walks the result
// and Foundry docs have circular refs that blow the stack. Phase B can
// re-fetch the API list via `getCreatableItems` when it wires actual
// recipe execution; for v1 we only need the resource accounting.
export async function gatherCreatables(actor) {
  if (!actor) return [];
  const api = getItemCreateApi();
  if (!api?.getCreatableItems) {
    warn("gatherCreatables: itemCreate API missing");
    return [];
  }
  let list = [];
  try {
    list = await api.getCreatableItems({ actor, includeParty: true });
  } catch (e) {
    warn("gatherCreatables: API call threw", e);
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.map((c, idx) => {
    const skillEntries = Array.isArray(c.activeSkillEntries) ? c.activeSkillEntries : [];
    const skillNames = skillEntries.map(skillEntryName).filter(Boolean);
    const skillUuids = skillEntries.map(skillEntryUuid).filter(Boolean);
    return {
      mode: "create",
      key: c.key ?? `create-${idx}-${c.itemUuid ?? c.name}`,
      name: c.name ?? c.itemName ?? "(unnamed)",
      img: c.img ?? c.item?.img ?? "icons/svg/item-bag.svg",
      ipCost: Number(c.ipCost ?? 0) || 0,
      baseIpCost: Number(c.baseIpCost ?? c.ipCost ?? 0) || 0,
      recipeName: String(c.recipeName ?? ""),
      descriptionHtml: String(c.descriptionHtml ?? c.itemProps?.description ?? ""),
      skillNames,
      skillUuids,
      itemUuid: c.itemUuid ?? c.item?.uuid ?? null,
    };
  });
}

// ─── Public: helpers a card can call to format ─────────────────────

export function describeCandidateForTooltip(c) {
  const parts = [];
  if (c.descriptionHtml) parts.push(c.descriptionHtml);
  if (c.skillNames?.length) {
    parts.push(`<p><em>Skills:</em> ${c.skillNames.map((n) => `<strong>${n}</strong>`).join(", ")}</p>`);
  }
  if (c.mode === "create" && c.recipeName) {
    parts.push(`<p><em>Recipe:</em> ${c.recipeName}</p>`);
  }
  return parts.join("\n");
}

// ─── Public: actor IP read ─────────────────────────────────────────

export function readActorIp(actor) {
  const p = actor?.system?.props ?? {};
  const cur = Number(p.current_ip ?? 0) || 0;
  const max = Number(p.max_ip ?? 0) || 0;
  return { current: cur, max };
}

// ─── Public: commit helpers ─────────────────────────────────────────

// Consume one unit of a non-unique consumable. Mirrors the legacy
// action-execution-core consume path:
//   • isUnique → no-op (skipped: true)
//   • qty > 1   → decrement by 1
//   • qty <= 1  → delete the item entirely
export async function consumeOne(actor, item) {
  if (!actor || !item) return { ok: false, reason: "missing-args" };
  const p = item.system?.props ?? {};
  if (p.isUnique) return { ok: true, skipped: true, reason: "unique-not-consumed" };
  const cur = Number(p.item_quantity ?? 0);
  if (!Number.isFinite(cur) || cur <= 0) {
    return { ok: false, reason: "non-positive-qty" };
  }
  const next = cur - 1;
  try {
    if (next > 0) {
      await item.update({ "system.props.item_quantity": next });
      return { ok: true, before: cur, after: next, deleted: false };
    }
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
    return { ok: true, before: cur, after: 0, deleted: true };
  } catch (e) {
    warn("consumeOne: commit failed", e);
    return { ok: false, reason: "commit-failed", error: e };
  }
}

// Spend `cost` IP. Caller is expected to have gated affordability at
// picker time — this routine clamps at 0 but does NOT refuse the spend
// if the gate was bypassed (e.g. mid-pick IP changes from another
// action). Returns the new IP value or an error reason.
export async function spendIp(actor, cost) {
  if (!actor) return { ok: false, reason: "no-actor" };
  const n = Math.max(0, Number(cost) || 0);
  if (n === 0) return { ok: true, skipped: true, reason: "zero-cost" };
  const cur = Number(actor.system?.props?.current_ip ?? 0) || 0;
  const next = Math.max(0, cur - n);
  try {
    await actor.update({ "system.props.current_ip": next });
    return { ok: true, before: cur, after: next, spent: cur - next };
  } catch (e) {
    warn("spendIp: actor.update failed", e);
    return { ok: false, reason: "commit-failed", error: e };
  }
}
