// scripts/fabula-arcana/fa-host.js
// The duel HOST: the one client that owns every Fabula Arcana session — the main GM (game.users.activeGM),
// or, for an NPC duel with no GM online, the challenger's own client.
// It runs the match (fa-engine.js), the AI seat, the PvP decision timer, Best-of series and the ante reward,
// and sends each participant a view from its OWN seat (Engine.View) so every duel window draws "you" at the bottom.
//
// Session (plain JSON; saved to a world setting by a GM host so a reload resumes):
//   { sid, kind:'npc'|'pvp', hostId, bestOf, series, seats:[seat,seat], spectators:[userId], match, gameKey,
//     deadline, prize:{cid,label,hint}|null, quote, npc:{actorId,tokenUuid}, pending, over, reward }
//   seat: { userId|null, actorId, name, kind:'human'|'ai', ai:{diff,style}, team, ready, next, lastTeam }

import { TAG, MODULE_ID, FLAG_DUELIST, FLAG_BLOCK, SETTING_SESSIONS, Engine, Catalog, hostGM, uid } from "./fa-const.js";
import { send, on } from "./fa-net.js";
import { ownedCards, grantCard, grantStarter, canPlay } from "./fa-collection.js";

const sessions = new Map();
const runtime = new Map();              // sid -> { timer, ai:[t,t], inviteTimer }
const rt = (sid) => { if (!runtime.has(sid)) runtime.set(sid, { timer: null, ai: [null, null], inviteTimer: null }); return runtime.get(sid); };
const E = () => Engine();
const CFG = () => Catalog().CFG;

export const listSessions = () => [...sessions.values()];
const inSession = (userId) => [...sessions.values()].find((s) => !s.over && (s.seats.some((t) => t.userId === userId)));
const notify = (userId, text, level = "info") => userId && send(userId, "notify", { text, level });
const INVITE_MS = 20000;                 // a PvP challenge stays open this long, then closes itself on both sides
const blockedBy = (target, fromUserId) => !game.users.get(fromUserId)?.isGM && !!target?.getFlag?.(MODULE_ID, FLAG_BLOCK)?.[fromUserId];

// ------------------------------------------------------------------ views
function viewerOf(s, userId) { const i = s.seats.findIndex((t) => t.userId === userId); return i >= 0 ? i : null; }
function participants(s) {
  const out = [];
  s.seats.forEach((t, i) => { if (t.userId && !out.some((p) => p.uid === t.userId)) out.push({ uid: t.userId, viewer: i }); });
  for (const u of s.spectators) if (!out.some((p) => p.uid === u)) out.push({ uid: u, viewer: null });
  return out;
}
function seriesFor(s, viewer) {
  const base = { ...s.series, wins: [...s.series.wins], game: s.match && s.match.phase !== "ended" ? s.series.game + 1 : s.series.game };
  return E().View.seriesForSeat(base, viewer);
}
function payload(s, viewer) {
  if (!s.match) return {};
  return { view: E().View.forSeat(s.match, viewer), series: seriesFor(s, viewer), gameKey: s.gameKey,
    msLeft: s.deadline ? Math.max(0, s.deadline - Date.now()) : 0, reward: viewer === 0 ? s.reward : null };
}
const toDuel = (s, uid, msg) => send(uid, "duel", { msg }, s.sid);
function broadcast(s, build) { for (const p of participants(s)) toDuel(s, p.uid, build(p.viewer)); }
function names(s, viewer) { const n = s.seats.map((t) => t.name); return viewer === 1 ? [n[1], n[0]] : n; }

// the team to preselect: last game's team, or the only legal team when the collection allows just one
function suggestTeam(seat, owned) {
  if (seat.lastTeam && seat.lastTeam.every((c) => owned.includes(c))) return seat.lastTeam;
  const legal = [];
  for (let a = 0; a < owned.length; a++) for (let b = a + 1; b < owned.length; b++) for (let c = b + 1; c < owned.length; c++) {
    const t = [owned[a], owned[b], owned[c]]; if (E().isLegalTeam(t)) legal.push(t);
    if (legal.length > 1) return null;
  }
  return legal[0] ?? null;
}

