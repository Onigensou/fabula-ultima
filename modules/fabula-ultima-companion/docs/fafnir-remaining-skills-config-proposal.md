# Fafnir — config-table proposal for the 3 remaining skills

DRAFT for review (2026-06-17). Nothing applied to the world — these are proposed
`reaction_config_table` / `effect_table` rows + AE definitions, grounded in
existing engine primitives. Field shapes mirror the already-built Fafnir skills
(Rend rider, Dreadwyrm chain/save, Torment redirect, Storm Calm grant).

Fafnir actor `P1uCkpNnxLRBNqZr`. Remaining skills:

| Skill | Item id | Type | Cost |
|---|---|---|---|
| Searing Brand | `eLMFbgeZkVWUbE0i` | Spell | 30 MP |
| Zero Power: Cruel Ultimatum | `mZnxgj2JnNYO2Hat` | Active | 6 Zero Power |
| Summon Elemental Drake | `C286kW050ikBQ85g` | Active | — |

Legend: ✅ uses existing primitive · ⚠ open design question · 🔧 needs an engine
knob that does not exist yet.

---

## 1. Searing Brand  ✅ data + 🔧 3 new engine knobs (Q1/Q2 resolved 2026-06-18)

> RAW: *"Place a Draconic Curse on a target. For 3 Rounds, if the target takes
> damage, the mark explodes, dealing bonus 50 Fire damage to the marked target.
> At the beginning of the marked creature's turn, they may transfer the mark to
> an ally as a Free Action."*

**Interpretation:** a transferable debuff *mark*. Cast → apply the "Searing Brand"
AE to one target. The AE carries TWO reactions: (a) **force** explode whenever the
bearer takes damage, (b) **ask** at the bearer's turn-start to hand the mark to an
ally as a free action. Effect rows live on the *skill* (resolved from the AE via
`directorAppliedBy.skillUuid`, per the AE-carried-reaction-context contract); the
AE only carries the trigger rows.

### Skill props
- `on_activate_effect_ref: "sb_mark"`
- `action_intent: "harmful"` — debuff-only spell, so Protect/redirect is offered
  (same override Torment/Dreadwyrm/Domination need).
- damage props stay empty — the cast deals no damage; the explosion is the AE reaction.

### effect_table (on the Searing Brand skill)
| effect_label | effect_kind | key fields |
|---|---|---|
| `sb_mark` | apply_ae | `ae_template_ref:"Searing Brand"`, `target_ref:"action_targets"`, `ae_duplicate_mode:"replace"` |
| `sb_explode` | deal_damage | `damage_element:"fire"`, `damage_amount:"50"`, `target_ref:"self"`, `damage_cause:"damage"` (attacker = mark applier / Fafnir — see Q1) |
| `sb_transfer` | chain | `chain_steps:"sb_pick,sb_move"` |
| `sb_pick` | targeting | `candidate_source:"combat"`, `category:"ally"`, `exclude_self:true`, `mode:"exact"`, `count:"1"` |
| `sb_move` | **transfer_ae** 🔧 | `ae_template_ref:"Searing Brand"`, `from_ref:"self"`, `target_ref:"sb_pick"` — MOVE the existing AE preserving its remaining charges (NOT a fresh apply) |

### New AE: "Searing Brand" (hub `XVOWOq9oUmEECGrU`, like Bleed/Charmed)
- `statuses:["fud-searing-brand"]`, `tags:["debuff"]`, `transfer:false`
- **charge-driven:** `chargeKey:"searing_brand"`, `charges:3`, `chargesMax:3`
- `lifetimeMode:"target_turn_start"` 🔧 — tick (decrement a charge) at the **bearer's**
  turn-start, BEFORE the transfer ask fires (Q2)
- `duration.rounds:3` (cosmetic mirror of the charge count)
- `changes:[]` (no stat mods)
- `flags["fabula-ultima-companion"].reactionConfig` rows:
  - `{reaction_trigger:"creature_takes_damage", reaction_source:"self", reaction_passive_mode:"force", reaction_effect_ref:"sb_explode"}`
  - `{reaction_trigger:"turn_start", reaction_source:"self", reaction_passive_mode:"ask", reaction_effect_ref:"sb_transfer"}` — routed to the **bearer's** client (Q3)

### Resolved decisions (2026-06-18)
- **✅ Q1 — explosion source + loop.** The explosion is attributed to the **caster
  (Fafnir)** — `damage_cause:"damage"`, attacker = the AE's applier (resolved from
  `directorAppliedBy`). The loop is killed at the ENGINE level, not per-skill:
  **`creature_takes_damage` no longer re-triggers from damage caused within its own
  reaction chain** (general re-entrancy guard, the new default).
- **✅ Q2 — tick before ask + charge preserved on move.** Mark is charge-driven and
  ticks at the **bearer's turn-start** via the new `lifetimeMode:"target_turn_start"`,
  ordered BEFORE the `turn_start` reaction dispatch so an expired mark offers no
  transfer. The transfer **moves** the AE (`transfer_ae`) keeping the same remaining
  charge — it does NOT re-apply a fresh 3-charge mark.
