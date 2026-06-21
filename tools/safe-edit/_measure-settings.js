// Break down the settings collection by key + namespace to find the bloat.
const { ClassicLevel } = require("classic-level");
const WORLD = "C:/Users/Oni/AppData/Local/FoundryVTT/Data/worlds/fabula-ultima-2/data";

(async () => {
  const db = new ClassicLevel(`${WORLD}/settings`, { keyEncoding: "utf8", valueEncoding: "json", createIfMissing: false });
  await db.open();
  const rows = [];
  const nsTotals = {};
  for await (const [, val] of db.iterator()) {
    const key = val?.key ?? "(no key)";
    const size = JSON.stringify(val).length;
    rows.push([key, size]);
    const ns = String(key).split(".")[0] || "(none)";
    nsTotals[ns] = (nsTotals[ns] || 0) + size;
  }
  await db.close();

  rows.sort((a, b) => b[1] - a[1]);
  console.log("=== Top 25 individual settings by size ===");
  for (const [key, size] of rows.slice(0, 25)) {
    console.log(`${(size / 1048576).toFixed(2).padStart(8)} MB   ${key}`);
  }
  console.log("\n=== Totals by namespace (module/system id) ===");
  const ns = Object.entries(nsTotals).sort((a, b) => b[1] - a[1]);
  for (const [name, size] of ns) {
    console.log(`${(size / 1048576).toFixed(2).padStart(8)} MB   ${name}`);
  }
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
