// ============================================================================
// scripts/apply-damage-core.js
// Universal Damage API  —  FUCompanion.api.applyDamage
// ============================================================================
//
// ── ARCHITECTURE NOTE (Strangler Fig Pattern) ────────────────────────────────
//
// This file is the NEW universal entry point for dealing damage / healing in
// the game.  It runs ALONGSIDE the old "AdvanceDamage" macro without touching
// it — both can coexist indefinitely.
//
// The migration strategy is:
//   OLD path  →  AdvanceDamage macro (called from Action Pipeline, skill cards)
//                Do NOT change these callers yet.  They work fine as-is.
//
//   NEW path  →  FUCompanion.api.applyDamage.applyToActor()
//                Use this for every NEW system you build:
//                passive damage, tile effects, reactions, item triggers, etc.
//
// Over time, when confidence is high, old callers can be migrated one-by-one.
// Until then: if in doubt, use the NEW API for anything you write today.
//
// ── WHY A SEPARATE API INSTEAD OF EDITING AdvanceDamage? ─────────────────────
//
// AdvanceDamage is wired into dozens of in-game macros and action cards.
// A wrong edit breaks combat for everyone immediately.  The new API is isolated:
// a bug here only affects callers that explicitly use it, so failures are
// contained and rollback is easy.
//
// ── SHEET KEY MAPPING (custom-system-builder, actor.system.props) ─────────────
//
// This file is the single source of truth for prop key names.
// If a key ever changes on the sheet, fix it HERE only.
//
//   Attacker outgoing flat bonus:
//     extra_damage_mod_all
//     extra_damage_mod_melee / _ranged / _spell
//     extra_damage_mod_{element}     (physical/air/bolt/dark/earth/fire/ice/light/poison)
//     extra_damage_mod_{weaponKey}   (arcane/bow/brawling/dagger/firearm/flail/heavy/spear/sword/thrown)
//     extra_damage_mod_item          (consumable use — needs opts.isItem, not a weaponKey)
//
//   Target incoming flat reduction:
//     damage_receiving_mod_all
//     damage_receiving_mod_melee / damage_receiving_mod_range  (note: "range" not "ranged")
//     damage_receiving_mod_{element}
//
//   Target incoming % reduction:
//     damage_receiving_percentage_all
//     damage_receiving_percentage_melee / damage_receiving_percentage_range
//     damage_receiving_percentage_{element}   (stored as "0%" string — handled automatically)
//
//   Crit:      critical_damage_bonus, critical_damage_multiplier
//   Affinity:  affinity_1 … affinity_9  (physical → poison, see ELEMENT_AFFINITY_KEY below)
//   Class affinity (FLAGS): flags["fabula-ultima-companion"].affinity_class_{strike,magic}
//                          ("" | "RS" | "VU" | "IM" | "AB")
//   Universal multiplier (FLAG): flags["fabula-ultima-companion"].damage_taken_mult
//                                (number, default 1.0)
//   HP/MP/Shield: current_hp, max_hp, current_mp, max_mp, shield_value
//   Weapon efficiency: {weaponKey}_ef  (e.g. sword_ef — value 100 = full efficiency)
//
// ── DAMAGE PIPELINE (Steps 0–9) ──────────────────────────────────────────────
//
//   0  Base damage (raw number)
//   1  + Outgoing flat bonus   (action bonus + all attacker sheet modifiers)
//   2  × Outgoing % multiplier (action multiplier × sheet %, sheet not wired yet)
//   3  − Target flat reduction (sheet modifiers, skipped if ignoreDR)
//   4  × Target % reduction    (sheet modifiers, skipped if ignoreDR)
//   5  + Crit flat bonus       (attacker sheet, only if isCrit)
//   6  × Crit multiplier       (attacker sheet, only if isCrit)
//   7  Clamp to 0
//   8  ceil → finalPreAffinity
//   9a × Weapon efficiency     (target sheet, e.g. sword_ef)
//   9b Element affinity        (RS ÷2, VU ×2, IM →0, AB →healing)
//       + condition-forced VU  (Wet/Oil/Petrify/Hypothermia/Turbulence/Zombie)
//   9c Damage-class affinity   (affinity_class_strike / affinity_class_magic;
//                               same RS/VU/IM/AB semantics; HP-damage only)
//   9d Damage-taken multiplier (props.damage_taken_mult, default 1.0;
//                               applies to hp/mp/shield reduction paths)
//
//   Steps 0–8 live in compute() (pure, no side-effects).
//   Step 9 runs inside applyToActor() after compute().
//
// ── PUBLIC API ────────────────────────────────────────────────────────────────
//
//   FUCompanion.api.applyDamage.VERBOSITY
//     Enum of output levels: SILENT / NUMBERS / FX / FULL
//
//   FUCompanion.api.applyDamage.verbosityAtLeast(level, threshold)
//     Returns true when level >= threshold in the ordered scale.
//     Use this in your own code when you need to gate output.
//
//   FUCompanion.api.applyDamage.deriveDamageClass({ damageClass, isSpellish, weaponType })
//     Resolves "strike" (targets DEF), "magic" (targets MDEF), or null (neither).
//     Pass damageClass explicitly to override auto-detection.
//
//   FUCompanion.api.applyDamage.compute(opts)  →  { finalPreAffinity, damageClass, breakdown }
//     Pure math.  Safe to call anywhere for preview / tooltip / dry-run purposes.
//     Does NOT update any actor or emit any output.
//
//   FUCompanion.api.applyDamage.applyToActor(opts)  →  Promise<result>
//     Full pipeline: compute → weapon efficiency → affinity → actor.update()
//     Also emits AV feedback (Sequencer, Damage Card, BattleLog) gated by verbosity.
//     verbosity defaults to "full" — pass verbosity:"silent" if your system
//     handles its own output (e.g. tile effects, passive system).
//
// ── QUICK USAGE EXAMPLE ──────────────────────────────────────────────────────
//
//   // Minimal — deal 10 fire damage to a target actor:
//   await FUCompanion.api.applyDamage.applyToActor({
//     baseDamage:   10,
//     elementType:  "fire",
//     targetActor:  someActor,
//     attackerName: "Lava Floor",
//   });
//
//   // With attacker sheet modifiers + crit + silent output:
//   await FUCompanion.api.applyDamage.applyToActor({
//     baseDamage:    20,
//     elementType:   "physical",
//     weaponType:    "sword_ef",
//     attackRange:   "Melee",
//     isCrit:        true,
//     attackerUuid:  attacker.uuid,   // resolves attackerProps automatically
//     targetActor:   target,
//     targetToken:   targetToken,
//     attackerName:  attacker.name,
//     verbosity:     "silent",        // caller handles its own output
//   });
//
// ============================================================================

