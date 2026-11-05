---
id: 2026-11-05-session-start-automation
title: Start Session now runs automatically when a save loads (Fabula Ledger) — your call on the details; plus a 10 FP cap in writeResourceDelta
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: session-system/session-start-button
introduced_in:
fixed_in:
---

## What changed

The user kept forgetting to press **Start Session**, so the new Fabula Ledger
(`scripts/fabula-ledger/fl-session.js`, branch `feat/fabula-ledger`) now calls
`SessionSystem.startSession()` itself. Your file is **unchanged**; this is a design
call about how it gets used, so it's yours to accept, change or veto.

**When it runs:** once per *opened session*, never on a reload. The ledger keeps an
open/closed session flag (world setting `fabulaLedgerState.session`), moved only by
in-game moments (the user rejected real-time gaps):

| moment | hook (new, one line each) | effect |
|---|---|---|
| a save finishes loading from the title screen | `fuSaveLoaded` in `title-screen/title-socket.js` `_performLoad` | session closed → **open it** (startSession + +1 FP to anyone on 0) |
| same, but a session is still open (tab closed mid-night, crash) | — | GM prompt: **New session** / **Same session** |
| camp rest "return to title" yes | `fuSessionClosing` in `camp-system/camp-rest-save-flow.js` | close |
| session-end prompt sent | `fuSessionClosing` in `session-end/session-end.js` | close |
| GM ledger panel | — | open / close by hand |

So the "not idempotent" concern in your header is handled by the flag: a second
`fuSaveLoaded` in the same open session asks the GM instead of re-running.

## Things you may want to decide

1. **It isn't awaited.** `startSession()` waits for interactive rolls. In the sandbox
   it sat on Hina's *Instability Recovery* "Roll d6" card until the GM clicked it, so
   the ledger fires it and moves on (`fl-session.js`, `open()`). The roll card
   therefore pops up on the GM's screen **during/just after the title load**. Is
   that the moment you want, or should the auto path defer it (e.g. to the first
   `canvasReady` after the load)?
2. **The manual button is still there** and still runs the effects again if
   pressed. Should it be hidden/greyed while `FUCompanion.api.fabula.session.isOpen()`
   is true, or warn "this session already started"?
3. **"Same session" skips startSession.** Right for a crash mid-night; tell me if
   any effect should run on every load instead.

## Repro (sandbox)

1. `await SaveSystem.Core.save(3)` then `await TitleScreen.Socket.forceLoad(3)`.
2. Console shows `[FabulaLedger][Session] opened save loaded`; the Instability roll
   card appears; anyone on 0 FP goes to 1.
3. `forceLoad(3)` again → GM prompt "New session? · last one still open".

## Notes

### Also in your files: a 10 Fabula Point cap (FYI, small)

The user capped Fabula Points at 10 ("easy to get > use fast > cap at 10"). Two
lines in Battle Director code you own:

- `battle-director/resources.js`: the `fp` row gets `hardMax: 10`.
- `battle-director/skill-effects.js` `writeResourceDelta`: `hardMax` now caps a
  **gain** only, and never pulls a total that is already above it back down:

  ```js
  // before
  next = Math.min(hardMax, Math.max(hardMin, next));
  // after
  const ceiling = delta > 0 ? Math.max(cur, hardMax) : Infinity;
  next = Math.min(ceiling, Math.max(hardMin, next));
  ```

  Why: Blanche sits on 12 FP (set by hand on the sheet). Under the old line, her
  next spend would have dropped her to 10, not 11. GM sheet edits stay uncapped
  on purpose.

**Zero Power also has `hardMax` (6), so it sees the same rule.** Gains still stop
at 6, so nothing changes in play. The only difference is a ZP total already above
6 (only possible by a hand edit) is no longer snapped to 6 by the next write.
Tell me if ZP should keep the old hard clamp and I'll special-case it.
