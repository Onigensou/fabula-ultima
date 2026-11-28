// ============================================================================
// Hurt pose inside the animation shows — gating, holds and every release path.
//
//     node scripts/battle-director/show-hurt.test.mjs
//
// 1. Pure rules (show-hurt-rules.js): the per-show registry, the GM's HP-loss
//    plan (hit:true with 0 / MP / immune / absorb / heal = no pose), hurtFromPlan.
// 2. The controller on a fake clock and a fake pose: sustained release on the
//    show's gate hook, brief hold until the engine hurt, caps, dispose, drops,
//    nested runs, and that every path leaves no timer behind.
// 3. The REAL battler-pose.js + controller + oni helpers against stubbed
//    Foundry / PIXI (fake canvas, fake <video>, fake timers): freeze across a
//    re-render, KO guards, ownership on release, both event orders, the lethal
//    -> KO bridge, KO / delete / teardown release, no plan = no contact pose,
//    and the plan riding pseudo.play's message (pseudoAnimation-core.js).
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

let passed = 0, failed = 0;
function ok(label, cond, extra) {
  if (cond) { passed++; console.log("  ok", label); }
  else { failed++; console.log("  FAIL", label, extra === undefined ? "" : JSON.stringify(extra)); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── fake clock (installed globally: battler-pose / director-surfaces use setTimeout) ──
const clock = (() => {
  let now = 0, seq = 0;
  const timers = new Map();   // id -> { at, fn }
  return {
    now: () => now,
    setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
    reset() { timers.clear(); },
  };
})();
globalThis.setTimeout = clock.setTimeout;
globalThis.clearTimeout = clock.clearTimeout;
// the controller reads performance.now(): keep it on the fake clock too
Object.defineProperty(globalThis, "performance", { value: { now: () => clock.now() }, configurable: true, writable: true });

const R = await import("./show-hurt-rules.js");
const { showHurtRule, hpLossPlan, hurtFromPlan, createShowHurtController, publishShowHpPlan, clearShowHpPlan, HP_PLAN_SLOT } = R;

// ── 1. pure rules ────────────────────────────────────────────────────────
console.log("1. rules");
eq("WB is sustained, gate + 800", [showHurtRule("oni.nidhogg.wailing-breath").mode, showHurtRule("oni.nidhogg.wailing-breath").releaseAfterGateMs], ["sustained", 800]);
eq("WB cap 9 s", showHurtRule("oni.nidhogg.wailing-breath").capMs, 9000);
for (const k of ["claw", "tail-stab", "call-of-the-master", "soulflare", "fragment-soul-echo", "fragment-zarg-phantom-volley", "fragment-keren-soul-siphon"]) {
  eq(`${k} is brief (cap 6 s)`, [showHurtRule("oni.nidhogg." + k).mode, showHurtRule("oni.nidhogg." + k).capMs], ["brief", 6000]);
}
for (const k of ["requiem-of-soul", "fragment-hina-spirit-leech", "fragment-zarg-warning-shriek", "fragment-blanche-mocking-provoke", "soul-devour", "army-of-the-damned"]) {
  eq(`${k} never poses`, showHurtRule("oni.nidhogg." + k).mode, "none");
}
eq("an unlisted show never poses", showHurtRule("oni.someone.else").mode, "none");
eq("no scriptId never poses", showHurtRule(undefined).mode, "none");

{
  const A = "Scene.S.Token.A", B = "Scene.S.Token.B", C = "Scene.S.Token.C", D = "Scene.S.Token.D", E = "Scene.S.Token.E", F = "Scene.S.Token.F";
  const ar = {
    kind: "Skill", hasDamage: true,
    perTargetResults: [
      { tokenUuid: A, hit: true, damage: 12, resource: "hp", affinity: "NE" },
      { tokenUuid: B, hit: true, damage: 0, resource: "hp", affinity: "NE" },     // hit:true but 0 loss
      { tokenUuid: C, hit: true, damage: 9, resource: "mp", affinity: "NE" },     // MP loss (Spirit Leech)
      { tokenUuid: D, hit: true, damage: 9, resource: "hp", affinity: "IM" },
      { tokenUuid: E, hit: true, damage: 9, resource: "hp", affinity: "AB" },     // absorb heals
      { tokenUuid: F, hit: false, damage: 9, resource: "hp", affinity: "NE" },    // miss
    ],
  };
  eq("HP plan: only the real HP loss poses", hpLossPlan(ar), { [A]: true, [B]: false, [C]: false, [D]: false, [E]: false, [F]: false });
  eq("status-only skill (no hasDamage) plans no loss", hpLossPlan({ kind: "Skill", hasDamage: false, perTargetResults: [{ tokenUuid: A, hit: true, damage: 5 }] }), { [A]: false });
  eq("heal / grant row is no loss", hpLossPlan({ kind: "Skill", hasDamage: true, perTargetResults: [{ tokenUuid: A, hit: true, grantAmount: 5, grantResource: "hp" }] }), { [A]: false });
  eq("shield loss counts (engine hurts on shield too)", hpLossPlan({ kind: "Skill", hasDamage: true, perTargetResults: [{ tokenUuid: A, hit: true, damage: 4, resource: "shield" }] }), { [A]: true });
  eq("an Attack row with no resource = HP", hpLossPlan({ kind: "Attack", perTargetResults: [{ tokenUuid: A, hit: true, damage: 4 }] }), { [A]: true });
  eq("a pierce miss still loses HP", hpLossPlan({ kind: "Attack", perTargetResults: [{ tokenUuid: A, hit: false, pierceMiss: true, damage: 4 }] }), { [A]: true });
  eq("action-level MP resource", hpLossPlan({ kind: "Skill", hasDamage: true, valueType: "mp", perTargetResults: [{ tokenUuid: A, hit: true, damage: 4 }] }), { [A]: false });
  eq("unknown damage (non-number) is no loss", hpLossPlan({ kind: "Attack", perTargetResults: [{ tokenUuid: A, hit: true, damage: null }] }), { [A]: false });
  eq("Chain: landed decides", hpLossPlan({ kind: "Attack", chainPlan: { single: false, perTarget: { [A]: { landed: 0 }, [B]: { landed: 2 } } },
    perTargetResults: [{ tokenUuid: A, hit: true, damage: 4 }, { tokenUuid: B, hit: false, damage: 4 }] }), { [A]: false, [B]: true });
  eq("Chain: a card target no strike went to is no loss", hpLossPlan({ kind: "Attack", chainPlan: { single: false, perTarget: { [B]: { landed: 1 } } },
    perTargetResults: [{ tokenUuid: A, hit: true, damage: 4 }, { tokenUuid: B, hit: true, damage: 4 }] }), { [A]: false, [B]: true });
  eq("no rows = no plan", hpLossPlan({ kind: "Attack", perTargetResults: [] }), null);
  eq("no action = no plan", hpLossPlan(null), null);
  eq("hurtFromPlan: planned yes", hurtFromPlan({ [A]: true }, A), true);
  eq("hurtFromPlan: target not in plan = no", hurtFromPlan({ [A]: true }, B), false);
  eq("hurtFromPlan: no plan = undefined", hurtFromPlan(null, A), undefined);
  const g = {};
  const s1 = publishShowHpPlan({ [A]: true }, 7, g);
  ok("publish fills the slot", g[HP_PLAN_SLOT]?.plan?.[A] === true && g[HP_PLAN_SLOT].runId === 7);
  const s2 = publishShowHpPlan({ [B]: true }, 8, g);
  clearShowHpPlan(s1, g);
  ok("clear only clears its own plan", g[HP_PLAN_SLOT] === s2);
  clearShowHpPlan(s2, g);
  ok("clear empties the slot", g[HP_PLAN_SLOT] === null);
}

// ── 2. the controller, fake pose ─────────────────────────────────────────
console.log("2. controller");
function fakeEnv() {
  const live = new Set();
  const calls = [];
  const handles = new Map();
  let refuse = new Set(), suppressed = false, runningHurt = new Set();
  const env = {
    now: () => clock.now(),
    setTimer: (fn, ms) => { const id = clock.setTimeout(() => { live.delete(id); fn(); }, ms); live.add(id); return id; },
    clearTimer: (id) => { live.delete(id); clock.clearTimeout(id); },
    suppressed: () => suppressed,
    begin: (tokenUuid, opts) => {
      calls.push(["begin", tokenUuid, opts.adoptRunning]);
      if (refuse.has(tokenUuid)) return null;
      if (runningHurt.has(tokenUuid) && !opts.adoptRunning) return null;
      const h = { tokenUuid, opts, engineHurtSeen: runningHurt.has(tokenUuid) };
      handles.set(tokenUuid, h);
      return h;
    },
    release: (h) => { calls.push(["release", h.tokenUuid]); },
    finish: (h, tier) => { calls.push(["finish", h.tokenUuid, tier]); },
  };
  return {
    env, calls, live, handles,
    refuse: (u) => refuse.add(u), suppress: (v) => { suppressed = v; }, running: (u) => runningHurt.add(u),
  };
}
const WB = "oni.nidhogg.wailing-breath", CLAW = "oni.nidhogg.claw", SF = "oni.nidhogg.soulflare", RQ = "oni.nidhogg.requiem-of-soul";
const T1 = "Scene.S.Token.T1", T2 = "Scene.S.Token.T2", CASTER = "Scene.S.Token.NID";
const hitOf = (o) => ({ casterTokenUuid: CASTER, runId: "r1", scriptId: WB, hit: true, hurt: true, ...o });

{ // sustained: contact 2900 -> gate 5650 -> release at 6450
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  const t0 = clock.now();
  clock.advance(2900);
  eq("WB contact holds", c.onHit(hitOf({ tokenUuid: T1 })), "held");
  eq("WB begins with adoptRunning (sustained)", f.calls[0], ["begin", T1, true]);
  // engine hurt during the hold only shakes: still held
  f.handles.get(T1).opts.onEngineHurt("strong");
  ok("engine hurt during WB keeps the hold", !f.calls.some((x) => x[0] === "release" || x[0] === "finish"));
  clock.advance(5650 - 2900);
  c.onGate({ runId: "r1", scriptId: WB });
  clock.advance(799);
  ok("not released before gate + 800", !f.calls.some((x) => x[0] === "release"));
  clock.advance(1);
  eq("released at gate + 800 = 6450", [f.calls.filter((x) => x[0] === "release").length, clock.now() - t0], [1, 6450]);
  eq("no timer left (sustained gate path)", [f.live.size, c.stats().timers, c.stats().tokens], [0, 0, 0]);
  c.onRunDisposed({ runId: "r1" });
  eq("run state gone after dispose", c.stats().runs, 0);
}
{ // sustained: dispose before gate (throw / abort) releases now
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1 }));
  clock.advance(1000);
  c.onRunDisposed({ runId: "r1" });
  clock.advance(2999);
  ok("WB dispose before gate / number: grace for a late number", !f.calls.some((x) => x[0] === "release"));
  clock.advance(1);
  eq("WB dispose with no number releases after the 3 s grace", f.calls.filter((x) => x[0] === "release").length, 1);
  eq("no timer left (dispose path)", [f.live.size, c.stats().timers, c.stats().runs], [0, 0, 0]);
}
{ // sustained: no gate, no dispose -> 9 s cap
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1 }));
  clock.advance(8999);
  ok("WB cap not before 9 s", !f.calls.some((x) => x[0] === "release"));
  clock.advance(1);
  eq("WB cap at 9 s", f.calls.filter((x) => x[0] === "release").length, 1);
  eq("no timer left (cap path)", f.live.size, 0);
}
{ // brief: hold until the engine hurt, then finish (the normal end)
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  clock.advance(560);
  eq("Claw contact holds", c.onHit(hitOf({ tokenUuid: T1, scriptId: CLAW })), "held");
  eq("Claw begins without adoptRunning (brief)", f.calls[0], ["begin", T1, false]);
  clock.advance(320);
  c.onGate({ runId: "r1", scriptId: CLAW });
  clock.advance(400);   // RESOLVE + socket
  ok("brief still held before the number", !f.calls.some((x) => x[0] !== "begin"));
  const owned = f.handles.get(T1).opts.onEngineHurt("normal");
  ok("engine hurt is owned by the controller", owned === true);
  eq("engine hurt finishes the brief hold (normal end)", f.calls.at(-1), ["finish", T1, "normal"]);
  eq("no timer left (brief engine-hurt path)", [f.live.size, c.stats().timers, c.stats().tokens], [0, 0, 0]);
  clock.advance(20000);
  ok("nothing fires later", f.calls.filter((x) => x[0] === "release").length === 0);
}
{ // brief: the number never comes -> the absolute cap, 6 s from each contact (no gate margin)
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onOffsets({ runId: "r1", scriptId: SF, offsets: { [T2]: 323, [T1]: 0 } });
  clock.advance(1456);
  c.onHit(hitOf({ tokenUuid: T1, scriptId: SF }));
  c.onGate({ runId: "r1", scriptId: SF });
  clock.advance(1779 - 1456);
  c.onHit(hitOf({ tokenUuid: T2, scriptId: SF }));
  clock.advance(1456 + 6000 - 1779 - 1);
  eq("T1 not capped before contact + 6 s", f.calls.filter((x) => x[0] === "release").length, 0);
  clock.advance(1);
  eq("T1 capped at contact + 6 s", f.calls.filter((x) => x[0] === "release").map((x) => x[1]), [T1]);
  clock.advance(323);
  eq("T2 capped at its own contact + 6 s", f.calls.filter((x) => x[0] === "release").map((x) => x[1]), [T1, T2]);
  eq("no timer left (brief cap path)", f.live.size, 0);
}
{ // brief: dispose gives a short grace, then releases
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1, scriptId: CLAW }));
  c.onRunDisposed({ runId: "r1" });
  clock.advance(2999);
  ok("brief (no gate ever) not released inside the dispose grace", !f.calls.some((x) => x[0] === "release"));
  clock.advance(1);
  eq("brief (no gate) released after the dispose grace", f.calls.filter((x) => x[0] === "release").length, 1);
  eq("no timer / run left (brief dispose path)", [f.live.size, c.stats().runs], [0, 0]);
}
{ // gating
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  eq("hit:true but no HP loss -> no pose", c.onHit(hitOf({ tokenUuid: T1, hurt: false })), "skip:no-hp-loss");
  eq("no plan on this client -> no contact pose", c.onHit(hitOf({ tokenUuid: T1, hurt: undefined })), "skip:no-plan");
  eq("miss -> no pose", c.onHit(hitOf({ tokenUuid: T1, hit: false })), "skip:miss");
  eq("status show (Requiem failed save) -> no pose", c.onHit(hitOf({ tokenUuid: T1, scriptId: RQ })), "skip:rule-none");
  eq("caster -> no pose", c.onHit(hitOf({ tokenUuid: CASTER })), "skip:caster");
  eq("tokenless oni.hit() -> nothing", c.onHit({ runId: "r1", scriptId: WB }), "skip:no-token");
  f.suppress(true);
  eq("hidden tab -> no pose", c.onHit(hitOf({ tokenUuid: T1 })), "skip:suppressed");
  f.suppress(false);
  f.refuse(T2);
  eq("pose refused (KO / no art) -> nothing held", c.onHit(hitOf({ tokenUuid: T2 })), "skip:refused");
  eq("nothing began for any skip", f.calls.filter((x) => x[0] === "begin").map((x) => x[1]), [T2]);
  eq("no state for skips", [c.stats().tokens, f.live.size], [0, 0]);
  c.onHit(hitOf({ tokenUuid: T1 }));
  eq("second oni.hit for the same token in a run is ignored", c.onHit(hitOf({ tokenUuid: T1 })), "skip:dup");
  c.onRunDisposed({ runId: "r1" });
  c.onHit(hitOf({ tokenUuid: T1, runId: "r1" }));
  ok("a disposed run never starts a hold", c.log.at(-1).what === "skip:disposed");
  clock.advance(3000);
  eq("no timer left (gating)", f.live.size, 0);
}
{ // pose dropped (KO / delete / replaced) clears the controller's timers
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1 }));
  f.handles.get(T1).opts.onDropped("ko");
  eq("dropped: no timer, no token", [f.live.size, c.stats().tokens, c.stats().timers], [0, 0, 0]);
  clock.advance(20000);
  ok("dropped: no release ever", !f.calls.some((x) => x[0] === "release"));
  eq("engine hurt after a drop is not owned", f.handles.get(T1).opts.onEngineHurt("normal"), false);
}
{ // nested runs: two shows hold one token; the pose lets go when the last does
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1 }));
  c.onHit(hitOf({ tokenUuid: T1, runId: "r2", scriptId: CLAW }));
  eq("one pose begin for two holders", f.calls.filter((x) => x[0] === "begin").length, 1);
  f.handles.get(T1).opts.onEngineHurt("normal");
  ok("brief holder satisfied, sustained keeps holding", !f.calls.some((x) => x[0] === "finish" || x[0] === "release"));
  c.onRunDisposed({ runId: "r1" });
  clock.advance(3000);
  eq("released when the last holder goes", f.calls.filter((x) => x[0] === "release").length, 1);
  eq("no timer left (nested)", f.live.size, 0);
  c.onHit(hitOf({ tokenUuid: T1, runId: "r3" }));
  c.reset();
  eq("reset (canvas teardown) clears every timer", [f.live.size, c.stats().runs, c.stats().tokens], [0, 0, 0]);
}
{ // order B at the controller: a running engine hurt is adopted by a sustained hold
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  f.running(T1);
  eq("brief + running engine hurt: left alone", c.onHit(hitOf({ tokenUuid: T1, scriptId: CLAW })), "skip:refused");
  eq("sustained + running engine hurt: adopted", c.onHit(hitOf({ tokenUuid: T1, runId: "r2" })), "held");
  c.onRunDisposed({ runId: "r2" });
  clock.advance(3000);
  eq("no timer left (order B)", f.live.size, 0);
}

