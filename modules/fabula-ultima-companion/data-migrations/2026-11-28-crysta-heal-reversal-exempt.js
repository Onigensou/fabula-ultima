/**
 * Migration: 2026-11-28-crysta-heal-reversal-exempt
 * ---------------------------------------------------------------------------
 * Crysta is Undead by species (UNDEAD) but fights on the party's side, and the user
 * approved (2026-11-28) that her species does NOT turn heals into damage: she heals
 * normally and is no revive-kill target. A Zombie STATUS on her still reverses heals
 * (skill-formulas.js isHealReversedActor / healReversalReason read the flag for the
 * species part only).
 *
 * Sets `flags.fabula-ultima-companion.healReversalExempt = true` on the Crysta world
 * actor (id ZPPCxB0eOJPulEHv; any other world actor named exactly "Crysta" too). Her
 * battle tokens are spawned from that actor (director-init spawn: td.actorId), so the
 * synthetic token actors and sim clones (toObject) inherit the flag.
 *
 * One-time. Writes only when the flag is not already true.
 */

export const key = "2026-11-28-crysta-heal-reversal-exempt";
export const description = "Crysta: her Undead species no longer reverses heals (healReversalExempt flag; a Zombie status still does).";

const M = "fabula-ultima-companion";
const CRYSTA_ID = "ZPPCxB0eOJPulEHv";

export async function migrate(game, log = () => {}) {
  const out = [];
  const targets = new Map();
  const byId = game.actors?.get?.(CRYSTA_ID);
  if (byId) targets.set(byId.id, byId);
  for (const a of game.actors ?? []) if (a?.name === "Crysta") targets.set(a.id, a);
  if (!targets.size) out.push("Crysta actor not found, nothing to do");
  for (const a of targets.values()) {
    if (a.flags?.[M]?.healReversalExempt === true) { out.push(`${a.name} (${a.id}): already exempt`); continue; }
    await a.update({ [`flags.${M}.healReversalExempt`]: true });
    out.push(`${a.name} (${a.id}): heals normally (healReversalExempt)`);
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
