/*:
 * @target Foundry VTT v12
 * @plugindesc [ONI] Adds conditional Active Effect change gates like aeWhen("Crisis", "RS").
 *
 * File:
 * modules/fabula-ultima-companion/scripts/syntaxExtender-conditionalChangeGate.js
 *
 * Version:
 * 6.0.0-apply-transform-source-fallback-2026-05-05
 *
 * What this script does:
 * - Allows Active Effect values like aeWhen("Crisis", "RS").
 * - If the condition is true, the real value is applied.
 * - If the condition is false, the change value becomes the actor's source/base value for that key.
 *
 * Why V6:
 * - Patching ActiveEffect.apply is the path that actually affects CSB's final applied value.
 * - Returning null can break CustomActor recalculation.
 * - Changing the key to a dummy flag does not work because CSB still applies the result to the original key.
 * - So false gates now transform the value to the actor's base/source value, usually "NA" for affinities.
 */

(() => {
  "use strict";

  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][AE-Gate]";
  const TRACE_TAG = "[ONI][AE-Gate][TRACE]";
  const VERSION = "6.3.0-affinity-false-fallback-na-2026-05-05";

  const HELPERS = ["aeWhen", "aeUuidWhen", "aeStatusWhen"];

  const PATCH_FLAGS = {
    actorPatched: "__oniAeConditionalGateActorPatched",
    actorOriginal: "__oniAeConditionalGateOriginalActorApply",
    actorVersion: "__oniAeConditionalGateActorPatchVersion",

    effectPatched: "__oniAeConditionalGateApplyPatched",
    effectOriginal: "__oniAeConditionalGateOriginalApply",
    effectVersion: "__oniAeConditionalGateApplyPatchVersion"
  };

  const DEFAULT_TRACE_KEYS = [
    "defense",
    "magic_defense",

    "base_defense",
    "bonus_defense",
    "override_defense",

    "base_magic_defense",
    "bonus_magic_defense",
    "override_magic_defense",

    "affinity_4",
    "affinity_9",

    "current_hp",
    "max_hp"
  ];

  const state = {
    settingsRegistered: false,
    debug: false,

    actorPatched: false,
    actorPatchTarget: null,
    actorPatchMode: null,

    effectPatched: false,
    effectPatchTarget: null,
    effectPatchMode: null,

    actorGuard: new WeakSet(),
    actorCache: new WeakMap(),
    actorPass: new WeakMap(),

    trace: {
      enabled: false,
      actorName: "Hina",
      maxEvents: 1500,
      seq: 0,
      events: [],
      keys: [...DEFAULT_TRACE_KEYS]
    }
  };

  // ------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------

  const settingDefs = {
    enabled: {
      name: "Enable AE Conditional Change Gate",
      hint: "Allows Active Effect changes like aeWhen(\"Crisis\", \"RS\") to conditionally apply.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    },

    debug: {
      name: "AE Conditional Gate Debug Logs",
      hint: "Prints detailed logs when aeWhen / aeUuidWhen / aeStatusWhen are evaluated.",
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    },

    useLibWrapper: {
      name: "AE Conditional Gate Prefer libWrapper",
      hint: "Usually leave this OFF. Direct patching is easier to inspect/debug for this script.",
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    }
  };

  function registerSettings() {
    if (state.settingsRegistered) return;

    for (const [key, data] of Object.entries(settingDefs)) {
      try {
        game.settings.register(MODULE_ID, `activeEffectConditionalGate.${key}`, data);
      } catch (_err) {}
    }

    state.settingsRegistered = true;
  }

  function getSetting(key, fallback = undefined) {
    try {
      return game.settings.get(MODULE_ID, `activeEffectConditionalGate.${key}`);
    } catch (_err) {
      return fallback ?? settingDefs[key]?.default;
    }
  }

  async function setSetting(key, value) {
    try {
      await game.settings.set(MODULE_ID, `activeEffectConditionalGate.${key}`, value);
    } catch (_err) {}
  }

  const isEnabled = () => !!getSetting("enabled", true);
  const isDebug = () => !!state.debug || !!getSetting("debug", false);
  const preferLibWrapper = () => !!getSetting("useLibWrapper", false);

  const log = (...args) => {
    if (isDebug()) console.log(TAG, ...args);
  };

  const warn = (...args) => {
    console.warn(TAG, ...args);
  };

  // ------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------

  function normalize(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function isActorDocument(doc) {
    return doc?.documentName === "Actor" || doc?.constructor?.name === "Actor";
  }

  function safeArrayFrom(value) {
    if (!value) return [];

    try {
      if (globalThis.Collection && value instanceof Collection) {
        return Array.from(value.values());
      }

      if (typeof value.values === "function") {
        return Array.from(value.values());
      }

      if (Array.isArray(value)) return value;

      if (Symbol.iterator in Object(value) && typeof value !== "string") {
        return Array.from(value);
      }
    } catch (_err) {}

    return [];
  }

  function clone(value) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_err) {}

    try {
      return structuredClone(value);
    } catch (_err) {}

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {}

    if (Array.isArray(value)) return [...value];
    if (value && typeof value === "object") return { ...value };
    return value;
  }

  function stringifyActiveEffectValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);

    try {
      return JSON.stringify(value);
    } catch (_err) {
      return String(value);
    }
  }

  function isEffectUsable(effect) {
    if (!effect) return false;
    if (effect.disabled) return false;
    if (effect.isSuppressed) return false;
    return true;
  }

  function hasGateSyntax(value) {
    return typeof value === "string"
      && /\b(?:aeWhen|aeUuidWhen|aeStatusWhen)\s*\(/i.test(value);
  }

  function resolveActorFromEffect(effect, explicitActor = null) {
    if (isActorDocument(explicitActor)) return explicitActor;
    if (explicitActor?.actor && isActorDocument(explicitActor.actor)) return explicitActor.actor;

    let parent = effect?.parent ?? null;

    for (let i = 0; parent && i < 10; i++) {
      if (isActorDocument(parent)) return parent;
      if (parent.actor && isActorDocument(parent.actor)) return parent.actor;
      parent = parent.parent ?? null;
    }

    return null;
  }

  function collectActorEffects(actor) {
    const results = [];
    const seenObjects = new WeakSet();
    const seenIds = new Set();

    const add = (effect, source = "unknown") => {
      if (!effect) return;

      if (typeof effect === "object") {
        if (seenObjects.has(effect)) return;
        seenObjects.add(effect);
      }

      const id =
        effect.uuid ??
        effect.id ??
        effect._id ??
        effect?.flags?.core?.sourceId ??
        null;

      if (id) {
        const fullId = `${source}:${id}`;
        if (seenIds.has(fullId)) return;
        seenIds.add(fullId);
      }

      try {
        if (!effect.__oniAeGateSource) {
          Object.defineProperty(effect, "__oniAeGateSource", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: source
          });
        }
      } catch (_err) {}

      results.push(effect);
    };

    try {
      if (typeof actor?.allApplicableEffects === "function") {
        for (const effect of safeArrayFrom(actor.allApplicableEffects())) {
          add(effect, "actor.allApplicableEffects()");
        }
      }
    } catch (err) {
      console.warn(TAG, "collectActorEffects: actor.allApplicableEffects() failed.", err);
    }

    for (const effect of safeArrayFrom(actor?.effects)) {
      add(effect, "actor.effects");
    }

    try {
      for (const effect of safeArrayFrom(actor?.temporaryEffects)) {
        add(effect, "actor.temporaryEffects");
      }
    } catch (_err) {}

    for (const item of safeArrayFrom(actor?.items)) {
      const itemName = item?.name ?? "Item";

      for (const effect of safeArrayFrom(item?.effects)) {
        add(effect, `item.effects:${itemName}`);
      }

      try {
        if (typeof item?.transferredEffects === "function") {
          for (const effect of safeArrayFrom(item.transferredEffects())) {
            add(effect, `item.transferredEffects():${itemName}`);
          }
        }
      } catch (_err) {}
    }

    return results.filter(isEffectUsable);
  }

  function collectActorConditionEffects(actor) {
  const results = [];
  const seenObjects = new WeakSet();
  const seenIds = new Set();

  const add = (effect, source = "unknown") => {
    if (!effect) return;
    if (!isEffectUsable(effect)) return;

    if (typeof effect === "object") {
      if (seenObjects.has(effect)) return;
      seenObjects.add(effect);
    }

    const id =
      effect.uuid ??
      effect.id ??
      effect._id ??
      effect?.flags?.core?.sourceId ??
      null;

    if (id) {
      const fullId = `${source}:${id}`;
      if (seenIds.has(fullId)) return;
      seenIds.add(fullId);
    }

    try {
      if (!effect.__oniAeGateConditionSource) {
        Object.defineProperty(effect, "__oniAeGateConditionSource", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: source
        });
      }
    } catch (_err) {}

    results.push(effect);
  };

  // These are the effects actually attached to the actor/status layer.
  // This avoids accidentally treating item-origin text/effects as conditions.
  for (const effect of safeArrayFrom(actor?.effects)) {
    add(effect, "actor.effects");
  }

  try {
    for (const effect of safeArrayFrom(actor?.temporaryEffects)) {
      add(effect, "actor.temporaryEffects");
    }
  } catch (_err) {}

  // Some systems expose real actor-owned status effects through allApplicableEffects().
  // Only accept them if their parent is actually the actor.
  try {
    if (typeof actor?.allApplicableEffects === "function") {
      for (const effect of safeArrayFrom(actor.allApplicableEffects())) {
        const parent = effect?.parent ?? null;
        const parentIsActor =
          parent === actor ||
          parent?.uuid === actor?.uuid ||
          parent?.documentName === "Actor";

        if (parentIsActor) {
          add(effect, "actor.allApplicableEffects():actor-owned");
        }
      }
    }
  } catch (_err) {}

  return results;
}

