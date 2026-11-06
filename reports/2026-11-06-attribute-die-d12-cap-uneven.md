---
id: 2026-11-06-attribute-die-d12-cap-uneven
title: Discussion — the d12 attribute-die cap is applied by the rolls but not by DEF/MDEF, skill formulas and a few readers
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/snapshot (attrDieSize), check-requester/cr-api (getDieSize), skill-formulas, CSB PC/NPC templates
introduced_in: 727e3d8e
fixed_in:
---

# The d12 die cap is only applied in some places

Written for sarunphat and the Claude session that runs the pull. **No code was changed for this.** The host wants
to discuss it with you before anything is decided. Today's decision: keep the current behaviour for now.

## 1. Background

In 727e3d8e (2026-08-08) you capped attribute dice at d12 **at the read**: `snapshot.js` `attrDieSize`
(MAX_ATTR_DIE, ~L141-177) and its twin `cr-api.js` `getDieSize` (~L136-142). The reasoning was the RAW ladder
plus Blue Bovine's "to a maximum of D12". The sheet value is left as it is, because no single buff AE can see the
stacked total.

Why it came up: Crystal Powder was reworked today. Its "Crystal High" AE adds +4 to every `*_current`, the same
total as the six basic buffs. On Hina the sheet showed INS d16.

## 2. What still disagrees

A buff pushes a die past d12 whenever it lands on a d12 attribute. That is common in this party: Hina and Keren
have INS d12, Blanche and Zarg have DEX d12. Measured on temporary clones (2026-11-06, live client):

| Reader | Hina + Crystal High (INS 12 → sheet 16) | Capped? |
|---|---|---|
| BD checks (`check.js` → `attrDieSize`), CheckRequester (`getDieSize`, incl. initiative roll) | d12 | yes |
| **PC sheet DEF/MDEF**: `base_defense = ${ref('dex_current')}$`, `base_magic_defense = ${ref('ins_current')}$` (PC template `_FabU Char Template v3.fire`) | MDEF 14 → **18** | **no** |
| **NPC sheet DEF/MDEF**: `defense` / `magic_defense` read `dex_current` / `ins_current` (`_Fabula NPC template v.2`) | Rock Golem: Swift + Clarity + High, DEX 6 → 14, DEF 17 | **no** |
| `skill-formulas.js` ~L1556-1559 `*_CURRENT_DIE` | 16 | no |
| `checkRoller-dialog.js` ~L155-158 (manual Check Roller) | accepts 4..20 | no |
| `director-initiative.js` ~L66-67 leader-pick proxy | uncapped (the roll itself is capped) | no |
| `enemy-autopilot.js` ~L133-134 `readInitiativeScore` | uncapped | no |
| `activity-fishing.js` ~L102-105, `refinement-core.js` ~L39-40, ~L96 (clamp 2..20) | uncapped | no |
| Sheet display of the die | d16 | not capped (by design, per your comment) |

The buffs bypass both templates' own clamps (PC `min(max(base + bonus, 4), 14)`, NPC `min(..., 12)`): the
status AEs write `*_current` with mode 2 *after* the label is computed, and the debuffs write `bonus_*`.

## 3. Impact if left as is

1. **DEF/MDEF** (the only real gameplay effect). Every step past d12 still adds +2 DEF or MDEF. Swift/Clarity on
   Blanche or Zarg gives +2 DEF, Awake/Clarity on Hina or Keren gives +2 MDEF, and enemies benefit the same way.
   This contradicts the "maximum of d12" text on Blue Bovine, Café au Lait, Awaken, Encourage and Withstand. All
   five rely on the global read-cap: they only add +2 and have no cap of their own.
2. **Your skills that read the die directly** skip the cap: Gamble (`roll_dice` WLP), Shadow Strike / Geist
   (`roll_dice` MIG), Unicorn Dance (heal), Meanad Dance (MP drain).
3. The sheet shows d14/d16 while the roll is d12. This confuses the reader but breaks nothing.
4. The manual Check Roller outside battle can roll above d12, but only with an always-on gear buff (Power Gloves /
   Joyeuse Strong). Battle buffs are swept at battle end.
5. Too small to notice: the initiative leader pick, the enemy AI order, fishing/refinement odds.

Nothing errors or crashes. 3D dice are off, and `new Roll("1d16")` works.

## 4. Open questions for discussion

- **Which direction?**
  - (a) Keep d12 everywhere: apply the read-cap in every reader above, and wrap the four template DEF/MDEF
    formulas in `min(…, 12)`.
  - (b) The host has considered letting **buffs** exceed d12 (house rule notes: extended range up to d20). That
    reverses 727e3d8e, so the five "max d12" items would need their own cap, or an opt-in flag on the AEs allowed
    to exceed it (e.g. Crystal High) with a hard limit such as d16.
- **Floor.** Debuffs can take a die to d4 (Hina's DEX under Crystal Withdraw: d6 → d4). The house notes say status
  effects floor at d6 (RAW); other sources may go lower. 727e3d8e set no floor (`attrDieSize` accepts ≥ 4).
- **Templates.** A DEF/MDEF formula change goes through the shared-layout resolver (b6e320fe). About 100 actors
  point at template ids that no longer exist (`yibwK7D0bMmrmXhL`, `Dx16KeWcJzikM7dh`, …). Check that they pick
  up a template edit before relying on it; that needs a sandbox test.

## Notes

- 2026-11-06 onigensou: filed for discussion; nothing changed. Related same-day commit: 9c70a179
  (`onRemoveApply` follow-up AE for Crystal High → Crystal Withdraw); it does not touch the cap.
