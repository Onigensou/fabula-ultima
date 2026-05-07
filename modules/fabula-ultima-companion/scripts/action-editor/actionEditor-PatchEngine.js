// ============================================================================
// actionEditor-PatchEngine.js
// Foundry V12
// -----------------------------------------------------------------------------
// Purpose:
//   Safe payload patching engine for Action Editor.
//
// What this script does:
//   - Receives an Action Card payload object.
//   - Applies requested edits to that payload.
//   - Supports beginner-friendly "operations" like:
//       changeDamageElement → Fire
//       addDamageBonus → +10
//       replaceTargets → new target UUIDs
//   - Supports advanced raw patches with a whitelist.
//   - Returns before/after snapshots, changed paths, and edit summary.
//
// What this script DOES NOT do:
//   - It does not find the card.
//   - It does not save ChatMessage flags.
//   - It does not rebuild card HTML.
//   - It does not confirm or resolve the action.
//
// Intended pipeline later:
//   actionEditor-API.js
//     → actionEditor-CardFinder.js
//     → actionEditor-PatchEngine.js
//     → actionCard-Rebuilder.js
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  // =========================================================
  // DEBUG TOGGLE
  // =========================================================
  const ACTION_EDITOR_PATCH_DEBUG = true;

  const TAG = "[ONI][ActionEditor][PatchEngine]";
  const API_VERSION = "0.1.0";

  const log = (...a) => {
    if (ACTION_EDITOR_PATCH_DEBUG) console.log(TAG, ...a);
  };

  const warn = (...a) => {
    if (ACTION_EDITOR_PATCH_DEBUG) console.warn(TAG, ...a);
  };

  const err = (...a) => {
    if (ACTION_EDITOR_PATCH_DEBUG) console.error(TAG, ...a);
  };

  // =========================================================
  // NORMAL HELPERS
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

  function ensureObject(root, key) {
    if (!root[key] || typeof root[key] !== "object" || Array.isArray(root[key])) {
      root[key] = {};
    }
    return root[key];
  }

  function ensurePayloadShape(payload) {
    payload.meta = payload.meta || {};
    payload.core = payload.core || {};
    payload.advPayload = payload.advPayload || {};

    return payload;
  }

  function splitPath(path) {
    return str(path)
      .split(".")
      .map(p => p.trim())
      .filter(Boolean);
  }

  function getByPath(obj, path, fallback = undefined) {
    const parts = splitPath(path);
    if (!parts.length) return fallback;

    let cur = obj;
    for (const p of parts) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        return fallback;
      }
      cur = cur[p];
    }

    return cur === undefined ? fallback : cur;
  }

  function setByPath(obj, path, value) {
    const parts = splitPath(path);
    if (!parts.length) return false;

    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];

      if (!cur[p] || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
        cur[p] = {};
      }

      cur = cur[p];
    }

    cur[parts[parts.length - 1]] = value;
    return true;
  }

  function deleteByPath(obj, path) {
    const parts = splitPath(path);
    if (!parts.length) return false;

    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur?.[p] || typeof cur[p] !== "object") return false;
      cur = cur[p];
    }

    delete cur[parts[parts.length - 1]];
    return true;
  }

  function pushByPath(obj, path, value, { unique = false } = {}) {
    const current = getByPath(obj, path, undefined);

    if (!Array.isArray(current)) {
      setByPath(obj, path, []);
    }

    const arr = getByPath(obj, path, []);

    if (unique) {
      const s = String(value);
      if (!arr.map(v => String(v)).includes(s)) arr.push(value);
    } else {
      arr.push(value);
    }

    return true;
  }

  function mergeByPath(obj, path, value) {
    const current = getByPath(obj, path, undefined);

    if (!current || typeof current !== "object" || Array.isArray(current)) {
      setByPath(obj, path, {});
    }

    const target = getByPath(obj, path, {});
    const src = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};

    try {
      foundry.utils.mergeObject(target, src, {
        insertKeys: true,
        insertValues: true,
        overwrite: true,
        recursive: true,
        inplace: true
      });
    } catch {
      Object.assign(target, src);
    }

    return true;
  }

  // =========================================================
  // SNAPSHOT HELPERS
  // =========================================================

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

  function snapshotPayload(payload = {}) {
    return {
      actionId:
        payload?.meta?.actionId ??
        payload?.actionId ??
        null,

      actionCardId:
        payload?.meta?.actionCardId ??
        payload?.actionCardId ??
        null,

      actionCardVersion:
        payload?.meta?.actionCardVersion ??
        payload?.actionCardVersion ??
        null,

      state:
        payload?.meta?.actionCardState ??
        payload?.actionCardState ??
        "pending",

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
        payload?.dataCore?.typeDamageTxt ??
        null,

      weaponType:
        payload?.core?.weaponType ??
        payload?.advPayload?.weaponType ??
        payload?.meta?.weaponType ??
        null,

      valueType:
        payload?.advPayload?.valueType ??
        payload?.meta?.valueType ??
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

      ignoreShield:
        payload?.advPayload?.ignoreShield ??
        payload?.meta?.ignoreShield ??
        false,

      ignoreDamageReduction:
        payload?.advPayload?.ignoreDamageReduction ??
        payload?.meta?.ignoreDamageReduction ??
        false,

      costRaw:
        payload?.meta?.costRaw ??
        null,

      costRawOverride:
        payload?.meta?.costRawOverride ??
        null,

      costRawFinal:
        payload?.meta?.costRawFinal ??
        null,

      targets: getCanonicalTargets(payload),
      targetActors: getCanonicalTargetActors(payload)
    };
  }

  function shallowDiff(before, after) {
    const diff = {};

    const keys = Array.from(new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after ?? {})
    ]));

    for (const key of keys) {
      const b = before?.[key];
      const a = after?.[key];

      const same =
        JSON.stringify(b) === JSON.stringify(a);

      if (!same) {
        diff[key] = {
          before: b,
          after: a
        };
      }
    }

    return diff;
  }

  // =========================================================
  // ALLOWED RAW PATCH PATHS
  // =========================================================
  // Raw patches are powerful, so we only allow them to touch
  // known action-card data areas.
  //
  // Scripts should prefer semantic operations when possible.
  // =========================================================

  const RAW_PATCH_ALLOW_PREFIXES = [
    "meta.elementType",
    "meta.weaponType",
    "meta.valueType",
    "meta.baseValue",
    "meta.bonus",
    "meta.reduction",
    "meta.multiplier",
    "meta.ignoreShield",
    "meta.ignoreDamageReduction",
    "meta.costRawOverride",
    "meta.costRawFinal",
    "meta.costsNormalized",
    "meta.actionEditor",
    "meta.actionEditorNote",
    "meta.actionEditorNotes",
    "meta.originalTargetUUIDs",
    "meta.originalTargetActorUUIDs",
    "meta.targetActorUUIDs",
    "meta.defenseSnapshot",
    "meta.autoHit",
    "meta.forceHit",
    "meta.forceMiss",

    "core.typeDamageTxt",
    "core.weaponType",
    "core.skillTargetRaw",
    "core.rawEffectHTML",

    "dataCore.typeDamageTxt",
    "dataCore.weaponType",
    "dataCore.skillTargetRaw",
    "dataCore.rawEffectHTML",

    "advPayload.elementType",
    "advPayload.weaponType",
    "advPayload.valueType",
    "advPayload.baseValue",
    "advPayload.bonus",
    "advPayload.reduction",
    "advPayload.multiplier",
    "advPayload.ignoreShield",
    "advPayload.ignoreDamageReduction",
    "advPayload.isCrit",
    "advPayload.isFumble",

    "accuracy.total",
    "accuracy.bonus",
    "accuracy.autoHit",
    "accuracy.forceHit",
    "accuracy.forceMiss",

    "targets",
    "originalTargetUUIDs",
    "originalTargetActorUUIDs"
  ];

  function isRawPatchPathAllowed(path) {
    const p = str(path);
    if (!p) return false;

    return RAW_PATCH_ALLOW_PREFIXES.some(prefix => {
      return p === prefix || p.startsWith(`${prefix}.`);
    });
  }

  // =========================================================
  // NORMALIZERS
  // =========================================================

  const ELEMENT_ALIASES = {
    phys: "physical",
    physicals: "physical",
    fire: "fire",
    flame: "fire",
    ice: "ice",
    frost: "ice",
    air: "air",
    wind: "air",
    bolt: "bolt",
    lightning: "bolt",
    thunder: "bolt",
    earth: "earth",
    stone: "earth",
    light: "light",
    holy: "light",
    dark: "dark",
    darkness: "dark",
    shadow: "dark",
    poison: "poison",
    venom: "poison",
    none: "elementless",
    neutral: "elementless",
    elementless: "elementless",
    mp: "mp"
  };

  const VALID_DAMAGE_ELEMENTS = new Set([
    "physical",
    "air",
    "bolt",
    "dark",
    "earth",
    "fire",
    "ice",
    "light",
    "poison",
    "elementless",
    "mp"
  ]);

  function normalizeElement(value) {
    const raw = lower(value);
    const aliased = ELEMENT_ALIASES[raw] ?? raw;
    return aliased;
  }

  function validateElement(value) {
    const el = normalizeElement(value);
    return VALID_DAMAGE_ELEMENTS.has(el)
      ? { ok: true, value: el }
      : {
          ok: false,
          value: el,
          reason: `Invalid damage element: ${value}`
        };
  }

  const WEAPON_ALIASES = {
    sword: "sword_ef",
    swords: "sword_ef",
    spear: "spear_ef",
    bow: "bow_ef",
    arcane: "arcane_ef",
    staff: "arcane_ef",
    tome: "arcane_ef",
    wand: "arcane_ef",
    thrown: "thrown_ef",
    dagger: "dagger_ef",
    knife: "dagger_ef",
    flail: "flail_ef",
    brawling: "brawling_ef",
    fist: "brawling_ef",
    heavy: "heavy_ef",
    firearm: "firearm_ef",
    gun: "firearm_ef",
    none: "none_ef",
    "": "none_ef"
  };

  function normalizeWeaponType(value) {
    const raw = lower(value);
    if (raw.endsWith("_ef")) return raw;
    return WEAPON_ALIASES[raw] ?? raw;
  }

  function normalizeMultiplier(value) {
    const n = num(value, 100);

    // Your pipeline normally stores multiplier as a percentage:
    // 100 = normal, 150 = 150%, 50 = half.
    //
    // If someone passes 1.5, treat it as 150.
    if (n > 0 && n <= 10) return Math.ceil(n * 100);

    return Math.ceil(n);
  }

  function normalizeTargets(value) {
    if (Array.isArray(value)) return uniq(value);
    if (typeof value === "string") {
      return uniq(
        value
          .split(/[,\n]+/g)
          .map(s => s.trim())
          .filter(Boolean)
      );
    }
    return [];
  }

  // =========================================================
  // SEMANTIC OPERATION APPLIERS
  // =========================================================

  function syncTargets(payload, tokenUuids = [], actorUuids = []) {
    const targets = uniq(tokenUuids);
    const targetActors = uniq(actorUuids);

    payload.targets = [...targets];
    payload.originalTargetUUIDs = [...targets];

    payload.meta = payload.meta || {};
    payload.meta.originalTargetUUIDs = [...targets];

    if (targetActors.length) {
      payload.originalTargetActorUUIDs = [...targetActors];
      payload.meta.originalTargetActorUUIDs = [...targetActors];
      payload.meta.targetActorUUIDs = [...targetActors];
    }

    return {
      changedPaths: [
        "targets",
        "originalTargetUUIDs",
        "meta.originalTargetUUIDs",
        ...(targetActors.length
          ? [
              "originalTargetActorUUIDs",
              "meta.originalTargetActorUUIDs",
              "meta.targetActorUUIDs"
            ]
          : [])
      ]
    };
  }

  function applyChangeDamageElement(payload, op) {
    const validation = validateElement(op.value ?? op.elementType ?? op.element);
    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.reason,
        changedPaths: []
      };
    }

    const element = validation.value;

    payload.meta.elementType = element;
    payload.advPayload.elementType = element;

    // Keep old/original data mirrors synchronized.
    payload.core.typeDamageTxt = element;
    payload.dataCore = payload.dataCore || {};
    payload.dataCore.typeDamageTxt = element;

    return {
      ok: true,
      changedPaths: [
        "meta.elementType",
        "advPayload.elementType",
        "core.typeDamageTxt",
        "dataCore.typeDamageTxt"
      ],
      summary: `Damage element changed to ${element}.`
    };
  }

  function applyChangeWeaponType(payload, op) {
    const weaponType = normalizeWeaponType(op.value ?? op.weaponType);

    payload.core.weaponType = weaponType;
    payload.advPayload.weaponType = weaponType;
    payload.meta.weaponType = weaponType;

    return {
      ok: true,
      changedPaths: [
        "core.weaponType",
        "advPayload.weaponType",
        "meta.weaponType"
      ],
      summary: `Weapon type changed to ${weaponType}.`
    };
  }

  function applySetBaseValue(payload, op) {
    const value = op.value ?? op.baseValue;
    const normalized = String(value ?? "0").trim() || "0";

    payload.advPayload.baseValue = normalized;
    payload.meta.baseValue = normalized;

    return {
      ok: true,
      changedPaths: [
        "advPayload.baseValue",
        "meta.baseValue"
      ],
      summary: `Base value set to ${normalized}.`
    };
  }

  function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function applySetDamagePreview(payload, op = {}) {
  payload.meta = payload.meta || {};
  payload.advPayload = payload.advPayload || {};
  payload.accuracy = payload.accuracy || {};

  const changedPaths = [];

  const setPath = (path, value) => {
    setByPath(payload, path, value);
    changedPaths.push(path);
  };

  // -------------------------------------------------------
  // Base / preview value
  // -------------------------------------------------------
  // value / previewValue / baseValue all mean:
  // "the number CreateActionCard should use as the displayed base damage."
  //
  // This intentionally updates meta.baseValueStrForCard because that is
  // the card-preview mirror field used by the visual Action Card.
  // -------------------------------------------------------

  const baseInput = pickFirstDefined(
    op.previewValue,
    op.previewBase,
    op.displayValue,
    op.displayBase,
    op.baseValue,
    op.base,
    op.value
  );

  if (baseInput !== undefined) {
    const normalizedBase = String(baseInput ?? "0").trim() || "0";

    setPath("advPayload.baseValue", normalizedBase);
    setPath("meta.baseValue", normalizedBase);
    setPath("meta.baseValueStrForCard", normalizedBase);
  }

  // -------------------------------------------------------
  // HR preview mirror
  // -------------------------------------------------------
  // This is separate because some actions want to preserve HR,
  // while effects like Warning Shot want to hard-neutralize it.
  // -------------------------------------------------------

  const wantsHr =
    hasOwn(op, "hrBonus") ||
    hasOwn(op, "hr") ||
    hasOwn(op, "hitRollBonus") ||
    hasOwn(op, "previewHrBonus");

  if (wantsHr) {
    const hr = num(
      pickFirstDefined(
        op.hrBonus,
        op.hr,
        op.hitRollBonus,
        op.previewHrBonus
      ),
      0
    );

    setPath("meta.hrBonus", hr);
    setPath("accuracy.hr", hr);
  }

  // -------------------------------------------------------
  // Bonus / reduction / multiplier
  // -------------------------------------------------------
  // These are optional. If omitted, they are preserved.
  // This keeps the operation useful for both:
  // - "change only the preview base"
  // - "hard set the whole damage packet"
  // -------------------------------------------------------

  if (hasOwn(op, "bonus") || hasOwn(op, "damageBonus")) {
    const bonus = num(pickFirstDefined(op.bonus, op.damageBonus), 0);
    setPath("advPayload.bonus", bonus);
    setPath("meta.bonus", bonus);
  }

  if (hasOwn(op, "reduction") || hasOwn(op, "damageReduction")) {
    const reduction = num(pickFirstDefined(op.reduction, op.damageReduction), 0);
    setPath("advPayload.reduction", reduction);
    setPath("meta.reduction", reduction);
  }

  if (hasOwn(op, "multiplier") || hasOwn(op, "damageMultiplier")) {
    const multiplier = normalizeMultiplier(
      pickFirstDefined(op.multiplier, op.damageMultiplier)
    );

    setPath("advPayload.multiplier", multiplier);
    setPath("meta.multiplier", multiplier);
  }

  // -------------------------------------------------------
  // Optional value type / element / weapon mirrors
  // -------------------------------------------------------

  if (hasOwn(op, "valueType")) {
    const valueType = lower(op.valueType);
    setPath("advPayload.valueType", valueType);
    setPath("meta.valueType", valueType);
  }

  if (hasOwn(op, "elementType") || hasOwn(op, "element")) {
    const validation = validateElement(pickFirstDefined(op.elementType, op.element));

    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.reason,
        changedPaths
      };
    }

    const element = validation.value;

    setPath("advPayload.elementType", element);
    setPath("meta.elementType", element);
    setPath("core.typeDamageTxt", element);

    payload.dataCore = payload.dataCore || {};
    setPath("dataCore.typeDamageTxt", element);
  }

  if (hasOwn(op, "weaponType")) {
    const weaponType = normalizeWeaponType(op.weaponType);

    setPath("advPayload.weaponType", weaponType);
    setPath("meta.weaponType", weaponType);
    setPath("core.weaponType", weaponType);
  }

  // -------------------------------------------------------
  // Debug marker
  // -------------------------------------------------------

  payload.meta.actionEditorPreviewOverride = {
    enabled: true,
    atMs: Date.now(),
    operation: "setDamagePreview",
    input: clone(op, {})
  };

  changedPaths.push("meta.actionEditorPreviewOverride");

  return {
    ok: true,
    changedPaths: uniq(changedPaths),
    summary: "Damage preview fields were set through Action Editor."
  };
} 

  function applySetDamageBonus(payload, op) {
    const value = num(op.value ?? op.bonus, 0);

    payload.advPayload.bonus = value;
    payload.meta.bonus = value;

    return {
      ok: true,
      changedPaths: [
        "advPayload.bonus",
        "meta.bonus"
      ],
      summary: `Damage bonus set to ${value}.`
    };
  }

  function applyAddDamageBonus(payload, op) {
    const add = num(op.value ?? op.amount ?? op.bonus, 0);
    const current = num(payload?.advPayload?.bonus ?? payload?.meta?.bonus, 0);
    const next = current + add;

    payload.advPayload.bonus = next;
    payload.meta.bonus = next;

    return {
      ok: true,
      changedPaths: [
        "advPayload.bonus",
        "meta.bonus"
      ],
      summary: `Damage bonus changed ${current} → ${next}.`
    };
  }

  function applySetDamageReduction(payload, op) {
    const value = num(op.value ?? op.reduction, 0);

    payload.advPayload.reduction = value;
    payload.meta.reduction = value;

    return {
      ok: true,
      changedPaths: [
        "advPayload.reduction",
        "meta.reduction"
      ],
      summary: `Damage reduction set to ${value}.`
    };
  }

  function applySetDamageMultiplier(payload, op) {
    const value = normalizeMultiplier(op.value ?? op.multiplier);

    payload.advPayload.multiplier = value;
    payload.meta.multiplier = value;

    return {
      ok: true,
      changedPaths: [
        "advPayload.multiplier",
        "meta.multiplier"
      ],
      summary: `Damage multiplier set to ${value}%.`
    };
  }

  function applyMultiplyDamageMultiplier(payload, op) {
    const current = normalizeMultiplier(
      payload?.advPayload?.multiplier ??
      payload?.meta?.multiplier ??
      100
    );

    const factorRaw = op.value ?? op.factor ?? 1;
    const factor = num(factorRaw, 1);

    const next = Math.ceil(current * factor);

    payload.advPayload.multiplier = next;
    payload.meta.multiplier = next;

    return {
      ok: true,
      changedPaths: [
        "advPayload.multiplier",
        "meta.multiplier"
      ],
      summary: `Damage multiplier changed ${current}% → ${next}%.`
    };
  }

  function applyReplaceTargets(payload, op) {
    const tokenUuids = normalizeTargets(
      op.value ??
      op.targets ??
      op.targetUuids ??
      op.tokenUuids
    );

    const actorUuids = normalizeTargets(
      op.actorUuids ??
      op.targetActorUuids ??
      op.targetActors
    );

    if (!tokenUuids.length) {
      return {
        ok: false,
        reason: "replaceTargets requires at least one token UUID.",
        changedPaths: []
      };
    }

    const result = syncTargets(payload, tokenUuids, actorUuids);

    return {
      ok: true,
      changedPaths: result.changedPaths,
      summary: `Targets replaced. New target count: ${tokenUuids.length}.`
    };
  }

  function applyAddTarget(payload, op) {
    const currentTokens = getCanonicalTargets(payload);
    const currentActors = getCanonicalTargetActors(payload);

    const addTokens = normalizeTargets(
      op.value ??
      op.targetUuid ??
      op.tokenUuid ??
      op.targetUuids ??
      op.tokenUuids
    );

    const addActors = normalizeTargets(
      op.actorUuid ??
      op.targetActorUuid ??
      op.actorUuids ??
      op.targetActorUuids
    );

    if (!addTokens.length) {
      return {
        ok: false,
        reason: "addTarget requires at least one token UUID.",
        changedPaths: []
      };
    }

    const result = syncTargets(
      payload,
      uniq([...currentTokens, ...addTokens]),
      uniq([...currentActors, ...addActors])
    );

    return {
      ok: true,
      changedPaths: result.changedPaths,
      summary: `Added ${addTokens.length} target(s).`
    };
  }

  function applyRemoveTarget(payload, op) {
    const currentTokens = getCanonicalTargets(payload);
    const currentActors = getCanonicalTargetActors(payload);

    const removeTokens = normalizeTargets(
      op.value ??
      op.targetUuid ??
      op.tokenUuid ??
      op.targetUuids ??
      op.tokenUuids
    );

    const removeActors = normalizeTargets(
      op.actorUuid ??
      op.targetActorUuid ??
      op.actorUuids ??
      op.targetActorUuids
    );

    if (!removeTokens.length && !removeActors.length) {
      return {
        ok: false,
        reason: "removeTarget requires token UUID or actor UUID.",
        changedPaths: []
      };
    }

    const removeTokenSet = new Set(removeTokens);
    const removeActorSet = new Set(removeActors);

    const nextTokens = currentTokens.filter(u => !removeTokenSet.has(u));
    const nextActors = currentActors.filter(u => !removeActorSet.has(u));

    const result = syncTargets(payload, nextTokens, nextActors);

    return {
      ok: true,
      changedPaths: result.changedPaths,
      summary: `Removed target(s). New target count: ${nextTokens.length}.`
    };
  }

  function applySetCostOverride(payload, op) {
    const raw = String(op.value ?? op.cost ?? op.costRaw ?? "").trim();

    payload.meta.costRawOverride = raw;
    payload.meta.costRawFinal = raw;

    return {
      ok: true,
      changedPaths: [
        "meta.costRawOverride",
        "meta.costRawFinal"
      ],
      summary: `Cost override set to "${raw}".`
    };
  }

  function applyClearCostOverride(payload) {
    delete payload.meta.costRawOverride;
    delete payload.meta.costRawFinal;

    return {
      ok: true,
      changedPaths: [
        "meta.costRawOverride",
        "meta.costRawFinal"
      ],
      summary: "Cost override cleared."
    };
  }

  function applySetAutoHit(payload, op) {
    const value = bool(op.value ?? op.autoHit, true);

    payload.meta.autoHit = value;
    payload.accuracy = payload.accuracy || {};
    payload.accuracy.autoHit = value;

    if (value) {
      payload.meta.forceMiss = false;
      payload.accuracy.forceMiss = false;
    }

    return {
      ok: true,
      changedPaths: [
        "meta.autoHit",
        "accuracy.autoHit",
        "meta.forceMiss",
        "accuracy.forceMiss"
      ],
      summary: value ? "Action set to auto-hit." : "Auto-hit removed."
    };
  }

  function applySetForceMiss(payload, op) {
    const value = bool(op.value ?? op.forceMiss, true);

    payload.meta.forceMiss = value;
    payload.accuracy = payload.accuracy || {};
    payload.accuracy.forceMiss = value;

    if (value) {
      payload.meta.autoHit = false;
      payload.accuracy.autoHit = false;
    }

    return {
      ok: true,
      changedPaths: [
        "meta.forceMiss",
        "accuracy.forceMiss",
        "meta.autoHit",
        "accuracy.autoHit"
      ],
      summary: value ? "Action set to force-miss." : "Force-miss removed."
    };
  }

  function applySetIgnoreShield(payload, op) {
    const value = bool(op.value ?? op.ignoreShield, true);

    payload.advPayload.ignoreShield = value;
    payload.meta.ignoreShield = value;

    return {
      ok: true,
      changedPaths: [
        "advPayload.ignoreShield",
        "meta.ignoreShield"
      ],
      summary: value ? "Action now ignores Shield." : "Action no longer ignores Shield."
    };
  }

  function applySetIgnoreDamageReduction(payload, op) {
    const value = bool(op.value ?? op.ignoreDamageReduction ?? op.ignoreDR, true);

    payload.advPayload.ignoreDamageReduction = value;
    payload.meta.ignoreDamageReduction = value;

    return {
      ok: true,
      changedPaths: [
        "advPayload.ignoreDamageReduction",
        "meta.ignoreDamageReduction"
      ],
      summary: value ? "Action now ignores damage reduction." : "Action no longer ignores damage reduction."
    };
  }

  function applySetCardNote(payload, op) {
    const note = String(op.value ?? op.note ?? op.text ?? "").trim();

    payload.meta.actionEditorNote = note;
    payload.meta.actionEditorNotes = Array.isArray(payload.meta.actionEditorNotes)
      ? payload.meta.actionEditorNotes
      : [];

    if (note) {
      payload.meta.actionEditorNotes.push({
        atMs: Date.now(),
        text: note
      });
    }

    return {
      ok: true,
      changedPaths: [
        "meta.actionEditorNote",
        "meta.actionEditorNotes"
      ],
      summary: note ? `Card note set: ${note}` : "Card note cleared."
    };
  }

  function applySetValueType(payload, op) {
    const valueType = lower(op.value ?? op.valueType);

    if (!["hp", "mp", "shield"].includes(valueType)) {
      return {
        ok: false,
        reason: `Invalid value type: ${valueType}`,
        changedPaths: []
      };
    }

    payload.advPayload.valueType = valueType;
    payload.meta.valueType = valueType;

    return {
      ok: true,
      changedPaths: [
        "advPayload.valueType",
        "meta.valueType"
      ],
      summary: `Value type set to ${valueType}.`
    };
  }

  const SEMANTIC_OPERATION_HANDLERS = {
    changeDamageElement: applyChangeDamageElement,
    setDamageElement: applyChangeDamageElement,
    changeElement: applyChangeDamageElement,
    setElement: applyChangeDamageElement,

    changeWeaponType: applyChangeWeaponType,
    setWeaponType: applyChangeWeaponType,

    setBaseValue: applySetBaseValue,
    setDamageBase: applySetBaseValue,

    setDamagePreview: applySetDamagePreview,
    setDamagePreviewValue: applySetDamagePreview,
    setDamageDisplay: applySetDamagePreview,
    setDamageDisplayValue: applySetDamagePreview,

    setDamageBonus: applySetDamageBonus,
    addDamageBonus: applyAddDamageBonus,

    setDamageReduction: applySetDamageReduction,
    setReduction: applySetDamageReduction,

    setDamageMultiplier: applySetDamageMultiplier,
    multiplyDamageMultiplier: applyMultiplyDamageMultiplier,

    replaceTargets: applyReplaceTargets,
    addTarget: applyAddTarget,
    removeTarget: applyRemoveTarget,

    setCostOverride: applySetCostOverride,
    clearCostOverride: applyClearCostOverride,

    setAutoHit: applySetAutoHit,
    setForceHit: applySetAutoHit,
    setForceMiss: applySetForceMiss,

    setIgnoreShield: applySetIgnoreShield,
    setIgnoreDamageReduction: applySetIgnoreDamageReduction,
    setIgnoreDR: applySetIgnoreDamageReduction,

    setCardNote: applySetCardNote,
    addCardNote: applySetCardNote,

    setValueType: applySetValueType
  };

  // =========================================================
  // RAW PATCH APPLIER
  // =========================================================

  function applyRawPatch(payload, patch = {}) {
    const op = lower(patch.op ?? patch.type ?? "set");
    const path = str(patch.path);

    if (!path) {
      return {
        ok: false,
        reason: "Raw patch missing path.",
        changedPaths: []
      };
    }

    if (!isRawPatchPathAllowed(path)) {
      return {
        ok: false,
        reason: `Raw patch path is not allowed: ${path}`,
        changedPaths: []
      };
    }

    const before = clone(getByPath(payload, path), null);

    if (op === "set" || op === "replace") {
      setByPath(payload, path, clone(patch.value, patch.value));
    } else if (op === "delete" || op === "remove") {
      deleteByPath(payload, path);
    } else if (op === "push") {
      pushByPath(payload, path, clone(patch.value, patch.value), {
        unique: !!patch.unique
      });
    } else if (op === "merge") {
      mergeByPath(payload, path, clone(patch.value, {}));
    } else if (op === "addNumber") {
      const current = num(getByPath(payload, path, 0), 0);
      const add = num(patch.value ?? patch.amount, 0);
      setByPath(payload, path, current + add);
    } else {
      return {
        ok: false,
        reason: `Unsupported raw patch op: ${op}`,
        changedPaths: []
      };
    }

    const after = clone(getByPath(payload, path), null);

    return {
      ok: true,
      changedPaths: [path],
      summary: `Raw patch ${op} ${path}`,
      before,
      after
    };
  }

  // =========================================================
  // MAIN APPLY FUNCTION
  // =========================================================

  function normalizeEditInput(editsOrRequest = {}) {
    const input = editsOrRequest?.edits ?? editsOrRequest ?? {};

    const operations =
      Array.isArray(input.operations)
        ? input.operations
        : Array.isArray(input.ops)
          ? input.ops
          : [];

    const patches =
      Array.isArray(input.patches)
        ? input.patches
        : Array.isArray(input.rawPatches)
          ? input.rawPatches
          : [];

    return {
      operations,
      patches
    };
  }

  function applySemanticOperation(payload, op = {}) {
    const type = str(op.type ?? op.operation ?? op.op);

    if (!type) {
      return {
        ok: false,
        reason: "Semantic operation missing type.",
        changedPaths: []
      };
    }

    const handler = SEMANTIC_OPERATION_HANDLERS[type];

    if (typeof handler !== "function") {
      return {
        ok: false,
        reason: `Unsupported semantic operation: ${type}`,
        changedPaths: []
      };
    }

    return handler(payload, op);
  }

  function applyEdits({
    payload,
    edits,
    userId = null,
    editorActorUuid = null,
    reason = "",
    allowPartial = false
  } = {}) {
    const runId = `APE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        runId,
        reason: "missing_payload"
      };
    }

    ensurePayloadShape(payload);

    const normalized = normalizeEditInput(edits ?? {});
    const beforeSnapshot = snapshotPayload(payload);

    const results = [];
    const changedPaths = [];

    log("APPLY START", {
      runId,
      userId,
      editorActorUuid,
      reason,
      actionId: beforeSnapshot.actionId,
      actionCardId: beforeSnapshot.actionCardId,
      actionCardVersion: beforeSnapshot.actionCardVersion,
      operationsCount: normalized.operations.length,
      patchesCount: normalized.patches.length
    });

    if (!normalized.operations.length && !normalized.patches.length) {
      return {
        ok: false,
        runId,
        reason: "no_edits_provided",
        beforeSnapshot,
        afterSnapshot: beforeSnapshot,
        changedPaths: [],
        results: []
      };
    }

    // -------------------------------------------------------
    // 1) Semantic operations first
    // -------------------------------------------------------
    for (const op of normalized.operations) {
      const result = applySemanticOperation(payload, op);

      results.push({
        kind: "operation",
        input: clone(op, {}),
        ...result
      });

      if (!result.ok && !allowPartial) {
        const afterSnapshot = snapshotPayload(payload);

        warn("APPLY FAILED during semantic operation", {
          runId,
          op,
          result
        });

        return {
          ok: false,
          runId,
          reason: result.reason ?? "operation_failed",
          failedAt: "operation",
          failedInput: clone(op, {}),
          beforeSnapshot,
          afterSnapshot,
          diff: shallowDiff(beforeSnapshot, afterSnapshot),
          changedPaths: uniq(changedPaths),
          results
        };
      }

      if (Array.isArray(result.changedPaths)) {
        changedPaths.push(...result.changedPaths);
      }
    }

    // -------------------------------------------------------
    // 2) Raw patches second
    // -------------------------------------------------------
    for (const patch of normalized.patches) {
      const result = applyRawPatch(payload, patch);

      results.push({
        kind: "patch",
        input: clone(patch, {}),
        ...result
      });

      if (!result.ok && !allowPartial) {
        const afterSnapshot = snapshotPayload(payload);

        warn("APPLY FAILED during raw patch", {
          runId,
          patch,
          result
        });

        return {
          ok: false,
          runId,
          reason: result.reason ?? "patch_failed",
          failedAt: "patch",
          failedInput: clone(patch, {}),
          beforeSnapshot,
          afterSnapshot,
          diff: shallowDiff(beforeSnapshot, afterSnapshot),
          changedPaths: uniq(changedPaths),
          results
        };
      }

      if (Array.isArray(result.changedPaths)) {
        changedPaths.push(...result.changedPaths);
      }
    }

    const afterSnapshot = snapshotPayload(payload);
    const diff = shallowDiff(beforeSnapshot, afterSnapshot);

    // Small non-destructive marker.
    payload.meta.actionEditor = payload.meta.actionEditor || {};
    payload.meta.actionEditor.lastPatchRunId = runId;
    payload.meta.actionEditor.lastPatchedAtMs = Date.now();
    payload.meta.actionEditor.lastPatchedByUserId = userId ?? game.userId ?? null;
    payload.meta.actionEditor.lastEditorActorUuid = editorActorUuid ?? null;
    payload.meta.actionEditor.lastReason = reason || "";

    changedPaths.push(
      "meta.actionEditor.lastPatchRunId",
      "meta.actionEditor.lastPatchedAtMs",
      "meta.actionEditor.lastPatchedByUserId",
      "meta.actionEditor.lastEditorActorUuid",
      "meta.actionEditor.lastReason"
    );

    const ok = results.every(r => r.ok) || allowPartial;

    log("APPLY DONE", {
      runId,
      ok,
      actionId: afterSnapshot.actionId,
      actionCardId: afterSnapshot.actionCardId,
      changedPaths: uniq(changedPaths),
      diff
    });

    return {
      ok,
      runId,
      payload,

      userId: userId ?? game.userId ?? null,
      editorActorUuid: editorActorUuid ?? null,
      reason: reason || "",

      beforeSnapshot,
      afterSnapshot,
      diff,

      changedPaths: uniq(changedPaths),
      results
    };
  }

  // Convenience function for common use cases.
  function changeDamageElement(payload, elementType, options = {}) {
    return applyEdits({
      payload,
      edits: {
        operations: [
          {
            type: "changeDamageElement",
            value: elementType
          }
        ]
      },
      ...options
    });
  }

  function replaceTargets(payload, targetUuids = [], options = {}) {
    return applyEdits({
      payload,
      edits: {
        operations: [
          {
            type: "replaceTargets",
            targetUuids
          }
        ]
      },
      ...options
    });
  }

  function addDamageBonus(payload, amount = 0, options = {}) {
    return applyEdits({
      payload,
      edits: {
        operations: [
          {
            type: "addDamageBonus",
            value: amount
          }
        ]
      },
      ...options
    });
  }

  // =========================================================
  // API REGISTRATION
  // =========================================================

  const api = {
    version: API_VERSION,

    applyEdits,

    changeDamageElement,
    replaceTargets,
    addDamageBonus,

    snapshotPayload,
    shallowDiff,

    normalizeElement,
    normalizeWeaponType,
    normalizeMultiplier,
    normalizeTargets,

    isRawPatchPathAllowed,
    RAW_PATCH_ALLOW_PREFIXES: [...RAW_PATCH_ALLOW_PREFIXES],
    SEMANTIC_OPERATION_TYPES: Object.keys(SEMANTIC_OPERATION_HANDLERS)
  };

  // Global namespace.
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  globalThis.FUCompanion.api.actionEditorPatchEngine = api;

  globalThis.FUCompanion.api.actionEditor =
    globalThis.FUCompanion.api.actionEditor || {};

  globalThis.FUCompanion.api.actionEditor.patchEngine = api;

  // Module API namespace.
  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};

      mod.api.actionEditorPatchEngine = api;

      mod.api.actionEditor = mod.api.actionEditor || {};
      mod.api.actionEditor.patchEngine = api;
    }
  } catch (e) {
    warn("Could not register PatchEngine on game.modules API.", {
      error: String(e?.message ?? e)
    });
  }

  console.log(`${TAG} Ready`, {
    version: API_VERSION,
    moduleId: MODULE_ID,
    debug: ACTION_EDITOR_PATCH_DEBUG,
    semanticOperations: Object.keys(SEMANTIC_OPERATION_HANDLERS)
  });
})();