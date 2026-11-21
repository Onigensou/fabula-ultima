/**
 * Migration: 2026-11-21-warden-hawk-author  (Warden of the Wilds set + Spirit Hawk)
 * ---------------------------------------------------------------------------
 * User-approved 2026-11-21. The four gacha pieces were text-only; this makes
 * them work, gives the Spirit Hawk a real kit, and adds the set bonuses.
 * (Rarity → Rare already happened in 2026-11-21-hako-ch4-content.)
 *
 *   1. Spirit Hawk (Actor GnEmdc02BDDTmeaU) moves onto the modern NPC sheet
 *      (King Gorger's template + shared layout, props blanked by rule) and gets:
 *        Talon Rake (basic attack) · Dive Strike (the swoop) · Spirit Bond
 *        (companion rules + owner-level scaling + the set bonuses read off its
 *        owner) · Flying · an action pattern. A "Spirit Hawk" marker effect on
 *        the actor lets gear find it (ANY_TARGET_HAS_ / AE_COUNT_SPIRIT_HAWK).
 *   2. Hunter's Mark becomes a real effect (Debuff library): the next ATTACK
 *      that targets the creature gets −3 to its DEF (= +3 Accuracy), then it
 *      is spent (adjust_defense + consume_carrier_charge, engine feat/warden-hawk).
 *   3. Hunter's Mantle: conflict-start companion (summon_kind "companion" —
 *      the one-companion gate in shared/companion-rule.js) + a contained
 *      Summon Spirit Hawk (20 MP; unavailable while you have a companion).
 *      Kindred Spirit: Snipe 20 → the hawk's free Dive Strike on the target.
 *      Kindred Feather: Protect (Spirit Hawk) (its +1 Accuracy effect already existed).
 *      Hunter Boots: unchanged (its +2 tracking check_buff already existed; no
 *      hazard-halving key exists in the dungeon or conflict hazard code).
 *   4. Equipment Set "Warden of the Wilds": 2pc Marked Prey · 3pc Keen Talons ·
 *      4pc Twin Dive — text-only owner skills the hawk reads through
 *      SUMMONER_SKILL_LEVEL_<NAME>.
 *
 * SEED-ONLY: new documents use fixed ids ("HkWd…") and are skipped when they
 * exist; edits to existing documents are gated by
 * `flags.fabula-ultima-companion.wardenHawk` on that document.
 */

export const key = "2026-11-21-warden-hawk-author";
export const description = "Warden of the Wilds: Spirit Hawk kit + companion, Hunter's Mark effect, Mantle/Kindred Spirit/Feather automation, set bonuses.";

const M = "fabula-ultima-companion";
const FLAG = "wardenHawk";

// ── In-world ids ─────────────────────────────────────────────────────────────
const HAWK = "GnEmdc02BDDTmeaU";
const KG = "A8vBJMBvMT9ON8O4";                 // King Gorger — modern companion sheet donor (read only)
const FIRE_SLIME = "Q2SuQSgrAC2dZR2Y";
const TACKLE = "Jm8zStHxlN560HcV";              // Fire Slime's clean NPC Attack
const KG_FLYING = "5VtEaXjywcgfR9Yx";           // King Gorger's Flying passive (deriveStatus)
const PASSIVE_SHELL = "r5YlGxjwTfvpt5yM";       // Razor Plume (Passive)
const PROTECT = "YBTRLqaFzBFu5xyt";             // Protect (contained copy in The Selfless)
const PROTECT_LIB = "MZXmnywINICmx7Ua";         // Protect (Guardian library)
const SET_DONOR = "ykiMgQjWE6X92oc1";           // Milky Holstein — Equipment Set
const SET_SKILL_DONOR = "Me3zQvIEF8Qs1rJh";     // Soothing Cream (set bonus skill)
const DEBUFF_LIB = "XVOWOq9oUmEECGrU";
const EMBED_FOLDER = "ft3358qUh5ZDldYQ";        // CSB embedded-items folder (contained skills)
const PIECE = {
  spirit: "aTVhiVRcHZpMinbg",  // Kindred Spirit (bow)
  mantle: "09KjioTnamwnRFv4",  // Hunter's Mantle (armor)
  boots: "duaQp4cjNOboR9Gk",   // Hunter Boots (accessory)
  feather: "Z4juGssM2ArmX7Vq", // Kindred Feather (accessory)
};
const SUMMON_SKILL = "b6o08227mQqMU33t";        // Summon Spirit Hawk (library)
const HUNTERS_MARK_ITEM = "D6IehPsp6h7srIJH";   // keyword item the set text links
const SET_NAME = "Warden of the Wilds";