- **✅ Q3 — transfer ownership.** When a PC bears the mark, the `ask` transfer prompt
  routes to that PC's client via the remote-prompt seam.

### ⚙️ AS-BUILT (2026-06-18) — one design correction
Built + syntax-clean + data authored; **needs Ctrl+Shift+R then battle-verify.**
- **Trigger correction:** the explosion does NOT use `creature_takes_damage` — that
  trigger is consumed ONLY by the incoming-damage adjuster (Mercy-clamp path), never
  dispatched for `deal_damage`. The explosion hangs off the resource-ledger event
  instead: `reaction_trigger:"creature_lose_resource"`, `reaction_resource_filter:"hp"`,
  `reaction_source:"self"`, mode `on`. (Any HP-loss cause detonates it — matches "if the
  target takes damage".)
- **Transfer row** uses `reaction_source:""` (empty) — `turn_start` is a lifecycle
  trigger with a null event subject, so a `self` filter would never match.
- **Q3 routing:** the "may transfer" menu already routes to the bearer's player owner
  via the existing owner-aware standalone reaction menu — no new code. The secondary
  ally-pick rides the in-flight remote-pick seam (verify in the 2-client pass).
- Effect rows live on the AE's own `reactionConfig.effect_table` (self-contained);
  the AE resolves its origin skill via `directorAppliedBy.skillUuid` for attribution.

### Engine work this skill requires (general, reusable — per the no-hardcode rule)
1. 🔧 **`creature_takes_damage` re-entrancy guard** — a reaction's own damage does
   not re-enter the same trigger's dispatch. [Q1]
2. 🔧 **AE-reaction `deal_damage` attribution** — reaction-fired damage from an AE
   credits the AE's applier as attacker (so `damage_cause:"damage"` reads as
   Fafnir-inflicted). [Q1]
3. 🔧 **`lifetimeMode:"target_turn_start"`** — new bearer-turn-start charge tick at
   `TURN_START`, placed before the turn_start reaction window. (Engine currently has
   only `on_activation` / `round_end` / `target_turn_end`.) [Q2]
4. 🔧 **`transfer_ae` effect_kind** — move an AE by name from `from_ref` to
   `target_ref`, preserving remaining charges/duration. (No move/transfer primitive
   exists today.) [Q2]
5. **turn_start `ask` remote-routed to the bearer** — wire the existing remote-prompt
   seam. [Q3]

---

## 2. Zero Power: Cruel Ultimatum  ⚠ (victim-side choice routing)

