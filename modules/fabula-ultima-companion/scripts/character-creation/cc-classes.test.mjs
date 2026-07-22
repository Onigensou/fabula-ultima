/**
 * Class/skill spend rules.
 *
 * These mirror levelup-api's `validateSpend` plus the creation-only class-count
 * rule. The GM re-checks all of them at finalize, so a miss here is a bad
 * experience rather than a corrupt actor — but the whole point of the step is
 * that the player is never told "no" only at the very end.
 *
 * cc-step-classes now borrows levelup-app's renderers, and that module
 * registers hooks at load, so the stub has to be in place before the import.
 * Nothing below calls into the renderers — these are the step's own rule
 * functions, which take a draft and a class record and touch no globals.
 */
globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game = { actors: [], items: [], folders: [], users: [], user: { id: "u1", name: "Oni" } };
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };

const C = await import("./cc-step-classes.js");
const D = await import("./cc-draft.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

// ── fixtures shaped like class-registry output ─────────────────────────────

const skill = (name, maxLevel = 5, facetGrant = 0) => ({
  uuid: `Item.${name}`, name, img: "", maxLevel, facetGrant, description: "",
});
const facet = (name) => ({ uuid: `Item.f-${name}`, name });

/** A class whose benefit is fixed by the rulebook. */
const fixed = {
  key: "guardian", name: "Guardian", img: "", folder: "Classic Classes", benefit: "hp",
  free: { martialArmor: true, martialShield: true },
  skills: [skill("Bodyguard"), skill("Fortress", 10), skill("Dual Shieldbearer", 1)],
  facets: [],
};
/** A class that lets the player pick, and that grants facets. */
const chooser = {
  key: "elementalist", name: "Elementalist", img: "", folder: "Classic Classes", benefit: null,
  free: { ritual: true },
  skills: [skill("Elemental Magic", 10, 2), skill("Spellblade")],
  facets: [facet("Flare"), facet("Aura"), facet("Glacial Breath"), facet("Thunderbolt")],
};

const mk = (level = 5) => { const d = D.createDraft(); d.attributes.level = level; return d; };
const spend = (d, cls, s, opts) => C.applySpend(d, cls, cls.skills.find((x) => x.name === s), opts);
const sk = (cls, name) => cls.skills.find((x) => x.name === name);

// ── counting ───────────────────────────────────────────────────────────────
{
  const d = mk(5);
  spend(d, fixed, "Bodyguard"); spend(d, fixed, "Bodyguard"); spend(d, fixed, "Fortress");
  eq("class level counts every pick", C.classLevelIn(d, "guardian"), 3);
  eq("skill level counts only that skill", C.skillLevelIn(d, sk(fixed, "Bodyguard").uuid), 2);
  eq("untouched class is level 0", C.classLevelIn(d, "elementalist"), 0);
  eq("points spent tracks picks", D.draftPointsSpent(d), 3);
  eq("points left is pool minus picks", D.draftPointsLeft(d), 2);
}

// ── the pool ───────────────────────────────────────────────────────────────
{
  const d = mk(5);
  for (let i = 0; i < 5; i++) spend(d, fixed, "Fortress");
  eq("spending the pool blocks the next pick",
    C.canSpend(d, fixed, sk(fixed, "Bodyguard")).ok, false);
  eq("...and says why", C.canSpend(d, fixed, sk(fixed, "Bodyguard")).reason, "No Skill Points left.");
}

// ── caps ───────────────────────────────────────────────────────────────────
{
  const d = mk(20);
  for (let i = 0; i < 10; i++) spend(d, fixed, "Fortress");
  eq("class stops at 10", C.canSpend(d, fixed, sk(fixed, "Bodyguard")).ok, false);
  eq("mastered class is named in the reason",
    C.canSpend(d, fixed, sk(fixed, "Bodyguard")).reason, "Guardian is already mastered.");
}
{
  const d = mk(20);
  spend(d, fixed, "Dual Shieldbearer");                    // maxLevel 1
  eq("skill stops at its own max", C.canSpend(d, fixed, sk(fixed, "Dual Shieldbearer")).ok, false);
  eq("a sibling skill is still open", C.canSpend(d, fixed, sk(fixed, "Bodyguard")).ok, true);
}

// ── three unmastered classes ───────────────────────────────────────────────
{
  const three = [
    { ...fixed, key: "a", name: "A" }, { ...fixed, key: "b", name: "B" }, { ...fixed, key: "c", name: "C" },
  ];
  const d = mk(20);
  for (const c of three) spend(d, c, "Bodyguard");
  eq("three unmastered blocks a fourth class", C.canSpend(d, chooser, sk(chooser, "Spellblade")).ok, false);
  eq("existing classes stay open", C.canSpend(d, three[0], sk(three[0], "Fortress")).ok, true);

  // Mastering one frees the slot — the rule counts unmastered, not total.
  for (let i = 0; i < 9; i++) spend(d, three[0], "Fortress");
  eq("class A reached 10", C.classLevelIn(d, "a"), 10);
  eq("mastering frees a slot", C.canSpend(d, chooser, sk(chooser, "Spellblade")).ok, true);
}

// ── the starting 2-3 rule, level-gated (user decision 5) ───────────────────
{
  const three = [
    { ...fixed, key: "a", name: "A" }, { ...fixed, key: "b", name: "B" }, { ...fixed, key: "c", name: "C" },
  ];
  const d = mk(5);
  for (const c of three) spend(d, c, "Bodyguard");
  eq("below level 10, a fourth class is blocked",
    C.canSpend(d, chooser, sk(chooser, "Spellblade")).ok, false);

  // The floor is a validation concern, not a spend concern: a build in progress
  // is legitimately below two classes.
  const solo = mk(5);
  spend(solo, fixed, "Bodyguard");
  eq("one class mid-build is a legal spend state",
    C.canSpend(solo, fixed, sk(fixed, "Fortress")).ok, true);
  for (let i = 0; i < 4; i++) spend(solo, fixed, "Fortress");
  eq("...but validation rejects it once the pool is spent",
    D.validateStep(solo, "classes").issues.map((i) => i.code), ["too_few_classes"]);

  // At 10+ mastery is possible, so mono-class must pass.
  const mono = mk(10);
  for (let i = 0; i < 10; i++) spend(mono, fixed, "Fortress");
  eq("mono-class is legal at level 10", D.validateStep(mono, "classes").issues.map((i) => i.code), []);
}

// ── benefits ───────────────────────────────────────────────────────────────
{
  const d = mk(10);
  eq("a fixed-benefit class asks nothing", C.needsBenefit(d, fixed), false);
  eq("a chooser asks on the first level", C.needsBenefit(d, chooser), true);
  spend(d, chooser, "Spellblade", { benefit: "mp" });
  eq("...and never again", C.needsBenefit(d, chooser), false);
  eq("the choice is recorded", d.classes[0].benefit, "mp");

  spend(d, fixed, "Bodyguard");
  eq("a fixed benefit is carried without asking", d.classes[1].benefit, "hp");
}

// ── facets ─────────────────────────────────────────────────────────────────
{
  const d = mk(10);
  const em = sk(chooser, "Elemental Magic");
  eq("grant count comes from the skill", C.facetNeed(d, chooser, em).need, 2);
  eq("all four start available", C.facetNeed(d, chooser, em).available.length, 4);
  eq("a non-granting skill needs none", C.facetNeed(d, chooser, sk(chooser, "Spellblade")).need, 0);

  spend(d, chooser, "Elemental Magic", { benefit: "mp", facetUuids: ["Item.f-Flare", "Item.f-Aura"] });
  const after = C.facetNeed(d, chooser, em);
  eq("learned facets drop out of the pool", after.available.map((f) => f.name),
    ["Glacial Breath", "Thunderbolt"]);
  eq("the need does not shrink with the pool", after.need, 2);

  spend(d, chooser, "Elemental Magic",
    { facetUuids: ["Item.f-Glacial Breath", "Item.f-Thunderbolt"] });
  eq("an exhausted pool offers nothing", C.facetNeed(d, chooser, em).available.length, 0);
}

// ── removal is last-in-first-out ───────────────────────────────────────────
{
  const d = mk(10);
  spend(d, chooser, "Elemental Magic", { benefit: "hp", facetUuids: ["Item.f-Flare"] });
  spend(d, chooser, "Elemental Magic", { benefit: "hp", facetUuids: ["Item.f-Aura"] });
  eq("removes the most recent level", C.removeLast(d, sk(chooser, "Elemental Magic").uuid), true);
  eq("...leaving the earlier one intact", d.classes.map((c) => c.facetUuids), [["Item.f-Flare"]]);
  eq("removing an unheld skill is a no-op", C.removeLast(d, "Item.nope"), false);
  eq("the point comes back", D.draftPointsLeft(d), 9);
}

// ── lowering the level trims from the end (reconcile contract) ─────────────
{
  const d = mk(10);
  for (let i = 0; i < 8; i++) spend(d, fixed, "Fortress");
  spend(d, chooser, "Spellblade", { benefit: "ip" });
  d.attributes.level = 5;
  const { trimmed } = D.reconcile(d);
  eq("pool shrinks to the new level", D.draftPointPool(d), 5);
  eq("picks are cut to fit", d.classes.length, 5);
  eq("the earliest decisions survive", d.classes.every((c) => c.classKey === "guardian"), true);
  eq("the trim is reported", trimmed.length > 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
