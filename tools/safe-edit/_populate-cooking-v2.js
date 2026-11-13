// Cooking v2 content (2026-11-13):
//   • 5 Dark Delicacies (Yaminabe only, potency 15+) and 5 Spoiled dishes (a muddled pot of 4+ tastes)
//   • _Cooking Config: darkDishIds, spoiledDishIds, ingredientKinds (style map for every ingredient),
//     link / muddledAt / yaminabe tunables, and `priority` removed from recipes (v2 weights recipe
//     wheels by core rarity instead).
// Icons are unused art already in the Forge library (Item Icon/Food/Genshin, Wuthering Wave).
//
// Idempotent — fixed document IDs, re-running overwrites in place.
// Usage: node _populate-cooking-v2.js [--dry] [--world <worldId or path relative to worlds/>]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");
const { safeEdit } = require("./lib");

const DRY = process.argv.includes("--dry");
const wi = process.argv.indexOf("--world");
const WORLD = wi > 0 ? process.argv[wi + 1] : "fabula-ultima-2";
const MOD = "fabula-ultima-companion";
const GM_USER = "JQGNzKpDPHJmcUIW";
const TPL_ID = "ZoiV53VaLzeRsEps";          // _equippableItemTemplate
const DISHES_FOLDER = "UNuBsFNeuyDDZ5AZ";   // 🍲 Dishes
const CFG_ID = "oG4U8b6if8enaswT";          // _Cooking Config
const G = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Food/Genshin/";
const W = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Food/Wuthering%20Wave/";

// ── Dishes ──────────────────────────────────────────────────────────────────
// Dark Delicacy = one step past tier 3 (T3 values: +5 dmg / 30 Shield / +30 HP / +30 MP / +2 IP).
// Spoiled = a mirror of tier 1, as a debuff that lasts until the next rest like any meal.
const DISHES = [
  { id: "CkV2DarkBitter00", ae: "CkV2AeDkBitter00", group: "dark", family: "bitter", name: "Midnight Root Elixir", img: G + "Item_Adeptus%2527_Temptation.webp",
    changes: [["max_ip", "3"]], effect: "Everyone who eats gains <strong>+3 Maximum IP</strong> until the next rest.",
    lore: "Roots steeped in the dark until the bitterness turns to something like clarity. Nobody remembers who put them in." },
  { id: "CkV2DarkSweet000", ae: "CkV2AeDkSweet000", group: "dark", family: "sweet", name: "Starfall Macarons", img: G + "Item_Rainbow_Macarons.webp",
    changes: [["max_mp", "40"]], effect: "Everyone who eats gains <strong>+40 Maximum MP</strong> until the next rest.",
    lore: "Somehow the pot gave back little rainbow shells, each one sweeter than the last. Nobody asks how." },
  { id: "CkV2DarkSour0000", ae: "CkV2AeDkSour0000", group: "dark", family: "sour", name: "Thunder-Lemon Braise", img: W + "Item_Lemon-Braised_Pork.webp",
    changes: [["extra_damage_mod_all", "7"]], effect: "Everyone who eats gains <strong>+7 bonus damage</strong> until the next rest.",
    lore: "Sharp enough to make your teeth hum. The pot crackled while it cooked, and so do you." },
  { id: "CkV2DarkSalty000", ae: "CkV2AeDkSalty000", group: "dark", family: "salty", name: "Abyssal Crab Roast", img: G + "Item_Golden_Crab.webp",
    instant: { shield: 40 }, changes: [], effect: "Grants <strong>40 Shield</strong> immediately.",
    lore: "Something with a shell crawled out of the dark pot fully roasted. It eats like armour." },
  { id: "CkV2DarkUmami000", ae: "CkV2AeDkUmami000", group: "dark", family: "umami", name: "Bottomless Jewel Broth", img: G + "Item_Jewelry_Soup.webp",
    changes: [["max_hp", "40"]], effect: "Everyone who eats gains <strong>+40 Maximum HP</strong> until the next rest.",
    lore: "A broth so deep the ladle never finds the bottom. Little gems of fat glitter on top." },
  { id: "CkV2SpoilBitter0", ae: "CkV2AeSpBitter00", group: "spoiled", family: "bitter", name: "Charred Phantasm", img: G + "Item_Charred_Mushroom_Phantasm.webp",
    changes: [["bonus_check", "-1"]], effect: "Everyone who eats suffers <strong>−1 to all checks</strong> until the next rest.",
    lore: "Four flavours fought in the pot and the bitter one won by burning everything else. It tastes like smoke and regret." },
  { id: "CkV2SpoilSweet00", ae: "CkV2AeSpSweet000", group: "spoiled", family: "sweet", name: "Crushed Candy Sludge", img: W + "Item_Crushed_Candy.webp",
    changes: [["max_mp", "-10"]], effect: "Everyone who eats suffers <strong>−10 Maximum MP</strong> until the next rest.",
    lore: "Sugar melted into everything and everything melted into sugar. Your head is sticky." },
  { id: "CkV2SpoilSour000", ae: "CkV2AeSpSour0000", group: "spoiled", family: "sour", name: "Sour Mishap", img: W + "Item_Failed_Attempt.webp",
    changes: [["extra_damage_mod_all", "-2"]], effect: "Everyone who eats suffers <strong>−2 bonus damage</strong> until the next rest.",
    lore: "It curdled. Then it curdled again. Your grip feels weaker just looking at it." },
  { id: "CkV2SpoilSalty00", ae: "CkV2AeSpSalty000", group: "spoiled", family: "salty", name: "Oversalted Fish", img: G + "Item_Dry-Braised_Salted_Fish.webp",
    changes: [["damage_receiving_mod_physical", "-2"]], effect: "Everyone who eats takes <strong>+2 damage from physical attacks</strong> until the next rest.",
    lore: "Salt on salt on salt. Your mouth dries out, your skin stings, and every bump hurts a little more." },
  { id: "CkV2SpoilUmami00", ae: "CkV2AeSpUmami000", group: "spoiled", family: "umami", name: "Canned Surprise", img: W + "Item_Canned_Surprise.webp",
    changes: [["max_hp", "-10"]], effect: "Everyone who eats suffers <strong>−10 Maximum HP</strong> until the next rest.",
    lore: "It came out of the pot already sealed in a tin. Nobody wanted to open it. Everybody had to." },
];

