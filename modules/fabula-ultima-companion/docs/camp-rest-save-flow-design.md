# Rest-Time Save Flow — update proposal

**Status:** proposal, not implemented. Awaiting go-ahead.
**Scope:** UI/UX + flow orchestration. No change to save/load *logic* — `SaveSystem.Core.save/load`,
the extractors, and the storage layer are used as-is.

---

## 1. Why

Today the party only ever *touches* the save system from the outside: the title-screen Load lobby
(`title-load-ui.js` / `title-socket.js`). **Saving** is a GM chore run from
`SaveSystem.UI.open()` after everyone has left. The table never gets the PS1/PS2 beat of
"you reach the save point, you choose to save, you choose to stop playing."

The Rest sequence is already the natural save point: it happens once, at the end of a session,
the screen is already black, and the jingle already marks it as a ceremony.

## 2. Current sequence (what exists)

| Step | Where |
|------|-------|
| Sleep lobby, party readies up, GM presses Start | `camp-ui-button.js:286` → phase `SLEEPING` |
| All clients fade to black | `camp-ui-sleep.js:13` (`SleepUI.run`) |
| GM-only: BGM stop → jingle broadcast → 5 s hold → HP/MP restore, AE sweep, rest-charge tick, chat card | `rest-api.js:153` (`RestAPI.perform`) |
| GM sets phase `SET_OUT_LOBBY`; every client fades back in and shows the Set Out button | `camp-ui-sleep.js:24`, `camp-bootstrap.js:114` |

Save-side facts that constrain the design:

- `SaveSystem.Core.save()` is **primary-GM only** and refuses concurrent save/load
  (`save-core.js:26-48`). Any player-driven trigger must be routed to the primary GM over socket.
- The save blob records `game.scenes.active` and re-`activate()`s it on load, deliberately last
  (`save-extractors.js:964`).
- The blob **also records every CampSystem world setting verbatim**, including `campPhase`
  (`save-extractors.js:1253`). This is the single biggest trap in this feature — see §5.
- `SaveSystemUI` already supports being driven by a remote flow: `openInMode("save")` skips the
  mode menu, and `_slotClickHook` lets a wrapper redirect a slot click into a socket flow
  (`save-ui.js:398`, `save-ui.js:405`). The title Load lobby is exactly that wrapper — the save
  side gets the same treatment instead of a new panel.

## 3. Proposed sequence

```
SLEEP_LOBBY  ──(GM Start)──►  SLEEPING
                                 │  fade to black, jingle, resources restored   [unchanged]
                                 ▼
                          REST_SAVE_PROMPT      "Save your journey?"   [Yes] / No
                                 │
                    Yes ─────────┼───────── No
                     │                        │
                     ▼                        │
              REST_SAVE_SLOT                  │   slot picker (existing SaveSystemUI file screen)
                     │                        │
                     ▼                        │
              REST_SAVING                     │   progress bar; primary GM runs Core.save()
                     │                        │
                     ├── fail → retry / continue without saving
                     ▼                        │
                          REST_TITLE_PROMPT ◄─┘   "Return to the title screen?"   [Yes] / No
                                 │
                    Yes ─────────┴───────── No
                     │                        │
                     ▼                        ▼
        activate Title scene            SET_OUT_LOBBY   (existing loop continues)
        (everyone pulled there)
```

The screen **stays black** for the whole prompt chain. Panels are drawn on top of the existing
`#oni-camp-sleep-screen` overlay, so the fade-in only happens on entry to `SET_OUT_LOBBY`
(or is handed off to the title scene).

Both branches converge on the title prompt: skipping the save does not skip the "are we done for
tonight?" question. If the save was declined or failed, the title panel carries a caution line
(`THIS SESSION HAS NOT BEEN SAVED`) so nobody quits by muscle memory.

---

## 4. Decision 1 — who controls the Save menu

### The options

| | Model | Pros | Cons |
|---|---|---|---|
| **A** | Primary GM drives, party watches | Zero new plumbing; matches where the write actually happens | Defeats the point — the party still doesn't touch it |
| **B** | Main Controller (`FUCompanion.api.isCurrentUserMainController`) | Already exists, already persists across scene modes; one unambiguous seat | It's a *map/exploration* seat. At camp nobody has "taken control", so it silently resolves to whoever last drove the overworld — arbitrary, and invisible to the table |
| **C** | Party-wide vote / ready-check, mirroring the title Load lobby | Consistent with Load; nobody is surprised | Heavy for a Yes/No; a disconnected player deadlocks it |
| **D** | Open floor — first party client to answer decides | Fastest, most arcade-like | Race between two clicks; no clear "whose turn" affordance |

