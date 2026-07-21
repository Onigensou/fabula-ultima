# Character Level-Up System — design

A skill-tree front end and its backing rules engine for spending Skill Points:
one point per character level, spent to raise a Class level and a Skill level
together, with free Heroic Skills at class mastery.

Status: **planned.** Nothing implemented yet. This document is the contract the
implementation is written against; the data-model section below is *verified
against the live world*, not assumed.

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
skill_point −1
```

Ordered, with a rollback guard: a half-applied spend is worse than a failed one.

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

`heroic_requirement` is prose written for humans:

> "you must have mastered the Arcanist Class, and your character must be level
> 30 or higher."

There are 170 heroic items, 149 with a non-empty requirement, 67 distinct
strings. A clause splitter with four patterns — `masteredAny`, `charLevel`,
`hasSkillLevels`, and a class-list form — covers **127 of 149**. The remainder
are near-misses, not new shapes: `"two or more classes among A, B, and C"`,
`"must have acquired the X skill"` with no count, and one
`"learned all the skills offered by the Sharpshooter class."`

So: parse once in a migration, cache the result as structured data, and keep
the prose as the display text.

```
heroic_requirement   (prose — still what the player reads)
        ↓ migration
heroic_req_json      { all: [ {kind:"masteredAny", classes:["Arcanist"]},
                              {kind:"charLevel", min:30} ] }
heroic_req_manual    checkbox — hand-authored, never re-parsed
```

Anything that fails to parse lands in a GM report to be filled by hand. The UI
hard-blocks on structured data and falls back to *show the prose, warn only*
where none exists yet — a skill nobody has curated should not become
unpickable.

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
  levelup-const.js       channels, message types, template + folder IDs
  class-registry.js      playable classes, keyed by actor ID, alias map
  levelup-gate.js        camp phase + title screen → may this actor spend?
  requirement-eval.js    heroic_req_json against actor state
  levelup-api.js         spendPoint / refundPoint / pickHeroic / getState
  levelup-app.js         the skill-tree window
  levelup-badge.js       "You have unspent Skill Point"
```

Writes are GM-mediated over a socket, following the existing
`shopPurchase-handler.js` request/result pattern, and routed through
`shared/primary-gm.js` so exactly one GM acts in a dual-GM world.

The badge mounts on the existing camp screen-edge button rather than
introducing a second floating-UI pattern — camp already owns that screen edge,
and two systems fighting over it would collide.

---

## 7. Migrations

| key | does |
|---|---|
| `actor-template-skill-point` | add `skill_point` + `skill_point_bonus`; back-fill every PC with `level − Σ class levels` |
| `skill-template-heroic-req-struct` | add `heroic_req_json` + `heroic_req_manual` to `j0F5Msw5RZ8aIB3j` |
| `heroic-req-parse` | parse the 149 prose strings; report what didn't parse |

Template edits go through migrations, never `safe-edit patch` — patch
deep-merges, which silently leaves stale rows behind on populated CSB tables.
CSB dynamicTable deletion is `$deleted: true`, not key removal.

Copying skill items onto PCs adds world documents. Payload headroom gets
measured before any bulk back-fill; this world has been near the V8 string
ceiling before.
