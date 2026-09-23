#!/usr/bin/env node
"use strict";

// ===========================================================================
// _backfill-skill-targets — fill the blank `skill_target` on 15 skills.
//
//   node tools/safe-edit/bin/_backfill-skill-targets.js [--apply]
//
// Default is DRY RUN. Pass --apply to write.
//
// WHY THESE 15
//   `skill-validate` reports SKILL_TARGET_BLANK on activatable skills with no
//   declared target. A blank self-locks the skill: compose-action.js:903 reads
//   blank as SELF, so a damage skill silently targets its own caster and can
//   never resolve the enemy it is written to hit. User ruling 2026-09-22:
//   "There should be skill target on everything, even self."
//
// WHY MASTERS *AND* COPIES
//   reaction-config-lint's MASTER_COPY_FIELD_DRIFT fires when an actor copy
//   disagrees with its master. Fixing only masters would trade one finding for
//   another, so every document carrying the blank moves together — 28 in all.
//
// EACH TARGET WAS READ OFF THE SKILL'S OWN RAW TEXT, then checked against the
// parser that consumes it (`target-survey.js` + `compose-action.js`), because
// authoring a string the engine mis-reads is worse than leaving it blank:
//
//   side   compose-action.js:920-924 — /creature/ → any, /enem/ → enemy,
//          /\ball(?:y|ies)\b/ → ally, else the action-intent tiebreaker.
//   mode   target-survey.js:217-233  — /\brandom\b/ → random, /\ball\b/ → all,
//          /up to/ → up_to, else exact.
//   count  extractTargetCountFromText — strips the trailing noun, then reads a
//          number word ("One" → 1) or evaluates the rest as a formula.
//   self   isSelfTargetText — blank or /^self$/i.
//
// Two traps that decided the exact strings:
//   • "One Ally" does NOT trip the `all` mode regex — `\ball\b` needs a word
//     boundary after "all", and "Ally" continues with "y". Verified.
//   • "All Enemy" trips BOTH `\ball\b` (mode all) and /enem/ (side enemy),
//     which is the intended combination.
// ===========================================================================

const path = require("path");
const { safeEdit, getDoc } = require(path.join(__dirname, "..", "lib", "edit.js"));

const WORLD = "fabula-ultima-2";
const APPLY = process.argv.includes("--apply");

// name -> authored skill_target, with the RAW line that justifies it.
const PLAN = {
  "Anchor Smash":           ["One Enemy", "free attack with an equipped melee weapon"],
  "Arm Hook":               ["One Enemy", "Choose 1 enemy … inflicts Grappled"],
  "Atmokinesis":            ["Self",      "modifies the damage YOU deal"],
  "Barrel Bomb":            ["All Enemy", "All enemy take 30 Fire damage"],
  "Blood Chalice":          ["Self",      "Reduce all condition timer ON YOU by 1"],
  "Boardside Cannon Salvo": ["All Enemy", "to all enemy present in the scene"],
  "Cursed Dagger":          ["One Enemy", "Inflict Curse on you and the target"],
  "Gamble":                 ["Special",   "roll-determined effects; resolves its own targeting"],
  "Grenadose":              ["One Enemy", "Target creature take 20 Fire Throw damage"],
  "Hook Throw":             ["One Enemy", "Inflict Stagger on a target"],
  "Magic Conch":            ["One Ally",  "Choose 1 ally. They gain +3 on next attack roll"],
  "Magic Monocular":        ["One Enemy", "Perform a Study action"],
  "Phantom Snipe":          ["One Enemy", "free attack against one creature with a firearm"],
  "Psychic Shield":         ["Self",      "treat YOUR Defense / Magic Defense as …"],
  "Spare Bullet":           ["One Enemy", "free attack with an equipped ranged weapon"],
};

// Built by the same walk the plan was reviewed from, so the script cannot drift
// from what was approved: every doc whose skill_target is still blank.
const fs = require("fs");
const EXPORT = path.resolve(__dirname, "..", "..", "..", "worlds", WORLD, "_authored-export");

// 🚨 The export ENUMERATES candidates; only the LIVE document decides whether a
//    write is still needed. These must not be the same source. After the world
//    merge of 2026-09-23 the export already carried this fill (it shipped in
//    `976f79a8`) while the live store — taken wholesale from origin, which never
//    received that commit — did not. Deciding blankness from the export reported
//    a clean "0 document(s)" while all 28 were still blank in play, which is a
//    silent no-op wearing the costume of a completed migration.
async function collect() {
  const candidates = [];
  for (const f of fs.readdirSync(path.join(EXPORT, "items"))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(EXPORT, "items", f), "utf8")); } catch { continue; }
    if (!PLAN[j.name]) continue;
    candidates.push({ name: j.name, uuid: `Item.${j._id}`, where: "master" });
  }
  for (const f of fs.readdirSync(path.join(EXPORT, "actors"))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(EXPORT, "actors", f), "utf8")); } catch { continue; }
    for (const it of (j.items || [])) {
      if (!PLAN[it.name]) continue;
      candidates.push({ name: it.name, uuid: `Actor.${j._id}.Item.${it._id}`, where: `copy on ${j.name}` });
    }
  }
  if (candidates.length === 0) throw new Error("no candidates found in the export — refusing to report a vacuous pass");

  const out = [];
  let alreadyFilled = 0, missing = 0;
  for (const c of candidates) {
    const live = await getDoc(c.uuid, WORLD);
    if (!live) { missing += 1; console.log(`  skip — not in the live world: ${c.name} (${c.uuid})`); continue; }
    if (String(live?.system?.props?.skill_target ?? "").trim() !== "") { alreadyFilled += 1; continue; }
    out.push(c);
  }
  console.log(`candidates ${candidates.length} · already filled live ${alreadyFilled} · absent ${missing} · to write ${out.length}`);
  return out;
}

(async () => {
  const docs = await collect();
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${docs.length} document(s)\n`);

  let ok = 0, failed = 0;
  for (const d of docs) {
    const [target, why] = PLAN[d.name];
    // A scalar dotted path. NOT a path through an array index — that form
    // destroys the array while still reporting `warnings: []`.
    const patch = { "system.props.skill_target": target };
    try {
      const r = await safeEdit({
        uuid: d.uuid,
        patch,
        note: `backfill skill_target="${target}" (${why})`,
        world: WORLD,
        dryRun: !APPLY,
      });
      const good = r && r.ok !== false;
      if (good) ok += 1; else failed += 1;
      console.log(`  ${good ? "ok  " : "FAIL"}  ${d.name.padEnd(24)} -> ${String(target).padEnd(11)} ${d.where}` +
        (good ? "" : `  ${JSON.stringify(r)}`));
      if (r?.warnings?.length) console.log(`        warnings: ${JSON.stringify(r.warnings)}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL  ${d.name.padEnd(24)} ${d.where}  ${e.message}`);
    }
  }
  console.log(`\n${ok} ok, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
