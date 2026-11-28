/**
 * Migration: 2026-11-28-opportunity-charms  (5 accessories that each grant an Opportunity)
 * ---------------------------------------------------------------------------
 * Designed with the user 2026-11-28 (chat). Goal: an indirect buff to Hina's Zero Power
 * "A Million Possibility" (3 distinct Opportunity picks) — more options on the wheel,
 * if she is lucky enough to find these.
 *
 *   Hex Coin           Uncommon  1500z  Opportunity Misfortune: 1d100 non-elemental damage, one enemy
 *   Doomsayer's Bell   Rare      2000z  Opportunity Calamity:   1d50 non-elemental damage, all enemies
 *   Mender's Ribbon    Uncommon  1500z  Opportunity Succor:     one creature recovers 50 HP
 *   Moonstone Pendant  Uncommon  1500z  Opportunity Calm:       one creature recovers 50 MP
 *   Saint's Rosary     Rare      2000z  Opportunity Sooth:      one creature recovers from all negative statuses
 *
 * Each item carries ONE equip-toggled AE setting flags.fabula-ultima-companion.opp_<id>
 * (Bunny Tail / Lucky pattern); the wheel option is gated by requiresFlag (opportunity-config.js).
 *
 * Loot (user): Uncommon → "<Dungeon> - Accessory", Rare → "<Dungeon> - Treasure", for
 * Vastwind Field, Bandits Hideout, The Wyrmwood, Valley of the Dragon, Fafnir Castle.
 * New rows fill range gaps first, then append; the formula becomes 1d<highest row>
 * (Bandits Hideout - Accessory had a gap at 6 and 1d11 with a row at 12).
 * Rare ones also join Hako's roster pool.
 *
 * SEED-ONLY: fixed item ids, rows deduped by documentId. Re-running creates nothing twice.
 */

export const key = "2026-11-28-opportunity-charms";
export const description = "Hex Coin, Doomsayer's Bell, Mender's Ribbon, Moonstone Pendant, Saint's Rosary (gear-granted Opportunities) + dungeon loot rows + Hako pool.";

const M = "fabula-ultima-companion";
const FLAG = "opportunityCharms";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const HAKO = "srAH3OHOoK0tvFih";
const DONOR = "6fN45LX3i4bmqIFY";               // Mage Hat (plain accessory)
const FOLDER = { uncommon: "6mmwacB3WSm0f9bN", rare: "5uQIy5BCy7UEVfcT" };   // Accessories / Rare Accessories
const PRICE = { Uncommon: 1500, Rare: 2000 };

const B = (s) => `<strong>${s}</strong>`;
const grant = (opp, effect) =>
  `<ul><li><p>You gain a new ${B("Opportunity")}, 【⏳${B(opp)}】</p></li></ul><blockquote><p>${effect}</p></blockquote>`;
const em = (t) => `<p><em>${t}</em></p>`;

const ITEMS = [
  { id: "OppCharmHexCoin1", ae: "OppCharmHexCnAE1", opp: "misfortune", oppLabel: "Misfortune", name: "Hex Coin", rarity: "Uncommon",
    img: `${FORGE}Item%20Icon/Accessories/Ys/Gambler_Coin.webp`,
    effect: `Deals ${B("【1d100】")} non-elemental damage to one enemy.`,
    flavor: "Both faces show the same grinning skull. Whoever calls it, someone else loses." },
  { id: "OppCharmDoomBel1", ae: "OppCharmDoomBAE1", opp: "calamity", oppLabel: "Calamity", name: "Doomsayer's Bell", rarity: "Rare",
    img: `${FORGE}Item%20Icon/Weapon/FF%20Brave%20Exvius%20Weapon/Instrument/Icon-Rune_Bell.webp`,
    effect: `Deals ${B("【1d50】")} non-elemental damage to all enemies.`,
    flavor: "Rung once by a prophet who was right about everything. Nobody thanked him." },
  { id: "OppCharmMendRib1", ae: "OppCharmMendRAE1", opp: "succor", oppLabel: "Succor", name: "Mender's Ribbon", rarity: "Uncommon",
    img: `${FORGE}Item%20Icon/Armor/FF%20Brave%20Exvius/Icon-Big_Red_Ribbon.webp`,
    effect: `One creature recovers ${B("50")} HP.`,
    flavor: "Tied around a wound by a stranger who never gave a name." },
  { id: "OppCharmMoonPen1", ae: "OppCharmMoonPAE1", opp: "calm", oppLabel: "Calm", name: "Moonstone Pendant", rarity: "Uncommon",
    img: `${FORGE}Item%20Icon/Accessories/Ys/Blue_Moon_Charm.webp`,
    effect: `One creature recovers ${B("50")} MP.`,
    flavor: "Cool to the touch even at noon. Holding it slows the breath." },
  { id: "OppCharmSaintRo1", ae: "OppCharmSaintAE1", opp: "sooth", oppLabel: "Sooth", name: "Saint's Rosary", rarity: "Rare",
    img: `${FORGE}Item%20Icon/Accessories/Ys/Ys9-Apis_Bead.webp`,
    effect: `One creature recovers from all negative statuses.`,
    flavor: "Worn smooth by a hundred years of prayers. A few of them were answered." },
];

