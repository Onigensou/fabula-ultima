// ============================================================================
// AR.actorHasAffinityBuff — the detector behind `enemy_has_affinity_buff` and
// `affinity_buff_focus`.
//
//     node scripts/action-reader/affinity-buff-detect.test.mjs
//
// It decides when a strip spell (Hilde-Fafnir's Disenchant) is worth a turn.
// Every wrong answer here is a boss wasting its action or ignoring a counter:
//   - matching INNATE affinity would fire every round against a naturally
//     resistant party, and she would never pressure anyone;
//   - matching UNDISPELLABLE sources (equipment, class marks) would spend the
//     turn on something the spell cannot remove;
//   - matching only a literal "RS" would miss every real buff, since the live
//     corpus authors `aeAffinityFloor("RS")`.
// ============================================================================

const { ActionReaderCore: AR } = await import("./actionReader-core.js");

const ae = (name, tags, changes) => ({ name, disabled: false, system: { tags }, changes });
const actor = (...effects) => ({ effects, system: { props: { affinity_6: "RS", affinity_3: "NE" } } });

let failed = 0;
function check(label, a, elements, expected) {
  const got = AR.actorHasAffinityBuff(a, elements);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${got}${ok ? "" : ` (expected ${expected})`}`);
}

// The real trigger: Elemental Shroud, as authored in the world.
const shroudFire = ae("Elemental Shroud (Fire)", ["buff", "dispellable"], [{ key: "affinity_6", value: 'aeAffinityFloor("RS")' }]);
const shroudBolt = ae("Elemental Shroud (Bolt)", ["buff", "dispellable"], [{ key: "affinity_3", value: 'aeAffinityFloor("RS")' }]);
check("Elemental Shroud (Fire), asking fire,bolt", actor(shroudFire), "fire,bolt", true);
check("Elemental Shroud (Bolt), asking fire,bolt", actor(shroudBolt), "fire,bolt", true);
check("Elemental Shroud (Fire), asking bolt only", actor(shroudFire), "bolt", false);

// Innate resistance must NOT count — it lives in props, not in an effect.
check("innately Fire RS, no effects", actor(), "fire,bolt", false);

// Undispellable sources must NOT count: the spell could not remove them.
check("Ring of Magma (equipment, untagged)", actor(ae("Ring of Magma", [], [{ key: "affinity_6", value: "AB" }])), "fire,bolt", false);
check("Asura mark (tagged asura_mark)", actor(ae("Fire Mark", ["asura_mark"], [{ key: "affinity_6", value: 'aeAffinityFloor("RS")' }])), "fire,bolt", false);
check("Rampart (buff, but not dispellable)", actor(ae("Rampart", ["buff"], [{ key: "affinity_6", value: 'aeAffinityFloor("RS")' }])), "fire,bolt", false);

// Value shapes seen in the live corpus.
check("literal RS", actor(ae("X", ["dispellable"], [{ key: "affinity_3", value: "RS" }])), "bolt", true);
check("aeWhen conditional", actor(ae("Dark Blood", ["dispellable"], [{ key: "affinity_3", value: 'aeWhen("Crisis", "RS")' }])), "bolt", true);
check("immunity", actor(ae("X", ["dispellable"], [{ key: "affinity_6", value: "IM" }])), "fire", true);
check("absorb", actor(ae("X", ["dispellable"], [{ key: "affinity_6", value: "AB" }])), "fire", true);

// A dispellable effect that does NOT help against these elements is not a reason to cast.
check("VU is not protection", actor(ae("X", ["dispellable"], [{ key: "affinity_6", value: "VU" }])), "fire", false);
check("dispellable buff on another element", actor(ae("X", ["dispellable"], [{ key: "affinity_4", value: "RS" }])), "fire,bolt", false);
check("dispellable non-affinity buff", actor(ae("Haste", ["dispellable"], [{ key: "init_mod", value: "5" }])), "fire,bolt", false);

// Degenerate inputs.
check("blank element list matches nothing", actor(shroudFire), "", false);
check("unknown element name", actor(shroudFire), "plasma", false);
check("no actor", null, "fire", false);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
