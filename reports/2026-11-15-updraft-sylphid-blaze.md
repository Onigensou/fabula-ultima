# Conflict events: Updraft + Sylphid Blaze (v1.0.615)

Two new conflict events with tutorial pages, set on four battle maps. Commits `06c46f43` (code), `49206470` (world: 4 scene flags + goldens + images), `5191197d` (design doc).

## The rules

- **Updraft** (Vastwind_Battlemap001/002): whenever a creature takes Air damage, it gains Flying until the end of its next turn.
  - Air HP loss from a hit or a hazard. Absorb (a gain) and Immune (0) don't trigger it.
  - It applies the canonical Flying as a `target_turn_end` countdown (the Liftoff model): 1 charge, or 2 when hit on its own turn. A second Air hit refreshes it.
  - A creature that already flies another way is left alone. The Flying AE carries `flags.fabula-ultima-companion.updraft = true`, and it is swept at conflict end.
- **Sylphid Blaze** (Wyrmwood_Battlemap001/002): every Burn application lands +1 stack, and Burn damage is ×1.1.

## Engine change you should know about: `modifiers`

A new optional key on a conflict event, for rules that change a number inside BD's executor:

```js
modifiers: { statusCharges: { Burn: 1 }, statusDamage: { Burn: 1.1 } }
```

Three small seams in `skill-effects.js`, all reading `conflictStatusModifier()` (conflict-event-runtime.js) through one helper, `conflictEventModifier`:

- **`apply_ae`, add_charges branch:** bonus added after the Resist clamp, only on a real gain.
- **`apply_ae`, fresh create/replace:** bonus added to the final `charges` just before `if (replaceTarget)`, capped by `chargesMax`.
- **`deal_damage`:** any row with `emit_status` gets the multiplier after the amount formula, floored, before affinity. This covers the Burn tick and every `trigger_status` replay (Flame Claw, Meteor).

All three seams are neutral with `none`, out of combat, or for a status the event doesn't name. They also apply in the Free Round.

An event with modifiers needs no handler; the registry now allows that.

## World data

`conflictEvent` flags on the 4 scenes only. The scenes store was audited document by document against HEAD: those 4 flags, plus a `modifiedTime`-only change on Eisendrache_Kingdom. world-export: 0/0/0. The 4 scene goldens were re-blessed.

## Tests

- **Unit:** registry 51 and updraft 16 pass; the existing conflict-event suites still pass.
- **Staging World, Sylphid Blaze vs a no-event control:** Burn 3 → 4 (control 3), +2 → +3 (control +2), tick 21 → 23 (control 21).
- **Staging World, real fight:** Burn stacks 4 → 8 → 12, and a tick of 15 became 16.
- **Updraft:** lifted on Air and expired at the end of the target's next turn.

## Heads-up

- King Gorger drops its own Flying on Crisis. An Air hit can then give it a 1-turn Updraft Flying, which is the literal rule.
- Not played at a real table yet.
