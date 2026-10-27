// Valley of the Dragon utility batch (2026-10-27):
//   • Smoke Bomb        — consumable, inflicts Obscure on one enemy.
//   • Invisibility Potion — consumable tagged "potion", grants Hidden (3 turns)
//     to one ally. Deliberately NOT spread by Potion Rain: its reaction keeps
//     the aid-intent gate and a buff-only Item action classifies "neutral".
//   • Dragon Stew       — unique dish, core Draconic Essence + Moonshroom,
//     immunity to Paralyzed until the next rest.
//   • Manta Sashimi     — unique dish, core Tempest Manta + Rock Salt, Bolt
//     Resistance until the next rest (affinity_3 "RS", the Wet idiom in reverse).
//   • Valley of the Dragon - Consumable: +2 rows (1d22 → 1d24).
//   • Every AE named "Hidden" (status library, Invisibility Cloak copies, actor
//     copies) gains `cannot_be_targeted_by: "single_target"` — the engine gate
//     landed in ae94c2d7; without this row Hidden stays a label.
//
// Consumables are CLONES of the live Café au Lait pair (carrier aITJntRz2m10Rgeo
// + action VNg8JKR5sUjqgdNb) — the house automated-consumable shape — so the
// full CSB template body stays valid. Dishes follow _populate-unique-dishes.js.
//
// Idempotent — fixed document IDs, re-running overwrites in place.
// Usage: node _populate-valley-utilities.js [--dry]
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");
const { safeEdit } = require("./lib");

const DRY = process.argv.includes("--dry");
const MOD = "fabula-ultima-companion";
const GM_USER = "JQGNzKpDPHJmcUIW";
const TPL_ID = "ZoiV53VaLzeRsEps";          // _equippableItemTemplate
const CONS_FOLDER = "VzpCG9mySsd9sQSL";     // ⚗️ Consumable
const EMBED_FOLDER = "ft3358qUh5ZDldYQ";    // CSB - Embedded Items Folder (linked actions live here)
const DISHES_FOLDER = "UNuBsFNeuyDDZ5AZ";   // 🍲 Dishes
const CFG_ID = "oG4U8b6if8enaswT";          // _Cooking Config
const CARRIER_SRC = "aITJntRz2m10Rgeo";     // Café au Lait (carrier)
const ACTION_SRC = "VNg8JKR5sUjqgdNb";      // Café au Lait (linked action)
const TABLE_ID = "S4PHPxGHldBoJVxj";        // Valley of the Dragon - Consumable

// Link snippets = the most common exact anchor for each target across world items.
const L = {
  obscure: `<a class="content-link" data-uuid="JournalEntry.ZdBbIFKzxQQcY71T" data-id="ZdBbIFKzxQQcY71T" data-type="JournalEntry">Obscure</a>`,
  hidden:  `<a class="content-link" data-uuid="JournalEntry.DMaL1B3Z5Y5AUrvC" data-id="DMaL1B3Z5Y5AUrvC" data-type="JournalEntry">Hidden</a>`,
};

// ── Consumables ─────────────────────────────────────────────────────────────
const CONSUMABLES = [
  {
    id: "Uti1SmokeBomb000", actionId: "Uti1SmokeBombAct", name: "Smoke Bomb",
    img: "icons/commodities/tech/smoke-bomb-yellow.webp",
    cost: "60", rarity: "Common", ip: "2", tags: "",
    target: "One Enemy",
    effectLabel: "smokebomb_obscure",
    effect: { effect_kind: "apply_ae", ae_template_ref: "Obscure", ae_duplicate_mode: "replace", target_ref: "action_targets" },
    bullet: `<ul><li><p>Inflicts ${L.obscure} on the target creature.</p></li></ul>`,
    flavor: `<p><em>A clay shell packed with damp powder. It bursts into a thick grey smoke that hangs around the target for a few turns.</em></p>`,
  },
  {
    id: "Uti1InvisPot1on0", actionId: "Uti1InvisPot1Act", name: "Invisibility Potion",
    img: "icons/consumables/potions/bottle-round-empty-glass.webp",
    cost: "150", rarity: "Uncommon", ip: "3", tags: "potion",
    target: "One Ally",
    effectLabel: "invispotion_hidden",
    effect: { effect_kind: "apply_ae", ae_template_ref: "Hidden", ae_duplicate_mode: "replace", ae_duration_rounds: "3", target_ref: "action_targets" },
    bullet: `<ul><li><p>Target ally gains ${L.hidden} for <strong>three turns</strong>.</p></li></ul>`,
    flavor: `<p><em>A bottle that looks empty. Whoever drinks it looks the same way for a while.</em></p>`,
  },
];

