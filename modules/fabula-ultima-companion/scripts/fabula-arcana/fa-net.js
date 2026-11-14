// scripts/fabula-arcana/fa-net.js
// Socket transport. Every message is addressed: { type: MSG, op, from, to, sid, data }.
//   to = a user id (only that client acts) or null (everyone). A message to yourself is delivered locally
//   (Foundry never echoes a socket emit back to its sender).
//
// Ops — client → host:  hello-client, challenge-npc, challenge-pvp, accept, decline, duel-in (duel window → host), spectate, cancel-all
//       host → client:  open, duel (host → duel window), close, invite, invite-close, invite-result, status, notify
//       duel-window messages from the host include opp-away / opp-back / opp-gone (PvP disconnect grace, fa-host.js)
// One handler per op: the GM client is both host and player, so the two directions must not share a name.

import { SOCKET, MSG, TAG } from "./fa-const.js";

const handlers = new Map();
export const on = (op, fn) => { if (handlers.has(op)) console.warn(TAG, `socket op "${op}" registered twice — the later handler wins`); handlers.set(op, fn); };

function dispatch(env) {
  if (!env || env.type !== MSG) return;
  if (env.to && env.to !== game.user.id) return;
  const fn = handlers.get(env.op);
  if (!fn) return;
  Promise.resolve().then(() => fn(env.data ?? {}, env)).catch((e) => console.error(TAG, `handler ${env.op}`, e));
}

export function send(to, op, data = {}, sid = null) {
  const env = { type: MSG, op, from: game.user.id, to: to ?? null, sid, data };
  if (to === game.user.id) return dispatch(env);
  game.socket.emit(SOCKET, env);
  if (to === null) dispatch(env);   // broadcasts reach this client too
}

export function install() {
  game.socket.on(SOCKET, dispatch);
}
