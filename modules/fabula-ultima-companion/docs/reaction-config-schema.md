# Reaction Config Schema

Schema reference for the **two sibling tables** that drive declarative
reaction behavior on a skill item:

- `system.props.reaction_config_table` — *trigger* rows. Each row says
  "when this trigger matches under these filters, fire effect X."
- `system.props.effect_table` — *effect* rows. Each row defines what to
  do (grant a resource, apply an AE, consume a charge, redirect a pending
  action card, or chain other effects). **Renamed from
  `reaction_effect_table` (Phase D, commit pending) — the runtime reads
  either key, preferring `effect_table`. The legacy key remains valid for
  back-compat.**

Rows are stored as objects keyed by row id (CSB numeric rowKeys), e.g.
`{ "0": {...}, "1": {...} }`. Order within the object is the row order in
the editor. Deleted rows carry `$deleted: true`.

When writing a skill spec, you populate these two tables. The matching
runtime code is in `scripts/reaction-system/reaction-triggers.config.js`
(trigger registry) and `scripts/reaction-system/reaction-grant.js`
(effect dispatch).

## Skill-activation fire points (Phase D)

The `effect_table` is **not reaction-specific** — it's a general-purpose
catalog of "things this skill can do." A skill's own action pipeline can
fire effects from its table without going through the reaction registry,
via these skill props:

| Prop | Fires when | Payload context |
|---|---|---|
| `on_activate_effect_ref` | Skill body activates (reserved — pipeline hook pending) | SL + BOND_* + reactor resources; no damage payload |
| `post_damage_effect_ref` | After Create Damage Card resolves, **per affected target** | Full damage payload (`finalValue`, `valueType`, target uuids) — `*_DEALT` formula identifiers resolve here |

Each prop is just a reference to an `effect_label` in this skill's
`effect_table`. No new effect_kinds; the existing handlers (`grant`,
`apply_ae`, `consume_charge`, `chain`) run as-is.

Use these for "after my own skill resolves, do X" mechanics — drain /
leech, on-cast self-buff, post-damage trigger — that aren't structurally
reactions to outside events.

## Passive bonus formula props (Phase E)

For passive skills that should add a flat (or formula-driven) bonus to
**every** action the owner performs — Adversity, Magical Artillery, etc. —
the skill's `system.props` can carry two formula-string fields read by
the passive-modifier-engine during the action phase:

| Prop | Applies to | Pipeline hook |
|---|---|---|
| `passive_check_bonus_formula` | `actionCtx.accuracy.bonus` (added) | `evaluatePassiveModifiers` — action phase |
| `passive_damage_bonus_formula` | `actionCtx.advPayload.bonus` (added) | `evaluatePassiveModifiers` — action phase |

