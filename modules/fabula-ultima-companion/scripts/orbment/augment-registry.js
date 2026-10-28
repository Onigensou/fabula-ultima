// scripts/orbment/augment-registry.js
//
// The AUGMENT REGISTRY — static, data-driven definitions of every orbment.
//
// Catalog mirrors the RAW Quality tables (Weapon p.269, Armor & Shield p.280).
// Accessories can NOT be augmented (enforced in the API).
//
// `appliesTo` filters by item type (weapon/armor/shield); `category`
// (offensive|defensive|enhancement) groups the picker within a type.
//
// PARAMETERIZED augments ("choose one" qualities — Status, Antistatus, Resistance,
// Immunity) carry a `param` block (prompt + options) and a `build(value)` fn that
// returns the effective projection + display for the chosen value. The window
// opens a secondary picker for these; the slot stores { id, param }. Non-param
// augments declare props / rider / ae directly. `resolveAugment(id, param)` yields
// a unified VIEW (label/summary/icon + projection) used by the compiler + UI.
//
// Projections the compiler reads: props (item.system.props overrides), rider
// (reaction_config_table + effect_table rows), ae (embedded ActiveEffect).
//
// `pending: true` = in the catalog but not wired (install blocked, "soon" tag).
//
// Verified mechanisms (bridge 2026-07-01): stat AE keys bonus_defense /
// bonus_magic_defense / check_mod_accuracy / extra_damage_mod_<X>; status
// immunity condition_<status>="IM" (OVERRIDE); affinity resistance
// affinity_<idx>=aeAffinityFloor("RS"/"IM"); element↔index verified on Fire Slime.
//
// v2 (2026-07-27): check_mod_init + check_mod_magic confirmed as EXISTING CSB
// template columns on every PC (Hina/Blanche/Zarg all carry them), so Initiative
// Up / Magic Up need no template change. check_mod_init feeds BOTH the backend
// Initiative Group Check (director-initiative, via checkContext "init") and the
// sheet's derived Initiative readout (attribute-api readDerived).

const ADD = 2;       // CONST.ACTIVE_EFFECT_MODES.ADD
const OVERRIDE = 5;  // CONST.ACTIVE_EFFECT_MODES.OVERRIDE

// Equip-gated value for PROPS-BACKED keys — keys that ARE CSB template columns
// (check_mod_*, affinity_*, condition_*, extra_damage_mod_*). CSB evaluates the
// `${…}$` phrase when it aggregates the change into system.props, so the gate
// works and the reader just sees a number.
const equipGated = (n) => `\${isEquipped ? ${n} : 0}$`;

// Value for AE-SCANNED keys — keys with NO template column, which the engine
// reads straight off the AE change (heal_receiving_flat_all, spell_restore_mod;
// see skill-formulas sumAeChangeKey). Those readers do `Number(change.value)`
// on the RAW string, and Number("${isEquipped ? 5 : 0}$") is NaN → silently 0.
// So AE-scanned keys MUST carry a plain number.
//
// They are still equip-gated, just by a different mechanism: the compiler creates
// the AE `disabled: !isEquipped` and equipment-swap's AE sync maintains that on
// swaps, while every AE scan skips disabled effects.
const aeScanned = (n) => n;

// Status immunity change: force condition_<status> to "IM". Equip-gated by the
// compiler disabling the AE off-body (matches the world "Status Immunity" item).
const immunityChange = (status) => ({ key: `condition_${status}`, mode: OVERRIDE, value: "IM" });

// Affinity change: aeAffinityFloor(code) sets affinity_<idx> to code but preserves
// an already-better IM/AB (won't downgrade) — the world's Bodyguard helper.
const affinityChange = (idx, code) => ({ key: `affinity_${idx}`, mode: OVERRIDE, value: `aeAffinityFloor("${code}")` });

// Damage type → affinity_N index (verified on Fire Slime Actor.Q2SuQSgrAC2dZR2Y:
// affinity_6=fire/AB, _7=ice/VU, _9=poison/IM). physical=affinity_1 (Swordbreaker).
const ELEMENTS = [
  { el: "air",    idx: 2, icon: "💨", label: "Air" },
  { el: "bolt",   idx: 3, icon: "⚡", label: "Bolt" },
  { el: "dark",   idx: 4, icon: "🌑", label: "Dark" },
  { el: "earth",  idx: 5, icon: "⛰️", label: "Earth" },
  { el: "fire",   idx: 6, icon: "🔥", label: "Fire" },
  { el: "ice",    idx: 7, icon: "❄️", label: "Ice" },
  { el: "light",  idx: 8, icon: "☀️", label: "Light" },
  { el: "poison", idx: 9, icon: "☠️", label: "Poison" },
];
const elementOf = (val) => ELEMENTS.find((e) => e.el === val) ?? null;

