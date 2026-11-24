# Party zenit: Party Stash box + live Party Total (to-do #14, 2026-11-24)

From the 2026-11-21 session: players could not move zenit between the central Party Stash and their own
wallets (only the GM could, from the console), had no way to see the stash, and read the Party Menu's coin
number as the stash. That number was the stored `total_zenit` roll-up, and it was stale (16,178 shown vs
21,043 real). Designed with a playable mockup over two rounds, then built and tested in a multi-client
sandbox. Mockup, with the decisions recorded on the page: https://claude.ai/artifact/5J7MVprV87fBkELxpB1zdR

## What players see
- **Main menu:** the coin box now reads **Party Total** (everyone's zenit + the stash), summed live each time
  the menu draws. Hovering it shows a tooltip with the **Party Stash** amount. Clicking it opens Item → Party
  Bag with the Zenit box already open.
- **Item view:** the Party Bag line shows the stash ("Shared by the party · 6,919 z · 82 shown"). On the
  Party Bag and on your own bag (the GM: any bag), that amount and a new **Zenit (G)** nav button open the box.
  The button stays visible but greyed during a conflict, and its tooltip says why.
- **Zenit box:** **Put in / Take out** (Tab), whose wallet (portraits, Q/E; greyed ones say why on hover),
  an FF-style digit dial (←→ picks a digit, ↑↓ / wheel / ▲▼ turn it, 0–9 types, Backspace), **All** (A),
  **Clear**, and before → after for both sides. It never goes above what the source holds ("The Party
  Stash only has 5,719 z."). Confirm plays the success chime and the bag line flashes with the new figure.
- **Everyone is told:** one System Message line, "Hina put 1,000 zenit in the Party Stash." / "Keren took 500
  zenit from the Party Stash.", plus the obtain chime on every client. The line names the wallet, not the
  player who pressed the button. While someone has the Party Menu open, System Message lines draw above
  it (`body.fud-pm-open #fu-sysmsg-host { z-index: 10001 }`), so the mover sees their own line too.

## Rules (`zenitRefusal`, party-menu-inventory.js)
- **Put in:** from a character you own. **Take out:** anyone in the party, into any party member's wallet
  (active or reserve), the same rule as taking an item from the Party Bag. **GM:** any direction, anyone.
- Same locks as moving items: the Item command granted, no conflict running, a GM online.
- Checked in the menu (to grey choices) and again on the acting GM, which takes the requester from the
  socket sender. A raw `partyMenu.moveZenit.req` from a player's console is refused with `not-yours` /
  `zenit-short` / `in-combat-zenit`.

## Build (feat/party-zenit)
- `party-menu-core.js` `getPartyRoster`: `zenit` = active + reserve wallets + stash, summed live; new `stash`.
- `party-menu-inventory.js`: `zenitMembersOf`, `zenitRefusal`, `moveZenit` → GM handler
  `partyMenu.moveZenit.req` on the **same queue as item moves** (`_moveChain`), through
  `ItemTransferCore.transferZenit`; `zenitLine` (System Message markup). The acting GM also rewrites
  `total_zenit` (debounced 250 ms) whenever a party wallet or the stash changes, from **any** source (shops,
  loot, crafting…), so the CSB party sheet is right again.
- `party-menu-view-item.js`: the Zenit box (constants block `Z`, ported from the mockup), the bag-line amount,
  the G action. `party-menu-app.js`: the Party Total line + tooltip, `openStashBox`, keys (G in Item; A and
  0–9 only while the box is open, so other inputs keep their digits), wheel routing, `fud-pm-open` body
  class, and the CSS, copied verbatim from the mockup. `party-menu-ui.js`: the G key cap.
- `event-gameState.js`: the event condition "Party zenit (total)" sums live (it read the stale field).
- No migration, no world data, no new files in module.json.

## Tested (sandbox, today's world copy, GM + Hina's player (visible GPU window) + Keren's player)
- Live total 22,400 = hand sum on every client. The stored total stayed 16,178 until the first change, then
  stayed in step through 8 moves and an outside wallet change (+50 → 22,450 → back).
- Take out 1,000 to Hina (typed), 500 to Keren (dial), 100 to Blanche (mouse + wheel), 200 via ▲ + button;
  put in 300 from Hina; the GM put in 100 from Keren's own bag. Every line reached the other clients and
  showed over the mover's open menu. Zenit is conserved (22,400 throughout).
- Put in greys Keren / Blanche / Zarg for Hina's player ("That isn't yours to give away."); overdraw caps with
  the note; Esc closes the box; forged requests refused; the conflict lock greys the button, toasts on G and
  refuses a raw request. No console errors on any client.

## Not tested / owed
- A real-table look (Sat 11-28): the line over the menu on real screens, and a player using it live.
- The CSB party sheet itself was not opened (only its field `total_zenit` was checked).
