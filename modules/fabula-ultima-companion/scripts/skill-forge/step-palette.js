// [ONI] Skill Forge — the step palette.
//
// What a new row is ALLOWED to contain, derived from the column registry.
//
// ═══ WHY THIS IS NOT A LIST OF FIELDS SOMEBODY TYPED ═══════════════════════
//
// Adding a step means writing columns, and a column the row's `effect_kind`
// does not declare is written, reported as saved, and silently dropped — the
// single failure this whole tool exists to prevent, committed by the tool.
// `visibility-audit` measures 41 such row keys across 275 authored cells today.
//
// So the palette reads `template-field-registry.js`, which is already the
// single source of truth for declarative row fields and is already what the
// boot sync ships onto every template. A kind's fields are the columns whose
// visibility gate names that kind, and nothing else. A second hand-maintained
// list here could disagree with the template, and the disagreement would be
// invisible until an author lost a value.

import {
  EFFECT_TABLE_REQUIRED_COLUMNS,
  REQUIRED_COLUMNS_BY_TABLE,
  REQUIRED_FIELDS_BY_KIND,
} from "../battle-director/template-field-registry.js";

/**
 * The kinds a gate names, pulled out of its formula.
 *
 * Gates are written as `equalText(sameRow("effect_kind",''), "deal_damage")`,
 * optionally wrapped in `or(...)`. Parsing the formula is how the palette stays
 * in step with the registry: the same string the sheet uses to decide whether
 * to SHOW a column decides whether the palette OFFERS it.
 */
export function kindsInGate(formula) {
  const out = new Set();
  const re = /equalText\(\s*sameRow\(\s*"effect_kind"[^)]*\)\s*,\s*"([a-z_]+)"\s*\)/g;
  for (const m of String(formula ?? "").matchAll(re)) out.add(m[1]);
  return out;
}

/** Every effect kind the registry knows, from its gates and its required map. */
export function stepKinds() {
  const kinds = new Set(Object.keys(REQUIRED_FIELDS_BY_KIND ?? {}));
  for (const col of EFFECT_TABLE_REQUIRED_COLUMNS ?? []) {
    for (const k of kindsInGate(col.visibilityFormula)) kinds.add(k);
  }
  return [...kinds].sort();
}

/**
 * The columns that belong on a row of this kind.
 *
 * An UNGATED column (blank `visibilityFormula`) applies to every kind — that is
 * what the sheet does with it, so it is what this does too.
 */
export function columnsForKind(kind) {
  const k = String(kind ?? "").trim();
  if (!k) return [];
  const out = [];
  for (const col of EFFECT_TABLE_REQUIRED_COLUMNS ?? []) {
    if (!col?.key) continue;
    const gate = String(col.visibilityFormula ?? "").trim();
    const named = kindsInGate(gate);
    // Gated at all, but not at this kind ⇒ not this kind's field. A gate this
    // parser cannot read is treated as UNGATED rather than skipped: showing a
    // field that does not apply is a cosmetic error, hiding one an author needs
    // is the failure mode.
    if (named.size && !named.has(k)) continue;
    out.push(col);
  }
  return out;
}

/** Fields the engine REFUSES to run this kind without. */
export function requiredFieldsForKind(kind) {
  const spec = (REQUIRED_FIELDS_BY_KIND ?? {})[String(kind ?? "").trim()];
  if (!spec) return { all: [], either: [] };
  return { all: [...(spec.all ?? [])], either: (spec.either ?? []).map((g) => [...g]) };
}

/**
 * A brand-new row for this kind.
 *
 * MINIMAL BY DESIGN: the kind, the name, and the fields the engine will refuse
 * to run without. Nothing else.
 *
 * Seeding every gated column would write 20-40 blank keys per row. Blank keys
 * are not a data-loss risk (`skill-forge-design.md` D4 — CSB stamps them
 * wholesale and deleting `""` loses nothing), but they ARE export churn on
 * every added step, and this project's review surface is a diff. The author
 * fills what they need; the inspector offers the rest of the kind's columns.
 */
export function newRowFor(kind, label) {
  const k = String(kind ?? "").trim();
  const name = String(label ?? "").trim();
  if (!k) return { ok: false, reason: "pick what the step should do" };
  if (!name) return { ok: false, reason: "a step needs a name" };
  if (!stepKinds().includes(k)) return { ok: false, reason: `"${k}" is not a step kind the template declares` };

  const row = { effect_kind: k, effect_label: name };
  const req = requiredFieldsForKind(k);
  for (const f of req.all) row[f] = "";
  // For an either-group the engine needs ONE of them; seeding the first gives
  // the author a visible slot without pretending both are wanted.
  for (const group of req.either) if (group[0]) row[group[0]] = "";

  return { ok: true, row, required: req };
}

/** Sanity: does the registry actually declare a column for every key we write? */
export function declaredColumnKeys(table = "effect_table") {
  return new Set(((REQUIRED_COLUMNS_BY_TABLE ?? {})[table] ?? []).map((c) => c.key));
}
