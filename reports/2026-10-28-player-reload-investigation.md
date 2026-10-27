---
id: 2026-10-28-player-reload-investigation
title: Rinri's and Blumairwen's pages reload mid-session (12 times each on 2026-10-24) — investigation case
status: open
severity: blocker
reporter: onigensou
assignee: onigensou
component: players' clients / network
introduced_in:
fixed_in:
---

# An investigation case, not a one-shot bug

The evidence, hypotheses and comparable per-session data are in the case folder:
`modules/fabula-ultima-companion/docs/investigations/player-reloads/CASE.md`.
This report holds the case's **state**. Change `status` here when the case moves.

## Symptom

Rinri and Blumairwen sit on a long black screen or a load bar stuck at 99% after map changes,
and their page reloads. On 2026-10-24 it happened 12 times each in 5½ hours. They say they never
pressed F5. Trinio and Silryantish had 0 reloads.

## Where it stands (2026-10-28)

- **Ruled out, with proof in CASE.md:**
  - The server.
  - A network cut.
  - Foundry's reconnect→reload path.
  - A crash, or a tab discard, followed by a reload.
  - Any broadcast reload.
  - Any code that silently reloads one player. Checked: Foundry core, all 58 active modules,
    world macros and scenes.
- **The page is alive when it reloads.** Either the player reloads it or a browser feature does.
- **Leading hypothesis:** a draw that looks stuck behind the black transition cover, after which the
  player reloads. The cover hides Foundry's load bar for the whole draw.
- **Why only these two:** they share a network route from the host that the other players don't use.
- **The client-health logger** (`d874e0a7`) is live on the host and verified end-to-end with a local
  test client. It has **not seen either player yet**.
- **Next:** a dedicated test with both players, planned for 2026-10-28 evening. The protocol is in
  CASE.md.

## For sarunphat

- **`client-health.js` gaps found while checking it** (CASE.md, "What the logger can and can't see"):
  - It can't tell a player's F5 from a script reload.
  - A page stuck on its first draw never reaches `ready`, so it leaves no heartbeat.
  - Deprecation warnings flood the 15-line console tail.

  The proposed upgrades are listed there. Whoever implements them, add a Notes line here.
- **Correction:** the 2026-10-24 deep-dive says Midgard_Map001 "never triggered a reload".
  Blumairwen reloaded 338 s after it, at 22:31:02. See the session record.

## Notes

- 2026-10-28 (onigensou's side): case opened. The 2026-10-24 baseline was re-derived with the new
  `_tools/` scripts, and the numbers match the deep-dive (13 page loads each).
- 2026-10-28 (onigensou's side): **load indicator shipped before tonight's test** (v1.0.473,
  `scripts/screen-transition/load-indicator.js`).
  - It draws inside the black cover. It never decides when the cover lifts.
  - It shows a "Now Loading" corner from 2 s and lifts toasts above the black.
  - GM switch: "Loading indicator on the black screen".
  - For sarunphat: `client-health.js` gained `record(kind, data)`, a one-line API addition, so the
    indicator logs `load-progress` / `load-waiting`. That covers P4 in CASE.md.
  - Commits `8ae307cf` + `da05f789` sit on `feat/zp-dishes`, mirrored on `main` as `e76e0873` + `da10d113`.
