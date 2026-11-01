# Session 2026-10-31 — the first full game session on the forge mirror

**Status:** done. This is the full session the case was waiting for.
**Window:** 2026-10-31 21:18 → 2026-11-01 02:28 (+07:00) · Foundry 12.343 · module at `5ddbab3a` (local `main`: v1.0.497
merged, plus local world commits).
**Who:** Rinri (route 124.122), Silryantish (27.130), Trinio (223.205), Blumairwen (27.145), GM II (122.155, a co-GM,
21:24–22:49), the host's GM app and Spectator window. All on for the whole session unless noted below.

**The value of this session:** on 10-24 two players reloaded 12 times each in 5½ hours. This is the same length of play
with every file coming from the host.

**Conditions:**
- **Mirror:** on. 3,160 files, 1,238 MB. The launcher's first sync copied 24 and downloaded 11 (41 MB); its second sync,
  after GM login, changed nothing.
- **Loading:** load indicator on; scene pre-fetch on.
- **Launch:** the session launcher, the first real run with its test-bridge and second-sync steps. Preflight 0 FAIL,
  358 WARN.
- **Stream:** Streamlabs running, Spectator window on the Cintiq.
- **Save:** slot 1, rebuilt for this session.
- **Watching:** from 22:36 a read-only watcher on the host's logs and counters. Its first version created about 9 stray
  Foundry client sessions in the server log by polling `/api/status` without a cookie (22:36–22:41); fixed then.
- **Host's restart:** Foundry and the Spectator were restarted at 23:17:35 on the host's order, because of game bugs
  reported that night. Preflight and sync were skipped. Every client reload at 23:18–23:20 is this restart.

**Host-side capture (raw data, not in git: full IPs):**
- `Logs/debug.2026-10-31.log`, `Logs/debug.2026-11-01.log`: the server log.
- `Data/client-health-logs/fabula-ultima-2_2026-10-31-14-19.json` and `..._2026-10-31-16-18.json`: one per GM boot.
- `save-backups/2026-10-31-midsession-restart/`: the launcher's console logs from before the restart.
- No tcp-watch or ping-watch.

## Numbers / what this session established

From `server-timeline.js` and `client-health-summary.js` on 10-31 21:18 → 11-01 02:29. Raw tool output:
`sessions.json` → `2026-10-31-game-session`.

| | Rinri | Blumairwen | Trinio | Silryantish |
|---|---|---|---|---|
| reloads on 10-24 | 12 | 12 | 0 | 0 |
| **unforced reloads tonight** | **0** | see below | **2** | **0** |
| map draws | 35 | 32 | 35 | 35 |
| median / slowest draw | 0.1 / 7.7 s | 0.1 / 5.3 s | 0.2 / 2.6 s | 0.1 / 6.3 s |
| draw stalls | 0 | 0 | 0 | 0 |
| first world entry | 49 s | 25 s | 31 s | 41 s |
| peak heap | 1,448 MB | 1,993 MB | not reported (Firefox) | 2,090 MB |
| files from the host / not mirrored / fell back | 2,994 / 5 / 1 | 5,628 / 4 / 47 | 4,140 / 3 / 1 | 2,997 / 3 / 1 |

**The host's own clients:** GM 35 draws, median 0.3 s, slowest 1.1 s, peak heap 2,581 MB of 4,096. Spectator 35 draws,
slowest 0.4 s, peak 1,214 MB. GM II 9 draws, slowest 5.3 s, world entry 139 s (first load in that browser).

**Server:** 35 activations, vends 3.3–6.2 s (median 4.2 s), 81 errors, 24 warnings. Host checks during play: CPU 19–42%,
15–17 GB RAM free, `/api/status` 2–7 ms.

**What this session established:**

1. **The stall that caused the reloads is gone.** 35 map changes, 0 draw stalls, nothing slower than 7.7 s, against
   223–520 s from Forge on 10-28. The slowest loads were first views of big map files (`Valley_Battlemap002.webp` 7.6 s,
   `Valley_Map030.png` 5.4 s).
2. **Rinri went from 12 reloads to none** in a session of the same length.
3. **Blumairwen's reloads tonight were a bad connection, not the old stall** (they reported wonky internet themselves;
   the data below fits it, but no network capture ran, so this isn't proven).
