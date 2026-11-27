/**
 * Migration: 2026-11-28-berserker-gear  (Berserker set + Spell Fencer Hat, sold by Hako)
 * ---------------------------------------------------------------------------
 * Designed with the user 2026-11-28 (chat): new gear for Hako's rolling shop pool, no drops.
 *
 *   Berserker Armor   Rare martial armor, DEF 12 / M.DEF = INS die, 3000z.
 *                     While in Crisis: +1 DEF and Berserk (Attack only, ×2 damage). Berserk is applied
 *                     on entering Crisis and re-checked at your turn start (a cleanse lasts until then);
 *                     it is removed when you leave Crisis (only the copy the armor gave: marker
 *                     "Berserker Rage").
 *   Berserker Axe     Rare martial Heavy, two-handed, MIG+MIG, HR+18 Physical, 2800z.
 *                     Basic attacks deal 3% more damage per 10% of HP missing (house ruling:
 *                     "attack with this weapon" = basic attack only).
 *   Berserker (set)   2 pieces: "You deal 10% more damage." (all damage, Mukuta row pattern).
 *                     2-piece sets may be normal loot / shop stock (user rule 2026-11-28).
 *   Spell Fencer Hat  Uncommon accessory, 1500z, class related equipment (Spell Fencer).
 *                     Offensive Spell after a weapon attack last turn → recover 5 MP; weapon attack
 *                     after an Offensive Spell last turn → 5 extra damage. Its own hidden markers
 *                     store the ROUND of the last attack / spell, so it stacks with Spellweave /
 *                     Bladework instead of sharing their Next Spell / Next Attack markers (user).
 *   Hako              the 3 items join her roster pool; set "Berserker" goes on the roster's
 *                     allowedSets (per-set call, user 2026-11-28); each piece rolls on its own.
 *
 * SEED-ONLY: fixed ids, flag berserkerGear. Re-running creates nothing twice.
 */

export const key = "2026-11-28-berserker-gear";
export const description = "Berserker Armor + Berserker Axe (2-piece set Berserker, +10% damage), Spell Fencer Hat; all three in Hako's roster pool, set allowed there.";

const M = "fabula-ultima-companion";
const FLAG = "berserkerGear";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SET_NAME = "Berserker";
const HAKO = "srAH3OHOoK0tvFih";

const ID = {
  setFolder: "BrskSetFolder001", setParent: "5KFkUixjqI5c6PpK",
  armor: "BrskArmor0000001", armorPsv: "BrskArmorPsv0001", aeGuard: "BrskArmorDefAE01", aeRage: "BrskRageMarker01",
  axe: "BrskAxe000000001", axePsv: "BrskAxePsv000001",
  set: "BrskSetDef000001", t2: "BrskSetFury00001",
  hatFolder: "ClassRelEquipFd1", hatParent: "6mmwacB3WSm0f9bN",
  hat: "SpFnHat000000001", hatPsv: "SpFnHatPsv000001", aeHatBlade: "SpFnHatBladeAE01", aeHatSpell: "SpFnHatSpellAE01",
};
const DONOR = {
  armor: "NoxStDullahArm01", axe: "5F5MJOjDM4zVk1cw", acc: "6fN45LX3i4bmqIFY",
  setDoc: "CQ6Pq61KaMixQAjw", passive: "r5YlGxjwTfvpt5yM",
};
const IMG = {
  armor: `${FORGE}Item%20Icon/Armor/FF%20Brave%20Exvius/Icon-Demon_Mail.webp`,
  axe: `${FORGE}Item%20Icon/Weapon/FF%20Brave%20Exvius%20Weapon/Axe/Icon-Ulfhedinn_Axe.webp`,
  hat: `${FORGE}Item%20Icon/Armor/FF%20Brave%20Exvius/Icon-Feathered_Cap.webp`,
};
const T = { axePerStep: 3, setMult: "1.1", hatMp: "5", hatDmg: "5" };
const PRICE = { armor: 3000, axe: 2800, hat: 1500 };

