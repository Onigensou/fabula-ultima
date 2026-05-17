// ──────────────────────────────────────────────────────────
//  Universal Damage / Healing / Shield macro – Foundry V12
//  Refactor: Split display to "Create Damage Card" (2025-10-12)
//  Updated: 2025-05-16 – fixes Absorb order-of-operations bug
//  + 2025-08-14 – GM-only collapsible change log (❤️/💙/🛡️)
//  + 2025-08-14 – Sign-based mode: "+N" = recovery, "N" = reduction
//  + 2025-10-03 – Update new Targeting Method
//  + 2025-10-04 – 🧾 Battle Log JSON writer (per-target entries)
//  + 2025-10-05 – 🧾 Log capped at 30, logs even when no effect
//  + 2025-10-05 – 📊 Also updates system.props.battle_log_table (capped 30)
//  + 2025-10-10 – 👤 Attacker/Range/Source (string inputs via payload)
//  + 2025-10-10 – 🤖 Headless mode (AUTO + PAYLOAD) parity with dialog
//  + 2025-10-10 – 🛡️ Standalone-safe shims for AUTO/PAYLOAD
//  + 2025-10-10 – 💬 Per-target ChatMessage moved out (now in Create Damage Card)
//  + 2025-10-12 – 🎵 Effectiveness SFX restored (VU/RS/IM/AB mapping)
//  + 2025-11-14 – 🎬 Custom Skill animations delegated to ActionAnimationHandler
//  + 2026-02-11 – ✅ Ordered Damage Computation (Steps 0–8), crit bonus/mult, breakdown log
//  + 2026-03-15 – 🪄 Forward skillTypeRaw / spell flag into Create Damage Card payload for reaction/passive checks
// ──────────────────────────────────────────────────────────

const CREATE_CARD_MACRO_NAME  = "Create Damage Card";      // ← ensure this matches exactly
const ACTION_ANIM_MACRO_NAME  = "ActionAnimationHandler";  // ← external animation handler macro name

// 🎵 Centralized SFX map (edit to your paths once and forget)
const SFX = {
  baseHit   : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/HitSlashM.wav",
  heal      : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Heal3.ogg",
  mpSpend   : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dispel%20Magic.ogg",
  mpAbsorb  : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/AbsorbElement.ogg",
  super     : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Hit_SlashingB.wav",
  resist    : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Parry.ogg",
};