function sendInit(s, userId) {
  const viewer = viewerOf(s, userId);
  const role = viewer === null ? "spectator" : "player";
  const me = viewer === null ? null : s.seats[viewer], opp = viewer === null ? null : s.seats[1 - viewer];
  const actor = me ? game.actors.get(me.actorId) : null;
  const owned = me ? ownedCards(actor) : [];
  const lobby = me ? {
    kind: s.kind, owned, suggest: suggestTeam(me, owned), bestOf: s.bestOf, quote: s.quote || "",
    prize: viewer === 0 && s.prize ? s.prize.cid : null, prizeLabel: s.prize?.label, prizeHint: s.prize?.hint, oppReady: !!opp?.ready,
  } : { kind: s.kind, bestOf: s.bestOf };
  const nm = names(s, viewer);
  toDuel(s, userId, { t: "init", role, myName: nm[0], oppName: nm[1], names: nm, lobby, ready: !!me?.ready, spectators: s.spectators.length, ...payload(s, viewer) });
}

// ------------------------------------------------------------------ status (overhead icons, Watch buttons)
export function statusList() {
  return [...sessions.values()].filter((s) => !s.pending && !s.over).map((s) => ({
    sid: s.sid, kind: s.kind, hostId: s.hostId, actorIds: s.seats.map((t) => t.actorId), userIds: s.seats.map((t) => t.userId),
    names: s.seats.map((t) => t.name), npcTokenUuid: s.npc?.tokenUuid ?? null,
  }));
}
const pushStatus = (to = null) => send(to, "status", { sessions: statusList(), hostId: game.user.id });

// ------------------------------------------------------------------ persistence (GM host only)
let saveTimer = null;
function save() {
  if (!game.user.isGM) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = Object.fromEntries([...sessions.values()].filter((s) => !s.over && !s.pending).map((s) => [s.sid, s]));
    game.settings.set(MODULE_ID, SETTING_SESSIONS, keep).catch((e) => console.warn(TAG, "save sessions", e));
  }, 400);
}
export function restore() {
  if (!game.user.isGM || hostGM()?.id !== game.user.id) return;
  let saved = {};
  try { saved = game.settings.get(MODULE_ID, SETTING_SESSIONS) || {}; } catch { saved = {}; }
  for (const s of Object.values(saved)) {
    if (!s?.sid || sessions.has(s.sid)) continue;
    s.hostId = game.user.id; s.deadline = null; sessions.set(s.sid, s);
    if (s.match && s.match.phase !== "ended") decide(s);
  }
  if (sessions.size) { console.log(TAG, `restored ${sessions.size} duel session(s)`); pushStatus(); }
}

// ------------------------------------------------------------------ game flow
function clearTimers(s) { const r = rt(s.sid); clearTimeout(r.timer); r.timer = null; r.ai.forEach((t) => clearTimeout(t)); r.ai = [null, null]; }

function decide(s) {
  clearTimers(s); s.deadline = null;
  const M = E().Match, m = s.match;
  if (!m || m.phase === "ended") return;
  const r = rt(s.sid);
  s.seats.forEach((t, i) => {
    if (t.kind !== "ai" || !M.needs(m, i)) return;
    const [a, b] = [700, 1900];
    r.ai[i] = setTimeout(() => { if (s.match === m && M.needs(m, i)) submit(s, i, M.aiChoice(m, i, t.ai || { diff: "casual" })); }, a + Math.random() * (b - a));
  });
  // decision timer only when two humans play (v0.5: no timer against the AI)
  const humans = s.seats.filter((t) => t.kind === "human").length;
  if (humans === 2 && s.seats.some((t, i) => M.needs(m, i))) {
    s.deadline = Date.now() + CFG().TIMER * 1000;
    r.timer = setTimeout(() => {
      if (s.match !== m || m.phase === "ended") return;
      s.seats.forEach((t, i) => { if (t.kind === "human" && M.needs(m, i)) { notify(t.userId, "Time ran out — an automatic choice was made for you."); submit(s, i, M.autoChoice(m, i)); } });
    }, CFG().TIMER * 1000 + 250);
  }
}

