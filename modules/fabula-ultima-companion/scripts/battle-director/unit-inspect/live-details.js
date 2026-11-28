// Battle Inspect / Study card — the battle-variable half of an enemy's Details.
//
// The Encyclopedia entry (getEntryData) reads the creature's PROTOTYPE world
// actor: that is the record of what the party knows, shared by every token of
// the creature, and it decides WHAT a player may see (the Study tiers).
//
// The VALUES of the sections that change mid-battle must come from the token
// actually on the field instead. An unlinked enemy token carries its own actor:
// Rakshasa's Adaptive Defense rewrites `<family>_ef` on the token (bow 25%), an
// Asura Mark makes an affinity RS on the token, while the prototype keeps the
// authored 100% / VU. Reading the prototype there showed the table numbers the
// fight no longer has.
//
// So: the gate (is `details` present at all, is it GM-only) stays the
// Encyclopedia's; only the numbers are swapped for the live token's.
// Affinities are already read live in inspect-model (resolveAffinity).

// Same lists as encyclopedia-core.js (WEAPON_TYPES / CONDITIONS) — a test pins them.
export const WEAPON_TYPES = Object.freeze(["arcane", "bow", "brawling", "dagger", "firearm", "flail", "heavy", "spear", "sword", "thrown"]);
export const CONDITIONS = Object.freeze([
  "slow", "dazed", "weak", "shaken", "poisoned", "enraged", "silence", "stagger",
  "frightened", "paralyzed", "confused", "panic", "grappled", "envenomed", "burn",
  "blind", "zombie", "wither", "bleed", "obscure", "fatigue", "charm", "berserk",
  "despair", "doom", "bane", "curse", "wet", "oil", "petrify", "hypothermia",
  "turbulence", "delayed", "isolate", "suppress", "disarmed", "anomaly", "sleep", "stunned",
]);
const GRADES = new Set(["RS", "VU", "AB", "IM"]);

/** Weapon efficiency rows from live props. A stored 0 / blank means 100% (readWeaponEfficiency's rule). */
export function liveWeapons(props) {
  const p = props ?? {};
  return WEAPON_TYPES.map((type) => {
    const n = Number(p[`${type}_ef`]);
    return { type, pct: Number.isFinite(n) && n > 0 ? n : 100 };
  });
}

/** Status affinities (RS/VU/AB/IM only) from live props. */
export function liveConditions(props) {
  const p = props ?? {};
  return CONDITIONS
    .map((name) => ({ name, code: String(p[`condition_${name}`] ?? "").trim().toUpperCase() }))
    .filter((c) => GRADES.has(c.code));
}

/**
 * The Encyclopedia's `details` block with its battle-variable values replaced by
 * the live token actor's. `det` null (locked) stays null: this never reveals.
 */
export function withLiveDetails(det, liveProps) {
  if (!det || !liveProps) return det ?? null;
  return { ...det, weapons: liveWeapons(liveProps), conditions: liveConditions(liveProps), conditionTotal: CONDITIONS.length };
}
