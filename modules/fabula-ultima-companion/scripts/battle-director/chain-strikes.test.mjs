// ============================================================================
// Chain N — pure strike planner.
//
//     node scripts/battle-director/chain-strikes.test.mjs
//
// One action card, N strikes, each with its own accuracy and damage. These
// pin the rules the planner owns: the keyword forms, per-strike targets, the
// running state from strike to strike (KO cut-off, shield, blockers, the
// hits-this-turn tally), one Opportunity per side, the per-target breakdown,
// and pseudo multi-hit ticks that always add up.
//
// Pure module, so no Foundry globals are needed.
// ============================================================================

const {
  parseChainKeyword, assignStrikeTargets, planStrikes, createStrikeWalker, applyStrikeToState,
  breakdownForTarget, summarizeTarget, splitTicks, fallbackBeatMs, makeRng,
  foldChargeSteps, aeRefreshIsNoop, isSeparateChain, planSingleChain, singleBreakdown,
} = await import("./chain-strikes.js");

let failed = 0, passed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failed++;
  console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
}

// ── keyword ──────────────────────────────────────────────────────────────────
eq("chain 3 = one roll",   parseChainKeyword(["chain 3"]),            { count: 3, mode: "single" });
eq("chain(2)",             parseChainKeyword("pierce, chain(2)"),     { count: 2, mode: "single" });
eq("chain 3 separate",     parseChainKeyword(["chain 3 separate"]),   { count: 3, mode: "separate" });
eq("chain x4 random",      parseChainKeyword(["chain x4 random"]),    { count: 4, mode: "random" });
eq("chain:3:pick",         parseChainKeyword(["chain:3:pick"]),       { count: 3, mode: "pick" });
eq("Chain 3 (case)",       parseChainKeyword(["Chain 3"]),            { count: 3, mode: "single" });
eq("bare chain ignored",   parseChainKeyword(["chain"]),              null);
eq("chain 1 is no chain",  parseChainKeyword(["chain 1"]),            null);
eq("combo is not chain",   parseChainKeyword(["combo 2"]),            null);
eq("capped at 20",         parseChainKeyword(["chain 99"]),           { count: 20, mode: "single" });
eq("other words ignored",  parseChainKeyword(["chain reaction"]),     null);
eq("unknown mode word ignored", parseChainKeyword(["chain 3 same"]),  null);
eq("separate kinds", ["single", "separate", "random", "pick"].map((mode) => isSeparateChain({ count: 3, mode })), [false, true, true, true]);

// ── per-strike targets ───────────────────────────────────────────────────────
eq("same: every strike hits all card targets",
  assignStrikeTargets({ count: 2, mode: "same", cardTargets: ["A", "B"] }),
  { strikeTargets: [["A", "B"], ["A", "B"]], cardTargets: ["A", "B"] });
{
  const r = assignStrikeTargets({ count: 5, mode: "random", pool: ["A", "B", "C"], rng: makeRng(7) });
  eq("random: one target per strike", r.strikeTargets.every((l) => l.length === 1), true);
  eq("random: targets come from the pool", r.strikeTargets.every(([t]) => ["A", "B", "C"].includes(t)), true);
  eq("random: card shows the distinct set", r.cardTargets.every((t) => r.strikeTargets.some(([x]) => x === t)), true);
  const again = assignStrikeTargets({ count: 5, mode: "random", pool: ["A", "B", "C"], rng: makeRng(7) });
  eq("random: seeded draw is repeatable", again.strikeTargets, r.strikeTargets);
}
eq("pick: one creature takes every strike",
  assignStrikeTargets({ count: 3, mode: "pick", picks: ["A"] }),
  { strikeTargets: [["A"], ["A"], ["A"]], cardTargets: ["A"] });
eq("pick: round-robin in pick order",
  assignStrikeTargets({ count: 3, mode: "pick", picks: ["A", "B"] }).strikeTargets,
  [["A"], ["B"], ["A"]]);
