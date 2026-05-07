// ============================================================================
// actionCard-Rebuilder.js
// Foundry V12
// -----------------------------------------------------------------------------
// Purpose:
//   Rebuild / refresh an existing Action Card chat message after Action Editor
//   changes the saved Action Card payload.
//
// Depends on:
//   - actionEditor-CardFinder.js
//   - actionEditor-API.js is optional but recommended
//
// Important:
//   This script is a bridge layer.
//
//   Right now it can:
//     1) Save/sync the edited payload back into the ChatMessage flag.
//     2) Update confirm-button data if it can find it.
//     3) Add/update a small "Edited" badge on the existing card.
//
//   After we patch CreateActionCard.js next, this script can call the proper
//   CreateActionCard renderer/update mode and fully replace the card HTML.
//
// Why this is separate:
//   ActionEditor edits data.
//   ActionCardRebuilder updates the visible card.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  // =========================================================
  // DEBUG TOGGLE
  // =========================================================
  const ACTION_CARD_REBUILDER_DEBUG = true;

  const TAG = "[ONI][ActionCard][Rebuilder]";
  const API_VERSION = "0.1.0";

  const log = (...a) => {
    if (ACTION_CARD_REBUILDER_DEBUG) console.log(TAG, ...a);
  };

  const warn = (...a) => {
    if (ACTION_CARD_REBUILDER_DEBUG) console.warn(TAG, ...a);
  };

  const err = (...a) => {
    if (ACTION_CARD_REBUILDER_DEBUG) console.error(TAG, ...a);
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

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function bool(v, fallback = false) {
    if (v === true || v === "true" || v === 1 || v === "1") return true;
    if (v === false || v === "false" || v === 0 || v === "0") return false;
    return fallback;
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

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m]));
  }

  function nowMs() {
    return Date.now();
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function cap(s = "") {
    const t = String(s ?? "");
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  }

  function safeJsonParse(raw, fallback = null) {
    try {
      if (raw === null || raw === undefined) return fallback;
      let s = String(raw);
      try {
        s = decodeURIComponent(s);
      } catch {}
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  }

  function encodeDataJson(obj) {
    try {
      return encodeURIComponent(JSON.stringify(obj ?? {}));
    } catch {
      return encodeURIComponent("{}");
    }
  }

  function getCanonicalTargets(payload = {}) {
    return uniq(
      Array.isArray(payload?.originalTargetUUIDs) && payload.originalTargetUUIDs.length
        ? payload.originalTargetUUIDs
        : Array.isArray(payload?.meta?.originalTargetUUIDs) && payload.meta.originalTargetUUIDs.length
          ? payload.meta.originalTargetUUIDs
          : Array.isArray(payload?.targets)
            ? payload.targets
            : []
    );
  }

  function getCanonicalTargetActors(payload = {}) {
    return uniq(
      Array.isArray(payload?.originalTargetActorUUIDs) && payload.originalTargetActorUUIDs.length
        ? payload.originalTargetActorUUIDs
        : Array.isArray(payload?.meta?.originalTargetActorUUIDs)
          ? payload.meta.originalTargetActorUUIDs
          : []
    );
  }

  function compactPayloadPreview(payload = {}) {
    return {
      actionId: payload?.meta?.actionId ?? payload?.actionId ?? null,
      actionCardId: payload?.meta?.actionCardId ?? payload?.actionCardId ?? null,
      actionCardVersion: payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? null,
      actionCardMessageId: payload?.meta?.actionCardMessageId ?? payload?.actionCardMessageId ?? null,
      state: payload?.meta?.actionCardState ?? payload?.actionCardState ?? "pending",

      skillName:
        payload?.core?.skillName ??
        payload?.dataCore?.skillName ??
        payload?.meta?.skillName ??
        null,

      attackerUuid:
        payload?.meta?.attackerUuid ??
        payload?.attackerUuid ??
        payload?.attackerActorUuid ??
        null,

      elementType:
        payload?.meta?.elementType ??
        payload?.advPayload?.elementType ??
        payload?.core?.typeDamageTxt ??
        null,

      weaponType:
        payload?.core?.weaponType ??
        payload?.advPayload?.weaponType ??
        payload?.meta?.weaponType ??
        null,

      baseValue:
        payload?.advPayload?.baseValue ??
        payload?.meta?.baseValue ??
        null,

      bonus:
        payload?.advPayload?.bonus ??
        payload?.meta?.bonus ??
        null,

      reduction:
        payload?.advPayload?.reduction ??
        payload?.meta?.reduction ??
        null,

      multiplier:
        payload?.advPayload?.multiplier ??
        payload?.meta?.multiplier ??
        null,

      targetsCount: getCanonicalTargets(payload).length
    };
  }

  // =========================================================
  // API RESOLVERS
  // =========================================================

  function getCardFinderApi() {
    return (
      globalThis.FUCompanion?.api?.actionEditorCardFinder ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditorCardFinder ??
      globalThis.FUCompanion?.api?.actionEditor?.cardFinder ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditor?.cardFinder ??
      null
    );
  }

  function getActionEditorApi() {
    return (
      globalThis.FUCompanion?.api?.actionEditor ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditor ??
      null
    );
  }

  function getRendererApi() {
    // These are future hooks for the next CreateActionCard.js patch.
    // The rebuilder checks several names so the next patch has flexibility.
    const globalApi = globalThis.FUCompanion?.api ?? {};
    const moduleApi = game.modules?.get?.(MODULE_ID)?.api ?? {};

    return (
      globalApi.createActionCardRenderer ??
      moduleApi.createActionCardRenderer ??
      globalApi.actionCardRenderer ??
      moduleApi.actionCardRenderer ??
      globalApi.createActionCard ??
      moduleApi.createActionCard ??
      null
    );
  }

  function findRenderFunction(rendererApi) {
    if (!rendererApi) return null;

    const candidates = [
      rendererApi.renderActionCardHTML,
      rendererApi.renderActionCardHtml,
      rendererApi.renderHtml,
      rendererApi.renderHTML,
      rendererApi.render,
      rendererApi.buildActionCardHTML,
      rendererApi.buildActionCardHtml,
      rendererApi.buildHtml,
      rendererApi.buildHTML
    ];

    return candidates.find(fn => typeof fn === "function") ?? null;
  }

  // =========================================================
  // MESSAGE RESOLUTION
  // =========================================================

  async function resolveMessage(messageOrId = null) {
    if (messageOrId && typeof messageOrId === "object") return messageOrId;

    const messageId = str(messageOrId);
    if (!messageId) return null;

    const loaded = game.messages?.get?.(messageId) ?? null;
    if (loaded) return loaded;

    try {
      const ChatMessageClass =
        globalThis.ChatMessage ??
        getDocumentClass?.("ChatMessage") ??
        null;

      if (ChatMessageClass && typeof ChatMessageClass.getDocuments === "function") {
        const docs = await ChatMessageClass.getDocuments({ _id: messageId });
        return docs?.[0] ?? null;
      }
    } catch (e) {
      warn("Database message lookup failed.", {
        messageId,
        error: String(e?.message ?? e)
      });
    }

    return null;
  }

  async function resolvePayloadFromRequest(request = {}) {
    if (request.payload && typeof request.payload === "object") {
      return {
        ok: true,
        payload: request.payload,
        source: "request.payload"
      };
    }

    const finder = getCardFinderApi();
    if (!finder?.findActionCard) {
      return {
        ok: false,
        reason: "missing_payload_and_card_finder"
      };
    }

    const found = await finder.findActionCard({
      actionCardId: request.actionCardId,
      actionId: request.actionId,
      actionCardMessageId: request.actionCardMessageId ?? request.messageId
    }, {
      includeReplaced: true,
      maxMessages: request.maxMessages ?? 250
    });

    if (!found?.ok) {
      return {
        ok: false,
        reason: found?.reason ?? "card_not_found",
        found
      };
    }

    return {
      ok: true,
      payload: found.payload,
      message: found.message,
      found,
      source: "cardFinder"
    };
  }

  function ensurePayloadIdentity(payload = {}, message = null, request = {}) {
    payload.meta = payload.meta || {};

    const actionId = str(
      payload?.meta?.actionId ??
      payload?.actionId ??
      request?.actionId
    );

    const actionCardId = str(
      payload?.meta?.actionCardId ??
      payload?.actionCardId ??
      request?.actionCardId
    );

    const actionCardVersion = num(
      payload?.meta?.actionCardVersion ??
      payload?.actionCardVersion ??
      request?.actionCardVersion ??
      0,
      0
    );

    const messageId = str(
      message?.id ??
      request?.messageId ??
      request?.actionCardMessageId ??
      payload?.meta?.actionCardMessageId ??
      payload?.actionCardMessageId
    );

    if (actionId) {
      payload.actionId = actionId;
      payload.meta.actionId = actionId;
    }

    if (actionCardId) {
      payload.actionCardId = actionCardId;
      payload.meta.actionCardId = actionCardId;
    }

    payload.actionCardVersion = actionCardVersion;
    payload.meta.actionCardVersion = actionCardVersion;

    if (messageId) {
      payload.actionCardMessageId = messageId;
      payload.meta.actionCardMessageId = messageId;
    }

    payload.meta.actionCardLastRebuiltAtMs = nowMs();
    payload.meta.actionCardLastRebuiltAtIso = isoNow();

    return payload;
  }

  // =========================================================
  // FLAG SAVE
  // =========================================================

  function buildActionCardFlagData(payload, messageId = null, existingFlag = null) {
    const editorApi = getActionEditorApi();

    if (editorApi && typeof editorApi.buildActionCardFlagData === "function") {
      try {
        return editorApi.buildActionCardFlagData(payload, messageId, existingFlag);
      } catch (e) {
        warn("ActionEditor buildActionCardFlagData failed; using local fallback.", {
          error: String(e?.message ?? e)
        });
      }
    }

    payload.meta = payload.meta || {};

    const resolvedMessageId = str(
      messageId ??
      payload?.meta?.actionCardMessageId ??
      payload?.actionCardMessageId
    );

    if (resolvedMessageId) {
      payload.actionCardMessageId = resolvedMessageId;
      payload.meta.actionCardMessageId = resolvedMessageId;
    }

    return {
      ...(existingFlag && typeof existingFlag === "object" ? clone(existingFlag, {}) : {}),

      payload,

      actionId: payload?.meta?.actionId ?? payload?.actionId ?? null,
      actionCardId: payload?.meta?.actionCardId ?? payload?.actionCardId ?? null,
      actionCardVersion: payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? null,
      actionCardMessageId: resolvedMessageId || null,

      replacedActionCardIds: uniq([
        ...(Array.isArray(existingFlag?.replacedActionCardIds) ? existingFlag.replacedActionCardIds : []),
        ...(Array.isArray(payload?.meta?.replacedActionCardIds) ? payload.meta.replacedActionCardIds : []),
        ...(Array.isArray(payload?.replacedActionCardIds) ? payload.replacedActionCardIds : [])
      ]),

      actionCardState:
        payload?.meta?.actionCardState ??
        payload?.actionCardState ??
        "pending",

      lastRebuiltAtMs: payload?.meta?.actionCardLastRebuiltAtMs ?? nowMs(),
      lastRebuiltAtIso: payload?.meta?.actionCardLastRebuiltAtIso ?? isoNow()
    };
  }

  async function saveActionCardFlag({
    message,
    payload,
    existingFlag = null
  } = {}) {
    const editorApi = getActionEditorApi();

    if (editorApi && typeof editorApi.saveActionCardFlag === "function") {
      try {
        return await editorApi.saveActionCardFlag({
          message,
          payload,
          existingFlag
        });
      } catch (e) {
        warn("ActionEditor saveActionCardFlag failed; using local fallback.", {
          error: String(e?.message ?? e)
        });
      }
    }

    if (!message) {
      return {
        ok: false,
        reason: "missing_message"
      };
    }

    const flagData = buildActionCardFlagData(payload, message.id, existingFlag);

    try {
      if (typeof message.setFlag === "function") {
        await message.setFlag(MODULE_ID, "actionCard", flagData);
      } else {
        await message.update({
          [`flags.${MODULE_ID}.actionCard`]: flagData
        });
      }

      return {
        ok: true,
        messageId: message.id,
        flagData
      };
    } catch (e) {
      return {
        ok: false,
        reason: "save_flag_failed",
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "")
      };
    }
  }

  // =========================================================
  // CONFIRM ARGS PATCHING
  // =========================================================
  // This is a compatibility fallback.
  //
  // Once Confirm handler is patched to read latest payload from the flag,
  // this becomes less important, but it is still useful for older cards.
  // =========================================================

  function buildConfirmArgsFromPayload(payload = {}, existingArgs = {}) {
    const meta = payload?.meta ?? {};
    const core = payload?.core ?? {};
    const adv = payload?.advPayload ?? {};
    const accuracy = payload?.accuracy ?? null;

    const targets = getCanonicalTargets(payload);

    return {
      ...(existingArgs && typeof existingArgs === "object" ? clone(existingArgs, {}) : {}),

      // Core identity.
      actionId: meta.actionId ?? payload.actionId ?? null,
      actionCardId: meta.actionCardId ?? payload.actionCardId ?? null,
      actionCardVersion: meta.actionCardVersion ?? payload.actionCardVersion ?? null,
      actionCardMessageId: meta.actionCardMessageId ?? payload.actionCardMessageId ?? null,

      // Resolution context.
      actionContext: payload,

      attackerUuid:
        meta.attackerUuid ??
        payload.attackerUuid ??
        payload.attackerActorUuid ??
        adv.attackerUuid ??
        null,

      attackerName:
        meta.attackerName ??
        core.attackerName ??
        adv.attackerName ??
        null,

      skillName:
        core.skillName ??
        payload?.dataCore?.skillName ??
        null,

      sourceType:
        meta.sourceType ??
        adv.sourceType ??
        null,

      attackRange:
        meta.attackRange ??
        adv.attackRange ??
        null,

      // Damage payload.
      advPayload: clone(adv, {}),
      elementType:
        meta.elementType ??
        adv.elementType ??
        core.typeDamageTxt ??
        null,

      weaponType:
        core.weaponType ??
        adv.weaponType ??
        meta.weaponType ??
        null,

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

      ignoreShield:
        !!(adv.ignoreShield ?? meta.ignoreShield),

      ignoreDamageReduction:
        !!(adv.ignoreDamageReduction ?? meta.ignoreDamageReduction),

      hasDamageSection:
        !!(meta.hasDamageSection ?? adv.hasDamageSection),

      declaresHealing:
        !!(meta.declaresHealing ?? adv.declaresHealing),

      isSpellish:
        !!(meta.isSpellish ?? payload?.dataCore?.isSpell ?? payload?.dataCore?.isOffSpell),

      skillTypeRaw:
        core.skillTypeRaw ??
        payload?.dataCore?.skillTypeRaw ??
        meta.skillTypeRaw ??
        "",

      // Accuracy.
      hasAccuracy: !!accuracy,
      accuracyTotal:
        accuracy?.total ??
        null,

      defenseUsed:
        meta?.defenseSnapshot?.primary?.def ??
        meta?.defenseSnapshot?.primary?.mdef ??
        null,

      autoHit:
        !!(accuracy?.autoHit ?? meta?.autoHit),

      forceMiss:
        !!(accuracy?.forceMiss ?? meta?.forceMiss),

      // Targets.
      targets,
      originalTargetUUIDs: targets,
      originalTargetActorUUIDs: getCanonicalTargetActors(payload)
    };
  }

  function updateConfirmButtonsInContent(html, payload = {}) {
    const original = String(html ?? "");
    if (!original.trim()) {
      return {
        changed: false,
        content: original,
        buttonsUpdated: 0,
        reason: "empty_content"
      };
    }

    const template = document.createElement("template");
    template.innerHTML = original;

    const selectors = [
      "[data-fu-confirm]",
      "[data-action-confirm]",
      "[data-confirm-action]",
      "button[data-fu-args]",
      "a[data-fu-args]"
    ];

    const buttons = Array.from(template.content.querySelectorAll(selectors.join(",")));

    let updated = 0;

    for (const btn of buttons) {
      const existingArgs = safeJsonParse(
        btn.getAttribute("data-fu-args") ??
        btn.dataset?.fuArgs ??
        "{}",
        {}
      );

      const nextArgs = buildConfirmArgsFromPayload(payload, existingArgs);

      btn.setAttribute("data-fu-args", encodeDataJson(nextArgs));
      btn.setAttribute("data-action-id", str(payload?.meta?.actionId ?? payload?.actionId));
      btn.setAttribute("data-action-card-id", str(payload?.meta?.actionCardId ?? payload?.actionCardId));
      btn.setAttribute("data-action-card-version", str(payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? 0));

      updated++;
    }

    return {
      changed: updated > 0,
      content: template.innerHTML,
      buttonsUpdated: updated
    };
  }

  // =========================================================
  // DATA-ONLY FALLBACK VISUAL PATCH
  // =========================================================
  // This does not fully rebuild your beautiful card.
  // It only marks the card as edited and refreshes confirm data.
  //
  // Full visual rebuild will be enabled by the next CreateActionCard.js patch.
  // =========================================================

  function computePreviewAmount(payload = {}) {
    const adv = payload?.advPayload ?? {};
    const baseRaw = String(adv.baseValue ?? payload?.meta?.baseValue ?? "0").trim();
    const isRecovery = baseRaw.startsWith("+");
    const base = num(baseRaw.replace("+", ""), 0);
    const bonus = num(adv.bonus ?? payload?.meta?.bonus, 0);
    const reduction = num(adv.reduction ?? payload?.meta?.reduction, 0);
    const multiplier = num(adv.multiplier ?? payload?.meta?.multiplier, 100);

    const final = Math.ceil(Math.max(base - reduction + bonus, 0) * (multiplier / 100));

    return {
      base,
      bonus,
      reduction,
      multiplier,
      final,
      isRecovery
    };
  }

  function makeEditedBadgeHTML(payload = {}, editRecord = null, reason = "") {
    const p = compactPayloadPreview(payload);
    const preview = computePreviewAmount(payload);
    const element = p.elementType ? cap(p.elementType) : "—";
    const version = p.actionCardVersion ?? "—";

    const note =
      str(reason) ||
      str(editRecord?.reason) ||
      str(payload?.meta?.actionEditor?.lastReason) ||
      "Action Card data was edited.";

    return `
      <div class="fu-action-editor-rebuild-badge"
           data-action-editor-rebuild-badge="true"
           style="
             margin:.35rem 0 .45rem;
             padding:.35rem .55rem;
             border:1px solid rgba(207,160,87,.75);
             border-radius:8px;
             background:rgba(255,246,220,.86);
             color:#6b3e1e;
             font-size:12px;
             line-height:1.25;
             box-shadow:0 1px 2px rgba(0,0,0,.08);
           ">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:.5rem;">
          <b><i class="fa-solid fa-pen-to-square"></i> Edited Action Card</b>
          <span style="opacity:.78;">v${esc(version)}</span>
        </div>
        <div style="margin-top:.2rem; opacity:.9;">
          ${esc(note)}
        </div>
        <div style="margin-top:.25rem; display:flex; flex-wrap:wrap; gap:.35rem; opacity:.86;">
          <span>Element: <b>${esc(element)}</b></span>
          <span>Preview: <b>${esc(preview.final)}</b></span>
          <span>Bonus: <b>${esc(p.bonus ?? 0)}</b></span>
          <span>Targets: <b>${esc(p.targetsCount)}</b></span>
        </div>
      </div>
    `.trim();
  }

  function addOrUpdateEditedBadge(content, payload = {}, editRecord = null, reason = "") {
    const original = String(content ?? "");
    const template = document.createElement("template");
    template.innerHTML = original;

    const badgeHTML = makeEditedBadgeHTML(payload, editRecord, reason);
    const existing = template.content.querySelector("[data-action-editor-rebuild-badge]");

    if (existing) {
      const badgeTemplate = document.createElement("template");
      badgeTemplate.innerHTML = badgeHTML;
      existing.replaceWith(badgeTemplate.content.firstElementChild);
    } else {
      const firstActionRoot =
        template.content.querySelector(".fu-action-card") ??
        template.content.querySelector(".fu-card") ??
        template.content.querySelector("fieldset") ??
        template.content.firstElementChild;

      const badgeTemplate = document.createElement("template");
      badgeTemplate.innerHTML = badgeHTML;
      const badge = badgeTemplate.content.firstElementChild;

      if (firstActionRoot) {
        firstActionRoot.prepend(badge);
      } else {
        template.innerHTML = `${badgeHTML}${original}`;
      }
    }

    // Try to keep visible roll numbers roughly current.
    const preview = computePreviewAmount(payload);
    const rollNums = Array.from(template.content.querySelectorAll(".fu-rollnum"));

    if (rollNums.length) {
      // Update the first roll number only. This is intentionally conservative.
      const first = rollNums[0];
      first.dataset.final = String(preview.final);
      first.textContent = String(preview.final);
      first.__rolled = false;
    }

    return {
      changed: true,
      content: template.innerHTML
    };
  }

  function patchExistingContentDataOnly({
    content,
    payload,
    editRecord = null,
    reason = ""
  } = {}) {
    let current = String(content ?? "");
    const steps = [];

    const confirmPatch = updateConfirmButtonsInContent(current, payload);
    current = confirmPatch.content;
    steps.push({
      step: "confirm-buttons",
      changed: confirmPatch.changed,
      buttonsUpdated: confirmPatch.buttonsUpdated ?? 0,
      reason: confirmPatch.reason ?? null
    });

    const badgePatch = addOrUpdateEditedBadge(current, payload, editRecord, reason);
    current = badgePatch.content;
    steps.push({
      step: "edited-badge",
      changed: badgePatch.changed
    });

    return {
      ok: true,
      content: current,
      changed: steps.some(s => s.changed),
      steps,
      fullVisualRebuild: false
    };
  }

  // =========================================================
  // RENDERER PATH
  // =========================================================

  async function renderWithCreateActionCardRenderer({
    payload,
    message,
    editRecord = null,
    reason = "",
    rendererApi = null
  } = {}) {
    const api = rendererApi ?? getRendererApi();
    const renderFn = findRenderFunction(api);

    if (!renderFn) {
      return {
        ok: false,
        reason: "renderer_missing"
      };
    }

    payload.meta = payload.meta || {};

    const renderPayload = clone(payload, {});
    renderPayload.meta = renderPayload.meta || {};

    // Future CreateActionCard patch should look for these.
    renderPayload.meta.__actionCardRenderMode = "updateExisting";
    renderPayload.meta.__actionCardUpdateExisting = true;
    renderPayload.meta.__preserveActionCardId = true;
    renderPayload.meta.__targetMessageId = message?.id ?? payload?.meta?.actionCardMessageId ?? null;
    renderPayload.meta.__skipReactionEmit = true;
    renderPayload.meta.__skipCriticalCutin = true;
    renderPayload.meta.__rebuiltByActionCardRebuilder = true;

    const options = {
      mode: "updateExisting",
      updateExisting: true,
      preserveActionCardId: true,
      targetMessageId: message?.id ?? payload?.meta?.actionCardMessageId ?? null,
      message,
      editRecord,
      reason
    };

    try {
      const rendered = await renderFn.call(api, renderPayload, options);

      if (typeof rendered === "string") {
        return {
          ok: true,
          html: rendered,
          content: rendered,
          fullVisualRebuild: true,
          renderer: "function:string"
        };
      }

      if (rendered && typeof rendered === "object") {
        const html = rendered.html ?? rendered.content ?? rendered.messageContent ?? null;

        if (typeof html === "string") {
          return {
            ok: true,
            ...rendered,
            html,
            content: html,
            fullVisualRebuild: true,
            renderer: "function:object"
          };
        }
      }

      return {
        ok: false,
        reason: "renderer_returned_no_html",
        rendered
      };
    } catch (e) {
      return {
        ok: false,
        reason: "renderer_exception",
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "")
      };
    }
  }

  // =========================================================
  // MAIN REBUILD FUNCTION
  // =========================================================

  async function replaceMessageWithVersionedCard({
  message,
  payload,
  reason = "",
  editRecord = null
} = {}) {
  if (!message) {
    return {
      ok: false,
      reason: "missing_old_message"
    };
  }

  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      reason: "missing_payload"
    };
  }

  const macro = game.macros?.getName?.("CreateActionCard");
  if (!macro) {
    return {
      ok: false,
      reason: "create_action_card_macro_missing"
    };
  }

  const nextPayload = clone(payload, {});
  nextPayload.meta = nextPayload.meta || {};

  const oldMessageId = String(message.id ?? "");
  const oldActionId = String(nextPayload?.meta?.actionId ?? nextPayload?.actionId ?? "");
  const oldActionCardId = String(nextPayload?.meta?.actionCardId ?? nextPayload?.actionCardId ?? "");
  const oldVersion = Number(nextPayload?.meta?.actionCardVersion ?? nextPayload?.actionCardVersion ?? 1) || 1;

  // Preserve identity across replacement versions.
  nextPayload.meta.__preserveActionId = true;
  nextPayload.meta.__preserveActionCardId = true;
  nextPayload.meta.__preserveActionCardVersion = true;
  nextPayload.meta.__actionEditorPreserveIdentity = true;

  // This is still a new chat message, but the same action card identity.
  nextPayload.meta.__actionEditorReplacementRender = true;
  nextPayload.meta.__actionEditorReplacedMessageId = oldMessageId;
  nextPayload.meta.__actionEditorReplacementReason = reason || "";
  nextPayload.meta.__actionEditorReplacementAtMs = Date.now();
  nextPayload.meta.__actionEditorReplacementAtIso = new Date().toISOString();

