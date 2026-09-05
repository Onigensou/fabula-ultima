/**
 * Builds the event timeline from a plan, then Monte-Carlos it.
 *
 * Two independent sources of swing, per the agreed model:
 *   - tempo  : one correlated multiplier for the whole night (the table is
 *              slow or fast tonight), applied to CONTENT minutes only.
 *   - jitter : each tile sampled independently, so per-tile error adds in
 *              quadrature rather than linearly.
 * Overheads are inelastic and are never multiplied by tempo.
 */
import { makeRng, samplePert, percentile, mean, stdev } from "./random.mjs";
import {
  parseClock, minutesFromStart, orderSegmentTiles,
  expectedTileMinutes, breakCount, classifyType,
} from "./model.mjs";

/** Flatten a plan into an ordered list of timeline events. */
export function buildTimeline(model, plan) {
  const warnings = [];
  const segments = plan.segments ?? [];

  // Per-segment ordered tiles + expected content minutes (used for break placement).
  const prepared = segments.map((seg, i) => {
    const tiles = orderSegmentTiles(model, seg);
    for (const t of tiles) {
      if (!t.cls) {
        warnings.push(`Unknown tile type "${t.type}" in segment "${seg.name ?? i}" - priced as "other".`);
        t.cls = "other";
      }
    }
    const expected = tiles.reduce((s, t) => s + expectedTileMinutes(model, t.cls), 0);
    return { seg, tiles, expected };
  });

  const totalContent = prepared.reduce((s, p) => s + p.expected, 0);
  const nBreaks = plan.overheads?.breaks === "none" ? 0
    : typeof plan.overheads?.breaks === "number" ? plan.overheads.breaks
    : breakCount(model, totalContent);

  // Place breaks at the segment boundary nearest each k/(n+1) fraction of content.
  const breakAfter = new Set();
  if (nBreaks > 0 && prepared.length > 1) {
    const cum = [];
    let running = 0;
    for (const p of prepared) { running += p.expected; cum.push(running); }
    for (let k = 1; k <= nBreaks; k++) {
      const target = (totalContent * k) / (nBreaks + 1);
      let best = -1, bestDist = Infinity;
      for (let i = 0; i < prepared.length - 1; i++) {
        if (breakAfter.has(i)) continue;
        const d = Math.abs(cum[i] - target);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      if (best >= 0) breakAfter.add(best);
    }
  }

  const events = [];
  events.push({ kind: "overhead", key: "open", label: "open", glyph: "open" });

  let prevScene = null;
  prepared.forEach(({ seg, tiles }, i) => {
    const scene = seg.scene ?? seg.name ?? `segment ${i + 1}`;
    if (prevScene !== null && scene !== prevScene) {
      events.push({
        kind: "overhead", key: "sceneTransition", glyph: "transition",
        label: `travel to ${scene}`, scene, safeStop: `${scene} entrance`,
      });
    }
    prevScene = scene;

    // Consecutive ordinary tiles collapse into one "chain" row; story-class and
    // camp tiles get their own row, because where they land on the clock is the
    // whole point of the report.
    let chain = [];
    const flushChain = () => {
      if (!chain.length) return;
      events.push({
        kind: "chain", glyph: "chain", scene, segIdx: i, tiles: chain,
        label: `${seg.name ?? scene} (${summarise(model, chain)})`,
      });
      chain = [];
    };

    for (const t of tiles) {
      const c = model.classes[t.cls];
      if (c?.storyClass || c?.safeStop) {
        flushChain();
        events.push({
          kind: "tile", glyph: c.storyClass ? "story" : "camp", scene, segIdx: i, tile: t,
          label: `${c.label.toUpperCase()}: ${seg.beats?.[t.type] ?? t.type}`,
          storyClass: !!c.storyClass,
          safeStop: c.storyClass ? `post-${c.label}` : `${c.label} tile`,
        });
      } else {
        chain.push(t);
      }
    }
    flushChain();
  });

  events.push({ kind: "overhead", key: "close", label: "close", glyph: "close" });

  if (breakAfter.size) insertBreaks(events, breakAfter);

  return { events, warnings, nBreaks, expectedContent: totalContent };
}

/** Insert each break after the last content event of its segment. */
function insertBreaks(events, breakAfter) {
  for (const segIdx of [...breakAfter].sort((a, b) => b - a)) {
    // Match on segment index, not scene name — two segments can share a scene.
    let at = -1;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if ((ev.kind === "chain" || ev.kind === "tile") && ev.segIdx === segIdx) at = i;
    }
    if (at >= 0) {
      events.splice(at + 1, 0, {
        kind: "overhead", key: "break", label: "break", glyph: "break", safeStop: "break",
      });
    }
  }
}

function summarise(model, tiles) {
  const byClass = {};
  for (const t of tiles) byClass[t.cls] = (byClass[t.cls] ?? 0) + 1;
  return Object.entries(byClass)
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => `${n} ${model.classes[cls].label.toLowerCase()}`)
    .join(", ");
}

/** Sample one tile: minutes (pre-tempo) plus whether the event actually fired. */
function sampleTile(rng, model, cls) {
  const c = model.classes[cls];
  const triggered = (c.p ?? 1) >= 1 ? true : rng() < c.p;
  const band = triggered ? c.event : (c.pass ?? c.event);
  let d = samplePert(rng, band);
  if (c.battleTail && triggered) d += samplePert(rng, model.overheads.postBattleTail.pert);
  return { d, triggered };
}

