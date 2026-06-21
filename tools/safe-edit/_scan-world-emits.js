// One-off: find world-stored macros that emit on the reserved core "world" socket.
const { ClassicLevel } = require("classic-level");

const RE = /\.emit\(\s*["'`]world["'`]/;

async function scanCollection(dir, label) {
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  const hits = [];
  try {
    for await (const [key, val] of db.iterator()) {
      const cmd = val?.command ?? "";
      if (typeof cmd === "string" && RE.test(cmd)) {
        const lines = cmd.split("\n")
          .map((l, i) => [i + 1, l])
          .filter(([, l]) => RE.test(l));
        hits.push({ _id: val._id, name: val?.name, key, lines });
      }
    }
  } finally { await db.close(); }
  console.log(`\n=== ${label}: ${hits.length} macro(s) emit on "world" ===`);
  for (const h of hits) {
    console.log(`\n[${h.name}]  _id=${h._id}`);
    for (const [n, l] of h.lines) console.log(`   L${n}: ${l.trim()}`);
  }
}

const BASE = "C:\\Users\\Oni\\AppData\\Local\\FoundryVTT\\Data\\worlds\\fabula-ultima-2\\data";
(async () => {
  await scanCollection(`${BASE}\\macros`, "macros");
})().catch(console.error);
