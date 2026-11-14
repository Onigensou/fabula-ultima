// ============================================================================
// Resource Panel — FU.ResourcePanel
//
// A party's HP / MP / IP changes on screen, for scenes with NO resource HUD
// (events, story scenes, conflict events). Dungeon maps have their own HUD and
// do not use this. Approved 2026-11-10 (trap mockup v2, second screen):
// https://claude.ai/artifact/EgW2YkyzCqX3PDokaiSLQY
//
//   FU.ResourcePanel.show({
//     label: "Healing Spring",                 // optional name plate
//     rows: [
//       { actor, resource: "hp", before: 60, after: 110 },
//       { actorId, resource: "hp", before: 9, after: 1, tags: ["held", "dr:5"] },
//     ],
//     hold: 2400,                              // ms after the bars settle
//   });
//   FU.ResourcePanel.broadcast({ rows })       // GM side: every client
//   FU.ResourcePanel.clear()
//
// A row names its member by `actor` (an Actor), `actorId`, or plain
// `name` + `img` (+ `max`). Tags: "resist", "immune", "absorb", "weak", "held", "dr:N"; Crisis
// is worked out from before / after / max. Loss = red −N with a draining red
// ghost; gain = green +N and the bar sweeps up; MP uses the blue bar.
//
// Look: the FU.SystemMessage frame (wood → gold hairline → parchment), its
// approved spot (14.5% from the top) and width at four cards (38%). Panels
// play one after another; a System Message line on screen at the same time
// pushes the panel down under it. A scene change clears it.
// ============================================================================

import { DEFAULTS, normalizePanel, band, amountLabel } from "./resource-panel-rules.js";

const NS = "fabula-ultima-companion";
const SOCKET = `module.${NS}`;
const MSG_TYPE = "FU_RESPANEL_SHOW_V1";
const STYLE_ID = "fu-respanel-style";
const HOST_ID = "fu-respanel-host";
const TAG = "[FU ResourcePanel]";
const BAND_COLOR = { ok: "#57c96b", crisis: "#e8c33a", low: "#e84b3a" };
const MP_COLOR = "#4f6fd8";
const SETTLE_MS = 250 + 600 + 100;   // bars start at 250 ms and run 600 ms

const state = { queue: [], running: false, abort: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
#${HOST_ID} {
  --sm-parch-top:#f6f1e6; --sm-parch-bot:#ebe3d0; --sm-ink:#3a3228; --sm-ink-soft:#6b5d4b;
  --sm-gold-1:#d5b67a; --sm-gold-2:#b7935a; --sm-wood-1:#a87649; --sm-wood-2:#8d5f38; --sm-wood-3:#6f4526;
  position:fixed; left:50%; transform:translateX(-50%); z-index:90; pointer-events:none;
  top:calc(var(--rp-top) * 1vh); width:calc(var(--rp-w) * 1vw);
  font-size:calc(var(--rp-fs) / 1920 * 100vw);
}
#${HOST_ID} .rp { position:relative; padding:.32em; border-radius:.7em; opacity:0; transform:translateX(-3em);
  transition:opacity 200ms ease-out, transform ${DEFAULTS.enterMs}ms cubic-bezier(.2,.8,.2,1);
  background:linear-gradient(180deg,var(--sm-wood-1),var(--sm-wood-2) 45%,var(--sm-wood-3));
  box-shadow:0 .9em 2.4em rgba(0,0,0,.55),0 0 0 1px rgba(40,24,10,.9),0 1px 0 rgba(255,236,190,.35) inset; }
#${HOST_ID} .rp.shown { opacity:1; transform:none; }
#${HOST_ID} .rp.leaving { opacity:0; transform:translateX(3em); }
#${HOST_ID} .rp .field { position:relative; border-radius:.48em; padding:.55em .6em; display:grid;
  grid-template-columns:repeat(var(--cols,4),minmax(0,1fr)); gap:.45em;
  background:linear-gradient(180deg,var(--sm-parch-top),var(--sm-parch-bot));
  box-shadow:0 0 0 1px var(--sm-gold-2),0 0 0 2px rgba(255,248,225,.75) inset,0 .25em .5em rgba(90,60,25,.18) inset; }