async function startGame(s) {
  const teams = s.seats.map((t) => t.team);
  s.match = E().Match.create({ teams, names: s.seats.map((t) => t.name) });
  s.gameKey = uid(); s.reward = null;
  s.seats.forEach((t) => { t.next = false; t.lastTeam = t.team; });
  decide(s);
  broadcast(s, (v) => ({ t: "start", ...payload(s, v) }));
  pushStatus(); save();
}

async function onGameEnd(s) {
  clearTimers(s); s.deadline = null;
  E().Series.record(s.series, s.match.result);
  if (!s.series.over) return;
  s.over = true;
  if (s.kind === "npc" && s.series.winner === 0 && s.prize) {
    try { const a = game.actors.get(s.seats[0].actorId); const r = await grantCard(a, s.prize.cid); if (r.ok) s.reward = { cid: s.prize.cid, created: r.created }; }
    catch (e) { console.error(TAG, "ante reward", e); }
  }
}

async function submit(s, seat, choice) {
  const M = E().Match, m = s.match;
  if (!m) return;
  const r = M.submit(m, seat, choice);
  const t = s.seats[seat];
  if (!r.ok) { if (t.userId) { notify(t.userId, `That move isn't possible: ${r.error}.`, "warn"); toDuel(s, t.userId, { t: "state", ...payload(s, seat) }); } return; }
  if (!r.resolved) {
    for (const p of participants(s)) {
      if (p.viewer === seat) continue;
      const shown = p.viewer === 1 ? 1 - seat : seat;      // seat as that viewer sees it
      toDuel(s, p.uid, { t: "committed", seat: shown });
    }
    save(); return;
  }
  if (m.phase === "ended") await onGameEnd(s);
  decide(s);
  broadcast(s, (v) => ({ t: "reveal", res: E().View.resolvedForSeat(r.resolved, v), ...payload(s, v) }));
  if (s.over) pushStatus();
  save();
}

// ------------------------------------------------------------------ duel-window messages (team / commit / surrender / next / leave)
async function onDuel(s, userId, msg) {
  const seat = viewerOf(s, userId);
  if (msg.t === "hello") return sendInit(s, userId);
  if (seat === null) { if (msg.t === "leave") return dropSpectator(s, userId); return; }
  const t = s.seats[seat];
  switch (msg.t) {
    case "team": {
      if (s.match && s.match.phase !== "ended") return;
      const team = Array.isArray(msg.team) ? msg.team : [];
      const owned = ownedCards(game.actors.get(t.actorId));
      if (!E().isLegalTeam(team) || !team.every((c) => owned.includes(c))) { notify(userId, "That team isn't legal (three cards you own, within the budget).", "warn"); t.ready = false; return sendInit(s, userId); }
      t.team = team; t.ready = true;
      const o = s.seats[1 - seat]; if (o.userId) toDuel(s, o.userId, { t: "lobby", lobby: { oppReady: true } });
      if (s.seats.every((x) => x.ready)) await startGame(s);
      save(); return;
    }
    case "commit": return submit(s, seat, msg.choice);
    case "surrender": {
      if (!s.match || !E().Match.concede(s.match, seat)) return;
      await onGameEnd(s); decide(s);
      broadcast(s, (v) => ({ t: "state", ...payload(s, v) }));
      if (s.over) pushStatus();
      return save();
    }
    case "next": {
      if (s.series.over || !s.match || s.match.phase !== "ended") return;
      t.next = true;
      if (s.seats.every((x) => x.kind === "ai" || x.next)) await startGame(s);
      return save();
    }
    case "rematch": return rematch(s, seat);
    case "leave": return leave(s, seat, userId);
  }
}

