// ActionProfile — the COMPUTE-side single source for the Action Card.
//
// This is the twin of the RESOLVE-side `resolveAction` pipeline. ONE preparation
// pass produces everything the card shows; the card is a pure renderer of its
// output. The pass is Target → Check → Effects, driven by DATA attributes
// (`view.check_mode`, the effect_table) — never by a kind switch beyond gathering
// the primary descriptor from wherever it lives today (weapon snapshot for
// Attack, item props for Skill/Spell).
//
// Design doc + contract: docs/battle-director-action-profile-contract.md.
//
// PHASE 0 STATUS: additive. No FSM caller invokes this yet. It is built to be
// parity-faithful with the COMPUTE handlers in state-handlers.js (it reuses the
// exact same skill-formulas / snapshot helpers) so it can be diffed against the
// live `actionResult` before any caller is switched (Phase 1+).

import { log, warn } from "./logger.js";
import {
  evaluateFormula, buildSkillResolver, buildDamageBonusParts,
  resolveAccuracyParts, resolveOutgoingDamageParts, resolveRestoreParts, sumRestoreParts, applyGrantAdjust,
  applyCritDamage, resolveIncomingReduction, healReceivingMultiplier, normalizeDamageType,
} from "./skill-formulas.js";
import { applyAffinityToDamage, readWeaponEfficiency, snapshotTargetForToken } from "./snapshot.js";
import { resolveResourceDef } from "./resources.js";
import { deriveCheck } from "./check.js";
import { previewEffectRow, resolveDamageElementOverride,
  computeSenderDamageBonuses, applyDamageOp, describeGrant,
  isTargetImmuneToStatuses } from "./skill-effects.js";

// Status conditions that force Vulnerability to a specific element (mirrors the
// Attack COMPUTE table in state-handlers.js — keep in sync).
const FORCED_VU_BY_STATUS = {
  Wet: "bolt", Oil: "fire", Petrify: "earth",
  Hypothermia: "ice", Turbulence: "air", Zombie: "light",
};
const TIER_IDENTITY = 7;

// Resource-recovery / non-elemental damage-type strings that are NOT routed
// through the elemental damage path.
const NON_ELEMENTAL_DT = new Set(["", "none", "healing", "heal", "hp", "recovery"]);

// ── Studied-mask gate ────────────────────────────────────────────────────────
// A player attacker shouldn't see an enemy's DEF/MDEF/outcome/affinity until the
// party has Studied them to Identity tier. Mirrors COMPUTE's checkStudied.
function makeStudiedGate(attacker) {
  const encApi = globalThis.FUCompanion?.api?.encyclopedia;
  const attackerIsFriendly = attacker?.disposition === 1;
  return (target) => {
    if (!attackerIsFriendly) return true;
    if (target.disposition !== -1) return true;
    if (!encApi?.getPageForActor) return true;
    for (const uuid of [target.worldActorUuid, target.actorUuid].filter(Boolean)) {
      try {
        const page = encApi.getPageForActor(uuid);
        const best = Number(page?.getFlag?.("fabula-ultima-companion", "encyclopedia")?.bestResult ?? 0) || 0;
        if (best >= TIER_IDENTITY) return true;
      } catch (_) { /* try next */ }
    }
    return false;
  };
}

