// ──────────────────────────────────────────────────────────
//  Action Data Fetch (→ CreateActionCard) · multi-source
//  Foundry V12 — No arguments[0]; use headless __AUTO/__PAYLOAD.
// ──────────────────────────────────────────────────────────
const CARD_MACRO_NAME    = "CreateActionCard";
const COMPUTE_MACRO_NAME = "ActionDataComputation";
const ADF_DEBUG = true; // <-- set true to see debug logs
const ADF_TAG   = "[ADF][DBG]";

// Rich text → script API (per Oni guide)
const MODULE_ID = "fabula-ultima-companion";

return (async () => {
  if (!canvas?.scene) return ui.notifications.error("No active scene.");
  const _ADF_T0 = (typeof performance !== "undefined" && performance?.now) ? performance.now() : Date.now();
  const _ADF_RUN_ID = `ADF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const { log: _adfLog, warn: _adfWarn, err: _adfErr } =
    FUCompanion.createLogger(`${ADF_TAG} ${_ADF_RUN_ID}`, ADF_DEBUG);

  // ---------------- Optional-number helper ----------------
  function parseOptionalNumber(raw) {
    const rawVal = raw;
    if (typeof rawVal === "string" && rawVal.trim() === "") return { provided: false, value: 0, raw: rawVal };
    if (rawVal === null || rawVal === undefined) return { provided: false, value: 0, raw: rawVal };
    const n = (typeof rawVal === "number") ? rawVal : Number(rawVal);
    if (!Number.isFinite(n)) return { provided: false, value: 0, raw: rawVal };
    return { provided: true, value: n, raw: rawVal };
  }

  // ---------------- Rich text normalization helpers ----------------
  function _getRichTextApi() {
    try {
      return game.modules?.get(MODULE_ID)?.api?.richText ?? null;
    } catch { return null; }
  }

  /**
   * Convert rich text HTML into clean JS.
   * - If API exists, always use it.
   * - If not, fallback to best-effort: return the input string.
   */
  function _toScript(raw) {
    const s = (raw ?? "").toString();
    if (!s.trim()) return "";
    const api = _getRichTextApi();
    if (!api?.toScript) return s; // fallback (won't fix HTML, but prevents crashes)
    try { return api.toScript(s); } catch (e) { _adfErr("richText.toScript failed:", e); return s; }
  }

  // ---------------- NEW: Owner-user resolver for downstream Targeting ----------------
  function resolveOwnerUserIdForActor(actor) {
    const fallback = game.userId ?? null;
    if (!actor) return fallback;

    const allUsers = Array.from(game.users ?? []);
    const isOwner = (u) => {
      try {
        return !!actor.testUserPermission?.(u, "OWNER");
      } catch {
        return false;
      }
    };

    const owners = allUsers.filter(isOwner);
    if (!owners.length) return fallback;

    // Prefer the current user if they own the actor.
    const currentOwner = owners.find(u => u.id === game.userId);
    if (currentOwner) return currentOwner.id;

    // Prefer an active non-GM owner for player-facing targeting.
    const activeNonGM = owners.find(u => u.active && !u.isGM);
    if (activeNonGM) return activeNonGM.id;

    // Then any active owner.
    const activeAny = owners.find(u => u.active);
    if (activeAny) return activeAny.id;

    // Finally, first owner.
    return owners[0]?.id ?? fallback;
  }

  // Snapshot: environment
  try {
    const c = game.combat ?? null;
    _adfLog("START", {
      scene: { id: canvas.scene?.id ?? null, name: canvas.scene?.name ?? null },
      user : { id: game.user?.id ?? null, name: game.user?.name ?? null, isGM: !!game.user?.isGM },
      combat: c ? { id: c.id ?? null, active: !!c.active, started: !!c.started, round: c.round ?? null, turn: c.turn ?? null } : null,
      controlledTokens: canvas.tokens?.controlled?.map(t => ({ id: t.id, name: t.name, actorId: t.actor?.id, actorUuid: t.actor?.uuid })) ?? [],
      userTargets: Array.from(game.user?.targets ?? []).map(t => t.document?.uuid).filter(Boolean)
    });
  } catch (e) {
    _adfErr("START snapshot failed:", e);
  }

  // ---------------- Headless shims ----------------
  let AUTO = false, PAYLOAD = {};
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

  // ---- PAYLOAD snapshot ----
  try {
    const safe = (v) => {
      if (v === null || v === undefined) return v;
      const t = typeof v;
      if (t === "string") return v.length > 240 ? (v.slice(0, 240) + "…") : v;
      if (t === "number" || t === "boolean") return v;
      if (Array.isArray(v)) return { _type: "array", len: v.length, sample: v.slice(0, 5) };
      if (t === "object") return { _type: "object", keys: Object.keys(v).slice(0, 25) };
      return { _type: t };
    };

    const globals = {
      actorIdType : (typeof actorId  !== "undefined") ? typeof actorId : "undefined",
      skillIdType : (typeof skillId  !== "undefined") ? typeof skillId : "undefined",
      skillUuidType: (typeof skillUuid!== "undefined") ? typeof skillUuid : "undefined",
      actorId  : (typeof actorId  !== "undefined") ? safe(actorId)  : undefined,
      skillId  : (typeof skillId  !== "undefined") ? safe(skillId)  : undefined,
      skillUuid: (typeof skillUuid!== "undefined") ? safe(skillUuid): undefined
    };

    _adfLog("PAYLOAD snapshot", {
      AUTO,
      source: PAYLOAD?.source ?? null,
      executionMode: PAYLOAD?.meta?.executionMode ?? (PAYLOAD?.autoPassive ? "autoPassive" : null),
      isPassiveExecution: !!(PAYLOAD?.meta?.isPassiveExecution || PAYLOAD?.autoPassive),
      keys: Object.keys(PAYLOAD ?? {}).slice(0, 40),
      attacker_uuid: safe(PAYLOAD?.attacker_uuid),
      attackerUuid : safe(PAYLOAD?.attackerUuid),
      metaAttacker : safe(PAYLOAD?.meta?.attackerUuid),
      passedSkillUuid: safe(PAYLOAD?.skillUuid),
      passiveItemUuid: safe(PAYLOAD?.meta?.passiveItemUuid),
      itemUuid: safe(PAYLOAD?.itemUuid),
      targetsCount: Array.isArray(PAYLOAD?.targets) ? PAYLOAD.targets.length : 0,
      originalTargetUUIDsCount: Array.isArray(PAYLOAD?.originalTargetUUIDs) ? PAYLOAD.originalTargetUUIDs.length : 0,
      originalTargetActorUUIDsCount:
        Array.isArray(PAYLOAD?.originalTargetActorUUIDs) ? PAYLOAD.originalTargetActorUUIDs.length
        : Array.isArray(PAYLOAD?.meta?.originalTargetActorUUIDs) ? PAYLOAD.meta.originalTargetActorUUIDs.length
        : Array.isArray(PAYLOAD?.meta?.targetActorUUIDs) ? PAYLOAD.meta.targetActorUUIDs.length
        : 0,
      globals
    });
  } catch (e) { _adfErr("PAYLOAD snapshot failed:", e); }

  // ---------------- Actor resolution (robust, V12-safe) ----------------
  function selectedToken()        { return canvas.tokens?.controlled?.[0] ?? null; }
  function firstSelectableToken() { return canvas.tokens?.placeables?.find(t => t.actor?.isOwner) ?? null; }

  function resolveActorForUserV12() {
    if (game.user.isGM) {
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok, why: tok ? "GM selected/fallback token" : "GM: none" };
    } else {
      const a = game.user.character ?? null;
      if (a) {
        const tok = canvas.tokens?.placeables?.find(t => t.actor?.id === a.id) ?? null;
        return { actor: a, token: tok, why: "Player linked actor" };
      }
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok, why: tok ? "Player fallback: selected owned token" : "Player: none" };
    }
  }

  async function resolveActorFromUuidMaybe(uuid) {
    if (!uuid) return { actor:null, token:null, why:"no uuid" };
    try {
      const doc = await fromUuid(uuid);
      if (doc?.documentName === "Actor") return { actor: doc, token: null, why: "incoming actor uuid" };
      if (doc?.documentName === "Token") return { actor: doc?.actor ?? null, token: doc?.object ?? null, why: "incoming token uuid" };
      return { actor: doc?.actor ?? null, token: doc?.object ?? null, why: "incoming uuid (best-effort)" };
    } catch { return { actor:null, token:null, why:"uuid error" }; }
  }

  const incomingUuid = PAYLOAD.attacker_uuid || PAYLOAD.attackerUuid || PAYLOAD?.meta?.attackerUuid || null;
  let attacker = await resolveActorFromUuidMaybe(incomingUuid);

  if (!attacker.actor) attacker = resolveActorForUserV12();

  const attackerUuid = attacker.actor?.uuid || attacker.token?.document?.uuid || null;
  if (!attackerUuid || !attacker.actor) {
    return ui.notifications?.warn("ActionDataFetch: Could not resolve your character. (Players: link a Character; GMs: select a token.)");
  }

  const resolvedOwnerUserId =
    PAYLOAD?.meta?.ownerUserId ||
    resolveOwnerUserIdForActor(attacker.actor) ||
    game.userId ||
    null;

  const executionModeSeed =
    String(PAYLOAD?.meta?.executionMode ?? (PAYLOAD?.autoPassive ? "autoPassive" : "manual")).trim() || "manual";

  const isAutoPassiveExecution =
    executionModeSeed === "autoPassive" ||
    !!PAYLOAD?.meta?.isPassiveExecution ||
    !!PAYLOAD?.autoPassive;

  const seededOriginalTargetUUIDs =
    Array.isArray(PAYLOAD?.originalTargetUUIDs) ? [...PAYLOAD.originalTargetUUIDs]
    : Array.isArray(PAYLOAD?.meta?.originalTargetUUIDs) ? [...PAYLOAD.meta.originalTargetUUIDs]
    : Array.isArray(PAYLOAD?.targets) ? [...PAYLOAD.targets]
    : [];

  const seededOriginalTargetActorUUIDs =
    Array.isArray(PAYLOAD?.originalTargetActorUUIDs) ? [...PAYLOAD.originalTargetActorUUIDs]
    : Array.isArray(PAYLOAD?.meta?.originalTargetActorUUIDs) ? [...PAYLOAD.meta.originalTargetActorUUIDs]
    : Array.isArray(PAYLOAD?.meta?.targetActorUUIDs) ? [...PAYLOAD.meta.targetActorUUIDs]
    : [];

  PAYLOAD.originalTargetUUIDs = [...seededOriginalTargetUUIDs];
  PAYLOAD.originalTargetActorUUIDs = [...seededOriginalTargetActorUUIDs];

  PAYLOAD.meta = {
    ...(PAYLOAD.meta ?? {}),
    attackerUuid,
    attackerName: PAYLOAD.meta?.attackerName ?? attacker.actor.name,
    ownerUserId: resolvedOwnerUserId,
    executionMode: executionModeSeed,
    isPassiveExecution: isAutoPassiveExecution,
    originalTargetUUIDs: seededOriginalTargetUUIDs,
    originalTargetActorUUIDs: seededOriginalTargetActorUUIDs,
    targetActorUUIDs: Array.isArray(PAYLOAD?.meta?.targetActorUUIDs)
      ? [...PAYLOAD.meta.targetActorUUIDs]
      : [...seededOriginalTargetActorUUIDs]
  };

  let useActor = attacker?.actor ?? null;
  if (!useActor) {
    if (game.user.isGM) {
      const sel = canvas.tokens?.controlled?.[0] ?? null;
      if (!sel?.actor) return ui.notifications.warn("GM: Select a token first (no attacker resolved).");
      useActor = sel.actor;
    } else {
      useActor = game.user?.character ?? null;
      if (!useActor) {
        const sel = canvas.tokens?.controlled?.[0] ?? null;
        if (sel?.actor?.isOwner) useActor = sel.actor;
      }
    }
  }
  if (!useActor) return ui.notifications.warn("Could not determine the attacker. (No linked character and no valid selection.)");

  function inferListTypeFromItem(itemDoc) {
    const p = itemDoc?.system?.props ?? {};
    const skillTypeRaw = String(p.skill_type ?? "").trim().toLowerCase();
    const isSpell = !!p.isSpell;
    const isOffSpell = !!p.isOffensiveSpell;

    if (skillTypeRaw === "passive") return "Passive";
    if (skillTypeRaw === "attack") return "Attack";
    if (isOffSpell) return "Offensive Spell";
    if (isSpell) return "Spell";
    return "Active";
  }

  function buildForwardMeta(extra = {}) {
    return {
      ...(PAYLOAD.meta ?? {}),
      ownerUserId: resolvedOwnerUserId,
      attackerUuid,
      attackerActorUuid: useActor?.uuid ?? attacker?.actor?.uuid ?? null,
      attackerTokenUuid: attacker?.token?.document?.uuid ?? attacker?.token?.uuid ?? null,
      executionMode: executionModeSeed,
      isPassiveExecution: isAutoPassiveExecution,
      originalTargetUUIDs: [...seededOriginalTargetUUIDs],
      originalTargetActorUUIDs: [...seededOriginalTargetActorUUIDs],
      targetActorUUIDs: Array.isArray(PAYLOAD?.meta?.targetActorUUIDs)
        ? [...PAYLOAD.meta.targetActorUUIDs]
        : [...seededOriginalTargetActorUUIDs],
      ...extra
    };
  }

  _adfLog("RESOLVED execution context", {
    source: PAYLOAD?.source ?? null,
    executionMode: executionModeSeed,
    isAutoPassiveExecution,
    attackerUuid,
    attackerActorUuid: useActor?.uuid ?? null,
    ownerUserId: resolvedOwnerUserId,
    originalTargetUUIDs: seededOriginalTargetUUIDs,
    originalTargetActorUUIDs: seededOriginalTargetActorUUIDs
  });

  // =========================== BRANCH: Weapon ===================================
  if (PAYLOAD?.source === "Weapon" && PAYLOAD?.overrides) {
    const O = PAYLOAD.overrides;

    async function resolveWeaponDoc() {
      const byName = (name) => {
        if (!name) return null;
        let it = useActor.items?.getName?.(name) || null;
        if (it) return it;
        const lower = String(name).toLowerCase();
        it = useActor.items?.find(i => i.name?.toLowerCase?.() === lower) || null;
        if (it) return it;
        it = useActor.items?.find(i => i.name?.toLowerCase?.().startsWith(lower)) || null;
        return it || null;
      };

      if (O.weapon_uuid) {
        try { const doc = await fromUuid(O.weapon_uuid); if (doc) return doc; } catch {}
      }

      const wn = O.weapon_name || (String(O.skill_name || "").replace(/^Attack\s*—\s*/i, "").trim());
      let doc = byName(wn);
      if (doc) return doc;

      try {
        const wlist = useActor?.system?.props?.weapon_list || {};
        const arr = Object.values(wlist);
        const found = arr.find(w => (w?.name || "").toLowerCase() === String(wn||"").toLowerCase());
        if (found?.uuid) {
          const fromW = await fromUuid(found.uuid).catch(()=>null);
          if (fromW) return fromW;
        }
      } catch {}

      return null;
    }

    const weaponDoc = await resolveWeaponDoc();
    const dmgParsed = parseOptionalNumber(O.damage_bonus);

      const dataCore = {
      attackerName : useActor.name,
      skillName    : String(O.skill_name ?? (O.weapon_name || "Attack")),
      skillImg     : String(weaponDoc?.img || O.skill_img || ""),
      listType     : "Attack",

      isCheck      : true,
      isSpell      : false,
      isOffSpell   : false,
      rolledAtr1   : String(O.rolled_atr1 ?? "DEX").toUpperCase(),
      rolledAtr2   : String(O.rolled_atr2 ?? "DEX").toUpperCase(),
      checkBonus   : Number(O.check_bonus ?? 0) || 0,

      damageBonus  : dmgParsed.value,
      damageBonusProvided: dmgParsed.provided,
      damageBonusRaw: dmgParsed.raw,
      typeDamageTxt: String(O.type_damage ?? "physical").trim(),
      flatBonus    : Number(O.bonus ?? 0) || 0,
      reduction    : Number(O.reduction ?? 0) || 0,
      multiplier   : Number(O.multiplier ?? 100) || 100,

      skillRange   : String(O.skill_range ?? "Melee"),
      rawEffectHTML: String(O.raw_effect ?? ""),

      weaponType   : (() => {
        const t = (
          O.weapon_type ||
          weaponDoc?.system?.props?.weapon_type ||
          weaponDoc?.system?.props?.category ||
          ""
        ).toString().trim();
        return t.toLowerCase();
      })(),

      skillTypeRaw   : "Active",
      skillTargetRaw : (
        O.skill_target ??
        weaponDoc?.system?.props?.skill_target ??
        "One Creature"
      ).toString().trim()
    };

    // NEW: Fetch + convert weapon custom logic from item template
    const customLogicActionRaw = _toScript(
      weaponDoc?.system?.props?.custom_logic_action ?? ""
    );
    const customLogicResolutionRaw = _toScript(
      weaponDoc?.system?.props?.custom_logic_resolution ?? ""
    );

    _adfLog("RichText scripts (Weapon)", {
      executionMode: executionModeSeed,
      isAutoPassiveExecution,
      weaponUuid: weaponDoc?.uuid ?? null,
      weaponName: weaponDoc?.name ?? null,
      customLogicActionLen: customLogicActionRaw.length,
      customLogicResolutionLen: customLogicResolutionRaw.length,
      customLogicActionPreview: customLogicActionRaw.slice(0, 140),
      customLogicResolutionPreview: customLogicResolutionRaw.slice(0, 140)
    });

    const targets = Array.isArray(PAYLOAD.targets)
      ? PAYLOAD.targets
      : Array.from(game.user?.targets ?? []).map(t => t.document?.uuid).filter(Boolean);

    const computeMacro = game.macros.getName(COMPUTE_MACRO_NAME);
    if (!computeMacro) return ui.notifications.error(`Macro "${COMPUTE_MACRO_NAME}" not found or no permission.`);

        return await computeMacro.execute({
      __AUTO: true,
      __PAYLOAD: {
        source           : "Weapon",
        executionMode    : executionModeSeed,
        autoPassive      : isAutoPassiveExecution,
        attackerActorUuid: useActor?.uuid ?? null,
        dataCore,
        overrides        : O,
        weaponUuid       : weaponDoc?.uuid ?? null,
        targets,
        originalTargetUUIDs     : [...seededOriginalTargetUUIDs],
        originalTargetActorUUIDs: [...seededOriginalTargetActorUUIDs],

        // NEW: Weapon custom logic scripts (clean JS text)
        customLogicActionRaw,
        customLogicResolutionRaw,

        meta             : buildForwardMeta({
  weaponUuid: weaponDoc?.uuid ?? null
})
      }
    });

    return;
  }

  // =========================== DEFAULT: Skill/Spell =================================
  let passedActorId, passedSkillId, passedSkillUuid;
  if (typeof actorId  !== "undefined") passedActorId  = actorId;
  if (typeof skillId  !== "undefined") passedSkillId  = skillId;
  if (typeof skillUuid!== "undefined") passedSkillUuid= skillUuid;
  if (PAYLOAD?.skillUuid) passedSkillUuid = PAYLOAD.skillUuid;

  // NEW: Item-sourced skill fast-path
  const originSource = (PAYLOAD?.source ?? "").toString();
  if (originSource === "Item" && PAYLOAD?.skillUuid) {
    if (!useActor) {
      const resolved = resolveActorForUserV12();
      if (!resolved?.actor) return ui.notifications.warn("No attacker resolved for Item-based Skill.");
      useActor = resolved.actor;
    }

    let skillItem = null;
    try { skillItem = await fromUuid(PAYLOAD.skillUuid); } catch (e) { console.error(e); }
    if (!skillItem) return ui.notifications.error("Could not resolve the Item Skill from its UUID.");

    let itemDoc = null;
    if (PAYLOAD?.itemUuid) {
      try { itemDoc = await fromUuid(PAYLOAD.itemUuid); } catch (e) { console.error(e); }
    }

    const displayName = itemDoc?.name ?? skillItem.name ?? "Unknown Skill";
    const displayImg  =
      (itemDoc?.img ||
       skillItem?.img ||
       foundry.utils.getProperty(skillItem, "system.props.img") ||
       "")?.toString();

    const GP = (k, d = null) =>
      foundry.utils.getProperty(skillItem, `system.props.${k}`) ?? d;

    const dmgRaw = GP("damage_bonus", null);
    const dmgParsed = parseOptionalNumber(dmgRaw);

    const dataCore = {
      attackerName : useActor.name,
      skillName    : displayName,
      skillImg     : displayImg,
      listType     : "Item",

      isCheck      : !!GP("isCheck", false),
      isSpell      : !!GP("isSpell", false),
      isOffSpell   : !!GP("isOffensiveSpell", false),
      rolledAtr1   : (GP("rolled_atr1", null) || "").toString().toUpperCase(),
      rolledAtr2   : (GP("rolled_atr2", null) || "").toString().toUpperCase(),
      checkBonus   : Number(GP("check_bonus", 0)) || 0,

      damageBonus  : dmgParsed.value,
      damageBonusProvided: dmgParsed.provided,
      damageBonusRaw: dmgRaw,
      typeDamageTxt: (GP("type_damage", "physical") || "").toString().trim(),
      flatBonus    : Number(GP("bonus", 0)) || 0,
      reduction    : Number(GP("reduction", 0)) || 0,
      multiplier   : Number(GP("multiplier", 100)) || 100,

      skillRange   : (GP("skill_range", "") || "").toString(),
      rawEffectHTML: GP("description", "") || "",
      weaponType   : (GP("weapon_type", "") || "").toString().toLowerCase(),
      skillTypeRaw : (GP("skill_type","") || "").toString().trim(),
      skillTargetRaw: (GP("skill_target","") || "").toString().trim()
    };

    const animTimingModeRaw   = GP("animation_damage_timing_options", "default");
    const animTimingOffsetRaw = GP("animation_damage_timing_offset", 0);
    const animTimingMode = String(animTimingModeRaw ?? "default").trim().toLowerCase();
    const animTimingOffset = (() => {
      const n = Number(animTimingOffsetRaw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    })();

    const ignoreHR = !!GP("ignore_hr", false);

    // NEW: Fetch + convert rich text scripts
    const animationScriptRaw = _toScript(GP("animation_script", ""));
    const customLogicActionRaw = _toScript(GP("custom_logic_action", ""));
    const customLogicResolutionRaw = _toScript(GP("custom_logic_resolution", ""));

    // Optional: debug preview
    _adfLog("RichText scripts (Item fast-path)", {
      executionMode: executionModeSeed,
      isAutoPassiveExecution,

      animationScriptLen: animationScriptRaw.length,
      customLogicActionLen: customLogicActionRaw.length,
      customLogicResolutionLen: customLogicResolutionRaw.length,
      customLogicActionPreview: customLogicActionRaw.slice(0, 140),
      customLogicResolutionPreview: customLogicResolutionRaw.slice(0, 140),
      skillTypeRaw: dataCore.skillTypeRaw,
      skillTargetRaw: dataCore.skillTargetRaw
    });

    const itemUseMode = String(
  PAYLOAD?.itemUseMode ??
  PAYLOAD?.meta?.itemUseMode ??
  (PAYLOAD?.itemCreate?.enabled || PAYLOAD?.meta?.itemCreate?.enabled ? "create" : "use")
).trim().toLowerCase();

const isCreateItemMode = itemUseMode === "create";

const itemCreate = (() => {
  const raw = PAYLOAD?.itemCreate ?? PAYLOAD?.meta?.itemCreate ?? null;
  if (!raw) return null;

  try {
    return foundry.utils.deepClone(raw);
  } catch {
    return { ...raw };
  }
})();

const itemUsage = (() => {
  if (!itemDoc) return null;

  const p = itemDoc.system?.props ?? {};
  const isUnique = !!p.isUnique;

  // Create mode:
  // The item is being created from IP, not consumed from inventory.
  if (isCreateItemMode) {
    return {
      mode: "create",
      consumeQuantity: false,

      itemUuid: itemDoc.uuid,
      itemId: itemDoc.id,
      itemName: itemDoc.name ?? "",

      createdItemUuid: itemCreate?.createdItemUuid ?? itemDoc.uuid,
      createdItemId: itemCreate?.createdItemId ?? itemDoc.id,
      createdItemName: itemCreate?.createdItemName ?? itemDoc.name ?? "",

      recipeUuid: itemCreate?.recipeUuid ?? null,
      recipeName: itemCreate?.recipeName ?? null,

      isUnique: false,
      quantity: null
    };
  }

  // Use mode:
  // Normal JRPG item usage; quantity should be consumed later by ActionExecutionCore.
  let quantity = 0;
  if (!isUnique) {
    const q = Number(p.item_quantity ?? 0);
    quantity = Number.isFinite(q) ? q : 0;
  }

  return {
    mode: "use",
    consumeQuantity: true,

    itemUuid: itemDoc.uuid,
    itemId: itemDoc.id,
    itemName: itemDoc.name ?? "",

    isUnique,
    quantity
  };
})();

const itemCostMeta = (() => {
  const out = {};

  if (PAYLOAD?.meta?.costRaw !== undefined) {
    out.costRaw = PAYLOAD.meta.costRaw;
  }

  if (PAYLOAD?.meta?.costRawOverride !== undefined) {
    out.costRawOverride = PAYLOAD.meta.costRawOverride;
  }

  if (PAYLOAD?.meta?.costRawFinal !== undefined) {
    out.costRawFinal = PAYLOAD.meta.costRawFinal;
  }

  return out;
})();

_adfLog("Item usage mode resolved", {
  itemUseMode,
  isCreateItemMode,
  itemName: itemDoc?.name ?? null,
  itemUuid: itemDoc?.uuid ?? null,
  itemUsage,
  itemCreate,
  itemCostMeta
});

    const targets = Array.isArray(PAYLOAD.targets)
      ? PAYLOAD.targets
      : Array.from(game.user?.targets ?? []).map(t => t.document?.uuid).filter(Boolean);

    const computeMacro = game.macros.getName(COMPUTE_MACRO_NAME);
    if (!computeMacro) return ui.notifications.error(`Macro "${COMPUTE_MACRO_NAME}" not found or no permission.`);

    return await computeMacro.execute({
      __AUTO: true,
      __PAYLOAD: {
        source            : "Skill",
        executionMode     : executionModeSeed,
        autoPassive       : isAutoPassiveExecution,
        attackerActorUuid : useActor?.uuid ?? null,
        dataCore,
        ignoreHR,
        skillUuid         : skillItem?.uuid ?? null,
        listType          : "Item",
        animTimingMode,
        animTimingOffset,
        animationScriptRaw,
        targets,
        originalTargetUUIDs     : [...seededOriginalTargetUUIDs],
        originalTargetActorUUIDs: [...seededOriginalTargetActorUUIDs],

        // NEW: Custom logic scripts (clean JS text)
        customLogicActionRaw,
        customLogicResolutionRaw,

itemUseMode,
itemCreate,
itemUsage,

meta: buildForwardMeta({
  itemUseMode,
  itemCreate,
  itemUsage,

  itemUuid: itemDoc?.uuid ?? PAYLOAD?.itemUuid ?? null,
  itemName: itemDoc?.name ?? PAYLOAD?.itemName ?? null,

  ...itemCostMeta
})
      }
    });

    return;
  }

  // --- Normal Skill/Spell flow ---
  if (passedActorId && game.actors?.has(passedActorId)) {
    const a = game.actors.get(passedActorId);
    const tokenForA = canvas.tokens?.placeables?.find(t => t.actor?.id === passedActorId) ?? null;
    useActor = tokenForA?.actor ?? a;
  }

  const props = useActor?.system?.props ?? {};
  const listToArray = (obj, listType) =>
    (obj && typeof obj === "object")
      ? Object.values(obj).map(e => ({ name: e.name, id: e.id, uuid: e.uuid, listType }))
      : [];

  const allSkills = [
    ...listToArray(props.attack_list,          "Attack"),
    ...listToArray(props.skill_active_list,    "Active"),
    ...listToArray(props.skill_passive_list,   "Passive"),
    ...listToArray(props.offensive_spell_list, "Offensive Spell"),
    ...listToArray(props.normal_spell_list,    "Spell")
  ];

  if (!allSkills.length && !passedSkillUuid) {
    return ui.notifications.warn("No skills found in this actor’s skill lists.");
  }

  let selectedSkillMeta = null;
  let preselectVia = null;

  const _extractItemIdFromUuid = (u) => {
    const s = String(u || "");
    const m = s.match(/\.Item\.([^.]+)$/);
    return m ? m[1] : null;
  };

  let passedSkillDoc = null;
  if (passedSkillUuid) {
    try { passedSkillDoc = await fromUuid(passedSkillUuid); } catch {}
  }

  if (passedSkillUuid) {
    selectedSkillMeta = allSkills.find(s => s.uuid === passedSkillUuid) ?? null;
    if (selectedSkillMeta) preselectVia = "exact-uuid";
  }

  if (!selectedSkillMeta && passedSkillUuid) {
    const itemId = _extractItemIdFromUuid(passedSkillUuid) || passedSkillDoc?.id || null;
    if (itemId) {
      selectedSkillMeta = allSkills.find(s => String(s.uuid || "").includes(`.Item.${itemId}`)) ?? null;
      if (selectedSkillMeta) preselectVia = "itemId-suffix";
    }
  }

  if (!selectedSkillMeta && passedSkillId) {
    selectedSkillMeta = allSkills.find(s => s.id === passedSkillId) ?? null;
    if (selectedSkillMeta) preselectVia = "passedSkillId";
  }

  if (!selectedSkillMeta && passedSkillDoc) {
    selectedSkillMeta = {
      name: passedSkillDoc?.name ?? "",
      id: passedSkillDoc?.id ?? null,
      uuid: passedSkillDoc?.uuid ?? passedSkillUuid ?? null,
      listType: inferListTypeFromItem(passedSkillDoc)
    };
    preselectVia = "passedSkillDoc-fallback";
  }

  async function pickSkillDialog(skills) {
    const grouped = skills.reduce((acc, s) => ((acc[s.listType] ??= []).push(s), acc), {});
    const order = ["Attack","Active","Passive","Offensive Spell","Spell"];
    const S = (v) => (v ?? "").toString().trim();
    const nameOf = (s) => (S(s?.name) || S(s?.item?.name) || "").trim();

    const htmlOpts = order.map(label => {
      const raw = (grouped[label] ?? []);
      const arr = raw.filter(s => nameOf(s).length).sort((a,b) => nameOf(a).localeCompare(nameOf(b)));
      if (!arr.length) return "";
      return `<optgroup label="${label}">` +
        arr.map(s => `<option value="${s.uuid}">[${label}] ${nameOf(s)}</option>`).join("") +
      `</optgroup>`;
    }).join("");

    const content =
      `<form>
        <div class="form-group">
          <label>Choose a Skill</label>
          <select name="skillUuid" style="width:100%;">${htmlOpts}</select>
        </div>
      </form>`;

    return await new Promise(resolve => new Dialog({
      title: "Choose Skill",
      content,
      default: "ok",
      buttons: {
        ok: {
          label: "Use",
          callback: html => resolve(html?.[0]?.querySelector?.('[name="skillUuid"]')?.value ?? null)
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      close: () => resolve(null)
    }).render(true));
  }

  if (!selectedSkillMeta) {
    if (isAutoPassiveExecution) {
      _adfWarn("Auto-passive skill resolution failed before dialog stage.", {
        passedSkillUuid,
        passedSkillId,
        source: PAYLOAD?.source ?? null,
        passiveItemUuid: PAYLOAD?.meta?.passiveItemUuid ?? null,
        allSkillsCount: allSkills.length
      });
      return ui.notifications?.warn?.("Auto Passive: Could not resolve the passive skill item.");
    }

    const pick = await pickSkillDialog(allSkills);
    if (!pick) return;
    selectedSkillMeta = allSkills.find(s => s.uuid === pick);
  }

  let skillItem = null;
  try {
    const primaryUuid = passedSkillUuid || selectedSkillMeta.uuid;
    skillItem = await fromUuid(primaryUuid);
    if (!skillItem && passedSkillUuid && selectedSkillMeta?.uuid && selectedSkillMeta.uuid !== passedSkillUuid) {
      skillItem = await fromUuid(selectedSkillMeta.uuid);
    }
  } catch(e){ _adfErr("fromUuid failed for skillItem:", (passedSkillUuid || selectedSkillMeta?.uuid), e); }
  if (!skillItem) return ui.notifications.error("Could not resolve the skill Item from its UUID.");

  const GP = (k, d = null) =>
    foundry.utils.getProperty(skillItem, `system.props.${k}`) ?? d;

  const dmgRaw = GP("damage_bonus", null);
  const dmgParsed = parseOptionalNumber(dmgRaw);

  const dataCore = {
    attackerName : useActor.name,
    skillName    : skillItem.name ?? "Unknown Skill",
    skillImg     : (skillItem?.img || GP("img","") || "").toString(),
    listType     : selectedSkillMeta?.listType || "",

    isCheck      : !!GP("isCheck", false),
    isSpell      : !!GP("isSpell", false),
    isOffSpell   : !!GP("isOffensiveSpell", false),
    rolledAtr1   : (GP("rolled_atr1", null) || "").toString().toUpperCase(),
    rolledAtr2   : (GP("rolled_atr2", null) || "").toString().toUpperCase(),
    checkBonus   : Number(GP("check_bonus", 0)) || 0,

    damageBonus  : dmgParsed.value,
    damageBonusProvided: dmgParsed.provided,
    damageBonusRaw: dmgRaw,
    typeDamageTxt: (GP("type_damage", "physical") || "").toString().trim(),
    flatBonus    : Number(GP("bonus", 0)) || 0,
    reduction    : Number(GP("reduction", 0)) || 0,
    multiplier   : Number(GP("multiplier", 100)) || 100,

    skillRange   : (GP("skill_range", "") || "").toString(),
    rawEffectHTML: GP("description", "") || "",
    weaponType   : (GP("weapon_type", "") || "").toString().toLowerCase(),
    skillTypeRaw : (GP("skill_type","") || "").toString().trim(),
    skillTargetRaw: (GP("skill_target","") || "").toString().trim()
  };

  const animTimingModeRaw   = GP("animation_damage_timing_options", "default");
  const animTimingOffsetRaw = GP("animation_damage_timing_offset", 0);
  const animTimingMode = String(animTimingModeRaw ?? "default").trim().toLowerCase();
  const animTimingOffset = (() => {
    const n = Number(animTimingOffsetRaw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();

  const ignoreHR = !!GP("ignore_hr", false);

  // NEW: Fetch + convert rich text scripts
  const animationScriptRaw = _toScript(GP("animation_script", ""));
  const customLogicActionRaw = _toScript(GP("custom_logic_action", ""));
  const customLogicResolutionRaw = _toScript(GP("custom_logic_resolution", ""));

  _adfLog("RichText scripts (Normal skill)", {
    executionMode: executionModeSeed,
    isAutoPassiveExecution,

    animationScriptLen: animationScriptRaw.length,
    customLogicActionLen: customLogicActionRaw.length,
    customLogicResolutionLen: customLogicResolutionRaw.length,
    customLogicActionPreview: customLogicActionRaw.slice(0, 140),
    customLogicResolutionPreview: customLogicResolutionRaw.slice(0, 140),
    skillTypeRaw: dataCore.skillTypeRaw,
    skillTargetRaw: dataCore.skillTargetRaw,
    preselectVia
  });

  const targets = Array.isArray(PAYLOAD.targets)
    ? PAYLOAD.targets
    : Array.from(game.user?.targets ?? []).map(t => t.document?.uuid).filter(Boolean);

  const computeMacro = game.macros.getName(COMPUTE_MACRO_NAME);
  if (!computeMacro) return ui.notifications.error(`Macro "${COMPUTE_MACRO_NAME}" not found or no permission.`);

  try {
    const _ADF_DT = ((typeof performance !== "undefined" && performance?.now) ? performance.now() : Date.now()) - _ADF_T0;
    _adfLog("END (handoff)", {
      msSinceStart: Math.round(_ADF_DT),
      next: COMPUTE_MACRO_NAME,
      ownerUserId: resolvedOwnerUserId,
      executionMode: executionModeSeed,
      isAutoPassiveExecution,
      skillTypeRaw: dataCore.skillTypeRaw,
      skillTargetRaw: dataCore.skillTargetRaw,
      originalTargetUUIDs: seededOriginalTargetUUIDs,
      originalTargetActorUUIDs: seededOriginalTargetActorUUIDs
    });
  } catch {}

  return await computeMacro.execute({
    __AUTO: true,
    __PAYLOAD: {
      source            : "Skill",
      executionMode     : executionModeSeed,
      autoPassive       : isAutoPassiveExecution,
      attackerActorUuid : useActor?.uuid ?? null,
      dataCore,
      ignoreHR,
      skillUuid         : skillItem?.uuid ?? null,
      listType          : selectedSkillMeta?.listType || inferListTypeFromItem(skillItem),
      animTimingMode,
      animTimingOffset,
      animationScriptRaw,
      targets,
      originalTargetUUIDs     : [...seededOriginalTargetUUIDs],
      originalTargetActorUUIDs: [...seededOriginalTargetActorUUIDs],

      // NEW: Custom logic scripts (clean JS text)
      customLogicActionRaw,
      customLogicResolutionRaw,

      meta: buildForwardMeta()
    }
  });

  return;
})();
