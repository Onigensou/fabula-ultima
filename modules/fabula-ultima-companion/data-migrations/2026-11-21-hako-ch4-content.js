/**
 * Migration: 2026-11-21-hako-ch4-content  (Hako's permanent camp shop, Chapter 4)
 * ---------------------------------------------------------------------------
 * Source of truth for every number/word here: the shop review kit round
 * E:\Art(New Com)\DND\Fabula Ultima\Resource\Shop\review-kit\rounds\hako-ch4\round.js
 * (user-approved through v13, 2026-11-21).
 *
 *   1. Doom becomes real: the Debuff library "Doomed" AE gets a 3-charge
 *      countdown that ticks at the afflicted's turn start and deals lethal
 *      damage on the last tick (Life Charm etc. still get their death-save).
 *   2. New items (all CLONED from in-world donors, then overridden):
 *        Muramasa (Legendary sword) · Staff of Stupidity + Wit's End ·
 *        Stalwart Shield · Mirror Shield · Full Phoenix
 *   3. Older items: rarity / price / text updates, and passives that automate
 *      their (previously text-only) effects:
 *        Zenith Blade (HR+13, +50% out of Crisis) · Death Scythe (Uncommon,
 *        Doom on hit / shorten, immune to Doom) · Frantic Nail + Kusarigama
 *        (Rare, official books; status escalation) · Black Mage Wand (Rare,
 *        3500z) · Tailwind (Rare) · Rewinder (Uncommon) · Gothic Lolita Dress
 *        (Hexer rework "Malediction", Rare 2500z) · Curse Collector (passive) ·
 *        Warden of the Wilds + Luchador set pieces → Rare (gacha budget).
 *   4. Hako's shop actor is restocked with the approved roster.
 *
 * SEED-ONLY: new documents use fixed ids ("HkC4…") and are skipped when they
 * exist; edits to existing items are gated by the flag
 * `flags.fabula-ultima-companion.hakoCh4` on that item, so a re-run never
 * re-applies and hand edits made afterwards are kept.
 */

export const key = "2026-11-21-hako-ch4-content";
export const description = "Hako Ch4: Doom countdown, Muramasa, Staff of Stupidity + Wit's End, Stalwart/Mirror Shield, Full Phoenix, older-item updates + passives, Hako restock.";

const M = "fabula-ultima-companion";
const FLAG = "hakoCh4";
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Hako%20Ch4/";

// ── In-world ids ─────────────────────────────────────────────────────────────
const DEBUFF_LIB = "XVOWOq9oUmEECGrU";
const DOOMED_AE = "8ZULwuHoGlBsToW0";
const HAKO = "srAH3OHOoK0tvFih";
const PASSIVE_SHELL = "r5YlGxjwTfvpt5yM";     // Razor Plume (Passive)
const SPELL_DONOR = "YDxWAJAtZKlH5Xo7";       // Glacies Finis (Arch Ice Wand)
const PHX_PARENT = "QXgHt7VEXEaVdPz1";        // Phoenix Feather
const PHX_SKILL = "wzcDK3lCWXGYqok6";         // Phoenix Feather (item skill)
const MIRROR_PASSIVE = "DzPCCPnqF7PioX20";     // Magic Mirror (Passive)
const DONOR = {
  sword: "CmfeUhDwT0Fwyy1t",   // Zenith Blade (2H sword)
  staff: "8mXI5OJRvKbBpmsm",   // Arch Ice Wand (2H arcane)
  shield: "vH6Q88n3beOHjxKq",  // Avalon (DEF UP / MDEF UP effects)
};

