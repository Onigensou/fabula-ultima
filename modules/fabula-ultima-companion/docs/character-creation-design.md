# Character Creation

An MMO-style wizard that walks a player through building a new PC and produces
a fully configured Actor. Entered from the **Create Character** button on the
title screen, between Load Game and Options.

Branch: `feat/character-creation`.

---

## Loop

```
Title screen ▸ Create Character
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 1 Profile  2 Attributes  3 Classes  4 Equipment         │
  │ 5 Bond     6 Summary                                    │
  │                                                         │
  │  ← Back        [step body]              Next →          │
  └─────────────────────────────────────────────────────────┘
        │  Create (summary only, gated on validateAll)
        ▼
  acting GM ▸ applyCreate ▸ Actor
```

Every step is backtrackable — the golden rule. The rail jumps to any step
already visited plus the next one, and the summary carries a per-panel `edit`
link straight back to the step that owns it. Going forward is never blocked;
only **Create** enforces completeness.

---

## Files

| File | Role |
|---|---|
| `cc-const.js` | Rulebook constants, budget/points/milestone formulas, emotion pairs, message types |
| `cc-folder.js` | Resolves `Actors ▸ Player Character ▸ <Username>'s PC` |
| `cc-draft.js` | The draft model, validation, reconciliation, step machine |
| `cc-app.js` | Overlay shell, step rail, nav, finalize dispatch |
| `cc-step-profile.js` | Step 1 |
| `cc-step-attributes.js` | Step 2 — also owns `applyMilestones` / `effectiveBases` / `previewDerived` |
| `cc-step-classes.js` | Step 3 |
| `cc-step-equipment.js` | Step 4 — also owns the equipment catalogue reader |
| `cc-step-bond.js` | Step 5 |
| `cc-step-summary.js` | Step 6 |
| `cc-api.js` | The finalize transaction (GM-side) |
| `cc-bootstrap.js` | Public API, transport install |

Step modules import `STEP_RENDERERS` from `cc-app.js` and register themselves;
`cc-bootstrap.js` imports the steps. The dependency runs one way — steps import
the shell, never the reverse — so there is no cycle.

`cc-app.js` imports `cc-api.js` **lazily**, inside `_finalize`. The write path
pulls in the whole level-up system, and a step module importing the shell must
not drag that along with it.

### Step renderer contract

```js
STEP_RENDERERS.set("<id>", {
  render(draft) -> html string,
  bind(rootEl, draft, ctx),
  reset?()            // clear transient view state between characters
});
```

`ctx` gives a step:

| | |
|---|---|
| `ctx.edit(fn)` | mutate, reconcile, re-render — for `change` and structural events |
| `ctx.touch(fn)` | mutate only — **for typing**, see below |
| `ctx.refresh()` | re-render without reconciling |
| `ctx.syncFoot()` | update the footer figure in place |
| `ctx.app` | the shell, for `goToStep` |

**Why `touch` exists.** The shell rebuilds `innerHTML` on render. Committing on
every keystroke would destroy the focused node and drop the caret after one
character. Text inputs therefore use `touch` on `input` and `edit` on `change`.
The same reasoning is why the class and equipment search boxes redraw only
their own list rather than the whole step.

---

## Decisions

These were settled with the table owner and are load-bearing.

1. **Blank clone, not `reloadTemplate()`.** The CSB template actor carries zero
   props, so a fresh stamp cannot reproduce a real PC's dropdown and derived
   state. `_CC Blank PC` (`CCBlankPC000Seed`) is a clone of the leanest PC on
   the current template version with every character-specific prop neutralised —
   355 props, no items, no effects. Seeded by
   `tools/safe-edit/_seed-cc-blank-pc.js`.
2. **Destination** is `Actors ▸ Player Character ▸ <Username>'s PC`, matched
   **exactly**. Fuzzy username→folder matching scored 17/20 on this world's
   roster, which is the worst possible result: right often enough to trust,
   wrong often enough to misfile. Older hand-made folders are legacy and left
   alone.
