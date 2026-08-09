#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// Stop hook — behavioral-regression gate. At end of a turn that touched
// skill-engine code or world skill data (marker written by on-skill-edit.js),
// re-run the compute-mode regression check and surface any drift.
//
//   • marker absent AND actor
//     data unchanged            → exit 0 (nothing changed this turn).
//   • actor data changed        → run, even with no marker. The PostToolUse
//                                trigger only sees Edit/Write, and world data is
//                                written through the bridge or safe-edit (both
//                                Bash), so its `data/actors/**` branch never
//                                fired once and authoring scheduled no check at
//                                all. lib/data-witness.js reads the counter the
//                                WRITERS publish instead.
//   • engine code semantically
//     unchanged since the last
//     completed check           → clear marker, one-line note, exit 0. The sweep
//                                is ~22 min (measured 2026-08-08: 491 skills,
//                                compute, 1294 s), and a path-match trigger fired
//                                it for comment rewrites, re-indents and
//                                edit-then-revert turns too. lib/engine-
//                                fingerprint.js hashes the engine with comments
//                                and formatting removed; an exact match with the
//                                hash recorded at the last check means the check
//                                can only reproduce its previous verdict.
//                                Never taken when world DATA also changed (the
//                                hash covers code only), and any stripper trouble
//                                changes the hash rather than preserving it — so
//                                the failure direction is a redundant run, never
//                                a missed regression.
//   • bridge (game) not alive  → keep the marker, print a one-line reminder,
//                                exit 0. The check runs on a later turn once
//                                Foundry is open. bridgeAlive() is a quick stat,
//                                so this never hangs.
//   • bridge alive, drift      → clear marker, exit 2 with a concise summary
//                                (fed back so it's seen once — advisory: review,
//                                re-baseline with `check --update` if intended).
//   • bridge alive, clean/setup→ clear marker, exit 0.
//
// The check itself is capped by a kill-timer so a wedged bridge can't freeze
// turn-end. Scene/mode are overridable via SKILL_REGRESSION_CHECK_ARGS.
// ───────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const { bridgeAlive } = require(path.join(ROOT, "lib", "bridge.js"));
const { engineFingerprint, readVerified, recordVerified } = require(path.join(ROOT, "lib", "engine-fingerprint.js"));
const { dataWitness } = require(path.join(ROOT, "lib", "data-witness.js"));

const MARKER = path.join(ROOT, ".state", "pending.json");
const clearMarker = () => { try { fs.unlinkSync(MARKER); } catch {} };

// Consume (and ignore) stdin so the parent isn't left writing to a closed pipe.
try { fs.readFileSync(0, "utf8"); } catch {}

const fp = engineFingerprint();
const verified = readVerified();

// ── did actor data change since the verdict we're holding? ──────────────────
// `supported:false` = the in-page watcher isn't reporting (old module still
// loaded in the browser, or a boot that couldn't seed its counter). Then the
// data half is simply unavailable and we decide on the engine hash alone —
// the state everything was in before this existed — rather than sweeping every
// turn until someone reloads Foundry.
const witness = dataWitness();
const dataChanged = witness.supported && (!verified || verified.dataKey !== witness.key);

const hasMarker = fs.existsSync(MARKER);
if (!hasMarker && !dataChanged) process.exit(0);

let marker = {};
if (hasMarker) { try { marker = JSON.parse(fs.readFileSync(MARKER, "utf8")); } catch {} }
const kindList = Object.keys(marker.kinds || {});
if (dataChanged && !kindList.includes("data")) kindList.push("data");
const kinds = kindList.join("+") || "skill";

// ── cheap semantic gate, before anything that costs time ────────────────────
// Only safe when NOTHING on the data side moved: the hash covers battle-director
// source, so an actor-data change must always fall through to the real check.
if (fp.hash && !dataChanged && !marker.kinds?.data && verified && verified.hash === fp.hash) {
  const when = verified.at ? ` (checked ${verified.at})` : "";
  const unchanged = `engine code is semantically unchanged since the last check${when} — comments/formatting only, sweep skipped`;
  // The skip carries forward the LAST verdict, and that verdict may have been
  // drift — recordVerified writes on drift too, deliberately, so a re-run only
  // reprints the same summary at full cost. But then a bare ✓ would report the
  // outstanding drift as clean. Carry the verdict, not just the skip.
  const drift = Number(verified.drift) || 0;
  process.stderr.write(drift
    ? `⚠ skill-regression: ${unchanged}. That check reported ${drift} skill${drift === 1 ? "" : "s"} of drift, still unreviewed — re-run \`check\` for the detail, or re-baseline with \`check --update\`.\n`
    : `✓ skill-regression: ${unchanged}.\n`);
  clearMarker();
  process.exit(0);
}

