/**
 * Migration: 2026-11-26-sage-of-destruction  (Sage of Destruction gacha set + both caster banners)
 * ---------------------------------------------------------------------------
 * Review page https://claude.ai/artifact/JERJHoc46xgsx6EjF1MbCV (approved round 5). All pieces Rare.
 *   Keter Rod      INS+WLP, HR+6 Physical. The first time you cast an offensive spell that costs MP
 *                  this scene → 1 Veil (max 3; lost at scene end). Grants Ain Soph Aur:
 *                  50 MP + 3 Veil, one creature, Pierce, 【50 + your level】 Non-Elemental, no High Roll;
 *                  then lose all Veil and every offensive spell counts as new again.
 *                  (Veil row: reaction_max_scope "skill"; Ain Soph Aur bumps skillCapCycle.)
 *   Gevurah Robe   DEF+0 / M.DEF+2. Offensive spells deal 【3 × targets】 extra damage to each target.
 *   Chesed Band    Offensive spells can target 1 additional creature (spell_extra_targets).
 *   2pc Mana Return  after a multi-target offensive spell, recover 20% of its MP cost.
 *   3pc Overflow Rite  when you cast an offensive spell, you may pay 20 extra MP: it gains Overflow
 *                  (add_target, every other enemy). Ain Soph Aur included.
 * Banners (Wonderous Gachapon): "Sage of Destruction" (+ Moonlight Dancer filler) — "Beyond the Three
 * Veils"; "Fey Wanderer" (+ Eternal Traveler filler) — "Moondew Lullaby". Cloned from the Warden table.
 *
 * SEED-ONLY: fixed ids, flag sageOfDestruction.
 */

export const key = "2026-11-26-sage-of-destruction";
export const description = "Sage of Destruction set (Keter Rod + Ain Soph Aur, Gevurah Robe, Chesed Band, Mana Return 2pc, Overflow Rite 3pc) + Sage / Fey Wanderer gacha banners.";

const M = "fabula-ultima-companion";
const FLAG = "sageOfDestruction";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SET_NAME = "Sage of Destruction";

const ID = {
  folder: "SageDstFolder001", setParent: "5KFkUixjqI5c6PpK",
  rod: "SageDstKeterRod1", asa: "SageDstAinSoph01", rodPsv: "SageDstRodPsv001", aeVeil: "SageDstVeilAE001", aeVeilReset: "SageDstVeilRst01",
  robe: "SageDstGevurah01", robePsv: "SageDstRobePsv01",
  band: "SageDstChesed001", aeBand: "SageDstBandAE001",
  set: "SageDstSetDef001", t2: "SageDstManaRtn01", t3: "SageDstOvrRite01",
  bannerFolder: "QGWhvmRAHt4ibvnG", bannerDonor: "HkC4WardenBanner", sageBanner: "CasterBnrSage001", feyBanner: "CasterBnrFey0001",
};
const DONOR = { staff: "UgcS71lsTsfnUG1b", spell: "YPuC5X6cDNWbafg9", armor: "P8L1KkGNgdqvydZT", acc: "NHQNneNjKb1Je06v", setDoc: "CQ6Pq61KaMixQAjw", passive: "r5YlGxjwTfvpt5yM" };
const IMG = {
  rod: `${FORGE}Item%20Icon/Weapon/FF%20Brave%20Exvius%20Weapon/Rods/Icon-Mateus%2527s_Malice.webp`,
  robe: `${FORGE}Item%20Icon/Armor/FF%20Brave%20Exvius/Icon-Mage%2527s_Habit.webp`,
  band: `${FORGE}Item%20Icon/Accessories/Ys/Ys9-Diablo_Ring.webp`,
};
const T = { veilMax: 3, asaMp: 50, asaBase: 50, robeScale: 3, refund: 0.2, overflowMp: 20 };

