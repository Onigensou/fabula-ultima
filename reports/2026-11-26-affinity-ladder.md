# Affinity ladder: affinities resolve per core p.92 (v1.0.685)

2026-11-26 · branch `feat/affinity-ladder` · user-approved design (chat 2026-11-26).

## Why

Every OVERRIDE / CUSTOM Active Effect change on `affinity_1..9` wrote straight over the slot, so the
change with the highest priority decided the result. A false gate wrote `"NA"`. Hina's **Dark Blood**
(`aeWhen("Crisis", "RS")`, priority 3) therefore erased the Poison / Dark Resistance from her gear
(priority 1) whenever she was out of Crisis. Separately, Wet / Oil / Petrify / Hypothermia / Turbulence
/ Zombie forced VU at damage time over everything, even an Immune or Absorbing target.

## The rule (Fabula Ultima core rulebook p.92)

> "Some game effects may cause you to gain a variety of Affinities: if a character is both Vulnerable
> and Resistant to a specific type of damage, they are treated as having no Affinity towards it.
> Immunity, on the other hand, always supersedes both Resistance and Vulnerability: finally, Absorption
> supersedes all other Affinities."

## What changed

**`syntax-extender/syntaxExtender-conditionalChangeGate.js` (v6.6.0).** Each affinity change lands in a
per-derivation bucket, and every write is the full resolution of that bucket. Order and priority no
longer matter.
1. **Grants**: the actor's base value plus each change's own value. That covers plain values, CSB `${…}$`
   formulas (evaluated by one call to the original `apply`, against the item's props), gates while true,
   and `aeAffinityFloor(X)` (= grant X). They combine per p.92: AB > IM > (RS + VU → NA) > RS > VU > NA.
   Duplicates don't stack, and a false gate grants nothing.
2. **Modifiers** on the result, along the ladder VU < NA < RS < IM < AB: raising `aeAffinityStep(+n)`,
   then `aeAffinityCap(X)` (Anomaly, Bane Oils Exposed, Nidhogg's Soul Master), then lowering
   `aeAffinityStep(-n)` (King Gorger's Element Gorge). The cap comes before the lowering step, so Gorge on
   an Anomaly'd Immune target worsens the NA the cap left to VU: both debuffs count.

The bucket is keyed per effect + change, so the same change applied twice can't count twice. It is
reset at `applyActiveEffects` and on a microtask, so it lives for one synchronous derivation.
For tests: `FUCompanion.api.activeEffectConditionalGate.resolveAffinityLadder(base, entries)`.

**Status vulnerability folded in.** The forced-VU tables are gone from `snapshot.js` (`resolveAffinity`
now reads the sheet), `action-profile.js` (`computeAffinity`) and `apply-damage-core.js`. Each status AE
grants VU on its own `affinity_N`. Wet, Oil, Petrify and Turbulence already carried that grant (CUSTOM
mode, which CSB's `applyActiveEffect` hook applies). Migration **`2026-11-26-status-vu-grants`** adds
Hypothermia → Ice (`affinity_7`) and Zombie → Light (`affinity_8`) to every copy: the Debuff library,
Ice Fang, actor items (Inferex, Bandit Zombie), and live statuses on actors and unlinked tokens.

## Effect on the world (all 341 actors, main vs branch)

- **Ampere, Bolt: NA → RS.** This was a bug: an unequipped Thunder Bow in its inventory wrote NA over its
  natural RS through its `${isEquipped ? 'RS' : 'NA'}$` formula.
- **Hina, Ice: RS → NA.** Ring of Magma (Ice VU) + the Aenigma of Adaptation orbment (Ice RS) now cancel
  per p.92. The user accepted the rule and will tell the players at the 11-28 session.
- Nothing else changes.

## Tests

- Snapshot runner `checks/affinity-ladder.js` 11/11 covers:
  - the resolver table;
  - Dark Blood + Emerald Pendant in and out of Crisis;
  - unequip (no stale grant);
  - Element Gorge from every base;
  - Anomaly alone and Anomaly + Gorge;
  - Gorge ×2;
  - base VU + RS gear;
  - Wet;
  - Soul Master.
- `checks/affinity-dump.js` A/B: the 2 changes above.
- Fingerprint A/B on the bench (`run.mjs --bench --collect/--compare`): **502 / 502 identical**.
- skill-regression `parity` + `census`: clean.
- **Real Foundry server** (private headless server on a fresh Staging World copy, module junctioned to
  the branch):
  - both migrations ran on the real GM boot;
  - the 11 scenarios pass;
  - real battles with Iceberg vs Hypothermia: NA → VU (86), IM → 0, AB → absorbs 44, RS → cancels to NA;
  - **King Gorger (Wild) really cast Element Gorge**: all-Immune target Dark IM → RS, others untouched;
    the same target under Anomaly: everything NA, Dark VU;
  - the real Hina, with Emerald Pendant added, showed identical affinities on the GM, after a GM hard
    reload, and on Rinri's player client, so CSB's derivation order doesn't change the result.

Runner notes:
- The companion **King Gorger** never takes its own turn (it acts through its summoner); the enemy one
  is **King Gorger (Wild)**.
- Sims act on `[SIM]` clones.
- `force: "hit"` is unreliable for NPCs.

## After pull

The GM boot runs `2026-11-26-status-vu-grants` once. Not yet seen: a real-table look (Sat 11-28).
