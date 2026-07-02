// State-entry snapshot helpers.
// See docs/battle-director-design.md §8 — every state captures an immutable
// snapshot of its inputs at entry so the state body operates on a frozen
// view rather than racing with live document mutations.

import { warn } from "./logger.js";
import { getActorKind, getNpcAttackItems } from "./actor-shape.js";
import { buildSkillResolver, evaluateFormula, isFormulaString } from "./skill-formulas.js";
import { hasIgnoreActionGating, snapshotUltimaBundle } from "./domination.js";

const FLAG_NS = "fabula-ultima-companion";

// Element → affinity_N prop key mapping, mirroring legacy AdvanceDamage.js
// line 278. The CSB template stores elemental affinities under numbered keys
// (`affinity_1` etc.) — these are dropdown values: "" / "NE" (neutral),
// "VU" (vulnerable, 2x), "RS" (resistant, 0.5x), "IM" (immune, 0), or
// "AB" (absorbing, heal).
export const AFFINITY_KEY = Object.freeze({
  physical: "affinity_1",
  air:      "affinity_2",
  bolt:     "affinity_3",
  dark:     "affinity_4",
  earth:    "affinity_5",
  fire:     "affinity_6",
  ice:      "affinity_7",
  light:    "affinity_8",
  poison:   "affinity_9",
});

// Read all 9 elemental affinities for an actor in one pass. Returns a frozen
// map keyed by element name. Missing / empty values are normalised to "NE"
// so downstream consumers don't have to defend against undefined.
export function readAffinities(actor) {
  const props = actor?.system?.props ?? actor?.system ?? {};
  const out = {};
  for (const [element, key] of Object.entries(AFFINITY_KEY)) {
    const raw = String(props?.[key] ?? "").trim().toUpperCase();
    out[element] = (raw === "VU" || raw === "RS" || raw === "IM" || raw === "AB") ? raw : "NE";
  }
  return Object.freeze(out);
}

// Status conditions that force Vulnerable on a specific element when
// applied — mirrored from AdvanceDamage.js line 588 (legacy condVU map).
const FORCED_VU_BY_STATUS = Object.freeze({
  Wet: "bolt",
  Oil: "fire",
  Petrify: "earth",
  Hypothermia: "ice",
  Turbulence: "air",
  Zombie: "light",
});

// Read the list of active-effect labels currently on an actor. Used by the
// affinity resolver to apply forced-VU from status conditions.
function readActiveConditions(actor) {
  try {
    const effs = actor?.effects ?? actor?.appliedEffects ?? [];
    const labels = [];
    for (const e of effs) {
      const label = e?.label ?? e?.name ?? null;
      if (label) labels.push(String(label));
    }
    return labels;
  } catch (_) { return []; }
}

// Resolve the effective affinity code for an actor against a given element,
// honouring status-condition forced-Vulnerable. Returns "VU"/"RS"/"IM"/"AB"
// or "NE".
export function resolveAffinity(actor, element) {
  const el = String(element ?? "physical").toLowerCase();
  const affinities = readAffinities(actor);
  let code = affinities[el] ?? "NE";

  // Status-forced VU overrides — applied AFTER reading the sheet affinity.
  // Mirrors legacy AdvanceDamage line 589-591: any of these conditions on
  // the actor, paired with the matching element, forces VU regardless of
  // the sheet value (so a fire-resistant actor doused in Oil still takes
  // doubled fire damage).
  const conditions = readActiveConditions(actor);
  for (const cond of conditions) {
    const forcedEl = FORCED_VU_BY_STATUS[cond];
    if (forcedEl && forcedEl === el) { code = "VU"; break; }
  }
  return code;
}

// Apply an affinity code to a damage value. Returns the post-affinity
// damage (always non-negative). The caller checks `affinity === "AB"`
// separately to flip the effect direction (heal instead of damage) — the
// `value` returned is always the absolute amount.
//   VU → ceil(damage * 2)
//   RS → ceil(damage / 2)
//   IM → 0
//   AB → damage (caller flips to heal)
//   NE → damage
export function applyAffinityToDamage(damage, code) {
  const base = Math.max(0, Number(damage) | 0);
  switch (code) {
    case "VU": return Math.ceil(base * 2);
    case "RS": return Math.ceil(base / 2);
    case "IM": return 0;
    default:   return base;
  }
}

// Weapon efficiency — the target's per-weapon-type incoming multiplier (RAW
// per-weapon armor/vulnerability). The INCOMING twin of element affinity:
// element → `affinity_N` (VU/RS/IM/AB), weapon family → `<family>_ef` (a percent,
// 25–200, default 100). One resolver so both the effect ruleset and the attack
// path read the same source of truth.
//
// `weaponType` may be the bare family ("sword", "brawling", "arcane") — the BD
// weapon snapshot's form — or the already-suffixed legacy key ("sword_ef"); both
// resolve to `system.props.<family>_ef`. No type / "none" → 100 (inert), so
// spells / MP / effect damage pass through untouched. Returns a percent; the
// caller applies `ceil(value * pct / 100)`. Mirrors legacy `actorData[weaponType]
// || 100` — 0 / NaN / missing all fold to 100 (no accidental zero-out).
export function readWeaponEfficiency(target, weaponType) {
  const fam = String(weaponType ?? "").trim().toLowerCase();
  if (!fam || fam === "none" || fam === "none_ef") return 100;
  const key = fam.endsWith("_ef") ? fam : `${fam}_ef`;
  const v = Number(target?.system?.props?.[key]);
  return Number.isFinite(v) && v > 0 ? v : 100;
}

