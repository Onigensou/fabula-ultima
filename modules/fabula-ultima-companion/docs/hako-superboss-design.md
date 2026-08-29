# 🌟 Hako — Super Boss Design Notes

**Status:** brainstorming. Nothing authored. No implementation until sign-off.
**Started:** 2026-08-28

---

## 1. Concept

Hako is the campaign's traveling merchant — the NPC the party has been buying from all
game. In the final chapter she is available as an **optional secret boss**.

She fights alongside **Mr. Mimic**, her monster partner. Mr. Mimic is the DPS and the
bodyguard; Hako is an IP-based utility/disruption support who never touches the party
directly — she throws things.

Fantasy: *a randomizer*. Her output is drawn at random from her stock, so no two runs of
the fight look alike.

### Super Boss charter (user's definition, recorded verbatim in intent)

- Still Champion rank, prefixed 🌟.
- Budget raised to an "unfair" level. The fairness question is **suspended**, but the
  fight must remain **beatable**.
- A mandatory puzzle/solve is **one** valid approach, **not** a requirement. Hako is not
  a solve-or-die design.
- Super bosses carry a time pressure that punishes stalling.

### Rank ladder for reference

| Rank | Meaning |
|---|---|
| Soldier | General dungeon trash |
| Elite | Strong dungeon monster |
| Champion | Story boss — own mechanics, built to be beaten fairly |
| 🌟 Super Boss | Champion rank, unfair budget, beatable but not fair. Optional/secret. |

Reference point for tier: **Ozmo** (L40 Champion, 2017 HP, 3 UP, Zero Power 6).

---

## 2. Target numbers

| Dial | Value |
|---|---|
| Party level | **50** |
| Target fight length | **7 rounds** |
| Hako activations | **3** |
| Mr. Mimic activations | **1** |
| Total boss activations/round | **4** |

---

## 3. Hako — kit (draft, not finalized)

### Throw Item — Skill, 2 IP
Throws one item chosen at **true random**. Effect depends on the item.

| Item | Effect |
|---|---|
| Anvil | Devastating Physical damage, single target |
| Bomb | Heavy Fire damage, all enemies |
| Lance of Longinus | Reduce target's HP to 1 |
| Poison | Medium Poison damage + inflicts Poisoned and Envenomed, single target |
| Love Potion | Inflicts Charm on all enemies |
| Addleweed | Target loses 50 MP + inflicts Silence |
| Remedy | Heal target ally 50 HP |
| Elixir | Restore 50 MP to target ally |

### Go! Mr. Mimic! — Skill, 30 MP
Grants Mr. Mimic 1 additional Turn Activation.

### Restock — 30 MP
Hako fully restores her IP. *(Proposed extension: also refills the bag — see §6.)*

### Panic Mode — Passive
While in **Crisis** (HP < 50%), Throw Item throws **2** items instead of 1.

### Intended rhythm
- **Offense:** Hako throws, causing damage and disruption.
- **Defense:** when she runs dry on IP she must spend an activation on Restock; when
  Mr. Mimic is downed she must spend activations repairing him. These are the party's
  breathing room.

---

## 4. Mr. Mimic

- **Protects Hako at all times while active.** Ruling = the Guardian **Protect** skill
  with the once-per-turn limiter removed.
  > *Protect: Once per turn. Take an ally's incoming attack or status instead.*
  > — `Item.YBTRLqaFzBFu5xyt`
  Note this redirects **attacks and statuses**, so Hako is status-proof while he is up.
- **Cannot be permanently defeated.** Downing him knocks him out for 1 round, during
  which Hako spends time repairing him. That is the party's damage window on Hako.
- **AoE tech:** hitting both with an AoE makes Mr. Mimic eat Hako's instance as well as
  his own → he takes **double**. This is the intended route to breaking him in
  reasonable time, and his HP must be sized around it.
  - *This falls out of unlimited Protect automatically — it is not a special-case rule.
    He takes his instance, then takes hers. No extra authoring needed.*
- Actions: **TBD.**

---

## 5. Verified rules facts

Checked against the live registry/world, 2026-08-28.

### Charm — the debuff (`x6ByoJnflDAuVn9r`)
> - Can't target the **charmer** or include them as the target of actions.
> - Reduce **opposed check** against the **charmer** by 2.
> - *(Charmer is the source of the charm)*
> - **Basic Condition:** Dazed

**It is a targeting lockout on the charmer, not mind control.** There is a separate
Fafnir boss *skill* also called Charm that forces a creature to act harmfully toward an
ally — different thing, do not conflate.

