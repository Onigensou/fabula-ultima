# Area Name Panel

A wooden plaque slides in from the top-left when a scene is **activated**, reads
`◈ <Area Name>`, holds 4s, and withdraws the way it came — the JRPG
establishing-shot beat.

Shipped on `feat/area-name-panel`, module `1.0.425`.

| File | Role |
|---|---|
| `scripts/area-panel/area-panel-core.js` | Pure gate + every tuning constant. No DOM, no Foundry globals. |
| `scripts/area-panel/area-panel.js` | CSS, DOM, WAAPI animation, hook wiring, debug API. |
| `scripts/area-panel/area-panel-tuner.js` | The live tuning window (GM only). |
| `scripts/area-panel/area-panel-core.test.mjs` | `node scripts/area-panel/area-panel-core.test.mjs` — 49 assertions. |
| `scripts/custom-ui/dungeon-configuration-ui.js` | The three Scene Config rows. |

## Authoring

Scene Config → **Fabula Configuration → General → Area Name Panel**. The whole
block is **hidden on Conflict and Gacha scenes** — a fight and a pull screen are
not places the party walks into. Hidden, not removed, so a stored value still
round-trips through a save made in another mode; the runtime gate refuses those
modes as well, so a scene switched to Conflict after a name was typed goes quiet
on its own.

- **Area Name** — what the plaque prints. Blank means no panel, whatever the
  switches say. Names need not be unique; that is the point of the suppression
  rule below.
- **Show Area Panel** — per-scene gate. **Unset counts as ON**, so typing a name
  is all it takes. Every pre-existing scene stays silent because none of them
  carries a name.
- **Always Show** — default off. Opts the scene out of repeat suppression.

Stored at `scene.flags["fabula-ultima-companion"].oniFabula.general.{areaName,
areaPanelEnabled, areaPanelAlwaysShow}`. The keys are declared in both
`area-panel-core.js` and `dungeon-configuration-ui.js` — keep the two in step.

## The gate

`shouldShowForScene(scene, { lastAreaName })` answers everything and reports
`reason` for the debug API:

| reason | when |
|---|---|
| `no-name` | blank or whitespace-only area name — also every legacy scene |
| `disabled` | Show Area Panel unticked |
| `suppressed-scene-mode` | `title` (its overlay owns the screen), `conflict`, `gacha` |
| `repeat` | same area as the last one announced, and Always Show is off |
| `ok` / `always-show` | it plays |

**Repeat suppression** is per client and keyed on the last area *announced*, held
in `sessionStorage` so an F5 mid-session does not re-announce. A scene with no
area name does **not** clear the memory: ducking into an unnamed battle arena and
coming back out is still the same castle. Going somewhere else and returning does
announce again.

## Trigger and sequencing

Activation is `updateScene` with `changes.active === true`, and nothing else. A
scene *switch* fires `canvasReady` without that flag and is deliberately silent,
as is an F5 on an already-active scene.

Every client reads the scene update itself — no socket, no GM host election,
nothing to de-duplicate.

Playing on the raw update would animate the plaque **behind** the
screen-transition curtain (`scripts/screen-transition/screen-transition.js`,
z 99999). So an activation *arms*, and the panel plays on whichever of these
arrives first:

- `oni:screenRevealed` + `DELAY_AFTER_REVEAL_MS` — the normal path. That hook
  fires on both the animated reveal and the `disableTransition` snap.
- `SETTLE_MS` with no `canvasTearDown` seen — the GM activating the scene already
  on screen, where no redraw happens at all. Measured live: plays at ~700ms.
- `WATCHDOG_MS` — last resort, and it drops the arm if this client never ended up
  on that scene.

A second activation cancels the first: one arm, one plaque, last name wins.

**A hidden client holds the panel.** `document.hidden` is true for a player
alt-tabbed to Discord or sitting behind the GM's window; such a tab paints
nothing and throttles its timers. Those clients park the panel and play it on
`visibilitychange`, provided they return within `DEFER_MAX_MS` and are still on
that scene. The first pass skipped them instead, which swallowed the panel
permanently — the area was already recorded, so it never came back.

## Look

One rounded rectangle, **welded to the left edge of the screen**: `left` is
`-OVERSHOOT_PX`, so the left corners are always off-frame and only the right ones
are ever seen. The left padding adds the overshoot back so the text is not
crowded against the edge. Warm cream parchment body, `--camp-wood-3` frame, brown
letterspaced text — the camp system's theme tokens
(`scripts/camp-system/camp-styles.js`) with literal fallbacks, since that file
injects them and load order is not guaranteed.

