// ============================================================================
// Party Talk — network
// ----------------------------------------------------------------------------
// One socket message per line, one per "typing" change. Every client runs its
// own queue (party-talk-ui.js), so there is no host, no GM relay and nothing to
// de-duplicate. Foundry does not echo a socket message back to its sender, so
// send() also delivers locally.
//
//   { type: MSG_TYPE, kind: "line",   line: { id, userId, mode, text, ts, speaker } }
//   { type: MSG_TYPE, kind: "typing", userId, on, speaker }
//
// Who may talk is checked on the RECEIVING side too (senderMayTalk): a party
// player may only speak as their own character; only a GM may speak as anyone
// or as the narrator. Spectators never talk.
// ============================================================================

import { SOCKET_CHANNEL, MSG_TYPE } from "./party-talk-core.js";

const TAG = "[ONI][PartyTalk][net]";
const listeners = new Set();

/** Subscribe to Party Talk messages. Returns an unsubscribe function. */
export function onTalkMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function deliver(msg) {
  for (const fn of [...listeners]) {
    try { fn(msg); } catch (e) { console.warn(TAG, "listener threw", e); }
  }
}

/** Broadcast to every client, this one included. */
export function sendTalk(kind, data) {
  const msg = { type: MSG_TYPE, kind, ...data };
  try { game.socket.emit(SOCKET_CHANNEL, msg); } catch (e) { console.warn(TAG, "emit failed", e); }
  deliver(msg);
}

const spectatorApi = () => globalThis.FUCompanion?.api?.Spectator ?? null;

/** Is this user someone who gets a text box (GM or party player)? */
export function userMayTalk(user) {
  if (!user) return false;
  if (user.isGM) return true;
  const S = spectatorApi();
  if (S?.isParticipant) return !!S.isParticipant(user);
  return !!user.character;   // no spectator helper loaded: a linked character is enough
}

/** May `userId` say a line as `speaker`? */
export function senderMayTalk(userId, speaker) {
  const user = game.users?.get(userId);
  if (!userMayTalk(user)) return false;
  if (user.isGM) return true;
  if (speaker?.narrator) return false;
  return !!speaker?.actorId && speaker.actorId === user.character?.id;
}

Hooks.once("ready", () => {
  game.socket.on(SOCKET_CHANNEL, (msg) => {
    if (msg?.type !== MSG_TYPE) return;
    deliver(msg);
  });
});
