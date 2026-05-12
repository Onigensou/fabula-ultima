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
      return { ok: true, summonedBy: uuid };
    } catch (e) {
      console.error(`${TAG} markSummon failed`, e);
      return { ok: false, reason: "set_flag_failed", error: String(e?.message ?? e) };
    }
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
