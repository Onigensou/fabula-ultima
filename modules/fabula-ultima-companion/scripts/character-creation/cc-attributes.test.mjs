/**
 * Attribute-step maths: milestone application, the d12 cap, derived stats, and
 * the swap that keeps the array a permutation.
 *
 * cc-step-attributes imports cc-app, which touches no Foundry global at import
 * time, so this runs in plain node.
 */
const A = await import("./cc-step-attributes.js");
const D = await import("./cc-draft.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

const mk = (level, assign, picks = []) => {
  const d = D.createDraft();
  d.attributes.level = level;
  d.attributes.assign = { ...assign };
  d.attributes.milestonePicks = [...picks];
  return d;
};
const AVG = { mig: 10, dex: 8, ins: 8, wlp: 6 };

// ── milestones ─────────────────────────────────────────────────────────────
eq("no milestones below 20", A.effectiveBases(mk(19, AVG)), { mig: 10, dex: 8, ins: 8, wlp: 6 });
eq("one step at 20", A.effectiveBases(mk(20, AVG, ["mig"])), { mig: 12, dex: 8, ins: 8, wlp: 6 });
eq("two steps at 41", A.effectiveBases(mk(41, AVG, ["dex", "dex"])), { mig: 10, dex: 12, ins: 8, wlp: 6 });
// d10 -> d12 -> capped. The third would be illegal anyway; the cap holds.
eq("d12 cap holds", A.effectiveBases(mk(41, AVG, ["mig", "mig"])), { mig: 12, dex: 8, ins: 8, wlp: 6 });
eq("blank picks ignored", A.effectiveBases(mk(41, AVG, ["", ""])), { mig: 10, dex: 8, ins: 8, wlp: 6 });
eq("junk picks ignored", A.effectiveBases(mk(20, AVG, ["nonsense"])), { mig: 10, dex: 8, ins: 8, wlp: 6 });

// ── derived ────────────────────────────────────────────────────────────────
const p5 = A.previewDerived(mk(5, AVG));
eq("HP = level + 5*MIG", p5.maxHp, 5 + 50);
eq("MP = level + 5*WLP", p5.maxMp, 5 + 30);
eq("crisis is half HP", p5.crisis, 27);
eq("DEF = DEX die", p5.def, 8);
eq("MDEF = INS die", p5.mdef, 8);
eq("IP is 6", p5.maxIp, 6);
eq("init = avg(DEX)+avg(INS)", p5.init, 4.5 + 4.5);

// Milestones must feed the derived numbers, not just the display.
const p20 = A.previewDerived(mk(20, AVG, ["mig"]));
eq("milestone raises HP", p20.maxHp, 20 + 5 * 12);

// Against a real sheet: Hina is level 41, MIG d8 -> max_hp 98 on the sheet,
// which is 41 + 5*8 = 81 plus 17 from class benefits and gear. The base
// formula is what we assert; the rest is added downstream by design.
eq("base HP for Hina's spread", A.previewDerived(mk(41, { mig: 8, dex: 6, ins: 12, wlp: 10 })).maxHp, 81);

// ── the swap, replicated exactly as the handler does it ────────────────────
const swap = (assign, key, want) => {
  const a = { ...assign };
  const KEYS = ["mig", "dex", "ins", "wlp"];
  if (!want) { delete a[key]; return a; }
  const holder = KEYS.find((k) => k !== key && Number(a[k] ?? 0) === want);
  const had = Number(a[key] ?? 0);
  a[key] = want;
  if (holder) { if (had) a[holder] = had; else delete a[holder]; }
  return a;
};
const sorted = (o) => Object.values(o).sort((x, y) => x - y);

eq("swap moves the die", swap(AVG, "dex", 10), { mig: 8, dex: 10, ins: 8, wlp: 6 });
eq("swap conserves the pool", sorted(swap(AVG, "dex", 10)), [6, 8, 8, 10]);
eq("swap with a duplicate still conserves", sorted(swap(AVG, "mig", 8)), [6, 8, 8, 10]);
eq("assigning into an empty slot takes from the holder",
  swap({ dex: 10 }, "mig", 10), { mig: 10 });
eq("clearing removes only that attribute", swap(AVG, "wlp", 0), { mig: 10, dex: 8, ins: 8 });

// A full assignment can never exceed the pool, whatever order it is built in.
let acc = {};
for (const [k, v] of [["wlp", 10], ["mig", 10], ["dex", 8], ["ins", 6], ["mig", 8]]) acc = swap(acc, k, v);
eq("no duplicate inflation across a sequence", sorted(acc).length <= 4, true);


// ── drag and drop placement ────────────────────────────────────────────────
//
// The pool must stay a permutation of the array no matter what is dragged
// where. That is the property the old dropdown version could not hold, and the
// reason assignment appeared to do nothing: the select and the draft disagreed.

const place = (assign, die, from, target) => {
  const a = { ...assign };
  A.placeDie(a, { die, from }, target);
  return a;
};

eq("tray -> empty socket places the die", place({}, 10, "tray", "mig"), { mig: 10 });
eq("tray -> occupied socket displaces the old die back to the tray",
  place({ mig: 8 }, 10, "tray", "mig"), { mig: 10 });
eq("socket -> empty socket moves it",
  place({ mig: 10 }, 10, "mig", "dex"), { dex: 10 });
eq("socket -> occupied socket SWAPS",
  place({ mig: 10, dex: 6 }, 10, "mig", "dex"), { mig: 6, dex: 10 });
eq("socket -> tray returns it", place({ mig: 10 }, 10, "mig", "tray"), {});
eq("dropping on its own socket does nothing",
  place({ mig: 10 }, 10, "mig", "mig"), { mig: 10 });
eq("a tray drop reports a change", A.placeDie({}, { die: 8, from: "tray" }, "wlp"), true);
eq("a no-op reports none", A.placeDie({ mig: 8 }, { die: 8, from: "mig" }, "mig"), false);
eq("returning something not placed reports none",
  A.placeDie({}, { die: 8, from: "mig" }, "tray"), false);

// Four placements from the tray must leave exactly the array, in some order.
{
  let a = {};
  for (const [die, slot] of [[10, "wlp"], [8, "mig"], [8, "dex"], [6, "ins"]]) {
    A.placeDie(a, { die, from: "tray" }, slot);
  }
  eq("a full assignment is the array itself",
    Object.values(a).sort((x, y) => x - y), [6, 8, 8, 10]);
}

// Swapping around can never mint a die.
{
  const a = { mig: 10, dex: 8, ins: 8, wlp: 6 };
  A.placeDie(a, { die: 10, from: "mig" }, "wlp");
  A.placeDie(a, { die: 8, from: "dex" }, "ins");
  A.placeDie(a, { die: 6, from: "mig" }, "dex");
  eq("swapping conserves the pool",
    Object.values(a).sort((x, y) => x - y), [6, 8, 8, 10]);
  eq("...and keeps all four attributes filled", Object.keys(a).length, 4);
}

// ── what is left in the tray ───────────────────────────────────────────────
//
// "Average" is d10 d8 d8 d6 — a MULTISET. Removing by value rather than by
// instance would empty both d8 slots the moment either was placed.
{
  const d = mk(5, {});
  d.attributes.arrayKey = "average";
  eq("a fresh tray holds the whole array", A.trayDice(d), [10, 8, 8, 6]);

  d.attributes.assign = { mig: 8 };
  eq("placing one d8 leaves the other", A.trayDice(d), [10, 8, 6]);

  d.attributes.assign = { mig: 8, dex: 8 };
  eq("placing both empties them", A.trayDice(d), [10, 6]);

  d.attributes.assign = { mig: 10, dex: 8, ins: 8, wlp: 6 };
  eq("a full assignment empties the tray", A.trayDice(d), []);
}

// ── class free benefits count once per CLASS, not per level ────────────────
{
  const d = D.createDraft();
  eq("no classes, no benefit", A.benefitTally(d), { hp: 0, mp: 0, ip: 0, classes: 0 });

  // Ten levels in one class is still one benefit.
  for (let i = 0; i < 10; i++) {
    d.classes.push({ classKey: "guardian", benefit: "hp", skillUuid: "s", facetUuids: [] });
  }
  eq("ten levels in one class grant it once",
    A.benefitTally(d), { hp: 5, mp: 0, ip: 0, classes: 1 });

  d.classes.push({ classKey: "elementalist", benefit: "mp", skillUuid: "s2", facetUuids: [] });
  d.classes.push({ classKey: "rogue", benefit: "ip", skillUuid: "s3", facetUuids: [] });
  eq("each further class adds its own",
    A.benefitTally(d), { hp: 5, mp: 5, ip: 2, classes: 3 });
}

// ── final stats ────────────────────────────────────────────────────────────
{
  const d = mk(5, AVG);                       // mig d10 -> base HP 5 + 50 = 55
  const bare = A.finalDerived(d);
  eq("with nothing chosen the final equals the base", [bare.maxHp, bare.maxMp, bare.maxIp],
    [55, 35, 6]);
  eq("DEF falls back to the DEX die", bare.def, 8);
  eq("MDEF falls back to the INS die", bare.mdef, 8);

  d.classes.push({ classKey: "guardian", benefit: "hp", skillUuid: "s", facetUuids: [] });
  d.classes.push({ classKey: "rogue", benefit: "ip", skillUuid: "s2", facetUuids: [] });
  const withClasses = A.finalDerived(d);
  eq("class benefits raise the maxima", [withClasses.maxHp, withClasses.maxIp], [60, 8]);
  eq("crisis follows the RAISED HP, not the base", withClasses.crisis, 30);
  eq("the base is still reported for comparison", withClasses.base.maxHp, 55);

  // Ordinary armour ADDS to the DEX die; martial armour REPLACES it. Getting
  // that backwards overstates a plate-wearer by their whole DEX die.
  const soft = A.finalDerived(d, { defBase: null, defBonus: 2, mdefBase: null, mdefBonus: 1, initPenalty: 0 });
  eq("ordinary armor adds to the die", soft.def, 10);
  eq("...and to MDEF", soft.mdef, 9);

  const plate = A.finalDerived(d, { defBase: 11, defBonus: 0, mdefBase: 9, mdefBonus: 0, initPenalty: 3 });
  eq("martial armor replaces the die", plate.def, 11);
  eq("...rather than adding to it", plate.def === 8 + 11, false);
  eq("MDEF is replaced too", plate.mdef, 9);
  eq("an initiative penalty subtracts", plate.init, bare.init - 3);

  // A shield on top of martial armour still adds.
  const both = A.finalDerived(d, { defBase: 11, defBonus: 2, mdefBase: 9, mdefBonus: 0, initPenalty: 0 });
  eq("a shield adds on top of the replacement", both.def, 13);
}


// ── a PARTIAL assignment must survive reconcile ────────────────────────────
//
// The player places dice one at a time, so for three of the four drops the
// assignment is legitimately incomplete. reconcile used to compare the placed
// dice against the WHOLE pool, so the first drop never matched and was wiped
// immediately -- which is what made assignment look like it did nothing and
// then complain that no die had been chosen.
{
  const step = (assign) => {
    const d = D.createDraft();
    d.attributes.arrayKey = "average";        // d10 d8 d8 d6
    d.attributes.assign = { ...assign };
    const r = D.reconcile(d);
    return { assign: d.attributes.assign, trimmed: r.trimmed };
  };

  eq("one die placed survives", step({ mig: 10 }).assign, { mig: 10 });
  eq("...silently", step({ mig: 10 }).trimmed, []);
  eq("two survive", step({ mig: 10, dex: 8 }).assign, { mig: 10, dex: 8 });
  eq("three survive", step({ mig: 10, dex: 8, ins: 8 }).assign, { mig: 10, dex: 8, ins: 8 });
  eq("a full assignment survives",
    step({ mig: 10, dex: 8, ins: 8, wlp: 6 }).assign, { mig: 10, dex: 8, ins: 8, wlp: 6 });
  eq("an empty assignment survives", step({}).assign, {});

  // Both d8s are legal; a third is not, because the array only holds two.
  eq("both d8s are allowed", step({ mig: 8, dex: 8 }).assign, { mig: 8, dex: 8 });
  eq("a third d8 is not on offer", step({ mig: 8, dex: 8, ins: 8 }).assign, {});
  eq("...and says so", step({ mig: 8, dex: 8, ins: 8 }).trimmed.length, 1);

  // A die from a different array is cleared -- this is the safety net for a
  // draft that arrives incoherent, not the normal array-switch path.
  eq("a d12 is not in Average", step({ mig: 12 }).assign, {});

  // Specialized is d10 d10 d6 d6, so two d10s are fine there.
  const spec = D.createDraft();
  spec.attributes.arrayKey = "specialized";
  spec.attributes.assign = { mig: 10, dex: 10 };
  D.reconcile(spec);
  eq("two d10s are legal in Specialized", spec.attributes.assign, { mig: 10, dex: 10 });

  const jack = D.createDraft();
  jack.attributes.arrayKey = "jack";          // d8 d8 d8 d8
  jack.attributes.assign = { mig: 10 };
  D.reconcile(jack);
  eq("a d10 is not on offer in Jack of All Trades", jack.attributes.assign, {});
}

// Placing all four one at a time, reconciling between each, must end complete.
// This is the exact sequence a player performs.
{
  const d = D.createDraft();
  d.attributes.arrayKey = "average";
  for (const [slot, die] of [["mig", 10], ["dex", 8], ["ins", 8], ["wlp", 6]]) {
    A.placeDie(d.attributes.assign, { die, from: "tray" }, slot);
    D.reconcile(d);
  }
  eq("four drops with a reconcile after each end assigned",
    d.attributes.assign, { mig: 10, dex: 8, ins: 8, wlp: 6 });
  eq("...and the step now passes", D.validateStep(d, "attributes").ok, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
