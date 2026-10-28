#!/usr/bin/env node
// ============================================================================
// ping-watch.js — host-side round-trip log for each remote client of Foundry
//
// Run on the HOST during a session or test (no admin needed):
//   node ping-watch.js [--port 30000] [--every 2] [--controls 192.168.1.1,1.1.1.1] [--no-pathping]
//
// Writes FoundryVTT/Logs/ping-watch-<date>_<time>.log (outside the repo: it holds
// full player IPs). Every --every seconds it pings each remote IP that has an
// established connection to --port, plus the control targets, and logs:
//   PING     <ip>  <ms> | timeout          one line per probe
//   NEW      <ip>  first connection seen   a pathping of the route runs once; its table goes in the log
//   GONE     <ip>  no connection left
//   SPIKE / TIMEOUT / BACK                 a probe well above that target's recent median, or lost
//   SUMMARY  every 15 min: median / p95 / max / timeouts per target
// stdout shows only what's worth a look (everything except PING), player IPs masked to /16.
//
// How to read it (H2 in player-reloads/CASE.md):
//   - the player's RTT spikes or times out while both controls stay flat = their route or line;
//   - the public control spikes too = the host's own uplink (a stream, a download);
//   - a player IP that never answers = their router drops ping; rely on tcp-watch for that player.
// ============================================================================
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const PORT = Number(args.port ?? 30000);
const EVERY_MS = Number(args.every ?? 2) * 1000;
const CONTROLS = String(args.controls ?? "192.168.1.1,1.1.1.1").split(",").filter(Boolean);
const PATHPING = !args["no-pathping"];
const LOGS = args.logs ?? path.resolve(__dirname, "../../../../../../Logs");

const pad = (n, w = 2) => String(n).padStart(w, "0");
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
const OUT = args.out ?? path.join(LOGS, `ping-watch-${stamp().slice(0, 16).replace(" ", "_").replace(":", "")}.log`);
const mask = ip => (CONTROLS.includes(ip) ? ip : ip.replace(/^(\d+\.\d+)\.\d+\.\d+$/, "$1.x.x"));

function log(kind, ip, text, show = false) {
  const t = stamp();
  fs.appendFileSync(OUT, `${t}  ${kind.padEnd(8)} ${ip.padEnd(16)} ${text}\n`);
  if (show) console.log(`${t.slice(11, 19)}  ${kind.padEnd(8)} ${mask(ip).padEnd(16)} ${text}`);
}

function run(cmd, argv, timeout = 10000) {
  return new Promise(resolve =>
    execFile(cmd, argv, { windowsHide: true, maxBuffer: 8 << 20, timeout }, (err, stdout = "") =>
      resolve({ err, stdout: String(stdout) })));
}

async function remotes() {
  const { err, stdout } = await run("netstat", ["-an", "-p", "TCP"]);
  if (err) return null;
  const ips = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+(\d+\.\d+\.\d+\.\d+):\d+\s+ESTABLISHED/i);
    if (m && Number(m[1]) === PORT && !m[2].startsWith("127.")) ips.add(m[2]);
  }
  return ips;
}

async function ping(ip) {
  const { stdout } = await run("ping", ["-4", "-n", "1", "-w", "2000", ip], 5000);
  const m = stdout.match(/time[=<]\s*(\d+)\s*ms/i);
  return m ? Number(m[1]) : null;
}

const median = v => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const state = new Map();   // ip -> probe stats

function track(ip, ms) {
  let s = state.get(ip);
  if (!s) state.set(ip, s = { recent: [], period: [], periodLost: 0, streak: 0, answered: false, quiet: false, lastSpike: 0 });
  if (ms === null) {
    s.streak++; s.periodLost++;
    log("PING", ip, "timeout");
    if (!s.answered) {
      if (s.streak === 5) { s.quiet = true; log("NO-ICMP", ip, "no answer to 5 pings: its router probably drops ping (logging continues quietly)", true); }
    } else if (s.streak === 2 || s.streak === 5 || s.streak % 15 === 0) {
      log("TIMEOUT", ip, `${s.streak} lost in a row`, true);
    }
    return;
  }
  if (s.streak >= 2) log("BACK", ip, `answers again after ${s.streak} lost, ${ms} ms`, true);
  if (s.quiet) { s.quiet = false; log("BACK", ip, `first answer, ${ms} ms`, true); }
  s.streak = 0; s.answered = true;
  log("PING", ip, String(ms));
  const med = median(s.recent);
  if (s.recent.length >= 10 && ms > Math.max(3 * med, med + 150) && Date.now() - s.lastSpike > 30000) {
    s.lastSpike = Date.now();
    log("SPIKE", ip, `${ms} ms (median of the last ${s.recent.length}: ${med} ms)`, true);
  }
  s.recent.push(ms); if (s.recent.length > 60) s.recent.shift();
  s.period.push(ms);
}

function summary() {
  for (const [ip, s] of state) {
    const v = [...s.period].sort((a, b) => a - b);
    const n = v.length + s.periodLost;
    if (!n) continue;
    const q = p => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : "-");
    log("SUMMARY", ip, `15 min: ${n} probes, median ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${v.length ? v[v.length - 1] : "-"} ms, ${s.periodLost} lost`, true);
    s.period = []; s.periodLost = 0;
  }
}

async function pathping(ip) {
  log("PATHPING", ip, "started (a few minutes)", true);
  const { err, stdout } = await run("pathping", ["-n", "-q", "25", "-w", "1000", ip], 15 * 60000);
  fs.appendFileSync(OUT, `----- pathping ${ip} -----\n${stdout}\n----- end pathping -----\n`);
  const hops = [...stdout.matchAll(/^\s*(\d+)\s+(\d+)ms\s+\d+\/\s*\d+\s*=\s*(\d+)%\s+\d+\/\s*\d+\s*=\s*(\d+)%\s+(\S+)/gm)]
    .map(m => ({ hop: Number(m[1]), rtt: Number(m[2]), node: Number(m[4]) }));
  if (!hops.length) return log("PATHPING", ip, err ? `failed: ${err.message}` : "done (no hop table; see log)", true);
  const worst = hops.reduce((a, b) => (b.node > a.node ? b : a));
  const last = hops[hops.length - 1];
  log("PATHPING", ip, `done: ${hops.length} answering hops, last at hop ${last.hop} ${last.rtt} ms, worst hop loss ${worst.node}% (hop ${worst.hop})`, true);
}

const lastPathping = new Map();
let current = new Set();

async function tick() {
  const ips = await remotes();
  if (ips) {
    for (const ip of ips) {
      if (current.has(ip)) continue;
      log("NEW", ip, `connected to port ${PORT}`, true);
      if (PATHPING && Date.now() - (lastPathping.get(ip) ?? 0) > 20 * 60000) {
        lastPathping.set(ip, Date.now());
        pathping(ip);   // runs alongside the probes
      }
    }
    for (const ip of current) if (!ips.has(ip)) log("GONE", ip, "no established connection left", true);
    current = ips;
  }
  const targets = [...CONTROLS, ...current];
  const results = await Promise.all(targets.map(ping));
  targets.forEach((ip, i) => track(ip, results[i]));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
log("START", "-", `port=${PORT} every=${EVERY_MS / 1000}s controls=${CONTROLS.join(",")} -> ${OUT}`, true);
(async function loop() {
  const t0 = Date.now();
  try { await tick(); } catch (e) { log("ERROR", "-", e.message, true); }
  setTimeout(loop, Math.max(0, EVERY_MS - (Date.now() - t0)));
})();
setInterval(summary, 15 * 60000);
