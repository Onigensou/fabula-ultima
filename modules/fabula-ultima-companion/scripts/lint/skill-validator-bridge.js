// [ONI] Skill Validator — in-game bridge.
// ---------------------------------------------------------------------------
// `skill-validator.js` is deliberately PURE: it takes a plain document and a
// `ctx`, touches no global, and runs in Node. That purity is what makes it
// testable, and it is also why it cannot run itself — somebody has to assemble
// the ctx from whatever world it is in.
//
// Offline that job belongs to tools/skill-validate (reads the template from
// LevelDB, scrapes the vocabulary from source). This file is the same job
// inside the browser, where neither of those is possible and the live game is
// a better source than either.
//
// WHY THIS FILE HAD TO EXIST
//   Stage 0 shipped without it, and the gap was invisible because every test
//   ran in Node: `module.json` referenced the validator 0 times and nothing
//   imported it, so in the running game the validator did not exist at all —
//   while the whole point of it is to be the oracle for an authoring UI, which
//   runs in the browser. A suite that cannot fail in the direction that matters
//   is the exact defect this validator was written to catch, one level up.
//
// Exposes:
//   FUCompanion.api.lint.validateSkillDoc(itemOrDoc)   -> { findings, skipped }
//   FUCompanion.api.lint.validateSkillCorpus(opts)     -> summary over the world
//   FUCompanion.api.lint.skillValidatorSelfTest()      -> proves it can go red

import { validateSkillDoc, validateMany, RULES } from "./skill-validator.js";
import { buildSkillResolver } from "../battle-director/skill-formulas.js";
import { REQUIRED_FIELDS_BY_KIND } from "../battle-director/template-field-registry.js";

const TAG = "[SkillValidator]";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

// ── vocabulary, by PROBE ────────────────────────────────────────────────────
//
// The offline driver scrapes `skill-formulas.js` for `case "IDENT":` arms. In
// the browser there is no source to read, but there is something better: the
// resolver itself. `buildSkillResolver({})` answers every identifier it serves
// even with no actor — measured against the full scraped vocabulary, all 167
// return a value and NONE return null, so a null answer means "not served".
//
// ⚠ The sentinel is `null`, NOT `undefined`. The resolver has an explicit
// unknown branch that warns ("unknown identifier X → evaluated as 0") and
// returns null; an earlier draft of this probe tested `=== undefined` and would
// have reported EVERY identifier as unknown. Verified 2026-09-22 by probing all
// 167 scraped names plus a deliberate typo.
//
// The warning is a feature here: it only fires for names that are genuinely
// unserved, which is exactly when an author wants to hear about it.
function makeLiveVocabulary() {
  const resolver = buildSkillResolver({});
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    let known;
    try { known = resolver(name) != null; } catch { known = false; }
    cache.set(name, known);
    return known;
  };
}

// ── template shape, from the LIVE template document ─────────────────────────
// Mirrors tools/csb-template's walker. The type lists must stay in step with
// it: `label` and `activeEffectContainer` are DECLARED (CSB recomputes a
// label's props[key] on load; ExtensibleTable contributes its key to the prune
// set), and omitting them produced 427 false errors offline.
const TABLE_TYPES = new Set([
  "dynamicTable", "compactDynamicTable", "itemContainer",
  "activeEffectContainer", "conditionalModifierList",
]);
const PROP_TYPES = new Set([
  "textField", "numberField", "checkbox", "select", "radioButton",
  "textArea", "richTextArea", "label", "picture",
  ...TABLE_TYPES,
]);

export function inventoryTemplate(templateDoc) {
  const fields = new Set();
  const columns = new Map();
  function walk(node, tableKey) {
    if (!node || typeof node !== "object") return;
    const nextTable = TABLE_TYPES.has(node.type) ? node.key : tableKey;
    if (node.type && node.key) {
      if (tableKey) {
        if (!columns.has(tableKey)) columns.set(tableKey, new Set());
        columns.get(tableKey).add(node.key);
      } else if (PROP_TYPES.has(node.type)) {
        fields.add(node.key);
      }
    }
    for (const c of node.contents || []) {
      if (Array.isArray(c)) c.forEach((cell) => walk(cell, nextTable));
      else walk(c, nextTable);
    }
    for (const c of node.rowLayout || []) walk(c, nextTable);
  }
  const sys = templateDoc?.system ?? {};
  for (const root of ["header", "body"]) if (sys[root]) walk(sys[root], null);
  return { fields, columns };
}

/**
 * Assemble the ctx for a document, from the template that document actually
 * instantiates.
 *
 * Reading the doc's OWN template matters: "is this key declared?" is only
 * meaningful against the template it was built from, and judging a weapon
 * against the skill template's fields produced 71,919 nonsense findings
 * offline. When the template cannot be found, the column/prop inputs are
 * omitted rather than guessed — the validator's skip contract then names those
 * rules as unrun instead of passing them.
 */
