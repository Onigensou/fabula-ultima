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
// The grappler-side reciprocal AE (applied to whoever applies "Grappled" via
// the supervised reciprocalAe flag in skill-effects.applyApplyAeEffect). It
// hosts the shared-space splash reaction (rule #1).
const GRAPPLING_NAME = "grappling";

const nameMatches = (e) => String(e?.name ?? "").trim().toLowerCase() === GRAPPLED_NAME;
const grapplingMatches = (e) => String(e?.name ?? "").trim().toLowerCase() === GRAPPLING_NAME;

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

/** Non-disabled "Grappling" AEs on an actor (the grappler-side reciprocal). */
export function grapplingAEsOn(actor) {
  const effects = actor?.effects?.contents ?? (Array.isArray(actor?.effects) ? actor.effects : []);
  return effects.filter((e) => e && !e.disabled && grapplingMatches(e));
}

/**
 * Drop a grappler's "Grappling" AE once it holds no one (after a victim breaks
 * free / the grapple ends). Supervised cleanup — called from breakFree. A
 * lingering Grappling is harmless (tokensGrappledBy → empty → the splash adds
 * nothing), so this is hygiene, not correctness. Returns count removed.
 */
export async function syncGrapplingForGrappler(grapplerActor) {
  if (!grapplerActor?.uuid) return 0;
  if (tokensGrappledBy({ actorUuid: grapplerActor.uuid }).length) return 0; // still grappling
  const aes = grapplingAEsOn(grapplerActor);
  if (!aes.length) return 0;
  try {
    await grapplerActor.deleteEmbeddedDocuments("ActiveEffect", aes.map((e) => e.id));
  } catch (e) {
    console.warn(`[grappled] syncGrapplingForGrappler: delete failed on ${grapplerActor?.name}`, e);
    return 0;
  }
  return aes.length;
}

/** Remove every Grappled AE on `actor` (break free). Returns count removed. */
export async function breakFree(actor, { reason = "" } = {}) {
  const aes = grappledAEsOn(actor);
  if (!aes.length) return 0;
  // Capture grapplers BEFORE deletion so we can clean up their reciprocal
  // "Grappling" AE afterwards if they no longer hold anyone.
  const grapplerUuids = new Set();
  for (const ae of aes) {
    const guuid = ae.flags?.[NS]?.directorAppliedBy?.reactorActorUuid;
    if (guuid) grapplerUuids.add(guuid);
  }
  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", aes.map((e) => e.id));
  } catch (e) {
    console.warn(`[grappled] breakFree: delete failed on ${actor?.name}`, e);
    return 0;
  }
  // Reciprocal cleanup (supervised): the victim's Grappled is gone, so drop
  // each grappler's Grappling AE if it now holds no one.
  for (const guuid of grapplerUuids) {
    try {
      const grappler = await fromUuid(guuid);
      if (grappler) await syncGrapplingForGrappler(grappler);
    } catch (e) { console.warn(`[grappled] breakFree: grappling sync failed for ${guuid}`, e); }
  }
  return aes.length;
}

/**
 * End every Guard-cover the given actor is currently PROVIDING to allies
 * (Grappled rule #2): when an actor becomes Grappled, any ally it is covering
 * loses the Covered AE — and that cover's riders (e.g. Bodyguard's RS-to-all
 * AE) — while the guarder keeps its own self-Guard (a separate AE on itself,
 * never touched here).
 *
 * The Covered AE carries the `guardCoverBy = <guarderUuid>` marker (stamped at
 * apply time in skill-effects.js). We find allies covered by this guarder via
 * that marker, then on each such ally remove the Covered AE PLUS the riders the
 * same guarder applied to that ally (matched by directorAppliedBy.reactorActorUuid).
 * Scoped to (this ally + this guarder) so other guarders' covers and unrelated
 * AEs survive. Returns the number of AEs removed.
 */
export async function endGuardCoverProvidedBy(guarderActor) {
  const guarderUuid = guarderActor?.uuid;
  if (!guarderUuid) return 0;
  const scenes = game.scenes?.active ? [game.scenes.active] : (game.scenes?.contents ?? []);
  const seenActors = new Set();
  let removed = 0;
  for (const scene of scenes) {
    for (const tok of scene.tokens?.contents ?? []) {
      const ally = tok.actor;
      if (!ally || seenActors.has(ally.uuid)) continue;
      seenActors.add(ally.uuid);
      const effects = ally.effects?.contents ?? [];
      // Only act on allies this guarder is actually covering.
      const coveredByGuarder = effects.some((e) => e?.flags?.[NS]?.guardCoverBy === guarderUuid);
      if (!coveredByGuarder) continue;
      // The cover (marker) + its riders (same guarder applied them to this
      // covered ally — Bodyguard etc.). A guarder doesn't normally apply
      // non-cover AEs to the very ally it's covering, so this stays precise.
      const ids = effects.filter((e) => {
        const f = e?.flags?.[NS];
        return f?.guardCoverBy === guarderUuid
          || f?.directorAppliedBy?.reactorActorUuid === guarderUuid;
      }).map((e) => e.id);
      if (!ids.length) continue;
      try {
        await ally.deleteEmbeddedDocuments("ActiveEffect", ids);
        removed += ids.length;
      } catch (e) {
        console.warn(`[grappled] endGuardCoverProvidedBy: delete failed on ${ally?.name}`, e);
      }
    }
  }
  if (removed) {
    console.log(`[grappled] ${guarderActor.name} became Grappled — ended Guard-cover (${removed} AE(s) removed)`);
  }
  return removed;
}

// Module-level guard so repeated director boots (rewind/reconstruct) don't
// stack duplicate hooks.
let _coverWatcherInstalled = false;

/**
 * Install the "Grappled ends the cover you provide" watcher (rule #2). A
 * createActiveEffect hook fires when a Grappled AE lands on an actor; on the
 * GM client we tear down any Guard-cover that actor is providing. Idempotent.
 */
export function installGrappledCoverWatcher() {
  if (_coverWatcherInstalled) return;
  _coverWatcherInstalled = true;
  Hooks.on("createActiveEffect", (effect) => {
    try {
      if (!game.user?.isGM) return;            // only the authoritative client mutates
      if (!nameMatches(effect)) return;        // only the Grappled relationship status
      const grappledActor = effect.parent;
      if (!grappledActor?.uuid) return;
      // Fire-and-forget: the hook is sync, the teardown is async.
      endGuardCoverProvidedBy(grappledActor).catch((e) =>
        console.warn("[grappled] cover-watcher teardown threw", e));
    } catch (e) {
      console.warn("[grappled] cover-watcher hook threw", e);
    }
  });
  console.log("[grappled] Guard-cover-ends-on-Grappled watcher installed");
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
