/**
 * Migration: 2026-11-25-legacy-gear-authoring  (Hako's text-only ledger gear)
 * ---------------------------------------------------------------------------
 * The Hako roster migration (2026-11-25-hako-shop-roster) marked 21 ledger items
 * "needs authoring": their effect text had no automation. User 2026-11-25:
 * author them all at once, rewrite their text Genshin-style, and decide:
 *   - Vengueful Yoroi Old → retired from the pool (the automated Vengueful Yoroi
 *     replaces it), text untouched;
 *   - Avalon's aura includes the wearer;
 *   - Defense Matrix tops Shield up to 10 (set, not stack);
 *   - Witch Hat's Cataclysm discount always applies;
 *   - Biker Suit's form switch costs an action.
 * Lid Shield (needs battle delicacies) and Portable Cauldron (no Alchemy reroll /
 * Traveling Cook hook) get the new text but stay "needs authoring".
 *
 * Engine pieces added in the same change: aeSceneSpellWhen / aeClassCount AE gates,
 * check_reroll `allow_fumble`, heal_reversed_all / mp_reversed_all, observer-aware
 * creature_completes_item + free_action `trigger_item`.
 *
 * Every copy is updated: world item, Hako's listings, party + NPC copies (refine
 * prefix "+N " ignored), unlinked token copies. Per-document flag gearAuthoring
 * makes it re-runnable; passives use fixed ids ("GrAu…").
 */

export const key = "2026-11-25-legacy-gear-authoring";
export const description = "Author Hako's 19 text-only ledger items (passives, effects, Genshin-style text), retire Vengueful Yoroi Old, Cataclysm cost discount for Witch Hat.";

const M = "fabula-ultima-companion";
const FLAG = "gearAuthoring";
const HAKO = "srAH3OHOoK0tvFih";
const PASSIVE_SHELL = "r5YlGxjwTfvpt5yM";     // Razor Plume (Passive)
const ACTIVE_SHELL = "6QTyJylY01Anv4IV";      // Lift off (Jetpack's gear skill)
const PASSIVE_FOLDER = "ft3358qUh5ZDldYQ";
const DEBUFF_CARRIER = "XVOWOq9oUmEECGrU";    // Debuff (status templates)
const CATACLYSM_LIB = "7oG8YvRYQBQAU025";

const id = (code) => ("GrAu" + code).padEnd(16, "0").slice(0, 16);
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const je = (jid, label) => `<a class="content-link" data-uuid="JournalEntry.${jid}" data-id="${jid}" data-type="JournalEntry">${label}</a>`;
const L = {
  charm: je("x6ByoJnflDAuVn9r", "Charm"),
  silenced: je("Q8FTFPsXVpNj2zxT", "Silenced"),
  poisoned: je("JltwIqzHbBKhkD45", "Poisoned"),
  shield: je("wrw2ENSwzCBjztvt", "Shield"),
  zp: je("J1BPPuvKwIi5WqRa", "Zero Power"),
};
const B = (s) => `<strong>${s}</strong>`;