// Rematch from the result screen: PvP waits for both players; against the AI it starts at once.
// Back to team select (last team preselected), a fresh series, the NPC prize re-checked (you may own it now).
async function rematch(s, seat) {
  if (!s.over || !s.series.over) return;
  const t = s.seats[seat], o = s.seats[1 - seat];
  if (t.left || !t.userId) return;
  t.rematch = true;
  if (o.kind === "human" && (!o.userId || o.left)) return toDuel(s, t.userId, { t: "rematch", me: true, opp: false, oppLeft: true });
  if (!s.seats.every((x) => x.kind === "ai" || x.rematch)) {
    toDuel(s, t.userId, { t: "rematch", me: true, opp: false });
    if (o.userId) toDuel(s, o.userId, { t: "rematch", me: false, opp: true });
    return;
  }
  clearTimers(s);
  s.over = false; s.match = null; s.gameKey = null; s.deadline = null; s.reward = null;
  s.series = E().Series.create(s.bestOf);
  for (const x of s.seats) { x.rematch = false; x.next = false; if (x.kind === "human") { x.ready = false; x.team = null; } }
  if (s.kind === "npc" && s.prize) { const a = game.actors.get(s.seats[0].actorId); if (a && ownedCards(a).includes(s.prize.cid)) s.prize = null; }
  for (const x of s.seats) if (x.userId) sendInit(s, x.userId);
  pushStatus(); save();
}

async function leave(s, seat, userId) {
  const t = s.seats[seat];
  if (!s.over) {
    if (s.match && s.match.phase !== "ended") { E().Match.concede(s.match, seat); await onGameEnd(s); }
    if (!s.series.over) { s.series.over = true; s.series.winner = 1 - seat; }
    s.over = true; clearTimers(s);
    const other = s.seats[1 - seat];
    if (other.userId) { notify(other.userId, `${t.name} left the duel.`); toDuel(s, other.userId, { t: "state", ...payload(s, 1 - seat) }); }
  }
  else { const other = s.seats[1 - seat]; if (other.userId && other.kind === "human") toDuel(s, other.userId, { t: "rematch", me: !!other.rematch, opp: false, oppLeft: true }); }
  send(userId, "close", {}, s.sid);
  t.userId = null; t.left = true;
  if (!s.seats.some((x) => x.userId)) closeSession(s);
  else { pushStatus(); save(); }
}
function dropSpectator(s, userId) {
  s.spectators = s.spectators.filter((u) => u !== userId);
  send(userId, "close", {}, s.sid);
  broadcast(s, () => ({ t: "spectators", n: s.spectators.length }));
  save();
}
function closeSession(s) {
  clearTimers(s); clearTimeout(rt(s.sid).inviteTimer);
  for (const p of participants(s)) send(p.uid, "close", {}, s.sid);
  sessions.delete(s.sid); runtime.delete(s.sid);
  pushStatus(); save();
}

// ------------------------------------------------------------------ creating sessions
function npcConfig(npcActor, practice) {
  const cfg = foundry.utils.deepClone(practice || npcActor?.getFlag?.(MODULE_ID, FLAG_DUELIST) || {});
  const teams = (Array.isArray(cfg.teams) ? cfg.teams : cfg.team ? [cfg.team] : []).filter((t) => E().isLegalTeam(t));
  cfg.team = teams.length ? teams[Math.floor(Math.random() * teams.length)] : E().randomTeam();
  cfg.bestOf = [1, 3, 5].includes(Number(cfg.bestOf)) ? Number(cfg.bestOf) : 1;
  cfg.ai = { diff: cfg.diff === "skilled" ? "skilled" : "casual", style: ["aggressive", "defensive", "trickster"].includes(cfg.style) ? cfg.style : null };
  return cfg;
}

