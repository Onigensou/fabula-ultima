// scripts/orbment/augment-registry.js
//
// The AUGMENT REGISTRY — static, data-driven definitions of every orbment an
// equipment slot can hold. Modelled on keyword-registry.js: a hardcoded table,
// not read from world data, so adding an augment is a code edit (augments change
// rarely and must map to engine-supported projections).
//
// Each augment declares ONE OR MORE projections; the compiler (orbment-compiler.js)
// compiles installed augments into fields the rest of the module already reads:
//
//   props: { <itemPropKey>: value }
//       Simple overrides on item.system.props. The compiler snapshots the
//       intrinsic value into flags.baseProps before overriding, so removal
//       restores it exactly. Multi → skill_target; Magical → defense_target_type.
//
//   rider: { trigger, condition_formula?, effects:[ <effect_table row fields> ] }
//       Weapon-used keyword automation. The compiler writes a reaction_config_table
//       row (gated reaction_requires_weapon_used:true, reaction_source:"self") + the
//       effect_table rows, all key/label-prefixed ORBMENT_ROW_PREFIX so recompile
//       strips the prior set cleanly. Read by the Battle Director effect pipeline.
//
//   ae: { name, icon?, changes:[{key,mode,value}] }
//       An embedded managed ActiveEffect (transfer:true) tagged ORBMENT_TAG. Stat
//       bonuses. Value formulas follow the world's proven equip-gated shape
//       `${isEquipped ? N : 0}$` so the bonus applies only while the item is worn
//       (verified against +5 Runic Shield / Matador Cape "DEF UP" AEs).
//
// COST = the RAW Quality zenit cost (p.269 weapons / p.280 armor & shield). It is
// DISPLAY-ONLY in v1 (tracked, not auto-deducted) per the design decision.
//
// See [[project_bd_effect_pipeline]] / [[reference_bd_monster_automation]] for the
// effect-row grammar and [[project_keyword_registry_tooltip]] for the registry idiom.

// AE change modes (Foundry CONST.ACTIVE_EFFECT_MODES).
const ADD = 2;

// A weapon-used pre/post-resolve reaction row's standard gate: fires only on the
// owning creature's own action AND only when THIS weapon was the one used.
const WEAPON_USED = { reaction_source: "self", reaction_requires_weapon_used: true };

// Equip-gated numeric AE value in the world's CSB formula syntax.
const equipGated = (n) => `\${isEquipped ? ${n} : 0}$`;

// ── The registry ─────────────────────────────────────────────────────────────
// Ordered roughly as the rulebook lists them. `appliesTo` filters which item
// types (weapon/armor/shield) may receive the augment.