// Numeric prop reader with multiple candidate keys + default.
export function readPropNum(actor, keys, fallback = 0) {
  const props = actor?.system?.props ?? actor?.system ?? {};
  for (const k of keys) {
    const v = props?.[k];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// Look up a CSB attribute die size for an actor. Default to d8.
export function attrDieSize(actor, key) {
  if (!actor) return 8;
  const A = String(key || "").toUpperCase();
  const a = A.toLowerCase();
  const props = actor?.system?.props ?? actor?.system ?? {};
  const candidates = [
    props[`${A}_die_size`],
    props[`${A}_die`],
    props[`current_${A}_die`],
    props[`current_${A}`],
    // Canonical CSB attribute-die props (used by NPCs + the skill-formulas
    // INS_CURRENT_DIE / INS_BASE_DIE identifiers): lowercase `<attr>_current`
    // (post-reduction) then `<attr>_base`. Without these, NPCs — which store
    // their die ONLY in `dex_base` etc. — fell through to the d8 default, so
    // every NPC check/attack rolled d8 regardless of its real attributes.
    props[`${a}_current`],
    props[`${a}_base`],
    props[A],
  ];
  for (const c of candidates) {
    const s = String(c ?? "").replace(/[^0-9]/g, "");
    const n = Number(s);
    if (Number.isFinite(n) && n >= 4) return n;
  }
  return 8;
}

// Resolve the attacker's currently-equipped weapon for Attack actions.
//
// Reads the same actor props the legacy `[Macro] Attack - Player.js` macro
// reads (lines 86-120) so the formulas line up: main_hand name lookup in
// weapon_list, main_attrib_1/2, weapon1_mod (accuracy bonus), weapon1_damage
// (damage bonus), weapon1_damagetype, plus weapon_range / weapon_type from
// the weapon_list entry.
//
// `which`: "main" | "off" — which equipped hand to read. Defaults to "main".
//
// Unified DEF-vs-MDEF resolution. An explicit per-item `defense_target_type`
// ("def" | "mdef") — declared on a weapon (Arc Wand's "deals Magic Damage") or a
// skill (Soul Steal / Pillage) — WINS. Absent that, the default falls back to the
// action kind: Spells resolve vs Magic Defense, everything else (Attacks,
// non-Spell Skills) vs Defense. Single source of truth for the per-target engine,
// the card labels, and the redirect recompute so they can never drift apart.
export function resolvesVsMagicDefense({ defenseTargetType, isSpell } = {}) {
  const dtt = String(defenseTargetType ?? "").trim().toLowerCase();
  if (dtt === "mdef") return true;
  if (dtt === "def") return false;
  return !!isSpell;
}

// Returns null if the requested hand isn't equipped or resolves to a shield
// (attribute "SHI"). Caller decides whether to fall back to the other hand
// or refuse the action.
//
// Buff effects (extra_damage_mod_*, check_mod_*) are NOT applied
// here — that's a later slice. We surface the raw weapon stats so the
// Compute state can roll them; buff aggregation happens above.
export function resolveAttackerWeapon(actor, { which = "main" } = {}) {
  if (!actor) return null;
  const props = actor?.system?.props ?? actor?.system ?? {};
  const weaponList = Object.values(props?.weapon_list ?? {});
  const isMain = which === "main";

  const handName = isMain ? props.main_hand : props.off_hand;
  if (!handName) return null;

  const entry = weaponList.find((w) => w?.name === handName) ?? null;

  // Attribute pair. Empty/SHI means no usable weapon in this hand.
  const A1 = String(isMain ? (props.main_attrib_1 ?? "") : (props.off_attrib_1 ?? "")).toUpperCase();
  const A2 = String(isMain ? (props.main_attrib_2 ?? "") : (props.off_attrib_2 ?? "")).toUpperCase();
  if (!A1 || A1 === "SHI" || A1 === "UNDEFINED") return null;

  // Accuracy bonus + damage bonus + damage type per hand. The off-hand
  // prop names are genuinely inverted in the CSB template (off_mod_1 is
  // accuracy, off_mod_2 is damage) — that's not a typo, it mirrors the
  // shipped data shape.
  // `let` (not const): the weapon-form overlay below may re-project these.
  let checkBonus = Number(
    isMain ? (props.weapon1_mod ?? 0) : (props.off_mod_1 ?? 0)
  ) || 0;
  let damageBonus = Number(
    isMain ? (props.weapon1_damage ?? 0) : (props.off_mod_2 ?? 0)
  ) || 0;
  let damageType = String(
    isMain ? (props.weapon1_damagetype ?? "Physical") : (props.weapon2_damagetype ?? "Physical")
  );

  const range = String(entry?.weapon_range ?? "Melee");
  let weaponType = String(entry?.weapon_type ?? entry?.category ?? entry?.type ?? "");

  // Resolve the live weapon Item. The entry's `uuid` field is canonical (the
  // `id` field is an unresolved CSB template literal `${item.id}$`). When the
  // weapon_list entry is absent (most PCs carry main_hand as a bare name with
  // no container entry), fall back to matching an embedded weapon Item by
  // name. The resolved Item drives both the sheet image AND — since Option B —
  // its `uuid` is threaded onto the profile so on-hit reaction rows on the
  // weapon attribute to THIS weapon (see weaponReactionInPlay in skill-effects).
  let weaponItem = null;
  if (entry?.uuid) {
    try { weaponItem = actor.items?.get?.(String(entry.uuid).split(".").pop()) ?? null; } catch (_) {}
  }
  if (!weaponItem) {
    weaponItem = actor.items?.find?.(
      (i) => i?.name === handName &&
        String(i?.system?.props?.item_type ?? "").toLowerCase() === "weapon"
    ) ?? null;
  }
  const imageUrl = entry?.img ?? entry?.image ?? weaponItem?.img ?? null;

  // ── Weapon-form overlay ────────────────────────────────────────────────
  // A weapon may define alternate FORMS (e.g. Zarg's Bow: Physical ⇄ Light).
  // A form shares the weapon's identity — it's the SAME Item, so its linked
  // skills are retained — and only re-projects a subset of combat stats.
  //   - form table: weaponItem.system.props.weapon_forms (flag fallback)
  //   - active index: weaponItem.flags[FLAG_NS].activeForm (0 = base, no overlay)
  // Element + weapon type are absolute overrides. Damage/accuracy are applied
  // as DELTAS vs the weapon's BASE values, because checkBonus/damageBonus here
  // already carry the CSB-derived actor buffs (weapon1_mod / weapon1_damage) —
  // a flat override would silently discard those buffs.
  try {
    const wp = weaponItem?.system?.props ?? {};
    // CSB stores a props array as an object keyed "0","1",… (same as
    // weapon_list above) — normalise either shape to an ordered array.
    const rawForms = (wp.weapon_forms && typeof wp.weapon_forms === "object")
      ? wp.weapon_forms
      : (weaponItem?.flags?.[FLAG_NS]?.weaponForms ?? null);
    const forms = rawForms ? Object.values(rawForms) : [];
    const fIdx = Number(weaponItem?.flags?.[FLAG_NS]?.activeForm ?? 0) || 0;
    const form = (fIdx > 0 && fIdx < forms.length) ? forms[fIdx] : null;
    if (form) {
      if (form.type_damage) damageType = String(form.type_damage);
      const ft = String(form.weapon_type ?? "").trim();
      if (ft) weaponType = ft;
      const baseDmg = Number(wp.damage_bonus ?? 0) || 0;
      const baseAcc = Number(wp.check_bonus ?? 0) || 0;
      const fDmg = Number(form.damage_bonus);
      const fAcc = Number(form.check_bonus);
      if (Number.isFinite(fDmg)) damageBonus += (fDmg - baseDmg);
      if (Number.isFinite(fAcc)) checkBonus  += (fAcc - baseAcc);
    }
  } catch (e) { warn("resolveAttackerWeapon: weapon-form overlay failed", e); }

  return Object.freeze({
    hand: which,
    name: String(handName),
    A1, A2,
    checkBonus,
    damageBonus,
    damageType,
    range,
    weaponType,
    // Flying exception (Psychokinesis): does the wielder's kit let THIS weapon's
    // category reach Flying targets in melee? Read by applyAttackRangeGate.
    canMeleeFlying: attackerCanMeleeFlying(actor, weaponType),
    imageUrl,
    // Live weapon Item uuid — null when the weapon isn't an embedded Item
    // (on-hit reaction effects simply won't fire then; the basic attack
    // still resolves from the derived stats above).
    uuid: weaponItem?.uuid ?? null,
    // Targeting text (Option B), mirrors buildPseudoWeaponFromNpcAttack so the
    // Attack TARGET branch honors a weapon's own skill_target (e.g. a whip that
    // hits all enemies). Blank → the branch falls back to "One Enemy".
    skillTarget: String(weaponItem?.system?.props?.skill_target ?? "").trim().toLowerCase(),
    // Effect prose (e.g. "On hit, inflicts Bleed") — surfaced in the action
    // card's Effect section. Mirrors the NPC pseudo-weapon so a PC weapon with
    // an on-hit effect shows it on the attack card too.
    descriptionHtml: String(weaponItem?.system?.props?.description ?? ""),
    // Inherent always-on action keywords declared on the weapon Item via its
    // `action_keywords` prop (comma/newline list — the SAME keyword vocabulary
    // skills use, e.g. "pierce"). An Attack's `view.source` is null, so
    // describePrimary folds these off the weapon snapshot into primary.keywords
    // (parity with a skill's inherent keywords). This is how a weapon carries a
    // mechanical action keyword like Pierce (Windpiercer) — no bespoke per-quality
    // boolean; a future benign weapon is just action_keywords:"benign".
    actionKeywords: String(weaponItem?.system?.props?.action_keywords ?? ""),
    // Explicit defense target for this weapon's Attacks ("def" | "mdef"). A weapon
    // that "deals Magic Damage" (Arc Wand) sets `defense_target_type: "mdef"` so its
    // Attack resolves vs Magic Defense; blank falls back to the kind default
    // (Attack → DEF) via resolvesVsMagicDefense. No bespoke per-weapon boolean.
    defenseTargetType: String(weaponItem?.system?.props?.defense_target_type ?? "").trim().toLowerCase(),
  });
}

// Resolve virtual attack profiles exposed by AEs on the actor.
//
// An AE can expose a synthetic attack option by carrying
//   flags.fabula-ultima-companion.exposedVirtualAttack = {
//     profile: { name, A1, A2, damageBonus, damageType, range, weaponType, ... },
//     condition_formula: "EQUIPPED_SHIELD_COUNT >= 2"   // optional
//   }
// When `condition_formula` is present and evaluates truthy (or absent),
// the profile is included in the snapshot's `virtualAttacks` list and
// becomes pickable in the weapon-mode picker. Used by Dual Shieldbearer
// to expose "Twin Shields" when the bearer has two shields equipped;
// generalises to any future "wield X+Y, gain access to Z attack" rule.
//
// Formula resolution at snapshot time means the bonus values are
// frozen — re-equip after snapshot doesn't re-evaluate until the next
// snapshot. That's fine for the current authoring model (Dual
// Shieldbearer scenarios don't have mid-turn shield swaps).
export function resolveVirtualAttacks(actor) {
  if (!actor) return Object.freeze([]);
  // Foundry V12: `actor.effects.contents` lists only actor-stamped AEs;
  // item-owned `transfer:true` templates land in `actor.appliedEffects`
  // (already filtered for disabled/suppressed). DSB's AE lives on the
  // skill item with transfer:true, so we MUST read appliedEffects.
  // Fallback chain covers both V12 and legacy code paths.
  let effs = [];
  try {
    if (actor.appliedEffects) effs = Array.from(actor.appliedEffects);
    else if (actor.allApplicableEffects) effs = Array.from(actor.allApplicableEffects()).filter((e) => !e.disabled);
    else if (actor.effects?.contents) effs = actor.effects.contents;
    else if (actor.effects) effs = Array.from(actor.effects);
  } catch (e) {
    warn("resolveVirtualAttacks: effect enumeration threw", e);
    effs = [];
  }
  if (!effs.length) return Object.freeze([]);

  const resolver = buildSkillResolver({ actor });
  const out = [];
  for (const ae of effs) {
    if (ae?.disabled) continue;
    const spec = ae?.flags?.[FLAG_NS]?.exposedVirtualAttack;
    if (!spec || typeof spec !== "object") continue;

    // Gate by condition_formula. Absent → always exposes.
    const cond = spec.condition_formula;
    if (cond != null && cond !== "") {
      const ok = isFormulaString(cond)
        ? evaluateFormula(cond, resolver, 0)
        : Number(cond);
      if (!ok) continue;
    }

    const profile = spec.profile ?? {};
    const A1 = String(profile.A1 ?? profile.rolled_atr1 ?? "MIG").toUpperCase();
    const A2 = String(profile.A2 ?? profile.rolled_atr2 ?? "MIG").toUpperCase();
    const damageBonusRaw = profile.damageBonus ?? profile.damage_bonus ?? 0;
    const checkBonusRaw  = profile.checkBonus  ?? profile.check_bonus  ?? 0;

    const damageBonus = isFormulaString(damageBonusRaw)
      ? evaluateFormula(damageBonusRaw, resolver, 0)
      : (Number(damageBonusRaw) || 0);
    const checkBonus = isFormulaString(checkBonusRaw)
      ? evaluateFormula(checkBonusRaw, resolver, 0)
      : (Number(checkBonusRaw) || 0);

    out.push(Object.freeze({
      hand: "virtual",
      virtualIndex: out.length,
      name: String(profile.name ?? ae.name ?? "Virtual Attack"),
      A1, A2,
      checkBonus,
      damageBonus,
      damageType: String(profile.damageType ?? profile.type_damage ?? "Physical"),
      range: String(profile.range ?? profile.weapon_range ?? "Melee"),
      weaponType: String(profile.weaponType ?? profile.category ?? "Brawling"),
      canMeleeFlying: attackerCanMeleeFlying(actor, String(profile.weaponType ?? profile.category ?? "Brawling")),
      imageUrl: profile.imageUrl ?? profile.img ?? ae.icon ?? null,
      sourceAeId: ae.id,
      sourceAeName: ae.name,
    }));
  }

  return Object.freeze(out);
}

// Resolve the weapon a skill marked `rolled_atr1:"WEAPON"` should roll its
// accuracy off — the SAME weapon the Attack action reaches for first, in the
// weapon-mode picker's order: equipped MAIN hand, else OFF hand, else the first
// exposed VIRTUAL attack (e.g. Dual Shieldbearer's Twin Shields, when both hands
// hold shields and carry no usable weapon attribute). Returns the weapon-shape
// object ({ A1, A2, checkBonus, damageBonus, ... }) or null when the wielder has
// no attack weapon at all. Used by the Skill COMPUTE ar-build.
export function resolvePrimaryAttackWeapon(actor) {
  if (!actor) return null;
  const main = resolveAttackerWeapon(actor, { which: "main" });
  if (main?.A1) return main;
  const off = resolveAttackerWeapon(actor, { which: "off" });
  if (off?.A1) return off;
  const virtuals = resolveVirtualAttacks(actor);
  if (virtuals?.length && virtuals[0]?.A1) return virtuals[0];
  return null;
}

// Does any applied AE grant mixed-Category Two-Weapon Fighting? Declarative seam
// mirroring exposedVirtualAttack (resolveVirtualAttacks above): an AE carries
//   flags.fabula-ultima-companion.allowMixedTwoWeapon = true
//     // or { condition_formula: "<formula>" } for a gated grant
// so the engine never hardcodes a skill name. The Ambidextrous Heroic Skill
// ("fight with two weapons of different Categories") authors this flag on a
// transfer:true passive AE; any future "lift the same-Category rule" skill is
// pure authoring. Returns true once any non-disabled exposing AE's condition
// holds (absent/empty condition = always grants while owned).
export function actorAllowsMixedTwoWeapon(actor) {
  if (!actor) return false;
  let effs = [];
  try {
    if (actor.appliedEffects) effs = Array.from(actor.appliedEffects);
    else if (actor.allApplicableEffects) effs = Array.from(actor.allApplicableEffects()).filter((e) => !e.disabled);
    else if (actor.effects?.contents) effs = actor.effects.contents;
    else if (actor.effects) effs = Array.from(actor.effects);
  } catch (e) {
    warn("actorAllowsMixedTwoWeapon: effect enumeration threw", e);
    return false;
  }
  if (!effs.length) return false;
  let resolver = null;
  for (const ae of effs) {
    if (ae?.disabled) continue;
    const spec = ae?.flags?.[FLAG_NS]?.allowMixedTwoWeapon;
    if (spec == null || spec === false) continue;
    if (spec === true) return true;
    if (typeof spec === "object") {
      const cond = spec.condition_formula;
      if (cond == null || cond === "") return true;
      resolver ??= buildSkillResolver({ actor });
      const ok = isFormulaString(cond) ? evaluateFormula(cond, resolver, 0) : Number(cond);
      if (ok) return true;
    }
  }
  return false;
}

// ── Two-Weapon Fighting eligibility as DATA ─────────────────────────────────
// The base RAW rule (Core p.69) is expressed as a data rule, and skills relax it
// by authoring data grants — the engine never branches on a skill name or a
// weapon Category literal.
//
// Rule shape:
//   requireOffhand  — needs a SEPARATE off-hand weapon (genuine TWF). A
//                     two-handed weapon (off-hand empty) can never satisfy this.
//   sameCategory    — (requireOffhand only) both weapons must share a Category.
//   soloWeapon      — ONE equipped weapon performs both attacks; off-hand MUST
//                     be empty (Double Arrow: a lone bow). The base rule never
//                     sets this, so a two-handed weapon stays a single attack
//                     unless a soloWeapon grant explicitly opts its Category in.
//   category        — "" = any; else the (main) weapon's Category must match.
const BASE_TWO_WEAPON_RULE = Object.freeze({
  requireOffhand: true, sameCategory: true, soloWeapon: false, category: "",
});

// Collect data-described Two-Weapon RELAXATIONS from the actor's AEs. An AE
// carries flags.fabula-ultima-companion.twoWeaponGrant = <grant> | <grant>[]:
//   grant = { soloWeapon?:bool, mixed?:bool, category?:string, condition_formula?:string }
// soloWeapon → lone-weapon double attack (off-hand empty), Category-gated.
// mixed      → lift the same-Category rule for two real weapons (the data form
//              of the legacy allowMixedTwoWeapon, which is still honored below).
export function actorTwoWeaponGrants(actor) {
  const out = [];
  if (!actor) return out;
  let effs = [];
  try {
    if (actor.appliedEffects) effs = Array.from(actor.appliedEffects);
    else if (actor.allApplicableEffects) effs = Array.from(actor.allApplicableEffects()).filter((e) => !e.disabled);
    else if (actor.effects?.contents) effs = actor.effects.contents;
    else if (actor.effects) effs = Array.from(actor.effects);
  } catch (e) { warn("actorTwoWeaponGrants: effect enumeration threw", e); effs = []; }
  let resolver = null;
  const passesCond = (cond) => {
    if (cond == null || cond === "") return true;
    resolver ??= buildSkillResolver({ actor });
    return !!(isFormulaString(cond) ? evaluateFormula(cond, resolver, 0) : Number(cond));
  };
  for (const ae of effs) {
    if (ae?.disabled) continue;
    const spec = ae?.flags?.[FLAG_NS]?.twoWeaponGrant;
    if (!spec) continue;
    const grants = Array.isArray(spec) ? spec : [spec];
    for (const g of grants) {
      if (!g || typeof g !== "object") continue;
      // A grant must declare an actual relaxation. `soloWeapon` = lone-weapon
      // double attack; `mixed` = lift the same-Category rule for two real
      // weapons (the data form of legacy allowMixedTwoWeapon). A grant that
      // sets NEITHER is a no-op — skip it. This makes the `mixed` field real
      // and means a stray/blank grant (e.g. a GM saving the AE-sheet panel
      // with nothing enabled) can never accidentally hand out mixed TWF.
      const solo = !!g.soloWeapon;
      const mixed = !!g.mixed;
      if (!solo && !mixed) continue;
      if (!passesCond(g.condition_formula)) continue;
      out.push({
        soloWeapon: solo,
        requireOffhand: !solo,
        sameCategory: false,   // a relaxation never re-imposes same-Category
        category: String(g.category ?? "").trim().toLowerCase(),
      });
    }
  }
  // Back-compat: fold the legacy allowMixedTwoWeapon flag (Ambidextrous) into a
  // mixed grant so existing skills keep working without re-authoring.
  if (actorAllowsMixedTwoWeapon(actor)) {
    out.push({ soloWeapon: false, requireOffhand: true, sameCategory: false, category: "" });
  }
  return out;
}

// Evaluate the ordered rule list against the equipped weapons. Returns
// { ok, off }: off is the weapon driving the SECOND attack (the off-hand for
// genuine TWF, or the main weapon itself for a soloWeapon grant).
export function evaluateTwoWeaponRules(weapon, offWeapon, rules) {
  const cat = (w) => String(w?.weaponType ?? "").trim().toLowerCase();
  const mt = cat(weapon), ot = cat(offWeapon);
  for (const r of rules ?? []) {
    if (r.category && r.category !== mt) continue;
    if (r.soloWeapon) {
      // Lone-weapon double attack: the SAME weapon fires twice (Double Arrow).
      if (weapon && !offWeapon && mt) return { ok: true, off: weapon, solo: true };
    } else if (r.requireOffhand) {
      if (weapon && offWeapon && mt && ot && (!r.sameCategory || mt === ot)) {
        return { ok: true, off: offWeapon, solo: false };
      }
    }
  }
  return { ok: false, off: null, solo: false };
}

// Build the weapon-related fields for a combatant snapshot — main weapon,
// off-hand, and the two-weapon eligibility flag — in one safe pass. Each
// piece is individually defended: if `resolveAttackerWeapon` throws for one
// hand, we still return the other plus `canTwoWeaponFight: false`. The
// snapshot must NEVER fail because of a malformed weapon entry — the
// attacker just ends up with no weapon and TARGET / COMPUTE handle that.
function buildWeaponBundle(actor) {
  // NPC actors have no equipped-weapon concept. They attack via Items with
  // skill_type === "Attack" (see actor-shape.js). Return empty weapon
  // fields + a list of the attack-item UUIDs so the compose / TARGET
  // phases can build the NPC picker from the snapshot alone.
  const kind = getActorKind(actor);
  if (kind === "npc") {
    let npcAttackItems = [];
    try {
      npcAttackItems = getNpcAttackItems(actor).map((it) => Object.freeze({
        uuid: it.uuid,
        id: it.id,
        name: it.name,
        img: it.img ?? null,
      }));
    } catch (e) {
      warn("buildWeaponBundle: getNpcAttackItems threw", e);
    }
    return {
      actorKind: "npc",
      weapon: null,
      offWeapon: null,
      canTwoWeaponFight: false,
      npcAttackItems: Object.freeze(npcAttackItems),
      virtualAttacks: Object.freeze([]),
    };
  }

  let weapon = null;
  let offWeapon = null;
  try { weapon = resolveAttackerWeapon(actor, { which: "main" }); }
  catch (e) { warn("buildWeaponBundle: main resolve threw", e); weapon = null; }
  try { offWeapon = resolveAttackerWeapon(actor, { which: "off" }); }
  catch (e) { warn("buildWeaponBundle: off resolve threw", e); offWeapon = null; }

  let canTwoWeaponFight = false;
  let twoWeaponSolo = false;
  try {
    // Eligibility = the base RAW rule + any data grants the actor's AEs author.
    // A soloWeapon grant (Double Arrow: lone bow) sets the SECOND attack to use
    // the same weapon, so we adopt the returned `off` as the off-hand and flag
    // `twoWeaponSolo` so the picker can present it as "attack twice with one
    // weapon" rather than a confusing "Weapon → Weapon" dual entry.
    const rules = [BASE_TWO_WEAPON_RULE, ...actorTwoWeaponGrants(actor)];
    const ev = evaluateTwoWeaponRules(weapon, offWeapon, rules);
    canTwoWeaponFight = ev.ok;
    twoWeaponSolo = !!ev.solo;
    if (ev.ok && ev.off) offWeapon = ev.off;
  } catch (e) { warn("buildWeaponBundle: canTwoWeaponFight threw", e); }

  let virtualAttacks = Object.freeze([]);
  try { virtualAttacks = resolveVirtualAttacks(actor); }
  catch (e) { warn("buildWeaponBundle: resolveVirtualAttacks threw", e); }

  return { actorKind: kind, weapon, offWeapon, canTwoWeaponFight, twoWeaponSolo, npcAttackItems: Object.freeze([]), virtualAttacks };
}

// Director-owned snapshot. Takes a DirectorCombatant (live tokenDoc + actorDoc
// refs) and produces the same frozen shape that snapshotCombatant returns.
// This is what TurnStart calls in the dCombat path.
export function snapshotDirectorCombatant(dc) {
  try {
    if (!dc) { warn("snapshotDirectorCombatant: null combatant"); return null; }
    const tokenDoc = dc.tokenDoc;
    const actor = dc.actorDoc;
    if (!tokenDoc) { warn("snapshotDirectorCombatant: combatant missing tokenDoc", dc.id); return null; }
    if (!actor) { warn("snapshotDirectorCombatant: combatant missing actor", dc.id); return null; }
    return Object.freeze({
      // dCombatantId — the director's combatant id (NOT a Foundry combatant)
      combatantId: dc.id,
      tokenId: tokenDoc.id,
      tokenUuid: tokenDoc.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name ?? dc.name ?? "Unknown",
      tokenImg: tokenDoc.texture?.src ?? tokenDoc.img ?? actor.img ?? null,
      disposition: dc.disposition ?? tokenDoc.disposition ?? 0,
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      attributes: Object.freeze({
        DEX: attrDieSize(actor, "DEX"),
        INS: attrDieSize(actor, "INS"),
        MIG: attrDieSize(actor, "MIG"),
        WLP: attrDieSize(actor, "WLP"),
      }),
      // Default fumble threshold per RAW: a Fumble is two 1s. Per-actor
      // override via `fumble_threshold` (the highest die value that still
      // counts as a fumbled die — both dice must be ≤ threshold).
      fumbleThreshold: readPropNum(actor, ["fumble_threshold"], 1),
      // Action-gating debuffs (Frightened/Silence/Confused/Disarmed/Berserk) →
      // frozen Array<{label, reason}>; the Octopath menu greys + red-stamps these.
      blockedActions: snapshotBlockedActions(actor),
      // Intent-filter set (`disable_action_intent`) — the compose-action pickers
      // re-apply it per-entry (hide aid/neutral spells/skills). See Charm/Domination.
      disabledActionIntents: snapshotDisabledActionIntents(actor),
      // Boss Ultima economy — isBoss / ultimaPoints / dominancePoints /
      // isDominating. Drives the boss-only "Ultima" Octopath page.
      ...snapshotUltimaBundle(actor),
      ...buildWeaponBundle(actor),
    });
  } catch (e) {
    warn("snapshotDirectorCombatant threw", e);
    return null;
  }
}

// Snapshot the active combatant. Captures token + actor identity + a few
// numeric props so state bodies don't have to refetch.
//
// Legacy path: reads `combat.combatant` directly (Foundry Combat doc).
// Used only in the manual-fallback start path (no payload, no PREP).
export function snapshotCombatant(combat) {
  try {
    const combatant = combat?.combatant ?? null;
    if (!combatant) { warn("snapshotCombatant: no current combatant"); return null; }
    const token = combatant.token;
    const actor = combatant.actor;
    if (!token) { warn("snapshotCombatant: combatant has no token", combatant.id); return null; }
    if (!actor) { warn("snapshotCombatant: combatant has no actor", combatant.id); return null; }

    return Object.freeze({
      combatantId: combatant.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name ?? "Unknown",
      tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
      disposition: token.disposition ?? 0,
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      attributes: Object.freeze({
        DEX: attrDieSize(actor, "DEX"),
        INS: attrDieSize(actor, "INS"),
        MIG: attrDieSize(actor, "MIG"),
        WLP: attrDieSize(actor, "WLP"),
      }),
      fumbleThreshold: readPropNum(actor, ["fumble_threshold"], 1),
      blockedActions: snapshotBlockedActions(actor),
      // Intent-filter set (`disable_action_intent`) — the compose-action pickers
      // re-apply it per-entry (hide aid/neutral spells/skills). See Charm/Domination.
      disabledActionIntents: snapshotDisabledActionIntents(actor),
      // Boss Ultima economy — see snapshotDirectorCombatant.
      ...snapshotUltimaBundle(actor),
      ...buildWeaponBundle(actor),
    });
  } catch (e) {
    warn("snapshotCombatant threw", e);
    return null;
  }
}

// AE-driven target self-defense. Walks a potential target's active
// effects, collects every change row whose `key === "cannot_be_targeted_by"`,
// and returns a list of blocks each describing what attack types the
// target is protected from. Mirrors getCannotTargetReasons but reads
// from the TARGET side (vs Vanish reading the attacker side).
//
// Each AE may declare multiple ranges in one row (comma-separated). The
// canonical values are "melee", "ranged", "any" (for "spell" etc. add
// later as needed). The AE's name surfaces as the picker overlay reason
// — Cover writes "Covered", future Out-of-Sight skills would write
// "Hidden", etc.
//
// Returns Array<{ aeName: string, ranges: Set<string> }> — empty when
// no blocks apply. Caller (applyAttackRangeGate) checks whether the
// attacker's weapon range matches any block's `ranges` set.
export function getTargetSideBlocks(actor) {
  const out = [];
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  for (const ae of effects) {
    if (ae?.disabled) continue;
    const changes = ae?.changes ?? [];
    const ranges = new Set();
    for (const ch of changes) {
      if (ch?.key !== "cannot_be_targeted_by") continue;
      const raw = String(ch.value ?? "").trim().toLowerCase();
      if (!raw) continue;
      for (const r of raw.split(/[\s,]+/)) {
        const trimmed = r.trim();
        if (trimmed) ranges.add(trimmed);
      }
    }
    if (ranges.size) {
      out.push({
        aeName: String(ae.name ?? "").trim() || "Blocked",
        ranges,
      });
    }
  }
  return out;
}

// ── Flying targeting rule (RAW Core: a Flying creature can't be reached by melee) ──
// Flying is a CONFIG status effect (not a hub AE), so we read the STATUS directly
// — kept deliberately separate from the generic cannot_be_targeted_by block system
// (Cover etc.) so the two never cross-interfere. The status id is resolved once by
// name from CONFIG.statusEffects.
let _flyingStatusId;
function flyingStatusId() {
  if (_flyingStatusId !== undefined) return _flyingStatusId;
  const entry = (CONFIG.statusEffects ?? []).find(
    (s) => String(s.name ?? s.label ?? "").trim().toLowerCase() === "flying"
  );
  _flyingStatusId = entry?.id ?? null;
  return _flyingStatusId;
}

// True if `actor` currently carries the Flying status. CSB custom statuses apply
// as an AE NAMED "Flying" but DON'T populate the AE's statuses[] with the status
// id (unlike core-Foundry statuses), and actor.statuses misses it — so we match
// by the status id (core path) OR by the AE name "Flying" (the CSB path).
export function targetIsFlying(actor) {
  if (!actor) return false;
  // Forced landing (Dragontrap Bow; RAW: a flyer loses flight until the end of the
  // round when forced down / after Vulnerable damage). A "Grounded" AE carries a
  // `flying_grounded` change that temporarily SUPPRESSES Flying — the underlying
  // Flying status is left intact and resumes automatically when the Grounded AE is
  // swept at round_end (lifetimeMode "round_end"). Symmetric with the attacker-side
  // can_target_flying_with exception. appliesEffects → sees applied/transfer AEs and
  // skips disabled ones.
  const effs = actor.appliedEffects ?? actor.effects?.contents ?? actor.effects ?? [];
  for (const ae of effs) {
    if (ae?.disabled) continue;
    if ((ae.changes ?? []).some((ch) => ch?.key === "flying_grounded")) return false;
  }
  const id = flyingStatusId();
  if (id && actor.statuses?.has?.(id)) return true;
  return !!actor.effects?.some?.((e) => !e.disabled && (
    (id && e.statuses?.has?.(id)) ||
    String(e.name ?? "").trim().toLowerCase() === "flying"
  ));
}

// True if the AE change's owning item is GEAR that isn't currently equipped —
// in which case the exception it carries is dormant. A `can_target_flying_with`
// change read straight off the raw AE change can't self-gate via a
// `${isEquipped ? ...}$` value (this key isn't a CSB label prop, so that formula
// is never evaluated), so equip-gating for GEAR carriers lives here instead.
// Fail-open for non-gear carriers (a skill item like Psychokinesis has no
// item_type) so always-on passives are unaffected. Mirrors containerReactionInPlay.
const _FLYING_EXCEPTION_GEAR_TYPES = new Set(["accessory", "armor", "weapon", "shield"]);
function meleeFlyingCarrierDormant(ae) {
  const item = ae?.parent?.documentName === "Item" ? ae.parent : null;
  const itemType = String(item?.system?.props?.item_type ?? "").toLowerCase();
  if (!_FLYING_EXCEPTION_GEAR_TYPES.has(itemType)) return false; // non-gear → always live
  return item?.system?.props?.isEquipped !== true;               // gear → dormant unless equipped
}

// True if `actor` carries a melee-vs-Flying EXCEPTION covering a weapon of
// `weaponType` — Psychokinesis (skill): melee arcane/sword may target Flying;
// Jumping Boots (accessory): any weapon, while equipped. Reads
// `can_target_flying_with` AE changes — the SYMMETRIC counterpart of the
// `cannot_be_targeted_by` block (getTargetSideBlocks) — so blocks AND exceptions
// are both AE-change-driven and compose with AE suppression. The value is a
// comma-list of weapon categories (empty = any melee weapon). Reads
// `appliedEffects` so an always-on (transfer:true) passive AE is seen; a GEAR
// carrier is additionally equip-gated (meleeFlyingCarrierDormant).
export function attackerCanMeleeFlying(actor, weaponType) {
  const cat = String(weaponType ?? "").trim().toLowerCase();
  const effs = actor?.appliedEffects ?? actor?.effects?.contents ?? actor?.effects ?? [];
  for (const ae of effs) {
    if (ae?.disabled) continue;
    if (meleeFlyingCarrierDormant(ae)) continue;
    for (const ch of (ae.changes ?? [])) {
      if (ch?.key !== "can_target_flying_with") continue;
      const cats = String(ch.value ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (cats.length === 0 || cats.includes(cat)) return true;
    }
  }
  return false;
}

// Canonical turn-action labels an action-gating debuff can block. Mirrors the
// Octopath menu's action set (turn-ui-manager LEGACY_PAGES). "Switch" / "Passive"
// are menu navigation, not real actions, so they're excluded — enable_action_only
// never blocks them.
export const GATEABLE_ACTION_LABELS = Object.freeze([
  "Attack", "Guard", "Skill", "Spell", "Item",
  "Equipment", "Study", "Hinder", "Objective",
]);
const _ACTION_LABEL_CANON = new Map(GATEABLE_ACTION_LABELS.map((l) => [l.toLowerCase(), l]));

// Static classified intent of each gateable top-level action — used by the
// `disable_action_intent` filter (the "force close by intent" gate, e.g.
// Charm/Domination). Spell / Skill / Item are MIXED (intent varies per entry)
// so they're absent here and handled per-entry instead.
const ACTION_LABEL_INTENT = Object.freeze({
  Attack: "harmful", Hinder: "harmful",
  Guard: "aid", Study: "neutral", Objective: "neutral", Equipment: "neutral",
});
function canonActionLabel(raw) {
  const k = String(raw ?? "").trim().toLowerCase();
  return _ACTION_LABEL_CANON.get(k) ?? String(raw ?? "").trim();
}

// AE-driven cap on how many creatures an action may target. The declarative
// counterpart to the action-LABEL gates above: instead of blocking a whole
// action type, it limits the BEARER's actions by target arity. Powers the
// Fatigue Advanced Debuff ("allows only single-target actions") — an AE carries
//   key "max_action_targets"  value = integer cap (Fatigue → "1")
// The MINIMUM cap across all active effects wins (two caps both apply). Returns
// { cap, reason } where reason = the source AE's name (the dim stamp); cap is
// Infinity when no AE restricts targeting. Mirrors getBlockedActionLabels' per-AE
// union — a pure change-row marker the BD reads itself, no CSB template field.
export function getMaxActionTargets(actor) {
  // Domination State ("Super Armor") — action-gating debuffs stay applied but
  // stop working. See [[domination.js]].
  if (hasIgnoreActionGating(actor)) return { cap: Infinity, reason: null };
  const effects = actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
  let cap = Infinity;
  let reason = null;
  for (const ae of effects) {
    if (ae?.disabled) continue;
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key !== "max_action_targets") continue;
      const v = Number(ch.value);
      if (Number.isFinite(v) && v < cap) {
        cap = v;
        reason = String(ae?.name ?? "").trim() || "Restricted";
      }
    }
  }
  return { cap, reason };
}

// Is an action inherently MULTI-target, judged from its skill_target text
// ("All Enemy", "Up to three creatures", "Multi (x)", "Two creatures")? Text-only
// (no formula resolver) — used by the Fatigue picker gate to decide whether the
// max_action_targets cap blocks this action. Conservative: a formula-count
// "Up to [SL]" reads as multi (the action is DESIGNED multi-target). Single-target
// specs ("One Creature", "One Random …", "Self") return false.
export function skillTargetIsMulti(skillTargetText) {
  const t = String(skillTargetText ?? "").toLowerCase();
  if (!t) return false;
  if (/\ball\b|every|\bmulti\b/.test(t)) return true;
  const m = t.match(/up to\s+(\d+|\[|\w+)/);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n > 1 : true;   // formula/word count ⇒ treat as multi
  }
  if (/\b(two|three|four|five|2|3|4|5)\b/.test(t)) return true;
  return false;
}

// AE-driven turn-action gating. Walks an actor's active effects and collects
// every change row that disables turn-action type(s) — the engine seam behind
// the homebrew "action-gating" Advanced Debuffs (Frightened / Silence / Confused
// / Disarmed / Berserk). Two declarative change keys:
//
//   key "disable_action"      value = comma-list of labels to BLOCK
//                             (Frightened→Attack, Silence→Spell, Confused→Objective,
//                              Disarmed→Equipment)
//   key "enable_action_only"  value = comma-list of the ONLY allowed labels;
//                             every other GATEABLE label is blocked
//                             (Berserk→Attack = "disable all except Attack")
//
// Reads are UNIONed per-AE across every active effect, so two debuffs blocking
// different actions both apply and neither clobbers the other (unlike a single
// CSB-applied field would). Mirrors getTargetSideBlocks / getCannotTargetReasons:
// pure change-row markers the BD reads itself — no reliance on a CSB template
// field. Returns Map<label, reason> where reason is the source AE's name (shown
// as the red rubber-stamp over the disabled menu blade).
export function getBlockedActionLabels(actor) {
  const out = new Map();
  // Domination State ("Super Armor") — every disable_action /
  // enable_action_only / disable_action_intent gate is inert while the bearer
  // carries the ignore_action_gating marker. The debuff AEs themselves stay
  // on (icons, durations, non-gating rows keep working).
  if (hasIgnoreActionGating(actor)) return out;
  const effects = actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
  const splitList = (raw) => String(raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const add = (label, reason) => {
    const L = canonActionLabel(label);
    if (L && !out.has(L)) out.set(L, reason);   // first source wins the stamp text
  };
  for (const ae of effects) {
    if (ae?.disabled) continue;
    const reason = String(ae?.name ?? "").trim() || "Disabled";
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key === "disable_action") {
        for (const lbl of splitList(ch.value)) add(lbl, reason);
      } else if (ch?.key === "enable_action_only") {
        const allow = new Set(splitList(ch.value).map(canonActionLabel));
        for (const lbl of GATEABLE_ACTION_LABELS) if (!allow.has(lbl)) add(lbl, reason);
      }
    }
  }

  // ── Intent filter (`disable_action_intent`) — "force close by intent" ──────
  // Default-open model: each AE may disable actions whose CLASSIFIED intent is
  // in its filter list (e.g. Charm/Domination → "aid, neutral" leaves only
  // harmful). Only the UNAMBIGUOUS static-intent top-level labels block here
  // (Guard/Study/Objective/Equipment). The mixed Spell/Skill/Item blades stay
  // OPEN — their submenu pickers dim + label the individual filtered entries
  // (shown, not hidden), matching the disabled-menu style. `snap.disabledActionIntents`
  // carries the intent→reason set the pickers re-apply per-entry.
  const disabledIntents = getDisabledActionIntents(actor);
  if (disabledIntents.size) {
    for (const [label, intent] of Object.entries(ACTION_LABEL_INTENT)) {
      if (disabledIntents.has(intent)) add(label, disabledIntents.get(intent));
    }
  }
  return out;
}