// ── Text (Genshin mode, styled links) ───────────────────────────────────────
const B = (s) => `<strong>${s}</strong>`;
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const em = (t) => `<p><em>${t}</em></p>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
// Status links: the house's most common styled Crisis anchor (harvested 11-28), Berserk derived from it.
const STATUS_STYLE = "box-sizing: border-box; user-select: text; scrollbar-width: thin; scrollbar-color: rgb(93, 20, 43) rgba(0, 0, 0, 0); cursor: pointer; --content-link-background: rgba(0, 0, 0, 0.1); background-image: none !important; background-position: initial !important; background-size: initial !important; background-repeat: initial !important; background-attachment: initial !important; background-origin: initial !important; background-clip: initial !important; background-color: rgb(102, 102, 102); padding: 0px !important; border: none !important; border-radius: 2px; white-space: nowrap; word-break: break-all; color: rgb(25, 24, 19); font-weight: bold; text-decoration: underline; display: inline-flex; align-items: center; position: relative; top: 2px; font-family: Signika, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px;";
const statusLink = (id, label) => `<span style="text-decoration: underline;"><span style="font-family: Signika, sans-serif"><a class="content-link" draggable="true" data-link="" data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry" data-tooltip="Journal Entry" aria-describedby="tooltip" style="${STATUS_STYLE}"><strong><span style="text-decoration: underline;">${label}</span></strong></a></span></span>`;
const CRISIS = statusLink("GJevbCPM8cffm1QM", "Crisis");
const BERSERK = statusLink("aPF9gzkqnUkcQmIC", "Berserk");
const OFF_SPELL = "【⚡Offensive Spell】";

const TEXT = {
  armor: [`While in ${CRISIS}, gain ${B("+1")} DEF and ${BERSERK}.`],
  axe: [`Deals ${B(`${T.axePerStep}%`)} more damage for every 10% of your HP missing.`],
  t2: [`You deal ${B("10%")} more damage.`],
  hat: [
    `When you cast an ${OFF_SPELL}, if you attacked last turn, recover ${B(T.hatMp)} MP.`,
    `When you attack, if you cast an ${OFF_SPELL} last turn, deal ${B(T.hatDmg)} extra damage.`,
  ],
};
const SET_DESC = `<p><strong>【Set Bonus】</strong></p><p><strong>2 Piece</strong></p>${ul(...TEXT.t2)}`;
const FLAVOR = {
  armor: em("Black plate that drinks its wearer's blood. The deeper the wound, the louder it howls."),
  axe: em("A plain battleaxe, notched from a hundred last stands. It swings heaviest when you are barely standing."),
  hat: em("A fashionable feathered hat favored by Spell Fencers."),
};

// ── Rows ────────────────────────────────────────────────────────────────────
const rc = (trigger, ref, extra = {}) => ({
  reaction_trigger: trigger, reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: ref,
  condition_formula: "", reaction_resource_filter: "", reaction_cause_filter: "", reaction_max_per_round: "", reaction_requires_weapon_used: false, ...extra,
});
const SELF = (label) => ({ effect_kind: "targeting", effect_label: label, candidate_source: "self", count: "1", mode: "exact",
  iteration_mode: "together", auto_target: "skip", auto_confirm_when_obvious: true, skip_when_passive: true });
const removeAe = (label, names, extra = {}) => ({ effect_label: label, effect_kind: "remove_ae", ae_template_ref: names, include_persistent: true, target_ref: "self", ...extra });
const templAe = (id, name, img, changes, desc, flags = {}, transfer = false) => ({
  _id: id, name, img, transfer, disabled: false, statuses: [], type: "base", system: { tags: [] }, sort: 0, tint: "#ffffff",
  description: `<p>${desc}</p>`, duration: {}, origin: null, changes, flags: { [M]: { [FLAG]: "ae", ...flags } },
});
const marker = (id, name, img, desc) => templAe(id, name, img, [], desc, { hidden: true, lifetimeMode: "persistent_counter", tags: ["hidden"] });

