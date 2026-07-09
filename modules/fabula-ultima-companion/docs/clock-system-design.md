# Clock System — design

Automates Fabula Ultima Clocks (core rulebook pp. 52–55) as a reusable API.
The bundled UI is optional; the engine has no idea it exists.

Status: **v1 complete.** 212 headless assertions plus ~150 run against a live
Foundry client, including a two-client (GM + player) test of the panel-click
roll. Engine, rendering, resolution, groups, lifecycle sweeps, the Battle
Director bridge, the GM button column, and the Check Requester wiring are all
exercised live.

### Bugs the headless suite could not have caught

Every one was found by running the thing, and each is now pinned by a test.

1. `makeClock` required an `id`, but the id is assigned by the store on create —
   so `api.create(api.preset.threat({name}))`, the usage in this very document,
   threw. Every headless test passed an explicit `id`, the way a *test* does and
   a caller never would. The tell was in the code: the manager window had to
   pass `id: "pending"` and then `delete spec.id`.
2. The presets spread `...spec` **before** their own `poles` key, so a caller who
   passed `poles` had it silently discarded and got a generic banner. Found by
   reading the demo's chat card, not by any assertion.
3. Backticks inside CSS comments in a JS template literal killed four modules at
   import. `node --check` passed them — it parses the CommonJS *script* goal,
   while Foundry loads ES *modules*. See `tools/check-esm.js`.
4. `paint-order` on HTML text is honoured only from Chromium 128. The desktop
   app (Electron 29 / Chromium 122) parses it — `CSS.supports` answers `true` —
   and paints the stroke over the fill. Same CSS, two renderings.
5. The Check Requester is **GM-orchestrated**: `interactiveRequest` throws on a
   non-GM client. A player's panel click had to become a request to the GM.

The first two share a shape worth remembering: the engine was correct, and the
*seam between the engine and its callers* was not. Tests written from inside a
module cannot see that seam.

---

## 1. The model: one axis, two poles

A Clock is a bounded integer axis, `0 .. sections`, with a **pole** at each end.
A pole may be **claimed** by a side, and carries what reaching it means *for the
players*. An unclaimed pole **clamps**: the value stops there and nothing
resolves.

**A side pushes toward the pole it owns.** That single rule collapses every
clock shape in the book into one structure — "the GM fills a threat clock" and
"the players empty a teardown clock" are the same operation with different pole
ownership.

| Shape | `sections` | starts at | high pole | low pole |
|---|---|---|---|---|
| progress | 6 | 0 | players / success | — |
| threat | 4 | 0 | gm / failure | — |
| teardown | 6 | 6 | — | players / success |
| struggle | 8 | 4 (centered) | players / success | gm / failure |

`preset.progress()`, `preset.threat()`, `preset.teardown()`, `preset.struggle()`
are sugar over `makeClock` — the engine treats none of them specially.

There are exactly **two sides** (`players`, `gm`). In fiction a scene may have
three factions; mechanically everything reduces to what the players want and
what the GM wants. A third interest gets its own clock.

### Which side advances on a check

Never asked, always derived: **the side whose pole's outcome matches the check
result.** A pass advances toward a `success` pole, a miss toward a `failure`
pole.

- progress clock → takes your successes, ignores your failures
- threat clock → takes your failures, ignores your successes
- struggle clock → takes both, and is therefore **bidirectional from a single
  call**: a pass drives the players' pole, a miss drives the GM's

This is why there is no per-shape branching anywhere in the code, and why a
`paired` group needs no special case at all (§3).

---

## 2. Advancement rules (RAW p.53)

Implemented in `clock-check.js`, pure:

- **1 section** for a check that goes the clock's way.
- **+1** if the margin was 3+; **+2 instead** if it was 6+. Tiered, never
  scaled — a margin of 20 is still +2.
- **+2** for a critical (on a success) or a fumble (on a failure), *only* when
  the caller opts in via `spendOpportunity`. RAW says the opportunity "may be
  spent"; it is a player resource and the engine never spends it silently.

Opposed checks: strictly greater wins, a tie is a failure with margin 0.

`previewCheck` is the same math without the write. That is the whole reason the
model is pure: an action card can honestly promise *"this would fill 2
sections"* before the dice commit.

---

## 3. Groups

`group: { id, mode, role }`.

