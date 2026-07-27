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

const equipGated = (n) => `\${isEquipped ? ${n} : 0}$`;

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

// The Basic Status Effects (Perfect Health covers exactly these).
const BASIC_STATUSES = ["slow", "weak", "dazed", "shaken", "enraged", "poisoned"];

// Shared on-hit status rider builder (Status / Status Plus).
const onHitStatusRider = (status) => ({
  trigger: "creature_deals_damage",
  effects: [{ effect_kind: "apply_ae", ae_template_ref: cap(status), target_ref: "hit_action_targets", ae_duplicate_mode: "refresh" }],
});

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
    appliesTo: ["weapon"], keyword: "Pierce",
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
    appliesTo: ["weapon"], keyword: "Multi",
    summary: "Attacks strike up to 2 different targets.",
    ruleText: "Attacks with the weapon have multi (2).",
    props: { skill_target: "Up to two creatures" },
  },
  {
    id: "status", label: "Status", icon: "☠️", cost: 1500, category: "offensive",
    appliesTo: ["weapon"],
    summary: "Each target hit suffers a chosen status (dazed / shaken / slow / weak).",
    ruleText: "Each target hit by the weapon suffers the chosen status.",
    param: { prompt: "Choose a status to inflict", options: ["dazed", "shaken", "slow", "weak"].map((s) => ({ value: s, label: cap(s), icon: "☠️" })) },
    build: (v) => ({ label: `Status: ${cap(v)}`, summary: `Each target hit suffers ${v}.`, icon: "☠️", keyword: cap(v), rider: onHitStatusRider(v) }),
  },
  {
    id: "status_plus", label: "Status Plus", icon: "☠️", cost: 2000, category: "offensive",
    appliesTo: ["weapon"],
    summary: "Each target hit suffers a chosen status (enraged / poisoned).",
    ruleText: "Each target hit by the weapon suffers the chosen status.",
    param: { prompt: "Choose a status to inflict", options: ["enraged", "poisoned"].map((s) => ({ value: s, label: cap(s), icon: "☠️" })) },
    build: (v) => ({ label: `Status+: ${cap(v)}`, summary: `Each target hit suffers ${v}.`, icon: "☠️", keyword: cap(v), rider: onHitStatusRider(v) }),
  },

  // ═══ ARMOR & SHIELD — Enhancement (Core p.280) ═════════════════════════════
  {
    // REBALANCE: RAW grants +4; we ship +2. BD re-rolls the Initiative Group
    // Check EVERY round and it's a binary "who acts first" on a 2-die total
    // (~11 avg) vs a DL in the 10-15 band, so +4 swung it far harder than the
    // 500z price implies. Display strings say +2 so the UI never lies.
    id: "initiative_up", label: "Initiative Up", icon: "⚡", cost: 500, category: "enhancement",
    appliesTo: ["armor", "shield"],
    summary: "+2 bonus to your Initiative modifier.",
    ruleText: "You gain a +2 bonus to your Initiative modifier.",
    ae: { name: "Initiative Up (Orbment)", changes: [{ key: "check_mod_init", mode: ADD, value: equipGated(2) }] },
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
    appliesTo: ["armor", "shield"],
    summary: "+1 bonus to your Magic Checks.",
    ruleText: "You gain a +1 bonus to your Magic Checks.",
    ae: { name: "Magic Up (Orbment)", changes: [{ key: "check_mod_magic", mode: ADD, value: equipGated(1) }] },
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
    id: "weapon_up", label: "Weapon Up", icon: "⚔️", cost: 2000, category: "enhancement",
    appliesTo: ["armor", "shield"],
    summary: "Your weapon attacks (melee or ranged) deal 5 extra damage.",
    ruleText: "Your attacks with the chosen weapon type deal 5 extra damage.",
    param: { prompt: "Choose weapon type", options: [{ value: "melee", label: "Melee", icon: "⚔️" }, { value: "ranged", label: "Ranged", icon: "🏹" }] },
    build: (v) => ({ label: `Weapon Up: ${cap(v)}`, summary: `Your ${v} weapon attacks deal 5 extra damage.`, icon: v === "ranged" ? "🏹" : "⚔️",
      ae: { name: `Weapon Up — ${cap(v)} (Orbment)`, changes: [{ key: `extra_damage_mod_${v}`, mode: ADD, value: equipGated(5) }] } }),
  },

  // ═══ DEFENSIVE — Weapon (p.269) + Armor & Shield (p.280) ═══════════════════
  {
    id: "antistatus", label: "Antistatus", icon: "🚫", cost: 500, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Immunity to a chosen status (slow / dazed / shaken / weak).",
    ruleText: "You are immune to the chosen status effect.",
    param: { prompt: "Choose a status", options: ["slow", "dazed", "shaken", "weak"].map((s) => ({ value: s, label: cap(s), icon: "🚫" })) },
    build: (v) => ({ label: `Antistatus: ${cap(v)}`, summary: `Immune to ${v}.`, icon: "🚫", ae: { name: `Antistatus ${cap(v)} (Orbment)`, changes: [immunityChange(v)] } }),
  },
  {
    id: "resistance", label: "Resistance", icon: "🛡️", cost: 700, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Resistance to a chosen damage type (not physical).",
    ruleText: "You have Resistance to a chosen damage type (not physical damage).",
    param: { prompt: "Choose a damage type", options: ELEMENTS.map((e) => ({ value: e.el, label: e.label, icon: e.icon })) },
    build: (v) => { const e = elementOf(v); return e ? { label: `Resistance: ${e.label}`, summary: `Resistance to ${e.label} damage.`, icon: e.icon, ae: { name: `Resistance ${e.label} (Orbment)`, changes: [affinityChange(e.idx, "RS")] } } : {}; },
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
    id: "swordbreaker", label: "Swordbreaker", icon: "🗡️", cost: 1000, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Resistance to physical damage.",
    ruleText: "You have Resistance to physical damage.",
    ae: { name: "Swordbreaker (Orbment)", changes: [affinityChange(1, "RS")] },
  },
  {
    id: "immunity", label: "Immunity", icon: "🚫", cost: 1500, category: "defensive",
    appliesTo: ["weapon", "armor", "shield"],
    summary: "Immunity to a chosen damage type (not physical).",
    ruleText: "You have Immunity to a chosen damage type (not physical damage).",
    param: { prompt: "Choose a damage type", options: ELEMENTS.map((e) => ({ value: e.el, label: e.label, icon: e.icon })) },
    build: (v) => { const e = elementOf(v); return e ? { label: `Immunity: ${e.label}`, summary: `Immunity to ${e.label} damage.`, icon: e.icon, ae: { name: `Immunity ${e.label} (Orbment)`, changes: [affinityChange(e.idx, "IM")] } } : {}; },
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
    summary: "Immune to all Basic Status Effects.",
    ruleText: "You are immune to all Basic Status Effects (Slow, Weak, Dazed, Shaken, Enraged, Poisoned).",
    ae: { name: "Perfect Health (Orbment)", changes: BASIC_STATUSES.map(immunityChange) },
  },
];

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

