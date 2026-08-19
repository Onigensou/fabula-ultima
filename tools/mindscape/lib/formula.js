"use strict";
//
// Mindscape — the small formula evaluator for sheet-authored numbers.
//
// Sheet numeric fields are not always numbers. Measured on the live party:
//
//   Create Phantasm: Strike   12 + (CHAR_LEVEL >= 20) * 4 + (CHAR_LEVEL >= 40) * 2
//   Muleta                    10 + (CHAR_LEVEL>=20)*5 + (CHAR_LEVEL>=40)*5
//   Descabello                30 + floor(CHAR_LEVEL/2)
//   Last Den of Cinders       (OWN_SUMMON_COUNT * 20) + 20
//
// `Number(x) || 0` silently turns every one of these into ZERO. That shipped in
// the first extractor and under-rated Create Phantasm: Strike by 18 damage while
// still reporting it as a fully modelled action — a silent approximation of
// exactly the kind Part 7 of the spec exists to forbid.
//
// So: evaluate what is knowable offline, and REFUSE what is not. OWN_SUMMON_COUNT
// is runtime state; a formula containing it has no offline value and must make
// its action unmodelled rather than resolve to a plausible number.

// Identifiers whose value is known from the actor at load time.
function knownVars(actor) {
  return {
    CHAR_LEVEL: Number(actor?.level) || 0,
    SL: 1,   // Skill Level. Not stored per-actor; 1 is the floor, and any use of
             // SL is reported by the caller as an approximation rather than hidden.
  };
}

// Functions the sheet uses.
const FUNCS = { floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max };

// Anything that is not a number, operator, paren, comma, space or a known
// identifier makes the formula unresolvable. This is a whitelist: the failure
// mode for an unrecognised token is refusal, never a guess.
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

function evaluate(raw, actor) {
  const src = String(raw ?? "").trim();
  if (!src) return { ok: true, value: 0 };

  // Fast path: a plain number.
  if (/^-?\d+(\.\d+)?$/.test(src)) return { ok: true, value: Number(src) };

  const vars = knownVars(actor);

  // Reject any character outside the arithmetic grammar before looking at
  // identifiers, so nothing exotic can reach the evaluator.
  if (!/^[A-Za-z0-9_+\-*/%<>=!&|().,\s?:]+$/.test(src)) {
    return { ok: false, reason: `formula "${src}" contains unsupported characters` };
  }

  const unknown = [];
  let usedSL = false;
  for (const m of src.matchAll(TOKEN_RE)) {
    const id = m[0];
    if (id in FUNCS) continue;
    if (id in vars) { if (id === "SL") usedSL = true; continue; }
    unknown.push(id);
  }
  if (unknown.length) {
    return { ok: false, reason: `formula "${src}" needs runtime state: ${[...new Set(unknown)].join(", ")}` };
  }

  // Every identifier is known and every character is in the grammar, so this is
  // arithmetic over a closed set. Booleans from comparisons coerce to 0/1, which
  // is exactly what the sheet's `(CHAR_LEVEL>=20)*10` idiom relies on.
  const names = [...Object.keys(vars), ...Object.keys(FUNCS)];
  const values = [...Object.values(vars), ...Object.values(FUNCS)];
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `"use strict"; return (${src});`);
    const v = Number(fn(...values));
    if (!Number.isFinite(v)) return { ok: false, reason: `formula "${src}" did not evaluate to a number` };
    return { ok: true, value: v, approximate: usedSL, ...(usedSL ? { note: "assumes SL 1" } : {}) };
  } catch (e) {
    return { ok: false, reason: `formula "${src}" failed to evaluate: ${e.message}` };
  }
}

module.exports = { evaluate, knownVars, FUNCS };
