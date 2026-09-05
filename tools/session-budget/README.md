# Session Time Budget Estimator

Turns a dungeon content plan into a **wall-clock timeline** for the 20:30 → 00:00 play window, so a session gets sized *before* it is built rather than discovered at 01:30.

It answers the question that actually matters — **where will the party be standing at midnight, and is that a safe place to stop?** — not "how long does this dungeon take", which is unactionable once you're already over.

Offline. Reads nothing from the world, writes nothing anywhere. Node 18+, no dependencies.

## Use

```bash
node bin/estimate.mjs plans/reference-fits-the-window.json   # timeline + verdict + what to cut
node bin/estimate.mjs plans/my-plan.json --runs 50000        # tighter percentiles
node bin/estimate.mjs --table                                # print the cost model
node bin/estimate.mjs plans/my-plan.json --json              # machine-readable

node test/smoke.mjs                                          # 14 checks
node test/pity-steady-state.mjs                              # re-derive the 47% battle rate
```

## Writing a plan

```jsonc
{
  "name": "Fafnir B1-B2",
  "session": { "start": "20:30", "target": "00:00", "hardStop": "01:00" },
  "segments": [
    { "name": "B1 descent", "scene": "Fafnir B1",
      "tiles": { "random_battle": 5, "skill_check": 1, "treasure": 1, "blank": 5 } },
    { "name": "B1 throne", "scene": "Fafnir B1",
      "tiles": { "story": 1 }, "beats": { "story": "Throne Confrontation" } }
  ]
}
```

Tile keys are `DP.TILE_TYPES` from `dp-constants.js`. Unknown keys warn rather than silently costing zero.

- **`tiles`** (counts) — the tool orders them: ordinary tiles round-robin so the mix is even, story-class tiles last, since a beat closes out a chain.
- **`sequence`** (array) — use instead when the exact walk order matters.
- **`beats`** — names a story-class tile in the timeline.
- A **scene change between segments** inserts a travel overhead and marks a safe stop.
- Breaks are placed automatically at segment boundaries. `"overheads": { "breaks": "none" }` or a number overrides.

## The model

```
T_total = O_open + M × Σ E[tile] + Σ O_fixed + O_close
E[tile] = P_trigger × Duration_event + (1 − P_trigger) × Duration_pass
```

Durations are `[min, mode, max]` sampled **beta-PERT**, so `mode` is the honest most-likely value rather than the midpoint — push it toward `max` for things that overrun.

Swing comes from two independent sources, which is why a flat ±10 min per tile is wrong (20 tiles would give ±200):

- **Tempo `M`** — one correlated multiplier for the whole night, PERT(0.90, 1.00, 1.30). Right-skewed on purpose: sessions run long far more often than short. Applied to **content only**; overheads are inelastic.
- **Per-tile jitter** — independent, so error adds in **quadrature**. 15 tiles of ±5 gives ≈ ±19, not ±75.

### Recalibrating

Edit `model/tile-costs.json`. **Never edit code to change a number.** `test/smoke.mjs` verifies the simulation still matches the analytic mean of whatever you put there, so a bad edit shows up as a failing check rather than a quietly wrong report.

## Things the code told us that the estimates didn't

**A Random Battle tile costs ~8 minutes, not 10–15.** `dp-random-battle.js` doesn't roll the configured chance independently per tile — it runs a pity chain (miss `+20..30` points, hit halves, floored at `minimum_encounter_percentage`) that converges to a **~47% trigger rate no matter what base rate is configured**. Verified over 2M steps by `test/pity-steady-state.mjs`. Consequence: `random_battle_percentage` barely affects session length; `minimum_encounter_percentage` is the real lever.

**Plan against P80, not the mean.** The tempo skew means a plan sized to the mean-tempo budget lands late four nights in ten. The report prints both budgets; use the P80 one.

**`rare_monster` is not in `DP.TILE_TYPES`** and infers as `UNKNOWN` in `dp-tile-state.js`. It's priced here by name. Any future scene-reading code must do the same or it will price a 34-minute tile at zero.

**One narrative beat per session.** Enforced as a warning in both directions: zero Story/Final Story tiles is a boring night (we play weekly, so the plot stalls a full week), two busts the window on their own. A Rare Monster is story-*class* in cost but is not a beat — it competes with one for time.

## Rules of thumb it produces

| | |
|---|---|
| Content budget, P80 on 00:00 | **~157 pre-tempo minutes** |
| Content budget, P80 on 01:00 | ~212 minutes |
| Fixed overheads | ~38 min (open 7, break 15, close 10, +5 per scene change) |
| Narrative beats per session | exactly 1 |
| Longest stretch without a safe stop | keep under ~75 min |

## Not built yet

- **Mode B** — read a built scene offline via `tools/safe-edit`, infer tile types, rebuild the graph from drawings (`dp-graph.js` `getDrawingEdges`) and report **critical path vs completionist path**. The party never walks every tile; that spread is usually 40+ minutes.
- **Calibration loop** — timestamp real tile dispatches during play and replay them into the cost table, so the model corrects itself from measurement instead of estimate.

**The cost table is uncalibrated.** Every duration is an estimate, not a measurement. Treat the output as a planning aid with roughly ±20 minute honesty until a few real sessions have been logged against it.