// Walk an actor's active effects and collect every `disable_action_intent`
// change → Map<intent, reason> (reason = source-AE name, for the menu stamp).
// Value is a comma/space list of intents ("harmful" | "aid" | "neutral").
// Mirrors getBlockedActionLabels' per-AE union. See [[reference_disable_action_intent]].
export function getDisabledActionIntents(actor) {
  const out = new Map();
  // Domination State ("Super Armor") — intent filters (Charm-likes) are inert.
  if (hasIgnoreActionGating(actor)) return out;
  const effects = actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
  for (const ae of effects) {
    if (ae?.disabled) continue;
    const reason = String(ae?.name ?? "").trim() || "Disabled";
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key !== "disable_action_intent") continue;
      for (const tok of String(ch.value ?? "").split(/[\s,]+/)) {
        const t = tok.trim().toLowerCase();
        if (t && !out.has(t)) out.set(t, reason);
      }
    }
  }
  return out;
}

// Serializable form of the disabled-intent set for the frozen snapshot — the
// compose-action pickers re-apply it per-entry (dim + label) on the player
// client. Each entry { intent, reason } so the picker can stamp the source-AE
// name on the dimmed row, exactly like the disabled-menu stamp.
function snapshotDisabledActionIntents(actor) {
  try {
    return Object.freeze(
      [...getDisabledActionIntents(actor).entries()].map(
        ([intent, reason]) => Object.freeze({ intent, reason }),
      ),
    );
  } catch (e) {
    warn("snapshotDisabledActionIntents threw", e);
    return Object.freeze([]);
  }
}

