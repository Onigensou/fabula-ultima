// One-time migration: move save-system slot blobs out of world settings (where
// they bloat every world-data vend and crash the host on concurrent logins) onto
// disk files. Writes worlds/<world>/fu-saves/slot-<N>.json (full blob) +
// index.json (small preview), then clears the slot settings.
//
//   node _migrate-saves-to-disk.js          # dry run (no writes)
//   node _migrate-saves-to-disk.js --apply  # perform migration
//
// Game must be closed. Settings already backed up by the caller.
const { ClassicLevel } = require("classic-level");
const fs = require("fs");
const path = require("path");

const WORLD_ID  = "fabula-ultima-2";
// Derive the data root from this script's location (tools/safe-edit/ -> repo root)
// so the migration is portable across machines; allow an explicit override.
const DATA_ROOT = process.env.FU_DATA_ROOT || path.resolve(__dirname, "..", "..");
const SETTINGS_DIR = path.join(DATA_ROOT, "worlds", WORLD_ID, "data", "settings");
const SAVES_DIR    = path.join(DATA_ROOT, "worlds", WORLD_ID, "fu-saves");
const SLOT_COUNT   = 3;
const APPLY = process.argv.includes("--apply");

// MUST stay identical to buildPreview() in save-storage.js
function buildPreview(blob) {
  if (!blob) return null;
  const pa = blob.data?.partyActorData ?? {};
  const props = pa.system?.props ?? {};
  const previewProps = {};
  if (props.game_name != null) previewProps.game_name = props.game_name;
  for (let i = 1; i <= 10; i++) {
    const k = `member_id_${i}`;
    if (props[k] != null) previewProps[k] = props[k];
  }
  return {
    label:   blob.label   ?? "",
    savedAt: blob.savedAt ?? "",
    version: blob.version ?? 1,
    data: {
      activeScene: {
        sceneId:   blob.data?.activeScene?.sceneId   ?? null,
        sceneName: blob.data?.activeScene?.sceneName ?? null,
      },
      partyActorData: {
        uuid:   pa.uuid ?? null,
        system: { props: previewProps },
      },
    },
  };
}

(async () => {
  const db = new ClassicLevel(SETTINGS_DIR, { keyEncoding: "utf8", valueEncoding: "json", createIfMissing: false });
  await db.open();

  // Map slot number -> { dbKey, settingDoc, rawValue }
  const found = {};
  for await (const [dbKey, val] of db.iterator()) {
    const m = /^fabula-ultima-companion\.saveSystem\.slot\.(\d+)$/.exec(val?.key ?? "");
    if (m) found[Number(m[1])] = { dbKey, doc: val };
  }

  const index = {};
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  if (APPLY) fs.mkdirSync(SAVES_DIR, { recursive: true });

  for (let i = 1; i <= SLOT_COUNT; i++) {
    const entry = found[i];
    const raw = entry?.doc?.value ?? "";
    if (!raw) { console.log(`Slot ${i}: empty — skip`); index[i] = null; continue; }

    // The DB stores the Setting doc's `value` as a JSON string. For a String-typed
    // setting whose value is itself JSON.stringify(blob), that means double encoding:
    // first parse -> the blob's JSON string, second parse -> the blob object.
    // (At runtime game.settings.get does the first parse, so storage.getSlot parses once.)
    let blob;
    try {
      const first = JSON.parse(raw);
      blob = typeof first === "string" ? JSON.parse(first) : first;
    } catch (e) { console.log(`Slot ${i}: UNPARSEABLE (${e.message}) — leaving untouched`); continue; }

    const sizeMB = (raw.length / 1048576).toFixed(2);
    const preview = buildPreview(blob);
    index[i] = preview;
    const members = Object.keys(preview.data.partyActorData.system.props).filter(k => k.startsWith("member_id_")).length;
    console.log(`Slot ${i}: ${sizeMB} MB  label="${blob.label}"  scene="${preview.data.activeScene.sceneName}"  members=${members}`);

    if (APPLY) {
      const file = path.join(SAVES_DIR, `slot-${i}.json`);
      fs.writeFileSync(file, JSON.stringify(blob));
      // verify the file reparses & matches
      const back = JSON.parse(fs.readFileSync(file, "utf8"));
      if (JSON.stringify(back) !== JSON.stringify(blob)) throw new Error(`Slot ${i}: file read-back mismatch — ABORT before clearing setting`);
      console.log(`        ✓ wrote ${file} (${(fs.statSync(file).size / 1048576).toFixed(2)} MB), verified`);
    }
  }

  if (APPLY) {
    fs.writeFileSync(path.join(SAVES_DIR, "index.json"), JSON.stringify(index, null, 2));
    console.log(`\n✓ wrote index.json`);
    // Clear the slot settings only AFTER all files are written & verified.
    for (let i = 1; i <= SLOT_COUNT; i++) {
      const entry = found[i];
      if (!entry || !entry.doc.value) continue;
      const cleared = { ...entry.doc, value: "" };
      await db.put(entry.dbKey, cleared);
      console.log(`✓ cleared setting fabula-ultima-companion.saveSystem.slot.${i}`);
    }
  } else {
    console.log("\n(dry run — no files written, no settings cleared)");
    console.log("Index that WOULD be written:");
    console.log(JSON.stringify(index, null, 2).split("\n").slice(0, 40).join("\n"));
  }

  await db.close();
  console.log("\nDone.");
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
