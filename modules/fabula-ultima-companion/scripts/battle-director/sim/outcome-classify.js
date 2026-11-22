// Sim verdict from a combat snapshot — pure (no imports) so it can be tested
// without Foundry. Mirrors battle-end/outcome-inference.js (the live verdict):
// same counted creatures (no guests, no battlefield objects), same precedence.

// A guest fights on the party side but is NOT a party member for any verdict; a
// battlefield object is the same on the enemy side. Same distinction as
// countsForSideWipe (state-handlers).
export function countsForReporting(c) {
  return !c?.isGuest && !c?.isObject;
}

export function classify(snap) {
  if (!snap) return "unknown";
  // Explicit outcome stamped by content (boss Ascension loss, Run Away, ...)
  // wins, exactly as detectOutcome does.
  const forced = String(snap.outcomeOverride ?? "").trim().toLowerCase();
  if (forced === "victory" || forced === "defeat" || forced === "escaped") return forced;
  const party = snap.combatants.filter((c) => c.side === "party" && countsForReporting(c));
  const enemy = snap.combatants.filter((c) => c.side === "enemy" && countsForReporting(c));
  const partyDead = party.length > 0 && party.every((c) => c.defeated);
  const enemyDead = enemy.length > 0 && enemy.every((c) => c.defeated);
  // Enemy side wiped wins even with every PC down: that is a HELD party wipe
  // (boss rule) followed by the core breaking, and detectOutcome says "victory".
  if (enemyDead) return "victory";
  if (partyDead) return "defeat";
  return "inconclusive";
}
