// ============================================================================
// Multiplayer (minigame) scene mode: session, transport, overlay, rewards.
//
// A minigame runs in a full-screen overlay on every connected client at once.
// Each player runs their own party character; absent members are CPUs. The
// primary GM's client hosts (spawns, referees, runs the CPUs) and is the only
// one that writes to the world, once, after the summary.
//
// ── Why an overlay and not the Foundry canvas ───────────────────────────────
// The race runs at 60 fps with up to four moving runners, dozens of hazards
// and 20 position updates a second per runner. Token documents can't carry
// that (every move would be a database write and a server round trip), so
// nothing on the scene moves during a race. The overlay draws with a 2D canvas
// and the Foundry board's ticker is paused while it is up, so the two never
// compete for the frame.
//
// ── Network ────────────────────────────────────────────────────────────────
// One message type on the module channel ("fu.mg"), scoped by a session id so
// a stale client from an earlier session can't talk into a new one. A
// broadcast doesn't echo to its sender. Clients estimate the host's clock with
// a ping/pong (the lowest round trip of the last eight wins), so a hazard
// lands at the same moment on every screen.
//
// API: FUCompanion.api.minigame.run({ game, intro, firstClear }) on the
// primary GM resolves with the result once everyone has left the field.
// FUCompanion.api.minigame.playtest({ actors, seats, practice, quick, ... })
// is the sandbox: no story context, nothing written to the world. The GM's
// "Minigame Playtest" button (token controls) opens a launcher for it.
// ============================================================================

import { createPlasmaField } from "./plasma-field/pf-game.js";

const MODULE_ID = "fabula-ultima-companion";
const CHANNEL = `module.${MODULE_ID}`;
const TYPE = "fu.mg";
const TAG = "[FU][Minigame]";
const SCENE_MODE = "minigame";

const ASSET_BASE = `modules/${MODULE_ID}/assets/minigame/`;
const FORGE_BGM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Fabula%20Ultima/BGM/";

// The games this mode can host. Each one says how to build it and what it pays.
const GAMES = {
  "plasma-field": {
    title: "Plasma Field Dash",
    create: createPlasmaField,
    assets: ASSET_BASE + "plasma-field/",
    bgm: { main: FORGE_BGM + "Lighthearted%20Mood.mp3", victory: FORGE_BGM + "Victory_Fanfare.mp3" },
    // first clear only, by final place (1st..4th)
    rewards: { coupons: [10, 8, 5, 2], fabula: [4, 3, 2, 1] },
  },
};

// The five drawn walk directions and the sheet fields that hold them (same as sprite-facing).
const ART_FIELDS = {
  down:     { walk: "sprite_walk_down",    stand: "sprite_stand_down" },
  downleft: { walk: "sprite_walk",         stand: "sprite_standard" },
  left:     { walk: "sprite_walk_left",    stand: "sprite_stand_left" },
  upleft:   { walk: "sprite_walk_up_left", stand: "sprite_stand_up_left" },
  up:       { walk: "sprite_walk_up",      stand: "sprite_stand_up" },
};
const FP_PROP = "fabula_point", FP_CAP = 10;
const CURTAIN_HOLD_MS = 900;   // black after the game closes, while the event repositions the party underneath

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const clean = (v) => String(v ?? "").trim();

export function sceneModeOf(scene) {
  return String(scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode ?? "");
}
export const isMinigameScene = (scene = canvas?.scene) => sceneModeOf(scene) === SCENE_MODE;

// ── Session state (one at a time) ───────────────────────────────────────────
let S = null;          // { sid, gameKey, hostId, isHost, instance, ui, clock, ... }
let lastOffer = null;  // an "open" this client could join late (reload mid-game)

function send(k, d) {
  if (!S) return;
  game.socket.emit(CHANNEL, { type: TYPE, payload: { sid: S.sid, k, d, u: game.user.id } });
}

// ── Clock: clients follow the host's performance.now() ──────────────────────
function makeClock(isHost) {
  const samples = [];
  let offset = 0, lastHost = performance.now(), pingTid = 0, n = 0;
  const clock = {
    hostNow: () => (isHost ? performance.now() : performance.now() + offset),
    hostSilentMs: () => (isHost ? 0 : performance.now() - lastHost),
    heardHost() { lastHost = performance.now(); },
    pong(d) {
      const t1 = performance.now(), rtt = t1 - d.t0;
      if (rtt < 0 || rtt > 5000) return;
      samples.push({ rtt, off: d.ht + rtt / 2 - t1 });
      if (samples.length > 8) samples.shift();
      offset = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
    },
    rtt: () => (samples.length ? Math.min(...samples.map((s) => s.rtt)) : null),
    lastRtt: () => (samples.length ? samples[samples.length - 1].rtt : null),
    start() {
      if (isHost) return;
      const ping = () => { send("ping", { t0: performance.now() }); n++; pingTid = setTimeout(ping, n < 6 ? 250 : 2000); };
      ping();
    },
    stop() { clearTimeout(pingTid); },
  };
  return clock;
}

// ── Overlay ─────────────────────────────────────────────────────────────────
function buildOverlay() {
  ensureStyles();
  const root = document.createElement("div");
  root.id = "fu-mg-root";
  root.className = "fu-mg";
  root.innerHTML = `<canvas class="fu-mg-cv" tabindex="0" aria-label="Minigame screen"></canvas>
    <div class="fu-mg-stage"><div class="overlay"></div></div>
    <div class="fu-mg-loading">Loading…</div>`;
  document.body.appendChild(root);
  const canvasEl = root.querySelector("canvas"), stage = root.querySelector(".fu-mg-stage");
  return {
    root, canvas: canvasEl, overlay: stage.querySelector(".overlay"),
    stageBox: () => ({ w: root.clientWidth, h: root.clientHeight }),
    place(w, h, s) {
      const x = Math.round((root.clientWidth - w) / 2), y = Math.round((root.clientHeight - h) / 2);
      const cs = canvasEl.style;
      if (cs.width !== w + "px") { cs.width = w + "px"; cs.height = h + "px"; }
      cs.left = x + "px"; cs.top = y + "px";
      stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    },
    loaded() { root.querySelector(".fu-mg-loading")?.remove(); },
    // a small label pinned to the bottom-left of the screen (playtest runs)
    tag(text) { const t = document.createElement("div"); t.className = "fu-mg-tag"; t.textContent = text; root.appendChild(t); },
    // Closing fades the game to black, then a black curtain holds while the event underneath moves the party
    // and camera, and only then fades away: the scene seems to carry straight on from the game.
    remove() {
      root.classList.add("is-closing");
      setTimeout(() => {
        root.remove();
        const c = document.createElement("div"); c.className = "fu-mg-curtain"; document.body.appendChild(c);
        setTimeout(() => { c.classList.add("is-gone"); setTimeout(() => c.remove(), 700); }, CURTAIN_HOLD_MS);
      }, 420);
    },
  };
}

