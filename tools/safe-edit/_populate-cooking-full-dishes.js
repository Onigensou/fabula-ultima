// Populates the full cooking system dish roster:
//   • Tags Animal Fang (existing Common) as Sour
//   • Creates 5 Uncommon ingredient items (one per taste)
//   • Creates 14 new dish items + AEs (Umami T1 = Hearty Hot-Pot already exists)
//   • Creates Abyssal Goop + Mysterious Hot-Pot (display-only, no buff AEs)
//   • Patches _Cooking Config with the complete matrix, goopDishId, mysteryDishId
//
// Usage: node _populate-cooking-full-dishes.js [--dry]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");
const { safeEdit } = require("./lib");

const DRY = process.argv.includes("--dry");
const TPL_ID = "ZoiV53VaLzeRsEps";
const DISHES_FOLDER = "UNuBsFNeuyDDZ5AZ";
const MATERIALS_FOLDER = "36rowiHAcXnIPsKK";
const GM_USER = "JQGNzKpDPHJmcUIW";
const MOD = "fabula-ultima-companion";
const CFG_ID = "oG4U8b6if8enaswT"; // existing _Cooking Config

// --------------------------------------------------------------------------
// Dish design
// --------------------------------------------------------------------------
//
// Sour  = Offense : extra_damage_mod_all +1/+3/+5
// Salty = Defense : instant shield 10/20/30 (no AE changes)
// Umami = Vitality: max_hp +10/+20/+30  (T1 = existing Hearty Hot-Pot)
// Sweet = Spirit  : max_mp +10/+20/+30
// Bitter= Wit     : bonus_check +1 (T1) / max_ip +1 (T2) / max_ip +2 (T3)
//
// --------------------------------------------------------------------------

const FOOD_PATH = "icons/consumables/food";
const COMM_PATH = "icons/commodities";

// Pre-generate deterministic layout so we can reference IDs before writing
function rID(prefix) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = prefix ?? "";
  while (out.length < 16) out += chars[Math.floor(Math.random() * chars.length)];
  return out.slice(0, 16);
}

const D = {
  sour1: rID(), sour2: rID(), sour3: rID(),
  salty1: rID(), salty2: rID(), salty3: rID(),
  umami2: rID(), umami3: rID(),           // T1 = existing GBixGFmKRv0B1Lgj
  sweet1: rID(), sweet2: rID(), sweet3: rID(),
  bitter1: rID(), bitter2: rID(), bitter3: rID(),
  goop: rID(), mystery: rID(),
};
const AE = {};
for (const k of Object.keys(D)) {
  if (!["goop","mystery","salty1","salty2","salty3"].includes(k)) AE[k] = rID();
}
// Salty dishes get an AE entry too (for the food-buff frame), but changes=[].
AE.salty1 = rID(); AE.salty2 = rID(); AE.salty3 = rID();

// New Uncommon ingredient item IDs
const ING = { moonshroom: rID(), starfruit: rID(), brinebloom: rID(), darkroot: rID(), silkpetal: rID() };

