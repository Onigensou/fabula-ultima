// Galvanic Paryashera — L46 ELITE, Valley Underground. SOLO ONLY. Was Galvanize Golem.
//
// Same concept as the Golem: a moderate fight that spikes once Bolt hits it, built
// for the Lightning Crystal. Four activations; steam and Hidden make the Paryashera
// family's rhythm: Steam Veil hides it, Spiral Drill strikes from hiding. While
// Hidden, a single-target PC can still hit the Crystal (buying turns), use an area
// attack, or spend an Objective on Reveal. Design record: tools/mindscape/dossiers.
//
// Also: moves Golem Fist to Iron Colossus (the Golem was its only source) and gives
// the solo elites Charm immunity (user rule, 2026-10-31).
//
// Run from tools/safe-edit; --apply to write.
const { getByKey, openCollection } = require("../lib/db");
const { L, bullets, trig, link, ICON } = require("./_fafnir-lib");
const { makeSkill, run } = require("./_fafnir-util");

const A = "ym6As1q7yG1EMl9M";
const NAME = "Galvanic Paryashera";
const BEST = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/";
const ART = BEST + "GalvanicParyashera_Standard.png";
const ART_CHARGED = BEST + "GalvanicParyashera_Supercharged.png";
const NS = "fabula-ultima-companion";

const ROPER = "NlYBXQwmXIttrDod";
const COLOSSUS = "FLy3XRr40wNRmYxV";
const SOLO_ELITES = ["B4qRdBIxFN6dZ6MT", ROPER, "0AwQ7wEDz4ISA9mA", "Rk5haXsaDemonAAA"]; // Carlbero, Roper, Asura, Rakshasa

const I = {
  CLAW: "PZ1aIYC42nTc1kgL", GALV: "F7gHvYczFw1y0OYj", CHARGE: "mc5kTxNZqC62RxDd", EMPTY: "pUy2R2lorpmzhYok",
  STEAM: "GpSteamVeilItm01", SPIN: "GpRendingSpinI01", SPIRAL: "GpSpiralDrillI01", VENT: "GpThunderVentI01",
  AE_STEAM: "GpSteamMarkerAE1", AE_SPIN: "GpSpinMarkerAE01",
  FANG: "GpLootFangItem01", ESSENCE: "GpLootEssenceI01", HOUND: "GpLootHoundItm01", IC_FIST: "IcLootGolemFist1",
};
const OLD_LOOT = { "Golem Soulstone": "16BERBxpFHIy4083", Steel: "MQ5RWvF33EqqCFGx", "Golem Fist": "T30voDCtVrGAj3n0", "Golem Fragment": "uos1sLHVyliTyqyc" };
const WORLD_LOOT = [["Animal Fang", "oAP85eeLJCliYm2E", I.FANG, "25"], ["Lightning Essence", "E1emEssenceB01t0", I.ESSENCE, "24"], ["Voltaic Hound", "Sot0IPra5zNXIUvG", I.HOUND, "6"]];

const HIDDEN = link("JournalEntry.DMaL1B3Z5Y5AUrvC", "Hidden");

