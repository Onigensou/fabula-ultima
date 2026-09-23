// ============================================================================
// Skill validator BRIDGE — in-game wiring harness.
//
//     node scripts/lint/skill-validator-bridge.test.mjs
//
// The bridge is what makes the validator exist inside Foundry. Stage 0 shipped
// without it and nothing noticed, because every other test runs in Node — so
// these assertions deliberately check the WIRING, not the rules:
//
//   • the resolver probe's sentinel is `null`, not `undefined`
//   • the probe answers every real identifier (no false unknowns)
//   • the template walker counts `label` / `activeEffectContainer` as declared
//   • registration actually lands on FUCompanion.api.lint
//   • the self-test can go red
//
// Foundry globals are stubbed just far enough for the module graph to load.
// ============================================================================

globalThis.Hooks = { on() {}, once(_e, fn) { globalThis.__readyFn = fn; }, callAll() {}, off() {} };
globalThis.canvas = { scene: null, tokens: { placeables: [] } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.CONFIG = {};

let _items = [];
globalThis.game = {
  get items() { return { contents: _items, get: (id) => _items.find((i) => i._id === id || i.id === id) }; },
  get actors() { return { contents: [] }; },
  user: { isGM: true },
  settings: { get: () => null, set: () => {} },
  modules: { get: () => ({ api: {} }) },
};

const bridge = await import("./skill-validator-bridge.js");
const { buildSkillResolver } = await import("../battle-director/skill-formulas.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── the sentinel ────────────────────────────────────────────────────────────
// The bug this caught: the validator's own comment claimed an unserved
// identifier returns `undefined`. It returns `null`. A probe written to the
// wrong spec reports EVERY identifier as unknown — silently, and in the
// permissive-looking direction of "everything is broken".
console.log("\n— resolver probe sentinel —");
{
  const r = buildSkillResolver({});
  eq("an unserved identifier is null, not undefined", r("TOTALLY_NOT_REAL"), null);
  eq("a served identifier returns a value", typeof r("SL") !== "undefined" && r("SL") !== null, true);
}

// ── no false unknowns across the real vocabulary ────────────────────────────
console.log("\n— probe vs the whole vocabulary —");
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../battle-director/skill-formulas.js", import.meta.url), "utf8");
  const vocab = new Set();
  for (const m of src.matchAll(/case\s+"([A-Z][A-Z0-9_]*)"\s*:/g)) vocab.add(m[1]);
  for (const m of src.matchAll(/name\s*===?\s*"([A-Z][A-Z0-9_]*)"/g)) vocab.add(m[1]);
  const r = buildSkillResolver({});
  const falseUnknown = [...vocab].filter((n) => { try { return r(n) == null; } catch { return true; } });
  eq(`every one of the ${vocab.size} scraped identifiers resolves`, falseUnknown, []);
  eq("the vocabulary is not trivially small", vocab.size > 150, true);
}

// ── template walker ─────────────────────────────────────────────────────────
console.log("\n— template inventory —");
{
  const tpl = { system: { body: { type: "panel", key: "root", contents: [
    { type: "textField", key: "cost" },
    { type: "label", key: "details_roller" },
    { type: "activeEffectContainer", key: "skill_effect" },
    { type: "dynamicTable", key: "effect_table", rowLayout: [
      { type: "select", key: "effect_kind" },
      { type: "textField", key: "effect_label" },
    ] },
  ] } } };
  const { fields, columns } = bridge.inventoryTemplate(tpl);
  eq("a plain field is declared", fields.has("cost"), true);
  // Both of these were MISSING from the offline type list and produced 427
  // false "reloadTemplate will delete it" errors.
  eq("a label is declared (CSB recomputes it; it is not lost)", fields.has("details_roller"), true);
  eq("an activeEffectContainer is declared (ExtensibleTable keeps its key)",
    fields.has("skill_effect"), true);
  eq("table columns are collected under their table",
    [...(columns.get("effect_table") ?? [])].sort(), ["effect_kind", "effect_label"]);
  eq("a table key is not also a top-level field", fields.has("effect_kind"), false);
}

// ── ctx assembly ────────────────────────────────────────────────────────────
console.log("\n— live ctx —");
{
  _items = [{ _id: "TPL1", id: "TPL1", system: { body: { type: "panel", key: "r", contents: [
    { type: "textField", key: "cost" },
    { type: "dynamicTable", key: "effect_table", rowLayout: [{ type: "select", key: "effect_kind" }] },
  ] } } }];
  const ctx = bridge.buildLiveCtx({ system: { template: "TPL1", props: {} } });
  eq("vocabulary is supplied as a function", typeof ctx.vocabulary, "function");
  eq("declaredProps come from the live template", ctx.declaredProps.has("cost"), true);
  eq("rowColumns come from the live template",
    [...(ctx.rowColumns.effect_table ?? [])], ["effect_kind"]);
  eq("the kind contract is supplied", typeof ctx.requiredFieldsByKind, "object");

  // A template we cannot find must OMIT the inputs, so the skip contract names
  // those rules unrun — never guess them into a pass.
  const missing = bridge.buildLiveCtx({ system: { template: "NOPE", props: {} } });
  eq("an unknown template omits declaredProps", missing.declaredProps, undefined);
}

// ── validateLive accepts a live Item ────────────────────────────────────────
console.log("\n— validateLive —");
{
  const item = {
    name: "Fake Item",
    system: { template: "TPL1", props: { skill_type: "Active", skill_target: "", action_command: "skill" } },
    toObject() { return { name: this.name, system: this.system }; },
  };
  const r = bridge.validateLive(item);
  eq("unwraps a document via toObject()", r.findings.some((f) => f.code === "SKILL_TARGET_BLANK"), true);
  eq("a plain object works too",
    bridge.validateLive({ name: "P", system: { template: "TPL1", props: { skill_type: "Active", skill_target: "", action_command: "skill" } } })
      .findings.some((f) => f.code === "SKILL_TARGET_BLANK"), true);
}

// ── self-test can go red ────────────────────────────────────────────────────
console.log("\n— self-test —");
{
  const r = bridge.selfTest();
  eq("self-test passes in a healthy build", r.ok, true);
  eq("every case fired its own code", r.results.filter((x) => !x.fired).map((x) => x.code), []);
  eq("the clean document produced nothing", r.cleanFindings, []);
}

// ── registration ────────────────────────────────────────────────────────────
console.log("\n— registration —");
{
  eq("the ready hook was registered", typeof globalThis.__readyFn, "function");
  globalThis.__readyFn();
  const api = globalThis.FUCompanion?.api?.lint ?? {};
  eq("validateSkillDoc is exposed", typeof api.validateSkillDoc, "function");
  eq("validateSkillCorpus is exposed", typeof api.validateSkillCorpus, "function");
  eq("skillValidatorSelfTest is exposed", typeof api.skillValidatorSelfTest, "function");
  eq("the rule catalogue is exposed", typeof api.skillValidatorRules, "object");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
