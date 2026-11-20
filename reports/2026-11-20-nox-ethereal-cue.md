# Nox Wraith Ethereal: its animation now plays (v1.0.640)

Ethereal (Nox Wraith: resists Strike damage) had an animation since v1.0.639 but no trigger, so nothing played it. Now the Wraith goes thin and rippled, then fills back in, each time it is hit by an attack that targets its Defense and takes damage. The halving itself is unchanged: it still comes from Ethereal's active effect.

## What you need to do
- Pull and restart the server (version bump). No migration: the Wraith ships in the world data commit.
- Your save slots don't need patching.
- **If your Nox tuning branch also writes the Nox actors:** rebase onto this push and re-run your actor writes before you commit the world (same as for v1.0.639).

## Code
- `state-handlers.js` §7c-bis: the `creature_hit_by_action` payload now carries `defenseResolved`, derived the same way as CONFIRM's `actionBase`.
  - Before this, `payloadForPassives` didn't carry it, so `ATTACK_VS_DEF` / `ATTACK_VS_MDEF` always read 0 on that trigger.
  - No authored row gated on them there, so nothing existing changes.
- `_wire-nox-passive-anims.js`: new `addCue` step for Ethereal.

## World (1 actor modified: Nox Wraith)
- Ethereal:
  - `et_anim`: play_animation "Ethereal".
  - A reaction row: `creature_hit_by_action`, source self, `ATTACK_VS_DEF == 1 && INCOMING_DAMAGE > 0`, pointing at `et_anim`.
  - `isReaction` = true.
- The item's rule text is unchanged.

## Checked
- Sandbox sim, party vs two Nox Wraiths:
  - The cue played 4 times, each right after a weapon hit on a Wraith.
  - It didn't play after spell hits.
  - No errors from the change.
- Battle Director unit tests: 31/32 pass. `crisis-keywords.test.mjs` fails the same way without this change (`Hooks is not defined`).
- World export report: 1 modified, 0 added, 0 removed.

## Owed
- A real-table look.
