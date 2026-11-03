// Stop the Foundry server listening on the configured port.
//   node scripts/stop-server.mjs           # only kills a HEADLESS node server
//   node scripts/stop-server.mjs --force   # also kills the human's desktop app
//
// Safety: by default this refuses to kill the Electron desktop app. That app is
// usually the HUMAN's session — a blind kill-by-port would take down their game
// (and if a world is live, yank a LevelDB writer out from under them). Only a
// server we could plausibly have started (node.exe running Foundry's main.js)
// is killed without --force.
import { execSync } from "node:child_process";
import { loadConfig } from "../lib/foundry.js";
import { isServerUp, describePortOwner, portOf } from "../lib/server.js";

const force = process.argv.slice(2).includes("--force");
const cfg = loadConfig();
const port = portOf(cfg);

if (!(await isServerUp(cfg.baseURL))) {
  console.log(`[stop-server] nothing listening on ${cfg.baseURL}`);
  process.exit(0);
}

const owners = describePortOwner(port);
if (!owners.length) {
  console.log(`[stop-server] could not resolve a PID for port ${port}`);
  process.exit(1);
}

for (const { pid, name, kind } of owners) {
  if (kind !== "foundry-node" && !force) {
    console.log(
      `[stop-server] REFUSING to kill pid ${pid} (${name}, kind=${kind}) on port ${port} — ` +
        `that looks like the desktop app, not a headless server we started.\n` +
        `[stop-server] If you really mean it: node scripts/stop-server.mjs --force`
    );
    process.exit(2);
  }
  execSync(`powershell.exe -NoProfile -NonInteractive -Command "Stop-Process -Id ${pid} -Force"`);
  console.log(`[stop-server] killed pid ${pid} (${name}, kind=${kind}, port ${port})`);
}
