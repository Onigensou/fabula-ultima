// ============================================================================
// AI anti-repeat / action_pattern_cooldown memory on the DIRECTOR combatant.
//
//     node scripts/action-reader/action-memory-director.test.mjs
//
// The Battle Director makes no Foundry Combat, so the old memory (a Foundry
// combatant flag) read empty and wrote nowhere in every director battle: no
// authored cooldown ever fired. Memory now lives on the dCombat combatant
// (`actionMemory`), round = dCombat.round, saved/restored by persistence.js.
// Drives the REAL matchAndPick stage and the REAL resolveTargetsWithRetry with
// stub rows/items (no Foundry, no Combat), plus a real save -> reconstruct.
// ============================================================================

const deep = () => new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : (k === "prototype" ? {} : deep())),
  apply: () => deep(), construct: () => deep(),
});
globalThis.PIXI = deep();
globalThis.Hooks = { on() {}, once() {}, callAll() {}, off() {} };
globalThis.game = { settings: { get() {}, register() {} }, combat: null, combats: null };
globalThis.CONFIG = {};
const mergeObject = (a, b) => { const o = { ...(a ?? {}) }; for (const [k, v] of Object.entries(b ?? {})) o[k] = (v && typeof v === "object" && !Array.isArray(v)) ? mergeObject(o[k], v) : v; return o; };
globalThis.foundry = { utils: {
  randomID: () => "id" + Math.random().toString(36).slice(2, 10),
  deepClone: (v) => JSON.parse(JSON.stringify(v ?? null)),
  mergeObject,
  getProperty: (o, p) => String(p).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o),
} };
globalThis.canvas = { scene: null, tokens: { placeables: [] } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const MP = await import("./actionReader-matchAndPickAction.js");
const { matchAndPickActionReaderAction: pick, commitPendingActionMemory, attachDirectorActionMemory } = MP;
const { resolveTargetsWithRetry } = await import("./feasibility-fallback.js");
const { DirectorCombat, DirectorCombatant } = await import("../battle-director/director-combat.js");
const { saveDirectorState, reconstructDirectorCombat } = await import("../battle-director/persistence.js");

let failed = 0, passed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

// Math.random pinned low: the weighted pick takes the FIRST pool entry.
Math.random = () => 0.01;

const norm = (s) => String(s).trim().replace(/\s+/g, " ").toLowerCase();
function item(name, cost = "") { return { id: norm(name), name, displayName: name, skillType: "skill", props: { cost }, item: { name } }; }
function row(name, { priority = 5, cooldown = 0, i = 0 } = {}) {
  return { rowIndex: i, rowKey: `r${i}`, passedCondition: true, actionName: name, actionNameNormalized: norm(name), priority, cooldown, raw: {} };
}
/** A context like the autopilot builds, minus Foundry: survey = feasibility's reach. */
function mkCtx({ rows, items, surveyReach = {}, dc = null, round = 0, foundry = null }) {
  const ctx = {
    ok: true, errors: [], warnings: [], debug: { stageReports: [], config: { enabled: false, verbose: false } },
    performer: foundry ? { combatant: foundry.combatant, actor: null } : null,
    combat: foundry ? { round: foundry.round } : null,
    actorData: { items, actionReferences: [], resources: { mp: { current: 99 }, ip: { current: 99 } } },
    patternRows: rows, evaluatedRows: rows, chosenAction: null, chosenTargets: [],
    targetSurvey: (it) => ({ ok: true, available: surveyReach[it?.name] === false ? 0 : 2, category: "enemy" }),
  };
  if (dc) attachDirectorActionMemory(ctx, { combatant: dc, round });
  return ctx;
}
const pool = (ctx) => (ctx.actionPickPool ?? []).map((p) => `${p.name}:${p.weight}`);
const stubDc = () => ({ tokenId: "t1", actionMemory: null }); // a dCombat combatant (only the field matters)

/** One autopilot activation: deferred first pick, real retry, real commit.
 *  `pickerReach` = what the TARGET PICKER finds (may disagree with the survey). */
async function activate({ rows, items, dc, round, surveyReach = {}, pickerReach = {}, grant = false }) {
  const ctx = mkCtx({ rows, items, surveyReach, dc, round });
  const logs = [];
  await pick(ctx, grant ? { recordMemory: false } : { deferMemory: true });
  if (!ctx.chosenAction) return { ok: false, chosen: null, first: null, logs, ctx };
  const first = ctx.chosenAction.name;
  const ok = await resolveTargetsWithRetry(ctx, {
    grant, log: (m) => logs.push(m), pick,
    resolveTargets: async (c) => { c.chosenTargets = pickerReach[c.chosenAction?.name] === false ? [] : ["tgt"]; },
    commit: commitPendingActionMemory,
  });
  return { ok, chosen: ctx.chosenAction?.name ?? null, first, logs, ctx };
}

// ── 1. read/write on a stub dCombat combatant, no Foundry Combat ─────────────
{
  const dc = stubDc();
  const ctx = mkCtx({ rows: [row("Soulflare", { cooldown: 2 })], items: [item("Soulflare")], dc, round: 3 });
  await pick(ctx);
  check("1 immediate write lands on the director combatant", dc.actionMemory, { lastActionName: "soulflare", usedRounds: { soulflare: 3 } });
  check("1 meta says memory host = director, round 3", [ctx.actionMatchMeta.memoryHost, ctx.actionMatchMeta.memoryRound], ["director", 3]);
  const ctx2 = mkCtx({ rows: [row("Soulflare")], items: [item("Soulflare")] });
  await pick(ctx2);
  check("1 no director + no Foundry combatant -> host none, nothing written anywhere", ctx2.actionMatchMeta.memoryHost, "none");
  const ctx3 = mkCtx({ rows: [row("Claw")], items: [item("Claw")], dc: stubDc(), round: 1 });
  await pick(ctx3, { recordMemory: false });
  check("1 recordMemory:false (grant consult / preview) writes nothing", ctx3.directorMemory.combatant.actionMemory, null);
  const ctx4 = mkCtx({ rows: [row("Claw")], items: [item("Claw")], dc: stubDc(), round: 1 });
  await pick(ctx4, { deferMemory: true });
  check("1 deferMemory parks the stamp, combatant untouched until commit", [ctx4.directorMemory.combatant.actionMemory, !!ctx4.pendingActionMemory], [null, true]);
  await commitPendingActionMemory(ctx4);
  check("1 commit writes the parked stamp", ctx4.directorMemory.combatant.actionMemory, { lastActionName: "claw", usedRounds: { claw: 1 } });
}

// ── 2. cooldown 2 blocks for its rounds, then frees ──────────────────────────
{
  const dc = stubDc();
  const rows = [row("Soulflare", { cooldown: 2, i: 0 }), row("Claw", { i: 1 })];
  const items = [item("Soulflare"), item("Claw")];
  const a = await activate({ rows, items, dc, round: 3 });
  check("2 round 3 act 1: Soulflare performed + stamped", [a.chosen, dc.actionMemory.usedRounds], ["Soulflare", { soulflare: 3 }]);
  const b = await activate({ rows, items, dc, round: 3 });
  check("2 round 3 act 2 (same round): Soulflare blocked -> Claw", [b.chosen, pool(b.ctx)], ["Claw", ["Claw:3"]]);
  check("2   cooldown counted in meta", b.ctx.actionMatchMeta.cooldownBlockedCandidates, 1);
  const c = await activate({ rows, items, dc, round: 4 });
  check("2 round 4: still blocked (4-3 < 2) -> Claw", c.chosen, "Claw");
  const d = await activate({ rows, items, dc, round: 5 });
  check("2 round 5: free again (5-3 = 2) -> Soulflare", [d.chosen, d.ctx.actionMatchMeta.cooldownBlockedCandidates], ["Soulflare", 0]);
  check("2 round 5 stamp moves to 5, Claw's kept", dc.actionMemory.usedRounds, { soulflare: 5, claw: 4 });
}

// ── 3. anti-repeat (soft) across activations ─────────────────────────────────
{
  const dc = stubDc();
  const rows = [row("Bite", { i: 0 }), row("Swipe", { i: 1 })];
  const items = [item("Bite"), item("Swipe")];
  const a = await activate({ rows, items, dc, round: 1 });
  check("3 first activation: even pool, Bite", [a.chosen, pool(a.ctx)], ["Bite", ["Bite:3", "Swipe:3"]]);
  const b = await activate({ rows, items, dc, round: 1 });
  const w = Object.fromEntries((b.ctx.actionPickPool).map((p) => [p.name, Math.round(p.weight * 100) / 100]));
  check("3 next activation: last action de-weighted x0.3", w, { Bite: 0.9, Swipe: 3 });
  check("3   lastActionName read from the director record", b.ctx.actionMatchMeta.antiRepeatLastAction, "bite");
}

// ── 4. persistence round-trip of the new field ───────────────────────────────
{
  let stored = null;
  const scene = { id: "sc1", name: "Arena", setFlag: async (_ns, _k, v) => { stored = v; }, getFlag: () => null };
  const tokA = { id: "tA", uuid: "Scene.sc1.Token.tA", name: "Nidhogg", disposition: -1, actor: { id: "aA", uuid: "Actor.aA", name: "Nidhogg", system: { props: {} } }, toObject: () => ({}) };
  const tokB = { id: "tB", uuid: "Scene.sc1.Token.tB", name: "Hina", disposition: 1, actor: { id: "aB", uuid: "Actor.aB", name: "Hina", system: { props: {} } }, toObject: () => ({}) };
  const byUuid = { [tokA.uuid]: tokA, [tokB.uuid]: tokB, "Actor.aA": tokA.actor, "Actor.aB": tokB.actor };
  globalThis.fromUuid = async (u) => byUuid[u] ?? null;
  const dc = new DirectorCombat({ scene, sourceSceneId: null });
  dc.scene = scene; dc.round = 4;
  const cA = new DirectorCombatant({ tokenDoc: tokA, actorDoc: tokA.actor, side: "enemy", disposition: -1 });
  const cB = new DirectorCombatant({ tokenDoc: tokB, actorDoc: tokB.actor, side: "party", disposition: 1 });
  check("4 a fresh DirectorCombatant starts with actionMemory null", cA.actionMemory, null);
  cA.actionMemory = { lastActionName: "soulflare", usedRounds: { soulflare: 4, claw: 3 } };
  dc.combatants.push(cA, cB);
  await saveDirectorState({ dCombat: dc, ctx: {} }, { skipHistory: true });
  const saved = JSON.parse(JSON.stringify(stored)); // what the scene flag really holds
  const savedA = saved?.dCombat?.combatants?.find((c) => c.name === "Nidhogg");
  check("4 save writes actionMemory with the combatant", savedA?.actionMemory, { lastActionName: "soulflare", usedRounds: { soulflare: 4, claw: 3 } });
  cA.actionMemory.usedRounds.soulflare = 99;
  check("4 the save is a CLONE (later writes do not alias the saved state)", stored.dCombat.combatants.find((c) => c.name === "Nidhogg").actionMemory.usedRounds.soulflare, 4);
  const back = await reconstructDirectorCombat(saved, scene);
  const rA = back?.combatants?.find((c) => c.name === "Nidhogg");
  const rB = back?.combatants?.find((c) => c.name === "Hina");
  check("4 reconstruct restores actionMemory", rA?.actionMemory, { lastActionName: "soulflare", usedRounds: { soulflare: 4, claw: 3 } });
  check("4 a combatant with no memory restores null", rB?.actionMemory, null);
  // and the restored record still drives the gate
  const ctx = mkCtx({ rows: [row("Soulflare", { cooldown: 2 }), row("Claw", { i: 1 })], items: [item("Soulflare"), item("Claw")], dc: rA, round: back.round });
  await pick(ctx, { recordMemory: false });
  check("4 after reload Soulflare (used round 4, cd 2) is still blocked in round 4", ctx.chosenAction?.name, "Claw");
  const legacy = JSON.parse(JSON.stringify(saved)); delete legacy.dCombat.combatants[0].actionMemory;
  const back2 = await reconstructDirectorCombat(legacy, scene);
  check("4 a save from before this field resumes with null memory", back2.combatants.find((c) => c.name === "Nidhogg").actionMemory, null);
}

// ── 5. retry + cooldown: only the PERFORMED pick is stamped ──────────────────
{
  const dc = stubDc();
  // Survey says both reach (feasibility passes), the PICKER finds nobody for Claw.
  const rows = [row("Claw", { i: 0 }), row("Soulflare", { cooldown: 2, i: 1 })];
  const items = [item("Claw"), item("Soulflare", "10 MP")];
  const a = await activate({ rows, items, dc, round: 2, pickerReach: { Claw: false } });
  check("5 first pick Claw reached nobody -> retry -> Soulflare performed", [a.first, a.chosen, a.ok, a.logs.length], ["Claw", "Soulflare", true, 1]);
  check("5 retry pick stamped, unperformed first pick NOT stamped", dc.actionMemory, { lastActionName: "soulflare", usedRounds: { soulflare: 2 } });
  const b = await activate({ rows, items, dc, round: 3, pickerReach: { Claw: false } });
  check("5 next activation: Claw reaches nobody, retry finds Soulflare ON COOLDOWN -> no action (not resurrected)", [b.first, b.chosen, b.ok], ["Claw", null, false]);
  check("5   memory unchanged by the failed activation", dc.actionMemory, { lastActionName: "soulflare", usedRounds: { soulflare: 2 } });
  const c = await activate({ rows, items, dc, round: 4, pickerReach: { Claw: false } });
  check("5 round 4 (cd over): retry may use Soulflare again", [c.chosen, dc.actionMemory.usedRounds], ["Soulflare", { soulflare: 4 }]);
  const g = await activate({ rows, items, dc: stubDc(), round: 1, pickerReach: { Claw: false }, grant: true });
  check("5 grant consult: no retry, no stamp", [g.ok, g.logs.length, g.ctx.directorMemory.combatant.actionMemory], [false, 0, null]);
}

// ── 6. the all-blocked fallback never returns a cooldown-blocked action ──────
{
  const used = (n, r) => ({ tokenId: "t", actionMemory: { lastActionName: norm(n), usedRounds: { [norm(n)]: r } } });
  const solo = mkCtx({ rows: [row("Soulflare", { cooldown: 2 })], items: [item("Soulflare", "10 MP")], dc: used("Soulflare", 3), round: 3 });
  await pick(solo, { deferMemory: true });
  check("6 only action on cooldown -> no pick (Do Nothing / GM hand-off), no fallback", [solo.chosenAction, solo.actionMatchMeta.antiRepeatFallbackUsed, solo.pendingActionMemory], [null, false, null]);

  const ex = mkCtx({ rows: [row("Claw", { i: 0 }), row("Soulflare", { cooldown: 2, i: 1 })], items: [item("Claw"), item("Soulflare", "10 MP")], dc: used("Soulflare", 3), round: 4 });
  await pick(ex, { excludeActions: ["Claw"], deferMemory: true });
  check("6 retry exclusion leaves only the blocked action -> null", ex.chosenAction, null);

  // Feasibility graceful fallback: nothing feasible (survey finds nobody for Claw),
  // the cooldown-blocked spell must not come back through the fallback pool.
  const fb = mkCtx({ rows: [row("Claw", { i: 0 }), row("Soulflare", { cooldown: 2, i: 1 })], items: [item("Claw"), item("Soulflare", "10 MP")], surveyReach: { Claw: false }, dc: used("Soulflare", 3), round: 3 });
  await pick(fb, { deferMemory: true });
  check("6 feasibility fallback pool excludes the cooldown-blocked action", [fb.chosenAction?.name, pool(fb)], ["Claw", ["Claw:3"]]);

  // Top-priority action on cooldown, the other row 3 priorities lower (outside the
  // window while the top one competes): the lower row takes the slot.
  const pw = mkCtx({ rows: [row("Big Move", { priority: 6, cooldown: 3, i: 0 }), row("Jab", { priority: 3, i: 1 })], items: [item("Big Move"), item("Jab")], dc: used("Big Move", 1), round: 2 });
  await pick(pw, { recordMemory: false });
  check("6 blocked top priority -> lower-priority row acts (not the blocked one)", pw.chosenAction?.name, "Jab");
  const pw2 = mkCtx({ rows: [row("Big Move", { priority: 6, cooldown: 3, i: 0 }), row("Jab", { priority: 3, i: 1 })], items: [item("Big Move"), item("Jab")], dc: used("Big Move", 1), round: 4 });
  await pick(pw2, { recordMemory: false });
  check("6   cooldown over -> the priority window is back to Big Move only", [pw2.chosenAction?.name, pool(pw2)], ["Big Move", ["Big Move:0.8999999999999999"]]);
}

// ── 7. Foundry-combatant fallback still works (no director attached) ─────────
{
  const flags = {};
  const fc = {
    id: "fc1",
    getFlag: (ns, k) => flags[`${ns}.${k}`],
    setFlag: async (ns, k, v) => { flags[`${ns}.${k}`] = JSON.parse(JSON.stringify(v)); },
  };
  const rows = [row("Soulflare", { cooldown: 2, i: 0 }), row("Claw", { i: 1 })];
  const items = [item("Soulflare"), item("Claw")];
  const a = mkCtx({ rows, items, foundry: { combatant: fc, round: 7 } });
  await pick(a);
  check("7 Foundry path: stamp via setFlag, round from the Foundry combat", [a.actionMatchMeta.memoryHost, Object.values(flags)[0]], ["foundry", { lastActionName: "soulflare", usedRounds: { soulflare: 7 } }]);
  const b = mkCtx({ rows, items, foundry: { combatant: fc, round: 8 } });
  await pick(b);
  check("7 Foundry path: cooldown blocks the next round", b.chosenAction?.name, "Claw");
  // Both present: the director record wins (the Foundry doc is only a shadow).
  const dc = stubDc();
  const c = mkCtx({ rows, items, foundry: { combatant: fc, round: 9 }, dc, round: 1 });
  const before = JSON.stringify(flags);
  await pick(c);
  check("7 director + Foundry combatant: director wins, flag untouched", [c.actionMatchMeta.memoryHost, dc.actionMemory?.usedRounds, JSON.stringify(flags) === before], ["director", { soulflare: 1 }, true]);
}

console.log(failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
