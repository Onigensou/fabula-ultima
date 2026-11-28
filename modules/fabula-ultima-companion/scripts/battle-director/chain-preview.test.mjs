// ============================================================================
// Random-target Chain card — preview assembly (chain-preview.js).
//
//     node scripts/battle-director/chain-preview.test.mjs
//
// The engine adapter (computeDrawnChainPreview) prices each strike through
// recomputeActionProfile and needs Foundry; it is covered by the sandbox battle
// run. Here, the samples are produced by a stand-in for that pipeline using the
// approved mockup's own data and order (flat reduction → weapon efficiency →
// affinity), so the assembly is checked against the mockup's numbers.
// ============================================================================

const {
  formatRange, isDrawnChainPreviewSpec, chainAccuracyRange, strikeElements, previewStrikesToSample,
  assembleChainPreview, mergeChainPreview, missingPreviewTargets, RANGE_SEP,
} = await import("./chain-preview.js");

let failed = 0, passed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failed++;
  console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
}

// ── basics ──────────────────────────────────────────────────────────────────
eq("separator", RANGE_SEP, "～");
eq("range", formatRange(81, 90), "81～90");
eq("range collapses", formatRange(5, 5), "5");
eq("drawn modes only", ["seek", "random", "volley", "single", "separate", "pick"].map((mode) => isDrawnChainPreviewSpec({ count: 3, mode })), [true, true, true, false, false, false]);
eq("hidden one-roll is not drawn", isDrawnChainPreviewSpec({ count: 8, mode: "single", hidden: true }), false);
eq("chain 1 is no chain", isDrawnChainPreviewSpec({ count: 1, mode: "seek" }), false);
eq("accuracy: Asura Strike DEX d10 + MIG d8 +6", chainAccuracyRange({ dA: 10, dB: 8, checkBonus: 6 }), { min: 8, max: 24 });
eq("accuracy: Sonic Blow d8 + d8 −2", chainAccuracyRange({ dA: 8, dB: 8, checkBonus: -2 }), { min: 0, max: 14 });
eq("accuracy: no dice", chainAccuracyRange({ dA: 0, dB: 8 }), null);

const asuraSpec = { count: 4, mode: "seek", elements: ["bolt", "fire", "ice", "air"], strikeTargets: [["h"], ["z"], ["h"], ["g"]] };
eq("strike elements (strike 1 = card)", strikeElements(asuraSpec, "bolt"), ["bolt", "fire", "ice", "air"]);
eq("short list repeats its last entry", strikeElements({ count: 4, mode: "seek", elements: ["bolt", "fire"] }, "bolt"), ["bolt", "fire", "fire", "fire"]);
eq("no list: card element", strikeElements({ count: 3, mode: "seek" }, "bolt"), ["bolt", "bolt", "bolt"]);
eq("samples: one per element", previewStrikesToSample(asuraSpec, "bolt"), [{ k: 1, element: "bolt" }, { k: 2, element: "fire" }, { k: 3, element: "ice" }, { k: 4, element: "air" }]);
eq("samples: one element, seek", previewStrikesToSample({ count: 3, mode: "seek" }, "bolt"), [{ k: 1, element: "bolt" }]);
eq("samples: volley prices first + last shot", previewStrikesToSample({ count: 5, mode: "volley" }, "physical"), [{ k: 1, element: "physical" }, { k: 5, element: "physical" }]);