return (async () => {
/* =========================== Safe headless shims ========================== */
let AUTO = false, PAYLOAD = {};
if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

// Normalizer for external strings
const _str = (v, d="None") => {
  const s = (v ?? "").toString().trim();
  return s.length ? s : d;
};

// External context (optional)
const EXT_ATTACKER_NAME = _str(PAYLOAD.attackerName ?? PAYLOAD.attacker, "None");
const EXT_ATTACK_RANGE  = _str(PAYLOAD.attackRange, "None");
const EXT_SOURCE_TYPE   = _str(PAYLOAD.sourceType, "None");

// Optional: full ActionDataComputation payload carried from the Action Card
const ACTION_CONTEXT   = PAYLOAD.actionContext ?? null;
const ACTION_CARD_MSG  = PAYLOAD.actionCardMsgId ?? null;

// Damage Card batching.
// This is created by ActionExecutionCore and passed through AdvanceDamage.
// Fallbacks are included so old/manual calls still behave normally.
const DAMAGE_BATCH_ID = String(
  PAYLOAD.damageBatchId ??
  PAYLOAD?.meta?.damageBatchId ??
  ACTION_CONTEXT?.damageBatchId ??
  ACTION_CONTEXT?.meta?.damageBatchId ??
  ""
).trim();

// BattleLog batching.
// Uses the same ID as Damage Card batching so the visual card and BattleLog
// flush together at the end of the full action/passive/reaction chain.
const BATTLE_LOG_BATCH_ID = String(
  PAYLOAD.battleLogBatchId ??
  PAYLOAD.damageBatchId ??
  PAYLOAD?.meta?.battleLogBatchId ??
  PAYLOAD?.meta?.damageBatchId ??
  ACTION_CONTEXT?.battleLogBatchId ??
  ACTION_CONTEXT?.damageBatchId ??
  ACTION_CONTEXT?.meta?.battleLogBatchId ??
  ACTION_CONTEXT?.meta?.damageBatchId ??
  ""
).trim();

function getBattleLogBatchApi() {
  return (
    globalThis.FUCompanion?.api?.battleLogBatch ??
    game.modules?.get?.("fabula-ultima-companion")?.api?.battleLogBatch ??
    null
  );
}

// Helpful: attackerUuid for portrait resolution / traceability
const ACTION_ATTACKER_UUID =
  _str(ACTION_CONTEXT?.meta?.attackerUuid ?? PAYLOAD.attackerUuid ?? "", "");

// Preserve original action skill typing for downstream damage/reaction/passive checks.
// Important: sourceType may still be "Skill" for spells, so downstream logic should
// use skillTypeRaw / isSpellish when it needs to know whether the triggering action
// was specifically a Spell.
const ACTION_SKILL_TYPE_RAW = _str(
  ACTION_CONTEXT?.core?.skillTypeRaw ??
  ACTION_CONTEXT?.dataCore?.skillTypeRaw ??
  ACTION_CONTEXT?.meta?.skillTypeRaw ??
  ACTION_CONTEXT?.sourceItem?.system?.props?.skill_type ??
  PAYLOAD.skillTypeRaw ??
  PAYLOAD.skill_type ??
  "",
  ""
);

const ACTION_SKILL_TYPE_NORM = String(ACTION_SKILL_TYPE_RAW || "").trim().toLowerCase();
const ACTION_IS_SPELLISH = !!(
  ACTION_SKILL_TYPE_NORM === "spell" ||
  ACTION_CONTEXT?.dataCore?.isSpell ||
  ACTION_CONTEXT?.meta?.isSpellish ||
  PAYLOAD.isSpell ||
  PAYLOAD.isSpellish
);

// Animation pre-check.
// Purpose:
// - Avoid calling ActionAnimationHandler when there is no real animation script.
// - This saves a macro execution and target normalization work for normal/basic actions.
function plainTextForAnimationPrecheck(raw = "") {
  return String(raw ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function getAnimationScriptRawForPrecheck(payload = {}, actionContext = null) {
  const candidates = [
    payload?.animationScriptRaw,
    payload?.animationScript,

    payload?.advPayload?.animationScriptRaw,
    payload?.advPayload?.animationScript,

    payload?.meta?.animationScriptRaw,
    payload?.meta?.animationScript,

    actionContext?.animationScriptRaw,
    actionContext?.animationScript,

    actionContext?.advPayload?.animationScriptRaw,
    actionContext?.advPayload?.animationScript,

    actionContext?.meta?.animationScriptRaw,
    actionContext?.meta?.animationScript
  ];

  for (const value of candidates) {
    const raw = String(value ?? "").trim();
    if (raw) return raw;
  }

  return "";
}

function getAnimationPrecheck(payload = {}, actionContext = null) {
  const raw = getAnimationScriptRawForPrecheck(payload, actionContext);
  const plain = plainTextForAnimationPrecheck(raw);

  if (!plain) {
    return {
      hasRunnableScript: false,
      reason: "empty_animation_script",
      rawLength: raw.length,
      plainLength: plain.length
    };
  }

  if (/insert your sequencer animation here/i.test(plain)) {
    return {
      hasRunnableScript: false,
      reason: "placeholder_animation_script",
      rawLength: raw.length,
      plainLength: plain.length
    };
  }

  return {
    hasRunnableScript: true,
    reason: "has_animation_script",
    rawLength: raw.length,
    plainLength: plain.length
  };
}


// NEW: Accuracy (store as string; '-' if this action has no accuracy check)
const EXT_ACCURACY = (() => {
  const acc = ACTION_CONTEXT?.accuracy ?? null;
  if (!acc) return "-";
  const total = acc.total ?? null;
  return (total === null || total === undefined) ? "-" : String(total);
})();


// For backward compatibility with existing log fields
const sourceName = EXT_ATTACKER_NAME;
const sourceDisp = "neutral";

/* ========================= Target resolution =========================== */

// Headless override: accept explicit target token IDs from payload to avoid UI targeting.
let targets = [];
if (AUTO && Array.isArray(PAYLOAD.targetIds) && PAYLOAD.targetIds.length) {
  // Preserve duplicate target ids per slot — Protect-style redirects can
  // legitimately put the same reactor in the array twice (RAW: "if the
  // danger already affected you, it affects you twice"). The old code
  // wrapped PAYLOAD.targetIds in a Set, collapsing duplicates and dropping
  // one hit. Resolve by id, then preserve the per-slot order.
  const byId = new Map();
  for (const t of (canvas.tokens?.placeables ?? [])) {
    if (t?.id) byId.set(t.id, t);
    if (t?.document?.id) byId.set(t.document.id, t);
  }
  targets = PAYLOAD.targetIds
    .map((id) => byId.get(id) ?? null)
    .filter(Boolean);
} else {
  const foundryTargets   = Array.from(game.user?.targets ?? []);
  const selectedTokens   = canvas.tokens?.controlled ?? [];
  const usingFoundryTargets = foundryTargets.length > 0;
  targets = usingFoundryTargets ? foundryTargets : selectedTokens;
}

if (!targets || targets.length === 0) {
  ui.notifications.warn("No targets provided/selected.");
  return;
}

// Tracks whether a per-Skill custom animation actually ran during this macro call.
// When true, APPLY will skip default impact FX + SFX but still show floating numbers.
let fuSkillAnimationUsed = false;

// If this call came from the Action System (AUTO), delegate animation handling
// to the external "ActionAnimationHandler" macro — but only if the action
// actually has a runnable animation script.
if (AUTO) {
  const animPrecheck = getAnimationPrecheck(PAYLOAD, ACTION_CONTEXT);

  if (!animPrecheck.hasRunnableScript) {
    console.debug("[AdvanceDamage] Animation pre-check skipped ActionAnimationHandler.", {
      reason: animPrecheck.reason,
      rawLength: animPrecheck.rawLength,
      plainLength: animPrecheck.plainLength,
      skillName:
        PAYLOAD?.skillName ??
        ACTION_CONTEXT?.core?.skillName ??
        ACTION_CONTEXT?.dataCore?.skillName ??
        null
    });
  } else {
    const ACTION_ANIM_MACRO = game.macros.getName(ACTION_ANIM_MACRO_NAME);

    if (!ACTION_ANIM_MACRO) {
      console.warn(`[AdvanceDamage] Animation macro "${ACTION_ANIM_MACRO_NAME}" not found. Using default FX/timing.`);
    } else {
      try {
        const animResult = await ACTION_ANIM_MACRO.execute({
          __AUTO: true,
          __PAYLOAD: {
            ...PAYLOAD,
            targets
          }
        });

        fuSkillAnimationUsed = !!animResult;
      } catch (err) {
        console.error("[AdvanceDamage] Error while running ActionAnimationHandler:", err);
      }
    }
  }
}

/* ========================= Mappings & helpers ========================== */
const elementMapping = {
  physical: "affinity_1", air: "affinity_2", bolt: "affinity_3", dark: "affinity_4",
  earth: "affinity_5", fire: "affinity_6", ice: "affinity_7", light: "affinity_8", poison: "affinity_9",
};
const CAP = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Step 4 optimization: yield between multi-target processing.
// This lets the browser/Foundry breathe between targets instead of doing
// all actor updates + FX + damage-card captures in one uninterrupted chain.
const TARGET_LOOP_YIELD_ENABLED = true;
const TARGET_LOOP_YIELD_MIN_TARGETS = 2;
const TARGET_LOOP_YIELD_EVERY = 1; // 1 = after every target except the last

function waitAfterNextPaint() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
      return;
    }

    setTimeout(resolve, 0);
  });
}