// Serializable form of getBlockedActionLabels for the frozen snapshot (a Map
// can't survive the IntentChannel hop to the player client that runs the
// compose-action menu). Returns a frozen Array<{label, reason}>.
function snapshotBlockedActions(actor) {
  try {
    return Object.freeze(Array.from(getBlockedActionLabels(actor),
      ([label, reason]) => Object.freeze({ label, reason })));
  } catch (e) {
    warn("snapshotBlockedActions threw", e);
    return Object.freeze([]);
  }
}

// AE-driven target exclusion. Walks the chooser's active effects, collects
// every change row whose `key === "cannot_target_uuids"`, and returns the
// set of actor UUIDs the chooser is forbidden from targeting.
//
// The change row's `value` is a comma-or-newline-separated list of UUIDs
// (typically one — Vanish writes the caster's actorUuid). We split on
// whitespace + commas so authors can pack multiple in a single row, and
// also merge across multiple AEs (Vanish from two casters → both UUIDs
// excluded).
//
// The bake-resolver in apply_ae substitutes `${casterActorUuid}$` at apply
// time, so by the time we read the AE here the value is already a literal
// UUID string. Disabled AEs are skipped.
//
// First consumer: Vanish's "Vanished from Caster" AE. Future consumers:
// any "you cannot see X" / "you cannot perceive X" reactive effect.
export function getCannotTargetUuids(actor) {
  return new Set(getCannotTargetReasons(actor).keys());
}