// Armor: Berserk while in Crisis. "Berserker Rage" marks the Berserk this armor gave.
const IN_CRISIS = "HAS_STATUS_CRISIS == 1";
const ARMOR_RC = [
  rc("creature_lose_resource", "bk_on", { reaction_resource_filter: "hp", condition_formula: `${IN_CRISIS} && AE_COUNT_BERSERKER_RAGE == 0` }),
  rc("turn_start", "bk_on", { reaction_passive_target: "self", condition_formula: `${IN_CRISIS} && (AE_COUNT_BERSERKER_RAGE == 0 || AE_COUNT_BERSERK == 0)` }),
  rc("conflict_start", "bk_on", { reaction_source: "", reaction_passive_target: "self", condition_formula: IN_CRISIS }),
  rc("creature_gain_resource", "bk_off", { reaction_resource_filter: "hp", condition_formula: `HAS_STATUS_CRISIS == 0 && AE_COUNT_BERSERKER_RAGE > 0` }),
  rc("turn_start", "bk_off", { reaction_passive_target: "self", condition_formula: `HAS_STATUS_CRISIS == 0 && AE_COUNT_BERSERKER_RAGE > 0` }),
];
const ARMOR_EFF = [
  { effect_label: "bk_on", effect_kind: "chain", chain_steps: "bk_berserk, bk_mark" },
  { effect_label: "bk_berserk", effect_kind: "apply_ae", ae_template_ref: "Berserk", ae_duplicate_mode: "skip", ae_lifetime_mode: "persistent_counter", target_ref: "self" },
  { effect_label: "bk_mark", effect_kind: "apply_ae", ae_template_ref: "Berserker Rage", ae_duplicate_mode: "replace", ae_lifetime_mode: "persistent_counter", target_ref: "self" },
  { effect_label: "bk_off", effect_kind: "chain", chain_steps: "bk_unberserk, bk_unmark" },
  removeAe("bk_unberserk", "Berserk"),
  removeAe("bk_unmark", "Berserker Rage"),
];
// +1 DEF in Crisis rides the armor itself (Matador Cape "Dance with Danger" pattern).
const armorGuardAe = () => templAe(ID.aeGuard, "Berserker Guard", IMG.armor,
  [{ key: "bonus_defense", mode: 2, priority: null, value: '${and(isEquipped, ae("Crisis")) ? 1 : 0}$' }], "+1 DEF while in Crisis.", {}, true);

// Axe: basic attacks only, 3% per full 10% of HP missing.
const AXE_RC = [rc("creature_will_deal_damage", "ax_rage", { reaction_requires_weapon_used: true,
  condition_formula: "ACTION_IS_ATTACK == 1 && DAMAGE_IS_HP == 1 && CUR_HP * 10 <= MAX_HP * 9" })];
const AXE_EFF = [{ effect_label: "ax_rage", effect_kind: "adjust_damage", damage_stage: "outgoing", damage_operation: "percent",
  damage_amount: `${T.axePerStep} * floor((100 - CUR_HP * 100 / MAX_HP) / 10)` }];

// 2pc: all damage ×1.10 (Mukuta row).
const T2_RC = [rc("creature_will_deal_damage", "bf_bonus", { condition_formula: "DAMAGE_IS_HP == 1" })];
const T2_EFF = [{ effect_label: "bf_bonus", effect_kind: "adjust_damage", damage_stage: "outgoing", damage_operation: "multiply", damage_amount: T.setMult }];

