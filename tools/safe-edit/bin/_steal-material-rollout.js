"use strict";
// Valley of the Dragon + Fafnir Castle steal-table rollout (2026-10-08).
//
// 1. Creates the new Material items (cloned off Animal Fang) in the world.
// 2. Embeds each monster's loot items and writes stealable_loot +
//    steal_percentage_table.
//
// Budget rule: a monster's MATERIAL share (and its EQUIPMENT share) is one
// budget split across however many items it holds, so adding a second
// material never eats into the consumable / equipment odds.
//
// Idempotent: an existing material (by name) is reused, an item already
// embedded on the actor (by name) is not embedded twice, and both tables are
// assigned outright (never merged) so a re-run cannot leave stale rows.
//
// Dry by default. `--apply` writes; the game must be CLOSED.

const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const { assertGameClosed } = require("../lib/lock");
const { newDocId } = require("../lib/edit");
const journal = require("../lib/journal");
const { DEFAULT_WORLD } = require("../lib/paths");

const APPLY = process.argv.includes("--apply");
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/";
const DONOR = "oAP85eeLJCliYm2E";          // Animal Fang
const MATERIAL_FOLDER = "36rowiHAcXnIPsKK"; // 💎 Material
const EMPTY = "(Empty)";
const LOOT_TYPES = new Set(["material", "consumable", "weapon", "armor", "accessory", "shield"]);

// name, cost, rarity, taste ("" = not an ingredient), icon, flavor
const MATERIALS = [
  ["Obsidian", 120, "Common", "", "Material/Genshin/Item_Noctilucous_Jade.webp",
    "Volcanic glass, black and sharp enough to cut the hand that picks it up."],
  ["Fish Fin", 60, "Common", "umami", "Material/RO/951.gif",
    "A stiff, translucent fin. Still smells faintly of the river."],
  ["Draconic Essence", 250, "Uncommon", "sour", "Material/Genshin/Item_Dracolite.webp",
    "An ancient lifeforce essence containing faint power of the dragons."],
  ["Mystic Horn", 400, "Uncommon", "bitter", "Material/Genshin/Item_Black_Bronze_Horn.webp",
    "A horn capable of storing a vast amount of magical energy."],
  ["Clear Liquid", 80, "Common", "sweet", "Material/Genshin/Item_Spring_of_the_First_Dewdrop.webp",
    "An unknown liquid from certain types of monsters."],
  ["Eyeball", 90, "Common", "umami", "Material/Genshin/Item_Fractured_Eye_of_the_Deep_Shadow.webp",
    "It does not blink. You are fairly sure it is still looking at you."],
  ["Steel", 150, "Common", "", "Material/RO/999.gif",
    "A dented slab of armor plate pried off something much larger than you."],
  ["Tentacle", 180, "Common", "salty", "Tako.png",
    "A tentacle from a monster."],
];