// Journal / element links (plain content-link, the house form in item text)
const J = (id, label) => `<a class="content-link" data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry">${label}</a>`;
const I = (id, label) => `<a class="content-link" data-uuid="Item.${id}" data-id="${id}" data-type="Item">${label}</a>`;
const DOOM = J("Do0VLf6wW9uCSLwD", "Doom");
const CRISIS = J("GJevbCPM8cffm1QM", "Crisis");
const SHIELD = J("wrw2ENSwzCBjztvt", "Shield");
const WEIGHTED = J("ljKBtlzPVvhhmdHW", "Weighted");
const DARK = I("vKU8UYT6DBhgOjtE", "Dark");
const POISON = I("tDcCWc67Ary9nVxe", "Poison");
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const flavor = (t) => `<p><em>${t}</em></p>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));

// ── New document ids (16 chars, stable) ──────────────────────────────────────
const ID = {
  muramasa: "HkC4Muramasa0001", muramasaPsv: "HkC4MuramasaPsv1", muramasaDoom: "HkC4MuraDoomAE01",
  staff: "HkC4StaffStupid1", staffPsv: "HkC4StaffStupPsv", witsEnd: "HkC4WitsEndSpel1", emptyHead: "HkC4EmptyHeadAE1",
  stalwart: "HkC4StalwartShd1", stalwartPsv: "HkC4StalwartPsv1",
  mirror: "HkC4MirrorShld01", mirrorPsv: "HkC4MirrorShPsv1",
  phoenix: "HkC4FullPhoenix1", phoenixSkill: "HkC4FullPhxSkill",
  zenithPsv: "HkC4ZenithPsv001", scythePsv: "HkC4DScythePsv01", scytheImm: "HkC4DScytheImmAE",
  franticPsv: "HkC4FranticPsv01", kusariPsv: "HkC4KusariPsv001", gothicPsv: "HkC4GothicPsv001",
  curseCollPsv: "HkC4CurseCollPsv",
};

// ── Doom countdown (shared by the library AE and Muramasa's variant) ────────
function doomFlags(extra = {}) {
  return {
    chargeKey: "doom",
    charges: 3,
    lifetimeMode: "on_activation",
    reactionConfig: {
      effect_table: table([
        { effect_kind: "notify", effect_label: "doom_tick", notify_message: "Doom draws near…", notify_type: "card", notify_abort: false, target_ref: "self" },
        { effect_kind: "chain", effect_label: "doom_fall", chain_steps: "doom_card, doom_kill" },
        { effect_kind: "notify", effect_label: "doom_card", notify_message: "Doom!", notify_type: "card", notify_abort: false, target_ref: "self" },
        { effect_kind: "deal_damage", effect_label: "doom_kill", damage_amount: "CUR_HP + CUR_SHIELD + 50", damage_element: "physical",
          damage_ignore_affinity: true, damage_verbosity: "full", emit_status: "Doomed", emit_trigger: "creature_status_triggered", target_ref: "self" },
      ]),
      reaction_config_table: table([
        { reaction_trigger: "turn_start", reaction_source: "self", reaction_passive_mode: "force", reaction_passive_target: "self",
          condition_formula: "AE_CHARGES_DOOMED > 1", reaction_effect_ref: "doom_tick" },
        { reaction_trigger: "turn_start", reaction_source: "self", reaction_passive_mode: "force", reaction_passive_target: "self",
          condition_formula: "AE_CHARGES_DOOMED <= 1", reaction_effect_ref: "doom_fall" },
      ]),
    },
    ...extra,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const isDone = (doc) => !!doc?.getFlag?.(M, FLAG);
const mark = (doc, v = true) => doc.setFlag(M, FLAG, v);

function cloneData(srcId, { id, name, container = null, folder, img, props = {}, effects } = {}) {
  const src = game.items.get(srcId);
  if (!src) throw new Error(`donor ${srcId} missing`);
  const d = src.toObject();
  d._id = id;
  d.name = name;
  if (img) d.img = img;
  if (folder !== undefined) d.folder = folder;
  d.system.container = container;
  d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...props, name, id, uuid: `Item.${id}` };
  if (img) d.system.props.img = img;
  if (effects !== undefined) d.effects = effects;
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: "created" } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}

async function createIfMissing(data, out) {
  if (game.items.get(data._id)) { out.push(`= ${data.name} exists`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${data.name} (${data._id})`);
  return doc;
}

// A contained passive cloned from the Razor Plume shell.
function passiveData({ id, name, parent, effect_table, reaction_config_table, text }) {
  return cloneData(PASSIVE_SHELL, {
    id, name, container: parent,
    props: { effect_table, reaction_config_table, description: text, skill_description: text, isReaction: true, skill_type: "Passive", skill_target: "Self" },
  });
}

