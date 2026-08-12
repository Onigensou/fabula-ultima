import {
  EMPTY_GM_OVERRIDE, GM_DIE_SIZES, normalizeGmOverride, isGmOverrideEmpty, mergeGmOverride,
  composeGmRoll, gmDamageInput, applyGmDamageInput, composeGmDefenseOverrides, gmHitOverrideMap,
  applyGmDamageOverrides, recomputeHitTokenUuids, gmOverrideDeltaRows, describeGmEditors,
  summarizeGmOverride, isGmEditableRow,
} from "./gm-card-override.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const ok = (name, cond) => eq(name, !!cond, true);

const ED = { userId: "u1", userName: "Main GM", at: 1 };
const ED2 = { userId: "u2", userName: "Support GM", at: 2 };

// Stand-in for check.js deriveCheck — same contract, no Foundry needed.
const deriveCheck = ({ rA = 0, rB = 0, fumbleThreshold = 1, checkBonus = 0 } = {}) => {
  const a = Number(rA) || 0, b = Number(rB) || 0;
  const isFumble = a <= fumbleThreshold && b <= fumbleThreshold;
  return { rA: a, rB: b, hr: Math.max(a, b), total: a + b + checkBonus,
           checkBonus, isFumble, isCrit: !isFumble && a === b && a >= 6 };
};

console.log("\n— normalize / empty —");
eq("null is empty", isGmOverrideEmpty(null), true);
eq("EMPTY const is empty", isGmOverrideEmpty(EMPTY_GM_OVERRIDE), true);
eq("all-null roll normalizes to null", normalizeGmOverride({ roll: { rA: null, dA: null } }).roll, null);
eq("junk keys dropped", "evil" in normalizeGmOverride({ evil: 1 }), false);
eq("non-numeric dice dropped", normalizeGmOverride({ roll: { rA: "abc" } }).roll, null);
eq("floats truncated", normalizeGmOverride({ roll: { rA: 5.9 } }).roll, { rA: 5 });
eq("bogus die size rejected", normalizeGmOverride({ roll: { dA: 7, rA: 3 } }).roll, { rA: 3 });
eq("valid die size kept", normalizeGmOverride({ roll: { dA: 10, rA: 3 } }).roll, { dA: 10, rA: 3 });
eq("die sizes offered", GM_DIE_SIZES.includes(12) && GM_DIE_SIZES.includes(6), true);
eq("useHR:false is KEPT (not falsy-dropped)",
  normalizeGmOverride({ damage: { useHR: false } }).damage, { useHR: false });
eq("hit:false is KEPT", normalizeGmOverride({ perTarget: { t1: { hit: false } } }).perTarget, { t1: { hit: false } });
eq("bonus 0 is a real override", normalizeGmOverride({ roll: { bonus: 0 } }).roll, { bonus: 0 });
eq("a roll-only bag is not empty", isGmOverrideEmpty({ roll: { rA: 5 } }), false);
eq("a damage-only bag is not empty", isGmOverrideEmpty({ damage: { bonus: 3 } }), false);

console.log("\n— merge semantics —");
let bag = mergeGmOverride(null, { roll: { rA: 5, dA: 8 } }, ED);
eq("set dice", bag.roll, { dA: 8, rA: 5 });
ok("editor stamped", bag.editors.length === 1 && bag.editors[0].userId === "u1");
bag = mergeGmOverride(bag, { damage: { base: 12, useHR: false } }, ED2);
eq("damage set", bag.damage, { base: 12, useHR: false });
eq("roll untouched by an unrelated patch", bag.roll, { dA: 8, rA: 5 });
ok("second editor appended", bag.editors.length === 2);
bag = mergeGmOverride(bag, { roll: { rA: null } }, ED);
eq("null CLEARS one field, leaves sibling", bag.roll, { dA: 8 });
ok("same editor not duplicated", bag.editors.filter((e) => e.userId === "u1").length === 1);
eq("reset clears everything", isGmOverrideEmpty(mergeGmOverride(bag, { reset: true }, ED)), true);
ok("reset keeps the audit trail", mergeGmOverride(bag, { reset: true }, ED).editors.length > 0);

