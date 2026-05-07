// fabula-ultima-companion/scripts/auto-crisis-detection.js
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[FUC][AutoCrisis]";

  // Your provided Crisis Active Effect UUID
  const CRISIS_EFFECT_UUID = "Item.0gIBYzSpjdXS6f25.ActiveEffect.4ldx00srGNv5AJBr";

  // User-provided UUID check (can be an existing embedded AE UUID from a scene/token/actor)
  // We treat it as an *additional* identifier to recognize Crisis effects.
  const CRISIS_EFFECT_UUID_FALLBACK = "Scene.T0Eo2forSEruOgO0.Token.1vXKtXKTqk9EMC4p.Actor.sr56xgKsKlkgdBXt.ActiveEffect.NSAaDpXeKidoqvk2";

  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

  // ---------------------------------------------------------------------------
  // Socket (GM-authoritative)
  // ---------------------------------------------------------------------------
  const SOCKET = `module.${MODULE_ID}`;

  function getPrimaryActiveGM() {
    const gms = (game.users?.contents ?? []).filter(u => u?.isGM && u?.active);
    return gms[0] ?? null;
  }

  function isPrimaryActiveGM() {
    const gm = getPrimaryActiveGM();
    return !!gm && game.user?.id === gm.id;
  }

  // Dedupe cache on GM: key -> timestamp
  const _gmDedupe = new Map();
  const DEDUPE_WINDOW_MS = 1500;

  function makeDedupeKey({ actorUuid, hpCur, hpMax, trigger }) {
    return `${actorUuid}::${trigger ?? "no-trigger"}::${hpCur}/${hpMax}`;
  }

  function gmShouldProcessOnce(key) {
    const now = Date.now();

    // Cleanup old entries opportunistically
    for (const [k, t] of _gmDedupe.entries()) {
      if (now - t > DEDUPE_WINDOW_MS) _gmDedupe.delete(k);
    }

    const last = _gmDedupe.get(key);
    if (last && (now - last) <= DEDUPE_WINDOW_MS) return false;

    _gmDedupe.set(key, now);
    return true;
  }

  // Reaction System integration -----------------------------------------------
  // We emit "oni:reactionPhase" with trigger keys:
  //   - creature_enter_crisis
  //   - creature_exit_crisis
  //
  // IMPORTANT (GM-authoritative):
  // - Only the GM client should emit reaction triggers for crisis enter/exit.
  function emitReactionPhase(payload) {
    try {
      if (globalThis?.ONI?.emit) {
        globalThis.ONI.emit("oni:reactionPhase", payload, { local: true, world: false });
        return;
      }
    } catch (_e) {}

    // Fallback (in case ONI.emit isn't available yet)
    try {
      Hooks.callAll?.("oni:reactionPhase", payload);
    } catch (_e) {
      warn("Could not emit oni:reactionPhase (no ONI.emit or Hooks.callAll).", payload);
    }
  }

  function buildCrisisReactionPayload(actor, tokenUuids, extra) {
    return {
      trigger: extra?.trigger ?? null,
      // For creature_* trigger core resolution
      tokenUuid: tokenUuids?.[0] ?? null,
      targetUuid: tokenUuids?.[0] ?? null,
      targets: Array.isArray(tokenUuids) ? tokenUuids : [],
      actorUuid: actor?.uuid ?? null,
      targetActorUuid: actor?.uuid ?? null,
      // Debug / context (ignored by trigger core if not needed)
      hpCur: extra?.hpCur ?? null,
      hpMax: extra?.hpMax ?? null,
      threshold: extra?.threshold ?? null,
      source: "auto-crisis-detection"
    };
  }

  function getRelevantTokenUuids(actor) {
    // Prefer tokens in the active combat scene, otherwise fall back to current canvas scene.
    const combatSceneId = game.combat?.scene?.id ?? null;

    const tokens = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.(true) ?? [];
    const filtered = tokens.filter(t => {
      const sceneId = t?.document?.parent?.id ?? t?.scene?.id ?? null;
      if (combatSceneId) return sceneId === combatSceneId;
      return sceneId === canvas?.scene?.id;
    });

    // Use document.uuid because ReactionTriggerCore can parse ".Token.<id>"
    return filtered.map(t => t?.document?.uuid).filter(Boolean);
  }

  // Track "before" crisis state so we can detect ENTER/EXIT transitions cleanly
  const _preUpdateCrisisState = new WeakMap();

  // Per-actor operation lock (GM side) to avoid duplicate apply/remove when updates fire rapidly.
  // key: actorUuid -> Promise chain
  const _actorOpLock = new Map();

  function queueActorOp(actorUuid, fn) {
    const prev = _actorOpLock.get(actorUuid) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(fn)
      .finally(() => {
        // Only clear if we're still the latest promise for this actor
        if (_actorOpLock.get(actorUuid) === next) _actorOpLock.delete(actorUuid);
      });
    _actorOpLock.set(actorUuid, next);
    return next;
  }

  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Crisis threshold rule:
  // "Below 50% HP (round up when calculating percentage)" -> current_hp <= ceil(max_hp / 2)
  function crisisThreshold(maxHp) {
    return Math.ceil(maxHp / 2);
  }

  // Your actor templates store HP under system.props.current_hp / system.props.max_hp
  // (We also try a couple fallback paths just in case)
  function getHp(actor) {
    const sys = actor?.system ?? {};
    const props = sys.props ?? {};

    const curRaw =
      props.current_hp ??
      sys.current_hp ??
      sys.attributes?.hp?.value ??
      sys.hp?.value;

    const maxRaw =
      props.max_hp ??
      sys.max_hp ??
      sys.attributes?.hp?.max ??
      sys.hp?.max;

    const cur = toNumber(curRaw);
    const max = toNumber(maxRaw);

    return { cur, max };
  }

  function isEffectActive(e) {
    // "Active" here means not disabled.
    // (Foundry uses the field "disabled" on ActiveEffect.)
    return !!e && e.disabled !== true;
  }

  function isCrisisEffect(e) {
    if (!e) return false;

    // 1) UUID match (user requested)
    if (e.uuid === CRISIS_EFFECT_UUID_FALLBACK) return true;

    // 2) Origin match to our template or fallback
    if (e.origin === CRISIS_EFFECT_UUID || e.origin === CRISIS_EFFECT_UUID_FALLBACK) return true;

    // 3) Flag (our own)
    if (e?.flags?.[MODULE_ID]?.autoCrisis === true) return true;

    // 4) Name fallback
    if (String(e.name ?? "").trim().toLowerCase() === "crisis") return true;

    return false;
  }

  function findAllCrisisEffects(actor) {
    return (actor?.effects ?? []).filter(e => isCrisisEffect(e));
  }

  function findAnyActiveCrisisEffect(actor) {
    return findAllCrisisEffects(actor).find(isEffectActive) ?? null;
  }

  async function buildCrisisEffectData() {
    const template = await fromUuid(CRISIS_EFFECT_UUID);
    if (!template) return null;

    const data = template.toObject();

    // Remove _id so Foundry can create a new embedded effect
    delete data._id;

    // Mark it so we can safely identify/remove it later
    data.flags ??= {};
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].autoCrisis = true;

    // Set origin to the template UUID (useful for identification)
    data.origin = CRISIS_EFFECT_UUID;

    // "Indefinite until HP recovers" -> leave duration empty
    data.duration = {};

    return data;
  }

  async function applyCrisis(actor) {
    // If an active Crisis effect already exists, do nothing.
    if (findAnyActiveCrisisEffect(actor)) return;

    // If duplicates already exist (disabled or otherwise), clean them up first.
    const allBefore = findAllCrisisEffects(actor);
    if (allBefore.length > 1) {
      // Keep the first, delete the rest
      const keep = allBefore[0];
      const toDelete = allBefore.slice(1).map(e => e.id).filter(Boolean);
      if (toDelete.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete, { oniAutoCrisis: true });
        log(`(Cleanup) Removed duplicate Crisis effects on: ${actor.name}`, { kept: keep?.id, deleted: toDelete });
      }
      // If the kept one is active, we're done.
      if (keep && isEffectActive(keep)) return;
      // Otherwise continue to apply a fresh one below.
    }

    const data = await buildCrisisEffectData();
    if (!data) {
      warn("Could not resolve Crisis ActiveEffect UUID:", CRISIS_EFFECT_UUID);
      return;
    }

    // Re-check right before create (extra safety if multiple calls happen quickly)
    if (findAnyActiveCrisisEffect(actor)) return;

    await actor.createEmbeddedDocuments("ActiveEffect", [data], {
      oniAutoCrisis: true
    });

    log(`Applied Crisis to: ${actor.name}`);
  }

  async function removeCrisis(actor) {
    // User request: when recovering, clear ALL Crisis effects by name/uuid/origin/flag.
    const all = findAllCrisisEffects(actor);
    if (!all.length) return;

    const ids = all.map(e => e.id).filter(Boolean);
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { oniAutoCrisis: true });
    log(`Removed Crisis (cleared ${ids.length} effect(s)) from: ${actor.name}`);
  }

  async function evaluateActorCrisis(actor) {
    if (!actor) return;

    const { cur, max } = getHp(actor);
    if (cur === null || max === null || max <= 0) return;

    const threshold = crisisThreshold(max);
    const inCrisis = cur <= threshold;

    // Serialize operations per actor (prevents duplicate creates/deletes under rapid updates)
    await queueActorOp(actor.uuid, async () => {
      if (inCrisis) await applyCrisis(actor);
      else await removeCrisis(actor);
    });
  }

  function hpWasTouched(changed) {
    // Filter: only react when HP fields are part of the update payload
    const hpPaths = [
      "system.props.current_hp",
      "system.props.max_hp",
      "system.current_hp",
      "system.max_hp",
      "system.attributes.hp.value",
      "system.attributes.hp.max"
    ];
    return hpPaths.some(p => foundry.utils.hasProperty(changed, p));
  }

  Hooks.once("ready", () => {
    log("Loaded.", {
      localUserId: game.user?.id ?? null,
      isGM: !!game.user?.isGM,
      primaryGmUserId: getPrimaryActiveGM()?.id ?? null,
      isPrimaryActiveGM: isPrimaryActiveGM()
    });

    // -------------------------------------------------------------------------
    // GM socket receiver: ONLY the primary active GM applies/removes Crisis
    // effects and emits crisis enter/exit reaction triggers.
    // -------------------------------------------------------------------------
    game.socket.on(SOCKET, async (msg) => {
      try {
        if (!game.user?.isGM) return;
        if (!isPrimaryActiveGM()) return;
        if (!msg || msg.type !== "autoCrisis:syncRequest") return;

        const { actorUuid, after, trigger, thresholdAfter, reactionPayload } = msg;
        if (!actorUuid) return;

        const hpCur = after?.cur;
        const hpMax = after?.max;

        const key = makeDedupeKey({ actorUuid, hpCur, hpMax, trigger });
        if (!gmShouldProcessOnce(key)) return;

        const actor = await fromUuid(actorUuid);
        if (!actor) return;

        // Always sync Crisis AE (authoritative on primary GM only)
        await evaluateActorCrisis(actor);

        // Only emit reaction if a transition trigger was supplied
        if (trigger && reactionPayload) {
          emitReactionPhase(reactionPayload);
          log(`(Primary GM) Socket processed crisis trigger: ${trigger} for ${actor.name}`, {
            thresholdAfter
          });
        } else {
          log(`(Primary GM) Socket synced Crisis AE (no trigger) for ${actor.name}`);
        }
      } catch (e) {
        err("(Primary GM) Socket sync failed:", e);
      }
    });

    // Capture the crisis state *before* HP updates so we can detect enter/exit transitions
    Hooks.on("preUpdateActor", (actor, changed, options) => {
      if (options?.oniAutoCrisis) return;
      if (!hpWasTouched(changed)) return;

      // Compute "before" from current actor data
      const before = getHp(actor);
      if (before.cur === null || before.max === null || before.max <= 0) return;

      // Compute "after" by applying the changed values (when present)
      const afterCur =
        foundry.utils.getProperty(changed, "system.props.current_hp") ??
        foundry.utils.getProperty(changed, "system.current_hp") ??
        foundry.utils.getProperty(changed, "system.attributes.hp.value") ??
        before.cur;

      const afterMax =
        foundry.utils.getProperty(changed, "system.props.max_hp") ??
        foundry.utils.getProperty(changed, "system.max_hp") ??
        foundry.utils.getProperty(changed, "system.attributes.hp.max") ??
        before.max;

      const curAfter = toNumber(afterCur);
      const maxAfter = toNumber(afterMax);
      if (curAfter === null || maxAfter === null || maxAfter <= 0) return;

      const thresholdBefore = crisisThreshold(before.max);
      const thresholdAfter  = crisisThreshold(maxAfter);

      const wasInCrisis = before.cur <= thresholdBefore;
      const willBeInCrisis = curAfter <= thresholdAfter;

      _preUpdateCrisisState.set(actor, {
        wasInCrisis,
        willBeInCrisis,
        before,
        after: { cur: curAfter, max: maxAfter },
        thresholdAfter
      });
    });

    // Main hook: after an Actor updates, request the primary GM to sync Crisis state
    // - Primary GM: applies/removes AE and emits enter/exit trigger (once)
    // - Secondary GM: does nothing
    // - Non-GM: sends socket request to primary GM
    Hooks.on("updateActor", (actor, changed, options) => {
      // Prevent recursion when we add/remove effects ourselves
      if (options?.oniAutoCrisis) return;

      // Only when HP changed
      if (!hpWasTouched(changed)) return;

      const pre = _preUpdateCrisisState.get(actor) ?? null;
      _preUpdateCrisisState.delete(actor);

      // Build optional trigger payload (only when threshold crossed)
      let trigger = null;
      let reactionPayload = null;
      let after = null;
      let thresholdAfter = null;

      if (pre) {
        after = pre.after;
        thresholdAfter = pre.thresholdAfter;

        if (pre.wasInCrisis !== pre.willBeInCrisis) {
          const tokenUuids = getRelevantTokenUuids(actor);
          if (tokenUuids.length === 0) {
            warn("Crisis transition detected, but no active token found on canvas/combat scene:", actor.name);
          }

          trigger = pre.willBeInCrisis ? "creature_enter_crisis" : "creature_exit_crisis";
          reactionPayload = buildCrisisReactionPayload(actor, tokenUuids, {
            trigger,
            hpCur: after.cur,
            hpMax: after.max,
            threshold: thresholdAfter
          });
        }
      } else {
        // Fallback: still allow GM to sync AE even if preUpdate missed
        const hpNow = getHp(actor);
        after = { cur: hpNow.cur, max: hpNow.max };
        thresholdAfter = (hpNow.max && hpNow.max > 0) ? crisisThreshold(hpNow.max) : null;
      }

      // -----------------------------
      // Primary GM path: do the real work
      // -----------------------------
      if (game.user?.isGM) {
        if (!isPrimaryActiveGM()) {
          log(`(Secondary GM) Ignoring updateActor Crisis processing for ${actor.name}`, {
            actorUuid: actor.uuid,
            trigger
          });
          return;
        }

        // Dedupe here too, just in case (multiple rapid updates / unusual client setups)
        const key = makeDedupeKey({
          actorUuid: actor.uuid,
          hpCur: after?.cur,
          hpMax: after?.max,
          trigger
        });

        if (!gmShouldProcessOnce(key)) return;

        evaluateActorCrisis(actor)
          .then(() => {
            if (trigger && reactionPayload) {
              emitReactionPhase(reactionPayload);
              log(`(Primary GM) Emitted Crisis Reaction trigger: ${trigger} for ${actor.name}`);
            }
          })
          .catch(e => err("evaluateActorCrisis failed:", e));

        return;
      }

      // -----------------------------
      // Non-GM path: request primary GM to do it
      // -----------------------------
      try {
        game.socket.emit(SOCKET, {
          type: "autoCrisis:syncRequest",
          actorUuid: actor.uuid,
          after,
          trigger,
          thresholdAfter,
          reactionPayload
        });
        log(`(Client) Sent socket syncRequest to primary GM for ${actor.name}`, { trigger });
      } catch (e) {
        err("(Client) Failed to send socket syncRequest:", e);
      }
    });

    // Optional: on ready, do a one-time sync across ALL actors in the world
    // so existing actors immediately get correct Crisis state after a reload.
    // PRIMARY GM ONLY (authoritative) to avoid permission issues and double-processing.
    if (game.user?.isGM && isPrimaryActiveGM()) {
      for (const actor of game.actors ?? []) {
        evaluateActorCrisis(actor).catch(e => err("Initial sync failed:", e));
      }
    }
  });
})();