/**
 * Migration: 2026-11-17-place-badge  (dungeon tiles that lead to a place)
 * ---------------------------------------------------------------------------
 * Seeds the new per-tile "Place badge" setting (dp-place-badge.js):
 *   flags.fabula-ultima-companion.dungeonPathing.placeBadge = "on" | "afterVisit"
 *
 *  1. Tile presets (Monk's Active Tiles "tile-templates"): Event, Story,
 *     Final Story and Settlement tiles come with "on". Doors and teleporters
 *     get nothing.
 *  2. Existing dungeon tiles that teleport to an exploration map, per the
 *     user-approved audit and calls (2026-11-17): the Overworld's 7 place
 *     nodes On, Sealed Cavern's way back to the Nether Bridge After visit,
 *     Winding Trail's Maelstrom Confluence tile (the current one; the old
 *     Waterfall Trail spot became the Plasma Field story tile) On. Exit doors
 *     back to an entrance hub stay off.
 *
 * ONE-TIME and SEED-ONLY: a tile or preset that already has a placeBadge value
 * (someone set it by hand) is left alone.
 */

export const key = "2026-11-17-place-badge";
export const description = "Place badge: On for Event/Story/Final Story/Settlement presets and the approved existing tiles.";

const M = "fabula-ultima-companion";
const ROOT = "dungeonPathing";

const PRESET_NAMES = new Set(["Event Tile", "Story Tile", "Final Story Tile", "Settlement Tile"]);

// [sceneId, tileId, value, note]
const TILES = [
  ["09CApvaBfOesGfbp", "BixtfXhqb8nHi1Ln", "on",         "Underground Area: Event -> Ancient Mural"],
  ["09CApvaBfOesGfbp", "I87y14MEgmH9XTpr", "on",         "Underground Area: Event -> Underground Lake"],
  ["09CApvaBfOesGfbp", "UiPqiCi2aPctAtmU", "on",         "Underground Area: Event -> Cave Dwelling"],
  ["09CApvaBfOesGfbp", "pS0b6DNaLc7WBw7S", "afterVisit", "Underground Area: Door -> Nether Bridge (surprise)"],
  ["67ucunbbGU3GvUUX", "vGWbspgGeBQsHQcf", "on",         "Monastery Road: Story -> Abandoned Monastery"],
  ["EtlYqCkE1aTvbwKo", "MZoFirYmBn2KJ66Q", "on",         "Summit Trail: Story -> Sacrificial Altar"],
  ["ST03Wjy5ZaVRND4m", "uIfufi9iQR9uBhOR", "on",         "Pit Road: Story -> Feeding Pit"],
  ["QIUobWQvzsjvZK08", "zFBbLgmEcKr54MGB", "on",         "Lower Trail: Story (expired) -> Thunder Pillar"],
  ["KvNYZ6DkF9IK3U6h", "xZO7bh6UmJKpMmPk", "on",         "Chain Bridges: Story -> Hatchery"],
  ["iQ026ac7nbWz8Mnr", "DbsLHvAlZZCF5mUX", "on",         "Treasury: Final Story -> Treasure Hoard"],
  // User calls 2026-11-17
  ["52LLgHZIyAXBrbMq", "7Votn2FymkL4dw9l", "afterVisit", "Sealed Cavern: Event -> Nether Bridge (secret area's way back)"],
  ["8ZqllaT165aEOEOn", "1pGpqDXOEbRuktpc", "on",         "Winding Trail: Story art (named Blank) -> Maelstrom Confluence (current spot)"],
  ["ozujmDgZuATRvJXh", "11zDhVTxp5oA1LxM", "on",         "Overworld: Door -> Wyrmwood - Entrance"],
  ["ozujmDgZuATRvJXh", "9qA6DIADFBc3AeN6", "on",         "Overworld: Door -> Fafnir Castle - Entrance"],
  ["ozujmDgZuATRvJXh", "ECOhLDxXgUOXMusM", "on",         "Overworld: Settlement -> Eisendrache Capital"],
  ["ozujmDgZuATRvJXh", "JAzmKs0x0MCBrUm7", "on",         "Overworld: Door -> Ruhig Village"],
  ["ozujmDgZuATRvJXh", "kdzqDChTijA3ELoT", "on",         "Overworld: Settlement -> Ancient Capital Midgard"],
  ["ozujmDgZuATRvJXh", "l3fQYBQOI5C5SKLD", "on",         "Overworld: Door -> Valley Entrance"],
  ["ozujmDgZuATRvJXh", "xy0NAo2VugI9gi0E", "on",         "Overworld: Door -> Sacrificial Altar (Valley exit)"],
];

export async function migrate(game, log) {
  const out = [];

  // 1. Presets
  let presets = 0;
  try {
    const templates = foundry.utils.duplicate(game.settings.get("monks-active-tiles", "tile-templates") ?? []);
    const walk = (arr) => {
      for (const t of arr ?? []) {
        if (Array.isArray(t?.children)) walk(t.children);
        if (!PRESET_NAMES.has(t?.name)) continue;
        const cur = t.flags?.[M]?.[ROOT]?.placeBadge;
        if (cur !== undefined && cur !== null && cur !== "") continue;
        foundry.utils.setProperty(t, `flags.${M}.${ROOT}.placeBadge`, "on");
        presets++;
      }
    };
    walk(templates);
    if (presets) await game.settings.set("monks-active-tiles", "tile-templates", templates);
    out.push(`${presets} preset(s)`);
  } catch (e) {
    log?.(`presets skipped: ${e?.message ?? e}`);
    out.push("presets skipped (Monk's Active Tiles not active?)");
  }

  // 2. Existing tiles
  let tiles = 0, missing = 0, kept = 0;
  for (const [sceneId, tileId, value, note] of TILES) {
    const tile = game.scenes.get(sceneId)?.tiles?.get(tileId);
    if (!tile) { missing++; log?.(`missing: ${note}`); continue; }
    const cur = tile.flags?.[M]?.[ROOT]?.placeBadge;
    if (cur !== undefined && cur !== null && cur !== "") { kept++; continue; }
    await tile.update({ [`flags.${M}.${ROOT}.placeBadge`]: value });
    tiles++;
  }
  out.push(`${tiles} tile(s) set, ${kept} already set, ${missing} not in this world`);

  return { applied: true, summary: out.join("; ") };
}
