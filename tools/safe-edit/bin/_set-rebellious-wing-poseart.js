// Masked Girl's winged form as a status sprite (legacy boss animation pass, 2026-11-16).
// Zero Power: Rebellious Wing applies its own embedded "Flying" effect to her; that effect now
// carries flags.fabula-ultima-companion.poseArt = Kalina_Battler002.webm, so while she holds it the
// battler-pose rules show the winged sprite on the REAL token (idle, depth, hurt poses, survives
// reloads). The old script's hidden-token + floating copy + cleanup macro is gone with it.
// Only Rebellious Wing's copy of Flying gets the art (Jump's Flying stays plain).
// Run from Data/tools/safe-edit with the game CLOSED. Dry run by default; --apply writes.
const { openCollection } = require("../lib/db");
const NS = "fabula-ultima-companion";
const ACTOR = "LnlydRl7Ed7agd1g", ITEM = "pyQNCZV7jGCDNQd8";
const ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Kalina/Kalina_Battler002.webm";
(async () => {
  const apply = process.argv.includes("--apply");
  const db = await openCollection("actors");
  const prefix = "!actors.items.effects!" + ACTOR + "." + ITEM + ".";
  const hits = [];
  for await (const [key, val] of db.iterator({ gte: prefix, lt: prefix + "￿" })) {
    const doc = val;   // valueEncoding json
    if (String(doc.name).trim().toLowerCase() === "flying") hits.push([key, doc]);
  }
  if (hits.length !== 1) { console.error("expected exactly one Flying effect on Rebellious Wing, found " + hits.length); await db.close(); process.exit(1); }
  const [key, doc] = hits[0];
  const before = doc.flags?.[NS]?.poseArt ?? null;
  console.log((apply ? "[apply] " : "[dry] ") + key + "  poseArt: " + before + "  ->  " + ART);
  if (apply && before !== ART) { doc.flags = doc.flags || {}; doc.flags[NS] = Object.assign({}, doc.flags[NS], { poseArt: ART }); await db.put(key, doc); }
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
