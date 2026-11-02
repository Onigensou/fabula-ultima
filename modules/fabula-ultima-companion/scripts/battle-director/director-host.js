// Battle Director — explicit host.
//
// The director's FSM runs on exactly one GM client: the one holding
// director-boot's `_instance`. The MAIN GM hosts (the highest-ranked GM online,
// core's `activeGM`): an assistant GM's start() is sent to the main GM's client
// when it is online, and when the hosting GM disconnects the highest-ranked GM
// left takes the saved battle over in place (director-boot; report
// 2026-11-01-bd-host-should-be-main-gm). An assistant GM alone still hosts, and
// a GM who logs in after the host started becomes primary WITHOUT hosting (no
// mid-battle hand-off). So "the primary GM" is still not "the host", and
// callers must not guess. Guessing caused:
//   - a SECOND director: auto-resume on `ready` was gated on isPrimaryGM(), so
//     a primary GM that loaded while another GM was hosting mounted its own
//     FSM from the same saved state. Two FSMs then sent two Opportunity offers
//     to one player (the first wheel orphaned, its host stalled 120 s, the GM
//     mirrors followed the wrong wheel) — and everything else twice;
//   - GM-desk Turn/Round and the menu-replay hello aimed at a GM that might
//     not be hosting.
//
// Here the host is explicit. The host announces itself; every client keeps the
// last announcement; a GM that wants to resume asks first and claims only when
// nobody answers. Two GMs claiming at once (both loading at the same moment)
// settle by core's activeGM order — higher role, then lower user id — so the
// main GM wins a tie.
//
// Messages (ns "bd-host" on the module socket; Foundry never echoes a socket
// emit to its sender):
//   HOST     { userId, claim }  "I host" — on start/resume, reconnect, and in
//                               answer to QUERY. claim:true while still deciding.
//   RELEASED { userId }         the host stopped
//   QUERY    { fromUserId }     "who hosts?"

import { log, warn } from "./logger.js";

const NS = "bd-host";
const CHANNEL = "module.fabula-ultima-companion";
const PROBE_MS = 1500;        // how long a QUERY waits for a host to answer
const CLAIM_SETTLE_MS = 500;  // how long a claim waits for a competing claim

let _installed = false;
let _isHosting = () => false;  // director-boot: () => !!_instance
let _claiming = false;
let _claimLost = false;
// Claim won, director not mounted yet (resume is async — seconds). Still
// answers as host so a GM probing in that gap does not claim too.
let _mounting = false;
let _mountingTimer = null;
const MOUNT_TIMEOUT_MS = 30_000;
let _knownHostId = null;
const _probeWaiters = new Set();
const _hostLostListeners = new Set();
const _conflictWarned = new Set();

function emit(event, payload = {}) {
  try { game.socket?.emit(CHANNEL, { ns: NS, event, payload }); }
  catch (e) { warn("[BD host] emit failed", e); }
}

// Core's activeGM order: higher role first, then lower id.
function outranks(a, b) {
  if (!a) return false;
  if (!b) return true;
  if ((a.role ?? 0) !== (b.role ?? 0)) return (a.role ?? 0) > (b.role ?? 0);
  return String(a.id) < String(b.id);
}

function hosting() { return _mounting || !!_isHosting(); }
function iHost() { return _claiming || hosting(); }

function onSocket(data) {
  if (!data || data.ns !== NS) return;
  const p = data.payload ?? {};
  switch (data.event) {
    case "HOST": {
      if (!p.userId || p.userId === game.user?.id) return;
      if (_claiming) {
        // Still deciding. An established host always wins; between two
        // claimers the higher-ranked GM keeps it (the other backs off on ours).
        if (!p.claim || outranks(game.users?.get(p.userId), game.user)) _claimLost = true;
        else return;
      } else if (hosting()) {
        // Someone is claiming what we already host: answer so they back off.
        if (p.claim) { emit("HOST", { userId: game.user.id, claim: false }); return; }
        warnConflict(p.userId);
      }
      _knownHostId = p.userId;
      for (const w of _probeWaiters) w(p.userId);
      return;
    }
    case "RELEASED":
      if (p.userId && p.userId === _knownHostId) _knownHostId = null;
      return;
    case "QUERY":
      if (iHost()) emit("HOST", { userId: game.user.id, claim: _claiming });
      return;
    default:
      return;
  }
}

// Safety net — should not happen once every mount goes through claim(), but if
// two FSMs ever run, say so instead of letting them race quietly.
function warnConflict(otherId) {
  if (_conflictWarned.has(otherId)) return;
  _conflictWarned.add(otherId);
  const name = game.users?.get(otherId)?.name ?? otherId;
  warn(`[BD host] CONFLICT — ${name} is also hosting this battle. Two directors are running.`);
  ui.notifications?.error(`Battle Director: ${name} is also hosting this battle. Reload one GM client — it will rejoin as a spectator of the other's battle.`, { permanent: true });
}

