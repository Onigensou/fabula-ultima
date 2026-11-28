# Reaction asked twice on one creature froze the battle (#17)

2026-11-28 · seen live in the session · branch `feat/fix-reaction-freeze`

## What broke

Rakshasa's Rending Orbit hit Hina twice, so `creature_lose_resource` fired twice and
Painful Lesson was asked twice on the GM desk.

- Ask 1: the GM skipped it. `srxPass` added Painful Lesson to the entry's `skipped`
  set and called `onPass`. The menu closed, and `closeSrxEntry` left the closed entry
  in `D.rx` for `CLOSE_GRACE_MS` (160 ms). That delay is there so a Use can re-open the
  same menu.
- Ask 2 came in on the same key (combat + token) inside those 160 ms.
  `deskSpawnReaction` copied `history` and `skipped` from that closed entry
  (`skipped: prev?.srx ? prev.skipped : new Set()`). The carry-over was only meant for a
  Use re-opening the same menu, but it ran for any previous entry.
- So ask 2 opened with Painful Lesson already marked **Skipped**: "0 to answer", and no
  Skip all button (it only shows when something is open). Nothing could call `onPass`,
  so RESOLVE waited forever.
- The Unstick panel said "Nothing is waiting on a player" because it only reads
  `listWaits()` and never looked at desk reaction entries.

## Fix (gm-desk.js + new srx-carry.js)

1. **Carry-over only on a Use re-open.** The decision now lives in `srx-carry.js`
   (`srxIsUseReopen` / `srxCarryOver`). A Use (Apply) leaves `pending` set on the
   entry, while a Pass or a plain close does not. So `history` + `skipped` carry over
   only when `prev.srx && prev.pending`. Anything else is a new ask and starts clean.
   The Applied-row logic is unchanged. The carried `skipped` set is now a copy.
2. **Safety net, no dead entries.** After `deskSpawnReaction` returns (on a `setTimeout 0`,
   so the caller has registered the record), it checks `srxNeedsAutoPass`. If the entry
   has a Pass and nothing left to Skip or Apply (every row auto, unusable or skipped,
   or no rows), Pass is the only answer left, and the desk gives it (`srxPass`). This
   does not happen while a Use is in flight, or for a creature a live player is deciding
   on their own screen (locked desk), because their client answers.
3. **Unstick panel lists open desk reaction menus.** Each one shows the creature, who
   decides, the label, how many rows are open, and a Pass button (the menu's own pass
   label) that calls `srxPass`. "Nothing is waiting on a player" now shows only when
   neither player waits nor desk reactions are open.

`srxOpenRows` moved into `srx-carry.js` unchanged, so the view and the tests share it.

Checked the other reaction UIs for the same pattern. None of them carry state from the
previous menu:
- player reaction hand (`reaction-hand.js mountHandReaction`): a fresh `sa` every mount
- drawer (`drawer-views.js mountDockedReaction`)
- token blades (`reaction-menu.js spawnMenuInternal`)
- `reaction-menu-player.js`

## Tests

- New `scripts/battle-director/srx-carry.test.mjs` (10 cases): the live repro (pass,
  then a second ask, comes back clean), a Use re-open keeping history/skips (landed and
  cancelled Use), the copy of the set, open-row filtering, and the auto-pass rules
  (fires on the old dead shape, on auto/unusable-only rows and on no rows; does not fire
  with a row open, no onPass, closed, busy, Use in flight, or a live player deciding).
- `tools/check-esm.js` OK on gm-desk.js + srx-carry.js. Full test sweep: see the commit
  notes / handback.

## Open edge (design call, left as is)

If a Use lands on a creature's LAST reaction and a separate second ask arrives within
the 160 ms grace, it is still read as a Use re-open and gets the first ask's skips.
Only reactions that were explicitly skipped in ask 1 would carry. If that leaves
nothing open, the safety net passes it instead of freezing. Telling the two apart
for sure would need the dispatcher (standalone-reactions.js) to mark its re-open
spawn. That's a small change if we ever see it happen.

`gm-desk.js` needs a full page reload (hot-reload-map: RELOAD-REQUIRED).
