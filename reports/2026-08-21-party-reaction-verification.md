# Party reaction verification — 88 of 95 rows REACHABLE (93%)

> ⚠ **Read the next section before quoting this number.** "Verified" here means
> the row's GATE is genuinely read. It does **NOT** mean the skill does what its
> description says.

## What "verified" does and does NOT mean

It means: the reaction is **reachable**, and its gate **discriminates** — flipping
the governing identifier flips availability, so the condition is really being
read. That is a real property and it is what caught the Poison self-lock, the
Sneaker text drift and all twelve harness defects.

It does **not** mean the effect matches the authored description. Measured over
the 88 rows counted as verified:

| tier | rows | what was actually observed |
|---|---|---|
| **A** — a document WRITE was captured | **38** | something real happened |
| **B** — routed elsewhere (`fireReason`) | **13** | effect travels a channel this probe cannot measure (card mutation, `costOverride`, `data-only`) |
| **C** — nothing observed | **37** | availability only |

So **37 of 88 rest on availability alone**, and of the 38 with writes only about
ten were hand-checked against their description text (Castigo `+AE[Bane]`,
Descabello `51 = 30 + half level`, Muleta 27, the consumable family).

⚠ Two tier-B entries are `step-failed:botc_summon` and
`step-failed:botc_destroy_minion` — the gate passed and **the effect chain step
FAILED**, yet the row still scored GATE_PROVEN. Availability and correctness are
different questions and this suite only answers the first.

**Still owed:** a description-conformance pass — read each skill's text, derive
the expected number/AE, and assert it. That is a different and harder sweep.

**Scope:** every `reaction_config_table` row on the four Exfursion PCs.
**Method:** `probeReactorTrigger` per row, run **twice** — once with its gates
satisfied, once with the governing identifier flipped. A row whose availability
does not MOVE is reported `INCONCLUSIVE` and **never counted as a pass**.

| player | verified | open |
|---|---|---|
| **Keren** | **24 / 24** ✅ | — |
| **Blanche** | **17 / 17** ✅ | — |
| Hina | 26 / 29 | 3 not-scanned |
| Zarg | 21 / 25 | 4 timeout |

🪤 **The denominator was wrong at first (97).** Two of Zarg's "rows" —
`High Speed #0` and `#99` — are CSB **`$deleted` tombstones**, not skills. A
tombstone comes in TWO shapes: the string `"$deleted"` AND an **object** with a
truthy `$deleted` property. The prober only checked the string, so it counted
removed rows as real and manufactured two NOT_SCANNED verdicts. Fixed; the true
corpus is **95 rows**.

Baseline before this pass: **43%** of testable docs. Now **90%** of reaction rows.

Writes actually observed (not "it didn't error"): Thread the Horns
`current_mp 76` + `+AE[Provoked]` · Fancy Footwork `+AE[Fatigue]` · Fear Is the
Key `+AE[Grave Points]` · Illusory Shield `current_mp 111` · Zero Trigger:
Shattered Phantasm `zero_power_value 1` · Frozen Envy `+AE[Slow]` · Icarus Wing
`+AE[Flying]` · Psychic Gifts `+AE[Brainwave Clock]`.

## The headline: the test rig was producing WRONG VERDICTS

Twelve defects were found **in the harness**, not the content. Every one made a
working skill read as broken (or, twice, hid a real problem). They are listed
here because the pattern matters more than any single fix: **a rig that omits a
field fails silently, and the failure looks like a content bug.**