eq("pick: more picks than strikes leaves the last unstruck",
  assignStrikeTargets({ count: 2, mode: "pick", picks: ["A", "B", "C"] }).cardTargets,
  ["A", "B"]);
eq("random with an empty pool falls back to the card",
  assignStrikeTargets({ count: 2, mode: "random", pool: [], cardTargets: ["A"] }).strikeTargets,
  [["A"], ["A"]]);

// ── state math ───────────────────────────────────────────────────────────────
{
  const s = { hp: 50, maxHp: 100, shield: 10 };
  eq("shield soaks first", applyStrikeToState(s, { kind: "hit", amount: 25 }),
    { hpBefore: 50, hpAfter: 35, shieldBefore: 10, shieldAfter: 0, hpLoss: 15, shieldLoss: 10, hpGain: 0 });
  eq("hp clamps at 0", applyStrikeToState(s, { kind: "hit", amount: 99 }).hpAfter, 0);
  const a = { hp: 90, maxHp: 100, shield: 0 };
  eq("absorb heals up to max", applyStrikeToState(a, { kind: "absorb", amount: 30 }).hpGain, 10);
  const i = { hp: 40, maxHp: 40, shield: 0 };
  eq("immune changes nothing", applyStrikeToState(i, { kind: "immune", amount: 0 }).hpAfter, 40);
}

// ── the walk ─────────────────────────────────────────────────────────────────
// Evaluate from a table: per strike index, per target → outcome.
const table = (rows) => (strike, uuid) => rows[strike.index]?.[uuid] ?? { hit: false, kind: "miss" };
const roll = (o = {}) => ({ total: 12, hr: 6, isCrit: false, isFumble: false, ...o });

{ // Dark Bane ×3 on Blanche: 53, miss, 54 crit = 107.
  const states = new Map([["B", { hp: 176, maxHp: 176, shield: 0, priorHits: 0 }]]);
  const plan = planStrikes({
    strikes: [1, 2, 3].map((i) => ({ index: i, roll: roll({ isCrit: i === 3 }), targets: ["B"] })),
    states,
    evaluate: table({
      1: { B: { hit: true, kind: "hit", amount: 53 } },
      2: { B: { hit: false, kind: "miss" } },
      3: { B: { hit: true, kind: "hit", amount: 54, isCrit: true } },
    }),
  });
  const t = plan.perTarget.get("B");
  eq("chain3: landed", t.landed, 2);
  eq("chain3: missed", t.missed, 1);
  eq("chain3: damage", t.damage, 107);
  eq("chain3: hp after", states.get("B").hp, 69);
  eq("chain3: landed total", plan.landed, 2);
  eq("chain3: one opportunity from strike 3", [plan.attackerOpportunity, plan.firstCritStrike], [true, 3]);
  eq("chain3: breakdown", breakdownForTarget(plan, "B"), "53 / MISS / 54★");
  eq("chain3: summary", summarizeTarget(t), "2 hits, 1 miss");
}

{ // KO mid-chain: the target loses its remaining strikes.
  const states = new Map([["S", { hp: 30, maxHp: 30, shield: 0 }]]);
  const plan = planStrikes({
    strikes: [1, 2, 3].map((i) => ({ index: i, roll: roll(), targets: ["S"] })),
    states,
    evaluate: () => ({ hit: true, kind: "hit", amount: 20 }),
  });
  const t = plan.perTarget.get("S");
  eq("ko: two land, one lost", [t.landed, t.lost], [2, 1]);
  eq("ko: defeated on strike 2", [t.defeated, t.defeatedOnStrike], [true, 2]);
  eq("ko: killing flag on the killing strike", plan.strikes[1].outcomes[0].killing, true);
  eq("ko: third strike is lost", plan.strikes[2].outcomes[0].kind, "lost");
}

