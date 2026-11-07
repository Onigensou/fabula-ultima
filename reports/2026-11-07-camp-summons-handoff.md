---
id: 2026-11-07-camp-summons-handoff
title: Hand-off — Camp Summons (v1.0.557) touches the walk runtime, the save token extractor, emotes and the speech bubble
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: camp-system (new camp-summons-*), map-system/movementControl-cameraRuntime, save-system/save-extractors, emotes-system/emote-resolver, speech-bubble
introduced_in: 923d9bb2..8450be57
fixed_in:
---

# Camp Summons: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. Nothing here needs action. It lists the shared
files this feature touched, so a merge or a later change doesn't undo it by accident.

## 1. The feature

During camp free time (Free Roam and the Sleep lobby), a player can call one of their character's summons into the
camp. It is cosmetic only: a sprite with no bars and no HUD that follows its summoner. Q swaps which token the
player walks. Any other phase and rest dismiss it.

New files: `scripts/camp-system/camp-summons-core.js`, `camp-summons-ui.js`, `camp-summons-bootstrap.js` (the
bootstrap is a new `esmodules` entry, after `party-menu-button.js`).

## 2. Shared files touched

| File | Change |
|---|---|
| `map-system/movementControl-cameraRuntime.js` | `isCampMemberToken` also counts tokens flagged `flags.<module>.campSummon`. `findOwnCampMember` skips summons unless the client chose one with the new `setCampWalker(tokenId)`. New `walkCampSummon(token, point)`. One new clause in the camp branch of the `preUpdateToken` gate allows a player's own summon to move when the update carries `oniSummonFollow`. The walk-map (`walkKind: "party"`) path is unchanged; an A/B against main gave identical positions. |
| `save-system/save-extractors.js` | `sceneTokenData` skips tokens flagged `campSummon`, so summons are never saved. A load already deletes tokens that aren't in the save. |
| `emotes-system/emote-resolver.js` | New priority 1b: if the player walks a summon (`FUCompanion.api.campSummons.ledToken()`), the emote plays on it. GM and other paths unchanged. |
| `speech-bubble.js` | The same check at the top of the player path. |

## 3. Data

- New camp-only skill flag `flags.<module>.campSummons: [[actorUuid, ...], ...]`. Each inner list is one group,
  called together. Set on Keren's Stubborn Scion for Leichi and Leilan. No other code reads it.
- New optional actor flag `flags.<module>.campSprite`: the image a summon wears at camp. Set on Crysta (her
  standing art), because her token art is the battle webm.
- Summon tokens are unlinked copies of the actor, owned by the summoning player through `delta.ownership`. The base
  actor (including King Gorger's battle state) is never written.

## 4. Things to know

- Only the primary GM creates and deletes summon tokens. Players ask over the module socket (`campSummon:req`).
- The camp row now has four player buttons (Upgrade, Inner Wellspring, Stubborn Scion, Summon). Summon docks after
  whichever of the other three are showing.
- Q is also DF Architect's "QuickSwap" layer shortcut. Our handler only takes Q from a player at camp who has a
  summon out, so the GM's QuickSwap is unaffected.
- The Hideout_Map009 camp room has an authored "Crysta" token at (136, 416). It is not a summon and isn't touched.
