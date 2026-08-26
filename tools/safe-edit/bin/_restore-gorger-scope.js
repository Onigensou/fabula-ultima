// Narrow the Gorger branch's world diff back to JUST the Gorger work.
//
// Two independent repairs, both sourced from origin/main's authored export
// (the correct baseline for "what does this branch change" — diffing against a
// local HEAD that already contains your own edits compares your output to your
// output and always looks clean):
//
//   A. The 4 PRE-EXISTING Gorgers lost per-actor configuration in the rebuild.
//      `blankActor` clones the DONOR wholesale, so `flags` and `prototypeToken`
//      came from Ampere, and it hard-sets `ownership = { default: 0 }`. That is
//      harmless when creating a NEW actor (the dragon scripts' case) and lossy
//      when rebuilding an existing one: Aero alone lost 43 prototypeToken flags
//      (Border-Control, barbrawl bars), plus idle-animation flags, the GM's
//      ownership entry and its creation stats.
//
//      ⚠ Restores prototypeToken.**flags** ONLY, never the whole prototypeToken.
//      Aero's origin/main token texture points at CRYO art — restoring the token
//      wholesale would silently undo the art fix this branch exists to make.
//
//      Deliberately NOT restored (these losses are the point of the rebuild):
//      Aero's ghost `normal_spell_list` row for the deleted "Ventus Alta",
//      Aero/Geo's `skill_active_list` Puff Up rows (it is a passive now), and
//      Life's "Generic NPC Passive" ghost `skill_passive_list` row.
//
//   B. 26 unrelated actors carry regenerated `Crisis` AE ids — fallout from a
//      teardown sweep that stripped AEs by NAME across every actor in the world.
//      Nothing authored was lost (Crisis is a transient marker the
//      derived-status-reactor re-applies itself), but it has no business in a
//      Gorger commit. Their `effects` arrays go back to origin/main verbatim.
//
// Run from tools/safe-edit; --apply to write.
const { execSync } = require("child_process");
const { getByKey } = require("../lib/db");
const { run } = require("./_dragon-util");

const REPO = "C:/Users/Oni/AppData/Local/FoundryVTT/Data";
const BASE = "origin/main";
const sh = (c) => execSync(c, { cwd: REPO, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
const baseDoc = (id) =>
  JSON.parse(sh(`git show ${BASE}:worlds/fabula-ultima-2/_authored-export/actors/${id}.json`));

// The 4 rebuilt-in-place Gorgers. The 4 NEW ones have nothing to preserve.
const REBUILT = {
  "9yadoDh5EhIWpevl": "Aero Gorger",
  zRuXyepUutM2LY9H:   "Geo Gorger",
  PgNX7yW5nxq2emWX:   "Mana Gorger",
  nyHr1MwzRKcGUdyW:   "Life Gorger",
};

const CRISIS = require("C:/Users/Oni/AppData/Local/Temp/claude/c--Users-Oni-AppData-Local-FoundryVTT/e6429e79-a7be-4f7d-acef-1565779f718f/scratchpad/crisis-ids.json");

run(async ({ changes }) => {
  // ── A. per-actor identity/config on the rebuilt Gorgers ──────────────────
  for (const [id, name] of Object.entries(REBUILT)) {
    const cur = await getByKey("actors", `!actors!${id}`);
    if (!cur) throw new Error(`missing live actor ${name} (${id})`);
    const was = baseDoc(id);

    const doc = JSON.parse(JSON.stringify(cur));
    const restored = [];

    if (was.ownership && JSON.stringify(was.ownership) !== JSON.stringify(doc.ownership)) {
      doc.ownership = JSON.parse(JSON.stringify(was.ownership));
      restored.push(`ownership(${Object.keys(was.ownership).length})`);
    }
    if (was.flags && Object.keys(was.flags).length) {
      doc.flags = JSON.parse(JSON.stringify(was.flags));
      restored.push(`flags(${Object.keys(was.flags).length})`);
    }
    const wasTokFlags = was.prototypeToken?.flags;
    if (wasTokFlags && Object.keys(wasTokFlags).length) {
      doc.prototypeToken = doc.prototypeToken ?? {};
      doc.prototypeToken.flags = JSON.parse(JSON.stringify(wasTokFlags));
      restored.push(`prototypeToken.flags(${Object.keys(wasTokFlags).length})`);
    }
    if (was._stats) {
      doc._stats = doc._stats ?? {};
      if (was._stats.createdTime != null) { doc._stats.createdTime = was._stats.createdTime; restored.push("createdTime"); }
      if (was._stats.duplicateSource != null) { doc._stats.duplicateSource = was._stats.duplicateSource; restored.push("duplicateSource"); }
    }

    // Guard: the art fix must survive this restore.
    const art = doc.img;
    if (doc.prototypeToken?.texture?.src !== art) {
      throw new Error(`${name}: prototypeToken art drifted from actor art during restore (${doc.prototypeToken?.texture?.src} vs ${art})`);
    }
    if (!restored.length) { console.log(`  (no-op) ${name}`); continue; }
    changes.push([`!actors!${id}`, doc, `${name} — restored ${restored.join(", ")}`]);
  }

  // ── B. transient Crisis AE ids on unrelated actors ───────────────────────
  for (const id of CRISIS) {
    const cur = await getByKey("actors", `!actors!${id}`);
    if (!cur) { console.log(`  (skip) missing actor ${id}`); continue; }
    const was = baseDoc(id);
    if (JSON.stringify(cur.effects ?? []) === JSON.stringify(was.effects ?? [])) {
      console.log(`  (no-op) ${cur.name}`); continue;
    }
    const doc = JSON.parse(JSON.stringify(cur));
    doc.effects = JSON.parse(JSON.stringify(was.effects ?? []));
    changes.push([`!actors!${id}`, doc, `${cur.name} — effects back to ${BASE} (transient Crisis ids)`]);
  }
}, "gorger-scope-restore");
