#!/usr/bin/env node
"use strict";
// ============================================================================
// Glacial Staff + Sunflower Staff rework and the 11-07 item fixes (user-approved 2026-11-10).
//
//   node bin/_build-staves-2026-11-10.js            # dry run: prints every change, writes nothing
//   node bin/_build-staves-2026-11-10.js --write    # snapshot items+actors, then write (GAME CLOSED)
//
// What it does (every copy: world item + every actor-embedded copy, matched by name):
//   Glacial Staff   Uncommon; swing vs MDEF; house-convention text + flavor.
//   Icicle Lance    (only the copies inside a Glacial Staff) One Creature, 15 MP, HR + 25, Pierce kept;
//                   animation tools/anim-studio/glacial-icicle-lance.js.
//   Sunflower Staff text (flavor typos only), set placeholder cleared, linked-skill list rebuilt;
//                   NEW contained "Sunflower Staff (Passive)": any creature takes Light damage → +1 Solar
//                   Charge (max 5), once per action (reaction_max_scope "action"), never from Solar Beam
//                   itself (reaction_origin_filter "!Solar Beam"), then play_animation of itself
//                   (tools/anim-studio/sunflower-solar-charge.js).
//   Solar Beam      (only the copies inside a Sunflower Staff) All Enemy, no menu, no reaction;
//                   floor(15 × charges ÷ enemies) Light to each; availability "No Solar Charge";
//                   Solar Charge AE max 5; animation tools/anim-studio/sunflower-solar-beam.js.
//   Dragontrap Bow  text: lands on the hit, Grounded until the end of the round; passive force (was ask).
//   Ancient Bone / Slayer's Blood  props.name fixed (was "Eisendrache Seal").
//   Dragonskull Helm / Draconic Roar / Punishment (+Passive) / The Wasp / Turbo Tonic  text tidy.
// Links are the house's fully-styled snippets, harvested from the authored export at run time.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const LIB = path.resolve(__dirname, "..", "..", "anim-studio", "lib");
const { encode, validate } = require(path.join(LIB, "encode.js"));
const ANIM = path.resolve(__dirname, "..", "..", "anim-studio");
const EXPORT = path.resolve(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "_authored-export");
const WRITE = process.argv.includes("--write");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const PX = FORGE + "Animation/pixelfx/";
const layers = (b, ls) => ls.map((l) => `${PX}${b}_${l}.webm`);

// ── Styled links (most common exact snippet per uuid in authored text) ─────────
function harvestLinks() {
  const texts = [];
  const walk = (o) => { if (!o || typeof o !== "object") return; for (const v of Object.values(o)) { if (typeof v === "string" && v.includes("content-link")) texts.push(v); else walk(v); } };
  for (const dir of ["items", "actors"]) for (const f of fs.readdirSync(path.join(EXPORT, dir))) { try { walk(JSON.parse(fs.readFileSync(path.join(EXPORT, dir, f), "utf8"))); } catch {} }
  const re = /<span style="text-decoration: underline;"><span style="font-family: Signika, sans-serif">(?:(?!<\/a>).)*?data-uuid="([^"]+)"(?:(?!<\/a>).)*?<\/a><\/span><\/span>/gs;
  const by = {};
  for (const t of texts) for (const m of t.matchAll(re)) { (by[m[1]] ||= new Map()).set(m[0], (by[m[1]].get(m[0]) || 0) + 1); }
  const out = {};
  for (const [u, mp] of Object.entries(by)) out[u] = [...mp.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return out;
}
const L = harvestLinks();
const link = (uuid) => { if (!L[uuid]) throw new Error("no styled link harvested for " + uuid); return L[uuid]; };
const MAGIC = link("JournalEntry.XYQUsuXPU0CQjEYa"), ICE = link("Item.Osq3NN3QCtiW7otU"), LIGHT = link("Item.IQaK3IzvfFp4I1xB");
const FLYING = link("JournalEntry.q6keqwDWUsEgSWDw"), COMBO = link("JournalEntry.noUOPxPoZq65yYxV");
const grant = (verb, emoji, worldSkillId, name) => `${verb} 【${emoji}<strong>@UUID[Item.${worldSkillId}]{${name}}</strong>】`;

