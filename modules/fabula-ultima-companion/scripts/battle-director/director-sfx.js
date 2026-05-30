// Director per-client broadcast channel — zero-first-play-latency SFX (Web
// Audio) plus lightweight UI sync (sidebar collapse).
//
// Why the Web Audio path: the battle preloader warms audio through Foundry's
// AudioHelper, but Sequencer's `.sound()` uses its OWN loader, so a cue played
// that way still paid a full fetch + decode on its first use (the audible
// "delay the first time a SFX plays"). This module instead fetches the FULL
// file once (a plain 200 GET, NOT a Range request — which also dodges the
// Forge `.wav` 206 `ERR_CONTENT_DECODING_FAILED` decode bug), decodes it to an
// AudioBuffer, and caches it. Subsequent plays are instant.
//
// Cross-client model: each client owns its own warmed buffer cache (the boot
// warm in director-boot runs on EVERY client). The GM-side director calls
// `broadcastSfx`, which plays the cue locally AND tells every other client to
// play it from THEIR cache via socketlib. So a battle SFX lands on all screens
// with no per-cue audio streamed over the socket. Same split the cut-in and
// round banner already use for their visuals.
//
// Autoplay caveat: a browser tab that has had ZERO user interaction keeps its
// AudioContext suspended (autoplay policy). We `resume()` on every play, so any
// client whose user has clicked the page at all (joining Foundry involves
// clicks) will hear cues; a totally-idle spectator tab may stay silent until
// its first interaction. This matches the round banner's behavior.

import { log, warn } from "./logger.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_SFX = "FU_DIRECTOR_SFX_PLAY";
const ACTION_SIDEBAR_COLLAPSE = "FU_DIRECTOR_SIDEBAR_COLLAPSE";

let _socket = null;

const _audio = { ctx: null, buffers: new Map(), pending: new Map() };

function ctx() {
  if (!_audio.ctx) {
    _audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audio.ctx;
}

// Fetch (full 200) → decode → cache. De-dupes concurrent decodes of the same
// URL via the `pending` map so a preload + a racing first-play share one fetch.
function decode(url) {
  if (_audio.buffers.has(url)) return Promise.resolve(_audio.buffers.get(url));
  if (_audio.pending.has(url)) return _audio.pending.get(url);
  const p = (async () => {
    // `cache: "reload"` forces a fresh full GET (200), never a cached 206.
    const resp = await fetch(url, { cache: "reload" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const buf = await ctx().decodeAudioData((await resp.arrayBuffer()).slice(0));
    _audio.buffers.set(url, buf);
    _audio.pending.delete(url);
    return buf;
  })();
  _audio.pending.set(url, p);
  // On failure, drop the pending entry so a later attempt can retry.
  p.catch(() => _audio.pending.delete(url));
  return p;
}

// Decode + cache a batch up front (call at battle start while the curtain is
// up). decodeAudioData works on a suspended context, so this is safe before
// the first user-gesture resume. Never rejects — a bad URL just logs.
export async function preloadSfx(urls = []) {
  const list = Array.from(new Set((urls ?? []).filter(Boolean)));
  if (!list.length) return;
  await Promise.allSettled(
    list.map((u) => decode(u).catch((e) => warn(`preloadSfx: decode failed for ${u}`, e)))
  );
  log(`preloadSfx: warmed ${_audio.buffers.size}/${list.length} cue(s)`);
}

// Play a cue. Instant if preloaded; otherwise decodes on demand (only that
// first uncached play pays the cost). Fire-and-forget, never throws.
export function playSfx(url, vol = 0.6) {
  try {
    if (!url) return;
    const c = ctx();
    if (c.state === "suspended") { c.resume().catch(() => {}); }
    const start = (buf) => {
      const src = c.createBufferSource();
      const gain = c.createGain();
      gain.gain.value = vol;
      src.buffer = buf;
      src.connect(gain).connect(c.destination);
      src.start(0);
    };
    const cached = _audio.buffers.get(url);
    if (cached) start(cached);
    else decode(url).then(start).catch((e) => warn(`playSfx: ${url} failed`, e));
  } catch (e) {
    warn("playSfx threw", e);
  }
}

// ── Cross-client broadcast channel ────────────────────────────────────────

// Register the socket on EVERY client (call once at boot, after socketlib is
// up). Idempotent: socketlib.registerModule returns the module's shared socket,
// so coexisting with the cut-in / round-banner registrations is fine.
export function initDirectorSfx() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("director-sfx: socketlib unavailable — SFX/sidebar stay local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_SFX, ({ url, vol } = {}) => playSfx(url, vol));
    _socket.register(ACTION_SIDEBAR_COLLAPSE, collapseSidebarLocal);
    log("director-sfx: socket registered");
  } catch (e) {
    warn("director-sfx: init failed", e);
  }
}

// Play a cue on THIS client + every other client (each from its own warmed
// cache). Use this from the GM-side director for any cue that should be heard
// on all screens. Falls back to local-only if the socket isn't up.
export function broadcastSfx(url, vol = 0.6) {
  playSfx(url, vol);
  try { _socket?.executeForOthers?.(ACTION_SFX, { url, vol }); }
  catch (e) { warn("broadcastSfx: executeForOthers failed", e); }
}

// ── Sidebar collapse (UI sync) ────────────────────────────────────────────

function collapseSidebarLocal() {
  try { ui.sidebar?.collapse?.(); }
  catch (e) { warn("collapseSidebarLocal threw", e); }
}

// Collapse the Foundry sidebar on THIS client + every other client. Fired at
// the battle-start transition so the battlefield gets the full screen for
// everyone.
export function collapseSidebarAllClients() {
  collapseSidebarLocal();
  try { _socket?.executeForOthers?.(ACTION_SIDEBAR_COLLAPSE); }
  catch (e) { warn("collapseSidebarAllClients: executeForOthers failed", e); }
}
