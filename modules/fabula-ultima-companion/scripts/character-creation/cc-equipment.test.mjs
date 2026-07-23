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


// ── defence contribution ───────────────────────────────────────────────────
//
// Follows the equipment macro: MARTIAL armor REPLACES the DEX die with
// item_baseDef; ordinary armor ADDS item_def_bonus to it. Shields always add.
// Reading those two the same way would overstate a plate-wearer by their whole
// DEX die.
{
  const mkItem = (name, slot, props) => ({
    uuid: "Item." + name, id: name, name, img: "", system: { props },
  });

  const plate = E.readEquip(mkItem("Steel Plate", "armor", {
    item_cost: "300", isMartial: true, item_type: "armor",
    item_baseDef: 11, item_baseMdef: 9, init_penalty: 3,
  }), "armor");
  eq("martial armor reports a replacement base", plate.defBase, 11);
  eq("...and contributes no bonus", plate.defBonus, 0);
  eq("...and its MDEF base", plate.mdefBase, 9);
  eq("...and its initiative penalty", plate.initPenalty, 3);

  const garb = E.readEquip(mkItem("Travel Garb", "armor", {
    item_cost: "100", isMartial: false, item_type: "armor",
    item_def_bonus: 1, item_mdef_bonus: 1,
  }), "armor");
  eq("ordinary armor has no replacement base", garb.defBase, null);
  eq("...it adds instead", garb.defBonus, 1);

  const shield = E.readEquip(mkItem("Bronze Shield", "shield", {
    item_cost: "100", isMartial: false, item_type: "shield", item_def_bonus: 2, item_mdef_bonus: 2,
  }), "shield");
  eq("a shield always adds", [shield.defBase, shield.defBonus], [null, 2]);

  // A MARTIAL shield still adds -- only armor can replace the die.
  const runicShield = E.readEquip(mkItem("Runic Shield", "shield", {
    item_cost: "150", isMartial: true, item_type: "shield", item_def_bonus: 2, item_mdef_bonus: 4,
  }), "shield");
  eq("a martial shield does not replace the die", runicShield.defBase, null);
  eq("...it adds like any other shield", runicShield.defBonus, 2);

  // ── totals ──
  const ALL = { melee: true, ranged: true, armor: true, shield: true };
  const NONE = { melee: false, ranged: false, armor: false, shield: false };

  const d = D.createDraft();
  eq("nothing worn contributes nothing",
    E.equipBonuses(d, ALL), { defBase: null, defBonus: 0, mdefBase: null, mdefBonus: 0, initPenalty: 0 });

  E.addPick(d, garb); E.addPick(d, shield);
  eq("soft armor and a shield stack as bonuses",
    [E.equipBonuses(d, ALL).defBase, E.equipBonuses(d, ALL).defBonus], [null, 3]);

  const p = D.createDraft();
  E.addPick(p, plate); E.addPick(p, shield);
  const worn = E.equipBonuses(p, ALL);
  eq("plate sets the base and the shield adds on top", [worn.defBase, worn.defBonus], [11, 2]);
  eq("the penalty carries", worn.initPenalty, 3);

  // Untrained gear is carried, not worn -- it must not reach the projection.
  const untrained = E.equipBonuses(p, NONE);
  eq("untrained plate contributes no base", untrained.defBase, null);
  eq("...and no penalty either", untrained.initPenalty, 0);
  eq("but the trained shield still counts", untrained.defBonus, 2);
}

// ── picks carry the defence fields, so the draft survives on its own ───────
{
  const d = D.createDraft();
  E.addPick(d, E.readEquip({
    uuid: "Item.x", id: "x", name: "Runic Plate", img: "",
    system: { props: { item_cost: "250", isMartial: true, item_type: "armor",
                       item_baseDef: 11, item_baseMdef: 9, init_penalty: 2 } },
  }, "armor"));
  const pick = E.picks(d)[0];
  eq("defBase is copied onto the pick", pick.defBase, 11);
  eq("mdefBase too", pick.mdefBase, 9);
  eq("and the penalty", pick.initPenalty, 2);
  eq("a pick is plain data, safe to serialise",
    JSON.parse(JSON.stringify(pick)).defBase, 11);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