(() => {
  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  // ── VERBOSITY ─────────────────────────────────────────────────────
  //   silent  – stat change only
  //   numbers – + floating damage text
  //   fx      – + VFX + SFX
  //   full    – + Damage Card in chat + BattleLog entry  (default)
  const VERBOSITY = Object.freeze({
    SILENT:  "silent",
    NUMBERS: "numbers",
    FX:      "fx",
    FULL:    "full",
  });
  const _VERBOSITY_ORDER = ["silent", "numbers", "fx", "full"];

  function verbosityAtLeast(level, threshold) {
    return _VERBOSITY_ORDER.indexOf(String(level ?? "full").toLowerCase()) >=
           _VERBOSITY_ORDER.indexOf(String(threshold).toLowerCase());
  }

  // ── DAMAGE CLASS ──────────────────────────────────────────────────
  //   "strike" – targets DEF    "magic" – targets MDEF    null – neither
  // Resolution: explicit override → isSpellish → weaponType → null
  function deriveDamageClass({ damageClass, isSpellish = false, weaponType = "none_ef" } = {}) {
    if (damageClass === "strike" || damageClass === "magic") return damageClass;
    if (damageClass === null) return null;
    if (isSpellish) return "magic";
    if (extractWeaponKey(weaponType)) return "strike";
    return null;
  }

  // ── NUMERIC HELPERS ───────────────────────────────────────────────

  // Handles "0%" strings produced by custom-system-builder
  function _num(v, fallback = 0) {
    if (v === null || v === undefined) return fallback;
    const n = Number(String(v).replace(/%/g, "").trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function _prop(props, key, fallback = 0) {
    return props ? _num(props[key], fallback) : fallback;
  }

  const _CAP = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function _affinityLabel(a) {
    if (a === "VU") return "Vulnerable";
    if (a === "RS") return "Resisted";
    if (a === "IM") return "Immune";
    if (a === "AB") return "Absorb";
    return "Neutral";
  }

  // ── KEY DERIVATION ────────────────────────────────────────────────

  // "sword_ef" → "sword",  "none_ef" / "" → null
  function extractWeaponKey(weaponType) {
    const key = String(weaponType ?? "").split("_")[0].toLowerCase();
    return (key && key !== "none") ? key : null;
  }

  // Returns "melee" | "ranged" | null
  function normalizeAttackRange(attackRange) {
    switch (String(attackRange ?? "").toLowerCase().trim()) {
      case "melee":  return "melee";
      case "ranged":
      case "range":  return "ranged";
      default:       return null;
    }
  }

  // ── ATTACKER OUTGOING FLAT ────────────────────────────────────────
  // Sheet keys (actor.system.props):
  //   extra_damage_mod_all
  //   extra_damage_mod_melee / _ranged / _spell
  //   extra_damage_mod_{element}
  //   extra_damage_mod_{weaponKey}
  //   extra_damage_mod_item          (damage dealt by USING a consumable)
  //
  // `item` is its own category, NOT a weaponKey: there is no `item_ef` on the
  // sheet, so it can never arrive through extractWeaponKey — hence the explicit
  // `isItem` flag. The action pipeline already scores this family on its own side
  // (action-profile's `kind === "item"` → skill-formulas' "Damage (Item)", which is
  // how Secret Formula's +4 AE reaches a created item); this flag is what lets the
  // SAME family reach damage that arrives through this core instead, i.e. a
  // consumable's `deal_damage` effect row. Each damage instance is scored once —
  // the two paths handle disjoint numbers, they don't stack on one value.
  function getAttackerFlatOutgoing(attackerProps, { elementType, attackRange, isSpellish, isItem, weaponKey }) {
    if (!attackerProps) return 0;
    let total = _prop(attackerProps, "extra_damage_mod_all");
    const range = normalizeAttackRange(attackRange);
    if (range === "melee")  total += _prop(attackerProps, "extra_damage_mod_melee");
    if (range === "ranged") total += _prop(attackerProps, "extra_damage_mod_ranged");
    if (isSpellish)         total += _prop(attackerProps, "extra_damage_mod_spell");
    if (isItem)             total += _prop(attackerProps, "extra_damage_mod_item");
    if (elementType && elementType !== "elementless")
      total += _prop(attackerProps, `extra_damage_mod_${elementType}`);
    if (weaponKey)
      total += _prop(attackerProps, `extra_damage_mod_${weaponKey}`);
    return total;
  }

  // No outgoing-% key on sheet yet — placeholder returns 1.0
  function getAttackerPctOutgoingMultiplier(_attackerProps) { return 1.0; }

  // ── TARGET RECEIVING FLAT REDUCTION ──────────────────────────────
  // Sheet keys: damage_receiving_mod_all, _melee, _range (NOT _ranged), _{element}
  function getTargetFlatReduction(targetProps, { elementType, attackRange }) {
    if (!targetProps) return 0;
    let total = _prop(targetProps, "damage_receiving_mod_all");
    const range = normalizeAttackRange(attackRange);
    if (range === "melee")  total += _prop(targetProps, "damage_receiving_mod_melee");
    if (range === "ranged") total += _prop(targetProps, "damage_receiving_mod_range");
    if (elementType && elementType !== "elementless")
      total += _prop(targetProps, `damage_receiving_mod_${elementType}`);
    return total;
  }

  // ── TARGET RECEIVING % MULTIPLIER ────────────────────────────────
  // Sheet keys: damage_receiving_percentage_all, _melee, _range, _{element}
  // Interpretation: "reduce by X%" → multiplier = 1 − X/100
  function getTargetPctMultiplier(targetProps, { elementType, attackRange }) {
    if (!targetProps) return 1;
    let totalPct = _prop(targetProps, "damage_receiving_percentage_all");
    const range = normalizeAttackRange(attackRange);
    if (range === "melee")  totalPct += _prop(targetProps, "damage_receiving_percentage_melee");
    if (range === "ranged") totalPct += _prop(targetProps, "damage_receiving_percentage_range");
    if (elementType && elementType !== "elementless")
      totalPct += _prop(targetProps, `damage_receiving_percentage_${elementType}`);
    return Math.max(0, 1 - (totalPct / 100));
  }

  // ── AFFINITY ──────────────────────────────────────────────────────
  const ELEMENT_AFFINITY_KEY = {
    physical: "affinity_1", air:   "affinity_2", bolt:  "affinity_3",
    dark:     "affinity_4", earth: "affinity_5", fire:  "affinity_6",
    ice:      "affinity_7", light: "affinity_8", poison:"affinity_9",
  };

  const CONDITION_VULNERABLE = {
    Wet: "bolt", Oil: "fire", Petrify: "earth",
    Hypothermia: "ice", Turbulence: "air", Zombie: "light",
  };

  // ── AV ASSETS (mirrors AdvanceDamage — self-contained copy) ──────
  const _SFX = {
    baseHit : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/HitSlashM.wav",
    heal    : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Heal3.ogg",
    mpSpend : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dispel%20Magic.ogg",
    mpAbsorb: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/AbsorbElement.ogg",
    super   : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Hit_SlashingB.wav",
    resist  : "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Parry.ogg",
  };

  function _resolveAV(valueType, isHeal, affinity) {
    let effectFile = "", textColor = "#ffffff", damageIcon = "⚔️", audioFile = "", suppressAudio = false;

    if (valueType === "hp") {
      if (isHeal) {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Green_400x400.webm";
        textColor = "#00FF00"; damageIcon = "❤️";
      } else {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_07_Regular_Orange_400x400.webm";
        if (affinity === "VU") damageIcon = "💥";
        if (affinity === "RS") damageIcon = "🛡️";
      }
    } else if (valueType === "mp") {
      if (isHeal) {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Blue_400x400.webm";
        textColor = "#00ABFF"; damageIcon = "💧"; audioFile = _SFX.mpAbsorb;
      } else {
        effectFile = "modules/JB2A_DnD5e/Library/2nd_Level/Misty_Step/MistyStep_01_Regular_Blue_400x400.webm";
        textColor = "#B32EFF"; damageIcon = "🌀"; audioFile = _SFX.mpSpend;
      }
    } else {
      if (isHeal) {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Green_400x400.webm";
        textColor = "#00FF00"; damageIcon = "🛡️";
      } else {
        effectFile = "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_07_Regular_Orange_400x400.webm";
        damageIcon = "🛡️";
      }
    }

    if (valueType === "hp" && !isHeal && affinity) {
      switch (affinity) {
        case "VU": audioFile = _SFX.super;  break;
        case "RS": audioFile = _SFX.resist; break;
        case "IM": case "AB": suppressAudio = true; audioFile = ""; break;
      }
    }
    if (!audioFile && !suppressAudio) audioFile = isHeal ? _SFX.heal : _SFX.baseHit;

    return { effectFile, textColor, damageIcon, audioFile };
  }

  // ── COMPUTE (pure, synchronous) ───────────────────────────────────
  /**
   * Steps 0-8: pure math, no side-effects.
   *
   * @param {object} opts
   * @param {number}      [opts.baseDamage]
   * @param {string}      [opts.elementType]        default "elementless"
   * @param {string}      [opts.attackRange]        "Melee" | "Ranged" | null
   * @param {boolean}     [opts.isSpellish]
   * @param {boolean}     [opts.isItem]             damage dealt by USING a consumable
   * @param {string}      [opts.weaponType]         e.g. "sword_ef"
   * @param {string|null} [opts.damageClass]        explicit override; undefined = auto-derive
   * @param {boolean}     [opts.isCrit]
   * @param {object}      [opts.attackerProps]      actor.system.props (null-safe)
   * @param {object}      [opts.targetProps]        actor.system.props (null-safe)
   * @param {boolean}     [opts.ignoreDR]
   * @param {number}      [opts.actionBonusFlat]
   * @param {number}      [opts.actionOutgoingMult]  decimal (default 1)
   * @param {number}      [opts.actionReductionFlat]
   * @returns {{ finalPreAffinity: number, damageClass: "strike"|"magic"|null, breakdown: object[] }}
   */
  function computeDamage({
    baseDamage         = 0,
    elementType        = "elementless",
    attackRange        = null,
    isSpellish         = false,
    isItem             = false,
    weaponType         = "none_ef",
    damageClass,
    isCrit             = false,
    attackerProps      = null,
    targetProps        = null,
    ignoreDR           = false,
    actionBonusFlat    = 0,
    actionOutgoingMult = 1,
    actionReductionFlat = 0,
  } = {}) {
    const log = [];
    const weaponKey = extractWeaponKey(weaponType);
    const ctx = { elementType, attackRange, isSpellish, isItem, weaponKey };
    const resolvedDamageClass = deriveDamageClass({ damageClass, isSpellish, weaponType });

    let x = _num(baseDamage);
    log.push({ step: 0, label: "Base", value: x });

    const sheetFlat    = getAttackerFlatOutgoing(attackerProps, ctx);
    const outgoingFlat = _num(actionBonusFlat) + sheetFlat;
    x += outgoingFlat;
    log.push({ step: 1, label: "Outgoing Flat", add: outgoingFlat, sheetFlat, actionBonus: _num(actionBonusFlat), value: x });

    const sheetPctMult = getAttackerPctOutgoingMultiplier(attackerProps);
    const outgoingMult = Math.max(0, _num(actionOutgoingMult, 1)) * sheetPctMult;
    x *= outgoingMult;
    log.push({ step: 2, label: "Outgoing %", mult: outgoingMult, value: x });

    const targetFlat = ignoreDR ? 0 : getTargetFlatReduction(targetProps, ctx) + _num(actionReductionFlat);
    x -= targetFlat;
    log.push({ step: 3, label: "Target Flat Reduction", sub: targetFlat, value: x });

    const targetPctMult = ignoreDR ? 1 : getTargetPctMultiplier(targetProps, ctx);
    x *= targetPctMult;
    log.push({ step: 4, label: "Target % Mod", mult: targetPctMult, value: x });

    const critFlat = isCrit ? _prop(attackerProps, "critical_damage_bonus") : 0;
    x += critFlat;
    log.push({ step: 5, label: "Crit Flat Bonus", add: critFlat, value: x });

    const critMult = isCrit ? Math.max(0, _prop(attackerProps, "critical_damage_multiplier", 1)) : 1;
    x *= critMult;
    log.push({ step: 6, label: "Crit Multiplier", mult: critMult, value: x });

    x = Math.max(x, 0);
    log.push({ step: 7, label: "Clamp", value: x });

    const finalPreAffinity = Math.ceil(x);
    log.push({ step: 8, label: "Final Pre-Affinity (ceil)", value: finalPreAffinity });

    return { finalPreAffinity, damageClass: resolvedDamageClass, breakdown: log };
  }

  // ── APPLY TO ACTOR (async, full pipeline + AV feedback) ──────────
  /**
   * Runs the full damage pipeline and writes the result to the actor.
   * Emits the same AV feedback as AdvanceDamage (Sequencer, Damage Card, BattleLog),
   * all gated by verbosity.  AdvanceDamage is never called or modified.
   *
   * @param {object}      opts
   * @param {number}      [opts.baseDamage]
   * @param {string}      [opts.elementType]
   * @param {string}      [opts.attackRange]         "Melee" | "Ranged" | null
   * @param {boolean}     [opts.isSpellish]
   * @param {boolean}     [opts.isItem]               damage dealt by USING a consumable
   * @param {string}      [opts.weaponType]           e.g. "sword_ef"
   * @param {string|null} [opts.damageClass]          "strike"|"magic"|null|undefined (auto)
   * @param {string}      [opts.valueType]            "hp"|"mp"|"shield"
   * @param {string}      [opts.targetAffinity]       "neutral"|"percentMax"|"percentCurrent"
   * @param {boolean}     [opts.isRecovery]
   * @param {boolean}     [opts.isCrit]
   * @param {object}      [opts.attackerProps]        actor.system.props (if already resolved)
   * @param {string}      [opts.attackerUuid]         resolved if attackerProps not provided
   * @param {string}      [opts.attackerName]         display name for log / card
   * @param {string}      [opts.sourceType]
   * @param {object}      opts.targetActor            Foundry Actor document  (required)
   * @param {object}      [opts.targetToken]          Token placeable
   * @param {boolean}     [opts.ignoreDR]
   * @param {boolean}     [opts.ignoreShield]
   * @param {number}      [opts.actionBonusFlat]
   * @param {number}      [opts.actionOutgoingMult]   decimal (1 = 100%)
   * @param {number}      [opts.actionReductionFlat]
   * @param {string}      [opts.verbosity]            VERBOSITY level (default "full")
   * @param {string}      [opts.damageBatchId]
   * @param {string}      [opts.battleLogBatchId]
   * @param {object}      [opts.actionContext]
   * @param {string}      [opts.actionCardMsgId]
   * @param {number|string} [opts.accuracy]           for battle log display
   * @returns {Promise<object>}  per-target result record
   */
  async function applyToActor({
    baseDamage         = 0,
    elementType        = "elementless",
    attackRange        = null,
    isSpellish         = false,
    isItem             = false,
    weaponType         = "none_ef",
    damageClass,
    valueType          = "hp",
    targetAffinity     = "neutral",
    isRecovery         = false,
    isCrit             = false,
    attackerProps      = null,
    attackerUuid       = "",
    attackerName       = "Unknown",
    sourceType         = "None",
    targetActor,
    targetToken        = null,
    ignoreDR           = false,
    ignoreShield       = false,
    // Skip element + damage-class affinity (RS/VU/IM/AB) and condition-forced
    // vulnerability — the damage lands as a flat amount. For fixed/"true" effect
    // damage that should not be halved/doubled by the target's affinities (e.g.
    // an opposed-check consequence like Pounce's 20). DR/shield still apply.
    ignoreAffinity     = false,
    actionBonusFlat    = 0,
    actionOutgoingMult = 1,
    actionReductionFlat = 0,
    verbosity          = VERBOSITY.FULL,
    damageBatchId      = null,
    battleLogBatchId   = null,
    actionContext      = null,
    actionCardMsgId    = null,
    accuracy           = null,
  } = {}) {
    if (!targetActor) throw new Error("[applyDamage] targetActor is required");

    // Resolve attackerProps from UUID if not provided directly
    let resolvedAttackerProps = attackerProps;
    if (!resolvedAttackerProps && attackerUuid) {
      try {
        const doc = await fromUuid(attackerUuid);
        resolvedAttackerProps = doc?.actor?.system?.props ?? doc?.system?.props ?? null;
      } catch (e) {
        console.warn("[applyDamage] Could not resolve attackerUuid:", attackerUuid, e);
      }
    }

    const props       = targetActor.system.props;
    const startHP     = _num(props.current_hp);
    const startMP     = _num(props.current_mp);
    const startShield = _num(props.shield_value);

    let postHP     = startHP;
    let postMP     = startMP;
    let postShield = startShield;

    // %-based base resolution
    let resolvedBase = _num(baseDamage);
    if (targetAffinity === "percentMax") {
      resolvedBase = Math.ceil(_num(props.max_hp) * (resolvedBase / 100));
    } else if (targetAffinity === "percentCurrent") {
      resolvedBase = Math.ceil(_num(props.current_hp) * (resolvedBase / 100));
    }

    const baseChangeKey          = valueType + (isRecovery ? "Recovery" : "Reduction");
    let   currentChangeKey       = baseChangeKey;
    let   finalValue;
    let   preAffinityBreakdown   = null;
    let   affinity               = null;
    let   weaponEfficiencyUsed   = 100;
    let   shieldBreak            = false;
    const resolvedDamageClass    = deriveDamageClass({ damageClass, isSpellish, weaponType });

    if (currentChangeKey === "hpReduction") {
      // Steps 0-8: pure math
      const { finalPreAffinity, breakdown } = computeDamage({
        baseDamage: resolvedBase,
        elementType, attackRange, isSpellish, isItem, weaponType, damageClass, isCrit,
        attackerProps: resolvedAttackerProps, targetProps: props, ignoreDR,
        actionBonusFlat, actionOutgoingMult, actionReductionFlat,
      });
      finalValue           = finalPreAffinity;
      preAffinityBreakdown = breakdown;

      // Step 9a: Weapon efficiency
      weaponEfficiencyUsed = _num(props[weaponType], 100);
      finalValue = Math.ceil(finalValue * (weaponEfficiencyUsed / 100));

      // Step 9b: Element affinity (skipped entirely when ignoreAffinity — the
      // damage lands flat regardless of RS/VU/IM/AB or condition-forced VU).
      const affinityKey = ELEMENT_AFFINITY_KEY[elementType] ?? null;
      affinity = (!ignoreAffinity && affinityKey) ? (props[affinityKey] ?? null) : null;

      if (!ignoreAffinity) {
        const activeActor = targetToken?.actor ?? targetActor;
        const conditions  = Array.from(activeActor.effects ?? []).map((e) => e.label ?? e.name);
        // Condition-forced vulnerability
        for (const [cond, el] of Object.entries(CONDITION_VULNERABLE)) {
          if (conditions.includes(cond) && elementType === el) affinity = "VU";
        }
        // NOTE: Guard's "Resistance to all" is NOT special-cased here. The Guard
        // AE overrides the affinity props (affinity_1..9 → RS, except where the
        // target is natively IM/AB; see 2026-06-09-guard-affinity-rs), so the
        // `props[affinityKey]` read above already reflects it. Single source of
        // truth = the actor's affinity data.
      }

      switch (affinity) {
        case "RS": finalValue = Math.ceil(finalValue / 2);                  break;
        case "VU": finalValue = Math.ceil(finalValue * 2);                  break;
        case "IM": finalValue = 0;                                           break;
        case "AB": finalValue = -Math.ceil(finalValue); currentChangeKey = "hpRecovery"; break;
      }

      // Step 9c: Damage-class affinity (parallel to element affinity).
      //   Source: actor.flags["fabula-ultima-companion"].affinity_class_{strike|magic}
      //   States: "" | "RS" | "VU" | "IM" | "AB"  (same semantics as element)
      //   Stored as a flag (not a system.props field) so AEs can write to it
      //   without requiring an extension to the CSB character template.
      if (!ignoreAffinity && currentChangeKey === "hpReduction" && resolvedDamageClass) {
        const flagKey = resolvedDamageClass === "strike"
          ? "affinity_class_strike"
          : "affinity_class_magic";
        const classAff = targetActor?.flags?.["fabula-ultima-companion"]?.[flagKey] ?? null;
        if (classAff) {
          switch (classAff) {
            case "RS": finalValue = Math.ceil(finalValue / 2);                  break;
            case "VU": finalValue = Math.ceil(finalValue * 2);                  break;
            case "IM": finalValue = 0;                                           break;
            case "AB": finalValue = -Math.ceil(finalValue); currentChangeKey = "hpRecovery"; break;
          }
        }
      }
    } else {
      // Non-HP: simple flat math, no pipeline
      finalValue = Math.ceil(
        Math.max(resolvedBase - _num(actionReductionFlat) + _num(actionBonusFlat), 0) *
        Math.max(0, _num(actionOutgoingMult, 1))
      );
    }

    // Step 9d: Universal damage-taken multiplier.
    //   Source: actor.flags["fabula-ultima-companion"].damage_taken_mult
    //   Multiplies finalValue on any *Reduction path. Skipped on recovery
    //   branches (AB-absorbed damage, heals) so it never amplifies benefits
    //   intended as drawbacks. Default 1 = no change.
    //
    //   Multiplicative stacking semantics: each AE that wants to scale
    //   incoming damage should target this flag with mode 1 (MULTIPLY).
    //   Today mode 5 (OVERRIDE) is also fine for single-source cases.
    if (currentChangeKey === "hpReduction" || currentChangeKey === "mpReduction" || currentChangeKey === "shieldReduction") {
      const mult = _num(targetActor?.flags?.["fabula-ultima-companion"]?.damage_taken_mult, 1);
      if (Number.isFinite(mult) && mult > 0 && mult !== 1) {
        finalValue = Math.ceil(finalValue * mult);
      }
    }

    // ── STAT UPDATE ───────────────────────────────────────────────────
    // We pass `fuReactionTriggersHandled: true` in the update options on
    // HP-mutating paths so the eager reaction emitters
    // (auto-crisis-detection, creature-defeated-emitter) know that the
    // damage card path will fire crisis-enter / crisis-exit / defeated
    // reactions itself, in the same batch as `creature_takes_damage`.
    // Without this dedupe flag those emitters race the damage card and
    // produce out-of-order or duplicate reaction windows.
    const _reactionDedupeOpts = { fuReactionTriggersHandled: true };
    switch (currentChangeKey) {
      case "hpReduction": {
        let shield = startShield, remaining = finalValue;
        if (!ignoreShield) {
          const absorbed = Math.min(shield, remaining);
          shield -= absorbed; remaining -= absorbed;
          if (shield === 0 && startShield > 0) shieldBreak = true;
        }
        postShield = shield;
        postHP     = Math.max(startHP - remaining, 0);
        await targetActor.update({
          "system.props.shield_value": postShield,
          "system.props.current_hp":   postHP,
        }, _reactionDedupeOpts);
        break;
      }
      case "hpRecovery": {
        const amt = Math.abs(finalValue || resolvedBase);
        postHP = Math.min(startHP + amt, _num(props.max_hp));
        await targetActor.update({ "system.props.current_hp": postHP }, _reactionDedupeOpts);
        break;
      }
      case "mpReduction": {
        postMP = Math.max(startMP - finalValue, 0);
        await targetActor.update({ "system.props.current_mp": postMP });
        break;
      }
      case "mpRecovery": {
        const amt = Math.abs(finalValue || resolvedBase);
        postMP = Math.min(startMP + amt, _num(props.max_mp));
        await targetActor.update({ "system.props.current_mp": postMP });
        break;
      }
      case "shieldReduction": {
        if (finalValue > 0 && startShield > 0 && startShield <= finalValue) shieldBreak = true;
        postShield = Math.max(startShield - finalValue, 0);
        await targetActor.update({ "system.props.shield_value": postShield });
        break;
      }
      case "shieldRecovery": {
        postShield = Math.max(finalValue, startShield);
        await targetActor.update({ "system.props.shield_value": postShield });
        break;
      }
    }

    const affected = (postHP !== startHP) || (postMP !== startMP) || (postShield !== startShield);
    const isHeal   = currentChangeKey.endsWith("Recovery");
    const { effectFile, textColor, damageIcon, audioFile } = _resolveAV(valueType, isHeal, affinity);
    const displayAmt = Math.abs(finalValue || resolvedBase);

    // ── SEQUENCER (floating numbers + VFX/SFX) ───────────────────────
    if (affected && verbosityAtLeast(verbosity, "numbers")) {
      const amountText  = `${damageIcon} ${displayAmt}`;
      const textStyle   = { fill: textColor, fontSize: 35, fontWeight: "bold", lineJoin: "round", strokeThickness: 3 };
      const seqLocation = targetToken ?? targetActor;

      if (!verbosityAtLeast(verbosity, "fx")) {
        // Numbers only
        new Sequence()
          .scrollingText()
            .atLocation(seqLocation)
            .text(amountText, textStyle)
            .duration(1000)
          .play();
      } else {
        if (effectFile) {
          new Sequence()
            .effect()
              .file(effectFile)
              .atLocation(seqLocation)
              .scale(0.4)
              .duration(1000)
            .scrollingText()
              .atLocation(seqLocation)
              .text(amountText, textStyle)
              .duration(1000)
            .play();
        }
        if (audioFile) new Sequence().sound(audioFile).play();
      }
    }

    // ── DAMAGE CARD ───────────────────────────────────────────────────
    if (verbosityAtLeast(verbosity, "full")) {
      const CREATE_CARD = game.macros.getName("Create Damage Card");
      if (CREATE_CARD) {
        const effLabel = _affinityLabel(affinity);
        const noEffectReason = !affected
          ? (affinity === "IM" ? "Immune" : finalValue === 0 ? "ReducedToZero" : "NoChange")
          : null;
        try {
          await CREATE_CARD.execute({
            __AUTO: true,
            __PAYLOAD: {
              damageBatchId:       damageBatchId || null,
              attackerName,
              attackerUuid,
              attackRange,
              sourceType,
              isSpellish,
              actionContext,
              actionCardMsgId,
              meta:                { damageBatchId: damageBatchId || null },
              preAffinityBreakdown,
              damageClass:         resolvedDamageClass,
              targetName:          targetActor.name,
              targetUuid:          targetToken?.document?.uuid ?? targetActor.uuid ?? null,
              valueType,
              changeKey:           currentChangeKey,
              elementType,
              weaponType,
              weaponEfficiencyUsed,
              affinityCode:        affinity ?? "NE",
              effectivenessLabel:  effLabel,
              baseValue:           resolvedBase,
              finalValue,
              displayedAmount:     displayAmt,
              shieldBreak,
              affected,
              noEffectReason,
              gmChanges: {
                hp:     { from: startHP,     to: postHP     },
                mp:     { from: startMP,     to: postMP     },
                shield: { from: startShield, to: postShield },
              },
            },
          });
        } catch (e) {
          console.warn("[applyDamage] Create Damage Card failed:", e);
        }
      }
    }

    // ── BATTLE LOG ────────────────────────────────────────────────────
    if (verbosityAtLeast(verbosity, "numbers")) {
      const effLabel     = _affinityLabel(affinity);
      const weaponKey    = extractWeaponKey(weaponType);
      const weaponNice   = weaponKey ? `${weaponKey.toLowerCase()} weapon` : "";
      const valueTypeLbl = valueType === "hp" ? "HP" : valueType === "mp" ? "MP" : "Shield";
      // targetToken may be a placeable Token (disposition on `.document`) OR a
      // TokenDocument (disposition directly) — effect-damage via reactions
      // (Burn et al.) passes the document. Read defensively so the battle-log
      // step never throws after the HP write has already committed.
      const tgtDisposition = targetToken?.document?.disposition ?? targetToken?.disposition ?? null;
      const tgtDisp      = tgtDisposition === 1 ? "ally" : tgtDisposition === -1 ? "enemy" : "neutral";

      let summary = "";
      if      (currentChangeKey === "hpReduction")    summary = `${attackerName} deals ${displayAmt}${elementType !== "elementless" ? ` ${_CAP(elementType)}` : ""} damage to ${targetActor.name}${weaponNice ? ` with a ${weaponNice}` : ""} [${effLabel}] [Efficiency: ${Math.round(weaponEfficiencyUsed)}%]`;
      else if (currentChangeKey === "mpReduction")    summary = `${attackerName} deals ${displayAmt} damage to ${targetActor.name}'s MP`;
      else if (currentChangeKey === "shieldReduction") summary = `${attackerName} deals ${displayAmt} damage to ${targetActor.name}'s Shield`;
      else if (currentChangeKey === "hpRecovery")     summary = `${attackerName} heals ${targetActor.name} for ${displayAmt} HP`;
      else if (currentChangeKey === "mpRecovery")     summary = `${attackerName} restores ${targetActor.name} for ${displayAmt} MP`;
      else if (currentChangeKey === "shieldRecovery") summary = `${attackerName} grants ${targetActor.name} ${displayAmt} Shield`;

      const entry = {
        ts:       new Date().toISOString(),
        accuracy: accuracy != null ? String(accuracy) : "-",
        dealer:   { name: attackerName, disposition: "neutral", range: attackRange ?? "None", sourceType },
        target:   { name: targetActor.name, disposition: tgtDisp },
        inputs:   {
          isRecovery, baseDamage: resolvedBase,
          actionBonusFlat, actionReductionFlat, actionOutgoingMult,
          weaponType, elementType, valueType, targetAffinity,
          ignoreDR, ignoreShield, attackerUuid, isCrit,
        },
        computed: {
          baseValue: resolvedBase, finalValue, weaponEfficiencyUsed,
          effectiveness: effLabel, preAffinityBreakdown,
          damageClass: resolvedDamageClass,
        },
        result: {
          hp:     { from: startHP,     to: postHP     },
          mp:     { from: startMP,     to: postMP     },
          shield: { from: startShield, to: postShield },
          shieldBreak, affected,
          noEffectReason: !affected
            ? (affinity === "IM" ? "Immune" : finalValue === 0 ? "ReducedToZero" : "NoChange")
            : null,
        },
        summary,
      };

      const tableRow = {
        $deleted:      false,
        attacker:      attackerName,
        attack_target: targetActor.name,
        accuracy:      entry.accuracy,
        value:         String(displayAmt),
        value_type:    valueTypeLbl,
        apply_mode:    currentChangeKey.endsWith("Reduction") ? "Damage" : "Healing",
        damage_type:   valueType === "hp" ? _CAP(elementType) : "—",
        affinity:      effLabel,
        efficiency:    valueType === "hp" ? `${Math.round(weaponEfficiencyUsed)}%` : "100%",
        weapon_type:   weaponKey ? _CAP(weaponKey) : "—",
        range:         attackRange ?? "None",
        source_type:   sourceType,
      };

      try {
        const batchApi =
          globalThis.FUCompanion?.api?.battleLogBatch ??
          game.modules?.get?.("fabula-ultima-companion")?.api?.battleLogBatch ??
          null;

        if (batchApi?.captureOrAppend) {
          const res = await batchApi.captureOrAppend({
            batchId:           battleLogBatchId || damageBatchId || null,
            damageBatchId:     damageBatchId || null,
            entries:           [entry],
            rows:              [tableRow],
            source:            "applyDamage",
            immediateIfNoBatch: true,
          });
          if (!res?.ok) console.warn("[applyDamage] BattleLog batch failed:", res);
        } else {
          const LOGGER = game.macros.getName("BattleLog: Append");
          if (LOGGER) await LOGGER.execute({ __AUTO: true, __PAYLOAD: { entries: [entry], rows: [tableRow] } });
        }
      } catch (err) {
        console.warn("[applyDamage] BattleLog failed:", err);
      }
    }

    return {
      finalValue,
      resolvedBase,
      changeKey:           currentChangeKey,
      valueType,
      damageClass:         resolvedDamageClass,
      affinity,
      weaponEfficiencyUsed,
      preAffinityBreakdown,
      shieldBreak,
      affected,
      verbosity,
      hp:     { from: startHP,     to: postHP     },
      mp:     { from: startMP,     to: postMP     },
      shield: { from: startShield, to: postShield },
    };
  }

  // ── PUBLIC API ────────────────────────────────────────────────────
  API_ROOT.api.applyDamage = {
    VERBOSITY,
    verbosityAtLeast,
    deriveDamageClass,
    compute:      computeDamage,
    applyToActor,
    _helpers: {
      extractWeaponKey,
      normalizeAttackRange,
      getAttackerFlatOutgoing,
      getTargetFlatReduction,
      getTargetPctMultiplier,
    },
  };

  console.log("[FU Companion] applyDamage API registered → FUCompanion.api.applyDamage");
})();
