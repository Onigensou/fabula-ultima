/**
 * Migration: 2026-11-25-hako-shop-roster  (Hako's equipment rerolls at Rest)
 * ---------------------------------------------------------------------------
 * User 2026-11-25: stop hand-picking Hako's roster every chapter. Her
 * equipment now rerolls from a curated pool at the camp Rest
 * (scripts/shop-system/shop-roster-*.js). This seeds that pool:
 *
 *   1. Pool = every equipment item Hako has ever stocked: her stealable_loot
 *      catalog (drag-drop history, see the shop stock history note) plus her
 *      current listings, resolved by name to the world item.
 *        - authoring "needed" for items whose effect text has no automation
 *          (carrier-scan 2026-11-25): kept out of rolls until authored;
 *          the GM console clears the mark.
 *        - Emergency-Radio retired (Support units are not in the game).
 *        - current listing prices become the pool prices.
 *   2. Consumable listings get flags…baseQty (Chapter 4 stock), which the
 *      Rest restock refills to. Tackle is left alone.
 *   3. Biker Suit + Heat HANDS Replica had no rarity → Rare (user 2026-11-25),
 *      world items and Hako's listing copy.
 *
 * SEED-ONLY: skipped when Hako already has the shopRoster flag; rarity is
 * only set where blank.
 */

export const key = "2026-11-25-hako-shop-roster";
export const description = "Hako: seed the randomized equipment roster (pool from her stock ledger, consumable refill quantities, rarity for Biker Suit / Heat HANDS Replica).";

const M = "fabula-ultima-companion";
const HAKO = "srAH3OHOoK0tvFih";
const EQUIP = ["weapon", "armor", "shield", "accessory"];
const EMBED_FOLDER = "CSB - Embedded Items Folder - DO NOT RENAME OR REMOVE";

// carrier-scan + effect names, 2026-11-25: effect text that nothing implements.
const NEEDS_AUTHORING = [
  "Mana Robe", "Gambler's Dice", "False Idol", "Copycat", "Dominatrix Leotard", "Ball Gag", "Biker Suit",
  "Lid Shield", "Fairy Tunic", "Defense Matrix", "Alpha Regalia", "Witch Hat", "Brief Respite", "Little Devil",
  "Ring of Onions", "Avalon", "Slimy Jacket", "Hekat Shield", "Vengueful Yoroi Old", "Enforcer Uniform",
  "Portable Cauldron",
];
const RETIRED = { "Emergency-Radio": "Support units (retired system)" };
const SET_RARE = ["Biker Suit", "Heat HANDS Replica"];
// Chapter 4 stock quantities (2026-11-21-hako-ch4-content ROSTER).
const BASE_QTY = {
  "Vaccine": 5, "Full Phoenix": 3, "Magic Mirror": 1, "Terrarium: Camp": 3, "Terrarium: Healing": 3,
  "Terrarium: Gathering": 3, "Terrarium: Random Battle": 3, "Terrarium: Blank": 3,
};

const decode = (s) => String(s ?? "").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
const worldItem = (name) => game.items.find((i) => decode(i.name) === decode(name) && !i.system?.container && i.folder?.name !== EMBED_FOLDER);
const typeOf = (doc) => String(doc?.system?.props?.item_type ?? "").toLowerCase();

export async function migrate(game, log = () => {}) {
  const hako = game.actors.get(HAKO);
  if (!hako) { log("Hako actor missing, skipped"); return { applied: false, summary: "no Hako" }; }
  const out = [];

  // 3. Rarity (independent of the seed gate).
  for (const name of SET_RARE) {
    const it = worldItem(name);
    if (it && !String(it.system?.props?.item_rarity ?? "").trim()) { await it.update({ "system.props.item_rarity": "Rare" }); out.push(`${name} → Rare`); }
    const listing = hako.items.find((i) => !i.system?.container && decode(i.name) === name);
    if (listing && !String(listing.system?.props?.item_rarity ?? "").trim()) await listing.update({ "system.props.item_rarity": "Rare" });
  }

  if (hako.flags?.[M]?.shopRoster) {
    log("Hako already has a roster; seed skipped");
    return { applied: true, summary: ["roster already seeded", ...out].join("; ") };
  }

  // 1. Pool from the ledger + current listings.
  const listings = hako.items.filter((i) => !i.system?.container);
  const catalog = Object.values(hako.system?.props?.stealable_loot ?? {}).map((r) => r?.name).filter(Boolean);
  const names = [...new Set([...catalog, ...listings.map((i) => i.name)].map(decode))];
  const priceNow = new Map(listings.filter((i) => EQUIP.includes(typeOf(i))).map((i) => [decode(i.name), Number(i.system.props.item_cost) || 0]));
  const pool = [], skipped = [];
  for (const name of names) {
    const it = worldItem(name);
    if (!it) { if (!BASE_QTY[name]) skipped.push(name); continue; }
    if (!EQUIP.includes(typeOf(it))) continue;
    const e = { id: it.id };
    if (priceNow.get(name) > 0) e.price = priceNow.get(name);
    if (NEEDS_AUTHORING.includes(name)) e.authoring = "needed";
    if (RETIRED[name]) e.retired = RETIRED[name];
    pool.push(e);
  }
  const current = listings.filter((i) => EQUIP.includes(typeOf(i))).map((i) => {
    const w = worldItem(i.name);
    return w ? { id: w.id, price: Number(i.system.props.item_cost) || 0 } : null;
  }).filter(Boolean);

  // 2. Consumable refill targets.
  const qtyUpdates = listings.filter((i) => typeOf(i) === "consumable").map((i) => ({
    _id: i.id,
    [`flags.${M}.baseQty`]: BASE_QTY[decode(i.name)] ?? Math.max(1, Number(i.system.props.item_quantity) || 1),
  }));
  if (qtyUpdates.length) await hako.updateEmbeddedDocuments("Item", qtyUpdates);

  await hako.update({
    [`flags.${M}.shopRoster`]: {
      enabled: true, locked: false, config: null, pool, current, previous: null,
      lastRestockAt: 0, lastCardId: null, history: [{ at: Date.now(), seed: null, reason: "Chapter 4 roster (hand-picked)", names: current.map((e) => game.items.get(e.id)?.name ?? e.id), repeats: 0 }],
    },
  });
  const authoring = pool.filter((e) => e.authoring).length;
  out.unshift(`pool ${pool.length} (${authoring} need authoring)`, `on sale ${current.length}`, `consumables tagged ${qtyUpdates.length}`);
  if (skipped.length) out.push(`not in world: ${skipped.join(", ")}`);
  log(out.join("; "));
  return { applied: true, summary: out.join("; ") };
}
