---
id: 2026-11-01-camp-lobby-button-dead-for-one-player
title: Camp lobby ready button does nothing for one player, while her other camp buttons work
status: open
severity: major
reporter: onigensou
assignee: onigensou
component: camp-system/camp-ui-button
introduced_in:
fixed_in:
---

# Root cause not found

Seen once, in the real session of 2026-10-31, on Valley_Map024 (Underground Camp). Not reproduced
elsewhere. Her client could not be inspected, so the cause is still open. No code was changed.

## Symptom

Blumairwen (Keren) pressed the round camp button in the Free Roam lobby and did not turn ready. The
same thing happened again in the Sleep lobby. The other three players readied normally both times.
The table could only continue because the GM client marked her ready by hand. The Set Out lobby uses
the same button and was not reached while this was being looked at.

## Evidence

A temporary socket listener on the GM page logged what arrived. All times are local, 2026-11-01.

| time | what reached the GM |
|---|---|
| 02:05:27–02:05:30 | `CAMP_TOGGLE_READY` from Rinri, Silryantish, Trinio |
| 02:05:28–02:06:20 | nothing from Blumairwen, with her tab visible and the host relaying that she was pressing |
| 02:06:20 | she was forced ready from the GM client |
| 02:06:29 | ready map cleared (GM Start, on to Activity Select) |
| 02:06:36 | `CAMP_TOGGLE_READY` from Blumairwen, most likely Activity Select's confirm (`camp-ui-activity-select.js:344`), not the lobby button |
| 02:19:18 | her Bond Confirm wrote to Keren, and the phase later moved on to `sleep_lobby` |
| 02:20:21–02:20:29 | `CAMP_TOGGLE_SLEEP` from Silryantish, Rinri, Trinio |
| through 02:22:50 | no `CAMP_TOGGLE_SLEEP` from Blumairwen; she was then forced ready again |

The clicks that failed go through `CAMP.Button.onClick` (`camp-ui-button.js:262`). The listener only
ran from 02:05 onward, so the failure the host reported before that was not captured.

## Ruled out

- **Her connection to the GM.** Other messages from her client arrived and her actor writes saved
  during the same camp. Her internet did drop earlier that night, but client health logged no
  disconnect since her page last loaded at about 23:20.
- **A full-screen layer over the page.** The lobby button sits at z-index 99998. Camp overlays sit at
  about 1200–1500 (`camp-styles.js`), and those took her clicks. A full-screen blocker above the
  button would have stopped those too, including the battle-end camera lock (z-index 100000).
- **Party membership.** The GM resolves her as Keren's owner. Her lobby dot was drawn and she was in
  the active party list. This was read on the GM client, not hers.
- **Module UI settings.** Her `hide-player-ui` flags match the other three players.

## Hypotheses

Each one is untested.

1. **Something small covers the bottom-left corner on her screen only.** The button is fixed at
   `bottom: 80px; left: 20px`. Her display reports 2170x1221 at a device pixel ratio of 1.18, so
   other UI may land differently. Confirmed if the check below shows `isButton: false`.
2. **The button's click handler is not running on her page.** Confirmed if `isButton: true`, and
   `CampSystem.Button.onClick()` from her console readies her while the mouse does not.
3. **Her client has a stale `campPhase`.** `onClick` returns silently when the phase is not a lobby
   phase. Weak, because her screen followed the phase changes. The check prints the phase.

Her page size also swings between about 12,700 and 20,200 DOM elements. It looks like a large window
opening and closing, since Rinri's spiked to about 22,300 once. It is noted here but not linked to
the bug.

## Next test

When it happens again and before any reload, which could wipe the evidence, have the player paste
this into the console. It only reads:

```js
(()=>{const b=document.getElementById('oni-camp-phase-btn');const r=b.getBoundingClientRect();const t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return JSON.stringify({phase:CampSystem.State.getPhase(),shown:b.style.display,rect:[r.x,r.y,r.width,r.height],win:[innerWidth,innerHeight],onTop:t?.id||t?.className||t?.tagName,isButton:b.contains(t)})})()
```

Then have them run `CampSystem.Button.onClick()`, and see whether they turn ready. It toggles, so
run it once.

## Workaround

On the primary GM client, while the matching lobby is open, use the method for that phase. These are
toggles, so check the map first or a ready player gets unreadied:

```js
const s = CampSystem.State, id = "<userId>";
if (!s.getSleepReady()[id]) await s.toggleSleepReady(id);   // Sleep lobby
// Free Roam: getReady / toggleReady. Set Out: getSetOutReady / toggleSetOutReady.
```

The ▶ button on the GM panel also skips a lobby without anyone being ready.

Do not use `CAMP.debug.reset()` to restart a camp mid-cycle. `State.reset()` also clears
`campReturnPoint`, so Set Out loses its destination.

## Suggested fix

Built on branch `feat/camp-loop-hardening`, not pushed. The root cause is still unknown, so this stays
open until a real session shows the button working or the new log names the cause.

- The button now acts on `pointerdown`, pulses while sending, resends for about 6 s, then warns.
- The client-health log records `camp-press`, `camp-press-click`, `camp-press-unanswered` and
  `camp-press-covered` (which names the covering element). The covered case also warns the player.
- A GM can click a lobby dot to mark that player ready, which replaces the console workaround.

**If it happens again**, read those entries for that player: `camp-press` with no `camp-press-click`
means the old `click` was the fault; `camp-press-covered` names the cover; no entries at all means the
press never reached the page, which points at something on their machine.

## Notes

- 2026-11-01: filed during the session. Another bug hit the same night and has no report yet: Bond
  Update's Add Bond can't reuse a slot freed in the same menu (`camp-ui-bond.js:272-302`). Fixed on
  the same branch.
- 2026-11-01: sandbox retest, not reproduced. A real mouse click on Blumairwen's user reached the GM at
  scale 1.18 in two window sizes, with Keren's sheet open or dragged over the button, with a sheet field
  focused, and with the camp drawn in a hidden tab. Keren's sheet accounts for the DOM swing. Not
  simulated: her browser extensions and screen overlays.
- 2026-11-01: a co-worker reports her camp pose spots work. Their "!" uses `pointerdown` or keyboard Z,
  and shows only in these same lobby phases. That supports a working connection and a correct phase on
  her client in the lobby. It wasn't confirmed which input she used or when.
- 2026-11-01: `ritual-pip.js` covered this button during anyone else's ritual, for everyone but the
  performer. It moved above the button row. No sign a ritual ran that night, so it's unlikely the cause.
