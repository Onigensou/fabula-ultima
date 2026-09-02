// ============================================================================
// Stealth Mode — vision, line of sight and detection.
//
// One question, asked constantly: can this guard see the party right now?
//
// It is evaluated PER CELL ENTERED during a move, never only at the end of one.
// That single decision is what makes walking into a cone feel fair rather than
// arbitrary — the party stops at the edge of the cone, not three cells past it,
// and the player can see why.
//
// ── The model ──────────────────────────────────────────────────────────────
// A guard sees the party when all of:
//   • the party is within the guard's sight range for the arc it stands in
//     (front = full, flank = reduced, rear = proximity only)
//   • the party is inside the cone (front/flank), or simply very close (rear)
//   • no wall interrupts — the same sight backend Foundry's own vision uses
//
// Cover and darkness do not BLOCK sight; they reduce how much awareness the
// sighting generates. A crate you are standing behind should make a guard
// squint, not blind them, and the tuning knobs decide how much.
// ============================================================================

import { ARC } from "./sm-constants.js";
import {
  cellDistance, relativeArc, angleOffFacing, inCone, cellsWithin, sameCell,
} from "./sm-grid.js";
import { cellRecord, hasLineOfSight } from "./sm-lattice.js";

/**
 * Evaluate one observer against one target cell.
 *
 * @returns {{
 *   seen:boolean, arc:string, distance:number, los:boolean,
 *   inCone:boolean, cover:boolean, lit:boolean,
 *   awareness:number, autoSpot:boolean, reason:string
 * }}
 *
 * `awareness` is what this sighting contributes THIS activation — 0 when
 * nothing was seen. `autoSpot` means close enough and exposed enough that no
 * check applies: the guard simply sees them.
 */
export function evaluateSight(observerCell, facing, targetCell, tune, {
  scene = canvas?.scene,
  concealTier = 0,
} = {}) {
  const miss = (reason, extra = {}) => ({
    seen: false, level: "none", spotted: false,
    arc: ARC.REAR, distance: Infinity, los: false, inCone: false,
    cover: false, lit: false, awareness: 0, autoSpot: false, reason, ...extra,
  });

  if (!observerCell || !targetCell) return miss("no-cell");
  if (sameCell(observerCell, targetCell)) {
    return { seen: true, level: "spotted", spotted: true,
             arc: ARC.FRONT, distance: 0, los: true, inCone: true,
             cover: false, lit: true, awareness: tune.awarenessMax, autoSpot: true,
             reason: "same-cell" };
  }

  const distance = cellDistance(observerCell, targetCell, scene);
  const arc = relativeArc(observerCell, facing, targetCell, tune.coneHalfAngle);

  // Range depends on the arc. The rear arc has no sight range at all — a guard
  // does not see behind their own head — but proximity still registers, which
  // is what stops a player parking on a guard's back tile with total impunity.
  let range;
  if (arc === ARC.FRONT)      range = tune.visionRange;
  else if (arc === ARC.FLANK) range = Math.round(tune.visionRange * tune.flankRangeMult);
  else                        range = 0;

  const withinProximity = distance <= tune.suspicionRadius;

  if (distance > range && !withinProximity) return miss("out-of-range", { distance, arc });

  const los = hasLineOfSight(observerCell, targetCell, scene);
  if (!los) return miss("wall", { distance, arc });

  const rec = cellRecord(targetCell, scene);
  // Concealment counts as cover for every purpose sight cares about. A party
  // that has just gone to ground is behind SOMETHING even on an open tile —
  // that is what the roll represents — so it suppresses the auto-spot and
  // feeds the same awareness penalty.
  const cover = !!rec?.cover || concealTier >= 1;
  const lit = !!rec?.lit;

  const coneHit = arc !== ARC.REAR && inCone(observerCell, facing, targetCell, tune.coneHalfAngle);

  // Nothing in the cone and nothing close: unseen.
  if (!coneHit && !withinProximity) return miss("outside-cone", { distance, arc });

  // How much this sighting is worth.
  let awareness = 0;
  if (coneHit && distance <= range) {
    // Nearer is stronger, on a simple linear falloff. A guard three cells away
    // staring straight at you is not the same event as one at the far edge.
    const closeness = 1 - Math.min(1, distance / Math.max(1, range));
    awareness = 1 + Math.round(closeness * 2);   // 1..3
  } else if (withinProximity) {
    awareness = 1;                                // heard, not seen
  }

  if (cover) awareness += tune.coverAwareness;    // negative
  if (!lit)  awareness += tune.darkAwareness;     // negative
  awareness = Math.max(0, awareness);

  // ── Two levels, not one ──────────────────────────────────────────────────
  //
  //   "spotted"     inside the cone, within spottedRange, not in cover.
  //                 The guard is looking right at them. No check, no doubt.
  //
  //   "suspicious"  inside the cone but further out. Something moved; the
  //                 guard is not sure what.
  //
  // The split exists because one level made movement unplayable: every cell
  // entered inside a cone re-triggered the same "spotted" event, halting the
  // walk and ratcheting the alert again and again while the party was still
  // crossing the same room. Suspicion now costs one tier ONCE per guard and
  // never stops the walk; only a genuine sighting does both.
  const spotted = coneHit && distance <= tune.spottedRange && !cover;

  // At Well Hidden and above, suspicion cannot register at all — a guard
  // either walks close enough to see you outright or learns nothing. That is
  // the whole point of a good hide, and without it a strong roll still leaked
  // your position one point of awareness at a time.
  const suspicionBlocked = concealTier >= 2;
  const level = spotted ? "spotted"
    : (awareness > 0 && !suspicionBlocked) ? "suspicious"
    : "none";

  return {
    seen: level !== "none",
    level,
    spotted,
    arc, distance, los, inCone: coneHit, cover, lit,
    awareness: spotted ? Math.max(awareness, 3) : awareness,
    // Kept for callers that only care whether the guard is certain.
    autoSpot: spotted,
    reason: spotted ? "spotted" : (coneHit ? "in-cone" : "proximity"),
  };
}

