# Asura rework, Chain engine changes, Life Charm automation

Heads-up for sarunphat: this touches shared Battle Director code (`chain-plan.js`, `state-handlers.js`, `skill-effects.js`, `equipment-swap.js`, `save-extractors.js`). Nothing here is a bug for you to fix. It's so a pull doesn't surprise you.

## Asura (story elite) — numbers

| | Before | Now |
|---|---|---|
| HP | 900 | 1200 |
| Asura Strike | 45 per beat, auto-hit | Chain 4 seek + Pierce, HR + 80 per strike, DEX+MIG +6 vs MDEF |
| Elemental Slash + (Enchanted) | 42 | 48 |
| Overflow | 20 | 25 |

- **Asura Strike** is now a real multi-hit. It has four strikes, each with its own check, in the order Bolt, Fire, Ice, Air.
  - A strike aimed at a creature that has already fallen moves to one that's still standing (seek).
  - A miss still deals half damage (Pierce).
- The Elemental Aspect bonus, Four-Armed Fury and the Mark +8 are unchanged.
- **New animations** for all 8 of his actions. The clips live on Forge under `Animation/pixelfx/asura/`.
- **Playtests** (sim, Lightning Storm, 2 Phoenix Feathers, Kalina as guest): party ends at 44 / 89 / 53% HP, wins in round 4–5, Asura Strike about once per round.
- The decision log is in `tools/mindscape/dossiers/asura.md`. It includes a rejected AI experiment, so nobody repeats it.

## Chain engine (`chain-plan.js`, `state-handlers.js`)

- **A different element per strike.** A skill can set the flag `flags.fabula-ultima-companion.chainElements: ["bolt","fire",…]`. Strike k uses element k for its damage type and its affinity.
  - Without the flag, nothing changes.
- **One write per creature.** `chainHitsView` merges duplicate rows for the same token before writing.
  - Before, a Protect redirect could produce two rows and double damage.
- **Absorb nets out.** When a mix of absorbed and damaging strikes lands on one creature, it gets a single net write: damage, or healing if absorb wins.
  - Before, the absorbed part was counted as damage.
- **Provoke.** A Provoked caster using a random or seek Chain sends at least one strike to the provoker. If no strike landed on the provoker, strike 1 is pinned to them (`pinProvokerStrike`).
  - This now covers Active skills too, not only Attacks.
- **Charm** needed no change: the charmer was already excluded from the pool.
- **Tests:** `chain-plan.test.mjs` passes 89/89 and `chain-strikes.test.mjs` passes 106/106.

## Life Charm automation (`skill-effects.js`, `equipment-swap.js`, `save-extractors.js`)

The item says "used automatically when HP reaches 0", but it never fired. Its transfer Active Effect was disabled by the equipment sync, because Life Charm is equippable and wasn't equipped.

- **New Active Effect flag `activeWhileCarried`.** An Active Effect with this flag stays enabled while the item is in the inventory, whether equipped or not.
  - `isEquipLinkedEffect` and `resolveItemEffectDocs` skip it.
  - The save extractor mirrors the same rule.
- **New reaction row field `reaction_last_resort`.** Rows marked with it run in a second pass, and only if the creature would still drop to 0 HP.
  - They don't run if another death save already changed the damage (for example Beyond the Realms of Death), or if a knock-out revive is pending.
  - So the charm is never spent when another effect already saved the creature.
- **World data:** the Life Charm world item and the 5 actor copies have `activeWhileCarried: true` and `reaction_last_resort: true`.
- **Verified in a sim:** an Asura Strike Chain would have killed Zarg. Life Charm left him at 1 HP, then was used up (removed from the inventory).

## Boss line (new, reusable: `boss-line.js`, one hook in `state-handlers.js` CONFIRM)

A monster can say a line before its signature move, once per playthrough. The order is the JRPG one: speech box, then the action name banner, then the attack. Add it to any skill item as a flag:

```js
flags.fabula-ultima-companion.bossLine = {
  text: "Feel my battle prowess!",   // System Message markup allowed
  switch: "Asura Battle Line",       // event switch that remembers "said it"
  speaker: "Asura",                  // optional, defaults to the caster's name
  hold: 2200,                        // optional ms
}
```

- **Where it runs:** at CONFIRM, before `playActionNamecard`, GM side only. The wait is capped at 9 s, and any failure just skips the line.
- **"Once" is an ordinary event switch** on the current party's database, so:
  - a save/load puts it back to what the save held;
  - a new party starts without it;
  - a GM can turn it off in the sheet's switch table.

  Without a switch name, the line plays on every cast.
- **Tests:** `boss-line.test.mjs` passes 19/19.
- **First use:** Asura Strike. Its animation lost its Zero Power style cut-in, because the line carries that moment now.

## Memory leak fix (shared code)

The dynamic imports with `?cb=` + `Date.now()` kept one new module copy per card. That came to about 500 MB per boss fight on the GM page, and a tab ran out of memory. They now use `hotUrl()` from `hot-reload.js`: one fresh copy per page load, plus a new one whenever the hot token is bumped. **After editing one of these modules, run `FUCompanion.api.test.reloadHot()`.** Full details: `reports/2026-11-11-bd-module-copy-leak.md`.

## Things to know

- Magic Mirror may have the same "disabled because it's not equipped" problem. I didn't check or change it.
- A Chain strike drawn onto a creature that Protect replaced goes to a random target, not to the protector. It's rare; I left it alone.
