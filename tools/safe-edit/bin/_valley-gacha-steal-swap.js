"use strict";
// Valley steal tables: take the gacha Monster of Frankensteiner pieces out (2026-11-06).
//
// User: the Frankensteiner set is a gacha set, so it belongs in no steal table.
//   Ampere: Silver Bolt     -> Thunder Bow      (6 %)
//   Kirin:  Lightning Rod   -> Rumbling Staves  (7 %)
// and the two replacements are made to work:
//   Thunder Bow     + Bolt Resistance AE while equipped (Topaz Pendant's change);
//                   its Fulgur (3SG96…, only Thunder Bow uses it) gets Fulgur Alta's
//                   Opportunity row (Dazed on crit); description in the house format.
//   Rumbling Staves rebalanced under the equipment metric (user, 2026-11-06):
//                   Rare, Arcane 2H chassis +6, WLP+WLP, Bolt, 2500z, grants the
//                   NEW spell Thunderstorm (30 MP, INS+WLP vs MDEF, All Enemy,
//                   `chain 3 seek`, 【HR + 15】 Bolt per bolt, no Opportunity row).
//
// Idempotent: re-running finds Thunderstorm by name, skips an AE that already
// exists, and assigns the steal tables outright.
// Dry by default. `--apply` writes; the game must be CLOSED.

const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const { assertGameClosed } = require("../lib/lock");
const { newDocId } = require("../lib/edit");
const journal = require("../lib/journal");
const { DEFAULT_WORLD } = require("../lib/paths");

const APPLY = process.argv.includes("--apply");
const clone = (o) => JSON.parse(JSON.stringify(o));
const now = Date.now();

const ID = {
  thunderBow: "gmqiLVM5ymdrjxLd",
  fulgur: "3SG96LfUyQaA0qAp",          // Thunder Bow's Fulgur (only Thunder Bow references it)
  fulgurAlta: "nUVRyBNSbOlqbh0Y",      // donor of the Opportunity row
  staves: "pdsnWFo6XwEIL0TV",
  topaz: "Zh2QWeG9EeU9hA9V",           // donor of the Bolt Resistance AE
  ampere: "kAYN54Id3iTAOw1A",
  kirin: "TvLv878yZLNUAWNN",
};
const STORM_IMG = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Aisha/Lightning_Shower.png";

// Linked Item Text storage format A: minimal anchors, no styling (project_linked_item_text).
const link = (type, id, label) => `<a class="content-link" data-uuid="${type}.${id}" data-id="${id}" data-type="${type}">${label}</a>`;
const BOLT = link("Item", "5XAuMMbDPlLzhJLw", "Bolt");
const MAGIC_DMG = link("JournalEntry", "XYQUsuXPU0CQjEYa", "Magic Damage");
const CHAIN = link("JournalEntry", "ChnStrikeKeyw0rd", "Chain");

// steal rows: [loot name, %] in table order — only the equipment row changes.
const SWAPS = [
  { actor: ID.ampere, name: "Ampere", out: "Silver Bolt", inId: ID.thunderBow,
    rows: [["(Empty)", 45], ["Fish Fin", 22], ["Draconic Essence", 16], ["Tincture of Endurance", 11], ["Thunder Bow", 6]] },
  { actor: ID.kirin, name: "Kirin", out: "Lightning Rod", inId: ID.staves,
    rows: [["(Empty)", 42], ["Mystic Horn", 36], ["Tincture of Strength", 15], ["Rumbling Staves", 7]] },
];

async function all(db, prefix) { const out = []; for await (const kv of db.iterator({ gte: prefix, lt: prefix + "~" })) out.push(kv); return out; }

