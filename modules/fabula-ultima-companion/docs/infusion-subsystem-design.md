# Infusion subsystem — design (DESIGN ONLY, not yet built)

Status: **design doc, awaiting build approval.** Authored 2026-06-14.
RAW source: Vanilla core "GADGETS" (Fabula_Ultima_TTJRPG.pdf, the Infusions facet) —
confirmed against the **May-4-2026 playtest** (which only *adds* Tinkerer content:
Detonation Artist heroic + Branching Magitech variant; the base Infusion rules are
unchanged) and against Zarg's live skill items (identical text).

## 1. RAW (canonical)

Infusions are one facet of the Tinkerer **Gadgets** meta-skill (the others —
**alchemy** = the d20 potion-mix system, **magitech** — are separate subsystems, NOT
in scope here). A character unlocks infusion tiers (basic → advanced → superior) by
taking Gadgets repeatedly. Zarg has all three (separate items: Basic / Advance /
Superior Infusion).

**Common rule (all infusions):** *"When you successfully hit one or more targets with
an attack, you may spend 2 Inventory Points to produce a special infusion and apply
the corresponding effect to that attack (if the attack had the multi property, apply
the effects to each target). You cannot apply more than one infusion to the same
attack; producing and using an infusion are both part of the attack action."*

| Tier | Infusion | Effect |
|---|---|---|
| Basic | Cryo / Pyro / Volt | +5 damage; attack's damage becomes **ice / fire / bolt** |
| Advanced | Cyclone / Exorcism / Seismic / Shadow | +5 damage; becomes **air / light / earth / dark** |
| Superior | **Venom** | +5 damage; becomes **poison**; each creature hit suffers **poisoned** |
| Superior | **Vampire** | recover HP **or** MP (choose) = **½ the HP loss** suffered by the target. **Single-target attacks only.** |

So 7 of the 9 infusions are "**override element + 5 damage**"; Venom adds a status;
Vampire is lifesteal with a HP/MP choice and a single-target restriction.

## 2. Engine mapping

| Need | Mechanism | Status |
|---|---|---|
| On-hit offer, once per action, all hit targets | `creature_will_deal_damage` reaction (single-fire-per-action; `appliesToTargetUuids` = hit targets → Multi handled for free) | EXISTS |
| Spend 2 IP (Deep Pockets honored) | `consume_resource` ip 2 | EXISTS |
| Pick which infusion | `prompt_element` (element infusions) / `open_action_menu` (the full infusion list) | EXISTS — but needs **custom labels** (Cryo/Pyro/Volt ≠ ice/fire/bolt); add `element_option_labels` to prompt_element |
| **Override the in-flight attack's element** | **NEW** — `change_damage_element` card-mutation (card-mutations.js already reserves this: see its line ~447 "future change_damage_element"). Must recompute each affected target's affinity (VU/RS/IM/AB) for the new element. | **NEW PRIMITIVE** |
| +5 damage | `adjust_damage` (outgoing; via computeSenderDamageBonuses → recomputePerTargetDamages) | EXISTS |
| Venom → Poisoned on each hit | `apply_ae` "Poisoned" → hit targets | EXISTS |
| Vampire → recover ½ HP loss, HP or MP | drain pattern: `HP_DEALT` formula → `grant` to self; a HP-vs-MP `prompt`/menu; single-target gate (`HIT_COUNT == 1`) | EXISTS (composed) |
| Tier-gating (only offer owned infusions) | `condition_formula` per option (`HAS_SKILL_BASIC_INFUSION` etc.) or merged-menu filter | EXISTS |

### The one genuinely new piece: in-flight element override
At `creature_will_deal_damage`, the per-target entries carry a precomputed
`affinity` (string) + `rawDamage`; `recomputePerTargetDamages` applies that stored
affinity. To change the element we must, per affected target:
1. Set the entry's element to the chosen one.
2. **Recompute** `entry.affinity` = the target's affinity to the **new** element
   (read `affinity_1..9` slot via the ELEMENT_TO_AFFINITY_SLOT map already in
   card-mutations.js, or `computeIncomingDamage(target, {element}).affinity`).
3. Let the existing recompute apply `affinity` to (rawDamage + 5).

This is the **per-attack transient** element override — sibling to the deferred
*COMPUTE-time persistent* `resolveDamageElementOverride` VAR-hook (Soul-Weapon style).
Both should ideally share an element→affinity helper.

## 3. Apply-ordering (the integration crux)

At CONFIRM the pipeline is: **(a) accepted pre-passives' effect chains run** (this is
where `consume_resource` IP + the infusion *pick* happen) → **(b) Phase 1 card
mutations** (redirects + accuracy + **element**) → **(c) Phase 2 damage recompute**
(`adjust_damage` +5).

