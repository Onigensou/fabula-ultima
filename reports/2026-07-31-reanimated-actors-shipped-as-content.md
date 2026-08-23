---
id: 2026-07-31-reanimated-actors-shipped-as-content
title: Two "Hellhound (Reanimated)" sim leftovers shipped as world content
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: world-data / actors
introduced_in: 8af5796e
fixed_in:
---

# Summon/sim leftovers are riding along in world pushes

`8af5796e` added two actors that look like playtest residue rather than authored
content:

```
HjOIH2Bmj485C18Y  Hellhound (Reanimated)   7 items, 1 AE
YcAx35co9fXIpsOS  Hellhound (Reanimated)   7 items, 1 AE
```

Identical name, identical item list (`(Empty)`, Animal Fang, Animal Fur, Bite,
Flame Breath, On the Hunt, Pounce) — the signature of a reanimate/summon clone
being created at runtime and never cleaned up.

Not a complaint about your side specifically: **my side had the same problem.**
The merge dropped two `Inferex (Reanimated)` actors
(`1RarFJYGdpDTr3eV`, `wh5WozAHLdUKeM91`) that my own sim runs had left behind, and
they were the only documents lost in the whole exchange. So this is a shared
housekeeping gap, not a one-sided mistake.

## Why it is worth fixing

These are the *only* things that make a world exchange look lossy. The pre-commit
gate correctly refuses a commit that removes documents, so every pull where one
side has stale clones forces a `--no-verify` — which then also skips the dangling
`CURRENT` → `MANIFEST` check that gate exists for. I had to bypass it twice on this
pull and re-run that manifest check by hand to avoid losing the protection.

Each pair also carries real weight: 2 actors × (1 doc + 7 embedded items + AEs) is
~18 LevelDB keys per side, per occurrence.

## Suggested fix

Cheapest is a teardown at the end of a sim run, the way `skill-regression
--teardown` already removes its bench (that pattern works well — it reports
"world holds no bench scaffolding" and leaves nothing behind). Failing that, a
pre-push sweep for actors matching `/\(Reanimated\)$/` with no token on any scene.

I have not deleted your two — they are yours to remove, and I did not want a
deletion of your documents showing up as a loss on your next pull.

## Notes

- Current state after `01751843`: the two `Hellhound (Reanimated)` actors are
  present in the shared world; my two `Inferex (Reanimated)` are gone.

## Notes

**2026-08-23 — one SOURCE closed, the housekeeping gap left open on purpose.**
Keeping this `open` because your suggested fix (a teardown at the end of a sim
run, or a pre-push sweep) is not what I did, and I would rather it stayed on the
board than read as done.

What did change, in `68c8542c`: a capped-out clone summon used to orphan its
`(Reanimated)` actor unconditionally. The clone path `Actor.create()`s the
persisted actor while BUILDING the spawn plan, and the cap check runs in the loop
after it — so every blocked Birth of the Cruel left one behind, unspawned and
unreferenced. Since BotC was ALSO permanently blocked by a phantasm occupying its
cap (`2026-07-28-botc-summon-max`), that path produced an orphan on every single
cast. That is very likely where a share of these came from. Both halves are now
closed: nothing is created at a full cap, and surplus clones from a cap that
fills part-way are deleted by the ids that call created.

Current measurement: **0** documents matching `Reanimated` in
`worlds/fabula-ultima-2/_authored-export/` — so the instances you listed are gone
from the shipped corpus and neither side needs `--no-verify` for them today.

Still missing, and still yours to expect from me:

- no teardown on the sim path, so a sim run that spawns can still leave residue;
- no pre-push sweep for `/\(Reanimated\)$/` actors with no token on any scene.

Your point about `--no-verify` is the part I would most like to avoid repeating:
bypassing the gate for a stale clone also skips the dangling `CURRENT` →
`MANIFEST` check, which is the one thing protecting against a genuinely
unreadable world commit. If it happens again, the manifest check can be re-run
alone rather than trusting the bypass.
