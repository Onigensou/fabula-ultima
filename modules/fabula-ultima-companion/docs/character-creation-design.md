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

**Navigation is one way.** The rail is a progress indicator — plain divs, no
pointer, no jumps — and Back/Next are the only movement. Every step is still
backtrackable, which is the golden rule; you just walk back through them.

That is also the fix for a reported bug where re-entering a step left Back
inert. `goTo` used to gate on a `seen`-derived reachability set, and Back
consulted the same set, so a jump could reach a state where stepping backwards
was refused with no visible reason. Movement is now positional and
unconditional between real steps, bounded by `stepAt`'s clamp, and the
reachability concept is gone — there is no set left to fall out of sync.
`seen` survives only to mark progress on the rail and to avoid criticising a
step nobody has opened.

**Forward is blocked until the current step validates.** Next carries the
reason as its tooltip. A later step is built on an earlier one’s answers — the
point pool comes from the level, the martial rules come from the classes — so
walking past an unfinished step produced a page that could not be filled in
correctly and an error with no obvious cause.

A step is only *criticised* once the player has been past it. On a first visit
an empty form is not a mistake, it is a form.

---

## Files

| File | Role |
|---|---|
| `cc-const.js` | Rulebook constants, budget/points/milestone formulas, emotion pairs, message types |
| `cc-folder.js` | Resolves `Actors ▸ Player Character ▸ <Username>'s PC` |
| `cc-draft.js` | The draft model, validation, reconciliation, step machine |
| `cc-class-state.js` | `draftState(draft)` — a `getState`-shaped view of the draft |
| `cc-app.js` | Overlay shell, step rail, nav, finalize dispatch |
| `cc-step-profile.js` | Step 1 |
| `cc-step-attributes.js` | Step 2 — owns ALL derived maths: `applyMilestones`, `previewDerived`, `benefitTally`, `finalDerived`, `placeDie` |
| `cc-step-classes.js` | Step 3 — spend rules; the markup is borrowed from `levelup-app` |
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
| `ctx.app` | the shell |

An optional `reset()` clears transient view state (open class pane, search box,
half-answered prompt) between characters. It is called on every registered step
when the window opens, so nothing leaks from one character into the next.

---

## Reusing the existing systems

The steps do not invent a look. Each one is built on the window that already
does that job, because those are tuned and a second copy would only be a second
thing to maintain.

| Step | Borrowed from | How |
|---|---|---|
| Shell | `attribute-app` / `levelup-app` | Palette, `levelup-fx` sounds and animations |
| Attributes | `attribute-app` | Row shape, `ATTR_META` icons, derived panel |
| Classes | `levelup-app` | **The actual renderers** — see below |
| Equipment | `shopWindow-app` | Vertical emoji tabs, item rows, zenit mark, buy pill |
| Bond | `camp-ui-bond` | Slot with hearts, `name → relationship`, one control per pair |

### The class step's seam

`LevelUpApp`'s `_rail`, `_main`, `_facetGrid` and `_row` render entirely from
the object `getState(actorUuid)` returns. None of them reaches for an Actor. So
the class step makes a derived object off `LevelUpApp` and points it at the
draft instead:

```js
const v = Object.create(LevelUpApp);
v._creation = true;
v._stateSource = () => draftState(draft);
v._pending = [];              // the draft IS the staging area
```

The whole seam is one method in `levelup-app.js`:

```js
_readState() {
  if (typeof this._stateSource === "function") return this._stateSource();
  return api()?.getState(this._actorUuid);
}
```

Five call sites route through it. Nothing below that line knows which it got,
so the live level-up window is unchanged.

`draftState` counts every actor-derived number out of the draft:

| `getState` | `draftState` |
|---|---|
| class row level from `class_list` | count of `draft.classes` with that key |
| skill level from actor items | count of `draft.classes` with that uuid |
| facet held from actor items | uuid present in any pick's `facetUuids` |
| `skill_point` prop | pool minus picks |

Everything else — names, images, descriptions, `maxLevel`, `facetGrant`, free
benefits — comes from the same `getRegistry()` the real window reads, so the two
cannot describe a class differently.

Because `_pending` stays empty, `_project` returns zero deltas and the levels
shown come straight from `draftState`. There is nothing to Confirm because
nothing has been written. That is also why creation reports an unbounded Forget
me Nut supply (giving a level back is free) and shows both `+` and `−` at once
— the only creation-specific branch inside `_main`.

**Why not create the Actor up front and use the real windows directly?** It
would have made all of this unnecessary, at the cost of a half-finished
character existing in the world from the moment the wizard opens, and surviving
a crash or a closed tab. Keeping the draft as the only state is what makes
rollback a matter of deleting one document nobody has touched.

