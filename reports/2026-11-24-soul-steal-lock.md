# Soul Steal: one steal per creature for the whole party (to-do #16, 2026-11-24)

From the 2026-11-21 session: several party members have Soul Steal (Keren, Zarg), and the user asked
whether the steal limit was per thief or per monster. Rule (user, 2026-11-24): FF-style Steal. Once a
creature has been successfully stolen from, nobody in the party can steal from it again. Mockup, three
rounds, decisions on the page: https://claude.ai/artifact/2dwWrFjcDGYi5DqhtfC1TP

## What was wrong
`roll_loot_table` (skill-effects.js) locked only the caster who stole. Keren could not steal twice from
Ampere, but Zarg still could, and his roll only skipped the exact item Keren took, so Ampere still gave its
other items. Each hit also paid SL Inventory Points again, even to the same thief. The picker showed
stolen creatures like any other.

## What players see now
- **Picking targets for Soul Steal:** a creature already stolen from stays on screen with the picker's
  existing grey dashed ring and a **"Nothing to Steal"** label (the same overlay as "Already studied"). Its
  sprite is greyed to ~62% brightness (user pick "A+"; other unpickable tokens keep the usual 30% dim).
  It can't be clicked, the arrow keys skip it, and its drawer row reads "Nothing to Steal".
- **Every enemy stolen from:** the picker still opens the same way. Everything is greyed, Confirm stays
  off, and Back (Esc) returns to the command menu with nothing spent. Pressing Enter shows the usual
  picker note ("Nothing can be picked. Go back to choose another action."), like "Pick exactly 1 target."
- **Soul Steal targets enemies only** (user ruling). It used to read "creatures", which let a player pick
  an ally.
- **Inventory Points** follow the item steal: a stolen creature can't be picked, so it can't be hit and
  pays no IP.
- A **miss**, or a roll that lands on **(Empty)**, is not a steal. Anyone may try again.
- The loot panel line for a stolen creature now reads "**Nothing to steal** from Ampere. It was already
  stolen from." (was "Already stolen from Ampere.").

## Build (feat/soul-steal-lock)
- New `battle-director/steal-lock.js`: `stolenFromBy`, `hasBeenStolenFrom`, `actionRollsStealTable` (an
  action with a `roll_loot_table` row), `applyStealLockExclusion` (moves stolen creatures into the
  picker's `.excluded` side-channel, reason "Nothing to Steal", `dim: "soft"`; flags an all-stolen pool
  `showWhenNoneLeft`). Data-driven: no skill is named in code.
- Applied in **both** pickers' pools: `target-survey.js` (GM + AI; last exclusion, so no later `.filter()`
  drops the side-channel) and `compose-action.js` (player). The AI counts an all-stolen field as 0
  targets, so autopilot never picks Soul Steal there.
- `target-picker.js`: opens on a `showWhenNoneLeft` pool, Confirm never valid with 0 pickable, soft dim
  filter for `dim: "soft"`. `state-handlers.js` `resolveActionTargets`: the empty-pool refusal lets that
  pool through to the picker.
- `remote-pick.js`: `.excluded` and the flag now cross the socket as fields. JSON dropped them before, so
  a remotely routed picker never showed any "🚫" overlay (Study's "Already studied" included).
- `skill-effects.js` `roll_loot_table`: backstop. Any `soulStolenBy` AE, whoever stamped it, means nothing
  to steal. Stamping is unchanged: only a won item stamps.
- Migration `2026-11-24-soul-steal-enemies-only` (one-time): `skill_target` "Up to (1 + 98 *
  HAS_SKILL_PILLAGE) creatures" → "... enemies" on the world items and every actor copy (exact-value
  match; anything else is reported and left alone). The description (core-book text) is untouched.

## Tests
- `steal-lock.test.mjs` (new, offline): 9 passed. The other 70 battle-director tests: unchanged
  (`crisis-keywords`, `impact-offsets` fail on main too).
- Sandbox (`worktrees/_soul-steal-lab`, :30007, GM headless + Zarg's player Trinio as a visible window),
  Training Ground, Zarg (+ Keren) vs Ampere, Lightning Prism, Galvanic Paryashera:
  1. Migration ran on GM boot: all 5 Soul Steal copies (2 world, Keren, Rogue, Zarg) now "enemies".
  2. Ampere marked "Soul Stolen by Keren": Zarg's picker shows Ampere greyed + "Nothing to Steal", rings on
     the other two, allies out ("No ally can be chosen for this."). Clicking Ampere's row selects nothing.
  3. Zarg cast at Lightning Prism and missed: no mark, Prism stays pickable (retry allowed).
  4. Resolver called directly for Zarg on Prism + Ampere: Prism gave Lightning Essence and was marked
     "Soul Stolen by Zarg"; Ampere returned "Nothing to steal" (stolen by Keren, a different thief).
  5. All three marked: survey says 0 available (category enemy). Zarg's picker opens with all three greyed,
     Confirm off; Enter shows the note; Esc returns to the Skill menu, Zarg still DECLARE with 1 turn.
  6. Attack in the same state still targets all three normally (the lock is steal-only).

## Noticed, not changed
- While any picker is open on a player's client, the **caster** is dimmed too (same with a plain Attack, so
  it's on main as well): `applyTargetingDim` keeps the caster lit via `director.ctx.turnSnapshot`, which is
  empty on the player's client.
- `battleDirector.stop()` during a group check left the check window ("Skill Check — Bubble Splash") on the
  player's screen.

## Owed
- GM boot runs the migration (5 Soul Steal copies). Real-table look Sat 11-28.
