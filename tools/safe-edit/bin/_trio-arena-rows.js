// _trio-arena-rows — point the story Start Battle rows for Asura / Rakshasa / Deva at their own arenas
// (Valley_Battlemap005/006/007, built 2026-11-20). The conflict event stays on the arena scenes (lightning-storm).
// Game CLOSED. Dry run by default; --apply writes. Idempotent (a row already on its arena is skipped).
const { openCollection } = require("../lib/db");
const APPLY = process.argv.includes("--apply");
const ARENA = { Asura: "Scene.qzTgM2eBrM7UjJEq", Rakshasa: "Scene.BRiO4VtK5UIY5PYW", Deva: "Scene.gMjNNahj2EQIWoyG" };
const OLD = "Scene.XHe8LfutYAkPuR5B";
const ROWS = [
  { key: "!scenes.tiles!YnGINTK5qxtt0rnO.Pbd7U90kKKOFae4Q", path: ["eventRows", 45, "choices", 0, "rows", 0], boss: "Asura" },
  { key: "!scenes.tokens!YnGINTK5qxtt0rnO.UurYH7OjxklS1H7k", path: ["eventRows", 4, "choices", 0, "rows", 0], boss: "Asura" },
  { key: "!scenes.tiles!XNTSewM1NcPG59L1.jQBRVnOLO7SjdKVC", path: ["eventRows", 51, "choices", 0, "rows", 0], boss: "Rakshasa" },
  { key: "!scenes.tokens!XNTSewM1NcPG59L1.qNxU3dILVw7pqivZ", path: ["eventRows", 3, "choices", 0, "rows", 0], boss: "Rakshasa" },
  { key: "!scenes.tiles!JFwf5x809fiLmRF6.8f2dPlEv95Fn0JuT", path: ["eventRows", 0, "thenRows", 29], boss: "Deva" },
];
(async () => {
  const db = await openCollection("scenes");
  let changed = 0;
  try {
    for (const R of ROWS) {
      const doc = await db.get(R.key);
      let row = doc.flags?.["oni-event-system"];
      for (const p of R.path) row = row?.[p];
      if (row?.type !== "startBattle" || row.enemies !== R.boss) throw new Error(`${R.key}: expected startBattle "${R.boss}", got ${JSON.stringify({ type: row?.type, enemies: row?.enemies })}`);
      const want = ARENA[R.boss];
      if (row.battleMap === want) { console.log(`skip  ${R.boss}  ${R.key} (already ${want})`); continue; }
      if (row.battleMap !== OLD) throw new Error(`${R.key}: battleMap is ${row.battleMap}, expected ${OLD} — not touching`);
      console.log(`${APPLY ? "write" : "would"} ${R.boss}  ${R.key}  ${row.battleMap} -> ${want}`);
      if (!APPLY) continue;
      row.battleMap = want;
      await db.put(R.key, doc);
      const back = await db.get(R.key);
      let b = back.flags["oni-event-system"]; for (const p of R.path) b = b[p];
      if (b.battleMap !== want) throw new Error(`${R.key}: read-back ${b.battleMap}`);
      changed++;
    }
  } finally { await db.close(); }
  console.log(APPLY ? `done: ${changed} row(s) written` : "dry run — pass --apply to write");
})().catch((e) => { console.error(e.message); process.exit(1); });
