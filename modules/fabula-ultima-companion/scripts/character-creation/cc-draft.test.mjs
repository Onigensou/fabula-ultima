/**
 * Exercises the pure draft/step-machine logic. No Foundry globals needed —
 * cc-draft imports only cc-const, which is dependency-free.
 */
const BASE = "./";
const D = await import(BASE + "cc-draft.js");
const C = await import(BASE + "cc-const.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

// ── budget / points / milestones ───────────────────────────────────────────
eq("budget @5", C.budgetForLevel(5), 500);
eq("budget @10", C.budgetForLevel(10), 750);
eq("budget @30", C.budgetForLevel(30), 1750);   // book's own example says 2000; formula wins
eq("points @5", C.pointsForLevel(5), 5);
eq("points @41", C.pointsForLevel(41), 41);
eq("milestones @19", C.milestonesForLevel(19), 0);
eq("milestones @20", C.milestonesForLevel(20), 1);
eq("milestones @40", C.milestonesForLevel(40), 2);
eq("class rule applies @5", C.startingClassRuleApplies(5), true);
eq("class rule off @10", C.startingClassRuleApplies(10), false);

// ── fresh draft ────────────────────────────────────────────────────────────
const d = D.createDraft();
eq("starts on profile", d.step, "profile");
eq("fresh pool", D.draftPointPool(d), 5);
eq("fresh budget", D.draftBudget(d), 500);

// ── step machine: forward only one beyond furthest seen ────────────────────
eq("reachable from fresh", D.reachableSteps(d), ["profile", "attributes"]);
eq("cannot jump to bond", D.goTo(d, "bond"), false);
eq("can step to attributes", D.goTo(d, "attributes"), true);
eq("reachable now", D.reachableSteps(d), ["profile", "attributes", "classes"]);
eq("can go back", D.goTo(d, "profile"), true);
eq("back does not shrink reach", D.reachableSteps(d).length, 3);

// ── validation ─────────────────────────────────────────────────────────────
eq("unnamed profile invalid", D.validateStep(d, "profile").ok, false);
d.profile.name = "Test Char";
eq("named profile valid", D.validateStep(d, "profile").ok, true);

eq("unassigned attrs invalid", D.validateStep(d, "attributes").ok, false);
d.attributes.arrayKey = "average";
d.attributes.assign = { mig: 10, dex: 8, ins: 8, wlp: 6 };
eq("assigned attrs valid", D.validateStep(d, "attributes").ok, true);

// ── the 2–3 class rule, on and off ─────────────────────────────────────────
const withClasses = (n, spread) => {
  const x = D.createDraft();
  x.profile.name = "T";
  x.attributes.assign = { mig: 10, dex: 8, ins: 8, wlp: 6 };
  x.attributes.level = n;
  x.classes = spread.map((k, i) => ({
    classKey: k, className: k, skillUuid: `u${i}`, skillName: `s${i}`,
    benefit: "hp", facetUuids: [],
  }));
  return x;
};
// level 5, all 5 points into one class -> too few classes
eq("1 class @5 blocked",
  D.validateStep(withClasses(5, ["a", "a", "a", "a", "a"]), "classes").issues.map(i => i.code),
  ["too_few_classes"]);
// level 5, 2 classes -> fine
eq("2 classes @5 ok",
  D.validateStep(withClasses(5, ["a", "a", "a", "b", "b"]), "classes").ok, true);
// level 5, 4 classes -> too many
eq("4 classes @5 blocked",
  D.validateStep(withClasses(5, ["a", "b", "c", "d", "d"]), "classes").issues.map(i => i.code),
  ["too_many_classes"]);
// level 10, mono-class -> allowed (mastery is reachable)
eq("1 class @10 ok",
  D.validateStep(withClasses(10, Array(10).fill("a")), "classes").ok, true);
// unspent points always flagged
eq("unspent points flagged",
  D.validateStep(withClasses(5, ["a", "b"]), "classes").issues.map(i => i.code).includes("points_unspent"),
  true);

// ── reconcile: lowering level trims from the END, keeps early picks ────────
const r = withClasses(20, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
                           "k", "l", "m", "n", "o", "p", "q", "r", "s", "t"]);
r.attributes.milestonePicks = ["mig"];
r.attributes.level = 5;
const out = D.reconcile(r);
eq("trimmed to pool", r.classes.length, 5);
eq("kept the earliest picks", r.classes.map(c => c.classKey), ["a", "b", "c", "d", "e"]);
eq("milestone picks dropped", r.attributes.milestonePicks, []);
eq("reported both trims", out.trimmed.length, 2);

// ── reconcile: array change invalidates a mismatched assignment ────────────
const r2 = D.createDraft();
r2.attributes.arrayKey = "average";
r2.attributes.assign = { mig: 10, dex: 8, ins: 8, wlp: 6 };
r2.attributes.arrayKey = "specialized";           // pool is now 10,10,6,6
D.reconcile(r2);
eq("assignment cleared on array change", r2.attributes.assign, {});

// ── reconcile: over-budget is REPORTED, never silently trimmed ─────────────
const r3 = D.createDraft();
r3.equipment.picks = [{ uuid: "x", name: "Steel Plate", cost: 300 },
                      { uuid: "y", name: "Greatsword", cost: 300 }];
eq("spend adds up", D.draftSpend(r3), 600);
const out3 = D.reconcile(r3);
eq("picks survive over-budget", r3.equipment.picks.length, 2);
eq("over-budget warned", out3.warnings.some(w => /over the new budget/.test(w)), true);
eq("equipment step invalid", D.validateStep(r3, "equipment").ok, false);

// ── bond: all-or-nothing, exactly one emotion ─────────────────────────────
const b = (bond) => { const x = D.createDraft(); x.bond = { ...x.bond, ...bond }; return D.validateStep(x, "bond"); };
eq("empty bond ok", b({}).ok, true);
eq("name without emotion blocked", b({ name: "Aria" }).issues.map(i => i.code), ["no_emotion"]);
eq("emotion without name blocked", b({ e1: "loyalty" }).issues.map(i => i.code), ["no_target"]);
eq("name + 1 emotion ok", b({ name: "Aria", e2: "loyalty" }).ok, true);
eq("two emotions blocked",
  b({ name: "Aria", e1: "admiration", e2: "loyalty" }).issues.map(i => i.code),
  ["too_many_emotions"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
