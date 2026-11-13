// Offline unit test of FUCompanion.api.cooking.resolve (pure resolver) — cooking v2.
//   node tools/safe-edit/_test-cooking-resolver.js
// Covers: flavor links (resonance / harmony / clash), muddled → spoiled, Yaminabe +2 and the
// Dark Delicacy tier, taste + recipe wheels, named > pattern recipes, rarity-weighted recipe wheel,
// near-miss hints, goop, and the invariant that the pip animation (left-to-right fusing) always
// adds up to the same link total as the resolver.
globalThis.window = globalThis;
globalThis.Hooks = { once() {} };
globalThis.game = {};
globalThis.foundry = { utils: { mergeObject: (a, b) => ({ ...a, ...b }), deepClone: x => JSON.parse(JSON.stringify(x)) } };
require("../../modules/fabula-ultima-companion/scripts/cooking-system/cooking-api.js");
const cooking = globalThis.FUCompanion.api.cooking;
const { rel, TASTES } = cooking._internals;

const CFG = {
  matrix: Object.fromEntries(["bitter", "sweet", "sour", "salty", "umami"].map(t => [t, { 1: t + "1", 2: t + "2", 3: t + "3" }])),
  recipes: [
    { name: "Rice Ball", dishId: "riceball", core: [{ name: "Rice" }, { name: "Rock Salt" }] },
    { name: "Moon Custard", dishId: "custard", core: [{ name: "Egg" }, { name: "Fresh Milk" }] },
    { name: "Manta Sashimi", dishId: "manta", core: [{ name: "Tempest Manta" }, { name: "Rock Salt" }] },
    { name: "Sweet Mush", dishId: "mush", core: [{ taste: "sweet", qty: 2 }] },
    { name: "Meatballs", dishId: "meatballs", core: [{ kind: "monster", qty: 3 }] },
  ],
  goopDishId: "goop",
  darkDishIds: { bitter: "dark_bitter", sweet: "dark_sweet", sour: "dark_sour", salty: "dark_salty", umami: "dark_umami" },
  spoiledDishIds: { bitter: "sp_bitter", sweet: "sp_sweet", sour: "sp_sour", salty: "sp_salty", umami: "sp_umami" },
  ingredientKinds: { "Charred Bone": "monster", "Ash": "monster", "Turnip": "garden", "Animal Fang": "meat", "Ember Petal": "garden",
    "Golden Koi": "sea", "Honey": "garden", "Starfruit": "garden", "Jellopy": "monster", "Fish Fin": "sea", "Rice": "pantry",
    "Rock Salt": "pantry", "Egg": "pantry", "Fresh Milk": "pantry", "Tempest Manta": "sea", "Golem Heart": "monster" },
  tierBreakpoints: [8, 12], weirdThreshold: 2, link: 2, muddledAt: 4,
  yaminabe: { bonus: 2, darkAt: 15 },
  tastePoints: { primary: 2, secondary: 1 },
  rarityPotency: { Common: 1, Uncommon: 2, Rare: 3, Legendary: 4 },
  cookerCheck: { attrA: "INS", attrB: "DEX", helperDl: 10,
    bands: [{ max: 6, potency: -1 }, { max: 12, potency: 0 }, { max: 15, potency: 1 }, { max: 9999, potency: 2 }], critPotency: 2, fumbleWeird: 1 },
};
const RARITY = { "Tempest Manta": "Legendary", "Golden Koi": "Legendary", "Honey": "Uncommon", "Starfruit": "Uncommon" };
const ing = (name, taste, rarity = "Common", extra = {}) => ({ name, taste, rarity, isIngredient: true, actorId: "a_" + name, actorName: "P_" + name, ...extra });
const CFG_NP = { ...CFG, recipes: CFG.recipes.filter(x => !x.core.some(e => !e.name)) };
const opts = (extra = {}) => ({ config: CFG_NP, rng: () => 0, rarityOf: n => RARITY[n] ?? "Common", ...extra });

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${label}`);
}

// 1. resonance + harmony: Bitter ×3 + Ember Petal (Sweet, Bitter's neighbour) → 4 + 4 + 2 = 10 → T2
let r = cooking.resolve([ing("Charred Bone", "bitter"), ing("Ash", "bitter"), ing("Turnip", "bitter"), ing("Ember Petal", "sweet")], opts());
expect("resonance + harmony → T2", [r.kind, r.family, r.tier, r.potency, r.parts.resonance, r.parts.harm, r.parts.clash], ["dish", "bitter", 2, 10, 4, 2, 0]);
expect("style + featured name", [r.key, r.displayName], ["dish:bitter:monster", "Hearty Smoky Charred Bone Hot-Pot"]);

// 2. clash: same pot with Animal Fang (Sour, across the chart) → 4 + 4 − 2 = 6 → T1
r = cooking.resolve([ing("Charred Bone", "bitter"), ing("Ash", "bitter"), ing("Turnip", "bitter"), ing("Animal Fang", "sour")], opts());
expect("clash → T1", [r.tier, r.potency, r.parts.clash], [1, 6, 2]);

// 3. mixed: Golden Koi + Honey (Sweet) + Starfruit (Sour) + Charred Bone (Bitter) → 9 + 2 + 4 − 2 = 13 → T3
r = cooking.resolve([ing("Golden Koi", "sweet", "Legendary"), ing("Honey", "sweet", "Uncommon"), ing("Starfruit", "sour", "Uncommon"), ing("Charred Bone", "bitter")], opts());
expect("mixed links → T3", [r.family, r.tier, r.potency, r.parts.harm, r.parts.clash], ["sweet", 3, 13, 4, 2]);
expect("featured = rarest of the winning taste", r.featured?.name, "Golden Koi");

// 4. muddled: four different tastes → spoiled, taste wheel decides whose taste ruined it
r = cooking.resolve([ing("Honey", "sweet", "Uncommon"), ing("Fish Fin", "umami"), ing("Rock Salt", "salty", "Common", { name: "Salt X" }), ing("Charred Bone", "bitter")], opts());
expect("muddled → spoiled", [r.kind, r.tier, r.wheel?.type, r.wheel?.segments.length, r.dishId], ["spoiled", 0, "taste", 4, "sp_" + r.family]);

// 5. 2-2 tie → taste wheel (weighted by rarity) + fusion name; rng 0 → first candidate in wheel order
r = cooking.resolve([ing("Honey", "sweet", "Uncommon"), ing("Jellopy", "sweet"), ing("Fish Fin", "umami"), ing("Golem Heart", "umami")], opts());
expect("tie → taste wheel", [r.wheel?.type, r.wheel?.segments.map(s => s.taste), r.family, r.key], ["taste", ["sweet", "umami"], "sweet", "fusion:sweet+umami"]);
expect("tie weights 3:2", r.wheel.segments.map(s => Math.round(s.p * 100)), [60, 40]);
expect("fusion display name", /Honeyed-Savory/.test(r.displayName), true);
r = cooking.resolve([ing("Honey", "sweet", "Uncommon"), ing("Jellopy", "sweet"), ing("Fish Fin", "umami"), ing("Golem Heart", "umami")], opts({ rng: () => 0.99 }));
expect("tie wheel rng high → second", r.family, "umami");

// 6. Yaminabe +2, Dark Delicacy at 15+
r = cooking.resolve([ing("Golden Koi", "sweet", "Legendary"), ing("Honey", "sweet", "Uncommon"), ing("Starfruit", "sour", "Uncommon"), ing("Charred Bone", "bitter")],
  opts({ mode: "dark", cookerCheck: { total: 16, isCrit: false, isFumble: false } }));
expect("yaminabe +2 & dark tier", [r.kind, r.tier, r.potency, r.parts.yami, r.dishId], ["dark", 4, 17, 2, "dark_sweet"]);
r = cooking.resolve([ing("Golden Koi", "sweet", "Legendary"), ing("Honey", "sweet", "Uncommon"), ing("Starfruit", "sour", "Uncommon"), ing("Charred Bone", "bitter")],
  opts({ cookerCheck: { total: 16, isCrit: false, isFumble: false } }));
expect("hot pot never reaches the dark tier", [r.kind, r.tier, r.potency], ["dish", 3, 15]);

// 7. fumble → goop (even over a recipe)
r = cooking.resolve([ing("Rice", "sweet"), ing("Rock Salt", "salty")], opts({ cookerCheck: { total: 2, isCrit: false, isFumble: true } }));
expect("fumble → goop", [r.kind, r.dishId], ["goop", "goop"]);

// 8. named beats pattern (Sweet ×2 also fits)
r = cooking.resolve([ing("Rice", "sweet"), ing("Rock Salt", "salty"), ing("Honey", "sweet", "Uncommon"), ing("Turnip", "bitter")], opts({ config: CFG }));
expect("named > pattern", [r.kind, r.recipeName, r.wheel], ["recipe", "Rice Ball", null]);

// 9. two named recipes → recipe wheel, 50/50 for equal rarity
r = cooking.resolve([ing("Rice", "sweet"), ing("Rock Salt", "salty"), ing("Egg", "umami"), ing("Fresh Milk", "sweet")], opts());
expect("recipe wheel", [r.wheel?.type, r.wheel?.segments.map(s => s.name), r.wheel?.segments.map(s => Math.round(s.p * 100))], ["recipe", ["Rice Ball", "Moon Custard"], [50, 50]]);

// 10. rarity weights replace priority: Manta (Legendary 4 + 1) vs Rice Ball (1 + 1) → 5:2
r = cooking.resolve([ing("Tempest Manta", "salty", "Legendary"), ing("Rock Salt", "salty"), ing("Rice", "sweet")], opts());
expect("rarity-weighted recipe wheel", r.wheel?.segments.map(s => [s.name, Math.round(s.p * 100)]), [["Rice Ball", 29], ["Manta Sashimi", 71]]);

// 11. pattern recipe (kind) when no named recipe fits
r = cooking.resolve([ing("Charred Bone", "bitter"), ing("Ash", "bitter"), ing("Golem Heart", "salty"), ing("Turnip", "bitter")], opts({ config: CFG }));
expect("pattern recipe", [r.kind, r.recipeName, r.pattern], ["recipe", "Meatballs", true]);

// 12. near miss → hint data (named recipes only)
r = cooking.resolve([ing("Rice", "sweet"), ing("Turnip", "bitter"), ing("Ember Petal", "sweet", "Common", { name: "Petal B" })], opts({ config: { ...CFG, recipes: CFG.recipes.filter(x => x.name !== "Sweet Mush") } }));
expect("near miss", r.near.map(n => [n.name, n.have]), [["Rice Ball", ["Rice"]]]);

// 13. weirdness ≥ 2 → goop
r = cooking.resolve([ing("Coin", "", "Common", { isIngredient: false }), ing("Ore", "", "Common", { isIngredient: false }), ing("Honey", "sweet", "Uncommon")], opts());
expect("weird → goop", r.kind, "goop");

// 14. single ingredient → T1, no links
r = cooking.resolve([ing("Fish Fin", "umami")], opts());
expect("single", [r.kind, r.tier, r.potency, r.parts.resonance + r.parts.harm + r.parts.clash], ["dish", 1, 1, 0]);

// 15. chart wheel: neighbours harmonize, across clashes
expect("flavor wheel", [rel("bitter", "sweet"), rel("sweet", "sour"), rel("sour", "salty"), rel("salty", "umami"), rel("umami", "bitter"), rel("bitter", "sour"), rel("sweet", "umami")],
  ["harm", "harm", "harm", "harm", "harm", "clash", "clash"]);

// 16. invariant: the pip show (fuse left→right, bounce on clash) adds up to the resolver's links
let mismatch = 0, runs = 0;
const pool = [["A", "bitter"], ["B", "sweet"], ["C", "sour"], ["D", "salty"], ["E", "umami"]];
for (let i = 0; i < 4000; i++) {
  const n = 2 + Math.floor(Math.random() * 3);
  const pot = Array.from({ length: n }, (_, k) => { const [nm, t] = pool[Math.floor(Math.random() * 5)]; return ing(nm + k, t); });
  const res = cooking.resolve(pot, opts({ config: { ...CFG, recipes: [] } }));
  if (res.kind !== "dish") continue;
  runs++;
  const blobs = [], tastes = []; let total = 0;
  for (const c of pot) {
    if (tastes.includes(c.taste)) { total += 2; continue; }
    tastes.push(c.taste);
    let fuse = null;
    for (const b of blobs) { let cl = false; for (const x of b) { if (rel(x, c.taste) === "harm") total += 2; else { total -= 2; cl = true; } } if (!cl && !fuse) fuse = b; }
    if (fuse) fuse.push(c.taste); else blobs.push([c.taste]);
    if (blobs.some(b => b.length > 2)) mismatch++;           // a blob never holds 3 tastes
  }
  if (total !== res.parts.resonance + res.parts.harm - res.parts.clash) mismatch++;
}
expect(`pip show == resolver links (${runs} pots)`, mismatch, 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
