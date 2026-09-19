# ⭐️ Hilde-Fafnir — Final Boss Design Notes

**Status:** DRAFT — benchmark update. Design only; nothing in this doc is authored in the
world yet. Additive to the live placeholder kit (§2); **not final** — more passes to come.
**Benchmark:** 2026-09-20
**Actor:** `2SFrEMqLBfqzc7Nj` (champion, L55, Fafnir Castle final boss)
**Build script:** `tools/safe-edit/bin/_build-hilde-fafnir.js` (still builds the §2 kit)

---

## 1. Concept — Culling the Weak

Hilde-Fafnir's actions revolve around **killing characters who are weakened or near death
outright**. Heavy Crisis interaction: Cripple pushes targets into Crisis, Execute finishes
them, and her Zero gauge feeds on the party falling.

She is the **final boss of the game — go hard**. She tries to kill PCs. A KO is an
expected outcome, not a design bug, and there is deliberately **no recovery window**
after Lance of Ruin.

---

## 2. Baseline — the live placeholder kit (built 2026-08-29)

| Stat | Value |
|---|---|
| HP / MP | 2400 / 500 |
| DEF / MDEF | 18 / 18 |
| Init | 16 |
| Max Zero | 6 |
| Ultima Points | 5 |
| Turns / round | 4 (champion, sized vs L45-50 party) |
| VU | none (boss) |

| Action | Live shape | AI row |
|---|---|---|
| Dragoon Lance | Attack, heavy Physical, vs DEF, one creature | `always`, prio 3, `lowest_hp` |
| Wyrmbreath | Spell, heavy Dark, vs MDEF, all enemies, 40 MP | `mp`, prio 6, cooldown 1 |
| Lance of Ruin | Active, all enemies → 1 HP (`deal_damage CUR_HP - 1`, `crush`), 50 MP, **once per conflict** | prio 12, `self_lacks_status: Lance Spent`, `hp_ceiling: 60` |

(Crown of the Sleeping Dragon was removed 2026-08-30 under the affinity-labels rule.)

---

## 3. Signature — Lance of Ruin (goes periodic)

- **Effect unchanged:** all enemies reduced to 1 HP, via `crush` (no DR, ignores immunity).
- **Periodic instead of once per conflict.** The `Lance Spent` marker becomes a **timed
  cooldown AE**; the row keeps `self_lacks_status` gating (a pattern cooldown is inert on
  a priority-exclusive row).
- **Keeps `hp_ceiling: 60`** — she only casts it below 60% HP.
- **Cost raised a LOT** — proposed **~150 MP** of her 500 (tune in simulation).
- **Tell — deliberately vague.** Her MP is **not** shown. Players who Study her see max
  MP and can estimate how many Lances she can afford; they are only meant to *roughly*
  predict it.
- Lance of Ruin **does** proc Contempt (§4): a full party dropping to 1 HP all enter Crisis
  at once. Intended — that is the pressure clock.

**Rotation intent:** Lance forces the whole party to 1 HP → a **healing check** that
breaks the party's tempo, with Reinslaughter looming over anyone left low.

---

## 4. Zero Trigger — Contempt

> Whenever an enemy **enters Crisis or is reduced to 0 HP**, Hilde-Fafnir gains 1 Zero Power.

- **One event per hit.** A one-shot from above half HP straight to 0 counts **once**, not
  twice.
- **Lance of Ruin procs it.** Her **Zero Power (Reinslaughter) does not** — neither its
  Crisis entries nor its KOs.

---

## 5. Zero Power — Reinslaughter (version 1, revised)

> Deals Bolt damage to all enemies. Damage against each target **increases the lower that
> target's HP percentage is**.

- **No Execute keyword.** Scaling on missing HP% is the execute by itself.
- **Counterplay is allowed, but costs a life.** Protect / Prophetic Defender style
  redirects are valid answers — the defender saves their friend, **but dies for sure**.
  The scaling is computed from the **originally targeted** ally's HP%, not the
  defender's, and the top of the curve (target at 1 HP) is tuned to exceed any PC's max
  HP plus their best mitigation.
- **Affinity:** handled however the system currently supports (Bolt resist / immune /
  absorb apply as normal) for now. Intent for later tuning: a final-boss Zero Power
  should **not** be completely shut down by absorb. There is no Bolt-absorb gear today.

**Rejected — version 2** ("Crisis targets reduced to 0 HP automatically"): more flavorful
but no counterplay once it lands, and it overlaps Death Gaze (reduce to 0 on a failed
save) in the same dungeon.

---

## 6. Fillers

Fillers are used **only when no pattern move is available** (Lance of Ruin, Reinslaughter).

| Move | Damage | Targets | Keyword | AI focus / gate |
|---|---|---|---|---|
| **Dragoon Lance** (reworked) | Devastating Physical, melee, single target | **MDEF** | **Execute** | Crisis / lowest HP targets |
| **Claw** (new) | Devastating Physical, melee, single target | **DEF** | **Cripple** | **High-HP targets only** (target HP% gate; threshold set at build) |
| **Wyrmbreath** (kept) | Heavy Dark, all enemies, 40 MP | MDEF | — | as live |

The loop: **Claw pushes a PC into Crisis → Contempt charges → Dragoon Lance or
Reinslaughter culls them.**

Wyrmbreath stays for now. Retiring it is an option if the kit gets convoluted (it would
also make the MP read for Lance cleaner).

---

## 7. Animation concept (NOT implemented)

**Reinslaughter** — **effort: Highest.**
Hilde-Fafnir flies up into the sky, raising large swirling stormclouds, then looses
thousands of lightning arrows that rain down across the battlefield.

---

## 8. Open — verify before building

1. **Prophetic Defender redirect:** does it hand over the **already-resolved** damage, or
   **re-resolve** it against the defender? §5's "defender dies" only works automatically
   in the first case; otherwise the build must pin the scaling to the original target.
2. **HP% variable:** which formula variable exposes a target's HP% for Reinslaughter's
   curve and Claw's high-HP gate.
3. **Contempt dedupe:** a single hit from above half HP to 0 may emit both
   `creature_enter_crisis` and a defeat trigger — needs a per-hit dedupe so it grants 1.
4. **Contempt exclusion:** how to scope the trigger so Reinslaughter's own hits don't count.
5. **Lance → Crisis emit:** confirm Lance's `crush` path emits `creature_enter_crisis`
   (the trigger exists; untested on Lance).

## 9. Tuning — deferred to fight simulation

- Reinslaughter damage curve (floor at full HP, ceiling at 1 HP).
- Lance of Ruin MP cost and cooldown length.
- Claw's high-HP threshold.
- Absorb interaction for Reinslaughter.