// The board behind the overlay doesn't need to render while it is covered.
let tickerStopped = false;
function pauseBoard() {
  try { if (canvas?.app?.ticker?.started) { canvas.app.ticker.stop(); tickerStopped = true; } } catch (e) { console.warn(TAG, e); }
}
function resumeBoard() {
  try { if (tickerStopped) canvas?.app?.ticker?.start(); } catch (e) { console.warn(TAG, e); }
  tickerStopped = false;
}

const vol = (key, fallback) => { try { return Number(game.settings.get("core", key)) ?? fallback; } catch { return fallback; } };

function isTyping(ev) {
  const t = ev.target;
  return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && !t.closest?.("#fu-mg-root"));
}

// ── Roster: the party, each seat's player (or a CPU), and their art ─────────
// One seat per player. A player's linked character wins; otherwise the usual
// decider (explicit owner first), skipping anyone already seated. A player
// who owns several party members by default ownership still runs only one.
function assignSeats(actors, { requireActive = true } = {}) {
  const Sp = globalThis.FUCompanion?.api?.Spectator;
  const pool = (Sp?.participantUsers?.({ requireActive }) ?? game.users.filter((u) => !u.isGM && (!requireActive || u.active)));
  const seats = actors.map(() => null), taken = new Set();
  actors.forEach((a, i) => { const u = pool.find((x) => x.character?.id === a.id && !taken.has(x.id)); if (u) { seats[i] = u.id; taken.add(u.id); } });
  actors.forEach((a, i) => {
    if (seats[i]) return;
    const explicit = pool.filter((u) => !taken.has(u.id) && (a.ownership?.[u.id] ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER).sort((x, y) => x.id.localeCompare(y.id));
    if (explicit[0]) { seats[i] = explicit[0].id; taken.add(explicit[0].id); }
  });
  return seats;
}

// The current party, from the game DB's member_id_1..4.
async function partyActors() {
  const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
  const props = res?.db?.system?.props ?? {};
  const actors = [];
  for (let i = 1; i <= 4; i++) {
    const id = clean(props[`member_id_${i}`]).replace(/^Actor\./i, "");
    const actor = id ? game.actors?.get(id) : null;
    if (actor) actors.push(actor);
  }
  return actors;
}

// `actors` = who runs (default: the party). `seatUsers` = the user id per seat, or null for a CPU
// (default: each player's linked / owned character, as assignSeats decides).
async function buildRoster({ actors = null, seatUsers = null } = {}) {
  actors ??= await partyActors();
  seatUsers ??= assignSeats(actors);
  const out = [];
  for (const [i, actor] of actors.entries()) {
    const p = actor.system?.props ?? {};
    const die = (k) => Math.max(4, Math.min(12, Number(p[`${k}_current`] ?? p[k] ?? 8) || 8));
    const userId = seatUsers[i];
    const art = {};
    for (const [slot, f] of Object.entries(ART_FIELDS)) art[slot] = { walk: clean(p[f.walk]) || null, stand: clean(p[f.stand]) || null };
    out.push({
      name: clean(actor.name).split(/\s+/)[0] || actor.name,
      actorId: actor.id,
      attrs: { mig: die("mig"), dex: die("dex"), ins: die("ins"), wlp: die("wlp") },
      userId: userId && game.users.get(userId)?.active ? userId : null,
      cpu: !(userId && game.users.get(userId)?.active),
      portrait: clean(p.sprite_standard) || actor.img || null,
      art,
    });
  }
  // two party members can't share a first name on the board
  const seen = new Map();
  for (const r of out) { const n = (seen.get(r.name) ?? 0) + 1; seen.set(r.name, n); if (n > 1) r.name = `${r.name} ${n}`; }
  return out;
}

// ── Opening a session on this client ────────────────────────────────────────
async function openSession(offer, { isHost, late = false, hold = false } = {}) {
  if (S) closeSession("replaced");
  const def = GAMES[offer.game];
  if (!def) { console.warn(TAG, "unknown game", offer.game); return null; }
  // a late joiner watches until the host hands their seat back at a round break
  const myIdx = late ? -1 : offer.roster.findIndex((r) => !r.cpu && r.userId === game.user.id);
  const ui = buildOverlay();
  const clock = makeClock(isHost);
  S = { sid: offer.sid, gameKey: offer.game, hostId: offer.hostId, isHost, ui, clock, offer, instance: null, loadedFrom: new Set() };
  const showPerf = () => !!globalThis.FUCompanion?.minigamePerf;
  const env = {
    canvas: ui.canvas, overlay: ui.overlay, stageBox: ui.stageBox, place: ui.place,
    roster: offer.roster.map((r) => ({ ...r })), myIdx, userId: game.user.id, hostId: offer.hostId,
    isHost, isGM: !!game.user.isGM, firstClear: !!offer.firstClear && !offer.playtest,
    playtest: offer.playtest ? { ...offer.playtest } : null,
    asset: (f) => def.assets + f, bgm: def.bgm,
    sfxVol: () => vol("globalInterfaceVolume", 0.5) * 1.6,
    musicVol: () => vol("globalPlaylistVolume", 0.5),
    isActive: () => !!S && S.sid === offer.sid,
    isTyping, showPerf,
    // dev/test only: this client's runner plays itself (set FUCompanion.minigameAutopilot = true before the game opens)
    autopilot: !!globalThis.FUCompanion?.minigameAutopilot,
    maxBackingWidth: () => 2200,
    // which seat a (re)joining user decides for (their linked / owned party character)
    seatFor: (userId) => {
      // the seat this user started in wins (a playtest can seat anyone anywhere)
      const own = offer.roster.findIndex((r) => r.userId === userId);
      if (own >= 0) return own;
      const actors = offer.roster.map((r) => game.actors.get(r.actorId)).filter(Boolean);
      return assignSeats(actors, { requireActive: true }).indexOf(userId);
    },
    net: {
      send: (k, d) => send(k, d),
      hostNow: () => clock.hostNow(),
      hostSilentMs: () => clock.hostSilentMs(),
    },
    onResult: (r) => { S && (S.result = r); },
    onClose: () => finishSession(),
  };
  pauseBoard();
  clock.start();
  try {
    S.instance = def.create(env);
    await S.instance.load();
  } catch (e) {
    console.error(TAG, "could not start the minigame", e);
    ui.notifications?.error?.("The minigame failed to load. See the console (F12).");
    closeSession("error");
    return null;
  }
  ui.loaded();
  if (offer.playtest) ui.tag("Playtest · nothing is saved");
  if (offer.playtest) startPerfRecorder(S, myIdx);
  if (!isHost) send("loaded", { seat: myIdx });
  const begin = () => { S?.instance?.begin({ intro: offer.intro, replay: !!offer.replay, late }); ui.canvas.focus(); };
  if (hold) S.begin = begin; else begin();
  console.info(TAG, `${def.title} opened (${isHost ? "host" : myIdx >= 0 ? "runner " + offer.roster[myIdx].name : "watching"})`);
  return S;
}

function closeSession(why) {
  if (!S) return;
  const s = S; S = null;
  try { clearInterval(s.perfTid); } catch {}
  try { s.instance?.destroy(); } catch (e) { console.warn(TAG, e); }
  try { s.clock.stop(); } catch {}
  s.ui.remove();
  resumeBoard();
  if (s.isHost && s.perfLog) { try { finishPerfLog(s, why); } catch (e) { console.warn(TAG, "perf log", e); } }
  s.resolve?.(s.result ?? { closed: why });
  console.info(TAG, "closed:", why);
}

// The game said "leave": the host pays out (first clear only), then everyone closes.
async function finishSession() {
  if (!S) return;
  const s = S;
  if (s.isHost && s.result && !s.paid) {
    s.paid = true;
    try { s.result.paid = await payRewards(s); } catch (e) { console.error(TAG, "rewards failed", e); }
  }
  closeSession("done");
}

async function payRewards(s) {
  const def = GAMES[s.gameKey];
  const r = s.result;
  // a playtest never writes to the world, whatever else the offer says
  if (s.offer.playtest) return null;
  if (!def?.rewards || r.replay || !s.offer.firstClear) return null;
  const db = (await globalThis.FUCompanion?.api?.getCurrentGameDb?.())?.db ?? null;
  const lines = [];
  // coupons: one shared pool on the party actor
  const coupons = r.ranking.reduce((sum, row) => sum + (def.rewards.coupons[row.place - 1] ?? 0), 0);
  if (db && coupons > 0) {
    const { grantCoupons } = await import("../gacha-system/gacha-state.js");
    const g = await grantCoupons(db, coupons);
    lines.push(g?.ok ? `<b>${coupons}</b> Hako Coupons for the party (now ${g.total}).` : `Couldn't add the Hako Coupons (${g?.reason ?? "unknown"}).`);
  }
  // Fabula Points by place; a runner already at the cap passes the excess down, in order
  let carry = 0;
  const fpLines = [];
  for (const row of [...r.ranking].sort((a, b) => a.place - b.place)) {
    const actor = game.actors.get(row.actorId);
    let give = (def.rewards.fabula[row.place - 1] ?? 0) + carry; carry = 0;
    if (!actor || give <= 0) { carry = give; continue; }
    const cur = Math.max(0, Number(actor.system?.props?.[FP_PROP]) || 0);
    const room = Math.max(0, FP_CAP - cur), got = Math.min(room, give);
    carry = give - got;
    if (got > 0) { await actor.update({ [`system.props.${FP_PROP}`]: cur + got }); fpLines.push(`${row.name} +${got}`); }
  }
  if (fpLines.length) lines.push(`Fabula Points: ${fpLines.join(", ")}.`);
  if (carry > 0) lines.push(`(${carry} Fabula Point${carry > 1 ? "s" : ""} had nowhere to go: everyone is at ${FP_CAP}.)`);
  const podium = [...r.ranking].sort((a, b) => a.place - b.place).map((row) => `${row.place}. ${row.name}${row.cpu ? " (CPU)" : ""} · ${row.points} pts`).join("<br>");
  try {
    await ChatMessage.create({ speaker: { alias: def.title }, content: `<p><b>${def.title}</b>: first clear!</p><p>${podium}</p><p>${lines.join("<br>")}</p>` });
  } catch (e) { console.warn(TAG, e); }
  return { coupons, fabula: fpLines };
}

// ── Playtest performance recorder ───────────────────────────────────────────
// Playtest runs only. Every client (host included) takes a 2-second sample of
// its own frame times and network smoothness (the game's perfWindow()) plus its
// ping, and sends it to the host. The host keeps the whole run in memory and,
// when the field closes, stores it in THIS browser's localStorage (last 10
// runs), never in the world, then shows a per-player, per-stage summary.
const PERF_STORE = `${MODULE_ID}.minigamePerfLogs`;
const PERF_EVERY_MS = 2000;
const perfLogsLoad = () => { try { return JSON.parse(localStorage.getItem(PERF_STORE) || "[]"); } catch { return []; } };
function perfLogsSave(logs) {
  // localStorage is ~5 MB: drop the oldest runs until it fits
  for (let keep = logs.length; keep > 0; keep--) {
    try { localStorage.setItem(PERF_STORE, JSON.stringify(logs.slice(0, keep))); return true; } catch {}
  }
  return false;
}

function deviceInfo(canvasEl) {
  let gpu = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) ?? null;
  } catch {}
  return {
    ua: navigator.userAgent, gpu, cores: navigator.hardwareConcurrency ?? null, memGB: navigator.deviceMemory ?? null,
    screen: `${screen.width}x${screen.height}`, window: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio,
    canvas: canvasEl ? `${canvasEl.width}x${canvasEl.height}` : null,
  };
}