// ── New document ids (16 chars, stable) ──────────────────────────────────────
const ID = {
  setDef: "HkWdWardenSetDef", prey: "HkWdMarkedPrey01", keen: "HkWdKeenTalons01", twin: "HkWdTwinDive0001",
  markAe: "HkWdHuntMarkAE01",
  mantlePsv: "HkWdMantlePsv001", mantleSummon: "HkWdMantleSumm01",
  spiritPsv: "HkWdKSpiritPsv01",
  featherProtect: "HkWdFeathProtect",
  talon: "HkWdHawkTalon001", dive: "HkWdHawkDive0001", bond: "HkWdHawkBond0001",
  flight: "HkWdHawkFlight01", flightAe: "HkWdHawkFlyAE001", marker: "HkWdHawkMarkAE01",
};
for (const [k, v] of Object.entries(ID)) if (!/^[A-Za-z0-9]{16}$/.test(v)) throw new Error(`warden-hawk: bad id ${k}=${v}`);

// ── Text helpers (plain content-links, the house form in item text) ─────────
const J = (id, label) => `<a class="content-link" data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry">${label}</a>`;
const I = (id, label) => `<a class="content-link" data-uuid="Item.${id}" data-id="${id}" data-type="Item">${label}</a>`;
const HAWK_LINK = `<a class="content-link" data-uuid="Actor.${HAWK}" data-id="${HAWK}" data-type="Actor">Spirit Hawk</a>`;
const PHYSICAL = I("XpKZuGo3VmT0TlTu", "<strong>Physical</strong>");
const CRISIS = J("GJevbCPM8cffm1QM", "Crisis");
const COMBO = J("noUOPxPoZq65yYxV", "Combo");
const MARK = I(HUNTERS_MARK_ITEM, "Hunter's Mark");
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const flavor = (t) => `<p><em>${t}</em></p>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));

const isDone = (doc) => !!doc?.getFlag?.(M, FLAG);
const mark = (doc, v = true) => doc.setFlag(M, FLAG, v);

// Generic action icons (💥 Skill folder templates), with a safe fallback.
function iconOf(name, fallback) {
  const it = game.items.find((i) => i.name === name && /skill/i.test(i.folder?.name ?? "") && !i.system?.container);
  const img = it?.img;
  return img && !/^icons\/svg\//.test(img) ? img : fallback;
}

function cloneItem(src, { id, name, container = null, folder, img, props = {}, effects } = {}) {
  if (!src) throw new Error(`donor for ${name} missing`);
  const d = src.toObject();
  d._id = id;
  d.name = name;
  if (img) d.img = img;
  if (folder !== undefined) d.folder = folder;
  d.system.container = container;
  d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...props, name, id, uuid: `Item.${id}` };
  if (img) d.system.props.img = img;
  d.effects = effects ?? [];
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: "created" } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}

// Clear the reaction plumbing a clone inherits before overriding it.
const BLANK_REACTION = { effect_table: {}, reaction_config_table: {}, active_effect_config_table: {}, optional_params: {} };

async function createWorldItem(data, out) {
  if (game.items.get(data._id)) { out.push(`= ${data.name} exists`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${data.name} (${data._id})`);
  return doc;
}

// ── Hawk numbers (pricing: report 2026-11-21 Warden of the Wilds) ────────────
// All scaling reads the OWNER's level (SUMMONER_LEVEL on the hawk; CHAR_LEVEL in
// the owner's summon row), so the hawk holds its share of a character's output
// from L20 to L50 instead of fading like a flat stat.
const HAWK_HP = "5 + CHAR_LEVEL";                         // summon_overrides, owner's resolver
const HAWK_ACC = "floor(SUMMONER_LEVEL / 15) + 3 * (SUMMONER_SKILL_LEVEL_KEEN_TALONS > 0)";
const DIVE_DMG = "floor(SUMMONER_LEVEL / 4)";
const RAKE_DMG = "floor(SUMMONER_LEVEL / 8)";
const DIVE_KEYWORDS = "chain {1 + (SUMMONER_SKILL_LEVEL_TWIN_DIVE > 0)} separate";

