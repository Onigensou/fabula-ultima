# Keren — skill config-table interpretation (DRAFT for review)

> Status: **proposal only**, nothing written to the world. Author: Claude, 2026-06-17.
> Purpose: a per-skill `reaction_config_table` + `effect_table` interpretation of every
> *unbuilt* Keren skill, derived from the in-game descriptions, for us to walk through
> together. Each entry flags its **subsystem dependency** and **open questions**.
>
> Canon: behavior lives in `reaction_config_table` + `effect_table` rows only
> (skill-authoring-canon.md, reaction-config-schema.md). New authoring is seed-only.

## Already done (not in this doc)
- ✅ **Thermokinesis** — `creature_performs_action/self` + Fire/Ice AEs (`override_damage_type`
  + `extra_damage_mod_all = 2 + target.clock_brainwave`).
- ✅ **See You Later** — confirm → consume 1 FP → `leave_combat`.
- ✅ **Beyond the Realms of Death** — Grave-Point gain + 0-HP death-save on the marker AE.

## Live subsystem state (the gating reality, verified via bridge 2026-06-17)
| Subsystem | Field / API | State |
|---|---|---|
| Brainwave Clock | `system.props.clock_brainwave` (="0") | read-only wired (Thermokinesis). **No fill/erase lifecycle.** |
| Grave Points | "Grave Points" AE (chargeKey `grave`) | ✅ wired; `AE_CHARGES_GRAVE_POINTS` formula id. legacy `clock_grave` (=2) superseded. |
| Focus | `system.props.isFocus` (=false) | boolean exists; **no set/clear/targeting/bonus wiring.** |
| Phantasms | `FUCompanion.api.phantasm.{isPhantasm,getSummoner,markSummon}`; actor "Fox fire" | summon-mark + auto-combatant exist. **No summon-from-skill, no shatter, no live count, no redirect.** |

## Reusable knobs that ALREADY exist (no engine work)
`override_damage_type`, `extra_damage_mod_all`, `heal_receiving_mod_all` (AE change keys) ·
`damage_ignore_affinity` (deal_damage row = "ignore Resistances") · effect_kinds
`grant / consume_resource / consume_charge / apply_ae / targeting / chain / free_action /
redirect_target / adjust_accuracy / modify_damage_taken / open_action_menu` · formula ids
`SL, CUR_HP, AE_CHARGES_GRAVE_POINTS, HAS_ARCANE_WEAPON, HAS_MELEE_WEAPON, DAMAGE_DEALT, HIT_COUNT`.

---

## ⭐ RE-EVALUATION 2026-06-18 — post-Fafnir engine delta
Fafnir's full 11-skill moveset shipped (committed `2282cf1b` engine + `e97d5332` data),
introducing several general primitives. Re-scored against this doc:

