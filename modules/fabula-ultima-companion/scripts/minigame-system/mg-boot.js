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

async function buildRoster() {
  const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
  const props = res?.db?.system?.props ?? {};
  const actors = [];
  for (let i = 1; i <= 4; i++) {
    const id = clean(props[`member_id_${i}`]).replace(/^Actor\./i, "");
    const actor = id ? game.actors?.get(id) : null;
    if (actor) actors.push(actor);
  }
  const seatUsers = assignSeats(actors);
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
    isHost, isGM: !!game.user.isGM, firstClear: !!offer.firstClear,
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
  if (!isHost) send("loaded", { seat: myIdx });
  const begin = () => { S?.instance?.begin({ intro: offer.intro, replay: !!offer.replay, late }); ui.canvas.focus(); };
  if (hold) S.begin = begin; else begin();
  console.info(TAG, `${def.title} opened (${isHost ? "host" : myIdx >= 0 ? "runner " + offer.roster[myIdx].name : "watching"})`);
  return S;
}

function closeSession(why) {
  if (!S) return;
  const s = S; S = null;
  try { s.instance?.destroy(); } catch (e) { console.warn(TAG, e); }
  try { s.clock.stop(); } catch {}
  s.ui.remove();
  resumeBoard();
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
  const offer = { sid: foundry.utils.randomID(), game: gameKey, roster, intro, replay: !!replay, firstClear: !!firstClear && !replay, hostId: game.user.id };
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
  const need = new Set(offer.roster.filter((r) => !r.cpu && r.userId).map((r) => r.userId));
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

function leave() {
  if (!S) return false;
  if (S.isHost) { send("bye", {}); finishSession(); }
  else closeSession("left");
  return true;
}

// ── Boot ────────────────────────────────────────────────────────────────────
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
    run, leave, isMinigameScene, sceneModeOf,
    games: () => Object.keys(GAMES),
    status: () => (S ? { sid: S.sid, game: S.gameKey, host: S.isHost, rtt: S.clock.rtt(), perf: S.instance?.perf?.(), mode: S.instance?.G?.mode, stage: S.instance?.G?.stage } : null),
    instance: () => S?.instance ?? null,
    // dev: toggle the frame-time readout in the corner
    perf: (on = true) => { globalThis.FUCompanion.minigamePerf = !!on; return on; },
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