// ── Unique dishes ───────────────────────────────────────────────────────────
const AE_OVERRIDE = 5;
const DISHES = [
  { id: "Un1qD1shDragonSt", ae: "Un1qAEDragonStew", name: "Dragon Stew",
    img: "icons/consumables/food/bowl-stew-brown.webp",
    core: [{ name: "Draconic Essence" }, { name: "Moonshroom" }],
    // Same trap as the Sashimi: Rice + Rock Salt filler would resolve as Rice Ball.
    priority: 5,
    desc: "<p><em>Draconic essence simmered with moonshrooms until the broth runs clear and stays faintly warm no matter how long it sits.</em></p><p>Grants immunity to <strong>Paralyzed</strong> until the next rest.</p>",
    changes: [{ key: "condition_paralyzed", mode: AE_OVERRIDE, value: "IM", priority: null }] },
  { id: "Un1qD1shMantaSas", ae: "Un1qAEMantaSashi", name: "Manta Sashimi",
    img: "icons/consumables/food/plate-fish-bowl-bones-brown.webp",
    core: [{ name: "Tempest Manta" }, { name: "Rock Salt" }],
    // Rock Salt is also Rice Ball's core (Rice + Rock Salt) and Pufferfish
    // Sashimi's; among equal-size core matches the resolver falls back to
    // declaration order, so without a priority a pot of Rice + Rock Salt +
    // Tempest Manta cooks a Rice Ball. The Legendary fish must win.
    priority: 10,
    desc: "<p><em>Tempest manta sliced thin and salted. It still crackles faintly on the tongue.</em></p><p>Grants <strong>Resistance to Bolt damage</strong> until the next rest.</p>",
    // affinity_3 = bolt (apply-damage-core index map). Same custom-mode idiom as
    // the Wet status (affinity_3 "VU", mode 0), value flipped to RS.
    changes: [{ key: "affinity_3", mode: 0, value: "RS", priority: 1 }] },
];

const HIDDEN_CHANGE = { key: "cannot_be_targeted_by", mode: 5, value: "single_target", priority: 20 };

