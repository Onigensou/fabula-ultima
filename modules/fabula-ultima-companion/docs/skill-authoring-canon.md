# Skill Authoring Canon

Battle Director skills follow a strict authoring canon. **All
conditional / triggered / passive behavior lives in `system.props.reaction_config_table`
rows + `effect_table` rows** — NOT in top-level `system.props.*` fields.
The Skill Effects panel should expose only `On-Activate Effect Ref`;
everything else is a reaction row.

## Canonical homes

| Concern | Canonical home | Don't author at top level |
|---|---|---|
| Passive on / ask / off mode | `reaction_config_table[N].reaction_passive_mode` | ~~props.passive_mode~~ |
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
