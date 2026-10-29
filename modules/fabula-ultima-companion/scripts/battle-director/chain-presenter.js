// ── Chain N — strike presenter (acting GM) ─────────────────────────────────
//
// Reveals a planned Chain action's strikes one at a time — damage number,
// flinch, impact, NPC HP bar, MISS / BLOCK / IMMUNE — through the same
// broadcast VFX helpers RESOLVE uses for a single hit, so every client sees
// each strike. Nothing is written here: RESOLVE commits each target once,
// after the last strike has been shown.
//
// Timing comes from the animation. Each `oni.hit()` the inner animation script
// calls fires a local "oni:hit" hook on every client that runs it; the acting
// GM's own run is the one that counts, and each hook reveals the next strike.
// A script with no cues falls back to a fixed beat from the damage moment
// (550 ms, shrinking for long Chains). Once cues start, the beat stops; if the
// cues dry up before the strikes do, the beat resumes after a short stall.
// When the animation ends, any strikes still hidden are flushed quickly.

import { log, warn } from "./logger.js";
import { CHAIN_BEAT_MS } from "./chain-strikes.js";

const STALL_MS = 1200;     // cue mode: resume the beat if no cue arrives for this long
const FLUSH_GAP_MS = 90;   // reveal gap when flushing leftovers (end / skip)
const TAIL_MS = 260;       // let the last number pop before RESOLVE writes HP

// Which actions this client has already presented, so RESOLVE knows whether
// it still has to (no-script actions, or a presenter that never armed).
// Transient on purpose — never persisted with director.ctx.
const _presented = new Set();
export function wasPresented(plan) { return !!plan?.instanceId && _presented.has(plan.instanceId); }
// The presenter currently revealing each action, so RESOLVE can JOIN it rather
// than start a second one — ANIMATION can be left before its presenter is done
// (the 35 s state timeout on a script that never ends, an abort), and two
// presenters would show every strike twice.
const _active = new Map();

function fxModule() { return import("./director-vfx.js"); }
function barModule() { return import("./damage-numbers/director-hp-bar.js"); }

// Reveal ONE strike on every client.
async function revealStrike(strike, { causeTokenUuid, actorsByToken }) {
  let vfx = null, bar = null;
  try { vfx = await fxModule(); } catch (e) { warn("chain presenter: vfx import failed", e); return; }
  for (const o of strike.outcomes ?? []) {
    const tokenUuid = o.tokenUuid;
    if (!tokenUuid) continue;
    try {
      switch (o.kind) {
        case "miss": vfx.playMissVfx?.({ tokenUuid, cascade: strike.index }); break;
        case "block": vfx.playBlockVfx?.({ tokenUuid, cascade: strike.index }); break;
        case "immune": vfx.playImmuneVfx?.({ tokenUuid, cascade: strike.index }); break;
        case "absorb": {
          if (o.hpGain > 0) vfx.playAbsorbVfx?.({ tokenUuid, amount: o.hpGain });
          break;
        }
        case "hit": {
          const common = { tokenUuid, affinity: o.affinity ?? "NE", element: o.element || "elementless", isCrit: !!o.isCrit, pierce: !!o.pierce, cascade: strike.index };
          if (o.shieldLoss > 0) vfx.playResourceLossVfx?.({ ...common, resource: "shield", amount: o.shieldLoss });
          if (o.hpLoss > 0) vfx.playResourceLossVfx?.({ ...common, resource: "hp", amount: o.hpLoss });
          break;
        }
        default: break;   // lost / skip: nothing to show
      }
      // NPC HP bar follows the running HP strike by strike (it self-gates on
      // hostile + studied). Absorbs move it too.
      if (o.kind === "hit" || o.kind === "absorb") {
        const actor = actorsByToken.get(tokenUuid) ?? null;
        if (actor) {
          bar = bar ?? await barModule().catch(() => null);
          bar?.emitNpcHpBar?.({
            tokenUuid, actor,
            hpBefore: o.hpBefore, hpAfter: o.hpAfter,
            maxHp: Number(actor?.system?.props?.max_hp) || Math.max(o.hpBefore ?? 0, 1),
            shieldBefore: o.shieldBefore, shieldAfter: o.shieldAfter,
          });
        }
      }
      // A killing strike starts an on-hit defeat style right after its number,
      // as a single killing blow does. Removal still happens in the settle.
      if (o.killing) {
        const actor = actorsByToken.get(tokenUuid) ?? null;
        import("./defeat-reactor.js")
          .then((m) => m.startDefeatOnHit?.({ tokenUuid, actor, hpAfter: 0, causeTokenUuid }))
          .catch((e) => warn("chain presenter: defeat-on-hit failed", e));
      }
    } catch (e) {
      warn(`chain presenter: strike ${strike.index} reveal failed for ${tokenUuid}`, e);
    }
  }
}

