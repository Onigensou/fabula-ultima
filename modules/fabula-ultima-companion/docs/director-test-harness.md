# Director test harness

The standard tool for verifying any creature action without launching combat or asking the user to click through UI. API on `FUCompanion.api.test`.

**Use this BEFORE asking the user to playtest** — the harness can verify almost anything a battle would.

---

## Quick lookup

```js
// What do I have in the world?
const fx = await FUCompanion.api.test.getDirectorTestFixtures();
// → { scene, caster: {actorUuid, tokenUuid, items: {Heal, Lux, ...}},
//     ally: {actorUuid, tokenUuid}, enemy: {actorUuid, tokenUuid} }

// Preview a skill (no writes anywhere)
const c = await FUCompanion.api.test.runDirectorSkillCompute({
  skillUuid, casterTokenUuid, targetTokenUuids, force,
});

// Simulate RESOLVE (writes captured, NOT committed)
const s = await FUCompanion.api.test.runDirectorSkillSimulate({
  skillUuid, casterTokenUuid, targetTokenUuids,
  force, picks, preApply, override, round,
  acceptPassives, vismagusHpPaid,
});

// Attack simulate — basic weapon attack incl. two-weapon
const a = await FUCompanion.api.test.runDirectorAttackSimulate({
  attackerTokenUuid, targetTokenUuids,
  mode: "main" | "off" | "two-weapon",
  force, preApply, override, acceptPassives, round,
});
// → { passes: [{weapon, summary, actionResult}, ...], captures, ... }

// Scenario runner — declarative test bundle
const r = await FUCompanion.api.test.runDirectorScenarios([
  { name: "...", kind: "skill"|"attack",
    setup: { caster: "Name", targets: ["Name"] },
    action: { skill: "Heal" } | { weapon: "main" },
    args: { force, picks, override, acceptPassives, ... },
    expect: { writes: [...], aeApplied: [...], aeRemoved: [...] }
  },
]);
// → { total, pass, fail, results: [{ name, pass, failures, ... }] }
```

---

## Test fixtures (Training Ground scene)

`getDirectorTestFixtures()` returns these — never hard-code UUIDs.

| Actor | HP | Notes |
|---|---|---|
| Test Caster | 100/100 | PC, 5 bonds, Spiritist 10, Arc Wand equipped. Heal / Lux / Reinforce / Mercy / Soul Weapon / Healing Power / Support Magic / Vismagus / Aura / Barrier / + Arc Wand / Orb |
| Test Target Ally | 10/80 | PC, friendly. Use for heal/buff tests |
| Test Target Enemy | 50/50 | NPC, MDEF 10. **affinity Light=VU + Dark=RS**, others NE |

---

## Args reference

| Field | Type | Effect |
|---|---|---|
| `skillUuid` | required string | Skill item UUID |
| `casterTokenUuid` | required string | Casting token UUID on a scene |
| `targetTokenUuids` | required string[] | Target tokens |
| `force` | object | Force dice (see below) |
| `picks` | `string[]` or `{menuLabel?, index?}[]` | Queue for `open_action_menu` (Reinforce, Torpor, Cleanse). Strings = case-insensitive `menu_label` match |
| `preApply` | `[{ targetActorUuid, data }]` | Apply AEs before running. Briefly mutates world; cleaned up in `finally` |
| `override` | `{ SL?, CHAR_LEVEL?, BOND_COUNT?, BOND_STRENGTH? }` | **Non-mutating** formula-resolver override. Consulted by `buildSkillResolver` before its switch. Cleaned up in `finally` |
| `acceptPassives` | `true` / `false` / `{[skillName]: bool}` | Auto-handle ask-mode passive prompts via `globalThis.__FU_HARNESS_ACCEPT_PASSIVES__`. **Default `false`** (harness never hangs on a Dialog). Object = per-skill substring map |
| `vismagusHpPaid` | boolean | Stamps `ar.vismagusHpPaid = true` so RESOLVE's grant suppresses self-heal on caster. Tests Vismagus's RESOLVE behavior without entering TARGET's alt-cost Dialog |
| `round` | integer | Override `dCombat.round` (passed to formula resolvers). Default 1 |

### Forcing rolls

```js
force: { crit: true }    // rA = rB = max die → guaranteed crit
force: { fumble: true }  // rA = rB = 1 → guaranteed fumble
force: { hit: true }     // smallest non-crit total ≥ target's DEF/MDEF
force: { miss: true }    // largest non-fumble total < target's DEF/MDEF
force: { rA: 6, rB: 5 }  // raw dice values
```

Raw `{rA, rB}` wins over semantic flags. `hit`/`miss` use the first target's defense. Foundry V12 dice use `Math.ceil((1 - CONFIG.Dice.randomUniform()) * faces)` — the harness patches `randomUniform`, not `Math.random`. Verified d6/d8/d10/d12.

---

## Return shape

```js
// runDirectorSkillCompute
{ ok, actionResult, summary, enqueued, dispatched }
//   ok:false + refused:true + reason:"compute_refused:<INTENT>" when COMPUTE
//   declined to build a card. `actionResult` is still returned (whatever got
//   computed before the bounce) so a refusal test can inspect it.

// runDirectorSkillSimulate
{ ok, actionResult, summary, captures, perActorWrites, preApplied, resolveError }
//   captures.actorUpdates: [{actorUuid, actorName, patch}]
//   captures.aeCreates:    [{parentUuid, name, changes, flags}]
//   captures.aeDeletes:    [{aeId, aeName, parentUuid}]
//   captures.itemUpdates / aeUpdates similarly
//   perActorWrites: per-actor rollup (cleaner for assertions but LOSSY —
//     two writes to current_hp collapse to the last; read actorUpdates
//     for the ordered list)
```

