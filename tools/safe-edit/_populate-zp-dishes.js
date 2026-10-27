// Zero Power dish cycle (2026-10-28):
//   • Katsudon           +1 ZP — core Meat + Egg + Rice            (Common staples)
//   • Manna Cake         +2 ZP — core Flour + Honey + Dewdrop      (moderate: gathered)
//   • Sæhrímnir Feast    +3 ZP — core Prime Steak + Mead           (very hard: Rare drops)
// Every eater, plus active guests / unique summons with a gauge, gains the ZP
// (cooking-api applyDish `instant.zp`). `instantOnly`: the meal slot is taken
// (old food buff cleared) but no new buff is created.
//
// New materials (clones of Animal Fang, the house material donor):
//   • Dewdrop     Common sweet  15z — Wyrmwood & Ancient Temple / Valley Material tables, Dryad steal
//   • Prime Steak Rare   umami 300z — Fafnir Castle Material table, Dire Orc + Drakoza steal
//   • Mead        Rare   sweet 300z — Fafnir Castle Material table, Elite Bandit + Roo steal
// Each steal share is carved out of that monster's existing material row, so
// consumable / equipment odds are untouched (reference_steal_table budget rule).
//
// Idempotent — fixed document IDs, re-running overwrites in place.
// Usage: node _populate-zp-dishes.js [--dry]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");
const { safeEdit } = require("./lib");

const DRY = process.argv.includes("--dry");
const MOD = "fabula-ultima-companion";
const GM_USER = "JQGNzKpDPHJmcUIW";
const TPL_ID = "ZoiV53VaLzeRsEps";          // _equippableItemTemplate
const DISHES_FOLDER = "UNuBsFNeuyDDZ5AZ";   // 🍲 Dishes
const MATERIAL_FOLDER = "36rowiHAcXnIPsKK"; // 💎 Material
const CFG_ID = "oG4U8b6if8enaswT";          // _Cooking Config
const DONOR = "oAP85eeLJCliYm2E";           // Animal Fang
const EMPTY = "(Empty)";
const LOOT_TYPES = new Set(["material", "consumable", "weapon", "armor", "accessory", "shield"]);
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/";

// ── Materials ───────────────────────────────────────────────────────────────
const MATERIALS = [
  { id: "ZpMatDewdrop0000", name: "Dewdrop", rarity: "Common", taste: "sweet", cost: "15",
    img: ICON + "Material/Genshin/Item_Drop_of_Tainted_Water.webp",
    lore: "Morning dew shaken from leaves into a vial before the sun burns it off." },
  { id: "ZpMatPrimeSteak0", name: "Prime Steak", rarity: "Rare", taste: "umami", cost: "300",
    img: ICON + "Material/Genshin/Item_Raw_Meat.webp",
    lore: "A thick, marbled cut from a large beast. The kind of meat a whole hall would gather around." },
  { id: "ZpMatMead0000000", name: "Mead", rarity: "Rare", taste: "sweet", cost: "300",
    img: ICON + "Food/Wuthering%20Wave/Item_Nectarwine.webp",
    lore: "Honey wine, aged long and poured for celebrations. Rarely carried, never shared cheaply." },
];

// ── Dishes ──────────────────────────────────────────────────────────────────
const zpBullet = (n) => `<ul><li><p>Everyone who eats this dish gains <strong>${n}</strong> Zero Power. Zero Power above the maximum is wasted.</p></li></ul>`;
const DISHES = [
  { id: "ZpD1shKatsudon00", name: "Katsudon", zp: 1,
    img: ICON + "Food/NEO%20The%20World%20Ends%20with%20you/NEO_Food_052_Grand_Slam_Meat_Bowl.webp",
    core: [{ name: "Meat" }, { name: "Egg" }, { name: "Rice" }],
    lore: "A fried cutlet laid over rice and bound with egg. Its name echoes the word for victory, so those facing a trial eat it the night before." },
  { id: "ZpD1shMannaCake0", name: "Manna Cake", zp: 2,
    img: ICON + "Food/Wuthering%20Wave/Item_Oaknut_Honeycake.webp",
    core: [{ name: "Flour" }, { name: "Honey" }, { name: "Dewdrop" }],
    lore: "Bread that fell with the morning dew to feed wanderers lost in the wastes. It tasted of honey, and of not being forgotten." },
  { id: "ZpD1shSaehrimnir", name: "Sæhrímnir Feast", zp: 3,
    img: ICON + "Food/NEO%20The%20World%20Ends%20with%20you/NEO_Food_022_Whole_Hog_BBQ.webp",
    core: [{ name: "Prime Steak" }, { name: "Mead" }],
    // Two-item core: a pot that also holds Rice + Rock Salt would otherwise fall
    // to Rice Ball by declaration order. The Rare core must win.
    priority: 10,
    lore: "The boar of Valhalla, cooked each night for the slain and whole again by dawn. Warriors who know the end is coming still feast, and rise ready to meet it." },
];

