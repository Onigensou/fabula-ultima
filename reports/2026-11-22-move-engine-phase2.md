# move-engine Phase 2: one shared result shape (engine 1.1.0)

2026-11-22 · branch `feat/move-results` · builds on v1.0.653 (reports/2026-11-22-move-engine.md). How-to: tools/move-engine/README.md "Results".

## What changed
- **tools/move-engine/shared/results.js** (new): one RESULT shape for what happened (kind, hit, crit, fumble, total, planned
  amount, element, affinity, perfect). A move asks `moveCheck(target, page)` or `moveChain(target, n, page)`; the answer
  comes from the game first, then a page's result picker, then the move's own sliders, and is traced. The Accuracy dice
  rule (rollCheck / accOdds / presets) moved here from the Sonic Katar family.
- **Game runtime**: `moveResult` carries amount / element / affinity; `moveStrikes(t)` gives BD's Chain plan per target,
  the Perfect strike flagged. **Mockup**: `movePick()` + `mockup/result-picker.js` (chip rows a page mounts).
- **Moves**: Gunblade reads its roll through `moveCheck` (same choices as before: odd total or crit fires). Sonic Blow and
  the plain Sonic Katar attack moved into `moves/sonic-katar/sonic.js` (host-neutral, comparison only; v1.0.652's hand
  port still ships), and Sonic Blow's Perfect beat now follows the game's plan.
- **BD (director-animation.js, shared)**: `payload.outcomes` rows also carry the planned `amount`, `element`, `affinity`.
  Additive. RELOAD-REQUIRED module.
- **Migration `2026-11-22-gunblade-move-results`**: refreshes Gunblade's move-engine scripts written by another engine
  version (1.0.0 from v1.0.653) to 1.1.0. Hand-made scripts are left alone. The v1.0.653 migration now also writes 1.1.0.

## Verified
- Dry run vs mockup: all 5 Sonic Katar / Gunblade moves match the page event for event, including which result was used.
- Page picker: odd / even / crit / fumble override a move's slider; "half land" = 4 of 8 and no Perfect; "all land" = Perfect.
- BD-shaped Chain plans on Sonic Blow: 8 hits + Perfect strike → 9 cues and the Perfect beat; misses cue exactly; 8 hits
  without a planned Perfect → no Perfect beat (the game decides).
- Real sim battles (runner): both migrations land on 1.1.0; outcomes arrive with amount / element / affinity (odd 9 →
  23 fire; crit → fire; even → 13 physical; fumble → miss); Sword / Firearm by form; both transform directions.
- Real-server first boot (sandbox copy of the real world, V12): `3 ran, 0 failed` (sonic-gunblade, gunblade-move-engine,
  gunblade-move-results). Upgrade path forced by hand (1.0.0 scripts put back): refreshed to 1.1.0, second run no-op, a
  hand-made script left alone. Stored scripts decode and parse.

## Known
- "Planned" amount = what the action result holds when the animation starts (reactions folded in before it are included).
- Phase 3 (one-command parity check) and Phase 4 (skill logic) not started.
