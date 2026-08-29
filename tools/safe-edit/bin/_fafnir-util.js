// Shared runner + actor-blanking for the Fafnir Castle roster.
// Lifted from _dragon-util.js (Valley of the Dragon) with one change: `run`
// takes the COLLECTION to write, because this build touches folders, items
// (the AE library) and tables as well as actors.
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const journal = require("../lib/journal");

const APPLY = process.argv.includes("--apply");

// Blank a donor actor BY RULE, never by hand — the CSB template carries zero
// props, so there is no "empty defaults" doc to copy. Every prop family gets
// its neutral value; then the caller sets only what this monster actually has.
function blankActor(donor, id, name, folder, art, tokenScale) {
  const a = JSON.parse(JSON.stringify(donor));
  a._id = id;
  a.name = name;
  a.folder = folder;
  a.img = art;
  a.items = [];
  a.sort = 0;
  a.ownership = { default: 0 };
  if (a._stats) { a._stats.createdTime = null; a._stats.modifiedTime = null; a._stats.duplicateSource = null; }

  const p = a.system.props;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (/^condition_/.test(k)) { p[k] = "NA"; continue; }
    if (/^affinity_[1-9]$/.test(k)) { p[k] = "NA"; continue; }
    if (/_ef$/.test(k)) { p[k] = "100"; continue; }
    if (/^(extra_damage_mod_|damage_receiving_mod_|check_mod_)/.test(k)) { p[k] = 0; continue; }
    if (typeof v === "boolean") { p[k] = false; continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) { p[k] = {}; continue; }
  }

  // Identity + art. All EIGHT image fields, or the monster is half-dressed
  // somewhere; a clone otherwise keeps the DONOR's URL in the six props ones.
  p.name = name;
  p.id = id;
  if ("uuid" in p) p.uuid = `Actor.${id}`;
  p.study_text = "";
  p.img = art;
  p.sprite_standard = art;
  p.sprite_battle = art;
  p.cut_in_critical = art;
  p.cut_in_fumble = art;
  p.cut_in_zero_power = art;

  a.prototypeToken = JSON.parse(JSON.stringify(donor.prototypeToken ?? {}));
  a.prototypeToken.name = name;
  a.prototypeToken.actorId = id;
  a.prototypeToken.texture = a.prototypeToken.texture ?? {};
  a.prototypeToken.texture.src = art;
  a.prototypeToken.texture.scaleX = tokenScale;
  a.prototypeToken.texture.scaleY = tokenScale;

  // Nothing of the donor's name or art may survive anywhere in the doc.
  const blob = JSON.stringify(a);
  if (blob.includes(donor.name)) throw new Error(`donor name "${donor.name}" survives in ${name}`);
  const donorArt = donor.img ?? "";
  if (donorArt && blob.includes(donorArt)) throw new Error(`donor art survives in ${name}`);
  if (blob.includes(donor._id)) throw new Error(`donor id ${donor._id} survives in ${name}`);
  return a;
}

// Clone-don't-construct for a skill item. Every inherited automation table is
// cleared before the caller's overrides land, so no donor wiring leaks through.
function makeSkill(src, actorId, id, name, img, props) {
  const d = JSON.parse(JSON.stringify(src));
  d._id = id; d.name = name; d.img = img; d.effects = [];
  d.folder = null; d.ownership = { default: 0 };
  if (d._stats) { d._stats.createdTime = null; d._stats.modifiedTime = null; d._stats.duplicateSource = null; }
  for (const k of ["reaction_config_table", "effect_table", "optional_params", "active_effect_config_table"]) {
    d.system.props[k] = {};
  }
  Object.assign(d.system.props, {
    name, img, id: "${item.id}", uuid: `Actor.${actorId}.Item.${id}`,
    level: "1", max_level: "1", class: "NPC",
    heroic_requirement: "", skill_information: "",
    isFacet: false, isHeroic: false, isZeroPower: false, ignore_hr: false,
    use_optional_params: false,
    skill_animation_mode: "default", skill_animation_default: "", animation_script: "",
    animation_damage_timing_options: "default", animation_damage_timing_offset: "0",
    on_activate_effect_ref: "",
    ae_chance_percent: "", ae_template_ref: "",
  }, props);
  return d;
}

// `collection` is the LevelDB collection every change key belongs to; a run
// writes exactly one. `label` names the run in the safe-edit journal.
async function run(build, label, collection = "actors") {
  const changes = [];
  await build({ changes });

  const ID_OK = /^[A-Za-z0-9]{16}$/;
  for (const [key] of changes) {
    for (const seg of key.split("!").pop().split(".")) {
      if (!ID_OK.test(seg)) throw new Error(`bad document id "${seg}" in key ${key} (must be 16 chars of [A-Za-z0-9])`);
    }
  }

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${changes.length} writes to "${collection}"\n`);
  for (const [key, , note] of changes) console.log(`  ${key}\n    ${note}`);

  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }

  const backupPath = snapshotCollection(collection);
  console.log(`\nbackup: ${backupPath}`);
  const db = await openCollection(collection);
  try {
    for (const [key, value] of changes) await db.put(key, value);
  } finally {
    await db.close();
  }
  journal.append({
    uuid: `collection:${collection}`, collection, key: changes.map((c) => c[0]).join(","),
    beforeHash: null, afterHash: null, backupPath, patch: null,
    note: `${label}: ${changes.length} docs — ${changes.map((c) => c[2]).join("; ")}`,
  });
  console.log(`\nwrote ${changes.length} docs`);
}

module.exports = { blankActor, makeSkill, run, APPLY };
