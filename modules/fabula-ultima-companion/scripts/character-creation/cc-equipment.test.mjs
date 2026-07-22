/**
 * Equipment picking: budget arithmetic, slot limits, martial advisories.
 *
 * Fixtures are transcribed from the world's actual Basic Weapon / Basic Armor /
 * Basic Shield items (costs and martial flags read out of LevelDB), so the
 * budget numbers here are the ones a player will really see.
 */
const E = await import("./cc-step-equipment.js");
const D = await import("./cc-draft.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

// ── real items from the world ──────────────────────────────────────────────
const W = (name, cost, martial, hands, range, cat) => ({
  uuid: `Item.${name}`, id: name, name, img: "", slot: "weapon",
  cost, isMartial: martial, itemType: "weapon", handSlots: hands, range, category: cat,
});
const A = (name, cost, martial) => ({
  uuid: `Item.${name}`, id: name, name, img: "", slot: "armor",
  cost, isMartial: martial, itemType: "armor", handSlots: "One-handed", range: "", category: "",
});
const S = (name, cost, martial) => ({
  uuid: `Item.${name}`, id: name, name, img: "", slot: "shield",
  cost, isMartial: martial, itemType: "shield", handSlots: "One-handed", range: "", category: "",
});

const bronzeSword = W("Bronze Sword", 200, true,  "One-handed", "Melee",  "Sword");
const rapier      = W("Rapier",       200, false, "One-handed", "Melee",  "Sword");
const greatsword  = W("Greatsword",   200, true,  "Two-handed", "Melee",  "Sword");
const shortbow    = W("Shortbow",     200, false, "Two-handed", "Ranged", "Bow");
const unarmed     = W("Unarmed Strike", 0, false, "One-handed", "Melee",  "Brawling");
const steelPlate  = A("Steel Plate",  300, false);
const runicPlate  = A("Runic Plate",  250, true);
const travelGarb  = A("Travel Garb",  100, false);
const bronzeShield= S("Bronze Shield",100, false);
const runicShield = S("Runic Shield", 150, true);

const mk = (level = 5) => { const d = D.createDraft(); d.attributes.level = level; return d; };
const NONE = { melee: false, ranged: false, armor: false, shield: false };
const ALL  = { melee: true,  ranged: true,  armor: true,  shield: true };

// ── budget ─────────────────────────────────────────────────────────────────
{
  const d = mk(5);
  eq("level 5 budget", D.draftBudget(d), 500);
  eq("nothing spent yet", D.draftSpend(d), 0);
  E.addPick(d, bronzeSword); E.addPick(d, travelGarb);
  eq("spend is the sum of picks", D.draftSpend(d), 300);
  eq("remaining is budget minus spend", D.draftBudgetLeft(d), 200);

  E.addPick(d, bronzeShield);
  eq("still inside budget", D.draftBudgetLeft(d), 100);
  eq("no over-budget issue", D.validateStep(d, "equipment").issues, []);
}
{
  // Going over is allowed by the picker and caught by validation, so the player
  // can rearrange rather than face a picker that has silently gone dead.
  const d = mk(5);
  E.addPick(d, steelPlate); E.addPick(d, greatsword);
  eq("the picker permits an over-budget buy", E.canAdd(d, bronzeShield).ok, true);
  E.addPick(d, bronzeShield);
  eq("over budget by the right amount", D.draftBudgetLeft(d), -100);
  eq("validation flags it",
    D.validateStep(d, "equipment").issues.map((i) => i.code), ["over_budget"]);
  eq("...with the amount in the message",
    /100 zenit/.test(D.validateStep(d, "equipment").issues[0].message), true);
}
{
  const d = mk(15);
  eq("higher level buys a bigger budget", D.draftBudget(d), 500 + 10 * 50);
  const d40 = mk(40);
  eq("budget scales linearly", D.draftBudget(d40), 500 + 35 * 50);
}

// ── slot limits ────────────────────────────────────────────────────────────
{
  const d = mk(20);
  E.addPick(d, steelPlate);
  eq("only one suit of armor", E.canAdd(d, travelGarb).ok, false);
  eq("...and it says so", /Only 1 armor/.test(E.canAdd(d, travelGarb).reason), true);

  E.addPick(d, bronzeShield);
  eq("only one shield", E.canAdd(d, runicShield).ok, false);

  eq("weapons stack", E.canAdd(d, bronzeSword).ok, true);
  E.addPick(d, bronzeSword);
  eq("a second weapon is fine", E.canAdd(d, rapier).ok, true);
  E.addPick(d, rapier);
  eq("weapon count is unbounded", E.countIn(d, "weapon"), 2);

  eq("the same item cannot be bought twice", E.canAdd(d, bronzeSword).ok, false);
  eq("...and it says so", E.canAdd(d, bronzeSword).reason, "Already chosen.");

  // Dropping the armour reopens the slot.
  eq("drop reports success", E.removePick(d, steelPlate.uuid), true);
  eq("the armor slot reopens", E.canAdd(d, travelGarb).ok, true);
  eq("dropping something unheld is a no-op", E.removePick(d, "Item.nope"), false);
}

// ── which martial right an item needs ──────────────────────────────────────
eq("non-martial gear needs nothing",       E.martialNeed(rapier), null);
eq("a martial melee weapon needs melee",   E.martialNeed(bronzeSword), "melee");
eq("range decides the weapon right",       E.martialNeed(W("X", 0, true, "Two-handed", "Ranged", "Bow")), "ranged");
eq("martial armor needs the armor right",  E.martialNeed(runicPlate), "armor");
eq("martial shields need the shield right", E.martialNeed(runicShield), "shield");

// ── advisories ─────────────────────────────────────────────────────────────
{
  const d = mk(20);
  E.addPick(d, bronzeSword); E.addPick(d, runicPlate);
  const untrained = E.advisories(d, NONE);
  eq("untrained martial gear is flagged, both pieces",
    untrained.filter((a) => /will be carried, not equipped/.test(a)).length, 2);
  eq("the weapon names the melee right",
    untrained.some((a) => /Bronze Sword needs martial melee weapons/.test(a)), true);
  eq("the armor names the armor right",
    untrained.some((a) => /Runic Plate needs martial armor/.test(a)), true);
  eq("training silences the flag",
    E.advisories(d, ALL).filter((a) => /not equipped/.test(a)).length, 0);
}
{
  // Buying nothing is legal but worth saying out loud.
  const d = mk(5);
  const adv = E.advisories(d, ALL);
  eq("bare hands are called out", adv.some((a) => /fight unarmed/.test(a)), true);
  eq("no armor is called out",   adv.some((a) => /No armor chosen/.test(a)), true);
  eq("an empty cart is still valid", D.validateStep(d, "equipment").issues, []);

  E.addPick(d, unarmed); E.addPick(d, travelGarb);
  const adv2 = E.advisories(d, ALL);
  eq("filling both slots clears both notes",
    adv2.some((a) => /fight unarmed|No armor chosen/.test(a)), false);
}
{
  // Two-handed weapon plus shield: legal to own, impossible to use together.
  const d = mk(20);
  E.addPick(d, greatsword); E.addPick(d, bronzeShield);
  eq("the two-handed clash is flagged",
    E.advisories(d, ALL).some((a) => /Greatsword is two-handed/.test(a)), true);

  const solo = mk(20);
  E.addPick(solo, greatsword); E.addPick(solo, travelGarb);
  eq("a two-handed weapon alone is fine",
    E.advisories(solo, ALL).some((a) => /two-handed/.test(a)), false);

  const oneH = mk(20);
  E.addPick(oneH, bronzeSword); E.addPick(oneH, bronzeShield); E.addPick(oneH, travelGarb);
  eq("one-handed plus shield is fine",
    E.advisories(oneH, ALL).some((a) => /two-handed/.test(a)), false);
}

// ── free items do not consume budget ───────────────────────────────────────
{
  const d = mk(5);
  E.addPick(d, unarmed);
  eq("a 0z item costs nothing", D.draftSpend(d), 0);
  eq("...and leaves the budget whole", D.draftBudgetLeft(d), 500);
}

// ── readEquip normalises CSB's string cost ─────────────────────────────────
{
  const item = {
    uuid: "Item.abc", id: "abc", name: "Bronze Sword", img: "x.png",
    system: { props: {
      item_cost: "200", isMartial: true, item_type: "weapon",
      hand_slots: "One-handed", weapon_range: "Melee", category: "Sword",
    } },
  };
  const rec = E.readEquip(item, "weapon");
  eq("cost becomes a number", rec.cost, 200);
  eq("cost is not a string", typeof rec.cost, "number");
  eq("martial flag survives", rec.isMartial, true);
  eq("weapons keep their category", rec.category, "Sword");

  // Armour and shields all carry category "Arcane" in this world, which is an
  // unset default rather than a fact — it must not leak into the UI.
  const armor = E.readEquip({ ...item, name: "Steel Plate",
    system: { props: { item_cost: "300", item_type: "armor", category: "Arcane" } } }, "armor");
  eq("armor category is dropped", armor.category, "");
  eq("a missing cost reads as 0", E.readEquip({ system: { props: {} } }, "armor").cost, 0);
  eq("a missing martial flag is false", E.readEquip({ system: { props: {} } }, "armor").isMartial, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
