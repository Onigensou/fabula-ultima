// scripts/fabula-arcana/fa-client.js
// Every client: opens the duel window (a full-screen frame with assets/fabula-arcana/duel.html?net=1),
// relays messages between that window and the host, answers PvP invites, and keeps the duel status list
// (who is dueling — used for the overhead icon and the Watch button).
// While a duel window is open, this client's scene music is silenced locally (the duel has its own theme).

import { TAG, ASSET_BASE, MODULE_ID, FORGE, FLAG_BLOCK } from "./fa-const.js";
import { showInvitePanel } from "./fa-invite-ui.js";
import { send, on } from "./fa-net.js";

const W = { sid: null, hostId: null, role: null, el: null, frame: null, queue: [], ready: false, musicGain: null };
export const status = { sessions: [], hostId: null };
export const currentDuel = () => (W.sid ? { sid: W.sid, role: W.role } : null);

function deliver(msg) {
  const fn = W.frame?.contentWindow?.FA_NET?.receive;
  if (W.ready && fn) return fn(msg);
  W.queue.push(msg);
}

function vol() {
  const g = (k, d) => { try { return Number(game.settings.get("core", k)); } catch { return d; } };
  return { sfx: g("globalInterfaceVolume", 0.5) / 0.5, music: g("globalPlaylistVolume", 0.5) / 0.5 };
}

function muteMusic(on) {
  const gn = game.audio?.music?.gainNode ?? null;
  if (!gn?.gain) return;
  try {
    if (on) { if (W.musicGain === null) W.musicGain = gn.gain.value; gn.gain.setTargetAtTime(0, game.audio.music.currentTime, 0.25); }
    else if (W.musicGain !== null) { gn.gain.setTargetAtTime(W.musicGain, game.audio.music.currentTime, 0.6); W.musicGain = null; }
  } catch (e) { console.warn(TAG, "music duck", e); }
}

export function openWindow(sid, { role = "player", hostId } = {}) {
  if (W.sid === sid && W.el) return;
  closeWindow({ quiet: true });
  W.sid = sid; W.hostId = hostId; W.role = role; W.queue = []; W.ready = false;
  const el = document.createElement("div");
  el.id = "fabula-arcana-window";
  Object.assign(el.style, { position: "fixed", inset: "0", zIndex: "10000", background: "#1a0f06", display: "flex" });
  const frame = document.createElement("iframe");
  frame.src = `${ASSET_BASE}duel.html?net=1&sid=${encodeURIComponent(sid)}`;
  frame.title = "Fabula Arcana";
  Object.assign(frame.style, { border: "0", width: "100%", height: "100%", background: "#1a0f06" });
  frame.setAttribute("allow", "autoplay");
  el.appendChild(frame);
  document.body.appendChild(el);
  W.el = el; W.frame = frame;
  muteMusic(true);
  Hooks.callAll("fabulaArcanaWindow", { open: true, sid, role });
}

export function closeWindow({ quiet = false } = {}) {
  if (!W.el) { W.sid = null; return; }
  W.el.remove();
  const sid = W.sid;
  W.el = null; W.frame = null; W.sid = null; W.ready = false; W.queue = [];
  muteMusic(false);
  if (!quiet) Hooks.callAll("fabulaArcanaWindow", { open: false, sid });
}

// The duel page calls window.parent.FabulaArcanaBridge.fromDuel(msg)
window.FabulaArcanaBridge = {
  fromDuel(msg) {
    if (!W.sid || !msg) return;
    if (msg.t === "hello") {
      W.ready = true;
      const q = W.queue.splice(0); for (const m of q) deliver(m);
    }
    send(W.hostId, "duel-in", { msg }, W.sid);
    if (msg.t === "leave") closeWindow();
  },
};

export function installClient() {
  on("open", (d, env) => openWindow(env.sid, { role: d.role, hostId: d.hostId ?? env.from }));
  on("duel", (d, env) => {
    if (env.sid !== W.sid) return;
    const msg = d.msg || {};
    if (msg.t === "init") msg.vol = vol();
    deliver(msg);
  });
  on("close", (d, env) => { if (env.sid === W.sid) closeWindow(); });
  on("status", (d) => { status.sessions = d.sessions || []; status.hostId = d.hostId || null; Hooks.callAll("fabulaArcanaStatus", status.sessions); });
  on("notify", (d) => ui.notifications?.[d.level === "warn" ? "warn" : "info"]?.(`Fabula Arcana | ${d.text}`));
  // PvP challenge: our own panel with a countdown (fa-invite-ui.js). It closes itself when the time runs out;
  // the host also withdraws it ("invite-close") so a late click can never answer a dead challenge.
  on("invite", (d, env) => {
    invite = { sid: env.sid, host: env.from };
    const ms = Math.max(3000, (Number(d.expiresAt) || Date.now() + 20000) - Date.now());
    invite.panel = showInvitePanel({
      fromName: d.fromName, toName: d.toName, bestOf: d.bestOf, img: d.img || "", ms, sound: playUi,
      onAnswer: async (answer) => {
        const mine = invite?.sid === env.sid; if (mine) invite = null;
        if (answer === "timeout") return;                  // the host times it out on its side too
        if (answer === "block") await blockUser(d.fromUser);
        send(env.from, answer === "accept" ? "accept" : "decline", { block: answer === "block" }, env.sid);
      },
    });
  });
  on("invite-close", (d, env) => { if (invite?.sid === env.sid) { invite.panel?.close(d.reason || "closed"); invite = null; } });
  // the challenger hears the answer
  on("invite-result", (d) => playUi(d.ok ? "accept" : "decline"));
}

let invite = null;

// UI sounds outside the duel window (challenge panel), at the player's interface volume
const UI_SFX = {
  appear: "Sound/Soundboard/Bell3.ogg",
  accept: "Sound/Soundboard/Item1.ogg",
  decline: "Sound/Soundboard/Down1.ogg",
  timeout: "Sound/Soundboard/Down1.ogg",
  cursor: "Sound/BattleCursor_2.wav",
};
export function playUi(key) {
  const p = UI_SFX[key]; if (!p) return;
  try {
    const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    const v = Number(game.settings.get("core", "globalInterfaceVolume") ?? 0.5);
    AH?.play({ src: FORGE + p, volume: Math.min(1, 0.9 * v + 0.1), autoplay: true, loop: false }, false);
  } catch (e) { console.warn(TAG, "ui sound", key, e); }
}

// "Block tonight": no more challenges from that player until the party rests (cleared by the GM on fabula.restPerformed)
async function blockUser(userId) {
  if (!userId || game.users.get(userId)?.isGM) return;
  try { await game.user.setFlag(MODULE_ID, FLAG_BLOCK, { ...(game.user.getFlag(MODULE_ID, FLAG_BLOCK) || {}), [userId]: Date.now() }); }
  catch (e) { console.warn(TAG, "block", e); }
}