| # | defect | effect |
|---|---|---|
| 1 | write-capture patch leaked on re-entrant install | **every world write silently swallowed** — `update()` returned success and changed nothing |
| 2 | `override` allowlisted only 4 identifiers | gated rows read "Conditions not met" → looked like broken skills |
| 3 | `list-picker` ignored the headless flag | every `open_action_menu` chain HUNG (and a hung picker is what leaks #1) |
| 4 | no awareness of **virtual weapons** | Blanche reported `no_main_weapon`; her whole kit was unprobeable |
| 5 | `"WEAPON"` sentinel unresolved on the skill path | Tafallera rolled the literal string → miss; actually hits for 37 |
| 6 | dropped bridge chunk reported as a result | mis-scored a row that had passed minutes earlier |
| 7 | `reaction_status_filter` read `statusId` not `status` | rows never scanned |
| 8 | `reaction_source_skill` never supplied | Bandit Gloves unreachable |
| 9 | `ROUND` excluded as the builtin `round()` | `ROUND % 2 == 0` extracted nothing → row read REFUSED |
| 10 | object-form `$deleted` tombstones counted as rows | 2 phantom rows, 2 phantom failures |
| 11 | last-occurrence-wins on a repeated identifier | picked the harder arm of a disjunction (Cataclysm) |
| 12 | identifier-vs-identifier gates (`CUR_MP >= ACTION_COST_MP + 10`) | both pinned equal → gate unsatisfiable |

⚠ #5 failed **pessimistic** — "the attack missed" looks like a normal outcome, so
it never tripped suspicion the way a permissive pass would.

## Content defects found and fixed
- **Poison** (2 docs) — blank `skill_target`; a blank IS Self
  (compose-action.js:813), so the only creature you could poison was yourself.
  Its sibling `Wind Stone` (same shape) had it right. Fixed → `One Creature`.
- **Sneaker (Passive)** (Keren's copy) — description said "+2 to **Study**
  Checks" while the row is `check_buff_action: "stealth"`. Copy drift; the world
  master and Festival Stall copy already read "Stealth".

## Content confirmed CORRECT (do not refile)
Blanche's Adoration family all read "no observable write" for ONE shared reason —
she holds 0 Adoration charges. Seeded: **Muleta** 27 dmg · **Castigo** `+AE[Bane]`
· **Descabello** 51 = `30 + half level` (lvl 41) · **Heal** 20→69 · **Zero Power**
15→69. `check_buff` / `check_die_swap` rows with no fire point are **not** dead —
they are read at check time.

## The last 10, categorised
- **4 Zarg timeouts** — already measured by the **attack rig** (Barrage fired;
  Cheap Shot / Dance #3 / Follow my lead condition-blocked). A tool boundary.
- **2 Avatar of Vengeance** — unscanned even with its gear equipped; consistent
  with that design having been removed.
- **High Speed #0 / #99** — RESOLVED: `$deleted` tombstones, correctly ignored by
  the engine. Not rows at all (see the denominator note above).
- **Cataclysm #0** — VERIFIED. Its nested OR defeated the auto-extractor
  (`ACTION_IS_FREE_CAST` appears as `== 0` in one arm and `== 1` in the other,
  and last-occurrence-wins picked the harder Bimagus arm). Now proven with THREE
  independent controls — dropping arcane weapon, spell-ness, or MP each flips
  availability on its own.
- **Heart of Darkness #0** — the one genuinely open row: reached now, but the
  ask-mode fire hangs.

## Reproducing
```
node tools/party-verify/verify.mjs <Actor> [--only <substr>] [--chunk N] [--probe-ms N]
node tools/party-verify/merge.mjs  <Actor>     # union verdicts across runs
BRIDGE_TIMEOUT_MS=280000 node tools/test-bridge-client/bridge-eval.mjs \
  tools/party-verify/virtual-weapon-test.js '{"who":"Blanche"}'   # 14/14
```
⚠ `tools/` is gitignored, so the tooling and raw results are **local only** —
which is why this pass left almost no trace in the repo. Full detail:
`tools/session-notes/PENDING-2026-08-20.md`.

## Regression status
Compute `check` 484 skills — clean (one intended change, Tafallera 35→36, after
fix #5; golden re-baselined at bench scope). `structure` 2115 docs clean.
`parity` and `census` clean. `world-export` 0/0/0.