const rcOut = (o) => ({ reaction_passive_mode: "on", reaction_source: "self", reaction_trigger: "creature_will_deal_damage", ...o });

// ── 1. Doom ─────────────────────────────────────────────────────────────────
async function authorDoom(out) {
  const lib = game.items.get(DEBUFF_LIB);
  const ae = lib?.effects.get(DOOMED_AE);
  if (!ae) { out.push("! Doomed AE missing"); return; }
  if (ae.getFlag(M, FLAG)) { out.push("= Doomed countdown exists"); return; }
  await ae.update({ "duration.rounds": null, [`flags.${M}`]: { ...(ae.flags?.[M] ?? {}), ...doomFlags(), [FLAG]: true } });
  out.push("~ Doomed: 3-charge countdown, lethal on the last tick");
}

// ── 2. New items ────────────────────────────────────────────────────────────
async function authorMuramasa(out) {
  const src = game.items.get(DONOR.sword);
  const text = ul(
    "Attacks with this weapon hit harder the lower the target's HP is.",
    `When you equip this weapon, or have it equipped at the start of a conflict, you suffer ${DOOM}. When you reduce a creature to 0 HP, set your ${DOOM} duration to <strong>3</strong>.`,
    `While this weapon is equipped, nothing can cleanse or prevent your ${DOOM}. Unequipping this weapon does not remove it.`,
  );
  await createIfMissing(cloneData(DONOR.sword, {
    id: ID.muramasa, name: "Muramasa", folder: src.folder, img: ICON + "Muramasa.webp",
    props: { category: "Sword", hand_slots: "Two-handed", weapon_range: "Melee", rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "0",
      damage_bonus: "16", type_damage: "Physical", isMartial: true, item_rarity: "Legendary", item_cost: "3800", item_quantity: "1",
      isSet: false, set_name: "", refine_level: "0", refine_count: "0", description: text,
      flavor_text: flavor("A blade that is never sated. Its wielder lives on borrowed time, paid back one life at a time.") },
  }), out);
  // The uncleansable self-Doom template lives on the passive.
  const lib = game.items.get(DEBUFF_LIB);
  const base = lib.effects.get(DOOMED_AE).toObject();
  const doomAe = { ...base, _id: ID.muramasaDoom, name: "Doomed", transfer: false, disabled: false,
    duration: { ...base.duration, rounds: null },
    flags: { ...base.flags, [M]: doomFlags({ uncleansable: true, directorPermanent: true, muramasaDoom: true }) } };
  const apply = { effect_kind: "apply_ae", ae_template_ref: `Item.${ID.muramasaPsv}.ActiveEffect.${ID.muramasaDoom}`,
    ae_duplicate_mode: "replace_same_status", ignore_condition_immunity: true, target_ref: "self" };
  const data = passiveData({
    id: ID.muramasaPsv, name: "Muramasa (Passive)", parent: ID.muramasa, text,
    effect_table: table([
      { effect_kind: "adjust_damage", effect_label: "mura_bite", damage_stage: "outgoing", damage_operation: "multiply",
        damage_amount: "1 + (1 - TARGET_CURRENT_HP / max(1, TARGET_MAX_HP)) * (0.5 - 0.25 * TARGET_IS_CHAMPION)" },
      { ...apply, effect_label: "mura_doom" },
      { effect_kind: "adjust_charges", effect_label: "mura_reset", charge_ae_name: "Doomed", charge_operation: "set", charge_amount: "3", target_ref: "self" },
    ]),
    reaction_config_table: table([
      rcOut({ reaction_passive_mode: "force", reaction_requires_weapon_used: true, condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "mura_bite" }),
      { reaction_trigger: "conflict_start", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_source: "", reaction_effect_ref: "mura_doom" },
      { reaction_trigger: "creature_equips_item", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_source: "", reaction_effect_ref: "mura_doom" },
      { reaction_trigger: "creature_defeated", reaction_passive_mode: "force", reaction_source: "all", condition_formula: "CAUSE_IS_SELF == 1", reaction_effect_ref: "mura_reset" },
    ]),
  });
  data.effects = [doomAe];
  await createIfMissing(data, out);
}