const DISHES = [
  // ── Sour ───────────────────────────────────────────────────────────────
  { id: D.sour1, aeId: AE.sour1, family: "sour", tier: 1,
    name: "Tangy Trailside Skewer",
    desc: "<p>Campfire skewers marinated with wild berry vinegar. Everyone who eats gains <strong>+1 bonus damage</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/cooked-kebab-meat-skewer-red.webp`,
    changes: [{ key: "extra_damage_mod_all", mode: 2, value: "1", priority: null }],
    instant: {} },

  { id: D.sour2, aeId: AE.sour2, family: "sour", tier: 2,
    name: "Zestfire Grill Platter",
    desc: "<p>A shared platter of citrus-glazed grilled meats, carved together around the fire. Everyone who eats gains <strong>+3 bonus damage</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/plate-steak-grilled-brown-green.webp`,
    changes: [{ key: "extra_damage_mod_all", mode: 2, value: "3", priority: null }],
    instant: {} },

  { id: D.sour3, aeId: AE.sour3, family: "sour", tier: 3,
    name: "Crimsonbite Battle Bento",
    desc: "<p>A precisely-composed box of razor-flavored cuts, prepared with the precision of a duellist. Everyone who eats gains <strong>+5 bonus damage</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/cooked-ribs-rack-glazed-bones-brown-white.webp`,
    changes: [{ key: "extra_damage_mod_all", mode: 2, value: "5", priority: null }],
    instant: {} },

  // ── Salty ──────────────────────────────────────────────────────────────
  { id: D.salty1, aeId: AE.salty1, family: "salty", tier: 1,
    name: "Salt-Cured Camp Bread",
    desc: "<p>Dense, salt-crusted bread pressed by hand and toasted over embers — it keeps you standing. Grants <strong>10 Shield</strong> immediately.</p>",
    icon: `${FOOD_PATH}/bread-toast-tan.webp`,
    changes: [],
    instant: { shield: 10 } },

  { id: D.salty2, aeId: AE.salty2, family: "salty", tier: 2,
    name: "Smoked Ironwood Cutlet",
    desc: "<p>A thick cut of beast-meat smoked low and slow over ironwood charcoal — protective as armour. Grants <strong>20 Shield</strong> immediately.</p>",
    icon: `${FOOD_PATH}/fish-fillet-steak-brown.webp`,
    changes: [],
    instant: { shield: 20 } },

  { id: D.salty3, aeId: AE.salty3, family: "salty", tier: 3,
    name: "Fortress Roast",
    desc: "<p>A hulking bone-in roast crusted with sea salt and rendered fat — practically a wall on a plate. Grants <strong>30 Shield</strong> immediately.</p>",
    icon: `${FOOD_PATH}/shank-meat-bone-glazed-brown.webp`,
    changes: [],
    instant: { shield: 30 } },

  // ── Umami T2 + T3 (T1 = existing Hearty Hot-Pot) ─────────────────────
  { id: D.umami2, aeId: AE.umami2, family: "umami", tier: 2,
    name: "Deep Forest Roast",
    desc: "<p>Slow-roasted forest game surrounded by root vegetables, cooked until the marrow runs. Everyone who eats gains <strong>+20 Maximum HP</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/bowl-ribs-meat-rice-mash-brown-white.webp`,
    changes: [{ key: "max_hp", mode: 2, value: "20", priority: null }],
    instant: {} },

  { id: D.umami3, aeId: AE.umami3, family: "umami", tier: 3,
    name: "Giant's Bone Broth",
    desc: "<p>A massive pot of deep-simmered bone broth, shared from a single ladle passed hand to hand. Everyone who eats gains <strong>+30 Maximum HP</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/bowl-stew-brown.webp`,
    changes: [{ key: "max_hp", mode: 2, value: "30", priority: null }],
    instant: {} },

  // ── Sweet ──────────────────────────────────────────────────────────────
  { id: D.sweet1, aeId: AE.sweet1, family: "sweet", tier: 1,
    name: "Honey Campfire Cake",
    desc: "<p>A simple skillet cake sweetened with wild honey, passed around still warm. Everyone who eats gains <strong>+10 Maximum MP</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/honey-beehive-brown.webp`,
    changes: [{ key: "max_mp", mode: 2, value: "10", priority: null }],
    instant: {} },

  { id: D.sweet2, aeId: AE.sweet2, family: "sweet", tier: 2,
    name: "Moonpetal Pudding",
    desc: "<p>A silky pudding infused with moonpetal blossom — its sweetness lingers long past the last spoon. Everyone who eats gains <strong>+20 Maximum MP</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/berries-cream-bowl-mint-red.webp`,
    changes: [{ key: "max_mp", mode: 2, value: "20", priority: null }],
    instant: {} },

  { id: D.sweet3, aeId: AE.sweet3, family: "sweet", tier: 3,
    name: "Starweave Confection",
    desc: "<p>Crystallised starfruit spun into delicate threads — a confection that seems to hum with arcane warmth. Everyone who eats gains <strong>+30 Maximum MP</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/candy-pattie-pink-white.webp`,
    changes: [{ key: "max_mp", mode: 2, value: "30", priority: null }],
    instant: {} },

  // ── Bitter ─────────────────────────────────────────────────────────────
  { id: D.bitter1, aeId: AE.bitter1, family: "bitter", tier: 1,
    name: "Sage Ember Toast",
    desc: "<p>Thick-cut bread toasted over sage-smoke embers — the acrid bite sharpens the mind. Everyone who eats gains <strong>+1 to all checks</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/bowl-salad-green.webp`,
    changes: [{ key: "bonus_check", mode: 2, value: "1", priority: null }],
    instant: {} },

  { id: D.bitter2, aeId: AE.bitter2, family: "bitter", tier: 2,
    name: "Scholar's Herb Dumplings",
    desc: "<p>Handmade dumplings stuffed with bitter medicinal herbs — the recipe copied from a dusty tome. Everyone who eats gains <strong>+1 Maximum IP</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/cooked-potato-boiled-egg-peeled-white.webp`,
    changes: [{ key: "max_ip", mode: 2, value: "1", priority: null }],
    instant: {} },

  { id: D.bitter3, aeId: AE.bitter3, family: "bitter", tier: 3,
    name: "Ancient Root Medley",
    desc: "<p>A complex arrangement of aged roots — slow-braised until their bitterness becomes something almost reverent. Everyone who eats gains <strong>+2 Maximum IP</strong> until the next rest.</p>",
    icon: `${FOOD_PATH}/spice-anise-pod.webp`,
    changes: [{ key: "max_ip", mode: 2, value: "2", priority: null }],
    instant: {} },
];

