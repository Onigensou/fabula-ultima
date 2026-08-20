// ============================================================================
// Gacha System — Banner registry
// ----------------------------------------------------------------------------
// Banners are DATA: every RollTable in BANNER_FOLDER_ID is a banner except the
// two shared rarity pools. Adding a banner is authoring a table — no edit here.
//
// A banner carries exactly two Equipment Sets: a MAIN set (the draw) and a
// FILLER set (the rest of the 5-star pool). Everything the banner card shows is
// derived rather than authored as an image:
//
//   title    = the MAIN set's name
//   epithet  = the RollTable's description  (authorable per banner)
//   lead     = the MAIN set's headline piece, by equipment slot priority
//   support  = the remaining main pieces, then the filler pieces
//
// That replaces the hand-made Banner_*_UI.png files, and with them the problem
// that two banners never had one.
// ============================================================================

import { BANNER_FOLDER_ID, POOL_TABLE_IDS, GACHA, warn } from "./gacha-const.js";

const POOL_IDS = new Set(Object.values(POOL_TABLE_IDS));

// Which piece represents a set. Every set in the world currently has a weapon,
// so this resolves to the weapon today; the rest of the ladder is the fallback
// for sets authored without one.
const SLOT_PRIORITY = ["weapon", "armor", "shield", "accessory"];

const slotRank = (item) => {
  const t = String(item?.system?.props?.item_type ?? "").trim().toLowerCase();
  const i = SLOT_PRIORITY.indexOf(t);
  return i === -1 ? SLOT_PRIORITY.length : i;
};

/** Strip the HTML a ProseMirror description field carries. */
function plainText(html) {
  const s = String(html ?? "").trim();
  if (!s) return "";
  const el = document.createElement("div");
  el.innerHTML = s;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ── Table → items ───────────────────────────────────────────────────────────

/**
 * Resolve a RollTable's results to concrete world Items.
 *
 * Results store `documentCollection` + `documentId` rather than a uuid, so
 * build it ourselves and fall back to a name lookup for text rows. Rows that
 * resolve to nothing are dropped — a broken row should degrade a banner, not
 * throw mid-pull.
 */
export function resolveTableItems(table) {
  const out = [];
  const seen = new Set();

  for (const res of table?.results?.contents ?? []) {
    let item = null;
    if (res.documentCollection === "Item" && res.documentId) {
      item = game.items?.get(res.documentId) ?? null;
    }
    if (!item && res.text) item = game.items?.getName(res.text) ?? null;
    if (!item || seen.has(item.id)) continue;

    seen.add(item.id);
    out.push({ item, name: item.name, img: item.img, uuid: item.uuid });
  }

  return out;
}

/** Group entries by CSB `set_name` (gated by `isSet`). */
export function groupBySet(entries) {
  const groups = new Map();

  for (const e of entries) {
    const p = e.item?.system?.props ?? {};
    const setName = p.isSet === true ? String(p.set_name ?? "").trim() : "";
    const key = setName || "—";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  return [...groups.entries()]
    .map(([setName, list]) => ({
      setName,
      entries: list.sort((a, b) => slotRank(a.item) - slotRank(b.item) || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.setName.localeCompare(b.setName));
}

// ── Main vs filler ──────────────────────────────────────────────────────────

/**
 * Decide which of a banner's sets is the MAIN one, in order:
 *
 *   1. an explicit override flag on the table
 *   2. the set whose name matches the banner's  (holds for 5 of 6 today)
 *   3. the set with the most pieces
 *
 * Rule 2 alone is not enough: the "Bloody Chivalry" banner's main set is named
 * "Bloodied Chivalry". Rule 3 happens to resolve that one correctly (4 pieces
 * vs 3), but the override exists so a future banner never depends on luck.
 */
function pickMainSet(table, groups) {
  if (!groups.length) return null;

  const override = String(
    table?.getFlag?.(GACHA.FLAG_NS, "gacha")?.mainSet ??
    table?.flags?.[GACHA.FLAG_NS]?.gacha?.mainSet ?? ""
  ).trim();
  if (override) {
    const hit = groups.find((g) => g.setName.toLowerCase() === override.toLowerCase());
    if (hit) return hit;
    warn(`Banner "${table.name}": mainSet override "${override}" matches no set on this banner.`);
  }

  const byName = groups.find((g) => g.setName.toLowerCase() === String(table.name).toLowerCase());
  if (byName) return byName;

  const biggest = [...groups].sort((a, b) => b.entries.length - a.entries.length)[0];
  warn(
    `Banner "${table.name}": no set matches the banner name; falling back to the largest ` +
    `set "${biggest.setName}". Set a mainSet flag on the table to be explicit.`
  );
  return biggest;
}

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Build the full display model for one banner.
 * @returns {{id,name,title,epithet,lead,support,mainSet,fillerSets,entries,table}|null}
 */
export function describeBanner(table) {
  if (!table) return null;

  const entries = resolveTableItems(table);
  const groups  = groupBySet(entries).filter((g) => g.setName !== "—");
  const main    = pickMainSet(table, groups);
  const fillers = groups.filter((g) => g !== main);

  // Entries are already slot-sorted by groupBySet, so the head IS the priority
  // pick: Weapon > Armor > Shield > Accessory.
  const lead = main?.entries?.[0] ?? entries[0] ?? null;

  const support = [
    ...(main?.entries ?? []).slice(1),
    ...fillers.flatMap((g) => g.entries),
  ];

  return {
    id: table.id,
    name: table.name,
    title: main?.setName || table.name,
    epithet: plainText(table.description),
    lead,
    support,
    mainSet: main ?? null,
    fillerSets: fillers,
    entries,
    table,
  };
}

/**
 * Every banner, sorted by the table's own `sort` then name — so tab order is
 * GM-controllable from the RollTable directory.
 */
export function listBanners() {
  const tables = (game.tables?.contents ?? []).filter(
    (t) => t.folder?.id === BANNER_FOLDER_ID && !POOL_IDS.has(t.id)
  );

  if (!tables.length) warn("No banner tables found in folder", BANNER_FOLDER_ID);

  tables.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
  return tables.map(describeBanner).filter(Boolean);
}

export function getBanner(bannerId) {
  const t = game.tables?.get(bannerId);
  if (!t || t.folder?.id !== BANNER_FOLDER_ID || POOL_IDS.has(t.id)) return null;
  return describeBanner(t);
}

/** The shared 3-star / 4-star pools. */
export function getPoolTable(rarityKey) {
  const id = POOL_TABLE_IDS[rarityKey];
  return id ? (game.tables?.get(id) ?? null) : null;
}

/** Foundry's own placeholder, for an item authored without art. */
export const FALLBACK_IMG = "icons/svg/item-bag.svg";
export const imgOf = (entry) => entry?.img || FALLBACK_IMG;
