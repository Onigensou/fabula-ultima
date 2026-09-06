---
id: 2026-09-05-botc-homebrew-divergences
title: Birth of the Cruel — deliberate divergences from RAW
status: wontfix
severity: minor
reporter: sarunphat
assignee: sarunphat
component: world-data / Necromancer
introduced_in:
fixed_in:
---

# Where Birth of the Cruel deliberately does not match the printed text

Filing these as `wontfix` rather than leaving them undocumented, because both look
like authoring bugs to anyone auditing the skill against its own description —
they were flagged as findings in a 2026-09-05 audit and are now ruled **intended
homebrew**. If a future pass re-discovers them, this is the answer.

Both live on all three copies of the skill (`Item.1eFbdLi3qXUczO6Z`, Keren's
`Actor.gdJZ1L1kv5mjTTMr.Item.fjrhRNjINs8xk7Lp`, and the Necromancer class template's
`Actor.IQdAebKiExUDRQT0.Item.oU5gEfQBzx2xO9ZR`).

## 1. The Minion does NOT retain the original creature's equipment

RAW: *"The newly created Minion is a completely new creature and has full HP, full
MP, and no status effects. It retains the original creature's equipment."*

Config: the `botc_summon` row sets

```
summon_strip_types: weapon,armor,shield,accessory
```

so every equippable gear shell is stripped off the clone.

**Why this is intended here.** In this world a monster's offensive kit is authored as
*skills*, not as equipment — see the `feedback_monster_items_are_skills_not_equipment`
convention. The gear shells an NPC carries are mostly inert scaffolding, and carrying
them onto a reanimated clone drags along equip-toggled `transfer:true` AEs that were
balanced for the original creature at its original Rank. Since the Minion is forced to
Rank soldier with roughly half HP, inheriting elite-tuned gear AEs is a bigger RAW
deviation than dropping the shells. **The RAW intent — "Skills are maintained" — is
preserved**, because the skills are what the moveset actually lives on.

## 2. The trigger only fires on ENEMY deaths

RAW: *"When a non-Villain NPC you can see that belongs to the beast, humanoid,
monster, or plant Species dies…"* — the text scopes by Species and Villain status,
not by allegiance.

Config: reaction row 0 carries `reaction_source: enemy`, so a neutral or allied NPC
of a qualifying Species dying does **not** offer the raise. The Species and Villain
halves of the gate are implemented faithfully
(`(TARGET_SPECIES_IS_BEAST + TARGET_SPECIES_IS_HUMANOID + TARGET_SPECIES_IS_MONSTER +
TARGET_SPECIES_IS_PLANT) >= 1 && TARGET_IS_VILLAIN == 0`).

**Why this is intended here.** Offering "reanimate the corpse" on a *friendly* NPC's
death is a table-tone decision, not a rules one, and the prompt firing on an allied
death mid-scene reads badly. Narrowing to `enemy` also keeps the reaction out of
scripted/neutral NPC deaths that the Battle Director emits for staging reasons.

## Notes

- 2026-09-05: recorded alongside two real fixes shipped the same day — the missing
  `party_rested` rest-restore, and deep-merge residue on the `botc_cost` row. Those
  were defects; these two are not.
- Still genuinely open on this skill, and deliberately NOT covered here: there is no
  voluntary "destroy your Minion at any time" path (RAW grants one, and it is the only
  release for the `OWN_PERSISTENT_SUMMON_COUNT == 0` gate while the Minion lives), and
  the known `max_hp` label-staleness on the spawned clone.

## 3. The Minion's rest clear is TAG-SCOPED — measured, and deliberately left as-is

RAW: *"When you rest, your Minion also gains the full benefits of resting."*

Config: `botc_rest_clear` uses `filter_tag: "debuff,buff"`. A party member's rest
is broader — it deletes every non-permanent AE originating on the actor, tagged
or not, and ticks campRestCharges, which the Minion never gets.

**The 2026-09-05 claim here was WRONG and is retracted.** It said untagged status
copies meant "all 15 `filter_tag: debuff` rows in the corpus under-cover by the
same amount". That counted **inert templates** as evidence: re-measured
2026-09-06, nearly every untagged copy sits on a carrier with zero effect rows,
is `transfer:false`, and mostly has empty `changes` — it never reaches a target.
The hub itself was already correct (42 statuses tagged `debuff`).

**The right scan** is not "untagged copies" but "`apply_ae` rows naming an
untagged AE". Nine exist:

| status | applied by | outcome |
|---|---|---|
| Flying ×4, Lance Spent | self-targeted | correct — buff/marker, not debuffs |
| Draconic Domination | Fafnir | ruled deliberately untagged 2026-07-04 |
| Armor Stripped | Imp › Strip Armor | **stays untagged — user's call 2026-09-06** |
| Weapon Stripped | Imp › Strip Weapon | **stays untagged — user's call 2026-09-06** |
| Deadly Temptation | Succubus › Charm | **stays untagged — user's call 2026-09-06** |

