/**
 * Migration: 2026-11-25-trio-elite-steals  (one Legendary steal per trio elite, 100%)
 * ---------------------------------------------------------------------------
 * User-approved design 2026-11-25 (tuning page https://claude.ai/artifact/XxaVrV6RTh3vQwrq1S6mDL,
 * picks pasted back and approved):
 *
 *   Asura Blade (Asura)       Legendary 4000z · Sword · Two-handed · Melee · Martial
 *                             DEX+MIG +0 · HR+10 Physical.
 *                             When you attack: optional prompt, spend 10 MP before the roll
 *                             (lost on a miss) → the attack's damage type becomes Air / Bolt /
 *                             Fire / Ice. Grants the skill Asura Strike.
 *   Asura Strike (granted)    30 MP · All enemies · Chain 4 seek + Pierce · each strike its own
 *                             DEX+MIG check vs M.DEF · HR+10 · Bolt → Fire → Ice → Air
 *                             (the monster move's engine: flags.chainElements; no Mark reset).
 *   Rakshasa Armor (Rakshasa) Legendary 3800z · Martial · DEF 13 / M.DEF 12 (fixed).
 *                             Attacks and skills with Bow / Flail / Sword / Thrown weapons:
 *                             +5 extra damage, 10 in Crisis (flat on purpose: % bonuses compound).
 *   Mukuta (Deva)             Legendary 4000z accessory · Max HP +12% · Max MP +12% ·
 *                             6% more damage.
 *
 * Steal tables: each elite gets one row at 100% (boss-style). Asura's placeholder
 * Demongrin row + catalog entry are replaced (the embedded Demongrin item stays on the
 * actor). The monster holds a plain shell copy (no children, unequipped) whose
 * _stats.compendiumSource points at the world item; a steal resolves to the world item
 * and copies its contained skill + passive (skill-effects.js resolveStealSourceItem).
 * Unlinked tokens whose delta overrides the steal props are updated the same way.
 *
 * Engine: ACTION_IS_SKILL (skill-formulas.js, same commit) for Rakshasa Armor's gate.
 *
 * SEED-ONLY: new documents use fixed ids ("TrEl…") and are skipped when they exist;
 * the steal-table step is gated by flags.fabula-ultima-companion.trioSteals on each actor.
 */

export const key = "2026-11-25-trio-elite-steals";
export const description = "Trio elite steals: Asura Blade (+ Asura Strike) from Asura, Rakshasa Armor from Rakshasa, Mukuta from Deva — 100% steal rows.";

const M = "fabula-ultima-companion";
const FLAG = "trioSteals";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";

// Donors (cloned for the CSB template + prop shape, then overridden).
const DONOR = {
  weapon: "jGvUQbTDGWuOYOrf",    // Balmung (Legendary 2H Sword)
  armor: "Y7JL7P9hbWipwb90",     // Dragonic Scalemail (martial armor, Armor DEF/MDEF effects)
  accessory: "DzXNAIk2nGsnrNmU", // Warrior Emblem
  passive: "r5YlGxjwTfvpt5yM",   // Razor Plume (Passive) — passive shell
  skill: "F5puT71npNWuUap8",     // Sverðgramr — PC Active skill with a check + damage
};
const ACTOR = { asura: "0AwQ7wEDz4ISA9mA", rakshasa: "Rk5haXsaDemonAAA", deva: "amxILxU7mqQ0jKhZ" };
const DEMONGRIN_LOOT = "ll1QCriD5ganoy1h";