- **`independent`** — grouped for display only.
- **`race`** — first sibling to resolve wins; the losers are discarded **in the
  same write**, so no client ever renders a frame with two winners. (RAW: the
  Bertrand vs. Duma duel.)
- **`paired`** — RAW "A Threshold For Failure" (p.54). One `applyCheck` is handed
  to *every* member of the group, and each one's poles decide whether it takes
  the result. A passed check advances the success clock; a failed one advances
  the parallel failure clock. No branching, no roles consulted at runtime.

---

## 4. Persistence and lifecycle

The registry is **one world setting**, `clockRegistry`, shaped `{ [id]: Clock }`.
World scope buys two things:

- **Reconnect survival.** A player who drops mid-scene re-reads live state on
  `ready`. No replay, no resync handshake.
- **Broadcast.** Foundry fires `updateSetting` on every client, so all clients
  converge without a socket of our own.

Change events are derived by **diffing** the previous registry snapshot against
the new one, not pushed alongside the write. A client that reloads, joins late,
or misses a packet still emits correct events from the setting alone, and the
writer runs the same code path as the observers.

Reconnect survival and session persistence are different axes. The setting gives
the first for free; `lifecycle` stops the second becoming a cleanup burden:

| `lifecycle` | swept when | wired to |
|---|---|---|
| `manual` | never (GM discards by hand) | — |
| `combat` | the Battle Director stops | `fu-director-stopped` hook |
| `scene` | you leave the owning scene | `canvasReady` hook |

A `scene` clock records its `sceneId` at creation — without it a sweep can't tell
"clock from the room we left" from "clock created for the room we entered", and
would discard both.

Per-clock `history` is capped at 50 entries. The world is near its payload
ceiling; the whole registry stays in the tens of KB.

---

## 5. Who may write

Only the **active GM** writes the registry (with two GMs connected, exactly one
must own the write or every advance lands twice — `isActiveGM()`, the same guard
`healing-socket.js` uses).

`dispatch(op, payload)` applies directly on the active GM and relays over a raw
socket from anywhere else, so the API is symmetric and **callers never branch on
`game.user.isGM`**. Ops live in a fixed table, so a payload cannot name an
arbitrary store export. The player allowlist is exactly `{advance, applyCheck}`;
everything else is refused **at the GM's end**, not hidden on the client.

Reads and `previewCheck` are ungated and never touch the socket.

> **`visibility: "gm"` is not a security boundary.** It hides a clock from the
> bundled UI, but the registry is a world setting, so any client can read every
> clock from the console. Don't put information in a clock's name that a player
> must not have. Making it real means a second, GM-only setting — worth doing if
> hidden clocks ever carry secrets.

---

## 6. The decoupling seam

The API never imports a renderer, and no renderer is required for the engine to
work. The bundled UI will be nothing but the first subscriber to:

```js
Hooks.on("fu-clock-created",   ({ clock }) => …);
Hooks.on("fu-clock-changed",   ({ clock, previous, delta, cause, side }) => …);
Hooks.on("fu-clock-resolved",  ({ clock, resolution }) => …);
Hooks.on("fu-clock-discarded", ({ clock, destroyed }) => …);
```

A downstream system that wants its own clock rendering disables ours and listens
to the same hooks. The decoupling is enforced by direction of dependency, not by
convention.

---

## 7. Files

| File | Purpose | Pure? |
|---|---|---|
| `clock-const.js` | enums, hook names, RAW thresholds | yes |
| `clock-model.js` | schema, advance/resolve math, presets, `notchOwnerAt` | yes |
| `clock-check.js` | RAW check rules, `previewCheck` | yes |
| `clock-store.js` | world-setting registry, writer gate, diff emission | no |
| `clock-socket.js` | GM-mediated mutation | no |
| `clock-api.js` | public surface + bootstrap | no |
| `clock-ui-styles.js` | injected CSS, `CLOCK_TUNE`, SFX | no |
| `clock-ui-bar.js` | the segmented gauge (a consumer) | no |
| `clock-ui-resolve.js` | resolution flourish + chat card | no |
| `clock-manager-app.js` | GM manager window (a consumer) | no |
| `clock-automation.js` | `fu-director-trigger` subscriber, rule matcher | no |

`module.json` lists the four entry points — `clock-api.js` first, then
`clock-ui-bar.js`, `clock-manager-app.js`, `clock-automation.js` — so the engine
boots before its consumers. Everything else is pulled in by import.

