#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// PostToolUse hook — marks the session "skill surface changed" so the Stop-hook
// gate (regression-gate.js) knows to re-run the behavioral regression check at
// end of turn. Fires on Edit/Write of Battle-Director skill-engine code or the
// world's actor skill data.
//
// Deliberately cheap: match a path, append a marker line, exit 0. NEVER blocks
// (the check itself is the Stop hook's job — running a multi-minute harness here,
// per edit, would be intolerable). Wired in .claude/settings.json.
// ───────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

const STATE_DIR = path.resolve(__dirname, "..", ".state");
const MARKER = path.join(STATE_DIR, "pending.json");

// Paths whose edits can regress OTHER skills. Kept in sync with the plan's
// matcher list; the last few engine files do NOT match a skill-*/reaction glob
// so they're named explicitly.
const ENGINE_RE = /[\\/]scripts[\\/]battle-director[\\/](skill-[^\\/]+\.js|[^\\/]*reaction[^\\/]*\.js|[^\\/]*reactor[^\\/]*\.js|state-handlers\.js|states\.js|damage-ruleset\.js|card-mutations\.js|template-field-registry\.js)$/i;
const DATA_RE = /[\\/]worlds[\\/]fabula-ultima-2[\\/]data[\\/]actors[\\/]/i;

function readStdin() {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    // If nothing is piped, don't hang.
    setTimeout(() => resolve(s), 500);
  });
}

(async () => {
  let filePath = "";
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    filePath = input.tool_input?.file_path || input.tool_input?.path || input.tool_input?.notebook_path || "";
  } catch { /* no/invalid stdin — nothing to do */ }
  if (!filePath) process.exit(0);

  const norm = String(filePath).replace(/\\/g, "/");
  const isEngine = ENGINE_RE.test(filePath) || ENGINE_RE.test(norm);
  const isData = DATA_RE.test(filePath) || DATA_RE.test(norm);
  if (!isEngine && !isData) process.exit(0);

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    let marker = { files: [], kinds: {} };
    if (fs.existsSync(MARKER)) { try { marker = JSON.parse(fs.readFileSync(MARKER, "utf8")); } catch {} }
    marker.files = Array.from(new Set([...(marker.files || []), norm])).slice(-50);
    marker.kinds = marker.kinds || {};
    if (isEngine) marker.kinds.engine = true;
    if (isData) marker.kinds.data = true;
    marker.updatedAt = new Date().toISOString();
    fs.writeFileSync(MARKER, JSON.stringify(marker, null, 2));
  } catch { /* best-effort; never fail the tool */ }
  process.exit(0);
})();
