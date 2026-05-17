# Action Pipeline Payload Shape

This is the schema reference for the `cardPayload` object that flows through the
action pipeline. It exists because the payload grew organically — every
subsystem added its own fields, and during debugging we kept rediscovering
which fields lived at top level vs. `meta` vs. `advPayload`. Use this doc when
you need to know *who writes* a field, *who reads* it, or *what shape* it has.

If you add a field, update this doc in the same change.

---

## Pipeline at a glance

```
[Command Button macro]
    │  passes { actorId?, skillUuid? } or weapon overrides
    ▼
ActionDataFetch.js  (ADF)
    │  resolves attacker, fetches skill/weapon item, builds dataCore,
    │  converts rich-text scripts, seeds meta + originalTargetUUIDs
    ▼
ActionDataComputation.js  (ADC)
    │  rolls accuracy, computes damage / HR, parses damage type,
    │  snapshots bonds + defenses, extracts AE directives,
    │  assembles the FINAL cardPayload (this is the canonical shape)
    │
    ├─ if isPassiveExecution ──────────────────────────────────────────┐
    │                                                                  │
    │   skip Targeting → skip ResourceGate → skip CreateActionCard     │
    │   → applyBeforeAttackEffects → PassiveLogic-Action               │
    │   → normalizePassiveCostsOrAllow → action-execution-core.execute │
    │                                                                  │
    └─ otherwise (manual flow): ───────────────────────────────────────┤
                                                                       │
        Targeting.js (TGT) ─ confirms targets, may abort ──────────────┤
            │                                                          │
        CustomLogic-Action.js (CLA) ─ skill author script ─────────────┤
            │                                                          │
        ApplyActiveEffect.js (AAE) ─ before_attack AEs ────────────────┤
            │                                                          │
        Skill: ResourceGate.js (RG) ─ MP/IP cost gate ─────────────────┤
            │                                                          │
        PassiveLogic-Action.js (PLA) ─ item-based passive mods ────────┤
            │                                                          │
        CreateActionCard.js (CAC) ─ posts the chat card ───────────────┤
            │  (waits for player to confirm)                           │
            │                                                          │
        applyDamage-button.js ─ confirm handler ──────────────────────►│
                                                                       ▼
                                                       action-execution-core.js
                                                                  (AEC)
                                                       │ executes damage,
                                                       │ AEs (on_hit/on_attack),
                                                       │ reaction emits,
                                                       │ resource spend, etc.
                                                       ▼
                                              CustomLogic-Resolution.js
                                              PassiveLogic-Resolution.js
```

**Reader abbreviations** used in field tables below:

| Code | File |
|------|------|
| ADF  | `macros/Action Pipeline/ActionDataFetch.js` |
| ADC  | `macros/Action Pipeline/ActionDataComputation.js` |
| TGT  | `macros/Action Pipeline/Targeting.js` |
| CLA  | `macros/Action Pipeline/CustomLogic-Action.js` |
| AAE  | `macros/Action Pipeline/ApplyActiveEffect.js` |
| RG   | `macros/Action Pipeline/ResourceGate.js` |
| CAC  | `macros/Action Pipeline/CreateActionCard.js` |
| PLA  | `macros/Action Pipeline/PassiveLogic-Action.js` |
| AEC  | `scripts/action-execution-core.js` |

`Writer` columns name **the file that originates the field**. Many fields are
copied / mirrored / overridden later (see "Mutation points" near the end).

---

## Top-level fields

The top-level object is the entry payload to ADC and the canonical shape going
forward. Many top-level fields are **mirrors** of `meta.*` for convenience —
both ADF and ADC place certain fields at both layers so consumers don't have
to remember which is authoritative. When in doubt, prefer `meta.*`.

