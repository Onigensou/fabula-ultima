// Adds the unique-recipe layer to the cooking system:
//   • 5 staple ingredients (Egg / Rice / Fresh Milk / Meat / Rock Salt) — cheap
//     and common ON PURPOSE, because staples are what players toss in casually,
//     which is what makes a unique recipe discoverable by accident.
//   • Lightning Essence — NOT a staple; the second member of the elemental
//     essence material cycle, built to mirror the existing Flame Essence
//     (Item.SkgnxeQnq4DVhVVU: material, sour, Common, 60z). Add further
//     essences here with the same shape.
//   • 11 unique dishes + their Active Effects.
//   • Registers all 11 as core+filler recipes in _Cooking Config flags.
//
// Every recipe here uses `core` (the pot must CONTAIN these; every other slot is
// free filler), NOT the exact `ingredients` spelling. Exact recipes consume the
// whole pot and so only ever fire at one party size — see cooking-api.js.
// Giga Pudding stays exact and is preserved untouched by this script.
//
// Idempotent — fixed document IDs, re-running overwrites in place.
// Usage: node _populate-unique-dishes.js [--dry]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");
const { safeEdit } = require("./lib");

const DRY = process.argv.includes("--dry");
const TPL_ID = "ZoiV53VaLzeRsEps";
const MATERIAL_FOLDER = "36rowiHAcXnIPsKK"; // 💎 Material
const DISHES_FOLDER = "UNuBsFNeuyDDZ5AZ";   // 🍲 Dishes
const GM_USER = "JQGNzKpDPHJmcUIW";
const MOD = "fabula-ultima-companion";
const CFG_ID = "oG4U8b6if8enaswT";          // _Cooking Config

// ── Staple ingredients ──────────────────────────────────────────────────────
// NOTE "Fresh Milk", not "Milk": the world already has an established "Milk"
// consumable (30 HP + Strong, 10z, with its own crafting recipe). Recipe
// matching is BY NAME, so a second "Milk" would be a genuine hazard.
const INGREDIENTS = [
  { id: "F00dStap1eEgg000", name: "Egg",        taste: "umami", cost: "12",
    img: "icons/consumables/eggs/eggs-white.webp",
    desc: "<p><em>A plain speckled egg. Somebody's breakfast, somebody's masterpiece.</em></p>" },
  { id: "F00dStap1eRice00", name: "Rice",       taste: "sweet", cost: "10",
    img: "icons/consumables/grains/sack-rice-open-brown.webp",
    desc: "<p><em>An open sack of polished grain. Fills a pot, fills a stomach, asks nothing.</em></p>" },
  { id: "F00dStap1eMi1k00", name: "Fresh Milk", taste: "sweet", cost: "20",
    img: "icons/consumables/drinks/pitcher-dripping-white.webp",
    desc: "<p><em>Still warm from the pail. Turns anything it touches soft and rich.</em></p>" },
  { id: "F00dStap1eMeat00", name: "Meat",       taste: "umami", cost: "45",
    img: "icons/consumables/meat/hock-leg-pink-brown.webp",
    desc: "<p><em>A good honest cut. What it was is between you and the butcher.</em></p>" },
  { id: "F00dStap1eSa1t00", name: "Rock Salt",  taste: "salty", cost: "8",
    img: "icons/consumables/food/salt-seasoning-spice-pink.webp",
    desc: "<p><em>Coarse pink crystals chipped from a seam. The oldest seasoning there is.</em></p>" },

  // Elemental essence cycle — mirrors Flame Essence (sour / Common / 60z), whose
  // description this deliberately echoes so the set reads as one family. The RO
  // material pack Flame Essence draws from has no lightning stone (its essence
  // run is fire/water/earth/shadow/gold), hence the core raw-gem icon.
  { id: "E1emEssenceB01t0", name: "Lightning Essence", taste: "sour", cost: "60",
    img: "icons/commodities/gems/gem-rough-cushion-yellow.webp",
    desc: "<p><em>Essence that can be obtained from monsters in the storm area in the ecological environment.</em></p>" },
];