export const AUGMENTS = [
  // ─── Offensive weapon qualities (RAW p.269) ───────────────────────────────
  {
    id: "multi",
    label: "Multi (2)",
    icon: "🎯",
    cost: 1000,
    appliesTo: ["weapon"],
    summary: "Attacks strike up to 2 different targets.",
    ruleText: "Attacks with the weapon have multi (2).",
    // Multi is pure targeting: the weapon's skill_target text drives
    // resolveTargetPlan → the PC weapon attack offers up to 2 targets.
    props: { skill_target: "Up to two creatures" },
  },
  {
    id: "magical",
    label: "Magical",
    icon: "✨",
    cost: 100,
    appliesTo: ["weapon"],
    summary: "The weapon targets Magic Defense instead of Defense.",
    ruleText: "The weapon targets Magic Defense instead of Defense.",
    props: { defense_target_type: "mdef" },
  },
  {
    id: "piercing",
    label: "Piercing",
    icon: "🩸",
    cost: 400,
    appliesTo: ["weapon"],
    summary: "Damage dealt by the weapon ignores Resistances.",
    ruleText: "Damage dealt by the weapon ignores Resistances.",
    // apply_action_keyword "pierce" is folded in at damage recompute
    // (pre-resolve), so a creature_will_deal_damage rider carries it.
    rider: {
      trigger: "creature_will_deal_damage",
      effects: [{ effect_kind: "apply_action_keyword", action_keyword: "pierce" }],
    },
  },
  // Status quality (RAW: choose one of dazed/shaken/slow/weak). Modelled as four
  // discrete augments so the installed choice is explicit in the slot.
  ...["dazed", "shaken", "slow", "weak"].map((st) => ({
    id: `status_${st}`,
    label: `Status: ${st[0].toUpperCase()}${st.slice(1)}`,
    icon: "☠️",
    cost: 1500,
    appliesTo: ["weapon"],
    summary: `Each target hit by the weapon suffers ${st}.`,
    ruleText: `Each target hit by the weapon suffers ${st}.`,
    // On-hit status is post-resolve: apply the debuff AE to the creatures hit.
    // ae_template_ref resolves by bare name via the world Debuff container
    // (same resolution monster automation uses for "Burn").
    rider: {
      trigger: "creature_deals_damage",
      effects: [{
        effect_kind: "apply_ae",
        ae_template_ref: st[0].toUpperCase() + st.slice(1),
        target_ref: "hit_action_targets",
        ae_duplicate_mode: "refresh",
      }],
    },
  })),
  ...["enraged", "poisoned"].map((st) => ({
    id: `status_${st}`,
    label: `Status+: ${st[0].toUpperCase()}${st.slice(1)}`,
    icon: "☠️",
    cost: 2000,
    appliesTo: ["weapon"],
    summary: `Each target hit by the weapon suffers ${st}.`,
    ruleText: `Each target hit by the weapon suffers ${st}.`,
    rider: {
      trigger: "creature_deals_damage",
      effects: [{
        effect_kind: "apply_ae",
        ae_template_ref: st[0].toUpperCase() + st.slice(1),
        target_ref: "hit_action_targets",
        ae_duplicate_mode: "refresh",
      }],
    },
  })),

  // ─── Defensive qualities (RAW p.269 weapon list / p.280 armor & shield) ────
  {
    id: "bulwark",
    label: "Bulwark",
    icon: "🛡️",
    cost: 800,
    appliesTo: ["weapon", "shield", "armor"],
    summary: "+1 bonus to Defense.",
    ruleText: "You gain a +1 bonus to Defense.",
    ae: { name: "Bulwark (Orbment)", changes: [{ key: "bonus_defense", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "amulet",
    label: "Amulet",
    icon: "🔮",
    cost: 800,
    appliesTo: ["weapon", "shield", "armor"],
    summary: "+1 bonus to Magic Defense.",
    ruleText: "You gain a +1 bonus to Magic Defense.",
    ae: { name: "Amulet (Orbment)", changes: [{ key: "bonus_magic_defense", mode: ADD, value: equipGated(1) }] },
  },
  {
    id: "omnishield",
    label: "Omnishield",
    icon: "🛡️",
    cost: 2000,
    appliesTo: ["weapon", "shield", "armor"],
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

  // ─── Enhancement qualities (RAW p.280 armor & shield) ──────────────────────
  {
    id: "accuracy_up",
    label: "Accuracy Up",
    icon: "🎯",
    cost: 1000,
    appliesTo: ["armor", "shield"],
    summary: "+1 bonus to Accuracy Checks.",
    ruleText: "You gain a +1 bonus to your Accuracy Checks.",
    ae: { name: "Accuracy Up (Orbment)", changes: [{ key: "check_mod_accuracy", mode: ADD, value: equipGated(1) }] },
  },
];

// ── Extension stubs (RAW qualities NOT yet seeded) ─────────────────────────────
// The following qualities need world-specific keys/data before they can be added
// safely, so they are documented here rather than shipped half-wired:
//   • Resistance / Dual Resistance / Immunity / Swordbreaker — affinity system
//     (actor affinity_1..N props are "NA"/element pairs, not a simple +N add).
//   • Antistatus / Perfect Health — status-immunity items (see world "Status
//     Immunity" AE items) rather than a stat change.
//   • Hunter / Dual Hunter — +5 vs Species: an adjust_damage rider gated on the
//     target's species (the *_ef species props exist on weapons already).
//   • Initiative Up / Magic Up / Vitality Up / Healing Up / Spell Up / Weapon Up
//     — need the matching actor derived-stat keys confirmed (mirror the ae shape).
// Each maps onto an EXISTING projection kind above; wiring is data, not engine.

const _BY_ID = new Map(AUGMENTS.map((a) => [a.id, a]));

// Look up a full augment def by id (null if unknown).
export function getAugment(id) {
  return _BY_ID.get(String(id ?? "")) ?? null;
}

// All augments installable on a given item_type ("weapon"|"armor"|"shield").
export function augmentsForItemType(itemType) {
  const t = String(itemType ?? "").trim().toLowerCase();
  return AUGMENTS.filter((a) => a.appliesTo.includes(t));
}

export { WEAPON_USED };
