// ============================================================================
// Stealth Mode — enemy AI.
//
// Four states per enemy. Metal Gear, Commandos and Mark of the Ninja all run
// essentially this one; it is meaningfully simpler than the Action Pattern
// combat AI we already ship, because the decision space is "where do I stand
// and which way do I look" rather than "which of forty skills".
//
//   PATROL      walks an authored route, or holds a post and sweeps its facing
//   SUSPICIOUS  walks to the SPOT it half-noticed, then commits or drops it
//   SEARCH      paths to the party's LAST KNOWN cell, not their real one
//   CHASE       paths to the true position; only reachable at the Alert tier
//
// ── Last known position is the entire trick ────────────────────────────────
// An AI that always paths at your true cell is an oppressive bloodhound and
// every map becomes a race. One that paths at where it last SAW you produces
// every good stealth moment there is — the guard checking the wrong corner, the
// pillar that actually works, the corpse found one round too early. It costs
// one stored cell per enemy and it is the difference between the mode being
// fun and being a stopwatch.
//
// SUSPICIOUS investigating the SPOT is the other half. It walks to where it
// thought something was — not at the party — and resolves there: sees them and
// commits, or finds nothing and drops it entirely. A guard that bolts straight
// at you the instant it half-noticed something makes suspicion
// indistinguishable from being caught, and leaves the party nothing to do about
// it. Bounded, and it ends where the guard is looking rather than where you are.
// ============================================================================

import { TAG, AI, ALERT } from "./sm-constants.js";
import {
  cellDistance, directionBetween, sameCell, neighbours, snapToDirection,
  DIR8, DIR6, directions, cellOfToken,
} from "./sm-grid.js";
import { stepToward, reachable, findPath, pathFromReachable } from "./sm-lattice.js";
import { evaluateSight } from "./sm-vision.js";
import { isAlert, pendingActivations, isStupored } from "./sm-state.js";

/**
 * Which enemy acts next.
 *
 * Priority, in order: the one who knows the most, then the nearest, then
 * round-robin among the rest. That ordering means an activation budget of 3 is
 * spent on the guards who matter rather than on whoever happens to be first in
 * the token list — and it makes the budget feel like a threat instead of a
 * lottery.
 */
export function pickActivation(state, partyCell, { scene = canvas?.scene } = {}) {
  // A stupored guard does not act — it is passed over and the budget moves on
  // to the next in priority. That is the whole value of running away: the
  // party bought a round, not a deleted enemy.
  const pending = pendingActivations(state).filter((e) => !isStupored(e));
  if (!pending.length) return null;

  const scored = pending.map((e) => ({
    e,
    aware: e.awareness,
    hunting: (e.ai === AI.CHASE || e.ai === AI.SEARCH) ? 1 : 0,
    dist: partyCell ? cellDistance(e.cell, partyCell, scene) : Infinity,
  }));

  scored.sort((a, b) =>
    (b.hunting - a.hunting) ||
    (b.aware - a.aware) ||
    (a.dist - b.dist));

  return scored[0].e;
}

// ── Patrol routes ───────────────────────────────────────────────────────────

/**
 * A guard with no authored route holds its post and sweeps.
 *
 * Sweeping matters more than it looks: a static facing turns every post into a
 * solved puzzle the moment the player sees the cone, whereas a slow sweep keeps
 * a corridor readable but not free. One step of the compass per activation.
 */
function sweepFacing(enemy, scene) {
  const keys = directions(scene);
  const idx = keys.indexOf(enemy.facing);
  const dirIdx = idx < 0 ? 0 : idx;
  const step = (enemy.routeIndex % 2 === 0) ? 1 : -1;
  enemy.routeIndex = (enemy.routeIndex + 1) % 4;
  return keys[(dirIdx + step + keys.length) % keys.length];
}

/**
 * A soft wander for a guard with no authored route.
 *
 * Picks a cell a short hop away, inside a leash around the post it started on,
 * and only some of the time — a guard that moves every single activation is a
 * guard whose cone never settles, and the player can never read a pattern to
 * plan against. Standing still sometimes IS the pattern.
 *
 * The anchor is captured on first use rather than authored, so an unrouted
 * guard the GM drops anywhere behaves sensibly with no setup at all.
 */
function wanderStep(enemy, tune, { scene }) {
  if (!enemy.anchor) enemy.anchor = { ...enemy.cell };
  if (Math.random() > (tune.wanderChance ?? 0.5)) return null;

  const leash = tune.wanderLeash ?? 3;
  const hop = Math.max(1, Math.min(tune.wanderStep ?? 2, tune.enemyMove));

  const reach = reachable(enemy.cell, hop, { scene, ignoreOccupants: false });
  const options = [...reach.values()].filter((n) =>
    n.cost > 0 && cellDistance(n.cell, enemy.anchor, scene) <= leash);

  if (!options.length) return null;
  const pick = options[Math.floor(Math.random() * options.length)];
  return { cell: pick.cell, path: pathFromReachable(reach, pick.cell) };
}