// ── New text (Genshin style, user 2026-11-25) ───────────────────────────────
const TEXT = {
  manaRobe: [`Damage reduces your MP before your HP.`],
  gamblersDice: [`Any doubles except double 1s count as a ${B("Critical Success")}.`, `When you Fumble, you may reroll once. Once per round.`],
  falseIdol: [`During battle, whenever any creature would recover HP or MP, it loses that much instead.`],
  copycat: [`When another creature uses a consumable, you may use a copy of it for free. Once per round.`],
  dominatrix: [`Flail attacks deal ${B("5")} extra damage and inflict ${L.charm}.`],
  ballGag: [`You are permanently ${L.silenced}.`, `When an attack damages you, recover ${B("5")} HP.`],
  bikerSuit: [
    `As an action, change into ${B("Steel Form")}, ${B("Mana Form")} or ${B("Formless")}.`,
    `While Formless, at the start of your turn you may change into Steel Form or Mana Form for free.`,
    `${B("Formless:")} DEF equals your DEX die, MDEF your INS die.`,
    `${B("Steel Form:")} DEF ${B("16")}. Spells deal ${B("10")} extra damage to you.`,
    `${B("Mana Form:")} MDEF ${B("16")}. Attacks deal ${B("10")} extra damage to you.`,
  ],
  lidShield: [`Delicacies deal ${B("5")} extra damage.`],
  fairyTunic: [`${B("+2 MDEF")} while a spell with a Scene duration affects you.`],
  defenseMatrix: [`At the start of your turn, gain ${B("10")} ${L.shield}.`],
  alphaRegalia: [`Critical hits by you and your allies deal double damage.`],
  witchHat: [`When you overcharge a spell with ${B("【📜Cataclysm】")}, the extra MP cost is halved.`],
  briefRespite: [`When you spend MP on a spell or skill, gain ${L.shield} equal to the MP spent. Once per turn.`, `This Shield fades at the start of your next turn.`],
  littleDevil: [`When you damage an ally, gain ${L.zp} equal to ${B("【damage ÷ 10】")}, rounded up.`],
  ringOfOnions: [`Max HP and max MP ${B("+2")} per class you have.`],
  avalon: [`You and your allies gain ${B("+1 DEF")} and ${B("+1 MDEF")}.`],
  slimyJacket: [`Immune to ${L.poisoned}.`],
  hekat: [`Resistance to spell damage.`, `When a spell damages you, recover ${B("5")} MP.`],
  enforcer: [`Sword and firearm attacks deal ${B("5")} extra damage.`],
  cauldron: [
    `When you use ${B("Gadget: Alchemy")}, you may spend ${B("20")} MP to reroll one die.`,
    `When you use ${B("Traveling Cook")}, you may spend ${B("20")} MP to change one ingredient into any other type.`,
  ],
};

// ── Reaction / effect row builders ──────────────────────────────────────────
const rc = (trigger, ref, extra = {}) => ({ reaction_trigger: trigger, reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: ref, ...extra });
const onEquipAndStart = (ref) => [
  { reaction_trigger: "conflict_start", reaction_source: "", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_effect_ref: ref },
  { reaction_trigger: "creature_equips_item", reaction_source: "", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_effect_ref: ref },
];
const onUnequip = (ref) => ({ reaction_trigger: "creature_unequips_item", reaction_source: "", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_effect_ref: ref });
const everyone = (label, category = "") => ({
  effect_label: label, effect_kind: "targeting", candidate_source: "combat", ...(category ? { category } : {}),
  mode: "all", count: 1, exclude_self: false, auto_confirm_when_obvious: true, skip_when_passive: true, iteration_mode: "together",
});
const aeRef = (passiveId, aeId) => `Item.${passiveId}.ActiveEffect.${aeId}`;
const permanentFlags = (extra = {}) => ({ [M]: { directorPermanent: true, crossScene: false, [FLAG]: "ae", ...extra } });

// A passive-carried aura: applied at conflict start / on equip to `category`
// (all combatants when blank), removed when the carrier is unequipped.
function aura({ code, aeName, changes = [], reactionConfig = null, category = "", img }) {
  const pid = id(code + "Psv"), aid = id(code + "Ae");
  return {
    passive: {
      id: pid,
      effects: [{ _id: aid, name: aeName, img, transfer: false, disabled: false, changes,
        system: { tags: [] }, flags: permanentFlags(reactionConfig ? { reactionConfig } : {}) }],
      reactions: [...onEquipAndStart("au_apply"), onUnequip("au_clear")],
      effectRows: [
        { effect_label: "au_apply", effect_kind: "apply_ae", ae_template_ref: aeRef(pid, aid), ae_duplicate_mode: "replace",
          ae_duration_rounds: "scene", target_ref: "au_who", on_empty: "skip" },
        { effect_label: "au_clear", effect_kind: "remove_ae", ae_template_ref: aeName, count: "all", target_ref: "au_who", on_empty: "skip" },
        everyone("au_who", category),
      ],
    },
  };
}

