/**
 * [ONI] Event System — Show Text — Speaker Resolver
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-showText-speakerResolver.js
 *
 * What this does:
 * - Resolves the "Speaker" field for the Show Text event
 * - Supports:
 *   1) empty input          -> Self
 *   2) "Self"               -> current party speaker
 *   3) Actor UUID           -> current-scene token for that actor if possible
 *   4) Token UUID           -> current-scene token match if possible
 *   5) plain text name      -> current-scene token / actor lookup, else plain text
 *
 * Important rule:
 * - When resolving non-party speakers, always try to anchor to a token
 *   on the CURRENT scene first.
 *
 * Exposes API to:
 *   window.oni.EventSystem.ShowText.SpeakerResolver
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ShowText][SpeakerResolver]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};
  window.oni.EventSystem.ShowText = window.oni.EventSystem.ShowText || {};

  if (window.oni.EventSystem.ShowText.SpeakerResolver?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  const DEBUG_SCOPE = "ShowTextSpeakerResolver";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args)
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------
  function stringOrEmpty(value) {
    return String(value ?? "").trim();
  }

  function isUuidLike(value) {
    const s = stringOrEmpty(value);
    return s.includes(".");
  }

  function normalizeSpeakerInput(raw) {
    const s = stringOrEmpty(raw);
    if (!s) return C.SPECIAL_SPEAKER_SELF;
    return s;
  }

  function isSelfSyntax(raw) {
    const s = normalizeSpeakerInput(raw).toLowerCase();
    return s === String(C.SPECIAL_SPEAKER_SELF).toLowerCase();
  }

  function getCurrentSceneId(context = {}) {
    return stringOrEmpty(context.sceneId) || canvas?.scene?.id || null;
  }

  function getCurrentSceneTokens(context = {}) {
    const sceneId = getCurrentSceneId(context);
    if (!sceneId) return [];

    // User specifically wants current-scene matching only.
    if (canvas?.scene?.id === sceneId) {
      return canvas?.tokens?.placeables ?? [];
    }

    // If context scene differs from current canvas, still only use current canvas
    // because off-scene speaking is not desired for this system.
    return canvas?.tokens?.placeables ?? [];
  }

  function getTokenDocumentUuid(tokenLike) {
    if (!tokenLike) return null;
    return tokenLike.document?.uuid || tokenLike.uuid || null;
  }

  function getTokenDocumentId(tokenLike) {
    if (!tokenLike) return null;
    return tokenLike.document?.id || tokenLike.id || null;
  }

  function getTokenActor(tokenLike) {
    return tokenLike?.actor || tokenLike?.document?.actor || null;
  }

  function getTokenName(tokenLike) {
    return stringOrEmpty(
      tokenLike?.name ||
      tokenLike?.document?.name ||
      tokenLike?.actor?.name ||
      tokenLike?.document?.actor?.name
    );
  }

  function makeResult({
  ok = true,
  mode = "text",
  input = "",
  matchedBy = "plainTextFallback",
  speakerName = "",
  token = null,
  actor = null,
  document = null
} = {}) {
  const preferredTokenName = getTokenName(token);
  const fallbackActorName = stringOrEmpty(actor?.name);

  return {
    ok,
    mode,
    input,
    matchedBy,

    // Always prefer current-scene token name first.
    // If no token name exists, then fall back to provided speakerName,
    // then actor name, then Self.
    speakerName:
      preferredTokenName ||
      stringOrEmpty(speakerName) ||
      fallbackActorName ||
      C.SPECIAL_SPEAKER_SELF,

    token,
    actor,
    tokenUuid: getTokenDocumentUuid(token),
    actorUuid: actor?.uuid ?? null,
    document: document ?? token?.document ?? actor ?? null
  };
}

  function findCurrentSceneTokenForActor(actor, context = {}) {
    if (!actor) return null;
    const tokens = getCurrentSceneTokens(context);
    return tokens.find(t => getTokenActor(t)?.id === actor.id) || null;
  }

  function findCurrentSceneTokenByTokenId(tokenId, context = {}) {
    const safeId = stringOrEmpty(tokenId);
    if (!safeId) return null;
    const tokens = getCurrentSceneTokens(context);
    return tokens.find(t => String(getTokenDocumentId(t)) === safeId) || null;
  }

  function findCurrentSceneTokenByName(name, context = {}) {
    const safe = stringOrEmpty(name).toLowerCase();
    if (!safe) return null;

    const tokens = getCurrentSceneTokens(context);

    return (
      tokens.find(t => getTokenName(t).toLowerCase() === safe) ||
      tokens.find(t => stringOrEmpty(getTokenActor(t)?.name).toLowerCase() === safe) ||
      null
    );
  }

  // ------------------------------------------------------------
  // Party / Self resolution
  // ------------------------------------------------------------
  async function resolveCurrentDbContext() {
    try {
      const api = window.FUCompanion?.api;
      if (!api?.getCurrentGameDb) {
        DBG.verboseLog(DEBUG_SCOPE, "FUCompanion DB resolver not available.");
        return { db: null, source: null };
      }

      const cache = await api.getCurrentGameDb();
      return {
        db: cache?.db ?? null,
        source: cache?.source ?? null
      };
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "Failed resolving current DB context:", e);
      return { db: null, source: null };
    }
  }

  async function resolvePartyToken(context = {}) {
    try {
      const currentSceneTokens = getCurrentSceneTokens(context);

      // 1) explicit token from context
      const explicitTokenId = stringOrEmpty(context.partyTokenId || context.tokenId);
      if (explicitTokenId) {
        const explicit =
          currentSceneTokens.find(t => String(getTokenDocumentId(t)) === explicitTokenId) ||
          canvas?.tokens?.get?.(explicitTokenId) ||
          null;

        if (explicit) {
          DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from explicit tokenId.", {
            tokenId: getTokenDocumentId(explicit),
            tokenName: getTokenName(explicit)
          });
          return explicit;
        }
      }

      // 2) explicit token object from context
      if (context.partyToken) {
        DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from context.partyToken.", {
          tokenId: getTokenDocumentId(context.partyToken),
          tokenName: getTokenName(context.partyToken)
        });
        return context.partyToken;
      }

      // 3) controlled token on current canvas
      const controlled = canvas?.tokens?.controlled?.[0] ?? null;
      if (controlled) {
        DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from controlled token.", {
          tokenId: controlled.id,
          tokenName: getTokenName(controlled)
        });
        return controlled;
      }

      // 4) FUCompanion DB lookup fallback
      const { db, source } = await resolveCurrentDbContext();
      if (!db) {
        DBG.verboseLog(DEBUG_SCOPE, "No DB actor found for Self speaker resolution.");
        return null;
      }

      const dbToken =
        currentSceneTokens.find(t => getTokenActor(t)?.id === db.id) ||
        (source ? currentSceneTokens.find(t => getTokenActor(t)?.id === source.id) : null) ||
        currentSceneTokens.find(t => getTokenName(t) === db.name) ||
        currentSceneTokens.find(t => stringOrEmpty(getTokenActor(t)?.name) === db.name) ||
        null;

      if (dbToken) {
        DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from FUCompanion DB fallback.", {
          tokenId: getTokenDocumentId(dbToken),
          tokenName: getTokenName(dbToken)
        });
      }

      return dbToken;
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "resolvePartyToken failed:", e);
      return null;
    }
  }

  async function resolveSelfSpeaker(context = {}) {
    const token = await resolvePartyToken(context);
    const actor = getTokenActor(token);

    const tokenName = getTokenName(token);
    const actorName = stringOrEmpty(actor?.name);
    const displayName = tokenName || actorName || C.SPECIAL_SPEAKER_SELF;

    const result = makeResult({
      ok: true,
      mode: "self",
      input: C.SPECIAL_SPEAKER_SELF,
      matchedBy: token ? "partyToken" : "fallback",
      speakerName: displayName,
      token,
      actor,
      document: token?.document ?? actor ?? null
    });

    DBG.verboseLog(DEBUG_SCOPE, "Resolved Self speaker:", result);
    return result;
  }

  // ------------------------------------------------------------
  // UUID resolution
  // ------------------------------------------------------------
  async function resolveUuidSpeaker(raw, context = {}) {
    const input = normalizeSpeakerInput(raw);

    try {
      const doc = await fromUuid(input);
      if (!doc) {
        DBG.warn(DEBUG_SCOPE, "fromUuid returned null for speaker input:", input);
        return null;
      }

      // Actor UUID
      if (doc.documentName === "Actor") {
        const sceneToken = findCurrentSceneTokenForActor(doc, context);

        const result = makeResult({
          ok: true,
          mode: "uuid",
          input,
          matchedBy: sceneToken ? "actorUuid+currentSceneToken" : "actorUuid",
          speakerName: stringOrEmpty(doc.name) || getTokenName(sceneToken) || "Unknown Speaker",
          token: sceneToken,
          actor: doc,
          document: sceneToken?.document ?? doc
        });

        DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from Actor UUID:", result);
        return result;
      }

      // Token / TokenDocument UUID
      if (doc.documentName === "Token") {
        const actor = doc.actor ?? null;

        const currentSceneToken =
          findCurrentSceneTokenByTokenId(doc.id, context) ||
          findCurrentSceneTokenForActor(actor, context) ||
          findCurrentSceneTokenByName(doc.name, context) ||
          null;

        const result = makeResult({
          ok: true,
          mode: "uuid",
          input,
          matchedBy: currentSceneToken ? "tokenUuid+currentSceneMatch" : "tokenUuid",
          speakerName:
            stringOrEmpty(actor?.name) ||
            getTokenName(currentSceneToken) ||
            stringOrEmpty(doc.name) ||
            "Unknown Speaker",
          token: currentSceneToken || doc.object || null,
          actor,
          document: currentSceneToken?.document ?? doc
        });

        DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from Token UUID:", result);
        return result;
      }

      // Anything else: salvage display name if possible
      const fallbackName = stringOrEmpty(doc.name);
      if (fallbackName) {
        const result = makeResult({
          ok: true,
          mode: "uuid",
          input,
          matchedBy: "otherDocumentUuid",
          speakerName: fallbackName,
          token: findCurrentSceneTokenByName(fallbackName, context),
          actor: null,
          document: doc
        });

        DBG.warn(DEBUG_SCOPE, "Speaker UUID was not Actor/Token, using document name as fallback:", {
          input,
          documentName: doc.documentName,
          speakerName: fallbackName
        });

        return result;
      }

      return null;
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "Failed to resolve UUID speaker:", { input, error: e });
      return null;
    }
  }

  // ------------------------------------------------------------
  // Name resolution
  // ------------------------------------------------------------
  async function resolveNameSpeaker(raw, context = {}) {
    const input = normalizeSpeakerInput(raw);
    const lowered = input.toLowerCase();

    // Scene token exact token-name match
    let token = findCurrentSceneTokenByName(input, context);

    if (token) {
      const actor = getTokenActor(token);

      // Prefer actor name for display if it exists, because that matches your NPC use better
      const result = makeResult({
        ok: true,
        mode: "name",
        input,
        matchedBy: "currentSceneNameMatch",
        speakerName: stringOrEmpty(actor?.name) || getTokenName(token) || input,
        token,
        actor,
        document: token?.document ?? token
      });

      DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from current-scene name match:", result);
      return result;
    }

    // World actor exact match -> immediately try to anchor it to current-scene token
    const actor =
      game?.actors?.find?.(a => stringOrEmpty(a?.name).toLowerCase() === lowered) ||
      null;

    if (actor) {
      token = findCurrentSceneTokenForActor(actor, context);

      const result = makeResult({
        ok: true,
        mode: "name",
        input,
        matchedBy: token ? "worldActorName+currentSceneToken" : "worldActorName",
        speakerName: stringOrEmpty(actor.name) || input,
        token,
        actor,
        document: token?.document ?? actor
      });

      DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from world actor name:", result);
      return result;
    }

    // Plain text fallback
    const result = makeResult({
      ok: true,
      mode: "text",
      input,
      matchedBy: "plainTextFallback",
      speakerName: input,
      token: null,
      actor: null,
      document: null
    });

    DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker as plain text fallback:", result);
    return result;
  }

  // ------------------------------------------------------------
  // Main API
  // ------------------------------------------------------------
  const SpeakerResolver = {
    installed: true,

    normalizeSpeakerInput,
    isSelfSyntax,

    async resolve(rawSpeaker, context = {}) {
      const normalized = normalizeSpeakerInput(rawSpeaker);

      DBG.log(DEBUG_SCOPE, "Resolving speaker...", {
        rawSpeaker,
        normalized,
        sceneId: getCurrentSceneId(context),
        tokenId: context?.tokenId ?? null
      });

      // Self / empty
      if (isSelfSyntax(normalized)) {
        return resolveSelfSpeaker(context);
      }

      // UUID path
      if (isUuidLike(normalized)) {
        const fromUuidResult = await resolveUuidSpeaker(normalized, context);
        if (fromUuidResult) return fromUuidResult;

        DBG.warn(DEBUG_SCOPE, "UUID speaker did not resolve cleanly, falling back to name/plain text resolution.", {
          input: normalized
        });
      }

      // Name / plain text path
      return resolveNameSpeaker(normalized, context);
    }
  };

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.ShowText.SpeakerResolver = SpeakerResolver;

  console.log(INSTALL_TAG, "Installed.");
})();