// ── Ingredient kinds (style layer). Every ingredient in the world must have one. ──
const KIND = {
  sea: "Blade Angler,Bolt Eel,Flame Salmon,Fugu,Golden Koi,Hearty Cod,Ice Pike,Keystone Ray,Lucky Loach,Magnificent Mahi-mahi,Mindful Sole,Moonfish,Mudfish,Prophet Tuna,River Trout,Shadow Sturgeon,Shine Herring,Silt Catfish,Stash Gar,Tempest Manta,Toxic Puffer,Venom Jellyfish,Wandering Shark,Wind Bass,Fish Fin,Urchin,Brinebloom Coral",
  meat: "Meat,Prime Steak,Frill,Tentacle,Animal Fang,Eyeball",
  monster: "Charred Bone,Insect Stinger,Jellopy,Nibbers,Golem Heart,Mystic Horn,Regret,Spore,Ash",
  garden: "Cabbage,Cauliflower,Cucumber,Turnip,Darkroot Herb,Moonshroom,Starfruit,Ember Petal,Dewdrop,Honey",
  pantry: "Bean Paste,Cheese,Cooking Oil,Egg,Flour,Fresh Milk,Rice,Rock Salt,Mead,Clear Liquid",
  arcane: "Flame Essence,Lightning Essence,Draconic Essence",
};
const KINDS = {};
for (const [k, v] of Object.entries(KIND)) for (const n of v.split(",")) KINDS[n] = k;

