// ───────────────────────────────────────────────────────────────────────────
// "Did the skill SURFACE change?" — the data half of the Stop-hook gate.
//
// The PostToolUse trigger can only see Edit/Write/MultiEdit, and world actor
// data is never written that way: game-open writes go through the test-bridge
// (evalGM, invoked from Bash) and game-closed writes go through safe-edit (a
// Node script, also Bash). So the trigger's `worlds/.../data/actors/**` branch
// never fired once — authoring a skill scheduled no check at all.
//
// Fixing it by matching Bash would mean sniffing arbitrary command strings for
// "did this write actor data", which fails silently in the wrong direction.
// Instead the WRITERS report, each from the one chokepoint it owns:
//
//   • game OPEN   → _test-bridge.js watches Foundry's own document hooks and
//                   publishes a monotonic counter in the heartbeat (state.json).
//                   Foundry is the authority on what actually changed, so this
//                   covers UI edits and other modules too, not just our scripts.
//   • game CLOSED → safe-edit bumps `.state/data-writes.json` when it opens the
//                   actors collection for writing (lib/db.js), as does
//                   world-pack `install` when it swaps the collection wholesale.
//
// The two are combined into one opaque key. The gate stores the key a verdict
// was reached on next to the engine hash and skips only when BOTH still match.
//
// ⚠ Content-hashing the LevelDB instead was the obvious alternative and does
// not work: the actors shards churn from compaction with no content change (it
// is visible in `git status` after any session), so the hash would false-
// positive constantly. Hashing authored content needs the game CLOSED, and the
// check needs it OPEN — the same tension that keeps the world-export pre-commit
// hook from covering this.
// ───────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, "..", "..");
const BRIDGE_STATE = path.join(REPO, "worlds", "fabula-ultima-2", "test-bridge", "state.json");
const STATE_DIR = path.join(ROOT, ".state");
const LOCAL = path.join(STATE_DIR, "data-writes.json");

function readBridgeState() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_STATE, "utf8")); } catch { return null; }
}

/** Game-closed writer counter. Absent = nothing has ever written, i.e. seq 0. */
function readLocal() {
  try {
    const v = JSON.parse(fs.readFileSync(LOCAL, "utf8"));
    return { seq: Number(v.seq) || 0, at: v.at || null, last: v.last || null };
  } catch { return { seq: 0, at: null, last: null }; }
}

/**
 * Called by safe-edit / world-pack when they write the actors collection with
 * the game closed. Best-effort: a failure here must never break a world write,
 * but it does mean a missed bump, so it is logged rather than swallowed silently.
 */
function bumpLocal(reason = "safe-edit") {
  const cur = readLocal();
  const rec = { seq: cur.seq + 1, at: new Date().toISOString(), last: String(reason).slice(0, 160) };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LOCAL, JSON.stringify(rec, null, 2));
    return rec;
  } catch (e) {
    try { process.stderr.write(`⚠ skill-regression: could not record the actor-data write (${e.message})\n`); } catch {}
    return null;
  }
}

/**
 * @returns {{supported:boolean, key:string|null, bridge:object|null, local:object, why:string}}
 *
 * `supported:false` means the in-page watcher isn't reporting — an older module
 * still loaded in the browser, or a boot whose counter could not be seeded from
 * the previous heartbeat. Callers must then fall back to the engine-hash-only
 * decision rather than sweeping every turn: the data half is simply unavailable,
 * which is exactly the state everything was in before this existed.
 */
function dataWitness() {
  const st = readBridgeState();
  const local = readLocal();
  const ss = st && st.skillSurface;
  if (!st) return { supported: false, key: null, bridge: null, local, why: "no bridge heartbeat" };
  if (!ss || ss.seq == null) {
    return { supported: false, key: null, bridge: null, local, why: "bridge predates the skill-surface watcher (reload Foundry)" };
  }
  if (ss.seeded === false) {
    // The counter restarted at 0 because the previous heartbeat was unreadable,
    // so it is NOT comparable with a key recorded before this boot. Refusing to
    // claim support costs a redundant sweep; trusting it would skip a real one.
    return { supported: false, key: null, bridge: { ...ss, bootId: st.bootId }, local, why: "counter could not be seeded from the previous heartbeat" };
  }
  return {
    supported: true,
    key: `bridge:${ss.seq}|local:${local.seq}`,
    bridge: { seq: ss.seq, at: ss.at || null, last: ss.last || null, bootId: st.bootId || null },
    local,
    why: "",
  };
}

module.exports = { dataWitness, bumpLocal, readLocal, BRIDGE_STATE, LOCAL };