#${HOST_ID} .rp .field::before { content:""; position:absolute; inset:.26em; border:1px solid var(--sm-gold-1); border-radius:.3em; pointer-events:none; opacity:.85; }
#${HOST_ID} .rp .plate { position:absolute; left:1.2em; top:-.95em; z-index:2; padding:.18em .9em .22em; border-radius:.45em;
  background:var(--sm-ink); color:var(--sm-parch-top); border:.12em solid var(--sm-gold-2); box-shadow:0 .18em 0 rgba(41,33,24,.55);
  font:900 .7em/1.2 "Cinzel",Georgia,serif; letter-spacing:.12em; text-transform:uppercase; white-space:nowrap; }
#${HOST_ID} .rp.hasplate .field { padding-top:.85em; }
#${HOST_ID} .pc { position:relative; display:grid; grid-template-columns:2.9em minmax(0,1fr); grid-template-rows:auto auto auto auto;
  column-gap:.45em; row-gap:.18em; align-items:center; padding:.1em .15em; }
#${HOST_ID} .pc + .pc::after { content:""; position:absolute; left:-.25em; top:.2em; bottom:.2em; width:1px; background:var(--sm-gold-1); opacity:.7; }
#${HOST_ID} .face { grid-row:1 / span 3; width:2.9em; height:2.9em; border-radius:.35em; object-fit:cover; object-position:50% 10%;
  background:#d9cdb3; box-shadow:0 0 0 1px var(--sm-gold-2), 0 0 0 2px rgba(255,248,225,.8); }
#${HOST_ID} .top { display:flex; align-items:baseline; justify-content:space-between; gap:.3em; min-width:0; }
#${HOST_ID} .name { font:700 .84em/1.1 "Signika","Segoe UI",sans-serif; color:var(--sm-ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${HOST_ID} .amt { font:800 1.02em/1 "Signika","Segoe UI",sans-serif; color:#a3261b; font-variant-numeric:tabular-nums; white-space:nowrap;
  opacity:0; transform:scale(.4); transition:opacity 120ms, transform 240ms cubic-bezier(.2,1.55,.4,1); }
