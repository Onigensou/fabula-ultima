# Fabula Arcana: spectators watch team select live (v1.0.616)

Spectator QoL. No world data, no engine or balance change. Commits `73322604` + `c17bc076` (branch `feat/fa-spectator-draft`).

## Why

A spectator who joined during team select saw a plain "both sides are choosing" box until the match started. Picks only reached the host when a player pressed Ready, so there was nothing to show.

## Change

- **Network (`fa-host.js`):** the player's duel window now sends `draft` `{ team, opener }` while choosing (throttled to 120 ms). The host stores it as `seat.draft` and forwards `draftView(s)` to **spectators only**. The opponent never receives it. The host also re-sends the view on Ready, Unready and Card clash, and late joiners get it in `init` (`lobby.spec`).
- **Spectator screen (`duel.html`):**
  - A versus header shows the rules, Best of N, clashed cards and the watcher count.
  - Each side has a Choosing / Ready chip, a ★ meter and 3 stable card slots. A new pick flips in; a removed pick fades out where it was.
  - The opener gets an Opener tag under its card. On Ready the side shows a gold frame and a "Locked in" stamp next to the chip.
  - When both sides lock in, the locked teams stay up for about 0.7 s, then fade into the normal intro.
  - NPC duels show the AI side as Ready with its team.
- **Players:** team select shows "N watching", plus whether watchers can see your picks.
- **Private team pick:** a new option in the challenge setup panel ("Spectators during team pick"). It's off by default and remembered in `fa.challengeRules`. The invite lists it. It's stored on the session as `s.privatePick`, not inside `Format`. With it on, spectators get face-down cards plus the ★ total, and `team: null` is sent.

## Tests

Staging World, headless:
- `fa-spec.mjs` **25/25**: live picks, late joiner, no leak to the opponent, Ready/Unready, hand-off to the intro, private pick from the setup panel through to face-down cards, NPC practice duel.
- The match-rules regression `fa-formats-pvp` gave 18/19. The one FAIL is in that test's own data restore: the staging Blanche now owns only one ★★ card. It is not a regression.
- `fa-engine.test.mjs` ALL PASS.

A watched GPU run checked the layout.

## Heads-up

- Not yet seen at a real table.
- Noticed, NOT changed (it predates this change): once the match starts, the spectator's board still shows player-only text ("your pick", "Choose your opening monster").