// Damage wording is qualitative; action text is systemic (one plain sentence of
// what it does, then the effect).
const DESC = {
  claw: `<p>Swing a drill-tipped claw at an enemy. Deal ${L.physical}&nbsp;damage to one creature.</p>`,
  spin: bullets(`${L.multi}<strong>&nbsp;3</strong>`) +
    `<p>Spin its drilled claws through nearby enemies. Deal <strong>light</strong> ${L.physical}&nbsp;damage to the targets. Once per round.</p>`,
  steam: `<p>Vent scalding steam around itself. It gains ${HIDDEN}. Once per round.</p>`,
  spiral: bullets(L.pierce) +
    `<p>Burst out of the steam with a spinning drill. Deal <strong>heavy</strong> ${L.physical}&nbsp;damage to one creature. Used only while ${HIDDEN}, and ends it.</p>`,
  galv: bullets(L.pierce) +
    `<p>Drive a lightning-charged drill into an enemy. Deal <strong>heavy</strong> ${L.bolt}&nbsp;damage to one creature. Used only while <strong>Supercharged</strong>.</p>`,
  vent: `<p>Blast stored lightning out through its belly vents. Deal ${L.bolt}&nbsp;damage to all enemies. Used only while <strong>Supercharged</strong>.</p>`,
  charge: bullets(trig(`When ${L.bolt}&nbsp;damage strikes the Galvanic Paryashera`)) +
    `<p>It gains <strong>Supercharge</strong> until the end of the battle: <strong>+2</strong> Accuracy, <strong>+10</strong> damage, <strong>+2</strong> Defense and Magic Defense, Resistant to ${L.physical}, Immune to ${L.bolt}, and spears, heavy weapons and daggers strike it harder. This happens only once per battle.</p>`,
};
const SUPERCHARGE_TEXT = "<p>Overcharged by lightning until the end of the battle: +2 Accuracy, +10 damage, +2 Defense and Magic Defense, Resistant to Physical, Immune to Bolt, and spears, heavy weapons and daggers strike it harder.</p>";
const STUDY = "<p>A cave beast that burrows through charged rock, cloaked in the steam of its own vents. It lives on small sparks, but a real jolt sends it into a frenzy, so it is best put down before the <strong>lightning</strong> finds it.</p>";