function startPerfRecorder(s, myIdx) {
  if (s.isHost) {
    const o = s.offer;
    s.perfLog = {
      sid: o.sid, game: o.game, at: new Date().toISOString(), opts: o.playtest,
      roster: o.roster.map((r) => ({ name: r.name, cpu: !!r.cpu, user: r.userId ? game.users.get(r.userId)?.name ?? r.userId : null })),
      users: {}, end: null,
    };
  }
  let devSent = false;
  s.perfTid = setInterval(() => {
    if (S !== s || !s.instance?.perfWindow) return;
    const w = s.instance.perfWindow();
    const rtt = s.clock.lastRtt(), best = s.clock.rtt();
    const sample = { t: Math.round(s.clock.hostNow()), seat: myIdx, hidden: document.hidden ? 1 : 0,
      rtt: rtt == null ? null : Math.round(rtt), rttBest: best == null ? null : Math.round(best), ...w };
    // the device line goes once, after the canvas has its real size
    if (!devSent) { devSent = true; sample.dev = deviceInfo(s.ui.canvas); }
    if (s.isHost) recordPerf(s, game.user.id, sample); else send("perf", sample);
  }, PERF_EVERY_MS);
}

function recordPerf(s, userId, d) {
  const log = s.perfLog; if (!log || !d) return;
  const u = (log.users[userId] ??= { name: game.users.get(userId)?.name ?? userId, host: userId === game.user.id, dev: null, samples: [] });
  if (d.dev) { u.dev = d.dev; delete d.dev; }
  if (u.samples.length < 3000) u.samples.push(d);
}

const phaseOf = (x) => (x.mode === "practice" ? "Practice" : x.mode === "play" && x.stage >= 0 ? `Stage ${x.stage + 1}` : null);
function med(arr) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; }

