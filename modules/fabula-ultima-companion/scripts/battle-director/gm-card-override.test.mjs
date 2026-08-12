import {
  EMPTY_GM_OVERRIDE, GM_DIE_SIZES, normalizeGmOverride, isGmOverrideEmpty, mergeGmOverride,
  composeGmRoll, gmDamageInput, applyGmDamageInput, composeGmDefenseOverrides, gmHitOverrideMap,
  applyGmDamageOverrides, recomputeHitTokenUuids, gmOverrideDeltaRows, describeGmEditors,
  summarizeGmOverride, isGmEditableRow,
  gmReactionKey, gmReactionDecision, gmReactionDecisionChanges, isGmEditableReaction,
  readGmReopenKeys, gmReactionBlocksAutoFire,
  applyGmTargetRemovals, gmTargetsToAdd, reduceGmTargetRows,
} from "./gm-card-override.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const ok = (name, cond) => eq(name, !!cond, true);

const ED = { userId: "u1", userName: "Main GM", at: 1 };
const ED2 = { userId: "u2", userName: "Support GM", at: 2 };

// Stand-in for check.js deriveCheck — same contract, no Foundry needed.
const deriveCheck = ({ rA = 0, rB = 0, fumbleThreshold = 1, checkBonus = 0 } = {}) => {
  const a = Number(rA) || 0, b = Number(rB) || 0;
  const isFumble = a <= fumbleThreshold && b <= fumbleThreshold;
  return { rA: a, rB: b, hr: Math.max(a, b), total: a + b + checkBonus,
           checkBonus, isFumble, isCrit: !isFumble && a === b && a >= 6 };
};

console.log("\n— normalize / empty —");
eq("null is empty", isGmOverrideEmpty(null), true);
eq("EMPTY const is empty", isGmOverrideEmpty(EMPTY_GM_OVERRIDE), true);
eq("all-null roll normalizes to null", normalizeGmOverride({ roll: { rA: null, dA: null } }).roll, null);
eq("junk keys dropped", "evil" in normalizeGmOverride({ evil: 1 }), false);
eq("non-numeric dice dropped", normalizeGmOverride({ roll: { rA: "abc" } }).roll, null);
eq("floats truncated", normalizeGmOverride({ roll: { rA: 5.9 } }).roll, { rA: 5 });
eq("bogus die size rejected", normalizeGmOverride({ roll: { dA: 7, rA: 3 } }).roll, { rA: 3 });
eq("valid die size kept", normalizeGmOverride({ roll: { dA: 10, rA: 3 } }).roll, { dA: 10, rA: 3 });
eq("die sizes offered", GM_DIE_SIZES.includes(12) && GM_DIE_SIZES.includes(6), true);
eq("useHR:false is KEPT (not falsy-dropped)",
  normalizeGmOverride({ damage: { useHR: false } }).damage, { useHR: false });
eq("hit:false is KEPT", normalizeGmOverride({ perTarget: { t1: { hit: false } } }).perTarget, { t1: { hit: false } });
eq("bonus 0 is a real override", normalizeGmOverride({ roll: { bonus: 0 } }).roll, { bonus: 0 });
eq("a roll-only bag is not empty", isGmOverrideEmpty({ roll: { rA: 5 } }), false);
eq("a damage-only bag is not empty", isGmOverrideEmpty({ damage: { bonus: 3 } }), false);

console.log("\n— merge semantics —");
let bag = mergeGmOverride(null, { roll: { rA: 5, dA: 8 } }, ED);
eq("set dice", bag.roll, { dA: 8, rA: 5 });
ok("editor stamped", bag.editors.length === 1 && bag.editors[0].userId === "u1");
bag = mergeGmOverride(bag, { damage: { base: 12, useHR: false } }, ED2);
eq("damage set", bag.damage, { base: 12, useHR: false });
eq("roll untouched by an unrelated patch", bag.roll, { dA: 8, rA: 5 });
ok("second editor appended", bag.editors.length === 2);
bag = mergeGmOverride(bag, { roll: { rA: null } }, ED);
eq("null CLEARS one field, leaves sibling", bag.roll, { dA: 8 });
ok("same editor not duplicated", bag.editors.filter((e) => e.userId === "u1").length === 1);
eq("reset clears everything", isGmOverrideEmpty(mergeGmOverride(bag, { reset: true }, ED)), true);
ok("reset keeps the audit trail", mergeGmOverride(bag, { reset: true }, ED).editors.length > 0);

