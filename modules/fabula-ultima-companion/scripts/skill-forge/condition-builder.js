// [ONI] Skill Forge — condition builder.
// ---------------------------------------------------------------------------
// STAGE 3. Replaces free-text gate formulas with a structured model a
// non-programmer can fill from dropdowns, and compiles that model back to the
// exact string the engine already evaluates. No engine change: the output is a
// `condition_formula` like any other.
//
// WHY A BUILDER AT ALL
//   Free text fails silently in two opposite directions. A typo'd identifier
//   folds to 0, so a `>= 1` gate is always false and the skill is permanently
//   unavailable WHILE STILL SHOWING its authored reason. Unparseable text
//   returns the CALLER's fallback — skill-picker passes 1 — so the gate simply
//   does not apply. Neither is visible to the author. A dropdown cannot
//   misspell an identifier, and a compiled string cannot be prose.
//
// THE MODEL IS SHAPED BY WHAT PEOPLE ACTUALLY WROTE
//   Measured across all 778 authored gate formulas:
//     458 are ONE clause · 248 are two · 37 are three · the rest rarer
//     ==  649   &&  403   >=  290   >  145   ||  55   <  21   <=  7
//     arithmetic (+ * -) appears 107 times
//   So: a flat list of `left OP right` clauses joined by a single connective
//   covers the overwhelming majority. Anything with arithmetic, mixed
//   connectives or parentheses is NOT forced into the model — `parse` returns
//   null and the UI keeps the raw text. A builder that mangles an expression it
//   half-understands is worse than one that declines it.
//
// ROUND-TRIP IS THE CONTRACT
//   `compile(parse(s)) === s` for every formula the builder claims. That is
//   what makes it safe to open an existing skill in the UI: either the builder
//   reproduces the author's string exactly, or it admits it cannot and shows
//   the text. It must never quietly rewrite a working gate.

import { identifiersIn } from "../lint/skill-validator.js";

// ── operators ───────────────────────────────────────────────────────────────
// Order matters: two-character operators must be tried before their
// single-character prefixes, or `>=` splits as `>` and a stray `=`.
export const OPERATORS = [
  { op: "==", label: "is" },
  { op: "!=", label: "is not" },
  { op: ">=", label: "is at least" },
  { op: "<=", label: "is at most" },
  { op: ">",  label: "is more than" },
  { op: "<",  label: "is less than" },
];
const OP_BY_SYMBOL = new Map(OPERATORS.map((o) => [o.op, o]));

export const CONNECTIVES = [
  { join: "&&", label: "ALL of these are true" },
  { join: "||", label: "ANY of these is true" },
];

