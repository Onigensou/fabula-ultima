// ============================================================================
// Ritual System — shared-window sessions (v1.5).
//
// The performer's setup window is still the ONLY place a ritual is edited. A
// "session" is that window's draft, published so a GM can watch it live:
//
//   performer  → SESSION_OPEN   (a full snapshot: who, and the whole spec)
//              → SESSION_PATCH   (every subsequent edit; throttled)
//              → SESSION_CLOSE   (abandoned or performed)
//   GM (attach)→ SESSION_SYNC_REQ …and the performer answers
//   performer  → SESSION_SYNC    (a fresh snapshot, for the late joiner)
//
// Nothing here is writable by a spectator, so none of it is activeGM-gated —
// two GMs each keep their own mirror and neither can corrupt the other. That
// is the whole reason v1.5 dodges the dual-GM dedupe trap that guards CAST_REQ.
//
// This module owns BOTH ends because they never run in the same client: the
// performer publishes, everyone else registers. Emitting goes straight out on
// game.socket (like ritual-feedback.js) so this file imports no socket module
// and closes no cycle; ritual-socket.js imports the handlers below and routes
// the five topics into them.
// ============================================================================

import {
  RITUAL_TAG, RITUAL_CHANNEL, RITUAL_SOCKET, RITUAL_PATCH_THROTTLE_MS,
} from "./ritual-const.js";

// ── Performer side: the local, published draft ──────────────────────────────
let _local = null;          // { sessionId, userId, performerUuid, performerName, performerImg }
let _throttleTimer = null;
let _pendingPatch = null;

function _emit(type, payload) {
  try {
    game.socket.emit(RITUAL_CHANNEL, { type, payload });
  } catch (e) {
    console.warn(RITUAL_TAG, "session emit failed", type, e);
  }
}

/** Clone the parts of a spec that travel — material is a flat display object. */
function _cloneSpec(spec) {
  return { ...spec, material: spec?.material ? { ...spec.material } : null };
}

/**
 * Begin publishing the performer's window. `snapshot` carries the identity
 * fields plus the initial spec and focused row; it is sent verbatim as the
 * SESSION_OPEN payload and answers the first sync.
 */
export function openLocalSession(snapshot) {
  _local = {
    sessionId: snapshot.sessionId,
    userId: game.user.id,
    performerUuid: snapshot.performerUuid,
    performerName: snapshot.performerName,
    performerImg: snapshot.performerImg,
  };
  _emit(RITUAL_SOCKET.SESSION_OPEN, _fullSnapshot(snapshot.spec, snapshot.row, false));
}

/** Publish an edit. Throttled trailing so a keystroke stream coalesces. */
export function patchLocalSession({ spec, row, casting = false, dir = 0 }) {
  if (!_local) return;
  _pendingPatch = { spec, row, casting, dir };
  if (_throttleTimer) return;                       // a trailing emit is already queued
  _flushPatch();                                    // leading edge: emit now
  _throttleTimer = setTimeout(() => {
    _throttleTimer = null;
    if (_pendingPatch) _flushPatch();               // trailing edge: latest state
  }, RITUAL_PATCH_THROTTLE_MS);
}

function _flushPatch() {
  if (!_local || !_pendingPatch) return;
  const { spec, row, casting, dir } = _pendingPatch;
  _pendingPatch = null;
  _emit(RITUAL_SOCKET.SESSION_PATCH, {
    sessionId: _local.sessionId,
    spec: _cloneSpec(spec),
    row, casting, dir,
  });
}

/** Stop publishing. `reason`: "cancel" | "perform" | "replace". */
export function closeLocalSession(reason = "cancel") {
  if (!_local) return;
  if (_throttleTimer) { clearTimeout(_throttleTimer); _throttleTimer = null; }
  _pendingPatch = null;
  const sessionId = _local.sessionId;
  _local = null;
  _emit(RITUAL_SOCKET.SESSION_CLOSE, { sessionId, reason });
}

function _fullSnapshot(spec, row, casting) {
  return {
    sessionId: _local.sessionId,
    userId: _local.userId,
    performerUuid: _local.performerUuid,
    performerName: _local.performerName,
    performerImg: _local.performerImg,
    spec: _cloneSpec(spec),
    row, casting,
  };
}

// ── Spectator side: the registry of live sessions ───────────────────────────
const _sessions = new Map();        // sessionId → snapshot
const _subs = new Set();            // (event, session) => void ; event: open|patch|close|sync
let _reaper = null;

function _notify(event, session) {
  for (const fn of _subs) {
    try { fn(event, session); } catch (e) { console.warn(RITUAL_TAG, "session subscriber threw", e); }
  }
}

/** Subscribe to session lifecycle. Returns an unsubscribe fn. */
export function subscribeSessions(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

export function getSessions() { return [..._sessions.values()]; }
export function getSession(id) { return _sessions.get(id) ?? null; }

/** Ask the performer of `sessionId` for a fresh snapshot (late-join). */
export function requestSync(sessionId) {
  _emit(RITUAL_SOCKET.SESSION_SYNC_REQ, { sessionId, requesterId: game.user.id });
}

// A performer who leaves between opening a session and a GM clicking its pip
// never sends SESSION_CLOSE, so nobody would retract the pip. Poll the user's
// connection while any session is live and reap the orphans.
function _ensureReaper() {
  if (_reaper || !_sessions.size) return;
  _reaper = setInterval(() => {
    for (const [id, s] of _sessions) {
      if (!game.users?.get(s.userId)?.active) _dropSession(id, "gone");
    }
    if (!_sessions.size && _reaper) { clearInterval(_reaper); _reaper = null; }
  }, 4000);
}

function _dropSession(id, reason) {
  const s = _sessions.get(id);
  if (!s) return;
  _sessions.delete(id);
  _notify("close", { ...s, closeReason: reason });
}

function _upsert(payload, event) {
  if (!payload?.sessionId) return;
  // A patch for a session we never saw open (we joined the table mid-ritual):
  // treat it as an open so the pip still appears, and ask for a full snapshot.
  const known = _sessions.get(payload.sessionId);
  const merged = { ...(known ?? {}), ...payload };
  _sessions.set(payload.sessionId, merged);
  _ensureReaper();
  _notify(event, merged);
  if (!known && event === "patch") requestSync(payload.sessionId);
}

// ── Socket handlers (called by ritual-socket.js) ────────────────────────────
export function handleSessionOpen(payload)  { _upsert(payload, "open"); }
export function handleSessionPatch(payload)  { _upsert(payload, "patch"); }
export function handleSessionSync(payload)   { _upsert(payload, "sync"); }

export function handleSessionClose(payload) {
  if (payload?.sessionId) _dropSession(payload.sessionId, payload.reason ?? "cancel");
}

/** Performer answers a late joiner's sync request. */
export function handleSessionSyncReq(payload) {
  if (!_local || payload?.sessionId !== _local.sessionId) return;
  // Re-publish current state. The window supplies it through the accessor it
  // registered at open; falling back to the last snapshot keeps us honest if
  // the window somehow closed first.
  const live = _localStateAccessor?.();
  if (live) _emit(RITUAL_SOCKET.SESSION_SYNC, _fullSnapshot(live.spec, live.row, live.casting));
}

// The window hands us a getter for its live { spec, row, casting } so a sync
// reply reflects the exact current state, not a stale copy. Set at open,
// cleared at close.
let _localStateAccessor = null;
export function setLocalStateAccessor(fn) { _localStateAccessor = fn; }

console.debug(RITUAL_TAG, "session layer loaded");
