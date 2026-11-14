# v1.0.608: feedback layer, GM effects menus, item announcements, Offer Item per member

Heads-up for sarunphat. One release from two branches:
- `feat/skill-check-list` (foundryvtt-ac): Skill Check polish, the feedback layer, GM menus, item announcements.
- `feat/offer-member-bags` (foundryvtt-2a): Offer Item tabs per member, plus Has item / Remove reading every bag.

**After pulling:**
- **Restart the server.** `module.json` gains two esmodules: `shared/feedback.js` and `shared/effects-menus.js`.
- **One world step, with the game OPEN.** Two actors' gear quantities go from 0 to 1 (Hina's Sage Robe, Blanche's Air Pendant). They ship as export JSON only, with no LevelDB:

  ```
  node tools/safe-edit/bin/world-import.js apply --only actors/dafTLBUscCDNgq8H.json,actors/uJFaNQCSvwwsr2AW.json
  ```

## Behaviour changes in shared systems (please read)

| Where | Before | Now |
|---|---|---|
| Active Effect Manager `applyEffects` / `removeEffects` / `toggleEffects` | A chat card on every non-silent call, plus a red/green flash and Dispel Magic | **No chat card by default** (pass `renderChat: true` for one). The result goes to `FU.Feedback`: one batched System Message line on every screen ("Zarg is inflicted with Slow!") and battle's generic beat (Down2 / Powerup). The old flash and sound are skipped when the line shows. Silent calls are unchanged. |
| `reaction-system/reaction-grant.js` (the two `applyEffects` calls) | A chat card | The banner line instead, because it doesn't pass `renderChat`. Pass `renderChat: true` there if you want the card back. |
| `ItemTransferCore` gains (`gmToActor`, `actorToActor`) | Receiver-only "Obtained" popup (TransferCardUI) | **Every screen:** "Zarg obtained Moonstone!" in the System Message box, the item name hoverable (linked-text item card), and the Item3 chime. The popup is now only the fallback when `FU.Feedback` is missing. `showTransferCard: false` still means quiet. |
| `ItemTransferCore` takes / zenit | Silent | Silent unless `announce: true` ("Keren handed over Old Bell.", "The party obtained 300 zenit!"). |
| New payload options | | `chatCard: true` (the house "Obtain" card, world CSS `.oni-obtain-card`), `announceSound: false` (the caller plays its own sound). |
| Treasure chest | Its own "Obtain X!" chat card | The core's announcement + card (`chatCard: true`, `announceSound: false`, so the chest fanfare stays). |
| Treasure Roulette, gacha, crafting, gathering | | Unchanged: they already pass `showTransferCard: false`, and their reveal overlays are the notification. |
| Change Items event action | | Adds, removes and zenit all announce; one row is one batch. **Bug fix:** "an item by name" now prefers the real item over a CSB sub-item or a Skill-folder use-skill of the same name. "Remedy" used to give the party the Remedy use-skill. |

## New APIs
- **`FU.Feedback`** (`shared/feedback.js`; pure rules in `feedback-rules.js`, 13 node checks):
  - `status([{actorId, actorName, status, kind}])`, with kind inflict / held / buff / immune / removed.
  - `damage(rows, {label, element, kind})`: one element-coloured flash (canon `ELEMENT_COLORS`, bolt purple), one sound (strongest result wins), one Resource Panel.
  - `items(entries, {chatCard, sound})`.
  - `group(fn)`: everything reported inside is one batch. Without it, a batch closes 250 ms after the last result, capped at 1.5 s.
  - `flash(key)`.
- **`FU.SystemMessage` markup:**
  - `{st:Slow}`: the status icon in front of the name.
  - `{p:The party}`: the party highlight.
  - `{it:<uuid>|Name}`: an item icon plus an `a.fu-lt` link, so linked-text gives it the hover card. A hovered line stays up.
  - A line waits up to 300 ms for its icons to load.
- **`FU.EffectsMenu.damage / status / items(opts)`:** small GM menus. They collect who / what / how long and call the APIs. Draggable, and they remember their position (localStorage).
- **`applyDamage.applyToActor({ feedback: "show" })`:** default `"none"`.
- **`heldStatus.remove({actors, status})`:** cleanses a status, held or not. `inflict` / `applyNow` / `remove` report to `FU.Feedback` unless `feedback: "none"`.
- **`ONI.CheckRequester.openDialog({label, actorUuids, mode})`** (`cr-sidebar-button.js`, co-owned): opens the Request Check dialog pre-filled and resolves `{ mode, results }` or `null`.
- **Active Effect Manager UI:** `ui.open({ targetActorUuids, timing, source })`, plus a Timing select (Now / Until next battle, statuses only).
- **Resource Panel:** `absorb` and `weak` tags.

## Skill Check tile (follow-up to v1.0.606)
- Custom Event is the last row of every picker.
- The panel has a Result switch (Not rolled / Passed / Failed).
- Request check opens the Request Check dialog.
- Deal damage… / Apply status… / Give / take items… open the menus beside the panel.
- The tile clears after the return, with the Clear Tile macro's smoke puff and door sound.
- A GM reload during the trip shows a "Skill Check interrupted, Return to <map>" panel (`flags.<MOD>.skillCheckTrip` on the map).

## Verified
- Sandbox (a world copy) with GM + player, per feature. The v1.0.608 smoke test ran on the merged branch:
  - an event with Change Items add / remove / zenit, Deal Damage, Apply Status held + remove: lines, panel and amounts right, 0 errors;
  - the Skill Check Custom Event: all three menus, trip record, End.
- Node checks: event-kit 177/177, feedback-rules 13, system-message-rules 10, resource-panel-rules 12, held-status-rules 8.
- Offer Item per member: foundryvtt-2a's sandbox, GM + 2 players.

## Not done / known
- Not yet seen in a real session, or with two GMs online.
- The world macro **ItemAwarder** still posts its own card. Migrating it needs a world edit.
- World data found but not changed:
  - Riot Shield / Vajra also exist in "Prototype Equipments".
  - The use-skills of Elemental Shard, Elixir, Remedy and Tonic are tagged `item_type: recipe`.
  - Oni's live Party Bag holds a stray "Remedy" use-skill from an earlier Change Items run.