// ── Multi-pick params ("choose TWO") ──────────────────────────────────────────
// A param augment declares `pick: N` (default 1). For N > 1 the slot's `param`
// stays a STRING — the chosen values joined by MULTI_SEP — so storage, the flag
// record, normalizeSlot and the dedupe key all keep the single-value shape and
// nothing downstream needs to learn about arrays.
export const MULTI_SEP = "+";
export const paramPickCount = (a) => Math.max(1, Number(a?.param?.pick ?? 1) || 1);
export const splitParam = (v) =>
  String(v ?? "").split(MULTI_SEP).map((s) => s.trim()).filter(Boolean);

// Canonical param string: values ordered by their position in the option list, so
// "ice+fire" and "fire+ice" resolve to the SAME stored param (and therefore the
// same dedupe key). Single-pick params pass through unchanged.
export function canonicalizeParam(augment, param) {
  if (!augment?.param) return null;
  if (paramPickCount(augment) === 1) return param ?? null;
  const order = augment.param.options.map((o) => o.value);
  const seen = new Set();
  return splitParam(param)
    .filter((v) => order.includes(v) && !seen.has(v) && seen.add(v))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .join(MULTI_SEP);
}

// Validate a param against its augment. Returns null when OK, else an error
// message. Enforces: known option values, exactly `pick` of them, no repeats.
export function validateParam(augment, param) {
  if (!augment?.param) return null;
  const need = paramPickCount(augment);
  const order = augment.param.options.map((o) => o.value);
  const vals = need === 1 ? [param].filter((v) => v != null) : splitParam(param);
  if (vals.length !== need)
    return `"${augment.label}" needs ${need === 1 ? "a choice" : `${need} choices`} — pick ${need === 1 ? "one" : need} of its options.`;
  if (new Set(vals).size !== vals.length)
    return `"${augment.label}" needs ${need} DIFFERENT choices.`;
  for (const v of vals) if (!order.includes(v)) return `"${augment.label}": unknown choice "${v}".`;
  return null;
}

// The Basic Status Effects (Perfect Health covers exactly these).
const BASIC_STATUSES = ["slow", "weak", "dazed", "shaken", "enraged", "poisoned"];

// The 8 canonical FU species, matching the values authored into NPC
// `system.props.species` (see director-init ROAR_BY_SPECIES).
const SPECIES = [
  { id: "beast",     label: "Beast",     icon: "🐺" },
  { id: "construct", label: "Construct", icon: "⚙️" },
  { id: "demon",     label: "Demon",     icon: "👿" },
  { id: "elemental", label: "Elemental", icon: "🌀" },
  { id: "humanoid",  label: "Humanoid",  icon: "🧍" },
  { id: "monster",   label: "Monster",   icon: "👹" },
  { id: "plant",     label: "Plant",     icon: "🌿" },
  { id: "undead",    label: "Undead",    icon: "💀" },
];
const speciesOf = (v) => SPECIES.find((s) => s.id === v) ?? null;

// Hunter damage formula. TARGET_SPECIES_IS_<X> (skill-formulas) returns 1/0 for
// the trigger SUBJECT, and computeSenderDamageBonuses evaluates damage_amount
// ONCE PER VICTIM, so the formula self-gates: +5 against a matching species, +0
// otherwise — no condition_formula needed, and a Multi attack scores each target
// independently. `min(..., 1)` keeps Dual Hunter at +5 (not +10) if a creature
// ever matched both.
const hunterFormula = (ids, n = 5) => {
  const terms = ids.map((id) => `TARGET_SPECIES_IS_${id.toUpperCase()}`);
  return terms.length > 1 ? `min(${terms.join(" + ")}, 1) * ${n}` : `${terms[0]} * ${n}`;
};
const hunterRider = (ids, n = 5) => ({
  trigger: "creature_will_deal_damage",
  effects: [{
    effect_kind: "adjust_damage",
    damage_operation: "add",
    damage_stage: "outgoing",
    damage_amount: hunterFormula(ids, n),
  }],
});

// ── v3: rolled values ──────────────────────────────────────────────────────────
// An augment with `vals` rolls one of those strengths at the Alchemist; the LAST
// step is the rulebook value (the ceiling), and is what a value-less slot (any
// v1/v2 install, or an Upgrade) resolves to. `build(param, value)` receives the
// resolved value. `unit` ("%") only affects display.
export const topValue = (a) => (Array.isArray(a?.vals) && a.vals.length ? a.vals[a.vals.length - 1] : null);
export function resolveValue(a, value) {
  if (!Array.isArray(a?.vals) || !a.vals.length) return null;
  const n = Number(value);
  return a.vals.includes(n) ? n : topValue(a);
}

// Orbment-only damage-reduction keys. AE-SCANNED (no template column): both
// damage paths read them off the actor's AE changes and CAP the total
// (ORBMENT_DR_CAP in skill-formulas / apply-damage-core), so refinement's shield
// DR — which writes the sheet's own damage_receiving_* columns — stays uncapped.
const drFlatKey = (el) => `orbment_dr_flat_${el}`;
const drPctKey = (el) => `orbment_dr_pct_${el}`;