async function maybeYieldBetweenTargets({
  index = 0,
  total = 0,
  label = "AdvanceDamage"
} = {}) {
  if (!TARGET_LOOP_YIELD_ENABLED) return;
  if (total < TARGET_LOOP_YIELD_MIN_TARGETS) return;

  const completed = Number(index) + 1;

  // Do not yield after the final target.
  if (completed >= total) return;

  if (TARGET_LOOP_YIELD_EVERY > 1 && completed % TARGET_LOOP_YIELD_EVERY !== 0) {
    return;
  }

  const started = performance.now?.() ?? Date.now();

  await waitAfterNextPaint();

  const ended = performance.now?.() ?? Date.now();

  console.debug("[AdvanceDamage] Yielded between targets.", {
    label,
    completed,
    total,
    waitedMs: Math.round((ended - started) * 100) / 100
  });
}

/* ===================== Damage Computation (Steps 0–8) =====================

ORDERING RULE: FLAT before MULTIPLIER

0) base damage (from action)
1) + flat outgoing bonuses (attacker)
2) * outgoing % bonuses (attacker)
3) - flat reductions (target)
4) * target % reductions / receiving mods (target)
5) + crit flat bonus (if crit)
6) * crit multiplier (if crit)
7) clamp
8) output finalPreAffinityDamage + breakdown

Step 9 (kept separate, after this):
- weapon efficiency + affinity + status-based forced vulnerability mapping
---------------------------------------------------------------------------- */

const SHEET_KEYS = {
  // Target receiving (your current sheet sample already uses these patterns)
  targetFlatAll: "damage_receiving_mod_all",
  targetPctAll : "damage_receiving_percentage_all",

  // Crit fields (new on attacker sheet)
  critFlat: "critical_damage_bonus",
  critMult: "critical_damage_multiplier",

  // Attacker outgoing (placeholder names; safe if missing => 0)
  attackerFlatAll: "damage_outgoing_mod_all",
  attackerPctAll : "damage_outgoing_percentage_all",
};

