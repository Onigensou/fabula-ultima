/**
 * Who advancement is FOR.
 *
 * Levelling, Skill Points and Attribute Advances are player-character systems.
 * Nothing else in the world is meant to reach them — a monster does not spend a
 * Skill Point, and raising its MIG die is a balance edit that belongs on the
 * sheet, not behind a camp-gated player window.
 *
 * The systems had no such check. Eligibility was pure arithmetic on
 * `system.props.level` against the claimed ledger, and every NPC carries a
 * level, so a GM who selected a level-40 monster token at camp was told they
 * had two unspent Attribute Points and offered arrows to spend them. Confirming
 * would have written `<attr>_base` onto the monster for real: the GM-side
 * handler validated the gate, the count, the die cap and the attribute key, but
 * never the subject.
 *
 * HOW A PLAYER CHARACTER IS RECOGNISED
 * ------------------------------------
 * By PROPS, not by document type. CSB makes every actor the Foundry "character"
 * type, so `actor.type` cannot separate Hina from a Flame Drake. NPCs carry
 * `npc_rank` and/or `species`; player characters carry neither.
 *
 * BOTH props are tested, because either can stand alone:
 *   - most monsters carry both ("elite" + "MONSTER")
 *   - Cardinal Gora carries an EMPTY npc_rank and `species: HUMANOID`, so a
 *     rank-only test — which is what defeat-reactor.js uses for its own, much
 *     narrower purpose — would wave it straight through
 *
 * `hasPlayerOwner` is deliberately NOT used. ~150 actors in this world report it
 * (retired PCs, guests, class templates); sim-run.js documents the same trap.
 */

/** Trimmed string value of a prop, or "" when absent/blank. */
const prop = (actor, key) => String(actor?.system?.props?.[key] ?? "").trim();

/**
 * May this actor use the advancement systems at all?
 *
 * True for player characters, false for anything carrying an NPC marker. A
 * missing actor is false — callers treat "no subject" and "wrong subject" the
 * same way, and neither may write.
 */
export function isAdvancementSubject(actor) {
  if (!actor) return false;
  return !prop(actor, "npc_rank") && !prop(actor, "species");
}

/**
 * The failure reason for a write handler, or null when the actor is eligible.
 *
 * Shaped for `fail()` in both API modules so the two domains report the same
 * reason string for the same condition.
 */
export function subjectFailure(actor) {
  if (!actor) return "actor_not_found";
  return isAdvancementSubject(actor) ? null : "not_a_player_character";
}

/**
 * The actor a UI should act on, given a controlled token and an assigned
 * character — or null when neither qualifies.
 *
 * Both entry points want the same order and the same filter: an explicitly
 * selected token first (this is how a GM operates the system on a player's
 * behalf), falling back to the user's own character. An ineligible selection
 * does not fall through to the assigned character — selecting a monster is a
 * deliberate act, and quietly retargeting the window at someone else would be
 * worse than showing nothing.
 */
export function advancementTarget() {
  const selected = canvas?.tokens?.controlled?.[0]?.actor ?? null;
  if (selected) return isAdvancementSubject(selected) ? selected : null;
  const own = game.user?.character ?? null;
  return own && isAdvancementSubject(own) ? own : null;
}