async function authorStaff(out) {
  const src = game.items.get(DONOR.staff);
  await createIfMissing(cloneData(SPELL_DONOR, {
    id: ID.witsEnd, name: "Wit's End", container: ID.staff,
    img: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Epic%207/show%20-%202025-07-20T213219.279.png", // Nightmare's icon
    props: { cost: "1 Fabula Point", rolled_atr1: "WLP", rolled_atr2: "INS", damage_bonus: "0", type_damage: "dark", defense_target_type: "mdef",
      isCheck: true, isOffensiveSpell: true, skill_type: "Spell", action_command: "spell", class: "", skill_target: "One creature",
      duration: "Instantaneous", skill_range: "Range", isReaction: true, on_activate_effect_ref: "",
      description: `Deals ${DARK} damage equal to <strong>【HR + the difference between your MP percentage and the target's MP percentage】</strong>.`,
      effect_table: table([
        { effect_kind: "adjust_damage", effect_label: "wits_gap", damage_stage: "outgoing", damage_operation: "add",
          damage_amount: "round(abs(CUR_MP / max(1, MAX_MP) - TARGET_CURRENT_MP / max(1, TARGET_MAX_MP)) * 100)" },
      ]),
      reaction_config_table: table([
        rcOut({ reaction_passive_mode: "force", reaction_source_skill: "Wit's End", condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "wits_gap" }),
      ]) },
  }), out);
  const text = ul(
    "While this weapon is equipped, your base Insight die becomes <strong>d6</strong>.",
    "While you have <strong>0 MP</strong>, attacks with this weapon deal <strong>8 bonus damage</strong>.",
    `You may cast the spell 【⚡<strong>@UUID[Item.${ID.witsEnd}]{Wit's End}</strong>】`,
  );
  const staff = cloneData(DONOR.staff, {
    id: ID.staff, name: "Staff of Stupidity", folder: src.folder, img: ICON + "Staff_of_Stupidity.webp",
    props: { category: "Arcane", hand_slots: "Two-handed", weapon_range: "Ranged", rolled_atr1: "MIG", rolled_atr2: "WLP", check_bonus: "0",
      damage_bonus: "8", type_damage: "Dark", defense_target_type: "mdef", item_rarity: "Rare", item_cost: "2800", item_quantity: "1",
      isSet: false, set_name: "", refine_level: "0", refine_count: "0", description: text,
      flavor_text: flavor("Whoever carved this staff forgot what it was for halfway through. Whoever holds it forgets a little more.") },
  });
  staff.effects = [{ _id: ID.emptyHead, name: "Empty Head", img: ICON + "Staff_of_Stupidity.webp", transfer: true, disabled: false,
    changes: [{ key: "ins_base", mode: 5, priority: 30, value: "6" }], flags: { [M]: { [FLAG]: "empty-head" } } }];
  await createIfMissing(staff, out);
  await createIfMissing(passiveData({
    id: ID.staffPsv, name: "Staff of Stupidity (Passive)", parent: ID.staff, text,
    effect_table: table([{ effect_kind: "adjust_damage", effect_label: "sos_empty", damage_stage: "outgoing", damage_operation: "add", damage_amount: "8" }]),
    reaction_config_table: table([rcOut({ reaction_passive_mode: "force", reaction_requires_weapon_used: true, condition_formula: "CUR_MP == 0 && DAMAGE_IS_HP == 1", reaction_effect_ref: "sos_empty" })]),
  }), out);
}