Consequences for Love Potion:
- Against a party that already cannot reach Hako (Mimic up), Love Potion is **inert**.
- Thrown during a **window**, it is a hard window-denial card — the single nastiest
  possible timing. Its value is entirely conditional.
- The **−2 opposed check** clause is the natural brake on stealing (§6).
- Carries Dazed (INS −1) via its Basic Condition.

### Protect — Guardian skill (`Item.YBTRLqaFzBFu5xyt`)
> *Protect: Once per turn. Take an ally's incoming attack or status instead.*

Granted by the parent Guardian skill item `SJSmfMW8C8gzwsuT`.

---

## 6. Steal — party counterplay

Thematically perfect (she's a merchant; the system already has `stealable_loot` +
`steal_percentage_table`), but must not become *"strip the bag, fight over."*

**Three interlocking brakes, no arbitrary caps needed:**

1. **You can only steal during a window.** Mr. Mimic guards the bag exactly as he guards
   Hako. Steal attempts therefore cost **window turns** — the scarcest resource in the
   fight. With ~2 windows × 4 PC turns = ~8 window turns total, and Hako needing roughly
   2 full windows of focused DPR to die, every steal trades directly against the kill.
   Stripping the bag inside 7 rounds is arithmetically impossible.
2. **Restock refills the bag, not just IP.** Denial is per-cycle and tactical, not
   permanent. This makes the victory-lap state **unreachable by construction** — an
   empty bag is a one-activation problem for her.
3. **Charm taxes it.** A landed Love Potion applies −2 to opposed checks against Hako,
   so a charmed party has a materially worse time stealing.

**Why steal is still worth doing:** denying a Jackpot item (§7) for a cycle is a real
tempo win, and stolen items presumably become party-usable.

**Empty-bag floor:** she still needs a non-blank action for the edge case. With brake 2
in place this resolves itself, but a modest default action ("Haggle" / improvised throw)
should exist so the state is never literally nothing. *Easy is acceptable; inert is not.*

---

## 7. Open design problems

### 7.1 Flat 12.5% × 3 draws kills the variance — **unresolved**
8 items at flat probability, 3 draws/round, 7 rounds = **21+ draws**. That converges to
the average. The "she rolled well / she rolled badly" fantasy needs rare outcomes to
exist at all.

Proposed fix — **tier the table**:
- **Common (~70%)** — Anvil, Bomb, Poison, Addleweed. The steady baseline.
- **Uncommon (~25%)** — Remedy, Elixir.
- **Jackpot (~5%)** — Lance of Longinus, Love Potion. Fight-warping, rare enough to be
  an event.

At 21 draws a 5% slot fires at least once in ~66% of fights — memorable, not guaranteed.

### 7.2 Panic Mode — **RESOLVED, no IP cost increase**
Earlier suggestion to double the IP cost is **rejected** (user's call, and the math backs
it): Panic Mode is a *benefit* she gains in Crisis. Raising its cost would push her into
her defensive phase faster, which lowers pressure — the opposite of an escalation.

Confirmed clean as written: 2 items for the same 2 IP means **IP burn per round is
unchanged** (3 throws × 2 IP = 6 IP/round), so Restock cadence is identical while output
doubles. Pure upside, self-consistent.

### 7.3 IP vs MP — **user still deciding**
Current shape is actually coherent: **IP is the ammo, MP is the reload.**
- IP fuels Throw Item.
- MP fuels Restock and Go! Mr. Mimic!

This gives the party's MP-denial kit (Drain Spirit etc.) a real chain to attack:
drain MP → she can't Restock → she runs genuinely dry on IP → fewer throws. The
interaction the merchant flavor wants already exists without changing anything.

Open question is whether IP should *also* be directly attackable, or stay a pure
metronome.

