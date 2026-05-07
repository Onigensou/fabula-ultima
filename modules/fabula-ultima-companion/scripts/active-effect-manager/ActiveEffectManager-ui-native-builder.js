// ============================================================================
// ActiveEffectManager-ui-native-builder.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Native Foundry Active Effect Configuration builder for modular AEM UI.
// - CSB-safe:
//     1. Creates a temporary disabled ActiveEffect draft on a real Actor.
//     2. Opens the native Active Effect sheet.
//     3. Adds smart Attribute Key suggestions to changes[].key inputs.
//     4. Captures Save.
//     5. Queues the final edited effect into AEM selectedEffects.
//     6. Deletes the temporary draft.
//
// Public API:
//   FUCompanion.api.activeEffectManager.uiParts.nativeBuilder.openForQueue(options)
//   FUCompanion.api.activeEffectManager.uiParts.nativeBuilder.open(options)
//
// Expected caller from ui-core:
//   nativeBuilder.openForQueue({
//     parentState,
//     root,
//     services,
//     onAddEffect(effectData, meta)
//   })
//
// Load order:
// - Load after ActiveEffectManager-ui-dom.js and ActiveEffectManager-field-catalog.js.
// - Load before ActiveEffectManager-ui-events.js or before ActiveEffectManager-ui-core.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:NativeBuilder]";
  const DEBUG = true;

  const DRAFT_FLAG_PATH = `flags.${MODULE_ID}.activeEffectManager.nativeBuilderDraft`;

  let ACTIVE_SESSION = null;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  // --------------------------------------------------------------------------
  // Namespace helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager =
      globalThis.FUCompanion.api.activeEffectManager || {};

    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function ensureUiPartsRoot() {
    const root = ensureApiRoot();
    root.uiParts = root.uiParts || {};
    return root.uiParts;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();
    const parts = ensureUiPartsRoot();

    parts.nativeBuilder = api;

    // Friendly alias for console testing.
    root.uiNativeBuilder = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);

      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.uiParts =
          mod.api.activeEffectManager.uiParts || {};

        mod.api.activeEffectManager.uiParts.nativeBuilder = api;
        mod.api.activeEffectManager.uiNativeBuilder = api;
      }
    } catch (e) {
      warn("Could not expose native builder API on module object.", e);
    }
  }

  function getGlobalKeySuggestionApi() {
  return (
    globalThis.FUCompanion?.api?.activeEffectKeySuggestions ??
    globalThis.FUCompanion?.api?.activeEffectManager?.keySuggestions ??
    game.modules?.get?.(MODULE_ID)?.api?.activeEffectKeySuggestions ??
    game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.keySuggestions ??
    null
  );
}