So the chosen element (captured in step a, e.g. on `_chainVars`/a recorded op) must be
read by the step-b `change_damage_element` mutation (recompute affinity), and the +5
flows through step c. **Risk to verify when building:** that the pick made in (a) is
available to (b) and that (b)'s affinity recompute composes with (c)'s +5 (order:
element/affinity first, then +5 scaled by the new affinity — matches RAW "becomes X,
deals 5 extra").

## 4. Structure — ONE consolidated Gadgets skill (USER direction 2026-06-14)

Build the **entire Gadgets meta-skill as a single skill item** with all three branches,
matching RAW (Gadgets *is* one skill you take repeatedly to unlock types/tiers). The
non-Infusion branches are **stubs** for now.

```
Gadgets (one skill)
├─ Infusions branch  → creature_will_deal_damage reaction (FULL — section 2)
├─ Alchemy branch    → Inventory-action activation (STUB: notify "not implemented")
└─ Magitech branch   → (STUB)
```

**Unlock-state model (the new piece consolidation requires).** With one skill, "which
types/tiers the character has" can't be inferred from separate items. Store it as
NUMERIC tier props on the Gadgets skill instance (or actor):
`gadget_infusion_tier`, `gadget_alchemy_tier`, `gadget_magitech_tier` ∈ {0 none, 1
basic, 2 advanced, 3 superior}. Set per character (Zarg = infusion 3, alchemy/magitech
0). The GM/level-up sets these; default 0 = branch inert.

**Tier-gating.** Each infusion menu option carries `condition_formula` like
`GADGET_INFUSION_TIER >= 1` (Basic) / `>= 2` (Advanced) / `>= 3` (Superior). Needs ONE
small engine addition: a `GADGET_<TYPE>_TIER` formula identifier that reads the prop
(or a generic "read numeric prop" in condition_formula). The affordability/menu walker
already drops options whose condition is false → tier-appropriate menu for free, and
"one infusion per attack" is automatic (one menu, one pick).

**Consolidation impact:** Zarg's separate `Basic / Advance / Superior Infusion` items
(+ the `Gadgets` item) collapse into the one Gadgets skill with `gadget_infusion_tier = 3`.
(`Potion Rain` / `Secret Formula` stay separate — they're distinct Tinkerer skills that
modify alchemy/item-creation, not Gadgets branches.) The legacy items can be retired or
left as inert flavor; the Gadgets skill becomes the single source of behavior.

**Stub contract:** alchemy/magitech branches exist in the config (trigger/activation +
a placeholder effect that just notifies "Gadget branch not yet implemented") so the
skill is complete-shaped and the branches fill in later with NO restructuring.

### Build-time additions vs section 2
- `GADGET_<TYPE>_TIER` formula identifier (or generic prop-read) — small.
- Tier props on the skill template (CSB columns) — small template surgery (like the
  pre_activate column).
- Everything else as section 2 (the `change_damage_element` primitive is still the main
  new piece).

## 5. Open questions for build-time
1. **Element override timing** — confirm the (a)→(b)→(c) ordering above carries the
   pick into the element mutation + affinity recompute. If not, the element override
   may need to run inside the pre-passive apply (step a) directly mutating
   perTargetResults, like card-mutations' redirect does.
2. **Labels** — USER chose infusion names (Cryo/Pyro/Volt). Add `element_option_labels`
   to prompt_element (pipe-list paired with `element_options`), OR drive the whole
   thing via `open_action_menu` (already supports labels) with one option row per
   infusion (element infusions set a `change_damage_element` + `adjust_damage`; Venom/
   Vampire their own rows).  → leaning `open_action_menu` since Venom/Vampire aren't
   pure element picks.
3. **Vampire** — HP-vs-MP sub-choice (nested `open_action_menu`/`confirm`), single-
   target gate (`HIT_COUNT == 1`), lifesteal = `grant` self `floor(HP_DEALT/2)`.
4. **Poisoned AE** — confirm the canonical "Poisoned" `ae_template_ref` (Acid Flask /
   Poison Lash use "Poisoned"/"Envenomed"; Venom RAW = "poisoned").

## 6. Suggested build phasing (when approved) — ONE Gadgets skill

- **P0:** Author the single **Gadgets** skill shell: tier props
  (`gadget_infusion_tier/alchemy_tier/magitech_tier`, template columns) + the
  `GADGET_<TYPE>_TIER` gating identifier. Alchemy + Magitech branches as **stubs**
  (activation/trigger present, effect = notify "not yet implemented"). Set Zarg
  `gadget_infusion_tier = 3`.
- **P1:** `change_damage_element` card-mutation + element→affinity helper + the
  `open_action_menu` infusion menu with the 7 element infusions (Basic+Advanced),
  2 IP, +5, on `creature_will_deal_damage`, tier-gated. Verify element+affinity+5 live.
- **P2:** Venom (element poison + 5 + apply Poisoned to hit targets).
- **P3:** Vampire (single-target gate + HP/MP choice + lifesteal).
- **P4:** Polish — one-per-attack, Multi confirmation, card display, retire the legacy
  separate Infusion items.
- **Later (separate effort):** fill the alchemy stub (d20 potion-mix system) + magitech
  stub. These are large; the stub contract means no restructuring when they land.

## NOT in scope (Zarg, deferred)
- **Alchemy** (the d20 potion-mix Inventory-action system) + **Magitech** facets of
  Gadgets — separate large subsystems; flagged Inventory-action skills (Potion Rain,
  Secret Formula) ride the item-creation flow and were deferred by the user.
