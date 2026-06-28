/*:
 * @target Foundry VTT v12
 * @plugindesc [ONI] Extends Active Effect value syntax with actor-aware helpers like ae("Wet").
 *
 * File:
 * modules/fabula-ultima-companion/scripts/active-effect-syntax-extender.js
 */

(() => {
  "use strict";

  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][AE-Syntax]";

  const HELPERS = ["ae", "aeUuid", "aeStatus", "countAe", "aeValue", "hasWeapon", "countWeapons"];

  // Weapon-category aliases — mirrors normalizeWeaponCategory() in
  // passive-modifier-engine.js / formula-evaluator.js so hasWeapon("staff")
  // matches an arcane weapon exactly like the reaction-side HAS_ARCANE_WEAPON.
  const WEAPON_CATEGORY_ALIASES = {
    arcana: "arcane", arcane: "arcane", wand: "arcane", staff: "arcane", tome: "arcane",
    dagger: "dagger", knife: "dagger",
    flail: "flail", mace: "flail"
  };
  const normalizeWeaponCategory = (value) => {
    const v = String(value ?? "").trim().toLowerCase();
    if (!v) return "";
    return WEAPON_CATEGORY_ALIASES[v] ?? v;
  };

  // Degraded-mode floor for the shared "state" identifier vocabulary. The
  // CANONICAL source is globalThis["oni.IdentifierRegistry"] (loaded from
  // esmodules on a world relaunch). This list is consulted ONLY when the
  // registry is absent — e.g. an F5 before a relaunch pulled the registry in —
  // so an unresolved STATUS_COUNT-style token degrades to 0 (the effect goes
  // inert) instead of leaking a bare identifier into CSB's mathjs, which would
  // compute the WHOLE prop to `undefined` and break the carrier's checks/damage.
  // Keep in sync with identifier-registry.js STATE_IDENTIFIERS when ids are added.
  const FALLBACK_STATE_IDENTIFIERS = ["STATUS_COUNT"];

  // Registry names when loaded, else the local degraded-mode floor.
  const getStateIdentifierNames = () => {
    const names = globalThis["oni.IdentifierRegistry"]?.stateIdentifierNames;
    return (Array.isArray(names) && names.length) ? names : FALLBACK_STATE_IDENTIFIERS;
  };

  const state = {
    settingsRegistered: false,

    debug: false,

    actorPatched: false,
    actorPatchTarget: null,
    actorPatchMode: null,
    originalApplyActiveEffects: null,

    customEffectPatched: false,
    customEffectPatchTarget: null,
    customEffectPatchMode: null,
    originalCustomEffectApply: null,

    actorCache: new WeakMap(),
    actorGuard: new WeakSet(),
    customEffectGuard: new WeakSet(),
    warningSeen: new Set()
  };

  // ------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------

  const settingDefs = {
    enabled: {
      name: "Enable Active Effect Syntax Extender",
      hint: "Allows custom Active Effect syntax helpers such as ae(\"Wet\").",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    },

    debug: {
      name: "AE Syntax Debug Logs",
      hint: "Prints detailed transform logs for custom Active Effect syntax.",
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    },

    warnings: {
      name: "AE Syntax Formula Warnings",
      hint: "Warns when a custom formula may fail in Custom System Builder, such as using && instead of and(...).",
      scope: "client",
      config: true,
      type: Boolean,
      default: true
    },

    strict: {
      name: "AE Syntax Strict Warning Mode",
      hint: "Shows formula warnings more loudly. This does not block formulas; it only helps debugging.",
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    },

    useLibWrapper: {
      name: "AE Syntax Prefer libWrapper",
      hint: "Usually leave this OFF when AE Conditional Gate is also installed. Both systems patch the same Active Effect methods, so direct patching avoids libWrapper self-conflict warnings.",
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    }
  };

  const registerSettings = () => {
    if (state.settingsRegistered) return;

    for (const [key, data] of Object.entries(settingDefs)) {
      try {
        game.settings.register(MODULE_ID, `activeEffectSyntax.${key}`, data);
      } catch (_err) {
        // Already registered, or settings unavailable very early.
      }
    }

    state.settingsRegistered = true;
  };

  const getSetting = (key, fallback = undefined) => {
    try {
      return game.settings.get(MODULE_ID, `activeEffectSyntax.${key}`);
    } catch (_err) {
      return fallback ?? settingDefs[key]?.default;
    }
  };

  const setSetting = async (key, value) => {
    try {
      await game.settings.set(MODULE_ID, `activeEffectSyntax.${key}`, value);
    } catch (_err) {
      // Client/world setting write may fail during early init; keep runtime value.
    }
  };

  const isEnabled = () => !!getSetting("enabled", true);
  const isDebug = () => !!state.debug || !!getSetting("debug", false);
  const warningsEnabled = () => !!getSetting("warnings", true);
  const strictWarnings = () => !!getSetting("strict", false);
  const preferLibWrapper = () => !!getSetting("useLibWrapper", true);

  // ------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------

  const normalize = (value) => {
    return String(value ?? "").trim().toLowerCase();
  };

  const isActorDocument = (doc) => {
    return doc?.documentName === "Actor";
  };

  const safeArrayFrom = (value) => {
    if (!value) return [];

    try {
      if (globalThis.Collection && value instanceof Collection) {
        return Array.from(value.values());
      }

      if (typeof value.values === "function") {
        return Array.from(value.values());
      }

      if (Array.isArray(value)) {
        return value;
      }

      if (Symbol.iterator in Object(value) && typeof value !== "string") {
        return Array.from(value);
      }
    } catch (_err) {}

    return [];
  };

  const isEffectUsable = (effect) => {
    if (!effect) return false;
    if (effect.disabled) return false;
    if (effect.isSuppressed) return false;
    return true;
  };

  const hasCustomSyntax = (value) => {
    if (typeof value !== "string") return false;
    if (/\b(?:ae|aeUuid|aeStatus|countAe|aeValue|propAtLeast|hasWeapon|countWeapons)\s*\(/.test(value)) return true;
    // Shared "state" identifiers (STATUS_COUNT, …) — bare UPPER_SNAKE tokens,
    // kept in sync with the reaction/BD evaluators via the identifier registry.
    // Matched even when the registry is absent (degraded-mode floor) so the
    // token is routed into transformValue, which degrades it to 0 rather than
    // leaving it to poison the prop.
    const names = getStateIdentifierNames();
    if (names.length
        && new RegExp("\\b(?:" + names.join("|") + ")\\b").test(value)) return true;
    return false;
  };

  const getDocName = (doc) => {
    return doc?.name ?? doc?.id ?? doc?._id ?? "(unknown)";
  };

  const unique = (arr) => [...new Set(arr)];

  // ------------------------------------------------------------
  // Formula validator / linter
  // ------------------------------------------------------------

  const countUnescaped = (text, char) => {
    let count = 0;
    let escaped = false;

    for (const c of String(text ?? "")) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (c === "\\") {
        escaped = true;
        continue;
      }

      if (c === char) count++;
    }

    return count;
  };

  const validateFormula = (value) => {
    const text = String(value ?? "");
    const warnings = [];
    const errors = [];

    if (!text.trim()) {
      return {
        ok: true,
        warnings,
        errors
      };
    }

    if (hasCustomSyntax(text) && (!text.includes("${") || !text.includes("}$"))) {
      warnings.push("Custom AE syntax is usually safest inside ${ ... }$.");
    }

    if (text.includes("&&")) {
      warnings.push("Found &&. CSB/math.js may reject this. Use and(...) instead.");
    }

    if (text.includes("||")) {
      warnings.push("Found ||. CSB/math.js may reject this. Use or(...) instead.");
    }

    if (/(^|[^=!<>])!(?!=)/.test(text)) {
      warnings.push("Found !. CSB/math.js may reject this. Use not(...) instead.");
    }

    if (countUnescaped(text, "\"") % 2 !== 0) {
      errors.push("Unclosed double quote detected.");
    }

    if (countUnescaped(text, "'") % 2 !== 0) {
      errors.push("Unclosed single quote detected.");
    }

    const openCount = (text.match(/\$\{/g) ?? []).length;
    const closeCount = (text.match(/\}\$/g) ?? []).length;
    if (openCount !== closeCount) {
      errors.push(`Mismatched formula wrapper count: found ${openCount} opening \${ and ${closeCount} closing }$.`);
    }

    const helperCalls = [...text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(m => m[1]);
    for (const helper of helperCalls) {
      const lower = normalize(helper);

      const looksLikeOniHelper =
        lower.startsWith("ae")
        || lower.startsWith("countae")
        || lower.includes("activeeffect");

      if (looksLikeOniHelper && !HELPERS.map(normalize).includes(lower)) {
        warnings.push(`Unknown AE syntax helper "${helper}". Supported helpers: ${HELPERS.join(", ")}.`);
      }
    }

    return {
      ok: errors.length === 0,
      warnings: unique(warnings),
      errors: unique(errors)
    };
  };

  const maybeWarnFormula = ({ value, actor, effect, source }) => {
    if (!warningsEnabled()) return;

    const report = validateFormula(value);
    if (report.warnings.length === 0 && report.errors.length === 0) return;

    const key = [
      source ?? "unknown",
      actor?.uuid ?? actor?.id ?? actor?.name ?? "no-actor",
      effect?.uuid ?? effect?.id ?? effect?.name ?? "no-effect",
      value
    ].join("|");

    if (state.warningSeen.has(key)) return;
    state.warningSeen.add(key);

    const payload = {
      actor: actor?.name ?? null,
      effect: effect?.name ?? effect?.id ?? null,
      source,
      value,
      warnings: report.warnings,
      errors: report.errors
    };

    if (strictWarnings() || report.errors.length > 0) {
      console.warn(`${TAG} Formula warning`, payload);
    } else {
      console.info(`${TAG} Formula note`, payload);
    }
  };

  // ------------------------------------------------------------
  // Actor / Effect resolution
  // ------------------------------------------------------------

  const resolveActorFromEffect = (effect, explicitActor = null) => {
    if (isActorDocument(explicitActor)) return explicitActor;
    if (explicitActor?.actor && isActorDocument(explicitActor.actor)) return explicitActor.actor;

    let parent = effect?.parent ?? null;

    for (let i = 0; parent && i < 10; i++) {
      if (isActorDocument(parent)) return parent;
      if (parent.actor && isActorDocument(parent.actor)) return parent.actor;
      parent = parent.parent ?? null;
    }

    return null;
  };

  const collectActorEffects = (actor) => {
    const results = [];
    const seen = new Set();

    const add = (effect) => {
      if (!effect) return;

      const id = effect.uuid ?? effect.id ?? effect._id ?? `${effect.name}-${results.length}`;
      if (seen.has(id)) return;

      seen.add(id);
      results.push(effect);
    };

    for (const effect of safeArrayFrom(actor?.effects)) {
      add(effect);
    }

    try {
      for (const effect of safeArrayFrom(actor?.temporaryEffects)) {
        add(effect);
      }
    } catch (_err) {}

    return results.filter(isEffectUsable);
  };

  const buildActorCache = (actor) => {
    const effects = collectActorEffects(actor);

    const names = new Set();
    const uuids = new Set();
    const statuses = new Set();
    const nameCounts = new Map();

    const addName = (raw) => {
      const key = normalize(raw);
      if (!key) return;

      names.add(key);
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
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
      nameCounts,
      createdAt: Date.now()
    };
  };

  const getActorCache = (actor) => {
    if (!actor) return null;

    let cache = state.actorCache.get(actor);
    if (!cache) {
      cache = buildActorCache(actor);
      state.actorCache.set(actor, cache);
    }

    return cache;
  };

  const withActorCache = (actor, callback) => {
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
  };

  // ------------------------------------------------------------
  // Effect helper checks
  // ------------------------------------------------------------

  const hasEffect = (actor, effectName) => {
    const cache = getActorCache(actor);
    if (!cache) return false;

    const wanted = normalize(effectName);
    if (!wanted) return false;

    return cache.names.has(wanted) || cache.statuses.has(wanted);
  };

  const hasEffectUuid = (actor, uuid) => {
    const cache = getActorCache(actor);
    if (!cache) return false;

    const wanted = normalize(uuid);
    if (!wanted) return false;

    return cache.uuids.has(wanted);
  };

  const hasEffectStatus = (actor, statusId) => {
    const cache = getActorCache(actor);
    if (!cache) return false;

    const wanted = normalize(statusId);
    if (!wanted) return false;

    return cache.statuses.has(wanted);
  };

  const countEffect = (actor, effectName) => {
    const cache = getActorCache(actor);
    if (!cache) return 0;

    const wanted = normalize(effectName);
    if (!wanted) return 0;

    const byName = cache.nameCounts.get(wanted) ?? 0;
    const byStatus = cache.statuses.has(wanted) ? 1 : 0;

    return Math.max(byName, byStatus);
  };

  // ------------------------------------------------------------
  // Weapon-category detection
  // ------------------------------------------------------------
  // Replicates the reaction-side HAS_ARCANE_WEAPON gate (passive-modifier-engine
  // _hasArcaneWeapon, lines ~527-534): an item is a counted weapon if it is
  // type "weapon", equipped, and its normalized category matches. This lets a
  // passive accuracy/damage skill that gated on an equipped weapon category
  // (e.g. Magical Artillery) be authored as a transfer AE instead of a reaction.

  const isWeaponItem = (item) => {
    const p = item?.system?.props ?? {};
    const t = String(p.item_type ?? item?.system?.item_type ?? item?.type ?? "").trim().toLowerCase();
    return t === "weapon";
  };

  const isWeaponEquipped = (item) => {
    const p = item?.system?.props ?? {};
    const candidates = [p.isEquipped, p.equipped, item?.system?.equipped, item?.equipped, item?.isEquipped];
    return candidates.some(v => v === true || v === "true" || v === 1 || v === "1");
  };

  const itemWeaponCategory = (item) => {
    const p = item?.system?.props ?? {};
    return normalizeWeaponCategory(p.category ?? item?.system?.category ?? item?.category ?? "");
  };

  // Count of EQUIPPED weapons of the given category on the actor.
  const countEquippedWeapons = (actor, category) => {
    const wanted = normalizeWeaponCategory(category);
    if (!actor || !wanted) return 0;
    let count = 0;
    for (const item of safeArrayFrom(actor.items)) {
      if (!isWeaponItem(item)) continue;
      if (!isWeaponEquipped(item)) continue;
      if (itemWeaponCategory(item) === wanted) count++;
    }
    return count;
  };

  // ------------------------------------------------------------
  // Syntax transform
  // ------------------------------------------------------------

  const transformValue = (value, context = {}) => {
    if (typeof value !== "string") {
      return {
        changed: false,
        value
      };
    }

    if (!hasCustomSyntax(value)) {
      return {
        changed: false,
        value
      };
    }

    const actor = context.actor ?? null;
    let output = value;

    // Shared "state" identifiers (STATUS_COUNT, …) — resolved through the SAME
    // registry the reaction/BD evaluators use, so the vocabulary stays in sync.
    // Each bare UPPER_SNAKE token is replaced with its resolved number before
    // CSB's mathjs evaluates the ${ ... }$. No event payload at derivation time
    // (payload = null), so event-scoped identifiers are intentionally absent.
    // DEGRADED MODE: if the registry isn't loaded (or can't resolve), the token
    // is substituted with 0 — the effect goes inert, which is far safer than
    // leaving a bare identifier for mathjs to choke on (poisons the whole prop).
    const idReg = globalThis["oni.IdentifierRegistry"];
    const stateNames = getStateIdentifierNames();
    for (const name of stateNames) {
      const tokenRe = new RegExp("\\b" + name + "\\b", "g");
      if (!tokenRe.test(output)) continue;
      let numeric = 0;
      if (actor && idReg?.resolveState) {
        const resolved = idReg.resolveState(name, actor, null);
        numeric = Number.isFinite(Number(resolved)) ? Number(resolved) : 0;
      }
      output = output.replace(new RegExp("\\b" + name + "\\b", "g"), String(numeric));
      if (isDebug()) console.log(TAG, `${name} =>`, numeric, actor?.name ?? null, idReg ? "(registry)" : "(fallback 0)");
    }

    maybeWarnFormula({
      value,
      actor,
      effect: context.effect,
      source: context.source ?? "transformValue"
    });

    // aeValue("Wet", 12, 0)
    // Simple convenience helper. The second and third arguments should be simple CSB-safe values.
    output = output.replace(
      /\baeValue\s*\(\s*(['"])(.*?)\1\s*,\s*([^,()]+?)\s*,\s*([^)]+?)\s*\)/g,
      (_match, _quote, name, trueValue, falseValue) => {
        const result = hasEffect(actor, name);
        const valueToReturn = result ? trueValue.trim() : falseValue.trim();

        if (isDebug()) {
          console.log(TAG, `aeValue("${name}", ${trueValue}, ${falseValue}) =>`, valueToReturn, actor?.name ?? null);
        }

        return valueToReturn;
      }
    );

    // propAtLeast("level", 40, 10, 5)
    // Numeric actor-prop threshold gate. Substitutes the third arg when the
    // bearer's `system.props.<name>` is >= the threshold, else the fourth.
    // Generic — any prop, any threshold; primarily the pervasive Fabula Ultima
    // "value increases at level 40" upgrade pattern (prop "level" = character
    // level, the same field CHAR_LEVEL reads). args 3/4 are bare CSB-safe values.
    output = output.replace(
      /\bpropAtLeast\s*\(\s*(['"])(.*?)\1\s*,\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,\s*([^)]+?)\s*\)/g,
      (_match, _quote, propName, thresholdRaw, trueValue, falseValue) => {
        const cur = Number(actor?.system?.props?.[propName] ?? actor?.system?.[propName] ?? 0) || 0;
        const threshold = Number(thresholdRaw) || 0;
        const valueToReturn = cur >= threshold ? trueValue.trim() : falseValue.trim();

        if (isDebug()) {
          console.log(TAG, `propAtLeast("${propName}", ${thresholdRaw}, ${trueValue}, ${falseValue}) =>`, valueToReturn, actor?.name ?? null);
        }

        return valueToReturn;
      }
    );

    // hasWeapon("arcane") — true if the actor has an EQUIPPED weapon of that
    // category (aliases normalized: staff/wand/tome → arcane, etc.). The AE
    // equivalent of the reaction-side HAS_ARCANE_WEAPON gate.
    output = output.replace(/\bhasWeapon\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, category) => {
      const result = countEquippedWeapons(actor, category) > 0;

      if (isDebug()) {
        console.log(TAG, `hasWeapon("${category}") =>`, result, actor?.name ?? null);
      }

      return result ? "true" : "false";
    });

    // countWeapons("dagger") — number of EQUIPPED weapons of that category.
    output = output.replace(/\bcountWeapons\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, category) => {
      const result = countEquippedWeapons(actor, category);

      if (isDebug()) {
        console.log(TAG, `countWeapons("${category}") =>`, result, actor?.name ?? null);
      }

      return String(result);
    });

    // ae("Wet")
    output = output.replace(/\bae\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, name) => {
      const result = hasEffect(actor, name);

      if (isDebug()) {
        console.log(TAG, `ae("${name}") =>`, result, actor?.name ?? null);
      }

      return result ? "true" : "false";
    });

    // aeUuid("Actor.x.ActiveEffect.y")
    output = output.replace(/\baeUuid\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, uuid) => {
      const result = hasEffectUuid(actor, uuid);

      if (isDebug()) {
        console.log(TAG, `aeUuid("${uuid}") =>`, result, actor?.name ?? null);
      }

      return result ? "true" : "false";
    });

    // aeStatus("wet")
    output = output.replace(/\baeStatus\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, statusId) => {
      const result = hasEffectStatus(actor, statusId);

      if (isDebug()) {
        console.log(TAG, `aeStatus("${statusId}") =>`, result, actor?.name ?? null);
      }

      return result ? "true" : "false";
    });

    // countAe("Wet")
    output = output.replace(/\bcountAe\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, name) => {
      const result = countEffect(actor, name);

      if (isDebug()) {
        console.log(TAG, `countAe("${name}") =>`, result, actor?.name ?? null);
      }

      return String(result);
    });

    return {
      changed: output !== value,
      value: output
    };
  };

  // ------------------------------------------------------------
  // Debug logging helper
  // ------------------------------------------------------------

  const logTransform = ({ title, actor, effect, key, path, before, after }) => {
    if (!isDebug()) return;

    console.groupCollapsed(`${TAG} ${title}`);
    console.log("Actor:", actor?.name ?? null);
    console.log("Effect:", effect?.name ?? effect?.id ?? effect?._id ?? null);
    if (key) console.log("Key:", key);
    if (path) console.log("Path:", path);
    console.log("Before:", before);
    console.log("After:", after);
    console.groupEnd();
  };

  // ------------------------------------------------------------
  // Patch 1: Actor.applyActiveEffects
  // ------------------------------------------------------------

  const withTransformedEffectChanges = (actor, callback) => {
    if (!isEnabled()) return callback();
    if (!actor || state.actorGuard.has(actor)) return callback();

    const restore = [];
    let transformedCount = 0;

    state.actorGuard.add(actor);

    try {
      return withActorCache(actor, () => {
        const effects = collectActorEffects(actor);

        for (const effect of effects) {
          const changes = safeArrayFrom(effect?.changes);

          for (const change of changes) {
            if (!change || typeof change.value !== "string") continue;
            if (!hasCustomSyntax(change.value)) continue;

            const before = change.value;
            const result = transformValue(before, {
              actor,
              effect,
              change,
              source: `change.${change.key ?? "unknown"}`
            });

            if (!result.changed) continue;

            try {
              change.value = result.value;
              restore.push({ change, value: before });
              transformedCount++;

              logTransform({
                title: "transformed Active Effect change",
                actor,
                effect,
                key: change.key,
                before,
                after: result.value
              });
            } catch (err) {
              console.error(TAG, "Failed to temporarily transform change.value.", err, {
                actor,
                effect,
                change
              });
            }
          }
        }

        return callback();
      });
    } finally {
      for (const entry of restore.reverse()) {
        try {
          entry.change.value = entry.value;
        } catch (_err) {}
      }

      state.actorGuard.delete(actor);

      if (isDebug() && transformedCount > 0) {
        console.log(TAG, `Restored ${transformedCount} temporary Active Effect change(s).`);
      }
    }
  };

  const getActorPatchTarget = () => {
    const candidates = [
      CONFIG?.Actor?.documentClass,
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
  };

  const patchActorDirect = () => {
    const target = getActorPatchTarget();

    if (!target) {
      console.warn(TAG, "Could not patch Actor.applyActiveEffects(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto.__oniAeSyntaxActorApplyPatched) {
      state.actorPatched = true;
      state.actorPatchTarget = cls?.name ?? "Actor";
      state.actorPatchMode = "direct-existing";
      return true;
    }

    const original = proto.applyActiveEffects;

    proto.applyActiveEffects = function oniAeSyntaxApplyActiveEffects(...args) {
      return withTransformedEffectChanges(this, () => {
        return original.apply(this, args);
      });
    };

    proto.__oniAeSyntaxActorApplyPatched = true;
    proto.__oniAeSyntaxOriginalApplyActiveEffects = original;

    state.originalApplyActiveEffects = original;
    state.actorPatched = true;
    state.actorPatchTarget = cls?.name ?? "Actor";
    state.actorPatchMode = "direct";

    console.log(TAG, `Patched ${state.actorPatchTarget}.prototype.applyActiveEffects() directly.`);
    return true;
  };

  const patchActorLibWrapper = () => {
    if (!globalThis.libWrapper || !preferLibWrapper()) return false;

    try {
      libWrapper.register(
        MODULE_ID,
        "CONFIG.Actor.documentClass.prototype.applyActiveEffects",
        function oniAeSyntaxApplyActiveEffectsWrapper(wrapped, ...args) {
          return withTransformedEffectChanges(this, () => {
            return wrapped(...args);
          });
        },
        "WRAPPER"
      );

      state.actorPatched = true;
      state.actorPatchTarget = CONFIG?.Actor?.documentClass?.name ?? "CONFIG.Actor.documentClass";
      state.actorPatchMode = "libWrapper";

      console.log(TAG, `Patched ${state.actorPatchTarget}.prototype.applyActiveEffects() with libWrapper.`);
      return true;
    } catch (err) {
      console.warn(TAG, "libWrapper actor patch failed. Falling back to direct patch.", err);
      return false;
    }
  };

  const patchActorApplyActiveEffects = () => {
    if (state.actorPatched) return true;
    return patchActorLibWrapper() || patchActorDirect();
  };

  // ------------------------------------------------------------
  // Patch 2: CustomActiveEffect.apply
  // ------------------------------------------------------------

  const transformApplyArgs = (args, actor, effect) => {
    let changed = false;
    const nextArgs = [...args];

    for (let i = 0; i < nextArgs.length; i++) {
      const arg = nextArgs[i];

      if (!arg || typeof arg.value !== "string") continue;
      if (!hasCustomSyntax(arg.value)) continue;

      const before = arg.value;
      const result = transformValue(before, {
        actor,
        effect,
        change: arg,
        source: `applyArg.${arg.key ?? i}`
      });

      if (!result.changed) continue;

      const cloned = foundry.utils.deepClone(arg);
      cloned.value = result.value;
      nextArgs[i] = cloned;
      changed = true;

      logTransform({
        title: "transformed CustomActiveEffect apply argument",
        actor,
        effect,
        key: cloned.key,
        before,
        after: result.value
      });
    }

    return changed ? nextArgs : args;
  };

  const withTransformedCustomActiveEffectValue = (effect, actor, callback) => {
    if (!isEnabled()) return callback();
    if (!effect || state.customEffectGuard.has(effect)) return callback();

    const restore = [];

    const paths = [
      "value",
      "system.value",
      "_source.value",
      "_source.system.value"
    ];

    state.customEffectGuard.add(effect);

    try {
      return withActorCache(actor, () => {
        for (const path of paths) {
          const before = foundry.utils.getProperty(effect, path);

          if (!hasCustomSyntax(before)) continue;

          const result = transformValue(before, {
            actor,
            effect,
            source: `effect.${path}`
          });

          if (!result.changed) continue;

          try {
            foundry.utils.setProperty(effect, path, result.value);
            restore.push({ path, value: before });

            logTransform({
              title: "transformed CustomActiveEffect value",
              actor,
              effect,
              path,
              before,
              after: result.value
            });
          } catch (err) {
            console.error(TAG, `Failed to temporarily set ${path}.`, err, {
              effect,
              actor
            });
          }
        }

        return callback();
      });
    } finally {
      for (const entry of restore.reverse()) {
        try {
          foundry.utils.setProperty(effect, entry.path, entry.value);
        } catch (_err) {}
      }

      state.customEffectGuard.delete(effect);

      if (isDebug() && restore.length > 0) {
        console.log(TAG, `Restored ${restore.length} temporary CustomActiveEffect value path(s).`);
      }
    }
  };

  const getCustomActiveEffectPatchTarget = () => {
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
  };

  const patchCustomEffectDirect = () => {
    const target = getCustomActiveEffectPatchTarget();

    if (!target) {
      console.warn(TAG, "Could not patch CustomActiveEffect.apply(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto.__oniAeSyntaxCustomApplyPatched) {
      state.customEffectPatched = true;
      state.customEffectPatchTarget = cls?.name ?? "CustomActiveEffect";
      state.customEffectPatchMode = "direct-existing";
      return true;
    }

    const original = proto.apply;

    proto.apply = function oniAeSyntaxCustomActiveEffectApply(...args) {
      const explicitActor = args.find((arg) => isActorDocument(arg)) ?? null;
      const actor = resolveActorFromEffect(this, explicitActor);

      if (!actor || !isEnabled()) {
        return original.apply(this, args);
      }

      return withActorCache(actor, () => {
        const nextArgs = transformApplyArgs(args, actor, this);

        return withTransformedCustomActiveEffectValue(this, actor, () => {
          return original.apply(this, nextArgs);
        });
      });
    };

    proto.__oniAeSyntaxCustomApplyPatched = true;
    proto.__oniAeSyntaxOriginalCustomApply = original;

    state.originalCustomEffectApply = original;
    state.customEffectPatched = true;
    state.customEffectPatchTarget = cls?.name ?? "CustomActiveEffect";
    state.customEffectPatchMode = "direct";

    console.log(TAG, `Patched ${state.customEffectPatchTarget}.prototype.apply() directly.`);
    return true;
  };

  const patchCustomEffectLibWrapper = () => {
    if (!globalThis.libWrapper || !preferLibWrapper()) return false;

    try {
      libWrapper.register(
        MODULE_ID,
        "CONFIG.ActiveEffect.documentClass.prototype.apply",
        function oniAeSyntaxCustomEffectApplyWrapper(wrapped, ...args) {
          const explicitActor = args.find((arg) => isActorDocument(arg)) ?? null;
          const actor = resolveActorFromEffect(this, explicitActor);

          if (!actor || !isEnabled()) {
            return wrapped(...args);
          }

          return withActorCache(actor, () => {
            const nextArgs = transformApplyArgs(args, actor, this);

            return withTransformedCustomActiveEffectValue(this, actor, () => {
              return wrapped(...nextArgs);
            });
          });
        },
        "WRAPPER"
      );

      state.customEffectPatched = true;
      state.customEffectPatchTarget = CONFIG?.ActiveEffect?.documentClass?.name ?? "CONFIG.ActiveEffect.documentClass";
      state.customEffectPatchMode = "libWrapper";

      console.log(TAG, `Patched ${state.customEffectPatchTarget}.prototype.apply() with libWrapper.`);
      return true;
    } catch (err) {
      console.warn(TAG, "libWrapper CustomActiveEffect patch failed. Falling back to direct patch.", err);
      return false;
    }
  };

  const patchCustomActiveEffectApply = () => {
    if (state.customEffectPatched) return true;
    return patchCustomEffectLibWrapper() || patchCustomEffectDirect();
  };

  // ------------------------------------------------------------
  // Report utilities
  // ------------------------------------------------------------

  const getActorFromInput = (actorOrName) => {
    if (typeof actorOrName === "string") {
      return game.actors.getName(actorOrName) ?? game.actors.get(actorOrName);
    }

    return actorOrName;
  };

  const scanEffectSyntaxEntries = (actor) => {
    const entries = [];

    return withActorCache(actor, () => {
      const effects = collectActorEffects(actor);

      for (const effect of effects) {
        const changes = safeArrayFrom(effect?.changes);

        for (const change of changes) {
          if (!change || typeof change.value !== "string") continue;
          if (!hasCustomSyntax(change.value)) continue;

          const transformed = transformValue(change.value, {
            actor,
            effect,
            change,
            source: `report.change.${change.key ?? "unknown"}`
          });

          entries.push({
            kind: "change",
            effect: effect.name ?? effect.id,
            effectId: effect.id,
            effectUuid: effect.uuid,
            key: change.key,
            mode: change.mode,
            priority: change.priority,
            before: change.value,
            after: transformed.value,
            changed: transformed.changed,
            validation: validateFormula(change.value)
          });
        }

        const paths = [
          "value",
          "system.value",
          "_source.value",
          "_source.system.value"
        ];

        for (const path of paths) {
          const value = foundry.utils.getProperty(effect, path);
          if (!hasCustomSyntax(value)) continue;

          const transformed = transformValue(value, {
            actor,
            effect,
            source: `report.effect.${path}`
          });

          entries.push({
            kind: "effect-value",
            effect: effect.name ?? effect.id,
            effectId: effect.id,
            effectUuid: effect.uuid,
            path,
            before: value,
            after: transformed.value,
            changed: transformed.changed,
            validation: validateFormula(value)
          });
        }
      }

      return entries;
    });
  };

  const getDetectedEffects = (actor) => {
    return withActorCache(actor, () => {
      const cache = getActorCache(actor);
      if (!cache) return [];

      return cache.effects.map((effect) => ({
        name: effect.name,
        id: effect.id,
        uuid: effect.uuid,
        disabled: effect.disabled,
        suppressed: effect.isSuppressed,
        statuses: safeArrayFrom(effect.statuses)
      }));
    });
  };

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------

  const installApi = () => {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};

    globalThis.FUCompanion.api.activeEffectSyntax = {
      status() {
        const enabled = isEnabled();
        const ok = enabled && !!state.actorPatched && !!state.customEffectPatched;

        return {
          ok,
          enabled,

          patched: !!state.actorPatched,
          patchTarget: state.actorPatchTarget,
          patchMode: state.actorPatchMode,

          customEffectPatched: !!state.customEffectPatched,
          customEffectPatchTarget: state.customEffectPatchTarget,
          customEffectPatchMode: state.customEffectPatchMode,

          debug: isDebug(),
          warnings: warningsEnabled(),
          strict: strictWarnings(),
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

      async setWarnings(value = true) {
        await setSetting("warnings", Boolean(value));
        return this.status();
      },

      async setStrict(value = true) {
        await setSetting("strict", Boolean(value));
        return this.status();
      },

      clearWarningMemory() {
        state.warningSeen.clear();
        return true;
      },

      hasEffect(actorOrName, effectName) {
        const actor = getActorFromInput(actorOrName);
        return withActorCache(actor, () => hasEffect(actor, effectName));
      },

      listEffects(actorOrName) {
        const actor = getActorFromInput(actorOrName);
        if (!actor) return [];
        return getDetectedEffects(actor);
      },

      transformValue(value, actorOrName) {
        const actor = getActorFromInput(actorOrName);
        return withActorCache(actor, () => transformValue(value, { actor }));
      },

      validateFormula(value) {
        return validateFormula(value);
      },

      test(actorOrName, value) {
        const actor = getActorFromInput(actorOrName);

        if (!actor) {
          return {
            ok: false,
            reason: "Actor not found.",
            actor: actorOrName,
            before: value,
            after: value
          };
        }

        return withActorCache(actor, () => {
          const transformed = transformValue(value, {
            actor,
            source: "api.test"
          });

          return {
            ok: true,
            actor: actor.name,
            before: value,
            after: transformed.value,
            changed: transformed.changed,
            validation: validateFormula(value),
            detectedEffects: getDetectedEffects(actor),
            status: this.status()
          };
        });
      },

      report(actorOrName) {
        const actor = getActorFromInput(actorOrName);

        if (!actor) {
          return {
            ok: false,
            reason: "Actor not found.",
            actor: actorOrName
          };
        }

        return {
          ok: true,
          actor: actor.name,
          effectsUsingCustomSyntax: scanEffectSyntaxEntries(actor),
          detectedEffects: getDetectedEffects(actor),
          status: this.status()
        };
      },

      debugActor(actorOrName) {
        return this.report(actorOrName);
      },

      forcePatch() {
        const actorPatch = patchActorApplyActiveEffects();
        const customPatch = patchCustomActiveEffectApply();

        return {
          actorPatch,
          customPatch,
          status: this.status()
        };
      }
    };
  };

  // ------------------------------------------------------------
  // Startup
  // ------------------------------------------------------------

  Hooks.once("init", () => {
    registerSettings();
    state.debug = !!getSetting("debug", false);

    installApi();
    patchActorApplyActiveEffects();
    patchCustomActiveEffectApply();
  });

  Hooks.once("ready", () => {
    registerSettings();
    state.debug = !!getSetting("debug", false);

    installApi();

    if (!state.actorPatched) {
      patchActorApplyActiveEffects();
    }

    if (!state.customEffectPatched) {
      patchCustomActiveEffectApply();
    }

    console.debug(TAG, "Ready.", globalThis.FUCompanion.api.activeEffectSyntax.status());
  });
})();