"use strict";
//
// Mindscape — measure ONE designed item (equipment guide, "Authoring an item").
//
// The reference ladder prices fixed one-effect items. This prices whatever a designer hands
// over — a paper spec for any slot (gear skills included) or a world item — the same way:
// the archetype presets on basic gear, with and without the item on its wearer, same
// encounter and seed, against the house roster (the live environment) and the rulebook base.
//
//   offense  % = extra damage the wearer deals per round / (wearer's actions per round x BA(L))
//                — the ladder's "per action" unit, taken per round so an item that GRANTS
//                actions is credited for them
//   defense  % = damage the PARTY no longer takes per round / HP-per-BA(L)
//   value    % = offense + defense. An offense item earns a little defense too: enemies that
//                die sooner hit less. That is real value, so it is not subtracted.
//   survival    wearer KO and party loss deltas; actions the wearer keeps per fight (max HP)
//
// Coverage is part of the answer. A gear skill the model cannot see (no registry entry, an
// unparseable active) or an effect the loadout parser cannot read measures as "worth 0%",
// which is a model gap, not a verdict — so every such piece is listed beside the numbers.

const RS = require("./reference-set");
const { applySwaps, resolveSource, sourceFromDoc } = require("./loadout-swap");
const { buildArchetypeParty } = require("./archetype-party");
const { extractActions } = require("./skills");
const RX = require("./reactions");
const { weaponBaseline } = require("./baseline-gear");

const ROLE_WEARERS = new Set(["striker", "caster", "tank", "support", "ranger"]);
const RARITY_BUDGET = Object.freeze({ common: 5, uncommon: 10, rare: 15, legendary: 22.5 });

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const text = (x) => (typeof x === "string" ? x : JSON.stringify(x));

// Pure: one A/B -> guide units. Exported for tests.
function priceArms(level, wearerName, baseline, withItem) {
  const b = baseline.members[wearerName];
  const i = withItem.members[wearerName];
  const unit = b.actionsPerRound.mean > 0 ? b.actionsPerRound.mean * RS.BA(level) : null;
  const offense = unit ? (100 * (i.dealtPerRound.mean - b.dealtPerRound.mean)) / unit : 0;
  const partyOffense = unit ? (100 * (withItem.partyDealtPerRound.mean - baseline.partyDealtPerRound.mean)) / unit : 0;
  const defense = (100 * (baseline.partyTakenPerRound.mean - withItem.partyTakenPerRound.mean)) / RS.hpPerBA(level);
  // Points of the fight the wearer spends standing instead of knocked out — the share of
  // its output a survival item keeps. Actions per fight would also fall when an offense
  // item simply ends the fight sooner.
  const actionsKept = 100 * ((b.downShare?.mean ?? 0) - (i.downShare?.mean ?? 0));
  return {
    value: offense + defense, offense, defense, partyOffense, actionsKept,
    koPts: 100 * (i.downRate - b.downRate), lossPts: 100 * (withItem.defeatRate - baseline.defeatRate),
    rounds: { baseline: baseline.meanRounds, withItem: withItem.meanRounds },
    wonInOne: { baseline: baseline.wonBands.oneRound, withItem: withItem.wonBands.oneRound },
    dealtPerRound: { baseline: b.dealtPerRound.mean, withItem: i.dealtPerRound.mean },
    partyTakenPerRound: { baseline: baseline.partyTakenPerRound.mean, withItem: withItem.partyTakenPerRound.mean },
    wearerDownRate: { baseline: b.downRate, withItem: i.downRate },
    damagePerHit: b.damagePerHit,
  };
}

// What of the item the model actually sees, on the wearer after the swap.
function coverageOf(wearer, source, report) {
  const subNames = new Set((source.subItems ?? []).map((x) => x.name));
  const ex = extractActions(wearer);
  const declared = RX.declaredReactions(ex.passives).filter((r) => subNames.has(r.name)).map((r) => `${r.name} (reaction)`);
  const acting = [...ex.actions, ...ex.utility].filter((a) => subNames.has(a.name)).map((a) => a.name);
  return {
    modelled: [...new Set([...acting, ...declared])],
    unmodelledPassives: RX.undeclaredReactions(ex.passives).filter((n) => subNames.has(n)),
    unmodelledActions: [...ex.unmodelled, ...ex.unmodelledUtility].filter((a) => subNames.has(a.name))
      .map((a) => `${a.name}${a.reasons?.length ? ` (${a.reasons.join("; ")})` : ""}`),
    unreadEffects: (report?.unresolved ?? []).map(text),
    situational: (report?.situational ?? []).map(text),
    warnings: [...(source.warnings ?? []), ...(report?.warnings ?? [])].map(text),
  };
}

// `item`: a spec path, item:<name>, own:<name>, or an in-memory spec document.
function sourceFor(item, wearer, worldItems) {
  if (item && typeof item === "object") return sourceFromDoc(item, item.name ?? "inline spec");
  return resolveSource(item, { worldItems, model: wearer });
}

