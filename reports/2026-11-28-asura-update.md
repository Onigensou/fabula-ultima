---
id: 2026-11-28-asura-update
title: Asura post-playtest update — IM Paralyzed, Air reaches flyers, flyer hunt, Overflow feeds his passives, Asura Strike ignores Provoke
status: open
reporter: onigensou
assignee: sarunphat
component: battle-director/skill-effects, reaction-hand, skill-formulas, state-handlers, compose-action, skill-targeting; data-migrations
fixed_in: (unreleased, branch feat/asura-update-1128)
---

Built from the user's 11-28 Valley trio playtest calls (session-planning/2026-11-28/notes.md, To-do 1-6).
World data changes ride ONE idempotent migration, `2026-11-28-asura-update`, on the world actor
Asura (`0AwQ7wEDz4ISA9mA`). Engine changes are generic; no Asura name in engine code.

## What changed

### A. Asura IM Paralyzed (data)
`condition_paralyzed` NA → IM. Paralyzed disables the Skill action, which is his whole clock
(the four Sword Enchants and Asura Strike). Same call as Rakshasa earlier today.

### B. Air Aspect reaches Flying (data + text)
The "Air Aspect" AE template on Elemental Aspect gains the change `can_target_flying_with`
(value empty = any melee). The NPC range gate reads it live (`snapshot.attackerCanMeleeFlying`
→ `CAN_REACH_FLYING`), so while Air is his Aspect, Elemental Slash, Elemental Slash (Enchanted)
and Overflow can hit Flying creatures. Other Aspects: unchanged, flyers stay out of reach.

Text (Genshin mode, only the lines about flyers):
- Air Aspect AE: + "Elemental Slash can target Flying creatures."
- Elemental Slash and Elemental Slash (Enchanted), Air line:
  "Air — the target is left Silenced." → "Air — the target is left Silenced. Can target Flying creatures."
  (Flying is a link to the Flying keyword journal.)

### C. The AI goes Air when only flyers are left (engine var + data)
- New formula vars `ENEMY_COUNT_FLYING` / `ENEMY_COUNT_GROUNDED` (skill-formulas.js). They use
  the same roster as `ENEMY_COUNT_LACKING_` (dCombat opponents: living, visible, targetable) and
  read Flying the way the melee range gate does (Flying status or AE named Flying over
  appliedEffects, so item transfer AEs count; a Grounded `flying_grounded` change suppresses it).
  `ENEMY_COUNT_LACKING_FLYING` was not used: it reads only `actor.effects` (misses transfer-AE
  flyers) and still counts a Grounded flyer as Flying.
- New pattern row on Asura: Sword Enchant - Air, priority **9**, condition `formula`:
  `ENEMY_COUNT_FLYING > 0 && ENEMY_COUNT_GROUNDED == 0 && AE_COUNT_AIR_ASPECT == 0`.
  Priority 9, not 7: the picker weighs every row within 2 points of the top one (gap 0/1/2 =
  weight 3/2/1). At 7 the first sandbox run picked Sword Enchant - Fire first (weight 1 of 3).
  At 9 (3 above Asura Strike's 6) every other row drops out, so the hunt is deterministic.
  The Enchant's 10 Air self-damage sets the Air Aspect (Elemental Aspect row 3, unchanged).

### D. Overflow feeds his passives (engine + data)
- Engine: `reaction_source_skill` takes a comma list; any listed name passes. Exact names,
  case-insensitive, blank = any, a single name works as before (`source-skill-filter.js`, used by
  `skill-effects.js passesMatchFilters`). The reaction hand's "From …" text reads the list. The
  mindscape sim (`tools/mindscape/lib/monster-data.js`) and the party-verify probe read it too.
  No skill name in the world contains a comma (scanned 11-28). Template-field tooltip updated.
- Data: Elemental Aspect rows 4-10 (`slash_*` element + bonus, `mark_*` statuses) were scoped to
  "Elemental Slash"; they now read "Elemental Slash, Elemental Slash: Overflow".
- Four-Armed Fury and Ascension ALREADY had dedicated Overflow rows (row 1 / row 5), so they are
  untouched. Adding Overflow to their Slash rows would have counted it twice.
- The Overflow cast reports `sourceSkillName = "Elemental Slash: Overflow"` (sandbox log).
- Balance effect: Overflow under the Fire Aspect now also gets the Aspect slash bonus, **+10 per
  target** (it is an All Enemy move). Fury and Ascension already applied to it.

### E. "Ignores Provoke" for signature moves (engine + data)
- New action keyword `ignore_provoke` in a move's `action_keywords` (no new sheet field;
  `provoke-bypass.js`). Accepted spellings: ignore_provoke, ignore provoke, ignores provoke,
  ignores_provoke.
