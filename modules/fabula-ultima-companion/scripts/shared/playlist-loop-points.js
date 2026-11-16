/**
 * Playlist loop points (2026-11-16) — lets a repeating playlist track play an intro once, then loop
 * only its main section.
 *
 * Foundry v12 plays tracks under 10 minutes from an AudioBuffer and can loop a region of it
 * (Sound#play options loopStart / loopEnd), but PlaylistSound never passes those options, so a
 * repeating track always restarts from 0:00.
 *
 * Opt-in per track: set flags["fabula-ultima-companion"].loopStart on the PlaylistSound (seconds into
 * the file). Optional loopEnd (seconds); default is the end of the file. With repeat on, the track
 * plays from the start, and on reaching loopEnd jumps back to loopStart. With repeat off, or for a
 * track streamed instead of buffered (over 10 minutes), nothing changes.
 *
 * First user: "Awaken" (The Legend of Dragonslayer), loopStart 34.632177 = the start of its 40-bar
 * battle loop.
 *
 * The Sound's own currentTime/duration assume a loop from 0, so they are replaced on that one Sound:
 * duration = whole file, currentTime = position in the file. That keeps the playlist progress bar,
 * fades and pause/resume correct.
 */
const MODULE_ID = "fabula-ultima-companion";
const TAG = "[FUCompanion][LoopPoints]";
const PATCHED = Symbol("fuLoopPoints");

function loopPointsOf(playlistSound, buffer) {
  const f = playlistSound?.flags?.[MODULE_ID];
  const start = Number(f?.loopStart);
  if (!buffer || !Number.isFinite(start) || start <= 0) return null;
  const full = buffer.duration;
  const endFlag = Number(f?.loopEnd);
  const end = Number.isFinite(endFlag) && endFlag > start && endFlag <= full ? endFlag : full;
  if (start >= end) return null;
  return { start, end };
}

function patchSound(playlistSound, sound) {
  if (!sound || sound[PATCHED]) return;
  sound[PATCHED] = true;
  const proto = Object.getPrototypeOf(sound);
  const baseDuration = Object.getOwnPropertyDescriptor(foundry.audio.Sound.prototype, "duration").get;
  const baseCurrentTime = Object.getOwnPropertyDescriptor(foundry.audio.Sound.prototype, "currentTime").get;
  let active = null;   // the loop points used by the current playback, or null
  let used = false;    // loop points were passed to this Sound at least once

  sound.play = function (options = {}) {
    if (typeof options !== "object" || options === null) return proto.play.apply(this, arguments);
    const pts = options.loop ? loopPointsOf(playlistSound, this.buffer) : null;
    active = pts;
    if (pts) {
      used = true;
      // Without an explicit offset Foundry would start at loopStart and skip the intro.
      options = { ...options, loopStart: pts.start, loopEnd: pts.end, offset: options.offset ?? 0 };
    } else if (used) {
      // Clear loop points a previous play left in the Sound's stored playback options.
      options = { ...options, loopStart: 0, loopEnd: Infinity };
    }
    return proto.play.call(this, options);
  };

  Object.defineProperty(sound, "duration", {
    configurable: true,
    get() {
      if (active && this.buffer) return this.buffer.duration;
      return baseDuration.call(this);
    }
  });

  Object.defineProperty(sound, "currentTime", {
    configurable: true,
    get() {
      if (!active || !this.buffer) return baseCurrentTime.call(this);
      if (!this.playing) return undefined;
      if (this.pausedTime) return this.pausedTime;
      let t = this.context.currentTime - this.startTime;
      if (this.loop && t >= active.end) t = active.start + ((t - active.start) % (active.end - active.start));
      return t;
    }
  });
}

let _hooked = false;
export function initPlaylistLoopPoints() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  Hooks.once("init", () => {
    const cls = CONFIG.PlaylistSound?.documentClass;
    const create = cls?.prototype?._createSound;
    if (typeof create !== "function") {
      console.warn(TAG, "PlaylistSound#_createSound not found; loop points disabled.");
      return;
    }
    cls.prototype._createSound = function (...args) {
      const sound = create.apply(this, args);
      try { if (sound) patchSound(this, sound); }
      catch (e) { console.warn(TAG, "could not add loop points to", this.name, e); }
      return sound;
    };
  });
}

initPlaylistLoopPoints();
