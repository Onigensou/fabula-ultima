# Battle Director — Skill Roadmap

Coverage map of every Fabula Ultima class against the director's skill-execution phases. Source PDFs (in `C:/Users/Nougat/Desktop/`):

- Fabula Ultima Core (`Fabula_Ultima_TTJRPG.pdf`) — 15 classes
- High Fantasy Atlas (`Fabula_Ultima_Atlas_High_Fantasy.pdf`) — 4 classes
- Natural Fantasy Atlas (`Fabula_Ultima_-_Natural_Fantasy_Atlas_v1.0.pdf`) — 4 classes
- Techno Fantasy Atlas (`Fabula_Ultima_-_Techno_Fantasy_Atlas_v1.01.pdf`) — 3 classes
- Low Fantasy Atlas (`The_Low_Fantasy_Atlas.pdf`) — 3 classes
- Bonus packs — Necromancer + Ace of Cards (2 classes)

**Total: 31 classes.**

**Implementation focus order**: Core > High Fantasy > Techno Fantasy > Natural Fantasy > Bonus > Low Fantasy.

---

## Phase definitions

| Phase | Scope |
|---|---|
| **B.1 — Skills MVP** | Picker · cost parse · roll · damage commit · 5 effect_kinds (`targeting`, `grant`, `apply_ae`, `consume_charge`, `chain`) · 3 recipes (`drain`, `damage`, `heal_target`) · closes D.5 Item linked-skill execution. |
| **B.2 — Skills expansion** | Adds 3 effect_kinds (`consume_resource`, `redirect_target`, `open_action_menu`) · 3 recipes (`protect`, `free_action_grant`, `redirect_attack`) · variable-cost UI (10-50 MP slider with per-segment options) · `TARGET_*` formula identifiers · `mutate_turn_counter` effect_kind. |
| **C — Spells** | Spell action button · isOffensiveSpell affinity routing · MP magnitude scaling with T-multipliers (`10×T MP`) · per-spell-list filtering (e.g. Elementalist learns Elementalist spells) · spell-specific HR+N damage formulas. |
| **F — Reactions** | Director-native reaction window (calls into the schema's 30 triggers) · autoPassive runner · `redirect_target` reactions (Protect / Mirror) · charge-gated reactions. |
| **G — Summoning** | Token spawn pipeline for class summons · Arcanum bind+merge state · Faithful Companion stats · Phantasm roster + PV tracker · Therioform manifest · Pilot vehicle + modules · Tinkerer Magitech construct. |
| **H — Custom resource pools** | Plug-in resource framework: Grave Points · Trade Points · Soul Beads (core + resolve) · Brainwave Clock · Growth Clock + magiseed garden · Card deck (hand/discard) · Ingredient pool · Symbol bearer registry. |
| **I — Out-of-combat / Ritual** | Ritual pipeline · Travel/Rest hook for travel-roll-keyed skills · Lore Q&A surface (Flash of Insight, Tavern Talk) · See You Later scene-swap. |
| **J — Roll modification hooks** | Post-Check value swap hook for Lucky Seven · Symbol of Destiny · Mirror · Divination · Bend Magic · Double or Nothing. Intercepts roll results out-of-band from the effect engine. |

---

## Class catalog (alphabetical, with phase needs)

Notation in brackets: phase that unlocks each skill. `passive: cb` = `passive_check_bonus_formula`. `passive: db` = `passive_damage_bonus_formula`.

### Ace of Cards (Bonus)
- Double or Nothing — `[J]` pre-roll declaration + outcome inversion
- High or Low — `[F+H]` post-crit/fumble deck mutation
- Magic Cards — `[H+B.2]` variable cost + set-resolution branch
- Mulligan — `[H]` end-of-turn deck mutation
- Trap Card — `[F+H]` post-enemy-action reaction with deck draw

### Arcanist (Core)
- Arcane Circle — `[F]` post-dismiss free spell
- Arcane Regeneration — `[B.1]` post-summon HP grant (recipe `drain`-style)
- Bind and Summon — `[G]` Arcanum summon, merge benefits
- Emergency Arcanum — `[B.1]` Crisis-gated MP cost reduction
- Ritual Arcanism — `[I]`
- Arcana list (Forge / Frost / Gate / Grimoire / Oak / Sky / Sword / Tower / Wheel) — `[G]`

### Chanter (HF)
- Magichant — `[B.2 + new infrastructure]` verse matrix (volume × key × tone)
- Resonance — `[F]` post-verse reaction
- Siren's Song — `[I]`
- Sound Barrier — `[F]` post-verse damage reduction
- Vibrato — `[B.2]` post-verse free attack

### Chimerist (Core)
- Consume — `[F]` post-spell-damage MP recovery
- Feral Speech — `[I]`
- Pathogenesis — `[B.1]` post_damage_effect_ref status apply
- Ritual Chimerism — `[I]`
- Spell Mimic — `[I]` skill-learn metadata (out-of-pipeline)
- Spells — `[C]` learned dynamically; offensive use INS+WLP or MIG+WLP

### Commander (HF)
- Bishop's Edict — `[B.1]` apply_ae scene-wide
- Charging Cavalry — `[B.2]` cross-actor free attack
- Crushing Chariot — `[F+B.2]` turn-order mutation reaction
- King's Castle — `[B.1]` apply_ae scene-wide
- Queen's Gambit — `[B.2]` free attack + branch picker

### Dancer (HF)
- Dance — `[B.2 + new infrastructure]` dance roster (Peacock = force-target, Ouroboros = turn-grant)
- Follow My Lead — `[B.2]` cross-actor dance extension
- Frenetic Footwork — `[B.1]` passive: cb (post-dance, AE-gated)
- Quick-Change — `[B.2]` post-dance Equipment-action grant
- Wardancer — `[B.1]` passive: db (post-dance, AE-gated)

### Darkblade (Core)
- Agony — `[B.1]` post_damage_effect_ref chain (HP + MP grant)
- Dark Blood — `[B.1]` passive: db (Crisis-gated, type-conditional)
- Heart of Darkness — `[B.1]` apply_ae with bond data (Phantasm-style)
- Painful Lesson — `[F]` reaction with `open_action_menu`
- Shadow Strike — `[B.2]` HP cost + free attack

### Elementalist (Core)
- Cataclysm — `[B.2]` variable-cost spell damage scaler
- Elemental Magic — `[C]` learn-spell repeatable
- Magical Artillery — `[B.1]` passive: cb (isOffensiveSpell-gated)
- Ritual Elementalism — `[I]`
- Spellblade — `[B.2]` Accuracy formula swap on offensive spell
- Spells (12) — `[C]` Elemental Shroud / Elemental Weapon / Flare / Fulgur / Glacies / Iceberg / Ignis / Soaring Strike / Terra / Thunderbolt / Ventus / Vortex

### Entropist (Core)
- Absorb MP — `[F]` post-damage MP grant reaction
- Entropic Magic — `[C]` learn-spell repeatable
- Lucky Seven — `[J]` post-Check value replacement
- Ritual Entropism — `[I]`
- Stolen Time — `[B.2 + cross-actor open_action_menu]` variable cost segments
- Spells (12) — Acceleration `[C]` / Anomaly `[C]` / Dark Weapon `[B.2+C]` / Dispel `[C]` / Divination `[F+J]` / Drain Spirit `[B.1]` / Drain Vigor `[B.1]` / Gamble `[H+ roll_dice extension]` / Mirror `[F]` / Omega `[C + TARGET_LEVEL]` / Stop `[C + mutate_turn_counter]` / Umbra `[C]`

### Esper (TF)
- Cognitive Focus — `[B.2]` single-target buff AE state
- Hypercognition — `[B.1]` passive cost discount (new prop or recipe)
- Navigator — `[I]`
- Psychic Gifts — `[H + multiple]` Brainwave Clock + sub-mechanics inc. reactions
- Psychokinesis — `[B.1]` passive: cb (ATTR-swap)

### Floralist (NF)
- Battle Gardening — `[B.2]` post-plant free action/spell
- Chloromancy — `[H]` Growth Clock + magiseed roster (20 magiseeds)
- Graft — `[H]` magiseed swap
- Tree of Life — `[H + B.1]` magiseed removal grant
- Verdant Sway — `[I]`

### Fury (Core)
- Adrenaline — `[B.1]` passive: db (Crisis-gated)
- Frenzy — `[B.1]` matched-dice crit window (new flag on weapon attack)
- Indomitable Spirit — `[F]` post-Fabula-spend reaction
- Provoke — `[B.2]` opposed Check + status + compulsion AE
- Withstand — `[F]` post-Guard reaction

### Gourmet (NF)
- Cooking — `[H]` ingredient pool + d12 taste table
- Knife and Fork — `[H]` free-attack damage variant
- Made With Love — `[H + B.2]` variable cost extra targets
- Salt and Pepper — `[H]` ingredient mutation
- Traveling Cook — `[H + I]` post-travel grant

### Guardian (Core)
- Bodyguard — `[B.1]` apply_ae Resistance to cover target
- Defensive Mastery — `[B.1]` passive: db (equipment-gated, negative)
- Dual Shieldbearer — `[B.2]` equipment pipeline extension
- Fortress — `[B.1]` max HP modifier (actor data extension)
- Protect — `[F + B.2]` redirect_target reaction

### Hunter (LF)
- Lock-On — `[B.1]` apply_ae mark + Accuracy bonus chain
- Set Trap — `[B.2 + I]` conflict-start trap roster
- Track — `[I]` opposed Check + Accuracy bonus state
- Vital Strike — `[B.1]` post_damage_effect_ref damage bonus
- Wild Reflexes — `[F]` post-Guard reaction

### Illusionist (LF)
- Illusionist Magic — `[C + G]` spell-learn (incl. Phantasm-creation spells)
- Phantasmal Echo — `[F]` post-Phantasm-destruction MP grant
- Phantasmal Recovery — `[G + B.1]` shatter Phantasm for HP
- Phantasmal Recycling — `[G]` alt-pay spell MP via shatter
- Ritual Illusionism — `[I]`

### Invoker (NF)
- Elemental Harmony — `[B.1]` passive: db conditional for heals
- Invocation — `[B.2 + new infrastructure]` wellspring matrix
- Linked Invocation — `[B.2]` variable cost extra targets
- Ripples — `[F + B.2]` post-ally-damage reaction free attack
- Wellspring Expansion — `[B.1]` passive: db (weapon-type-gated)

### Loremaster (Core)
- Flash of Insight — `[I]` Check-threshold-triggered Q&A
- Focused — `[B.1]` max MP modifier + passive: cb for Open Checks
- Knowledge Is Power — `[B.1]` passive: cb (ATTR-swap)
- Quick Assessment — `[B.2 + I]` variable cost + Reveal mechanic
- Trained Memory — `[I]`

### Merchant (NF)
- Expiration Date — `[B.2]` damage swap on consumables
- I've Heard of It! — `[H + B.1]` Trade Point spend on Check
- Private Stock — `[H]` cross-actor IP bypass
- Real Treasure — `[H]` session-bounded grant
- Winds of Trade — `[H + I]` post-rest TP grant

### Monk (LF)
- Clarity — `[H]` Soul Beads (Core + Resolve pools) + benefit stacking
- Resonant Clarity — `[H]` cross-actor extension
- Soul Renewal — `[H + B.1]` cross-actor Bead heal
- Spirit Shot — `[H + B.2]` Bead-fueled ranged opposed attack
- Spiritual Fortress — `[F + H]` Bead-fueled damage reduction reaction

### Mutant (TF)
- Akromorphosis — `[B.1]` passive: db unarmed + Category swap at turn start (new effect_kind or recipe)
- Biophagy — `[F]` post-damage Crisis-gated HP grant
- Ecdysis — `[F]` reactive HP-cost Resistance grant
- Genoclepsis — `[G]` learning + therioform roster (out-of-pipeline metadata)
- Theriomorphosis — `[G]` therioform manifest (12 forms)

### Necromancer (Bonus)
- Beyond the Realms of Death — `[H + F]` Grave Points + on-KO reaction
- Children of the Grave — `[I]`
- Fear is the Key — `[H + F]` post-damage GP grant reaction
- For Whom the Bell Tolls — `[H + B.2]` GP spend on spell damage mod
- Rondo of Nightmare — `[H + C]` GP spend on spell target expansion

### Orator (Core)
- Condemn — `[B.2]` opposed Check + MP drain + status
- Encourage — `[B.1]` apply_ae HP heal + ATTR die-bump
- My Trust In You — `[J]` post-Check Fabula-Trait/Bond reroll
- Persuasive — `[I]` Clock mod out-of-combat
- Unexpected Ally — `[I]`

### Pilot (TF)
- Compression Tech — `[I + G]`
- Flexible Configuration — `[B.2 + G]` module enable/disable
- Heart in the Engine — `[B.1]` turn-start variable buff (3-option picker, simple options)
- Personal Vehicle — `[G + H]` vehicle state + module slots
- Strong Grip — `[B.1]` passive: cb (ATTR-swap)

### Rogue (Core)
- Cheap Shot — `[B.1]` post_damage_effect_ref with status-count formula
- Dodge — `[B.1]` equipment-gated passive: cb for Defense
- High Speed — `[B.2 + I]` pre-round free action (conflict-start open_action_menu)
- See You Later — `[I]`
- Soul Steal — `[B.2 + I]` opposed Check + loot

### Sharpshooter (Core)
- Barrage — `[B.2]` multi-property add (weapon prop modifier effect_kind)
- Crossfire — `[F]` post-enemy-ranged-attack reaction with MP cost = result
- Hawkeye — `[F]` post-Guard reaction
- Ranged Weapon Mastery — `[B.1]` passive: cb (weapon-type-gated)
- Warning Shot — `[B.2]` hit-replacement (no damage + status)

### Spiritist (Core)
- Healing Power — `[B.1]` passive: db adapted to healing (needs `passive_heal_bonus_formula`)
- Ritual Spiritism — `[I]`
- Spiritual Magic — `[C]` learn-spell repeatable
- Support Magic — `[B.1]` post-spell apply_ae with bond-strength formula
- Vismagus — `[B.2]` alt-pay HP for MP (cost parser extension)
- Spells (12) — `[C]` Aura / Awaken / Barrier / Cleanse / Enrage / Hallucination / Heal / Lux / Mercy / Reinforce / Soul Weapon / Torpor

### Symbolist (HF)
- Magic Symbols — `[B.2 + H]` symbol-bearer cross-actor spell-cast
- Mirage — `[I]`
- Personal Touch — `[H + B.1]` on-symbol-bearer event bonus
- Symbolic Connection — `[I]`
- Symbolism — `[H]` symbol roster + bearer registry (18 symbols; several reactions inside: Destiny=reroll/J, Sacrifice=redirect/F)

### Tinkerer (Core)
- Emergency Item — `[B.2]` Crisis-gated extra Inventory action
- Gadgets — `[H + B.2 + G]` 3-branch tree (Alchemy = roll-dice-and-branch, Infusions = post-hit damage-type swap, Magitech = Magicannon / Magisphere / Construct)
- Potion Rain — `[B.2]` multi-target potion mod
- Secret Formula — `[B.1]` passive: db for item types (needs item-class identifier)
- Visionary — `[I]`

### Wayfarer (Core)
- Faithful Companion — `[G]`
- Resourceful — `[I]`
- Tavern Talk — `[I]`
- Treasure Hunter — `[I]`
- Well-Traveled — `[I]`

### Weaponmaster (Core)
- Bladestorm — `[B.2]` multi-property mod
- Bone Crusher — `[B.2]` hit-replacement
- Breach — `[B.2]` free attack + branch
- Counterattack — `[F]` post-enemy-melee reaction
- Melee Weapon Mastery — `[B.1]` passive: cb (weapon-type-gated)

---

## Coverage roll-up

| After phase | Classes wholly lit | Classes partially lit | Classes still dark |
|---|---|---|---|
| B.1 | 0 | ~16 | ~15 |
| B.1 + B.2 | 0 | ~22 | ~9 |
| B.1 + B.2 + C | ~3 | ~24 | ~4 |
| B + C + F | ~10 | ~17 | ~4 |
| B + C + F + G | ~14 | ~13 | ~4 |
| All phases | 31 | 0 | 0 |

---

## Phase B.1 acceptance set

B.1 should validate against at least these 8 reference skills, chosen to exercise every B.1 primitive end-to-end:

1. **Drain Spirit** (Entropist spell) — `post_damage_effect_ref` MP recovery. Tests: cost parser, check roll, damage commit, `MP_DEALT` formula, grant effect_kind, recipe `drain`.
2. **Drain Vigor** (Entropist spell) — same with HP. Tests: `HP_DEALT` formula, multi-resource recipe.
3. **Heal** (Spiritist spell) — basic ally-targeted heal. Tests: targeting `ally`, grant effect_kind, recipe `heal_target`.
4. **Agony** (Darkblade) — post-damage self-grant. Tests: chain effect_kind.
5. **Heart of Darkness** (Darkblade) — apply_ae with bond data. Tests: apply_ae, AE template ref.
6. **Bodyguard** (Guardian) — apply_ae Resistance to cover target. Tests: interop with existing Guard cmd.
7. **Lock-On** (Hunter) — apply_ae enemy mark + passive cb reading mark AE. Tests: apply_ae to enemy + passive cb formula.
8. **Magical Artillery** (Elementalist) — passive cb gated by isOffensiveSpell. Tests: passive layer defers gracefully when Spell action isn't wired yet.

---

## Implementation focus order

Per user direction:
1. **Core** (15 classes) — finish entirely before moving on.
2. **High Fantasy** (4 classes — Chanter, Commander, Dancer, Symbolist)
3. **Techno Fantasy** (3 classes — Esper, Mutant, Pilot)
4. **Natural Fantasy** (4 classes — Floralist, Gourmet, Invoker, Merchant)
5. **Bonus** (2 classes — Necromancer, Ace of Cards)
6. **Low Fantasy** (3 classes — Hunter, Illusionist, Monk)

The plan progresses through the phases (B.1 → B.2 → C → F → J → G → I → H) per book before moving to the next book. Each book gets at least two milestones (book-specific infrastructure + class wiring atop existing infrastructure). See the implementation plan in chat / commits for milestone definitions.
