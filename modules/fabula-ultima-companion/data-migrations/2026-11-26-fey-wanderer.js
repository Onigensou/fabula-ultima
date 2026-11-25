/**
 * Migration: 2026-11-26-fey-wanderer  (Fey Wanderer gacha set — healer, FFXIV Scholar-inspired)
 * ---------------------------------------------------------------------------
 * Review page https://claude.ai/artifact/JERJHoc46xgsx6EjF1MbCV (approved round 5; Fairy = companion
 * rules, stats option A). All pieces Rare.
 *   Glimmerwing Staff    WLP+WLP, HR+6 Physical; grants the spell Sprout Ward (10 MP, one ally, scene):
 *                        the next time the target falls into Crisis it recovers 【HR + 30】 HP.
 *   Glimmerwing Robe     DEF+1 / M.DEF+1; begins each conflict with the companion Fairy
 *                        (Hunter's Mantle pattern: conflict_start summon, companion slot, 0 own turns).
 *   Glimmerwing Earring  allies healed by your spells gain Fey Regen (10 HP at turn start, 2 rounds).
 *   Fairy (actor)        HP 【5 + level】, DEF 10, M.DEF 13, Flying, MP 0. Fey Light acts on the
 *                        summoner's turn end: heal the most hurt ally 【10 + ½ level】; on even rounds
 *                        cleanse 1 debuff from an ally instead, if any ally has one.
 *   2pc Moondew          2 at conflict start; spend 1 on a healing spell → it costs no MP.
 *   3pc Fairy's Sacrifice  aura on every ally: a would-be KO is capped at 1 HP, every ally recovers
 *                        【20 + your level】, the Fairy is dismissed; the aura clears (once per scene).
 * Data: healing spells (Heal, Regen) gain skill_tags "heal" — world + every actor copy — so
 * "healing spell" reads SKILL_HAS_TAG_HEAL. Fairy art: placeholder Beastiary/Wisp.png (owed).
 *
 * SEED-ONLY: fixed ids, flag feyWanderer.
 */

export const key = "2026-11-26-fey-wanderer";
export const description = "Fey Wanderer set: Glimmerwing Staff/Robe/Earring, Sprout Ward, Fairy companion actor (Fey Light), Fey Regen, Moondew 2pc, Fairy's Sacrifice 3pc, heal tags on healing spells.";

const M = "fabula-ultima-companion";
const FLAG = "feyWanderer";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SET_NAME = "Fey Wanderer";

const ID = {
  folder: "FeyWndFolder0001", setParent: "5KFkUixjqI5c6PpK",
  staff: "FeyWndStaff00001", spell: "FeyWndSproutWrd1", aeSprout: "FeyWndSproutAE01",
  robe: "FeyWndRobe000001", robePsv: "FeyWndRobePsv001",
  earring: "FeyWndEarring001", earPsv: "FeyWndEarPsv0001", aeRegen: "FeyWndRegenAE001",
  fairy: "FeyWndFairyAct01", feyLight: "FeyWndFeyLight01", aePresence: "FeyWndPresence01",
  set: "FeyWndSetDef0001", t2: "FeyWndMoondew001", aeMoondew: "FeyWndMoondewAE1", t3: "FeyWndSacrifice1", aeGrace: "FeyWndGraceAE001",
};
const DONOR = {
  staff: "UgcS71lsTsfnUG1b", spell: "vwdKavkWNuq0Alp1", armor: "09KjioTnamwnRFv4", acc: "NHQNneNjKb1Je06v",
  setDoc: "CQ6Pq61KaMixQAjw", passive: "r5YlGxjwTfvpt5yM", hawk: "GnEmdc02BDDTmeaU",
  regenItem: "OmWE7jRa80TMTc1x", regenAe: "OlzqcPwkPWtVJyHY",
};
const IMG = {
  staff: `${FORGE}Item%20Icon/Sword%20of%20Convollaria/Gleam_Short_Staff-icon.webp`,
  robe: `${FORGE}Item%20Icon/Armor/FF%20Brave%20Exvius/Icon-Siren%2527s_Robe.webp`,
  earring: `${FORGE}Item%20Icon/Fantasy%20Life%20I/Armor/Flutter_Charm.webp`,
  fairy: `${FORGE}Beastiary/Wisp.png`,
};
const T = { fairyHeal: "10 + floor(SUMMONER_LEVEL / 2)", sproutHr: "30", regenHp: "10", regenTurns: 2, moondew: 2, graceHeal: "20 + CHAR_LEVEL" };

