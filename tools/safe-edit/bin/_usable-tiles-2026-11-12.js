"use strict";
// ============================================================================
// Usable tiles + Healing rework, world data (2026-11-12).
//
// Rule (user-approved): beneficial tiles get a Use button, forced ones fire on
// Confirm.
//   Usable : camp, dirt, healing, gathering, fishing, and every loot type
//            (gold, consumable, item, weapon, armor, accessory, treasure)
//   Except : loot / gathering drawn with the Blank texture (hidden surprises)
//   Reset on rest : healing, fishing (they come back after a rest)
// The tile's ORIGINAL type (tileStates.initialType) decides, so spent tiles
// get the flags too and a reset re-arms them as Usable. Nothing else changes:
// no tile state, texture or name is touched.
//
// Targets (each opt-in):
//   --scenes   world scenes store: tile docs' dungeonPathing.usable/resetOnRest
//   --presets  world settings store: Monk's Active Tiles tile-templates presets
//   --slot1    fu-saves/slot-1.json: the saved copy of the same tile flags
//              (a Load re-applies sceneTileVisibility, so an unpatched slot would
//              turn the flags back off)
//
// Dry run by default; --apply writes (game must be closed). For a dry run that
// must not touch the live LevelDB (opening it rotates its MANIFEST), point it at
// copies: --scenes-dir <dir> --settings-dir <dir>.
//
//   node tools/safe-edit/bin/_usable-tiles-2026-11-12.js --scenes --presets --slot1 [--apply]
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");
const LIB = path.join(__dirname, "..", "lib");
const { ClassicLevel }       = require("classic-level");
const { collectionDir, DEFAULT_WORLD, WORLDS_DIR } = require(LIB + "/paths.js");

const MOD = "fabula-ultima-companion";
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = has("--apply");
const DO_SCENES = has("--scenes"), DO_PRESETS = has("--presets"), DO_SLOT1 = has("--slot1");

const LOOT = ["gold", "consumable", "item", "weapon", "armor", "accessory", "treasure"];
const USABLE = new Set(["camp", "dirt", "healing", "gathering", "fishing", ...LOOT]);
const HIDDEN_OK = new Set(["gathering", ...LOOT]);
const RESET_ON_REST = new Set(["healing", "fishing"]);
const truthy = (v) => v === true || v === "true";
const isBlankTex = (src) => /blank/i.test(String(src ?? ""));

// What a tile of this type should carry. null = leave the tile alone.
function wanted(type, textureSrc) {
  if (!USABLE.has(type)) return null;
  const hidden = HIDDEN_OK.has(type) && isBlankTex(textureSrc);
  const w = {};
  if (!hidden) w.usable = true;
  if (RESET_ON_REST.has(type)) w.resetOnRest = true;
  return Object.keys(w).length ? w : null;
}
// The change a tile's dungeonPathing needs (only the keys that differ).
function diff(dp, want) {
  const d = {};
  for (const [k, v] of Object.entries(want ?? {})) if (!truthy(dp?.[k])) d[k] = v;
  return Object.keys(d).length ? d : null;
}

// ── scenes ────────────────────────────────────────────────────────────────
async function planScenes(dir) {
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  const scenes = new Map(), tiles = [];
  try {
    for await (const [key, doc] of db.iterator()) {
      if (key.startsWith("!scenes!")) scenes.set(key.slice(8), doc);
      else if (key.startsWith("!scenes.tiles!")) {
        const [sceneId, tileId] = key.slice(14).split(".");
        tiles.push({ key, sceneId, tileId, doc });
      }
    }
  } finally { await db.close(); }

  const changes = [];
  for (const t of tiles) {
    const st = scenes.get(t.sceneId)?.flags?.[MOD]?.dungeonPathing?.tileStates?.[t.tileId];
    const type = st?.initialType || st?.currentType;
    const want = wanted(type, st?.initialTexture || t.doc?.texture?.src);
    const d = diff(t.doc?.flags?.[MOD]?.dungeonPathing, want);
    if (d) changes.push({ ...t, type, sceneName: scenes.get(t.sceneId)?.name, d });
  }
  // map for the slot patch: tileId → wanted flags
  const byTile = new Map();
  for (const t of tiles) {
    const st = scenes.get(t.sceneId)?.flags?.[MOD]?.dungeonPathing?.tileStates?.[t.tileId];
    const want = wanted(st?.initialType || st?.currentType, st?.initialTexture || t.doc?.texture?.src);
    if (want) byTile.set(`${t.sceneId}.${t.tileId}`, want);
  }
  return { changes, byTile };
}

