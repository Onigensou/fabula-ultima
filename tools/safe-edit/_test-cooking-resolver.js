// Offline unit test of FUCompanion.api.cooking.resolve (pure resolver).
globalThis.window = globalThis;
globalThis.Hooks = { once() {} };
globalThis.game = {};
globalThis.foundry = { utils: {} };
require("../../modules/fabula-ultima-companion/scripts/cooking-system/cooking-api.js");
const cooking = globalThis.FUCompanion.api.cooking;

const CFG = {
  matrix: {
    sour: { 1: "sour1", 2: "sour2", 3: "sour3" },
    salty: { 1: "salty1", 2: "salty2", 3: "salty3" },
    umami: { 1: "umami1", 2: "umami2", 3: "umami3" },
    sweet: { 1: "sweet1", 2: "sweet2", 3: "sweet3" },
    bitter: { 1: "bitter1", 2: "bitter2", 3: "bitter3" },
  },
  mysteryDishId: "mystery", goopDishId: "goop",
  tierBreakpoints: [8, 12], weirdThreshold: 2,
  tastePoints: { primary: 2, secondary: 1 },
  rarityPotency: { Common: 1, Uncommon: 2, Rare: 3, Legendary: 4 },
  cookerCheck: {
    attrA: "INS", attrB: "DEX", helperDl: 10,
    bands: [{ max: 6, potency: -1 }, { max: 12, potency: 0 }, { max: 15, potency: 1 }, { max: 9999, potency: 2 }],
    critPotency: 2, fumbleWeird: 1,
  },
  pickTimeoutMs: 1,
};

