---
id: 2026-11-18-botc-minion-soldier-rules
title: Birth of the Cruel — Minion HP to the soldier formula + free setups for multi-activation kits (onigensou taking this one)
status: open
severity: minor
reporter: onigensou
assignee: onigensou
component: world-data / Necromancer + battle-director/free-action
introduced_in:
fixed_in:
---

# Birth of the Cruel: two changes, and we are taking them

Heads-up for sarunphat: Birth of the Cruel is your authored skill. We are taking these
two changes on ourselves this update so you do not have to. Nothing below changes the
reaction rows, the cost/toll chain, Dismiss, the rest-restore, or the one-at-a-time gate.
If you object to either change, add a Notes entry before we push and we will hold it.

## 1. Minion HP: ÷2 → the soldier HP formula

### Symptom

Keren reanimated Gigas (elite, L45, 800 HP). The Minion came out at **400 HP**, nearly
5× Keren's own current max HP (85). You said in conversation this looked wrong. We agree.

### Rule text

Necromancer bonus, Birth of the Cruel:

> Its **Rank becomes soldier**; if the original creature was an élite or champion, the GM
> must reduce the Minion's HP and MP **accordingly** (Skills are maintained).
> The newly created Minion is a completely new creature and has full HP, full MP.

Core Rulebook p. 303, building an NPC, step 7 (this is what a soldier IS):

> Maximum HP equal to **twice the NPC's level + five times the NPC's base Might die size.**

Core p. 294: "A soldier-rank foe is roughly on par with a Player Character of its level."

### Root cause

`botc_summon.summon_overrides.max_hp` is `=floor(MAX_HP*(1-(1-RANK_IS_SOLDIER)*0.5))`,
which halves the sheet HP. That works only for a book-built elite, where HP = soldier ×2
(Core p. 295; Angela 80 → 160). Our house elites are tuned well above ×2, so halving does
not produce a soldier:

| Monster | Lv, MIG | Sheet HP | Current Minion (÷2) | Soldier formula |
|---|---|---|---|---|
| Gigas | 45, d12 | 800 (1 turn) | 400 | **150** |
| Carlbero | 50, d12 | 640 (4 turns) | 320 | **160** |
| Galvanic Paryashera | 46, d10 | 520 (4 turns) | 260 | **142** |
| Roper | 46, d12 | 550 (4 turns) | 275 | **152** |
| Deva | 40, d10 | 1000 (4 turns) | 500 | **130** |

### Change

On all three copies (`Item.1eFbdLi3qXUczO6Z`, Keren's `Actor.gdJZ1L1kv5mjTTMr.Item.fjrhRNjINs8xk7Lp`,
Necromancer template `Actor.IQdAebKiExUDRQT0.Item.oU5gEfQBzx2xO9ZR`), `max_hp` and
`current_hp` become:

```
=RANK_IS_SOLDIER*MAX_HP + (1-RANK_IS_SOLDIER)*(2*CHAR_LEVEL + 5*MIG_BASE_DIE)
```

(evaluated against the clone, so CHAR_LEVEL / MIG_BASE_DIE are the corpse's). A soldier
corpse keeps its sheet HP. MP is unchanged (`current_mp: =MAX_MP`): elite rank never
touched MP, so your 2026-09-05 note §7 still holds. Description line updated to match.

Open edge, not changed: a **champion** corpse should also halve MP (the champion rule
doubles it). BotC excludes Villains, and we have no non-Villain champion, so we are noting
this, not fixing it.

## 2. Free setups for a Minion's free action

### Symptom

The Minion acts once per round, as the `botc_minion_free` grant at the end of Keren's turn.
Our solo elites run 4 activations, and some kits are SETUP → PAYOFF. Example: Galvanic's
Steam Veil (Hidden) → Spiral Drill (only while Hidden). With one action the Minion spends
the whole grant on the setup.

### Why the existing path does not cover it

`skill_free_action` (state-handlers.js ~8079) is gated on `!topIsFreeAction(director.ctx)`,
and the Minion ONLY ever acts inside a free action. So the authored free return never fires
for it, by design.

### Change

- A new item prop `minion_free_setup` (declared via the csb-template field script).
  Rule: tag only a no-damage Active skill whose job is to arm the next move.
- When a reanimated Minion resolves a tagged skill inside its free-action grant, the
  engine enqueues ONE more free action for the same performer with the same
  `enabledLabels`. Cap: 1 free setup per grant. The grant ends at the first untagged action.
- Scope guard: the prop is read only when the performer is a persistent-summon Minion inside
  a free-action frame. The original monster, with its 4 activations, ignores it. Your
  `skill_free_action` and its anti-spin guard are untouched.

### Who gets tagged (eligible species only)

- **Galvanic Paryashera:** Steam Veil.
- **Deva:** Enlightenment (Fury ↔ Focus form swap; self, no damage). User approved 2026-11-18.
  Her stances and forms otherwise come from Celestial Discipline on round parity, so nothing
  else needs a tag.
- **Carlbero / Roper:** none. Grab is a damaging Attack and Grappled persists across rounds,
  so Grab → Sap/Bite already works at one action.
- **Gigas:** none (1 activation already).
- **Asura / Rakshasa:** none. They are DEMON, and BotC's own species gate excludes them. The
  user ruled no exception.

### Known gap (pre-existing, not ours)

Under SimMode a Minion's free action goes to the player brain → Guard
(summon-autopilot.js ~264), so the sim will not exercise this. We will verify live on the
Training Ground.

## Notes

- 2026-11-18 (onigensou): filed before the work starts so you see it on your next pull.
- 2026-11-18 (onigensou): built on `feat/botc-minion-soldier` and verified on the Staging World
  running the branch code:
  - Both GM-boot migrations ran and are in the ledger. BotC copies carry the new formula and both
    text lines. The existing Gigas Minion went from 400 to **150/150**. Steam Veil is tagged
    `minion_setup`; Spiral Drill is untouched.
  - The formula through `buildSkillResolver`/`evaluateFormula` gives Gigas 150 and Galvanic 142.
    A soldier (Test Target Enemy) keeps its sheet HP.
  - Real battle (Keren + a Galvanic Minion vs Test Target Enemy): Keren's turn end → BotC grant →
    Minion autopilot picks **Steam Veil** → `RESOLVE: "Steam Veil" is a Minion setup` → follow-up
    grant (`enqueueFront`) → autopilot picks **Spiral Drill** (Hidden consumed, 44 dmg) → the grant
    ends normally. Exactly one follow-up.
  - Snapshot Runner A/B, `--bench`, main vs branch: **493/493 skill fingerprints identical**.
  - Deva's Enlightenment (Active, self, no damage) is a candidate tag held for the user's call.
    Deva's stances and forms come from her passive on round parity, so one action a round already
    works without tags.
- 2026-11-18 (onigensou): user approved tagging Deva's Enlightenment `minion_setup`; added to
  the free-setup migration (same key, not yet run on the real world).
