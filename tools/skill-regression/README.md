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

node bin/skill-regression.js capture          # baseline: write goldens from current behavior
node bin/skill-regression.js check            # diff current vs goldens; exit 1 on any change
node bin/skill-regression.js check --update   # accept current behavior as the new goldens
```

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
bin/skill-regression.js   CLI: capture | check
lib/collect.js            in-world collector body (sent as evalGM code)
lib/bridge.js             test-bridge round-trip client
goldens/skills.json       committed golden (behavioral baseline)
```
