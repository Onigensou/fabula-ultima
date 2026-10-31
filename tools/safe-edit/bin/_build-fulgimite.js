// Fulgimite — L40 SOLDIER, Valley Underground. Elemental, Insect.
//
// Weak utility monster built around the Lightning Crystal: Resonance takes 2 off a
// Crystal's count and is always used when it can be, Bite otherwise. Evasion makes
// it immune to area attacks, and 15% of fights with a Crystal one of them is a
// Fulgimite in disguise. Design record: tools/mindscape/dossiers/fulgimite.md.
//
// Run from tools/safe-edit; --apply to write.
const fs = require("fs");
const path = require("path");
const { getByKey } = require("../lib/db");
const { L, bullets, trig, link, ICON } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");
const { encode } = require("../../anim-studio/lib/encode");

const A = "FulgimiteActor01";
const NAME = "Fulgimite";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ART = FORGE + "Beastiary/Fulgimite_Standard.png";
const SCALE = 1;
const NS = "fabula-ultima-companion";
const CRYSTAL = "lightning-crystal";

const I = {
  BITE: "FgBiteAttack0001", RES: "FgResonance00001", EVA: "FgEvasionPass001", IMP: "FgImpersonate001",
  AE_EVA: "FgEvasionAE00001", AE_DIS: "FgDisguiseAE0001",
  EMPTY: "FgLootEmptyItm01", ESSENCE: "FgLootEssenceI01",
};
const SKIZZIK = "I2sSkVIQ4FCunZBE";
const OBSIDRAX = "x8TBsDZaRgoSo5no";
const ROPER = "NlYBXQwmXIttrDod";
const EARTHEN_WIRE = "blW2o4tFoB0oVzEM", EARTHEN_AE = "9IyEHsRTryxVBNsR";
const PARYASHERA = "ym6As1q7yG1EMl9M", DRILL_CLAW = "PZ1aIYC42nTc1kgL";
const REEL = "6kdjnyHZGZ0MRh0g";
const ESSENCE_WORLD = "E1emEssenceB01t0";
const STEAL = [["(Empty)", "60"], ["Lightning Essence", "40"]];

const PARALYZED = link("JournalEntry.GqqgHkKOs0hkghdG", "Paralyzed");
const DESC = {
  bite: `<p>Deal <strong>light</strong> ${L.physical}&nbsp;damage to one creature.</p>`,
  res: `<p>Reduce the countdown of one Lightning Crystal by <strong>2</strong>.</p>`,
  eva: `<p>This creature can't be targeted by area actions or effects.</p>`,
  imp: bullets(trig("Lightning Crystals appear")) +
    `<p>This creature may take the place of one. While disguised, an action aimed at it deals no damage. This creature then deals <strong>light</strong> ${L.bolt}&nbsp;damage to the attacker, inflicts ${PARALYZED}&nbsp;and ${L.slow}, and reveals itself.</p>`,
};
const STUDY = "<p>It picks at a crystal with those little legs until the charge shakes loose, and it never gets bored of it. Its shell splits under a <strong>heavy</strong> blow, so count the crystals in the room twice before you swing at one.</p>";

const dir = path.join(__dirname, "../../anim-studio");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const scaled = (s) => { const out = s.replace(/scale: 1,/, `scale: ${SCALE},`); if (SCALE !== 1 && out === s) throw new Error("no scale in the reveal shot"); return out; };
const anim = (src, preload) => ({ skill_animation_mode: "custom", animation_script: encode(src), animation_damage_timing_options: "default", animation_damage_timing_offset: "0", animation_preload_urls: preload.join("\n") });
const MV = FORGE + "Animation/RPG%20Maker%20MV/", GGS = FORGE + "Animation/Guilty%20Gear%20Strive/webm/", D4 = FORGE + "Animation/Disgaea%204/webm/";
const RING = D4 + "flash_ring_white.webm";

const clone = (o) => JSON.parse(JSON.stringify(o));
async function need(coll, key) { const v = await getByKey(coll, key); if (!v) throw new Error(`missing ${key}`); return v; }