const ID = {
  blade: "TrElAsuraBlade01", bladePsv: "TrElAsuraBldPsv1", strike: "TrElAsuraStrike1",
  armor: "TrElRakshArmor01", armorPsv: "TrElRakshArmPsv1",
  crown: "TrElMukutaCrown1", crownPsv: "TrElMukutaPsv001", crownHp: "TrElMukutaHpAE01", crownMp: "TrElMukutaMpAE01",
  edge: { air: "TrElEdgeAirAE001", bolt: "TrElEdgeBoltAE01", fire: "TrElEdgeFireAE01", ice: "TrElEdgeIceAE001" },
  loot: { asura: "TrElAsuraLoot001", rakshasa: "TrElRakshLoot001", deva: "TrElDevaLoot0001" },
};
const ICON = {
  blade: FORGE + "Item%20Icon/Weapon/Ys/Dunamis_Edge.webp",
  armor: FORGE + "Item%20Icon/Armor/Ys/Ys9-Battle_Armor.webp",
  crown: FORGE + "Item%20Icon/Armor/FF%20Brave%20Exvius/Icon-Imperial_Crown.webp",
};

// ── Styled links (house convention; same markup as the Sonic Katar / Gunblade migration) ──
const A_STYLE = "box-sizing: border-box; user-select: text; scrollbar-width: thin; scrollbar-color: rgb(93, 20, 43) rgba(0, 0, 0, 0); cursor: pointer; --content-link-background: rgba(0, 0, 0, 0.1); background-image: none !important; background-position: initial !important; background-size: initial !important; background-repeat: initial !important; background-attachment: initial !important; background-origin: initial !important; background-clip: initial !important; background-color: rgb(102, 102, 102); padding: 0px !important; border: none !important; border-radius: 2px; white-space: nowrap; word-break: break-all; color: {COLOR}; font-weight: bold; text-decoration: underline; display: inline-flex; align-items: center; position: relative; top: 2px; {SHADOW}font-family: Signika, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px;";
const styledLink = (type, id, label, { color = "inherit", glow = null } = {}) => {
  const style = A_STYLE.replace("{COLOR}", color).replace("{SHADOW}", glow ? `text-shadow: ${glow} 0px 0px 4px; ` : "");
  const tip = type === "Item" ? "Equippable Item Item" : "Journal Entry";
  return `<span style="text-decoration: underline;"><span style="font-family: Signika, sans-serif"><a class="content-link" draggable="true" data-link="" data-uuid="${type}.${id}" data-id="${id}" data-type="${type}" data-tooltip="${tip}" aria-describedby="tooltip" style="${style}"><strong><span style="text-decoration: underline;">${label}</span></strong></a></span></span>`;
};
const J = (id, label) => styledLink("JournalEntry", id, label, { color: "rgb(25, 24, 19)" });
const AIR = styledLink("Item", "imkMQLnCLaFbaS6Y", "Air", { glow: "rgb(168, 255, 187)" });
const BOLT = styledLink("Item", "5XAuMMbDPlLzhJLw", "Bolt", { glow: "rgb(215, 169, 255)" });
const FIRE = styledLink("Item", "0sFCVCoM6FRrQP2f", "Fire", { glow: "rgb(255, 174, 0)" });
const ICE = styledLink("Item", "Osq3NN3QCtiW7otU", "Ice", { glow: "rgb(166, 227, 255)" });
const CRISIS = J("GJevbCPM8cffm1QM", "Crisis");
const PIERCE = J("2hNU23YLpCcZCCmf", "Pierce");
const CHAIN = J("ChnStrikeKeyw0rd", "Chain");
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const em = (t) => `<p><em>${t}</em></p>`;
const B = (s) => `<strong>${s}</strong>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));

// ── Text (Genshin mode, Option A; approved on the tuning page) ──────────────
const BLADE_TEXT = ul(
  `When you attack, you may spend ${B("10 MP")} to change its damage type to ${AIR}, ${BOLT}, ${FIRE} or ${ICE}.`,
  `You may perform the skill 【💥<strong>@UUID[Item.${ID.strike}]{Asura Strike}</strong>】`,
);
const BLADE_FLAVOR = em("Asura's own blade, tempered in every element it ever collected. It answers to whichever one its wielder calls.");
const STRIKE_TEXT = ul(
  `${CHAIN} ${B("4")} · ${PIERCE}`,
  `Four blades strike in turn: ${BOLT}, ${FIRE}, ${ICE}, then ${AIR}. Each strike hits a random enemy, makes its own Accuracy Check and deals ${B("【HR + 10】")} damage of its element.`,
  "A strike aimed at a fallen enemy moves to another.",
);
const ARMOR_TEXT = ul(
  `Your attacks and skills with ${B("Bow")}, ${B("Flail")}, ${B("Sword")} or ${B("Thrown")} weapons deal ${B("5")} extra damage.`,
  `In ${CRISIS}, ${B("10")} instead.`,
);
const ARMOR_FLAVOR = em("Rakshasa's war harness, with a hook for each of its four arms. It still remembers the weight of every weapon.");
const CROWN_TEXT = ul(`Max HP ${B("+12%")}.`, `Max MP ${B("+12%")}.`, `You deal ${B("6%")} more damage.`);
const CROWN_FLAVOR = em("Deva's crown. Every jewel weighs exactly the same, so it never tips.");

// ── Helpers (Sonic Gunblade / Lionheart pattern) ─────────────────────────────
function cloneData(srcId, { id, name, container = null, img, props = {}, effects, folderOf, flags = {} } = {}) {
  const src = game.items.get(srcId);
  if (!src) throw new Error(`donor ${srcId} missing`);
  const d = src.toObject();
  d._id = id;
  d.name = name;
  if (img) d.img = img;
  if (folderOf) d.folder = game.items.get(folderOf)?.folder?.id ?? d.folder ?? null;
  d.system.container = container;
  d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...props, name, id, uuid: `Item.${id}` };
  if (img) d.system.props.img = img;
  d.effects = effects !== undefined ? effects : (d.effects ?? []);
  const mine = { ...(d.flags?.[M] ?? {}), ...flags, [FLAG]: "created" };
  delete mine.draftAutomation;
  d.flags = { ...(d.flags ?? {}), [M]: mine };
  delete d.flags.fucompanion; // item-migrator backup of the donor
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}
async function createIfMissing(data, out) {
  if (game.items.get(data._id)) { out.push(`= ${data.name} exists`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${data.name} (${data._id})`);
  return doc;
}
const freshEffect = (base) => {
  const e = foundry.utils.deepClone(base);
  delete e._stats;
  if (e.flags?.["custom-system-builder"]) {
    delete e.flags["custom-system-builder"].originalId;
    delete e.flags["custom-system-builder"].originalParentId;
    delete e.flags["custom-system-builder"].originalUuid;
  }
  return e;
};
const markerEffect = (id, name, img) => ({
  _id: id, name, img, transfer: false, disabled: false, changes: [], statuses: [], description: "",
  duration: {}, origin: null, sort: 0, tint: "#ffffff", type: "base", system: { tags: [] },
  flags: {
    "custom-system-builder": { isFromTemplate: false },
    [M]: { category: "buff", directorPermanent: true, lifetimeMode: "persistent_counter" },
    statuscounter: { config: { dataSource: "flags.statuscounter.value", multiplyEffect: true, type: "default" }, value: 1, visible: false },
  },
});
const pctEffect = (id, name, key, mult) => ({
  _id: id, name, img: ICON.crown, transfer: true, disabled: false, statuses: [], description: "",
  duration: {}, origin: null, sort: 0, tint: "#ffffff", type: "base", system: {},
  // MULTIPLY after every flat add (priority 50, as Crippled); the round-up hook keeps it whole.
  changes: [{ key, mode: 1, priority: 50, value: `\${isEquipped ? ${mult} : 1}$` }],
  flags: {
    "custom-system-builder": { isFromTemplate: false },
    [M]: { roundUp: [key] },
    statuscounter: { config: { multiplyEffect: true, type: "default" }, value: 1, visible: false },
  },
});