Each is a formula string with the same grammar as `grant_amount` (see
[Formula identifiers](#formula-identifiers-resolved-against-the-reactor--trigger-payload)).
Identifiers resolve against the actor performing the action; the
identifier `STATUS_COUNT` exposes the actor's current count of
debuff-classified effects (see [Formula identifiers](#formula-identifiers-resolved-against-the-reactor--trigger-payload)).

Blank disables. Applies on every action — gate inside the formula itself
(e.g. `min(STATUS_COUNT, 3)` resolves to 0 when no statuses are present).

**Important — the passive-formula evaluator is `oni.ReactionFormula`
([formula-evaluator.js](modules/fabula-ultima-companion/scripts/reaction-system/formula-evaluator.js)),
a smaller identifier set than the Battle Director reaction resolver
([skill-formulas.js](modules/fabula-ultima-companion/scripts/battle-director/skill-formulas.js)).**
Rich identifiers like `HAS_RANGED_WEAPON`, `CRIT`, `RAW_DAMAGE`,
`TARGET_STATUS_COUNT` etc. exist ONLY on the reaction side and resolve to
0 here. The passive-formula evaluator supports: `SL`, `CUR/MAX_HP|MP|IP`,
`BOND_STRENGTH`, `BOND_COUNT[_<EMOTION>]`, `STATUS_COUNT`,
`DAMAGE|HP|MP|SHIELD_DEALT`, `ROUND`, `ACTION_TARGET_COUNT`, plus three
action/equipment gates pre-computed by the passive-modifier-engine:
`ACTION_IS_SPELL`, `ACTION_IS_OFFENSIVE_SPELL`, `HAS_ARCANE_WEAPON`
(each 1/0). If you need a gate not in this list, add it to
`oni.ReactionFormula` (and, when it needs actor/action context the
evaluator can't reach, pre-compute a numeric flag in the
passive-modifier-engine and read it off `payload`) — don't assume a
reaction-side identifier is available.

### Worked example — Magical Artillery (declarative)

The Elementalist skill *Magical Artillery*: "+SL×2 to your Magic Check
when you cast an Offensive Spell while an arcane weapon is equipped."

```jsonc
"system.props.passive_check_bonus_formula": "HAS_ARCANE_WEAPON * ACTION_IS_SPELL * SL * 2"
```

The two 0/1 gates multiply to 0 (inert) unless BOTH hold; `ACTION_IS_SPELL`
keeps it off basic attacks (which is also why offensive spells — the only
spells that roll a Magic Check — are the effective scope).

### Worked example — Adversity (declarative)

The Darkblade Heroic Skill *Adversity* (Jan 2025 playtest revision):
"+1 bonus on all Checks per status effect (cap +3), +2 damage per
status (cap +6)."

```jsonc
"system.props.passive_check_bonus_formula":  "min(STATUS_COUNT, 3)",
"system.props.passive_damage_bonus_formula": "min(STATUS_COUNT * 2, 6)"
```

No reaction_config_table, no scripts, no AEs. The engine reads both
formulas on every action and adds the results to check/damage. The
formulas resolve to 0 when no statuses are present, so the skill is
inert until at least one debuff lands on the owner.

**Coverage caveat:** these fields apply inside the action pipeline
(attack accuracy + damage). Open Checks performed outside the pipeline
(Study, Insight, opposed skill checks narrated by the GM) won't pick up
the bonus today — that's a pipeline scope question, not a skill-data
question.

### Worked example — Drain Spirit (declarative)

```jsonc
"system.props.post_damage_effect_ref": "drain_recover",
"system.props.effect_table": {
  "0": {
    "effect_label": "drain_recover",
    "effect_kind":  "grant",
    "grant_resource": "mp",
    "grant_amount":   "MP_DEALT / 2",
    "grant_target":   "self"
  }
}
```

Flow: Hina casts Drain Spirit → Create Damage Card resolves the MP burn
on the target → post_damage hook fires `drain_recover` on Hina with
`payload.finalValue` = MP loss inflicted and `payload.valueType = "mp"` →
`MP_DEALT / 2` evaluates to half the loss → Hina's MP grant applied.

No reaction config. Per-target semantics correct out of the box (Create
Damage Card emits per-target, so the hook fires per-target).

---

## `reaction_config_table` — trigger row fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `reaction_trigger` | string (canonical trigger key, see list below) | yes | What event the row listens for. |
| `reaction_source` | `"self" \| "ally" \| "enemy" \| "neutral" \| "all"` | when trigger has a subject | Whose actions/events to listen to, relative to the reactor. Hidden in the UI for global lifecycle triggers (conflict/round). |
| `reaction_damage_source` | `"" \| "self" \| "ally" \| "enemy" \| "neutral" \| "all"` | no | Universal filter. Matches the *acting creature's* disposition relative to the reactor — orthogonal to `reaction_source` (which matches the *subject*). For `creature_takes_damage` etc. where subject = target, this filters who *caused* the event (attacker / applier / healer). Available on any trigger that declares a `damageSourceFrom` shape (action-derived events, damage triggers, status / heal triggers). Blank disables. Active filter on a trigger without a source side fails-closed. |
| `reaction_damage_type` | `"physical" \| "air" \| "bolt" \| "dark" \| "earth" \| "fire" \| "ice" \| "light" \| "poison"` | when trigger has `damage_type` filter | Filter to a specific element. Blank = match any. |
| `reaction_damage_amount` | number (≥0) | when trigger has `damage_amount` filter | Minimum damage amount to match. Blank = match any. |
| `reaction_debuff_count_target` | `"self" \| "ally" \| "enemy" \| "all" \| ""` | when trigger has `debuff_count` filter | Whose tokens to scan for debuffs. Blank disables the filter. |
| `reaction_debuff_count_min` | number (≥0) | when trigger has `debuff_count` filter | Minimum total debuffs across the chosen group. Blank disables the filter. |
| `reaction_subject_kind` | string (a `system.props.*` boolean flag, e.g. `"isPhantasm"`) | no | Subject-creature kind filter. When non-blank, the subject's `actor.system.props[<value>]` must be truthy. Available on any trigger whose subject is a creature (i.e. `subjectFrom !== null`). Blank disables the filter. |
| `reaction_ownership` | `"" \| "own_summon"` | no | Subject/reactor relationship filter. `own_summon` requires the subject token's `flags["fabula-ultima-companion"].summonedBy` to equal the reactor's actor UUID — i.e. "I summoned this creature." Available on any trigger with a creature subject. Blank disables the filter. |
| `reaction_action_intent` | `"" \| "harmful" \| "aid" \| "neutral"` | no | Action-intent filter. `harmful` matches only when ADC classifies the triggering action as harmful (attack, offensive spell, damage source) — the gate Protect / Cover / Counterattack need so they don't fire on an ally's buff/heal. `aid` matches heals / buff spells / utility actives. `neutral` matches Passive / Item / Other. Blank disables the filter. Lifecycle phase payloads (turn_start, round_end, etc.) carry no `actionIntent`, so a row with this filter active against such a payload fails-closed (no match). |
| `reaction_bond_presence` | `"" \| "present" \| "absent"` | no | Bond gate against the trigger's subject creature. `present` matches when at least one of the reactor's `bond_N` slots (1–6 + `bond_temp`) holds a name equal to a subject's `actor.name` or `token.name` (case-insensitive). `absent` is the inverse — "no bond toward any subject." Blank disables the filter. Available on any trigger with a creature subject; inert on lifecycle triggers. |
| `reaction_bond_emotion` | `"" \| "admiration" \| "inferiority" \| "loyalty" \| "mistrust" \| "affection" \| "hatred"` | no | Specific-emotion filter on the Bond toward the subject. Maps to the three RAW pairings (Admiration/Inferiority, Loyalty/Mistrust, Affection/Hatred) stored on the actor as `emotion_N_1` / `emotion_N_2` / `emotion_N_3` respectively. Implies presence (the matched Bond must exist) and is checked case-insensitively. Blank disables. |
| `reaction_effect_ref` | string (an `effect_label` from `effect_table`) | no | Pick a declarative effect to fire on match. Blank = no declarative effect (the row still surfaces the skill in the reaction picker; chosen-skill execution proceeds normally). |
| `reaction_isPassive` | ~~boolean~~ | **RETIRED 2026-06-07** | Removed. Every row's behavior now comes from `reaction_passive_mode` alone (see next row). The former "manual" reaction (a RAW "may" the player clicks) is simply `reaction_passive_mode: "ask"` — the engine default. Migration `2026-06-07-retire-reaction-ispassive` converts all data + strips the field + the template column. |
| `reaction_passive_target` | `"self"` | when mode is `on`/`force` | Where an auto-fired reaction applies its effect. Currently only `"self"` is implemented. For `ask` rows the player picks via the menu, so this is unused. |
| `reaction_passive_mode` | `"on" \| "ask" \| "off" \| "force"` | no (default `ask`) | **THE single firing-mode field.** `ask` = player decides via a clickable pill / menu blade (RAW "may" wording — this is the former `reaction_isPassive: false` "manual" behavior). `on` = auto-fire on match, visible to player (Auto chip in menu / pill). `off` = disabled (toggle-off for intrusive passives). `force` = engine-mandatory auto-fire, UI-invisible (no pill, no menu blade, no Passive Manager toggle). Use `force` for system housekeeping like Protect's charge-refresh; `on` for player-facing auto passives like Healing Power; `ask` for elective "may" reactions like Protect / Crossfire / Hawkeye. Default `ask`. Every dispatch surface (action-card CONFIRM/PRE_ROLL pills + post-resolve token menu) shows every non-`off` row for the trigger — there is no longer an `includeManual` filter. |
| `reaction_action_target` | `"" \| "ally" \| "enemy" \| "neutral"` | no | Action-target disposition filter. Fires only when the subject's action targeted at least one creature with the given disposition relative to the reactor. Used by passives like Healing Power that should only fire when an ally was targeted. Blank disables. Available on triggers whose subject performs an action (`creature_performs_action`, `creature_completes_spell`, `creature_deals_damage`, etc.). |
| `condition_formula` | formula string | no | Universal gate. When non-blank, the trigger matcher evaluates this via `window["oni.ReactionFormula"].evaluate` and only fires the row when the result is truthy. The grammar supports arithmetic (`+ - * /`), modulo (`%`), comparison (`== != < > <= >=`), and logical operators (`&& || !`). Identifier list under [Formula identifiers](#formula-identifiers-resolved-against-the-reactor--trigger-payload) — `ROUND` and `ACTION_TARGET_COUNT` are common gates. Blank disables. Example: `"ROUND % 2 == 0"` (only even rounds); `"ACTION_TARGET_COUNT >= 2"` (only multi-target dangers); `"HAS_ARCANE_WEAPON"` (Spiritist arcane-weapon gate). |
| `requires_skill` | string (skill master `uniqueId`) | no | Prerequisite-skill gate. When non-blank, the reactor's actor must own an item whose `system.uniqueId` equals this value (i.e. has learned the named skill master). Use the master's `uniqueId`, not the actor-copy id. Blank disables. Example: Hina's Prophetic Defender Style gates its even-round PP gain on `BmgIHS4DdDAT1rUc` (Divination's master uniqueId) so the gain only fires when she actually knows Divination. |

### Canonical trigger keys

31 triggers, grouped by phase bucket. The bucket determines when the
reaction window opens/closes. Reactions in the same bucket coexist in a
single merged window (e.g. damage + crisis + defeat all stay available
in `resolution_phase`).

| Bucket | Trigger keys |
|--------|--------------|
| `conflict_start` | `conflict_start` |
| `conflict_end` | `conflict_end` |
| `round_start` | `round_start` |
| `round_end` | `round_end` |
| `turn_start` | `turn_start` |
| `turn_end` | `turn_end` |
| `action_phase` | `creature_performs_check`, `creature_performs_action`, `creature_targeted_by_action`, `creature_fumbles_check`, `creature_check_outcome_flipped` |
| `resolution_phase` | `creature_hit_by_action`, `creature_critical_hit`, `creature_miss_action`, `creature_deals_damage`, `creature_takes_damage`, `creature_takes_vulnerable_damage`, `creature_takes_weak_damage`, `creature_resists_damage`, `creature_absorbs_damage`, `creature_immune_damage`, `creature_shield_break`, `creature_recovers_hp`, `creature_lose_mp`, `creature_recovers_mp`, `creature_status_applied`, `creature_enter_crisis`, `creature_exit_crisis`, `creature_defeated`, `creature_unleashes_zero_power`, `creature_completes_spell` |

`creature_completes_spell` fires from the director's Skill RESOLVE
handler after a Spell-typed action finishes resolving on its targets.
Subject = performer (the caster); payload carries `targetTokenUuids` so
`reaction_action_target` can filter "spell hit at least one ally" etc.
Used by Spiritist's Healing Power and Support Magic.

### Subject + filter matrix

This table determines which row fields are *relevant* for a given
trigger. UI hides irrelevant fields via `visibilityFormula`, but you can
write them in JSON regardless — they just won't be evaluated.

| Trigger key | Subject side | `source` filter | `damage_type` | `damage_amount` | `debuff_count` |
|---|---|---|---|---|---|
| `conflict_start` | — | — | — | — | — |
| `round_start` | — | — | — | — | yes |
| `round_end` | — | — | — | — | yes |
| `turn_start` | turn actor | yes | — | — | yes |
| `turn_end` | turn actor | yes | — | — | yes |
| `creature_performs_check` | performer | yes | — | — | — |
| `creature_performs_action` | performer | yes | — | — | — |
| `creature_targeted_by_action` | target | yes | yes | — | — |
| `creature_fumbles_check` | performer | yes | — | — | — |
| `creature_check_outcome_flipped` | performer | yes | — | — | — |
| `creature_hit_by_action` | target | yes | yes | — | — |
| `creature_critical_hit` | damage source | yes | — | — | — |
| `creature_miss_action` | damage source | yes | — | — | — |
| `creature_will_deal_damage` | damage source | yes | yes | yes | pre-resolve (fires per hit target during CONFIRM, BEFORE affinity is applied; reactions can modify rawDamage via `effect_kind: "add_damage"` and RESOLVE recomputes the post-affinity value) |
| `creature_deals_damage` | damage source | yes | yes | yes | post-resolve (fires per-target AFTER damage commits — for Drain-Spirit-style grants that react to damage already dealt) |
| `creature_takes_damage` | target | yes | yes | yes | — |
| `creature_takes_vulnerable_damage` | target | yes | yes | — | — |
| `creature_takes_weak_damage` | target | yes | yes | — | — |
| `creature_resists_damage` | target | yes | yes | — | — |
| `creature_absorbs_damage` | target | yes | yes | — | — |
| `creature_immune_damage` | target | yes | yes | — | — |
| `creature_shield_break` | target | yes | yes | — | — |
| `creature_recovers_hp` | target | yes | — | — | — |
| `creature_lose_mp` | target | yes | — | — | — |
| `creature_recovers_mp` | target | yes | — | — | — |
| `creature_status_applied` | target | yes | — | — | yes |
| `creature_enter_crisis` | state-changed | yes | — | — | — |
| `creature_exit_crisis` | state-changed | yes | — | — | — |
| `creature_defeated` | state-changed | yes | — | — | — |
| `creature_unleashes_zero_power` | performer | yes | — | — | — |
| `creature_completes_spell` | performer | yes | — | — | — |

(The `_Skill Template`'s dropdown options list may be one or two
triggers behind the runtime — e.g. `creature_unleashes_zero_power` was
added later. New triggers work correctly at runtime; just type the key
directly if it's missing from the dropdown.)

`reaction_action_target` is universal across triggers whose subject
performs an action (`creature_performs_action`, `creature_completes_spell`,
`creature_deals_damage`, etc.), filtering on the *targets* of that
action by disposition vs the reactor.

**`reaction_subject_kind`, `reaction_ownership`, `reaction_action_intent`,
`reaction_bond_presence`, and `reaction_bond_emotion` are universal across
all subject-bearing triggers** (any trigger whose Subject side is not `—`),
so they're omitted from the matrix above. The runtime matchers self-skip
when the trigger has no per-creature subject, so authoring them on
`conflict_start` / `round_start` / `round_end` is a no-op (the rows still
match). `reaction_action_intent` additionally requires the phase payload
to carry an `actionIntent` field (set by ADC for action-driven triggers,
not for lifecycle triggers) — when the field is absent and the filter is
set, the row fails-closed.

### Bond data shape (on character actors)

The bond filters read from the actor's Traits & Bonds tab fields:

| Field | Type | Notes |
|---|---|---|
| `system.props.bond_N` | string | Target's name. `N ∈ {1..6, "temp"}`. Blank = slot unused. |
| `system.props.emotion_N_1` | `"" \| "admiration" \| "inferiority"` | Pair 1. |
| `system.props.emotion_N_2` | `"" \| "loyalty" \| "mistrust"` | Pair 2. |
| `system.props.emotion_N_3` | `"" \| "affection" \| "hatred"` | Pair 3. |

Per RAW (Core p. 56), each Bond may hold up to three emotions, one per
pairing. Strength = count of non-empty emotion fields on the slot (0–3).
Comparison is case-insensitive — older worlds may have capitalized values
on bond slot 1 due to template drift.

### `actionIntent` inference (ADC)

`meta.actionIntent` is populated by ActionDataComputation and emitted on every
action-driven reaction-phase payload (`creature_performs_action`,
`creature_targeted_by_action`, `creature_hit_by_action`, damage / heal /
status triggers from Create Damage Card, etc.).

Priority order (first match wins):

1. Explicit author override: `props.action_intent` on the skill item
   (`"harmful" | "aid" | "neutral"`, blank = auto).
2. Weapon attacks → `"harmful"`.
3. `skill_type === "Attack"` → `"harmful"`.
4. `isOffensiveSpell` → `"harmful"`.
5. `declaresHealing` (HP or MP recovery) → `"aid"`.
6. `hasDamageSection && !declaresHealing` (covers MP burn) → `"harmful"`.
7. `skill_type === "Spell"` (non-offensive) → `"aid"`.
8. `skill_type === "Active"` without damage → `"aid"` (buffs / utility actives).
9. Otherwise (`Passive` / `Item` / `Other`) → `"neutral"`.

"neutral" deliberately fails the harmful and aid filters — reactions opt-in by
declaring intent. Authors of edge-case skills can pin the classification via
the `action_intent` prop override.

### `reaction_source` semantics (relative to the reactor)

| Value | Match condition |
|-------|-----------------|
| `self` | Subject is the reactor itself. |
| `ally` | Subject is on the reactor's disposition side (incl. reactor). |
| `enemy` | Subject is on the opposite disposition. |
| `neutral` | Subject has disposition 0 (treated as Neutral; -2 / Secret normalizes to 0). |
| `all` | Any subject. |

#### `creature_performs_action` — `reaction_source` is the *scope* knob

`reaction_source` answers **"whose action do I react to?"** for this trigger, and
that choice selects which dispatch the row participates in:

| Value | Behaviour | Example |
|-------|-----------|---------|
| `self` *(default)* | **Self-rider** — fires only on the reactor's OWN action. A row with **no source set behaves as `self`** (the trigger's default), so picking `creature_performs_action` and touching nothing else gives the common, least-surprising case. | Magical Artillery, Adversity, Cognitive Focus |
| `ally` / `enemy` | **Observer (scoped)** — fires when an ally / enemy performs, never the reactor. | (defensive "when an enemy acts" reactions) |
| `all` | **Observer (any)** — fires for the reactor's own action AND any other creature's. | Divination ("force any creature you can see to reroll") |

The reactor's own action is dispatched by the performer-side scan; **other**
creatures' actions reach `ally`/`enemy`/`all` rows via the *observer scan*, which
stamps `reactorActorUuid` = the bystander so card-mutation effects (e.g.
`force_reroll`) act on the performer while costs come from the reactor. `self`
rows never appear in the observer scan (subject ≠ reactor), so self-riders cannot
double-fire. A row with no `reaction_effect_ref` (nothing to do) never surfaces.

---

## `effect_table` — effect row fields

(Legacy name: `reaction_effect_table`. Runtime reads either.)

Common to every row:

| Field | Type | Notes |
|-------|------|-------|
| `effect_label` | string | Unique identifier; trigger rows reference this in their `reaction_effect_ref` column. Other effect rows reference it via `target_ref` / `destination_ref` / `chain_steps`. Must be non-blank for the row to be findable. |
| `effect_kind` | `"targeting" \| "grant" \| "apply_ae" \| "consume_charge" \| "consume_resource" \| "redirect_target" \| "adjust_damage" \| "adjust_accuracy" \| "chain" \| "modify_damage_taken"` | Default: `"grant"`. Dispatches to the matching handler. |

Per-kind fields below. Fields irrelevant to the chosen kind are hidden
in the UI but harmless in JSON.

**Targeting is a separate effect_kind.** Every effect that needs to act
on specific tokens (grant, apply_ae, consume_charge, open_action_menu,
redirect_target) reads its target list via `target_ref` — a string
pointing to an `effect_label` of a `targeting` row in the same
`effect_table`. There are no legacy per-kind targeting fields
(`grant_target`, `target_lock`) — those have been removed. See
[`effect_kind: "targeting"`](#effect_kind-targeting--produce-a-named-token-list).

---

### `effect_kind: "targeting"` — produce a named token list

The single source of truth for *who* downstream effects act on. A
targeting row resolves to a list of `TokenDocument` UUIDs, named by its
`effect_label`, that other rows reference via `target_ref` /
`destination_ref`.

Built on top of [`JRPGTargeting.requestTargeting`](#integration-with-jrpg-targeting),
so the picker UX, socket routing, canvas highlight, and passive
auto-skip plumbing all apply uniformly.

```jsonc
{
  "effect_label":   "pick_attacker",
  "effect_kind":    "targeting",
  "candidate_source": "trigger_actor",
  "category":         "",                  // disposition filter; blank = any
  "mode":             "exact",
  "count":            1,
  "auto_confirm_when_obvious": true,
  "skip_when_passive":         true,
  "iteration_mode":            "together",
  "exclude_self":              false
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `candidate_source` | enum | `"combat"` | Pre-filters the pool to a subset of combat. See table below. |
| `category` | `"" \| "creature" \| "ally" \| "enemy"` | `""` (any) | Disposition filter applied after `candidate_source`. `ally` matches friendly (incl. reactor) + neutral. `enemy` matches hostile + neutral. `creature` matches all. Blank skips. |
| `exclude_self` | bool | `false` | When `true`, the reactor's own token is removed from the candidate pool *after* category filtering. Useful for Protect-style skills where the reactor steps in for an ally — picking yourself would be a no-op redirect. |
| `mode` | `"exact" \| "up_to" \| "all"` | `"exact"` | How many tokens to take. `exact` = pick `count`. `up_to` = pick 0..`count`. `all` = take every eligible candidate, no picker. |
| `count` | integer | `1` | Required for `exact`/`up_to`; ignored for `all`. |
| `auto_confirm_when_obvious` | bool | `true` | If the filtered pool has exactly one eligible token, skip the picker — the resolved target is used without a prompt. |
| `skip_when_passive` | bool | `true` | When the effect chain runs in a passive context (`ctx.isPassive`), apply to the entire eligible pool with no picker. Mirrors the existing [passive-targeting-auto-skip](../scripts/reaction-system/reaction-buttonUI.js) policy. |
| `iteration_mode` | `"together" \| "per_token"` | `"together"` | How consumers receive the resolved list. `together` (default, matches RAW for multi-target Fabula Ultima spells/attacks) passes the full list to each consumer in one invocation. `per_token` re-invokes each consumer once per token. |

#### `candidate_source` values

| Value | Resolves to | Where it reads from |
|---|---|---|
| `combat` | Every combatant in the current encounter. | `game.combat.combatants[].token` |
| `trigger_subject` | The creature the trigger is *about* (target of damage, performer of action, defeated creature). | Trigger registry's `subjectFrom(triggerKey)` against `phasePayload`. |
| `trigger_actor` | The acting creature on the source side (attacker, applier, healer). | Trigger registry's `damageSourceFrom(triggerKey)` against `phasePayload`. |
| `action_targets` | The originating action card's full target list. | `phasePayload.targets[]` / `targetUuid`. |
| `self` | Reactor only. | `ctx.actor` / `ctx.token`. |

#### Resolution flow

A targeting row evaluates **lazily** — only when first demanded by a
consumer's `target_ref` — and the result is **memoized** per chain
execution (so multiple consumers referencing the same row see the same
tokens).

1. **Build candidate pool** from `candidate_source` (consulting trigger payload + combat state).
2. **Apply `category` filter** to the pool (disposition relative to reactor).
3. **Apply `exclude_self` filter** to the pool (drops the reactor's own token if set).
4. If pool is empty → effect chain aborts with `ok: false, reason: "no_candidates"`.
5. If `skip_when_passive` AND `ctx.isPassive` → apply to entire pool, no picker.
6. If `auto_confirm_when_obvious` AND pool has 1 element → use that token, no picker.
7. If `mode: "all"` → use entire pool, no picker.
8. Otherwise → call `JRPGTargeting.requestTargeting` with the pool as `allowedTargetTokenUuids` and `parsedTargeting` built from `{mode, category, count}`.
9. Resolved token list is stored under the row's `effect_label` in the chain's `resolvedTargets` map.

#### Integration with JRPG Targeting

The targeting kind is a thin wrapper over [`JRPGTargeting.requestTargeting`](../scripts/jrpg-targeting-system/). Mapping:

| Targeting field | JRPG `parsedTargeting` |
|---|---|
| `mode: "exact"` | `mode: EXACT` + `count` |
| `mode: "up_to"` | `mode: UP_TO` + `count` (`minTargets: 0`) |
| `mode: "all"` | `mode: ALL` (`autoSelectAll: true`) |
| `category: "ally"` / `"enemy"` / `"creature"` | `category: ally/enemy/creature` |
| `category: ""` | `category: creature` (any disposition) |

The filtered candidate pool is passed as `allowedTargetTokenUuids`, so JRPG's existing legality matrix, canvas highlight, and player-side socket routing all work unchanged.

#### Consuming a targeting row — `target_ref`

Every non-targeting effect_kind that operates on tokens carries a
`target_ref` field:

| Field | Type | Notes |
|---|---|---|
| `target_ref` | string | The `effect_label` of a `targeting` row in this same `effect_table`. Required for effect kinds that act on tokens (`grant`, `apply_ae`, `consume_charge`, `open_action_menu`, `redirect_target`). The dispatcher auto-resolves the referenced targeting row lazily and memoizes the result for the rest of the chain. |

For `effect_kind: "redirect_target"` there's an additional
`destination_ref` (same shape, points to a targeting row that names
*where* the redirected action lands).

#### Translating from the old per-kind fields

For migration / spec-author reference, here's how the removed legacy
fields map to targeting rows:

| Old form | Replacement targeting row |
|---|---|
| `grant_target: "self"` | `{ candidate_source: "self" }` |
| `grant_target: "ally"` | `{ candidate_source: "combat", category: "ally", mode: "all" }` |
| `grant_target: "enemy"` | `{ candidate_source: "combat", category: "enemy", mode: "all" }` |
| `grant_target: "all"` | `{ candidate_source: "combat", category: "creature", mode: "all" }` |
| `target_lock: "damage_source"` | `{ candidate_source: "trigger_actor", mode: "exact", count: 1 }` |
| `target_lock: "subject"` | `{ candidate_source: "trigger_subject", mode: "exact", count: 1 }` |
| `redirect_target` implicit "to reactor" | a `targeting` row with `{ candidate_source: "self" }` plus `destination_ref` pointing to it |

---

### `effect_kind: "grant"` — grant or drain a resource

| Field | Type | Notes |
|-------|------|-------|
| `grant_resource` | `"hp" \| "mp" \| "ip" \| "zero_power" \| "zenit" \| "enmity"` | Required. Blank = effect disabled. |
| `grant_amount` | number OR formula string | Positive grants; negative drains. Blank or 0 = effect disabled. **Formulas are supported** — see "Formula identifiers" below. |
| `target_ref` | string (`effect_label`) | Required. References a [`targeting`](#effect_kind-targeting--produce-a-named-token-list) row in this `effect_table`. Recipient(s) of the grant. |

Resource caps: `hp/mp/ip` clamp to actor's `max_*`; `zero_power` clamps
to [0, 6]; `zenit/enmity` are uncapped. Floor is always 0.

#### Formula identifiers (resolved against the reactor + trigger payload)

`grant_amount` (and `condition_formula` on trigger rows) accepts a literal
number (`"10"`) OR a safe expression with whitelisted identifiers and
functions. Evaluated by `window["oni.ReactionFormula"]`. No `eval` / `new
Function`.

Operators: `+` `-` `*` `/` `%`, comparison `== != < > <= >=`, logical
`&& || !`, unary `-` / `+` / `!`, parentheses. Booleans are represented
as `1` / `0`; truthy = nonzero.
Functions: `floor`, `ceil`, `round`, `abs`, `min`, `max`.

Identifiers (all return 0 if unresolvable):

| Name | Resolves to |
|---|---|
| `SL` | Firing skill/AE's level. |
| `MAX_HP` / `CUR_HP` | Reactor's HP. |
| `MAX_MP` / `CUR_MP` | Reactor's MP. |
| `MAX_IP` / `CUR_IP` | Reactor's IP. |
| `BOND_STRENGTH` | Strength (0–3) of reactor's Bond toward the trigger subject. |
| `BOND_COUNT` | Total non-empty bond slots on the reactor. |
| `BOND_COUNT_<EMOTION>` | Count of reactor's bonds with that emotion. `<EMOTION>` is one of `ADMIRATION`, `INFERIORITY`, `LOYALTY`, `MISTRUST`, `AFFECTION`, `HATRED`. |
| `STATUS_COUNT` | Count of debuff-classified active effects on the reactor (non-disabled, non-suppressed). Uses the AEM registry's `inferCategory()` classifier — same source of truth as the reaction `debuff_count` filter. |
| `DAMAGE_DEALT` | The triggering damage-card event's `finalValue` (post-affinity), regardless of resource type. Set by Create Damage Card emits — works for `creature_takes_damage`, `creature_deals_damage`, `creature_lose_mp`, etc. |
| `HP_DEALT` / `MP_DEALT` / `SHIELD_DEALT` | Same value but returns 0 unless the event's `valueType` matches. |
| `ROUND` | Current combat round number (1-indexed). 0 outside combat. Used by `condition_formula` gates like `"ROUND % 2 == 0"` (even rounds only). |
| `ACTION_TARGET_COUNT` | `payload.targets.length` — how many tokens the triggering action targets. 0 when the payload carries no target list (lifecycle triggers). Used by gates like `"ACTION_TARGET_COUNT >= 2"` for multi-target-only reactions. |
| `HIT_COUNT` | `payload.hitTargets.length` — how many targets passed the Check. Threaded onto chainPayload by the Skill RESOLVE path (state-handlers.js), so it's available to `on_activate_effect_ref` chains for gating "fire only on hit" effects. 0 when no roll info was threaded (no-Check skill / passive grant). Example: Soul Steal's IP grant uses `condition_formula: "HIT_COUNT > 0"` to skip on miss. |
| `SINGLE_TARGET_ATTACK` | 1 if `payload.targets.length === 1`, else 0. Boolean alias that reads cleaner in gates than `ACTION_TARGET_COUNT == 1`. Used by Cheap Shot's "only fires on single-target attacks" gate. |
| `TARGET_STATUS_COUNT` | Status (debuff) count on the trigger's **subject** creature (the target of the action that fired the trigger), not the reactor. Reads `payload.subjectActorUuid` — populated by per-target firing sites (e.g. `creature_will_deal_damage`). Falls back to 0 if no subject is in the payload. Used by Cheap Shot's "+1 per status on target" damage scaling. |
| `HAS_ARCANE_WEAPON` / `HAS_MELEE_WEAPON` / `HAS_RANGED_WEAPON` | **LOADOUT gate.** 1 if the reactor has at least one *equipped* weapon (`isEquipped`) whose type matches, else 0. Reads the item `isEquipped` flag — NOT the weapon being used for the current attack. Use for "do I have an X weapon on me" (Spiritist's arcane-weapon gate). For "is the attack I'm performing an X attack", use `ATTACK_IS_*` below instead — see the caveat. |
| `ATTACK_IS_RANGED` / `ATTACK_IS_MELEE` / `ATTACK_IS_ARCANE` | **ACTIVE-ATTACK gate.** 1 if the in-flight action's weapon is of that kind, else 0. `_RANGED`/`_MELEE` read the attack weapon's **range** (`payload.weaponRange`, threaded by the attack pipeline onto the pre-roll, `creature_will_deal_damage`, `creature_deals_damage`, and `creature_targeted_by_action` payloads); `_ARCANE` reads the weapon family. Use for reactions whose RAW says "when you perform a ranged/melee attack" (Barrage, Warning Shot, Hawkeye) or "after a creature performs a ranged attack" (Crossfire). 0 when no weapon action is in flight, so a `== 1` gate fails closed. |
| `ATTACK_CHECK_RESULT` | The in-flight attack's **Accuracy Check total Result** (post-roll). Threaded onto the `creature_targeted_by_action` payload at CONFIRM, so a post-roll bystander reaction can scale by it. Crossfire spends MP equal to it. 0 when no roll info is in the payload. |
| `ATTACK_IS_CRIT` / `ATTACK_IS_FUMBLE` | 1 if the in-flight attack's Accuracy Check was a critical success / a fumble, else 0. Used as a gate — Crossfire "has no effect if the Accuracy Check was a critical success" → `ATTACK_IS_CRIT == 0`. 0 when no roll info is threaded, so a `== 0` gate passes by default. |
| `HAS_SHIELD` | **LOADOUT gate.** 1 if the reactor has any equipped (`isEquipped`) item with `item_type === "shield"`, else 0. |
| `HAS_MARTIAL_ARMOR` | **LOADOUT gate.** 1 if the reactor has any equipped (`isEquipped`) item with `item_type === "armor"` AND `isMartial: true`, else 0. Paired with `HAS_SHIELD` for Dodge's RAW gate (`"!HAS_SHIELD && !HAS_MARTIAL_ARMOR"`). |
| `HAS_SKILL_<NAME>` | 1 if the reactor owns a skill item whose `name` matches `<NAME>` (case-insensitive), else 0. The skill name is baked into the identifier: spaces become underscores, case is uppercased. Examples: `HAS_SKILL_PILLAGE` (Pillage), `HAS_SKILL_SOUL_STEAL` (Soul Steal), `HAS_SKILL_HEART_OF_DARKNESS` (Heart of Darkness). Used for cross-skill requirement gates (Pillage modifies Soul Steal; Fleeting Moment modifies Counterattack; etc.). The tokenizer doesn't support string literals, so the dynamic-identifier shape is the workaround. |

> **Loadout vs active-attack gates — pick the right one.** `HAS_*_WEAPON` /
> `HAS_SHIELD` / `HAS_MARTIAL_ARMOR` ask "what's in my loadout" via the per-item
> `isEquipped` flag. `ATTACK_IS_*` asks "what am I attacking WITH" via the action
> payload. A reaction whose RAW says *"when you perform a ranged attack"* wants
> **`ATTACK_IS_RANGED`**, not `HAS_RANGED_WEAPON` — because the two can disagree:
> a BD attack reads its weapon from the actor's `main_hand` SLOT prop, while
> `isEquipped` is a separate boolean. They desync whenever equip state is mutated
> outside `applyEquipmentSwap` (cloning an actor, bulk item add, raw writes,
> migrations), so a weapon can be the one you're attacking with while its
> `isEquipped` is `false`. Gating such a reaction on `HAS_RANGED_WEAPON` then
> wrongly suppresses it. (`equipment-swap.reconcileEquip(actor)` repairs the
> desync by driving `isEquipped` from the slots; the Test Battle dev tool runs it
> on generated actors.)

Per-target semantics: damage triggers fire once per affected target, so a
grant that uses `DAMAGE_DEALT` also fires once per target — cumulatively
correct for drain-style effects ("recover an amount equal to half the
damage you dealt"). `DAMAGE_DEALT_TOTAL` / `HP_DEALT_TOTAL` etc. are
aliases for the per-event reads.

Examples:

```text
grant_amount: "SL * 2"           // Agony — recover 10 at SL 5
grant_amount: "MP_DEALT / 2"     // Drain Spirit — half the MP burned
grant_amount: "BOND_STRENGTH"    // recover equal to bond strength toward target
grant_amount: "floor(CUR_HP / 4)"  // self-sacrifice scaling
```

### `effect_kind: "apply_ae"` — apply an Active Effect

| Field | Type | Notes |
|-------|------|-------|
| `ae_template_ref` | string | An effect identifier — registry id, an `Item.x.ActiveEffect.y` UUID, or a name registered in the AEM. Forwarded to `FUCompanion.api.activeEffectManager.applyEffects` as-is. |
| `target_ref` | string (`effect_label`) | Required. References a [`targeting`](#effect_kind-targeting--produce-a-named-token-list) row. Recipient(s) of the AE. |
| `ae_duplicate_mode` | `"skip" \| "replace" \| "stack" \| "remove" \| "ask"` | Default `"replace"`. How to handle when the target already has the AE. |

The AE itself must exist somewhere the AEM can resolve (on a skill item
or registered globally). Inline AE JSON authoring was removed — keep the
single source of truth in the AE document.

### `effect_kind: "consume_charge"` — gate-and-consume one charged AE

| Field | Type | Notes |
|-------|------|-------|
| `charge_key` | string | The `chargeKey` to find on the target actor. |
| `target_ref` | string (`effect_label`) | Required. References a [`targeting`](#effect_kind-targeting--produce-a-named-token-list) row. Actor(s) whose charge is consumed (typically a row with `candidate_source: "self"`). |
| `on_empty` | `"abort" \| "skip"` | Default `"abort"`. With `abort`, an empty charge cancels the chain *and* signals callers to skip the skill body. |
| `count` | number | Charges to consume per target. Default 1. |

Returns `abort: true` when nothing could be consumed and `on_empty:
"abort"`. The manual-reaction dispatcher and autoPassive runner both
respect this — the skill body never runs.

### `effect_kind: "consume_resource"` — gate-and-deduct a resource

Generalizes `consume_charge` to actor resources (HP / MP / IP / Zenit /
etc.). Validates that each target's current resource is `>= amount`
before deducting; on insufficient resource and `on_empty: "abort"`,
returns abort and the chain stops.

| Field | Type | Notes |
|-------|------|-------|
| `grant_resource` | `"hp" \| "mp" \| "ip" \| "zero_power" \| "zenit" \| "enmity"` | Required. Which resource to spend. |
| `grant_amount` | number OR formula string | Amount to deduct per target. Same formula grammar as `grant`. |
| `target_ref` | string (`effect_label`) | Required. References a [`targeting`](#effect_kind-targeting--produce-a-named-token-list) row. Actor(s) paying the cost (typically a row with `candidate_source: "self"`). |
| `on_empty` | `"abort" \| "skip"` | Default `"abort"`. What to do when at least one target's current resource < amount. `abort` cancels the chain *and* signals the skill body to skip. |

Use this as the "spend N MP" gate at the END of a chain so it only
fires when prior steps (e.g. `redirect_target` for Protect, or
`open_action_menu` for High Speed) actually committed. Placing it
first means a cancellation in a later step still costs the resource.

### `effect_kind: "redirect_target"` — rewrite the pending action card's target

Action-mutation verb. Wraps `oni.ReactionRedirectPendingAction` so
authors don't write JS for "intercept the incoming attack and aim it at
me instead" (Protect, Cover, Bodyguard).

This kind reads **two** targeting references:

- `target_ref` — *which* target slot of the originating action card gets moved (the "source slot"). For classic Protect, this references a row with `candidate_source: "action_targets", mode: "exact", count: 1`.
- `destination_ref` — *where* it lands. For Protect, references a row with `candidate_source: "self"`. For Cover, references a row picking an ally.

| Field | Type | Notes |
|-------|------|-------|
| `target_ref` | string (`effect_label`) | Required. References the [`targeting`](#effect_kind-targeting--produce-a-named-token-list) row that resolves the source slot to redirect. |
| `destination_ref` | string (`effect_label`) | Required. References the targeting row that resolves the destination. |
| `rebuild_card` | boolean | Default `true`. Re-render the redirected card so viewers see the new target. |

Returns `{ ok: true, skipBody: true }` on success (NOT `abort: true`).
`skipBody` suppresses the reactor's skill body (no Protect card posts
on top of the redirected card) while letting the rest of the effect
chain continue — so a downstream `consume_charge` / `consume_resource`
step runs only when the redirect actually went through. Place such
cost-deducting steps AFTER the redirect in the chain.

### `effect_kind: "open_action_menu"` — spawn the action menu with a filter

Two modes:
- **Option menu** (`menu_option_refs` set): prompts the player to choose one (or
  `menu_pick_count`) option(s); each chosen option's referenced row is dispatched.
  Warning Shot, Reinforce, Hawkeye, etc. **All option display text lives on THIS
  row** (see below) — the referenced option rows hold only their mechanical data.
- **Free-action mode** (`free_mode: true`): spawns the TurnUI command buttons over
  the reactor's token with only `allowed_types` enabled + registers a free-action
  grant. Acceleration, Painful Lesson.

#### Option-menu fields (the menu row owns all the text)

| Field | Type | Notes |
|-------|------|-------|
| `menu_title` | string | Prompt title (default `"Choose an option"`). |
| `menu_subtitle` | string | Prompt subtitle / instruction line. |
| `menu_option_refs` | string | **Comma**-separated `effect_label`s — which option rows this menu offers, in order. Each referenced row is the dispatch row (its own `effect_kind` + params). |
| `menu_option_labels` | string | **Pipe (`|`)**-separated display labels, positionally paired with `menu_option_refs`. Falls back per-index to the option row's legacy `menu_label` (back-compat), then the ref. |
| `menu_option_descriptions` | string | **Pipe (`|`)**-separated descriptions, positionally paired with `menu_option_refs` (use `|` so descriptions may contain commas). Falls back to the option row's legacy `menu_description`. |
| `menu_pick_count` | number OR formula string | See below. |

> **Text lives on the menu row, not the options.** As of 2026-06-07 the per-option
> display text moved off the option rows onto the `open_action_menu` row
> (`menu_option_labels` / `menu_option_descriptions`, `|`-separated, paired with
> the comma-separated `menu_option_refs`). The option rows carry only mechanics.
> The engine still falls back to the legacy per-option `menu_label` /
> `menu_description` if the menu row doesn't supply them, so pre-migration skills
> keep working. These fields (+ the free-mode fields) are now editable in the CSB
> sheet (columns gated to `effect_kind === "open_action_menu"`).

#### Free-action-mode fields

| Field | Type | Notes |
|-------|------|-------|
| `allowed_types` | string | Comma-separated TurnUI button labels (`"Attack,Spell"`, `"Study"`, etc.). Other buttons render disabled. |
| `free_mode` | boolean | When `true`, registers a pending free-action grant in `FUCompanion.api.freeActions` keyed by the reactor's actor.id. Default false. |
| `max_mp_cost` | number | Optional cap on the MP cost of a Spell selectable through this free action. Used by playtest Acceleration. Blank/0 = no cap. |
| `check_bonus_formula` | string (formula) | Resolved at apply time against the reactor + firing skill. Result stored in the free-action grant and applied to the next action's check. Painful Lesson uses `"SL"`. |
| `damage_bonus_formula` | string (formula) | Same shape but applied to the next action's damage. |
| `target_ref` | string (`effect_label`) | Optional. References a [`targeting`](#effect_kind-targeting--produce-a-named-token-list) row. When set, the resolved token is stashed on the free-action grant; consumers (Study macro, etc.) restrict their target picker to that token. Painful Lesson uses a row with `candidate_source: "trigger_actor"` to enforce "on that creature". |
| `menu_pick_count` | number OR formula string | Optional, default `1`. How many **distinct** options the player chooses (clamped to the option count). A formula lets a sibling skill widen the choice without an engine edit — Warning Shot uses `"1 + HAS_SKILL_PERFECT_AIM"` so the Perfect Aim Heroic Skill makes it pick two. Resolved against the reactor + payload. Interactive mode prompts once per pick over the remaining options (cancelling the first pick aborts; cancelling a later one keeps the picks already made); passive mode auto-picks the first N (author ordering = priority); the harness consumes N entries from `harnessPicks`. Each chosen option's row is dispatched in pick order. |

**Apply-click resolution (reaction pills).** When an option-menu reaction is
applied from an Action Card pill, the menu is resolved **at Apply-click** (not at
RESOLVE): `previewReactionMenu` walks the chain, prompts the menu, caches the
chosen picks on the candidate (`chosenMenuPicks`, round-tripped like Protect's
`pickedSubjectActorUuids`), and the card previews the outcome — the Damage panel
strikes through if the chain zeroes outgoing damage (`adjust_damage ×0`), and an
Effect panel lists the chosen statuses/costs. At RESOLVE the cached picks are
replayed via `ctx.menuPicks` so the chain dispatches the same options without
re-prompting. Set `skip_when_passive: true` only for a genuinely automatic
passive that should auto-pick without any prompt.

The formula bonuses are stamped into the free-action grant state at trigger
time. Macros that don't flow through ADC (e.g. the Study macro) read the
grant directly and apply / consume on confirm.

### `effect_kind: "chain"` — invoke other effect labels in order

| Field | Type | Notes |
|-------|------|-------|
| `chain_steps` | string | Comma- or newline-separated `effect_label` values to invoke in order. |

Stops at the first step that returns `abort: true` OR `ok: false`.
Aborts the whole chain (and the skill body) when any step does.

---

### `effect_kind: "modify_damage_taken"` — mutate pending damage before HP write

Fires from the director's RESOLVE damage paths via `resolveDamageReactions`,
which walks the target's AEs at damage-application time and applies any
matching reactions BEFORE writing `current_hp`. Pair with trigger
`creature_takes_damage` (and the `reaction_damage_outcome` filter when
relevant).

Used by **Mercy** (clamp HP floor at 1). Other modes are placeholders for
future Phase F reactions (Damage Cap, Mirror reflect, etc.).

| Field | Type | Notes |
|-------|------|-------|
| `modify_mode` | `"set_hp_floor"` (only mode implemented; future: `"cap_damage"`, `"reflect_damage"`, `"multiply_damage"`) | What to do with the pending damage. `set_hp_floor` clamps the resulting HP up to `modify_value` if it would land lower. |
| `modify_value` | number or formula | Mode-dependent argument. For `set_hp_floor` this is the floor HP. |
| `consume_self` | bool | When `true`, the AE bearing this reaction is deleted after firing. Used by Mercy ("Consumed on first trigger"). |

**Trigger-row filter** (used alongside this effect_kind):

| Field | Values | Notes |
|---|---|---|
| `reaction_damage_outcome` | `"any"` (default) `\| "would_reduce_to_zero"` | Pre-write outcome test. `would_reduce_to_zero` only matches when the target's HP minus pending damage would land at 0 or below. |

Example — **Mercy** AE's `reactionConfig` blob (lives on
`flags.fabula-ultima-companion.reactionConfig` of the AE; visible in the
AE-sheet Reactions panel):

```jsonc
{
  "name": "Mercy",
  "reaction_config_table": {
    "0": {
      "reaction_trigger":         "creature_takes_damage",
      "reaction_source":          "self",
      "reaction_damage_outcome":  "would_reduce_to_zero",
      "reaction_effect_ref":      "mercy_clamp",
      "reaction_passive_mode":    "on"
    }
  },
  "effect_table": {
    "0": {
      "effect_label":   "mercy_clamp",
      "effect_kind":    "modify_damage_taken",
      "modify_mode":    "set_hp_floor",
      "modify_value":   1,
      "consume_self":   true
    }
  }
}
```

---

### `effect_kind: "adjust_accuracy"` — override the in-flight Accuracy total

Action-level card mutation: rewrite the in-flight Accuracy Check total, then
recompute hit/miss for **every** target against its own defense. The accuracy
analogue of `adjust_damage`, but action-scoped (one roll) rather than per-target.
Crossfire `set`s it to 0 so a ranged attack "fails automatically against all
targets". The card UI shows **Blocked** in place of the overridden total.

| Field | Type | Notes |
|---|---|---|
| `accuracy_operation` | `"set" \| "add" \| "subtract"` | Default `"set"`. How to combine `accuracy_amount` with the current total. |
| `accuracy_amount` | number OR formula string | The operand. Same formula grammar as `grant_amount` (resolved against the reactor + the candidate's fire-time payload). |

Like `redirect_target`, this kind is **data-only at chain-fire time** — the
override + hit/miss recompute happen in `card-mutations.js` at the CONFIRM write
site (before RESOLVE reads `ar.perTargetResults`), and the same pipeline drives
the live Apply-click preview. It currently only re-derives damage on the **miss**
side (zeroing it); a future `add`/positive that flips a miss to a hit would need
a full HR/damage recompute (left out until a skill needs it).

**Phase note:** the override applies at CONFIRM but a downstream cost step
(`consume_resource`) fires at RESOLVE — a *different* phase, so
[[consume-last-in-chain]] doesn't protect against an unaffordable reactor paying
nothing after the attack is already blocked. Gate affordability up front in the
`condition_formula` (`CUR_MP >= ATTACK_CHECK_RESULT`) so the reaction only
surfaces when the reactor can pay.

---

## Worked example — "Crossfire" (post-roll bystander accuracy override)

Sharpshooter reaction (Core). RAW: "After a creature you can see performs a
ranged attack, you may spend an amount of Mind Points equal to the total Result
of their Accuracy Check in order to have the attack fail automatically against
all targets. You can only use this Skill if you have a ranged weapon equipped,
and it has no effect if the Accuracy Check was a critical success."

Crossfire is a **third-party, post-roll** reaction: it rides the existing
CONFIRM `creature_targeted_by_action` scan (the same path Protect / Cover use),
so the bystander reactor sees a pill once the attack's roll is known.
`reaction_source: "all"` because RAW reacts to *any* visible ranged attack
(even one aimed at an ally or yourself); the scan already excludes the attacker
as a reactor.

```jsonc
"reaction_config_table": {
  "0": {
    "reaction_trigger":      "creature_targeted_by_action",
    "reaction_source":       "all",
    "reaction_action_intent": "harmful",
    "reaction_passive_mode": "ask",            // "may" → clickable pill
    "reaction_effect_ref":   "crossfire_do",
    "condition_formula":
      "ATTACK_IS_RANGED == 1 && HAS_RANGED_WEAPON && ATTACK_IS_CRIT == 0 && CUR_MP >= ATTACK_CHECK_RESULT"
  }
},
"effect_table": {
  "0": { "effect_label": "crossfire_do", "effect_kind": "chain", "chain_steps": "crossfire_block,crossfire_cost" },
  "1": {
    "effect_label":     "crossfire_block",
    "effect_kind":      "adjust_accuracy",
    "accuracy_operation": "set",
    "accuracy_amount":  "0"
  },
  "2": {
    "effect_label":    "crossfire_cost",
    "effect_kind":     "consume_resource",
    "consume_resource": "mp",
    "consume_amount":  "ATTACK_CHECK_RESULT",   // = the attacker's Accuracy Result
    "target_ref":      "self",
    "on_empty":        "abort"
  }
}
```

Flow: an enemy fires a ranged attack → the roll resolves → at CONFIRM the
third-party scan offers Crossfire to any bystander with a ranged weapon + enough
MP (the gate clauses) → the reactor clicks Apply → `adjust_accuracy` sets the
Accuracy total to 0, so every target's hit/miss recomputes to MISS and the card
shows **Blocked** → at RESOLVE the `consume_resource` deducts MP equal to the
attacker's Accuracy Result. `ATTACK_IS_RANGED` reads the *incoming* attack's
range; `HAS_RANGED_WEAPON` reads the *reactor's* equipped loadout — the
[loadout vs active-attack](#formula-identifiers-resolved-against-the-reactor--trigger-payload)
distinction.

---

## Worked example — "Protect"

Reaction-skill that intercepts a single-target *harmful* action on an ally,
redirects it onto the reactor, and consumes one Protect charge. The
`reaction_action_intent: "harmful"` gate keeps Protect from firing when an
ally targets another ally with a heal or buff — per RAW, only "attack, spell
or other danger" qualifies.

```jsonc
"reaction_config_table": {
  "0": {
    "reaction_trigger": "creature_targeted_by_action",
    "reaction_source": "ally",
    "reaction_damage_type": "",
    "reaction_action_intent": "harmful",
    "reaction_effect_ref": "do_protect",
    "reaction_passive_mode": "ask"
  }
},
"effect_table": {
  "0": {
    "effect_label": "do_protect",
    "effect_kind":  "chain",
    "chain_steps":  "consume_one, redirect"
  },
  "1": {
    "effect_label": "consume_one",
    "effect_kind":  "consume_charge",
    "charge_key":   "protect",
    "on_empty":     "abort",
    "count":        1,
    "target_ref":   "self_target"
  },
  "2": {
    "effect_label":    "redirect",
    "effect_kind":     "redirect_target",
    "rebuild_card":    true,
    "target_ref":      "incoming_target",
    "destination_ref": "self_target"
  },
  "3": {
    "effect_label":     "self_target",
    "effect_kind":      "targeting",
    "candidate_source": "self"
  },
  "4": {
    "effect_label":     "incoming_target",
    "effect_kind":      "targeting",
    "candidate_source": "action_targets",
    "mode":             "exact",
    "count":            1
  }
}
```

The two targeting rows resolve lazily (only when first referenced by a `target_ref` / `destination_ref`) and are memoized — so `self_target` is resolved once and shared between the `consume_one` and `redirect` steps.

Flow: when an ally is targeted, the reactor can choose Protect from the
reaction picker. The chosen-skill dispatcher calls
`applyEffectsForGroup` for the matched row → fires the `do_protect`
chain → first `consume_one` (aborts the chain if no charge) → then
`redirect` (which aborts the chain because redirect always aborts on
success, suppressing the Protect skill body so no Protect card posts).

---

## Worked example — "Painful Lesson" (damage_source + open_action_menu bonus)

Reaction-skill (Darkblade Heroic). RAW: "After another creature causes you to
lose Hit Points, you may immediately perform the Study action on that creature
for free. If you do, gain a bonus equal to SL to your Check."

```jsonc
"system.props.isReaction": true,
"system.props.reaction_config_table": {
  "0": {
    "reaction_trigger":       "creature_takes_damage",
    "reaction_source":        "self",       // reactor IS the damage target
    "reaction_damage_source": "enemy",      // damage came from an enemy
    "reaction_action_intent": "harmful",
    "reaction_effect_ref":    "pl_free_study",
    "reaction_passive_mode":  "ask"          // player picks from the picker
  }
},
"system.props.effect_table": {
  "0": {
    "effect_label":        "pl_free_study",
    "effect_kind":         "open_action_menu",
    "allowed_types":       "Study",                  // only Study button enabled
    "free_mode":           true,                     // bypass action budget
    "check_bonus_formula": "SL",                     // +Painful Lesson SL to Study
    "target_ref":          "attacker"                // Study locked onto the attacker
  },
  "1": {
    "effect_label":     "attacker",
    "effect_kind":      "targeting",
    "candidate_source": "trigger_actor",             // the creature that dealt the damage
    "mode":             "exact",
    "count":            1
  }
}
```

Flow: Hina takes damage from a Bandit Archer → reaction window opens with
Painful Lesson available → Hina picks it → TurnUI spawns with only Study
enabled, and a free-action grant is stamped with `checkBonus: SL`. → Hina
clicks Study → the Study macro pre-fills the modifier with SL, consumes
the grant on confirm.

## Worked example — "Phantasmal Echo" (kind + ownership)

Passive reaction-skill that auto-fires when one of the reactor's own
Phantasms is defeated. Uses the universal `reaction_subject_kind` /
`reaction_ownership` filters instead of a `custom_logic_action` gate.

```jsonc
"reaction_config_table": {
  "0": {
    "reaction_trigger":      "creature_defeated",
    "reaction_source":       "all",
    "reaction_subject_kind": "isPhantasm",   // subject.actor.system.props.isPhantasm == true
    "reaction_ownership":    "own_summon",   // subject token's summonedBy flag == reactor.actor.uuid
    "reaction_effect_ref":   "",             // skill body itself runs the MP restore
    "reaction_passive_mode": "on",
    "reaction_passive_target": "self"
  }
}
```

Setup outside the reaction config:

- Phantasm NPC actors carry `system.props.isPhantasm = true`.
- The summoner skill (e.g. *Create Phantasm: Dread*) stamps the spawned
  TokenDocument with `flags["fabula-ultima-companion"].summonedBy =
  <reactor actor UUID>` via `FUCompanion.api.phantasm.markSummon`.

When the matched row fires, the autoPassive runner executes Phantasmal
Echo's normal skill body (MP restore), with no custom JS in the skill.

---

## Adding a new field — checklist

If you extend either table with a new column:

1. Add the column to the `rowLayout` of the relevant table in
   `Game Object/Template/[Item] _Skill Template.json` AND in the
   running world's template (CSB stores a copy of the layout per item).
2. Wire the runtime read in `scripts/reaction-system/reaction-grant.js`
   (effect side) or `reaction-triggers.config.js` / `reaction-triggerCore.js`
   (trigger side).
3. Update this doc.
4. If the new field is a filter, also update the subject/filter matrix
   table above.

If you add a new `effect_kind` — the engine is now the single source of truth:

1. Add the kind to `EFFECT_KIND_DISPATCH` in `scripts/battle-director/skill-effects.js`
   (key → handler; data-only kinds use a small inline `() => ({ok:true,...})`).
2. Add a label to `EFFECT_KIND_LABELS` in the same file.
3. Document the per-kind fields here.

That's it for the dropdown: the **every-boot template dropdown-options sync**
(`_module-boot.js` section 3) reads `SUPPORTED_EFFECT_KINDS` + `EFFECT_KIND_LABELS`
and backfills the template's `effect_kind` option automatically — NO per-kind
template migration. (See the select-option gate in [[csb-template-gating]].)
**Also verify the kind across all four passive modes** —
[[feedback_effect_kind_check_all_passive_modes]].

If you add a new trigger key:

1. Add the entry to the `TRIGGERS` array in `reaction-triggers.config.js`
   (subject, bucket, filters).
2. Emit it from the appropriate phase handler.
3. Add the row to the subject/filter matrix table above.

The template's `reaction_trigger` dropdown is backfilled automatically by the
boot dropdown-options sync (it reads `oni.ReactionTriggers.listTriggers()`), so
no template option edit is needed.

**General select columns:** the boot sync also backfills any select column from
the values actually used in the skill masters — so a value authored via migration
won't be stripped when a human opens the sheet. New select *columns* still need
the column-gate surgery in the field checklist above.
