// Foundry SERVER lifecycle — start the local Foundry server when it's down.
//
// The rest of the harness (lib/foundry.js connect()) drives the BROWSER and
// assumes a server is already listening on :30000. This module fills the gap:
// it can boot the server process itself so the closed -> open flow is fully
// autonomous.
//
// TWO LAUNCHERS (cfg.launcher, default "node"):
//
//   "node"     — HEADLESS. `node <app>/main.js --dataPath=… --port=…`, run with
//                the SYSTEM node. One process, ~94 MB, NO GPU/renderer process
//                at all. This is the default: the harness drives Foundry through
//                its own Playwright Chromium, so a desktop window is dead weight
//                (and a renderer we don't need is a TDR-BSOD risk — see the
//                machine-gpu-tdr-bsod-hazard memory).
//
//   "electron" — the desktop GUI app. 5 processes, ~551 MB, opens a window.
//                Use when a HUMAN wants to look at the running game.
//
// Verified 2026-08-02 on Foundry 12.343 / Node v24.15.0:
//   - Headless node works from the EXISTING desktop install's resources/app —
//     no separate "Node dedicated server" download needed.
//   - The old "the desktop build hard-requires electron" belief was wrong. The
//     import is CONDITIONAL: dist/init.mjs does `if (s.isElectron) import(
//     "./interface/electron.js")`, and dist/core/config.mjs sets
//     `isElectron = process.versions.hasOwnProperty("electron")`. The failure
//     that produced that belief came from ELECTRON_RUN_AS_NODE=1, which KEEPS
//     process.versions.electron set — so it took the branch and died on
//     require("electron"). Plain system `node` never does.
//   - No classic-level ABI problem: it ships an N-API prebuild
//     (prebuilds/win32-x64/node.napi.node), stable across Node majors. Node 24
//     boots fine despite package.json engines "<22.0.0" — main.mjs only
//     enforces major >= 18.
//   - --port / --noupnp are RUNTIME-only: booting and shutting down with them
//     left Config/options.json byte-identical. Safe against the live dataPath.
//
// Electron-launcher quirks (still true, still load-bearing — don't re-derive):
//   1. Spawning the .exe directly as a child of our shell/node process makes it
//      exit 0 immediately without ever running Foundry's JS. The ONLY launch
//      that reliably boots it is PowerShell's
//      `Start-Process explorer.exe -ArgumentList '"<exe>"'` — Explorer becomes
//      the shell parent and the app boots as if double-clicked. Things that do
//      NOT work: Start-Process on the exe directly (exit 0), `cmd /c start`
//      (mangles the spaced path's backslashes), and Node spawning explorer.exe
//      directly (explorer's non-standard arg parsing drops the path).
//   2. It ignores --dataPath / --port and uses its own remembered user-data path
//      plus that path's Config/options.json port.
//   3. It must be launched from an INTERACTIVE shell, or the launch silently
//      no-ops. The node launcher has NONE of these constraints — it is an
//      ordinary child process and starts fine from any context.
//
// Because `world` is null in the Foundry options, the server boots to /setup
// quickly; connect()'s launchWorldFromSetup() then activates the world.

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Probe the base URL once. Resolves true if the server answered with ANY HTTP
 * status (302 -> /setup or /join, 200, etc.), false on connection refused /
 * timeout. Never throws.
 */
