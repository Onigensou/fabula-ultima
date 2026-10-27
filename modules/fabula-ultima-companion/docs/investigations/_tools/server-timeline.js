#!/usr/bin/env node
// ============================================================================
// server-timeline — Foundry server log → session timeline + per-player reload metrics
//
// Reads Logs/debug.<date>.log for a time window and lines up, in one timeline:
//   - scene activations    "Activating scene <name> [<id>]"
//   - world-data vends     "Vended World data to User [<id>] in <n>ms"   (= one page load)
//   - logins               "User authentication successful for user <name>"  (/join, with ip)
//   - server warn/error lines (counted)
// Every vend after a user's first one in the window is a full page reload.
//
//   node server-timeline.js --from "2026-10-24 20:40" --to "2026-10-25 02:30" \
//        --players ../player-reloads/players.json [--watch Rinri,Blumairwen] [--json out.json]
//
// --logs defaults to the FoundryVTT/Logs folder beside Data/. Times are the log's own
// local time. IPs are printed masked to /16, so the output can be committed.
//
// Metric definitions (keep them stable — sessions are compared on these):
//   secAfterActivation  vend time minus the latest scene activation before it. The page
//                       load began earlier than the vend by the page-load time (~10–50 s
//                       on 2026-10-24), so this over-states the trigger delay.
//   secAfterDraw        vend time minus the user's latest DRAW: the later of the last scene
//                       activation and their own previous page load (a page load draws too)
//   mode                of secAfterDraw: quick ≤120 s · mid 121–299 s · sixMin 300–420 s · long >420 s
//   pairedWith          another watched user's reload within 60 s of this one
// ============================================================================
const fs = require("fs");
const path = require("path");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i];
}
if (!args.from || !args.to) {
  console.error('usage: node server-timeline.js --from "YYYY-MM-DD HH:MM" --to "YYYY-MM-DD HH:MM" [--players f.json] [--watch a,b] [--json out.json] [--logs dir]');
  process.exit(1);
}
const LOGS = args.logs ?? path.resolve(__dirname, "../../../../../../Logs");
const FROM = args.from.length === 16 ? args.from + ":00" : args.from;
const TO = args.to.length === 16 ? args.to + ":59" : args.to;
const players = args.players ? JSON.parse(fs.readFileSync(args.players, "utf8")) : {};
const nameOf = id => players[id]?.name ?? id;
const watch = args.watch ? new Set(String(args.watch).split(",")) : null;
const PAIR_S = 60;

const maskIp = ip => {
  const v4 = String(ip ?? "").replace(/^::ffff:/, "");
  if (v4 === "::1" || v4.startsWith("127.")) return "local";
  const m = v4.match(/^(\d+)\.(\d+)\./);
  return m ? `${m[1]}.${m[2]}.x.x` : "?";
};
const sec = ts => Date.parse(ts.replace(" ", "T")) / 1000;   // log-local; only differences are used

// ── read the log files whose date falls in the window ───────────────────────
const days = [];
for (let d = new Date(FROM.slice(0, 10) + "T00:00:00Z"); d <= new Date(TO.slice(0, 10) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  days.push(d.toISOString().slice(0, 10));
}
const ev = [];
const lastAuthIp = {};   // user name -> masked ip of their latest login
for (const day of days) {
  const file = path.join(LOGS, `debug.${day}.log`);
  if (!fs.existsSync(file)) { console.error(`(no ${file})`); continue; }
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const ts = j.timestamp; if (!ts || ts < FROM || ts > TO) continue;
    const msg = String(j.message ?? "");
    let m;
    if ((m = msg.match(/^Activating scene (.+) \[(\w+)\]/))) ev.push({ ts, type: "SCENE", scene: m[1] });
    else if ((m = msg.match(/^Vended World data to User \[(\w+)\] in (\d+)ms/))) ev.push({ ts, type: "VEND", user: nameOf(m[1]), ms: +m[2] });
    else if ((m = msg.match(/^User authentication successful for user (.+)$/))) ev.push({ ts, type: "LOGIN", user: m[1], ip: maskIp(j.ip) });
    else if (j.level === "error" || j.level === "warn") ev.push({ ts, type: j.level.toUpperCase(), text: msg.split("\n")[0].slice(0, 100) });
  }
}
ev.sort((a, b) => a.ts.localeCompare(b.ts));

