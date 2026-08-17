# Lightning Storm — Dungeon Hazard Design

The environmental hazard of **Valley of the Dragon** (and its sub-area,
Fafnir Castle). "Lightning Storm" is the name of the mechanic; the
dungeon's in-world name is Valley of the Dragon.

Status: **BUILT + LIVE-TESTED 2026-08-16** on branch
`feat/conflict-event-system`. Ruling settled 2026-08-14.

Live run (3 sims, Kirin / Lightning Prism / Skizzik encounters from the Valley
of the Dragon table): seeding, singleton movement and the turn-start discharge
all confirmed. Kirin took **15 damage (30 Bolt halved by its RS bolt) and +30
MP**, twice in one round on its two activations — so affinity and the
per-activation ruling both hold. Numbers are still unvalidated for BALANCE.

That run also showed Rail Stream never firing, which triggered the
2026-08-16 rebalance in [Roster interlock](#roster-interlock-valley-of-the-dragon):
Kirin's pool and Rail Stream's cost are now **50**, fed to full by a single
Rod strike (+30 Rod, +20 Lightning Charge), and the ult stopped being a TPK.
**Not yet live-tested at the new numbers.**

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
| The Storm's own strike | Does **not** move the Rod | Otherwise it self-refreshes and never leaves its holder. |
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

**Kirin / Rail Stream is the storm's mouthpiece.** (The actor is named Kirin;
earlier drafts of this doc called it Qilin.) Kirin starts at 0 MP with a **50
MP** pool, and Rail Stream costs **50** — and **one Rod strike still arms it**,
because the strike pays out twice:

| Source | MP |
|---|---|
| `rod_charge` — the Rod's own grant | +30 |
| **Lightning Charge** — Kirin took Bolt damage | +20 |
| | **= 50, exactly Rail Stream** |

That is the whole trick. The Rod deals **Bolt** damage to its holder, and
Lightning Charge fires on `creature_lose_resource` with **no
`reaction_cause_filter`**, so the `hazard`-cause strike feeds it. Kirin resists
bolt, so the strike costs it only 15 HP for 50 MP — a trade never in the
party's favour.

> ⚠ **`reaction_cause_filter` is load-bearing here and must stay BLANK.** It is
> the dial that decides whether the Rod feeds a passive: Prism's Overcharge sets
> it to `"damage"` precisely to *exclude* the hazard strike. Setting it on
> Lightning Charge would drop Kirin to +30 per strike and Rail Stream would
> never arm — the exact bug this design replaced.

Party bolt damage also feeds the horn at +20 a hit (3 hits arms it alone), so a
bolt-using party still escalates the fight against itself. The pool caps at 50,
so Kirin can never bank more than one Rail Stream.

**Overflow becomes Shield.** The Rod is not the only bolt in the room — an
Electro Slime death burst hits everyone for 30 — so Kirin rarely lands on a
clean 50. Lightning Charge is a chain: it grants the excess as **Shield** first,
then the MP.

```
charge_horn      chain    charge_overflow, charge_mp
charge_overflow  grant    shield   max(0, CUR_MP + 20 - MAX_MP)
charge_mp        grant    mp       20
```

Order is load-bearing — the overflow step reads `CUR_MP` *before* the MP grant
writes. At 40 MP a hit gives +10 MP and **+10 Shield**; at 50 it gives 20 Shield
and no MP. Nothing is wasted, and a Kirin the party keeps shocking while it is
already charged turns that waste into a damage buffer instead.