{ // Q1: a number landing after the rule time (sustained) -> no release until it has played
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  clock.advance(2900);
  c.onHit(hitOf({ tokenUuid: T1 }));
  clock.advance(3400);
  c.onGate({ runId: "r1", scriptId: WB });           // gate ~6300
  clock.advance(800 + 1500);                         // rule time passed, number (RESOLVE) not here yet
  ok("WB still held past gate + 800 while its number is due", !f.calls.some((x) => x[0] === "release"));
  c.noteEngineHurt(T1);
  f.handles.get(T1).opts.onEngineHurt("normal");
  clock.advance(289);
  ok("held until the number's own tail (290)", !f.calls.some((x) => x[0] === "release"));
  clock.advance(1);
  eq("released at number + tail: one release, one begin (no restart path)", [f.calls.filter((x) => x[0] === "release").length, f.calls.filter((x) => x[0] === "begin").length], [1, 1]);
  eq("no timer left (late number)", [f.live.size, c.stats().timers, c.stats().tokens], [0, 0, 0]);
  c.onRunDisposed({ runId: "r1" });
}
{ // Q1: number BEFORE rule time -> rule time stands (max)
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1 }));
  clock.advance(1000);
  c.noteEngineHurt(T1); f.handles.get(T1).opts.onEngineHurt("strong");
  clock.advance(1000);
  c.onGate({ runId: "r1", scriptId: WB });
  clock.advance(799);
  ok("number early: still held until gate + 800", !f.calls.some((x) => x[0] === "release"));
  clock.advance(1);
  eq("released exactly at gate + 800", f.calls.filter((x) => x[0] === "release").length, 1);
}
{ // Q1: sustained, no number ever: cap at 9 s; the late number is then ONE normal hurt (logged)
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1 }));
  clock.advance(1000);
  c.onGate({ runId: "r1", scriptId: WB });
  clock.advance(7999);
  ok("WB past gate + 800 with no number: waits up to the cap", !f.calls.some((x) => x[0] === "release"));
  clock.advance(1);
  eq("WB released at the 9 s cap", f.calls.filter((x) => x[0] === "release").length, 1);
  c.noteEngineHurt(T1);
  eq("a number after the cap is logged as the one accepted restart", c.log.at(-1).what, "late-engine-hurt-after-cap");
  eq("...and it is not owned (the pose plays a normal hurt on its own)", f.handles.get(T1).opts.onEngineHurt("normal"), false);
  eq("no timer left (cap, late number)", [f.live.size, c.stats().timers], [0, 0]);
}
{ // Q1: brief cap = gate + offset + 3000 (4-PC RESOLVE), not dispose + 600
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  clock.advance(560);
  c.onHit(hitOf({ tokenUuid: T1, scriptId: CLAW }));
  clock.advance(320); c.onGate({ runId: "r1", scriptId: CLAW });   // gate 880
  clock.advance(100); c.onRunDisposed({ runId: "r1" });            // dispose ~1 s: the old cap would be 1.6 s
  clock.advance(2000);                                             // the number lands ~2.1 s after the gate (slow RESOLVE)
  ok("brief survives dispose + 600 while the number is slow", !f.calls.some((x) => x[0] === "release"));
  c.noteEngineHurt(T1);
  ok("slow number lands in the hold, owned", f.handles.get(T1).opts.onEngineHurt("normal") === true);
  eq("brief finishes (normal end), no release", [f.calls.at(-1)[0], f.calls.some((x) => x[0] === "release")], ["finish", false]);
  eq("no timer left (brief slow number)", [f.live.size, c.stats().timers, c.stats().runs], [0, 0, 0]);
}
{ // Q3: engine hurt BEFORE contact -> no later hold (per run, and by the token's memory)
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  clock.advance(10000);
  c.onOffsets({ runId: "r1", scriptId: WB, offsets: {} });         // run known first
  clock.advance(500);
  c.noteEngineHurt(T1);                                            // its number lands first
  clock.advance(2400);
  eq("contact after its own number: refused", c.onHit(hitOf({ tokenUuid: T1 })), "skip:engine-hurt-already-seen");
  eq("no pose began, nothing live", [f.calls.length, f.live.size, c.stats().tokens], [0, 0, 0]);
  // the run is first seen at the hit: the token's memory refuses
  c.noteEngineHurt(T2);
  clock.advance(3000);
  eq("run first seen at the hit, number 3 s earlier: refused", c.onHit(hitOf({ tokenUuid: T2, runId: "r9" })), "skip:engine-hurt-already-seen");
  clock.advance(5000);
  eq("an old engine hurt (previous action) does not block a new run", c.onHit(hitOf({ tokenUuid: T2, runId: "r10", scriptId: CLAW })), "held");
  c.onRunDisposed({ runId: "r10" }); clock.advance(3000);
  c.reset();
}
{ // Q3: after its number was seen in a hold, a second begin for the same run is refused
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  clock.advance(10000);
  c.onHit(hitOf({ tokenUuid: T1, scriptId: CLAW }));
  c.noteEngineHurt(T1); f.handles.get(T1).opts.onEngineHurt("normal");
  clock.advance(6000);
  eq("same run, same token, after its number: refused", c.onHit(hitOf({ tokenUuid: T1, scriptId: CLAW })), "skip:engine-hurt-already-seen");
  c.onRunDisposed({ runId: "r1" });
  eq("no timer left (Q3 run memory)", [f.live.size, c.stats().timers], [0, 0]);
}
{ // Q3: Skip Animation (abort) -> no new contact holds for that run; others unaffected
  clock.reset();
  const f = fakeEnv(); const c = createShowHurtController(f.env);
  c.onHit(hitOf({ tokenUuid: T1 }));
  c.onAbort({ runId: "r1" });
  eq("aborted run: a later contact starts no hold", c.onHit(hitOf({ tokenUuid: T2 })), "skip:aborted");
  eq("the log says why", c.log.at(-1).what, "skip:aborted");
  eq("another run is unaffected", c.onHit(hitOf({ tokenUuid: T2, runId: "r2", scriptId: CLAW })), "held");
  c.onRunDisposed({ runId: "r1" }); c.onRunDisposed({ runId: "r2" });
  clock.advance(10000);
  eq("every timer cleared (abort path)", [f.live.size, c.stats().timers, c.stats().runs, c.stats().tokens], [0, 0, 0, 0]);
  c.reset();
}

