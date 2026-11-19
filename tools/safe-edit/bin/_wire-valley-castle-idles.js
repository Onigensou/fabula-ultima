// Wire the 2026-11-19 Valley / Underground / Fafnir Castle battle idle batch (18 clips) into the world.
// Clips were uploaded to Forge Beastiary/<Name>_Battle_Idle.webm (all new paths, CDN bytes verified).
// Per actor:
//   - system.props.sprite_battle = the idle webm (the Battle Director swaps it in as the battle token texture)
//   - SHADOW-STRIPPED art (baked ground shadow removed, so the game's own shadow must draw it):
//       flags.fabula-ultima-companion.spriteShadow = true, and the map token also uses the idle webm, so no token
//       anywhere still shows the old baked shadow (one shadow source per actor; Asura/Deva precedent)
//   - CANVAS-CHANGED clips (re-padded symmetrically so the art sits exactly where the standing sprite does):
//       prototype token scale x factor (fit=contain: max side decides the pixel size), and the map token uses the
//       idle webm too, so map and battle tokens stay the same size
// Run from Data/: node tools/safe-edit/bin/_wire-valley-castle-idles.js [--apply]
const { openCollection, getByKey } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const journal = require("../lib/journal");
const APPLY = process.argv.includes("--apply");
const BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/";
const MOD = "fabula-ultima-companion";

// id: [file, shadowStripped, scaleFactor]
const WIRE = {
  "1Lw78Js1f7MogV2B": ["Gigas", true, 1],
  "8kluKkqkcGFkmXNO": ["MistDragon", true, 178 / 172],
  FulgimiteActor01: ["Fulgimite", false, 1],
  H6Ubup6kmkgNQzLU: ["Drakoza", true, 1],
  I2sSkVIQ4FCunZBE: ["Skizzik", true, 1],
  iGc0EUHE9LKWT0Ye: ["ManaRay", false, 1],
  sTGMdYipYCG36aBO: ["LightningPrism", false, 1],
  vmYeN1WWIF5TSjjF: ["Kurona", true, 1],
  x8TBsDZaRgoSo5no: ["Obsidrax", false, 1],
  ym6As1q7yG1EMl9M: ["GalvanicParyashera", false, 1],
  pEIMfwzQHUAGnGWz: ["LightningCrystal", false, 103 / 99],
  B4qRdBIxFN6dZ6MT: ["Carlbero", false, 1],
  bnem1vdA6Bv3mBVx: ["Succubus", false, 181 / 179],
  fCxslZazJKtQWsKP: ["DeathGazer", false, 1],
  FLy3XRr40wNRmYxV: ["IronColossus", false, 449 / 410],
  rftRuHZwWx5SiNpH: ["DireOrc", false, 1],
  VwClo606KbQSK6aQ: ["Roo", true, 1],
  wjGqTFMH0Z7yZkZt: ["Imp", false, 1],
};
const r4 = v => Math.round(v * 10000) / 10000;

(async () => {
  const changes = [];
  for (const [id, [file, stripped, factor]] of Object.entries(WIRE)) {
    const a = await getByKey("actors", `!actors!${id}`);
    if (!a) throw new Error(`actor ${id} not found`);
    const next = JSON.parse(JSON.stringify(a)), url = `${BASE}${file}_Battle_Idle.webm`, notes = [];
    next.system.props.sprite_battle = url; notes.push(`sprite_battle -> ${file}_Battle_Idle.webm`);
    const tex = (next.prototypeToken.texture = next.prototypeToken.texture ?? {});
    const tokenToo = stripped || factor !== 1;
    if (tokenToo) { tex.src = url; notes.push("map token -> idle webm"); }
    if (stripped) { next.flags = next.flags ?? {}; next.flags[MOD] = next.flags[MOD] ?? {}; next.flags[MOD].spriteShadow = true; notes.push("spriteShadow on"); }
    if (factor !== 1) {
      const sx = Math.sign(tex.scaleX || 1) * r4(Math.abs(tex.scaleX || 1) * factor), sy = Math.sign(tex.scaleY || 1) * r4(Math.abs(tex.scaleY || 1) * factor);
      notes.push(`token scale ${tex.scaleX} -> ${sx}`); tex.scaleX = sx; tex.scaleY = sy;
    }
    // asserts
    if (next.system.props.sprite_battle !== url) throw new Error(`${a.name}: sprite_battle not set`);
    if (stripped && next.flags[MOD].spriteShadow !== true) throw new Error(`${a.name}: spriteShadow not set`);
    changes.push([`!actors!${id}`, next, `${a.name}: ${notes.join(", ")}`]);
  }
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${changes.length} writes\n`);
  for (const [, , note] of changes) console.log(`  ${note}`);
  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }
  const backupPath = snapshotCollection("actors");
  console.log(`\nbackup: ${backupPath}`);
  const db = await openCollection("actors");
  try { for (const [k, v] of changes) await db.put(k, v); }
  finally { await db.close(); }
  journal.append({
    uuid: "collection:actors", collection: "actors", key: changes.map(c => c[0]).join(","),
    beforeHash: null, afterHash: null, backupPath, patch: null,
    note: `valley/castle idle batch wiring: ${changes.map(c => c[2]).join("; ")}`,
  });
  console.log(`\nwrote ${changes.length} docs`);
})();