// One row per player per phase (practice, stage 1-3), plus an "All racing" row.
function summarizePerf(log) {
  const rows = [];
  for (const u of Object.values(log.users)) {
    const groups = new Map();
    for (const x of u.samples) {
      const ph = phaseOf(x); if (!ph || !x.frames) continue;
      if (!groups.has(ph)) groups.set(ph, []);
      groups.get(ph).push(x);
      if (ph !== "Practice") { if (!groups.has("All racing")) groups.set("All racing", []); groups.get("All racing").push(x); }
    }
    // nothing drawn while racing (tab hidden or minimised the whole time): still list them, or they'd silently vanish
    if (!groups.size) {
      rows.push({ player: u.name + (u.host ? " (host)" : ""), phase: "No racing frames", secs: 0, fps: null, worstFps: null, slowPerMin: null, frameP95: null, worstFrame: null,
        pingMed: med(u.samples.map((x) => x.rtt).filter((v) => v != null)), pingMax: null, gapP95: null, gapMax: 0, stallPct: null,
        hiddenS: u.samples.filter((x) => x.hidden).length * PERF_EVERY_MS / 1000, errors: Math.max(0, ...u.samples.map((x) => x.errors)) });
    }
    for (const [phase, xs] of groups) {
      const frames = xs.reduce((a, x) => a + x.frames, 0), ms = xs.reduce((a, x) => a + (x.ms ?? x.frames * 1000 / (x.fps || 60)), 0);
      const rtts = xs.map((x) => x.rtt).filter((v) => v != null);
      rows.push({
        player: u.name + (u.host ? " (host)" : ""), phase, secs: Math.round(ms / 1000),
        fps: Math.round(1000 * frames / (ms || 1)), worstFps: Math.min(...xs.map((x) => x.fps)),
        slowPerMin: +((xs.reduce((a, x) => a + x.long, 0)) / ((ms || 1) / 60000)).toFixed(1),
        frameP95: med(xs.map((x) => x.frameP95)), worstFrame: Math.max(...xs.map((x) => x.frameMax)),
        pingMed: med(rtts), pingMax: rtts.length ? Math.max(...rtts) : null,
        gapP95: med(xs.map((x) => x.snapGapP95).filter(Boolean)), gapMax: Math.max(0, ...xs.map((x) => x.snapGapMax)),
        stallPct: +(xs.reduce((a, x) => a + x.starvedPct, 0) / xs.length).toFixed(1),
        hiddenS: xs.filter((x) => x.hidden).length * PERF_EVERY_MS / 1000, errors: Math.max(...xs.map((x) => x.errors)),
      });
    }
  }
  const order = (p) => (p === "Practice" ? 0 : p === "All racing" ? 9 : Number(p.slice(-1)));
  return rows.sort((a, b) => a.player.localeCompare(b.player) || order(a.phase) - order(b.phase));
}

function finishPerfLog(s, why) {
  const log = s.perfLog; s.perfLog = null;
  log.end = { at: new Date().toISOString(), why };
  if (!Object.values(log.users).some((u) => u.samples.length)) return;
  log.summary = summarizePerf(log);
  const logs = perfLogsLoad(); logs.unshift(log);
  if (!perfLogsSave(logs.slice(0, 10))) console.warn(TAG, "perf log too big for localStorage; use the JSON button now");
  console.info(TAG, "playtest performance:"); console.table(log.summary);
  showPerfSummary(log);
}

function downloadPerfLog(log) {
  const name = `plasma-field-perf-${log.at.replace(/[:.]/g, "-")}.json`;
  try { saveDataToFile(JSON.stringify(log, null, 1), "application/json", name); }
  catch (e) { console.warn(TAG, e); }
}

function showPerfSummary(log) {
  const esc = (v) => foundry.utils.escapeHTML?.(String(v ?? "")) ?? String(v ?? "");
  const rows = log.summary ?? summarizePerf(log);
  // colour: green fine, amber noticeable, red a problem
  const c = (v, warn, bad, lowIsBad = false) => (v == null ? "" : (lowIsBad ? v < bad : v > bad) ? "bad" : (lowIsBad ? v < warn : v > warn) ? "warn" : "ok");
  const tr = rows.map((r) => `<tr class="${r.phase === "All racing" ? "all" : ""}"><td>${esc(r.player)}</td><td>${esc(r.phase)}</td><td>${r.secs}</td>
    <td class="${c(r.fps, 55, 45, true)}">${r.fps ?? "-"}</td><td class="${c(r.worstFps, 50, 35, true)}">${r.worstFps ?? "-"}</td>
    <td class="${c(r.slowPerMin, 6, 20)}">${r.slowPerMin ?? "-"}</td><td class="${c(r.frameP95, 20, 34)}">${r.frameP95 ?? "-"}</td><td class="${c(r.worstFrame, 100, 250)}">${r.worstFrame ?? "-"}</td>
    <td class="${c(r.pingMed, 120, 250)}">${r.pingMed ?? "-"}</td><td class="${c(r.pingMax, 300, 600)}">${r.pingMax ?? "-"}</td>
    <td class="${c(r.gapP95, 90, 160)}">${r.gapP95 ?? "-"}</td><td class="${c(r.gapMax, 300, 800)}">${r.gapMax || "-"}</td>
    <td class="${c(r.stallPct, 3, 10)}">${r.stallPct ?? "-"}</td><td class="${c(r.hiddenS, 0, 10)}">${r.hiddenS}</td><td class="${c(r.errors, 0, 0)}">${r.errors}</td></tr>`).join("");
  const devs = Object.values(log.users).map((u) => `<li><b>${esc(u.name)}</b>: ${esc(u.dev?.gpu ?? "GPU unknown")} · screen ${esc(u.dev?.screen)} @${u.dev?.dpr ?? "?"}x · canvas ${esc(u.dev?.canvas)} · ${u.dev?.cores ?? "?"} cores</li>`).join("");
  const content = `<div class="fu-mg-perf">
    <style>.fu-mg-perf table{font-size:11px;border-collapse:collapse;width:100%}.fu-mg-perf th,.fu-mg-perf td{padding:2px 4px;border-bottom:1px solid #8884;text-align:right}
    .fu-mg-perf td:nth-child(-n+2),.fu-mg-perf th:nth-child(-n+2){text-align:left}.fu-mg-perf .ok{color:#2e7d32}.fu-mg-perf .warn{color:#b26a00;font-weight:700}
    .fu-mg-perf .bad{color:#c62828;font-weight:700}.fu-mg-perf tr.all td{border-top:2px solid #8888;font-weight:600}.fu-mg-perf ul{font-size:11px;margin:6px 0}</style>
    <p class="notes">${esc(log.at.slice(0, 19).replace("T", " "))} · ${esc(log.roster.map((r) => `${r.name}=${r.cpu ? "CPU" : r.user}`).join(", "))} · ended: ${esc(log.end?.why)}</p>
    <table><tr><th>Player</th><th>Phase</th><th>Secs</th><th>FPS</th><th>Worst 2s</th><th>Slow/min</th><th>Frame p95</th><th>Worst frame</th>
      <th>Ping</th><th>Ping max</th><th>Gap p95</th><th>Gap max</th><th>Stall %</th><th>Tab hidden s</th><th>Errors</th></tr>${tr}</table>
    <ul>${devs}</ul>
    <p class="notes">FPS = frames drawn per second. Slow/min = frames over 33 ms (a visible hitch). Ping = round trip to the host (ms).
    Gap = time between another runner's position updates while they move (target 50 ms). Stall % = frames where a moving runner had no fresh position to draw.</p></div>`;
  new Dialog({
    title: "Playtest performance: Plasma Field Dash", content,
    buttons: { json: { icon: '<i class="fas fa-download"></i>', label: "Download JSON", callback: () => downloadPerfLog(log) }, ok: { label: "Close" } },
    default: "ok",
  }, { width: 900, resizable: true }).render(true);
}