// ── a stand-in for the per-target pipeline, with the mockup's data ──────────
// (action-profile.js order: raw → flat reduction → weapon efficiency ceil(x × ef / 100) → affinity)
const U = {
  hina:    { name: "Hina", aff: { bolt: "RS", fire: "AB" }, dr: { all: 2, physical: 4 } },
  blanche: { name: "Blanche", aff: { physical: "RS", bolt: "RS", dark: "RS", fire: "RS", ice: "RS", light: "RS" }, dr: { all: 4, physical: 4 } },
  keren:   { name: "Keren", aff: { bolt: "RS", fire: "RS" }, dr: { physical: 5 } },
  zarg:    { name: "Zarg", aff: { bolt: "RS", dark: "RS", earth: "RS", poison: "RS" } },
  gorger:  { name: "King Gorger", aff: {} },
  manaray: { name: "Mana Ray", aff: { bolt: "RS", fire: "RS", ice: "VU", dark: "IM", earth: "VU", light: "VU", poison: "IM" }, ef: { arcane: 75, dagger: 125 } },
  crysta:  { name: "Crysta", aff: {} },
  asura:   { name: "Asura", aff: { air: "VU", bolt: "VU", fire: "VU", ice: "VU" }, ef: { sword: 50, bow: 150 } },
  electro: { name: "Electro Gorger", aff: { bolt: "AB", earth: "VU" } },
  pyro:    { name: "Pyro Gorger", aff: { fire: "AB", ice: "VU" } },
  aero:    { name: "Aero Gorger", aff: { air: "AB", earth: "VU" } },
};
const applyAff = (n, a) => (a === "VU" ? n * 2 : a === "RS" ? Math.ceil(n / 2) : a === "IM" ? 0 : n);
function pipeline(act, t, raw, el) {
  const u = U[t];
  const dr = (u.dr?.all || 0) + (u.dr?.[el] || 0);
  const parts = [];
  let v = Math.max(0, raw - dr);
  if (dr) parts.push({ source: `Damage reduction −${dr}`, amount: -dr });
  const ef = act.weaponKey ? (u.ef?.[act.weaponKey] || 100) : 100;
  if (ef !== 100) { const b = v; v = Math.ceil(v * ef / 100); parts.push({ source: `${act.weaponKey} efficiency ${ef}%`, amount: v - b }); }
  const aff = u.aff[el] || "NE";
  return { tokenUuid: t, name: u.name, value: applyAff(v, aff), affinity: aff, parts };
}
function previewOf(act) {
  const spec = { count: act.count, mode: act.mode, elements: act.elements };
  const maxHR = Math.max(act.dA, act.dB);
  const samples = [];
  for (const s of previewStrikesToSample(spec, act.elements?.[0] ?? act.element)) {
    for (const h of [1, maxHR]) {
      const raw = Math.floor((h + act.base) * act.mult);
      samples.push({ ...s, hr: h, outgoing: raw, rows: act.targets.map((t) => pipeline(act, t, raw, s.element)) });
    }
  }
  return assembleChainPreview({ spec, cardElement: act.elements?.[0] ?? act.element, pierce: !!act.pierce, roll: { dA: act.dA, dB: act.dB, checkBonus: act.bonus }, samples });
}
const row = (p, t) => { const r = p.perTarget[t]; return { range: r.min == null ? null : formatRange(r.min, r.max), heals: r.heals, zero: r.zero }; };

// Asura Strike (Asura · pierce, chain 4 seek): DEX d10 + MIG d8 +6, HR + 80, Bolt/Fire/Ice/Air, a skill (no weapon efficiency)
const asura = previewOf({ count: 4, mode: "seek", elements: ["bolt", "fire", "ice", "air"], dA: 10, dB: 8, bonus: 6, base: 80, mult: 1, pierce: true, weaponKey: null,
  targets: ["hina", "blanche", "keren", "zarg", "gorger", "manaray", "crysta"] });
eq("Asura: accuracy", formatRange(asura.accuracy.min, asura.accuracy.max), "8～24");
eq("Asura: damage box", formatRange(asura.damage.min, asura.damage.max), "81～90");
eq("Asura: Multi-Type", [asura.mixed, asura.elements], [true, ["bolt", "fire", "ice", "air"]]);
eq("Asura: pierce", asura.pierce, true);
eq("Asura: Mana Ray (Bolt RS … Ice VU)", row(asura, "manaray"), { range: "41～180", heals: [], zero: [] });
// The mockup's own maths (Hina: −2 reduction on every hit; Bolt RS): Bolt 79/2 → 40 … Air/Ice 88. Fire heals.
eq("Asura: Hina (Fire heals)", row(asura, "hina"), { range: "40～88", heals: ["Fire"], zero: [] });
eq("Asura: King Gorger (neutral)", row(asura, "gorger"), { range: "81～90", heals: [], zero: [] });
eq("Asura: Blanche (−4, RS)", row(asura, "blanche"), { range: "39～86", heals: [], zero: [] });
eq("Asura: Hina hover", asura.perTarget.hina.why, ["Bolt RS, Damage reduction −2: 40～44", "Fire AB, Damage reduction −2: heals", "Ice, Damage reduction −2: 79～88", "Air, Damage reduction −2: 79～88"]);

// Thunderstorm (Kirin, chain 3 seek): INS d10 + WLP d10, HR + 15, Bolt, a spell (arcane efficiency)
const storm = previewOf({ count: 3, mode: "seek", element: "bolt", dA: 10, dB: 10, bonus: 0, base: 15, mult: 1, weaponKey: "arcane", targets: ["hina", "blanche", "keren", "zarg"] });
eq("Thunderstorm: accuracy", formatRange(storm.accuracy.min, storm.accuracy.max), "2～20");
eq("Thunderstorm: damage box", formatRange(storm.damage.min, storm.damage.max), "16～25");
eq("Thunderstorm: one element", [storm.mixed, storm.element], [false, "bolt"]);
eq("Thunderstorm: Keren (Bolt RS)", row(storm, "keren"), { range: "8～13", heals: [], zero: [] });
eq("Thunderstorm: Hina (−2, RS)", row(storm, "hina"), { range: "7～12", heals: [], zero: [] });