// Fury rides the Battle Director's existing attacker multiplier flag (BD
// action-profile: atkDmgMult = damage_dealt_mult_all × damage_dealt_mult_<kind>,
// seeded to 1 so MULTIPLY AEs compose). No engine change.
const MULTIPLY = 1;   // CONST.ACTIVE_EFFECT_MODES.MULTIPLY

// Advanced statuses for Antistatus+ (Rare) / Antistatus++ (Jackpot). Keys are
// the sheet's condition_<status> columns (verified present on the PC template).
const ADV_STATUSES = ["burn", "blind", "stagger", "envenomed", "frightened", "confused"];
const MAX_STATUSES = ["paralyzed", "silence", "panic"];
const ATTRS = [
  { id: "dex", label: "DEX" }, { id: "ins", label: "INS" },
  { id: "mig", label: "MIG" }, { id: "wlp", label: "WLP" },
];
const PHYSICAL = { el: "physical", idx: 1, icon: "🗡️", label: "Physical" };

// Shared on-hit status rider builder (Status / Status Plus).
const onHitStatusRider = (status) => ({
  trigger: "creature_deals_damage",
  effects: [{ effect_kind: "apply_ae", ae_template_ref: cap(status), target_ref: "hit_action_targets", ae_duplicate_mode: "refresh" }],
});

