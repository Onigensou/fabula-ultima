// ============================================================================
// Out of play — a combatant that stays IN the conflict but is not on the field
// right now (docs/nidhogg-boss-design.md §6c). Leaf module: no imports.
//
// First users: Nidhogg's hidden Crystal (while the dragon fights) and the fallen
// dragon (through the Crystal Round). Later bosses can reuse it.
//
// It is ONE Active Effect on the actor: flags.<ns>.outOfPlay = true, plus the
// shared targeting block `cannot_be_targeted_by: any` (mode 5, the Guest's
// primitive) — so every picker, AoE / all-enemies pool, action card list,
// formula and the AI's own target filter (actionReader isUntargetableActor)
// already leave it out, with no code of their own.
//
// The read sites that need THIS flag (keep the list here, like battlefield-object.js):
//   - turns: 0 activations                    director-combat.js _effectiveActivation
//   - turn bar icons + GM desk tiles: omitted director-round-banner.js buildTurnActionSnapshot
//   - HP bar: none                            damage-numbers/director-hp-bar.js
//   - crisis: none                            crisis-reactor.js
//   - drawing: mesh / bars / nameplate / shadow hidden on every client
//                                             out-of-play-render.js
//   - the Sealing Crystal host: not drawn     sealing-crystal/crystal-runtime.js
//   - SIDE WIPE: STILL COUNTS, on purpose. The hidden Crystal must keep the enemy
//     side alive while the dragon is down, or his first fall reads as a victory
//     (state-handlers.js countsForSideWipe: NO change).
// Not a token `hidden` flag (BD filters !t.hidden in places, and the GM still sees
// hidden tokens), and not bdObject (that drops it from the side-wipe tally).
// ============================================================================

const NS = "fabula-ultima-companion";
export const OUT_OF_PLAY_FLAG = "outOfPlay";
export const OUT_OF_PLAY_NAME = "Out of Play";

/** The AE's data (create it on the actor). `extra` merges into its flags[ns] (e.g. a reason). */
export function outOfPlayEffectData(extra = {}) {
  return {
    name: OUT_OF_PLAY_NAME,
    img: "icons/svg/invisible.svg",
    disabled: false,
    transfer: false,
    changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "any", priority: 50 }],
    // never ticked (directorPermanent), but battle-scoped (conflictScoped: the scene-end sweep still takes it, so a
    // battle that ends any way at all never leaves a linked actor out of play); no buff/debuff tag, so no cleanse
    // (Dispel, the on-KO cleanse) can remove it
    flags: { [NS]: { [OUT_OF_PLAY_FLAG]: true, directorPermanent: true, conflictScoped: true, ...extra } },
  };
}

const effectsOf = (actor) => {
  const e = actor?.effects;
  if (!e) return [];
  return Array.isArray(e) ? e : (e.contents ?? [...e]);
};
const isOopEffect = (ef) => ef?.flags?.[NS]?.[OUT_OF_PLAY_FLAG] === true;

/** True while the actor carries an enabled Out of Play effect. Accepts an actor, a token, or a token document. */
export function isOutOfPlay(subject) {
  const actor = subject?.actor ?? subject;
  for (const ef of effectsOf(actor)) if (isOopEffect(ef) && !ef.disabled) return true;
  return false;
}

/** The actor's Out of Play effects (any, enabled or not). */
export function outOfPlayEffects(actor) {
  return effectsOf(actor).filter(isOopEffect);
}

/** Put the actor out of play (on) or back in play (off). Idempotent. Resolves when written. */
export async function setOutOfPlay(actor, on, extra = {}) {
  if (!actor) return false;
  const have = outOfPlayEffects(actor);
  if (on) {
    if (have.some((e) => !e.disabled)) return false;
    await actor.createEmbeddedDocuments("ActiveEffect", [outOfPlayEffectData(extra)]);
    return true;
  }
  if (!have.length) return false;
  await actor.deleteEmbeddedDocuments("ActiveEffect", have.map((e) => e.id));
  return true;
}