// ── Animation scripts ─────────────────────────────────────────────────────────
function script(file) {
  const src = fs.readFileSync(path.join(ANIM, file), "utf8");
  const r = validate(src);
  if (!r.ok) throw new Error(`${file} invalid: ${r.errors.join("; ")}`);
  return encode(src);
}
const ANIM_LANCE = script("glacial-icicle-lance.js");
const ANIM_BEAM = script("sunflower-solar-beam.js");
const ANIM_CHARGE = script("sunflower-solar-charge.js");

// ── Texts ─────────────────────────────────────────────────────────────────────
const WORLD = { lance: "HvZLpWcS87pzh7b8", beam: "WQzVAB1xoaPdDTS7", roar: "hIiWUGkuayYqQNeb" };
const T = {
  glacialDesc: `<ul><li><p>This weapon deals ${MAGIC}</p></li><li><p>You may ${grant("cast the spell", "⚡", WORLD.lance, "Icicle Lance")}</p></li></ul>`,
  glacialFlavor: `<p><em>A staff of rime-glazed wood capped with a frozen crystal. Its tip never stops dripping, and every drop freezes before it lands.</em></p>`,
  lanceDesc: `<p>Deals <strong>【HR + 25】</strong>${ICE}&nbsp;damage.</p>`,
  sunDesc: `<ul><li><p>Whenever one or more creatures take ${LIGHT}&nbsp;damage, gain <strong>1 Solar Charge</strong> (once per instance, up to <strong>5</strong>).</p></li><li><p>You may ${grant("cast the spell", "⚡", WORLD.beam, "Solar Beam")}</p></li></ul>`,
  sunPassiveDesc: `<ul><li><p>Whenever one or more creatures take ${LIGHT}&nbsp;damage, gain <strong>1 Solar Charge</strong> (once per instance, up to <strong>5</strong>).</p></li></ul>`,
  sunFlavor: `<p><em>A mythical staff shaped like a sunflower. It allows the user to channel energy from the sun itself directly.</em></p>`,
  beamDesc: `<p>Consume all your <strong>Solar Charge</strong>. Deal <strong>【15 × Solar Charge consumed】</strong>${LIGHT}&nbsp;damage, divided evenly among all enemies (rounded down). You can't cast this spell without Solar Charge.</p>`,
  trapDesc: `<ul><li><p>When you hit a ${FLYING}&nbsp;target with this weapon, it lands at once and is <strong>Grounded</strong> until the end of the round.</p></li></ul>`,
  helmDesc: `<ul><li><p><strong>+1 DEF / +1 MDEF</strong></p></li><li><p>You may ${grant("perform the skill", "💥", WORLD.roar, "Draconic Roar")}</p></li></ul>`,
  roarDesc: `<p>Deals <strong>【HR + 13】</strong> non-elemental damage to all enemies and inflicts each with a random <strong>basic debuff</strong>. An enemy whose level is lower than yours suffers a <strong>stronger debuff</strong> instead.</p>`,
  punishDesc: `<ul><li><p>This weapon deals <strong>5</strong> extra damage for each debuff you are suffering from.</p></li></ul>`,
  waspDesc: `<ul><li><p>${COMBO}<strong>&nbsp;3</strong></p></li><li><p>Attacks with this weapon don't add your <strong>High Roll</strong> to their damage.</p></li></ul>`,
  tonicDesc: `<ul><li><p>Removes every <strong>debuff</strong> from all allies.</p></li></ul>`,
};

