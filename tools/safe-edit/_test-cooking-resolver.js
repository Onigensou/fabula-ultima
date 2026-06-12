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

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
