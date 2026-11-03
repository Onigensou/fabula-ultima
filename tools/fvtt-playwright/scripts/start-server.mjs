// Start the Foundry server if it's down. Idempotent: no-op when already up.
//   node scripts/start-server.mjs              # headless node server (default)
//   node scripts/start-server.mjs --electron   # desktop GUI app instead
//
// The default "node" launcher is a plain detached child process, so this runs
// fine from ANY context — including the sandboxed Bash tool.
//
// --electron keeps the old behavior and the old constraint: it must be invoked
// from an INTERACTIVE shell (Claude's PowerShell tool, or a normal terminal).
// The launcher double-clicks the desktop app into the interactive desktop; from
// the Bash tool's restricted process context that launch silently no-ops and
// this times out after ~120s.
//
// NOTE: a headless server on the configured port OWNS that port — the human's
// desktop app can't bind it afterwards. Run stop-server.mjs first if they want
// their window back.
import { loadConfig } from "../lib/foundry.js";
import { ensureServerUp, portOf } from "../lib/server.js";

const argv = process.argv.slice(2);
const override = argv.includes("--electron")
  ? "electron"
  : argv.includes("--node")
    ? "node"
    : null;

const cfg = { ...loadConfig(), ...(override ? { launcher: override } : {}) };

console.log(
  `[start-server] target ${cfg.baseURL} via "${cfg.launcher}" launcher (dataPath ${cfg.dataPath})`
);

const t0 = Date.now();
const { started, launcher, pid, logPath } = await ensureServerUp(cfg);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (!started) {
  console.log(`[start-server] already running — nothing to do`);
} else {
  console.log(`[start-server] booted Foundry (${launcher}) — answering ${cfg.baseURL} in ${secs}s`);
  if (pid) console.log(`[start-server] pid ${pid}, log ${logPath}`);
  if (launcher === "node") {
    console.log(
      `[start-server] headless — no window. Stop it with: node scripts/stop-server.mjs ` +
        `(port ${portOf(cfg)})`
    );
  }
}
