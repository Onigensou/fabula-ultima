// One-shot: open every store so LevelDB replays any write-ahead log into a
// committable .ldb. world-export only opens what it exports, so scenes,
// settings and messages can otherwise keep their newest writes in a
// gitignored .log and ship missing. See WORLD-EXPORT.md.
const { openCollection } = require("./lib/db");
(async () => {
  const stores = ["settings","messages","combats","users","fog","cards","journal",
                  "macros","scenes","playlists","tables","folders","items","actors"];
  for (const c of stores) {
    try {
      const db = await openCollection(c);
      let n = 0;
      for await (const _ of db.iterator()) n++;
      await db.close();
      console.log(`  ${c.padEnd(10)} ${String(n).padStart(5)} docs`);
    } catch (e) { console.log(`  ${c.padEnd(10)} SKIP (${String(e.message).slice(0,60)})`); }
  }
})();
