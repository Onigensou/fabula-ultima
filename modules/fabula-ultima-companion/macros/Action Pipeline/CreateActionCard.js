// ──────────────────────────────────────────────────────────
//  Create Action Card (global, delegated UI bind) — Foundry V12
//  • One row: Confirm → Invoke Trait → Invoke Bond
//  • Tooltips (black, instant) via document-level delegation
//  • Collapsible Effect via delegation
//  • Content-link open via delegation
//  • Roll-up numbers auto-run for new cards (IO + MO)
//  • Invoke buttons are HTML only; your module handles click logic
//  • No Dismiss button
//  • NEW: Floating 👑 Critical! callout (no more crit badge in Accuracy row)
//  • UPDATED: canonical saved target UUIDs are now the source of truth
//  • NEW: display action cost in subtitle row when cost exists
// ──────────────────────────────────────────────────────────
const ADV_MACRO_NAME  = "AdvanceDamage";
const MISS_MACRO_NAME = "Miss";
const MODULE_NS       = "fabula-ultima-companion";
const CAC_DEBUG       = true;
const CAC_TAG         = "[ONI][CreateActionCard]";

// --- icons for defense targeting (Strike/Magic) ---
const STRIKE_ICON_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/UI/fu-icon/physical_icon.png";
const MAGIC_ICON_URL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/UI/fu-icon/magical_icon.png";

// ---------- one-time global UI binder (idempotent) ----------
(function fuBindGlobalOnce(){
  if (window.__fuCardUIBound) return;
  window.__fuCardUIBound = true;

  // Global tooltip node
  const TT_ID = "fu-global-tooltip";
  let tipEl = document.getElementById(TT_ID);
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.id = TT_ID;
    Object.assign(tipEl.style, {
      position: "fixed", zIndex: "2147483647", display: "none",
      background: "rgba(0,0,0,.90)", color: "#fff", padding: ".45rem .6rem",
      borderRadius: "6px", fontSize: "12px", maxWidth: "320px",
      pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,.4)",
      border: "1px solid rgba(255,255,255,.15)", textAlign: "left",
      whiteSpace: "pre-wrap"
    });
    document.body.appendChild(tipEl);
  }
  const TIP_MARGIN = 10, CURSOR_GAP = 12;
  const placeTipAt = (x,y) => {
    const vw=innerWidth, vh=innerHeight, r=tipEl.getBoundingClientRect();
    let tx=x+CURSOR_GAP, ty=y+CURSOR_GAP;
    if (tx + r.width + TIP_MARGIN > vw) tx = x - r.width - CURSOR_GAP;
    if (tx < TIP_MARGIN) tx = TIP_MARGIN;
    if (ty + r.height + TIP_MARGIN > vh) ty = y - r.height - CURSOR_GAP;
    if (ty < TIP_MARGIN) ty = TIP_MARGIN;
    tipEl.style.left = `${tx}px`; tipEl.style.top = `${ty}px`;
  };
  const showTip = (html,x,y)=>{ tipEl.style.visibility="hidden"; tipEl.style.display="block"; tipEl.innerHTML=html; placeTipAt(x,y); tipEl.style.visibility="visible"; };
  const hideTip = ()=>{ tipEl.style.display="none"; };

  // --- Half-open Effect CSS (inject once) ---
  if (!document.getElementById("fu-effect-preview-css")) {
    const style = document.createElement("style");
    style.id = "fu-effect-preview-css";
    style.textContent = `
  /* Keep body text black, but don't touch your colored content-links */
.chat-message .message-content .fu-effect .fu-effect-inner {
  color: #000;
  text-shadow: none;
}
/* Allow your Custom CSS to recolor these links (Bolt, Fire, etc.) */
.chat-message .message-content .fu-effect .fu-effect-inner a.content-link,
.chat-message .message-content .fu-effect .fu-effect-inner a.content-link * {
  color: inherit;
  text-shadow: none;
}

  /* Body container already exists in your card */
  .fu-effect-body {
    will-change: max-height;
    max-height: 0;
    overflow: hidden;
    transition: max-height .28s ease, padding .28s ease;
    position: relative;
    padding: 0 .25rem;
    margin-top: .05rem;
  }

  /* NEW: Real child overlay (theme-safe), only when in preview mode */
  .fu-effect-body.preview .fu-fade{
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: var(--fade-height, 2.2em);
    pointer-events: none;
    z-index: 1;
    background: var(--fade-overlay,
      linear-gradient(to bottom,
        rgba(217,215,203,0) 0%,
        rgba(217,215,203,0.85) 65%,
        rgba(217,215,203,1) 100%)
    );
  }

  /* Optional hint styling (unchanged) */
  .fu-effect-hint { opacity:.7; font-size:12px; margin-left:.35rem; }
  .fu-effect[data-collapsed="false"] .fu-effect-hint { opacity:.9; }
`;
    document.head.appendChild(style);
  }

  // Delegated tooltip
  document.addEventListener("mouseover", (ev) => {
    const host = ev.target.closest?.(".fu-tip-host");
    if (!host) return;
    const html = decodeURIComponent(host.getAttribute("data-tip") || "");
    showTip(html, ev.clientX, ev.clientY);
    document.addEventListener("mousemove", mouseMoveFollower);
    function mouseMoveFollower(e){ placeTipAt(e.clientX, e.clientY); }
    host.addEventListener("mouseout", function onOut() {
      hideTip();
      document.removeEventListener("mousemove", mouseMoveFollower);
      host.removeEventListener("mouseout", onOut);
    }, { once:true });
  }, { capture:false });

  // Delegated content-link opening
  document.addEventListener("click", async (ev) => {
    const a = ev.target.closest?.("a.content-link[data-doc-uuid],a.content-link[data-uuid]");
    if (!a) return;
    ev.preventDefault(); ev.stopPropagation();
    const uuid = a.dataset.docUuid || a.dataset.uuid;
    if (!uuid) return;
    try { await Hotbar.toggleDocumentSheet(uuid); }
    catch {
      try { const doc = await fromUuid(uuid); doc?.sheet?.render(true); }
      catch { ui.notifications?.error("Could not open linked document."); }
    }
  }, { capture:false });


  Hooks.on("closeChatMessage", () => { const t=document.getElementById(TT_ID); if (t) t.style.display="none"; });
})();

