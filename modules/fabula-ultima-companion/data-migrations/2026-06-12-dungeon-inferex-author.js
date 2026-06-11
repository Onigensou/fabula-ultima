/**
 * Migration: 2026-06-12-dungeon-inferex-author
 * ---------------------------------------------------------------------------
 * Fix the Current Dungeon "Inferex" monster's NON-CHOMP skills. (Chomp is a
 * separate focused pass — it needs the conditional Pierce-on-damage mechanism.)
 *
 *   Flamethrower (Overflow Fire to all enemy) — already correct (Fire 42, target
 *     All Enemy). No change.
 *   Blast Breath (Fire; Blaze: consume the TARGET's Burn, +Burn×5) — already
 *     correct: target-flavored Blaze (blaze_damage = TARGET_AE_CHARGES_BURN * 5
 *     outgoing; blaze_consume = remove_tagged_ae on action_targets). No change.
 *   Undead (always Zombie) — already correct: conflict_start → apply_ae Zombie
 *     (self), template directorPermanent so it never ticks away. No change.
 *
 *   Voracious (on reducing a target to 0 HP, free Attack, ONCE PER TURN) — the
 *     reaction + free-attack grant are correct; the once-per-turn gate uses a
 *     "Voracious Active" marker AE (cond AE_COUNT_VORACIOUS_ACTIVE == 0). BUG:
 *     that marker had no duration → it inherited the default 3-turn director-AE
 *     lifetime, so Voracious actually fired only once per ~3 turns. FIX: stamp
 *     `duration.rounds = 1` on the embedded "Voracious Active" template so it
 *     ticks off at the start of the Inferex's NEXT turn → genuinely once per turn.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Inferex is a co-dev
 * world actor; sharing is via WORLD-DATA PUSH (see feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-12-dungeon-inferex-author";
export const description =
  "Fix Inferex Voracious once-per-turn: stamp duration.rounds=1 on the " +
  "'Voracious Active' marker AE (was defaulting to 3 turns → fired 1/3 turns). " +
  "Flamethrower / Blast Breath / Undead already correct. Chomp deferred.";

const ACTOR_NAME = "Inferex";
const NS = "fabula-ultima-companion";

// Embedded-AE duration patches: { skill, aeName, durationRounds }.
const EMBEDDED_DURATION = [
  { skill: "Voracious", aeName: "Voracious Active", durationRounds: 1 },
];

async function patchActor(actor, log) {
  let changed = 0;
  for (const { skill, aeName, durationRounds } of EMBEDDED_DURATION) {
    const items = actor.items.filter((i) => i.name === skill);
    if (!items.length) { log(`  [${actor.name}] "${skill}": item not found — skipped`); continue; }
    for (const item of items) {
      const ae = item.effects.find((e) => e.name === aeName);
      if (!ae) { log(`  [${actor.name}] "${skill}"/${aeName}: embedded AE NOT FOUND`); continue; }
      if (Number(ae.duration?.rounds) === durationRounds) {
        log(`  [${actor.name}] "${skill}"/${aeName}: duration.rounds already ${durationRounds}`);
        continue;
      }
      await ae.update({ "duration.rounds": durationRounds });
      log(`  [${actor.name}] "${skill}"/${aeName}: duration.rounds → ${durationRounds}`);
      changed++;
    }
  }
  return changed;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) changed += await patchActor(actor, log);
  return { applied: true, summary: `Inferex non-Chomp skills patched (AEs updated: ${changed})` };
}