async function authorShields(out) {
  const src = game.items.get(DONOR.shield);
  const stalwartText = ul(`You begin each conflict with ${SHIELD} equal to <strong>【5 + half your level】</strong>.`);
  await createIfMissing(cloneData(DONOR.shield, {
    id: ID.stalwart, name: "Stalwart Shield", folder: src.folder, img: ICON + "Stalwart_Shield.webp",
    props: { isMartial: true, item_def_bonus: "0", item_mdef_bonus: "0", item_rarity: "Rare", item_cost: "2500", item_quantity: "1",
      isSet: false, set_name: "", refine_level: "0", refine_count: "0", description: stalwartText,
      flavor_text: flavor("Plain, heavy and honest. It does not make you harder to hit; it makes you harder to finish.") },
  }), out);
  await createIfMissing(passiveData({
    id: ID.stalwartPsv, name: "Stalwart Shield (Passive)", parent: ID.stalwart, text: stalwartText,
    effect_table: table([{ effect_kind: "set_resource", effect_label: "stal_guard", grant_resource: "shield", grant_amount: "5 + floor(CHAR_LEVEL / 2)", target_ref: "self" }]),
    reaction_config_table: table([{ reaction_trigger: "conflict_start", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_source: "", reaction_effect_ref: "stal_guard" }]),
  }), out);

  const mirrorText = ul("Once per conflict, when a creature targets you with an offensive spell, you may negate the spell and reflect it back to the caster.");
  await createIfMissing(cloneData(DONOR.shield, {
    id: ID.mirror, name: "Mirror Shield", folder: src.folder, img: ICON + "Mirror_Shield.gif",
    props: { isMartial: false, item_def_bonus: "0", item_mdef_bonus: "2", item_rarity: "Rare", item_cost: "2800", item_quantity: "1",
      isSet: false, set_name: "", refine_level: "0", refine_count: "0", description: mirrorText,
      flavor_text: flavor("Polished until it remembers every spell ever cast at it, and returns one with interest.") },
  }), out);
  const mm = game.items.get(MIRROR_PASSIVE);
  const mmTable = foundry.utils.deepClone(mm.system.props.effect_table ?? {});
  // Same reflect chain as the Magic Mirror consumable, minus the consume step.
  for (const r of Object.values(mmTable)) {
    if (r?.effect_kind === "chain" && /mirror_spend/.test(r.chain_steps ?? "")) r.chain_steps = "mirror_redirect";
  }
  for (const [k, r] of Object.entries(mmTable)) if (r?.effect_kind === "consume_item") delete mmTable[k];
  const mmRc = foundry.utils.deepClone(mm.system.props.reaction_config_table ?? {});
  for (const r of Object.values(mmRc)) { r.reaction_max_per_round = "1"; r.reaction_max_scope = "battle"; }
  await createIfMissing(passiveData({ id: ID.mirrorPsv, name: "Mirror Shield (Passive)", parent: ID.mirror, text: mirrorText, effect_table: mmTable, reaction_config_table: mmRc }), out);
}

async function authorPhoenix(out) {
  const src = game.items.get(PHX_PARENT);
  const revive = table([
    { chain_steps: "phoenix_fx, phoenix_revive", effect_kind: "chain", effect_label: "phoenix_use" },
    { action_ref: "Item.FxShared0Revive1", effect_kind: "play_animation", effect_label: "phoenix_fx", target_ref: "action_targets" },
    { effect_kind: "set_resource", effect_label: "phoenix_revive", grant_amount: "MAX_HP", grant_resource: "hp", target_ref: "action_targets" },
  ]);
  const text = ul("Revive one <strong>KO</strong> ally and restore their HP to <strong>full</strong>.");
  await createIfMissing(cloneData(PHX_PARENT, {
    id: ID.phoenix, name: "Full Phoenix", folder: src.folder, img: ICON + "Full_Phoenix.webp",
    props: { item_rarity: "Rare", item_cost: "2000", item_quantity: "1", effect_table: revive, description: text,
      flavor_text: flavor("A whole wing of the Immortal Phoenix, still warm. One touch, and the fallen stand as if nothing happened.") },
  }), out);
  await createIfMissing(cloneData(PHX_SKILL, {
    id: ID.phoenixSkill, name: "Full Phoenix", container: ID.phoenix, img: ICON + "Full_Phoenix.webp",
    props: { effect_table: revive, description: "<p><em>Full Phoenix:</em> revive an ally to full HP.</p>" },
  }), out);
}

