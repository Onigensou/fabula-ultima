// Grappled (Advanced Debuff) — shared relationship helpers.
//
// Grappled is applied as an AE named "Grappled" via the effect dispatcher
// (apply_ae). The dispatcher stamps the grappler on the AE's
// `flags["fabula-ultima-companion"].directorAppliedBy` (reactorActorUuid +
// reactorTokenUuid). These helpers read that link so the Grappled mechanics
// (break-free, Guard-Cover end, shared-space redirect targeting) can resolve
// "who grappled whom" without re-deriving it per call site.
//
// Spec (in-world Journal "Grappled"): the grappled unit shares the grappler's
// space; a third-party effect targeting the grappler also hits the grappled
// unit; performing a Guard-Cover ends the cover; a DC10 (≥1 DEX/MIG die) check
// breaks free (free action at turn start, or via the Objective action).
// See [[project_grappled_advanced_debuff]].

const NS = "fabula-ultima-companion";
const GRAPPLED_NAME = "grappled";

const nameMatches = (e) => String(e?.name ?? "").trim().toLowerCase() === GRAPPLED_NAME;

/** Non-disabled "Grappled" AEs on an actor. */
export function grappledAEsOn(actor) {
  const effects = actor?.effects?.contents ?? (Array.isArray(actor?.effects) ? actor.effects : []);
  return effects.filter((e) => e && !e.disabled && nameMatches(e));
}

/** Is this actor currently Grappled? */
export function isGrappled(actor) {
  return grappledAEsOn(actor).length > 0;
}

/**
 * The grappler holding `actor`, read from the first Grappled AE that carries a
 * grappler link. Returns { actorUuid, tokenUuid } | null.
 */
export function grapplerOf(actor) {
  for (const ae of grappledAEsOn(actor)) {
    const by = ae.flags?.[NS]?.directorAppliedBy;
    if (by?.reactorActorUuid || by?.reactorTokenUuid) {
      return { actorUuid: by.reactorActorUuid ?? null, tokenUuid: by.reactorTokenUuid ?? null };
    }
  }
  return null;
}

/** Remove every Grappled AE on `actor` (break free). Returns count removed. */
export async function breakFree(actor, { reason = "" } = {}) {
  const aes = grappledAEsOn(actor);
  if (!aes.length) return 0;
  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", aes.map((e) => e.id));
  } catch (e) {
    console.warn(`[grappled] breakFree: delete failed on ${actor?.name}`, e);
    return 0;
  }
  return aes.length;
}

/**
 * Reverse lookup — every TOKEN whose actor is Grappled by the given grappler.
 * Scans the active scene's tokens (covers unlinked NPC tokens that share one
 * base actor) and matches by token UUID first, falling back to actor UUID.
 * Returns an array of TokenDocuments. Used by the shared-space redirect rule:
 * when the grappler is targeted, these tokens are added as targets too.
 */
export function tokensGrappledBy({ actorUuid = null, tokenUuid = null } = {}) {
  if (!actorUuid && !tokenUuid) return [];
  const out = [];
  const scenes = game.scenes?.active ? [game.scenes.active] : (game.scenes?.contents ?? []);
  for (const scene of scenes) {
    for (const tok of scene.tokens?.contents ?? []) {
      const actor = tok.actor;
      if (!actor) continue;
      for (const ae of grappledAEsOn(actor)) {
        const by = ae.flags?.[NS]?.directorAppliedBy;
        if (!by) continue;
        if ((tokenUuid && by.reactorTokenUuid === tokenUuid) ||
            (actorUuid && by.reactorActorUuid === actorUuid)) {
          out.push(tok);
          break;
        }
      }
    }
  }
  return out;
}
