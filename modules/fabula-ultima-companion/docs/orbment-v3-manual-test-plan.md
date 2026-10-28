# Orbment v3 — manual test plan

Orbment v3 turns sockets into player self-service: random Attunement at an
Alchemist NPC, Field Attune at the Camp Forge, and the Tinkerer's Upgrade at
camp. This plan covers the checks a live table session still owes. Everything
under "Already verified" passed in a sandbox world copy on 2026-10-28 (GM
client plus a real player client); run the rest with real players.

Branch: `feat/orbment-v3-alchemist`. Code: `scripts/orbment/`.

## Setup

1. Flag the Alchemist NPC (GM console):
   `await FUCompanion.api.orbment.setAlchemist("Actor.<id>", true)`.
   The intended Alchemist is the accessory-shop owner (the Jeweler). The flag
   is world data, so it needs the world-export procedure before it is committed.
2. Give each tester some Zenit and at least one weapon, armor or shield.
   Accessories never take Orbments.

## Already verified (sandbox, 2026-10-28)

- Shop Attune from a player client: the request reaches the primary GM, Zenit
  is charged once, slots are written with source `roll`, and the banner shows
  on the other client.
- Refusals: another member's gear (`not_your_gear`); another player's Upgrade
  (`not_your_character`); a second Upgrade in one rest (`already_queued`);
  queue or cancel while sleeping (`not_now`).
- Camp Forge with the player operating and the GM watching: marks mirror live,
  both screens show the same result and line, Proceed closes both. GM solo
  operation, "Leave without attuning", and a video (.webm) sprite also work.
- Upgrade through a real camp rest: queue, cancel and refund, re-queue, install
  at full value (source `upgrade`) when the rest completes, banner at wake.
- Battle Director simulate with forced dice: Fury +10% (36 → 40); Guard:
  Physical 5 + Bastion 3 caps at 5 flat; Ward: Physical 20% + Aegis 10% caps
  at 20% (flat first, then %, rounded up).
- Max HP +15 raises max HP and reverts on removal; an unequipped item's
  Orbment effects start disabled.
- Item card Orbment footer (rolled-value bar, Upgrade wrench, socket strip),
  and stripping of the old "🔮 Orbment" description block.
- Party menu: the item detail lists each socket and its effect; the list
  shows socket gems only after O toggles them on (off by default).
- Banners stay on one row, sized to their content, beside the open sidebar.
  The Alchemist window drags without jumping.

## Still to check at the table

### Alchemist shop
- [ ] The ⚗ button appears near the flagged NPC, and Interact shows "Attune".
- [ ] Socket first, then stone: the selection moves to the next empty socket.
      Drag and drop also works; clicking the selected socket removes its stone.
- [ ] The price follows the item's rarity (Rough 50 / 70 / 100 / 170 by
      rarity, Polished double). "Not enough Zenit" blocks the roll.
- [ ] The overwrite warning names what will be replaced.
- [ ] The Alchemist's line and expression match the most notable result
      (Jackpot > Worse > Better > New > Sidegrade). Stars and sounds play.
- [ ] Every other player sees the two-stage banner: "is attuning…", then the
      result. Clicking the item name opens the Item Window for that player only.
- [ ] Two players attuning at once: the banners queue one at a time.

### Camp Forge (Merchant / Tinkerer / Pilot)
- [ ] Pick Camp Forge in activity selection. At resolve, the owner operates
      and everyone else watches.
- [ ] The owner reloads mid-activity: their window comes back with the marks
      intact.
- [ ] The owner is offline: the GM operates instead.

### Upgrade (Zarg)
- [ ] The 🔧 button sits beside the camp button in Free Roam and the Sleep
      lobby, for Zarg's player only. A ✓ badge shows while an upgrade is queued.
- [ ] A queue made by Zarg's player, and the wake banner, are seen by the
      whole table.
- [ ] Choose-two qualities (Dual Hunter, Dual Resistance) take exactly two
      choices.

### Combat
- [ ] A rolled Fury, Guard / Ward, Bastion / Aegis, Spirit Up and Antistatus+
      behave in a real fight as they did in simulate.
- [ ] The manual damage path (apply-damage-core) applies the same Orbment
      reduction caps.

## Known caveats (decisions pending)

- **Save / Load keeps sockets live.** The save system restores only equip state
  and quantity on items, the same as for Refinement, but it restores actor
  Zenit. So save → Attune → load refunds the Zenit and keeps the roll. Only
  the primary GM can load.
- **Token pop-ups.** Foundry shows "+(…)" / "−(…)" over the token whenever an
  Orbment effect is created or deleted. A re-attune rebuilds every Orbment
  effect on the item, so untouched sockets flash "−" then "+" as well.
- Names such as Guard, Ward, Bastion, Aegis, Fury, Spirit Up and Antistatus+
  are still placeholders.

## Attribute Up (Jackpot tier)

One die size (+2 on `bonus_<attr>`), never past d12, which is the game's die
ceiling. The sheet itself allows d14, so the cap lives in the effect formula,
at priority 15, ahead of statuses. Live-checked in the sandbox: d6 → d8;
d12 stays d12; two on a d10 → d12; d12 + Up + Dazed → d10; unequipped → no
change.
- [ ] At the table: a rolled Attribute Up raises the die on the sheet and in
      checks, and drops when the item is unequipped.
