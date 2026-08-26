// Invariant sweep over the whole Gorger family, read straight from LevelDB.
const { openCollection } = require("../lib/db");

const THIEF = { PgNX7yW5nxq2emWX: "Mana Gorger", nyHr1MwzRKcGUdyW: "Life Gorger" };
const ELEM = {
  "9yadoDh5EhIWpevl": ["Aero Gorger", "air", "earth", 2, 5],
  zRuXyepUutM2LY9H:   ["Geo Gorger", "earth", "air", 5, 2],
  ERT7381Ood5xdrL9:   ["Pyro Gorger", "fire", "ice", 6, 7],
  s3PZn3F1rEEOfSKG:   ["Cryo Gorger", "ice", "fire", 7, 6],
  YSv1nNWZ5SGDJL5C:   ["Electro Gorger", "bolt", "earth", 3, 5],
  oclPc7ibfLZKdXmg:   ["Phobo Gorger", "dark", "light", 4, 8],
};

let fails = 0, checks = 0;
const ck = (who, label, cond, detail = "") => {
  checks++;
  if (!cond) { fails++; console.log(`  FAIL  ${who.padEnd(16)} ${label}${detail ? " — " + detail : ""}`); }
};

(async () => {
  const db = await openCollection("actors");
  const actors = new Map(), items = new Map(), aes = new Map();
  for await (const [k, v] of db.iterator()) {
    if (k.startsWith("!actors.items.effects!")) {
      const [, a, i] = k.split("!")[2].split(".");
      aes.set(k, v);
    } else if (k.startsWith("!actors.items!")) {
      const aid = k.split("!")[2].split(".")[0];
      if (!items.has(aid)) items.set(aid, []);
      items.get(aid).push(v);
    } else if (k.startsWith("!actors!")) actors.set(v._id, v);
  }

  const all = { ...THIEF };
  for (const id in ELEM) all[id] = ELEM[id][0];

  for (const [id, name] of Object.entries(all)) {
    const a = actors.get(id);
    if (!a) { console.log(`  FAIL  ${name} — ACTOR MISSING`); fails++; continue; }
    const p = a.system.props;
    const its = items.get(id) ?? [];
    const byName = new Map(its.map((i) => [i.name, i]));

    // shared chassis
    ck(name, "level 15", p.level === "15", p.level);
    ck(name, "soldier", p.npc_rank === "soldier", p.npc_rank);
    ck(name, "species ELEMENTAL", p.species === "ELEMENTAL", p.species);
    ck(name, "subtype GORGER", p.subtype_list === "GORGER", p.subtype_list);
    ck(name, "HP 30", p.max_hp === "30" && p.current_hp === "30", `${p.max_hp}/${p.current_hp}`);
    ck(name, "no Zero Power", p.max_zero === "0", p.max_zero);
    ck(name, "art is not a placeholder", /^https:\/\/assets\.forge-vtt\.com/.test(a.img || ""), a.img);
    ck(name, "token art matches actor art", a.prototypeToken?.texture?.src === a.img,
       `${a.prototypeToken?.texture?.src} vs ${a.img}`);
    ck(name, "study text set", (p.study_text || "").length > 40);
    ck(name, "elemental species immunities",
       p.condition_poisoned === "IM" && p.condition_envenomed === "IM" && p.condition_zombie === "IM");
    ck(name, "Slow left OPEN", p.condition_slow === "NA", p.condition_slow);
    ck(name, "derived DEF matches dex+mod",
       Number(p.defense) === Number(p.dex_base) + Number(String(p.def_mod).replace("+", "")),
       `${p.defense} vs ${p.dex_base}${p.def_mod}`);
    ck(name, "derived MDEF matches ins+mod",
       Number(p.magic_defense) === Number(p.ins_base) + Number(String(p.mdef_mod).replace("+", "")),
       `${p.magic_defense} vs ${p.ins_base}${p.mdef_mod}`);

    // every item listed on the actor actually exists, and vice versa
    const listed = new Set(a.items || []);
    const present = new Set(its.map((i) => i._id));
    for (const i of listed) ck(name, `listed item ${i} exists`, present.has(i));
    for (const i of present) ck(name, `stored item ${i} is listed`, listed.has(i));

    // sheet mirrors must point at items that exist
    for (const key of ["attack_list", "normal_spell_list", "skill_active_list", "skill_passive_list", "stealable_loot"]) {
      for (const k of Object.keys(p[key] ?? {})) {
        ck(name, `${key} row ${k} has a backing item`, present.has(k));
      }
    }

    // steal table sums to 100 when there is loot
    const steal = Object.values(p.steal_percentage_table ?? {}).filter((r) => !r.$deleted);
    if (steal.length) {
      const sum = steal.reduce((n, r) => n + Number(r.steal_item_percentage || 0), 0);
      ck(name, "steal table sums to 100", sum === 100, String(sum));
    }

    // AI pattern names must resolve to a real item
    const pat = Object.values(p.action_pattern_table ?? {}).filter((r) => !r.$deleted);
    ck(name, "has an action pattern", pat.length > 0);
    for (const r of pat) {
      ck(name, `pattern "${r.action_pattern_name}" resolves`, byName.has(r.action_pattern_name));
    }

    // every effect_table row referenced by a chain / reaction / on_activate exists
    for (const it of its) {
      const et = it.system?.props?.effect_table ?? {};
      const labels = new Set(Object.values(et).map((r) => r.effect_label).filter(Boolean));
      const rc = it.system?.props?.reaction_config_table ?? {};
      for (const r of Object.values(rc)) {
        if (r.reaction_effect_ref) {
          ck(name, `${it.name}: reaction ref "${r.reaction_effect_ref}"`, labels.has(r.reaction_effect_ref));
        }
      }
      const oa = it.system?.props?.on_activate_effect_ref;
      if (oa) ck(name, `${it.name}: on_activate ref "${oa}"`, labels.has(oa));
      for (const r of Object.values(et)) {
        for (const step of String(r.chain_steps ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
          ck(name, `${it.name}: chain step "${step}"`, labels.has(step));
        }
        const tr = String(r.target_ref ?? "").trim();
        const RESERVED = new Set(["self", "action_targets", "hit_action_targets", "cause_actor",
          "trigger_actor", "trigger_attacker", "trigger_subject", "save_failed_targets"]);
        if (tr && !RESERVED.has(tr)) {
          ck(name, `${it.name}: target_ref "${tr}"`, labels.has(tr));
        }
      }
      // an Eaten AE referenced by name must be embedded somewhere on this actor
      for (const r of Object.values(et)) {
        if (r.effect_kind === "apply_ae" && r.ae_template_ref === "Eaten") {
          const hasEaten = its.some((x) => (x.effects || []).some((e) =>
            aes.get(`!actors.items.effects!${id}.${x._id}.${e}`)?.name === "Eaten"));
          ck(name, `${it.name}: Eaten AE is embedded`, hasEaten);
        }
      }
    }
  }

  // elemental-specific
  for (const [id, [name, el, vu, ai, vi]] of Object.entries(ELEM)) {
    const a = actors.get(id); if (!a) continue;
    const p = a.system.props;
    ck(name, `AB ${el}`, p[`affinity_${ai}`] === "AB", p[`affinity_${ai}`]);
    ck(name, `VU ${vu}`, p[`affinity_${vi}`] === "VU", p[`affinity_${vi}`]);
    ck(name, "MP 60", p.max_mp === "60", p.max_mp);
    ck(name, "exactly one AB", Object.keys(p).filter((k) => /^affinity_\d$/.test(k) && p[k] === "AB").length === 1);
    ck(name, "exactly one VU", Object.keys(p).filter((k) => /^affinity_\d$/.test(k) && p[k] === "VU").length === 1);
    const its = items.get(id) ?? [];
    const puff = its.find((i) => i.name === "Puff Up");
    ck(name, "Puff Up is a Passive", puff?.system?.props?.skill_type === "Passive", puff?.system?.props?.skill_type);
    ck(name, "Puff Up on turn_start/self",
       Object.values(puff?.system?.props?.reaction_config_table ?? {})
         .some((r) => r.reaction_trigger === "turn_start" && r.reaction_source === "self"));
    ck(name, "Puff Up has no legacy AE config",
       Object.keys(puff?.system?.props?.active_effect_config_table ?? {}).length === 0);
    const spell = its.find((i) => i.system?.props?.skill_type === "Spell");
    ck(name, "spell is NPC-castable",
       spell?.system?.props?.isOffensiveSpell === true && spell?.system?.props?.isCheck === true);
    ck(name, "spell damage normalised to 15", spell?.system?.props?.damage_bonus === "15",
       spell?.system?.props?.damage_bonus);
    const boom = its.find((i) => /Explosion$/.test(i.name));
    ck(name, "explosion on creature_defeated/self",
       Object.values(boom?.system?.props?.reaction_config_table ?? {})
         .some((r) => r.reaction_trigger === "creature_defeated" && r.reaction_source === "self"));
    const consume = its.find((i) => /^Consume /.test(i.name));
    ck(name, "absorb rides creature_gain_resource (NOT the dead absorb trigger)",
       Object.values(consume?.system?.props?.reaction_config_table ?? {})
         .some((r) => r.reaction_trigger === "creature_gain_resource"));
    ck(name, "absorb gated on its own element",
       Object.values(consume?.system?.props?.reaction_config_table ?? {})
         .some((r) => String(r.condition_formula).includes(`TRIGGER_DAMAGE_IS_${el.toUpperCase()}`)));
  }

  // thief-specific
  for (const [id, name] of Object.entries(THIEF)) {
    const a = actors.get(id); if (!a) continue;
    const p = a.system.props;
    ck(name, "MP 200", p.max_mp === "200", p.max_mp);
    ck(name, "init 12", p.init === "12", p.init);
    ck(name, "arcane_ef 125", p.arcane_ef === "125", p.arcane_ef);
    ck(name, "other EF 75", p.sword_ef === "75" && p.bow_ef === "75", `${p.sword_ef}/${p.bow_ef}`);
    const its = items.get(id) ?? [];
    const run = its.find((i) => i.name === "Run Away");
    ck(name, "has Run Away", !!run);
    const et = Object.values(run?.system?.props?.effect_table ?? {});
    ck(name, "Run Away uses group_check", et.some((r) => r.effect_kind === "group_check"));
    ck(name, "group_check var is lowercase (VAR_ reads lowercased)",
       et.filter((r) => r.effect_kind === "group_check").every((r) => r.gc_var === String(r.gc_var).toLowerCase()),
       JSON.stringify(et.find((r) => r.effect_kind === "group_check")?.gc_var));
    ck(name, "leave_combat gated on the check", et.some((r) =>
      r.effect_kind === "leave_combat" && String(r.condition_formula).includes("VAR_ESCAPE")));
    const residue = its.find((i) => /Residue$/.test(i.name));
    ck(name, "residue targets the killer", Object.values(residue?.system?.props?.effect_table ?? {})
      .some((r) => r.target_ref === "cause_actor"));
  }

  await db.close();
  console.log(`\n${checks - fails}/${checks} checks passed${fails ? ` — ${fails} FAILED` : " — all clean"}`);
  process.exit(fails ? 1 : 0);
})();
