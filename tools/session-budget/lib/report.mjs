/**
 * Terminal rendering. Everything is expressed in WALL-CLOCK time, because
 * "the dungeon takes 3h40" is not actionable and "you open the story beat at
 * 23:40" is.
 */
import { formatClock, formatDuration, expectedTileMinutes } from "./model.mjs";
import { pertMean } from "./random.mjs";

const GLYPH = {
  open: "▓", close: "▓", break: "▓", transition: "▒",
  chain: "░", story: "■", camp: "◆",
};

export function renderReport(model, plan, result, cuts, { color = true } = {}) {
  const C = color ? {
    dim: s => `\x1b[2m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
    red: s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    green: s => `\x1b[32m${s}\x1b[0m`,
  } : { dim: s => s, bold: s => s, red: s => s, yellow: s => s, green: s => s };

  const L = [];
  const clock = off => formatClock(result.startMin + off);

  L.push("");
  L.push(C.bold(plan.name ?? plan._file ?? "SESSION PLAN"));
  L.push(C.dim(`${result.session.start} start  ·  target ${result.session.target}  ·  hard stop ${result.session.hardStop}  ·  ${result.runs} runs`));
  L.push("");

  // ── Timeline ──────────────────────────────────────────────────────────────
  const WIDTH = 46;
  for (const ev of result.events) {
    const g = GLYPH[ev.glyph] ?? " ";
    const start = clock(ev.p50Start);
    const label = ev.label.length > WIDTH ? `${ev.label.slice(0, WIDTH - 1)}…` : ev.label;
    const dur = `${Math.round(ev.meanDur)}m`.padStart(4);
    const sd = ev.sdDur >= 1 ? C.dim(` ± ${String(Math.round(ev.sdDur)).padEnd(2)}`) : "      ";
    let line = ` ${start}  ${g} ${label.padEnd(WIDTH)} ${dur}${sd}`;

    if (ev.storyClass) {
      // The last moment you can open this beat and still land on the target,
      // priced at the beat's own P80 length rather than its average.
      const lastSafeOff = result.targetOffset - ev.p80Dur;
      const lastSafe = clock(lastSafeOff);
      const late = ev.p50Start > lastSafeOff;
      const note = late
        ? `  ◀ OPENS TOO LATE (last safe start ${lastSafe})`
        : `  ◀ last safe start ${lastSafe}`;
      line += late ? C.red(note) : C.dim(note);
    }
    L.push(line);
  }
  L.push(` ${clock(result.totals.p50)}  ${C.dim("└ session ends (P50)")}`);
  L.push("");

  // ── Headline ──────────────────────────────────────────────────────────────
  const verdict = (off) => {
    if (off <= result.targetOffset) return C.green("✅");
    if (off <= result.hardOffset) return C.yellow("⚠ past target");
    return C.red("⛔ past hard stop");
  };
  L.push(` ${C.bold("P50")} ${clock(result.totals.p50)} ${verdict(result.totals.p50)}    ` +
         `${C.bold("P80")} ${clock(result.totals.p80)} ${verdict(result.totals.p80)}    ` +
         `${C.bold("P95")} ${clock(result.totals.p95)} ${verdict(result.totals.p95)}`);
  L.push("");
  L.push(C.dim(` content ${formatDuration(result.content.mean)}   overheads ${formatDuration(result.overhead.mean)} ` +
               `(${result.nBreaks} break${result.nBreaks === 1 ? "" : "s"})   ` +
               `expected battles ${result.battles.mean.toFixed(1)}`));
  const over80 = result.budget.planned - result.budget.targetP80;
  L.push(C.dim(` content budget (pre-tempo, same units as --table):`));
  L.push(C.dim(`   ${String(Math.round(result.budget.targetP80)).padStart(3)}m  to land P80 on ${result.session.target}` +
               `        ${String(Math.round(result.budget.hardP80)).padStart(3)}m  to land P80 on ${result.session.hardStop}`));
  L.push(C.dim(`   ${String(Math.round(result.budget.targetP50)).padStart(3)}m  to land P50 on ${result.session.target}` +
               `        ${String(Math.round(result.budget.planned)).padStart(3)}m  planned` +
               (over80 > 0 ? C.yellow(`  (+${Math.round(over80)}m over the P80 budget)`) : C.green("  ✅"))));
  L.push("");

  // Safe stops are needed by both the warnings and the stop-point section.
  const all = result.events
    .filter(ev => ev.safeStop)
    .map(ev => ({
      label: ev.safeStop,
      // A scene boundary is safe on ARRIVAL; everything else once it has finished.
      at: ev.glyph === "transition" ? ev.p50Start : ev.p50End,
    }))
    .sort((a, b) => a.at - b.at);

  // ── Warnings ──────────────────────────────────────────────────────────────
  const warns = [];

  // A long run with nowhere clean to stop is how a session overshoots even when
  // the total looks fine — you cannot call it mid-chain without leaving the
  // party stranded on a live tile.
  {
    const marks = [0, ...all.map(s => s.at), result.totals.p50];
    let worst = 0, worstAt = 0;
    for (let i = 1; i < marks.length; i++) {
      const gap = marks[i] - marks[i - 1];
      if (gap > worst) { worst = gap; worstAt = marks[i - 1]; }
    }
    if (worst > 75) {
      warns.push(`Longest stretch with no safe stop: ${Math.round(worst)}m ` +
                 `(${clock(worstAt)} → ${clock(worstAt + worst)}). Consider a camp tile or scene break inside it.`);
    }
  }

  if (result.content.mean > result.budget.target) {
    warns.push(`Over content budget by ${Math.round(result.content.mean - result.budget.target)}m.`);
  }
  // Session composition: exactly one narrative beat per session. Zero is a
  // boring night (nothing about the plot gets revealed); two busts the window.
  // A Rare Monster is story-CLASS in cost but is not a beat, so it does not count.
  {
    const want = model.guidelines.narrativeBeatsPerSession ?? 1;
    const beats = result.events.filter(ev => ev.tile && model.classes[ev.tile.cls]?.narrativeBeat).length;
    if (beats < want) {
      warns.push(`No narrative beat this session (${beats}/${want} Story or Final Story tile). ` +
                 `A gameplay-only night reveals nothing about the plot — we play weekly, so the story stalls a full week.`);
    } else if (beats > want) {
      warns.push(`${beats} narrative beats planned (want ${want}). Story-class tiles cost 30-60m each; ` +
                 `two of them plus a tile chain busts the window on their own. Move one to next session.`);
    }
  }

  if (result.storyShare > model.guidelines.storyClassShareWarn) {
    warns.push(`Story-class tiles are ${Math.round(result.storyShare * 100)}% of content ` +
               `(guideline: ≤ ${Math.round(model.guidelines.storyClassShareWarn * 100)}%). ` +
               `One big narrative beat per session, not two.`);
  }
  if (result.totals.p95 > result.hardOffset) {
    warns.push(`P95 lands ${clock(result.totals.p95)} — past the ${result.session.hardStop} hard stop.`);
  }
  for (const w of result.warnings) warns.push(w);
  for (const w of warns) L.push(` ${C.yellow("⚠")} ${w}`);
  if (warns.length) L.push("");

  // ── Safe stopping points ──────────────────────────────────────────────────
  // The two that matter: the last clean break before the target, and the first
  // one after it. The rest is padding.
  const before = all.filter(s => s.at <= result.targetOffset);
  const after = all.filter(s => s.at > result.targetOffset);
  const stops = [...before.slice(-2), ...after.slice(0, 2)];

  if (stops.length) {
    L.push(C.bold(` SAFE STOP POINTS (target ${result.session.target})`));
    for (const s of stops) {
      const delta = s.at - result.targetOffset;
      const sign = delta >= 0 ? "+" : "−";
      const isRecommended = s === before[before.length - 1];
      const mark = delta <= 0
        ? (isRecommended ? C.green("✅ cleanest cut-off") : C.green("✅"))
        : s.at + result.startMin <= result.startMin + result.hardOffset
          ? C.yellow("⚠ past target, inside hard stop")
          : C.red("⛔ past hard stop");
      L.push(`   → ${s.label.padEnd(26)} ${clock(s.at)}  ${(sign + Math.abs(Math.round(delta)) + "m").padStart(6)}  ${mark}`);
    }
    L.push("");
  }

  // ── What to cut ───────────────────────────────────────────────────────────
  if (cuts?.options?.length) {
    L.push(C.bold(` TO LAND P80 ON TARGET — cut ${Math.round(cuts.overshoot)}m`));
    for (const o of cuts.options) {
      const lands = clock(result.totals.p80 - o.saves);
      const tail = o.full ? C.dim(`P80 → ${lands}`) : C.yellow(`P80 → ${lands}, still ${Math.round(cuts.overshoot - o.saves)}m over`);
      L.push(`   → drop ${String(o.cut).padStart(2)} × ${o.type.padEnd(20)} ` +
             C.dim(`~${String(Math.round(o.saves)).padStart(3)}m  (${o.each.toFixed(1)}m each, ${o.n} planned)  `) + tail);
    }
    L.push("");
  }

  return L.join("\n");
}

/** `--table`: print the cost model itself, so the numbers are auditable. */
export function renderCostTable(model, { color = true } = {}) {
  const C = color ? { bold: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` }
                  : { bold: s => s, dim: s => s };
  const L = ["", C.bold(" TILE COST MODEL") , ""];
  L.push(C.dim("  class          p     min/mode/max      E[tile]"));
  for (const [key, c] of Object.entries(model.classes)) {
    const band = `${c.event[0]}/${c.event[1]}/${c.event[2]}`;
    const e = expectedTileMinutes(model, key);
    L.push(`  ${c.label.padEnd(13)} ${String(c.p ?? 1).padEnd(5)} ${band.padEnd(17)} ${e.toFixed(1).padStart(5)}m` +
           (c.pass ? C.dim(`   pass ${c.pass.join("/")}`) : ""));
  }
  L.push("");
  L.push(C.dim(`  tempo   ${model.tempo.pert.join(" / ")}  (content only)`));
  for (const [k, v] of Object.entries(model.overheads)) {
    if (!v.pert) continue;
    L.push(C.dim(`  ${k.padEnd(16)} ${v.pert.join(" / ")}  ≈ ${pertMean(v.pert).toFixed(1)}m` +
                 (v.note ? `   ${v.note}` : "")));
  }
  L.push("");
  return L.join("\n");
}
