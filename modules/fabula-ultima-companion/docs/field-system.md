# Field System — effects held by the battle scene

A **field effect** is an effect no creature owns: the elemental wellsprings an
Invoker draws on, weather, a terrain hazard, a boss arena's aura. This module
gives those a home without inventing a new effect model.

## The one idea

The runtime holder is a single hidden world Actor, **`Field`**
(`flags.fabula-ultima-companion.isField = true`, GM-only ownership, never a
token). Its only content is its **Active Effects**. Every facility the engine
already has for an effect — charges and round tickers, tags and
`remove_tagged_ae`, the AE → `reactionConfig` bridge, formula identifiers that
read AE-applied flags, the status library — therefore works on field effects
unchanged.

Three documents, created lazily by the primary GM's first `ready`
(`scripts/field-system/field-api.js`), so a world that has never run this code
gets them without shipping LevelDB:

| Document | Type | Role |
|---|---|---|
| `_Field Template` | Actor `_template` (CSB) | versioned (`FIELD_TEMPLATE_VERSION`, auto-upgraded on boot): a **Wellsprings** container (tag `wellspring`, compact), a **Field Effects** container (tag `field`, with descriptions), and a collapsed **GM notes** panel. Tag what you author, or it will not appear |
| `Field` | Actor `character` | THE runtime holder |
| `Field Effects` | Item `activeEffectContainer` | library of AE templates (7 wellsprings + sample hazards) |

## Where effects come from (producers)

1. **The scene.** Scene Config → Fabula → General has the wellspring chips
   (Air/Earth/Fire/Lightning/Water default *present*; Moon/Sun default
   *absent*) and a **Field Effects** picker (library chips + free-text names).
   Stored under `flags.fabula-ultima-companion.oniFabula.general`:
   `wellspring_<elem>` booleans + `fieldEffects` (comma list).
   `seedFromScene` reconciles the Field to that declaration on world ready, on
   scene activation, when the active scene's config is edited, and at
   `conflict_start`. Scene-seeded AEs are stamped `fieldOrigin: "scene"` +
   `fieldSceneId`; **only** those are ever removed by a reseed, so anything a
   skill or the GM added survives until its own lifetime ends.

   **Precedence — the scene declaration wins.** `add()` of a name the active
   scene already declares returns the scene copy untouched (a transient copy
   would be swept at scene end and take the declared effect with it). A reseed
   that finds a transient copy of a name the scene declares **promotes** it to
   scene ownership (one copy, permanent, lifetime bookkeeping dropped) rather
   than creating a second one that would double-fire a reaction row. A skill's
   `apply_ae` of a scene-declared effect refreshes in place; its
   `ae_duration_rounds` cannot shorten the scene's standing effect.
2. **Skills.** `target_ref: "field"` resolves to the Field as an actor carrier
   (like `own_persistent_summons`). `apply_ae` with a library name creates a
   field effect with the normal charge/lifetime rules, credited to the caster;
   `remove_tagged_ae` with `filter_tag` ends them.
   ```
   { effect_kind: "apply_ae", ae_template_ref: "Rain", target_ref: "field", ae_duration_rounds: "3" }
   { effect_kind: "remove_tagged_ae", filter_tag: "hazard", count: "all", target_ref: "field" }
   ```
3. **The GM.** Open the `Field` sheet and toggle/add/remove, or
   `FUCompanion.api.field.add("Scorching Ground")` / `.remove(name)` /
   `.list()` / `.library()`.

## How effects reach creatures (consumers)

**Query** — gate formulas read the Field:

| Identifier | Meaning |
|---|---|
| `WELLSPRING_<ELEM>_AVAILABLE` | 1 if the Field carries `wellspring_<elem>` **or the asking creature does** (air/earth/fire/bolt/ice/dark/light) |
| `WELLSPRING_COUNT` | how many the asking creature can draw from |
| `FIELD_HAS_<NAME>` | 1 if an enabled Field AE matches by name, tag or status id (`FIELD_HAS_SCORCHING_GROUND`, `FIELD_HAS_HAZARD`) |
| `FIELD_FLAG_<KEY>` | numeric value of the Field's AE-applied flag `flags.<ns>.<key>` |
| `FIELD_EFFECT_COUNT` | enabled effects on the Field |

**Push** — the AE carries `flags.fabula-ultima-companion.reactionConfig`
(the Ninja Log pattern) and the Field is enumerated as a **reactor**:
standalone lifecycle triggers (`conflict_start`, `round_start`, `round_end`,
`turn_start`/`turn_end` with the acting creature as subject), the ledger family
(`creature_lose_resource`, …) and the card scan
(`creature_targeted_by_action`). Rules for rows on the Field:

- `reaction_passive_mode` must be **`force`** or **`on`** — there is no token
  to hang an ask-menu on; the ask pass skips the Field.
- `reaction_source` must be **`all`** (or the absolute `party` / `hostile`);
  the Field has no side, so `ally`/`enemy` match nothing useful.
- targets: `all_combatants`, `all_party`, `all_hostiles` (absolute sides;
  all three carry `exclude_defeated: true`, so a KO'd creature at 0 HP is
  skipped — the raw `combat` pool keeps it), `trigger_subject` (the
  acting/affected creature; `turn_start`/`turn_end` stamp it).
- an incoming `adjust_damage` on `creature_targeted_by_action` mutates the
  **subject's** slot (a bystander reactor has no slot of its own), and the
  Field gets **one candidate per target** — a creature's row is once per
  action, the Field's is about each subject.
- for `deal_damage`, set `attacker_name` so the battle log names the hazard.

Worked examples live in the library: **Scorching Ground** (round_end, 5 fire
to `all_combatants`) and **Thin Air** (turn_start, −5 MP to `trigger_subject`).

## Scoping rule

`available(X) = Field AEs ∪ the asking creature's own AEs with the same flag`.
So a per-character grant — Inner Wellspring, Wheel of Moon and Sun — is a plain
self-AE with change key `flags.fabula-ultima-companion.wellspring_<elem>` and
needs no field machinery.

## Relationship to Conflict Events

`scripts/conflict-event/` is the **scripted** counterpart: one JS rule per
scene for logic that cannot be declared (Lightning Storm's moving Rod). The
Field is the **data** counterpart: any number of declarative effects. They
coexist; a conflict event may seed Field AEs.

## Testing

- `FUCompanion.api.test.probeReactorTrigger({ reactorActorUuid: field.uuid, trigger: "round_end", payload: {...} })`
  exercises a push row through the real pipeline with writes captured.
- `probeTargetedReactions({ …, picks: ["Pyro Blast"], reactorNames: ["Field"] })`
  for card-path rows (the Field is in the harness reactor set).
- Query identifiers: build a resolver with `buildSkillResolver({ actor })` and
  `evaluateFormula("WELLSPRING_AIR_AVAILABLE", r, -99)`.
- Lifetimes: the applier-turn ticker and the scene-end sweep iterate
  `game.actors`, so Field AEs tick and sweep like any world actor's.