// ── Socket ──────────────────────────────────────────────────────────────────
function onSocket(msg) {
  if (!msg || msg.type !== TYPE) return;
  const p = msg.payload || {};
  const from = game.users.get(p.u) ?? null;
  if (p.k === "open") {
    // a new session from the host: join it (a GM's open is the only one honoured)
    if (!from?.isGM) return;
    lastOffer = p.d;
    openSession(p.d, { isHost: false }).catch((e) => console.error(TAG, e));
    return;
  }
  if (p.k === "who" && S?.isHost) { send("open-late", { ...S.offer, to: p.u }); return; }
  if (p.k === "open-late") {
    if (S || !from?.isGM || p.d.to !== game.user.id) return;
    openSession(p.d, { isHost: false, late: true }).catch((e) => console.error(TAG, e));
    return;
  }
  if (!S || p.sid !== S.sid) return;
  if (p.u === S.hostId) S.clock.heardHost();
  switch (p.k) {
    case "ping":
      if (!S.isHost) return;
      send("pong", { to: p.u, t0: p.d.t0, ht: performance.now() });
      // the ping keeps running in a background tab: it is how the host knows a player is still here
      S.instance?.handle("hello", {}, from ? { id: from.id, isGM: from.isGM } : { id: p.u, isGM: false });
      return;
    case "pong": if (p.d.to === game.user.id) S.clock.pong(p.d); return;
    case "loaded": if (S.isHost) S.loadedFrom.add(p.u); return;
    case "perf": if (S.isHost && S.perfLog) recordPerf(S, p.u, p.d); return;
    case "bye": if (p.u === S.hostId) closeSession("host closed"); return;
  }
  try { S.instance?.handle(p.k, p.d, from ? { id: from.id, isGM: from.isGM } : { id: p.u, isGM: false }); }
  catch (e) { console.error(TAG, "handler", p.k, e); }
}

// ── Host API ────────────────────────────────────────────────────────────────
/**
 * Run a minigame for everyone connected. Primary GM only.
 * @param {object} o
 * @param {string} o.game        "plasma-field"
 * @param {"full"|"none"} [o.intro]  the in-game opening pan (full) or straight to practice
 * @param {boolean} [o.firstClear]   pay rewards at the end (the caller decides; replays pass false)
 * @param {boolean} [o.replay]       a replay: time limit on, rewards column reads "Just for fun"
 * @returns {Promise<object>} the result: { ranking:[{actorId,name,place,points,cpu}], rescuer, replay, paid }
 */
async function run({ game: gameKey = "plasma-field", intro = "full", firstClear = false, replay = false } = {}) {
  if (!isPrimaryGM()) throw new Error("Only the primary GM can start a minigame.");
  if (!GAMES[gameKey]) throw new Error(`Unknown minigame "${gameKey}".`);
  if (S) closeSession("restart");
  const roster = await buildRoster();
  if (!roster.length) { ui.notifications?.warn?.("No party members found (check the game DB's member_id_1..4)."); return { closed: "no party" }; }
  return startOffer({ sid: foundry.utils.randomID(), game: gameKey, roster, intro, replay: !!replay, firstClear: !!firstClear && !replay, hostId: game.user.id });
}

/**
 * Play a minigame as a sandbox: no story context, nothing written to the world.
 * No switches, variables, rewards, chat card or event hold; it runs on any scene.
 * Primary GM only. Any option left out takes the default below.
 * @param {object} o
 * @param {string}   [o.game]        "plasma-field"
 * @param {string[]} [o.actors]      who runs, by actor name or id, 1-4 (default: the current party)
 * @param {object}   [o.seats]       { "<user name or id>": "<actor name or id>" }: put a player (a GM too) on a runner.
 *                                   Seats not named here go to their usual player; "cpu" as the user key is ignored.
 * @param {boolean}  [o.cpu]         true (default): seats nobody takes are CPUs. false: only named seats get a player,
 *                                   and the usual linked/owned seating is skipped (every other seat is a CPU)
 * @param {"full"|"none"} [o.intro]  "none" (default) skips the opening pan
 * @param {boolean}  [o.practice]    true (default): the practice yard first. false: straight to the race
 * @param {boolean}  [o.quick]       the short course (default false)
 * @param {boolean}  [o.timeLimit]   the replay time limit (default false: no limit, the GM can call a round)
 * @param {number}   [o.startStage]  1, 2 or 3: the stage the race opens on (default 1)
 * @returns {Promise<object>} the result, as run() (paid is always null)
 */
