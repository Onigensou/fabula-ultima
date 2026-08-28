"use strict";
// ============================================================================
// Update the "Vertigo Tile" preset in the Monk's Active Tiles template setting.
//
// The preset is one entry inside a ~180 KB JSON array held in a single Setting
// document, so this does a whole-value read → mutate → put. safe-edit's `patch`
// deep-MERGES and can never delete or reorder inside an array (see
// reference_safe_edit_merge_trap), which is the wrong tool for this shape.
//
// What changes on the preset:
//   · dungeonPathing.vertigoMoves = 5      — how long the darkness lasts
//   · effectConfig Blind entry gains turns:5 — so Blind and Vertigo expire together
//   · effectConfig.sfxUrl cleared           — dp-vertigo now plays Darkness5.ogg
//     for every client when the scene flag flips; emotion_down.wav on top of it
//     was two stings fighting each other
//
// Game must be closed. Run:  node tools/safe-edit/bin/_update-vertigo-tile-preset.js [--dry-run]
// ============================================================================

const path = require("node:path");
const LIB = path.join(__dirname, "..", "lib");
const { openCollection }      = require(LIB + "/db.js");
const { assertGameClosed }    = require(LIB + "/lock.js");
const { snapshotCollection }  = require(LIB + "/backup.js");
const journal                 = require(LIB + "/journal.js");

const COLLECTION   = "settings";
const SETTING_KEY  = "monks-active-tiles.tile-templates";
const PRESET_NAME  = "Vertigo Tile";
const MOD          = "fabula-ultima-companion";
const VERTIGO_MOVES = 5;

const DRY = process.argv.includes("--dry-run");

function parseValue(v) {
  return typeof v === "string" ? JSON.parse(v) : v;
}

/** Apply every change to one preset object. Returns a list of what it did. */
function mutatePreset(preset) {
  const notes = [];
  const dp = preset?.flags?.[MOD]?.dungeonPathing;
  if (!dp) throw new Error("preset has no dungeonPathing flags");

  if (dp.vertigoMoves !== VERTIGO_MOVES) {
    dp.vertigoMoves = VERTIGO_MOVES;
    notes.push(`vertigoMoves=${VERTIGO_MOVES}`);
  }

  const ec = dp.effectConfig;
  if (!ec) throw new Error("preset has no effectConfig");

  let effects = [];
  try { effects = JSON.parse(ec.activeEffectsJson ?? "[]"); } catch {}
  if (!Array.isArray(effects) || !effects.length) {
    throw new Error("preset has no activeEffectsJson entries — expected Blind");
  }
  for (const e of effects) {
    if (e.turns !== VERTIGO_MOVES) {
      e.turns = VERTIGO_MOVES;
      notes.push(`${e.label ?? e.id}.turns=${VERTIGO_MOVES}`);
    }
  }
  ec.activeEffectsJson = JSON.stringify(effects);

  if (ec.sfxUrl) {
    notes.push(`sfxUrl cleared (was ${ec.sfxUrl.split("/").pop()})`);
    ec.sfxUrl = "";
  }

  return notes;
}

(async () => {
  assertGameClosed();   // takes a WORLD, not a collection — defaults to DEFAULT_WORLD

  const db = await openCollection(COLLECTION);
  let hit = null;
  try {
    for await (const [key, val] of db.iterator()) {
      const doc = typeof val === "string" ? JSON.parse(val) : val;
      if (doc?.key === SETTING_KEY) { hit = { key: String(key), doc }; break; }
    }
  } finally {
    await db.close();
  }
  if (!hit) throw new Error(`Setting "${SETTING_KEY}" not found`);

  const beforeHash = journal.hash(hit.doc);
  const wasString  = typeof hit.doc.value === "string";
  const arr        = parseValue(hit.doc.value);
  const list       = Array.isArray(arr) ? arr : Object.values(arr);

  const presets = list.filter(t => t?.flags?.["monks-active-tiles"]?.name === PRESET_NAME);
  if (presets.length !== 1) {
    throw new Error(`expected exactly 1 "${PRESET_NAME}" preset, found ${presets.length}`);
  }

  const notes = mutatePreset(presets[0]);
  if (!notes.length) { console.log("Already up to date — nothing to write."); return; }

  console.log(`"${PRESET_NAME}" changes:`);
  for (const n of notes) console.log("  ·", n);

  hit.doc.value = wasString ? JSON.stringify(arr) : arr;
  const afterHash = journal.hash(hit.doc);

  if (DRY) { console.log("\n--dry-run — nothing written."); return; }

  const backupPath = snapshotCollection(COLLECTION);
  console.log("backup:", backupPath);

  const wdb = await openCollection(COLLECTION);
  try {
    await wdb.put(hit.key, hit.doc);
  } finally {
    await wdb.close();
  }

  // Read-back verify — confirm the preset on disk carries every change.
  const vdb = await openCollection(COLLECTION);
  let ok = false;
  try {
    const back = await vdb.get(hit.key);
    const doc  = typeof back === "string" ? JSON.parse(back) : back;
    const varr = parseValue(doc.value);
    const vlist = Array.isArray(varr) ? varr : Object.values(varr);
    const p = vlist.find(t => t?.flags?.["monks-active-tiles"]?.name === PRESET_NAME);
    const dp = p?.flags?.[MOD]?.dungeonPathing;
    const fx = JSON.parse(dp?.effectConfig?.activeEffectsJson ?? "[]");
    ok = dp?.vertigoMoves === VERTIGO_MOVES
      && !dp?.effectConfig?.sfxUrl
      && fx.length > 0
      && fx.every(e => e.turns === VERTIGO_MOVES);
    console.log("read-back:", ok ? "OK" : "MISMATCH", JSON.stringify({
      vertigoMoves: dp?.vertigoMoves,
      sfxUrl: dp?.effectConfig?.sfxUrl,
      effects: fx.map(e => ({ label: e.label, turns: e.turns })),
    }));
  } finally {
    await vdb.close();
  }
  if (!ok) throw new Error(`read-back verify FAILED — restore from ${backupPath}`);

  journal.append({
    uuid: `Setting.${hit.doc._id ?? SETTING_KEY}`,
    collection: COLLECTION,
    key: hit.key,
    beforeHash, afterHash, backupPath,
    patch: { preset: PRESET_NAME, notes },
    note: "Vertigo tile preset — 5-move duration, Blind turns, SFX moved to dp-vertigo",
  });
  console.log("journalled. done.");
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
