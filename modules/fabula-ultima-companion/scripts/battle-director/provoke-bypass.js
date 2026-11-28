// scripts/battle-director/provoke-bypass.js
// "Ignores Provoke" — a skill-level setting for boss signature moves.
//
// User rule 2026-11-28: provoking a boss is fine, but its signature move goes
// through. Authored as the action keyword `ignore_provoke` in the move's own
// `action_keywords` list (the same comma/newline list as pierce / chain N /
// massive / silent), so it needs no new sheet field. Accepted spellings:
// "ignore_provoke", "ignore provoke", "ignores provoke", "ignores_provoke".
//
// What it bypasses: the Provoked pin (`must_include_applier`, attacker side)
// at every place it narrows targets —
//   - the TARGET picker / AI pick pins (state-handlers resolveActionTargets),
//   - the drawn-Chain "strike 1 goes to the provoker" pin (pinProvokerStrike),
//   - the row-level narrowing of the action's own effect rows (skill-targeting),
//   - the player compose pins (compose-action),
//   - ACTION_IS_PROVOKABLE (Peacock Dance's one-shot consume reads the same kind).
// What it does NOT bypass: taunter pins on the target side (must_be_targeted_by,
// Covered / forcedInclude) and every other targeting rule — only Provoke.
//
// Pure: no Foundry globals (provoke-bypass.test.mjs).

export const IGNORE_PROVOKE_KEYWORD = "ignore_provoke";
const SPELLINGS = new Set(["ignore_provoke", "ignore provoke", "ignores_provoke", "ignores provoke"]);

// A keyword list (string, comma/newline separated, or array) carries the setting?
export function keywordsIgnoreProvoke(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").replace(/<[^>]*>/g, " ").split(/[,\n]+/);
  return list.some((k) => SPELLINGS.has(String(k ?? "").trim().toLowerCase().replace(/\s+/g, " ")));
}

// The keyword list of an action source: a skill/weapon Item document
// (system.props.action_keywords), a weapon snapshot / pseudo-weapon
// (actionKeywords / action_keywords), or a raw keyword string.
function keywordsOf(src) {
  if (src == null) return "";
  if (typeof src === "string" || Array.isArray(src)) return src;
  return src?.system?.props?.action_keywords ?? src?.actionKeywords ?? src?.action_keywords ?? "";
}

// Does ANY of the given sources (the acting skill, its weapon) ignore Provoke?
export function actionIgnoresProvoke(...sources) {
  return sources.some((s) => keywordsIgnoreProvoke(keywordsOf(s)));
}

// Random-target actions ignore Provoke too (user rule 2026-11-28): a move that does not
// declare its target outright — a "One Random …" skill_target, a roulette weapon, or a
// drawn Chain (random / seek / volley) — might or might not hit the provoker, so no pin.
// (Hit-everyone moves already include the provoker; a declared single target keeps the pin.)
const DRAWN_CHAIN = new Set(["random", "seek", "volley"]);
export function targetsAtRandom({ skillTarget = "", hasRoulette = false, chainMode = "" } = {}) {
  if (hasRoulette) return true;
  if (DRAWN_CHAIN.has(String(chainMode ?? "").toLowerCase())) return true;
  return /\brandom\b/i.test(String(skillTarget ?? ""));
}

// The kind an action presents to the Provoked pin, after the bypass: the given
// kind ("attack" / "spell"), or null when the action ignores Provoke (null = no
// attacker-side pin, exactly as for a heal or buff).
export function provokePinKind(kind, ...sources) {
  if (!kind) return kind ?? null;
  return actionIgnoresProvoke(...sources) ? null : kind;
}