(async () => {
  if (APPLY) assertGameClosed(DEFAULT_WORLD);
  const itemWrites = [], actorWrites = [], actorDeletes = [];

  // ── read ──
  const idb = await openCollection("items");
  const items = new Map((await all(idb, "!items!")).map(([, v]) => [v._id, v]));
  const itemAEs = await all(idb, "!items.effects!");
  await idb.close();
  const adb = await openCollection("actors");
  const actors = new Map((await all(adb, "!actors!")).map(([, v]) => [v._id, v]));
  const embedded = await all(adb, "!actors.items!");
  await adb.close();
  const need = (id) => { const d = items.get(id); if (!d) throw new Error("world item missing: " + id); return d; };

  // ── Thunder Bow: Bolt Resistance AE + text ──
  const bow = clone(need(ID.thunderBow));
  const topazAE = itemAEs.find(([k]) => k.startsWith(`!items.effects!${ID.topaz}.`))?.[1];
  if (!topazAE) throw new Error("Topaz Pendant AE not found");
  const bowAEs = itemAEs.filter(([k]) => k.startsWith(`!items.effects!${ID.thunderBow}.`)).map(([, v]) => v);
  let bowAE = bowAEs.find((e) => (e.changes || []).some((c) => c.key === "affinity_3"));
  if (!bowAE) {
    bowAE = clone(topazAE);
    bowAE._id = newDocId();
    bowAE.name = "Thunder Bow";
    bowAE.img = bow.img;
    bowAE.origin = null;
    bowAE.description = `<p>Gain resistance to ${BOLT} damage</p>`;
    bowAE._stats = { ...bowAE._stats, compendiumSource: null, duplicateSource: null, createdTime: now, modifiedTime: now };
    bowAE.flags = { ...(bowAE.flags || {}), "custom-system-builder": { isFromTemplate: false, originalId: bowAE._id, originalParentId: ID.thunderBow, originalUuid: `Item.${ID.thunderBow}.ActiveEffect.${bowAE._id}` } };
    bow.effects = [...(bow.effects || []), bowAE._id];
    itemWrites.push([`!items.effects!${ID.thunderBow}.${bowAE._id}`, bowAE, "Thunder Bow: + AE Bolt Resistance (affinity_3 RS while equipped)"]);
  }
  bow.system.props.description =
    `<ul><li><p>You have Resistance to ${BOLT} damage.</p></li>` +
    `<li><p>You may cast the spell ${link("Item", ID.fulgur, "Fulgur")}</p></li></ul>`;
  bow._stats = { ...bow._stats, modifiedTime: now };
  itemWrites.push([`!items!${ID.thunderBow}`, bow, "Thunder Bow: description in the house format"]);

  // ── Fulgur (Thunder Bow's copy): the Opportunity row ──
  const fulgur = clone(need(ID.fulgur));
  const alta = need(ID.fulgurAlta);
  const fp = fulgur.system.props;
  const altaRow = alta.system.props.effect_table?.["0"];
  if (!altaRow) throw new Error("Fulgur Alta has no Opportunity row");
  fp.effect_table = { "0": { ...clone(altaRow), effect_label: "fulgur_opportunity" } };
  fp.on_activate_effect_ref = "fulgur_opportunity";
  fp.id = ID.fulgur;
  fp.uuid = `Item.${ID.fulgur}`;
  fulgur._stats = { ...fulgur._stats, modifiedTime: now };
  itemWrites.push([`!items!${ID.fulgur}`, fulgur, "Fulgur (Thunder Bow): + Opportunity row Dazed (Fulgur Alta's)"]);

  // ── Thunderstorm: new spell, cloned off the fixed Fulgur ──
  let storm = [...items.values()].find((i) => i.name === "Thunderstorm" && i.folder === fulgur.folder);
  const stormId = storm?._id ?? newDocId();
  storm = clone(fulgur);
  storm._id = stormId;
  storm.name = "Thunderstorm";
  storm.img = STORM_IMG;
  storm._stats = { ...storm._stats, compendiumSource: null, duplicateSource: null, createdTime: now, modifiedTime: now };
  storm.system.uniqueId = stormId;
  // CSB container model: the grant link lives on the CHILD (reference_csb_item_container_linkage).
  // The clone inherited Fulgur's container (Thunder Bow); the staff is Thunderstorm's carrier.
  storm.system.container = ID.staves;
  const sp = storm.system.props;
  Object.assign(sp, {
    name: "Thunderstorm", img: STORM_IMG, id: stormId, uuid: `Item.${stormId}`,
    class: "", cost: "30 MP", damage_bonus: "15", skill_target: "All Enemy",
    action_keywords: "chain 3 seek",
    rolled_atr1: "INS", rolled_atr2: "WLP", defense_target_type: "mdef",
    type_damage: "Bolt", isOffensiveSpell: true, isCheck: true, skill_type: "Spell", action_command: "spell",
    duration: "Instantaneous", skill_range: "Range",
    effect_table: {}, on_activate_effect_ref: "",
    description:
      `<p>${CHAIN} 3: call down three bolts, each on a random enemy. Each bolt makes its own Magic Check and deals ` +
      `<strong>【HR + 15】</strong>${BOLT} damage. A bolt aimed at an enemy already reduced to 0 HP strikes another enemy instead.</p>`,
  });
  // the animation is written by _build-party-animations.js (gear jobs), never here
  sp.animation_script = ""; sp.skill_animation_mode = "default";
  itemWrites.push([`!items!${stormId}`, storm, `Thunderstorm ${stormId}: 30 MP, All Enemy, chain 3 seek, HR + 15 Bolt`]);

  // ── Rumbling Staves: rebalance + grant Thunderstorm ──
  const staves = clone(need(ID.staves));
  const rp = staves.system.props;
  Object.assign(rp, {
    item_rarity: "Rare", damage_bonus: "6", item_cost: "2500", isMartial: false,
    rolled_atr1: "WLP", rolled_atr2: "WLP", type_damage: "Bolt", hand_slots: "Two-handed", weapon_range: "Ranged",
    isSet: false, set_name: "", isRelatedItem: true,
    description:
      `<ul><li><p>This weapon deals ${MAGIC_DMG}</p></li>` +
      `<li><p>You may cast the spell ${link("Item", stormId, "Thunderstorm")}</p></li></ul>`,
    item_skill_active: { [stormId]: { id: "${item.id}", name: "Thunderstorm", skill_cost: "30 MP", skill_description: sp.description, skill_maxLevel: 1, uuid: `Item.${stormId}` } },
    related_item_list: { [stormId]: { id: "${item.id}", name: "Thunderstorm", related_item_description: sp.description, uuid: `Item.${stormId}` } },
  });
  staves._stats = { ...staves._stats, modifiedTime: now };
  itemWrites.push([`!items!${ID.staves}`, staves, "Rumbling Staves: Rare, +6, grants Thunderstorm"]);

  // ── actors: swap the embedded loot + the steal tables ──
  const worldNow = new Map([[ID.thunderBow, { doc: bow, aes: bowAE ? [bowAE] : [] }], [ID.staves, { doc: staves, aes: [] }]]);
  for (const s of SWAPS) {
    const actor = actors.get(s.actor);
    if (!actor || actor.name !== s.name) throw new Error(`actor ${s.actor} is not ${s.name}`);
    if (s.rows.reduce((n, r) => n + r[1], 0) !== 100) throw new Error(s.name + ": weights must sum to 100");
    const mine = embedded.filter(([k]) => k.startsWith(`!actors.items!${s.actor}.`));
    const next = clone(actor);
    const loot = clone(actor.system.props.stealable_loot || {});
    // remove the gacha piece
    for (const [k, v] of mine) {
      if (v.name !== s.out) continue;
      actorDeletes.push([k, `${s.name}: remove embedded ${s.out}`]);
      next.items = (next.items || []).filter((id) => id !== v._id);
      delete loot[v._id];
      for (const aeId of v.effects || []) actorDeletes.push([`!actors.items.effects!${s.actor}.${v._id}.${aeId}`, `${s.name}: remove ${s.out} AE`]);
    }
    // embed the replacement (fresh copy of the UPDATED world item)
    const src = worldNow.get(s.inId);
    let emb = mine.map(([, v]) => v).find((v) => v.name === src.doc.name);
    if (!emb) {
      emb = clone(src.doc);
      emb._id = newDocId();
      emb._stats = { ...emb._stats, compendiumSource: `Item.${s.inId}`, duplicateSource: null, createdTime: now, modifiedTime: now };
      emb.effects = [];
      for (const ae of src.aes) {
        const c = clone(ae); c._id = newDocId(); emb.effects.push(c._id);
        actorWrites.push([`!actors.items.effects!${s.actor}.${emb._id}.${c._id}`, c, `${s.name}: ${src.doc.name} AE copy`]);
      }
      next.items = [...(next.items || []), emb._id];
      actorWrites.push([`!actors.items!${s.actor}.${emb._id}`, emb, `${s.name}: embed ${src.doc.name}`]);
    }
    loot[emb._id] = { id: "${item.id}", loot_description: String(emb.system.props.description ?? ""), name: src.doc.name, roll: "", uuid: `Actor.${s.actor}.Item.${emb._id}` };
    const table = {};
    s.rows.forEach(([n, p], i) => { table[String(i)] = { $deleted: false, loot_id: n, loot_percentage: String(p) }; });
    for (const [n] of s.rows) if (!Object.values(loot).some((e) => e?.name === n)) throw new Error(`${s.name}: no catalog entry for ${n}`);
    next.system.props.stealable_loot = loot;
    next.system.props.steal_percentage_table = table;
    next._stats = { ...next._stats, modifiedTime: now };
    actorWrites.push([`!actors!${s.actor}`, next, `${s.name}: ${s.rows.map((r) => r.join(" ")).join(" / ")}`]);
  }

  // ── report / write ──
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — items ${itemWrites.length} puts · actors ${actorWrites.length} puts, ${actorDeletes.length} deletes\n`);
  for (const [k, , n] of itemWrites) console.log("  put  " + k + "  " + n);
  for (const [k, , n] of actorWrites) console.log("  put  " + k + "  " + n);
  for (const [k, n] of actorDeletes) console.log("  del  " + k + "  " + n);
  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }

  for (const [coll, puts, dels] of [["items", itemWrites, []], ["actors", actorWrites, actorDeletes]]) {
    const backupPath = snapshotCollection(coll);
    const db = await openCollection(coll);
    try {
      await db.batch([...puts.map(([key, value]) => ({ type: "put", key, value })), ...dels.map(([key]) => ({ type: "del", key }))]);
    } finally { await db.close(); }
    journal.append({ uuid: `collection:${coll}`, collection: coll, key: [...puts, ...dels].map((w) => w[0]).join(","), beforeHash: null, afterHash: null, backupPath, patch: null, note: `valley-gacha-steal-swap: ${puts.length} puts, ${dels.length} dels` });
    console.log(`wrote ${coll}: ${puts.length} puts, ${dels.length} dels (backup: ${backupPath})`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