// ── 3. Older items ──────────────────────────────────────────────────────────
// patch: system.props changes. passive: a contained passive to add. ae: transfer AEs to add.
const OLDER = [
  { name: "Zenith Blade", props: { damage_bonus: "13" }, text: (d) => d.replace("<strong>40%</strong>", "<strong>50%</strong>"),
    passive: { id: ID.zenithPsv, name: "Zenith Blade (Passive)",
      effect_table: table([{ effect_kind: "adjust_damage", effect_label: "zen_edge", damage_stage: "outgoing", damage_operation: "multiply", damage_amount: "1.5" }]),
      reaction_config_table: table([rcOut({ reaction_passive_mode: "force", reaction_requires_weapon_used: true, condition_formula: "HAS_STATUS_CRISIS == 0 && DAMAGE_IS_HP == 1", reaction_effect_ref: "zen_edge" })]) } },
  { name: "Death Scythe", props: { item_rarity: "Uncommon" },
    text: (d) => d.includes("Weighted") ? d : d.replace("<ul>", `<ul><li><p>${WEIGHTED}</p></li>`),
    ae: [{ _id: ID.scytheImm, name: "Death Scythe: Doom immunity", transfer: true, disabled: false,
      changes: [{ key: "condition_doom", mode: 5, priority: 20, value: "aeAffinityFloor(\"IM\")" }] }],
    passive: { id: ID.scythePsv, name: "Death Scythe (Passive)",
      effect_table: table([
        { effect_kind: "chain", effect_label: "ds_hit", chain_steps: "ds_shorten, ds_floor, ds_doom" },
        { effect_kind: "adjust_charges", effect_label: "ds_shorten", condition_formula: "TARGET_AE_COUNT_DOOMED > 0", charge_ae_name: "Doomed", charge_operation: "subtract", charge_amount: "1", target_ref: "trigger_subject" },
        { effect_kind: "adjust_charges", effect_label: "ds_floor", condition_formula: "TARGET_AE_COUNT_DOOMED > 0", charge_ae_name: "Doomed", charge_operation: "floor", charge_amount: "1", target_ref: "trigger_subject" },
        { effect_kind: "apply_ae", effect_label: "ds_doom", condition_formula: "TARGET_AE_COUNT_DOOMED == 0", ae_template_ref: "Doomed", ae_duplicate_mode: "replace_same_status", target_ref: "trigger_subject" },
      ]),
      reaction_config_table: table([{ reaction_trigger: "creature_deals_damage", reaction_passive_mode: "force", reaction_source: "self", reaction_requires_weapon_used: true, condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "ds_hit" }]) } },
  { name: "Frantic Nail", props: { item_rarity: "Rare" },
    passive: { id: ID.franticPsv, name: "Frantic Nail (Passive)",
      effect_table: table([
        { effect_kind: "chain", effect_label: "fn_hit", chain_steps: "fn_panic, fn_enrage" },
        { effect_kind: "apply_ae", effect_label: "fn_panic", condition_formula: "TARGET_AE_COUNT_ENRAGED > 0", ae_template_ref: "Panic", ae_duplicate_mode: "replace", target_ref: "trigger_subject" },
        { effect_kind: "apply_ae", effect_label: "fn_enrage", condition_formula: "TARGET_AE_COUNT_ENRAGED == 0", ae_template_ref: "Enraged", ae_duplicate_mode: "replace_same_status", target_ref: "trigger_subject" },
      ]),
      reaction_config_table: table([{ reaction_trigger: "creature_deals_damage", reaction_passive_mode: "on", reaction_source: "self", reaction_requires_weapon_used: true, condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "fn_hit" }]) } },
  { name: "Kusarigama", props: { item_rarity: "Rare" },
    passive: { id: ID.kusariPsv, name: "Kusarigama (Passive)",
      effect_table: table([
        { effect_kind: "chain", effect_label: "ku_hit", chain_steps: "ku_bleed, ku_slow" },
        { effect_kind: "apply_ae", effect_label: "ku_bleed", condition_formula: "TARGET_AE_COUNT_SLOW > 0", ae_template_ref: "Bleed", ae_duplicate_mode: "replace", target_ref: "trigger_subject" },
        { effect_kind: "apply_ae", effect_label: "ku_slow", condition_formula: "TARGET_AE_COUNT_SLOW == 0", ae_template_ref: "Slow", ae_duplicate_mode: "replace_same_status", target_ref: "trigger_subject" },
      ]),
      reaction_config_table: table([{ reaction_trigger: "creature_deals_damage", reaction_passive_mode: "on", reaction_source: "self", reaction_requires_weapon_used: true, condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "ku_hit" }]) } },
  { name: "Black Mage Wand", props: { item_rarity: "Rare", item_cost: "3500" } },
  { name: "Tailwind", props: { item_rarity: "Rare" } },
  { name: "Rewinder", props: { item_rarity: "Uncommon" } },
  { name: "Gothic Lolita Dress", props: { item_rarity: "Rare", item_cost: "2500" },
    text: () => ul(`Your offensive spells that deal ${DARK} or ${POISON} damage deal <strong>5 bonus damage</strong> for each status effect on the target (up to <strong>15</strong>).`),
    passive: { id: ID.gothicPsv, name: "Gothic Lolita Dress (Passive)",
      effect_table: table([{ effect_kind: "adjust_damage", effect_label: "gl_malediction", damage_stage: "outgoing", damage_operation: "add", damage_amount: "min(TARGET_STATUS_COUNT * 5, 15)" }]),
      reaction_config_table: table([
        rcOut({ reaction_passive_mode: "force", reaction_damage_type: "dark", condition_formula: "ACTION_IS_SPELL == 1 && DAMAGE_IS_HP == 1 && TARGET_STATUS_COUNT > 0", reaction_effect_ref: "gl_malediction" }),
        rcOut({ reaction_passive_mode: "force", reaction_damage_type: "poison", condition_formula: "ACTION_IS_SPELL == 1 && DAMAGE_IS_HP == 1 && TARGET_STATUS_COUNT > 0", reaction_effect_ref: "gl_malediction" }),
      ]) } },
  { name: "Curse Collector",
    passive: { id: ID.curseCollPsv, name: "Curse Collector (Passive)",
      effect_table: table([{ effect_kind: "adjust_damage", effect_label: "cc_collect", damage_stage: "outgoing", damage_operation: "add", damage_amount: "STATUS_COUNT * 3" }]),
      reaction_config_table: table([rcOut({ reaction_passive_mode: "force", condition_formula: "STATUS_COUNT > 0 && DAMAGE_IS_HP == 1", reaction_effect_ref: "cc_collect" })]) } },
];
// Gacha pieces priced at the Rare budget (equipment design metric, 2026-11-08 ruling).
const GACHA_RARE = ["Kindred Spirit", "Hunter's Mantle", "Hunter Boots", "Kindred Feather", "Luchador Gloves", "Luchador Pant", "Luchador Mask"];

