/**
 * [ONI] Phantasm API
 * ---------------------------------------------------------------------------
 * Tiny helpers for the Phantasm summoning + reaction conventions.
 *
 * Conventions:
 *
 *   1. **Kind marker.** A Phantasm NPC actor template should set
 *      `system.props.isPhantasm = true`. Mirrors the existing `isSummon`
 *      pattern used by the initiative system.
 *
 *   2. **Ownership link.** When a "Create Phantasm: <X>" skill spawns a
 *      Phantasm token, it should call:
 *
 *        FUCompanion.api.phantasm.markSummon(tokenDoc, summonerActorUuid);
 *
 *      This stamps a flag on the TokenDocument:
 *
 *        flags["fabula-ultima-companion"].summonedBy = <summonerActorUuid>
 *
 *      Downstream reactions (e.g. Phantasmal Echo) read this flag to enforce
 *      "only the reactor's own Phantasm" semantics — without it, a passive
 *      that fires on creature_defeated/ally would also trigger when *another*
 *      PC's Phantasm dies.
 *
 *   3. **Reader helpers.** Use `isPhantasm(actor)` and `getSummoner(tokenDoc)`
 *      from this API rather than poking flags directly, so future convention
 *      changes can be absorbed in one place.
 *
 * Exposed on: `FUCompanion.api.phantasm`. GM-callable; player-callable too
 * for the markSummon path (a player using their Create Phantasm skill needs
 * to stamp their own newly-spawned token).
 */
(() => {
  const TAG = "[FUCompanion][Phantasm]";
  const MODULE_ID = "fabula-ultima-companion";
  const FLAG_SUMMONED_BY = "summonedBy";
  const LANCER_INITIATIVE_MODULE_ID = "lancer-initiative";

  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  function isPhantasm(actor) {
    return !!actor?.system?.props?.isPhantasm;
  }

  function getSummoner(tokenOrDoc) {
    const doc = tokenOrDoc?.document ?? tokenOrDoc ?? null;
    if (!doc) return null;
    try {
      return doc.getFlag?.(MODULE_ID, FLAG_SUMMONED_BY) ?? null;
    } catch (_e) {
      return null;
    }
  }

  // Adds the Phantasm token to the active combat (if one exists on the same
  // scene) with `lancer-initiative` activations.max/value = 0. The Phantasm
  // is tracked in the turn order but does not consume its own activation —
  // it acts on its summoner's turn per Fabula's summon rules.
  //
  // Create is done in two steps (create combatant, then set flags) because
  // createEmbeddedDocuments doesn't always expand dotted-string keys in the
  // initial payload, while updateEmbeddedDocuments does.
  async function joinCombatAtZeroActivations(tokenDoc) {
    const sceneId = tokenDoc?.parent?.id ?? null;
    if (!sceneId) return { ok: false, reason: "no_scene" };

    const combat = (game.combat?.scene?.id === sceneId)
      ? game.combat
      : (game.combats?.contents ?? []).find((c) => c?.scene?.id === sceneId) ?? null;
    if (!combat) return { ok: false, reason: "no_combat" };

    const setActivationsFlags = (combatantId) => combat.updateEmbeddedDocuments("Combatant", [{
      _id: combatantId,
      [`flags.${LANCER_INITIATIVE_MODULE_ID}.activations.max`]: 0,
      [`flags.${LANCER_INITIATIVE_MODULE_ID}.activations.value`]: 0,
    }], { diff: false });

    const existing = (combat.combatants?.contents ?? []).find((c) => c?.tokenId === tokenDoc.id) ?? null;
    if (existing) {
      try {
        await setActivationsFlags(existing.id);
        return { ok: true, combatantId: existing.id, alreadyPresent: true };
      } catch (e) {
        return { ok: false, reason: "pin_activations_failed", error: String(e?.message ?? e) };
      }
    }

    let combatantId = null;
    try {
      const created = await combat.createEmbeddedDocuments("Combatant", [{
        tokenId: tokenDoc.id,
        actorId: tokenDoc.actorId ?? tokenDoc.actor?.id ?? null,
      }]);
      combatantId = created?.[0]?.id ?? null;
      if (!combatantId) return { ok: false, reason: "no_combatant_id" };
    } catch (e) {
      return { ok: false, reason: "create_combatant_failed", error: String(e?.message ?? e) };
    }

    try {
      await setActivationsFlags(combatantId);
    } catch (e) {
      // Combatant is in the tracker; activations may default to 1 until next refresh.
      console.warn(`${TAG} joinCombat: combatant created but flag-set failed (continuing)`, e);
    }

    return { ok: true, combatantId, alreadyPresent: false };
  }

  async function markSummon(tokenOrDoc, summonerActorUuid) {
    const doc = tokenOrDoc?.document ?? tokenOrDoc ?? null;
    if (!doc) {
      console.warn(`${TAG} markSummon called with no token document.`);
      return { ok: false, reason: "no_token_document" };
    }
    const uuid = (summonerActorUuid ?? "").toString().trim();
    if (!uuid) {
      console.warn(`${TAG} markSummon called with no summoner UUID.`);
      return { ok: false, reason: "no_summoner_uuid" };
    }
    try {
      await doc.setFlag(MODULE_ID, FLAG_SUMMONED_BY, uuid);
    } catch (e) {
      console.error(`${TAG} markSummon failed to set summonedBy flag`, e);
      return { ok: false, reason: "set_flag_failed", error: String(e?.message ?? e) };
    }

    // Best-effort: join the active combat at 0 activations. Failures here
    // are logged but don't fail the overall markSummon — the ownership flag
    // is the load-bearing part for reactions to work.
    const combatJoin = await joinCombatAtZeroActivations(doc);
    if (!combatJoin.ok && combatJoin.reason !== "no_combat" && combatJoin.reason !== "no_scene") {
      console.warn(`${TAG} markSummon: combat-join failed (continuing).`, combatJoin);
    }

    return { ok: true, summonedBy: uuid, combatJoin };
  }

  API_ROOT.api.phantasm = {
    isPhantasm,
    getSummoner,
    markSummon,
    _const: Object.freeze({
      MODULE_ID,
      FLAG_SUMMONED_BY
    })
  };

  console.info(`${TAG} API registered at FUCompanion.api.phantasm`);
})();
