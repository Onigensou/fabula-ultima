# Creature rig — a 3D, animated stand-in for a painted token (2026-11-17)

First user: **Nidhogg**. The painting is cut into relief layers with rig weights (tools/nidhogg-depth-mockup →
tools/nidhogg-motion-test, `rig.py` → `export_rig.py`), shipped to `assets/creature-rigs/<id>/` (`rig.json` +
one PNG per layer). Each client renders the rig locally with three.js r128 (`assets/vendor/three-r128.min.js`)
and the result REPLACES the token mesh's texture every frame — so every existing effect that works on
`token.mesh` (turn-glow outline filter, tint AE, alpha hide/fade, shake filter, depth scale, 3D-camera
placement) keeps working unchanged.

## Files

| File | Role |
|---|---|
| `scripts/creature-rig/rig-model.js` | THREE scene for one rig: build from rig.json, `pose(channels)`, `setYaw(deg)`, `render(renderer)`. Orthographic camera framing exactly the painting: at rest + yaw 0 the output IS the painting (no anchor moves). |
| `scripts/creature-rig/rig-motions.js` | Pure. Channels (jaw, lift, breath, tail, wings, tailPhase), `idle()`, `defineMotion(name, spec)`, built-in motions `roar` / `flinch` / `snarl`, `RigAnimator` (idle + additive one-shots, `play → {done, peak, cancel}`, `rest(ms)`, `release(ms)`). |
| `scripts/creature-rig/rig-host.js` | Foundry side: rig definitions, which tokens get a rig, per-token renderer + live texture swap, frame loop, camera yaw, pause when hidden, client setting, painted-texture accessor. |
| `scripts/creature-rig/rig-api.js` | Public trigger API + cross-client broadcast, `oni.rig` helper for animation scripts, entrance hook, event row. |

## Host contract (rig-host.js exports)

```js
registerRigDef({ id, base, match: { src: [..] }, onEntrance })   // base = "modules/fabula-ultima-companion/assets/creature-rigs/<id>/"
isRiggedToken(token) -> boolean        // a def matches this token's painted image (even before the rig has built)
rigFor(tokenOrId) -> RigInstance|null  // live, built rig on THIS client
whenRig(tokenOrId, timeoutMs=8000) -> Promise<RigInstance|null>
paintedTexture(token) -> PIXI.Texture  // the ORIGINAL painting texture (use this, not token.mesh.texture, to read his pixels)
initCreatureRigs()                     // boot: settings, hooks, built-in defs
```
`RigInstance`: `{ id, token, def, animator, play(name, opts) -> {done, peak, cancel}, rest(ms), release(ms), busy }`.

Matching: a token is rigged when its `document.texture.src` is in a def's `match.src` (path compare, query string
stripped), unless the actor flag `flags.fabula-ultima-companion.creatureRig === "off"`. The flag may also name a
def id to force one. Client setting `creatureRig3d` (default on) turns the whole thing off per client.

## API contract (rig-api.js)

```js
FUCompanion.api.creatureRig = {
  play(tokenRef, motion, opts) -> Promise<result>   // ALL clients (socket + local); resolves on THIS client's end
  playLocal(tokenRef, motion, opts) -> handle       // this client only (use inside code that already runs everywhere)
  rest(tokenRef, ms), release(tokenRef, ms),        // all clients
  isRigged(tokenRef), motions(), defineMotion(name, spec)
}
oni.rig.play(token, "roar", opts) / oni.rig.roar(token, opts)   // inside animation scripts (they already run on every client: LOCAL)
```
`tokenRef`: Token placeable, TokenDocument, token id or uuid. A call on a token with no rig resolves
`{ ok: false, reason: "no-rig" }` — callers never need to check first.

## Rules

- Anything that reads the dragon's PIXELS (fall show smoke, return show body + glow cuts, sprite shadow) must use
  `paintedTexture(token)`: `token.mesh.texture` is the live rig canvas while rigged.
- Shows that hide his token and draw their own copy call `rest(token)` first so the hand-off is the painting.
- Motions are additive over idle; `opts.hold` lengthens the roar; `peak` resolves at the jaw snap (time a shake / sound to it).

## How to trigger a motion (as built)

| Where | Call | Notes |
|---|---|---|
| Skill / move animation script | `await oni.rig.roar(ctx.caster)` or `const h = oni.rig.play(token, "roar", { hold: 2 }); await h.peak; /* shake */ await h.done;` | Scripts already run on every client: local. A roar the script doesn't await still finishes. |
| Entrance | automatic: rig def `onEntrance` (Nidhogg: `"roar"`) plays when his token is revealed (fade, descent, gather, mid-battle join) | once per token per 8 s |
| Story event | row **Creature Motion** (category Token): token, motion (or Hold still / Move again), hold seconds, wait for end | runs on every client on the scene |
| Any other code (GM macro, a show) | `FUCompanion.api.creatureRig.play(token, "roar", opts)` (all clients) / `.playLocal(...)` (this client) / `.rest(token)` / `.release(token)` | `timing(name, opts)` -> `{durationMs, peakMs}` without a rig |

Motions: `roar` (opts `hold`, `jaw`, `head`, `wings`, `speed`), `snarl` (`hold`, `jaw`), `flinch` (`strength`). Add more with
`defineMotion(name, { duration(o), peakAt(o), sample(t, o) -> channels, calm })` in rig-motions.js (all clients must
define it, so put new motions in that file). Asking for a motion that is already running JOINS it (`restart: true` starts over).

Updating the rig art: rebuild in tools/nidhogg-motion-test (`rig.py`), then `python tools/nidhogg-motion-test/export_rig.py`.
Client setting "3D animated creatures" turns rigs off per client (painting shown instead).