Those last three were briefly tagged on 2026-09-06 and **reverted the same day**
(`tools/safe-edit/_untag-marker-debuffs.js`; the hub is byte-identical to its
committed state). The reason is the second thing the tag does:
`countDebuffs` (identifier-registry.js:57-84) counts any AE whose `system.tags`
includes `debuff`, feeding `TARGET_STATUS_COUNT` / `STATUS_COUNT` /
`ENEMY_DISTINCT_STATUS_COUNT` — which gate and scale **Cheap Shot** (Rogue,
Zarg), **For Whom the Bell Tolls** (Keren, Necromancer, Farian Pasta),
**Adversity**, and two Zero Triggers. Tagging made an enemy carrying only
"Armor Stripped" satisfy Cheap Shot's `> 0` gate, and Armor/Weapon Stripped are
equipment-loss markers with no `changes` of their own — not RAW status effects.

⭐ **The general rule this establishes: the `debuff` tag is overloaded.** It means
BOTH "cleansable" and "counts as a status". There is no way in data to have one
without the other; separating them needs an exclusion set in `countDebuffs`.
Weigh both before tagging anything.

**Consequence accepted:** a Minion stripped by an Imp or hit by a Succubus's
Charm keeps that effect through a full rest. It is uncleansable by any
`filter_tag` row.

KO and Death stay untagged for a different, load-bearing reason:
`cleanseBuffsDebuffsOnKO` deletes every buff/debuff AE on the KO edge, so tagging
KO would make a KO'd creature delete its own KO marker.

🩸 **The residual floor, which no tagging closes.** A status applied by the
token-HUD toggle, the AE Manager, or a macro arrives as a bare
`CONFIG.statusEffects` clone with **no tags at all**
(`condition-adoption.js:5-11`), and `selectAEsOnActor` matches only an AE's own
tags or its chargeKey. `filter_tag` covers BD's own `apply_ae` path with a tagged
template, and nothing else.

## 4. ~~The Dismiss is a turn ACTION, where RAW grants it "at any time"~~ — CLOSED 2026-09-06

RAW: *"You may also destroy your Minion at any time; if you want to create a new
Minion, you must first destroy the current one."*

It shipped as a turn action because the engine had no way to say otherwise: every
Active skill spends the turn and goes through the battlefield Action Card. The
2026-09-05 note here said the fix would be "a free-action grant on Birth of the
Cruel itself". That turned out to be the wrong shape — a `free_action` grant
naming a specific skill is a **preset** that DECLARE stages directly, so it would
have **auto-dismissed** the Minion rather than offering to; naming a TYPE instead
grants a free skill of any kind, every turn.

**Closed with two declared props instead** — a general primitive, not a BotC
special case (`tools/csb-template/scripts/_add-quick-action-fields.js`):

| prop | effect |
|---|---|
| `skill_free_action` | RESOLVE leaves the turn unresolved; CLEANUP routes back to DECLARE. The action menu re-opens with the turn intact. |
| `skill_skip_action_card` | CONFIRM shows a plain confirm dialog instead of the battlefield card. |

Play experience now: **click Dismiss → Confirm → the Minion is gone, your turn is
still yours.**

`skill_free_action` did not invent that path — the FSM already had it
(`ctx.returnToMenuAfterCleanup`, states.js:224), reachable only via two
hard-coded conditions in state-handlers.js (`ar.equipmentFree`, the free
Equipment transform; and `ar.kind === "Domination"`). Any third case meant a
third disjunct. It is now authorable.

🩸 **`skill_skip_action_card` is a REQUEST, not a command.** The Action Card is
the only place pre-resolve reaction pills are offered. If CONFIRM's scan found
any live reaction, the full card is posted anyway and the flag simply does not
apply that time — otherwise skipping it would silently remove a player's chance
to react, a permissive failure nobody would ever see. A summon's armed
auto-confirm suppresses the skip for the same reason.

**Why "free" is safe on THIS skill and would not be on a damaging one:** the
Dismiss is Self-targeted, rolls nothing, deals nothing, and is gated
`OWN_PERSISTENT_SUMMONS_MINION >= 1` — using it removes the only thing that makes
it available, so it cannot repeat for value. A free action that CAN repeat is a
free extra attack; the authoring script refuses to set the flag on a skill with
no `availability_formula` for exactly that reason.

⚠ **Verified: declaration only.** All three Dismiss copies carry both flags,
persisted in `_source`, and a live `reloadTemplate()` probe on a throwaway
duplicate pruned neither (14/14 live assertions). The FSM behaviour itself — that
the turn is genuinely not spent, and the card genuinely skipped — is NOT verified:
it needs a live battle with a standing Minion, and the sim can neither be driven
to raise-then-dismiss on demand nor finish under a headless client.