const ap = (name, cond, str, prio, cooldown = "0") => ({
  $deleted: false, action_pattern_name: name, action_pattern_condition: cond, action_pattern_string: str,
  action_pattern_value_1: "0", action_pattern_value_2: "100", action_pattern_priority: prio,
  action_pattern_target_focus: "auto", action_pattern_cooldown: cooldown,
  action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0",
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const animOf = (p) => ({ skill_animation_mode: "custom", animation_script: p.animation_script,
  animation_damage_timing_options: p.animation_damage_timing_options ?? "default",
  animation_damage_timing_offset: p.animation_damage_timing_offset ?? "0",
  ...(p.animation_preload_urls ? { animation_preload_urls: p.animation_preload_urls } : {}) });

async function need(coll, key) {
  const v = await getByKey(coll, key);
  if (!v) throw new Error(`missing ${key}`);
  return v;
}

(async () => {
  // ── actors ──────────────────────────────────────────────────────────────
  await run(async ({ changes, deletes }) => {
    const ik = (id) => `!actors.items!${A}.${id}`;
    const actor = clone(await need("actors", `!actors!${A}`));
    if (actor.name !== "Galvanize Golem") throw new Error(`already built? actor is "${actor.name}"`);
    const claw = await need("actors", ik(I.CLAW));
    const galv = await need("actors", ik(I.GALV));
    const charge = await need("actors", ik(I.CHARGE));
    const reel = await need("actors", `!actors.items!${ROPER}.6kdjnyHZGZ0MRh0g`);
    const tentacle = await need("actors", `!actors.items!${ROPER}.iHiXf8OOFWXfVztS`);
    const lashedId = tentacle.effects?.[0];
    const marker = await need("actors", `!actors.items.effects!${ROPER}.iHiXf8OOFWXfVztS.${lashedId}`);
    const slap = (await need("actors", "!actors.items!B4qRdBIxFN6dZ6MT.aL8M4ZB1s4i6wgSG")).system.props;
    const stinger = await findItem("iGc0EUHE9LKWT0Ye", "Volt Stinger");
    const rail = (await need("actors", "!actors.items!TvLv878yZLNUAWNN.zNhzAhg1phFoHW8q")).system.props;
    const smoke = (await need("items", "!items!Uti1SmokeBombAct")).system.props;

    const edit = (doc, name, img, props) => {
      const d = clone(doc); d.name = name; d.img = img;
      Object.assign(d.system.props, { name, img }, props);
      return d;
    };
    const atk = { skill_type: "Attack", skill_range: "Melee", rolled_atr1: "DEX", rolled_atr2: "MIG",
      check_bonus: "5", defense_target_type: "def", isCheck: true, isOffensiveSpell: false, cost: "-",
      duration: "Instantaneous", details_roller: "Show" };

    changes.push([ik(I.CLAW), edit(claw, "Drill Claw", ICON.melee, { ...atk, skill_target: "One Creature",
      damage_bonus: "25", type_damage: "Physical", action_keywords: "", isReaction: false, description: DESC.claw }), "Piston Fist → Drill Claw"]);

    changes.push([ik(I.GALV), edit(galv, "Galvanic Drill", ICON.melee, { ...atk, skill_target: "One Creature",
      damage_bonus: "42", type_damage: "Bolt", action_keywords: "pierce", isReaction: false, description: DESC.galv,
      ...animOf(stinger.system.props) }), "Galvanic Smash → Galvanic Drill (Bolt, Pierce)"]);

    const spin = makeSkill(claw, A, I.SPIN, "Rending Spin", ICON.melee, { ...atk, skill_target: "Up to three creatures",
      damage_bonus: "20", type_damage: "Physical", action_keywords: "multi", isReaction: false, description: DESC.spin,
      on_activate_effect_ref: "spin_mark", ...animOf(slap),
      effect_table: { "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "spin_mark", ae_template_ref: "Drill Spun", target_ref: "self", ae_duplicate_mode: "skip" } } });
    spin.effects = [I.AE_SPIN];
    changes.push([ik(I.SPIN), spin, "NEW — Rending Spin (Multi 3, once per round)"]);

    const spiral = makeSkill(claw, A, I.SPIRAL, "Spiral Drill", ICON.melee, { ...atk, skill_target: "One Creature",
      damage_bonus: "38", type_damage: "Physical", action_keywords: "pierce", isReaction: false, description: DESC.spiral,
      on_activate_effect_ref: "spiral_reveal", ...animOf(claw.system.props),
      effect_table: { "0": { $deleted: false, effect_kind: "remove_ae", effect_label: "spiral_reveal", ae_template_ref: "Hidden", target_ref: "self", count: "all", include_persistent: true } } });
    changes.push([ik(I.SPIRAL), spiral, "NEW — Spiral Drill (Hidden only, Pierce, ends Hidden)"]);

    const steam = makeSkill(reel, A, I.STEAM, "Steam Veil", ICON.spell, { skill_type: "Active", skill_target: "Self", skill_range: "Any",
      rolled_atr1: "-", rolled_atr2: "-", check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
      isCheck: false, isOffensiveSpell: false, isReaction: false, cost: "-", duration: "Instantaneous", details_roller: "Show",
      action_keywords: "", description: DESC.steam, on_activate_effect_ref: "steam_chain", ...animOf(smoke),
      effect_table: {
        "0": { $deleted: false, effect_kind: "chain", effect_label: "steam_chain", chain_steps: "steam_hide,steam_mark" },
        // Self-applied charges tick at this creature's next turn start, so a
        // 1-turn Hidden would be gone before Spiral Drill. Spiral Drill ends it.
        "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "steam_hide", ae_template_ref: "Hidden", target_ref: "self", ae_duplicate_mode: "skip", ae_duration_rounds: "3" },
        "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "steam_mark", ae_template_ref: "Steam Vented", target_ref: "self", ae_duplicate_mode: "skip" },
      } });
    steam.effects = [I.AE_STEAM];
    changes.push([ik(I.STEAM), steam, "NEW — Steam Veil (gains Hidden, once per round)"]);

    const vent = makeSkill(reel, A, I.VENT, "Thunder Vent", ICON.ospell, { skill_type: "Active", skill_target: "All Enemies", skill_range: "Any",
      rolled_atr1: "INS", rolled_atr2: "WLP", check_bonus: "5", damage_bonus: "22", type_damage: "Bolt", defense_target_type: "mdef",
      isCheck: true, isOffensiveSpell: false, isReaction: false, cost: "30 MP", duration: "Instantaneous", details_roller: "Show",
      action_keywords: "", description: DESC.vent, ...animOf(rail) });
    changes.push([ik(I.VENT), vent, "NEW — Thunder Vent (all enemies, 30 MP, Supercharged only)"]);

    changes.push([ik(I.CHARGE), edit(charge, "Super Charge", charge.img, { description: DESC.charge }), "Super Charge text"]);

    const markerAE = (itemId, aeId, name, text) => {
      const m = clone(marker); m._id = aeId; m.name = name; m.description = text; m.img = ART;
      if (m._stats) { m._stats.createdTime = null; m._stats.modifiedTime = null; }
      return [`!actors.items.effects!${A}.${itemId}.${aeId}`, m, `marker AE — ${name}`];
    };
    changes.push(markerAE(I.STEAM, I.AE_STEAM, "Steam Vented", "<p>It has vented its steam this round.</p>"));
    changes.push(markerAE(I.SPIN, I.AE_SPIN, "Drill Spun", "<p>It has spun its drills this round.</p>"));

    // ── steal table ───────────────────────────────────────────────────────
    const loot = {};
    const empty = actor.system.props.stealable_loot[I.EMPTY];
    if (!empty) throw new Error("no (Empty) row");
    loot[I.EMPTY] = empty;
    const rows = [["(Empty)", "45"]];
    for (const [lootName, worldId, newId, pct] of WORLD_LOOT) {
      const emb = clone(await need("items", `!items!${worldId}`));
      emb._id = newId; emb.effects = [];
      emb._stats = { ...emb._stats, compendiumSource: `Item.${worldId}`, duplicateSource: null };
      changes.push([ik(newId), emb, `steal: embed ${lootName} ${pct}%`]);
      loot[newId] = { id: "${item.id}", name: lootName, uuid: `Actor.${A}.Item.${newId}`, roll: "", loot_description: String(emb.system?.props?.description ?? "") };
      rows.push([lootName, pct]);
    }
    for (const [lootName, id] of Object.entries(OLD_LOOT)) deletes.push([ik(id), `steal: drop ${lootName}`]);

    // ── the actor ─────────────────────────────────────────────────────────
    const p = actor.system.props;
    actor.name = NAME; actor.img = ART;
    actor.flags = { ...actor.flags, [NS]: { ...(actor.flags?.[NS] ?? {}), spriteShadow: true } };
    actor.prototypeToken.name = NAME;
    actor.prototypeToken.width = 2; actor.prototypeToken.height = 2;
    actor.prototypeToken.texture.src = ART;
    actor.prototypeToken.texture.scaleX = 1.6; actor.prototypeToken.texture.scaleY = 1.6;
    Object.assign(p, {
      name: NAME, img: ART, sprite_standard: ART, sprite_battle: ART, cut_in_critical: ART, cut_in_fumble: ART, cut_in_zero_power: ART,
      sprite_attack: "", sprite_hurt: "", sprite_ko: "", sprite_walk: "",
      npc_rank: "elite", activation: "4", species: "BEAST", subtype_list: "REPTILIAN", level: "46",
      traits: "Cave Dweller, Steam-Cloaked, Lightning-Fed, Burrowing",
      dex_base: "8", ins_base: "8", mig_base: "10", wlp_base: "8",
      dex_current: "8", ins_current: "8", mig_current: "10", wlp_current: "8",
      def_mod: "+4", mdef_mod: "+3", defense: 12, magic_defense: 11,
      max_hp: "420", current_hp: "420", max_mp: "60", current_mp: "60", init: "9",
      zenit_reward_min: "200", zenit_reward_max: "260", study_text: STUDY,
      // Bolt stays neutral so the hit lands and fires Super Charge. RS earth: the
      // Crystal's best delay does little to the monster.
      affinity_1: "NA", affinity_3: "NA", affinity_5: "RS", affinity_7: "VU", affinity_9: "RS",
      // Plates over a soft belly.
      spear_ef: "150", heavy_ef: "125", dagger_ef: "125", bow_ef: "100", brawling_ef: "75", sword_ef: "75",
    });
    for (const k of Object.keys(p)) if (/^condition_/.test(k)) p[k] = "NA";
    for (const s of ["charm", "grappled", "frightened", "petrify", "poisoned", "enraged"]) p[`condition_${s}`] = "IM";
    for (const s of ["shaken", "weak", "blind", "paralyzed"]) p[`condition_${s}`] = "RS";

    const U = (id) => `Actor.${A}.Item.${id}`;
    const attackRow = (id, name, target, d) => ({ name, id: "${item.id}", uuid: U(id), active_target: target, attribute_die1: "DEX", attribute_die2: "MIG", attack_description: d, roll: "" });
    const activeRow = (id, name, target, cost, d) => ({ name, id: "${item.id}", uuid: U(id), active_target: target, active_cost: cost, active_duration: "Instantaneous", active_description: d, roll: "" });
    p.attack_list = {
      [I.CLAW]: attackRow(I.CLAW, "Drill Claw", "One Creature", DESC.claw),
      [I.SPIN]: attackRow(I.SPIN, "Rending Spin", "Up to three creatures", DESC.spin),
      [I.SPIRAL]: attackRow(I.SPIRAL, "Spiral Drill", "One Creature", DESC.spiral),
      [I.GALV]: attackRow(I.GALV, "Galvanic Drill", "One Creature", DESC.galv),
    };
    p.skill_active_list = {
      [I.STEAM]: activeRow(I.STEAM, "Steam Veil", "Self", "-", DESC.steam),
      [I.VENT]: activeRow(I.VENT, "Thunder Vent", "All Enemies", "30 MP", DESC.vent),
    };
    p.skill_passive_list = { [I.CHARGE]: { name: "Super Charge", id: "${item.id}", uuid: U(I.CHARGE), passive_description: DESC.charge, roll: "" } };
    p.stealable_loot = loot;
    p.steal_percentage_table = Object.fromEntries(rows.map(([loot_id, loot_percentage], i) => [String(i), { $deleted: false, loot_id, loot_percentage }]));

    // Spiral Drill sits clear of everything: once Hidden, the next action is the
    // strike. The rest share priority 7 and compete. Drill Claw sits 3 below, so it
    // only comes up once the once-per-round moves are spent, and it drops out
    // entirely while Galvanic Drill is legal. Thunder Vent is not exclusive, so its
    // cooldown works; 30 MP of 60 caps it at two casts.
    p.action_pattern_table = {
      "0": ap("Spiral Drill", "self_has_status", "Hidden", "12"),
      "1": ap("Steam Veil", "self_lacks_status", "Steam Vented", "7"),
      "2": ap("Rending Spin", "self_lacks_status", "Drill Spun", "7"),
      "3": ap("Galvanic Drill", "self_has_status", "Supercharge", "7"),
      "4": ap("Thunder Vent", "self_has_status", "Supercharge", "7", "4"),
      "5": ap("Drill Claw", "always", "", "4"),
    };
    actor.items = [I.CLAW, I.SPIN, I.SPIRAL, I.STEAM, I.GALV, I.VENT, I.CHARGE, I.EMPTY, I.FANG, I.ESSENCE, I.HOUND];
    changes.push([`!actors!${A}`, actor, `${NAME}: stats, affinities, mirrors, AI, steal`]);

    // ── Golem Fist → Iron Colossus ────────────────────────────────────────
    const ic = clone(await need("actors", `!actors!${COLOSSUS}`));
    const fist = clone(await need("actors", ik(OLD_LOOT["Golem Fist"])));
    fist._id = I.IC_FIST;
    changes.push([`!actors.items!${COLOSSUS}.${I.IC_FIST}`, fist, "Iron Colossus: embed Golem Fist"]);
    ic.items = [...ic.items, I.IC_FIST];
    const icp = ic.system.props;
    icp.stealable_loot[I.IC_FIST] = { id: "${item.id}", name: "Golem Fist", uuid: `Actor.${COLOSSUS}.Item.${I.IC_FIST}`, roll: "", loot_description: String(fist.system?.props?.description ?? "") };
    const icRows = Object.values(icp.steal_percentage_table);
    const icEmpty = icRows.find((r) => r.loot_id === "(Empty)");
    if (icEmpty.loot_percentage !== "42") throw new Error("Iron Colossus steal table changed");
    icEmpty.loot_percentage = "36";
    icp.steal_percentage_table[String(Object.keys(icp.steal_percentage_table).length)] = { $deleted: false, loot_id: "Golem Fist", loot_percentage: "6" };
    if (SOLO_ELITES.includes(COLOSSUS)) throw new Error("unexpected");
    changes.push([`!actors!${COLOSSUS}`, ic, "Iron Colossus: Golem Fist 6%, (Empty) 42 → 36"]);

    // ── Charm immunity on the solo elites ─────────────────────────────────
    for (const id of SOLO_ELITES) {
      const e = clone(await need("actors", `!actors!${id}`));
      e.system.props.condition_charm = "IM";
      changes.push([`!actors!${id}`, e, `${e.name}: IM Charm (solo elite rule)`]);
    }
  }, "galvanic-paryashera: actors", "actors");

  // ── items: the Supercharge template ─────────────────────────────────────
  await run(async ({ changes }) => {
    const key = "!items.effects!0rfKFWTyPt7TfUvl.wPkGIdQeP7kpaw8n";
    const ae = clone(await need("items", key));
    if (ae.name !== "Supercharge") throw new Error("wrong AE");
    const ch = (k, mode, value, priority = 20) => ({ key: k, mode, priority, value });
    ae.description = SUPERCHARGE_TEXT;
    ae.changes = [
      ch("check_mod_accuracy", 2, "2"), ch("extra_damage_mod_all", 2, "10"),
      ch("bonus_defense", 2, "2"), ch("bonus_magic_defense", 2, "2"),
      ch("affinity_1", 5, 'aeAffinityFloor("RS")'), ch("affinity_3", 5, 'aeAffinityFloor("IM")'),
      ch("spear_ef", 5, "200"), ch("heavy_ef", 5, "150"), ch("dagger_ef", 5, "150"),
    ];
    ae.flags = { ...ae.flags, [NS]: { ...(ae.flags?.[NS] ?? {}), poseArt: ART_CHARGED } };
    changes.push([key, ae, "Supercharge: new bonuses, no die rise, Supercharged art"]);
  }, "galvanic-paryashera: Supercharge AE", "items");

  // ── tables ──────────────────────────────────────────────────────────────
  await run(async ({ changes, deletes }) => {
    const ENC = "sULKvLErNMF8JtUr", ENE = "hBupoi4SsKj1GmDM";
    const enc = clone(await need("tables", `!tables!${ENC}`));
    const rows = [];
    for (const id of enc.results) rows.push(clone(await need("tables", `!tables.results!${ENC}.${id}`)));
    rows.sort((a, b) => a.range[0] - b.range[0]);
    const kept = [];
    for (const r of rows) {
      const t = String(r.text ?? "");
      if (/^Gigas, Galvanize Golem$/.test(t)) { r.text = "Gigas, Skizzik"; kept.push(r); }
      else if (/Galvanize Golem/.test(t)) deletes.push([`!tables.results!${ENC}.${r._id}`, `Encounter: drop "${t}"`]);
      else kept.push(r);
    }
    if (rows.length - kept.length !== 5) throw new Error("expected 5 pair rows");
    const roper = rows.find((r) => r.text === "Roper");
    const solo = clone(roper); solo._id = "GpEncounterRow01"; solo.text = NAME; solo.name = NAME;
    if ("description" in solo) solo.description = NAME;
    const at = kept.indexOf(roper);
    kept.splice(at + 1, 0, solo);
    let n = 1;
    for (const r of kept) {
      const width = r.range[1] - r.range[0] + 1;
      r.range = [n, n + width - 1]; n += width;
      changes.push([`!tables.results!${ENC}.${r._id}`, r, `Encounter ${r.range.join("-")}: ${r.text}`]);
    }
    enc.results = kept.map((r) => r._id);
    enc.formula = `1d${n - 1}`;
    changes.push([`!tables!${ENC}`, enc, `Encounter: formula ${enc.formula}`]);

    const ene = await need("tables", `!tables!${ENE}`);
    let done = 0;
    for (const id of ene.results) {
      const r = clone(await need("tables", `!tables.results!${ENE}.${id}`));
      if (r.documentId !== A) continue;
      r.text = NAME; if ("name" in r) r.name = NAME; r.img = ART; done++;
      changes.push([`!tables.results!${ENE}.${id}`, r, "Enemies row: renamed"]);
    }
    if (done !== 1) throw new Error("Enemies row not found");
  }, "galvanic-paryashera: tables", "tables");
})().catch((e) => { console.error(e); process.exit(1); });

async function findItem(actorId, name) {
  const db = await openCollection("actors");
  try {
    for await (const [k, v] of db.iterator({ gte: `!actors.items!${actorId}.`, lt: `!actors.items!${actorId}.~` })) {
      if (v?.name === name) return v;
    }
  } finally { await db.close(); }
  throw new Error(`no ${name}`);
}
