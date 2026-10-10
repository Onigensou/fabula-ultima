# Lightning Crystal — Underground Hazard Design

The conflict event of the **Valley of the Dragon's cave maps** — the
Underground Area group and The Great Seal. It is the underground counterpart
of [Lightning Storm](lightning-storm-design.md): no bolt reaches the party
from the sky down here, so there is **no Lightning Rod** on these maps. The
charge sits in the rock instead.

Status: **BUILT 2026-10-10. Live-tested in automated (sim) battles only.**
Not yet played by a person, not yet seen from a player client, and its
numbers are unvalidated for balance. Ruling settled with the user 2026-10-10.

It deliberately stays inside the dungeon's existing vocabulary — Bolt damage,
the roster's Bolt passives — so a party that has learned the Storm is not
handed a second unrelated system.

---

## The ruling

1. **At the start of a conflict, 0–2 Lightning Crystals appear** (25% / 50% / 25%).
2. **Each crystal has its own countdown, rolled 6–9.**
3. **At the start of every turn, each countdown drops by 1.** Every creature's
   turn counts, both sides, and a multi-activation creature counts once per
   activation.
4. **A crystal that takes damage gains time**, by how much it took after
   affinity:

   | Damage taken | Turns gained |
   |---|---|
   | 24 or less | +1 |
   | 25–49 | +2 |
   | 50 or more | +3 |

5. **At zero the crystal deals 20–30 Bolt to every creature, then shatters.**
   One roll per blast, shared by all targets.

### The crystal itself

| Property | Value | Why |
|---|---|---|
| Side | Enemy | Monsters never target it; a player's "all enemies" skill includes it. Neither needs targeting code. |
| Turns | None | It is not a participant. |
| Durability | Indestructible | The only way to interact with it is its clock. |
| Bolt | Immune | Bolt never delays it, and one crystal's blast does not move another's clock. |
| Earth | Vulnerable | Earth damage arrives doubled, so it nearly always buys +3. Both maps carry an Earth wellspring. |
| Statuses | Immune to all | It is a rock. |
| Defences | DEF 6 / MDEF 6 | Hitting it should be a choice, not a dice roll. |

### Edge rulings

| Case | Ruling |
|---|---|
| Area attacks | Include the crystal. **Intended** — it is the way to manage the clock while keeping up offence. |
| Monster "all creatures" Bolt bursts | Hit the crystal for nothing (immune). |
| The blast and the roster's passives | The blast **does** set off Overcharge, Chain Reaction and Lightning Charge. That is the point of it. |
| Damage from effect rows (Zero Powers, riders) | Counts. The rule is "takes damage", whatever the cause. |
| Fight ends with a crystal standing | Victory as normal. The crystal is removed with the battlefield. |

---

## How it plays

Assume about 8 turns a round (4 PCs, about 4 enemy activations) and one PC
action ≈ 34 damage.

**It is a delay mechanic, not a prevention one.** A crystal starts between
three-quarters of a round and a little over one round from zero. One ordinary
hit buys 2 turns — a quarter of a round. Holding a single crystal forever
would cost the whole party's turn every round, so it *will* go off; the party
chooses when, and who is standing when it does. That is the same shape as
Kirin's Rail Stream, on purpose.

**The cheap way to manage it is a target slot, not an action.** A two-target
bow, an "up to three" spell or an all-enemies skill nudges the clock while
still doing its real job.

**What a blast costs depends entirely on who is on the field:**

| | Party cost |
|---|---|
| The blast alone (avg 25) | ~100 HP across four, about 21% of a 471 pool |
| + Lightning Prism Overcharge | a free Fulgur Finis |
| + Skizzik Chain Reaction | a free Thunder Strike |
| + Kirin Lightning Charge | ~5 MP per creature damaged — one blast arms Rail Stream |

A Bolt-vulnerable PC (or one who is Wet) takes 40–60 from a single blast.

> ⚠ **Two crystals in a fight full of Bolt reactors is the hot case.** In sim,
> Kirin + Skizzik + Lightning Prism with two crystals wiped the party in
> round 2 — but the sim's party brains do not know crystals exist and never
> spend an attack on one, so read that as the cost of *ignoring* the mechanic,
> not as a balance verdict. A person has to play it.

---

## Implementation — as built

Selected on the battle map at Scene Config → Fabula Configuration → General →
Conflict Event. Set on `Valley_Battlemap002` (Underground) and
`Valley_Battlemap003` (The Great Seal).

### Battlefield objects

A crystal is a real token and a real combatant, so every skill, picker and
damage path reaches it unchanged. What makes it a *thing* is one actor flag,
`flags.fabula-ultima-companion.bdObject`
([battlefield-object.js](../scripts/battle-director/battlefield-object.js)),
read at five places:

