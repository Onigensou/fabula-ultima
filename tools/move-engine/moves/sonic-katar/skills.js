// ═════════ Sonic Katar family · SKILL BLOCKS (move-engine Phase 4) — plain data, loaded by the page AND by Node
// One block per game document a move's rules live on. `props` / `effects` / `reactions` / `flags` are the LOGIC fields of the
// item (system.props, the two row tables, the module flags); the item's text and art stay authored as they are today.
// `bind` ties a move's page slider to a field: the slider's approved value IS the skill's value. `move` names that move.
//   node tools/move-engine/bin/move-engine.js export sonic-katar [skill…] [--check]
// Fields here must match what the game holds (export --check proves it, a round trip); change them and export writes the migration.
const MOVE_SKILLS = {
  // Sonic Blow (Sonic Katar's skill, v1.0.652): one Attack card with the weapon, Chain 8 Volley, the hit's damage ×2 shared over
  // the strikes, −2 per strike, crit ×1.5 without Opportunity, Perfect (every strike lands) ×1.5
  sonic_blow: {
    doc: { id: "f3QKcoZ4HwrR607a", name: "Sonic Blow" },
    move: "sonicblow",
    // game numbers for the page: real sim battles (move-engine.js pack sonic-katar sonic_blow); Blanche = the DEX d12 wielder the balance read uses
    pack: { actor: "Blanche", weapon: "Sonic Katar", target: "Test Target Enemy", skill: "Sonic Blow", strikes: 8 },
    props: { skill_type: "Active", cost: "30 MP", skill_target: "One creature", duration: "Instantaneous", skill_range: "Melee",
      isCheck: true, rolled_atr1: "DEX", rolled_atr2: "DEX", check_bonus: "-2", damage_bonus: "", type_damage: "",
      defense_target_type: "def", action_keywords: "chain 8 volley", attack_with_carrier: true, on_activate_effect_ref: "",
      action_command: "skill" },   // picked from the Skill menu (validator ACTION_COMMAND_MISSING, 2026-11-22)
    effects: [],
    reactions: [],
    flags: { carrierAttack: { damageMult: 2, critDamageMult: 1.5, noCritOpportunity: true, perfectMult: 1.5 } },
    bind: {
      mp:    { path: "props.cost", to: (v) => v + " MP" },
      pen:   { path: "props.check_bonus", to: (v) => String(-v) },
      n:     { path: "props.action_keywords", to: (v) => "chain " + v + " volley" },
      // each landed strike = share × one normal hit, so the whole volley = share × n hits
      share: { path: "flags.carrierAttack.damageMult", to: (v, T) => Math.round(v * T.n * 1000) / 1000 },
      critm: { path: "flags.carrierAttack.critDamageMult" },
      perf:  { path: "flags.carrierAttack.perfectMult" },
    },
  },
  // Gunblade (Passive) (v1.0.652): Sword form, a hit with an odd Accuracy total or a crit → +10 and the damage becomes Fire
  gunblade_passive: {
    doc: { id: "SnGbGunbladePsv1", name: "Gunblade (Passive)", container: "mODVDmjIfozcfERi" },
    move: "gb_sword",
    props: { isReaction: true, skill_type: "Passive", skill_target: "Self" },
    effects: [
      { effect_kind: "chain", effect_label: "gb_fire", chain_steps: "gb_fire_plus, gb_fire_el" },
      { effect_kind: "adjust_damage", effect_label: "gb_fire_plus", damage_stage: "outgoing", damage_operation: "add", damage_amount: "10" },
      { effect_kind: "change_damage_element", effect_label: "gb_fire_el", change_element: "fire" },
    ],
    reactions: [
      { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self", reaction_requires_weapon_used: true,
        condition_formula: "WEAPON_FORM == 0 && DAMAGE_IS_HP == 1 && (ATTACK_CHECK_RESULT % 2 == 1 || ATTACK_IS_CRIT == 1)", reaction_effect_ref: "gb_fire" },
    ],
    flags: {},
    bind: {
      fb: { path: "effects.gb_fire_plus.damage_amount", to: (v) => String(v) },
    },
  },
};
if (typeof module !== "undefined" && module.exports) module.exports = MOVE_SKILLS;
