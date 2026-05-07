(() => {
  const TAG = "[ONI][AE Formula Bridge V2]";
  const INSTALL_KEY = "__ONI_AE_FORMULA_BRIDGE_V2_INSTALLED__";

  if (globalThis[INSTALL_KEY]) {
    console.warn(TAG, "Already installed. Skipping duplicate install.");
    return;
  }

  globalThis[INSTALL_KEY] = true;

  const DEBUG = true;

  // Example:
  // @fu.override(actor.wet_status == 1 && item.isEquipped ? 99 : 0)
  // @fu.upgrade(actor.wet_status == 1 && item.isEquipped ? 12 : 0)
  const BRIDGE_PATTERN = /^\s*@fu\.(override|upgrade|add|downgrade)\(([\s\S]*)\)\s*$/i;

  const log = (...args) => {
    if (DEBUG) console.log(TAG, ...args);
  };

  const toNumber = (value) => {
    if (value === true) return 1;
    if (value === false) return 0;
    if (value == null || value === "") return 0;

    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const toFormulaNumber = (value) => {
    if (value === true) return 1;
    if (value === false) return 0;

    const s = String(value ?? "").trim().toLowerCase();

    if (s === "true" || s === "yes" || s === "on") return 1;
    if (s === "false" || s === "no" || s === "off" || s === "") return 0;

    return toNumber(value);
  };

  const parseBridge = (value) => {
    const raw = String(value ?? "").trim();
    const match = raw.match(BRIDGE_PATTERN);
    if (!match) return null;

    return {
      mode: match[1].toLowerCase(),
      expression: match[2].trim()
    };
  };

  const toSystemPropPath = (key) => {
    const k = String(key ?? "").trim();
    if (!k) return "";

    // Allows both:
    // override_dex
    // system.props.override_dex
    return k.startsWith("system.") ? k : `system.props.${k}`;
  };

  const getFromChanges = (changes, path) => {
    if (!changes || !path) return undefined;

    if (Object.prototype.hasOwnProperty.call(changes, path)) {
      return changes[path];
    }

    return foundry.utils.getProperty(changes, path);
  };

  const setIntoChanges = (changes, path, value) => {
    if (!changes || !path) return;

    // Flat path, like Foundry's AE changes object often uses.
    changes[path] = value;

    // Nested path, useful for actor.overrides post-pass.
    try {
      foundry.utils.setProperty(changes, path, value);
    } catch (err) {
      console.warn(TAG, "Could not set nested change path.", { path, value, err });
    }
  };

  const readActorPath = (actor, changes, key) => {
    const path = toSystemPropPath(key);

    // First read already-applied AE changes.
    // This is important for Wet:
    // Wet effect may place system.props.wet_status into changes before Swift Swimmer resolves.
    const fromChanges = getFromChanges(changes, path);
    if (fromChanges !== undefined) return fromChanges;

    const fromOverrides = foundry.utils.getProperty(actor?.overrides ?? {}, path);
    if (fromOverrides !== undefined) return fromOverrides;

    return foundry.utils.getProperty(actor, path);
  };

  const readItemPath = (item, key) => {
    if (!item) return 0;

    const path = toSystemPropPath(key);
    return foundry.utils.getProperty(item, path);
  };

  const changeMatches = (a, b) => {
    if (!a || !b) return false;

    return (
      String(a.key ?? "") === String(b.key ?? "") &&
      String(a.value ?? "") === String(b.value ?? "") &&
      String(a.mode ?? "") === String(b.mode ?? "")
    );
  };

  const resolveOwningItem = (actor, effect, change) => {
    // Best case: effect is still owned by an Item.
    if (effect?.parent?.documentName === "Item") return effect.parent;

    // Some systems attach item references differently.
    if (effect?.item?.documentName === "Item") return effect.item;

    // Fallback: search actor embedded items for the effect/change.
    for (const item of actor?.items ?? []) {
      for (const itemEffect of item.effects ?? []) {
        if (effect && itemEffect.id === effect.id) return item;
        if (effect && itemEffect.uuid === effect.uuid) return item;

        for (const itemChange of itemEffect.changes ?? []) {
          if (changeMatches(itemChange, change)) return item;
        }
      }
    }

    return null;
  };

  const sanitizeExpression = (expression, actor, item, changes) => {
    let expr = String(expression ?? "").trim();

    // actor.wet_status -> actor.system.props.wet_status
    expr = expr.replace(/\bactor\.([A-Za-z_][A-Za-z0-9_.]*)\b/g, (_match, key) => {
      const value = readActorPath(actor, changes, key);
      return String(toFormulaNumber(value));
    });

    // item.isEquipped -> item.system.props.isEquipped
    expr = expr.replace(/\bitem\.([A-Za-z_][A-Za-z0-9_.]*)\b/g, (_match, key) => {
      const value = readItemPath(item, key);
      return String(toFormulaNumber(value));
    });

    // After replacement, only allow numbers/operators.
    // Supports:
    // 1 == 1 && 1 ? 99 : 0
    // 1 + 2 * 3
    const safe = /^[0-9\s+\-*/%().?:<>=!&|]+$/.test(expr);

    if (!safe) {
      throw new Error(`Unsupported expression after resolving actor/item paths: ${expr}`);
    }

    return expr;
  };

  const evaluateExpression = (expression, actor, item, changes) => {
    const safeExpression = sanitizeExpression(expression, actor, item, changes);
    const result = Function(`"use strict"; return (${safeExpression});`)();
    return toNumber(result);
  };

  const applyBridgeMode = (mode, currentValue, formulaValue) => {
    const current = toNumber(currentValue);
    const value = toNumber(formulaValue);

    switch (mode) {
      case "override":
        return value;

      case "upgrade":
        return Math.max(current, value);

      case "downgrade":
        return Math.min(current, value);

      case "add":
        return current + value;

      default:
        return value;
    }
  };

  const applyBridgeChange = ({ actor, effect = null, change, current = undefined, changes, source = "unknown" }) => {
    const parsed = parseBridge(change?.value);
    if (!parsed) return false;

    const targetPath = toSystemPropPath(change.key);
    const item = resolveOwningItem(actor, effect, change);

    const currentTargetValue =
      getFromChanges(changes, targetPath) ??
      foundry.utils.getProperty(actor?.overrides ?? {}, targetPath) ??
      foundry.utils.getProperty(actor, targetPath) ??
      current ??
      0;

    const formulaValue = evaluateExpression(parsed.expression, actor, item, changes);
    const finalValue = applyBridgeMode(parsed.mode, currentTargetValue, formulaValue);

    setIntoChanges(changes, targetPath, finalValue);

    log("Applied bridge change.", {
      source,
      actor: actor?.name,
      item: item?.name ?? null,
      effect: effect?.name ?? effect?.label ?? null,
      key: change.key,
      targetPath,
      bridgeMode: parsed.mode,
      expression: parsed.expression,
      currentTargetValue,
      formulaValue,
      finalValue
    });

    return true;
  };

  // ---------------------------------------------------------------------------
  // Layer 1: Foundry Custom Active Effect hook
  // ---------------------------------------------------------------------------

  Hooks.on("applyActiveEffect", (actor, change, current, delta, changes) => {
    try {
      applyBridgeChange({
        actor,
        change,
        current,
        changes,
        source: "applyActiveEffect hook"
      });
    } catch (err) {
      console.error(TAG, "Hook bridge failed.", { actor, change, current, delta, changes, err });
    }
  });

  // ---------------------------------------------------------------------------
  // Layer 2: Patch Foundry's Custom mode method directly
  // This prevents @fu formulas from being applied as literal text.
  // ---------------------------------------------------------------------------

  const ActiveEffectClass = foundry.documents.ActiveEffect ?? ActiveEffect;

  if (ActiveEffectClass?._applyChangeCustom && !ActiveEffectClass._oniBridgeCustomPatched) {
    const originalApplyChangeCustom = ActiveEffectClass._applyChangeCustom;

    ActiveEffectClass._applyChangeCustom = function(targetDoc, change, current, delta, changes) {
      try {
        const handled = applyBridgeChange({
          actor: targetDoc,
          change,
          current,
          changes,
          source: "patched _applyChangeCustom"
        });

        if (handled) return;
      } catch (err) {
        console.error(TAG, "Patched custom bridge failed.", {
          targetDoc,
          change,
          current,
          delta,
          changes,
          err
        });
      }

      return originalApplyChangeCustom.call(this, targetDoc, change, current, delta, changes);
    };

    ActiveEffectClass._oniBridgeCustomPatched = true;
    log("Patched ActiveEffect._applyChangeCustom.");
  } else {
    console.warn(TAG, "Could not patch ActiveEffect._applyChangeCustom. Post-pass will still run.");
  }

  // ---------------------------------------------------------------------------
  // Layer 3: Post-pass after Actor.applyActiveEffects
  // This catches CSB/custom-system behavior if it wrote @fu(...) as literal text.
  // ---------------------------------------------------------------------------

  const ActorClass = CONFIG.Actor.documentClass ?? Actor;

  const collectBridgeEffects = (actor) => {
    const out = [];

    // Actor-owned effects.
    for (const effect of actor.effects ?? []) {
      if (effect.disabled) continue;

      for (const change of effect.changes ?? []) {
        if (!parseBridge(change.value)) continue;

        out.push({ effect, change });
      }
    }

    // Item-owned embedded effects.
    for (const item of actor.items ?? []) {
      for (const effect of item.effects ?? []) {
        if (effect.disabled) continue;

        for (const change of effect.changes ?? []) {
          if (!parseBridge(change.value)) continue;

          out.push({ effect, change });
        }
      }
    }

    return out;
  };

  const postProcessActorBridgeEffects = (actor) => {
    if (!actor) return;

    const bridgeEffects = collectBridgeEffects(actor);
    if (!bridgeEffects.length) return;

    actor.overrides ??= {};

    for (const { effect, change } of bridgeEffects) {
      try {
        applyBridgeChange({
          actor,
          effect,
          change,
          changes: actor.overrides,
          source: "Actor.applyActiveEffects post-pass"
        });
      } catch (err) {
        console.error(TAG, "Post-pass bridge failed.", { actor, effect, change, err });
      }
    }
  };

  if (ActorClass?.prototype?.applyActiveEffects && !ActorClass.prototype._oniBridgeApplyEffectsPatched) {
    const originalApplyActiveEffects = ActorClass.prototype.applyActiveEffects;

    ActorClass.prototype.applyActiveEffects = function(...args) {
      const result = originalApplyActiveEffects.apply(this, args);

      try {
        postProcessActorBridgeEffects(this);
      } catch (err) {
        console.error(TAG, "Actor.applyActiveEffects post-pass crashed.", { actor: this, err });
      }

      return result;
    };

    ActorClass.prototype._oniBridgeApplyEffectsPatched = true;
    log("Patched Actor.applyActiveEffects post-pass.");
  } else {
    console.warn(TAG, "Could not patch Actor.applyActiveEffects.");
  }

  console.log(`${TAG} Ready.`);
})();