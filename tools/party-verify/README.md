# party-verify — do the party's reaction rows work, and do they match their text?

Every PC skill/gear passive declares its behavior as `reaction_config_table` rows
plus `effect_table` rows. This probes each row and answers **two different
questions** that are easy to conflate:

1. **Reachability** — can the row's gate actually open? Proven by a **gate flip**:
   pin the gate identifiers and the row becomes available; flip them and it does
   not. That is `GATE_PROVEN`.
2. **Conformance** — does what it *did* match what the description *says*?
   Judged from the writes the probe observed, against the authored text.

> ⚠ **Reachable ≠ correct.** A gate flip proves the row can fire. It says nothing
> about whether the effect is the one the text promises. Keep the two numbers
> apart when reporting; collapsing them overstates the work every time.

## Commands

```bash
# probe one actor (game OPEN — drives the file-IPC test-bridge)
node tools/party-verify/verify.mjs Hina
node tools/party-verify/verify.mjs Zarg --only "Skull Orb"   # targeted retry

# roll every run up into one verdict per row (offline)
node tools/party-verify/merge.mjs Hina

# conformance pass: observed writes vs authored description (offline, no game)
node tools/party-verify/conformance.mjs
```

`verify.mjs` writes one JSON per run into `results/` (gitignored — machine- and
world-specific, and they only grow). `merge.mjs` and `conformance.mjs` read them.

## First use on a different world — read this

The tool is written against **this** authoring world. Before trusting output:

- `conformance.mjs` and `roster.mjs` hardcode `worlds/fabula-ultima-2/` and the
  four PC actor ids in their `ACTORS` map. Point them at your world/actors.
- `verify.mjs` defaults to the `Test Target Enemy` / `Test Target Ally` fixtures
  (`--enemy` / `--ally` to override) and needs the test-bridge running.
- `adjudications.json` records decisions about THIS world's content. On another
  world it is a worked example, not an answer key.

## The traps this tool exists to survive

Each of these produced confident, wrong output before it was guarded:

- **An empty canvas silently fails every row.** `probeReactorTrigger` resolves
  reactors from `canvas.tokens.placeables`; with none, every row degrades to
  `NOT_SCANNED` — a full sweep of false negatives that looks like real data.
  `verify.mjs` now **hard-aborts (exit 2)** rather than write an untrustworthy run.
  👉 After any `skill-regression teardown`, re-activate the fixture scene first.
- **A merge over run files is grow-only.** A row DELETED from a skill keeps its
  last verdict forever, because no later run enumerates it to contradict.
  `roster.mjs` derives the live row set from the **world** (CSB tombstones and
  all) so the denominator tracks reality; `merge.mjs` names what it drops.
- **Evidence has a shelf life.** A verdict is cumulative — a gate proven Monday
  is still proven. **Write evidence is not**: a capture taken before a harness
  attribution fix can be credited to a skill that never made it, and an observed
  write is exactly what makes a result look conclusive. `conformance.mjs` takes
  verdicts from every run but writes only from runs at/after `EVIDENCE_CUTOFF`,
  and reports the rest as **STALE — not judged, not dropped**.
- **A step that failed may be the RIG, not the content.** `no-sink` (no in-flight
  action card), `no-combat`, `no-candidates` are things a trigger probe cannot
  supply. `probe-lib.js` scores those as gate-answered + **EFFECT UNMEASURED**
  rather than `STEP_FAILED` — which deliberately outranks a pass, so mislabeling
  one buries a good verdict. Anything outside that exact whitelist still fails.
- **`containerEquipped: false` is not a bug.** A gear passive whose gear is not
  equipped correctly reports `NOT_SCANNED`. Read that field before blaming the
  canvas — both print the same verdict and only one is a defect.
  `equip-toggle.js` equips and restores exactly (and prefers the gear SHELL over
  a same-named linked `_skill`, whose `isEquipped` means nothing).
- **A killed run strands its seeds.** `PV Charge <key>` AEs persist and leak into
  the next run's evidence *and* into `world-export` as authored content.
  `verify.mjs` sweeps them at startup.

## Files

| file | role |
|---|---|
| `verify.mjs` | drives the probes; writes `results/*.json` |
| `probe-lib.js` | builds the positive/negative cases; assigns the verdict |
| `merge.mjs` | one verdict per row across all runs, gated on the live roster |
| `roster.mjs` | the live row set, derived from world data |
| `conformance.mjs` | observed writes vs description; strict, never infers a pass |
| `adjudications.json` | the human half — settled rows + the evidence that settled them |
| `equip-toggle.js` | temporarily equip gear, then restore exactly |
| `virtual-weapon-test.js` | unit checks for the virtual-weapon resolution |