| Field | Type | Writer | Readers | Notes |
|-------|------|--------|---------|-------|
| `source` | `"Weapon" \| "Skill" \| "Item" \| "AutoPassive"` | Caller / ADF | ADC, TGT, RG | ADC normalizes `"AutoPassive"` → `"Skill"` and routes via `executionMode` instead. |
| `executionMode` | `"manual" \| "autoPassive"` | ADF | ADC, TGT, RG, AEC | Top-level mirror of `meta.executionMode`. |
| `autoPassive` | `boolean` | ADF | ADC | Legacy boolean form of `executionMode === "autoPassive"`. |
| `isPassiveExecution` | `boolean` | ADC | (mirror only) | Top-level mirror of `meta.isPassiveExecution`. |
| `attackerActorUuid` | `string` (Actor UUID) | ADF | ADC, AEC | The attacker's *actor* UUID (not token). ADC resolves this into `useActor`. |
| `dataCore` | `object` | ADF | ADC | The pre-computation skill/weapon snapshot. See "dataCore" section. |
| `overrides` | `object` | Caller (Weapon / Skill branch) | ADF, ADC | Per-call overrides applied on top of the resolved item's props. **Weapon branch:** raw weapon-attack overrides (rolled attrs, damage bonus, etc.). **Skill branch:** optional `{ rolled_atr1, rolled_atr2, check_bonus }` for skills where the caller picks the formula at fire time (e.g. Study). |
| `skillUuid` | `string` | ADF | ADC | Skill item UUID. Skill / Item branch only. |
| `weaponUuid` | `string` | ADF | ADC | Weapon item UUID. Weapon branch only. |
| `itemUuid` | `string` | Caller (Item branch) | ADF | Owning item UUID for an Item-fastpath skill. Mirrored to `meta.itemUuid`. |
| `ignoreHR` | `boolean` | ADF (Skill) | ADC | If true, do not add HR bonus to damage. |
| `listType` | `string` | ADF | ADC | `"Attack" \| "Active" \| "Passive" \| "Spell" \| "Offensive Spell" \| "Item"`. |
| `animTimingMode` | `string` | ADF | ADC | `"default" \| "before" \| "after"`. Forwarded into `advPayload.animation_damage_timing_options`. |
| `animTimingOffset` | `number` (ms ≥0) | ADF | ADC | Forwarded into `advPayload.animation_damage_timing_offset`. |
| `animationScriptRaw` | `string` (JS) | ADF | ADC | Sequencer animation script, already converted from rich text. Forwarded into `advPayload.animationScriptRaw`. |
| `customLogicActionRaw` | `string` (JS) | ADF | ADC, CLA | Action-phase author script; blank means "no custom logic". Mirrored to `meta.customLogicActionRaw`. |
| `customLogicResolutionRaw` | `string` (JS) | ADF | ADC | Resolution-phase author script. Mirrored to `meta.customLogicResolutionRaw`. |
| `targets` | `string[]` (Token UUIDs) | ADF / TGT | ADC, RG, CAC, AEC, CLA, AAE | Current target list. **Mutated by Targeting** to the user's confirmed selection. |
| `originalTargetUUIDs` | `string[]` (Token UUIDs) | ADF | ADC, TGT, CAC, AEC | Canonical target list, refreshed after every target-touching step (see `refreshCanonicalTargetsAndDefense` in ADC). |
| `originalTargetActorUUIDs` | `string[]` (Actor UUIDs) | ADF | ADC, TGT, CAC, AEC | Canonical actor-UUID counterpart of the above. |
| `actionCardMessageId` | `string` (ChatMessage id) | CAC | AEC | Set by CreateActionCard once the card is posted; mirrored from `meta.actionCardMessageId`. |
| `accuracy` | `object \| null` | ADC | CAC, AEC | See "accuracy" section. `null` for non-check skills. |
| `advPayload` | `object` | ADC | CAC, AEC, CLA, PLA | The damage-engine payload. See "advPayload" section. |
| `core` | `object` | ADC | CAC, CLA, PLA, AEC | Display + descriptor fields. See "core" section. |
| `meta` | `object` | ADC | All consumers | Catch-all for everything else. See "meta" section. |
| `itemUseMode` | `"" \| "use" \| "create"` | ADF | ADC | JRPG-item flow only. Mirrored to `meta.itemUseMode`. |
| `itemCreate` | `object \| null` | ADF | ADC | Create-mode payload (recipe + created item refs). |
| `itemUsage` | `object` | ADF | ADC | Use- or create-mode usage descriptor (consumeQuantity, isUnique, etc.). |
| `reaction_trigger_key` | `string \| null` | Caller (passive emit) | ADC | Single trigger key seeding this action (e.g. when one passive enqueues another). |
| `reaction_trigger_keys` | `string[]` | Caller | ADC | Multi-trigger variant. |
| `reaction_phase_payload` | `object` | Caller | ADC, CLA | Snapshot of the source reaction phase that emitted this action. |
| `reaction_phase_payload_by_trigger` | `object` | Caller | ADC | Per-trigger map of phase payloads. |
| `passiveTriggerKey` | `string \| null` | Caller | ADC, CLA | Trigger key for a passive auto-fire (e.g. `creature_unleashes_zero_power`). |
| `passiveSourceEvent` | `object` | Caller | ADC, AEC | The event blob that triggered the passive (round/turn/actor/etc.). |
| `sourceActionId` | `string \| null` | Caller | ADC | If this action was emitted by a parent action card, the parent's actionId. Used to chain reactions back. |
| `sourceActionCardId` | `string \| null` | Caller | ADC | Parent action card id (flag value). |
| `sourceActionCardVersion` | `number \| null` | Caller | ADC | Version stamp of the parent card flag. |
| `sourceActionCardMessageId` | `string \| null` | Caller | ADC | Parent ChatMessage id. |
| `sourceActionOwnerUserId` | `string \| null` | Caller | ADC | Parent action's owning user id. |
| `sourceActionOwnerUserName` | `string \| null` | Caller | ADC | Parent action's owning user name. |

