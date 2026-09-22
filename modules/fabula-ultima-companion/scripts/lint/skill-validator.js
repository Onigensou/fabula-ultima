/**
 * [ONI] Skill Validator — the per-document half of the lint.
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT IS NOT reaction-config-lint.js
 *
 * `reaction-config-lint.js` is a WORLD SWEEP: it walks every item + actor copy
 * + AE at GM ready and reports 47 structural rule codes. It is excellent at
 * what it does, and the two are designed to be CONCATENATED by a caller that
 * wants everything — so overlap here means the author sees a defect twice.
 *
 * Six of this module's seven codes are genuinely uncovered by the sweep (it has
 * no skill_target, duration, column-declaration or formula-identifier rule).
 * The seventh, REQUIRED_FIELD_MISSING, WOULD have overlapped on three effect
 * kinds; those are excluded — see SWEEP_OWNED_KINDS.
 *
 * What it cannot be is a PER-DOCUMENT, PURE function. It is a classic-script
 * IIFE that reads `game.items`, so it cannot run in Node, cannot be unit
 * tested, and cannot answer "is THIS document, right now, well-formed?" —
 * which is exactly the question an authoring UI has to ask on every keystroke
 * and a pre-commit gate has to ask without a running game.
 *
 * So this module adds the checks the sweep has no coverage for (verified by
 * grep: the sweep has ZERO formula-identifier and ZERO column-declaration
 * coverage), as a pure function over a plain document object.
 *
 *   validateSkillDoc(doc, ctx) -> { findings, skipped }
 *
 * `doc` is a PLAIN OBJECT in the `_authored-export` shape — `{ name, system:
 * { props }, effects: [...] }`. A live Foundry Item satisfies this shape via
 * `item.toObject()`. Nothing here touches `game`, `ui`, or any global.
 *
 * ---------------------------------------------------------------------------
 * THE SKIP CONTRACT — read this before adding a rule.
 *
 * Every rule needs a piece of `ctx` (the formula vocabulary, the declared
 * column set, ...). When that piece is ABSENT the rule is SKIPPED and named in
 * `skipped`, never silently downgraded to "passed".
 *
 * This is not defensive decoration. The `formulas` audit's own first draft
 * produced three false positives on its first run, and the note it left behind
 * is the governing principle here: an audit that is wrong some of the time
 * gets ignored the rest of the time. A caller that cannot supply the
 * vocabulary must be told "identifier checking did not run", because the
 * alternative — a clean report that checked nothing — is the exact
 * silent-permissive failure this whole layer exists to end.
 *
 * ---------------------------------------------------------------------------
 * SEVERITY POLICY
 *
 *   error   — the authored intent is silently NOT what the engine will do,
 *             or authored data is destroyed. Never "it looks odd".
 *   warning — real defect, but the behaviour still matches the author's
 *             intent (e.g. the data works but no human can edit it).
 *   info    — context that changes how to read the other findings.
 */

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/**
 * This project writes "-" to mean "deliberately not applicable" (93 blank-ish
 * `skill_target` values, every `rolled_atr` on a non-rolling skill). It is an
 * AUTHORED answer, not an omission, so no blank-field rule may flag it.
 * Distinguishing the two is the entire value of these rules — "" is "nobody
 * decided", "-" is "somebody decided no".
 */
const NOT_APPLICABLE = new Set(["-", "–", "—"]);

/** True for "" / whitespace / null / undefined. "-" is NOT blank — see above. */
function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

/** True when the author explicitly marked the field not-applicable. */
function isNotApplicable(v) {
  return NOT_APPLICABLE.has(String(v ?? "").trim());
}

/** Blank OR explicitly not-applicable — i.e. "no usable value here". */
function isEmptyish(v) {
  return isBlank(v) || isNotApplicable(v);
}

// ---------------------------------------------------------------------------
// Formula vocabulary — kept deliberately in step with tools/skill-regression's
// formula-audit. Two tools disagreeing about what an identifier means would be
// worse than having only one, so the lists below mirror that audit's model:
// a literal vocabulary, a set of dynamic PREFIX families, and the language's
// own words. The audit scrapes the vocabulary from source (game closed); in
// the browser we probe the live resolver instead. Same rule, two sources.
// ---------------------------------------------------------------------------