The glyph is part of the printed line (`◈ Area`), which is what `formatLabel()`
returns; `cleanName()` is the bare name. An early build drew the glyph on a gold
spine **and** prepended it, and the first live screenshot read `◈ ◈ Eisendrache
Kingdom` — hence the split, pinned in the test.

`z-index: 62` — above Foundry chrome (`#interface` is 30) and the Main Controller
badge (61), below the curtain. It is `pointer-events: none`, which matters
because an edge-attached plaque crosses the GM's left tool column for its few
seconds on screen; clicks pass straight through. Vertically it anchors below
`#ui-top` and below any module HUD already in that corner.

## Tuning

Every number is in `TUNING` in the core file. Current feel: 1100ms in (ease-out
quad), 4000ms hold, 950ms out (ease-in quad), travelling its own full width
(`translateX(-100%)`) so a long name leaves from as far out as a short one.
Measured live at 6.0s on screen, end to end.

### The tuner

`scripts/area-panel/area-panel-tuner.js` — a draggable GM-only window that tunes
the plaque by eye against a real scene. Open it from **Scene Config → Area Name
Panel → Tune Appearance**, or `FUCompanion.api.areaPanel.tuner()`.

Knobs, in the order they appear: area-name size, diamond scale and gap, panel
scale, min width/height, padding X/Y, X/Y offset, outline thickness, corner
radius, and the three durations. `TUNABLE` in the core is the single source of
truth for the window AND for the exported snippet, so adding a knob is one entry
there plus one CSS variable.

Three states, deliberately distinct:

| | where it lives | who sees it |
|---|---|---|
| shipped defaults | `TUNING` in the code | everyone, absent an override |
| saved overrides | world setting `areaPanelTuning` | every client, across reloads |
| the draft | the open tuner window | only while it is open |

**Save** writes only the keys that differ from the shipped defaults — storing a
value that merely equals today's default would pin the world to it, so a later
change in code would silently never arrive. **Revert** goes back to what is
saved, **Defaults** to what is shipped (without saving), and **Copy constants**
gives the `TUNING` block to paste back into `area-panel-core.js` when a look is
settled and should stop living in world data. Closing the window discards the
draft.

**Hold** pins the plaque on screen while you drag; every look knob is a CSS
variable, so a drag repaints in place instead of re-running the slide. **Play**
drops the hold and runs the whole in/dwell/out cycle, which is the only way to
judge the timings.

At 30px type the plaque is about 69px tall — under the mockup's roughly
one-tenth of screen height, which is the first thing to try if it wants more
presence.

## Debug API

`FUCompanion.api.areaPanel`:

- `preview(name)` — play an arbitrary label now. **This is the tuning loop**: the
  panel deliberately does not replay on F5, so re-tuning without it means
  bouncing scenes.
- `previewScene(scene)` — play what a scene would show, ignoring suppression.
- `check(scene)` — the verdict, with its reason.
- `state()` — pending arm, held panel, hidden flag, remembered area.
- `lastArea()` / `resetLastArea()` — the suppression memory.
- `hide()`, `readConfig(scene)`, `TUNING`.

## Verified live (2026-09-23, GM + a real player client)

Activation from another scene; repeat suppressed; Always Show overriding it;
unnamed scene silent with the memory intact; Show Area Panel unticked silent;
activating the scene already on screen; rapid double activation (one plaque, last
name); F5 on an active scene silent; Scene Config rows render, prefill and save;
a backgrounded player holding the panel and playing it on return.

Re-verified after the edge-attached restyle: the plaque sliding in from off-frame
to rest at `left: -28px`, the 6.0s cycle, and the config block hiding on Conflict
and Gacha and coming back for Exploration / Dungeon / Camp.

Re-verified after the tuner landed: every knob moving the live plaque (size,
diamond scale including 0, padding, offsets, outline, radius, panel scale, min
height), a drag repainting WITHOUT restarting the slide, Save / Revert /
Defaults / Copy constants / close-discards-draft, the Scene Config button
opening it, and a real scene activation still playing `◈ Eisendrache Kingdom`
with the diamond printed exactly once.

⚠ Adding a file to `module.json` needs a full Foundry **restart** — the manifest
is parsed when the server starts, so a page reload alone kept reporting the old
module version and never loaded the tuner.

Not exercised live: the `title` scene-mode suppression (offline only — activating
the title scene starts the title screen's own flow).