// ── identifier catalogue ────────────────────────────────────────────────────
// Human labels for the identifiers authors actually reach for, ordered by
// measured use. Anything not listed still works — `describeIdentifier` falls
// back to a readable form of the name itself — so the catalogue is a UX
// nicety, never a gate on what can be authored.
//
// `kind` drives the value widget: boolean renders yes/no, number renders a
// number box, element renders the damage-type list.
const CATALOGUE = [
  ["SL",                    "Skill level",                     "number"],
  ["ACTION_IS_ATTACK",      "The action is an attack",         "boolean"],
  ["ACTION_IS_SPELL",       "The action is a spell",           "boolean"],
  ["ATTACK_IS_MELEE",       "The attack is melee",             "boolean"],
  ["ATTACK_IS_RANGED",      "The attack is ranged",            "boolean"],
  ["CUR_MP",                "Current MP",                      "number"],
  ["CUR_HP",                "Current HP",                      "number"],
  ["CUR_IP",                "Current IP",                      "number"],
  ["MAX_HP",                "Maximum HP",                      "number"],
  ["MAX_MP",                "Maximum MP",                      "number"],
  ["ATTACK_CHECK_RESULT",   "The attack's Check result",       "number"],
  ["ACTION_IS_FREE_CAST",   "The action is a free cast",       "boolean"],
  ["SUBJECT_IS_SELF",       "The subject is me",               "boolean"],
  ["SUBJECT_IS_ALLY",       "The subject is an ally",          "boolean"],
  ["SUBJECT_IS_ENEMY",      "The subject is an enemy",         "boolean"],
  ["TRIGGER_IS_SELF",       "I triggered this",                "boolean"],
  ["HAS_ARCANE_WEAPON",     "I have an arcane weapon",         "boolean"],
  ["HAS_MELEE_WEAPON",      "I have a melee weapon",           "boolean"],
  ["HAS_RANGED_WEAPON",     "I have a ranged weapon",          "boolean"],
  ["HAS_SHIELD",            "I have a shield equipped",        "boolean"],
  ["HAS_MARTIAL_ARMOR",     "I have martial armor equipped",   "boolean"],
  ["HAS_FIREARM",           "I have a firearm",                "boolean"],
  ["DAMAGE_IS_HP",          "The damage is to HP",             "boolean"],
  ["DAMAGE_IS_MP",          "The damage is to MP",             "boolean"],
  ["CRIT",                  "The Check was a critical",        "boolean"],
  ["FUMBLE",                "The Check was a fumble",          "boolean"],
  ["HIT_COUNT",             "Number of targets hit",           "number"],
  ["ACTION_COST_MP",        "The action's MP cost",            "number"],
  ["ACTION_TARGET_COUNT",   "Number of targets",               "number"],
  ["ALLY_COUNT",            "Number of allies",                "number"],
  ["ENEMY_COUNT",           "Number of enemies",               "number"],
  ["ROUND",                 "Current round",                   "number"],
  ["CHAR_LEVEL",            "My character level",              "number"],
  ["TARGET_CURRENT_HP",     "The target's current HP",         "number"],
  ["TARGET_MAX_HP",         "The target's maximum HP",         "number"],
  ["HIT_MARGIN",            "How much the attack beat DEF by", "number"],
  ["IS_MY_TURN",            "It is my turn",                   "boolean"],
  ["ANY_ALLY_IN_CRISIS",    "Any ally is in Crisis",           "boolean"],
  ["ANY_ENEMY_IN_CRISIS",   "Any enemy is in Crisis",          "boolean"],
  ["DID_COVER_ALLY",        "I covered an ally",               "boolean"],
];
const CATALOGUE_BY_NAME = new Map(CATALOGUE.map(([name, label, kind]) => [name, { name, label, kind }]));

// Prefix families are open-ended by design (HAS_STATUS_<X>, AE_COUNT_<X>, …),
// so they get a label PATTERN rather than an entry each.
const PREFIX_LABELS = [
  ["HAS_STATUS_",           (x) => `I have the status ${titleCase(x)}`,         "boolean"],
  ["TARGET_HAS_STATUS_",    (x) => `The target has the status ${titleCase(x)}`, "boolean"],
  ["AE_COUNT_",             (x) => `How many ${titleCase(x)} effects I have`,   "number"],
  ["AE_CHARGES_",           (x) => `Charges on my ${titleCase(x)}`,             "number"],
  ["TARGET_AE_COUNT_",      (x) => `How many ${titleCase(x)} effects the target has`, "number"],
  ["TARGET_AE_CHARGES_",    (x) => `Charges on the target's ${titleCase(x)}`,   "number"],
  ["WELLSPRING_",           (x) => `The ${titleCase(x.replace(/_AVAILABLE$/, ""))} wellspring is available`, "boolean"],
  ["SPECIES_IS_",           (x) => `I am a ${titleCase(x)}`,                    "boolean"],
  ["TARGET_SPECIES_IS_",    (x) => `The target is a ${titleCase(x)}`,           "boolean"],
  ["TARGET_SUBTYPE_IS_",    (x) => `The target is a ${titleCase(x)}`,           "boolean"],
  ["HAS_SKILL_",            (x) => `I know ${titleCase(x)}`,                    "boolean"],
  ["TRIGGER_DAMAGE_IS_",    (x) => `The damage is ${titleCase(x)}`,             "boolean"],
  ["VAR_",                  (x) => `The stored value ${titleCase(x)}`,          "number"],
];

function titleCase(s) {
  return String(s).toLowerCase().split("_").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Human description + value kind for any identifier, catalogued or not. */
export function describeIdentifier(name) {
  const hit = CATALOGUE_BY_NAME.get(name);
  if (hit) return hit;
  for (const [prefix, fn, kind] of PREFIX_LABELS) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return { name, label: fn(name.slice(prefix.length)), kind, family: prefix };
    }
  }
  // Unknown but well-formed: still usable, just plainly labelled. Never refuse
  // to describe an identifier — the validator decides what is real, not this.
  return { name, label: titleCase(name), kind: "number", unlisted: true };
}

/** The catalogue as option rows for a picker, richest first. */
export function identifierOptions() {
  return CATALOGUE.map(([name]) => describeIdentifier(name));
}