const _num = (v, d=0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function getProp(actorProps, key, fallback=0) {
  if (!actorProps) return fallback;
  return _num(actorProps[key], fallback);
}

function getTargetFlatReduction(actorProps, elementType) {
  const all = getProp(actorProps, SHEET_KEYS.targetFlatAll, 0);
  const el  = elementType && elementType !== "elementless"
    ? getProp(actorProps, `damage_receiving_mod_${elementType}`, 0)
    : 0;
  return all + el;
}

function getTargetPctMultiplier(actorProps, elementType) {
  // Stored as percentage numbers (example: 0, 10, 25)
  // Interpret as “reduce damage by X%” => multiplier = 1 - X/100
  const all = getProp(actorProps, SHEET_KEYS.targetPctAll, 0);
  const el  = elementType && elementType !== "elementless"
    ? getProp(actorProps, `damage_receiving_percentage_${elementType}`, 0)
    : 0;

  const totalPct = all + el;
  return Math.max(0, 1 - (totalPct / 100));
}

function getAttackerFlatOutgoing(actorProps, elementType) {
  // Safe placeholders: if your sheet doesn’t have these keys yet, they read as 0.
  const all = getProp(actorProps, SHEET_KEYS.attackerFlatAll, 0);
  const el  = elementType && elementType !== "elementless"
    ? getProp(actorProps, `damage_outgoing_mod_${elementType}`, 0)
    : 0;
  return all + el;
}

function getAttackerPctOutgoingMultiplier(actorProps, elementType) {
  // Interpret as “increase damage by X%” => multiplier = 1 + X/100
  const all = getProp(actorProps, SHEET_KEYS.attackerPctAll, 0);
  const el  = elementType && elementType !== "elementless"
    ? getProp(actorProps, `damage_outgoing_percentage_${elementType}`, 0)
    : 0;

  const totalPct = all + el;
  return Math.max(0, 1 + (totalPct / 100));
}

function computePreAffinityDamage({
  baseDamage,
  actionBonusFlat,
  actionOutgoingMultiplierDec, // decimal (ex: 1.25)
  actionReductionFlat,
  attackerProps,
  targetProps,
  elementType,
  isCrit,
  clampMin = 0,
  clampMin1 = false,
  ignoreDR = false,
}) {
  const log = [];
  let x = _num(baseDamage, 0);
  log.push({ step: 0, label: "Base", value: x });

  // 1) outgoing flat (attacker + action bonus compatibility)
  const attackerFlat = getAttackerFlatOutgoing(attackerProps, elementType);
  const outgoingFlat = _num(actionBonusFlat, 0) + attackerFlat;
  x = x + outgoingFlat;
  log.push({ step: 1, label: "Outgoing Flat", add: outgoingFlat, value: x });

  // 2) outgoing % (action multiplier + attacker outgoing %)
  const actionMult = Math.max(0, _num(actionOutgoingMultiplierDec, 1));
  const attackerMult = getAttackerPctOutgoingMultiplier(attackerProps, elementType);
  const outgoingMult = actionMult * attackerMult;
  x = x * outgoingMult;
  log.push({ step: 2, label: "Outgoing %", mult: outgoingMult, value: x });

  // 3) target flat reductions
  const targetFlat = ignoreDR
    ? 0
    : (getTargetFlatReduction(targetProps, elementType) + _num(actionReductionFlat, 0));
  x = x - targetFlat;
  log.push({ step: 3, label: "Target Flat Reduction", sub: targetFlat, value: x });

  // 4) target % reductions / receiving mods
  const targetMult = ignoreDR ? 1 : getTargetPctMultiplier(targetProps, elementType);
  x = x * targetMult;
  log.push({ step: 4, label: "Target % Mod", mult: targetMult, value: x });

  // 5) crit flat
  const critFlat = isCrit ? getProp(attackerProps, SHEET_KEYS.critFlat, 0) : 0;
  x = x + critFlat;
  log.push({ step: 5, label: "Crit Flat Bonus", add: critFlat, value: x });

  // 6) crit multiplier
  const critMult = isCrit ? Math.max(0, getProp(attackerProps, SHEET_KEYS.critMult, 1)) : 1;
  x = x * critMult;
  log.push({ step: 6, label: "Crit Multiplier", mult: critMult, value: x });

  // 7) clamp
  let min = clampMin1 ? 1 : clampMin;
  min = _num(min, 0);
  x = Math.max(x, min);
  log.push({ step: 7, label: "Clamp", min, value: x });

  // 8) final (pre-affinity)
  const finalPreAffinity = Math.ceil(x);
  log.push({ step: 8, label: "Final Pre-Affinity (ceil)", value: finalPreAffinity });

  return { finalPreAffinity, breakdown: log };
}

/* ============================ Core executor ============================ */
async function APPLY(opts) {
  // Parse sign-based base value ("+10" heals; "10" damages)
  const rawBase     = String(opts.baseValue ?? "0").trim();
  const isRecovery  = rawBase.startsWith("+");
  const baseNumRaw  = parseInt(rawBase.replace("+","")) || 0;

  const reduction   = Number(opts.reduction ?? 0);
  const bonus       = Number(opts.bonus ?? 0);
  const multiplier  = Number(opts.multiplier ?? 100) / 100; // decimal

  const weaponType      = String(opts.weaponType ?? "none_ef");
  const elementType     = String(opts.elementType ?? "elementless");
  const valueType       = String(opts.valueType ?? "hp");
  const targetAffinity  = String(opts.targetAffinity ?? "neutral");
  const ignoreDR        = !!opts.ignoreDamageReduction;
  const ignoreShield    = !!opts.ignoreShield;

  // NEW: attacker actor resolve (for outgoing + crit bonuses)
  const attackerUuid = String(opts.attackerUuid ?? ACTION_ATTACKER_UUID ?? "");
  let attackerActor = null;
  try {
    if (attackerUuid) attackerActor = await fromUuid(attackerUuid);
  } catch (e) {
    console.warn("[AdvanceDamage] Could not resolve attackerUuid:", attackerUuid, e);
  }
  const attackerProps = attackerActor?.actor?.system?.props ?? attackerActor?.system?.props ?? null;

  // NEW: crit flag (safe default false)
  const isCrit = !!(opts.isCrit ?? ACTION_CONTEXT?.isCrit ?? ACTION_CONTEXT?.crit ?? false);

  const baseChangeKey   = valueType + (isRecovery ? "Recovery" : "Reduction");

  // Collectors for Battle Log (centralized macro stays the same)
  const battleLogEntries = [];
  const tableRows        = [];

  // Resolve display macro once
  const CREATE_CARD = game.macros.getName(CREATE_CARD_MACRO_NAME);
  if (!CREATE_CARD) console.warn(`[ADV-DMG] Display macro "${CREATE_CARD_MACRO_NAME}" not found. Cards will be skipped.`);

  const weaponKey  = String(weaponType || "").split("_")[0];
  const weaponNice = (weaponType !== "none_ef" && weaponKey) ? `${weaponKey.toLowerCase()} weapon` : "";

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
  const target = targets[targetIndex];
    const actorData = target.actor.system.props;

    // Starting stats
    const startHP     = Number(actorData.current_hp);
    const startMP     = Number(actorData.current_mp);
    const startShield = Number(actorData.shield_value) || 0;

    let postHP     = startHP;
    let postMP     = startMP;
    let postShield = startShield;

    // Base numeric magnitude
    let baseValue = baseNumRaw;

    // %-based targeting
    if (targetAffinity === "percentMax") {
      baseValue = Math.ceil(actorData.max_hp * (baseValue / 100));
    } else if (targetAffinity === "percentCurrent") {
      baseValue = Math.ceil(actorData.current_hp * (baseValue / 100));
    }

    // Default (non-HP paths keep legacy behavior)
    let finalValue = Math.ceil(Math.max(baseValue - reduction + bonus, 0) * multiplier);

    // NEW: breakdown container (only filled for HP damage path)
    let preAffinityBreakdown = null;

    let shieldBreak = false;
    let affinity;
    let currentChangeKey = baseChangeKey;
    let weaponEfficiencyUsed = 100;

    const startingShield = startShield;

    // HP damage path: NEW ordered Steps 0–8 first, Step 9 after
    if (currentChangeKey === "hpReduction") {
      // Step 0–8: compute sheet-aware damage BEFORE efficiency/affinity
      const { finalPreAffinity, breakdown } = computePreAffinityDamage({
        baseDamage: baseValue,
        actionBonusFlat: bonus,
        actionOutgoingMultiplierDec: multiplier,
        actionReductionFlat: reduction,
        attackerProps,
        targetProps: actorData,
        elementType,
        isCrit,
        clampMin: 0,
        clampMin1: false,
        ignoreDR,
      });

      finalValue = finalPreAffinity;
      preAffinityBreakdown = breakdown;

      // Step 9a: Weapon efficiency (kept as-is)
      weaponEfficiencyUsed = Number(actorData[weaponType] || 100);
      finalValue = Math.ceil(finalValue * (weaponEfficiencyUsed / 100));

      // Step 9b: Affinity (+ forced Vulnerable from conditions) (kept as-is)
      affinity = actorData[elementMapping[elementType]];
      const conditions = target.actor.effects.map(e => e.label);
      const condVU = { Wet:"bolt", Oil:"fire", Petrify:"earth", Hypothermia:"ice", Turbulence:"air", Zombie:"light" };
      for (const [cond, el] of Object.entries(condVU)) {
        if (conditions.includes(cond) && elementType === el) affinity = "VU";
      }
      switch (affinity) {
        case "RS": finalValue = Math.ceil(finalValue / 2); break;
        case "VU": finalValue = Math.ceil(finalValue * 2); break;
        case "IM": finalValue = 0; break;
        case "AB": finalValue = -Math.ceil(finalValue); currentChangeKey = "hpRecovery"; break;
      }
    }

    // Apply updates
    switch (currentChangeKey) {
      case "hpReduction": {
        let shield = startingShield;
        let remainingDamage = finalValue;
        if (!ignoreShield) {
          const shieldDamage = Math.min(shield, remainingDamage);
          shield -= shieldDamage;
          remainingDamage -= shieldDamage;
          if (shield === 0 && startingShield > 0) shieldBreak = true;
        }
        postShield = shield;
        postHP = Math.max(Number(actorData.current_hp) - remainingDamage, 0);
        await target.actor.update({
          "system.props.shield_value": postShield,
          "system.props.current_hp": postHP,
        });
        break;
      }
      case "hpRecovery": {
        const healAmt = Math.abs(finalValue || baseValue);
        postHP = Math.min(Number(actorData.current_hp) + healAmt, Number(actorData.max_hp));
        await target.actor.update({ "system.props.current_hp": postHP });
        break;
      }
      case "mpReduction": {
        const spend = finalValue;
        postMP = Math.max(Number(actorData.current_mp) - spend, 0);
        await target.actor.update({ "system.props.current_mp": postMP });
        break;
      }
      case "mpRecovery": {
        const rec = Math.abs(finalValue || baseValue);
        postMP = Math.min(Number(actorData.current_mp) + rec, Number(actorData.max_mp));
        await target.actor.update({ "system.props.current_mp": postMP });
        break;
      }
      case "shieldReduction": {
        if (finalValue > 0 && startingShield > 0 && startingShield <= finalValue) shieldBreak = true;
        postShield = Math.max(startingShield - finalValue, 0);
        await target.actor.update({ "system.props.shield_value": postShield });
        break;
      }
      case "shieldRecovery": {
        const newShield = Math.max(finalValue, startingShield);
        postShield = newShield;
        await target.actor.update({ "system.props.shield_value": postShield });
        break;
      }
    }

    // FX + Floating number
    const isHeal = currentChangeKey.endsWith("Recovery");
    let effectFile = "";
    let textColor = "#ffffff";
    let damageIcon = "⚔️";
    let audioFile  = "";
    let suppressDefaultAudio = false; // lets IM/AB stay silent

    if (valueType === "hp") {
      if (isHeal) {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Green_400x400.webm";
        textColor = "#00FF00";
        damageIcon = "❤️";
      } else {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_07_Regular_Orange_400x400.webm";
        textColor = "#ffffff";
        if (affinity === "VU") damageIcon = "💥";
        if (affinity === "RS") damageIcon = "🛡️";
      }
    } else if (valueType === "mp") {
      if (isHeal) {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Blue_400x400.webm";
        textColor = "#00ABFF";
        damageIcon = "💧";
        audioFile  = SFX.mpAbsorb;
      } else {
        effectFile = "modules/JB2A_DnD5e/Library/2nd_Level/Misty_Step/MistyStep_01_Regular_Blue_400x400.webm";
        textColor = "#B32EFF";
        damageIcon = "🌀";
        audioFile  = SFX.mpSpend;
      }
    } else {
      if (isHeal) {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Green_400x400.webm";
        textColor = "#00FF00";
        damageIcon = "🛡️";
      } else {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_07_Regular_Orange_400x400.webm";
        textColor = "#ffffff";
        damageIcon = "🛡️";
      }
    }

    // 🎵 Effectiveness-based SFX (HP damage only, non-heal)
    if (valueType === "hp" && !isHeal && affinity) {
      switch (affinity) {
        case "VU": audioFile = SFX.super; break;
        case "RS": audioFile = SFX.resist; break;
        case "IM": suppressDefaultAudio = true; audioFile = ""; break;
        case "AB": suppressDefaultAudio = true; audioFile = ""; break;
      }
    }

    // Fallback SFX (only if not explicitly suppressed)
    if (!audioFile && !suppressDefaultAudio) {
      audioFile = isHeal ? SFX.heal : SFX.baseHit;
    }

    const somethingChanged = (postHP !== startHP) || (postMP !== startMP) || (postShield !== startShield);

    // Show floating numbers whenever something actually changed.
    // If a custom Skill animation ran, we only show numbers here.
    if (somethingChanged) {
      const amountText = `${damageIcon} ${Math.abs(finalValue || baseValue)}`;

      if (fuSkillAnimationUsed) {
        new Sequence()
          .scrollingText()
            .atLocation(target)
            .text(amountText, {
              fill: textColor,
              fontSize: 35,
              fontWeight: "bold",
              lineJoin: "round",
              strokeThickness: 3,
            })
            .duration(1000)
          .play();
      } else {
        if (effectFile) {
          new Sequence()
            .effect()
              .file(effectFile)
              .atLocation(target)
              .scale(0.4)
              .duration(1000)
            .scrollingText()
              .atLocation(target)
              .text(amountText, {
                fill: textColor,
                fontSize: 35,
                fontWeight: "bold",
                lineJoin: "round",
                strokeThickness: 3,
              })
              .duration(1000)
            .play();
        }
        if (audioFile) {
          new Sequence().sound(audioFile).play();
        }
      }
    }

    // ---------- Build Battle Log + Table Row ----------
    const tgtDisp = (target.document.disposition === 1 ? "ally" : target.document.disposition === -1 ? "enemy" : "neutral");
    const affinityToLabel = (a) => {
      if (a === "VU") return "Vulnerable";
      if (a === "RS") return "Resisted";
      if (a === "IM") return "Immune";
      if (a === "AB") return "Absorb";
      return "Neutral";
    };

    // If damage got converted into healing (AB), we STILL want to label it "Absorb".
    // Normal healing spells keep "Neutral" because `affinity` will be undefined in that path.
    const effLabel = (valueType === "hp") ? affinityToLabel(affinity) : "Neutral";

    let noEffectReason = null;
    if (!somethingChanged) {
      if (currentChangeKey === "hpReduction" && affinity === "IM") noEffectReason = "Immune";
      else if (finalValue === 0) noEffectReason = "ReducedToZero";
      else noEffectReason = "NoChange";
    }

    const amtForSummary = Math.abs(finalValue || baseValue);

    const entry = {
      ts: new Date().toISOString(),
      accuracy: EXT_ACCURACY,
      dealer: {
        name: sourceName,
        disposition: sourceDisp,
        range: EXT_ATTACK_RANGE,
        sourceType: EXT_SOURCE_TYPE
      },
      target: { name: target.name, disposition: tgtDisp },
      inputs: {
        rawBase, isRecovery, baseNumRaw, reduction, bonus, multiplier,
        weaponType, elementType, valueType, targetAffinity,
        ignoreDamageReduction: !!ignoreDR,
        ignoreShield: !!ignoreShield,
        attackerUuid,
        isCrit
      },
      computed: {
        baseValue,
        finalValue,
        weaponEfficiencyUsed,
        effectiveness: effLabel,
        preAffinityBreakdown // NEW
      },
      result: {
        hp: { from: startHP, to: postHP },
        mp: { from: startMP, to: postMP },
        shield: { from: startShield, to: postShield },
        shieldBreak, affected: !!somethingChanged, noEffectReason
      }
    };

    // Human summary (kept for logger)
    if (currentChangeKey === "hpReduction") {
      const typeTxt = (valueType === "hp" && elementType !== "elementless") ? `${CAP(elementType)} ` : "";
      entry.summary = `${sourceName} deals ${amtForSummary} ${typeTxt}damage to ${target.name}` +
                      (weaponNice ? ` with a ${weaponNice}` : "") +
                      ` [${effLabel}] [Efficiency: ${Math.round(weaponEfficiencyUsed)}%]`;
    } else if (currentChangeKey === "mpReduction") {
      entry.summary = `${sourceName} deals ${amtForSummary} damage to ${target.name}'s MP`;
    } else if (currentChangeKey === "shieldReduction") {
      entry.summary = `${sourceName} deals ${amtForSummary} damage to ${target.name}'s Shield`;
    } else if (currentChangeKey === "hpRecovery") {
      entry.summary = `${sourceName} heals ${target.name} for ${amtForSummary} HP`;
    } else if (currentChangeKey === "mpRecovery") {
      entry.summary = `${sourceName} restores ${target.name} for ${amtForSummary} MP`;
    } else if (currentChangeKey === "shieldRecovery") {
      entry.summary = `${sourceName} grants ${target.name} ${amtForSummary} Shield`;
    }

    battleLogEntries.push(entry);

    // Table row
    const valueTypeLabel = valueType === "hp" ? "HP" : (valueType === "mp" ? "MP" : "Shield");
    const applyMode = currentChangeKey.endsWith("Reduction") ? "Damage" : "Healing";
    const dmgTypeLabel = (valueType === "hp") ? CAP(elementType) : "—";
    const effPct = (valueType === "hp") ? `${Math.round(weaponEfficiencyUsed)}%` : "100%";

    tableRows.push({
      $deleted: false,
      attacker: sourceName,
      attack_target: target.name,
      accuracy: EXT_ACCURACY,
      value: String(amtForSummary),
      value_type: valueTypeLabel,
      apply_mode: applyMode,
      damage_type: dmgTypeLabel,
      affinity: effLabel,
      efficiency: effPct,
      weapon_type: (weaponType !== "none_ef") ? CAP(weaponType.split("_")[0]) : "—",
      range: EXT_ATTACK_RANGE,
      source_type: EXT_SOURCE_TYPE
    });

    // ---------- Hand off to "Create Damage Card" per target ----------
    if (CREATE_CARD) {
const cardPayload = {
  // Damage Card batch identity.
  // If a batch is open, Create Damage Card.js will capture this payload
  // instead of posting a separate Foundry ChatMessage.
  damageBatchId: DAMAGE_BATCH_ID || null,

  // Attacker / context
  attackerName: sourceName,
  attackerUuid: attackerUuid || ACTION_ATTACKER_UUID,
  attackRange : EXT_ATTACK_RANGE,
  sourceType  : EXT_SOURCE_TYPE,

        // Preserve original action typing explicitly for downstream systems.
        // This is the flattened copy that Create Damage Card / reaction payloads can read
        // without needing to reconstruct from actionContext.
        skillTypeRaw : ACTION_SKILL_TYPE_RAW || null,
        skill_type   : ACTION_SKILL_TYPE_RAW || null,
        isSpellish   : ACTION_IS_SPELLISH,

// keep full upstream payload for inspection / fallback consumers
actionContext : ACTION_CONTEXT,
actionCardMsgId: ACTION_CARD_MSG,

// Small explicit meta object for systems that prefer payload.meta access.
meta: {
  damageBatchId: DAMAGE_BATCH_ID || null
},

        // NEW: debug math breakdown
        preAffinityBreakdown,

        // Target info
        targetName  : target.name,
        targetUuid  : target.document?.uuid ?? null,

        // Inputs + computed (compact set that a card needs)
        valueType,
        changeKey: currentChangeKey,
        elementType,
        weaponType,
        weaponEfficiencyUsed,
        affinityCode: affinity ?? "NE",
        effectivenessLabel: effLabel,

        // Amounts
        baseValue,
        finalValue,
        displayedAmount: Math.abs(finalValue || baseValue),

        // Result state
        shieldBreak,
        affected: !!somethingChanged,
        noEffectReason,

        // For GM whisper log (needs both pre/post)
        gmChanges: {
          hp   : { from: startHP, to: postHP },
          mp   : { from: startMP, to: postMP },
          shield: { from: startShield, to: postShield },
        }
      };

      try {
        await CREATE_CARD.execute({ __AUTO: true, __PAYLOAD: cardPayload });
      } catch (e) {
        console.warn("[ADV-DMG] Create Damage Card failed:", e);
      }
    }

    await maybeYieldBetweenTargets({
      index: targetIndex,
      total: targets.length,
      label: "AdvanceDamage target loop"
    });
  } // for targets

  // Persist BattleLog.
  // If this AdvanceDamage call belongs to a Damage Card batch, capture the log
  // and let battle-log-batch-manager flush it once at the end of the full chain.
  // If this is a manual/standalone AdvanceDamage call with no batchId, fall back
  // to immediate BattleLog: Append behavior.
  try {
    if (battleLogEntries.length || tableRows.length) {
      const battleLogBatchApi = getBattleLogBatchApi();

      if (battleLogBatchApi?.captureOrAppend) {
        const result = await battleLogBatchApi.captureOrAppend({
          batchId: BATTLE_LOG_BATCH_ID || null,
          damageBatchId: DAMAGE_BATCH_ID || null,
          entries: battleLogEntries,
          rows: tableRows,
          source: "AdvanceDamage",
          immediateIfNoBatch: true
        });

        if (!result?.ok) {
          console.warn("[ADV-DMG] BattleLog batch capture/append failed.", result);
        }
      } else {
        // Safety fallback if the module API is missing.
        const LOGGER = game.macros.getName("BattleLog: Append");

        if (!LOGGER) {
          console.warn("[ADV-DMG] Logger not found. Is the macro named exactly 'BattleLog: Append'?");
        } else {
          await LOGGER.execute({
            __AUTO: true,
            __PAYLOAD: {
              entries: battleLogEntries,
              rows: tableRows
            }
          });
        }
      }
    }
  } catch (err) {
    console.warn("[ADV-DMG] Failed to capture/append BattleLog:", err);
  }
} // APPLY

