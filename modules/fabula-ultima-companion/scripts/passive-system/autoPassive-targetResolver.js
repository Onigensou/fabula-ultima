// scripts/autoPassive-targetResolver.js
// Foundry VTT v12
// [ONI] Auto Passive Target Resolver
//
// PURPOSE
// - Resolve preset passive targets without any user input.
// - v1 supports only: reaction_passive_target = "self"
// - Return canonical token/actor UUID arrays for direct use in the Action pipeline.
//
// PUBLIC API
//   const result = await window.FUCompanion.api.autoPassiveTargetResolver.resolve({
//     passiveTargetMode: "self",
//     tokenUuid: "Scene....Token....",
//     actorUuid: "Actor....",
//     itemUuid: "Actor....Item....",
//     phasePayload: {...},
//     row: {...}
//   });
//
// RETURN SHAPE
//   {
//     ok: true,
//     mode: "self",
//     tokenUuid: "Scene....Token....",
//     actorUuid: "Actor....",
//     targetUUIDs: ["Scene....Token...."],
//     targetActorUUIDs: ["Actor...."],
//     token,
//     actor,
//     debug: { ... }
//   }
//
// NOTES
// - Keep this script logic-only. No UI here.
// - Auto Passive Manager should call this before ActionDataFetch.

(() => {
  const ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  ROOT.api = ROOT.api || {};

  const TAG = "[ONI][AutoPassiveTargetResolver]";
  const DEBUG = true; // set false when stable

  const log = (...a) => { if (DEBUG) console.log(TAG, ...a); };
  const warn = (...a) => { if (DEBUG) console.warn(TAG, ...a); };
  const err = (...a) => { if (DEBUG) console.error(TAG, ...a); };

  function str(v, d = "") {
    const s = (v ?? "").toString().trim();
    return s.length ? s : d;
  }

  function lower(v, d = "") {
    return str(v, d).toLowerCase();
  }

  function clone(obj) {
    try {
      return foundry.utils.deepClone(obj);
    } catch {
      try {
        return JSON.parse(JSON.stringify(obj));
      } catch {
        return obj;
      }
    }
  }

  function byIdOnCanvas(tokenId) {
    if (!tokenId) return null;
    return canvas?.tokens?.get?.(tokenId) ?? null;
  }

  async function docFromUuidSafe(uuid) {
    if (!uuid) return null;
    try {
      return await fromUuid(uuid);
    } catch (e) {
      warn("fromUuid failed", { uuid, error: e });
      return null;
    }
  }

  function getCombatTokenForActor(actor) {
    if (!actor || !game.combat) return null;
    const combatants = game.combat.combatants?.contents ?? game.combat.combatants ?? [];
    for (const cmbt of combatants) {
      try {
        if (cmbt?.actor?.id !== actor.id) continue;
        const tokenId = cmbt.tokenId ?? cmbt.token?.id ?? null;
        const token = byIdOnCanvas(tokenId);
        if (token) return token;
      } catch (_) {}
    }
    return null;
  }

  function getSceneTokenForActor(actor) {
    if (!actor) return null;

    try {
      const active = actor.getActiveTokens?.(true, true) ?? [];
      if (active[0]) return active[0];
    } catch (_) {}

    try {
      const active = actor.getActiveTokens?.() ?? [];
      if (active[0]) return active[0];
    } catch (_) {}

    try {
      const tokenObj = actor.token?.object ?? actor.prototypeToken?.object ?? null;
      if (tokenObj) return tokenObj;
    } catch (_) {}

    return null;
  }

  async function resolveActorFromHints(hints = {}) {
    const candidates = [
      hints.actor,
      hints.ownerActor,
      hints.passiveActor,
      null
    ].filter(Boolean);

    if (candidates.length) {
      const actor = candidates.find(a => a?.documentName === "Actor" || a?.constructor?.name === "Actor") ?? candidates[0];
      if (actor) {
        return { actor, source: "direct-actor-hint" };
      }
    }

    const uuidCandidates = [
      hints.actorUuid,
      hints.ownerActorUuid,
      hints.passiveActorUuid,
      hints?.meta?.actorUuid,
      hints?.meta?.ownerActorUuid,
      hints?.phasePayload?.actorUuid,
      hints?.phasePayload?.ownerActorUuid,
      hints?.phasePayload?.meta?.actorUuid,
      hints?.phasePayload?.meta?.ownerActorUuid
    ].filter(Boolean).map(String);

    for (const uuid of uuidCandidates) {
      const doc = await docFromUuidSafe(uuid);
      if (!doc) continue;
      if (doc.documentName === "Actor" || doc.constructor?.name === "Actor") {
        return { actor: doc, source: "actor-uuid" };
      }
      if (doc.actor) {
        return { actor: doc.actor, source: "tokenish-uuid->actor" };
      }
    }

    const itemCandidates = [
      hints.item,
      hints.passiveItem,
      null
    ].filter(Boolean);

    if (itemCandidates.length) {
      const item = itemCandidates[0];
      const actor = item?.actor ?? item?.parent ?? null;
      if (actor) return { actor, source: "item-parent" };
    }

    const itemUuidCandidates = [
      hints.itemUuid,
      hints.passiveItemUuid,
      hints?.meta?.itemUuid,
      hints?.phasePayload?.itemUuid,
      hints?.phasePayload?.meta?.itemUuid
    ].filter(Boolean).map(String);

    for (const uuid of itemUuidCandidates) {
      const doc = await docFromUuidSafe(uuid);
      const actor = doc?.actor ?? doc?.parent ?? null;
      if (actor) return { actor, source: "item-uuid-parent" };
    }

    return { actor: null, source: "unresolved" };
  }

  async function resolveTokenFromHints(hints = {}, resolvedActor = null) {
    const directToken = [hints.token, hints.ownerToken, hints.passiveToken].find(Boolean) ?? null;
    if (directToken) {
      return { token: directToken, source: "direct-token-hint" };
    }

    const tokenUuidCandidates = [
      hints.tokenUuid,
      hints.ownerTokenUuid,
      hints.passiveTokenUuid,
      hints?.meta?.tokenUuid,
      hints?.meta?.ownerTokenUuid,
      hints?.phasePayload?.tokenUuid,
      hints?.phasePayload?.ownerTokenUuid,
      hints?.phasePayload?.meta?.tokenUuid,
      hints?.phasePayload?.meta?.ownerTokenUuid
    ].filter(Boolean).map(String);

    for (const uuid of tokenUuidCandidates) {
      const doc = await docFromUuidSafe(uuid);
      if (!doc) continue;

      if (doc.documentName === "Token" || doc.documentName === "TokenDocument") {
        const token = doc.object ?? byIdOnCanvas(doc.id) ?? null;
        if (token) return { token, source: "token-uuid" };
      }

      const token = doc?.token?.object ?? doc?.object ?? null;
      if (token?.document?.documentName === "Token") {
        return { token, source: "uuid-best-effort" };
      }
    }

    if (resolvedActor) {
      const combatToken = getCombatTokenForActor(resolvedActor);
      if (combatToken) return { token: combatToken, source: "actor-combat-token" };

      const sceneToken = getSceneTokenForActor(resolvedActor);
      if (sceneToken) return { token: sceneToken, source: "actor-scene-token" };
    }

    return { token: null, source: "unresolved" };
  }

  function normalizePassiveTargetMode(input, row = null) {
    const mode = lower(
      input ??
      row?.reaction_passive_target ??
      row?.passive_target ??
      ""
    );

    if (!mode) return "self";
    return mode;
  }

  function buildResult({ ok, mode, token = null, actor = null, reason = "", debug = {} }) {
    const tokenUuid = token?.document?.uuid ?? token?.uuid ?? null;
    const actorUuid = actor?.uuid ?? token?.actor?.uuid ?? null;

    return {
      ok: !!ok,
      mode,
      tokenUuid,
      actorUuid,
      targetUUIDs: tokenUuid ? [tokenUuid] : [],
      targetActorUUIDs: actorUuid ? [actorUuid] : [],
      token,
      actor: actor ?? token?.actor ?? null,
      reason,
      debug: clone(debug)
    };
  }

  async function resolveSelfTarget(hints = {}) {
    const actorRes = await resolveActorFromHints(hints);
    const actor = actorRes.actor ?? null;

    const tokenRes = await resolveTokenFromHints(hints, actor);
    const token = tokenRes.token ?? null;

    const debug = {
      actorResolutionSource: actorRes.source,
      tokenResolutionSource: tokenRes.source,
      suppliedHints: {
        actorUuid: hints.actorUuid ?? hints.ownerActorUuid ?? hints.passiveActorUuid ?? null,
        tokenUuid: hints.tokenUuid ?? hints.ownerTokenUuid ?? hints.passiveTokenUuid ?? null,
        itemUuid: hints.itemUuid ?? hints.passiveItemUuid ?? null
      }
    };

    if (!actor && !token) {
      return buildResult({
        ok: false,
        mode: "self",
        token: null,
        actor: null,
        reason: "Could not resolve passive owner actor or token for self target.",
        debug
      });
    }

    const finalActor = actor ?? token?.actor ?? null;
    const finalToken = token ?? getCombatTokenForActor(finalActor) ?? getSceneTokenForActor(finalActor) ?? null;

    if (!finalActor) {
      return buildResult({
        ok: false,
        mode: "self",
        token: finalToken,
        actor: null,
        reason: "Resolved a token, but could not resolve the passive owner actor.",
        debug
      });
    }

    if (!finalToken) {
      return buildResult({
        ok: false,
        mode: "self",
        token: null,
        actor: finalActor,
        reason: "Resolved the passive owner actor, but could not find a token on the active scene/combat.",
        debug
      });
    }

    return buildResult({
      ok: true,
      mode: "self",
      token: finalToken,
      actor: finalActor,
      reason: "Resolved self target successfully.",
      debug
    });
  }

  async function resolve(input = {}) {
    const runId = `APR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const mode = normalizePassiveTargetMode(input.passiveTargetMode, input.row);

    log(runId, "START", {
      mode,
      actorUuid: input.actorUuid ?? input.ownerActorUuid ?? input.passiveActorUuid ?? null,
      tokenUuid: input.tokenUuid ?? input.ownerTokenUuid ?? input.passiveTokenUuid ?? null,
      itemUuid: input.itemUuid ?? input.passiveItemUuid ?? null,
      hasRow: !!input.row,
      phaseTrigger: input?.phasePayload?.trigger ?? input?.phasePayload?.triggerKey ?? null
    });

    switch (mode) {
      case "self": {
        const result = await resolveSelfTarget(input);
        if (result.ok) {
          log(runId, "RESOLVED SELF", {
            tokenUuid: result.tokenUuid,
            actorUuid: result.actorUuid,
            debug: result.debug
          });
        } else {
          warn(runId, "FAILED SELF", {
            reason: result.reason,
            debug: result.debug
          });
        }
        return result;
      }

      default: {
        const result = buildResult({
          ok: false,
          mode,
          token: null,
          actor: null,
          reason: `Unsupported passive target mode: ${mode}`,
          debug: {
            supportedModes: ["self"]
          }
        });
        warn(runId, "UNSUPPORTED MODE", result);
        return result;
      }
    }
  }

  const api = {
    normalizePassiveTargetMode,
    resolve,
    resolveSelfTarget
  };

  ROOT.api.autoPassiveTargetResolver = api;
  window["oni.AutoPassiveTargetResolver"] = api;

  log("Installed.");
})();