// ── Item specs ──────────────────────────────────────────────────────────────
function specs() {
  const S = {};
  S["jnhWaWPLwZcPQ883"] = { name: "Mana Robe", text: TEXT.manaRobe, aes: [{
    _id: id("ManaRobeAe"), name: "Mana Robe", transfer: true, changes: [],
    flags: { [M]: { [FLAG]: "ae", reactionConfig: { name: "Mana Robe",
      reaction_config_table: table([{ reaction_trigger: "creature_takes_damage", reaction_source: "self", reaction_passive_mode: "force",
        condition_formula: "CUR_MP > 0 && INCOMING_DAMAGE > 0", reaction_effect_ref: "mr_root" }]),
      effect_table: table([
        { effect_label: "mr_root", effect_kind: "chain", chain_steps: "mr_soak, mr_drain" },
        { effect_label: "mr_soak", effect_kind: "adjust_damage", damage_stage: "incoming", damage_operation: "subtract", damage_amount: "min(INCOMING_DAMAGE, CUR_MP)" },
        { effect_label: "mr_drain", effect_kind: "consume_resource", consume_resource: "mp", consume_amount: "min(INCOMING_DAMAGE, CUR_MP)", on_empty: "drain", target_ref: "self" },
      ]) } } },
  }] };
  S["fXTiW1mHRFBGSGR8"] = { name: "Gambler's Dice", text: TEXT.gamblersDice,
    aes: [{ _id: id("GamblerAe"), name: "Gambler's Dice", transfer: true, changes: [{ key: "minimum_critical_dice", mode: 3, value: "2", priority: 1 }] }],
    passive: { id: id("GamblerPsv"), reactions: [rc("creature_performs_action", "gd_reroll", {
      reaction_passive_mode: "ask", condition_formula: "ACTION_ROLLS_ACCURACY == 1 && ATTACK_IS_FUMBLE == 1",
      reaction_max_per_round: "1", reaction_max_scope: "round" })],
      effectRows: [{ effect_label: "gd_reroll", effect_kind: "check_reroll", allow_fumble: true }] } };
  S["L15zxS1OesPs4l2h"] = { name: "False Idol", text: TEXT.falseIdol,
    ...aura({ code: "FalseIdol", aeName: "False Idol", img: "icons/svg/skull.svg",
      changes: [{ key: "heal_reversed_all", mode: 2, value: "1", priority: 20 }, { key: "mp_reversed_all", mode: 2, value: "1", priority: 20 }] }) };
  S["Hurc7SbzCtjIAaC3"] = { name: "Copycat", text: TEXT.copycat,
    passive: { id: id("CopycatPsv"), reactions: [{ reaction_trigger: "creature_completes_item", reaction_source: "all", reaction_passive_mode: "ask",
      condition_formula: "SUBJECT_IS_SELF == 0", reaction_max_per_round: "1", reaction_max_scope: "round", reaction_effect_ref: "cc_copy" }],
      effectRows: [{ effect_label: "cc_copy", effect_kind: "free_action", action_ref: "trigger_item", free_of_cost: true,
        menu_label: "Copycat — use a copy", menu_description: "Use a copy of the item just used, for free." }] } };
  S["V3R1cSiLgIfXVgRj"] = { name: "Dominatrix Leotard", text: TEXT.dominatrix,
    passive: { id: id("DominaPsv"), reactions: [
      rc("creature_will_deal_damage", "dl_dmg", { reaction_passive_mode: "on", condition_formula: "USED_WEAPON_CATEGORY_IS_FLAIL == 1 && DAMAGE_IS_HP == 1" }),
      rc("creature_deals_damage", "dl_charm", { reaction_passive_mode: "on", condition_formula: "USED_WEAPON_CATEGORY_IS_FLAIL == 1 && DAMAGE_IS_HP == 1" }),
    ], effectRows: [
      { effect_label: "dl_dmg", effect_kind: "adjust_damage", damage_amount: "5", damage_operation: "add", damage_stage: "outgoing" },
      { effect_label: "dl_charm", effect_kind: "apply_ae", ae_template_ref: "Charmed", ae_duplicate_mode: "replace", target_ref: "trigger_subject" },
    ] } };
  S["Ef9i1q5WWmWw0ZcI"] = { name: "Ball Gag", text: TEXT.ballGag, passive: { id: id("BallGagPsv"), silenceAe: id("BallGagAe"),
    reactions: [...onEquipAndStart("bg_silence"), rc("creature_lose_resource", "bg_heal", {
      reaction_resource_filter: "hp", reaction_cause_filter: "damage", condition_formula: "ACTION_IS_ATTACK == 1" })],
    effectRows: [
      { effect_label: "bg_silence", effect_kind: "apply_ae", ae_template_ref: aeRef(id("BallGagPsv"), id("BallGagAe")),
        ae_duplicate_mode: "replace_same_status", ignore_condition_immunity: true, ae_duration_rounds: "scene", target_ref: "self" },
      { effect_label: "bg_heal", effect_kind: "grant", grant_resource: "hp", grant_amount: "5", target_ref: "self" },
    ] } };
  // Biker Suit: armor stats switch through aeWhen on the armor's own (equip-gated)
  // effect; the markers live on the passive; the action is a gear skill.
  const bkP = id("BikerPsv"), bkSteel = id("BikerSteelAe"), bkMana = id("BikerManaAe");
  const formRows = [
    { effect_label: "bk_steel", effect_kind: "chain", chain_steps: "bk_put_steel, bk_drop_mana" },
    { effect_label: "bk_mana", effect_kind: "chain", chain_steps: "bk_put_mana, bk_drop_steel" },
    { effect_label: "bk_formless", effect_kind: "chain", chain_steps: "bk_drop_steel, bk_drop_mana" },
    { effect_label: "bk_put_steel", effect_kind: "apply_ae", ae_template_ref: aeRef(bkP, bkSteel), ae_duplicate_mode: "replace", ae_duration_rounds: "scene", target_ref: "self" },
    { effect_label: "bk_put_mana", effect_kind: "apply_ae", ae_template_ref: aeRef(bkP, bkMana), ae_duplicate_mode: "replace", ae_duration_rounds: "scene", target_ref: "self" },
    { effect_label: "bk_drop_steel", effect_kind: "remove_ae", ae_template_ref: "Steel Form", count: "all", target_ref: "self", condition_formula: "AE_COUNT_STEEL_FORM > 0" },
    { effect_label: "bk_drop_mana", effect_kind: "remove_ae", ae_template_ref: "Mana Form", count: "all", target_ref: "self", condition_formula: "AE_COUNT_MANA_FORM > 0" },
  ];
  const marker = (_id, name) => ({ _id, name, transfer: false, disabled: false, changes: [], system: { tags: [] }, flags: permanentFlags() });
  S["HlSNO4jVVSMkSCT7"] = { name: "Biker Suit", text: TEXT.bikerSuit, props: { item_rarity: "Rare", item_def_bonus: "0", item_mdef_bonus: "0" },
    aes: [{ _id: id("BikerFormAe"), name: "Biker Suit Forms", transfer: true, changes: [
      { key: "base_defense", mode: 4, value: `aeWhen("Steel Form", "16")`, priority: 30 },
      { key: "base_magic_defense", mode: 4, value: `aeWhen("Mana Form", "16")`, priority: 30 },
    ] }],
    passive: { id: bkP, effects: [marker(bkSteel, "Steel Form"), marker(bkMana, "Mana Form")],
      reactions: [
        rc("turn_start", "bk_free", { reaction_passive_mode: "ask", condition_formula: "AE_COUNT_STEEL_FORM == 0 && AE_COUNT_MANA_FORM == 0" }),
        rc("creature_targeted_by_action", "bk_spellhit", { reaction_passive_mode: "on", condition_formula: "AE_COUNT_STEEL_FORM > 0 && ACTION_IS_SPELL == 1" }),
        rc("creature_targeted_by_action", "bk_atkhit", { reaction_passive_mode: "on", condition_formula: "AE_COUNT_MANA_FORM > 0 && ACTION_IS_ATTACK == 1" }),
        { reaction_trigger: "conflict_end", reaction_source: "", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_effect_ref: "bk_formless" },
        onUnequip("bk_formless"),
      ],
      effectRows: [
        { effect_label: "bk_free", effect_kind: "open_action_menu", menu_title: "Biker Suit", menu_subtitle: "Change form for free.",
          menu_option_labels: "Steel Form|Mana Form", menu_option_descriptions: "DEF 16. Spells deal 10 extra damage to you.|MDEF 16. Attacks deal 10 extra damage to you.",
          menu_option_refs: "bk_steel, bk_mana" },
        { effect_label: "bk_spellhit", effect_kind: "adjust_damage", damage_operation: "add", damage_amount: "10", damage_stage: "incoming" },
        { effect_label: "bk_atkhit", effect_kind: "adjust_damage", damage_operation: "add", damage_amount: "10", damage_stage: "incoming" },
        ...formRows,
      ] },
    skill: { id: id("BikerTransform"), name: "Transform", onActivate: "bk_menu", effectRows: [
      { effect_label: "bk_menu", effect_kind: "open_action_menu", menu_title: "Transform", menu_subtitle: "Choose your form.",
        menu_option_labels: "Steel Form|Mana Form|Formless",
        menu_option_descriptions: "DEF 16. Spells deal 10 extra damage to you.|MDEF 16. Attacks deal 10 extra damage to you.|DEF = DEX die, MDEF = INS die.",
        menu_option_refs: "bk_steel, bk_mana, bk_formless" },
      ...formRows,
    ] } };
  S["UbFTDlw59jKvWab2"] = { name: "Lid Shield", text: TEXT.lidShield, textOnly: true };
  S["G8fBxPWSabEzD5V6"] = { name: "Fairy Tunic", text: TEXT.fairyTunic,
    aes: [{ _id: id("FairyAe"), name: "Fairy Tunic", transfer: true, changes: [{ key: "bonus_magic_defense", mode: 2, value: "aeSceneSpellWhen(2)", priority: 20 }] }] };
  S["4OH9H2YYxr9KhhBx"] = { name: "Defense Matrix", text: TEXT.defenseMatrix,
    passive: { id: id("DefMatrixPsv"), reactions: [rc("turn_start", "dm_shield")],
      effectRows: [{ effect_label: "dm_shield", effect_kind: "set_resource", grant_resource: "shield", grant_amount: "10", target_ref: "self" }] } };
  S["0b9L1O59jxijKJ1I"] = { name: "Alpha Regalia", text: TEXT.alphaRegalia,
    ...aura({ code: "AlphaReg", aeName: "Alpha Regalia", category: "ally", img: "icons/svg/sword.svg",
      reactionConfig: { name: "Alpha Regalia",
        reaction_config_table: table([rc("creature_will_deal_damage", "ar_double", { condition_formula: "ACTION_IS_ATTACK == 1 && ATTACK_IS_CRIT == 1 && DAMAGE_IS_HP == 1" })]),
        effect_table: table([{ effect_label: "ar_double", effect_kind: "adjust_damage", damage_operation: "multiply", damage_amount: "2", damage_stage: "outgoing" }]) } }) };
  S["oGop1MLCHPzdpdR5"] = { name: "Witch Hat", text: TEXT.witchHat,
    aes: [{ _id: id("WitchHatAe"), name: "Witch Hat", transfer: true, changes: [
      { key: `flags.${M}.cataclysm_cost_discount`, mode: 2, value: "${isEquipped ? 50 : 0}$", priority: null }] }] };
  const brP = id("BriefPsv"), brAe = id("BriefAe");
  S["6f3U2Cz826kB5ZIp"] = { name: "Brief Respite", text: TEXT.briefRespite, passive: { id: brP,
    effects: [{ _id: brAe, name: "Brief Respite", transfer: false, disabled: false, changes: [], system: { tags: [] },
      flags: { [M]: { [FLAG]: "ae", lifetimeMode: "persistent_counter", chargeKey: "brief-respite", charges: 0, chargesMax: 999 } } }],
    reactions: [
      rc("creature_performs_action", "br_root", { condition_formula: "ACTION_EFFECTIVE_COST_MP > 0 && ACTION_IS_FREE_CAST == 0 && ACTION_IS_ATTACK == 0",
        reaction_max_per_round: "1", reaction_max_scope: "round" }),
      rc("turn_start", "br_drop", { condition_formula: "AE_CHARGES_BRIEF_RESPITE > 0 && CUR_SHIELD > 0" }),
      rc("turn_start", "br_unmark", { condition_formula: "AE_COUNT_BRIEF_RESPITE > 0" }),
    ],
    effectRows: [
      { effect_label: "br_root", effect_kind: "chain", chain_steps: "br_mark, br_shield" },
      { effect_label: "br_mark", effect_kind: "apply_ae", ae_template_ref: aeRef(brP, brAe), ae_duplicate_mode: "replace",
        ae_initial_charges: "max(0, ACTION_EFFECTIVE_COST_MP - CUR_SHIELD)", target_ref: "self" },
      { effect_label: "br_shield", effect_kind: "set_resource", grant_resource: "shield", grant_amount: "ACTION_EFFECTIVE_COST_MP", target_ref: "self" },
      { effect_label: "br_drop", effect_kind: "consume_resource", consume_resource: "shield", consume_amount: "min(CUR_SHIELD, AE_CHARGES_BRIEF_RESPITE)", on_empty: "drain", target_ref: "self" },
      { effect_label: "br_unmark", effect_kind: "remove_ae", ae_template_ref: "Brief Respite", count: "all", target_ref: "self" },
    ] } };
  S["08Aj60g6ffE0XmAW"] = { name: "Little Devil", text: TEXT.littleDevil,
    passive: { id: id("LilDevilPsv"), reactions: [{ reaction_trigger: "creature_lose_resource", reaction_source: "all", reaction_passive_mode: "force",
      reaction_resource_filter: "hp", reaction_cause_filter: "damage", condition_formula: "CAUSE_IS_SELF == 1 && SUBJECT_IS_ALLY == 1", reaction_effect_ref: "ld_zp" }],
      effectRows: [{ effect_label: "ld_zp", effect_kind: "grant", grant_resource: "zero_power", grant_amount: "ceil(TRIGGER_AMOUNT / 10)", target_ref: "self" }] } };
  S["rp6c8fADXzWLAt68"] = { name: "Ring of Onions", text: TEXT.ringOfOnions,
    aes: [{ _id: id("OnionAe"), name: "Ring of Onions", transfer: true, changes: [
      { key: "max_hp", mode: 2, value: "aeClassCount(2)", priority: 20 }, { key: "max_mp", mode: 2, value: "aeClassCount(2)", priority: 20 }] }] };
  S["vH6Q88n3beOHjxKq"] = { name: "Avalon", text: TEXT.avalon,
    ...aura({ code: "Avalon", aeName: "Avalon", category: "ally", img: "icons/svg/shield.svg",
      changes: [{ key: "bonus_defense", mode: 2, value: "1", priority: 20 }, { key: "bonus_magic_defense", mode: 2, value: "1", priority: 20 }] }) };
  S["g0S7SNOw5EJcJd1T"] = { name: "Slimy Jacket", text: TEXT.slimyJacket,
    aes: [{ _id: id("SlimyAe"), name: "Slimy Jacket", transfer: true, changes: [{ key: "condition_poisoned", mode: 5, value: `aeAffinityFloor("IM")`, priority: 20 }] }] };
  S["96gMkuCexILXHXyI"] = { name: "Hekat Shield", text: TEXT.hekat,
    passive: { id: id("HekatPsv"), reactions: [
      rc("creature_targeted_by_action", "hk_resist", { reaction_passive_mode: "on", condition_formula: "ACTION_IS_SPELL == 1" }),
      rc("creature_lose_resource", "hk_mp", { reaction_resource_filter: "hp", reaction_cause_filter: "damage", condition_formula: "ACTION_IS_SPELL == 1" }),
    ], effectRows: [
      { effect_label: "hk_resist", effect_kind: "adjust_damage", damage_operation: "multiply", damage_amount: "0.5", damage_stage: "incoming", damage_round: "down" },
      { effect_label: "hk_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: "5", target_ref: "self" },
    ] } };
  S["2MAkZpclKVJH9Hvx"] = { name: "Enforcer Uniform", text: TEXT.enforcer,
    passive: { id: id("EnforcerPsv"), reactions: [rc("creature_will_deal_damage", "eu_dmg", { reaction_passive_mode: "on",
      condition_formula: "(USED_WEAPON_CATEGORY_IS_SWORD == 1 || USED_WEAPON_CATEGORY_IS_FIREARM == 1) && DAMAGE_IS_HP == 1" })],
      effectRows: [{ effect_label: "eu_dmg", effect_kind: "adjust_damage", damage_amount: "5", damage_operation: "add", damage_stage: "outgoing" }] } };
  S["xkeIviw9s7Ri1Vm4"] = { name: "Portable Cauldron", text: TEXT.cauldron, textOnly: true };
  return S;
}

const AUTHORED_IDS = () => Object.entries(specs()).filter(([, s]) => !s.textOnly).map(([k]) => k);
const RETIRE = { "Mt04b0K0gNEE9kYs": "Superseded by Vengueful Yoroi" };

// ── Builders ────────────────────────────────────────────────────────────────
function cloneData(srcId, { _id, name, container, img, props = {}, effects }) {
  const src = game.items.get(srcId);
  if (!src) throw new Error(`donor ${srcId} missing`);
  const d = src.toObject();
  d._id = _id; d.name = name;
  if (img) d.img = img;
  d.folder = PASSIVE_FOLDER;
  d.system.container = container;
  d.system.uniqueId = _id;
  d.system.props = { ...d.system.props, ...props, name, id: _id, uuid: `Item.${_id}` };
  if (img) d.system.props.img = img;
  d.effects = effects ?? [];
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: "created" } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}

