// scripts/orbment/augment-registry.js
//
// The AUGMENT REGISTRY — static, data-driven definitions of every orbment an
// equipment slot can hold. Modelled on keyword-registry.js: a hardcoded table.
//
// The catalog mirrors the RAW Quality tables:
//   • Weapon qualities        — Core p.269 (offensive + defensive)
//   • Armor & Shield qualities — Core p.280 (enhancement + defensive)
// Accessories can NOT be augmented (enforced in the API/validateItem).
//
// `appliesTo` filters which item types (weapon/armor/shield) may receive an
// augment — this is the "sort by item type" the window uses. `category`
// (offensive|defensive|enhancement) groups the picker within a type.
//
// Each augment compiles via one or more projections the rest of the module reads
// (props / rider / ae — see orbment-compiler.js). Augments whose world mechanism
// isn't cleanly wired yet carry `pending: true`: they appear in the catalog
// (complete + sorted) but the API blocks installing them, and the window dims
// them with a "soon" tag. This keeps the list honest — no broken installs.
//
// Verified mechanisms (test bridge, 2026-07-01):
//   • stat AE  → key bonus_defense / bonus_magic_defense / check_mod_accuracy /
//     extra_damage_mod_<X>, mode ADD, value `${isEquipped ? N : 0}$` (equip-gated).
//   • status immunity → key condition_<status>, mode OVERRIDE, value
//     `${isEquipped ? 'IM' : 'NA'}$`.
//   • defense_target_type "mdef" (Magical); skill_target text (Multi).
// Deferred (mechanism unconfirmed → pending): affinity resistances (positional
//   affinity_1..9, element↔index mapping), species Hunter, and the init/magic/
//   heal Up-lines (actor keys not yet found).

const ADD = 2;       // CONST.ACTIVE_EFFECT_MODES.ADD
const OVERRIDE = 5;  // CONST.ACTIVE_EFFECT_MODES.OVERRIDE

// Equip-gated AE values (CSB formula syntax). Numeric add / override-string.
const equipGated = (n) => `\${isEquipped ? ${n} : 0}$`;
const equipGatedStr = (v, off = "NA") => `\${isEquipped ? '${v}' : '${off}'}$`;

// Status → an immunity AE change (condition_<status> forced to IM while worn).
const immunityChange = (status) => ({ key: `condition_${status}`, mode: OVERRIDE, value: equipGatedStr("IM") });

// Every debuff condition the actor tracks (from the CSB template) — Perfect
// Health forces them all to IM.
const ALL_CONDITIONS = [
  "slow","dazed","weak","shaken","poisoned","enraged","silence","stagger","frightened",
  "paralyzed","confused","panic","grappled","envenomed","burn","blind","zombie","wither",
  "bleed","obscure","fatigue","charm","berserk","despair","doom","bane","curse","wet","oil",
  "petrify","hypothermia","turbulence","delayed","isolate","suppress","disarmed","anomaly",
];

