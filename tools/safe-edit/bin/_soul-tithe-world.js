#!/usr/bin/env node
"use strict";
// ============================================================================
// World data for the Soul Tithe conflict event (docs/soul-tithe-design.md).
//
//   node bin/_soul-tithe-world.js           # dry run
//   node bin/_soul-tithe-world.js --write   # GAME MUST BE CLOSED
//
//   1. The Soul Fragment template actor: the Lightning Crystal's sheet with the
//      crystal's affinities removed. Found by the event through its flag.
//   2. Valley_Battlemap004, the Sealed Cavern's own battle map: a copy of
//      Valley_Battlemap002 (same art, same walls) with no lightning arcs.
//   3. Valley_Map010 points at it. Every other underground map keeps 002.
//   4. "Seal Cavern" becomes "Sealed Cavern" everywhere it is written.
// Idempotent: reruns reuse the ids below and rewrite the same content.
// ============================================================================

const { openCollection } = require("../lib/db");

const NS = "fabula-ultima-companion";
const CRYSTAL = "!actors!pEIMfwzQHUAGnGWz";
const FRAGMENT_ID = "soULFRagmeNT0001";
const SOURCE_SCENE = "JKhl4GMekbmkKBXw"; // Valley_Battlemap002
const NEW_SCENE = "VaLLeYBaTTLeM004";
const CAVERN = "!scenes!52LLgHZIyAXBrbMq"; // Valley_Map010
const ICON = "icons/svg/aura.svg";

const NAME_DOCS = [
  "!scenes!09CApvaBfOesGfbp",
  CAVERN,
  "!scenes!MWQBX1ZnbjcFkvq2",
  "!scenes!Uas0vCUZJOjrpgB0",
  "!scenes!W5aPNI1FbnYEMESZ",
  "!scenes!q5y2KZtTg7k9CCi8",
  "!scenes!sEaLbRiDgEvM0250",
  "!scenes.tiles!sEaLbRiDgEvM0250.bm0FzO3DZibxAnKc",
];

async function buildActor(write) {
  const db = await openCollection("actors");
  try {
    const crystal = await db.get(CRYSTAL);
    if ((crystal.items ?? []).length || (crystal.effects ?? []).length) {
      throw new Error("Lightning Crystal now carries items or effects; review before cloning");
    }
    const a = JSON.parse(JSON.stringify(crystal));
    a._id = FRAGMENT_ID;
    a.name = "Soul Fragment";
    a.flags[NS] = { ...a.flags[NS], bdObject: true, bdObjectHpBar: true, conflictObject: "soul-fragment" };
    const p = a.system.props;
    p.id = FRAGMENT_ID;
    p.uuid = `Actor.${FRAGMENT_ID}`;
    p.name = "Soul Fragment";
    p.max_hp = "1";
    p.current_hp = "1";
    p.traits = "Stolen Soul";
    p.study_text = "<p>A torn-off piece of someone's soul, called down into the dark. Destroy it and what it took goes home. Leave it, and it takes more.</p>";
    p.subtype_list = "";
    p.attribute = "";
    // The art is the owner's, set at spawn. Nothing here should still show a crystal.
    a.img = ICON;
    p.img = ICON;
    a.prototypeToken.texture.src = ICON;
    for (const k of ["sprite_battle", "sprite_standard", "cut_in_critical", "cut_in_fumble", "cut_in_zero_power"]) p[k] = "";
    for (let i = 1; i <= 9; i++) if (`affinity_${i}` in p) p[`affinity_${i}`] = "NA";
    a.prototypeToken.name = "Soul Fragment";
    console.log(`actor: ${a.name} (${a._id}) DEF ${p.defense} MDEF ${p.magic_defense} activation ${p.activation}, cloned from ${crystal.name}`);
    if (write) await db.put(`!actors!${FRAGMENT_ID}`, a);
  } finally { await db.close(); }
}

function renamed(doc) {
  return JSON.parse(JSON.stringify(doc).split("Seal Cavern").join("Sealed Cavern"));
}

async function buildScenes(write) {
  const db = await openCollection("scenes");
  try {
    const src = await db.get(`!scenes!${SOURCE_SCENE}`);
    if ((src.tokens ?? []).length) throw new Error(`${src.name} has tokens on it; a battle may be parked there`);

    const s = JSON.parse(JSON.stringify(src));
    s._id = NEW_SCENE;
    s.name = "Valley_Battlemap004";
    s.navName = "Valley of the Dragon - Sealed Cavern (Battle)";
    const f = s.flags[NS];
    f.stageAmbientNoArcs = true;
    f.oniFabula.general.conflictEvent = "soul-tithe";
    f.oniFabula.general.sceneVisited = false;
    console.log(`scene: ${s.name} (${s._id}), event ${f.oniFabula.general.conflictEvent}, ${s.walls.length} walls, art ${decodeURIComponent(s.background.src).split("/").pop()}`);
    if (write) {
      await db.put(`!scenes!${NEW_SCENE}`, s);
      for (const wid of src.walls) {
        const wall = await db.get(`!scenes.walls!${SOURCE_SCENE}.${wid}`);
        await db.put(`!scenes.walls!${NEW_SCENE}.${wid}`, wall);
      }
    }

    for (const key of NAME_DOCS) {
      const doc = await db.get(key);
      const before = JSON.stringify(doc);
      const next = renamed(doc);
      if (key === CAVERN) {
        console.log(`Valley_Map010 battleMap ${next.flags[NS].oniDungeon.battleMap} -> Scene.${NEW_SCENE}`);
        next.flags[NS].oniDungeon.battleMap = `Scene.${NEW_SCENE}`;
      }
      const hits = before.split("Seal Cavern").length - 1;
      console.log(`rename: ${key} (${hits} occurrence${hits === 1 ? "" : "s"})`);
      if (write) await db.put(key, next);
    }
  } finally { await db.close(); }
}

async function main() {
  const write = process.argv.includes("--write");
  await buildActor(write);
  await buildScenes(write);
  console.log(write ? "written" : "dry run: pass --write (game closed)");
}

main().catch((e) => { console.error(e); process.exit(1); });
