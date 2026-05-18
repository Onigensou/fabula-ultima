/**
 * [ONI] creature_defeated emitter
 * ---------------------------------------------------------------------------
 * Universal "HP reduced to 0" detector. Emits the `creature_defeated`
 * reaction trigger for any actor whose `system.props.current_hp` transitions
 * from >0 to 0, regardless of disposition, npc_rank, or auto-defeat
 * eligibility.
 *
 * Why this exists separately from auto-defeat.js:
 *   - The trigger label literally reads "When a creature is reduced to 0 HP",
 *     so it should match the HP threshold, not the physical-defeat workflow.
 *   - auto-defeat.js is enemy-only (disposition === -1) + rank-gated, which
 *     excluded friendly summons (Phantasms) and unranked creatures from ever
 *     firing the trigger.
 *   - auto-defeat.js still owns the *removal* of eligible enemy tokens after
 *     they hit 0; we just lift the trigger emit out into this universal path.
 *
 * Dedup: a Map captures pre-update HP keyed by actor.id so we can detect the
 * specific old>0 -> new=0 transition. Repeat updates that keep HP at 0 don't
 * re-fire.
 */
(() => {
  const TAG = "[ONI][CreatureDefeatedEmitter]";
  const DEBUG = typeof globalThis.ONI_CREATURE_DEFEATED_DEBUG === "boolean"
    ? globalThis.ONI_CREATURE_DEFEATED_DEBUG
    : false;
  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // Pre-update HP cache keyed by actor.id. Cleared on updateActor or on
  // a subsequent preUpdateActor for the same actor (defensive — Foundry
  // pairs them, but a thrown handler could leave stale entries).
  const oldHpByActorId = new Map();

  function readHp(actorLike) {
    const v = foundry.utils.getProperty(actorLike, "system.props.current_hp");
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function emitReactionPhase(payload) {
    const rs = globalThis.FUCompanion?.api?.reactionSystem;
    if (rs?.emitPhaseSequential) {
      try { return await rs.emitPhaseSequential(payload, { reason: "defeated" }); }
      catch (e) { warn("emitPhaseSequential threw:", e?.message ?? e, payload); return; }
    }
    if (rs?.openWindow) {
      try { return await rs.openWindow(payload, { reason: "defeated" }); }
      catch (e) { warn("openWindow threw:", e?.message ?? e, payload); return; }
    }
    try {
      if (globalThis?.ONI?.emit) {
        globalThis.ONI.emit("oni:reactionPhase", payload, { local: true, world: false });
        return;
      }
    } catch (_e) {}
    try { Hooks.callAll?.("oni:reactionPhase", payload); }
    catch (_e) { warn("Could not emit oni:reactionPhase (no substrate, no ONI.emit, no Hooks).", payload); }
  }

  function buildPayload(actor, tokenDoc) {
    const tokenUuid = tokenDoc?.uuid ?? null;
    const actorUuid = actor?.uuid ?? null;
    return {
      trigger: "creature_defeated",
      tokenUuid,
      targetUuid: tokenUuid,
      targets: tokenUuid ? [tokenUuid] : [],
      actorUuid,
      targetActorUuid: actorUuid,
      defeatedTokenUuid: tokenUuid,
      defeatedActorUuid: actorUuid,
      hpCur: 0,
      hpMax: Number(foundry.utils.getProperty(actor, "system.props.max_hp")) || null,
      source: "creature-defeated-emitter",
      sceneId: tokenDoc?.parent?.id ?? null,
      tokenId: tokenDoc?.id ?? null,
      actorId: actor?.id ?? null,
      timestamp: Date.now(),
    };
  }

  function onPreUpdateActor(actor, change) {
    const newHpRaw = foundry.utils.getProperty(change, "system.props.current_hp");
    if (newHpRaw === undefined) return;
    const oldHp = readHp(actor);
    oldHpByActorId.set(actor.id, { oldHp, newHpRaw });
  }

  function onUpdateActor(actor) {
    const entry = oldHpByActorId.get(actor.id);
    if (!entry) return;
    oldHpByActorId.delete(actor.id);

    const newHp = readHp(actor);
    if (newHp !== 0) return;
    if (entry.oldHp !== null && entry.oldHp <= 0) return;

    // Resolve token(s) — emit once per active token. Most actors have one;
    // unlinked NPCs can have many.
    let tokens = [];
    try {
      tokens = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
    } catch (e) {
      warn("getActiveTokens threw; emitting with null token.", { actor: actor?.name, err: String(e?.message ?? e) });
    }

    if (!tokens.length) {
      // No active token (actor not on any scene). Still emit with null token so
      // reactions that don't need token-side subject resolution can match via
      // actorUuid fields.
      const payload = buildPayload(actor, null);
      log("emit creature_defeated (no active token)", payload);
      emitReactionPhase(payload);
      return;
    }

    for (const t of tokens) {
      const tokenDoc = t?.document ?? t;
      const payload = buildPayload(actor, tokenDoc);
      log("emit creature_defeated", { actor: actor.name, token: tokenDoc?.name, payload });
      emitReactionPhase(payload);
    }
  }

  Hooks.once("ready", () => {
    Hooks.on("preUpdateActor", onPreUpdateActor);
    Hooks.on("updateActor", onUpdateActor);
    log("Installed preUpdateActor + updateActor hooks.");
  });
})();
