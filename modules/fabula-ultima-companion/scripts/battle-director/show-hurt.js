// Hurt pose inside the animation shows — the Foundry wiring of
// show-hurt-rules.js (rules, HP-loss gating and every release path live there).
//
// Runs on EVERY client and only changes what this client draws: each client
// runs the show itself (pseudo.play broadcast) and hears its own oni.hit /
// oni.fireDone / oni.dispose as local hooks, so nothing is sent anywhere.
// The engine's hurt at the damage number still arrives by socket from the GM
// (director-hurt-reaction.js -> battler-pose.js playHurtPoseLocal), which
// latches onto a hold instead of restarting the clip.
//
// Never starts a hold in SimMode / harness / bench runs: those carry no HP-loss
// plan (director-animation.js publishes one only for a real FSM action), and
// oni.hit without a plan has no `hurt`.

import { log, warn } from "./logger.js";
import {
  createShowHurtController, HIT_HOOK, SHOW_GATE_HOOK, RUN_DISPOSED_HOOK, SHOW_ABORT_HOOK,
} from "./show-hurt-rules.js";
import { IMPACT_OFFSETS_HOOK } from "./impact-offsets.js";
import { beginShowHurtHold, releaseShowHurtHold, finishShowHurtHold, setEngineHurtListener } from "./battler-pose.js";

let _ctl = null;

export function initShowHurt() {
  if (_ctl) return _ctl;
  _ctl = createShowHurtController({
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
    suppressed: () => !!globalThis.FUCompanion?.api?.vfxSuppressed?.(),
    begin: (tokenUuid, opts) => beginShowHurtHold(tokenUuid, opts),
    release: (handle) => releaseShowHurtHold(handle),
    finish: (handle, tier) => finishShowHurtHold(handle, tier),
  });
  const on = (hook, fn) => Hooks.on(hook, (d) => { try { fn(d); } catch (e) { warn(`show-hurt: ${hook}`, e); } });
  on(HIT_HOOK, (d) => _ctl.onHit(d));
  on(SHOW_GATE_HOOK, (d) => _ctl.onGate(d));
  on(IMPACT_OFFSETS_HOOK, (d) => _ctl.onOffsets(d));
  on(RUN_DISPOSED_HOOK, (d) => _ctl.onRunDisposed(d));
  on(SHOW_ABORT_HOOK, (d) => _ctl.onAbort(d));
  setEngineHurtListener((tokenUuid) => _ctl.noteEngineHurt(tokenUuid));
  on("canvasTearDown", () => _ctl.reset());
  // console / tests: what the controller holds and why it decided so
  globalThis.__ONI_SHOW_HURT__ = { stats: () => _ctl.stats(), log: _ctl.log };
  log("show-hurt: installed");
  return _ctl;
}
