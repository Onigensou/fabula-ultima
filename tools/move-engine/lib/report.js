"use strict";
// The parity report: one self-contained HTML page (images embedded) + report.json.
const fs = require("fs");
const path = require("path");

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const png = (file) => (file && fs.existsSync(file) ? "data:image/png;base64," + fs.readFileSync(file).toString("base64") : "");

function html(R) {
  const css = `
:root { --bg: #f6f4ef; --card: #ffffff; --ink: #24211c; --muted: #6d665b; --line: #ddd6c8; --pass: #2f7a3e; --fail: #b3402a; --warn: #9a6a12; --accent: #3e5c8a;
  --mono: ui-monospace, "Cascadia Mono", Consolas, monospace; --ui: "Segoe UI", system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #17161a; --card: #211f25; --ink: #ece8df; --muted: #a49d90; --line: #3a3640; --pass: #7fc48a; --fail: #ea8a74; --warn: #e2b85e; --accent: #8fb0e0; color-scheme: dark; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--ui); }
.wrap { max-width: 1500px; margin: 0 auto; padding: 24px max(16px, env(safe-area-inset-left, 0px)) 60px; display: grid; gap: 22px; }
h1 { margin: 0; font-size: 24px; } h2 { margin: 0 0 8px; font-size: 18px; } .muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; min-width: 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; } td, th { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; } .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.v { font-weight: 700; padding: 1px 8px; border-radius: 4px; border: 1px solid currentColor; font-size: 12px; letter-spacing: .04em; }
.pass { color: var(--pass); } .fail { color: var(--fail); } .warn { color: var(--warn); }
.pairs { display: grid; gap: 14px; } .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 800px) { .pair { grid-template-columns: 1fr; } }
figure { margin: 0; min-width: 0; } figure img { width: 100%; display: block; border: 1px solid var(--line); border-radius: 4px; } figcaption { color: var(--muted); font-size: 12px; }
.scroll { overflow-x: auto; } details summary { cursor: pointer; color: var(--accent); } ul { margin: 4px 0; padding-left: 20px; }`;
  const V = (ok, txt) => `<span class="v ${ok === true ? "pass" : ok === false ? "fail" : "warn"}">${esc(txt || (ok ? "PASS" : "FAIL"))}</span>`;
  const sum = R.moves.map((m) => `<tr><td><b>${esc(m.key)}</b><br><span class="muted">${esc(m.label)}</span></td><td>${V(m.verdict.ok)}</td>
    <td>${V(m.dry.ok, m.dry.ok ? "match " + m.dry.total + "/" + m.dry.total : m.dry.bad + " of " + m.dry.total + " differ")}</td>
    <td>${m.play ? V(m.play.ok, m.play.ok ? "ok" : "issues") : '<span class="muted">not run</span>'}</td><td>${esc(m.verdict.reasons.join("; ") || "—")}</td></tr>`).join("");
  const section = (m) => {
    const p = m.play;
    const stats = p ? `<table class="num"><tr><th>planned</th><th>ran</th><th>fps</th><th>hit cues (planned → shown, ms)</th><th>slow frames &gt; 40 ms (move ms: frame ms)</th><th>result the game used</th></tr>
      <tr><td>${p.total} ms</td><td>${p.ranMs} ms</td><td>${p.fps}</td><td>${p.cues.map((c) => c.planned + "→" + c.shown).join("  ") || "—"}</td>
      <td>${p.stalls.map((s) => s.at + ": " + s.ms).join("  ") || "none"}</td><td>${esc(p.result ? JSON.stringify(p.result) : "—")}</td></tr></table>
      ${p.errors.length ? `<p class="fail">Errors: ${esc(p.errors.join(" | "))}</p>` : ""}${p.warnings && p.warnings.length ? `<p class="warn">Runtime warnings: ${esc(p.warnings.join(" | "))}</p>` : ""}` : "";
    const diffRows = m.dry.rows.filter((r) => r.diffs.length);
    const diffs = diffRows.length ? `<table><tr><th>mockup ms</th><th>game ms</th><th>event</th><th>difference</th></tr>${diffRows.map((r) => `<tr><td class="num">${r.mockAt ?? ""}</td><td class="num">${r.gameAt ?? ""}</td><td>${esc(r.what)}</td><td class="fail">${esc(r.diffs.join(" · "))}</td></tr>`).join("")}</table>` : `<p class="pass">Every event matches: time, sound, clip, volume, size, position, result.</p>`;
    const full = `<details><summary>All ${m.dry.total} events</summary><div class="scroll"><table class="num"><tr><th>mockup</th><th>game</th><th>event</th></tr>${m.dry.rows.map((r) => `<tr><td>${r.mockAt ?? ""}</td><td>${r.gameAt ?? ""}</td><td>${esc(r.what)}</td></tr>`).join("")}</table></div></details>`;
    const allowed = m.dry.allowed.length ? `<p class="muted">By design: ${esc(m.dry.allowed.join("; "))}</p>` : "";
    const shots = (m.shots || []).map((s) => `<div><div><b>${esc(s.name)}</b> <span class="muted">planned ${s.at} ms</span></div><div class="pair">
      <figure>${s.mock ? `<img src="${s.mock}" alt="mockup frame">` : "<p class=muted>no frame</p>"}<figcaption>MOCKUP · frame at ${s.mockAt ?? "?"} ms</figcaption></figure>
      <figure>${s.game ? `<img src="${s.game}" alt="game frame">` : "<p class=muted>no frame</p>"}<figcaption>GAME · frame at ${s.gameAt ?? "?"} ms</figcaption></figure></div></div>`).join("");
    return `<section class="card" id="${esc(m.key)}"><h2>${esc(m.label)} ${V(m.verdict.ok)}</h2>
      <p class="muted">Mockup: timeline identical on a second run: ${m.mock.repeat ? "yes" : "NO"} · largest wall-clock lag ${Math.round(m.mock.lag)} ms. Game dry run: ${m.dry.total} events compared exactly${m.dry.warnings.length ? " · build warnings: " + esc(m.dry.warnings.join("; ")) : ""}.</p>
      ${m.shipped ? `<p class="${m.shipped.stale ? "warn" : "muted"}">Shipped (${esc(m.shipped.module)} · ${esc(m.shipped.export)}): built with engine ${esc(m.shipped.engine || "?")}${m.shipped.stale ? `, the repo is on ${esc(m.shipped.current)}. This check ran the CURRENT build; the game still plays the ${esc(m.shipped.engine)} one until it is rebuilt (${esc(m.shipped.rebuild || "")}).` : " (current)."}</p>` : ""}
      ${stats}<h3>Event diff (dry run vs mockup)</h3>${diffs}${allowed}${full}${shots ? `<h3>Side by side</h3><div class="pairs">${shots}</div>` : ""}</section>`;
  };
  return `<title>Move Parity ${esc(R.family)}</title><style>${css}</style><div class="wrap"><header><h1>Move parity · ${esc(R.family)}</h1>
<p class="muted">${esc(R.when)} · move-engine ${esc(R.engine)} · mockup page built from the repo · game: dry run (exact) + real playback on ${esc(R.game ? R.game.scene + " (" + (R.game.stage3d ? "3D" : "flat") + "), " + R.game.caster + " vs " + R.game.target : "not run")}${R.code ? " · module code " + esc(R.code) : ""}</p></header>
<section class="card"><table><tr><th>move</th><th>verdict</th><th>dry run vs mockup</th><th>playback</th><th>why</th></tr>${sum}</table>
<p class="muted">PASS = every event matches the mockup in the dry run, and in playback: ran within 100 ms of plan, every hit cue within 50 ms, no frame over 100 ms, no errors.</p></section>
${R.moves.map(section).join("")}</div>`;
}

function writeReport(R, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const slim = { ...R, moves: R.moves.map((m) => ({ ...m, shots: (m.shots || []).map((s) => ({ ...s, mock: s.mock ? "(embedded)" : null, game: s.game ? "(embedded)" : null })) })) };
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(slim, null, 1));
  const file = path.join(dir, "report.html");
  fs.writeFileSync(file, html(R));
  return file;
}
module.exports = { writeReport, png };