// ── per-user metrics ─────────────────────────────────────────────────────────
const users = {};
let lastScene = null;
const activations = [];
for (const e of ev) {
  if (e.type === "SCENE") { lastScene = e; activations.push({ at: e.ts, scene: e.scene }); continue; }
  if (e.type === "LOGIN") { lastAuthIp[e.user] = e.ip; (users[e.user] ??= blank()).logins.push({ at: e.ts, ip: e.ip }); continue; }
  if (e.type !== "VEND") continue;
  const u = (users[e.user] ??= blank());
  const prev = u.vends.at(-1);
  const lastDraw = [lastScene?.ts, prev?.at].filter(Boolean).sort().at(-1);
  u.vends.push({ at: e.ts, ms: e.ms, ip: lastAuthIp[e.user] ?? null,
    lastScene: lastScene?.scene ?? null, secAfterActivation: lastScene ? sec(e.ts) - sec(lastScene.ts) : null,
    secAfterDraw: lastDraw ? sec(e.ts) - sec(lastDraw) : null,
    drawWas: !lastDraw ? null : lastDraw === prev?.at ? "own page load" : "scene activation" });
}
function blank() { return { logins: [], vends: [] }; }
const modeOf = s => s == null ? "n/a" : s <= 120 ? "quick" : s < 300 ? "mid" : s <= 420 ? "sixMin" : "long";

const summary = {};
for (const [name, u] of Object.entries(users)) {
  const reloads = u.vends.slice(1).map(v => ({ ...v, mode: modeOf(v.secAfterDraw) }));
  summary[name] = {
    pageLoads: u.vends.length,
    reloads: reloads.length,
    logins: u.logins.length,
    localClient: u.vends.some(v => v.ip === "local"),
    route: [...new Set(u.logins.map(l => l.ip))],
    vendMs: u.vends.length ? [Math.min(...u.vends.map(v => v.ms)), Math.max(...u.vends.map(v => v.ms))] : null,
    modes: reloads.reduce((m, r) => (m[r.mode] = (m[r.mode] ?? 0) + 1, m), {}),
    reloadDetail: reloads,
  };
}
// pair reloads across watched users
const watched = Object.keys(summary).filter(n => !watch || watch.has(n));
for (const a of watched) for (const r of summary[a].reloadDetail) {
  r.pairedWith = [];
  for (const b of watched) if (b !== a) for (const o of summary[b].reloadDetail) {
    const d = sec(o.at) - sec(r.at);
    if (Math.abs(d) <= PAIR_S) r.pairedWith.push({ user: b, deltaSec: d });
  }
}

// ── print ────────────────────────────────────────────────────────────────────
console.log(`# Server timeline ${FROM} → ${TO}\n`);
console.log(`${activations.length} scene activations · ${ev.filter(e => e.type === "ERROR").length} server errors · ${ev.filter(e => e.type === "WARN").length} warnings\n`);
console.log("| time | event | who / scene | detail |");
console.log("|---|---|---|---|");
for (const e of ev) {
  if (e.type === "WARN") continue;
  if (e.type === "SCENE") console.log(`| ${e.ts.slice(5)} | scene | **${e.scene}** | |`);
  else if (e.type === "LOGIN") console.log(`| ${e.ts.slice(5)} | login | ${e.user} | ${e.ip} |`);
  else if (e.type === "ERROR") console.log(`| ${e.ts.slice(5)} | error | | ${e.text.replace(/\|/g, "/")} |`);
  else {
    const u = users[e.user]; const idx = u.vends.findIndex(v => v.at === e.ts);
    const v = u.vends[idx];
    const what = idx === 0 ? "join" : "RELOAD";
    const after = idx === 0 ? "" : ` · ${v.secAfterDraw} s after last draw (${v.drawWas})`;
    console.log(`| ${e.ts.slice(5)} | ${what} | ${e.user} | vend ${e.ms} ms · +${v.secAfterActivation ?? "?"} s after ${v.lastScene ?? "—"}${after} |`);
  }
}
console.log("\n## Per user\n");
console.log("| user | page loads | reloads | logins | route | vend ms | modes |");
console.log("|---|---|---|---|---|---|---|");
for (const [n, s] of Object.entries(summary)) {
  console.log(`| ${n}${s.localClient ? " (local client seen)" : ""} | ${s.pageLoads} | ${s.reloads} | ${s.logins} | ${s.route.join(", ")} | ${s.vendMs?.join("–") ?? ""} | ${JSON.stringify(s.modes)} |`);
}
// each pair once: from the earlier-sorted user's side
const pairs = watched.flatMap(a => summary[a].reloadDetail.flatMap(r => (r.pairedWith ?? [])
  .filter(p => a < p.user)
  .map(p => `${a} ${r.at.slice(11)} ↔ ${p.user} ${p.deltaSec > 0 ? "+" : ""}${p.deltaSec} s (after ${r.lastScene ?? "—"})`)));
if (pairs.length) console.log(`\nPaired reloads (≤${PAIR_S} s apart): ${pairs.length}\n- ${pairs.join("\n- ")}`);

if (args.json) {
  fs.writeFileSync(args.json, JSON.stringify({ window: { from: FROM, to: TO }, activations, users: summary }, null, 2));
  console.log(`\n(wrote ${args.json})`);
}