### Recommendation: **Rest Steward** (B, made explicit, with C only for the title question)

Split the two questions by consequence:

**Save question → one steward drives, everyone spectates.**
Saving is harmless and reversible-by-repetition; it does not need consensus. Elect a **Rest
Steward** once, on entry to `REST_SAVE_PROMPT`, on the primary GM:

1. the Main Controller, *if* they are an active party-member client
   (`isCurrentUserMainController` resolves the stored seat — reuse it, don't invent a second one);
2. else the first active party member by `member_id_N` slot order (`CAMP.Party.resolve()`);
3. else the primary GM.

The steward's client owns the panel and the keyboard. Every other client — players, the co-GM,
spectators — gets the same panel rendered read-only with a `⟨ Name ⟩ IS CHOOSING` banner and live
cursor mirroring. This is the house pattern already used by the Opportunity spectator flow and
Treasure Roulette v2 (controller-owned full-screen flow, picker-client broadcasts, GM take-control),
so it will feel native and reuses proven code shape.

Escape hatches, both required:

- **GM take-control** — a GM-only `TAKE CONTROL` chip on the spectator panel reassigns the steward.
  Covers a steward who went to make tea.
- **Auto-default timer** — 45 s of no input resolves to the default (Yes). Prevents the whole table
  being stranded behind one AFK client, and reads as JRPG-correct ("the cursor is already on YES").

Why not just "the GM does it": the request is explicitly to hand the ritual to the party.
Why not the full vote: a 4-way quorum for "yes, save" is friction with no safety benefit, and the
existing Load quorum exists to prevent two clients loading *different slots*, which has no analogue
here.

**Title question → party ready-check (option C).**
Returning to title ejects everyone and ends the session — that is not one player's call. Reuse the
Sleep/Set Out lobby idiom the camp already has: dots per active party client, everyone confirms,
GM Start commits. Default Yes with the same 45 s auto-confirm; a single `NO` from anyone drops the
whole table back to `SET_OUT_LOBBY` (the safe branch — you can always ask again next Rest).

### Slot selection

Do **not** invent a quick-save slot. On `Yes`, the steward gets the existing SaveSystem file screen
via `SaveSystemUI.openInMode("save")` with `_slotClickHook` set — exactly how `TitleLoadUI` does it
— so slot cards, overwrite confirm, feather cursor and SFX all come for free and the save menu the
party sees at Rest is byte-identical to the one they see at the title screen.

---

## 5. Decision 2 — where a load lands

### The trap

`campState` (`save-extractors.js:1253`) snapshots **every** CampSystem setting including `campPhase`,
and `apply()` writes them all back. A save taken at `REST_SAVING` would restore `campPhase =
rest_saving`, and on the next `canvasReady` `camp-bootstrap.js:61` would replay that phase — at
best a dead panel, at worst (if it were `sleeping`) a **second full rest**: another jingle, another
resource restore, another AE sweep. Silent, and it would look like a save-system bug rather than a
phase bug.

### Recommendation: normalize the phase at snapshot time

Add a landing-phase normalizer to the camp system and have the `campState` extractor's `extract()`
call it, rather than special-casing this one feature:

```
CAMP.LANDING_PHASE = {
  activity_resolve:  free_roam,        // mid-animation, unreplayable
  sleeping:          set_out_lobby,
  rest_save_prompt:  set_out_lobby,
  rest_save_slot:    set_out_lobby,
  rest_saving:       set_out_lobby,
  rest_title_prompt: set_out_lobby,
}   // every other phase maps to itself
```

Same pass clears the transient maps that belong to the finished cycle — `campReady`,
`campSelections`, `campResolved`, `campBondConfirmed`, `campSleepReady`, `campSetOutReady` — so the
restored Set Out lobby opens with clean dots instead of a stale all-ready state that could
auto-advance the moment the last player connects.

**Result:** load puts the party on the camp scene, screen visible, in `SET_OUT_LOBBY` with the
Set Out button live — precisely the requested landing spot. No change to `activeScene`: the camp
scene is already the active scene when the save is taken.

Bonus: this makes *any* future mid-cutscene save safe, not just this one.

Two supporting details:

- The black overlay is created lazily by `_ensureScreen()` at run time, so a freshly-loaded client
  has no black element at all and `SleepUI.fadeIn()` is a harmless no-op. Nothing to persist.
- `label`/`thumbnail` on the blob come from the active scene, so rest saves will read
  `"<Game> — <Camp scene>"`. Worth a small tweak: append a marker (e.g. `⏾`) for rest saves so the
  slot card reads as an end-of-session save rather than a mid-camp one.

---

## 6. Implementation plan

### New phases (`camp-constants.js`)

```
REST_SAVE_PROMPT:  "rest_save_prompt"
REST_SAVE_SLOT:    "rest_save_slot"
REST_SAVING:       "rest_saving"
REST_TITLE_PROMPT: "rest_title_prompt"
```

Inserted between `SLEEPING` and `SET_OUT_LOBBY` in: `PHASE_ORDER` (`camp-bootstrap.js:177`),
the GM panel's label map and order (`camp-ui-gm-panel.js:15-33`).

Why phases and not a transient overlay: a phase survives an F5 mid-flow, syncs every client through
one `updateSetting`, and drops into the GM panel's skip/step controls for free. A transient
socket-only overlay strands anyone who refreshes.

### New state (`camp-constants.js` `SETTING` + `camp-state.js`)

| Key | Shape | Purpose |
|-----|-------|---------|
| `campRestSteward` | `{ userId }` | elected steward, so every client can render the right banner |
| `campSaveChoice` | `{ save: bool, slotId: int\|null, ok: bool\|null, error: str\|null }` | outcome of the save leg; drives the title panel's caution line |
| `campTitleReady` | `{ [userId]: true }` | ready-check for the title question (same shape as `campSetOutReady`) |

All registered in `registerSettings()` and cleared in `State.reset()`.

### New socket messages (`camp-constants.js` `MSG`, handled in `camp-socket.js`)

```
REST_SAVE_ANSWER    steward → GM   { userId, save: bool }
REST_SAVE_SLOT_PICK steward → GM   { userId, slotId }
REST_SAVE_PROGRESS  GM → all       { pct }              spectator progress mirror
REST_SAVE_RESULT    GM → all       { ok, slotId, error }
REST_TAKE_CONTROL   GM → all       { userId }           steward reassignment
REST_TOGGLE_TITLE   any → GM       { userId }           title ready-check toggle
REST_CURSOR         steward → all  { index }            spectator cursor mirror (ephemeral)
```

Handlers follow the existing camp convention: player→GM requests mutate world settings, Foundry's
`updateSetting` fans the result out.

### New files

- `scripts/camp-system/camp-ui-rest-save.js` — the three panels (save prompt, saving progress,
  title prompt), steward vs spectator rendering, keyboard handling, auto-default timer. Visual
  language copied from `title-quit-ui.js` / `ts-wait-*` (parchment panel) so it sits in the same
  family as the title screen.
- `scripts/camp-system/camp-rest-save-flow.js` — GM-side orchestration: steward election, phase
  advancement, `Core.save()` invocation, title-scene activation.

Registered in `module.json` after `camp-ui-sleep.js` and before `camp-bootstrap.js` (line ~340).

### Touched files

| File | Change |
|------|--------|
| `camp-constants.js` | 4 phases, 3 setting keys, 7 messages |
| `camp-state.js` | register + accessors + reset for the 3 new keys; `CAMP.LANDING_PHASE` + `State.landingPhaseFor()` |
| `camp-bootstrap.js` | 4 new cases in `_onPhaseChange`, 4 entries in `PHASE_ORDER` |
| `camp-ui-sleep.js` | `run()` advances to `REST_SAVE_PROMPT` instead of `SET_OUT_LOBBY`; keep the black screen up |
| `camp-socket.js` | handlers for the 7 new messages |
| `camp-ui-gm-panel.js` | 4 label/order entries |
| `save-extractors.js` | `campState.extract()` routes `campPhase` through `landingPhaseFor()` and blanks the transient ready maps |
| `rest-api.js` | expose the scheduled BGM-resume handle so the flow can cancel it (see §7) |
| `module.json` | 2 script entries |

No changes to `save-core.js`, `save-storage.js`, `save-ui.js` (only *used*, via `openInMode` +
`_slotClickHook`), or any title-screen file.

---

## 7. Traps and edge cases

1. **BGM resume over the title screen.** `_scheduleResume` (`rest-api.js:127`) re-starts the camp
   playlist when the jingle ends, or blindly after 35 s. If the party returns to title, that timer
   fires *over the title BGM*. `RestAPI.perform()` must return (or stash) the resume handle so the
   flow can cancel it on the return-to-title branch. Easy to miss — it only shows up ~35 s after a
   correct-looking transition.
2. **Dual GM.** Both GM clients receive every socket message. Steward election, `Core.save()`, and
   `scene.activate()` must all be gated on `FUCompanion.isPrimaryGM()`, exactly as
   `title-socket.js` does. `Core.save()` would refuse a second caller anyway, but the phase writes
   and the scene activation would not.
3. **Save failure must not be swallowed.** `Core.save()` returns `{ok:false, error}` when any
   extractor fails and deliberately writes nothing. The panel shows the error with
   `RETRY` / `CONTINUE WITHOUT SAVING`, and the title prompt inherits the caution line. Never
   auto-advance a failed save into a return-to-title — that is the one path that loses a session.
4. **Save is not instant.** ~15 extractors, party embeds, disk write. Use the existing
   `_startProgress`/progress-bar in `SaveSystemUI` rather than a spinner, and mirror the percentage
   to spectators over `REST_SAVE_PROGRESS` so four black screens don't look frozen.
5. **Steward disconnects mid-prompt.** The auto-default timer covers it; additionally re-elect on
   `userConnected` if the current steward went inactive, mirroring
   `TS.Socket.refreshRoster()`'s posture.
6. **Spectators are not party members.** Use `CAMP.Party.getActiveUserIds()` for both the steward
   pool and the title ready-check — the camp UI already excludes spectators this way
   (`camp-ui-button.js:243`), and per house rule "players" here means db-resolved party members.
7. **Load cannot start while this save runs.** `Core`'s `_inFlight` guard already blocks it on the
   primary GM, and both paths funnel through the same client — but the title-screen Load lobby is
   reachable the instant the title scene activates, so the return-to-title branch must only fire
   *after* `Core.save()` has resolved, never in parallel.
8. **`_poisoned` state.** If a prior load timed out, `Core.save()` refuses until F5. Check
   `Core.blockedReason("save")` when entering `REST_SAVE_PROMPT` and grey the `YES` with the reason
   rather than letting the party pick a slot and hit a wall.
9. **Returning to title leaves camp phase mid-flow.** Before activating the title scene, write
   `campPhase = SET_OUT_LOBBY` and clear the transient maps, so the *live* world (not just the save
   blob) is in the resumable state. Otherwise the next session boots into a dead phase.
10. **Hidden-tab clients.** These panels are DOM overlays, not broadcast VFX, so the
    `vfxSuppressed()` guard does not apply — but the jingle and any new SFX broadcast do go through
    AudioHelper; keep new sound to the steward's own client plus the existing broadcast jingle.

---

## 8. Test plan

Offline / code:
- `node --check` each new script as `.mjs` before relaunch.
- Unit-ish: `landingPhaseFor()` over every phase value, including unknown input.

Live, 2 clients minimum (CDP dual-client rig):
1. Rest → save prompt appears black-screened on both; steward banner correct on the non-steward.
2. `No` → title prompt shows the not-saved caution → `No` → lands in `SET_OUT_LOBBY`, screen fades in.
3. `Yes` → slot picker → overwrite an occupied slot → progress mirrors on the spectator → success.
4. Title prompt `Yes` → both clients land on the title scene, title menu open, camp overlay gone,
   camp BGM does **not** resume 35 s later.
5. Load that slot from the title lobby → camp scene, `SET_OUT_LOBBY`, clean ready dots, Set Out
   works, **no second jingle / no second resource restore**.
6. F5 the steward mid-prompt → rejoins into the same phase with the panel intact.
7. Steward goes inactive → 45 s auto-default fires; GM `TAKE CONTROL` also works.
8. Force a save failure (temporarily break one extractor) → error panel, retry works, no silent
   pass-through to title.
9. Run the `preflight` suite + `skill-regression --teardown` before any push, and the full
   world-export procedure if any world object moved (none expected — this is module-code only).

## 9. Out of scope

- Any change to what a save *contains* or how it applies (extractors, diff-apply, storage).
- Mid-session / quick save from anywhere but the Rest sequence.
- Autosave.
- Save points as physical objects in dungeon/exploration scenes (a natural sequel — the flow built
  here is reusable, since only the entry trigger differs).
