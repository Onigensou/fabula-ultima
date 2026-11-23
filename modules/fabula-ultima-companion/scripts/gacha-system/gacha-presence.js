// ============================================================================
// Gacha System — "At the machine" roster
// ----------------------------------------------------------------------------
// Who has the machine open right now, for the small portraits in the console.
// Ephemeral and presentation-only, like the shop's "who's browsing" roster
// (shop-system/shopPresence.js): nothing is persisted, nothing is written, so
// there is no GM gate and every client just keeps its own copy.
//
//   enter   I opened the machine          → everyone adds me; anyone already
//                                           there answers "here" so I learn them
//   here    reply to an enter
//   select  I moved to another banner      (kept for a future "looking at" hint)
//   leave   I closed the machine
// ============================================================================

import { sendPresence } from "./gacha-net.js";

const roster = new Map();   // userId -> { bannerId }
const subs = new Set();
let iAmHere = false;

const notify = () => { for (const cb of subs) { try { cb(); } catch (e) { console.error("[FU][Gacha] presence sub", e); } } };

export function onPresence(msg) {
  const { op, userId } = msg ?? {};
  if (!userId) return;
  if (op === "enter" || op === "here" || op === "select") roster.set(userId, { bannerId: msg.bannerId ?? null });
  if (op === "leave") roster.delete(userId);
  // Someone new walked up: let them know I'm here too.
  if (op === "enter" && iAmHere && userId !== game.user.id) sendPresence("here", { bannerId: roster.get(game.user.id)?.bannerId ?? null });
  notify();
}

export function enter(bannerId) { iAmHere = true; sendPresence("enter", { bannerId }); }
export function select(bannerId) { if (iAmHere) sendPresence("select", { bannerId }); }
export function leave() { if (!iAmHere) return; iAmHere = false; sendPresence("leave"); }

/** User ids at the machine, me first, then by join order. Offline users drop out. */
export function here() {
  const ids = [...roster.keys()].filter((id) => game.users?.get(id)?.active);
  ids.sort((a, b) => (a === game.user.id ? -1 : b === game.user.id ? 1 : 0));
  return ids;
}

export function subscribe(cb) { subs.add(cb); return () => subs.delete(cb); }

Hooks.on("userConnected", (user, connected) => {
  if (!connected && roster.delete(user?.id)) notify();
});