// ── Text ────────────────────────────────────────────────────────────────────
const B = (s) => `<strong>${s}</strong>`;
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const em = (t) => `<p><em>${t}</em></p>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const CRISIS = `<a class="content-link" data-uuid="JournalEntry.GJevbCPM8cffm1QM" data-id="GJevbCPM8cffm1QM" data-type="JournalEntry">Crisis</a>`;
const FAIRY = B("Fairy"), MOONDEW = B("Moondew"), REGEN = B("Fey Regen");
const TEXT = {
  staff: [`You may cast the spell 【✨<strong>@UUID[Item.${ID.spell}]{Sprout Ward}</strong>】`],
  spell: [`The next time the target falls into ${CRISIS}, it recovers ${B(`【HR + ${T.sproutHr}】`)} HP.`],
  robe: [
    `You begin each conflict with the companion ${FAIRY}.`,
    `${FAIRY}: at the end of your turn, restores ${B("【10 + ½ your level】")} HP to the ally with the lowest HP.`,
    `${FAIRY}: every ${B("2")} rounds, removes 1 debuff from an ally instead, if any ally has one.`,
  ],
  earring: [`Allies healed by your spells gain ${REGEN}: recover ${B(T.regenHp)} HP at the start of their turn for ${B(T.regenTurns)} rounds.`],
  t2: [`At the start of each conflict, gain ${B(T.moondew)} ${MOONDEW}. When you cast a healing spell, you may spend 1 ${MOONDEW}: it costs no MP.`],
  t3: [`Once per scene, when an ally would fall to 0 HP, ${FAIRY} takes the blow instead. The ally is left at 1 HP, and every ally recovers ${B("【20 + your level】")} HP. ${FAIRY} leaves until the next scene.`],
};
const SET_DESC = `<p><strong>【Set Bonus】</strong></p><p><strong>2 Piece</strong></p>${ul(...TEXT.t2)}<p><strong>3 Piece</strong></p>${ul(...TEXT.t3)}`;
const FLAVOR = {
  staff: em("A slender wand of moonlit silver. Fey lights gather at its tip, waiting to be asked."),
  robe: em("Layers of leaf-green silk that rustle like a forest at dusk. Something small and bright lives in its folds."),
  earring: em("A charm shaped like a wing. Wear it, and every kindness you cast lingers a little longer."),
};

// ── Rows ────────────────────────────────────────────────────────────────────
const rc = (trigger, ref, extra = {}) => ({
  reaction_trigger: trigger, reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: ref,
  condition_formula: "", reaction_resource_filter: "", reaction_cause_filter: "", reaction_max_per_round: "", reaction_requires_weapon_used: false, ...extra,
});
const applyAe = (label, name, extra = {}) => ({ effect_label: label, effect_kind: "apply_ae", ae_template_ref: name, ae_duplicate_mode: "replace", target_ref: "self", ...extra });
const removeAe = (label, name, target = "self") => ({ effect_label: label, effect_kind: "remove_ae", ae_template_ref: name, include_persistent: true, target_ref: target });
const templAe = (id, name, img, changes, desc, flags = {}) => ({
  _id: id, name, img, transfer: false, disabled: false, statuses: [], type: "base", system: { tags: [] }, sort: 0, tint: "#ffffff",
  description: `<p>${desc}</p>`, duration: {}, origin: null, changes, flags: { [M]: { [FLAG]: "ae", ...flags } },
});

// Sprout Ward AE — rides the ally; Crisis → heal, then gone.
const sproutAe = () => templAe(ID.aeSprout, "Sprout Ward", IMG.staff, [], "The next time you fall into Crisis, recover HP (Sprout Ward).", {
  category: "buff",
  reactionConfig: {
    name: "Sprout Ward",
    reaction_config_table: { 0: { reaction_trigger: "creature_status_applied", reaction_status_filter: "Crisis", reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: "sw_do" } },
    effect_table: table([
      { effect_label: "sw_do", effect_kind: "chain", chain_steps: "sw_heal, sw_end" },
      { effect_label: "sw_heal", effect_kind: "grant", grant_resource: "hp", grant_amount: `HR + ${T.sproutHr}`, target_ref: "self" },
      removeAe("sw_end", "Sprout Ward"),
    ]),
  },
});
const SPELL_EFF = [applyAe("sw_apply", "Sprout Ward", { target_ref: "action_targets", ae_duration_rounds: "scene" })];

// Robe — summon the Fairy at conflict start (companion rules).
const ROBE_RC = [rc("conflict_start", "gr_call", { reaction_source: "", reaction_passive_target: "self" })];
const ROBE_EFF = [{ effect_label: "gr_call", effect_kind: "summon", summon_actor: `Actor.${ID.fairy}`, summon_count: "1", summon_kind: "companion", summon_max: "1",
  summon_overrides: JSON.stringify({ max_hp: "5 + CHAR_LEVEL", current_hp: "5 + CHAR_LEVEL" }), summon_act_this_round: "false", summon_turns_per_round: "0" }];

// Earring — Fey Regen on allies your healing spells touched.
const EAR_RC = [rc("creature_completes_spell", "ge_regen", { condition_formula: "ACTION_IS_SPELL == 1 && SKILL_HAS_TAG_HEAL == 1" })];
const EAR_EFF = [applyAe("ge_regen", "Fey Regen", { target_ref: "ally_action_targets", ae_initial_charges: String(T.regenTurns) })];

// Fairy's own passive — acts on its SUMMONER's turn end (Spirit Bond pattern).
const FAIRY_RC = [
  rc("turn_end", "fl_heal_do", { reaction_source: "ally", condition_formula: "SUBJECT_IS_MY_SUMMONER == 1 && (ROUND % 2 == 1 || ANY_ALLY_HAS_DEBUFF == 0)" }),
  rc("turn_end", "fl_clean_do", { reaction_source: "ally", condition_formula: "SUBJECT_IS_MY_SUMMONER == 1 && ROUND % 2 == 0 && ROUND > 0 && ANY_ALLY_HAS_DEBUFF == 1" }),
];
const FAIRY_EFF = [
  { effect_label: "fl_heal_do", effect_kind: "chain", chain_steps: "fl_pick, fl_heal" },
  { effect_label: "fl_pick", effect_kind: "targeting", candidate_source: "combat", category: "ally", mode: "exact", count: "1", target_sort: "lowest_hp_pct",
    exclude_defeated: true, exclude_self: true, auto_target: "skip", skip_when_passive: false },
  { effect_label: "fl_heal", effect_kind: "grant", grant_resource: "hp", grant_amount: T.fairyHeal, target_ref: "fl_pick" },
  { effect_label: "fl_clean_do", effect_kind: "chain", chain_steps: "fl_dpick, fl_clean" },
  { effect_label: "fl_dpick", effect_kind: "targeting", candidate_source: "combat", category: "ally", mode: "exact", count: "1", target_filter: "STATUS_COUNT > 0",
    allow_empty: true, exclude_defeated: true, exclude_self: true, auto_target: "skip", skip_when_passive: false },
  { effect_label: "fl_clean", effect_kind: "remove_tagged_ae", filter_tag: "debuff", count: "1", target_ref: "fl_dpick" },
];

// 2pc Moondew.
const T2_RC = [
  rc("conflict_start", "md_fill", { reaction_source: "" }),
  rc("creature_performs_action", "md_do", { reaction_passive_mode: "ask",
    condition_formula: "ACTION_IS_SPELL == 1 && SKILL_HAS_TAG_HEAL == 1 && AE_CHARGES_MOONDEW >= 1 && ACTION_IS_FREE_CAST == 0 && ACTION_COST_MP > 0" }),
  rc("conflict_end", "md_clear", { reaction_source: "" }),
];
const T2_EFF = [
  applyAe("md_fill", "Moondew", { ae_initial_charges: String(T.moondew), ae_initial_charges_max: String(T.moondew) }),
  { effect_label: "md_do", effect_kind: "chain", chain_steps: "md_pay, md_free", menu_label: "Moondew", menu_description: "Spend 1 Moondew: this healing spell costs no MP." },
  { effect_label: "md_pay", effect_kind: "consume_charge", charge_key: "moondew", count: "1", on_empty: "abort", target_ref: "self" },
  { effect_label: "md_free", effect_kind: "adjust_cost", cost_resource: "mp", cost_operation: "subtract", cost_amount: "ACTION_COST_MP" },
  removeAe("md_clear", "Moondew"),
];

// 3pc Fairy's Sacrifice — an aura on every ally carries the KO save (the save hook only
// reads the VICTIM's own AEs). Needs a living Fairy (Fairy Presence marker on its actor).
const graceAe = () => templAe(ID.aeGrace, "Fairy's Grace", IMG.robe, [], "Once per scene, the Fairy takes a blow that would knock you out.", {
  category: "Other",
  reactionConfig: {
    name: "Fairy's Grace",
    reaction_config_table: { 0: { reaction_trigger: "creature_takes_damage", reaction_source: "self", reaction_passive_mode: "force",
      reaction_damage_outcome: "would_reduce_to_zero", condition_formula: "COMBAT_LIVING_MAX_AE_CHARGES_FAIRY_PRESENCE >= 1", reaction_effect_ref: "fg_save" } },
    effect_table: table([
      { effect_label: "fg_save", effect_kind: "chain", chain_steps: "fg_cap, fg_card, fg_heal, fg_fairy, fg_dismiss, fg_clear" },
      { effect_label: "fg_cap", effect_kind: "adjust_damage", damage_stage: "incoming", damage_operation: "cap", damage_amount: "CUR_HP - 1", consume_self: true },
      { effect_label: "fg_card", effect_kind: "notify", notify_type: "card", notify_message: "Fairy's Sacrifice", notify_abort: false },
      { effect_label: "fg_heal", effect_kind: "grant", grant_resource: "hp", grant_amount: T.graceHeal, target_ref: "all_party" },
      { effect_label: "fg_fairy", effect_kind: "targeting", candidate_source: "combat", category: "ally", mode: "all", target_filter: "HAS_SKILL_FEY_LIGHT == 1", auto_target: "skip", allow_empty: true },
      { effect_label: "fg_dismiss", effect_kind: "destroy_summon", target_ref: "fg_fairy", suppress_defeat: true },
      removeAe("fg_clear", "Fairy's Grace", "all_party"),
    ]),
  },
});
const T3_RC = [rc("conflict_start", "fs_aura", { reaction_source: "" })];
const T3_EFF = [applyAe("fs_aura", "Fairy's Grace", { target_ref: "all_party", ae_duration_rounds: "scene" })];

// ── Helpers ─────────────────────────────────────────────────────────────────
function cloneItem(srcId, { id, name, container = null, folder = ID.folder, img = null, props = {}, effects = [] }) {
  const donor = game.items.get(srcId);
  if (!donor) throw new Error(`donor ${srcId} missing`);
  const d = donor.toObject();
  d._id = id; d.name = name; d.img = img ?? d.img; d.folder = game.folders.get(folder) ? folder : null; d.effects = effects;
  d.system.container = container; d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...props, name, id, uuid: `Item.${id}` };
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: "created" } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}
async function createIfMissing(data, out, label) {
  if (game.items.get(data._id)) { out.push(`= ${label}`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${label}`);
  return doc;
}
const passiveProps = (rcRows, effRows, text) => ({ effect_table: table(effRows), reaction_config_table: table(rcRows), description: ul(...text), skill_description: ul(...text),
  isReaction: true, skill_type: "Passive", skill_target: "Self", max_level: 1 });
