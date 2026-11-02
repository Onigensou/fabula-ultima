---
id: 2026-11-03-study-card-handoff-v1-0-512
title: Hand-off for v1.0.512 — Study results now use your Battle Inspect card, and what that changed in your code
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: process/merge-handoff
introduced_in:
fixed_in:
---

# Not a bug — a hand-off note for the code you just pulled

Written for sarunphat, and for the Claude session that ran the pull. Nothing here is broken that needs an
urgent fix. Please read it, look at the three data questions at the end, then set `status: verified`.

## What this pull is

Code only: no world data, so your world isn't rewritten. Reload to pick it up. It sits on top of your v1.0.511.

Onigensou is moving player-facing screens off the default Foundry UI. They like your Alt+Click card and asked for
Study to use it, so Study no longer opens the Monster Encyclopedia journal for players. The journal is still the
only record and still the GM's tool.

Approved mockup: https://claude.ai/artifact/S3qYiJB3qMCP9MAa6DbMwb

## What changes for players

- After a Study, the Inspect card opens on every client and each newly learned tier lights up in turn.
- **The battle now waits on it.** RESOLVE holds until the studier or a GM presses Continue (or Z). Others can only
  close their own view. The wait also ends if the studier is gone (`watchGone`), from the GM desk (`trackWait`), when
  the director stops, or at a 60 s cap.
- The card's Bestiary button and the round banner's enemy icons open the Party Menu Bestiary on that monster, not the
  journal.

## What changed in your files

- `unit-inspect/inspect-render.js`, `inspect-model.js`, `unit-inspect.js`: the enemy card is reworked: rank crest and
  frame, turn pips, DEF / M.DEF badges beside HP and MP, attribute icons, weapon gauges, status rows, full action text
  with cost chips grouped by type, effect-row hover text. **The card is now 572 tall (was 528), and Onigensou does not
  want it taller.** New content has to fit by tightening. The ally card keeps its layout but shares the height.
- `unit-inspect.js`: a Study result ignores the "battle moved" closes (`fu-battle-phase`, `fu-director-action`,
  surface changes), because the battle is waiting on it. Alt+Click behaves as before.
- `party-menu-view-bestiary.js`: tiles show the rank crest, and Sword and Dagger have separate icons.
- `encyclopedia-core.js`, `getEntryData`:
  - new `asBest` option, and `identity.turns`
  - rows for one item are merged, and the item's text beats the list row's copy
  - `Generic NPC…` placeholder rows are hidden
  - a stored weapon value of 0 now reads 100%, matching `readWeaponEfficiency`
- `keyword-tooltip.js`: a hover form of your panel (`showKeywordHover`).
- `state-handlers.js`: the Study branch of RESOLVE calls `runStudyReveal` (new file `unit-inspect/study-reveal.js`).
  An enemy studying the party, and sim or harness runs, keep the old path.

## Tested, and not tested

Sandbox with a GM and a player client: the Study flow, Continue from each side, a non-owner's close, the 60 s cap,
Bestiary jump, effect hover, gauge fill, and all 51 Encyclopedia monsters fitting the card. skill-regression compute
is clean.

Not tested: a real network, Forge hosting, a studier dropping mid-reveal, the GM desk's Continue action, and the card's
fit when the desk sits high.

## Three data questions, your call

1. **Malflorus's `npc_rank` is `cha`.** `readRank` (`director-combat.js`) and `enemyRankOf` (`exp-core.js`) only accept
   full names, so combat and EXP treat them as a Soldier. The card reads the prefix and shows Champion.
2. **Turn counts look uneven.** Seven Champions have `activation` 1, and six NPCs have 0. Players now see these as pips
   (hidden below 1). Five Elites at 4 (Asura, Carlbero, Roper, Rakshasa, Galvanic Paryashera) may be intended.
3. **The Bestiary Profile's description looked clipped to one line** in the sandbox. This work didn't touch it and nobody
   has looked into it.

## Notes
