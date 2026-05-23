# Battle Director — v1 Prototype

Experimental, parallel battle flow. **Not used in normal gameplay** — the legacy battle system (`scripts/turn-ui-manager.js`, `scripts/reaction-system/`, `macros/Action Pipeline/`, etc.) is untouched.

See [`docs/battle-director-design.md`](../../docs/battle-director-design.md) for the full design and rationale.

## How to invoke

### Primary path — through the BattleInit dropdown

After Setup-relaunching the world (see "Critical note" below), the normal Battle Init flow now has a **Combat System** dropdown in the Battle Prompt:

1. Click the floating combat button (⚔️) to open the BattleInit dialog.
2. In **Combat System**, select **Battle Director (EXPERIMENTAL)**.
3. Confirm the prompt.

The legacy Manager macro sees `battleSystem === "director"` in the payload, **skips its entire pipeline** (gate, resolver, transition, layout, spawner, preload, entrance, initiator, unleash, record), and delegates to a director-owned macro (`BattleInit — Director Manager`). That macro:

1. Suppresses the legacy combat hook handlers (`turn-ui-manager`, `reaction-manager`, `fabula-initiative-controller`, etc.) — see `legacy-suppressor.js`.
2. Calls `runDirectorInit(payload)` which activates the battle scene, spawns enemy tokens, creates the Combat doc, rolls initiative, and starts combat — all using Foundry native APIs + the public `FUCompanion.api.animationCache` for the curtain.
3. Calls the director's `start()` on the new combat.

When combat ends, `stop()` restores the legacy hook handlers so subsequent legacy-mode combats work normally.

### Manual paths — console

```js
// Payload-driven (full PREP pipeline — director creates combat from scratch):
await FUCompanion.api.experimental.battleDirector.start({ payload: <yourPayload> });

// Combat-driven (manual fallback — attaches to an existing combat, skips PREP):
await FUCompanion.api.experimental.battleDirector.start(game.combat.id);
```

The payload form runs the same pipeline as the Director Manager macro. The combat-id form is for testing the FSM against an already-set-up combat — handy if you don't want to go through the full prep flow.

Either way:

```js
// Check status:
FUCompanion.api.experimental.battleDirector.status();

// Stop manually:
await FUCompanion.api.experimental.battleDirector.stop();
```

The director also auto-stops when:
- Combat is **deleted** (`deleteCombat` hook)
- Combat is **ended** (`combatEnd` hook — fired by the BattleEnd Manager flow)
- Combat is **deactivated** (`updateCombat` with `active: false`)

### Ending a director battle

The same End Combat button used by legacy battles. When clicked, the legacy `[BattleEnd: Manager]` macro detects the director-mode combat (via the `flags.fabula-ultima-companion.directorMode` tag stamped during PREP) and **delegates to `[BattleEnd: Director Manager]`**, skipping all the legacy BattleEnd steps (Prompt, Gate, FX, SummaryLogic, SummaryUI, Transition, Cleanup, CameraReset, ResetResource).

The Director End Manager:
1. Calls `api.stop()` — director cleans up spawned tokens (via the `directorSpawned` flag), removes Octopath UI, restores the legacy hook listeners.
2. Deletes the combat document.
3. Activates the source scene (from `directorMode.sourceSceneId` stamped during PREP).

If the combat is NOT director-mode (legacy combat), the BattleEnd Manager runs its normal pipeline unchanged.

### Critical note

This module adds a new `esmodules` entry to `module.json`. Per the legacy system's known constraint, **F5 does not re-parse `module.json`** — you must either:

- **Setup-relaunch the world** (return to setup, then re-launch), OR
- Restart Foundry entirely.

After the first launch with the new code, plain F5 reloads work fine.

## v1 scope

**Implemented end-to-end:**