const worldItem = (name) => game.items.find((i) => i.name === name && !i.system?.container && i.folder?.name !== "CSB - Embedded Items Folder - DO NOT RENAME OR REMOVE");

async function updateOlder(out) {
  for (const spec of OLDER) {
    const item = worldItem(spec.name);
    if (!item) { out.push(`! ${spec.name} not found`); continue; }
    if (isDone(item)) { out.push(`= ${spec.name} already updated`); continue; }
    const patch = {};
    for (const [k, v] of Object.entries(spec.props ?? {})) patch[`system.props.${k}`] = v;
    if (spec.text) patch["system.props.description"] = spec.text(String(item.system.props.description ?? ""));
    if (Object.keys(patch).length) await item.update(patch);
    if (spec.ae?.length) {
      const missing = spec.ae.filter((a) => !item.effects.get(a._id));
      if (missing.length) await item.createEmbeddedDocuments("ActiveEffect", missing, { keepId: true });
    }
    if (spec.passive) {
      await createIfMissing(passiveData({ ...spec.passive, parent: item.id, text: patch["system.props.description"] ?? item.system.props.description }), out);
    }
    await mark(item);
    // Every actor copy carries the same words and numbers (item text convention).
    const copyPatch = Object.fromEntries(Object.entries(patch));
    let copies = 0;
    for (const a of game.actors) {
      const same = a.items.filter((i) => i.name === spec.name && !i.system?.container);
      for (const c of same) { if (Object.keys(copyPatch).length) await c.update(copyPatch); copies++; }
    }
    out.push(`~ ${spec.name}${copies ? ` (+${copies} actor cop${copies === 1 ? "y" : "ies"} text/props)` : ""}`);
  }
  for (const name of GACHA_RARE) {
    const item = worldItem(name);
    if (!item || isDone(item)) continue;
    await item.update({ "system.props.item_rarity": "Rare" });
    await mark(item);
    out.push(`~ ${name} → Rare`);
  }
}

