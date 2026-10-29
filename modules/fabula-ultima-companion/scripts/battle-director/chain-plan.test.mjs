// ============================================================================
// Chain N — engine adapter helpers + hit counter rules.
//
//     node scripts/battle-director/chain-plan.test.mjs
//
// The parts of the Chain adapter that decide what each later strike inherits
// from the confirmed card (accuracy re-base, the one-shot block), plus the
// keyword gate, random-target narrowing, the RESOLVE hit view, and the hit
// counter's counting rules. buildChainPlan itself needs a live director
// (dice, recompute) and is covered by the live run, not here.
// ============================================================================

const {
  chainSpecFor, drawChainTargets, narrowToTargets, strikesPerTarget,
  isBlockingOverride, rebaseAccuracyOverride, chainHitsView, _test,
} = await import("./chain-plan.js");
const { makeRng } = await import("./chain-strikes.js");

let failed = 0, passed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failed++;
  console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
}

// ── keyword gate ─────────────────────────────────────────────────────────────
const skill = (kw) => ({ system: { props: { action_keywords: kw } } });
eq("skill chain", chainSpecFor({ kind: "Skill", skillItem: skill("pierce, chain 3"), isCheck: true, hasDamage: true }), { count: 3, mode: "same" });
eq("weapon chain on an attack", chainSpecFor({ kind: "Attack", weapon: { actionKeywords: "chain 2 random" } }), { count: 2, mode: "random" });
eq("weapon keywords ignored for a skill", chainSpecFor({ kind: "Skill", weapon: { actionKeywords: "chain 2" }, isCheck: true, hasDamage: true }), null);
eq("no check, no chain", chainSpecFor({ kind: "Skill", skillItem: skill("chain 3"), isCheck: false, hasDamage: true }), null);
eq("no damage, no chain", chainSpecFor({ kind: "Skill", skillItem: skill("chain 3"), isCheck: true, hasDamage: false }), null);
eq("old Combo items never chain", chainSpecFor({ kind: "Skill", skillItem: skill("combo 3"), isCheck: true, hasDamage: true }), null);

// ── random targets at COMPUTE ────────────────────────────────────────────────
{
  const d = drawChainTargets({ count: 4, mode: "random" }, ["A", "B", "C"], makeRng(3));
  eq("random: spec carries 4 strike targets", d.spec.strikeTargets.length, 4);
  eq("random: keep = the distinct drawn set", [...new Set(d.spec.strikeTargets.flat())].sort(), [...d.keep].sort());
  const n = narrowToTargets({
    targets: [{ tokenUuid: "A" }, { tokenUuid: "B" }, { tokenUuid: "C" }],
    perTargetResults: [{ tokenUuid: "A" }, { tokenUuid: "B" }, { tokenUuid: "C" }],
    hitTokenUuids: ["A", "C"],
  }, ["C"]);
  eq("narrow: targets", n.targets.map((t) => t.tokenUuid), ["C"]);
  eq("narrow: rows", n.perTargetResults.map((t) => t.tokenUuid), ["C"]);
  eq("narrow: hit list", n.hitTokenUuids, ["C"]);
  eq("same mode keeps the card", drawChainTargets({ count: 3, mode: "same" }, ["A"]).keep, null);
  eq("strikes per target (random)", strikesPerTarget({ count: 3, strikeTargets: [["A"], ["B"], ["A"]] }), { A: 2, B: 1 });
  eq("strikes per target (same)", strikesPerTarget({ count: 2 }, ["A", "B"]), { A: 2, B: 2 });
}

// ── what later strikes inherit ───────────────────────────────────────────────
eq("Ninja Log set 0 is a one-shot block", isBlockingOverride({ ops: [{ op: "set", amount: 0 }] }), true);
eq("multiply 0 is a block", isBlockingOverride({ ops: [{ op: "multiply", amount: 0 }] }), true);
eq("a flat reduction is not", isBlockingOverride({ ops: [{ op: "add", amount: -5 }] }), false);
eq("halving is not", isBlockingOverride({ ops: [{ op: "multiply", amount: 0.5 }] }), false);
eq("legacy single-op set 0", isBlockingOverride({ op: "set", amount: 0 }), true);

eq("additive bonus re-bases on the strike's roll",
  rebaseAccuracyOverride({ from: 12, to: 14, parts: [{ source: "Aim", amount: 2 }] }, { total: 9 }),
  { from: 9, to: 11, blocked: false, via: null, reactorName: null, parts: [{ source: "Aim", amount: 2 }] });
eq("Crossfire set 0 stays absolute",
  rebaseAccuracyOverride({ from: 12, to: 0, parts: [], via: "Crossfire" }, { total: 15 }).to, 0);
eq("a reroll belonged to strike 1", rebaseAccuracyOverride({ from: 8, to: 13, rerolled: true }, { total: 10 }), null);
eq("GM accuracy parts belong to strike 1",
  rebaseAccuracyOverride({ from: 10, to: 16, gm: true, parts: [{ source: "Aim", amount: 2 }, { source: "GM adjustment", amount: 4, gm: true }] }, { total: 7 }).to,
  9);
