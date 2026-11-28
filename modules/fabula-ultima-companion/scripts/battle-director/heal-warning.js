// heal-warning.js — "this heal will hurt" for the target picker (approved 2026-11-28,
// claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX, section "Zombie" B).
//
// While a player picks targets for an HP heal, a red "Heal hurts" chip sits after the
// name of every creature the heal would DAMAGE (with the Zombie icon when it is the
// status). It warns, it never blocks: healing an enemy zombie is a fair attack.
// Attacks never show it. The action card says the same thing on its rows
// (action-card.js healRevPillHTML / resultLabelFor), from the same rule.
//
// Reveal gate (user, 2026-11-28): a Zombie STATUS is visible on the token, so it is
// always warned about. A creature that is Undead by SPECIES is warned about only once
// the party knows its species: an ally, or a foe Studied to the Identity tier (the
// encyclopedia tier that reveals Species; the same gate that masks DEF / affinity on
// the card, action-profile makeStudiedGate). An unknown Undead gets no chip; the heal
// still reverses when it lands (the engine is unchanged).
//
// Pure (no Foundry globals except the encyclopedia API, which callers may pass in).

import { healReversalReason } from "./skill-formulas.js";

const NS = "fabula-ultima-companion";
export const TIER_IDENTITY = 7;   // encyclopedia-core TIER_IDENTITY: Rank, Species, HP/MP, DEF/MDEF…

/** Has the party Studied this creature to Identity? uuids = [world actor uuid, token actor uuid]. */
export function studiedToIdentity(uuids, enc = globalThis.FUCompanion?.api?.encyclopedia) {
  if (!enc?.getPageForActor) return null;          // no encyclopedia: caller decides
  for (const uuid of (uuids ?? []).filter(Boolean)) {
    try {
      const page = enc.getPageForActor(uuid);
      const best = Number(page?.getFlag?.(NS, "encyclopedia")?.bestResult ?? 0) || 0;
      if (best >= TIER_IDENTITY) return true;
    } catch { /* try next */ }
  }
  return false;
}

/**
 * Does the caster's side know this target's species? Same rule as the card's Studied
 * gate: only a FRIENDLY caster looking at a HOSTILE target needs the Study; with no
 * encyclopedia the card's gate shows everything, and so does this.
 */
export function speciesKnown({ casterDisposition, targetDisposition, uuids, enc } = {}) {
  if (casterDisposition !== 1) return true;
  if (targetDisposition !== -1) return true;
  const s = studiedToIdentity(uuids, enc);
  return s === null ? true : s;
}

/**
 * The picker chip for one target of an HP heal: { text, zombie } or null.
 * `known(actor)` answers the reveal gate for a species-only Undead.
 */
export function healHurtsChip(actor, { known = () => true } = {}) {
  const why = healReversalReason(actor);
  if (!why) return null;
  if (why === "zombie") return { text: "Heal hurts", zombie: true };
  if (why === "effect") return { text: "Heal hurts", zombie: false };
  return known(actor) ? { text: "Heal hurts · Undead", zombie: false } : null;
}
