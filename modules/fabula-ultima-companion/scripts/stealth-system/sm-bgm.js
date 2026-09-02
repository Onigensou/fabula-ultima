// ============================================================================
// Stealth Mode — the score.
//
// The alert tier is the loudest thing the system has to say, and until now it
// said it only in a small panel in the corner. Music carries it without the
// player having to look: creeping while unnoticed, the scene's own theme once
// something is stirring, an alarm track once the room is hunting.
//
// ── Why the middle tier is the SCENE's track ────────────────────────────────
// Neutral deliberately has no track of its own. It is the state a scene is
// authored in — the dungeon's own music — so dropping back to it is a return
// to normal rather than a third distinct mood. It also means a GM can score a
// map without knowing this system exists.
//
// ── GM only ────────────────────────────────────────────────────────────────
// Playlist playback is world state: `playSound` broadcasts to every client on
// its own. If each client drove its own music from the state it received, the
// track would be started once per connected user. So this listens on the GM
// and nowhere else — the same rule the rest of the system runs on.
// ============================================================================

import { TAG } from "./sm-constants.js";

/**
 * Track names, resolved by name across every playlist in the world (the same
 * lookup the Battle Director uses for battle BGM). A name rather than a path
 * so the GM can re-point, re-encode or re-upload the track without a code
 * change — and so a missing track degrades to a warning, not a broken scene.
 */
export const TIER_TRACK = Object.freeze({
  stealth: "Stealth Theme",
  neutral: null,            // null → the scene's own authored playlist
  alert:   "Alert Theme",
});

// What we last put on, so a state broadcast that changes nothing musical does
// not restart the track. Without this the score would stutter back to zero on
// every move, every awareness tick, every phase change.
let _appliedTier = null;
let _current = null;        // { playlistId, soundId } we started ourselves
let _installed = false;

/** Find a named sound anywhere in the world's playlists. */
function findTrack(name) {
  const wanted = String(name ?? "").trim();
  if (!wanted) return null;
  for (const pl of (game.playlists ?? [])) {
    const snd = pl.sounds?.getName?.(wanted);
    if (snd) return { playlist: pl, sound: snd };
  }
  return null;
}

/** Stop every playing playlist sound. */
async function silence() {
  const stops = [];
  for (const pl of (game.playlists ?? [])) {
    for (const s of (pl.sounds ?? [])) {
      if (s?.playing) stops.push(pl.stopSound(s).catch(() => {}));
    }
  }
  await Promise.allSettled(stops);
}

/**
 * Play the scene's authored music.
 *
 * A scene can name a single sound or a whole playlist; Foundry treats both as
 * "the scene's music", so both are honoured here. A scene with neither is
 * simply quiet, which is a legitimate authoring choice and not an error.
 */
async function playSceneDefault(scene) {
  const sc = scene ?? canvas?.scene;
  if (!sc) return;
  try {
    const snd = sc.playlistSound;
    if (snd?.parent) { await snd.parent.playSound(snd); return; }
    const pl = sc.playlist;
    if (pl) await pl.playAll();
  } catch (e) {
    console.warn(TAG, "scene default BGM failed:", e);
  }
}

/**
 * Put the tier's music on, if it is not already on.
 * Safe to call on every state broadcast — that is how it is wired.
 */
export async function applyTierBgm(tier, { scene = canvas?.scene, force = false } = {}) {
  if (!game.user?.isGM) return;
  const key = String(tier ?? "").toLowerCase();
  if (!force && key === _appliedTier) return;
  _appliedTier = key;

  const name = TIER_TRACK[key] ?? null;

  await silence();
  _current = null;

  if (!name) { await playSceneDefault(scene); return; }

  const hit = findTrack(name);
  if (!hit) {
    // Named but absent: say so once, loudly enough to be fixed, and fall back
    // to the scene's own music rather than leaving the map silent.
    console.warn(TAG, `BGM track not found in any playlist: "${name}" — falling back to the scene's own`);
    await playSceneDefault(scene);
    return;
  }

  try {
    await hit.playlist.playSound(hit.sound);
    _current = { playlistId: hit.playlist.id, soundId: hit.sound.id };
  } catch (e) {
    console.warn(TAG, `BGM play failed for "${name}":`, e);
  }
}

/**
 * Hand the scene back its own music. Called when the infiltration ends, so a
 * stealth track never outlives the mode that justified it.
 */
export async function restoreSceneBgm(scene = canvas?.scene) {
  if (!game.user?.isGM) return;
  _appliedTier = null;
  _current = null;
  await silence();
  await playSceneDefault(scene);
}

/** Forget what is playing without touching audio (teardown, scene change). */
export function resetBgmMemory() {
  _appliedTier = null;
  _current = null;
}

/**
 * Follow the authoritative state.
 *
 * `stealth.stateBroadcast` fires on the GM for every authoritative push, which
 * is exactly the pulse we want: it covers alert changes from any cause — a
 * sighting, a Hide, a GM override — without each of those having to remember
 * to touch the music.
 */
export function installBgmWatcher() {
  if (_installed) return;
  _installed = true;
  Hooks.on("stealth.stateBroadcast", (payload) => {
    if (!game.user?.isGM) return;
    if (!payload?.active) return;
    applyTierBgm(payload.alert).catch((e) => console.warn(TAG, "BGM sync threw:", e));
  });
}
