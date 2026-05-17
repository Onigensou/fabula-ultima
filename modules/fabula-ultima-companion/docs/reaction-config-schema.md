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
| `reaction_isPassive` | boolean | no | If true, this row auto-fires when the trigger matches (no user pick required). |
| `reaction_passive_target` | `"self"` | when `reaction_isPassive: true` | Currently only `"self"` is implemented. |

### Canonical trigger keys

29 triggers, grouped by phase bucket. The bucket determines when the
reaction window opens/closes. Reactions in the same bucket coexist in a
single merged window (e.g. damage + crisis + defeat all stay available
in `resolution_phase`).

| Bucket | Trigger keys |
|--------|--------------|
| `conflict_start` | `conflict_start` |
| `round_start` | `round_start` |
| `round_end` | `round_end` |
| `turn_start` | `turn_start` |
| `turn_end` | `turn_end` |
| `action_phase` | `creature_performs_check`, `creature_performs_action`, `creature_targeted_by_action`, `creature_fumbles_check`, `creature_check_outcome_flipped` |
| `resolution_phase` | `creature_hit_by_action`, `creature_critical_hit`, `creature_miss_action`, `creature_deals_damage`, `creature_takes_damage`, `creature_takes_vulnerable_damage`, `creature_takes_weak_damage`, `creature_resists_damage`, `creature_absorbs_damage`, `creature_immune_damage`, `creature_shield_break`, `creature_recovers_hp`, `creature_lose_mp`, `creature_recovers_mp`, `creature_status_applied`, `creature_enter_crisis`, `creature_exit_crisis`, `creature_defeated`, `creature_unleashes_zero_power` |

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
| `creature_deals_damage` | damage source | yes | yes | yes | — |
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

(The `_Skill Template`'s dropdown options list omits
`creature_unleashes_zero_power` — that trigger was added later and the
template UI is one behind. It still works correctly at runtime; just
type the key directly.)

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

---

## `effect_table` — effect row fields

(Legacy name: `reaction_effect_table`. Runtime reads either.)

Common to every row:

| Field | Type | Notes |
|-------|------|-------|
| `effect_label` | string | Unique identifier; trigger rows reference this in their `reaction_effect_ref` column. Must be non-blank for the row to be findable. |
| `effect_kind` | `"grant" \| "apply_ae" \| "consume_charge" \| "redirect_target" \| "chain"` | Default: `"grant"`. Dispatches to the matching handler in `reaction-grant.js`. |

Per-kind fields below. Fields irrelevant to the chosen kind are hidden
in the UI but harmless in JSON.

### `effect_kind: "grant"` — grant or drain a resource

| Field | Type | Notes |
|-------|------|-------|
| `grant_resource` | `"hp" \| "mp" \| "ip" \| "zero_power" \| "zenit" \| "enmity"` | Required. Blank = effect disabled. |
| `grant_amount` | number OR formula string | Positive grants; negative drains. Blank or 0 = effect disabled. **Formulas are supported** — see "Formula identifiers" below. |
| `grant_target` | `"self" \| "ally" \| "enemy" \| "all"` | Default `"self"`. `"ally"` includes the reactor. |

Resource caps: `hp/mp/ip` clamp to actor's `max_*`; `zero_power` clamps
to [0, 6]; `zenit/enmity` are uncapped. Floor is always 0.

#### Formula identifiers (resolved against the reactor + trigger payload)

`grant_amount` accepts a literal number (`"10"`) OR a safe arithmetic
expression with whitelisted identifiers and functions. Evaluated by
`window["oni.ReactionFormula"]`. No `eval` / `new Function`.

Operators: `+` `-` `*` `/`, unary minus, parentheses.
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
| `grant_target` | `"self" \| "ally" \| "enemy" \| "all"` | Default `"self"`. |
| `ae_duplicate_mode` | `"skip" \| "replace" \| "stack" \| "remove" \| "ask"` | Default `"replace"`. How to handle when the target already has the AE. |

The AE itself must exist somewhere the AEM can resolve (on a skill item
or registered globally). Inline AE JSON authoring was removed — keep the
single source of truth in the AE document.

### `effect_kind: "consume_charge"` — gate-and-consume one charged AE

| Field | Type | Notes |
|-------|------|-------|
| `charge_key` | string | The `chargeKey` to find on the target actor. |
| `grant_target` | `"self" \| "ally" \| "enemy" \| "all"` | Default `"self"`. Typically `"self"` (the reactor's own charge). |
| `on_empty` | `"abort" \| "skip"` | Default `"abort"`. With `abort`, an empty charge cancels the chain *and* signals callers to skip the skill body. |
| `count` | number | Charges to consume per target. Default 1. |

Returns `abort: true` when nothing could be consumed and `on_empty:
"abort"`. The manual-reaction dispatcher and autoPassive runner both
respect this — the skill body never runs.

### `effect_kind: "redirect_target"` — rewrite the pending action card's target

Action-mutation verb. Wraps `oni.ReactionRedirectPendingAction` so
authors don't write JS for "intercept the incoming attack and aim it at
me instead" (Protect, Cover, Bodyguard).

| Field | Type | Notes |
|-------|------|-------|
| `target_select` | `"first"` | Which target slot to redirect. Today only `"first"` is implemented. |
| `rebuild_card` | boolean | Default `true`. Re-render the redirected card so viewers see the new target. |

Always returns `abort: true` on success — a successful redirect means
the reactor's own skill body must NOT continue (no Protect card created).

### `effect_kind: "chain"` — invoke other effect labels in order

| Field | Type | Notes |
|-------|------|-------|
| `chain_steps` | string | Comma- or newline-separated `effect_label` values to invoke in order. |

Stops at the first step that returns `abort: true` OR `ok: false`.
Aborts the whole chain (and the skill body) when any step does.

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
    "reaction_isPassive": false
  }
},
"effect_table": {
  "0": {
    "effect_label": "do_protect",
    "effect_kind": "chain",
    "chain_steps": "consume_one, redirect"
  },
  "1": {
    "effect_label": "consume_one",
    "effect_kind": "consume_charge",
    "charge_key": "protect",
    "grant_target": "self",
    "on_empty": "abort",
    "count": 1
  },
  "2": {
    "effect_label": "redirect",
    "effect_kind": "redirect_target",
    "target_select": "first",
    "rebuild_card": true
  }
}
```

Flow: when an ally is targeted, the reactor can choose Protect from the
reaction picker. The chosen-skill dispatcher calls
`applyEffectsForGroup` for the matched row → fires the `do_protect`
chain → first `consume_one` (aborts the chain if no charge) → then
`redirect` (which aborts the chain because redirect always aborts on
success, suppressing the Protect skill body so no Protect card posts).

---

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
    "reaction_isPassive":    true,
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

If you add a new `effect_kind`:

1. Add the option key/value in the template's `effect_kind` select
   options.
2. Add the handler function in `reaction-grant.js`.
3. Add the kind to the switch in `applyEffectByLabel`.
4. Document the per-kind fields here.

If you add a new trigger key:

1. Add the entry to the `TRIGGERS` array in `reaction-triggers.config.js`
   (subject, bucket, filters).
2. Add it to the template's `reaction_trigger` select options.
3. Emit it from the appropriate phase handler.
4. Add the row to the subject/filter matrix table above.
