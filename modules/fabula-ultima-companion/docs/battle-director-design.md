# Battle Director — Design

Design for a **new, parallel battle flow** built alongside the existing
system. The legacy flow stays in place and unmodified; the director is
reached only through an explicit experimental entry point and is never
opened by normal gameplay until it's ready to replace the legacy path.

> **Status:** Design only. No code yet. Tracked in project memory
> `project_battle_director`.

## 1. Why

The current battle flow is a web of Foundry hooks, socket messages,
ad-hoc awaits, and ambient global state. There is no single point that
"owns" a battle's progression — each subsystem (turn UI, action
pipeline, reaction manager, AE manager, animation handler) listens for
its own events and acts on them whenever they arrive, regardless of
which phase the battle is actually in.

A pre-design audit found eight distinct *classes* of cross-state bleed
in the legacy system. The director's job is to make each of those
classes **structurally impossible** in the new flow — not to try to fix
them inside the legacy code, which would require touching every
subsystem.

The eight bleed classes (from the audit):

1. **Hook lifecycle leaks** — `Hooks.on` calls with no guaranteed
   `Hooks.off`. Token deletion, combat end, or module reload leave
   stale listeners that fire on later combats.
2. **Phase-blind handlers** — code reacts to events
   (`creature_takes_damage`, `updateActiveEffect`) regardless of which
   phase the battle is currently in.
3. **Concurrent writes without a transaction** — multiple clients
   write the same field (`actor.system.props.*`, `combat.flags`)
   without serialization. Free-action consume vs. turn-emitter clear
   is the canonical case.
4. **Reaction re-entry / cycles** — only guard is a 12 s TTL ledger
   plus 1.2 s per-passive grace lock. A passive that emits a damage
   trigger can re-enter itself within the TTL.
5. **Async races between snapshot and apply** — refund snapshots
   captured at Confirm time, resources read-then-written across
   `await`s, AE creation mid-Resolve mutating the same Resolve's
   damage calculation.
6. **Animation hide/show desync** — `showUIAfterAnimation` socket
   message can be lost; `hidePromise` then hangs forever.
7. **Pipeline abort leaves orphans** — `__abortPipeline` is set but
   the hide promise stays unresolved, the AE created mid-pipeline
   stays on the actor, the reaction card stays in chat after the
   action that fired it vanishes.
8. **No ownership gate before mutation** — non-owner clients can
   write combat flags (the turn-emitter's `updateCombat` listener
   fires on *every* client and writes `combat.flags.turnState`
   from each), abort pipelines from inside custom-logic snippets,
   or clear `reactionsPending` flags. Free-action state is held
   per-client in an in-memory `Map` (`scripts/free-action-state.js`),
   so the GM and a player can disagree about what the reactor's
   budget is. `gm-executor` *itself* is fine — it throws cleanly
   when called as non-GM with no socket — but the broader pattern
   of "every subsystem writes from wherever it ran" is real.

## 2. Scope and non-goals

**In scope.** Whole combat lifecycle — round start → initiative → each
combatant's turn (declare → target → roll → confirm → resolve →
reaction window → cleanup) → turn end → round end → combat end.

**Out of scope (for v1).** The 2059-line `ActionDataComputation` is not
being rewritten. The director treats it as a black box: hand it inputs
(snapshot), get back an immutable `actionResult`. The director owns
*when* it runs and *how its output flows*, not *how it computes*.
Three other subsystems are black-boxed the same way:

- **JRPG targeting** — `scripts/jrpg-targeting-system/`. Already has
  `requestTargeting(...)` with full local/remote dispatch, confirm /
  cancel / force-close lifecycle. The director's `TARGET` state calls
  this and awaits the result.
- **Active-effect manager** — `scripts/active-effect-manager/`. The
  director's `ctx.ae.*` calls thin-wrap
  `FUCompanion.api.activeEffectManager.applyEffects` / `removeEffects`.
- **Dialog system** — `scripts/dialog-system/dialog-core.js` for
  speech bubbles; `scripts/remote-choice-api.js` for player
  decision prompts. The director invokes these, doesn't replace them.

**Out of scope, forever.** Touching the legacy flow. The director is
the experimental path; the legacy flow continues to handle all real
combats until the director reaches parity.

## 2.5. RAW vs. legacy — what's homebrew

The legacy battle system is partially RAW (Fabula Ultima core book +
playtest revisions) and partially homebrew. The director must preserve
the homebrew where it works because content (skills, AEs, world data)
depends on it. This section catalogues the deviations so they're not
accidentally "fixed" back to RAW in the director.

