#!/usr/bin/env node
// Wire ⭐ Fafnir's Zero Power: Cruel Ultimatum to play a per-branch cinematic.
//
// The players choose between two outcomes mid-resolution, so the shot has to
// match the branch they picked. A script on the parent skill would have to play
// BEFORE the choice, when it cannot yet know which element to breathe — so each
// branch fires its own carrier item through a `play_animation` row.
//
// Row ORDER inside each branch is load-bearing:
//     <targeting> , <play_animation> , <deal_damage>
// Targeting first so the shot knows who it is hitting; play_animation returns at
// the damage gate, so the damage lands on impact rather than before or after it.
//
// Carriers are resolved BY NAME, never by a hardcoded uuid: a replay onto
// another world creates them with fresh ids, and a pinned uuid would point at
// nothing there. Run _ensure-fafnir-anim-carriers.js first.
//
// Idempotent. Dry by default; pass --write, with the game CLOSED.
//
//   node bin/_wire-cruel-ultimatum-animations.js
//   node bin/_wire-cruel-ultimatum-animations.js --write

const { openCollection } = require("../lib/db");

const FAFNIR = "P1uCkpNnxLRBNqZr";
const EXPECT_ACTOR = "⭐️ Fafnir";
const ZERO_POWER = "Zero Power: Cruel Ultimatum";

// branch chain row label -> { carrier item, the targeting row it follows,
// the damage row it precedes, and the label its own row gets }
const BRANCHES = [
  { chainLabel: "cu_optA", animLabel: "cu_anim_fire", carrier: "Cruel Ultimatum: Fire", targeting: "cu_pick_one", damage: "cu_300" },
  { chainLabel: "cu_optB", animLabel: "cu_anim_bolt", carrier: "Cruel Ultimatum: Bolt", targeting: "cu_all",      damage: "cu_120" },
];

const WRITE = process.argv.includes("--write");

const rowsOf = (t) => Object.entries(t ?? {}).filter(([, v]) => v && !v.$deleted);
const findRow = (t, label) => rowsOf(t).find(([, v]) => v.effect_label === label);
const nextKey = (t) => String(Math.max(-1, ...Object.keys(t ?? {}).map(Number).filter(Number.isFinite)) + 1);

(async () => {
  const db = await openCollection("actors");
  let changed = 0;

  try {
    const actorKey = `!actors!${FAFNIR}`;
    let actor = null;
    try { actor = await db.get(actorKey); } catch { /* handled below */ }
    if (!actor) { console.error(`MISS  actor ${FAFNIR} not in this world; aborting.`); process.exitCode = 1; return; }
    if (actor.name !== EXPECT_ACTOR) {
      console.error(`NAME  ${FAFNIR} is "${actor.name}", expected "${EXPECT_ACTOR}"; aborting.`);
      process.exitCode = 1; return;
    }

    const items = new Map();
    for await (const [key, val] of db.iterator()) {
      if (String(key).startsWith(`!actors.items!${FAFNIR}.`)) items.set(val?.name, { key, val });
    }

    const zp = items.get(ZERO_POWER);
    if (!zp) { console.error(`MISS  "${ZERO_POWER}" not found; aborting.`); process.exitCode = 1; return; }

    const table = zp.val.system.props.effect_table ?? {};

    for (const b of BRANCHES) {
      const carrier = items.get(b.carrier);
      if (!carrier) {
        console.error(`MISS  carrier "${b.carrier}" not found — run _ensure-fafnir-anim-carriers.js first; aborting.`);
        process.exitCode = 1; return;
      }
      const carrierUuid = `Actor.${FAFNIR}.Item.${carrier.val._id}`;

      const chain = findRow(table, b.chainLabel);
      if (!chain) { console.error(`MISS  chain row "${b.chainLabel}" not found; aborting.`); process.exitCode = 1; return; }
      for (const need of [b.targeting, b.damage]) {
        if (!findRow(table, need)) { console.error(`MISS  row "${need}" not found; aborting.`); process.exitCode = 1; return; }
      }

      // The animation row itself.
      const existing = findRow(table, b.animLabel);
      const row = {
        $deleted: false,
        effect_label: b.animLabel,
        effect_kind: "play_animation",
        action_ref: carrierUuid,
        target_ref: b.targeting,
      };
      if (existing) {
        const [k, v] = existing;
        if (v.action_ref === carrierUuid && v.target_ref === b.targeting && v.effect_kind === "play_animation") {
          console.log(`SKIP  ${b.animLabel} already wired to ${b.carrier}`);
        } else {
          console.log(`FIX   ${b.animLabel} -> ${b.carrier} (${carrierUuid})`);
          table[k] = Object.assign({}, v, row);
          changed++;
        }
      } else {
        const k = nextKey(table);
        console.log(`ADD   ${b.animLabel} [row ${k}] -> ${b.carrier} (${carrierUuid})`);
        table[k] = row;
        changed++;
      }

      // Splice the animation between targeting and damage in the chain.
      const want = `${b.targeting},${b.animLabel},${b.damage}`;
      if (chain[1].chain_steps === want) {
        console.log(`SKIP  ${b.chainLabel} chain already "${want}"`);
      } else {
        console.log(`SET   ${b.chainLabel}: "${chain[1].chain_steps}" -> "${want}"`);
        table[chain[0]] = Object.assign({}, chain[1], { chain_steps: want });
        changed++;
      }
    }

    if (WRITE && changed) {
      zp.val.system.props.effect_table = table;
      await db.put(zp.key, zp.val);
    }

    if (!WRITE) console.log(`\nDRY RUN — ${changed} change(s) pending. Re-run with --write (game CLOSED).`);
    else console.log(`\nWROTE ${changed} change(s).`);
  } finally {
    await db.close();
  }
})().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; });