/**
 * Callable built-ins (`FUNCTIONS` in skill-formulas.js). A call node whose name
 * is NOT here falls through to the resolver, so an UPPERCASE call such as
 * `AE_FLAG(name, key)` is checked as an identifier like any other.
 */
const BUILTIN_FUNCTIONS = new Set([
  "floor", "ceil", "round", "abs", "min", "max", "pow", "chance", "randint",
]);

/**
 * Bare lowercase words that are language, not authored identifiers.
 *
 * ⚠ BYTE-IDENTICAL to formula-audit.js's list, deliberately. An earlier version
 * added `chance` / `randint` / `pow` / `sameRow` / `fetchFromParent` here only,
 * which made the two tools disagree about prose: `chance roulette` read as one
 * prose word here and two there.
 *
 * Those names no longer need to be listed, because parseProblems now strips
 * CALL SYNTAX structurally (see there) — `chance(25)` is recognised as a call
 * whether or not anything knows the word `chance`. Resolving the divergence by
 * deleting the need for the list beats keeping two lists in sync by hand.
 */
const LANGUAGE_WORDS = new Set([
  "true", "false", "null", "and", "or", "not", "if", "else",
  "min", "max", "floor", "ceil", "round", "abs", "switchCase", "equalText",
]);

/**
 * Fields whose value is a gate formula. Split by where they live, because the
 * three homes are reached by different walks and an earlier one-off version of
 * this scan missed the AE-change home entirely (an AE-only document has no
 * `system.props` to speak of, so a `props`-first walk skips it).
 */
export const FORMULA_FIELDS = {
  /** `system.props.<key>` */
  topLevel: ["availability_formula", "target_eligibility"],
  /** a row inside `system.props.<table>.<n>.<key>` */
  row: ["condition_formula", "target_filter", "focus_max_formula"],
  /** an entry in `effects[].changes[].key` */
  aeChange: ["cannot_be_targeted_by_unless"],
};

/**
 * Every ALL-CAPS token in a formula that is not inside a string literal.
 *
 * `minLength` defaults to 2, matching tools/skill-regression's formula-audit
 * (changed in the same pass — the two must agree or they give different answers
 * about the same formula). It was 3, which never checked the real two-character
 * identifiers `SL` and `HR`, so a two-character typo of either passed silently.
 * Measured before lowering: 0 new findings across the corpus.
 */
