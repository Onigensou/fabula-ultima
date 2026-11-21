# Ruhig welcome: wait for the gryphon (v1.0.649)

## What was wrong

The Ruhig welcome (`Ruhig_Village011`, the step-in tile at the spawn) starts as soon as the party lands. When the party arrives with the Travel menu, the gryphon is still flying away at that moment, and the welcome's first camera move already pans to Rume, so the gryphon leaves half off-screen.

## What changed (world data, scenes store)

- The welcome now opens with a 2-second Wait, before the letterbox. Walking in through the Overworld door gets the same short pause.
- My save slot 1 got the same row (slots rebuild tiles on Load). If one of your slots holds `Ruhig_Village011`, loading it brings back the old welcome without the wait; say so and I'll send the one-tile patch.

## Also in this world commit: Nox Legion tuning results

Booting the world as GM ran the existing `2026-11-20-nox-legion-tuning.js` migration (v1.0.636 onward). Its results ship here, as that report asked: the Nox actors and their summoners (Carlbero, Nidhogg, Roo), and the Zombie debuff lasting until the end of the target's turn (Debuff item, Inferex, Bandit Zombie). No new numbers from me.

## What you need to do

- Pull and restart the server (version bump). Nothing else.

## Checked

- Sandbox copy, GM + a player client: Travel menu → Ruhig Village → the welcome played end to end, `Ruhig Welcome` ON afterwards. (Run before the wait was added; the wait is one plain Wait row.)
- world-export report: 0 removals. Preflight: 0 FAIL; Ruhig_Village011 re-blessed.
