# skill-regression — behavioral regression tripwire for director skills

Refactor the Battle Director engine, then run one command to see **exactly which
skills changed behavior** — instead of eyeballing one skill at a time in the UI.

It drives the standard director test harness (`FUCompanion.api.test.*`) over the
whole roster of PC skills, captures a deterministic per-skill fingerprint, and
diffs it against a committed golden. A changed damage number, a hit that became a
miss, a heal amount that shifted, a skill that started erroring — all surface as
a field-level diff.

## Requirements

- **The Foundry world must be OPEN.** The tool drives the running world through
  the file-IPC test-bridge (`worlds/fabula-ultima-2/test-bridge/`). No combat is
  required — the harness runs skills against a synthetic director context.
- A roster scene with tokens. Defaults to the **active scene**, else
  **Training Ground**. The 4 PCs (Blanche/Hina/Keren/Zarg) + 2 enemies
  (Salamander/Hellhound) on Training Ground are the standard roster.

## Usage

```bash
cd tools/skill-regression

node bin/skill-regression.js bench            # build/refresh the local Regression Bench scene (whole catalog)
node bin/skill-regression.js capture          # baseline: write goldens from current behavior
node bin/skill-regression.js check            # diff current vs goldens; exit 1 on any change
node bin/skill-regression.js check --update   # accept current behavior as the new goldens
node bin/skill-regression.js verify           # assert expected-value invariants; exit 1 on mismatch
```

## Coverage: the Regression Bench (whole catalog)

The classic roster is the 4 PCs on Training Ground (~52 skills). That misses the
biggest reservoir of authored skills — the 37 **ClassTemplate** actors (the
canonical ~290-skill library), plus bosses and guests — which is exactly where a
shared-engine change silently regresses skills nobody re-tested.

`bench` builds a **local** "Regression Bench" scene holding one token per
*backbone* actor (ClassTemplates + heroes/PCs + bosses + a guest allow-list ≈ 67
actors / ~450 skills) plus a single target dummy (the `Test Target Enemy`
fixture). It is **not shipped as world data** — a fresh clone regenerates it by
re-running `bench`; only the goldens + tooling are committed. The backbone is
computed live from actor props (`class_facet` / `char_identity` / `isBoss` /
guest names), so new class templates and bosses are picked up automatically.

```bash
node bin/skill-regression.js bench --json     # build + print the selected roster
# → capture the whole-catalog golden against it:
node bin/skill-regression.js capture --scene "Regression Bench" --dummy "Test Target Enemy"
node bin/skill-regression.js capture --scene "Regression Bench" --dummy "Test Target Enemy" \
     --mode simulate --goldens goldens/skills-simulate.json
```

In **bench mode** (`--dummy` set) the dummy is the single offensive target and
**every other token is a caster regardless of disposition** (ClassTemplates are
enemy-disposition but still get fingerprinted); support skills target self. A
skill that errors on a bare template actor fingerprints as a stable `ok:false` —
still a valid diffable baseline. Without `--dummy` the classic
ally=caster / first-enemy=target behaviour is unchanged.

Runtime: **~110 s** for the full 491-skill compute pass (`bench` 2 s + `check`
**109 s** + `teardown` 3 s; measured 2026-08-08, reproduced at 108 s).

It was **1294 s** until the module-reuse fix below. The old cost was ~2.6 s/skill,
and the dominant term was not the engine work — it was the test harness's
per-call cache-bust re-fetching, re-parsing and re-evaluating **1.5 MB of module
source on every single skill** (measured 925 ms of raw `import()` per call, plus
the cold-module cost downstream: ~713 MB of module churn per sweep).
`loadDeps()` now takes an optional `depsToken`; the collector issues **one token
per bridge page**, so the first skill in a page loads fresh and the other 29
reuse it. Freshness is preserved at page granularity — every page is a new bridge
call with a new token — and callers that pass no token (all interactive use) keep
the per-call bust that makes single-file edits take effect without a reload.
Verified by re-running the whole catalog against the unchanged golden: **491/491
identical**. `--no-deps-reuse` restores the old path.

⚠ An earlier "~1 min" figure here was wrong by 20× and is what sized the Stop
hook's old 420 s cap — which silently killed every whole-catalog run a third of
the way through. Re-measure before changing any timeout; use `--caster` /
`--limit` for a fast subset. `skip.json` is a committed list of interactive
`open_action_menu` skills that only ever record `reason:"timeout"` at COMPUTE (a
12s guard each); they're recorded as `reason:"skipped"` instead, which removes
that dead time with no loss of real compute signal. `capture` and `check` both
auto-load it (so they stay consistent); `--no-skip` disables it (e.g. to
re-measure which skills still time out — add any new ones to `skip.json`). Paging
handles the bridge's 5-min cap; use `--caster` / `--limit` for fast subsets.

