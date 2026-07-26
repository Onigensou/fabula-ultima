/**
 * The starting bond: one target, one emotion, or nothing at all.
 *
 * The house rule allows a single emotion, but the underlying schema has three
 * paired fields. Most of what matters here is that picking in one pair clears
 * the others, so the draft can never present the sheet with two.
 */
const B = await import("./cc-step-bond.js");
const D = await import("./cc-draft.js");
const { CC_EMOTION_PAIRS } = await import("./cc-const.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};
const codes = (d) => D.validateStep(d, "bond").issues.map((i) => i.code);

// ── vocabulary matches the bond system ─────────────────────────────────────
eq("three pairs, one per emotion field", CC_EMOTION_PAIRS.length, 3);
eq("the field keys are e1/e2/e3", CC_EMOTION_PAIRS.map((p) => p.key), ["e1", "e2", "e3"]);
eq("the vocabulary matches BondUpdater.PAIRS",
  CC_EMOTION_PAIRS.map((p) => [p.pos, p.neg]),
  [["admiration", "inferiority"], ["loyalty", "mistrust"], ["affection", "hatred"]]);
eq("slot numbers line up with emotion_N_<slot>", CC_EMOTION_PAIRS.map((p) => p.slot), [1, 2, 3]);

// ── empty is valid ─────────────────────────────────────────────────────────
{
  const d = D.createDraft();
  eq("a fresh draft has no bond", B.bondIsEmpty(d), true);
  eq("no emotion chosen", B.chosenEmotion(d), null);
  eq("skipping the step is valid", codes(d), []);
}

// ── one emotion, and only one ──────────────────────────────────────────────
{
  const d = D.createDraft();
  B.setEmotion(d, "e2", "loyalty");
  eq("the emotion is recorded", B.chosenEmotion(d), { key: "e2", value: "loyalty" });
  eq("it lands in its own field", d.bond.e2, "loyalty");
  eq("the other fields stay empty", [d.bond.e1, d.bond.e3], ["", ""]);

  // Choosing from another pair replaces rather than adds — the allowance is one.
  B.setEmotion(d, "e3", "hatred");
  eq("a second choice replaces the first", B.chosenEmotion(d), { key: "e3", value: "hatred" });
  eq("the old field is cleared", d.bond.e2, "");
  eq("only one field is ever set",
    [d.bond.e1, d.bond.e2, d.bond.e3].filter(Boolean).length, 1);

  // Within a pair, swapping poles works the same way.
  B.setEmotion(d, "e3", "affection");
  eq("swapping poles within a pair", d.bond.e3, "affection");

  // Clicking the chosen one again unsets it.
  B.setEmotion(d, "e3", "affection");
  eq("re-picking toggles off", B.chosenEmotion(d), null);
  eq("...leaving every field empty", [d.bond.e1, d.bond.e2, d.bond.e3], ["", "", ""]);
}

// ── half a bond is not a thing ─────────────────────────────────────────────
{
  const target = D.createDraft();
  target.bond.name = "Mira";
  eq("a target with no emotion is rejected", codes(target), ["no_emotion"]);
  B.setEmotion(target, "e1", "admiration");
  eq("adding the emotion settles it", codes(target), []);

  const feeling = D.createDraft();
  B.setEmotion(feeling, "e1", "inferiority");
  eq("an emotion aimed at nobody is rejected", codes(feeling), ["no_target"]);
  feeling.bond.name = "The Duke";
  eq("naming the target settles it", codes(feeling), []);
}

// ── the schema still catches two emotions written past the helper ──────────
{
  const d = D.createDraft();
  d.bond.name = "Someone";
  d.bond.e1 = "admiration";
  d.bond.e2 = "loyalty";
  eq("two emotions are rejected", codes(d), ["too_many_emotions"]);
  eq("the count sees both", B.emotionCount(d), 2);

  // Clicking the first of the two must REPAIR to it, not toggle it off — a
  // toggle here would clear the field and break the bond a different way.
  B.setEmotion(d, "e1", "admiration");
  eq("setEmotion repairs rather than toggles", codes(d), []);
  eq("...keeping the clicked emotion", B.chosenEmotion(d), { key: "e1", value: "admiration" });
  eq("...and dropping the other", B.emotionCount(d), 1);

  // Once coherent, the same click toggles off as usual.
  B.setEmotion(d, "e1", "admiration");
  eq("a second click now toggles off", B.emotionCount(d), 0);
}

// ── emptiness accounts for every field ─────────────────────────────────────
{
  const d = D.createDraft();
  d.bond.rel = "childhood friend";
  eq("a relationship alone counts as touched", B.bondIsEmpty(d), false);
  eq("...but is not by itself invalid", codes(d), []);

  B.clearBond(d);
  eq("clearBond empties everything", B.bondIsEmpty(d), true);

  const full = D.createDraft();
  full.bond.name = "Mira"; full.bond.rel = "sister";
  B.setEmotion(full, "e3", "affection");
  eq("a complete bond is not empty", B.bondIsEmpty(full), false);
  B.clearBond(full);
  eq("clearBond wipes a complete bond too", B.bondIsEmpty(full), true);
  eq("...including the emotion", B.chosenEmotion(full), null);
  eq("...and the relationship", full.bond.rel, "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