const GOOP = {
  id: D.goop,
  name: "Abyssal Goop",
  desc: "<p>An unfathomable, dark mass that gurgles of its own accord. The smell alone ended three friendships. It is completely inert — but it <em>knows</em>.</p>",
  icon: `${FOOD_PATH}/soup-tentacle-blue-yellow.webp`,
};

const MYSTERY = {
  id: D.mystery,
  name: "Mysterious Hot-Pot",
  desc: "<p>Nobody agrees on what went in. Somehow it smells amazing. The true dish reveals itself to the eater's heart.</p>",
  icon: `${FOOD_PATH}/pot-soup-white.webp`,
};

const NEW_INGREDIENTS = [
  { id: ING.moonshroom,  name: "Moonshroom",       taste: "umami",  rarity: "Uncommon",
    desc: "A luminescent fungus that grows only under moonlight. Rich, earthy, deeply savoury.",
    icon: `${FOOD_PATH}/plate-chicken-grilled-mushroom-brown.webp` },
  { id: ING.starfruit,   name: "Starfruit Peel",   taste: "sour",   rarity: "Uncommon",
    desc: "The dried peel of a starfruit — intensely tart, prized by travelling chefs.",
    icon: `${COMM_PATH}/flowers/lily-yellow.webp` },
  { id: ING.brinebloom,  name: "Brinebloom Coral", taste: "salty",  rarity: "Uncommon",
    desc: "A sea-coral that crystallises oceanic minerals. Crumbles into pure seasoning.",
    icon: `${COMM_PATH}/biological/shell-ridged-blue.webp` },
  { id: ING.darkroot,    name: "Darkroot Herb",    taste: "bitter", rarity: "Uncommon",
    desc: "A dense, almost-black root with a brutally sharp bite. Used in scholarly cuisine.",
    icon: `${COMM_PATH}/flowers/dandelion-pod-white.webp` },
  { id: ING.silkpetal,   name: "Silkpetal Honey",  taste: "sweet",  rarity: "Uncommon",
    desc: "Honey cultivated from silk-bee hives nested in arcane blossoms. Supernaturally sweet.",
    icon: `${COMM_PATH}/flowers/cornflower-gold.webp` },
];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function stats() {
  const now = Date.now();
  return {
    compendiumSource: null, duplicateSource: null,
    coreVersion: "12.343", systemId: "custom-system-builder", systemVersion: "4.8.5",
    createdTime: now, modifiedTime: now, lastModifiedBy: GM_USER,
  };
}

