# Skill Authoring Canon

Battle Director skills follow a strict authoring canon. **All
conditional / triggered / passive behavior lives in `system.props.reaction_config_table`
rows + `effect_table` rows** — NOT in top-level `system.props.*` fields.
The Skill Effects panel should expose only `On-Activate Effect Ref`;
everything else is a reaction row.

## Decision tree

Before authoring a skill / spell, walk this tree to decide where the
behavior goes:

1. **Activated by the player from the turn menu?**
   → It's either a **simple spell that uses the legacy fields**
     (`cost`, `damage_bonus`, `isCheck`, `type_damage`, etc. — Lux, Heal
     as a recipe call, generic Magic Check spells), OR a **complex
     skill that uses `effect_table` rows** (Reinforce's open_action_menu
     picker, Cleanse's remove_tagged_ae, custom multi-step chains).
     Either way, the activation is wired through `on_activate_effect_ref`.
     This is the ONE legitimate inhabitant of the Skill Effects panel.

2. **Activated by an external event (not the turn menu)?**
   → Author a **reaction_config_table row** with the appropriate
     trigger (`creature_completes_spell`, `creature_deals_damage`,
     `creature_performs_check`, etc.) pointing at an `effect_table` row
     via `reaction_effect_ref`. **If the trigger you need doesn't
     exist yet, add a new canonical trigger** (with the matching subject
     side + filter matrix entry) rather than hardcoding the behavior in
     the engine.

3. **The behavior is a buff / debuff on another creature?**
   → Apply an AE to that creature with a `reactionConfig` blob on the
     AE's flags. The reactionConfig holds its own
     `reaction_config_table` + `effect_table`. The AE is the carrier;
     the dispatcher fires it the same way it fires skill-borne
     reactions. Mercy / Support Magic are the canonical examples.

4. **The behavior is limited to N activations or a duration?**
   → Apply an AE to the user (self or other). The AE holds the
     reactionConfig AND `flags.fabula-ultima-companion.charges /
     chargesMax / chargeKey`. The dispatcher auto-decrements charges
     each time the reaction fires; at 0 the AE deletes itself. For
     duration-based limits, rely on the existing director-AE turn
     ticker (see `[[ae-default-3-turn-duration]]`) or set explicit
     `duration.rounds`.

5. **A *true* passive — always-on while the skill is owned, no
   trigger, no chargeable count, no duration?**
   → Embed an AE on the skill item with `transfer: true` and no
     duration. CSB / Foundry V12 auto-applies the AE's changes to
     the bearer on every sheet derive. **No reaction_config_table,
     no effect_table, no apply_ae dispatch.** Examples: Dodge's
     `bonus_defense +=` SL bonus; any "while you have this skill
     equipped, X" rule. Canon shape:

     ```js
     {
       name: "<Skill Name>",
       transfer: true,           // ← the key bit
       disabled: false,
       duration: {},             // no turn / round ticking
       changes: [
         // Bare CSB column names (auto-prefixed to system.props.*).
         // ${level}$ reads the BEARING SKILL ITEM's
         // `system.props.level` dynamically. CSB AEF exposes the
         // bearing item's props at the top formula scope (not under
         // an `item.` namespace — that doesn't resolve). Levelling
         // the skill auto-updates the bonus on the next sheet
         // derive. Used by every legacy class passive that scales
         // with SL (Adrenaline: `${level * 2}$`; Defensive Mastery,
         // Retaliation, Wardancer, etc.: `${level}$`).
         { key: "bonus_defense", value: "${level}$", mode: 2, priority: 20 },
       ],
       system: { tags: ["buff"] },   // opt-in classification
       statuses: ["fud-<slug>"],     // V12 token-icon ring needs at least one
       flags: { ... },               // no directorPermanent — not director-applied
     }
     ```

     **Reading actor stats.** Use `${fetchFromParent('<prop>')}$`
     for actor-side values — e.g. Prophetic Defender Style reads
     `${fetchFromParent('ins_current')}$` to add INS to bonus_hp.
     `fetchFromParent` reads the BEARING ACTOR's props; bare
     identifiers like `level` resolve against the BEARING ITEM's
     props. Combine for hybrid formulas like `${ins_current + level * 2}$`
     (would need both — actor's INS plus 2×skill SL).

     **Conditional gates.** RAW rules like Dodge's "as long as you
     have no shields and no martial armor" are NOT enforced at the
     engine level — the director's `HAS_SHIELD` / `HAS_MARTIAL_ARMOR`
     formulas don't bridge to CSB AEF, and `aeWhen` /
     `aeStatusWhen` (the existing conditional-change-gate helpers)
     only gate on actor status effects, not equipment. For now,
     these gates are **player-honour** — the player simply doesn't
     equip the disallowed gear when they want the bonus. Future
     work: extend the conditional gate with `aeEquippedWhen("shield",
     ...)`.

### Proposed rule 5 — scope by folder, not by name

When migrating named items, **scope the migration to the
`Battle Director` folder tree** (and via `system.uniqueId` for actor
copies — find the master by uniqueId, then check its folder ancestry).
Filtering only by `item.name === "Foo"` will collide with legacy items
that happen to share a name (real case: Acceleration exists as both a
BD-tree skill and an Entropist legacy spell). Touching a legacy item's
canon-only fields can subtly break its sheet.

A small inline helper at the top of every migration:

```js
const BD_ROOT_NAME = "Battle Director";
function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}
function actorCopyIsBattleDirector(item, masterIndexByUniqueId) {
  const uid = String(item?.system?.uniqueId ?? "").trim();
  if (!uid) return false;
  const master = masterIndexByUniqueId.get(uid);
  return master ? isInBattleDirectorTree(master) : false;
}
```

(More rules may be added as new patterns surface.)

## Why the 5 rules matter

They map directly to the lint + spec-guard rules below:

| Authoring rule | Caught by |
|---|---|
| #1 picks legacy OR effect_table — never both for the same fire-point | Lint flags deprecated fire-point props (`post_damage_effect_ref` etc.) when rows exist |
| #2 requires reaction_config_table for external activations | Engine canon lint flags hardcoded name / flag checks in director source |
| #3 puts behavior on the AE, not the skill | `REACTION_FLAG_MISSING` catches AEs with reactionConfig under skills lacking `isReaction:true` |
| #4 uses the existing charges system | Reuse means no per-skill counter props (the deprecation table forbids those) |
| #5 uses `transfer: true` for true passives, NOT a reaction trigger | (lint rule pending — `PASSIVE_FAKE_REACTION` should flag a `turn_start` row whose only effect is `apply_ae` of a self-AE) |

## Reaction UI policy (locked 2026-05-30)

Two co-existing UIs, classified by **trigger phase** in
`scripts/battle-director/director-triggers.js` (`TRIGGER_PHASE` map).
The dispatch site reads the phase to pick the UI — no per-handler
conditionals.

| Phase | Triggers | UI |
|---|---|---|
| **pre-resolve** | `caster_short_on_mp`, `creature_completes_spell`, `creature_will_deal_damage` | Pills on action card (`buildReactionPillRow`) |
| **post-resolve** | `creature_deals_damage`, `creature_takes_damage`, `creature_performs_check`, recovers HP/MP, etc. | Token-anchored menu (`ReactionMenu.spawn`) |
| **standalone** | `conflict_start/end`, `round_start/end`, `turn_start/end` | Token-anchored menu (`ReactionMenu.spawn`) |

User's locked rule (re-affirmed 2026-05-30 — co-developer
preference):

> "If it manipulates the values in the action, the reaction shows
> during the Action Card. Some exceptions only happen after the
> action is resolved: Counterattack, Absorb MP, Painful Lesson.
> Another exception would be reactions that happen outside of
> action, such as Start of Turn, End of Turn, etc."

Adding a new trigger:

1. Add to `DIRECTOR_NATIVE_TRIGGERS`.
2. Add to `TRIGGER_PHASE` with `"pre-resolve" | "post-resolve" | "standalone"`.
3. Wire the dispatch site (CONFIRM for pre-resolve, RESOLVE-tail
   for post-resolve, FSM transition for standalone).
4. Run a template-surgery migration to expose the trigger in the
   CSB editor's dropdown.

Both UIs route through the **same engine path**:
`findPassiveCandidates` (matcher) → `firePreAcceptedCandidate`
(applier). Authors don't pick the UI; the trigger's phase does.

See [[reaction-pills-on-action-card]] + [[reaction-menu-on-token]]
for engine + UI surfaces.

## Canonical homes

| Concern | Canonical home | Don't author at top level |
|---|---|---|
| Passive on / ask / off / force mode | `reaction_config_table[N].reaction_passive_mode` | ~~props.passive_mode~~ |
| Skill level (current SL) | `system.props.level` — set to `1` in every new spec (the FU Core convention: a newly acquired skill starts at SL 1). | leaving level blank → CSB inherits the template default which may not be 1 in practice |
| Skill max level (cap on SL) | `system.props.max_level` — RAW values per FU Core: Active Skills 1-3 typically, Passive Skills 1-5, Heroic Skills 1, narrative Fabula-Point skills 1. Always set explicitly; never rely on template defaults. | leaving max_level blank → CSB inherits the template default of `"1"` which is wrong for any skill with a real progression |
| Heroic skill flag | `system.props.isHeroic: true` — required on Heroic Skills + Heroic Spells; gates the `Battle Director / <Class> / Heroic Skill` folder placement + suppresses SL ranking UI (Heroics are 1-shot, no SL progression). | bare `folder: "Heroic Skill"` without isHeroic — placement works but the sheet shows the SL ranker which doesn't apply |
| Always-on passive bonus (Dodge-style) | Embedded AE on the skill item with `transfer: true`, no duration. Change value uses CSB formula syntax: `${level}$` reads bearing skill SL; `${fetchFromParent('<prop>')}$` reads actor props. Foundry/CSB auto-applies to the bearer; the bonus disappears when the skill is removed. NO `reaction_config_table`, NO `effect_table`. | ~~turn_start force-mode reaction + apply_ae~~ — wastes a trigger dispatch on something that should just BE. ~~literal-baked numbers~~ — loses dynamic SL scaling. |
| Engine-mandatory housekeeping (Protect charge refresh etc.) | reaction row with `reaction_passive_mode: "force"` — auto-fires AND stays invisible to UI (no pill, no menu blade, no Passive Manager toggle). Reserved for system mechanics the player shouldn't see as a choice. | ~~hardcoded engine flag, per-skill cleanup hook~~ |
| "Fires when caster's spell hits an ally" | reaction row, trigger `creature_completes_spell` + `reaction_action_target: "ally"` | — |
| "Fires after I deal damage" | reaction row, trigger `creature_deals_damage` + `reaction_source: "self"` | ~~props.post_damage_effect_ref~~ |
| "Adds bonus to my Check" | reaction row, trigger `creature_performs_check` + effect_kind=grant | ~~props.passive_check_bonus_formula~~ |
| "Adds damage to my attacks / spells" | reaction row, trigger `creature_deals_damage` + effect_kind=grant | ~~props.passive_damage_bonus~~ |
| "I am a Vismagus / Mercy-style passive" | reaction row with the appropriate trigger | ~~props.\<class\>_passive: true~~ — engine must never gate on class-named boolean flags |
| AE that fires N times then removes itself | `flags.fabula-ultima-companion.charges/chargesMax/chargeKey` + an `effect_table` row whose effect_kind triggers `consume_charge`. Use the existing `skill-charges.js` consume API; the AE auto-deletes when charges reach 0. | Per-skill counter props |

## Enforcement

Two lint passes — one for the data side, one for the engine source —
plus a spec-time guard. All run automatically at GM `ready`.

**Data lint** — `scripts/lint/reaction-config-lint.js`
Flags every canon-deprecated prop on every Item (master + actor copy):
- `DEPRECATED_PROPS_PASSIVE_MODE` — top-level `passive_mode` set
- `DEPRECATED_HARDCODED_PASSIVE_FLAG` — `<class>_passive: true`
- `DEPRECATED_FIRE_POINT_POST_DAMAGE`
- `DEPRECATED_FIRE_POINT_PASSIVE_CHECK_BONUS`
- `DEPRECATED_FIRE_POINT_PASSIVE_DAMAGE_BONUS`

Plus structural checks on `reaction_config_table` and `effect_table`
rows. Run manually: `FUCompanion.api.lint.runReactionLint()`.

**Engine lint** — `scripts/lint/engine-canon-lint.js`
Static-greps director engine source files for code that hardcodes
skill-specific behavior — the *other* class of canon violation, where
the engine reads a class-specific flag or branches on a skill name
instead of dispatching via reaction_config_table:
- `ENGINE_HARDCODED_SKILL_NAME` — `*.name === "<SpecificSkill>"`
- `ENGINE_DEPRECATED_PASSIVE_FLAG_READ` — `props.<x>_passive` reads
- `ENGINE_HARDCODED_UUID` — `Item.<...>` / `Actor.<...>` literals

Run manually: `FUCompanion.api.lint.runEngineCanonLint()`. Intentional
violations can be moved to the `ALLOWLIST` constant in that file —
every entry is an admission that the canon doesn't yet cover the case
and is a TODO for refactoring.

**Spec-time guard** — `macros/Authoring/CreateSkillFromSpec.js`
REJECTS new specs that author the deprecated fields — returns
`{ ok: false, reason: "canon_violation" }` and notifies the GM.
Migration scripts that bypass the macro (writing directly via
`Item.create`) aren't gated; they should still follow canon or carry a
deprecation note.

## Transition states

When the engine still reads a deprecated field (e.g. Drain Spirit's
`post_damage_effect_ref`, Vismagus's hardcoded flag), the lint emits
`severity: "info"` rather than `"error"` and a follow-up migration is
queued to convert. **Don't add NEW skills using deprecated patterns** —
the guard blocks that.

The deprecation table is the contract: when the engine drops a field's
reader, the corresponding lint rule should escalate from `info` to
`warning`/`error` and a migration should sweep the field off all
remaining items.

## Related

- `reaction-config-schema.md` — full reaction_config_table + effect_table
  schema (31 triggers, all effect_kinds, formula identifiers).
- `action-payload-shape.md` — every `system.props.*` field surfaced
  through the action pipeline.
- `battle-director-skill-roadmap.md` — class-by-class delivery order.