console.log("\n— replace (the editor's Save) —");
const before = mergeGmOverride(null, { roll: { rA: 9 }, damage: { bonus: 4 }, perTarget: { t1: { hit: true } } }, ED);
const saved = mergeGmOverride(before, { replace: { roll: { rA: 3 }, damage: null, perTarget: {} } }, ED2);
eq("replace sets the new roll", saved.roll, { rA: 3 });
eq("replace CLEARS an omitted section", saved.damage, null);
eq("replace clears per-target", saved.perTarget, {});
ok("replace preserves the audit trail", saved.editors.some((e) => e.userId === "u1"));
ok("replace stamps the new editor", saved.editors.some((e) => e.userId === "u2"));
eq("saving an untouched form leaves the card unedited",
  isGmOverrideEmpty(mergeGmOverride(null, { replace: { roll: null, damage: null, perTarget: {} } }, ED)), true);
eq("a form with only per-target nulls is still empty",
  isGmOverrideEmpty(mergeGmOverride(null,
    { replace: { roll: null, damage: null, perTarget: { t1: { hit: null, damage: null, defense: null } } } }, ED)), true);

console.log("\n— roll composition (dice, not totals) —");
const ar = { roll: { rA: 4, rB: 2, dA: 8, dB: 6, checkBonus: 1, total: 7, hr: 4 } };
eq("no roll override → null", composeGmRoll(ar, EMPTY_GM_OVERRIDE, deriveCheck), null);
const r1 = composeGmRoll(ar, { roll: { rA: 6 } }, deriveCheck);
eq("edited die value", r1.rA, 6);
eq("untouched die kept as rolled", r1.rB, 2);
eq("TOTAL is re-derived, never typed", r1.total, 9);
eq("HIGHEST ROLL follows the dice", r1.hr, 6);
eq("die sizes preserved", [r1.dA, r1.dB], [8, 6]);
ok("marked as GM-authored", r1.gmSet === true);
const rCrit = composeGmRoll(ar, { roll: { rA: 7, rB: 7 } }, deriveCheck);
eq("matching high dice derive a CRIT", rCrit.isCrit, true);
const rFum = composeGmRoll(ar, { roll: { rA: 1, rB: 1 } }, deriveCheck);
eq("double ones derive a FUMBLE", rFum.isFumble, true);
eq("fumble is not also a crit", rFum.isCrit, false);
// The bonus field is an ADJUSTMENT on top of the action's own bonus (here 1),
// matching the damage adjustment — not a replacement for it.
const rBonus = composeGmRoll(ar, { roll: { bonus: 10 } }, deriveCheck);
eq("adjustment ADDS to the existing bonus", rBonus.checkBonus, 11);
eq("total = dice + existing + adjustment", rBonus.total, 4 + 2 + 11);
eq("bonus does not touch HR", rBonus.hr, 4);
const rNeg = composeGmRoll(ar, { roll: { bonus: -3 } }, deriveCheck);
eq("a NEGATIVE adjustment subtracts", rNeg.checkBonus, -2);
eq("…and lands in the total", rNeg.total, 4 + 2 - 2);
const rZero = composeGmRoll(ar, { roll: { bonus: 0, rA: 5 } }, deriveCheck);
eq("a zero adjustment leaves the existing bonus intact", rZero.checkBonus, 1);
const rNoBonus = composeGmRoll(ar, { roll: { rA: 5 } }, deriveCheck);
eq("an untouched adjustment leaves the existing bonus intact", rNoBonus.checkBonus, 1);
eq("die SIZE can be changed", composeGmRoll(ar, { roll: { dA: 12, rA: 11 } }, deriveCheck).dA, 12);

console.log("\n— damage composition (base / HR / bonus) —");
eq("no damage override → null input", gmDamageInput(EMPTY_GM_OVERRIDE), null);
eq("untouched → engine values pass through", applyGmDamageInput(null, 10, 5), { flat: 10, hr: 5 });
eq("base replaces the engine base",
  applyGmDamageInput(gmDamageInput({ damage: { base: 20 } }), 10, 5), { flat: 20, hr: 5 });
eq("bonus adds on top",
  applyGmDamageInput(gmDamageInput({ damage: { bonus: 3 } }), 10, 5), { flat: 13, hr: 5 });
eq("a NEGATIVE damage adjustment subtracts — same behaviour as accuracy",
  applyGmDamageInput(gmDamageInput({ damage: { bonus: -4 } }), 10, 5), { flat: 6, hr: 5 });