return (async () => {
  // ============ read payload ============
  let AUTO = false, PAYLOAD = {};
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

  if (!PAYLOAD || !Object.keys(PAYLOAD).length) {
    return ui.notifications.error("CreateActionCard: Missing __PAYLOAD (call ActionDataFetch first).");
  }

   PAYLOAD.meta = PAYLOAD.meta || {};
  PAYLOAD.core = PAYLOAD.core || {};

  const { log: cacLog, warn: cacWarn, err: cacErr } =
    FUCompanion.createLogger(CAC_TAG, CAC_DEBUG);

  const nowMs = () => Date.now();
  const isoNow = () => new Date().toISOString();
  const makeActionRefId = (prefix = "ACT") => {
    const rnd = (foundry?.utils?.randomID?.(8))
      ?? Math.random().toString(36).slice(2, 10);
    return `${prefix}-${nowMs().toString(36)}-${rnd}`;
  };

  function ensureActionCardIdentity(payload, options = {}) {
  payload.meta = payload.meta || {};

  const preserveActionId = !!(
    options.preserveActionId === true ||
    payload?.meta?.__preserveActionId === true ||
    payload?.meta?.__actionEditorPreserveIdentity === true
  );

  const preserveActionCardId = !!(
    options.preserveActionCardId === true ||
    payload?.meta?.__preserveActionCardId === true ||
    payload?.meta?.__actionEditorPreserveIdentity === true
  );

  const preserveVersion = !!(
    options.preserveVersion === true ||
    payload?.meta?.__preserveActionCardVersion === true
  );

  const existingActionId = String(
    payload?.meta?.actionId ??
    payload?.actionId ??
    ""
  ).trim();

  const existingCardId = String(
    payload?.meta?.actionCardId ??
    payload?.actionCardId ??
    ""
  ).trim();

  const existingVersion =
    Number(payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? 0) || 0;

  const nextActionId =
    preserveActionId && existingActionId
      ? existingActionId
      : existingActionId || makeActionRefId("ACT");

  const nextActionCardId =
    preserveActionCardId && existingCardId
      ? existingCardId
      : makeActionRefId("ACARD");

  const nextVersion =
    preserveVersion
      ? Math.max(1, existingVersion || 1)
      : existingVersion + 1;

  const createdAtMs =
    Number(payload?.meta?.actionCreatedAtMs ?? payload?.actionCreatedAtMs ?? nowMs()) || nowMs();

  const createdAtIso = String(
    payload?.meta?.actionCreatedAtIso ??
    payload?.actionCreatedAtIso ??
    new Date(createdAtMs).toISOString()
  );

  const replacedCardIds = Array.isArray(payload?.meta?.replacedActionCardIds)
    ? payload.meta.replacedActionCardIds.filter(Boolean).map(String)
    : [];

  if (
    existingCardId &&
    existingCardId !== nextActionCardId &&
    !replacedCardIds.includes(existingCardId)
  ) {
    replacedCardIds.push(existingCardId);
  }

  payload.actionId = nextActionId;
  payload.actionCardId = nextActionCardId;
  payload.actionCardVersion = nextVersion;
  payload.actionCreatedAtMs = createdAtMs;
  payload.actionCreatedAtIso = createdAtIso;

  payload.meta.actionId = nextActionId;
  payload.meta.actionCardId = nextActionCardId;
  payload.meta.actionCardVersion = nextVersion;
  payload.meta.actionCreatedAtMs = createdAtMs;
  payload.meta.actionCreatedAtIso = createdAtIso;
  payload.meta.actionCardRenderedAtMs = nowMs();
  payload.meta.actionCardRenderedAtIso = isoNow();
  payload.meta.replacedActionCardIds = replacedCardIds;

  if (!payload.meta.actionCardState) {
    payload.meta.actionCardState = "pending";
  }

  if (payload?.meta?.actionCardMessageId !== undefined && payload?.meta?.actionCardMessageId !== null) {
    payload.actionCardMessageId = String(payload.meta.actionCardMessageId);
  }

  return {
    actionId: nextActionId,
    actionCardId: nextActionCardId,
    actionCardVersion: nextVersion,
    actionCreatedAtMs: createdAtMs,
    actionCreatedAtIso: createdAtIso,
    replacedActionCardIds: replacedCardIds,
    preserveActionId,
    preserveActionCardId,
    preserveVersion
  };
}

function buildActionCardFlagData(payload, messageId = null) {
  payload.meta = payload.meta || {};

  const resolvedMessageId =
    messageId ??
    payload?.meta?.actionCardMessageId ??
    payload?.actionCardMessageId ??
    null;

  if (resolvedMessageId) {
    payload.meta.actionCardMessageId = String(resolvedMessageId);
    payload.actionCardMessageId = String(resolvedMessageId);
  }

  const replacedActionCardIds = Array.from(new Set([
    ...(Array.isArray(payload?.meta?.replacedActionCardIds) ? payload.meta.replacedActionCardIds : []),
    ...(Array.isArray(payload?.replacedActionCardIds) ? payload.replacedActionCardIds : [])
  ].filter(Boolean).map(String)));

  payload.meta.replacedActionCardIds = replacedActionCardIds;

  return {
    payload,
    actionId: payload?.meta?.actionId ?? payload?.actionId ?? null,
    actionCardId: payload?.meta?.actionCardId ?? payload?.actionCardId ?? null,
    actionCardVersion: payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? null,
    actionCardMessageId: resolvedMessageId ? String(resolvedMessageId) : null,
    replacedActionCardIds,
    actionCardState: payload?.meta?.actionCardState ?? payload?.actionCardState ?? "pending",
    lastRenderedAtMs: payload?.meta?.actionCardRenderedAtMs ?? nowMs(),
    lastRenderedAtIso: payload?.meta?.actionCardRenderedAtIso ?? isoNow()
  };
}

async function saveActionCardFlagToMessage(message, payload) {
  if (!message) return { ok: false, reason: "missing_message" };

  const flagData = buildActionCardFlagData(payload, message.id);

  try {
    await message.update(
      { [`flags.${MODULE_NS}.actionCard`]: flagData },
      { render: false }
    );

    return {
      ok: true,
      messageId: message.id,
      flagData
    };
  } catch (e1) {
    try {
      await message.setFlag(MODULE_NS, "actionCard", flagData);

      return {
        ok: true,
        messageId: message.id,
        flagData,
        fallback: "setFlag"
      };
    } catch (e2) {
      cacWarn("saveActionCardFlagToMessage failed", {
        messageId: message?.id ?? null,
        updateError: String(e1?.message ?? e1),
        setFlagError: String(e2?.message ?? e2)
      });

      return {
        ok: false,
        reason: "save_flag_failed",
        updateError: String(e1?.message ?? e1),
        setFlagError: String(e2?.message ?? e2)
      };
    }
  }
}

function registerCreateActionCardRendererApi() {
  const api = {
    version: "0.1.0",

    renderActionCardHTML: async (payload, options = {}) => {
      const macro = game.macros?.getName?.("CreateActionCard") ?? null;

      if (!macro) {
        throw new Error('CreateActionCard macro not found.');
      }

      const messageId = String(
        options?.targetMessageId ??
        options?.message?.id ??
        payload?.meta?.actionCardMessageId ??
        payload?.actionCardMessageId ??
        ""
      ).trim();

      const renderPayload = foundry?.utils?.deepClone
        ? foundry.utils.deepClone(payload)
        : JSON.parse(JSON.stringify(payload ?? {}));

      renderPayload.meta = renderPayload.meta || {};
      renderPayload.meta.__actionCardRenderMode = "updateExisting";
      renderPayload.meta.__actionCardUpdateExisting = true;
      renderPayload.meta.__preserveActionCardId = true;
      renderPayload.meta.__preserveActionCardVersion = true;
      renderPayload.meta.__targetMessageId = messageId;
      renderPayload.meta.__skipReactionEmit = true;
      renderPayload.meta.__skipCriticalCutin = true;
      renderPayload.meta.__rebuiltByActionCardRebuilder = true;

      const result = await macro.execute({
        __AUTO: true,
        __PAYLOAD: renderPayload
      });

      return {
        ok: !!result?.ok,
        html: result?.html ?? result?.content ?? "",
        content: result?.content ?? result?.html ?? "",
        payload: result?.payload ?? renderPayload,
        messageId: result?.messageId ?? messageId,
        actionId: result?.actionId ?? renderPayload?.meta?.actionId ?? null,
        actionCardId: result?.actionCardId ?? renderPayload?.meta?.actionCardId ?? null,
        actionCardVersion: result?.actionCardVersion ?? renderPayload?.meta?.actionCardVersion ?? null
      };
    },

    updateExistingActionCard: async ({ payload, messageId } = {}) => {
      return await api.renderActionCardHTML(payload, {
        targetMessageId: messageId
      });
    },

    buildActionCardFlagData,
    saveActionCardFlagToMessage
  };

  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.createActionCardRenderer = api;
  globalThis.FUCompanion.api.actionCardRenderer = api;

  try {
    const mod = game.modules?.get?.(MODULE_NS);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.createActionCardRenderer = api;
      mod.api.actionCardRenderer = api;
    }
  } catch (e) {
    cacWarn("Could not register CreateActionCard renderer API.", {
      error: String(e?.message ?? e)
    });
  }

  cacLog("CreateActionCard renderer API registered.", {
    hasRenderActionCardHTML: true
  });

  return api;
}

registerCreateActionCardRendererApi();

    const renderModeRaw = String(PAYLOAD?.meta?.__actionCardRenderMode ?? "").trim().toLowerCase();

  const actionCardUpdateExisting = !!(
    renderModeRaw === "updateexisting" ||
    PAYLOAD?.meta?.__actionCardUpdateExisting === true
  );

  const actionCardTargetMessageId = String(
    PAYLOAD?.meta?.__targetMessageId ??
    PAYLOAD?.meta?.actionCardMessageId ??
    PAYLOAD?.actionCardMessageId ??
    ""
  ).trim();

const skipReactionEmit = !!(
  actionCardUpdateExisting ||
  PAYLOAD?.meta?.__skipReactionEmit === true ||
  PAYLOAD?.meta?.__suppressActionDeclarationEvents === true ||
  PAYLOAD?.meta?.__actionEditorReplacementRender === true
);

const skipCriticalCutin = !!(
  actionCardUpdateExisting ||
  PAYLOAD?.meta?.__skipCriticalCutin === true ||
  PAYLOAD?.meta?.__actionEditorReplacementRender === true
);

  const actionCardIdentity = ensureActionCardIdentity(PAYLOAD, {
  preserveActionId: !!(
    PAYLOAD?.meta?.__preserveActionId ||
    PAYLOAD?.meta?.__actionEditorPreserveIdentity ||
    actionCardUpdateExisting
  ),

  preserveActionCardId: !!(
    PAYLOAD?.meta?.__preserveActionCardId ||
    PAYLOAD?.meta?.__actionEditorPreserveIdentity ||
    actionCardUpdateExisting
  ),

  preserveVersion: !!(
    PAYLOAD?.meta?.__preserveActionCardVersion ||
    actionCardUpdateExisting
  )
});

cacLog("ACTION CARD RENDER MODE", {
  updateExisting: actionCardUpdateExisting,
  replacementRender: !!PAYLOAD?.meta?.__actionEditorReplacementRender,
  targetMessageId: actionCardTargetMessageId || null,
  actionId: actionCardIdentity.actionId,
  actionCardId: actionCardIdentity.actionCardId,
  actionCardVersion: actionCardIdentity.actionCardVersion,
  skipReactionEmit,
  skipCriticalCutin,
  suppressActionDeclarationEvents: !!PAYLOAD?.meta?.__suppressActionDeclarationEvents
});

  const passiveGuardExecutionMode = String(
    PAYLOAD?.executionMode ??
    PAYLOAD?.meta?.executionMode ??
    "manual"
  ).trim();

  const isAutoPassiveExecution =
    passiveGuardExecutionMode === "autoPassive" ||
    !!PAYLOAD?.autoPassive ||
    !!PAYLOAD?.meta?.isPassiveExecution ||
    String(PAYLOAD?.source || "") === "AutoPassive";

  if (isAutoPassiveExecution) {
    cacWarn("AUTO PASSIVE reached CreateActionCard unexpectedly. Rerouting to execution core.", {
      skillName: PAYLOAD?.core?.skillName ?? null,
      executionMode: passiveGuardExecutionMode,
      source: PAYLOAD?.source ?? null,
      targets: PAYLOAD?.originalTargetUUIDs ?? PAYLOAD?.meta?.originalTargetUUIDs ?? PAYLOAD?.targets ?? []
    });

    const execApi = globalThis.FUCompanion?.api?.actionExecution?.execute ?? null;
    if (!execApi) {
      ui.notifications?.error("CreateActionCard: Auto Passive reached card creation but Action Execution Core API was not found.");
      return cacErr("AUTO PASSIVE reroute failed: execution core missing.");
    }

    try {
      const rerouteResult = await execApi({
        actionContext: PAYLOAD,
        args: {},
        chatMsgId: null,
        executionMode: "autoPassive",
        confirmingUserId: null,
        skipVisualFeedback: false
      });

      cacLog("AUTO PASSIVE reroute result", rerouteResult);
      return rerouteResult;
    } catch (err) {
      console.error("CreateActionCard: Auto Passive reroute failed:", err);
      ui.notifications?.error("CreateActionCard: Failed to reroute Auto Passive into execution core.");
      return;
    }
  }

  const { core, meta, accuracy, advPayload } = PAYLOAD;
  const {
    attackerName, listType, isSpellish, weaponTypeLabel,
    elementType, declaresHealing, hasDamageSection,
    baseValueStrForCard, hrBonus, attackRange, ignoreHR
  } = meta;
  const { skillName, skillImg, rawEffectHTML, skillTypeRaw, weaponType } = core;

  // ============ canonical saved targets ============
  const cloneArray = (a) => Array.isArray(a) ? a.filter(Boolean).map(String) : [];

  function resolveCanonicalTargetData(payload) {
    const fromTopOriginal = cloneArray(payload?.originalTargetUUIDs);
    if (fromTopOriginal.length) {
      return { uuids: fromTopOriginal, source: "PAYLOAD.originalTargetUUIDs" };
    }

    const fromMetaOriginal = cloneArray(payload?.meta?.originalTargetUUIDs);
    if (fromMetaOriginal.length) {
      return { uuids: fromMetaOriginal, source: "PAYLOAD.meta.originalTargetUUIDs" };
    }

    const fromTopTargets = cloneArray(payload?.targets);
    if (fromTopTargets.length) {
      return { uuids: fromTopTargets, source: "PAYLOAD.targets" };
    }

    // Legacy-only fallback: preserve old passive/older pipeline behavior if no saved targets exist.
    const liveTargets = Array.from(game.user?.targets ?? [])
      .map(t => t?.document?.uuid)
      .filter(Boolean)
      .map(String);

    if (liveTargets.length) {
      return { uuids: liveTargets, source: "game.user.targets (legacy fallback)" };
    }

    return { uuids: [], source: "none" };
  }

  const canonicalTargetData = resolveCanonicalTargetData(PAYLOAD);
  const originalTargetUUIDs = canonicalTargetData.uuids;
  const originalTargetSource = canonicalTargetData.source;

  // Keep payload synchronized so downstream systems / re-renders always see the same targets.
  PAYLOAD.originalTargetUUIDs = [...originalTargetUUIDs];
  PAYLOAD.targets = [...originalTargetUUIDs];
  PAYLOAD.meta.originalTargetUUIDs = [...originalTargetUUIDs];

  const originalTargetActorUUIDs = cloneArray(
    PAYLOAD?.originalTargetActorUUIDs ??
    PAYLOAD?.meta?.originalTargetActorUUIDs ??
    []
  );
  if (originalTargetActorUUIDs.length) {
    PAYLOAD.originalTargetActorUUIDs = [...originalTargetActorUUIDs];
    PAYLOAD.meta.originalTargetActorUUIDs = [...originalTargetActorUUIDs];
  }

    // --- ONI Reaction Phase beacons: action declared / checks / targeting ---
  // Deferred so the card is posted to chat BEFORE reactor buttons appear —
  // reactors need to see the attack / accuracy details to decide. Assigned
  // inside the try below (captures the helper + payload via closure) and
  // invoked from the CREATE NEW branch after `saveActionCardFlagToMessage`.
  let __fireReactionsLater = () => {};
  try {
        if (!skipReactionEmit && globalThis.ONI?.emit) {
      const targetsFromPayload = [...originalTargetUUIDs];

      const baseReactionPayload = {
        kind: "action_declaration",
        trigger: null, // filled per-event below
        timestamp: Date.now(),

        // Who is acting (performer / source subject for SELF/ALLY/ENEMY filtering)
        attackerUuid: meta?.attackerUuid ?? advPayload?.attackerUuid ?? null,
        attackerName: attackerName ?? null,

        // Helpful fallbacks / aliases for future trigger-core subject resolution
        sourceUuid: meta?.attackerUuid ?? advPayload?.attackerUuid ?? null,
        actorUuid: PAYLOAD?.attackerActorUuid ?? meta?.attackerActorUuid ?? advPayload?.attackerActorUuid ?? null,

        // What is being used
        sourceType: meta?.sourceType ?? advPayload?.sourceType ?? null,
        listType: listType ?? null,
        elementType: elementType ?? null,
        skillName: skillName ?? null,
        skillTypeRaw: skillTypeRaw ?? null,

        // Harmful vs aid classification — used by reaction_action_intent
        // filters (Protect, Cover, Counterattack, ...) so they don't fire
        // on an ally's buff/heal targeting another ally. Computed by ADC
        // from skill_type / isOffensiveSpell / declaresHealing / damage,
        // with optional `props.action_intent` author override.
        actionIntent: meta?.actionIntent ?? null,

        // Check info
        isCheck: !!accuracy,
        hasAccuracy: !!accuracy,

        // Target info
        targets: targetsFromPayload,
        attackRange: attackRange ?? null,

        // Universal action-card identity
        actionId: actionCardIdentity.actionId,
        actionCardId: actionCardIdentity.actionCardId,
        actionCardVersion: actionCardIdentity.actionCardVersion,
        actionCardMessageId: PAYLOAD?.meta?.actionCardMessageId ?? PAYLOAD?.actionCardMessageId ?? null
      };

      // Phase R Slice 1: when the awaitable reaction substrate is loaded,
      // route GM-side emits through `openWindow` so the action-card flow
      // pauses for the reaction window (5s default, indefinite once a
      // picker opens). All same-tick emits with the same action_phase +
      // actionCardId merge into ONE window so the caller's Promise.all
      // resolves on a single 5s timer, not five sequential ones.
      //
      // Player-initiated emits keep the existing fire-and-forget
      // socket→GM path (player-side awaitable comes in a later slice).
      async function emitReactionPhaseForActionCard(payload) {
        const cleanPayload = {
          ...payload,
          requestedByUserId: game.user?.id ?? null,
          requestedByUserName: game.user?.name ?? null
        };

        if (game.user?.isGM) {
          const rs = globalThis.FUCompanion?.api?.reactionSystem;
          if (rs?.openWindow) {
            return await rs.openWindow(cleanPayload, { reason: "action_card" });
          }
          // Fallback when the substrate isn't loaded yet.
          ONI.emit("oni:reactionPhase", cleanPayload, { local: true, world: false });
          return null;
        }

        // Player path — fire-and-forget to GM. The substrate tracks per-card
        // pending sub-windows on GM and broadcasts `OniReactionCardSettled`
        // when they all close; that drives the action-card UI lock via
        // the `reactionsPending` message flag (see reaction-cardLock.js).
        const channel = `module.${MODULE_NS}`;
        if (game.socket) {
          game.socket.emit(channel, {
            type: "OniReactionPhaseRequest",
            payload: cleanPayload
          });
          console.log("[CreateActionCard] Sent OniReactionPhaseRequest to GM.", {
            trigger: cleanPayload.trigger,
            actionId: cleanPayload.actionId,
            actionCardId: cleanPayload.actionCardId,
            requestedByUserId: cleanPayload.requestedByUserId
          });
        } else {
          console.warn("[CreateActionCard] game.socket unavailable; cannot forward reaction phase to GM.", cleanPayload);
        }

        // Keep local debug visibility. Non-GM ReactionManager will ignore this.
        ONI.emit("oni:reactionPhase", cleanPayload, { local: true, world: false });
        return null;
      }

// Build the deferred emit closure. We DON'T fire anything here — the
// caller (the CREATE NEW branch below) calls __fireReactionsLater()
// AFTER ChatMessage.create so reactors see the attack/accuracy
// details on the card before deciding. Per-card pending tracking in
// reaction-window.js clears the `reactionsPending` flag (and the
// card UI lock in reaction-cardLock.js) when every sub-window settles.
__fireReactionsLater = () => {
  // Backfill actionCardMessageId now that ChatMessage.create has run
  // and PAYLOAD.meta.actionCardMessageId is populated. baseReactionPayload
  // was constructed at line ~607 BEFORE the chat message existed, so its
  // actionCardMessageId field was null up to this point. Reactors need
  // it set so chooseSkill can locate the source card to append the
  // reactor's pre-action snapshot for cascade-undo.
  const __resolvedMsgId =
    PAYLOAD?.meta?.actionCardMessageId ??
    PAYLOAD?.actionCardMessageId ??
    null;
  if (__resolvedMsgId) baseReactionPayload.actionCardMessageId = String(__resolvedMsgId);

  const reactionPromises = [];

  // 1) Trigger: "When a creature performs an action"
  reactionPromises.push(emitReactionPhaseForActionCard({
    ...baseReactionPayload,
    trigger: "creature_performs_action"
  }));

  // 2) Trigger: "When a creature performs a check"
  if (accuracy) {
    reactionPromises.push(emitReactionPhaseForActionCard({
      ...baseReactionPayload,
      trigger: "creature_performs_check"
    }));
  }

  // 3) Trigger: "When a creature gets targeted by an action"
  for (const targetUuid of targetsFromPayload) {
    reactionPromises.push(emitReactionPhaseForActionCard({
      ...baseReactionPayload,
      trigger: "creature_is_targeted",
      targetUuid
    }));
  }

  // 4) Trigger: "When a creature scores a Critical Hit" / "fumbles a Check"
  //    Both rely on the resolved accuracy result.
  const isCrit   = !!(accuracy?.isCrit   || advPayload?.isCrit);
  const isFumble = !!(accuracy?.isFumble || advPayload?.isFumble);

  if (isCrit && !isFumble) {
    reactionPromises.push(emitReactionPhaseForActionCard({
      ...baseReactionPayload,
      trigger: "creature_critical_hit",
      isCrit: true,
      isFumble: false,
      accuracyTotal: accuracy?.total ?? null
    }));
  }
  if (isFumble) {
    reactionPromises.push(emitReactionPhaseForActionCard({
      ...baseReactionPayload,
      trigger: "creature_fumbles_check",
      isCrit: false,
      isFumble: true,
      accuracyTotal: accuracy?.total ?? null
    }));
  }

  // Fire-and-forget. Don't block the macro on the 5s windows — the
  // card UI is already locked via the message flag, and the
  // substrate clears it when sub-windows settle.
  Promise.all(reactionPromises).then((results) => {
    console.log("[CreateActionCard] Reaction window settled.", {
      actionCardId: actionCardIdentity.actionCardId,
      results: results.map(r => r ? { outcome: r.outcome, reason: r.reason } : null)
    });
  }).catch((waitErr) => {
    console.warn("[CreateActionCard] Reaction promise chain threw (non-fatal):", waitErr);
  });
};
    }
  } catch (err) {
    console.warn("[CreateActionCard] ReactionPhase emit setup failed (safe to ignore for now):", err);
  }

  // --- Critical Cut-In (unchanged behavior timing) ---
  try {
    const isCritical = !!((accuracy?.isCrit || advPayload?.isCrit) && !(accuracy?.isFumble || advPayload?.isFumble));
    const attackerUuid =
      meta?.attackerUuid ||
      canvas.tokens?.controlled?.[0]?.document?.uuid ||
      game.user?.character?.getActiveTokens?.()?.[0]?.document?.uuid ||
      game.user?.character?.uuid ||
      null;

    let hasCritImage = false;
    if (attackerUuid && isCritical) {
      try {
        const doc = await fromUuid(attackerUuid);
        const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
        const img =
          actor?.system?.cut_in_critical ||
          actor?.flags?.["fabula-ultima-companion"]?.cut_in_critical ||
          actor?.getFlag?.("fabula-ultima-companion", "cut_in_critical");
        hasCritImage = !!(img && String(img).trim().length);
      } catch {}
    }

        if (!skipCriticalCutin && isCritical && attackerUuid && window.FUCompanion?.api?.cutinBroadcast) {
      const SUSPENSE_MS = 0;
      const SLIDE_IN_MS = 220;
      const HOLD_MS     = 700;
      const SLIDE_OUT_MS= 550;
      const DIM_ALPHA   = 0.55;
      if (SUSPENSE_MS > 0 && hasCritImage) await new Promise(r => setTimeout(r, SUSPENSE_MS));
      await window.FUCompanion.api.cutinBroadcast({
        tokenUuid: attackerUuid,
        type: "critical",
        delayMs: 0,
        slideInMs: SLIDE_IN_MS,
        holdMs: HOLD_MS,
        slideOutMs: SLIDE_OUT_MS,
        dimAlpha: DIM_ALPHA
      });
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.warn("CreateActionCard: critical cut-in skipped:", err);
  }

  // ============ helpers ============
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const cap = (s="") => s ? s[0].toUpperCase()+s.slice(1) : s;
  const WEAPON_ICON = { arcane:"fa-book", bow:"fa-bow-arrow", brawling:"fa-hand-fist", dagger:"fa-dagger", firearm:"fa-gun", flail:"fa-mace", heavy:"fa-hammer-war", spear:"fa-location-arrow", sword:"fa-sword", thrown:"fa-bomb", swords:"fa-swords" };
  const weaponIconHTML = (t) => `<i class="fa-solid ${WEAPON_ICON[(t||"").toLowerCase()] || "fa-sword"}" style="margin-right:.35rem;"></i>`;
  const attrIcon = (a) => {
    const cls = { DEX:"fa-person-running", INS:"fa-book", MIG:"fa-dumbbell", WLP:"fa-comment-dots" }[(a||"").toUpperCase()] || "fa-circle-question";
    return `<i class="fa-solid ${cls}"></i>`;
  };
  const UUID_MAP = {
    range: { "Melee":"JournalEntry.10LjF01NAYNKpRvn", "Ranged":"JournalEntry.Fcq1HgCEh3jxxELa" },
    element: { physical:"Item.XpKZuGo3VmT0TlTu", fire:"Item.0sFCVCoM6FRrQP2f", ice:"Item.Osq3NN3QCtiW7otU", air:"Item.imkMQLnCLaFbaS6Y", earth:"Item.ZyOMe6IkUTlBzfjw", bolt:"Item.5XAuMMbDPlLzhJLw", light:"Item.IQaK3IzvfFp4I1xB", dark:"Item.vKU8UYT6DBhgOjtE", poison:"Item.tDcCWc67Ary9nVxe" }
  };
  const uuidLink = (label, uuid) => uuid ? `<a class="content-link" draggable="true" data-uuid="${uuid}" data-doc-uuid="${uuid}">${esc(label)}</a>` : esc(label);
  const linkRangeLabel = (txt) => { const t=(txt||"").toLowerCase(); if (t.includes("melee")) return uuidLink("Melee", UUID_MAP.range.Melee); if (t.includes("ranged")||t.includes("range")) return uuidLink("Ranged", UUID_MAP.range.Ranged); return esc(txt||"—"); };
  const linkElement = (type) => uuidLink(cap((type||"physical").toLowerCase()), UUID_MAP.element[(type||"physical").toLowerCase()]);

  function resolveDisplayCost(meta = {}) {
    const rawFinal = String(
      meta?.costRawFinal ??
      meta?.costRawOverride ??
      meta?.costRaw ??
      ""
    ).trim();

    const normalized = Array.isArray(meta?.costsNormalized) ? meta.costsNormalized : [];

    const isZeroish =
      !rawFinal ||
      rawFinal === "-" ||
      /^\s*\+?\s*0(\s*[%]?\s*(?:x|\*)\s*T)?\s*[a-z]*\s*$/i.test(rawFinal);

    if (normalized.length) {
      const parts = normalized
        .map(c => {
          const req = Number(c?.req ?? 0);
          const label = String(c?.label ?? c?.type ?? "").trim();
          if (!Number.isFinite(req) || !label || req <= 0) return "";
          return `${req} ${label}`;
        })
        .filter(Boolean);

      if (parts.length) return parts.join(" + ");
    }

    if (isZeroish) return "";
    return rawFinal;
  }

function getCostTextColor(costText = "") {
  const s = String(costText || "").trim().toLowerCase();

  // Zero Power / ZP
  if (/\bzero\s*power\b|\bzp\b/.test(s)) return "#c94f2d";

  // MP / Mind Point / Mana
  if (/\bmp\b|\bmind\s*point\b|\bmana\b/.test(s)) return "#2f6fd6";

  // HP / Hit Point / Health
  if (/\bhp\b|\bhit\s*point(s)?\b|\bhealth\b/.test(s)) return "#c43d3d";

  // IP / Inventory Point
  if (/\bip\b|\binventory\s*point(s)?\b/.test(s)) return "#c9821f";

  // Fallback = your current default brown
  return "#8a4b22";
}

const actionCostText = resolveDisplayCost(meta);
const actionCostTextColor = getCostTextColor(actionCostText);

const actionCostEffectHTML = actionCostText
  ? `
    <div style="
      position:absolute;
      top:-10px;
      right:.6rem;
      z-index:3;
      pointer-events:none;
    ">
      <span style="
        display:inline-flex;
        align-items:center;
        font-size:12px;
        line-height:1;
        font-weight:500;
        color:${actionCostTextColor};
        opacity:.82;
        padding:.16rem .48rem;
        border:1px solid rgba(207,160,87,.72);
        border-radius:999px;
        background:rgb(247,236,217);
        white-space:nowrap;
        box-shadow:0 1px 2px rgba(0,0,0,.08);
      ">
        <span>${esc(actionCostText)}</span>
      </span>
    </div>
  `
  : "";

  // === defense targeting resolver (Strike vs Magic) ===
  function fuResolveDefenseTarget(meta) {
    const raw = String(
      meta?.targetDefenseType ??
      meta?.accuracyAgainst ??
      meta?.defenseKind ??
      meta?.defenseType ??
      ""
    ).trim().toLowerCase();

    const isStrike = ["def","defense","strike","phys","physical","guard","armor"].some(x => raw === x);
    const isMagic  = ["mdef","magic_defense","magicdefense","magic","mdf","res","resistance","spirit"].some(x => raw === x);

    if (isStrike) return { kind: "Strike", tip: "Strike (targets DEF)" };
    if (isMagic)  return { kind: "Magic",  tip: "Magic (targets Magic DEF)" };

    if (meta?.isSpellish) return { kind: "Magic", tip: "Magic (targets Magic DEF)" };
    return { kind: "Strike", tip: "Strike (targets DEF)" };
  }

  // ============ title + subtitle ============
  const isNormalAttack = (listType === "Attack") || ((advPayload?.sourceType || "").toLowerCase() === "weapon");
  const displayTitle   = isNormalAttack ? esc(String(skillName||"").replace(/^Attack\s*—\s*/i, "").trim() || "Attack") : esc(skillName);
  const subtitleHTML = (() => {
    if (isNormalAttack) {
      const bullets = [];
      const rangeText = linkRangeLabel(attackRange || "—");
      if (rangeText && !rangeText.includes("—")) bullets.push(rangeText);

      const wt = (weaponType || weaponTypeLabel || "").toString().trim();
      if (wt) bullets.push(`${weaponIconHTML(wt)}${esc(cap(wt))}`);

      bullets.push("Normal Attack");


      return `<div style="text-align:center; font-size:12px; color:#6b3e1e; margin:.18rem 0 .25rem;">${bullets.join(" • ")}</div><div style="border-top:1px solid #cfa057; opacity:.6; margin:.2rem auto .35rem; width:96%;"></div>`;
    } else {
      let main = isSpellish ? "Spell" : "Skill";
      let sub = "", subIcon = "";

      if (isSpellish && (listType === "Offensive Spell")) {
        sub = "Offensive";
        subIcon = `<i class="fa-solid fa-bolt" style="margin-right:.25rem;"></i>`;
      }

      if (!isSpellish) {
        const st = (skillTypeRaw || "").toLowerCase();
        if (st === "active") sub = "Active";
        else if (st === "passive") sub = "Passive";
        else if (st === "other") {
          sub = "Other";
          subIcon = `<i class="fa-solid fa-circle-notch" style="margin-right:.25rem;"></i>`;
        }
      }

      let wKey = "", wLbl = "";
      if (isSpellish) {
        wKey = "arcane";
        wLbl = "Arcane";
      } else if (weaponType && weaponType.toLowerCase() !== "none") {
        wKey = weaponType;
        wLbl = cap(weaponType);
      }

      const bullets = [];
      const rangeText = linkRangeLabel(attackRange || "—");

      if (rangeText && !rangeText.includes("—")) bullets.push(rangeText);
      if (wLbl) bullets.push(`${weaponIconHTML(wKey)}${esc(wLbl)}`);
      bullets.push(esc(main));
      if (sub) bullets.push(`${subIcon}${esc(sub)}`);

      return `<div style="text-align:center; font-size:12px; color:#6b3e1e; margin:.18rem 0 .25rem;">${bullets.join(" • ")}</div><div style="border-top:1px solid #cfa057; opacity:.6; margin:.2rem auto .35rem; width:96%;"></div>`;
    }
  })();

  // ============ targets display (saved target list, not live UI state) ============
  let targetsList = `<i>None (saved target list empty)</i>`;
  if (originalTargetUUIDs.length) {
    const parts = [];
    for (const uuid of originalTargetUUIDs) {
      try {
        const doc = await fromUuid(uuid);
        const tokenDoc = doc?.documentName === "Token" ? doc : doc?.documentName === "TokenDocument" ? doc : doc?.document ?? null;
        const name = tokenDoc?.name ?? doc?.name ?? "Unknown";
        const disp = tokenDoc?.disposition ?? tokenDoc?.document?.disposition ?? null;
        const c = disp === 1 ? "dodgerblue" : disp === -1 ? "tomato" : "khaki";
        parts.push(`<b style="color:${c}">${esc(name)}</b>`);
      } catch {
        parts.push(`<b style="color:khaki">${esc(String(uuid).slice(0, 16))}…</b>`);
      }
    }
    targetsList = parts.join(", ");
  }

  const attackerBox = `
    <fieldset style="border:1px solid #cfa057; border-radius:8px; padding:.5rem;">
      <legend style="padding:0 .5rem; color:#8a4b22;"><b>Attacker</b></legend>
      <div style="display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:.4rem; font-size:14px;">
        <div style="justify-self:start;"><b>${attackerName}</b></div>
        <div style="justify-self:center;"><i class="fa-solid fa-swords" style="opacity:.9;"></i></div>
        <div style="justify-self:end; text-align:right;">${targetsList}</div>
      </div>
    </fieldset>`;

  // ============ accuracy (tooltip hosts) ============
  let accuracyHTML = "";
  let floatBannerHTML = "";
  if (accuracy) {
    const { dA,dB,rA,rB,total,hr,isCrit,isBunny,isFumble,A1,A2,checkBonus } = accuracy;

    const tgtInfo = fuResolveDefenseTarget(meta);

    const tipDieA  = `<b>${A1}</b><br>Die: d${dA}<br>Raw: ${rA.result}<br>Result: ${rA.total}`;
    const tipDieB  = `<b>${A2}</b><br>Die: d${dB}<br>Raw: ${rB.result}<br>Result: ${rB.total}`;

    const tipTotal =
      `Targeting: <b>${tgtInfo.tip}</b><br>` +
      `${ignoreHR ? "HR: —" : `HR: ${hr ?? "—"}`}<br>` +
      `A: ${rA.total} (d${dA})<br>` +
      `B: ${rB.total} (d${dB})<br>` +
      `Bonus: ${Number(checkBonus)}<br>` +
      `Total: ${total}` +
      `${isCrit ? `<br><b style="color:#b40000;">Critical!</b>` : ""}` +
      `${isFumble ? `<br><b>Fumble!</b>` : ""}`;

    const accGlow = isCrit ? "rgba(180, 0, 0, .35)" : (isFumble ? "rgba(0, 0, 0, .30)" : "rgba(0, 0, 0, .22)");

    const isMagicKind = (tgtInfo.kind === "Magic");
    const defIconURL  = isMagicKind ? MAGIC_ICON_URL : STRIKE_ICON_URL;
    const iconSizePx  = 25;
    const defIconHTML = `
      <img src="${defIconURL}" alt="${tgtInfo.kind}" title="${tgtInfo.kind}"
           style="width:${iconSizePx}px;height:${iconSizePx}px;object-fit:contain;vertical-align:-3px;border:0;outline:0;box-shadow:none;background:transparent;">`;

    if (isCrit || isFumble) {
      const isF = !!isFumble;
      const text  = isF ? "Fumble!" : "Critical!";
      const icon  = isF ? "fa-skull" : "fa-crown";
      const color = isF ? "#e6e6e6" : "#ffd34d";
      const stroke = isF ? "1.6px rgba(38,38,38,.72)" : "1.6px rgba(90,58,18,.72)";
      const shadow = isF
        ? `0 0 26px rgba(255,255,255,.55),
           0 0 12px rgba(240,240,240,.85),
           0 2px 0 #1f1f1f,
           0 4px 0 #1f1f1f`
        : `0 0 30px rgba(255,207,64,.75),
           0 0 14px rgba(255,207,64,.85),
           0 2px 0 #5a3a12,
           0 4px 0 #5a3a12`;

      floatBannerHTML = `
        <div class="fu-crit-float" aria-hidden="true"
             style="
               position:absolute; right:-10px; bottom:-16px; z-index:7; pointer-events:none;
               background: transparent; transform: translateZ(0);
               font-size: 22px; font-weight:900; font-style:italic; letter-spacing:.6px; text-transform:uppercase;
               color:${color}; text-shadow:${shadow};
               -webkit-text-stroke: ${stroke};
               padding:.25rem .7rem; border-radius:12px;
               animation: fuCritPop .32s ease-out both;
             ">
          <i class="fa-solid ${icon}" style="margin-right:.45rem;"></i> ${text}
        </div>
        <style>
          @keyframes fuCritPop {
            0%   { transform: scale(.80); opacity:0; }
            60%  { transform: scale(1.18); opacity:1; }
            100% { transform: scale(1.02); opacity:1; }
          }
        </style>`;
    }

    accuracyHTML = `
      <div class="fu-acc-wrap" style="position:relative;">
        <fieldset style="border:1px solid #cfa057; border-radius:8px; padding:.5rem;">
          <legend style="padding:0 .5rem; color:#8a4b22;"><b>Accuracy Check</b></legend>
          <div class="fu-acc-row" style="display:flex; align-items:center; gap:.7rem; margin:.15rem 0 .1rem;">
            <span class="fu-tip-host" data-tip="${encodeURIComponent(tipDieA)}" style="display:inline-flex; align-items:center; gap:.35rem;">
              ${attrIcon(A1)} <b>${A1}</b> <b>${rA.total}</b>
            </span>
            <b>+</b>
            <span class="fu-tip-host" data-tip="${encodeURIComponent(tipDieB)}" style="display:inline-flex; align-items:center; gap:.35rem;">
              ${attrIcon(A2)} <b>${A2}</b> <b>${rB.total}</b>
            </span>
            <span style="margin-left:auto; display:inline-flex; align-items:center; gap:.4rem;">
              <span class="fu-tip-host"
                    data-tip="${encodeURIComponent(tipTotal)}"
                    style="display:inline-flex; align-items:center; gap:.35rem; font-weight:900; font-size:22px; margin-right:6px; text-shadow:0 0 6px ${accGlow}; color:#111;">
                ${defIconHTML}
                <span>${total}</span>
              </span>
            </span>
          </div>
        </fieldset>
        ${floatBannerHTML}
      </div>`;
  }

  // ============ damage / healing (tooltip hosts) ============
  let damagePreviewHTML = "";
  if (hasDamageSection) {
    const COLOR = { physical:"#111", fire:"#e25822", ice:"#5ab3d4", air:"#48c774", earth:"#8b5e3c", bolt:"#9b59b6", light:"#a38b50", dark:"#4b0082", poison:"#2e8b57",
                    heal:"#2ecc71", healing:"#2ecc71", recovery:"#2ecc71", restore:"#2ecc71", restoration:"#2ecc71" };
    const GLOW  = { physical:"rgba(0,0,0,.28)", fire:"rgba(226,88,34,.45)", ice:"rgba(90,179,212,.45)", air:"rgba(72,199,116,.45)", earth:"rgba(139,94,60,.45)", bolt:"rgba(155,89,182,.45)",
                    light:"rgba(163,139,80,.45)", dark:"rgba(75,0,130,.45)", poison:"rgba(46,139,87,.45)",
                    heal:"rgba(46,204,113,.48)", healing:"rgba(46,204,113,.48)", recovery:"rgba(46,204,113,.48)", restore:"rgba(46,204,113,.48)", restoration:"rgba(46,204,113,.48)" };

    const elemKey   = String(elementType || "physical").toLowerCase();
    const isMP      = (elemKey === "mp");
    const mpColor   = declaresHealing ? "#1e6cff" : "#c62828";
    const mpGlow    = declaresHealing ? "rgba(30,108,255,.45)" : "rgba(198,40,40,.45)";

    const dmgColor  = isMP ? mpColor : (COLOR[elemKey] || COLOR.physical);
    const glowColor = isMP ? mpGlow  : (GLOW[elemKey]  || GLOW.physical);

    const elemLabelHTML = isMP
      ? `<span style="color:${mpColor}; font-weight:900; letter-spacing:.4px;">MP</span>`
      : `<span class="fu-noicon">${linkElement(elemKey)}</span>`;

    const showHRPill = (!declaresHealing && !ignoreHR && (Number(hrBonus)||0) > 0);
    const hrPill = showHRPill ? `<span style="margin-left:.45rem; font-size:11px; font-weight:800; padding:.05rem .4rem; border-radius:999px; border:1px solid #cfa057; color:#8a4b22; background:#f7ecd9;">+HR</span>` : "";

    const _bonus = Number(advPayload?.bonus ?? 0) || 0;
    const _reduction = Number(advPayload?.reduction ?? 0) || 0;
    const _mult = Number(advPayload?.multiplier ?? 100) || 100;

    const _baseDamage = Number(baseValueStrForCard) || 0;
    const _baseHeal = Number(String(advPayload?.baseValue ?? "0").replace("+", "")) || 0;
    const _base = declaresHealing ? _baseHeal : _baseDamage;

    const finalForCard = Math.max(
      0,
      Math.floor((_base + _bonus - _reduction) * (_mult / 100))
    );

    const tipHTML = `
      <div style='min-width:220px'>
        <b>${declaresHealing ? "Healing Preview" : "Damage Preview"}</b><br>
        Base Value: ${declaresHealing ? (advPayload.baseValue || "+0").toString().replace("+","") : (Number(baseValueStrForCard) - (ignoreHR ? 0 : (Number(hrBonus)||0)))}<br>
        ${declaresHealing ? "HR: —" : (ignoreHR ? "HR: —" : `HR: ${accuracy?.hr ?? "—"}`)}<br>
        Bonus: ${advPayload.bonus}<br>
        Reduction: ${advPayload.reduction}<br>
        Multiplier: ${advPayload.multiplier}%<br>
        Element: ${elementType}<br>
        Weapon: ${weaponType || "—"}<br>
        ${accuracy?.isCrit ? "<b style='color:#ffb3b3;'>Critical</b><br>" : ""}
        ${accuracy?.isFumble ? "<b>Fumble</b><br>" : ""}
        <i>Final result may vary per target defenses.</i>
      </div>`;

    damagePreviewHTML = `
      <fieldset style="border:1px solid #cfa057; border-radius:8px; padding:.6rem;">
        <legend style="padding:0 .5rem; color:#8a4b22;"><b>${declaresHealing ? "Healing" : "Damage"}</b></legend>
        <style>.fu-noicon .content-link::before{content:none !important; margin:0 !important;}</style>
        <div class="fu-dmg-row" style="display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:.5rem;">
          <div style="font-weight:800;">${declaresHealing ? "Heal" : "Damage"}</div>
          <div style="text-align:left;">
<span class="fu-action-rollnum fu-tip-host"
      data-final="${finalForCard}"
      data-fu-roll-key="${esc(`${actionCardIdentity.actionCardId}:damage-preview:${finalForCard}`)}"
      data-fu-roll-scope="action-preview"
      data-tip="${encodeURIComponent(tipHTML)}"
      style="font-size:32px; font-weight:900; font-style:italic; color:${dmgColor}; text-shadow:0 0 15px ${glowColor}; margin-left:2.9rem; will-change: contents;">
  ${finalForCard}
</span>${hrPill}
          </div>
          <div style="justify-self:end; font-size:18px; font-weight:800;">
            ${elemLabelHTML}
          </div>
        </div>
      </fieldset>`;
  }

  // ============ effect (collapsible) ============
  const hasEffect = !!String(rawEffectHTML ?? "").trim();
const effectHTML = !hasEffect ? "" : `
  <fieldset class="fu-effect" data-collapsed="true"
    style="
      position:relative;
      border:1px solid #cfa057;
      border-radius:8px;
      padding:.35rem .5rem;
      margin-top:.45rem;
      cursor:pointer;
      user-select:none;
    ">
    <legend style="padding:0 .5rem; color:#8a4b22;">
      <b>Effect</b>
      <span class="fu-effect-hint" style="opacity:.7; font-size:12px; margin-left:.35rem;">(click to expand)</span>
    </legend>

    ${actionCostEffectHTML}

    <div class="fu-effect-body"
         style="position:relative; overflow:hidden; max-height:0; transition:max-height .25s ease, padding .25s ease; padding:0 .25rem;">
      <div class="fu-effect-inner" style="font-size:13px; line-height:1.35; color:#000; text-shadow:none;">
        ${rawEffectHTML}
      </div>

      <div class="fu-fade" aria-hidden="true"
           style="
             position:absolute; left:0; right:0; bottom:0;
             z-index:1; pointer-events:none; display:none;
             height:32px;
             background:transparent;
           "></div>
    </div>
  </fieldset>`;

  // ============ buttons row ============
  const confirmBtnHTML = `
    <button type="button" class="fu-confirm btn" data-fu-confirm
            data-original-targets="${encodeURIComponent(JSON.stringify(originalTargetUUIDs))}"
            data-fu-args='${esc(JSON.stringify({
              advMacroName: ADV_MACRO_NAME,
              missMacroName: MISS_MACRO_NAME,
              advPayload,
              elementType: (meta?.elementType ?? "physical"),
              isSpellish: !!meta?.isSpellish,

              hasAccuracy: !!accuracy,
              accuracyTotal: (accuracy && Number.isFinite(Number(accuracy.total))) ? Number(accuracy.total) : null,

              autoHit: !!(
              (accuracy?.isCrit || advPayload?.autoHit) &&
              !(accuracy?.isFumble || accuracy?.forceMiss || advPayload?.isFumble || advPayload?.forceMiss)
              ),

              forceMiss: !!(
              accuracy?.forceMiss ||
              accuracy?.isFumble ||
              advPayload?.forceMiss ||
              advPayload?.isFumble ||
              meta?.forceMiss
              ),

              weaponType: core?.weaponType || "",
              attackRange: meta?.attackRange ?? (meta?.listType?.match(/Range/i) ? "Range" : "Melee"),
              attackerName: meta?.attackerName ?? "Unknown",
              aeMacroName: "ApplyActiveEffect",
              aeDirectives: meta?.activeEffects ?? [],
              attackerUuid: meta?.attackerUuid ?? null,
              originalTargetUUIDs,
              originalTargetActorUUIDs,

              actionContext: PAYLOAD,

              actionId: actionCardIdentity.actionId,
              actionCardId: actionCardIdentity.actionCardId,
              actionCardVersion: actionCardIdentity.actionCardVersion,
              actionCardMessageId: PAYLOAD?.meta?.actionCardMessageId ?? PAYLOAD?.actionCardMessageId ?? null,

              hasDamageSection: !!hasDamageSection
            }))}'
            style="flex:0 0 auto; padding:.35rem .6rem; border-radius:8px; border:1px solid #9a6a2a; background:#e2b86b; color:#4a2a10; font-weight:800;">
       Confirm
    </button>`;

// Fumble lock:
// In Fabula, Invoke Trait / Invoke Bond cannot be used to reroll or modify a Fumble.
// Instead of hiding the buttons, show them as visibly locked.
const isFumbleAction = !!(
  accuracy?.isFumble === true ||
  advPayload?.isFumble === true ||
  PAYLOAD?.meta?.isFumble === true ||
  PAYLOAD?.meta?.invokeLockedByFumble === true
);

PAYLOAD.meta.invokeLockedByFumble = isFumbleAction;

function buildInvokeButtonHTML({
  kind = "trait",
  icon = "🎭",
  label = "Invoke Trait",
  normalTitle = "Invoke Trait",
  lockedTitle = "Locked: Invoke cannot be used on a Fumble."
} = {}) {
  const dataAttr = kind === "bond" ? "data-fu-bond" : "data-fu-trait";

  const lockedAttrs = isFumbleAction
    ? `data-fu-invoke-locked="fumble" aria-disabled="true"`
    : `data-fu-invoke-locked="0" aria-disabled="false"`;

  const title = isFumbleAction ? lockedTitle : normalTitle;

  const baseStyle = `
    flex:0 0 auto;
    position:relative;
    overflow:hidden;
    padding:.35rem .6rem;
    border-radius:8px;
    border:1px solid #cfa057;
    background:#f7ecd9;
    color:#8a4b22;
    font-weight:700;
  `;

const lockedStyle = isFumbleAction ? `
  opacity:1;
  filter:grayscale(1) saturate(.15);
  cursor:not-allowed;
  border-color:#080808;
  background:linear-gradient(180deg, #2a2a2a 0%, #141414 100%);
  color:#d8d8d8;
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.06),
    inset 0 2px 4px rgba(255,255,255,.04),
    inset 0 -3px 8px rgba(0,0,0,.55),
    0 1px 2px rgba(0,0,0,.35);
` : "";

  const lockOverlay = isFumbleAction ? `
    <span class="fu-invoke-lock-overlay"
          aria-hidden="true"
          style="
            position:absolute;
            inset:0;
            display:flex;
            align-items:center;
            justify-content:center;
            background:rgba(0,0,0,.48);
            color:#f2f2f2;
            font-size:16px;
            text-shadow:0 1px 3px rgba(0,0,0,.75);
            pointer-events:none;
          ">
      <i class="fa-solid fa-lock"></i>
    </span>
  ` : "";

  return `
    <button type="button"
            class="fu-btn ${isFumbleAction ? "fu-invoke-locked" : ""}"
            ${dataAttr}
            ${lockedAttrs}
            title="${esc(title)}"
            style="${baseStyle} ${lockedStyle}">
      <span style="${isFumbleAction ? "visibility:hidden;" : ""}">${icon} ${esc(label)}</span>
      ${lockOverlay}
    </button>`;
}

const invokeTraitBtnHTML = buildInvokeButtonHTML({
  kind: "trait",
  icon: "🎭",
  label: "Invoke Trait",
  normalTitle: "Invoke Trait (reroll up to two accuracy dice)",
  lockedTitle: "Locked: Invoke Trait cannot be used on a Fumble."
});

const invokeBondBtnHTML = buildInvokeButtonHTML({
  kind: "bond",
  icon: "🤝",
  label: "Invoke Bond",
  normalTitle: "Invoke Bond (add your Bond bonus)",
  lockedTitle: "Locked: Invoke Bond cannot be used on a Fumble."
});

  // ============ card HTML ============
  const titleIconHTML = skillImg ? `<img src="${skillImg}" alt="" style="width:28px;height:28px; object-fit:cover; border-radius:4px; box-shadow: 0 1px 0 rgba(0,0,0,.2), inset 0 0 0 1px rgba(0,0,0,.25); margin-right:.35rem; vertical-align:-3px;">` : "";
  const editBtnHTML = `
    <button type="button" data-fu-edit data-gm-only
            title="Edit Action Card"
            style="
              display:inline-flex; align-items:center; justify-content:center;
              width:28px; height:28px; padding:0; margin:0;
              border-radius:6px; border:1px solid rgba(207,160,87,.9);
              background:rgba(247,236,217,.85);
              box-shadow: 0 1px 0 rgba(0,0,0,.18);
              cursor:pointer; user-select:none;
              font-size:16px; line-height:1;
            ">✏️</button>`;

  // Undo button — GM-only, sits next to the Edit pencil. Reverts the
  // action card's consumption side-effects when the GM ran something by
  // mistake (wrong skill, mistargeted, etc.). For pending cards (not yet
  // confirmed) it's a clean delete; for resolved cards it restores the
  // caster's pre-confirm state from the snapshot captured at confirm
  // time, then cascade-deletes downstream damage cards. Handler lives
  // in scripts/action-system/action-card-undo.js.
  const undoBtnHTML = `
    <button type="button" data-fu-undo data-gm-only
            title="Undo Action Card"
            style="
              display:inline-flex; align-items:center; justify-content:center;
              width:28px; height:28px; padding:0; margin:0;
              border-radius:6px; border:1px solid rgba(192,86,86,.9);
              background:rgba(247,224,224,.85);
              box-shadow: 0 1px 0 rgba(0,0,0,.18);
              cursor:pointer; user-select:none;
              font-size:16px; line-height:1;
            ">↶</button>`;

  const cardHTML = `
    <div class="fu-card"
         data-fu-action-id="${esc(actionCardIdentity.actionId)}"
         data-fu-action-card-id="${esc(actionCardIdentity.actionCardId)}"
         data-fu-action-card-version="${esc(String(actionCardIdentity.actionCardVersion))}"
         style="font-family: Signika, sans-serif; letter-spacing:.2px; position:relative; overflow:hidden; border-radius:10px;">
      <div class="fu-body">
<h1 style="
  font-family: Signika, sans-serif;
  letter-spacing:.5px;
  color:#8a4b22;
  text-align:center;
  border-bottom:3px solid #cfa057;
  padding-bottom:.15rem;
  margin:.25rem 0 .1rem;
">
  <div style="display:flex; flex-direction:column; gap:.25rem; align-items:flex-start;">
    <div class="fu-card-controls" style="display:inline-flex; align-items:center; gap:.35rem;">
      ${editBtnHTML}
      ${undoBtnHTML}
    </div>
    <span style="display:inline-flex; align-items:center; gap:.35rem;">
      ${titleIconHTML}
      <span>${displayTitle}</span>
    </span>
  </div>
</h1>
<div style="text-align:center; font-size:12px; color:#6b3e1e; margin:.18rem 0 .25rem;">${subtitleHTML ? subtitleHTML : ""}</div>
${attackerBox}
        ${accuracyHTML}
        ${damagePreviewHTML}
        ${effectHTML}
        <div class="fu-btns" style="display:flex; align-items:center; gap:.5rem; margin-top:.5rem; flex-wrap:wrap;">
          ${confirmBtnHTML}
          ${invokeTraitBtnHTML}
          ${invokeBondBtnHTML}
        </div>
        <div style="margin-top:.35rem; opacity:.7; font-size:12px;">
          This card will apply to the <b>original targets saved on creation</b>.
        </div>
      </div>
    </div>`;

        // ============ post / update & after-post light wiring ============
  let posted = null;

  if (actionCardUpdateExisting) {
    posted = game.messages?.get?.(actionCardTargetMessageId) ?? null;

    if (!posted) {
      cacWarn("UPDATE EXISTING failed: target ChatMessage not found.", {
        targetMessageId: actionCardTargetMessageId,
        actionId: actionCardIdentity.actionId,
        actionCardId: actionCardIdentity.actionCardId
      });

      ui.notifications?.warn?.("CreateActionCard: could not find existing Action Card message to update.");

      return {
        ok: false,
        reason: "target_message_not_found",
        actionId: actionCardIdentity.actionId,
        actionCardId: actionCardIdentity.actionCardId,
        actionCardVersion: actionCardIdentity.actionCardVersion,
        targetMessageId: actionCardTargetMessageId || null
      };
    }

    PAYLOAD.meta.actionCardMessageId = String(posted.id);
    PAYLOAD.actionCardMessageId = String(posted.id);

    const flagData = buildActionCardFlagData(PAYLOAD, posted.id);

    // PRESERVE custom flag fields across rebuild. buildActionCardFlagData
    // constructs the flag from scratch (canonical keys: actionCardId,
    // actionCardVersion, payload, etc.) and a wholesale flag replacement
    // would wipe any custom keys other code stamps onto this namespace
    // — most notably `reactionsFiredOnThisCard` (the per-reactor undo
    // snapshots written by reaction-chooseSkill) and `refundSnapshot`
    // (the per-card undo snapshot written by applyDamage-button at
    // confirm time). Read the existing flag, copy any non-canonical
    // keys onto the rebuilt flagData, then write the merged result.
    const existingFlag = (typeof posted.getFlag === "function")
      ? (posted.getFlag(MODULE_NS, "actionCard") ?? {})
      : (posted?.flags?.[MODULE_NS]?.actionCard ?? {});
    if (existingFlag && typeof existingFlag === "object") {
      const CANONICAL_KEYS = new Set([
        "actionId", "actionCardId", "actionCardVersion", "actionCardMessageId",
        "replacedActionCardIds", "actionCardState",
        "lastRenderedAtMs", "lastRenderedAtIso",
        "payload"
      ]);
      for (const k of Object.keys(existingFlag)) {
        if (CANONICAL_KEYS.has(k)) continue;
        if (flagData[k] !== undefined) continue; // never overwrite a fresh canonical write
        flagData[k] = existingFlag[k];
      }
    }

    await posted.update({
      content: cardHTML,
      [`flags.${MODULE_NS}.actionCard`]: flagData
    });

    cacLog("UPDATED EXISTING ACTION CARD", {
      messageId: posted.id,
      actionId: actionCardIdentity.actionId,
      actionCardId: actionCardIdentity.actionCardId,
      actionCardVersion: actionCardIdentity.actionCardVersion,
      preservedCustomKeys: Object.keys(existingFlag ?? {}).filter(k => flagData[k] !== undefined && !["actionId","actionCardId","actionCardVersion","actionCardMessageId","replacedActionCardIds","actionCardState","lastRenderedAtMs","lastRenderedAtIso","payload"].includes(k))
    });
  } else {
    const speaker = ChatMessage.getSpeaker();
    posted = await ChatMessage.create({
      user: game.userId,
      speaker,
      content: cardHTML
    });

    PAYLOAD.meta.actionCardMessageId = posted?.id ? String(posted.id) : null;
    PAYLOAD.actionCardMessageId = PAYLOAD.meta.actionCardMessageId;

    await saveActionCardFlagToMessage(posted, PAYLOAD);

    cacLog("CREATED NEW ACTION CARD", {
      messageId: posted?.id ?? null,
      actionId: actionCardIdentity.actionId,
      actionCardId: actionCardIdentity.actionCardId,
      actionCardVersion: actionCardIdentity.actionCardVersion
    });

    // Stamp the card UI lock. reaction-cardLock.js disables action-card
    // buttons (Apply Damage etc.) while this flag is true; the
    // per-card pending tracker in reaction-window.js clears it once
    // every reactor sub-window for this actionCardId settles.
    if (posted && !skipReactionEmit) {
      try {
        await posted.update({
          [`flags.${MODULE_NS}.actionCard.reactionsPending`]: true
        });
      } catch (lockErr) {
        console.warn("[CreateActionCard] Could not stamp reactionsPending flag:", lockErr);
      }

      // Safety: if the substrate never clears the flag (e.g. GM
      // disconnects, openWindow throws, etc.) force-clear after 60s
      // so the card isn't permanently locked.
      const lockSafetyId = setTimeout(async () => {
        try {
          const msg = game.messages?.get?.(posted.id);
          if (!msg) return;
          const flag = msg.getFlag?.(MODULE_NS, "actionCard");
          if (flag?.reactionsPending) {
            console.warn("[CreateActionCard] reactionsPending safety timeout — force-clearing.", {
              actionCardId: actionCardIdentity.actionCardId
            });
            await msg.update({ [`flags.${MODULE_NS}.actionCard.reactionsPending`]: false });
          }
        } catch (_) {}
      }, 60000);
      try { lockSafetyId.unref?.(); } catch (_) {}

      // Now that the card is live in chat AND the lock is set, fire
      // the reaction triggers. Reactor buttons appear with the card
      // already visible — reactors can read the attack/accuracy
      // details before deciding.
      //
      // Wrap the batch in beginCardEmit / endCardEmit so the per-card
      // pending counter stays >0 while we're still STARTING openWindow
      // calls — without the guard, the first no-reactor emit
      // decrements to zero and prematurely fires cardSettled (clearing
      // the lock) before the reactor-bearing emit even reaches its
      // async pause.
      const __rsForLock = globalThis.FUCompanion?.api?.reactionSystem;
      if (__rsForLock?.beginCardEmit) {
        try { __rsForLock.beginCardEmit(actionCardIdentity.actionCardId); }
        catch (e) { console.warn("[CreateActionCard] beginCardEmit threw:", e); }
      }
      try {
        __fireReactionsLater();
      } catch (e) {
        console.warn("[CreateActionCard] __fireReactionsLater threw:", e);
      } finally {
        if (__rsForLock?.endCardEmit) {
          try { __rsForLock.endCardEmit(actionCardIdentity.actionCardId); }
          catch (e) { console.warn("[CreateActionCard] endCardEmit threw:", e); }
        }
      }
    }

    // Phase R Slice 1 (#3): the action menu floats over the active
    // combatant until they pick a skill. Once the action card is live in
    // chat the menu is just visual noise — the player's intent has
    // already been committed to the card, and the next user-input is the
    // Confirm button on the card itself. Hide locally + broadcast so the
    // active combatant's client (which may not be `this` client when the
    // GM creates a card for a player's PC) drops the menu too.
    try {
      const uiPayload = { sceneId: canvas.scene?.id ?? null };
      const SOCKET_CHANNEL = `module.${MODULE_NS}`;
      try { game.socket?.emit?.(SOCKET_CHANNEL, { type: "ONI_TURNUI_HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}
      try { game.socket?.emit?.("world", { _oniTurnUI: "HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}
      try { globalThis.TurnUI?.hideUIForAnimation?.(uiPayload); } catch {}
    } catch (hideErr) {
      console.warn("[CreateActionCard] Could not hide action menu after card creation (non-fatal):", hideErr);
    }
  }

    // Dedicated Action Card preview roll system.
  // This intentionally uses .fu-action-rollnum, NOT .fu-rollnum.
  // Damage Cards still use .fu-rollnum.
  const FU_ACTION_PREVIEW_ROLL_MEMORY =
    globalThis.__fuActionPreviewRollMemory ??= new Map();

  const FU_ACTION_PREVIEW_ROLL_TTL_MS = 10 * 60 * 1000;

  function cleanupActionPreviewRollMemory() {
    const now = Date.now();

    for (const [key, value] of FU_ACTION_PREVIEW_ROLL_MEMORY.entries()) {
      const t = Number(value?.time ?? value ?? 0);
      if (now - t > FU_ACTION_PREVIEW_ROLL_TTL_MS) {
        FU_ACTION_PREVIEW_ROLL_MEMORY.delete(key);
      }
    }
  }

  function getActionPreviewRollKey(el) {
    const explicit = String(el?.dataset?.fuRollKey ?? "").trim();
    if (explicit) return `explicit::${explicit}`;

    const card = el?.closest?.("[data-fu-action-card-id], [data-fu-action-id]");
    const actionCardId = String(card?.dataset?.fuActionCardId ?? "").trim();
    const actionId = String(card?.dataset?.fuActionId ?? "").trim();
    const final = String(el?.dataset?.final ?? el?.textContent ?? "0").trim();

    if (actionCardId) return `action-card::${actionCardId}::damage-preview::${final}`;
    if (actionId) return `action::${actionId}::damage-preview::${final}`;

    return `unknown::damage-preview::${final}`;
  }

  function formatActionPreviewNumber(n) {
    return Number(n).toLocaleString?.() ?? String(n);
  }

  function setActionPreviewRollFinal(el) {
    if (!el) return;

    const final = Number(el.dataset.final || "0");
    if (Number.isFinite(final)) {
      el.textContent = formatActionPreviewNumber(final);
    }
  }

  function animateActionPreviewRoll(el) {
    if (!el) return;

    cleanupActionPreviewRollMemory();

    const key = getActionPreviewRollKey(el);
    const final = Number(el.dataset.final || "0");

    if (!Number.isFinite(final) || final <= 0) {
      setActionPreviewRollFinal(el);
      return;
    }

    // Already animated before: snap to final, do not replay.
    if (FU_ACTION_PREVIEW_ROLL_MEMORY.has(key)) {
      setActionPreviewRollFinal(el);

      return;
    }

    // Mark BEFORE animation starts.
    // This protects against re-render during the animation.
    FU_ACTION_PREVIEW_ROLL_MEMORY.set(key, {
      time: Date.now(),
      final
    });

    const start = Math.min(1, final > 0 ? 1 : 0);
    const duration = 800;
    const t0 = performance.now();

    function easeOutCubicLocal(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    function clampLocal(n, a, b) {
      return Math.min(Math.max(n, a), b);
    }

    function frame(now) {
      // If Foundry removed/replaced this DOM node, stop animating this old node.
      if (!el.isConnected) return;

      const p = clampLocal((now - t0) / duration, 0, 1);
      const value = Math.max(
        start,
        Math.floor(start + (final - start) * easeOutCubicLocal(p))
      );

      el.textContent = formatActionPreviewNumber(value);

      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        setActionPreviewRollFinal(el);
      }
    }

    requestAnimationFrame(frame);
  }

  function initActionPreviewRolls(root) {
    const rolls = Array.from(root?.querySelectorAll?.(".fu-action-rollnum") ?? []);

    for (const el of rolls) {
      animateActionPreviewRoll(el);
    }
  }

// Keep only one render hook per Action Card message.
// This prevents stacked render hooks if the same card is rebuilt/updated.
globalThis.__fuActionCardRenderHooks = globalThis.__fuActionCardRenderHooks || new Map();

const oldRenderHook = globalThis.__fuActionCardRenderHooks.get(String(posted.id));
if (oldRenderHook) {
  try {
    Hooks.off("renderChatMessage", oldRenderHook);
  } catch (_e) {}
}

const fuCardInit = async function fuCardInit(chatMsg, htmlEl) {
  if (chatMsg.id !== posted.id) return;

  const root = htmlEl?.[0];
  if (!root) return;

  if (root.dataset.fuPrepped === "1") return;

  root.dataset.fuPrepped = "1";

  // Action Card damage preview roll-up.
  // Uses .fu-action-rollnum so it cannot be picked up by old .fu-rollnum observers.
  initActionPreviewRolls(root);

    if (!game.user?.isGM) {
      root.querySelectorAll("[data-gm-only]").forEach(el => { el.style.display = "none"; });
    }

    const confirmBtn = root.querySelector("[data-fu-confirm]");
        if (confirmBtn?.dataset?.fuArgs) {
      try {
        const cur = JSON.parse(confirmBtn.dataset.fuArgs);
        cur.chatMsgId = chatMsg.id;
        cur.actionCardMessageId = chatMsg.id;
        cur.actionId = PAYLOAD?.meta?.actionId ?? PAYLOAD?.actionId ?? null;
        cur.actionCardId = PAYLOAD?.meta?.actionCardId ?? PAYLOAD?.actionCardId ?? null;
        cur.actionCardVersion = PAYLOAD?.meta?.actionCardVersion ?? PAYLOAD?.actionCardVersion ?? null;
        confirmBtn.dataset.fuArgs = JSON.stringify(cur);
      } catch {}
    }

   // --- INIT: Half-open preview for this card's Effect body ---
try {
  const eff = root.querySelector(".fu-effect");

  // Some Action Cards do not have an Effect section. That is normal.
  // In that case, do nothing and do not print an error.
  if (!eff) {
    // No Effect section on this card. This is normal.
  } else {
    const body  = eff.querySelector(".fu-effect-body");
    const inner = eff.querySelector(".fu-effect-inner");
    const hint  = eff.querySelector(".fu-effect-hint");
    const fade  = eff.querySelector(".fu-fade");

    if (!body || !inner || !fade) {
      throw new Error("Effect DOM incomplete");
    }

    const PREVIEW_LINES = 8;
      const cs = getComputedStyle(inner);
      const lineH = parseFloat(cs.lineHeight) || 16;
      const padT  = parseFloat(cs.paddingTop) || 0;
      const padB  = parseFloat(cs.paddingBottom) || 0;
      const previewPx = Math.round(lineH * PREVIEW_LINES + padT + padB);

      const msgContent = root.querySelector(".message-content") || root;
      let bg = getComputedStyle(msgContent).backgroundColor || "rgb(217, 215, 203)";
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "rgb(217, 215, 203)";

      const toRgba = (alpha) => {
        const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/i);
        if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
        const hex = bg.match(/^#([0-9a-f]{6})$/i);
        if (hex) {
          const r = parseInt(hex[1].slice(0,2),16),
                g = parseInt(hex[1].slice(2,4),16),
                b = parseInt(hex[1].slice(4,6),16);
          return `rgba(${r},${g},${b},${alpha})`;
        }
        return `rgba(217,215,203,${alpha})`;
      };

      const fadeOverlay = `linear-gradient(to bottom,
        ${toRgba(0)} 0%,
        ${toRgba(0.85)} 65%,
        ${toRgba(1)} 100%)`;
      const fadeHeight = Math.round(lineH * 2);

      eff.dataset.collapsed = "true";
      body.style.maxHeight = `${previewPx}px`;
      body.style.paddingTop = "0";
      body.style.paddingBottom = "0";
      body.classList.add("preview");
      body.dataset.previewPx = String(previewPx);

      fade.style.display = "block";
      fade.style.height = `${fadeHeight}px`;
      fade.style.background = fadeOverlay;

      if (hint) hint.textContent = "(click to expand)";
  }
    } catch (e) {
      console.warn("Effect preview init failed:", e);
    }

           // --- Keep payload synchronized locally, but DO NOT write flags here. ---
    //
    // Important:
    // renderChatMessage can be called many times whenever Foundry updates flags.
    // If this hook writes chatMsg.update(...) or chatMsg.setFlag(...), it can
    // trigger another renderChatMessage, which recreates the Action Card DOM and
    // can replay the roll-up animation.
    PAYLOAD.meta.actionCardMessageId = chatMsg?.id
      ? String(chatMsg.id)
      : (PAYLOAD?.meta?.actionCardMessageId ?? null);

    PAYLOAD.actionCardMessageId = PAYLOAD.meta.actionCardMessageId;

    };

globalThis.__fuActionCardRenderHooks.set(String(posted.id), fuCardInit);
Hooks.on("renderChatMessage", fuCardInit);

    cacLog("Posted with canonical targets:", {
    count: originalTargetUUIDs.length,
    source: originalTargetSource,
    targets: originalTargetUUIDs,
    actionId: PAYLOAD?.meta?.actionId ?? null,
    actionCardId: PAYLOAD?.meta?.actionCardId ?? null,
    actionCardVersion: PAYLOAD?.meta?.actionCardVersion ?? null,
    actionCardMessageId: PAYLOAD?.meta?.actionCardMessageId ?? null
  });
    return {
    ok: true,
    updatedExisting: !!actionCardUpdateExisting,
    createdNew: !actionCardUpdateExisting,
    messageId: posted?.id ?? null,
    chatMsgId: posted?.id ?? null,
    actionId: actionCardIdentity.actionId,
    actionCardId: actionCardIdentity.actionCardId,
    actionCardVersion: actionCardIdentity.actionCardVersion,
    actionCardMessageId: posted?.id ?? null,
    content: cardHTML,
    html: cardHTML,
    payload: PAYLOAD
  };
})();
