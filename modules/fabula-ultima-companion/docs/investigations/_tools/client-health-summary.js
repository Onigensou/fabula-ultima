#!/usr/bin/env node
// ============================================================================
// client-health-summary — Data/client-health-logs/*.json → per-player verdicts
//
// scripts/client-health.js writes one file per primary-GM page load. This merges
// every file overlapping a window and reads each player's boots back as a verdict:
//
//   TAB DISCARDED         document.wasDiscarded — Memory Saver / Sleeping Tabs / memory pressure
//   PAGE DIED             no pagehide on the previous page — renderer crash, killed or frozen tab
//   RELOAD DURING DRAW    clean exit while a scene was still drawing — a stuck draw, then F5 / script
//   RELOAD                clean exit, navigation type "reload" — the player or a script reloaded
//   NEW NAVIGATION        navigation type "navigate" — rejoined via /join or the link
//   FIRST LOAD            no heartbeat from an earlier page in this browser
//   + "boot gap N s"      the last heartbeat is N s older than this page's navigation start:
//                         a page in between never reached `ready` (stuck on its first draw —
//                         Foundry fires ready only after it), so it left no heartbeat.
//
// Also flags SAMPLE GAPS: in the 10 min after a draw the logger samples once a minute, so
// a gap > 150 s there means the page ran no timers that long (a throttled hidden tab still wakes once a minute, so up to ~120 s is normal) — a frozen tab (Chrome Energy
// Saver / Edge Sleeping Tabs freeze hidden tabs after ~5 min) or a blocked main thread.
//
//   node client-health-summary.js --from "2026-10-28 19:00" --to "2026-10-29 03:00" [--tz +07:00]
//        [--users Rinri,Blumairwen] [--json out.json] [--dir <client-health-logs>]
//
// --dir defaults to Data/client-health-logs. --from/--to are local wall time in --tz.
// ============================================================================
const fs = require("fs");
const path = require("path");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i];
}
const DIR = args.dir ?? path.resolve(__dirname, "../../../../../client-health-logs");
const TZ = args.tz ?? "+07:00";
const toMs = s => Date.parse(s.replace(" ", "T") + (s.length === 16 ? ":00" : "") + TZ);
const FROM = args.from ? toMs(args.from) : 0;
const TO = args.to ? toMs(args.to) : Infinity;
const only = args.users ? new Set(String(args.users).split(",")) : null;
const tzMin = (TZ[0] === "-" ? -1 : 1) * (Number(TZ.slice(1, 3)) * 60 + Number(TZ.slice(4, 6)));
const local = t => new Date(t + tzMin * 60e3).toISOString().slice(5, 19).replace("T", " ");
const s = ms => (ms == null ? null : Math.round(ms / 1000));