const grantMap = (spell, text) => ({ [spell]: { id: "${item.id}", name: "Sprout Ward", skill_cost: "10 MP", skill_description: ul(...text), skill_maxLevel: 1, uuid: `Item.${spell}` } });
const relMap = (spell, text) => ({ [spell]: { id: "${item.id}", name: "Sprout Ward", related_item_description: ul(...text), uuid: `Item.${spell}` } });
const GEAR = { item_rarity: "Rare", isSet: true, set_name: SET_NAME, set_description: SET_DESC, item_activeEffect: "" };

async function ensureFolder(out) {
  if (game.folders.get(ID.folder)) return;
  await Folder.create({ _id: ID.folder, name: SET_NAME, type: "Item", folder: game.folders.get(ID.setParent) ? ID.setParent : null, sorting: "a" }, { keepId: true });
  out.push("+ folder Fey Wanderer");
}

async function createFairy(out) {
  if (game.actors.get(ID.fairy)) { out.push("= Fairy actor"); return; }
  const hawk = game.actors.get(DONOR.hawk);
  if (!hawk) { out.push("! Spirit Hawk donor missing — Fairy not created"); return; }
  const d = hawk.toObject();
  d._id = ID.fairy; d.name = "Fairy"; d.img = IMG.fairy;
  d.prototypeToken = { ...(d.prototypeToken ?? {}), name: "Fairy", texture: { ...(d.prototypeToken?.texture ?? {}), src: IMG.fairy } };
  const keep = (d.items ?? []).filter((i) => i.name === "Flying");
  const light = cloneItem(DONOR.passive, { id: ID.feyLight, name: "Fey Light", folder: null, img: IMG.earring,
    props: passiveProps(FAIRY_RC, FAIRY_EFF, [`At the end of your summoner's turn, restore ${B("【10 + ½ their level】")} HP to the ally with the lowest HP. On even rounds, remove 1 debuff from an ally instead, if any ally has one.`]) });
  delete light.folder;
  d.items = [...keep, light];
  d.effects = [templAe(ID.aePresence, "Fairy Presence", IMG.fairy, [], "Marks a living Fairy (Fairy's Sacrifice checks for it).",
    { category: "Other", chargeKey: "fairypresence", charges: 1, chargesMax: 1, lifetimeMode: "persistent_counter", directorPermanent: true })];
  const p = d.system.props;
  Object.assign(p, { name: "Fairy", max_mp: 0, current_mp: 0, def_mod: "+0", mdef_mod: "+5", species: "MONSTER" });
  for (let n = 1; n <= 9; n++) p[`affinity_${n}`] = "NA";
  const f = { ...(d.flags?.[M] ?? {}) }; delete f.spiritHawkArt; delete f.wardenHawk;
  d.flags = { ...(d.flags ?? {}), [M]: { ...f, [FLAG]: "created", feyFairy: true, idleAnimation: { bounce: false, float: true } } };
  delete d._stats; delete d.sort; delete d.ownership;
  await Actor.createDocuments([d], { keepId: true });
  out.push("+ Fairy actor");
}