async function applyScenes(dir, changes) {
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  let ok = 0;
  const now = Date.now();
  try {
    const batch = db.batch();
    for (const c of changes) {
      const doc = c.doc;
      doc.flags ??= {}; doc.flags[MOD] ??= {};
      doc.flags[MOD].dungeonPathing = { ...(doc.flags[MOD].dungeonPathing ?? {}), ...c.d };
      doc._stats = { ...(doc._stats ?? {}), modifiedTime: now };
      batch.put(c.key, doc);
    }
    await batch.write();
    for (const c of changes) {
      const back = await db.get(c.key);
      const dp = back?.flags?.[MOD]?.dungeonPathing ?? {};
      if (Object.keys(c.d).every((k) => dp[k] === true)) ok++;
      else console.error("READ-BACK MISMATCH", c.sceneName, c.tileId);
    }
  } finally { await db.close(); }
  return ok;
}

// ── presets ───────────────────────────────────────────────────────────────
const PRESET_KEY = "monks-active-tiles.tile-templates";
// Preset name → tile type, e.g. "Healing Tile" → healing, "SkillCheck Tile" → none
function presetType(name) {
  const n = String(name ?? "").toLowerCase();
  for (const t of USABLE) if (n.startsWith(t + " tile")) return t;
  return null;
}
async function planPresets(dir) {
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  let hit = null;
  try {
    for await (const [key, doc] of db.iterator()) {
      if (doc?.key === PRESET_KEY) { hit = { key, doc }; break; }
    }
  } finally { await db.close(); }
  if (!hit) throw new Error(`setting ${PRESET_KEY} not found`);
  const value = typeof hit.doc.value === "string" ? JSON.parse(hit.doc.value) : hit.doc.value;
  const changes = [];
  const walk = (list) => {
    for (const p of list ?? []) {
      if (Array.isArray(p?.children)) walk(p.children);
      const type = presetType(p?.name);
      if (!type) continue;
      const want = wanted(type, p?.texture?.src);
      const d = diff(p?.flags?.[MOD]?.dungeonPathing, want);
      if (d) changes.push({ preset: p, name: p.name, type, d });
    }
  };
  walk(Array.isArray(value) ? value : []);
  return { hit, value, changes };
}
async function applyPresets(dir, plan) {
  for (const c of plan.changes) {
    c.preset.flags ??= {}; c.preset.flags[MOD] ??= {};
    c.preset.flags[MOD].dungeonPathing = { ...(c.preset.flags[MOD].dungeonPathing ?? {}), ...c.d };
  }
  const doc = plan.hit.doc;
  doc.value = typeof doc.value === "string" ? JSON.stringify(plan.value) : plan.value;
  doc._stats = { ...(doc._stats ?? {}), modifiedTime: Date.now() };
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  try { await db.put(plan.hit.key, doc); } finally { await db.close(); }
}

// ── slot 1 ────────────────────────────────────────────────────────────────
function planSlot(file, byTile) {
  const save = JSON.parse(fs.readFileSync(file, "utf8"));
  const vis = save?.data?.sceneTileVisibility ?? {};
  const changes = [];
  for (const [sceneId, tiles] of Object.entries(vis)) {
    for (const [tileId, t] of Object.entries(tiles ?? {})) {
      const want = byTile.get(`${sceneId}.${tileId}`);
      const d = diff(t?.flags?.[MOD]?.dungeonPathing, want);
      if (d) changes.push({ sceneId, tileId, t, d });
    }
  }
  return { save, changes };
}