| Subject | RAW | Legacy (homebrew) | Director keeps... |
|---|---|---|---|
| Initiative model | Side-based alternation: PCs and NPCs alternate turns; one Group Check (or playtest's Villain-presence rule) decides which side goes first. Cannot "pass." Dynamic turn order *within* a side. | Individual initiative via Lancer Initiative; each combatant gets their own slot. | **Legacy.** Changing this would invalidate every existing combat encounter and content authored against per-combatant turns. |
| Reactions | Per-skill prose triggers ("When …", "After …") with explicit cooldowns written into the skill text. Critical hits can bypass certain reactions (e.g. *Just a Humble Merchant!*). | 30-trigger typed registry (`reaction-triggers.config.js`) + declarative `reaction_config_table` + 8 effect_kinds dispatcher. | **Legacy.** The trigger registry is the system extension that makes declarative skills possible; without it every reaction would need custom JS. |
| Reaction cooldowns | Per-skill prose: "until the start of your next turn", "once per conflict", "once per turn". | Modelled as AE presence + `consume_charge` effect_kind. A "ready" AE gates availability; consume_charge deletes it. | **Legacy.** This is how content already expresses cooldowns; the director doesn't add a parallel notion. |
| Damage timing for *Protect* | RAW Protect: "you may declare the use of this Skill **before or after the Checks have been made**." Reactor can interrupt or post-hoc. | Legacy fires reaction trigger at action-card time (before damage) — interrupts. No post-hoc interception today. | **Legacy** for v1. Post-hoc Protect is a known gap; v1 ships the same interrupt-only timing. |
| Fumble threshold | Universal: rolling 1 + 1 on the two dice. | Per-actor `fumble_threshold` prop (default 1+1, overridable). | **Legacy.** A handful of NPC stat blocks rely on the override. |
| Action intent classification | RAW skills don't tag themselves as harmful / aid / neutral; the GM adjudicates. | `meta.actionIntent` inferred by ADC from skill_type / declaresHealing / damage section. Used by reactions to filter (e.g. Protect only fires on `harmful`). | **Legacy.** Without this, Protect would fire on ally heals — known nonsense per the Phase F work. |
| Multi-actor reaction windows | RAW: each skill resolves "in turn", GM adjudicates simultaneity. | Legacy spawns reaction menus on multiple reactors concurrently; responses serialize. | **Legacy.** The concurrent-menu UX is well-tested. The director codifies it as the MANUAL phase of `REACTION_WINDOW` (§7). |
| Initiative variant (playtest Feb 2026) | "If the conflict features no Villains, the heroes' side wins initiative." Removes Initiative Group Check entirely; ignores armor Initiative penalty. | Not implemented. Legacy still uses Group Check via Lancer. | **Legacy.** The director can model side-alternation as a future variant; v1 inherits Lancer-individual. |
| Zero Power | Playtest mechanic; reactions can fire on `creature_unleashes_zero_power`. | Trigger exists in registry; consumers (Zero Reaper etc.) already authored. | **Legacy.** Director's MATCH phase reads this trigger like any other. |

**Rule of thumb.** When the design says "preserves legacy semantics,"
it means: same player-visible behavior, same content compatibility,
new control flow. The director is a runtime rewrite, not a rules
rewrite.

## 3. Architectural shape

One class, `BattleDirector`, owns a Combat document and runs a finite
state machine. Every event that affects the battle (player click,
socket message, hook fire, timer tick, AE created, etc.) is funnelled
into a single entry point:

```
director.dispatch({ type: "...", payload: {...} })
```

Three layered guarantees:

- **GM authoritative.** The director runs on the GM's client only. All
  state mutations (combat flags, actor data, AE create/delete) go
  through the GM-side director. Player clients send **intents**, never
  direct writes.
- **Single mutation lock.** `dispatch()` is serialized. While one
  transition is in flight, incoming events are queued. There is no
  re-entry into `dispatch()` from inside a handler — a handler that
  wants to fire a follow-up enqueues it.
- **Explicit transition table.** Every (state, event) pair is declared
  in one table. Events that arrive in a state with no declared
  transition are either queued (if they're persistent — like a reaction
  trigger), rejected (if they're stale), or logged-and-dropped. No
  handler runs implicitly.

### 3.1 Where the code lives

```
modules/fabula-ultima-companion/scripts/battle-director/
  BattleDirector.js              — the class + dispatch loop
  states.js                       — state names (enum)
  transitions.js                  — the transition table
  intents.js                      — typed intent shape + validation
  IntentChannel.js                — GM ↔ player socket envelope
  HookRegistry.js                 — single owner for Hooks.on/off
  TimerRegistry.js                — single owner for setTimeout / RAF
  Snapshot.js                     — phase-entry snapshot helpers
  ReactionDepth.js                — depth counter + cycle guard
  states/
    DeclareState.js               — one file per state's handlers
    TargetState.js
    ComputeState.js
    ...
  entry.js                        — experimental entry point
```

Names are advisory; the structure is the point — every cross-cutting
concern (hooks, timers, intents, snapshots) has exactly one owner.

### 3.2 Entry point

The director is reachable only via:

```js
FUCompanion.api.experimental.battleDirector.start(combatId)
```

This:

1. Looks up the Combat document.
2. Constructs a `BattleDirector` instance.
3. Mounts it on `globalThis.__fuDirector` (single instance per
   client; the GM-side instance is authoritative, player-side
   instances are intent-clients only).
4. Returns the instance for console inspection.

It does **not** hook `combatStart`, does **not** advertise itself in
the turn UI, and does **not** replace any legacy entry point. The
legacy flow continues exactly as it does today.

## 4. States

The state set covers both the *phases of a round* and the *cross-cutting
modes* that bleed in the legacy system (animation hold, reaction
window, abort cleanup).

| State | Owner waits for | Exit on |
|---|---|---|
| `IDLE` | — | `START_COMBAT` intent |
| `ROUND_START` | round-start triggers drained | always → `TURN_START` |
| `TURN_START` | turn-start triggers drained | always → `DECLARE` |
| `DECLARE` | turn owner's command click | `DECLARE_COMMAND` intent |
| `TARGET` | turn owner's target picks | `TARGET_PICKED` intent, or timeout |
| `COMPUTE` | (synchronous; no input) | always → `CONFIRM` |
| `CONFIRM` | turn owner's confirm click | `CONFIRM_ACTION` intent, timeout, or `ABORT` |
| `ANIMATING` | animation playback | `ANIMATION_DONE`, or timeout |
| `RESOLVE` | (synchronous; emits triggers) | always → `REACTION_WINDOW` |
| `REACTION_WINDOW` | matched reactors' picks (manual phase) | `REACTION_WINDOW_DRAINED`, or timeout |
| `CLEANUP` | (synchronous; releases AEs, drains queue) | always → `TURN_END` |
| `TURN_END` | turn-end triggers drained | `TURN_END_DRAINED` → `ROUND_END`/`TURN_START` |
| `ROUND_END` | round-end triggers drained | `ROUND_END_DRAINED` → `ROUND_START` or `IDLE` |
| `ABORTED` | (synchronous; CLEANUP wrap) | always → `CLEANUP` |

Notes:

- `ANIMATING` is its own state, not an in-band `await` inside `CONFIRM`
  or `RESOLVE`. This is what fixes bleed class 6 — every state has a
  timeout, including animation.
- `REACTION_WINDOW` can be entered with a depth counter `> 0` (see §7).
- `CLEANUP` is the **only** path that re-enables the turn UI, releases
  pending undos, and clears any partially-applied AEs from an
  aborted action.

## 5. Transitions

The transition table is declared once, not embedded in handlers. Shape:

```js
const TRANSITIONS = {
  DECLARE: {
    DECLARE_COMMAND: { next: "TARGET", guard: isTurnOwner },
    ABORT:           { next: "ABORTED" },
    TIMEOUT:         { next: "TURN_END" },
  },
  TARGET: {
    TARGET_PICKED: { next: "COMPUTE", guard: targetsValid },
    BACK:          { next: "DECLARE" },
    ABORT:         { next: "ABORTED" },
    TIMEOUT:       { next: "ABORTED" },
  },
  // ...
};
```

Each entry has `next` (target state), optional `guard` (predicate run
before transition; rejects with reason), and optional `commit` (write
hook called atomically with the transition).

Events that aren't in the current state's table are routed by the
*event class*:

- **Persistent / interesting** (a reaction trigger, an AE created):
  push onto the relevant queue (e.g. `pendingTriggers`). They'll be
  drained when the FSM enters a state that consumes them.
- **Stale / late** (a target pick after we left TARGET): drop with a
  debug log.
- **Bug / unexpected**: throw in dev, log+drop in prod.

This is what fixes bleed class 2 — handlers never run "whenever the
event happens", only when the FSM is in a state that has declared a
transition for it.

## 6. Ownership and the intent channel

**The GM client runs the director.** Player clients run a thin
`IntentChannel` that:

- Listens for local user input (clicks on the turn UI, JRPG picker,
  chat-card Confirm).
- Wraps each input as a typed intent.
- Emits the intent on the module socket targeted to the GM.
- Awaits an `intent-ack` response (with timeout).
- Does **not** mutate combat state locally.

The GM director's socket listener is registered once (in
`HookRegistry`) and:

1. Validates the intent: requestId not seen before, fromUserId owns
   the actor named in the intent, combatId matches the current
   director's combat.
2. Calls `director.dispatch(intent)`. Result of the dispatch (or its
   rejection) is acked back to the sender.

This is what fixes bleed class 8. The director runs only on the GM;
player clients never write combat state. If no director is running
on the GM, intents are rejected with a clear error — `gm-executor`
already does this (it throws `"socket is not ready"` at
[gm-executor.js:833](../scripts/gm-executor.js#L833)), and the
director's intent channel follows the same pattern.

### 6.1 Adopting existing precedents

The codebase already has three working request/response patterns the
director should inherit rather than reinvent:

| Subsystem | Pattern | Envelope shape |
|---|---|---|
| **`scripts/gm-executor.js`** | Non-GM calls `socketlib.executeAsGM("executeSnippet", request)`. GM-side runs locally. Throws if no socket. | `{scriptText, payload, args, targets, chatMsgId, auto, globals, mode, actorUuid, metadata, callerUserId}` |
| **`scripts/remote-choice-api.js`** | Requester→GM `request`, GM→responder, response back; named socket channel `oni.remoteChoice`; per-request timeout (default 120 s). | `{ns:"oni.remoteChoice", type:"request"\|"response"\|"cancel", requestId, requesterUserId, targetUserId, cfg \| result}` |
| **`scripts/jrpg-targeting-system/`** | Full session lifecycle: `JRPG_TARGETING_START` → `_CONFIRM` / `_CANCEL` / `_FORCE_CLOSE`. Module-namespaced socket. Confirm carries selected tokens. | `{ns, event, payload:{requestId, requesterUserId, targetUserId, sessionId, ...config}, senderUserId, timestamp}` |

The **JRPGTargeting envelope** is the right precedent for director
intents: it has a request id (correlates response), session id
(correlates lifetime over multiple sub-events), sender + target user
ids (ownership check), and a sealed namespace. The director's
envelope:

```js
{
  ns: "battle-director",
  event: "INTENT" | "INTENT_ACK" | "INTENT_REJECT" | "MENU_OPEN" | "MENU_CLOSE",
  payload: {
    requestId,           // correlates ack to request
    combatId,            // which director instance
    fromUserId,          // who's asking
    type,                // intent type (DECLARE_COMMAND, REACTION_CHOICE, ...)
    body: { ... },       // intent-specific data
  },
  senderUserId,
  timestamp,
}
```

The director runs the intent listener on the GM, the menu broadcaster
on the GM, and the menu UI on whichever client the player owns. The
shape mirrors JRPGTargeting because reactor menus are essentially
"request a choice from this user with these options" — the same
problem RemoteChoice and JRPGTargeting already solved.

### 6.2 What goes over the channel

Intent types are an **explicit, fixed enum** declared in `intents.js`.
v1 list:

```
START_COMBAT
DECLARE_COMMAND
TARGET_PICKED         (forwarded from JRPGTargeting result)
TARGET_BACK
CONFIRM_ACTION
REACTION_CHOICE
ABORT
TIMEOUT               (internal — never from clients)
ANIMATION_DONE        (from animation handler)
TRIGGER_EMIT          (internal — from RESOLVE step)
```

Anything that isn't in this enum cannot be sent. Adding a new intent
type requires editing both `intents.js` and the transition table —
they're co-located so unused or undeclared intents are obvious.

The director **does not** route raw `JRPG_TARGETING_*` or
`oni.remoteChoice` messages through its own enum. Those subsystems
keep their own envelopes; the director calls their public APIs
(`JRPGTargeting.requestTargeting(...)`, `RemoteChoice.requestChoice(...)`)
and awaits the result, then emits its own `TARGET_PICKED` /
`REACTION_CHOICE` intent into the dispatch queue.

## 7. Reaction window

Fabula Ultima reactions are heterogeneous: a single emitted trigger
(e.g. `creature_takes_damage` on Bandit-A) can simultaneously match a
**different** reaction skill on each of several actors — the wounded
bandit's "Last Stand" passive, an ally's "Avenge Fallen Comrade"
passive, *and* a player's manual "Protect" interrupt. Each has its own
trigger predicate, its own filter set (range, disposition, status,
weapon, …), and its own effect chain. The director has to handle this
fan-out without serialising every reactor.

`REACTION_WINDOW` is therefore not a single linear state — it's a
state with **internal phases** that the FSM transitions through
deterministically, plus a per-reactor concurrent input channel for
manual prompts.

### 7.1 Multi-reactor flow

On entering `REACTION_WINDOW`, the director processes one trigger from
the queue and runs four internal phases. Each phase has a single
exit; the state as a whole still has one external `next` (`CLEANUP`
when the queue is drained, or itself with `reactionDepth + 1` when a
nested trigger was emitted).

```
REACTION_WINDOW
  ├─ 7.1.a  MATCH        — collect {reactor, row} pairs across all
  │                        actors. Filters evaluated against current
  │                        snapshot, not live docs.
  │
  ├─ 7.1.b  PASSIVE      — run passive matches sequentially, in
  │                        deterministic order (reactor initiative,
  │                        then row index). After each, re-evaluate
  │                        remaining filters — earlier reactions may
  │                        have changed targeting / damage / status.
  │
  ├─ 7.1.c  MANUAL       — for each reactor with at least one manual
  │                        match, spawn a reaction menu on THAT
  │                        reactor's client. All menus appear
  │                        concurrently. Each reactor responds (or
  │                        times out) independently. Responses are
  │                        queued and applied in arrival order.
  │
  └─ 7.1.d  DRAIN        — when no pending manuals remain, check the
                           trigger queue. If new triggers were
                           emitted at this depth, loop back to MATCH
                           with depth + 1. Otherwise exit.
```

Per-reactor concurrency lives in `7.1.c MANUAL`. The director holds a
map:

```js
ctx.pendingReactors = new Map();
// reactorActorId -> {
//   matches:      ReactionRow[],
//   menuId:       string,
//   timer:        TimerHandle,
//   intentNonces: Set<string>,  // dedup
//   decided:      false,
// }
```

A reactor sees a menu on their client (spawned via the intent channel
in §6 — the GM director **sends** menu specs to reactor clients, not
just receives intents from them). The reactor clicks a button, which
sends a `REACTION_CHOICE` intent back to the GM. The intent carries
the menuId, reactor identity, and chosen row (or `null` for skip).

`dispatch()`'s lock applies: even though menus render in parallel,
their *responses* are serialised. Two reactors clicking at the same
millisecond produce two intents; the director processes them one at a
time, applying each reaction's effect chain through the same
mutation APIs before processing the next.

Exit conditions for the MANUAL phase:

- All pendingReactors entries are `decided: true`.
- The manual-window timer fires (5 s in v1). Undecided reactors
  default to "skip" and the menu is closed on their client. The
  legacy reaction-window has the same 5 s timer plumbed but it's
  currently **disabled** by an early return at
  [reaction-window.js:316](../scripts/reaction-system/reaction-window.js#L316);
  reactions in the legacy effectively wait forever for a click. The
  director re-enables the timeout because the FSM's "every state
  has a guaranteed exit" invariant requires it.
- An abort intent fires — usually because of a higher-level
  cancellation (e.g. GM ends combat). All menus close; FSM goes to
  `ABORTED`.

### 7.2 Passive ordering and re-evaluation

`7.1.b PASSIVE` doesn't just iterate — between each passive
resolution, it re-evaluates the remaining filter set against the
**post-effect** snapshot. This matters when one passive's effect
removes another's preconditions:

- A "Reduce damage to 0" passive runs first → subsequent `damage > X`
  passives no longer match.
- A "Counter-attack" passive emits a new trigger → it goes into the
  queue for `DRAIN` to pick up at depth + 1, not into the current
  pass.

This is the only place in the FSM where a phase's body is itself a
small loop, and it's intentional — passive ordering is a content-
authored property and the loop preserves the author's expectation
that the *next* row sees the *current* state of the world.

### 7.3 Depth and cycle guard

When a reaction effect emits a new trigger, the new trigger is queued
on `ctx.pendingTriggers` with `depth = ctx.reactionDepth + 1`. The
`DRAIN` phase transitions back into `REACTION_WINDOW` only if:

```js
guard: (ctx) => ctx.reactionDepth < MAX_REACTION_DEPTH
```

`MAX_REACTION_DEPTH` is 3 in v1 (configurable). Past the bound, the
trigger is dropped with a clear log entry; no infinite cycle is
possible.

The depth counter is a **call-stack counter**, not a TTL. It resets
to 0 when the FSM returns to `CLEANUP`. This is what fixes bleed
class 4 — the legacy 12 s TTL ledger plus 1.2 s grace lock is
replaced by a structural bound on call depth.

### 7.4 Why this isn't a sub-FSM

These internal phases could be modelled as their own nested FSM, but
in v1 they're encoded as a linear sequence inside one
`REACTION_WINDOW` handler. Reasoning:

- The phases are sequential within the state (MATCH → PASSIVE →
  MANUAL → DRAIN), never out of order.
- The only branching is at DRAIN: loop back or exit.
- The only concurrency is in MANUAL, and that's already handled by
  per-reactor pendingReactors entries plus the dispatch lock — no
  state-machine vocabulary needed.

If a future requirement (e.g. allowing reactors to **interrupt each
other's** reactions, or running passives across nested windows in
some interleaved order) breaks this linear shape, the v2 design will
promote `REACTION_WINDOW` to a sub-FSM. For v1 the linear sequence is
sufficient and easier to reason about.

### 7.5 Mapping internal phases to existing legacy code

The four phases (MATCH / PASSIVE / MANUAL / DRAIN) aren't new
mechanisms — they correspond to existing legacy code that the
director should reuse, not duplicate:

| Phase | Legacy code | Notes |
|---|---|---|
| MATCH | `TriggerCore.collectReactionsForTrigger(triggerKey, payload)` (callable from `reaction-manager.js:218`) | Returns `[{actor, token, reactions, ...}]` — already evaluates filters (disposition, damage_type, debuff_count, condition_formula, requires_skill, etc.). |
| PASSIVE | `AutoPassiveManager.processMatches(matches, ...)` at [`scripts/passive-system/autoPassive-manager.js`](../scripts/passive-system/autoPassive-manager.js) (called from `reaction-manager.js:249`) | Returns the leftover `manualMatches`. Already handles passive ordering. The director awaits this; nothing about it has to change. |
| MANUAL | `reaction-buttonUI.spawnButton(...)` + `reaction-chooseSkill.openReactionDialog(...)` + `OniReactionOffer` socket message (`reaction-manager.js:328`) | Existing infrastructure spawns the per-reactor menu. The director adopts the spawn/await pattern; replaces the socket envelope with its own (§6.1) so reactor responses are typed director intents. |
| DRAIN | `reactionSystem.beginCardEmit` / `endCardEmit` (reaction-window.js:920, 926) + `onCardSettled` debounce | Already tracks per-card pending counts. The director's DRAIN is the same idea but tied to its trigger queue + depth counter instead of action-card flags. |

In other words: REACTION_WINDOW isn't a rewrite of the reaction
system, it's a **state that owns its lifetime** instead of letting
the legacy `oni:reactionPhase` event soup own it ambiently. The
matching, the passive engine, and the picker UI all stay.

## 8. Snapshot model

On entering each state, the director captures the inputs that state
needs into an **immutable snapshot** stored on the FSM context:

- `DECLARE` → snapshot turn owner, available action budget, applicable
  bonus grants.
- `TARGET` → snapshot eligible targets (token UUIDs + dispositions + HP).
- `COMPUTE` → snapshot attacker, defender stats, weapon, skill props.
- `CONFIRM` → snapshot computed action result + refund snapshot.
- `RESOLVE` → snapshot the actionResult and the trigger queue at entry.

Snapshots are plain objects, never references to live Foundry docs.
The state body operates on the snapshot; only the transition's
`commit` hook writes back to the live world.

This is what fixes bleed class 5. The legacy refund snapshot taken at
Confirm time is replaced by a `CONFIRM`-entry snapshot, captured the
moment the action card is posted — not the moment the player clicks.

## 9. Hook and timer lifecycle

`HookRegistry` is the **only** code that calls `Hooks.on` /
`Hooks.off`. It exposes:

```js
const off = registry.on("updateCombat", handler);  // returns disposer
registry.disposeAll();                              // teardown
```

Internally it tracks `{ hookName, id, handler }`. The director's
`dispose()` calls `registry.disposeAll()` and is itself called from:

- `combatEnd` / `deleteCombat`
- `deleteToken` on the active combatant
- Manual `director.stop()`
- Test teardown

`TimerRegistry` does the same for `setTimeout`, `setInterval`, and
`requestAnimationFrame`. Every timer carries a label so leaks are
diagnosable.

This is what fixes bleed class 1. No handler self-registers; no
handler is responsible for its own cleanup.

## 10. Timeout / abort model

Every state has a declared timeout (or an explicit `null` if it's
synchronous and instant). On entering the state, the director starts
a single timer via `TimerRegistry`. The timer fires `dispatch({ type:
"TIMEOUT" })` — which is in every state's transition table, with a
sensible default (most go to `ABORTED`; `REACTION_WINDOW` goes to
`REACTION_WINDOW_DRAINED`; `ANIMATING` goes straight through to
`RESOLVE`).

`ABORTED` is a real state, not a flag. Its entry handler:

1. Calls each registered `onAbort` hook on the current state (state
   files can register one).
2. Releases any partially-applied AEs from this turn (tracked in
   `ctx.transientAEs`).
3. Resolves any pending UI promises (e.g. animation hide).
4. Posts a "Action cancelled" chat note.
5. Transitions to `CLEANUP`.

This is what fixes bleed classes 6 and 7. There is no path through the
director that leaves the UI hidden, an AE dangling, or a promise
unresolved — every state has a single exit, and every exit goes
through `CLEANUP`.

## 11. Concurrent-write avoidance

All writes to combat-relevant data go through one of four director
APIs:

- `ctx.actor.write(actorId, mutation)` — wraps `actor.update()`; runs
  on the GM, serialized by `dispatch()`'s lock.
- `ctx.combat.write(mutation)` — wraps `combat.update()`; same.
- `ctx.ae.create / update / delete` — wraps embedded-document calls;
  same. Routes through `FUCompanion.api.activeEffectManager.applyEffects`
  / `removeEffects` for content compatibility (AE classification,
  duplicate handling, FX).
- `ctx.freeAction.set / consume / clear` — director-owned free-action
  state. **This is new.** The legacy free-action state lives in an
  in-memory `Map` per client
  ([scripts/free-action-state.js](../scripts/free-action-state.js)),
  which is why the GM and the reactor's client can disagree about
  whether a free action is pending. The director's free-action map is
  GM-side only; reactor clients query it via intent or via a
  read-only mirror flag the director writes to the combat document.

Player clients never call these. Their intent triggers a transition,
the transition's `commit` calls the API, and the API runs on the GM.

Because all writes route through `dispatch()`'s lock, two clients
cannot race on the same field. This is what fixes bleed class 3 — the
free-action consume + turn-emitter clear race can't happen because
both go through the same serial dispatch.

### 11.1 What the director doesn't own

A few subsystems write to the world out-of-band of the director.
Their writes are not serialized by `dispatch()`'s lock. The director
must either route around them or accept the conflict:

- **Lancer-initiative module** writes activation counters via its own
  hooks. If the director uses Lancer initiative (it does, per §2.5),
  it observes those writes through `updateCombat` and translates
  them into FSM events; it never writes Lancer flags directly.
- **CSB and Foundry document lifecycle** fires hooks (`createItem`,
  `updateActor`, etc.) on every client. The director listens for the
  ones it cares about and ignores the rest. It does not assume it's
  the only writer.
- **Macro authors writing custom-logic snippets** can mutate the
  payload from inside a GMExecutor snippet. The director gates this
  by treating the snippet's output as a fresh snapshot to compare
  against the entry snapshot — if the snippet rewrites `targets`, the
  next state's commit re-runs the targeting refresh, the same way
  legacy ADC's `refreshCanonicalTargetsAndDefense` does after CLA.

## 12. Mapping: bleed classes → structural prevention

| # | Bleed class | Director's structural answer |
|---|---|---|
| 1 | Hook lifecycle leaks | `HookRegistry` is the sole owner; `dispose()` is guaranteed. |
| 2 | Phase-blind handlers | Transitions declared per state; events with no transition are queued, rejected, or dropped — never silently run. |
| 3 | Concurrent writes | All writes route through `dispatch()`'s serial lock on the GM. |
| 4 | Reaction re-entry | Depth counter with `MAX_REACTION_DEPTH = 3`; structural bound, not TTL. |
| 5 | Snapshot/apply races | State-entry snapshots are immutable; only the transition's `commit` writes back. |
| 6 | Animation hide/show desync | `ANIMATING` is a real state with timeout; entry/exit always pair via the FSM. |
| 7 | Abort orphans | `ABORTED` → `CLEANUP` always; cleanup releases UI, AEs, promises. |
| 8 | Ownership gates | Director runs on the GM only; all mutations route through its serial dispatch; player clients send typed intents and never write. Free-action state, previously per-client in memory, becomes GM-authoritative. |

## 13. Coexistence with the legacy flow

The two flows share the world data (actors, items, AEs) but not the
runtime control:

- Legacy `combatStart` hook continues to fire `turn-ui-manager` and
  `reaction-manager`. The director does not listen to `combatStart`.
- The director is started **only** via the explicit experimental entry
  point. While running, it consumes its own combat document, listens
  on its own intent channel, and never emits the legacy `oni:*` socket
  messages from §7.5's table.
- Reaction skills, AE definitions, and skill props are shared. The
  director re-uses the existing declarative reaction config schema
  (see `reaction-config-schema.md`) and the existing trigger registry
  / passive engine / effect-kind dispatcher; it just owns *when*
  those run via the `REACTION_WINDOW` state instead of letting the
  `oni:reactionPhase` event soup decide.
- The legacy `gm-executor` **is** used by the director, as a tool.
  It's the right primitive for running content-authored
  custom-logic snippets — GM-side, with an existing actor-ownership
  gate, throwing on failure. What the director adds is the *FSM
  ownership* around snippet execution: a snippet runs inside a
  specific state's handler, the post-snippet snapshot is compared
  against the entry snapshot, and any `cancelPipeline` /
  `skipPassive` signal becomes a transition decided by the
  director, not an out-of-band mutation. (See §14.4.)

If both flows are accidentally started on the same combat (e.g.
someone calls the experimental entry point while a real combat is
running), the director **does not** suppress the legacy flow. The
intent channel will simply find that the GM's actor mutations conflict
with the legacy flow's mutations, and the director's writes will
either be wasted or trigger validation errors. This is acceptable for
v1 — the experimental entry point is for testing in isolated combats,
not parallel-running with real play.

### 13.1 Party-wide reaction visibility

The legacy reaction system already broadcasts `OniReactionVisibilityBroadcast`
to non-owner clients so everyone can see who *might* react (ally
indicator pills, per `project_reaction_party_visibility`). The
director preserves this: the `REACTION_WINDOW` state's MATCH phase
produces the same `{tokenId, ownerUserIds, itemGroupsByTrigger}`
shape and the director broadcasts it on its own envelope (§6.1) so
non-owner clients can render the indicator. The reaction-UI code
that consumes it (legacy `reaction-buttonUI.spawnAllyIndicator`)
stays.

## 14. Open questions for v1 implementation

These are the things the design intentionally leaves unanswered;
they'll be decided when prototyping starts. Items that the legacy
audit closed (e.g. "should we reuse JRPGTargeting?") are not listed
here — they're decided in §2 / §6.

1. **Action computation black-boxing.** Does the director call
   `ActionDataComputation` directly, or wrap it in a thin
   `computeActionResult(snapshot) → actionResult` facade? The facade
   gives a seam to swap implementations later; the direct call is
   one less indirection. **Leaning facade**: ADC reads from many
   sources (actor, weapon, skill, world flags) and the snapshot
   abstraction lets us pass a frozen subset rather than the live docs.
2. **AE event handling.** AE create/delete fires Foundry hooks on
   every client. The director needs its own AE-event listener to
   convert AE lifecycle into FSM events (e.g. "AE created during
   RESOLVE → maybe a new trigger fires"). Where does that listener
   live — `HookRegistry` (one of N hooks) or its own `AEAdapter`
   module? **Leaning HookRegistry**: it's just another hook; the
   adapter abstraction is premature.
3. **Animation handler.** Reuse the legacy `ActionAnimationHandler`
   (which uses the `ONI_TURNUI_HIDE_FOR_ANIMATION` /
   `_SHOW_AFTER_ANIMATION` socket pattern) or write a director-native
   one? Reuse means inheriting the socket hide/show pattern that the
   audit flagged as drop-prone. A native handler tied to the
   `ANIMATING` state is more aligned with the FSM's invariants.
   **Leaning native** — but the legacy handler is well-tested, so
   v1 might wrap it: legacy plays the animation, director's
   `ANIMATING` state holds the timeout and the exit.
4. **Custom-logic snippet model.** Legacy CLA / CLR / passive
   modifier all route through `gm-executor.executeSnippet`. The
   director's COMPUTE / RESOLVE states can call the same API. But
   snippets can call `env.cancelPipeline()`, `env.skipPassive()`,
   `env.ui.chooseButtons()` — each is an effective FSM transition.
   Should we expose director intents to snippets (so a snippet's
   `cancelPipeline` becomes an `ABORT` intent) or keep snippets as
   black-box code that mutates the snapshot? **Leaning black-box**:
   the snippet runs, the director re-reads the snapshot, the
   transition's `commit` decides what to do — same pattern as
   ADC's `refreshCanonicalTargetsAndDefense`.
5. **Per-state file layout.** One big `transitions.js` vs. one file
   per state risks handler-state mismatch. **Leaning hybrid**:
   transition table in `transitions.js`, handler implementations in
   `states/*.js`. Each handler exports `{ onEnter, onExit, onAbort }`
   and the transitions file is the only place that names them.
6. **Testing surface.** The director is harness-friendly — single
   `dispatch()` entry point with a mockable intent channel. Should
   v1 ship with a Vitest suite that drives a full battle round
   through the FSM with no Foundry runtime? **Yes, ideally** — the
   legacy is hard to test because everything is hook-tangled; the
   director's whole value proposition is testability.
7. **Reaction skill cooldown enforcement.** Legacy expresses
   cooldowns as AE-presence + `consume_charge` — a "ready" AE gates
   availability, and consuming it deletes the AE. The director
   inherits this. But the AE-presence check happens at
   MATCH; if a passive elsewhere creates the cooldown AE *during*
   MANUAL, the next reactor's match shouldn't see the skill
   available. Does PASSIVE-phase re-evaluation (§7.2) cover this,
   or does MANUAL need its own re-check before each prompt? Likely
   PASSIVE re-eval is sufficient because PASSIVE precedes MANUAL,
   but worth confirming during prototype.

## 15. Out of scope for the design

- Performance tuning. The FSM's per-event overhead is trivial
  compared to AE evaluation; no point optimising prematurely.
- Plugin / extension API. The legacy reaction config schema is the
  extension point for content; the director itself is not pluggable.
- Migrating existing reaction skills. The schema is shared, so this
  is a no-op for v1.
- UX changes. Same chat cards, same turn UI surfaces, same JRPG
  picker. Only the runtime control flow is new.

## Appendix A — Audit corrections

The pre-design audit (Explore agent run, 2026-05-23) produced an 8-class
bleed taxonomy that this design is built on. A subsequent systematic
read-through of the legacy code found several factual errors in that
audit. They're documented here so future revisions don't reintroduce
the same misclaims.

| Audit claim | Reality | Source of truth |
|---|---|---|
| `gm-executor` has a silent fallback to local execution if GM unavailable | `gm-executor.js:833` throws `"socket is not ready"` for non-GM with no socket. No silent fallback. | [gm-executor.js:828–836](../scripts/gm-executor.js#L828-L836) |
| 29 reaction triggers | 30 triggers, including `creature_unleashes_zero_power` which was added later. | [reaction-triggers.config.js:108–355](../scripts/reaction-system/reaction-triggers.config.js#L108) and [reaction-config-schema.md](reaction-config-schema.md#canonical-trigger-keys) |
| 7 effect_kinds | 8 effect_kinds: `targeting`, `grant`, `apply_ae`, `consume_charge`, `consume_resource`, `redirect_target`, `chain`, `open_action_menu`. The reaction-config-schema doc's introductory list is one short — it doesn't enumerate `consume_resource` in the kinds list, but the dispatcher handles it (`reaction-grant.js:639`). | [reaction-grant.js:1317–1369](../scripts/reaction-system/reaction-grant.js#L1317) |
| `ActionDataComputation` is 1969 lines | 2059 lines. | [ActionDataComputation.js](../macros/Action%20Pipeline/ActionDataComputation.js) |
| Pipeline order: `…→ CreateActionCard → applyDamage-button → action-execution-core → ApplyActiveEffect (before_attack) → ResourceGate → CustomLogic-Action → PassiveLogic-Action → AdvanceDamage` | Actual order: `ADF → ADC → TGT → CLA → AAE(before_attack) → RG → PLA → CAC → (await player Confirm) → AEC → AdvanceDamage → Create Damage Card`. TGT runs **before** CAC, not after. AAE has two phases (before_attack inside ADC; on_attack emitted from CAC). | [action-payload-shape.md](action-payload-shape.md#pipeline-at-a-glance) |
| `applyDamage-button.js` is a separate macro in the pipeline | It's a chat-card button callback **inside** CreateActionCard. Confirming the card invokes `action-execution-core` directly. | [CreateActionCard.js](../macros/Action%20Pipeline/CreateActionCard.js) (button callback inside the post-card handler) |
| AutoPassiveManager is in `scripts/auto-passive-manager.js` (or doesn't exist) | Lives at [`scripts/passive-system/autoPassive-manager.js`](../scripts/passive-system/autoPassive-manager.js); called from `reaction-manager.js:249` as `AutoPassiveManager.processMatches(matches, ...)`. | Verified by Grep across the module. |
| Reaction window has 5 s timeout per reactor | The 5 s timer is plumbed but disabled by an early return at [reaction-window.js:316](../scripts/reaction-system/reaction-window.js#L316). Reactions wait indefinitely today. | reaction-window.js direct read. |
| Free-action state is per-actor (implicitly per-combat) | In-memory `Map` per client; lifecycle cleared by `updateCombat` / `deleteCombat` hooks. The GM and the reactor's client can diverge. | [free-action-state.js](../scripts/free-action-state.js) |

The 8-class bleed taxonomy itself remains valid; only specific
citations were wrong. The design's *structural answers* (single
dispatch lock, explicit transitions, snapshot model, depth-bounded
reaction window, guaranteed exits) are unchanged by these
corrections — they're just framed against a more accurate picture
of the legacy.

## Appendix B — Subsystem inventories

Full inventories of the legacy subsystems live in the conversation
that produced this design and are summarised here for cold-start
context. If detailed inventories are needed during implementation,
re-run the four parallel Explore audits (reaction system, action
pipeline, AE + state, multi-user infra) over the current code rather
than relying on this appendix, which will drift.

- **Reaction system** — 19 files, ~12,800 LOC. Public API surface
  via `FUCompanion.api.reactionSystem.*`. Socket channel
  `module.fabula-ultima-companion` carries 10 message types
  (`OniReactionPhaseRequest`, `_Resolved`, `_Offer`,
  `_VisibilityBroadcast`, `_CardSettled`, `_SubTick`, `_SubClose`,
  `_SubPickerOpened`, `_Closed`, `_Picked`).
- **Action pipeline** — 16 macro files + `action-execution-core.js`.
  Payload shape documented at
  [`docs/action-payload-shape.md`](action-payload-shape.md). Trigger
  emit sites: `ApplyActiveEffect.js:330–335` (oni:reactionPhase, on
  attack), `CreateActionCard.js:671–696` (on confirm),
  `Create Damage Card.js:649,711,735` (creature_takes_damage,
  shield_break, defeated).
- **AE + state subsystems** — `active-effect-manager/` (24 files),
  `passive-system/` (3 files), `free-action-state.js`,
  `fabula-initiative/fabula-initiative-turn-emitter.js` (727 LOC,
  writes `combat.flags.fabula-ultima-companion.turnState`).
- **Multi-user infra** — `gm-executor.js` (single-snippet executor),
  `dialog-system/` (3 files, JRPG speech bubbles),
  `jrpg-targeting-system/` (11 files, full picker lifecycle),
  `remote-choice-api.js` (request/response with timeout),
  `action-animation/` (PseudoAnimationNetListener,
  animation-asset-cache).