3. **The player is granted OWNER** on their character immediately.
4. **Budget** = `500 + (level − 5) × 50`. The rulebook's own p.229 example
   contradicts its stated rule (level 30 gives 2000z where the formula gives
   1750); the formula won.
5. **The 2–3 starting class rule is enforced only below level 10**, where
   mastery is not yet reachable. At 10+ a mono-class build is legal and the rule
   lifts. Enforced as a hard block on the *upper* bound; the lower bound is a
   validation issue, since a build in progress is legitimately below it.
6. **Characters created at 20 or 40+ receive their milestone attribute
   advances**, and the ledger is written so they cannot be claimed twice.
7. **Any user may open the wizard.**

---

## The draft

```js
{
  step: "profile", seen: ["profile"],
  profile:    { name, pronouns, identity, theme, origin, backstory, img, tokenImg },
  attributes: { level, arrayKey, assign: {mig,dex,ins,wlp}, milestonePicks: [] },
  classes:    [ { classKey, className, skillUuid, skillName, benefit, facetUuids[] } ],
  equipment:  { picks: [ { uuid, name, cost, slot, isMartial, handSlots, range, category } ] },
  bond:       { name, rel, e1, e2, e3 },
}
```

`classes` is **one entry per Skill Point**, not one per class. Class level is
the count of entries with that key; skill level is the count with that skill
uuid. This is the shape finalize replays.

### Reconciliation

`reconcile(draft)` runs after any edit and returns `{ trimmed, warnings }`.

The rule: **never silently discard a choice.** It trims only what would
otherwise be incoherent — picks past a shrunken pool, an assignment whose die
no longer exists in the array. Trimming is always from the **end**, so the
earliest decisions survive, since a later pick was often built on an earlier
one. Over-budget equipment is **reported, never trimmed**.

---

## Rules and where they live

| Rule | Client (courtesy) | GM (authoritative) |
|---|---|---|
| Point pool = level | `draftPointPool` | `skill_point` seeded at creation |
| Class level ≤ 10 | `canSpend` | `validateSpend` |
| Skill level ≤ its max | `canSpend` | `validateSpend` |
| ≤ 3 unmastered classes | `canSpend` | `validateSpend` |
| 2–3 classes below level 10 | `canSpend` + `validateStep` | `validateAll` in `applyCreate` |
| Budget not exceeded | `validateStep` | `validateAll` in `applyCreate` |
| Spend gate (title/camp) | window greys out | `gateState` in `applyCreate` **and** each spend |

The client checks exist so a player is never told "no" only at the very end.
The GM re-checks everything regardless.

`gateState` reads `game.scenes.active`, the **world's** active scene, so the
player's window and the executing GM always agree. Creation works from the
title screen because `levelup-gate` already permits scene mode `title` at any
time — no gate change was needed.

---

## Finalize

`cc-api.js`, message pair `charcreate.create.req` / `charcreate.create.res` on
the shared `advancement-net` channel. A player's request crosses the socket to
the acting GM; a GM's is handled in place. One channel, one authority gate, one
dedupe set — the reason that module exists.

```
gate check ─ validateAll ─ resolve seed ─ resolve user ─ ensureFolder
   │
   ▼
Actor.create(buildActorData)        ← nothing before this wrote anything
   │
   ├─ replaySpends     one spendPoint per draft.classes entry, sequential
   ├─ grantEquipment   embedded items; isEquipped only where trained
   ├─ writeBond        BondUpdater.writeSlot(actor, 1, …)
   ├─ writeAttributeLedger
   └─ syncResources    current_hp/mp/ip ← max, LAST
   │
   └─ on any throw ──▶ actor.delete()
```

### Rollback is deletion

Everything after `Actor.create` writes to an actor that did not exist a moment
ago and that nobody has touched. So the compensation for a failure anywhere is
to delete it: no unwinding of partial spends, no half-granted items, no chance
of restoring the wrong prior state. That is the entire reason the order is
"create the actor first, then do everything else to it".

The destination folder is **not** rolled back. An empty folder named after the
player is harmless and gets reused.