// Same walk as getCannotTargetUuids, but keeps the human-readable
// reason (AE name) for each excluded UUID. Used by the target picker
// to overlay a "WHY can't I target this?" label above the excluded
// tokens — players need to know whether the target is dropped because
// they're invisible, or for some other reason they should plan around.
//
// Returns Map<excludedActorUuid, string[]> — multiple AEs hitting the
// same UUID concatenate their names into the list, so the picker can
// surface all of them when relevant.
export function getCannotTargetReasons(actor) {
  const out = new Map();
  // Domination State ("Super Armor") — the ACTING side's target exclusions
  // (Charmed's "cannot target your charmer") are inert. Note this reader is
  // also used TARGET-side by other callers passing the candidate's actor —
  // those pass a DIFFERENT actor, so a dominating attacker only bypasses its
  // OWN restrictions, never a defender's protections.
  if (hasIgnoreActionGating(actor)) return out;
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  for (const ae of effects) {
    if (ae?.disabled) continue;
    const changes = ae?.changes ?? [];
    for (const ch of changes) {
      if (ch?.key !== "cannot_target_uuids") continue;
      const raw = String(ch.value ?? "").trim();
      if (!raw) continue;
      const reason = String(ae.name ?? "").trim() || "Cannot target";
      for (const u of raw.split(/[\s,]+/)) {
        const trimmed = u.trim();
        if (!trimmed) continue;
        const list = out.get(trimmed);
        if (list) list.push(reason);
        else out.set(trimmed, [reason]);
      }
    }
  }
  return out;
}