const ing = (name, taste, rarity = "Common", isIngredient = true, taste2 = "") =>
  ({ name, taste, taste2, rarity, isIngredient });

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${label}`);
}

const opts = (extra = {}) => ({ config: CFG, rng: () => 0.0, ...extra });

// 1. Dominant sour, 4 commons → potency 4, tier 1
let r = cooking.resolve([ing("A", "sour"), ing("B", "sour"), ing("C", "sweet"), ing("D", "umami")], opts());
expect("sour T1", [r.kind, r.dishId, r.tier, r.potency], ["dish", "sour1", 1, 4]);

// 2. Same pot + good check (13) → potency 5, still T1
r = cooking.resolve([ing("A", "sour"), ing("B", "sour"), ing("C", "sweet"), ing("D", "umami")],
  opts({ cookerCheck: { total: 13, isCrit: false, isFumble: false } }));
expect("sour T1 +check", [r.kind, r.tier, r.potency], ["dish", 1, 5]);

// 3. Rare+Legendary sour pot → potency 3+4+1+1=9 → tier 2; crit → 11 → still T2; 16+ band +2 → 11
r = cooking.resolve([ing("A", "sour", "Rare"), ing("B", "sour", "Legendary"), ing("C", "sour"), ing("D", "umami")], opts());
expect("sour T2", [r.kind, r.dishId, r.tier, r.potency], ["dish", "sour2", 2, 9]);

// 4. Crit pushes over tier 3 breakpoint: base 10+2=12
r = cooking.resolve([ing("A", "sour", "Rare"), ing("B", "sour", "Legendary"), ing("C", "sour", "Uncommon"), ing("D", "umami")],
  opts({ cookerCheck: { total: 14, isCrit: true, isFumble: false } }));
expect("crit → T3", [r.kind, r.dishId, r.tier, r.potency], ["dish", "sour3", 3, 12]);

// 5. Burnt: check ≤6 → −1 potency
r = cooking.resolve([ing("A", "umami"), ing("B", "umami"), ing("C", "umami"), ing("D", "umami")],
  opts({ cookerCheck: { total: 5, isCrit: false, isFumble: false } }));
expect("burnt −1", [r.kind, r.dishId, r.potency], ["dish", "umami1", 3]);

// 6. Two weird → goop (one coin + one weird-tagged ingredient)
r = cooking.resolve([ing("Gold Bar", "", "Rare", false), ing("Eyeball", "weird"), ing("C", "sweet"), ing("D", "sweet")], opts());
expect("goop", [r.kind, r.dishId, r.weirdness], ["goop", "goop", 2]);

// 7. One weird tolerated → still a dish
r = cooking.resolve([ing("Gold Bar", "", "Rare", false), ing("B", "sweet"), ing("C", "sweet"), ing("D", "umami")], opts());
expect("1 weird ok", [r.kind, r.dishId, r.weirdness], ["dish", "sweet1", 1]);

// 8. Fumble adds weirdness: 1 weird + fumble → goop
r = cooking.resolve([ing("Gold Bar", "", "Rare", false), ing("B", "sweet"), ing("C", "sweet"), ing("D", "umami")],
  opts({ cookerCheck: { total: 2, isCrit: false, isFumble: true } }));
expect("fumble → goop", [r.kind, r.weirdness], ["goop", 2]);

// 9. Tie → mystery, redirect to tier-1 of rng-picked leader (rng 0 → first leader alphabetic order of TASTES filter)
r = cooking.resolve([ing("A", "sour"), ing("B", "sour"), ing("C", "sweet"), ing("D", "sweet")], opts());
expect("clash → mystery", [r.kind, r.dishId, r.redirectFamily, r.redirectDishId], ["mystery", "mystery", "sour", "sour1"]);

// 10. Recipe exact match bypasses goop
r = cooking.resolve([ing("Gold Bar", "", "Rare", false), ing("Golem Heart", "weird"), ing("Jellopy", "sweet"), ing("Spore", "bitter")],
  opts({ knownRecipes: [{ name: "Golem-Heart Fondue", dishUuid: "Item.fondue", ingredientNames: ["Golem Heart", "Gold Bar", "Jellopy", "Spore"] }] }));
expect("recipe bypass", [r.kind, r.dishId], ["recipe", "Item.fondue"]);

// 11. Recipe must be exact multiset — different 4th ingredient falls through to goop
r = cooking.resolve([ing("Gold Bar", "", "Rare", false), ing("Golem Heart", "weird"), ing("Jellopy", "sweet"), ing("Nibbers", "umami")],
  opts({ knownRecipes: [{ name: "Golem-Heart Fondue", dishUuid: "Item.fondue", ingredientNames: ["Golem Heart", "Gold Bar", "Jellopy", "Spore"] }] }));
expect("recipe strict", r.kind, "goop");

// 12. taste2 half weight: 2×sour primary vs sour secondary ×1 + sweet... verify secondary counts
r = cooking.resolve([ing("A", "sweet", "Common", true, "sour"), ing("B", "sweet", "Common", true, "sour"), ing("C", "sour"), ing("D", "sour")], opts());
// sweet 4, sour 2+4=6 → sour dominant, potency 4 → T1
expect("taste2 weights", [r.kind, r.dishId, r.points.sour, r.points.sweet], ["dish", "sour1", 6, 4]);

// 13. Empty/unknown taste on flagged ingredient counts weird (misconfigured)
r = cooking.resolve([ing("A", ""), ing("B", "sweet"), ing("C", "sweet"), ing("D", "umami")], opts());
expect("blank taste = weird", [r.kind, r.weirdness], ["dish", 1]);

// ── Config-borne unique recipes (Giga Pudding: Jellopy x4) ──────────────────
const CFG_R = {
  ...CFG,
  recipes: [{ name: "Giga Pudding", dishId: "gigapudding", ingredients: [{ name: "Jellopy", qty: 4 }] }],
};
const optsR = (extra = {}) => ({ config: CFG_R, rng: () => 0.0, ...extra });
const jellopy = () => ing("Jellopy", "sweet");

// 14. 4x Jellopy → Giga Pudding (counted recipe, nobody has to "know" it)
r = cooking.resolve([jellopy(), jellopy(), jellopy(), jellopy()], optsR());
expect("giga pudding x4", [r.kind, r.dishId, r.recipeName], ["recipe", "gigapudding", "Giga Pudding"]);

// 15. Only 3 Jellopy → no match, falls through to normal sweet taste math
r = cooking.resolve([jellopy(), jellopy(), jellopy()], optsR());
expect("3x jellopy = no recipe", [r.kind, r.dishId], ["dish", "sweet1"]);

// 16. 3 Jellopy + 1 other → no match (exact multiset, not a subset)
r = cooking.resolve([jellopy(), jellopy(), jellopy(), ing("Nibbers", "umami")], optsR());
expect("3x jellopy + other", [r.kind, r.dishId], ["dish", "sweet1"]);

// 17. Fumble ruins even the unique recipe — and yields the REAL goop dish id
r = cooking.resolve([jellopy(), jellopy(), jellopy(), jellopy()],
  optsR({ cookerCheck: { total: 2, isCrit: false, isFumble: true } }));
expect("fumble beats recipe", [r.kind, r.dishId], ["goop", "goop"]);

// 18. Fumble on a plain dish now goops properly (previously kept the dish id)
r = cooking.resolve([ing("A", "umami"), ing("B", "umami"), ing("C", "umami"), ing("D", "umami")],
  optsR({ cookerCheck: { total: 3, isCrit: false, isFumble: true } }));
expect("fumble goops dish", [r.kind, r.dishId], ["goop", "goop"]);

// ── core + filler partial matching ──────────────────────────────────────────
// `core` = ingredients the pot must CONTAIN; every other slot is free filler.
const CFG_C = {
  ...CFG,
  recipes: [
    { name: "Giga Pudding",  dishId: "gigapudding", ingredients: [{ name: "Jellopy", qty: 4 }] },
    { name: "Moon Custard",  dishId: "custard",     core: [{ name: "Egg" }, { name: "Fresh Milk" }] },
    { name: "Lucky Omelette",dishId: "omelette",    core: [{ name: "Egg" }, { name: "Lucky Loach" }] },
    { name: "Grand Omelette",dishId: "grand",       core: [{ name: "Egg" }, { name: "Lucky Loach" }, { name: "Rice" }] },
    { name: "Soufflé",       dishId: "souffle",     core: [{ name: "Regret", qty: 2 }] },
  ],
};
const optsC = (extra = {}) => ({ config: CFG_C, rng: () => 0.0, ...extra });
const egg   = () => ing("Egg", "umami");
const milk  = () => ing("Fresh Milk", "sweet");
const loach = () => ing("Lucky Loach", "sweet", "Uncommon");
const rice  = () => ing("Rice", "sweet");

// 19. Core met + 2 filler → the unique dish, filler ignored
r = cooking.resolve([egg(), milk(), ing("A", "sour"), ing("B", "bitter")], optsC());
expect("core+2 filler", [r.kind, r.dishId, r.recipeName], ["recipe", "custard", "Moon Custard"]);

// 20. Core met with NO filler (pot exactly the core) still matches
r = cooking.resolve([egg(), milk()], optsC());
expect("core exact, no filler", [r.kind, r.dishId], ["recipe", "custard"]);

// 21. Half the core → no match, falls through to taste math, flags a near-miss
r = cooking.resolve([egg(), ing("A", "sour"), ing("B", "sour"), ing("C", "sour")], optsC());
expect("1 short → near-miss", [r.kind, r.nearMiss], ["dish", true]);

// 22. Nothing close → no near-miss tease
r = cooking.resolve([ing("A", "sour"), ing("B", "sour"), ing("C", "sour"), ing("D", "umami")], optsC());
expect("no near-miss", [r.kind, r.nearMiss], ["dish", false]);

// 23. Specificity: Egg+Loach+Rice satisfies BOTH omelettes — the 3-core wins
r = cooking.resolve([egg(), loach(), rice(), ing("F", "sour")], optsC());
expect("most specific core wins", [r.kind, r.dishId], ["recipe", "grand"]);

// 24. Drop the Rice and the 2-core one takes over
r = cooking.resolve([egg(), loach(), ing("F", "sour")], optsC());
expect("2-core fallback", [r.kind, r.dishId], ["recipe", "omelette"]);

// 25. Counted core: 1 Regret is not enough, 2 is
r = cooking.resolve([ing("Regret", "bitter"), ing("A", "sour"), ing("B", "sour")], optsC());
expect("1 Regret insufficient", r.kind, "dish");
r = cooking.resolve([ing("Regret", "bitter"), ing("Regret", "bitter"), ing("A", "sour")], optsC());
expect("2 Regret matches", [r.kind, r.dishId], ["recipe", "souffle"]);

// 26. Exact full-pot recipe still outranks a core match sharing the pot
const CFG_X = { ...CFG, recipes: [
  { name: "Core Dish",  dishId: "core",  core: [{ name: "Jellopy", qty: 2 }] },
  { name: "Giga Pudding", dishId: "gigapudding", ingredients: [{ name: "Jellopy", qty: 4 }] },
]};
r = cooking.resolve([jellopy(), jellopy(), jellopy(), jellopy()], { config: CFG_X, rng: () => 0.0 });
expect("exact outranks core", [r.kind, r.dishId], ["recipe", "gigapudding"]);

// 27. …but 3 Jellopy (no longer exact) falls to the core recipe
r = cooking.resolve([jellopy(), jellopy(), jellopy()], { config: CFG_X, rng: () => 0.0 });
expect("core catches non-exact", [r.kind, r.dishId], ["recipe", "core"]);

// 28. Fumble ruins a core recipe too, and suppresses the near-miss tease
r = cooking.resolve([egg(), milk(), ing("A", "sour"), ing("B", "sour")],
  optsC({ cookerCheck: { total: 2, isCrit: false, isFumble: true } }));
expect("fumble beats core recipe", [r.kind, r.dishId], ["goop", "goop"]);

// 29. Weird ingredients can be filler — a core match bypasses the goop gate
r = cooking.resolve([egg(), milk(), ing("Coin", "", "Common", false), ing("Nail", "", "Common", false)], optsC());
expect("core bypasses goop", [r.kind, r.dishId], ["recipe", "custard"]);

// 30. Determinism — the same pot must always cook the same dish
const potD = [egg(), loach(), rice(), ing("F", "sour")];
const a = cooking.resolve(potD, { config: CFG_C, rng: () => 0.99 });
const b = cooking.resolve(potD, { config: CFG_C, rng: () => 0.01 });
expect("deterministic across rng", [a.dishId, b.dishId], ["grand", "grand"]);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
