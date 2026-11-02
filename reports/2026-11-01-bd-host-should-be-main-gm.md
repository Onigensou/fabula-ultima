---
id: 2026-11-01-bd-host-should-be-main-gm
title: A battle can run on an assistant GM's client while the main GM is online
status: fixed
severity: major
reporter: onigensou
assignee: sarunphat
component: battle-director/host
introduced_in:
fixed_in: dd8b9599
---

## Symptom

The host's rule for this project: **GM is the main GM, every other GM is an assistant.**
Two GMs in the game at once is normal.

In the real session of 2026-10-31, at the end of the Vastwind battle (~22:47), the victory
prompt appeared on GM II's client instead of the host's. GM II confirmed it, and the battle ended
normally. Read over the debug port just before that, the host's client had no director:
`status().running` false, `history()` empty, `activeGM` = GM. The host didn't know a prompt was
waiting, and couldn't act on the battle from their own client.

## What the code does

`6666ed0c` (one explicit host) fixed the two-directors bug. That part is good. This report is
about the choice of host, which that commit deliberately leaves open:

- `director-host.js:6-8` documents that "a Co-DM can host". The host is whichever GM client called
  `start()`.
- `director-boot.js:216` `start()` only checks `game.user.isGM`.
- `dp-random-battle.js:16-19`: a GM walking the turn takes the "GM-direct path", which runs
  locally, so a Random Battle tile can start on an assistant GM's client. The Battle Prompt and test
  tools can too.
- `claimHost()` has one caller, the auto-resume on `ready` (`director-boot.js:2040`). So when
  an assistant GM who hosts disconnects mid-battle, nothing takes over until a GM reloads. Reloading
  during play is not allowed. **Read from the code, not tested.**

The role order already gives the right answer: in the world, GM has role 4 and GM II role 3, and
`outranks()` and core's `activeGM` both pick GM.

## Not proven

How the Vastwind battle came to be on GM II. The likely path is GM II starting it (walking a tile or
pressing Start), but GM II's client logs weren't available. The session record is
`docs/investigations/player-reloads/sessions.json`.

## Suggested fix

Your system, your call. The shape we'd suggest:

1. **Start on the main GM.** When `start()` runs on a GM client that isn't the primary GM and the
   primary GM is online, send the payload to the primary GM and return, without mounting a director
   locally. An assistant GM alone in the game still hosts, as now.
2. **Take over without a reload.** When the hosting GM disconnects, the highest-ranked GM still
   online claims the saved battle in place (`findSavedDirectorState` + `claimHost`).
3. **Leave the existing tie-break and refusal logic as they are.**

`start()` returns a director to its callers, and `dp-random-battle.js:796` reads that as success or
refusal, so a forwarded start needs a defined return value.

## Repro

1. Log in as GM and GM II (two clients).
2. On GM II's client, start any battle (`battleDirector.start({ payload })`, a Random Battle tile
   or the Battle Prompt).
3. On GM's client: `battleDirector.host()` reports GM II and `status().running` is false.
   End-of-battle prompts appear on GM II.

## Notes

- 2026-11-01 onigensou: a local helper now shows who hosts in its `status` output, so the host finds
  out straight away during play. That only reports the problem; it doesn't fix it.
- 2026-11-03 sarunphat: fixed in dd8b9599 (v1.0.513), your suggested shape. (1) An assistant GM's
  `start()` goes to the main GM's client (socketlib `executeAsUser`) when that GM is online and
  mounts nothing locally; it returns `{ forwarded: true, hostUserId, hostName }`, which
  `dp-random-battle` reads as launched (a refusal there returns null). If the main GM cannot be
  reached at all (still loading) the start runs locally as before; if it does not answer in 30 s,
  nothing starts and the GM is told, so two directors cannot result. (2) When the hosting GM
  disconnects and is not back within 15 s, the highest-ranked GM still online claims the saved
  battle in place (`findSavedDirectorState` + `claimHost` + `resumeFromSavedState`). A host that only
  reloads reconnects inside the window and resumes on its own `ready`, as now. (3) Tie-break and
  refusals untouched; `start({ local: true })` opts out (the sim runner uses it).
  Tested on the Battle Lab, two real GM clients: GM II's start returned forwarded, GM hosted
  (`status().running` true, `host().amHost` true), GM II did not; closing GM's page made GM II host
  the same battle ~19 s later; GM II alone in the game still hosts locally.
  Script: tools/battle-lab/host-test.mjs (local). Please verify.
