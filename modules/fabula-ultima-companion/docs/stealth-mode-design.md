# Stealth Scene Mode

A turn-structured infiltration layer. One party token on a real grid, enemies
that see, and an Alert Level that decides how the fight starts.

Armed by the scene flag `sceneMode = "stealth"`.

## Turn structure

```
IDLE → PREP → ROUND_START
  → PLAYER_START → CONTROLLER_PICK → ACTION ⇄ RESOLUTION → PLAYER_END
  → ENEMY_START → ACTIVATE (×3) → REINFORCE → ENEMY_END
  → ROUND_END → ROUND_START …

exits: CONFLICT_HANDOFF · STOPPED
```

`ACTION ⇄ RESOLUTION` is the pair that matters. The player spends from a
movement pool and one Objective slot **in any order**, and every committed step
round-trips through RESOLUTION so detection is evaluated **per cell entered**,
never once at the end of a move. That is what makes walking into a cone stop
you at its edge instead of three cells past it.

## Who drives what

The **controller's player** clicks; the **primary GM** decides. Every roll,
alert change, spawn, EXP write and conflict launch resolves GM-side over the
socket, serialised through `director.serialize()`.

That serialisation is load-bearing, not hygiene: a stealth turn fans a
detection roll, an alert write and an AI decision at the GM, all three
read-modify-write against the same scene flag. Unserialised, the last writer
wins with stale data — the same class of bug `DP.gmSerialize` exists to prevent.

Raw `game.socket` delivers to **every** GM and this game normally runs two, so
`isPrimaryGM()` gates the intent handler. Without it every player action would
resolve twice.

The client's reachable-cell map is a convenience, not a permission: a move
intent is re-pathed against the GM's own lattice before a single cell is walked.

## Grid: Foundry's coordinates, our movement

Square grid, 8-way facing. The adapter (`sm-grid.js`) keeps hex viable but
square is what this is built and tested against.

**Foundry's grid stays.** `getOffset` / `getCenterPoint` / `getTopLeftPoint`
already agree with walls, lighting, token snapping, the camera and the ruler.
Reimplementing that means reimplementing agreement with all five.

**The movement layer is ours**, because Foundry has no answer for an occupancy
lattice, movement points, wall-aware reachability, or an AI that can path.
Native dragging can express none of it, and is blocked while a run is live
(the GM is exempt; their drag re-syncs the state instead of being refused).

- `sm-lattice.js` — passability, cover, occupancy, light. Rebuilt wholesale on
  any wall/tile change; ~1,200 cells is sub-millisecond, and incremental
  invalidation is where this kind of cache goes subtly wrong.
- BFS for the reachable set (the overlay), A* for a committed route.

## Facing

Lives in data and overlay, never in the sprite. Tokens have no directional art
and vertical-flipping an orthographic sprite looks wrong, so **the vision cone
is the facing indicator** — intent and danger in one glance instead of two.

Front/Flank/Rear is derived, never stored, from the angle between the observer's
facing and the bearing to the target:

| Arc | Angle | Sight | Takedown |
|---|---|---|---|
| Front | 0–45° | full range | forbidden |
| Flank | 45–135° | reduced (`flankRangeMult`) | allowed, no bonus |
| Rear | 135–180° | proximity only | allowed, DL reduced |

One derivation feeds detection, Takedown eligibility and the GM's flavour.

## Alert vs awareness

Two quantities, deliberately kept apart. Conflating them gives you either a room
that reacts as one organism, or a tier nobody can read.

**Alert** is scene-wide, three tiers, what the party sees, and it decides how a
conflict opens — mapped straight onto `battlePlan.engagement`, which the Battle
Director already implements:

| Tier | Engagement | Meaning |
|---|---|---|
| Stealth | `advantage` | party acts first in round 1 |
| Neutral | `normal` | initiative as usual |
| Alert | `ambush` | enemies act first |

**Awareness** is per-enemy and continuous. It drives that guard's own AI state.
Only a spot or a loud event moves the scene-wide tier.

Raised by: entering a cone, proximity, noise (Dash, breaking cover, a failed
Takedown), a guard reaching a takedown victim's last cell, or GM fiat.
Lowered by: the **Hide** objective, or optional passive decay
(`alertDecayRounds`, **off by default** — automatic cooling undercuts the
tension the mode exists for).