async function playtest({ game: gameKey = "plasma-field", actors = null, seats = null, cpu = true, intro = "none",
  practice = true, quick = false, timeLimit = false, startStage = 1 } = {}) {
  if (!isPrimaryGM()) throw new Error("Only the primary GM can start a minigame.");
  if (!GAMES[gameKey]) throw new Error(`Unknown minigame "${gameKey}".`);
  const findActor = (v) => { const k = clean(v).replace(/^Actor\./i, ""); return game.actors.get(k) ?? game.actors.find((a) => a.name === k) ?? game.actors.find((a) => clean(a.name).split(/\s+/)[0].toLowerCase() === k.toLowerCase()) ?? null; };
  const findUser = (v) => { const k = clean(v); return game.users.get(k) ?? game.users.find((u) => u.name === k) ?? game.users.find((u) => u.name.toLowerCase() === k.toLowerCase()) ?? null; };
  let list;
  if (actors?.length) {
    list = actors.map((v) => { const a = findActor(v); if (!a) throw new Error(`Playtest: no actor "${v}".`); return a; });
  } else list = await partyActors();
  list = list.filter((a, i) => list.indexOf(a) === i).slice(0, 4);
  if (!list.length) throw new Error("Playtest: no runners (pass actors, or set the party in the game DB).");
  // seats: the named ones first, then (with cpu on) each player's usual character
  const seatUsers = list.map(() => null);
  for (const [uk, ak] of Object.entries(seats ?? {})) {
    const u = findUser(uk); if (!u) throw new Error(`Playtest: no user "${uk}".`);
    if (!u.active) { ui.notifications?.warn?.(`Playtest: ${u.name} isn't connected; their seat is a CPU.`); continue; }
    const a = findActor(ak), i = a ? list.indexOf(a) : -1;
    if (i < 0) throw new Error(`Playtest: "${ak}" isn't one of the runners.`);
    if (seatUsers.includes(u.id)) throw new Error(`Playtest: ${u.name} is seated twice.`);
    seatUsers[i] = u.id;
  }
  if (cpu) {
    const usual = assignSeats(list);
    usual.forEach((u, i) => { if (u && !seatUsers[i] && !seatUsers.includes(u)) seatUsers[i] = u; });
  }
  if (S) closeSession("restart");
  const roster = await buildRoster({ actors: list, seatUsers });
  const st = Math.max(1, Math.min(3, Math.round(Number(startStage) || 1)));
  console.info(TAG, "playtest:", roster.map((r) => `${r.name}=${r.cpu ? "CPU" : game.users.get(r.userId)?.name}`).join(", "));
  return startOffer({
    sid: foundry.utils.randomID(), game: gameKey, roster, intro: intro === "full" ? "full" : "none", replay: false, firstClear: false, hostId: game.user.id,
    playtest: { quick: !!quick, timeLimit: !!timeLimit, practice: practice !== false, startStage: st - 1 },
  });
}

// Send the offer to everyone, open it here as the host, resolve once the field closes.
async function startOffer(offer) {
  let resolveRun;
  const done = new Promise((resolve) => { resolveRun = resolve; });
  game.socket.emit(CHANNEL, { type: TYPE, payload: { sid: offer.sid, k: "open", d: offer, u: game.user.id } });
  // host opens too, but holds the first frame until every runner's client has loaded (or 12 s pass)
  const s = await openSessionHostWhenReady(offer, resolveRun);
  if (!s) return { closed: "error" };
  return done;
}

async function openSessionHostWhenReady(offer, resolveRun) {
  // open the overlay and load the art, but don't begin until the runners have loaded
  const need = new Set(offer.roster.filter((r) => !r.cpu && r.userId && r.userId !== game.user.id).map((r) => r.userId));
  const s = await openSession(offer, { isHost: true, hold: true });
  if (!s) { resolveRun({ closed: "error" }); return null; }
  s.resolve = resolveRun;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      if (!S || S !== s) return resolve();
      const missing = [...need].filter((u) => !s.loadedFrom.has(u));
      if (!missing.length || performance.now() - t0 > 12000) {
        if (missing.length) console.warn(TAG, "starting without", missing.map((u) => game.users.get(u)?.name));
        return resolve();
      }
      setTimeout(tick, 150);
    };
    tick();
  });
  if (S === s) s.begin?.();
  return s;
}

// ── Playtest launcher (GM dialog) ───────────────────────────────────────────
// Four seats (character + who plays it) and the run options. The last choices
// are kept in this browser only (localStorage), never in the world.
const PT_STORE = `${MODULE_ID}.minigamePlaytest`;
const ptLoad = () => { try { return JSON.parse(localStorage.getItem(PT_STORE) || "null"); } catch { return null; } };
const ptSave = (v) => { try { localStorage.setItem(PT_STORE, JSON.stringify(v)); } catch {} };