// --------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const _created = new Map();
function stats(id) {
  const now = Date.now();
  return { compendiumSource: null, duplicateSource: null, coreVersion: "12.343", systemId: "custom-system-builder", systemVersion: "4.8.5",
    createdTime: _created.get(id) ?? now, modifiedTime: now, lastModifiedBy: GM_USER };
}
function makeDish(d, tpl) {
  return {
    _id: d.id, name: d.name, type: "equippableItem", img: d.img, folder: DISHES_FOLDER,
    effects: [d.ae], sort: 0,
    ownership: { default: 0, [GM_USER]: 3 },
    flags: { "custom-system-builder": { version: "4.8.5" }, [MOD]: { cookingDish: { family: d.family, tier: d.group === "dark" ? 4 : 0, group: d.group, instant: d.instant ?? {} } } },
    system: {
      template: TPL_ID, templateSystemUniqueVersion: tpl.system.templateSystemUniqueVersion,
      hidden: clone(tpl.system.hidden), body: clone(tpl.system.body), header: clone(tpl.system.header), display: clone(tpl.system.display),
      modifiers: [], unique: false, uniqueId: d.id,
      props: {
        name: d.name, isEquipped: false, isMartial: false, isModule: false, isUnique: false,
        isKey: false, isSet: false, set_name: "", isRelatedItem: false, isIngredient: false,
        optional_params: {}, active_effect_config_table: {}, effect_table: {},
        item_type: "consumable", item_rarity: "Common", item_cost: "0", item_quantity: "1", ip_cost: "0",
        ingredient_taste: "", ingredient_taste2: "", recipe_kind: "", recipe_dish_uuid: "",
        description: `<ul><li><p>${d.effect}</p></li></ul>`, flavor_text: `<p><em>${d.lore}</em></p>`,
        id: d.id, uuid: `Item.${d.id}`, img: d.img,
      },
    },
    _stats: stats(d.id),
  };
}
function makeAe(d) {
  return {
    _id: d.ae, name: d.name, img: d.img, description: `<p>${d.effect}</p>`, type: "base",
    system: { tags: ["food"] },
    changes: d.changes.map(([key, value]) => ({ key, mode: 2, priority: null, value })),
    disabled: false,
    duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
    origin: null, tint: "#ffffff", transfer: false, statuses: [],
    flags: { "custom-system-builder": { originalParentId: d.id, originalId: d.ae, originalUuid: `Item.${d.id}.ActiveEffect.${d.ae}`, isFromTemplate: false } },
    sort: 0, _stats: stats(d.ae),
  };
}