// ── Asura Blade ──────────────────────────────────────────────────────────────
const ELS = ["air", "bolt", "fire", "ice"];
const CAP = { air: "Air", bolt: "Bolt", fire: "Fire", ice: "Ice" };
const EDGE_NAME = (el) => `Asura ${CAP[el]} Edge`;
const EDGE_COUNT = (el) => `AE_COUNT_ASURA_${el.toUpperCase()}_EDGE`;
const NO_EDGE = ELS.map(EDGE_COUNT).join(" + ") + " == 0";

function bladeData() {
  return cloneData(DONOR.weapon, {
    id: ID.blade, name: "Asura Blade", img: ICON.blade, folderOf: DONOR.weapon,
    props: {
      item_type: "weapon", category: "Sword", hand_slots: "Two-handed", weapon_range: "Melee", isMartial: true,
      rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "0", damage_bonus: "10", type_damage: "Physical",
      defense_target_type: "", action_keywords: "", skill_target: "One Enemy",
      item_rarity: "Legendary", item_cost: "4000", item_quantity: "1", isEquipped: false, isUnique: false,
      isSet: false, set_name: "", refine_level: "0", refine_count: "0",
      description: BLADE_TEXT, flavor_text: BLADE_FLAVOR,
    },
  });
}
function bladePassiveData() {
  const rows = [
    { effect_kind: "open_action_menu", effect_label: "ab_offer", menu_title: "Asura Blade",
      menu_subtitle: "Spend 10 MP: this attack's damage type becomes…", menu_pick_count: "1",
      menu_option_labels: "Air|Bolt|Fire|Ice",
      menu_option_descriptions: "Damage becomes Air|Damage becomes Bolt|Damage becomes Fire|Damage becomes Ice",
      menu_option_refs: ELS.map((e) => `ab_${e}`).join(",") },
    { effect_kind: "consume_resource", effect_label: "ab_pay", consume_resource: "mp", consume_amount: "10", on_empty: "abort", target_ref: "self" },
  ];
  for (const el of ELS) {
    rows.push(
      { effect_kind: "chain", effect_label: `ab_${el}`, menu_label: CAP[el], chain_steps: `ab_pay, ab_mk_${el}` },
      { effect_kind: "apply_ae", effect_label: `ab_mk_${el}`, ae_template_ref: `Item.${ID.bladePsv}.ActiveEffect.${ID.edge[el]}`,
        ae_duplicate_mode: "replace", target_ref: "self" },
      { effect_kind: "change_damage_element", effect_label: `ab_el_${el}`, change_element: el },
      { effect_kind: "remove_ae", effect_label: `ab_clr_${el}`, ae_template_ref: EDGE_NAME(el), count: "all", include_persistent: true, target_ref: "self" },
    );
  }
  const rc = [
    // Before the roll: the optional prompt (pay + pick). The MP is spent even if the attack misses.
    { reaction_trigger: "creature_performs_action", reaction_passive_mode: "ask", reaction_source: "self",
      condition_formula: `ACTION_IS_ATTACK == 1 && CUR_MP >= 10 && ${NO_EDGE}`, reaction_effect_ref: "ab_offer" },
  ];
  for (const el of ELS) {
    rc.push(
      { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self",
        condition_formula: `${EDGE_COUNT(el)} > 0 && ACTION_IS_ATTACK == 1 && DAMAGE_IS_HP == 1`, reaction_effect_ref: `ab_el_${el}` },
      { reaction_trigger: "creature_completes_action", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_source: "self",
        condition_formula: `${EDGE_COUNT(el)} > 0`, reaction_effect_ref: `ab_clr_${el}` },
      { reaction_trigger: "conflict_end", reaction_passive_mode: "force", reaction_passive_target: "self",
        condition_formula: `${EDGE_COUNT(el)} > 0`, reaction_effect_ref: `ab_clr_${el}` },
    );
  }
  return cloneData(DONOR.passive, {
    id: ID.bladePsv, name: "Asura Blade (Passive)", container: ID.blade,
    effects: ELS.map((el) => markerEffect(ID.edge[el], EDGE_NAME(el), ICON.blade)),
    props: {
      description: BLADE_TEXT, skill_description: BLADE_TEXT, isReaction: true, skill_type: "Passive", skill_target: "Self",
      effect_table: table(rows), reaction_config_table: table(rc),
    },
  });
}
function strikeData() {
  const sd = `<p><strong>Cost:</strong> 30 MP</p><p><strong>Target:</strong> All enemies</p><p><strong>Check:</strong> 【DEX】 + 【MIG】 vs Magic Defense</p>${STRIKE_TEXT}`;
  return cloneData(DONOR.skill, {
    id: ID.strike, name: "Asura Strike", container: ID.blade, img: ICON.blade,
    flags: { chainElements: ["bolt", "fire", "ice", "air"] },
    props: {
      skill_type: "Active", cost: "30 MP", skill_target: "All Enemy", duration: "Instantaneous", skill_range: "Melee",
      isCheck: true, rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "0", damage_bonus: "10",
      // strike 1 IS the card, so the card's own type = the first element (chain-plan.js)
      type_damage: "Bolt", defense_target_type: "mdef", action_keywords: "pierce, chain 4 seek",
      on_activate_effect_ref: "", effect_table: {}, reaction_config_table: {},
      animation_script: "", skill_animation_mode: "default",
      description: STRIKE_TEXT, skill_description: sd,
    },
  });
}