## Correctness invariants: `verify`

The golden answers "did behaviour **change**"; `verify` answers "is it
**correct**". It runs the hand-authored scenarios in `expectations/*.json` and
checks **invariants** — facts that hold regardless of balance tuning (no resolve
error, affinity routing, a heal raises HP, a crit sets the crit flag) — so they
don't churn on every rebalance the way exact numbers do. See the header of
`lib/verify.js` for the spec schema + the derived signal list. Seed suite:
`expectations/core-invariants.json` (re-confirm/expand on first game-open run).

## Enforcement: auto-run after skill edits

Two hooks (wired in `.claude/settings.json`) make the check unavoidable when
skill-engine code or world actor data changes — the world-export pre-commit hook
can't cover this because it runs game-*closed* and this check needs the game
*open*.

- **PostToolUse** (`hooks/on-skill-edit.js`) — on an Edit/Write to a Battle-
  Director skill-engine file (`skill-*.js`, `*reaction*`/`*reactor*`,
  `state-handlers.js`, `states.js`, `damage-ruleset.js`, `card-mutations.js`,
  `template-field-registry.js`) or `worlds/fabula-ultima-2/data/actors/**`,
  writes a session marker (`.state/pending.json`, gitignored). Cheap; never blocks.
- **Stop** (`hooks/regression-gate.js`) — at end of a turn that set the marker:
  engine code **semantically unchanged** since the last completed check → clear
  the marker, one-line note, **skip the sweep** (see below);
  game **closed** → keep the marker + print a one-line "deferred" reminder;
  game **open**, drift → clear marker, surface a concise NEW/CHANGED/REMOVED
  summary once (advisory — review; re-baseline with `check --update` if
  intended); game open, clean → clear marker. A kill-timer caps the run so a
  wedged bridge can't freeze turn-end. Override scene/mode via
  `SKILL_REGRESSION_CHECK_ARGS` (e.g. `--scene "Regression Bench" --dummy "Test Target Enemy"`).

#### The semantic gate — why most engine turns cost nothing

The trigger above is a **path** match, so it used to fire the full ~22 min sweep
for a comment rewrite, a re-indent, or a turn that edited an engine file and then
reverted it. `lib/engine-fingerprint.js` hashes the engine source with comments
stripped and formatting normalized (**54% of those 1.6 MB is comments and
indentation**), and the hash of the code a verdict was reached on is recorded in
`.state/verified.json`. When the marker is engine-only and the hash still
matches, the sweep is skipped — the check could only reproduce its previous
verdict.

- The hash is written by the Stop hook **and** by a manual full `check` /
  `check --update` / `capture`, so re-baselining by hand doesn't cost a re-sweep.
- It is **never** written for a `--caster` / `--limit` run: a subset proves
  nothing about the rest of the catalog.
- The skip is **never** taken when world actor data also changed — the hash
  covers code only.
- Recorded on drift as well as on clean: the check *did* evaluate that code, and
  re-running it next turn would only reprint the same summary at full cost. The
  skip line then **carries that verdict forward** — `⚠ … reported N skills of
  drift, still unreviewed` rather than a `✓`, so unreviewed drift can't read as
  clean just because the sweep was skipped.
- The comment stripper is string/template/regex-aware (all 23 engine files still
  `node --check`-parse after stripping). Any confusion in it changes the hash
  rather than preserving it, so the failure direction is a **redundant run**,
  never a missed regression.

Typical loop: `capture` once on a known-good engine → refactor → `check`. A clean
run prints `✓ no behavioral changes`; a dirty run lists NEW / REMOVED / CHANGED
skills with the exact fields that moved, e.g.

```
~ CHANGED (2) — behavior differs from golden:
    ~ Hina / Ignis Finis
        perTarget.0.damage: 42 → 55
    ~ Zarg / Barrage
        perTarget.1.hit: true → false
```

### Options

| flag | meaning |
|------|---------|
| `--mode compute\|simulate` | `compute` (default): read-only, safe mid-battle. `simulate`: richer (writes + card HTML), gated — see below. |
| `--caster <ActorName>` | Restrict to one caster (fast smoke test). |
| `--limit <N>` | Cap total skills. |
| `--scene <SceneName>` | Roster scene (default: active / Training Ground). |
| `--goldens <path>` | Golden file (default `goldens/skills.json`). |
| `--json` | Machine-readable `check` output (for CI/piping). |
| `--no-deps-reuse` | Cache-bust the harness modules per skill (pre-2026-08-08 path, ~12× slower). Escape hatch if module reuse is ever suspected of leaking state between skills. |