async function createNpc(userId, { challengerActorId, npcActorId, npcTokenUuid, practice }) {
  const user = game.users.get(userId);
  const actor = game.actors.get(challengerActorId);
  if (!actor) return notify(userId, "Nobody to play with — no character found.", "warn");
  if (inSession(userId)) return notify(userId, "You're already in a card duel.", "warn");
  let npcActor = npcTokenUuid ? (fromUuidSync(npcTokenUuid)?.actor ?? null) : null;
  npcActor = npcActor || game.actors.get(npcActorId) || null;
  if (!npcActor && !practice) return notify(userId, "That challenger couldn't be found.", "warn");
  const cfg = npcConfig(npcActor, practice);
  if (!canPlay(ownedCards(actor))) { const given = await grantStarter(actor); if (given.length) notify(userId, `${actor.name} received a starter set of ${given.length} Fabula Arcana card${given.length > 1 ? "s" : ""}.`); }
  const prizeCid = cfg.prize && Catalog().CARDS[cfg.prize] && !ownedCards(actor).includes(cfg.prize) ? cfg.prize : null;
  const s = {
    sid: uid(), kind: "npc", hostId: game.user.id, createdAt: Date.now(), bestOf: cfg.bestOf, series: E().Series.create(cfg.bestOf),
    seats: [
      { userId, actorId: actor.id, name: actor.name, kind: "human", team: null, ready: false, next: false, lastTeam: null },
      { userId: null, actorId: npcActor?.id ?? null, name: practice?.name || npcActor?.name || "Challenger", kind: "ai", ai: cfg.ai, team: cfg.team, ready: true, next: true },
    ],
    spectators: [], match: null, gameKey: null, deadline: null, quote: cfg.quote || "",
    prize: prizeCid ? { cid: prizeCid, label: "Ante card", hint: cfg.bestOf > 1 ? "Win the series to take it." : "Win the duel to take it." } : null,
    npc: { actorId: npcActor?.id ?? null, tokenUuid: npcTokenUuid ?? null }, pending: false, over: false, reward: null,
  };
  sessions.set(s.sid, s);
  send(userId, "open", { role: "player", hostId: s.hostId }, s.sid);
  pushStatus(); save();
  console.log(TAG, `${user?.name} (${actor.name}) challenged ${s.seats[1].name}`);
}

async function createPvp(userId, { fromActorId, toActorId, bestOf }) {
  const from = game.actors.get(fromActorId), to = game.actors.get(toActorId);
  if (!from || !to) return notify(userId, "That player's character couldn't be found.", "warn");
  const target = game.users.find((u) => !u.isGM && u.active && u.character?.id === to.id)
    || game.users.find((u) => !u.isGM && u.active && to.testUserPermission(u, "OWNER"));
  if (!target) return notify(userId, `${to.name}'s player isn't online.`, "warn");
  if (target.id === userId) return;
  if (inSession(userId) || inSession(target.id)) return notify(userId, "One of you is already in a card duel.", "warn");
  if (blockedBy(target, userId)) return notify(userId, `${to.name} isn't taking challenges tonight.`);
  const bo = [1, 3, 5].includes(Number(bestOf)) ? Number(bestOf) : 1;
  const s = {
    sid: uid(), kind: "pvp", hostId: game.user.id, createdAt: Date.now(), bestOf: bo, series: E().Series.create(bo),
    seats: [
      { userId, actorId: from.id, name: from.name, kind: "human", team: null, ready: false, next: false, lastTeam: null },
      { userId: target.id, actorId: to.id, name: to.name, kind: "human", team: null, ready: false, next: false, lastTeam: null },
    ],
    spectators: [], match: null, gameKey: null, deadline: null, quote: "", prize: null, npc: null, pending: true, over: false, reward: null,
  };
  sessions.set(s.sid, s);
  send(target.id, "invite", { fromName: from.name, fromUser: userId, toName: to.name, bestOf: bo, img: from.img || "", expiresAt: Date.now() + INVITE_MS }, s.sid);
  notify(userId, `Challenge sent to ${to.name}.`);
  rt(s.sid).inviteTimer = setTimeout(() => {
    if (!sessions.get(s.sid)?.pending) return;
    sessions.delete(s.sid);
    send(target.id, "invite-close", { reason: "timeout" }, s.sid);
    notify(userId, `${to.name} didn't answer the challenge.`); send(userId, "invite-result", { ok: false }, s.sid);
  }, INVITE_MS + 400);
}