// Build a presenter for one planned Chain. Call arm() before the animation
// script runs, startFallback() at the damage moment, flush() at the true end
// (or on a GM skip), skip() when nobody is watching. `done` settles once every
// strike has been revealed (or skipped).
export function createChainPresenter(plan, { causeTokenUuid = null } = {}) {
  const queue = [...(plan?.strikes ?? [])].sort((a, b) => a.index - b.index);
  const beatMs = Number(plan?.beatMs) || CHAIN_BEAT_MS;
  const actorsByToken = new Map();
  for (const s of queue) for (const o of s.outcomes ?? []) {
    if (!o?.tokenUuid || actorsByToken.has(o.tokenUuid)) continue;
    try { actorsByToken.set(o.tokenUuid, fromUuidSync(o.tokenUuid)?.actor ?? null); } catch { actorsByToken.set(o.tokenUuid, null); }
  }
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let finished = false, armed = false, cueSeen = false, flushing = false;
  let beatTimer = null, stallTimer = null, hookId = null;

  const clearTimers = () => {
    if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; }
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimers();
    if (hookId != null) { try { Hooks.off("oni:hit", hookId); } catch {} hookId = null; }
    if (plan?.instanceId) _presented.add(plan.instanceId);
    setTimeout(() => {
      if (plan?.instanceId && _active.get(plan.instanceId) === api) _active.delete(plan.instanceId);
      resolveDone();
    }, TAIL_MS);
  };
  const showNext = () => {
    if (finished) return false;
    const s = queue.shift();
    if (!s) { finish(); return false; }
    revealStrike(s, { causeTokenUuid, actorsByToken });
    if (!queue.length) finish();
    return true;
  };
  const beat = () => {
    beatTimer = null;
    if (finished || flushing) return;
    if (showNext() && queue.length) beatTimer = setTimeout(beat, beatMs);
  };
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stallTimer = null; if (!finished && !flushing && !beatTimer) beat(); }, STALL_MS);
  };
  const onCue = () => {
    if (finished || flushing) return;
    cueSeen = true;
    if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; }
    showNext();
    if (!finished) armStall();
  };

  const api = {
    plan,
    done,
    get remaining() { return queue.length; },
    get finished() { return finished; },
    // Listen for the animation's hit cues from the very start of the script.
    arm() {
      if (armed || finished) return;
      armed = true;
      if (!queue.length) { finish(); return; }
      hookId = Hooks.on("oni:hit", onCue);
    },
    // The damage moment: start the beat unless cues are already driving it.
    startFallback() {
      if (finished || flushing) return;
      if (!queue.length) { finish(); return; }
      if (cueSeen) { armStall(); return; }
      if (!beatTimer) beat();
    },
    // Reveal what is left, quickly (true end of the animation, or a GM skip).
    flush() {
      if (finished || flushing) return;
      flushing = true;
      clearTimers();
      const step = () => {
        if (finished) return;
        if (showNext() && queue.length) setTimeout(step, FLUSH_GAP_MS);
      };
      step();
    },
    // Nobody is watching (hidden window, no viewers): mark everything shown.
    skip() {
      if (finished) return;
      queue.length = 0;
      log("Chain presenter: no viewers — strikes not shown");
      finish();
    },
  };
  if (plan?.instanceId) _active.set(plan.instanceId, api);
  return api;
}

// Present a plan with the beat alone — for actions that have no animation
// script (or never reached one). Resolves when every strike is shown. If a
// presenter is already revealing this action (ANIMATION was left early), JOIN
// it: let it finish on its own timing, never start a second one.
export async function presentChainWithoutAnimation(plan, opts = {}) {
  const live = plan?.instanceId ? _active.get(plan.instanceId) : null;
  if (live && !live.finished) {
    live.startFallback();
    const capLive = (live.remaining + 1) * ((Number(plan?.beatMs) || CHAIN_BEAT_MS) + 200) + 2000;
    await Promise.race([live.done, new Promise((r) => setTimeout(r, capLive))]);
    if (!live.finished) live.flush();
    await Promise.race([live.done, new Promise((r) => setTimeout(r, 1500))]);
    return live;
  }
  const p = createChainPresenter(plan, opts);
  p.arm();
  p.startFallback();
  const cap = (plan?.strikes?.length ?? 1) * ((Number(plan?.beatMs) || CHAIN_BEAT_MS) + 200) + 2000;
  await Promise.race([p.done, new Promise((r) => setTimeout(r, cap))]);
  if (!p.finished) p.flush();
  await Promise.race([p.done, new Promise((r) => setTimeout(r, 1500))]);
  return p;
}