const _BY_ID = new Map(AUGMENTS.map((a) => [a.id, a]));

export function getAugment(id) {
  return _BY_ID.get(String(id ?? "")) ?? null;
}

// A unified VIEW of an augment for a chosen param (null for non-param augments):
// resolves the display (label/summary/icon) + projection (props/rider/ae).
export function resolveAugment(id, param = null) {
  const a = getAugment(id);
  if (!a) return null;
  const view = {
    id: a.id, label: a.label, icon: a.icon, summary: a.summary, cost: a.cost,
    category: a.category ?? "", appliesTo: a.appliesTo, pending: !!a.pending,
    param: param ?? null, props: a.props, rider: a.rider, ae: a.ae,
    // Keyword-registry term this augment surfaces (Multi/Pierce/status…) for the
    // clickable-keyword link in the description block.
    keyword: a.keyword ?? null,
  };
  if (typeof a.build === "function") {
    const b = a.build(param) || {};
    view.label = b.label ?? view.label;
    view.summary = b.summary ?? view.summary;
    view.icon = b.icon ?? view.icon;
    view.props = b.props; view.rider = b.rider; view.ae = b.ae;
    if (b.keyword !== undefined) view.keyword = b.keyword;
  }
  return view;
}

// All augments installable on a given item_type, preserving registry order.
export function augmentsForItemType(itemType) {
  const t = String(itemType ?? "").trim().toLowerCase();
  return AUGMENTS.filter((a) => a.appliesTo.includes(t));
}
