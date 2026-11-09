---
id: 2026-11-09-turn-order-free-round-handoff
title: Hand-off — Quicken/Delay phases, Free Round for Ambush/Advantage, held summon actions (v1.0.577)
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: battle-director (director-combat, state-handlers, skill-effects free_action, persistence, director-boot, director-round-banner, sim-run), conflict-event runtime, event-system, dungeon-pathing tile config, tools/mindscape engine
introduced_in: 9efd4669..v1.0.577
fixed_in:
---

# Turn order rework: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. Nothing here needs action. It lists the shared
files this change touched, so a merge or a later change doesn't undo it by accident.

## 1. Why

- **Quicken and Delay did nothing.** They had an icon and a tooltip, but nothing in turn order read them. The
  Gigas' Oaf Delay and the Giant Club's "always Delay" were cosmetic; Gigas only went last because its DEX+INS
  was the lowest on its side.
- **Ambush/Advantage felt wrong against multi-activation enemies.** Round 1 let the favoured side take every
  turn first, and then the other side took ALL of its turns in a row. An Advantage start against a 4-activation
  elite ended with 4 elite turns back to back.

## 2. New rules (user rulings, 2026-11-09)

- **Speed phases.** Every round plays QUICKEN → NORMAL → DELAY. Sides alternate inside a phase, and the
  alternation carries straight across a phase border (no double turn at a change).
  - Quicken + Delay together = Normal; both stay on. Dispel one and the other applies at the next pick.
  - All of a multi-activation creature's turns move.
  - A creature's phase locks at its first turn of the round. A status landing after that applies next round;
    a creature that hasn't acted moves at once.
- **Free Round.** Ambush / Advantage give the favoured side ONE extra round before Round 1, with ALL its
  activations. The other side gets no turns but can still react.
  - It is **round 0** with `dCombat.freeRound = true`. `ROUND` reads 0; enemy patterns keyed to "Round No. 1"
    still open Round 1.
  - Round-level rules wait for Round 1: no `round_start` / `round_end` reactions (Kalina's Late Actor
    included), no conflict-event beats (Lightning Crystal countdown, Storm strikes), no initiative roll, no
    Dominance. Turn-level rules run as usual.
  - Round 1 then resolves initiative like any other round. Ambush/Advantage no longer set `firstSide`.
- **Turn-less summons.** A summon with no turn of its own (Birth of the Cruel's Minion) under Quicken/Delay
  acts at the END of its phase instead of right after its summoner. Never ahead of a creature with a real turn
  in that phase.

## 3. Shared code that changed

- `director-combat.js`
  - `eligibleOnSide(side)` now only returns creatures in the phase being played (`currentPhaseTier()`). The
    turn picker and enemy autopilot follow it with no other wiring. An empty side while the other side still
    has turns in the phase is normal now.
  - New: `speedTierOf(c)`, `currentPhaseTier()`, `lockPhase(c)` (called by TURN_START after the pick),
    `enterFreeRound()`, `holdSummonAction()`, `takeDueHeldActions()`. Combatant field `phaseLock`.
  - `_alternationPolicyForRound` always returns "alternate" (the consecutive round-1 policy is gone).
  - `buildDirectorCombat` reads `engagement: "preemptive"` as `"advantage"`. The Event System's Start Battle
    row saves "preemptive" for "Party strikes first"; those battles were silently running as normal fights.
- `state-handlers.js`
  - ROUND_START enters the Free Round when `freeRoundPending`; the first-round bump skips while `freeRound`.
  - `resolveRoundInitiative` lost its round-1 Ambush/Advantage branch.
  - STANDALONE_REACTION_WINDOW accepts **trigger `"none"`** (dispatches nothing) and, before its free-action
    detour check, releases due held summon actions into the free-action queue.
  - ROUND_END uses `"none"` after the Free Round.
  - TURN_START: the "side has no eligible, swapping" line is a log, not a warn — it is routine with phases.
- `skill-effects.js` `applyFreeActionEffect`: builds the request, then `holdSummonFreeAction()` may hold it
  instead of enqueueing (performer ≠ reactor, token `isSummon`, not phantasm, combatant `turnsPerRound` 0,
  tier ≠ 0, not a Chain strike).
- `persistence.js`: saves `freeRoundPending`, `freeRound`, `freeRoundSide`, `heldSummonActions`, per-combatant
  `phaseLock`. `director-boot.js` resume: round 0 + `freeRound` is a running round, not Battle Start.
- `director-round-banner.js`: `playRoundBanner({ label })` — the Free Round plate reads AMBUSH! / ADVANTAGE!
  with a "Free Round" seal, and the bar text matches. Tracker icons carry a Q / D tag (`speed` in the snapshot).
- `conflict-event-runtime.js` `dispatchConflictEventLifecycle`: returns early during the Free Round (except
  `conflict_start`).
- `sim-run.js`: `run({ engagement })`. Merged next to your `scene` option.
- `tools/mindscape/lib/engine.js` `alternatingRound`: same phases, so balance runs match the table.
- New: `speed-phase.js` (pure Quicken/Delay → tier), `director-combat-phases.test.mjs` (24 tests).

## 4. Verified

Unit tests 24/24 + existing suites. Staging World hands-free sims (Gigas + 2 Electro Slimes), Advantage and
Ambush: Free Round for the favoured side only, no round reactions in it, Round 1 rolls initiative, enemy Gigas
waits until all PCs have acted, Keren's reanimated Gigas held and released at the end of the Delay phase, a
mid-round reload resumed cleanly.

## 5. Known effects

- Gigas now really acts last, so the party has a full round to land Bolt before Heavy Swing — expect it to
  play easier than its dossier sims (re-sim owed).
- The Battle Prompt macro (world data) still words Ambush/Advantage the old way.