// ── Must-target constraint (Provoked) ─────────────────────────────────────
// The inverse of `cannot_target_uuids`: an AE change
// `{ key: "must_target_applier", value: "Attack,Spell" }` on the ACTING
// creature forces it to target the AE's APPLIER (the "provoker") with the
// listed action kinds. The provoker UUID is NOT in the change value — it's
// resolved from the apply-time `directorAppliedBy.reactorActorUuid` stamp, so
// one template serves every caster. First user: the Matador "Provoked" debuff
// (Capote). Returns `{ uuids:Set<actorUuid>, kinds:Set<string>, reason }` or
// `null` when the actor bears no such constraint (or no applier resolves — the
// constraint then lapses, so a creature whose provoker has left the field can
// still act). Callers exclude every NON-member target, but ONLY when a required
// provoker is actually present among candidates (see eligibility loops).
export function getMustTargetReasons(actor) {
  // Domination State ("Super Armor") — Provoked's forced-target constraint is inert.
  if (hasIgnoreActionGating(actor)) return null;
  const uuids = new Set();
  const kinds = new Set();
  let reason = null;
  const effects = actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
  for (const ae of effects) {
    if (ae?.disabled) continue;
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key !== "must_target_applier") continue;
      const applier = ae?.flags?.["fabula-ultima-companion"]?.directorAppliedBy?.reactorActorUuid;
      if (!applier) continue; // unresolved provoker → this constraint lapses
      uuids.add(String(applier).trim());
      for (const k of String(ch.value ?? "").split(/[\s,]+/)) {
        const t = k.trim().toLowerCase();
        if (t) kinds.add(t);
      }
      reason = String(ae.name ?? "").trim() || "Must target";
    }
  }
  return uuids.size ? { uuids, kinds, reason } : null;
}

// ── Allegiance override (relative side reclassification) ───────────────────
// An AE change `{ key: "allegiance_override", value: "<target>:<override_to>" }`
// on the ACTING creature reclassifies how IT sees other units' side. target =
// "ally" | "enemy" | "self" (relative to the actor) OR a token/actor UUID;
// override_to = "ally" | "enemy". RECLASSIFY (not duplicate) semantics, matched
// against the NATURAL side with NO cascade (first match wins) — so a full swap =
// two rows (`ally:enemy` + `enemy:ally`), no hardcoded swap. Read at the
// targeting classifier alongside cannot_target_uuids. First user: Fafnir
// Draconic Domination (`ally:enemy` → charmed creature's allies count as enemies
// to it). See [[reference_allegiance_override]].
export function getAllegianceOverrides(actor) {
  const out = [];
  // Domination State ("Super Armor") — hostile side-reclassification (Fafnir
  // Draconic Domination's charm) is inert on a dominating bearer.
  if (hasIgnoreActionGating(actor)) return out;
  const effects = actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
  for (const ae of effects) {
    if (ae?.disabled) continue;
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key !== "allegiance_override") continue;
      const raw = String(ch.value ?? "").trim();
      const i = raw.indexOf(":");
      if (i <= 0) continue;
      const target = raw.slice(0, i).trim().toLowerCase();
      const to = raw.slice(i + 1).trim().toLowerCase();
      if (target && (to === "ally" || to === "enemy")) out.push({ target, to });
    }
  }
  return out;
}

// Resolve a candidate's EFFECTIVE side relative to the acting creature, applying
// allegiance overrides to its NATURAL side (∈ {"ally","enemy"}). First matching
// override wins (no cascade). Overrides match by natural-side keyword OR the
// candidate's token/actor UUID.
export function applyAllegianceOverride(naturalSide, tokenUuid, actorUuid, overrides) {
  if (!overrides || !overrides.length) return naturalSide;
  for (const o of overrides) {
    if (o.target === naturalSide || o.target === tokenUuid || o.target === actorUuid) return o.to;
  }
  return naturalSide;
}

