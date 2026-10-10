---
id: 2026-10-10-dangling-embedded-effect-ids
title: Three monster loot items list effect ids that do not exist — Foundry CLI unpack crashes on the actors store
status: open
severity: minor
reporter: sarunphat
assignee: onigensou
component: world-data / actors
introduced_in: e27444c2
fixed_in:
---

# Symptom

`world-pack unpack --collection actors` (the Foundry CLI) dies with
`LEVEL_NOT_FOUND` on origin's actors store from `e27444c2` onward. Foundry
itself loads fine because it silently skips the missing ids. But the merge tool
cannot read the store, and the items probably lack the effects you meant them
to have.

# The five dangling references

Each embedded item's `effects` array names an id that has no
`!actors.items.effects!<actor>.<item>.<effect>` key:

| actor | item | missing effect ids |
|---|---|---|
| Asura `0AwQ7wEDz4ISA9mA` | Demongrin `ll1QCriD5ganoy1h` | `TlMCRfo2h3MeTeUa`, `CP7p0r8hNj11AMfz` |
| Electro Slime `A1VzokzJPoyxobCd` | Topaz Pendant `FUbKCWzDtxTT4Nfp` | `FUwvG3wyIlZWLfyj` |
| Succubus `bnem1vdA6Bv3mBVx` | Bikini Armor `hN5IkJdmMjvuGmey` | `BYmDLMmevbfp6Jer`, `hcXD2mSw60trRMAg` |

All three items arrived in `e27444c2` (steal tables). The export shows their
`effects: []`, so whatever those AEs do (the library items carry them) is
absent on the monster copies. A steal that copies from the monster would then
hand the player an item without its effects.

# Suggested fix

Re-add the three items to those actors from the library (drag in a fresh copy),
or create the missing embedded effects. Then confirm with:

```
node tools/safe-edit/bin/world-pack.js unpack --collection actors --ref HEAD --out <scratch>
```

# Notes
