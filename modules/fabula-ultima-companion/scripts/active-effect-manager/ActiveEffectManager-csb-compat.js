// ============================================================================
// ActiveEffectManager-csb-compat.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Optimization compatibility layer for Custom System Builder ActiveEffects.
// - CSB's CustomActiveEffect._onCreateOperation calls setFlag 4 times after
//   ActiveEffect creation:
//     custom-system-builder.originalParentId
//     custom-system-builder.originalId
//     custom-system-builder.originalUuid
//     custom-system-builder.isFromTemplate
// - Each setFlag triggers a document update and actor prepareData.
// - For AEM-created effects, those flags are already pre-stamped in effectData.
// - This script skips the redundant post-create setFlag calls.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:CSBCompat]";
  const DEBUG = true;

  const PATCH_KEY = "__ONI_AEM_CSB_COMPAT_SETFLAG_PATCH_V1__";

  const CSB_SCOPE = "custom-system-builder";
  const SKIP_KEYS = new Set([
    "originalParentId",
    "originalId",
    "originalUuid",
    "isFromTemplate"
  ]);

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  if (globalThis[PATCH_KEY]) {
    warn("CSB compat patch already installed. Skipping duplicate install.");
    return;
  }

  globalThis[PATCH_KEY] = true;

  function getProperty(obj, path) {
    try {
      if (foundry?.utils?.getProperty) return foundry.utils.getProperty(obj, path);
    } catch (_e) {}

    try {
      return path.split(".").reduce((cur, key) => cur?.[key], obj);
    } catch (_e) {
      return undefined;
    }
  }

  function hasUsableValue(value) {
    return value !== undefined && value !== null && value !== "";
  }

  function isAemManagedEffect(effect) {
    return !!(
      getProperty(effect, `flags.${MODULE_ID}.activeEffectManager.managed`) ||
      getProperty(effect, `flags.${MODULE_ID}.activeEffectManager.optimizedCreate`)
    );
  }

  function shouldSkipSetFlag(effect, scope, key) {
    if (scope !== CSB_SCOPE) return false;
    if (!SKIP_KEYS.has(String(key))) return false;
    if (!isAemManagedEffect(effect)) return false;

    const existing = getProperty(effect, `flags.${CSB_SCOPE}.${key}`);

    // Only skip if the API successfully pre-stamped this value.
    // This prevents us from blocking CSB if the field is genuinely missing.
    return hasUsableValue(existing) || existing === false;
  }

  function installPatch() {
    const ActiveEffectClass =
      CONFIG?.ActiveEffect?.documentClass ??
      globalThis.ActiveEffect ??
      null;

    const proto = ActiveEffectClass?.prototype;

    if (!proto?.setFlag) {
      warn("ActiveEffect.prototype.setFlag not found. Could not install patch.");
      return false;
    }

    if (proto.setFlag.__oniAemCsbCompatPatched) {
      log("Patch already installed on ActiveEffect.prototype.setFlag.");
      return true;
    }

    const originalSetFlag = proto.setFlag;

    async function patchedSetFlag(scope, key, value) {
      if (shouldSkipSetFlag(this, scope, key)) {
        log("Skipped redundant CSB setFlag.", {
          effect: this.name,
          scope,
          key,
          existing: getProperty(this, `flags.${CSB_SCOPE}.${key}`)
        });

        return this;
      }

      return await originalSetFlag.call(this, scope, key, value);
    }

    patchedSetFlag.__oniAemCsbCompatPatched = true;
    patchedSetFlag.__oniAemOriginalSetFlag = originalSetFlag;

    proto.setFlag = patchedSetFlag;

    log("Installed CSB setFlag compatibility patch.");

    return true;
  }

  installPatch();

  Hooks.once("ready", () => {
    installPatch();
  });

  setTimeout(() => {
    installPatch();
  }, 500);
})();

// ============================================================================
// Active Effect — Token Icon Visibility Toggle
//
// By default Foundry only shows an AE icon on its token if the effect has a
// non-zero duration (isTemporary === true). Some effects (e.g. Advantage) have
// no mechanical duration but still need a visible icon.
//
// Setting flags["fabula-ultima-companion"].showTokenIcon = true on an AE
// forces it to be treated as temporary for the purposes of icon display,
// without requiring a duration to be set.
// ============================================================================
(() => {
  const MODULE_ID      = "fabula-ultima-companion";
  const ICON_PATCH_KEY = "__ONI_AEM_SHOW_ICON_PATCH__";

  if (globalThis[ICON_PATCH_KEY]) return;
  globalThis[ICON_PATCH_KEY] = true;

  function installIconPatch() {
    const AEClass = CONFIG?.ActiveEffect?.documentClass ?? globalThis.ActiveEffect ?? null;
    const proto   = AEClass?.prototype;
    if (!proto) return false;
    if (proto.__oniShowIconPatched) return true;

    // Find isTemporary on this prototype or its parent
    let descriptor = Object.getOwnPropertyDescriptor(proto, "isTemporary");
    if (!descriptor?.get) {
      descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), "isTemporary");
    }
    if (!descriptor?.get) {
      console.warn("[ONI][AEM:IconPatch] Could not locate isTemporary getter — patch skipped.");
      return false;
    }

    const originalGetter = descriptor.get;

    Object.defineProperty(proto, "isTemporary", {
      get() {
        if (this.flags?.[MODULE_ID]?.showTokenIcon) return true;
        return originalGetter.call(this);
      },
      configurable: true,
    });

    proto.__oniShowIconPatched = true;
    console.debug("[ONI][AEM:IconPatch] showTokenIcon isTemporary patch installed.");
    return true;
  }

  installIconPatch();
  Hooks.once("ready", () => { installIconPatch(); });
})();