// The summon row both companion sources use.
const summonRow = (label) => ({
  effect_kind: "summon", effect_label: label, summon_actor: `Actor.${HAWK}`, summon_count: "1",
  summon_kind: "companion", summon_max: "1", summon_turns_per_round: "0", summon_act_this_round: "false",
  summon_overrides: JSON.stringify({ max_hp: HAWK_HP, current_hp: HAWK_HP }),
});

// ── 1. Spirit Hawk ───────────────────────────────────────────────────────────
function blankProp(k, v) {
  if (/^condition_/.test(k)) return "NA";
  if (/^affinity_[1-9]$/.test(k)) return "NA";
  if (/_ef$/.test(k)) return "100";
  if (/^(extra_damage_mod_|damage_receiving_mod_|check_mod_)/.test(k)) return 0;
  if (typeof v === "boolean") return false;
  if (v && typeof v === "object") return {};
  return v;
}

async function authorHawk(out) {
  const hawk = game.actors.get(HAWK);
  if (!hawk) { out.push("! Spirit Hawk actor missing"); return; }
  if (isDone(hawk)) { out.push("= Spirit Hawk already authored"); return; }
  const kg = game.actors.get(KG);
  const slime = game.actors.get(FIRE_SLIME);
  const tackle = slime?.items.get(TACKLE);
  const kgFly = kg?.items.get(KG_FLYING);
  const shell = game.items.get(PASSIVE_SHELL);
  if (!kg || !tackle || !kgFly || !shell) { out.push("! Spirit Hawk donors missing (King Gorger / Tackle / Flying / passive shell)"); return; }

  const kgSys = kg.toObject().system;
  const img = hawk.img || "icons/svg/mystery-man.svg";
  const props = {};
  for (const [k, v] of Object.entries(kgSys.props ?? {})) props[k] = blankProp(k, v);
  const set = (k, v) => { if (k in props) props[k] = v; };
  const old = hawk.system.props ?? {};
  Object.assign(props, { name: "Spirit Hawk", id: HAWK });
  set("uuid", `Actor.${HAWK}`);
  for (const k of ["img", "sprite_standard", "sprite_battle", "cut_in_critical", "cut_in_fumble", "cut_in_zero_power"]) set(k, img);
  set("level", 5); set("species", "BEAST"); set("subtype_list", "AVIAN"); set("npc_rank", "soldier");
  set("dex_base", "10"); set("ins_base", "8"); set("mig_base", "6"); set("wlp_base", "6");
  set("dex_current", 10); set("ins_current", 8); set("mig_current", 6); set("wlp_current", 6);
  set("def_mod", "+2"); set("mdef_mod", "+0"); set("defense", 12); set("magic_defense", 8);
  set("max_hp", "30"); set("current_hp", 30); set("max_mp", "20"); set("current_mp", 20);
  set("init", "6"); set("enmity", kgSys.props.enmity ?? 100);
  for (const k of ["minimum_critical_dice", "critical_damage_multiplier", "damage_dealt_mult_all", "damage_taken_mult"]) if (k in kgSys.props) props[k] = kgSys.props[k];
  set("battle_facing_direction", kgSys.props.battle_facing_direction ?? "left");
  set("default_facing_direction", kgSys.props.default_facing_direction ?? "right");
  // The legacy sheet's elements: Air RS · Bolt VU · Earth IM · Ice VU · Poison VU.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) set(`affinity_${n}`, old[`affinity_${n}`] || "NA");
  for (const k of ["bow_ef", "brawling_ef", "firearm_ef", "flail_ef", "heavy_ef", "spear_ef", "thrown_ef"]) if (old[k]) set(k, old[k]);
  set("traits", "Nature spirit of a hawk, loyal, keen-eyed");
  set("study_text", "<p>A <strong>spirit hawk</strong> bound to a forest warden. It never strays far from the one it chose, and it strikes where its partner's arrows point.</p>");
  set("desc", "<p>A hawk woven from wind and leaf-light, companion to whoever wears the Hunter's Mantle.</p>");

  // Sheet mirrors + action pattern (the sheet renders from these, not the items).
  const atk = (id, name, desc) => ({ name, id: "${item.id}", uuid: `Actor.${HAWK}.Item.${id}`, active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "INS", attack_description: desc, roll: "" });
  const psv = (id, name, desc) => ({ name, id: "${item.id}", uuid: `Actor.${HAWK}.Item.${id}`, passive_description: desc, roll: "" });
  props.attack_list = { [ID.talon]: atk(ID.talon, "Talon Rake", TEXT.talon), [ID.dive]: atk(ID.dive, "Dive Strike", TEXT.dive) };
  props.skill_passive_list = { [ID.bond]: psv(ID.bond, "Spirit Bond", TEXT.bond), [ID.flight]: psv(ID.flight, "Flying", TEXT.flight) };
  if ("skill_active_list" in props) props.skill_active_list = {};
  if ("normal_spell_list" in props) props.normal_spell_list = {};
  const pat = (name, priority, cooldown, focus) => ({ $deleted: false, action_pattern_name: name, action_pattern_condition: "always",
    action_pattern_value_1: "0", action_pattern_value_2: "100", action_pattern_string: "", action_pattern_priority: String(priority),
    action_pattern_target_focus: focus, action_pattern_cooldown: String(cooldown), action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0", action_pattern_focus_status: "" });
  // Dive Strike is exclusive when ready (priority gap 3) and rests 2 turns, so
  // the hawk's own action runs Dive, Rake, Rake, Dive…
  props.action_pattern_table = { 0: pat("Dive Strike", 5, 2, "by_affinity"), 1: pat("Talon Rake", 2, 0, "auto") };

  // Nothing of the donor's identity may survive the blanking.
  const leak = Object.entries(props).filter(([, v]) => /gorger/i.test(typeof v === "string" ? v : JSON.stringify(v ?? ""))).map(([k]) => k);
  if (leak.length) { out.push(`! Spirit Hawk: donor text left in ${leak.join(", ")} — not written`); return; }
  // Drop the legacy sheet's keys the new template does not have.
  for (const k of Object.keys(old)) if (!(k in props)) props[`-=${k}`] = null;

  await hawk.update({
    "system.template": kgSys.template,
    ...(kgSys.templateSystemUniqueVersion !== undefined ? { "system.templateSystemUniqueVersion": kgSys.templateSystemUniqueVersion } : {}),
    "system.props": props,
    [`flags.${M}.layoutRef`]: kg.flags?.[M]?.layoutRef,
    [`flags.${M}.idleAnimation`]: { bounce: false, float: true },
    "prototypeToken.actorLink": false,
    "prototypeToken.disposition": 1,
  });

  // Items (embedded, fixed ids).
  const melee = iconOf("Melee Attack", tackle.img);
  const passiveIcon = iconOf("Passive", shell.img);
  const npcAttack = (id, name, desc, extra) => {
    const d = cloneItem(tackle, { id, name, img: melee, props: { ...BLANK_REACTION, ...extra, description: desc } });
    d.system.props.uuid = `Actor.${HAWK}.Item.${id}`;
    return d;
  };
  const talon = npcAttack(ID.talon, "Talon Rake", TEXT.talon, {
    action_command: "attack", skill_type: "Attack", class: "NPC", cost: "-", rolled_atr1: "DEX", rolled_atr2: "INS",
    check_bonus: "0", damage_bonus: "0", type_damage: "Physical", defense_target_type: "def", isCheck: true,
    skill_range: "Melee", skill_target: "One Creature", duration: "Instantaneous", action_keywords: "", isReaction: false,
  });
  const dive = npcAttack(ID.dive, "Dive Strike", TEXT.dive, {
    action_command: "attack", skill_type: "Attack", class: "NPC", cost: "-", rolled_atr1: "DEX", rolled_atr2: "INS",
    check_bonus: "0", damage_bonus: "0", type_damage: "Physical", defense_target_type: "def", isCheck: true,
    skill_range: "Melee", skill_target: "One Creature", duration: "Instantaneous", action_keywords: DIVE_KEYWORDS, isReaction: false,
  });
  const bond = cloneItem(shell, { id: ID.bond, name: "Spirit Bond", img: passiveIcon, props: {
    ...BLANK_REACTION, class: "NPC", skill_type: "Passive", skill_target: "-", rolled_atr1: "-", rolled_atr2: "-", cost: "-",
    damage_bonus: "0", type_damage: "", check_bonus: "0", isReaction: true, description: TEXT.bond, skill_description: TEXT.bond,
    effect_table: table([
      { effect_kind: "free_action", effect_label: "sb_act", action_ref: "Attack", source_label: "Spirit Hawk" },
      { effect_kind: "adjust_damage", effect_label: "sb_dive_dmg", damage_stage: "outgoing", damage_operation: "add", damage_amount: DIVE_DMG },
      { effect_kind: "adjust_damage", effect_label: "sb_rake_dmg", damage_stage: "outgoing", damage_operation: "add", damage_amount: RAKE_DMG },
      { effect_kind: "adjust_accuracy", effect_label: "sb_aim", accuracy_operation: "add", accuracy_amount: HAWK_ACC },
      { effect_kind: "apply_ae", effect_label: "sb_mark", ae_template_ref: "Hunter's Mark", ae_duplicate_mode: "replace",
        ae_duration_rounds: "scene", target_ref: "trigger_subject", on_empty: "skip" },
    ]),
    reaction_config_table: table([
      // Companion: no turn of its own — it acts at the start of its owner's turn (King Gorger's rule).
      { reaction_trigger: "turn_start", reaction_source: "ally", reaction_passive_mode: "force", condition_formula: "SUBJECT_IS_MY_SUMMONER == 1", reaction_effect_ref: "sb_act" },
      { reaction_trigger: "creature_will_deal_damage", reaction_source: "self", reaction_passive_mode: "force", reaction_source_skill: "Dive Strike", condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "sb_dive_dmg" },
      { reaction_trigger: "creature_will_deal_damage", reaction_source: "self", reaction_passive_mode: "force", reaction_source_skill: "Talon Rake", condition_formula: "DAMAGE_IS_HP == 1", reaction_effect_ref: "sb_rake_dmg" },
      { reaction_trigger: "creature_performs_action", reaction_source: "self", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_action_kind: "Attack", condition_formula: `(${HAWK_ACC}) > 0`, reaction_effect_ref: "sb_aim" },
      // Warden of the Wilds 2pc (owner holds Marked Prey): Dive Strike marks what it hits.
      { reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "force", reaction_source_skill: "Dive Strike", condition_formula: "DAMAGE_IS_HP == 1 && SUMMONER_SKILL_LEVEL_MARKED_PREY > 0", reaction_effect_ref: "sb_mark" },
    ]),
  } });
  bond.system.props.uuid = `Actor.${HAWK}.Item.${ID.bond}`;
  const fly = cloneItem(kgFly, { id: ID.flight, name: "Flying", props: { description: TEXT.flight, skill_description: TEXT.flight } });
  fly.system.props.uuid = `Actor.${HAWK}.Item.${ID.flight}`;
  const flyAe = kgFly.effects.contents[0]?.toObject();
  if (flyAe) {
    flyAe._id = ID.flightAe;
    flyAe.description = "<p>The Spirit Hawk is airborne while it is not in <strong>Crisis</strong>. Granted and withdrawn by the derived-status reactor (rule <code>spirit-hawk-flight</code>).</p>";
    flyAe.flags = { ...(flyAe.flags ?? {}), [M]: { ...(flyAe.flags?.[M] ?? {}), deriveStatus: { ...(flyAe.flags?.[M]?.deriveStatus ?? {}), ruleKey: "spirit-hawk-flight" } } };
    delete flyAe._stats;
    fly.effects = [flyAe];
  }
  const items = [talon, dive, bond, fly].filter((d) => !hawk.items.get(d._id));
  for (const d of items) delete d.folder;
  if (items.length) await hawk.createEmbeddedDocuments("Item", items, { keepId: true });

  // The marker gear looks for (Protect (Spirit Hawk), and Kindred Spirit's filter by skill).
  if (!hawk.effects.get(ID.marker)) {
    await hawk.createEmbeddedDocuments("ActiveEffect", [{
      _id: ID.marker, name: "Spirit Hawk", img: passiveIcon, transfer: false, disabled: false, changes: [], statuses: [],
      description: "<p>Marks this creature as a Spirit Hawk (Warden of the Wilds gear looks for it).</p>",
      flags: { [M]: { directorPermanent: true, crossScene: true, [FLAG]: "marker" } },
    }], { keepId: true });
  }
  await mark(hawk);
  out.push(`~ Spirit Hawk: modern sheet, ${items.length} item(s), action pattern, marker`);
}

// ── Text ────────────────────────────────────────────────────────────────────
const TEXT = {
  talon: `<p>Deal <strong>light</strong> ${PHYSICAL} damage to one creature.</p>`,
  dive: `<p>The hawk folds its wings and drops from the sky. Deal ${PHYSICAL} damage to one creature.</p>`,
  bond: ul(
    "The Spirit Hawk is a <strong>companion</strong>: it takes no turn of its own. At the start of its owner's turn, before them, it performs one action.",
    "Its Accuracy and damage grow with its owner's level.",
    `Its owner's <strong>Warden of the Wilds</strong> set: 2 pieces — 【🏹 Dive Strike】 applies ${MARK}; 3 pieces — its attacks gain <strong>+3</strong> Accuracy; 4 pieces — 【🏹 Dive Strike】 gains ${COMBO} <strong>2</strong> <em>(both attacks target the same creature)</em>.`,
  ),
  flight: `<p>The Spirit Hawk always has the <strong>Flying</strong> status. While in ${CRISIS}, it is <strong>Grounded</strong>.</p>`,
  mark: "<p>The next attack that targets this creature gains <strong>+3</strong> Accuracy. After that attack resolves, this effect ends.</p>",
};

// ── 2. Hunter's Mark effect ─────────────────────────────────────────────────
async function authorHuntersMark(out) {
  const lib = game.items.get(DEBUFF_LIB);
  if (!lib) { out.push("! Debuff library missing"); return; }
  if (lib.effects.get(ID.markAe)) { out.push("= Hunter's Mark effect exists"); return; }
  const icon = game.items.get(HUNTERS_MARK_ITEM)?.img ?? "icons/svg/target.svg";
  await lib.createEmbeddedDocuments("ActiveEffect", [{
    _id: ID.markAe, name: "Hunter's Mark", img: icon, transfer: false, disabled: false, changes: [], statuses: [],
    description: TEXT.mark,
    system: { tags: ["debuff", "mark"] },
    flags: { [M]: {
      tags: ["debuff", "mark"], chargeKey: "hunters_mark", charges: 1, [FLAG]: "hunters-mark",
      reactionConfig: {
        effect_table: table([
          { effect_kind: "adjust_defense", effect_label: "hm_expose", defense_operation: "subtract", defense_amount: "3", consume_carrier_charge: true },
        ]),
        reaction_config_table: table([
          { reaction_trigger: "creature_targeted_by_action", reaction_source: "self", reaction_passive_mode: "force",
            reaction_action_kind: "Attack", reaction_action_intent: "harmful", condition_formula: "", reaction_effect_ref: "hm_expose" },
        ]),
      },
    } },
  }], { keepId: true });
  out.push("+ Hunter's Mark effect (Debuff library)");
}

// ── 3. Set pieces ───────────────────────────────────────────────────────────
const SET_DESCRIPTION = `<p><strong>【Set Bonus】</strong></p><p><strong>2 Piece</strong></p><ul><li><p>Ally ${HAWK_LINK}'s <strong>【🏹 Dive Strike】</strong> apply <img src="https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rena/30px-GrandArcherSkill1.png" style="width: 18px; height: 18px; vertical-align: middle; margin-right: 4px; border: none;"> ${MARK} to the target</p><hr></li></ul><p><strong>3 Piece</strong></p><ul><li><p>Ally ${HAWK_LINK}'s <strong>Attacks</strong> gain +3 Accuracy</p><hr></li></ul><p><strong>4 Piece</strong></p><ul><li><p>Ally ${HAWK_LINK}'s <strong>【🏹 Dive Strike】</strong> gain ${COMBO} <strong>2</strong> <em>(Both attacks must target the same creature)</em></p></li></ul>`;

const FLAVOR = {
  spirit: "A longbow strung with a hawk's flight feather. Loose an arrow, and something answers from the sky.",
  mantle: "Woven by forest wardens from moss, bark and the down of a spirit hawk. Wear it, and the hawk comes when called.",
  boots: "Soft-soled and silent. The wardens who wore them read every trail and crossed every bog unharmed.",
  feather: "A single feather shed by a spirit hawk. It hums whenever its partner is near.",
};

function mantleText() {
  return ul(
    `You may begin the <strong>conflict</strong> with the <strong>companion</strong> ${HAWK_LINK}. <em>(A character can have only one companion: if you already have one, the Spirit Hawk does not join.)</em>`,
    `You may perform the skill 【💥<strong>@UUID[Item.${ID.mantleSummon}]{Summon Spirit Hawk}</strong>】`,
  );
}

async function authorPieces(out) {
  const shell = game.items.get(PASSIVE_SHELL);
  const passiveIcon = iconOf("Passive", shell?.img);

  // Hunter's Mantle — conflict-start companion + contained Summon Spirit Hawk.
  const mantle = game.items.get(PIECE.mantle);
  const lib = game.items.get(SUMMON_SKILL);
  if (mantle && lib) {
    const summonProps = {
      ...BLANK_REACTION, skill_type: "Active", action_command: "skill", class: "", cost: "20 MP", skill_target: "Self",
      duration: "Scene", skill_range: "-", rolled_atr1: "-", rolled_atr2: "-", isCheck: false, isReaction: false,
      description: `<p>You call upon the spirits of nature: an ally ${HAWK_LINK} joins the conflict as your <strong>companion</strong>. Unavailable while you already have a companion.</p>`,
      on_activate_effect_ref: "ssh_call",
      availability_formula: "HAS_COMPANION == 0", availability_reason: "Already has a companion",
      effect_table: table([summonRow("ssh_call")]),
    };
    if (!isDone(lib)) {
      const patch = {};
      for (const [k, v] of Object.entries(summonProps)) patch[`system.props.${k}`] = v;
      await lib.update(patch);
      await mark(lib);
      out.push("~ Summon Spirit Hawk (library): 20 MP, companion summon, HAS_COMPANION gate");
    }
    await createWorldItem(cloneItem(lib, { id: ID.mantleSummon, name: "Summon Spirit Hawk", container: PIECE.mantle, folder: EMBED_FOLDER, props: summonProps }), out);
    await createWorldItem(cloneItem(shell, { id: ID.mantlePsv, name: "Hunter's Mantle (Passive)", container: PIECE.mantle, folder: EMBED_FOLDER, img: passiveIcon, props: {
      ...BLANK_REACTION, skill_type: "Passive", skill_target: "Self", isReaction: true, description: mantleText(), skill_description: mantleText(),
      effect_table: table([summonRow("wm_call")]),
      reaction_config_table: table([{ reaction_trigger: "conflict_start", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_source: "", reaction_effect_ref: "wm_call" }]),
    } }), out);
  } else out.push("! Hunter's Mantle or Summon Spirit Hawk missing");

  // Kindred Spirit — Snipe 20: an ally Spirit Hawk dives on the same target.
  const spirit = game.items.get(PIECE.spirit);
  if (spirit) {
    await createWorldItem(cloneItem(shell, { id: ID.spiritPsv, name: "Kindred Spirit (Passive)", container: PIECE.spirit, folder: EMBED_FOLDER, img: passiveIcon, props: {
      ...BLANK_REACTION, skill_type: "Passive", skill_target: "Self", isReaction: true,
      description: spirit.system.props.description, skill_description: spirit.system.props.description,
      effect_table: table([
        { effect_kind: "chain", effect_label: "ks_follow", chain_steps: "ks_hawk, ks_dive" },
        { effect_kind: "targeting", effect_label: "ks_hawk", candidate_source: "combat", category: "ally", exclude_self: true, exclude_defeated: true,
          target_filter: "HAS_SKILL_DIVE_STRIKE == 1", mode: "all", count: "1", skip_when_passive: true, auto_target: "skip", iteration_mode: "together" },
        { effect_kind: "free_action", effect_label: "ks_dive", performer_ref: "ks_hawk", action_ref: "Dive Strike", target_ref: "trigger_subject", source_label: "Kindred Spirit" },
      ]),
      reaction_config_table: table([{ reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_passive_mode: "force",
        reaction_requires_weapon_used: true, condition_formula: "ATTACK_CHECK_RESULT >= 20", reaction_effect_ref: "ks_follow" }]),
    } }), out);
  }

  // Kindred Feather — Protect (Spirit Hawk). Its +1 Accuracy already ships as the
  // equip-gated "Attacks +1 Accuracy" effect (check_mod_melee + check_mod_ranged).
  const feather = game.items.get(PIECE.feather);
  const protect = game.items.get(PROTECT);
  if (feather && protect) {
    const pet = foundry.utils.deepClone(protect.system.props.effect_table ?? {});
    for (const r of Object.values(pet)) {
      if (r?.effect_label === "protect_incoming") r.target_filter = "AE_COUNT_SPIRIT_HAWK > 0";
      if (r?.effect_label === "protect_anim") r.action_ref = `Item.${PROTECT_LIB}`;
    }
    const prc = foundry.utils.deepClone(protect.system.props.reaction_config_table ?? {});
    for (const r of Object.values(prc)) if (r?.reaction_trigger === "creature_targeted_by_action") r.condition_formula = "ANY_TARGET_HAS_SPIRIT_HAWK == 1";
    const ptext = `<p>When an ally ${HAWK_LINK} is threatened by an <strong>attack, spell</strong> or <strong>other danger</strong>, you may take its place. This shares <strong>Protect</strong>'s limit: once used, neither can be used again until the start of your next turn.</p>`;
    await createWorldItem(cloneItem(protect, { id: ID.featherProtect, name: "Protect (Spirit Hawk)", container: PIECE.feather, folder: EMBED_FOLDER,
      props: { effect_table: pet, reaction_config_table: prc, description: ptext, skill_description: ptext, class: "" } }), out);
  }

  // Text, flavor and set fields on the four pieces.
  for (const [k, id] of Object.entries(PIECE)) {
    const item = game.items.get(id);
    if (!item) { out.push(`! ${k} piece missing`); continue; }
    if (isDone(item)) { out.push(`= ${item.name} already updated`); continue; }
    const patch = {
      "system.props.flavor_text": flavor(FLAVOR[k]),
      "system.props.set_description": SET_DESCRIPTION,
      "system.props.isSet": true,
      "system.props.set_name": SET_NAME,
    };
    if (k === "mantle") patch["system.props.description"] = mantleText();
    if (k === "feather") patch["system.props.description"] = String(item.system.props.description ?? "").replace("on an an ally", "on an ally");
    await item.update(patch);
    await mark(item);
    // Actor copies (none hold these today): same words and set fields.
    let copies = 0;
    for (const a of game.actors) for (const c of a.items.filter((i) => i.name === item.name && !i.system?.container)) { await c.update(patch); copies++; }
    out.push(`~ ${item.name}: text/flavor/set${copies ? ` (+${copies} actor copies; their contained passives are NOT added)` : ""}`);
  }
}

// ── 4. Equipment Set + bonus skills ─────────────────────────────────────────
async function authorSet(out) {
  const donor = game.items.get(SET_DONOR);
  const skillDonor = game.items.get(SET_SKILL_DONOR);
  if (!donor || !skillDonor) { out.push("! Equipment Set donors missing"); return; }
  await createWorldItem(cloneItem(donor, { id: ID.setDef, name: `${SET_NAME} — Equipment Set`, folder: donor.folder?.id ?? null, props: {
    set_name: SET_NAME,
    set_bonus_table: table([
      { pieces: "2", bonus_label: "Spirit Hawk's Dive Strike applies Hunter's Mark", bonus_ae_ref: "", bonus_skill_ref: "Marked Prey" },
      { pieces: "3", bonus_label: "Spirit Hawk's attacks gain +3 Accuracy", bonus_ae_ref: "", bonus_skill_ref: "Keen Talons" },
      { pieces: "4", bonus_label: "Spirit Hawk's Dive Strike gains Combo 2", bonus_ae_ref: "", bonus_skill_ref: "Twin Dive" },
    ]),
  } }), out);
  // Text-only on the owner: the Spirit Hawk reads them (SUMMONER_SKILL_LEVEL_<NAME>).
  const bonus = [
    [ID.prey, "Marked Prey", `<p><strong>${SET_NAME} (2 pieces)</strong> — your ${HAWK_LINK}'s <strong>【🏹 Dive Strike】</strong> applies ${MARK} to the creature it hits.</p>`],
    [ID.keen, "Keen Talons", `<p><strong>${SET_NAME} (3 pieces)</strong> — your ${HAWK_LINK}'s attacks gain <strong>+3</strong> Accuracy.</p>`],
    [ID.twin, "Twin Dive", `<p><strong>${SET_NAME} (4 pieces)</strong> — your ${HAWK_LINK}'s <strong>【🏹 Dive Strike】</strong> gains ${COMBO} <strong>2</strong> <em>(both attacks target the same creature)</em>.</p>`],
  ];
  for (const [id, name, text] of bonus) {
    await createWorldItem(cloneItem(skillDonor, { id, name, container: ID.setDef, folder: null, img: game.items.get(HUNTERS_MARK_ITEM)?.img, props: {
      ...BLANK_REACTION, description: text, isReaction: false, skill_type: "Passive",
    } }), out);
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────
export async function migrate(game, log = () => {}) {
  const out = [];
  await authorHuntersMark(out);
  await authorSet(out);
  await authorPieces(out);
  await authorHawk(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