// ── Rakshasa Armor ───────────────────────────────────────────────────────────
const CATS = ["BOW", "FLAIL", "SWORD", "THROWN"];
const USED = CATS.map((c) => `USED_WEAPON_CATEGORY_IS_${c}`).join(" + ");
const HELD = CATS.map((c) => `HAS_WEAPON_CATEGORY_${c}`).join(" + ");
function armorData() {
  const donor = game.items.get(DONOR.armor);
  const keep = (donor?.effects?.contents ?? []).filter((e) => e.name === "Armor DEF" || e.name === "Armor MDEF").map((e) => freshEffect(e.toObject()));
  return cloneData(DONOR.armor, {
    id: ID.armor, name: "Rakshasa Armor", img: ICON.armor, folderOf: DONOR.armor, effects: keep,
    props: {
      item_type: "armor", isMartial: true, item_baseDef: "13", item_baseMdef: "12", item_def_bonus: "0", item_mdef_bonus: "0",
      item_rarity: "Legendary", item_cost: "3800", item_quantity: "1", isEquipped: false, isUnique: false,
      isSet: false, set_name: "", refine_level: "0", refine_count: "0",
      description: ARMOR_TEXT, flavor_text: ARMOR_FLAVOR,
    },
  });
}
function armorPassiveData() {
  return cloneData(DONOR.passive, {
    id: ID.armorPsv, name: "Rakshasa Armor (Passive)", container: ID.armor, effects: [],
    props: {
      description: ARMOR_TEXT, skill_description: ARMOR_TEXT, isReaction: true, skill_type: "Passive", skill_target: "Self",
      effect_table: table([
        { effect_kind: "adjust_damage", effect_label: "rk_bonus", damage_stage: "outgoing", damage_operation: "add", damage_amount: "5 + 5 * HAS_STATUS_CRISIS" },
      ]),
      reaction_config_table: table([
        // An attack swung with one of the four, or a (non-spell) skill while holding one.
        { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self",
          condition_formula: `DAMAGE_IS_HP == 1 && ((ACTION_IS_ATTACK == 1 && ${USED} > 0) || (ACTION_IS_SKILL == 1 && ${HELD} > 0))`,
          reaction_effect_ref: "rk_bonus" },
      ]),
    },
  });
}