`summary.healed` / `damaged` / `missed` are derived from COMPUTE's `perTargetResults` — they preview the action even if RESOLVE writes a different value (e.g. clamp to max).

### Asserting a REFUSAL

`ok` used to be a hardcoded `true`, so `runDirectorSkillSimulate`'s `if
(!compute.ok)` guard was dead code and simulate walked into RESOLVE on an action
COMPUTE had bounced — reporting the writes as though the action were allowed.
That is a false green in the permissive direction, and it hit hardest on the
tests most worth trusting: a gate is proven by showing the action does **not**
happen.

`ok` is now the presence of `INTERNAL_DONE`, the one intent `Compute` emits on
success. Its only other intents are `TARGET_BACK` (pre_activate refused or
cancelled) and `ABORT` (hard failure), and an empty queue — a swallowed throw —
also reads as a refusal. Asserting the success token rather than blacklisting
refusals means a refusal path added to `Compute` later fails closed here by
default.

```js
const c = await FUCompanion.api.test.runDirectorSkillCompute({ ... });
// a gate that SHOULD refuse:
assert(c.ok === false && c.reason === "compute_refused:TARGET_BACK");
// a gate that should NOT refuse — do not settle for a truthy actionResult,
// it is returned on the refusal path too:
assert(c.ok === true);
```

⚠ A refusal is the engine working correctly, but the regression collector counts
`!ok` as an error (`collect.js:245`) and reduces the fingerprint to `{ok, reason}`
(`:150-151`). So a skill that starts refusing shows up as golden churn plus an
error, not as a silent pass.

---

## Working examples

```js
// Heal both targets, preview shape
await FUCompanion.api.test.runDirectorSkillSimulate({
  skillUuid: fx.caster.items["Heal"].uuid,
  casterTokenUuid: fx.caster.tokenUuid,
  targetTokenUuids: [fx.caster.tokenUuid, fx.ally.tokenUuid],
});
// → perActorWrites: Caster HP→90 (clamp), Ally HP→60 ✓

// Force a Lux crit
await FUCompanion.api.test.runDirectorSkillSimulate({
  skillUuid: fx.caster.items["Lux"].uuid,
  casterTokenUuid: fx.caster.tokenUuid,
  targetTokenUuids: [fx.enemy.tokenUuid],
  force: { crit: true },
});
// → roll.isCrit=true, damaged: [{amount: 46, affinity: VU, crit: true}]

// Fire Healing Power passive on Heal; decline Support Magic
await FUCompanion.api.test.runDirectorSkillSimulate({
  skillUuid: fx.caster.items.Heal.uuid,
  casterTokenUuid: fx.caster.tokenUuid,
  targetTokenUuids: [fx.ally.tokenUuid],
  acceptPassives: { "Healing Power": true, "Support Magic": false },
  override: { SL: 1, BOND_COUNT: 5, CHAR_LEVEL: 10 },
});
// → captures.actorUpdates has TWO writes to ally HP

// Vismagus self-heal suppression via injected AR flag
await FUCompanion.api.test.runDirectorSkillSimulate({
  skillUuid: fx.caster.items.Heal.uuid,
  casterTokenUuid: fx.caster.tokenUuid,
  targetTokenUuids: [fx.caster.tokenUuid, fx.ally.tokenUuid],
  vismagusHpPaid: true,
});
// → actorUpdates: ally updated, caster NO update (suppressed)
```

---

## Writing assertions

```js
const r = await FUCompanion.api.test.runDirectorSkillSimulate({...});

console.assert(r.actionResult.roll.isCrit === true);

const enemy = r.perActorWrites.find(p => p.actorName === "Test Target Enemy");
console.assert(enemy.propPatches["system.props.current_hp"] === 4); // 50 - 46

console.assert(r.captures.aeCreates.some(c => c.name.includes("Reinforced")));
```

---

## Known limits

| Limit | Workaround |
|---|---|
| Cross-module edits need Ctrl+Shift+R | Hard-reload Foundry after multi-file edits. Single-file edits inside the harness reload fine (entry module is cache-busted per call; deeper static imports aren't). **Exception:** the `state-handlers.js → skill-effects.js` edge is hot — the harness re-imports it per call, and live you can `await FUCompanion.api.test.reloadHot()` to pick up a `skill-effects.js` edit with no refresh (see `hot-reload.js` / `registerHotModule`) |
| Cascading-state for chained skills (Mercy + damage) | Use `preApply` to install Mercy before the damage skill |
| `summary.healed` shows COMPUTE preview only | Read `captures.actorUpdates` directly for the ordered write list |
| Vismagus alt-cost Dialog (TARGET phase) | Use `vismagusHpPaid: true` to test RESOLVE-side suppression directly |

`location.reload()` from the bridge does NOT clear the ESM cache reliably — Foundry serves modules with cache-able headers. Only Ctrl+Shift+R / Cmd+Shift+R does.

---

## Related

- [battle-director-dev-guide.md](battle-director-dev-guide.md) — high-level onboarding
- The test-bridge protocol (in the dev guide, § 5) — how to drive the harness from outside Foundry
