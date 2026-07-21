# Character Level-Up System — design

A skill-tree front end and its backing rules engine for spending Skill Points:
one point per character level, spent to raise a Class level and a Skill level
together, with free Heroic Skills at class mastery.

Status: **v1 built, live-verified, not yet played.** Every claim in this document
was checked against `fabula-ultima-2` rather than assumed, and the write paths
were exercised against a real party member and reverted to a byte-identical
state. What has *not* happened is a session where players use it at the table.

### What live testing changed

Four things that reading the code could not have told me:

1. **`reloadTemplate` was the wrong tool.** Actor instances carry their own
   282kB copy of the template layout and CSB renders against that copy, so a
   template-only patch reaches no existing sheet. But CSB's own resync marks
   every prop missing from `getAllProperties()` for deletion — and that returns
   only the 173 props with declared defaults, while a played-in PC carries ~360.
   The migration splices two nodes into each instance's header instead.
2. **The Oxford comma silently corrupted most heroic requirements.** Splitting
   a class list on `,` before ` and ` turns "Ace of Cards, Darkblade, Entropist,
   and Spiritist" into a member literally named `"and Spiritist"` — while still
   looking parsed.
3. **Heroic slot accounting cannot match against the class catalogues**,
   because they are incomplete: Illusionist has no heroics authored at all, yet
   Keren legitimately holds an Illusionist heroic authored onto her sheet.
   Matching handed her two phantom slots she had already spent.
4. **Writing immediately made the sheet flash a corruption warning.** A spend is
   three updates and the window re-rendered between them, catching the books
   mid-balance. The fix — staging changes until Confirm — turned out to be the
   better interaction anyway.

---

## 1. The data model that already exists

Almost none of this had to be invented. The world already models classes,
skills, and class levels — it just has no engine driving them. Everything in
this section was read out of `fabula-ultima-2` before any code was written.

### Classes are Actors

Playable classes live as Actors on template `hoxC3HFCtMYGScIo`
(`_FabU Classes Template`), under the `Classes` folder:

| subfolder | count | playable |
|---|---|---|
| `Classic Classes` | 30 | yes |
| `Custom Classes` | 13 | yes |
| `Prototype Classes` | 6 | **no** — homebrew under test |

A class actor holds its skills as **embedded Items**, surfaced through three
itemContainers that all filter the *same* item template `j0F5Msw5RZ8aIB3j` and
are separated only by props:

| container | `itemFilterFormula` |
|---|---|
| `class_skill` | `skill_type ∈ {Active,Passive,Other}` and not `isHeroic` and not `isFacet` |
| `class_heroicSkill` | `item.isHeroic` |
| `class_facet` | `item.isFacet` |

So "the skills of a class" is not a list to be maintained — it is a filter over
that class actor's embedded items. The level-up system reads the same filters.

### Skills already carry their own level

Template `j0F5Msw5RZ8aIB3j` has, among much else:

```
level              current skill level        max_level    cap for this skill
class              owning class (free text)   skill_type   Active/Passive/Other/…
isHeroic           heroic skill flag          isFacet      spell flag
heroic_requirement prose prerequisites
```

`level` is the one that matters most, because the Battle Director already reads
it: `SL` resolves from `skill.system.props.level` in
`scripts/battle-director/skill-formulas.js`. **Writing a skill level through
this system is therefore immediately live in every damage formula** — there is
no second place to update and no sync step.

### The PC side

`class_list` is a dynamicTable of `{class_name (text), level (1–10), benefit
(hp|mp|ip)}`. `skill_active_list` is an itemContainer over the same skill
template. Granting a skill to a PC means **copying the class actor's embedded
Item onto the PC**; the sheet lists it automatically.

`props.level` is a plain numberField (0–50), not a computed field. It is
authoritative, and on a healthy sheet it equals the sum of class levels — Hina
is level 41 with class levels 10+10+10+7+1+3 = 41.

### Level gain has exactly one choke point

`applyLevelUpOverflow` in `scripts/exp-awarder/expAwarder-api.js` returns
`levelsGained`. EXP is a 0..10 gauge that rolls over into a level. That
function is the only place a level is minted, so it is the only place a Skill
Point needs to be minted.