/* ============================== Dialog UI (unchanged) ============================== */
const targetList = targets.map(t => {
  const disp = t.document.disposition;
  const colour = disp === 1 ? "blue" : disp === -1 ? "red" : "yellow";
  return `<span style='color:${colour}; font-weight:bold;'>${t.actor.name}</span>`;
}).join(", ");

const attackerDisplay = `
  <fieldset>
    <legend><b>Attacker:</b></legend>
    <p style="margin:.25rem 0 .25rem;">
      <span style="font-weight:bold; color:#9c6a2b;">${sourceName}</span>
    </p>
    <p style="margin:.25rem 0 0; font-size:12px; opacity:.85;">
      <b>Range:</b> ${EXT_ATTACK_RANGE} &nbsp;•&nbsp; <b>Source:</b> ${EXT_SOURCE_TYPE}
    </p>
  </fieldset>
`;
const targetDisplay = `<fieldset><legend><b>Target(s):</b></legend><p>${targetList}</p></fieldset>`;

const dialogContent = /* html */ `
  <fieldset>
    <legend><b>Attacker & Context</b></legend>
    <div style="margin:.25rem 0 .25rem;"><b>Attacker:</b> <span style="font-weight:bold; color:#9c6a2b;">${sourceName}</span></div>
    <div style="font-size:12px; opacity:.85;"><b>Range:</b> ${EXT_ATTACK_RANGE} &nbsp;•&nbsp; <b>Source:</b> ${EXT_SOURCE_TYPE}</div>
  </fieldset>
  ${targetDisplay}
  <form>
    <fieldset>
      <legend><b>Value & Modifiers</b></legend>
      <div class='form-group'>
        <label>Base Value <small>(use + for recovery, e.g. +10)</small>:</label>
        <input type='text' id='baseValue' value='0' />
      </div>
      <div class='form-group' style='display:flex;gap:10px;'>
        <div><label>Reduction:</label><input type='number' id='damageReduction' value='0' /></div>
        <div><label>Bonus:</label><input type='number' id='damageBonus' value='0' /></div>
        <div><label>Multiplier (%):</label><input type='number' id='damageMultiplier' value='100' /></div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Value Type:</legend>
      <table>
        <tr>
          <td><input type='radio' name='valueType' value='hp' checked /> <span style='color:red'>HP</span></td>
          <td><input type='radio' name='valueType' value='mp' /> <span style='color:blue'>MP</span></td>
          <td><input type='radio' name='valueType' value='shield' /> <span style='color:#404040'>Shield</span></td>
        </tr>
      </table>
    </fieldset>

    <fieldset>
      <legend>Weapon Category:</legend>
      <table>
        <tr><td><input type='radio' name='weaponType' value='none_ef' checked> 🚫 None</td></tr>
        <tr>
          <td><input type='radio' name='weaponType' value='arcane_ef'> Arcane</td>
          <td><input type='radio' name='weaponType' value='bow_ef'> Bow</td>
          <td><input type='radio' name='weaponType' value='brawling_ef'> Brawling</td>
          <td><input type='radio' name='weaponType' value='dagger_ef'> Dagger</td>
        </tr>
        <tr>
          <td><input type='radio' name='weaponType' value='firearm_ef'> Firearm</td>
          <td><input type='radio' name='weaponType' value='flail_ef'> Flail</td>
          <td><input type='radio' name='weaponType' value='heavy_ef'> Heavy</td>
          <td><input type='radio' name='weaponType' value='spear_ef'> Spear</td>
        </tr>
        <tr>
          <td><input type='radio' name='weaponType' value='sword_ef'> Sword</td>
          <td><input type='radio' name='weaponType' value='thrown_ef'> Thrown</td>
        </tr>
      </table>
    </fieldset>

    <fieldset>
      <legend>Element:</legend>
      <table>
        <tr><td><input type='radio' name='elementType' value='elementless' checked> 🚫 None</td></tr>
        <tr>
          <td><input type='radio' name='elementType' value='physical'> Physical</td>
          <td><input type='radio' name='elementType' value='air'> Air</td>
          <td><input type='radio' name='elementType' value='bolt'> Bolt</td>
        </tr>
        <tr>
          <td><input type='radio' name='elementType' value='dark'> Dark</td>
          <td><input type='radio' name='elementType' value='earth'> Earth</td>
          <td><input type='radio' name='elementType' value='fire'> Fire</td>
        </tr>
        <tr>
          <td><input type='radio' name='elementType' value='ice'> Ice</td>
          <td><input type='radio' name='elementType' value='light'> Light</td>
          <td><input type='radio' name='elementType' value='poison'> Poison</td>
        </tr>
      </table>
    </fieldset>

    <fieldset>
      <legend>Target Affinity:</legend>
      <table>
        <tr>
          <td><input type='radio' name='targetAffinity' value='neutral' checked> Neutral</td>
          <td><input type='radio' name='targetAffinity' value='percentMax'> % Max</td>
          <td><input type='radio' name='targetAffinity' value='percentCurrent'> % Current</td>
        </tr>
      </table>
    </fieldset>

    <fieldset>
      <input type='checkbox' name='ignoreDamageReduction' value='true'>Ignore Damage Reduction</input><br/>
      <input type='checkbox' name='ignoreShield' value='true'>Ignore Shield</input>
    </fieldset>
  </form>
`;

