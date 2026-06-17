// pickItem — the Item action's source-selection step (Item's "pickSkill").
//
// Thin builder over the shared list-picker (list-picker.js): gathers the actor's
// usable consumables + IP-affordable recipes, groups them into Use / Create
// sections, maps each to a list-picker row, and delegates rendering + lifecycle
// + keyboard to pickFromList. The chosen row's `value` IS the return contract.
// After this, composeItem runs the SHARED targeting and the action flows through
// the one pipeline exactly like a Skill — no Item-specific path downstream.
//
// Returns: { mode:"use"|"create", key, cost, uuid, name } | null (cancelled).

import { gatherConsumables, gatherCreatables, readActorIp, describeCandidateForTooltip } from "./item-resource.js";
import { pickFromList } from "./list-picker.js";
import { log, warn } from "./logger.js";
import { classifyActionIntent } from "./skill-intent.js";

// Does a consumable survive a `disable_action_intent` filter? FAIL-OPEN: a
// consumable is blocked ONLY when we can POSITIVELY prove it's non-harmful —
//   1. it has linked activation skills and EVERY one is filtered (all aid), OR
//   2. it's genuinely skill-shaped (`skill_type` set) and classifies as filtered.
// Everything else SHOWS. Legacy/flavor consumables carry no machine-readable
// intent (most inherit a junk weapon-template `type_damage: "Physical"`, with
// empty effect tables), so we CANNOT distinguish a damaging shard from a heal —
// and over-blocking would wrongly hide harmful items the dominated creature
// should be able to use (e.g. an elemental shard on a now-enemy ally). Reliable
// per-consumable enforcement needs an explicit intent tag on the items (future
// work). Async (linked skills resolve via fromUuid).
async function consumableSurvivesIntentFilter(c, excludeIntents) {
  if (!excludeIntents || !excludeIntents.size) return true;
  const uuids = Array.isArray(c?.skillUuids) ? c.skillUuids.filter(Boolean) : [];
  if (uuids.length) {
    for (const u of uuids) {
      const sk = await fromUuid(u).catch(() => null);
      if (sk && !excludeIntents.has(classifyActionIntent(sk))) return true;
    }
    return false;   // has links and ALL are filtered → positively non-harmful
  }
  const item = await fromUuid(c?.uuid).catch(() => null);
  const skillType = String(item?.system?.props?.skill_type ?? "").trim();
  if (item && skillType && excludeIntents.has(classifyActionIntent(item))) return false;
  return true;   // no positive non-harmful signal → fail OPEN (don't over-block)
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
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

function safeImg(img, fallback) {
  return img && !/['"<>\n\r]/.test(img) ? img : fallback;
}

// Secondary line — linked skill names (+ recipe name for Create), mirroring
// buildItemCard's formatMeta.
function metaSecondary(c) {
  const parts = [];
  if (c.skillNames?.length) parts.push(escapeHtml(c.skillNames.join(", ")));
  if (c.mode === "create" && c.recipeName) parts.push(`Recipe: ${escapeHtml(c.recipeName)}`);
  return parts.map((p) => `<span class="bullet">${p}</span>`).join(` <span class="dot">•</span> `);
}

// Consumable → row. The value object IS pickItem's return contract for "use".
function useRow(c) {
  const qty = c.isUnique ? "∞" : (c.quantity ?? 0);
  const intentDisabled = c._intentDisabled || null;
  return {
    value: { mode: "use", key: c.id, cost: 0, uuid: c.uuid, name: c.name },
    imageUrl: safeImg(c.img, "icons/svg/potion.svg"),
    primary: escapeHtml(c.name),
    secondary: metaSecondary(c),
    secondaryNoWrap: true,
    badge: intentDisabled ? escapeHtml(intentDisabled) : `x${qty}`,
    badgeTone: intentDisabled ? "danger" : undefined,
    disabled: !!intentDisabled,
    tooltip: { name: c.name, body: stripHtml(describeCandidateForTooltip(c) || "(no description)") },
  };
}

// Recipe → row. Disabled + danger badge when its IP cost exceeds current IP.
function createRow(c, curIp) {
  const unaffordable = Number(c.ipCost) > curIp;
  const intentDisabled = c._intentDisabled || null;
  return {
    value: { mode: "create", key: c.key, cost: c.ipCost, uuid: c.itemUuid, name: c.name },
    imageUrl: safeImg(c.img, "icons/svg/item-bag.svg"),
    primary: escapeHtml(c.name),
    secondary: metaSecondary(c),
    secondaryNoWrap: true,
    badge: intentDisabled ? escapeHtml(intentDisabled) : `${c.ipCost} IP`,
    badgeTone: (intentDisabled || unaffordable) ? "danger" : null,
    disabled: !!intentDisabled || unaffordable,
    tooltip: { name: c.name, body: stripHtml(describeCandidateForTooltip(c) || "(no description)"), cost: `${c.ipCost} IP` },
  };
}

export async function pickItem({ director, actor, externalCancel = null, excludeIntents = null } = {}) {
  if (!actor) return null;

  let [useList, createList] = await Promise.all([
    gatherConsumables(actor).catch((e) => { warn("pickItem: gatherConsumables threw", e); return []; }),
    gatherCreatables(actor).catch((e) => { warn("pickItem: gatherCreatables threw", e); return []; }),
  ]);

  // `disable_action_intent` filter (e.g. Charm/Domination): DIM + label (don't
  // hide) consumables/recipes with no allowed use. Crafting an ATTACK item (e.g.
  // an Elemental Shard) IS a harmful action, so Create rows are classified per
  // recipe — by the item they PRODUCE (itemUuid) — not blanket-dimmed. Rows stay
  // visible, matching the disabled menu.
  if (excludeIntents && excludeIntents.size) {
    const reason = [...excludeIntents.values()][0] || "Disabled";
    const useSurv = await Promise.all(useList.map((c) => consumableSurvivesIntentFilter(c, excludeIntents)));
    useList.forEach((c, i) => { if (!useSurv[i]) c._intentDisabled = reason; });
    const createSurv = await Promise.all(createList.map((c) =>
      consumableSurvivesIntentFilter({ skillUuids: c.skillUuids, uuid: c.itemUuid }, excludeIntents)));
    createList.forEach((c, i) => { if (!createSurv[i]) c._intentDisabled = reason; });
  }

  if (!useList.length && !createList.length) {
    ui.notifications?.warn("No consumables to use and no recipes to create.");
    return null;
  }

  const ip = readActorIp(actor);
  const curIp = Number(ip?.current ?? 0) || 0;
  const maxIp = Number(ip?.max ?? 0) || 0;

  // Use + Create become two sections. With both present the list-picker renders
  // them as tabs (tabbed mode, ≥2 sections); with only one type it falls back to
  // a plain single list. The IP budget rides on the Create section's hint/tab.
  // Always emit BOTH tabs even when one is empty (the empty tab stays present +
  // clickable, showing an empty-state line). The both-empty case already
  // returned above, so at least one tab has rows.
  const sections = [
    {
      label: "Use",
      hint: `${useList.length} consumable${useList.length === 1 ? "" : "s"}`,
      items: useList.map(useRow),
      emptyText: "No consumables to use.",
    },
    {
      label: "Create",
      hint: `IP ${curIp}/${maxIp}`,
      items: createList.map((c) => createRow(c, curIp)),
      emptyText: "No recipes you can craft.",
    },
  ];

  log(`pickItem: ${useList.length} use / ${createList.length} create (IP ${curIp}/${maxIp})`);

  // The shared list-picker returns the chosen row's `value`
  // ({mode, key, cost, uuid, name}) or null on cancel — the old contract.
  return pickFromList({
    director,
    title: "Item",
    subtitle: "Use a consumable • Spend IP to craft",
    sections,
    externalCancel,
    autoFocusFirst: true,
    numberShortcuts: false,
    tabbed: true,
    width: 420,
    listHeight: "min(56vh, 440px)",  // consistent size across selector pickers
    zIndex: 96,
  });
}