> **Adding a NEW file to `esmodules` needs a world relaunch, not an F5.** The
> Foundry *server* reads `module.json` when the world launches and hands the
> client that list; a browser reload re-runs the same four scripts. Symptom: your
> new file's `Hooks.once("ready")` never fires and `game.modules.get(id).esmodules`
> doesn't contain it. Editing an *existing* esmodule is fine with a reload.

### Tuning

Layout and choreography live in `CLOCK_TUNE` (`clock-ui-styles.js`), applied as
CSS custom properties so they can be dialled in live and then baked into the
defaults:

| | |
|---|---|
| Layout | `layerTop`, `layerGap`, `panelWidth`, `panelHeight`, `barHeight` |
| Type | `nameSize`, `pctSize`, `gearSize` |
| Spawn (3 beats) | `gearInMs` → `panelInMs` → `barFillMs` |
| Live change | `advanceMs` |
| Finality | `holdMs` (5000) |
| Exit | `outMs`, `reflowMs` |

---

## 8. Tests

Run in bare Node — no Foundry, no browser, no world. Keeping the model pure is
what makes this possible, and these harnesses are what keep it pure.

```
node scripts/clock-system/clock-model.test.mjs       # 78 assertions
node scripts/clock-system/clock-check.test.mjs       # 58 assertions
node scripts/clock-system/clock-automation.test.mjs  # 24 assertions
node scripts/clock-system/clock-socket.test.mjs      # 11 assertions
```

