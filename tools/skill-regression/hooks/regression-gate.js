#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// Stop hook — behavioral-regression gate. At end of a turn that touched
// skill-engine code or world skill data (marker written by on-skill-edit.js),
// re-run the compute-mode regression check and surface any drift.
//
//   • marker absent            → exit 0 (nothing changed this turn).
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

const MARKER = path.join(ROOT, ".state", "pending.json");
const clearMarker = () => { try { fs.unlinkSync(MARKER); } catch {} };

// Consume (and ignore) stdin so the parent isn't left writing to a closed pipe.
try { fs.readFileSync(0, "utf8"); } catch {}

if (!fs.existsSync(MARKER)) process.exit(0);

let marker = {};
try { marker = JSON.parse(fs.readFileSync(MARKER, "utf8")); } catch {}
const kinds = Object.keys(marker.kinds || {}).join("+") || "skill";

// ── cheap semantic gate, before anything that costs time ────────────────────
// Only safe when the marker is engine-ONLY: the hash covers battle-director
// source, so a world-data edit must always fall through to the real check.
const fp = engineFingerprint();
const verified = readVerified();

if (fp.hash && !marker.kinds?.data && verified && verified.hash === fp.hash) {
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
  process.stderr.write(`⏳ skill-regression: ${kinds} changed this turn but Foundry is closed — regression check deferred until the world is open (marker kept).\n`);
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
recordVerified({ total: counts.total, drift: counts.added + counts.removed + counts.changed, by: "stop-hook" }, fp);

if (!counts.added && !counts.removed && !counts.changed) {
  process.stderr.write(`✓ skill-regression: ${counts.total} skills checked after ${kinds} edit — no behavioral drift.\n`);
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
process.stderr.write(lines.join("\n") + "\n");
process.exit(2);