## Enemy AI

Four states per enemy. Simpler than the Action Pattern combat AI, because the
decision space is "where do I stand and which way do I look".

| State | Behaviour | Leaves when |
|---|---|---|
| `PATROL` | walks an authored route, or holds a post and sweeps facing | awareness ≥ `suspiciousAt` |
| `SUSPICIOUS` | turns to face the stimulus and **stops** | awareness ≥ `searchAt` → SEARCH; decays → PATROL |
| `SEARCH` | paths to the **last known cell**, not the real one | sighted → CHASE; `searchPersistence` rounds → PATROL |
| `CHASE` | paths at the true position; **Alert tier only** | contact → conflict; `chaseGiveUp` rounds → SEARCH |

**Last known position is the entire trick.** An AI that always paths at your
true cell is an oppressive bloodhound; one that paths at where it last *saw* you
produces every good stealth moment — the guard checking the wrong corner, the
pillar that works. It costs one stored cell per enemy.

**SUSPICIOUS not approaching** is the other half: it hands the party a full
round to break line of sight, which makes a near-miss readable as a near-miss.

Three activations per round, each enemy at most once. Priority is hunting →
most aware → nearest, so the budget is spent on the guards who matter. The GM
can force an activation from the panel.

**Speed parity** (`enemyMove` = `partyMove`, per the brief) means a CHASE is
mathematically inescapable — the gap can never close. Dash is the only escape
lever, which is why `enemiesMayDash` defaults to **false**. Those two knobs are
where "is Alert survivable" gets settled.

## Objective actions

One slot per Player Phase. Ids match world Items flagged
`coreAction: "objective:<id>"`.

| Objective | Check | Effect |
|---|---|---|
| Scan | INS-based | reveals positions, facings, AI states |
| Hide | DEX+INS vs awareness DL | lowers Alert one tier; forbidden inside an active cone |
| Dash | none | `+dashBonus` movement; noisy |
| Takedown | DEX+INS vs dynamic DL | removes an adjacent enemy silently |
| Move Object | MIG-based | shoves a movable prop; noisy |
| Diversion | varies | moves enemies' last-known cell to a chosen point |
| Break Cover | MIG-based | destroys a destructible prop; very loud |
| Custom | GM picks pair + DL | **the roleplay space** — already shipping |

### Takedown

Stealth or Neutral only, adjacent only, never from the front arc.

```
DL = clamp( base + rank + levelCoef×(target.level − leader.level)
            − rearBonus − stealthBonus, dlMin, dlMax )
```

The brief's flat +1 during Stealth is applied as a −1 to DL — same thing, and it
keeps every term pointing one direction.

**Success**: the token is hidden (not deleted, so a GM can reverse it and the
world actor is never touched) and the kill is banked. Nearby guards gain
awareness — a missing guard is itself a stimulus, which is what stops a stealth
run being a free win.

**Failure**: the guard reacts and contact follows, at whatever tier the failure
produced — *not* a forced ambush. A botched takedown from Stealth still opens
with Advantage; punishing the fumble twice makes the option unusable.

### The EXP ledger

Takedowns pay **EXP only** — no Zenit, no loot — through `shared/exp-core.js`.

Kills are **banked and batched**, settled at scene end (and before battle EXP if
the run collapses into a conflict, so the two awards read separately).

Batching is the balance, not an optimisation. Paying each kill out immediately
would give every one the full first-enemy weight (1.00) **and** its own EXP
floor, so six guards picked off individually would out-earn the same six fought
together — the exact inverse of the intent. Running the banked list through the
shared v1.2 formula as one virtual encounter applies the diminishing weights and
the single clamp exactly as a fight does.

```
EXP_takedown = clamp( P×G×R×β × takedownExpMult, takedownExpFloor, 15 )
```

The multiplier lands **before** the clamp with its own lower floor. Clamping
first would let the floor of 1 swallow the discount on small hauls.

At `takedownExpMult = 0.7`, six level-appropriate soldiers pay 3.50 fought and
2.45 taken down — roughly **1.4× slower** levelling. A level is 9 points wide
and the cap is 15, so a big haul can still level a character outright.

## Terrain

**Walls stay native.** 173 already exist on the prototype scene, the GM authors
them with a tool they know, and one call answers both "can I walk here" and "can
that guard see me".