// Snapshot eligible targets read from a DirectorCombat (the no-Foundry-doc
// path). Same returned shape as `snapshotEligibleTargets` so callers can swap
// without changing downstream code.
export function snapshotEligibleTargetsFromDCombat(dCombat, attackerSnapshot, { category = "any" } = {}) {
  const combatants = dCombat?.combatants ?? [];
  const attackerDisp = attackerSnapshot?.disposition ?? 0;
  // AE-driven exclusion — walks the attacker's AEs once and collects every
  // `cannot_target_uuids` value plus its source-AE name (used as the
  // "why" label in the target picker). Excluded targets are filtered out
  // of the eligible list below AND collected separately into `excluded`,
  // attached to the returned array so the picker can render a greyed-out
  // overlay + reason label over each blocked token.
  // Skips self-targeting (category === "self") since that bypass is
  // already actor-id-based, and a self-targeted skill never honors
  // "I can't see this actor" exclusions per RAW.
  // The snapshot doesn't carry the live actor doc (frozen-data contract);
  // re-resolve via combatant.actorDoc on the dCombat side or
  // game.actors.get on the legacy side. Returns an empty map if no
  // attacker is resolvable.
  const attackerActorId = attackerSnapshot?.actorId ?? null;
  const attackerActor = attackerActorId
    ? (dCombat?.combatants?.find?.((c) => c.id === attackerSnapshot?.combatantId)?.actorDoc
        ?? game.actors?.get?.(attackerActorId)
        ?? null)
    : null;
  const exclusionReasons = (category === "self")
    ? new Map()
    : getCannotTargetReasons(attackerActor);
  // Allegiance overrides — reclassify a candidate's effective side relative to
  // the attacker (e.g. Charm/Domination: allies count as enemies).
  const allegianceOverrides = (category === "self") ? [] : getAllegianceOverrides(attackerActor);
  // Must-target (Provoked): when the attacker is forced to target its provoker
  // with Attacks, every other target is excluded — but only while the provoker
  // is actually present (else the constraint lapses; see getMustTargetReasons).
  const mustTarget = (category === "self") ? null : getMustTargetReasons(attackerActor);
  const mustTargetActive = !!mustTarget && mustTarget.kinds.has("attack")
    && combatants.some((c) => {
      const a = c.actorDoc; if (!a) return false;
      return readPropNum(a, ["current_hp", "hp"]) > 0 && mustTarget.uuids.has(a.uuid);
    });
  const out = [];
  const excluded = [];
  for (const c of combatants) {
    const token = c.tokenDoc;
    const actor = c.actorDoc;
    if (!token || !actor) continue;
    const disp = c.disposition ?? token.disposition ?? 0;
    const hp = readPropNum(actor, ["current_hp", "hp"]);
    if (hp <= 0) continue;
    let ok = true;
    if (category === "ally" || category === "enemy") {
      const isSelf = c.id === attackerSnapshot?.combatantId;
      const natSide = ((disp === attackerDisp) && (disp !== 0)) ? "ally" : "enemy";
      // Never reclassify the acting creature itself (self-targeting is identity-
      // based; an ally:enemy override must not sweep the actor into its own AoE).
      const effSide = isSelf ? natSide : applyAllegianceOverride(natSide, token.uuid, actor.uuid, allegianceOverrides);
      ok = effSide === category;
    } else if (category === "self") {
      ok = c.id === attackerSnapshot?.combatantId;
    }
    if (!ok) continue;
    if (mustTargetActive && c.id !== attackerSnapshot?.combatantId && !mustTarget.uuids.has(actor.uuid)) {
      excluded.push(Object.freeze({
        combatantId: c.id,
        tokenId: token.id,
        tokenUuid: token.uuid,
        actorId: actor.id,
        actorUuid: actor.uuid,
        name: actor.name,
        tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
        disposition: disp,
        reasons: Object.freeze([mustTarget.reason]),
      }));
      continue;
    }
    if (exclusionReasons.size && exclusionReasons.has(actor.uuid)) {
      excluded.push(Object.freeze({
        combatantId: c.id,
        tokenId: token.id,
        tokenUuid: token.uuid,
        actorId: actor.id,
        actorUuid: actor.uuid,
        name: actor.name,
        tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
        disposition: disp,
        reasons: Object.freeze([...exclusionReasons.get(actor.uuid)]),
      }));
      continue;
    }
    out.push(Object.freeze({
      combatantId: c.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      // World-actor UUID (the protoUuid the encyclopedia keys by) when the
      // token is unlinked — derived from token.actorId. Equals actorUuid for
      // linked actors. Used by the action card's "???" masking when a player
      // attacker hasn't Studied the target.
      worldActorUuid: (game.actors?.get?.(token.actorId)?.uuid) ?? actor.uuid,
      name: actor.name,
      tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
      disposition: disp,
      hp,
      maxHp: readPropNum(actor, ["max_hp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      affinities: readAffinities(actor),
      conditions: Object.freeze(readActiveConditions(actor)),
      // AE-driven target-side blocks (Cover, future Out-of-Sight, etc.).
      // Each entry: { aeName, ranges: Set<string> }. applyAttackRangeGate
      // reads this per-weapon to decide whether to move the target into
      // `.excluded` with the AE name as the reason. Stays empty for
      // most targets; ranges are normalized lowercase ("melee", "ranged",
      // "any").
      isFlying: targetIsFlying(actor),
      targetingBlocks: Object.freeze(getTargetSideBlocks(actor).map((b) =>
        Object.freeze({ aeName: b.aeName, ranges: Object.freeze([...b.ranges]) })
      )),
    }));
  }
  // Attach excluded list as a property BEFORE freezing — Object.freeze
  // applies recursively only one level, but we want the array property
  // accessible at all (assignment would silently fail post-freeze).
  out.excluded = Object.freeze(excluded);
  return Object.freeze(out);
}

// Build ONE target snapshot for a single token, in the SAME shape
// snapshotEligibleTargets / …FromDCombat produce (identity + defense /
// magicDefense / affinities / conditions / targetingBlocks). The reaction-
// mutation layer (redirect_target, add_target) uses this so a reactor or a
// spliced-in target can be re-derived through `buildPerTarget` — the ONE
// per-target derivation — instead of a hand-rolled clone
// (recomputePerTargetForRedirect). Mirrors the per-target object built in the
// loops above; keep the three in sync (they read the same actor props/helpers).
//
// Accepts a TokenDocument or a placeable Token. Returns null when the token has
// no actor.
export function snapshotTargetForToken(tokenLike) {
  const token = tokenLike?.document ?? tokenLike;   // placeable → its document
  const actor = token?.actor ?? null;
  if (!token || !actor) return null;
  const disp = token.disposition ?? 0;
  return Object.freeze({
    tokenId: token.id,
    tokenUuid: token.uuid,
    actorId: actor.id,
    actorUuid: actor.uuid,
    worldActorUuid: (game.actors?.get?.(token.actorId)?.uuid) ?? actor.uuid,
    name: actor.name,
    tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
    disposition: disp,
    hp: readPropNum(actor, ["current_hp", "hp"]),
    maxHp: readPropNum(actor, ["max_hp"]),
    defense: readPropNum(actor, ["defense", "current_def", "def"]),
    magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
    affinities: readAffinities(actor),
    conditions: Object.freeze(readActiveConditions(actor)),
    isFlying: targetIsFlying(actor),
    targetingBlocks: Object.freeze(getTargetSideBlocks(actor).map((b) =>
      Object.freeze({ aeName: b.aeName, ranges: Object.freeze([...b.ranges]) })
    )),
  });
}

// Apply the Attack range gate to an eligible-targets array, preserving
// the `excluded` side-channel that target-picker reads to render the
// "🚫 <reason>" overlay (Vanish etc.).
//
// The gate is data-driven via AE-config: each target may carry one or
// more `targetingBlocks` entries (collected by getTargetSideBlocks at
// snapshot time from `cannot_be_targeted_by` change rows). For each
// target, if ANY block's `ranges` set contains the attacker's weapon
// range OR `"any"`, the target moves into `.excluded` with the
// block's AE name as the reason.
//
// Cover (RAW Core p.70) is the canonical example — the Covered AE
// declares `cannot_be_targeted_by: "melee"`. Future targeting blocks
// (Out-of-Sight, Sanctuary, Concealment, etc.) author the same change
// row with their own scope and overlay the same way without engine
// changes.
//
// IMPORTANT: this function exists because `Array.prototype.filter()`
// returns a fresh array WITHOUT custom properties. Inlining a filter
// at the call site silently drops `.excluded` and the canvas overlay.
// All Attack call sites (PC composeAttack, NPC composeAttackNpc,
// TARGET re-snapshot) MUST route their range gating through this
// helper so the excluded-overlay contract holds uniformly.
export function applyAttackRangeGate(eligible, weapon) {
  if (!Array.isArray(eligible)) return eligible;
  const range = String(weapon?.range ?? "").trim().toLowerCase();
  if (!range) {
    // No weapon — nothing to gate on. Return as-is.
    return eligible;
  }
  const canMeleeFlying = !!weapon?.canMeleeFlying;
  const out = [];
  const newlyExcluded = [];
  for (const e of eligible) {
    const blocks = Array.isArray(e.targetingBlocks) ? e.targetingBlocks : [];
    const matchingReasons = [];
    for (const b of blocks) {
      const blockRanges = Array.isArray(b.ranges) ? b.ranges : [];
      if (blockRanges.includes("any") || blockRanges.includes(range)) {
        matchingReasons.push(b.aeName);
      }
    }
    // Flying rule (RAW): a melee attack can't reach a Flying creature, unless the
    // attacker's kit grants an exception for this weapon (weapon.canMeleeFlying —
    // Psychokinesis: arcane/sword). Deliberately separate from the block loop above
    // so it can't be confused with Cover / generic cannot_be_targeted_by blocks.
    if (range === "melee" && e.isFlying && !canMeleeFlying) {
      matchingReasons.push("Flying");
    }
    if (matchingReasons.length) {
      newlyExcluded.push(Object.freeze({
        combatantId: e.combatantId,
        tokenId: e.tokenId,
        tokenUuid: e.tokenUuid,
        actorId: e.actorId,
        actorUuid: e.actorUuid,
        name: e.name,
        tokenImg: e.tokenImg,
        disposition: e.disposition,
        reasons: Object.freeze([...matchingReasons]),
      }));
      continue;
    }
    out.push(e);
  }
  // Union with the existing AE-driven exclusions (Vanish etc.). Both
  // groups render identically — the overlay code doesn't care WHY a
  // token is excluded, only that it is.
  const priorExcluded = Array.isArray(eligible.excluded) ? eligible.excluded : [];
  out.excluded = Object.freeze([...priorExcluded, ...newlyExcluded]);
  return out;
}

// Apply the Study guard to an eligible-targets array, preserving the
// `excluded` side-channel that target-picker reads to render the
// "🚫 <reason>" overlay (same path as Vanish / Provoked).
//
// `studiedTokenUuids` is the set of target tokens the studier has already
// Studied this fight (DirectorCombat.studiedTokensFor). Each matching target
// MOVES from the selectable pool into `.excluded` with the reason
// "Already studied" — so the token stays VISIBLE in the picker but greyed +
// labeled, exactly like a Provoked target, rather than vanishing. RAW Core
// p.74: "you can study the same aspect of a creature only once."
//
// IMPORTANT: like applyAttackRangeGate, this exists because
// Array.prototype.filter() returns a fresh array WITHOUT custom properties —
// inlining a filter at the call site would silently drop `.excluded`. Both
// the GM-side Study TARGET branch and the player-side composeStudy route
// through this one helper so the overlay contract holds uniformly.
export function applyStudyGuardExclusion(eligible, studiedTokenUuids) {
  if (!Array.isArray(eligible)) return eligible;
  const studied = new Set(Array.isArray(studiedTokenUuids) ? studiedTokenUuids : []);
  if (!studied.size) return eligible;   // nothing studied yet → untouched
  const out = [];
  const newlyExcluded = [];
  for (const e of eligible) {
    if (studied.has(e.tokenUuid)) {
      newlyExcluded.push(Object.freeze({
        combatantId: e.combatantId,
        tokenId: e.tokenId,
        tokenUuid: e.tokenUuid,
        actorId: e.actorId,
        actorUuid: e.actorUuid,
        name: e.name,
        tokenImg: e.tokenImg,
        disposition: e.disposition,
        reasons: Object.freeze(["Already studied"]),
      }));
    } else {
      out.push(e);
    }
  }
  // Union with any existing AE-driven exclusions (Vanish / Provoked). Both
  // groups render identically — the overlay code doesn't care WHY.
  const priorExcluded = Array.isArray(eligible.excluded) ? eligible.excluded : [];
  out.excluded = Object.freeze([...priorExcluded, ...newlyExcluded]);
  return out;
}

// Snapshot eligible targets for a given action category.
// `category`: "any" | "ally" | "enemy" | "self".
// For the prototype we keep this simple — token UUIDs + name + disposition.
export function snapshotEligibleTargets(combat, attackerSnapshot, { category = "any" } = {}) {
  const combatants = combat?.combatants ?? [];
  const attackerDisp = attackerSnapshot?.disposition ?? 0;
  // AE-driven exclusion — same as the dCombat variant above. The legacy
  // Foundry combat carries `combatant.actor` references; we re-resolve
  // via game.actors as a fallback if the snapshot doesn't carry one.
  const attackerActorId = attackerSnapshot?.actorId ?? null;
  const attackerActor = attackerActorId
    ? (combat?.combatants?.find?.((c) => c.id === attackerSnapshot?.combatantId)?.actor
        ?? game.actors?.get?.(attackerActorId)
        ?? null)
    : null;
  const exclusionReasons = (category === "self")
    ? new Map()
    : getCannotTargetReasons(attackerActor);
  const allegianceOverrides = (category === "self") ? [] : getAllegianceOverrides(attackerActor);
  // Must-target (Provoked) — see the dCombat twin above for rationale.
  const mustTarget = (category === "self") ? null : getMustTargetReasons(attackerActor);
  const mustTargetActive = !!mustTarget && mustTarget.kinds.has("attack")
    && combatants.some((c) => {
      const a = c.actor; if (!a) return false;
      return readPropNum(a, ["current_hp", "hp"]) > 0 && mustTarget.uuids.has(a.uuid);
    });
  const out = [];
  const excluded = [];
  for (const c of combatants) {
    const token = c.token;
    const actor = c.actor;
    if (!token || !actor) continue;
    const disp = token.disposition;
    const hp = readPropNum(actor, ["current_hp", "hp"]);
    if (hp <= 0) continue; // defeated combatants are not targetable in v1
    let ok = true;
    if (category === "ally" || category === "enemy") {
      const isSelf = c.id === attackerSnapshot?.combatantId;
      const natSide = ((disp === attackerDisp) && (disp !== 0)) ? "ally" : "enemy";
      // Never reclassify the acting creature itself (self-targeting is identity-
      // based; an ally:enemy override must not sweep the actor into its own AoE).
      const effSide = isSelf ? natSide : applyAllegianceOverride(natSide, token.uuid, actor.uuid, allegianceOverrides);
      ok = effSide === category;
    } else if (category === "self") {
      ok = c.id === attackerSnapshot?.combatantId;
    }
    if (!ok) continue;
    if (mustTargetActive && c.id !== attackerSnapshot?.combatantId && !mustTarget.uuids.has(actor.uuid)) {
      excluded.push(Object.freeze({
        combatantId: c.id,
        tokenId: token.id,
        tokenUuid: token.uuid,
        actorId: actor.id,
        actorUuid: actor.uuid,
        name: actor.name,
        tokenImg: token.document?.texture?.src ?? token.texture?.src ?? token.img ?? actor.img ?? null,
        disposition: disp,
        reasons: Object.freeze([mustTarget.reason]),
      }));
      continue;
    }
    if (exclusionReasons.size && exclusionReasons.has(actor.uuid)) {
      excluded.push(Object.freeze({
        combatantId: c.id,
        tokenId: token.id,
        tokenUuid: token.uuid,
        actorId: actor.id,
        actorUuid: actor.uuid,
        name: actor.name,
        tokenImg: token.document?.texture?.src ?? token.texture?.src ?? token.img ?? actor.img ?? null,
        disposition: disp,
        reasons: Object.freeze([...exclusionReasons.get(actor.uuid)]),
      }));
      continue;
    }
    out.push(Object.freeze({
      combatantId: c.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      worldActorUuid: (game.actors?.get?.(token.actorId)?.uuid) ?? actor.uuid,
      name: actor.name,
      tokenImg: token.document?.texture?.src ?? token.texture?.src ?? token.img ?? actor.img ?? null,
      disposition: disp,
      hp,
      maxHp: readPropNum(actor, ["max_hp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      affinities: readAffinities(actor),
      conditions: Object.freeze(readActiveConditions(actor)),
      isFlying: targetIsFlying(actor),
      targetingBlocks: Object.freeze(getTargetSideBlocks(actor).map((b) =>
        Object.freeze({ aeName: b.aeName, ranges: Object.freeze([...b.ranges]) })
      )),
    }));
  }
  out.excluded = Object.freeze(excluded);
  return Object.freeze(out);
}

// Snapshot the action result computed by COMPUTE. Used by CONFIRM + RESOLVE.
export function freezeActionResult(obj, _depth = 0) {
  if (!obj || typeof obj !== "object") return obj;
  // NB: explicit lambda — Array.prototype.map passes (value, index, array),
  // which would feed the index in as `_depth` and mis-trip the depth-0 guard.
  if (Array.isArray(obj)) return Object.freeze(obj.map((v) => freezeActionResult(v, _depth + 1)));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (v && typeof v === "object") ? freezeActionResult(v, _depth + 1) : v;
  }
  // Single source of truth for "this action rolls an accuracy/Check and can
  // therefore MISS". Derived ONCE on the actionResult root (depth 0) from its
  // own `kind` + `isCheck`, so every consumer reads one capability fact instead
  // of re-deriving `kind === "Attack" || isCheck` at each call site — whose
  // half-spellings caused real bugs (weapon attacks don't set the skill-level
  // isCheck prop; offensive spells/Check-skills do but aren't kind "Attack").
  // `kind` stays the routing/economy/UI axis; this is the capability axis.
  // `canMiss` is a readability synonym for `rollsAccuracy`. Guarded to objects
  // that look like an actionResult so unrelated frozen objects are untouched.
  if (_depth === 0 && (out.kind !== undefined || out.isCheck !== undefined)) {
    const rolls = out.kind === "Attack" || !!out.isCheck;
    out.rollsAccuracy = rolls;
    out.canMiss = rolls;
    // Stable per-action-instance id. Generated once for a given card's
    // actionResult and PRESERVED across every re-freeze (each re-freeze spreads
    // `...ar`, so the field is copied in the loop above before we reach here). It
    // lets a NON-DETERMINISTIC card mutation (check_reroll's random rerollDice)
    // memoize its rolled result across the SEPARATE preview + commit passes —
    // without it the two passes roll different dice and the target takes a value
    // that doesn't match the card. Non-actionResult objects never get one.
    if (!out._instanceId) out._instanceId = foundry.utils.randomID();
  }
  return Object.freeze(out);
}

// Re-read live actor HP/MP. Used when the snapshot is stale (rare in v1).
export function readLiveResources(actor) {
  if (!actor) return null;
  try {
    return {
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
    };
  } catch (e) {
    warn("readLiveResources failed", e);
    return null;
  }
}
