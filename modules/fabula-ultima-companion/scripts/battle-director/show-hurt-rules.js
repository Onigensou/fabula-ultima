// Hurt pose inside the animation shows — the pure half of show-hurt.js (no
// Foundry, no PIXI), so the gating, the per-show rules and every release path
// can be tested with plain node.
//
// What it does: a PC hit by a Nidhogg / Soul Fragment show switches to its hurt
// art (system.props.sprite_hurt) at the VISIBLE contact (the show's oni.hit),
// instead of waiting for the damage number. Only for HP loss (user rule,
// 2026-11-23): a miss, a status-only hit, MP loss, immune and absorb never pose.
//
//   sustained  (Wailing Breath)  held from contact through the knock-back:
//              released at the show's own gate (oni.fireDone, every client)
//              + releaseAfterGateMs, but never before THAT token's engine hurt
//              (+ its normal tail) has played, so a late number cannot restart
//              the clip on idle art (hurt -> idle -> hurt). The number only shakes.
//   brief      (Claw, Tail Stab, Call of the Master, Soulflare, damage
//              fragments)  held from contact until THAT token's engine hurt
//              arrives at its number; then the normal one-shot end runs (which
//              keeps the lethal hurt -> KO bridge). Capped at
//              contact + capMs (6 s) only; the lethal hurt -> KO bridge then keeps
//              the frozen frame until the KO lands (battler-pose.js, capped 6 s).
//   none       everything else, including every unlisted show.
//
// HP loss is not knowable at contact on a client, so the acting GM attaches a
// per-target plan to the show message (hpLossPlan, published by
// director-animation.js, attached by pseudoAnimation-core.js); oni.hit adds
// `hurt` from it. No plan on a client (bench, reaction path, late joiner,
// SimMode) = no contact pose = today's hurt at the number.
//
// Design + review: tools/handoffs/hurt-pose-in-shows-design.md,
// tools/handoffs/hurt-pose-design-review.md.

// Local hooks the oni helpers fire on every client that runs a show.
export const HIT_HOOK = "oni:hit";
export const SHOW_GATE_HOOK = "oni:showGate";        // oni.fireDone()
export const RUN_DISPOSED_HOOK = "oni:runDisposed";  // oni.dispose()
// Skip Animation (the GM collapsed the gate): NO new contact holds for that run.
// To be emitted by director-animation.js abort() (follow-up, see the handoff); the
// "engine hurt already seen" memory below covers clients without it.
export const SHOW_ABORT_HOOK = "oni:showAborted";     // { runId }

// The global slot the GM fills while an action's show is starting
// (director-animation.js) and pseudoAnimation-core.js reads into the message.
export const HP_PLAN_SLOT = "__ONI_SHOW_HP_PLAN__";

// ── per-show rules ──────────────────────────────────────────────────────
// Brief: waits for that token's number up to the absolute cap capMs from contact
// (no gate-relative margin: a 4-PC RESOLVE can land the last number 3.9 s after
// the gate). disposeGraceMs only counts when the show never reached its gate (a throw).
const BRIEF = Object.freeze({ mode: "brief", capMs: 6000, disposeGraceMs: 3000 });
// Sustained: released at max(gate + releaseAfterGateMs, the token's engine hurt +
// its normal hurt tail) so a number landing after the rule time never restarts
// the clip on idle art; with no number it waits up to capMs. tailMs = the pose's
// shake (260 / 420) + 30.
const SUSTAINED_WB = Object.freeze({
  mode: "sustained", releaseAfterGateMs: 800, capMs: 9000, disposeGraceMs: 3000,
  tailMs: Object.freeze({ normal: 290, strong: 450 }),
});
// An engine hurt that landed this long before a contact is the SAME action's
// number (a client running behind, or Skip Animation): no pose for it any more.
const ENGINE_HURT_MEMORY_MS = 4000;
const NONE = Object.freeze({ mode: "none" });