// scopes: [{ id, group, kind: "house"|"base", level, enemies, conflictEvent }]
function measureItem({ item, slot, wearer, scopes, presets, runs, seed, power = "table", catalogue, worldItems, onArm = null }) {
  const rows = [];
  let coverage = null;
  for (const scope of scopes) {
    const arm = { runs, seed, conflictEvent: scope.conflictEvent ?? null };
    for (const preset of presets) {
      const build = () => buildArchetypeParty(preset, { level: scope.level, power, catalogue });
      const where = { scope: scope.id, group: scope.group, kind: scope.kind, level: scope.level, preset };
      // A role wearer needs no fight to be found; "most-hit" wearers are read off a plain arm.
      const plainArm = ROLE_WEARERS.has(wearer) ? null : RS.runArm(build(), scope.enemies, arm);
      const party = build();
      const who = RS.pickWearer(party, { wearer }, plainArm ?? {});
      if (!who) { rows.push({ ...where, skipped: `no ${wearer} in ${preset}` }); continue; }
      const source = sourceFor(item, who, worldItems);
      // The 0% for a weapon is the basic weapon of ITS category (guide Part 2 chassis), not
      // whatever the archetype carries: a Flail measured against a Greatsword would be paying
      // for the category change. Armor, shields and accessories baseline on the role's basic kit.
      const chassis = ["main", "off"].includes(slot) && String(source.item.props?.item_type ?? "").trim().toLowerCase() === "weapon"
        ? weaponBaseline(source.item, catalogue) : null;
      let baseline = plainArm;
      if (chassis) {
        const baseParty = build();
        const baseWearer = baseParty.find((m) => m.name === who.name);
        applySwaps(baseWearer, [{ slot, source: {
          item: { ...chassis.item, props: { ...chassis.item.props }, effects: JSON.parse(JSON.stringify(chassis.item.effects ?? [])), container: null },
          subItems: [], origin: `chassis: basic ${chassis.item.props.category} "${chassis.item.name}"`, warnings: chassis.note ? [chassis.note] : [],
        } }], { worldItems });
        baseline = RS.runArm(baseParty, scope.enemies, arm);
      }
      baseline = baseline ?? RS.runArm(build(), scope.enemies, arm);
      const report = applySwaps(who, [{ slot, source }], { worldItems });
      if (!coverage) {
        coverage = coverageOf(who, source, report);
        coverage.chassis = chassis ? `${chassis.item.name}${chassis.note ? ` (${chassis.note})` : ""}` : null;
      }
      const withItem = RS.runArm(party, scope.enemies, arm);
      rows.push({ ...where, wearer: who.name, chassis: chassis?.item.name ?? null, ...priceArms(scope.level, who.name, baseline, withItem) });
      if (onArm) onArm(rows[rows.length - 1]);
    }
  }
  return { rows, coverage };
}

// Rows -> per-group means and the Part 5 level check. `budget` in % (null: no verdict).
// L20 end: rows at L25 or below; L50 end: rows at L46 or above. The house roster answers
// when it has rows there; the rulebook base answers otherwise, and the verdict says which.
function summarize(rows, budget = null) {
  const ok = rows.filter((r) => !r.skipped);
  const keys = [...new Set(ok.map((r) => `${r.kind}\u0000${r.group}`))];
  const byGroup = keys.map((k) => {
    const [kind, group] = k.split("\u0000");
    const rs = ok.filter((r) => r.kind === kind && r.group === group);
    const f = (fn) => mean(rs.map(fn));
    return {
      kind, group, levels: [...new Set(rs.map((r) => r.level))].sort((a, b) => a - b), n: rs.length,
      value: f((r) => r.value), min: Math.min(...rs.map((r) => r.value)), max: Math.max(...rs.map((r) => r.value)),
      offense: f((r) => r.offense), defense: f((r) => r.defense), partyOffense: f((r) => r.partyOffense),
      actionsKept: f((r) => r.actionsKept), koPts: f((r) => r.koPts), lossPts: f((r) => r.lossPts),
      roundsBase: f((r) => r.rounds.baseline), roundsItem: f((r) => r.rounds.withItem),
      wonInOneBase: f((r) => r.wonInOne.baseline), wonInOneItem: f((r) => r.wonInOne.withItem),
    };
  });
  const at = (kind, pred) => mean(ok.filter((r) => r.kind === kind && pred(r.level)).map((r) => r.value));
  const early = { house: at("house", (l) => l <= 25), base: at("base", (l) => l <= 25) };
  const late = { house: at("house", (l) => l >= 46), base: at("base", (l) => l >= 46) };
  const house = mean(ok.filter((r) => r.kind === "house").map((r) => r.value));
  let verdict = null;
  if (budget != null) {
    const pick = (o) => (o.house != null ? ["house", o.house] : ["base", o.base]);
    const [earlySource, earlyValue] = pick(early);
    const [lateSource, lateValue] = pick(late);
    verdict = {
      budget, house, houseOk: house == null ? null : house <= budget,
      early: earlyValue, earlySource, earlyOk: earlyValue == null ? null : earlyValue <= budget,
      late: lateValue, lateSource, lateOk: lateValue == null ? null : lateValue >= budget / 2,
    };
  }
  return { byGroup, house, early, late, verdict };
}

module.exports = { RARITY_BUDGET, priceArms, coverageOf, measureItem, summarize };
