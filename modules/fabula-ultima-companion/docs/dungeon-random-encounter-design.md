# Dungeon Random Encounters — selection and launch

How a Random Battle tile becomes an actual battle. Shipped 2026-08-20 on
`feat/dungeon-auto-random-battle`.

Related: [dungeon tiles](../scripts/dungeon-pathing-system/), the Battle Director
(`battle-director-design.md`), and the Monster Encyclopedia
(`../scripts/encyclopedia/encyclopedia-core.js`).

---

## Why this exists

The tile used to roll the encounter chance **and** the ambush/advantage
engagement, post a chat card, and stop. The GM then opened the Battle Prompt and
re-picked, by hand, the engagement the tile had already rolled and discarded.
That was a dead pause in the middle of play.

The half-manual shape was deliberate — it let the GM plant an unseen monster or
stage a set-piece. The redesign keeps that authority but takes it **off the
critical path**: the common case runs end to end, and the GM intercepts only when
they want to.

No new engine capability was needed. Every piece already existed; they just were
not connected.

---

## Flow

```
player confirms a move onto a Random Battle tile
  └─ tile-event-random-battle.js  (any client — thin request only)
      └─ DP.Socket.requestRandomBattle → DP.RandomBattle.run()  (ONE GM)
          1. d100 vs random_battle_percentage
          2. miss → "Nothing appears…" card, rate climbs 20–30 → turn ends
          3. hit  → resolve the group (novelty-biased)
                  → roll engagement from the flat percentages
                  → encounter SFX (broadcast)
                  → GM override window, ~2.5s
                  → rate halves (floored at minimum_encounter_percentage)
                  → battleDirector.start({ payload })
          4. Director: shatter → curtain → spawn → round-1 AMBUSH!/ADVANTAGE!
```

Battle end returns the party to `context.sourceSceneId` — the dungeon scene —
and the pathing graph re-activates on `canvasReady`. There is no bespoke return
path.

### Why the GM resolves

Two independent reasons:

1. The rolls used to be bare `Math.random()` on whichever client walked the turn.
   That was fine when the only consequence was a chat card. Now that they decide
   real combat they must be authoritative on one client.
2. `battleDirector.start()` is GM-only.

socketlib's `executeAsGM` routes to exactly one GM, and the GM-direct branch in
`DP.Socket.requestRandomBattle` runs locally — so exactly one client resolves
either way. **No primary-GM gate is needed here**, unlike the raw `game.socket`
channel in the same file, which broadcasts to every GM and does need one.

---

## Novelty bias

The dial that makes encounters lean toward monsters the party has never fought.

