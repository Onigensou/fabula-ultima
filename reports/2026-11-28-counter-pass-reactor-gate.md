# Counter Pass picked by the enemy autopilot — fix report (2026-11-28)

For: sarunphat (owner of the free-action autopilot path, 2f742f11)

## What happened at the table
Asura missed Blanche → Counter Pass granted its free Pase → log
`autopilot: Blanche free action → Skill "Muleta" [grant "Counter Pass"]`.
Blanche never got her menu, and it was always Muleta.

## Cause
DECLARE's autopilot gate was `isAutopilotEnabled() && isAiControlledTurn(director)`
(state-handlers.js ~3405, and the mid-turn takeover ~3614). `isAiControlledTurn` asks about
the CURRENT combatant (Asura = AI), but a free action is declared by the REACTOR (Blanche,
player-owned). The autopilot then ran `decideFreeActionBundle` → `pickNamedGrantItem`, which
takes the first legal + affordable allow-listed item in sheet order = Muleta.
The Counter Pass data was fine: the allow-list already holds all six Pases.

## Fix (branch fix/counter-pass-reactor-gate, af84c236)
- `enemy-autopilot.js`: new `isAiControlledDeclarer(director, snap, grant?)`. If a free-action grant is
  live for `snap.actorId`, it answers for snap's own combatant (matched like
  `isAutomatedSummonTurn`: token uuid → token id → actor uuid). With no grant, or no roster match, it
  returns `isAiControlledTurn(director)` unchanged. SimMode is still always AI.
- `state-handlers.js`: both gates call it. The summon half of the condition is untouched.
- Downstream needed nothing: `freeActionPerformerIsMachine` already keys off the declaration.

## Side effect (intended)
The mirror case is fixed too. An ENEMY free action granted on a PC's turn (or at conflict_start,
where `currentCombatantId` is null) used to open the GM's manual compose menu. It now runs on autopilot.

## Verified
- `reactor-declarer-gate.test.mjs`: 10 pass (PC reactor on an enemy turn → player; enemy reactor on a PC turn → AI;
  no grant / own turn unchanged; roster fallback; registry path; sim).
- BD suite 71/73. The 2 failures (crisis-keywords, impact-offsets) fail on base too.
- Snapshot runner `snap-trio` with `--code af84c236`, real actors: old gate on Asura's turn = AI, new gate for
  Blanche's grant = player, no grant = AI, Asura reactor on Blanche's turn = AI. Blanche's Counter Pass menu
  lists all 6 owned Pases (Capote, Castigo, Descabello, Muleta, Tafallera, Verónica).
- Not yet seen: a real human-clicked Counter Pass at the table.