async function acceptPvp(s, userId) {
  if (!s?.pending || s.seats[1].userId !== userId) return;
  clearTimeout(rt(s.sid).inviteTimer);
  s.pending = false;
  send(s.seats[0].userId, "invite-result", { ok: true }, s.sid);
  for (const t of s.seats) {
    const a = game.actors.get(t.actorId);
    if (a && !canPlay(ownedCards(a))) { const g = await grantStarter(a); if (g.length) notify(t.userId, `${a.name} received a starter set of ${g.length} Fabula Arcana cards.`); }
  }
  for (const t of s.seats) send(t.userId, "open", { role: "player", hostId: s.hostId }, s.sid);
  pushStatus(); save();
}

// ------------------------------------------------------------------ install (every client registers; only the addressed host acts)
export function installHost() {
  on("challenge-npc", (d, env) => createNpc(env.from, d));
  on("challenge-pvp", (d, env) => createPvp(env.from, d));
  on("accept", (d, env) => acceptPvp(sessions.get(env.sid), env.from));
  on("decline", (d, env) => {
    const s = sessions.get(env.sid); if (!s?.pending) return;
    if (s.seats[1].userId !== env.from) return;
    notify(s.seats[0].userId, d.block ? `${s.seats[1].name} isn't taking challenges tonight.` : `${s.seats[1].name} declined the card duel.`);
    send(s.seats[0].userId, "invite-result", { ok: false }, s.sid);
    clearTimeout(rt(s.sid).inviteTimer); sessions.delete(s.sid);
  });
  on("duel-in", (d, env) => { const s = sessions.get(env.sid); if (!s) return send(env.from, "close", { reason: "gone" }, env.sid); return onDuel(s, env.from, d.msg || {}); });
  on("spectate", (d, env) => {
    const s = sessions.get(env.sid); if (!s || s.over) return notify(env.from, "That duel has ended."); if (s.pending) return notify(env.from, "That duel hasn't started yet.");
    if (viewerOf(s, env.from) !== null) return send(env.from, "open", { role: "player", hostId: s.hostId }, s.sid);
    if (!s.spectators.includes(env.from)) s.spectators.push(env.from);
    send(env.from, "open", { role: "spectator", hostId: s.hostId }, s.sid);
    broadcast(s, () => ({ t: "spectators", n: s.spectators.length })); save();
  });
  on("hello-client", (d, env) => {
    pushStatus(env.from);
    for (const s of sessions.values()) {
      if (s.over || s.pending) continue;
      const v = viewerOf(s, env.from);
      if (v !== null || s.spectators.includes(env.from)) send(env.from, "open", { role: v === null ? "spectator" : "player", hostId: s.hostId }, s.sid);
    }
  });
  Hooks.on("fabula.restPerformed", () => {
    if (!game.user.isGM || hostGM()?.id !== game.user.id) return;
    for (const u of game.users) if (u.getFlag(MODULE_ID, FLAG_BLOCK)) u.unsetFlag(MODULE_ID, FLAG_BLOCK).catch((e) => console.warn(TAG, "clear blocks", e));
  });
  on("cancel-all", (d, env) => { if (!game.users.get(env.from)?.isGM) return; for (const s of [...sessions.values()]) closeSession(s); });
}

// GM tool: end every duel (e.g. before a session ends)
export function closeAll() { for (const s of [...sessions.values()]) closeSession(s); }
