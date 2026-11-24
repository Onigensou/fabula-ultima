// _deva-affinity-ef — Deva form-bound affinities + weapon efficiency (2026-11-24, user approved, to-do #15).
// Fury (Strike Form): RS Light, VU Dark, attribute LIGHT. Focus (Magic Form): VU Light, RS Dark, attribute DARK.
// Guard rounds (no form AE) stay all Neutral, no attribute: g_clear_off removes the deva_offense form AE,
// and removing the AE reverts its changes. EF: spear 150, brawling 50, rest 100 (arcane untouched: spells).
// The change lives on the 4 form TEMPLATE AEs (Celestial Discipline + Enlightenment), so apply_ae copies it.
// _build-deva.js carries the same values. Game CLOSED. Dry run by default; --apply writes (backup first).
// Idempotent: a value already at its target is skipped; any other value aborts.
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const APPLY = process.argv.includes("--apply");
const A = "amxILxU7mqQ0jKhZ";
const ch = (key, value) => ({ key, mode: 5, priority: 3, value });
const FURY = { changes: [ch("affinity_8", 'aeAffinityFloor("RS")'), ch("affinity_4", 'aeAffinityFloor("VU")'), ch("attribute", "LIGHT")],
  description: "<p>Fury: her arms burn red. Resists Light. Vulnerable to Dark.</p>", was: "<p>Fury: her arms burn red.</p>" };
const FOCUS = { changes: [ch("affinity_8", 'aeAffinityFloor("VU")'), ch("affinity_4", 'aeAffinityFloor("RS")'), ch("attribute", "DARK")],
  description: "<p>Focus: her arms burn blue. Resists Dark. Vulnerable to Light.</p>", was: "<p>Focus: her arms burn blue.</p>" };
const AES = [
  ["DvDisciplineP001", "DvAeStrikeForm01", "Strike Form", FURY], ["DvDisciplineP001", "DvAeMagicForm001", "Magic Form", FOCUS],
  ["DvEnlighten00001", "DvAeEnStrikeFrm1", "Strike Form", FURY], ["DvEnlighten00001", "DvAeEnMagicFrm01", "Magic Form", FOCUS],
];
// HP 1400 -> 1550: runner 2026-11-24 (story setup, 10 fights each): 1400 median 4 rounds, 1550 median 5.
const PROPS = { spear_ef: ["100", "150"], brawling_ef: ["100", "50"], max_hp: ["1400", "1550"], current_hp: ["1400", "1550"] };
const J = (v) => JSON.stringify(v);
(async () => {
  const plan = [];
  let db = await openCollection("actors");
  try {
    const akey = `!actors!${A}`; const a = await db.get(akey);
    if (a.name !== "Deva") throw new Error(`${akey} is ${a.name}`);
    for (const [k, [from, to]] of Object.entries(PROPS)) {
      const cur = String(a.system.props[k]);
      if (cur === to) continue;
      if (cur !== from) throw new Error(`Deva ${k} is ${cur}, expected ${from}`);
      plan.push(`Deva ${k}: ${from} -> ${to}`); a.system.props[k] = to;
    }
    const writes = plan.length ? [[akey, a]] : [];
    for (const [item, id, name, T] of AES) {
      const k = `!actors.items.effects!${A}.${item}.${id}`; const e = await db.get(k);
      if (e.name !== name) throw new Error(`${k} is ${e.name}`);
      let dirty = false;
      if (J(e.changes) !== J(T.changes)) {
        if ((e.changes ?? []).length) throw new Error(`${k} already has other changes: ${J(e.changes)}`);
        plan.push(`${item}/${name}: changes [] -> ${T.changes.map((c) => `${c.key}=${c.value}`).join(", ")}`); e.changes = T.changes; dirty = true;
      }
      if (e.description !== T.description) {
        if (e.description !== T.was) throw new Error(`${k} description is ${J(e.description)}`);
        plan.push(`${item}/${name}: description -> ${T.description}`); e.description = T.description; dirty = true;
      }
      if (dirty) writes.push([k, e]);
    }
    plan.forEach((l) => console.log(`${APPLY ? "write" : "would"} ${l}`));
    if (APPLY && writes.length) {
      await db.close(); db = null;
      console.log(`backup: ${snapshotCollection("actors")}`);
      db = await openCollection("actors");
      for (const [k, v] of writes) await db.put(k, v);
    }
  } finally { if (db) await db.close(); }
  console.log(`${plan.length} change(s) ${APPLY ? "written" : "planned — pass --apply to write"}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
