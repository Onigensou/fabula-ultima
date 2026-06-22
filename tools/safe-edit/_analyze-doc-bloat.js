// Find where the actor/item payload bytes live: top docs by size, and within each
// the split across system (CSB props), flags, embedded items, embedded effects.
// Also aggregate flag-namespace bytes across ALL docs (module flag bloat hunt).
const { ClassicLevel } = require("classic-level");
const path = require("path");
const WORLD = "C:/Users/Oni/AppData/Local/FoundryVTT/Data/worlds/fabula-ultima-2/data";

const sizeOf = (o) => (o == null ? 0 : JSON.stringify(o).length);
const mb = (n) => (n / 1048576).toFixed(2);

async function analyze(coll) {
  const db = new ClassicLevel(path.join(WORLD, coll), { keyEncoding: "utf8", valueEncoding: "json", createIfMissing: false });
  await db.open();
  const docs = [];
  const flagNs = {};          // flag namespace -> total bytes across all docs
  let total = 0;
  for await (const [key, val] of db.iterator()) {
    // only top-level docs (key has no embedded separator after the collection)
    const total1 = sizeOf(val);
    total += total1;
    const sys = sizeOf(val?.system);
    const flg = sizeOf(val?.flags);
    const items = sizeOf(val?.items);
    const fx = sizeOf(val?.effects);
    docs.push({ id: val?._id, name: val?.name, total: total1, sys, flg, items, fx, key });
    for (const ns of Object.keys(val?.flags ?? {})) {
      flagNs[ns] = (flagNs[ns] || 0) + sizeOf(val.flags[ns]);
    }
  }
  await db.close();

  docs.sort((a, b) => b.total - a.total);
  console.log(`\n========== ${coll.toUpperCase()} — total ${mb(total)} MB, ${docs.length} entries ==========`);
  console.log("Top 15 individual docs:");
  console.log("   total |   system |   flags  |  items  | effects | name");
  for (const d of docs.slice(0, 15)) {
    console.log(`${mb(d.total).padStart(8)} |${mb(d.sys).padStart(9)} |${mb(d.flg).padStart(9)} |${mb(d.items).padStart(8)} |${mb(d.fx).padStart(8)} | ${String(d.name).slice(0,40)}`);
  }
  const fns = Object.entries(flagNs).sort((a, b) => b[1] - a[1]).filter(([, b]) => b > 1048576);
  if (fns.length) {
    console.log("Flag namespaces > 1 MB (summed across all docs):");
    for (const [ns, b] of fns) console.log(`   ${mb(b).padStart(8)} MB  flags.${ns}`);
  }
}

(async () => {
  for (const c of ["actors", "items"]) await analyze(c);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