export function simulate(model, plan, { runs = 10000, seed = 20260905 } = {}) {
  const { events, warnings, nBreaks, expectedContent } = buildTimeline(model, plan);
  const rng = makeRng(seed);

  const session = { ...model.session, ...(plan.session ?? {}) };
  const startMin = parseClock(session.start);
  const targetOffset = minutesFromStart(startMin, parseClock(session.target));
  const hardOffset = minutesFromStart(startMin, parseClock(session.hardStop));

  const totals = [], contentTotals = [], overheadTotals = [], storyTotals = [], battleCounts = [], tempos = [];
  const perEventDur = events.map(() => []);
  const perEventStart = events.map(() => []);
  const perEventEnd = events.map(() => []);

  for (let r = 0; r < runs; r++) {
    const tempo = samplePert(rng, model.tempo.pert);
    tempos.push(tempo);
    let clock = 0, content = 0, overhead = 0, story = 0, battles = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      let dur;

      if (ev.kind === "overhead") {
        dur = samplePert(rng, model.overheads[ev.key].pert);
        overhead += dur;
      } else if (ev.kind === "tile") {
        const s = sampleTile(rng, model, ev.tile.cls);
        dur = s.d * tempo;
        content += dur;
        if (ev.storyClass) story += dur;
      } else {
        let raw = 0;
        for (const t of ev.tiles) {
          const s = sampleTile(rng, model, t.cls);
          raw += s.d;
          if (t.cls === "battle" && s.triggered) battles++;
        }
        dur = raw * tempo;
        content += dur;
      }

      perEventStart[i].push(clock);
      clock += dur;
      perEventDur[i].push(dur);
      perEventEnd[i].push(clock);
    }

    totals.push(clock);
    contentTotals.push(content);
    overheadTotals.push(overhead);
    storyTotals.push(story);
    battleCounts.push(battles);
  }

  const rows = events.map((ev, i) => ({
    ...ev,
    meanDur: mean(perEventDur[i]),
    sdDur: stdev(perEventDur[i]),
    p50Start: percentile(perEventStart[i], 0.5),
    p50End: percentile(perEventEnd[i], 0.5),
    p80Dur: percentile(perEventDur[i], 0.8),
  }));

  const meanOverhead = mean(overheadTotals);
  const tempoMean = mean(tempos);
  const tempoP80 = percentile(tempos, 0.8);

  // Content budgets are expressed in PRE-TEMPO minutes — the same units as the
  // E[tile] column of the cost table — so a designer can sum tiles by hand and
  // compare directly. Dividing by tempoP80 is what makes the budget honest: a
  // plan sized to the mean-tempo budget lands late four nights in ten.
  const budgetAt = (offset, tempo) => (offset - meanOverhead) / tempo;

  return {
    session, startMin, targetOffset, hardOffset,
    events: rows, warnings, nBreaks, expectedContent,
    totals: {
      p50: percentile(totals, 0.5),
      p80: percentile(totals, 0.8),
      p95: percentile(totals, 0.95),
      mean: mean(totals),
    },
    content: { mean: mean(contentTotals), p80: percentile(contentTotals, 0.8) },
    overhead: { mean: meanOverhead },
    storyShare: mean(storyTotals) / (mean(contentTotals) || 1),
    battles: { mean: mean(battleCounts) },
    tempo: { mean: tempoMean, p80: tempoP80 },
    budget: {
      planned: expectedContent,
      targetP50: budgetAt(targetOffset, tempoMean),
      targetP80: budgetAt(targetOffset, tempoP80),
      hardP80: budgetAt(hardOffset, tempoP80),
    },
    runs,
  };
}

/** Greedy "what to cut" advice, priced in expected minutes at mean tempo. */
export function suggestCuts(model, plan, result) {
  const overshoot = result.totals.p80 - result.targetOffset;
  if (overshoot <= 0) return { overshoot: 0, options: [] };

  const t = model.tempo.pert;
  const tempo = (t[0] + 4 * t[1] + t[2]) / 6;

  const pool = new Map();
  for (const seg of plan.segments ?? []) {
    for (const tile of orderSegmentTiles(model, seg)) {
      const cls = tile.cls ?? classifyType(model, tile.type) ?? "other";
      const entry = pool.get(tile.type)
        ?? { type: tile.type, cls, n: 0, each: expectedTileMinutes(model, cls) * tempo };
      entry.n++;
      pool.set(tile.type, entry);
    }
  }

  const options = [];
  for (const e of pool.values()) {
    if (e.each < 1) continue;
    // Cap at what is actually planned. A single expensive tile that covers most
    // of the overshoot is better advice than gutting the battle chain, so keep
    // near-misses (>=60% of the gap) and label them.
    const cut = Math.min(Math.ceil(overshoot / e.each), e.n);
    const saves = cut * e.each;
    if (saves < overshoot * 0.6) continue;
    options.push({ ...e, cut, saves, full: saves >= overshoot });
  }
  // Fewest tiles removed wins; a full fix beats a near-miss at equal count.
  options.sort((a, b) => a.cut - b.cut || Number(b.full) - Number(a.full) || b.saves - a.saves);
  return { overshoot, options: options.slice(0, 4) };
}
