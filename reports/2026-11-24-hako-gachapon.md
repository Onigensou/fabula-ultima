# Hako's Gachapon — walk-up access, watch party, 50/50, pity line, history (v1.0.663, 2026-11-24)

Session to-do from the 2026-11-21 session: players could not reach the gacha without the GM moving the table to the
Gacha Scene, and there was no pity readout. Designed with a playable mockup over four rounds, then built and tested in a
multi-client sandbox. Mockup (decisions recorded on the page): https://claude.ai/artifact/UY1Ho5ENGJgmhq9WFpuBdP

## What players see
- **Walk-up:** stand at Hako's feet → a gold **star** button next to Shop (keyboard: Confirm → "Shop / Gachapon").
  The machine opens on **this client only**, over the current map, fully opaque (Gacha_Scene001 art as its own backdrop).
  The scene's music + ambience duck locally and DRG_Gacha loops; **←** (or Esc / Cancel X) leaves and restores them.
- **The pull is public (watch party):** when anyone presses Wish, every other client gets a call-out
  ("Keren is wishing ×10!") and, after 1.6 s, the shared reveal; any key skips, the summary returns them to the map.
  Per-player setting *Gachapon: when someone else wishes* = join (default) / ask first / results card only.
  Busy players (event running, battle, card duel) are never taken over: they get a results card with **Watch replay**,
  which stays until they are free. The Spectator account follows every reveal silently. One reveal at a time:
  others at the machine see "Machine in use: Keren is wishing…".
- **Card:** party pity as ONE line ("Party pity 6/30 — a 5★ is guaranteed within 24 wishes; a 4★ or better within 10")
  and a pill beside "Probability increased!": "Next 5★: 50/50", gold "Next 5★: featured" after a filler-set 5★.
  Hako's fine print stays fully visible (the text column tightens on screens under 1000 px tall).
- **Reveal additions** (sequence unchanged): "Keren · Wish ×10 · Oathsworn Paladin" chip, "Featured set!" /
  "Filler set · the next 5★ is guaranteed featured" on 5-stars, watchers' ✦ cheer / 💧 groan badges.
- **Wish History** panel (new nav button): who pulled what, newest first, last 50, ticket redemptions included.

## Rules
- **50/50 featured guarantee:** a 5★ is a fair coin between the banner's main set and its filler set(s) — not the table
  weights (Warden of the Wilds would be 57/43) — then a piece within that set by the table weights. A filler 5★ arms
  `guaranteed`; the next 5★ (rolled or hard pity) is forced featured and clears it. Per banner, shared by the party,
  stored next to pity: `flags.fabula-ultima-companion.gacha.pity[bannerId].guaranteed`. Sim: featured piece ~40 → ~30
  wishes, never more than 60. Gift Exchange still turns any piece into another of the same set.
- **Not changed:** rates, hard pity 30, 4★ floor 10, the 5-Star Exchange Ticket (GM gift; redeeming it touches neither
  pity nor the 50/50). Hako Stamps (spark) were designed and dropped: with Gift Exchange they only added yield (+50%).
- **Scene mode "gacha" kept** as the GM's "open for everyone" switch: activating Gacha Scene opens the machine on every
  client (no ← button; the GM ends it by changing scene).

## Build (feat/hako-gachapon, 3 commits)
- New: `gacha-entrance.js` (star button + `window.oni.Interact` provider, keyed on actor flag `gachaVendor`; docks to the
  Shop button), `gacha-audio.js` (local duck of the music + environment channels, restored to the core volume settings),
  `gacha-presence.js` ("At the machine" portraits, presentation only), `gacha-watch.js` (call-out / join / card / replay,
  cheers, busy tracking via oniEventExecuteStart/Done, fuBattleFocusChanged, fabulaArcanaWindow).
- Engine: `chooseFiveSide` + main/filler pick, GM machine lock (released by the roller's `REVEAL_END`, 45 s fallback),
  history append (also on ticket redeem). Socket: `REVEAL_END`, `PRESENCE`, `CHEER`; `REVEAL` now carries the roller.
- UI: opaque `#gacha-backdrop` right above the canvas (Foundry chrome stays on top), ← button, History nav, pity line +
  pill, busy chip, map overlay layers hidden while the machine or a reveal is up (`MAP_OVERLAY_LAYERS`), focus dropped
  after clicks so Z / X keep working.
- Migration `2026-11-23-gacha-vendor-hako` (seed-only): Hako (`srAH3OHOoK0tvFih`) gets `gachaVendor: true`.
  `FUCompanion.api.gacha.setVendor(actor, on)` marks any other NPC.

## Verified
- Unit tests: gacha-engine 21/21 (15 pity + 6 new 50/50).
- Sandbox (private Staging World copy on :30005 — Underground Camp + Gacha Scene; GM + Keren + Hina + Spectator, real
  mouse/keyboard input): migration on GM boot; star docks beside Shop; click and Confirm-menu open; opaque backdrop;
  local theme + duck/restore; Esc / X leave (also after mouse clicks); all 7 banners fit at 1600×900; x10 watch party on
  every client; ask mode; at-machine watcher + busy chip; busy player → card, card outlives the event, replay plays;
  50/50 loss → gold pill → forced featured → cleared (rolls rigged on the sandbox GM); cheer badges on all screens;
  history; lock release; scene-mode open/close on all clients; 0 gacha errors on any client.
- Bugs found and fixed during testing: star misaligned; fine print clipped at 900 px; camp buttons over the machine and
  reveals; cheer buttons unclickable under the reveal layers; a watcher on the last summary missed the next wish; card
  expired before a busy player could replay; a focused button swallowed Z / X; music could restore above the player's slider.

## Known / owed
- The ← sits on the "Wonderous Gachapon" title painted into Gacha_Scene001 (art call pending, see the push note).
- Headless sandbox clients run the reveal slower under CPU load; real clients not measured. Real-table look owed.
- Not tested: a real battle starting while the machine is open (uses the same fuBattleFocusChanged path as busy).
