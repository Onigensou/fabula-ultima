# Usable tiles + Healing tile rework (v1.0.594)

Heads-up for sarunphat: this touches shared dungeon files. The trap FX (`dp-trap-fx.js`), the status HUD pulse (`dp-status-hud.js`), the tile effect engine and the confirm panel all gained a heal path or new options. Trap behaviour is unchanged.

## The rules (Oni's ruling, 2026-11-12)

- **Beneficial tiles get a Use button** (the per-tile `dungeonPathing.usable` flag): Healing, all loot tiles (Gold, Consumable, Item, Weapon, Armor, Accessory, Treasure), Gathering and Fishing. Camp and Dirt already had it.
- **Forced tiles fire on Confirm**: Random Battle, Skill Check ("works like a battle"), Trap and the effect tiles, Force Move, Gusty, Vertigo, Story, Event, Final, Door and Travel.
- **Hidden tiles stay forced.** A loot or Gathering tile placed with the Blank texture is a surprise; `tileStates.initialTexture` tells. That's 42 tiles today.
- **Fixing a mistaken Confirm:** after Confirm on a Usable tile, clicking the tile the party stands on reopens the panel as **Use · Cancel**. It is free: no step is counted and TURN_END doesn't fire, so dungeon debuffs don't tick twice. Spent tiles and forced tiles still get "You are already on this tile."
- **Confirm keeps its label** everywhere ("I end my move here").

## Healing tile

- Heals each member **35% of their own max HP, at least 10**, and skips a member at 0 HP. The tile's Amount field is ignored, the same way a Trap ignores it. The point is a healthy heal that never brings anyone to full. Lv 45 slot-1 party: +54 / +29 / +71 / +50.
- Same pipeline as the Trap: the GM previews with `applyDamage({ isRecovery, dryRun })`, broadcasts `DP_TRAP_FX` with `kind: "heal"`, and then writes. A player trigger goes over `DP_TILE_EFFECT_APPLY` with `heal: true`. No chat card and no screen flash.
- What players see: Heal3.ogg, the MV `041_heal_one_1` clip at the token's feet (Sequencer), a green tint flash, a face + green `+N` per member (with FULL / KO tags), and each HUD row glows green as a pale-green lead jumps ahead and the bar fills up behind it. The readout shows `+N`, HP / max, and Full or Crisis cleared.
- **Bug fixed:** `healing` had no registry handler, so the dispatch never reported the tile cleared and it healed on every landing. `tile-event-healing.js` registers it with `clearAfterTrigger: true`. "Reset on rest" brings it back after a rest, as the Fishing tile does.

## Code

- New: `dp-heal-rules.js` (+ `dp-heal-rules.test.mjs`, 7 tests) and `tile-events/tile-event-healing.js`, both in `module.json`.
- `dp-tile-effect-engine.js`: `isHeal` / `runHealGM`, beside the Trap path.
- `dp-trap-fx.js`: `impact({ kind: "heal" })` and `play({ kind: "heal" })`. Trap calls are unchanged (kind defaults to `"trap"`).
- `dp-status-hud.js`: `pulse()` rows with `kind: "heal"` use the gain pulse.
- `dp-confirm-dialog.js`: `ask()` takes `useType` (the Use glyph: ✚ Healing, ⛺ Camp, ⛏ Dirt and Gathering, 🎣 Fishing, ✦ loot), `showConfirmButton` and `revertLabel`. The MirrorPrompt watcher copy follows the spec.
- `dp-bootstrap.js`: `state.pendingUse` is set on Confirm on a Usable tile and cleared on any move (restored on Go Back), on Use and on deactivate. `useTileInPlace()` runs the dispatch with no turn events. `pendingUse` lives on the client that pressed Confirm; after a reload the party walks off and back as before.
- `dp-tile-effect-config.js`: a note under Amount.
- Preflight `tiles`: warns when a beneficial tile isn't Usable (hidden ones exempt) or a Healing/Fishing tile has no Reset on rest.

## World data

- scenes: 104 tiles flagged (`tools/safe-edit/bin/_usable-tiles-2026-11-12.js`). All 15 Healing tiles and both Fishing tiles get Reset on rest.
- settings: 9 Monk's tile presets get the same flags. This store also carries `hideHotbar=true` from Battle Grade v2.
- Save slot 1 is patched locally. A Load re-applies the saved tile flags, so slots 2 and 3 would switch them back off on load until they're re-saved.

## Verified (Staging World, Valley_Map006)

- GM run, 25/25: the landing panel, Go Back, Confirm, the own-tile Use and Cancel, heal amounts, numbers and HUD, no extra turn, the tile goes spent, the notice on a spent tile, a rest re-arms it, a KO'd member is skipped.
- GM + player (Blumairwen), 9/9: the player drives, the GM watcher copy shows both panels, the heal goes over the socket, and both clients show the numbers.
- Not tested: a real session, the Skeletal Key button inside the own-tile panel, Gathering/Fishing/loot via the own-tile panel (same dispatch).