#${HOST_ID} .amt.on { opacity:1; transform:none; }
#${HOST_ID} .amt.gain { color:#2f8a3e; } #${HOST_ID} .amt.mp { color:#3b56b8; } #${HOST_ID} .amt.zero { color:var(--sm-ink-soft); }
#${HOST_ID} .bar { position:relative; height:.42em; border-radius:999px; overflow:hidden;
  background:linear-gradient(to bottom,#05060a,#14161d 55%,#0a0b10); box-shadow:0 0 0 1px rgba(60,40,20,.55); }
#${HOST_ID} .bar i { position:absolute; left:0; top:0; bottom:0; border-radius:999px 3px 3px 999px; }
#${HOST_ID} .bar .ghost { background:linear-gradient(to bottom,#ff6a55,#d92c1e 60%,#a81c12); }
#${HOST_ID} .bar .ghost.gain { background:linear-gradient(to bottom,#c8ffd2,#7be38e); }
#${HOST_ID} .bar .fill { --c:#57c96b; background:linear-gradient(to bottom, color-mix(in srgb, var(--c) 65%, #fff) 0%, var(--c) 55%, color-mix(in srgb, var(--c) 70%, #000) 100%); }
#${HOST_ID} .hp { display:flex; align-items:baseline; gap:.3em; font:600 .76em/1 "Signika","Segoe UI",sans-serif; color:var(--sm-ink-soft); font-variant-numeric:tabular-nums; white-space:nowrap; }
#${HOST_ID} .hp b { color:var(--sm-ink); font-weight:700; font-size:1.12em; }
#${HOST_ID} .chips { grid-column:1 / -1; display:flex; gap:.3em; flex-wrap:wrap; min-height:1.15em; font-size:.64em; }
#${HOST_ID} .chip { font:700 1em/1 "Signika","Segoe UI",sans-serif; padding:.18em .38em .2em; border-radius:.25em; white-space:nowrap; letter-spacing:.02em; }
#${HOST_ID} .chip.dr { background:#e2d8c2; color:#5b4a33; } #${HOST_ID} .chip.rs { background:#3a5b80; color:#fff; }
#${HOST_ID} .chip.im { background:#2a3140; color:#fff; } #${HOST_ID} .chip.cr { background:#e8c33a; color:#3a2a00; }
#${HOST_ID} .chip.one { background:#8a4b22; color:#fff4e0; }
#${HOST_ID} .chip.ab { background:#2f7a45; color:#fff; } #${HOST_ID} .chip.vu { background:#a3261b; color:#fff; }
@media (prefers-reduced-motion: reduce) { #${HOST_ID} .rp { transition:none; } }
`;
  document.head.appendChild(css);
}

function ensureHost() {
  ensureStyles();
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);
  }
  host.style.setProperty("--rp-fs", String(DEFAULTS.fontPx1080));
  host.style.setProperty("--rp-top", String(DEFAULTS.topPct));
  return host;
}

// A System Message line on screen: sit under it.
function placeHost(host) {
  const line = document.querySelector("#fu-sysmsg-host .sm.shown");
  if (line) {
    const r = line.getBoundingClientRect();
    host.style.top = `${Math.round(r.bottom + 8)}px`;
  } else {
    host.style.top = "";
  }
}

// Resolve who a row is about (name, picture, max) on this client.
function resolveRow(row = {}) {
  const actor = row.actor ?? (row.actorId ? game.actors?.get(row.actorId) : null);
  const p = actor?.system?.props ?? {};
  const resource = String(row.resource ?? "hp").toLowerCase();
  const maxKey = resource === "mp" ? "max_mp" : resource === "ip" ? "max_ip" : "max_hp";
  return {
    name: row.name ?? actor?.name ?? "",
    img: row.img ?? actor?.img ?? "",
    resource,
    before: row.before,
    after: row.after,
    max: row.max ?? p[maxKey],
    tags: row.tags ?? [],
  };
}

function cardHtml(r) {
  const isMp = r.resource === "mp";
  const f0 = (r.before / r.max) * 100;
  const fillC = isMp ? MP_COLOR : BAND_COLOR[band(r.before, r.max)];
  const cls = !r.amount ? "zero" : r.gain ? "gain" : isMp ? "mp" : "";
  const unit = r.resource === "hp" ? "" : r.resource.toUpperCase() + " ";
  return `<div class="pc">
    <img class="face" alt="" src="${esc(r.img)}">
    <div class="top"><span class="name">${esc(r.name)}</span><span class="amt ${cls}">${esc(amountLabel(r))}</span></div>
    <div class="bar"><i class="ghost${r.gain ? " gain" : ""}" style="width:${(r.gain ? r.after / r.max : r.before / r.max) * 100}%;${r.gain ? "opacity:0" : ""}"></i><i class="fill" style="width:${f0}%;--c:${fillC}"></i></div>
    <div class="hp"><span>${unit}<b class="cur">${r.before}</b> / ${r.max}</span></div>
    <div class="chips">${r.chips.map((c) => `<span class="chip ${c.kind}">${esc(c.label)}</span>`).join("")}</div>
  </div>`;
}

function animateCard(el, r, signal) {
  const isMp = r.resource === "mp";
  const f1 = (r.after / r.max) * 100;
  const fill = el.querySelector(".fill"), ghost = el.querySelector(".ghost"), cur = el.querySelector(".cur");
  el.querySelector(".amt")?.classList.add("on");
  const color = () => { if (!isMp) fill.style.setProperty("--c", BAND_COLOR[band(r.after, r.max)]); };
  if (r.gain) {
    ghost.style.opacity = ".9";
    setTimeout(() => {
      if (signal.aborted) return;
      fill.style.transition = "width 600ms cubic-bezier(.2,.8,.2,1)"; fill.style.width = f1 + "%"; color();
      ghost.style.transition = "opacity 500ms 500ms"; ghost.style.opacity = "0";
    }, 250);
  } else {
    fill.style.transition = "width 180ms cubic-bezier(.2,.8,.2,1)"; fill.style.width = f1 + "%"; color();
    setTimeout(() => { if (signal.aborted) return; ghost.style.transition = "width 600ms ease-in"; ghost.style.width = f1 + "%"; }, 250);
  }
  const t0 = performance.now() + 250;
  const tick = () => {
    if (signal.aborted) return;
    const k = Math.max(0, Math.min(1, (performance.now() - t0) / 600));
    cur.textContent = String(Math.round(r.before + (r.after - r.before) * k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function playOne(panel, signal) {
  const host = ensureHost();
  host.style.setProperty("--rp-w", String(panel.widthPct));
  placeHost(host);
  const box = document.createElement("div");
  box.className = "rp" + (panel.label ? " hasplate" : "");
  box.style.setProperty("--cols", String(panel.rows.length));
  box.innerHTML = (panel.label ? `<span class="plate">${esc(panel.label)}</span>` : "")
    + `<div class="field">${panel.rows.map(cardHtml).join("")}</div>`;
  host.appendChild(box);
  void box.offsetWidth;
  box.classList.add("shown");
  try {
    await sleep(200);
    if (!signal.aborted) box.querySelectorAll(".pc").forEach((el, i) => animateCard(el, panel.rows[i], signal));
    await Promise.race([sleep(SETTLE_MS + panel.hold), new Promise((r) => { signal.onabort = r; })]);
  } finally {
    box.classList.remove("shown");
    box.classList.add("leaving");
    setTimeout(() => box.remove(), DEFAULTS.leaveMs);
    await sleep(DEFAULTS.leaveMs);
  }
}

async function pump() {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length) {
      const item = state.queue.shift();
      if (Date.now() - item.at > DEFAULTS.maxQueueAgeMs) { item.resolve(); continue; }
      const signal = { aborted: false, onabort: null };
      state.abort = () => { signal.aborted = true; try { signal.onabort?.(); } catch (e) {} };
      try { await playOne(item.panel, signal); } catch (e) { console.warn(TAG, "panel failed", e); }
      item.resolve();
    }
  } finally {
    state.running = false;
    state.abort = null;
  }
}

function enqueue(panel) {
  return new Promise((resolve) => {
    if (!panel.rows.length) { resolve(); return; }
    state.queue.push({ panel, resolve, at: Date.now() });
    pump();
  });
}

// ── public API ────────────────────────────────────────────────────────────
function show(input = {}) {
  const rows = (Array.isArray(input.rows) ? input.rows : []).map(resolveRow);
  return enqueue(normalizePanel({ ...input, rows }));
}

// Every client, this one included. Rows are resolved here (name, picture,
// max), so the wire carries plain values only.
function broadcast(input = {}) {
  const rows = (Array.isArray(input.rows) ? input.rows : []).map(resolveRow);
  const payload = { label: input.label ?? "", hold: input.hold, rows };
  try { game.socket?.emit(SOCKET, { type: MSG_TYPE, payload }); } catch (e) { console.warn(TAG, "emit failed", e); }
  return enqueue(normalizePanel(payload));
}

function clear() {
  const pending = state.queue.splice(0);
  for (const it of pending) it.resolve();
  state.abort?.();
}

Hooks.once("ready", () => {
  game.socket?.on(SOCKET, (data) => {
    if (data?.type !== MSG_TYPE || !data.payload) return;
    enqueue(normalizePanel(data.payload));
  });
});
Hooks.on("canvasTearDown", () => clear());

globalThis.FU = globalThis.FU ?? {};
globalThis.FU.ResourcePanel = Object.freeze({ show, broadcast, clear });