---

## `dataCore` (input-only)

Built by ADF, consumed by ADC, then **discarded** — not stored on the final
cardPayload. Use `core.*` and `meta.*` to read post-ADC state.

| Field | Type | Source |
|-------|------|--------|
| `attackerName` | `string` | `useActor.name` |
| `skillName` | `string` | item name / weapon override |
| `skillImg` | `string` | item img / weapon override |
| `listType` | `string` | inferred (`Attack` / `Active` / `Passive` / `Spell` / `Offensive Spell` / `Item`) |
| `isCheck` | `boolean` | `props.isCheck` |
| `isSpell` | `boolean` | `props.isSpell` |
| `isOffSpell` | `boolean` | `props.isOffensiveSpell` |
| `rolledAtr1` | `string` (uppercase, e.g. `"DEX"`) | `props.rolled_atr1` |
| `rolledAtr2` | `string` (uppercase) | `props.rolled_atr2` |
| `checkBonus` | `number` | `props.check_bonus` |
| `damageBonus` | `number` | parsed from `props.damage_bonus` |
| `damageBonusProvided` | `boolean` | true iff a numeric value was provided (blank = nonDamageAction) |
| `damageBonusRaw` | `string \| null` | the raw value pre-parse |
| `typeDamageTxt` | `string` | e.g. `"physical"`, `"fire"`, `"healing"`, `"mp"`, `"mp burn"` |
| `flatBonus` | `number` | `props.bonus` |
| `reduction` | `number` | `props.reduction` |
| `multiplier` | `number` | `props.multiplier` (default 100) |
| `skillRange` | `string` | e.g. `"Melee"`, `"Ranged"` |
| `rawEffectHTML` | `string` | the description rich text |
| `weaponType` | `string` (lowercase) | weapon category (e.g. `"sword"`, `"arcane"`) |
| `skillTypeRaw` | `string` | raw `props.skill_type` |
| `skillTargetRaw` | `string` | raw `props.skill_target` |