eq("GM-only override: nothing to carry",
  rebaseAccuracyOverride({ from: 10, to: 15, gm: true, parts: [{ source: "GM adjustment", amount: 5, gm: true }] }, { total: 7 }),
  null);

// ── per-target row → strike outcome ──────────────────────────────────────────
const ev = _test.evaluateRow;
eq("row: miss", ev({ hit: false, defense: 12 }, {}).kind, "miss");
eq("row: Ninja Log block", ev({ hit: true, damage: 0, damageOverride: { ops: [{ op: "set", amount: 0 }], from: 40, to: 0, via: "Ninja Log" } }, {}),
  { hit: true, kind: "block", blockedBy: "Ninja Log", defense: null });
eq("row: absorb", ev({ hit: true, damage: 30, affinity: "AB" }, {}).kind, "absorb");
eq("row: immune", ev({ hit: true, damage: 0, affinity: "IM" }, {}).kind, "immune");
eq("row: crit hit", (({ kind, amount, isCrit }) => ({ kind, amount, isCrit }))(ev({ hit: true, damage: 54, crit: true }, {})), { kind: "hit", amount: 54, isCrit: true });
eq("row: pierce half-hit", (({ kind, pierce, isCrit }) => ({ kind, pierce, isCrit }))(ev({ hit: false, pierceMiss: true, damage: 20, crit: false }, {})), { kind: "hit", pierce: true, isCrit: false });
eq("row: element falls back to the action's", ev({ hit: true, damage: 5 }, { damage: { element: "fire" } }).element, "fire");

// ── RESOLVE view of a Chain's targets ────────────────────────────────────────
{
  const plan = { perTarget: {
    A: { landed: 2, hitsLanded: 2, crits: 1, damage: 107 },
    B: { landed: 0, hitsLanded: 0, crits: 0, damage: 0 },
    C: { landed: 1, hitsLanded: 0, crits: 0, damage: 9 },
  } };
  const rows = chainHitsView(plan, [
    { tokenUuid: "A", hit: false, damage: 0, damageOverride: { to: 0 } },
    { tokenUuid: "B", hit: true, damage: 50 },
    { tokenUuid: "C", hit: false, damage: 0 },
  ]);
  eq("view: A hit by later strikes", [rows[0].hit, rows[0].damage, rows[0].crit, "damageOverride" in rows[0]], [true, 107, true, false]);
  eq("view: B missed every strike", [rows[1].hit, rows[1].damage], [false, 0]);
  eq("view: C only pierced", [rows[2].hit, rows[2].pierceMiss, rows[2].damage], [false, true, 9]);
}

// ── hit counter rules (minimal DOM stub) ─────────────────────────────────────
{
  const el = () => ({
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    style: {}, textContent: "", innerHTML: "", offsetWidth: 0, childElementCount: 0,
    querySelector() { return this._child ??= el(); }, getBoundingClientRect() { return { bottom: 0 }; },
  });
  const root = el();
  let created = false;
  globalThis.document = {
    getElementById: (id) => (id === "fud-hit-counter" && created ? root : null),
    createElement: () => { created = true; return root; },
    head: { appendChild() {} }, body: { appendChild() {} },
  };
  globalThis.window = { innerHeight: 800 };
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.Hooks = { on() {}, callAll() {} };
  const { _test: hc } = await import("./hit-counter.js");
  const t = (n) => new Promise((r) => setTimeout(r, n));

  hc.onMessage({ op: "begin", id: "a1", side: "party" });
  hc.onNumber({ kind: "loss", tokenUuid: "T1", resource: "hp", amount: 30 });
  hc.onNumber({ kind: "loss", tokenUuid: "T2", resource: "hp", amount: 25 });
  hc.onNumber({ kind: "loss", tokenUuid: "T3", resource: "hp", amount: 20 });
  eq("AoE: one hit per target", [hc.state.hits, hc.state.damage], [3, 75]);

  hc.onMessage({ op: "begin", id: "a2", side: "enemy" });
  hc.onNumber({ kind: "loss", tokenUuid: "T1", resource: "shield", amount: 10 });
  hc.onNumber({ kind: "loss", tokenUuid: "T1", resource: "hp", amount: 43 });
  eq("shield + HP of one hit = one hit", [hc.state.hits, hc.state.damage], [1, 53]);
  await t(80);
  hc.onNumber({ kind: "miss", tokenUuid: "T1" });
  hc.onNumber({ kind: "gain", tokenUuid: "T1", resource: "hp", amount: 9 });
  hc.onNumber({ kind: "absorb", tokenUuid: "T1", amount: 9 });
  eq("MISS, heals and absorbs never count", hc.state.hits, 1);
  hc.onNumber({ kind: "loss", tokenUuid: "T1", resource: "hp", amount: 54 });
  eq("a later strike on the same target counts", [hc.state.hits, hc.state.damage, hc.state.side], [2, 107, "enemy"]);

  hc.onMessage({ op: "end", id: "a2" });
  hc.onNumber({ kind: "loss", tokenUuid: "T1", resource: "hp", amount: 12 });
  eq("numbers after the window closes are not this action's", hc.state.hits, 2);
  hc.onMessage({ op: "end", id: "someone-else" });
  eq("an end for another action is ignored", hc.state.active, false);
}

console.log(`chain-plan: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
process.exit();