// --------------------------------------------------------------------------
(async () => {
  assertGameClosed(WORLD);
  if (!DRY) snapshotCollection("items", WORLD);   // BEFORE any openCollection (our handle holds the lock)
  const problems = [];
  for (const d of DISHES) for (const id of [d.id, d.ae]) if (id.length !== 16) problems.push(`id ${id} is ${id.length} chars`);

  const idb = await openCollection("items", WORLD);
  const tpl = await idb.get(`!items!${TPL_ID}`).catch(() => null);
  const cfgDoc = await idb.get(`!items!${CFG_ID}`).catch(() => null);
  if (!tpl?.system?.body) problems.push("template missing body");
  if (cfgDoc?.name !== "_Cooking Config") problems.push("_Cooking Config not found");
  const worldItems = [];
  for await (const [, val] of idb.iterator({ gte: "!items!", lt: "!items!~" })) {
    if (val?._id && val?._stats?.createdTime) _created.set(val._id, val._stats.createdTime);
    worldItems.push(val);
  }
  await idb.close();

  const mine = new Set(DISHES.map(d => d.id));
  for (const d of DISHES) {
    const dup = worldItems.filter(i => i.name === d.name && !mine.has(i._id));
    if (dup.length) problems.push(`name "${d.name}" collides with existing item(s): ${dup.map(x => x._id).join(", ")}`);
  }
  const ingredients = [...new Set(worldItems.filter(i => i?.system?.props?.isIngredient === true && i?.system?.props?.item_type === "material").map(i => i.name))];
  const noKind = ingredients.filter(n => !KINDS[n]);
  if (noKind.length) problems.push(`ingredients without a kind: ${noKind.join(", ")}`);
  const unknownKind = Object.keys(KINDS).filter(n => !ingredients.includes(n));
  const cc = cfgDoc?.flags?.[MOD]?.cookingConfig ?? {};
  if (!Object.keys(cc.matrix ?? {}).length) problems.push("_Cooking Config has no matrix — refusing to write");
  if (!(cc.recipes ?? []).length) problems.push("_Cooking Config has no recipes — refusing to write");
  if (problems.length) throw new Error("Pre-flight failed:\n  " + problems.join("\n  "));

  const ops = [];
  for (const d of DISHES) {
    ops.push({ type: "put", key: `!items!${d.id}`, value: makeDish(d, tpl) });
    ops.push({ type: "put", key: `!items.effects!${d.id}.${d.ae}`, value: makeAe(d) });
  }
  const darkDishIds = Object.fromEntries(DISHES.filter(d => d.group === "dark").map(d => [d.family, d.id]));
  const spoiledDishIds = Object.fromEntries(DISHES.filter(d => d.group === "spoiled").map(d => [d.family, d.id]));
  const recipes = (cc.recipes ?? []).map(r => { const x = clone(r); delete x.priority; return x; });
  const ingredientKinds = Object.fromEntries(ingredients.sort().map(n => [n, KINDS[n]]));

  console.log(`${DRY ? "[DRY] " : ""}world ${WORLD}: ${DISHES.length} dishes (${DISHES.length * 2} keys)`);
  for (const d of DISHES) console.log(`   ${d.group.padEnd(7)} ${d.family.padEnd(6)} ${d.name} — ${d.instant?.shield ? `${d.instant.shield} Shield` : d.changes.map(c => c.join(" ")).join(", ")}`);
  console.log(`   ingredientKinds: ${Object.keys(ingredientKinds).length} ingredients${unknownKind.length ? ` (map names not in this world, skipped: ${unknownKind.join(", ")})` : ""}`);
  console.log(`   recipes: ${recipes.length}, priority removed from: ${(cc.recipes ?? []).filter(r => r.priority).map(r => r.name).join(", ") || "none"}`);
  if (DRY) return;

  const w = await openCollection("items", WORLD); await w.batch(ops); await w.close();
  await safeEdit({ world: WORLD, uuid: `Item.${CFG_ID}`, note: "cooking v2: dark/spoiled dishes, ingredient kinds, tunables, recipe priority → rarity weights",
    patch: {
      [`flags.${MOD}.cookingConfig.darkDishIds`]: darkDishIds,
      [`flags.${MOD}.cookingConfig.spoiledDishIds`]: spoiledDishIds,
      [`flags.${MOD}.cookingConfig.ingredientKinds`]: ingredientKinds,
      [`flags.${MOD}.cookingConfig.link`]: 2,
      [`flags.${MOD}.cookingConfig.muddledAt`]: 4,
      [`flags.${MOD}.cookingConfig.yaminabe`]: { bonus: 2, darkAt: 15 },
      [`flags.${MOD}.cookingConfig.recipes`]: recipes,
    } });

  // ── verify ──
  const v = await openCollection("items", WORLD);
  let ok = 0;
  for (const d of DISHES) if (await v.get(`!items!${d.id}`).catch(() => null) && await v.get(`!items.effects!${d.id}.${d.ae}`).catch(() => null)) ok++;
  const c2 = (await v.get(`!items!${CFG_ID}`))?.flags?.[MOD]?.cookingConfig ?? {}; await v.close();
  console.log(`verify dishes: ${ok}/${DISHES.length}`);
  console.log(`verify config: dark ${Object.keys(c2.darkDishIds ?? {}).length}, spoiled ${Object.keys(c2.spoiledDishIds ?? {}).length}, kinds ${Object.keys(c2.ingredientKinds ?? {}).length}, recipes ${(c2.recipes ?? []).length}, matrix ${Object.keys(c2.matrix ?? {}).length === 5 ? "OK" : "!! DAMAGED !!"}, goop ${c2.goopDishId ? "OK" : "!! MISSING !!"}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
