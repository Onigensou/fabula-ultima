# Study card values + Adaptive Defense reads: fix report (2026-11-28)

Branch `feat/fix-study-adaptive` (based on main 5849bf9f). Playtest to-dos #15 and #16.

## #15: the Study / Alt card showed the base sheet, not the token

**What happened.** Rakshasa's token had bow 25% (Adaptive Defense). The Study card said 100%.

**Cause.** The Inspect card (it is both the Alt view and the Study result) gets its Details block
(weapon efficiency, status immunities) from the Monster Encyclopedia entry, `getEntryData`. That
entry reads the PROTOTYPE world actor (`Actor.Rk5haXsaDemonAAA`). An unlinked enemy token has its
own actor, and that is where Adaptive Defense writes `<family>_ef`. Element affinities were already
read live from the token (`resolveAffinity(actor)`), so an Asura Mark already showed correctly on
this card.

**Fix.**
- New `battle-director/unit-inspect/live-details.js` with `withLiveDetails(det, tokenProps)`.
- `inspect-model.js`: `det = withLiveDetails(entry.details, p)` (`p` = the token actor's props).
- The entry still decides what may be shown. A `details` of null (Study below 13) stays null, and
  the GM-only flag is kept. Only the numbers change.
- The Encyclopedia journal page and the Party Menu Bestiary still read the prototype. They are the
  record of what the party knows, not of this one fight.

## #16: Adaptive Defense never read Twin Shields or a spell

Reproduced in a sandbox (port 30033): Zarg's bow, Blanche's Twin Shields and Hina's Iceberg (plus
Keren's spells) against Rakshasa. After each action I read the token's `weaponReads` flag.

**Before the fix:**
- Zarg's bow hit: `weapon_read: Rakshasa read bow -> 25% [bow:4]`.
- Hina's Iceberg hit: `weapon_read: no weapon family on the payload — no read (fails closed)`, then
  `creature_hit_by_action ... chain did NOT apply (no_family)`. The counter stayed `{bow:4}`.
- Blanche's Twin Shields, on a hit: `read brawling -> 25% [bow:3 brawling:4]`. That path worked.

There were three causes:

1. **Spells: the payload never says "spell".** `resolveWeaponReadFamily` maps
   `actionKind === "spell"` to arcane. But the BD stamps both skills and spells with
   `ar.kind: "Skill"` (see the comment at state-handlers.js ~460), so that check could never pass.
   The spell fact is `actionSkillType`, which the hit payload already carried.
2. **Misses: the miss row could never match a party miss.** Adaptive Defense's
   `creature_miss_action` row is `reaction_source: "self"`. The miss trigger reaches the missed
   creature with the ATTACKER as its subject, so "self" never matched there. It only matched the
   attacker-side "I missed" dispatch, which means Rakshasa's OWN misses. Those did nothing because
   his pseudo-weapons have no family. Every other defender-side miss row in the world uses "enemy"
   (Pases, Fancy Footwork, Counter Pass, Swordbreaker, Counterattack). This is the most likely
   reason the playtest counter never showed brawling: a Twin Shields swing that MISSED was never
   read. Hits were.
3. **Sim harness only (not a game bug).** A scripted `attack: true` always declared the main hand.
   Blanche's main hand is a shield, so COMPUTE aborted with "no weapon in queue". The harness now
   uses the brain's `resolveAttackMode` (main, then off, then virtual) and accepts an
   `attackMode` override.

**Fix.**
- `weapon-read-family.js` (new, pure): a spell is `actionKind` "spell" OR `actionSkillType`
  "spell". `skill-effects.js` now uses it.
- `state-handlers.js`: both miss payloads also carry `actionSkillType`, so a missed spell reads
  arcane.
- Migration `2026-11-28-adaptive-defense-miss-source`: on every Adaptive Defense copy (world item,
  world actor, unlinked tokens), the miss row's `reaction_source` changes from "self" to "enemy".
  Only rows that are still `creature_miss_action` + "self" change. `_build-rakshasa.js` now writes
  it the same way.

**After the fix (sandbox, live counters):**
- Hits: `{bow:4}` → `{bow:3, arcane:4}` (Iceberg) → ... → `{bow:3, arcane:2, brawling:4}` (Twin
  Shields). Keren's spells read arcane too.
- Misses (DEF and M.DEF raised by 60 in the sandbox copy): the logs show
  `creature_miss_action: auto-fired "Adaptive Defense"` with `read brawling -> 25%` (Twin Shields
  miss), `read bow -> 25%` (Zarg miss) and `read arcane -> 25%` (Iceberg miss).
- Study card mid-fight: token bow 25 / brawling 80 / arcane 40, prototype bow 100. The card showed
  `arcane:40, bow:25, brawling:80`. As a player at Study 7, weapons and statuses were null (still
  locked). At Study 13 the card showed the live values.

## Heads-ups
- **Balance.** The tuning passes on 11-21 ran with spells never read (and misses never read).
  From now on a caster who repeats spells drops to 25% arcane, as the design intended ("Spells read
  as Arcane", dossier). The fight may run longer for spell-heavy parties.
- `creature_hit_by_action` also fires for non-harmful actions that "hit" Rakshasa (his own
  self-targeted Form Shift). Those fail closed (no family). A buff SPELL cast on him by an ally
  would read arcane. He fights alone, so nothing does that today.

## Tests
- `unit-inspect/live-details.test.mjs` (7), `weapon-read-family.test.mjs` (11),
  `data-migrations/2026-11-28-adaptive-defense-miss-source.test.mjs` (4).

## Update 2026-11-28 (user call): hits only

User: "When he gets hit he adapts, that is it." Misses never feed Adaptive Defense. The migration above was replaced by `2026-11-28-adaptive-defense-hits-only`: it REMOVES the creature_miss_action row on every copy and changes the trigger text to "the Rakshasa is hit by an attack or a spell". Spells still read as Arcane.