console.log("\n— replace (the editor's Save) —");
const before = mergeGmOverride(null, { roll: { rA: 9 }, damage: { bonus: 4 }, perTarget: { t1: { hit: true } } }, ED);
const saved = mergeGmOverride(before, { replace: { roll: { rA: 3 }, damage: null, perTarget: {} } }, ED2);
eq("replace sets the new roll", saved.roll, { rA: 3 });
eq("replace CLEARS an omitted section", saved.damage, null);
eq("replace clears per-target", saved.perTarget, {});
ok("replace preserves the audit trail", saved.editors.some((e) => e.userId === "u1"));
ok("replace stamps the new editor", saved.editors.some((e) => e.userId === "u2"));
eq("saving an untouched form leaves the card unedited",
  isGmOverrideEmpty(mergeGmOverride(null, { replace: { roll: null, damage: null, perTarget: {} } }, ED)), true);
eq("a form with only per-target nulls is still empty",
  isGmOverrideEmpty(mergeGmOverride(null,
    { replace: { roll: null, damage: null, perTarget: { t1: { hit: null, damage: null, defense: null } } } }, ED)), true);

console.log("\n— roll composition (dice, not totals) —");
const ar = { roll: { rA: 4, rB: 2, dA: 8, dB: 6, checkBonus: 1, total: 7, hr: 4 } };
eq("no roll override → null", composeGmRoll(ar, EMPTY_GM_OVERRIDE, deriveCheck), null);
const r1 = composeGmRoll(ar, { roll: { rA: 6 } }, deriveCheck);
eq("edited die value", r1.rA, 6);
eq("untouched die kept as rolled", r1.rB, 2);
eq("TOTAL is re-derived, never typed", r1.total, 9);
eq("HIGHEST ROLL follows the dice", r1.hr, 6);
eq("die sizes preserved", [r1.dA, r1.dB], [8, 6]);
ok("marked as GM-authored", r1.gmSet === true);
const rCrit = composeGmRoll(ar, { roll: { rA: 7, rB: 7 } }, deriveCheck);
eq("matching high dice derive a CRIT", rCrit.isCrit, true);
const rFum = composeGmRoll(ar, { roll: { rA: 1, rB: 1 } }, deriveCheck);
eq("double ones derive a FUMBLE", rFum.isFumble, true);
eq("fumble is not also a crit", rFum.isCrit, false);
// The bonus field is an ADJUSTMENT on top of the action's own bonus (here 1),
// matching the damage adjustment — not a replacement for it.
const rBonus = composeGmRoll(ar, { roll: { bonus: 10 } }, deriveCheck);
eq("adjustment ADDS to the existing bonus", rBonus.checkBonus, 11);
eq("total = dice + existing + adjustment", rBonus.total, 4 + 2 + 11);
eq("bonus does not touch HR", rBonus.hr, 4);
const rNeg = composeGmRoll(ar, { roll: { bonus: -3 } }, deriveCheck);
eq("a NEGATIVE adjustment subtracts", rNeg.checkBonus, -2);
eq("…and lands in the total", rNeg.total, 4 + 2 - 2);
const rZero = composeGmRoll(ar, { roll: { bonus: 0, rA: 5 } }, deriveCheck);
eq("a zero adjustment leaves the existing bonus intact", rZero.checkBonus, 1);
const rNoBonus = composeGmRoll(ar, { roll: { rA: 5 } }, deriveCheck);
eq("an untouched adjustment leaves the existing bonus intact", rNoBonus.checkBonus, 1);
eq("die SIZE can be changed", composeGmRoll(ar, { roll: { dA: 12, rA: 11 } }, deriveCheck).dA, 12);