**Newly available (verified in committed engine) — these LOWER difficulty:**
| Primitive | Where | Impact on Keren |
|---|---|---|
| **`summon` effect_kind** | skill-effects.js `applySummonEffect` (~5608). Fields `summon_actor` (uuid/bare-id/NAME comma-list), `summon_count`, `summon_act_this_round`. Spawns **own-turn** combatants on caster's side via `spawnLiveDirectorTokens` + `dc.addCombatant`. | **Create Phantasm: Numen (#12)** drops from "design pass" to mostly declarative — Numen's "own turn, single action" IS what `summon` produces. Strike/Dread (#10/#11) still need a **0-activation** variant (their phantasms act on Keren's turn, = `phantasm.markSummon` style); that's now a *small extension* to `summon` (add a `summon_as_phantasm`/`summon_activation:0` mode routing through markSummon), not a from-scratch build. |
| **`action_keywords: "pierce"`** | action-profile.js `parseActionKeywords` (~75); computeAffinity RS→NE, VU/IM/AB untouched. | **Create Phantasm: Strike (#10)** "ignores Resistances" → use Pierce, **not** `damage_ignore_affinity` (which wrongly skips VU/IM/AB too). Corrected below. |
| **`deal_damage` unified + `ACTION_TARGET_COUNT` in damage formulas + VFX fix** | skill-effects.js `dealDamageRun` (~2708, 3604/3632 token.uuid VFX fix); action-profile threads `payload:{targets}`. | Validates the **`deal_damage` rows in Brainwave Discharge (#6) and Zero Power (#15)** — fixed AoE damage with a working floating-number now lands. AoE-split via `300 / ACTION_TARGET_COUNT`-style formulas confirmed working. |
| `save_check` / `save_failed_targets`, `transfer_ae`, `reaction_responder:"target"`, `menu_responder:"enemy"` + `remotePickAny`, `ENEMY_IN_CRISIS`, `TARGET_CURRENT_HP` | skill-effects.js / skill-formulas.js | **No Keren skill needs saves or AE-transfer**, so N/A — but the **victim-side menu routing** (`menu_responder` / `remotePickAny`) is now proven, useful if any Keren skill later needs a target to choose. |

**Damage-authoring refinement (Fafnir convention):** HR/Check-based offensive spells put their
damage in **PROPS** (`type_damage`, `damage_bonus`, `isCheck:true`, `rolled_atr1/2`,
`defense_target_type`, `ignore_hr`) — NOT a `deal_damage` row. `deal_damage` effect rows are for
**fixed, no-Check** damage inside a chain (Cruel Ultimatum's 300 Fire / 120 Bolt). So:
Detonate Phantasm (#5, HR+25) and Create Phantasm: Strike (#10, HR+12) = **props**; Brainwave
Discharge (#6, fixed 20/30) and Zero Power (#15, fixed) = **`deal_damage` rows**. (Doc corrected.)

**Still gaps after Fafnir (UNCHANGED — Fafnir did not touch these):**
- **`shatter_summon` / despawn-summon primitive** — `summon` only *spawns*; there is no
  declarative un-summon. Still blocks Detonate (#5), Zero Power (#15), and is the natural trigger
  source for Phantasmal Echo (#1). **Build this alongside `summon`.**
- **`TARGET_HAS_<STATUS>`** — only `TARGET_STATUS_COUNT` exists (count, not per-named-status).
  Still needed by Fear Is the Key (#3) and Cognitive Focus's enemy-status filter (#7).
- **`HAS_WEAPON_CATEGORY_<X>` / `DAMAGE_IS_SPELL`** — still missing (Consume #2).
- **Focus subsystem, Brainwave registry/fill, MP-cost hook, Psychokinesis roll-time hooks,
  Illusory Shield split-damage shield** — all untouched by Fafnir; remain as in the tiers below.

---

---

# TIER 1 — pure declarative, NO new subsystem, NO Phantasm needed (build first)

> ⚠️ **Phantasmal Echo (#1) moved OUT of this tier** (was the easiest declarative skill, but it
> *reacts to a Phantasm shattering* — untestable until a Create Phantasm skill exists). It now
> lives in **Tier 4 (Phantasm subsystem)** below, sequenced after the creators. See build order.

## 2. Consume  *(Passive)*
**RAW:** "After you deal damage to one or more creatures with a spell, if you have an
arcane, dagger or flail weapon equipped, you recover [SL × 2] Mind Points."
**Maps to:** `creature_deals_damage / self`, gated to spell-sourced damage + the weapon
loadout. `HAS_ARCANE_WEAPON` exists; **dagger/flail loadout ids do NOT** — see open Q.

```jsonc
"reaction_config_table": {
  "0": {
    "reaction_trigger":      "creature_deals_damage",
    "reaction_source":       "self",
    "reaction_effect_ref":   "consume_recover",
    "reaction_passive_mode": "on",
    // gate: damage came from a spell, and reactor has a qualifying weapon equipped.
    "condition_formula":     "DAMAGE_FROM_SPELL == 1 && (HAS_ARCANE_WEAPON || HAS_DAGGER_WEAPON || HAS_FLAIL_WEAPON)"
  }
},
"effect_table": {
  "0": { "effect_label": "consume_self",   "effect_kind": "targeting", "candidate_source": "self" },
  "1": { "effect_label": "consume_recover","effect_kind": "grant",
         "grant_resource": "mp", "grant_amount": "SL * 2", "target_ref": "consume_self" }
}
```
**Dependencies / open Qs (2 small engine gaps):**
1. **`HAS_DAGGER_WEAPON` / `HAS_FLAIL_WEAPON` loadout formula ids** don't exist (only
   arcane/melee/ranged/shield/martial-armor). Cheapest add: a generic
   `HAS_WEAPON_CATEGORY_<X>` reading the equipped weapon's category — covers dagger/flail/sword
   here and future skills. (Avoids per-skill hardcode.)
2. **`DAMAGE_FROM_SPELL`** — is "the damage I just dealt came from a Spell" exposed to a
   `creature_deals_damage` payload? If not, two options: (a) fire via the skill's own
   `post_damage_effect_ref` on each spell instead of a global reaction (cleaner — only spells
   carry the ref), or (b) add a `DAMAGE_IS_SPELL` payload id. **I lean (a):** Consume becomes a
   no-reaction passive that every offensive spell's `post_damage_effect_ref` points at. ⚠️ but
   that requires every spell item to carry the ref — a reaction keyed on the actor is more
   "install once". Decision point for us.

## 3. Fear Is the Key  *(Passive)*
**RAW:** "After you cause one or more enemies to lose Hit Points, if you have acquired the
Beyond the Realms of Death Skill and at least one of them is suffering from Shaken and/or
Weak, you gain 1 Grave Point and recover [SL × 2] Hit Points and Mind Points."
**Maps to:** `creature_deals_damage / self`, enemy subject, gated on Beyond ownership +
target status. Reuses the Beyond GP-gain machinery (`add_charges` on the Grave Points AE).

```jsonc
"reaction_config_table": {
  "0": {
    "reaction_trigger":      "creature_deals_damage",
    "reaction_source":       "self",
    "reaction_action_target":"enemy",       // hit at least one enemy
    "reaction_effect_ref":   "fitk_do",
    "reaction_passive_mode": "on",
    // requires_skill: Beyond's master uniqueId (qdGOPTKJQ2YI6LUl), plus a target-status gate.
    "requires_skill":        "qdGOPTKJQ2YI6LUl",
    "condition_formula":     "TARGET_HAS_SHAKEN == 1 || TARGET_HAS_WEAK == 1"
  }
},
"effect_table": {
  "0": { "effect_label": "fitk_self", "effect_kind": "targeting", "candidate_source": "self" },
  "1": { "effect_label": "fitk_do",   "effect_kind": "chain", "chain_steps": "fitk_gp, fitk_hp, fitk_mp" },
  "2": { "effect_label": "fitk_gp",   "effect_kind": "apply_ae", "ae_template_ref": "Grave Points",
         "ae_duplicate_mode": "add_charges", "target_ref": "fitk_self" },   // +1 GP (clamps to SL+1)
  "3": { "effect_label": "fitk_hp",   "effect_kind": "grant", "grant_resource": "hp", "grant_amount": "SL * 2", "target_ref": "fitk_self" },
  "4": { "effect_label": "fitk_mp",   "effect_kind": "grant", "grant_resource": "mp", "grant_amount": "SL * 2", "target_ref": "fitk_self" }
}
```
**Dependencies / open Qs:**
- **`TARGET_HAS_SHAKEN` / `TARGET_HAS_WEAK`** status-on-subject ids — `TARGET_STATUS_COUNT`
  exists but not per-named-status. Need a `TARGET_HAS_<STATUS>` id (general, reusable for any
  "if target is X" skill). One small engine add.
- **Per-target firing:** `creature_deals_damage` fires once per affected target, so the "at
  least one is Shaken/Weak" wording would fire once per qualifying enemy → potentially +N Grave
  Points / +N heals in a multi-hit. RAW says "gain 1 / recover once." Need a once-per-action
  guard (e.g. fire on the *action's* post-resolve rather than per-target, or a `consume_charge`
  per-turn marker). **Decision point.** The Beyond GAIN row has the same per-target shape — worth
  checking how it behaves before copying.
- `add_charges` as an `ae_duplicate_mode` — confirm that's the right verb to bump the Grave
  Points AE by 1 (Beyond's `bortd_gain` uses `apply_ae … add_charges 1 / max "SL+1"`). Mirror it.

## 4. Nocebo Weapon  *(Spell)*  — AE shell already exists
**RAW:** "Make a weapon appear imbued with soul energy. Choose a damage type: Light/Dark.
Until this spell ends, all damage dealt by the weapon becomes the chosen type. If you have
that weapon equipped while casting, you may perform a free attack with it as part of the
same action. Cast only on a weapon equipped by a willing creature."
**Maps to:** an `apply_ae` (two options Light/Dark, each an AE carrying `override_damage_type`)
on a chosen willing creature, then a `free_action` limited to Attack. Two-option skill →
`Skill (Light)` / `Skill (Dark)` AE naming.

```jsonc
// Cast-time effect chain (fired from the skill body / on_activate_effect_ref):
"effect_table": {
  "0": { "effect_label": "nw_target", "effect_kind": "targeting",
         "candidate_source": "combat", "category": "ally", "mode": "exact", "count": 1 },
  "1": { "effect_label": "nw_menu",   "effect_kind": "open_action_menu",
         "menu_title": "Nocebo Weapon", "menu_subtitle": "Choose a damage type",
         "menu_option_refs": "nw_light, nw_dark",
         "menu_option_labels": "Light|Dark" },
  "2": { "effect_label": "nw_light",  "effect_kind": "apply_ae", "ae_template_ref": "Nocebo Weapon (Light)", "target_ref": "nw_target" },
  "3": { "effect_label": "nw_dark",   "effect_kind": "apply_ae", "ae_template_ref": "Nocebo Weapon (Dark)",  "target_ref": "nw_target" },
  "4": { "effect_label": "nw_free",   "effect_kind": "free_action", "allowed_types": "Attack" }
}
// AE "Nocebo Weapon (Light)" changes: [{ key: "override_damage_type", value: "light" }]   (transfer:false)
// AE "Nocebo Weapon (Dark)"  changes: [{ key: "override_damage_type", value: "dark"  }]
```
**Dependencies / open Qs:**
- The existing Nocebo AE has **zero `changes`** (no-op) — needs the `override_damage_type`
  change added (same key Thermokinesis uses). Two AEs (Light/Dark).
- **Free attack only when "that weapon equipped while casting".** `free_action` exists; gating it
  to "the buffed weapon" is loose — simplest is: offer the free Attack only when target == self
  (the common case) or always offer and trust the player. **Decision point.**
- **"Willing creature" + cast on others:** `targeting category:ally` approximates it. RAW allows
  any willing creature; ally-pick is the closest declarative fit.

---

# TIER 2 — fixed / Brainwave damage (no Phantasm needed)

> ⚠️ **Detonate Phantasm (#5) moved OUT of this tier** — it detonates an *existing* Phantasm (needs
> both a creator and the shatter primitive), so it now lives in **Tier 4 (Phantasm subsystem)**
> below, after the creators. See build order.

## 6. Brainwave Discharge  *(Active)*
**RAW:** "While your Brainwave Clock is full, erase all sections. Then choose: 20 Physical to
every enemy on the scene, OR 30 Physical to a single enemy. (Lv20: 30/40. Lv40: 40/50.)"
**Maps to:** a gated active — affordability-style gate on "clock full" → erase clock → AoE or
single damage. SL-banded damage numbers.

```jsonc
"reaction_config_table": {},   // not a reaction — fired as an Active turn-action
"effect_table": {
  "0": { "effect_label": "bd_gate",   "effect_kind": "consume_resource",
         "grant_resource": "brainwave", "grant_amount": "CLOCK_BRAINWAVE_MAX", "on_empty": "abort",
         "target_ref": "bd_self" },        // spend = "must be full"; sets clock to 0
  "1": { "effect_label": "bd_self",   "effect_kind": "targeting", "candidate_source": "self" },
  "2": { "effect_label": "bd_menu",   "effect_kind": "open_action_menu",
         "menu_title": "Brainwave Discharge", "menu_option_refs": "bd_all, bd_single",
         "menu_option_labels": "All enemies|Single enemy" },
  "3": { "effect_label": "bd_all",    "effect_kind": "deal_damage", "type_damage": "physical",
         "damage_amount": "20 + (SL>=2)*10 + (SL>=4)*10", "target_ref": "bd_enemies_all" },
  "4": { "effect_label": "bd_single", "effect_kind": "deal_damage", "type_damage": "physical",
         "damage_amount": "30 + (SL>=2)*10 + (SL>=4)*10", "target_ref": "bd_enemy_one" },
  "5": { "effect_label": "bd_enemies_all","effect_kind": "targeting", "candidate_source": "combat", "category": "enemy", "mode": "all" },
  "6": { "effect_label": "bd_enemy_one",  "effect_kind": "targeting", "candidate_source": "combat", "category": "enemy", "mode": "exact", "count": 1 }
}
```
**Dependencies / open Qs:**
- **Brainwave clock as a spendable resource:** `clock_brainwave` is a plain `system.props`
  string, not in the RESOURCE_REGISTRY. Two routes: (a) register `brainwave` in the resource
  registry (then `consume_resource` + `CLOCK_BRAINWAVE` / `CLOCK_BRAINWAVE_MAX` formula ids work
  cleanly — and this also serves Life Transference & the "fill" lifecycle), or (b) model the clock
  as a charged AE like Grave Points. **Recommend (a)** — clocks are first-class FU mechanics; a
  registry row + two formula ids is the smallest durable fix. ⭐ This is the **Brainwave subsystem
  foundation** — do it before Life Transference too.
- **SL-band damage:** Lv20 = SL≥2, Lv40 = SL≥4? Need to confirm Keren's SL↔level mapping (the
  "Skill Enhancement Lv20/40" wording is character-level, not SL). May be cleaner as literal level
  read than SL. **Decision point.**
- `deal_damage` effect_kind for the AoE (already used by monster skills, e.g. Marigold) — confirm
  it's the right primary here vs. a normal damage-section action. Since this is "fixed Physical,
  no Check," `deal_damage` rows fit.

---

# TIER 3 — Focus subsystem (foundational; unlocks 3 skills)

⭐ **Build the Focus subsystem first.** Proposed shape (mirrors Grave Points / clock work):
- A **"Focus" AE** applied to the chosen creature, `flags…{focusOf: <Keren actor uuid>}`,
  `statuses:["fud-focus"]`, lifetime "until start of my next turn" (turn-scoped).
- Formula ids: `SUBJECT_IS_MY_FOCUS` (reaction gate) and a targeting `candidate_source: "my_focus"`.
- Cognitive Focus applies it; Hypercognition + Life Transference read it.

## 7. Cognitive Focus  *(Active)* — builds the subsystem
**RAW:** "At the start of your turn, choose one ally who can hear you, or one enemy you can see
suffering from Dazed/Enraged/Shaken. Until the start of your next turn, that creature is your
focus. +[SL] to Checks to examine focus, +[SL] to your Accuracy/Magic Checks for Attacks/
Offensive Spells that include focus among targets. When you cause focus to recover HP/MP, they
recover [SL × 2] additional."

```jsonc
"reaction_config_table": {
  "0": { "reaction_trigger": "turn_start", "reaction_source": "self",
         "reaction_effect_ref": "cf_set", "reaction_passive_mode": "ask" }  // "may" → player picks at own turn
},
"effect_table": {
  "0": { "effect_label": "cf_pick_enemy", "effect_kind": "targeting", "candidate_source": "combat",
         "category": "enemy", "mode": "exact", "count": 1, "condition": "Dazed|Enraged|Shaken" },
  "1": { "effect_label": "cf_pick_ally",  "effect_kind": "targeting", "candidate_source": "combat",
         "category": "ally", "mode": "exact", "count": 1 },
  "2": { "effect_label": "cf_menu", "effect_kind": "open_action_menu",
         "menu_title": "Cognitive Focus", "menu_option_refs": "cf_ally, cf_enemy",
         "menu_option_labels": "Focus an ally|Focus an enemy (Dazed/Enraged/Shaken)" },
  "3": { "effect_label": "cf_ally",  "effect_kind": "apply_ae", "ae_template_ref": "Focus", "target_ref": "cf_pick_ally" },
  "4": { "effect_label": "cf_enemy", "effect_kind": "apply_ae", "ae_template_ref": "Focus", "target_ref": "cf_pick_enemy" }
}
// "Focus" AE: flags…{focusOf: Keren.uuid}; statuses ["fud-focus"]; lifetime my-next-turn-start.
//   It carries NO bonus itself — Keren's own passives read "is this my focus" (below).
```
The +SL accuracy/magic-when-focus-is-targeted and the SL×2 healing-amplify are **Keren-side
modifiers gated on "target is my focus"**, not bonuses on the Focus AE:
```jsonc
// On the Cognitive Focus skill item, passive modifier formulas (Phase E props):
"passive_check_bonus_formula":  "SL * ACTION_TARGETS_MY_FOCUS",   // +SL when an attack/offensive spell includes focus
// Healing amplify: a heal_receiving_mod fired only toward the focus, or a grant uplift gated on SUBJECT_IS_MY_FOCUS.
```
**Dependencies / open Qs (this is the big one):**
1. **Targeting `condition`/status filter on the candidate pool** (enemy must be Dazed/Enraged/
   Shaken) — `targeting` rows have no status filter today. Needs adding (reusable).
2. **"Includes focus among targets" gate** — need `ACTION_TARGETS_MY_FOCUS` (1 if the action's
   target list contains the focus). New formula id.
3. **Healing-amplify toward focus** — "+SL×2 when *I* cause focus to recover" overlaps
   `heal_receiving_mod_all` but that's a fraction on the *healed* actor regardless of healer. We
   need "extra when the healer is Keren AND healed is Keren's focus." Likely a new reaction on
   `creature_recovers_hp`/`_mp` gated `DAMAGE_SOURCE_IS_SELF && SUBJECT_IS_MY_FOCUS` → top-up grant.
4. **"Examine focus" +SL** — Study/Insight checks outside the action pipeline; passive check-bonus
   formula doesn't cover open checks (documented coverage caveat). Likely deferred/narrative.

## 8. Hypercognition  *(Passive)*
**RAW:** "Total MP cost of your spells/verses that include your focus among targets is reduced
by [SL], or [SL × 2] if your focus is the only target (min 0)."
**Maps to:** an MP-cost discount hook at cast time. **This is the known engine gap** (memory:
IP/MP-cost discount hook). No declarative path exists yet.
```jsonc
// Proposed skill prop (NEW knob), not a reaction:
"spell_mp_cost_mod_formula": "-(SL + SL * FOCUS_IS_ONLY_TARGET) * ACTION_TARGETS_MY_FOCUS"
// resolved at cost-computation time; clamps total to >= 0.
```
**Dependencies:** new `spell_mp_cost_mod_formula` cost hook + `FOCUS_IS_ONLY_TARGET` id +
`ACTION_TARGETS_MY_FOCUS` (shared with Cognitive Focus). Build after Focus subsystem.

## 9. Life Transference  *(Active / trigger)*
**RAW:** "Trigger: When you cause one or more enemies to lose Hit Points. Choose yourself or an
ally who is your focus: if the chosen creature is in Crisis, they recover [5 + (filled Brainwave
sections × 5)] HP."

```jsonc
"reaction_config_table": {
  "0": { "reaction_trigger": "creature_deals_damage", "reaction_source": "self",
         "reaction_action_target": "enemy", "reaction_effect_ref": "lt_heal",
         "reaction_passive_mode": "ask" }   // "choose" → player picks self or focus-ally
},
"effect_table": {
  "0": { "effect_label": "lt_pick", "effect_kind": "targeting", "candidate_source": "self_or_my_focus", "mode": "exact", "count": 1 },
  "1": { "effect_label": "lt_heal", "effect_kind": "grant", "grant_resource": "hp",
         "grant_amount": "5 + CLOCK_BRAINWAVE * 5", "target_ref": "lt_pick",
         "condition_formula": "TARGET_IN_CRISIS == 1" }
}
```
**Dependencies / open Qs:**
- `CLOCK_BRAINWAVE` formula id (from the Brainwave registry work, skill #6).
- `candidate_source: "self_or_my_focus"` — composite pool (self + the focus). New targeting source
  (Focus subsystem).
- `TARGET_IN_CRISIS` per-recipient gate — Beyond used `TARGET_AE_COUNT_CRISIS > 0` on the subject;
  here the gate is on the *heal recipient*. Confirm the formula evaluates against the grant target.
- Same per-target multi-fire concern as Fear Is the Key (fires per enemy hit) → once-per-action guard.

---

# TIER 4 — Phantasm subsystem (CREATORS FIRST, then consumers)

⭐ **Dependency rule:** every phantasm-*consuming* skill needs a phantasm on the board, so the
**creators are built and tested first**, then the consumers. Build order within this tier:

1. **#10 Create Phantasm: Strike** — foundational creator. Builds the summon primitives
   (`summon` 0-activation mode, count cap). Once this works, a Phantasm can exist to test the rest.
2. **#11 Create Phantasm: Dread** — second creator (reuses the summon primitive + status apply).
3. **#5 Detonate Phantasm** *(moved from Tier 2)* — first consumer; also builds the
   **`shatter_summon`** primitive + `own_summons` targeting. Gives a controlled way to shatter.
4. **#1 Phantasmal Echo** *(moved from Tier 1)* — reacts to a shatter; now testable (shatter a
   Strike phantasm via Detonate, or let one die in combat).
5. **#12 Create Phantasm: Numen** — heaviest creator (own-turn summon + Numen actor + constraints).

Shared primitives this tier builds: `summon` 0-activation/phantasm mode · `shatter_summon` /
despawn · `own_summons` targeting source · a live phantasm-count read (for caps + re-command).

## 10. Create Phantasm: Strike  *(Spell)*
**RAW:** "Spend one action to create a Phantasm and command it to attack. Target suffers
[HR + 12] damage (Lv20: 16, Lv40: 18). Range = current weapon. On later turns, action + Magic
Check to re-command with no MP. Damage ignores Resistances."
**Damage = PROPS** (HR-based Magic Check): `isCheck:true`, INS+WLP, `type_damage:"physical"`,
`damage_bonus:"12"` (Lv20→16, Lv40→18), **`action_keywords:"pierce"`** (RAW "ignores Resistances"
= Pierce, RS→NE; leaves VU/IM/AB — corrected from the earlier `damage_ignore_affinity`).
```jsonc
// PROPS: isCheck true / rolled ins+wlp / type_damage physical / damage_bonus per level / action_keywords "pierce"
"effect_table": {
  "0": { "effect_label": "cps_summon", "effect_kind": "summon", "summon_actor": "Fox fire",
         "summon_count": 1, "summon_act_this_round": false }   // ⚠ see dependency: needs 0-activation mode
}
```
**Dependencies:**
- **0-activation summon variant.** Fafnir's `summon` spawns **own-turn** combatants; a Phantasm
  acts on *Keren's* turn (0 activations, `markSummon` style). Need a `summon` mode flag
  (`summon_as_phantasm:true` / `summon_activation:0`) that routes through `phantasm.markSummon`
  instead of `dc.addCombatant`. Small extension now that `summon` exists.
- **`action_keywords:"pierce"`** ✅ exists (Fafnir Condemn). Use it for "ignores Resistances".
- **Re-command flow** — a separate "command existing phantasm to attack again, no MP" action, or
  the same skill detecting an existing own-phantasm and skipping the summon. Design decision.
- **Count cap (max 4 / one Numen)** — needs a live phantasm-count read; small helper.

## 11. Create Phantasm: Dread  *(Spell)*
**RAW:** "Conjure a terrifying Phantasm. Choose: it inflicts Weak, or Shaken. Inflicts the
chosen status on the target hit. Later turns: re-command with no MP."
```jsonc
"effect_table": {
  "0": { "effect_label": "cpd_target", "effect_kind": "targeting", "candidate_source": "combat", "category": "enemy", "mode": "exact", "count": 1 },
  "1": { "effect_label": "cpd_summon", "effect_kind": "summon", "summon_actor": "Fox fire", "summon_count": 1, "summon_act_this_round": false },  // ⚠ 0-activation mode (see #10)
  "2": { "effect_label": "cpd_menu",   "effect_kind": "open_action_menu", "menu_option_refs": "cpd_weak, cpd_shaken", "menu_option_labels": "Weak|Shaken" },
  "3": { "effect_label": "cpd_weak",   "effect_kind": "apply_ae", "ae_template_ref": "Weak",   "target_ref": "cpd_target" },
  "4": { "effect_label": "cpd_shaken", "effect_kind": "apply_ae", "ae_template_ref": "Shaken", "target_ref": "cpd_target" }
}
```
**Dependencies:** `summon` 0-activation mode (shared with #10) · Weak/Shaken AE templates (should
exist as common debuffs) · re-command flow.

## 5. Detonate Phantasm  *(Spell)*  — moved from Tier 2 (consumer)
**RAW:** "Overflow one Phantasm, making it explode. Choose a damage type: Light/Dark. The
target hit suffers [HR + 25] damage of the chosen type. This shatters the Phantasm."
**Maps to:** a normal offensive-spell damage action in **PROPS** (`isCheck:true`, INS+WLP Magic
Check, `type_damage` = chosen element via two-option menu, `damage_bonus:"25"`) **+ a shatter step**
in the effect chain.

```jsonc
// PROPS (Fafnir convention for HR/Check spells): isCheck true, rolled_atr1 ins / rolled_atr2 wlp,
//   defense_target_type mdef, type_damage = chosen element (Light/Dark menu), damage_bonus "25".
// Effect chain adds the shatter:
"effect_table": {
  "0": { "effect_label": "dp_phantasm", "effect_kind": "targeting",
         "candidate_source": "own_summons", "mode": "exact", "count": 1 },   // ← pick one of MY phantasms
  "1": { "effect_label": "dp_shatter",  "effect_kind": "shatter_summon", "target_ref": "dp_phantasm" }
}
```
**Dependencies / open Qs:**
- **`shatter_summon` effect_kind STILL does NOT exist** (confirmed 2026-06-18 — Fafnir's `summon`
  only spawns). Need a knob: "set this summon's HP to 0 / remove the token", which then fires
  `creature_defeated` (→ feeds Phantasmal Echo). Core Phantasm-shatter primitive that **Zero Power
  and Illusory Shield also need** — build once here, as the despawn half of the `summon` family.
- **`own_summons` targeting source** — also still missing (summon tags tokens `summonedBy/isSummon`
  but no targeting `candidate_source` reads them yet). Small add; reused by Zero Power.
- **Two-element pick** like Nocebo (Light/Dark) — same `open_action_menu` pattern, or two skill
  variants. **Decision point:** menu vs two-card.

## 1. Phantasmal Echo  *(Passive)*  — moved from Tier 1 (consumer)
**RAW:** "After any of your Phantasms is shattered, you recover [SL + 2] MP."
**Maps to:** the canonical `creature_defeated` + `isPhantasm` + `own_summon` pattern
(reaction-config-schema worked example). Shatter == phantasm HP→0, which the universal
`creature-defeated-emitter` already fires for friendly summons.

```jsonc
"reaction_config_table": {
  "0": {
    "reaction_trigger":      "creature_defeated",
    "reaction_source":       "all",
    "reaction_subject_kind": "isPhantasm",
    "reaction_ownership":    "own_summon",
    "reaction_effect_ref":   "pe_recover",
    "reaction_passive_mode": "on"          // auto, player-visible
  }
},
"effect_table": {
  "0": { "effect_label": "pe_self",   "effect_kind": "targeting", "candidate_source": "self" },
  "1": { "effect_label": "pe_recover","effect_kind": "grant",
         "grant_resource": "mp", "grant_amount": "SL + 2", "target_ref": "pe_self" }
}
```
**Dependency:** the config is trivial (works today), but **testing requires a phantasm to shatter** —
hence its placement here after Strike (#10) + Detonate (#5). **Open Q:** the 35-day-old memory had
PE wired with the retired `reaction_isPassive` flag — confirm the live copy is migrated to
`reaction_passive_mode` and uses an `effect_ref` (above) rather than the old "skill body restores MP
via type_damage:MP" approach. Recommend the explicit `grant` row above.

## 12. Create Phantasm: Numen  *(Active)*
**RAW (summary):** raises Phantasm cap to 4 (one must be Numen, max one Numen); Numen costs
50 MP, has PV = 2× base Insight die + level, takes its own turn with a single action, can't be
used by other Illusionist skills.
**Assessment (UPGRADED 2026-06-18):** Fafnir's **`summon` effect_kind already produces own-turn
combatants** — exactly Numen's "has its own turn and a single action." So the mechanical core is now
declarative, not a design pass:
```jsonc
"effect_table": {
  "0": { "effect_label": "numen_summon", "effect_kind": "summon", "summon_actor": "Numen",
         "summon_count": 1, "summon_act_this_round": false }
}
// PROPS / cost: native cost "50 MP" (skill-cost.js gates+debits via the resource registry).
```
**Remaining work (smaller than before):** (1) a **Numen actor** must exist (PV = 2× base Insight
die + level — set on the actor, or a derive hook); (2) the "max 4 phantasms / max one Numen / can't
be used by other Illusionist skills" **constraints** need a count+kind guard (shared with Strike/
Dread's cap). The hard part ("own turn") is solved by `summon`. Still the heaviest of the three
Create-Phantasm skills, but no longer a from-scratch subsystem.

---

# TIER 5 — roll-time hook

## 13. Psychokinesis  *(Passive)*
**RAW:** "When you perform an Accuracy Check, you may replace one Attribute die with Willpower
(e.g. [DEX + WLP] for a shortbow). Additionally, your melee attacks with arcane or sword
weapons may target Flying creatures."
**Assessment:** two **roll-time / targeting-legality** hooks, neither declarative today:
1. **Attribute-die→WLP swap** at Accuracy-Check assembly — there's an `attribute-pair-picker`
   in the BD; the cleanest path is a per-actor "may swap one die to WLP" option surfaced there
   when this skill is owned. **New engine hook** (roll-time), not a reaction row.
2. **Melee arcane/sword can target Flying** — a targeting-legality exception in the JRPG matrix.
   **New flag** (`can_target_flying_with: ["arcane","sword"]`) read by the legality check.
**Dependencies:** both are engine hooks; no config-table representation. List as design items.

---

# TIER 6 — capstones (full subsystems)

## 14. Illusory Shield  *(Spell — reaction)*
**RAW:** "When another creature is threatened by an Attack/Spell/other danger, command one
Phantasm to take their place. Checks part of the danger are performed against the Phantasm. The
Phantasm shields the creature, suffering damage = its remaining PV until it shatters; remaining
damage goes to the defended creature. All status effects related to the attack are nullified."
**Maps to:** a Protect-shaped **`redirect_target`** reaction, but the destination is a Phantasm
(not self), with **partial damage absorption** (phantasm soaks up to its PV, overflow passes
through) and **status nullification**.
```jsonc
"reaction_config_table": {
  "0": { "reaction_trigger": "creature_targeted_by_action", "reaction_source": "ally",
         "reaction_action_intent": "harmful", "reaction_effect_ref": "is_do", "reaction_passive_mode": "ask" }
},
"effect_table": {
  "0": { "effect_label": "is_do",        "effect_kind": "chain", "chain_steps": "is_redirect" },
  "1": { "effect_label": "is_redirect",  "effect_kind": "redirect_target",
         "target_ref": "is_incoming", "destination_ref": "is_phantasm", "rebuild_card": true },
  "2": { "effect_label": "is_incoming",  "effect_kind": "targeting", "candidate_source": "action_targets", "mode": "exact", "count": 1 },
  "3": { "effect_label": "is_phantasm",  "effect_kind": "targeting", "candidate_source": "own_summons", "mode": "exact", "count": 1 }
}
```
**Dependencies (heaviest reaction):** `redirect_target` exists ✅ but RAW needs (a) **PV-capped
absorption with overflow to the original target** (no current effect_kind splits damage across two
creatures), (b) **status-nullification on the redirected danger**, (c) Phantasm-as-defender +
auto-shatter when PV hits 0. Realistically a dedicated `shield_redirect` effect_kind. Big.

## 15. Zero Power: Last Den of Cinders  *(Active — Zero Power)*
**RAW:** "Shatter all phantoms. Deal [(shattered × 20) + 20] Fire damage to all enemies."
```jsonc
"effect_table": {
  "0": { "effect_label": "zp_phantasms", "effect_kind": "targeting", "candidate_source": "own_summons", "mode": "all" },
  "1": { "effect_label": "zp_count",     "effect_kind": "shatter_summon", "target_ref": "zp_phantasms" },  // returns count → SHATTERED_COUNT
  "2": { "effect_label": "zp_enemies",   "effect_kind": "targeting", "candidate_source": "combat", "category": "enemy", "mode": "all" },
  "3": { "effect_label": "zp_damage",    "effect_kind": "deal_damage", "type_damage": "fire",
         "damage_amount": "(SHATTERED_COUNT * 20) + 20", "target_ref": "zp_enemies" }
}
```
**Dependencies:** Zero-Power framework (cost/availability gate — `zero_power` resource exists in
the registry) · `shatter_summon` (shared) that **reports a count** consumable as
`SHATTERED_COUNT` · `own_summons` targeting source. Build last.

---

# Summary — recommended build order & the shared primitives to build first

**Build now (Tier 1, ~zero engine work):** Nocebo Weapon (#4, just AE-change + free_action), then
Fear Is the Key (#3) and Consume (#2) once two small formula-id adds land (`TARGET_HAS_<STATUS>`,
`HAS_WEAPON_CATEGORY_<X>`/`DAMAGE_IS_SPELL`).
> Phantasmal Echo (#1) is config-trivial but **deferred to Tier 4** — it can't be tested without a
> Phantasm on the board, so it's sequenced after the creators (Strike #10 → Detonate #5 → Echo #1).

**Shared primitives that unblock the most skills (build these next, in order):**
1. **Brainwave registry + `CLOCK_BRAINWAVE` formula id + fill/erase lifecycle** → unblocks
   Brainwave Discharge (#6) and Life Transference (#9).
2. **Focus AE subsystem** (`Focus` AE + `SUBJECT_IS_MY_FOCUS` + `ACTION_TARGETS_MY_FOCUS` +
   `self_or_my_focus` targeting source) → unblocks Cognitive Focus (#7), Hypercognition (#8, also
   needs the MP-cost hook), Life Transference (#9).
3. **Phantasm summon/shatter (POST-FAFNIR: half-built).** `summon` effect_kind now exists (own-turn
   spawns) — Numen (#12) uses it directly. Still to build: a **`summon_as_phantasm` / 0-activation
   mode** (Strike/Dread phantasms act on Keren's turn), a **`shatter_summon`/despawn** effect_kind
   (Detonate #5, Zero Power #15, Phantasmal Echo trigger), and an **`own_summons` targeting source**.
   These three are the remaining phantasm work.
4. **Small formula-id adds (cheap, unblock T1):** `TARGET_HAS_<STATUS>` (#3, #7),
   `HAS_WEAPON_CATEGORY_<X>` + `DAMAGE_IS_SPELL` (#2).

**Defer to design passes:** Psychokinesis (#13, roll-time die-swap + Flying-legality), Illusory
Shield (#14, split-damage shield redirect — `redirect_target` is now robust on AoE but the
PV-absorption/overflow + status-nullification half is unbuilt). Create Phantasm: Numen (#12) is
**no longer a defer** — `summon` covers its core; only the Numen actor + count constraints remain.

**Cross-cutting open question:** several "after you cause enemies to lose HP" passives
(#2/#3/#9) fire **per affected target**. Decide a single once-per-action convention (fire on the
action's post-resolve, or a per-turn `consume_charge` marker) and apply it uniformly — Beyond's
GAIN row already has this shape, so check its live behavior first.