// ── Unique dishes ───────────────────────────────────────────────────────────
// changes[] are CSB prop keys (see cooking-api.js applyDish).
//   bonus_<attr> ±2  = one attribute DIE STAGE. Debuffs (Weak/Slow/Dazed/
//     Shaken) already use this exact key and value, and it sits INSIDE the
//     `min(max(base + bonus, 4), 14)` clamp — so food can never push a die past
//     d14. The Strong/Swift buff family writes `<attr>_current` instead, a
//     different key applied AFTER the clamp, so buff and dish stack natively.
//   condition_<slug> OVERRIDE "IM" = immunity. On the PC template these props
//     are CSB labels with an empty formula, so the AE override lands on the
//     computed value and getConditionAffinity() reads "IM".
const AE_ADD = 2;      // CONST.ACTIVE_EFFECT_MODES.ADD
const AE_OVERRIDE = 5; // CONST.ACTIVE_EFFECT_MODES.OVERRIDE
const G = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Food/Genshin";

const DISHES = [
  // ── Attribute cycle — one die stage, stacks with Strong/Swift ──────────────
  { id: "Un1qD1shSteak000", ae: "Un1qAESteak00000", name: "Grilled-Hog Steak",
    img: `${G}/Item_Steak.webp`, core: [{ name: "Meat" }, { name: "Cooking Oil" }],
    desc: "<p><em>A thick cut seared hard in its own fat, crust black, centre pink. The kind of meal that makes you want to pick something up and throw it.</em></p><p>Increases <strong>Might</strong> by one die size until the next rest.</p>",
    changes: [{ key: "bonus_mig", mode: AE_ADD, value: "2", priority: null }] },

  { id: "Un1qD1shSoda0000", ae: "Un1qAESoda000000", name: "Zesty Soda",
    img: "icons/consumables/drinks/alcohol-spirits-bottle-green.webp",
    core: [{ name: "Starfruit" }, { name: "Lightning Essence" }],
    desc: "<p><em>Starfruit pressed cold, then a shard of storm essence dropped in to do the fizzing. It bites the tongue going down and leaves your hands quick for hours.</em></p><p>Increases <strong>Dexterity</strong> by one die size until the next rest.</p>",
    changes: [{ key: "bonus_dex", mode: AE_ADD, value: "2", priority: null }] },

  { id: "Un1qD1shConge000", ae: "Un1qAECongee0000", name: "Sage Congee",
    img: `${G}/Item_Bamboo_Shoot_Soup.webp`, core: [{ name: "Rice" }, { name: "Mindful Sole" }],
    desc: "<p><em>Rice simmered down to silk with a whole sole folded through it. Quiet food. You finish the bowl noticing things you had walked past all week.</em></p><p>Increases <strong>Insight</strong> by one die size until the next rest.</p>",
    changes: [{ key: "bonus_ins", mode: AE_ADD, value: "2", priority: null }] },

  { id: "Un1qD1shCustard0", ae: "Un1qAECustard000", name: "Moon Custard",
    img: `${G}/Item_Almond_Tofu.webp`, core: [{ name: "Egg" }, { name: "Fresh Milk" }],
    desc: "<p><em>Egg and milk steamed until they set into one pale trembling disc. It looks like the moon in a cup and it steadies you like one.</em></p><p>Increases <strong>Willpower</strong> by one die size until the next rest.</p>",
    changes: [{ key: "bonus_wlp", mode: AE_ADD, value: "2", priority: null }] },

  // ── Ward cycle — condition immunity ───────────────────────────────────────
  { id: "Un1qD1shFugu0000", ae: "Un1qAEFugu000000", name: "Pufferfish Sashimi",
    img: `${G}/Item_Sashimi_Platter.webp`, core: [{ name: "Toxic Puffer" }, { name: "Rock Salt" }],
    desc: "<p><em>Sliced thin enough to read through, salted, and arranged like petals. Cut correctly it is the finest thing you will ever eat. Cut poorly it is the last.</em></p><p>Grants immunity to <strong>Poisoned</strong> and <strong>Envenomed</strong> until the next rest.</p>",
    changes: [
      { key: "condition_poisoned", mode: AE_OVERRIDE, value: "IM", priority: null },
      { key: "condition_envenomed", mode: AE_OVERRIDE, value: "IM", priority: null },
    ] },

  { id: "Un1qD1shCreamSt0", ae: "Un1qAECreamStew0", name: "Cream Stew",
    img: `${G}/Item_Cream_Stew.webp`, core: [{ name: "Ember Petal" }, { name: "Fresh Milk" }],
    desc: "<p><em>Milk held just under the boil with an ember petal turning slowly in it. The heat settles somewhere behind the ribs and stays there all day.</em></p><p>Grants immunity to <strong>Burn</strong> and <strong>Hypothermia</strong> until the next rest.</p>",
    changes: [
      { key: "condition_burn", mode: AE_OVERRIDE, value: "IM", priority: null },
      { key: "condition_hypothermia", mode: AE_OVERRIDE, value: "IM", priority: null },
    ] },

  { id: "Un1qD1shHerba1T0", ae: "Un1qAEHerba1Tea0", name: "Herbal Tea",
    img: "icons/consumables/drinks/tea-jug-gourd-brown.webp",
    core: [{ name: "Darkroot Herb" }, { name: "Honey" }],
    desc: "<p><em>Bitter root steeped long and cut with honey until it is only almost bitter. Two cups in, the noise in your head goes quiet.</em></p><p>Grants immunity to <strong>Dazed</strong> and <strong>Confused</strong> until the next rest.</p>",
    changes: [
      { key: "condition_dazed", mode: AE_OVERRIDE, value: "IM", priority: null },
      { key: "condition_confused", mode: AE_OVERRIDE, value: "IM", priority: null },
    ] },

  { id: "Un1qD1shR1ceBa11", ae: "Un1qAER1ceBa1100", name: "Rice Ball",
    img: `${G}/Item_Jade_Parcels.webp`, core: [{ name: "Rice" }, { name: "Rock Salt" }],
    desc: "<p><em>Rice pressed in salted palms into a shape that fits a hand. No garnish, no ceremony. Somebody made this for you to take with you.</em></p><p>Grants immunity to <strong>Shaken</strong> and <strong>Frightened</strong> until the next rest.</p>",
    changes: [
      { key: "condition_shaken", mode: AE_OVERRIDE, value: "IM", priority: null },
      { key: "condition_frightened", mode: AE_OVERRIDE, value: "IM", priority: null },
    ] },

  // ── Unique properties ─────────────────────────────────────────────────────
  { id: "Un1qD1shOme1ette", ae: "Un1qAEOme1ette00", name: "Lucky Omelette",
    img: `${G}/Item_Teyvat_Fried_Egg.webp`, core: [{ name: "Lucky Loach" }, { name: "Egg" }],
    desc: "<p><em>A loach that was already having a better day than most, folded into an egg. It comes out of the pan gold on both sides, every time, for no reason anyone can explain.</em></p><p>Widens your <strong>critical range by 1</strong> until the next rest.</p>",
    changes: [{ key: "critical_dice_range", mode: AE_ADD, value: "1", priority: null }] },

  { id: "Un1qD1shSouff1e0", ae: "Un1qAESouff1e000", name: "Regretful Soufflé",
    img: "icons/consumables/food/berries-cream-bowl-mint-red.webp",
    core: [{ name: "Regret", qty: 2 }],
    desc: "<p><em>It rose. For one glorious moment it rose. What is left in the dish is dense, cracked, sunken in the middle — and, infuriatingly, delicious. You eat it fast and angry.</em></p><p><strong>+5</strong> damage dealt, but <strong>−3</strong> physical damage reduction, until the next rest.</p>",
    changes: [
      { key: "extra_damage_mod_all", mode: AE_ADD, value: "5", priority: null },
      { key: "damage_receiving_mod_physical", mode: AE_ADD, value: "-3", priority: null },
    ] },

  // Conflict-start Shield: NOT an AE change (shield_value is a spendable pool,
  // not a derived stat). Rides as a flag; BD's food-conflict-start.js sweep
  // grants it raise-only at every conflict_start. See balance note below.
  { id: "Un1qD1shGo1emSt0", ae: "Un1qAEGo1emStew0", name: "Golem Stew",
    img: "icons/consumables/food/pot-soup-white.webp",
    core: [{ name: "Golem Heart" }, { name: "Bean Paste" }],
    desc: "<p><em>A golem's core boiled down in bean paste for half a day until the stone gives up and goes soft. It sits in you like ballast.</em></p><p>At the <strong>start of every conflict</strong>, gain <strong>15 Shield</strong> (does not stack with a larger Shield). Lasts until the next rest.</p>",
    changes: [],
    conflictStart: { shield: 15 } },
];

