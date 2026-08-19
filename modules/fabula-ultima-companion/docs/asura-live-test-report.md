# Asura — Live Test Report

**2026-08-19 · four sim battles against the real Battle Director · branch `feat/asura-rework` · commits `65923c8b` (build) → `a9672ca1` (this pass)**

Method: Foundry launched headless-driven (CDP GM auto-join), the
[Automated Playtest Harness](../scripts/battle-director/sim/) running a **real** BD
conflict — same FSM, same rolls, same damage pipeline, only the human replaced.
Every run: solo Asura, the four-PC L41 party (no guests), `conflictEvent:
"lightning-storm"` armed, 3 Fabula Points each.

> **Headline: the monster's central mechanic had never worked, in the old build
> or the new one.** Once fixed, the fight went from *trivial* to *three PCs
> dead*. Nothing here is tuned yet — the numbers below are measurements, not
> settled values.

---

## 1. The critical finding — `creature_takes_damage` is a dead trigger on items

`Elemental Aspect` has fired on `creature_takes_damage` since it was built on
2026-08-15. **That trigger is never dispatched to item-hosted reaction configs.**
The only code that reads it is the AE-hosted incoming-damage walk in
[`skill-effects.js:325`](../scripts/battle-director/skill-effects.js#L325)
(`resolveDamageReactions`, the Mercy-style damage-reduction path, which walks
`target.appliedEffects`). No emitter queues it for the item reaction system —
the resolve path emits `creature_deals_damage` and the resource ledger emits
`creature_lose_resource`, and that is all.

Consequences:

- Asura's Aspect state machine — the monster's entire identity — **had been
  inert since the day it was built.** It was never live-tested, so nobody saw it.
- The new **Mark** rows I wrote in the rework inherited the same dead trigger,
  so the element-collection clock never ticked either.
- Run 1 confirmed it empirically: after four rounds Asura carried
  `Crisis, Lightning Rod, Awake, Whetted` — no Aspect, no Marks, no Ascension.

**Fix:** all eight rows moved to `creature_lose_resource` +
`reaction_resource_filter: "hp"` + `SUBJECT_IS_SELF == 1`. This is the house
idiom already in use on Lightning Prism, Skizzik and Kirin, and
`project_lightning_surge_dungeon` even records it as the "KEY ENGINE FINDING" —
framed as being about *bystander* reactions, which is why I did not apply it to a
self-scoped reaction. **The rule is stronger than the note says: on an item,
`creature_takes_damage` does nothing at all.**

> This is worth a wider audit. Any other monster using `creature_takes_damage` on
> a skill item is silently dead. Asura was the only one I checked.

---

## 2. Everything else automation found

| # | Problem | Status |
|---|---|---|
| 1 | `creature_takes_damage` never dispatched to items (§1) | **fixed** |
| 2 | Sword Enchant self-damage read as cause `hazard` — `deal_damage` defaults there ([`skill-effects.js:5131`](../scripts/battle-director/skill-effects.js#L5131)) — so the Aspect's `"damage"` cause filter excluded the enchants, which are supposed to drive it | **fixed** (`damage_cause: "damage"` set explicitly) |
| 3 | The AI re-cast an enchant for an element it already held (`Sword Enchant - Fire` in rounds 2 *and* 3), stalling the clock at 2/4 so Quad never armed | **fixed** — each enchant row is now gated `self_lacks_status: "<Element> Mark"`, which also retires the `Whetted` lock |
| 4 | **An exclusive-priority row defeats its own cooldown.** Quad at priority 12 excluded everything else from the window; when its cooldown blocked it, *every* candidate was blocked, and [`matchAndPickAction.js:419`](../scripts/action-reader/actionReader-matchAndPickAction.js#L419) falls back to the unadjusted pool "rather than freeze" — firing it anyway. It cast twice in one round. | **reduced, not eliminated** — priorities now 8/6/5/4 so a companion usually survives; run 4 still doubled once |
| 5 | Quad's random target pool included **KO'd combatants** (user-observed). The targeting pool builder has no liveness filter of its own — zero references to defeated/HP anywhere in [`skill-targeting.js`](../scripts/battle-director/skill-targeting.js) | **fixed** — `target_filter: "CUR_HP > 0"` |
| 6 | `Elemental Aspect`'s exclusivity is leaking — three Aspects coexisted on Asura in run 3 (`Fire Aspect, Ice Aspect, Air Aspect`) despite `aspect_clear` (`remove_tagged_ae`, tag `asura_state`) | **OPEN — not fixed** |

**Verified working, unchanged:** the four-slot action rotation and its priority
windows; the Whetted lock (while it existed, exactly one enchant/round); the
Lightning Rod hazard and its per-activation strike; `Elemental Slash: Overflow`
firing off Fire Aspect; `activation: 4` (Asura took four turns every round);
`persistent_counter` keeping the Aspects alive across activations; the
`Ascension` counter accumulating via `add_charges`; the Crisis surge.

Also re-verified offline after every change: 51 formula assertions green through
`evaluateFormula` (with a non-vacuity probe and the full element × row
exclusivity matrix), reference-integrity audit clean, preflight with zero Asura
findings, `world-export` clean apart from the intentional Sweep removal.

### On bug 6 — what I know and don't

Observed directly (three Aspects on one actor). Not root-caused. The likely
mechanism is that `creature_lose_resource` fires **per HP-loss event**, so a
multi-instance turn runs several aspect chains whose `remove_tagged_ae` steps can
all resolve before their `apply_ae` steps land. If that is right, the leak
predates this pass and the fix is a `reaction_max_per_round: 1` on the aspect
rows — but **I have not confirmed it**, and it matters because a stacked Aspect
plausibly applies its `+10` rider more than once, inflating damage.

---

## 3. The two design changes you called during the test

**Strike-class monoculture → the magic twin.** Every action Asura had resolved
vs DEF, so a single **Ghostly Sheet** (immune to Strike, 200% from everything
else) blanks the entire monster. Damage class follows the *accuracy check*
([`action-profile.js:665`](../scripts/battle-director/action-profile.js#L665)):
vs DEF → `strike`, vs MDEF → `magic`, **no check at all → `null`, both axes
inert**. `resolvesVsMagicDefense` reads only the item's own
`defense_target_type` and no reaction can override it — so a dynamic flip is not
expressible, and the two-item split is the only form available. Shipped as:

- `Elemental Slash` — Physical, vs DEF, used only while un-enchanted;
- **`Elemental Slash (Enchanted)`** — vs MDEF, takes over once any Aspect is up;
- a new **`Enchanted`** marker AE (tagged `asura_state`, so it clears and
  re-applies with the Aspect) giving the action pattern one name to gate on;
- nine mirrored reaction rows so the element-retype, the `+10` rider, the Mark
  bonus and the Crisis surge all still scope to the twin.

Live-confirmed: run 4 used the enchanted twin four times and the Physical
version zero times — Asura enchants in round 1 and never goes back, so the
Physical mode is close to vestigial. Worth a look.

**Quad reworked into a flurry.** Was four `free_action` re-casts = four action
cards. Now **one card**, then four auto-hit elemental beats, each on its own
random *live* enemy — `mode: "random"` targeting rows (one per beat, since the
resolver memoizes per row), 45 flat each, `damage_cause: "damage"` so the hits
still move the Rod. This is the engine's Starfall model.

Two consequences worth knowing:

- Auto-hit means **no accuracy check**, so Quad reads as damage-class `null` —
  it bypasses Ghostly Sheet's Strike immunity *by construction*, and its 200%
  penalty too.
- With the liveness filter, four beats redistribute across however many
  defenders remain — which is exactly the "stronger the fewer are left"
  concentration you asked for, for free.

`Elemental Slash (Sweep)` is deleted; nothing referenced it any more.

---

## 4. Balance data

| Run | State | Result | Party HP left | Rounds | Marks reached | Quad casts |
|---|---|---|---|---|---|---|
| 1 | as committed in `65923c8b` | UNRESOLVED (overtime) | **86%** | 4+ | **0** | 0 |
| 2 | + dead-trigger fix | VICTORY | **89%** | 3 | 2 | 0 |
| 3 | + clock fix, Slash 32→42 | VICTORY, **3 PCs dead** | **21%** | 6 | 4 | 6 |
| 4 | + magic twin, Quad flurry | VICTORY, **3 PCs dead** | **21%** | 5 | 4 | 5 |

Target band is 40–60% party HP remaining; >70% means (per the playbook) *the
fight never happened*. Runs 1–2 are trivial, runs 3–4 overshoot into the
KO-snowball failure mode — the party won both only because Asura died too.

### Measured constants — worth keeping

- **Lightning Rod lands ~3.3 strikes/round on Asura** (10, 9, 15 strikes across
  runs of 4, 3 and 5 rounds) = **~100 Bolt damage and ~100 MP per round**. My
  design estimate of 3/round was right, and the 270-damage storm padding baked
  into the 900 HP is validated.
- **Party DPR against a solo Asura: ~125–210/round**, huge run-to-run variance.
  The proposal assumed 206 (`BaselineDPR 110 × RD 1.25 × M 1.50`); the true
  average is nearer **~165**. 900 HP resolves in 3–5 rounds, which is the target.
  **HP is the one number that came out right.**
- The party **manufactures earth VU every single turn** (Zarg's Gadgets and
  Keren's Thermokinesis both infuse → earth, one of Asura's two VUs). Its real
  play efficiency against this monster is far above the 17% design point, which
  the double-VU invites.

### The fire wall — why runs 1–2 read so trivial

Every PC resists or absorbs Fire: **Hina AB fire**, Zarg/Keren/Blanche RS fire.
`Elemental Slash: Overflow` — Asura's only AoE — is hard-locked to Fire. In run 2
Hina finished at 98/98, *healed* by the attack meant to threaten her.

This is party-specific and per `project_multiparty_randomized_runs` should be
weighted at ~25%, so I did **not** tune numbers around it. But it exposes a
structural flaw of exactly the kind that cost Kirin a redesign: **a mono-element
AoE is a coin-flip on party affinity.** Quad's four elements now cover it (run 4
killed Hina — the ice beat hits her VU), but Overflow is still Fire-only.

---

## 5. Open decisions — yours, not mine

I stopped tuning after run 4 rather than dial numbers toward a target you set,
because these are balance calls of the kind you've made yourself before.

1. **The fight kills three PCs.** 21% remaining is inside my proposed
   "Pressure ~1.0" but past the KO-snowball line the playbook calls the real loss
   condition. Pull Quad back (45/beat → ~30), or accept it as a demi-god?
2. **The clock completes in round 1** — the Rod hands over Bolt for free, the
   party supplies one or two elements, and two enchants finish it. A doomsday
   clock with no build-up. Slowing it is the single biggest lever on 1.
3. **Quad fires ~once per round** (5 casts in 5 rounds). Intended was once per
   round *at most*, arriving late. Bug 4 is part of this and is not fully fixed.
4. **Overflow's Fire lock** (§4). The Kirin precedent was to *add* an option
   rather than nerf — e.g. let Overflow inherit the current Aspect's element, and
   give Fire Aspect a different rider.
5. **The Physical `Elemental Slash` is nearly dead weight** now that Asura
   enchants on turn one.
6. **Bug 6** (Aspect exclusivity) needs root-causing before any damage number is
   trusted, since a stacked Aspect may be applying its `+10` more than once.

---

## 6. What is still unverified

- Bug 6 root cause, and whether it inflated runs 3–4's damage.
- The reworked Quad and the magic twin have **one** sim run between them (run 4).
- No real-table play; the sim's known fidelity gaps all make the party read
  *weaker*, so a "hard" verdict is trustworthy and an "easy" one is not — runs
  3–4 being hard is therefore the more reliable signal.
- Valley of the Dragon still has **no arena scene**, so the Lightning Storm
  cannot yet be selected outside a sim override — and this stat block is only
  valid with it on.
- Loot/steal tables and action animations, deferred as always.

---

Related: [asura-rework-proposal.md](asura-rework-proposal.md) ·
[lightning-storm-design.md](lightning-storm-design.md) ·
[monster-balance-design.md](monster-balance-design.md) ·
[reaction-config-schema.md](reaction-config-schema.md)
