# Force mode — `reaction_passive_mode: "force"`

Auto-fire + UI-invisible. The row runs whenever its trigger + filters match, with **no chip, no menu blade, no Passive Manager entry**. The player can't decline it, gets no signal it happened. Reserve for engine housekeeping with nothing for the player to decide.

The full four-mode spec (`on` / `ask` / `off` / `force`) lives in the reaction-config schema doc. This page is the **authoring decision rule + canonical inventory**.

---

## Decision rule

**Use Force when ALL of these are true:**
1. The row fires deterministically on a known FSM boundary (`conflict_start`, `turn_start`, `turn_end`, `round_end`, or a fully data-driven trigger like `creature_unleashes_zero_power` / `creature_check_outcome_flipped`).
2. The chain has no `consume_resource`, no Fabula Point cost, no `open_action_menu`, no `target_prompt`.
3. The chain's effect is one of:
   - Apply a "ready" / "charge" / "armed" AE to self
   - Increment an engine accumulator (Zero Power gauge, PDS charges, custom resource pools)
   - Refill / refresh / setup with no meaningful player decision
4. Surfacing the row as a pill/menu blade would be UI noise — "your charge AE just refilled" isn't decision-time information.

**Stay Ask when ANY of these is true:**
- The chain has a resource cost (MP/HP/IP/FP).
- The chain has a `target_prompt`, `open_action_menu`, or other player-pick step.
- The effect is a buff/debuff the player would want to know about ("Adversity activated" ≠ "PDS charge +1").
- The trigger fires from a player-driven event where the player should see they had the option (Cheap Shot, Vanish, Counterattack).

**Stay On when** the trigger is data-driven AND the effect IS player-meaningful — Adversity, Magical Artillery: passive buffs that auto-apply but should surface so the player sees the bonus landed. (Today most always-on buffs ship as embedded `transfer:true` AEs, not reaction-config rows.)

---

## Canonical Force rows (BD-tree, audited 2026-06-01)

When you create the BD-tree master for an item still pending one, default the equivalent row to Force without re-deriving.

| Skill | Class | Trigger | effect_ref | Why Force |
|---|---|---|---|---|
| **Protect** | Guardian | `conflict_start` | `protect_refill` | Refills protect-charge AE — canonical example |
| **Protect** | Guardian | `turn_start` (self) | `protect_refill` | Per-turn refill of same charge AE |
| **Heart of Darkness** | Darkblade | `conflict_start` | `hod_arm` | Applies "Ready" charge AE that gates the actual reaction at `creature_enter_crisis`. The arming is setup; `creature_enter_crisis` row stays Ask (target + bond emotion are player-meaningful). |
| **Prophetic Defender Style** | Heroic | `conflict_start` | `pds_gain` | Initial PDS charge |
| **Prophetic Defender Style** | Heroic | `round_end` (`ROUND % 2 == 0`) | `pds_gain` | Even-round PDS refill |
| **Zero Trigger: Motivation** | Blanche | `creature_unleashes_zero_power` (ally) | `ZP refill` | Engine accumulator refill |
| **Zero Trigger: Foresight** | Hina | `creature_check_outcome_flipped` (self) | `ZP on Flip` | ZP refill on Lucky Seven flip |
| **Zero Trigger: Strategy** | Zarg | `turn_end` (self) | (stub) | Will be ZP filler when wired. Master pre-emptively flipped. |
| **Cognitive Focus** | Esper / Keren | `turn_start` (self) | (stub) | Will be turn-start refresh when wired. |

**Provenance note.** Only **Protect (BD master)** and **actor-embedded copies** carry these Force values. The legacy `💥 Skill /` tree never reads `reaction_passive_mode` (its reaction system was independent). **Do not write `reaction_passive_mode` on items inside `💥 Skill /`** — that tree powers the legacy system and shouldn't carry BD-tree concerns. Battle Director work goes in `Battle Director / <Class> / <Skill | Heroic Skill | Arcana>` and on actor copies.

---

## Anti-pattern — looks like Force, isn't

| Skill | Trigger | Why NOT Force |
|---|---|---|
| **High Speed** | `conflict_start` | 10 MP cost — player decides |
| **Cheap Shot** | `creature_will_deal_damage` | Adds bonus damage — player picks per attack |
| **Vanish** | `creature_deals_damage` | 1 Fabula Point cost |
| **Painful Lesson** | `creature_takes_damage` | Opens free-action menu with target lock |
| **Absorb MP / Agony / Drain Spirit** | post-damage | Feels like refill but player-meaningful — keep visible |
| **Mercy** | (passive) | "You survived at 1 HP" — Ask/On for visibility, never Force |
| **Counterattack / Phantasmal Echo / Illusory Shield / Fancy Footwork** | various | Player choice or cost |

---

## Force on a stub is safe

If you flip a row to Force whose `reaction_effect_ref` is empty or points at a non-existent label (Cognitive Focus, ZT:Strategy above), the chain dispatcher resolves to nothing — Force just no-ops. Safe to set as an authoring default. When the chain gets wired later, the row already has the right mode.

---

## Related

- [reaction-config-schema.md](reaction-config-schema.md) — the four-mode spec + all trigger names + all effect_kinds
- [reaction-architecture.md](reaction-architecture.md) — visibility / ordering / stacking contracts (Force rows are exempt from visibility stages 2 & 3)
- [skill-authoring-canon.md](skill-authoring-canon.md) — author rules