- FSM with the full state set from the design doc (IDLE, ROUND_START, TURN_START, DECLARE, TARGET, COMPUTE, CONFIRM, RESOLVE, REACTION_WINDOW, CLEANUP, TURN_END, ROUND_END, ABORTED, STOPPED).
- Single dispatch lock — `director.dispatch()` is serial; new events queue.
- Explicit transition table — events without a declared transition are queued (persistent) or dropped (transient). No handler runs implicitly.
- Hook + Timer registries — every `Hooks.on` and `setTimeout` routes through them; `stop()` guarantees cleanup.
- Snapshot model — state-entry inputs are frozen.
- Octopath command-button UI replicating the legacy look, with a blue-tinted gold and a `DIRECTOR` pip.
- **PREP is now an explicit FSM state**. When the director is started with a payload (the Director Manager macro path), the FSM transitions `IDLE → PREP → ROUND_START → TURN_START → DECLARE`. `PrepState.onEnter` runs the full pre-combat pipeline (`runDirectorInit`) and only enqueues `INTERNAL_DONE` after combat is created + started:
  1. Suppress legacy listeners (early, before any combat hooks fire)
  2. Raise curtain (black screen)
  3. Resolve encounter (manual picks / fixed encounter table / random)
  4. Resolve party members from `payload.party.members`
  5. Activate battle scene
  6. Compute layout (party right / enemies left, matches legacy positions, scales to scene size)
  7. Spawn tokens **hidden** (`alpha: 0`) at layout positions, flagged `directorSpawned: true`
  8. Build preload URL list (token textures + BGM) and preload across clients via `FUCompanion.api.animationCache.prepareUrlsAcrossClients`
  9. Drop curtain (scene visible, tokens still invisible)
  10. Entrance animation — staggered fade-in (party first, then enemies)
  11. Create Combat doc, add combatants, roll initiative, startCombat
  12. Hand combat to the director (`_setCombat`) so the rest of the FSM picks it up

  If PREP fails (scene not found, network timeout, no participants resolved), `ctx.abortReason` is set and the FSM dispatches ABORT. The transition table routes `ABORTED → STOPPED` when `combat.started` is false, so the boot's cleanup runs (spawned-token deletion, suppressor restore) without trying to advance any turns.

  The manual-fallback path (`start("combat-id-string")` against an already-running combat) skips PREP entirely — the FSM goes straight `IDLE → ROUND_START`.

  Layout positions match the legacy Layout Engine (base x 790–1082 / y 181–356 for party, x 274–336 / y 197–329 for enemies, both with `+22` Y offset and `ENEMY_SPREAD = 1.80` applied around the enemy column midpoint). Scaled to actual scene dimensions if they differ from the 1682×788 reference.
- **Curtain timing**: the black curtain stays up until `prepareUrlsAcrossClients` returns. The user requested "only fade out when preload is completed" — we await the call (which waits for client ACKs or its internal timeout), warn the GM if it timed out, then drop. Battle-stance video playback kicks BEFORE the curtain drops so the looping animations are running the moment tokens become visible.
- **Battle stance animation**: WEBM/MP4 token textures auto-play and loop. After spawn, the director walks each token's PIXI texture, finds the underlying `<video>` element, and kicks `play()` with `loop = true`. Static (PNG/JPG) textures skip this step silently. No separate actor property — the prototype-token texture IS the stance animation.
- **Auto-add all participants to combat on scene load**: every token the director spawns during `runDirectorInit` (party + enemies) is automatically added as a combatant in the new Combat doc. Defensive `ensureAllInCombat` re-check catches any that slipped through and patches them in. No manual GM intervention required to set up the participant list. (Hand-placed tokens on the scene are NOT auto-added in v1 — they stay outside combat unless you add them via the standard Foundry Combat Tracker.)

  Skips ALL legacy BattleInit macros (gate, resolver, transition, layout, spawner, preload, entrance, initiator, unleash, record).
- **Legacy-listener suppression** — automatic on director.start(), automatic restore on stop(). Director's combat doesn't trigger duplicate gold buttons or phantom legacy reactions.
- **Attack** flow: pick target via click-to-select picker → roll MIG+DEX → post action card with hit/miss/damage → Confirm applies HP damage.
- **Guard** flow: posts a card; on Confirm, sets an actor flag noting Guard is active until the actor's next turn. (No proper AE is created in v1.)
- Turn advancement via `combat.nextTurn()`.
- Combat-end detection on `deleteCombat`, `combatEnd`, or `updateCombat` with `active: false`.

**Stubbed:**

