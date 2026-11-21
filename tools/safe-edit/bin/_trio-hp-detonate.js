// _trio-hp-detonate — Valley trio playtest outcome (2026-11-21, user approved):
//   1. story-elite HP for a 5-6 round fight: Asura 1200 -> 1800, Rakshasa 1200 -> 2000, Deva 1000 -> 1500
//   2. Missile Fist Detonate: victim pool category "enemy" -> "party". "enemy" is relative to the acting
//      token, and a fist acting without its token fails open (skill-targeting matchesCategory returns true),
//      so Detonate once hit the other Missile Fist. "party" = PCs' side by the candidate's own disposition.
// Game CLOSED. Dry run by default; --apply writes. Idempotent.
const { openCollection } = require("../lib/db");
const APPLY = process.argv.includes("--apply");
const HP = [["0AwQ7wEDz4ISA9mA", "Asura", 1200, 1800], ["Rk5haXsaDemonAAA", "Rakshasa", 1200, 2000], ["amxILxU7mqQ0jKhZ", "Deva", 1000, 1500]];
const DET_KEY = "!actors.items!MsFistSummon0001.MsFistDetonate01";
(async () => {
  const db = await openCollection("actors");
  try {
    for (const [id, name, from, to] of HP) {
      const key = `!actors!${id}`; const a = await db.get(key); const p = a.system.props;
      if (a.name !== name) throw new Error(`${key} is "${a.name}", expected ${name}`);
      if (Number(p.max_hp) === to && Number(p.current_hp) === to) { console.log(`skip  ${name} already ${to}`); continue; }
      if (Number(p.max_hp) !== from) throw new Error(`${name} max_hp ${p.max_hp}, expected ${from} — not touching`);
      console.log(`${APPLY ? "write" : "would"} ${name} max_hp/current_hp ${p.max_hp}/${p.current_hp} -> ${to}`);
      if (!APPLY) continue;
      p.max_hp = String(to); p.current_hp = String(to);   // stored as strings on these sheets
      await db.put(key, a);
      const b = (await db.get(key)).system.props; if (b.max_hp !== String(to) || b.current_hp !== String(to)) throw new Error(`${name} read-back ${b.max_hp}/${b.current_hp}`);
    }
    const it = await db.get(DET_KEY);
    if (it.name !== "Detonate") throw new Error(`${DET_KEY} is "${it.name}"`);
    const rows = Object.values(it.system.props.effect_table ?? {}).filter((r) => r?.effect_label === "fd_victim");
    if (rows.length !== 1) throw new Error(`fd_victim rows: ${rows.length}`);
    const r = rows[0];
    if (r.category === "party") console.log("skip  Detonate fd_victim already party");
    else if (r.category !== "enemy") throw new Error(`fd_victim category ${r.category}, expected enemy`);
    else {
      console.log(`${APPLY ? "write" : "would"} Detonate fd_victim category enemy -> party`);
      if (APPLY) { r.category = "party"; await db.put(DET_KEY, it);
        const back = Object.values((await db.get(DET_KEY)).system.props.effect_table).find((x) => x?.effect_label === "fd_victim");
        if (back.category !== "party") throw new Error("Detonate read-back " + back.category); }
    }
  } finally { await db.close(); }
  console.log(APPLY ? "done" : "dry run — pass --apply to write");
})().catch((e) => { console.error(e.message); process.exit(1); });