async function createPieces(out) {
  // Staff + its spell.
  const spellText = TEXT.spell;
  await createIfMissing(cloneItem(DONOR.staff, { id: ID.staff, name: "Glimmerwing Staff", img: IMG.staff, props: {
    ...GEAR, item_type: "weapon", category: "Arcane", rolled_atr1: "WLP", rolled_atr2: "WLP", damage_bonus: "6", type_damage: "Physical",
    hand_slots: "Two-handed", weapon_range: "Melee", item_cost: "3000", description: ul(...TEXT.staff), flavor_text: FLAVOR.staff,
    item_skill_active: grantMap(ID.spell, spellText), related_item_list: relMap(ID.spell, spellText),
  } }), out, "Glimmerwing Staff");
  await createIfMissing(cloneItem(DONOR.spell, { id: ID.spell, name: "Sprout Ward", container: ID.staff, img: IMG.staff, effects: [sproutAe()], props: {
    cost: "10 MP", skill_target: "One creature", duration: "Scene", skill_type: "Spell", isCheck: false, isOffensiveSpell: false, skill_tags: "heal",
    effect_table: table(SPELL_EFF), on_activate_effect_ref: "sw_apply", description: ul(...spellText), skill_description: ul(...spellText),
  } }), out, "Sprout Ward");
  // Robe + summon passive.
  await createIfMissing(cloneItem(DONOR.armor, { id: ID.robe, name: "Glimmerwing Robe", img: IMG.robe, props: {
    ...GEAR, item_type: "armor", isMartial: false, item_baseDef: "0", item_baseMdef: "0", item_def_bonus: "1", item_mdef_bonus: "1", item_cost: "3200",
    description: ul(...TEXT.robe), flavor_text: FLAVOR.robe,
  } }), out, "Glimmerwing Robe");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.robePsv, name: "Glimmerwing Robe (Passive)", container: ID.robe, img: IMG.robe, props: passiveProps(ROBE_RC, ROBE_EFF, TEXT.robe) }), out, "Glimmerwing Robe (Passive)");
  // Earring + Fey Regen passive.
  const regen = game.items.get(DONOR.regenItem)?.effects?.get(DONOR.regenAe)?.toObject();
  let regenAe = null;
  if (regen) {
    regenAe = foundry.utils.deepClone(regen);
    regenAe._id = ID.aeRegen; regenAe.name = "Fey Regen"; regenAe.img = IMG.earring;
    const rf = regenAe.flags[M];
    rf.charges = T.regenTurns; rf.chargesMax = T.regenTurns; rf.chargeKey = "feyregen";
    for (const r of Object.values(rf.reactionConfig?.effect_table ?? {})) if (r.effect_kind === "grant") r.grant_amount = T.regenHp;
    if (rf.reactionConfig) rf.reactionConfig.name = "Fey Regen";
    rf[FLAG] = "ae";
  } else out.push("! Regen template missing — Fey Regen not built");
  await createIfMissing(cloneItem(DONOR.acc, { id: ID.earring, name: "Glimmerwing Earring", img: IMG.earring, props: {
    ...GEAR, item_type: "accessory", item_cost: "2000", description: ul(...TEXT.earring), flavor_text: FLAVOR.earring,
  } }), out, "Glimmerwing Earring");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.earPsv, name: "Glimmerwing Earring (Passive)", container: ID.earring, img: IMG.earring,
    effects: regenAe ? [regenAe] : [], props: passiveProps(EAR_RC, EAR_EFF, TEXT.earring) }), out, "Glimmerwing Earring (Passive)");
}

