# Animation Brief

A **Brief** is a structured description of an animation you want built. It
exists to kill the "type out free-form what I want" pain: instead of prose, you
assemble a timeline of named **beats** (each from the recipe catalog below) and
hand the JSON to Claude, who turns it into a polished `animation_script`.

Produce a Brief either by:
- filling in [`templates/brief-template.json`](templates/brief-template.json), or
- the in-game **Brief Builder** (Anim Studio scene-control button → Preview
  Bench → *Brief Builder*), which emits the JSON for you.

## Shape

```jsonc
{
  "name": "Fireball",
  "concept": "A compressed sphere of flame hurled at one enemy; detonates on impact.",
  "caster": "the mage",          // free text — who/what casts
  "target": "single enemy",       // free text — who/what it hits
  "palette": ["#ff8a3d", "#ffd27f"],
  "timing": "default",            // "default" (gate on impact) | "offset"
  "beats": [
    { "type": "sfxCue",   "sfx": "Fire2",     "at": "start" },
    { "type": "projectile","color": "#ff8a3d", "travelMs": 420 },
    { "type": "impact" },          // <- the damage moment (fireDone)
    { "type": "whiteout", "fadeIn": 120, "hold": 80 },
    { "type": "screenshake", "intensity": 8, "durationMs": 300 },
    { "type": "sfxCue",   "sfx": "Explosion" }
  ]
}
```

Exactly one beat should be (or be marked) the **impact** — the frame damage
lands on. If you omit an explicit `impact` beat, note in `concept` when damage
should land.

## Beat catalog

Each beat maps to `oni` helpers, so a Brief is directly buildable. Params are
suggestions — omit any to accept sensible defaults.

| beat `type` | what it does | key params |
|---|---|---|
| `sfxCue` | play a sound (by manifest name) | `sfx`, `volume`, `at` ("start"/inline), `delayMs` |
| `projectile` | glowing bolt caster→target | `color`, `boltSize`, `travelMs` |
| `webmOnTarget` | play a `.webm` at target/caster | `webmUrl`, `size`, `anchor`, `preFlash` |
| `tokenLunge` | caster darts at target + recoils | `distance`, `outMs`, `backMs` |
| `glowAura` | radial glow (+ optional embers) on a token | `color`, `size`, `durationMs`, `embers` |
| `cutIn` | dim + slide-in portrait of a token, hold, slide out | `who` ("caster"/"target"), `holdMs`, `stingSfx` |
| `cameraPan` | illusion pan across the field | `direction`, `durationMs` |
| `zoomOutReveal` | shrink subject(s) to reveal scale | `scale`, `durationMs` |
| `stutterScale` | grow-in-spurts with shudder holds | `steps`, `totalMs` |
| `telegraph` | ground shadow that scales up before a slam | `growMs`, `color` |
| `whiteout` | full-screen flash (often the impact) | `fadeIn`, `hold`, `fadeOut`, `color` |
| `dim` | cinematic dim sheet behind the action | `to`, `fadeInMs` |
| `screenshake` | shake the canvas | `intensity`, `durationMs` |
| `impact` | marker: fire the damage gate here | — |

## Why this helps

- **You** stop describing camera/timing/SFX in prose — you pick beats and set
  numbers. The vocabulary carries the shared meaning.
- **Claude** gets an unambiguous spec that maps 1:1 onto the `oni` helpers, so
  the first draft is close and tuning is just CFG numbers in the Preview Bench.
- SFX are named (from your manifest), never pasted URLs.
