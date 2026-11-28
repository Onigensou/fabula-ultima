// node scripts/action-reader/field-object.test.mjs
// Field objects (Deva's Missile Fists): AI actions that deal no damage never pick them; damaging ones may.
const { actionDealsDamage, isFieldObjectActor } = await import("./actionReader-buildAndPickTargets.js");
let failed = 0;
function check(label, got, expected) { const ok = got === expected; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${got}${ok ? "" : ` (expected ${expected})`}`); }
const NS = "fabula-ultima-companion";
check("Attack deals damage", actionDealsDamage({ skill_type: "Attack" }), true);
check("offensive spell deals damage", actionDealsDamage({ skill_type: "Spell", isOffensiveSpell: true }), true);
check("Active with a deal_damage row deals damage", actionDealsDamage({ skill_type: "Active", effect_table: { 0: { effect_kind: "deal_damage" } } }), true);
check("Element Gorge (Active, check, no damage row) deals none", actionDealsDamage({ skill_type: "Active", isCheck: true, effect_table: { 0: { effect_kind: "apply_ae" } } }), false);
check("a deleted damage row does not count", actionDealsDamage({ skill_type: "Active", effect_table: { 0: { effect_kind: "deal_damage", $deleted: true } } }), false);
check("heal spell deals none", actionDealsDamage({ skill_type: "Spell", isOffensiveSpell: false }), false);
check("no props = none", actionDealsDamage(null), false);
check("fist flag read", isFieldObjectActor({ flags: { [NS]: { fieldObject: true } } }), true);
check("plain actor", isFieldObjectActor({ flags: {} }), false);
console.log(failed ? `${failed} failed` : "all passed");
if (failed) process.exit(1);