export async function isServerUp(baseURL, timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // redirect:"manual" so a 302 to /setup counts as "up" without a second hop.
    await fetch(baseURL, { signal: ac.signal, redirect: "manual" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Poll isServerUp() until true or the deadline elapses. */
async function waitForServer(baseURL, timeoutMs, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  // Date.now() here is fine — this is a live tool script, not a replayable workflow.
  while (Date.now() < deadline) {
    if (await isServerUp(baseURL)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/** Field delimiter for describePortOwner's PowerShell rows — see the note there. */
const ROW_SEP = "|=|";

/** Port from cfg.baseURL, defaulting to Foundry's 30000. */
export function portOf(cfg) {
  return Number(new URL(cfg.baseURL).port || 30000);
}

/**
 * Run a PowerShell script via -EncodedCommand. Base64/UTF-16LE sidesteps every
 * layer of quote mangling between execSync, cmd, and PowerShell's own parser —
 * which matters because these scripts embed quotes and pipes.
 */
function runPowerShell(script) {
  // $ProgressPreference: without it, cmdlets like Get-NetTCPConnection emit a
  // progress record that PowerShell serializes to stderr as "#< CLIXML …".
  // stdio stderr:"ignore" keeps any such noise out of our console regardless.
  const full = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Path to the Foundry server entry point. Explicit cfg.foundryMain wins;
 * otherwise derive it from the desktop install (<exe dir>/resources/app/main.js)
 * — the same tree serves both launchers.
 */
export function resolveMainJs(cfg) {
  if (cfg.foundryMain) return cfg.foundryMain;
  if (!cfg.foundryExe) return "";
  return join(dirname(cfg.foundryExe), "resources", "app", "main.js");
}

/**
 * Identify who is listening on a port, so callers can avoid killing the human's
 * desktop app by accident.
 *
 * @returns {Array<{pid:number, name:string, cmd:string, kind:"foundry-node"|"electron"|"other"}>}
 */
export function describePortOwner(port) {
  // Rows are joined with a literal delimiter rather than an escape sequence:
  // PowerShell backtick escapes (`t) are LITERAL inside single-quoted strings,
  // which silently produced unsplittable rows here once already.
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `Get-NetTCPConnection -State Listen -LocalPort ${port} |`,
    `  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {`,
    `    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_"`,
    `    if ($p) {`,
    `      @($p.ProcessId, $p.Name, ($p.CommandLine -replace '\\s+', ' ')) -join '${ROW_SEP}'`,
    `    }`,
    `  }`,
  ].join("\n");

  let out = "";
  try {
    out = runPowerShell(script);
  } catch {
    return [];
  }

  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, name, ...rest] = line.split(ROW_SEP);
      const cmd = rest.join(ROW_SEP) ?? "";
      let kind = "other";
      if (/^node\.exe$/i.test(name) && /main\.js/i.test(cmd)) kind = "foundry-node";
      else if (/foundry/i.test(name)) kind = "electron";
      return { pid: Number(pid), name, cmd, kind };
    })
    .filter((p) => Number.isFinite(p.pid));
}

/**
 * Launch the HEADLESS Node server. An ordinary detached child process: it
 * outlives us (Claude starts it and walks away) and needs no interactive shell.
 * stdout/stderr go to <dataPath>/Logs/headless-server.log so a failed boot is
 * diagnosable instead of silent.
 */
function spawnServerNode(cfg) {
  const mainJs = resolveMainJs(cfg);
  if (!mainJs || !existsSync(mainJs)) {
    throw new Error(
      `[fvtt] cannot start server: Foundry main.js not found (${mainJs || "unset"}). ` +
        `Set "foundryExe" (or "foundryMain") in config.local.json.`
    );
  }
  // Unlike the desktop app, the Node server has NO remembered user-data path.
  if (!cfg.dataPath) {
    throw new Error(
      `[fvtt] cannot start server: the node launcher requires "dataPath" in ` +
        `config.local.json (the Foundry user-data dir holding Config/license.json).`
    );
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) {
    throw new Error(
      `[fvtt] node ${process.versions.node} is too old for Foundry (needs >= 18). ` +
        `Use launcher:"electron", or upgrade Node.`
    );
  }

  const logDir = join(cfg.dataPath, "Logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "headless-server.log");
  const fd = openSync(logPath, "a");

  // --port/--noupnp are runtime-only (verified: options.json unchanged after a
  // boot+shutdown), so passing them never mutates the user's saved config.
  const args = [mainJs, `--dataPath=${cfg.dataPath}`, `--port=${portOf(cfg)}`];
  if (cfg.noupnp !== false) args.push("--noupnp");

  const child = spawn(process.execPath, args, {
    cwd: dirname(mainJs),
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, logPath };
}

/**
 * Launch the Foundry desktop app through the shell (see header quirk #1) so it
 * boots normally and OUTLIVES this Node process. `Start-Process` detaches the
 * real app from our process tree, so we don't get its pid back; ensureServerUp()
 * confirms liveness by polling the port instead.
 */
function spawnServerElectron(cfg) {
  if (!cfg.foundryExe || !existsSync(cfg.foundryExe)) {
    throw new Error(
      `[fvtt] cannot start server: foundryExe not found (${cfg.foundryExe}). ` +
        `Set "foundryExe" in config.local.json.`
    );
  }

  // Start-Process explorer.exe -ArgumentList '"<exe>"'  ==  double-clicking it.
  // No app args: the desktop client uses its remembered user-data path (already
  // this project's data dir). The exe path is wrapped in PS single quotes (so
  // backslashes/spaces stay literal) AND inner double quotes (so explorer sees
  // it as one argument).
  const psCommand = `Start-Process explorer.exe -ArgumentList '"${cfg.foundryExe}"'`;
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psCommand],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
  return {};
}

/**
 * Ensure a Foundry server is listening on cfg.baseURL. If one already is,
 * no-op. Otherwise boot it and wait until it answers.
 *
 * @returns {Promise<{started: boolean, launcher: string|null, pid?: number, logPath?: string}>}
 *   started=false  -> a server was already up (we did not touch it)
 *   started=true   -> we booted it
 */
export async function ensureServerUp(cfg) {
  if (await isServerUp(cfg.baseURL)) return { started: false, launcher: null };

  const launcher = String(cfg.launcher ?? "node").toLowerCase();
  if (launcher !== "node" && launcher !== "electron") {
    throw new Error(`[fvtt] unknown launcher "${cfg.launcher}" (expected "node" or "electron").`);
  }

  const info = launcher === "electron" ? spawnServerElectron(cfg) : spawnServerNode(cfg);
  const timeoutMs = Number(cfg.serverStartTimeoutMs ?? 120000);
  const ok = await waitForServer(cfg.baseURL, timeoutMs);
  if (!ok) {
    const hint = info.logPath
      ? ` See ${info.logPath}.`
      : cfg.dataPath
        ? ` Check ${cfg.dataPath}/Logs.`
        : "";
    throw new Error(
      `[fvtt] launched Foundry (${launcher}) but it did not answer ${cfg.baseURL} ` +
        `within ${Math.round(timeoutMs / 1000)}s.${hint}`
    );
  }
  return { started: true, launcher, ...info };
}