function silenceAe(_id) {
  const src = game.items.get(DEBUFF_CARRIER)?.effects?.find((e) => /^silence/i.test(e.name));
  if (!src) throw new Error("Silence template missing on Debuff");
  const d = src.toObject();
  d._id = _id; d.transfer = false; d.disabled = false;
  const f = (d.flags[M] ??= {});
  delete f.charges; delete f.chargesMax; delete f.lifetimeMode;
  Object.assign(f, { directorPermanent: true, uncleansable: true, equipLock: "Ball Gag", crossScene: false, [FLAG]: "ae" });
  if (d.flags.statuscounter) d.flags.statuscounter.visible = false;
  return d;
}

function passiveDoc(spec, parent) {
  const p = spec.passive;
  const effects = (p.effects ?? []).map((e) => ({ ...e }));
  if (p.silenceAe) effects.push(silenceAe(p.silenceAe));
  return cloneData(PASSIVE_SHELL, {
    _id: p.id, name: `${spec.name} (Passive)`, container: parent.id, img: parent.img, effects,
    props: { description: ul(...spec.text), skill_description: ul(...spec.text), isReaction: true, skill_type: "Passive",
      skill_target: "Self", max_level: 1, reaction_config_table: table(p.reactions), effect_table: table(p.effectRows) },
  });
}