// ── model ───────────────────────────────────────────────────────────────────
/**
 * A condition:
 *   { join: "&&" | "||", clauses: [{ left, op, right }] }
 * `left` is an identifier, `right` a literal (number, or a bare word for the
 * string-valued accessors). A one-clause condition carries join "&&" by
 * convention; it is not emitted.
 */

export function compile(condition) {
  if (!condition || !Array.isArray(condition.clauses) || !condition.clauses.length) return "";
  const join = condition.join === "||" ? "||" : "&&";
  const parts = condition.clauses.map((c) => {
    const op = OP_BY_SYMBOL.has(c.op) ? c.op : "==";
    return `${c.left} ${op} ${c.right}`;
  });
  return parts.join(` ${join} `);
}

/**
 * Parse a formula into the model, or return null.
 *
 * Returns null — deliberately, not an approximation — for anything with
 * parentheses, arithmetic, mixed connectives, or a clause that is not a plain
 * `IDENT OP VALUE`. The caller keeps the raw text in that case. Round-tripping
 * a formula the builder only half-understands is how a working gate gets
 * silently rewritten, which is the one outcome worse than showing raw text.
 */
export function parse(formula) {
  const src = String(formula ?? "").trim();
  if (!src) return null;
  if (/[()]/.test(src)) return null;                       // grouping: out of scope
  if (src.includes("&&") && src.includes("||")) return null; // mixed connectives

  const join = src.includes("||") ? "||" : "&&";
  const rawClauses = src.split(join === "||" ? "||" : "&&");
  const clauses = [];
  for (const raw of rawClauses) {
    const c = parseClause(raw.trim());
    if (!c) return null;
    clauses.push(c);
  }
  if (!clauses.length) return null;
  return { join: clauses.length > 1 ? join : "&&", clauses };
}

function parseClause(text) {
  for (const { op } of OPERATORS) {
    const i = text.indexOf(op);
    if (i < 0) continue;
    // `>=` contains `>`; OPERATORS is ordered so the longer form is found
    // first, but a `>` search would still match inside `>=`. Guard explicitly.
    if (op === ">" && text[i + 1] === "=") continue;
    if (op === "<" && text[i + 1] === "=") continue;
    const left = text.slice(0, i).trim();
    const right = text.slice(i + op.length).trim();
    if (!left || !right) return null;
    // LEFT must be a single identifier, RIGHT a single literal. Arithmetic on
    // either side means the model cannot represent it faithfully.
    if (!/^[A-Z][A-Z0-9_]*$/.test(left)) return null;
    if (!/^-?\d+(\.\d+)?$/.test(right) && !/^[A-Za-z][A-Za-z0-9_]*$/.test(right)) return null;
    return { left, op, right };
  }
  return null;
}

/** True when the builder can represent this formula exactly. */
export function canRepresent(formula) {
  const model = parse(formula);
  if (!model) return false;
  return compile(model) === normalizeSpacing(formula);
}

/** Spacing the compiler emits, so round-trip compares content not whitespace. */
export function normalizeSpacing(formula) {
  let s = String(formula ?? "").trim().replace(/\s+/g, " ");
  for (const { op } of OPERATORS) s = s.split(op).map((x) => x.trim()).join(` ${op} `);
  // The two-char operators were just split by their prefixes too; rebuild.
  s = s.replace(/>\s*=/g, ">=").replace(/<\s*=/g, "<=")
       .replace(/=\s*=/g, "==").replace(/!\s*=/g, "!=");
  return s.replace(/\s*(&&|\|\|)\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

/** Plain-English rendering of a condition, for a preview line. */
export function explain(condition) {
  if (!condition?.clauses?.length) return "(always)";
  const lines = condition.clauses.map((c) => {
    const d = describeIdentifier(c.left);
    const opLabel = OP_BY_SYMBOL.get(c.op)?.label ?? c.op;
    if (d.kind === "boolean" && (c.right === "1" || c.right === "0")) {
      const positive = (c.right === "1") === (c.op === "==");
      return positive ? d.label : `NOT: ${d.label}`;
    }
    return `${d.label} ${opLabel} ${c.right}`;
  });
  if (lines.length === 1) return lines[0];
  const joiner = condition.join === "||" ? "OR" : "AND";
  return lines.join(`  ${joiner}  `);
}

/** Every identifier a condition references — feeds the validator's check. */
export function identifiersUsed(condition) {
  return [...new Set((condition?.clauses ?? []).map((c) => c.left))];
}

export { identifiersIn };
