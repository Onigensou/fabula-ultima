# Asura — Adaptive Affinity (the VU→RS toggle)

**Status: ANALYSIS ONLY. Nothing built. For review.**
2026-08-19, against the post-live-test state (`1a6c2c6c`). Companion to
[asura-rework-proposal.md](asura-rework-proposal.md) and
[asura-live-test-report.md](asura-live-test-report.md).

**The proposal.** Asura is **VU** to all four aspect elements (fire / bolt / ice /
air). Taking that element enchants it → **RS** to that element until disenchanted.
**Quad-Elemental Slash resets everything back to VU.**

---

## 1. Verdict

**I think this is the strongest idea in the whole rework, and I'd build it — but
not on its own.** It fixes three separate problems the live test exposed, two of
which I had listed as open decisions and one of which I could only half-fix in
code. It also needs two things changed alongside it or it will not produce the
mood you described.

It is also **fully buildable with no engine work** — verified, §5.

The one thing I'd push back on: as written, the VU phase lasts **less than one
round**, so "it felt weak at first" never actually happens. §4.1 is the fix.

---

## 2. What it fixes (the case for)

### 2.1 It makes Quad cost something — which fixes the bug I couldn't

The live test's worst unresolved problem: **Quad fires ~once per round forever**
(5 casts in 5 rounds), because `action_pattern_cooldown` is defeated by its own
priority window — when every candidate is blocked the picker fires it anyway.

If Quad **consumes the marks**, the gate stops being a cooldown counter and
becomes a *consumable resource*. `effect_stacks: Ascension >= 4` fails the instant
Quad resolves, and cannot pass again until four elements are re-collected. That is
exactly the fix I wrote into the action-pattern notes after the live test —
*"gate the big move on a resource the action itself consumes, never on a cooldown
counter"* — and your design produces it as a side effect.

### 2.2 It turns the ultimate into a real decision instead of a free payoff

Right now Quad is pure upside. Under this design, casting it **hands the party a
fresh burst window on four elements**. The more Asura leans on its ultimate, the
softer it becomes. That is a genuine risk/reward on the monster's own strongest
button, and it is self-balancing in a way no number I pick could be.

### 2.3 It gives the fight a shape

Damage becomes a **sawtooth**: fast right after a reset, decaying as the party
burns its element windows, then fast again. The +8/mark damage bonus resets on the
same clock, so **Asura's offence sawtooths with it** — it is weakest immediately
after its own ultimate. That is a much better rhythm than the current monotonic
ramp, and it prevents the runaway the live test produced (Asura sitting at +32
damage *and* Quad every round).

### 2.4 It finally makes the element choice matter

In all four sim runs, Zarg and Keren infused **earth every single turn**, because
earth is a static VU. The elemental identity never engaged — the party solved the
monster once on turn one and repeated the answer. This design makes the right
answer *expire*, which is the whole point of a four-element monster.

---

## 3. Working it into the balance metric

The balance doc assumes a **constant** `M(PE)`. A time-varying affinity breaks
that, so here is the honest model.

Let the party land **one ×2 hit per element per cycle** (using an element marks it,
so each is one-shot), with everything else at ×1 neutral. With `A` actions per
round and a cycle of `R` rounds:

```
M_effective = ( 2·V + (A·R − V) ) / (A·R)  =  1 + V / (A·R)
```
where `V` = VU windows actually used per cycle.

At `A = 5` (RD 1.25 × 4 PCs) and `V = 3` — three, not four, because **the
Lightning Rod steals the bolt window** (§4.2):

| Quad cadence | Cycle | `M_effective` | vs today (~1.55) |
|---|---|---|---|
| every round | 1 rd | **1.60** | +3% |
| **every 2 rounds** | 2 rd | **1.30** | **−16%** |
| every 3 rounds | 3 rd | 1.20 | −23% |
| never resets | 5 rd | 1.12 | −28% |

**The Quad cadence is the dominant balance variable in the whole design.** That
is unusual and worth saying plainly: you are not tuning a damage number, you are
tuning how often the monster hands the party its burst window back.

### What this does to HP

