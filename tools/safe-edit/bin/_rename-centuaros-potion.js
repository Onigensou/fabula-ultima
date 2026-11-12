// "Polymorph Potion: Centauros" → "Polymorph Potion: Centuaros" (user ruling
// 2026-11-12, option a): the Wyrmwood elite's actor is named "Centuaros", and a
// polymorph potion finds its form by the monster's EXACT name. Only the potion's
// own text changes — its name, description and the sheet mirrors / steal table
// that copy them. The monster's own study text and skill descriptions are NOT
// touched (they spell it "Centauros" too; left for the user to decide).
//
// Copies found 2026-11-12 (scenes: none): world item wWrePzzYfpE3bEVV, the copy
// on Centuaros 7FB6x9kD38cX5SGB (bnDWRuQ4F9ZunDNN), the copy on Hako
// srAH3OHOoK0tvFih (9osWqShXiM6c2Sin).
// Run from tools/safe-edit:  node bin/_rename-centuaros-potion.js items|actors [--apply]
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const OLD = "Centauros", NEW = "Centuaros";
const POTION_OLD = `Polymorph Potion: ${OLD}`;
const fix = (s) => String(s).split(OLD).join(NEW);

// The potion item doc: every string field mentioning the old spelling.
function fixPotion(doc) {
  const d = JSON.parse(JSON.stringify(doc));
  if (d.name !== POTION_OLD) throw new Error(`unexpected item ${d.name}`);
  d.name = fix(d.name);
  for (const k of ["name", "description"]) if (typeof d.system?.props?.[k] === "string") d.system.props[k] = fix(d.system.props[k]);
  return d;
}
// The owning actor: only the mirror rows that ARE the potion.
function fixOwner(doc, potionId) {
  const d = JSON.parse(JSON.stringify(doc));
  const p = d.system.props;
  let n = 0;
  for (const list of ["shop_consumable_list", "stealable_loot"]) {
    const row = p[list]?.[potionId];
    if (!row) continue;
    for (const k of Object.keys(row)) if (typeof row[k] === "string" && row[k].includes(OLD)) { row[k] = fix(row[k]); n++; }
  }
  for (const row of Object.values(p.steal_percentage_table ?? {})) {
    if (row && row.loot_id === POTION_OLD) { row.loot_id = fix(row.loot_id); n++; }
  }
  return [d, n];
}

const which = process.argv[2];
if (which === "items") {
  run(async ({ changes }) => {
    const k = "!items!wWrePzzYfpE3bEVV";
    const doc = await getByKey("items", k);
    if (!doc) throw new Error("world potion missing");
    if (doc.name !== POTION_OLD) { console.log(`already renamed: ${doc.name}`); return; }
    changes.push([k, fixPotion(doc), `world item → "${fix(doc.name)}"`]);
  }, "Centuaros potion rename — world item", "items");
} else if (which === "actors") {
  run(async ({ changes }) => {
    for (const [actor, item] of [["7FB6x9kD38cX5SGB", "bnDWRuQ4F9ZunDNN"], ["srAH3OHOoK0tvFih", "9osWqShXiM6c2Sin"]]) {
      const ik = `!actors.items!${actor}.${item}`, ak = `!actors!${actor}`;
      const it = await getByKey("actors", ik), a = await getByKey("actors", ak);
      if (!it || !a) throw new Error(`missing ${ik} or ${ak}`);
      if (it.name !== POTION_OLD) { console.log(`already renamed on ${a.name}`); continue; }
      changes.push([ik, fixPotion(it), `${a.name}'s copy → "${fix(it.name)}"`]);
      const [owner, n] = fixOwner(a, item);
      changes.push([ak, owner, `${a.name}: ${n} mirror/steal-table field(s) → ${NEW}`]);
    }
  }, "Centuaros potion rename — actor copies", "actors");
} else {
  console.log("usage: node bin/_rename-centuaros-potion.js items|actors [--apply]");
}
