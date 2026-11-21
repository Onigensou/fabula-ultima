# Nox Viper Counterattack + canvas ticker fix (v1.0.643)

Two small changes on top of the Nox Legion tuning (`reports/2026-11-20-nox-legion-tuning.md`). The first is a monster change. The second is an engine fix in your animation code, found while running balance batches in the snapshot runner.

## What you need to do
- Pull and restart the server (version bump), then load the world as GM once. The existing idempotent migration `2026-11-20-nox-legion-tuning.js` re-runs because its source changed, and adds the Viper's Counterattack. No world data in this push.

## Nox Viper: Counterattack
- The Viper gets a copy of the generic Counterattack world item (`Item.IEFFYKz9pycXYl7G`), flagged `noxViperCounter`.
- The trigger is unchanged: on an even Accuracy Check, from a melee attack that hits or misses it.
- The difference is the free action: its `action_ref` is `"Poison Fang"`, so the counter is a preset Poison Fang. `target_ref: trigger_attacker` keeps it on the attacker alone, and `free_hr_as_zero` still applies.
- The description says Poison Fang instead of "a free attack".
- Tested with forced dice: it fires on 4+4 ("preset Attack (Poison Fang)") and not on 4+5.

## Canvas ticker: one throwing listener stopped it for the session
**What happened:**
- `PIXI.Ticker.update` does not catch listener errors.
- A listener that throws escapes `_tick` before the next frame is requested, so the ticker keeps `started: true` but never ticks again.
- From then on every `oni.tween` waits forever. Animation scripts never reach their `finally`, so their `follow` listeners and sprites are never removed.
- Battles go on through the director's failsafe timeouts, slower and slower.
- In the snapshot runner this built up to 143,000 ticker listeners and 137,000 transparent sprites. A fight that normally takes 30 s took over 4 minutes.

**What threw:**
- `action-anim-script.js` (DEFAULT_INNER), the clone-follow listener.
- When the caster's token is deleted while that listener is still on the ticker (battle end), `caster.mesh` is a destroyed mesh, not null. `m.anchor` is then null, and `clone.anchor.copyFrom(m.anchor)` throws.

**Fixes:**
- **`action-anim-script.js`:** `follow` removes itself from the ticker when the caster mesh is destroyed (or has no anchor), instead of throwing. Your tests still pass (21).
- **`sprite-shadow-renderer.js`:**
  - A clone shadow whose baked texture is gone detaches itself.
  - `onTick` runs each clone-shadow tick inside its own try/catch, so one bad entry is detached and logged once and can no longer stop the ticker.
  - It also threw in the runner (`set width` on a null texture). After the follow fix it did not fire again.

**Before / after (warm runner, GPU, same snapshot):**
- **Before:** 26 fights took 46 min, with 5 timeouts or stalls; fight times grew from about 30 s to over 240 s.
- **After:** 10 fights back to back at 25–47 s each, then all 13 encounters in 9 min. The ticker stayed at about 28 listeners and ran 117 frames in 2 s (0 before).

**Live game:**
- The same throw would freeze that client's battle canvas until a reload, but I have not seen it at a real table.
- In the runner, `skipAnimation` aborts presentations, which may make it more likely.
- Worth knowing for the player-reload investigation, in case a frozen canvas is part of what people reload to fix.

## Open
- PIXI tickers swallow nothing, so any other listener that can throw has the same failure mode. A general guard, such as wrapping the ticker listeners our module adds, could be worth a look. Not done here.
