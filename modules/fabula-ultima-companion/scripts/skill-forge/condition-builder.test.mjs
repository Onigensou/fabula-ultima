// ============================================================================
// Condition builder — model, compile/parse, and the corpus round-trip.
//
//     node scripts/skill-forge/condition-builder.test.mjs
//
// THE INVARIANT THIS EXISTS FOR:
//   parse() may only succeed when compile() reproduces the author's string
//   EXACTLY. A builder that half-understands an expression and rewrites it is
//   worse than one that declines — the author gets a silently different gate,
//   which is the failure mode this whole layer exists to end.
//
//   So every corpus formula must land in exactly one of two buckets:
//     representable  -> compile(parse(s)) === s (modulo whitespace)
//     declined       -> parse(s) === null, UI keeps the raw text
//   A third bucket — parsed but altered — is a hard failure.
// ============================================================================

const cb = await import("./condition-builder.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── compile ─────────────────────────────────────────────────────────────────
console.log("\n— compile —");
eq("one clause", cb.compile({ clauses: [{ left: "HAS_SHIELD", op: "==", right: "1" }] }),
  "HAS_SHIELD == 1");
eq("two clauses, AND", cb.compile({ join: "&&", clauses: [
  { left: "SL", op: ">=", right: "2" }, { left: "CUR_MP", op: ">=", right: "10" }] }),
  "SL >= 2 && CUR_MP >= 10");
eq("two clauses, OR", cb.compile({ join: "||", clauses: [
  { left: "CRIT", op: "==", right: "1" }, { left: "FUMBLE", op: "==", right: "1" }] }),
  "CRIT == 1 || FUMBLE == 1");
eq("an empty condition compiles to nothing", cb.compile({ clauses: [] }), "");
eq("a null condition compiles to nothing", cb.compile(null), "");

// ── parse ───────────────────────────────────────────────────────────────────
console.log("\n— parse —");
eq("a simple clause", cb.parse("HAS_SHIELD == 1"),
  { join: "&&", clauses: [{ left: "HAS_SHIELD", op: "==", right: "1" }] });
eq(">= is not split by the > rule", cb.parse("SL >= 2").clauses[0].op, ">=");
eq("<= is not split by the < rule", cb.parse("SL <= 2").clauses[0].op, "<=");
eq("!= survives", cb.parse("SL != 2").clauses[0].op, "!=");
eq("an OR condition keeps its join", cb.parse("CRIT == 1 || FUMBLE == 1").join, "||");
eq("a string-valued right side is allowed",
  cb.parse("PERFORMED_SKILL == Dodge").clauses[0].right, "Dodge");

console.log("\n— parse DECLINES what it cannot represent —");
eq("parentheses", cb.parse("(A == 1 || B == 1) && C == 1"), null);
eq("arithmetic on the right", cb.parse("SL >= CUR_MP / 2"), null);
eq("arithmetic on the left", cb.parse("SL + 1 >= 2"), null);
eq("mixed connectives", cb.parse("A == 1 && B == 1 || C == 1"), null);
eq("a bare identifier with no operator", cb.parse("HAS_SHIELD"), null);
eq("prose", cb.parse("When you have a Minion"), null);
eq("an empty string", cb.parse(""), null);
eq("a lowercase left side is not an identifier", cb.parse("shield == 1"), null);

// ── explain ─────────────────────────────────────────────────────────────────
console.log("\n— explain —");
eq("a catalogued boolean reads as a sentence",
  cb.explain(cb.parse("HAS_SHIELD == 1")), "I have a shield equipped");
eq("a negated boolean says NOT",
  cb.explain(cb.parse("HAS_SHIELD == 0")), "NOT: I have a shield equipped");
eq("a number comparison reads naturally",
  cb.explain(cb.parse("SL >= 2")), "Skill level is at least 2");
eq("two clauses are joined with AND",
  cb.explain(cb.parse("SL >= 2 && CUR_MP >= 10")),
  "Skill level is at least 2  AND  Current MP is at least 10");
eq("an empty condition is 'always'", cb.explain(null), "(always)");

// ── identifier descriptions ─────────────────────────────────────────────────
console.log("\n— describeIdentifier —");
eq("a catalogued name", cb.describeIdentifier("CUR_MP").label, "Current MP");
eq("a prefix family expands", cb.describeIdentifier("HAS_STATUS_POISONED").label,
  "I have the status Poisoned");
eq("a prefix family knows its kind", cb.describeIdentifier("AE_COUNT_BIMAGUS").kind, "number");
eq("wellspring strips the _AVAILABLE suffix",
  cb.describeIdentifier("WELLSPRING_FIRE_AVAILABLE").label, "The Fire wellspring is available");
// Never refuse to describe: the validator decides what is real, not this.
eq("an unlisted name still gets a label",
  cb.describeIdentifier("SOME_NEW_THING").label, "Some New Thing");
eq("an unlisted name is marked as such", cb.describeIdentifier("SOME_NEW_THING").unlisted, true);

// ── THE CORPUS ROUND-TRIP ───────────────────────────────────────────────────
console.log("\n— corpus round-trip (the contract) —");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { collectFormulas } = await import("../lint/skill-validator.js");
  const base = path.resolve(process.cwd(), "..", "..", "worlds", "fabula-ultima-2", "_authored-export");

  const formulas = [];
  if (fs.existsSync(base)) {
    for (const dir of ["items", "actors"]) {
      const full = path.join(base, dir);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        let j; try { j = JSON.parse(fs.readFileSync(path.join(full, f), "utf8")); } catch { continue; }
        const list = dir === "items" ? [j] : [j, ...(j.items || [])];
        for (const d of list) for (const c of collectFormulas(d)) formulas.push(c.formula);
      }
    }
  }

  let represented = 0, declined = 0;
  const altered = [];
  for (const f of formulas) {
    const model = cb.parse(f);
    if (!model) { declined += 1; continue; }
    const back = cb.compile(model);
    if (back === cb.normalizeSpacing(f)) represented += 1;
    else altered.push({ from: f, to: back });
  }

  eq("the corpus was found", formulas.length > 500, true);
  // THE invariant. Anything here is a formula the builder would silently rewrite.
  eq("NO formula is parsed but altered", altered.slice(0, 5), []);
  console.log(`        ${formulas.length} formulas: ${represented} representable, ` +
    `${declined} declined (raw text), ${altered.length} ALTERED`);
  const pct = Math.round((represented / Math.max(1, formulas.length)) * 100);
  console.log(`        builder covers ${pct}% of authored gates; the rest keep their text`);
  // Coverage is informational, not a pass condition — declining is always safe.
  eq("coverage is meaningful (over half)", pct > 50, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