// --------------------------------------------------------------------------
const _created = new Map();
function stats(id) {
  const now = Date.now();
  return {
    compendiumSource: null, duplicateSource: null,
    coreVersion: "12.343", systemId: "custom-system-builder", systemVersion: "4.8.5",
    createdTime: _created.get(id) ?? now, modifiedTime: now, lastModifiedBy: GM_USER,
  };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

function makeCarrier(src, c) {
  const d = clone(src);
  d._id = c.id; d.name = c.name; d.img = c.img; d.folder = CONS_FOLDER; d.effects = []; d.sort = 0;
  d.ownership = { default: 0, [GM_USER]: 3 };
  d.system.uniqueId = c.id;
  const p = d.system.props;
  p.name = c.name; p.img = c.img; p.id = c.id; p.uuid = `Item.${c.id}`;
  p.item_type = "consumable"; p.item_rarity = c.rarity; p.item_cost = c.cost; p.item_quantity = "1"; p.ip_cost = c.ip;
  p.skill_tags = c.tags; p.skill_target = c.target;
  p.description = c.bullet; p.flavor_text = c.flavor;
  p.isSet = false; p.set_name = "";
  // The ACTION drives the effect (DECLARE resolves the linked activation skill);
  // the carrier keeps an inert copy of the row for parity with Café au Lait /
  // Golem Soulstone / Turbo Remedy / Mixed Juice / Blue Bovine (5 of 6 siblings).
  p.effect_table = { "0": { effect_label: c.effectLabel, ...c.effect } };
  p.related_item_list = { [c.actionId]: { uuid: `Item.${c.actionId}`, name: c.name, id: "${item.id}", related_item_description: c.bullet } };
  p.item_skill_active = { [c.actionId]: { uuid: `Item.${c.actionId}`, name: c.name, id: "${item.id}", skill_maxLevel: 1, skill_cost: "-", skill_description: c.bullet } };
  d._stats = stats(c.id);
  return d;
}

function makeAction(src, c) {
  const d = clone(src);
  d._id = c.actionId; d.name = c.name; d.img = c.img; d.folder = EMBED_FOLDER; d.effects = []; d.sort = 0;
  d.ownership = { default: 0, [GM_USER]: 3 };
  d.system.uniqueId = c.actionId;
  // CSB resolves a carrier's item_skill_active / related_item_list LIVE from the
  // CHILD side: every item whose `system.container` is the carrier id. The stored
  // container props on the carrier are only a cache. A clone that keeps the
  // source's container id shows up under Café au Lait and leaves the new carrier
  // empty (bit us 2026-10-27).
  d.system.container = c.id;
  const p = d.system.props;
  p.skill_type = "Item"; p.skill_target = c.target; p.cost = "-"; p.action_command = "item";
  p.on_activate_effect_ref = c.effectLabel;
  p.description = c.bullet; p.skill_description = c.bullet;
  p.skill_tags = c.tags;
  p.effect_table = { "0": { effect_label: c.effectLabel, ...c.effect } };
  d._stats = stats(c.actionId);
  return d;
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
function makeDish(d, tpl) {
  return {
    _id: d.id, name: d.name, type: "equippableItem", img: d.img, folder: DISHES_FOLDER,
    effects: [d.ae], sort: 0,
    ownership: { default: 0, [GM_USER]: 3 },
    flags: { "custom-system-builder": { version: "4.8.5" }, [MOD]: { cookingDish: { family: "recipe", tier: 0, instant: {} } } },
    system: {
      template: TPL_ID,
      templateSystemUniqueVersion: tpl.system.templateSystemUniqueVersion,
      hidden: clone(tpl.system.hidden), body: clone(tpl.system.body),
      header: clone(tpl.system.header), display: clone(tpl.system.display),
      modifiers: [], unique: false, uniqueId: d.id,
      props: { ...baseProps(d.name, "consumable", { description: d.desc }), id: d.id, uuid: `Item.${d.id}`, img: d.img },
    },
    _stats: stats(d.id),
  };
}
function makeAe(d) {
  return {
    _id: d.ae, name: d.name, img: d.img, description: d.desc, type: "base",
    system: { tags: ["food"] }, changes: d.changes, disabled: false,
    duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
    origin: null, tint: "#ffffff", transfer: false, statuses: [],
    flags: { "custom-system-builder": { originalParentId: d.id, originalId: d.ae, originalUuid: `Item.${d.id}.ActiveEffect.${d.ae}`, isFromTemplate: false } },
    sort: 0, _stats: stats(d.ae),
  };
}
function makeRow(id, c, range) {
  return { _id: id, type: "document", documentCollection: "Item", documentId: c.id, text: c.name, img: c.img, weight: 1, range: [range, range], drawn: false, flags: {} };
}
const ROWS = [["Uti1RowSmokeBomb", CONSUMABLES[0], 23], ["Uti1RowInvisPotn", CONSUMABLES[1], 24]];

// --------------------------------------------------------------------------
(async () => {
  assertGameClosed();
  if (!DRY) { snapshotCollection("items"); snapshotCollection("tables"); snapshotCollection("actors"); }

  const problems = [];
  for (const c of CONSUMABLES) for (const id of [c.id, c.actionId]) if (id.length !== 16) problems.push(`id ${id} is ${id.length} chars`);
  for (const d of DISHES) for (const id of [d.id, d.ae]) if (id.length !== 16) problems.push(`id ${id} is ${id.length} chars`);
  for (const [id] of ROWS) if (id.length !== 16) problems.push(`row id ${id} is ${id.length} chars`);

  const db = await openCollection("items");
  const tpl = await db.get(`!items!${TPL_ID}`);
  const carrierSrc = await db.get(`!items!${CARRIER_SRC}`);
  const actionSrc = await db.get(`!items!${ACTION_SRC}`);
  if (!tpl?.system?.body) problems.push("template missing body");
  if (!carrierSrc?.system?.props?.item_skill_active) problems.push("Café au Lait carrier not found / not automated");
  if (!actionSrc?.system?.props?.effect_table) problems.push("Café au Lait action not found");

  const existing = new Map();
  const hiddenAeKeys = [];
  for await (const [key, val] of db.iterator()) {
    if (val?._id && val?._stats?.createdTime) _created.set(val._id, val._stats.createdTime);
    if (key.startsWith("!items!") && val?.name) {
      if (!existing.has(val.name)) existing.set(val.name, []);
      existing.get(val.name).push({ id: val._id, type: val.system?.props?.item_type });
    }
    if (key.startsWith("!items.effects!") && val?.name === "Hidden") hiddenAeKeys.push([key, val]);
  }
  const mine = new Set([...CONSUMABLES.flatMap((c) => [c.id, c.actionId]), ...DISHES.map((d) => d.id)]);
  for (const n of [...CONSUMABLES.map((c) => c.name), ...DISHES.map((d) => d.name)]) {
    const dup = (existing.get(n) ?? []).filter((h) => !mine.has(h.id));
    if (dup.length) problems.push(`name "${n}" collides with existing item(s): ${dup.map((d) => d.id).join(", ")}`);
  }
  for (const d of DISHES) for (const c of d.core) {
    const hits = (existing.get(c.name) ?? []).filter((h) => h.type === "material");
    if (!hits.length) problems.push(`${d.name}: core ingredient "${c.name}" not found as a material`);
  }
  for (const ref of ["Obscure", "Hidden"]) {
    if (!(await db.get(`!items.effects!XVOWOq9oUmEECGrU.${ref === "Obscure" ? "9ru58ghiO53ZxM5e" : "pZ93jM12X0L5bCsM"}`).catch(() => null))) problems.push(`status template ${ref} missing from Debuff library`);
  }
  if (problems.length) { await db.close(); throw new Error("Pre-flight failed:\n  " + problems.join("\n  ")); }

  // Actor-embedded Hidden AEs (Invisibility Cloak copies etc.) — world mirror rule.
  const adb = await openCollection("actors");
  const actorHidden = [];
  for await (const [key, val] of adb.iterator()) {
    if (key.includes(".effects!") && val?.name === "Hidden") actorHidden.push([key, val]);
  }
  await adb.close();

  const batch = [];
  for (const c of CONSUMABLES) {
    batch.push({ type: "put", key: `!items!${c.id}`, value: makeCarrier(carrierSrc, c) });
    batch.push({ type: "put", key: `!items!${c.actionId}`, value: makeAction(actionSrc, c) });
  }
  for (const d of DISHES) {
    batch.push({ type: "put", key: `!items!${d.id}`, value: makeDish(d, tpl) });
    batch.push({ type: "put", key: `!items.effects!${d.id}.${d.ae}`, value: makeAe(d) });
  }
  const hiddenPatched = [];
  const patchHidden = (key, val) => {
    const changes = Array.isArray(val.changes) ? val.changes : [];
    if (changes.some((ch) => ch?.key === "cannot_be_targeted_by")) return null;
    const v = clone(val); v.changes = [...changes, HIDDEN_CHANGE]; hiddenPatched.push(key); return v;
  };
  for (const [key, val] of hiddenAeKeys) { const v = patchHidden(key, val); if (v) batch.push({ type: "put", key, value: v }); }
  const actorBatch = [];
  for (const [key, val] of actorHidden) { const v = patchHidden(key, val); if (v) actorBatch.push({ type: "put", key, value: v }); }

  // Table rows
  const tdb = await openCollection("tables");
  const table = await tdb.get(`!tables!${TABLE_ID}`);
  const tableBatch = [];
  const resultIds = Array.isArray(table.results) ? [...table.results] : [];
  for (const [rid, c, range] of ROWS) {
    tableBatch.push({ type: "put", key: `!tables.results!${TABLE_ID}.${rid}`, value: makeRow(rid, c, range) });
    if (!resultIds.includes(rid)) resultIds.push(rid);
  }
  const t2 = clone(table); t2.results = resultIds; t2.formula = `1d${Math.max(24, resultIds.length)}`;
  tableBatch.push({ type: "put", key: `!tables!${TABLE_ID}`, value: t2 });

  const RECIPES = DISHES.map((d) => ({ name: d.name, dishId: d.id, core: d.core, ...(d.priority ? { priority: d.priority } : {}) }));

  if (DRY) {
    console.log(`[DRY] ${CONSUMABLES.length} consumables (+${CONSUMABLES.length} actions), ${DISHES.length} dishes, ${tableBatch.length - 1} table rows → formula ${t2.formula} (${resultIds.length} results)`);
    console.log(`[DRY] Hidden AEs to patch: items ${hiddenPatched.filter((k) => k.startsWith("!items")).length}/${hiddenAeKeys.length}, actors ${actorBatch.length}/${actorHidden.length}`);
    for (const k of hiddenPatched) console.log("   ", k);
    for (const c of CONSUMABLES) console.log(`  ${c.name}: ${c.target} → ${JSON.stringify(c.effect)}`);
    for (const d of DISHES) console.log(`  ${d.name}: core=${d.core.map((x) => x.name).join(" + ")} changes=${JSON.stringify(d.changes)}`);
    await db.close(); await tdb.close();
    return;
  }

  await db.batch(batch); await db.close();
  await tdb.batch(tableBatch); await tdb.close();
  if (actorBatch.length) { const a2 = await openCollection("actors"); await a2.batch(actorBatch); await a2.close(); }
  console.log(`wrote ${batch.length} item keys, ${tableBatch.length} table keys, ${actorBatch.length} actor keys`);

  // Register recipes (read-modify-write, targeted path).
  const r = await openCollection("items");
  const cfgDoc = await r.get(`!items!${CFG_ID}`);
  await r.close();
  const prior = cfgDoc?.flags?.[MOD]?.cookingConfig?.recipes ?? [];
  const ids = new Set(RECIPES.map((x) => x.dishId));
  const merged = [...prior.filter((p) => !ids.has(p.dishId)), ...RECIPES];
  await safeEdit({ uuid: `Item.${CFG_ID}`, patch: { [`flags.${MOD}.cookingConfig.recipes`]: merged }, note: `cooking: register ${RECIPES.length} Valley unique recipes` });
  console.log(`patched _Cooking Config → recipes[] (${merged.length} total)`);

  // Verify
  const v = await openCollection("items");
  let ok = 0, want = 0;
  for (const c of CONSUMABLES) for (const k of [`!items!${c.id}`, `!items!${c.actionId}`]) { want++; if (await v.get(k).catch(() => null)) ok++; }
  for (const d of DISHES) for (const k of [`!items!${d.id}`, `!items.effects!${d.id}.${d.ae}`]) { want++; if (await v.get(k).catch(() => null)) ok++; }
  let hiddenOk = 0;
  for (const [key] of hiddenAeKeys) { const x = await v.get(key).catch(() => null); if (x?.changes?.some((ch) => ch.key === "cannot_be_targeted_by" && ch.value === "single_target")) hiddenOk++; }
  const cfg2 = await v.get(`!items!${CFG_ID}`).catch(() => null);
  await v.close();
  const cc = cfg2?.flags?.[MOD]?.cookingConfig ?? {};
  const tv = await openCollection("tables"); const tDoc = await tv.get(`!tables!${TABLE_ID}`); let rowsOk = 0; for (const [rid] of ROWS) if (await tv.get(`!tables.results!${TABLE_ID}.${rid}`).catch(() => null)) rowsOk++; await tv.close();
  console.log(`verify docs:     ${ok}/${want}`);
  console.log(`verify Hidden:   ${hiddenOk}/${hiddenAeKeys.length} item AEs carry single_target (+${actorBatch.length} actor AEs patched)`);
  console.log(`verify recipes:  ${(cc.recipes ?? []).length} (Giga Pudding preserved: ${(cc.recipes ?? []).some((x) => x.name === "Giga Pudding")}); matrix ${Object.keys(cc.matrix ?? {}).length === 5 ? "OK" : "!! DAMAGED !!"}; goop/mystery ${cc.goopDishId && cc.mysteryDishId ? "OK" : "!! MISSING !!"}`);
  console.log(`verify table:    rows ${rowsOk}/${ROWS.length}, formula ${tDoc.formula}, results ${tDoc.results.length}`);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
