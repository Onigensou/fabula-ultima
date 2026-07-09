// ============================================================================
// Ritual System — cost + eligibility regression harness.
//
//     node scripts/ritual-system/ritual-cost.test.mjs
//
// Bare Node: no Foundry, no browser, no game world. Possible only because
// ritual-cost.js and the `*ActorLike` half of ritual-actor.js are pure, and
// keeping this runnable is the reason to keep them pure. Exits non-zero on
// failure.
//
// The load-bearing assertions are the ELIGIBILITY ones. They are transcribed
// from a live probe of every actor in the world holding a ritual skill, and
// they encode the finding that source-id matching alone silently finds no
// Spiritists — the exact bug this harness exists to prevent from returning.
// ============================================================================

import { computeCost, canAfford, attrsFor, currentMp, shortfall } from "./ritual-cost.js";
import { disciplinesForActorLike } from "./ritual-actor.js";
import { POTENCY, AREA, discountForRarity } from "./ritual-const.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── The book's own worked examples (core p. 120) ────────────────────────────
// If these four drift, the pricing no longer matches the rulebook.
eq("Elementalism major/small = 80 MP, DL 13",
   (({ mp, dl }) => [mp, dl])(computeCost({ potency: "major", area: "small" })), [80, 13]);
eq("Spiritism minor/individual = 20 MP, DL 7",
   (({ mp, dl }) => [mp, dl])(computeCost({ potency: "minor", area: "individual" })), [20, 7]);
eq("Ritualism extreme/huge = 200 MP, DL 16",
   (({ mp, dl }) => [mp, dl])(computeCost({ potency: "extreme", area: "huge" })), [200, 16]);
eq("Entropism medium/individual = 30 MP, DL 10",
   (({ mp, dl }) => [mp, dl])(computeCost({ potency: "medium", area: "individual" })), [30, 10]);

// ── Material discount scales with rarity (homebrew) ─────────────────────────
// Common 10%, Uncommon 20%, Rare 30%, then a 20-point jump to Legendary 50% so
// the book's original "halve the cost" survives as the Legendary case.
eq("rarity ladder", ["common", "uncommon", "rare", "legendary"].map(discountForRarity), [0.10, 0.20, 0.30, 0.50]);
eq("unknown rarity → no discount", discountForRarity("mythic"), 0);
eq("rarity is case-insensitive",   discountForRarity("LEGENDARY"), 0.50);

const withMat = (potency, area, materialRarity) => computeCost({ potency, area, materialRarity }).mp;
eq("legendary halves 200 → 100", withMat("extreme", "huge", "Legendary"), 100);
eq("rare 30% off 200 → 140",     withMat("extreme", "huge", "Rare"), 140);
eq("uncommon 20% off 200 → 160", withMat("extreme", "huge", "Uncommon"), 160);
eq("common 10% off 200 → 180",   withMat("extreme", "huge", "Common"), 180);
eq("legendary halves 20 → 10",   withMat("minor", "individual", "Legendary"), 10);
eq("no material → full price",   withMat("major", "small", null), 80);

// Rounds UP — a ritual must never get cheaper by rounding. 30% off 50 is 35, not 34.
eq("ceil, not floor: rare off 50 MP", withMat("extreme", "individual", "Rare"), 35);
eq("ceil: common off 30 MP",          withMat("medium", "individual", "Common"), 27);

eq("material does not change DL", computeCost({ potency: "major", area: "small", materialRarity: "Legendary" }).dl, 13);
eq("baseMp survives the discount", computeCost({ potency: "major", area: "small", materialRarity: "Legendary" }).baseMp, 80);
eq("saved is reported",            computeCost({ potency: "major", area: "small", materialRarity: "Legendary" }).saved, 40);
eq("discount is reported",         computeCost({ potency: "major", area: "small", materialRarity: "Rare" }).discount, 0.30);

// ── Full table sweep: every pairing prices and never returns null ───────────
{
  let bad = 0;
  for (const p of Object.values(POTENCY)) {
    for (const a of Object.values(AREA)) {
      const c = computeCost({ potency: p.id, area: a.id });
      if (!c || c.mp !== p.mp * a.multiplier || c.dl !== p.dl) bad++;
    }
  }
  eq("all 16 potency×area pairings price correctly", bad, 0);
}
eq("unknown potency → null", computeCost({ potency: "cosmic", area: "huge" }), null);
eq("unknown area → null",    computeCost({ potency: "minor", area: "galactic" }), null);
eq("missing args → null",    computeCost({}), null);

// ── Affordability + the red shortage report ────────────────────────────────
const mpActor = (n) => ({ system: { props: { current_mp: n } } });
eq("currentMp reads prop",        currentMp(mpActor(45)), 45);
eq("currentMp tolerates garbage", currentMp({ system: { props: { current_mp: "abc" } } }), 0);
eq("currentMp tolerates missing", currentMp(undefined), 0);
eq("exact MP affords",  canAfford(mpActor(80), computeCost({ potency: "major", area: "small" })), true);
eq("1 short cannot",    canAfford(mpActor(79), computeCost({ potency: "major", area: "small" })), false);
eq("legendary rescues", canAfford(mpActor(40), computeCost({ potency: "major", area: "small", materialRarity: "Legendary" })), true);
eq("null cost cannot afford", canAfford(mpActor(999), null), false);

// CSB stores current_mp as a STRING — the string path must afford identically.
eq("string MP affords", canAfford({ system: { props: { current_mp: "111" } } }, computeCost({ potency: "minor", area: "individual" })), true);

eq("shortfall when short",     shortfall(mpActor(111), computeCost({ potency: "extreme", area: "huge" })), 89);
eq("shortfall zero when able", shortfall(mpActor(200), computeCost({ potency: "extreme", area: "huge" })), 0);
eq("shortfall never negative", shortfall(mpActor(999), computeCost({ potency: "minor", area: "individual" })), 0);