function baseProps(name, itemType, extra = {}) {
  return {
    name, isEquipped: false, isMartial: false, isModule: false, isUnique: false,
    isKey: false, isSet: false, isRelatedItem: false, isIngredient: false,
    optional_params: {}, active_effect_config_table: {}, effect_table: {},
    item_type: itemType, item_rarity: "Common", item_cost: "0",
    item_quantity: "1", ip_cost: "0",
    ingredient_taste: "", ingredient_taste2: "", recipe_kind: "", recipe_dish_uuid: "",
    ...extra,
  };
}

function makeItem({ id, name, img, folder, effects = [], props, flags = {} }, tpl) {
  return {
    _id: id, name, type: "equippableItem", img, folder,
    effects, sort: 0,
    ownership: { default: 0, [GM_USER]: 3 },
    flags: { "custom-system-builder": { version: "4.8.5" }, ...flags },
    system: {
      template: TPL_ID,
      templateSystemUniqueVersion: tpl.system.templateSystemUniqueVersion,
      hidden: structuredClone(tpl.system.hidden),
      body: structuredClone(tpl.system.body),
      header: structuredClone(tpl.system.header),
      display: structuredClone(tpl.system.display),
      modifiers: [], unique: false, uniqueId: id,
      props,
    },
    _stats: stats(),
  };
}