// Tommy Gun (Hako, chain 5 volley): DEX d8 + DEX d8, HR + 4, Physical, firearm
const gun = previewOf({ count: 5, mode: "volley", element: "physical", dA: 8, dB: 8, bonus: 0, base: 4, mult: 1, weaponKey: "firearm", targets: ["asura", "electro", "pyro", "aero"] });
eq("Tommy Gun: accuracy", formatRange(gun.accuracy.min, gun.accuracy.max), "2～16");
eq("Tommy Gun: damage box", formatRange(gun.damage.min, gun.damage.max), "5～12");
eq("Tommy Gun: Asura", row(gun, "asura"), { range: "5～12", heals: [], zero: [] });

// Sonic Blow (Keren, Sonic Katar, chain 8 volley): DEX d8 + DEX d8 −2, (HR + 5) × 2 as the mockup draws it, dagger
const sonic = previewOf({ count: 8, mode: "volley", element: "physical", dA: 8, dB: 8, bonus: -2, base: 5, mult: 2, weaponKey: "dagger", targets: ["asura"] });
eq("Sonic Blow: accuracy", formatRange(sonic.accuracy.min, sonic.accuracy.max), "0～14");
eq("Sonic Blow: damage box (mockup maths)", formatRange(sonic.damage.min, sonic.damage.max), "12～26");
eq("Sonic Blow: count", sonic.count, 8);

// An element the target is immune to is a "0" note, not part of the range
const im = previewOf({ count: 2, mode: "random", elements: ["dark", "ice"], dA: 6, dB: 6, bonus: 0, base: 10, mult: 1, weaponKey: null, targets: ["manaray"] });
eq("immune element = note", row(im, "manaray"), { range: "22～32", heals: [], zero: ["Dark"] });
// Every element absorbed: no range at all, only the note
const ab = previewOf({ count: 2, mode: "random", element: "bolt", dA: 6, dB: 6, bonus: 0, base: 10, mult: 1, weaponKey: null, targets: ["electro"] });
eq("all absorbed = no range", row(ab, "electro"), { range: null, heals: ["Bolt"], zero: [] });

// ── merge / missing (a protector joins the card) ────────────────────────────
eq("missing rows", missingPreviewTargets(storm, [{ tokenUuid: "hina" }, { tokenUuid: "kirin" }]).map((t) => t.tokenUuid), ["kirin"]);
const merged = mergeChainPreview(storm, { perTarget: { kirin: { min: 1, max: 2 }, hina: { min: 99, max: 99 } } });
eq("merge keeps priced rows, adds new", [merged.perTarget.hina.min, merged.perTarget.kirin.max], [7, 2]);
eq("non-drawn chain: no preview", assembleChainPreview({ spec: { count: 8, mode: "single", hidden: true } }), null);

// ── the card's row label: a Pierce miss deals half, so it never reads MISS ──
{
  globalThis.Hooks = globalThis.Hooks ?? { on() {}, once() {}, callAll() {} };
  const C = await import("./action-card.js");
  eq("plain miss", [C.resultLabelFor({ hit: false, damage: 0 }), C.resultClsFor({ hit: false, damage: 0 })], ["MISS", "miss"]);
  eq("pierce miss: half damage", [C.resultLabelFor({ hit: false, pierceMiss: true, damage: 20, affinity: "NE" }), C.resultClsFor({ hit: false, pierceMiss: true, damage: 20, affinity: "NE" })],
    [`PIERCE ½ <span class="t-num">20</span>`, "hit"]);
  eq("pierce miss: resisted", C.resultClsFor({ hit: false, pierceMiss: true, damage: 10, affinity: "RS" }), "resist");
  eq("pierce miss: absorbed", C.resultLabelFor({ hit: false, pierceMiss: true, damage: 10, affinity: "AB" }), `ABSORB <span class="t-num">10</span>`);
  eq("pierce miss: immune", C.resultLabelFor({ hit: false, pierceMiss: true, damage: 0, affinity: "IM" }), "IMMUNED");
  eq("hit unchanged", C.resultLabelFor({ hit: true, damage: 20, affinity: "NE" }), `HIT <span class="t-num">20</span>`);
}

console.log(`chain-preview: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