// ── Solar Beam rows ───────────────────────────────────────────────────────────
const SOLAR_AE = `Item.${WORLD.beam}.ActiveEffect.RQxY4Y3L9lvsPGCJ`;
function beamEffectTable() {
  const t = { "0": { effect_kind: "chain", effect_label: "solar_fire", chain_steps: "solar_dmg_1, solar_dmg_2, solar_dmg_3, solar_dmg_4, solar_dmg_5, solar_spend" } };
  for (let n = 1; n <= 5; n++) t[String(n)] = {
    effect_kind: "deal_damage", effect_label: `solar_dmg_${n}`, target_ref: "action_targets",
    condition_formula: n < 5 ? `AE_CHARGES_SOLAR_CHARGE == ${n}` : "AE_CHARGES_SOLAR_CHARGE >= 5",
    damage_amount: `floor(${15 * n} / max(1, ACTION_TARGET_COUNT))`, damage_cause: "damage", damage_element: "light",
  };
  t["6"] = { effect_kind: "remove_ae", effect_label: "solar_spend", ae_template_ref: "Solar Charge", count: "all", include_persistent: true, target_ref: "self" };
  return t;
}

// ── Per-item edits. ctx: { coll, key, owner, containerName } ─────────────────
const EDITS = [];
const on = (name, fn, when = () => true) => EDITS.push({ name: name.toLowerCase(), fn, when });

on("glacial staff", (d) => {
  const p = d.system.props;
  p.item_rarity = "Uncommon"; p.defense_target_type = "mdef";
  p.description = T.glacialDesc; p.flavor_text = T.glacialFlavor;
  if ("isSet" in p) p.isSet = false; if ("set_name" in p) p.set_name = "";
});
on("icicle lance", (d) => {
  const p = d.system.props;
  p.skill_target = "One Creature"; p.cost = "15 MP"; p.damage_bonus = 25; p.action_keywords = "pierce";
  p.description = T.lanceDesc; if ("skill_description" in p) p.skill_description = T.lanceDesc;
  p.animation_script = ANIM_LANCE; p.animation_damage_timing_options = "default"; p.animation_damage_timing_offset = 0;
  p.animation_preload_urls = [...layers("pxfx_ice_glacial_lance", ["back", "front", "light"]), FORGE + "Animation/RPG%20Maker%20MV/004_hit_ice.webm"].join("\n");
}, (c) => c.containerName === "glacial staff");

on("sunflower staff", (d, c) => {
  const p = d.system.props;
  p.description = T.sunDesc; p.flavor_text = T.sunFlavor; p.isSet = false; p.set_name = "";
  // the linked-skill lists: only the live Solar Beam (the 5 MP one is a leftover) + the new passive
  const beamDesc = T.beamDesc;
  p.item_skill_active = { [WORLD.beam]: { id: "${item.id}", name: "Solar Beam", skill_cost: "10 MP", skill_description: beamDesc, skill_maxLevel: 1, uuid: `Item.${WORLD.beam}` } };
  p.related_item_list = { [WORLD.beam]: { id: "${item.id}", name: "Solar Beam", related_item_description: beamDesc, uuid: `Item.${WORLD.beam}` } };
});
on("solar beam", (d) => {
  const p = d.system.props;
  p.skill_target = "All Enemy"; p.cost = "10 MP"; p.isOffensiveSpell = true;
  p.description = T.beamDesc; if ("skill_description" in p) p.skill_description = T.beamDesc;
  p.effect_table = beamEffectTable(); p.on_activate_effect_ref = "solar_fire";
  p.reaction_config_table = {}; p.isReaction = false;
  p.availability_formula = "AE_COUNT_SOLAR_CHARGE > 0"; p.availability_reason = "No Solar Charge";
  p.animation_script = ANIM_BEAM; p.animation_damage_timing_options = "default"; p.animation_damage_timing_offset = 0;
  p.animation_preload_urls = [...layers("pxfx_light_solar_charge", ["front", "light"]), ...layers("pxfx_light_solar_cannon", ["front", "light"])].join("\n");
  for (const e of d.effects || []) if (e.name === "Solar Charge") {
    const f = (e.flags ||= {})["fabula-ultima-companion"] ||= {};
    f.chargesMax = 5;
  }
}, (c) => c.containerName === "sunflower staff");