async function installGlobalKeySuggestionsForSheet(sheet, actor) {
  const keySuggest = getGlobalKeySuggestionApi();

  if (!keySuggest?.installIntoSheet) {
    return {
      ok: false,
      reason: "global_key_suggestion_api_not_found"
    };
  }

  let refreshReport = null;

  try {
    if (typeof keySuggest.refresh === "function") {
      refreshReport = await keySuggest.refresh(actor, {
        force: true
      });
    }
  } catch (e) {
    warn("Global key suggestion refresh failed.", e);
  }

  const installReport = await keySuggest.installIntoSheet(sheet, sheet?.element, {
    actor,
    forceRefresh: false
  });

  return {
    ok: !!installReport?.ok,
    refreshReport,
    installReport,
    entries: refreshReport?.entries ?? []
  };
}

  function getDomApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager?.uiParts?.dom ?? null;
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

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

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function uniq(values) {
    return Array.from(
      new Set(
        asArray(values)
          .filter(v => v != null && String(v).trim() !== "")
          .map(String)
      )
    );
  }

  function randomId(prefix = "aem-native") {
    const id =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${id}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function compactError(e) {
    return String(e?.message ?? e);
  }

  function getProperty(obj, path, fallback = undefined) {
    try {
      if (foundry?.utils?.getProperty) {
        const value = foundry.utils.getProperty(obj, path);
        return value === undefined ? fallback : value;
      }
    } catch (_e) {}

    try {
      const value = String(path)
        .split(".")
        .reduce((cur, key) => cur?.[key], obj);

      return value === undefined ? fallback : value;
    } catch (_e) {
      return fallback;
    }
  }

  function setProperty(obj, path, value) {
    try {
      if (foundry?.utils?.setProperty) {
        foundry.utils.setProperty(obj, path, value);
        return obj;
      }
    } catch (_e) {}

    const parts = String(path).split(".");
    let cur = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      cur[key] ??= {};
      cur = cur[key];
    }

    cur[parts[parts.length - 1]] = value;
    return obj;
  }

  function modeValue(name) {
    const modes = CONST?.ACTIVE_EFFECT_MODES ?? {};

    const fallback = {
      CUSTOM: 0,
      MULTIPLY: 1,
      ADD: 2,
      DOWNGRADE: 3,
      UPGRADE: 4,
      OVERRIDE: 5
    };

    return modes[name] ?? fallback[name] ?? 0;
  }

  function boolFromFormValue(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (value === true || value === false) return value;

    const s = String(value).trim().toLowerCase();

    if (["true", "1", "on", "yes", "checked"].includes(s)) return true;
    if (["false", "0", "off", "no", ""].includes(s)) return false;

    return !!value;
  }

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  function deleteUnsafeCreateFields(effectData) {
    if (!effectData || typeof effectData !== "object") return effectData;

    delete effectData._id;
    delete effectData.id;
    delete effectData.folder;
    delete effectData.sort;
    delete effectData.ownership;
    delete effectData._stats;

    return effectData;
  }

  function normalizeNativeChanges(changes) {
    if (!changes) return [];

    if (Array.isArray(changes)) {
      return changes
        .filter(Boolean)
        .map(row => ({
          key: safeString(row.key),
          mode: Number(row.mode ?? modeValue("ADD")),
          value: String(row.value ?? ""),
          priority: Number(row.priority ?? 20)
        }))
        .filter(row => row.key);
    }

    if (typeof changes === "object") {
      return Object.entries(changes)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, row]) => row)
        .filter(Boolean)
        .map(row => ({
          key: safeString(row.key),
          mode: Number(row.mode ?? modeValue("ADD")),
          value: String(row.value ?? ""),
          priority: Number(row.priority ?? 20)
        }))
        .filter(row => row.key);
    }

    return [];
  }

  function normalizeStatuses(value) {
    if (value instanceof Set) return Array.from(value).map(String).filter(Boolean);
    if (Array.isArray(value)) return value.map(String).filter(Boolean);

    if (typeof value === "string") {
      return value
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    }

    return [];
  }

  function stripDraftPrefix(name) {
    return safeString(name, "Custom Active Effect")
      .replace(/^\[AEM Draft\]\s*/i, "")
      .trim() || "Custom Active Effect";
  }

  function categoryFromEffectData(effectData = {}) {
    return safeString(
      getProperty(effectData, `flags.${MODULE_ID}.category`) ??
      getProperty(effectData, `flags.${MODULE_ID}.activeEffectManager.sourceCategory`) ??
      getProperty(effectData, `flags.${MODULE_ID}.activeEffectManager.category`) ??
      effectData.category,
      "Other"
    );
  }

  function inferCategoryFromEffectData(effectData = {}) {
    const existing = categoryFromEffectData(effectData);
    if (existing && existing !== "Other") return existing;

    const text = [
      effectData.name,
      effectData.label,
      JSON.stringify(effectData.statuses ?? []),
      JSON.stringify(effectData.changes ?? [])
    ].join(" ").toLowerCase();

    if (/slow|dazed|weak|shaken|enraged|poison|poisoned|fatigue|bleed|burn|curse|blind|stun|debuff/.test(text)) {
      return "Debuff";
    }

    if (/swift|awake|strong|focus|clarity|energized|regen|shield|barrier|buff|up|boost/.test(text)) {
      return "Buff";
    }

    return "Other";
  }

  function stampFinalFlags(effectData, meta = {}) {
    const category = safeString(meta.category, inferCategoryFromEffectData(effectData));

    effectData.flags = effectData.flags || {};
    effectData.flags[MODULE_ID] = effectData.flags[MODULE_ID] || {};

    effectData.flags[MODULE_ID] = {
      ...(effectData.flags[MODULE_ID] ?? {}),
      category,
      customActiveEffect: true,
      activeEffectManager: {
        ...(effectData.flags[MODULE_ID]?.activeEffectManager ?? {}),

        managed: true,
        custom: true,
        sourceCategory: category,
        createdFromUi: true,
        createdFromNativeBuilder: true,
        createdAt: nowIso(),

        nativeBuilderVersion: api.version,
        draftActorUuid: meta.actor?.uuid ?? null,
        draftEffectId: meta.draftEffectId ?? null
      }
    };

    return effectData;
  }

  function sanitizeFinalEffectData(rawData = {}, meta = {}) {
    const data = clone(rawData, {});

    deleteUnsafeCreateFields(data);

    data.name = stripDraftPrefix(data.name ?? data.label);
    data.label = data.name;

    data.img = safeString(data.img ?? data.icon, "icons/svg/aura.svg");
    data.icon = data.img;

    // The draft document is disabled while editing so it does not affect the actor.
    // The queued final effect should normally be enabled unless the user explicitly
    // left Disabled checked on the native sheet.
    data.disabled = boolFromFormValue(meta.disabledFromForm, data.disabled ?? false);
    data.transfer = boolFromFormValue(data.transfer, false);

    data.changes = normalizeNativeChanges(data.changes);
    data.statuses = normalizeStatuses(data.statuses);

    data.duration = {
      ...(data.duration ?? {})
    };

    data.description = data.description ?? "";

    stampFinalFlags(data, {
      category: meta.category,
      actor: meta.actor,
      draftEffectId: meta.draftEffectId
    });

    return data;
  }

  function normalizeFormData(formData = {}) {
    try {
      if (foundry?.utils?.expandObject) {
        return foundry.utils.expandObject(clone(formData, {}));
      }
    } catch (_e) {}

    return clone(formData, {});
  }

  function mergeFormDataFallback(baseData = {}, formData = {}) {
    const expanded = normalizeFormData(formData);
    const out = clone(baseData, {});

    for (const key of ["name", "label", "img", "icon", "disabled", "transfer", "description"]) {
      if (expanded[key] !== undefined) out[key] = expanded[key];
    }

    if (expanded.duration) {
      out.duration = {
        ...(out.duration ?? {}),
        ...expanded.duration
      };
    }

    if (expanded.changes) {
      out.changes = normalizeNativeChanges(expanded.changes);
    }

    if (expanded.statuses) {
      out.statuses = normalizeStatuses(expanded.statuses);
    }

    return out;
  }

  function updateOutput(root, state, data) {
    const dom = getDomApi();

    if (typeof dom?.updateOutput === "function") {
      return dom.updateOutput(root, state, data);
    }

    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);

    if (state) state.outputText = text;

    const out = root?.querySelector?.("[data-aem-output]");
    if (out) out.value = text;

    return {
      ok: true,
      text
    };
  }

  // --------------------------------------------------------------------------
  // Actor / draft resolving
  // --------------------------------------------------------------------------

  async function resolveActor(ref) {
    if (!ref) return null;
    if (typeof ref !== "string") {
      if (ref.documentName === "Actor") return ref;
      if (ref.actor) return ref.actor;
      return null;
    }

    try {
      const doc = await fromUuid(ref);
      if (doc?.documentName === "Actor") return doc;
      if (doc?.actor) return doc.actor;
      if (doc?.object?.actor) return doc.object.actor;
      if (doc?.document?.actor) return doc.document.actor;
    } catch (_e) {}

    return null;
  }

  function getSelectedTokenActor() {
    return Array.from(canvas?.tokens?.controlled ?? [])
      .map(token => token.actor)
      .find(Boolean) ?? null;
  }

  function getFallbackOwnedActor() {
    if (game.user?.character) return game.user.character;

    return Array.from(game.actors ?? []).find(actor => {
      try {
        return game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER");
      } catch (_e) {
        return false;
      }
    }) ?? null;
  }

  async function resolveBuilderActor(options = {}) {
    const parentState = options.parentState ?? {};

    const candidates = [
      options.actorUuid,
      parentState.targetActorUuids?.[0],
      getSelectedTokenActor()?.uuid,
      getFallbackOwnedActor()?.uuid
    ].filter(Boolean);

    for (const candidate of candidates) {
      const actor = await resolveActor(candidate);
      if (actor) return actor;
    }

    return null;
  }

  function makeDraftEffectData(options = {}) {
    const duration =
      options.services?.getGlobalDurationFromState?.(options.parentState) ??
      {
        rounds: Number(options.parentState?.durationRounds) || 3,
        turns: Number(options.parentState?.durationTurns) || 0
      };

    const draftId = randomId("draft");

    const data = {
      name: "[AEM Draft] Custom Active Effect",
      label: "[AEM Draft] Custom Active Effect",
      img: "icons/svg/aura.svg",
      icon: "icons/svg/aura.svg",

      disabled: true,
      transfer: false,
      description: "",

      changes: [{
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      }],

      statuses: [],
      duration,

      flags: {
        [MODULE_ID]: {
          category: "Other",
          customActiveEffect: true,
          activeEffectManager: {
            managed: true,
            custom: true,
            nativeBuilderDraft: true,
            draftId,
            createdAt: nowIso()
          }
        }
      }
    };

    setProperty(data, DRAFT_FLAG_PATH, {
      id: draftId,
      createdAt: nowIso(),
      reason: "temporary-native-builder-draft"
    });

    return data;
  }

  async function createDraftEffect(actor, options = {}) {
    if (!actor) {
      return {
        ok: false,
        reason: "actor_not_found"
      };
    }

    const draftData = makeDraftEffectData(options);

    const [draft] = await actor.createEmbeddedDocuments("ActiveEffect", [draftData], {
      render: false
    });

    if (!draft) {
      return {
        ok: false,
        reason: "draft_create_failed"
      };
    }

    return {
      ok: true,
      actor,
      draft,
      draftData
    };
  }

  async function deleteDraft(actor, draft) {
    if (!actor || !draft?.id) return false;

    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [draft.id], {
        render: false
      });

      return true;
    } catch (e) {
      warn("Could not delete temporary native builder draft.", {
        actor: actor?.name,
        draft: draft?.name,
        error: compactError(e)
      });

      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Native suggestion CSS/dropdown
  // --------------------------------------------------------------------------

  function getSheetRoot(sheet) {
    return normalizeHtmlRoot(sheet?.element) ??
      document.getElementById(sheet?.id) ??
      document.querySelector(`[data-appid="${sheet?.appId}"]`) ??
      document.querySelector(`#app-${sheet?.appId}`) ??
      null;
  }

  // --------------------------------------------------------------------------
  // Sheet patch / submit capture
  // --------------------------------------------------------------------------

  function getSheetDocument(sheet) {
    return sheet?.document ?? sheet?.object ?? null;
  }

  async function refreshDraftDocument(actor, draft) {
    if (!actor || !draft?.id) return draft;
    return actor.effects?.get?.(draft.id) ?? draft;
  }

  async function readDraftDataAfterSubmit(actor, draft, formData = {}) {
    const fresh = await refreshDraftDocument(actor, draft);

    let raw = {};

    try {
      raw = clone(fresh?.toObject?.(), {});
    } catch (_e) {
      raw = clone(fresh, {});
    }

    if (!raw || !Object.keys(raw).length) {
      raw = mergeFormDataFallback({}, formData);
    } else {
      raw = mergeFormDataFallback(raw, formData);
    }

    return raw;
  }

  function patchSheetUpdateObject(sheet, session) {
    if (!sheet || sheet.__oniAemNativeBuilderPatched) return;

    const originalUpdateObject = sheet._updateObject?.bind(sheet);

    sheet.__oniAemNativeBuilderPatched = true;
    sheet.__oniAemNativeBuilderOriginalUpdateObject = originalUpdateObject;

    sheet._updateObject = async function patchedAemNativeBuilderUpdateObject(event, formData) {
      if (session.finished) {
        if (typeof originalUpdateObject === "function") {
          return await originalUpdateObject(event, formData);
        }
        return null;
      }

      session.submitStarted = true;

      try {
        // Let the native sheet do its normal validation/data shaping first.
        // Then we read the draft document and queue its final data.
        if (typeof originalUpdateObject === "function") {
          await originalUpdateObject(event, formData);
        } else {
          const document = getSheetDocument(sheet);
          if (document?.update) {
            await document.update(formData);
          }
        }

        const raw = await readDraftDataAfterSubmit(session.actor, session.draft, formData);

        const expanded = normalizeFormData(formData);
        const finalEffectData = sanitizeFinalEffectData(raw, {
          actor: session.actor,
          draftEffectId: session.draft?.id ?? null,
          disabledFromForm:
            expanded.disabled ??
            formData?.disabled ??
            false
        });

        await queueFinalEffect(session, finalEffectData);

        await finishSession(session, {
          closeSheet: false,
          deleteDraft: true,
          reason: "submit"
        });

        return null;
      } catch (e) {
        err("Native custom effect submit failed.", e);

        const report = {
          ok: false,
          reason: "native_custom_effect_submit_failed",
          error: compactError(e)
        };

        updateOutput(session.parentRoot, session.parentState, report);

        ui.notifications?.error?.("Active Effect Manager: native sheet submit failed. Check console.");

        throw e;
      }
    };

    session.cleanupFns.push(() => {
      try {
        if (sheet.__oniAemNativeBuilderPatched) {
          sheet._updateObject = sheet.__oniAemNativeBuilderOriginalUpdateObject;
          delete sheet.__oniAemNativeBuilderPatched;
          delete sheet.__oniAemNativeBuilderOriginalUpdateObject;
        }
      } catch (_e) {}
    });
  }

  function patchSheetClose(sheet, session) {
    if (!sheet || sheet.__oniAemNativeBuilderClosePatched) return;

    const originalClose = sheet.close?.bind(sheet);

    sheet.__oniAemNativeBuilderClosePatched = true;
    sheet.__oniAemNativeBuilderOriginalClose = originalClose;

    sheet.close = async function patchedAemNativeBuilderClose(...args) {
      try {
        if (!session.finished && !session.submitStarted) {
          await finishSession(session, {
            closeSheet: false,
            deleteDraft: true,
            reason: "close_without_submit"
          });
        }
      } catch (e) {
        warn("Native builder close cleanup failed.", e);
      }

      if (typeof originalClose === "function") {
        return await originalClose(...args);
      }

      return null;
    };

    session.cleanupFns.push(() => {
      try {
        if (sheet.__oniAemNativeBuilderClosePatched) {
          sheet.close = sheet.__oniAemNativeBuilderOriginalClose;
          delete sheet.__oniAemNativeBuilderClosePatched;
          delete sheet.__oniAemNativeBuilderOriginalClose;
        }
      } catch (_e) {}
    });
  }

  async function queueFinalEffect(session, finalEffectData) {
    const category = inferCategoryFromEffectData(finalEffectData);

    const meta = {
      category,
      actorUuid: session.actor?.uuid ?? null,
      draftEffectId: session.draft?.id ?? null
    };

    if (typeof session.onAddEffect === "function") {
      session.onAddEffect(finalEffectData, meta);
    } else {
      session.parentState.selectedEffects ??= [];
      session.parentState.selectedEffects.push({
        id: randomId("selected"),
        kind: "custom",
        name: finalEffectData.name,
        img: finalEffectData.img || finalEffectData.icon || "icons/svg/aura.svg",
        category,
        effectData: clone(finalEffectData, {})
      });
    }

    const report = {
      ok: true,
      action: "queue_native_custom_effect",
      effectName: finalEffectData.name,
      category,
      changes: finalEffectData.changes ?? [],
      statuses: finalEffectData.statuses ?? [],
      actor: {
        uuid: session.actor?.uuid ?? null,
        name: session.actor?.name ?? null
      }
    };

    updateOutput(session.parentRoot, session.parentState, report);

    ui.notifications?.info?.(`Queued custom effect: ${finalEffectData.name}`);

    return report;
  }

async function installIntoSheet(session) {
  const root = getSheetRoot(session.sheet);
  if (!root) return false;

  const keySuggestionReport = await installGlobalKeySuggestionsForSheet(
    session.sheet,
    session.actor
  );

  session.fieldEntries = keySuggestionReport.entries ?? [];

  if (!keySuggestionReport.ok) {
    warn(
      "Global key suggestion installer was not available. Native sheet will open without smart suggestions.",
      keySuggestionReport
    );
  }

  // Visually default the final queued effect to enabled while the real draft
  // remains disabled on the actor.
  const disabledBox = root.querySelector('input[name="disabled"]');
  if (disabledBox && !disabledBox.dataset.oniAemNativeDefaulted) {
    disabledBox.dataset.oniAemNativeDefaulted = "1";
    disabledBox.checked = false;
  }

  const nameInput = root.querySelector('input[name="name"]');
  if (nameInput && /^\[AEM Draft\]\s*/i.test(nameInput.value)) {
    nameInput.value = nameInput.value.replace(/^\[AEM Draft\]\s*/i, "");
  }

  log("Installed native builder helpers into ActiveEffect sheet.", {
    actor: session.actor?.name,
    draft: session.draft?.name,
    fields: keySuggestionReport.installReport?.fields ?? null,
    fieldSuggestions: session.fieldEntries.length
  });

  return true;
}

  function installRenderHooks(session) {
    const hookNames = [
      "renderActiveEffectConfig",
      "renderCustomActiveEffectConfig"
    ];

    for (const name of hookNames) {
      const id = Hooks.on(name, app => {
        if (app !== session.sheet) return;

        installIntoSheet(session).catch(e => {
          warn("Could not install native builder helpers after render hook.", e);
        });
      });

      session.hookIds.push({
        name,
        id
      });
    }

    session.cleanupFns.push(() => {
      for (const row of session.hookIds) {
        try {
          Hooks.off(row.name, row.id);
        } catch (_e) {}
      }

      session.hookIds = [];
    });
  }

  async function finishSession(session, options = {}) {
    if (!session || session.finished) return;

    session.finished = true;

    const closeSheet = options.closeSheet === true;
    const deleteTheDraft = options.deleteDraft !== false;

    if (deleteTheDraft) {
      await deleteDraft(session.actor, session.draft);
    }

    for (const fn of session.cleanupFns.splice(0)) {
      try {
        fn();
      } catch (e) {
        warn("Native builder cleanup function failed.", e);
      }
    }

    if (closeSheet) {
      try {
        await session.sheet?.close?.();
      } catch (_e) {}
    }

    if (ACTIVE_SESSION === session) ACTIVE_SESSION = null;

    log("Finished native builder session.", {
      reason: options.reason ?? "unknown",
      deletedDraft: deleteTheDraft
    });
  }

  // --------------------------------------------------------------------------
  // Main open
  // --------------------------------------------------------------------------

  async function openForQueue(options = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Active Effect Manager native builder is GM-only.");
      return null;
    }

    if (ACTIVE_SESSION && !ACTIVE_SESSION.finished) {
      try {
        ACTIVE_SESSION.sheet?.bringToTop?.();
        return ACTIVE_SESSION.sheet;
      } catch (_e) {
        ACTIVE_SESSION = null;
      }
    }

    const actor = await resolveBuilderActor(options);

    if (!actor) {
      const report = {
        ok: false,
        reason: "native_builder_actor_not_found",
        hint: "Select a token or select at least one target actor before opening the native builder."
      };

      updateOutput(options.root, options.parentState, report);
      ui.notifications?.warn?.("Active Effect Manager: no actor found for native builder draft.");
      return null;
    }

    const draftResult = await createDraftEffect(actor, options);

    if (!draftResult.ok) {
      updateOutput(options.root, options.parentState, draftResult);
      ui.notifications?.error?.("Active Effect Manager: could not create native builder draft.");
      return null;
    }

    const draft = draftResult.draft;
    const sheet = draft.sheet;

    if (!sheet?.render) {
      await deleteDraft(actor, draft);

      const report = {
        ok: false,
        reason: "active_effect_sheet_not_found"
      };

      updateOutput(options.root, options.parentState, report);
      ui.notifications?.error?.("Active Effect Manager: ActiveEffect sheet not found.");
      return null;
    }

    const session = {
      id: randomId("session"),
      actor,
      draft,
      sheet,

      parentState: options.parentState ?? {},
      parentRoot: options.root ?? null,
      services: options.services ?? {},
      onAddEffect: options.onAddEffect ?? null,

      fieldEntries: [],

      dropdown: null,
      observer: null,
      hookIds: [],
      cleanupFns: [],

      finished: false,
      submitStarted: false
    };

    ACTIVE_SESSION = session;

    patchSheetUpdateObject(sheet, session);
    patchSheetClose(sheet, session);
    installRenderHooks(session);

    try {
      sheet.render(true);

      // Run shortly after render because some custom sheets do not fire the same
      // hook name consistently.
      setTimeout(() => {
        if (!session.finished) {
          installIntoSheet(session).catch(e => {
            warn("Delayed native builder install failed.", e);
          });
        }
      }, 60);

      setTimeout(() => {
        if (!session.finished) {
          installIntoSheet(session).catch(e => {
            warn("Second delayed native builder install failed.", e);
          });
        }
      }, 350);

      updateOutput(options.root, options.parentState, {
        ok: true,
        action: "open_native_active_effect_builder",
        actor: {
          uuid: actor.uuid,
          name: actor.name
        },
        draft: {
          id: draft.id,
          name: draft.name
        },
        hint: "Edit the native Active Effect sheet, then press Save. The draft will be queued in AEM and deleted from the actor."
      });

      return sheet;
    } catch (e) {
      await finishSession(session, {
        closeSheet: false,
        deleteDraft: true,
        reason: "render_failed"
      });

      const report = {
        ok: false,
        reason: "native_sheet_render_failed",
        error: compactError(e)
      };

      updateOutput(options.root, options.parentState, report);
      ui.notifications?.error?.("Active Effect Manager: native sheet failed to open.");

      return null;
    }
  }

  async function open(options = {}) {
    return openForQueue(options);
  }

  async function cancelActiveSession() {
    if (!ACTIVE_SESSION) {
      return {
        ok: false,
        reason: "no_active_session"
      };
    }

    const session = ACTIVE_SESSION;

    await finishSession(session, {
      closeSheet: true,
      deleteDraft: true,
      reason: "manual_cancel"
    });

    return {
      ok: true
    };
  }

  function getActiveSessionInfo() {
    const session = ACTIVE_SESSION;

    if (!session) return null;

    return {
      id: session.id,
      finished: !!session.finished,
      actor: {
        uuid: session.actor?.uuid ?? null,
        name: session.actor?.name ?? null
      },
      draft: {
        id: session.draft?.id ?? null,
        name: session.draft?.name ?? null
      },
      sheet: {
        id: session.sheet?.id ?? null,
        appId: session.sheet?.appId ?? null
      },
      fieldEntryCount: session.fieldEntries?.length ?? 0
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.1",

    openForQueue,
    open,

    cancelActiveSession,
    getActiveSessionInfo,

    _internal: {
      clone,
      safeString,
      randomId,
      nowIso,
      compactError,
      getProperty,
      setProperty,
      modeValue,
      boolFromFormValue,
      normalizeHtmlRoot,
      deleteUnsafeCreateFields,
      normalizeNativeChanges,
      normalizeStatuses,
      stripDraftPrefix,
      stampFinalFlags,
      sanitizeFinalEffectData,
      resolveBuilderActor,
      createDraftEffect,
      deleteDraft,
      getSheetRoot,
      patchSheetUpdateObject,
      patchSheetClose,
      installIntoSheet,
      finishSession
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager UI Native Builder module installed.", {
      api: "FUCompanion.api.activeEffectManager.uiParts.nativeBuilder"
    });
  });
})();