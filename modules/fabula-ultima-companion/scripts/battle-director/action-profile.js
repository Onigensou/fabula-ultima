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
  applyCritDamage, resolveIncomingReduction,
} from "./skill-formulas.js";
import { applyAffinityToDamage, readWeaponEfficiency } from "./snapshot.js";
import { deriveCheck } from "./check.js";
import { previewEffectRow, resolveDamageElementOverride,
  computeSenderDamageBonuses, applyDamageOp } from "./skill-effects.js";

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
function describePrimary({ view, ar, weapon, liveAttacker, resolver, grant = null, chainVars = null }) {
  const kind = view?.kind ?? ar?.kind ?? "Skill";
  const props = liveAttacker?.system?.props ?? null;

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
  const isMpDamage = nativeDt === "mp";
  const isSpell = String(ar?.skillType ?? "").toLowerCase() === "spell";
  const element = isMpDamage
    ? nativeDt
    : String(resolveDamageElementOverride({ actor: liveAttacker, scope: "spell", native: nativeDt }) ?? nativeDt).toLowerCase();
  const isElemental = !!element && !NON_ELEMENTAL_DT.has(element) && !isMpDamage;
  const hasDamage = isMpDamage || isElemental;
  const damageBonus = evaluateFormula(ar?.damageBonus, resolver, 0);

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
    // Hit determination.
    let hit = !rolled;          // auto-hit when no roll required
    let pierceMiss = false;
    if (rolled) {
      if (check.isFumble) hit = false;
      else if (check.isCrit) hit = true;
      else hit = check.total >= defStat;
      if (!hit && kind === "Attack" && primary.pierce) pierceMiss = true;
    }

    const effects = [];
    let damageVal = 0, rawDamage = 0, affinityCode = "NE", damageRange = null;
    const damageModParts = [];
    // In-flight reaction damage ops attributed to their carrier, so the card
    // breakdown can itemize them (e.g. Bite's grappled +50%) rather than hiding
    // the delta inside the per-target total.
    const reactionParts = [];
    const targetOps = opsMap?.get?.(e.actorUuid) ?? [];

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
        type: "damage", valence: "harmful", source: kind === "Attack" ? "weapon" : "spell",
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

      // Fold accepted-reaction outgoing damage ops (Hawkeye add, Cheap Shot,
      // Bite's grappled +50%…) AFTER reduction/crit, on a hit only — mirrors
      // recomputePerTargetDamages. Capture each op's integer contribution +
      // source so the card can itemize it.
      if (hit && targetOps.length) {
        let d = rawDamage;
        for (const o of targetOps) {
          const next = applyDamageOp(d, o.op, o.amount);
          const delta = Math.floor(next) - Math.floor(d);
          if (delta !== 0) reactionParts.push({ source: o.source ?? "Reaction", amount: delta });
          d = next;
        }
        rawDamage = Math.max(0, Math.floor(d));
      }

      // Weapon efficiency — the target's per-weapon-type incoming multiplier (the
      // INCOMING twin of element affinity, applied just before it to match the
      // legacy order: DR → crit → efficiency → affinity). Weapon attacks only
      // (`primary.weaponKey` is null for spells / skills / MP). Shares the
      // readWeaponEfficiency resolver with the effect ruleset — one source of
      // truth for the weapon-affinity axis.
      if (primary.weaponKey && liveTarget) {
        const effPct = readWeaponEfficiency(liveTarget, primary.weaponKey);
        if (effPct !== 100) {
          const before = rawDamage;
          rawDamage = Math.ceil(rawDamage * (effPct / 100));
          if (rawDamage !== before) damageModParts.push({ source: `${primary.weaponKey} efficiency ${effPct}%`, amount: rawDamage - before });
        }
      }

      affinityCode = computeAffinity();
      damageVal = applyAffinityToDamage(rawDamage, affinityCode);

      effects.push({
        id: `primary-damage:${e.tokenUuid}`,
        type: "damage", valence: "harmful", source: kind === "Attack" ? "weapon" : "spell",
        targetRef: e.tokenUuid,
        element: primary.element, resource: primary.resource, damageClass: "primary",
        breakdown: damageModParts, preAffinity: rawDamage, affinity: affinityCode,
        value: damageVal,
      });
    }

    out.push({
      target: {
        actorUuid: e.actorUuid, tokenUuid: e.tokenUuid, name: e.name, img: e.tokenImg,
        disposition: e.disposition, studied: studiedGate(e), defenseShown: defStat,
      },
      outcome: {
        kind: isPreRoll ? "pending" : (!rolled ? "auto" : (hit ? "hit" : "miss")),
        hit: isPreRoll ? null : (rolled ? hit : true),
        margin: rolled ? (check.total - defStat) : null,
        tier: null, source: null,
      },
      effects,
      // Parity mirror fields (flat, matching perTargetResults) so the diff test
      // can compare without reshaping.
      _parity: {
        defense: defStat, hit, crit: !!check.isCrit && hit, rawDamage, damage: damageVal,
        affinity: affinityCode, pierceMiss, resource: primary.resource,
        studied: studiedGate(e), damageModParts, reactionParts,
      },
    });
  }
  return out;
}

