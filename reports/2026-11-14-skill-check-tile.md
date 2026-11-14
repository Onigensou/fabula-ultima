# Skill Check tile + "status until next battle" (feat/skill-check-tile)

Heads-up for sarunphat. Two features, built together. No Battle Director file is edited, but the second one runs at the director's start hook and imports three `skill-effects.js` exports, so please read the "Battle Director touchpoints" section.

## 1. Held status: inflicted now, counts down in the next battle

Story events often end with "you're Slowed until your next battle". In this game that means:
- The actor is inflicted now (icon, Party Menu, attribute changes on checks).
- It does not count down on dungeon steps.
- When the actor's next battle starts, it becomes a normal battle condition. It counts down on their turns and is cleansed when that battle ends.
- A Rest cures it. (Oni's rulings, 2026-11-14.)

API: `FUCompanion.api.heldStatus`
- `inflict({ actors: "party" | [...], status, source, turns? })`
- `applyNow({ actors, status, steps? })`: an ordinary out-of-battle status, landed the way dungeon tiles land theirs.
- `release({ actors, status? })`
- `activate(actors)`
- `list(actor?)`
- `statusNames()`

Status names match loosely: "Paralyzed" finds Paralyze, "Slowed" finds Slow. Immune actors are skipped. On a player client, calls are relayed to the primary GM.

How it works:
- A held status is a real ActiveEffect built from the canonical condition template (`resolveCanonicalConditionTemplate`). It carries `heldUntilBattle: true` and `crossScene: true`.
- `shared/ae-lifetime.js` gains `isBattleHeld`. `isDungeonTickable` now says no for held effects, and `describe()` labels them "Carried into your next battle…".
- `crossScene` keeps `sweepTransientAEsAtSceneEnd` off a status that is still held. That's the case for a benched member: their status stays held for the next battle they actually fight in.
- Rest cures it through the existing `_clearTemporaryEffects`: its origin is the actor, and it is not rest-bound.

### Battle Director touchpoints
- `shared/held-status.js` (esmodule, loaded after `director-boot.js`) listens to `fu-director-started`, on the battle host only (`battleDirector.host().amHost`).
- It reads `director.dCombat.combatants[].actorDoc`. Every combatant whose actor has a held effect is converted in place with an update, not delete plus create:
  - flags from `buildAdoptedConditionData(eff.toObject(), { affinity })`: `directorAppliedBy` (lifetimeMode `target_turn_end`), `charges`, `bdAdopted`;
  - `heldUntilBattle` and `crossScene` removed.
- `getConditionAffinityFor`: IM at conversion deletes the status; RS clamps charges to 1, your rule.
- Sandbox (2026-11-14) showed conversion lands during the conflict-start reaction window at round 0, before ROUND_START. Zarg's Slow 3 / Paralyze 2 ticked to 2 / 1 on his turn end, and `stop()` swept them. If `fu-director-started` ever moves later than the first turn, a held status would miss a tick; please keep it before round 1, or tell me.

## 2. Skill Check tile runs itself

The `skill_check` tile type had no handler, so the GM ran it by hand. It now works like Random Battle:
- `tile-event-skill-check.js` is a thin request: socketlib `dungeonPathing.skillCheck` to the main GM.
- The walking client's turn waits for the reply. When the party leaves for the theatre scene, the handler sets `battleLaunching`.
- The GM side is `dp-skill-check.js`:
  - A picker with the dungeon's presets. Played ones are greyed with a count, and picking one again asks first.
  - A tile can pin a preset.
  - Freeform: the GM narrates, with a chip to request the check (Group Check or everyone), quick damage and status, End, and Finish.
  - The trip activates the map's theatre scene (first theatre in its Scene Network) and does not touch the dungeon's party token. Coming back, the dungeon rebuilds as after a battle.
  - On Finish: EXP through `expAwarder.awardExp` (1 by default, pass or fail), a log row on the party DB actor (`flags.<MOD>.skillCheckLog`), and the tile cleared.
- A preset is an Event Config event on a hidden theatre tile ticked "Use as a preset" (Fabula tab → Dungeon).

Shared files touched:
- `event-system/event-executeCore.js`: `gmExecuteEventTile(args, opts)`. The second argument is for internal callers only, never a socket payload. `opts.preset` skips the hidden, availability, party-token and range gates and run memory; `opts.onRowResult` gets each row's result. The result now has `endedEarly`. New `Core.runPreset()`.
- `event-system/event-gmChip.js`: the chip falls back to the tile's Monk's name before "Event tile".
- New actions in `event-system/event-rows-party-effects.js`: **Deal Damage** (through `applyDamage.applyToActor`, verbosity `fx`) and **Apply Status** (now, or carried into the next battle).
- `dungeon-pathing-system/dp-socket.js`: one handler, `SKILL_CHECK`, and `requestSkillCheck`.
- `dungeon-pathing-system/dp-tile-config.js`: the pin field and the preset fields.
- `module.json`: four new entries. `held-status.js` is an esmodule after `director-boot.js`.

## Found, not fixed (please look)

`activeEffectManager.applyEffects({ effects: ["Dazed"] })`, a status given by plain name, lands with `origin` set to the Debuff container item (`Item.XVOWOq9oUmEECGrU`). `AELifetime.isItemTransferred` then treats it as equipment-granted:
- dungeon steps never count it down;
- `rest-api _clearTemporaryEffects` skips it (origin isn't empty or an Actor).

The registry-object form that tiles use (`{ registryId, overrides }`) lands with origin `null` and behaves correctly. I didn't check which UI paths use the plain-name form.

## Not done
- **Save during a skill-check trip is not blocked.** The save system has no guard anywhere today, not even in battle. A save made on the theatre scene loads there, with the tile still present.
- Between the reply and the scene switch (~300 ms) the walking client is idle before the canvas tears down. Random Battle has the same gap.
