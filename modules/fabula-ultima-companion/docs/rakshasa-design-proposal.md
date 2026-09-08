# Rakshasa — design proposal (v2, FOR REVIEW — nothing built)

**Status:** plan only. No actor, no items, no world writes, no code changes.
**Role:** Valley of the Dragon *event encounter*, solo, strong Elite, 4 activations.
**Counterpart to:** [Asura](./asura-rework-proposal.md) — read that doc's §9 and
`asura-live-test-report.md` before trusting any number here.

**v2 changes:** rulings applied on all four open questions; **§0.1 is a
correction to v1** — spells already route through `arcane_ef` and always have,
my v1 claim was wrong. Adaptive Defense rebuilt as a **5-slot rolling window**
per the tempo clarification. Execute/Cripple promoted to real engine keywords,
which changes every damage number in §5.

**The one-line identity:** *Asura collects elements. Rakshasa reads weapons.*
Asura punishes you for **not** varying your element; Rakshasa punishes you for
**repeating** a weapon category — and a four-person party can never quite rotate
fast enough on its own.

---

## 0. Rulings applied

### 0.1 ⚠ CORRECTION — spells already count as Arcane

**My v1 claim was wrong, and the ruling is: nothing to build.** Spells have
routed through `arcane_ef` since commit `6f8f73a2` (2026-06-25, *"Attack/Skill/
Spell type convergence"*):

```js
// action-profile.js:236-242
// Spell = Arcane weapon type by default. Routes spells through the SAME weaponKey
// machinery as a weapon strike: the caster's `extra_damage_mod_arcane` adds here
// (offensive), and buildPerTarget's efficiency block reduces by the target's arcane
// weapon efficiency (defensive).
const weaponKey = (isSpell && !isMpDamage) ? "arcane" : null;
```

`action-profile.js` is live (imported by `state-handlers.js:104`); its
"PHASE 0 — no FSM caller invokes this yet" header comment is stale. So your
recollection was right and the house rule is already the engine's behaviour.

**What misled me:** the note in `reference_monster_actor_setup` — *"EF is INERT
for spells, `damage-ruleset.js` L150"* — overgeneralises. That line governs the
**effect-damage** path (`deal_damage` rows, DoT ticks, hazards), which passes no
weapon type. It does **not** govern cast spells, which never go through that
function. Two consequences worth acting on:

- **The Asura HP math was adjusted on a false premise** (2026-08-16, "halve any
  EF-based DPR estimate"). Asura's 900 HP inherits that error and should be
  re-checked when it is next touched.
- **I have corrected the memory note.**

**The one real gap that remains:** damage delivered by a `deal_damage` **effect
row** (`skill-effects.js:5627`) calls `computeIncomingDamage` with no
`weaponType`, so it bypasses every lane. Correct for a Burn tick; wrong for a
skill whose main damage is authored as an effect row. Optional fix in §7.

### 0.2 Floor is 25%

Applied. 25 is safely above the `readWeaponEfficiency` `v > 0` guard, so it does
not trip the 0-reads-as-100 bug — but that path/`apply-damage-core` divergence is
still a live inconsistency and is on the fix list (§7).

### 0.3 Shield = Brawling

Applied — and it turns out the **damage side already does this**. My v1 claim
that Blanche "escapes the mechanic entirely" was half wrong; the precise
situation:

- A lone shield cannot be attacked with at all — `resolveAttackerWeapon`
  (`snapshot.js:214`) returns null on `A1 === "SHI"`.
- Blanche therefore attacks through **Twin Shields**, the Dual Shieldbearer
  virtual attack, whose AE profile declares `weaponType: "Brawling"`. That flows
  into `primary.weaponKey = "brawling"` → `brawling_ef`. **Her damage is already
  taxed by the brawling lane.**
- What fails is **detection**: `USED_WEAPON_CATEGORY_IS_<X>` resolves
  `payload.weaponUuid`, and a virtual attack has no item, so no uuid. The gate
  fails closed and her attacks never *register* a read.

So the fix is detection-only, and it is the same ~8 lines already proposed
(§4.4), plus an explicit `item_type: "shield"` → `brawling` mapping so a future
real weapon-shield lands in the same lane.

### 0.4 ⚠ SECOND CORRECTION — Execute is already built, as DATA. Adopt it.

**My v2 first draft said Execute/Cripple were unimplemented and proposed engine
work. That was wrong, and the instinct to reuse the existing pattern was right.**

There is no engine handler for the keyword *string* — that part held up. But the
*effect* is fully implemented on Kirin's **Horn Rush** as a two-row declarative
pattern, and it needs no code at all:

```jsonc
"reaction_config_table": { "0": {
  "reaction_trigger":     "creature_will_deal_damage",
  "reaction_source":      "self",
  "reaction_source_skill":"Horn Rush",
  "condition_formula":    "TARGET_AE_COUNT_CRISIS > 0",
  "reaction_passive_mode":"force",
  "reaction_effect_ref":  "horn_execute"
} },
"effect_table": { "0": {
  "effect_label":     "horn_execute",
  "effect_kind":      "adjust_damage",
  "damage_operation": "multiply",
  "damage_amount":    "2",
  "damage_stage":     "outgoing"
} }
```

**So the 200% comes from authored rows, not from the keyword and not from the
engine.** `action_keywords: "execute"` is decorative — it drives the tooltip and
the chip, nothing more. Every piece is already general-purpose:
`TARGET_AE_COUNT_<NAME>` (`skill-formulas.js:1826`) counts AEs by name on the
target, the crisis-reactor maintains a `Crisis` AE, and `adjust_damage` supports
`multiply` at the `outgoing` stage (`skill-effects.js:8273`).

**Ruling: adopt this pattern verbatim. No engine work, and nothing retroactive.**
Cripple is the same two rows with the condition inverted
(`TARGET_AE_COUNT_CRISIS == 0`). Full rows in §6.

> ⚠ **Separately: Kirin's Execute is currently DEAD.** Horn Rush has
> **`isReaction: false`**, and `reaction-triggerCore.js` skips every row on an
> item without that flag (`if (!props?.isReaction) continue;`). So the reaction
> row never runs and Horn Rush has been dealing flat damage to Crisis targets
> since it shipped. This is the `REACTION_FLAG_MISSING` lint case. **It is a
> one-field bug fix, not a balance change** — but flipping it roughly doubles
> Horn Rush against a Crisis PC (~150 → ~300), so fix it deliberately and re-check
> Kirin, don't let it ride in on an unrelated push. `cripple`: zero existing uses,
> nothing to migrate.

**How I got this wrong:** I grepped `scripts/` for a handler, found none, and
concluded "not implemented" without checking whether it was implemented as
*content*. That is the same failure as §0.1 — checking one layer and
generalising. In this codebase "is X built?" has to be asked of the data as well
as the code.

---

## 1. Theme & lore

**Study text (as approved):**

> A man-eating demon that lives off the mountain's leavings — travellers who
> strayed, and whatever Fafnir did not finish. It does not hunt so much as
> *collect*: bodies, and the weapons found on them. Every arm holds something
> somebody died holding.

> Note: v1 carried an extra hinting line about its guard resetting. Dropped per
> your call — the party learns the rotation by playing it. Flagging only because
> Adaptive Defense is now a **5-slot** window (§4), which is subtler than the
> v1 version and has no in-fiction tell. If it reads as opaque in the sim, the
> cheapest fix is a line of Study text, not a mechanical change.

---

## 2. Stat block

| | Value | Note |
|---|---|---|
| Level | **40** | Asura is 38; party is 41. |
| Species | **Demon** | RS to 2 types of choice — spent below. |
| Rank | **elite**, `activation: "4"` | Same structural exception as Asura: an elite with champion action economy because it is a solo encounter. |
| Attributes | DEX **d10** · INS **d8** · MIG **d10** · WLP **d8** | |
| **HP** | **840** | Asura 900 — the "small swing" is downward, see §8. |
| **MP** | **45** | Asura 60. |
| Crisis | 420 | |
| **DEF** | **14** (`dex_base 10` + `def_mod "+4"`) | Party hit rate **40.5%** — high, but clear of the DEF 15 / 32.6% line that made Imp + Dragon Guard feel like a wall. |
| **MDEF** | **12** (`ins_base 8` + `mdef_mod "+4"`) | Party hit rate **57.7%**. The intended soft flank. |
| Initiative | 12 | |
| Check bonus | +4 (L40) **+1 per form** | Attack accuracy avg ≈ 16 — elite band. |

> ⚠ **Re-stamp `defense` / `magic_defense` on disk after any clone-based build.**
> A CSB clone carries the donor's stored derived values; the live client hides it,
> every offline read shows the wrong numbers. The Skizzik/Mana Ray trap.

**Affinity:** **VU light · RS dark · RS poison · NA everything else.**
Light because it is a demon, and both Zarg's Bow and the Lunar Bow can reach it
without re-gearing. Dark and poison are the Demon species' two free resistances;
poison is the carrion-eater joke and costs the party almost nothing. **No IM, no
AB** — this monster's puzzle is the weapon layer, and a second gimmick on the
element axis would blur it. Static by design: Asura's affinities move because
elements are its subject; Rakshasa's must not, because the weapon axis is
already the moving part.

**Conditions:** IM **disarmed** (a weapon master cannot be disarmed — and this is
load-bearing now that the strip-equipment mechanic exists) · IM **frightened** ·
RS **slow**, **weak** · everything else NA, leaving four of the six
attribute-shrinkers fully open.

**Weapon Efficiency: all ten categories start at 100.** No static profile — a
baked-in "bow 150 / sword 50" would fight the dynamic system instead of seeding
it.

---

## 3. Combat shape — the Shift/Strike cycle

Four activations resolve as **Shift → Strike → Shift → Strike**: two telegraphs,
two attacks. That is why the attacks are double-potency.

**Form Shift** (Active, Self) — *the Rakshasa lets one weapon fall and draws
another.* One `apply_ae` row drawing from a 4-name pool with
`ae_pool_skip_existing: "1"` (the Carlbero primitive), which draws *without*
replacement and so can never redraw the form it is already in. One item, one row,
four stance AEs. Also restores 15 MP.

> **Change from v1:** Form Shift **no longer clears the Weapon Reads.** The
> 5-slot window (§4) is now the only thing that clears them, which is what the
> tempo clarification asks for. This also frees the Crisis passive to be about
> the window itself (§5.3).

**The four forms.** Each attack is gated `self_has_status: "<Form> Stance"` and
**consumes its own stance AE on resolve**. That one fact makes the cycle
self-regulating: stance present → exactly one attack row passes; stance consumed
→ only Form Shift remains. Priority **attacks 8, Form Shift 4** — a gap of ≥3
makes each exclusive when the other is unavailable, per the weighted-window rule,
so no cooldowns are needed (and `action_pattern_cooldown` on a priority-exclusive
row is inert anyway).

---

## 4. Adaptive Defense — the signature passive

> **Adaptive Defense.** The Rakshasa has held every weapon there is. Attack it
> with a weapon and it learns that weapon — the Efficiency of that category
> collapses, and recovers only as it is shown four *different* ones. It does not
> matter whether the attack hits.

### 4.1 The 5-slot rolling window

Per the tempo clarification: **a category needs five distinct weapon categories
shown — itself plus four others — before it is back to full.** Not a timer, not a
per-round tick: a least-recently-used window.

Each lane carries a **freshness counter, 4 down to 0**. Attacking with category X
sets X's counter to 4 and **decrements every other lane's counter by 1**. A lane
at 0 is clear.

| Counter | `<cat>_ef` | Reads as |
|---|---|---|
| **4** (just used) | **25%** | you just showed it this |
| 3 | **40%** | one other category since |
| 2 | **60%** | two others |
| 1 | **80%** | three others |
| 0 (cleared) | **100%** | four others — fully reset |

> ⚠ **MEASURED 2026-09-08 — the table below is WRONG and the mechanic does not
> work against the real party. Read §9 before acting on anything in this
> section.** The party cannot field four lanes; the sim measured **two**.

**The tempo this was intended to produce:**

| Party composition | Efficiency each PC attacks at | Why |
|---|---|---|
| One PC spamming one category | **25%** | refreshed to 4 every time |
| Two PCs sharing a category | ~40% on that lane | |
| **4 PCs, 4 distinct categories** | **80%** | three others since your last swing — one short |
| **5 distinct sources** (guest, summon, a PC swapping weapons) | **100%** | four others — the window closes exactly |

A four-person party is *permanently one slot short*. Not punished — 80% is a mild
tax — but never quite whole, and a fifth distinct source is worth real damage.
That makes guests, summons and a PC carrying a second weapon category actively
valuable, which is the stated design goal.

**Why the curve accelerates (25 → 40 → 60 → 80).** A linear 25/50/75/100 would
close the window in three others, not four. The uneven first step also puts the
sharpest pain immediately after the repeat, where the lesson is legible, and
makes the last two steps feel like recovery rather than a grind.

### 4.2 ⚠ Implementation — this needs a small engine primitive, not 100 rows

The declarative reaction/AE system has **no ordered-list or counter-arithmetic
primitive**. Expressing the window with AEs alone means four tier AEs per lane
swapped by `replace_family`, plus a step-down row per (lane × tier), across two
triggers — roughly **100 authored rows for ten lanes**. That is brittle in a way
the reaction linter cannot catch (it validates row shape, not ordering logic), and
every future adaptive monster would re-author it.

**Recommendation: one new declarative effect kind, `weapon_read`** (~60 lines in
`skill-effects.js`, dispatched like every other kind):

```jsonc
{ "effect_label": "read_weapon", "effect_kind": "weapon_read",
  "target_ref": "self",
  "read_window": 4,                       // others needed to fully clear
  "read_curve": "25,40,60,80",            // counter 4..1 → EF%
  "read_category": "ATTACKER_WEAPON",     // or a literal family
  "read_evict": true }                    // false = Crisis mode, §5.3
```

It reads an ordered history off one actor flag, recomputes every `<cat>_ef`, and
commits **one** actor update per attack. Properties that matter:

- **Deterministic and unit-testable** — pure function from (history, category) to
  a props patch. The 100-row version is testable only in play.
- **One write per attack**, which matters because this fires on every party
  attack. Must go through the **activeGM gate** (GM Host / Anti-Dedupe pattern) or
  a dual-GM table double-decrements, and must join the existing write serializer
  so it cannot clobber concurrent socket-driven writes.
- **Crisis is a boolean** (`read_evict: false`) instead of a second row set.
- **Reusable.** Any future "it adapts to X" monster is one row.

The alternative — ~100 authored rows — is written up here only so the tradeoff is
explicit; I do not recommend it and would rather cut lane count than take it.

### 4.3 Trigger wiring

Two rows total, not two per lane, because the effect kind resolves the category
itself:

- `creature_hit_by_action` (`state-handlers.js:1326`)
- `creature_miss_action` (`state-handlers.js:1415`, `:1483`)

Both thread the attacker's weapon, which is what "doesn't have to hit" needs.
Post-resolve firing is also the fairer reading: the read lands *after* the attack
you made, so you see the penalty before it applies to anything.

`creature_targeted_by_action` is wrong here — it fires pre-roll (penalising the
triggering attack with no warning) and its payload contract
(`reaction-derive.js:107`) carries `weaponType` but **not** `weaponUuid`.

### 4.4 Category resolution — the shield fix

Resolution order for "what category was that attack":

1. `payload.weaponUuid` → item `category` (real weapons).
2. **`item_type: "shield"` → `brawling`** (ruling 0.3).
3. Fall back to **`payload.weaponType`** — present on both triggers, and the only
   thing that works for **virtual attacks** like Twin Shields, which have no item.
4. Spell (`actionKind` Spell, no weapon) → **`arcane`**, matching §0.1.
5. Nothing resolvable → no read (fails closed).

Step 3 is the ~8-line change; steps 2 and 4 are two lines each. Without step 3,
Blanche's attacks are damage-taxed by `brawling_ef` but never *register* a read —
she would be invisible to the mechanic while still paying for it, which is the
worst of both.

### 4.5 Lane coverage

All **ten** categories (arcane, bow, brawling, dagger, firearm, flail, heavy,
spear, sword, thrown), plus spells folded into `arcane` per §0.1. With the
`weapon_read` primitive this is a config string, not authoring cost, and the
multiparty rule means the roster on the night is not knowable in advance. At most
five lanes are ever non-clear, so the token's status tray stays readable.

---

## 5. The four attacks

### 5.1 Numbers

Design target: **~106 raw per attack**, derived from Asura — Asura lands ~53 raw
per hit × 4 activations; Rakshasa gets **2** attacks per round, so per-attack
parity is ~106. That is Asura's baseline *without* the Lightning Storm and Quad,
which is where Asura's excess actually came from.

**The 200% now comes from the keywords, not from `damage_bonus`.** Sword and
Flail therefore carry much smaller bonuses than v1, and are conditional:

| Form | Skill | Keyword | Target | `damage_bonus` | Raw when keyword misses | **Raw when it lands** |
|---|---|---|---|---|---|---|
| **Sword** | Execute | `execute` | One Creature | **30** | ~51 | **~102** (target in Crisis) |
| **Flail** | Cripple | `cripple` | One Creature | **28** | ~49 | **~98** (target not in Crisis) |
| **Throwing** | Chakram | `multi` (3) | Up to three creatures | **16** | — | ~37 ea = **~111** |
| **Bow** | Rain of Arrows | `overflow` | All Enemy, 30 MP | **11** | — | ~32 ea = **~128** |

(HR = two actor dice ≈ 11, plus the L40 flat +10.) Mean ≈ **110** — on target.
All four resolve vs **DEF**.

### 5.2 What the keywords buy, tactically

This is the part I think is genuinely good, and it came out of your own naming:

- **Flail/Cripple hunts the healthy** (`target_focus: "highest_hp"`). Reliably
  ~98 plus a DEF debuff — the opener.
- **Sword/Execute hunts the wounded** (`target_focus: "lowest_hp"`). ~102 on a
  PC in Crisis, a limp **51** on anyone healthy.
- So **"is anyone in Crisis?" becomes the party's own lever.** Keep everybody
  above half and the Sword stance is a wasted activation. Let someone slip and
  the next Sword telegraph is a death sentence they have one turn to answer.

> ⚠ **Execute is lethal by construction and that needs sim attention.** A PC in
> Crisis is at ≤ half HP (Hina ≤49, Keren ≤48, Zarg ≤55, Blanche ≤83); ~102 kills
> any of them. That is what the keyword *means*, and the party has two real
> answers — heal out of Crisis, or **Blanche's Protect**, which redirects the
> single-target hit onto DEF 19+. But if the sim shows Execute reliably
> converting one downed PC into a chain of them, the dial is Sword's bonus (30),
> not the keyword.

**Riders:** Chakram → **Bleed** (existing common AE, `charges 3`,
`target_turn_end`). Cripple → a cleansable DEF debuff; `defense` is CSB-derived,
so a literal −50% needs an AE in **MULTIPLY** mode (the AE manager supports it —
**verify live that CSB honours it on a derived prop**), with a flat
`bonus_defense: -6` as the fallback. If MULTIPLY does not take, say "reduces
Defense" in the text rather than promise a percentage the engine cannot deliver.

**One required addition — a non-Strike option.** Every form above is
Strike-class, and Asura's live test found a single Strike-immune enemy (Ghostly
Sheet) **blanked the entire monster**. **Devour** — Active, One Creature,
auto-hit, no accuracy check, modest damage, heals the Rakshasa for half. Auto-hit
⇒ damage-class `null` ⇒ bypasses Strike immunity. Fires only when no stance is
held and Form Shift is unavailable. One row, and it is the man-eater flavour.

### 5.3 Crisis passive — **Ten Thousand Arms** (confirmed)

> At Crisis, the Rakshasa stops setting its weapons down. **The window stops
> evicting** — a category it has learned, it keeps. Efficiency now only falls.

`read_evict: false`. One field.

- **It escalates the signature mechanic** rather than sitting beside it: the
  thing you spent five rounds learning is the thing that changes.
- **It is a shot clock, not a stat block.** With no eviction, all four rotating
  lanes ratchet toward the 25% floor over roughly two rounds. The second half of
  the HP bar has to be spent fast.
- **It never touches action economy** — every telegraph still gets an answer,
  which was your objection to the +2-activation version.

Floor stays **25%**, never lower, or the fight stalls instead of ending.

**Held in reserve** (do not build yet): at Crisis, Form Shift draws **two**
stances and the Strike fires both at ~65% potency each. Keeps the telegraph
honest — two stance chips, the party still sees what is coming — and reads as a
four-armed demon finally using all four arms. Add only if the sim says the clock
alone is too soft.

---

## 6. Execute / Cripple — authored rows, no engine work

Copied from Kirin's working pattern (§0.4). Two rows per skill, four rows total.

**Sword — Execute** (200% to a creature **in** Crisis):

```jsonc
"reaction_config_table": { "0": {
  "reaction_trigger":      "creature_will_deal_damage",
  "reaction_source":       "self",
  "reaction_source_skill": "Execute",
  "condition_formula":     "TARGET_AE_COUNT_CRISIS > 0",
  "reaction_passive_mode": "force",
  "reaction_effect_ref":   "sword_execute"
} },
"effect_table": { "0": {
  "effect_label": "sword_execute", "effect_kind": "adjust_damage",
  "damage_operation": "multiply", "damage_amount": "2", "damage_stage": "outgoing"
} }
```

**Flail — Cripple** (200% to a creature **not** in Crisis): identical, with
`condition_formula: "TARGET_AE_COUNT_CRISIS == 0"` and its own `effect_label`.

**Both items need `isReaction: true`** — the flag that killed Kirin's copy. Run
`FUCompanion.api.lint.runReactionLint` after authoring; `REACTION_FLAG_MISSING`
is exactly this.

Notes worth carrying:

- **`creature_will_deal_damage` fires per hit target during CONFIRM, before
  affinity**, so a VU target takes double the doubled figure — the natural
  reading, and consistent with `damage_taken_increased_<el>`.
- **Mutually exclusive by construction.** A target is in Crisis or not, so
  exactly one of the two can ever fire. No stacking case to guard.
- **The gate reads the Crisis *AE*, not HP.** That is what
  `TARGET_AE_COUNT_CRISIS` does, and it is what Kirin already relies on, so
  Rakshasa inherits the same exposure rather than inventing a new one: the AE is
  maintained by the crisis-reactor and could in principle lag a mid-card heal.
  Worth one dry-run probe (heal a PC out of Crisis, then swing Execute in the
  same round) — if it lags, that is a Kirin bug too, and a shared fix.
- **Pre-damage by construction.** The trigger fires before the damage lands, so a
  target this attack pushes *into* Crisis does not retroactively earn the 200%.
- Add the new rows to the skill-regression goldens; expect MODIFIED rows, accept
  with `--update`, confirm the "removed" count is zero.

---

## 7. Adjacent engine fixes worth taking while in here

1. **`readWeaponEfficiency` treats 0 as 100** (`snapshot.js:125`, `v > 0`) while
   `apply-damage-core` step 9a honours 0. The same authored value behaves
   differently depending on which damage path fired. Rakshasa's 25% floor dodges
   it, but it is a live inconsistency and a trap for the next author.
2. **`deal_damage` effect rows bypass weapon efficiency entirely** (§0.1) — no
   `weaponType` is passed. Correct for Burn ticks, wrong for a skill whose main
   damage is authored as an effect row. Optional additive fix: a
   `damage_weapon_type` field on the row, blank = today's behaviour.
3. **Kirin's `Horn Rush` has `isReaction: false`** (§0.4), so its Execute has
   never fired. One field, but flipping it roughly doubles the attack against a
   Crisis PC — fix it on its own, not folded into an unrelated push.
4. **The stale comments** that cost this review two passes: `action-profile.js`'s
   "PHASE 0 — no FSM caller invokes this yet" header, and the EF-inert-for-spells
   note in `reference_monster_actor_setup` (**already corrected**).

---

## 8. Balance budget

**HP 840.** Asura's 900 priced in ~270 free damage from the Lightning Storm,
which Rakshasa has no equivalent of. Against that, Rakshasa taxes party output
through Adaptive Defense: a rotating four-person party sits at **80%** efficiency
(§4.1), so party EffDPR ≈ 206 × 0.80 ≈ **165**. Five rounds × 165 ≈ **825**.
840 it is.

| Target | Value |
|---|---|
| Fight length | **~5 rounds** |
| Party HP at end | **40–60%** (Asura landed at 21% — too lethal) |
| Expected party EffDPR | ~165 (rotating 4) · ~206 (5 distinct sources) · ~60 (one-category spam) |
| Damage taken | ~110 raw per attack, 2 attacks/round |

**The 25% floor widens the spread, deliberately.** Careless play now costs ~4×
rather than v1's ~2×, so the *variance* between a good and a bad table is larger
than the playbook's comfort zone. That is the point of the mechanic, but it means
the sim needs to run **both** a rotating party and a lazy one — a single
well-played sample will not surface the failure mode.

**Known-unknowns, stated rather than papered over:**

- **Party DEF at L41 is not in the snapshot** (only the L30 values). The
  monster's landing rate — and therefore every number in §5 — hangs off it.
  **Measure before the first tuning pass.**
- `BaselineDPR` is unverified at this tier, and **Asura's 900 inherits the EF
  error from §0.1**, so "parity with Asura" is a shakier anchor than it looks.
- Dial order: **Sword's bonus** (Execute lethality) → the read curve → HP last.
  Per-hit damage moves the fight; HP only moves its length.

---

## 9. ⚠ SIM RESULTS — the mechanic does not work as designed

Measured 2026-09-08 with Mindscape, before anything was built.
`tools/mindscape/specs/rakshasa.json`, 400–500 runs per cell.

```
node tools/mindscape/bin/mindscape.js --enemy-file specs/rakshasa.json \
     --runs 500 --force --expected 12
```

### 9.1 The party fields TWO lanes, not four

The whole design rests on the party having four or five weapon categories to
rotate between. Measured against the real EXFURSION roster:

| PC | Modelled damage | Lane |
|---|---|---|
| Hina | all spells | **arcane** |
| Keren | Phantasm spells (his dagger is a fallback he rarely reaches) | **arcane** |
| Zarg | bow only | **bow** |
| Blanche | **none modelled** — Twin Shields is a virtual attack | — |

> Both casters route through `arcane`, because the house rule (correctly)
> makes spells count as Arcane. So the party's offence is **bow + arcane**, and
> the sim's lane report reads:
>
> ```
> weapon lanes  (2 distinct families fielded by the party)
>   bow         64% of swings   mean efficiency 33%
>   arcane      36% of swings   mean efficiency 50%
> ```

**With two lanes a 5-slot window can never open.** Each lane is re-read every
other swing, so it oscillates between the floor and one step above it and never
climbs. Confirmed by sweeping the window itself:

| `read_window` | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| party DPR | 26.4 | 26.0 | 27.1 | 27.3 |

**The tempo dial is inert.** Only the curve's floor does anything. The mechanic
is not a rotation puzzle against this party — it is a flat damage multiplier
with a rotation-themed description.

### 9.2 The multiplier is roughly half what the design claims

Same fight, only the curve varying. Baseline is the same monster with the read
switched off:

| curve | party DPR | share of baseline |
|---|---|---|
| off (100/100/100/100) | 87.8 | 100% |
| **25/40/60/80 (as designed)** | **39.3** | **45%** |
| 50/65/80/95 | 54.2 | 62% |
| 65/80/90/100 | 65.4 | 74% |
| 80/90/100/100 | 74.1 | **84%** |

§4.1 claims a steady state of 80%. The authored curve delivers **45%**. To get
the 80% the design intends, the curve has to be **80/90/100/100** — at which
point the mechanic is barely perceptible, which is its own problem.

### 9.3 840 HP is unkillable, and that is not mostly the mechanic's fault

Every configuration ran out the 12-round budget. But so does the read-disabled
control (10 rounds, 95% win), so **HP is the larger error**: the design derived
840 from an EffDPR of ~165–206 that does not exist against a solo target.

The party's own multi-target actions collapse to one target against a solo boss.
Control run, Asura, same party: **DPR 95.2**, versus 164.6 against Inferex +
Centuaros. A solo fight roughly halves party output before any monster mechanic
touches it.

### 9.4 How much of this is the model, not the design

Stated plainly, because it bounds every number above:

- **Blanche deals literally zero damage in the model** — a quarter of the party.
  Her Twin Shields is an AE-exposed virtual attack the loader does not model.
  In play she also adds **brawling** as a third lane, so the two-lane figure is
  the floor, not the ceiling. Three lanes still cannot open a four-slot window.
- Zarg contributes only his bow; summons, Zero Power and Fabula Points are all
  unmodelled, and a long solo fight gives each of them more time to matter.
- Calibrating against Asura's live result (~900 HP cleared in ~4 rounds ⇒ live
  DPR ≈ 225 vs Mindscape's 95) suggests Mindscape understates solo-boss party
  output by roughly **2.4×**. Recorded as `expectations/asura-solo.json`.
  **One live data point — an order-of-magnitude correction, not a constant.**

Applying that correction: at the intended 80% efficiency, live DPR ≈ 178, so a
5-round fight wants **~890 HP** and 840 is about right. At the *authored* 45%
curve, live DPR ≈ 94 and the same fight wants **~470 HP**.

**So HP and the curve cannot be chosen independently — pick the curve first.**

### 9.5 What I would change

The two-lane finding is structural and re-tuning does not fix it. Three options,
in the order I would consider them:

1. **Read the ATTACKER, not the weapon.** "It learns whoever just hit it." A
   four-person party then has exactly four lanes by construction, the window
   becomes live, and the rotation the brief asks for ("always switch your
   offence") is something the party can actually act on. Costs the weapon-master
   flavour, which is a real loss — but it is the only option that makes the
   tempo dial mean anything.
2. **Keep weapons, accept it is a multiplier**, set the curve to 80/90/100/100
   and drop the five-slot framing from the text. Honest and cheap; the mechanic
   becomes flavour on a ~20% damage tax.
3. **Split the arcane lane** (spells separate from arcane weapons) for three
   lanes. Cheapest, but both casters still share the spell lane, so it buys one
   lane and the window still cannot open.

I would not build any of the four attacks until this is settled — their damage
numbers are downstream of which of these we pick.

## 10. Build order

1. **Engine, before any content — now just one feature.** The `weapon_read`
   effect kind (§4.2) plus category resolution incl. shield → brawling and the
   `weaponType` fallback (§4.4), and the §7 fixes. Additive, off by default.
   Unit-test the read curve as a pure function.
   *(Execute/Cripple no longer appear here — they are authored rows, §6.)*
2. **Kirin's `isReaction` fix** — separate, deliberate, re-check Kirin after.
3. **Actor + 4 stance AEs.** Clone-don't-construct; re-stamp `defense` /
   `magic_defense` on disk; write the four sheet list mirrors or the sheet renders
   empty.
4. **Skills:** Form Shift, four forms, Devour, Adaptive Defense, Ten Thousand
   Arms. `isReaction: true` on **every** item carrying `reaction_config_table`
   rows, then `FUCompanion.api.lint.runReactionLint`.
5. **`action_pattern_table`** — attacks @8 gated `self_has_status` (Sword
   `lowest_hp`, Flail `highest_hp`), Form Shift @4, Devour @5.
6. **Offline dry-run** — mind the prePassives/acceptPassives trap. Verify: stance
   consumption; the pool draw never repeating; the window stepping 25→40→60→80→
   clear across five distinct categories; a 4-PC rotation settling at 80%; the
   floor clamping; eviction stopping at Crisis.
7. **Sim, both party behaviours** (§8). Model **target concentration** — a
   cruncher that ignores focus fire has overrated every monster we have built.
8. Live test. Then loot, steal table, animations.

---

## 11. Open questions

**1 is the only one that matters right now — the rest are downstream of it.**

1. **§9.5: read the ATTACKER, keep weapons as a flat multiplier, or split the
   arcane lane?** The party fields two lanes, so the rotation window can never
   open and the tempo dial is measurably inert. This is a structural choice, not
   a tuning one, and every damage number in §5 depends on it.
2. **`weapon_read` effect kind — still approved?** It remains the one piece of
   real engine work the design asks for, and it is needed under any of the three
   §9.5 options (all three need ordered state). But do not build it before 1.
3. **HP** — 840 only holds at the ~80% steady state the design *intends*. At the
   curve actually authored it wants ~470. Pick the curve, then the HP (§9.4).
4. **Kirin's `isReaction: false`** — fix it (Execute starts working, Horn Rush
   roughly doubles vs a Crisis PC) or leave it and re-tune Kirin first?
5. **Does Rakshasa go on the Valley of the Dragon encounter table**, or stay a
   hand-placed event? Asura's arena-scene dependency is still open.

> **Worth noting for later, not now:** the same `creature_will_deal_damage` +
> `adjust_damage multiply` pattern could in principle carry Adaptive Defense too,
> instead of writing `<cat>_ef` props. I am not proposing it — the 5-slot window
> still needs ordered state that no declarative row can hold (§4.2), and EF props
> are what the sheet displays and what "Weapon Efficiency" means in the game's own
> language. But if the `weapon_read` kind is rejected, that is the direction the
> fallback design would take.