// The rules of the disguise. Two rows, one pool of effects: an action picking only
// this Crystal runs the whole chain, any other hit runs imp_zero alone.
const DISGUISE_CONFIG = {
  name: "Crystal Disguise",
  reaction_config_table: {
    "0": { $deleted: false, reaction_trigger: "creature_takes_damage", reaction_source: "self", reaction_passive_mode: "force", condition_formula: "HIT_ACTION_AIMED_AT_ME == 1", reaction_effect_ref: "imp_chain" },
    "1": { $deleted: false, reaction_trigger: "creature_takes_damage", reaction_source: "self", reaction_passive_mode: "force", condition_formula: "HIT_ACTION_AIMED_AT_ME == 0", reaction_effect_ref: "imp_zero" },
  },
  effect_table: {
    "0": { $deleted: false, effect_kind: "chain", effect_label: "imp_chain", chain_steps: "imp_zero,imp_mask,imp_shot,imp_bolt,imp_para,imp_slow,imp_reveal" },
    "1": { $deleted: false, effect_kind: "adjust_damage", effect_label: "imp_zero", damage_operation: "set", damage_amount: "0", damage_stage: "incoming" },
    "2": { $deleted: false, effect_kind: "conflict_event_action", effect_label: "imp_mask", conflict_action: "mask_countdown", target_ref: "self" },
    "3": { $deleted: false, effect_kind: "play_animation", effect_label: "imp_shot", action_ref: `Actor.${A}.Item.${I.IMP}`, target_ref: "cause_actor" },
    "4": { $deleted: false, effect_kind: "deal_damage", effect_label: "imp_bolt", damage_amount: "18", damage_element: "bolt", damage_cause: "damage", damage_verbosity: "full", attacker_name: NAME, target_ref: "cause_actor" },
    "5": { $deleted: false, effect_kind: "apply_ae", effect_label: "imp_para", ae_template_ref: "Paralyzed", target_ref: "cause_actor" },
    "6": { $deleted: false, effect_kind: "apply_ae", effect_label: "imp_slow", ae_template_ref: "Slow", target_ref: "cause_actor" },
    "7": { $deleted: false, effect_kind: "conflict_event_action", effect_label: "imp_reveal", conflict_action: "reveal", target_ref: "self" },
  },
};

