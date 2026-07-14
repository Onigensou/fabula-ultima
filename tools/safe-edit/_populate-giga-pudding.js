// Adds the unique cooking recipe "Giga Pudding" (Jellopy x4).
//   • Creates the Giga Pudding dish item + its Active Effect
//       (damage_receiving_mod_physical +3 = -3 incoming physical damage)
//   • Registers the recipe in _Cooking Config flags (intrinsic — no recipe ITEM,
//     nobody has to "know" it; 4 Jellopy in the pot always yields Giga Pudding)
//
// Giga Pudding deliberately gets NO dish-matrix entry: recipe matches bypass the
// taste/tier math, which is what makes it exclusive to the Jellopy x4 combo.
//
// Idempotent — fixed document IDs, re-running overwrites in place.
// Usage: node _populate-giga-pudding.js [--dry]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");
const { safeEdit } = require("./lib");

const DRY = process.argv.includes("--dry");
const TPL_ID = "ZoiV53VaLzeRsEps";
const DISHES_FOLDER = "UNuBsFNeuyDDZ5AZ";
const GM_USER = "JQGNzKpDPHJmcUIW";
const MOD = "fabula-ultima-companion";
const CFG_ID = "oG4U8b6if8enaswT"; // _Cooking Config

const DISH_ID = "G1gaPudd1ngD1sh0"; // 16-char Foundry document IDs
const AE_ID = "G1gaPudd1ngAEff0";
const JELLOPY_NAME = "Jellopy"; // Item.L1ki1clOnOhpl7wN — matching is BY NAME

const DISH = {
  name: "Giga Pudding",
  icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Food/Doraemon/160664.webp",
  desc: "<p>An absurdly enormous pudding, quivering under its own weight — four whole jellopies rendered down and set into one trembling golden dome. It jiggles. It endures. So do you.</p><p>Everyone who eats gains <strong>Physical Damage Reduction +3</strong> until the next rest.</p>",
  changes: [{ key: "damage_receiving_mod_physical", mode: 2, value: "3", priority: null }],
};

const RECIPE = {
  name: "Giga Pudding",
  dishId: DISH_ID,
  ingredients: [{ name: JELLOPY_NAME, qty: 4 }],
};

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
(async () => {
  assertGameClosed();

  // snapshot BEFORE opening — our own handle holds the LOCK and would
  // otherwise break the backup copy
  if (!DRY) snapshotCollection("items");

  const db = await openCollection("items");
  const tpl = await db.get("!items!" + TPL_ID);
  if (!tpl?.system?.body) { await db.close(); throw new Error("Template missing body"); }

  // sanity: the ingredient the recipe matches on must exist under this exact name
  const jellopy = await db.get("!items!L1ki1clOnOhpl7wN").catch(() => null);
  if (!jellopy) { await db.close(); throw new Error("Jellopy (L1ki1clOnOhpl7wN) not found"); }
  if (jellopy.name !== JELLOPY_NAME) {
    await db.close();
    throw new Error(`Jellopy name mismatch: world has "${jellopy.name}", recipe expects "${JELLOPY_NAME}"`);
  }

  const dish = makeItem({
    id: DISH_ID, name: DISH.name, img: DISH.icon,
    folder: DISHES_FOLDER,
    effects: [AE_ID],
    props: baseProps(DISH.name, "consumable", { description: DISH.desc }),
    flags: { [MOD]: { cookingDish: { family: "recipe", tier: 0, instant: {} } } },
  }, tpl);

  const ae = makeAe({
    id: AE_ID, parentId: DISH_ID, name: DISH.name,
    icon: DISH.icon, desc: DISH.desc, changes: DISH.changes,
  });

  if (DRY) {
    console.log("[DRY] would create dish:", DISH_ID, DISH.name);
    console.log("[DRY] AE changes:", JSON.stringify(DISH.changes));
    console.log("[DRY] would register recipe:", JSON.stringify(RECIPE));
    await db.close();
    return;
  }

  await db.batch([
    { type: "put", key: `!items!${DISH_ID}`, value: dish },
    { type: "put", key: `!items.effects!${DISH_ID}.${AE_ID}`, value: ae },
  ]);
  await db.close();
  console.log(`created dish: ${DISH.name} → ${DISH_ID} (AE ${AE_ID})`);

  // Register the recipe. Targeted dotted path so the deep-merge cannot disturb
  // the existing matrix / goopDishId / mysteryDishId.
  await safeEdit({
    uuid: `Item.${CFG_ID}`,
    patch: { [`flags.${MOD}.cookingConfig.recipes`]: [RECIPE] },
    note: "cooking: register Giga Pudding unique recipe (Jellopy x4)",
  });
  console.log("patched _Cooking Config → recipes[]");

  // Verify
  const v = await openCollection("items");
  const wroteDish = await v.get(`!items!${DISH_ID}`).catch(() => null);
  const wroteAe = await v.get(`!items.effects!${DISH_ID}.${AE_ID}`).catch(() => null);
  const cfg = await v.get(`!items!${CFG_ID}`).catch(() => null);
  await v.close();

  const cc = cfg?.flags?.[MOD]?.cookingConfig ?? {};
  console.log("verify dish:   ", wroteDish ? `OK (${wroteDish.name})` : "MISSING");
  console.log("verify AE:     ", wroteAe ? `OK (${JSON.stringify(wroteAe.changes)})` : "MISSING");
  console.log("verify recipes:", JSON.stringify(cc.recipes ?? null));
  console.log("matrix intact: ", Object.keys(cc.matrix ?? {}).length === 5 ? "OK (5 families)" : "!! MATRIX DAMAGED !!");
  console.log("goop/mystery:  ", cc.goopDishId && cc.mysteryDishId ? "OK" : "!! MISSING !!");
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