if (AUTO) {
  // AUTO: apply directly
  await APPLY({
    baseValue: PAYLOAD.baseValue,
    reduction: PAYLOAD.reduction,
    bonus: PAYLOAD.bonus,
    multiplier: PAYLOAD.multiplier,
    weaponType: PAYLOAD.weaponType,
    elementType: PAYLOAD.elementType,
    valueType: PAYLOAD.valueType,
    targetAffinity: PAYLOAD.targetAffinity,
    ignoreDamageReduction: PAYLOAD.ignoreDamageReduction,
    ignoreShield: PAYLOAD.ignoreShield,

    // NEW: attacker uuid + crit flag passthrough
    attackerUuid: PAYLOAD.attackerUuid ?? ACTION_ATTACKER_UUID,
    isCrit: PAYLOAD.isCrit ?? ACTION_CONTEXT?.isCrit ?? false,
  });
} else {
  new Dialog({
    title: "Damage / Healing / Shield",
    content: dialogContent,
    buttons: {
      apply: {
        label: "Apply",
        callback: async (html) => {
          const opts = {
            baseValue: String(html.find("#baseValue").val() ?? "0").trim(),
            reduction: Number(html.find("#damageReduction").val()),
            bonus: Number(html.find("#damageBonus").val()),
            multiplier: Number(html.find("#damageMultiplier").val()),
            weaponType: html.find("input[name='weaponType']:checked").val(),
            elementType: html.find("input[name='elementType']:checked").val(),
            valueType: html.find("input[name='valueType']:checked").val(),
            targetAffinity: html.find("input[name='targetAffinity']:checked").val(),
            ignoreDamageReduction: !!html.find("input[name='ignoreDamageReduction']:checked").val(),
            ignoreShield: !!html.find("input[name='ignoreShield']:checked").val(),

            // Manual dialog default (no crit unless you later add a checkbox)
            attackerUuid: ACTION_ATTACKER_UUID,
            isCrit: false,
          };
          await APPLY(opts);
        },
      },
      cancel: { label: "Cancel" },
    },
  }).render(true);
}
})();
