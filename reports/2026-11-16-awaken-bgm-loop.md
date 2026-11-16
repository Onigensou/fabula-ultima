# Awaken BGM: intro once, then a seamless battle loop (v1.0.622)

The battle music "Awaken" looped badly. The music ended at 3:16, then the file ran about 38 seconds of near-silence before starting over, so long battles sat in dead air on every loop. The user approved a re-cut that keeps the intro.

World data: **one playlist sound only**, "Awaken" in The Legend of Dragonslayer (`VrpdABUTSoREMDR5` / `N5EBhNpsUKKzWCOG`). Its name, id, volume and repeat setting are unchanged, so every event and script that plays "Awaken" still works.

## What changed

**The file (Forge, overwritten in place).** `Sound/Fabula Ultima/BGM/Awaken.mp3` is now 2:21.3:
- 0:00 to 0:34.63 is the original intro.
- The rest is a 40-bar section (90 BPM) that the song itself repeats at 2:22. The cut is on the downbeat, with a 120 ms crossfade. The end of the file leads straight back into 0:34.63.
- The MP3 is gapless: Chromium decodes it to the exact sample count, so the loop has no gap.

**The playlist sound.** Path now ends in `?v=2` (Forge's CDN and browsers keep the old file under the plain URL). New flag `flags.fabula-ultima-companion.loopStart = 34.632177`.

**New module file `scripts/shared/playlist-loop-points.js`.** Foundry v12 can loop part of a buffered track (`Sound#play` loopStart/loopEnd), but `PlaylistSound` never passes those options, so repeating tracks always restart at 0:00. This file wraps `PlaylistSound#_createSound`:
- A sound with `flags.fabula-ultima-companion.loopStart` (seconds, optional `loopEnd`) and repeat on plays from 0:00, then loops loopStart..end.
- On that Sound only, `currentTime` and `duration` are replaced so the playlist progress bar, fades and pause/resume see the whole file.
- Sounds without the flag go through Foundry's `play` untouched. Tracks over 10 minutes (streamed, not buffered) are not affected.

To give another BGM an intro: cut the file so its end flows into the loop start, upload it, and set the flag on the playlist sound.

## Tested

Staging World, headless:
- The decoded length is exact (141.298 s).
- Playback starts at 0:00, so the intro plays.
- Started at 139 s, four seconds later the track was at 36.34 s, so it wrapped to loopStart (34.63 s), not to 0:00.
- `duration` reports the whole file.
- The control track "City" (no flag) was unchanged.

Not tested: Firefox, and a real-session listen.

## For you

- **Pull** brings the module file, `module.json` and the playlists store. A GM reload is enough; the new script needs a server restart only if your server was running during the pull (new `esmodules` entry).
- **Forge mirror:** your mirror needs a sync to serve the `?v=2` file. Until then, clients load Awaken from Forge (still works, just slower).
