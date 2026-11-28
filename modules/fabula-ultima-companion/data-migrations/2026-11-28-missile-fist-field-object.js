/**
 * Migration: 2026-11-28-missile-fist-field-object  (user rule, playtest 2026-11-28)
 * ---------------------------------------------------------------------------
 * "King Gorger's action is not a damaging action so it should only target Deva, while damaging actions like
 * Kalina's attack are okay to target a fist." The Missile Fist is a thing on the field, not an enemy in the
 * traditional sense: actor flag fieldObject = true. ActionReader (buildAndPickTargets isFieldObjectActor) drops it
 * from an AI action's candidates unless that action deals damage. Targeting stays random otherwise. Summoned copies
 * inherit the flag from the base actor. Idempotent.
 */
export const key = "2026-11-28-missile-fist-field-object";
export const description = "Missile Fist is a field object: AI actions that deal no damage never target it.";

const M = "fabula-ultima-companion";
const FIST = "MsFistSummon0001";

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const a of game.actors) {
    if (a.id !== FIST && !/^missile fist$/i.test(a.name ?? "")) continue;
    if (a.getFlag(M, "fieldObject") === true) continue;
    await a.update({ [`flags.${M}.fieldObject`]: true }); out.push(`~ ${a.name} (${a.id}): field object`);
  }
  if (!out.length) out.push("= Missile Fist already a field object (or not in the world)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
