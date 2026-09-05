// ───────────────────────────────────────────────────────────────────────────
// formula-audit — "does every authored gate formula actually MEAN anything?"
//
// Why this exists.
//
// Gate formulas (`availability_formula`, `target_eligibility`, `condition_formula`,
// `target_filter`, `focus_max_formula`) are free text on the sheet with no
// validation, and the evaluator fails SILENTLY in two opposite directions:
//
//   • Unparseable text — `evaluateFormula` catches internally and returns the
//     CALLER's fallback. skill-picker.js passes `1`, so a GM who types
//     "When you have a Minion" gets NO GATE AT ALL. That is exactly the
//     silent-permissive end-state the declared-props work existed to prevent.
//
//   • A typo'd identifier — `OWN_PERSISTANT_SUMMON_COUNT` — resolves to null and
//     folds to 0, so `>= 1` is falsy and the skill is PERMANENTLY greyed out,
//     displaying its authored player-facing reason. The player reads "You have no
//     Minion to destroy" while standing next to their Minion. Nothing warns.
//
// The second is worse than a crash: it is indistinguishable from correct
// behaviour. Neither shows up in the sheet, the console, or the picker.
//
// The vocabulary is statically enumerable — the resolver is a flat
// `switch (name)` over ~150 `case "IDENT":` arms plus a small set of dynamic
// PREFIXES — so an offline reader can decide whether an identifier can ever
// resolve. Game-CLOSED: reads skill-formulas.js for the vocabulary and the
// authored export for the formulas.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const FORMULAS_JS = path.join(ROOT, "modules", "fabula-ultima-companion", "scripts",
  "battle-director", "skill-formulas.js");
const EXPORT_DIR = path.join(ROOT, "worlds", "fabula-ultima-2", "_authored-export");

// Top-level props whose value is a formula.
const TOP_LEVEL_FORMULA_PROPS = ["availability_formula", "target_eligibility"];
// Row-level formula cells inside the dynamic tables.
const ROW_FORMULA_PROPS = ["condition_formula", "target_filter", "focus_max_formula"];

// Identifiers the resolver serves through a PREFIX rather than a literal case.
// Anything starting with one of these is resolvable by construction.
const DYNAMIC_PREFIXES = [
  "VAR_", "HAS_SKILL_", "AE_COUNT_", "AE_CHARGES_", "COMBAT_MAX_AE_CHARGES_",
  "TARGET_AE_CHARGES_", "TARGET_AE_COUNT_", "SPECIES_IS_", "TARGET_SPECIES_IS_",
  "ATTACKER_SPECIES_IS_", "ATTACKER_RANK_IS_", "RANK_IS_", "TARGET_RANK_IS_",
  "SUBTYPE_IS_", "TARGET_SUBTYPE_IS_", "TRIGGER_DAMAGE_IS_", "ANY_TARGET_HAS_",
  "HAS_STATUS_", "TARGET_HAS_STATUS_", "BOND_COUNT_", "SAVE_TIER_",
];

// Bare words that are language, not identifiers.
const LANGUAGE_WORDS = new Set([
  "true", "false", "null", "and", "or", "not", "if", "else",
  "min", "max", "floor", "ceil", "round", "abs", "switchCase", "equalText",
]);

// Scrape the resolver's vocabulary. It is NOT just the `case` arms — the first
// draft of this audit assumed it was and produced three false positives on its
// very first run, which is worse than no audit at all. The resolver serves an
// identifier four different ways:
//   • `case "IDENT":`             — the bulk of them
//   • `if (name === "IDENT")`     — e.g. USED_WEAPON_IS_EQUIPPED
//   • `name.startsWith("PREFIX")` — the dynamic families
//   • injected `vars`             — buildSkillResolver checks `vars` BEFORE the
//     switch, so a caller can supply extra identifiers per evaluation.
//     skill-targeting injects IS_ALLY / IS_ENEMY for each candidate.
function readVocabulary() {
  if (!fs.existsSync(FORMULAS_JS)) return null;
  const src = fs.readFileSync(FORMULAS_JS, "utf8");
  const vocab = new Set();
  for (const m of src.matchAll(/case\s+"([A-Z][A-Z0-9_]*)"\s*:/g)) vocab.add(m[1]);
  for (const m of src.matchAll(/name\s*===?\s*"([A-Z][A-Z0-9_]*)"/g)) vocab.add(m[1]);
  // `startsWith("PREFIX")` guards are the dynamic families; harvest them too so
  // the prefix list self-heals when the engine grows a new one.
  const prefixes = new Set(DYNAMIC_PREFIXES);
  for (const m of src.matchAll(/startsWith\("([A-Z][A-Z0-9_]*_)"\)/g)) prefixes.add(m[1]);

  // Identifiers injected by CALLERS through buildSkillResolver({ vars }).
  const bdDir = path.dirname(FORMULAS_JS);
  for (const f of fs.readdirSync(bdDir)) {
    if (!f.endsWith(".js")) continue;
    let code;
    try { code = fs.readFileSync(path.join(bdDir, f), "utf8"); } catch (e) { continue; }
    for (const m of code.matchAll(/\bvars\s*[:=]\s*\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/([A-Z][A-Z0-9_]{2,})\s*:/g)) vocab.add(k[1]);
    }
  }
  return { vocab, prefixes: [...prefixes] };
}

// Every ALL-CAPS token in a formula that is not a string literal.
function identifiersIn(formula) {
  const stripped = String(formula).replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const out = [];
  for (const m of stripped.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) out.push(m[1]);
  return out;
}

