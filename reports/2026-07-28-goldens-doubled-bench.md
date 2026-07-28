---
id: 2026-07-28-goldens-doubled-bench
title: Compute goldens blessed from a doubled Regression Bench — every key got an id suffix
status: verified
severity: major
reporter: onigensou
assignee: sarunphat
component: tools/skill-regression
introduced_in: 2ee09d01
fixed_in: da8af877
---

# Compute goldens blessed from a doubled Regression Bench

`2ee09d01` ("re-key goldens with the skill id suffix") did not re-key the goldens on
purpose — the bench it was blessed from had **two tokens per caster**, and that made
`collect.js` suffix all 482 keys. The data has been repaired in `da8af877`; the reason
this is still worth a report is that nothing in the harness could detect it, and it
will happen again the next time a `bench` runs without a `--teardown` first.

## Symptom

The committed `goldens/skills.json` is internally inconsistent:

```
_meta.count      964      but only 482 unique keys exist
_meta.casters    133      66 duplicated, plus the dummy "Test Target Enemy"
suffixed keys    482/482  should be 6
```

`skills-simulate.json` from the same suite is clean (`count 482`, 66 casters, 6
suffixed), which is what made the contamination visible by comparison.

## Root cause

`nameCounts` is keyed on the actor **name**, not the token:

```js
// collect.js:116-119
const nameCounts = {};
for (const { cTok, skill } of tasks) {
  const nk = `${cTok.actor.name} / ${skill.name}`;
  nameCounts[nk] = (nameCounts[nk] || 0) + 1;
}
```

so a second token of the same actor doubles every count, and

```js
// collect.js:189
const key = nameCounts[baseKey] > 1 ? `${baseKey} #${skill.id.slice(0, 6)}` : baseKey;
```

then suffixes *everything*. The dummy leaked into the caster pool for the same class of
reason — `collect.js:71` excludes it by **token** id, so its twin was treated as a caster:

```js
casterPool = toks.filter((t) => t.id !== dummyTok.id);
```

That is why `Test Target Enemy` appears in `_meta.casters` exactly once while every real
caster appears twice.

## Why the values survived

Both duplicate tokens resolve to the same `actor` + `skill.id`, so they produce the same
key and the second write overwrites the first with an identical fingerprint. `count`
increments per task, hence 964 against 482 keys. Checked explicitly:

- `perTarget` length is **max 1** across all 482 entries — nothing fanned out across the
  doubled scene.
- 437/437 skills present in both modes have identical `perTarget` lengths.
- `fingerprint()` records `targets.length` and actor/skill *names*, never token uuids, so
  it is token-identity independent.

## Impact if it had been left

A clean single-token bench emits bare keys for everything except the 3 genuinely
colliding names. Diffed against the contaminated goldens that is **~476 false `removed` +
~476 false `added`** — the next `check` on either side would have reported the whole
catalogue as drifted.

On this clone that would only have surfaced on a manual `check`: `hooks/regression-gate.js`
is inert here because `.claude/settings.json` is untracked and does not exist. If you have
the gate wired on your side, it would have fired on your next skill edit instead.

## Repair (da8af877)

Keys and `_meta` only; no fingerprint was touched. The legitimate suffix set was
*derived* rather than guessed — a bare key carrying more than one distinct skill id is a
real collision:

```
Hina / Glacies Finis          #7vAXk1, #C3K6l9
Illusionist / Placebo Energy  #CqAmHz, #WHzVR6
Weaponmaster / Breach         #i3d0y0, #rQHMta
```

3 collisions / 6 entries, which independently matches the 6 suffixed keys already in the
uncontaminated `skills-simulate.json`. Verified afterwards: 482/482 fingerprints
byte-identical, the diff is 952 key lines + 67 caster lines + 2 count lines and nothing
else, and the result is key-for-key and value-for-value identical to the pre-re-key
baseline at `2ee09d01^`.

## Residual — not fixed, your call

The data is clean but the harness still cannot notice this state. Cheapest guard by far
is a single invariant at bless time, since `count` and the key count diverge the moment
a caster is doubled:

```js
// skill-regression.js, before writeFileSync
if (result.count !== Object.keys(payload.skills).length) {
  throw new Error(`bench looks doubled: ${result.count} tasks but ` +
    `${Object.keys(payload.skills).length} unique keys — teardown and re-bench`);
}
```

Two smaller ones, if you think they are worth it: dedupe `_meta.casters` (or refuse when
it contains duplicates), and exclude the dummy by **actor** id at `collect.js:71` so a
stray second dummy token cannot become a caster.

I have not touched `collect.js` or `skill-regression.js` — the tool is yours and I did
not want to collide with in-flight work.

## Verified live (2026-07-28, Foundry 12.343)

Ran the suite on a clean world to confirm the repaired goldens are what a real bench
actually produces, rather than only what the arithmetic said they should be:

```
bench   -> Regression Bench (created), 66 actors / 482 skills
           (boss:9, template:37, hero:16, guest:4), placed 67 new tokens
check   -> compute mode, 482 skills, engine 1.0.423
           ✓ no behavioral changes — all skills match golden.
teardown-> torn down "Regression Bench" (67 tokens) — world holds no scaffolding
```

67 tokens for 66 casters + 1 dummy is the correct, undoubled count. `check` exited 0 and
wrote nothing. So the repaired goldens are confirmed against live behaviour, and this
doubles as end-to-end validation that your BD work causes no drift on our world.

## Notes

- Genuinely good news buried in this: `2ee09d01` was a **fresh 13:43 run**, and all 476
  shared fingerprints match the 2026-07-27 baseline exactly. So `f0e8f936`, `42dfd462`,
  `e059724c`, `b540d2a9` and `188e36c9` — the whole day of BD work including the
  `action-card.js` delta rewrite and the `skill-effects.js` changes — produced **zero**
  behavioural drift across 476 skills. The suite did its job; only its bookkeeping broke.
- `skills-simulate.json` was never contaminated and needs nothing.
- `skip.json` matches on bare skill *names* and `collect.js:190` checks both name and
  key, so the skip list was unaffected either way. `expectations/core-invariants.json`
  uses separate `caster`/`skill` fields and is likewise unaffected.
- No world data involved anywhere in this — repo tooling only.