**Damage type parsing** happens in ADC's `parseDamageSpec(typeDamageTxt)`:
- `"healing"` / `"recovery"` etc. → `{ elementType, valueType: "hp", declaresHealing: true }`
- `"mp burn"` → `{ elementType: "mp", valueType: "mp", declaresHealing: false }`
- `/\bmp\b/` → `{ elementType: "mp", valueType: "mp", declaresHealing: true }`
- otherwise → `{ elementType: <lower>, valueType: "hp", declaresHealing: false }`

---

## `core` (display + identifying descriptors)

Stable, display-oriented projection of the skill/weapon. Read by CAC for the
chat card; read by CLA / PLA / AEC as a fallback display source.

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `attackerName` | `string` | ADC | CAC, AEC |
| `skillName` | `string` | ADC | CAC, CLA, PLA, AEC |
| `skillImg` | `string` | ADC | CAC, AEC |
| `rawEffectHTML` | `string` | ADC | CAC |
| `typeDamageTxt` | `string` | ADC | CAC |
| `skillTypeRaw` | `string` | ADC | CAC, TGT |
| `skillTargetRaw` | `string` | ADC | CAC, TGT |
| `weaponType` | `string` (lowercase) | ADC | CAC |

---

## `meta` (the catch-all)

This is where most fields live. The categories below are conceptual — they're
all flat keys on `meta`.

### Identity / authorship

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `attackerName` | `string` | ADC (mirror) | CAC, AEC |
| `attackerUuid` | `string` (Token UUID, falls back to Actor UUID) | ADF | TGT, CAC, AEC, CLA, AAE |
| `attackerActorUuid` | `string` (Actor UUID) | ADF | AEC |
| `attackerTokenUuid` | `string` (Token UUID) | ADF | (consumers TBD; harmless if missing) |
| `ownerUserId` | `string` (User id) | ADF | TGT, CAC |
| `ownerUserName` | `string` | ADC | CAC |
| `skillUuid` | `string` | ADC (Skill branch) | AEC |
| `weaponUuid` | `string` | ADF (Weapon branch) | (passed-through) |
| `itemUuid` | `string` | ADF (Item branch) | AEC |
| `itemName` | `string` | ADF (Item branch) | AEC |

### Mode flags

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `executionMode` | `"manual" \| "autoPassive"` | ADF | TGT, RG, CAC, CLA, PLA, AEC |
| `isPassiveExecution` | `boolean` | ADF | TGT, RG, CAC, CLA, PLA, AEC |
| `listType` | `string` | ADC (mirror) | CAC, AEC |
| `isSpellish` | `boolean` | ADC | CAC, AAE |
| `weaponTypeLabel` | `string` | ADC | CAC |

### Damage-type fanout

Computed by ADC from `dataCore.typeDamageTxt`.

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `elementType` | `string` | ADC | CAC, PLA, AEC |
| `declaresHealing` | `boolean` | ADC | CAC, AEC |
| `hasDamageSection` | `boolean` | ADC | CAC, AEC (gates damage application) |
| `hasAnimationScript` | `boolean` | ADC | CAC |
| `baseValueStrForCard` | `string` | ADC | CAC |
| `hrBonus` | `number` | ADC | CAC |
| `ignoreHR` | `boolean` | ADC | CAC |
| `attackRange` | `string` | ADC (from `dataCore.skillRange`) | CAC, AEC |

### Snapshots

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `bonds` | `{ list, viable, hasAny, hasViable }` | ADC | CAC (invoke buttons) |
| `defenseSnapshot` | `{ primary, perTarget }` | ADC | CAC, AEC |
| `activeEffects` | `Directive[]` | ADC | CAC, AEC, AAE |
| `invoked` | `{ trait: bool, bond: bool }` | ADC (init) → CAC (mutate) | CAC |

