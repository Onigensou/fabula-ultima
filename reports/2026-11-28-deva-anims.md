# Deva animations in the game (move-engine 1.3.0) — 2026-11-28

Branch `feat/deva-anims`. The user approved every Deva move on the animation mockup (page `deva-anim` v20,
artifact C7wZxC2jSAo15AAsJfQxRb, review rounds rmwzrtftn / rmwzszayz / rmwzti7z1) and asked for all of them
to be wired into the game.

## What ships

| Move | Carrier | How it plays |
|---|---|---|
| Vajra Fist, Mudra Lance, Double Slap, Ground Slam, Surya Palm, Rahu's Eclipse, Kala Strike | the skill | turn action; numbers land where the mockup shows them (`gateOnNum`) |
| Fists of Fury | the skill | turn action; replaces the v1.0.575 script; cues its 12 Chain strikes through the barrage; camera push |
| Fists of Focus | the skill | turn action; replaces v1.0.575; one number at the final punch; camera push |
| Enlightenment | the skill, timing `resolve` | `play_animation` in `en_chain` before the form clear |
| Missile Fist (summon) | the skill, timing `resolve` | `play_animation` after `mf_summon`, the spawned fists are its targets |
| Stance Change | Celestial Discipline `#stance_maya` / `#stance_vajra` | Guard round, only when the drawn stance changed (hidden memory AE `Last Stance Maya`) |
| Form Change | Celestial Discipline `#form_fury` / `#form_focus` | Offense round, before the form AE lands |
| Detonate | the fist's skill, timing `resolve` | `play_animation` first in `fd_chain`, at the random victim |
| Missile Fist break | the fist's Fuse | `creature_defeated` (self) → `play_animation`; defeat style `consumed` (no second death FX) |

Missile Fist token art: `Beastiary/Deva/Missile_Fist.png` (the approved art, stored pointing LEFT because BD
mirrors enemies) + float idle. New Forge files: that PNG, Rahu's eclipse layers (`Animation/pixelfx/`), the GG
mask sheets (`Animation/Guilty Gear Strive/sheets/ggs_*.png`).

Migration `2026-11-28-deva-anims` (every copy, idempotent, hand-made scripts left). Rebuild the scripts with
`node tools/move-engine/build/deva-anims.js`.

## Engine (1.3.0)

`sprite()` props on the game canvas, caster poses (`cfg.poses`), target poses from sheet fields
(`cfg.targetPoses`), `a.flip` drawn, the camera (`cfg.camera`, the timeline owns the board for that shot),
`impactFrame()`, `gateOnNum` + `oni.impactOffsets`, `byVariant`, per-move `skip`, `ME_PRELOAD`, clip `fadeIn`.
Fixes found in a real fight: video poses were sized 0 x 0 in oni-timeline (Deva vanished in Fury / Focus);
freshly summoned targets painted before their texture loaded.

## Checks

- Dry parity (`move-engine parity deva --no-game`, page seed): summon, Stance, Vajra, Lance, Form,
  Enlightenment, Surya, Rahu, Kala exact. Barrages within the page's own run-to-run spread (±20 ms, its fist
  flights are unseeded). Slap / Slam / Detonate / break differ by design (game targets, one fist per turn).
- Real-server first boot (sandbox copy of the live world): `2026-11-28-deva-anims` ran, every field written,
  the Deva token copy on Valley_Map029 included; a second boot does not re-run it.
- Real fights (snapshot runner, GPU, Valley_Battlemap007, 3 runs): all 15 moves played through BD (Detonate in a run
  with 99-HP fists, since the sim party always breaks them first), wall time = plan, no move-engine warnings or
  errors; 3–4 frames of 100–170 ms per fight, during the barrages. The runner's Forge mirror lacks the two explosion
  clips (rl_explosion__boom, GG explosion_anim01): both serve from the Forge CDN (200).

## Differences from the mockup (by design)

- The stance rim light and status words are mockup stand-ins: BD shows its own statuses; the board token has
  no stance glow yet.
- Hits / misses follow BD's real result (the mockup rolls or always hits).
- Double Slap's spin uses each target's sheet walk clips; the mockup's down-left frame is the sheet's left clip.
- The barrage blink keeps the mockup's gap to the nearest party member (not a fixed step).
- Fury's 30 visual ticks per target become its 12 real Chain strikes; Focus shows one number.
- Afterimages that the mockup spawned inside tween callbacks come from a beat-clock loop (same rate).