console.log("\n— damage composition (base / HR / bonus) —");
eq("no damage override → null input", gmDamageInput(EMPTY_GM_OVERRIDE), null);
eq("untouched → engine values pass through", applyGmDamageInput(null, 10, 5), { flat: 10, hr: 5 });
eq("base replaces the engine base",
  applyGmDamageInput(gmDamageInput({ damage: { base: 20 } }), 10, 5), { flat: 20, hr: 5 });
eq("bonus adds on top",
  applyGmDamageInput(gmDamageInput({ damage: { bonus: 3 } }), 10, 5), { flat: 13, hr: 5 });
eq("a NEGATIVE damage adjustment subtracts — same behaviour as accuracy",
  applyGmDamageInput(gmDamageInput({ damage: { bonus: -4 } }), 10, 5), { flat: 6, hr: 5 });
eq("adjustment applies on top of a REPLACED base",
  applyGmDamageInput(gmDamageInput({ damage: { base: 20, bonus: -4 } }), 10, 5), { flat: 16, hr: 5 });
eq("HR unchecked drops the highest roll",
  applyGmDamageInput(gmDamageInput({ damage: { useHR: false } }), 10, 5), { flat: 10, hr: 0 });
eq("HR checked keeps it",
  applyGmDamageInput(gmDamageInput({ damage: { useHR: true } }), 10, 5), { flat: 10, hr: 5 });
eq("all three together",
  applyGmDamageInput(gmDamageInput({ damage: { base: 20, bonus: 3, useHR: false } }), 10, 5), { flat: 23, hr: 0 });
eq("base 0 is a real override, not 'unset'",
  applyGmDamageInput(gmDamageInput({ damage: { base: 0 } }), 10, 5), { flat: 0, hr: 5 });

console.log("\n— per-target —");
const pts = [
  { tokenUuid: "t1", actorUuid: "a1", defense: 12, hit: false, damage: 0, affinity: "NE" },
  { tokenUuid: "t2", actorUuid: "a2", defense: 10, hit: true, damage: 20, affinity: "VU" },
];
eq("gm defense row", composeGmDefenseOverrides({ perTarget: { t1: { defense: 8 } } }, [], pts),
  [{ tokenUuid: "t1", actorUuid: "a1", from: 12, to: 8, via: "GM adjustment", gm: true }]);
eq("engine defense rows kept first",
  composeGmDefenseOverrides({ perTarget: { t1: { defense: 8 } } }, [{ tokenUuid: "t2", from: 10, to: 13 }], pts).length, 2);
eq("hit map", gmHitOverrideMap({ perTarget: { t1: { hit: true }, t2: { hit: false } } }), { t1: true, t2: false });
eq("hit map null when nothing forced", gmHitOverrideMap({ perTarget: { t1: { damage: 5 } } }), null);
eq("grant rows are not editable", isGmEditableRow({ grantAmount: 5 }), false);
eq("unstudied rows ARE editable", isGmEditableRow({ studied: false, tokenUuid: "t1" }), true);

console.log("\n— IDEMPOTENCE (the core safety claim) —");
const ov = { perTarget: { t2: { damage: 7 } } };
const once = applyGmDamageOverrides(pts, ov);
const twice = applyGmDamageOverrides(once, ov);
eq("damage set", once[1].damage, 7);
eq("untouched row is the same object", once[0], pts[0]);
eq("APPLYING TWICE == ONCE", JSON.stringify(twice), JSON.stringify(once));
eq("no override → same array reference", applyGmDamageOverrides(pts, EMPTY_GM_OVERRIDE), pts);
// The roll and damage composers are pure functions of (engine value, override),
// so re-running them on their own output must not drift either.
const rOnce = composeGmRoll(ar, { roll: { rA: 6 } }, deriveCheck);
const rTwice = composeGmRoll({ roll: rOnce }, { roll: { rA: 6 } }, deriveCheck);
eq("roll composition is idempotent", rTwice.total, rOnce.total);
eq("…and stable on HR", rTwice.hr, rOnce.hr);

console.log("\n— hit list + delta rows + summary —");
eq("hit list from final rows", recomputeHitTokenUuids(pts, null), ["t2"]);
eq("null rows → fallback preserved", recomputeHitTokenUuids(null, ["x"]), ["x"]);
eq("delta row fields", gmOverrideDeltaRows(pts, { perTarget: { t1: { hit: true, defense: 8 } } })[0].fields,
  { hit: true, damage: false, defense: true });
