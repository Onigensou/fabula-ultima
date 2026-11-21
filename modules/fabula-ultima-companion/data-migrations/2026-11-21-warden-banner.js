/**
 * Migration: 2026-11-21-warden-banner  (Chapter 4 gacha banner)
 * ---------------------------------------------------------------------------
 * User-approved 2026-11-21 ("Gacha banner, build it now"). Adds the banner
 * RollTable "Warden of the Wilds" to the gacha banner folder. Banners are data
 * (scripts/gacha-system/gacha-banners.js): every table in the folder is a
 * banner, title = main set name, epithet = table description, the card art is
 * composed in code from the items. Same shape as the existing banners:
 * 1dN, one weight-1 document row per piece, replacement on.
 *
 *   main   Warden of the Wilds · 4 (Kindred Spirit, Hunter's Mantle, Hunter Boots, Kindred Feather)
 *   filler Luchador · 3 (Luchador Gloves, Luchador Pant, Luchador Mask)
 *
 * Runs AFTER luchador-author and warden-hawk-author (both sets must work —
 * a banner goes live as soon as the table exists).
 *
 * SEED-ONLY: fixed table id; skipped when it exists.
 */

export const key = "2026-11-21-warden-banner";
export const description = "Gacha: add the Warden of the Wilds banner (Warden main set + Luchador filler).";

const M = "fabula-ultima-companion";
const TABLE_ID = "HkC4WardenBanner";
const BANNER_FOLDER_ID = "QGWhvmRAHt4ibvnG";
const OWNER_USER = "JQGNzKpDPHJmcUIW";          // same ownership as the other banners
const EPITHET = "Call of the Spirit Hawk";
const PIECES = [
  "aTVhiVRcHZpMinbg", // Kindred Spirit (bow, lead)
  "09KjioTnamwnRFv4", // Hunter's Mantle
  "duaQp4cjNOboR9Gk", // Hunter Boots
  "Z4juGssM2ArmX7Vq", // Kindred Feather
  "r0dthPszZhHz2SVH", // Luchador Gloves
  "e4fETqmxyFgqnGDO", // Luchador Pant
  "j66zqDzOEsqBntxo", // Luchador Mask
];

export async function migrate(game, log = () => {}) {
  if (game.tables.get(TABLE_ID)) { log("Warden banner exists, skipped"); return { applied: true, summary: "exists" }; }
  if (!game.folders.get(BANNER_FOLDER_ID)) { log("banner folder missing, skipped"); return { applied: false, summary: "no banner folder" }; }
  const items = PIECES.map((id) => game.items.get(id));
  const missing = PIECES.filter((id, i) => !items[i]);
  if (missing.length) { log(`missing pieces ${missing.join(",")}, skipped`); return { applied: false, summary: "missing pieces" }; }
  const results = items.map((it, i) => ({
    type: "document", text: it.name, documentCollection: "Item", documentId: it.id,
    img: it.img, weight: 1, range: [i + 1, i + 1], drawn: false,
  }));
  const data = {
    _id: TABLE_ID, name: "Warden of the Wilds", folder: BANNER_FOLDER_ID,
    description: `<p>${EPITHET}</p>`, img: items[0].img,
    formula: `1d${results.length}`, replacement: true, displayRoll: true,
    ownership: { default: 0, [OWNER_USER]: 3 },
    results,
    flags: { [M]: { gacha: { mainSet: "Warden of the Wilds" }, hakoCh4: true } },
  };
  await RollTable.createDocuments([data], { keepId: true });
  log(`Warden of the Wilds banner created (${results.length} rows)`);
  return { applied: true, summary: "Warden banner created" };
}