4. **Trinio's two reloads are a new, small question.** They had none on 10-24.
5. **The mirror held with everyone at once.** Load times stayed in the range of the one-player tests. Host upload was
   measured only once (1.6 MB/s in a 5 s sample mid-battle), so the peak during a map change isn't known.
6. **No sign of a memory leak.** The GM's typical heap went from about 1,010 to 1,240 MB over 5 hours, and heap fell back
   after peaks on every client that reports it.

**Every reload, from the server log and the logger:**

| time | who | what | reading |
|---|---|---|---|
| 21:39:04 | Trinio | `reload`, clean exit, 646 s after the draw, tab visible | not a stall. Cause unknown: ask them |
| 22:43:02 | Trinio | `reload`, clean exit, 1,467 s after the draw | same |
| 22:47:55 | Blumairwen | page load, no boot report until 23:11:33 | the 987 s load below |
| 23:01:53 | Blumairwen | another load inside that window | same |
| 23:14:09 | Blumairwen | new page, 23 s, then fine | their way out of it |
| 23:18–23:19 | all but GM II | the host's restart | not reloads |

**Blumairwen, 22:36 → 23:14:**
- 22:36:14 `transport close`, back at 22:36:35. Over the next 38 min their route to the host dropped and came back about
  every 1–3 min, and they logged in at 22:42, 22:55 and 23:13.
- One page took **987 s** to load (`loadMs`, ready at 23:11:33). At 23:11:33 a `load-waiting` record shows 84 files with
  48 left, waiting on files from the game host.
- It had **47 fallbacks to Forge**, every other client 0 or 1. Some Forge sounds failed too (`preloadSfx: Failed to fetch`),
  so both sources were failing for them, which points at their line rather than at the mirror.
- The next two page loads took 23 s and 25 s, with 0 fallbacks.
- **The mirror's fallback only fires on an error, not on a hang,** so a stalled connection waits. That may have lengthened
  this load. Not separated yet.
- The two battle stalls forced by the GM around 23:05 (Terror Gaze, Keren's Opportunity) fall in this window: a client
  that is connected but still loading is a case to design for.

**Reading GM II:** two socket blips under 1 s (21:51:15, 22:24:53), then off from 22:49, about 25 s after a map change,
and not back. The Vastwind battle's director was on GM II's client at about 22:47: see Side findings.

**Side findings:**
- **Low frame rate, the new complaint.** The host's GM app was slow while the Spectator stayed smooth (22:40, on
  `Vastwind_Battlemap001`), and a player reported it in a Valley battle (00:20). Nothing logged frame rate that night.
  Separate case: [../../frame-rate/CASE.md](../../frame-rate/CASE.md).
- **81 server errors, none visible as a slowdown.** 61 `Token ... does not exist` (58 of them from deletes), 17
  `undefined id ... EmbeddedCollection` from `fromUuid`, 3 `ActiveEffect ... does not exist`. All in bursts around battles,
  per removed token. Likely a repeat of `performDefeat` for one enemy, whose second `removeCombatant` finds no combatant and
  falls back to `tokenDoc.delete()` (`defeat-reactor.js`); not proven.
- **A battle's director ran on GM II** (host's note): the victory prompt appeared on GM II's client at about 22:47, not
  the host's. Not traced.
- **Other game bugs from that night** are in the host's notes and reports (the camp lobby button, Add Bond, stale
  Frightened gate); none are performance findings.
- **The launcher's sync gap fix ran for real:** the second sync changed nothing because nothing new had been added in
  between, and it took 2 s.
- **Gaps in the raw samples aren't freezes:** the logger slows from 1 to 5 min once 10 min have passed since a draw, so
  every client shows gaps at the same times.

**Player comments:**
- Blumairwen: internet a bit wonky that night.
- A player ("trio" in the host's message, read as Trinio; not confirmed) reported low frame rate in a battle.

**Open:**
- Ask Trinio about the two reloads (F5? what did the screen look like?).
- Mirror fallback on a hang, not only on an error.
- The token-delete errors, and why GM II held a battle's director.
- From earlier records, still open: forge-mirror's GM scanner and URLs with raw spaces; sync reading save slots; whether to
  keep `scenePrefetch`.
- 10-24's other pattern (Blumairwen's 5½ min reloads) didn't appear. The timeline tags one of the reloads above "sixMin",
  but that's the bad-connection window, not the pattern.