eq("credit line", describeGmEditors({ editors: [ED, ED2] }), "Edited by Main GM, Support GM");
eq("no editors → null", describeGmEditors(null), null);
eq("summary lists what is set",
  summarizeGmOverride({ roll: { rA: 5 }, damage: { bonus: 2 }, perTarget: { t1: { hit: true } } }),
  "accuracy · damage · 1 target");
eq("summary pluralises", summarizeGmOverride({ perTarget: { t1: { hit: true }, t2: { hit: false } } }), "2 targets");
eq("nothing set → null summary", summarizeGmOverride(null), null);

console.log("\n— reactions: bag —");
const K = (r, c) => gmReactionKey(r, c);
eq("key shape", K("0", "Item.abc"), "0::Item.abc");
eq("reaction bag normalizes", normalizeGmOverride({ reactions: { "0::i1": true } }).reactions, { "0::i1": true });
eq("false is KEPT (suppress ≠ absent)", normalizeGmOverride({ reactions: { "0::i1": false } }).reactions, { "0::i1": false });
eq("non-boolean verdict dropped", normalizeGmOverride({ reactions: { "0::i1": "apply", "1::i1": 1 } }).reactions, {});
eq("a reaction-only bag is NOT empty", isGmOverrideEmpty({ reactions: { "0::i1": true } }), false);
eq("an all-junk reaction bag IS empty", isGmOverrideEmpty({ reactions: { "0::i1": "yes" } }), true);
let rbag = mergeGmOverride(null, { reactions: { "0::i1": true, "1::i2": false } }, ED);
eq("merge sets both", rbag.reactions, { "0::i1": true, "1::i2": false });
rbag = mergeGmOverride(rbag, { reactions: { "0::i1": null } }, ED);
eq("null CLEARS one verdict", rbag.reactions, { "1::i2": false });
eq("replace drops omitted verdicts",
  mergeGmOverride(rbag, { replace: { reactions: { "9::i9": true } } }, ED).reactions, { "9::i9": true });
eq("reset clears reactions too", isGmOverrideEmpty(mergeGmOverride(rbag, { reset: true }, ED)), true);
eq("decision lookup: force", gmReactionDecision(rbag, "1", "i2"), "skip");
eq("decision lookup: absent → null", gmReactionDecision(rbag, "0", "i1"), null);
eq("summary names the direction",
  summarizeGmOverride({ reactions: { "0::i1": true, "1::i2": false, "2::i3": false } }),
  "1 forced · 2 suppressed");

console.log("\n— reactions: which candidates are editable —");
eq("plain candidate", isGmEditableReaction({ rowKey: "0", carrierUuid: "i1" }), true);
eq("cost-unavailable is BLOCKED (mutation commits, cost aborts ⇒ half-applied)",
  isGmEditableReaction({ available: false, unavailableKind: "cost" }), false);
eq("a pre-spliced force add_target is BLOCKED (nothing removes a target)",
  isGmEditableReaction({ usesAddTarget: true, mode: "force" }), false);
eq("…and an ask-mode add_target too — the block is on the capability",
  isGmEditableReaction({ usesAddTarget: true, mode: "ask" }), false);
eq("condition-unavailable is NOT (its trigger never applied)",
  isGmEditableReaction({ available: false, unavailableKind: "condition" }), false);
eq("_addTarget is NOT (already spliced at click; suppress can't undo it)",
  isGmEditableReaction({ _addTarget: true }), false);

console.log("\n— reactions: reconciling a card's decisions —");
const CANDS = [
  { rowKey: "0", carrierUuid: "i1", carrierName: "Cognitive Focus" },   // auto-applied
  { rowKey: "0", carrierUuid: "i2", carrierName: "Protect" },           // undecided ask
  { rowKey: "1", carrierUuid: "i3", carrierName: "Barrage", _addTarget: true },
];
const cur = new Map([["0:i1", "apply"]]);
const base = new Map([["0:i1", "apply"]]);
const changesFor = (bag) => gmReactionDecisionChanges(CANDS, bag,
  (c) => cur.get(`${c.rowKey}:${c.carrierUuid}`) ?? null,
  (c) => base.get(`${c.rowKey}:${c.carrierUuid}`) ?? null);