export function identifiersIn(formula, minLength = 2) {
  const stripped = String(formula)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  const rest = Math.max(0, minLength - 1);
  const re = new RegExp(`\\b([A-Z][A-Z0-9_]{${rest},})\\b`, "g");
  const out = [];
  for (const m of stripped.matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * Structural parse check — balanced delimiters, and a prose smell.
 *
 * The prose case is the one that matters. `evaluateFormula` catches its own
 * parse errors and returns the CALLER's fallback, and skill-picker passes `1`
 * — so a GM who types "When you have a Minion" into a gate gets NO GATE AT
 * ALL, silently. That is the opposite failure from a typo'd identifier (which
 * folds to 0 and blocks forever), and both are invisible.
 */
export function parseProblems(formula) {
  const f = String(formula);
  const problems = [];

  let depth = 0;
  let unbalancedClose = false;
  for (const ch of f) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) { unbalancedClose = true; break; }
    }
  }
  if (unbalancedClose || depth !== 0) problems.push("unbalanced parentheses");
  if ((f.match(/'/g) || []).length % 2) problems.push("unbalanced single quote");
  if ((f.match(/"/g) || []).length % 2) problems.push("unbalanced double quote");

  // Prose smell: two or more non-language lowercase words and no operator
  // anywhere. Both halves are needed — `chance(25)` has no operator but only
  // one lowercase word, and `HAS_SHIELD == 1` has lowercase-free content.
  // A lowercase word immediately followed by `(` is a CALL, not prose —
  // whatever its name. Detecting that structurally beats maintaining a list of
  // known function names; the list is what let this and formula-audit diverge.
  // `max(chance(50), randint(1,3))` reads as zero prose words after stripping,
  // while `chance roulette` still reads as two.
  const stripped = f.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "")
    .replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\s*\(/g, "(");
  const hasOperator =
    /[<>=!+\-*/]|&&|\|\||\b(and|or|not|switchCase|equalText)\b/.test(stripped);
  const lowerWords = (stripped.match(/\b[a-z]{2,}\b/g) || [])
    .filter((w) => !LANGUAGE_WORDS.has(w));
  if (!hasOperator && lowerWords.length >= 2) {
    problems.push("looks like prose, not a formula");
  }
  return problems;
}

/**
 * Build the identifier checker every formula rule runs on.
 *
 * Accepts either shape so all three callers can supply what they cheaply have:
 *   • `{ vocab: Set, prefixes: string[] }` — the offline scrape (formula-audit)
 *   • `(name) => boolean`                  — e.g. a live-resolver probe
 *
 * The live probe works because `buildSkillResolver`'s switch has NO `default:`
 * arm: a name it does not serve returns `undefined`, while every real arm
 * returns a number or a string. That is why this module never needs the engine
 * to export its 167-arm vocabulary as a constant.
 */
export function makeIdentifierChecker(vocabulary) {
  if (!vocabulary) return null;
  if (typeof vocabulary === "function") return vocabulary;
  const vocab = vocabulary.vocab instanceof Set
    ? vocabulary.vocab
    : new Set(vocabulary.vocab || []);
  const prefixes = Array.from(vocabulary.prefixes || []);
  if (!vocab.size && !prefixes.length) return null;
  return (name) => vocab.has(name) || prefixes.some((p) => name.startsWith(p));
}

// ---------------------------------------------------------------------------
// Rule catalogue — the author-facing half.
// ---------------------------------------------------------------------------

/**
 * One entry per rule code. `why` explains the failure in terms of what the
 * PLAYER or AUTHOR experiences, not in terms of the engine's internals; `fix`
 * names the concrete edit. The authoring UI renders these verbatim, which is
 * the whole reason they are data and not string-concatenated at the throw site.
 */
export const RULES = {
  FORMULA_IDENT_UNKNOWN: {
    severity: "error",
    title: "Formula uses an identifier the engine does not know",
    why:
      "An unknown identifier resolves to 0. A gate like `>= 1` is then always " +
      "false, so the skill is permanently unavailable — while still displaying " +
      "the reason you authored. It is indistinguishable from working correctly.",
    fix: "Correct the spelling, or use an identifier the resolver serves.",
  },
  FORMULA_UNPARSEABLE: {
    severity: "error",
    title: "Formula cannot be parsed",
    why:
      "Unparseable text makes evaluateFormula return the CALLER's fallback. " +
      "The skill picker passes 1, so the gate does not apply at all — the " +
      "opposite of what an unparseable condition looks like it should do.",
    fix: "Write an expression (e.g. `HAS_SHIELD == 1`), not prose.",
  },
  ROW_COLUMN_UNDECLARED: {
    severity: "warning",
    title: "Row field has no column on the template",
    why:
      "The engine reads this field, but no sheet renders it, so it cannot be " +
      "edited or even seen by a human. It survives today only because no write " +
      "path rebuilds a row from its cells — an editor that did would drop it.",
    fix: "Add one entry to template-field-registry.js; the boot sync ships the column.",
  },
  PROP_UNDECLARED: {
    severity: "error",
    title: "Top-level prop is not declared by the template",
    why:
      "reloadTemplate iterates system.props against the declared key set and " +
      "deletes anything undeclared. This value is destroyed on the next " +
      "template reload — the documented 112-key loss.",
    fix: "Declare the field on the template, or migrate the value onto a declared one.",
  },
  REQUIRED_FIELD_MISSING: {
    severity: "error",
    title: "Effect row is missing a field its handler refuses to run without",
    why:
      "The handler rejects the row and returns. The row is authored, reads " +
      "correctly, and does nothing — with no error anywhere.",
    fix: "Fill the named field, or change the row's effect kind.",
  },
  SPELL_DURATION_BLANK: {
    severity: "error",
    title: "Spell has no duration",
    why:
      "A blank duration silently claims Instantaneous. A Scene-long spell " +
      "authored this way is refused by every instantaneous-only gate at the " +
      "moment it matters, and passes every test that omits the field.",
    // "-" is ACCEPTED here, unlike skill_target. User ruling 2026-09-22:
    // "depends on the skill — it is possible it is [a] passive that [is] always
    // active, and normally Fabula Ultima [doesn't] define duration on passive."
    // The engine ranks "-" as Instantaneous (skill-formulas.js:1243), so it is
    // only safe for a spell that really is instantaneous or is passive-shaped.
    fix: 'Set duration explicitly — "Instantaneous" or "Scene". Use "-" only ' +
      'for an always-active, passive-shaped spell; the engine reads it as ' +
      'Instantaneous, so anything lasting a Scene must say so.',
  },
  SKILL_TARGET_BLANK: {
    severity: "error",
    title: "Activatable skill has no target",
    why:
      "Every action is supposed to declare what it hits, including Self. " +
      "A blank self-locks the skill — it cannot resolve a target from the turn " +
      "menu, and every harness mode is blind to the cause. A \"-\" is worse " +
      "than blank: compose-action treats it as NOT self, so it falls through " +
      "to side classification and opens the enemy picker.",
    // DO NOT suggest "-" here. compose-action.js:903 computes
    //   isSelf = !skillTargetText || /^self$/i.test(skillTargetText)
    // so "-" is NOT a no-target sentinel for this field: it falls through to
    // side classification and opens the full ENEMY picker (intent tiebreaker).
    // The authoring UI renders this string verbatim to a non-programmer, so a
    // wrong suggestion here actively breaks the skill it claims to fix.
    fix: 'Set skill_target to what it actually hits — "Self", "One Enemy", "One Ally".',
  },
};

// ---------------------------------------------------------------------------
// Document walking
// ---------------------------------------------------------------------------

const TABLES = ["effect_table", "reaction_config_table"];

const MODULE_NS = "fabula-ultima-companion";

/**
 * Every place on this document that carries `effect_table` /
 * `reaction_config_table` rows.
 *
 * There are TWO homes, not one. The obvious one is `system.props`. The other is
 * a `reactionConfig` blob on an Active Effect's flags — and per the equipment
 * policy that is the MANDATED carrier for gear behaviour, so a gear item whose
 * whole implementation is a `transfer:true` AE lives entirely in the second.
 *
 * Walking only the first made such an item validate CLEAN with an empty
 * `skipped` — "we checked and it's fine" when the truth was "we never looked".
 * The corpus holds 123 such AEs carrying 64 gate formulas and 189 effect rows.
 */
export function configScopes(doc) {
  const out = [{ label: "system.props", props: doc?.system?.props ?? {} }];
  for (const eff of doc?.effects ?? []) {
    const cfg = eff?.flags?.[MODULE_NS]?.reactionConfig;
    if (!cfg || typeof cfg !== "object") continue;
    out.push({ label: `effects["${eff?.name ?? "?"}"].reactionConfig`, props: cfg });
  }
  return out;
}

/** Live rows of a CSB dynamic table, with `$deleted` tombstones dropped. */
export function liveRows(table) {
  if (!table || typeof table !== "object") return [];
  const out = [];
  for (const [key, row] of Object.entries(table)) {
    if (!row || typeof row !== "object") continue;
    if (row.$deleted === true) continue;
    out.push({ key, row });
  }
  return out;
}

function push(findings, code, location, message, extra = {}) {
  const rule = RULES[code];
  findings.push({
    severity: rule?.severity ?? "warning",
    code,
    location,
    message,
    title: rule?.title ?? code,
    why: rule?.why ?? "",
    fix: rule?.fix ?? "",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Collect every gate formula on the document, with a readable location. */
export function collectFormulas(doc) {
  const out = [];
  const props = doc?.system?.props ?? {};

  for (const key of FORMULA_FIELDS.topLevel) {
    const v = props[key];
    if (!isEmptyish(v)) out.push({ location: `system.props.${key}`, formula: String(v) });
  }

  // Row formulas live in BOTH homes — the document's props and any AE-carried
  // reactionConfig. See configScopes.
  for (const scope of configScopes(doc)) {
    for (const table of TABLES) {
      for (const { key, row } of liveRows(scope.props[table])) {
        for (const field of FORMULA_FIELDS.row) {
          const v = row[field];
          if (isEmptyish(v)) continue;
          const label = row.effect_label || row.reaction_effect_ref || key;
          out.push({
            location: `${scope.label}.${table}[${key}].${field}`,
            formula: String(v),
            rowLabel: label,
          });
        }
      }
    }
  }

  for (const eff of doc?.effects ?? []) {
    for (const ch of eff?.changes ?? []) {
      if (!FORMULA_FIELDS.aeChange.includes(ch?.key)) continue;
      if (isEmptyish(ch?.value)) continue;
      out.push({
        location: `effects["${eff?.name ?? "?"}"].changes.${ch.key}`,
        formula: String(ch.value),
      });
    }
  }
  return out;
}

function ruleFormulas(doc, findings, isKnownIdentifier, minLength) {
  for (const { location, formula } of collectFormulas(doc)) {
    // A bare number is a legal formula and has nothing to check.
    if (/^-?\d+(\.\d+)?$/.test(formula.trim())) continue;

    const problems = parseProblems(formula);
    if (problems.length) {
      push(findings, "FORMULA_UNPARSEABLE", location,
        `"${formula}" — ${problems.join("; ")}.`,
        { formula });
      // Identifier checking on text that does not parse would report noise
      // about words that were never meant as identifiers.
      continue;
    }

    for (const ident of new Set(identifiersIn(formula, minLength))) {
      if (isKnownIdentifier(ident)) continue;
      push(findings, "FORMULA_IDENT_UNKNOWN", location,
        `"${ident}" is not served by the formula resolver (in "${formula}").`,
        { formula, identifier: ident });
    }
  }
}

/**
 * @param {string[]} skipped  appended to PER TABLE — see below.
 *
 * The guard here is per-table on purpose. An earlier version gated the whole
 * rule on `if (ctx.rowColumns)` and then did `if (!declared) continue;` inside,
 * so a caller passing `{effect_table: null, reaction_config_table: null}` — the
 * exact shape the offline driver builds for a template with no such tables —
 * got a clean report with nothing in `skipped`. The rule read as PASSED while
 * checking nothing, which is the single failure mode this module exists to end.
 */
function ruleRowColumns(doc, findings, rowColumns, skipped) {
  const props = doc?.system?.props ?? {};
  for (const table of TABLES) {
    const declared = rowColumns[table];
    if (!declared) {
      skipped.push(`ROW_COLUMN_UNDECLARED on ${table} (no column set supplied)`);
      continue;
    }
    for (const { key, row } of liveRows(props[table])) {
      for (const field of Object.keys(row)) {
        if (field === "$deleted") continue;
        if (declared.has(field)) continue;
        // A BLANK value in an undeclared column is not a defect. CSB stamps
        // keys onto rows wholesale, so most undeclared keys carry "" — and an
        // empty uneditable cell costs nothing. Only an authored VALUE that no
        // human can see or correct is worth a finding.
        if (isBlank(row[field])) continue;
        push(findings, "ROW_COLUMN_UNDECLARED", `${table}[${key}].${field}`,
          `"${field}" holds an authored value but no template column renders it.`,
          { field, table, value: String(row[field]) });
      }
    }
  }
}

/**
 * CSB row/document bookkeeping that lives in `system.props` but is not an
 * authored field. Every instance carries these, so counting them as undeclared
 * buries the real findings 4:1 (3675 of the first backtest's 4543). Mirrors
 * IGNORE_KEYS in tools/csb-template/bin/visibility-audit.js — the two tools
 * must agree on what "a field" is or their numbers cannot be compared.
 */
const BOOKKEEPING_PROPS = new Set([
  "deleted", "$deleted", "name", "img", "id", "uuid", "uniqueId",
]);

function rulePropsDeclared(doc, findings, declaredProps) {
  const props = doc?.system?.props ?? {};
  for (const key of Object.keys(props)) {
    if (BOOKKEEPING_PROPS.has(key)) continue;
    if (declaredProps.has(key)) continue;
    // Same reasoning as ROW_COLUMN_UNDECLARED: reloadTemplate deletes an
    // undeclared key whatever it holds, but deleting "" destroys nothing.
    // Filtering blanks is also what makes this number comparable with
    // tools/csb-template's visibility-audit, which counts authored cells.
    if (isBlank(props[key])) continue;
    push(findings, "PROP_UNDECLARED", `system.props.${key}`,
      `"${key}" is authored but the template declares no field for it — ` +
      `reloadTemplate will delete it.`,
      { field: key });
  }
}

/**
 * Effect kinds whose required-field check the WORLD SWEEP already performs.
 *
 * `lintOneItem` and this validator are designed to be concatenated, so an
 * overlapping rule shows the author the same defect twice — and for `apply_ae`
 * with a severity conflict (the sweep says warning, this said error). The sweep
 * owns these three; this rule covers the other fourteen kinds it never looks at.
 *
 *   chain          -> CHAIN_EMPTY                  (reaction-config-lint.js:449)
 *   consume_charge -> CONSUME_CHARGE_KEY_MISSING   (:497)
 *   apply_ae       -> APPLY_AE_NO_TEMPLATE         (:511, same ae_name_pool /
 *                                                   ae_pool_tag escape hatch)
 */
const SWEEP_OWNED_KINDS = new Set(["chain", "consume_charge", "apply_ae"]);

function ruleRequiredFields(doc, findings, requiredByKind) {
  for (const scope of configScopes(doc)) {
  for (const { key, row } of liveRows(scope.props.effect_table)) {
    const kind = String(row.effect_kind ?? "").trim();
    if (!kind) continue;                       // EFFECT_KIND_MISSING is the sweep's rule
    if (SWEEP_OWNED_KINDS.has(kind)) continue; // see SWEEP_OWNED_KINDS
    const spec = requiredByKind[kind];
    if (!spec) continue;                       // absent = nothing harvested, not "nothing required"

    // Exemptions first — a handler that returns early requires nothing.
    const set = (f) => !isBlank(row[f]);
    if ((spec.unlessSet || []).some(set)) continue;
    if ((spec.unlessTrue || []).some((f) => row[f] === true || row[f] === "true")) continue;
    if ((spec.unlessTrueStrict || []).some((f) => row[f] === true)) continue;

    for (const field of spec.all || []) {
      if (set(field)) continue;
      push(findings, "REQUIRED_FIELD_MISSING", `${scope.label}.effect_table[${key}].${field}`,
        `effect_kind "${kind}" needs "${field}"; the handler rejects the row without it.`,
        { field, kind, rowLabel: row.effect_label || key });
    }
    for (const group of spec.either || []) {
      if (group.some(set)) continue;
      push(findings, "REQUIRED_FIELD_MISSING", `${scope.label}.effect_table[${key}].${group[0]}`,
        `effect_kind "${kind}" needs one of ${group.map((g) => `"${g}"`).join(" / ")}; ` +
        `the handler rejects the row without it.`,
        { field: group[0], kind, rowLabel: row.effect_label || key });
    }
  }
  }
}

/**
 * Blank `duration` on a Spell.
 *
 * Measured over the corpus at authoring time: 0 hits — the duration migration
 * already swept it. This rule is therefore a REGRESSION GUARD, not a finding
 * source, and that is worth keeping: a blank here is invisible in play and
 * passes any test that omits the field.
 */
function ruleSpellDuration(doc, findings) {
  const props = doc?.system?.props ?? {};
  if (String(props.skill_type ?? "").trim() !== "Spell") return;
  if (!isBlank(props.duration)) return;        // "-" counts as authored
  push(findings, "SPELL_DURATION_BLANK", "system.props.duration",
    "Spell has no duration; the engine will read it as Instantaneous.");
}

/**
 * Blank `skill_target` on something the player activates.
 *
 * SCOPE IS THE WHOLE RULE. Unscoped, this flags 258 documents — 212 of them
 * Passives, which never target and are correct as authored. Scoped to
 * Active/Spell with no reaction wiring it flags 13, and those are the ones a
 * player can actually select and fail to aim.
 */
function ruleSkillTarget(doc, findings) {
  const props = doc?.system?.props ?? {};
  if (!("skill_target" in props)) return;
  // isEmptyish, NOT isBlank: for THIS field "-" is not an authored answer.
  // User ruling 2026-09-22 — "there should be skill target on everything, even
  // self; [a dash] might either be left over, or incomplete back filling."
  // The engine agrees: compose-action.js:903 makes only blank-or-/^self$/i mean
  // self, so "-" routes to the enemy picker. Contrast `duration`, where "-" IS
  // allowed to stand (see ruleSpellDuration).
  if (!isEmptyish(props.skill_target)) return;

  const type = String(props.skill_type ?? "").trim();
  if (type !== "Active" && type !== "Spell") return;
  if (props.isReaction === true) return;
  const hasTrigger = liveRows(props.reaction_config_table)
    .some((r) => !isBlank(r.row.reaction_trigger));
  if (hasTrigger) return;

  const dash = isNotApplicable(props.skill_target);
  push(findings, "SKILL_TARGET_BLANK", "system.props.skill_target",
    dash
      ? `${type} skill has skill_target "-", which the engine does not read as ` +
        `"no target" — it opens the enemy picker.`
      : `${type} skill has no target; it cannot resolve one from the turn menu.`,
    { dash });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate ONE document.
 *
 * @param {object} doc  `_authored-export`-shaped item (or `item.toObject()`).
 * @param {object} ctx
 *   @param {object|function} [ctx.vocabulary]  `{vocab,prefixes}` or `(name)=>bool`
 *   @param {object} [ctx.rowColumns]           `{ effect_table: Set, reaction_config_table: Set }`
 *   @param {Set}    [ctx.declaredProps]        declared top-level `system.props` keys
 *   @param {object} [ctx.requiredFieldsByKind] REQUIRED_FIELDS_BY_KIND
 * @returns {{findings: object[], skipped: string[]}}
 */
export function validateSkillDoc(doc, ctx = {}) {
  const findings = [];
  const skipped = [];

  const identifierChecker = makeIdentifierChecker(ctx.vocabulary);
  if (identifierChecker) {
    ruleFormulas(doc, findings, identifierChecker, ctx.identifierMinLength ?? 2);
  }
  else skipped.push("FORMULA_IDENT_UNKNOWN + FORMULA_UNPARSEABLE (no vocabulary supplied)");

  if (ctx.rowColumns) ruleRowColumns(doc, findings, ctx.rowColumns, skipped);
  else skipped.push("ROW_COLUMN_UNDECLARED (no column set supplied)");

  if (ctx.declaredProps instanceof Set && ctx.declaredProps.size) {
    rulePropsDeclared(doc, findings, ctx.declaredProps);
  } else {
    skipped.push("PROP_UNDECLARED (no declared-prop set supplied)");
  }

  if (ctx.requiredFieldsByKind) ruleRequiredFields(doc, findings, ctx.requiredFieldsByKind);
  else skipped.push("REQUIRED_FIELD_MISSING (no per-kind contract supplied)");

  // Rules that need no context at all.
  ruleSpellDuration(doc, findings);
  ruleSkillTarget(doc, findings);

  const name = doc?.name ?? "(unnamed)";
  for (const f of findings) {
    f.itemName = name;
    f.itemUuid = doc?.uuid ?? null;
  }
  return { findings, skipped };
}

/** Roll several documents up into one report. */
export function validateMany(docs, ctx = {}) {
  const findings = [];
  let skipped = [];
  for (const doc of docs) {
    const r = validateSkillDoc(doc, ctx);
    findings.push(...r.findings);
    if (!skipped.length) skipped = r.skipped;
  }
  const byCode = {};
  let errors = 0, warnings = 0, info = 0;
  for (const f of findings) {
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    if (f.severity === "error") errors += 1;
    else if (f.severity === "warning") warnings += 1;
    else info += 1;
  }
  return {
    findings,
    skipped,
    summary: { total: findings.length, errors, warnings, info, byCode },
  };
}
