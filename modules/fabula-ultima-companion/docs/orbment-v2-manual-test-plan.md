# Orbment v2 — Manual Test Plan

Covers the 7 augments completed on 2026-07-27 (merge `7c5aa509`), plus the
initiative leader-proxy fix that shipped alongside them.

Everything here was already verified programmatically over the test bridge. This
plan is for confirming it through the **real UI and real play**, which is the part
automation can't reach.

---

## 0. Setup (do this once)

1. **Hard reload** the client — `F5`. Not a Setup relaunch.
   `skill-formulas.js` is static-imported at boot, so without a reload you're
   running the old engine and Vitality/Healing Up will read 0.
2. Open any **weapon, armor, or shield** on a PC.
3. In the item sheet's **title bar** (next to Sheet / Configure / Close) click the
   **"Orbment"** text link. It's a text link, not a button — easy to miss.
4. In the window, leave **"Charge Zenit on install" OFF** while testing. Off = free
   GM edit. Turn it on only when you want to test the shop/economy path (§8).

**Slot counts come from rarity:** Common/Uncommon = 1, Rare = 2, Legendary = 3.
For 2-augment tests use a Rare+ item.

> ⚠ **AEs only apply while the item is EQUIPPED.** The compiler creates them
> `disabled` when the item is off-body. If a stat doesn't move, check equip state first.

---

## 1. Magic Up  *(armor/shield, 1000 z)*

1. Install **Magic Up** on an equipped armor or shield.
2. Open the wearer's sheet → **Magic Check** modifier should read **+1** higher.
3. Have them cast an offensive spell → the accuracy tooltip should itemize the +1.
4. Remove it → the +1 disappears.

**Pass:** magic check accuracy +1, only on that wearer.

---

## 2. Initiative Up  *(armor/shield, 500 z)* — **rebalanced to +2**