(async () => {
  if (!DO_SCENES && !DO_PRESETS && !DO_SLOT1) { console.log("pick --scenes / --presets / --slot1"); return; }
  const scenesDir = arg("--scenes-dir") ?? collectionDir("scenes", DEFAULT_WORLD);
  const settingsDir = arg("--settings-dir") ?? collectionDir("settings", DEFAULT_WORLD);
  const slotFile = arg("--slot-file") ?? path.join(WORLDS_DIR, DEFAULT_WORLD, "fu-saves", "slot-1.json");
  if (APPLY) {
    const { assertGameClosed } = require(LIB + "/lock.js");
    assertGameClosed(DEFAULT_WORLD);
  }

  const sc = await planScenes(scenesDir);
  if (DO_SCENES) {
    const count = {};
    for (const c of sc.changes) count[c.type] = (count[c.type] ?? 0) + 1;
    console.log(`scenes: ${sc.changes.length} tile(s)`, count);
    for (const c of sc.changes) console.log(`  ${c.sceneName} | ${c.tileId} | ${c.type} | ${JSON.stringify(c.d)}`);
  }
  let pr = null;
  if (DO_PRESETS) {
    pr = await planPresets(settingsDir);
    console.log(`presets: ${pr.changes.length}`);
    for (const c of pr.changes) console.log(`  ${c.name} | ${c.type} | ${JSON.stringify(c.d)}`);
  }
  let sl = null;
  if (DO_SLOT1) {
    sl = planSlot(slotFile, sc.byTile);
    console.log(`slot 1: ${sl.changes.length} tile(s)`);
  }
  if (!APPLY) { console.log("\nDRY RUN — pass --apply to write."); return; }

  const { snapshotCollection } = require(LIB + "/backup.js");
  const journal = require(LIB + "/journal.js");
  if (DO_SCENES && sc.changes.length) {
    const backupPath = snapshotCollection("scenes", DEFAULT_WORLD);
    const ok = await applyScenes(scenesDir, sc.changes);
    journal.append({ uuid: `scenes:${sc.changes.length} usable tiles`, collection: "scenes", key: "(batch)", beforeHash: "-", afterHash: "-",
      backupPath, patch: { tiles: sc.changes.map((c) => `${c.sceneId}.${c.tileId}:${Object.keys(c.d).join("+")}`) },
      note: "Usable tiles rollout 2026-11-12: usable on beneficial types, resetOnRest on healing/fishing" });
    console.log(`scenes written + verified: ${ok}/${sc.changes.length} (backup ${backupPath})`);
    if (ok !== sc.changes.length) process.exit(1);
  }
  if (DO_PRESETS && pr.changes.length) {
    const backupPath = snapshotCollection("settings", DEFAULT_WORLD);
    await applyPresets(settingsDir, pr);
    journal.append({ uuid: `settings:${PRESET_KEY}`, collection: "settings", key: pr.hit.key, beforeHash: "-", afterHash: "-",
      backupPath, patch: { presets: pr.changes.map((c) => `${c.name}:${Object.keys(c.d).join("+")}`) },
      note: "Usable tiles rollout 2026-11-12: tile presets" });
    console.log(`presets written: ${pr.changes.length} (backup ${backupPath})`);
  }
  if (DO_SLOT1 && sl.changes.length) {
    const bak = slotFile.replace(/\.json$/, `.pre-usable-tiles-${Date.now()}.json`);
    fs.copyFileSync(slotFile, bak);
    for (const c of sl.changes) {
      c.t.flags ??= {}; c.t.flags[MOD] ??= {};
      c.t.flags[MOD].dungeonPathing = { ...(c.t.flags[MOD].dungeonPathing ?? {}), ...c.d };
    }
    fs.writeFileSync(slotFile, JSON.stringify(sl.save));
    console.log(`slot 1 written: ${sl.changes.length} (backup ${bak})`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