/** Advance along an authored waypoint route, looping at the end. */
function patrolStep(enemy, route, budget, { scene }) {
  if (!route?.length) return null;

  let target = route[enemy.routeIndex % route.length];
  // Standing on the waypoint means it is time for the next one.
  if (sameCell(enemy.cell, target)) {
    enemy.routeIndex = (enemy.routeIndex + 1) % route.length;
    target = route[enemy.routeIndex];
  }
  if (!target) return null;

  const { cell, path } = stepToward(enemy.cell, target, budget, { scene, ignoreOccupants: false });
  return { cell, path, target };
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * Decide one enemy's activation. PURE — returns an intent, writes nothing.
 * The caller commits it, so the whole decision is loggable and testable.
 *
 * @returns {{
 *   enemyId:string, ai:string, move:object|null, path:object[],
 *   facing:string, sawParty:boolean, contact:boolean, note:string
 * }}
 */
export function decideActivation(state, enemy, partyCell, tune, { scene = canvas?.scene } = {}) {
  // A guard walking its rounds moves at a walk; one that is actually onto you
  // runs. Patrol at full speed meant an idle guard covered as much ground as a
  // pursuit, so the map never felt calm and there was no tempo change to read
  // when things went wrong.
  const patrolling = enemy.ai === AI.PATROL;
  const budget = patrolling ? (tune.patrolMove ?? tune.enemyMove) : tune.enemyMove;
  const out = {
    enemyId: enemy.tokenId,
    ai: enemy.ai,
    move: null,
    path: [],
    facing: enemy.facing,
    sawParty: false,
    contact: false,
    resolved: false,   // suspicion investigated and dismissed
    note: "",
  };

  // Look first — an enemy that can see the party acts on that, whatever state
  // it was in when the round started.
  const sight = partyCell
    ? evaluateSight(enemy.cell, enemy.facing, partyCell, tune, { scene })
    : { seen: false };

  // Escalate on what was ACTUALLY seen, not on "something registered".
  //
  // This used to branch on sight.seen, which is true for a merely SUSPICIOUS
  // reading as well as a real sighting — so a guard that half-noticed you at
  // four cells jumped straight to SEARCH and pathed at your exact tile. That
  // is the "I stepped behind a crate and it bolted at me anyway" case, and it
  // was a bug rather than the dice: stepping into cover cannot help if being
  // glimpsed already handed the guard your position.
  if (sight.spotted) {
    out.sawParty = true;
    out.facing = directionBetween(enemy.cell, partyCell, scene) ?? enemy.facing;
    out.ai = isAlert(state) ? AI.CHASE : AI.SEARCH;
  } else if (sight.level === "suspicious" && out.ai === AI.PATROL) {
    // Glimpsed something. Go and LOOK at where it was — which is what makes
    // ducking behind cover work: they walk to the spot and find nothing.
    out.sawParty = true;
    out.ai = AI.SUSPICIOUS;
    if (!enemy.lastKnownCell) enemy.lastKnownCell = partyCell;
  }

  const config = state.__config ?? {};
  const route = (config.routes ?? {})[enemy.tokenId] ?? null;

  switch (out.ai) {
    case AI.CHASE: {
      // The only state that paths at the truth.
      const goal = partyCell ?? enemy.lastKnownCell;
      if (!goal) { out.note = "nothing to chase"; break; }
      const dash = tune.enemiesMayDash ? tune.dashBonus : 0;
      const { cell, path } = stepToward(enemy.cell, goal, budget + dash, { scene, ignoreOccupants: false });
      out.move = cell;
      out.path = path;
      out.facing = directionBetween(enemy.cell, goal, scene) ?? out.facing;
      out.note = `chasing ${goal.i},${goal.j}`;
      break;
    }

    case AI.SEARCH: {
      const goal = enemy.lastKnownCell ?? partyCell;
      if (!goal) { out.ai = AI.PATROL; out.note = "no lead"; break; }

      if (sameCell(enemy.cell, goal)) {
        // Arrived and found nothing. Sweep, then widen outward next round —
        // the guard checking the corner you already left.
        out.facing = sweepFacing(enemy, scene);
        out.note = "sweeping last known position";
        break;
      }

      const { cell, path } = stepToward(enemy.cell, goal, budget, { scene, ignoreOccupants: false });
      out.move = cell;
      out.path = path;
      out.facing = directionBetween(enemy.cell, goal, scene) ?? out.facing;
      out.note = `searching toward ${goal.i},${goal.j}`;
      break;
    }

    case AI.SUSPICIOUS: {
      // Investigate the SPOT, not the party.
      //
      // A suspicious guard walks to where it thought something was and looks.
      // It does not path at the party's real position — that is CHASE, and a
      // guard that bolts straight at you the instant it half-noticed something
      // makes suspicion indistinguishable from being caught.
      //
      // On arrival it resolves one way or the other: sees you and commits, or
      // finds nothing and drops it. That bounded outcome is what makes
      // suspicion survivable — it ends, and it ends where the guard is looking
      // rather than where you are.
      const point = enemy.lastKnownCell;
      if (!point) { out.ai = AI.PATROL; out.note = "nothing to investigate"; break; }

      if (sameCell(enemy.cell, point)) {
        if (sight.spotted) {
          out.ai = isAlert(state) ? AI.CHASE : AI.SEARCH;
          out.facing = directionBetween(enemy.cell, partyCell, scene) ?? out.facing;
          out.note = "found them";
        } else {
          // Nothing here. The `resolved` flag tells the caller to clear the
          // awareness and latch that put this guard on edge in the first place.
          out.ai = AI.PATROL;
          out.resolved = true;
          out.facing = sweepFacing(enemy, scene);
          out.note = "investigated, found nothing";
        }
        break;
      }

      const { cell, path } = stepToward(enemy.cell, point, budget, { scene, ignoreOccupants: false });
      out.move = cell;
      out.path = path;
      out.facing = directionBetween(enemy.cell, point, scene) ?? out.facing;
      out.note = `investigating ${point.i},${point.j}`;
      break;
    }

    case AI.PATROL:
    default: {
      const stepped = patrolStep(enemy, route, budget, { scene });
      if (stepped?.cell && !sameCell(stepped.cell, enemy.cell)) {
        out.move = stepped.cell;
        out.path = stepped.path;
        out.facing = directionBetween(enemy.cell, stepped.cell, scene) ?? out.facing;
        out.note = "patrolling";
        break;
      }

      // No authored route. Rather than stand rooted and spin — which made
      // unrouted guards read as scenery and let a player memorise a static
      // map — drift a short way around the post and look where you are going.
      // The anchor is remembered so the guard never wanders off its station.
      const wander = wanderStep(enemy, tune, { scene });
      if (wander) {
        out.move = wander.cell;
        out.path = wander.path;
        out.facing = directionBetween(enemy.cell, wander.cell, scene) ?? out.facing;
        out.note = "meandering";
      } else {
        out.facing = sweepFacing(enemy, scene);
        out.note = "holding post";
      }
      break;
    }
  }

  // Contact: the ENEMY walked into the party. Only ever enemy-initiated —
  // the party stepping next to a guard is the setup for a Takedown, not a
  // mistake, and the brief was explicit about that asymmetry.
  const endCell = out.move ?? enemy.cell;
  if (partyCell && cellDistance(endCell, partyCell, scene) <= 1 && out.ai !== AI.PATROL) {
    out.contact = true;
  }
  // A patrolling guard that blunders directly onto the party still makes
  // contact — being unaware is not a force field.
  if (partyCell && sameCell(endCell, partyCell)) out.contact = true;

  return out;
}

/**
 * Trim an intent's path so it stops the moment it would touch the party.
 *
 * Without this a chasing guard walks THROUGH the party cell to reach a goal
 * behind them, and contact reads as a pass-through rather than a collision.
 */
export function truncateAtContact(path, partyCell, scene = canvas?.scene) {
  if (!partyCell || !path?.length) return { path, contact: false };
  const cut = [];
  for (const cell of path) {
    cut.push(cell);
    if (cellDistance(cell, partyCell, scene) <= 1) return { path: cut, contact: true };
  }
  return { path: cut, contact: false };
}

/**
 * Which enemies join a fight triggered at `atCell`.
 *
 * A lone guard should be a lone fight; a corridor chase should drag the whole
 * pursuit in. Radius plus "anyone already hunting" gets both without a third
 * concept.
 */
export function conflictParticipants(state, atCell, tune, { scene = canvas?.scene } = {}) {
  const out = [];
  for (const e of Object.values(state.enemies ?? {})) {
    if (!e || e.defeated) continue;
    const near = cellDistance(e.cell, atCell, scene) <= tune.conflictJoinRadius;
    const hunting = e.ai === AI.CHASE || e.ai === AI.SEARCH;
    if (near || (hunting && isAlert(state))) out.push(e);
  }
  return out;
}