// IMPORTANT:
// This render is only a card replacement/edit preview.
// It should NOT count as "the actor performed an action" again.
// So CreateActionCard must not emit action-phase reaction beacons,
// and it must not replay critical cut-ins.
nextPayload.meta.__skipReactionEmit = true;
nextPayload.meta.__skipCriticalCutin = true;
nextPayload.meta.__suppressActionDeclarationEvents = true;

  nextPayload.meta.previousActionCardMessageIds = Array.from(new Set([
    ...(Array.isArray(nextPayload.meta.previousActionCardMessageIds) ? nextPayload.meta.previousActionCardMessageIds : []),
    oldMessageId
  ].filter(Boolean).map(String)));

  // Clear old message id before CreateActionCard creates the new message.
  delete nextPayload.actionCardMessageId;
  delete nextPayload.meta.actionCardMessageId;

  log("REPLACE MESSAGE WITH VERSIONED CARD - START", {
    oldMessageId,
    oldActionId,
    oldActionCardId,
    oldVersion,
    elementType: nextPayload?.meta?.elementType ?? nextPayload?.advPayload?.elementType ?? null
  });

  let result = null;

  try {
    // Your macro convention supports __AUTO / __PAYLOAD through macro.execute.
    result = await macro.execute({
      __AUTO: true,
      __PAYLOAD: nextPayload
    });
  } catch (e) {
    err("CreateActionCard replacement render failed", {
      error: String(e?.message ?? e),
      stack: String(e?.stack ?? "")
    });

    return {
      ok: false,
      reason: "create_action_card_execute_failed",
      error: String(e?.message ?? e),
      stack: String(e?.stack ?? "")
    };
  }

  const newMessageId = String(
    result?.messageId ??
    result?.chatMsgId ??
    nextPayload?.meta?.actionCardMessageId ??
    nextPayload?.actionCardMessageId ??
    ""
  ).trim();

  let newMessage = newMessageId ? game.messages?.get?.(newMessageId) : null;

  // Fallback: find the newest loaded message with the same preserved actionCardId.
  if (!newMessage && oldActionCardId) {
    const candidates = Array.from(game.messages?.contents ?? [])
      .filter(m => {
        const p = m.getFlag?.(MODULE_ID, "actionCard")?.payload;
        return String(p?.meta?.actionCardId ?? p?.actionCardId ?? "") === oldActionCardId;
      })
      .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));

    newMessage = candidates[0] ?? null;
  }

  if (!newMessage) {
    return {
      ok: false,
      reason: "new_message_not_found_after_replacement",
      macroResult: result
    };
  }

  const newFlag = newMessage.getFlag?.(MODULE_ID, "actionCard") ?? null;
  const newPayload = newFlag?.payload ?? result?.payload ?? nextPayload;

  // Delete old message only after new card exists.
  try {
    await message.delete();
  } catch (e) {
    warn("Could not delete old Action Card message after replacement.", {
      oldMessageId,
      error: String(e?.message ?? e)
    });
  }

  log("REPLACE MESSAGE WITH VERSIONED CARD - DONE", {
    oldMessageId,
    newMessageId: newMessage.id,
    actionId: newPayload?.meta?.actionId ?? newPayload?.actionId ?? null,
    actionCardId: newPayload?.meta?.actionCardId ?? newPayload?.actionCardId ?? null,
    actionCardVersion: newPayload?.meta?.actionCardVersion ?? newPayload?.actionCardVersion ?? null,
    elementType: newPayload?.meta?.elementType ?? newPayload?.advPayload?.elementType ?? null
  });

  return {
    ok: true,
    mode: "replace-message-preserve-id",
    oldMessageId,
    newMessage,
    newMessageId: newMessage.id,
    message: newMessage,
    messageId: newMessage.id,
    chatMsgId: newMessage.id,
    payload: newPayload,
    flagData: newFlag,
    macroResult: result,

    actionId: newPayload?.meta?.actionId ?? newPayload?.actionId ?? null,
    actionCardId: newPayload?.meta?.actionCardId ?? newPayload?.actionCardId ?? null,
    actionCardVersion: newPayload?.meta?.actionCardVersion ?? newPayload?.actionCardVersion ?? null,
    actionCardMessageId: newMessage.id
  };
}

  async function rebuildActionCard(request = {}) {
    const runId = `ACR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const updateContent = request.updateContent !== false;
    const saveFlag = request.saveFlag !== false;
    const preferFullRenderer = request.preferFullRenderer !== false;
    const allowDataOnlyFallback = request.allowDataOnlyFallback !== false;

    const rebuildModeRequest = String(
      request.mode ??
      request.rebuildMode ??
      "replace-message-preserve-id"
    ).trim().toLowerCase();

    const useReplaceMessageMode = (
      rebuildModeRequest === "replace-message" ||
      rebuildModeRequest === "replace-message-preserve-id" ||
      rebuildModeRequest === "versioned-replace" ||
      rebuildModeRequest === "safe-replace"
);

    log("REBUILD START", {
      runId,
      messageId: request.messageId ?? request.actionCardMessageId ?? request.message?.id ?? null,
      actionId: request.actionId ?? null,
      actionCardId: request.actionCardId ?? null,
      updateContent,
      saveFlag,
      preferFullRenderer,
      allowDataOnlyFallback
    });

    const payloadResult = await resolvePayloadFromRequest(request);

    if (!payloadResult?.ok) {
      warn("REBUILD FAILED: could not resolve payload", {
        runId,
        payloadResult
      });

      return {
        ok: false,
        runId,
        reason: payloadResult?.reason ?? "payload_not_found",
        payloadResult
      };
    }

    let message =
      request.message ??
      payloadResult.message ??
      payloadResult.found?.message ??
      null;

    if (!message) {
      message = await resolveMessage(
        request.messageId ??
        request.actionCardMessageId ??
        request.chatMsgId ??
        payloadResult.payload?.meta?.actionCardMessageId ??
        payloadResult.payload?.actionCardMessageId ??
        payloadResult.found?.messageId ??
        null
      );
    }

    if (!message) {
      return {
        ok: false,
        runId,
        reason: "message_not_found",
        payloadSource: payloadResult.source,
        payloadPreview: compactPayloadPreview(payloadResult.payload)
      };
    }

    const payload = clone(payloadResult.payload, {});
    ensurePayloadIdentity(payload, message, request);

    if (useReplaceMessageMode) {
  const replaceResult = await replaceMessageWithVersionedCard({
    message,
    payload,
    reason: request.reason ?? "",
    editRecord: request.editRecord ?? null
  });

  return {
    ...replaceResult,
    runId,
    requestedMode: rebuildModeRequest,
    fullVisualRebuild: true,
    dataOnlyFallback: false
  };
}

    const existingFlag =
      payloadResult?.found?.flag ??
      message.getFlag?.(MODULE_ID, "actionCard") ??
      message.flags?.[MODULE_ID]?.actionCard ??
      null;

    const beforeContent = String(message.content ?? "");
    const beforePreview = compactPayloadPreview(payload);

    // -------------------------------------------------------
    // 1) Save/sync flag first.
    // -------------------------------------------------------
    let flagResult = {
      ok: true,
      skipped: true,
      reason: "save_flag_false"
    };

    if (saveFlag) {
      flagResult = await saveActionCardFlag({
        message,
        payload,
        existingFlag
      });

      if (!flagResult?.ok) {
        return {
          ok: false,
          runId,
          reason: flagResult?.reason ?? "save_flag_failed",
          flagResult,
          payloadPreview: beforePreview
        };
      }
    }

    // -------------------------------------------------------
    // 2) Build next content.
    // -------------------------------------------------------
    let renderResult = {
      ok: false,
      reason: "full_renderer_not_attempted"
    };

    let nextContent = beforeContent;
    let rebuildMode = "none";

    if (updateContent && preferFullRenderer) {
      renderResult = await renderWithCreateActionCardRenderer({
        payload,
        message,
        editRecord: request.editRecord ?? null,
        reason: request.reason ?? ""
      });

      if (renderResult?.ok && typeof renderResult.content === "string") {
        nextContent = renderResult.content;
        rebuildMode = "full-renderer";
      }
    }

    if (updateContent && rebuildMode === "none" && allowDataOnlyFallback) {
      const fallback = patchExistingContentDataOnly({
        content: beforeContent,
        payload,
        editRecord: request.editRecord ?? null,
        reason: request.reason ?? ""
      });

      if (fallback?.ok) {
        nextContent = fallback.content;
        rebuildMode = "data-only-fallback";
        renderResult = {
          ok: true,
          ...fallback,
          reason: "renderer_missing_used_data_only_fallback"
        };
      }
    }

    // -------------------------------------------------------
    // 3) Update message content.
    // -------------------------------------------------------
    let messageUpdateResult = {
      ok: true,
      skipped: true,
      reason: "update_content_false"
    };

    if (updateContent) {
      if (nextContent !== beforeContent) {
        try {
          await message.update({
            content: nextContent
          });

          messageUpdateResult = {
            ok: true,
            messageId: message.id,
            changed: true
          };
        } catch (e) {
          err("MESSAGE CONTENT UPDATE FAILED", {
            runId,
            messageId: message.id,
            error: String(e?.message ?? e),
            stack: String(e?.stack ?? "")
          });

          return {
            ok: false,
            runId,
            reason: "message_update_failed",
            error: String(e?.message ?? e),
            stack: String(e?.stack ?? ""),
            flagResult,
            renderResult,
            payloadPreview: beforePreview
          };
        }
      } else {
        messageUpdateResult = {
          ok: true,
          messageId: message.id,
          changed: false,
          reason: "content_unchanged"
        };
      }
    }

    const result = {
      ok: true,
      runId,
      mode: rebuildMode,
      fullVisualRebuild: rebuildMode === "full-renderer",
      dataOnlyFallback: rebuildMode === "data-only-fallback",

      message,
      messageId: message.id,
      chatMsgId: message.id,

      payload,
      payloadPreview: compactPayloadPreview(payload),

      actionId: payload?.meta?.actionId ?? payload?.actionId ?? null,
      actionCardId: payload?.meta?.actionCardId ?? payload?.actionCardId ?? null,
      actionCardVersion: payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? null,
      actionCardMessageId: payload?.meta?.actionCardMessageId ?? payload?.actionCardMessageId ?? message.id,

      flagResult,
      renderResult,
      messageUpdateResult
    };

    log("REBUILD DONE", {
      runId,
      mode: result.mode,
      fullVisualRebuild: result.fullVisualRebuild,
      actionId: result.actionId,
      actionCardId: result.actionCardId,
      actionCardVersion: result.actionCardVersion,
      messageId: result.messageId
    });

    return result;
  }

  // =========================================================
  // CONVENIENCE HELPERS
  // =========================================================

  async function rebuildByActionCardId(actionCardId, options = {}) {
    return await rebuildActionCard({
      ...options,
      actionCardId
    });
  }

  async function rebuildByMessageId(messageId, options = {}) {
    return await rebuildActionCard({
      ...options,
      messageId
    });
  }

  async function refreshConfirmDataOnly(request = {}) {
    return await rebuildActionCard({
      ...request,
      preferFullRenderer: false,
      allowDataOnlyFallback: true,
      updateContent: true,
      saveFlag: request.saveFlag !== false
    });
  }

  function getStatus() {
    const rendererApi = getRendererApi();
    const renderFn = findRenderFunction(rendererApi);

    return {
      ok: true,
      version: API_VERSION,
      debug: ACTION_CARD_REBUILDER_DEBUG,

      hasCardFinder: !!getCardFinderApi()?.findActionCard,
      hasActionEditor: !!getActionEditorApi()?.editActionCard,
      hasRendererApi: !!rendererApi,
      hasRenderFunction: !!renderFn,

      rendererKeys: rendererApi && typeof rendererApi === "object"
        ? Object.keys(rendererApi)
        : [],

      isGM: !!game.user?.isGM,
      userId: game.userId,
      userName: game.user?.name ?? null
    };
  }

  // =========================================================
  // API REGISTRATION
  // =========================================================

  const api = {
    version: API_VERSION,

    rebuildActionCard,
    rebuildByActionCardId,
    rebuildByMessageId,
    refreshConfirmDataOnly,

    getStatus,

    // Utility exports.
    buildConfirmArgsFromPayload,
    updateConfirmButtonsInContent,
    patchExistingContentDataOnly,
    renderWithCreateActionCardRenderer,
    compactPayloadPreview,
    computePreviewAmount
  };

  // Global namespace.
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  globalThis.FUCompanion.api.actionCardRebuilder = api;

  globalThis.FUCompanion.api.actionEditor =
    globalThis.FUCompanion.api.actionEditor || {};

  globalThis.FUCompanion.api.actionEditor.rebuilder = api;

  // Module API namespace.
  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};

      mod.api.actionCardRebuilder = api;

      mod.api.actionEditor = mod.api.actionEditor || {};
      mod.api.actionEditor.rebuilder = api;
    }
  } catch (e) {
    warn("Could not register Rebuilder on game.modules API.", {
      error: String(e?.message ?? e)
    });
  }

  console.log(`${TAG} Ready`, {
    version: API_VERSION,
    moduleId: MODULE_ID,
    debug: ACTION_CARD_REBUILDER_DEBUG
  });
})();