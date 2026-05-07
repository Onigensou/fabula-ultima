// ============================================================================
// ActiveEffectManager-api.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Core backend API for applying/removing/toggling/modifying real ActiveEffect
//   documents on Actors.
// - Uses the dynamic registry when possible.
// - Does NOT hardcode Slow/Dazed/etc.
// - Does NOT touch legacy condition booleans like isSlow/isDazed.
// - Actor-first: works on Actors even when they have no token on the scene.
//
// Depends on:
// - ActiveEffectManager-registry.js
//
// Optional later dependencies:
// - ActiveEffectManager-chat.js
// - ActiveEffectManager-fx.js
//
// Public API:
//   FUCompanion.api.activeEffectManager.applyEffects(...)
//   FUCompanion.api.activeEffectManager.removeEffects(...)
//   FUCompanion.api.activeEffectManager.toggleEffects(...)
//   FUCompanion.api.activeEffectManager.modifyExistingEffect(...)
//   FUCompanion.api.activeEffectManager.resolveActors(...)
//   FUCompanion.api.activeEffectManager.findDuplicatesOnActor(...)
//   FUCompanion.api.activeEffectManager.listActorEffects(...)
//
// Example:
//   await FUCompanion.api.activeEffectManager.applyEffects({
//     actorUuids: ["Actor.dafTLBUscCDNgq8H"],
//     effects: ["Slow"],
//     duplicateMode: "skip",
//     duration: { rounds: 3, turns: 0 }
//   });
//
// Example with registry ID:
//   await FUCompanion.api.activeEffectManager.applyEffects({
//     actorUuids: ["Actor.dafTLBUscCDNgq8H"],
//     effects: ["Item.xxxxx.ActiveEffect.yyyyy"],
//     duplicateMode: "replace"
//   });
//
// Example custom modifier:
//   await FUCompanion.api.activeEffectManager.applyEffects({
//     actorUuids: ["Actor.dafTLBUscCDNgq8H"],
//     effects: [{
//       effectData: {
//         name: "Defense Boost",
//         img: "icons/svg/shield.svg",
//         changes: [
//           { key: "defense", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "2", priority: 20 }
//         ],
//         duration: { rounds: 3, turns: 0 }
//       }
//     }],
//     duplicateMode: "replace"
//   });
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:API]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  const VALID_DUPLICATE_MODES = new Set([
    "skip",
    "replace",
    "stack",
    "remove",
    "ask"
  ]);

  const DEFAULT_OPTIONS = {
    duplicateMode: "skip",

    // If true, duplicate matching can use status IDs as backup.
    // Kept false by default to avoid broad matches.
    matchByStatus: false,

    // Later chat/fx scripts can hook into these.
    renderChat: true,
    playFx: true,

    silent: false,

    // If true, skip permission warning noise.
    quiet: false,

    sourceUserId: null,
    sourceName: null
  };

  // --------------------------------------------------------------------------
  // API root
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager = globalThis.FUCompanion.api.activeEffectManager || {};
    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();

    // Main API lives directly on activeEffectManager for easy use.
    Object.assign(root, api);

    // Also expose as named namespaces for clarity.
    root.api = api;
    root.core = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        Object.assign(mod.api.activeEffectManager, api);
        mod.api.activeEffectManager.api = api;
        mod.api.activeEffectManager.core = api;
      }
    } catch (e) {
      warn("Could not expose API on module object.", e);
    }
  }

  function getRegistryApi() {
    const apiRoot = globalThis.FUCompanion?.api ?? {};

    return (
      apiRoot.activeEffectManager?.registry ??
      apiRoot.activeEffectRegistry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.registry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectRegistry ??
      null
    );
  }

  // --------------------------------------------------------------------------
  // General helpers
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

  function nowIso() {
    return new Date().toISOString();
  }

  function nowRunId(prefix = "AEM") {
    const rnd =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${Date.now().toString(36)}-${rnd}`;
  }

  function normalizeName(value) {
    return safeString(value).toLowerCase().replace(/\s+/g, " ");
  }

  function normalizeId(value) {
    return safeString(value).toLowerCase();
  }

  function getProperty(obj, path, fallback = undefined) {
    try {
      if (foundry?.utils?.getProperty) {
        const v = foundry.utils.getProperty(obj, path);
        return v === undefined ? fallback : v;
      }
    } catch (_e) {}

    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch (_e) {
      return fallback;
    }
  }

  function mergeObject(target, source) {
    if (!source || typeof source !== "object") return clone(target, {});

    try {
      return foundry.utils.mergeObject(clone(target, {}), clone(source, {}), {
        inplace: false,
        recursive: true,
        insertKeys: true,
        insertValues: true,
        overwrite: true
      });
    } catch (_e) {
      return {
        ...(clone(target, {}) ?? {}),
        ...(clone(source, {}) ?? {})
      };
    }
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

  function compactEffectDoc(effect) {
    if (!effect) return null;

    return {
      id: effect.id ?? null,
      uuid: effect.uuid ?? null,
      name: effect.name ?? effect.label ?? null,
      img: effect.img ?? effect.icon ?? null,
      disabled: !!effect.disabled,
      origin: effect.origin ?? null,
      statuses: Array.from(effect.statuses ?? [])
    };
  }

  function compactActor(actor) {
    if (!actor) return null;

    return {
      id: actor.id ?? null,
      uuid: actor.uuid ?? null,
      name: actor.name ?? null,
      type: actor.type ?? null
    };
  }

  function getEffectRaw(effect) {
    if (!effect) return {};

    try {
      if (typeof effect.toObject === "function") {
        return clone(effect.toObject(), {});
      }
    } catch (_e) {}

    return clone(effect, {});
  }

  function getEffectName(effectLike) {
    return safeString(
      effectLike?.name ??
      effectLike?.label ??
      effectLike?.id ??
      "Unnamed Effect"
    );
  }

  function getEffectImg(effectLike) {
    return safeString(
      effectLike?.img ??
      effectLike?.icon ??
      "icons/svg/aura.svg"
    );
  }

  function getEffectStatuses(effectLike, raw = null) {
    const data = raw ?? getEffectRaw(effectLike);

    return uniq([
      ...asArray(effectLike?.statuses),
      ...asArray(data?.statuses),
      data?.status
    ]);
  }

  function getCanonicalIdsFromEffect(effectLike, raw = null) {
    const data = raw ?? getEffectRaw(effectLike);
    const flags = data?.flags ?? effectLike?.flags ?? {};

    return uniq([
      effectLike?.uuid,
      effectLike?.id,
      data?.uuid,
      data?._id,
      data?.id,
      data?.origin,

      getProperty(flags, "core.sourceId"),
      getProperty(flags, "core.uuid"),
      getProperty(data, "_stats.compendiumSource"),

      getProperty(flags, "custom-system-builder.originalUuid"),
      getProperty(flags, "custom-system-builder.originalParentId"),
      getProperty(flags, "custom-system-builder.originalId"),

      getProperty(flags, "dfreds-convenient-effects.ceEffectId"),
      getProperty(flags, "dfreds-convenient-effects.originalEffectId"),

      getProperty(flags, `${MODULE_ID}.registryId`),
      getProperty(flags, `${MODULE_ID}.sourceEffectUuid`),
      getProperty(flags, `${MODULE_ID}.sourceEffId`),

      getProperty(flags, `${MODULE_ID}.activeEffectManager.registryId`),
      getProperty(flags, `${MODULE_ID}.activeEffectManager.sourceEffectUuid`),
      getProperty(flags, `${MODULE_ID}.activeEffectManager.sourceEffId`)
    ]);
  }

  // --------------------------------------------------------------------------
  // Document resolving
  // --------------------------------------------------------------------------

  async function resolveDocument(uuidOrDoc) {
    if (!uuidOrDoc) return null;
    if (typeof uuidOrDoc !== "string") return uuidOrDoc;

    try {
      return await fromUuid(uuidOrDoc);
    } catch (e) {
      warn("fromUuid failed.", {
        uuidOrDoc,
        error: String(e?.message ?? e)
      });
      return null;
    }
  }

  async function resolveActor(actorOrUuid) {
    const doc = await resolveDocument(actorOrUuid);
    if (!doc) return null;

    if (doc.documentName === "Actor") return doc;
    if (doc.actor) return doc.actor;
    if (doc.object?.actor) return doc.object.actor;
    if (doc.document?.actor) return doc.document.actor;

    return null;
  }

  async function resolveToken(tokenOrUuid) {
    const doc = await resolveDocument(tokenOrUuid);
    if (!doc) return null;

    if (doc.documentName === "Token" || doc.documentName === "TokenDocument") {
      return doc.object ?? doc;
    }

    if (doc.document?.documentName === "Token") return doc;
    if (doc.object?.document?.documentName === "Token") return doc.object;

    return null;
  }

  function getSelectedActors() {
    return Array.from(canvas?.tokens?.controlled ?? [])
      .map(t => t.actor)
      .filter(Boolean);
  }

  async function resolveActors(input = {}) {
    const actors = [];

    const actorRefs = [
      ...asArray(input.actor),
      ...asArray(input.actors),
      ...asArray(input.actorUuid),
      ...asArray(input.actorUuids),
      ...asArray(input.targetActorUuid),
      ...asArray(input.targetActorUuids)
    ];

    for (const ref of actorRefs) {
      const actor = await resolveActor(ref);
      if (actor) actors.push(actor);
    }

    const tokenRefs = [
      ...asArray(input.token),
      ...asArray(input.tokens),
      ...asArray(input.tokenUuid),
      ...asArray(input.tokenUuids),
      ...asArray(input.targetUuid),
      ...asArray(input.targetUuids),
      ...asArray(input.targetTokenUuid),
      ...asArray(input.targetTokenUuids)
    ];

    for (const ref of tokenRefs) {
      const token = await resolveToken(ref);
      if (token?.actor) actors.push(token.actor);
    }

    if (input.useSelected === true || (!actors.length && input.fallbackToSelected === true)) {
      actors.push(...getSelectedActors());
    }

    const byUuid = new Map();

    for (const actor of actors) {
      if (!actor?.uuid) continue;
      byUuid.set(actor.uuid, actor);
    }

    return Array.from(byUuid.values());
  }

  function canModifyActor(actor) {
    if (!actor) return false;
    if (game.user?.isGM) return true;

    try {
      return actor.testUserPermission?.(game.user, "OWNER") === true;
    } catch (_e) {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Registry / effect normalization
  // --------------------------------------------------------------------------

  async function ensureRegistryReady() {
    const registry = getRegistryApi();
    if (!registry) return null;

    try {
      const all = typeof registry.getAll === "function"
        ? registry.getAll({ cloneResult: false })
        : [];

      if (!Array.isArray(all) || !all.length) {
        if (typeof registry.refresh === "function") {
          await registry.refresh();
        }
      }
    } catch (_e) {}

    return registry;
  }

  function findRegistryEntryLoose(registry, value) {
    if (!registry || value == null) return null;

    const raw = safeString(value);
    if (!raw) return null;

    try {
      const byId = registry.getById?.(raw, { cloneResult: false });
      if (byId) return byId;
    } catch (_e) {}

    try {
      const byName = registry.findByName?.(raw, {
        exact: true,
        cloneResult: false
      });

      if (Array.isArray(byName) && byName.length) return byName[0];
    } catch (_e) {}

    try {
      const search = registry.search?.(raw, {
        limit: 1,
        cloneResult: false
      });

      if (Array.isArray(search) && search.length) return search[0];
    } catch (_e) {}

    return null;
  }

  function looksLikeEffectData(value) {
    if (!value || typeof value !== "object") return false;

    return !!(
      value.name ||
      value.label ||
      value.img ||
      value.icon ||
      Array.isArray(value.changes) ||
      value.duration ||
      value.statuses ||
      value.flags
    );
  }

  function normalizeDuration(duration) {
    if (!duration || typeof duration !== "object") return null;

    const out = clone(duration, {});

    for (const key of ["rounds", "turns", "seconds", "startRound", "startTurn"]) {
      if (out[key] !== undefined && out[key] !== null && out[key] !== "") {
        const n = Number(out[key]);
        if (Number.isFinite(n)) out[key] = n;
      }
    }

    return out;
  }

  function cleanChanges(changes) {
    if (!Array.isArray(changes)) return [];

    return changes
      .filter(c => c && typeof c === "object")
      .map(c => ({
        key: safeString(c.key),
        mode: Number(c.mode ?? CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2),
        value: String(c.value ?? ""),
        priority: Number(c.priority ?? 20)
      }))
      .filter(c => c.key);
  }

  function stampManagerFlags(effectData, meta = {}) {
    effectData.flags = effectData.flags || {};
    effectData.flags[MODULE_ID] = effectData.flags[MODULE_ID] || {};

    effectData.flags[MODULE_ID].activeEffectManager = {
      ...(effectData.flags[MODULE_ID].activeEffectManager ?? {}),

      managed: true,

      registryId: meta.registryId ?? null,
      sourceEffectUuid: meta.sourceEffectUuid ?? null,
      sourceEffId: meta.sourceEffId ?? meta.sourceEffectUuid ?? meta.registryId ?? null,
      sourceName: meta.sourceName ?? effectData.name ?? null,
      sourceCategory: meta.sourceCategory ?? meta.category ?? null,

      appliedAt: nowIso(),
      appliedByUserId: game.userId ?? null,
      appliedByUserName: game.user?.name ?? null
    };

    // Convenient flat aliases for older/future lookup.
    effectData.flags[MODULE_ID].registryId =
      effectData.flags[MODULE_ID].registryId ??
      meta.registryId ??
      null;

    effectData.flags[MODULE_ID].sourceEffectUuid =
      effectData.flags[MODULE_ID].sourceEffectUuid ??
      meta.sourceEffectUuid ??
      null;

    effectData.flags[MODULE_ID].sourceEffId =
      effectData.flags[MODULE_ID].sourceEffId ??
      meta.sourceEffId ??
      meta.sourceEffectUuid ??
      meta.registryId ??
      null;

    return effectData;
  }

    function parseActiveEffectUuidParts(uuid) {
    const raw = safeString(uuid);
    if (!raw || !raw.includes(".ActiveEffect.")) return null;

    const parts = raw.split(".");
    const aeIndex = parts.indexOf("ActiveEffect");

    if (aeIndex < 2 || aeIndex + 1 >= parts.length) return null;

    return {
      parentType: parts[aeIndex - 2] ?? null,
      parentId: parts[aeIndex - 1] ?? null,
      effectId: parts[aeIndex + 1] ?? null,
      originalUuid: raw
    };
  }

  function stampCustomSystemBuilderFlags(effectData, { entry = null, overrides = {}, origin = null } = {}) {
    effectData.flags = effectData.flags || {};

    const csbScope = "custom-system-builder";
    const existing = clone(effectData.flags[csbScope] ?? {}, {});

    const candidateUuid =
      existing.originalUuid ??
      entry?.effectUuid ??
      entry?.sourceUuid ??
      entry?.registryId ??
      overrides.sourceEffectUuid ??
      overrides.sourceEffId ??
      origin ??
      effectData.origin ??
      null;

    const parsed = parseActiveEffectUuidParts(candidateUuid);

    const originalUuid =
      existing.originalUuid ??
      parsed?.originalUuid ??
      candidateUuid ??
      null;

    const originalParentId =
      existing.originalParentId ??
      parsed?.parentId ??
      entry?.parentId ??
      entry?.sourceParentId ??
      null;

    const originalId =
      existing.originalId ??
      parsed?.effectId ??
      entry?.effectId ??
      entry?.sourceEffId ??
      null;

    effectData.flags[csbScope] = {
      ...existing,

      // These are the exact keys Custom System Builder is currently setting
      // after creation. Pre-stamping them lets our compat guard skip the costly
      // post-create setFlag calls.
      originalParentId,
      originalId,
      originalUuid,
      isFromTemplate: existing.isFromTemplate ?? false
    };

    return effectData;
  }

  function finalizeEffectData(effectData, {
    entry = null,
    overrides = {},
    duration = null,
    origin = null,
    category = null
  } = {}) {
    const data = clone(effectData, {});

    deleteUnsafeCreateFields(data);

    const name = safeString(
      overrides.name ??
      data.name ??
      data.label ??
      entry?.name ??
      "Custom Active Effect"
    );

    const img = safeString(
      overrides.img ??
      overrides.icon ??
      data.img ??
      data.icon ??
      entry?.img ??
      "icons/svg/aura.svg"
    );

    data.name = name;
    data.label = name;
    data.img = img;
    data.icon = img;

    data.disabled = !!(overrides.disabled ?? data.disabled ?? false);
    data.transfer = !!(overrides.transfer ?? data.transfer ?? false);

    if (origin !== undefined && origin !== null) {
      data.origin = origin;
    } else if (overrides.origin !== undefined) {
      data.origin = overrides.origin;
    } else {
      data.origin = data.origin ?? entry?.sourceUuid ?? null;
    }

    if (Array.isArray(overrides.changes)) {
      data.changes = cleanChanges(overrides.changes);
    } else {
      data.changes = cleanChanges(data.changes ?? []);
    }

    if (Array.isArray(overrides.statuses)) {
      data.statuses = uniq(overrides.statuses);
    } else {
      data.statuses = uniq(data.statuses ?? []);
    }

    const durationOverride = normalizeDuration(overrides.duration ?? duration);
    if (durationOverride) {
      data.duration = {
        ...(data.duration ?? {}),
        ...durationOverride
      };
    } else {
      data.duration = data.duration ?? {};
    }

    if (overrides.description !== undefined) {
      data.description = overrides.description;
    } else {
      data.description = data.description ?? "";
    }

    data.flags = mergeObject(data.flags ?? {}, overrides.flags ?? {});

    stampManagerFlags(data, {
      registryId: entry?.registryId ?? overrides.registryId ?? null,
      sourceEffectUuid: entry?.effectUuid ?? overrides.sourceEffectUuid ?? null,
      sourceEffId:
        entry?.effectUuid ??
        entry?.effectId ??
        entry?.registryId ??
        overrides.sourceEffId ??
        null,
      sourceName: entry?.name ?? name,
      sourceCategory: category ?? entry?.category ?? overrides.category ?? null
    });

    stampCustomSystemBuilderFlags(data, {
      entry,
      overrides,
      origin: data.origin
    });

    return data;
  }

  async function normalizeEffectInput(effectInput, globalOptions = {}) {
    const registry = await ensureRegistryReady();

    const duration = normalizeDuration(
      effectInput?.duration ??
      effectInput?.overrides?.duration ??
      globalOptions.duration
    );

    const overrides = {
      ...(globalOptions.effectOverrides ?? {}),
      ...(effectInput?.overrides ?? {})
    };

    let entry = null;
    let baseEffectData = null;

    if (typeof effectInput === "string") {
      entry = findRegistryEntryLoose(registry, effectInput);

      if (!entry) {
        return {
          ok: false,
          reason: "registry_entry_not_found",
          input: effectInput
        };
      }

      if (registry?.cloneEffectDataForApplication) {
        const cloned = registry.cloneEffectDataForApplication(entry, {
          ...overrides,
          duration
        });

        if (cloned?.ok && cloned.effectData) {
          baseEffectData = cloned.effectData;
        }
      }

      if (!baseEffectData) {
        baseEffectData = clone(entry.effectData, {});
      }
    }

    else if (effectInput?.registryId || effectInput?.sourceEffId || effectInput?.effectUuid) {
      const id =
        effectInput.registryId ??
        effectInput.sourceEffId ??
        effectInput.effectUuid;

      entry = findRegistryEntryLoose(registry, id);

      if (entry) {
        if (registry?.cloneEffectDataForApplication) {
          const cloned = registry.cloneEffectDataForApplication(entry, {
            ...overrides,
            duration
          });

          if (cloned?.ok && cloned.effectData) {
            baseEffectData = cloned.effectData;
          }
        }

        if (!baseEffectData) {
          baseEffectData = clone(entry.effectData, {});
        }
      } else if (effectInput.effectData) {
        baseEffectData = clone(effectInput.effectData, {});
      } else {
        return {
          ok: false,
          reason: "registry_entry_not_found",
          input: effectInput
        };
      }
    }

    else if (effectInput?.effectData) {
      entry = effectInput.entry ?? null;
      baseEffectData = clone(effectInput.effectData, {});
    }

    else if (effectInput?.registryId && effectInput?.effectData) {
      entry = findRegistryEntryLoose(registry, effectInput.registryId);
      baseEffectData = clone(effectInput.effectData, {});
    }

    else if (looksLikeEffectData(effectInput)) {
      baseEffectData = clone(effectInput, {});
    }

    if (!baseEffectData) {
      return {
        ok: false,
        reason: "invalid_effect_input",
        input: effectInput
      };
    }

    const effectData = finalizeEffectData(baseEffectData, {
      entry,
      overrides,
      duration,
      origin: globalOptions.origin ?? effectInput?.origin ?? null,
      category: effectInput?.category ?? globalOptions.category ?? null
    });

    const identity = buildEffectIdentity({
      entry,
      effectData,
      sourceInput: effectInput
    });

    return {
      ok: true,
      entry: entry ? clone(entry, null) : null,
      effectData,
      identity,
      duplicateMode: safeString(
        effectInput?.duplicateMode ??
        globalOptions.duplicateMode ??
        DEFAULT_OPTIONS.duplicateMode
      )
    };
  }

  async function normalizeEffectInputs(effectsInput, globalOptions = {}) {
    const rawEffects =
      Array.isArray(effectsInput)
        ? effectsInput
        : effectsInput != null
          ? [effectsInput]
          : [];

    const normalized = [];

    for (const effectInput of rawEffects) {
      const row = await normalizeEffectInput(effectInput, globalOptions);
      normalized.push(row);
    }

    return normalized;
  }

  // --------------------------------------------------------------------------
  // Identity / duplicate matching
  // --------------------------------------------------------------------------

  function buildEffectIdentity({ entry = null, effectData = {}, sourceInput = null } = {}) {
    const name = getEffectName(effectData);
    const raw = effectData ?? {};
    const flags = raw.flags ?? {};

    const canonicalIds = uniq([
      entry?.registryId,
      entry?.effectUuid,
      entry?.effectId,
      ...(entry?.canonicalIds ?? []),

      sourceInput?.registryId,
      sourceInput?.effectUuid,
      sourceInput?.sourceEffId,

      getProperty(flags, `${MODULE_ID}.registryId`),
      getProperty(flags, `${MODULE_ID}.sourceEffectUuid`),
      getProperty(flags, `${MODULE_ID}.sourceEffId`),

      getProperty(flags, `${MODULE_ID}.activeEffectManager.registryId`),
      getProperty(flags, `${MODULE_ID}.activeEffectManager.sourceEffectUuid`),
      getProperty(flags, `${MODULE_ID}.activeEffectManager.sourceEffId`),

      raw.origin
    ]);

    return {
      name,
      normalizedName: normalizeName(name),
      statuses: getEffectStatuses(effectData, raw),
      canonicalIds,
      category:
        entry?.category ??
        getProperty(flags, `${MODULE_ID}.activeEffectManager.sourceCategory`) ??
        getProperty(flags, `${MODULE_ID}.category`) ??
        null
    };
  }

  function effectMatchesIdentity(effect, identity, options = {}) {
    const raw = getEffectRaw(effect);

    const effectName = normalizeName(getEffectName(effect));
    const wantedName = normalizeName(identity?.name);

    const effectIds = new Set(
      getCanonicalIdsFromEffect(effect, raw).map(normalizeId)
    );

    const wantedIds = uniq(identity?.canonicalIds ?? []).map(normalizeId);

    const sameId = wantedIds.some(id => id && effectIds.has(id));
    const sameName = !!wantedName && !!effectName && wantedName === effectName;

    let sameStatus = false;

    if (options.matchByStatus === true) {
      const effectStatuses = new Set(getEffectStatuses(effect, raw).map(normalizeId));
      const wantedStatuses = uniq(identity?.statuses ?? []).map(normalizeId);
      sameStatus = wantedStatuses.some(s => s && effectStatuses.has(s));
    }

    const moduleIds = new Set(
      uniq([
        getProperty(raw, `flags.${MODULE_ID}.registryId`),
        getProperty(raw, `flags.${MODULE_ID}.sourceEffectUuid`),
        getProperty(raw, `flags.${MODULE_ID}.sourceEffId`),

        getProperty(raw, `flags.${MODULE_ID}.activeEffectManager.registryId`),
        getProperty(raw, `flags.${MODULE_ID}.activeEffectManager.sourceEffectUuid`),
        getProperty(raw, `flags.${MODULE_ID}.activeEffectManager.sourceEffId`)
      ]).map(normalizeId)
    );

    const sameManagerSource = wantedIds.some(id => id && moduleIds.has(id));

    return {
      matched: sameId || sameName || sameStatus || sameManagerSource,
      sameId,
      sameName,
      sameStatus,
      sameManagerSource
    };
  }

  async function findDuplicatesOnActor(actorOrUuid, effectOrIdentity, options = {}) {
    const actor = await resolveActor(actorOrUuid);

    if (!actor) {
      return {
        ok: false,
        reason: "actor_not_found",
        actor: null,
        duplicates: []
      };
    }

    let identity = null;

    if (effectOrIdentity?.normalizedName || effectOrIdentity?.canonicalIds) {
      identity = effectOrIdentity;
    } else {
      const normalized = await normalizeEffectInput(effectOrIdentity, options);
      if (!normalized.ok) {
        return {
          ok: false,
          reason: normalized.reason,
          actor: compactActor(actor),
          duplicates: []
        };
      }

      identity = normalized.identity;
    }

    const duplicates = [];

    for (const effect of actor.effects ?? []) {
      const match = effectMatchesIdentity(effect, identity, options);

      if (match.matched) {
        duplicates.push({
          ...compactEffectDoc(effect),
          match,
          raw: getEffectRaw(effect)
        });
      }
    }

    return {
      ok: true,
      actor: compactActor(actor),
      identity: clone(identity, {}),
      duplicates
    };
  }

  // --------------------------------------------------------------------------
  // Duplicate ask dialog
  // --------------------------------------------------------------------------

  function askDuplicateAction({ actor, effectData, duplicates }) {
    return new Promise(resolve => {
      const dupList = duplicates.map(d => `<li>${d.name}</li>`).join("");

      const content = `
        <div style="color:#111;">
          <p><b>${actor.name}</b> already has an effect matching:</p>
          <p><b>${effectData.name}</b></p>
          <ul>${dupList}</ul>
          <p>What should Active Effect Manager do?</p>
        </div>
      `;

      new Dialog({
        title: "Duplicate Active Effect",
        content,
        buttons: {
          skip: {
            label: "Skip",
            callback: () => resolve("skip")
          },
          replace: {
            label: "Replace",
            callback: () => resolve("replace")
          },
          stack: {
            label: "Stack",
            callback: () => resolve("stack")
          },
          remove: {
            label: "Remove Existing",
            callback: () => resolve("remove")
          }
        },
        default: "skip",
        close: () => resolve("skip")
      }).render(true);
    });
  }

  async function decideDuplicateMode({ actor, effectData, duplicates, mode }) {
    const normalized = safeString(mode, "skip").toLowerCase();

    if (!duplicates.length) return "none";
    if (VALID_DUPLICATE_MODES.has(normalized) && normalized !== "ask") return normalized;

    if (normalized === "ask" && game.user?.isGM) {
      return await askDuplicateAction({
        actor,
        effectData,
        duplicates
      });
    }

    return "skip";
  }

  // --------------------------------------------------------------------------
  // Core document operations
  // --------------------------------------------------------------------------

  async function createEffectOnActor(actor, effectData, options = {}) {
    const created = await createEffectsOnActor(actor, [effectData], options);
    return created?.[0] ?? null;
  }

  async function createEffectsOnActor(actor, effectRowsOrData = [], options = {}) {
    const rows = asArray(effectRowsOrData).filter(Boolean);

    const dataArray = rows
      .map(row => {
        const data = row.effectData ?? row;
        const cloned = clone(data, {});
        deleteUnsafeCreateFields(cloned);
        return cloned;
      })
      .filter(data => data && typeof data === "object");

    if (!actor || !dataArray.length) return [];

    const created = await actor.createEmbeddedDocuments("ActiveEffect", dataArray, {
      render: false,
      ...options
    });

    return Array.from(created ?? []);
  }

  async function deleteEffectsOnActor(actor, effectsOrIds = [], options = {}) {
    const ids = effectsOrIds
      .map(e => typeof e === "string" ? e : e?.id)
      .filter(Boolean);

    if (!actor || !ids.length) return [];

    await actor.deleteEmbeddedDocuments("ActiveEffect", uniq(ids), {
      render: false,
      ...options
    });

    return uniq(ids);
  }

  async function updateEffect(effect, updates = {}) {
    if (!effect) return null;

    const cleanUpdates = clone(updates, {});
    delete cleanUpdates.id;
    delete cleanUpdates._id;
    delete cleanUpdates.uuid;

    await effect.update(cleanUpdates);

    return effect;
  }

  // --------------------------------------------------------------------------
  // Chat / FX optional hooks
  // --------------------------------------------------------------------------

  async function maybeRenderChat(report, options = {}) {
    if (options.silent || options.renderChat === false) return null;

    const chatApi =
      globalThis.FUCompanion?.api?.activeEffectManager?.chat ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.chat ??
      null;

    if (chatApi?.renderResults) {
      try {
        return await chatApi.renderResults(report, options);
      } catch (e) {
        warn("Optional chat renderer failed.", e);
      }
    }

    return null;
  }

  async function maybePlayFx(report, options = {}) {
    if (options.silent || options.playFx === false) return null;

    const fxApi =
      globalThis.FUCompanion?.api?.activeEffectManager?.fx ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.fx ??
      null;

    if (fxApi?.play) {
      try {
        return await fxApi.play(report, options);
      } catch (e) {
        warn("Optional FX player failed.", e);
      }
    }

    return null;
  }

  function emitEvent(eventName, report) {
    try {
      Hooks.callAll(eventName, report);
    } catch (e) {
      warn("Hook emission failed.", {
        eventName,
        error: String(e?.message ?? e)
      });
    }

    try {
      globalThis.ONI?.emit?.(eventName, report, {
        local: true,
        world: true
      });
    } catch (_e) {}
  }

  // --------------------------------------------------------------------------
  // Main API: apply
  // --------------------------------------------------------------------------

  async function applyEffects(input = {}) {
    const runId = input.runId ?? nowRunId("AEM-APPLY");

    const options = {
      ...DEFAULT_OPTIONS,
      ...(input.options ?? {}),
      ...input,
      runId
    };

    options.duplicateMode = safeString(options.duplicateMode, "skip").toLowerCase();
    if (!VALID_DUPLICATE_MODES.has(options.duplicateMode)) {
      options.duplicateMode = "skip";
    }

    options.sourceUserId = options.sourceUserId ?? game.userId ?? null;
    options.sourceName = options.sourceName ?? game.user?.name ?? null;

    const actors = await resolveActors({
      ...input,
      fallbackToSelected: input.fallbackToSelected ?? false
    });

    const effectsInput =
      input.effects ??
      input.effect ??
      input.effectData ??
      [];

    const normalizedEffects = await normalizeEffectInputs(effectsInput, options);

    const results = [];
    const errors = [];

    const makeEffectResultInfo = (effectData, identity) => ({
      name: effectData?.name ?? null,
      img: effectData?.img ?? effectData?.icon ?? null,
      identity
    });

    const identityQueueKey = (identity, effectData) => {
      const ids = uniq(identity?.canonicalIds ?? []).filter(Boolean);
      if (ids.length) return `ids:${ids.join("|")}`;

      const statuses = uniq(identity?.statuses ?? []).filter(Boolean);
      const name = normalizeName(identity?.name ?? effectData?.name);

      return `name:${name}|statuses:${statuses.join("|")}`;
    };

    if (!actors.length) {
      const report = {
        ok: false,
        runId,
        action: "apply",
        reason: "no_actors",
        actors: [],
        normalizedEffects,
        results,
        errors
      };

      emitEvent("oni:activeEffectManagerApplied", report);
      emitEvent("oni:activeEffectApplied", report);

      return report;
    }

    const validEffects = normalizedEffects.filter(e => e.ok);

    for (const bad of normalizedEffects.filter(e => !e.ok)) {
      errors.push({
        scope: "effect-normalization",
        reason: bad.reason,
        input: bad.input ?? null
      });
    }

    if (!validEffects.length) {
      const report = {
        ok: false,
        runId,
        action: "apply",
        reason: "no_valid_effects",
        actors: actors.map(compactActor),
        normalizedEffects,
        results,
        errors
      };

      emitEvent("oni:activeEffectManagerApplied", report);
      emitEvent("oni:activeEffectApplied", report);

      return report;
    }

    for (const actor of actors) {
      if (!canModifyActor(actor)) {
        results.push({
          ok: false,
          status: "failed",
          reason: "no_permission",
          actor: compactActor(actor)
        });

        if (!options.quiet) {
          ui.notifications?.warn?.(`Active Effect Manager: no permission to modify ${actor.name}.`);
        }

        continue;
      }

      const createQueue = [];
      const deleteIds = [];
      const removeResultRows = [];
      const plannedCreateKeys = new Set();
      let deleteFailed = false;

      for (const normalized of validEffects) {
        const effectData = clone(normalized.effectData, {});
        const identity = normalized.identity;
        const queueKey = identityQueueKey(identity, effectData);

        try {
          const dupReport = await findDuplicatesOnActor(actor, identity, options);
          const duplicates = dupReport.duplicates ?? [];

          const requestedMode = safeString(
            normalized.duplicateMode ?? options.duplicateMode,
            options.duplicateMode
          ).toLowerCase();

          // Important for batched mode:
          // If the same effect is queued twice in one operation, "skip" should still
          // behave like the old sequential version: first one applies, second skips.
          if (
            plannedCreateKeys.has(queueKey) &&
            requestedMode !== "stack"
          ) {
            results.push({
              ok: true,
              status: "skipped",
              reason: "duplicate_exists",
              actor: compactActor(actor),
              effect: makeEffectResultInfo(effectData, identity),
              duplicates: []
            });
            continue;
          }

          const duplicateMode = await decideDuplicateMode({
            actor,
            effectData,
            duplicates,
            mode: requestedMode
          });

          if (duplicates.length && duplicateMode === "skip") {
            results.push({
              ok: true,
              status: "skipped",
              reason: "duplicate_exists",
              actor: compactActor(actor),
              effect: makeEffectResultInfo(effectData, identity),
              duplicates
            });
            continue;
          }

          if (duplicates.length && duplicateMode === "remove") {
            const ids = duplicates
              .map(d => d?.id)
              .filter(Boolean);

            deleteIds.push(...ids);

            removeResultRows.push({
              ok: true,
              status: "removed",
              reason: "duplicate_removed",
              actor: compactActor(actor),
              effect: makeEffectResultInfo(effectData, identity),
              removedIds: ids,
              duplicates
            });

            continue;
          }

          if (duplicates.length && duplicateMode === "replace") {
            const ids = duplicates
              .map(d => d?.id)
              .filter(Boolean);

            deleteIds.push(...ids);

            createQueue.push({
              status: "replaced",
              actor,
              effectData,
              identity,
              duplicates,
              removedIds: ids
            });

            plannedCreateKeys.add(queueKey);
            continue;
          }

          // stack or no duplicate
          createQueue.push({
            status: duplicates.length ? "stacked" : "applied",
            actor,
            effectData,
            identity,
            duplicates,
            removedIds: []
          });

          if (duplicateMode !== "stack") {
            plannedCreateKeys.add(queueKey);
          }

        } catch (e) {
          const errorRow = {
            ok: false,
            status: "failed",
            actor: compactActor(actor),
            effect: makeEffectResultInfo(effectData, identity),
            error: String(e?.message ?? e)
          };

          results.push(errorRow);
          errors.push(errorRow);

          err("Failed to plan effect application.", {
            actor: actor.name,
            effect: effectData?.name,
            error: e
          });
        }
      }

      // Batch delete first for remove / replace.
      if (deleteIds.length) {
        try {
          await deleteEffectsOnActor(actor, deleteIds, {
            render: false
          });

          for (const row of removeResultRows) {
            results.push(row);
          }

        } catch (e) {
          deleteFailed = true;

          const errorText = String(e?.message ?? e);

          errors.push({
            actor: compactActor(actor),
            operation: "deleteEmbeddedDocuments",
            ids: uniq(deleteIds),
            error: errorText
          });

          for (const row of removeResultRows) {
            results.push({
              ...row,
              ok: false,
              status: "failed",
              reason: "delete_failed",
              error: errorText
            });
          }
        }
      }

      // If delete failed, avoid creating replacement duplicates.
      const actualCreateQueue = createQueue.filter(row => {
        if (!deleteFailed) return true;

        if (row.status === "replaced") {
          results.push({
            ok: false,
            status: "failed",
            reason: "replace_delete_failed",
            actor: compactActor(actor),
            effect: makeEffectResultInfo(row.effectData, row.identity),
            removedIds: row.removedIds,
            duplicates: row.duplicates
          });

          return false;
        }

        return true;
      });

      // Batch create once per actor.
      if (actualCreateQueue.length) {
        try {
          const createdDocs = await createEffectsOnActor(actor, actualCreateQueue, {
            render: false
          });

          for (let i = 0; i < actualCreateQueue.length; i++) {
            const row = actualCreateQueue[i];
            const created = createdDocs?.[i] ?? null;

            results.push({
              ok: true,
              status: row.status,
              actor: compactActor(actor),
              effect: makeEffectResultInfo(row.effectData, row.identity),
              duplicates: row.duplicates,
              removedIds: row.removedIds,
              created: compactEffectDoc(created)
            });
          }

        } catch (e) {
          const errorText = String(e?.message ?? e);

          errors.push({
            actor: compactActor(actor),
            operation: "createEmbeddedDocuments",
            count: actualCreateQueue.length,
            error: errorText
          });

          for (const row of actualCreateQueue) {
            results.push({
              ok: false,
              status: "failed",
              reason: "create_failed",
              actor: compactActor(actor),
              effect: makeEffectResultInfo(row.effectData, row.identity),
              duplicates: row.duplicates,
              removedIds: row.removedIds,
              error: errorText
            });
          }

          err("Failed to batch create ActiveEffects.", {
            actor: actor.name,
            count: actualCreateQueue.length,
            error: e
          });
        }
      }
    }

    const ok = results.some(r =>
      r.ok &&
      ["applied", "stacked", "replaced", "removed", "skipped"].includes(r.status)
    );

    const report = {
      ok,
      optimized: true,
      runId,
      action: "apply",
      options: {
        duplicateMode: options.duplicateMode,
        matchByStatus: !!options.matchByStatus,
        silent: !!options.silent
      },
      actors: actors.map(compactActor),
      normalizedEffects,
      results,
      errors,
      counts: summarizeResultCounts(results),
      createdAt: nowIso()
    };

    emitEvent("oni:activeEffectManagerApplied", report);
    emitEvent("oni:activeEffectApplied", report);

    await maybePlayFx(report, options);
    await maybeRenderChat(report, options);

    log("applyEffects complete.", {
      optimized: true,
      runId,
      counts: report.counts
    });

    return report;
  }

  // --------------------------------------------------------------------------
  // Main API: remove
  // --------------------------------------------------------------------------

  function buildRemoveMatcher(input = {}) {
    const names = new Set(
      uniq([
        ...asArray(input.name),
        ...asArray(input.names),
        ...asArray(input.effectName),
        ...asArray(input.effectNames)
      ]).map(normalizeName)
    );

    const ids = new Set(
      uniq([
        ...asArray(input.id),
        ...asArray(input.ids),
        ...asArray(input.uuid),
        ...asArray(input.uuids),
        ...asArray(input.registryId),
        ...asArray(input.registryIds),
        ...asArray(input.sourceEffId),
        ...asArray(input.sourceEffIds)
      ]).map(normalizeId)
    );

    const statuses = new Set(
      uniq([
        ...asArray(input.status),
        ...asArray(input.statuses),
        ...asArray(input.statusId),
        ...asArray(input.statusIds)
      ]).map(normalizeId)
    );

    return function match(effect) {
      const raw = getEffectRaw(effect);
      const effectName = normalizeName(getEffectName(effect));
      const effectIds = new Set(getCanonicalIdsFromEffect(effect, raw).map(normalizeId));
      const effectStatuses = new Set(getEffectStatuses(effect, raw).map(normalizeId));

      if (names.size && names.has(effectName)) return true;

      if (ids.size) {
        for (const id of ids) {
          if (effectIds.has(id)) return true;
        }
      }

      if (statuses.size) {
        for (const s of statuses) {
          if (effectStatuses.has(s)) return true;
        }
      }

      return false;
    };
  }

  async function removeEffects(input = {}) {
    const runId = input.runId ?? nowRunId("AEM-REMOVE");

    const options = {
      ...DEFAULT_OPTIONS,
      ...(input.options ?? {}),
      ...input,
      runId
    };

    const actors = await resolveActors({
      ...input,
      fallbackToSelected: input.fallbackToSelected ?? false
    });

    const results = [];
    const errors = [];

    const effectInputs =
      input.effects ??
      input.effect ??
      [];

    const normalizedEffects = effectInputs
      ? await normalizeEffectInputs(effectInputs, options)
      : [];

    const hasEffectInputs = normalizedEffects.some(e => e.ok);
    const removeMatcher = buildRemoveMatcher(input);

    for (const actor of actors) {
      if (!canModifyActor(actor)) {
        results.push({
          ok: false,
          status: "failed",
          reason: "no_permission",
          actor: compactActor(actor)
        });
        continue;
      }

      try {
        const toRemove = [];

        if (hasEffectInputs) {
          for (const row of normalizedEffects.filter(e => e.ok)) {
            for (const effect of actor.effects ?? []) {
              const match = effectMatchesIdentity(effect, row.identity, options);
              if (match.matched) toRemove.push(effect);
            }
          }
        } else {
          for (const effect of actor.effects ?? []) {
            if (removeMatcher(effect)) toRemove.push(effect);
          }
        }

        const uniqueToRemove = Array.from(
          new Map(toRemove.map(e => [e.id, e])).values()
        );

        if (!uniqueToRemove.length) {
          results.push({
            ok: true,
            status: "skipped",
            reason: "no_matching_effects",
            actor: compactActor(actor)
          });
          continue;
        }

        const removed = uniqueToRemove.map(compactEffectDoc);
        const removedIds = await deleteEffectsOnActor(actor, uniqueToRemove);

        results.push({
          ok: true,
          status: "removed",
          actor: compactActor(actor),
          removedIds,
          removed
        });

      } catch (e) {
        const row = {
          ok: false,
          status: "failed",
          actor: compactActor(actor),
          error: String(e?.message ?? e)
        };

        results.push(row);
        errors.push(row);
      }
    }

    const report = {
      ok: results.some(r => r.ok),
      runId,
      action: "remove",
      actors: actors.map(compactActor),
      normalizedEffects,
      results,
      errors,
      counts: summarizeResultCounts(results),
      createdAt: nowIso()
    };

    emitEvent("oni:activeEffectManagerRemoved", report);
    emitEvent("oni:activeEffectRemoved", report);

    await maybeRenderChat(report, options);

    log("removeEffects complete.", {
      runId,
      counts: report.counts
    });

    return report;
  }

  // --------------------------------------------------------------------------
  // Main API: toggle
  // --------------------------------------------------------------------------

  async function toggleEffects(input = {}) {
    const runId = input.runId ?? nowRunId("AEM-TOGGLE");

    const options = {
      ...DEFAULT_OPTIONS,
      ...(input.options ?? {}),
      ...input,
      runId
    };

    const actors = await resolveActors({
      ...input,
      fallbackToSelected: input.fallbackToSelected ?? false
    });

    const effectsInput =
      input.effects ??
      input.effect ??
      input.effectData ??
      [];

    const normalizedEffects = await normalizeEffectInputs(effectsInput, options);
    const validEffects = normalizedEffects.filter(e => e.ok);

    const results = [];
    const errors = [];

    for (const actor of actors) {
      if (!canModifyActor(actor)) {
        results.push({
          ok: false,
          status: "failed",
          reason: "no_permission",
          actor: compactActor(actor)
        });
        continue;
      }

      for (const normalized of validEffects) {
        try {
          const dupReport = await findDuplicatesOnActor(actor, normalized.identity, options);
          const duplicates = dupReport.duplicates ?? [];

          if (duplicates.length) {
            const removedIds = await deleteEffectsOnActor(actor, duplicates);

            results.push({
              ok: true,
              status: "removed",
              reason: "toggle_off",
              actor: compactActor(actor),
              effect: {
                name: normalized.effectData.name,
                img: normalized.effectData.img,
                identity: normalized.identity
              },
              removedIds,
              duplicates
            });

            continue;
          }

          const created = await createEffectOnActor(actor, normalized.effectData);

          results.push({
            ok: true,
            status: "applied",
            reason: "toggle_on",
            actor: compactActor(actor),
            effect: {
              name: normalized.effectData.name,
              img: normalized.effectData.img,
              identity: normalized.identity
            },
            created: compactEffectDoc(created)
          });

        } catch (e) {
          const row = {
            ok: false,
            status: "failed",
            actor: compactActor(actor),
            effect: {
              name: normalized.effectData?.name ?? null
            },
            error: String(e?.message ?? e)
          };

          results.push(row);
          errors.push(row);
        }
      }
    }

    const report = {
      ok: results.some(r => r.ok),
      runId,
      action: "toggle",
      actors: actors.map(compactActor),
      normalizedEffects,
      results,
      errors,
      counts: summarizeResultCounts(results),
      createdAt: nowIso()
    };

    emitEvent("oni:activeEffectManagerToggled", report);
    emitEvent("oni:activeEffectToggled", report);

    await maybePlayFx(report, options);
    await maybeRenderChat(report, options);

    log("toggleEffects complete.", {
      runId,
      counts: report.counts
    });

    return report;
  }

  // --------------------------------------------------------------------------
  // Main API: modify existing effect
  // --------------------------------------------------------------------------

  async function findExistingEffect(actor, input = {}) {
    if (!actor) return null;

    const directId = safeString(input.effectId ?? input.id);
    if (directId) {
      const byId = actor.effects?.get?.(directId);
      if (byId) return byId;
    }

    const directUuid = safeString(input.effectUuid ?? input.uuid);
    if (directUuid) {
      const doc = await resolveDocument(directUuid);
      if (doc?.parent?.uuid === actor.uuid || doc?.parent === actor) return doc;
    }

    if (input.name || input.effectName) {
      const wanted = normalizeName(input.name ?? input.effectName);

      for (const effect of actor.effects ?? []) {
        if (normalizeName(getEffectName(effect)) === wanted) return effect;
      }
    }

    if (input.registryId || input.sourceEffId || input.effect) {
      const normalized = await normalizeEffectInput(
        input.effect ?? input.registryId ?? input.sourceEffId,
        input
      );

      if (normalized.ok) {
        for (const effect of actor.effects ?? []) {
          const match = effectMatchesIdentity(effect, normalized.identity, input);
          if (match.matched) return effect;
        }
      }
    }

    return null;
  }

  async function modifyExistingEffect(input = {}) {
    const runId = input.runId ?? nowRunId("AEM-MODIFY");

    const actor =
      await resolveActor(input.actor ?? input.actorUuid ?? input.targetActorUuid);

    if (!actor) {
      return {
        ok: false,
        runId,
        action: "modify",
        reason: "actor_not_found"
      };
    }

    if (!canModifyActor(actor)) {
      return {
        ok: false,
        runId,
        action: "modify",
        reason: "no_permission",
        actor: compactActor(actor)
      };
    }

    const effect = await findExistingEffect(actor, input);

    if (!effect) {
      return {
        ok: false,
        runId,
        action: "modify",
        reason: "effect_not_found",
        actor: compactActor(actor)
      };
    }

    const updates = clone(input.updates ?? {}, {});

    if (input.duration) {
      updates.duration = {
        ...(getEffectRaw(effect).duration ?? {}),
        ...normalizeDuration(input.duration)
      };
    }

    if (Array.isArray(input.changes)) {
      updates.changes = cleanChanges(input.changes);
    }

    if (input.disabled !== undefined) {
      updates.disabled = !!input.disabled;
    }

    if (input.name !== undefined) {
      updates.name = String(input.name);
      updates.label = String(input.name);
    }

    if (input.img !== undefined || input.icon !== undefined) {
      updates.img = String(input.img ?? input.icon);
      updates.icon = String(input.icon ?? input.img);
    }

    const before = compactEffectDoc(effect);
    await updateEffect(effect, updates);
    const after = compactEffectDoc(effect);

    const report = {
      ok: true,
      runId,
      action: "modify",
      actor: compactActor(actor),
      before,
      after,
      updates,
      createdAt: nowIso()
    };

    emitEvent("oni:activeEffectManagerModified", report);
    emitEvent("oni:activeEffectModified", report);

    return report;
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  function summarizeResultCounts(results = []) {
    const counts = {};

    for (const row of results) {
      const key = row.status ?? "unknown";
      counts[key] = (counts[key] ?? 0) + 1;
    }

    counts.total = results.length;
    counts.failed = results.filter(r => r.status === "failed" || r.ok === false).length;
    counts.success = results.filter(r => r.ok === true).length;

    return counts;
  }

  async function listActorEffects(actorOrUuid) {
    const actor = await resolveActor(actorOrUuid);

    if (!actor) {
      return {
        ok: false,
        reason: "actor_not_found",
        actor: null,
        effects: []
      };
    }

    const effects = Array.from(actor.effects ?? []).map(effect => {
      const raw = getEffectRaw(effect);

      return {
        ...compactEffectDoc(effect),
        changes: clone(raw.changes ?? [], []),
        duration: clone(raw.duration ?? {}, {}),
        flags: clone(raw.flags ?? {}, {}),
        raw
      };
    });

    return {
      ok: true,
      actor: compactActor(actor),
      effects
    };
  }

  async function buildEffectPreview(effectInput, options = {}) {
    return await normalizeEffectInput(effectInput, options);
  }

  function getVersion() {
    return "0.1.0";
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------

  const api = {
    version: getVersion(),

    applyEffects,
    removeEffects,
    toggleEffects,
    modifyExistingEffect,

    resolveActors,
    resolveActor,
    resolveDocument,

    findDuplicatesOnActor,
    listActorEffects,

    buildEffectPreview,
    normalizeEffectInput,
    normalizeEffectInputs,

    _internal: {
      DEFAULT_OPTIONS,
      VALID_DUPLICATE_MODES,

      getRegistryApi,
      ensureRegistryReady,
      findRegistryEntryLoose,

      stampCustomSystemBuilderFlags,
      parseActiveEffectUuidParts,

      finalizeEffectData,
      buildEffectIdentity,
      effectMatchesIdentity,

      createEffectOnActor,
      createEffectsOnActor,
      deleteEffectsOnActor,
      updateEffect,

      canModifyActor,
      compactActor,
      compactEffectDoc,
      getCanonicalIdsFromEffect,
      getEffectStatuses
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager API installed.", {
      api: [
        "applyEffects",
        "removeEffects",
        "toggleEffects",
        "modifyExistingEffect",
        "resolveActors",
        "findDuplicatesOnActor",
        "listActorEffects"
      ]
    });
  });
})();