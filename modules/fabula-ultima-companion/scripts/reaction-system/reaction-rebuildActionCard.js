/**
 * reaction-rebuildActionCard.js
 * Foundry VTT v12
 * ---------------------------------------------------------------------------
 * PURPOSE
 * -------
 * Rebuild an existing pending FU Action Card from its stored flag payload,
 * preserving the stable action identity while creating a fresh card instance.
 *
 * Typical use:
 *   window["oni.ReactionRebuildActionCard"].rebuildByMessageId(messageId, {
 *     preserveIdentity: true,
 *     reason: "reaction_target_redirect"
 *   });
 *
 * WHY THIS EXISTS
 * ---------------
 * Some reaction mechanics (Protect / Cover / Redirect / Intercept) need to:
 *   1) edit the stored payload on an existing pending action card
 *   2) then visually rebuild the card so the UI matches the new payload
 *
 * This helper:
 *   - reads the old chat card payload
 *   - re-posts it through CreateActionCard
 *   - finds the newly created card
 *   - deletes the old one after success
 *
 * API
 * ---
 * window["oni.ReactionRebuildActionCard"] = {
 *   rebuildByMessageId(messageId, opts),
 *   rebuildFromMessage(chatMsg, opts)
 * }
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionRebuildActionCard";
    if (window[KEY]) {
      console.log("[ReactionRebuildActionCard] Already installed.");
      return;
    }

    const MODULE_ID = "fabula-ultima-companion";
    const MODULE_NS = "fabula-ultima-companion";
    const CARD_FLAG = "actionCard";
    const APPLIED_FLAG = "actionApplied";
    const CREATE_ACTION_CARD_MACRO_NAME = "CreateActionCard";

    const TAG = "[ReactionRebuildActionCard]";
    const DEBUG = true;

    const log = (...a) => DEBUG && console.log(TAG, ...a);
    const warn = (...a) => DEBUG && console.warn(TAG, ...a);
    const err = (...a) => DEBUG && console.error(TAG, ...a);

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function clone(value, fallback = null) {
      try {
        if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
      } catch (_e) {}
      try {
        return structuredClone(value);
      } catch (_e) {}
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_e) {}
      return fallback;
    }

    function firstNonBlank(...values) {
      for (const value of values) {
        if (value == null) continue;
        const s = String(value).trim();
        if (s) return s;
      }
      return "";
    }

    function makeFallbackActionId(prefix = "ACT-RBLD") {
      const rnd =
        foundry?.utils?.randomID?.(8) ??
        Math.random().toString(36).slice(2, 10);
      return `${prefix}-${Date.now().toString(36)}-${rnd}`;
    }

    function defaultRequestingActorUuid() {
      try {
        return (
          game.user?.character?.uuid ||
          canvas.tokens?.controlled?.[0]?.actor?.uuid ||
          canvas.tokens?.controlled?.[0]?.document?.uuid ||
          null
        );
      } catch (_e) {
        return null;
      }
    }

    async function getWrapperFromMessage(chatMsg) {
      try {
        const wrapper = chatMsg?.getFlag?.(MODULE_NS, CARD_FLAG);
        return (wrapper && typeof wrapper === "object") ? clone(wrapper, {}) : null;
      } catch (_e) {
        return null;
      }
    }

    async function getPayloadFromMessage(chatMsg) {
      const wrapper = await getWrapperFromMessage(chatMsg);
      const payload = wrapper?.payload ?? null;
      return (payload && typeof payload === "object") ? payload : null;
    }

    async function findNewestMessageForActionId(actionId, excludeMessageId = null, beforeIds = null) {
      const msgs = Array.from(game.messages?.contents ?? []).slice().reverse();

      for (const msg of msgs) {
        if (!msg) continue;
        if (excludeMessageId && String(msg.id) === String(excludeMessageId)) continue;
        if (beforeIds && beforeIds.has(String(msg.id))) continue;

        let wrapper = null;
        try {
          wrapper = msg.getFlag(MODULE_NS, CARD_FLAG);
        } catch (_e) {}

        const payload = wrapper?.payload ?? {};
        const meta = payload?.meta ?? {};

        const msgActionId = firstNonBlank(
          wrapper?.actionId,
          payload?.actionId,
          meta?.actionId
        );

        if (msgActionId && String(msgActionId) === String(actionId)) {
          return {
            msg,
            wrapper: clone(wrapper, {}),
            payload: clone(payload, {})
          };
        }
      }

      return null;
    }

    function buildRemoteScript() {
      return `
const MODULE_NS = "fabula-ultima-companion";
const CARD_FLAG = "actionCard";
const APPLIED_FLAG = "actionApplied";
const CREATE_ACTION_CARD_MACRO_NAME = "CreateActionCard";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function makeFallbackActionId(prefix = "ACT-RBLD") {
  const rnd =
    foundry?.utils?.randomID?.(8) ??
    Math.random().toString(36).slice(2, 10);
  return \`\${prefix}-\${Date.now().toString(36)}-\${rnd}\`;
}

async function findNewestMessageForActionId(actionId, excludeMessageId = null, beforeIds = null) {
  const msgs = Array.from(game.messages?.contents ?? []).slice().reverse();

  for (const msg of msgs) {
    if (!msg) continue;
    if (excludeMessageId && String(msg.id) === String(excludeMessageId)) continue;
    if (beforeIds && beforeIds.has(String(msg.id))) continue;

    let wrapper = null;
    try {
      wrapper = msg.getFlag(MODULE_NS, CARD_FLAG);
    } catch (_e) {}

    const payload = wrapper?.payload ?? {};
    const meta = payload?.meta ?? {};

    const msgActionId = firstNonBlank(
      wrapper?.actionId,
      payload?.actionId,
      meta?.actionId
    );

    if (msgActionId && String(msgActionId) === String(actionId)) {
      return {
        msg,
        wrapper: foundry.utils.deepClone(wrapper),
        payload: foundry.utils.deepClone(payload)
      };
    }
  }

  return null;
}

const opts = globals?.__REBUILD_OPTS ?? {};
const messageId = String(opts?.messageId ?? "").trim();
if (!messageId) throw new Error("Missing rebuild target messageId");

const oldMsg = game.messages?.get(messageId) ?? null;
if (!oldMsg) throw new Error(\`Old action card message not found: \${messageId}\`);

const applied = oldMsg.getFlag?.(MODULE_NS, APPLIED_FLAG);
if (applied && opts?.allowApplied !== true) {
  throw new Error("Action card is already applied; refusing rebuild");
}

const wrapper = oldMsg.getFlag?.(MODULE_NS, CARD_FLAG);
if (!wrapper || typeof wrapper !== "object" || !wrapper.payload) {
  throw new Error("Action card wrapper payload missing on old message");
}

const payload = foundry.utils.deepClone(wrapper.payload);
payload.meta = payload.meta || {};

const stableActionId = firstNonBlank(
  payload?.meta?.actionId,
  payload?.actionId,
  wrapper?.actionId
) || makeFallbackActionId();

payload.meta.actionId = stableActionId;
payload.actionId = stableActionId;

payload.meta.rebuildHistory = Array.isArray(payload.meta.rebuildHistory)
  ? payload.meta.rebuildHistory
  : [];

payload.meta.rebuildHistory.push({
  timestamp: Date.now(),
  reason: String(opts?.reason ?? "reaction_rebuild"),
  previousMessageId: oldMsg.id,
  previousActionCardId: firstNonBlank(payload?.meta?.actionCardId, payload?.actionCardId, wrapper?.actionCardId) || null,
  previousActionCardVersion: Number(payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? wrapper?.actionCardVersion ?? 0) || 0,
  rebuiltByUserId: game.user?.id ?? null,
  rebuiltByUserName: game.user?.name ?? null
});

payload.meta.rebuildReason = String(opts?.reason ?? "reaction_rebuild");
payload.meta.rebuildRequestedAt = Date.now();
payload.meta.rebuildPreviousMessageId = oldMsg.id;

const beforeIds = new Set((game.messages?.contents ?? []).map(m => String(m.id)));

const createMacro = game.macros?.getName?.(CREATE_ACTION_CARD_MACRO_NAME) ?? null;
if (!createMacro) {
  throw new Error(\`Macro "\${CREATE_ACTION_CARD_MACRO_NAME}" not found\`);
}

await createMacro.execute({
  __AUTO: true,
  __PAYLOAD: payload
});

let created = null;
for (let i = 0; i < 15; i++) {
  created = await findNewestMessageForActionId(stableActionId, oldMsg.id, beforeIds);
  if (created?.msg) break;
  await sleep(80);
}

if (!created?.msg) {
  throw new Error("Rebuild create step finished, but new action card message could not be located");
}

if (opts?.deleteOld !== false) {
  await oldMsg.delete();
}

return {
  ok: true,
  oldMessageId: oldMsg.id,
  newMessageId: created.msg.id,
  actionId: stableActionId,
  actionCardId: firstNonBlank(
    created?.wrapper?.actionCardId,
    created?.payload?.meta?.actionCardId,
    created?.payload?.actionCardId
  ) || null,
  actionCardVersion: Number(
    created?.wrapper?.actionCardVersion ??
    created?.payload?.meta?.actionCardVersion ??
    created?.payload?.actionCardVersion ??
    NaN
  ),
  deletedOld: opts?.deleteOld !== false
};
      `.trim();
    }

    async function runRemoteRebuild(messageId, opts = {}) {
      const gmExecutor =
        game.modules?.get(MODULE_ID)?.api?.GMExecutor ??
        globalThis.FUCompanion?.api?.GMExecutor ??
        null;

      if (!gmExecutor?.executeSnippet) {
        return {
          ok: false,
          reason: "gm_executor_missing",
          error: "GMExecutor.executeSnippet is unavailable"
        };
      }

      const actorUuid =
        opts?.requestingActorUuid ||
        opts?.actorUuid ||
        defaultRequestingActorUuid();

      if (!actorUuid) {
        return {
          ok: false,
          reason: "no_requesting_actor_uuid",
          error: "No requesting actor uuid was available for GM validation"
        };
      }

      const result = await gmExecutor.executeSnippet({
        mode: "generic",
        scriptText: buildRemoteScript(),
        payload: {},
        actorUuid,
        globals: {
          __REBUILD_OPTS: {
            messageId: String(messageId),
            reason: String(opts?.reason ?? "reaction_rebuild"),
            deleteOld: opts?.deleteOld !== false,
            allowApplied: opts?.allowApplied === true
          }
        }
      });

      if (!result?.ok) {
        return {
          ok: false,
          reason: "remote_rebuild_failed",
          error: result?.error ?? "Unknown GMExecutor failure",
          stack: result?.stack ?? null
        };
      }

      return result?.resultValue ?? { ok: true };
    }

    async function runLocalRebuild(chatMsg, opts = {}) {
      const applied = await chatMsg.getFlag?.(MODULE_NS, APPLIED_FLAG);
      if (applied && opts?.allowApplied !== true) {
        return {
          ok: false,
          reason: "already_applied",
          error: "Action card is already applied; refusing rebuild"
        };
      }

      const wrapper = await getWrapperFromMessage(chatMsg);
      if (!wrapper?.payload) {
        return {
          ok: false,
          reason: "missing_payload",
          error: "Action card wrapper payload missing on old message"
        };
      }

      const payload = clone(wrapper.payload, {});
      payload.meta = payload.meta || {};

      const stableActionId = firstNonBlank(
        payload?.meta?.actionId,
        payload?.actionId,
        wrapper?.actionId
      ) || makeFallbackActionId();

      payload.meta.actionId = stableActionId;
      payload.actionId = stableActionId;

      payload.meta.rebuildHistory = Array.isArray(payload.meta.rebuildHistory)
        ? payload.meta.rebuildHistory
        : [];

      payload.meta.rebuildHistory.push({
        timestamp: Date.now(),
        reason: String(opts?.reason ?? "reaction_rebuild"),
        previousMessageId: chatMsg.id,
        previousActionCardId: firstNonBlank(payload?.meta?.actionCardId, payload?.actionCardId, wrapper?.actionCardId) || null,
        previousActionCardVersion: Number(payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? wrapper?.actionCardVersion ?? 0) || 0,
        rebuiltByUserId: game.user?.id ?? null,
        rebuiltByUserName: game.user?.name ?? null
      });

      payload.meta.rebuildReason = String(opts?.reason ?? "reaction_rebuild");
      payload.meta.rebuildRequestedAt = Date.now();
      payload.meta.rebuildPreviousMessageId = chatMsg.id;

      const beforeIds = new Set((game.messages?.contents ?? []).map(m => String(m.id)));

      const createMacro = game.macros?.getName?.(CREATE_ACTION_CARD_MACRO_NAME) ?? null;
      if (!createMacro) {
        return {
          ok: false,
          reason: "missing_create_action_card_macro",
          error: `Macro "${CREATE_ACTION_CARD_MACRO_NAME}" not found`
        };
      }

      await createMacro.execute({
        __AUTO: true,
        __PAYLOAD: payload
      });

      let created = null;
      for (let i = 0; i < 15; i++) {
        created = await findNewestMessageForActionId(stableActionId, chatMsg.id, beforeIds);
        if (created?.msg) break;
        await sleep(80);
      }

      if (!created?.msg) {
        return {
          ok: false,
          reason: "new_message_not_found",
          error: "Rebuild create step finished, but new action card message could not be located"
        };
      }

      if (opts?.deleteOld !== false) {
        try {
          await chatMsg.delete();
        } catch (deleteErr) {
          warn("New card created, but deleting old card failed.", deleteErr);
          return {
            ok: true,
            oldMessageId: chatMsg.id,
            newMessageId: created.msg.id,
            actionId: stableActionId,
            actionCardId: firstNonBlank(
              created?.wrapper?.actionCardId,
              created?.payload?.meta?.actionCardId,
              created?.payload?.actionCardId
            ) || null,
            actionCardVersion: Number(
              created?.wrapper?.actionCardVersion ??
              created?.payload?.meta?.actionCardVersion ??
              created?.payload?.actionCardVersion ??
              NaN
            ),
            deletedOld: false,
            warning: "old_delete_failed"
          };
        }
      }

      return {
        ok: true,
        oldMessageId: chatMsg.id,
        newMessageId: created.msg.id,
        actionId: stableActionId,
        actionCardId: firstNonBlank(
          created?.wrapper?.actionCardId,
          created?.payload?.meta?.actionCardId,
          created?.payload?.actionCardId
        ) || null,
        actionCardVersion: Number(
          created?.wrapper?.actionCardVersion ??
          created?.payload?.meta?.actionCardVersion ??
          created?.payload?.actionCardVersion ??
          NaN
        ),
        deletedOld: opts?.deleteOld !== false
      };
    }

    async function rebuildFromMessage(chatMsg, opts = {}) {
      if (!chatMsg?.id) {
        return {
          ok: false,
          reason: "missing_chat_message",
          error: "rebuildFromMessage received no valid ChatMessage"
        };
      }

      log("START rebuildFromMessage", {
        messageId: chatMsg.id,
        isGM: !!game.user?.isGM,
        opts
      });

      let result = null;

      if (game.user?.isGM) {
        result = await runLocalRebuild(chatMsg, opts);
      } else {
        result = await runRemoteRebuild(chatMsg.id, opts);
      }

      if (!result?.ok) {
        ui.notifications?.error?.(`[Reaction] Rebuild failed: ${result?.error ?? result?.reason ?? "Unknown error"}`);
        err("Rebuild failed.", result);
        return result;
      }

      log("DONE rebuildFromMessage", result);
      return result;
    }

    async function rebuildByMessageId(messageId, opts = {}) {
      const msg = game.messages?.get?.(String(messageId)) ?? null;
      if (!msg) {
        return {
          ok: false,
          reason: "message_not_found",
          error: `ChatMessage not found: ${messageId}`
        };
      }
      return await rebuildFromMessage(msg, opts);
    }

    window[KEY] = {
      rebuildByMessageId,
      rebuildFromMessage
    };

    log("Installed.", { key: KEY });
  })();
});