function skillDoc(spec, parent) {
  const k = spec.skill;
  return cloneData(ACTIVE_SHELL, {
    _id: k.id, name: k.name, container: parent.id, img: parent.img,
    props: { description: ul(spec.text[0]), skill_description: ul(spec.text[0]), skill_type: "Active", skill_target: "Self",
      on_activate_effect_ref: k.onActivate, effect_table: table(k.effectRows), max_level: 1 },
  });
}

const aeDoc = (a) => ({ disabled: false, img: null, system: { tags: [] }, ...a,
  flags: { ...(a.flags ?? {}), [M]: { ...(a.flags?.[M] ?? {}), [FLAG]: "ae" } } });

// ── Apply to one carrier (world item or an actor's copy) ────────────────────
const baseName = (n) => String(n ?? "").replace(/&#39;|&apos;/g, "'").replace(/^\+\d+\s+/, "").trim();

async function authorCarrier(item, spec, out) {
  const where = item.parent ? `${item.parent.name}: ${item.name}` : item.name;
  if (item.getFlag(M, FLAG)) { out.push(`= ${where}`); return; }
  const patch = { "system.props.description": ul(...spec.text), [`flags.${M}.${FLAG}`]: true };
  for (const [k, v] of Object.entries(spec.props ?? {})) if (!String(item.system?.props?.[k] ?? "").trim()) patch[`system.props.${k}`] = v;
  await item.update(patch);
  for (const a of spec.aes ?? []) {
    if (item.effects.get(a._id) || item.effects.some((e) => e.name === a.name && e.getFlag(M, FLAG))) continue;
    await item.createEmbeddedDocuments("ActiveEffect", [aeDoc(a)], { keepId: true });
  }
  const children = [];
  if (spec.passive) children.push(passiveDoc(spec, item));
  if (spec.skill) children.push(skillDoc(spec, item));
  for (const c of children) {
    if (item.parent) {
      const actor = item.parent;
      if (actor.items.some((i) => i.system?.container === item.id && i.name === c.name)) continue;
      const cd = foundry.utils.deepClone(c); delete cd._id; delete cd.folder;
      cd.system.container = item.id;
      await actor.createEmbeddedDocuments("Item", [cd]);
    } else if (!game.items.get(c._id)) {
      await Item.createDocuments([c], { keepId: true });
    }
  }
  out.push(`~ ${where}${children.length ? ` (+${children.map((c) => c.name).join(", ")})` : ""}`);
}

// ── Cataclysm: Witch Hat discount (FLAG_CATACLYSM_COST_DISCOUNT, percent) ───
const RATE = "(100 - FLAG_CATACLYSM_COST_DISCOUNT) / 100";
function discountRows(table) {
  const out = foundry.utils.deepClone(table ?? {});
  for (const r of Object.values(out)) {
    if (!r || typeof r !== "object") continue;
    if (r.effect_kind === "adjust_cost" && r.cost_resource === "mp" && !String(r.cost_amount).includes("DISCOUNT"))
      r.cost_amount = `ceil((${r.cost_amount}) * ${RATE})`;
    for (const k of ["condition_formula", "prompt_max"]) {
      const v = String(r[k] ?? "");
      if (!v || v.includes("DISCOUNT")) continue;
      let w = v.replace(/ACTION_COST_MP \+ (\d+)/g, (_, n) => `ACTION_COST_MP + ceil(${n} * ${RATE})`);
      if (k === "prompt_max") w = w.replace(") / 10) * 10", `) / (${RATE}) / 10) * 10`);
      r[k] = w;
    }
  }
  return out;
}

async function patchCataclysm(doc, lib, out) {
  if (doc.getFlag(M, FLAG)) return;
  const p = doc.system?.props ?? {};
  const hasRows = Object.keys(p.reaction_config_table ?? {}).length > 0;
  // An empty granted copy (Witch Hat's) gets the library rows first.
  const src = hasRows ? p : (lib?.system?.props ?? p);
  const patch = {
    "system.props.effect_table": null, "system.props.reaction_config_table": null, [`flags.${M}.${FLAG}`]: true,
  };
  await doc.update(patch);
  await doc.update({
    "system.props.effect_table": discountRows(src.effect_table),
    "system.props.reaction_config_table": discountRows(src.reaction_config_table),
    "system.props.isReaction": true,
  });
  out.push(`~ Cataclysm ${doc.parent ? doc.parent.name + ": " : ""}${doc.id}${hasRows ? "" : " (rows from library)"}`);
}

async function cataclysmAll(out) {
  const lib = game.items.get(CATACLYSM_LIB);
  const docs = [...game.items.filter((i) => i.name === "Cataclysm")];
  for (const a of game.actors) docs.push(...a.items.filter((i) => i.name === "Cataclysm"));
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) docs.push(...t.actor.items.filter((i) => i.name === "Cataclysm" && i.parent === t.actor && t.delta?.items?.get(i.id)));
  // Library first so empty copies inherit the ORIGINAL rows (discountRows runs once per doc).
  docs.sort((a, b) => (a.id === CATACLYSM_LIB ? -1 : b.id === CATACLYSM_LIB ? 1 : 0));
  const libRows = lib ? { system: { props: { effect_table: foundry.utils.deepClone(lib.system.props.effect_table), reaction_config_table: foundry.utils.deepClone(lib.system.props.reaction_config_table) } } } : null;
  for (const d of docs) await patchCataclysm(d, libRows, out);
}

