// ============================================================================
// Damage-reaction follow-ups deferred out of the RESOLVE hits loop.
//
//     node scripts/battle-director/deferred-followups.test.mjs
//
// A target's damage-reaction follow-up chain (Life Charm: lc_card, 500 ms,
// fall, 1200 ms, revive show, heal, rise, spend = ~3.6 s) used to run inside
// applyDamageToTarget, awaited by the RESOLVE `for (const r of hits)` loop, so
// the NEXT target's HP write and number waited for the whole cinematic.
// applyDamageToTarget now takes an optional `deferFollowUps` collector; the
// RESOLVE loop passes one and runs the collected chains after the loop.
//
// 1. applyDamageToTarget (lifted from skill-effects.js by its source text):
//    without a collector the chain runs before the call returns (every other
//    caller: DoT ticks, deal_damage rows); with one nothing runs until run().
// 2. The RESOLVE damage tail (lifted from state-handlers.js): target 2's write
//    lands before target 1's slow chain starts; the chains run in target order,
//    each serial and after its own number; all of them finish before the hit
//    counter closes and step-6 reactions fire (the stand-in for the settle).
// 3. Source contract: the hits loop is the only RESOLVE caller that passes the
//    collector; the drain (5c) and settle come after the collected run.
// 4. Gate fixes (deferred-followups.js registry): a post_damage rider or a
//    redirect that reaches a creature whose chain is still pending runs that
//    chain first (ONE once-only save); a throwing chain or a throwing loop
//    still runs the rest and closes the collector.
// 5. Lethal hurt hold (battler-pose-rules.js createLethalHoldGate): no fixed
//    stand-up cap while follow-ups are pending; settle + 3 s; 30 s ceiling.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const IO = await import("./impact-offsets.js");
const { createImpactPresenter, deferVfxTable, takeImpactOffsets, rememberImpactPresenter, drainImpactPresentation } = IO;
const { orderAcceptedForFire } = await import("./card-reaction-order.js");
const DF = await import("./deferred-followups.js");
const { openFollowUpCollector, closeFollowUpCollector, flushPendingFollowUpsFor, runCollectedFollowUps } = DF;

