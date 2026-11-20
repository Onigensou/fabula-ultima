// ============================================================================
// System Tutorial — named tutorials, and showing one to the whole table.
//
// Any system registers its pages once (e.g. fa-boot.js registers
// "fabula-arcana"); the card itself is system-tutorial-panel.js.
//
// API: FUCompanion.api.systemTutorial
//   .register(id, { kicker, title, accent, aspect, pages:[{ image, text }] })
//   .get(id) / .list()                        → [{ id, title }]
//   .open(id)                                 this screen only (returns false if unknown)
//   .showToEveryone(id, { waitFor })          GM: opens it on every connected screen and
//                                             resolves when the user `waitFor` (normally the
//                                             Main Controller) closes theirs — Done or Close.
//                                             If that user is offline (or is the GM) the GM's
//                                             own card counts. Everyone else's closes with it.
//   .closeEverywhere()                        GM: close the card on every screen (event aborted)
//
// Event row: "Show Tutorial" (event-system/event-rows-tutorial.js).
// ============================================================================

import { openTutorialPanel, closeTutorialPanel, isTutorialPanelOpen } from "./system-tutorial-panel.js";

const NS = "fabula-ultima-companion";
const TAG = "[FU][SystemTutorial]";
const SOCKET = `module.${NS}`;
const MSG = "ONI_SYSTEM_TUTORIAL_V1";

const registry = new Map();
const pending = new Map();      // GM: reqId → { resolve, waitFor }
let shownReq = null;            // the request this screen's card belongs to (null = opened locally)

export function registerTutorial(id, def) {
  if (!id || !def) return;
  registry.set(String(id), { kicker: "Tutorial", accent: "#b3261e", aspect: "16 / 9", ...def, pages: [...(def.pages ?? [])] });
}
export const getTutorial = (id) => registry.get(String(id)) ?? null;
export const listTutorials = () => [...registry.entries()].map(([id, d]) => ({ id, title: d.title || id }));

function openLocal(id, { reqId = null, onClose = null } = {}) {
  const def = getTutorial(id);
  if (!def) { console.warn(TAG, `unknown tutorial "${id}"`); return false; }
  shownReq = reqId;
  return openTutorialPanel({ ...def, onClose: (reason) => { if (shownReq === reqId) shownReq = null; onClose?.(reason); } });
}

export const openTutorial = (id) => openLocal(id);

const emit = (data) => { try { game.socket.emit(SOCKET, { type: MSG, ...data }); } catch (e) { console.error(TAG, "socket", e); } };
const activeUser = (id) => !!id && !!game.users.get(id)?.active;

/** The user whose close ends a request: the waited-for player if they're online, else the GM. */
function countsFor(userId, waitFor) {
  if (activeUser(waitFor) && !game.users.get(waitFor)?.isGM) return userId === waitFor;
  return !!game.users.get(userId)?.isGM;
}

function finish(reqId, reason, by) {
  const p = pending.get(reqId);
  if (!p) return;
  pending.delete(reqId);
  emit({ op: "close", reqId });
  if (shownReq === reqId) closeTutorialPanel({ silent: false, reason: "forced" });
  console.log(TAG, `"${p.id}" finished (${reason}) by ${game.users.get(by)?.name ?? by}`);
  p.resolve({ reason, by });
}

/** GM: show a tutorial on every connected screen; resolves once the waited-for user closes it. */
export function showTutorialToEveryone(id, { waitFor = null } = {}) {
  if (!game.user?.isGM) return Promise.reject(new Error(`${TAG} GM only.`));
  if (!getTutorial(id)) return Promise.resolve({ reason: "unknown" });
  const reqId = foundry.utils.randomID(12);
  return new Promise((resolve) => {
    pending.set(reqId, { resolve, waitFor, id });
    emit({ op: "open", reqId, id, waitFor });
    openLocal(id, { reqId, onClose: (reason) => { if (reason !== "forced" && countsFor(game.user.id, waitFor)) finish(reqId, reason, game.user.id); } });
  });
}

/** GM: close every screen's card (and settle any request that was waiting). */
export function closeTutorialEverywhere() {
  for (const reqId of [...pending.keys()]) finish(reqId, "aborted", game.user.id);
  emit({ op: "close", reqId: null });
  if (isTutorialPanelOpen()) closeTutorialPanel({ silent: true, reason: "forced" });
}

function onSocket(msg) {
  if (!msg || msg.type !== MSG) return;
  if (msg.op === "open") {
    const { reqId, id, waitFor } = msg;
    openLocal(id, { reqId, onClose: (reason) => {
      if (reason === "forced") return;
      if (countsFor(game.user.id, waitFor)) emit({ op: "done", reqId, reason, by: game.user.id });
    } });
  } else if (msg.op === "close") {
    if (msg.reqId === null || msg.reqId === shownReq) { if (isTutorialPanelOpen() && shownReq !== null) closeTutorialPanel({ silent: false, reason: "forced" }); }
  } else if (msg.op === "done") {
    if (game.user.isGM && pending.has(msg.reqId) && countsFor(msg.by, pending.get(msg.reqId).waitFor)) finish(msg.reqId, msg.reason, msg.by);
  }
}

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  // the waited-for player dropped out mid-tutorial: don't leave the table stuck on it
  Hooks.on("userConnected", (user, connected) => {
    if (connected || !game.user.isGM) return;
    for (const [reqId, p] of [...pending]) if (p.waitFor === user?.id) finish(reqId, "left", user.id);
  });
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.systemTutorial = {
    register: registerTutorial, get: getTutorial, list: listTutorials,
    open: openTutorial, close: () => closeTutorialPanel({ reason: "closed" }),
    showToEveryone: showTutorialToEveryone, closeEverywhere: closeTutorialEverywhere,
  };
});