The load-bearing cases are the pole-ownership ones ("players push a teardown
clock DOWN", "an unclaimed pole clamps and never resolves") and the rulebook's
own worked example: Valea rolls a 6 against DL 10, and the GM fills two sections
of "Ambushed!" — one for the failure, one for missing by three or more.

---

## 9. Usage

```js
const api = FUCompanion.api.clocks;

// A danger closing in. Fills as the players fail.
const clock = await api.create(api.preset.threat({ name: "Ambushed!" }));

// Valea rolls a 6 against DL 10 → two sections (RAW p.53).
await api.applyCheck(clock.id, { result: 6, difficulty: 10, cause: "Sneaking" });

// What would a 14 have done? No write, any client, no GM needed.
api.previewCheck(clock.id, { result: 14, difficulty: 10 });

// RAW "Other Events": fill one section, or two for a major event.
await api.event(clock.id, { side: api.SIDE.GM, major: true });

// RAW "Turning Back a Clock".
await api.turnBack(clock.id, { side: api.SIDE.GM, sections: 1 });

// A ritual the party races to disrupt, with a parallel failure clock (p.54).
const g = { id: "ritual", mode: api.GROUP_MODE.PAIRED };
await api.create(api.preset.progress({ name: "Ritual Disrupted", sections: 6,
  group: { ...g, role: "primary" } }));
const rift = await api.create(api.preset.threat({ name: "The Rift Opens", sections: 4,
  group: { ...g, role: "failure" }, lifecycle: api.LIFECYCLE.COMBAT }));

// One check, both clocks: a pass fills the ritual, a miss fills the rift.
await api.applyCheck(rift.id, { result: 8, difficulty: 10, isFumble: false });
```

---

## 10. The UI

A warm parchment plate docked to the **top right**, hanging off
`--fu-sidebar-anchor-right` so the stack tracks the chat sidebar frame-by-frame
as it expands and collapses. (That var is republished by a `ResizeObserver` in
`custom-ui/sidebar-anchor.js`; Foundry's own `collapseSidebar` hook fires only
*after* the width animation finishes, which would snap rather than track.)

```
  [ Ambushed! ]                 ← floating name tab, overhangs the panel
  ┌───────────────────────┐  ⚙  ← brass gear, right of the panel
  │ ████████░░░░░░░  50%  │
  └───────────────────────┘
```

**One continuous fill bar, not discrete notches**, reading a whole percentage
**rounded up**. The user chose legibility over literalism, and rounding up is
what makes it honest: any progress at all shows above 0%, and only a truly full
clock reads 100%. Sections still govern everything underneath — the bar is a
view of `value / sections`.

**The glow says what kind of clock it is** — `clockTone` (§1): red threat, blue
progress, blue→red gradient for a two-poled contest. Derived from the poles, so
it can't disagree with how the clock behaves. A teardown clock reads as
`progress`: its pole is a player success, and counting down is a rendering
detail.

**Choreography.** Spawn is three beats — the gear fades in, the panel slides in
from the right, then the bar fills to its starting value. Resolution flares the
panel, turns the gear, holds **five seconds**, then exits. Exit is one beat:
everything slides and fades together. When a clock leaves, the survivors FLIP
upward, so the stack always reforms toward the top.

`clockTone` and `clockPercent` live in the pure model beside `notchOwnerAt`, so
the tones and the rounding rule are tested rather than eyeballed.

Turn it off with the client setting **"Show the clock bar"**. Resolution chat
cards stay wired regardless, and self-gate to the active GM so a six-client
table sees one card. The card carries **no speaker** — a clock has no voice — and
hides Foundry's message header via `:has(.oni-clock-card)`.

**GM manager**: the clock button in the right-edge column, or
`FUCompanion.api.clocks.manager.open()`.

---

## 11. Automation

A clock's `automation` array is data:

```js
automation: [
  { trigger: "creature_defeated", subject: "enemy", side: "players", sections: 1 },
  { trigger: "round_end",         side: "gm", sections: 1, cause: "the ritual advances" },
  { trigger: "creature_fumbles_check", side: "gm", sections: 2, once: true },
]
```

Filters: `trigger`, `subject` (`player`/`enemy`/`any`), `skill` (name match),
`once`, and `condition`. `mode: "check"` re-uses the RAW advancement rules when
the payload carries a check, so the sections come from the margin.

Events arrive on `fu-director-trigger`. **Conditions are a named-predicate
registry, not a formula language** — BD already has one, and a second dialect to
keep in sync would be a liability:

```js
FUCompanion.api.clocks.automation.registerCondition(
  "bossIsBloodied", ({ casterActor }) => hpFraction(casterActor) < 0.5);
```

An unknown or throwing condition **rejects the row** rather than passing it.

### The Battle Director edit

`firePassiveTriggers` now re-broadcasts every trigger as a plain
`fu-director-trigger` hook. Additive: it changes no dispatch, consumes no
result, cannot influence resolution, and is wrapped so a subscriber that throws
cannot break combat.

It fires **before** the token guard, deliberately — a reaction menu needs a token
to anchor to, but an observer does not, and dropping the event for a tokenless
actor would be a silent gap.

That is the entire BD footprint of this feature. Before it, BD's 26 triggers
went only to reaction rows: no subsystem could observe combat events at all.

---

## 12. Verified live

- [x] the bar renders, docks to the sidebar, and reforms upward on removal
- [x] each shape renders its documented colour; the clash band tracks `value`
- [x] resolution: flare, 5s hold, exit, exactly ONE chat card
- [x] `combat` clocks vanish when the director stops; `scene` clocks survive
      their own `canvasReady` and die when you leave
- [x] an automation row fires once per trigger, not once per GM
- [x] the BD trigger bridge fires even for a tokenless actor
- [x] GM panel clicks adjust the axis; a resolved clock ignores clicks
- [x] a player's panel click opens the Requester on THEIR client and moves the
      clock on confirm (tested GM + player, two clients)
- [x] the Progress opportunity effect lists Clock System clocks first

Not yet exercised: a **two-GM table** (every `isActiveGM()` guard is right by
inspection but has never had a second GM to contend with), and `race` /`paired`
groups in a real session rather than a scripted one.

`CLOCK_TUNE` is where the visual dialling-in happens.

---

## 13. Deferred, with reasons

- **Predictive preview on the action card.** `previewCheck` exists and is pure;
  wiring it into BD's pre-resolve pill mechanism is separate work and should not
  sit on the critical path to a working clock.
- **Retiring `global-progress-clocks`.** The Progress opportunity effect now
  lists Clock System clocks *first* and keeps the legacy module's clocks under a
  "(legacy)" group, rather than ripping them out from under a live world. Once
  no authored clock lives there, delete the branch and the module.
- **Outcome scripts on a pole.** Letting a pole spawn an actor or end a combat
  turns clocks into a scene-scripting primitive. The clean version is a pole
  emitting `fu-clock-resolved` and letting `event-system` own the response —
  which it already can.
- **Sides beyond two.** See §1.
- **Actor-resource clocks.** The CSB `clock_*` fields are legacy; not wired.
