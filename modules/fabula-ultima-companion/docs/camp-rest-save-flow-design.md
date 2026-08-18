# Rest-Time Save Ceremony — design

**Status:** implemented on `feat/rest-save-flow`. **Not live-tested** — see §8.
**Scope:** UI/UX + flow orchestration. No change to save/load *logic* —
`SaveSystem.Core.save/load`, the extractors and the storage layer are used as-is.

---

## 1. Why

The party only ever *touched* the save system from the outside: the title-screen Load lobby.
**Saving** was a GM chore run from `SaveSystem.UI.open()` after everyone had left, so the table
never got the console-JRPG beat of reaching a save point at the end of a session.

The Rest sequence is already that save point: once per session, screen already black, jingle
already marking it as a ceremony.

## 2. Sequence

```
SLEEP_LOBBY  ──(GM Start)──►  SLEEPING
                                 │  fade to black, jingle, resources restored   [unchanged]
                                 ▼
                          REST_SAVE_PROMPT      "RECORD YOUR JOURNEY?"   [YES] / NO
                                 │
                    Yes ─────────┼───────── No
                     │                        │
                     ▼                        │
                 REST_SAVING                  │   GM drives the save system's own file screen;
                     │                        │   everyone else watches a progress panel
                     ├── fail → GM retries or backs out → recorded as "not written"
                     ▼                        │
                          REST_TITLE_PROMPT ◄─┘   "RETURN TO THE TITLE SCREEN?"   [YES] / NO
                                 │
                    Yes ─────────┴───────── No
                     │                        │
                     ▼                        ▼
        activate the Title scene        SET_OUT_LOBBY   (existing camp loop continues)
        (Foundry pulls everyone there)
```

The screen **stays black** for the whole chain — the panels draw on top of the existing
`#oni-camp-sleep-screen` (z-index 1600 over its 1500), and the fade-in happens only on entry to
`SET_OUT_LOBBY`, or is handed off to the title scene.

Both branches converge on the title question: skipping the save does not skip "are we done for
tonight?". When nothing was written the title panel carries `THIS SESSION HAS NOT BEEN SAVED`, so
nobody quits by muscle memory.

## 3. Who drives — the primary GM, and it should look like nobody does

Every client renders all three panels; only the **primary GM** can answer. Other clients get the
same panel with pointer events off and the cursor position mirrored over `REST_FOCUS`, and nothing
on screen says who is choosing — so from a player's seat **the game appears to save itself**, which
is exactly the PS1/PS2 reading the table wanted.

Rejected alternatives, and why:

| Model | Why not |
|---|---|
| Party-wide vote / ready-check, like the title Load lobby | The Load quorum exists to stop two clients loading *different slots* — no analogue for a Yes/No. It would be pure friction, and one disconnected player deadlocks the end of the session. |
| An elected "steward" (Main Controller, or first party member) | The Main Controller is a *map/exploration* seat; at camp nobody has taken control, so it silently resolves to whoever last drove the overworld. Inventing a second seat for one Yes/No is overblown. |
| Open floor, first client to answer wins | Two clicks race, and there is no affordance for whose turn it is. |

It is also where the write already has to happen: `Core.save()` refuses anyone but the primary GM
(`save-core.js:26-48`), because two concurrent saves interleave the delete-all/recreate-all in
`applyActorEmbeds` and corrupt the first party member's items.

### Slot selection

No quick-save slot. On YES the GM gets the save system's existing file screen via
`SaveSystemUI.openInMode("save", flowHook)` — slot cards, overwrite confirm, feather cursor, SFX all
reused — so the rest-time save menu **is** the title-screen save menu.

`_flowHook` is a new extension point on `SaveSystemUI`, a sibling of the `_slotClickHook` that
`TitleLoadUI` already uses:

```
{ onSaved(slotId, result), onExit() }
```

`onSaved` fires on a successful write and **consumes** the hook, so the close that follows is not
also reported as an exit; `onExit` fires on any other close (ESC, BACK, a dismissed failure).

## 4. Where a load lands

`campState` (`save-extractors.js`) snapshots **every** CampSystem setting including `campPhase`, and
writes them all back on load. Camp phases like `sleeping` and the three ceremony phases are one-shot
animations, not resting states — restored verbatim, `camp-bootstrap.js:61` replays them. For
`sleeping` that is **a second full rest**: another jingle, another resource restore, another
`campRestCharges` tick. Silent, and it would read as a save-system bug rather than a phase bug.

`CAMP.LANDING_PHASE` + `CAMP.State.landingPhaseFor()` fold every unreplayable phase to where the
party should wake up:

| live phase | lands as |
|---|---|
| `activity_resolve` | `free_roam` |
| `sleeping`, `rest_save_prompt`, `rest_saving`, `rest_title_prompt` | `set_out_lobby` |
| anything else (incl. unknown) | itself |

The same pass blanks `CAMP.TRANSIENT_SETTINGS` — the finished cycle's ready/selection maps — so the
restored Set Out lobby does not open already-all-ready and auto-advance when the last player
connects. `campExplorationDebuffs` is deliberately **not** in that list: rest clears it itself, and a
save taken before that must keep it.

**Result:** a load lands on the camp scene, screen visible, in `SET_OUT_LOBBY` with the Set Out
button live. `activeScene` needs no change — the camp scene is already active when the save is taken.
Any future mid-cutscene save is now safe too, not just this one.

The black overlay is created lazily by `_ensureScreen()`, so a freshly-loaded client has no black
element at all and `SleepUI.fadeIn()` is a harmless no-op. Nothing to persist.