let failed = 0, passed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failed++;
  console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
}
function ok(label, cond) { eq(label, !!cond, true); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the real passive-anim fallback (imported by the follow-up path) has no `game` here
const prevWarn = console.warn;
console.warn = (...a) => { if (!a.some((x) => String(x).includes("PassiveAnim"))) prevWarn(...a); };

const SE_SRC = readFileSync(fileURLToPath(new URL("./skill-effects.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const SH_SRC = readFileSync(fileURLToPath(new URL("./state-handlers.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

function liftApplyDamage(stubs) {
  const start = SE_SRC.indexOf("export async function applyDamageToTarget(");
  const end = SE_SRC.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("applyDamageToTarget not found");
  const body = SE_SRC.slice(start, end + 2).replace(/^export /, "");
  const names = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn applyDamageToTarget;`)(...names.map((n) => stubs[n]));
}

// One harness: an event log with timestamps, actors whose update() logs the
// write, and a follow-up chain per token (rows run with an optional delay).
function makeWorld({ chains = {}, rowMs = 0, rowFns = {}, onceOnly = false } = {}) {
  const t0 = performance.now();
  const ev = [];
  const at = (s) => ev.push(`${s}@${Math.round(performance.now() - t0)}`);
  // onceOnly: the charm is spent by its chain's "spend" row (Life Charm's lc_spend):
  // a second hit before that row caps again (the double save the gate found).
  const spent = new Set();
  let W = null;
  const applyDamageToTarget = liftApplyDamage({
    log: () => {}, warn: () => {},
    flushPendingFollowUpsFor,
    readPropNum: (a, keys, dflt = 0) => { for (const k of keys) { const v = a.system.props[k]; if (v != null) return Number(v); } return dflt; },
    resolveDamageReactions: async ({ target, curHp, rawDamage }) => {
      const rows = (onceOnly && spent.has(target._tok)) ? null : (chains[target._tok] ?? null);
      // Life Charm: the cap runs here (before the write), the rest is follow-up.
      const capped = rows ? Math.min(rawDamage, Math.max(0, curHp - 1)) : rawDamage;
      return {
        newHp: Math.max(0, curHp - capped), dealtDamage: capped, consumedAeIds: [], fired: rows ? [{ aeName: "Life Charm", from: rawDamage, to: capped }] : [],
        followUp: rows ? [{ aeName: "Life Charm", rows: rows.map((l) => ({ effect_label: l })), effectTable: [] }] : [],
      };
    },
    floorHp: (hp) => hp, actorHpFloor: () => null,
    buildDamageRow: (x) => x,
    applyEffectRow: async (row, fctx) => {
      at(`fu:${fctx.reactorActor._tok}:${row.effect_label}`);
      if (rowMs) await sleep(rowMs);
      if (row.effect_label === "heal") { fctx.reactorActor.system.props.current_hp = 50; at(`heal:${fctx.reactorActor._tok}`); }
      if (row.effect_label === "spend") spent.add(fctx.reactorActor._tok);
      const fn = rowFns[row.effect_label];
      if (fn) await fn(W, fctx);
    },
    fireResourceLossVfx: (o, after) => { at(`num:${o.tokenUuid}`); try { after?.(); } catch (_e) { /* ignore */ } },
    fireAbsorbVfx: () => {}, fireNpcHpBar: () => {}, fireBlockVfx: () => {}, fireImmuneVfx: () => {},
    fireDefeatOnHit: (o) => at(`defeat:${o.tokenUuid}`),
    deferVfxTable,
  });
  const actors = {};
  const mk = (tok, hp, { throwOnTokens = false } = {}) => (actors[`A.${tok}`] = {
    _tok: tok, name: tok, uuid: `A.${tok}`,
    system: { props: { current_hp: hp, max_hp: 100, shield_value: 0 } },
    effects: { get: () => null },
    getActiveTokens: () => { if (throwOnTokens) throw new Error(`boom:${tok}`); return []; },
    async update(u) { at(`write:${tok}:${u["system.props.current_hp"]}`); this.system.props.current_hp = u["system.props.current_hp"]; },
  });
  W = { ev, at, applyDamageToTarget, actors, mk, t0, spent };
  return W;
}
const idxOf = (ev, re) => ev.findIndex((e) => re.test(e));
const tOf = (ev, re) => { const s = ev.find((e) => re.test(e)); return s ? Number(s.split("@").pop()) : null; };
const strip = (ev) => ev.map((e) => e.split("@")[0]);

// ── 1. applyDamageToTarget: inline by default, collected on request ──────────
{
  // (a) no collector (DoT tick / deal_damage row): the chain runs before return
  const W = makeWorld({ chains: { T1: ["card", "fall", "heal"] } });
  W.mk("T1", 10);
  const res = await W.applyDamageToTarget({ target: W.actors["A.T1"], damage: 30, affinity: "NE", tokenUuid: "T1", targetName: "T1" });
  W.at("returned");
  eq("1a inline: write, number, chain, then return", strip(W.ev),
    ["write:T1:1", "num:T1", "fu:T1:card", "fu:T1:fall", "fu:T1:heal", "heal:T1", "returned"]);
  eq("1a inline: hpAfterHit is the capped HP, before the heal", res.hpAfterHit, 1);
}
{
  // (b) collector: nothing of the chain runs before return; run() runs it all
  const W = makeWorld({ chains: { T1: ["card", "fall", "heal"] } });
  W.mk("T1", 10);
  const bag = [];
  const res = await W.applyDamageToTarget({ target: W.actors["A.T1"], damage: 30, affinity: "NE", tokenUuid: "T1", targetName: "T1", deferFollowUps: bag });
  W.at("returned");
  eq("1b collected: one entry for the target", bag.map((d) => [d.tokenUuid, d.targetName, d.aeNames]), [["T1", "T1", ["Life Charm"]]]);
  eq("1b collected: chain not run before return", strip(W.ev), ["write:T1:1", "num:T1", "returned"]);
  eq("1b collected: hpAfterHit unchanged (capped HP)", res.hpAfterHit, 1);
  ok("1b collected: run is a function", typeof bag[0]?.run === "function");
  await bag[0]?.run?.();
  eq("1b collected: run() runs the chain serially", strip(W.ev).slice(3), ["fu:T1:card", "fu:T1:fall", "fu:T1:heal", "heal:T1"]);
}
{
  // (c) a collector with no follow-up on the hit stays empty
  const W = makeWorld();
  W.mk("T1", 50);
  const bag = [];
  await W.applyDamageToTarget({ target: W.actors["A.T1"], damage: 5, affinity: "NE", tokenUuid: "T1", deferFollowUps: bag });
  eq("1c no follow-up: collector empty", bag.length, 0);
}
{
  // (d) collected run() still waits for its own deferred number (staggered impacts)
  const W = makeWorld({ chains: { T1: ["card"] } });
  W.mk("T1", 10);
  const bag = [];
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const deferPresentation = (fn) => gate.then(() => fn());
  const call = W.applyDamageToTarget({ target: W.actors["A.T1"], damage: 30, affinity: "NE", tokenUuid: "T1", deferPresentation, deferFollowUps: bag });
  await sleep(20);
  const p = bag[0]?.run?.();
  await sleep(20);
  eq("1d staggered: call returned, chain waits for its number", [strip(W.ev), bag.length], [["write:T1:1"], 1]);
  release();
  await call;
  await p;
  eq("1d staggered: number, then chain", strip(W.ev), ["write:T1:1", "num:T1", "fu:T1:card"]);
}

// ── 2. The RESOLVE damage tail ───────────────────────────────────────────────
const iA = SH_SRC.indexOf('  const dmgResource = ar.damageResource ?? "hp";');
const iB = SH_SRC.indexOf("  // 6b. Post-damage passive trigger", iA);
ok("resolve tail found in state-handlers.js", iA > 0 && iB > iA);
const TAIL = SH_SRC.slice(iA, iB);

async function runTail({ chains, rowMs = 0, order = ["T1", "T2", "T3"], offsets = null, rowFns = {}, onceOnly = false, postDamage = null, throwOnTokens = [], misses = [], missThrows = false, worldOut = null, snapshot = null, tail = null }) {
  const W = makeWorld({ chains, rowMs, rowFns, onceOnly });
  if (worldOut) worldOut.W = W;
  for (const t of new Set(order)) W.mk(t, t in chains ? 10 : 50, { throwOnTokens: throwOnTokens.includes(t) });
  const row = (tok) => ({ tokenUuid: tok, actorUuid: `A.${tok}`, name: tok, hit: !misses.includes(tok), damage: 30, affinity: "NE" });
  const ar = {
    _instanceId: "A1", kind: "Skill", hasDamage: true, damageType: "dark",
    perTargetResults: order.map(row), targets: order.map((t) => ({ tokenUuid: t })),
    attacker: { tokenUuid: "C" }, attackerActorRef: "A.C", roll: { total: 15, hr: 5 },
    acceptedCardReactions: [{ carrierName: "Counter", reactorActorUuid: "A.T3", phaseTrigger: "creature_targeted_by_action" }],
  };
  const director = { ctx: { animImpactOffsets: offsets ? { actionId: "A1", offsets } : null } };
  const scope = {
    ar, view: { kind: "Skill" }, director, ctx: {}, battleLogSink: [],
    casterActor: { name: "Nidhogg" },
    skill: { name: "Soulflare", uuid: "Item.S", system: { props: { skill_target: "Three Creatures" } } },
    SE: () => ({
      applyDamageToTarget: W.applyDamageToTarget,
      firePostDamageEffect: async (_s, _c, p) => { W.at(`post:${p.targetTokenUuid}`); if (postDamage) await postDamage(W, p); },
      fireResourceChangeTrigger: (o) => { W.at(`queue:${o.tokenUuid}`); },
      collectAppliedIncreaseTags: () => [],
    }),
    fromUuid: async (u) => W.actors[u] ?? null,
    captureSubjectSnapshot: (a) => (snapshot ? snapshot(W, a) : null), snapshotForChain: () => null,
    buildMissRow: (x) => { if (missThrows) throw new Error("miss row boom"); return x; }, chainHitsView: () => [], chainTargetOf: () => null, chainLogOf: () => null,
    chainSpentBlockers: () => null, chainStrikeLines: () => [], chainCombinedLine: () => null,
    playMissVfx: () => {}, playBlockVfx: () => {},
    createImpactPresenter, takeImpactOffsets, rememberImpactPresenter, orderAcceptedForFire,
    openFollowUpCollector, closeFollowUpCollector, flushPendingFollowUpsFor, runCollectedFollowUps,
    emitFollowUpsPending: (on) => W.at(`pending:${on}`),
    endHitCounter: () => W.at("hc-end"),
    getSkillEffectsExtras: async () => ({ firePreAcceptedCandidate: async ({ candidate }) => { W.at(`reaction:${candidate.carrierName}`); } }),
    isActorDefeated: () => false, reactionChainActs: async () => true, skipCost: false, computeEffectiveCost: () => null,
    log: () => {}, warn: (...a) => console.log("[warn]", ...a), err: (...a) => console.log("[err]", ...a),
  };
  const proxy = new Proxy(scope, { has: (t, k) => k in t, get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } });
  // eslint-disable-next-line no-new-func
  await new Function("__scope", `return (async () => { with (__scope) {\n${tail ?? TAIL}\n} })();`)(proxy);
  W.at("tail-done");   // what follows: 6b passives, then the post-resolve settle
  await drainImpactPresentation(director);
  return W;
}

{
  // (a) two targets, the FIRST has a slow chain (2 rows x 150 ms)
  const W = await runTail({ chains: { T1: ["card", "heal"] }, rowMs: 150, order: ["T1", "T2"] });
  const ev = W.ev;
  ok("2a T1's write first", idxOf(ev, /^write:T1:/) === 0);
  ok("2a T2's write BEFORE T1's chain starts", idxOf(ev, /^write:T2:/) >= 0 && idxOf(ev, /^write:T2:/) < idxOf(ev, /^fu:T1:card/));
  ok("2a T2's number BEFORE T1's chain starts", idxOf(ev, /^num:T2/) >= 0 && idxOf(ev, /^num:T2/) < idxOf(ev, /^fu:T1:card/));
  const gap = tOf(ev, /^write:T2:/) - tOf(ev, /^write:T1:/);
  ok(`2a T1 -> T2 write gap is not the chain (${gap} ms < 100)`, gap < 100);
  ok("2a T1's chain after T1's own number", idxOf(ev, /^fu:T1:card/) > idxOf(ev, /^num:T1/));
  ok("2a T1's chain serial (card, then heal)", idxOf(ev, /^fu:T1:heal/) > idxOf(ev, /^fu:T1:card/));
  ok("2a chain finished before the hit counter closes", idxOf(ev, /^heal:T1/) >= 0 && idxOf(ev, /^heal:T1/) < idxOf(ev, /^hc-end/));
  ok("2a chain finished before step-6 reactions", idxOf(ev, /^heal:T1/) < idxOf(ev, /^reaction:Counter/));
  ok("2a chain finished before the tail returns (settle)", idxOf(ev, /^heal:T1/) < idxOf(ev, /^tail-done/));
  eq("2a capped write is 1 (cap before the write)", ev.find((e) => /^write:T1:/.test(e)).split("@")[0], "write:T1:1");
  eq("2a T1 HP healed by the time the tail ends", W.actors["A.T1"].system.props.current_hp, 50);
}
{
  // (b) three targets, two with chains: run in target order, never interleaved
  const W = await runTail({ chains: { T1: ["card", "heal"], T3: ["card", "heal"] }, rowMs: 40 });
  const order = strip(W.ev).filter((e) => /^(write|fu|hc-end|reaction)/.test(e));
  eq("2b all writes, then T1's chain, then T3's, then close / step 6", order,
    ["write:T1:1", "write:T2:20", "write:T3:1", "fu:T1:card", "fu:T1:heal", "fu:T3:card", "fu:T3:heal", "hc-end", "reaction:Counter"]);
}
{
  // (c) no chain anywhere: the old order (writes, close, step 6), no hold
  const W = await runTail({ chains: {} });
  const order = strip(W.ev).filter((e) => /^(write|fu|hc-end|reaction)/.test(e));
  eq("2c no follow-ups: unchanged order", order, ["write:T1:20", "write:T2:20", "write:T3:20", "hc-end", "reaction:Counter"]);
}
{
  // (d) staggered impacts: T1's chain still waits for T1's number; every
  //     number lands on its own offset, not after the chain
  const W = await runTail({ chains: { T1: ["card"] }, rowMs: 200, offsets: { T1: 0, T2: 60, T3: 120 } });
  const ev = W.ev;
  ok("2d staggered: chain after T1's number", idxOf(ev, /^fu:T1:card/) > idxOf(ev, /^num:T1/));
  const d3 = tOf(ev, /^num:T3/) - tOf(ev, /^num:T1/);
  ok(`2d staggered: T3's number on its offset (+${d3} ms, < 200)`, d3 >= 100 && d3 < 200);
  ok("2d staggered: step 6 after the last number and the chain", idxOf(ev, /^reaction:Counter/) > idxOf(ev, /^num:T3/) && idxOf(ev, /^reaction:Counter/) > idxOf(ev, /^fu:T1:card/));
}

{
  // (e) the same creature twice in one action: its first hit's follow-ups land
  //     before its second write (a once-per-conflict marker must be there)
  const W = await runTail({ chains: { T1: ["mark"] }, order: ["T1", "T2", "T1"] });
  const order = strip(W.ev).filter((e) => /^(write|fu|hc-end)/.test(e));
  eq("2e repeat target: first hit's chain before its second write", order,
    ["write:T1:1", "write:T2:20", "fu:T1:mark", "write:T1:1", "fu:T1:mark", "hc-end"]);
}

{
  // (f) N1, behavioural: the hits loop's OWN top-of-iteration flush. The same
  //     creature hit again: its first hit's chain (here it marks the actor, as
  //     Ninja Log's once-per-conflict marker does) must land before the loop
  //     reads the creature for its second hit (the status snapshot the post-
  //     resolve creature_deals_damage reaction reads), not only before the write
  //     (applyDamageToTarget's own flush covers that one).
  const runF = (tail) => runTail({
    chains: { T1: ["mark"] }, order: ["T1", "T2", "T1"], tail,
    rowFns: { mark: async (_W, fctx) => { fctx.reactorActor.system.props.marked = true; } },
    snapshot: (W2, a) => { W2.at(`snap:${a._tok}:${a.system.props.marked ? "marked" : "clean"}`); return null; },
  });
  const W = await runF(null);
  const ev = strip(W.ev).filter((e) => /^(snap|write|fu|hc-end)/.test(e));
  eq("2f loop-top flush: first hit's chain before the second hit's snapshot", ev,
    ["snap:T1:clean", "write:T1:1", "snap:T2:clean", "write:T2:20", "fu:T1:mark", "snap:T1:marked", "write:T1:1", "fu:T1:mark", "hc-end"]);
  // Control: the same run with the loop-top flush cut out must go red (only
  // applyDamageToTarget's flush is left, which comes AFTER the snapshot).
  const FLUSH = "        {\n          const _pending = flushPendingFollowUpsFor({ tokenUuid: r.tokenUuid, actorUuid: r.actorUuid });\n          if (_pending) await _pending;\n        }\n";
  ok("2f control: loop-top flush block found in the tail", TAIL.includes(FLUSH));
  const Wc = await runF(TAIL.replace(FLUSH, ""));
  const evc = strip(Wc.ev).filter((e) => /^snap:T1/.test(e));
  eq("2f control: without the loop-top flush the second snapshot is stale", evc, ["snap:T1:clean", "snap:T1:clean"]);
}

// ── 3. Source contract ───────────────────────────────────────────────────────
{
  const loopAt = TAIL.indexOf("const _deferredFollowUps = openFollowUpCollector();");
  const passAt = TAIL.indexOf("deferFollowUps: _deferredFollowUps");
  const runAt = TAIL.indexOf("try { await runCollectedFollowUps(_deferredFollowUps); }");
  const drainAt = TAIL.indexOf("await impactPresenter.drain()");
  const closeAt = TAIL.indexOf("endHitCounter(");
  ok("3 collector declared, passed, run after the loop, before the drain + close", loopAt > 0 && passAt > loopAt && runAt > passAt && drainAt > runAt && closeAt > runAt);
  eq("3 exactly one RESOLVE call passes the collector", (SH_SRC.match(/deferFollowUps:/g) ?? []).length, 1);
  eq("3 no skill-effects caller passes a collector (inline elsewhere)", (SE_SRC.match(/deferFollowUps:/g) ?? []).length, 0);
  ok("3 collector closed in a finally after the run", /finally \{\s*closeFollowUpCollector\(_deferredFollowUps\);/.test(TAIL));
  ok("3 hits-loop flush before the snapshot / HP read", TAIL.indexOf("flushPendingFollowUpsFor({ tokenUuid: r.tokenUuid") > 0
    && TAIL.indexOf("flushPendingFollowUpsFor({ tokenUuid: r.tokenUuid") < TAIL.indexOf("_subjectSnapshots.set(r.tokenUuid"));
  // The choke point: every damage / HP-loss write in skill-effects flushes first.
  const ADT = SE_SRC.slice(SE_SRC.indexOf("export async function applyDamageToTarget("));
  ok("3 applyDamageToTarget flushes before its first HP read", ADT.indexOf("flushPendingFollowUpsFor(") > 0
    && ADT.indexOf("flushPendingFollowUpsFor(") < ADT.indexOf('const curHp = readPropNum(target, ["current_hp", "hp"]);'));
  const DD = SE_SRC.slice(SE_SRC.indexOf("const _casterShield = Number("));
  ok("3 deal_damage flushes before amount / HP-before", DD.indexOf("flushPendingFollowUpsFor(") > 0
    && DD.indexOf("flushPendingFollowUpsFor(") < DD.indexOf("evaluateFormula(amountFormula, resolver, 0)")
    && DD.indexOf("flushPendingFollowUpsFor(") < DD.indexOf('const hpBefore = readPropNum(actor, ["current_hp", "hp"]);'));
  const RH = SE_SRC.slice(SE_SRC.indexOf("async function applyReversedHealDamage("));
  ok("3 reversed heal flushes before HP-before", RH.indexOf("flushPendingFollowUpsFor(") > 0
    && RH.indexOf("flushPendingFollowUpsFor(") < RH.indexOf('const hpBefore = readPropNum(actor, ["current_hp", "hp"]);'));
  const CR = SE_SRC.slice(SE_SRC.indexOf("const canDefeat = row.consume_can_defeat"));
  ok("3 HP consume_resource flushes before its read", CR.indexOf("flushPendingFollowUpsFor(") > 0
    && CR.indexOf("flushPendingFollowUpsFor(") < CR.indexOf("const cur = Number(actor.system?.props?.[def.prop] ?? 0) || 0;"));
}

// ── 4. Gate fixes: nothing reaches a creature between its write and its chain ──
const count = (ev, re) => ev.filter((e) => re.test(e)).length;
{
  // (a) pinned order: a post_damage rider that does NOT touch a pending creature
  //     runs at its target's hit, before the collected follow-ups (deferred).
  const W = await runTail({ chains: { T1: ["card", "heal"] }, order: ["T1", "T2"] });
  const order = strip(W.ev).filter((e) => /^(write|post|fu|hc-end|pending)/.test(e));
  eq("4a post_damage at its hit, follow-ups after the loop", order,
    ["write:T1:1", "pending:true", "post:T1", "write:T2:20", "post:T2", "fu:T1:card", "fu:T1:heal", "pending:false", "hc-end"]);
}
{
  // (b) B1: a post_damage rider damages the victim whose charm chain is pending
  //     (Burning Hand > Fling onto the creature just capped at 1): the chain runs
  //     first (cap -> ... -> heal -> spend), so the rider meets a spent charm. ONE save.
  const W = await runTail({
    chains: { T1: ["card", "heal", "spend"] }, onceOnly: true, order: ["T1", "T2"],
    postDamage: async (W2, p) => {
      if (p.targetTokenUuid !== "T1") return;
      // deal_damage -> applyDamageToTarget with no collector of its own (the choke point)
      await W2.applyDamageToTarget({ target: W2.actors["A.T1"], damage: 30, affinity: "NE", tokenUuid: "T1", targetName: "T1" });
    },
  });
  const ev = strip(W.ev);
  eq("4b post_damage onto a pending victim: ONE charm save", count(ev, /^fu:T1:card$/), 1);
  ok("4b chain (incl. spend) before the rider's write", ev.indexOf("fu:T1:spend") >= 0 && ev.indexOf("fu:T1:spend") < ev.lastIndexOf("write:T1:20"));
  eq("4b rider lands on the healed HP (50 - 30)", W.actors["A.T1"].system.props.current_hp, 20);
  eq("4b order", ev.filter((e) => /^(write|post|fu)/.test(e)),
    ["write:T1:1", "post:T1", "fu:T1:card", "fu:T1:heal", "fu:T1:spend", "write:T1:20", "write:T2:20", "post:T2"]);
}
{
  // (c) Q: T1's chain redirects damage onto T2 (Earthen Wire) while T2's own
  //     charm chain is still pending: T2's chain runs first. ONE save on T2.
  const W = await runTail({
    chains: { T1: ["card", "redirect", "spend"], T2: ["card", "heal", "spend"] }, onceOnly: true, order: ["T1", "T2"],
    rowFns: { redirect: async (W2, fctx) => {
      if (fctx.reactorActor._tok !== "T1") return;
      await W2.applyDamageToTarget({ target: W2.actors["A.T2"], damage: 30, affinity: "NE", tokenUuid: "T2", targetName: "T2" });
    } },
  });
  const ev = strip(W.ev);
  eq("4c redirect onto a pending target: ONE charm save on T2", count(ev, /^fu:T2:card$/), 1);
  eq("4c order: T2's chain lands before the redirect's write on T2", ev.filter((e) => /^(write|fu|hc-end)/.test(e)),
    ["write:T1:1", "write:T2:1", "fu:T1:card", "fu:T1:redirect", "fu:T2:card", "fu:T2:heal", "fu:T2:spend", "write:T2:20", "fu:T1:spend", "hc-end"]);
}
{
  // (d) a throwing chain (T1's run() throws outside its row try) does not skip
  //     the later chain (T3) nor the close / step 6.
  const W = await runTail({ chains: { T1: ["card"], T3: ["card", "heal"] }, throwOnTokens: ["T1"] });
  const ev = strip(W.ev);
  ok("4d T3's chain still runs after T1's threw", ev.includes("fu:T3:heal"));
  ok("4d close and step 6 still run, after T3's chain", ev.indexOf("hc-end") > ev.indexOf("fu:T3:heal") && ev.indexOf("reaction:Counter") > ev.indexOf("hc-end"));
  eq("4d collector closed", DF._openCollectorCount(), 0);
}
{
  // (e) the hits loop itself throws outside its inner try (here: the miss row of
  //     T2): T1's collected chain still runs, the collector closes, pending clears,
  //     and the exception still propagates.
  const out = {};
  let threw = null;
  try { await runTail({ chains: { T1: ["card", "heal"] }, order: ["T1", "T2"], misses: ["T2"], missThrows: true, worldOut: out }); }
  catch (e) { threw = e; }
  ok("4e the loop's exception still propagates", threw && /miss row boom/.test(String(threw?.message)));
  const ev = strip(out.W?.ev ?? []);
  ok("4e T1's chain ran despite the throw", ev.includes("heal:T1"));
  ok("4e pending cleared after the chain", ev.indexOf("pending:false") > ev.indexOf("heal:T1"));
  eq("4e collector closed after the throw", DF._openCollectorCount(), 0);
}
{
  // (f) registry: a throwing entry does not stop the next; flush takes only the
  //     matching token's entries and leaves the rest in order.
  const ran = [];
  const bag = openFollowUpCollector();
  bag.push({ tokenUuid: "X", actorUuid: "A.X", run: async () => { ran.push("X1"); throw new Error("x"); } });
  bag.push({ tokenUuid: "Y", actorUuid: "A.Y", run: async () => { ran.push("Y"); } });
  bag.push({ tokenUuid: "X", actorUuid: "A.X", run: async () => { ran.push("X2"); } });
  eq("4f nothing pending for an unknown token -> null (no await)", flushPendingFollowUpsFor({ tokenUuid: "Z" }), null);
  ok("4f pending for X (by actor)", DF.hasPendingFollowUps({ actorUuid: "A.X" }));
  await flushPendingFollowUpsFor({ tokenUuid: "X" });
  eq("4f flush X: both X entries, the thrower does not stop the next", ran, ["X1", "X2"]);
  eq("4f Y left in the collector", bag.map((d) => d.tokenUuid), ["Y"]);
  await runCollectedFollowUps(bag);
  closeFollowUpCollector(bag);
  eq("4f then Y; collector closed", [ran, DF._openCollectorCount()], [["X1", "X2", "Y"], 0]);
  eq("4f closed collector: nothing pending", flushPendingFollowUpsFor({ tokenUuid: "Y" }), null);
}

// ── 5. B2: a lethal victim keeps its hurt frame while follow-ups are pending ──
{
  const R = await import("./battler-pose-rules.js");
  const { createLethalHoldGate, LETHAL_HURT_HOLD_MS, SHOW_LETHAL_HURT_HOLD_MS, PENDING_FOLLOWUPS_GRACE_MS, PENDING_FOLLOWUPS_CEILING_MS } = R;
  ok("5 gate exported", typeof createLethalHoldGate === "function");
  if (typeof createLethalHoldGate === "function") {
  // fake clock
  let now = 0, seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  const clearTimer = (id) => { timers.delete(id); };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = end;
  };
  const stood = [];
  const G = createLethalHoldGate({ setTimer, clearTimer, now: () => now });
  const hold = (id, show = false) => G.hold(id, { show, onExpire: () => stood.push(`${id}@${now}`) });

  // not pending: the old caps
  hold("a"); hold("s", true);
  advance(LETHAL_HURT_HOLD_MS + 1);
  eq("5a no follow-ups pending: stands up at 1500 ms", stood, [`a@${LETHAL_HURT_HOLD_MS}`]);
  advance(SHOW_LETHAL_HURT_HOLD_MS);
  eq("5a show hold: 6000 ms", stood.slice(1), [`s@${SHOW_LETHAL_HURT_HOLD_MS}`]);

  // pending: no fixed cap; the KO cancels; settle + grace otherwise
  stood.length = 0; now = 0; timers.clear();
  G.setPending(true);
  hold("b"); hold("k", true);
  advance(8000);                  // two charms in a show: more than 6 s
  eq("5b pending: no stand-up after 1.5 s / 6 s (8 s in)", stood, []);
  G.cancel("k");                  // its KO arrived
  G.setPending(false);            // the follow-ups have all run
  advance(PENDING_FOLLOWUPS_GRACE_MS - 1);
  eq("5b settled: still holding inside the grace", stood, []);
  advance(2);
  eq("5b settled + 3 s, no KO: stands up; the KO'd one never does", stood, [`b@${8000 + PENDING_FOLLOWUPS_GRACE_MS}`]);

  // a hold armed BEFORE pending began is converted (charm wearer ordered after)
  stood.length = 0; now = 0; timers.clear();
  hold("c");
  advance(500);
  G.setPending(true);
  advance(LETHAL_HURT_HOLD_MS * 3);
  eq("5c armed hold disarmed by pending", stood, []);
  G.setPending(false);
  advance(PENDING_FOLLOWUPS_GRACE_MS);
  eq("5c stands up only after settle + grace", stood, [`c@${500 + LETHAL_HURT_HOLD_MS * 3 + PENDING_FOLLOWUPS_GRACE_MS}`]);

  // lost "settled" signal: the ceiling ends pending, then the grace
  stood.length = 0; now = 0; timers.clear();
  G.setPending(true);
  hold("d");
  advance(PENDING_FOLLOWUPS_CEILING_MS - 1);
  eq("5d no settle signal: holding until the ceiling", [stood, G.isPending()], [[], true]);
  advance(1 + PENDING_FOLLOWUPS_GRACE_MS);
  eq("5d ceiling + grace: never frozen", [stood, G.isPending()], [[`d@${PENDING_FOLLOWUPS_CEILING_MS + PENDING_FOLLOWUPS_GRACE_MS}`], false]);
  G.reset();

  // N5: a SHOW hold that starts while follow-ups are pending releases at the
  // LATER of (settle + 3 s) and (hold start + 6000 ms): never earlier than HEAD.
  stood.length = 0; now = 0; timers.clear();
  G.setPending(true);
  advance(200);
  hold("e", true);                                  // starts at 200
  advance(300);
  G.setPending(false);                              // settles at 500: 500 + 3000 = 3500 < 200 + 6000
  advance(3001);
  eq("5e show hold, early settle: no stand-up at settle + 3 s", stood, []);
  advance(SHOW_LETHAL_HURT_HOLD_MS);
  eq("5e show hold, early settle: stands up at hold start + 6000", stood, [`e@${200 + SHOW_LETHAL_HURT_HOLD_MS}`]);

  stood.length = 0; now = 0; timers.clear();
  G.setPending(true);
  hold("f", true);                                  // starts at 0
  advance(4000);
  G.setPending(false);                              // 4000 + 3000 = 7000 > 6000
  advance(10000);
  eq("5f show hold, late settle: settle + 3 s wins", stood, [`f@${4000 + PENDING_FOLLOWUPS_GRACE_MS}`]);

  stood.length = 0; now = 0; timers.clear();
  G.setPending(true);
  hold("g");                                        // ordinary hold at 0
  advance(100);
  G.setPending(false);                              // max(100 + 3000, 0 + 1500)
  advance(10000);
  eq("5g ordinary hold: settle + 3 s (later than start + 1500)", stood, [`g@${100 + PENDING_FOLLOWUPS_GRACE_MS}`]);

  stood.length = 0; now = 0; timers.clear();
  hold("h", true);                                  // show hold armed with nothing pending at 0
  advance(1000);
  G.setPending(true);                               // disarmed
  advance(500);
  G.setPending(false);                              // 1500 + 3000 = 4500 < 0 + 6000
  advance(10000);
  eq("5h show hold armed before pending: still its own 6000 ms", stood, [`h@${SHOW_LETHAL_HURT_HOLD_MS}`]);
  G.reset();
  }
}

// ── 6. N4: the registry is cleared on battle end / director stop ─────────────
{
  ok("6 reset exported", typeof DF.resetFollowUpRegistry === "function");
  const { BattleDirector } = await import("./director.js");
  const { STATES } = await import("./states.js");
  const stale = () => {
    const bag = openFollowUpCollector();
    bag.push({ tokenUuid: "S", actorUuid: "A.S", run: async () => { throw new Error("a stale chain must never run"); } });
    return bag;
  };
  // (a) the pure reset
  stale();
  ok("6a an open collector is pending before the reset", DF.hasPendingFollowUps({ tokenUuid: "S" }));
  eq("6a reset reports the open collector", DF.resetFollowUpRegistry(), 1);
  eq("6a after reset: nothing open, nothing pending, flush is null",
    [DF._openCollectorCount(), DF.hasPendingFollowUps({ tokenUuid: "S" }), flushPendingFollowUpsFor({ tokenUuid: "S" })], [0, false, null]);
  // (b) the director entering BATTLE_ENDING
  for (const target of [STATES.BATTLE_ENDING, STATES.STOPPED]) {
    stale();
    const d = new BattleDirector({ payload: {}, stateHandlers: {} });
    d.state = STATES.RESOLVE ?? d.state;
    await d._transition(target);
    eq(`6b entering ${target} clears the registry`, DF._openCollectorCount(), 0);
  }
  // (c) a manual director stop
  stale();
  const d2 = new BattleDirector({ payload: {}, stateHandlers: {} });
  await d2.stop({ reason: "test" });
  eq("6c director.stop() clears the registry", DF._openCollectorCount(), 0);
  // (d) an ordinary transition does NOT clear it (a RESOLVE in flight keeps its collector)
  const keep = stale();
  const d3 = new BattleDirector({ payload: {}, stateHandlers: {} });
  await d3._transition(STATES.TURN_END ?? STATES.CLEANUP);
  eq("6d an ordinary transition leaves an open collector alone", DF._openCollectorCount(), 1);
  closeFollowUpCollector(keep);
}

console.warn = prevWarn;
console.log(`deferred-followups: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