`activeEffects` directive shape (see `fuExtractAEDirectivesFromItem` in ADC):
`{ effId, application: "add"\|..., mode, target: "any"\|"self"\|..., trigger: "before_attack"\|"on_attack"\|"on_hit", percent, die1, die2, dl, effect }`.

### Cost / resource

| Field | Type | Writer | Read by | Notes |
|-------|------|--------|---------|-------|
| `costRaw` | `string` | ADC (from skill `props.cost`) | RG, CAC, AEC | Skill's declared cost. |
| `costRawOriginal` | `string` | RG (mutate) | RG | Stamp-once snapshot of `costRaw` so later passes can compare. |
| `costRawOverride` | `string \| undefined` | ADC (Item create-mode) | RG, CAC, AEC | Per-call override, e.g. `"1 IP"` for Create Item. |
| `costRawFinal` | `string \| undefined` | RG | RG, CAC, AEC | Final resolved cost string. |
| `costsNormalized` | `SpendPlan[]` | RG / ADC (passive path) | (downstream cost-spending logic) | `[{ type:"mp"\|"ip", label, req, cur, mx, curKey, maxKey }, ...]`. ADC sets this directly in `normalizePassiveCostsOrAllow` for autoPassive flow. |

### Item Use / Create

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `itemUseMode` | `"" \| "use" \| "create"` | ADF / ADC (mirror) | (downstream item handler) |
| `itemCreate` | `object \| null` | ADF | (downstream item handler) |
| `itemUsage` | `{ mode, consumeQuantity, itemUuid, itemId, itemName, isUnique, quantity, ... }` | ADF | (downstream item handler) |

### Targets

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `originalTargetUUIDs` | `string[]` (Token UUIDs) | ADF / ADC (refreshed by `refreshCanonicalTargetsAndDefense`) | TGT, CAC, AEC |
| `originalTargetActorUUIDs` | `string[]` (Actor UUIDs) | ADF / ADC | TGT, CAC, AEC |
| `targetActorUUIDs` | `string[]` (Actor UUIDs) | ADF | (legacy mirror; prefer `originalTargetActorUUIDs`) |

### Reaction / passive carry-through

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `reaction_trigger_key` | `string \| null` | ADF (seeded from caller) | ADC, AEC |
| `reaction_trigger_keys` | `string[]` | ADF | ADC |
| `reaction_phase_payload` | `object` | ADF | ADC, CLA, AEC |
| `reaction_phase_payload_by_trigger` | `object` | ADF | ADC, AEC |
| `passiveTriggerKey` | `string \| null` | ADF | ADC, CLA |
| `passiveSourceEvent` | `object` | ADF | ADC, AEC |
| `sourceActionId` | `string \| null` | ADF | ADC |
| `sourceActionCardId` | `string \| null` | ADF | ADC |
| `sourceActionCardVersion` | `number \| null` | ADF | ADC |
| `sourceActionCardMessageId` | `string \| null` | ADF | ADC |
| `sourceActionOwnerUserId` | `string \| null` | ADF | ADC |
| `sourceActionOwnerUserName` | `string \| null` | ADF | ADC |

### Custom-logic carry-through

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `customLogicActionRaw` | `string` (JS) | ADF | ADC, CLA |
| `customLogicResolutionRaw` | `string` (JS) | ADF | (resolution phase) |
| `hasCustomLogicAction` | `boolean` | ADC | CLA (early-out gate) |
| `hasCustomLogicResolution` | `boolean` | ADC | (resolution phase) |
| `customLogicActionForceLocal` | `boolean` | (caller) | CLA (skips GM executor) |

### Damage-source stamps (set by AEC during execution)

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `damageSourceName` | `string` | AEC | (damage card consumer) |
| `damageSourceKind` | `"skill" \| "spell" \| "passive"` | AEC | (damage card consumer) |
| `damageSourceIcon` | `string` | AEC | (damage card consumer) |
| `damageSourceKey` | `string` | AEC | (damage batching) |
| `damageBatchId` | `string` | AEC | AEC |
| `rootDamageBatchId` | `string` | AEC | AEC |

