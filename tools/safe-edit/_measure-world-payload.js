const { ClassicLevel } = require("classic-level");
const path = require("path");
const WORLD = "C:/Users/Oni/AppData/Local/FoundryVTT/Data/worlds/fabula-ultima-2/data";
const COLLS = ["actors", "items", "scenes", "journal", "macros", "messages", "playlists", "tables", "cards", "folders", "combats", "settings", "users", "fog"];

(async () => {
  let grand = 0;
  const rows = [];
  for (const c of COLLS) {
    const db = new ClassicLevel(path.join(WORLD, c), { keyEncoding: "utf8", valueEncoding: "json", createIfMissing: false });
    await db.open();
    let total = 0, count = 0;
    for await (const [, val] of db.iterator()) { total += JSON.stringify(val).length; count++; }
    await db.close();
    grand += total;
    rows.push([c, count, total]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  for (const [c, n, t] of rows) console.log(`${c.padEnd(10)} ${String(n).padStart(6)} docs  ${(t / 1048576).toFixed(1).padStart(8)} MB`);
  console.log(`\nTOTAL: ${(grand / 1048576).toFixed(1)} MB  (${grand.toLocaleString()} chars)`);
  console.log(`V8 max string: ${(536870888 / 1048576).toFixed(1)} MB (536,870,888 chars)`);
  console.log(`Headroom: ${((536870888 - grand) / 1048576).toFixed(1)} MB`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