eq("no bag → nothing changes", changesFor(null), []);
// THE trap this whole layer exists to avoid: a "green" run where nothing fired.
// Force must produce a real change entry, or a suppress/force test compares
// 0 mutations against 0 mutations and passes having proved nothing.
const forced = changesFor({ reactions: { [K("0", "i2")]: true } });
eq("forcing an undecided ask pill IS a change", forced.length, 1);
eq("…to apply, credited to the GM", [forced[0].decision, forced[0].byGm, forced[0].from], ["apply", true, null]);
const supp = changesFor({ reactions: { [K("0", "i1")]: false } });
eq("suppressing an auto-applied pill IS a change", [supp.length, supp[0].decision, supp[0].from], [1, "skip", "apply"]);
eq("_addTarget is never touched",
  changesFor({ reactions: { [K("1", "i3")]: false } }).length, 0);
// Absolute, therefore idempotent — the same claim the roll/damage sections make.
// A save that re-states the current state must repaint and broadcast nothing.
const sameBag = { reactions: { [K("0", "i1")]: true } };
eq("restating the CURRENT decision is a no-op", changesFor(sameBag), []);
// Clearing must restore what the CARD decided, not strand the GM's verdict.
cur.set("0:i1", "skip");   // as if a suppress had been applied
eq("clearing restores the engine's own verdict",
  changesFor({ reactions: {} }).map((c) => [c.carrierUuid, c.decision, c.byGm]),
  [["i1", "apply", false]]);
cur.set("0:i1", "apply");
cur.set("0:i2", "apply");  // as if a force had been applied
base.delete("0:i2");       // …to a pill the card never decided
eq("clearing a force on an UNDECIDED pill returns it to undecided",
  changesFor({ reactions: {} }).map((c) => [c.carrierUuid, c.decision]), [["i2", null]]);

console.log("\n— reactions: Ask again (back to pre-decision) —");
// Reopen is an ACTION on the patch, never a stored verdict. If it were stored it
// would re-fire on every later recompute and wipe whatever was decided since.
eq("reopen keys read off the patch", readGmReopenKeys({ reopen: ["0::i1", "1::i2"] }), ["0::i1", "1::i2"]);
eq("reopen deduped", readGmReopenKeys({ reopen: ["0::i1", "0::i1"] }), ["0::i1"]);
eq("junk reopen entries dropped", readGmReopenKeys({ reopen: [null, 7, "nonsense", "0::ok"] }), ["0::ok"]);
eq("absent reopen → empty", readGmReopenKeys({}), []);
// "Ask again" is TWO things stored differently: the ACTION (patch-only `reopen`,
// clears the decision now) and the RULE ("ask" in the bag, stops the candidate
// auto-firing again on a card re-post). The action must never replay; the rule
// must survive an F5.
eq("the RULE is stored", normalizeGmOverride({ reactions: { "0::i1": "ask" } }).reactions, { "0::i1": "ask" });
eq("junk that merely looks like it is still dropped",
  normalizeGmOverride({ reactions: { "0::i1": "asked", "1::i2": "APPLY" } }).reactions, {});
eq("an ask-only bag is NOT empty — it still forbids the auto-fire",
  isGmOverrideEmpty({ reactions: { "0::i1": "ask" } }), false);
// It is NOT a verdict: reconcile must fall through to whatever was decided
// SINCE, or answering the reopened question would be wiped on the next pass.
eq("ask is not a verdict", gmReactionDecision({ reactions: { "0::i1": "ask" } }, "0", "i1"), null);
eq("ask blocks the spawn auto-fire",
  gmReactionBlocksAutoFire({ reactions: { "0::i1": "ask" } }, "0", "i1"), true);
eq("a real verdict does not block the auto-fire",
  gmReactionBlocksAutoFire({ reactions: { "0::i1": true } }, "0", "i1"), false);
eq("summary counts reopened separately",
  summarizeGmOverride({ reactions: { "0::i1": "ask", "1::i2": true } }), "1 forced · 1 reopened");

