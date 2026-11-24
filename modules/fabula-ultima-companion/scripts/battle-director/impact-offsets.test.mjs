// ============================================================================
// Per-target impact offsets — staggered impact presentation.
//
//     node scripts/battle-director/impact-offsets.test.mjs
//
// 1. The pure module (impact-offsets.js): normalize, the collector's caster
//    scope, take-once matched to the action id, the presenter's anchor + delays
//    on a fake clock, drain / flush / cap, and "no offsets = run now".
// 2. applyDamageToTarget (skill-effects.js), lifted out of the module by its
//    source text and run against stubs: with a deferral every HP write happens
//    NOW and every presentation call (number, bar, on-hit defeat) waits; without
//    one the presentation runs inline exactly as before.
// 3. Wiring contracts that need a live director (source checks): RESOLVE passes
//    the presenter + drains it before settleInstance, the director collects the
//    report, oni exposes impactOffsets, and the shipped Soulflare reports its
//    bolt offsets before its gate.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const M = await import("./impact-offsets.js");
const {
  normalizeImpactOffsets, armImpactOffsetsCollector, takeImpactOffsets,
  createImpactPresenter, deferVfxTable, rememberImpactPresenter, drainImpactPresentation,
  IMPACT_OFFSETS_HOOK, MAX_IMPACT_OFFSET_MS, IMPACT_SETTLE_CAP_MS,
} = M;

let failed = 0, passed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failed++;
  console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
}
function ok(label, cond) { eq(label, !!cond, true); }

