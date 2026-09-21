#!/usr/bin/env node
// Ensure ⭐ Fafnir's two Cruel Ultimatum ANIMATION CARRIER items exist.
//
// Zero Power: Cruel Ultimatum lets the players choose between two outcomes
// mid-resolution, so the cinematic has to match the branch they picked. A
// script on the parent skill would have to play BEFORE the choice, when it
// cannot yet know which element to breathe. So each branch's shot lives on its
// own carrier item and is fired by a `play_animation` row inside that branch's
// chain, after the menu resolves.
//
// The carriers hold nothing but a name and an animation_script:
//   - skill_type Passive, so they never appear as an action
//   - no effect / reaction / AE tables, so they can never fire anything
//
// _build-dungeon-animations.js references them BY NAME. Without them that build
// reports MISS for both branches and Cruel Ultimatum silently plays no shot, so
// this runs first on any world that does not already have them.
//
// Idempotent. Dry by default; pass --write, with the game CLOSED.
//
//   node bin/_ensure-fafnir-anim-carriers.js
//   node bin/_ensure-fafnir-anim-carriers.js --write

const { openCollection } = require("../lib/db");

const FAFNIR = "P1uCkpNnxLRBNqZr";
const EXPECT_NAME = "⭐️ Fafnir";
// Structural base to clone. Clone, never construct: a CSB item carries template
// wiring and a full props block that a hand-built object silently lacks.
const BASE_ITEM = "Zero Trigger: Suffering";

const CARRIERS = [
  {
    name: "Cruel Ultimatum: Fire",
    desc: "Animation carrier for the Fire branch of Zero Power: Cruel Ultimatum. Not an action — it holds the cinematic that the Fire option plays via a play_animation row.",
  },
  {
    name: "Cruel Ultimatum: Bolt",
    desc: "Animation carrier for the Bolt branch of Zero Power: Cruel Ultimatum. Not an action — it holds the cinematic that the Bolt option plays via a play_animation row.",
  },
];

const WRITE = process.argv.includes("--write");

// Foundry-style 16-char id.
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const newId = () => Array.from({ length: 16 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");

(async () => {
  const db = await openCollection("actors");
  let changed = 0;

  try {
    const actorKey = `!actors!${FAFNIR}`;
    let actor = null;
    try { actor = await db.get(actorKey); } catch { /* handled below */ }
    if (!actor) { console.error(`MISS  actor ${FAFNIR} not in this world; aborting.`); process.exitCode = 1; return; }
    if (actor.name !== EXPECT_NAME) {
      console.error(`NAME  ${FAFNIR} is "${actor.name}", expected "${EXPECT_NAME}"; aborting.`);
      process.exitCode = 1; return;
    }

    // Index this actor's embedded items by name.
    const byName = new Map();
    for await (const [key, val] of db.iterator()) {
      if (!String(key).startsWith(`!actors.items!${FAFNIR}.`)) continue;
      byName.set(val?.name, { key, val });
    }

    const base = byName.get(BASE_ITEM);
    if (!base) { console.error(`MISS  base item "${BASE_ITEM}" not found; aborting.`); process.exitCode = 1; return; }

    for (const c of CARRIERS) {
      if (byName.has(c.name)) { console.log(`SKIP  "${c.name}" already exists`); continue; }

      const id = newId();
      const doc = JSON.parse(JSON.stringify(base.val));
      doc._id = id;
      doc.name = c.name;

      const p = doc.system.props;
      p.name = c.name;
      p.description = `<p>${c.desc}</p>`;
      p.skill_type = "Passive";
      p.isReaction = false;
      p.cost = "-";
      p.skill_target = "-";
      p.skill_range = "";
      p.animation_script = "";                      // filled by the animation build
      p.animation_damage_timing_options = "default";
      p.animation_damage_timing_offset = "0";
      p.effect_table = {};
      p.reaction_config_table = {};
      p.active_effect_config_table = {};
      p.on_activate_effect_ref = "";
      p.pre_activate_effect_ref = "";
      // CSB mirrors the item's own id into its props; a clone would otherwise
      // leave these pointing at the SOURCE item.
      p.id = id;
      p.uuid = `Actor.${FAFNIR}.Item.${id}`;

      console.log(`CREATE "${c.name}" -> ${id}`);
      changed++;
      if (WRITE) {
        await db.put(`!actors.items!${FAFNIR}.${id}`, doc);
        // ⚠ The embedded doc is NOT enough. The ACTOR's `items` field is an
        // ID ARRAY and it is what Foundry actually loads from; a doc written
        // to the !actors.items! keyspace without its id appended is an ORPHAN
        // the game never sees.
        //
        // This bit for real: the first version of this script wrote only the
        // doc, and `world-export` — which walks the embedded keyspace directly,
        // not the id array — happily reported all nine animations present. The
        // export was a FALSE GREEN. In the live game the two carriers did not
        // exist, so Cruel Ultimatum's play_animation rows pointed at nothing
        // and silently played no shot.
        const fresh = await db.get(actorKey);
        fresh.items = Array.isArray(fresh.items) ? fresh.items : [];
        if (!fresh.items.includes(id)) {
          fresh.items.push(id);
          await db.put(actorKey, fresh);
        }
      }
    }

    // Belt and braces: every carrier must be reachable from the id array, not
    // merely present in the keyspace.
    if (WRITE && changed) {
      const check = await db.get(actorKey);
      const ids = new Set(check.items ?? []);
      for await (const [key, val] of db.iterator()) {
        if (!String(key).startsWith(`!actors.items!${FAFNIR}.`)) continue;
        if (!CARRIERS.some((c) => c.name === val?.name)) continue;
        if (!ids.has(val._id)) {
          console.error(`ORPHAN "${val.name}" (${val._id}) is not in the actor's items array!`);
          process.exitCode = 1;
        }
      }
    }

    if (!WRITE) console.log(`\nDRY RUN — ${changed} carrier(s) pending. Re-run with --write (game CLOSED).`);
    else console.log(`\nWROTE ${changed} carrier(s). Now run _build-dungeon-animations.js to fill their scripts.`);
  } finally {
    await db.close();
  }
})().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; });