### 7.4 "Go! Mr. Mimic!" is action-neutral — **unresolved**
She spends 1 of her 3 activations to give Mr. Mimic 1. Total stays 4. It is only correct
to cast if a Mimic action beats an average Throw Item **plus** 30 MP. As written the AI
will rationally never pick it. Options: grant **2** activations, make it free/reaction
speed, or make Mimic's actions individually nastier than a throw. Resolve alongside §4
(Mimic's action list).

### 7.5 Action economy may be under-tuned for the tier — **unresolved**
4 boss activations vs 4 PCs is a **normal Champion** ratio, and 12.5% of her output is a
blank (Remedy). Against 5 PCs it is under water. Either individual throws must hit far
harder than a standard boss action, or a 5th activation is needed somewhere.

### 7.6 Lance of Longinus is a setup card, not a finisher
HP→1 kills nobody alone; with 3 activations, Lance→Bomb is a real execute. Its value is
therefore *itself* randomized (whiff on an already-low PC, lethal on a healthy one).
Good variance-on-variance for this boss — just be aware it is not the scariest item
despite sounding like it.

### 7.7 Elixir is not a dud
50 MP restored ≈ two Restocks (30 MP each). The genuine blank rate is **12.5%** (Remedy
only), not 25%. Also define whether Mr. Mimic has MP at all, or Elixir-on-Mimic is a
double whiff.

---

## 8. Budget math — 7-round skeleton

Proposed shape:

| Round | State |
|---|---|
| 1–3 | Party burns Mr. Mimic with AoE |
| 4 | **Window 1** — Mimic down, Hako exposed, Hako repairs |
| 5–6 | Mimic back; party burns him again |
| 7 | **Window 2** — kill |

Derived sizing rules:

- **Hako's HP is not a health pool, it is a window counter.** She only ever takes damage
  during windows. Size it as `2 × (party single-target DPR for one round)`.
- ⚠️ **Collapse every Multi/AoE to one target when computing that number.** If downed
  Mr. Mimic is still on the field during the window, party AoE splits and true DPR on
  Hako is single-target only. This is the exact trap that mis-sized Gigas.
- **Mr. Mimic printed HP** = `2 × (3 rounds of party AoE output)` for break #1, since AoE
  hits him double. Note only the **AoE** portion doubles — single-target hits land once,
  so compute against the party's AoE output specifically. Break #2 should be faster
  (~2 rounds) to fit the skeleton.
- **Survivability side:** the party eats ~21 thrown items (more once Crisis/Panic Mode is
  live) plus 7 Mimic activations across the fight. Total incoming must be lethal-ish but
  survivable at L50.

**Blocker:** we do not have an L50 party DPR/HP snapshot. The existing snapshot is L30
(Hina/Zarg/Keren/Blanche). Every number above is a formula until that exists.

### Window boundary definition (must be nailed down)
"KO for 1 round" is turn-order dependent. Proposed: dropped → exposed for the **entirety
of the next round** → repaired at end of that round. Otherwise the window silently
shrinks depending on who acts when.

---

## 9. Implementation landmines (for when we build)

- **`creature_takes_damage` is dead on items.** Mr. Mimic's protect-and-double is a
  damage-time interception — it must route through `creature_will_deal_damage` +
  `adjust_damage`, not a takes-damage trigger. This is what gutted Asura's Aspect machine.
- **Do not revive Mr. Mimic via `summon_overrides`** — Birth of the Cruel bug: the minion
  spawns as a full-strength elite at 0 HP. Keep him on the field in a downed state.
- **`action_pattern_cooldown` is inert on a priority-exclusive row.** Relevant if Throw
  Item is one action with a random branch under a priority window.
- **`creature_lose_resource` is the only observer-aware trigger** — the right hook for
  anything that should fire when Hako spends IP.
- **Charm on player-controlled PCs**: confirm how BD surfaces the targeting lockout to
  players before Love Potion ships. At Jackpot rarity it will still come up regularly.

---

## 10. Decision log

| Date | Decision |
|---|---|
| 2026-08-28 | Fight length target set to **7 rounds** |
| 2026-08-28 | Balance target set to **L50** party |
| 2026-08-28 | Hako 3 activations, Mr. Mimic 1 |
| 2026-08-28 | Hako is **fully** protected behind Mr. Mimic — Guardian Protect ruling, limiter removed |
| 2026-08-28 | Panic Mode does **not** cost extra IP — it is a Crisis benefit, and raising cost would reduce pressure |
| 2026-08-28 | Steal accepted as a mechanic, gated behind windows + bag-refilling Restock so a victory lap is unreachable |
| 2026-08-28 | Charm verified as a targeting lockout, **not** mind control — Love Potion re-read as a window-denial card |
| 2026-08-28 | No mandatory-puzzle framing — Hako is "unfair but beatable", not solve-or-die |

---

## 11. Still to decide

- Mr. Mimic's action list (§4) — blocks §7.4.
- Item table weighting (§7.1).
- IP pool size and MP pool size (§7.3).
- Whether Restock refills the bag (§6 brake 2) — recommended yes.
- Fix for Go! Mr. Mimic! being action-neutral (§7.4).
- Whether a 5th activation is needed (§7.5).
- L50 party DPR/HP snapshot — **blocks all sizing**.
- Per-item damage expressed as a fraction of one PC's max HP, not flat numbers.