async function openPlaytest() {
  if (!game.user.isGM) return ui.notifications?.warn?.("Only a GM can start a playtest.");
  if (!isPrimaryGM()) return ui.notifications?.warn?.("Only the primary GM can start a minigame.");
  const esc = (v) => foundry.utils.escapeHTML?.(String(v ?? "")) ?? String(v ?? "");
  const party = await partyActors();
  const others = game.actors.filter((a) => a.hasPlayerOwner && !party.includes(a)).sort((a, b) => a.name.localeCompare(b.name));
  const users = game.users.filter((u) => u.active).sort((a, b) => (a.isGM - b.isGM) || a.name.localeCompare(b.name));
  const usual = assignSeats(party);
  const last = ptLoad();
  // defaults: the party with its usual players; a remembered seat list wins when its actors still exist
  let rows = [0, 1, 2, 3].map((i) => ({ actor: party[i]?.id ?? "", user: usual[i] ?? "" }));
  if (Array.isArray(last?.rows) && last.rows.some((r) => r.actor && game.actors.get(r.actor))) {
    rows = last.rows.slice(0, 4).map((r) => ({ actor: game.actors.get(r.actor) ? r.actor : "", user: game.users.get(r.user)?.active ? r.user : "" }));
    while (rows.length < 4) rows.push({ actor: "", user: "" });
  }
  const o = { practice: true, intro: false, quick: false, timeLimit: false, startStage: 1, ...(last?.opts ?? {}) };
  const actorOpts = (sel) => `<option value="">(empty seat)</option>`
    + (party.length ? `<optgroup label="Party">${party.map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>` : "")
    + (others.length ? `<optgroup label="Other player characters">${others.map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>` : "");
  const userOpts = (sel) => `<option value="">CPU</option>` + users.map((u) => `<option value="${u.id}" ${u.id === sel ? "selected" : ""}>${esc(u.name)}${u.isGM ? " (GM)" : ""}</option>`).join("");
  const content = `<form class="fu-mg-pt">
    <p class="notes">A sandbox run: no switches, rewards or chat card, nothing saved. Everyone connected sees it; empty player slots are CPUs.</p>
    <p class="notes"><b>Don't minimise this GM window while the game runs:</b> it hosts the race, and the game stops for everyone. Covering it with other windows is fine.</p>
    <table><tr><th>Seat</th><th>Character</th><th>Played by</th></tr>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td><select name="a${i}">${actorOpts(r.actor)}</select></td><td><select name="u${i}">${userOpts(r.user)}</select></td></tr>`).join("")}
    </table>
    <div class="form-group"><label>Start at stage</label><select name="startStage">${[1, 2, 3].map((n) => `<option value="${n}" ${n === Number(o.startStage) ? "selected" : ""}>Stage ${n}</option>`).join("")}</select></div>
    <div class="form-group"><label><input type="checkbox" name="practice" ${o.practice ? "checked" : ""}> Practice yard first (with the rules slides)</label></div>
    <div class="form-group"><label><input type="checkbox" name="intro" ${o.intro ? "checked" : ""}> Opening camera pan</label></div>
    <div class="form-group"><label><input type="checkbox" name="quick" ${o.quick ? "checked" : ""}> Quick course (short stages)</label></div>
    <div class="form-group"><label><input type="checkbox" name="timeLimit" ${o.timeLimit ? "checked" : ""}> Time limit per round (as on replays)</label></div>
  </form>`;
  const read = (html) => {
    const f = (html[0] ?? html).querySelector("form");
    const rowsOut = [0, 1, 2, 3].map((i) => ({ actor: f[`a${i}`].value, user: f[`u${i}`].value }));
    const opts = { practice: f.practice.checked, intro: f.intro.checked, quick: f.quick.checked, timeLimit: f.timeLimit.checked, startStage: Number(f.startStage.value) || 1 };
    return { rows: rowsOut, opts };
  };
  new Dialog({
    title: "Minigame Playtest: Plasma Field Dash",
    content,
    buttons: {
      go: { icon: '<i class="fas fa-play"></i>', label: "Start playtest", callback: async (html) => {
        const { rows: picked, opts } = read(html);
        const used = picked.filter((r) => r.actor);
        if (!used.length) return ui.notifications?.warn?.("Pick at least one character.");
        const ids = used.map((r) => r.actor);
        if (new Set(ids).size !== ids.length) return ui.notifications?.warn?.("A character is in two seats.");
        const us = used.map((r) => r.user).filter(Boolean);
        if (new Set(us).size !== us.length) return ui.notifications?.warn?.("A player is in two seats.");
        ptSave({ rows: picked, opts });
        const seats = Object.fromEntries(used.filter((r) => r.user).map((r) => [r.user, r.actor]));
        try {
          await playtest({ actors: ids, seats, cpu: false, intro: opts.intro ? "full" : "none", practice: opts.practice, quick: opts.quick, timeLimit: opts.timeLimit, startStage: opts.startStage });
        } catch (e) { console.error(TAG, e); ui.notifications?.error?.(e.message); }
      } },
      cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" },
    },
    default: "go",
  }, { width: 460, classes: ["dialog", "fu-mg-pt-dialog"] }).render(true);
}

function leave() {
  if (!S) return false;
  if (S.isHost) { send("bye", {}); finishSession(); }
  else closeSession("left");
  return true;
}

// ── Boot ────────────────────────────────────────────────────────────────────
// GM: a "Minigame Playtest" button under the token controls opens the launcher.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const tokenLayer = controls.find?.((c) => c.name === "token");
  if (!tokenLayer) return;
  tokenLayer.tools.push({ name: "fuMinigamePlaytest", title: "Minigame Playtest", icon: "fas fa-gamepad", button: true, onClick: () => openPlaytest() });
});

Hooks.once("ready", () => {
  game.socket.on(CHANNEL, onSocket);
  // a client that (re)loads while a minigame runs asks to join; it watches until the next round break
  setTimeout(() => { if (!S && !game.user.isGM) game.socket.emit(CHANNEL, { type: TYPE, payload: { sid: null, k: "who", d: {}, u: game.user.id } }); }, 2500);
  // the host leaving mid-game strands everyone else: give them a way out after a while
  Hooks.on("userConnected", (user, connected) => {
    if (!S || S.isHost || connected || user.id !== S.hostId) return;
    ui.notifications?.warn?.("The GM disconnected. The minigame will close if they don't come back.");
    setTimeout(() => { if (S && S.clock.hostSilentMs() > 25000) closeSession("host gone"); }, 30000);
  });
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.minigame = {
    run, playtest, openPlaytest, leave, isMinigameScene, sceneModeOf,
    games: () => Object.keys(GAMES),
    status: () => (S ? { sid: S.sid, game: S.gameKey, host: S.isHost, rtt: S.clock.rtt(), perf: S.instance?.perf?.(), mode: S.instance?.G?.mode, stage: S.instance?.G?.stage } : null),
    instance: () => S?.instance ?? null,
    // dev: toggle the frame-time readout in the corner
    perf: (on = true) => { globalThis.FUCompanion.minigamePerf = !!on; return on; },
    // playtest performance logs kept in this (host) browser, newest first; summary popup / JSON download by index
    perfLogs: () => perfLogsLoad(),
    perfSummary: (i = 0) => { const log = perfLogsLoad()[i]; if (log) showPerfSummary(log); return log ? summarizePerf(log) : null; },
    perfDownload: (i = 0) => { const log = perfLogsLoad()[i]; if (log) downloadPerfLog(log); return !!log; },
  };
  console.debug(TAG, "ready");
});

// ── Styles (the mockup's, scoped to the overlay) ────────────────────────────
function ensureStyles() {
  if (document.getElementById("fu-mg-styles")) return;
  const st = document.createElement("style");
  st.id = "fu-mg-styles";
  st.textContent = MG_CSS;
  document.head.appendChild(st);
}

const MG_CSS = `
.fu-mg-curtain{position:fixed;inset:0;z-index:10000;background:#000;pointer-events:none;transition:opacity .6s ease}
.fu-mg-curtain.is-gone{opacity:0}
#fu-mg-root > *{transition:opacity .4s ease}
#fu-mg-root.is-closing > *{opacity:0}
@keyframes fumgOpen{from{opacity:0}to{opacity:1}}
#fu-mg-root{animation:fumgOpen .45s ease both}
#fu-mg-root{position:fixed;inset:0;z-index:10000;background:#000;overflow:hidden;
  --bg:#141019;--panel:#1e1828;--line:#3a2f4d;--ink:#ece6f6;--muted:#a99cc0;--violet:#9b7bff;--bolt:#fff6c8;
  --parch-a:#f8f0d4;--parch-b:#ede0b0;--gold:#c9a44a;--wood:#7a4e20;--wood2:#b8865a;--pink:#3a1e06;--sta:#8fe36b;--go:#5fd38a;
  --ui:"Signika",system-ui,"Segoe UI",sans-serif;color:var(--ink);font-family:var(--ui);color-scheme:dark}