const K = (k) => "oni.nidhogg." + k;
export const SHOW_HURT_RULES = Object.freeze({
  // gate fires at the BLAST frame (wailing-breath.inner.js:1176): release = blast + 800 (~6300 ms);
  // 6450 is only the no-frames fallback (GATE + GATE_SLACK + 800)
  [K("wailing-breath")]: SUSTAINED_WB,
  [K("claw")]: BRIEF,
  [K("tail-stab")]: BRIEF,
  [K("call-of-the-master")]: BRIEF,
  [K("soulflare")]: BRIEF,
  // damage fragments (fragment-core MOVE.stun "damage" / "pull")
  [K("fragment-blanche-ghost-descabello")]: BRIEF,
  [K("fragment-blanche-hollow-muleta")]: BRIEF,
  [K("fragment-keren-mirror-wraith")]: BRIEF,
  [K("fragment-keren-soul-siphon")]: BRIEF,
  [K("fragment-soul-echo")]: BRIEF,
  [K("fragment-zarg-dawnbreak-arrow")]: BRIEF,
  [K("fragment-zarg-phantom-volley")]: BRIEF,
  // explicit "none": no HP loss (second guard behind the plan) or no PC target
  [K("requiem-of-soul")]: NONE,
  [K("soul-devour")]: NONE,
  [K("army-of-the-damned")]: NONE,
  [K("fragment-blanche-mocking-provoke")]: NONE,
  [K("fragment-hina-frozen-requiem")]: NONE,
  [K("fragment-hina-spirit-leech")]: NONE,
  [K("fragment-hina-stolen-hour")]: NONE,
  [K("fragment-keren-hollow-charm")]: NONE,
  [K("fragment-zarg-warning-shriek")]: NONE,
});

// The rule for a show; an unlisted show never poses.
export function showHurtRule(scriptId) {
  return SHOW_HURT_RULES[String(scriptId ?? "")] ?? NONE;
}

// ── the GM's HP-loss plan ───────────────────────────────────────────────
// Same reads as director-animation.js outcomesFromDirector (perTargetResults:
// hit / damage / affinity, Chain landed) plus the resource, with the engine's
// own hurt rule (director-vfx.js playResourceLossVfx: HP or shield loss > 0).
// Returns { [tokenUuid]: boolean } or null when there is nothing to plan.
// Anything uncertain counts as NO loss: the cost of a false "no" is today's
// hurt at the number, the cost of a false "yes" is a pose with no number.
const lc = (v) => String(v ?? "").trim().toLowerCase();
const LOSS_RESOURCES = new Set(["hp", "shield"]);
const NO_LOSS_AFFINITY = new Set(["IM", "AB"]);

export function hpLossPlan(ar) {
  const rows = ar?.perTargetResults;
  if (!Array.isArray(rows) || !rows.length) return null;
  const damaging = ar.kind === "Attack" || !!ar.hasDamage;
  const chain = ar?.chainPlan && !ar.chainPlan.single ? (ar.chainPlan.perTarget ?? null) : null;
  const plan = {};
  for (const r of rows) {
    const tokenUuid = r?.tokenUuid;
    if (!tokenUuid) continue;
    plan[tokenUuid] = !!plan[tokenUuid] || (damaging && rowLosesHp(r, ar, chain));
  }
  return Object.keys(plan).length ? plan : null;
}

function rowLosesHp(r, ar, chain) {
  const c = chain ? chain[r.tokenUuid] : null;
  const landed = c ? Number(c.landed) > 0 : (!!r.hit || !!r.pierceMiss);
  if (!landed) return false;
  if (r.grantResource != null || r.grantAmount != null) return false;   // a heal / grant row
  if (typeof r.damage !== "number" || !(r.damage > 0)) return false;
  if (NO_LOSS_AFFINITY.has(String(r.affinity ?? "").toUpperCase())) return false;
  const resource = lc(r.resource ?? ar?.valueType ?? ar?.damage?.resource ?? "hp");
  return LOSS_RESOURCES.has(resource);
}