### Action-card identity (set by CAC + AEC)

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `actionId` | `string` | CAC / AEC | AEC |
| `actionCardId` | `string` | CAC | AEC |
| `actionCardVersion` | `number` | CAC | AEC |
| `actionCardMessageId` | `string` | CAC | AEC, top-level mirror |
| `__actionCardRenderMode` | `"create" \| "update"` | CAC | CAC |
| `invokeLockedByFumble` | `boolean` | CAC | CAC |

### Pipeline-control flags (`__` prefix = transient mutation)

These are **not part of the durable payload** — they're signaling channels
between adjacent steps. Anything writing one of these is asking the upstream
loop in ADC to abort, skip, or short-circuit.

| Field | Type | Writer | Read by | Purpose |
|-------|------|--------|---------|---------|
| `__abortPipeline` | `boolean` | TGT, CLA | ADC | "Stop the pipeline now." ADC `runTargetingShim` and `runActionPhaseCustomLogic` both check this and bail. |
| `__abortReason` | `string` | TGT, CLA | ADC | Human-readable reason. |
| `__abortNotify` | `boolean` | CLA | ADC | If true, ADC will surface `__abortReason` as a `ui.notifications.warn`. |
| `__abortNotified` | `boolean` | ADC, TGT | ADC | Idempotency: don't toast the same abort twice. |
| `__passiveSkipped` | `boolean` | CLA | (passive engine) | Custom logic explicitly opted this passive out. |
| `__passiveSkipReason` | `string` | CLA | (passive engine) | Why the passive was skipped. |
| `__customLogicAction` | `{ lastRun, error?, ... }` | CLA | CLA | Diagnostic stamp from the most recent CLA invocation. |
| `__forceLocalUiExecution` | `boolean` | (caller) | PLA, CLA | Bypass GM executor; run in the local UI context. |
| `passiveLogicForceLocal` | `boolean` | (caller) | PLA | Same intent as above, dedicated to PLA. |
| `passiveModifier` | `{ lastRun, ... }` | PLA | PLA | Diagnostic stamp from the most recent PLA invocation. |

---

## `accuracy` (null on non-check skills)

Set by `rollAccuracy` in ADC. `null` for skills where `dataCore.isCheck === false`
or required attributes are missing. Always present (with all fields populated)
for the Weapon branch.

| Field | Type | Notes |
|-------|------|-------|
| `dA` | `number` (4/6/8/10/12/20) | First die size. |
| `dB` | `number` (4/6/8/10/12/20) | Second die size. |
| `rA` | `{ total, result }` | First die result. |
| `rB` | `{ total, result }` | Second die result. |
| `total` | `number` | `rA.total + rB.total + checkBonus`. |
| `hr` | `number` | `max(rA.total, rB.total)`. |
| `isCrit` | `boolean` | True only when not a fumble. |
| `isBunny` | `boolean` | Crit AND `rA !== rB` (used for visual cue). |
| `isFumble` | `boolean` | Per actor's `fumble_threshold`, default `1+1`. |
| `forceMiss` | `boolean` | Mirror of `isFumble`. |
| `autoHit` | `boolean` | `isCrit && !isFumble`. |
| `A1`, `A2` | `string` | Attribute names rolled (`"DEX"`, etc.). |
| `checkBonus` | `number` | The bonus added before crit/fumble decisions. |
| `hrUsed` | `number \| null` | Recorded HR if not ignored. |

Read primarily by CAC (display + reaction triggers), with `isCrit`/`isFumble`
mirrored down to `advPayload`.

---

## `advPayload` (the damage-engine payload)

This is the object handed to the AdvanceDamage / damage-batch flow. Many fields
mirror `meta.*` so the downstream damage code can be passed `advPayload` alone.

