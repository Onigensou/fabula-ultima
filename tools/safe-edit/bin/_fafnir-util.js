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
// A build may also DELETE keys — a rework that drops an item has to, or the doc
// survives in the keyspace while the actor's items[] no longer lists it, which
// is an orphan the sheet can still render. `deletes` is [key, note] pairs and is
// optional; a build that never pushes one behaves exactly as before.
async function run(build, label, collection = "actors") {
  const changes = [];
  const deletes = [];
  await build({ changes, deletes });

  const ID_OK = /^[A-Za-z0-9]{16}$/;
  for (const [key] of changes.concat(deletes)) {
    for (const seg of key.split("!").pop().split(".")) {
      if (!ID_OK.test(seg)) throw new Error(`bad document id "${seg}" in key ${key} (must be 16 chars of [A-Za-z0-9])`);
    }
  }
  // A key on both sides means the build both writes and drops it — always a
  // bug, and the outcome would depend on statement order.
  const written = new Set(changes.map((c) => c[0]));
  for (const [key] of deletes) {
    if (written.has(key)) throw new Error(`key is both written and deleted: ${key}`);
  }

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${changes.length} writes`
    + (deletes.length ? `, ${deletes.length} deletes` : "") + ` to "${collection}"\n`);
  for (const [key, , note] of changes) console.log(`  ${key}\n    ${note}`);
  for (const [key, note] of deletes) console.log(`  DELETE ${key}\n    ${note}`);

  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }

  const backupPath = snapshotCollection(collection);
  console.log(`\nbackup: ${backupPath}`);
  const db = await openCollection(collection);
  let preserved = 0;
  try {
    // ── Carry animations across a rebuild ────────────────────────────────
    // A monster build writes WHOLE documents, so re-running one silently
    // discarded every animation_script that _build-dungeon-animations.js had
    // authored. That is exactly what happened to Rakshasa: the Crisis rework
    // rebuilt the actor and blanked all four shipped animations, and the loss
    // was invisible — the export report counts it as a MODIFIED doc, not a
    // removal, so the "no removals, safe to submit" gate passed and it shipped.
    //
    // The two tools own different fields, so the mechanics build no longer gets
    // to speak for the animation one: whatever is already on disk wins for these
    // keys unless the build explicitly sets them.
    const ANIM_KEYS = ["animation_script", "skill_animation_mode", "animation_preload_urls",
                       "animation_damage_timing_options", "animation_damage_timing_offset"];
    for (const change of changes) {
      const [key, value] = change;
      if (!/^!actors\.items!/.test(key)) continue;
      const props = value?.system?.props;
      if (!props) continue;
      let existing = null;
      try { existing = await db.get(key); } catch (e) { existing = null; }
      const old = existing?.system?.props;
      if (!old) continue;
      for (const k of ANIM_KEYS) {
        const incoming = props[k];
        const blank = incoming == null || incoming === "" || incoming === "default";
        if (blank && old[k] != null && old[k] !== "" && old[k] !== "default") {
          props[k] = old[k];
          preserved++;
        }
      }
    }

    for (const [key, value] of changes) await db.put(key, value);
    for (const [key] of deletes) await db.del(key);
  } finally {
    await db.close();
  }
  if (preserved) console.log(`preserved ${preserved} animation field(s) from the existing docs`);
  journal.append({
    uuid: `collection:${collection}`, collection,
    key: changes.map((c) => c[0]).concat(deletes.map((d) => d[0])).join(","),
    beforeHash: null, afterHash: null, backupPath, patch: null,
    note: `${label}: ${changes.length} docs`
      + (deletes.length ? `, ${deletes.length} deleted` : "")
      + ` — ${changes.map((c) => c[2]).concat(deletes.map((d) => "DELETE " + d[1])).join("; ")}`,
  });
  console.log(`\nwrote ${changes.length} docs`
    + (deletes.length ? `, deleted ${deletes.length}` : ""));
}

module.exports = { blankActor, makeSkill, run, APPLY };