// ── Text ────────────────────────────────────────────────────────────────────
const B = (s) => `<strong>${s}</strong>`;
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const em = (t) => `<p><em>${t}</em></p>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const VEIL = B("Veil");
const OVERFLOW = `<a class="content-link" data-uuid="JournalEntry.NUaxIAIPUu5Qnk8l" data-id="NUaxIAIPUu5Qnk8l" data-type="JournalEntry">Overflow</a>`;
const PIERCE = B("Pierce");
const TEXT = {
  rod: [
    `When you cast an offensive spell that costs MP for the first time this scene, gain 1 ${VEIL}. Max ${B(T.veilMax)} stacks.`,
    `You may cast the spell 【⚡<strong>@UUID[Item.${ID.asa}]{Ain Soph Aur}</strong>】`,
    `${VEIL} is lost at the end of the scene.`,
  ],
  asa: [`Deals ${B(`【${T.asaBase} + your level】`)} Non-Elemental damage.`, `Then lose all ${VEIL}. Every offensive spell counts as new again.`],
  robe: [`Your offensive spells deal ${B(`【${T.robeScale} × the number of creatures they target】`)} extra damage to each target.`],
  band: [`Offensive spells you cast can target ${B("1")} additional creature.`],
  t2: [`After an offensive spell that targets more than one creature resolves, recover ${B("20%")} of its MP cost.`],
  t3: [`When you cast an offensive spell, you may pay ${B(T.overflowMp)} extra MP. If you do, it gains ${OVERFLOW}.`],
};
const SET_DESC = `<p><strong>【Set Bonus】</strong></p><p><strong>2 Piece</strong></p>${ul(...TEXT.t2)}<p><strong>3 Piece</strong></p>${ul(...TEXT.t3)}`;
const FLAVOR = {
  rod: em("A crowned rod that hums with light no eye was meant to see. Three veils stand between its bearer and the end of all things."),
  robe: em("Severity woven into black and gold. The wider the ruin, the brighter its threads burn."),
  band: em("A band of shifting colour. Spells cast through it never quite stay where they were aimed."),
};

// ── Rows ────────────────────────────────────────────────────────────────────
const rc = (trigger, ref, extra = {}) => ({
  reaction_trigger: trigger, reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: ref,
  condition_formula: "", reaction_resource_filter: "", reaction_cause_filter: "", reaction_max_per_round: "", reaction_requires_weapon_used: false, ...extra,
});
const applyAe = (label, name, extra = {}) => ({ effect_label: label, effect_kind: "apply_ae", ae_template_ref: name, ae_duplicate_mode: "replace", target_ref: "self", ...extra });
const removeAe = (label, name) => ({ effect_label: label, effect_kind: "remove_ae", ae_template_ref: name, include_persistent: true, target_ref: "self" });
const templAe = (id, name, img, changes, desc, flags = {}) => ({
  _id: id, name, img, transfer: false, disabled: false, statuses: [], type: "base", system: { tags: [] }, sort: 0, tint: "#ffffff",
  description: `<p>${desc}</p>`, duration: {}, origin: null, changes, flags: { [M]: { [FLAG]: "ae", ...flags } },
});
const gearAe = (id, name, img, changes, desc) => ({ ...templAe(id, name, img, changes, desc), transfer: true });

// Keter Rod passive — Veil (once per spell NAME per cycle, whole battle; skill scope).
const ROD_RC = [
  rc("creature_performs_action", "kr_veil", { reaction_max_per_round: "1", reaction_max_scope: "skill",
    condition_formula: `ACTION_IS_OFFENSIVE_SPELL == 1 && ACTION_COST_MP > 0 && ACTION_IS_FREE_CAST == 0 && PERFORMED_SKILL != "Ain Soph Aur"` }),
  rc("conflict_end", "kr_clear", { reaction_source: "" }),
];
const ROD_EFF = [
  applyAe("kr_veil", "Veil", { ae_duplicate_mode: "add_charges", ae_initial_charges: "1", ae_initial_charges_max: String(T.veilMax) }),
  removeAe("kr_clear", "Veil"),
];
const veilAe = () => templAe(ID.aeVeil, "Veil", IMG.rod, [], "At 3 Veil, Keter Rod can cast Ain Soph Aur.",
  { category: "Other", chargeKey: "veil", charges: 0, chargesMax: T.veilMax, lifetimeMode: "persistent_counter", hudResourceColor: "#f0d27a" });
// Ain Soph Aur — pay 3 Veil, drop the rest, re-open every spell's Veil quota.
const ASA_EFF = [
  { effect_label: "asa_root", effect_kind: "chain", chain_steps: "asa_pay, asa_drop, asa_cycle" },
  { effect_label: "asa_pay", effect_kind: "consume_charge", charge_key: "veil", count: String(T.veilMax), on_empty: "abort", target_ref: "self" },
  removeAe("asa_drop", "Veil"),
  applyAe("asa_cycle", "Veil Reset", { ae_duplicate_mode: "stack", ae_duration_rounds: "scene" }),
];
const veilResetAe = () => templAe(ID.aeVeilReset, "Veil Reset", IMG.rod, [{ key: `flags.${M}.skillCapCycle`, mode: 2, priority: 20, value: "1" }],
  "Every offensive spell counts as new again for Veil.", { category: "Other" });

// Gevurah Robe passive — 3 × targets, per target.
const ROBE_RC = [rc("creature_will_deal_damage", "gv_bonus", { condition_formula: "ACTION_IS_OFFENSIVE_SPELL == 1 && DAMAGE_IS_HP == 1" })];
const ROBE_EFF = [{ effect_label: "gv_bonus", effect_kind: "adjust_damage", damage_stage: "outgoing", damage_operation: "add", damage_amount: `${T.robeScale} * ACTION_TARGET_COUNT` }];

// 2pc Mana Return — the multi-target gate sits on the EFFECT row (fire time); the CONFIRM
// pre-scan of creature_completes_spell carries no targets.
const T2_RC = [rc("creature_completes_spell", "mr_mp", { condition_formula: "ACTION_IS_OFFENSIVE_SPELL == 1" })];
const T2_EFF = [{ effect_label: "mr_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: `floor(LAST_SPELL_MP * ${T.refund})`, target_ref: "self", condition_formula: "ACTION_TARGET_COUNT >= 2" }];

// 3pc Overflow Rite — pay 20 MP, every other enemy joins (Rondo / Barrage add_target shape).
const T3_RC = [rc("creature_performs_action", "ov_do", { reaction_passive_mode: "ask",
  condition_formula: `ACTION_IS_OFFENSIVE_SPELL == 1 && ACTION_TARGET_COUNT < ENEMY_COUNT && CUR_MP >= ACTION_COST_MP + ${T.overflowMp}` })];
const T3_EFF = [
  { effect_label: "ov_do", effect_kind: "chain", chain_steps: "ov_add, ov_cost", menu_label: "Overflow", menu_description: `Pay ${T.overflowMp} MP: this spell hits every enemy.` },
  { effect_label: "ov_add", effect_kind: "add_target", target_ref: "ov_pool", menu_label: "Overflow", menu_description: `Pay ${T.overflowMp} MP: hits every enemy.` },
  { effect_label: "ov_pool", effect_kind: "targeting", candidate_source: "combat", category: "enemy", mode: "all", exclude_action_targets: true, auto_target: "skip", skip_when_passive: false },
  { effect_label: "ov_cost", effect_kind: "adjust_cost", cost_resource: "mp", cost_operation: "add", cost_amount: String(T.overflowMp) },
];

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
const GEAR = { item_rarity: "Rare", isSet: true, set_name: SET_NAME, set_description: SET_DESC, item_activeEffect: "" };

async function ensureFolder(out) {
  if (game.folders.get(ID.folder)) return;
  await Folder.create({ _id: ID.folder, name: SET_NAME, type: "Item", folder: game.folders.get(ID.setParent) ? ID.setParent : null, sorting: "a" }, { keepId: true });
  out.push("+ folder Sage of Destruction");
}

async function createPieces(out) {
  const asaText = TEXT.asa;
  await createIfMissing(cloneItem(DONOR.staff, { id: ID.rod, name: "Keter Rod", img: IMG.rod, props: {
    ...GEAR, item_type: "weapon", category: "Arcane", rolled_atr1: "INS", rolled_atr2: "WLP", damage_bonus: "6", type_damage: "Physical",
    hand_slots: "Two-handed", weapon_range: "Melee", item_cost: "3200", description: ul(...TEXT.rod), flavor_text: FLAVOR.rod,
    item_skill_active: { [ID.asa]: { id: "${item.id}", name: "Ain Soph Aur", skill_cost: `${T.asaMp} MP + ${T.veilMax} Veil`, skill_description: ul(...asaText), skill_maxLevel: 1, uuid: `Item.${ID.asa}` } },
    related_item_list: { [ID.asa]: { id: "${item.id}", name: "Ain Soph Aur", related_item_description: ul(...asaText), uuid: `Item.${ID.asa}` } },
  } }), out, "Keter Rod");
  await createIfMissing(cloneItem(DONOR.spell, { id: ID.asa, name: "Ain Soph Aur", container: ID.rod, img: IMG.rod, effects: [veilResetAe()], props: {
    skill_type: "Spell", action_command: "spell", isCheck: true, isOffensiveSpell: true, rolled_atr1: "INS", rolled_atr2: "WLP", defense_target_type: "mdef",
    type_damage: "elementless", damage_bonus: `${T.asaBase} + CHAR_LEVEL`, ignore_hr: true, cost: `${T.asaMp} MP`, skill_target: "One creature", duration: "Instantaneous",
    action_keywords: "pierce", availability_formula: `AE_CHARGES_VEIL >= ${T.veilMax}`, availability_reason: `Needs ${T.veilMax} Veil`,
    effect_table: table(ASA_EFF), on_activate_effect_ref: "asa_root", description: ul(...asaText), skill_description: ul(...asaText),
  } }), out, "Ain Soph Aur");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.rodPsv, name: "Keter Rod (Passive)", container: ID.rod, img: IMG.rod, effects: [veilAe()],
    props: passiveProps(ROD_RC, ROD_EFF, [TEXT.rod[0], TEXT.rod[2]]) }), out, "Keter Rod (Passive)");
  await createIfMissing(cloneItem(DONOR.armor, { id: ID.robe, name: "Gevurah Robe", img: IMG.robe, props: {
    ...GEAR, item_type: "armor", isMartial: false, item_baseDef: "0", item_baseMdef: "0", item_def_bonus: "0", item_mdef_bonus: "2", item_cost: "3000",
    description: ul(...TEXT.robe), flavor_text: FLAVOR.robe,
  } }), out, "Gevurah Robe");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.robePsv, name: "Gevurah Robe (Passive)", container: ID.robe, img: IMG.robe, props: passiveProps(ROBE_RC, ROBE_EFF, TEXT.robe) }), out, "Gevurah Robe (Passive)");
  await createIfMissing(cloneItem(DONOR.acc, { id: ID.band, name: "Chesed Band", img: IMG.band,
    effects: [gearAe(ID.aeBand, "Chesed Band — Spread", IMG.band, [{ key: "spell_extra_targets", mode: 0, priority: 20, value: "1" }], "Offensive spells you cast can target 1 additional creature.")],
    props: { ...GEAR, item_type: "accessory", item_cost: "2000", description: ul(...TEXT.band), flavor_text: FLAVOR.band } }), out, "Chesed Band");
}

async function createSet(out) {
  await createIfMissing(cloneItem(DONOR.setDoc, { id: ID.set, name: `${SET_NAME} — Equipment Set`, img: "icons/svg/item-bag.svg", props: {
    isSet: false, set_name: SET_NAME, set_bonus_table: table([
      { pieces: "2", bonus_label: "Multi-target offensive spell: recover 20% of its MP", bonus_ae_ref: "", bonus_skill_ref: "Mana Return" },
      { pieces: "3", bonus_label: "Pay 20 MP: an offensive spell gains Overflow", bonus_ae_ref: "", bonus_skill_ref: "Overflow Rite" },
    ]) } }), out, "Sage of Destruction — Equipment Set");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.t2, name: "Mana Return", container: ID.set, img: IMG.band, props: passiveProps(T2_RC, T2_EFF, TEXT.t2) }), out, "2-Piece Mana Return");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.t3, name: "Overflow Rite", container: ID.set, img: IMG.rod, props: passiveProps(T3_RC, T3_EFF, TEXT.t3) }), out, "3-Piece Overflow Rite");
}

// Banners — clone the Warden table (folder, ownership, displayRoll), main set first.
async function createBanner(out, { id, name, epithet, mainSet, pieceIds }) {
  if (game.tables.get(id)) { out.push(`= banner ${name}`); return; }
  const donor = game.tables.get(ID.bannerDonor);
  if (!donor) { out.push("! Warden banner donor missing"); return; }
  const items = pieceIds.map((i) => game.items.get(i)).filter(Boolean);
  if (items.length !== pieceIds.length) { out.push(`! banner ${name}: ${pieceIds.length - items.length} piece(s) missing`); return; }
  const d = donor.toObject();
  d._id = id; d.name = name; d.description = `<p>${epithet}</p>`; d.img = items[0].img; d.folder = ID.bannerFolder;
  d.formula = `1d${items.length}`;
  d.results = items.map((it, i) => ({ type: "document", text: it.name, documentCollection: "Item", documentId: it.id, img: it.img, weight: 1, range: [i + 1, i + 1], drawn: false, flags: {} }));
  d.flags = { [M]: { gacha: { mainSet }, [FLAG]: "banner" } };
  delete d._stats; delete d.sort;
  await RollTable.createDocuments([d], { keepId: true });
  out.push(`+ banner ${name}`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await ensureFolder(out);
  await createPieces(out);
  await createSet(out);
  await createBanner(out, { id: ID.sageBanner, name: "Sage of Destruction", epithet: "Beyond the Three Veils", mainSet: "Sage of Destruction",
    pieceIds: [ID.rod, ID.robe, ID.band, "nJXcfE31UpQ0rGJI", "roafy3ui2JMXHqsa", "nYQMIXsVeTZzPvhd"] });
  await createBanner(out, { id: ID.feyBanner, name: "Fey Wanderer", epithet: "Moondew Lullaby", mainSet: "Fey Wanderer",
    pieceIds: ["FeyWndStaff00001", "FeyWndRobe000001", "FeyWndEarring001", "gmnCyBBh5qJNb8HM", "dHS9b0tj8FnO0aOQ", "FU3mR0UB7xuX9ZPu"] });
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
