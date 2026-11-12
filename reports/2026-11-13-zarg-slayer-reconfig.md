# Zarg: Hunter → Slayer reconfig (2026-11-13)

Heads-up for sarunphat. **No code and no world data changed.** This is player progress plus a note about who works on what.

## What happened

Trinio (Zarg's player) rebuilt Zarg's skills between sessions, on the main world, using the normal level-up flow.

| | Before | After |
|---|---|---|
| Classes | Rogue 10, Sharpshooter 10, Tinkerer 10, Dancer 10, **Hunter 3** | the same four + **Slayer 5** (Hunter unlearned) |
| Skills unlearned | Wild Reflexes 1, Vital Strike 1, Set Trap 1, Tripwire Trap 1, Siren Trap 1 | all five sit in the `levelupStash` flag, so a re-take brings back the party copies |
| Skills taken | none | **Bane Oils 2, Giant Killer 1, Lockdown 2** |
| SP | 2 | 0 |
| Forget me Nut | 0 | 7 (bought 10 from Rume for 500z, spent 3) |
| Zenit | 1805 | 1305 |

Oni's save slot 1 is patched with this (Zarg + Rume's stock and till). Saves stay personal and nothing in `fu-saves/` is committed.

## Slayer: we'll take the follow-up on our side

You authored Slayer in `b8bdb0db` (2026-09-29: `TARGET_SOLDIER_EQUIVALENT`, `TARGET_AFFINITY_<ELEM>`, the `subject_actions` menu, `ae_remember_action`). Zarg is the first PC to actually take it, so **we'll do the follow-up authoring for Bane Oils, Giant Killer and Lockdown here**:

- a gameplay pass in a real battle (Staging World first), with fixes where something doesn't fire or reads wrong;
- Zarg's own data, e.g. his Bane Oils has no species enabled yet (all 8 `Bane Oils: <Species>` effects are off), so Trinio has to pick 2;
- a check against systems built after September: the Expose keyword (11-11, `applyKeywordAffinity`), the Armor/Magic Break statuses and Polymorph forms;
- animations and UI for all three (mockup first, Oni reviews it).

**Please avoid editing these three skills and the Slayer class actor (`RQLxwTwMhxZ6zLvR`) for now, so we don't both change the same items.** If the engine pieces above need a fix, we'll fix them properly and say so in the hand-off report. A design question will come to you as a question, not a silent change.

The other Slayer skills (Harvester, Protective Strike, Weak Point, Exploit, Wildlife Expert) are not in scope.