on("dragontrap bow", (d) => { d.system.props.description = T.trapDesc; });
on("dragontrap bow (passive)", (d) => {
  const p = d.system.props;
  p.description = T.trapDesc; if ("skill_description" in p) p.skill_description = T.trapDesc;
  for (const r of Object.values(p.reaction_config_table || {})) if (r && !r.$deleted) r.reaction_passive_mode = "force";
});
on("ancient bone", (d) => { d.system.props.name = "Ancient Bone"; });
on("slayer's blood", (d) => { d.system.props.name = "Slayer's Blood"; });
on("dragonskull helm", (d) => {
  const p = d.system.props; p.description = T.helmDesc; p.isSet = false; p.set_name = "";
  for (const k of ["item_skill_active", "related_item_list"]) for (const v of Object.values(p[k] || {})) {
    if ("skill_description" in v) v.skill_description = T.roarDesc; if ("related_item_description" in v) v.related_item_description = T.roarDesc;
  }
});
on("draconic roar", (d) => { const p = d.system.props; p.description = T.roarDesc; if ("skill_description" in p) p.skill_description = T.roarDesc; });
on("punishment", (d) => { d.system.props.description = T.punishDesc; });
on("punishment (passive)", (d) => { const p = d.system.props; p.description = T.punishDesc; if ("skill_description" in p) p.skill_description = T.punishDesc; });
on("the wasp", (d) => { d.system.props.description = T.waspDesc; });
on("turbo tonic", (d) => {
  const p = d.system.props; p.description = T.tonicDesc; if ("skill_description" in p) p.skill_description = T.tonicDesc;
  for (const k of ["item_skill_active", "related_item_list"]) for (const v of Object.values(p[k] || {})) {
    if ("skill_description" in v) v.skill_description = T.tonicDesc; if ("related_item_description" in v) v.related_item_description = T.tonicDesc;
  }
});