(async () => {
  await run(async ({ changes }) => {
    if (await getByKey("actors", `!actors!${A}`)) throw new Error("already built");
    const ik = (id) => `!actors.items!${A}.${id}`;
    const donor = await need("actors", `!actors!${SKIZZIK}`);
    const actor = blankActor(donor, A, NAME, donor.folder, ART, SCALE);

    const claw = await need("actors", `!actors.items!${PARYASHERA}.${DRILL_CLAW}`);
    const reel = await need("actors", `!actors.items!${ROPER}.${REEL}`);
    const wire = await need("actors", `!actors.items!${OBSIDRAX}.${EARTHEN_WIRE}`);
    const wireAe = await need("actors", `!actors.items.effects!${OBSIDRAX}.${EARTHEN_WIRE}.${EARTHEN_AE}`);

    // ── Bite ──────────────────────────────────────────────────────────────
    const bite = makeSkill(claw, A, I.BITE, "Bite", ICON.melee, {
      skill_type: "Attack", skill_range: "Melee", skill_target: "One Creature", rolled_atr1: "DEX", rolled_atr2: "MIG",
      check_bonus: "5", damage_bonus: "15", type_damage: "Physical", defense_target_type: "def", isCheck: true,
      isOffensiveSpell: false, isReaction: false, cost: "-", duration: "Instantaneous", details_roller: "Show",
      action_keywords: "", description: DESC.bite,
      ...anim(read("fulgimite-bite.js"), [MV + "016_claw_physical.webm", MV + "001_hit_physical.webm"]),
    });
    changes.push([ik(I.BITE), bite, "Bite: light Physical, DEX+MIG +5, bonus 15"]);

    // ── Resonance ─────────────────────────────────────────────────────────
    const res = makeSkill(reel, A, I.RES, "Resonance", ICON.spell, {
      skill_type: "Active", skill_range: "Any", skill_target: "One Ally", rolled_atr1: "-", rolled_atr2: "-",
      check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def", isCheck: false,
      isOffensiveSpell: false, isReaction: false, cost: "-", duration: "Instantaneous", details_roller: "Show",
      action_keywords: "", description: DESC.res, target_eligibility: "TARGET_COUNTDOWN > 0",
      on_activate_effect_ref: "res_down",
      effect_table: { "0": { $deleted: false, effect_kind: "conflict_event_action", effect_label: "res_down", conflict_action: "adjust_countdown", conflict_amount: "-2", target_ref: "action_targets" } },
      ...anim(read("fulgimite-resonance.js"), [GGS + "spark_anim01.webm", RING]),
    });
    changes.push([ik(I.RES), res, "Resonance: -2 on one Crystal, no roll, no cost"]);

    // ── The two passives ──────────────────────────────────────────────────
    const passive = (id, name, description, extra = {}) => makeSkill(wire, A, id, name, ICON.passive, {
      skill_type: "Passive", skill_target: "-", skill_range: "-", rolled_atr1: "-", rolled_atr2: "-",
      check_bonus: "0", damage_bonus: "", type_damage: "", isCheck: false, isOffensiveSpell: false, isReaction: false,
      cost: "-", duration: "-", action_keywords: "", description, ...extra,
    });
    const ae = (itemId, id, name, description, fields) => {
      const m = clone(wireAe);
      m._id = id; m.name = name; m.description = description; m.img = null; m.origin = null;
      m.statuses = []; m.disabled = false;
      if (m._stats) { m._stats.createdTime = null; m._stats.modifiedTime = null; m._stats.duplicateSource = null; }
      delete m.flags["custom-system-builder"];
      Object.assign(m, fields);
      return [`!actors.items.effects!${A}.${itemId}.${id}`, m, `AE ${name}`];
    };

    const eva = passive(I.EVA, "Evasion", DESC.eva);
    eva.effects = [I.AE_EVA];
    changes.push([ik(I.EVA), eva, "Evasion: immune to area actions and effects"]);
    changes.push(ae(I.EVA, I.AE_EVA, "Evasion", DESC.eva, {
      transfer: true,
      changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "area", priority: 0 }],
      flags: { ...wireAe.flags, [NS]: { directorPermanent: true } },
    }));

    const imp = passive(I.IMP, "Lightning Crystal Impersonation", DESC.imp,
      anim(scaled(read("fulgimite-reveal.js")), [ART, RING, MV + "076_thunder_one_1.webm", MV + "064_paralyze.webm"]));
    imp.effects = [I.AE_DIS];
    changes.push([ik(I.IMP), imp, "Impersonation: holds the reveal shot and the disguise AE"]);
    // transfer:false, so the Fulgimite itself never wears it. The event copies it
    // onto the chosen Crystal (lightning-crystal.js, disguiseAeData).
    changes.push(ae(I.IMP, I.AE_DIS, "Crystal Disguise", "", {
      transfer: false, changes: [],
      flags: { ...wireAe.flags, [NS]: { directorPermanent: true, reactionConfig: DISGUISE_CONFIG } },
    }));

    // ── Steal table ───────────────────────────────────────────────────────
    const emptyDonor = (await need("actors", `!actors.items!${SKIZZIK}.D0uts61zAlFfc8aJ`));
    const empty = clone(emptyDonor); empty._id = I.EMPTY; empty.effects = [];
    changes.push([ik(I.EMPTY), empty, "steal: (Empty)"]);
    const ess = clone(await need("items", `!items!${ESSENCE_WORLD}`));
    ess._id = I.ESSENCE; ess.effects = [];
    ess._stats = { ...ess._stats, compendiumSource: `Item.${ESSENCE_WORLD}`, duplicateSource: null };
    changes.push([ik(I.ESSENCE), ess, "steal: Lightning Essence 40%"]);
    const lootRow = (id, name, doc) => ({ id: "${item.id}", name, uuid: `Actor.${A}.Item.${id}`, roll: "", loot_description: String(doc.system?.props?.description ?? "") });

    // ── The actor ─────────────────────────────────────────────────────────
    const p = actor.system.props;
    actor.flags = { ...actor.flags, [NS]: { spriteShadow: true, impersonates: { object: CRYSTAL, chance: 0.15 } } };
    actor.prototypeToken.width = 1; actor.prototypeToken.height = 1;
    Object.assign(p, {
      sprite_attack: "", sprite_hurt: "", sprite_ko: "", sprite_walk: "",
      npc_rank: "soldier", activation: "1", species: "ELEMENTAL", subtype_list: "INSECT", attribute: "LIGHTNING", level: "40",
      traits: "Crystal Parasite, Mimic, Skittering, Lightning-Fed",
      dex_base: "10", ins_base: "8", mig_base: "6", wlp_base: "6",
      dex_current: "10", ins_current: "8", mig_current: "6", wlp_current: "6",
      def_mod: "+1", mdef_mod: "+2", defense: 11, magic_defense: 10,
      max_hp: "80", current_hp: "80", max_mp: "30", current_mp: "30", init: "8",
      zenit_reward_min: "40", zenit_reward_max: "60", study_text: STUDY,
      affinity_2: "RS", affinity_3: "AB", affinity_5: "VU", affinity_9: "IM",
      heavy_ef: "200", bow_ef: "75",
    });
    for (const s of ["poisoned", "envenomed", "zombie", "bleed", "paralyzed"]) p[`condition_${s}`] = "IM";

    const U = (id) => `Actor.${A}.Item.${id}`;
    p.attack_list = { [I.BITE]: { name: "Bite", id: "${item.id}", uuid: U(I.BITE), active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "MIG", attack_description: DESC.bite, roll: "" } };
    p.skill_active_list = { [I.RES]: { name: "Resonance", id: "${item.id}", uuid: U(I.RES), active_target: "One Ally", active_cost: "-", active_duration: "Instantaneous", active_description: DESC.res, roll: "" } };
    p.skill_passive_list = {
      [I.EVA]: { name: "Evasion", id: "${item.id}", uuid: U(I.EVA), passive_description: DESC.eva, roll: "" },
      [I.IMP]: { name: "Lightning Crystal Impersonation", id: "${item.id}", uuid: U(I.IMP), passive_description: DESC.imp, roll: "" },
    };
    p.stealable_loot = { [I.EMPTY]: lootRow(I.EMPTY, "(Empty)", empty), [I.ESSENCE]: lootRow(I.ESSENCE, "Lightning Essence", ess) };
    p.steal_percentage_table = Object.fromEntries(STEAL.map(([loot_id, loot_percentage], i) => [String(i), { $deleted: false, loot_id, loot_percentage }]));

    // Priority 8 against 2 is outside the 2-priority window, so Resonance is
    // exclusive whenever a Crystal with turns left is reachable.
    const ap = (name, cond, v1, v2, prio) => ({ $deleted: false, action_pattern_name: name, action_pattern_condition: cond, action_pattern_string: "", action_pattern_value_1: v1, action_pattern_value_2: v2, action_pattern_priority: prio, action_pattern_target_focus: "auto", action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" });
    p.action_pattern_table = { "0": ap("Resonance", "target_count", "1", "99", "8"), "1": ap("Bite", "always", "0", "100", "2") };
    actor.items = [I.BITE, I.RES, I.EVA, I.IMP, I.EMPTY, I.ESSENCE];
    changes.push([`!actors!${A}`, actor, `${NAME}: L40 soldier, HP 80, mirrors, AI, steal`]);
  }, "fulgimite: actor", "actors");

  await run(async ({ changes }) => {
    const ENC = "sULKvLErNMF8JtUr", ENE = "hBupoi4SsKj1GmDM";
    const enc = clone(await need("tables", `!tables!${ENC}`));
    if (enc.formula !== "1d45") throw new Error(`Encounter table is ${enc.formula}`);
    const rows = [];
    for (const id of enc.results) rows.push(await need("tables", `!tables.results!${ENC}.${id}`));
    const donor = rows.find((r) => r.text === "Roper");
    const add = [
      ["FgEncounterRow01", "Galvanic Paryashera, Fulgimite, Fulgimite", 1],
      ["FgEncounterRow02", "Fulgimite, Lightning Prism", 2],
      ["FgEncounterRow03", "Fulgimite, Skizzik, Fulgimite", 2],
      ["FgEncounterRow04", "Fulgimite, Obsidrax", 2],
    ];
    let n = 46;
    for (const [id, text, width] of add) {
      const r = clone(donor); r._id = id; r.text = text; if ("name" in r) r.name = text; if ("description" in r) r.description = text;
      r.range = [n, n + width - 1]; r.weight = width; n += width;
      changes.push([`!tables.results!${ENC}.${id}`, r, `Encounter ${r.range.join("-")}: ${text}`]);
      enc.results.push(id);
    }
    enc.formula = `1d${n - 1}`;
    if (enc.formula !== "1d52") throw new Error(enc.formula);
    changes.push([`!tables!${ENC}`, enc, `Encounter: ${enc.formula}`]);

    const ene = clone(await need("tables", `!tables!${ENE}`));
    if (ene.formula !== "1d11") throw new Error(`Enemies table is ${ene.formula}`);
    const row = clone(await need("tables", `!tables.results!${ENE}.${ene.results[0]}`));
    row._id = "FgEnemiesRow0001"; row.text = NAME; if ("name" in row) row.name = NAME; row.documentId = A; row.img = ART; row.range = [12, 12];
    changes.push([`!tables.results!${ENE}.${row._id}`, row, "Enemies 12: Fulgimite"]);
    ene.results.push(row._id); ene.formula = "1d12";
    changes.push([`!tables!${ENE}`, ene, "Enemies: 1d12"]);
  }, "fulgimite: tables", "tables");
})().catch((e) => { console.error(e); process.exit(1); });