function effectMatchesQuery(effect, query) {
  const wanted = normalize(query);
  if (!wanted) return false;

  const names = [
    effect?.name,
    effect?.id,
    effect?._id,
    effect?.uuid,
    effect?._source?.name
  ];

  for (const name of names) {
    if (normalize(name) === wanted) return true;
  }

  for (const status of safeArrayFrom(effect?.statuses)) {
    if (normalize(status) === wanted) return true;
  }

  return false;
}

  function buildActorCache(actor) {
    const effects = collectActorEffects(actor);

    const names = new Set();
    const uuids = new Set();
    const statuses = new Set();

    const addName = (raw) => {
      const key = normalize(raw);
      if (key) names.add(key);
    };

    for (const effect of effects) {
      addName(effect?.name);
      addName(effect?.id);
      addName(effect?._id);
      addName(effect?.uuid);
      addName(effect?._source?.name);

      const uuid = normalize(effect?.uuid);
      if (uuid) uuids.add(uuid);

      for (const status of safeArrayFrom(effect?.statuses)) {
        const key = normalize(status);
        if (key) statuses.add(key);
      }
    }

    return {
      actor,
      effects,
      names,
      uuids,
      statuses,
      createdAt: Date.now()
    };
  }

  function getActorCache(actor) {
    if (!actor) return null;

    let cache = state.actorCache.get(actor);
    if (!cache) {
      cache = buildActorCache(actor);
      state.actorCache.set(actor, cache);
    }

    return cache;
  }

  function withActorCache(actor, callback) {
    if (!actor) return callback();

    const alreadyHadCache = state.actorCache.has(actor);

    if (!alreadyHadCache) {
      state.actorCache.set(actor, buildActorCache(actor));
    }

    try {
      return callback();
    } finally {
      if (!alreadyHadCache) {
        state.actorCache.delete(actor);
      }
    }
  }

  function resolveMaybePromise(value, onSuccess, onError) {
    try {
      if (value && typeof value.then === "function") {
        return value.then(onSuccess).catch((err) => {
          if (onError) return onError(err);
          throw err;
        });
      }

      return onSuccess(value);
    } catch (err) {
      if (onError) return onError(err);
      throw err;
    }
  }

  // ------------------------------------------------------------
  // Trace debugger
  // ------------------------------------------------------------

  function traceEnabledFor(actor = null) {
    if (!state.trace?.enabled) return false;
    if (!actor) return true;

    const wanted = String(state.trace.actorName ?? "").trim().toLowerCase();
    if (!wanted || wanted === "*") return true;

    return String(actor?.name ?? "").trim().toLowerCase() === wanted;
  }

  function actorTraceSnapshot(actor) {
    const props = actor?.system?.props ?? {};
    const out = {
      actor: actor?.name ?? null,
      actorId: actor?.id ?? null,
      actorUuid: actor?.uuid ?? null,
      timestamp: Date.now(),
      keys: {}
    };

    for (const key of state.trace.keys) {
      out.keys[key] = props[key];
    }

    return out;
  }

  function diffSnapshots(before, after) {
    const diff = {};
    const b = before?.keys ?? {};
    const a = after?.keys ?? {};

    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const bv = b[key];
      const av = a[key];

      if (String(bv) !== String(av)) {
        diff[key] = { before: bv, after: av };
      }
    }

    return diff;
  }

  function summarizeEffect(effect) {
    return {
      name: effect?.name ?? null,
      id: effect?.id ?? effect?._id ?? null,
      uuid: effect?.uuid ?? null,

      collectorSource: effect?.__oniAeGateSource ?? null,

      disabled: !!effect?.disabled,
      suppressed: !!effect?.isSuppressed,

      parentName: effect?.parent?.name ?? null,
      parentType: effect?.parent?.documentName ?? effect?.parent?.constructor?.name ?? null,

      origin: effect?.origin ?? null,
      statuses: safeArrayFrom(effect?.statuses),

      changesCount: Array.isArray(effect?.changes) ? effect.changes.length : null,
      sourceChangesCount: Array.isArray(effect?._source?.changes) ? effect._source.changes.length : null
    };
  }

  function summarizeChange(change) {
    if (!change) return null;

    return {
      key: change.key ?? null,
      mode: change.mode ?? null,
      value: change.value ?? null,
      priority: change.priority ?? null,
      hasGateSyntax: hasGateSyntax(change.value)
    };
  }

  function summarizeArgs(args = []) {
    return Array.from(args).map((arg, i) => {
      if (isActorDocument(arg)) {
        return {
          index: i,
          kind: "Actor",
          name: arg.name,
          id: arg.id,
          uuid: arg.uuid
        };
      }

      if (arg?.actor && isActorDocument(arg.actor)) {
        return {
          index: i,
          kind: "ActorLike",
          actor: arg.actor.name,
          actorUuid: arg.actor.uuid
        };
      }

      if (arg && typeof arg === "object") {
        return {
          index: i,
          kind: "Object",
          change: summarizeChange(arg)
        };
      }

      return {
        index: i,
        kind: typeof arg,
        value: arg
      };
    });
  }

  function pushTrace(label, actor = null, data = {}) {
    if (!traceEnabledFor(actor)) return null;

    const event = {
      seq: ++state.trace.seq,
      label,
      actor: actor?.name ?? null,
      time: new Date().toISOString(),
      data
    };

    state.trace.events.push(event);

    if (state.trace.events.length > state.trace.maxEvents) {
      state.trace.events.splice(0, state.trace.events.length - state.trace.maxEvents);
    }

    console.warn(TRACE_TAG, `#${event.seq}`, label, event);

    return event;
  }

  // ------------------------------------------------------------
  // Effect checks
  // ------------------------------------------------------------