| Field | Type | Writer | Read by |
|-------|------|--------|---------|
| `baseValue` | `string` (e.g. `"+5"`, `"12"`, `"0"`) | ADC | CLA (snapshot), AEC |
| `reduction` | `number` | ADC | CLA, AEC |
| `bonus` | `number` (flat + universal + weapon-type bonuses) | ADC | CLA, AEC |
| `multiplier` | `number` (default 100 = ×1.0) | ADC | CLA, AEC |
| `valueType` | `"hp" \| "mp"` | ADC | (damage engine) |
| `weaponType` | `string` (`"sword_ef"`, `"arcane_ef"`, `"none_ef"`, ...) | ADC (via `weaponTypeToEF`) | (damage engine) |
| `elementType` | `string` | ADC | PLA |
| `targetAffinity` | `"neutral"` (currently constant) | ADC | (damage engine) |
| `animationScriptRaw` | `string` (JS) | ADC | (animation handler) |
| `animation_damage_timing_options` | `string` | ADC | (animation handler) |
| `animation_damage_timing_offset` | `number` (ms) | ADC | (animation handler) |
| `ignoreDamageReduction` | `boolean` | ADC (currently always false) | (damage engine) |
| `ignoreShield` | `boolean` | ADC (currently always false) | (damage engine) |
| `attackerName` | `string` | ADC | AEC |
| `attackerUuid` | `string` | ADC | AEC |
| `attackRange` | `string` | ADC | (damage engine) |
| `sourceType` | `"Weapon" \| "Skill" \| "Attack"` | ADC | AEC |
| `isCrit` | `boolean` | ADC | AEC |
| `isFumble` | `boolean` | ADC | AEC |
| `forceMiss` | `boolean` | ADC | (damage engine) |
| `hr` | `number \| null` | ADC | AEC |
| `autoHit` | `boolean` | ADC | (damage engine) |
| `passiveApplied` | `boolean` | PLA | (mutated mid-pipeline) |
| `passiveMods` | `object` | PLA | (mutated mid-pipeline) |

**Bonus rule:** `bonus = dataCore.flatBonus + universalDamageBonus + weaponTypeDamageBonus`,
where the latter two come from actor props `extra_damage_mod_all` and
`extra_damage_mod_<type>` (see `getUniversalDamageBonus` /
`getWeaponTypeDamageBonus` in ADC). Both are zeroed out when the action is a
heal, an MP move, or a non-damage action.

---

## Mutation points

The payload is **not immutable** mid-pipeline. The places where a field is
written (or rewritten) after ADC's initial assembly:

| Writer | Mutates |
|--------|---------|
| TGT | `meta.__abortPipeline`, `meta.__abortReason`, `meta.__abortNotified`; refreshes `targets` / `originalTargetUUIDs` / `originalTargetActorUUIDs` via the user's confirmed selection. |
| ADC `refreshCanonicalTargetsAndDefense` | Re-syncs `targets`, `originalTargetUUIDs`, `originalTargetActorUUIDs`, and `meta.defenseSnapshot` after every targeting-touching step. |
| CLA | Any of the `meta.__*` flags above; `meta.__customLogicAction` (lastRun/error stamp); arbitrary fields the author chose to write. Author scripts can also rewrite `targets` and `meta.originalTargetUUIDs` — ADC re-runs `refreshCanonicalTargetsAndDefense` after CLA returns. |
| RG | `meta.costRawOriginal` (stamp-once), `meta.costRawFinal`, `meta.costsNormalized`. |
| ADC `normalizePassiveCostsOrAllow` (passive path) | Same fields as RG, but during the autoPassive bypass. |
| PLA | `meta.passiveModifier`, `advPayload.passiveApplied`, `advPayload.passiveMods`. |
| CAC | `meta.actionCardMessageId` (and top-level mirror), `meta.actionCardId`, `meta.actionCardVersion`, `meta.actionId`, `meta.invokeLockedByFumble`, `meta.invoked`, `meta.__actionCardRenderMode`. |
| AEC | `meta.executionMode`, `meta.isPassiveExecution` (re-stamps on passive forwarding), `meta.damageSource{Name,Kind,Icon,Key}`, `meta.damageBatchId`, `meta.rootDamageBatchId`, `meta.actionId`, `meta.actionCardId`, `meta.actionCardVersion`, `meta.actionCardMessageId`, top-level mirrors of those. |