// ── Hako's roster pool ──────────────────────────────────────────────────────
async function updatePool(out) {
  const hako = game.actors.get(HAKO);
  const st = hako?.getFlag(M, "shopRoster");
  if (!st?.pool) { out.push("= no Hako roster pool"); return; }
  const authored = new Set(AUTHORED_IDS());
  let cleared = 0, retired = 0;
  const pool = st.pool.map((e) => {
    const n = { ...e };
    if (authored.has(e.id) && n.authoring) { delete n.authoring; cleared++; }
    if (RETIRE[e.id] && !n.retired) { n.retired = RETIRE[e.id]; retired++; }
    return n;
  });
  await hako.update({ [`flags.${M}.shopRoster.pool`]: pool });
  out.push(`~ Hako pool: ${cleared} authored, ${retired} retired`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  const S = specs();
  for (const [wid, spec] of Object.entries(S)) {
    const world = game.items.get(wid);
    if (!world) { out.push(`! ${spec.name} missing`); continue; }
    await authorCarrier(world, spec, out);
    const actors = [...game.actors];
    for (const sc of game.scenes) for (const t of sc.tokens) if (!t.actorLink && t.actor) actors.push(t.actor);
    for (const a of actors) {
      for (const copy of a.items.filter((i) => !i.system?.container && baseName(i.name) === spec.name)) {
        if (a.isToken && !a.token?.delta?.items?.get(copy.id)) continue;   // inherited from the base actor
        await authorCarrier(copy, spec, out);
      }
    }
  }
  await cataclysmAll(out);
  await updatePool(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