// ── Attribute pairs ────────────────────────────────────────────────────────
eq("arcanism is WLP+WLP",        attrsFor("arcanism"), ["WLP", "WLP"]);
eq("chimerism default INS+WLP",  attrsFor("chimerism"), ["INS", "WLP"]);
eq("chimerism alt MIG+WLP",      attrsFor("chimerism", { useAlt: true }), ["MIG", "WLP"]);
eq("useAlt ignored elsewhere",   attrsFor("entropism", { useAlt: true }), ["INS", "WLP"]);
eq("unknown discipline → null",  attrsFor("necromancy"), null);

// ── Eligibility — transcribed from a live probe of the world ───────────────
const ids = (actorLike) => disciplinesForActorLike(actorLike).map((d) => d.id);
const item = (name, extra = {}) => ({ name, ...extra });
const comp = (id) => ({ _stats: { compendiumSource: `Item.${id}` } });
const dup  = (id) => ({ _stats: { duplicateSource: `Item.${id}` } });

// Varan: Ritual Arcanism with a clean compendiumSource.
eq("Varan → arcanism (by id)",
   ids({ items: [item("Ritual Arcanism", comp("NqgJHogtrenPHxPP"))], classes: ["Arcanist", "Elementalist", "Wayfarer"] }),
   ["arcanism", "ritualism"]);

// Spiritist: Ritual Spiritism with NO source reference whatsoever. Id matching
// alone finds nothing here — this is the case that broke the original design.
eq("Spiritist → spiritism (name only, no source ids)",
   ids({ items: [item("Ritual Spiritism")], classes: [] }), ["spiritism"]);

// Hina: Ritual Entropism whose compendiumSource points at a DUPLICATE world
// item (6HdBHEPi…), not the registry id. Name carries it.
eq("Hina → entropism via duplicate world item + spiritism + ritualism",
   ids({
     items: [item("Ritual Entropism", comp("6HdBHEPiRoPMMydJ")), item("Curse Magic", comp("XSy7MGgInDpsTwG5")), item("Ritual Spiritism")],
     classes: ["Entropist", "Elementalist", "Dark Blade", "Spiritist", "Hexer", "Arcanist"],
   }),
   ["entropism", "ritualism", "spiritism"]);

// Hexer: Curse Ritualism grants SPIRITISM. Its duplicateSource disagrees with
// its compendiumSource (it points at Curse Magic) — and Curse Magic must not
// itself grant anything.
eq("Hexer → spiritism via Curse Ritualism",
   ids({
     items: [item("Curse Magic", comp("XSy7MGgInDpsTwG5")),
             item("Curse Ritualism", { _stats: { compendiumSource: "Item.A7DaASySso4pdaar", duplicateSource: "Item.XSy7MGgInDpsTwG5" } })],
     classes: [],
   }),
   ["spiritism"]);

// Arcanist (Variant): only duplicateSource points home; the name is suffixed.
eq("Ritual Arcanism (variant) → arcanism",
   ids({ items: [item("Ritual Arcanism (variant)", dup("NqgJHogtrenPHxPP"))], classes: [] }), ["arcanism"]);

// Koshka: no ritual skill at all, but a Ritualism class. Class-only grant.
eq("Koshka → ritualism by class alone",
   ids({ items: [item("Curse Mallet", comp("DY5RBlybpPqfV4dw"))], classes: ["Hexer", "Wayfarer", "Entropist", "Symbolist", "Spiritist", "Elementalist"] }),
   ["ritualism"]);

// ── Eligibility — the near-miss names that must NOT grant ──────────────────
eq("Ritual Seal grants nothing",     ids({ items: [item("Ritual Seal", comp("tIAPvYFFIMtpmh9k"))], classes: [] }), []);
eq("Curse Magic grants nothing",     ids({ items: [item("Curse Magic", comp("XSy7MGgInDpsTwG5"))], classes: [] }), []);
eq("Curse Collector grants nothing", ids({ items: [item("Curse Collector", comp("3QBrbZe41Yx2UAWD"))], classes: [] }), []);
eq("Curse Mallet grants nothing",    ids({ items: [item("Curse Mallet", comp("DY5RBlybpPqfV4dw"))], classes: [] }), []);
eq("no items, no classes → nothing", ids({ items: [], classes: [] }), []);
eq("unrelated class → nothing",      ids({ items: [], classes: ["Guardian", "Darkblade"] }), []);

// Ritualism accepts ANY one of its four classes, not all four.
for (const c of ["Chimerist", "Elementalist", "Entropist", "Spiritist"]) {
  eq(`ritualism via ${c}`, ids({ items: [], classes: [c] }), ["ritualism"]);
}

// Spiritism: either skill suffices, and both together still grant it once.
eq("both spiritism skills → one grant",
   ids({ items: [item("Ritual Spiritism"), item("Curse Ritualism")], classes: [] }), ["spiritism"]);

// Output order follows DISCIPLINE_ORDER, not item order.
eq("stable discipline ordering",
   ids({ items: [item("Ritual Illusionism"), item("Ritual Arcanism")], classes: [] }), ["arcanism", "illusionism"]);

// `via` explains WHY, so the window can label class-grants distinctly.
// Note the Entropist class grants RITUALISM, never Entropism — a class never
// stands in for its discipline's skill.
eq("via item vs via class",
   disciplinesForActorLike({ items: [item("Ritual Spiritism")], classes: ["Entropist"] }).map((d) => [d.id, d.via]),
   [["ritualism", "class"], ["spiritism", "item"]]);
eq("Entropist class does not grant entropism",
   ids({ items: [], classes: ["Entropist"] }), ["ritualism"]);

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