export function installDirectorHost({ isHosting } = {}) {
  if (typeof isHosting === "function") _isHosting = isHosting;
  if (_installed || !game.socket) return;
  game.socket.on(CHANNEL, onSocket);
  // A host that disconnected is not hosting any more (it reloaded, or left).
  Hooks.on("userConnected", (user, connected) => {
    if (!connected && user?.id === _knownHostId) {
      log(`[BD host] host ${user.name} disconnected`);
      _knownHostId = null;
      for (const fn of _hostLostListeners) { try { fn(user); } catch (e) { warn("[BD host] host-lost listener threw", e); } }
    }
  });
  // A socket blip drops our announcement on clients that loaded meanwhile.
  game.socket.on("connect", () => { if (hosting()) emit("HOST", { userId: game.user.id, claim: false }); });
  _installed = true;
  if (game.user?.isGM) probeHost().catch(() => {});   // learn a running host early
}

/** Run `fn(user)` when the hosting GM disconnects (director-boot takes over). */
export function onHostLost(fn) { if (typeof fn === "function") _hostLostListeners.add(fn); }

/** The main GM: the highest-ranked GM online (core's activeGM order). */
export function mainGM() {
  const core = game.users?.activeGM;
  if (core) return core;
  let best = null;
  for (const u of game.users ?? []) if (u.isGM && u.active && outranks(u, best)) best = u;
  return best;
}

/** The hosting user's id, or null when nobody is known to host. */
export function hostUserId() {
  if (hosting()) return game.user?.id ?? null;
  if (_knownHostId && game.users?.get(_knownHostId)?.active) return _knownHostId;
  return null;
}
export function hostUser() { const id = hostUserId(); return id ? game.users?.get(id) ?? null : null; }
export function amHost() { return !!_isHosting(); }
/** This client won (or is winning) a claim and is mounting the saved battle. */
export function mountingLocally() { return _claiming || _mounting; }

/** Ask who hosts. Resolves with the host's user id, or null if nobody answers. */
export function probeHost(timeoutMs = PROBE_MS) {
  if (_isHosting()) return Promise.resolve(game.user.id);
  return new Promise((resolve) => {
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      _probeWaiters.delete(finish);
      clearTimeout(timer);
      resolve(id ?? null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    _probeWaiters.add(finish);
    emit("QUERY", { fromUserId: game.user?.id ?? null });
  });
}

/**
 * Become the host if nobody else is. Probe → claim → wait for a competing
 * claim → decide. Returns true when this client should mount the director.
 */
export async function claimHost() {
  if (!game.user?.isGM) return false;
  if (_isHosting()) return true;
  const existing = await probeHost();
  if (existing && existing !== game.user.id) {
    log(`[BD host] ${game.users?.get(existing)?.name ?? existing} is hosting — not claiming`);
    return false;
  }
  if (_isHosting()) return true;   // a local start() landed during the probe; resume will skip
  _claiming = true;
  _claimLost = false;
  emit("HOST", { userId: game.user.id, claim: true });
  await new Promise((r) => setTimeout(r, CLAIM_SETTLE_MS));
  _claiming = false;
  if (_claimLost) {
    log(`[BD host] claim lost to ${game.users?.get(_knownHostId)?.name ?? _knownHostId}`);
    return false;
  }
  _mounting = true;
  clearTimeout(_mountingTimer);
  _mountingTimer = setTimeout(abandonClaim, MOUNT_TIMEOUT_MS);
  return true;
}

/** A won claim whose mount failed — stop answering as host. */
export function abandonClaim() {
  clearTimeout(_mountingTimer);
  if (!_mounting) return;
  _mounting = false;
  if (!_isHosting()) emit("RELEASED", { userId: game.user?.id });
}

/** Called once this client holds the director. */
export function announceHost() {
  clearTimeout(_mountingTimer);
  _mounting = false;
  _knownHostId = game.user?.id ?? null;
  emit("HOST", { userId: game.user?.id, claim: false });
  log(`[BD host] hosting (${game.user?.name})`);
}

/** Called once this client no longer holds the director. */
export function releaseHost() {
  clearTimeout(_mountingTimer);
  _mounting = false;
  if (_knownHostId === game.user?.id) _knownHostId = null;
  _conflictWarned.clear();
  emit("RELEASED", { userId: game.user?.id });
}

export function hostInfo() {
  const u = hostUser();
  return { hostUserId: u?.id ?? null, hostName: u?.name ?? null, amHost: amHost(), claiming: _claiming };
}
