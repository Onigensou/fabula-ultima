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

## 3. The Minion's rest clear is TAG-SCOPED, not the party's full sweep

Added 2026-09-05 alongside the `party_rested` implementation, and waived here rather
than left silent.

RAW: *"When you rest, your Minion also gains the full benefits of resting."*

Config: `botc_rest_clear` uses `filter_tag: "debuff,buff"`. A **party member's** rest
(`camp-system/rest-api.js _clearTemporaryEffects`) is broader — it deletes *every*
non-permanent AE whose origin is the actor itself, tagged or not, and also runs
`_tickCampRestEffects` (campRestCharges expiry), which the Minion never gets.

**Why not simply widen it.** `filter_tag: "*"` is not the equivalent: `selectAEsOnActor`
skips only persistent counters, so `"*"` would also strip the Minion's passive trait
and equipment-derived AEs — a bigger deviation than the one it fixes. The engine has
no `remove_ae` mode meaning "everything the rest sweep would take".

**The real gap is upstream, and it is not BotC's.** Status AEs in this world are tagged
inconsistently — measured across `_authored-export`, these carry an EMPTY `system.tags`
in at least one copy: `dazed`, `enraged`, `isolate`, `slow`, and one `poisoned` copy.
No tag-based clear reaches those, which means **all 15 existing `filter_tag: "debuff"`
rows in the corpus under-cover by the same amount** — every Cleanse and Dispel in the
game, not just this row. Closing it properly is a status-tagging migration, tracked
separately from this skill.

Net effect in play: the six core FU statuses ARE tagged and do clear; an untagged
status copy rides through the Minion's rest.

## 4. The Dismiss is a turn ACTION, where RAW grants it "at any time"

Added 2026-09-05 with "Birth of the Cruel: Dismiss".

RAW: *"You may also destroy your Minion at any time; if you want to create a new
Minion, you must first destroy the current one."*

Config: `skill_type: "Active"`. Every `pickSkill()` call site lives inside the Battle
Director's turn compose (`compose-action.js`, `state-handlers.js`), so the Dismiss is
reachable only on your turn, in a conflict, and it spends the turn's action.

**Why this stands.** There is no out-of-conflict entry point for an Active skill in
this engine. The alternatives were a `party_rested`-style forced trigger (wrong — a
dismiss is a decision, not an automatic event) or a free-action grant (needs a carrier
action to hang off, which reintroduces the same turn dependency). Spending the action
is the honest cost of making the release reachable at all; before this the Minion could
only be released by Keren dying.

**Consequence to know at the table:** freeing the raise gate costs an action. If that
matters in play, the fix is a free-action grant on Birth of the Cruel itself, not a
change to this skill.

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
