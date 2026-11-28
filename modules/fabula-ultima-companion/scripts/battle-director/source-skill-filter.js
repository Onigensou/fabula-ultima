// scripts/battle-director/source-skill-filter.js
// The `reaction_source_skill` name filter, parsed in ONE place.
//
// A row scoped to the skill that drives its trigger names that skill. Since
// 2026-11-28 the cell may name several skills, comma-separated
// ("Elemental Slash, Elemental Slash: Overflow"): the row fires when the acting
// skill is ANY of them. Exact names, case-insensitive, whitespace-trimmed; blank
// = any skill (no-op for every unscoped row). A single name behaves exactly as
// before. No skill name in the world carries a comma (checked 2026-11-28), so
// the comma is a safe separator.
//
// Pure: no Foundry globals, so the decision is unit-tested in node
// (source-skill-filter.test.mjs).

// The names a row's cell lists, trimmed, blanks dropped, original casing kept
// (the reaction hand shows them). [] = no filter.
export function sourceSkillNames(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Does the acting skill `gotName` pass the row's filter `raw`?
// Blank filter → true. A filter with names → the acting name must equal one of
// them (case-insensitive). An action with no name fails a non-blank filter
// (fail CLOSED, as before: a rider scoped to one skill must not leak onto an
// unnamed dispatch).
export function sourceSkillMatches(raw, gotName) {
  const want = sourceSkillNames(raw).map((s) => s.toLowerCase());
  if (!want.length) return true;
  const got = String(gotName ?? "").trim().toLowerCase();
  return !!got && want.includes(got);
}