// The card auto-applied Cheap Shot (`on` mode). The GM sends it back to
// undecided: the decision is deleted, NOT flipped to skip — those are different
// table calls, and only this one lets it be decided again.
const cur2 = new Map([["0:i1", "apply"]]);
const base2 = new Map([["0:i1", "apply"]]);
const reopenChanges = (bag, reopened) => gmReactionDecisionChanges(
  [{ rowKey: "0", carrierUuid: "i1", carrierName: "Cheap Shot" }], bag,
  (c) => cur2.get(`${c.rowKey}:${c.carrierUuid}`) ?? null,
  (c) => base2.get(`${c.rowKey}:${c.carrierUuid}`) ?? null,
  reopened);

// The host clears the base first (that is what "nobody has decided" means), so
// the ordinary want = gm ?? base computation lands on null by itself.
base2.delete("0:i1");
const reop = reopenChanges({}, new Set([K("0", "i1")]));
eq("reopen produces ONE change", reop.length, 1);
eq("…to undecided, not to skip", reop[0].decision, null);
eq("…flagged as the GM's doing", [reop[0].byGm, reop[0].reopened], [true, true]);
eq("…from the auto-applied state", reop[0].from, "apply");
// Once reopened and re-decided by a player, a later pass must NOT re-reopen it —
// the bag never recorded the action, so there is nothing to replay.
cur2.set("0:i1", "skip"); base2.set("0:i1", "skip");
eq("no stored reopen replays on the next pass", reopenChanges({}, new Set()), []);
// Suppress and reopen are genuinely different verdicts on the same pill.
cur2.set("0:i1", "apply"); base2.set("0:i1", "apply");
eq("suppress still means skip, not undecided",
  reopenChanges({ reactions: { [K("0", "i1")]: false } }, new Set())[0].decision, "skip");

console.log("\n— targets: add / remove / change —");
eq("both sides normalize + dedupe",
  normalizeGmOverride({ targets: { removed: ["a", "a"], added: ["b", "b", 7, null] } }).targets,
  { removed: ["a"], added: ["b"] });
// Removal is the destructive call; letting a token sit in both sets would make
// the result depend on which loop ran last.
eq("a token in BOTH sets is removed, not added",
  normalizeGmOverride({ targets: { removed: ["x"], added: ["x"] } }).targets, { removed: ["x"], added: [] });
eq("a targets-only bag is NOT empty", isGmOverrideEmpty({ targets: { removed: ["a"] } }), false);
eq("an all-junk targets bag IS empty", isGmOverrideEmpty({ targets: { added: [7, null] } }), true);
eq("summary names both directions",
  summarizeGmOverride({ targets: { removed: ["a", "b"], added: ["c"] } }), "−2 target · +1 target");
eq("replace clears an omitted targets section",
  mergeGmOverride(mergeGmOverride(null, { targets: { removed: ["a"] } }, ED),
    { replace: { roll: null, damage: null, perTarget: {} } }, ED).targets, { removed: [], added: [] });

const TGT = [
  { tokenUuid: "T1", name: "Ally" },
  { tokenUuid: "T2", name: "Enemy" },
  { tokenUuid: "T3", name: "Bystander" },
];
const ROWS = [
  { tokenUuid: "T1", damage: 5 }, { tokenUuid: "T2", damage: 9 }, { tokenUuid: "T3", damage: 4 },
];
const cutOne = applyGmTargetRemovals(TGT, ROWS, { targets: { removed: ["T2"] } });
eq("the target is dropped", cutOne.targets.map((t) => t.tokenUuid), ["T1", "T3"]);
eq("and its per-target ROW with it", cutOne.perTargets.map((r) => r.tokenUuid), ["T1", "T3"]);
eq("removal is counted", cutOne.removed, 1);
// The two arrays are joined by tokenUuid, never by index — a reaction may
// already have spliced them (add_target, shield_redirect), so position lies.
const skewed = applyGmTargetRemovals(TGT, [ROWS[2], ROWS[0], ROWS[1]], { targets: { removed: ["T1"] } });
eq("row filtering does not rely on array order",
  skewed.perTargets.map((r) => r.tokenUuid), ["T3", "T2"]);
