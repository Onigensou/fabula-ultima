# Monster Design Dossiers

One file per monster: **why** it is built the way it is, so a balance pass weeks later
judges it against its design instead of against generic rules.

Born from Gigas: its Heavy Swing (~128) is *meant* to be able to drop a PC — it is gated
by Oaf → Frightened, and the Lightning Rod is the counterplay. A scan that did not know
that called it OP. The audit now reads that finding as **intended**, with the reason.

## Commands

```bash
node bin/dossier.js gigas              # the brief — run BEFORE proposing any change to a monster
node bin/dossier.js --list             # every dossier: status, drift, new findings; who has none
node bin/dossier.js --check            # exit 2 when any invariant fails (design drift)
node bin/dossier.js --new "Rakshasa"   # scaffold a draft from the sheet
node test/dossier.test.js
```

Three tools read the dossiers:

- **`bin/balance-proposal.js`** — before simulating a plan, a *Design check* lists every
  invariant the plan would break (⛔), every intended rule-break it changes (⚠, with the
  reason), monsters with no record (❔) and each monster's role. `--design-only` skips the sim.
- **Balance Board** — a *Designer's notes* panel on every bestiary card (opens itself on drift);
  the card's flag list shows only findings the dossier does not explain.
- `bin/monster-audit.js` reads the dossiers on every run: its *Rules broken* column shows
only **new** findings (`+N intended`), a *Design record* column shows status and drift,
and a *Design records* section lists each intended finding with its reason, every
blind spot and every open question. Monsters without a dossier are listed by name.

**Automatic recall (Claude Code hook).** `bin/dossier-hook.js` is a `UserPromptSubmit` hook
(configured in `FoundryVTT/.claude/settings.json`): when a prompt names a monster (name or
`aliases`, minus any `match_exclude` phrase such as "Fafnir Castle"), its role, intended
rule-breaks, invariant ids, blind spots and open questions are injected into Claude's context.
It reads only these files (~0.1 s) and never blocks a prompt. Try it:
`echo '{"prompt":"tune gigas"}' | node bin/dossier-hook.js`

## The workflow

1. **Before** any change or balance proposal for a monster: run its brief and quote the
   intent back. No dossier → say so and ask, do not infer the design from the numbers.
2. **After** a change is applied: add a row to its *Decision log* in the same commit, and
   update invariants/exceptions if the design moved.
3. A finding marked intended is still shown — re-read the reason, it can go stale.
4. Drift (`DRIFT` in the audit/brief) means the sheet no longer matches the design:
   either fix the sheet or update the dossier — ask the designer which.

## Authority

`status: draft` until the designer confirms the file → `confirmed`. Each exception and
log row records `decided_by`: **`user`** = the designer's call; **`claude`** = a proposal
or a mechanical fix. The audit prints unconfirmed exceptions as `intended (unconfirmed)`.

## File format

Markdown prose (Identity & role · Concept · The gimmick · Numbers & targets ·
Decision log · Not simulated / risks), plus exactly one fenced block tagged `json dossier`:

| key | |
|---|---|
| `monster`, `actorId` | matched by actor id first, then name |
| `status` | `draft` \| `confirmed` |
| `role` | random encounter / story elite / boss add, and where it appears |
| `aliases`, `match_exclude` | extra names the recall hook matches ("Qilin"), phrases it ignores ("Fafnir Castle") |
| `exceptions` | `{ rule, action?, why, decided_by, date }` — a rule broken on purpose |
| `invariants` | `{ id, why, <selector>, <operator> }` — sheet values the gimmick depends on |
| `blind_spots` | what the sim/engine cannot see, so its verdict is incomplete |
| `open_questions` | unresolved design questions — printed in every brief and audit |
| `candidate_exceptions` | scaffold output only; **ignored** until moved into `exceptions` |

**Audit rule ids** (for `exceptions[].rule`): `one-shot` · `vu-count` · `absorb` ·
`basic-attack-min` · `resisted-min` · `no-damage-action` · `not-simulated` · `pattern` ·
`not-modelled` · `passive-not-simulated`. `action` narrows an exception to one action.

**Invariant selectors** — `prop` (actor `system.props` key) · `affinity` (element) ·
`item` + `prop` · `[item +] table` + `row|where` + `field` (on the item, or the actor's own
table such as `action_pattern_table` when no item is named; `row` = key or a row's
`effect_label` / `reaction_effect_ref`; `where` = field values, must match exactly one row)
· `item_where` narrows same-named items · `item` + `sameAsWorldItem` (embedded copy matches
the world item, e.g. a stealable weapon). **Operators** — `equals` · `in` · `contains` · `excludes` ·
`min` · `max`. See `gigas.md` for each one in use.