- It skips the Provoked pin (`must_include_applier`) at every place it narrows targets:
  1. TARGET picker / AI pins: `state-handlers.resolveActionTargets` (`pinKind`).
  2. Drawn-Chain pin "strike 1 goes to the provoker": the Skill and Attack Chain branches in
     `state-handlers` COMPUTE (this was the one that touched Asura Strike: Chain 4 seek).
  3. Row-level narrowing of the action's own effect rows: `skill-targeting.js` 3d-bis.
  4. Player compose pins: `compose-action.js` (PC attack, NPC attack, skill).
  5. `ACTION_IS_PROVOKABLE` (actionPinKind): an action that ignored the pin does not consume
     Peacock Dance's one-shot Provoke.
  Taunter pins (target-side `must_be_targeted_by`) still apply. Only Provoke is bypassed.
- Data: Asura Strike `action_keywords` "pierce, chain 4 seek" → "pierce, chain 4 seek, ignore_provoke".

## Tests
- `battle-director/source-skill-filter.test.mjs` (17 checks), `battle-director/provoke-bypass.test.mjs` (25 checks).
- Full sweep: 184 pass / 8 fail. 5 are the known ones (crisis-keywords, impact-offsets, soul-fx-look,
  return-look, return-stage). The other 3 (deferred-followups, crack-out, return-close) failed only under
  the parallel load (timing / perf thresholds, one hit the 120 s cap) and pass when run alone.

## Sandbox (port 30034, world copy, real first boot)
Real first boot ran only this migration ("1 ran, 0 failed, 214 total"). Summary:
`~ A: condition_paralyzed NA -> IM | ~ B: Air Aspect template changes + description | ~ B: Elemental Slash Air line + "Can target Flying creatures." | ~ B: Elemental Slash (Enchanted) Air line + "Can target Flying creatures." | + C: pattern row 8 Sword Enchant - Air (priority 7, formula) | ~ D: Elemental Aspect 7 rows "Elemental Slash" -> "Elemental Slash, Elemental Slash: Overflow" | ~ E: Asura Strike keywords "pierce, chain 4 seek" -> "pierce, chain 4 seek, ignore_provoke"`
After the priority change, a re-run printed `~ C: flyer-hunt pattern row 8 priority 7 -> 9`, and a third run printed `=` for every step (idempotent).
(On the real world the first boot writes priority 9 directly.)

Driven with `FUCompanion.api.experimental.sim.run` / `testSkill`. Sandbox-only tweaks are named per check.

1. **Only flyers left → Air, then Slash: PASS.** Asura vs Hina alone (Icarus Wing gives her Flying, log `applied "Flying"`).
   No guests, so this matches "everyone else KO". Asura Strike was parked at priority 0 in the sandbox so the run shows Air → Slash.
   Free Round: activation 1 = **Sword Enchant - Air** (priority 9 row), then `Attack "Elemental Slash (Enchanted)" … applied 84 dmg to Hina [SIM]`
   in round 1 and 93 dmg in round 2. Before, no Slash could reach her.
   Seen in the run: each other Enchant (Fire/Ice/Bolt) replaces the Aspect, then the row casts Air again (open call 1).