// --------------------------------------------------------------------------
// `createdTime` survives a re-run. world-export strips modifiedTime but NOT
// createdTime, so regenerating it churns every doc in the review diff on each
// run — and diff noise is precisely what hides a real removal. Existing docs
// keep their original timestamp; only genuinely new ones get "now".
const _created = new Map(); // docId -> original createdTime

function stats(id) {
  const now = Date.now();
  return {
    compendiumSource: null, duplicateSource: null,
    coreVersion: "12.343", systemId: "custom-system-builder", systemVersion: "4.8.5",
    createdTime: _created.get(id) ?? now, modifiedTime: now, lastModifiedBy: GM_USER,
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
      // props.id / props.uuid must self-identify — a naive clone leaves an item
      // claiming to be its clone source.
      props: { ...props, id, uuid: `Item.${id}`, img },
    },
    _stats: stats(id),
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
    sort: 0, _stats: stats(id),
  };
}

// --------------------------------------------------------------------------
(async () => {
  assertGameClosed();
  if (!DRY) snapshotCollection("items"); // BEFORE opening — our handle holds the LOCK

  const db = await openCollection("items");
  const tpl = await db.get("!items!" + TPL_ID);
  if (!tpl?.system?.body) { await db.close(); throw new Error("Template missing body"); }

  // Every ingredient a recipe names must exist under that EXACT name, or the
  // recipe is silently undiscoverable. Check before writing anything.
  const existing = new Map();
  for await (const [key, val] of db.iterator()) {
    // Same pass records original createdTime for both items and their AEs, so a
    // re-run rewrites content without churning timestamps (see stats()).
    if (val?._id && val?._stats?.createdTime) _created.set(val._id, val._stats.createdTime);
    if (key.startsWith("!items!") && val?.name) {
      if (!existing.has(val.name)) existing.set(val.name, []);
      existing.get(val.name).push({ id: val._id, type: val.system?.props?.item_type });
    }
  }
  const newNames = new Set(INGREDIENTS.map(i => i.name));
  const problems = [];

  // Foundry document IDs are EXACTLY 16 chars. A 15-char id writes to LevelDB
  // and reads back fine offline, but Foundry drops the document on load — which
  // is how Rice Ball shipped with no Active Effect and only turned up in live
  // verification. Cheap assertion, so it can never happen again.
  for (const d of DISHES) {
    if (d.id.length !== 16) problems.push(`dish "${d.name}" id "${d.id}" is ${d.id.length} chars, must be 16`);
    if (d.ae.length !== 16) problems.push(`dish "${d.name}" AE id "${d.ae}" is ${d.ae.length} chars, must be 16`);
  }
  for (const i of INGREDIENTS) {
    if (i.id.length !== 16) problems.push(`ingredient "${i.name}" id "${i.id}" is ${i.id.length} chars, must be 16`);
  }
  for (const d of DISHES) {
    for (const c of d.core) {
      if (newNames.has(c.name)) continue;
      const hits = (existing.get(c.name) ?? []).filter(h => h.type === "material");
      if (!hits.length) problems.push(`${d.name}: core ingredient "${c.name}" not found as a material`);
    }
  }
  for (const i of INGREDIENTS) {
    const dup = (existing.get(i.name) ?? []).filter(h => h.id !== i.id);
    if (dup.length) problems.push(`ingredient "${i.name}" collides with existing item(s): ${dup.map(d => d.id).join(", ")}`);
  }
  if (problems.length) { await db.close(); throw new Error("Pre-flight failed:\n  " + problems.join("\n  ")); }

  // Build docs
  const batch = [];
  for (const i of INGREDIENTS) {
    batch.push({ type: "put", key: `!items!${i.id}`, value: makeItem({
      id: i.id, name: i.name, img: i.img, folder: MATERIAL_FOLDER,
      props: baseProps(i.name, "material", {
        description: i.desc, item_cost: i.cost, item_rarity: "Common",
        isIngredient: true, ingredient_taste: i.taste,
      }),
    }, tpl) });
  }
  for (const d of DISHES) {
    batch.push({ type: "put", key: `!items!${d.id}`, value: makeItem({
      id: d.id, name: d.name, img: d.img, folder: DISHES_FOLDER, effects: [d.ae],
      props: baseProps(d.name, "consumable", { description: d.desc }),
      flags: { [MOD]: { cookingDish: {
        family: "recipe", tier: 0, instant: {},
        ...(d.conflictStart ? { conflictStart: d.conflictStart } : {}),
      } } },
    }, tpl) });
    batch.push({ type: "put", key: `!items.effects!${d.id}.${d.ae}`, value: makeAe({
      id: d.ae, parentId: d.id, name: d.name, icon: d.img, desc: d.desc, changes: d.changes,
    }) });
  }

  const RECIPES = DISHES.map(d => ({ name: d.name, dishId: d.id, core: d.core }));

  if (DRY) {
    console.log(`[DRY] ${INGREDIENTS.length} ingredients, ${DISHES.length} dishes (${batch.length} keys)`);
    for (const d of DISHES) {
      console.log(`  ${d.name.padEnd(20)} core=${d.core.map(c => c.name + (c.qty ? ` x${c.qty}` : "")).join(" + ")}`);
      console.log(`  ${"".padEnd(20)} ${d.changes.length ? JSON.stringify(d.changes) : "(no AE changes)"}${d.conflictStart ? ` conflictStart=${JSON.stringify(d.conflictStart)}` : ""}`);
    }
    await db.close();
    return;
  }

  await db.batch(batch);
  await db.close();
  console.log(`created ${INGREDIENTS.length} ingredients + ${DISHES.length} dishes`);

  // Register recipes. Read-modify-write so Giga Pudding (and any other existing
  // entry) survives; targeted dotted path so the deep-merge can't touch
  // matrix / goopDishId / mysteryDishId.
  const r = await openCollection("items");
  const cfgDoc = await r.get(`!items!${CFG_ID}`);
  await r.close();
  const prior = cfgDoc?.flags?.[MOD]?.cookingConfig?.recipes ?? [];
  const mine = new Set(RECIPES.map(x => x.dishId));
  const merged = [...prior.filter(p => !mine.has(p.dishId)), ...RECIPES];

  await safeEdit({
    uuid: `Item.${CFG_ID}`,
    patch: { [`flags.${MOD}.cookingConfig.recipes`]: merged },
    note: `cooking: register ${RECIPES.length} unique core+filler recipes`,
  });
  console.log(`patched _Cooking Config → recipes[] (${merged.length} total)`);

  // Verify
  const v = await openCollection("items");
  let okItems = 0;
  for (const i of INGREDIENTS) if (await v.get(`!items!${i.id}`).catch(() => null)) okItems++;
  let okDishes = 0, okAes = 0;
  for (const d of DISHES) {
    if (await v.get(`!items!${d.id}`).catch(() => null)) okDishes++;
    if (await v.get(`!items.effects!${d.id}.${d.ae}`).catch(() => null)) okAes++;
  }
  const cfg2 = await v.get(`!items!${CFG_ID}`).catch(() => null);
  await v.close();
  const cc = cfg2?.flags?.[MOD]?.cookingConfig ?? {};

  console.log(`verify ingredients: ${okItems}/${INGREDIENTS.length}`);
  console.log(`verify dishes:      ${okDishes}/${DISHES.length}  (AEs ${okAes}/${DISHES.length})`);
  console.log(`verify recipes:     ${(cc.recipes ?? []).length} (Giga Pudding preserved: ${(cc.recipes ?? []).some(x => x.name === "Giga Pudding")})`);
  console.log(`matrix intact:      ${Object.keys(cc.matrix ?? {}).length === 5 ? "OK (5 families)" : "!! MATRIX DAMAGED !!"}`);
  console.log(`goop/mystery:       ${cc.goopDishId && cc.mysteryDishId ? "OK" : "!! MISSING !!"}`);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