| Site | Effect |
|---|---|
| `state-handlers.js` `countsForSideWipe` | An indestructible enemy never keeps the enemy side "alive" — without this no fight on these maps could end in victory. |
| `battle-end-rewards.js` | No EXP, no Zenit. |
| `director-hp-bar.js` | No HP bar. |
| `actionReader-core.js` `isUntargetableActor` | The AI never targets it (no wasted heals, buffs or summon attacks) and never counts it. |
| `sim/sim-run.js` `countsForReporting` | A win with a crystal standing reports as a win. |

It takes no turns through the ordinary activation stat (`activation: 0` on the
actor, plus the `turnsPerRound: 0` token pin so the value survives round wraps
and reloads). It is indestructible by construction — 9999 HP against a
lifetime of a round or two — rather than by a defeat rule.

Any future destructible-scenery or objective prop can reuse the flag.

### The actor

`Lightning Crystal`, in the Current Dungeon folder, found by the event through
`flags.fabula-ultima-companion.conflictObject === "lightning-crystal"` rather
than by name or id. Art is the placeholder
`Item Icon/cryst.png`.

### The event

[`events/lightning-crystal.js`](../scripts/conflict-event/events/lightning-crystal.js).

- **Countdown state is an Active Effect on the crystal** (`Crystal Countdown`,
  the number in its flags). An event holds no state; an AE survives F5,
  rewinds with the actor snapshot, and replicates to every client. It carries
  no charges and no reaction rows, so the event writes it directly.
- **The tick is in `onTurnStart`.** Unlike the Storm's strike it cannot live
  on an AE's own `turn_start` row — a crystal has no turn, and "every
  creature's turn" is a battlefield beat. Each tick stamps a per-turn key so a
  re-dispatched window cannot tick twice.
- **The bump is in `onLedgerEvent`**, reading the ledger's `amount` (HP that
  actually came off, post-affinity).
- **The blast goes through BD's effect executor** as a `deal_damage` row with
  `damage_cause: "damage"`. The default `hazard` cause would be skipped by any
  passive carrying `reaction_cause_filter: damage`.
- **Shatter is deferred by one turn start.** The blast's damage is written
  inside the handler, but the reactions it provokes settle after it returns
  and name the crystal as their cause. So the crystal is marked spent
  (untargetable, invisible) and removed at the next turn start.

### The display

[`lightning-crystal-countdown.js`](../scripts/conflict-event/lightning-crystal-countdown.js).
A large number above the crystal's rendered sprite: white, amber at 3, pulsing
red at 1, a pop on each change and a floating `+N` when a hit buys time.
Derived per client from the AE, the same no-socket contract as the Rod cursor.

The blast currently borrows the Storm's strike cinematic, landing on the
crystal. It has the right ordering (dim, strike, then damage) and is a
placeholder for a real detonation.

### Pinning the count

`payload.context.conflictEventOptions.crystalCount` (0–2) replaces the spawn
roll, for a scripted encounter or a balance run:

```js
FUCompanion.api.experimental.sim.run({
  enemies: [{ uuid: "Actor.…", quantity: 1 }],
  conflictEvent: "lightning-crystal",
  conflictEventOptions: { crystalCount: 2 },
});
```

---

## Verified, and not

**Confirmed in live sim battles (2026-10-10):** spawn and placement, the
per-turn tick, two independent countdowns in one fight, bumps at all three
tiers including an Earth hit, the blast through affinity (vulnerable doubled,
resistant halved, absorb heals, immune zero), Overcharge and Lightning Charge
firing off the blast, shatter and removal, victory with crystals standing, no
stray tokens after a fight or an abort, and the countdown rendering in its
white, amber and red states.

**Not done:**

- **Never played by a person**, and never seen from a player client.
- **Teardown in a real battle.** Sims run lean and skip the battle-end
  sequence, so `onConflictEnd` has not run in anger. The conflict-start sweep
  covers a crystal left behind.
- **Rewind across a shatter.** The countdown rewinds; a crystal that has
  already been removed does not come back.
- **The blast cinematic** has not been eyeballed on a crystal.
- **The reward exclusion** (no EXP or Zenit for a crystal) is in the code but
  its numbers were not checked against a real reward screen.
- **The sim's party brains ignore crystals** (`sim/hazard-brain.js` only knows
  the Rod), so sim results on these maps overstate the hazard.
- **Chain Reaction off a blast** was not observed — Skizzik was already down
  when the crystals went off. It uses the same trigger path as Overcharge.
- **Asura** was balanced around Rod strikes and should stay off these maps.
- Art, a real detonation effect, and the study text's final wording.

---

## Related

- [conflict-event-design.md](conflict-event-design.md) — the system
- [lightning-storm-design.md](lightning-storm-design.md) — the surface hazard, and the roster's passives