⚠ `--goldens` defaults **per mode** (`skills.json` for compute,
`skills-simulate.json` for simulate). It used to default to `skills.json`
regardless, so a `capture --mode simulate` that omitted `--goldens` overwrote the
compute baseline — the one every `check` and the Stop-hook gate depend on.

⚠ The **simulate** golden is not fully deterministic: skills that pick a random
status (e.g. `Hina / Draconic Roar`, Enraged vs Poisoned) differ between two runs
of the *same* code. Forced dice pin the attack roll, not that pick. Compute mode —
what the gate uses — is stable.

## How it works

- **Roster**: every ally-disposition token on the scene is a caster; the first
  enemy token is the offensive target. Support skills target the caster itself
  (always a valid, stable target).
- **Skills**: each caster's embedded `Active` + `Spell` items, in deterministic
  (name, id) order.
- **Determinism**: fixed dice (`force: {rA:5, rB:6}`) and pinned formula
  identifiers (`override: {SL:5, CHAR_LEVEL:50, BOND_COUNT:4, BOND_STRENGTH:4}`)
  so a PC levelling up or a bond changing does **not** churn the golden — only an
  engine or skill-data change does. The pinned values are recorded in the golden
  header.
- **Fingerprint (compute mode)**: `{ ok, roll (hr/crit/fumble), hasDamage,
  hasHealing, element, perTarget:[{hit, damage, resource, affinity, grant,
  grantRes}] }`. Read-only — no document writes, no prototype patching.
- **Fingerprint (simulate mode)** additionally captures `writes` (per-actor prop
  patches + AE applied/removed) and `cardHtml` (the normalized action-card HTML
  the player would see). This is the richest signal, especially for buff / heal /
  status skills whose real effect lands in RESOLVE.
- **Paging**: the bridge caps one `evalGM` at 5 minutes, so the driver walks the
  roster in pages of 30 skills, one bridge call each, and merges. A full 4-PC
  compute run is ~52 skills in ~100s.
- **Per-skill guard**: each harness call races a 12s timeout. A skill whose
  `open_action_menu` would *prompt* at COMPUTE (interactive) can't wedge the
  batch — it's recorded as `ok:false, reason:"timeout"` (a stable, diffable
  state) and any dialog it spawned is closed. To exercise such a skill for real,
  pass its menu picks via the collector's `picks` option, or add it to a `skip`
  list.

## compute vs simulate — which to use

- **compute** (default) is **safe to run mid-session**: it never writes and never
  patches document prototypes. Its fingerprint is rich for **offensive / damaging
  skills** (hit routing, damage, affinity) but thin for pure buff/heal/status
  skills, whose effect only materializes in RESOLVE.
- **simulate** runs RESOLVE under write-capture and captures everything, but it
  **globally monkey-patches** `Actor/Item/ActiveEffect.prototype` for each call
  window. If a live battle resolved an action during that window the real write
  would be intercepted (not committed) → data loss. The collector **refuses**
  simulate mode when the director is mid-action (`COMPUTE/RESOLVE/CONFIRM/TARGET`);
  run it when the battle is idle or no director is running. Prefer simulate for a
  thorough baseline; prefer compute for a quick mid-work sanity check.

## Reproducibility & caveats

- A golden is valid **against the same roster it was captured on**. Caster stats
  and target defenses/affinities are *live actor state* (deliberately — a skill
  genuinely behaves differently on a stronger caster), so re-capture if you
  change an actor's build or swap the roster.
- Capturing while a **live battle** is applying buffs/debuffs to the roster
  enemy can shift affinity/defense and show up as a spurious `CHANGED`. For a
  trustworthy baseline, capture when the roster is quiescent.
- Each harness call re-imports the director module edges with a cache-bust
  (that's how it always tests latest disk). A large batch therefore grows the
  browser's module map for the session — harmless, cleared on the next world
  reload. A reload after a big `simulate` capture is a good hygiene step.

## Files

```
bin/skill-regression.js   CLI: bench | capture | check | verify
lib/collect.js            in-world collector body (sent as evalGM code)
lib/build-bench.js        in-world Regression Bench builder (evalGM code)
lib/verify.js             in-world invariant runner (evalGM code)
lib/bridge.js             test-bridge round-trip client
goldens/skills.json       committed golden (behavioral baseline; bench, 482 skills)
goldens/skills-simulate.json  simulate-mode golden (writes + AE + card)
skip.json                 interactive skills recorded as 'skipped' (keeps runs ~1 min)
expectations/*.json       hand-authored correctness invariants for `verify`
hooks/on-skill-edit.js    PostToolUse marker writer (enforcement)
hooks/regression-gate.js  Stop-hook gate that runs `check` (enforcement)
.state/                   local session marker (gitignored)
```