## 5. The Dismiss is NOT flagged `isHeroic`

`isHeroic: false`, deliberately, though it belongs to a Heroic Skill.

`heroicSlots()` counts every `isHeroic` item an actor holds that is not CONTAINED.
Flagging the Dismiss pushed Keren to **4 heroics against 3 earned** — it silently ate
a slot she had paid a class mastery for.

The textbook fix, `system.container -> Birth of the Cruel`, is what Avatar of Vengeance
uses for its Pulse/Merge/Dismiss trio. It does not work here: `gatherSkillsForActor`
skips every contained item *except a merged Arcanum child*, so containment removed the
Dismiss from the skill picker entirely (measured: 27 candidates → 26, entry absent).
Avatar of Vengeance escapes that only because `isMergedArcanumChild` whitelists it.

Not flagging it is also the truer description: this is a companion action to a Heroic
Skill, not a separately-earned one. It is not on the Necromancer class template either,
so it can never be bought as a heroic pick.

## 6. ~~The Dismiss gate rides on an UNDECLARED prop~~ — RESOLVED 2026-09-05

`availability_formula` / `availability_reason` are **not declared columns** on the skill
template `j0F5Msw5RZ8aIB3j`, nor on any of the 8 CSB templates in this world, nor in
`template-field-registry.js` (whose boot-time self-healing covers dynamic-table ROW
fields only, never top-level props).

They work today — `skill-picker.js` reads `p.availability_formula` straight off the
prepared doc. But `reloadTemplate()` prunes every undeclared prop, writing a persisted
`-=key` deletion marker. **Measured directly this session:** calling `reloadTemplate()`
on both Dismiss copies dropped exactly `availability_formula` and `availability_reason`
every time; they only survived because the authoring pass restores them afterwards, the
same guard `world-import` uses.

**Failure direction is PERMISSIVE and silent.** A pruned formula means no gate at all —
the Dismiss becomes always-clickable with no reason chip, and nothing reports it.

**This is pre-existing and not confined to this skill.** The same prop backs Create
Phantasm: Numen's one-Numen cap, Bimagus's arcane-weapon gate, Quaking Titan and
Brainwave Discharge — 11 skills. `world-import` already names `availability_formula`
among the undeclared props it restores; the CSB "Reload template" context-menu entry and
a CSB version migration do not.

**✅ FIXED the same day.** Both fields are now DECLARED on the skill template as
"Usable When" and "Unavailable Reason", placed beside "Eligibility Filter" in the
header. Verified: `reloadTemplate()` now drops nothing, no `-=` markers persist, the
picker still gates correctly after a reload, and the other users (Numen, Bimagus,
Quaking Titan, Brainwave Discharge) are intact. No mass backfill — 13 of 2325 docs
carry the props and all 13 author a real gate.

Details, and why the export shows the change as nothing but a
`templateSystemUniqueVersion` bump: [[2026-09-05-skill-template-availability-fields]].

---

# Verified CONFORMANT — do not "fix" these

Added 2026-09-06 after a fresh inspection re-raised them. Both looked like defects
and are not. Recorded here because the file above is where the next audit will
look, and because one of them was filed as a finding by *this* process before the
rulebook was actually read.

## 7. `summon_overrides` reduces HP but not MP — and that is CORRECT

The `botc_summon` row halves the clone's `max_hp` for a non-soldier corpse
(`=floor(MAX_HP*(1-(1-RANK_IS_SOLDIER)*0.5))`) and leaves `max_mp` untouched,
setting `current_mp: "=MAX_MP"`.

Against the skill's own text — *"if the original creature was an élite or
champion, the GM must reduce the Minion's HP and MP accordingly"* — that reads
like a half-done implementation. It is not. **Rank in Fabula Ultima scales Hit
Points only:**

> **Creating an Elite** — Hit Points: Double the creature's maximum Hit Points.
> **Creating a Champion** — Hit Points: Multiply the creature's maximum Hit
> Points by the number of soldiers […]
>
> — Core Rulebook, *Elites and Champions* (p. 295)

Neither entry touches MP, and the book's own worked example agrees: Angela is
made an elite, "she will double her maximum Hit Points (bringing her to a rather
resilient 160), and she will get an additional Skill" — no MP change.

So an elite's MP was never rank-inflated in the first place, and demoting the
corpse to soldier has nothing to take off it. `current_mp: "=MAX_MP"` then
delivers exactly what RAW asks for on the next bullet — *"full HP, full MP"*.
The clause "and MP" in the skill text is the designers covering the general case;
for a stat block built by the book's own rules the MP delta is zero.

**Do not add a `max_mp` override.** It would halve an elite corpse's MP against
both the Rank rules and the "full MP" clause.

