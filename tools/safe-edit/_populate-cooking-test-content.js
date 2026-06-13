// Populate minimal cooking world content for the testing phase:
//   1. Tag Nibbers (umami) + Spore (bitter) as ingredients (Jellopy already
//      tagged sweet — survived the 2026-06-12 rollback).
//   2. Create ONE dish item — "Hearty Hot-Pot" (+10 Max HP AE) — in the
//      existing 🍲 Dishes folder (UNuBsFNeuyDDZ5AZ).
//   3. Create the _Cooking Config item whose matrix maps EVERY family/tier
//      to that one dish. This is a TESTING SHIM so any pot outcome resolves;
//      replace the matrix entries as real dishes get authored.
//
// Payload impact: ~100 KB (2 items with template body copies + 1 AE) — far
// inside the ~15 MB headroom. See feedback_world_payload_limit.
//
// Usage: node _populate-cooking-test-content.js [--dry]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");
const { safeEdit } = require("./lib");

const DRY = process.argv.includes("--dry");
const TPL_ID = "ZoiV53VaLzeRsEps";
const DISHES_FOLDER = "UNuBsFNeuyDDZ5AZ";
const GM_USER = "JQGNzKpDPHJmcUIW";
const MOD = "fabula-ultima-companion";

const DISH_ICON = "icons/consumables/food/bowl-stew-tofu-potato-brown.webp";
const CONFIG_ICON = "icons/svg/book.svg";

function randomID(n = 16) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function stats() {
  const now = Date.now();
  return {
    compendiumSource: null, duplicateSource: null,
    coreVersion: "12.343", systemId: "custom-system-builder", systemVersion: "4.8.5",
    createdTime: now, modifiedTime: now, lastModifiedBy: GM_USER,
  };
}

// Base props every equippableItem carries (modeled on existing consumables);
// CSB fills in anything missing on first sheet render.
function baseProps(name, itemType, description) {
  return {
    name,
    isEquipped: false, isMartial: false, isModule: false, isUnique: false,
    isKey: false, isSet: false, isRelatedItem: false, isIngredient: false,
    optional_params: {}, active_effect_config_table: {}, effect_table: {},
    item_type: itemType, item_rarity: "Common", item_cost: "0",
    item_quantity: "1", ip_cost: "0",
    ingredient_taste: "", ingredient_taste2: "", recipe_kind: "", recipe_dish_uuid: "",
    description,
  };
}

function makeItem({ id, name, img, folder, props, effects = [], flags = {} }, tpl) {
  return {
    _id: id, name, type: "equippableItem", img, folder,
    effects, sort: 0,
    ownership: { default: 3, [GM_USER]: 3 },
    flags: { "custom-system-builder": { version: "4.8.5" }, ...flags },
    system: {
      template: TPL_ID,
      templateSystemUniqueVersion: tpl.system.templateSystemUniqueVersion,
      hidden: structuredClone(tpl.system.hidden),
      body: structuredClone(tpl.system.body),
      header: structuredClone(tpl.system.header),
      display: structuredClone(tpl.system.display),
      modifiers: [],
      unique: false, uniqueId: id,
      props,
    },
    _stats: stats(),
  };
}

(async () => {
  assertGameClosed();

  // --- 1. tag the two untagged ingredients --------------------------------
  const tags = [
    { uuid: "Item.enYeUpvUT2OWxZGC", name: "Nibbers", taste: "umami" },
    { uuid: "Item.gx7c6eOkqOSbKKxH", name: "Spore", taste: "bitter" },
  ];
  for (const t of tags) {
    if (DRY) { console.log(`[DRY] would tag ${t.name} → ${t.taste}`); continue; }
    await safeEdit({
      uuid: t.uuid,
      patch: {
        "system.props.isIngredient": true,
        "system.props.ingredient_taste": t.taste,
        "system.props.ingredient_taste2": "",
      },
      note: `cooking: tag ${t.name} as ${t.taste} ingredient`,
    });
    console.log(`tagged ${t.name} → ${t.taste}`);
  }

  // --- 2 + 3. dish item + AE + config item (one atomic batch) -------------
  // Snapshot BEFORE opening the collection — our own open handle holds the
  // LevelDB LOCK and makes the backup copy fail otherwise.
  if (!DRY) snapshotCollection("items");
  const db = await openCollection("items");
  const tpl = await db.get("!items!" + TPL_ID);
  if (!tpl?.system?.body) throw new Error("Template missing body");

  const dishId = randomID();
  const aeId = randomID();
  const cfgId = randomID();

  const dish = makeItem({
    id: dishId,
    name: "Hearty Hot-Pot",
    img: DISH_ICON,
    folder: DISHES_FOLDER,
    effects: [aeId],
    props: baseProps("Hearty Hot-Pot", "consumable",
      "<p>A rich, bubbling hot-pot. Everyone who shares it gains <strong>+10 Maximum Hit Points</strong> until the next rest.</p>"),
    flags: { [MOD]: { cookingDish: { family: "umami", tier: 1, instant: {} } } },
  }, tpl);

  const dishAe = {
    _id: aeId,
    name: "Hearty Hot-Pot",
    img: DISH_ICON,
    description: "<p>+10 Maximum Hit Points until the next rest.</p>",
    type: "base",
    system: { tags: ["food"] },
    changes: [{ key: "max_hp", mode: 2, value: "10", priority: null }],
    disabled: false,
    duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
    origin: null, tint: "#ffffff", transfer: false, statuses: [],
    flags: {
      "custom-system-builder": {
        originalParentId: dishId, originalId: aeId,
        originalUuid: `Item.${dishId}.ActiveEffect.${aeId}`, isFromTemplate: false,
      },
    },
    sort: 0,
    _stats: stats(),
  };

  // TESTING SHIM: every family/tier resolves to the single test dish.
  const tiers = { 1: dishId, 2: dishId, 3: dishId };
  const config = makeItem({
    id: cfgId,
    name: "_Cooking Config",
    img: CONFIG_ICON,
    folder: DISHES_FOLDER,
    props: baseProps("_Cooking Config", "misc",
      "<p>Cooking system tunables live in this item's flags (fabula-ultima-companion.cookingConfig). Do not delete.</p>"),
    flags: {
      [MOD]: {
        cookingConfig: {
          matrix: {
            bitter: { ...tiers }, salty: { ...tiers }, sour: { ...tiers },
            sweet: { ...tiers }, umami: { ...tiers },
          },
          mysteryDishId: null,
          goopDishId: null,
        },
      },
    },
  }, tpl);

  const ops = [
    { type: "put", key: `!items!${dishId}`, value: dish },
    { type: "put", key: `!items.effects!${dishId}.${aeId}`, value: dishAe },
    { type: "put", key: `!items!${cfgId}`, value: config },
  ];

  if (DRY) {
    console.log("[DRY] would create:", JSON.stringify({ dishId, aeId, cfgId }, null, 1));
  } else {
    await db.batch(ops);
    console.log("created:", JSON.stringify({ dishId, aeId, cfgId }));
  }
  await db.close();

  // --- verify --------------------------------------------------------------
  if (!DRY) {
    const v = await openCollection("items");
    for (const key of [`!items!${dishId}`, `!items.effects!${dishId}.${aeId}`, `!items!${cfgId}`]) {
      const doc = await v.get(key).catch(() => null);
      console.log(doc ? `VERIFY OK ${key} (${doc.name})` : `VERIFY FAILED ${key}`);
    }
    await v.close();
  }
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