if (!bridgeAlive()) {
  // A data-only trigger needs no marker to survive: `dataChanged` is derived by
  // comparing against the verdict we're still holding, so it stays true on every
  // later turn until a check actually runs. The marker is only what carries an
  // ENGINE edit forward.
  const kept = hasMarker ? " (marker kept)" : "";
  process.stderr.write(`⏳ skill-regression: ${kinds} changed this turn but Foundry is closed — regression check deferred until the world is open${kept}.\n`);
  process.exit(0);
}

// Default to the whole-catalog Regression Bench so auto-enforcement covers
// ClassTemplates/bosses/guests, not just whatever scene happens to be active —
// the golden is scene-specific, so this must match the scene the golden was
// captured on. Override the whole arg list via SKILL_REGRESSION_CHECK_ARGS
// (e.g. a faster subset: `--scene "Training Ground"` or `--caster Hina`).
const DEFAULT_CHECK = ['--scene', 'Regression Bench', '--dummy', 'Test Target Enemy'];
const env = (process.env.SKILL_REGRESSION_CHECK_ARGS || "").trim();
// naive but sufficient split that keeps simple "quoted phrases" together
const extra = env ? (env.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((s) => s.replace(/^["']|["']$/g, "")) : DEFAULT_CHECK;
// The bench is EPHEMERAL — it is torn down after every run so it never sits in
// the world at commit time (a world commit is a wholesale binary dump; a resident
// scene would ship to the co-dev). So the gate has to build it before checking,
// and `--teardown` removes it again afterwards. Safe on both counts: `bench` is
// idempotent (reuses the scene and places only missing tokens), and the goldens
// are keyed "<Actor> / <Skill>", never by scene or token id, so a rebuilt bench
// still diffs against the same golden. Skipped when the caller overrode the args
// (their scene is their business).
// ── the CONFIG half ────────────────────────────────────────────────────────
// The behavioral check can only see what COMPUTE exercises, so a change to
// config it never reads — `skill_tags` (the Dance framework's match key),
// `target_eligibility`, an AE change VALUE — passes it green. It also drops any
// doc that stops being a usable skill, so flipping one to Passive removes it
// from coverage entirely. `structure` diffs the authored shape of every
// skill-shaped doc instead, needs no bench, and costs well under a second, so
// the gate always runs it. Never fatal on its own error: a missing golden or a
// closed bridge must not turn into a false "drift".
function structureVerdict() {
  const r = spawnSync("node", ["bin/skill-regression.js", "structure", "--json"], {
    cwd: ROOT, encoding: "utf8", timeout: 90 * 1000, maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status == null || r.status > 1) return { drifted: false, note: "", text: "" };
  let out = null;
  try { out = JSON.parse(r.stdout || "{}"); } catch { return { drifted: false, note: "", text: "" }; }
  const c = out.counts || {};
  const n = (c.changed || 0) + (c.added || 0) + (c.removed || 0);
  if (!n) return { drifted: false, note: ` (config golden clean, ${c.total || 0} docs)`, text: "" };
  const lines = [`⚠ skill-regression CONFIG drift (${c.changed || 0} changed, ${c.added || 0} new, ${c.removed || 0} removed) — a change COMPUTE cannot see:`];
  for (const ch of (out.changed || []).slice(0, 10)) {
    lines.push(`  ~ ${ch.key}`);
    for (const d of (ch.diffs || []).slice(0, 4)) lines.push(`      ${d}`);
  }
  for (const k of (out.removed || []).slice(0, 6)) lines.push(`  - REMOVED ${k}`);
  for (const k of (out.added || []).slice(0, 6)) lines.push(`  + NEW ${k}`);
  lines.push(`If intended: node tools/skill-regression/bin/skill-regression.js structure --update`);
  return { drifted: true, note: "", text: lines.join("\n") + "\n" };
}

if (!env) {
  const build = spawnSync("node", ["bin/skill-regression.js", "bench"], {
    cwd: ROOT, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
  });
  if (build.status !== 0) {
    const why = build.error ? build.error.message : ((build.stderr || "").trim().split("\n").pop() || `exit ${build.status}`);
    process.stderr.write(`⚠ skill-regression: could not build the bench (${why}). Marker cleared; run the check manually.\n`);
    clearMarker();
    process.exit(0);
  }
}

// Kill-timer sized off a MEASURED full run, not a guess: 2026-08-08, 491 skills
// in compute mode take 109 s (down from 1294 s — see the module-reuse fix in the
// README). The old 6-minute cap killed every whole-catalog run a third of the way
// through, so the gate paid the time and still reported "could not evaluate
// drift". 12 min is ~6× the real run: enough for a slow machine or the
// --no-deps-reuse path, without letting a wedged bridge hold turn-end for half an
// hour. The Stop-hook timeout in .claude/settings.json has to stay above this or
// the outer kill lands first.
const args = ["bin/skill-regression.js", "check", "--mode", "compute", "--json", ...extra];
const run = spawnSync("node", args, { cwd: ROOT, encoding: "utf8", timeout: 12 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });

// Tear down UNCONDITIONALLY — not via the check's own --teardown flag. The check
// runs under a kill-timer so turn-end can't hang, and a killed process never
// reaches its cleanup: the bench would then sit in the world until someone
// noticed, which is the exact failure this is meant to prevent. Cheap, and
// idempotent when the bench is already gone.
if (!env) {
  spawnSync("node", ["bin/skill-regression.js", "teardown"], {
    cwd: ROOT, encoding: "utf8", timeout: 2 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
  });
}

// Parse the tool's JSON verdict from stdout; anything else = couldn't evaluate.
let verdict = null;
try { verdict = JSON.parse((run.stdout || "").trim()); } catch {}

if (!verdict || !verdict.counts) {
  const why = run.error ? run.error.message : ((run.stderr || "").trim().split("\n").pop() || "no JSON output");
  process.stderr.write(`⚠ skill-regression: could not evaluate drift (${why}). Marker cleared; run \`node tools/skill-regression/bin/skill-regression.js check\` manually.\n`);
  clearMarker();
  process.exit(0);
}

const { added, removed, changed, counts } = verdict;
clearMarker();
// Record the fingerprint the verdict belongs to — on drift as well as on clean.
// The check DID evaluate this exact code; re-running it next turn would only
// reprint the same 12 lines at a 22-minute cost. Deliberately NOT recorded when
// the run failed to produce a verdict (above), so that case retries.
// `witness` was sampled BEFORE the run, deliberately: recording the post-run
// value would swallow any actor write that landed while the check was in
// flight. Sampling first means such a write still reads as "changed" next turn.
recordVerified({
  total: counts.total,
  drift: counts.added + counts.removed + counts.changed,
  by: "stop-hook",
  dataKey: witness.key,
}, fp);

if (!counts.added && !counts.removed && !counts.changed) {
  const s = structureVerdict();
  if (s.drifted) {
    process.stderr.write(`✓ skill-regression: ${counts.total} skills checked after ${kinds} edit — no behavioral drift.\n${s.text}`);
    process.exit(2);
  }
  process.stderr.write(`✓ skill-regression: ${counts.total} skills checked after ${kinds} edit — no behavioral drift${s.note}.\n`);
  process.exit(0);
}

// Drift — build a concise, review-oriented summary and surface it once.
const lines = [];
lines.push(`⚠ skill-regression drift after a ${kinds} edit (${counts.changed} changed, ${counts.added} new, ${counts.removed} removed):`);
for (const c of (changed || []).slice(0, 12)) {
  lines.push(`  ~ ${c.key}`);
  for (const d of (c.diffs || []).slice(0, 4)) lines.push(`      ${d}`);
}
if ((changed || []).length > 12) lines.push(`  … +${changed.length - 12} more changed`);
for (const k of (removed || []).slice(0, 8)) lines.push(`  - REMOVED ${k}`);
for (const k of (added || []).slice(0, 8)) lines.push(`  + NEW ${k}`);
lines.push(`Review whether this is intended. If it is, re-baseline: node tools/skill-regression/bin/skill-regression.js check --update`);
const sv = structureVerdict();
if (sv.drifted) lines.push(sv.text.replace(/\n$/, ""));
process.stderr.write(lines.join("\n") + "\n");
process.exit(2);