{ // Ninja Log: a one-shot blocker stops the first landing strike only.
  const states = new Map([["N", { hp: 100, maxHp: 100, shield: 0, blockers: 1 }]]);
  const plan = planStrikes({
    strikes: [1, 2].map((i) => ({ index: i, roll: roll(), targets: ["N"] })),
    states,
    evaluate: (s, u, st) => (st.blockers > 0
      ? { hit: true, kind: "block", blockedBy: "Ninja Log" }
      : { hit: true, kind: "hit", amount: 40 }),
  });
  eq("block: first strike blocked", plan.strikes[0].outcomes[0].kind, "block");
  eq("block: second strike lands", plan.strikes[1].outcomes[0].amount, 40);
  eq("block: blocker used up", states.get("N").blockers, 0);
  eq("block: breakdown", breakdownForTarget(plan, "N"), "BLOCK / 40");
}

{ // Champion Gloves: the evaluator sees hits that landed earlier in the chain.
  const states = new Map([["G", { hp: 500, maxHp: 500, shield: 0, priorHits: 0 }]]);
  const seen = [];
  planStrikes({
    strikes: [1, 2, 3].map((i) => ({ index: i, roll: roll(), targets: ["G"] })),
    states,
    evaluate: (s, u, st) => { seen.push(st.priorHits); return s.index === 2 ? { hit: false } : { hit: true, kind: "hit", amount: 10 + 5 * st.priorHits }; },
  });
  eq("tally: prior hits seen per strike", seen, [0, 1, 1]);
  eq("tally: grows by landed strikes only", states.get("G").priorHits, 2);
}

{ // Pierce half-hit: lands (deals damage) but is not a hit for the tally.
  const states = new Map([["P", { hp: 100, maxHp: 100, shield: 0, priorHits: 0 }]]);
  const plan = planStrikes({
    strikes: [1, 2].map((i) => ({ index: i, roll: roll(), targets: ["P"] })),
    states,
    evaluate: (s) => (s.index === 1 ? { hit: true, kind: "hit", amount: 8, pierce: true } : { hit: true, kind: "hit", amount: 16 }),
  });
  const t = plan.perTarget.get("P");
  eq("pierce: both land", t.landed, 2);
  eq("pierce: only the real hit counts", [t.hitsLanded, states.get("P").priorHits], [1, 1]);
}

{ // MP damage: 0 MP is not a KO, so later strikes still land.
  const states = new Map([["M", { hp: 10, maxHp: 50, shield: 0, noKo: true }]]);
  const plan = planStrikes({
    strikes: [1, 2].map((i) => ({ index: i, roll: roll(), targets: ["M"] })),
    states,
    evaluate: () => ({ hit: true, kind: "hit", amount: 10 }),
  });
  eq("mp: no lost strikes", [plan.perTarget.get("M").landed, plan.perTarget.get("M").lost, plan.perTarget.get("M").defeated], [2, 0, false]);
}

{ // Incremental walker = planStrikes, step by step.
  const states = new Map([["W", { hp: 25, maxHp: 25, shield: 0 }]]);
  const w = createStrikeWalker(states);
  w.step({ index: 1, roll: roll(), targets: ["W"] }, () => ({ hit: true, kind: "hit", amount: 20 }));
  eq("walker: still standing after strike 1", w.standing("W"), true);
  w.step({ index: 2, roll: roll(), targets: ["W"] }, () => ({ hit: true, kind: "hit", amount: 20 }));
  eq("walker: down after strike 2", w.standing("W"), false);
  w.step({ index: 3, roll: roll(), targets: ["W"] }, () => { throw new Error("evaluate must not run for a downed target"); });
  const plan = w.finish();
  eq("walker: third strike lost", plan.perTarget.get("W").lost, 1);
}

{ // AoE + Chain: same mode hits every target with every strike.
  const states = new Map([["A", { hp: 100, maxHp: 100, shield: 0 }], ["B", { hp: 100, maxHp: 100, shield: 5 }]]);
  const plan = planStrikes({
    strikes: [1, 2].map((i) => ({ index: i, roll: roll(), targets: ["A", "B"] })),
    states,
    evaluate: () => ({ hit: true, kind: "hit", amount: 10 }),
  });
  eq("aoe: 4 landed", plan.landed, 4);
  eq("aoe: shield soaked on B", [plan.perTarget.get("B").shieldLoss, plan.perTarget.get("B").hpLoss], [5, 15]);
}