// ── Material table rows ─────────────────────────────────────────────────────
// [rowId, tableId, expected table name, material id]
const ROWS = [
  ["ZpRowDewdropWyrm", "aCK7rDJ2A21ZWfcj", "Wyrmwood & Ancient Temple — Material", "ZpMatDewdrop0000"],
  ["ZpRowDewdropVall", "QailcoOmaoZW0v6b", "Valley of the Dragon - Material", "ZpMatDewdrop0000"],
  ["ZpRowPrimeStkFaf", "1rLmUBY4E7xxrOlA", "Fafnir Castle - Material", "ZpMatPrimeSteak0"],
  ["ZpRowMeadFafnir0", "1rLmUBY4E7xxrOlA", "Fafnir Castle - Material", "ZpMatMead0000000"],
];

// ── Steal tables (full table, written outright; weights sum to 100) ─────────
const STEALS = {
  RJECgM6oVt4UI4ds: ["Dryad", [[EMPTY, 45], ["Starfruit", 29], ["Dewdrop", 10], ["Dead Branch", 10], ["Fairy Ring", 6]]],
  rftRuHZwWx5SiNpH: ["Dire Orc", [[EMPTY, 45], ["Animal Fang", 33], ["Prime Steak", 5], ["Tincture of Strength", 11], ["Giants Belt", 6]]],
  H6Ubup6kmkgNQzLU: ["Drakoza", [[EMPTY, 46], ["Draconic Essence", 31], ["Prime Steak", 5], ["Polymorph Potion: Drakoza", 12], ["Dragontrap Bow", 6]]],
  qkogIO0dEtQ466Wo: ["Elite Bandit", [["Bandit Coin", 35], ["Mead", 5], ["Gold Bar", 15], ["Deadly Premonition", 5], ["Thug Mug", 5], [EMPTY, 35]]],
  VwClo606KbQSK6aQ: ["Roo", [[EMPTY, 40], ["Torned Fabric", 31], ["Mead", 5], ["Bloodied Coin", 10], ["Zombie Potion", 8], ["Chef's Knife", 6]]],
};
// What each table held when this was written — the pre-flight refuses to
// overwrite a table someone has changed since.
const STEALS_BEFORE = {
  RJECgM6oVt4UI4ds: "(Empty) 45, Starfruit 39, Dead Branch 10, Fairy Ring 6",
  rftRuHZwWx5SiNpH: "(Empty) 45, Animal Fang 38, Tincture of Strength 11, Giants Belt 6",
  H6Ubup6kmkgNQzLU: "(Empty) 46, Draconic Essence 36, Polymorph Potion: Drakoza 12, Dragontrap Bow 6",
  qkogIO0dEtQ466Wo: "Bandit Coin 40, Gold Bar 15, Deadly Premonition 5, Thug Mug 5, (Empty) 35",
  VwClo606KbQSK6aQ: "(Empty) 40, Torned Fabric 36, Bloodied Coin 10, Zombie Potion 8, Chef's Knife 6",
};

// --------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const _created = new Map();
function stats(id) {
  const now = Date.now();
  return {
    compendiumSource: null, duplicateSource: null,
    coreVersion: "12.343", systemId: "custom-system-builder", systemVersion: "4.8.5",
    createdTime: _created.get(id) ?? now, modifiedTime: now, lastModifiedBy: GM_USER,
  };
}
const tableText = (t) => Object.values(t || {}).filter((r) => r && !r.$deleted).map((r) => `${r.loot_id} ${r.loot_percentage}`).join(", ");

function makeMaterial(donor, m) {
  const d = clone(donor);
  d._id = m.id; d.name = m.name; d.img = m.img; d.folder = MATERIAL_FOLDER; d.effects = []; d.sort = 0;
  d.ownership = { default: 0, [GM_USER]: 3 };
  d.system.uniqueId = m.id;
  Object.assign(d.system.props, {
    name: m.name, img: m.img, id: m.id, uuid: `Item.${m.id}`,
    description: `<p><em>${m.lore}</em></p>`,
    item_type: "material", item_rarity: m.rarity, item_cost: m.cost, item_quantity: "1",
    isIngredient: true, ingredient_taste: m.taste, ingredient_taste2: "",
  });
  d._stats = stats(m.id);
  return d;
}

