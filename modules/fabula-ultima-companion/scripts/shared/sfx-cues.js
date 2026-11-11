// ============================================================================
// SFX cue tracks — sounds timed to an effect's own clock (pure; no Foundry).
//
// A cue is { beat, file, vol, peak }: `beat` is the moment in the effect (s)
// the sound must LAND on, `peak` how far into the file its loudest moment is
// (measured once, 2026-11-11, by decoding the file), so it starts at
// beat - peak and the hit lands on the frame. Every file is a path under the
// co-dev's Forge Sound folder (SOUND_BASE).
//
// A track fires each cue once as the effect's clock passes its start. A clock
// that JUMPS past a cue (a rig seeking, a stalled tab catching up) skips it
// silently instead of firing a pile of stale sounds at once.
// ============================================================================

export const SOUND_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
/** A cue whose start is further behind the clock than this when first seen is skipped (s). */
export const CUE_LATE_S = 0.35;

export const cueUrl = (file) => SOUND_BASE + String(file).split("/").map(encodeURIComponent).join("/");
export const cueStart = (c) => Math.max(0, (Number(c.beat) || 0) - (Number(c.peak) || 0));

/**
 * makeCueTrack(cues) → { step(t, play), fired, reset() }
 *   step(t, play): call every frame with the effect's time t (s); play(cue, url) for each cue that starts now.
 */
export function makeCueTrack(cues = []) {
  const list = cues.map((c, i) => ({ ...c, i, start: cueStart(c) })).sort((a, b) => a.start - b.start);
  const done = new Set();
  return {
    fired: [],
    step(t, play) {
      for (const c of list) {
        if (c.start > t) break;
        if (done.has(c.i)) continue;
        done.add(c.i);
        if (t - c.start > CUE_LATE_S) continue;   // jumped past it: stay quiet
        this.fired.push(c.i);
        try { play?.(c, cueUrl(c.file)); } catch { /* a sound never breaks the effect */ }
      }
    },
    reset() { done.clear(); this.fired.length = 0; },
  };
}

/** Every distinct URL in some cue lists (to preload). */
export const cueUrls = (...lists) => [...new Set(lists.flat().map((c) => cueUrl(c.file)))];