{ // Fumble: one defender-side flag; crit never set by a fumble.
  const states = new Map([["F", { hp: 100, maxHp: 100, shield: 0 }]]);
  const plan = planStrikes({
    strikes: [
      { index: 1, roll: roll({ isFumble: true }), targets: ["F"] },
      { index: 2, roll: roll({ isFumble: true }), targets: ["F"] },
    ],
    states,
    evaluate: () => ({ hit: false }),
  });
  eq("fumble: one defender opportunity", [plan.defenderOpportunity, plan.firstFumbleStrike, plan.attackerOpportunity], [true, 1, false]);
}

// ── ticks + beat ─────────────────────────────────────────────────────────────
eq("ticks sum exactly (107 over 3)", splitTicks(107, [1, 1, 1]), [36, 35, 36]);
eq("ticks sum exactly (weights)", splitTicks(100, [0.3, 0.3, 0.4]), [30, 30, 40]);
eq("ticks: sum check", splitTicks(997, [1, 2, 3, 4]).reduce((a, b) => a + b, 0), 997);
eq("ticks: no ratios = one tick", splitTicks(50, []), [50]);
eq("beat: short chain keeps 550", fallbackBeatMs(3), 550);
eq("beat: long chain shrinks", fallbackBeatMs(10), 288);
eq("beat: floor at 140", fallbackBeatMs(40), 140);

// ── one-roll Chain: one result shown as N hits ───────────────────────────────
{
  const hit = (amount, extra = {}) => ({ kind: "hit", amount, affinity: "NE", element: "fire", ...extra });
  const st = (hp, shield = 0, extra = {}) => ({ hp, maxHp: hp, shield, ...extra });
  const p = planSingleChain({ count: 3, targets: [{ tokenUuid: "A", outcome: hit(13), state: st(100) }] });
  const ticks = p.strikes.map((s) => s.outcomes[0].amount);
  eq("single: ticks add up to the one damage", [ticks, ticks.reduce((a, b) => a + b, 0)], [[4, 5, 4], 13]);
  eq("single: one landed hit, not three", [p.perTarget.A.landed, p.perTarget.A.hitsLanded, p.perTarget.A.damage], [1, 1, 13]);
  eq("single: running HP per tick", p.strikes.map((s) => s.outcomes[0].hpAfter), [96, 91, 87]);
  eq("single: breakdown", singleBreakdown(p.perTarget.A), "4 + 5 + 4");

  const sh = planSingleChain({ count: 3, targets: [{ tokenUuid: "A", outcome: hit(30), state: st(100, 15) }] });
  eq("single: shield soaks the early ticks", sh.strikes.map((s) => [s.outcomes[0].shieldLoss, s.outcomes[0].hpLoss]), [[10, 0], [5, 5], [0, 10]]);

  const cr = planSingleChain({ count: 3, targets: [{ tokenUuid: "A", outcome: hit(9, { isCrit: true }), state: st(100) }] });
  eq("single: every crit tick gold, banner on the last only",
    cr.strikes.map((s) => [s.outcomes[0].isCrit, s.outcomes[0].critBanner]), [[true, false], [true, false], [true, true]]);
  eq("single: crit breakdown", singleBreakdown(cr.perTarget.A), "3 + 3 + 3★");

  const ms = planSingleChain({ count: 3, targets: [{ tokenUuid: "A", outcome: { kind: "miss" }, state: st(100) }] });
  eq("single: a miss shows once", ms.strikes.map((s) => s.outcomes[0].kind), ["miss", "skip", "skip"]);
  eq("single: miss breakdown", [singleBreakdown(ms.perTarget.A), ms.perTarget.A.missed], ["MISS", 1]);

  const bl = planSingleChain({ count: 2, targets: [{ tokenUuid: "A", outcome: { kind: "block", blockedBy: "Ninja Log" }, state: st(100) }] });
  eq("single: a block shows once", bl.strikes.map((s) => s.outcomes[0].kind), ["block", "skip"]);

  const ab = planSingleChain({ count: 3, targets: [{ tokenUuid: "A", outcome: { kind: "absorb", amount: 20 }, state: { hp: 90, maxHp: 100, shield: 0 } }] });
  eq("single: an absorb heals once, capped", [ab.strikes[0].outcomes[0].hpGain, ab.strikes[1].outcomes[0].kind, singleBreakdown(ab.perTarget.A)], [10, "skip", "+10"]);

  const ko = planSingleChain({ count: 3, targets: [{ tokenUuid: "A", outcome: hit(30), state: st(12) }] });
  eq("single: a killing hit downs on its LAST tick", ko.strikes.map((s) => s.outcomes[0].killing), [false, false, true]);
  eq("single: overkill ticks still show", [ko.strikes[2].outcomes[0].amount, ko.perTarget.A.defeated, ko.perTarget.A.defeatedOnStrike], [10, true, 3]);

  const mp = planSingleChain({ count: 2, targets: [{ tokenUuid: "A", outcome: hit(50), state: st(10, 0, { noKo: true }) }] });
  eq("single: MP damage never downs", [mp.strikes[1].outcomes[0].killing, mp.perTarget.A.defeated], [false, false]);

  const aoe = planSingleChain({ count: 2, targets: [
    { tokenUuid: "A", outcome: hit(10), state: st(100) },
    { tokenUuid: "B", outcome: { kind: "miss" }, state: st(100) },
  ] });
  eq("single: AoE — each strike slot carries every target", aoe.strikes.map((s) => s.outcomes.map((o) => `${o.tokenUuid}:${o.kind}`)),
    [["A:hit", "B:miss"], ["A:hit", "B:skip"]]);
}

