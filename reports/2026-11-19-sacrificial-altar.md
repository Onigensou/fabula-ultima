# Sacrificial Altar and Fafnir Castle - Entrance (v1.0.633)

The last Valley map and the castle's front door. The **Sacrificial Altar** gets a storm: a cloud sea churning below the cliff, distant lightning in the sky with a soft flash, and thunder as its only sound. The altar sigil now holds Fafnir's event. The party presents one item (the GM judges; the item is **not** taken, as at the Nidhogg barrier). On Accept, a beam falls on them, they spin and are pulled into the sky, and they arrive in a slow whiteout at **Fafnir Castle - Entrance**. The castle gets cloud in its gaps lit from below, candlelight, light shafts, floating debris and rising embers. Designed over 4 rounds of a playable mockup and approved by the user.

## Gameplay

**Sacrificial Altar**, examine the sigil:
- **First time:** the Maelstrom sigil circle fills the plateau, the screen dims, and Fafnir speaks three lines ("…present unto me a **Soul Bound under Covenant**."). Then **Offer Item**: one item, any item, GM verdict **Accept** / **Refuse** (the item stays with the party either way).
  - **Accept:** switch `Fafnir Altar Opened` on, letterbox, shake, "!", the beam, spin, pull-up (Saint1), whiteout. The party arrives at the castle facing the gate. The white holds 1.8 s and lifts over 3 s while the camera draws back, then the camera visits the gate and returns.
  - **Refuse / Take back:** the dim lifts, nothing changes, and it can be tried again.
- **After that:** "Go to **Fafnir Castle - Entrance**?" Yes / No, in the teleporter's own box. Yes plays the beam, spin, pull-up and whiteout to the castle, with no cutscene.

## Code

- **Map storm** (new `map-system/map-storm.js` + pure `map-storm-core.js`, 31 tests): scene flag `ambience.storm`.
  - "above": forked bolts in sky pockets, cut out of the ground's outline so they sit behind the cliff.
  - "below": the cloud under the map flares.
  - Both: a soft screen flicker (none for reduced motion) and thunder 0.3–1.7 s later on the Ambient channel.
  - Each client storms on its own.
- **Map ambience** (`map-ambience.js`):
  - `clouds`: the mockup's cloud sea, ported as is (fbm noise sheets turning round a pivot, masked by the walk-depth weight map's mist).
  - Glows can be coloured objects with a candle `flicker`.
  - `shafts` (light from the top edge).
  - `motes.fromMist` (specks and embers rising out of the cloud).
- **Walk parallax:** `uFlash` (lightning lights mist pixels) and `walkParallax.setFlash()`.
- **Jump To · Levitate**, new options (a plain Levitate, e.g. Deva's exits, is unchanged):
  - `beam` "violet" / "gold": MV `117_light_pillar_1` from the top of the view to the feet.
  - `spin` through the 8 standing directions, slow to fast. Uses the new `spriteFacing.standFor(token, direction)`.
  - `curve: "suck"`: a hover, then an accelerating pull with stretch and afterimages; the flash comes as the token leaves the top of the screen.
  - `glowColor`.
  - 7 new tests.
- **New row "Confirm (Yes / No)"**:
  - It runs on Show Choices' answering (main controller answers, GM can answer from the chip) in a new "confirm" look: the teleporter's parchment box, now `TeleporterSystem.promptBox`.
  - Cancel = No. 7 new tests.
- **Change Scene keeps the screen:**
  - Every client used to drop the event's fade and letterbox at the canvas teardown, so a whiteout vanished mid-load.
  - Now `Flow.travel(id, { keepScreen: true })` (Change Scene only) keeps them through one teardown (60 s failsafe).
  - The scene-change cover takes the fade's colour (`ScreenTransition.nextCover`), so the load stays white.
  - 3 new tests.
- **Lint:** a Confirm with no question warns.

## World data (build script, re-runnable, everything tagged `draftAltar`)

**Sacrificial Altar** (`Valley_Map022`, `or2XPkXT448qmdrh`):
- **Removed:** FXMaster clouds + lightning filter, and the scene playlist / sound. On arrival Foundry stops the previous scene's track; thunder is the only sound.
- **Ambience:** clouds, storm "above", faint violet sigil glow.
- **Added:** marker `Altar Circle`; the event tile (60 px, examine) on the sigil.

**Fafnir Castle - Entrance** (`FafnirCastle_Map001`, `H7A94pOj6BniOQOS`):
- **Removed:** the FXMaster lightning filter.
- **Walk parallax:** on with the mist plate still (churn 0). It only covers the painted debris blocks under their tiles.
- **Ambience:** clouds, storm "below", 15 flame + 4 window glows, 4 light shafts, motes + embers.
- **Added:** markers `Altar Arrival` and `Castle Gate Shot`; 4 debris tiles (bob, elevation 1).
- **Kept:** the Darkness ambience.

**Module assets:** `assets/walk-depth/Valley_Map029.webp`, `Fafnir_Castle001.webp` + `Fafnir_Castle001.mist.webp`.

**Forge** (new files only): `Campaign/The Legend of Dragonslayer/Image/Map/Game Map/Fafnir_Castle001_Debris1..4.png`.

## Tested

- All event-system, jump and storm test files pass.
- In a sandbox copy of the world, every path was played through:
  - first visit with Accept;
  - first visit with Refuse;
  - return visit with Yes;
  - return visit with No.
- Lint: one known false positive (the gate camera marker is on the castle map, reached by Change Scene).
- Both maps at 60 fps.
- **Not checked yet:** a real player client (the offer box is the controller's, and the sandbox drove the controller's requests), and the real-table look.
