// Director VFX + asset registry.
//
// Static assets the director references at runtime — AE icons, Study VFX,
// status iconography, sound cues. All of them are added to the preload
// list inside director-init.js so first-use during combat doesn't hit
// the network. (Forge-vtt URLs in particular have a noticeable first-use
// delay; pre-fetching them at battle start avoids "lag spike when Guard
// is first applied" UX.)
//
// Adding a new asset: just append to DIRECTOR_STATIC_URLS — the battle
// preload picks it up automatically the next time `runDirectorInit` runs.

import { log, warn } from "./logger.js";

export const DIRECTOR_STATIC_URLS = Object.freeze([
  // Guard / Covered AE icons (Forge-vtt — remote, slowest first-fetch).
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/shield_oath.png",
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/intervene.png",

  // Study VFX: 4s green marker on the studied token + a "computer ping"
  // sound. The JB2A file is local-to-the-module but still ~1MB; preloading
  // saves the first-Study lag.
  "modules/JB2A_DnD5e/Library/Generic/Marker/SciFi/MarkerScifiComplete001_001_GreenYellow_600x600.webm",
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg",
]);

// Study token VFX — mirrors `playStudyVfxAndWait` from
// `scripts/encyclopedia/encyclopedia-core.js`. Plays a green-marker effect
// on the studied token plus a short audio cue, then awaits the duration
// so the caller can chain (e.g. open the encyclopedia AFTER the effect).
//
// Silently no-ops if Sequencer isn't installed or the token isn't on the
// active canvas — this is a flavor moment, not a critical path.
export async function playStudyVfx({ targetTokenUuid, durationMs = 2500 } = {}) {
  // `targetTokenUuid` for linked tokens looks like `Scene.X.Token.Y`; for
  // unlinked the same. Grab the trailing token id.
  const tokenId = String(targetTokenUuid ?? "").split(".Token.").pop();
  const canvasTok = tokenId ? canvas?.tokens?.get?.(tokenId) : null;
  if (!canvasTok) {
    log("Study VFX: token not on canvas, skipping");
    return;
  }
  if (typeof Sequence === "undefined") {
    log("Study VFX: Sequencer not loaded, skipping");
    return;
  }
  try {
    new Sequence()
      .effect()
        .file("modules/JB2A_DnD5e/Library/Generic/Marker/SciFi/MarkerScifiComplete001_001_GreenYellow_600x600.webm")
        .atLocation(canvasTok)
        .duration(durationMs)
        .opacity(0.7)
        .scale(0.5)
      .play();
    new Sequence()
      .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg")
      .play();
    // Brief tail beyond the FX duration so the green marker has time to
    // fade out before whatever the caller does next (encyclopedia open,
    // typically).
    await new Promise((r) => setTimeout(r, durationMs + 200));
  } catch (e) {
    warn("playStudyVfx threw", e);
  }
}