// ── 4. Hako restock ─────────────────────────────────────────────────────────
// [name, price, qty]
const ROSTER = [
  ["Zenith Blade", 3000, 1], ["Aenigma of Adaptation", 3000, 1], ["Tommy Gun", 2500, 1], ["Frantic Nail", 2450, 1],
  ["Death Scythe", 2000, 1], ["Black Mage Wand", 3500, 1], ["Lionheart", 3000, 1], ["Staff of Stupidity", 2800, 1],
  ["Muramasa", 3800, 1], ["Kusarigama", 2200, 1],
  ["Gothic Lolita Dress", 2500, 1], ["Biker Suit", 2500, 1], ["Dominatrix Leotard", 2500, 1], ["Curse Collector", 3500, 1],
  ["Stalwart Shield", 2500, 1], ["Mirror Shield", 2800, 1],
  ["Rewinder", 2200, 1], ["Cursed Ivory Statue", 3000, 1], ["Little Devil", 2800, 1], ["Lucky Egg", 2600, 1], ["Witch Hat", 2000, 1],
  ["Vaccine", 1000, 5], ["Full Phoenix", 2000, 3], ["Magic Mirror", 1000, 1],
  ["Terrarium: Camp", 800, 3], ["Terrarium: Healing", 500, 3], ["Terrarium: Gathering", 400, 3], ["Terrarium: Random Battle", 300, 3], ["Terrarium: Blank", 300, 3],
  ["Ironwood Rod", 1500, 1], ["Swiftline Rod", 1500, 1], ["Seer's Rod", 1500, 1], ["Stillwater Rod", 1500, 1],
];
const ROD_IDS = { "Ironwood Rod": "FishRodIronwood1", "Swiftline Rod": "FishRodSwiftlin1", "Seer's Rod": "FishRodSeers0001", "Stillwater Rod": "FishRodStillwat1" };

function subtree(rootId) {
  const out = [];
  const walk = (id) => { for (const c of game.items.filter((i) => i.system?.container === id)) { out.push(c); walk(c.id); } };
  walk(rootId);
  return out;
}

async function restockHako(out) {
  const hako = game.actors.get(HAKO);
  if (!hako) { out.push("! Hako actor missing"); return; }
  if (hako.getFlag(M, FLAG)) { out.push("= Hako already restocked"); return; }
  // Clear the old stock: top-level items one at a time (CSB cascades children).
  for (const it of hako.items.filter((i) => !i.system?.container)) {
    if (hako.items.get(it.id)) await it.delete();
  }
  for (const it of [...hako.items]) if (hako.items.get(it.id)) await it.delete();
  let n = 0;
  for (const [name, price, qty] of ROSTER) {
    const src = ROD_IDS[name] ? game.items.get(ROD_IDS[name]) : worldItem(name);
    if (!src) { out.push(`! roster: ${name} not found`); continue; }
    const data = src.toObject(); delete data._id;
    data.system.container = null;
    data.system.props = { ...data.system.props, item_cost: String(price), item_quantity: String(qty) };
    const [parent] = await hako.createEmbeddedDocuments("Item", [data]);
    // Copy the whole contained tree, re-pointing each child at its new parent.
    const map = new Map([[src.id, parent.id]]);
    for (const child of subtree(src.id)) {
      const cd = child.toObject(); delete cd._id;
      cd.system.container = map.get(child.system.container) ?? parent.id;
      const [made] = await hako.createEmbeddedDocuments("Item", [cd]);
      map.set(child.id, made.id);
    }
    n++;
  }
  await hako.setFlag(M, FLAG, "restocked-v1");
  out.push(`~ Hako restocked: ${n}/${ROSTER.length} listings`);
}

// ── Entry ────────────────────────────────────────────────────────────────────
export async function migrate(game, log = () => {}) {
  const out = [];
  await authorDoom(out);
  await authorMuramasa(out);
  await authorStaff(out);
  await authorShields(out);
  await authorPhoenix(out);
  await updateOlder(out);
  await restockHako(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