eq("no removals → the SAME arrays back (no needless copy)",
  applyGmTargetRemovals(TGT, ROWS, EMPTY_GM_OVERRIDE).targets, TGT);
// Idempotence is the whole reason the bag stores absolute SETS: the recompute
// re-runs this on every preview click and again at CONFIRM.
const cutTwice = applyGmTargetRemovals(cutOne.targets, cutOne.perTargets, { targets: { removed: ["T2"] } });
eq("APPLYING A REMOVAL TWICE == ONCE",
  cutTwice.targets.map((t) => t.tokenUuid), cutOne.targets.map((t) => t.tokenUuid));
// Inputs must never be mutated: freezeActionResult deep-freezes target objects,
// so writing one throws in strict mode and kills the whole recompute pass.
eq("the input array is untouched", TGT.length, 3);

eq("an addition not yet present is reported",
  gmTargetsToAdd(TGT, { targets: { added: ["T9"] } }), ["T9"]);
eq("an addition ALREADY in the set is not re-added",
  gmTargetsToAdd(TGT, { targets: { added: ["T2"] } }), []);
eq("no additions → empty", gmTargetsToAdd(TGT, EMPTY_GM_OVERRIDE), []);
// "Change this target" is not a third operation — it is the two primitives,
// which is exactly how the editor presents it.
const swapBag = { targets: { removed: ["T1"], added: ["T9"] } };
eq("a CHANGE composes from remove + add",
  [applyGmTargetRemovals(TGT, ROWS, swapBag).targets.map((t) => t.tokenUuid),
   gmTargetsToAdd(TGT, swapBag)],
  [["T2", "T3"], ["T9"]]);

// ── reduceGmTargetRows ───────────────────────────────────────────────────────
// The editor's target list reduces its ROWS to the two sets. Every failure the
// design review found in this reduction was invisible to the rest of this file,
// because it used to live inside the editor's DOM closure.
const reduce = (rows) => reduceGmTargetRows(rows);
const ROW = (o) => ({ token: null, addToken: null, dropped: false, ...o });

eq("an untouched engine row contributes nothing",
  reduce([ROW({ token: "T1" })]), { added: [], removed: [] });
eq("a dropped engine row is REMOVED",
  reduce([ROW({ token: "T1", dropped: true })]), { added: [], removed: ["T1"] });
eq("a staged add is ADDED",
  reduce([ROW({ addToken: "T9" })]), { added: ["T9"], removed: [] });
// Discarded before it ever existed — it is in neither set, and in particular
// must NOT land in `removed`, which would make it unaddable (removal wins).
eq("a staged add, discarded, contributes to NEITHER set",
  reduce([ROW({ addToken: "T9", dropped: true })]), { added: [], removed: [] });
// The Protect case: the GM adds the protector, then a redirect moves it into
// the engine's own target set. Un-adding alone would leave it targeted while
// the editor had just shown a removal.
eq("a GM add the ENGINE also targets goes to REMOVED when dropped, not merely un-added",
  reduce([ROW({ token: "P", addToken: "P", dropped: true })]), { added: [], removed: ["P"] });
eq("...and is still an ADD while it stands",
  reduce([ROW({ token: "P", addToken: "P" })]), { added: ["P"], removed: [] });
// normalizeGmOverride is what stops the pair persisting.
eq("normalize drops the token from `added` once it is removed",
  normalizeGmOverride({ targets: reduce([ROW({ token: "P", addToken: "P", dropped: true })]) }).targets,
  { removed: ["P"], added: [] });
eq("a whole list reduces in one pass", reduce([
  ROW({ token: "A" }), ROW({ token: "B", dropped: true }),
  ROW({ addToken: "X" }), ROW({ addToken: "Y", dropped: true }),
  ROW({ token: "C", addToken: "C" }),
]), { added: ["X", "C"], removed: ["B"] });
eq("junk in the row list is skipped, not thrown on",
  reduce([null, undefined, ROW({ token: "A", dropped: true })]), { added: [], removed: ["A"] });
eq("a non-array is empty, not a throw", reduce(null), { added: [], removed: [] });

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