// ── Mukuta ───────────────────────────────────────────────────────────────────
function crownData() {
  return cloneData(DONOR.accessory, {
    id: ID.crown, name: "Mukuta", img: ICON.crown, folderOf: DONOR.accessory,
    effects: [pctEffect(ID.crownHp, "Mukuta (Max HP)", "max_hp", 1.12), pctEffect(ID.crownMp, "Mukuta (Max MP)", "max_mp", 1.12)],
    props: {
      item_type: "accessory", item_rarity: "Legendary", item_cost: "4000", item_quantity: "1", isEquipped: false, isUnique: false,
      isSet: false, set_name: "", description: CROWN_TEXT, flavor_text: CROWN_FLAVOR,
    },
  });
}
function crownPassiveData() {
  return cloneData(DONOR.passive, {
    id: ID.crownPsv, name: "Mukuta (Passive)", container: ID.crown, effects: [],
    props: {
      description: CROWN_TEXT, skill_description: CROWN_TEXT, isReaction: true, skill_type: "Passive", skill_target: "Self",
      effect_table: table([
        { effect_kind: "adjust_damage", effect_label: "mk_bonus", damage_stage: "outgoing", damage_operation: "multiply", damage_amount: "1.06" },
      ]),
      reaction_config_table: table([
        { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self",
          condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "mk_bonus" },
      ]),
    },
  });
}

