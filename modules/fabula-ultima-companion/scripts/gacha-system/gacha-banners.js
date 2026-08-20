// ============================================================================
// Gacha System — Banner registry
// ----------------------------------------------------------------------------
// Banners are DATA, not code: every RollTable in BANNER_FOLDER_ID is a banner
// except the two shared rarity pools. Adding a banner is authoring a table and
// dropping matching art — no edit here.
//
// Art convention (matches the tiles this overlay replaces):
//   .../Image/UI/Gacha Banner/Banner_<TableNameWithoutSpaces>_UI.png
// e.g. "Tidal Predator" -> Banner_TidalPredator_UI.png
// ============================================================================

import { BANNER_FOLDER_ID, POOL_TABLE_IDS, warn } from "./gacha-const.js";

const ART_BASE =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/" +
  "The%20Legend%20of%20Dragonslayer/Image/UI/Gacha%20Banner/";

const POOL_IDS = new Set(Object.values(POOL_TABLE_IDS));

/** "Tidal Predator" -> ".../Banner_TidalPredator_UI.png" */
export function bannerArtFor(tableName) {
  const slug = String(tableName ?? "").replace(/\s+/g, "");
  return `${ART_BASE}Banner_${encodeURIComponent(slug)}_UI.png`;
}

/**
 * Every banner in the folder, sorted by the table's own `sort` then name so the
 * tab order is GM-controllable from the RollTable directory.
 *
 * @returns {Array<{id, name, table, art}>}
 */
export function listBanners() {
  const tables = (game.tables?.contents ?? []).filter(
    (t) => t.folder?.id === BANNER_FOLDER_ID && !POOL_IDS.has(t.id)
  );

  if (!tables.length) warn("No banner tables found in folder", BANNER_FOLDER_ID);

  tables.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));

  return tables.map((t) => ({
    id: t.id,
    name: t.name,
    table: t,
    art: bannerArtFor(t.name),
  }));
}

export function getBanner(bannerId) {
  const t = game.tables?.get(bannerId);
  if (!t || t.folder?.id !== BANNER_FOLDER_ID || POOL_IDS.has(t.id)) return null;
  return { id: t.id, name: t.name, table: t, art: bannerArtFor(t.name) };
}

/** The shared 3-star / 4-star pools. */
export function getPoolTable(rarityKey) {
  const id = POOL_TABLE_IDS[rarityKey];
  return id ? (game.tables?.get(id) ?? null) : null;
}

/**
 * Resolve a RollTable's results to concrete world Items.
 *
 * Table results store `documentCollection` + `documentId` rather than a uuid,
 * so build the uuid ourselves and fall back to a name lookup for text rows.
 * Rows that resolve to nothing are dropped — a banner with a broken row should
 * degrade, not throw mid-pull.
 *
 * @returns {Array<{item, name, img, uuid}>}
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

/**
 * Group a banner's items by CSB `set_name`, which is already authored and
 * correct across the existing banners. A single banner routinely carries two
 * distinct sets (e.g. "Oathsworn Paladin" holds both Oathsworn Paladin and
 * Lovely Retainer pieces), and the Gift Exchange treats the SET — never the
 * banner — as the swap boundary. Presenting them grouped keeps that rule
 * legible instead of arbitrary.
 *
 * @returns {Array<{setName: string, entries: Array}>}
 */
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
      entries: list.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.setName.localeCompare(b.setName));
}
