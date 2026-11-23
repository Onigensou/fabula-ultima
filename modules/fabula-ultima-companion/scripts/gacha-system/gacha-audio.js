// ============================================================================
// Gacha System — Local machine music
// ----------------------------------------------------------------------------
// The machine opens over whatever map is loaded, so its theme is LOCAL: only
// the client that has the machine open (or is watching a reveal) hears the
// scene's audio duck. Nobody else's music changes.
//
// Same duck as the Fabula Arcana duel window (fa-client.js muteMusic): ramp the
// playlist channels' gain nodes down and back up. Both the music and the
// environment channels are ducked — camp maps play ambience (Drips) on the
// latter. The theme itself is a plain HTMLAudioElement, so it is never caught
// by that duck; its volume follows the player's Music volume setting.
//
// Reference-counted by reason ("machine", "watch") so a watcher who opens the
// machine mid-reveal, or a roller whose reveal ends while the machine is still
// open, never restores the scene music too early.
// ============================================================================

import { BGM_SRC, log, warn } from "./gacha-const.js";

const holds = new Set();          // reasons currently ducking
const saved = new Map();          // channel name -> gain before the duck
let theme = null;                 // HTMLAudioElement
let themeWanted = false;

const CHANNELS = ["music", "environment"];

// What Foundry itself drives each channel's gain to: the raw core volume
// setting (measured in v12: gain 0.5 == setting 0.5 on both channels). The
// restore targets THIS, not the value read at duck time — a duck that lands
// right after the first click can read the AudioContext's default 1.0 before
// Foundry has applied the player's slider, and restoring that would leave the
// scene music louder than the player set it.
const CHANNEL_SETTING = { music: "globalPlaylistVolume", environment: "globalAmbientVolume" };
function channelTarget(name, fallback) {
  try {
    const v = Number(game.settings.get("core", CHANNEL_SETTING[name]));
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {}
  return fallback;
}

function musicVolume() {
  let v = 0.5;
  try { v = Number(game.settings.get("core", "globalPlaylistVolume")); } catch {}
  if (!Number.isFinite(v)) v = 0.5;
  // Foundry maps the slider through inputToVolume (a curve); match it when available.
  try { const f = foundry?.audio?.AudioHelper?.inputToVolume; if (typeof f === "function") return f(v); } catch {}
  return v;
}

function duck(on) {
  for (const name of CHANNELS) {
    const ctx = game.audio?.[name];
    const gn = ctx?.gainNode;
    if (!gn?.gain) continue;
    try {
      if (on) {
        if (!saved.has(name)) saved.set(name, gn.gain.value);
        gn.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
      } else if (saved.has(name)) {
        gn.gain.setTargetAtTime(channelTarget(name, saved.get(name)), ctx.currentTime, 0.6);
        saved.delete(name);
      }
    } catch (e) { warn("audio duck", name, e); }
  }
}

function fadeTheme(to, ms) {
  if (!theme) return;
  const from = theme.volume, t0 = performance.now();
  const step = (now) => {
    if (!theme) return;
    const k = Math.min(1, (now - t0) / ms);
    theme.volume = Math.max(0, Math.min(1, from + (to - from) * k));
    if (k < 1) requestAnimationFrame(step);
    else if (to === 0 && !themeWanted) { theme.pause(); }
  };
  requestAnimationFrame(step);
}

function startTheme() {
  themeWanted = true;
  try {
    if (!theme) { theme = new Audio(BGM_SRC); theme.loop = true; theme.volume = 0; theme.preload = "auto"; }
    if (theme.paused) { theme.currentTime = 0; theme.play().catch((e) => warn("theme play blocked", e?.message)); }
    fadeTheme(musicVolume(), 900);
  } catch (e) { warn("theme", e); }
}

function stopTheme() {
  themeWanted = false;
  fadeTheme(0, 600);
}

/**
 * @param {string} reason  "machine" (screen open; plays the theme) or "watch"
 *   (joined someone else's reveal; duck only — the reveal has its own cues)
 */
export function hold(reason) {
  const first = holds.size === 0;
  holds.add(reason);
  if (first) duck(true);
  if (reason === "machine") startTheme();
}

export function release(reason) {
  if (!holds.delete(reason)) return;
  if (reason === "machine") stopTheme();
  if (holds.size === 0) duck(false);
}

export function releaseAll() {
  holds.clear();
  stopTheme();
  duck(false);
}

/** Follow the player's Music slider while the theme plays. */
Hooks.on("updateSetting", (s) => {
  if (s?.key === "core.globalPlaylistVolume" && theme && themeWanted) theme.volume = musicVolume();
});

export const audioDebug = () => ({ holds: [...holds], saved: Object.fromEntries(saved), theme: theme ? { paused: theme.paused, volume: theme.volume } : null });
log("Local audio ready.");