> RAW: *"Offer the enemy a vile edict. **Enemy Choose:** (a) one target enemy takes
> 300 Fire damage (enemy's choice which); (b) all enemies take 120 Bolt damage."*

**Interpretation:** spend 6 Zero Power, then the **enemy side** picks which of two
outcomes happens. A `consume_resource` for the cost, then an `open_action_menu`
with two branches — but the menu must be answered by an enemy, not Fafnir's GM.

### Skill props
- `on_activate_effect_ref: "cu_unleash"`
- `action_intent: "harmful"`
- `cost:"6 Zero Power"` (display)

### effect_table
| effect_label | effect_kind | key fields |
|---|---|---|
| `cu_unleash` | chain | `chain_steps:"cu_cost,cu_choice"` |
| `cu_cost` | consume_resource | `consume_resource:"zero_power"`, `consume_amount:"6"`, `target_ref:"self"` |
| `cu_choice` | open_action_menu | two options (below) |
| `cu_pick_one` | targeting | `candidate_source:"combat"`, `category:"enemy"`, `mode:"exact"`, `count:"1"` |
| `cu_300` | deal_damage | `damage_element:"fire"`, `damage_amount:"300"`, `target_ref:"cu_pick_one"`, `damage_cause:"damage"` |
| `cu_all` | targeting | `candidate_source:"combat"`, `category:"enemy"`, `mode:"all"` |
| `cu_120` | deal_damage | `damage_element:"bolt"`, `damage_amount:"120"`, `target_ref:"cu_all"`, `damage_cause:"damage"` |

`cu_choice` options:
- **A — "One enemy takes 300 Fire"**: `effect_kind:"chain"`, `chain_steps:"cu_pick_one,cu_300"`
- **B — "All enemies take 120 Bolt"**: `effect_kind:"chain"`, `chain_steps:"cu_all,cu_120"`

### ⚙️ AS-BUILT (2026-06-18) — needs Ctrl+Shift+R + 2-client battle test
Built + syntax-clean + data authored. **Decisions:** the "Enemy Choose" routes to the
**enemy players, loudest wins** (Q4/Q5 = broadcast to all enemy players, first to answer
wins; the winner then also picks which enemy eats branch A's 300).
- New declarative knob `menu_responder:"enemy"` on the `open_action_menu` row → at the pick,
  the engine resolves the active players owning an enemy-disposition token and routes via a
  new `remotePickAny` (multi-target broadcast + first-fulfilled race + force-close the losers'
  pickers via MENU_CLOSE→`externalCancel`). Winner's userId is returned so the follow-on
  "which enemy" target pick (`ctx.remotePrompt`) lands on the same player.
- **Fallback:** no enemy player online / nobody answers → GM resolves the menu locally, so the
  action never stalls.
- **Cost FIRST** (`cu_cost,cu_choice`): insufficient Zero Power aborts before any damage.
- Zero Power resource was already fully wired (registry `zero_power`→`zero_power_value`, cap 6;
  grant + consume + affordability all registry-driven) — no resource work needed.
- Files: `remote-pick.js` (remotePickAny + player close-hook), `skill-effects.js`
  (`menu_responder` branch + `resolveEnemyPlayerUserIds`). Engine → Ctrl+Shift+R.
- ⚠ Verify in battle: a no-target Active casts cleanly (TARGET phase skips); 2-client loudest-wins
  race + loser pickers dismiss; 1-client GM-fallback; 6 ZP debits; 300 Fire / 120 Bolt land.

### Open questions (original — now resolved above)
- **⚠ Q4 — who answers the menu.** `open_action_menu` is normally the CASTER's
  pick at apply-click → here that's Fafnir's GM. RAW gives the choice to the ENEMY.
  Options: (i) GM picks on the enemies' behalf (simplest interim; note it on the
  card label "Enemy chooses"); (ii) route the menu to an enemy player via the
  remote-prompt seam — cleaner, matches the player-reaction-control direction.
  Recommend (i) for v1, (ii) as a follow-up. **Decision needed.**
- **⚠ Q5 — "enemy's choice which" for branch A.** `cu_pick_one` lets the enemy
  side choose *which* enemy eats the 300. Same routing concern as Q4 — the picker
  should be an enemy. Same interim (GM picks) applies.
- Note: `category:"enemy"` resolves from Fafnir's POV, so the PC party = "enemy".

---

## 3. Summon Elemental Drake  🔧 (needs a `summon` effect_kind)

> RAW: *"Summon 1 Flame Drake and 1 Lightning Drake to the battlefield."*

**Interpretation:** spawn two independent monster combatants. Actors already exist:
**Flame Drake** `2vmogpXhRJZzAvXt`, **Lightning Drake** `mQlh6GTyw2449hXC`.

**Engine gap:** there is NO `summon` effect_kind. The only spawn path today is
`FUCompanion.api.phantasm.markSummon(tokenDoc, summonerUuid)`, which adds the token
as a **0-activation** combatant (acts on the summoner's turn — correct for
Illusionist Phantasms, WRONG for Drakes which should take their own turns).

### Proposed new effect_kind `summon` (declarative, reusable — no per-skill macro)
| field | meaning |
|---|---|
| `summon_actor` | source actor uuid or name (e.g. `2vmogpXhRJZzAvXt`) |
| `summon_count` | how many (default 1) |
| `summon_disposition` | token disposition (default = match caster, here hostile) |
| `summon_independent` | `true` → full own-turn combatant; `false` → phantasm-style 0-activation |

### effect_table
| effect_label | effect_kind | key fields |
|---|---|---|
| `summon_drakes` | chain | `chain_steps:"summon_flame,summon_lightning"` |
| `summon_flame` | summon | `summon_actor:"2vmogpXhRJZzAvXt"`, `summon_count:"1"`, `summon_independent:true` |
| `summon_lightning` | summon | `summon_actor:"mQlh6GTyw2449hXC"`, `summon_count:"1"`, `summon_independent:true` |

### Engine work required (flagged per the no-hardcode rule)
1. New `summon` effect_kind in `skill-effects.js` (+ preview entry + template
   dropdown option via the effect-kind boot migration).
2. Spawn helper: create token(s) near the caster on the active scene, set
   disposition, and register as combatant(s). Reuse `markSummon` for the
   combatant-create plumbing but add an `independent` path (own activation, normal
   initiative) for Drakes.
3. Battle-end cleanup: tag spawns `isSummon:true` so the existing summon sweep
   removes them at conflict end (Drakes shouldn't persist between battles).

### Open questions
- **⚠ Q6 — placement.** Where do Drakes spawn (adjacent to Fafnir? a fixed
  layout?) and what disposition? Default: hostile, near Fafnir.
- **⚠ Q7 — cap / re-summon.** Can Fafnir re-cast to stack more Drakes, or is it
  capped at one pair alive? RAW is silent — propose no cap (re-cast spawns more).

---

## Build-order recommendation
1. **Searing Brand** — closest to existing patterns (Rend rider + Charmed AE +
   transfer chain). Only Q1 (loop guard) blocks it.
2. **Cruel Ultimatum** — pure data once Q4 routing is decided (GM-picks interim
   needs no engine work).
3. **Summon Elemental Drake** — needs the new `summon` effect_kind first; biggest
   engine lift.