// oni.hit's `hurt` for one token: true / false from the plan, undefined = no plan.
export function hurtFromPlan(plan, tokenUuid) {
  if (!plan || typeof plan !== "object" || !tokenUuid) return undefined;
  return plan[tokenUuid] === true;
}

// GM: publish the plan while this action's show starts; returns a slot token
// for clearShowHpPlan (which only clears its own plan).
export function publishShowHpPlan(plan, runId = null, g = globalThis) {
  if (!plan || typeof plan !== "object") return null;
  const slot = { plan, runId, at: Date.now() };
  g[HP_PLAN_SLOT] = slot;
  return slot;
}

export function clearShowHpPlan(slot, g = globalThis) {
  if (slot && g[HP_PLAN_SLOT] === slot) g[HP_PLAN_SLOT] = null;
}

// ── the controller ──────────────────────────────────────────────────────
// env = {
//   now(), setTimer(fn, ms) -> id, clearTimer(id), suppressed() -> bool,
//   begin(tokenUuid, { adoptRunning, onEngineHurt(tier) -> bool, onDropped(why) }) -> handle | null,
//   release(handle)          end the hold now (ownership-checked by the pose)
//   finish(handle, tier)     the engine hurt arrived: run the normal end after its shake
// }
// One timer per holder at most; every path that removes a holder clears it.
const MAX_RUNS = 64;

