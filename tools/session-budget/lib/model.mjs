/**
 * Loading + normalisation: cost model, plan files, tile classification,
 * and the ordering heuristic that turns tile COUNTS into a walk order.
 */
import fs from "node:fs";
import path from "node:path";
import { pertMean } from "./random.mjs";

export function loadModel(modelPath) {
  const raw = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  return raw;
}

export function loadPlan(planPath) {
  const raw = JSON.parse(fs.readFileSync(planPath, "utf8"));
  raw._file = path.basename(planPath);
  return raw;
}

/** "20:30" -> 1230 (minutes past 00:00). */
export function parseClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`Bad clock value: "${hhmm}" (want "HH:MM")`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes past `start`, wrapping across midnight. */
export function minutesFromStart(startMin, clockMin) {
  return clockMin >= startMin ? clockMin - startMin : clockMin + 1440 - startMin;
}

/** 1230 + 222 -> "00:12" */
export function formatClock(minutesPastMidnight) {
  const m = ((Math.round(minutesPastMidnight) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function formatDuration(mins) {
  const m = Math.round(mins);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
}

/** DP tile type -> cost class. Unknown types fall back to "other" and are reported. */
export function classifyType(model, type) {
  const key = String(type).toLowerCase().replace(/\s+/g, "_").replace(/_tile$/, "");
  return model.typeToClass[key] ?? null;
}

/**
 * Turn a segment's `tiles` count map into an ordered walk.
 *
 * Story-class tiles are appended LAST: a narrative beat closes out a tile
 * chain, and where it lands on the clock is exactly what we need to know.
 * Everything else is round-robin interleaved so the mix is even rather than
 * front-loading all the battles.
 */
export function orderSegmentTiles(model, segment) {
  if (Array.isArray(segment.sequence)) {
    return segment.sequence.map(t => ({ type: t, cls: classifyType(model, t) }));
  }

  const counts = segment.tiles ?? {};
  const normal = [];
  const storyClass = [];

  const buckets = [];
  for (const [type, n] of Object.entries(counts)) {
    const cls = classifyType(model, type);
    const entry = { type, cls };
    if (cls && model.classes[cls]?.storyClass) {
      for (let i = 0; i < n; i++) storyClass.push({ ...entry });
    } else {
      buckets.push({ entry, remaining: n });
    }
  }

  // Round-robin across types until every bucket is drained.
  let drained = false;
  while (!drained) {
    drained = true;
    for (const b of buckets) {
      if (b.remaining > 0) {
        normal.push({ ...b.entry });
        b.remaining--;
        drained = false;
      }
    }
  }

  return [...normal, ...storyClass];
}

/** Expected (analytic) minutes for one tile, before tempo. */
export function expectedTileMinutes(model, cls) {
  const c = model.classes[cls];
  if (!c) return 0;
  const evt = pertMean(c.event);
  const pass = c.pass ? pertMean(c.pass) : 0;
  const p = c.p ?? 1;
  let total = p * evt + (1 - p) * pass;
  if (c.battleTail) total += p * pertMean(model.overheads.postBattleTail.pert);
  return total;
}

/** How many breaks a session of this content length gets. */
export function breakCount(model, contentMinutes) {
  const b = model.overheads.break;
  let n = 0;
  if (contentMinutes >= b.firstAt) n = 1;
  if (contentMinutes >= b.secondAt) n = 2;
  return Math.min(n, b.max ?? 2);
}