// Hat: markers hold the ROUND of your last weapon attack / Offensive Spell; "last turn" = ROUND - 1.
const HAT_SPELL = "ACTION_IS_SPELL == 1 && ACTION_ROLLS_ACCURACY == 1";
const HAT_RC = [
  rc("creature_completes_attack", "ht_atk", { reaction_passive_target: "self", condition_formula: "ROUND > 0" }),
  rc("creature_completes_spell", "ht_spl", { reaction_passive_target: "self", condition_formula: `ROUND > 0 && ${HAT_SPELL}` }),
  rc("creature_will_deal_damage", "ht_dmg", { reaction_action_target: "enemy",
    condition_formula: "ROUND > 0 && ACTION_IS_ATTACK == 1 && DAMAGE_IS_HP == 1 && AE_CHARGES_FENCER_HAT_SPELL == ROUND - 1" }),
  rc("conflict_start", "ht_clear", { reaction_source: "", reaction_passive_target: "self" }),
  rc("conflict_end", "ht_clear", { reaction_source: "", reaction_passive_target: "self" }),
];
const HAT_EFF = [
  SELF("ht_self"),
  { effect_label: "ht_atk", effect_kind: "apply_ae", ae_template_ref: "Fencer Hat Blade", ae_duplicate_mode: "replace",
    ae_initial_charges: "ROUND", ae_initial_charges_max: "999", ae_lifetime_mode: "persistent_counter", target_ref: "ht_self" },
  { effect_label: "ht_spl", effect_kind: "chain", chain_steps: "ht_mp, ht_spl_mark" },
  { effect_label: "ht_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: T.hatMp, target_ref: "ht_self",
    condition_formula: "AE_CHARGES_FENCER_HAT_BLADE == ROUND - 1", on_condition_fail: "skip" },
  { effect_label: "ht_spl_mark", effect_kind: "apply_ae", ae_template_ref: "Fencer Hat Spell", ae_duplicate_mode: "replace",
    ae_initial_charges: "ROUND", ae_initial_charges_max: "999", ae_lifetime_mode: "persistent_counter", target_ref: "ht_self" },
  { effect_label: "ht_dmg", effect_kind: "adjust_damage", damage_stage: "outgoing", damage_operation: "add", damage_amount: T.hatDmg, target_ref: "trigger_subject" },
  removeAe("ht_clear", "Fencer Hat Blade, Fencer Hat Spell"),
];
const hatMarkers = () => [
  marker(ID.aeHatBlade, "Fencer Hat Blade", IMG.hat, "Round of your last weapon attack (Spell Fencer Hat)."),
  marker(ID.aeHatSpell, "Fencer Hat Spell", IMG.hat, "Round of your last Offensive Spell (Spell Fencer Hat)."),
];

// ── Helpers ─────────────────────────────────────────────────────────────────
// Drops the donor's own references (contained-skill maps, migrator/backup flags).
const STRIP_PROPS = { item_skill_passive: {}, item_skill_active: {}, related_item_list: {}, item_activeEffect: "" };
function cloneItem(srcId, { id, name, container = null, folder = null, img = null, props = {}, effects = [] }) {
  const donor = game.items.get(srcId);
  if (!donor) throw new Error(`donor ${srcId} missing`);
  const d = donor.toObject();
  d._id = id; d.name = name; d.img = img ?? d.img; d.folder = folder && game.folders.get(folder) ? folder : null; d.effects = effects;
  d.system.container = container; d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...STRIP_PROPS, ...props, name, id, uuid: `Item.${id}`, img: d.img };
  d.flags = { "custom-system-builder": d.flags?.["custom-system-builder"] ?? {}, [M]: { [FLAG]: "created" } };
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
const SET_GEAR = { item_rarity: "Rare", isSet: true, set_name: SET_NAME, set_description: SET_DESC, refine_count: "0", refine_level: "0" };

async function ensureFolder(id, name, parent, out) {
  if (game.folders.get(id)) return;
  await Folder.create({ _id: id, name, type: "Item", folder: game.folders.get(parent) ? parent : null, sorting: "a" }, { keepId: true });
  out.push(`+ folder ${name}`);
}