function hasEffect(actor, effectName, currentEffect = null) {
  const wanted = normalize(effectName);
  if (!actor || !wanted) return false;

  for (const effect of collectActorConditionEffects(actor)) {
    // Avoid self-matching. Example: an effect should not count itself as its own condition.
    if (currentEffect && effect === currentEffect) continue;
    if (effectMatchesQuery(effect, wanted)) return true;
  }

  return false;
}

function hasEffectUuid(actor, uuid, currentEffect = null) {
  const wanted = normalize(uuid);
  if (!actor || !wanted) return false;

  for (const effect of collectActorConditionEffects(actor)) {
    if (currentEffect && effect === currentEffect) continue;

    if (normalize(effect?.uuid) === wanted) return true;
    if (normalize(effect?.id) === wanted) return true;
    if (normalize(effect?._id) === wanted) return true;
  }

  return false;
}

function hasEffectStatus(actor, statusId, currentEffect = null) {
  const wanted = normalize(statusId);
  if (!actor || !wanted) return false;

  for (const effect of collectActorConditionEffects(actor)) {
    if (currentEffect && effect === currentEffect) continue;

    for (const status of safeArrayFrom(effect?.statuses)) {
      if (normalize(status) === wanted) return true;
    }

    // Some condition systems use the effect name instead of statuses.
    if (normalize(effect?.name) === wanted) return true;
    if (normalize(effect?._source?.name) === wanted) return true;
  }

  return false;
}

  // ------------------------------------------------------------
  // Gate parser / evaluator
  // ------------------------------------------------------------

  function parseGateSyntax(rawValue) {
    const text = String(rawValue ?? "").trim();

    const match = text.match(
      /^\s*(?:\$\{\s*)?(aeWhen|aeUuidWhen|aeStatusWhen)\s*\(\s*(['"])(.*?)\2\s*,\s*(?:(['"])(.*?)\4|([^)]*?))\s*\)\s*(?:\}\$)?\s*$/i
    );

    if (!match) {
      return {
        ok: false,
        reason: "not_gate_syntax",
        rawValue
      };
    }

    const helper = String(match[1] ?? "").trim();
    const query = String(match[3] ?? "").trim();

    const quotedValue = match[5];
    const unquotedValue = match[6];

    const trueValue = String(
      quotedValue !== undefined
        ? quotedValue
        : unquotedValue ?? ""
    ).trim();

    if (!helper || !query) {
      return {
        ok: false,
        reason: "missing_helper_or_query",
        rawValue
      };
    }

    return {
      ok: true,
      helper,
      query,
      trueValue,
      rawValue
    };
  }

function evaluateGate(rawValue, actor, effect = null, change = null) {
  const parsed = parseGateSyntax(rawValue);

  if (!parsed.ok) {
    return {
      recognized: false,
      active: false,
      skipped: false,
      value: rawValue,
      reason: parsed.reason
    };
  }

  let active = false;
  const helperNorm = normalize(parsed.helper);
  const queryNorm = normalize(parsed.query);

if (helperNorm === "aewhen") {
  if (queryNorm === "crisis") {
    active = isActorInCrisis(actor, effect);
  } else {
    active = hasEffect(actor, parsed.query, effect);
  }
} else if (helperNorm === "aeuuidwhen") {
  active = hasEffectUuid(actor, parsed.query, effect);
} else if (helperNorm === "aestatuswhen") {
  active = hasEffectStatus(actor, parsed.query, effect);
}

  const result = {
    recognized: true,
    active,
    skipped: !active,
    helper: parsed.helper,
    query: parsed.query,
    value: active ? parsed.trueValue : rawValue,
    rawValue,
    actorName: actor?.name ?? null,
    effectName: effect?.name ?? effect?.id ?? null,
    key: change?.key ?? null,

    debug: {
      helperNorm,
      queryNorm,
      crisisDetected: queryNorm === "crisis" ? isActorInCrisis(actor, effect) : null,
conditionEffects: queryNorm === "crisis"
  ? collectActorConditionEffects(actor).map(e => ({
      name: e.name,
      id: e.id,
      uuid: e.uuid,
      parentName: e.parent?.name ?? null,
      parentType: e.parent?.documentName ?? e.parent?.constructor?.name ?? null,
      source: e.__oniAeGateConditionSource ?? null,
      statuses: safeArrayFrom(e.statuses)
    }))
  : null
    }
  };

  log("Gate evaluated.", result);
  return result;
}

  function listAllGateChanges(actor) {
    const rows = [];

    for (const effect of collectActorEffects(actor)) {
      const scans = [
        {
          source: "effect.changes",
          changes: Array.isArray(effect?.changes) ? effect.changes : []
        },
        {
          source: "effect._source.changes",
          changes: Array.isArray(effect?._source?.changes) ? effect._source.changes : []
        }
      ];

      for (const scan of scans) {
        for (let i = 0; i < scan.changes.length; i++) {
          const change = scan.changes[i];
          if (!hasGateSyntax(change?.value)) continue;

          let decision = null;
          try {
            decision = evaluateGate(change.value, actor, effect, change);
          } catch (err) {
            decision = { error: String(err?.message ?? err) };
          }

          rows.push({
            source: scan.source,
            effect: summarizeEffect(effect),
            index: i,
            change: summarizeChange(change),
            decision
          });
        }
      }
    }

    return rows;
  }

  // ------------------------------------------------------------
  // Baseline / false gate fallback
  // ------------------------------------------------------------

  function isBlankish(value) {
  return value === undefined || value === null || value === "";
}

function isBrokenGateValue(value) {
  return hasGateSyntax(value);
}

function isAffinityKey(key) {
  return /^affinity_\d+$/i.test(String(key ?? "").trim());
}

function getActorNumberProp(actor, key) {
  const props = actor?.system?.props ?? {};
  const value = Number(props[key]);
  return Number.isFinite(value) ? value : NaN;
}

function isActorInCrisis(actor, currentEffect = null) {
  if (!actor) return false;

  // Strict behavior:
  // Crisis is true ONLY when an actual active Crisis condition/effect exists.
  // No HP fallback here, because Dark Blood specifically requires the Crisis effect.
  return hasEffect(actor, "Crisis", currentEffect);
}

  function getActorSourceProps(actor) {
    return (
      actor?._source?.system?.props ??
      actor?.system?._source?.props ??
      actor?.system?.props ??
      {}
    );
  }

  function makeActorPassData(actor) {
    const sourceProps = clone(getActorSourceProps(actor) ?? {});
    const currentProps = clone(actor?.system?.props ?? {});

    return {
      actor,
      startedAt: Date.now(),
      sourceProps,
      currentProps
    };
  }

  function getActorPassData(actor) {
    if (!actor) return null;

    let data = state.actorPass.get(actor);

    if (!data) {
      data = makeActorPassData(actor);
      state.actorPass.set(actor, data);
    }

    return data;
  }

  function clearActorPassData(actor) {
    if (!actor) return;
    state.actorPass.delete(actor);
  }

function getBaseValueForChange(actor, change) {
  const key = String(change?.key ?? "").trim();
  if (!actor || !key) return "";

  const pass = getActorPassData(actor);
  const sourceProps = pass?.sourceProps ?? {};
  const currentProps = pass?.currentProps ?? {};

  const cleanCandidate = (...values) => {
    for (const value of values) {
      if (isBlankish(value)) continue;
      if (isBrokenGateValue(value)) continue;
      return value;
    }

    return undefined;
  };

  // ------------------------------------------------------------
  // Important rule:
  // Gated affinity effects should always fall back to NA when false.
  //
  // Reason:
  // If Dark Blood was previously true, the actor may currently store RS.
  // When Crisis turns off, preserving the current value would preserve RS.
  // But false Dark Blood means "do not modify affinity", and the normal
  // default affinity value is NA.
  // ------------------------------------------------------------

  if (!key.includes(".")) {
    if (isAffinityKey(key)) return "NA";

    const clean = cleanCandidate(sourceProps[key], currentProps[key]);
    if (clean !== undefined) return clean;

    return "";
  }

  if (key.startsWith("system.props.")) {
    const shortKey = key.slice("system.props.".length);

    if (isAffinityKey(shortKey)) return "NA";

    const clean = cleanCandidate(sourceProps[shortKey], currentProps[shortKey]);
    if (clean !== undefined) return clean;

    return "";
  }

  return "";
}

  // ------------------------------------------------------------
  // Patch 1: ActiveEffect.apply
  // ------------------------------------------------------------

  function transformApplyArgs(effect, args) {
    const explicitActor = args.find((arg) => isActorDocument(arg)) ?? null;
    const actor = resolveActorFromEffect(effect, explicitActor);

    pushTrace("ActiveEffect.apply ENTER", actor, {
      effect: summarizeEffect(effect),
      args: summarizeArgs(args),
      actorBefore: actor ? actorTraceSnapshot(actor) : null
    });

    if (!actor) {
      return {
        changed: false,
        args,
        reason: "no_actor"
      };
    }

    return withActorCache(actor, () => {
      let changed = false;
      const nextArgs = [...args];

      for (let i = 0; i < nextArgs.length; i++) {
        const arg = nextArgs[i];

        if (!arg || typeof arg.value !== "string") continue;

        pushTrace("ActiveEffect.apply CHANGE SEEN", actor, {
          effect: summarizeEffect(effect),
          argIndex: i,
          change: summarizeChange(arg),
          actorSnapshot: actorTraceSnapshot(actor)
        });

        if (!hasGateSyntax(arg.value)) continue;

        const decision = evaluateGate(arg.value, actor, effect, arg);

        pushTrace("ActiveEffect.apply GATE DECISION", actor, {
          effect: summarizeEffect(effect),
          argIndex: i,
          change: summarizeChange(arg),
          decision,
          actorSnapshot: actorTraceSnapshot(actor)
        });

        if (!decision.recognized) continue;

        const cloned = clone(arg);

        if (decision.active) {
          cloned.value = decision.value;

          pushTrace("ActiveEffect.apply TRANSFORM TRUE", actor, {
            effect: summarizeEffect(effect),
            before: summarizeChange(arg),
            after: summarizeChange(cloned),
            decision
          });
        } else {
          const fallbackRaw = getBaseValueForChange(actor, arg);
          const fallbackValue = stringifyActiveEffectValue(fallbackRaw);

          cloned.value = fallbackValue;

          pushTrace("ActiveEffect.apply TRANSFORM FALSE TO BASE", actor, {
            effect: summarizeEffect(effect),
            before: summarizeChange(arg),
            after: summarizeChange(cloned),
            fallbackRaw,
            fallbackValue,
            decision,
            actorSnapshot: actorTraceSnapshot(actor)
          });
        }

        nextArgs[i] = cloned;
        changed = true;
      }

      return {
        changed,
        args: changed ? nextArgs : args,
        reason: changed ? "gate_transformed" : "no_gate_change"
      };
    });
  }

  function getActiveEffectPatchTarget() {
    const candidates = [
      CONFIG?.ActiveEffect?.documentClass,
      globalThis.CustomActiveEffect,
      globalThis.ActiveEffect?.implementation,
      globalThis.ActiveEffect
    ].filter(Boolean);

    const uniqueCandidates = [...new Set(candidates)];

    for (const cls of uniqueCandidates) {
      const proto = cls?.prototype;
      if (proto && typeof proto.apply === "function") {
        return { cls, proto };
      }
    }

    return null;
  }

  function restoreExistingEffectPatch(proto) {
    if (!proto) return false;

    if (proto[PATCH_FLAGS.effectPatched] && typeof proto[PATCH_FLAGS.effectOriginal] === "function") {
      proto.apply = proto[PATCH_FLAGS.effectOriginal];
      delete proto[PATCH_FLAGS.effectPatched];
      delete proto[PATCH_FLAGS.effectOriginal];
      delete proto[PATCH_FLAGS.effectVersion];
      return true;
    }

    return false;
  }

  function patchActiveEffectDirect({ force = false } = {}) {
    const target = getActiveEffectPatchTarget();

    if (!target) {
      warn("Could not patch ActiveEffect.apply(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto[PATCH_FLAGS.effectPatched]) {
      const oldVersion = proto[PATCH_FLAGS.effectVersion] ?? "unknown";

      if (!force && oldVersion === VERSION) {
        state.effectPatched = true;
        state.effectPatchTarget = cls?.name ?? "ActiveEffect";
        state.effectPatchMode = "direct-existing-current";
        return true;
      }

      const restored = restoreExistingEffectPatch(proto);
      console.warn(TAG, "Restored previous ActiveEffect.apply patch before repatching.", {
        oldVersion,
        restored
      });
    }

    const original = proto.apply;

    proto.apply = function oniAeConditionalGateApply(...args) {
      if (!isEnabled()) {
        return original.apply(this, args);
      }

      const result = transformApplyArgs(this, args);
      return original.apply(this, result.args);
    };

    proto[PATCH_FLAGS.effectPatched] = true;
    proto[PATCH_FLAGS.effectOriginal] = original;
    proto[PATCH_FLAGS.effectVersion] = VERSION;

    state.effectPatched = true;
    state.effectPatchTarget = cls?.name ?? "ActiveEffect";
    state.effectPatchMode = "direct";

    console.log(TAG, `Patched ${state.effectPatchTarget}.prototype.apply() directly.`, { version: VERSION });
    return true;
  }

  function patchActiveEffectLibWrapper() {
    if (!globalThis.libWrapper || !preferLibWrapper()) return false;

    try {
      libWrapper.register(
        MODULE_ID,
        "CONFIG.ActiveEffect.documentClass.prototype.apply",
        function oniAeConditionalGateApplyWrapper(wrapped, ...args) {
          if (!isEnabled()) {
            return wrapped(...args);
          }

          const result = transformApplyArgs(this, args);
          return wrapped(...result.args);
        },
        "WRAPPER"
      );

      state.effectPatched = true;
      state.effectPatchTarget = CONFIG?.ActiveEffect?.documentClass?.name ?? "CONFIG.ActiveEffect.documentClass";
      state.effectPatchMode = "libWrapper";

      console.log(TAG, `Patched ${state.effectPatchTarget}.prototype.apply() with libWrapper.`, { version: VERSION });
      return true;
    } catch (err) {
      warn("libWrapper ActiveEffect.apply patch failed. Falling back to direct patch.", err);
      return false;
    }
  }

  function patchActiveEffectApply({ force = false } = {}) {
    if (state.effectPatched && !force) return true;
    return patchActiveEffectLibWrapper() || patchActiveEffectDirect({ force });
  }

  // ------------------------------------------------------------
  // Patch 2: Actor.applyActiveEffects
  // This creates the source baseline used by false gates.
  // ------------------------------------------------------------

  function withGatedActorChanges(actor, callback) {
    if (!isEnabled()) return callback();
    if (!actor) return callback();

    if (state.actorGuard.has(actor)) {
      pushTrace("Actor.applyActiveEffects REENTRY BYPASS", actor, {
        actorBefore: actorTraceSnapshot(actor)
      });

      return callback();
    }

    const before = actorTraceSnapshot(actor);
    const gateChangesBefore = listAllGateChanges(actor);

    pushTrace("Actor.applyActiveEffects BEFORE", actor, {
      actorBefore: before,
      gateChangesBefore,
      sourceProps: clone(getActorSourceProps(actor) ?? {})
    });

    state.actorGuard.add(actor);
    state.actorPass.set(actor, makeActorPassData(actor));

    const finish = (result = undefined, error = null) => {
      const after = actorTraceSnapshot(actor);
      const diff = diffSnapshots(before, after);
      const gateChangesAfter = listAllGateChanges(actor);

      pushTrace(error ? "Actor.applyActiveEffects ERROR/AFTER" : "Actor.applyActiveEffects AFTER", actor, {
        actorBefore: before,
        actorAfter: after,
        diff,
        gateChangesBefore,
        gateChangesAfter,
        error: error ? String(error?.stack ?? error?.message ?? error) : null
      });

      clearActorPassData(actor);
      state.actorGuard.delete(actor);

      return result;
    };

    try {
      const result = withActorCache(actor, () => callback());

      return resolveMaybePromise(
        result,
        (value) => finish(value, null),
        (err) => {
          finish(undefined, err);
          throw err;
        }
      );
    } catch (err) {
      finish(undefined, err);
      throw err;
    }
  }

  function getActorPatchTarget() {
    const candidates = [
      CONFIG?.Actor?.documentClass,
      globalThis.CustomActor,
      globalThis.Actor
    ].filter(Boolean);

    const uniqueCandidates = [...new Set(candidates)];

    for (const cls of uniqueCandidates) {
      const proto = cls?.prototype;
      if (proto && typeof proto.applyActiveEffects === "function") {
        return { cls, proto };
      }
    }

    return null;
  }

  function restoreExistingActorPatch(proto) {
    if (!proto) return false;

    if (proto[PATCH_FLAGS.actorPatched] && typeof proto[PATCH_FLAGS.actorOriginal] === "function") {
      proto.applyActiveEffects = proto[PATCH_FLAGS.actorOriginal];
      delete proto[PATCH_FLAGS.actorPatched];
      delete proto[PATCH_FLAGS.actorOriginal];
      delete proto[PATCH_FLAGS.actorVersion];
      return true;
    }

    return false;
  }

  function patchActorDirect({ force = false } = {}) {
    const target = getActorPatchTarget();

    if (!target) {
      warn("Could not patch Actor.applyActiveEffects(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto[PATCH_FLAGS.actorPatched]) {
      const oldVersion = proto[PATCH_FLAGS.actorVersion] ?? "unknown";

      if (!force && oldVersion === VERSION) {
        state.actorPatched = true;
        state.actorPatchTarget = cls?.name ?? "Actor";
        state.actorPatchMode = "direct-existing-current";
        return true;
      }

      const restored = restoreExistingActorPatch(proto);
      console.warn(TAG, "Restored previous Actor.applyActiveEffects patch before repatching.", {
        oldVersion,
        restored
      });
    }

    const original = proto.applyActiveEffects;

    proto.applyActiveEffects = function oniAeConditionalGateActorApply(...args) {
      return withGatedActorChanges(this, () => {
        return original.apply(this, args);
      });
    };

    proto[PATCH_FLAGS.actorPatched] = true;
    proto[PATCH_FLAGS.actorOriginal] = original;
    proto[PATCH_FLAGS.actorVersion] = VERSION;

    state.actorPatched = true;
    state.actorPatchTarget = cls?.name ?? "Actor";
    state.actorPatchMode = "direct";

    console.log(TAG, `Patched ${state.actorPatchTarget}.prototype.applyActiveEffects() directly.`, { version: VERSION });
    return true;
  }

  function patchActorLibWrapper() {
    if (!globalThis.libWrapper || !preferLibWrapper()) return false;

    try {
      libWrapper.register(
        MODULE_ID,
        "CONFIG.Actor.documentClass.prototype.applyActiveEffects",
        function oniAeConditionalGateActorWrapper(wrapped, ...args) {
          return withGatedActorChanges(this, () => {
            return wrapped(...args);
          });
        },
        "WRAPPER"
      );

      state.actorPatched = true;
      state.actorPatchTarget = CONFIG?.Actor?.documentClass?.name ?? "CONFIG.Actor.documentClass";
      state.actorPatchMode = "libWrapper";

      console.log(TAG, `Patched ${state.actorPatchTarget}.prototype.applyActiveEffects() with libWrapper.`, { version: VERSION });
      return true;
    } catch (err) {
      warn("libWrapper Actor.applyActiveEffects patch failed. Falling back to direct patch.", err);
      return false;
    }
  }

  function patchActorApplyActiveEffects({ force = false } = {}) {
    if (state.actorPatched && !force) return true;
    return patchActorLibWrapper() || patchActorDirect({ force });
  }

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------

  function getActorFromInput(actorOrName) {
    if (typeof actorOrName === "string") {
      return game.actors.getName(actorOrName) ?? game.actors.get(actorOrName);
    }

    return actorOrName;
  }

  function getPatchStatusDetails() {
    const actorTarget = getActorPatchTarget();
    const effectTarget = getActiveEffectPatchTarget();

    return {
      actorPrototype: actorTarget?.cls?.name ?? null,
      actorPrototypePatched: !!actorTarget?.proto?.[PATCH_FLAGS.actorPatched],
      actorPrototypeVersion: actorTarget?.proto?.[PATCH_FLAGS.actorVersion] ?? null,
      actorHasOriginal: typeof actorTarget?.proto?.[PATCH_FLAGS.actorOriginal] === "function",

      effectPrototype: effectTarget?.cls?.name ?? null,
      effectPrototypePatched: !!effectTarget?.proto?.[PATCH_FLAGS.effectPatched],
      effectPrototypeVersion: effectTarget?.proto?.[PATCH_FLAGS.effectVersion] ?? null,
      effectHasOriginal: typeof effectTarget?.proto?.[PATCH_FLAGS.effectOriginal] === "function"
    };
  }

  function installApi() {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};

    globalThis.FUCompanion.api.activeEffectConditionalGate = {
      status() {
        const enabled = isEnabled();
        const ok = enabled && !!state.actorPatched && !!state.effectPatched;

        return {
          ok,
          version: VERSION,
          enabled,

          strategy: "active-effect-apply-transform-source-fallback",
          falseGateBehavior: "transform-to-source-base-value",
          neverReturnsNull: true,

          actorPatched: !!state.actorPatched,
          actorPatchTarget: state.actorPatchTarget,
          actorPatchMode: state.actorPatchMode,

          effectPatched: !!state.effectPatched,
          effectPatchTarget: state.effectPatchTarget,
          effectPatchMode: state.effectPatchMode,

          debug: isDebug(),
          trace: {
            enabled: !!state.trace.enabled,
            actorName: state.trace.actorName,
            events: state.trace.events.length,
            maxEvents: state.trace.maxEvents,
            keys: [...state.trace.keys]
          },

          patchDetails: getPatchStatusDetails(),

          libWrapperAvailable: !!globalThis.libWrapper,
          preferLibWrapper: preferLibWrapper(),

          helpers: HELPERS
        };
      },

      async setEnabled(value = true) {
        await setSetting("enabled", Boolean(value));
        return this.status();
      },

      async setDebug(value = true) {
        state.debug = Boolean(value);
        await setSetting("debug", Boolean(value));
        console.log(TAG, "Debug mode:", isDebug());
        return isDebug();
      },

      setTrace(enabled = true, options = {}) {
        state.trace.enabled = !!enabled;

        if (options.actorName !== undefined) {
          state.trace.actorName = String(options.actorName ?? "").trim();
        }

        if (Array.isArray(options.keys) && options.keys.length) {
          state.trace.keys = Array.from(new Set(options.keys.filter(Boolean).map(String)));
        }

        if (Number.isFinite(Number(options.maxEvents))) {
          state.trace.maxEvents = Math.max(20, Number(options.maxEvents));
        }

        console.warn(TRACE_TAG, "Trace mode updated.", this.status().trace);
        return this.status().trace;
      },

      clearTrace() {
        state.trace.events = [];
        state.trace.seq = 0;
        console.warn(TRACE_TAG, "Trace buffer cleared.");
        return true;
      },

      getTrace() {
        return clone(state.trace.events);
      },

      getTraceTable() {
        return state.trace.events.map(e => ({
          seq: e.seq,
          label: e.label,
          actor: e.actor,

          effect:
            e.data?.effect?.name ??
            e.data?.decision?.effectName ??
            null,

          collectorSource:
            e.data?.effect?.collectorSource ??
            null,

          key:
            e.data?.change?.key ??
            e.data?.decision?.key ??
            e.data?.before?.key ??
            e.data?.after?.key ??
            null,

          gateActive: e.data?.decision?.active ?? null,
          gateValue: e.data?.decision?.value ?? null,

          fallbackValue: e.data?.fallbackValue ?? null,

          defenseBefore: e.data?.actorBefore?.keys?.defense,
          defenseAfter: e.data?.actorAfter?.keys?.defense,

          baseDefBefore: e.data?.actorBefore?.keys?.base_defense,
          baseDefAfter: e.data?.actorAfter?.keys?.base_defense,

          mdefBefore: e.data?.actorBefore?.keys?.magic_defense,
          mdefAfter: e.data?.actorAfter?.keys?.magic_defense,

          baseMdefBefore: e.data?.actorBefore?.keys?.base_magic_defense,
          baseMdefAfter: e.data?.actorAfter?.keys?.base_magic_defense,

          affinity4Before: e.data?.actorBefore?.keys?.affinity_4,
          affinity4After: e.data?.actorAfter?.keys?.affinity_4,

          affinity9Before: e.data?.actorBefore?.keys?.affinity_9,
          affinity9After: e.data?.actorAfter?.keys?.affinity_9,

          diff: JSON.stringify(e.data?.diff ?? {})
        }));
      },

      dumpActor(actorOrName = "Hina") {
        const actor = getActorFromInput(actorOrName);

        if (!actor) {
          return {
            ok: false,
            reason: "Actor not found.",
            actor: actorOrName
          };
        }

        const result = withActorCache(actor, () => ({
          ok: true,
          version: VERSION,
          actor: actor.name,
          snapshot: actorTraceSnapshot(actor),
          sourceProps: clone(getActorSourceProps(actor) ?? {}),
          gateChanges: listAllGateChanges(actor),
          effects: collectActorEffects(actor).map(effect => ({
            effect: summarizeEffect(effect),
            changes: Array.isArray(effect?.changes)
              ? effect.changes.map(summarizeChange)
              : [],
            sourceChanges: Array.isArray(effect?._source?.changes)
              ? effect._source.changes.map(summarizeChange)
              : []
          })),
          status: this.status()
        }));

        console.warn(TRACE_TAG, "Actor dump.", result);
        return result;
      },

      parse(value) {
        return parseGateSyntax(value);
      },

      test(actorOrName, value) {
        const actor = getActorFromInput(actorOrName);

        if (!actor) {
          return {
            ok: false,
            reason: "Actor not found.",
            actor: actorOrName,
            value
          };
        }

        return withActorCache(actor, () => {
          const result = evaluateGate(value, actor);

          return {
            ok: true,
            actor: actor.name,
            input: value,
            result,
            detectedEffects: collectActorEffects(actor).map(e => ({
              name: e.name,
              id: e.id,
              uuid: e.uuid,
              disabled: e.disabled,
              source: e.__oniAeGateSource ?? null,
              statuses: safeArrayFrom(e.statuses)
            })),
            status: this.status()
          };
        });
      },

      forcePatch() {
        state.actorPatched = false;
        state.effectPatched = false;

        const actorPatch = patchActorApplyActiveEffects({ force: true });
        const effectPatch = patchActiveEffectApply({ force: true });

        return {
          actorPatch,
          effectPatch,
          status: this.status()
        };
      },

      restorePatches() {
        const actorTarget = getActorPatchTarget();
        const effectTarget = getActiveEffectPatchTarget();

        const actorRestored = restoreExistingActorPatch(actorTarget?.proto);
        const effectRestored = restoreExistingEffectPatch(effectTarget?.proto);

        state.actorPatched = false;
        state.actorPatchTarget = null;
        state.actorPatchMode = null;

        state.effectPatched = false;
        state.effectPatchTarget = null;
        state.effectPatchMode = null;

        return {
          actorRestored,
          effectRestored,
          status: this.status()
        };
      },

      async selfTest(actorOrName = "Hina") {
        const actor = getActorFromInput(actorOrName);
        if (!actor) {
          return { ok: false, reason: "actor_not_found", actor: actorOrName };
        }

        this.clearTrace();
        this.setTrace(true, { actorName: actor.name, maxEvents: 1500 });

        const before = actorTraceSnapshot(actor);
        const dumpBefore = this.dumpActor(actor);

        try {
          actor.applyActiveEffects();
        } catch (err) {
          return {
            ok: false,
            reason: "applyActiveEffects_failed",
            error: String(err?.stack ?? err?.message ?? err),
            before,
            trace: this.getTrace()
          };
        }

        const after = actorTraceSnapshot(actor);
        const dumpAfter = this.dumpActor(actor);

        return {
          ok: true,
          actor: actor.name,
          before,
          after,
          diff: diffSnapshots(before, after),
          dumpBefore,
          dumpAfter,
          traceTable: this.getTraceTable(),
          status: this.status()
        };
      }
    };
  }

  // ------------------------------------------------------------
  // Startup
  // ------------------------------------------------------------

  Hooks.once("init", () => {
    registerSettings();
    state.debug = !!getSetting("debug", false);

    installApi();
    patchActorApplyActiveEffects({ force: true });
    patchActiveEffectApply({ force: true });
  });

  Hooks.once("ready", () => {
    registerSettings();
    state.debug = !!getSetting("debug", false);

    installApi();

    if (!state.actorPatched) {
      patchActorApplyActiveEffects({ force: true });
    }

    if (!state.effectPatched) {
      patchActiveEffectApply({ force: true });
    }

    console.debug(TAG, "Ready.", globalThis.FUCompanion.api.activeEffectConditionalGate.status());
  });
})();