// ── 3. real battler-pose.js + controller + oni helpers, stubbed Foundry ──
console.log("3. battler-pose integration");
const NS = "fabula-ultima-companion";
const hooks = new Map();
let hookSeq = 0;
globalThis.Hooks = {
  on(name, fn) { const id = ++hookSeq; if (!hooks.has(name)) hooks.set(name, new Map()); hooks.get(name).set(id, fn); return id; },
  once(name, fn) { const id = this.on(name, (...a) => { this.off(name, id); fn(...a); }); return id; },
  off(name, id) { const m = hooks.get(name); if (!m) return; if (typeof id === "function") { for (const [k, f] of m) if (f === id) m.delete(k); } else m.delete(id); },
  callAll(name, ...args) { for (const fn of [...(hooks.get(name)?.values() ?? [])]) fn(...args); return true; },
};
globalThis.game = { user: { isGM: true, id: "gm", name: "GM" }, modules: { get: () => null } };
const fakeTex = (w = 100, h = 100) => ({ valid: true, width: w, height: h, baseTexture: { resource: { update() {} } }, frame: { x: 0, y: 0 }, destroy() {} });
globalThis.PIXI = {
  Texture: { from: () => fakeTex() },
  UPDATE_PRIORITY: { LOW: -25 },
  ColorMatrixFilter: class { destroy() {} },
  Container: class {}, Sprite: class {}, Point: class {},
};
const videos = [];
function fakeVideo() {
  const ls = {};
  const v = {
    muted: false, loop: false, paused: true, duration: 0.6, plays: 0, seeks0: 0, _t: 0, _src: null,
    get currentTime() { return this._t; }, set currentTime(x) { this._t = x; if (x === 0) this.seeks0++; },
    addEventListener(t, fn) { (ls[t] ??= []).push(fn); },
    removeEventListener() {},
    fire(t) { for (const fn of ls[t] ?? []) fn(); },
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; },
    end() { this.paused = true; this._t = this.duration; },
    removeAttribute() {}, load() {},
    set src(s) { this._src = s; queueMicrotask(() => this.fire("loadeddata")); }, get src() { return this._src; },
  };
  videos.push(v);
  return v;
}
const stubCtx = () => new Proxy({}, { get: () => () => ({ data: [] }) });
globalThis.document = {
  visibilityState: "visible",
  createElement: (tag) => tag === "video" ? fakeVideo() : { getContext: stubCtx, width: 0, height: 0, style: {} },
  getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} },
};
globalThis.window = globalThis;
const tokens = new Map();
const tickers = new Set();
globalThis.canvas = {
  ready: true,
  tokens: { get: (id) => tokens.get(id) ?? null, get placeables() { return [...tokens.values()]; }, controlled: [] },
  app: { ticker: { add(fn) { tickers.add(fn); }, remove(fn) { tickers.delete(fn); } } },
  stage: { scale: { x: 1 } },
};
globalThis.FUCompanion = { api: { vfxSuppressed: () => globalThis.document.visibilityState === "hidden" } };
globalThis.foundry = { utils: { deepClone: (o) => JSON.parse(JSON.stringify(o ?? {})), randomID: () => "abcdef" } };