async function createBerserkerSet(out) {
  await ensureFolder(ID.setFolder, SET_NAME, ID.setParent, out);
  const armorDonor = game.items.get(DONOR.armor);
  // keep the donor's Armor DEF / Armor MDEF stat effects (fixed DEF for martial armor), fresh ids
  const statAes = (armorDonor?.effects?.contents ?? []).filter((e) => /^Armor (M)?DEF$/.test(e.name)).map((e) => {
    const o = e.toObject(); delete o._id; o.flags = {}; return o;
  });
  await createIfMissing(cloneItem(DONOR.armor, { id: ID.armor, name: "Berserker Armor", folder: ID.setFolder, img: IMG.armor,
    effects: [...statAes, armorGuardAe()], props: {
      ...SET_GEAR, item_type: "armor", isMartial: true, item_baseDef: "12", item_baseMdef: "0", item_def_bonus: "0", item_mdef_bonus: "0",
      item_cost: String(PRICE.armor), description: ul(...TEXT.armor), flavor_text: FLAVOR.armor,
    } }), out, "Berserker Armor");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.armorPsv, name: "Berserker Armor (Passive)", container: ID.armor, img: IMG.armor,
    effects: [marker(ID.aeRage, "Berserker Rage", IMG.armor, "This Berserk comes from Berserker Armor; it ends when you leave Crisis.")],
    props: passiveProps(ARMOR_RC, ARMOR_EFF, TEXT.armor) }), out, "Berserker Armor (Passive)");

  await createIfMissing(cloneItem(DONOR.axe, { id: ID.axe, name: "Berserker Axe", folder: ID.setFolder, img: IMG.axe, props: {
    ...SET_GEAR, item_type: "weapon", category: "Heavy", hand_slots: "Two-handed", isMartial: true, rolled_atr1: "MIG", rolled_atr2: "MIG",
    check_bonus: "0", damage_bonus: "18", type_damage: "Physical", weapon_range: "Melee", skill_target: "One Enemy",
    item_cost: String(PRICE.axe), description: ul(...TEXT.axe), flavor_text: FLAVOR.axe,
  } }), out, "Berserker Axe");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.axePsv, name: "Berserker Axe (Passive)", container: ID.axe, img: IMG.axe,
    props: { ...passiveProps(AXE_RC, AXE_EFF, TEXT.axe) } }), out, "Berserker Axe (Passive)");

  await createIfMissing(cloneItem(DONOR.setDoc, { id: ID.set, name: `${SET_NAME} — Equipment Set`, folder: ID.setParent, img: "icons/svg/item-bag.svg", props: {
    isSet: false, set_name: SET_NAME, set_description: SET_DESC, set_bonus_table: table([
      { pieces: "2", bonus_label: "+10% damage", bonus_ae_ref: "", bonus_skill_ref: "Berserker's Fury" },
    ]) } }), out, "Berserker — Equipment Set");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.t2, name: "Berserker's Fury", container: ID.set, img: IMG.axe,
    props: passiveProps(T2_RC, T2_EFF, TEXT.t2) }), out, "2-Piece Berserker's Fury");
}

async function createHat(out) {
  await ensureFolder(ID.hatFolder, "Class Related Equipment", ID.hatParent, out);
  await createIfMissing(cloneItem(DONOR.acc, { id: ID.hat, name: "Spell Fencer Hat", folder: ID.hatFolder, img: IMG.hat, props: {
    item_type: "accessory", item_rarity: "Uncommon", isSet: false, set_name: "", set_description: "",
    item_def_bonus: "0", item_mdef_bonus: "0", item_cost: String(PRICE.hat), description: ul(...TEXT.hat), flavor_text: FLAVOR.hat,
  } }), out, "Spell Fencer Hat");
  await createIfMissing(cloneItem(DONOR.passive, { id: ID.hatPsv, name: "Spell Fencer Hat (Passive)", container: ID.hat, img: IMG.hat,
    effects: hatMarkers(), props: passiveProps(HAT_RC, HAT_EFF, TEXT.hat) }), out, "Spell Fencer Hat (Passive)");
}

// Hako: pool entries + the per-set allow.
async function addToHako(out) {
  const hako = game.actors.get(HAKO);
  const st = hako?.flags?.[M]?.shopRoster;
  if (!st) { out.push("! Hako roster missing, pool not updated"); return; }
  const pool = [...(st.pool ?? [])];
  let added = 0;
  for (const [id, price] of [[ID.armor, PRICE.armor], [ID.axe, PRICE.axe], [ID.hat, PRICE.hat]]) {
    if (pool.some((e) => e.id === id)) continue;
    pool.push({ id, price }); added++;
  }
  const config = { ...(st.config ?? {}) };
  const allowed = new Set(Array.isArray(config.allowedSets) ? config.allowedSets : []);
  const setAdded = !allowed.has(SET_NAME);
  allowed.add(SET_NAME);
  config.allowedSets = [...allowed];
  if (!added && !setAdded) { out.push("= Hako pool"); return; }
  await hako.update({ [`flags.${M}.shopRoster.pool`]: pool, [`flags.${M}.shopRoster.config`]: config });
  out.push(`~ Hako pool +${added}${setAdded ? `, set "${SET_NAME}" allowed` : ""}`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await createBerserkerSet(out);
  await createHat(out);
  await addToHako(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
