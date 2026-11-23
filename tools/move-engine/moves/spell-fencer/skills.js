// ═════════ Spell Fencer · SKILL BLOCKS (move-engine Phase 4) — rules only (no move, no page sliders)
// Design approved 2026-11-23 (class page https://claude.ai/artifact/7ioWPpurkP3XtdJr5okMSz, rounds 1–4):
//   Resonance  an AE with charges on the bearer. Start each conflict with 1, max 【Spellweave SL + 1】, lost at scene end.
//              Each SWITCH between a weapon attack and an Offensive Spell grants 1 (free attacks count). Turns where
//              Spellblade Rhapsody is used grant none.
//   Rhythm     two marker AEs, "Next Spell" (last action was a weapon attack) / "Next Attack" (last was an Offensive Spell),
//              swapped when an attack / spell completes. They drive the switch gain, Bladework and the red / blue aura.
//   Rhapsody   2 Resonance (or Encore's once-per-scene charge): marks the turn ("Rhapsody Turn", round end), then a free
//              Attack or Offensive Spell (≤ SL × 10 MP), and when it completes, a free action of the other kind.
// The text of every skill is authored by data-migrations/2026-11-23-spell-fencer-author.js (it also creates the 3 Heroics).
//   node tools/move-engine/bin/move-engine.js export spell-fencer [skill…] [--check]
const SK = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/";
const BF = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Buff%20Icon/";

// shared pieces ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const SELF = (label) => ({ effect_kind: "targeting", effect_label: label, candidate_source: "self", count: "1", mode: "exact",
  iteration_mode: "together", auto_target: "skip", auto_confirm_when_obvious: true, skip_when_passive: true });
// an Offensive Spell for the rhythm: a spell that rolls Accuracy; Master of Duality lets every spell count
const RHYTHM_SPELL = "ACTION_IS_SPELL == 1 && (ACTION_ROLLS_ACCURACY == 1 || HAS_SKILL_MASTER_OF_DUALITY == 1)";
const NO_RHAPSODY = "AE_COUNT_RHAPSODY_TURN == 0";
const MARKER_AES = [
  { name: "Next Spell", transfer: false, changes: [], img: BF + "MAGIC%20UP.png", statuses: ["fud-next-spell"],
    flags: { lifetimeMode: "persistent_counter", tags: ["spell-fencer-rhythm"] } },
  { name: "Next Attack", transfer: false, changes: [], img: BF + "AttackUp.png", statuses: ["fud-next-attack"],
    flags: { lifetimeMode: "persistent_counter", tags: ["spell-fencer-rhythm"] } },
];
// the marker swap after an attack / spell (prefix = row label prefix, self = the targeting row)
const swapRows = (pre, self) => [
  { effect_kind: "remove_ae", effect_label: pre + "_atk_off", ae_template_ref: "Next Attack", include_persistent: true, target_ref: "self" },
  { effect_kind: "apply_ae", effect_label: pre + "_atk_on", ae_template_ref: "Next Spell", ae_duplicate_mode: "replace", target_ref: self },
  { effect_kind: "remove_ae", effect_label: pre + "_spl_off", ae_template_ref: "Next Spell", include_persistent: true, target_ref: "self" },
  { effect_kind: "apply_ae", effect_label: pre + "_spl_on", ae_template_ref: "Next Attack", ae_duplicate_mode: "replace", target_ref: self },
];

// Mystic Infusion: one AE per element the next weapon attack can take
const ELEMENTS = ["Air", "Bolt", "Dark", "Earth", "Fire", "Ice", "Light", "Poison"];
const INFUSION_AE = (el) => "Mystic Infusion (" + el + ")";
const ALL_INFUSIONS = ELEMENTS.map(INFUSION_AE).join(", ");