const DUNGEONS = [
  { name: "Vastwind Field",       accessory: "oDiuDJRoayGJwr1L", treasure: "dRN7ElUZH86RVl4e" },
  { name: "Bandits Hideout",      accessory: "jlDJQx6WUtsw7npK", treasure: "xcvyadSZsEqYvjJA" },
  { name: "The Wyrmwood",         accessory: "CRGj5HutohiPQnl1", treasure: "hS4XNu1vLtWbPSne" },
  { name: "Valley of the Dragon", accessory: "86Lj4WaVPFkt286A", treasure: "DMeYaPoSPUxH6xVE" },
  { name: "Fafnir Castle",        accessory: "h2UugZ9iirGWux94", treasure: "aK4ojp7R73e7cKzj" },
];

const oppAe = (it) => ({
  _id: it.ae, name: `${it.oppLabel} Opportunity`, img: it.img, transfer: true, disabled: false, statuses: [], type: "base",
  system: {}, sort: 0, tint: "#ffffff", description: "", duration: {}, origin: null,
  changes: [{ key: `flags.${M}.opp_${it.opp}`, mode: 5, priority: 20, value: "${isEquipped ? 1 : 0}$" }],
  flags: { [M]: { [FLAG]: "ae" } },
});

const STRIP_PROPS = { item_skill_passive: {}, item_skill_active: {}, related_item_list: {}, item_activeEffect: "" };
function buildItem(it) {
  const donor = game.items.get(DONOR);
  if (!donor) throw new Error(`donor ${DONOR} missing`);
  const d = donor.toObject();
  const folder = it.rarity === "Rare" ? FOLDER.rare : FOLDER.uncommon;
  d._id = it.id; d.name = it.name; d.img = it.img; d.folder = game.folders.get(folder) ? folder : null;
  d.effects = [oppAe(it)];
  d.system.container = null; d.system.uniqueId = it.id;
  d.system.props = {
    ...d.system.props, ...STRIP_PROPS,
    name: it.name, id: it.id, uuid: `Item.${it.id}`, img: it.img,
    item_type: "accessory", item_rarity: it.rarity, item_cost: String(PRICE[it.rarity]),
    isEquipped: false, isSet: false, set_name: "", set_description: "",
    item_def_bonus: "0", item_mdef_bonus: "0",
    description: grant(it.oppLabel, it.effect), flavor_text: em(it.flavor),
  };
  d.flags = { "custom-system-builder": d.flags?.["custom-system-builder"] ?? {}, [M]: { [FLAG]: "created" } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}

async function createItems(out) {
  for (const it of ITEMS) {
    if (game.items.get(it.id)) { out.push(`= ${it.name}`); continue; }
    await Item.createDocuments([buildItem(it)], { keepId: true });
    out.push(`+ ${it.name}`);
  }
}

// Fill range gaps first, then append; formula = 1d<highest row end>.
async function addRows(tableId, ids, out) {
  const t = game.tables.get(tableId);
  if (!t) { out.push(`! table ${tableId} missing`); return; }
  const have = new Set(t.results.map((r) => r.documentId));
  const used = new Set();
  for (const r of t.results) for (let n = r.range[0]; n <= r.range[1]; n++) used.add(n);
  const rows = [];
  let n = 1;
  for (const id of ids) {
    if (have.has(id)) continue;
    const it = game.items.get(id);
    if (!it) continue;
    while (used.has(n)) n++;
    used.add(n);
    rows.push({ type: "document", documentCollection: "Item", documentId: id, text: it.name, img: it.img, weight: 1, range: [n, n], drawn: false });
  }
  if (rows.length) await t.createEmbeddedDocuments("TableResult", rows);
  const max = Math.max(0, ...t.results.map((r) => r.range[1]));
  const formula = `1d${max}`;
  const fixed = t.formula !== formula;
  if (fixed) await t.update({ formula });
  out.push(rows.length || fixed ? `~ ${t.name} +${rows.length} (${formula})` : `= ${t.name}`);
}

async function addToHako(out) {
  const hako = game.actors.get(HAKO);
  const st = hako?.flags?.[M]?.shopRoster;
  if (!st) { out.push("! Hako roster missing, pool not updated"); return; }
  const pool = [...(st.pool ?? [])];
  let added = 0;
  for (const it of ITEMS.filter((i) => i.rarity === "Rare")) {
    if (pool.some((e) => e.id === it.id)) continue;
    pool.push({ id: it.id, price: PRICE.Rare }); added++;
  }
  if (!added) { out.push("= Hako pool"); return; }
  await hako.update({ [`flags.${M}.shopRoster.pool`]: pool });
  out.push(`~ Hako pool +${added}`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await createItems(out);
  const unc = ITEMS.filter((i) => i.rarity === "Uncommon").map((i) => i.id);
  const rare = ITEMS.filter((i) => i.rarity === "Rare").map((i) => i.id);
  for (const d of DUNGEONS) {
    await addRows(d.accessory, unc, out);
    await addRows(d.treasure, rare, out);
  }
  await addToHako(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