// ── Heal synthesis (no-damage skills with a grant) ───────────────────────────
// Mirrors COMPUTE's heal preview: find the first grant row (recipe / on_activate)
// and produce per-target heal EffectPreviews.
async function buildHealPerTarget({ view, ar, targets, resolver, liveAttacker = null }) {
  const out = [];
  const fireLabel = String(view?.fire_points?.on_activate_effect_ref ?? "").trim();
  const tbl = view?.effect_table ?? {};
  let grantRow = null;
  for (const k of Object.keys(tbl)) {
    const row = tbl[k];
    if (!row || row.$deleted || row.effect_kind !== "grant") continue;
    if (fireLabel && row.effect_label === fireLabel) { grantRow = row; break; }
    if (!grantRow) grantRow = row;
  }
  if (!grantRow) return { rows: out, healingObj: null };

  const grantResource = String(grantRow.grant_resource ?? "").toLowerCase();
  const grantBase = evaluateFormula(grantRow.grant_amount, resolver, 0);
  // Secret Formula (and any restore modifier): add the SHARED restore bonus —
  // the SAME resolveRestoreParts that applyGrantEffect uses at resolve, so the
  // card preview and the applied heal can't drift. The PARTS (attributed to each
  // AE source, e.g. "Secret Formula") feed the Healing tooltip's itemized
  // breakdown, mirroring the damage side. Positive restores only.
  const restoreParts = grantBase > 0
    ? resolveRestoreParts({ actor: liveAttacker, kind: ar?.kind })
    : [];
  const restoreBonus = sumRestoreParts(restoreParts);
  // Potion Rain spread (adjust_grant): apply the action's restore op to the FINAL
  // restore (after the modifier bonus) — same applyGrantAdjust RESOLVE uses, so
  // the previewed heal and the applied heal match. No-op when absent.
  const grantAmount = applyGrantAdjust(
    grantBase + (restoreBonus > 0 ? restoreBonus : 0),
    ar?.grantAdjust,
  );
  if (!(grantAmount > 0) || !["hp", "mp"].includes(grantResource)) return { rows: out, healingObj: null };

  for (const e of targets) {
    const tActor = await fromUuid(e.actorUuid).catch(() => null);
    const curKey = grantResource === "mp" ? "current_mp" : "current_hp";
    const maxKey = grantResource === "mp" ? "max_mp" : "max_hp";
    const cur = Number(tActor?.system?.props?.[curKey] ?? 0) || 0;
    const max = Number(tActor?.system?.props?.[maxKey] ?? 0) || 0;
    const isCasterSelf = e.actorUuid === ar?.attackerActorRef;
    const vismagusSuppress = !!ar?.vismagusHpPaid && isCasterSelf && grantResource === "hp";
    const amount = vismagusSuppress ? 0 : grantAmount;
    out.push({
      target: { actorUuid: e.actorUuid, tokenUuid: e.tokenUuid, name: e.name, img: e.tokenImg,
        disposition: e.disposition, studied: true, defenseShown: 0 },
      outcome: { kind: "auto", hit: true, margin: null, tier: null, source: null },
      effects: [{
        id: `primary-heal:${e.tokenUuid}`, type: "heal", valence: "beneficial",
        source: "skill", targetRef: e.tokenUuid, resource: grantResource, value: amount,
      }],
      _parity: {
        defense: 0, hit: true, crit: false, grantAmount: amount, grantResource,
        resourceCur: cur, resourceMax: max, affinity: "NE", studied: true,
        vismagusSuppressed: vismagusSuppress || undefined,
      },
    });
  }
  const healingObj = {
    base: grantAmount, element: grantResource === "mp" ? "mp" : "healing", resource: grantResource,
    ignoreHR: true, finalIfHit: grantAmount, declaresHealing: grantResource === "hp", isHealing: true,
    // Itemized restore-modifier sources (e.g. "Secret Formula: +20") — the
    // Healing tooltip renders these under "Base bonus", same as damage baseParts.
    baseParts: restoreParts,
  };
  return { rows: out, healingObj };
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
  const resolver = buildSkillResolver({
    actor: liveAttacker, payload: null, skill, round: ctx?.round ?? 0,
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
    const heal = await buildHealPerTarget({ view, ar, targets, resolver, liveAttacker });
    if (heal.rows.length) { perTarget = perTarget.concat(heal.rows); healingObj = heal.healingObj; }
  }

  const { selfEffects, targetedEffects } = gatherEffectPreviews({ view, resolver, chainVars: ctx?.chainVars ?? null });

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
          const dmg = (r.effects ?? []).find((x) => x.type === "damage" && x.range);
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
// flattenRow rebuilds the flat perTargetResults entry from the structured row +
// its _parity mirror, kind-aware (Attack carries pierceMiss; heal rows differ).
function flattenRow(r, kind) {
  const p = r._parity ?? {};
  const t = r.target ?? {};
  const baseFields = {
    tokenUuid: t.tokenUuid, actorUuid: t.actorUuid, name: t.name, tokenImg: t.img,
    disposition: t.disposition, defense: p.defense ?? t.defenseShown ?? 0,
    hit: !!p.hit, crit: !!p.crit, affinity: p.affinity ?? "NE", studied: p.studied ?? true,
  };
  if (typeof p.grantAmount === "number") {
    // Heal/grant row.
    return {
      ...baseFields, grantAmount: p.grantAmount, grantResource: p.grantResource,
      resourceCur: p.resourceCur, resourceMax: p.resourceMax,
      ...(p.vismagusSuppressed ? { vismagusSuppressed: true } : {}),
    };
  }
  // Damage row. Attack rows carry pierceMiss but NOT resource; Skill/Spell rows
  // carry resource (hp/mp) but not pierceMiss — match COMPUTE exactly.
  const out = {
    damageModParts: p.damageModParts ?? [],
    ...baseFields,
    rawDamage: p.rawDamage ?? 0, damage: p.damage ?? 0,
  };
  if (kind === "Attack") out.pierceMiss = !!p.pierceMiss;
  else out.resource = p.resource ?? "hp";
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
      const p = r._parity ?? {};
      if (p.hit && Array.isArray(p.reactionParts) && p.reactionParts.length) return p.reactionParts;
    }
    return [];
  })();
  const reactionDelta = repReactionParts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const damageObj = hasDamage ? (kind === "Attack" ? {
    base: prim.damageBonus + prim.outgoingTotal + reactionDelta,
    baseParts: [...(prim.baseParts ?? prim.outgoingParts ?? []), ...repReactionParts],
    element: prim.overriddenElement ?? prim.nativeElement ?? prim.element,
    ignoreHR: attackIgnoreHR,
    ...(profile._summary?.hrZeroReason ? { hrZeroReason: profile._summary.hrZeroReason } : {}),
    finalIfHit: effectiveHr + prim.damageBonus + prim.outgoingTotal + reactionDelta,
  } : {
    base: prim.damageBonus + prim.outgoingTotal + reactionDelta,
    baseParts: [...(prim.outgoingParts ?? []), ...repReactionParts],
    element: prim.element, resource: prim.resource,
    ignoreHR: !roll,
    finalIfHit: effectiveHr + prim.damageBonus + prim.outgoingTotal + reactionDelta,
  }) : null;

  // hitTokenUuids — for a Check, the hit rows; with NO Check, ALL action
  // targets (matches COMPUTE: no-Check skills auto-hit every target, even
  // pure-buff skills that produce zero per-target rows).
  const hitTokenUuids = check.required
    ? (profile.perTarget ?? []).filter((r) => !!r._parity?.hit).map((r) => r.target.tokenUuid)
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

  const arRows = ar?.perTargetResults ?? [];
  const byUuid = new Map();
  for (const r of profile.perTarget ?? []) byUuid.set(r.target.actorUuid, r._parity ?? {});
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