---

## 2. Skill Points

> **A Skill Point is a stored number, not a derived one.**

`skill_point` is a real prop on the character template, visible to the player
and editable by the GM, with a GM-only `skill_point_bonus` beside it for gifts
that aren't backed by a level.

It *could* have been derived — `level + bonus − Σ class levels` is exact, can't
drift, and self-corrects on refund. It isn't, for two reasons. A stored number
is honest about intent: `level` stops being load-bearing, so setting a PC to 50
to test a boss doesn't quietly mint nine Skill Points. And a stored number is
inspectable — it reads the same in the live game, in an offline `safe-edit`
dump, in a save blob, and in an export. Computed props do persist, but they are
recomputed on load, and a stale shard disagreeing with the live value is a trap
this world has already been bitten by.

The cost of storing is drift. That cost is paid down by *when* spending is
allowed — see below.

### Earning

```
expAwarder.awardExp → levelsGained: n > 0 → skill_point += n
```

The player keeps playing. The point sits unspent, visibly, for as long as they
like.

### Spending is gated

Choosing a skill mid-session stalls the table, so spending is only legal where
the game is already paused:

| context | when |
|---|---|
| Camp | phases `free_roam`, `sleep_lobby`, `set_out_lobby` |
| Title screen | anytime |

The camp phase machine is linear and reaches `free_roam` only once per cycle
(`free_roam → activity_select → activity_resolve → bond_update → bond_summary →
sleep_lobby → sleeping → set_out_lobby`), resetting only when camp ends. The
three permitted phases are its three idle ready-up lobbies — the moments that
already expect players to be clicking around.

The window opens anywhere, so a player can browse and plan a build mid-session;
it is **read-only** outside a gate. The gate is re-checked **GM-side on
arrival**, not merely in the UI, so a window left open when the party sets out
cannot slip a write through.

### Drift is caught at the gate

Because spending is gated, there is exactly one moment that matters, and it is
a moment where a human is already looking at the screen:

```
on window open:
  expected = level + skill_point_bonus − Σ class_list levels
  skill_point ≠ expected  →  banner + GM one-click fix
  otherwise                →  silent
```

Not an auto-heal, and not a background reconciler on actor update. Nothing else
in the game reads Skill Points, so nothing else needs to check.

---

## 3. Spending and unspending

**Spend** — one point buys one class level *and* one skill level:

```
class level +1   (create the class_list row if this is a new class)
skill level +1   (copy the item from the class actor if not already held)
skill_point −1   ← LAST
```

The point is debited **last**, after the two writes that can fail have
succeeded. A player who paid a point and got no skill has no way to recover it.

Taking a new class is not a separate operation — in Fabula Ultima, putting a
level into a class *is* gaining one of its skills. Spending on a class the
character doesn't have creates the `class_list` row, writing the **canonical
class-actor name**. This also fixes name drift at the source: the only reason
Hina's sheet reads `"Dark Blade"` against an actor named `"Darkblade"` is that
it was hand-typed.

