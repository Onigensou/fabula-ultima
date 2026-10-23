# Animation staging: prepare before you play

**The rule:** an animation's assets are made ready to draw, and its heavy
setup is done, *before* the first frame that shows them. A hitch while the
screen is still can't be seen. The same hitch on the frame an effect appears
can.

## Why loading is not enough

Combat start already downloads every asset an `animation_script` names
(`animation-asset-cache.js`). But a loaded asset still costs work on the frame
it first appears:

- **GPU upload.** PIXI uploads a texture the first time it draws it.
- **Video decoder.** A webm must start (or restart) its decoder. Chrome puts
  the decoder of a video that sits paused for a while to sleep.
- **Fresh objects.** Sequencer builds a new `<video>` for every effect, from
  scratch, on the frame you call `play()`.

Hiding things does not pre-pay any of this. PIXI skips anything that is
invisible or at alpha 0, and the browser does not paint `visibility: hidden`.
To be ready, it has to have been drawn once.

## What the engine does (every skill, no script change)

`scripts/action-animation/animation-stage.js`:

1. **CONFIRM:** while the action card is up, the GM tells every client which
   files the skill's script names. Each client then:
   - loads every image and webm and uploads it to the GPU;
   - re-seeks each paused webm to wake its decoder;
   - parks one ready, independent copy of each webm for `oni.vfx()`;
   - for scripts that use Sequencer, fills Sequencer's own file cache.
2. **ANIMATION:** before the script runs, the GM waits for every client to
   ack. The wait is capped at `STAGE_CFG.waitCapMs` (900 ms), so a slow client
   never stalls the battle. Reactions (`playSkillAnimation`) and the Anim Studio
   bench stage at play time, with the same cap.

**Sequencer inside pseudo scripts plays locally.** A pseudo (inner) script runs
on every client. By default, Sequencer also pushes each effect and sound to
every other client. Each client therefore drew N copies, one per connected
client: N impact videos decoding at once, and N hit sounds at N times the
volume. The pseudo listener now gives scripts a `Sequence` whose `play()` is
forced local. The GM-side outer script still broadcasts as before.

## What a script should do

- **One-shot webm effects (impacts, bursts):** use
  `oni.vfx(url, { x, y, scale })`. It takes the staged copy, so the impact
  frame pays nothing. It is sized like Sequencer's `.effect().file(url).scale(s)`
  (native px × grid/100 × s). It outlives the script, like a Sequencer effect,
  and removes itself when it ends.
- **Name your assets as literal URLs in the script.** Staging finds them the
  way the combat preload does: quoted paths with a media extension. A URL built
  at run time cannot be staged.
- **Do the expensive setup in a still moment:** the banner lead, a hold, a
  caster off-screen. Build sprites there at alpha 0. If they must be on the GPU
  before they show, give them one frame at a tiny alpha.
- **Avoid document writes mid-animation.** For example, hiding the caster by
  updating the token's alpha costs a server round trip and redraws that token
  on every client. `oni.hideToken()` hides it on each client only.

## Custom effects outside skills

Follow the same rule. The battle shatter transition
(`battle-transition/shatter-transition.js`) builds its entire glass track
(about 310 WAAPI animations) during the cracked-frame hold. The animations
start paused, and the shards are painted once behind an opacity-0 layer, with
`will-change: opacity` so Chrome still rasterises them. At the cut it only
starts them. Measured headless on 2026-10-23: the time from the cut to the
first frame dropped from about 1370 ms to about 340 ms.

## Measuring

Every animation run is metered on each client:

```js
FUCompanion.api.animStage.perf()   // last 40 runs: worstMs, worstAtMs, late frames, long tasks
FUCompanion.api.animStage.stats()  // stage count, oni.vfx pool hits/misses
FUCompanion.api.shatter.lastStats  // the shatter's own per-phase frame stats
```

- `anim:<caster>` covers the GM-side run up to the damage moment.
- `pseudo:<scriptId>` covers the per-client script, start to end.
- Headless clients render in software (SwiftShader), so their frame timings are
  not comparable to a real GPU. Measure on a real client.

**Kill switch / baseline:** `FUCompanion.api.animStage.config.enabled = false`
plays every animation cold, as before staging existed.
