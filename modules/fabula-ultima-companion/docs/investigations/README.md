# investigations/ — cases that outlive one session

A **case** is a problem we can't fix in one sitting because the evidence comes from live
sessions: a player's client misbehaving, a host crash, lag that only shows up with a full table.
Each session adds data. Comparing sessions on the same metrics is how a case gets closed.

`reports/` tracks the case's *state* (open → fixed → verified) and announces changes to the other
side on pull. This folder holds the case's *evidence*. Every case has one tracking report that
links here.

## Layout

```
investigations/
  README.md                  this file
  _tools/                    analysis scripts shared by all cases (plain node / PowerShell, no deps)
  <case>/
    CASE.md                  the living case file: status, ruled out, hypotheses, next test
    sessions.json            one entry per session/test, same metric names every time
    sessions/<date>-<kind>.md   per-session record: conditions, numbers, findings, generated timeline
    players.json             user id -> name for the tools (when the case is about clients)
```

## Opening a case

1. Make `<case>/` with a `CASE.md`. Sections:
   - **Status.**
   - **Symptom.**
   - **Ruled out:** each item with the proof.
   - **Hypotheses:** each with what would confirm or refute it.
   - **Open questions.**
   - **Next test.**
   - **Notes:** append-only, newest last.
2. File `reports/<date>-<slug>.md` (see `reports/README.md`) with `status: open`, linking to `CASE.md`.
3. Write the first session record and the first `sessions.json` entry from the raw logs, before
   anyone forgets the details.

## Adding a session

1. Run the tools for the session's window. Raw inputs stay on the host and are never committed:
   - Foundry `Logs/` (beside `Data/`).
   - `Data/client-health-logs/`.
   - `Logs/tcp-watch-*.log`.

   ```
   node _tools/server-timeline.js --from "YYYY-MM-DD HH:MM" --to "..." --players <case>/players.json --watch <names> --json /tmp/tl.json
   node _tools/client-health-summary.js --from "YYYY-MM-DD HH:MM" --to "..." --users <names> --json /tmp/ch.json
   ```
2. Add `sessions/<date>-<kind>.md`: conditions, the numbers, what changed vs the last session,
   then paste the generated tables.
3. Append the `sessions.json` entry. Copy the metric names, don't invent new ones. Fill
   `conditions`, so a change in the numbers can be pinned on a change in the setup: which fixes
   were live, the logger on or off, the proxy.
4. Update `CASE.md`: move hypotheses between *open / weakened / ruled out*, and add a Notes line.

## Rules

- **No full IPs or personal data in git.** The tools mask routes to /16 (`171.100.x.x`). Raw logs
  stay where Foundry wrote them.
- **Raw logs rotate.** The generated timeline in a session record *is* the long-term copy.
- **Metric definitions live in the tool headers.** If a definition must change, bump
  `schemaVersion` in that case's `sessions.json` and say so in its Notes.
- **Read before re-deriving.** A past session's numbers came from the same tools. Rerun them on
  the same window before doubting a figure.

## Tools

| script | input | gives |
|---|---|---|
| `_tools/server-timeline.js` | Foundry `Logs/debug.*.log` | scene activations, joins, reloads, logins; per player: reload delay after the last draw, modes, paired reloads |
| `_tools/client-health-summary.js` | `Data/client-health-logs/*.json` (from `scripts/client-health.js`) | per player: browser, RAM, GPU (flags software WebGL), a verdict per page boot (discarded / died / reload during draw / boot gap), draw times, stalls, disconnects, hidden time, console lines before each reload |
| `_tools/tcp-watch.ps1` | live `Get-NetTCPConnection` on the host | per remote IP, every connection-state change, with ms timestamps. Run it during a session; it writes `Logs/tcp-watch-*.log`. The header explains how to read a reload |

## Cases

| case | status | opened |
|---|---|---|
| [player-reloads](player-reloads/CASE.md) | open | 2026-10-28 (incident 2026-10-24) |