// ── The new contained passive (cloned from Razor Plume (Passive)) ─────────────
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const mintId = () => Array.from({ length: 16 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");
function makePassive(shell, id, containerId, uuid, img) {
  const d = JSON.parse(JSON.stringify(shell));
  d._id = id; d.name = "Sunflower Staff (Passive)"; d.img = img;
  d.system.container = containerId; d.system.uniqueId = id;
  d._stats = { ...(d._stats || {}), createdTime: Date.now(), modifiedTime: Date.now(), duplicateSource: null, compendiumSource: null };
  d.effects = [];
  const p = d.system.props;
  for (const k of Object.keys(p)) if (/^animation_|^description$|^skill_description$|^effect_table$|^reaction_config_table$/.test(k)) delete p[k];
  Object.assign(p, {
    name: d.name, id, uuid, img, skill_type: "Passive", skill_target: "Self", isReaction: true, isCheck: false,
    description: T.sunPassiveDesc, skill_description: T.sunPassiveDesc,
    reaction_config_table: { "0": {
      reaction_trigger: "creature_lose_resource", reaction_source: "all", reaction_resource_filter: "hp", reaction_cause_filter: "damage",
      reaction_origin_filter: "!Solar Beam", condition_formula: "TRIGGER_DAMAGE_IS_LIGHT == 1",
      reaction_passive_mode: "force", reaction_max_per_round: "1", reaction_max_scope: "action", reaction_effect_ref: "sun_charge",
    } },
    effect_table: {
      "0": { effect_kind: "chain", effect_label: "sun_charge", chain_steps: "sun_add, sun_anim" },
      "1": { effect_kind: "apply_ae", effect_label: "sun_add", ae_template_ref: SOLAR_AE, ae_duplicate_mode: "add_charges", ae_initial_charges: "1", ae_initial_charges_max: "5", target_ref: "self" },
      "2": { effect_kind: "play_animation", effect_label: "sun_anim", action_ref: "Sunflower Staff (Passive)", target_ref: "trigger_subject" },
    },
    animation_script: ANIM_CHARGE, animation_damage_timing_options: "default", animation_damage_timing_offset: 0,
  });
  return d;
}

async function main() {
  console.log(`scripts: lance ${ANIM_LANCE.length}b, beam ${ANIM_BEAM.length}b, charge ${ANIM_CHARGE.length}b stored`);
  if (WRITE) for (const c of ["items", "actors"]) console.log("snapshot", c, "→", snapshotCollection(c));
  const plan = [];   // [coll, key, doc, label]
  const adds = [];   // new passive docs: [coll, key, doc]
  const actorAdds = []; // [actorKey, newItemId]
  let shell = null;
  for (const coll of ["items", "actors"]) {
    const db = await openCollection(coll);
    try {
      const prefix = coll === "items" ? "!items!" : "!actors.items!";
      const all = [];
      for await (const [key, val] of db.iterator()) if (key.startsWith(prefix)) all.push([key, val]);
      if (coll === "items") shell = all.find(([, v]) => v._id === "r5YlGxjwTfvpt5yM")?.[1];
      const byId = new Map(all.map(([k, v]) => [(coll === "items" ? "" : k.split("!")[2].split(".")[0] + ".") + v._id, v]));
      const ownerOf = (k) => coll === "items" ? "" : k.split("!")[2].split(".")[0];
      for (const [key, doc] of all) {
        const nm = String(doc.name ?? "").toLowerCase();
        const cont = doc.system?.container ? byId.get((coll === "items" ? "" : ownerOf(key) + ".") + doc.system.container) : null;
        const ctx = { coll, key, owner: ownerOf(key), containerName: String(cont?.name ?? "").toLowerCase() };
        for (const e of EDITS) if (e.name === nm && e.when(ctx)) {
          const next = JSON.parse(JSON.stringify(doc)); e.fn(next, ctx);
          plan.push([coll, key, next, `${doc.name} (${coll === "items" ? "world" : "actor " + ctx.owner})`]);
          if (nm === "sunflower staff") {
            const hasPassive = all.some(([, v]) => v.system?.container === doc._id && v.name === "Sunflower Staff (Passive)");
            if (!hasPassive) {
              const id = mintId();
              const uuid = coll === "items" ? `Item.${id}` : `Actor.${ctx.owner}.Item.${id}`;
              adds.push([coll, coll === "items" ? `!items!${id}` : `!actors.items!${ctx.owner}.${id}`, { id, containerId: doc._id, uuid, img: doc.img }]);
              if (coll === "actors") actorAdds.push([`!actors!${ctx.owner}`, id]);
            }
          }
        }
      }
    } finally { await db.close(); }
  }
  if (!shell) throw new Error("passive shell Razor Plume (Passive) r5YlGxjwTfvpt5yM not found");
  for (const [coll, key, , label] of plan) console.log((WRITE ? "  ✓ " : "  [dry] ") + label.padEnd(44) + key);
  for (const [coll, key] of adds) console.log((WRITE ? "  + " : "  [dry +] ") + "Sunflower Staff (Passive)".padEnd(44) + key);
  if (!WRITE) { console.log(`\n${plan.length} docs to update, ${adds.length} passives to create. Dry run — pass --write (GAME CLOSED).`); return; }

  for (const coll of ["items", "actors"]) {
    const db = await openCollection(coll);
    try {
      for (const [c, key, doc] of plan) if (c === coll) await db.put(key, doc);
      for (const [c, key, a] of adds) if (c === coll) await db.put(key, makePassive(shell, a.id, a.containerId, a.uuid, a.img));
      for (const [actorKey, id] of actorAdds) if (coll === "actors") {
        const actor = await db.get(actorKey);
        if (!actor.items.includes(id)) { actor.items.push(id); await db.put(actorKey, actor); }
      }
    } finally { await db.close(); }
  }
  console.log(`\nwrote ${plan.length} updates + ${adds.length} new passives.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
