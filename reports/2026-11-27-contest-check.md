---
id: 2026-11-27-contest-check
title: Heads-up — Contest Check (Opposed Checks) API + HUD; touches cr-api, cr-sidebar-button, skill-effects contest_check, event rows
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: check-requester, battle-director/skill-effects, battle-director/template-field-registry, event-system
introduced_in: 02ab09b0
fixed_in:
---

Not a bug: a feature onigensou designed and approved over five mockup rounds on
2026-11-27 (https://claude.ai/artifact/Ui9f3pgddn3pkQuP6c16Th). It touches your
files in small, additive ways. Read-only for you unless something looks wrong. Close
it (`status: verified`) once you've had a look.

## What it is

A Fabula Ultima **Opposed Check** (core p.48): every side rolls a Check with no
Difficulty Level and the highest Result wins. A fumble is the lowest possible Result,
a critical the highest; two crits (or two fumbles) draw; a draw is repeated by the
sides that tied.

House rules onigensou set:
- The side that is **behind answers first** (invoke or accept); a change re-opens the
  window for everyone behind. Timeout = accept (25 s default).
- Ties reroll until there is a winner (no cap). A reroll is a new Check, so Trait and
  Bond open again.
- **Invoke Trait is once per Check** (as everywhere in the Check Requester).
- Conflict mode: the winner pushes a linked Clock 1 section, +1 at 3+, +2 at 6+;
  a win by crit (or against a fumble) counts as 6+.
- Each client hears its own result sting: own side → the party's result → winner.

## New files

| File | What |
|---|---|
| `check-requester/cr-contest-logic.js` | Pure rules, node-tested (`cr-contest-logic.test.mjs`, 38 tests). |
| `check-requester/cr-contest.js` | `ONI.Contest.request(opts)` (GM). The GM is the referee: rolls every die, spends points and charges, runs answer windows, rerolls ties, moves the Clock, posts the chat card, fires reactions + Opportunities. `mode: "silent"` = no HUD, no invokes, no Opportunity picker. |
| `check-requester/cr-contest-hud.js` | The HUD on every client. Plays the GM's ordered event stream through ONE queue; clicks become intents the GM validates (owner or GM). |
| `check-requester/cr-contest-setup.js` | The new **Contest** tab of the Request Check dialog. |
| `event-system/event-rows-contest.js` | **Run Contest** event row. |

Socket types on the module channel: `CT_EV` (GM → all), `CT_INTENT` (player → active GM).

## Changes to existing files

1. **`cr-api.js`**
   - **D4 (behaviour change):** an NPC (any actor with `npc_rank`) invokes a Trait with
     an **Ultima Point**, a PC with a Fabula Point (same rule as BD
     `invoke-core.getPointResource`). NPCs no longer get the Bond button. This applies to
     ordinary Skill Checks too.
   - `ONI.CheckRequester._internal` exposes the roll / invoke / reaction helpers the
     contest reuses (not a public API).
2. **`cr-sidebar-button.js`**: a third tab `data-mode="contest"`; the shared
   attribute / DL blocks get `data-mode-hide="contest"`; the confirm callback has a
   contest branch first; `openDialog` tags results `{ mode: "contest" }`; width 460 → 520.
3. **`skill-effects.js` `contest_check`**
   - New column **`contest_hud`** (registered in `template-field-registry.js`, so the
     boot sync adds the column): blank / `silent` = exactly the old path;
     `interactive` = one Contest HUD contest per target slot, the NPC performer rolling
     itself. Same outputs (`contest_lost/won_targets`) and failure direction.
   - New chain var **`VAR_CONTEST_MARGIN`** (`_chainVars.contest_margin`) in both modes:
     the performer's total minus the first target's on the deciding roll (negative when
     the performer lost). Harness override: `harnessNumbers.contest_margin`.
4. **`event-lint.js`**: a `runContest` case. **`event-kit.test.mjs`** loads the new row.
5. **`module.json`**: four check-requester scripts after `cr-group-check.js`, one event
   row after `event-rows-check.js` (a server restart picks them up).

## Tested

- `cr-contest-logic.test.mjs` 38/38; `cr-check-resolved.test.mjs` ALL PASS;
  `event-kit.test.mjs` all passed.
- Lab server (:30008, GM + 2 player clients, forced dice): roll intents from a player;
  answer window to the side behind; Trait FP 4→3; NPC Trait UP 3→2; Bond; draw →
  clash → round 2; fumble (Fabula Ledger +1 FP, tier 2); crit cut-in from
  `cut_in_critical` on a watching client; bench Divination by a watching player
  (charge 2→1); 3-way race placings; silent tie → crit win; Clock contest 4→7;
  Request Check dialog → contest; Run Contest row (branch + last-check memory);
  `contest_check` interactive (lost list, HR 6, margin 4).
- Visual check in a GPU window against the mockup (answer window, crit cut-in, win).

Not tested: a real BD battle with `contest_hud: "interactive"` on a monster action; a
second GM forwarding intents (intents go to `game.users.activeGM`).

## Things to know

- A contest's crit opens the Opportunity picker **after** the HUD closes and
  `request()` resolves only once it is chosen (same as `CR.request`). A silent contest
  never opens it.
- The interactive `contest_check` runs one contest per target slot, so the performer
  rolls once per target (the silent path rolls the performer once for all targets).
