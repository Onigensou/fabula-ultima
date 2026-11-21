// _trio-damage-tune — Valley trio tuning pass 2 (2026-11-21, user approved "ship it like this").
// Runner-tested set (lean + round 2 + confirmation): Rakshasa HP 2000 -> 1700 + stronger strikes + Severing
// Verdict accuracy +8 and players-only; Deva HP 1500 -> 1400 + stronger hits + accuracy +6 + Surya Palm /
// Kala Strike players-only. Asura unchanged (1800 from _trio-hp-detonate.js).
// Game CLOSED. Dry run by default; --apply writes. Idempotent (a value already at its target is skipped).
const { openCollection } = require("../lib/db");
const APPLY = process.argv.includes("--apply");
const PO = "IS_SUMMON == 0 && IS_GUEST == 0";
const PLAN = [
  { actor: "Rk5haXsaDemonAAA", name: "Rakshasa", hp: [2000, 1700], items: {
    "Saber": { damage_bonus: [60, 80] }, "Mace": { damage_bonus: [40, 60] }, "Chakram": { damage_bonus: [20, 35] },
    "Rain of Arrows": { damage_bonus: [15, 30] }, "Executioner's Volley": { damage_bonus: [18, 32] }, "Rending Orbit": { damage_bonus: [22, 38] },
    "Devour": { damage_bonus: [45, 65], et: { dv_bite: { damage_amount: ["45", "65"] } } },
    "Severing Verdict": { check_bonus: [5, 8], target_eligibility: ["", PO] } } },
  { actor: "amxILxU7mqQ0jKhZ", name: "Deva", hp: [1500, 1400], items: {
    "Vajra Fist": { damage_bonus: [38, 52], check_bonus: [4, 6] }, "Mudra Lance": { damage_bonus: [38, 52], check_bonus: [4, 6] },
    "Double Slap": { damage_bonus: [25, 36], check_bonus: [4, 6] }, "Ground Slam": { damage_bonus: [30, 45], check_bonus: [4, 6] },
    "Fists of Fury": { damage_bonus: [28, 42], check_bonus: [4, 6] },
    "Fists of Focus": { damage_bonus: [12, 18], check_bonus: [4, 6], et: { fo_drain: { damage_amount: ["3 * (HR + 12)", "3 * (HR + 18)"] } } },
    "Surya Palm": { damage_bonus: [62, 78], check_bonus: [4, 6], target_eligibility: ["", PO] },
    "Kala Strike": { damage_bonus: [25, 38], check_bonus: [4, 6], target_eligibility: ["", PO] } } },
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
