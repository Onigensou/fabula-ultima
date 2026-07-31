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
