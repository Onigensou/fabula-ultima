# Conflict Event System

An **additional rule layered on top of a normal Battle Director conflict** — a
dungeon hazard, an arena gimmick, a story modifier. Standard conflicts run BD
unchanged; a conflict event automates exactly one extra rule inside it.

Status: **BUILT 2026-08-16. NOT LIVE-TESTED.** Branch
`feat/conflict-event-system`.

First event: [Lightning Storm](lightning-storm-design.md), the Valley of the
Dragon hazard.

---

## The shape

One event per conflict scene, chosen by the developer in
**Scene Config → Fabula Configuration → General → Conflict Event**. The
dropdown only appears when Scene Mode is `conflict`. Default is `none`, which
is a true no-op.

Events do not stack. A complex event is hard enough to reason about alone, and
two interacting hazards would multiply combinatorially for no payoff.

```
scripts/conflict-event/
  conflict-event-registry.js    register / get / list + the handler contract
  conflict-event-binding.js     where the selection lives, and what wins
  conflict-event-runtime.js     the BD binding
  conflict-event-api.js         FUCompanion.api.conflictEvents + event imports
  events/
    lightning-storm.js          one file per event
```

### The contract

Every handler is optional; an event implements only the beats it needs.

| Handler | When |
|---|---|
| `onConflictStart(ctx)` | the conflict has begun (round 0) — seed here |
| `onRoundStart(ctx)` | a new round has begun — re-seed / upkeep |
| `onLedgerEvent(ctx, cfg, extra)` | a resource/status ledger event is settling |
| `onConflictEnd(ctx)` | the conflict is over — sweep here |

`ctx` carries `director`, `dCombat`, `scene`, `combatants()`, and BD's own
`applyEffectRow` / `applyEffectByLabel`. Deliberately narrow: an event gets the
battlefield and BD's executor, and nothing else.

Handler names are validated at registration. A typo'd handler would otherwise
register cleanly and simply never fire — a miserable class of bug to chase at a
live table.

---

## The rules the system is built on

### 1. Battle Director owns the game state

An event never reaches around BD. It does not write HP, does not roll its own
damage, does not keep a private model of the battle. It observes BD's lifecycle
and asks BD to act through BD's own effect executor.

This is not stylistic. Routing damage through `applyEffectRow` is what makes an
event's damage pick up affinities, absorb, the resource ledger and the
downstream trigger cascade. Three of the four Valley of the Dragon monsters
**absorb Bolt**; a hazard that rolled its own damage would be wrong on its very
first hit.

### 2. An event holds no state

`persistence.js` captures an **allowlist** of `director.ctx` fields — the
continuation stack, `standalone*`, `payload` — not the whole object. Anything an
event parks in a module-level `Map`, a closure, or an ad-hoc `ctx` field is
silently gone after an F5 mid-battle, and wrong after a rewind.

Where state is needed:

- **Prefer an AE.** Foundry persists it, F5 restores it, rewind restores it, and
  the players see it as a status chip. Lightning Storm needs nothing else —
  "who holds the Rod" *is* the AE.
- Otherwise a scene flag, or a `director.ctx` field you accept will not survive
  a reload.

The runtime itself follows this rule: it caches nothing and re-resolves the
active event on every dispatch from `ctx.payload` + the battle scene, both of
which *are* restored.

### 3. Actor-scoped behaviour belongs on an AE, not in the event

| Scope | Home |
|---|---|
| **Actor** — "at the start of MY turn", "when I am hit" | an AE carrying its own `reactionConfig` |
| **Battlefield** — no owner, applies to the fight itself | a conflict event |

An AE-hosted rule works identically on PCs and NPCs with no per-actor authoring,
and fires once per **activation** for free — which is why Lightning Storm's
multi-activation ruling cost nothing to implement.

Keeping to this split is what makes event scripts small. Lightning Storm is four
short handlers.

---

## Why it binds where it does

### Selection: the conflict scene

```
flags.fabula-ultima-companion.oniFabula.general.conflictEvent
```

On the **conflict scene** — the arena, not the dungeon scene the party walked in
from. A dungeon may own several arenas and each picks its own event, so the
hazard belongs to the arena that fights it.

Consequence: this is per-scene authoring. Five arenas in one dungeon means
setting the dropdown five times.

### Resolution: override → scene flag → none

`payload.context.conflictEventId` wins over the scene flag. Not every conflict
is launched by walking into an arena — battle-end follow-ups, the sim harness
and `test-battle-tool` all build their own payload, and during development the
arena scene may not exist yet at all. The override is how an event is exercised
end-to-end before its scene is built, and how a one-off scripted encounter runs
an event on a shared arena without editing that scene.

An explicit `none` override is honoured as an override: the documented way to
run a plain conflict on a scene that normally carries a hazard.

---

## The BD binding

Three call sites, plus registrations. With `none` selected every one of them
returns before doing anything.