RAW says +4; we ship **+2** deliberately (BD re-rolls the Initiative Group Check
every round and it's a binary who-goes-first outcome, so +4 was overtuned for 500 z).
The description in-game says +2 — it is not a display bug.

1. Install **Initiative Up** on equipped armor/shield.
2. Sheet → derived **Initiative** readout should rise by **2**.
3. Start a battle. In the round-start initiative resolution, the wearer's check
   should include a **"Check Bonus (Init): 2"** modifier line.
4. **Leader-selection check (the fix):** the group check auto-picks the PC with the
   best `DEX + INS + initiative modifier`. If your Initiative Up wearer is within
   2 points of the party's fastest, they should now sometimes be picked as leader
   where previously they never were.

**Pass:** +2 on the sheet AND inside the actual initiative roll.
**Watch for:** it feeling too swingy in play — this is the one I'd expect to need
another balance pass. Easy to drop to +1 in `augment-registry.js`.

---

## 3. Dual Resistance  *(weapon/armor/shield, 1000 z)* — first two-pick augment

1. Click **Dual Resistance** → the picker opens showing **"(0/2 chosen)"**.
2. Click one element → it highlights and shows **"picked"**, counter goes 1/2.
3. Click it **again** → it deselects (misclick recovery). Counter back to 0/2.
4. Pick **two different** elements → it auto-stages. Confirm.
5. Sheet → **both** damage types now show **Resistance**.
6. **Native-affinity guard:** pick an element the character is *already* resistant or
   immune to. It must **not downgrade** them — `aeAffinityFloor` keeps the better value.
7. **Dedupe:** try installing the same pair in the other slot **in reverse order**
   (Ice+Fire vs Fire+Ice). It must be **refused** as already installed.
8. Remove → both affinities revert to their original values, native ones intact.

**Pass:** two resistances from one slot; reverse-order duplicate blocked.

---

## 4. Hunter  *(weapon, 300 z)* — needs a real fight

Species list: Beast, Construct, Demon, Elemental, Humanoid, Monster, Plant, Undead.

1. Install **Hunter → Beast** on an equipped weapon.
2. Take that character into a battle with **both a Beast and a non-Beast** enemy.
3. Attack the **Beast** → damage should be **+5** vs baseline.
4. Attack the **non-Beast** → **no bonus**.
5. If the weapon has **Multi**, attack both in one action → the Beast takes +5 and
   the other doesn't, **in the same attack**. This per-target behaviour is the whole
   point of the design.

**Pass:** +5 only against the chosen species, resolved per-target.

**If it doesn't fire —** this is the highest-risk item in the release. The rider
path (shared with Piercing and on-hit Status from v1) had never run in a live fight
before this work. Check in order:
- Is the weapon actually the one being attacked with? The rider is gated to it.
- Is the enemy's `system.props.species` set, and spelled as one of the 8 above?
- Look for a passive pill/toggle for the weapon — mode is `"on"`, so it should
  auto-fire, but a player can toggle it off via the Passive Manager.

---

## 5. Dual Hunter  *(weapon, 500 z)*

1. Install **Dual Hunter → Beast + Undead** (two-pick picker, as §3).
2. Attack a Beast → **+5**. Attack an Undead → **+5**. Attack anything else → **+0**.
3. **Important:** a creature that somehow matched *both* still gets **+5, not +10**
   (the `min(A+B,1)` guard).
4. **Stacking is allowed across slots:** Dual Hunter (Beast+Undead) in slot 1 plus a
   separate Hunter (Undead) in slot 2 → Undead takes **+10**, Beast takes **+5**.
   That's intended — two different augments each contributing.

---

## 6. Vitality Up  *(armor/shield, 1000 z)* — recipient side

1. Install **Vitality Up** on an equipped armor/shield.
2. Have **someone else** heal that character → they recover **5 more HP** than the
   spell/skill says.
3. **Any** HP recovery counts — potions, skills, spells — because it reads off the
   *recipient*, not the healer.
4. **MP restore must NOT be boosted.** Restore MP → no +5.
5. **Bleed interaction (ordering):** apply **Bleed** (−50% incoming healing) and heal
   for 20. Expected result is **15**, not 12 — the multiplier applies first, then the
   flat +5. Verify the card preview and the applied HP **agree**.

**Pass:** +5 on HP recovery only; Bleed + Vitality Up on a 20 heal = 15.

---

## 7. Healing Up  *(armor/shield, 1500 z)* — caster side

Note this is the **opposite side** from Vitality Up: it boosts healing the wearer
*casts*, not healing they receive.

1. Install **Healing Up** on an equipped armor/shield.
2. That character casts an **HP-restoring spell** → target recovers **+5**.
3. The heal card's tooltip should itemize **"Healing Up (Orbment): +5"**.
4. **Must NOT apply to:**
   - a healing **skill** that isn't a Spell (`skill_type` must be "Spell")
   - **MP**-restoring spells
   - **potions / items** (that's Secret Formula's `item_restore_mod`)
5. **Secret Formula regression:** if a Tinkerer with Secret Formula is around, confirm
   their potion/magisphere restore bonus still works — I touched the shared resolver.

---

## 8. Cross-cutting checks

**Zenit economy** — turn **"Charge Zenit on install" ON**:
- Installing deducts the listed cost from the wearer's Zenit.
- If they can't afford it, install is **blocked** and **no** Zenit is taken.
- A failed install must never bill.

**Equip gating:**
- Unequip an augmented item → its bonuses **stop applying**.
- Re-equip → they come back.

**Transform weapons (Zarg's Bow):** installing on one form should mirror to the
linked doc — the window shows a **"🔗 Linked group"** note. Zarg's Multi is currently
installed; leave it be unless you're deliberately testing this.

**Item description block:** every augmented item grows a **"🔮 Orbment"** section
listing each slot. Install/remove repeatedly and confirm you get **exactly one**
block, never duplicates.

**Removal is clean:** after removing everything, the item should have no orbment
AEs, no `orbment_*` rows in its reaction/effect tables, and no description block.

---

## Known-untested edges

Honest list of what neither the automated pass nor this plan fully covers:

- **Hunter/Dual Hunter in an actual fight.** Verified through the BD dry-run harness
  (which reuses the real COMPUTE handlers), but never through a live card + confirm flow.
- **Healing Up cast for real.** Verified at the `resolveRestoreParts` layer, not by
  casting a heal spell at a wounded target.
- **Piercing and on-hit Status** (from v1) are still unverified in live combat. They
  share the rider path with Hunter, so if Hunter works they probably do too — worth
  confirming opportunistically.
- **Multi-client / player-facing view.** All testing was GM-side on one client.

## Rollback

Feature branch `feat/orbment-v2-pending` is retained as a revert point.
Whole release: `git revert -m 1 7c5aa509`.
Individual augments are one registry entry each in
`modules/fabula-ultima-companion/scripts/orbment/augment-registry.js` — setting
`pending: true` on an entry re-blocks its install without touching anything else.
