---
id: 2026-11-11-alter-the-story-handoff
title: Hand-off — Alter the Story (spend 1 FP), HudDock right stack, PartyTalk.narrate
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: new scripts/alter-story, shared/hud-dock (right stack), conflict-event/conflict-event-panel (place), party-talk/party-talk-ui (narrate), module.json
introduced_in: f5eaa51c..dc259d07 (v1.0.585)
fixed_in:
---

# Alter the Story: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. Nothing here needs action. It lists
the shared code this change touched, so a merge or a later change doesn't undo it by accident.

## 1. What it does

The rulebook's "Alter the Story" (core p.98): a player spends 1 Fabula Point to make something true.
Approved mockup: claude.ai/artifact/HWUJino19XLGjcHLE15jzV.

- **Button** (players only): above the dice, and above the Conflict Event emblem in battle.
- **Flow:** the player writes one sentence (or "I'll say it on voice") and can tag other heroes, whose
  players agree first. The Main GM approves, asks for a revision or denies. Everyone else sees a
  soft hold banner: nothing is locked, the GM can cancel any request, and Space is still the real pause.
- **Approve:** a cinematic ("Fate has been altered…"), then −1 FP through
  `FUCompanion.api.fabula.change([actor], -1, { reason: "alter-story" })`, a page in the GM-only
  "Altered Fates" journal, and one Party Talk narrator line outside battles and events.
- **No Foundry chat** and **no EXP** for spending.

## 2. Shared code touched

- **`shared/hud-dock.js`:** new right stack. `registerRight(id, { order, size, present })`,
  `rightSlot(id)` → `{ left, top }`, plus pure `stackRight` / `rightBase`. It stacks upward from the
  dice (`#oni-cr-button`), or from the GM desk's right end on the GM. Members: Conflict Event emblem
  (order 10), Alter the Story (order 20). Tests in `hud-dock.test.mjs` pin the emblem's old coordinates.
- **`conflict-event/conflict-event-panel.js`:** `place()` asks `rightSlot("conflict-emblem")` first; the
  old measuring code is now the fallback when HudDock is missing. `showEmblem` registers the emblem.
  It lands on exactly the same pixels as before.
- **`party-talk/party-talk-ui.js`:** `oni.PartyTalk.narrate(text, mode = "action")`, GM only, sends one
  narrator line where Talk runs and returns false elsewhere.
- **`module.json`:** three classic scripts after `fl-sheet.js`: `alter-story/as-logic.js`,
  `as-core.js`, `as-ui.js`.

## 3. Network

Socket `module.fabula-ultima-companion`, types `AS_EVENT` (client → Main GM), `AS_STATE`
(Main GM → everyone), `AS_SYNC` (a client that just loaded asks for the state). The Main GM is
`FUCompanion.isPrimaryGM()`; it holds the one open request in memory.

## 4. Tests

- `node modules/fabula-ultima-companion/scripts/alter-story/as-logic.test.mjs` (49 checks)
- `node modules/fabula-ultima-companion/scripts/shared/hud-dock.test.mjs`
- Sandbox 2026-11-11 with GM, GM II and two players: exploration and a Lightning Storm battle.