// Cheap structural parse check: balanced parens/quotes and no obviously prose text.
function parseProblems(formula) {
  const f = String(formula);
  const problems = [];
  let depth = 0;
  for (const ch of f) {
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth < 0) break; }
  }
  if (depth !== 0) problems.push("unbalanced parentheses");
  if ((f.match(/'/g) || []).length % 2) problems.push("unbalanced single quote");
  if ((f.match(/"/g) || []).length % 2) problems.push("unbalanced double quote");
  // Prose smell: lowercase words with no operator anywhere.
  const stripped = f.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
  const hasOperator = /[<>=!+\-*/]|&&|\|\||\b(and|or|not|switchCase|equalText)\b/.test(stripped);
  const lowerWords = (stripped.match(/\b[a-z]{2,}\b/g) || [])
    .filter((w) => !LANGUAGE_WORDS.has(w));
  if (!hasOperator && lowerWords.length >= 2) problems.push("looks like prose, not a formula");
  return problems;
}

function* walkExport() {
  const dirs = ["items", "actors"];
  for (const d of dirs) {
    const full = path.join(EXPORT_DIR, d);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".json")) continue;
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(full, f), "utf8")); } catch (e) { continue; }
      yield { doc, owner: null };
      for (const it of (doc.items || [])) yield { doc: it, owner: doc.name };
    }
  }
}

function collectFormulas() {
  const found = [];
  for (const { doc, owner } of walkExport()) {
    const p = doc?.system?.props;
    if (!p) continue;
    const where = `${owner ? owner + " / " : ""}${doc.name}`;
    for (const key of TOP_LEVEL_FORMULA_PROPS) {
      const v = p[key];
      if (v && String(v).trim()) found.push({ where, field: key, formula: String(v).trim() });
    }
    for (const tableKey of ["effect_table", "reaction_config_table"]) {
      const t = p[tableKey];
      if (!t || typeof t !== "object") continue;
      for (const [rk, row] of Object.entries(t)) {
        if (!row || typeof row !== "object") continue;
        for (const key of ROW_FORMULA_PROPS) {
          const v = row[key];
          if (v && String(v).trim()) {
            found.push({ where, field: `${tableKey}[${rk}].${key}`, formula: String(v).trim() });
          }
        }
      }
    }
  }
  return found;
}

function runFormulaAudit() {
  const voc = readVocabulary();
  if (!voc) return { engineMissing: true };
  if (!fs.existsSync(EXPORT_DIR)) return { exportMissing: true };

  const formulas = collectFormulas();
  const unparseable = [];
  const unknown = new Map();   // identifier -> [{where, field, formula}]

  for (const entry of formulas) {
    const probs = parseProblems(entry.formula);
    if (probs.length) unparseable.push({ ...entry, problems: probs });
    for (const id of identifiersIn(entry.formula)) {
      if (voc.vocab.has(id)) continue;
      if (voc.prefixes.some((p) => id.startsWith(p))) continue;
      if (!unknown.has(id)) unknown.set(id, []);
      unknown.get(id).push(entry);
    }
  }
  return {
    vocabSize: voc.vocab.size,
    prefixCount: voc.prefixes.length,
    formulaCount: formulas.length,
    unparseable,
    unknown: [...unknown.entries()].map(([id, uses]) => ({ id, uses })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// A green audit that CANNOT go red is worthless. This feeds known-bad formulas
// through the same two checks the real run uses and asserts each is caught, plus
// known-good ones (including the three shapes that were false positives on the
// first draft) and asserts they are NOT. Run it with `formulas --self-test`.
function selfTest() {
  const voc = readVocabulary();
  if (!voc) return [{ name: "vocabulary loads", pass: false, detail: "skill-formulas.js not found" }];
  const unknownIds = (f) => identifiersIn(f)
    .filter((id) => !voc.vocab.has(id) && !voc.prefixes.some((p) => id.startsWith(p)));
  const t = [];
  const add = (name, pass, detail) => t.push({ name, pass: !!pass, detail });

  // must be CAUGHT
  add("prose is caught", parseProblems("When you have a Minion").length > 0,
      JSON.stringify(parseProblems("When you have a Minion")));
  add("unbalanced paren is caught", parseProblems("and(A, B").includes("unbalanced parentheses"), "");
  add("unbalanced quote is caught",
      parseProblems("equalText(skill_type, 'Active)").includes("unbalanced single quote"), "");
  add("typo'd identifier is caught",
      unknownIds("OWN_PERSISTANT_SUMMON_COUNT >= 1").includes("OWN_PERSISTANT_SUMMON_COUNT"), "");

  // must NOT be caught (the first draft got all three of these wrong)
  add("real identifier passes", unknownIds("OWN_PERSISTENT_SUMMON_COUNT >= 1").length === 0, "");
  add("if(name===) identifier passes (USED_WEAPON_IS_EQUIPPED)",
      unknownIds("USED_WEAPON_IS_EQUIPPED == 1").length === 0, "");
  add("injected vars pass (IS_ALLY / IS_ENEMY)",
      unknownIds("IS_ALLY + IS_ENEMY * HAS_STATUS_DAZED").length === 0, "");
  add("dynamic prefix passes (AE_CHARGES_)",
      unknownIds("AE_CHARGES_BRAINWAVE_CLOCK >= 4").length === 0, "");
  add("string literal is not an identifier",
      unknownIds("equalText(skill_type, 'ACTIVE')").length === 0,
      JSON.stringify(unknownIds("equalText(skill_type, 'ACTIVE')")));
  add("a real formula parses clean", parseProblems("OWN_NUMEN_COUNT == 0").length === 0, "");
  return t;
}

module.exports = { runFormulaAudit, selfTest, DYNAMIC_PREFIXES };
