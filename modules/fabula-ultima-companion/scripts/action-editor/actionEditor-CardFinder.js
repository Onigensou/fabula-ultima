// ============================================================================
// actionEditor-CardFinder.js
// Foundry V12
// -----------------------------------------------------------------------------
// Purpose:
//   Central lookup API for pending Action Cards.
//
// What this script does:
//   - Finds a ChatMessage that contains an Action Card payload.
//   - Can search by:
//       1) actionCardMessageId / messageId
//       2) actionCardId
//       3) actionId
//       4) replacedActionCardIds
//   - Returns the ChatMessage + saved payload + card metadata.
//   - DOES NOT edit the card.
//   - DOES NOT rebuild the card.
//   - DOES NOT confirm or resolve the action.
//
// This is the first backend piece for the Action Editor system.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  // =========================================================
  // DEBUG TOGGLE
  // =========================================================
  const ACTION_EDITOR_CARD_FINDER_DEBUG = true;

  const TAG = "[ONI][ActionEditor][CardFinder]";
  const API_VERSION = "0.1.0";

  const log = (...a) => {
    if (ACTION_EDITOR_CARD_FINDER_DEBUG) console.log(TAG, ...a);
  };

  const warn = (...a) => {
    if (ACTION_EDITOR_CARD_FINDER_DEBUG) console.warn(TAG, ...a);
  };

  const err = (...a) => {
    if (ACTION_EDITOR_CARD_FINDER_DEBUG) console.error(TAG, ...a);
  };

  // =========================================================
  // SMALL HELPERS
  // =========================================================

  function str(v, fallback = "") {
    const s = String(v ?? "").trim();
    return s.length ? s : fallback;
  }

  function lower(v) {
    return str(v).toLowerCase();
  }

  function uniq(list) {
    return Array.from(
      new Set(
        (Array.isArray(list) ? list : [])
          .filter(v => v !== null && v !== undefined)
          .map(v => String(v).trim())
          .filter(Boolean)
      )
    );
  }

  function firstString(...values) {
    for (const v of values) {
      const s = str(v);
      if (s) return s;
    }
    return "";
  }

  function clone(obj, fallback = null) {
    try {
      if (obj === undefined || obj === null) return fallback;
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(obj);
      return JSON.parse(JSON.stringify(obj));
    } catch {
      if (Array.isArray(obj)) return [...obj];
      if (obj && typeof obj === "object") return { ...obj };
      return fallback;
    }
  }

  function safeGetFlag(message, scope, key) {
    try {
      if (!message) return null;
      if (typeof message.getFlag === "function") {
        const v = message.getFlag(scope, key);
        if (v !== undefined && v !== null) return v;
      }
    } catch (e) {
      warn("getFlag failed", {
        messageId: message?.id ?? null,
        scope,
        key,
        error: String(e?.message ?? e)
      });
    }

    try {
      return message?.flags?.[scope]?.[key] ?? null;
    } catch {
      return null;
    }
  }

  function looksLikeActionCardFlag(flag) {
    if (!flag || typeof flag !== "object") return false;

    const payload = flag.payload ?? flag.actionContext ?? flag.actionCtx ?? null;

    const hasDirectId =
      !!str(flag.actionCardId) ||
      !!str(flag.actionId) ||
      !!str(flag.actionCardMessageId);

    const hasPayloadId =
      !!str(payload?.meta?.actionCardId) ||
      !!str(payload?.actionCardId) ||
      !!str(payload?.meta?.actionId) ||
      !!str(payload?.actionId);

    return hasDirectId || hasPayloadId;
  }

  // =========================================================
  // FLAG READER
  // =========================================================
  // Current expected flag from CreateActionCard:
  //   flags["fabula-ultima-companion"].actionCard
  //
  // This also checks a few fallback names in case you rename during refactor.
  // =========================================================

  function getActionCardFlag(message) {
    if (!message) return null;

    const candidates = [
      safeGetFlag(message, MODULE_ID, "actionCard"),
      safeGetFlag(message, MODULE_ID, "action_card"),
      safeGetFlag(message, MODULE_ID, "actionCardData"),
      safeGetFlag(message, MODULE_ID, "cardPayload")
    ];

    for (const candidate of candidates) {
      if (looksLikeActionCardFlag(candidate)) return candidate;
    }

    return null;
  }

  function extractActionCardData(message) {
    const flag = getActionCardFlag(message);

    if (!flag) {
      return {
        ok: false,
        reason: "no_action_card_flag",
        message,
        messageId: message?.id ?? null
      };
    }

    const payload =
      flag.payload ??
      flag.actionContext ??
      flag.actionCtx ??
      null;

    const meta = payload?.meta ?? {};

    const actionId = firstString(
      flag.actionId,
      meta.actionId,
      payload?.actionId
    );

    const actionCardId = firstString(
      flag.actionCardId,
      meta.actionCardId,
      payload?.actionCardId
    );

    const actionCardVersionRaw =
      flag.actionCardVersion ??
      meta.actionCardVersion ??
      payload?.actionCardVersion ??
      null;

    const actionCardVersion = Number(actionCardVersionRaw ?? 0) || 0;

    const actionCardMessageId = firstString(
      flag.actionCardMessageId,
      meta.actionCardMessageId,
      payload?.actionCardMessageId,
      message?.id
    );

    const replacedActionCardIds = uniq([
      ...(Array.isArray(flag.replacedActionCardIds) ? flag.replacedActionCardIds : []),
      ...(Array.isArray(meta.replacedActionCardIds) ? meta.replacedActionCardIds : []),
      ...(Array.isArray(payload?.replacedActionCardIds) ? payload.replacedActionCardIds : [])
    ]);

    const state = firstString(
      meta.actionCardState,
      payload?.actionCardState,
      flag.actionCardState,
      "pending"
    );

    const skillName = firstString(
      payload?.core?.skillName,
      payload?.dataCore?.skillName,
      meta.skillName,
      flag.skillName
    );

    const attackerUuid = firstString(
      meta.attackerUuid,
      payload?.attackerUuid,
      payload?.attackerActorUuid,
      flag.attackerUuid
    );

    return {
      ok: true,
      message,
      messageId: message?.id ?? null,
      flag,
      payload,
      meta,

      actionId,
      actionCardId,
      actionCardVersion,
      actionCardMessageId,
      replacedActionCardIds,
      state,

      skillName,
      attackerUuid
    };
  }

  // =========================================================
  // MESSAGE RESOLUTION
  // =========================================================

  async function resolveMessageById(messageId) {
    const id = str(messageId);
    if (!id) return null;

    const loaded = game.messages?.get?.(id) ?? null;
    if (loaded) return loaded;

    // Optional best-effort database lookup.
    // In most action-card cases, the card is recent and already loaded in chat.
    try {
      const ChatMessageClass =
        globalThis.ChatMessage ??
        getDocumentClass?.("ChatMessage") ??
        null;

      if (ChatMessageClass && typeof ChatMessageClass.getDocuments === "function") {
        const docs = await ChatMessageClass.getDocuments({ _id: id });
        return docs?.[0] ?? null;
      }
    } catch (e) {
      warn("Database message lookup failed; falling back to loaded chat only.", {
        messageId: id,
        error: String(e?.message ?? e)
      });
    }

    return null;
  }

  function getLoadedMessages({ newestFirst = true, maxMessages = 250 } = {}) {
    const raw =
      game.messages?.contents ??
      Array.from(game.messages ?? []);

    const list = Array.isArray(raw) ? [...raw] : [];

    list.sort((a, b) => {
      const at =
        Number(a?.timestamp ?? a?._source?.timestamp ?? a?.createdTime ?? 0) || 0;
      const bt =
        Number(b?.timestamp ?? b?._source?.timestamp ?? b?.createdTime ?? 0) || 0;

      return newestFirst ? bt - at : at - bt;
    });

    const limit = Number(maxMessages ?? 250) || 250;
    return list.slice(0, Math.max(1, limit));
  }

  // =========================================================
  // MATCHING
  // =========================================================

  function dataMatchesQuery(data, query = {}, options = {}) {
    if (!data?.ok) return false;

    const includeReplaced = options.includeReplaced !== false;

    const qActionCardId = str(
      query.actionCardId ??
      query.cardId ??
      query.id
    );

    const qActionId = str(
      query.actionId
    );

    const qMessageId = str(
      query.actionCardMessageId ??
      query.messageId ??
      query.chatMsgId ??
      query.chatMessageId
    );

    const hasSpecificCardQuery = !!qActionCardId;
    const hasSpecificActionQuery = !!qActionId;
    const hasSpecificMessageQuery = !!qMessageId;

    // Message-only lookup:
    // If only message ID is provided, any valid action-card flag is acceptable.
    if (
      hasSpecificMessageQuery &&
      !hasSpecificCardQuery &&
      !hasSpecificActionQuery
    ) {
      return String(data.messageId) === qMessageId ||
             String(data.actionCardMessageId) === qMessageId;
    }

    if (hasSpecificCardQuery) {
      const directMatch = String(data.actionCardId) === qActionCardId;
      const replacedMatch =
        includeReplaced &&
        Array.isArray(data.replacedActionCardIds) &&
        data.replacedActionCardIds.includes(qActionCardId);

      if (!directMatch && !replacedMatch) return false;
    }

    if (hasSpecificActionQuery) {
      if (String(data.actionId) !== qActionId) return false;
    }

    if (hasSpecificMessageQuery) {
      const msgMatch =
        String(data.messageId) === qMessageId ||
        String(data.actionCardMessageId) === qMessageId;

      if (!msgMatch) return false;
    }

    return true;
  }

  function buildFoundResult(data, {
    source = "unknown",
    query = {},
    inspected = 0
  } = {}) {
    return {
      ok: true,
      source,
      inspected,

      message: data.message,
      messageId: data.messageId,
      chatMsgId: data.messageId,

      flag: data.flag,
      payload: data.payload,
      meta: data.meta,

      actionId: data.actionId,
      actionCardId: data.actionCardId,
      actionCardVersion: data.actionCardVersion,
      actionCardMessageId: data.actionCardMessageId,
      replacedActionCardIds: data.replacedActionCardIds,
      state: data.state,

      skillName: data.skillName,
      attackerUuid: data.attackerUuid,

      query: clone(query, {})
    };
  }

  function buildNotFoundResult(query = {}, {
    reason = "not_found",
    inspected = 0
  } = {}) {
    return {
      ok: false,
      reason,
      inspected,
      query: clone(query, {})
    };
  }

  // =========================================================
  // PUBLIC FIND FUNCTIONS
  // =========================================================

  async function findActionCard(query = {}, options = {}) {
    const runId = `ACF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const normalizedQuery = {
      actionCardId: str(query.actionCardId ?? query.cardId ?? query.id),
      actionId: str(query.actionId),
      actionCardMessageId: str(
        query.actionCardMessageId ??
        query.messageId ??
        query.chatMsgId ??
        query.chatMessageId
      )
    };

    const hasAnyQuery =
      !!normalizedQuery.actionCardId ||
      !!normalizedQuery.actionId ||
      !!normalizedQuery.actionCardMessageId;

    if (!hasAnyQuery) {
      warn("findActionCard called without a usable lookup key.", {
        runId,
        query
      });

      return buildNotFoundResult(query, {
        reason: "missing_lookup_key",
        inspected: 0
      });
    }

    const searchOptions = {
      includeReplaced: options.includeReplaced !== false,
      maxMessages: Number(options.maxMessages ?? 250) || 250,
      newestFirst: options.newestFirst !== false
    };

    log("FIND START", {
      runId,
      normalizedQuery,
      searchOptions
    });

    // -------------------------------------------------------
    // 1) Fast path: direct message lookup
    // -------------------------------------------------------
    if (normalizedQuery.actionCardMessageId) {
      const message = await resolveMessageById(normalizedQuery.actionCardMessageId);

      if (message) {
        const data = extractActionCardData(message);

        log("DIRECT MESSAGE INSPECTED", {
          runId,
          messageId: message.id,
          hasActionCardFlag: !!data?.ok,
          actionId: data?.actionId ?? null,
          actionCardId: data?.actionCardId ?? null,
          actionCardVersion: data?.actionCardVersion ?? null
        });

        if (dataMatchesQuery(data, normalizedQuery, searchOptions)) {
          const result = buildFoundResult(data, {
            source: "direct-message-id",
            query: normalizedQuery,
            inspected: 1
          });

          log("FIND SUCCESS", {
            runId,
            source: result.source,
            actionId: result.actionId,
            actionCardId: result.actionCardId,
            actionCardVersion: result.actionCardVersion,
            messageId: result.messageId
          });

          return result;
        }

        // If message ID was provided but card ID did not match,
        // continue into loaded search in case actionCardMessageId was stale.
      }
    }

    // -------------------------------------------------------
    // 2) Loaded chat message search
    // -------------------------------------------------------
    const messages = getLoadedMessages({
      newestFirst: searchOptions.newestFirst,
      maxMessages: searchOptions.maxMessages
    });

    let inspected = 0;

    for (const message of messages) {
      inspected++;

      const data = extractActionCardData(message);
      if (!data?.ok) continue;

      if (dataMatchesQuery(data, normalizedQuery, searchOptions)) {
        const result = buildFoundResult(data, {
          source: "loaded-chat-search",
          query: normalizedQuery,
          inspected
        });

        log("FIND SUCCESS", {
          runId,
          source: result.source,
          inspected,
          actionId: result.actionId,
          actionCardId: result.actionCardId,
          actionCardVersion: result.actionCardVersion,
          messageId: result.messageId
        });

        return result;
      }
    }

    warn("FIND FAILED", {
      runId,
      normalizedQuery,
      inspected
    });

    return buildNotFoundResult(normalizedQuery, {
      reason: "not_found",
      inspected
    });
  }

  async function findByActionCardId(actionCardId, options = {}) {
    return await findActionCard({ actionCardId }, options);
  }

  async function findByActionId(actionId, options = {}) {
    return await findActionCard({ actionId }, options);
  }

  async function findByMessageId(messageId, options = {}) {
    return await findActionCard({ actionCardMessageId: messageId }, options);
  }

  // =========================================================
  // LIST / DEBUG FUNCTIONS
  // =========================================================

  function listLoadedActionCards(options = {}) {
    const maxMessages = Number(options.maxMessages ?? 250) || 250;
    const includePayload = !!options.includePayload;
    const stateFilter = str(options.state);

    const messages = getLoadedMessages({
      newestFirst: options.newestFirst !== false,
      maxMessages
    });

    const cards = [];

    for (const message of messages) {
      const data = extractActionCardData(message);
      if (!data?.ok) continue;

      if (stateFilter && lower(data.state) !== lower(stateFilter)) continue;

      const row = {
        messageId: data.messageId,
        actionId: data.actionId,
        actionCardId: data.actionCardId,
        actionCardVersion: data.actionCardVersion,
        actionCardMessageId: data.actionCardMessageId,
        replacedActionCardIds: data.replacedActionCardIds,
        state: data.state,
        skillName: data.skillName,
        attackerUuid: data.attackerUuid
      };

      if (includePayload) {
        row.payload = data.payload;
        row.flag = data.flag;
      }

      cards.push(row);
    }

    log("LIST LOADED ACTION CARDS", {
      count: cards.length,
      maxMessages,
      stateFilter: stateFilter || null
    });

    return {
      ok: true,
      count: cards.length,
      cards
    };
  }

  function getCardDataFromMessage(messageOrId) {
    const message =
      typeof messageOrId === "string"
        ? game.messages?.get?.(messageOrId)
        : messageOrId;

    if (!message) {
      return {
        ok: false,
        reason: "message_not_found",
        messageId: typeof messageOrId === "string" ? messageOrId : null
      };
    }

    return extractActionCardData(message);
  }

  function isActionCardMessage(messageOrId) {
    return !!getCardDataFromMessage(messageOrId)?.ok;
  }

  // =========================================================
  // API REGISTRATION
  // =========================================================

  const api = {
    version: API_VERSION,

    findActionCard,
    findByActionCardId,
    findByActionId,
    findByMessageId,

    listLoadedActionCards,
    getCardDataFromMessage,
    isActionCardMessage,

    // Lower-level utility exports for later scripts.
    getActionCardFlag,
    extractActionCardData,
    dataMatchesQuery
  };

  // Global namespace.
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  globalThis.FUCompanion.api.actionEditorCardFinder = api;

  globalThis.FUCompanion.api.actionEditor =
    globalThis.FUCompanion.api.actionEditor || {};

  globalThis.FUCompanion.api.actionEditor.cardFinder = api;

  // Module API namespace.
  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};

      mod.api.actionEditorCardFinder = api;

      mod.api.actionEditor = mod.api.actionEditor || {};
      mod.api.actionEditor.cardFinder = api;
    }
  } catch (e) {
    warn("Could not register CardFinder on game.modules API.", {
      error: String(e?.message ?? e)
    });
  }

  console.log(`${TAG} Ready`, {
    version: API_VERSION,
    moduleId: MODULE_ID,
    debug: ACTION_EDITOR_CARD_FINDER_DEBUG
  });
})();