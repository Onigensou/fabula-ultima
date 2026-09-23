# Area Name Panel

A wooden plaque slides in from the top-left when a scene is **activated**, reads
`◈ <Area Name>`, holds 4s, and withdraws the way it came — the JRPG
establishing-shot beat.

Shipped on `feat/area-name-panel`, module `1.0.425`.

| File | Role |
|---|---|
| `scripts/area-panel/area-panel-core.js` | Pure gate + every tuning constant. No DOM, no Foundry globals. |
| `scripts/area-panel/area-panel.js` | CSS, DOM, WAAPI animation, hook wiring, debug API. |
| `scripts/area-panel/area-panel-core.test.mjs` | `node scripts/area-panel/area-panel-core.test.mjs` — 49 assertions. |
| `scripts/custom-ui/dungeon-configuration-ui.js` | The three Scene Config rows. |

## Authoring

Scene Config → **Fabula Configuration → General → Area Name Panel**:

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
| `suppressed-scene-mode` | `sceneMode === "title"`; the title overlay owns the screen |
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

Warm wood and parchment, on the camp system's theme tokens
(`scripts/camp-system/camp-styles.js`) with literal fallbacks, since that file
injects them and load order is not guaranteed. Dark `--camp-wood-3` frame, gold
spine carrying the glyph, parchment body, ink text.

The glyph lives on the **spine only**. `cleanName()` is what the plaque prints;
`formatLabel()` adds the glyph and exists for text surfaces (a log line, a chat
card). Printing both is the bug the first live screenshot caught.

`z-index: 62` — above Foundry chrome (`#interface` is 30) and the Main Controller
badge (61), below the curtain. The panel anchors below `#ui-top` and right of
`#ui-left` at show time, and pushes below any module HUD already in that corner.

## Tuning

Every number is in `TUNING` in the core file, so a re-tune is a constant change.
Current feel: 900ms in (ease-out quad), 4000ms hold, 800ms out (ease-in quad),
56px of travel. Measured live at 5.6s on screen, end to end.

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

Not exercised live: the `title` scene-mode suppression (offline only — activating
the title scene starts the title screen's own flow).
