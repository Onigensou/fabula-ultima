# Nidhogg — Boss Design Notes

**Status:** DESIGN DRAFT, started 2026-11-10. Nothing built. Sections marked
**PROPOSED** wait on a ruling from the user. **RULED** means the user decided it.
The user's first round of rulings came in on 2026-11-10 (§1–§4, §7).
**Secret boss.** He does not change the course of the main quest.
**Arena:** `Valley_Battlemap003` "The Great Seal (Battle)" (`7zYxzBQAw6FkcIyM`): a green
sealing circle on a dark cavern floor. The same scene hosts The Great Seal's random
battles, which stay on Lightning Crystal.
**Conflict event:** Soul Tithe (RULED 2026-11-08), see [soul-tithe-design.md](soul-tithe-design.md).
**Naming — RULED (2026-11-11):** the crystal IS Nidhogg, his actual body. Its actor / token is named **Nidhogg**. The
sections below were written when "Nidhogg" meant the dragon sprite and the crystal was "the Sealing Crystal"; read
"the Crystal" as Nidhogg's body and "Nidhogg (the dragon)" as the form that fights (its own name still open). Code keeps
its internal names (`scripts/sealing-crystal/`, flag `sealingCrystal`, defeat style `crystal_death`); what a player or
the GM reads says Nidhogg (the defeat style reads "Nidhogg's crystal body shatters").

---

## 1. Concept — RULED (2026-11-10)

The fight has two parts:

- **Nidhogg**, the dragon sprite. The thing that fights.
- **The Sealing Crystal**, drawn in 3D (not a sprite) with pixel FX. The thing that has
  to break.

**Destroying the Crystal wins the battle.** While Nidhogg is on the field the Crystal is
hidden and cannot be reached. **Each time the party defeats Nidhogg, they get one round
against the Crystal.** Then Nidhogg returns and the cycle repeats.

```
 ┌──────────────── Dragon phase ────────────────┐      ┌── Crystal Round ──┐
 │ Nidhogg fights. Crystal hidden.              │      │ Crystal exposed.   │
 │ Soul Tithe running.                          │      │ Party only acts.   │
 │                         Nidhogg reaches 0 HP ├─────►│ Crystal HP sticks. │
 └──────────────────────────────────────────────┘      └─────────┬─────────┘
            ▲                    Nidhogg returns at round end     │
            └─────────────────────────────────────────────────────┘
                           Crystal at 0 HP at any point → VICTORY
```

---

## 2. The loop, beat by beat — RULED (2026-11-10), edge cases PROPOSED

### 2a. When does the Crystal Round happen? — RULED

**Nidhogg reaches 0 HP → transition animation → a new round starts at once, with the
Crystal.** Any turns left in the round he fell in are lost. That is deliberate: the party
manages the round themselves if they don't want to waste them (for example, land the kill
late in the round, after the others have acted).

(Weighed and not taken: expose the Crystal at once for the rest of the round plus the
next; let the round play out and make the next one the Crystal Round.)

### 2b. Soul Fragments — RULED

**Every Soul Fragment is destroyed the moment Nidhogg reaches 0 HP**, and their destroy
animation plays as part of his transition. Thematic (his hold on their souls breaks with
him), and it clears the field so the party can focus on the Crystal.

RULED 2026-11-10: the destroy follows the ordinary Soul Tithe destroy rule, so each
owner gets their stolen Max HP back plus the same amount of current HP.

### 2c. The beats in order — RULED (2026-11-10)

When Nidhogg reaches 0 HP:

1. The action that dropped him finishes resolving (other targets of a multi-target
   attack still take their damage, its reactions settle).
2. **Transition**: Nidhogg's fall, every Soul Fragment destroyed (refunds paid), the
   Crystal rises out of the seal. One combined sequence.
3. The current round ends **without** its round-end beats (no `round_end` reactions,
   no Soul Tithe lock or Calling). A Soul Tithe lock here would spawn fresh fragments
   straight into the Crystal Round, against ruling 2b.
4. A new round starts: the **Crystal Round**. The round banner announces it.

At the end of the Crystal Round:

1. Ordinary `round_end` reactions.
2. Soul Tithe: nothing to Call (no fragments). **Soul Tithe is suspended while
   Nidhogg is down**, so no lock either. Nothing on the field can wound the party
   in the Crystal Round anyway, apart from their own HP costs.
3. **Nidhogg returns** (§3), the Crystal sinks back (exposed → hidden).
4. Round banner: a normal round.

### 2d. Rulings to confirm — PROPOSED