// ── Primary-effect descriptor ────────────────────────────────────────────────
// The "primary" damage/heal lives in STAT FIELDS today (weapon snapshot for
// Attack; item props mirrored onto `ar` for Skill/Spell), not in an effect_kind
// row. This normalizes both into one descriptor so the per-target loop can
// synthesize a `damage`/`heal` EffectPreview uniformly.
//
// Returns { mode:"damage"|"heal"|"none", element, resource, damageBonus(number),
//           isMpDamage, outgoingParts, outgoingTotal }.
// Inherent action keywords (pierce, …) declared on the action's own item via
// the `action_keywords` prop (comma/newline list). These are ALWAYS-on game
// keywords — distinct from reaction-granted keywords (apply_action_keyword),
// which are collected per-subject in computeSenderDamageBonuses. Both feed the
// same damage-calc effects (pierce → Resistance treated as neutral).
function parseActionKeywords(view) {
  const raw = view?.source?.system?.props?.action_keywords ?? "";
  return String(raw).split(/[,\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function describePrimary({ view, ar, weapon, liveAttacker, resolver, grant = null, chainVars = null }) {
  const kind = view?.kind ?? ar?.kind ?? "Skill";
  const props = liveAttacker?.system?.props ?? null;
  const keywords = parseActionKeywords(view);

  if (kind === "Attack") {
    const native = weapon?.damageType ?? "Physical";
    const overridden = resolveDamageElementOverride({ actor: liveAttacker, scope: "attack", native });
    const element = String(overridden ?? native ?? "Physical").toLowerCase();
    const rangeKind = /melee/i.test(weapon?.range ?? "") ? "melee"
      : /rang/i.test(weapon?.range ?? "") ? "ranged" : null;
    const weaponKey = String(weapon?.weaponType ?? "").toLowerCase() || null;
    const outgoingParts = resolveOutgoingDamageParts({
      actor: liveAttacker, props, kind: rangeKind, elementType: element, weaponKey,
    });
    // Free-action grant damage (High Speed +SL etc.) folds into the base, like
    // COMPUTE Attack (`damageBonus += grantDb`). The grant's tooltip line comes
    // via buildDamageBonusParts(attackGrant) in baseParts.
    const grantDb = Number(grant?.damageBonus ?? 0) || 0;
    return {
      mode: "damage", element, resource: "hp", isMpDamage: false,
      damageBonus: (Number(weapon?.damageBonus ?? 0) || 0) + grantDb,
      outgoingParts, outgoingTotal: outgoingParts.reduce((s, p) => s + p.amount, 0),
      rangeKind, weaponKey, nativeElement: native, overriddenElement: overridden,
      pierce: !!weapon?.hasPierce,
      keywords,
    };
  }

  // Skill / Spell — read damage descriptor from the TARGET-built `ar`.
  // A `VAR_<NAME>` damage type (e.g. Elemental Shard's "VAR_ELEMENT") resolves
  // to the element the player chose in a pre_activate prompt_element, stashed on
  // ctx.chainVars — so the MAIN damage block (not just an effect chip) shows the
  // chosen element + affinity. Falls back to the literal if no pick was made.
  let nativeDt = String(ar?.damageType ?? "").toLowerCase();
  if (nativeDt.startsWith("var_")) {
    const k = nativeDt.slice(4);
    const picked = chainVars?.[k];
    nativeDt = String(picked ?? "").toLowerCase() || nativeDt;
  }
  // Collapse "no-damage" placeholders ("", "-", "none", "healing", "hp", …) to ""
  // so a restore / status skill is never mis-read as a 0-damage hit. Real elements
  // and "mp" (MP-damage) pass through. Single guard for the type_damage footgun.
  nativeDt = normalizeDamageType(nativeDt);
  const damageBonus = evaluateFormula(ar?.damageBonus, resolver, 0);
  if (!nativeDt) {
    // No damage element → not a damage action; restore/status is built downstream
    // (buildHealPerTarget for a grant; effect chips otherwise). Skip the element
    // override too, so an active spell-element buff can't turn a restore into damage.
    return { mode: "none", element: null, resource: "hp", isMpDamage: false,
      damageBonus, outgoingParts: [], outgoingTotal: 0 };
  }
  const isMpDamage = nativeDt === "mp";
  const isSpell = String(ar?.skillType ?? "").toLowerCase() === "spell";
  const element = isMpDamage
    ? nativeDt
    : String(resolveDamageElementOverride({ actor: liveAttacker, scope: "spell", native: nativeDt }) ?? nativeDt).toLowerCase();
  const isElemental = !!element && !NON_ELEMENTAL_DT.has(element) && !isMpDamage;
  const hasDamage = isMpDamage || isElemental;

  if (!hasDamage) {
    return { mode: "none", element: null, resource: "hp", isMpDamage: false,
      damageBonus, outgoingParts: [], outgoingTotal: 0 };
  }
  // Item-use actions get the `item` damage family so the actor's
  // `extra_damage_mod_item` modifier (Secret Formula's passive AE) applies to
  // created items (e.g. Elemental Shard) but NOT to normal attacks/spells.
  const isItem = String(ar?.kind ?? "").toLowerCase() === "item";
  const dmgKind = isItem ? "item" : (isSpell ? "spell" : null);
  const outgoingParts = isMpDamage ? [] : resolveOutgoingDamageParts({
    actor: liveAttacker, props, kind: dmgKind, elementType: element, weaponKey: null,
  });
  return {
    mode: "damage", element, resource: isMpDamage ? "mp" : "hp", isMpDamage,
    damageBonus,
    outgoingParts, outgoingTotal: outgoingParts.reduce((s, p) => s + p.amount, 0),
    rangeKind: null, weaponKey: null,
    keywords,
  };
}

// ── Check stage ──────────────────────────────────────────────────────────────
// Resolves the accuracy/check block from dice inputs (null dice = pre-roll). The
// mode comes from the data (`view.check_mode` + kind), never a hard kind switch.
function computeCheck({ view, ar, attacker, weapon, primary, liveAttacker, dice, ctx }) {
  const kind = view?.kind ?? ar?.kind ?? "Skill";
  const props = liveAttacker?.system?.props ?? null;
  const fumbleThr = Math.max(1, attacker?.fumbleThreshold ?? 1);

  // Mode + attribute pair + base bonus + accuracy family differ by where the
  // data lives; resolve them, then the dice math is identical for all modes.
  let mode, A1, A2, required = true, baseBonus = 0, accKind = null, dl = null, thresholds = null;
  const bonusParts = [];

  if (kind === "Attack") {
    mode = "vs_defense";
    A1 = weapon?.A1 ?? "DEX"; A2 = weapon?.A2 ?? "INS";
    baseBonus = Number(weapon?.checkBonus ?? 0) || 0;
    if (baseBonus !== 0) bonusParts.push({ source: weapon?.name || "Weapon", amount: baseBonus });
    accKind = primary.rangeKind;   // melee | ranged | null
  } else if (kind === "Hinder") {
    mode = "threshold";
    const cfg = ctx?.hinderCheckConfig ?? {};
    A1 = cfg.A1 ?? "DEX"; A2 = cfg.A2 ?? "INS";
    dl = Math.max(1, Number(cfg.dl) || 10);
  } else if (kind === "Study") {
    mode = "open";
    A1 = "INS"; A2 = "INS";
  } else {
    // Skill / Spell. check_mode "none" => auto-hit (no roll).
    required = String(view?.check_mode ?? (ar?.isCheck ? "opposed" : "none")) !== "none" && (ar?.isCheck ?? false);
    mode = required ? (String(ar?.skillType).toLowerCase() === "spell" ? "vs_defense" : "vs_defense") : "open";
    A1 = ar?.rolledA1 || "INS"; A2 = ar?.rolledA2 || "INS";
    baseBonus = ar?.checkBonus | 0;
    if (baseBonus !== 0) bonusParts.push({ source: ar?.skillName || "Skill", amount: baseBonus });
    accKind = String(ar?.skillType).toLowerCase() === "spell" ? "magic" : null;
  }

  const dA = attacker?.attributes?.[A1] ?? 8;
  const dB = attacker?.attributes?.[A2] ?? 8;

  // Free-action grant (Attack/Hinder consume it; peeked here non-destructively —
  // the caller / COMPUTE owns the real consume). Adds check bonus.
  const grant = ctx?.grant ?? null;
  let grantHrAsZero = false;
  if (grant && (kind === "Attack" || kind === "Hinder")) {
    const gcb = Number(grant.checkBonus) || 0;
    grantHrAsZero = grant.hrAsZero === true;
    if (gcb !== 0) bonusParts.push({ source: grant.sourceLabel || "Free Action", amount: gcb });
    baseBonus += gcb;
  }

  // Actor-status accuracy family (RWM etc.) — Attack + Skill/Spell. Hinder/Study
  // don't fold these today (parity).
  if (kind === "Attack" || kind === "Skill" || kind === "Spell" || (kind !== "Hinder" && kind !== "Study" && required)) {
    if (kind === "Attack" || accKind != null || required) {
      const accParts = resolveAccuracyParts({ actor: liveAttacker, props, kind: accKind });
      for (const p of accParts) { baseBonus += p.amount; bonusParts.push(p); }
    }
  }

  const check = {
    required, mode, attrs: { A1, A2, dA, dB }, bonusParts,
    rA: null, rB: null, hr: null, total: null, isCrit: false, isFumble: false,
    thresholds, dl, blocked: false, blockedBy: null,
    grantHrAsZero,
  };

  if (!required && kind !== "Hinder" && kind !== "Study") {
    // Auto-hit skill — no roll. Leave dice null.
    return check;
  }
  if (dice == null) {
    // Pre-roll: dice not yet known. Caller renders ranges from attrs + bonus.
    return check;
  }

  // Single check derivation (prop-aware crit + fumble_threshold) — same rule as
  // every other check site. The former open-check special-case (hardcoded
  // rA>=6 for Hinder/Study) is gone; deriveCheck honors crit-modifier props for
  // all kinds.
  const d = deriveCheck({ rA: dice.rA ?? 0, rB: dice.rB ?? 0, props, fumbleThreshold: fumbleThr, checkBonus: baseBonus });
  Object.assign(check, { rA: d.rA, rB: d.rB, hr: d.hr, total: d.total, isCrit: d.isCrit, isFumble: d.isFumble, checkBonus: baseBonus });

  if (kind === "Hinder") {
    check.outcomeSuccess = isCrit ? true : isFumble ? false : (total >= dl);
  } else if (kind === "Study") {
    // Graded ladder → encyclopedia tiers.
    let name = "None", threshold = 0;
    if (total >= 13) { name = "Details"; threshold = 13; }
    else if (total >= 8) { name = "Stats"; threshold = 8; }
    else if (total >= 7) { name = "Identity"; threshold = 7; }
    check.thresholds = { name, threshold, fumbled: isFumble };
  }
  return check;
}

// ── Per-target hit determination (shared) ────────────────────────────────────
// Pure. Given a target's defense stat and the (optional) check context, returns
// the hit / pierceMiss flags plus the `outcome` object: auto-hit when no roll,
// crit/fumble overrides, Attack pierce-on-miss. Extracted from the per-target
// builder so the hit rule lives in one place and every effect kind shares it.
function resolveTargetOutcome({ check, kind, primary, defStat, rolled, isPreRoll }) {
  let hit = !rolled;            // auto-hit when no roll required
  let pierceMiss = false;
  if (rolled) {
    if (check.isFumble) hit = false;
    else if (check.isCrit) hit = true;
    else hit = check.total >= defStat;
    if (!hit && kind === "Attack" && primary.pierce) pierceMiss = true;
  }
  const outcome = {
    kind: isPreRoll ? "pending" : (!rolled ? "auto" : (hit ? "hit" : "miss")),
    hit: isPreRoll ? null : (rolled ? hit : true),
    crit: !!check.isCrit && hit, pierceMiss,
    margin: rolled ? (check.total - defStat) : null,
    tier: null, source: null,
  };
  return { hit, pierceMiss, outcome };
}

// ── Per-target outcome + primary EffectPreview ───────────────────────────────
async function buildPerTarget({ view, ar, attacker, primary, check, targets, liveAttacker, ctx, studiedGate, opsMap }) {
  const kind = view?.kind ?? ar?.kind ?? "Skill";
  const out = [];
  // Pre-roll = a Check is required but dice aren't known yet (ranges, not finals).
  const isPreRoll = check.required && (check.total == null);
  const maxHR = Math.max(Number(check.attrs?.dA) || 0, Number(check.attrs?.dB) || 0);
  const foldOps = (d, ops) => {
    if (!ops?.length) return d;
    let v = d;
    for (const { op, amount } of ops) v = applyDamageOp(v, op, amount);
    return v;
  };

  // Defense stat selector — DEF vs MDEF.
  const isSpell = String(ar?.skillType ?? "").toLowerCase() === "spell";
  const dtt = String(ar?.defenseTargetType ?? "").toLowerCase();
  const vsMDef = kind !== "Attack" && (isSpell || dtt === "mdef");
  const pickDef = (e) => (kind === "Attack")
    ? (e.defense ?? 0)
    : (vsMDef ? (e.magicDefense ?? 0) : (e.defense ?? 0));

  const rolled = check.required && check.total != null;
  const effectiveHr = check.grantHrAsZero || String(ctx?.attackMode ?? "").startsWith("two-weapon")
    ? 0
    : (check.isFumble ? 0 : (check.hr ?? 0));

  for (const e of targets) {
    const defStat = pickDef(e);
    const { hit, pierceMiss, outcome } = resolveTargetOutcome({ check, kind, primary, defStat, rolled, isPreRoll });

    const effects = [];
    let damageVal = 0, rawDamage = 0, affinityCode = "NE", damageRange = null;
    const damageModParts = [];
    // In-flight reaction damage ops attributed to their carrier, so the card
    // breakdown can itemize them (e.g. Bite's grappled +50%) rather than hiding
    // the delta inside the per-target total.
    const reactionParts = [];
    // Reaction element override + applied action-keywords + the numeric-op
    // breakdown — surfaced onto the flat row (parity with the retired
    // recomputePerTargetDamages overlay) so the card / RESOLVE read them.
    let reactionElement = null, reactionKeywords = null, reactionBreakdown = null;
    // Per-subject reaction ops, keyed by tokenUuid first (unique per token) then
    // actorUuid (back-compat / single-token actors). The tokenUuid key
    // disambiguates two LINKED tokens that share one world actor — both would
    // collide on actorUuid. computeSenderDamageBonuses emits both keys.
    const targetOps = opsMap?.get?.(e.tokenUuid) ?? opsMap?.get?.(e.actorUuid) ?? [];

    // Affinity helper (MP damage / status-only → NE). Forced-VU is ATTACK-only
    // in COMPUTE today; gate to kind==="Attack". Guard's "RS to all" is NO LONGER
    // special-cased here — the Guard AE overrides the affinity props directly
    // (see 2026-06-09-guard-affinity-rs migration), so `e.affinities` already
    // reflects it. Single source of truth = the actor's affinity data.
    const computeAffinity = () => {
      if (primary.isMpDamage) return "NE";
      let aff = e.affinities?.[primary.element] ?? "NE";
      if (kind === "Attack") {
        for (const cond of (e.conditions ?? [])) {
          if (FORCED_VU_BY_STATUS[cond] === primary.element) { aff = "VU"; break; }
        }
      }
      // Inherent Pierce keyword: ignore Resistance (RS → NE) — VU/IM/AB are
      // left untouched. Mirrors the reaction-side pierce in
      // skill-effects.recomputePerTargetDamages so both paths agree.
      if (primary.keywords?.includes("pierce") && aff === "RS") aff = "NE";
      return aff;
    };

    if (primary.mode === "damage" && isPreRoll) {
      // Pre-roll: a pre-affinity damage RANGE over the HR span (1…maxHR, or
      // 0…0 when HR is forced to 0). Reaction ops (Hawkeye take-aim etc.) fold
      // into both ends so the preview anticipates them. Per-target reduction /
      // affinity are NOT applied to the pre-roll range (matches the legacy
      // pre-roll card's generic "potential damage" range).
      const ignoreHR = check.grantHrAsZero || String(ctx?.attackMode ?? "").startsWith("two-weapon");
      const rawAt = (h) => {
        const d = foldOps(h + primary.damageBonus + primary.outgoingTotal, targetOps);
        return Math.max(0, Math.floor(d));
      };
      const lo = ignoreHR ? 0 : (maxHR > 0 ? 1 : 0);
      const hi = ignoreHR ? 0 : maxHR;
      damageRange = { min: rawAt(lo), max: rawAt(hi), maxHR: hi, base: rawAt(0) };
      affinityCode = computeAffinity();
      effects.push({
        id: `primary-damage:${e.tokenUuid}`,
        type: "resource_delta", valence: "harmful", actionKind: kind, source: kind === "Attack" ? "weapon" : "spell",
        targetRef: e.tokenUuid,
        element: primary.element, resource: primary.resource, damageClass: "primary",
        breakdown: [], preAffinity: null, affinity: affinityCode, range: damageRange,
      });
    } else if (primary.mode === "damage" && (hit || pierceMiss)) {
      const outBase = effectiveHr + primary.damageBonus + primary.outgoingTotal;
      rawDamage = (kind === "Attack" && pierceMiss) ? Math.ceil(outBase / 2) : outBase;

      // Target actor for the incoming layer (DR + weapon efficiency), fetched
      // once and reused (null for MP damage, which skips the incoming layer).
      const liveTarget = (!primary.isMpDamage) ? await fromUuid(e.actorUuid).catch(() => null) : null;

      if (!primary.isMpDamage) {
        const red = resolveIncomingReduction({
          actor: liveTarget, elementType: primary.element, range: primary.rangeKind ?? null, raw: rawDamage,
        });
        rawDamage = red.value;
        damageModParts.push(...red.parts);
        if (check.isCrit) {
          const cd = applyCritDamage({ raw: rawDamage, actor: liveAttacker });
          rawDamage = cd.value;
          damageModParts.push(...cd.parts);
        }
      }

      // Weapon efficiency — the target's per-weapon-type incoming multiplier (the
      // INCOMING twin of element affinity). Applied BEFORE the reaction ops +
      // affinity so the fold order matches the post-decision recompute (which
      // folds reaction ops over the stored rawDamage that already includes
      // efficiency): DR → crit → efficiency → reaction ops → affinity. Weapon
      // attacks only (`primary.weaponKey` is null for spells / skills / MP).
      // Shares the readWeaponEfficiency resolver with the effect ruleset — one
      // source of truth for the weapon-affinity axis.
      if (primary.weaponKey && liveTarget) {
        const effPct = readWeaponEfficiency(liveTarget, primary.weaponKey);
        if (effPct !== 100) {
          const before = rawDamage;
          rawDamage = Math.ceil(rawDamage * (effPct / 100));
          if (rawDamage !== before) damageModParts.push({ source: `${primary.weaponKey} efficiency ${effPct}%`, amount: rawDamage - before });
        }
      }

      // Fold accepted-reaction ops (numeric add/multiply + element override +
      // action-keyword tags) on a hit only, as the LAST step before affinity.
      // This is the SINGLE op-folding path — shared by COMPUTE (auto-fired on/
      // force reactions) AND the post-decision recompute (was the separate
      // skill-effects.recomputePerTargetDamages overlay). Numeric ops capture
      // their integer contribution + source for the card breakdown; the element
      // op overrides the affinity element below; pierce downgrades RS→NE.
      if (hit && targetOps.length) {
        const numericOps = targetOps.filter((o) => o.op !== "keyword" && o.op !== "element");
        const kwSet = new Set(targetOps.filter((o) => o.op === "keyword").map((o) => o.keyword));
        const elementOp = [...targetOps].reverse().find((o) => o.op === "element" && o.element);
        const fromRaw = rawDamage;
        let d = rawDamage;
        for (const o of numericOps) {
          const next = applyDamageOp(d, o.op, o.amount);
          const delta = Math.floor(next) - Math.floor(d);
          if (delta !== 0) reactionParts.push({ source: o.source ?? "Reaction", amount: delta });
          d = next;
        }
        rawDamage = Math.max(0, Math.floor(d));
        if (elementOp) reactionElement = elementOp.element;
        if (kwSet.size) reactionKeywords = [...kwSet];
        reactionBreakdown = {
          ops: numericOps, from: fromRaw, to: rawDamage, baseBonus: rawDamage - fromRaw,
          keywords: [...kwSet], ...(elementOp ? { element: elementOp.element, affinity: elementOp.affinity } : {}),
        };
      }

      // Affinity — a reaction element override wins (use its per-subject-resolved
      // affinity, falling back to the target snapshot's affinity for that element);
      // else the native element's affinity. A reaction pierce keyword ALSO
      // downgrades RS→NE (mirrors the inherent primary.keywords pierce).
      affinityCode = computeAffinity();
      if (reactionElement) {
        const eop = [...targetOps].reverse().find((o) => o.op === "element" && o.element === reactionElement);
        affinityCode = (eop && eop.affinity != null) ? String(eop.affinity) : String(e.affinities?.[reactionElement] ?? "NE");
      }
      if (reactionKeywords?.includes("pierce") && affinityCode === "RS") affinityCode = "NE";
      damageVal = applyAffinityToDamage(rawDamage, affinityCode);

      effects.push({
        id: `primary-damage:${e.tokenUuid}`,
        type: "resource_delta", valence: "harmful", actionKind: kind, source: kind === "Attack" ? "weapon" : "spell",
        targetRef: e.tokenUuid,
        element: reactionElement ?? primary.element, resource: primary.resource, damageClass: "primary",
        breakdown: damageModParts, preAffinity: rawDamage, affinity: affinityCode,
        value: damageVal,
        // Reaction-fold artifacts (was on _parity) so flattenRow + the headline
        // breakdown can rebuild from effects alone. overrideElement is null unless
        // a reaction overrode the element — flatten emits `element` only when set,
        // matching the legacy mirror exactly. reactionParts feeds the headline's
        // representative in-flight bonus (projectProfileToActionResult).
        overrideElement: reactionElement ?? null,
        reactionParts,
        ...(reactionKeywords ? { keywords: reactionKeywords } : {}),
        ...(reactionBreakdown ? { bonusBreakdown: reactionBreakdown } : {}),
      });
    }

    out.push({
      target: {
        actorUuid: e.actorUuid, tokenUuid: e.tokenUuid, name: e.name, img: e.tokenImg,
        disposition: e.disposition, studied: studiedGate(e), defenseShown: defStat,
      },
      outcome,
      effects,
    });
  }
  return out;
}

// ── Heal effects (no-damage skills with a grant) ─────────────────────────────
// Finds the first grant row (recipe / on_activate) and attaches a per-target heal
// effect to each roster row, creating rows (auto-hit) for targets that have none
// yet (pure heal). Heal shares the roster's hit determination instead of producing
// a separate row set. Mutates `rows`; returns { healingObj }.
async function attachHealEffects({ rows, view, ar, targets, resolver, liveAttacker = null, check, kind, primary, chainVars = null }) {
  const rolled = !!(check?.required && check?.total != null);
  const isPreRoll = !!(check?.required && check?.total == null);
  const fireLabel = String(view?.fire_points?.on_activate_effect_ref ?? "").trim();
  const tbl = view?.effect_table ?? {};
  let grantRow = null;
  for (const k of Object.keys(tbl)) {
    const row = tbl[k];
    if (!row || row.$deleted || row.effect_kind !== "grant") continue;
    if (fireLabel && row.effect_label === fireLabel) { grantRow = row; break; }
    if (!grantRow) grantRow = row;
  }
  if (!grantRow) return { healingObj: null };

  // Precondition guard (#7): the primary grant amount must be a pure function of
  // pre-card inputs. A VAR_<NAME> captured MID-CHAIN (a prompt in the RESOLVE
  // effect_table, not at pre_activate_effect_ref) is absent at COMPUTE → it would
  // silently resolve to 0 here (and, once heals apply from this profile, apply 0).
  // Fail loud so the author moves the prompt pre-card. Pre-card captures live in
  // chainVars (preActivateVars), so a VAR present there is fine.
  const amtStr = String(grantRow.grant_amount ?? "");
  const varRefs = [...amtStr.matchAll(/VAR_(\w+)/g)].map((m) => m[1].toLowerCase());
  if (varRefs.length) {
    const provided = chainVars ?? {};
    const missing = varRefs.filter((v) => !(v in provided));
    if (missing.length) {
      throw new Error(
        `[action-profile] grant "${grantRow.effect_label}" reads mid-chain ` +
        `${missing.map((m) => "VAR_" + m.toUpperCase()).join(", ")} with no pre-card provider — ` +
        `capture the choice at pre_activate_effect_ref so the grant amount is frozen before the card.`
      );
    }
  }

  // Caster-side restore amount + itemized restore parts come from the SHARED
  // describeGrant — the SAME derivation grantApply runs at RESOLVE — so the
  // previewed heal headline and the applied heal CANNOT drift. The PARTS
  // (attributed to each AE source, e.g. "Secret Formula") feed the Healing
  // tooltip's itemized breakdown, mirroring the damage side. Per-recipient
  // scaling (incoming-heal mult, Vismagus suppress) stays in the loop below.
  const grant = describeGrant(grantRow, {
    resolver, liveAttacker,
    actionResult: { kind: ar?.kind, grantAdjust: ar?.grantAdjust },
  });
  const grantResource = grant.resource;
  const grantAmount = grant.amount;
  const restoreParts = grant.restoreParts;
  // Any RESTORABLE resource (hp/mp/ip/shield/zero_power/…) gets a restore preview —
  // resolved from the shared registry, so adding a resource there makes it render
  // here automatically. Non-restorable / unknown resources → no preview headline.
  const resDef = resolveResourceDef(grantResource);
  if (!(grantAmount > 0) || !resDef?.restorable) return { healingObj: null };
  const canonRes = resDef.key;

  for (const e of targets) {
    const tActor = await fromUuid(e.actorUuid).catch(() => null);
    const cur = Number(tActor?.system?.props?.[resDef.prop] ?? 0) || 0;
    // null max for uncapped resources → the card's "FULL · NO EFFECT" check
    // (gated on resourceMax != null) correctly skips them.
    const max = resDef.max ? (Number(tActor?.system?.props?.[resDef.max] ?? 0) || 0) : null;
    const isCasterSelf = e.actorUuid === ar?.attackerActorRef;
    const vismagusSuppress = !!ar?.vismagusHpPaid && isCasterSelf && canonRes === "hp";
    // Incoming-heal modifier (recipient side, e.g. Bleed -50%): mirror
    // applyGrantEffect so the previewed heal matches the applied heal. HP only.
    const recipMult = canonRes === "hp" ? healReceivingMultiplier(tActor) : 1;
    const recipBase = vismagusSuppress ? 0 : (recipMult !== 1 ? Math.floor(grantAmount * recipMult) : grantAmount);
    // Performer-side per-target heal boosts (Cognitive Focus "+SL×2 to my focus")
    // are NO LONGER a standing prop read here — they ride the adjust_grant
    // card-mutation (a reaction), folded into this amount post-recompute via
    // grantOverride in recomputeActionProfile. Uniform with adjust_accuracy.
    const amount = recipBase;
    const healEffect = {
      id: `primary-heal:${e.tokenUuid}`, type: "resource_delta", valence: "beneficial", actionKind: kind,
      source: "skill", targetRef: e.tokenUuid, resource: canonRes, value: amount,
      // Recipient resource snapshot + Vismagus marker so flattenRow can rebuild
      // the flat grant row from effects alone.
      resourceCur: cur, resourceMax: max,
      ...(vismagusSuppress ? { vismagusSuppressed: true } : {}),
    };
    // Attach to the target's existing roster row (shares its hit determination);
    // create an auto-hit row only when none exists yet (pure heal — no damage/check).
    const existing = rows.find((r) => r.target?.actorUuid === e.actorUuid);
    if (existing) {
      existing.effects.push(healEffect);
    } else {
      const { outcome } = resolveTargetOutcome({ check, kind, primary, defStat: 0, rolled, isPreRoll });
      rows.push({
        target: { actorUuid: e.actorUuid, tokenUuid: e.tokenUuid, name: e.name, img: e.tokenImg,
          disposition: e.disposition, studied: true, defenseShown: 0 },
        outcome,
        effects: [healEffect],
      });
    }
  }
  const healingObj = {
    base: grantAmount, element: canonRes, resource: canonRes,
    resourceLabel: resDef.label, resourceColour: resDef.colour,
    // Primary grant row label — lets RESOLVE's grantApply match THIS grant and
    // apply the precomputed per-target amount from the profile (single source).
    sourceLabel: grantRow.effect_label,
    ignoreHR: true, finalIfHit: grantAmount, declaresHealing: canonRes === "hp", isHealing: true,
    // Itemized restore-modifier sources (e.g. "Secret Formula: +20") — the
    // Healing tooltip renders these under "Base bonus", same as damage baseParts.
    baseParts: restoreParts,
  };
  return { healingObj };
}

// ── Effects gather (effect_table → self/applied previews) ─────────────────────
// Surfaces non-primary effect rows (apply_ae, costs, cleanses, grants…) as
// EffectPreviews. Pure preview — no writes. Self vs target routing is by
// target_ref ("self" → selfEffects). Phase 0: a flat list per row; per-target
// fan-out happens in the profile builder once target resolution is wired.
function gatherEffectPreviews({ view, resolver, chainVars = null }) {
  const selfEffects = [];
  const targetedEffects = [];
  const tbl = view?.effect_table ?? {};
  for (const k of Object.keys(tbl)) {
    const row = tbl[k];
    if (!row || row.$deleted) continue;
    const pv = previewEffectRow(row, { resolver, targetRef: row.target_ref ?? null, chainVars });
    if (!pv) continue;
    const ref = String(row.target_ref ?? "").trim().toLowerCase();
    if (ref === "self" || ref === "" || pv.type === "cost" || pv.type === "equip") selfEffects.push(pv);
    else targetedEffects.push(pv);
  }
  return { selfEffects, targetedEffects };
}

// ── Public: computeActionProfile ─────────────────────────────────────────────
// Build the full ActionProfile. `dice` null = pre-roll (ranges); `{rA,rB}` =
// post-roll (finals). Reuses the exact COMPUTE helpers for parity.
export async function computeActionProfile(input) {
  const {
    view, ar = null, attacker, weapon = null, targets = [], dice = null, ctx = {},
    acceptedReactions = null,
  } = input;
  const kind = view?.kind ?? ar?.kind ?? "Skill";

  const liveAttacker = input.liveAttacker
    ?? (attacker?.actorUuid ? await fromUuid(attacker.actorUuid).catch(() => null) : null);
  const skill = (ar?.skillUuid && await fromUuid(ar.skillUuid).catch(() => null)) || view?.source || null;
  // Thread the action's targets onto the resolver payload so damage/heal
  // formulas can read ACTION_TARGET_COUNT at compute time — e.g. an AoE that
  // splits a fixed pool across its targets (Ruinous Breath: "300 / ACTION_TARGET_COUNT").
  const resolver = buildSkillResolver({
    actor: liveAttacker, payload: { targets, _chainVars: ctx?.chainVars ?? null }, skill, round: ctx?.round ?? 0,
  });

  const studiedGate = makeStudiedGate(attacker);
  const primary = describePrimary({ view, ar, weapon, liveAttacker, resolver, grant: ctx?.grant ?? null, chainVars: ctx?.chainVars ?? null });
  // Attack damage tooltip breakdown (per-AE/weapon/grant source list) — the
  // Skill path's baseParts are just the outgoing-mod parts; Attack appends the
  // buildDamageBonusParts breakdown ahead of them (mirrors COMPUTE Attack).
  if (kind === "Attack" && primary.mode === "damage") {
    try {
      const hand = weapon?.hand ?? (String(ctx?.attackMode ?? "") === "off" ? "off" : "main");
      const dbp = buildDamageBonusParts({ actor: liveAttacker, weapon, hand, attackGrant: ctx?.grant ?? null });
      primary.baseParts = [...dbp, ...(primary.outgoingParts ?? [])];
    } catch (e) {
      warn("computeActionProfile: buildDamageBonusParts threw", e);
      primary.baseParts = [...(primary.outgoingParts ?? [])];
    }
  }
  const check = computeCheck({ view, ar, attacker, weapon, primary, liveAttacker, dice, ctx });

  // Accepted-reaction outgoing damage ops (Hawkeye take-aim, Cheap Shot…). At
  // pre-roll the caller passes the auto-fired on/force candidates so the preview
  // anticipates them; post-roll the accepted set folds the same way.
  let opsMap = null;
  if (Array.isArray(acceptedReactions) && acceptedReactions.length) {
    try {
      opsMap = await computeSenderDamageBonuses({
        casterActor: liveAttacker, acceptedPrePassives: acceptedReactions,
        dCombat: { round: ctx?.round ?? 0 },
      });
    } catch (e) { warn("computeActionProfile: computeSenderDamageBonuses threw", e); }
  }

  // Per-target rows: damage/check path, else heal path.
  let perTarget = [];
  let healingObj = null;
  if (primary.mode === "damage" || check.required) {
    perTarget = await buildPerTarget({ view, ar, attacker, primary, check, targets, liveAttacker, ctx, studiedGate, opsMap });
  }
  if (primary.mode !== "damage") {
    const heal = await attachHealEffects({ rows: perTarget, view, ar, targets, resolver, liveAttacker, check, kind, primary, chainVars: ctx?.chainVars ?? null });
    healingObj = heal.healingObj;
  }

  const { selfEffects, targetedEffects } = gatherEffectPreviews({ view, resolver, chainVars: ctx?.chainVars ?? null });

  // Per-target status fan-out (additive): surface each targeted status AE on the
  // roster rows it applies to, tagged with a per-target `immune` flag — the status
  // analogue of damage affinity. `appliedEffects` is kept (the card still reads it);
  // this adds the unified per-target view, and flattenRow ignores status effects so
  // flat parity holds. Only fans onto EXISTING rows (damage/check/heal targets);
  // pure-status no-roster skills keep status in appliedEffects until row creation is
  // wired (would change perTarget.count, so deferred).
  for (const eff of targetedEffects) {
    if (eff?.type !== "status") continue;
    const ref = String(eff.targetRef ?? "").trim().toLowerCase();
    if (!ref.endsWith("action_targets")) continue;   // only the action-target family maps to the roster
    const hitOnly = ref.startsWith("hit_");
    for (const row of perTarget) {
      if (hitOnly && !row.outcome?.hit) continue;
      const tActor = await fromUuid(row.target.actorUuid).catch(() => null);
      const immune = tActor ? isTargetImmuneToStatuses(tActor, [eff.status]) : false;
      row.effects.push({
        type: "status", status: eff.status, valence: eff.valence,
        source: eff.source, targetRef: eff.targetRef, immune,
      });
    }
  }

  const profile = {
    action: {
      kind,
      name: weapon?.name ?? ar?.skillName ?? ar?.weapon?.name ?? attacker?.name ?? "Action",
      icon: weapon?.imageUrl ?? null,
      descriptor: null,
      actor: {
        actorUuid: attacker?.actorUuid ?? null, tokenUuid: attacker?.tokenUuid ?? null,
        name: attacker?.name ?? null, img: attacker?.tokenImg ?? null,
        disposition: attacker?.disposition ?? null,
      },
    },
    check,
    perTarget,
    selfEffects,
    appliedEffects: targetedEffects,   // non-primary, non-self effect rows
    decisions: [],
    reactions: { pending: false, candidates: [] },
    gate: { canRoll: true, canConfirm: true, reason: null },
    // Carry the synthesized headline objects so a parity test / renderer can
    // read the same `damage`/`healing` summary the COMPUTE ar exposes.
    _summary: {
      hasDamage: primary.mode === "damage",
      hasHealing: !!healingObj,
      damageResource: primary.resource,
      // Attack-only HR-as-0 (two-weapon OR a free-action grant with hrAsZero).
      ignoreHR: kind === "Attack" && (check.grantHrAsZero || String(ctx?.attackMode ?? "").startsWith("two-weapon")),
      // Human-readable WHY HR is 0 — two-weapon vs the actual grant source
      // (Hawkeye take-aim / Soaring Strike), so the card stops blaming
      // Two-Weapon Fighting for every HR-as-0.
      hrZeroReason: kind !== "Attack" ? null
        : String(ctx?.attackMode ?? "").startsWith("two-weapon") ? "Two-Weapon Fighting forces HR=0"
        : check.grantHrAsZero ? `${ctx?.grant?.sourceLabel || "Free action"} treats HR as 0`
        : null,
      primary, healingObj,
      // Headline check bonus (weapon/skill base + actor-status accuracy mods +
      // grant + accuracy reactions) — pre-roll card reads this so RWM etc. show.
      checkBonusTotal: (check.bonusParts ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0),
      // Representative pre-roll damage range (first damaged target). The legacy
      // pre-roll card renders ONE range; per-target ops are in perTarget[].
      headlineRange: (() => {
        for (const r of perTarget) {
          const dmg = (r.effects ?? []).find((x) => x.type === "resource_delta" && x.valence === "harmful" && x.range);
          if (dmg) return dmg.range;
        }
        return null;
      })(),
    },
  };
  return profile;
}

// ── Projection: ActionProfile → legacy actionResult (post-roll dedup) ────────
// Maps a computed profile back into the COMPUTE-added fields of the legacy
// `actionResult` so a COMPUTE handler can `{...baseAr, ...delta}` instead of
// hand-building them. Returns ONLY the COMPUTE-added fields (roll, damage,
// perTargetResults, …); pass-through TARGET fields stay on baseAr. Phase 2/3
// gate: the full-field diff test must be zero-diff before any caller switches.
//
// flattenRow rebuilds the flat perTargetResults entry from the structured row
// (target = WHO, effects = WHAT, outcome = roll result), kind-aware (Attack
// carries pierceMiss; heal rows differ).
function flattenRow(r, kind) {
  const t = r.target ?? {};
  const o = r.outcome ?? {};
  // Heal/grant rows — WHO from target/outcome, WHAT from the beneficial resource
  // effect. effects[] is the source of truth. A beneficial resource_delta is
  // emitted for every restorable resource (hp/mp/ip/shield/…), so its presence is
  // the grant marker. Heal/restore has no element affinity → always "NE".
  const heal = (r.effects ?? []).find((x) => x.type === "resource_delta" && x.valence === "beneficial");
  if (heal) {
    return {
      tokenUuid: t.tokenUuid, actorUuid: t.actorUuid, name: t.name, tokenImg: t.img,
      disposition: t.disposition, defense: t.defenseShown ?? 0,
      hit: !!o.hit, crit: !!o.crit, affinity: "NE", studied: t.studied ?? true,
      grantAmount: heal.value, grantResource: heal.resource,
      resourceCur: heal.resourceCur, resourceMax: heal.resourceMax,
      ...(heal.vismagusSuppressed ? { vismagusSuppressed: true } : {}),
    };
  }
  // Damage row — WHO from target/outcome, WHAT from the primary damage effect.
  // effects[] is now the source of truth (was _parity). Attack rows carry
  // pierceMiss but NOT resource; Skill/Spell rows carry resource (hp/mp) but not
  // pierceMiss — match COMPUTE exactly.
  const dmg = (r.effects ?? []).find((x) => x.type === "resource_delta" && x.valence === "harmful" && x.damageClass === "primary") ?? {};
  const baseFields = {
    tokenUuid: t.tokenUuid, actorUuid: t.actorUuid, name: t.name, tokenImg: t.img,
    disposition: t.disposition, defense: t.defenseShown ?? 0,
    hit: !!o.hit, crit: !!o.crit, affinity: dmg.affinity ?? "NE", studied: t.studied ?? true,
  };
  const out = {
    damageModParts: dmg.breakdown ?? [],
    ...baseFields,
    rawDamage: dmg.preAffinity ?? 0, damage: dmg.value ?? 0,
  };
  if (kind === "Attack") out.pierceMiss = !!o.pierceMiss;
  else out.resource = dmg.resource ?? "hp";
  // Reaction-fold artifacts (element override / applied keywords / numeric-op
  // breakdown) — only present when an accepted reaction touched this row, so the
  // no-reaction COMPUTE row stays byte-identical to before.
  if (dmg.overrideElement) out.element = dmg.overrideElement;
  if (Array.isArray(dmg.keywords) && dmg.keywords.length) out.keywords = dmg.keywords;
  if (dmg.bonusBreakdown) out.bonusBreakdown = dmg.bonusBreakdown;
  return out;
}

export function projectProfileToActionResult(profile, baseAr = {}, targets = null) {
  const kind = profile.action?.kind ?? baseAr.kind ?? "Skill";
  const allTargets = targets ?? baseAr.targets ?? [];
  const check = profile.check ?? {};
  const prim = profile._summary?.primary ?? {};
  const healingObj = profile._summary?.healingObj ?? null;
  const hasDamage = !!profile._summary?.hasDamage;

  let roll = null;
  if (check.required && check.total != null) {
    roll = {
      A1: check.attrs.A1, A2: check.attrs.A2, dA: check.attrs.dA, dB: check.attrs.dB,
      rA: check.rA, rB: check.rB,
      checkBonus: check.checkBonus ?? (check.bonusParts ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0),
      checkBonusParts: check.bonusParts ?? [],
      total: check.total, hr: check.hr, isCrit: check.isCrit, isFumble: check.isFumble,
      opportunities: check.isCrit && !check.isFumble,
    };
  }

  const perTargetResults = (profile.perTarget ?? []).map((r) => flattenRow(r, kind));
  // HR-as-0: Attack honors two-weapon / hrAsZero grant (profile._summary.ignoreHR);
  // Skill/Spell damage carries ignoreHR = "no roll happened". effectiveHr zeroes
  // on the same condition (or a fumble).
  const attackIgnoreHR = !!profile._summary?.ignoreHR;
  const effectiveHr = (kind === "Attack")
    ? (attackIgnoreHR || check.isFumble ? 0 : (check.hr ?? 0))
    : (check.isFumble ? 0 : (check.hr ?? 0));
  // Representative in-flight reaction bonus for the headline breakdown — the
  // first hit target's per-target ops (e.g. Bite's grappled +50%). Folded into
  // base / baseParts / finalIfHit so the Damage Preview tooltip itemizes the
  // bonus and its "Final on hit" matches the actual per-target total instead of
  // omitting it. Per-target rows still carry their own exact numbers.
  const repReactionParts = (() => {
    for (const r of (profile.perTarget ?? [])) {
      if (!r.outcome?.hit) continue;
      const dmg = (r.effects ?? []).find((x) => x.type === "resource_delta" && x.valence === "harmful" && x.damageClass === "primary");
      if (dmg && Array.isArray(dmg.reactionParts) && dmg.reactionParts.length) return dmg.reactionParts;
    }
    return [];
  })();
  const reactionDelta = repReactionParts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  // Representative reaction ELEMENT override for the headline — a creature_will_deal_
  // damage reaction (Thermokinesis Fire/Ice, Tinkerer Infusions) can change the
  // in-flight element per-target. buildPerTarget stamps it on each hit row's primary
  // damage effect as `overrideElement`; the per-target rows + affinity already honor
  // it, but the headline `damage.element` was reading only the base/native element, so
  // the card + battle log still showed the base (e.g. "Elementaless"). Fold the first
  // hit target's override into the headline (uniform across hit targets, same as the
  // numeric repReactionParts fold above).
  const repOverrideElement = (() => {
    for (const r of (profile.perTarget ?? [])) {
      if (!r.outcome?.hit) continue;
      const dmg = (r.effects ?? []).find((x) => x.type === "resource_delta" && x.valence === "harmful" && x.damageClass === "primary");
      if (dmg && dmg.overrideElement) return dmg.overrideElement;
    }
    return null;
  })();
  const damageObj = hasDamage ? (kind === "Attack" ? {
    base: prim.damageBonus + prim.outgoingTotal + reactionDelta,
    baseParts: [...(prim.baseParts ?? prim.outgoingParts ?? []), ...repReactionParts],
    element: repOverrideElement ?? prim.overriddenElement ?? prim.nativeElement ?? prim.element,
    ignoreHR: attackIgnoreHR,
    ...(profile._summary?.hrZeroReason ? { hrZeroReason: profile._summary.hrZeroReason } : {}),
    finalIfHit: effectiveHr + prim.damageBonus + prim.outgoingTotal + reactionDelta,
  } : {
    base: prim.damageBonus + prim.outgoingTotal + reactionDelta,
    baseParts: [...(prim.outgoingParts ?? []), ...repReactionParts],
    element: repOverrideElement ?? prim.element, resource: prim.resource,
    ignoreHR: !roll,
    finalIfHit: effectiveHr + prim.damageBonus + prim.outgoingTotal + reactionDelta,
  }) : null;

  // hitTokenUuids — for a Check, the hit rows; with NO Check, ALL action
  // targets (matches COMPUTE: no-Check skills auto-hit every target, even
  // pure-buff skills that produce zero per-target rows).
  // `outcome.hit` is null in pre-roll (kind "pending") where the legacy
  // `_parity.hit` was true (hit = !rolled); reconstruct that so pre-roll
  // hitTokenUuids stays identical.
  const rowHit = (r) => r.outcome?.hit ?? (r.outcome?.kind === "pending");
  const hitTokenUuids = check.required
    ? (profile.perTarget ?? []).filter(rowHit).map((r) => r.target.tokenUuid)
    : allTargets.map((t) => t.tokenUuid);

  return {
    roll,
    damageComputed: prim.damageBonus ?? 0,
    damage: damageObj ?? healingObj,
    hasDamage,
    hasHealing: !!healingObj,
    damageResource: prim.resource ?? "hp",
    perTargetResults,
    hitTokenUuids,
  };
}

// ── Parity helper ────────────────────────────────────────────────────────────
// Compare a computed profile against a live COMPUTE `actionResult`. Returns
// { ok, diffs:[...] } focusing on the numbers that matter (check total, per-
// target hit/damage/affinity). Used by the verify-* harness, not the runtime.
export function diffProfileAgainstActionResult(profile, ar) {
  const diffs = [];
  const push = (path, a, b) => { if (a !== b) diffs.push({ path, profile: a, actionResult: b }); };

  if (ar?.roll && profile.check?.required) {
    push("check.total", profile.check.total, ar.roll.total);
    push("check.hr", profile.check.hr, ar.roll.hr);
    push("check.isCrit", !!profile.check.isCrit, !!ar.roll.isCrit);
    push("check.isFumble", !!profile.check.isFumble, !!ar.roll.isFumble);
  }

  // Flatten the profile through the SAME flattenRow the runtime uses, then compare
  // to the live ar rows. Profile + ar are independent computations, so this still
  // catches compute/projection drift; flatten-logic correctness is covered by the
  // dedicated synthetic regression test (_parity-flattenrow).
  const kind = profile.action?.kind ?? ar?.kind ?? "Skill";
  const arRows = ar?.perTargetResults ?? [];
  const byUuid = new Map();
  for (const r of profile.perTarget ?? []) byUuid.set(r.target.actorUuid, flattenRow(r, kind));
  push("perTarget.count", (profile.perTarget ?? []).length, arRows.length);
  for (const r of arRows) {
    const p = byUuid.get(r.actorUuid);
    if (!p) { diffs.push({ path: `perTarget[${r.name}]`, profile: "MISSING", actionResult: "present" }); continue; }
    push(`perTarget[${r.name}].hit`, !!p.hit, !!r.hit);
    if (typeof r.damage === "number") push(`perTarget[${r.name}].damage`, p.damage, r.damage);
    if (typeof r.rawDamage === "number") push(`perTarget[${r.name}].rawDamage`, p.rawDamage, r.rawDamage);
    if (r.affinity) push(`perTarget[${r.name}].affinity`, p.affinity, r.affinity);
    if (typeof r.grantAmount === "number") push(`perTarget[${r.name}].grantAmount`, p.grantAmount, r.grantAmount);
  }
  return { ok: diffs.length === 0, diffs };
}

// ── Action view from a live actionResult ─────────────────────────────────────
// Reconstruct the runtime `view` (kind + effect_table + fire_points + source)
// from an `ar` so a re-derivation (recomputeActionProfile, card-mutations'
// per-target redirect re-derive) can run through buildPerTarget. Attack has no
// item view (its primary comes from the weapon snapshot on the ar); Skill/Spell
// rebuild from the skill item. Single source for this logic (was duplicated in
// card-mutations.rederiveTargetRow).
export async function buildActionViewFromAr(ar) {
  const isAttack = String(ar?.kind ?? "").toLowerCase() === "attack";
  if (isAttack) {
    return { kind: "Attack", check_mode: "opposed", effect_table: {}, fire_points: {}, source: null };
  }
  const skill = ar?.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null;
  if (skill) {
    const sr = await import("./skill-recipes.js");
    return sr.getRuntimeActionView(skill);
  }
  return { kind: ar?.kind ?? "Skill", effect_table: {}, fire_points: {}, source: null };
}

// ── Public: recomputeActionProfile ───────────────────────────────────────────
// The SINGLE post-decision recompute entrypoint. Re-derives the per-target rows
// (+ headline damage / hitTokenUuids) for a (possibly mutated) target set with
// the accepted reactions folded in — all through buildPerTarget, so there is no
// separate overlay math. Used by BOTH the action-card preview recompute AND the
// CONFIRM recompute, replacing the computeSenderDamageBonuses +
// recomputePerTargetDamages two-step.
//
// `targets` = the post-mutation target list (redirect / add_target applied);
// defaults to ar.targets. Each is re-snapshotted from its live token so
// buildPerTarget sees full affinity/condition/defense data even if the ar entry
// was slim; the `redirectedFrom` swap marker is preserved across the re-snapshot
// and re-attached to the flat output rows. `acceptedReactions` are the accepted
// pre-passive candidates (their appliesToTargetUuids should already be refreshed
// via skill-effects.refreshReactionSubjects). Returns the projected delta
// (perTargetResults, damage, hitTokenUuids, …) or null on hard failure.
export async function recomputeActionProfile({ ar, targets = null, acceptedReactions = null, round = 0, attackMode = null, accuracyOverride = null, grantOverride = null, defenseOverrides = null } = {}) {
  if (!ar) return null;
  try {
    const srcTargets = Array.isArray(targets) ? targets : (Array.isArray(ar.targets) ? ar.targets : []);
    const snaps = [];
    for (const t of srcTargets) {
      let snap = null;
      try {
        const tok = t?.tokenUuid ? await fromUuid(t.tokenUuid).catch(() => null) : null;
        snap = tok ? snapshotTargetForToken(tok) : null;
      } catch { snap = null; }
      if (!snap) snap = t;
      snaps.push(t?.redirectedFrom ? { ...snap, redirectedFrom: t.redirectedFrom } : snap);
    }
    const view = await buildActionViewFromAr(ar);
    const dice = (ar.roll && typeof ar.roll.rA === "number") ? { rA: ar.roll.rA, rB: ar.roll.rB } : null;
    const profile = await computeActionProfile({
      view, ar, attacker: ar.attacker, weapon: ar.weapon ?? null,
      targets: snaps, dice,
      ctx: { round: ar.round ?? round ?? 0, attackMode: attackMode ?? ar.attackMode ?? null },
      acceptedReactions,
    });
    const delta = projectProfileToActionResult(profile, ar, snaps);
    if (Array.isArray(delta?.perTargetResults)) {
      for (let i = 0; i < delta.perTargetResults.length; i++) {
        const rf = snaps[i]?.redirectedFrom;
        if (rf) delta.perTargetResults[i].redirectedFrom = rf;
      }
    }
    // Accuracy override (adjust_accuracy / Crossfire): card-mutations rewrote the
    // effective Accuracy total and recomputed hit/miss, but buildPerTarget rebuilds
    // hit/miss from the ORIGINAL roll. Re-apply the override on the rebuilt rows so
    // a "set 0 → all miss" survives the recompute (the old overlay preserved it by
    // skipping misses). Mirrors card-mutations.applyAdjustAccuracyMutation.
    if (accuracyOverride && Array.isArray(delta?.perTargetResults)) {
      const isCrit = !!ar.roll?.isCrit, isFumble = !!ar.roll?.isFumble;
      const newTotal = Number(accuracyOverride.to ?? 0);
      const newHits = [];
      for (const row of delta.perTargetResults) {
        const def = Number(row.defense ?? 10);
        const newHit = isCrit ? true : (!isFumble && newTotal >= def);
        row.hit = newHit;
        row.crit = isCrit && newHit;
        row.rawDamage = newHit ? row.rawDamage : 0;
        row.damage = newHit ? row.damage : 0;
        row.accuracyBlocked = !newHit;
        if (newHit && row.tokenUuid) newHits.push(row.tokenUuid);
      }
      delta.hitTokenUuids = newHits;
    }
    // Defense override (adjust_defense reaction, e.g. Verónica "+2 DEF when targeted"):
    // card-mutations bumped a target's OWN defense, but buildPerTarget rebuilt hit/miss
    // from the target's NATIVE defense. Re-apply each overridden target's defense and
    // re-evaluate ITS hit against the effective total (the accuracyOverride total when
    // one is also in play, else the roll total). PER-TARGET, so it runs AFTER the
    // action-wide accuracy loop and only touches the overridden slots. Mirrors the
    // accuracyOverride re-apply above. defenseOverrides: [{ tokenUuid, actorUuid, from, to, via }].
    if (Array.isArray(defenseOverrides) && defenseOverrides.length && Array.isArray(delta?.perTargetResults)) {
      const isCrit = !!ar.roll?.isCrit, isFumble = !!ar.roll?.isFumble;
      const effTotal = Number(accuracyOverride?.to ?? ar.roll?.total ?? 0);
      let flipped = false;
      for (const row of delta.perTargetResults) {
        const ov = defenseOverrides.find((o) =>
          (o.tokenUuid && o.tokenUuid === row.tokenUuid) || (o.actorUuid && o.actorUuid === row.actorUuid));
        if (!ov) continue;
        const newDef = Number(ov.to);
        const newHit = isCrit ? true : (!isFumble && effTotal >= newDef);
        row.defense = newDef;
        row.hit = newHit;
        row.crit = isCrit && newHit;
        row.rawDamage = newHit ? row.rawDamage : 0;
        row.damage = newHit ? row.damage : 0;
        row.defenseOverride = { from: ov.from, to: ov.to, via: ov.via, reactorName: ov.reactorName ?? null };
        flipped = true;
      }
      // Rebuild the hit list from the final per-target state (covers a +DEF miss).
      if (flipped) delta.hitTokenUuids = delta.perTargetResults.filter((r) => r.hit && r.tokenUuid).map((r) => r.tokenUuid);
    }
    // Grant override (adjust_grant reaction, e.g. Cognitive Focus "+SL×2 healing to
    // my focus"): card-mutations boosted the matching targets' grant amount, but
    // buildHealPerTarget rebuilt it from the BASE formula (no longer carries a
    // standing per-target bonus). Re-apply each token's op on the rebuilt amount so
    // the boost survives the recompute. Mirrors the accuracyOverride re-apply above.
    if (grantOverride?.perToken && Array.isArray(delta?.perTargetResults)) {
      for (const row of delta.perTargetResults) {
        if (typeof row.grantAmount !== "number") continue;
        const ov = grantOverride.perToken[row.tokenUuid];
        if (!ov) continue;
        row.grantAmount = Math.max(0, applyGrantAdjust(row.grantAmount, { op: ov.op, value: ov.value, round: ov.round }));
      }
    }
    return delta;
  } catch (e) {
    warn("recomputeActionProfile threw", e);
    return null;
  }
}