Refunding a class to zero leaves a `$deleted` tombstone (CSB's own convention),
so re-taking that class revives the tombstoned row rather than appending a new
key — otherwise cycling a class in and out grows `class_list` forever.

### Changes are staged, not written

The window never writes as you click. `+` and `−` adjust a local pending list
and the UI renders the *projected* class levels, skill levels and point
balance; **Confirm** applies the batch and **Cancel** discards it.

This started as a bug fix — a spend is three updates, and re-rendering between
them caught the books mid-balance and flashed the GM drift warning on every
click — but it is the better interaction regardless: a player can try a build
and back out of it. Clicking `+` then `−` on one skill annihilates rather than
queueing two operations.

On Confirm, **refunds apply before spends**: they free the points later spends
depend on and relax the three-unmastered-class limit, so "drop this class,
start that one" works on a single point. The first failure abandons the rest
and leaves them staged, so the window shows exactly what did not go through.
Each operation is individually atomic GM-side, so a partial apply is a coherent
character sheet rather than a corrupt one.

**Refund** reverses it, and **blocks rather than cascades**. If dropping a class
below 10 would orphan a held Heroic Skill, the refund is refused —
*"unlearn Grand Summoning first."* Cascading refunds are quick to write and
impossible to reason about at the table; a player who unlearns one skill should
never watch three others vanish.

A skill refunded to level 0 has its item deleted. A class refunded to level 0
has its row removed and its free benefits revoked, but only if no *other* held
class still grants them.

### Rules enforced

Class level ≤ 10 · skill level ≤ its own `max_level` · at most **three
non-mastered classes** (core rulebook p. 227) · character level ≤ 50 · Heroic
Skills only from mastered classes, and only when their requirements are met.

Level 20/40 attribute increases are **out of scope**. They don't consume Skill
Points and want their own track.

---

## 4. Heroic Skills

Mastering a class earns a pick. It does **not** restrict what may be picked —
the rules grant "one Heroic Skill of your choice" (p. 228), and the skill's own
requirements are the only gate. The candidate pool is therefore every heroic on
every playable class (~99 after dedup and exclusions), not the mastered class's
own list.

This matters concretely: Blanche can take `Protective Strike`, offered by
Slayer — a class she has never taken — because its requirement is "mastered one
or more Classes among Guardian or Slayer" and she has Guardian at 10. It also
dissolves the Illusionist problem: mastering a class with no heroics authored
still earns a pick, usable anywhere.

Because the pool is large, entries are ranked `met` → `close` (blocked, but
from a class already being played) → `distant` (blocked, class never taken),
and the window shows the first two with a count for the rest.

### 4a. Which held heroics consume a slot

One slot is earned per mastered class, but only heroics the character **picked**
consume one. The discriminator is CSB's grant mechanism, not the name: a skill
granted by equipment is stored as a contained sub-item, with `container`
pointing at the holder.

Zarg is the case that proved it. He carries `Maid cap (Passive)`, a
heroic-grade passive hanging off the "Maid cap" accessory. Counting it made
mastering Dancer appear to award nothing — the slot was eaten by a hat.

```
Perfect Aim    container: null          → a pick, consumes a slot
Deep Pockets   container: null          → a pick
Upgrade        container: null          → a pick
Maid cap (P.)  container: "Maid cap"    → granted, consumes nothing
```

Matching against the class catalogues instead is *not* viable — they are
incomplete (§8), and that approach handed Keren two phantom slots she had
already spent.

**Blank requirements fail safe.** Fifteen heroics carry no requirement text.
Reading that as "no requirement" would make them freely takeable by anyone with
a slot, which is certainly not intended — every Heroic Skill in the book states
one, so a blank is missing data, not permission. Those fall back to requiring
the offering class to be mastered.

`heroic_requirement` is prose written for humans:

> "you must have mastered the Arcanist Class, and your character must be level
> 30 or higher."

Across the Classic and Custom class actors there are 143 heroic skills, 128 of
them with requirement text. **All 128 parse with zero leftovers**, and — the
check that actually matters — every class name and every skill name the parser
emits resolves to a real class actor or a real item.

```
143 heroic skills · 15 with no requirement · 128 parsed · 0 unparsed
masteredAny 127 · hasSkill 21 · skillLevel 4 · charLevel 3 · allSkillsOf 1
```

**This is not stored anywhere.** The original plan was to parse once in a
migration and cache structured JSON onto each item. That would write to 149
world items for data that is static rulebook text and never changes; parsing
the handful belonging to one class when its panel opens costs microseconds. The
parser runs live and the prose stays the only stored form.

Clause kinds: `masteredAny{classes,min}`, `charLevel{min}`,
`skillLevel{skill,min}`, `hasSkill{skill}`, `allSkillsOf{className}`.

A requirement that leaves prose unclaimed returns `evaluable: false`, and
callers must not read that as a pass — a half-parsed requirement would
otherwise become a *weaker* gate than its author wrote. The window shows the
original prose for a GM to adjudicate.

---

## 5. Class identity is not a string

`class_list.class_name` is free text, and it has already drifted. Hina has a
class named `"Dark Blade"`; the class actor is `"Darkblade"`. One heroic item
claims `class: "Repaer"`. There are two class actors both named
`"Weaponmaster"`.

`class-registry.js` therefore keys classes by **class actor ID**, enumerates
only `Classic Classes` and `Custom Classes`, and carries an alias map for the
known drift. New `class_list` rows written by this system use the canonical
name; legacy rows resolve through the aliases.

A related trap: several container rows carry `id: "${item.id}"` — an
unresolved template literal, present in the live data. **Everything resolves by
`uuid`, never by `id`.**

---

## 6. Shape

```
scripts/levelup-system/
  levelup-const.js        channels, message types, rules, idKey()
  class-registry.js       the 42 playable classes, keyed by idKey(name)
  requirement-parser.js   heroic prose → clauses
  requirement-eval.js     clauses → per-clause verdict for one actor
  levelup-gate.js         camp phase + scene mode → may this actor spend?
  levelup-api.js          getState / spendPoint / refundPoint / pickHeroic
  levelup-app.js          the skill-tree window
  levelup-badge.js        "Unspent Skill Points"
```

Writes are GM-mediated over a socket, following the existing
`shopPurchase-handler.js` request/result pattern, and routed through
`shared/primary-gm.js` so exactly one GM acts in a dual-GM world.

**Identity is `idKey(name)`** — lowercase alphanumerics — everywhere, not the
raw name and not the actor id. `class_list.class_name` is hand-typed free text
that has already drifted, and actor ids are absent from `class_list` entirely,
which is the table the whole system reads. Collapsing to alphanumerics makes
`"Dark Blade"` and `"Darkblade"` the same key with no alias table.

The rail shows only the classes a character actually has; starting a new one is
a separate layered window, because 42 entries would bury the four or five in
play. The badge anchors **above** the camp screen-edge button (camp owns
`bottom: 80 / left: 20`, 64px) rather than beside it.

---

## 7. Migrations

**One**, `2026-07-21-actor-template-skill-point-v2`: add `skill_point` +
`skill_point_bonus` beside LEVEL on the character template *and* on each party
member's own header copy, then back-fill `level − Σ class levels`.

The two planned heroic-requirement migrations were **dropped** — see §4. The
parser runs live and nothing about requirements is written to world data.

Instance patching is scoped to the **db-resolved party**, not every actor on the
template. The template is shared by 17 instances of which 4 are in play; the
rest are retired PCs, test dummies and backups, and rewriting a 282kB header
onto each is churn for actors nobody opens. A character who later joins the
party is repaired by the window on open rather than by this one-shot.

Template edits go through migrations, never `safe-edit patch` — patch
deep-merges, which silently leaves stale rows behind on populated CSB tables.
CSB dynamicTable deletion is `$deleted: true`, not key removal, and CSB props
deep-merge on update, so removing a row key needs an explicit `-=` delete.

Copying skill items onto PCs adds world documents. Payload headroom gets
measured before any bulk back-fill; this world has been near the V8 string
ceiling before.

---

## 8. Known gaps in world data

Not bugs, but things the system can only report rather than fix:

- **Five classes have thin or empty heroic lists** — Illusionist has none
  authored, and Esper, Merchant, Spell Fencer and Tinkerer have one each. This
  no longer blocks anyone (§4: the pick is not restricted to the mastered
  class), but those classes contribute nothing to the shared pool, and Keren
  holds an Illusionist heroic that exists only on her sheet.
- ~~Zarg holds 4 heroics against 3 mastered classes~~ — **resolved.** It was
  `Maid cap (Passive)`, a heroic-grade passive granted by the "Maid cap"
  accessory. Equipment grants a skill as a contained sub-item (`container`
  points at the holder), and slot accounting now excludes those: a granted
  skill was never a pick, and counting it ate the slot he earned for mastering
  Dancer. See §4a.
- **Two class actors are named "Weaponmaster".** The registry keeps the richer
  one (`twJIPhORKNZvbaxK`, 6 skills + 11 heroics) and reports the ignored id.
- **`member_id_1` stores a bare actor id while slots 2–4 store `Actor.<id>`
  uuids.** This system accepts both; other consumers doing a plain
  `game.actors.get(raw)` resolve only slot 1.