async function createSet(out) {
  await createIfMissing(cloneItem(DONOR.setDoc, { id: ID.set, name: `${SET_NAME} — Equipment Set`, img: "icons/svg/item-bag.svg", props: {
    isSet: false, set_name: SET_NAME, set_bonus_table: table([
      { pieces: "2", bonus_label: "2 Moondew per conflict: a healing spell costs no MP", bonus_ae_ref: "", bonus_skill_ref: "Moondew" },
      { pieces: "3", bonus_label: "Once per scene: the Fairy saves an ally from a KO", bonus_ae_ref: "", bonus_skill_ref: "Fairy's Sacrifice" },
    ]) } }), out, "Fey Wanderer — Equipment Set");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.t2, name: "Moondew", container: ID.set, img: IMG.earring,
    effects: [templAe(ID.aeMoondew, "Moondew", IMG.earring, [], "Spend 1 when you cast a healing spell: it costs no MP.",
      { category: "Other", chargeKey: "moondew", charges: T.moondew, chargesMax: T.moondew, lifetimeMode: "persistent_counter", hudResourceColor: "#9fe3c4" })],
    props: passiveProps(T2_RC, T2_EFF, TEXT.t2) }), out, "2-Piece Moondew");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.t3, name: "Fairy's Sacrifice", container: ID.set, img: IMG.robe, effects: [graceAe()],
    props: passiveProps(T3_RC, T3_EFF, TEXT.t3) }), out, "3-Piece Fairy's Sacrifice");
}

// Healing spells carry skill_tags "heal" (world + every actor copy).
const HEAL_SPELLS = new Set(["Heal", "Regen"]);
async function tagHealingSpells(out) {
  const docs = [...game.items];
  for (const a of game.actors) docs.push(...a.items);
  let n = 0;
  for (const it of docs) {
    const p = it.system?.props ?? {};
    if (!HEAL_SPELLS.has(it.name) || String(p.skill_type ?? "") !== "Spell") continue;
    const tags = String(p.skill_tags ?? "").split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    if (tags.includes("heal")) continue;
    await it.update({ "system.props.skill_tags": [...tags, "heal"].join(", ") });
    n++;
  }
  out.push(`~ heal tag on ${n} healing-spell copies`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await ensureFolder(out);
  await createFairy(out);
  await createPieces(out);
  await createSet(out);
  await tagHealingSpells(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
