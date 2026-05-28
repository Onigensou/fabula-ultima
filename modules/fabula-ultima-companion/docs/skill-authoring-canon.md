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

- `scripts/lint/reaction-config-lint.js` flags every canon-deprecated
  prop at boot:
  - `DEPRECATED_PROPS_PASSIVE_MODE` — top-level `passive_mode` set
  - `DEPRECATED_HARDCODED_PASSIVE_FLAG` — `<class>_passive: true`
  - `DEPRECATED_FIRE_POINT_POST_DAMAGE`
  - `DEPRECATED_FIRE_POINT_PASSIVE_CHECK_BONUS`
  - `DEPRECATED_FIRE_POINT_PASSIVE_DAMAGE_BONUS`

  Auto-runs on `ready`; GM sees a notification if any errors fire.
- `macros/Authoring/CreateSkillFromSpec.js` REJECTS new specs that
  author the deprecated fields — returns `{ ok: false, reason:
  "canon_violation" }` and notifies the GM. Migration scripts that
  bypass the macro (writing directly via `Item.create`) aren't gated;
  they should still follow canon or carry a deprecation note.
- Run `FUCompanion.api.lint.runReactionLint()` after any data migration
  to verify no regressions slipped in.

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