| Site | Call |
|---|---|
| `director-boot.js` | `registerBuiltinReactor(conflictEventReactor)` |
| `state-handlers.js` (SRW forced phase) | `dispatchConflictEventLifecycle(...)` |
| `battle-end-orchestrator.js` | `teardownConflictEvent(...)` |

### Why `registerBuiltinReactor` and not the `fu-director-trigger` Hook

The obvious seam for "observe BD from outside" is the hook
`skill-effects.js` broadcasts, which is how the clock system listens. **It is
the wrong seam here.** It is `Hooks.callAll` — synchronous and unawaited — so an
async subscriber that applies an AE races the settle loop it is reacting to.
Clocks tolerate a late counter increment; moving a status does not.

`registerBuiltinReactor` runs *inside* `settleInstance`, is awaited, is handed
the shared `firedKeys` dedupe set, and fires before the authored-reaction walk.
The crisis, defeat, derived-status and Blackest Night reactors all ride it. The
conflict-event reactor registers **last**, so the engine's own reconcilers have
settled before an event reads the battlefield.

It is registered on **both** the fresh-start and resume paths. Registering only
on start would mean a mid-conflict F5 silently switches the hazard off for the
rest of the fight — the same failure Blackest Night documents.

### Lifecycle placement

The lifecycle dispatch sits in SRW's forced phase, **after** the crisis /
derived-status / defeat sweeps (so the battlefield an event reads is
reconciled) and **before** the forced reaction dispatch (so a status an event
seeds is visible to force-mode reactions in the same window).

### Teardown placement

Between the undying early-return and the follow-up hand-off:

- **undying** resumed *this* conflict — its early return must skip teardown
- a **follow-up** is a *new* conflict on the same scene (round resets,
  `conflict_start` re-fires), so sweeping here lets it re-seed clean

BD has no `conflict_end` dispatch site yet — `state-handlers.js` notes at
STOPPED that one is wanted (a pre-STOPPED hook, so players can react before
tokens are wiped). When it lands, teardown should move onto it.

### Failure containment

An event that throws is caught at every entry point. The fight continues
without the extra rule rather than aborting to a broken FSM state. A scene
naming an event nobody registered warns **once per conflict** — the ledger
reactor runs on every HP-loss event, and an unguarded warning would flood the
console during a Skizzik chain.

---

## Gotchas found while building

**`ae_duplicate_mode: "remove"` does not no-op when the AE is absent.** In the
BD effect dispatcher the remove case sits inside an `if (existing)` guard; on a
creature *without* the AE the row falls through to the create branch and grants
one. A broadcast "remove" over every combatant therefore strips the holder and
hands one to everybody else — the exact inverse of a singleton. Use
**`remove_ae`**, which genuinely no-ops when absent. (The AE-manager API behaves
as the older notes described; the two are different code paths.)

**`deal_damage` defaults to `damage_cause: "hazard"`.** That is what keeps an
event's own damage from tripping player-inflicted-damage reactions, and it is
why one `cause` filter can exclude both a hazard strike and every DoT tick.

**Only the loss ledger family sees absorbed damage as a loss.** An absorb writes
a recovery and fires `creature_gain_resource`. Whether an event listens to one
family or both is a real design decision — for Lightning Storm, listening only
to `creature_lose_resource` is what preserves "an absorber cannot gain the Rod".

---

## Testing

Four bare-Node harnesses, no Foundry required:

```
node scripts/conflict-event/conflict-event-registry.test.mjs      # 26
node scripts/conflict-event/conflict-event-binding.test.mjs       # 25
node scripts/conflict-event/conflict-event-runtime.test.mjs       # 15
node scripts/conflict-event/events/lightning-storm.test.mjs       # 23
```

They stay runnable because the registry, binding, gate and movement rule are
all pure. Keep them that way.

Not covered — needs a live world: handler invocation, the AE writes, singleton
enforcement, and the turn-start strike.

---

## Adding an event

1. Write `events/<id>.js`; `registerConflictEvent({ id, label, description, ... })`.
2. Import it from `conflict-event-api.js` (imports are explicit and ordered —
   one file lists every event that exists).
3. Author any actor-scoped behaviour as an AE with its own `reactionConfig`.
4. Select it on the conflict scene, or pass
   `payload.context.conflictEventId` to test before the scene exists.

---

## Convergence: battle-end follow-ups

[`battle-followup.js`](../scripts/battle-director/battle-end/battle-followup.js)
is the same idea at a different phase — a registry of rules, each its own
sub-script, that fire when a battle ends (the ⭐ Wandering Flame ambush). It
predates this system and is deliberately left alone for now.

The natural convergence is a `onConflictEnd`-style outcome hook on this
contract, with follow-ups becoming conflict events that happen to fire at the
end. Worth doing once both have more than one consumer — not before.

---

## Related

- [lightning-storm-design.md](lightning-storm-design.md) — the first event
- [reaction-config-schema.md](reaction-config-schema.md) — trigger + effect field reference
- `[[project_battle_director]]`, `[[project_bd_effect_pipeline]]`