> **Not yet borrowed:** the level-up window's full-screen class *browser*
> (`_paintPicker`) and facet-picker overlays. Both append to `LevelUpApp._root`
> and are styled under `#oni-levelup`, which is `position:fixed; inset:0` — they
> would fight the wizard frame. Step 3 uses a simple class list and an inline
> benefit/facet prompt instead. Making those overlays host-agnostic is the
> follow-up if the browser's class pages are wanted here.

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
  profile:    { name, identity, theme, origin, backstory, img, tokenImg },
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

## Derived stats

Three layers, added in this order. `cc-step-attributes.js` owns all of it, so
the numbers a player sees on step 2 and the numbers on the summary come from one
place.

| Layer | Where it appears | Function |
|---|---|---|
| Base — level and the attribute dice | Attribute step, right panel | `previewDerived` |
| Class free benefits | Summary only | `benefitTally` |
| Equipment | Summary only | `equipBonuses` (equipment step) |
| The three combined | Summary "Starting Stats" | `finalDerived` |

The attribute step deliberately shows base only: classes are picked a step
later and gear a step after that, so anything more would be a guess. The
summary's table prints base → change → total for each stat, because a bare
total is a number to take on faith.

Two rules that are easy to get backwards, and are both pinned by tests:

- **A class free benefit applies ONCE, when the class is opened** — not per
  level in it. That is why `class_list` carries one benefit column per class
  row. Counting per level would inflate a level-10 mono-class build by 45 HP.
- **Martial armour REPLACES the DEX die** with `item_baseDef`; ordinary armour
  ADDS `item_def_bonus` to it. Shields always add, martial or not. This mirrors
  the equipment macro, which is what actually writes these onto a sheet.
  Treating them the same way would overstate a plate-wearer by their whole DEX
  die.

Untrained gear contributes nothing — it is carried, not worn, so it must not
appear in the projection any more than it does on the sheet.

---

## Assignment is drag and drop

The array is a tray of four dice; each attribute is a socket. A die *moves* when
placed, so the pool cannot inflate — the invalid spread is unreachable rather
than merely rejected.

This replaced a set of dropdowns whose selection did not survive the shell's
re-render, so choosing a die appeared to do nothing and the step then complained
that no die had been chosen. Nothing here holds widget state that can disagree
with the draft.

- socket → socket **swaps**
- tray → occupied socket displaces the old die back to the tray
- socket → tray, or a click on a filled socket, returns it
- switching array **resets every socket**, since the dice on offer changed

`trayDice` removes placed dice by **instance, not by value**: "Average" is
d10 d8 d8 d6, a multiset, and filtering by value would empty both d8 slots the
moment either was placed.

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
| A name was entered | `validateStep` | `validateAll` in `applyCreate` |
| Every attribute die placed | `validateStep` | (baked into the bases at creation) |
| Spend gate (title/camp) | window greys out | `gateState` in `applyCreate` **and** each spend |

Every one of these also DISABLES Next on its own step, so the client checks are
not merely advice -- they are the gate. The GM re-checks everything regardless.

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

Eight plain-node suites, 405 assertions, run directly:

```
cd modules/fabula-ultima-companion/scripts/character-creation
for t in cc-draft cc-attributes cc-classes cc-class-state cc-equipment cc-bond cc-render cc-api; do
  node $t.test.mjs
done
```

`cc-class-state.test.mjs` is the important one. It stubs a world holding two
real-shaped class actors, then runs `LevelUpApp`'s own `_rail` / `_main` /
`_facetGrid` / `_project` over draft state and asserts on the markup that comes
out — the only way to find out those renderers accept it. Its fixtures use the
formats the world really uses (`hp_benefit`, and a facet grant spelled out in
prose containing "see Facet") because a made-up shape would test nothing. Both
were wrong on the first attempt and the suite said so.

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
- [ ] Next stays GREY until each step is complete, and its tooltip says why.
- [ ] Dragging a die from the tray into a socket works, socket-to-socket swaps,
      and clicking a filled socket returns its die.
- [ ] Switching array clears every socket.
- [ ] The equipment purse and bar count/slide rather than snapping, and the
      chosen list shows full item names.
- [ ] The summary Starting Stats table matches the sheet after creation --
      especially Max HP against the class benefits actually granted.
- [ ] Back and Next walk the whole road in both directions, and the rail is
      inert. (The reported "re-enter a step and Back dies" bug should be gone.)
- [ ] The class step draws the real level-up rail and skill rows, and `+` / `−`
      move the draft.
- [ ] The normal level-up window still works — same actor, same spends,
      unchanged. This is the one existing system the rework touched.
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