A failed rollback is reported with the orphan's id rather than swallowed —
"it failed" and "it failed and left a broken character behind" need different
responses from the player.

### Why spends go through the level-up system

`spendPoint` already builds the class row, revives a `$deleted` tombstone when a
class is retaken, grants the skill item from the class actor, hands out facets,
sets `is_martialarmor`, and debits the point last. Reimplementing any of that
here would be a second copy to keep in step with CSB.

Consequence: the actor must **hold** the points before spending, because
`unspentPoints` reads the stored `skill_point` prop. Creation seeds it with the
character's level; the spends draw it to zero. `expectedPoints` then agrees
(`level + 0 − sumClassLevels`), so the level-up window reports no drift.

### Ordering constraints

- **`syncResources` is last.** `max_hp` is a CSB formula output that only
  settles after class benefits are applied — a Guardian's +5 HP per level is
  part of it. Reading it earlier would start the character wounded.
- **`replaySpends` is sequential.** Each spend reads the actor's current class
  rows and point total; running them together would race on one document.
- **The gate is checked up front** as well as per spend, so a GM switching
  scenes mid-run refuses before anything exists rather than failing the third
  spend of twenty.

---

## World data this depends on

| Thing | Id / name |
|---|---|
| Blank PC seed | `CCBlankPC000Seed` — `_CC Blank PC` |
| PC template | `OmwL5UqoVwjshkJo` — `_FabU Char Template v3.fire` |
| PC root folder | `Player Character` (`eZWKkXNgeaFs6HSS`) |
| Equipment | folders named `Basic Weapon` / `Basic Armor` / `Basic Shield` |
| Classes | via `levelup-system/class-registry` |

**Equipment folder depth is not fixed.** Weapons sit at
`⚔️ Equipments / Weapon / Basic Weapon / <Category>` while armor sits at
`⚔️ Equipments / Armor / Basic Armor`. The catalogue walks folder ancestry
looking for the `Basic *` name rather than assuming a level, so adding or
removing an intermediate folder cannot silently empty a tab.

`category` is a meaningless default (`"Arcane"`) on **every** armor and shield
in the world, so only weapons are grouped by it.

### Data-quality notes (surfaced, not fixed)

- **Brigadine** is priced `0z`; the rulebook says 150z. It is also flagged
  martial, which is correct. A 0-cost item makes the budget meaningless for it.
- **Magicannon** and **Twin Shield** are also `0z`.

These are world-data bugs, not code bugs. Fixing them silently from the wizard
would hide the problem.

---

## Testing

Eight plain-node suites, 272 assertions, run directly:

```
cd modules/fabula-ultima-companion/scripts/character-creation
for t in cc-draft cc-attributes cc-classes cc-equipment cc-bond cc-render cc-api; do
  node $t.test.mjs
done
```

They are **not** registered in `module.json` — they are developer tools.

`cc-render.test.mjs` stubs the handful of Foundry globals the steps read and
renders every step against both an empty and a fully populated draft, asserting
no `undefined` / `NaN` / `[object Object]` reaches the markup and that player
text is escaped rather than injected. The steps build markup as strings, so this
catches typos that would otherwise only appear on screen.

> **`node --check` is unreliable in this environment** — it returned exit 0 on a
> file containing `const a = ;`. Real syntax checking uses `vm.SourceTextModule`
> under `--experimental-vm-modules`, self-tested against a known-broken file
> first.

### Still to verify live

Nothing in this system has been exercised in a running Foundry instance. In
particular:

- [ ] The window opens from the title menu and every step renders.
- [ ] Class registry populates (needs real Classes folders).
- [ ] A full level-5 build creates an actor in the right folder with the right
      owner.
- [ ] `class_list` rows, granted skill items and facets look right on the sheet.
- [ ] `max_hp` / `max_mp` reflect class benefits, and current = max.
- [ ] Equipment items appear and CSB populates `weapon_list` from them.
- [ ] The bond shows in slot 1.
- [ ] A level-20 build writes the ledger and the attribute window offers **no**
      further advance.
- [ ] A deliberately failed finalize rolls back with no actor left behind.