/**
 * Every cell an observer can currently see — the cone overlay's geometry.
 * Wall-clipped, so a cone stops at a corner exactly where the player expects.
 */
export function visibleCells(observerCell, facing, tune, { scene = canvas?.scene } = {}) {
  const out = [];
  if (!observerCell) return out;

  for (const cell of cellsWithin(observerCell, tune.visionRange, scene)) {
    const off = angleOffFacing(observerCell, facing, cell);
    if (off > tune.coneHalfAngle) continue;

    const d = cellDistance(observerCell, cell, scene);
    if (d > tune.visionRange) continue;
    if (!hasLineOfSight(observerCell, cell, scene)) continue;

    out.push({ cell, distance: d, near: d <= tune.detectionRange });
  }
  return out;
}

/**
 * Run every listed observer against one party cell.
 *
 * Returns the per-observer results plus the aggregate the alert model needs.
 * `best` is the strongest single sighting, because alert should react to the
 * guard who saw the most, not to the average of a crowd.
 */
/**
 * Run every listed observer against one party cell. PURE — reads only.
 *
 * The mutating half (awareness, marks, alert) lives in the caller. Keeping the
 * query side clean is what lets a GATE ask "can they see us?" without the act
 * of asking bumping awareness and raising the alarm, which is exactly the bug
 * the Hide permission check used to have.
 */
export function surveyObservers(observers, partyCell, tune, {
  scene = canvas?.scene, concealTier = 0,
} = {}) {
  const results = [];
  let best = null;
  let anySpotted = false;

  for (const obs of observers) {
    const r = evaluateSight(obs.cell, obs.facing, partyCell, tune, { scene, concealTier });
    const row = { ...obs, sight: r };
    results.push(row);
    if (r.spotted) anySpotted = true;
    if (r.seen && (!best || r.awareness > best.sight.awareness)) best = row;
  }

  return {
    results, best, anySpotted,
    anyAutoSpot: anySpotted,          // legacy alias
    spottedBy:   results.filter((r) => r.sight.spotted),
    suspiciousBy: results.filter((r) => r.sight.level === "suspicious"),
    seenBy:      results.filter((r) => r.sight.seen),
  };
}
