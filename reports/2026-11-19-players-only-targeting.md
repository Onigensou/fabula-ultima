# Moves that never target summons or guests + Bandit Roo automation (v1.0.634)

Some monster moves now refuse decoys: a summon or a guest can't be picked for them, by the AI or by the GM's targeting. Summoning a decoy is still a fair strategy against every other move. Bandit Roo now plays itself.

Code and world data. The world data (3 actors) comes from `tools/safe-edit/bin/_players-only-targeting.js`, which is already applied to the world in this push. No migration, no new `module.json` entries (a hard reload is enough).

## New formula words
- `IS_SUMMON`: 1 when the creature is a summon (token flags `isSummon` / `isPhantasm` / `summonedBy`, or the old actor props). Same test the summon autopilot uses.
- `IS_GUEST`: 1 when the actor is a guest (`bdGuest`).
- `COMBAT_LIVING_MAX_AE_CHARGES_<NAME>`: like `COMBAT_MAX_AE_CHARGES_<NAME>`, but skips defeated combatants. Pyrefly keeps the old word.
- To refuse decoys, a move sets `target_eligibility` (or a targeting row's `target_filter`) to `IS_SUMMON == 0 && IS_GUEST == 0`. The target survey already reads `target_eligibility`, so the AI's pick, its "can I use this?" check and the GM's targeting menu all follow it. If nobody legal is left, the AI hands the turn to the GM.

## Monsters
- **Kurona:** Infectious Bite never targets a summon or guest.
- **Roo:**
  - Chef's Knife and the Approach victim never target a summon or guest, and the victim is never a defeated creature.
  - If the Marked victim is gone (KO'd or left the battle), the walk restarts on a new victim from step 1. Before, the Roo Marked the KO'd body again and kept walking toward it.
- **Bandit Roo** (automated, was manual):
  - **Approach:** a 6-section counter, +1 at the start of every enemy turn.
  - **Robbed Blind:** at 6, takes all the victim's IP. If the victim had no IP left, the hit is lethal (+9999 Dark, from the old custom logic). Then Bandit Roo runs from the battle ("escaped" if it was alone). Never a summon or guest.
  - **Chef's Knife:** a new Attack skill with the weapon's numbers (DEX + DEX, HR + 7 Dark, melee), because the NPC autopilot never attacks with a weapon item. On a critical hit it drops the target to 0 HP, not against Champions. That spends the Opportunity, so no Opportunity wheel opens. The loot weapon is unchanged.
  - **Curse:** now actually applies Cursed on a hit (it had no effect row).
  - **AI:** Robbed Blind at 6 Approach, otherwise Chef's Knife or Curse.

## Engine fixes found on the way
- **AI action-list lookup:** when an action and a piece of equipment share a name, the action now wins here too. Roo's AI was aiming with the loot weapon (One Enemy), so the knife skipped its Marked focus and eligibility; 09b94a54 only fixed the name fallback.
- **`consume_resource` and Deep Pockets:** the IP reduction now applies only to IP a creature spends itself. IP taken from someone else used to be reduced by the victim's Deep Pockets (a 3 IP rob took 2). Hrotti's Avarice had the same leak.

## Tests
- Module tests: 113/114 pass. The failure is `crisis-keywords`, which already fails on main.
- Content linters: nothing new for the 3 actors.
- Sandbox fights (copy of the world):
  - AI picks, 40 runs each, with Zarg flagged as a summon, Kalina as a guest and Blanche's King Gorger on the field: Kurona's bite 40/40 on Blanche, Roo's knife 40/40, Robbed Blind 40/40.
  - Roo: a KO'd victim restarts the walk on Zarg.
  - Bandit Roo:
    - The counter ticks on each party turn.
    - The rob takes all 3 IP, or is lethal at 0 IP (Zarg lived through his own Life Charm).
    - It runs away, and the fight ends "escaped" when it is alone.
    - A real critical knife hit left Blanche defeated, with no Opportunity wheel.
    - Curse applies Cursed.

## Not verified yet
- A real table session with players' own summons.
- Bandit Roo has no slide animation for Approach. Its Approach item still carries an old custom-logic slide script that nothing runs.