| Case | Proposed ruling |
|---|---|
| Who acts in the Crystal Round | Only the party, each PC with all their turns. Nidhogg and the fragments are gone and the Crystal takes no turns: a round with an empty enemy side, so no Free Round machinery is needed. |
| Crystal HP | Persists across the whole fight. Damage never heals. |
| Crystal fights back | No (v1). It is an object: no turns, immune to statuses. |
| Crystal defenses | DEF / MDEF and affinities TBD (§5). Immune to statuses, like the Soul Fragment. |
| Nidhogg's fall counts as a defeat for on-defeat skills | Yes. It is a real 0 HP. |
| Statuses and buffs on Nidhogg when he falls | Cleared. He comes back fresh. |
| Nidhogg falls to a `round_end` effect (a DoT) | Same transition; the next round is the Crystal Round. |
| Nidhogg falls in an Ambush Free Round (round 0) | Same transition; Round 1 is the Crystal Round. |
| The Crystal breaks | Victory at once, mid-turn. |
| The party is wiped | Defeat, as usual. |
| EXP / Zenit | Paid once, at victory. A fall pays nothing. |
| Camera moves in the transition | The user's call, as always (no camera work until asked). |

---

## 3. Nidhogg's return — RULED (2026-11-10): full HP + crack escalation

Options:

| Option | Each return | Read |
|---|---|---|
| **Full HP, kit escalates with the Crystal's cracks** ⭐ | Full HP. When the Crystal passes 75 / 50 / 25 % HP it cracks, and each crack unlocks a harder Nidhogg pattern. | Ties the two halves together: hurting the Crystal is what makes the dragon angry. Readable on screen (the cracks ARE the phase indicator). |
| Full HP, same kit | Each cycle is the same fight, only Soul Tithe gets worse. | Simplest. Can feel repetitive by cycle 3. |
| Decaying HP (e.g. 100 → 70 → 50 %) | Each dragon phase is shorter. | Counters the Soul Tithe snowball, so the fight speeds up toward the end. Pairs with either kit option. |

**Ruled:** full HP + crack-stage escalation. Nidhogg's HP pool is sized by sim so that a
dragon phase is 2–3 rounds. Decaying HP stays in reserve if the sims show the Soul Tithe
snowball makes cycle 3 unwinnable.

---

## 4. Nidhogg — who he is, and his kit

### 4a. Lore — RULED (2026-11-10)

Nidhogg was the **king of dragons** in the age of dragons. He was sealed inside the
Sealing Crystal by an alliance: a human king, a dragon slayer, and, in secret, the dragon
**Fafnir** herself. Many lives were sacrificed to seal him, and once he could be contained
for good, everyone left him be. The party has unknowingly released a piece of the seal; now
they must destroy him for good, or he will come back to haunt the world.

**His in-game description only touches the surface:** *the king of dragons, whose soul is
sealed inside a red crystal made of dragon slayer blood and bone.* The alliance and
Fafnir's part stay out of the game text.

For the visuals: the Crystal is his prison and his soul is the green flame inside it.
Nidhogg on the field is what has escaped of him; when he falls, it is drawn back in.
Breaking the Crystal frees nothing: it destroys the soul.

### 4b. Stats — RULED in part (2026-11-10)

