// Register Carlbero in the Fafnir Castle tables.
//
// Enemies (1d4) is the RANDOM-BATTLE draw pool — it hands the encounter builder
// a body at a time, so anything that must never share a field belongs OUT of the
// rollable range. Carlbero parks at row 6, one above the boss's row 5 and two
// above the 1d4 ceiling: reachable by name and by a deliberate GM draw, never by
// the dice. Same containment the boss already uses.
//
// Encounter (1d8 -> 1d9) is the composed-group table; row 9 is Carlbero ALONE,
// which is the only shape this monster is balanced for.
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const APPLY = process.argv.includes("--apply");
const CB = "B4qRdBIxFN6dZ6MT";
const ENEMIES = "oVJkUYCxsiHW6guM";
const ENCOUNTER = "hpCzLw5RI4wQNtF7";
const R_ENEMY = "Cb1RowFafnir6x9";   // placeholder, replaced below
(async () => {
  const mkId = () => {
    const C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 16 }, () => C[Math.floor(Math.random() * C.length)]).join("");
  };
  const rEnemy = mkId(), rEnc = mkId();
  const db = await openCollection("tables");
  const enemies = await db.get(`!tables!${ENEMIES}`);
  const enc = await db.get(`!tables!${ENCOUNTER}`);
  if (enemies.results.length !== 5 || enc.results.length !== 8) throw new Error("table shape changed — re-check before writing");
  if (enemies.results.includes(rEnemy)) throw new Error("already registered");

  const enemyRow = { _id: rEnemy, type: "document", documentCollection: "Actor", documentId: CB,
                     text: "Carlbero", img: "icons/svg/mystery-man.svg", range: [6, 6], weight: 1, drawn: false, flags: {} };
  const encRow   = { _id: rEnc, type: "text", text: "Carlbero", img: "icons/svg/mystery-man.svg",
                     range: [9, 9], weight: 1, drawn: false, flags: {} };
  enemies.results = [...enemies.results, rEnemy];
  enc.results = [...enc.results, rEnc];
  enc.formula = "1d9";

  const writes = [
    [`!tables.results!${ENEMIES}.${rEnemy}`, enemyRow, "Enemies row 6 (above the 1d4 ceiling — containment)"],
    [`!tables!${ENEMIES}`, enemies, "Enemies: +1 result, formula stays 1d4"],
    [`!tables.results!${ENCOUNTER}.${rEnc}`, encRow, "Encounter row 9 — Carlbero, solo"],
    [`!tables!${ENCOUNTER}`, enc, "Encounter: formula 1d8 -> 1d9"],
  ];
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${writes.length} writes`);
  for (const [k, , n] of writes) console.log(`  ${k}\n    ${n}`);
  // LevelDB holds a directory lock while open, and snapshotCollection copies
  // that directory wholesale — so the read handle MUST be closed before the
  // backup and a fresh one opened to write. Same order _fafnir-util.run() uses;
  // snapshotting through an open handle fails with EPIPE on Windows.
  await db.close();
  if (!APPLY) { console.log("\n(dry run — pass --apply)"); return; }
  const backup = snapshotCollection("tables");
  console.log(`\nbackup: ${backup}`);
  const wdb = await openCollection("tables");
  try { for (const [k, v] of writes) await wdb.put(k, v); } finally { await wdb.close(); }
  console.log("\nwrote " + writes.length + " docs");
})();
