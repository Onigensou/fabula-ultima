// _trio-rakshasa-final — Valley trio tuning pass 3 (2026-11-21, user approved): Rakshasa HP 1700 -> 1600 and
// stronger multi/area strikes + Devour (single-target Saber 80 / Mace 60 / Severing Verdict unchanged).
// Runner: 5.2 rounds, 745 damage to PCs a fight (was 393), lows 66-78%, 1 KO in 5, Verdict 5/6.
// Game CLOSED. Dry run by default; --apply writes. Idempotent.
const { openCollection } = require("../lib/db");
const APPLY = process.argv.includes("--apply");
const PO = "IS_SUMMON == 0 && IS_GUEST == 0";
const PLAN = [
  { actor: "Rk5haXsaDemonAAA", name: "Rakshasa", hp: [1700, 1600], items: {
    "Chakram": { damage_bonus: [35, 45] }, "Rain of Arrows": { damage_bonus: [30, 40] },
    "Executioner's Volley": { damage_bonus: [32, 42] }, "Rending Orbit": { damage_bonus: [38, 48] },
    "Devour": { damage_bonus: [65, 75], et: { dv_bite: { damage_amount: ["65", "75"] } } } } },
];
const same = (a, b) => String(a ?? "") === String(b ?? "");
const cast = (orig, v) => (typeof orig === "number" ? Number(v) : String(v));
(async () => {
  const db = await openCollection("actors");
  let n = 0;
  try {
    for (const P of PLAN) {
      const akey = `!actors!${P.actor}`; const a = await db.get(akey);
      if (a.name !== P.name) throw new Error(`${akey} is ${a.name}`);
      const [hpFrom, hpTo] = P.hp; const ap = a.system.props;
      if (!(same(ap.max_hp, hpTo) && same(ap.current_hp, hpTo))) {
        if (!same(ap.max_hp, hpFrom)) throw new Error(`${P.name} max_hp ${ap.max_hp}, expected ${hpFrom}`);
        console.log(`${APPLY ? "write" : "would"} ${P.name} HP ${ap.max_hp} -> ${hpTo}`); n++;
        if (APPLY) { ap.max_hp = String(hpTo); ap.current_hp = String(hpTo); await db.put(akey, a); }
      }
      for (const [iname, spec] of Object.entries(P.items)) {
        const ids = (a.items ?? []).map(String);
        let key = null, it = null;
        for (const id of ids) { const k = `!actors.items!${P.actor}.${id}`; const d = await db.get(k).catch(() => null); if (d?.name === iname) { key = k; it = d; break; } }
        if (!it) throw new Error(`${P.name}: no item ${iname}`);
        const p = it.system.props; let dirty = false;
        for (const [field, val] of Object.entries(spec)) {
          if (field === "et") {
            for (const [label, fields] of Object.entries(val)) {
              const row = Object.values(p.effect_table ?? {}).find((r) => r?.effect_label === label);
              if (!row) throw new Error(`${iname}: no effect row ${label}`);
              for (const [f, [from, to]] of Object.entries(fields)) {
                if (same(row[f], to)) continue;
                if (!same(row[f], from)) throw new Error(`${iname}.${label}.${f} is ${row[f]}, expected ${from}`);
                console.log(`${APPLY ? "write" : "would"} ${P.name} / ${iname} / ${label}.${f}: ${row[f]} -> ${to}`); row[f] = to; dirty = true; n++;
              }
            }
            continue;
          }
          const [from, to] = val;
          if (same(p[field], to)) continue;
          if (!same(p[field], from)) throw new Error(`${iname}.${field} is ${JSON.stringify(p[field])}, expected ${from}`);
          console.log(`${APPLY ? "write" : "would"} ${P.name} / ${iname} / ${field}: ${JSON.stringify(p[field])} -> ${JSON.stringify(to)}`);
          p[field] = field === "target_eligibility" ? to : cast(p[field], to); dirty = true; n++;
        }
        if (dirty && APPLY) await db.put(key, it);
      }
    }
  } finally { await db.close(); }
  console.log(`${n} change(s) ${APPLY ? "written" : "planned — pass --apply to write"}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