function makeAe({ id, parentId, name, icon, desc, changes }) {
  return {
    _id: id, name, img: icon, description: desc, type: "base",
    system: { tags: ["food"] },
    changes,
    disabled: false,
    duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
    origin: null, tint: "#ffffff", transfer: false, statuses: [],
    flags: {
      "custom-system-builder": {
        originalParentId: parentId, originalId: id,
        originalUuid: `Item.${parentId}.ActiveEffect.${id}`, isFromTemplate: false,
      },
    },
    sort: 0, _stats: stats(),
  };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
(async () => {
  assertGameClosed();

  // 1. Tag Animal Fang as Sour (patch via safe-edit before opening the collection)
  if (DRY) {
    console.log("[DRY] would tag Animal Fang → sour");
  } else {
    await safeEdit({
      uuid: "Item.oAP85eeLJCliYm2E",
      patch: { "system.props.isIngredient": true, "system.props.ingredient_taste": "sour", "system.props.ingredient_taste2": "" },
      note: "cooking: tag Animal Fang as sour ingredient",
    });
    console.log("tagged Animal Fang → sour");
  }

  // 2. Load template + snapshot items BEFORE opening
  if (!DRY) snapshotCollection("items");
  const db = await openCollection("items");
  const tpl = await db.get("!items!" + TPL_ID);
  if (!tpl?.system?.body) { await db.close(); throw new Error("Template missing body"); }

  const ops = [];

  // 3. New Uncommon ingredient items
  for (const ing of NEW_INGREDIENTS) {
    const item = makeItem({
      id: ing.id, name: ing.name, img: ing.icon,
      folder: MATERIALS_FOLDER,
      props: baseProps(ing.name, "material", {
        item_rarity: ing.rarity,
        isIngredient: true,
        ingredient_taste: ing.taste,
        ingredient_taste2: "",
        description: ing.desc,
      }),
    }, tpl);
    ops.push({ type: "put", key: `!items!${ing.id}`, value: item });
    if (!DRY) console.log(`  new ingredient: ${ing.name} (${ing.rarity}, ${ing.taste}) → ${ing.id}`);
  }

  // 4. Dish items + AEs
  for (const d of DISHES) {
    const dish = makeItem({
      id: d.id, name: d.name, img: d.icon,
      folder: DISHES_FOLDER,
      effects: [d.aeId],
      props: baseProps(d.name, "consumable", { description: d.desc }),
      flags: { [MOD]: { cookingDish: { family: d.family, tier: d.tier, instant: d.instant } } },
    }, tpl);
    const ae = makeAe({ id: d.aeId, parentId: d.id, name: d.name, icon: d.icon, desc: d.desc, changes: d.changes });
    ops.push({ type: "put", key: `!items!${d.id}`, value: dish });
    ops.push({ type: "put", key: `!items.effects!${d.id}.${d.aeId}`, value: ae });
    if (!DRY) console.log(`  dish: ${d.name} (${d.family} T${d.tier}) → ${d.id}`);
  }

  // 5. Goop — inert, no AE
  const goopItem = makeItem({
    id: D.goop, name: GOOP.name, img: GOOP.icon,
    folder: DISHES_FOLDER,
    props: baseProps(GOOP.name, "consumable", { description: GOOP.desc }),
    flags: { [MOD]: { cookingDish: { family: "goop", tier: 0, instant: {} } } },
  }, tpl);
  ops.push({ type: "put", key: `!items!${D.goop}`, value: goopItem });

  // 6. Mysterious Hot-Pot — display-only, no buff AE
  const mysteryItem = makeItem({
    id: D.mystery, name: MYSTERY.name, img: MYSTERY.icon,
    folder: DISHES_FOLDER,
    props: baseProps(MYSTERY.name, "consumable", { description: MYSTERY.desc }),
    flags: { [MOD]: { cookingDish: { family: "mystery", tier: 0, instant: {} } } },
  }, tpl);
  ops.push({ type: "put", key: `!items!${D.mystery}`, value: mysteryItem });

  if (DRY) {
    console.log("[DRY] dish IDs:", JSON.stringify(D, null, 1));
    console.log("[DRY] ingredient IDs:", JSON.stringify(ING, null, 1));
    await db.close();
    return;
  }

  await db.batch(ops);
  await db.close();
  console.log(`wrote ${ops.length} ops (${DISHES.length} dishes, ${NEW_INGREDIENTS.length} ingredients, goop, mystery)`);

  // 7. Patch _Cooking Config with complete matrix
  const UMAMI_T1 = "GBixGFmKRv0B1Lgj"; // existing Hearty Hot-Pot
  const newConfig = {
    matrix: {
      sour:   { 1: D.sour1,   2: D.sour2,   3: D.sour3   },
      salty:  { 1: D.salty1,  2: D.salty2,  3: D.salty3  },
      umami:  { 1: UMAMI_T1,  2: D.umami2,  3: D.umami3  },
      sweet:  { 1: D.sweet1,  2: D.sweet2,  3: D.sweet3  },
      bitter: { 1: D.bitter1, 2: D.bitter2, 3: D.bitter3 },
    },
    goopDishId: D.goop,
    mysteryDishId: D.mystery,
  };
  await safeEdit({
    uuid: `Item.${CFG_ID}`,
    patch: { [`flags.${MOD}.cookingConfig`]: newConfig },
    note: "cooking: full dish matrix + goop + mystery IDs",
  });
  console.log("patched _Cooking Config");

  // 8. Verify critical keys
  const v = await openCollection("items");
  let ok = 0, fail = 0;
  const checkKeys = [
    ...DISHES.map(d => `!items!${d.id}`),
    ...DISHES.map(d => `!items.effects!${d.id}.${d.aeId}`),
    `!items!${D.goop}`, `!items!${D.mystery}`,
    ...NEW_INGREDIENTS.map(i => `!items!${i.id}`),
  ];
  for (const k of checkKeys) {
    const doc = await v.get(k).catch(() => null);
    if (doc) { ok++; } else { fail++; console.warn("MISSING:", k); }
  }
  await v.close();
  console.log(`verify: ${ok} OK, ${fail} MISSING`);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
