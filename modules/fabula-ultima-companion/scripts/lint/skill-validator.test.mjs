// ============================================================================
// Skill validator — rule harness.
//
//     node scripts/lint/skill-validator.test.mjs
//
// Every rule gets BOTH directions: a document that trips it and a neighbouring
// document that must not. One-directional rule tests are how a validator ends
// up flagging everything or nothing and still showing green.
//
// The module is pure, so there are no Foundry stubs to set up.
// ============================================================================

const {
  validateSkillDoc, validateMany, RULES,
  identifiersIn, parseProblems, liveRows, makeIdentifierChecker, collectFormulas,
} = await import("./skill-validator.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── Context ─────────────────────────────────────────────────────────────────
// A deliberately SMALL vocabulary: the rules must be driven by ctx, not by
// anything hardcoded, and a small set makes an accidental hardcode visible.
const VOCAB = {
  vocab: new Set(["HAS_SHIELD", "SL", "CUR_MP", "AE_FLAG"]),
  prefixes: ["VAR_", "HAS_STATUS_"],
};
const COLUMNS = {
  effect_table: new Set([
    "effect_kind", "effect_label", "target_ref", "chain_steps",
    "condition_formula", "grant_resource", "grant_amount", "ae_template_ref",
  ]),
  reaction_config_table: new Set([
    "reaction_trigger", "reaction_effect_ref", "reaction_passive_mode", "condition_formula",
  ]),
};
const PROPS = new Set([
  "name", "description", "skill_type", "skill_target", "duration", "cost",
  "level", "max_level", "isReaction", "availability_formula",
  "effect_table", "reaction_config_table",
]);
const REQUIRED = {
  grant: { all: ["grant_resource"], either: [] },
  chain: { all: ["chain_steps"], either: [] },
  apply_ae: { all: ["ae_template_ref"], either: [], unlessSet: ["ae_pool_tag"] },
  open_action_menu: { all: ["menu_option_refs"], either: [], unlessTrueStrict: ["free_mode"] },
  remove_ae: { all: [], either: [["ae_template_ref", "filter_tag"]] },
};
const CTX = {
  vocabulary: VOCAB,
  rowColumns: COLUMNS,
  declaredProps: PROPS,
  requiredFieldsByKind: REQUIRED,
};

// ── Fixture builder ─────────────────────────────────────────────────────────
function doc({ name = "Test Skill", props = {}, effects = [] } = {}) {
  return { name, system: { props }, effects };
}
/** Rows keyed like CSB's dynamic tables ("0", "1", ...). */
function rows(...list) {
  const out = {};
  list.forEach((r, i) => { out[String(i)] = r; });
  return out;
}
const codes = (d, ctx = CTX) => validateSkillDoc(d, ctx).findings.map((f) => f.code).sort();
const only = (d, code, ctx = CTX) =>
  validateSkillDoc(d, ctx).findings.filter((f) => f.code === code);

// ── Helpers ─────────────────────────────────────────────────────────────────
console.log("\n— helpers —");
eq("identifiersIn finds ALL_CAPS tokens", identifiersIn("HAS_SHIELD == 1 and MAX_HP >= 2"),
  ["HAS_SHIELD", "MAX_HP"]);
// The threshold is 2, paired with formula-audit. `SL` and `HR` are REAL
// identifiers that the old 3-char floor never checked.
eq("identifiersIn catches 2-char identifiers", identifiersIn("SL + HR"), ["SL", "HR"]);
eq("identifiersIn can still be raised", identifiersIn("SL + HR", 3), []);
// Prose detection is CALL-SYNTAX aware, so it needs no list of function names.
// The name list is what let this and formula-audit disagree about `chance`.
eq("nested builtin calls are not prose",
  parseProblems("max(chance(50), randint(1,3))"), []);
eq("an unknown function call is not prose either",
  parseProblems("someFutureFn(2)"), []);
eq("a bare word beside a call still reads as prose",
  parseProblems("chance roulette"), ["looks like prose, not a formula"]);
eq("identifiersIn ignores tokens inside string literals",
  identifiersIn('equalText(NAME, "BIG_SCARY_WORD")'), ["NAME"]);
eq("identifiersIn still ignores single letters", identifiersIn("A + BB + CCC"), ["BB", "CCC"]);

eq("parseProblems accepts a normal gate", parseProblems("HAS_SHIELD == 1"), []);
eq("parseProblems accepts a bare builtin call", parseProblems("chance(25)"), []);
eq("parseProblems accepts nested calls", parseProblems("min(SL, floor(CUR_MP / 10))"), []);
eq("parseProblems catches unbalanced parens", parseProblems("min(SL, 2"),
  ["unbalanced parentheses"]);
eq("parseProblems catches a stray close paren", parseProblems("SL) + 1"),
  ["unbalanced parentheses"]);
eq("parseProblems catches an unbalanced quote", parseProblems('equalText(X, "a)'),
  ["unbalanced double quote"]);
eq("parseProblems catches prose", parseProblems("When you have a Minion"),
  ["looks like prose, not a formula"]);

eq("liveRows drops $deleted tombstones",
  liveRows({ 0: { effect_label: "a" }, 1: { $deleted: true, effect_label: "b" } })
    .map((r) => r.row.effect_label), ["a"]);
eq("liveRows tolerates a missing table", liveRows(undefined), []);

eq("makeIdentifierChecker accepts a function", makeIdentifierChecker((n) => n === "X")("X"), true);
eq("makeIdentifierChecker honours prefixes", makeIdentifierChecker(VOCAB)("VAR_ANYTHING"), true);
eq("makeIdentifierChecker returns null with nothing to check",
  makeIdentifierChecker({ vocab: [], prefixes: [] }), null);

// ── FORMULA_IDENT_UNKNOWN ───────────────────────────────────────────────────
console.log("\n— FORMULA_IDENT_UNKNOWN —");
eq("flags a typo'd identifier",
  codes(doc({ props: { availability_formula: "HAS_SHEILD == 1" } })),
  ["FORMULA_IDENT_UNKNOWN"]);
eq("accepts the correct spelling",
  codes(doc({ props: { availability_formula: "HAS_SHIELD == 1" } })), []);
eq("accepts a dynamic-prefix identifier",
  codes(doc({ props: { availability_formula: "VAR_BURN_STACKS >= 3" } })), []);
eq("accepts an uppercase CALL served by the resolver",
  codes(doc({ props: { availability_formula: "AE_FLAG(NAME, KEY)" } })).length > 0, true);
eq("names the offending identifier, not the whole formula",
  only(doc({ props: { availability_formula: "SL + BAD_IDENT" } }), "FORMULA_IDENT_UNKNOWN")
    .map((f) => f.identifier), ["BAD_IDENT"]);
eq("checks row-level condition_formula too",
  codes(doc({ props: { effect_table: rows({
    effect_kind: "grant", effect_label: "g", grant_resource: "mp",
    condition_formula: "NOPE_IDENT > 0",
  }) } })), ["FORMULA_IDENT_UNKNOWN"]);
eq("checks AE-change formulas (no system.props needed)",
  codes(doc({ effects: [{ name: "Aloft", changes: [
    { key: "cannot_be_targeted_by_unless", value: "MISSPELLED_FLY == 1" },
  ] }] })), ["FORMULA_IDENT_UNKNOWN"]);
eq("a bare number is not an identifier problem",
  codes(doc({ props: { availability_formula: "1" } })), []);
eq('"-" is an authored not-applicable, not a formula',
  codes(doc({ props: { availability_formula: "-" } })), []);

// ── FORMULA_UNPARSEABLE ─────────────────────────────────────────────────────
console.log("\n— FORMULA_UNPARSEABLE —");
eq("flags prose in a gate",
  codes(doc({ props: { availability_formula: "When you have a Minion" } })),
  ["FORMULA_UNPARSEABLE"]);
eq("does NOT also report identifiers inside unparseable text",
  only(doc({ props: { availability_formula: "When you have a BAD_IDENT Minion" } }),
    "FORMULA_IDENT_UNKNOWN").length, 0);
eq("flags unbalanced parens",
  codes(doc({ props: { availability_formula: "min(SL, 2" } })), ["FORMULA_UNPARSEABLE"]);

// ── ROW_COLUMN_UNDECLARED ───────────────────────────────────────────────────
console.log("\n— ROW_COLUMN_UNDECLARED —");
eq("flags a row field with no template column",
  codes(doc({ props: { effect_table: rows({
    effect_kind: "grant", effect_label: "g", grant_resource: "mp", summon_max: "2",
  }) } })), ["ROW_COLUMN_UNDECLARED"]);
eq("does not flag declared fields",
  codes(doc({ props: { effect_table: rows({
    effect_kind: "grant", effect_label: "g", grant_resource: "mp",
  }) } })), []);
eq("ignores $deleted rows entirely",
  codes(doc({ props: { effect_table: rows({
    $deleted: true, effect_kind: "grant", summon_max: "2",
  }) } })), []);
eq("is a warning, not an error (row keys are not pruned)",
  only(doc({ props: { effect_table: rows({
    effect_kind: "grant", effect_label: "g", grant_resource: "mp", summon_max: "2",
  }) } }), "ROW_COLUMN_UNDECLARED")[0].severity, "warning");
// CSB stamps keys onto rows wholesale, so most undeclared keys carry "".
// Without this filter the corpus reports 438 findings instead of 302, and the
// extra 136 are empty cells nobody can lose anything by losing.
eq("does NOT flag an undeclared column that is blank",
  codes(doc({ props: { effect_table: rows({
    effect_kind: "grant", effect_label: "g", grant_resource: "mp", summon_max: "",
  }) } })), []);

// ── PROP_UNDECLARED ─────────────────────────────────────────────────────────
console.log("\n— PROP_UNDECLARED —");
eq("flags an undeclared top-level prop",
  codes(doc({ props: { details_roller: "x" } })), ["PROP_UNDECLARED"]);
eq("does not flag declared props", codes(doc({ props: { cost: "10 MP" } })), []);
eq("is an error (reloadTemplate deletes it)",
  only(doc({ props: { details_roller: "x" } }), "PROP_UNDECLARED")[0].severity, "error");
// Severity splits on whether the ENGINE READS the key. Both classes are
// "reloadTemplate deletes this"; only one loses something that runs.
{
  const ctxRead = { ...CTX, engineReadProps: new Set(["details_roller"]) };
  eq("an engine-READ undeclared prop is an error",
    codes(doc({ props: { details_roller: "x" } }), ctxRead), ["PROP_UNDECLARED"]);
  eq("an UNREAD undeclared prop is only a warning",
    codes(doc({ props: { abandoned_field: "x" } }), ctxRead), ["PROP_UNDECLARED_UNREAD"]);
  eq("the unread message says nothing will notice",
    /nothing will notice/.test(
      only(doc({ props: { abandoned_field: "x" } }), "PROP_UNDECLARED_UNREAD", ctxRead)[0].message), true);
  // No readership set supplied => everything stays an error. Nothing is
  // downgraded on missing input; that would be the permissive direction.
  eq("without the readership set, nothing is downgraded",
    codes(doc({ props: { abandoned_field: "x" } })), ["PROP_UNDECLARED"]);
}
eq("does NOT flag an undeclared prop that is blank (deleting \"\" loses nothing)",
  codes(doc({ props: { details_roller: "" } })), []);
eq("ignores CSB bookkeeping keys that every instance carries",
  codes(doc({ props: { name: "X", img: "a.png", id: "abc", uuid: "Item.abc", uniqueId: "u" } })), []);

// ── REQUIRED_FIELD_MISSING ──────────────────────────────────────────────────
console.log("\n— REQUIRED_FIELD_MISSING —");
eq("flags a grant row with no resource",
  codes(doc({ props: { effect_table: rows({ effect_kind: "grant", effect_label: "g" }) } })),
  ["REQUIRED_FIELD_MISSING"]);
eq("accepts a grant row with a resource",
  codes(doc({ props: { effect_table: rows({
    effect_kind: "grant", effect_label: "g", grant_resource: "mp",
  }) } })), []);
eq("honours unlessSet exemptions",
  codes(doc({ props: { effect_table: rows({
    effect_kind: "apply_ae", effect_label: "a", ae_pool_tag: "burn",
  }) } })).filter((c) => c === "REQUIRED_FIELD_MISSING"), []);
eq("honours unlessTrueStrict — real boolean exempts",
  only(doc({ props: { effect_table: rows({
    effect_kind: "open_action_menu", effect_label: "m", free_mode: true,
  }) } }), "REQUIRED_FIELD_MISSING").length, 0);
eq('unlessTrueStrict does NOT accept the string "true"',
  only(doc({ props: { effect_table: rows({
    effect_kind: "open_action_menu", effect_label: "m", free_mode: "true",
  }) } }), "REQUIRED_FIELD_MISSING").length, 1);
eq("either-groups are satisfied by any member",
  only(doc({ props: { effect_table: rows({
    effect_kind: "remove_ae", effect_label: "r", filter_tag: "burn",
  }) } }), "REQUIRED_FIELD_MISSING").length, 0);
eq("either-groups flag when no member is set",
  only(doc({ props: { effect_table: rows({ effect_kind: "remove_ae", effect_label: "r" }) } }),
    "REQUIRED_FIELD_MISSING").length, 1);
eq("an unknown kind requires nothing (absent != nothing required)",
  only(doc({ props: { effect_table: rows({ effect_kind: "notify", effect_label: "n" }) } }),
    "REQUIRED_FIELD_MISSING").length, 0);

// ── SPELL_DURATION_BLANK ────────────────────────────────────────────────────
console.log("\n— SPELL_DURATION_BLANK —");
eq("flags a Spell with no duration",
  codes(doc({ props: { skill_type: "Spell", duration: "", skill_target: "One Enemy" } })),
  ["SPELL_DURATION_BLANK"]);
eq("accepts a Spell with a duration",
  codes(doc({ props: { skill_type: "Spell", duration: "Scene", skill_target: "One Enemy" } })), []);
eq('accepts "-" as an authored answer',
  codes(doc({ props: { skill_type: "Spell", duration: "-", skill_target: "One Enemy" } })), []);
eq("does not apply to non-Spells",
  codes(doc({ props: { skill_type: "Active", duration: "", skill_target: "Self" } })), []);

// ── SKILL_TARGET_BLANK (scope is the whole rule) ────────────────────────────
console.log("\n— SKILL_TARGET_BLANK —");
eq("flags an Active skill with no target",
  codes(doc({ props: { skill_type: "Active", skill_target: "" } })), ["SKILL_TARGET_BLANK"]);
eq("does NOT flag a Passive (212 of these exist and are correct)",
  codes(doc({ props: { skill_type: "Passive", skill_target: "" } })), []);
eq("does NOT flag a reaction",
  codes(doc({ props: { skill_type: "Active", skill_target: "", isReaction: true } })), []);
eq("does NOT flag something driven by a trigger row",
  codes(doc({ props: {
    skill_type: "Active", skill_target: "",
    reaction_config_table: rows({ reaction_trigger: "turn_start", reaction_effect_ref: "x" }),
  } })), []);
// "-" is NOT an authored answer for THIS field. User ruling 2026-09-22: every
// action should declare a target, even Self; a dash is leftover or incomplete
// back-filling. The engine agrees — compose-action.js:903 makes only
// blank-or-/^self$/i mean self, so "-" opens the ENEMY picker.
eq('flags "-" — the engine does not read it as "no target"',
  codes(doc({ props: { skill_type: "Active", skill_target: "-" } })), ["SKILL_TARGET_BLANK"]);
eq('the "-" message says what actually happens, not just "no target"',
  /enemy picker/.test(only(doc({ props: { skill_type: "Active", skill_target: "-" } }),
    "SKILL_TARGET_BLANK")[0].message), true);
eq("a real target is still accepted",
  codes(doc({ props: { skill_type: "Active", skill_target: "Self" } })), []);
// The per-field split: duration KEEPS its "-" exemption (passive-shaped spells).
eq('duration still accepts "-" while skill_target does not',
  codes(doc({ props: { skill_type: "Spell", duration: "-", skill_target: "One Enemy" } })), []);
eq("ignores a document with no skill_target key at all",
  codes(doc({ props: { skill_type: "Active" } })), []);

// ── The skip contract ───────────────────────────────────────────────────────
console.log("\n— skip contract —");
{
  const bad = doc({ props: {
    availability_formula: "TOTAL_NONSENSE == 1",
    details_roller: "x",
    effect_table: rows({ effect_kind: "grant", effect_label: "g", summon_max: "2" }),
  } });
  const r = validateSkillDoc(bad, {});
  eq("no ctx => context-dependent rules produce NO findings", r.findings.map((f) => f.code), []);
  eq("no ctx => every skipped rule is named", r.skipped.length, 4);
  eq("skip text names the missing input",
    r.skipped.some((s) => s.includes("no vocabulary supplied")), true);

  const partial = validateSkillDoc(bad, { vocabulary: VOCAB });
  eq("partial ctx runs what it can", partial.findings.map((f) => f.code), ["FORMULA_IDENT_UNKNOWN"]);
  eq("partial ctx still reports the rest as skipped", partial.skipped.length, 3);
}

// ── Review-gate regressions (each of these shipped green once) ──────────────
console.log("\n— review-gate regressions —");
{
  // GATE 1: ROW_COLUMN_UNDECLARED silently no-op'd. `ctx.rowColumns` was a
  // truthy object whose members were null, so the outer guard passed, the inner
  // `continue` skipped every table, and the rule reported PASSED having checked
  // nothing — with nothing in `skipped`. This is the exact shape the driver
  // builds for a template that has no such tables.
  const d = doc({ props: { effect_table: rows({
    effect_kind: "grant", effect_label: "g", grant_resource: "mp",
    bogus_undeclared_col: "AUTHORED VALUE",
  }) } });
  const r = validateSkillDoc(d, { rowColumns: { effect_table: null, reaction_config_table: null } });
  eq("null column sets do NOT read as a pass",
    r.skipped.some((s) => s.includes("ROW_COLUMN_UNDECLARED on effect_table")), true);
  eq("each missing table is named separately",
    r.skipped.filter((s) => s.startsWith("ROW_COLUMN_UNDECLARED on")).length, 2);
}
{
  // GATE 1: REQUIRED_FIELD_MISSING duplicated three of the world sweep's codes
  // (CHAIN_EMPTY / CONSUME_CHARGE_KEY_MISSING / APPLY_AE_NO_TEMPLATE). The two
  // linters are concatenated by callers, so the author saw each twice — and for
  // apply_ae with conflicting severities.
  const ctx2 = { requiredFieldsByKind: {
    chain: { all: ["chain_steps"], either: [] },
    consume_charge: { all: ["charge_key"], either: [] },
    apply_ae: { all: ["ae_template_ref"], either: [] },
    grant: { all: ["grant_resource"], either: [] },
  } };
  for (const kind of ["chain", "consume_charge", "apply_ae"]) {
    eq(`${kind} is left to the world sweep`,
      validateSkillDoc(doc({ props: { effect_table: rows({ effect_kind: kind, effect_label: "x" }) } }),
        ctx2).findings.length, 0);
  }
  eq("a kind the sweep does NOT cover is still checked",
    validateSkillDoc(doc({ props: { effect_table: rows({ effect_kind: "grant", effect_label: "x" }) } }),
      ctx2).findings.map((f) => f.code), ["REQUIRED_FIELD_MISSING"]);
}
{
  // GATE 1: behaviour carried on an Active Effect was not walked at all, and
  // was not named in `skipped`. Per the equipment policy an AE is the MANDATED
  // carrier for gear behaviour, so a gear item's entire implementation could
  // validate clean while nothing had been looked at. 123 such AEs in the corpus.
  const gear = doc({ name: "Gear", effects: [{
    name: "Worn", flags: { "fabula-ultima-companion": { reactionConfig: {
      reaction_config_table: rows({ reaction_trigger: "turn_start", condition_formula: "NOT_REAL >= 1" }),
      effect_table: rows({ effect_kind: "grant", effect_label: "g" }),
    } } },
  }] });
  const r = validateSkillDoc(gear, CTX);
  eq("AE-carried gate formulas are checked",
    r.findings.some((f) => f.code === "FORMULA_IDENT_UNKNOWN"), true);
  eq("AE-carried effect rows are checked",
    r.findings.some((f) => f.code === "REQUIRED_FIELD_MISSING"), true);
  eq("the finding names the AE it came from",
    r.findings[0].location.startsWith('effects["Worn"].reactionConfig.'), true);
}
{
  // GATE 1: the fix text told the author to write "-", but compose-action.js
  // computes isSelf from blank-or-/^self$/i only — so "-" opens the ENEMY
  // picker. The authoring UI renders this string verbatim to a non-programmer.
  eq("SKILL_TARGET_BLANK does not recommend the dash sentinel",
    /"-"/.test(RULES.SKILL_TARGET_BLANK.fix), false);
}

// ── Finding shape (the authoring UI renders these verbatim) ─────────────────
console.log("\n— finding shape —");
{
  const f = only(doc({ props: { availability_formula: "HAS_SHEILD == 1" } }),
    "FORMULA_IDENT_UNKNOWN")[0];
  eq("carries a location", f.location, "system.props.availability_formula");
  eq("carries the item name", f.itemName, "Test Skill");
  eq("carries the rule title", f.title, RULES.FORMULA_IDENT_UNKNOWN.title);
  eq("carries a why", f.why.length > 20, true);
  eq("carries a fix", f.fix.length > 10, true);
  eq("every rule in the catalogue has a severity/title/why/fix",
    Object.values(RULES).every((r) => r.severity && r.title && r.why && r.fix), true);
}

// ── Rollup ──────────────────────────────────────────────────────────────────
console.log("\n— validateMany —");
{
  const r = validateMany([
    doc({ name: "A", props: { availability_formula: "BAD_ONE == 1" } }),
    doc({ name: "B", props: { details_roller: "x" } }),
    doc({ name: "C", props: { cost: "10 MP" } }),
  ], CTX);
  eq("totals across documents", r.summary.total, 2);
  eq("counts errors", r.summary.errors, 2);
  eq("groups by code", r.summary.byCode, { FORMULA_IDENT_UNKNOWN: 1, PROP_UNDECLARED: 1 });
  eq("attributes each finding to its document",
    r.findings.map((f) => f.itemName).sort(), ["A", "B"]);
}

// ── Self-test: prove this harness can still go red ──────────────────────────
// formula-audit's first draft shipped three false positives, so "the suite is
// green" is only worth something if green is reachable from both sides.
console.log("\n— self-test —");
{
  const clean = doc({ props: {
    skill_type: "Active", skill_target: "One Enemy", duration: "Instantaneous",
    availability_formula: "HAS_SHIELD == 1",
    effect_table: rows({ effect_kind: "grant", effect_label: "g", grant_resource: "mp" }),
  } });
  eq("a fully correct document produces nothing", codes(clean), []);

  const dirty = doc({ props: {
    skill_type: "Active", skill_target: "",
    availability_formula: "NOT_A_THING == 1",
    details_roller: "x",
    effect_table: rows({ effect_kind: "grant", effect_label: "g", summon_max: "2" }),
  } });
  eq("a maximally broken document trips every applicable rule", codes(dirty), [
    "FORMULA_IDENT_UNKNOWN", "PROP_UNDECLARED",
    "REQUIRED_FIELD_MISSING", "ROW_COLUMN_UNDECLARED", "SKILL_TARGET_BLANK",
  ]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