export function buildLiveCtx(doc) {
  const ctx = {
    vocabulary: makeLiveVocabulary(),
    requiredFieldsByKind: REQUIRED_FIELDS_BY_KIND,
  };
  const templateId = doc?.system?.template ?? SKILL_TEMPLATE_ID;
  const tpl = game?.items?.get?.(templateId);
  if (tpl) {
    const { fields, columns } = inventoryTemplate(tpl);
    if (fields.size) ctx.declaredProps = fields;
    ctx.rowColumns = {
      effect_table: columns.get("effect_table") ?? null,
      reaction_config_table: columns.get("reaction_config_table") ?? null,
    };
  }
  return ctx;
}

/** Validate ONE document. Accepts a live Item or a plain object. */
export function validateLive(itemOrDoc) {
  const doc = typeof itemOrDoc?.toObject === "function" ? itemOrDoc.toObject() : itemOrDoc;
  return validateSkillDoc(doc, buildLiveCtx(doc));
}

/** Validate every item in the world plus every actor-embedded copy. */
export function validateCorpus({ templateOnly = null } = {}) {
  const docs = [];
  for (const it of (game?.items?.contents ?? [])) {
    if (templateOnly && it?.system?.template !== templateOnly) continue;
    docs.push(it.toObject());
  }
  for (const actor of (game?.actors?.contents ?? [])) {
    for (const it of (actor?.items?.contents ?? [])) {
      if (templateOnly && it?.system?.template !== templateOnly) continue;
      const o = it.toObject();
      o._owner = actor.name;
      docs.push(o);
    }
  }
  // One ctx per template, not per document — inventorying the template for each
  // of ~4000 docs is the difference between instant and a visible stall.
  const ctxCache = new Map();
  const findings = [];
  let skipped = [];
  for (const d of docs) {
    const key = d?.system?.template ?? "(none)";
    if (!ctxCache.has(key)) ctxCache.set(key, buildLiveCtx(d));
    const r = validateSkillDoc(d, ctxCache.get(key));
    if (!skipped.length) skipped = r.skipped;
    for (const f of r.findings) { f.owner = d._owner ?? null; findings.push(f); }
  }
  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  return { scanned: docs.length, findings, skipped, byCode };
}

/**
 * Prove the validator can still go RED in this environment.
 *
 * "It found nothing" and "it is not wired" look identical in a report, and the
 * offline side learned that the expensive way. Each case below is a document
 * that MUST produce its code; if any comes back clean the validator is broken
 * or mis-wired, whatever the corpus says.
 */
export function selfTest() {
  const ctx = {
    vocabulary: makeLiveVocabulary(),
    requiredFieldsByKind: REQUIRED_FIELDS_BY_KIND,
    declaredProps: new Set(["skill_type", "skill_target", "duration", "effect_table"]),
    rowColumns: { effect_table: new Set(["effect_kind", "effect_label"]), reaction_config_table: new Set() },
  };
  const cases = [
    ["FORMULA_IDENT_UNKNOWN", { system: { props: { availability_formula: "HAS_SHEILD == 1" } } }],
    ["FORMULA_UNPARSEABLE",   { system: { props: { availability_formula: "When you have a Minion" } } }],
    ["PROP_UNDECLARED",       { system: { props: { not_a_real_field: "x" } } }],
    ["ROW_COLUMN_UNDECLARED", { system: { props: { effect_table: { 0: { effect_kind: "grant", effect_label: "g", bogus_col: "v" } } } } }],
    ["SKILL_TARGET_BLANK",    { system: { props: { skill_type: "Active", skill_target: "" } } }],
    ["SPELL_DURATION_BLANK",  { system: { props: { skill_type: "Spell", duration: "" } } }],
  ];
  const results = cases.map(([code, doc]) => {
    const got = validateSkillDoc({ name: `selftest:${code}`, ...doc }, ctx).findings.map((f) => f.code);
    return { code, fired: got.includes(code), got };
  });
  // A clean document must produce NOTHING, or every result above is meaningless.
  const clean = validateSkillDoc({
    name: "selftest:clean",
    system: { props: { skill_type: "Active", skill_target: "One Enemy", duration: "Instantaneous" } },
  }, ctx).findings;
  const ok = results.every((r) => r.fired) && clean.length === 0;
  const out = { ok, results, cleanFindings: clean.map((f) => f.code), rules: Object.keys(RULES).length };
  console[ok ? "info" : "error"](`${TAG} self-test ${ok ? "PASSED" : "FAILED"}`, out);
  return out;
}

// ── registration ────────────────────────────────────────────────────────────
Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint ?? {};
  Object.assign(globalThis.FUCompanion.api.lint, {
    validateSkillDoc: validateLive,
    validateSkillCorpus: validateCorpus,
    skillValidatorSelfTest: selfTest,
    skillValidatorRules: RULES,
  });
  console.debug(`${TAG} ready — validateSkillDoc(item) / validateSkillCorpus() / skillValidatorSelfTest()`);
});

export { validateMany };