#fu-mg-root .fu-mg-cv{position:absolute;display:block;outline:none;image-rendering:auto}
#fu-mg-root .fu-mg-stage{position:absolute;left:0;top:0;width:960px;height:600px;transform-origin:0 0;pointer-events:none}
#fu-mg-root .fu-mg-tag{position:absolute;left:10px;bottom:8px;z-index:3;pointer-events:none;font:600 11px/1 var(--ui);letter-spacing:.12em;text-transform:uppercase;color:#f6ecd6;background:rgba(155,123,255,.32);border:1px solid rgba(155,123,255,.7);border-radius:4px;padding:4px 7px}
#fu-mg-root .fu-mg-loading{position:absolute;inset:0;display:grid;place-items:center;font:600 22px var(--ui);color:var(--muted)}
#fu-mg-root .overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
#fu-mg-root .overlay > *{pointer-events:auto}
#fu-mg-root .parch{background:linear-gradient(180deg,var(--parch-a),var(--parch-b));color:var(--pink);border:2px solid var(--gold);border-radius:12px;box-shadow:0 0 0 2px var(--wood),0 0 0 4px var(--wood2),0 12px 32px rgba(0,0,0,.55);position:relative}
#fu-mg-root .parch::before{content:"";position:absolute;inset:0;border-radius:10px;background:repeating-linear-gradient(180deg,transparent 0 27px,rgba(122,78,32,.07) 27px 28px);pointer-events:none}
#fu-mg-root .card{width:min(640px,92%);max-height:94%;overflow:auto;padding:16px 22px 14px;animation:fumgSlide .35s ease-out}
#fu-mg-root .card h2{margin:0 0 4px;font-size:1.3rem;font-weight:400;border:0;color:inherit;font-family:var(--ui)}
#fu-mg-root .card h2 b{font-weight:700}
#fu-mg-root .card .eyebrow{font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;opacity:.7}
#fu-mg-root .card p{margin:.35em 0;line-height:1.4;font-size:.93rem}
#fu-mg-root kbd{display:inline-block;min-width:1.6em;text-align:center;padding:1px 6px;border-radius:5px;background:#5c3818;color:var(--parch-a);font-family:var(--ui);font-size:.82rem;box-shadow:0 2px 0 #3b220c;border:0}
#fu-mg-root .row{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;align-items:center}
#fu-mg-root .btn{font:inherit;font-size:.95rem;color:var(--parch-a);background:linear-gradient(180deg,#7a5230,#5c3818);border:2px solid transparent;border-radius:8px;padding:7px 16px;cursor:pointer;width:auto;line-height:1.2;display:inline-block}
#fu-mg-root .btn.primary{border-color:var(--gold);box-shadow:0 0 10px rgba(201,164,74,.55)}
#fu-mg-root .btn.ghost{background:rgba(20,16,25,.75);color:var(--ink);border-color:var(--line);font-size:.8rem;padding:4px 10px}
#fu-mg-root .btn[disabled]{opacity:.55;cursor:default}
#fu-mg-root .btn:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
#fu-mg-root .tutv{position:absolute;inset:0;z-index:5;background:rgba(8,6,4,.74);display:grid;place-items:center;animation:fumgTv .2s ease-out}
@keyframes fumgTv{from{opacity:0}to{opacity:1}}
#fu-mg-root .tut{width:min(620px,92%);max-height:96%;overflow:auto;color:#3a3228;background:linear-gradient(180deg,#f6f1e6,#ebe3d0);border:2px solid #7a6a55;border-radius:10px;box-shadow:0 0 0 1px rgba(213,182,122,.6) inset,0 18px 44px rgba(0,0,0,.6);font-family:var(--ui)}
#fu-mg-root .tut>*{animation:fumgTr .26s cubic-bezier(.2,.8,.3,1) both}
@keyframes fumgTr{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
#fu-mg-root .tut .t-head{display:flex;align-items:center;gap:12px;padding:9px 16px;background:linear-gradient(180deg,#2b241b,#1f1a14);color:#f6ecd6}
#fu-mg-root .tut .t-sigil{width:24px;height:24px;color:#b48cff;flex:none}
#fu-mg-root .tut .t-head small{display:block;font:600 11px/1.2 var(--ui);letter-spacing:.14em;text-transform:uppercase;color:#d5b67a}
#fu-mg-root .tut .t-head b{font:600 21px/1.15 "Cinzel",Georgia,serif;letter-spacing:.02em}
#fu-mg-root .tut .t-shot{margin:14px 32px 0;position:relative;border:2px solid #7a6a55;border-radius:6px;overflow:hidden;background:#000;box-shadow:0 0 0 1px rgba(213,182,122,.8),0 4px 10px rgba(0,0,0,.3);aspect-ratio:16/9}
#fu-mg-root .tut .t-shot img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;border:0;max-width:none}
#fu-mg-root .tut .t-shot img.in{animation:fumgSi .36s cubic-bezier(.22,.8,.3,1) both}
#fu-mg-root .tut .t-shot img.out{animation:fumgSo .36s ease both}
@keyframes fumgSi{from{opacity:0;transform:translateX(var(--dx,36px))}to{opacity:1;transform:none}}
@keyframes fumgSo{from{opacity:1;transform:none}to{opacity:0;transform:translateX(calc(var(--dx,36px)*-.6))}}
#fu-mg-root .tut .t-text{margin:12px 32px 0;min-height:3em;font:400 18px/1.42 var(--ui);text-wrap:pretty;transition:opacity .16s ease,transform .16s ease}
#fu-mg-root .tut .t-text.swap{opacity:0;transform:translateY(4px)}
#fu-mg-root .tut .t-text em{font-style:normal;font-weight:600;color:#7d4f12}
#fu-mg-root .tut .t-foot{display:flex;align-items:center;gap:12px;margin-top:12px;padding:9px 14px;border-top:1px solid rgba(122,106,85,.45);background:rgba(213,182,122,.18);font:500 13px/1 var(--ui);color:#6d6152;flex-wrap:wrap}
#fu-mg-root .tut .t-foot .dots{flex:1;display:flex;gap:7px;justify-content:center;font-size:11px;color:#9c7a3a}
#fu-mg-root .tut .t-foot .dots i{font-style:normal;opacity:.35;transition:opacity .2s ease}
#fu-mg-root .tut .t-foot .dots i.on{opacity:1}
#fu-mg-root .tut .t-foot kbd{font:600 11px/1 var(--ui);color:#f6ecd6;background:#1f1a14;border-radius:3px;padding:4px 6px;box-shadow:none;min-width:0}
#fu-mg-root .tut .t-foot button{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;color:#6d6152}
#fu-mg-root .tut .t-foot button:hover{color:#3a3228}
#fu-mg-root .tut .t-foot button[disabled]{opacity:.3;cursor:default}
#fu-mg-root .tut .t-foot button.go{color:#3a1e06;font-weight:600}
#fu-mg-root .corner{position:absolute;right:12px;top:12px;display:flex;gap:6px}
#fu-mg-root .ready-bar{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;align-items:center}
#fu-mg-root table.res{width:100%;border-collapse:collapse;font-size:.84rem;font-variant-numeric:tabular-nums;margin:.4em 0 .6em;background:none;border:0}
#fu-mg-root table.res th{font-weight:600;text-align:left;font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;opacity:.75;padding:3px 6px;background:none;color:inherit;border:0}
#fu-mg-root table.res td{padding:4px 6px;border-top:1px solid rgba(122,78,32,.18);vertical-align:top}
#fu-mg-root table.res tr{background:none}
#fu-mg-root table.res tr.top td{background:rgba(201,164,74,.22)}
#fu-mg-root .tw{overflow-x:auto}
#fu-mg-root .ex{font-size:.75rem;opacity:.72}
#fu-mg-root .title{font-weight:600}
@keyframes fumgSlide{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){#fu-mg-root .card,#fu-mg-root .tutv,#fu-mg-root .tut>*,#fu-mg-root .tut .t-shot img.in,#fu-mg-root .tut .t-shot img.out{animation:none}#fu-mg-root .tut .t-text{transition:none}}
`;