## 8. `reaction_max_scope` is NOT drift — the sheet restores it. Do not "fix" it

First read 2026-09-06 as authored drift: `reaction_max_scope: "round"` sat on
Keren's four BotC reaction rows and on neither of the other two copies, so the
three diffed noisily. It was cleared on Keren to make them agree.

**That was wrong, and measuring it produced the actual rule.** Opening Birth of
the Cruel's sheet in a live session re-stamped `"round"` onto **all five** rows —
including the one row that had never carried it. The two copies whose sheets were
NOT opened still hold no key at all. Measured the same session:

```
Keren BotC   (sheet WAS opened): ['round','round','round','round','round']
Necro BotC   (sheet NOT opened): [absent x5]
Master BotC  (sheet NOT opened): [absent x5]
```

So the mechanism is the **CSB sheet render**, which writes every declared column's
`defaultValue` into every existing row — not a boot sync, and not something the
author did. The cross-copy difference therefore says nothing about authoring; it
records **which copies have had their sheet opened since the column was added**.
Clearing it is futile: the next sheet open puts it back.

None of it matters behaviourally. `readReactionMaxScope` (skill-effects.js:1705)
maps a blank to `"round"`, `reactionRoundCapReached` short-circuits on `!max`, and
all five rows carry `reaction_max_per_round: ""` (blank/0 = uncapped), so the
scope is never consulted. Blank and `"round"` are the same row.

**Rule for the next audit:** a `*_table` column whose value equals the template's
`defaultValue` is not evidence of anything. Diff copies on the columns an author
actually sets. This generalises past this skill — 28 rows corpus-wide carry an
inert `"round"`, and they are simply the rows whose sheets have been opened.

## 9. The Dismiss was absent from the Necromancer class template — CLOSED 2026-09-06

Keren had "Birth of the Cruel: Dismiss"; the master item existed; the class
template actor (`Actor.IQdAebKiExUDRQT0`) did not carry it. A second Necromancer
would therefore have got the raise with no release.

**Embedding the Dismiss on the class actor — the obvious fix — is wrong twice
over, and was written and reverted before it shipped.** Recorded because it is
the first thing the next person will try:

1. `class-registry.js` splits a class actor's items by PROP, not by container
   (`isHeroic` / `isFacet` / `skill_type === "Spell"`; :49, :64-70, :147). The
   Dismiss is `isHeroic:false`, `isFacet:false`, `skill_type:"Active"`, so it
   lands in `cls.skills` — a purchasable **base** skill with a live buy button
   and no `heroic_requirement` check on that path. A level-1 Necromancer could
   burn a Skill Point on a release for a Minion they cannot raise, and the class
   browser would advertise 6 base skills where every other Classic Class has 5.
2. It would not work anyway. `applyBaseSkill` (levelup-api.js:319-324) and
   `applyHeroic` (:485-490) each copy exactly ONE named item; there was no
   companion-grant path, and no class actor uses `system.container`.

**What shipped instead — a general companion-skill grant primitive:**

- `companion_skills` is now a DECLARED column on the live skill template
  (`tools/csb-template/scripts/_add-companion-skills-field.js`). It has to be
  declared: `reloadTemplate()` prunes undeclared props, and the failure here is
  silent AND restores the purchasable-trap above.
- `class-registry.js` withholds every named companion from `skills` / `heroics` /
  `facets`, and exposes them on `cls.companions`. A skill naming ITSELF is
  ignored with a warning (it would otherwise delete the parent from the class),
  and a name matching no item warns.
- `levelup-api.js` `grantCompanions()` copies them alongside the parent, from
  both `applySpend` and `applyHeroic`.
- `reconcileCompanions(actor)` is the BACKFILL lever, and it is needed:
  `grantCompanions` only fires on a purchase, and a heroic is never re-offered
  once held, so declaring a companion on a skill characters already hold reaches
  none of them. **Do not assume the next level-up heals it.**
- Data: `companion_skills = "Birth of the Cruel: Dismiss"` on all three BotC
  copies, and a clone of the master Dismiss embedded on the class actor as
  `Actor.IQdAebKiExUDRQT0.Item.BFubGFMKDspGDLWb`
  (`tools/safe-edit/_botc-dismiss-companion.js`).
- Regression net: `node tools/levelup-companion-test/levelup-companion.test.mjs`
  (12 checks, includes a control that proves the assertions can go red).

Existing holders were audited, not assumed: exactly one actor holds Birth of the
Cruel (Keren) and already carried the Dismiss, so no backfill was needed.

⚠ **Verified offline only.** The READ half was replayed over the real class-actor
documents; the WRITE half has passed a stubbed run of the real
`grantCompanions` chain but has never executed inside Foundry, and the new sheet
panel has never been rendered. Both want one live confirmation.
