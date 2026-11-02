---
id: 2026-11-03-shared-actor-layouts-handoff
title: Hand-off — actors now share their sheet layouts (empty system.body is intended), plus the v1.0.513 fixes
status: open
severity: minor
reporter: sarunphat
assignee: onigensou
component: process/merge-handoff (csb-extensions, world data: actors)
introduced_in:
fixed_in:
---

# Not a bug: a hand-off note for the v1.0.513 pull

Written for onigensou, and for the Claude session that runs the pull. Please read it before
touching actors, then close it as described at the end.

## 1. Actors share their sheet layouts: an empty `system.body` is now NORMAL

**What you will see:** 262 actors in the actors store now have
`system.body.contents: []` and `system.header.contents: []`, plus
`flags.fabula-ultima-companion.layoutRef`. A new hidden `_template` actor,
**`_Layout Library`**, holds the 33 distinct layouts once, keyed by that ref. The module
puts the right layout back on every actor at prepare time
(`scripts/csb-extensions/csb-template-layout-dedup.js`, section SHARED ACTOR LAYOUTS).

**Why:** the world data each client downloads on join/reload went from ~130 MB to ~89 MB.
47 MB of it was 262 copies of 33 layouts.

**What does not change:** what any sheet shows or computes. Checked in a sandbox (the real
client and module, with the world read from disk) over every world actor (315) and every
unlinked token actor (110):

| Check, before vs after | Result |
|---|---|
| Stored layout, built CSB trees, derived props, rendered sheets | **identical** |
| Same check with `csbLayoutTreeCache` off | **identical** |
| Regression-bench skill fingerprints | **487/487** |

On the real server, a GM client and a player client both resolved all 262 actors.

**Rules for your side (and for your Claude):**

- **Do not delete, rename into a template you use, or edit `_Layout Library`.** Every
  actor with a `layoutRef` loses its sheet without it. A missing entry shows a permanent
  error notification to the GM.
- **An actor whose `_source` / export / LevelDB body is empty is NOT broken.** Do not
  "repair" it by restamping. Read `actor.system.body` (prepared) in code, never
  `actor._source.system.body`.
- **`reloadTemplate` on an actor behaves as before:** it stamps the template's layout and
  that stored layout wins over the ref. This includes `world-import`.
- **New actors you make carry their own layout.** That is fine. To fold them into the
  library later (game CLOSED, backs up first):
  `node tools/safe-edit/bin/_share-actor-layouts.js`
- **The world-export review JSON strips `system.body`,** so its diff for this change shows
  only the added `layoutRef` flag, plus the new `_Layout Library` file (5.6 MB).
- **Merging actors stores (world-pack):** keep `_Layout Library` from whichever side has
  more layouts, and check that every `layoutRef` in the merged actors exists in it.

Full notes: `modules/fabula-ultima-companion/docs/shared-actor-layouts.md`.

## 2. Your report 2026-11-01-bd-host-should-be-main-gm: fixed

- **Start goes to the main GM.** An assistant GM's `start()` now goes to the main GM's
  client when that GM is online (socketlib `executeAsUser`). Nothing mounts on the
  assistant, and the caller gets `{ forwarded: true, hostUserId, hostName }`
  (`dp-random-battle` reads that as launched).
- **Take-over without a reload.** When the hosting GM disconnects and is not back within
  15 s, the highest-ranked GM still online claims the saved battle in place.
- **Opt-out for the sim:** `start({ ..., local: true })` keeps the start on this client.
  The sim runner uses it.
- **Unchanged:** tie-break and refusal logic.

Tested on the Battle Lab with two real GM clients:
1. GM II started a battle and got `forwarded: true`. GM was hosting
   (`status().running` true, `host().amHost` true); GM II was not.
2. GM's page was then closed, and GM II hosted the same battle about 19 s later.
3. GM II alone still hosts locally.

The status is set to fixed; please verify.

## 3. Other changes in this push

- **Rakshasa's Mace "Crippled" never loaded.** The AE existed as a LevelDB key, but the
  Mace's `effects` list did not include it, so Foundry ignored it (confirmed against the
  server's payload). Now listed. Per the review gate, also:
  - it lands only on a hit (`hit_action_targets`);
  - it carries the `debuff` tag, so cleanses can remove it;
  - its DEF change runs at priority 50, after armour, Barrier and buffs.

  Verified on the NPC Attack path: hit → Crippled, miss → none; DEF Keren 11 → 5.5,
  Blanche 19 → 9.5.

  ⚠ **Still open, not fixed: keep Rakshasa out of live battles until it is.** `chain_steps`
  on non-chain effect rows never run, so Rakshasa never spends its stances. A Flail-form
  Rakshasa can repeat Mace (×2 + Crippled) every turn. The same dead link drops Devour's
  drain-heal and Form Shift's MP recovery. This needs its own authoring pass. Also open:
  Crippled lasts 3 Rakshasa turns (house default), while its text says "until removed".
- **A general trap this exposed:** a child doc stored as its own key but absent from its
  parent's id list is not loaded by Foundry, yet world-export shows it. Any raw writer that
  adds a child key must also add its id to the parent.
- **Active Effect registry startup scan** is ~5x faster (690 → 135 ms per refresh). Same
  registry, verified identical.

## Closing this

Pull, open the world once as GM, and check in the console:

```
__fuSharedActorLayouts.missing.size
```

It should print 0, and a few NPC and PC sheets should look as before. Then set
`status: verified` and push.
