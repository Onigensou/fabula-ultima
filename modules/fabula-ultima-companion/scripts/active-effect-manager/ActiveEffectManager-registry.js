// ============================================================================
// ActiveEffectManager-registry.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Dynamically build a registry of available Active Effect presets.
// - No hardcoded Slow/Dazed/etc. list.
// - Scans:
//   1. CONFIG.statusEffects
//   2. World Items with embedded ActiveEffects
//   3. World Actors with embedded ActiveEffects
//   4. Optional compendiums, only when requested
//   5. Actor Status tab metadata / labels, for UI reference
//
// This script DOES NOT apply effects.
// It only exposes registry APIs for the future UI/API scripts.
//
// Public API:
//   FUCompanion.api.activeEffectRegistry.refresh(options)
//   FUCompanion.api.activeEffectRegistry.getAll()
//   FUCompanion.api.activeEffectRegistry.getGrouped()
//   FUCompanion.api.activeEffectRegistry.getById(id)
//   FUCompanion.api.activeEffectRegistry.findByName(name)
//   FUCompanion.api.activeEffectRegistry.cloneEffectDataForApplication(entryOrId, overrides)
//   FUCompanion.api.activeEffectRegistry.scanActorStatusTabMetadata(actorOrUuid)
//   FUCompanion.api.activeEffectRegistry.findDuplicatesOnActor(actorOrUuid, entryOrId)
//
// Console examples:
//   await FUCompanion.api.activeEffectRegistry.refresh()
//   FUCompanion.api.activeEffectRegistry.getGrouped()
//   FUCompanion.api.activeEffectRegistry.getAll().map(e => e.name)
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][AERegistry]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  const DEFAULT_REFRESH_OPTIONS = {
    scanConfigStatusEffects: true,
    scanWorldItems: true,
    scanWorldActors: true,

    // Compendium scanning can be slow, so keep it off by default.
    // The future UI can expose a "Refresh including compendiums" button.
    scanCompendiums: false,

    // If true, actor effects currently on PCs/NPCs can appear as presets.
    // Useful while building, but later we may prefer using only item/compendium presets.
    includeActorEffects: true,

    // Used for reading Status tab labels/containers.
    sampleActorUuid: null,

    dedupe: true,

    maxCompendiumDocuments: 800
  };

  const SOURCE_PRIORITY = {
    "world-item-effect": 100,
    "compendium-item-effect": 90,
    "config-status-effect": 80,
    "world-actor-effect": 60,
    "compendium-actor-effect": 50,
    "unknown": 0
  };

  const CACHE = {
    ready: false,
    refreshedAt: null,
    options: null,
    entries: [],
    grouped: {
      Buff: [],
      Debuff: [],
      Other: []
    },
    byId: new Map(),
    byName: new Map(),
    statusTabMetadata: null,
    report: null
  };

  // --------------------------------------------------------------------------
  // General helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    return globalThis.FUCompanion.api;
  }

  function exposeApi(api) {
    ensureApiRoot().activeEffectRegistry = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectRegistry = api;
      }
    } catch (e) {
      warn("Could not expose API on module object.", e);
    }
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

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeName(value) {
    return safeString(value).toLowerCase().replace(/\s+/g, " ");
  }

  function normalizeId(value) {
    return safeString(value).toLowerCase();
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function uniq(values) {
    return Array.from(new Set(asArray(values).filter(v => v != null && String(v).trim() !== "").map(String)));
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
      const p = parts[i];
      cur[p] ??= {};
      cur = cur[p];
    }

    cur[parts[parts.length - 1]] = value;
    return obj;
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

  function getSelectedOrFallbackActor() {
    const selectedToken = canvas?.tokens?.controlled?.[0] ?? null;
    if (selectedToken?.actor) return selectedToken.actor;

    if (game.user?.character) return game.user.character;

    return Array.from(game.actors ?? []).find(a => {
      try {
        return game.user?.isGM || a.testUserPermission?.(game.user, "OWNER");
      } catch (_e) {
        return false;
      }
    }) ?? null;
  }

  // --------------------------------------------------------------------------
  // Active Effect data helpers
  // --------------------------------------------------------------------------

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

  function effectToRawData(effectLike) {
    if (!effectLike) return {};

    try {
      if (typeof effectLike.toObject === "function") {
        return clone(effectLike.toObject(), {});
      }
    } catch (_e) {}

    return clone(effectLike, {});
  }

  function getEffectStatuses(effectLike, rawData = null) {
    const raw = rawData ?? effectToRawData(effectLike);

    return uniq([
      ...asArray(effectLike?.statuses),
      ...asArray(raw?.statuses),
      raw?.status,
      raw?.id && effectLike?.sourceType === "config-status-effect" ? raw.id : null
    ]);
  }

  function getCanonicalIds(effectLike, rawData = null, source = {}) {
    const raw = rawData ?? effectToRawData(effectLike);

    const flags = raw?.flags ?? effectLike?.flags ?? {};

    const candidates = [
      effectLike?.uuid,
      effectLike?.id,
      raw?.uuid,
      raw?._id,
      raw?.id,
      raw?.origin,

      source?.effectUuid,
      source?.effectId,
      source?.ownerUuid,

      getProperty(flags, "core.sourceId"),
      getProperty(flags, "core.uuid"),
      getProperty(raw, "_stats.compendiumSource"),

      // Custom System Builder often keeps original source identity here.
      getProperty(flags, "custom-system-builder.originalUuid"),
      getProperty(flags, "custom-system-builder.originalParentId"),
      getProperty(flags, "custom-system-builder.originalId"),

      // Dfreds/Convenient Effects compatibility if present.
      getProperty(flags, "dfreds-convenient-effects.ceEffectId"),
      getProperty(flags, "dfreds-convenient-effects.originalEffectId"),

      // Our future handler source IDs.
      getProperty(flags, `${MODULE_ID}.sourceEffId`),
      getProperty(flags, `${MODULE_ID}.sourceEffectUuid`),
      getProperty(flags, `${MODULE_ID}.registryId`)
    ];

    return uniq(candidates);
  }

  function extractTags(effectLike, rawData = null) {
    const raw = rawData ?? effectToRawData(effectLike);
    const flags = raw?.flags ?? effectLike?.flags ?? {};

    const candidates = [
      ...asArray(raw?.tags),
      ...asArray(raw?.system?.tags),
      ...asArray(effectLike?.tags),
      ...asArray(effectLike?.system?.tags),

      ...asArray(getProperty(flags, MODULE_ID + ".tags")),
      ...asArray(getProperty(flags, MODULE_ID + ".effectTags")),
      ...asArray(getProperty(flags, MODULE_ID + ".activeEffectManager.tags")),
      ...asArray(getProperty(flags, "custom-system-builder.tags")),
      ...asArray(getProperty(flags, "dfreds-convenient-effects.tags"))
    ];

    return uniq(candidates).map(String);
  }

  function normalizeCategoryToken(value) {
    return safeString(value)
      .toLowerCase()
      .replace(/[\s_-]+/g, "")
      .trim();
  }

  function normalizeCategory(value) {
    const token = normalizeCategoryToken(value);

    if (token === "buff") return "Buff";
    if (token === "debuff") return "Debuff";
    if (token === "other") return "Other";

    return "";
  }

  function categoryFromTags(tags = []) {
    const rawTags = asArray(tags);

    // Strongest signal:
    // CSB stores the visible tag chips here:
    // system.tags = ["buff"] / ["debuff"] / ["other"]
    for (const tag of rawTags) {
      const cat = normalizeCategory(tag);
      if (cat) return cat;
    }

    // Loose fallback for future/custom text tags.
    for (const tag of rawTags) {
      const text = safeString(tag).toLowerCase();
      if (/\bdebuff\b/.test(text)) return "Debuff";
      if (/\bbuff\b/.test(text)) return "Buff";
      if (/\bother\b/.test(text)) return "Other";
    }

    return "";
  }

  function categoryFromOwnerName(value) {
    const token = normalizeCategoryToken(value);

    // Strong fallback for template Items named exactly:
    // Buff / Debuff / Other
    if (token === "buff" || token === "buffs") return "Buff";
    if (token === "debuff" || token === "debuffs") return "Debuff";
    if (token === "other" || token === "others") return "Other";

    return "";
  }

  function explicitCategoryFromData(effectLike, rawData = null) {
    const raw = rawData ?? effectToRawData(effectLike);
    const flags = raw?.flags ?? effectLike?.flags ?? {};

    const explicit = safeString(
      raw?.category ??
      raw?.system?.category ??
      effectLike?.category ??
      effectLike?.system?.category ??
      getProperty(flags, MODULE_ID + ".category") ??
      getProperty(flags, MODULE_ID + ".effectCategory") ??
      getProperty(flags, MODULE_ID + ".activeEffectManager.sourceCategory") ??
      getProperty(flags, MODULE_ID + ".activeEffectManager.category") ??
      getProperty(flags, "custom-system-builder.category") ??
      getProperty(flags, "dfreds-convenient-effects.category")
    );

    return normalizeCategory(explicit);
  }

  function inferCategory(effectLike, rawData = null, source = {}) {
    const raw = rawData ?? effectToRawData(effectLike);
    const flags = raw?.flags ?? effectLike?.flags ?? {};
    const tags = extractTags(effectLike, raw);
    const name = getEffectName(effectLike ?? raw);

    // 1. Explicit category fields win.
    const explicit = explicitCategoryFromData(effectLike, raw);
    if (explicit) return explicit;

    // 2. CSB string-tags field wins after explicit category.
    // This fixes cases like Berserk:
    // system.tags = ["debuff"]
    const fromTags = categoryFromTags(tags);
    if (fromTags) return fromTags;

    // 3. Template parent Item fallback.
    // Example: effect lives inside an Item named "Debuff".
    const fromOwner = categoryFromOwnerName(
      source?.ownerName ??
      source?.name ??
      raw?.parentName ??
      effectLike?.parentName ??
      effectLike?.parent?.name ??
      ""
    );
    if (fromOwner) return fromOwner;

    const allText = [
      name,
      ...tags,
      source?.ownerName,
      JSON.stringify(raw?.statuses ?? []),
      JSON.stringify(flags ?? {})
    ].join(" ").toLowerCase();

    // 4. Last-resort display fallback only.
    // Mechanics still use the real ActiveEffect document.
    if (
      /\bdebuff\b/.test(allText) ||
      /\bcondition\b/.test(allText) ||
      /slow|dazed|weak|shaken|enraged|poison|poisoned|bleed|burn|frozen|curse|blind|stun|fatigue|wet|oil|petrify|hypothermia|turbulence|zombie|berserk/.test(allText)
    ) {
      return "Debuff";
    }

    if (
      /\bbuff\b/.test(allText) ||
      /swift|awake|strong|focus|clarity|energized|regen|regeneration|shield|barrier|protect|haste|bless|boost|defense up|power up/.test(allText)
    ) {
      return "Buff";
    }

    return "Other";
  }

  function normalizeStatusMatchKey(value) {
    return safeString(value)
      .toLowerCase()
      .replace(/^status:/, "")
      .trim();
  }

  function getConfigStatusMatchKeys(status = {}) {
    return uniq([
      status?.id,
      status?._id,
      status?.name,
      status?.label,
      status?.status,
      ...asArray(status?.statuses)
    ])
      .map(normalizeStatusMatchKey)
      .filter(Boolean);
  }

  function effectMatchesConfigStatus(effectLike, rawData = null, status = {}) {
    const raw = rawData ?? effectToRawData(effectLike);
    const wanted = new Set(getConfigStatusMatchKeys(status));
    if (!wanted.size) return false;

    const effectStatusKeys = getEffectStatuses(effectLike, raw)
      .map(normalizeStatusMatchKey)
      .filter(Boolean);

    if (effectStatusKeys.some(k => wanted.has(k))) return true;

    // Name fallback catches templates whose status id is not loaded yet,
    // but only after the stronger status-id match check above.
    const effectName = normalizeName(getEffectName(effectLike ?? raw));
    const wantedNames = uniq([
      status?.name,
      status?.label,
      status?.id
    ])
      .map(normalizeName)
      .filter(Boolean);

    return !!effectName && wantedNames.includes(effectName);
  }

  function scoreStatusTemplateCandidate({ effect, raw, source, status, tags, category } = {}) {
    let score = 0;

    const wanted = new Set(getConfigStatusMatchKeys(status));
    const effectStatusKeys = getEffectStatuses(effect, raw)
      .map(normalizeStatusMatchKey)
      .filter(Boolean);

    if (effectStatusKeys.some(k => wanted.has(k))) score += 100;

    const effectName = normalizeName(getEffectName(effect ?? raw));
    const statusNames = uniq([status?.name, status?.label, status?.id])
      .map(normalizeName)
      .filter(Boolean);

    if (effectName && statusNames.includes(effectName)) score += 35;
    if (categoryFromTags(tags)) score += 30;
    if (explicitCategoryFromData(effect, raw)) score += 25;
    if (categoryFromOwnerName(source?.ownerName)) score += 15;
    if (source?.ownerDocumentName === "Item") score += 8;
    if (category === "Buff" || category === "Debuff") score += 5;

    return score;
  }

  function findTemplateForConfigStatus(status = {}) {
    const candidates = [];

    const scanOwner = (owner, sourceType, ownerDocumentName) => {
      for (const effect of owner?.effects ?? []) {
        try {
          const raw = effectToRawData(effect);
          if (!effectMatchesConfigStatus(effect, raw, status)) continue;

          const source = {
            sourceType,
            ownerName: owner.name,
            ownerUuid: owner.uuid,
            ownerDocumentName,
            ownerType: owner.type,
            effectId: effect.id,
            effectUuid: effect.uuid,
            registryId: effect.uuid
          };

          const tags = extractTags(effect, raw);
          const category = inferCategory(effect, raw, source);
          const score = scoreStatusTemplateCandidate({
            effect,
            raw,
            source,
            status,
            tags,
            category
          });

          candidates.push({
            effect,
            raw,
            source,
            tags,
            category,
            score
          });
        } catch (e) {
          warn("Failed while matching CONFIG.statusEffects entry to ActiveEffect template.", {
            owner: owner?.name,
            effect: effect?.name,
            status: status?.name ?? status?.label ?? status?.id,
            error: String(e?.message ?? e)
          });
        }
      }
    };

    for (const item of game.items ?? []) {
      scanOwner(item, "world-item-effect", "Item");
    }

    for (const actor of game.actors ?? []) {
      scanOwner(actor, "world-actor-effect", "Actor");
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ?? null;
  }

  function normalizeEffectDataForRegistry(effectLike, source = {}) {
    const raw = effectToRawData(effectLike);

    const name = getEffectName(effectLike ?? raw);
    const img = getEffectImg(effectLike ?? raw);

    const statuses = getEffectStatuses(effectLike, raw);

    const data = {
      name,
      label: name,
      img,
      icon: img,

      disabled: false,
      transfer: !!raw?.transfer,

      changes: clone(raw?.changes ?? [], []),
      duration: clone(raw?.duration ?? {}, {}),
      statuses,

      origin: raw?.origin ?? source?.ownerUuid ?? null,

      description:
        raw?.description ??
        getProperty(raw, "system.description") ??
        getProperty(raw, "flags.core.description") ??
        "",

      flags: clone(raw?.flags ?? {}, {})
    };

    data.flags[MODULE_ID] = {
      ...(data.flags[MODULE_ID] ?? {}),
      registrySourceType: source.sourceType ?? "unknown",
      registrySourceName: source.ownerName ?? source.name ?? null,
      registrySourceUuid: source.ownerUuid ?? null,
      sourceEffectUuid: source.effectUuid ?? effectLike?.uuid ?? null,
      sourceEffId: source.effectUuid ?? effectLike?.uuid ?? source.effectId ?? null
    };

    deleteUnsafeCreateFields(data);

    return data;
  }

  function buildSearchText(entry) {
    return [
      entry.name,
      entry.category,
      ...(entry.tags ?? []),
      ...(entry.statuses ?? []),
      entry.sourceType,
      entry.sourceName,
      ...(entry.canonicalIds ?? [])
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function makeEffectFingerprint(effectData = {}) {
    const name = normalizeName(effectData.name ?? effectData.label);
    const changes = clone(effectData.changes ?? [], [])
      .map(c => ({
        key: safeString(c.key),
        mode: Number(c.mode ?? 0),
        value: safeString(c.value),
        priority: Number(c.priority ?? 0)
      }))
      .sort((a, b) => {
        const ak = `${a.key}|${a.mode}|${a.value}|${a.priority}`;
        const bk = `${b.key}|${b.mode}|${b.value}|${b.priority}`;
        return ak.localeCompare(bk);
      });

    const statuses = uniq(effectData.statuses ?? []).sort();

    return JSON.stringify({
      name,
      changes,
      statuses
    });
  }

  function makeDedupeKey(entry) {
    const ids = uniq(entry.canonicalIds ?? []);

    const strongId = ids.find(id => {
      const s = normalizeId(id);
      return (
        s.includes("activeeffect") ||
        s.includes("compendium") ||
        s.includes("custom-system-builder") ||
        s.includes("dfreds") ||
        s.startsWith("status:")
      );
    });

    if (strongId) return `id:${normalizeId(strongId)}`;

    return `fingerprint:${makeEffectFingerprint(entry.effectData)}`;
  }

  function buildRegistryEntry(effectLike, source = {}) {
    const raw = effectToRawData(effectLike);
    const effectData = normalizeEffectDataForRegistry(effectLike, source);

    const name = getEffectName(effectLike ?? raw);
    const img = getEffectImg(effectLike ?? raw);
    const category = inferCategory(effectLike ?? raw, raw, source);
    const tags = extractTags(effectLike ?? raw, raw);
    const statuses = getEffectStatuses(effectLike ?? raw, raw);
    const canonicalIds = getCanonicalIds(effectLike ?? raw, raw, source);

    const sourceType = source.sourceType ?? "unknown";
    const sourcePriority = SOURCE_PRIORITY[sourceType] ?? 0;

    const registryId =
      source.registryId ??
      source.effectUuid ??
      effectLike?.uuid ??
      source.effectId ??
      canonicalIds[0] ??
      `${sourceType}:${name}:${foundry?.utils?.randomID?.(8) ?? Math.random().toString(36).slice(2, 10)}`;

    const entry = {
      registryId: String(registryId),
      name,
      label: name,
      img,
      icon: img,

      category,
      tags,
      statuses,

      sourceType,
      sourcePriority,

      sourceName: source.ownerName ?? source.name ?? null,
      sourceUuid: source.ownerUuid ?? null,
      sourceDocumentName: source.ownerDocumentName ?? null,

      effectId: source.effectId ?? effectLike?.id ?? raw?._id ?? raw?.id ?? null,
      effectUuid: source.effectUuid ?? effectLike?.uuid ?? null,

      canonicalIds,

      effectData,

      rawPreview: {
        duration: clone(effectData.duration ?? {}, {}),
        changes: clone(effectData.changes ?? [], []),
        statuses: clone(effectData.statuses ?? [], []),
        flags: clone(effectData.flags ?? {}, {})
      }
    };

    entry.dedupeKey = makeDedupeKey(entry);
    entry.searchText = buildSearchText(entry);

    return entry;
  }

  function buildConfigStatusEffectEntry(status) {
    const id = safeString(status?.id ?? status?.name ?? status?.label);
    const name = safeString(status?.name ?? status?.label ?? status?.id, "Unnamed Status");
    const img = safeString(status?.img ?? status?.icon ?? "icons/svg/aura.svg");

    const raw = clone(status, {});

    // CONFIG.statusEffects entries often know the status id/name,
    // but not the CSB string-tags field from the actual ActiveEffect template.
    // Bridge that gap by matching the CONFIG status to the real ActiveEffect
    // document by status id first, then by name.
    const template = findTemplateForConfigStatus(status);
    const templateTags = template?.tags ?? [];
    const templateCategory = template?.category ?? "";

    const mergedTags = uniq([
      ...asArray(status?.tags),
      ...asArray(status?.system?.tags),
      ...templateTags
    ]);

    const pseudoFlags = clone(status?.flags ?? {}, {});
    pseudoFlags[MODULE_ID] = {
      ...(pseudoFlags[MODULE_ID] ?? {}),
      sourceEffectUuid: template?.source?.effectUuid ?? null,
      sourceEffId: template?.source?.effectUuid ?? template?.source?.effectId ?? null,
      statusTemplateEffectUuid: template?.source?.effectUuid ?? null,
      statusTemplateSourceName: template?.source?.ownerName ?? null,
      statusTemplateCategory: templateCategory || null,
      statusTemplateTags: clone(templateTags, [])
    };

    const pseudoSystem = {
      ...(status?.system && typeof status.system === "object" ? clone(status.system, {}) : {}),
      tags: mergedTags
    };

    if (templateCategory && !pseudoSystem.category) {
      pseudoSystem.category = templateCategory;
    }

    const pseudoEffect = {
      id,
      name,
      label: name,
      img,
      icon: img,
      tags: mergedTags,
      system: pseudoSystem,
      statuses: id ? [id] : [],
      changes: clone(status?.changes ?? template?.raw?.changes ?? [], []),
      duration: {},
      flags: pseudoFlags,
      sourceType: "config-status-effect"
    };

    const source = {
      sourceType: "config-status-effect",
      ownerName: "CONFIG.statusEffects",
      ownerUuid: null,
      ownerDocumentName: "CONFIG",
      effectId: id,
      effectUuid: id ? "status:" + id : null,
      registryId: id ? "status:" + id : "status:" + name,
      raw,
      templateSource: template?.source ?? null
    };

    return buildRegistryEntry(pseudoEffect, source);
  }

  // --------------------------------------------------------------------------
  // Scanners
  // --------------------------------------------------------------------------

  function scanConfigStatusEffects() {
    const rows = [];

    for (const status of CONFIG.statusEffects ?? []) {
      try {
        rows.push(buildConfigStatusEffectEntry(status));
      } catch (e) {
        warn("Failed to index CONFIG.statusEffects entry.", {
          status,
          error: String(e?.message ?? e)
        });
      }
    }

    return rows;
  }

  function scanWorldItems() {
    const rows = [];

    for (const item of game.items ?? []) {
      for (const effect of item.effects ?? []) {
        try {
          rows.push(buildRegistryEntry(effect, {
            sourceType: "world-item-effect",
            ownerName: item.name,
            ownerUuid: item.uuid,
            ownerDocumentName: "Item",
            ownerType: item.type,
            effectId: effect.id,
            effectUuid: effect.uuid,
            registryId: effect.uuid
          }));
        } catch (e) {
          warn("Failed to index item ActiveEffect.", {
            item: item?.name,
            effect: effect?.name,
            error: String(e?.message ?? e)
          });
        }
      }
    }

    return rows;
  }

  function scanWorldActors({ includeActorEffects = true } = {}) {
    const rows = [];
    if (!includeActorEffects) return rows;

    for (const actor of game.actors ?? []) {
      for (const effect of actor.effects ?? []) {
        try {
          rows.push(buildRegistryEntry(effect, {
            sourceType: "world-actor-effect",
            ownerName: actor.name,
            ownerUuid: actor.uuid,
            ownerDocumentName: "Actor",
            ownerType: actor.type,
            effectId: effect.id,
            effectUuid: effect.uuid,
            registryId: effect.uuid
          }));
        } catch (e) {
          warn("Failed to index actor ActiveEffect.", {
            actor: actor?.name,
            effect: effect?.name,
            error: String(e?.message ?? e)
          });
        }
      }
    }

    return rows;
  }

  async function scanCompendiums(options = {}) {
    const rows = [];
    const maxDocs = Number(options.maxCompendiumDocuments ?? DEFAULT_REFRESH_OPTIONS.maxCompendiumDocuments) || 800;
    let scannedDocs = 0;

    for (const pack of game.packs ?? []) {
      const docName = pack.documentName;

      if (!["Item", "Actor"].includes(docName)) continue;

      try {
        const index = await pack.getIndex();

        for (const idx of index) {
          if (scannedDocs >= maxDocs) {
            warn("Compendium scan hit max document limit.", {
              maxDocs
            });
            return rows;
          }

          const doc = await pack.getDocument(idx._id).catch(() => null);
          scannedDocs++;

          if (!doc?.effects?.size) continue;

          for (const effect of doc.effects ?? []) {
            const sourceType =
              docName === "Item"
                ? "compendium-item-effect"
                : "compendium-actor-effect";

            rows.push(buildRegistryEntry(effect, {
              sourceType,
              ownerName: doc.name,
              ownerUuid: doc.uuid,
              ownerDocumentName: docName,
              ownerType: doc.type,
              packCollection: pack.collection,
              packTitle: pack.title,
              effectId: effect.id,
              effectUuid: effect.uuid,
              registryId: effect.uuid
            }));
          }
        }
      } catch (e) {
        warn("Failed while scanning compendium.", {
          pack: pack.collection,
          title: pack.title,
          documentName: docName,
          error: String(e?.message ?? e)
        });
      }
    }

    return rows;
  }

  // --------------------------------------------------------------------------
  // Actor Status tab metadata scanner
  // --------------------------------------------------------------------------

  function plainText(value) {
    let s = String(value ?? "");

    // Remove big CSS/style chunks and HTML.
    s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<[^>]*>/g, " ");

    // Remove formula wrappers enough to keep labels readable.
    s = s.replace(/\$\{[\s\S]*?\}\$/g, " ");

    s = s.replace(/&nbsp;/gi, " ");
    s = s.replace(/\s+/g, " ").trim();

    return s;
  }

  function shouldKeepLabel(value) {
    const s = plainText(value);
    if (!s) return false;
    if (s.length > 80) return false;
    if (/^\W+$/.test(s)) return false;
    return true;
  }

  function walkNodes(value, visitor, path = []) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walkNodes(v, visitor, [...path, i]));
      return;
    }

    if (!value || typeof value !== "object") return;

    visitor(value, path);

    const childKeys = ["contents", "rowLayout", "options", "predefinedLines"];

    for (const key of childKeys) {
      if (value[key] !== undefined) {
        walkNodes(value[key], visitor, [...path, key]);
      }
    }
  }

  function nodeTextIdentity(node = {}) {
    return [
      node.type,
      node.key,
      node.name,
      node.title,
      node.label,
      node.value,
      node.colName
    ].map(plainText).join(" ").toLowerCase();
  }

  function isStatusTabNode(node = {}) {
    if (node.type !== "tab") return false;

    const identity = nodeTextIdentity(node);

    return (
      identity.includes("status") ||
      identity.includes("active effect") ||
      identity.includes("effect")
    );
  }

  function isActiveEffectContainerNode(node = {}) {
    const identity = nodeTextIdentity(node);

    return (
      node.type === "activeEffectContainer" ||
      identity.includes("activeeffectcontainer") ||
      identity.includes("active effect") ||
      String(node.key ?? "").toLowerCase().includes("activeeffect")
    );
  }

  function isActiveEffectConfigTableNode(node = {}) {
    const key = String(node.key ?? "").toLowerCase();
    const identity = nodeTextIdentity(node);

    return (
      key.includes("active_effect") ||
      key.includes("activeeffect") ||
      identity.includes("active effect config") ||
      (
        node.type === "dynamicTable" &&
        JSON.stringify(node).toLowerCase().includes("active_effect")
      )
    );
  }

  function summarizeSheetNode(node = {}, path = []) {
    return {
      path: path.join("."),
      key: node.key ?? "",
      type: node.type ?? "",
      name: node.name ?? "",
      title: node.title ?? "",
      label: plainText(node.label ?? ""),
      value: shouldKeepLabel(node.value) ? plainText(node.value) : "",
      colName: plainText(node.colName ?? ""),
      flow: node.flow ?? "",
      align: node.align ?? "",
      raw: clone({
        key: node.key,
        type: node.type,
        name: node.name,
        title: node.title,
        label: node.label,
        value: shouldKeepLabel(node.value) ? node.value : "",
        colName: node.colName,
        flow: node.flow,
        align: node.align
      }, {})
    };
  }

  function collectMetadataInside(rootNode = {}, rootPath = []) {
    const labels = [];
    const fields = [];
    const activeEffectContainers = [];
    const configTables = [];

    walkNodes(rootNode, (node, path) => {
      const fullPath = [...rootPath, ...path];

      if (node.type === "label" && shouldKeepLabel(node.value)) {
        labels.push(summarizeSheetNode(node, fullPath));
      }

      if (node.key && node.type) {
        fields.push(summarizeSheetNode(node, fullPath));
      }

      if (isActiveEffectContainerNode(node)) {
        const rowLayout = Array.isArray(node.rowLayout) ? node.rowLayout : [];
        const contents = Array.isArray(node.contents) ? node.contents : [];

        activeEffectContainers.push({
          ...summarizeSheetNode(node, fullPath),
          columns: rowLayout.map((col, i) => ({
            index: i,
            key: col.key ?? "",
            type: col.type ?? "",
            label: plainText(col.label ?? col.colName ?? col.value ?? ""),
            colName: plainText(col.colName ?? "")
          })),
          contentsLabels: contents
            .filter(c => c?.type === "label" && shouldKeepLabel(c?.value))
            .map((c, i) => ({
              index: i,
              key: c.key ?? "",
              value: plainText(c.value ?? ""),
              label: plainText(c.label ?? "")
            }))
        });
      }

      if (isActiveEffectConfigTableNode(node)) {
        const rowLayout = Array.isArray(node.rowLayout) ? node.rowLayout : [];

        configTables.push({
          ...summarizeSheetNode(node, fullPath),
          rowFields: rowLayout.map((field, i) => ({
            index: i,
            key: field.key ?? "",
            type: field.type ?? "",
            label: plainText(field.label ?? field.colName ?? field.value ?? ""),
            defaultValue: field.defaultValue ?? "",
            options: clone(field.options ?? [], [])
          }))
        });
      }
    });

    return {
      labels,
      fields,
      activeEffectContainers,
      configTables
    };
  }

  async function scanActorStatusTabMetadata(actorOrUuid = null) {
    const actor =
      actorOrUuid
        ? await resolveActor(actorOrUuid)
        : getSelectedOrFallbackActor();

    if (!actor) {
      return {
        ok: false,
        reason: "no_actor",
        statusTabs: [],
        activeEffectContainers: [],
        configTables: [],
        labels: []
      };
    }

    const body = actor.system?.body ?? {};
    const bodyContents = body.contents ?? [];

    const statusTabs = [];

    walkNodes(bodyContents, (node, path) => {
      if (isStatusTabNode(node)) {
        const inner = collectMetadataInside(node, path);

        statusTabs.push({
          ...summarizeSheetNode(node, path),
          labels: inner.labels,
          fields: inner.fields,
          activeEffectContainers: inner.activeEffectContainers,
          configTables: inner.configTables
        });
      }
    });

    const fullBody = collectMetadataInside(bodyContents, []);

    const report = {
      ok: true,
      actor: {
        name: actor.name,
        uuid: actor.uuid,
        type: actor.type
      },

      // Status tab specific data.
      statusTabs,

      // Whole-sheet fallbacks, useful if Custom System Builder layout changes.
      activeEffectContainers: fullBody.activeEffectContainers,
      configTables: fullBody.configTables,

      // Label data requested for UI language/reference.
      labels: statusTabs.length
        ? statusTabs.flatMap(t => t.labels)
        : fullBody.labels,

      generatedAt: nowIso()
    };

    return report;
  }

  // --------------------------------------------------------------------------
  // Dedupe and cache
  // --------------------------------------------------------------------------

  function dedupeEntries(entries = []) {
    const byKey = new Map();

    for (const entry of entries) {
      const key = entry.dedupeKey || makeDedupeKey(entry);
      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, entry);
        continue;
      }

      const existingPriority = existing.sourcePriority ?? 0;
      const nextPriority = entry.sourcePriority ?? 0;

      if (nextPriority > existingPriority) {
        byKey.set(key, {
          ...entry,
          alternateSources: [
            ...(entry.alternateSources ?? []),
            {
              registryId: existing.registryId,
              sourceType: existing.sourceType,
              sourceName: existing.sourceName,
              effectUuid: existing.effectUuid
            },
            ...(existing.alternateSources ?? [])
          ]
        });
      } else {
        existing.alternateSources = [
          ...(existing.alternateSources ?? []),
          {
            registryId: entry.registryId,
            sourceType: entry.sourceType,
            sourceName: entry.sourceName,
            effectUuid: entry.effectUuid
          }
        ];
      }
    }

    return Array.from(byKey.values());
  }

  function sortEntries(entries = []) {
    return [...entries].sort((a, b) => {
      const cat = String(a.category).localeCompare(String(b.category));
      if (cat) return cat;

      const name = String(a.name).localeCompare(String(b.name));
      if (name) return name;

      return String(a.registryId).localeCompare(String(b.registryId));
    });
  }

  function groupEntries(entries = []) {
    const grouped = {
      Buff: [],
      Debuff: [],
      Other: []
    };

    for (const entry of entries) {
      const cat = ["Buff", "Debuff", "Other"].includes(entry.category)
        ? entry.category
        : "Other";

      grouped[cat].push(entry);
    }

    return grouped;
  }

  function rebuildMaps(entries = []) {
    const byId = new Map();
    const byName = new Map();

    for (const entry of entries) {
      const ids = uniq([
        entry.registryId,
        entry.effectUuid,
        entry.effectId,
        ...(entry.canonicalIds ?? [])
      ]);

      for (const id of ids) {
        byId.set(String(id), entry);
      }

      const nameKey = normalizeName(entry.name);
      if (nameKey) {
        const list = byName.get(nameKey) ?? [];
        list.push(entry);
        byName.set(nameKey, list);
      }
    }

    CACHE.byId = byId;
    CACHE.byName = byName;
  }

  async function refresh(options = {}) {
    const finalOptions = {
      ...DEFAULT_REFRESH_OPTIONS,
      ...(options ?? {})
    };

    const startedAt = Date.now();
    const rows = [];
    const warnings = [];

    log("Refresh started.", finalOptions);

    try {
      if (finalOptions.scanConfigStatusEffects) {
        rows.push(...scanConfigStatusEffects());
      }
    } catch (e) {
      warnings.push(`CONFIG.statusEffects scan failed: ${String(e?.message ?? e)}`);
    }

    try {
      if (finalOptions.scanWorldItems) {
        rows.push(...scanWorldItems());
      }
    } catch (e) {
      warnings.push(`World item scan failed: ${String(e?.message ?? e)}`);
    }

    try {
      if (finalOptions.scanWorldActors) {
        rows.push(...scanWorldActors({
          includeActorEffects: finalOptions.includeActorEffects
        }));
      }
    } catch (e) {
      warnings.push(`World actor scan failed: ${String(e?.message ?? e)}`);
    }

    try {
      if (finalOptions.scanCompendiums) {
        rows.push(...await scanCompendiums(finalOptions));
      }
    } catch (e) {
      warnings.push(`Compendium scan failed: ${String(e?.message ?? e)}`);
    }

    let statusTabMetadata = null;

    try {
      const sampleActor =
        finalOptions.sampleActorUuid
          ? await resolveActor(finalOptions.sampleActorUuid)
          : getSelectedOrFallbackActor();

      statusTabMetadata = await scanActorStatusTabMetadata(sampleActor ?? null);
    } catch (e) {
      warnings.push(`Status tab metadata scan failed: ${String(e?.message ?? e)}`);
    }

    const rawCount = rows.length;
    const entries = sortEntries(finalOptions.dedupe ? dedupeEntries(rows) : rows);
    const grouped = groupEntries(entries);

    CACHE.ready = true;
    CACHE.refreshedAt = nowIso();
    CACHE.options = clone(finalOptions, {});
    CACHE.entries = entries;
    CACHE.grouped = grouped;
    CACHE.statusTabMetadata = statusTabMetadata;
    rebuildMaps(entries);

    const report = {
      ok: true,
      refreshedAt: CACHE.refreshedAt,
      durationMs: Date.now() - startedAt,
      options: finalOptions,
      counts: {
        raw: rawCount,
        final: entries.length,
        buff: grouped.Buff.length,
        debuff: grouped.Debuff.length,
        other: grouped.Other.length
      },
      warnings,
      statusTabMetadata,
      entries
    };

    CACHE.report = report;

    log("Refresh complete.", {
      counts: report.counts,
      durationMs: report.durationMs,
      warnings
    });

    return report;
  }

  // --------------------------------------------------------------------------
  // Lookup helpers / future API helpers
  // --------------------------------------------------------------------------

  function getAll({ cloneResult = true } = {}) {
    return cloneResult ? clone(CACHE.entries, []) : CACHE.entries;
  }

  function getGrouped({ cloneResult = true } = {}) {
    return cloneResult ? clone(CACHE.grouped, { Buff: [], Debuff: [], Other: [] }) : CACHE.grouped;
  }

  function getById(id, { cloneResult = true } = {}) {
    const entry = CACHE.byId.get(String(id));
    if (!entry) return null;
    return cloneResult ? clone(entry, null) : entry;
  }

  function findByName(name, { exact = true, cloneResult = true } = {}) {
    const key = normalizeName(name);

    if (exact) {
      const list = CACHE.byName.get(key) ?? [];
      return cloneResult ? clone(list, []) : list;
    }

    const rows = CACHE.entries.filter(e => normalizeName(e.name).includes(key));
    return cloneResult ? clone(rows, []) : rows;
  }

  function search(query, { category = null, limit = 50, cloneResult = true } = {}) {
    const q = normalizeName(query);
    const cat = safeString(category);

    let rows = CACHE.entries;

    if (cat && ["Buff", "Debuff", "Other"].includes(cat)) {
      rows = rows.filter(e => e.category === cat);
    }

    if (q) {
      rows = rows.filter(e => e.searchText.includes(q));
    }

    rows = rows.slice(0, limit);

    return cloneResult ? clone(rows, []) : rows;
  }

  function resolveEntry(entryOrId) {
    if (!entryOrId) return null;
    if (typeof entryOrId === "string") return getById(entryOrId, { cloneResult: false });
    if (entryOrId.registryId || entryOrId.effectData) return entryOrId;
    return null;
  }

  function cloneEffectDataForApplication(entryOrId, overrides = {}) {
    const entry = resolveEntry(entryOrId);

    if (!entry) {
      return {
        ok: false,
        reason: "registry_entry_not_found",
        effectData: null
      };
    }

    const data = clone(entry.effectData, {});
    deleteUnsafeCreateFields(data);

    data.name = safeString(overrides.name ?? data.name ?? entry.name, entry.name);
    data.label = data.name;

    data.img = safeString(overrides.img ?? overrides.icon ?? data.img ?? data.icon, "icons/svg/aura.svg");
    data.icon = safeString(overrides.icon ?? overrides.img ?? data.icon ?? data.img, data.img);

    if (overrides.duration && typeof overrides.duration === "object") {
      data.duration = {
        ...(data.duration ?? {}),
        ...clone(overrides.duration, {})
      };
    }

    if (Array.isArray(overrides.changes)) {
      data.changes = clone(overrides.changes, []);
    }

    if (Array.isArray(overrides.statuses)) {
      data.statuses = clone(overrides.statuses, []);
    }

    if (overrides.disabled !== undefined) {
      data.disabled = !!overrides.disabled;
    } else {
      data.disabled = false;
    }

    if (overrides.transfer !== undefined) {
      data.transfer = !!overrides.transfer;
    }

    if (overrides.origin !== undefined) {
      data.origin = overrides.origin;
    }

    data.flags = data.flags || {};
    data.flags[MODULE_ID] = {
      ...(data.flags[MODULE_ID] ?? {}),
      registryId: entry.registryId,
      sourceEffectUuid: entry.effectUuid ?? null,
      sourceEffId: entry.effectUuid ?? entry.effectId ?? entry.registryId,
      sourceName: entry.name,
      sourceCategory: entry.category,
      appliedFromRegistry: true,
      appliedAt: nowIso()
    };

    if (overrides.flags && typeof overrides.flags === "object") {
      data.flags = foundry?.utils?.mergeObject
        ? foundry.utils.mergeObject(data.flags, overrides.flags, {
            inplace: false,
            recursive: true,
            insertKeys: true,
            insertValues: true,
            overwrite: true
          })
        : {
            ...data.flags,
            ...clone(overrides.flags, {})
          };
    }

    return {
      ok: true,
      entry: clone(entry, null),
      effectData: data
    };
  }

  async function findDuplicatesOnActor(actorOrUuid, entryOrId) {
    const actor = await resolveActor(actorOrUuid);
    const entry = resolveEntry(entryOrId);

    if (!actor || !entry) {
      return {
        ok: false,
        reason: !actor ? "actor_not_found" : "entry_not_found",
        duplicates: []
      };
    }

    const wantedName = normalizeName(entry.name);
    const wantedIds = new Set(uniq([
      entry.registryId,
      entry.effectUuid,
      entry.effectId,
      ...(entry.canonicalIds ?? [])
    ]).map(normalizeId));

    const duplicates = [];

    for (const effect of actor.effects ?? []) {
      const raw = effectToRawData(effect);
      const effectName = normalizeName(getEffectName(effect));
      const effectIds = uniq(getCanonicalIds(effect, raw, {
        effectUuid: effect.uuid,
        effectId: effect.id,
        ownerUuid: actor.uuid
      })).map(normalizeId);

      const sameName = wantedName && effectName && wantedName === effectName;
      const sameId = effectIds.some(id => wantedIds.has(id));

      const moduleSourceIds = uniq([
        getProperty(raw, `flags.${MODULE_ID}.registryId`),
        getProperty(raw, `flags.${MODULE_ID}.sourceEffectUuid`),
        getProperty(raw, `flags.${MODULE_ID}.sourceEffId`)
      ]).map(normalizeId);

      const sameModuleSource = moduleSourceIds.some(id => wantedIds.has(id));

      if (sameName || sameId || sameModuleSource) {
        duplicates.push({
          id: effect.id,
          uuid: effect.uuid,
          name: getEffectName(effect),
          sameName,
          sameId,
          sameModuleSource,
          raw: clone(raw, {})
        });
      }
    }

    return {
      ok: true,
      actor: {
        name: actor.name,
        uuid: actor.uuid
      },
      entry: {
        registryId: entry.registryId,
        name: entry.name
      },
      duplicates
    };
  }

  function clearCache() {
    CACHE.ready = false;
    CACHE.refreshedAt = null;
    CACHE.options = null;
    CACHE.entries = [];
    CACHE.grouped = {
      Buff: [],
      Debuff: [],
      Other: []
    };
    CACHE.byId = new Map();
    CACHE.byName = new Map();
    CACHE.statusTabMetadata = null;
    CACHE.report = null;
  }

  function getLastReport({ cloneResult = true } = {}) {
    return cloneResult ? clone(CACHE.report, null) : CACHE.report;
  }

  function getStatusTabMetadata({ cloneResult = true } = {}) {
    return cloneResult ? clone(CACHE.statusTabMetadata, null) : CACHE.statusTabMetadata;
  }

  function debugPrint() {
    console.groupCollapsed(`${TAG} Cache Debug`);
    console.log({
      ready: CACHE.ready,
      refreshedAt: CACHE.refreshedAt,
      counts: {
        entries: CACHE.entries.length,
        buff: CACHE.grouped.Buff.length,
        debuff: CACHE.grouped.Debuff.length,
        other: CACHE.grouped.Other.length
      },
      grouped: CACHE.grouped,
      statusTabMetadata: CACHE.statusTabMetadata,
      report: CACHE.report
    });
    console.groupEnd();

    return getLastReport();
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    refresh,

    getAll,
    getGrouped,
    getById,
    findByName,
    search,

    cloneEffectDataForApplication,
    findDuplicatesOnActor,

    scanActorStatusTabMetadata,
    getStatusTabMetadata,

    getLastReport,
    clearCache,
    debugPrint,

    // Useful for later scripts.
    _internal: {
      buildRegistryEntry,
      buildConfigStatusEffectEntry,
      normalizeEffectDataForRegistry,
      inferCategory,
      extractTags,
      getCanonicalIds,
      makeEffectFingerprint,
      makeDedupeKey,
      cache: CACHE
    }
  };

  exposeApi(api);

  Hooks.once("ready", async () => {
    exposeApi(api);

    try {
      // Initial lightweight scan.
      // No compendiums by default to avoid slow startup.
      await refresh({
        scanCompendiums: false
      });

      log("Ready. Active Effect Registry API installed.", {
        entries: CACHE.entries.length,
        groupedCounts: {
          buff: CACHE.grouped.Buff.length,
          debuff: CACHE.grouped.Debuff.length,
          other: CACHE.grouped.Other.length
        }
      });
    } catch (e) {
      err("Initial registry refresh failed.", e);
    }
  });
})();