---

## Branch differences

The payload's contents differ by `source`:

### Weapon branch (`source === "Weapon"`)

- `overrides` is set; `weaponUuid` is set; `skillUuid` is unset.
- `meta.isSpellish` is always `false`.
- `meta.weaponTypeLabel` mirrors `dataCore.weaponType`.
- `dataCore.listType` is hardcoded `"Attack"`.
- `accuracy` is always present (weapon attacks always roll).
- No `ignoreHR` (weapons always use HR unless overridden upstream).
- `costRaw` family is empty (weapons don't have a cost field).

### Skill / Spell branch (`source === "Skill"`)

- `skillUuid` is set; `weaponUuid` is unset.
- `overrides` is optional: `{ rolled_atr1?, rolled_atr2?, check_bonus? }`. When present, ADF reads each field from `PAYLOAD.overrides[k]` in preference to the skill's `system.props[k]`. Used by Study (player picks INS+INS vs INS+WLP at fire time) and similar dynamic-formula skills.
- `meta.isSpellish = !!dataCore.isSpell` (true for normal Spells; Offensive Spells set `dataCore.isOffSpell` separately).
- `accuracy` is `null` when `dataCore.isCheck === false`.
- `costRaw` carries the skill's `props.cost`.
- `ignoreHR`, `animTimingMode`, `animTimingOffset`, `animationScriptRaw` are all surfaced.

### Item-skill branch (`source === "Item"` in ADF)

This is a fast-path within ADF that funnels into the Skill branch in ADC. It
adds:
- `itemUseMode` (`"use"` or `"create"`)
- `itemCreate` (recipe + created item refs, only in create mode)
- `itemUsage` (consumeQuantity, isUnique, quantity)
- `meta.itemUuid`, `meta.itemName`
- `meta.costRawOverride` (when create mode redirects cost away from the skill's
  default to e.g. `"1 IP"`)

### Auto-passive (`executionMode === "autoPassive"`)

- Skips Targeting and CreateActionCard entirely.
- `targets` / `originalTargetUUIDs` / `originalTargetActorUUIDs` are seeded by
  the caller (the passive trigger) and **not** picked by the user.
- ADC runs `applyBeforeAttackEffects` → `applyPassiveModifiers` →
  `normalizePassiveCostsOrAllow` → `executeAutoPassive` (which calls
  `FUCompanion.api.actionExecution.execute(...)` directly).
- `meta.executionMode === "autoPassive"` and `meta.isPassiveExecution === true`.
- `meta.passiveTriggerKey` and `meta.passiveSourceEvent` carry the trigger
  context.

---

## Adding a new field — checklist

1. **Decide the home.** If it's display-related, prefer `core`. If it's a damage-engine input, prefer `advPayload`. Otherwise use `meta`.
2. **Write it from the earliest stage that has the data.** Usually ADF (skill/weapon item read) or ADC (computation result).
3. **Mirror it** if downstream consumers shouldn't have to know whether it lives in `meta` or top-level (this is the existing convention for `executionMode`, `isPassiveExecution`, `originalTargetUUIDs`, `actionCardMessageId`).
4. **Read it through `cardPayload?.meta?.foo ?? cardPayload?.foo ?? default`** — defensive reads survive seed payloads that don't set every field.
5. **Update this doc** with writer, readers, type, and one-line description.

If the field is a transient signaling flag (e.g. "skip this passive"), name it
with a `__` prefix and document it under "Pipeline-control flags".