export const AUGMENTS = [
  // ═══ WEAPON — Offensive (Core p.269) ═══════════════════════════════════════
  {
    id: "magical", label: "Magical", icon: "✨", cost: 100, category: "offensive",
    appliesTo: ["weapon"],
    summary: "The weapon targets Magic Defense instead of Defense.",
    ruleText: "The weapon targets Magic Defense instead of Defense.",
    props: { defense_target_type: "mdef" },
  },
  {
    id: "hunter", label: "Hunter", icon: "🏹", cost: 300, category: "offensive",
    appliesTo: ["weapon"], pending: true,
    summary: "Deals 5 extra damage to creatures of a particular Species.",
    ruleText: "The weapon deals 5 extra damage to creatures of a particular Species.",
  },
  {
    id: "piercing", label: "Piercing", icon: "🩸", cost: 400, category: "offensive",
    appliesTo: ["weapon"],
    summary: "Damage dealt by the weapon ignores Resistances.",
    ruleText: "Damage dealt by the weapon ignores Resistances.",
    rider: {
      trigger: "creature_will_deal_damage",
      effects: [{ effect_kind: "apply_action_keyword", action_keyword: "pierce" }],
    },
  },
  {
    id: "dual_hunter", label: "Dual Hunter", icon: "🏹", cost: 500, category: "offensive",
    appliesTo: ["weapon"], pending: true,
    summary: "Deals 5 extra damage to creatures of one of two Species.",
    ruleText: "The weapon deals 5 extra damage to creatures belonging to one of two particular Species.",
  },
  {
    id: "multi", label: "Multi (2)", icon: "🎯", cost: 1000, category: "offensive",
    appliesTo: ["weapon"],
    summary: "Attacks strike up to 2 different targets.",
    ruleText: "Attacks with the weapon have multi (2).",
    props: { skill_target: "Up to two creatures" },
  },
  ...["dazed", "shaken", "slow", "weak"].map((st) => ({
    id: `status_${st}`, label: `Status: ${cap(st)}`, icon: "☠️", cost: 1500, category: "offensive",
    appliesTo: ["weapon"],
    summary: `Each target hit by the weapon suffers ${st}.`,
    ruleText: `Each target hit by the weapon suffers ${st}.`,
    rider: {
      trigger: "creature_deals_damage",
      effects: [{ effect_kind: "apply_ae", ae_template_ref: cap(st), target_ref: "hit_action_targets", ae_duplicate_mode: "refresh" }],
    },
  })),
  ...["enraged", "poisoned"].map((st) => ({
    id: `status_${st}`, label: `Status+: ${cap(st)}`, icon: "☠️", cost: 2000, category: "offensive",
    appliesTo: ["weapon"],
    summary: `Each target hit by the weapon suffers ${st}.`,
    ruleText: `Each target hit by the weapon suffers ${st}.`,
    rider: {
      trigger: "creature_deals_damage",
      effects: [{ effect_kind: "apply_ae", ae_template_ref: cap(st), target_ref: "hit_action_targets", ae_duplicate_mode: "refresh" }],
    },
  })),

  // ═══ ARMOR & SHIELD — Enhancement (Core p.280) ═════════════════════════════
  {
    id: "initiative_up", label: "Initiative Up", icon: "⚡", cost: 500, category: "enhancement",
    appliesTo: ["armor", "shield"], pending: true,
    summary: "+4 bonus to your Initiative modifier.",
    ruleText: "You gain a +4 bonus to your Initiative modifier.",
  },
  {
    id: "accuracy_up", label: "Accuracy Up", icon: "🎯", cost: 1000, category: "enhancement",
    appliesTo: ["armor", "shield"],
    summary: "+1 bonus to your Accuracy Checks.",
    ruleText: "You gain a +1 bonus to your Accuracy Checks.",
    ae: { name: "Accuracy Up (Orbment)", changes: [{ key: "check_mod_accuracy", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "magic_up", label: "Magic Up", icon: "🔯", cost: 1000, category: "enhancement",
    appliesTo: ["armor", "shield"], pending: true,
    summary: "+1 bonus to your Magic Checks.",
    ruleText: "You gain a +1 bonus to your Magic Checks.",
  },
  {
    id: "vitality_up", label: "Vitality Up", icon: "💚", cost: 1000, category: "enhancement",
    appliesTo: ["armor", "shield"], pending: true,
    summary: "When you recover HP, you recover 5 extra HP.",
    ruleText: "When you recover HP, you recover 5 extra HP.",
  },
  {
    id: "healing_up", label: "Healing Up", icon: "✚", cost: 1500, category: "enhancement",
    appliesTo: ["armor", "shield"], pending: true,
    summary: "Your HP-restoring spells restore 5 extra HP.",
    ruleText: "Spells you cast that restore Hit Points will restore 5 extra Hit Points.",
  },
  {
    id: "spell_up", label: "Spell Up", icon: "🔮", cost: 2000, category: "enhancement",
    appliesTo: ["armor", "shield"],
    summary: "Spells you cast deal 5 extra damage.",
    ruleText: "Spells you cast deal 5 extra damage.",
    ae: { name: "Spell Up (Orbment)", changes: [{ key: "extra_damage_mod_spell", mode: ADD, value: equipGated(5) }] },
  },
  {
    id: "weapon_up_melee", label: "Weapon Up (Melee)", icon: "⚔️", cost: 2000, category: "enhancement",
    appliesTo: ["armor", "shield"],
    summary: "Your melee weapon attacks deal 5 extra damage.",
    ruleText: "Your attacks with melee weapons deal 5 extra damage.",
    ae: { name: "Weapon Up — Melee (Orbment)", changes: [{ key: "extra_damage_mod_melee", mode: ADD, value: equipGated(5) }] },
  },
  {
    id: "weapon_up_ranged", label: "Weapon Up (Ranged)", icon: "🏹", cost: 2000, category: "enhancement",
    appliesTo: ["armor", "shield"],
    summary: "Your ranged weapon attacks deal 5 extra damage.",
    ruleText: "Your attacks with ranged weapons deal 5 extra damage.",
    ae: { name: "Weapon Up — Ranged (Orbment)", changes: [{ key: "extra_damage_mod_ranged", mode: ADD, value: equipGated(5) }] },
  },

  // ═══ DEFENSIVE — Weapon (p.269) + Armor & Shield (p.280) ═══════════════════
  {
    id: "antistatus", label: "Antistatus", icon: "🚫", cost: 500, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"], pending: true,
    summary: "You are immune to a single status effect (choose one).",
    ruleText: "You are immune to a single status effect.",
    // Mechanism confirmed (condition_<status>: IM) but needs a status picker —
    // pending the choice-picker feature.
  },
  {
    id: "resistance", label: "Resistance", icon: "🛡️", cost: 700, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"], pending: true,
    summary: "Resistance to a single damage type (not physical).",
    ruleText: "You have Resistance to a single damage type (not physical damage).",
  },
  {
    id: "amulet", label: "Amulet", icon: "🔮", cost: 800, category: "defensive",
    appliesTo: ["weapon"],
    summary: "+1 bonus to Magic Defense.",
    ruleText: "You gain a +1 bonus to Magic Defense.",
    ae: { name: "Amulet (Orbment)", changes: [{ key: "bonus_magic_defense", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "bulwark", label: "Bulwark", icon: "🛡️", cost: 800, category: "defensive",
    appliesTo: ["weapon"],
    summary: "+1 bonus to Defense.",
    ruleText: "You gain a +1 bonus to Defense.",
    ae: { name: "Bulwark (Orbment)", changes: [{ key: "bonus_defense", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "dual_resistance", label: "Dual Resistance", icon: "🛡️", cost: 1000, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"], pending: true,
    summary: "Resistance to two damage types (not physical).",
    ruleText: "You have Resistance to two damage types (not physical damage).",
  },
  {
    id: "swordbreaker", label: "Swordbreaker", icon: "🛡️", cost: 1000, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"], pending: true,
    summary: "Resistance to physical damage.",
    ruleText: "You have Resistance to physical damage.",
  },
  {
    id: "immunity", label: "Immunity", icon: "🚫", cost: 1500, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"], pending: true,
    summary: "Immunity to a single damage type (not physical).",
    ruleText: "You have Immunity to a single damage type (not physical damage).",
  },
  {
    id: "omnishield", label: "Omnishield", icon: "🛡️", cost: 2000, category: "defensive",
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
    id: "perfect_health", label: "Perfect Health", icon: "💠", cost: 2000, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"],
    summary: "You are immune to all status effects.",
    ruleText: "You are immune to all status effects.",
    ae: { name: "Perfect Health (Orbment)", changes: ALL_CONDITIONS.map(immunityChange) },
  },
];

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

const _BY_ID = new Map(AUGMENTS.map((a) => [a.id, a]));

export function getAugment(id) {
  return _BY_ID.get(String(id ?? "")) ?? null;
}

// All augments installable on a given item_type ("weapon"|"armor"|"shield"),
// preserving registry order (offensive → enhancement → defensive by section).
export function augmentsForItemType(itemType) {
  const t = String(itemType ?? "").trim().toLowerCase();
  return AUGMENTS.filter((a) => a.appliesTo.includes(t));
}