eq("adjustment applies on top of a REPLACED base",
  applyGmDamageInput(gmDamageInput({ damage: { base: 20, bonus: -4 } }), 10, 5), { flat: 16, hr: 5 });
eq("HR unchecked drops the highest roll",
  applyGmDamageInput(gmDamageInput({ damage: { useHR: false } }), 10, 5), { flat: 10, hr: 0 });
eq("HR checked keeps it",
  applyGmDamageInput(gmDamageInput({ damage: { useHR: true } }), 10, 5), { flat: 10, hr: 5 });
eq("all three together",
  applyGmDamageInput(gmDamageInput({ damage: { base: 20, bonus: 3, useHR: false } }), 10, 5), { flat: 23, hr: 0 });
eq("base 0 is a real override, not 'unset'",
  applyGmDamageInput(gmDamageInput({ damage: { base: 0 } }), 10, 5), { flat: 0, hr: 5 });

console.log("\n— per-target —");
const pts = [
  { tokenUuid: "t1", actorUuid: "a1", defense: 12, hit: false, damage: 0, affinity: "NE" },
  { tokenUuid: "t2", actorUuid: "a2", defense: 10, hit: true, damage: 20, affinity: "VU" },
];
eq("gm defense row", composeGmDefenseOverrides({ perTarget: { t1: { defense: 8 } } }, [], pts),
  [{ tokenUuid: "t1", actorUuid: "a1", from: 12, to: 8, via: "GM adjustment", gm: true }]);
eq("engine defense rows kept first",
  composeGmDefenseOverrides({ perTarget: { t1: { defense: 8 } } }, [{ tokenUuid: "t2", from: 10, to: 13 }], pts).length, 2);
eq("hit map", gmHitOverrideMap({ perTarget: { t1: { hit: true }, t2: { hit: false } } }), { t1: true, t2: false });
eq("hit map null when nothing forced", gmHitOverrideMap({ perTarget: { t1: { damage: 5 } } }), null);
eq("grant rows are not editable", isGmEditableRow({ grantAmount: 5 }), false);
eq("unstudied rows ARE editable", isGmEditableRow({ studied: false, tokenUuid: "t1" }), true);

console.log("\n— IDEMPOTENCE (the core safety claim) —");
const ov = { perTarget: { t2: { damage: 7 } } };
const once = applyGmDamageOverrides(pts, ov);
const twice = applyGmDamageOverrides(once, ov);
eq("damage set", once[1].damage, 7);
eq("untouched row is the same object", once[0], pts[0]);
eq("APPLYING TWICE == ONCE", JSON.stringify(twice), JSON.stringify(once));
eq("no override → same array reference", applyGmDamageOverrides(pts, EMPTY_GM_OVERRIDE), pts);
// The roll and damage composers are pure functions of (engine value, override),
// so re-running them on their own output must not drift either.
const rOnce = composeGmRoll(ar, { roll: { rA: 6 } }, deriveCheck);
const rTwice = composeGmRoll({ roll: rOnce }, { roll: { rA: 6 } }, deriveCheck);
eq("roll composition is idempotent", rTwice.total, rOnce.total);
eq("…and stable on HR", rTwice.hr, rOnce.hr);

console.log("\n— hit list + delta rows + summary —");
eq("hit list from final rows", recomputeHitTokenUuids(pts, null), ["t2"]);
eq("null rows → fallback preserved", recomputeHitTokenUuids(null, ["x"]), ["x"]);
eq("delta row fields", gmOverrideDeltaRows(pts, { perTarget: { t1: { hit: true, defense: 8 } } })[0].fields,
  { hit: true, damage: false, defense: true });
eq("credit line", describeGmEditors({ editors: [ED, ED2] }), "Edited by Main GM, Support GM");
eq("no editors → null", describeGmEditors(null), null);
eq("summary lists what is set",
  summarizeGmOverride({ roll: { rA: 5 }, damage: { bonus: 2 }, perTarget: { t1: { hit: true } } }),
  "accuracy · damage · 1 target");
eq("summary pluralises", summarizeGmOverride({ perTarget: { t1: { hit: true }, t2: { hit: false } } }), "2 targets");
eq("nothing set → null summary", summarizeGmOverride(null), null);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
