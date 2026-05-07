// scripts/applyDamage-button.js — Foundry VTT v12
// Confirm (owner or GM) → commits the action via shared Action Execution Core.
//
// • Button: [data-fu-confirm] (shown only to action owner or GM; fu-card-hydrate enforces per-client visibility)
// • Players: click Confirm → request GM to resolve via module socket (module.fabula-ultima-companion)
// • GM: click Confirm OR receives socket request → resolves immediately on GM client
//
// Notes:
// - This version delegates actual action execution to:
//     window.FUCompanion.api.actionExecution.execute(...)
// - Chat button locking, card stamping, and socket sync remain here.
// - This keeps manual Confirm behavior intact while making the execution backend reusable
//   for future Auto Passive / Auto Reaction flows.

const MODULE_ID = "fu-chatbtn";
const MODULE_NS = "fabula-ultima-companion";
const SOCKET_NS = "module.fabula-ultima-companion";

Hooks.once("ready", async () => {
  const root = document.querySelector("#chat-log") || document.body;
  if (!root) return;

  // Prevent double-binding on this client
  if (root.__fuChatBtnBound) return;
  root.__fuChatBtnBound = true;

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  async function resolveAttackerActor(attackerUuid) {
    const doc = await fromUuid(attackerUuid).catch(() => null);
    return (
      doc?.actor ??
      (doc?.documentName === "Actor" ? doc : null) ??
      (doc?.documentName === "Token" ? doc.actor : null) ??
      (doc?.documentName === "TokenDocument" ? doc.actor : null)
    );
  }

  function lockButton(btn, text = "Confirming…") {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = text;
    btn.style.filter = "grayscale(.25)";
    btn.dataset.fuLock = "1";
  }

  function unlockButton(btn, text = "✅ Confirm") {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = text;
    btn.style.filter = "";
    btn.dataset.fuLock = "0";
  }

  function getPrimaryActiveGM() {
  const activeGMs = Array.from(game.users ?? [])
    .filter(u => u.active && u.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return activeGMs[0] ?? null;
}

function isPrimaryActiveGMClient() {
  const primary = getPrimaryActiveGM();
  return !!primary && primary.id === game.userId;
}

function getSavedTargetUUIDsFromPayload(payload = {}) {
  const arr =
    (Array.isArray(payload?.originalTargetUUIDs) && payload.originalTargetUUIDs.length)
      ? payload.originalTargetUUIDs
      : (Array.isArray(payload?.meta?.originalTargetUUIDs) && payload.meta.originalTargetUUIDs.length)
        ? payload.meta.originalTargetUUIDs
        : (Array.isArray(payload?.targets) ? payload.targets : []);

  return Array.from(new Set(arr.filter(Boolean).map(String)));
}

function getSavedTargetActorUUIDsFromPayload(payload = {}) {
  const arr =
    (Array.isArray(payload?.originalTargetActorUUIDs) && payload.originalTargetActorUUIDs.length)
      ? payload.originalTargetActorUUIDs
      : (Array.isArray(payload?.meta?.originalTargetActorUUIDs) && payload.meta.originalTargetActorUUIDs.length)
        ? payload.meta.originalTargetActorUUIDs
        : [];

  return Array.from(new Set(arr.filter(Boolean).map(String)));
}

function buildSafeExecutionArgsFromFlaggedPayload(flagged, incomingArgs = {}, chatMsgId = null) {
  const clean = foundry.utils.deepClone(incomingArgs || {});

  // These are baked into the button when the card is printed.
  // After Action Editor edits the card, these may be stale, so remove them.
  const staleKeys = [
    "actionContext",
    "advPayload",

    "elementType",
    "weaponType",
    "valueType",
    "baseValue",
    "bonus",
    "reduction",
    "multiplier",

    "ignoreShield",
    "ignoreDamageReduction",

    "hasDamageSection",
    "declaresHealing",
    "isSpellish",
    "skillTypeRaw",

    "attackerUuid",
    "attackerName",
    "skillName",
    "sourceType",
    "attackRange",

    "hasAccuracy",
    "accuracyTotal",
    "autoHit",
    "forceMiss",

    "targets",
    "originalTargetUUIDs",
    "originalTargetActorUUIDs"
  ];

  for (const key of staleKeys) {
    delete clean[key];
  }

  const meta = flagged?.meta ?? {};
  const core = flagged?.core ?? {};
  const dataCore = flagged?.dataCore ?? {};
  const adv = flagged?.advPayload ?? {};
  const accuracy = flagged?.accuracy ?? null;

  const savedTargets = getSavedTargetUUIDsFromPayload(flagged);
  const savedTargetActors = getSavedTargetActorUUIDsFromPayload(flagged);

  return {
    ...clean,

    // Identity from the latest flag.
    actionId: meta.actionId ?? flagged?.actionId ?? null,
    actionCardId: meta.actionCardId ?? flagged?.actionCardId ?? null,
    actionCardVersion: meta.actionCardVersion ?? flagged?.actionCardVersion ?? null,
    actionCardMessageId: meta.actionCardMessageId ?? flagged?.actionCardMessageId ?? chatMsgId ?? null,
    chatMsgId,

    // Most important: resolution receives the latest edited payload.
    actionContext: flagged,
    advPayload: foundry.utils.deepClone(adv),

    attackerUuid: meta.attackerUuid ?? flagged?.attackerUuid ?? flagged?.attackerActorUuid ?? null,
    attackerName: meta.attackerName ?? core.attackerName ?? "Unknown",

    skillName: core.skillName ?? dataCore.skillName ?? null,
    sourceType: meta.sourceType ?? adv.sourceType ?? null,
    attackRange: meta.attackRange ?? adv.attackRange ?? "Melee",

    elementType:
      meta.elementType ??
      adv.elementType ??
      core.typeDamageTxt ??
      dataCore.typeDamageTxt ??
      "physical",

    weaponType:
      core.weaponType ??
      adv.weaponType ??
      meta.weaponType ??
      "",

    valueType:
      adv.valueType ??
      meta.valueType ??
      "hp",

    baseValue:
      adv.baseValue ??
      meta.baseValue ??
      "0",

    bonus:
      adv.bonus ??
      meta.bonus ??
      0,

    reduction:
      adv.reduction ??
      meta.reduction ??
      0,

    multiplier:
      adv.multiplier ??
      meta.multiplier ??
      100,

    ignoreShield: !!(adv.ignoreShield ?? meta.ignoreShield),
    ignoreDamageReduction: !!(adv.ignoreDamageReduction ?? meta.ignoreDamageReduction),

    hasDamageSection:
      (meta.hasDamageSection !== undefined)
        ? !!meta.hasDamageSection
        : (adv.hasDamageSection !== undefined)
          ? !!adv.hasDamageSection
          : true,

    declaresHealing: !!(meta.declaresHealing ?? adv.declaresHealing),

    isSpellish: !!(
      meta.isSpellish ??
      dataCore.isSpell ??
      dataCore.isOffSpell
    ),

    skillTypeRaw:
      core.skillTypeRaw ??
      dataCore.skillTypeRaw ??
      meta.skillTypeRaw ??
      "",

    hasAccuracy: !!accuracy,
    accuracyTotal: accuracy?.total ?? null,

    autoHit: !!(
      accuracy?.autoHit ??
      meta.autoHit ??
      adv.autoHit ??
      adv.isCrit ??
      accuracy?.isCrit
    ),

    forceMiss: !!(
  accuracy?.forceMiss ||
  accuracy?.isFumble ||
  meta.forceMiss ||
  adv.forceMiss ||
  adv.isFumble
),

    targets: savedTargets,
    originalTargetUUIDs: savedTargets,
    originalTargetActorUUIDs: savedTargetActors
  };
}
async function setChatFlagNoRender(chatMsg, scope, key, value) {
  if (!chatMsg) return null;

  return await chatMsg.update(
    {
      [`flags.${scope}.${key}`]: value
    },
    {
      render: false
    }
  );
}

async function setActionCardState(chatMsg, state, extra = {}) {
  if (!chatMsg) return;

  const flag = foundry.utils.deepClone(chatMsg.getFlag(MODULE_NS, "actionCard") ?? {});
  const payload = flag?.payload ?? null;
  if (!payload) return;

  payload.meta = payload.meta || {};
  payload.meta.actionCardState = state;
  payload.actionCardState = state;

  const at = Date.now();
  payload.meta.actionCardStateChangedAtMs = at;
  payload.meta.actionCardStateChangedAtIso = new Date(at).toISOString();

  for (const [k, v] of Object.entries(extra || {})) {
    payload.meta[k] = v;
  }

  flag.payload = payload;
  flag.actionCardState = state;

  await setChatFlagNoRender(chatMsg, MODULE_NS, "actionCard", flag);
}

  // ------------------------------------------------------------
  // Core resolver (GM only)
  // ------------------------------------------------------------
  async function runConfirm(chatMsg, args = {}, confirmingUserId = null) {
    const RUN_TAG = "[fu-chatbtn][Confirm]";
    const runId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const msgEl =
      document.querySelector(`#chat-log .message[data-message-id="${chatMsg.id}"]`) ||
      document.querySelector(`.chat-popout .message[data-message-id="${chatMsg.id}"]`) ||
      null;

    const btn = msgEl?.querySelector?.("[data-fu-confirm]") ?? null;

    // double-click guard
    if (btn?.dataset?.fuLock === "1") return;
    if (btn) lockButton(btn, "Confirming…");

    console.groupCollapsed(`${RUN_TAG} START runId=${runId} msgId=${chatMsg.id}`);
    console.log(`${RUN_TAG} meta`, {
      runId,
      msgId: chatMsg.id,
      confirmingUserId,
      gm: !!game.user?.isGM,
      argsKeys: Object.keys(args || {})
    });

    try {
      const flagged = chatMsg.getFlag(MODULE_NS, "actionCard")?.payload ?? null;
      const executor = globalThis.FUCompanion?.api?.actionExecution?.execute ?? null;

      console.log(`${RUN_TAG} flagged payload`, {
        hasFlagged: !!flagged,
        hasMeta: !!flagged?.meta,
        hasCore: !!flagged?.core,
        hasExecutor: !!executor
      });

      if (!flagged?.meta || !flagged?.core) {
        ui.notifications?.error("Confirm: missing action payload on chat card.");
        throw new Error("Missing action payload");
      }

      if (!executor) {
        ui.notifications?.error("Confirm: Action Execution Core API not found.");
        throw new Error("Action Execution Core API not found");
      }

      // Prevent double-confirm (server-side-ish)
      const already = await chatMsg.getFlag(MODULE_NS, "actionApplied");
      if (already) {
        console.warn(`${RUN_TAG} already applied, abort`, already);
        return;
      }

      await setActionCardState(chatMsg, "confirming", {
        actionCardConfirmingByUserId: confirmingUserId ?? game.userId,
        actionCardConfirmingRunId: runId
      });

      const executionArgs = buildSafeExecutionArgsFromFlaggedPayload(flagged, args, chatMsg.id);

      console.log(`${RUN_TAG} execution handoff`, {
        runId,
        executionMode: "manualCard",
        chatMsgId: chatMsg.id,
        attackerUuid: flagged?.meta?.attackerUuid ?? null,
        skillName: flagged?.core?.skillName ?? null
      });

      const result = await executor({
        actionContext: flagged,
        args: executionArgs,
        chatMsgId: chatMsg.id,
        executionMode: "manualCard",
        confirmingUserId,
        skipVisualFeedback: false
      });

      console.log(`${RUN_TAG} execution result`, { runId, result });

      if (!result?.ok) {
        const reason = result?.reason ?? "unknown";
        console.warn(`${RUN_TAG} executor reported non-ok result`, { runId, reason, result });

      await setActionCardState(chatMsg, "pending", {
        actionCardLastConfirmFailedByUserId: confirmingUserId ?? game.userId,
        actionCardLastConfirmFailedRunId: runId,
        actionCardLastConfirmFailedReason: reason
      });

      if (btn) unlockButton(btn);
      return;
    }

    await setActionCardState(chatMsg, "resolved", {
      actionCardResolvedByUserId: confirmingUserId ?? game.userId,
      actionCardResolvedRunId: runId
    });

      // Stamp + disable button (GM client)
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Confirmed ✔";
        btn.style.filter = "grayscale(1)";
        btn.dataset.fuLock = "1";
      }

      const stamp = msgEl?.querySelector?.("[data-fu-stamp]");
      if (stamp) {
        const by = confirmingUserId ? (game.users.get(confirmingUserId)?.name ?? "Player") : game.user.name;
        stamp.textContent = `Confirmed by: ${by}`;
        stamp.style.opacity = ".9";
      }

await setChatFlagNoRender(chatMsg, MODULE_NS, "actionApplied", {
  by: confirmingUserId ?? game.userId,
  at: Date.now(),
  executionMode: "manualCard",
  result: {
    hitUUIDs: Array.isArray(result?.hitUUIDs) ? result.hitUUIDs : [],
    missUUIDs: Array.isArray(result?.missUUIDs) ? result.missUUIDs : []
  }
});

      // Broadcast to all clients so their Confirm button greys out too
      game.socket.emit(SOCKET_NS, {
        type: "fu.actionConfirmed",
        messageId: chatMsg.id,
        by: confirmingUserId ?? game.userId
      });

      console.log(`[${MODULE_ID}] Confirm resolved`, {
        chatMsgId: chatMsg.id,
        hitUUIDs: result?.hitUUIDs ?? [],
        missUUIDs: result?.missUUIDs ?? []
      });

} catch (err) {
  console.error(err);

  await setActionCardState(chatMsg, "pending", {
    actionCardLastConfirmError: String(err?.message ?? err),
    actionCardLastConfirmFailedByUserId: confirmingUserId ?? game.userId,
    actionCardLastConfirmFailedRunId: runId
  });

  ui.notifications?.error("Confirm failed (see console).");
  if (btn) unlockButton(btn);
} finally {
      console.groupEnd();
    }
  }

  // ------------------------------------------------------------
  // Socket receiver
  // ------------------------------------------------------------
  game.socket.on(SOCKET_NS, async (data) => {
    try {
      // GM-only: player requests confirm
      if (data?.type === "fu.actionConfirm") {
  if (!game.user?.isGM) return;

  // IMPORTANT: only one full GM client handles player confirm requests
  if (!isPrimaryActiveGMClient()) {
    console.log("[fu-chatbtn] Skip confirm on non-primary GM", {
      thisUser: game.userId,
      primaryGM: getPrimaryActiveGM()?.id ?? null,
      messageId: data.messageId ?? null
    });
    return;
  }

  const chatMsg = data.messageId ? game.messages.get(data.messageId) : null;
  if (!chatMsg) return;

  const already = await chatMsg.getFlag(MODULE_NS, "actionApplied");
  if (already) return;

  // Validate: confirming user must own the attacker OR match ownerUserId
  const flagged = chatMsg.getFlag(MODULE_NS, "actionCard")?.payload ?? null;
  const ownerUserId = flagged?.meta?.ownerUserId ?? null;

  let ok = false;
  if (ownerUserId && ownerUserId === data.userId) ok = true;
  else {
    const attackerUuid = flagged?.meta?.attackerUuid ?? null;
    if (attackerUuid) {
      const actor = await resolveAttackerActor(attackerUuid);
      const user = game.users.get(data.userId);
      if (actor && user) ok = actor.testUserPermission(user, "OWNER");
    }
  }
  if (!ok) return;

  await runConfirm(chatMsg, data.args ?? {}, data.userId);
  return;
}

      // ALL clients: GM broadcasts that this action is confirmed
      if (data?.type === "fu.actionConfirmed") {
        const msgId = data.messageId;
        if (!msgId) return;

        const msgEl =
          document.querySelector(`#chat-log .message[data-message-id="${msgId}"]`) ||
          document.querySelector(`.chat-popout .message[data-message-id="${msgId}"]`) ||
          null;

        const btn = msgEl?.querySelector?.("[data-fu-confirm]") ?? null;
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Confirmed ✔";
          btn.style.filter = "grayscale(1)";
          btn.dataset.fuLock = "1";
        }

        return;
      }
    } catch (err) {
      console.error("[fu-chatbtn] socket handler failed:", err);
    }
  });

  // ------------------------------------------------------------
  // Click handler (all clients)
  // ------------------------------------------------------------
  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-confirm]");
    if (!btn) return;

    // Double-click guard
    if (btn.dataset.fuLock === "1") return;

    const msgEl = btn.closest?.(".message");
    const msgId = msgEl?.dataset?.messageId;
    const chatMsg = msgId ? game.messages.get(msgId) : null;
    if (!chatMsg) return;

    // Parse dataset args
    let args = {};
    try { args = btn.dataset.fuArgs ? JSON.parse(btn.dataset.fuArgs) : {}; }
    catch { args = {}; }

    // Permission: GM always; otherwise must own attacker (or match ownerUserId)
    const flagged = chatMsg.getFlag(MODULE_NS, "actionCard")?.payload ?? null;
    const ownerUserId = flagged?.meta?.ownerUserId ?? null;

    let ownsAttacker = false;
    try {
      const attackerUuid = flagged?.meta?.attackerUuid ?? null;
      if (attackerUuid) {
        const actor = await resolveAttackerActor(attackerUuid);
        ownsAttacker = !!actor?.isOwner;
      }
    } catch {}

    const canConfirm = !!game.user?.isGM || (ownerUserId && ownerUserId === game.userId) || ownsAttacker;
    if (!canConfirm) {
      ui.notifications?.warn("You can only confirm actions for a character you own.");
      return;
    }

    // If player: request GM to resolve via socket
    if (!game.user?.isGM) {
      btn.dataset.fuLock = "1";
      lockButton(btn, "Confirming…");
      game.socket.emit(SOCKET_NS, {
        type: "fu.actionConfirm",
        messageId: msgId,
        userId: game.userId,
        args
      });
      return;
    }

    // GM click: resolve locally
    await runConfirm(chatMsg, args, game.userId);
  }, { capture: false });

  console.log(`[${MODULE_ID}] ready — global Confirm listener installed on this client`);
});