Measured party DPR against solo Asura was **125–210/round (mean ~165)** at today's
`M ≈ 1.55`. At a 2-round cadence the party loses ~16%, so **900 HP would push the
fight from ~5 rounds to ~6**.

That is the wrong direction — the live test already ends with **three of four PCs
dead at 21% party HP**, and every extra round is another four Asura activations
into a party that has lost its action economy. So:

> **If this ships, HP must come down with it — ~900 → ~750** at a 2-round cadence.
> This is not optional; it is the same correction, not a separate balance call.

### Where it sits in the doc's own framework

Part 5 says unique factors adjust **HP or rounds, never PE**. This one is a
*damage-line* factor (it moves the multiplier), so formally it belongs in PE — but
PE is defined as a constant. **The honest answer is that Asura now has a
per-monster `M_effective` and its PE is not comparable to any other monster's.**
That is already true (it knowingly carries 2 VU); this makes it emphatic. For a
unique solo encounter I think that is an acceptable price, but it should be
written on the monster so nobody later reads its PE as a roster-comparable number.

---

## 4. The three problems

### 4.1 ⚠ The VU phase lasts less than one round — the mood never lands

This is the one that would sink it. From the live runs, Asura reaches **all four
marks by the end of round 1**: the Rod hands it Bolt for free, party damage
supplies one or two, and its own Sword Enchants finish the set (it enchants at
exclusive priority, and in run 4 it cast two in round 1).

So "it felt weak at first with a lot of VU" would be **the first two or three
party actions of the fight**, and then never again except in the instant after a
Quad. The decay you want to feel over a fight would compress into one round.

Three ways to slow it, in the order I'd pick them:

1. **Asura's own Sword Enchant grants the Mark but NOT the resistance.** Split the
   two: marks (clock, from any source) vs *tempering* (RS, only from
   creature-inflicted damage of that element). Then **the party's own choices are
   the only thing that armours it** — which is a much sharper version of your
   fantasy, and makes "don't feed it" a real tension rather than a thing Asura
   does to itself while you watch. **This is my recommendation.**
2. Cap enchants at one per round (re-instate the retired `Whetted` lock — but it
   cannot AND with the per-element gate, so this costs the duplicate-enchant fix).
3. Raise the Quad threshold above 4 marks so a full set is not also a full clock.

Option 1 also removes the oddity that Asura currently *wants* to hurt itself to
gain armour.

### 4.2 The Lightning Storm steals the bolt window — and gets weaker

The Rod deals **Bolt** to Asura ~3.3 times per round. Consequences:

- **Asura is handed the Bolt mark for free, every cycle, before the party can
  ever use the bolt VU window.** The party effectively has three usable elements,
  not four. (Thematically excellent — the storm tempers it — but it is a real
  quarter of the mechanic that players never touch.)
- Once bolt is RS, **every subsequent Rod strike drops 30 → 15**. Per 2-round
  cycle the storm goes from ~198 damage to ~144 — a **~27% cut to the dungeon
  mechanic's contribution**, which is the thing the 900 HP was explicitly priced
  around.
- The compensation: the one strike that lands during a VU window does **60**.

Net, the storm gets weaker and spikier. If you want it to keep its teeth, the
cleanest option is **hold bolt at NA permanently and run the toggle on
fire/ice/air only** — three elements, no interference with the dungeon rule. It
costs symmetry; it buys a mechanic that does not fight the hazard it is supposed
to be married to.

### 4.3 "Harder as it gets weaker" — half true, worth being precise

Defensively yes: marks accumulate, resistances rise, HP falls. That arc works.

But marks *also* grant **+8 damage each**, so the same act that armours Asura also
sharpens it. It does not get "weaker" in any sense except its HP bar — it gets
strictly stronger on both axes until the reset. That is a fine monster (a cornered
demi-god escalating) but it is not "weak at first"; it is "briefly soft, then
compounding". Worth naming so the study text and the fight's telegraphing match
what actually happens.

Also: light and earth must drop to **NA**. If they stay VU the party will keep
solving the monster with earth infusions and none of this engages — that is
exactly what all four sim runs did.