function makeToken(id, { hp = 30, art = true } = {}) {
  const own = fakeTex();
  const props = { current_hp: hp, ...(art ? { sprite_hurt: `${id}-hurt.webm`, sprite_ko: `${id}-ko.webm`, sprite_attack: `${id}-atk.webm` } : {}) };
  const actor = { documentName: "Actor", isToken: false, system: { props }, effects: { contents: [] } };
  const token = {
    id, name: id, destroyed: false, actor, texture: own,
    document: { uuid: `Scene.S.Token.${id}`, flags: { [NS]: { directorSpawned: true } }, texture: { tint: 0xffffff, anchorX: 0.5, anchorY: 0.5, fit: "contain" }, rotation: 0 },
    mesh: { texture: own, scale: { x: 1, y: 1 }, pivot: { x: 0, y: 0 }, anchor: { set() {} }, tint: 0xffffff, filters: null, alpha: 1 },
    _refreshSize() {}, getSize: () => ({ width: 100, height: 100 }),
  };
  actor.getActiveTokens = () => [token];
  tokens.set(id, token);
  return token;
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const artVideo = (tok, pose) => videos.findLast((v) => v._src === `${tok.id}-${pose}.webm`);
const addEffect = (tok, e) => { tok.actor.effects.contents.push(e); Hooks.callAll("createActiveEffect", { ...e, parent: tok.actor }); };
const removeEffect = (tok, name) => {
  const i = tok.actor.effects.contents.findIndex((e) => e.name === name);
  const [e] = tok.actor.effects.contents.splice(i, 1);
  Hooks.callAll("deleteActiveEffect", { ...e, parent: tok.actor });
};
const KO_AE = { name: "KO", disabled: false, flags: { [NS]: { bdDefeated: true } } };
const CRISIS_AE = { name: "Crisis", disabled: false, flags: { [NS]: { bdCrisis: true } } };

const BP = await import("./battler-pose.js");
const { initShowHurt } = await import("./show-hurt.js");
const { buildOni } = await import("../anim-studio/oni-helpers.js");

clock.reset();
const A = makeToken("A"), B = makeToken("B"), NID = makeToken("NID", { art: false });
BP.initBattlerPose();
const ctl = initShowHurt();
await flush();
ok("hurt art loaded for A", artVideo(A, "hurt")?._src === "A-hurt.webm");
const desc = (t) => BP.describeToken(t);

// One show run on this client: a real oni with a pseudo-style ctx.
function showRun(scriptId, runId, { plan } = {}) {
  const msg = { scriptId, runId, ...(plan !== undefined ? { hpPlan: plan } : {}) };
  const ctx = { runId, msg, casterToken: NID, targetTokens: [A, B], params: { doneHook: `done.${runId}` } };
  return buildOni(ctx, { canvas: globalThis.canvas, PIXI: globalThis.PIXI, wait: (ms) => new Promise((r) => clock.setTimeout(r, ms)), loadTexture: async () => fakeTex(), fromUuid: async () => null, foundry: globalThis.foundry });
}
const fresh = () => { clock.reset(); clock.advance(5000); };   // past the 4 s engine-hurt memory
const uuid = (t) => t.document.uuid;
const engineHurt = (t, tier = "normal") => BP.playHurtPoseLocal(uuid(t), tier);

{ // 3a. WB: contact hold, frozen across a Crisis re-render, number = shake only, gate + 800
  const oni = showRun(WB, "wb1", { plan: { [uuid(A)]: true, [uuid(B)]: false } });
  let shown = null;
  const hk = Hooks.on("oni:hit", (d) => { shown = d; });
  clock.advance(2900);
  oni.hit({ tokenUuid: uuid(A), hit: true });
  Hooks.off("oni:hit", hk);
  eq("oni.hit carries scriptId + hurt from the plan", [shown.scriptId, shown.hurt, shown.runId], [WB, true, "wb1"]);
  eq("A shows hurt at contact", [desc(A).shown, desc(A).showHold], ["hurt", "held"]);
  oni.hit({ tokenUuid: uuid(B), hit: true });
  eq("B: hit:true but no HP loss -> no pose", desc(B).oneShot, null);
  const v = artVideo(A, "hurt");
  eq("clip started once", v.plays, 1);
  clock.advance(700); v.end();                       // the clip has ended, held on its last frame
  addEffect(A, CRISIS_AE);                           // the gate write adds Crisis -> re-render
  eq("Crisis mid-hold: still hurt, clip NOT replayed (frozen)", [desc(A).shown, v.plays, v.currentTime], ["hurt", 1, 0.6]);
  const tintBefore = A.mesh.tint;
  ok("engine hurt during the hold is taken by the pose", engineHurt(A, "strong") === true);
  eq("number during hold: no restart, no red tint", [v.plays, v.currentTime, A.mesh.tint === tintBefore], [1, 0.6, true]);
  ok("number during hold: a pivot shake runs", tickers.size > 0);
  for (const fn of [...tickers]) fn();
  eq("still held after the number (sustained)", desc(A).showHold, "held");
  clock.advance(5650 - 3600);
  oni.fireDone();                                    // the show's gate, heard on this client
  clock.advance(799);
  eq("held until gate + 800", desc(A).showHold, "held");
  clock.advance(1);
  eq("released at gate + 800 -> lasting crisis", [desc(A).oneShot, desc(A).showHold], [null, null]);
  oni.dispose();
  eq("WB leaves no controller timer / run", [ctl.stats().timers, ctl.stats().runs, ctl.stats().tokens], [0, 0, 0]);
  removeEffect(A, "Crisis");
}
{ // 3b. Claw brief: contact -> engine hurt -> normal end; lethal -> KO bridge
  fresh();
  const oni = showRun(CLAW, "cl1", { plan: { [uuid(A)]: true, [uuid(B)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  clock.advance(170);
  oni.hit({ tokenUuid: uuid(B), hit: true });
  eq("both held at their own contact", [desc(A).showHold, desc(B).showHold], ["held", "held"]);
  clock.advance(150); oni.fireDone();
  clock.advance(5000);
  eq("A still held at gate + 5 s (no gate margin any more)", desc(A).showHold, "held");
  clock.advance(1000);
  // A's number never came (RESOLVE zeroed it): the 6 s cap let it go
  eq("A capped at contact + 6 s with no number", desc(A).oneShot, null);
  eq("B capped too (no number came)", desc(B).oneShot, null);
  oni.dispose();
  // a second Claw: the number arrives in time, and it is lethal
  fresh();
  const o2 = showRun(CLAW, "cl2", { plan: { [uuid(A)]: true } });
  const v = artVideo(A, "hurt");
  const plays0 = v.plays;
  o2.hit({ tokenUuid: uuid(A), hit: true });
  clock.advance(320); o2.fireDone();
  clock.advance(300);
  A.actor.system.props.current_hp = 0;              // the write: lethal
  ok("engine hurt during brief hold taken, no restart", engineHurt(A) === true && v.plays === plays0 + 1);
  eq("brief now ending (frozen for the shake)", desc(A).showHold, "ending");
  clock.advance(290);
  eq("normal end ran: oneShot cleared", desc(A).oneShot, null);
  eq("lethal: the hurt frame stays shown waiting for the KO", desc(A).shown, "hurt");
  addEffect(A, KO_AE);
  eq("KO takes over from the held hurt frame", desc(A).shown, "ko");
  o2.dispose();
  clock.advance(5000);
  eq("brief path leaves no controller timer", [ctl.stats().timers, ctl.stats().tokens], [0, 0]);
  removeEffect(A, "KO");
  A.actor.system.props.current_hp = 30;
  eq("revive: back to idle, no stale hold", [desc(A).shown, desc(A).oneShot], ["idle", null]);
}
{ // 3b2. Proof-C defect 1: the last target's number lands 3.9 s after the gate (4-PC RESOLVE)
  fresh();
  const oni = showRun(CLAW, "late1", { plan: { [uuid(A)]: true } });
  const v = artVideo(A, "hurt");
  const plays0 = v.plays;
  oni.hit({ tokenUuid: uuid(A), hit: true });
  clock.advance(320); oni.fireDone();                       // gate
  clock.advance(3900);                                      // number not here yet: old cap (gate + 3000) is long gone
  eq("3.9 s after the gate: still held, not idle", [desc(A).shown, desc(A).showHold], ["hurt", "held"]);
  eq("one clip start so far", v.plays, plays0 + 1);
  ok("the late number is taken by the hold", engineHurt(A) === true);
  eq("no clip restart on the late number", v.plays, plays0 + 1);
  clock.advance(290 + 30);
  eq("released after its number (normal end)", [desc(A).oneShot, desc(A).shown], [null, "idle"]);
  eq("still one clip start in total", v.plays, plays0 + 1);
  oni.dispose();
  clock.advance(10000);
  eq("late number: no controller timer / run", [ctl.stats().timers, ctl.stats().runs, ctl.stats().tokens, clock.pending()], [0, 0, 0, 0]);
}
{ // 3b3. past the absolute 6 s cap, then a late number = one normal hurt (logged)
  fresh();
  const oni = showRun(CLAW, "late2", { plan: { [uuid(A)]: true } });
  const v = artVideo(A, "hurt");
  const plays0 = v.plays;
  oni.hit({ tokenUuid: uuid(A), hit: true });
  clock.advance(320); oni.fireDone();
  clock.advance(5679);
  eq("held at 5.999 s", desc(A).showHold, "held");
  clock.advance(1);
  eq("released at the 6 s cap, idle", [desc(A).oneShot, desc(A).shown], [null, "idle"]);
  ok("late number plays a normal hurt", engineHurt(A) === true && desc(A).oneShot === "hurt" && desc(A).showHold === null);
  eq("exactly one more clip start", v.plays, plays0 + 2);
  eq("logged late-engine-hurt-after-cap", ctl.log.some((x) => x.what === "late-engine-hurt-after-cap"), true);
  clock.advance(1000);
  oni.dispose();
  eq("cleanup", [ctl.stats().timers, ctl.stats().runs, ctl.stats().tokens, clock.pending()], [0, 0, 0, 0]);
}
{ // 3b4. Proof-C defect 2: lethal Claw, handover long before the KO (KO at +3.4 s)
  fresh();
  globalThis.ONI_BATTLER_POSE_DEBUG = true; globalThis.__battlerPoseTrace = [];
  const oni = showRun(CLAW, "leth1", { plan: { [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  clock.advance(320); oni.fireDone();
  A.actor.system.props.current_hp = 0;
  clock.advance(50);
  ok("number taken by the hold", engineHurt(A) === true);
  const tNumber = clock.now();
  clock.advance(290 + 30);
  eq("handover: hurt frame frozen", [desc(A).oneShot, desc(A).shown], [null, "hurt"]);
  clock.advance(1500 + 100);                                  // the old 1500 ms lethal timer would have fired here
  eq("past the old 1500 ms: still the frozen hurt frame", desc(A).shown, "hurt");
  clock.advance(3400 - (clock.now() - tNumber) - 1);
  eq("just before the KO: still hurt", desc(A).shown, "hurt");
  clock.advance(1);
  addEffect(A, KO_AE);                                        // the KO lands at +3.4 s
  eq("KO takes over", desc(A).shown, "ko");
  const seq = globalThis.__battlerPoseTrace.filter((e) => e.what === "render").map((e) => e.pose);
  eq("render sequence: hurt ... ko, never idle in between", seq.filter((x, i) => i === 0 || x !== seq[i - 1]), ["hurt", "ko"]);
  eq("lethal timer cleared by the KO", [clock.pending() > 0 && false, ctl.stats().timers], [false, 0]);
  oni.dispose();
  clock.advance(10000);
  eq("nothing pending after the KO path", clock.pending(), 0);
  removeEffect(A, "KO");
  // KO never comes: end at the 6 s cap, logged
  fresh();
  globalThis.__battlerPoseTrace = [];
  A.actor.system.props.current_hp = 30;
  const o2 = showRun(CLAW, "leth2", { plan: { [uuid(A)]: true } });
  o2.hit({ tokenUuid: uuid(A), hit: true });
  clock.advance(320); o2.fireDone();
  A.actor.system.props.current_hp = 0;
  engineHurt(A);
  clock.advance(290);                                        // shake tail (260 + 30) -> hand-over to the lethal bridge
  clock.advance(5999);
  eq("5.999 s after the hand-over: still frozen hurt", desc(A).shown, "hurt");
  clock.advance(1);
  eq("6 s cap (from the hand-over, number + 290 ms) with no KO: stands up normally", desc(A).shown, "idle");
  ok("...and it was logged", globalThis.__battlerPoseTrace.some((e) => e.what === "show-lethal-ko-never-came"));
  o2.dispose();
  A.actor.system.props.current_hp = 30;
  clock.advance(10000);
  eq("nothing pending after the cap path", [clock.pending(), ctl.stats().timers, ctl.stats().tokens], [0, 0, 0]);
  // non-show lethal hurt keeps the 1500 ms bridge
  fresh();
  A.actor.system.props.current_hp = 0;
  engineHurt(A);
  clock.advance(700);
  eq("non-show lethal: frame held after the clip", [desc(A).oneShot, desc(A).shown], [null, "hurt"]);
  clock.advance(1500);
  eq("non-show lethal: stands up after 1500 ms (unchanged)", desc(A).shown, "idle");
  A.actor.system.props.current_hp = 30;
  clock.advance(10000);
  eq("nothing pending (non-show lethal)", clock.pending(), 0);
  globalThis.ONI_BATTLER_POSE_DEBUG = false;
}
{ // 3c. KO guards
  fresh();
  BP.playBattlerPoseLocal({ tokenUuid: uuid(A), pose: "ko", hold: true });   // staged KO (Life Charm)
  const oni = showRun(CLAW, "ko1", { plan: { [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  eq("staged KO stays down", [desc(A).oneShot, desc(A).shown, desc(A).showHold], ["ko", "ko", null]);
  BP.playBattlerPoseLocal({ tokenUuid: uuid(A), pose: "idle" });
  addEffect(B, KO_AE);
  oni.hit({ tokenUuid: uuid(B), hit: true });
  eq("lasting KO never poses", [desc(B).shown, desc(B).showHold], ["ko", null]);
  removeEffect(B, "KO");
  oni.dispose();
  eq("KO guards leave nothing", [ctl.stats().tokens, ctl.stats().timers], [0, 0]);
}
{ // 3d. KO arriving during a hold drops it (no resurfacing on revive)
  fresh();
  const oni = showRun(WB, "ko2", { plan: { [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  addEffect(A, KO_AE);
  eq("KO mid-hold: KO shown, hold gone, controller cleared", [desc(A).shown, desc(A).oneShot, ctl.stats().tokens, ctl.stats().timers], ["ko", null, 0, 0]);
  removeEffect(A, "KO");
  eq("revive after a KO mid-hold: idle", desc(A).shown, "idle");
  oni.dispose();
}
{ // 3e. ownership: a reaction's attack pose replaces the hold; release must not end it
  fresh();
  const oni = showRun(WB, "own1", { plan: { [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  BP.playBattlerPoseLocal({ tokenUuid: uuid(A), pose: "attack" });
  eq("attack replaced the hold; controller dropped it", [desc(A).oneShot, ctl.stats().tokens, ctl.stats().timers], ["attack", 0, 0]);
  oni.fireDone(); clock.advance(100);
  oni.dispose();
  eq("show end does not cut the attack pose", desc(A).oneShot, "attack");
  const fake = { tokenId: "A", record: { show: { dropped: false } } };
  eq("release of a foreign record is refused", BP.releaseShowHurtHold(fake), false);
  clock.advance(5000);
  eq("attack ends on its own", desc(A).oneShot, null);
}
{ // 3f. order B: the engine hurt arrives before this client's contact
  fresh();
  const v = artVideo(A, "hurt");
  ok("engine hurt first (normal one-shot)", engineHurt(A) === true && desc(A).oneShot === "hurt" && desc(A).showHold === null);
  const plays = v.plays, seeks = v.seeks0;
  const oni = showRun(CLAW, "b1", { plan: { [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  eq("brief: the running hurt is left alone (no restart, no hold)", [v.plays, v.seeks0, desc(A).showHold], [plays, seeks, null]);
  clock.advance(700);
  eq("...and ends on its own timer", desc(A).oneShot, null);
  oni.dispose(); clock.advance(1000);
  engineHurt(A);
  const plays2 = v.plays, seeks2 = v.seeks0;
  const o2 = showRun(WB, "b2", { plan: { [uuid(A)]: true } });
  o2.hit({ tokenUuid: uuid(A), hit: true });
  eq("sustained: its number already landed -> no hold, no restart", [v.plays, v.seeks0, desc(A).showHold], [plays2, seeks2, null]);
  eq("...logged skip:engine-hurt-already-seen", ctl.log.at(-1).what, "skip:engine-hurt-already-seen");
  clock.advance(3000);
  eq("the running hurt ended on its own timer", desc(A).oneShot, null);
  o2.fireDone(); clock.advance(800);
  o2.dispose();
  eq("order B leaves nothing", [ctl.stats().tokens, ctl.stats().timers, ctl.stats().runs], [0, 0, 0]);
}
{ // 3g. no plan on this client / unlisted show / hidden tab
  fresh();
  const o1 = showRun(WB, "np1");
  o1.hit({ tokenUuid: uuid(A), hit: true });
  eq("no plan on this client -> no contact pose", desc(A).oneShot, null);
  ok("...and the number still plays today's hurt", engineHurt(A) === true && desc(A).oneShot === "hurt" && desc(A).showHold === null);
  clock.advance(1000);
  o1.dispose();
  const o2 = showRun("oni.other.show", "np2", { plan: { [uuid(A)]: true } });
  o2.hit({ tokenUuid: uuid(A), hit: true });
  eq("unlisted show -> no pose", desc(A).oneShot, null);
  o2.dispose();
  globalThis.document.visibilityState = "hidden";
  const o3 = showRun(WB, "np3", { plan: { [uuid(A)]: true } });
  o3.hit({ tokenUuid: uuid(A), hit: true });
  globalThis.document.visibilityState = "visible";
  eq("hidden tab -> no pose", desc(A).oneShot, null);
  o3.dispose();
}
{ // 3h. token deleted / canvas torn down mid-hold
  fresh();
  const C = makeToken("C");
  Hooks.callAll("drawToken", C);
  await flush();
  const oni = showRun(WB, "del1", { plan: { [uuid(C)]: true, [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(C), hit: true });
  eq("C held", desc(C).showHold, "held");
  Hooks.callAll("destroyToken", C);
  tokens.delete("C");
  eq("token deleted: controller cleared", [ctl.stats().tokens, ctl.stats().timers], [0, 0]);
  oni.hit({ tokenUuid: uuid(A), hit: true });
  eq("A held", desc(A).showHold, "held");
  Hooks.callAll("canvasTearDown");
  eq("canvas teardown: every hold and timer gone", [ctl.stats().tokens, ctl.stats().timers, ctl.stats().runs], [0, 0, 0]);
  oni.dispose();
  clock.advance(20000);
  eq("no stray timer after the teardown", clock.pending(), 0);
}
{ // 3i. dispose emits once per pseudo run, carries runId; no runId = silent
  let n = 0, last = null;
  const hk = Hooks.on("oni:runDisposed", (d) => { n++; last = d; });
  const oni = showRun(WB, "d1");
  oni.dispose(); oni.dispose();
  const plain = buildOni({ casterToken: NID, targetTokens: [], params: {} }, { canvas: globalThis.canvas, PIXI: globalThis.PIXI, wait: async () => {}, loadTexture: async () => null, fromUuid: async () => null, foundry: globalThis.foundry });
  plain.dispose();
  Hooks.off("oni:runDisposed", hk);
  eq("runDisposed fires once with runId + scriptId", [n, last?.runId, last?.scriptId], [1, "d1", WB]);
  let g = null;
  const hg = Hooks.on("oni:showGate", (d) => { g = d; });
  let doneHeard = 0;
  const hd = Hooks.on("done.d2", () => { doneHeard++; });
  showRun(SF, "d2").fireDone();
  Hooks.off("oni:showGate", hg); Hooks.off("done.d2", hd);
  eq("fireDone: doneHook still fires + showGate carries runId/scriptId", [doneHeard, g?.runId, g?.scriptId], [1, "d2", SF]);
  let off = null;
  const ho = Hooks.on("oni:impactOffsets", (d) => { off = d; });
  showRun(SF, "d3").impactOffsets({ x: 5 });
  Hooks.off("oni:impactOffsets", ho);
  eq("impactOffsets carries scriptId", [off?.runId, off?.scriptId, off?.offsets?.x], ["d3", SF, 5]);
}

// ── 3j. pseudo.play attaches the GM's plan to the message ────────────────
{
  const src = readFileSync(fileURLToPath(new URL("../pseudo-animation/pseudoAnimation-core.js", import.meta.url)), "utf8");
  const sent = [];
  const local = [];
  let initFn = null;
  const g = {
    console, Date, Math, JSON, Promise,
    Hooks: { once: (n, fn) => { if (n === "init") initFn = fn; } },
    foundry: globalThis.foundry,
    ui: { notifications: { warn() {} } },
    window: {},
  };
  g.game = { user: { id: "gm", name: "GM" }, socket: { emit: (_ns, m) => sent.push(m) }, ONI: { pseudo: { _receive: async (m) => { local.push(m); } } } };
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(src, g);
  initFn();
  const api = g.game.ONI.pseudo;
  g.game.ONI.pseudo._receive = async (m) => { local.push(m); };
  api.play({ scriptId: WB, params: {} });
  eq("no plan published -> message has none", "hpPlan" in sent[0], false);
  g.__ONI_SHOW_HP_PLAN__ = { plan: { [uuid(A)]: true }, runId: 1 };
  api.play({ scriptId: WB, params: {} });
  eq("published plan rides the broadcast", sent[1].hpPlan, { [uuid(A)]: true });
  await flush();
  eq("...and the sender's own local run", local.at(-1)?.hpPlan, { [uuid(A)]: true });
  g.__ONI_SHOW_HP_PLAN__ = null;
}

// ── 3l. Review Q1 / Q3 on the real pose ─────────────────────────────────
{ // WB: the number lands AFTER gate + 800 (slow RESOLVE): hold keeps the frame, number shakes, then idle; one clip start
  Hooks.callAll("drawToken", A); Hooks.callAll("drawToken", B); await flush();   // 3h tore the canvas down
  for (const id of ["d2", "d3"]) Hooks.callAll("oni:runDisposed", { runId: id });   // 3i left two undisposed probe runs
  fresh();
  const v = artVideo(A, "hurt");
  const plays0 = v.plays;
  const oni = showRun(WB, "q1a", { plan: { [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  clock.advance(3400); oni.fireDone();
  clock.advance(800 + 1200);
  eq("past gate + 800, number not here: still hurt, held", [desc(A).shown, desc(A).showHold], ["hurt", "held"]);
  ok("the late number is taken by the hold", engineHurt(A) === true);
  eq("no clip restart on the late number (one start total)", v.plays, plays0 + 1);
  clock.advance(289);
  eq("held through the number's tail", desc(A).showHold, "held");
  clock.advance(1);
  eq("then released to idle exactly once", [desc(A).oneShot, desc(A).shown], [null, "idle"]);
  clock.advance(5000);
  eq("nothing restarts afterwards", v.plays, plays0 + 1);
  oni.dispose();
  eq("cleanup stats {runs:0,tokens:0,timers:0}", ctl.stats(), { runs: 0, tokens: 0, timers: 0 });
}
{ // WB: no number ever -> cap 9 s -> idle; the number after that is one normal hurt (the accepted restart)
  fresh();
  const v = artVideo(A, "hurt");
  const oni = showRun(WB, "q1b", { plan: { [uuid(A)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  const plays0 = v.plays;
  clock.advance(1000); oni.fireDone();
  clock.advance(9000);
  eq("cap released the hold to idle", [desc(A).oneShot, desc(A).shown], [null, "idle"]);
  ok("late number after the cap plays ONE normal hurt", engineHurt(A) === true && desc(A).oneShot === "hurt" && desc(A).showHold === null && v.plays === plays0 + 1);
  ok("...and the restart was logged", ctl.log.some((x) => x.what === "late-engine-hurt-after-cap"));
  clock.advance(1000);
  oni.dispose();
  eq("cleanup stats", ctl.stats(), { runs: 0, tokens: 0, timers: 0 });
}
{ // Claw after Skip Animation / slow client: the number landed first, contact later -> no pose; abort hook -> no new holds
  fresh();
  const v = artVideo(A, "hurt");
  engineHurt(A);
  clock.advance(1500);
  const plays0 = v.plays;
  const oni = showRun(CLAW, "q3a", { plan: { [uuid(A)]: true, [uuid(B)]: true } });
  oni.hit({ tokenUuid: uuid(A), hit: true });
  eq("contact after its number: no hold, no restart", [desc(A).showHold, v.plays], [null, plays0]);
  Hooks.callAll("oni:showAborted", { runId: "q3a" });
  oni.hit({ tokenUuid: uuid(B), hit: true });
  eq("aborted run: B gets no hold", desc(B).oneShot, null);
  eq("logged skip:aborted", ctl.log.at(-1).what, "skip:aborted");
  clock.advance(3000);
  oni.fireDone();
  oni.dispose();
  clock.advance(10000);
  eq("cleanup stats (abort path)", ctl.stats(), { runs: 0, tokens: 0, timers: 0 });
  eq("no stray timer", clock.pending(), 0);
}

// ── 3k. wiring contracts (source) ────────────────────────────────────────
{
  const DA = readFileSync(fileURLToPath(new URL("./director-animation.js", import.meta.url)), "utf8");
  const BOOT = readFileSync(fileURLToPath(new URL("./director-boot.js", import.meta.url)), "utf8");
  ok("FSM path passes the plan", /hpPlan: showHpPlanFor\(director\),/.test(DA));
  ok("no plan in SimMode", /function showHpPlanFor\(director\) \{\s*if \(SimMode\.active\) return null;/.test(DA));
  ok("plan published before the script, cleared at the gate",
    DA.indexOf("publishShowHpPlan(hpPlan, animRunId)") > 0 && DA.indexOf("publishShowHpPlan(hpPlan, animRunId)") < DA.indexOf("const result = fn(payload, targets);")
    && /try \{ await gatePromise; \}\s*finally \{ clearShowHpPlan\(hpPlanSlot\); \}/.test(DA));
  ok("reaction path / preview never pass a plan", (DA.match(/hpPlan:/g) ?? []).length === 1);
  ok("boot installs show-hurt", /initShowHurt\(\);/.test(BOOT));
}

console.log(`\n${passed} passed, ${failed} failed`);
// an imported module (anim stage / timeline) keeps a live handle: exit explicitly
process.exit(failed ? 1 : 0);
