# Legacy boss animations on the 3D board (v1.0.618)

Seven older bosses now play their new animations: Gryphon, Masked Girl (Kalina), Jack, Jill, Love, Rauben and Geist. The user approved every move in a mockup first.

The world data changes too: **7 boss actors** (their skill items' `animation_script`, timing and preload), plus one effect flag on Masked Girl.

Not included: Geist's **Shadowbringers**, which is deferred and keeps its old script.

## What changed

- **Regular moves** run on the live 3D board.
  - The camera doesn't move, and bodies are depth-scaled.
  - On contact the targets show their hurt sprites, and the screen dims fully instead of the old half-faded tiles.
- **Zero Powers** always open with the caster's full-body cut-in.
- **Three Zero Powers** take over the camera, as approved: Jack's Apex Arrow, Rauben's Night of Hundred Bandits and Masked Girl's Rebellious Wing. When they end, the camera returns to the arena's normal framing.
- **Masked Girl's Rebellious Wing** gives her a winged status sprite for as long as she holds its **Flying** effect. This uses the effect's `flags.fabula-ultima-companion.poseArt`, set by `tools/safe-edit/bin/_set-rebellious-wing-poseart.js`.
  - The old trick (hidden token plus a floating copy) is gone.
  - The "Rebellious Wing End" item (`MCHyHOcBNzN3ByOU`) now does nothing. It was left in place.
- **Berserk** now has a token cue: a red rage aura with an underglow, rising streaks and a red wash. It applies to **any** actor with Berserk, not just Jill. The test in `status-classifier.test.mjs` is updated.
- **Moves whose animation still runs game logic keep it intact:**
  - Spear Rain: the AdvanceDamage calls now land on each spear's impact.
  - Come! My Amigo!: the arrival chat card's stripped `<div>` is restored.
  - Oi! Come help me now!: summons kept.
  - Gangster Paradise: the IP drain and share are unchanged.
  - Love Serenade: the BGM swap is unchanged.

## Code

- **Generators:**
  - `tools/anim-studio/lib/legacy-{gryphon,masked,twins,rauben,love,geist}-signatures.js`
  - `tools/anim-studio/lib/legacy-shots/*.inner.js`
  - `tools/anim-studio/lib/legacy-boss-registry.js`, merged into `_build-dungeon-animations.js` REGISTRY.
- **To rebuild one boss:** `node bin/_build-dungeon-animations.js --write --only "⭐️ <Boss>"`, from `tools/safe-edit`, with the game closed. Note that `"⭐️"` on its own also matches Fafnir.
- **Pixelfx `_light` layers:** these are glow on black with no alpha channel. Drawing them with canvas `lighter` onto the transparent overlay turned the black into an opaque box. They now pass an SVG luminance-to-alpha filter (`#oni-luma-alpha`).
- **New Forge assets:**
  - `Animation/pixelfx/` (spotlights and pools, dark crescent/plasma/etc., fire pillar).
  - 5 Kalina pose PNGs in `Campaign/The Legend of Dragonslayer/Image/NPCs/Kalina/`.

## Tests

Staging World, in a GPU window:
- **Every move:** all 52 moves played. None threw, all ran at 51-60 fps, and every token was visible again afterwards.
  - Kalina's Jump hides her and Skyfall Dive brings her back.
  - Love Serenade's floor lights sit under the sprites.
- **Black-box fix:** after it, Torcleaver and Temper Tantrum have no box and the glow is kept.
- `status-classifier.test.mjs` passes.

## Heads-up

- **Not yet seen in a real fight.** These logic moves need a real combat to check:
  - Spear Rain: in preview, `chat-portrait` threw "reading 'prepend'", possibly because the sidebar was collapsed.
  - Love Serenade's music: preview had audio locked.
  - Gangster Paradise's IP writes.
- **Summons:** the camera follows the new tokens. This comes from token creation, not from the animation, and it predates this change.
- **Geist's "Attack (imbued by Shadow Strike)":** the generator exists but isn't hooked to anything.