2. **Overflow feeds the passives: PASS.** DB party, Overflow cost set to "-" in the sandbox (he starts each fight at 0 MP),
   HP 700 so he is in Crisis. Natural pattern pick: `Attack "Elemental Slash: Overflow" on 3 target(s)`. The cast reports
   `got="Elemental Slash: Overflow"`. On the hit: `[PassiveCard] "Elemental Aspect" → on-hit bonus`,
   `"Four-Armed Fury" → on-hit bonus`, `"Ascension" → on-hit bonus`. The rows scoped to other skills logged
   `source_skill filter failed` as they should. (Hina's Prophetic Defender absorbed all 3 hits.)
   The Marks are lit by damage he takes, not by Overflow hits, so there are no new Marks to show. The Aspect's status rows
   (`mark_bolt/ice/air`) also accept Overflow now, but Overflow only runs under the Fire Aspect, which has no status row.
3. **Provoke: PASS (pin skipped), with a caveat.** Blanche casts Provoke on Asura in an Advantage Free Round
   (`applied "Provoked" to 1 actor(s)`), then a scripted Asura Strike (cost "-" in the sandbox). Log:
   `COMPUTE: Chain 4 (seek) on Asura Strike` with no "— strike 1 pinned to the provoker" suffix. Strikes:
   Keren 24 · Zarg BLOCK · Blanche 48/37 (three party members hit). In page: `provokePinKind("attack", Asura Strike) = null`,
   Elemental Slash = "attack".
   Caveat: I did NOT stage an untargetable provoker. In code there was never a "whiff" path for Strike. It is All-mode with no
   picker pins, and its own effect rows only target himself, so row-level narrowing never touched it. The only way Provoke
   changed Strike was the drawn-Chain strike-1 pin, and that pin is now skipped.
4. **Paralyzed can't be applied: PASS.** In a live battle, `applyEffectRow(apply_ae "Paralyzed", self)` on the Asura token →
   `Asura immune to "Paralyzed" (condition_<slug>=IM)`, applied to 0 actors. Control row Silence → applied to 1.

## Open calls (for the user)
1. **Other Enchants still wipe the Air Aspect.** vs an all-flyer party he runs Enchant X → Air →
   Enchant Y → Air until every Mark is lit, because the other Enchant rows (prio 5) replace the
   Aspect. He is never idle (Enchants are his power-up, per the 11-11 decision), but it costs him
   actions. Options: leave it, or gate the other Enchant rows off while only flyers remain.
2. **Asura Strike text** does not say it ignores Provoke. Suggested line: "Ignores Provoked."
   Not written: approved text is left as is until you say.
3. **Overflow +10 per target** from the Aspect (D) is a small damage raise on his AoE.

## Owed
- Real GM boot of the world runs the migration (merge `_manifest.json` with any other 11-28
  migration branch; this one appends `2026-11-28-asura-update`).
- Save slot 1: patch the same changes in (rule: between-session world changes go into slot 1).
- Ignores Provoke candidates on other bosses (NOT flagged, user call each): Deva Fists of Fury
  (chain 12) / Ground Slam; Rakshasa Severing Verdict (+162); Hilde-Fafnir Zero Power: Reinslaughter;
  Nidhogg Wailing Breath (massive) / Call of the Master; Galvanic Paryashera Galvanic Drill (chain 6);
  Kirin Divine Railstream (chain 8); Crysta Zero Power: Water-Moon Mirage; Fafnir Condemn; Gigas Heavy Swing.

## Update 2026-11-28 (user call): Enchant gate

Open call 1 decided: switch the other Enchants off while only flyers remain. New migration `2026-11-28-asura-enchant-gate` (asura-update had already run on the real world): the Fire/Bolt/Ice Enchant rows become `AE_COUNT_<X>_MARK == 0 && ENEMY_COUNT_GROUNDED > 0`. Calls 2 (Overflow gets the Aspect bonus) and "no Ignores Provoked text" were confirmed by the user.