> **This is deliberately NOT the RAW Shield ruling.** Shield normally behaves
> like temp HP — a new one does not stack, you keep the higher. The engine
> models that as `set_resource` (a raise-only `Math.max(cur, value)` write);
> `grant` is the additive one. Kirin uses **`grant`**, so overflow Shield
> **stacks** on whatever it already has. The description says so explicitly,
> because a player reading the sheet would otherwise assume the normal rule.
> (Both idioms are in use elsewhere: Golem Soulstone `set_resource` = keep
> highest, Golem Fragment / Geist's Shadow Wall `grant` = stack.)
>
> Only Lightning Charge's own +20 is converted. The Rod's `rod_charge` +30
> clamps and is still discarded, because that row lives on the **shared**
> Lightning Rod AE — converting there would hand Shield to every Rod holder,
> PCs included. That is a hazard-wide change, not a Kirin one.

**Rail Stream is meant to land.** It is not a doomsday clock the party is
supposed to defuse, and it is not a wipe — it is a **heavy** party-wide Bolt hit
(~52 per target, ~208 across four) with a **50% chance per target** of
Paralyzed, rolled separately for each. The decision it poses is not *whether*
but *when*: the Rod is a singleton and any damage moves it, so the party
chooses which round Kirin gets fed and who is standing when it fires. Nobody
dies at neutral affinity from full — Keren at VU bolt is the exception, which is
the same VU tax the Rod itself charges.

> **Design history (all 2026-08-16).** Rail Stream was originally 50 MP out of a
> 60 pool at **+125** damage — ~528 across the party, a TPK — fed by a Lightning
> Charge that gave +15 whenever *any* creature dealt Bolt damage (gated
> `CAUSE_IS_SELF == 0`, capped 2/round). Arming took two rounds of careless
> attacking and the payoff was a wipe.
>
> First pass cut the damage to +45 and dropped the pool and the cost to 30,
> deleting Lightning Charge so the Rod was the sole feed. That played correctly
> but priced the spell wrong: **Chimerists can learn monster spells**, and a
> 30 MP party-wide hit with a 50% Paralyze rider is far too cheap in a PC's
> hands.
>
> Current design restores Lightning Charge in a **narrower** form — "when *the
> Kirin* takes Bolt damage, +20 MP" (`SUBJECT_IS_SELF`, no self-loop guard
> needed since Kirin's own AoE never damages Kirin) — and puts the cost back to
> 50. The monster plays **identically** (one Rod strike still arms it) while the
> spell costs a PC what it is actually worth. The old encounter-table ramp
> existed to keep players away from the wipe; it is no longer load-bearing.

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
activation. The original vision — "the Storm is the party's silent fourth
damage source, ~2.5–3 rounds when it lands" — works fully, and the wall
banking useless MP is fine (arguably the point).

---

## Implementation — as built (2026-08-16)

Shipped as the first **[Conflict Event](conflict-event-design.md)** — a
scene-selected additional rule layered on a normal Battle Director conflict.
Selected on the arena scene at Scene Config → Fabula Configuration → General →
Conflict Event. No Battle Director UI work was required.

**The status.** A `Lightning Rod` Active Effect on the shared Debuff item,
`Item.XVOWOq9oUmEECGrU.ActiveEffect.79ozpIYE1nzBlTEK`, carrying its own
reaction config in `flags.fabula-ultima-companion.reactionConfig`:

- `reaction_trigger: turn_start`, `reaction_source: self`,
  `reaction_passive_mode: force` (auto-fires, UI-invisible)
- → chain `rod_strike, rod_charge`
  - `rod_strike`: `deal_damage`, `damage_element: bolt`, `damage_amount: 30`,
    `damage_cause: hazard`, `target_ref: self`
  - `rod_charge`: `grant`, `grant_resource: mp`, `grant_amount: 30`,
    `target_ref: self`

`charges: 1` with no `lifetimeMode`, so it is a persistent presence flag rather
than something that expires — it lives until the Storm moves it.

Hosting the strike on the AE means it works identically on PCs and NPCs with no
per-actor authoring, **and it fires once per activation for free** — the
multi-activation ruling cost nothing.

**The applier** is [`events/lightning-storm.js`](../scripts/conflict-event/events/lightning-storm.js),
not a hazard host. A hidden combatant would have to live in the initiative
order, target surveys and defeat sweeps; a field AE stamped on every combatant
would hear each HP-loss event N times and stampede on a Skizzik chain. The Rod
is a battlefield-scoped rule with no owner, and BD's reaction system is
actor-scoped — that mismatch is what the Conflict Event system exists to fill.

It rides `registerBuiltinReactor`, so it runs inside `settleInstance`, awaited,
with the shared dedupe set — **not** the `fu-director-trigger` Hook, which is
unawaited and would race the settle loop.

Filters: `creature_lose_resource`, `resource: hp`, `cause: damage`, and the
subject must not be its own cause.

**Seeding** is `onConflictStart` (rule 1) and `onRoundStart` (rule 5), with
`onConflictEnd` sweeping so the Rod never follows a creature out of the fight.

### Corrections to the pre-build plan

**The strip plan was wrong.** It specified `apply_ae` with
`ae_duplicate_mode: "remove"` broadcast over all combatants, citing
`ActiveEffectManager-api.js`. The BD effect dispatcher is a **different code
path**, and there the remove case sits inside an `if (existing)` guard — on a
creature *without* the AE, the row falls through to the create branch and
**grants one**. That plan would have stripped the holder and handed a Rod to
everybody else: the exact inverse of a singleton. The build uses `remove_ae`,
which genuinely no-ops when absent.

**Both "open engine questions" dissolved.** Random target selection and the
"does anybody hold the Rod" gate were hard to express as `candidate_source`
data; in an event script they are three lines each. Building the system removed
the questions rather than inheriting them.

**Prism Overcharge and Skizzik Chain Reaction now carry
`reaction_cause_filter: damage`** on both their lose and gain rows. Without it,
a Rod parked on either would heal them, hand them 30 MP *and* fire the passive
every single turn.

### Not done

- **Never live-tested.** No numbers have been validated in play, and no
  handler has run against a real battlefield.
- **No arena scene exists yet.** Valley of the Dragon's conflict scenes are
  still unbuilt, so nothing can carry the selection. Test through the
  `payload.context.conflictEventId` override until they exist.
- The Rod's icon is `Buff Icon/Shock.png` — picked for being in the same
  set as Burn and otherwise unused. Worth a look during live review.
- The AE has no entry in `statuses`, so it shows as an effect icon rather
  than a registered status. Fine for a first pass; revisit if the chip reads
  poorly.
- Study text still needs the "the Rod feeds whoever holds it" line before
  this sees a table.
- The Valley of the Dragon `- Hazard` roll table (`MN4u8ohWRo25Xj5h`
  folder) is no longer needed as the fallback home, but remains empty.

---

## Presentation (built + live-tested 2026-08-18)

The rules above were correct from the first live run and still read as
arbitrary at the table, for two reasons: "who holds the Rod" was one effect
icon in a row of effect icons, and the turn-start strike — the whole point of
the mechanic — happened as a log line and a number. Both are now shown. No
rule changed.

### The Rod cursor

`scripts/conflict-event/lightning-rod-cursor.js`. A purple arrow bobs above
the holder's rendered sprite (slow 1.8s float). Placeholder art: the arrow is
a CSS triangle, and `ROD_CURSOR_SRC` swaps in a real image when one exists.

It is **derived from the Active Effect, not broadcast.** The Rod *is* an AE,
Foundry replicates AEs to every client, so each client renders its own cursor
off `createActiveEffect` / `updateActiveEffect` / `deleteActiveEffect` plus a
`canvasReady` rescan. There is no socket to desync and no GM to be the source
of truth; an F5 mid-battle re-derives the cursor from the world rather than
from a message the client missed. Same contract as the Dominance Crest.

Two details that are not obvious:

- It anchors off `token.mesh.getBounds()` — the *rendered* sprite rect — not
  the grid square. Token scale, off-center anchors, Contain fit and mirroring
  all move the art away from its square, and the crest learned this the hard
  way on Wandering Flame.
- It follows `token.visible`, which is per-client. A holder a player cannot
  see is not advertised to them by a floating purple arrow.

It is self-scoping: the AE only exists during a Storm, so the cursor costs
nothing in every other fight and needs no teardown from `onConflictEnd`.

### The strike cinematic

`scripts/conflict-event/lightning-storm-strike-fx.js`. The battlefield dims,
the holder stays lit, a JB2A bolt falls with a thunder crack, the lights come
back up — **and only then does the 30 Bolt land.**

That ordering is the whole reason this hooks `onTurnStart` rather than the
resource ledger. The runtime dispatches `onTurnStart` awaited and *before* the
forced reaction pass that fires the Rod AE's own `rod_strike` row, so the
cinematic completes ahead of its own damage. The ledger event — the obvious
seam — is post-resolve and would have put the damage number on screen before
the lightning that caused it. Measured live: the handler blocks 1797 ms for an
1800 ms cinematic, then returns.

**The dim is a PIXI layer on `canvas.stage`, not a DOM overlay.** Chat, the
HUD, the sidebar and any open sheet stay lit; only the canvas darkens.

**The struck token is exempted by cloning it above the dim**, not by punching
a hole (a hole reveals the map background, not the token). The clone copies
`token.mesh`'s transform wholesale, which is what makes it right for scaled,
mirrored, rotated and Contain-fitted tokens — and animated `.webm` token art
keeps playing, because the clone shares the live video texture. This is only
exact because `canvas.primary`'s world transform is identity relative to the
stage; verified live (all three intervening canvas groups are identity), and
worth re-checking on a Foundry major.

The dim is drawn in **world** coordinates over an inflated scene rect, so a
camera pan or zoom mid-strike needs no per-frame work.

**The watchdog is load-bearing.** The layer carries an unconditional
self-destruct timer from the moment it mounts. A stranded dim on a player's
screen is the one failure here that ruins a session, so it cannot depend on
the timeline finishing, on the socket arriving, or on nothing throwing.

Suppression: `shouldRender()` (hidden tab / occluded window / sim run) and
`vfxSuppressed()` both skip the show. The rules never skip — the damage is
applied by the caller either way. One accepted asymmetry: because the GM
awaits the cinematic to sequence the damage, a GM whose window is hidden
collapses its dwell to zero while player clients still play the full 1.8 s.
Every broadcast VFX in this codebase behaves that way.

### Wiring

`turn_start` reaches events through one entry in `LIFECYCLE_HANDLERS`
(conflict-event-runtime.js) **and** one in `EVENT_HANDLERS` plus the frozen
object in `registerConflictEvent` (conflict-event-registry.js). Both files are
authoritative — a handler added to one and not the other registers with only a
console warning and then silently never fires. That is exactly what happened
during this build and is why the registry now says so in a comment.

The BD dispatch site needed no change: `state-handlers.js` already called
`dispatchConflictEventLifecycle` for every phased standalone trigger.

### The Rod dies with its holder — implemented 2026-08-18

Rule "holder is defeated → Rod dies with them" was in the ruling from the start
and was never actually implemented, and the omission was not neutral.

`collectReactors` — which `ctx.combatants()` is — **skips defeated combatants**
by design (a corpse is not offered reactions). Every Rod query went through it,
so from the moment a holder went down:

- the strip could not see them, and their Rod stayed on the corpse forever;
- rule 5's round-start gate saw no *live* holder, and seeded a fresh Rod.

One extra Rod per round. A real playtest hit round 5 with three Rods on three
KO'd PCs — which is what surfaced it, because the new cursor drew all three.

The fix is in two halves, and the second is the one that matters conceptually:

1. `creature_defeated` now drops the holder's Rod immediately. Nothing is lost —
   rule 3 puts one back in play on the next damage dealt — and because the
   cursor is AE-driven, the arrow leaves with its holder for free.
2. **"Who holds the Rod" is a battlefield question and must not be filtered by
   liveness.** The event ctx gained `allCombatants()` (every combatant, defeated
   included) alongside `combatants()`. The rule of thumb, now written at both
   sites: ask `combatants()` who should RECEIVE something, `allCombatants()` who
   currently HAS something. Rule 5's re-seed gate deliberately still reads the
   LIVE list, because a Rod on a corpse must not suppress the re-seed.

Half 2 also self-heals a world that already has stranded Rods: the next seed
strips them. Verified live, including that exact case.

Stripping a corpse's Rod bypasses BD's effect executor and deletes the AE
directly — the executor's paths are built around live reactors, and the reason
everything else here routes through it (affinity, absorb, the ledger, the
trigger cascade) is about DAMAGE. The Rod is a marker with no rules payload.

### Why the strike is invisible in the playtest sim

It is not a bug and not sim-specific breakage: `sim-mode.js` calls
`setDwellSuppressed(pace !== "watch")`, and the strike renderer early-returns on
`shouldRender()`. Skip the show, never the rules — the 30 Bolt still lands, the
Rod still moves, only the 1.8 s cinematic is dropped, which is the whole reason
a sim can run a fight in seconds.

The cursor is NOT gated that way, because it is world state rather than dwell —
hence the cursor-yes/strike-no asymmetry a sim run shows.

**To see the cinematic in a sim, run at `pace: "watch"`.** Measured live: with
`setDwellSuppressed(true)` the layer and video never mount; with `false` both
do.

### Still to tune

- **The bolt is centred on the token with no offset.** JB2A's
  `LightningStrike01` puts its strike in the middle of an 800×800 frame with a
  lot of empty space, so at `strikeScale: 2.2` it reads small and its impact
  point sits high. Deliberate first pass — `CFG.strikeScale` and an anchor
  offset are the knobs.
- Cursor art is the placeholder triangle.
- Never yet seen inside a real Battle Director conflict: the handler was
  driven directly with a stub context (holder / non-holder / nobody-holding
  all correct). The remaining unknown is the *feel* in a live fight, not the
  wiring.

---

## Related

- [[project_lightning_surge_dungeon]] — roster, stat blocks, skill IDs, roll tables
- [[project_fight_balance_playbook]] — action economy over DPR
- [[project_fu_resource_map]] — 1 Action ≈ 34 damage, 10 MP ≈ 25–35 damage
- [[reference_bd_monster_automation]] — wiring `reaction_config_table` + `effect_table`
- [[reference_common_aes]] — AE templates, tags, charge keys
- [reaction-config-schema.md](reaction-config-schema.md) — trigger + effect field reference