// ── folding a Chain's repeat status writes ───────────────────────────────────
eq("fold: plain sum", foldChargeSteps(1, [{ add: 1, max: 99 }, { add: 1, max: 99 }]), 3);
eq("fold: capped like strike-by-strike", foldChargeSteps(2, [{ add: 2, max: 5 }, { add: 2, max: 5 }]), 5);
eq("fold: per-step caps apply in order", foldChargeSteps(0, [{ add: 3, max: 3 }, { add: 3, max: 4 }]), 4);
eq("fold: no steps keeps the stack", foldChargeSteps(4, []), 4);
eq("fold: missing max = uncapped", foldChargeSteps(0, [{ add: 2 }, { add: 2 }]), 4);
{
  const NS = "fabula-ultima-companion";
  const by = { skillUuid: "Item.s", reactorActorUuid: "Actor.a", reactorTokenUuid: "T.a", effectLabel: "slow_on_hit", appliedAtRound: 2 };
  const ae = { name: "Slow", origin: "Item.s", changes: [{ key: "bonus_dex", mode: 2, value: "-2", priority: null }], statuses: new Set(["slow"]), disabled: false, flags: { [NS]: { charges: 3, directorAppliedBy: by } } };
  const same = JSON.parse(JSON.stringify({ ...ae, statuses: ["slow"] }));
  eq("noop: identical refresh", aeRefreshIsNoop(ae, same, NS), true);
  eq("noop: a reset counter is a change", aeRefreshIsNoop(ae, { ...same, flags: { [NS]: { charges: 2, directorAppliedBy: by } } }, NS), false);
  eq("noop: another applier is a change", aeRefreshIsNoop(ae, { ...same, flags: { [NS]: { charges: 3, directorAppliedBy: { ...by, reactorActorUuid: "Actor.b" } } } }, NS), false);
  eq("noop: different changes", aeRefreshIsNoop(ae, { ...same, changes: [{ key: "bonus_dex", mode: 2, value: "-4" }] }, NS), false);
  eq("noop: core duration is not compared", aeRefreshIsNoop({ ...ae, duration: { startRound: 3 } }, { ...same, duration: { startRound: null } }, NS), true);
}

console.log(`chain-strikes: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