- Skill / Spell / Item / Equipment / Study / Hinder / Objective / Switch — clicking any of these shows a notification and returns to DECLARE. No flow implemented in v1.
- `REACTION_WINDOW` is a 100ms no-op pass-through. No reactions fire.
- No proper Active Effect application (Guard is just an actor flag).
- No animation handler integration (the `ANIMATING` state isn't even in the v1 transition table).
- No multi-target / multi-hit attacks.
- No equipped-weapon lookup — all attacks roll MIG+DEX with HR+5 damage.
- No affinity / defense type handling (no Vulnerable / Resistant / Immune / Absorbing).
- No fumble Fabula Point granting.
- No custom-logic snippet execution.
- No reaction-config integration.
- Damage application doesn't go through `apply-damage-core.js` — it just writes `system.props.current_hp` directly.
- Encounter modes supported: **manual** (with `quantity` honored), **fixed encounter** (rolls encounter table for a comma-separated name list, `"Random"` keyword draws from enemies table), and **randomize** (3–5 random draws from enemies table). Champion-rank filtering is NOT replicated — bosses spawned from a roll table will spawn (use manual list if you need that gate).
- Tokens spawned by the director are flagged `flags.fabula-ultima-companion.directorSpawned = true`. On battle end / `stop()`, those tokens are auto-deleted from the battle scene; hand-placed tokens stay. `cleanupDirectorSpawnedTokens(scene)` exposed on the API for manual recovery.

**GM-only:**

The Octopath buttons and target picker spawn only on the GM client in v1. Player clients see nothing. The `IntentChannel` is wired but only used for socket scaffolding.

## Coexistence with legacy

The only shared surface between the director and the legacy system is the **Battle Prompt UI** (the dropdown dialog) — the moment the user confirms it, the legacy Manager hands off to the director-owned `BattleInit — Director Manager` macro and never runs another legacy step.

To prevent the legacy modules' Foundry hook handlers from firing on the director's own combat/actor mutations, `legacy-suppressor.js` snapshots and removes the specific hook handlers from `Hooks._hooks` when the director starts. They're restored when the director stops. The legacy modules' code is unchanged; only their runtime hook subscriptions are temporarily neutralized.

**What gets suppressed** (during director combat):

- `turn-ui-manager` — `updateCombat`, `canvasReady` (no gold Octopath buttons)
- `reaction-manager` + `reaction-phaseHandler` — `oni:reactionPhase` (no legacy reactions fire)
- `fabula-initiative-controller` — `combatStart`, `updateCombat`, `updateCombatant`, `canvasReady`, `combatEnd`, `deleteCombat`
- `fabula-initiative-turn-emitter` — `preUpdateCombat`, `updateCombat`, `deleteCombat`, `combatRound` (no `turnState` flag writes)
- `fabula-initiative-round-announcer` — `preUpdateCombat`, `updateCombat`
- `fabula-initiative-autoUntarget` — `updateCombat`, `deleteCombat`
- `creature-defeated-emitter` — `preUpdateActor`, `updateActor` (no `creature_defeated` trigger emit)

**What stays active** (deliberately):

- `auto-crisis-detection` — real Fabula game mechanic, applies Crisis AE at low HP
- `auto-defeat` — marks tokens defeated when HP hits 0
- `cutin-receiver` — cinematic UI, harmless
- All Foundry-native hooks (combat doc lifecycle, etc.)

Inspect the current suppression set with `FUCompanion.api.experimental.battleDirector.legacySuppressor.snapshot()`.

**Finding leaks**: if you see legacy chat cards, SFX, or UI firing during a director combat, the suppressor missed a listener. Use:

```js
FUCompanion.api.experimental.battleDirector.legacySuppressor.dumpHooks("combatStart")
// → [{ index, length, snippet }, ...]
```

This lists every currently-registered handler for a given hook (after suppression), with a snippet of each function's source. Find the offender, grab a distinctive string from its source, and add a new entry to `TARGETS` in `legacy-suppressor.js`. Common noisy hooks to check: `combatStart`, `combatRound`, `combatTurnChange`, `updateCombat`, `preUpdateCombat`, `createCombatant`, `oni:reactionPhase`.

## File map

```
scripts/battle-director/
  director-boot.js       — esmodule entry; registers API on `ready`
  director.js            — BattleDirector class + dispatch loop
  director-combat.js     — DirectorCombat + DirectorCombatant: director-owned
                            authoritative combat model. FSM reads from here,
                            not from Foundry's Combat doc.
  director-init.js       — director-owned BattleInit (scene activate, spawn,
                            combat create, startCombat) — replaces the legacy
                            Manager pipeline in director mode
  legacy-suppressor.js   — finds + removes specific legacy hook handlers on
                            director start, restores on stop
  states.js              — state constants + transition table
  intents.js             — intent type constants
  registries.js          — HookRegistry + TimerRegistry
  intent-channel.js      — GM ↔ player socket (v1 stub-ish)
  snapshot.js            — state-entry snapshot helpers + actor prop readers
  turn-ui.js             — Octopath command-button menu (director-namespaced)
  target-picker.js       — click-to-pick canvas overlay
  action-card.js         — chat card with Confirm/Cancel buttons
  state-handlers.js      — per-state onEnter/onExit logic + Attack/Guard
  logger.js              — scoped `[BD]` console logger
  README.md              — this file

macros/Battle Init/
  [Macro] BattleInit — Director Manager.js
                         — invoked by the legacy Manager when battleSystem=director
                            calls runDirectorInit(payload) then director.start
```

## Authoritative combat model (DirectorCombat)

Starting in this iteration, the director maintains its own combat state in a
plain `DirectorCombat` object (see `director-combat.js`) alongside the
Foundry Combat document. The relationship:

- **`director.dCombat`** — DirectorCombat instance. Owns `round`, `turn`,
  `started`, `ended`, and the ordered `combatants` list. The FSM reads this
  for all turn / round / current-combatant decisions.
- **`director.combat`** — Foundry Combat document. Kept as a *shadow* for
  the Combat Tracker UI display, the End Combat button, and external module
  compatibility. After each `dCombat.nextTurn`, `mirrorTurnToFoundry`
  syncs the Foundry doc's `turn` and `round` to match.

PrepState builds both during init: the Foundry combat is created and started
(so Lancer Initiative can register activations and the tracker can show the
encounter), then `buildDirectorCombat({scene, partyTokens, enemyTokens})`
produces the director-owned model.

Phase 1 scope: turn advancement runs through dCombat. Phases 2+ will move
initiative ordering, activation counters, and reaction-window state.

Inspect with:

```js
FUCompanion.api.experimental.battleDirector.status()
// returns: { dCombat: {round, turn, current, ...}, foundryCombat: {...}, ... }
```

## Debugging

- All director logs are prefixed `[BD]` — filter the console by that string.
- `FUCompanion.api.experimental.battleDirector.status()` returns the current state, combatant, hook count, and timer count.
- The latest director instance is exposed at `globalThis.__fuDirector_lastInstance` for post-crash inspection. You can read `__fuDirector_lastInstance.state`, `.ctx`, `.hooks.snapshot()`, `.timers.snapshot()` to see what was going on.
- The FSM has a **transition rate limiter**: if it makes more than 50 transitions in 1 second (typically a malformed transition table or a state that immediately INTERNAL_DONEs back to itself), the director self-stops with `err("Transition rate-limit exceeded ...")` and disposes all hooks/timers.
- The Turn UI's PIXI tick callback is wrapped in try/catch — render errors won't crash the canvas, they just log up to 60 times before suppressing.

## Extending

To add a new command (say "Skill"):

1. Add the flow to `state-handlers.js` Target.onEnter — branch on `command === "Skill"`. Probably call a Skill picker dialog.
2. Add the COMPUTE branch — roll the skill's accuracy formula, build an actionResult of `kind: "Skill"`.
3. Add a `buildSkillBody` to `action-card.js` and wire it into `postActionCard`'s kind switch.
4. Add the RESOLVE branch — apply damage, emit reaction triggers (when reaction support lands).

The FSM and dispatch lock don't change. Only the per-command logic does.

To add a new state, edit `states.js` (add to `STATES`, `STATE_TIMEOUT_MS`, `TRANSITIONS`) and `state-handlers.js`. The transition table is the single source of truth — events that aren't declared in it are queued or dropped.