| Stat | Value |
|---|---|
| Level | **60** (past the game's level cap of 50, on purpose) |
| Attributes | MIG / DEX / INS / WLP all **d12** |
| HP / MP | **1500 / 400**, placeholder (user, 2026-11-11). Resized by sim once the kit exists. |
| Rank | **the highest there is**: Champion, at the 🌟 Super Boss tier (champion rank, unfair budget, optional/secret; see [hako-superboss-design.md](hako-superboss-design.md)) |
| Turns per round | **4** (`activation: 4`) |

**The dragon actor exists (2026-11-11, uncommitted):** **🌟 Nidhogg, Dragon King** (`UfL16aNJqFM6Zw55`,
folder Current Dungeon), the name the user chose for the form that fights; the crystal body stays "Nidhogg". Sprite =
the user's `worlds/fabula-ultima-2/assets/Beastiary/Nidhoggr_Standard.png` (859 × 837, drawn facing left like every
sprite; enemies are mirrored to face right in battle). A SHELL: no skills, no action pattern, no entrance or defeat
style yet. Built by `tools/fvtt-playwright/scripts/_author-nidhogg-dragon.mjs` (idempotent) as a clone of ⭐️ Fafnir with
every item, effect and table dropped and every Fafnir value reset.
- Ruled: L60, d12 ×4, Champion, 4 turns, 1500 HP / 400 MP (placeholder), affinities all neutral (decide with the kit).
- Placeholders of mine, NOT ruled: status immunities none, weapon efficiencies all 100, Init 16, DEF/M.DEF +6/+6
  (Hilde-Fafnir's, the highest-level champion), Boss + Villain on, 10 Ultima Points, Zero gauge 6, 6000 zenit,
  traits "King of Dragons, Dragon, Sealed Soul", study text = the ruled description (§4a).
- Token: 1.5 × 1.5 grid, scale 5 (Fafnir's), linked, hostile, auto sprite shadow on. Visible size 824 × 802 scene px =
  Fafnir's width, taller than Fafnir (618), about 4.7× a PC (~170 px); the crystal is ~3× a PC.

### 4c. Kit — NOT STARTED

Ideas that lean on the fight's systems (ideas only):

- **Devour.** Nidhogg eats a Soul Fragment to heal or power up. Makes fragments a
  target for both sides.
- **Gnaw the seal.** A charged move that heals the Crystal if not interrupted. Clashes
  with "Crystal damage never heals"; pick one.
- New moves per crack stage (§3).
- Adds? If he summons adds, they need a rule for his fall: vanish with him (like the
  fragments) or stay.
- Zero Power?

---

## 5. Numbers — PROPOSED skeleton

Soul Tithe punishes length: an ignored fragment doubles every round. So fight length is
the main balance lever, more than any single number.

- **Target: 3 cycles, about 9–10 rounds in total** (3 × (2–3 dragon rounds + 1 Crystal
  Round)). RULED 2026-11-10: that is the goal.
- **Crystal HP ≈ 2.5 × the party's focused one-round damage** at this level, so the
  third Crystal Round is the break, and a great round can finish it in two.
- Measure with the sim (`conflictEvent: "soul-tithe"`) and Mindscape once the kit exists.

---

## 6. How it fits the engine — PROPOSED

### 6a. Not a second conflict event

Soul Tithe already holds this fight's conflict-event slot, and events do not stack
([conflict-event-design.md](conflict-event-design.md), "The shape"). The cycle is
therefore a **boss rule** pinned to Nidhogg, like Geist's undying rule
(`battle-end/undying/geist-blackest-night.js`), and not an event. The Geist route itself
(fake victory → BATTLE_ENDING → resume) is too heavy for a fall that happens every few
rounds and should never look like an ending, so the rule rides BD's builtin-reactor seam
plus a round-end beat instead.

### 6b. The Crystal is the battle-ender

The win rule is "the enemy side is wiped when the Crystal is destroyed":

- The Crystal **counts** for `countsForSideWipe` (it is NOT a plain `bdObject`, which is
  excluded from the tally). A fallen Nidhogg plus fragments must never read as a wiped
  side, or his first fall would end the fight as a victory — Soul Tithe's own rule ("all
  real enemies die, fragments remain → victory") has the same trap.
- Like a battlefield object it pays no EXP of its own, takes no turns, and the AI never
  targets it.

### 6c. A general "out of play" primitive

Both the hidden Crystal and the fallen Nidhogg need the same thing: a combatant that stays
in the conflict but is **out of play** — token hidden, untargetable by players and AI, no
HP bar, no turns, no tracker icon, ignored by "all enemies" targeting, and (for the
Crystal) still counted as alive. Nothing in BD does this today (Lightning Crystal and
Soul Fragments are spawned and removed instead). Proposed: one general marker read at the
same sites `battlefield-object.js` lists, so later bosses can reuse it.

### 6d. State

Phase (`dragon` / `crystal-pending` / `crystal`) and the cycle count live on an AE on the
Crystal, per conflict-event rule 2: it survives F5, rewinds with the actor, and replicates.

### 6e. Wiring

Nidhogg's battle payload carries `context.conflictEventId: "soul-tithe"` (proposed
2026-11-08, still unconfirmed). Soul Tithe also needs two new hooks for this fight:
destroy every fragment on Nidhogg's fall (§2b), and stay suspended while he is down (§2c).
The Great Seal's random battles keep the scene's
Lightning Crystal setting. *(Superseded 2026-11-12, see 6f: Soul Tithe goes on the scene.)*

### 6f. Engine rulings — RULED (2026-11-12)

The engine plan's (`tools/nidhogg-fall-mockup/ENGINE-PLAN.md`) eight open questions, answered by the user:

| # | Question | Ruling |
|---|---|---|
| 1 | The cut round: do "until end of round" effects expire? | **No, they carry over** into the Crystal Round (the cut skips the round-end AE sweep too; they run out at the Crystal Round's end). |
| 2 | Dragon MP on his return | **Full MP** (and full HP). |
| 3 | Crystal EXP / Zenit | **None.** A general `noRewards` actor flag, read by the battle-end rewards. |
| 4 | Where the Crystal stands | **Where the dragon stood** (his token's position). |
| 5 | When the fall show starts | **At the killer's turn end**, after the action and its reaction windows (ruling 2c.1). |
| 6 | The Champion red fall + KO pose | **Both skipped.** On-defeat skills still fire. |
| 7 | The return | **Instant swap for v1** at the round boundary; a reverse show is designed later. |
| 8 | Where Soul Tithe is set | **On the arena scene** (Valley_Battlemap003's conflict event), not on the Start Battle row. Every battle on that scene then runs Soul Tithe. |

---

## 7. The Crystal in 3D — method RULED (2026-11-10): our pixel renderer, trial first

### 7a. How to draw it

| Approach | What | Read |
|---|---|---|
| **Our pixel 3D renderer** ⭐ | The `pixel-vfx-materials` ice shape library (`lab/ice-shapes.js` `drawSolid`): a real convex faceted mesh posed in 3D, lit by one light, painted to the ice material rules (dark rim, facet ramp, edge lines, glint). The `prism` and `cluster` meshes are crystals already. | A true 3D solid that turns and catches light, in the same pixel style as every other effect. House-style tier 1. |
| three.js mesh | The vendored three r128 renders a smooth crystal offscreen into a PIXI texture. | Real refraction/shader looks, but smooth shading clashes with pixel FX around it. |

**Ruled: try our pixel renderer first.** The look (the user, 2026-11-10): **a red crystal
with a green flame inside** (Nidhogg's soul, in the Soul Tithe soul-fire colours);
**rotates horizontally** (about its vertical axis); **pointed top and bottom, a diamond
(the suit) overall, but asymmetric.**

Either way the Crystal is drawn as its **own token
art** (a live texture), not as part of the stage camera: players can set Battle depth to
Off, and this scene has no 3D camera preset yet. It then works in 2D and under the 3D
camera alike.

### 7b. States to animate

| State | Look (draft) |
|---|---|
| Hidden | Nothing, or a faint pulse in the floor seal. |
| Rising | Nidhogg's dissolving body streams into the seal; the Crystal rises out of it. |
| Idle | Slow roll (1/6 turn per loop, so it loops seamlessly), hover, inner green pulse. |
| Hit | Struck facet flashes white, chips fly. |
| Cracked (75 / 50 / 25 %) | Cracks painted across facets, more glow leaking through each stage. Doubles as Nidhogg's phase indicator (§3). |
| Sinking | The Crystal drops back into the seal as Nidhogg reforms from it. |
| Shatter | The ice shatter rules: break along facets, shards and glints, the seal on the floor goes dark. |

Palette sampled from the arena's greens. Performance follows the Soul Tithe rules the user
approved: bake the idle loop, live sim only during flares, FX at 30 fps.

**Mockup first**, in an artifact, before anything is built in game.

---

## 8. Mockups

- **Mockup 1 (2026-11-10):** the crystal at rest on The Great Seal. Sources in the
  scratchpad of session fc3159d9, `nidhogg-crystal/` (`fx/crystal.js` renderer,
  `index.html` page, `work/still.mjs` Node stills), built on the vendored pixelfx
  (`burn()` for the soul fire). Controls: damage stage, strike, glass amount, how much
  soul shows through, turn speed, 8 shapes, pixel size, FX rate. About 2 ms a frame live
  (headless, this PC); in game the idle turn would be baked (§7b).

- **Mockups 2–4 (2026-11-10, same artifact):** larger crystal (towers ~3× a PC at pixel
  size 2), soul centred, merged soul fire (`fx/soul-ball-fire.js`, a port of the approved
  `ballFireAura`), more cracks and debris, red aura, rays of light, and a **Battle camera**
  view: the rest framing of a 1920 × 1080 screen on this map with the party on its line.
- **The user's chosen look (2026-11-10), now the mockup's defaults:** glass 95 %, soul
  shows through 40 %, soul fire rage 180 %, rays Strong, ray colour red, one turn 12 s,
  shape 6 (seed 68), pixel size 2, effects at 60 fps.

- **Mockups 5–7 (2026-11-10):** rays come FROM THE CRACKS as soul-green beams in 3D
  (one wide beam per crack starting point plus two thin ones along its cracks; they turn
  with the crystal, foreshorten toward the camera, hide behind it on the far side, stop at
  the floor; none while intact). They burst out in ~0.1 s with a white-hot flash and then
  hold RIGID (the user found the idle sway "too cartoony"). Cracks start from 4 / 5 / 6
  points spread round the crystal per stage, so every stage is always visible.
- **RULED (2026-11-10): the crystal phase is played in deep darkness.** The arena goes
  **pitch black**: the ground is not visible at all (the user, 2026-11-10: "I can still
  see the ground a bit" at 94 %). Only the crystal's own light remains; the units are not
  darkened, and the beams are not stopped by a floor that cannot be seen. Expected in game: fade to
  dark as Nidhogg falls, back to the lit arena as he returns.

- **The crystal's death — RULED script (2026-11-10), mockups 8–9.** ~26 s: the spin slows
  to a stop (0–2 s); four flashes, sudden white easing back (2, 4, 5, 7 s); 3 s of silence;
  a screen flash as cracks spread through the whole crystal (10 s); the soul pours out of
  three cracks well apart, one at a time (10.8, 12, 13.2 s), each shoving the crystal the
  other way with 0.5 s of shake, and **pouring at full force until the end**; the screen
  whites out from the crystal (from 14.4 s); the crystal **shatters early in the white-out**
  (15 s) so the player sees it, its facets flying off as shards while the soul bursts into
  green flame that floats up; full white (17.8 s), then the white clears onto the arena, lit
  again. **No traditional victory screen** ("probably"; what follows the white is still to
  design).

- **Mockups 10–11 (2026-11-10, v13–v33): the death, as it now stands (the build target).**
  Timeline (`crystal-death.js` `DEATH`): the spin stops (0–2 s); flashes at 2 / 4 / 5 / 7 s;
  cracks through the whole crystal + a screen flash (10 s); the soul pours from three cracks
  facing the camera, one at a time (10.8 / 12 / 13.2 s, 3D streams); the **build-up** (13.5–17 s):
  harder and harder shaking, four more pours (14.1 / 15 / 15.7 / 16.3 s), the inside whitens;
  the white-out starts (16.4 s); **shatter at 17.0 s** — the facets break into tumbling 3D glass
  slabs + chips + glitter, and the **11p explosion**: a dip to dark, a 0.07 s hit-stop, a white
  hero frame, the arena lit soul green, a starburst, two 3D shock rings, spark streaks, the soul
  bursting from the whole crystal shape; full white (19.8 s), held to 20.4 s, clears onto the lit
  arena by 22.4 s; end 28 s. An anime impact frame was tried and removed ("maybe next time").
- **The death's camera (mockups 11f–11o):** from 10.8 s the game's 3D camera orbits round the
  crystal and down to a low spot close to it (eye 0.6 m), square to the party line through the
  Blanche / Keren middle (done by 13.5 s); the GM desk and player HUD slide away and the party
  tokens are hidden while it stands there; from 15 s an accelerating pull-away to 28 m, its stop
  hidden by the full white, and back to the battle framing under the white. Built as a **placed
  shot** in the game camera (`battle-stage-3d-rules.js` `placedRig` / `orbitPath`,
  `camera.stand(...)`), uncommitted.

## 8b. The dragon's fall → the crystal — RULED (2026-11-11), mockup FINAL (the build target)

Mockup: https://claude.ai/artifact/Kao8wZHgeyWuin23TZZ4Lp (v15, "Current pick"). Sources (local, gitignored):
`tools/nidhogg-fall-mockup/` (`index.html` is BUILT by `bash work/build.sh` from `work/style.css` + `work/body.html` +
`work/script.js`; effects in `fx/`). Engine plan (seam, phases, out-of-play AE, open questions):
`tools/nidhogg-fall-mockup/ENGINE-PLAN.md`.

**Look rulings.** The dragon's BODY turns into black smoke (front "From his core": charge → white flash → a ragged
edge chars him black and each charred pixel lets go as smoke, lit green from below) and the smoke swallows the arena.
The soul is ALWAYS inside its crystal (never shown alone, the crystal never forms round it late). The light pulses in
BOTH colours (red halo painted as stepped bands round a green core — added red + green turns yellow). No camera moves
except the ones below. The smoke's engulf texture must not repeat (one frame-sized field, 2 octaves, the second
rotated); the arena is drawn exactly as long as the smoke (it once blinked back for 0.1 s). The drawn-in swirl
(mockup 4) and the slow multi-line light pass were REJECTED.

**First fall (20.6 s)** — `COMBO.first` in `fx/void-birth.js`, `SHOW.first` in `work/script.js`:
| t (s) | beat |
|---|---|
| 0.1–1.0 | his soul's light gathers (rim crackle, streaks into the core, shudder); the HUD fades out 0.15–0.6 |
| 1.0 | white flash + floor ring |
| 1.07–3.7 | body → smoke; engulf 3.0–7.0 — **covers the party and summons too** (first fall only) |
| 6.7–7.4 | the smoke's last light sinks to black; **black at 7.4** |
| 7.5–8.2 | camera moves (unseen) so the crystal is centred on screen |
| 10.4 / 11.9 / 12.8 | three blips (red + green point of light, rings; 2 s of nothing before the first, a longer gap after it) |
| 13.2–14.6 | the crystal fades in **SOLID** (opaque: no soul, no inner light), then holds solid |
| 17.2 (0.45 s) | ONE quick thick flash crosses it in 3D (bends at every facet edge; facets facing the light brighter, edges flare white); behind it the glass is clear |
| 17.65 | his soul in plain sight, soft swell, no screen flash |
| 18.2–19.4 | camera back to the battle framing; the party fades back in 18.5–19.4 |
| 19.4–19.9 | the HUD returns; the battle continues (Crystal Round) |

**Later fall (5.8 s)** — mockup 3's blip with the debris removed: charge 0.08–0.38, flash 0.38, smoke by 1.5, black
3.25, pulses 3.35 / 3.8, red motes gather 3.5–4.25, a breath in, **the crystal pops in at 4.3** (white frame, shake,
shock rings, glitter, screen flash, the cracks it has, NO glass shards: `crystal.js st.debris = false`). The party stays
visible; no camera moves; the HUD stays.

**Crystal renderer additions** (port into `scripts/sealing-crystal/crystal-render.js`; the mockup's `fx/crystal.js`
was v3 + these): `st.reveal` 0..1 (facets lit one by one), `st.opaque` 0..1 (front glass alpha → 1, inner light leak,
back edges, crack beams off), `st.sweep { pos, k, before, after, lines:[{o,w,k}] }` (the plane of light in 3D: faces carry
`n` + `a` for per-pixel depth), `st.debris` (false = hit shake + white frame without shards). Defaults draw as before.

**HUD hiding = a reusable primitive** (the user: "might be used many times in the future"): ref-counted
`hide(reason) → token` / `show(token)`, every client, fades, safety release at battle end / scene change. Nothing like it
exists yet (the death show fades the desk/HUD itself — fold that into the primitive).

**Sound — RULED (the user's picks, 2026-11-11).** Game convention (`scripts/shared/sfx-cues.js`): a one-shot starts at
max(0, beat − peak). Files are Forge `Sound/` (`Soundboard_X.ogg` in the mockup = `Soundboard/X.ogg`). Volumes as listed.
| moment | first fall | later fall | file (peak s) | vol |
|---|---|---|---|---|
| soul's light gathers | beat 1.0 | beat 0.38 | Soundboard/Magic3.ogg (0.05) | 0.5 |
| white flash | 1.0 | 0.38 | Flash.mp3 (0.5) | 0.55 |
| body → smoke | — | — | (none) | |
| the smoke swallows all (BED: fade in 0.8 s, loop, fade out over the last 1.2 s) | 2.8–7.4 | 1.0–3.25 | BGS/Darkness.ogg | 0.5 |
| each blip | 10.4, 11.9, 12.8 | — (none) | Soundboard/Blind.ogg (0.15) | 0.5 |
| red motes gather | — | 3.95 | Soundboard/Magic2.ogg (0.6) | 0.45 |
| the crystal pops in | — | 4.3 | Soundboard/Ice2.ogg (0) | 0.5 |
| crystal fades in solid | (none) | — | | |
| the flash passes through | 17.35 | — | Soundboard/Wind1.ogg (0.4) | 0.55 |
| his soul shows | 17.7 | — | Soundboard/Fire1.ogg (0.35) | 0.5 |
| HUD returns | (none) | — | | |
The picks also live in the artifact db (`picks/current`, ArtifactData get). Mockup engine: `fx/sfx-track.js`.

## 9. Open questions (for the user)

1. Nidhogg's kit theme (§4c). HP / MP set to a 1500 / 400 placeholder.
2. ~~Who makes the Nidhogg actor and sprite~~: the user drew the sprite; the dragon actor is made (§4b).
3. Rise / sink animations (§7b) are not mocked up yet; the death is (§8).

## 10. In-game build

**Step 1 — the Crystal as live token art: BUILT (2026-11-10, uncommitted).**
`scripts/sealing-crystal/`: `crystal-render.js` (the mockup's `fx/crystal.js`, ported 1:1; the
only change is a faster triangle fill, proven pixel-identical over 282 frames incl. the death),
`soul-ball-fire.js`, `crystal-death.js`, `crystal-painter.js` (one crystal + its frame, 608 × 548
effect px, feet at 304, 424), `crystal-worker.js` (the painter in a module Worker),
`crystal-runtime.js` (the host on every client), `crystal.test.mjs` (Node checks).

- Any token flagged `flags.fabula-ultima-companion.sealingCrystal` (token or actor) is drawn as
  the crystal at its feet (the 3D camera's `drawnMap` when it runs), 1 effect px = 2 scene px on a
  110 px grid, at the token's own depth; the token's own art is drawn invisible.
- Crack stage from HP (≤ 75 / 50 / 25 % → 1 / 2 / 3): a new stage plays its crack reveal, beam
  burst and a hit; any HP drop plays a hit.
- Cost: painting 8–16 ms a frame idle, 18–28 ms dying (Node) — all of it in the Worker; the main
  thread only uploads two textures. One frame in flight at a time, at the "Effects frame rate"
  option (60 / 30). No Worker → painted on the main thread at 15 fps.
- Verified on the Staging World (Great Seal, rest framing): stages 0–3 by real HP writes, the
  token mesh hidden, the host goes with its token (`tools/staging-world/sealing-crystal-look.mjs`).

**Step 3 — the Great Seal's 3D camera preset: BUILT (2026-11-10, uncommitted).** `PRESETS.Valley_Battlemap003 =
{ horizon: -78, strength: 0.583, stage3d: { relief: true, backRow: 222, frontRow: 547 } }` + depth map
`assets/battle-depth/Valley_Battlemap003.webp` (tools/battle-depth). Horizon from two independent reads that agree:
the depth model's floor fit (-67 / -75) and the seal's rings fitted as floor circles (-80 / -86). The mockup's guess
(-590, strength 0.35) was far off. Verified in a real battle on the Staging World: the camera runs, back row drawn at
0.73, front clamped at 1.12, every named shot renders (`tools/staging-world/great-seal-3d.mjs`). ⚠ The death's
camera move (§8) was tuned on the old guess: re-rendered with the real preset, the rest framing is identical but the
crystal comes out much larger in the placed shot (13.5–15 s) — retune STAND / BACK when porting the death.

**Step 2 — the death cinematic: BUILT (2026-11-10, uncommitted).** `crystal-death-show.js` (the show, every client),
`crystal-death-camera.js` (the camera plan, pure + `crystal-death-camera.test.mjs`), `crystal-host-lib.js` (what the idle
host and the show share). Trigger: the crystal's actor carries `defeatStyle: "crystal_death"` (new external style in
`defeat-styles.js`); the director's defeat plays the show on every client and removes the token once the white has
cleared (22.4 s); the show outlives the token (embers to 28 s). It owns a larger painter frame (1120², for the burst),
turns the arena pitch black above the backdrop, plays the screen beats on a DOM overlay (crack flash, dip, hero frame,
green arena light, white-out, shake), drives the 3D camera from its own clock (`camera.claim` + `camera.set`, new in
`battle-stage-3d.js`), and fades the GM desk / player HUD / round bar / token overlays and hides the other battlers
while the camera stands. Camera retuned for the real preset: the stand's lens is SOLVED so the crystal is 74 % of the
screen height (what the user approved in the mockup). Off the 3D camera the crystal stays put (mockup camera-off).
Verified on the Staging World (Great Seal, real battle, 3D camera): stepped through 24 beats with screenshots, clean-up
after the end; and through the director (a flagged staging actor struck to 0: the show starts, the token goes 24.5 s
later). Rigs: `tools/staging-world/crystal-death-show.mjs` (PART=A stepped, DIRECTOR=1 the real defeat).
Open: the death paints ~20–25 ms a frame in the Worker (≈30–40 fps), the pours need cutting for 60; what follows the
white (victory screen or not) is still the director's usual victory; no sound yet.

**The battle's ending — RULED (2026-11-11), BUILT (uncommitted).** Full white → hold 5 s → fade to black (1.5 s) →
the GM's battle-end prompt above the black → a quiet result screen → the party is put at the battle's return point. The
music stops on the killing blow. Built as general parts, none of them naming this fight:
- Defeat style keys (defeat-styles.js): `startOnHit` (now also on `crystal_death`), `stopsBgm` (the GM cuts the battle
  BGM the moment the defeat begins, restarts it if the defeat is undone), `battleEnd: { quiet }` (read by the
  orchestrator). External players get `lastFoe`; external styles are no longer slowed as the finisher.
- The death show's ending "black" (crystal-death.js `ENDING`, `endingScreen`, `ENDING_BLACK_AT` 26.3 s) when the crystal
  is the last foe; the removal (so the battle end) waits for the black. Not the last foe → the old clear-back. The black
  stays until the scene change (canvasTearDown) or `releaseCrystalBlack` (GM's `fu-director-stopped` → socket).
- Battle end: the prompt opens with music + pan unticked and sits above the black (z 10060, !important); the result
  screen skips the level-up sound (EXP ticks stay).
- Return point: payload `context.return = { sceneId, x, y }` → the prompt's default return scene; the transition moves
  the party token there (teleporter cross-scene). Event Start Battle rows: new "Return to" + "Arrive at" (door tile id,
  marker token, "x, y", blank = spawn). `fu.battleEnd` now carries `returnSceneId`.
Verified on the Staging World (`tools/staging-world/crystal-ending.mjs`, run results/crystal-ending4): white held, black,
removal after black, prompt above black + quiet + return scene default, result screen quiet (6 ticks, 0 level-up sounds
with 5 level-ups), party landed at the point, overlay gone. Timing on the real GPU (run results/crystal-ending5-gpu, all 24 checks PASS): the death begins 0.03 s and the music cut is confirmed 0.04 s after the damage write; black at D 26.4, removal and prompt right after. (The software-GL runs were ~1.2 s late on every timer and cannot judge timing.) The crystal actor (Nidhogg) must be Soldier/Elite with no creature_defeated rows of
its own, or the on-hit start (and with it the early music cut) falls back to the settle.
**"Outside" — RULED (2026-11-11):** the Underground Area (`Valley_Map009`, `09CApvaBfOesGfbp`), on the node just before
the Nether Bridge: tile `DbXpdY0hHtGbDCPX` (centre 1289, 1921; its one link goes to the Nether Bridge door
`pS0b6DNaLc7WBw7S`). On the Nidhogg Start Battle row: Return to `Valley_Map009`, Arrive at `DbXpdY0hHtGbDCPX` (a node on a
dungeon map is landed on with the party token offset, as a walk does).

**The fight loop — BUILT (2026-11-12, uncommitted) as the general Boss Cycle.** The user asked for it not to be a
Nidhogg special case: any boss with a CORE (defeat the boss to expose the core for a round, break the core to win) is
now DATA on the boss actor, `flags.fabula-ultima-companion.bossCycle`, run by `battle-director/boss-rules/boss-cycle.js`
on the generic boss-rule seams (`boss-rules.js`). Nidhogg's settings (written by
`tools/fvtt-playwright/scripts/_author-nidhogg-crystal.mjs`):
`{ core: <Nidhogg crystal id>, exposeRounds: 1, cutRound, carryRoundEffects, holdConflictEvent, clearStatusesOnDown,
onDown: { conflictEventAction: "destroyAllFragments" }, returnHp/Mp: "full", roundLabel: "Crystal Round",
transition: { first: "nidhogg-fall-first", repeat: "nidhogg-fall-repeat", return: null }, stage: "core-hp-quarters",
voidWhileExposed: true }`.
- Named pieces (`boss-cycle-styles.js`): transitions (a show + its beats `down` / `hidden` / `reveal`; Nidhogg's fall
  registers both variants in `nidhogg-fall-show.js`; `return` plugs in the same way) and stage readers.
- **`BOSS_STAGE`** (formula identifier): Nidhogg = the crystal's cracks, 0 intact, 1 / 2 / 3 at or below 75 / 50 / 25 %
  of its HP — his kit escalates on it (§3). 0 in any battle no rule claims.
- The crystal actor **"Nidhogg"** (`nR6asin3do1U1eLj`, Current Dungeon): Soldier, no items, activation 0, immune to
  every status, **weak to all nine damage types and every weapon at 100 %** (ruled 2026-11-12: nothing can add a
  weakness), unlinked, `sealingCrystal` + `noRewards` + `defeatStyle: crystal_death`. HP 2500 / DEF +0 are placeholders.
- General pieces it uses: Out of Play (`out-of-play.js` + `out-of-play-render.js`), the HUD curtain
  (`shared/hud-curtain.js`), `noRewards`, Soul Tithe's `destroyAllFragments` action, the arena void source.
- Arena: Valley_Battlemap003's conflict event set to Soul Tithe (ruling 8).
- Verified on the Staging World (`tools/staging-world/nidhogg-crystal-mode.mjs`): crystal spawned out of play, a fall
  with a fragment on the field (destroyed + refunded), no victory on his 0, the cut round (no round_end, no lock), the
  Crystal Round (party only, crystal targetable, dragon out of play), his return (full HP/MP, 4 turns), a second fall,
  the crystal broken → its death. A sweep that put "KO" on the down dragon at every turn_start was fixed
  (`sweepDefeat` skips out-of-play / rule-owned falls). Tests: `boss-cycle.test.mjs`.
- Known: his actor is LINKED, so HP he ends a lost battle with carries into the next attempt; the event that starts
  the battle should set him to full.

**Not yet:** the crystal-phase darkness / void for the idle crystal (beams then pass the floor line), turning the idle
crystal with the 3D camera's line of sight, the Crystal actor (Nidhogg, the body), the fight loop (§2, §6). The dragon actor is made (§4b).