### 4.4 Who gets shut out at full marks

At 4/4 the aspect set is all RS. Checking the current party:

| PC | Neutral option at full marks |
|---|---|
| Zarg | Physical bow ✓ |
| Blanche | Physical brawling ✓ |
| Keren | Elementaless — **bypasses affinity entirely**, unaffected by any of this |
| Hina | Ice/Air/Bolt all RS → must switch to **Dark (Morrigan) or Light** ✓ |

Nobody is locked out, and Hina becomes the character who has to think — which is
right, she is the elementalist. Note Keren is structurally immune to the whole
mechanic; that is her identity and I would not change it, but it means one
quarter of the party never plays this minigame.

---

## 5. Buildability — verified, no engine work

I checked this before writing, because the whole design dies if affinity cannot
move at runtime. **It can, and it is a well-worn path — 14+ existing effects do
it**: Elemental Shroud (all five), the whole Dance suite, Air Pendant, and `Wet`
(which is literally "target becomes VU bolt").

The recipe, on each of the four existing **Mark** AEs:

```js
changes: [{ key: "system.props.affinity_6",        // fire; 3 bolt, 7 ice, 2 air
            value: 'aeAffinityFloor("RS")',
            mode: 5 }]                              // 5 = OVERRIDE
```

`aeAffinityFloor("RS")` always sets RS but preserves an existing IM/AB
(`syntaxExtender-conditionalChangeGate.js:23`). Asura's base would be VU, so
VU → RS is applied correctly.

**This means the entire mechanic is free of new automation.** Holding the mark
*is* the resistance; removing the mark *is* the reset. Quad needs one added step:

```js
{ effect_kind: "remove_tagged_ae", filter_tag: "asura_mark", count: "all", target_ref: "self" }
```
plus the same for the `asura_clock` tag (the `Ascension` counter). Base actor
affinities change to: **fire/bolt/ice/air = VU · light/earth/dark/physical/poison = NA**.

Two things to verify during the build, not before:
- that the action-card damage **preview** re-reads affinity after a mid-turn
  change (a stale preview would misreport, even if the applied damage is right);
- that removing four AEs in one `remove_tagged_ae` reverts all four props in one
  `prepareData` pass rather than leaving one frame of stale affinity.

---

## 6. What I'd actually ship

1. **Take the design.** §2 is four real wins and one of them fixes a bug I could
   only paper over.
2. **Split enchant-mark from party-mark** (§4.1 option 1) so the VU phase survives
   past round 1 and the party owns the consequence.
3. **Hold bolt at NA**; run the toggle on **fire / ice / air** (§4.2) so it stops
   fighting the dungeon hazard.
4. **Light and earth → NA** (§4.3), or none of this engages.
5. **HP 900 → ~750** (§3), as part of the same change, not a later pass.
6. Re-sim. This changes `M_effective`, so every number from the live test is stale.

Deliberately **not** included: any change to Quad's damage or the three-PC-deaths
problem. Those are still open from the live-test report and this design moves both
(shorter fight, sawtoothed offence) — I would rather re-measure than stack two
guesses.

## 7. Questions for you

1. **Enchant-mark vs party-mark** (§4.1) — do Asura's own Sword Enchants grant it
   resistance, or only the clock? I recommend clock-only.
2. **Bolt in or out** of the toggle (§4.2)? Symmetry vs the storm keeping its bite.
3. **Does Quad clear the marks, the Ascension counter, or both?** Clearing both
   makes it a clean cycle; clearing only affinity keeps the +8 damage ramp
   monotonic, which reads as "it never truly resets".
4. Should the **Aspect** (the current one-at-a-time state that retypes Elemental
   Slash) stay separate from the Marks, or should this collapse the two systems?
   They are currently distinct and I have kept them distinct here.

---

Related: [asura-live-test-report.md](asura-live-test-report.md) ·
[asura-rework-proposal.md](asura-rework-proposal.md) ·
[monster-balance-design.md](monster-balance-design.md) ·
[lightning-storm-design.md](lightning-storm-design.md)
