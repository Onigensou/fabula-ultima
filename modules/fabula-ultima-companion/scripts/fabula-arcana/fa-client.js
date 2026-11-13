// scripts/fabula-arcana/fa-client.js
// Every client: opens the duel window (a full-screen frame with assets/fabula-arcana/duel.html?net=1),
// relays messages between that window and the host, answers PvP invites, and keeps the duel status list
// (who is dueling — used for the overhead icon and the Watch button).
// While a duel window is open, this client's scene music is silenced locally (the duel has its own theme).

import { TAG, ASSET_BASE } from "./fa-const.js";
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
    send(W.hostId, "duel", { msg }, W.sid);
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
  on("invite", async (d, env) => {
    const bo = Number(d.bestOf) > 1 ? ` (best of ${d.bestOf})` : "";
    let yes = false;
    try {
      yes = await Dialog.confirm({
        title: "Fabula Arcana",
        content: `<p><strong>${foundry.utils.escapeHTML?.(d.fromName) ?? d.fromName}</strong> challenges ${foundry.utils.escapeHTML?.(d.toName) ?? d.toName} to a card duel${bo}.</p><p>Accept?</p>`,
        defaultYes: true,
      });
    } catch { yes = false; }
    send(env.from, yes ? "accept" : "decline", {}, env.sid);
  });
}