**Where "seen" comes from.** The Monster Encyclopedia creates a placeholder page
the first time a monster is spawned into a battle
(`ensurePlaceholderPagesForTokens`, called from the Director's init). So
`getPageForActor(actor.uuid) === null` **is** "never encountered". There is no
second seen-list to keep in sync.

`isUnseen()` fails **closed** — if the encyclopedia API is missing, everything
counts as seen and the draw is unbiased. The opposite default would treat a whole
dungeon as novel on a load-order hiccup.

**The weight.** Rows are read straight off `table.results` rather than through
`table.roll()`, so the bias multiplies the author's own odds instead of replacing
them:

```
base   = range[1] - range[0] + 1        // a 3-wide row stays 3× as likely
weight = base × (1 + bias × distinctUnseenMonstersInRow)
```

`bias` is the per-scene `oniDungeon.encounterNoveltyBias` (default `1`, `0`
disables). Counting is **distinct monsters**, not slots — `"Mana Ray, Mana Ray"`
is one new monster, not two.

Worked example at `bias = 1` over six 1-wide rows:

| unseen in row | weight | share |
|---|---|---|
| 0 | 1 | 10% |
| 1 | 2 | 20% |
| 2 | 3 | 30% |

**It degrades on its own.** Once every monster has a page, every multiplier is
`1 + bias × 0 = 1` and the draw is exactly the authored table. No exhaustion
check, no reset.

### ⚠ The formula ceiling is load-bearing

Reading `results` directly is what makes the bias possible — and it also
bypasses the die. **A row parked above the die maximum is the house idiom for
"list this monster in the bestiary but never roll it."** `Ancient Temple -
Enemies` is `1d8` with `⭐️ Geist` at row 9 for exactly that reason.

So `rollableRows()` drops every row whose range starts above the formula's
maximum, and the maximum is obtained by asking Foundry
(`new Roll(formula).evaluateSync({ maximize: true })`) rather than by pattern-
matching, so it stays in parity with what `table.roll()` would accept. A regex
fallback covers the house `1dN` for environments without `Roll`.

A formula neither Roll nor the regex can read means Foundry could not have
rolled the table either, so it is treated as **unusable** — the draw falls back
to the Enemies table, then to a graceful miss. Never to an unbounded draw.

Without this filter the bias makes things actively worse, not merely
unfiltered: an unfought boss is by definition unseen, so it would be the single
most-favoured row on the table. The offline check covers this case, and a
negative control (formula blanked) confirms the guard is what excludes it —
Geist is otherwise drawn ~16% of the time.

`Random` keyword slots go through `table.draw()`, which honours the formula
already, so that path was never exposed.

`Random` keyword slots are skipped when counting novelty — a row is not more
novel just because it contains a wildcard — but they still resolve normally from
the Enemies table at pick time.

Verified offline: `node tools/random-battle-novelty-check.js` asserts the
10/20/30 split, the flat spread at `bias = 0`, and the automatic collapse once
the roster is exhausted.

---

## GM control

Two intercepts, both GM-only:

**The override window** — a ~2.5s toast naming the resolved group (and flagging
any first encounters), with *Fight now* and *Customize…*. It runs **while the
encounter SFX plays**, so the pause it adds sits inside a beat the players are
already watching. Untouched, it launches.

**The curate toggle** — 🎬 in the dungeon HUD, GM-only, dungeon scenes only. When
ON, the next random battle skips the timer entirely and opens the Battle Prompt.
It is one-shot: `run()` clears it as it fires. This is the pre-emptive path for
when the GM already knows they want to author the next fight, and it costs zero
latency on every other encounter.

> **Customize does not pre-fill the Battle Prompt.** It runs the standard
> `BattleInit — BattleInit Manager` macro, exactly as the ⚔️ button does.
> Pre-filling would mean editing the live Battle Prompt macro, which is
> world-authoritative and has diverged from the source copy in the repo. The
> toast names the group and the engagement, so a GM who wants to reproduce the
> rolled encounter can. Revisit only alongside a deliberate Battle Prompt change.

---

## Engagement

Unchanged in every respect except that it now arrives somewhere. The same flat
percentages on the Current Game DB (`ambush_percentage`, `advantage_percentage`,
`normal_percentage`) pick `ambush` / `advantage` / `normal`, and the result is
written to `payload.battlePlan.engagement`.

The Director already turns that into a forced round-1 consecutive surprise round
plus the red **AMBUSH!** / blue **ADVANTAGE!** banner. Nothing new was built for
this — the value simply used to be thrown away.

`initiativeMode` is left at `rolled`, so a `normal` engagement still gets the
per-round Initiative Group Check and its Player/Enemy Initiative flash.

---

## Payload

Minimal, in the shape the Test Battle tool and the sim already use. Note
`encounterPlan.mode: "manual"` — we resolved the group ourselves, so the Director
takes its deterministic manual branch rather than re-rolling.

```js
{
  context:       { battleSceneUuid, sourceSceneId, sourceSceneUuid, return: { enabled: true } },
  encounterPlan: { mode: "manual", manualPicks: [{ actorUuid, name, quantity, isNew }] },
  party:         { members: [{ actorUuid, actorId, name, slot, img }] },
  battlePlan:    { type: "default", isBoss: false, initiativeMode: "rolled", engagement },
  battleConfig:  { bgm, battleSceneUuid },
  options:       { battleSystem: "director" },
  meta:          { source: "dungeon-random-battle", sceneId, tileId },
}
```

`lean` is deliberately **not** set — that flag is what suppresses the shatter,
curtain and entrance, and those are the whole point here.

`party.members` comes from `CampSystem.Party.resolve()` (the shared reader for
the game DB's `member_id_1..4`). `slot` only ever ORDERS the spawn line —
`resolveParty` sorts by it and nothing reads the value — so the roster's own
order is all that needs preserving. **Guests are merged downstream** by
`resolveParty`; adding them here would deploy them twice.

`isNew` rides along on each pick purely so the toast can flag first encounters
without re-querying the encyclopedia (which by then may already have been
written to). The Director ignores unknown keys.

---

## Failure modes, and what they do

All of these are reachable today.

| Condition | Behaviour |
|---|---|
| No Encounter table, or zero rows | Falls back to 3–5 novelty-weighted draws from the Enemies table |
| Table formula unreadable | Table skipped entirely (Foundry could not roll it either) → Enemies table → miss |
| Neither table usable | Degrades to a **miss**: card, rate climbs, GM-only warning |
| No `battleMap` on the scene | Same graceful miss |
| An encounter slot names a missing actor | Skipped with a console warning; the rest of the row still spawns |
| Director already running | Launch skipped, GM notified |
| No party members in the game DB | Launch refused (an enemy-only battle is never wanted) |

The guiding rule: **a misconfigured dungeon must never strand a player's turn.**
Three dungeons ship with empty Encounter tables (Fafnir Castle, Eisendrache
Arena, Eisendrache Burning), so the degrade path is not hypothetical.

Encounter rows are plain text with no referential integrity — a renamed or
deleted monster breaks them silently, which is why the unresolved-slot warning is
loud.

---

## Turn-loop interaction

When a battle actually launches, the tile handler sets
`__ONI_DUNGEON_PATHING__.state.battleLaunching`, and the dungeon turn loop skips
its closing graph rebuild. Without that the rebuild races the scene teardown and
warns about a party token already on its way to the battle scene.
`canvasTearDown → deactivate()` handles the real teardown; the flag only silences
that one racing rebuild, and `activate()` clears it.

---

## Deliberately not done

- **No anti-repeat de-weighting.** Novelty bias only. `applyAntiRepeat` in
  `actionReader-matchAndPickAction.js` is the template if it is ever wanted.
- **The legacy `macros/Tiles Event/[Macro] Random Battle.js`** — the pre-Dungeon-
  Pathing monks-active-tiles twin — was left untouched and has now diverged from
  the ported handler. It is not on any live path.
- Ambush/advantage percentages stay flat and global on the Current Game DB;
  they were not moved per-dungeon or made situational.
