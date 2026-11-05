// ============================================================================
// Underground Decor (2026-11-06): writes the approved mockup's surface FX and
// ambience flags onto Nether Bridge and Ancient Mural. GAME CLOSED (opens the
// scenes LevelDB directly).
//
//   node tools/safe-edit/bin/_apply-underground-decor.js <world dir> [--dry-run]
//   e.g. node tools/safe-edit/bin/_apply-underground-decor.js worlds/fabula-ultima-2
//
// Idempotent: it SETS these keys outright (never deep-merges), touches nothing
// else, and backs up the two scene docs to tools/safe-edit/backups/ (git-ignored).
// Positions are map px read off the paintings (both scenes have padding 0).
// ============================================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { ClassicLevel } = require(path.join(__dirname, "..", "node_modules", "classic-level"));

const MOD = "fabula-ultima-companion";
const TAG = "claude-2026-11-06-underground-decor";

const BRIDGE_CRYSTALS = [[350, 560, 70], [730, 478, 60], [1395, 575, 80], [1880, 548, 70], [1550, 100, 60], [260, 120, 50], [1930, 335, 55], [360, 1362, 45]];
const MURAL_CRYSTALS = [[42, 432, 46], [172, 393, 44], [438, 420, 46], [915, 412, 40], [1198, 300, 42], [1395, 262, 44], [100, 722, 42], [1385, 742, 42], [1282, 918, 46]];
const AMETHYST = [0.78, 0.58, 1];

const SCENES = {
  // Nether Bridge (Valley_Map025)
  sEaLbRiDgEvM0250: {
    surfaceFx: {
      mode: "gas",
      crystals: BRIDGE_CRYSTALS,
      crystalColor: [0.70, 0.48, 1.0],
      wisp: 0.16,
      shimmerTile: "GIRssfFkLlaJ5evn",
      shimmer: { cx: 1024, cy: 820, squash: 1.9 },
      draft: TAG,
    },
    ambience: { spores: { preset: "gas" }, puffs: true, draft: TAG },
  },
  // Ancient Mural (Valley_Map012)
  bcg4esedBAmZTEVL: {
    surfaceFx: {
      mode: "water",
      crystals: MURAL_CRYSTALS,
      crystalColor: [0.72, 0.5, 1.0],
      wisp: 0.12,
      darkness: 0.32,
      lights: [
        ...MURAL_CRYSTALS.map(([x, y], i) => [x, y, [150, 150, 170, 150, 150, 160, 140, 140, 140][i], ...AMETHYST, 1]),
        [20, 400, 120, 0.85, 0.7, 1, 0.8],       // west cave mouth
        [700, 250, 520, 0.72, 0.76, 1, 0.55],    // cool wash on the mural
      ],
      draft: TAG,
    },
    ambience: { spores: { preset: "crystal", points: MURAL_CRYSTALS.map(([x, y]) => [x, y]) }, drips: true, draft: TAG },
  },
};

async function main() {
  const worldDir = path.resolve(process.argv[2] || "");
  const dry = process.argv.includes("--dry-run");
  const dir = path.join(worldDir, "data", "scenes");
  if (!fs.existsSync(dir)) { console.error(`no scenes store at ${dir}`); process.exit(2); }
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  try {
    const backup = {};
    for (const [id, set] of Object.entries(SCENES)) {
      const key = `!scenes!${id}`;
      const doc = await db.get(key);
      backup[id] = JSON.parse(JSON.stringify(doc));
      const fu = (doc.flags[MOD] ??= {});
      const general = ((fu.oniFabula ??= {}).general ??= {});
      if (general.parallaxEnabled === true) throw new Error(`${doc.name}: Walk Parallax is on; surface FX would not draw`);
      general.surfaceFxEnabled = true;
      fu.surfaceFx = set.surfaceFx;
      if (fu.ambience && fu.ambience.draft !== TAG) throw new Error(`${doc.name}: already has a hand-made ambience flag; not overwriting`);
      fu.ambience = set.ambience;
      console.log(`${dry ? "[dry] " : ""}${doc.name} (${general.navigationName}): surfaceFx ${set.surfaceFx.mode}, ambience ${Object.keys(set.ambience).filter((k) => k !== "draft").join("+")}`);
      if (!dry) await db.put(key, doc);
    }
    if (!dry) {
      const bdir = path.join(__dirname, "..", "backups");   // git-ignored
      fs.mkdirSync(bdir, { recursive: true });
      const out = path.join(bdir, `surface-fx-${path.basename(worldDir)}-${Date.now()}.json`);
      fs.writeFileSync(out, JSON.stringify(backup, null, 1));
      console.log(`backup -> ${out}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