function makeDish(d, tpl) {
  return {
    _id: d.id, name: d.name, type: "equippableItem", img: d.img, folder: DISHES_FOLDER,
    effects: [], sort: 0,
    ownership: { default: 0, [GM_USER]: 3 },
    flags: { "custom-system-builder": { version: "4.8.5" }, [MOD]: { cookingDish: { family: "recipe", tier: 0, instantOnly: true, instant: { zp: d.zp } } } },
    system: {
      template: TPL_ID,
      templateSystemUniqueVersion: tpl.system.templateSystemUniqueVersion,
      hidden: clone(tpl.system.hidden), body: clone(tpl.system.body),
      header: clone(tpl.system.header), display: clone(tpl.system.display),
      modifiers: [], unique: false, uniqueId: d.id,
      props: {
        name: d.name, isEquipped: false, isMartial: false, isModule: false, isUnique: false,
        isKey: false, isSet: false, set_name: "", isRelatedItem: false, isIngredient: false,
        optional_params: {}, active_effect_config_table: {}, effect_table: {},
        item_type: "consumable", item_rarity: "Common", item_cost: "0", item_quantity: "1", ip_cost: "0",
        ingredient_taste: "", ingredient_taste2: "", recipe_kind: "", recipe_dish_uuid: "",
        description: zpBullet(d.zp), flavor_text: `<p><em>${d.lore}</em></p>`,
        id: d.id, uuid: `Item.${d.id}`, img: d.img,
      },
    },
    _stats: stats(d.id),
  };
}

function makeRow(id, m, range) {
  return { _id: id, type: "document", documentCollection: "Item", documentId: m.id, text: m.name, img: m.img, weight: 1, range: [range, range], drawn: false, flags: {} };
}

async function readAll(db, prefix) {
  const out = [];
  for await (const [key, value] of db.iterator({ gte: prefix, lt: prefix + "~" })) out.push([key, value]);
  return out;
}
const newEmbedId = (actorId, matId) => ("Zp" + actorId.slice(0, 7) + matId.slice(5, 12)).slice(0, 16);