// ── fake clock ───────────────────────────────────────────────────────────────
function fakeClock() {
  let t = 1000;
  let timers = [];
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + Math.max(0, ms), fn }); return id; },
    clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const nx = timers[0];
        if (!nx || nx.at > end) break;
        timers.shift();
        t = nx.at;
        nx.fn();
      }
      t = end;
    },
    get count() { return timers.length; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── 1a. normalize ────────────────────────────────────────────────────────────
eq("normalize null", normalizeImpactOffsets(null), null);
eq("normalize array", normalizeImpactOffsets([1, 2]), null);
eq("normalize empty", normalizeImpactOffsets({}), null);
eq("normalize drops bad", normalizeImpactOffsets({ a: 0, b: -5, c: "x", "": 9, d: 156.4, e: NaN }), { a: 0, d: 156 });
eq("normalize clamps", normalizeImpactOffsets({ a: 99999 }), { a: MAX_IMPACT_OFFSET_MS });
eq("normalize numeric strings", normalizeImpactOffsets({ a: "320" }), { a: 320 });

// ── 1b. collector ────────────────────────────────────────────────────────────
{
  const listeners = new Map();
  const hooks = {
    on: (n, f) => { listeners.set(n, [...(listeners.get(n) ?? []), f]); },
    off: (n, f) => { listeners.set(n, (listeners.get(n) ?? []).filter((x) => x !== f)); },
    call: (n, d) => { for (const f of listeners.get(n) ?? []) f(d); },
  };
  const c = armImpactOffsetsCollector({ casterTokenUuid: "Scene.s.Token.N", hooks });
  eq("collector hook name", IMPACT_OFFSETS_HOOK, "oni:impactOffsets");
  hooks.call(IMPACT_OFFSETS_HOOK, { casterTokenUuid: "Scene.s.Token.OTHER", offsets: { x: 50 } });
  eq("collector ignores another caster", c.offsets, null);
  hooks.call(IMPACT_OFFSETS_HOOK, { casterTokenUuid: "Scene.s.Token.N", offsets: { a: 0, b: 156, c: 320 } });
  eq("collector hears its caster", c.offsets, { a: 0, b: 156, c: 320 });
  hooks.call(IMPACT_OFFSETS_HOOK, { offsets: { a: 0, b: 100 } });
  eq("collector accepts no-caster payload, last wins", c.offsets, { a: 0, b: 100 });
  eq("collector stop returns heard", c.stop(), { a: 0, b: 100 });
  eq("collector unhooked", (listeners.get(IMPACT_OFFSETS_HOOK) ?? []).length, 0);
  hooks.call(IMPACT_OFFSETS_HOOK, { offsets: { z: 1 } });
  eq("collector deaf after stop", c.offsets, { a: 0, b: 100 });
  const none = armImpactOffsetsCollector({ hooks: null });
  eq("collector without hooks", none.stop(), null);
}

// ── 1c. take once, matched to the action ─────────────────────────────────────
{
  const d = { ctx: { animImpactOffsets: { actionId: "A1", offsets: { a: 0, b: 150 } } } };
  eq("take: other action -> null", takeImpactOffsets(d, { _instanceId: "A2" }), null);
  ok("take: other action leaves the entry", d.ctx.animImpactOffsets);
  eq("take: no action id -> null", takeImpactOffsets(d, {}), null);
  eq("take: matching", takeImpactOffsets(d, { _instanceId: "A1" }), { a: 0, b: 150 });
  eq("take: consumed", d.ctx.animImpactOffsets, null);
  eq("take: second time null", takeImpactOffsets(d, { _instanceId: "A1" }), null);
  eq("take: no director", takeImpactOffsets(null, { _instanceId: "A1" }), null);
  const d2 = { ctx: { animImpactOffsets: { actionId: null, offsets: { a: 5 } } } };
  eq("take: entry without id never matches", takeImpactOffsets(d2, { _instanceId: "A1" }), null);
}

// ── 1d. presenter ────────────────────────────────────────────────────────────
{
  // inactive: runs inline, nothing scheduled
  const clk = fakeClock();
  const p = createImpactPresenter(null, clk);
  const log = [];
  p.present("a", () => log.push("a"));
  eq("inactive presents inline", log, ["a"]);
  eq("inactive forTarget is null", p.forTarget("a"), null);
  eq("inactive nothing pending", p.pendingCount, 0);
  eq("inactive not active", p.active, false);
  let drained = false;
  await p.drain().then(() => { drained = true; });
  ok("inactive drain resolves at once", drained);
}
{
  // active: anchor = first present; delays keep the animation's spacing
  const clk = fakeClock();
  const p = createImpactPresenter({ T1: 0, T2: 156, T3: 320 }, clk);
  const log = [];
  const at = (k) => () => log.push(k + "@" + (clk.now() - 1000));
  clk.advance(40);                       // RESOLVE latency before the first write
  p.present("T1", at("n1"));             // offset 0 -> now (anchor = 40)
  p.present("T1", at("bar1"));
  clk.advance(25);                       // target 2's write takes 25 ms
  p.present("T2", at("n2"));
  p.present("T2", at("bar2"));
  clk.advance(30);
  p.present("T3", at("miss3"));
  p.present("T9", at("unlisted"));       // a target the script left out -> now
  eq("active: listed offsets pending", p.pendingCount, 3);
  eq("active: immediate ones ran", log, ["n1@40", "bar1@40", "unlisted@95"]);
  let drained = false;
  const dr = p.drain().then(() => { drained = true; });
  clk.advance(101);
  eq("active: T2 at anchor+156", log.slice(3), ["n2@196", "bar2@196"]);
  await tick();
  ok("drain still waiting on T3", !drained);
  clk.advance(200);
  eq("active: T3 at anchor+320", log.slice(5), ["miss3@360"]);
  await dr;
  ok("drain resolved once all ran", drained);
  eq("offsetFor", [p.offsetFor("T2"), p.offsetFor("nope")], [156, 0]);
}
{
  // a late write (past its own offset) presents at once, never early
  const clk = fakeClock();
  const p = createImpactPresenter({ A: 0, B: 50 }, clk);
  const log = [];
  p.present("A", () => log.push("A"));
  clk.advance(80);
  p.present("B", () => log.push("B@" + (clk.now() - 1000)));
  eq("late write presents now", log, ["A", "B@80"]);
}
{
  // flush + drain cap
  const clk = fakeClock();
  const p = createImpactPresenter({ A: 0, B: 300 }, clk);
  const log = [];
  p.present("A", () => log.push("A"));
  p.present("B", () => log.push("B"));
  p.flush();
  eq("flush runs pending now", log, ["A", "B"]);
  eq("flush cleared", p.pendingCount, 0);
  clk.advance(1000);
  eq("flushed fn not run twice", log, ["A", "B"]);

  const p2 = createImpactPresenter({ A: 0, B: 300 }, clk);
  p2.present("A", () => {});
  p2.present("B", () => log.push("B2"));
  let done = false;
  p2.drain({ capMs: 100 }).then(() => { done = true; });
  clk.advance(100);
  await tick();
  ok("drain cap flushes + resolves", done && log.includes("B2"));
}
{
  // a presentation that throws does not break the others
  const clk = fakeClock();
  const p = createImpactPresenter({ A: 0, B: 10 }, clk);
  const log = [];
  const prevWarn = console.warn; console.warn = () => {};
  p.present("A", () => { throw new Error("x"); });
  p.present("A", () => log.push("A2"));
  p.present("B", () => { throw new Error("y"); });
  p.present("B", () => log.push("B2"));
  clk.advance(20);
  console.warn = prevWarn;
  eq("throwing presentation isolated", log, ["A2", "B2"]);
}
try {
  // settle (forTarget's mode): present's promise and drain wait for the
  // thenable the presentation returned (the vfx bridge's import chain)
  const clk = fakeClock();
  const p = createImpactPresenter({ A: 0, B: 50 }, clk);
  let rel; const th = new Promise((r) => { rel = r; });
  let doneB = false, drained = false;
  const pr = p.present("B", () => th, { settle: true });
  ok("active present returns a promise", pr && typeof pr.then === "function");
  pr.then(() => { doneB = true; });
  p.drain().then(() => { drained = true; });
  clk.advance(50); await tick();
  ok("settle: not done before its thenable settles", !doneB && !drained);
  rel(); await tick();
  ok("settle: done + drained once it settled", doneB && drained);
  const p2 = createImpactPresenter({ A: 0 }, clk);
  let d2 = false;
  p2.present("A", () => new Promise(() => {}), { settle: true }).then(() => { d2 = true; });
  clk.advance(IMPACT_SETTLE_CAP_MS); await tick();
  ok("settle cap releases a hung thenable", d2);
  const p3 = createImpactPresenter({ A: 0 }, clk);
  let d3 = false;
  p3.present("A", () => new Promise(() => {})).then(() => { d3 = true; });
  await tick();
  ok("no settle: resolves once run (a rider cosmetic is never waited on)", d3);
  eq("inactive present returns undefined", createImpactPresenter(null, clk).present("a", () => 1), undefined);
  const held = [];
  const pf = createImpactPresenter({ T: 40 }, clk);
  pf.present("X", () => {});                     // anchor
  const fr = pf.forTarget("T")(() => { held.push("T"); return Promise.resolve(); });
  let df = false; fr.then(() => { df = true; });
  clk.advance(40); await tick();
  ok("forTarget's promise resolves after its presentation ran + settled", df && held.length === 1);
} catch (e) { failed++; console.log(`FAIL  settle block threw: ${e?.message}`); }
{
  // deferVfxTable
  const calls = [];
  const deferred = [];
  const t = deferVfxTable({ loss: (o, after) => calls.push(["loss", o.amount, typeof after]), bar: (o) => calls.push(["bar", o.hpAfter]) }, (fn) => deferred.push(fn));
  t.loss({ amount: 7 }, () => {});
  t.bar({ hpAfter: 3 });
  eq("deferVfxTable defers", calls, []);
  deferred.forEach((f) => f());
  eq("deferVfxTable forwards args", calls, [["loss", 7, "function"], ["bar", 3]]);
  eq("deferVfxTable null table", deferVfxTable(null, () => {}), null);
  const raw = { loss: () => {} };
  eq("deferVfxTable no defer returns same", deferVfxTable(raw, null) === raw, true);
}
{
  // director drain registry
  const clk = fakeClock();
  const dir = {};
  const p = createImpactPresenter({ A: 0, B: 200 }, clk);
  rememberImpactPresenter(dir, p);
  rememberImpactPresenter(dir, createImpactPresenter(null, clk));   // inactive: not kept
  const log = [];
  p.present("A", () => log.push("A"));
  p.present("B", () => log.push("B"));
  let held = null;
  const d = drainImpactPresentation(dir).then((ms) => { held = ms; });
  clk.advance(200);
  await d;
  eq("registry drain waited for B", log, ["A", "B"]);
  ok("registry drain returned a number", typeof held === "number");
  eq("registry emptied", await drainImpactPresentation(dir), 0);
  eq("registry no director", await drainImpactPresentation(null), 0);
}

// ── 2. applyDamageToTarget lifted from skill-effects.js ──────────────────────
const DF = await import("./deferred-followups.js");
const SE_SRC = readFileSync(fileURLToPath(new URL("./skill-effects.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
function liftApplyDamage(stubs) {
  const start = SE_SRC.indexOf("export async function applyDamageToTarget(");
  const end = SE_SRC.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("applyDamageToTarget not found");
  const body = SE_SRC.slice(start, end + 2).replace(/^export /, "");
  const names = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn applyDamageToTarget;`)(...names.map((n) => stubs[n]));
}
function makeHarness() {
  const events = [];
  const stubs = {
    log: () => {}, warn: () => {},
    flushPendingFollowUpsFor: DF.flushPendingFollowUpsFor,
    readPropNum: (a, keys, dflt = 0) => { for (const k of keys) { const v = a.system.props[k]; if (v != null) return Number(v); } return dflt; },
    resolveDamageReactions: async ({ curHp, rawDamage }) => ({ newHp: Math.max(0, curHp - rawDamage), dealtDamage: rawDamage, consumedAeIds: [], fired: [], followUp: [] }),
    floorHp: (hp) => hp, actorHpFloor: () => null,
    buildDamageRow: (x) => x, applyEffectRow: async () => {},
    fireResourceLossVfx: (o, after) => { events.push(`loss:${o.tokenUuid}:${o.amount}`); after?.(); },
    fireAbsorbVfx: (o) => events.push(`absorb:${o.tokenUuid}`),
    fireNpcHpBar: (o) => events.push(`bar:${o.tokenUuid}:${o.hpAfter}`),
    fireBlockVfx: (o) => events.push(`block:${o.tokenUuid}`),
    fireImmuneVfx: (o) => events.push(`immune:${o.tokenUuid}`),
    fireDefeatOnHit: (o) => events.push(`defeat:${o.tokenUuid}`),
    deferVfxTable,
  };
  const actor = (hp) => ({
    system: { props: { current_hp: hp, max_hp: 100, shield_value: 0 } },
    effects: { get: () => null },
    getActiveTokens: () => [],
    async update(u) { events.push(`write:${u["system.props.current_hp"]}`); this.system.props.current_hp = u["system.props.current_hp"]; },
  });
  return { events, apply: liftApplyDamage(stubs), actor };
}
{
  // no deferral: today's order — write, number, defeat, bar, all inline
  const h = makeHarness();
  await h.apply({ target: h.actor(10), damage: 10, tokenUuid: "T2" });
  eq("no deferral: presentation inline after the write", h.events, ["write:0", "loss:T2:10", "defeat:T2", "bar:T2:0"]);
}
{
  // deferral: the write lands now, every presentation (and the on-hit defeat) waits
  const h = makeHarness();
  const held = [];
  await h.apply({ target: h.actor(10), damage: 10, tokenUuid: "T2", deferPresentation: (fn) => held.push(fn) });
  eq("deferral: only the write ran", h.events, ["write:0"]);
  eq("deferral: number + bar held", held.length, 2);
  held.forEach((f) => f());
  eq("deferral: presented later, defeat after its number", h.events, ["write:0", "loss:T2:10", "defeat:T2", "bar:T2:0"]);
}
{
  // MP path + immune path also go through the deferral
  const h = makeHarness();
  const held = [];
  const t = h.actor(50); t.system.props.current_mp = 20;
  t.update = async (u) => { h.events.push(`writeMp:${u["system.props.current_mp"]}`); };
  await h.apply({ target: t, damage: 5, resource: "mp", tokenUuid: "M", deferPresentation: (fn) => held.push(fn) });
  await h.apply({ target: h.actor(50), damage: 0, affinity: "IM", tokenUuid: "I", deferPresentation: (fn) => held.push(fn) });
  eq("deferral: mp write now, immune nothing yet", h.events, ["writeMp:15"]);
  held.forEach((f) => f());
  eq("deferral: mp + immune presented later", h.events, ["writeMp:15", "loss:M:5", "immune:I"]);
}
{
  // silent (Chain commit) stays silent even with a deferral
  const h = makeHarness();
  const held = [];
  await h.apply({ target: h.actor(10), damage: 3, tokenUuid: "S", silent: true, deferPresentation: (fn) => held.push(fn) });
  eq("silent + deferral: nothing presented", [h.events, held.length], [["write:7"], 0]);
}
{
  // end to end with the presenter: 3 targets written back to back, numbers at +0/+156/+320
  const h = makeHarness();
  const clk = fakeClock();
  const p = createImpactPresenter({ T1: 0, T2: 156, T3: 320 }, clk);
  const stamp = [];
  const orig = h.events.push.bind(h.events);
  h.events.push = (e) => { stamp.push(`${e}@${clk.now() - 1000}`); return orig(e); };
  for (const [u, hp] of [["T1", 40], ["T2", 40], ["T3", 5]]) {
    await h.apply({ target: h.actor(hp), damage: 10, tokenUuid: u, deferPresentation: p.forTarget(u) });
    clk.advance(10);
  }
  eq("e2e: all writes first", stamp.filter((s) => s.startsWith("write")), ["write:30@0", "write:30@10", "write:0@20"]);
  clk.advance(400);
  eq("e2e: presentation per target offset", stamp.filter((s) => !s.startsWith("write")),
    ["loss:T1:10@0", "bar:T1:30@0", "loss:T2:10@156", "bar:T2:30@156", "loss:T3:10@320", "defeat:T3@320", "bar:T3:0@320"]);
}

// ── 3. wiring contracts (need a live director, so read the source) ───────────
const SH = readFileSync(fileURLToPath(new URL("./state-handlers.js", import.meta.url)), "utf8");
const DA = readFileSync(fileURLToPath(new URL("./director-animation.js", import.meta.url)), "utf8");
const ONI = readFileSync(fileURLToPath(new URL("../anim-studio/oni-helpers.js", import.meta.url)), "utf8");
ok("RESOLVE builds the presenter from this action's offsets (not for a Chain)",
  /createImpactPresenter\(chainShown \? null : takeImpactOffsets\(director, ar\)\)/.test(SH));
ok("RESOLVE hands each target its deferral", /deferPresentation: impactPresenter\.forTarget\(r\.tokenUuid\)/.test(SH));
eq("RESOLVE miss + block go through the presenter",
  (SH.match(/impactPresenter\.present\(r\.tokenUuid, \(\) => play(Miss|Block)Vfx/g) ?? []).length, 3);
{
  const iDrain = SH.indexOf("await drainImpactPresentation(director)");
  const iSettle = SH.indexOf('const { settleInstance } = await import("./instance-settle.js");', iDrain);
  ok("RESOLVE drains before settleInstance (defeats)", iDrain > 0 && iSettle > iDrain && iSettle - iDrain < 1200);
  const iEnd = SH.indexOf("try { endHitCounter({ id: ar._instanceId ?? null }); }", iDrain - 2000);
  ok("RESOLVE closes the hit counter AFTER the drain (counts at render)", iEnd > iDrain && iEnd < iSettle);
}
ok("Animation.onEnter clears a previous action's offsets", /director\.ctx\.animImpactOffsets = null;/.test(SH));
ok("director arms the collector (not for a Chain)", /chainPlan \? null : armImpactOffsetsCollector\(\{ casterTokenUuid \}\)/.test(DA));
ok("director keeps offsets only for a run that played, unskipped, for this action",
  /heard && ran && !aborted && _actionId != null/.test(DA));
ok("oni.impactOffsets fires the hook", /Hooks\.callAll\("oni:impactOffsets"/.test(ONI));
ok("oni api exports impactOffsets", /hit, hitstop, strikes, impactOffsets,/.test(ONI));

// The shipped Soulflare reports per-bolt offsets (hitAt - first hit) before its gate.
const SF = readFileSync(fileURLToPath(new URL("../../../../tools/anim-studio/nidhogg-soulflare.js", import.meta.url)), "utf8");
{
  const iRep = SF.indexOf("oni.impactOffsets(offs)");
  const iFrameGate = SF.indexOf("if (GATE_FIRST && g.rank === 0) { gate();");
  const iWaitGate = SF.indexOf("await wait(GATE_FALLBACK);");
  ok("Soulflare reports offsets", iRep > 0);
  ok("Soulflare reports before any gate call", iRep > 0 && iRep < iWaitGate && iRep > SF.indexOf("const GATE_FALLBACK"));
  ok("Soulflare offsets = hitAt - FIRST_HIT", /offs\[g\.tok\.document\.uuid\] = Math\.max\(0, g\.hitAt - FIRST_HIT\)/.test(SF));
  ok("Soulflare gate still on the first bolt", iFrameGate > 0);
  ok("Soulflare guards an older engine", /typeof oni\.impactOffsets === "function"/.test(SF));
}

// ── 4. resolveAction's damage loop + step 6, run for real ────────────────────
// The section of resolveAction from the damage resource to step 6b is lifted
// out of state-handlers.js by its source text and run in a `with` scope of
// stubs, together with the real applyDamageToTarget (section 2's lift), the
// real presenter (real timers) and the real hit counter. The number bridge
// mimics fireResourceLossVfx: a lazy import, THEN the number renders (that is
// when the hit counter counts it). Catches what section 3's source checks
// cannot: the counter's close, follow-ups and step-6 reactions vs the delayed
// numbers.
{
  // hit counter DOM stub (as in chain-plan.test.mjs)
  const el = () => ({
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    style: {}, textContent: "", innerHTML: "", offsetWidth: 0, childElementCount: 0,
    querySelector() { return this._child ??= el(); }, getBoundingClientRect() { return { bottom: 0 }; },
  });
  const root = el();
  let created = false;
  globalThis.document ??= {
    getElementById: (id) => (id === "fud-hit-counter" && created ? root : null),
    createElement: () => { created = true; return root; },
    head: { appendChild() {} }, body: { appendChild() {} },
  };
  globalThis.window ??= { innerHeight: 800 };
  globalThis.requestAnimationFrame ??= (fn) => fn();
  const HC = await import("./hit-counter.js");
  const prevLog = console.log;
  const prevWarn4 = console.warn;
  // the real passive-anim fallback (imported by the lifted follow-up path) has no `game` here
  console.warn = (...a) => { if (!String(a[1] ?? a[0] ?? "").includes("PassiveAnim") && !String(a[0]).includes("PassiveAnim")) prevWarn4(...a); };

  const { orderAcceptedForFire } = await import("./card-reaction-order.js");
  const SHn = SH.replace(/\r\n/g, "\n");
  const iA = SHn.indexOf('  const dmgResource = ar.damageResource ?? "hp";');
  const iB = SHn.indexOf("  // 6b. Post-damage passive trigger", iA);
  ok("resolve tail found in state-handlers.js", iA > 0 && iB > iA);
  const TAIL = SHn.slice(iA, iB);

  async function runResolveTail({ offsets, followUpOn = null }) {
    const t0 = performance.now();
    const ev = [];
    const at = (s) => ev.push(`${s}@${Math.round(performance.now() - t0)}`);
    const applyDamageToTarget = liftApplyDamage({
      log: () => {}, warn: () => {},
      flushPendingFollowUpsFor: DF.flushPendingFollowUpsFor,
      readPropNum: (a, keys, dflt = 0) => { for (const k of keys) { const v = a.system.props[k]; if (v != null) return Number(v); } return dflt; },
      resolveDamageReactions: async ({ target, curHp, rawDamage }) => ({
        newHp: Math.max(0, curHp - rawDamage), dealtDamage: rawDamage, consumedAeIds: [], fired: [],
        followUp: target._tok === followUpOn ? [{ aeName: "Life Charm", rows: [{ effect_label: "revive" }], effectTable: [] }] : [],
      }),
      floorHp: (hp) => hp, actorHpFloor: () => null,
      buildDamageRow: (x) => x,
      applyEffectRow: async (row, fctx) => { at(`followup:${fctx.reactorActor._tok}`); },
      fireResourceLossVfx: (o, after) => import("./impact-offsets.js")
        .then(() => { at(`num:${o.tokenUuid}`); HC._test.onNumber({ kind: "loss", tokenUuid: o.tokenUuid, resource: o.resource, amount: o.amount }); })
        .finally(() => { try { after?.(); } catch (_e) { /* ignore */ } }),
      fireAbsorbVfx: () => {}, fireNpcHpBar: () => {}, fireBlockVfx: () => {}, fireImmuneVfx: () => {},
      fireDefeatOnHit: () => {},
      deferVfxTable,
    });
    const actors = {};
    const mk = (tok, hp) => (actors[`A.${tok}`] = {
      _tok: tok, name: tok,
      system: { props: { current_hp: hp, max_hp: 100, shield_value: 0 } },
      effects: { get: () => null }, getActiveTokens: () => [],
      async update(u) { at(`write:${tok}`); this.system.props.current_hp = u["system.props.current_hp"]; },
    });
    mk("T1", 50); mk("T2", 50); mk("T3", 50);
    const row = (tok) => ({ tokenUuid: tok, actorUuid: `A.${tok}`, name: tok, hit: true, damage: 10, affinity: "NE" });
    const ar = {
      _instanceId: "A1", kind: "Skill", hasDamage: true, damageType: "dark",
      perTargetResults: [row("T1"), row("T2"), row("T3")],
      targets: [{ tokenUuid: "T1" }, { tokenUuid: "T2" }, { tokenUuid: "T3" }],
      attacker: { tokenUuid: "C" }, attackerActorRef: "A.C", roll: { total: 15, hr: 5 },
      // a "when targeted" counter for the LAST bolt's target, accepted at CONFIRM
      acceptedCardReactions: [{ carrierName: "Counter", reactorActorUuid: "A.T3", phaseTrigger: "creature_targeted_by_action" }],
    };
    const director = { ctx: { animImpactOffsets: offsets ? { actionId: "A1", offsets } : null } };
    const scope = {
      ar, view: { kind: "Skill" }, director, ctx: {}, battleLogSink: [],
      casterActor: { name: "Nidhogg" },
      skill: { name: "Soulflare", uuid: "Item.S", system: { props: { skill_target: "Three Creatures" } } },
      SE: () => ({
        applyDamageToTarget, firePostDamageEffect: async () => {}, fireResourceChangeTrigger: () => {},
        collectAppliedIncreaseTags: () => [],
      }),
      fromUuid: async (u) => actors[u] ?? null,
      captureSubjectSnapshot: () => null, snapshotForChain: () => null,
      buildMissRow: (x) => x, chainHitsView: () => [], chainTargetOf: () => null, chainLogOf: () => null,
      chainSpentBlockers: () => null, chainStrikeLines: () => [], chainCombinedLine: () => null,
      playMissVfx: (o) => at(`miss:${o.tokenUuid}`), playBlockVfx: (o) => at(`block:${o.tokenUuid}`),
      createImpactPresenter, takeImpactOffsets, rememberImpactPresenter, orderAcceptedForFire,
      openFollowUpCollector: DF.openFollowUpCollector, closeFollowUpCollector: DF.closeFollowUpCollector,
      flushPendingFollowUpsFor: DF.flushPendingFollowUpsFor, runCollectedFollowUps: DF.runCollectedFollowUps,
      emitFollowUpsPending: () => {},
      endHitCounter: (o) => { at("hc-end"); HC.endHitCounter(o); },
      getSkillEffectsExtras: async () => ({ firePreAcceptedCandidate: async ({ candidate }) => { at(`reaction:${candidate.carrierName}`); } }),
      isActorDefeated: () => false, reactionChainActs: async () => true, skipCost: false, computeEffectiveCost: () => null,
      log: () => {}, warn: (...a) => prevLog("[warn]", ...a), err: (...a) => prevLog("[err]", ...a),
    };
    const proxy = new Proxy(scope, { has: (t, k) => k in t, get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } });
    HC.beginHitCounter({ id: "A1", side: "enemy" });
    // eslint-disable-next-line no-new-func
    await new Function("__scope", `return (async () => { with (__scope) {\n${TAIL}\n} })();`)(proxy);
    // what the RESOLVE state does next (a no-op when resolveAction drained)
    await drainImpactPresentation(director);
    await new Promise((r) => setTimeout(r, 30));   // let any straggler render
    const t = (re) => { const s = ev.find((e) => re.test(e)); return s ? Number(s.split("@").pop()) : null; };
    const idx = (re) => ev.findIndex((e) => re.test(e));
    return { ev, t, idx, hits: HC._test.state?.hits ?? 0, damage: HC._test.state?.damage ?? 0 };
  }

  // (a) a 3-target staggered resolve counts all 3 numbers in the counter window
  {
    const r = await runResolveTail({ offsets: { T1: 0, T2: 60, T3: 120 } });
    eq("4a staggered: hit counter counted 3 numbers / 30 dmg", [r.hits, r.damage], [3, 30]);
    ok("4a staggered: counter closed after the last number", r.idx(/^hc-end/) > r.idx(/^num:T3/) && r.idx(/^num:T3/) >= 0);
    ok("4a staggered: writes all before the late numbers", r.idx(/^write:T3/) < r.idx(/^num:T2/));
    const d2 = r.t(/^num:T2/) - r.t(/^num:T1/), d3 = r.t(/^num:T3/) - r.t(/^num:T1/);
    ok(`4a staggered: spacing kept (T2 +${d2}, T3 +${d3})`, d2 >= 50 && d3 >= 110);
    // (c) step-6 reactions run after the last delayed presentation
    ok("4c staggered: step-6 reaction after T3's number", r.idx(/^reaction:Counter/) > r.idx(/^num:T3/) && r.idx(/^num:T3/) >= 0);
  }
  // (b) a damage-reaction follow-up on a late target starts after that target's number
  {
    const r = await runResolveTail({ offsets: { T1: 0, T2: 60, T3: 120 }, followUpOn: "T3" });
    ok("4b staggered: T3's follow-up ran", r.idx(/^followup:T3/) >= 0);
    ok("4b staggered: T3's follow-up after T3's number", r.idx(/^followup:T3/) > r.idx(/^num:T3/) && r.idx(/^num:T3/) >= 0);
    eq("4b staggered: counter still 3", r.hits, 3);
  }
  // no offsets = the old path, nothing held: writes back to back in target order,
  // a damage-reaction follow-up after EVERY write (collected out of the hits
  // loop, deferred-followups.test.mjs), the counter closed after it, step 6
  // last, no wait. (The numbers' exact
  // place in that order is the lazy import's latency, the same on HEAD; with
  // these instant stubs the last number can even render after the counter
  // closes. That is the pre-existing no-offset path and is not changed here.)
  {
    const r = await runResolveTail({ offsets: null, followUpOn: "T2" });
    const order = r.ev.map((e) => e.split("@")[0]).filter((e) => !e.startsWith("num:"));
    eq("4 no offsets: write / follow-up / close / step-6 order", order,
      ["write:T1", "write:T2", "write:T3", "followup:T2", "hc-end", "reaction:Counter"]);
    eq("4 no offsets: every number still shown", r.ev.filter((e) => e.startsWith("num:")).length, 3);
    ok(`4 no offsets: no hold (took ${r.t(/^reaction/)} ms)`, r.t(/^reaction/) < 40);
  }
  console.warn = prevWarn4;
}

console.log(`impact-offsets: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