// Roll metadata (v3): `tier` 0 Common · 1 Uncommon · 2 Rare · 3 Jackpot decides
// how often the Alchemist's stones land it; `vals` are its rollable strengths
// (last = the rulebook value). `rollable: false` keeps an augment out of random
// Attunement (GM backstage installs still work). `house: true` marks additions
// beyond the rulebook Quality tables — those are never offered by Upgrade.
export const AUGMENTS = [
  // ═══ WEAPON — Offensive (Core p.269) ═══════════════════════════════════════
  {
    id: "magical", label: "Magical", icon: "✨", cost: 100, category: "offensive", tier: 0,
    appliesTo: ["weapon"],
    summary: "The weapon targets Magic Defense instead of Defense.",
    ruleText: "The weapon targets Magic Defense instead of Defense.",
    props: { defense_target_type: "mdef" },
  },
  {
    id: "hunter", label: "Hunter", icon: "🏹", cost: 300, category: "offensive", tier: 0,
    appliesTo: ["weapon"], vals: [2, 3, 5],
    summary: "Deals 5 extra damage to creatures of a particular Species.",
    ruleText: "The weapon deals 5 extra damage to creatures of a particular Species.",
    param: { prompt: "Choose a Species", options: SPECIES.map((s) => ({ value: s.id, label: s.label, icon: s.icon })) },
    build: (v, n) => {
      const s = speciesOf(v);
      if (!s) return {};
      return {
        label: `Hunter: ${s.label}`,
        summary: `Deals ${n} extra damage to ${s.label} creatures.`,
        icon: s.icon,
        rider: hunterRider([s.id], n),
      };
    },
  },
  {
    id: "piercing", label: "Piercing", icon: "🩸", cost: 400, category: "offensive", tier: 1,
    appliesTo: ["weapon"], keyword: "Pierce",
    summary: "Damage dealt by the weapon ignores Resistances.",
    ruleText: "Damage dealt by the weapon ignores Resistances.",
    rider: {
      trigger: "creature_will_deal_damage",
      effects: [{ effect_kind: "apply_action_keyword", action_keyword: "pierce" }],
    },
  },
  {
    id: "dual_hunter", label: "Dual Hunter", icon: "🏹", cost: 500, category: "offensive", tier: 1,
    appliesTo: ["weapon"], vals: [2, 3, 5],
    summary: "Deals 5 extra damage to creatures of one of two Species.",
    ruleText: "The weapon deals 5 extra damage to creatures belonging to one of two particular Species.",
    param: { prompt: "Choose two Species", pick: 2, options: SPECIES.map((s) => ({ value: s.id, label: s.label, icon: s.icon })) },
    build: (v, n) => {
      const sp = splitParam(v).map(speciesOf).filter(Boolean);
      if (sp.length !== 2) return {};
      const [a, b] = sp;
      return {
        label: `Dual Hunter: ${a.label} + ${b.label}`,
        summary: `Deals ${n} extra damage to ${a.label} and ${b.label} creatures.`,
        icon: a.icon,
        rider: hunterRider([a.id, b.id], n),
      };
    },
  },
  {
    id: "multi", label: "Multi (2)", icon: "🎯", cost: 1000, category: "offensive", tier: 3,
    appliesTo: ["weapon"], keyword: "Multi",
    summary: "Attacks strike up to 2 different targets.",
    ruleText: "Attacks with the weapon have multi (2).",
    props: { skill_target: "Up to two creatures" },
  },
  {
    id: "status", label: "Status", icon: "☠️", cost: 1500, category: "offensive", tier: 2,
    appliesTo: ["weapon"],
    summary: "Each target hit suffers a chosen status (dazed / shaken / slow / weak).",
    ruleText: "Each target hit by the weapon suffers the chosen status.",
    param: { prompt: "Choose a status to inflict", options: ["dazed", "shaken", "slow", "weak"].map((s) => ({ value: s, label: cap(s), icon: "☠️" })) },
    build: (v) => ({ label: `Status: ${cap(v)}`, summary: `Each target hit suffers ${v}.`, icon: "☠️", keyword: cap(v), rider: onHitStatusRider(v) }),
  },
  {
    id: "status_plus", label: "Status Plus", icon: "☠️", cost: 2000, category: "offensive", tier: 3,
    appliesTo: ["weapon"],
    summary: "Each target hit suffers a chosen status (enraged / poisoned).",
    ruleText: "Each target hit by the weapon suffers the chosen status.",
    param: { prompt: "Choose a status to inflict", options: ["enraged", "poisoned"].map((s) => ({ value: s, label: cap(s), icon: "☠️" })) },
    build: (v) => ({ label: `Status+: ${cap(v)}`, summary: `Each target hit suffers ${v}.`, icon: "☠️", keyword: cap(v), rider: onHitStatusRider(v) }),
  },
  {
    // House. "You deal X% more damage." Multiplies the BD attacker flag.
    id: "fury", label: "Fury", icon: "🔥", cost: 0, category: "offensive", tier: 2, house: true,
    appliesTo: ["weapon"], vals: [3, 6, 10], unit: "%",
    summary: "You deal 10% more damage.",
    ruleText: "You deal more damage with every attack, spell and skill.",
    build: (_v, n) => ({
      summary: `You deal ${n}% more damage.`,
      ae: { name: `Fury ${n}% (Orbment)`, changes: [{ key: "flags.fabula-ultima-companion.damage_dealt_mult_all", mode: MULTIPLY, value: aeScanned(1 + n / 100) }] },
    }),
  },

  // ═══ ARMOR & SHIELD — Enhancement (Core p.280) ═════════════════════════════
  {
    // REBALANCE: RAW grants +4; we ship +2. BD re-rolls the Initiative Group
    // Check EVERY round and it's a binary "who acts first" on a 2-die total
    // (~11 avg) vs a DL in the 10-15 band, so +4 swung it far harder than the
    // 500z price implies. Display strings say +2 so the UI never lies.
    id: "initiative_up", label: "Initiative Up", icon: "⚡", cost: 500, category: "enhancement", tier: 0,
    appliesTo: ["armor", "shield"], vals: [1, 2],
    summary: "+2 bonus to your Initiative modifier.",
    ruleText: "You gain a +2 bonus to your Initiative modifier.",
    build: (_v, n) => ({ summary: `+${n} bonus to your Initiative modifier.`,
      ae: { name: "Initiative Up (Orbment)", changes: [{ key: "check_mod_init", mode: ADD, value: equipGated(n) }] } }),
  },
  {
    id: "accuracy_up", label: "Accuracy Up", icon: "🎯", cost: 1000, category: "enhancement", tier: 1,
    appliesTo: ["armor", "shield"],
    summary: "+1 bonus to your Accuracy Checks.",
    ruleText: "You gain a +1 bonus to your Accuracy Checks.",
    ae: { name: "Accuracy Up (Orbment)", changes: [{ key: "check_mod_accuracy", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "magic_up", label: "Magic Up", icon: "🔯", cost: 1000, category: "enhancement", tier: 1,
    appliesTo: ["armor", "shield"],
    summary: "+1 bonus to your Magic Checks.",
    ruleText: "You gain a +1 bonus to your Magic Checks.",
    ae: { name: "Magic Up (Orbment)", changes: [{ key: "check_mod_magic", mode: ADD, value: equipGated(1) }] },
  },
  {
    // RECIPIENT-side: read off the HEALED actor, so it boosts any HP recovery
    // the wearer receives regardless of who healed them. `heal_receiving_flat_all`
    // is NOT a CSB template column — skill-formulas reads it straight off the AE
    // changes (same as its fractional sibling heal_receiving_mod_all), so no
    // template re-stamp is needed. Applied AFTER the fractional modifier.
    id: "vitality_up", label: "Vitality Up", icon: "💚", cost: 1000, category: "enhancement", tier: 0,
    appliesTo: ["armor", "shield"], vals: [2, 3, 5],
    summary: "When you recover HP, you recover 5 extra HP.",
    ruleText: "When you recover HP, you recover 5 extra HP.",
    build: (_v, n) => ({ summary: `When you recover HP, you recover ${n} extra HP.`,
      ae: { name: "Vitality Up (Orbment)", changes: [{ key: "heal_receiving_flat_all", mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    // CASTER-side, spells only — the exact analogue of Secret Formula's
    // item_restore_mod, added as a new family in skill-formulas
    // resolveRestoreParts. AE-scanned (no template column), so it uses a plain
    // value; see aeScanned above.
    id: "healing_up", label: "Healing Up", icon: "✚", cost: 1500, category: "enhancement", tier: 1,
    appliesTo: ["armor", "shield"], vals: [2, 3, 5],
    summary: "Your HP-restoring spells restore 5 extra HP.",
    ruleText: "Spells you cast that restore Hit Points will restore 5 extra Hit Points.",
    build: (_v, n) => ({ summary: `Your HP-restoring spells restore ${n} extra HP.`,
      ae: { name: "Healing Up (Orbment)", changes: [{ key: "spell_restore_mod", mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    id: "spell_up", label: "Spell Up", icon: "🔮", cost: 2000, category: "enhancement", tier: 2,
    appliesTo: ["armor", "shield"], vals: [2, 3, 5],
    summary: "Spells you cast deal 5 extra damage.",
    ruleText: "Spells you cast deal 5 extra damage.",
    build: (_v, n) => ({ summary: `Spells you cast deal ${n} extra damage.`,
      ae: { name: "Spell Up (Orbment)", changes: [{ key: "extra_damage_mod_spell", mode: ADD, value: equipGated(n) }] } }),
  },
  {
    id: "weapon_up", label: "Weapon Up", icon: "⚔️", cost: 2000, category: "enhancement", tier: 2,
    appliesTo: ["armor", "shield"], vals: [2, 3, 5],
    summary: "Your weapon attacks (melee or ranged) deal 5 extra damage.",
    ruleText: "Your attacks with the chosen weapon type deal 5 extra damage.",
    param: { prompt: "Choose weapon type", options: [{ value: "melee", label: "Melee", icon: "⚔️" }, { value: "ranged", label: "Ranged", icon: "🏹" }] },
    build: (v, n) => ({ label: `Weapon Up: ${cap(v)}`, summary: `Your ${v} weapon attacks deal ${n} extra damage.`, icon: v === "ranged" ? "🏹" : "⚔️",
      ae: { name: `Weapon Up — ${cap(v)} (Orbment)`, changes: [{ key: `extra_damage_mod_${v}`, mode: ADD, value: equipGated(n) }] } }),
  },
  // House enhancement stats. Max HP/MP/IP use the same key + plain-number form
  // as armor refinement's proven Max HP AE; equip-gating comes from the
  // compiler's `disabled: !isEquipped` (kept in sync by equipment-swap).
  {
    id: "max_hp", label: "Max HP", icon: "❤️", cost: 0, category: "enhancement", tier: 0, house: true,
    appliesTo: ["armor", "shield"], vals: [5, 10, 15],
    summary: "Your maximum HP increases by 15.", ruleText: "Your maximum HP increases.",
    build: (_v, n) => ({ summary: `Your maximum HP increases by ${n}.`,
      ae: { name: `Max HP +${n} (Orbment)`, changes: [{ key: "system.props.max_hp", mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    id: "max_mp", label: "Max MP", icon: "💧", cost: 0, category: "enhancement", tier: 0, house: true,
    appliesTo: ["armor", "shield"], vals: [5, 10, 15],
    summary: "Your maximum MP increases by 15.", ruleText: "Your maximum MP increases.",
    build: (_v, n) => ({ summary: `Your maximum MP increases by ${n}.`,
      ae: { name: `Max MP +${n} (Orbment)`, changes: [{ key: "system.props.max_mp", mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    id: "max_ip", label: "Max IP", icon: "🎒", cost: 0, category: "enhancement", tier: 1, house: true,
    appliesTo: ["armor", "shield"], vals: [1, 2],
    summary: "Your maximum IP increases by 2.", ruleText: "Your maximum IP increases.",
    build: (_v, n) => ({ summary: `Your maximum IP increases by ${n}.`,
      ae: { name: `Max IP +${n} (Orbment)`, changes: [{ key: "system.props.max_ip", mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    // The MP twin of Vitality Up: applyMpReceiving reads mp_receiving_flat_all
    // off the AE changes (AE-scanned, plain number).
    id: "spirit_up", label: "Spirit Up", icon: "🌀", cost: 0, category: "enhancement", tier: 0, house: true,
    appliesTo: ["armor", "shield"], vals: [2, 3, 5],
    summary: "When you recover MP, you recover 5 extra MP.", ruleText: "When you recover MP, you recover extra MP.",
    build: (_v, n) => ({ summary: `When you recover MP, you recover ${n} extra MP.`,
      ae: { name: "Spirit Up (Orbment)", changes: [{ key: "mp_receiving_flat_all", mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    // PENDING the live check of what +1 on bonus_<attr> does (a real die step,
    // not a flat +1). Pending = shown, never rolled, install blocked. No
    // per-character limit (user): two on different items stack, d12 caps.
    id: "attr_up", label: "Attribute Up", icon: "🎲", cost: 0, category: "enhancement", tier: 3, house: true, pending: true,
    appliesTo: ["armor", "shield"],
    summary: "One attribute die grows one size (up to d12).", ruleText: "One attribute die grows one size, up to d12.",
    param: { prompt: "Choose an attribute", options: ATTRS.map((a) => ({ value: a.id, label: a.label, icon: "🎲" })) },
    build: (v) => {
      const a = ATTRS.find((x) => x.id === v);
      // bonus_<attr> moves the die VALUE: the sheet computes <attr>_current =
      // clamp(<attr>_base + bonus_<attr>, 4, 14), so ONE size is +2 (Slow is -2,
      // Supercharge +2). Live-checked 2026-10-28. The sheet's ceiling is d14, not
      // d12 — still pending until that cap is decided.
      return a ? { label: `Attribute Up: ${a.label}`, summary: `Your ${a.label} die grows one size (up to d12).`,
        ae: { name: `${a.label} Up (Orbment)`, changes: [{ key: `bonus_${a.id}`, mode: ADD, value: equipGated(2) }] } } : {};
    },
  },

  // ═══ DEFENSIVE — Weapon (p.269) + Armor & Shield (p.280) ═══════════════════
  {
    id: "antistatus", label: "Antistatus", icon: "🚫", cost: 500, category: "defensive", tier: 0,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Immunity to a chosen status (slow / dazed / shaken / weak).",
    ruleText: "You are immune to the chosen status effect.",
    param: { prompt: "Choose a status", options: ["slow", "dazed", "shaken", "weak"].map((s) => ({ value: s, label: cap(s), icon: "🚫" })) },
    build: (v) => ({ label: `Antistatus: ${cap(v)}`, summary: `Immune to ${v}.`, icon: "🚫", ae: { name: `Antistatus ${cap(v)} (Orbment)`, changes: [immunityChange(v)] } }),
  },
  {
    id: "antistatus_adv", label: "Antistatus+", icon: "🚫", cost: 0, category: "defensive", tier: 2, house: true,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Immunity to an advanced status.", ruleText: "You are immune to the chosen status effect.",
    param: { prompt: "Choose a status", options: ADV_STATUSES.map((s) => ({ value: s, label: cap(s), icon: "🚫" })) },
    build: (v) => ({ label: `Antistatus+: ${cap(v)}`, summary: `Immune to ${v}.`, icon: "🚫", ae: { name: `Antistatus+ ${cap(v)} (Orbment)`, changes: [immunityChange(v)] } }),
  },
  {
    id: "antistatus_max", label: "Antistatus++", icon: "🚫", cost: 0, category: "defensive", tier: 3, house: true,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Immunity to paralyzed, silence or panic.", ruleText: "You are immune to the chosen status effect.",
    param: { prompt: "Choose a status", options: MAX_STATUSES.map((s) => ({ value: s, label: cap(s), icon: "🚫" })) },
    build: (v) => ({ label: `Antistatus++: ${cap(v)}`, summary: `Immune to ${v}.`, icon: "🚫", ae: { name: `Antistatus++ ${cap(v)} (Orbment)`, changes: [immunityChange(v)] } }),
  },
  {
    id: "resistance", label: "Resistance", icon: "🛡️", cost: 700, category: "defensive", tier: 0,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Resistance to a chosen damage type (not physical).",
    ruleText: "You have Resistance to a chosen damage type (not physical damage).",
    param: { prompt: "Choose a damage type", options: ELEMENTS.map((e) => ({ value: e.el, label: e.label, icon: e.icon })) },
    build: (v) => { const e = elementOf(v); return e ? { label: `Resistance: ${e.label}`, summary: `Resistance to ${e.label} damage.`, icon: e.icon, ae: { name: `Resistance ${e.label} (Orbment)`, changes: [affinityChange(e.idx, "RS")] } } : {}; },
  },
  {
    id: "amulet", label: "Amulet", icon: "🔮", cost: 800, category: "defensive", tier: 1,
    appliesTo: ["weapon"],
    summary: "+1 bonus to Magic Defense.",
    ruleText: "You gain a +1 bonus to Magic Defense.",
    ae: { name: "Amulet (Orbment)", changes: [{ key: "bonus_magic_defense", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "bulwark", label: "Bulwark", icon: "🛡️", cost: 800, category: "defensive", tier: 1,
    appliesTo: ["weapon"],
    summary: "+1 bonus to Defense.",
    ruleText: "You gain a +1 bonus to Defense.",
    ae: { name: "Bulwark (Orbment)", changes: [{ key: "bonus_defense", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "dual_resistance", label: "Dual Resistance", icon: "🛡️", cost: 1000, category: "defensive", tier: 1,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Resistance to two damage types (not physical).",
    ruleText: "You have Resistance to two damage types (not physical damage).",
    param: { prompt: "Choose two damage types", pick: 2, options: ELEMENTS.map((e) => ({ value: e.el, label: e.label, icon: e.icon })) },
    build: (v) => {
      const els = splitParam(v).map(elementOf).filter(Boolean);
      if (els.length !== 2) return {};
      const [a, b] = els;
      return {
        label: `Dual Resistance: ${a.label} + ${b.label}`,
        summary: `Resistance to ${a.label} and ${b.label} damage.`,
        icon: a.icon,
        ae: {
          name: `Dual Resistance ${a.label}/${b.label} (Orbment)`,
          changes: [affinityChange(a.idx, "RS"), affinityChange(b.idx, "RS")],
        },
      };
    },
  },
  {
    id: "swordbreaker", label: "Swordbreaker", icon: "🗡️", cost: 1000, category: "defensive", tier: 2,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Resistance to physical damage.",
    ruleText: "You have Resistance to physical damage.",
    ae: { name: "Swordbreaker (Orbment)", changes: [affinityChange(1, "RS")] },
  },
  {
    // OUT of random Attunement (user 2026-10-28: too strong, boxes in monster
    // design). Kept for GM backstage installs until a retire decision.
    id: "immunity", label: "Immunity", icon: "🚫", cost: 1500, category: "defensive", rollable: false,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Immunity to a chosen damage type (not physical).",
    ruleText: "You have Immunity to a chosen damage type (not physical damage).",
    param: { prompt: "Choose a damage type", options: ELEMENTS.map((e) => ({ value: e.el, label: e.label, icon: e.icon })) },
    build: (v) => { const e = elementOf(v); return e ? { label: `Immunity: ${e.label}`, summary: `Immunity to ${e.label} damage.`, icon: e.icon, ae: { name: `Immunity ${e.label} (Orbment)`, changes: [affinityChange(e.idx, "IM")] } } : {}; },
  },
  {
    id: "omnishield", label: "Omnishield", icon: "🛡️", cost: 2000, category: "defensive", tier: 3,
    appliesTo: ["weapon"],
    summary: "+1 bonus to Defense and Magic Defense.",
    ruleText: "You gain a +1 bonus to Defense and Magic Defense.",
    ae: {
      name: "Omnishield (Orbment)",
      changes: [
        { key: "bonus_defense",       mode: ADD, value: equipGated(1) },
        { key: "bonus_magic_defense", mode: ADD, value: equipGated(1) },
      ],
    },
  },
  {
    id: "perfect_health", label: "Perfect Health", icon: "💠", cost: 2000, category: "defensive", tier: 3,
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Immune to all Basic Status Effects.",
    ruleText: "You are immune to all Basic Status Effects (Slow, Weak, Dazed, Shaken, Enraged, Poisoned).",
    ae: { name: "Perfect Health (Orbment)", changes: BASIC_STATUSES.map(immunityChange) },
  },

  // ═══ DAMAGE REDUCTION — house, ARMOR ONLY (the shield keeps refinement's DR) ═
  // Orbment-only AE-scanned keys, capped per character in both damage paths.
  {
    id: "guard", label: "Guard", icon: "🧱", cost: 0, category: "defensive", tier: 0, house: true,
    appliesTo: ["armor"], vals: [1, 2, 3, 4, 5],
    summary: "You take 5 less damage of a chosen type.", ruleText: "You take less damage of one type (not physical).",
    param: { prompt: "Choose a damage type", options: ELEMENTS.map((e) => ({ value: e.el, label: e.label, icon: e.icon })) },
    build: (v, n) => { const e = elementOf(v); return e ? { label: `Guard: ${e.label}`, summary: `You take ${n} less ${e.label} damage.`, icon: e.icon,
      ae: { name: `Guard ${e.label} (Orbment)`, changes: [{ key: drFlatKey(e.el), mode: ADD, value: aeScanned(n) }] } } : {}; },
  },
  {
    id: "guard_phys", label: "Guard: Physical", icon: "🧱", cost: 0, category: "defensive", tier: 1, house: true,
    appliesTo: ["armor"], vals: [1, 2, 3, 4, 5],
    summary: "You take 5 less Physical damage.", ruleText: "You take less Physical damage.",
    build: (_v, n) => ({ summary: `You take ${n} less Physical damage.`,
      ae: { name: "Guard Physical (Orbment)", changes: [{ key: drFlatKey(PHYSICAL.el), mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    id: "ward", label: "Ward", icon: "🔰", cost: 0, category: "defensive", tier: 1, house: true,
    appliesTo: ["armor"], vals: [8, 14, 20], unit: "%",
    summary: "You take 20% less damage of a chosen type.", ruleText: "You take a percentage less damage of one type (not physical).",
    param: { prompt: "Choose a damage type", options: ELEMENTS.map((e) => ({ value: e.el, label: e.label, icon: e.icon })) },
    build: (v, n) => { const e = elementOf(v); return e ? { label: `Ward: ${e.label}`, summary: `You take ${n}% less ${e.label} damage.`, icon: e.icon,
      ae: { name: `Ward ${e.label} (Orbment)`, changes: [{ key: drPctKey(e.el), mode: ADD, value: aeScanned(n) }] } } : {}; },
  },
  {
    id: "ward_phys", label: "Ward: Physical", icon: "🔰", cost: 0, category: "defensive", tier: 2, house: true,
    appliesTo: ["armor"], vals: [8, 14, 20], unit: "%",
    summary: "You take 20% less Physical damage.", ruleText: "You take a percentage less Physical damage.",
    build: (_v, n) => ({ summary: `You take ${n}% less Physical damage.`,
      ae: { name: "Ward Physical (Orbment)", changes: [{ key: drPctKey(PHYSICAL.el), mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    id: "bastion", label: "Bastion", icon: "🏰", cost: 0, category: "defensive", tier: 2, house: true,
    appliesTo: ["armor"], vals: [1, 2, 3],
    summary: "You take 3 less damage from every source.", ruleText: "You take less damage from every source.",
    build: (_v, n) => ({ summary: `You take ${n} less damage from every source.`,
      ae: { name: "Bastion (Orbment)", changes: [{ key: drFlatKey("all"), mode: ADD, value: aeScanned(n) }] } }),
  },
  {
    id: "aegis", label: "Aegis", icon: "🏰", cost: 0, category: "defensive", tier: 2, house: true,
    appliesTo: ["armor"], vals: [3, 6, 10], unit: "%",
    summary: "You take 10% less damage from every source.", ruleText: "You take a percentage less damage from every source.",
    build: (_v, n) => ({ summary: `You take ${n}% less damage from every source.`,
      ae: { name: "Aegis (Orbment)", changes: [{ key: drPctKey("all"), mode: ADD, value: aeScanned(n) }] } }),
  },
];

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

const _BY_ID = new Map(AUGMENTS.map((a) => [a.id, a]));

export function getAugment(id) {
  return _BY_ID.get(String(id ?? "")) ?? null;
}

// A unified VIEW of an augment for a chosen param (null for non-param augments)
// and rolled value (null = the rulebook max, which is what every pre-v3 install
// and every Upgrade carries): resolves the display (label/summary/icon) +
// projection (props/rider/ae). A valued augment's label gains "+n" (or "+n%").
export function resolveAugment(id, param = null, value = null) {
  const a = getAugment(id);
  if (!a) return null;
  const n = resolveValue(a, value);
  const view = {
    id: a.id, label: a.label, icon: a.icon, summary: a.summary, cost: a.cost,
    category: a.category ?? "", appliesTo: a.appliesTo, pending: !!a.pending,
    tier: Number.isInteger(a.tier) ? a.tier : null, house: !!a.house,
    param: param ?? null, value: n, vals: a.vals ? a.vals.slice() : null, unit: a.unit ?? "",
    props: a.props, rider: a.rider, ae: a.ae,
    // Keyword-registry term this augment surfaces (Multi/Pierce/status…) for the
    // clickable-keyword link in the description block.
    keyword: a.keyword ?? null,
  };
  if (typeof a.build === "function") {
    const b = a.build(param, n) || {};
    view.label = b.label ?? view.label;
    view.summary = b.summary ?? view.summary;
    view.icon = b.icon ?? view.icon;
    view.props = b.props; view.rider = b.rider; view.ae = b.ae;
    if (b.keyword !== undefined) view.keyword = b.keyword;
  }
  if (n != null) view.label = `${view.label} +${n}${view.unit}`;
  return view;
}

// All augments installable on a given item_type, preserving registry order.
export function augmentsForItemType(itemType) {
  const t = String(itemType ?? "").trim().toLowerCase();
  return AUGMENTS.filter((a) => a.appliesTo.includes(t));
}

// The random-Attunement pool for an item type: installable, tiered, not pending,
// not opted out (damage Immunity).
export function rollableAugments(itemType) {
  return augmentsForItemType(itemType)
    .filter((a) => Number.isInteger(a.tier) && !a.pending && a.rollable !== false);
}

// Upgrade (Tinkerer heroic skill): the rulebook Quality list for the item type,
// cost modifier ≤ 1000 z. House additions and pending entries never qualify.
export const UPGRADE_COST_CAP = 1000;
export function upgradeAugments(itemType) {
  return augmentsForItemType(itemType)
    .filter((a) => !a.house && !a.pending && Number(a.cost) > 0 && Number(a.cost) <= UPGRADE_COST_CAP);
}
