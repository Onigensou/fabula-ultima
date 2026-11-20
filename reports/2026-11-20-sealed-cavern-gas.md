# Sealed Cavern arena: churning noxious gas (v1.0.641)

The Sealed Cavern battle map (`Valley_Battlemap004`) loses its slime drips and gets a churning noxious gas at the back of the cave. Code only: no world data, art or migration.

## What you need to do
- Pull and reload. Nothing else.

## What changed
- `battle-stage-ambient-fx.js`: new effect kind `cloudsea`. It's the Sacrificial Altar / Fafnir Castle Entrance cloud sea (`map-ambience.js` `clouds`: fbm noise tiling sheets turning round a pivot and drifting, the Castle Entrance layer set), as a battle-stage effect with a colour (`rgb`).
  - Two masked halves pivot at the glowing cave mouth. The left half turns counter-clockwise and drifts left, the right half clockwise and right, so the gas rolls outward like the plume painted in the art.
  - The mask is an ellipse at the back of the cave, faded out before the floor. Everything sits in one container pinned to the painting.
  - It takes `n: 1` in the budget; `speed`, `alpha` and `size` scale the layer set.
- `battle-stage-3d-rules.js`: the `Valley_Battlemap004` preset adds the cloud sea first (under the haze and glows) and drops the `slime` entry.
- Test: `battle-stage-3d-rules.test.mjs` 216/216 (new check: the Sealed Cavern has the cloud sea and no slime).

## Checked
- Sandbox copy of the world, a real fight (2 Nox Ghouls + Nox Priest) on the arena: 3D camera on, Soul Tithe event, the six sheets drawn and pinned at the back of the cave, 58-60 fps.
