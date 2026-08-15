# Lightning Surge — Dungeon Hazard Design

The environmental hazard of **Valley of the Dragon** (and its sub-area,
Fafnir Castle). "Lightning Surge" is the name of the mechanic; the
dungeon's in-world name is Valley of the Dragon.

Status: **RULING SETTLED 2026-08-14. NOT BUILT, NOT LIVE-TESTED.**

Supersedes two earlier drafts:

- **v1** — "at the start of any creature's turn, a chance of 30 Bolt / +30 MP."
  Rejected: pure RNG, no agency, ~4 strikes/round of invisible coin flips.
- **v2** — Lightning Rod applied by **bolt** damage, removable with an
  Objective action. Rejected: the Objective action does not exist in the
  Battle Director ([state-handlers.js:3651](../scripts/battle-director/state-handlers.js#L3651)
  rejects it; [turn-ui.js:31](../scripts/battle-director/turn-ui.js#L31)
  hides the blade "until D.6/D.7"), and the removal button was a trap —
  30 MP is worth ~2–3× the 30 damage it costs, so pressing it was
  mathematically wrong.

---

## The ruling

1. **At the beginning of combat, a random creature gains the `Lightning Rod`
   status.**
2. **At the start of a creature's turn, if it has Lightning Rod, it takes
   30 Bolt damage and recovers 30 MP.**
3. **Whenever a creature takes damage dealt by another creature, it gains
   Lightning Rod.**
4. **Lightning Rod is a singleton** — only one exists in play. A new holder
   replaces the previous one.
5. **If no creature has Lightning Rod at the start of a round, a random
   creature gains it.**

### Exclusions and edge rulings

| Case | Ruling | Why |
|---|---|---|
| The Surge's own strike | Does **not** move the Rod | Otherwise it self-refreshes and never leaves its holder. |
| DoT ticks (Burn, Poison, environmental) | Do **not** move the Rod | Uncontrollable motion dilutes the strategy layer. Free to implement — shares the `hazard` damage-cause with the strike, so one filter excludes both. |
| Multi-target damage (AoE, death bursts) | **System picks** the recipient | Play speed over agency, by design call. The engine resolves multi-target damage sequentially, so "last target resolved" is free and reads as arbitrary at the table. |
| Absorb / immune holders | Keep the emergent behaviour | No HP-loss event means an absorbing creature never *gains* the Rod — but it can still *hold* one, and the strike then heals it and hands it MP. Electro Slime (AB bolt) becomes a Rod sponge. Deliberate. |
| Holder is defeated | Rod dies with them | Covered by rule 5's round re-seed. |
| Multi-activation monsters | One strike **per activation** | Each activation is another turn start. This is the point — see the HP-wall design below. |

### Why the MP stays at 30

The double edge is load-bearing. Strip the MP and the Rod becomes purely
punishing, everyone always wants to dump it on the enemy, and there is no
decision left.

The ambiguity ("do I want this?") is fine **because v3 has no removal
button.** In v2 the same ambiguity made the Objective action a trap. Here
it is a targeting consideration, which is the good kind of ambiguity — the
same kind as "focus fire or spread?"

One honest caveat: **30 damage / 30 MP reads as an even trade and is not
one.** Per [FU Resource Map](#related), 10 MP ≈ 25–35 damage of output, so
30 MP is worth roughly 75–105. The mechanic looks symmetrical and plays
asymmetrical. This is accepted rather than fixed: "who benefits from the
charge" becomes a **monster-knowledge question**, which makes Study
load-bearing and fits the dungeon's bestiary tradition. Study text and the
status tooltip must say the quiet part loudly: *the Rod feeds whoever
holds it.*

---

## How it plays

### The core heuristic

> The Rod should be held by whoever's turn is **furthest away**.

"Don't hit a monster that hasn't acted yet" is the common case of that
rule. It is readable off the initiative tracker, and it collides
productively with normal targeting priorities (focus fire, finish the
wounded one, spike the dangerous one before it acts).

### Variance became a skill expression

| | v1 | v3 |
|---|---|---|
| Strikes per round | ~4, fixed by RNG | **0 to one-per-turn**, decided by targeting |
| Who chooses the victim | nobody | whoever dealt the last damage |
| Table bookkeeping | ~8 coin flips/round, invisible | one visible status chip |

### The round boundary is the pressure point

The party *can* suppress the mechanic mid-round by only ever damaging
already-acted monsters. That suppression collapses every round, because
the already-acted pool empties:

- **Party beat.** PC-A holds the Rod. Party acts with PC-B, hits
  already-acted M1. Rod → M1. PC-A is clean.
- **GM beat.** M1 cannot act again. GM activates M2 — no Rod, no strike.
  M2 attacks PC-C. Rod → PC-C.
- …repeat. The mechanic stays suppressed for the rest of the round.
- **New round.** No monster has acted. The party's first attacker must
  either hand the Rod to an un-acted monster (which the GM gladly
  collects) or the holder eats it.

Floor: **~1 strike per round, earned rather than automatic.**

### Avoidance is never free

Even perfect play pays a tax: "only hit already-acted monsters" means no
focus fire on the priority target, no finishing a wounded one at the
moment it matters, and no spiking the dangerous one *before* it acts —
which is when spiking is worth the most. Per
[Fight Balance Playbook](#related), that is the currency fights are
actually decided in.

**Stalling is not an out.** Every PC must take their turn before the round
ends, and moving the Rod requires dealing damage. Trading a full action to
dodge 30 damage is a worse deal than the v2 Objective action was.

### GM-side agency

The GM never has a real decision about *collecting* — 15 damage (RS bolt)
for 30 MP is always good for this roster. The GM's lever is **targeting:
which PC receives the Rod.**

- **Keren is VU bolt** → 60 damage, not 30.
- A PC in **crisis**.
- A PC who is **about to act** and cannot dump it in time.

A GM who reads the party well roughly doubles the hazard's teeth. Write
this into the monster-facing notes — it is not obvious from the rules.

---

## Roster interlock (Valley of the Dragon)

See [[project_lightning_surge_dungeon]] for stat blocks and skill IDs.

**Qilin / Rail Stream is the live danger.** Qilin starts at 0 MP, needs 50
for Rail Stream, resists bolt (15 damage for 30 MP), and stacks Lightning
Charge (+15) on top. **Rail Stream can arm by round 2 through nothing but
careless attacking.** That is the mechanic teaching its lesson — but the
lesson arrives as a party wipe, so the encounter-table ramp matters:
rows 1–2 slime-only, 3–8 slimes + reactors, 9–12 Qilin. Keep that order.

**Electro Slime closes the exploit.** The cheapest way to void the Rod is
to kill its holder — hand it to 45-HP chaff and finish them. But the
slime's death burst deals 30 bolt to *everyone*, creature-inflicted, which
immediately re-tags a random creature. The out re-rolls itself. Emergent,
already built, keep it.

**Skizzik's uncapped Chain Reaction** multiplies damage instances, so the
Rod ping-pongs during its turns. Noisy but coherent.

**The anti-synergy HP wall is revived.** Under v2 (bolt-only trigger) a
non-bolt monster could never be tagged and the idea died. Under v3 **any**
damage tags it, so the party's own attacks park the Rod on the wall
constantly, and a multi-activation build eats a strike at nearly every
activation. The original vision — "the Surge is the party's silent fourth
damage source, ~2.5–3 rounds when it lands" — works fully, and the wall
banking useless MP is fine (arguably the point).

---

## Implementation notes

**No Battle Director UI work is required.** This is the practical reason
v3 ships where v2 could not. Everything below is authorable as data.

**The status.** A `Lightning Rod` Active Effect carrying its own reaction
config in `flags.fabula-ultima-companion.reactionConfig` (AEs support this
— see [ActiveEffectManager-reaction-ui.js](../scripts/active-effect-manager/ActiveEffectManager-reaction-ui.js)):

- `reaction_trigger: turn_start`, `reaction_source: self`,
  `reaction_passive_mode: force` (auto-fires, UI-invisible)
- → chain `[deal_damage, grant]`
  - `deal_damage`: `damage_element: bolt`, `damage_amount: 30`,
    `damage_cause: hazard`
  - `grant`: `grant_resource: mp`, `grant_amount: 30`, `target_ref: self`

Hosting the strike on the AE means it works identically on PCs and NPCs
with no per-actor authoring.

**The applier.** A hazard host (hidden combatant, or a field AE stamped on
every combatant at conflict start) listening on `creature_lose_resource` —
the observer-aware trigger family, which fires per HP-loss event and is
the only one a bystander can hear. No element filter (v3 is any-damage).
Damage-cause filter set to creature-inflicted, which excludes both the
Surge's own strike and all DoT ticks in one field.

- → chain `[strip, apply]`
  - `strip`: `apply_ae` with `ae_duplicate_mode: "remove"` over a targeting
    row of `candidate_source: combat, mode: all`. Verified in
    [ActiveEffectManager-api.js:1419](../scripts/active-effect-manager/ActiveEffectManager-api.js#L1419)
    — `remove` deletes the existing copy and no-ops when absent.
  - `apply`: `apply_ae` Lightning Rod to `candidate_source: trigger_subject`.

**Seeding.** A `conflict_start` row for rule 1 and a `round_start` row for
rule 5. Clean up on `conflict_end` so the Rod does not persist between
fights.

### Open engine questions

- **Random target selection** — unverified whether a `candidate_source`
  supports random pick. GM-picks is an acceptable substitute (and lets the
  seed be placed dramatically) if it needs a script.
- **"No creature has the Rod" gate** for rule 5's re-seed — needs a
  formula identifier for "does any combatant have status X." Unverified.
- Both are small; neither blocks the core mechanic.

### Not done

- Nothing is built. No numbers have been validated in play.
- The Valley of the Dragon `- Hazard` roll table (`MN4u8ohWRo25Xj5h`
  folder) remains the fallback home if this ships as GM-adjudicated rather
  than automated.
- Study text and the status tooltip need the "the Rod feeds whoever holds
  it" line before this sees a table.

---

## Related

- [[project_lightning_surge_dungeon]] — roster, stat blocks, skill IDs, roll tables
- [[project_fight_balance_playbook]] — action economy over DPR
- [[project_fu_resource_map]] — 1 Action ≈ 34 damage, 10 MP ≈ 25–35 damage
- [[reference_bd_monster_automation]] — wiring `reaction_config_table` + `effect_table`
- [[reference_common_aes]] — AE templates, tags, charge keys
- [reaction-config-schema.md](reaction-config-schema.md) — trigger + effect field reference
