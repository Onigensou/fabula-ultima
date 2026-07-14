// Adds 8 general-purpose cooking ingredients (kitchen staples) to the Material
// folder, tagged for the hot-pot so future unique recipes have stock to draw on.
//
// Tastes are spread across all five families so no recipe combo is impossible:
//   umami : Bean Paste, Cooking Oil    salty : Cheese
//   sweet : Cabbage, Flour         bitter: Cauliflower, Turnip
//   sour  : Cucumber
// All Common → potency 1 each (four of them = potency 4 → Tier 1 before the
// cooker check). Recipe matching is BY NAME, so these names are the handles a
// future _Cooking Config recipes[] entry will reference.
//
// Idempotent — fixed document IDs, re-running overwrites in place.
// Usage: node _populate-food-ingredients.js [--dry]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");

const DRY = process.argv.includes("--dry");
const TPL_ID = "ZoiV53VaLzeRsEps";
const MATERIALS_FOLDER = "36rowiHAcXnIPsKK"; // 💎 Material
const GM_USER = "JQGNzKpDPHJmcUIW";
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Food/Ingredient";

const INGREDIENTS = [
  { id: "FoodBeanPaste001", name: "Bean Paste", taste: "umami", cost: "30",
    icon: `${ICON}/bean-paste_gph.webp`,
    desc: "A dark, salt-fermented bean paste aged in cedar casks. A single spoonful turns plain broth into something that tastes like it simmered all day." },

  // "Cooking Oil", not "Oil" — the world already has an Oil *status effect*, and
  // recipe matching is by NAME, so the distinct name keeps the two unambiguous.
  { id: "FoodOil000000001", name: "Cooking Oil", taste: "umami", cost: "25",
    icon: `${ICON}/oil_gph.webp`,
    desc: "Pressed cooking oil in a stoppered flask. Carries flavour into everything it touches, and makes a campfire pan sing." },

  { id: "FoodCheese000001", name: "Cheese", taste: "salty", cost: "35",
    icon: `${ICON}/cheese_gph.webp`,
    desc: "A firm wheel of cave-cured cheese, rind still dusted with salt. Keeps for weeks in a pack and improves the whole way." },

  { id: "FoodCabbage00001", name: "Cabbage", taste: "sweet", cost: "15",
    icon: `${ICON}/cabbage_gph.webp`,
    desc: "A dense, heavy head of cabbage. Sharp raw — but let it soften in the pot and it turns quietly, surprisingly sweet." },

  { id: "FoodFlour0000001", name: "Flour", taste: "sweet", cost: "10",
    icon: `${ICON}/flour_gph.webp`,
    desc: "A sack of finely milled flour. The humble beginning of every bread, dumpling and pudding worth eating." },

  { id: "FoodCauliflowr01", name: "Cauliflower", taste: "bitter", cost: "20",
    icon: `${ICON}/cauliflower_gph.webp`,
    desc: "A pale, tight-curded head with a faintly bitter bite. Charred over embers, that bitterness becomes the best thing on the plate." },

  { id: "FoodTurnip000001", name: "Turnip", taste: "bitter", cost: "15",
    icon: `${ICON}/turnip_gph.webp`,
    desc: "A stout root, peppery and bitter at the skin. Field rations for a hundred generations of soldiers who had nothing better." },

  { id: "FoodCucumber0001", name: "Cucumber", taste: "sour", cost: "15",
    icon: `${ICON}/cucumber_gph.webp`,
    desc: "Cool and crisp, with a green snap to it. Brined in a jar it turns bracingly sour — the sharpest thing in most travellers' packs." },
];

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

function makeItem({ id, name, img, folder, props }, tpl) {
  return {
    _id: id, name, type: "equippableItem", img, folder,
    effects: [], sort: 0,
    ownership: { default: 0, [GM_USER]: 3 },
    flags: { "custom-system-builder": { version: "4.8.5" } },
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

// --------------------------------------------------------------------------
(async () => {
  assertGameClosed();

  const TASTES = ["bitter", "salty", "sour", "sweet", "umami"];
  for (const i of INGREDIENTS) {
    if (i.id.length !== 16) throw new Error(`Bad id length (${i.id.length}, need 16): ${i.id}`);
    if (!TASTES.includes(i.taste)) throw new Error(`Bad taste on ${i.name}: ${i.taste}`);
  }
  const ids = new Set(INGREDIENTS.map(i => i.id));
  if (ids.size !== INGREDIENTS.length) throw new Error("Duplicate ids");

  if (!DRY) snapshotCollection("items");

  const db = await openCollection("items");
  const tpl = await db.get("!items!" + TPL_ID);
  if (!tpl?.system?.body) { await db.close(); throw new Error("Template missing body"); }

  // Guard: don't silently clobber an existing item that happens to share a name.
  const wanted = new Map(INGREDIENTS.map(i => [i.name, i.id]));
  for await (const [key, val] of db.iterator()) {
    if (!key.startsWith("!items!")) continue;
    const clashId = wanted.get(val?.name);
    if (clashId && val._id !== clashId) {
      await db.close();
      throw new Error(`An item named "${val.name}" already exists (${val._id}) — recipe matching is by NAME, resolve this before adding a duplicate.`);
    }
  }

  const ops = [];
  for (const ing of INGREDIENTS) {
    const item = makeItem({
      id: ing.id, name: ing.name, img: ing.icon,
      folder: MATERIALS_FOLDER,
      props: baseProps(ing.name, "material", {
        item_rarity: "Common",
        item_cost: ing.cost,
        isIngredient: true,
        ingredient_taste: ing.taste,
        ingredient_taste2: "",
        description: `<p><em>${ing.desc}</em></p>`,
      }),
    }, tpl);
    ops.push({ type: "put", key: `!items!${ing.id}`, value: item });
    console.log(`${DRY ? "[DRY] " : ""}${ing.name.padEnd(12)} ${ing.taste.padEnd(6)} ${ing.cost.padStart(3)}z  ${ing.id}`);
  }

  if (DRY) { await db.close(); return; }

  await db.batch(ops);
  await db.close();
  console.log(`\nwrote ${ops.length} ingredients`);

  // Verify
  const v = await openCollection("items");
  let ok = 0;
  for (const ing of INGREDIENTS) {
    const doc = await v.get(`!items!${ing.id}`).catch(() => null);
    const p = doc?.system?.props;
    if (doc && p?.isIngredient === true && p?.ingredient_taste === ing.taste && p?.item_type === "material") ok++;
    else console.warn("BAD:", ing.name, p ? JSON.stringify({ isIngredient: p.isIngredient, taste: p.ingredient_taste, type: p.item_type }) : "MISSING");
  }
  await v.close();
  console.log(`verify: ${ok}/${INGREDIENTS.length} OK`);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