// --------------------------------------------------------------------------
(async () => {
  assertGameClosed();
  // Snapshot BEFORE any openCollection — our own handle holds the LevelDB lock
  // and breaks the backup copy otherwise.
  if (!DRY) { snapshotCollection("items"); snapshotCollection("tables"); snapshotCollection("actors"); }
  const problems = [];
  for (const x of [...MATERIALS, ...DISHES]) if (x.id.length !== 16) problems.push(`id ${x.id} is ${x.id.length} chars`);
  for (const [rid] of ROWS) if (rid.length !== 16) problems.push(`row id ${rid} is ${rid.length} chars`);
  for (const [aid, [n, rows]] of Object.entries(STEALS)) { const s = rows.reduce((a, r) => a + r[1], 0); if (s !== 100) problems.push(`${n}: weights sum to ${s}`); }

  // ── items: pre-flight ──
  const idb = await openCollection("items");
  const tpl = await idb.get(`!items!${TPL_ID}`).catch(() => null);
  const donor = await idb.get(`!items!${DONOR}`).catch(() => null);
  const cfgDoc = await idb.get(`!items!${CFG_ID}`).catch(() => null);
  if (!tpl?.system?.body) problems.push("template missing body");
  if (donor?.name !== "Animal Fang") problems.push("donor Animal Fang not found");
  const worldItems = [];
  for await (const [key, val] of idb.iterator({ gte: "!items!", lt: "!items!~" })) {
    if (val?._id && val?._stats?.createdTime) _created.set(val._id, val._stats.createdTime);
    worldItems.push(val);
  }
  await idb.close();
  const mine = new Set([...MATERIALS, ...DISHES].map((x) => x.id));
  for (const x of [...MATERIALS, ...DISHES]) {
    const dup = worldItems.filter((i) => i.name === x.name && !mine.has(i._id));
    if (dup.length) problems.push(`name "${x.name}" collides with existing item(s): ${dup.map((d) => d._id).join(", ")}`);
  }
  const newNames = new Set(MATERIALS.map((m) => m.name));
  for (const d of DISHES) for (const c of d.core) {
    if (newNames.has(c.name)) continue;
    if (!worldItems.some((i) => i.name === c.name && i.system?.props?.isIngredient === true)) problems.push(`${d.name}: core ingredient "${c.name}" not found as an ingredient`);
  }
  const priorRecipes = cfgDoc?.flags?.[MOD]?.cookingConfig?.recipes ?? [];
  if (!priorRecipes.length) problems.push("_Cooking Config has no recipes — refusing to write");
  for (const d of DISHES) {
    const clash = priorRecipes.find((r) => r.dishId !== d.id && r.core && r.core.length === d.core.length &&
      r.core.map((c) => c.name).sort().join("|") === d.core.map((c) => c.name).sort().join("|"));
    if (clash) problems.push(`${d.name}: identical core to existing recipe ${clash.name}`);
  }

  // ── tables: pre-flight ──
  const tdb = await openCollection("tables");
  const tables = {};
  for (const [, tid, tname] of ROWS) {
    if (tables[tid]) continue;
    const t = await tdb.get(`!tables!${tid}`).catch(() => null);
    if (!t) { problems.push(`table ${tid} missing`); continue; }
    if (t.name !== tname) problems.push(`table ${tid} is "${t.name}", expected "${tname}"`);
    const results = (await readAll(tdb, `!tables.results!${tid}.`)).map(([, v]) => v);
    tables[tid] = { doc: t, results };
  }

  // ── actors: pre-flight ──
  const adb = await openCollection("actors");
  const actors = {};
  for (const [aid, [name]] of Object.entries(STEALS)) {
    const a = await adb.get(`!actors!${aid}`).catch(() => null);
    if (!a) { problems.push(`actor ${aid} (${name}) missing`); continue; }
    if (a.name.replace(/^⭐️\s*/, "") !== name) problems.push(`actor ${aid} is "${a.name}", expected "${name}"`);
    const emb = (await readAll(adb, `!actors.items!${aid}.`)).map(([, v]) => v);
    const now = tableText(a.system?.props?.steal_percentage_table);
    const already = now === STEALS[aid][1].map((r) => `${r[0]} ${r[1]}`).join(", ");
    if (!already && now !== STEALS_BEFORE[aid]) problems.push(`${name}: steal table changed since planning: "${now}"`);
    actors[aid] = { doc: a, emb };
  }
  // Placed tokens keep their own copy of the steal table (feedback_token_world_mirror).
  const sdb = await openCollection("scenes");
  const placed = [];
  for await (const [key, val] of sdb.iterator({ gte: "!scenes.tokens!", lt: "!scenes.tokens!~" })) {
    if (val?.actorId && STEALS[val.actorId] && !val.actorLink) placed.push(`${STEALS[val.actorId][0]} on scene ${key.split("!")[2].split(".")[0]}`);
  }
  await sdb.close();

  if (problems.length) { await tdb.close(); await adb.close(); throw new Error("Pre-flight failed:\n  " + problems.join("\n  ")); }

  // ── build writes ──
  const itemBatch = [];
  const matDocs = {};
  for (const m of MATERIALS) { const d = makeMaterial(donor, m); matDocs[m.name] = d; itemBatch.push({ type: "put", key: `!items!${m.id}`, value: d }); }
  for (const d of DISHES) itemBatch.push({ type: "put", key: `!items!${d.id}`, value: makeDish(d, tpl) });

  const tableBatch = [];
  const tableNotes = [];
  for (const [tid, { doc, results }] of Object.entries(tables)) {
    const mineRows = ROWS.filter((r) => r[1] === tid);
    const others = results.filter((r) => !mineRows.some(([rid]) => rid === r._id));
    let top = others.reduce((n, r) => Math.max(n, r.range?.[1] ?? 0), 0);
    const ids = [...(doc.results || [])];
    for (const [rid, , , mid] of mineRows) {
      const m = MATERIALS.find((x) => x.id === mid);
      top += 1;
      tableBatch.push({ type: "put", key: `!tables.results!${tid}.${rid}`, value: makeRow(rid, m, top) });
      if (!ids.includes(rid)) ids.push(rid);
    }
    const t2 = clone(doc); t2.results = ids; t2.formula = `1d${top}`;
    tableBatch.push({ type: "put", key: `!tables!${tid}`, value: t2 });
    tableNotes.push(`${doc.name}: ${doc.formula} → ${t2.formula}`);
  }

  const actorBatch = [];
  const actorNotes = [];
  const now = Date.now();
  for (const [aid, [name, rows]] of Object.entries(STEALS)) {
    const { doc, emb } = actors[aid];
    const next = clone(doc);
    const loot = {};
    for (const [lootName] of rows) {
      let e = emb.find((i) => i.name === lootName && LOOT_TYPES.has(i.system?.props?.item_type));
      if (!e) {
        const src = matDocs[lootName];
        if (!src) throw new Error(`${name}: no embedded "${lootName}" and it is not a new material`);
        e = clone(src);
        e._id = newEmbedId(aid, src._id);
        e._stats = { ...e._stats, compendiumSource: `Item.${src._id}`, duplicateSource: null, createdTime: now, modifiedTime: now };
        if (!(next.items || []).includes(e._id)) next.items = [...(next.items || []), e._id];
        actorBatch.push({ type: "put", key: `!actors.items!${aid}.${e._id}`, value: e });
      }
      loot[e._id] = { id: "${item.id}", loot_description: String(e.system?.props?.description ?? ""), name: lootName, roll: "", uuid: `Actor.${aid}.Item.${e._id}` };
    }
    for (const [k, v] of Object.entries(doc.system?.props?.stealable_loot || {})) {
      if (!loot[k] && !Object.values(loot).some((x) => x.name === v?.name)) loot[k] = v;
    }
    const table = {};
    rows.forEach(([lootName, pct], i) => { table[String(i)] = { $deleted: false, loot_id: lootName, loot_percentage: String(pct) }; });
    next.system.props.stealable_loot = loot;
    next.system.props.steal_percentage_table = table;
    next._stats = { ...(next._stats || {}), modifiedTime: now };
    actorBatch.push({ type: "put", key: `!actors!${aid}`, value: next });
    actorNotes.push(`${name}: ${tableText(doc.system?.props?.steal_percentage_table)}  →  ${rows.map((r) => `${r[0]} ${r[1]}`).join(", ")}`);
  }

  const RECIPES = DISHES.map((d) => ({ name: d.name, dishId: d.id, core: d.core, ...(d.priority ? { priority: d.priority } : {}) }));
  const ids = new Set(RECIPES.map((x) => x.dishId));
  const merged = [...priorRecipes.filter((p) => !ids.has(p.dishId)), ...RECIPES];

  console.log(`${DRY ? "[DRY] " : ""}items: ${MATERIALS.length} materials + ${DISHES.length} dishes`);
  for (const d of DISHES) console.log(`   ${d.name}: +${d.zp} ZP, core ${d.core.map((c) => c.name).join(" + ")}${d.priority ? ` (priority ${d.priority})` : ""}`);
  for (const n of tableNotes) console.log(`   table ${n}`);
  for (const n of actorNotes) console.log(`   steal ${n}`);
  console.log(`   recipes: ${priorRecipes.length} → ${merged.length}`);
  console.log(`   placed unlinked tokens with a stale steal table: ${placed.length ? placed.join("; ") : "none"}`);
  if (DRY) { await tdb.close(); await adb.close(); return; }

  await tdb.batch(tableBatch); await tdb.close();
  await adb.batch(actorBatch); await adb.close();
  const w = await openCollection("items"); await w.batch(itemBatch); await w.close();
  console.log(`wrote ${itemBatch.length} item keys, ${tableBatch.length} table keys, ${actorBatch.length} actor keys`);

  await safeEdit({ uuid: `Item.${CFG_ID}`, patch: { [`flags.${MOD}.cookingConfig.recipes`]: merged }, note: `cooking: register ${RECIPES.length} Zero Power dish recipes` });

  // ── verify ──
  const v = await openCollection("items");
  let ok = 0;
  for (const x of [...MATERIALS, ...DISHES]) if (await v.get(`!items!${x.id}`).catch(() => null)) ok++;
  const cfg2 = await v.get(`!items!${CFG_ID}`); await v.close();
  const cc = cfg2?.flags?.[MOD]?.cookingConfig ?? {};
  const tv = await openCollection("tables");
  const tf = []; for (const tid of Object.keys(tables)) { const t = await tv.get(`!tables!${tid}`); tf.push(`${t.name} ${t.formula} (${t.results.length} results)`); }
  await tv.close();
  const av = await openCollection("actors");
  const st = []; for (const aid of Object.keys(STEALS)) { const a = await av.get(`!actors!${aid}`); st.push(`${a.name}: ${tableText(a.system.props.steal_percentage_table)}`); }
  await av.close();
  console.log(`verify docs:    ${ok}/${MATERIALS.length + DISHES.length}`);
  console.log(`verify recipes: ${(cc.recipes ?? []).length}; ZP: ${(cc.recipes ?? []).filter((r) => ids.has(r.dishId)).map((r) => r.name).join(", ")}; matrix ${Object.keys(cc.matrix ?? {}).length === 5 ? "OK" : "!! DAMAGED !!"}; goop/mystery ${cc.goopDishId && cc.mysteryDishId ? "OK" : "!! MISSING !!"}`);
  for (const s of tf) console.log(`verify table:   ${s}`);
  for (const s of st) console.log(`verify steal:   ${s}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