// ── merge entries from every file in the window (a GM reload starts a new file) ──
const seen = new Set();
const entries = [];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith(".json")).sort()) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { continue; }
  for (const e of j.entries ?? []) {
    if (e.t < FROM || e.t > TO || (only && !only.has(e.user))) continue;
    const key = `${e.userId}|${e.kind}|${e.t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(e);
  }
}
entries.sort((a, b) => a.t - b.t);

const browserOf = ua => {
  const m = ua?.match(/(Edg|OPR|Firefox|Electron|Chrome)\/([\d.]+)/g) ?? [];
  const pick = ["Edg", "OPR", "Firefox", "Electron", "Chrome"].map(n => m.find(x => x.startsWith(n + "/"))).find(Boolean);
  return pick ? pick.replace("Edg/", "Edge ").replace("OPR/", "Opera ").replace("/", " ").replace(/(\d+)\.[\d.]+/, "$1") : "?";
};
const SOFTWARE_GL = /SwiftShader|Basic Render|llvmpipe|Software/i;
const NOISE = /Deprecated since Version|You are accessing /;

function verdict(b) {
  const tags = [];
  if (b.wasDiscarded) tags.push("TAB DISCARDED");
  if (!b.prev) tags.push("FIRST LOAD");
  else if (b.prev.verdict === "died") tags.push("PAGE DIED");
  else if (b.navType === "reload") tags.push(b.prev.drawing ? "RELOAD DURING DRAW" : "RELOAD");
  else if (b.navType === "navigate") tags.push("NEW NAVIGATION");
  else tags.push(String(b.navType));
  if (b.prev) {
    const gap = s(b.prev.endedAgoMs - b.loadMs);   // last beat → this navigation's start
    if (gap > 10) tags.push(`boot gap ${gap} s`);
  }
  return tags.join(" · ");
}

// ── per user ─────────────────────────────────────────────────────────────────
const users = {};
for (const e of entries) {
  const u = (users[e.user] ??= { boots: [], draws: [], stalls: [], disconnects: [], hidden: 0, hiddenMs: 0, longHides: [], sampleGaps: [], lastSample: null, peakHeapMB: 0, peakTextures: 0, machine: null, console: {}, lastPagehide: null, loads: [], waits: [] });
  // load-indicator.js: world entry, every map load over 2 s, and marks at 30 / 60 s that survive a reload.
  // A world-entry load counts from the page's navigation start, so it includes the page and world-data download.
  if (e.kind === "load-progress") u.loads.push({ at: local(e.t), scene: e.entry ? `${e.scene} (world entry)` : e.scene, s: s(e.ms), texS: s(e.texturesMs),
    files: e.files, left: e.left, shown: e.shown, reason: e.reason, slowest: (e.slowest ?? []).slice(0, 3), pending: e.pending ?? [] });
  if (e.kind === "load-waiting") u.waits.push({ at: local(e.t), atS: e.atS, scene: e.entry ? `${e.scene} (world entry)` : e.scene, pct: e.pct, left: e.left, pending: e.pending ?? [] });
  if (e.kind === "sample") {
    const p = u.lastSample;
    // both inside the once-a-minute window after the same draw
    if (p && e.sinceDrawMs < 600000 && e.sinceDrawMs > p.sinceDrawMs && e.t - p.t > 150000) {
      u.sampleGaps.push({ at: local(p.t), gapS: s(e.t - p.t), scene: e.scene, hiddenAfter: e.hidden });
    }
    u.lastSample = e;
  }
  if (e.kind === "visible" && (e.hiddenMs ?? 0) >= 240000) u.longHides.push({ at: local(e.t), hiddenS: s(e.hiddenMs) });
  if (e.kind === "boot") u.lastSample = null;
  if (e.kind === "boot") {
    u.machine ??= e.machine;
    if (e.machine) u.machine = e.machine;
    u.boots.push({ at: local(e.t), verdict: verdict(e), navType: e.navType, wasDiscarded: e.wasDiscarded, loadS: s(e.loadMs),
      prevScene: e.prev?.scene ?? null, prevSinceDrawS: s(e.prev?.sinceDrawMs), prevDrawing: e.prev?.drawing ?? null,
      prevHeapMB: e.prev?.mem?.heapMB ?? null, prevTextures: e.prev?.mem?.textures ?? null, prevDriftMs: e.prev?.driftMs ?? null });
    for (const c of e.prev?.console ?? []) {
      if (NOISE.test(c.msg)) continue;
      const k = `${c.level} ${c.msg.split("\n")[0].slice(0, 140)}`;
      u.console[k] = (u.console[k] ?? 0) + 1;
    }
    // a disconnect within 3 s before the previous page's last beat is that page's own unload
    if (e.prev?.clean) u.lastPagehide = e.prev.t;
    for (const d of u.disconnects) if (u.lastPagehide && Math.abs(u.lastPagehide - d.t) <= 3000) d.unload = true;
  }
  if (e.kind === "draw") u.draws.push({ at: local(e.t), scene: e.scene, s: Math.round(e.ms / 100) / 10, heapBefore: e.before?.heapMB, heapAfter: e.after?.heapMB });
  if (e.kind === "draw-stall") u.stalls.push({ at: local(e.t), loading: e.loading });
  if (e.kind === "disconnect") u.disconnects.push({ t: e.t, at: local(e.t), reason: e.reason, scene: e.scene, unload: false });
  if (e.kind === "hidden") u.hidden++;
  if (e.kind === "visible") u.hiddenMs += e.hiddenMs ?? 0;
  const heap = e.mem?.heapMB ?? e.after?.heapMB; if (heap) u.peakHeapMB = Math.max(u.peakHeapMB, heap);
  const tex = e.mem?.textures ?? e.after?.textures; if (tex) u.peakTextures = Math.max(u.peakTextures, tex);
}

// ── print ────────────────────────────────────────────────────────────────────
const range = entries.length ? `${local(entries[0].t)} → ${local(entries.at(-1).t)}` : "(no entries)";
console.log(`# Client health ${range} (${TZ}) — ${entries.length} entries\n`);
const out = {};
for (const [name, u] of Object.entries(users)) {
  const m = u.machine ?? {};
  const gpu = m.gpu ?? "?";
  const draws = u.draws.map(d => d.s).sort((a, b) => a - b);
  out[name] = {
    browser: browserOf(m.ua), deviceMemoryGB: m.deviceMemoryGB ?? null, cores: m.cores ?? null, gpu, softwareGL: SOFTWARE_GL.test(gpu), screen: m.screen ?? null,
    boots: u.boots, draws: u.draws.length, drawMedianS: draws[Math.floor(draws.length / 2)] ?? null, drawMaxS: draws.at(-1) ?? null,
    stalls: u.stalls, disconnects: u.disconnects.map(({ t, ...d }) => d), hides: u.hidden, hiddenMinutes: Math.round(u.hiddenMs / 6e4),
    longHides: u.longHides, sampleGaps: u.sampleGaps, loads: u.loads, waits: u.waits,
    peakHeapMB: u.peakHeapMB, peakTextures: u.peakTextures, console: u.console,
  };
  const o = out[name];
  console.log(`## ${name} — ${o.browser} · ${o.deviceMemoryGB ?? "?"} GB · ${o.cores ?? "?"} cores · ${o.softwareGL ? "⚠ SOFTWARE WebGL: " : ""}${gpu}`);
  console.log(`draws ${o.draws} (median ${o.drawMedianS ?? "–"} s, max ${o.drawMaxS ?? "–"} s) · stalls ${o.stalls.length} · disconnects ${o.disconnects.length} (${o.disconnects.filter(d => d.unload).length} = own unload) · hidden ${o.hides}× / ${o.hiddenMinutes} min · peak heap ${o.peakHeapMB} MB · peak textures ${o.peakTextures}\n`);
  if (o.boots.length) {
    console.log("| boot | verdict | load s | previous page: scene · since draw · drawing · heap · textures |");
    console.log("|---|---|---|---|");
    for (const b of o.boots) console.log(`| ${b.at} | ${b.verdict} | ${b.loadS} | ${b.prevScene ?? "—"} · ${b.prevSinceDrawS ?? "–"} s · ${b.prevDrawing ?? "–"} · ${b.prevHeapMB ?? "–"} MB · ${b.prevTextures ?? "–"} |`);
  }
  for (const d of o.disconnects.filter(d => !d.unload)) console.log(`- disconnect ${d.at}: ${d.reason} (${d.scene ?? "—"})`);
  for (const g of o.sampleGaps) console.log(`- SAMPLE GAP ${g.at}: no timers for ${g.gapS} s after a draw on ${g.scene ?? "—"} (frozen tab or blocked main thread)`);
  for (const h of o.longHides) console.log(`- tab hidden ${h.hiddenS} s, back at ${h.at}`);
  for (const b of o.boots.filter(b => (b.prevDriftMs ?? 0) > 60000)) console.log(`- boot ${b.at}: previous page's timers ran ${s(b.prevDriftMs)} s late (frozen / throttled)`);
  for (const st of o.stalls) console.log(`- draw stall ${st.at} (canvas.loading ${st.loading})`);
  if (o.loads.length) {
    console.log("\n| slow load | scene | total s | textures s | files (left) | indicator | slowest files / still pending |");
    console.log("|---|---|---|---|---|---|---|");
    for (const l of o.loads) {
      const files = l.pending.length ? "PENDING " + l.pending.map(p => `${p.file} (${p.from})`).join(", ")
                                     : l.slowest.map(r => `${r.file} ${s(r.ms)} s (${r.from})`).join(", ");
      console.log(`| ${l.at} | ${l.scene ?? "—"} | ${l.s} | ${l.texS ?? "–"} | ${l.files} (${l.left}) | ${l.shown ? "shown" : "—"}${l.reason !== "ready" ? " · " + l.reason : ""} | ${files} |`);
    }
  }
  for (const w of o.waits) console.log(`- still loading ${w.atS} s into ${w.scene ?? "—"} at ${w.at}: ${w.pct}%, ${w.left} left — ${w.pending.join(", ")}`);
  const con = Object.entries(o.console).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (con.length) console.log(`console before reloads (deprecations dropped):\n${con.map(([k, n]) => `  ${n}× ${k}`).join("\n")}`);
  console.log("");
}
if (args.json) { fs.writeFileSync(args.json, JSON.stringify({ tz: TZ, from: args.from ?? null, to: args.to ?? null, users: out }, null, 2)); console.log(`(wrote ${args.json})`); }