// actor id → [name, rows]; rows are [loot name, percentage] in table order.
const TABLES = {
  // ── Valley of the Dragon ──
  A1VzokzJPoyxobCd: ["Electro Slime", [[EMPTY, 44], ["Jellopy", 40], ["Elemental Shard", 11], ["Topaz Pendant", 5]]],
  sTGMdYipYCG36aBO: ["Lightning Prism", [[EMPTY, 46], ["Lightning Essence", 37], ["Tincture of Spirit", 11], ["Lightning Wand", 6]]],
  I2sSkVIQ4FCunZBE: ["Skizzik", [[EMPTY, 45], ["Lightning Essence", 39], ["Tincture of Precision", 10], ["Lightning Greaves", 6]]],
  x8TBsDZaRgoSo5no: ["Obsidrax", [[EMPTY, 47], ["Obsidian", 37], ["Earth Stone", 10], ["Elemental Ward", 6]]],
  iGc0EUHE9LKWT0Ye: ["Mana Ray", [[EMPTY, 45], ["Fish Fin", 38], ["Tincture of Spirit", 11], ["Mana Catcher", 6]]],
  kAYN54Id3iTAOw1A: ["Ampere", [[EMPTY, 45], ["Fish Fin", 22], ["Draconic Essence", 16], ["Tincture of Endurance", 11], ["Silver Bolt", 6]]],
  H6Ubup6kmkgNQzLU: ["Drakoza", [[EMPTY, 46], ["Draconic Essence", 36], ["Polymorph Potion: Drakoza", 12], ["Dragontrap Bow", 6]]],
  TvLv878yZLNUAWNN: ["Kirin", [[EMPTY, 42], ["Mystic Horn", 36], ["Tincture of Strength", 15], ["Lightning Rod", 7]]],
  "8kluKkqkcGFkmXNO": ["Mist Dragon", [[EMPTY, 42], ["Draconic Essence", 36], ["Polymorph Potion: Mist Dragon", 15], ["Dragonslayer Pendant", 7]]],
  // Elite, but wired like a boss: one equipment at 100%, nothing else.
  "0AwQ7wEDz4ISA9mA": ["Asura", [["Demongrin", 100]]],
  "1Lw78Js1f7MogV2B": ["Gigas", [[EMPTY, 49], ["Animal Fur", 30], ["Tincture of Strength", 15], ["Giant Club", 6]]],
  "2vmogpXhRJZzAvXt": ["Flame Drake", [[EMPTY, 55], ["Draconic Essence", 25], ["Flame Essence", 20]]],
  mQlh6GTyw2449hXC: ["Lightning Drake", [[EMPTY, 55], ["Draconic Essence", 25], ["Lightning Essence", 20]]],
  // ── Fafnir Castle ──
  rftRuHZwWx5SiNpH: ["Dire Orc", [[EMPTY, 45], ["Animal Fang", 38], ["Tincture of Strength", 11], ["Giants Belt", 6]]],
  tJCXrTtfLkrN9E57: ["Dragon Guard", [[EMPTY, 46], ["Draconic Essence", 37], ["Tincture of Endurance", 11], ["Halberd", 6]]],
  wjGqTFMH0Z7yZkZt: ["Imp", [[EMPTY, 44], ["Clear Liquid", 37], ["Love Potion", 13], ["Panties", 3], ["Imp's Tail", 3]]],
  bnem1vdA6Bv3mBVx: ["Succubus", [[EMPTY, 44], ["Clear Liquid", 37], ["Love Potion", 14], ["Bikini Armor", 5]]],
  fCxslZazJKtQWsKP: ["Death Gazer", [[EMPTY, 46], ["Eyeball", 38], ["Tincture of Spirit", 10], ["Gorgon Eye", 6]]],
  VwClo606KbQSK6aQ: ["Roo", [[EMPTY, 40], ["Torned Fabric", 36], ["Bloodied Coin", 10], ["Zombie Potion", 8], ["Chef's Knife", 6]]],
  FLy3XRr40wNRmYxV: ["Iron Colossus", [[EMPTY, 42], ["Steel", 20], ["Golem Heart", 16], ["Golem Fragment", 15], ["Berserker Sword", 7]]],
  B4qRdBIxFN6dZ6MT: ["Carlbero", [[EMPTY, 42], ["Tentacle", 36], ["Dead Branch", 15], ["Verdant Force", 7]]],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

async function readAll(db, prefix) {
  const out = [];
  for await (const [key, value] of db.iterator({ gte: prefix, lt: prefix + "~" })) out.push([key, value]);
  return out;
}

(async () => {
  if (APPLY) assertGameClosed(DEFAULT_WORLD);

  // ── Read phase ─────────────────────────────────────────────────────────
  const idb = await openCollection("items");
  const worldItems = (await readAll(idb, "!items!")).map(([, v]) => v);
  await idb.close();
  const adb = await openCollection("actors");
  const actorDocs = new Map((await readAll(adb, "!actors!")).map(([, v]) => [v._id, v]));
  const embedded = await readAll(adb, "!actors.items!");
  await adb.close();

  const embeddedByActor = new Map();
  const sourceUse = new Map(); // world item id → times used as a compendiumSource
  for (const [key, v] of embedded) {
    const actorId = key.split("!").pop().split(".")[0];
    if (!embeddedByActor.has(actorId)) embeddedByActor.set(actorId, []);
    embeddedByActor.get(actorId).push(v);
    const src = String(v?._stats?.compendiumSource || "");
    if (src.startsWith("Item.")) sourceUse.set(src.slice(5), (sourceUse.get(src.slice(5)) || 0) + 1);
  }

  // ── New materials ──────────────────────────────────────────────────────
  const donor = worldItems.find((i) => i._id === DONOR);
  if (!donor) throw new Error("donor Animal Fang not found");
  const itemWrites = [];
  const now = Date.now();
  for (const [name, cost, rarity, taste, icon, flavor] of MATERIALS) {
    const existing = worldItems.find((i) => i.name === name && i.system?.props?.item_type === "material");
    if (existing) { console.log(`material exists, reusing: ${name} ${existing._id}`); continue; }
    const id = newDocId();
    const doc = clone(donor);
    const img = ICON + icon;
    doc._id = id;
    doc.name = name;
    doc.img = img;
    doc.folder = MATERIAL_FOLDER;
    doc._stats = { ...doc._stats, compendiumSource: null, duplicateSource: null, createdTime: now, modifiedTime: now };
    doc.system.uniqueId = id;
    Object.assign(doc.system.props, {
      name, img, id, uuid: `Item.${id}`,
      description: `<p><em>${flavor}</em></p>`,
      item_type: "material", item_rarity: rarity, item_cost: String(cost), item_quantity: "1",
      isIngredient: taste !== "", ingredient_taste: taste, ingredient_taste2: "",
    });
    worldItems.push(doc);
    itemWrites.push([`!items!${id}`, doc, `create material ${name} (${cost}z ${rarity}${taste ? ", " + taste : ", not an ingredient"})`]);
  }

  // ── Resolve a loot name to ONE world item ──────────────────────────────
  function resolveWorld(name) {
    const hits = worldItems.filter((i) => i.name === name && LOOT_TYPES.has(i.system?.props?.item_type));
    if (!hits.length) throw new Error(`no world loot item named "${name}"`);
    if (hits.length === 1) return hits[0];
    // Same-name duplicates: prefer the one existing steal setups already point at.
    const ranked = hits.slice().sort((a, b) => (sourceUse.get(b._id) || 0) - (sourceUse.get(a._id) || 0));
    if ((sourceUse.get(ranked[0]._id) || 0) === (sourceUse.get(ranked[1]._id) || 0)) {
      throw new Error(`ambiguous world item "${name}": ${hits.map((h) => h._id).join(", ")}`);
    }
    console.log(`  note: "${name}" has ${hits.length} world copies, using ${ranked[0]._id} (the one existing monsters reference)`);
    return ranked[0];
  }

  // ── Actors ─────────────────────────────────────────────────────────────
  const actorWrites = [];
  for (const [actorId, [expectName, rows]] of Object.entries(TABLES)) {
    const actor = actorDocs.get(actorId);
    if (!actor) throw new Error(`actor ${actorId} (${expectName}) not found`);
    if (actor.name.replace(/^⭐️\s*/, "") !== expectName) throw new Error(`actor ${actorId} is "${actor.name}", expected "${expectName}"`);
    const sum = rows.reduce((n, r) => n + r[1], 0);
    if (sum !== 100) throw new Error(`${expectName}: weights sum to ${sum}`);

    const mine = embeddedByActor.get(actorId) || [];
    const next = clone(actor);
    const loot = {};
    const added = [];
    for (const [lootName] of rows) {
      let emb = mine.find((i) => i.name === lootName && LOOT_TYPES.has(i.system?.props?.item_type));
      if (!emb) {
        const src = resolveWorld(lootName);
        emb = clone(src);
        emb._id = newDocId();
        emb._stats = { ...emb._stats, compendiumSource: `Item.${src._id}`, duplicateSource: null, createdTime: now, modifiedTime: now };
        next.items = [...(next.items || []), emb._id];
        actorWrites.push([`!actors.items!${actorId}.${emb._id}`, emb, `${expectName}: embed ${lootName}`]);
        added.push(lootName);
      }
      loot[emb._id] = {
        id: "${item.id}",
        loot_description: String(emb.system?.props?.description ?? ""),
        name: lootName,
        roll: "",
        uuid: `Actor.${actorId}.Item.${emb._id}`,
      };
    }
    // Keep catalog entries for loot the actor already carried but this table
    // does not roll (none today; harmless if a later edit adds one).
    for (const [k, v] of Object.entries(actor.system?.props?.stealable_loot || {})) {
      if (!loot[k] && !Object.values(loot).some((e) => e.name === v?.name)) loot[k] = v;
    }
    const table = {};
    rows.forEach(([lootName, pct], i) => { table[String(i)] = { $deleted: false, loot_id: lootName, loot_percentage: String(pct) }; });

    next.system.props.stealable_loot = loot;          // outright, never merged
    next.system.props.steal_percentage_table = table; // outright, never merged
    next._stats = { ...(next._stats || {}), modifiedTime: now };
    actorWrites.push([`!actors!${actorId}`, next,
      `${expectName}: ${rows.map((r) => `${r[0]} ${r[1]}`).join(" / ")}${added.length ? "" : " (no new embeds)"}`]);
  }

  // ── Report / write ─────────────────────────────────────────────────────
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${itemWrites.length} item writes, ${actorWrites.length} actor writes\n`);
  for (const [k, , note] of itemWrites) console.log(`  ${k}  ${note}`);
  for (const [k, , note] of actorWrites.filter((w) => /^!actors![^.]+$/.test(w[0]))) console.log(`  ${k}  ${note}`);
  console.log(`  + ${actorWrites.filter((w) => w[0].startsWith("!actors.items!")).length} embedded loot items`);
  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }

  for (const [collection, writes] of [["items", itemWrites], ["actors", actorWrites]]) {
    if (!writes.length) continue;
    const backupPath = snapshotCollection(collection);
    const db = await openCollection(collection);
    try {
      await db.batch(writes.map(([key, value]) => ({ type: "put", key, value })));
    } finally {
      await db.close();
    }
    journal.append({
      uuid: `collection:${collection}`, collection,
      key: writes.map((w) => w[0]).join(","),
      beforeHash: null, afterHash: null, backupPath, patch: null,
      note: `steal-material-rollout: ${writes.length} docs`,
    });
    console.log(`wrote ${writes.length} docs to "${collection}" (backup: ${backupPath})`);
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