const MOVE_SKILLS = {
  // ── Spellweave (Passive, SL 1–5) ─────────────────────────────────────────────────────────────────────────────────────
  // Switching between a weapon attack and an Offensive Spell grants 1 Resonance. Start each conflict with 1 Resonance.
  // Max 【SL + 1】 stacks, lost at scene end. When you cast an Offensive Spell, spend up to 【SL】 Resonance for +1 Accuracy each.
  spellweave: {
    doc: { id: "dDT8OrIPHFQuyfQp", name: "Spellweave" },
    props: { skill_type: "Passive", skill_target: "Self" },
    effects: [
      SELF("sw_self"),
      { effect_kind: "chain", effect_label: "sw_seed", chain_steps: "sw_seed_res, sw_seed_clear" },
      { effect_kind: "apply_ae", effect_label: "sw_seed_res", ae_template_ref: "Resonance", ae_duplicate_mode: "replace",
        ae_initial_charges: "1", ae_initial_charges_max: "SL + 1", target_ref: "sw_self" },
      { effect_kind: "remove_ae", effect_label: "sw_seed_clear", ae_template_ref: "Next Spell, Next Attack", include_persistent: true, target_ref: "self" },
      // after a weapon attack: +1 if the last action was an Offensive Spell, then Next Spell
      { effect_kind: "chain", effect_label: "sw_atk", chain_steps: "sw_atk_gain, sw_atk_off, sw_atk_on" },
      { effect_kind: "apply_ae", effect_label: "sw_atk_gain", ae_template_ref: "Resonance", ae_duplicate_mode: "add_charges",
        ae_initial_charges: "1", ae_initial_charges_max: "SL + 1", target_ref: "sw_self",
        condition_formula: "AE_COUNT_NEXT_ATTACK > 0 && " + NO_RHAPSODY, on_condition_fail: "skip" },
      // after an Offensive Spell: +1 if the last action was a weapon attack, then Next Attack
      { effect_kind: "chain", effect_label: "sw_spl", chain_steps: "sw_spl_gain, sw_spl_off, sw_spl_on" },
      { effect_kind: "apply_ae", effect_label: "sw_spl_gain", ae_template_ref: "Resonance", ae_duplicate_mode: "add_charges",
        ae_initial_charges: "1", ae_initial_charges_max: "SL + 1", target_ref: "sw_self",
        condition_formula: "AE_COUNT_NEXT_SPELL > 0 && " + NO_RHAPSODY, on_condition_fail: "skip" },
      ...swapRows("sw", "sw_self"),
      // the Accuracy spend (an "ask" pill on the player's own Offensive Spell)
      { effect_kind: "chain", effect_label: "sw_spend", chain_steps: "sw_spend_n, sw_spend_acc, sw_spend_pay",
        menu_label: "Spellweave", menu_description: "Spend Resonance: +1 Accuracy each." },
      { effect_kind: "prompt_number", effect_label: "sw_spend_n", prompt_var: "res_spend",
        prompt_label: "Spellweave: spend Resonance (+1 Accuracy each)", prompt_min: "1", prompt_max: "min(SL, AE_CHARGES_RESONANCE)", prompt_step: "1" },
      { effect_kind: "adjust_accuracy", effect_label: "sw_spend_acc", accuracy_operation: "add", accuracy_amount: "VAR_RES_SPEND" },
      { effect_kind: "adjust_charges", effect_label: "sw_spend_pay", charge_ae_name: "Resonance", charge_operation: "subtract",
        charge_amount: "VAR_RES_SPEND", target_ref: "self" },
    ],
    reactions: [
      { reaction_trigger: "conflict_start", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_effect_ref: "sw_seed" },
      { reaction_trigger: "creature_completes_attack", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        reaction_effect_ref: "sw_atk" },
      { reaction_trigger: "creature_completes_spell", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        condition_formula: RHYTHM_SPELL, reaction_effect_ref: "sw_spl" },
      { reaction_trigger: "creature_performs_action", reaction_passive_mode: "ask", reaction_source: "self", reaction_action_kind: "Skill,Spell",
        condition_formula: "ACTION_IS_SPELL == 1 && ACTION_ROLLS_ACCURACY == 1 && AE_CHARGES_RESONANCE >= 1", reaction_effect_ref: "sw_spend" },
    ],
    flags: {},
    aes: [
      { name: "Resonance", transfer: false, changes: [], img: SK + "15_RDM/dualcast.png", statuses: ["fud-resonance"],
        flags: { chargeKey: "resonance", charges: 1, chargesMax: 3, lifetimeMode: "persistent_counter", tags: ["resource"] } },
      ...MARKER_AES,
    ],
  },

  // ── Spellblade Rhapsody (Active, SL 1–3, cost 2 Resonance) ────────────────────────────────────────────────────────────
  // This turn, perform both the 【⚔️Attack】 and 【📕Spell】 actions. The spell must be an Offensive Spell costing 【SL × 10】 MP
  // or less. Generates no Resonance this turn. (Encore: once per scene it costs no Resonance.)
  spellblade_rhapsody: {
    doc: { id: "4qw6XEVHQmERzZ8y", name: "Spellblade Rhapsody" },
    props: { skill_type: "Active", cost: "2 Resonance", skill_target: "Self", duration: "Instantaneous", isCheck: false,
      on_activate_effect_ref: "rh_root", availability_formula: "AE_CHARGES_RESONANCE >= 2 || AE_CHARGES_ENCORE >= 1",
      action_command: "skill" },
    effects: [
      { effect_kind: "chain", effect_label: "rh_root", chain_steps: "rh_pay_enc, rh_pay_res, rh_turn, rh_pend, rh_first, rh_first_d" },
      { effect_kind: "consume_charge", effect_label: "rh_pay_enc", charge_key: "encore", count: "1", on_empty: "abort", target_ref: "self",
        condition_formula: "AE_CHARGES_RESONANCE < 2", on_condition_fail: "skip" },
      { effect_kind: "consume_charge", effect_label: "rh_pay_res", charge_key: "resonance", count: "2", on_empty: "abort", target_ref: "self",
        condition_formula: "AE_CHARGES_RESONANCE >= 2", on_condition_fail: "skip" },
      { effect_kind: "apply_ae", effect_label: "rh_turn", ae_template_ref: "Rhapsody Turn", ae_duplicate_mode: "replace",
        ae_lifetime_mode: "round_end", ae_duration_rounds: "1", target_ref: "self" },
      { effect_kind: "apply_ae", effect_label: "rh_pend", ae_template_ref: "Rhapsody Pending", ae_duplicate_mode: "replace",
        ae_lifetime_mode: "persistent_counter", target_ref: "self" },
      // the first free action: either kind (the second is the other kind, from the completion rows below)
      { effect_kind: "free_action", effect_label: "rh_first", action_ref: "Attack,Spell", max_mp_cost: "SL * 10", allowed_skill_refs: "kind:offensive",
        condition_formula: "HAS_SKILL_MASTER_OF_DUALITY == 0", on_condition_fail: "skip" },
      { effect_kind: "free_action", effect_label: "rh_first_d", action_ref: "Attack,Spell", max_mp_cost: "SL * 10",
        condition_formula: "HAS_SKILL_MASTER_OF_DUALITY == 1", on_condition_fail: "skip" },
      { effect_kind: "remove_ae", effect_label: "rh_unpend", ae_template_ref: "Rhapsody Pending", include_persistent: true, target_ref: "self" },
      { effect_kind: "chain", effect_label: "rh_then_spell", chain_steps: "rh_unpend, rh_spell, rh_spell_d" },
      { effect_kind: "free_action", effect_label: "rh_spell", action_ref: "Spell", max_mp_cost: "SL * 10", allowed_skill_refs: "kind:offensive",
        condition_formula: "HAS_SKILL_MASTER_OF_DUALITY == 0", on_condition_fail: "skip" },
      { effect_kind: "free_action", effect_label: "rh_spell_d", action_ref: "Spell", max_mp_cost: "SL * 10",
        condition_formula: "HAS_SKILL_MASTER_OF_DUALITY == 1", on_condition_fail: "skip" },
      { effect_kind: "chain", effect_label: "rh_then_attack", chain_steps: "rh_unpend, rh_attack" },
      { effect_kind: "free_action", effect_label: "rh_attack", action_ref: "Attack" },
    ],
    reactions: [
      { reaction_trigger: "creature_completes_attack", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        condition_formula: "AE_COUNT_RHAPSODY_PENDING > 0", reaction_effect_ref: "rh_then_spell" },
      { reaction_trigger: "creature_completes_spell", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        condition_formula: "AE_COUNT_RHAPSODY_PENDING > 0 && ACTION_IS_SPELL == 1", reaction_effect_ref: "rh_then_attack" },
      { reaction_trigger: "turn_end", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        condition_formula: "AE_COUNT_RHAPSODY_PENDING > 0", reaction_effect_ref: "rh_unpend" },
    ],
    flags: {},
    aes: [
      { name: "Rhapsody Turn", transfer: false, changes: [], img: SK + "15_RDM/fleche.png", statuses: ["fud-rhapsody-turn"],
        flags: { lifetimeMode: "round_end", tags: ["spell-fencer"] } },
      { name: "Rhapsody Pending", transfer: false, changes: [], img: SK + "15_RDM/fleche.png",
        flags: { lifetimeMode: "persistent_counter", tags: ["spell-fencer"] } },
    ],
  },

  // ── Bladework (Passive, SL 1–5) ──────────────────────────────────────────────────────────────────────────────────────
  // After you cast an Offensive Spell, your next weapon attack deals 【SL】 extra damage. On hit, recover 【SL × 2】 MP.
  // It carries the rhythm markers too, for a Bladework owner without Spellweave (gated so they never run twice).
  bladework: {
    doc: { id: "GqVU8ps3IJp0KQ3Y", name: "Bladework" },
    props: { skill_type: "Passive", skill_target: "Self" },
    effects: [
      SELF("bw_self"),
      { effect_kind: "chain", effect_label: "bw_hit", chain_steps: "bw_dmg, bw_mp" },
      { effect_kind: "adjust_damage", effect_label: "bw_dmg", damage_operation: "add", damage_stage: "outgoing", damage_amount: "SL", target_ref: "trigger_subject" },
      { effect_kind: "grant", effect_label: "bw_mp", grant_resource: "mp", grant_amount: "SL * 2", target_ref: "bw_self" },
      { effect_kind: "chain", effect_label: "bw_atk", chain_steps: "bw_atk_off, bw_atk_on" },
      { effect_kind: "chain", effect_label: "bw_spl", chain_steps: "bw_spl_off, bw_spl_on" },
      ...swapRows("bw", "bw_self"),
    ],
    reactions: [
      { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self", reaction_action_target: "enemy",
        condition_formula: "ACTION_IS_ATTACK == 1 && DAMAGE_IS_HP == 1 && AE_COUNT_NEXT_ATTACK > 0", reaction_effect_ref: "bw_hit" },
      { reaction_trigger: "creature_completes_attack", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        condition_formula: "HAS_SKILL_SPELLWEAVE == 0", reaction_effect_ref: "bw_atk" },
      { reaction_trigger: "creature_completes_spell", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        condition_formula: "HAS_SKILL_SPELLWEAVE == 0 && " + RHYTHM_SPELL, reaction_effect_ref: "bw_spl" },
    ],
    flags: {},
    aes: MARKER_AES,
  },

  // ── Mystic Infusion (Passive, SL 1) ──────────────────────────────────────────────────────────────────────────────────
  // After you cast an Offensive Spell, your next weapon attack deals that spell's damage type.
  mystic_infusion: {
    doc: { id: "XwoHbYxHvfqvHHAZ", name: "Mystic Infusion" },
    props: { skill_type: "Passive", skill_target: "Self" },
    effects: [
      { effect_kind: "remove_ae", effect_label: "mi_clear", ae_template_ref: ALL_INFUSIONS, include_persistent: true, target_ref: "self" },
      ...ELEMENTS.flatMap((el) => [
        { effect_kind: "chain", effect_label: "mi_" + el.toLowerCase(), chain_steps: "mi_clear, mi_ae_" + el.toLowerCase() },
        { effect_kind: "apply_ae", effect_label: "mi_ae_" + el.toLowerCase(), ae_template_ref: INFUSION_AE(el), ae_duplicate_mode: "replace", target_ref: "self" },
      ]),
    ],
    reactions: [
      ...ELEMENTS.map((el) => ({ reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self",
        condition_formula: "ACTION_IS_SPELL == 1 && ACTION_ROLLS_ACCURACY == 1 && TRIGGER_DAMAGE_IS_" + el.toUpperCase() + " == 1",
        reaction_effect_ref: "mi_" + el.toLowerCase() })),
      { reaction_trigger: "creature_completes_attack", reaction_passive_mode: "force", reaction_source: "self", reaction_passive_target: "self",
        reaction_effect_ref: "mi_clear" },
    ],
    flags: {},
    aes: ELEMENTS.map((el) => ({ name: INFUSION_AE(el), transfer: false, img: SK + "15_RDM/riposte.png", statuses: ["fud-infusion-" + el.toLowerCase()],
      changes: [{ key: "override_attack_damage_type", mode: 5, value: el, priority: 20 }],
      flags: { lifetimeMode: "persistent_counter", tags: ["buff", "spell-fencer"] } })),
  },

  // ── Book and Blade (Passive, SL 1) ───────────────────────────────────────────────────────────────────────────────────
  // You can equip two-handed arcane weapons in one hand. (shared/hand-slots.js reads one_hand_categories off the actor's AEs)
  book_and_blade: {
    doc: { id: "grSkhZspOgRbAgCJ", name: "Book and Blade" },
    props: { skill_type: "Passive", skill_target: "Self" },
    aes: [{ name: "Book and Blade", transfer: true, changes: [{ key: "one_hand_categories", mode: 0, value: "arcane", priority: 20 }] }],
  },

  // ── Heroics ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Master of Duality (bmXjtAU8XKmnVQ0D) has no rows of its own: HAS_SKILL_MASTER_OF_DUALITY opens the spell gates above.

  // Crescendo: during Spellblade Rhapsody, your 【⚔️Attack】 and your 【📕Spell】 each deal 10 extra damage.
  crescendo: {
    doc: { id: "SpFnCrescendo001", name: "Crescendo" },
    props: { skill_type: "Passive", skill_target: "Self" },
    effects: [
      { effect_kind: "adjust_damage", effect_label: "cr_dmg", damage_operation: "add", damage_stage: "outgoing", damage_amount: "10", target_ref: "trigger_subject" },
    ],
    reactions: [
      { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self", reaction_action_target: "enemy",
        condition_formula: "(ACTION_IS_ATTACK == 1 || ACTION_IS_SPELL == 1) && DAMAGE_IS_HP == 1 && AE_COUNT_RHAPSODY_TURN > 0", reaction_effect_ref: "cr_dmg" },
    ],
    flags: {},
  },

  // Encore: once per scene, Spellblade Rhapsody costs no Resonance. (one "Encore" charge per conflict; Rhapsody spends it when
  // Resonance is short)
  encore: {
    doc: { id: "SpFnEncore000001", name: "Encore" },
    props: { skill_type: "Passive", skill_target: "Self" },
    effects: [
      { effect_kind: "apply_ae", effect_label: "en_seed", ae_template_ref: "Encore", ae_duplicate_mode: "replace",
        ae_initial_charges: "1", ae_initial_charges_max: "1", target_ref: "self" },
    ],
    reactions: [
      { reaction_trigger: "conflict_start", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_effect_ref: "en_seed" },
    ],
    flags: {},
    aes: [
      { name: "Encore", transfer: false, changes: [], img: SK + "15_RDM/embolden.png", statuses: ["fud-encore"],
        flags: { chargeKey: "encore", charges: 1, chargesMax: 1, lifetimeMode: "persistent_counter", tags: ["resource"] } },
    ],
  },

  // Duelist's Guard: while you have 2 or more Resonance, gain +2 DEF and +2 MDEF. (adjust_defense raises whichever defense the
  // incoming action checks; the sheet value stays as it is)
  duelists_guard: {
    doc: { id: "SpFnDuelGuard001", name: "Duelist's Guard" },
    props: { skill_type: "Passive", skill_target: "Self" },
    effects: [
      { effect_kind: "adjust_defense", effect_label: "dg_def", defense_operation: "add", defense_amount: "2" },
    ],
    reactions: [
      { reaction_trigger: "creature_targeted_by_action", reaction_passive_mode: "force", reaction_source: "self", reaction_action_intent: "harmful",
        reaction_action_kind: "Attack,Spell,Skill", condition_formula: "AE_CHARGES_RESONANCE >= 2", reaction_effect_ref: "dg_def" },
    ],
    flags: {},
  },
};
if (typeof module !== "undefined" && module.exports) module.exports = MOVE_SKILLS;