// ── Steal tables ─────────────────────────────────────────────────────────────
const STEALS = [
  { who: "asura", actorId: ACTOR.asura, itemId: ID.blade, lootId: ID.loot.asura, dropKeys: [DEMONGRIN_LOOT] },
  { who: "rakshasa", actorId: ACTOR.rakshasa, itemId: ID.armor, lootId: ID.loot.rakshasa, dropKeys: [] },
  { who: "deva", actorId: ACTOR.deva, itemId: ID.crown, lootId: ID.loot.deva, dropKeys: [] },
];
function stealPatch(actor, s, item) {
  const p = actor.system?.props ?? {};
  const patch = {
    [`system.props.stealable_loot.${s.lootId}`]: {
      id: "${item.id}", name: item.name, roll: "",
      loot_description: item.system?.props?.description ?? "",
      uuid: `Actor.${s.actorId}.Item.${s.lootId}`,
    },
  };
  for (const k of s.dropKeys) if (p.stealable_loot?.[k]) patch[`system.props.stealable_loot.-=${k}`] = null;
  // One row at 100%: delete every old row key, then write row 0.
  for (const k of Object.keys(p.steal_percentage_table ?? {})) if (k !== "0") patch[`system.props.steal_percentage_table.-=${k}`] = null;
  patch["system.props.steal_percentage_table.0"] = { $deleted: false, loot_id: item.name, loot_percentage: "100" };
  return patch;
}
async function wireSteals(out) {
  for (const s of STEALS) {
    const actor = game.actors.get(s.actorId);
    const item = game.items.get(s.itemId);
    if (!actor || !item) { out.push(`! ${s.who}: actor or item missing`); continue; }
    if (!actor.items.get(s.lootId)) {
      const d = item.toObject();
      d._id = s.lootId;
      d.system.container = null;
      d.system.props.isEquipped = false;
      d._stats = { ...(d._stats ?? {}), compendiumSource: `Item.${s.itemId}` };
      await actor.createEmbeddedDocuments("Item", [d], { keepId: true });
      out.push(`+ ${actor.name}: loot shell ${item.name}`);
    }
    if (actor.getFlag(M, FLAG)) { out.push(`= ${actor.name}: steal table already set`); continue; }
    await actor.update(stealPatch(actor, s, item));
    await actor.setFlag(M, FLAG, true);
    out.push(`~ ${actor.name}: steal ${item.name} 100%`);
    // Unlinked tokens whose delta carries its own copy of the steal props.
    for (const scene of game.scenes ?? []) {
      for (const t of scene.tokens ?? []) {
        if (t.actorLink || t.actorId !== s.actorId || !t.actor) continue;
        const dp = t.delta?.system?.props ?? {};
        if (dp.stealable_loot === undefined && dp.steal_percentage_table === undefined) continue;
        await t.actor.update(stealPatch(t.actor, s, item));
        out.push(`~ ${scene.name} / ${t.name}: token steal props synced`);
      }
    }
  }
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await createIfMissing(bladeData(), out);
  await createIfMissing(bladePassiveData(), out);
  await createIfMissing(strikeData(), out);
  await createIfMissing(armorData(), out);
  await createIfMissing(armorPassiveData(), out);
  await createIfMissing(crownData(), out);
  await createIfMissing(crownPassiveData(), out);
  await wireSteals(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