**Props are ours**, because a Foundry wall cannot be pushed. A crate is a Tile
carrying `flags.<module>.stealthProp`:

```js
{ enabled: true, cover: true, solid: true, movable: false, destructible: false, hp: 1, label: "" }
```

The lattice derives blocked cells from the tile's bounds by sampling its
footprint — a 21px barrel on a 35px grid must not be rounded away. Destroying or
shoving one rebuilds the lattice; no wall document is ever touched.

Only *flagged* props are interactable. The prototype map carries 64 decorative
tiles, and letting the player shove arbitrary scenery would turn every barrel
into a puzzle piece the GM never authored.

## Room for the GM

The FSM's job is to be **interruptible, not complete**. No ruleset anticipates
"the party hides in the water and holds their breath"; what it can do is stay
out of the way.

- **Custom Objective** — the player describes, the GM sets the check.
- **GM panel** — raise/lower Alert, force an activation, spawn a reinforcement,
  settle the ledger, end the run, and read the log.
- **Ad-hoc check** — `ONI.CheckRequester` with a free label, no Objective spent.
- **Narration broadcast** — GM prose pushed to every client.

Every panel action lands as an ordinary event on the same queue a player click
uses, so improvisation is a real transition rather than a hack around one.

## Files

```
scripts/stealth-system/
  sm-constants.js      tunables, flag keys, enums, hooks
  sm-grid.js           square/hex adapter, facing, Front/Flank/Rear
  sm-lattice.js        occupancy, cover, light, BFS reachability, A*
  sm-vision.js         cone + LOS + cover → detection outcome
  sm-state.js          runtime model, alert tiers, awareness, persistence
  sm-states.js         FSM state set + transition table
  sm-director.js       dispatch lock, hook/timer registries, start/stop
  sm-handlers.js       what each state does
  sm-enemy-ai.js       PATROL / SUSPICIOUS / SEARCH / CHASE
  sm-actions.js        objectives, takedown, EXP ledger
  sm-reinforcement.js  spawn markers, caps, table draw
  sm-conflict.js       Battle Director payload, engagement mapping
  sm-socket.js         player → GM routing, primary-GM gate
  sm-overlay.js        reachable cells, cones, facing chevrons
  sm-ui.js             Alert HUD + command blade
  sm-gm-panel.js       GM overrides, narration, ad-hoc checks
  sm-boot.js           scene gate, intent validation, public API
  sm-core.test.mjs     70 assertions over the algorithmic core
```

Touched outside the folder: the scene-mode `<option>` and whitelists in
`dungeon-configuration-ui.js`, the mode branches in `movementControl-*` and
`camera-follow-actor.js`, and `module.json`. All additive.

## Tuning

`TUNE_DEFAULTS` in `sm-constants.js` → world setting `stealthTuning` (JSON) →
scene flag `stealthConfig.tuning`. Most specific wins. No number in the ruleset
is written into logic anywhere else.

## Authoring a scene

```js
const API = FUCompanion.api.stealth;

// Which way a guard starts looking
await API.setFacing("<tokenId>", "NE");

// A patrol route, in cells
await API.setRoute("<tokenId>", [{i:5,j:3}, {i:5,j:9}, {i:9,j:9}]);

// Where reinforcements walk in from
await API.setSpawnPoints([{i:0,j:0}, {i:29,j:35}]);

API.status();   // running state, round, alert, counts
```

Scene flags: `stealthConfig = { routes, facings, spawnPoints, reinforcementTable, tuning }`.
Runtime: `stealthState` (one flag; an F5 mid-turn resumes at the top of the
player's turn — mid-enemy-phase is not safely resumable, and rewinding can only
ever give the party back a fraction of a turn, never take one).

## Not yet done

- **Not live-tested.** 70 offline assertions cover the algorithmic core; nothing
  has run in a browser.
- Objective Items are not authored as world content yet — the UI drives the ids
  directly. A migration mirroring `2026-08-31-objective-common-author.js` would
  make them real CSB Items with authored descriptions.
- No scene-config UI for prop flags, routes or spawn points; the console API
  above is the authoring surface.
- The prototype scene `Vmpo8fzLeKfnlSzm` is still `grid.type = 2` (hex). Flip it
  to `1` (square) before testing.