export function createShowHurtController(env) {
  const runs = new Map();     // runId -> { runId, scriptId, rule, gateAt, offsets, disposedAt, holders:Set }
  const tokens = new Map();   // tokenUuid -> { handle, holders:Set }
  const ended = new Set();    // runIds already disposed (a late hit must not revive them)
  const aborted = new Set();  // runIds the GM skipped: no new contact holds
  const lastEngine = new Map();   // tokenUuid -> when its engine hurt last arrived here
  const capReleased = new Map();  // tokenUuid -> when a hold ended at its cap with no engine hurt seen
  const log = [];             // last decisions (debug / tests)

  const note = (what, extra) => {
    log.push({ what, ...extra });
    if (log.length > 200) log.splice(0, log.length - 200);
    return what;
  };

  function runFor(runId, scriptId) {
    let run = runs.get(runId);
    if (!run) {
      if (ended.has(runId)) return { disposedAt: 0, holders: new Set(), ended: true };
      const rule = showHurtRule(scriptId);
      if (rule.mode === "none") return null;
      run = { runId, scriptId, rule, startedAt: env.now(), gateAt: null, offsets: {}, disposedAt: null, holders: new Set(), engineSeen: new Set() };
      runs.set(runId, run);
      prune();
    }
    return run;
  }

  // Runs that never got a dispose (should not happen) must not pile up.
  function prune() {
    if (runs.size <= MAX_RUNS) return;
    for (const [id, run] of runs) {
      if (runs.size <= MAX_RUNS) break;
      if (!run.holders.size) runs.delete(id);
    }
  }

  function deadlineOf(h) {
    const run = runs.get(h.runId);
    const rule = h.rule;
    const cap = h.contactAt + rule.capMs;
    let d = cap;
    if (rule.mode === "sustained") {
      const tail = h.engineSeenAt != null ? h.engineSeenAt + (rule.tailMs?.[h.engineTier] ?? rule.tailMs?.normal ?? 0) : null;
      if (run?.gateAt != null) {
        const base = Math.max(run.gateAt + rule.releaseAfterGateMs, h.contactAt);
        // the number has not landed yet: wait for it (up to the cap), never release on idle art
        d = tail != null ? Math.min(cap, Math.max(base, tail)) : cap;
      }
      if (run?.disposedAt != null) {
        d = Math.min(d, tail != null ? Math.max(run.disposedAt, tail) : run.disposedAt + (rule.disposeGraceMs ?? 0));
      }
    } else {
      // A brief hold waits for ITS token's number up to the absolute cap only
      // (real play: the last target's number lands 3.7-3.9 s after the gate; a
      // gate-relative cap released it onto idle art). Dispose grace only counts
      // when the show never reached its gate (a throw).
      if (run?.gateAt == null && run?.disposedAt != null) {
        d = Math.min(d, run.disposedAt + rule.disposeGraceMs);
      }
    }
    return d;
  }

  function schedule(h) {
    if (h.timer != null) { env.clearTimer(h.timer); h.timer = null; }
    const ms = Math.max(0, deadlineOf(h) - env.now());
    if (ms <= 0) return releaseHolder(h, "deadline");
    h.timer = env.setTimer(() => { h.timer = null; releaseHolder(h, "timer"); }, ms);
  }

  function removeHolder(h) {
    if (h.timer != null) { env.clearTimer(h.timer); h.timer = null; }
    const run = runs.get(h.runId);
    if (run) {
      run.holders.delete(h);
      if (run.disposedAt != null && !run.holders.size) runs.delete(h.runId);
    }
    const ts = tokens.get(h.tokenUuid);
    ts?.holders.delete(h);
    return ts;
  }

  function releaseHolder(h, why) {
    const ts = removeHolder(h);
    note("release", { why, tokenUuid: h.tokenUuid, runId: h.runId });
    if (h.engineSeenAt == null) {      // let go with no number: a late one plays as a normal hurt
      capReleased.set(h.tokenUuid, env.now());
      if (capReleased.size > MAX_RUNS) capReleased.delete(capReleased.keys().next().value);
    }
    if (ts && !ts.holders.size) {
      tokens.delete(h.tokenUuid);
      try { env.release(ts.handle); } catch (_e) { /* the pose guards itself */ }
    }
  }

  // The engine's hurt (the damage number) reached a show-held token.
  // Returns true when this controller owns the hold (the pose then waits for
  // finish/release); false = unknown hold, the pose ends it on its own.
  function engineHurt(tokenUuid, tier) {
    const ts = tokens.get(tokenUuid);
    if (!ts) return false;
    const now = env.now();
    for (const h of [...ts.holders]) {
      if (h.rule.mode === "brief") removeHolder(h);
      else if (h.engineSeenAt == null) {
        h.engineSeenAt = now;
        h.engineTier = tier === "strong" ? "strong" : "normal";
        schedule(h);               // release moves to max(rule time, number + tail)
      }
    }
    note("engine-hurt", { tokenUuid, tier, left: ts.holders.size });
    if (!ts.holders.size && tokens.get(tokenUuid) === ts) {
      tokens.delete(tokenUuid);
      try { env.finish(ts.handle, tier); } catch (_e) {}
    }
    return true;
  }

  // EVERY engine hurt this client plays (held or not): remembered per token and
  // per run, so a contact that comes after its own number starts no hold.
  function noteEngineHurt(tokenUuid) {
    if (!tokenUuid) return;
    const now = env.now();
    lastEngine.set(tokenUuid, now);
    if (lastEngine.size > MAX_RUNS) lastEngine.delete(lastEngine.keys().next().value);
    const ts = tokens.get(tokenUuid);
    if (ts) {
      for (const h of ts.holders) runs.get(h.runId)?.engineSeen.add(tokenUuid);
    } else if (capReleased.has(tokenUuid)) {
      capReleased.delete(tokenUuid);
      note("late-engine-hurt-after-cap", { tokenUuid });   // the one accepted restart
    }
  }

  function onAbort(d = {}) {
    if (!d?.runId) return;
    aborted.add(d.runId);
    if (aborted.size > MAX_RUNS) aborted.delete(aborted.values().next().value);
    note("abort", { runId: d.runId });
  }

  // The pose let go on its own (KO, token gone, canvas torn down, replaced).
  function dropped(tokenUuid, why) {
    const ts = tokens.get(tokenUuid);
    if (!ts) return;
    for (const h of [...ts.holders]) removeHolder(h);
    tokens.delete(tokenUuid);
    note("dropped", { tokenUuid, why });
  }

  function onHit(d = {}) {
    const tokenUuid = d?.tokenUuid;
    const runId = d?.runId;
    if (!tokenUuid || !runId) return note("skip:no-token");
    const rule = showHurtRule(d.scriptId);
    if (rule.mode === "none") return note("skip:rule-none", { tokenUuid, scriptId: d.scriptId });
    if (d.hit === false) return note("skip:miss", { tokenUuid });
    if (d.hurt !== true) return note(d.hurt === undefined ? "skip:no-plan" : "skip:no-hp-loss", { tokenUuid });
    if (d.casterTokenUuid && tokenUuid === d.casterTokenUuid) return note("skip:caster", { tokenUuid });
    if (env.suppressed?.()) return note("skip:suppressed", { tokenUuid });
    if (aborted.has(runId)) return note("skip:aborted", { tokenUuid, runId });
    const run = runFor(runId, d.scriptId);
    if (!run) return note("skip:rule-none", { tokenUuid });
    if (run.disposedAt != null) return note("skip:disposed", { tokenUuid });
    for (const h of run.holders) if (h.tokenUuid === tokenUuid) return note("skip:dup", { tokenUuid });
    // This action's number already landed here (a client running behind, or Skip
    // Animation): a hold now would wait for a number that is gone.
    const le = lastEngine.get(tokenUuid);
    if (run.engineSeen?.has(tokenUuid) || (le != null && (le >= run.startedAt || env.now() - le <= ENGINE_HURT_MEMORY_MS))) {
      return note("skip:engine-hurt-already-seen", { tokenUuid, runId });
    }

    let ts = tokens.get(tokenUuid);
    let engineHurtSeen = false;
    if (!ts) {
      const handle = env.begin(tokenUuid, {
        adoptRunning: rule.mode === "sustained",
        onEngineHurt: (tier) => engineHurt(tokenUuid, tier),
        onDropped: (why) => dropped(tokenUuid, why),
      });
      if (!handle) return note("skip:refused", { tokenUuid });
      engineHurtSeen = !!handle.engineHurtSeen;
      ts = { handle, holders: new Set() };
      tokens.set(tokenUuid, ts);
    }
    const h = { runId, tokenUuid, rule, contactAt: env.now(), timer: null, engineHurtSeen };
    ts.holders.add(h);
    run.holders.add(h);
    schedule(h);
    return note(tokens.has(tokenUuid) ? "held" : "released-at-once", { tokenUuid, runId, mode: rule.mode });
  }

  function onGate(d = {}) {
    const run = d?.runId ? runFor(d.runId, d.scriptId) : null;
    if (!run || run.ended || run.gateAt != null) return;
    run.gateAt = env.now();
    for (const h of [...run.holders]) schedule(h);
  }

  function onOffsets(d = {}) {
    const run = d?.runId ? runFor(d.runId, d.scriptId) : null;
    if (!run || run.ended) return;
    const out = {};
    for (const [k, v] of Object.entries(d.offsets ?? {})) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) out[k] = n;
    }
    run.offsets = out;
    for (const h of [...run.holders]) schedule(h);
  }

  function onRunDisposed(d = {}) {
    if (!d?.runId) return;
    ended.add(d.runId);
    if (ended.size > MAX_RUNS) ended.delete(ended.values().next().value);
    const run = runs.get(d.runId);
    if (!run) return;
    if (run.disposedAt == null) run.disposedAt = env.now();
    if (!run.holders.size) { runs.delete(run.runId); return; }
    for (const h of [...run.holders]) schedule(h);
  }

  // Canvas torn down: every hold is gone with the meshes.
  function reset() {
    for (const ts of tokens.values()) for (const h of ts.holders) if (h.timer != null) { env.clearTimer(h.timer); h.timer = null; }
    tokens.clear();
    runs.clear();
    ended.clear();
    aborted.clear();
    lastEngine.clear();
    capReleased.clear();
  }

  function stats() {
    let timers = 0;
    for (const run of runs.values()) for (const h of run.holders) if (h.timer != null) timers++;
    return { runs: runs.size, tokens: tokens.size, timers };
  }

  return { onHit, onGate, onOffsets, onRunDisposed, onAbort, noteEngineHurt, reset, stats, log };
}