## 5. Three traps fixed along the way

1. **Camp BGM resumed over the title screen.** `_scheduleResume` restarts the camp playlist when the
   jingle ends, or blindly after 35 s — firing long after a return-to-title that looked clean. Added
   `RestAPI.cancelBgmResume()`, called on that branch. The `"end"` listeners cannot be unregistered
   portably, so they check a cancellation token instead.
2. **The rest ran twice with two GMs.** `SleepUI.run()` executes on every client via the phase hook
   and gated the work on `game.user.isGM` — so both GM clients performed the rest: two jingle
   broadcasts, two AE sweeps, and `campRestCharges` decremented twice (food buffs quietly expiring a
   rest early). Now gated on `FUCompanion.isPrimaryGM()`. Pre-existing bug, adjacent to this work.
3. **Phase-settle ordering.** Settling `campPhase` to `SET_OUT_LOBBY` *before* activating the title
   scene fired `_onPhaseChange(SET_OUT_LOBBY)` while camp was still active, fading the screen back in
   to the camp scene for a beat: black → camp → title. The scene now activates first; the phase write
   lands after every client has run `deactivateCamp()` and is therefore silent. It runs in a
   `finally`, so the live world is left resumable even if activation throws.

## 6. What was built

**New phases** (`camp-constants.js`, added to `PHASE_ORDER` in `camp-bootstrap.js` and the GM panel):
`REST_SAVE_PROMPT`, `REST_SAVING`, `REST_TITLE_PROMPT`.

Phases rather than a transient overlay: a phase survives an F5 mid-ceremony, syncs every client
through one `updateSetting`, and drops into the GM panel's step controls for free.

**New setting** `campSaveChoice` — `{ asked, save, slotId, ok, label, error }`. Drives the spectator
result line and the title panel's caution.

**New message** `CAMP_REST_FOCUS` (primary GM → all) — cursor mirror only. Phase changes and
`campSaveChoice` carry the actual state.

**New files**
- `camp-ui-rest-save.js` — the three panels, GM-interactive vs mirrored, keyboard (←/→, Enter, ESC =
  No), spectator progress animation matching the save system's own 3.2 s curve.
- `camp-rest-save-flow.js` — primary-GM orchestration: prompts → slot picker → result → title.

**Touched:** `camp-constants.js`, `camp-state.js`, `camp-socket.js`, `camp-bootstrap.js`,
`camp-ui-sleep.js`, `camp-ui-gm-panel.js`, `rest-api.js`, `save-extractors.js`, `save-ui.js`,
`module.json`. No change to `save-core.js` or `save-storage.js`, and no title-screen file was touched.

## 7. Edge cases handled

- **Save refused up front** (`Core.blockedReason("save")` — poisoned client, load in flight): the
  YES is greyed with the reason instead of letting the GM pick a slot and hit a wall.
- **Save fails**: the save system shows its own error and stays open to retry; backing out records
  `not written` and the title panel warns. A failed save never auto-advances into a return-to-title —
  that is the one path that loses a session.
- **F5 mid-ceremony**: the phase is world state, so the client rejoins into the same beat; on the GM
  the slot picker reopens.
- **GM steps phases by hand**: entering a prompt beat, or leaving the ceremony, closes any stray save
  overlay first (clearing the hook so the close is not misread as an exit). Without it a manual
  Prev/Next strands the table on a black screen behind a dead overlay.
- **Double answer** (click + keypress in one tick): the panel locks itself on answer and the flow
  holds a `_busy` re-entrancy guard.
- **Spectator clients** get `pointer-events: none` on the panel body, so the mirrored cursor cannot
  be touched.

## 8. Test plan — NOT YET RUN

Done offline:
- `node --check` on all 11 edited/added scripts, and `JSON.parse` on `module.json`.
- `landing-phase-check.js` (scratchpad): `landingPhaseFor()` over every phase including unknown and
  `undefined`, the transient-map blanking, exploration debuffs surviving, `free_roam` passing
  through untouched, and the `getSaveChoice()` default shape. All pass. **Caveat:** it exercises the
  real `camp-constants.js`/`camp-state.js` but *replicates* the extractor's few lines rather than
  loading `save-extractors.js` (which needs the full Foundry surface) — so it proves the rule, not
  the wiring of that one call site.

Still required, live, 2 clients (CDP dual-client rig):
1. Rest → save panel appears black-screened on both; the GM's cursor moves on the player's screen.
2. `NO` → title panel shows the not-saved caution → `NO` → lands in `SET_OUT_LOBBY`, screen fades in.
3. `YES` → slot picker → overwrite an occupied slot → progress mirrors on the spectator → success.
4. Title `YES` → both clients land on the title scene, menu open, camp overlay gone, and the camp
   BGM does **not** resume ~35 s later.
5. Load that slot from the title lobby → camp scene, `SET_OUT_LOBBY`, clean ready dots, Set Out
   works, **no second jingle and no second resource restore**.
6. F5 the GM mid-ceremony → rejoins into the same beat.
7. Force a save failure (break one extractor temporarily) → error panel, retry works, no silent
   pass-through to title.
8. Confirm with two GM clients that the rest runs **once** (trap #2 above).
9. `preflight` + `skill-regression --teardown` before any push. No world objects move — module code
   only — so the world-export procedure is not triggered by this branch.

## 9. Out of scope

- What a save *contains* or how it applies (extractors, diff-apply, storage).
- Mid-session / quick save from anywhere but the Rest sequence; autosave.
- Save points as physical objects in dungeon/exploration scenes — a natural sequel, since only the
  entry trigger differs from the flow built here.
