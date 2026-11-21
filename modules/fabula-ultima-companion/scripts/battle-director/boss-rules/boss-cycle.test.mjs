// Node checks: the Boss Cycle's pure parts (settings, phase machine), the boss-rule seams with and
// without a cycle boss, BOSS_STAGE, the transition / stage registries, and the out-of-play read.
// Run: node boss-cycle.test.mjs
import {
  ascensionTickFor, shouldAscend, ascensionCheck, ASCENSION_TEXT, ASCENSION_ZP, readCycleConfig, fallsNow, fallVariant, atRoundBoundary, roundEndTriggerFor, skipsSweepFor, holdsEventFor, voidFor,
  PHASES, BossCycle,
} from "./boss-cycle.js";
import {
  activeBossRules, bossRuleOwnsFall, bossRoundEndTrigger, bossSkipsRoundEndSweep, bossHoldsConflictEvent,
  runBossPendingBeat, runBossRoundBoundary, bossRuleIds, bossStage,
} from "./boss-rules.js";
import { registerBossCycleTransition, bossCycleTransition, bossCycleStageReader, hpQuarterStage } from "./boss-cycle-styles.js";
import { isOutOfPlay, outOfPlayEffectData } from "../out-of-play.js";
import { crackStage } from "../../sealing-crystal/crack-stage.js";

let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) pass++; else { fail++; console.log("FAIL", name, JSON.stringify(got)); } };
const NS = "fabula-ultima-companion";

// ── settings ──
ok("no settings → not a cycle boss", readCycleConfig({ flags: {} }) === null && readCycleConfig(null) === null);
ok("settings without a core → not a cycle boss", readCycleConfig({ flags: { [NS]: { bossCycle: { exposeRounds: 2 } } } }) === null);
const D = readCycleConfig({ flags: { [NS]: { bossCycle: { core: "abc" } } } });
ok("defaults: 1 exposed round, cut, carry, hold, cleanse, full HP/MP, quarters, no void",
  D.exposeRounds === 1 && D.cutRound && D.carryRoundEffects && D.holdConflictEvent && D.clearStatusesOnDown
  && D.returnHp === "full" && D.returnMp === "full" && D.stage === "core-hp-quarters" && D.voidWhileExposed === false
  && D.onDown.conflictEventAction === null && D.transition.first === null, D);
const K = readCycleConfig({ flags: { [NS]: { bossCycle: { core: "abc", exposeRounds: 0, cutRound: false, returnHp: "keep", returnMp: "keep", holdConflictEvent: false } } } });
ok("explicit offs are read; exposeRounds floors at 1", K.exposeRounds === 1 && !K.cutRound && K.returnHp === "keep" && K.returnMp === "keep" && !K.holdConflictEvent, K);

// ── the phase machine ──
ok("active + down → falls", fallsNow("active", true) && fallsNow("falling", true));
ok("not down → no fall", !fallsNow("active", false));
ok("down / exposed → no second fall at a turn end", !fallsNow("down", true) && !fallsNow("exposed", true));
ok("first fall at cycle 0, repeat later", fallVariant(0) === "first" && fallVariant(2) === "repeat");
const cfg1 = { ...D, roundLabel: "Crystal Round" };
let b = atRoundBoundary({ phase: "down", cycle: 0 }, cfg1);
ok("down → exposed at the boundary, labelled", b.act === "expose" && b.state.phase === "exposed" && b.state.exposedLeft === 1 && b.label === "Crystal Round", b);
b = atRoundBoundary(b.state, cfg1);
ok("1 exposed round: the next boundary returns him, cycle + 1", b.act === "return" && b.state.phase === "active" && b.state.cycle === 1 && b.label === null, b);
const cfg2 = { ...D, exposeRounds: 2, roundLabel: "Heart Round" };
b = atRoundBoundary({ phase: "down", cycle: 0 }, cfg2);
b = atRoundBoundary(b.state, cfg2);
ok("2 exposed rounds: the second boundary stays exposed, labelled", b.act === "stay" && b.state.exposedLeft === 1 && b.label === "Heart Round", b);
b = atRoundBoundary(b.state, cfg2);
ok("…and the third returns him", b.act === "return" && b.state.phase === "active", b);
ok("active at the boundary: nothing", atRoundBoundary({ phase: "active", cycle: 1 }, cfg1).act === null);

// ── round rules per phase ──
ok("cut round fires no round_end", roundEndTriggerFor("down", D) === "none");
ok("…unless the cycle does not cut", roundEndTriggerFor("down", K) === null);
ok("other phases leave round_end to the engine", PHASES.filter((p) => p !== "down").every((p) => roundEndTriggerFor(p, D) === null));
ok("cut round carries until-end-of-round effects", skipsSweepFor("down", D) && !skipsSweepFor("exposed", D) && !skipsSweepFor("down", K));
ok("conflict event held from the fall to the return", ["falling", "down", "exposed"].every((p) => holdsEventFor(p, D)) && !holdsEventFor("active", D));
ok("…unless the cycle lets it run", !holdsEventFor("exposed", K));
ok("void only when asked, through the cut and the exposed rounds", !voidFor("exposed", D) && voidFor("down", { voidWhileExposed: true }) && voidFor("exposed", { voidWhileExposed: true }) && !voidFor("active", { voidWhileExposed: true }));

// ── registries ──
ok("built-in stage: core-hp-quarters", bossCycleStageReader("core-hp-quarters")({ core: { system: { props: { current_hp: 50, max_hp: 100 } } } }) === 2);
ok("built-in stage: cycle", bossCycleStageReader("cycle")({ state: { cycle: 3 } }) === 3);
ok("the crystal's cracks are the same rule", [100, 75, 50, 25, 0].every((h) => crackStage(h, 100) === hpQuarterStage(h, 100)));
registerBossCycleTransition("test-show", { present: () => null, beats: () => ({ down: 1, hidden: 2, reveal: 3 }) });
ok("a transition registers by name", !!bossCycleTransition("test-show") && bossCycleTransition("nope") === null && bossCycleTransition(null) === null);

// ── the seams with no cycle boss: the engine's own values ──
globalThis.game = { user: { isGM: true }, actors: { get: () => null, find: () => null } };
const plain = { dCombat: { combatants: [{ side: "enemy", actorDoc: { id: "x", name: "Imp", flags: {} }, tokenDoc: { actorId: "x" } }] } };
ok("the rule registered itself", bossRuleIds().includes(BossCycle.id));
ok("an ordinary battle: no rule claims it", activeBossRules(plain).length === 0);
ok("an ordinary battle: no owned fall", bossRuleOwnsFall(plain.dCombat.combatants[0].actorDoc, plain) === false);
ok("an ordinary battle: round_end trigger is the engine's", bossRoundEndTrigger(plain) === null);
ok("an ordinary battle: sweeps as usual", bossSkipsRoundEndSweep(plain) === false);
ok("an ordinary battle: the event's round end runs", bossHoldsConflictEvent(plain) === false);
ok("an ordinary battle: no beat cuts", (await runBossPendingBeat(plain, "turn_end")).cut === false);
ok("an ordinary battle: no round label", (await runBossRoundBoundary(plain)) === null);
ok("an ordinary battle: BOSS_STAGE 0", bossStage(plain) === 0 && bossStage(null) === 0);

// ── a cycle boss, its core in the cut phase ──
const bossActor = { id: "BOSS1", uuid: "Actor.BOSS1", name: "Dragon", flags: { [NS]: { bossCycle: { core: "CORE1", roundLabel: "Crystal Round" } } } };
const coreAt = (hp, phase = "down") => ({ name: "Core", system: { props: { current_hp: hp, max_hp: 100 } },
  effects: { contents: [{ flags: { [NS]: { bossCycleState: { phase, cycle: 0, exposedLeft: 0 } } } }] } });
const battle = (hp, phase) => ({ dCombat: { combatants: [
  { side: "enemy", actorDoc: bossActor, tokenDoc: { actorId: null } },
  { side: "enemy", actorDoc: coreAt(hp, phase), tokenDoc: { flags: { [NS]: { bossCycleCore: true, bossCycleOf: "BOSS1" } } } },
] } });
const fight = battle(100, "down");
ok("a cycle boss's battle is claimed", activeBossRules(fight).length === 1);
ok("the rule owns the boss's fall", bossRuleOwnsFall(bossActor, fight) === true);
ok("…and not the core's", bossRuleOwnsFall(fight.dCombat.combatants[1].actorDoc, fight) === false);
ok("cut phase read from the core's AE: no round_end", bossRoundEndTrigger(fight) === "none");
ok("cut phase: sweep skipped", bossSkipsRoundEndSweep(fight) === true);
ok("cut phase: conflict event held", bossHoldsConflictEvent(fight) === true);
ok("BOSS_STAGE = the core's HP quarters", JSON.stringify([100, 75, 50, 25, 0].map((h) => bossStage(battle(h, "active")))) === "[0,1,2,3,3]");
ok("a core of ANOTHER boss is not this boss's", activeBossRules({ dCombat: { combatants: [fight.dCombat.combatants[0],
  { ...fight.dCombat.combatants[1], tokenDoc: { flags: { [NS]: { bossCycleCore: true, bossCycleOf: "OTHER" } } } }] } }).length === 1
  && bossRoundEndTrigger({ dCombat: { combatants: [fight.dCombat.combatants[0], { ...fight.dCombat.combatants[1], tokenDoc: { flags: { [NS]: { bossCycleCore: true, bossCycleOf: "OTHER" } } } }] } }) === null);

// ── out of play ──
const oop = { effects: { contents: [outOfPlayEffectData()] } };
ok("out of play read from the AE", isOutOfPlay(oop) === true);
ok("a disabled AE is not out of play", isOutOfPlay({ effects: { contents: [{ ...outOfPlayEffectData(), disabled: true }] } }) === false);
ok("a token's actor is read", isOutOfPlay({ actor: oop }) === true);
ok("no AE, in play", isOutOfPlay({ effects: { contents: [] } }) === false && isOutOfPlay(null) === false);
ok("the AE blocks targeting by anyone (the Guest primitive)", outOfPlayEffectData().changes.some((c) => c.key === "cannot_be_targeted_by" && c.value === "any" && c.mode === 5));

// ── the return: through transition.return on its beats, or the instant swap ──
// Fakes record every write in order: the core going out of play, the dragon's HP / MP, him back in play, the state.
{
  const trail = [];
  let eid = 0;
  const mkActor = (id, name, props, effects = []) => {
    const a = { id, uuid: `Actor.${id}`, name, flags: {}, system: { props: { ...props } }, effects: { contents: effects } };
    a.update = async (u) => { trail.push(["update", name, u]); for (const [k, v] of Object.entries(u)) if (k.startsWith("system.props.")) a.system.props[k.slice(13)] = v; };
    a.createEmbeddedDocuments = async (_t, arr) => { for (const d of arr) { trail.push(["oop-on", name]); a.effects.contents.push({ ...d, id: `e${++eid}` }); } };
    a.deleteEmbeddedDocuments = async (_t, ids) => { trail.push(["oop-off", name]); a.effects.contents = a.effects.contents.filter((e) => !ids.includes(e.id)); };
    return a;
  };
  const stateEffect = (phase) => {
    const ae = { id: `s${++eid}`, flags: { [NS]: { bossCycleState: { phase, cycle: 0, exposedLeft: 1 } } } };
    ae.update = async (u) => { const st = u[`flags.${NS}.bossCycleState`]; trail.push(["state", st.phase, st.cycle]); ae.flags[NS].bossCycleState = st; };
    return ae;
  };
  const scenario = (transitionReturn) => {
    trail.length = 0;
    const dragon = mkActor("DRG", "Dragon", { current_hp: 0, max_hp: 5000, current_mp: 10, max_mp: 400 }, [{ ...outOfPlayEffectData(), id: `e${++eid}` }]);
    dragon.flags = { [NS]: { bossCycle: { core: "CRY", roundLabel: "Crystal Round", transition: { return: transitionReturn } } } };
    const core = mkActor("CRY", "Crystal", { current_hp: 2000, max_hp: 2500 }, [stateEffect("exposed")]);
    const director = { dCombat: { scene: { id: "SCN" }, combatants: [
      { side: "enemy", actorDoc: dragon, tokenDoc: { id: "TD", actorId: null } },
      { side: "enemy", actorDoc: core, tokenDoc: { id: "TC", flags: { [NS]: { bossCycleCore: true, bossCycleOf: "DRG" } } } },
    ] } };
    return { dragon, core, director };
  };
  const quiet = console.warn, qlog = console.log;
  const hush = () => { console.warn = () => {}; console.log = () => {}; };
  const loud = () => { console.warn = quiet; console.log = qlog; };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const names = (t) => t.map((x) => x[0] === "update" ? "hp/mp" : x[0] === "at" ? `at ${x[1]}` : x[0] === "state" ? `state ${x[1]}` : `${x[0]} ${x[1]}`);

  // 1. a show: the rules follow its beats
  let doneResolve = null, presented = [];
  registerBossCycleTransition("test-return", {
    present: (spec) => { presented.push(spec); return { at: (s) => { trail.push(["at", s]); return Promise.resolve(); }, done: new Promise((r) => { doneResolve = r; }) }; },
    beats: () => ({ down: 99, hidden: 3.6, reveal: 11.35 }),
  });
  let S = scenario("test-return");
  hush();
  let resolved = false;
  const pr = BossCycle.roundBoundary(S.director).then((r) => { resolved = true; return r; });
  for (let i = 0; i < 10 && !trail.some((x) => x[0] === "state"); i++) await tick();
  await tick();
  loud();
  ok("return show: presented once with the return spec", presented.length === 1 && presented[0].variant === "return" && presented[0].bossTokenId === "TD" && presented[0].coreTokenId === "TC" && presented[0].sceneId === "SCN", presented);
  ok("return show: hidden -> core out; reveal -> HP/MP full, him in play, next phase (in that order)",
    JSON.stringify(names(trail)) === JSON.stringify(["at 3.6", "oop-on Crystal", "at 11.35", "hp/mp", "oop-off Dragon", "state active"]), names(trail));
  ok("return show: full HP and MP at the reveal", S.dragon.system.props.current_hp === 5000 && S.dragon.system.props.current_mp === 400, S.dragon.system.props);
  ok("return show: the state is active, cycle 1", S.core.effects.contents.find((e) => e.flags?.[NS]?.bossCycleState)?.flags[NS].bossCycleState.cycle === 1);
  ok("return show: the boundary waits for the show's end (the round banner comes after it)", resolved === false);
  hush(); doneResolve(); const res = await pr; loud();
  ok("…and goes on once it is over (no label: the return round is a plain round)", resolved === true && res === null, res);

  // 2. no transition.return: today's instant swap, unchanged
  S = scenario(null);
  hush(); await BossCycle.roundBoundary(S.director); loud();
  ok("no transition: the instant swap (core out, HP/MP, him in, next phase)", JSON.stringify(names(trail)) === JSON.stringify(["oop-on Crystal", "hp/mp", "oop-off Dragon", "state active"]), names(trail));

  // 3. nobody watching (sim / lean / headless): present -> null, the same instant swap
  registerBossCycleTransition("test-return-nobody", { present: () => null, beats: () => ({ hidden: 3.6, reveal: 11.35 }) });
  S = scenario("test-return-nobody");
  hush(); await BossCycle.roundBoundary(S.director); loud();
  ok("nobody watching: the rules run at once", JSON.stringify(names(trail)) === JSON.stringify(["oop-on Crystal", "hp/mp", "oop-off Dragon", "state active"]), names(trail));

  // 4. an unknown name, and a show that throws: the rules still run
  S = scenario("no-such-show");
  hush(); await BossCycle.roundBoundary(S.director); loud();
  ok("unknown transition name: the rules run without a show", trail.at(-1)?.[1] === "active" && S.dragon.system.props.current_hp === 5000, names(trail));
  registerBossCycleTransition("test-return-throws", { present: () => { throw new Error("boom"); } });
  S = scenario("test-return-throws");
  hush(); await BossCycle.roundBoundary(S.director); loud();
  ok("a show that throws at present: the rules run without it", trail.at(-1)?.[1] === "active", names(trail));

  // 5. the settings carry the return's name
  ok("readCycleConfig reads transition.return", readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c", transition: { return: "nidhogg-return" } } } } }).transition.return === "nidhogg-return");
}

// ── the round-end sweep on a cut round: endsOnCutRound (Soul Master, ruling 2026-11-19) ──
{
  const { isRoundEndSwept, endsOnCutRound } = await import("../../shared/round-end-sweep.js");
  const ae = (lifetimeMode, extra = {}) => ({ flags: { [NS]: { directorAppliedBy: { lifetimeMode }, ...extra } } });
  const flagged = ae("round_end", { endsOnCutRound: true });
  const carried = ae("round_end");
  const stampFlagged = { flags: { [NS]: { directorAppliedBy: { lifetimeMode: "round_end", endsOnCutRound: true } } } };
  const scene = ae("");
  const manual = { flags: { [NS]: { endsOnCutRound: true } } };   // not director-applied
  const cutSweep = skipsSweepFor("down", readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c" } } } }));
  ok("Nidhogg's fall (default cycle) sweeps in cut-round mode", cutSweep === true);
  ok("cut round: a flagged round_end AE is swept", isRoundEndSwept(flagged, { cutRound: cutSweep }) === true);
  ok("cut round: the flag on the director stamp counts too", isRoundEndSwept(stampFlagged, { cutRound: true }) === true && endsOnCutRound(stampFlagged));
  ok("cut round: an unflagged round_end AE carries", isRoundEndSwept(carried, { cutRound: true }) === false);
  ok("normal round end: both flagged and unflagged round_end AEs are swept", isRoundEndSwept(flagged) === true && isRoundEndSwept(carried) === true);
  ok("never: a non-round_end AE, or one not applied by the director", [scene, manual].every((e) => !isRoundEndSwept(e) && !isRoundEndSwept(e, { cutRound: true })));
  ok("a cycle without carryRoundEffects keeps the full sweep on the fall", skipsSweepFor("down", readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c", carryRoundEffects: false } } } })) === false);

  // The fall itself (BossCycle.pendingBeat → playFall) ends the flagged AEs at once,
  // before the cut round's turn_end window / any save; unflagged round effects stay.
  const order = [];
  let eid = 0;
  const mkA = (id, name, props, effs = []) => {
    const a = { id, uuid: `Actor.${id}`, name, flags: {}, system: { props: { ...props } }, effects: { contents: effs } };
    a.update = async () => {};
    a.createEmbeddedDocuments = async (_t, arr) => { for (const d of arr) a.effects.contents.push({ ...d, id: `n${++eid}`, update: async () => {} }); };
    a.deleteEmbeddedDocuments = async (_t, ids) => { order.push(["delete", name, ids.slice()]); a.effects.contents = a.effects.contents.filter((e) => !ids.includes(e.id)); };
    return a;
  };
  const stAe = () => { const s = { id: "st", flags: { [NS]: { bossCycleState: { phase: "active", cycle: 0, exposedLeft: 0 } } } };
    s.update = async (u) => { const v = u[`flags.${NS}.bossCycleState`]; order.push(["state", v.phase]); s.flags[NS].bossCycleState = v; }; return s; };
  const dragon = mkA("DRG2", "Dragon", { current_hp: 0, max_hp: 5000 });
  dragon.flags = { [NS]: { bossCycle: { core: "CRY2", clearStatusesOnDown: false } } };
  const core = mkA("CRY2", "Crystal", { current_hp: 2000, max_hp: 2500 }, [stAe()]);
  const pc = mkA("PC1", "Hina", { current_hp: 50, max_hp: 100 }, [
    { id: "sm", name: "Soul Master", flags: { [NS]: { endsOnCutRound: true, directorAppliedBy: { lifetimeMode: "round_end" } } } },
    { id: "rp", name: "Rampart", flags: { [NS]: { directorAppliedBy: { lifetimeMode: "round_end" } } } },
  ]);
  const pcTurn = { side: "party", actorDoc: pc, tokenDoc: { id: "TP", actorId: null }, turnsRemaining: 1 };
  const dir = { ctx: {}, dCombat: { scene: { id: "SCN" }, combatants: [
    { side: "enemy", actorDoc: dragon, tokenDoc: { id: "TD2", actorId: null }, turnsRemaining: 2 },
    { side: "enemy", actorDoc: core, tokenDoc: { id: "TC2", flags: { [NS]: { bossCycleCore: true, bossCycleOf: "DRG2" } } } },
    pcTurn,
  ] } };
  const qw = console.warn, ql = console.log; console.warn = () => {}; console.log = () => {};
  let fell = null;
  try { fell = await BossCycle.pendingBeat(dir, "turn_end"); } finally { console.warn = qw; console.log = ql; }
  const left = pc.effects.contents.map((e) => e.name);
  const iDel = order.findIndex((x) => x[0] === "delete" && x[1] === "Hina");
  const iDown = order.findIndex((x) => x[0] === "state" && x[1] === "down");
  ok("the fall: pendingBeat cut the round", fell?.cut === true && pcTurn.turnsRemaining === 0, { fell, turns: pcTurn.turnsRemaining });
  ok("the fall: the endsOnCutRound AE is gone the moment pendingBeat returns (before ROUND_END)", !left.includes("Soul Master"), left);
  ok("the fall: an unflagged round_end AE carries", left.includes("Rampart"), left);
  ok("the fall: swept before the phase reaches down (start of the fall)", iDel >= 0 && iDown >= 0 && iDel < iDown, order);
  ok("the fall: the ROUND_END backstop then finds nothing more to take", pc.effects.contents.every((e) => !isRoundEndSwept(e, { cutRound: true })), left);
}

// ── permanentExpose: the Oath of Servitude (spec 6, docs §4c item 8) ──
{
  const { hasFlaggedEffect, isCyclePc, everyPcHas, oathGain, permanentDue, isPermanentExposed, readState, ascensionCheck } = await import("./boss-cycle.js");
  // 1. settings
  ok("permanentExpose absent → null", readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c" } } } }).permanentExpose === null);
  ok("permanentExpose without a key → null", readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c", permanentExpose: { coreGainFraction: 0.5 } } } } }).permanentExpose === null);
  const PE = readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c", permanentExpose: { whenEveryPcHas: " noxServant ", coreGainFraction: "0.5" } } } } }).permanentExpose;
  ok("permanentExpose normalised: key trimmed, fraction \"0.5\" → 0.5, no transition", PE && PE.whenEveryPcHas === "noxServant" && PE.coreGainFraction === 0.5 && PE.transition === null, PE);
  ok("permanentExpose fraction clamps to [0, 1]; junk → 0",
    readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c", permanentExpose: { whenEveryPcHas: "k", coreGainFraction: 3 } } } } }).permanentExpose.coreGainFraction === 1
    && readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c", permanentExpose: { whenEveryPcHas: "k", coreGainFraction: "x" } } } } }).permanentExpose.coreGainFraction === 0);
  ok("permanentExpose.transition is read", readCycleConfig({ flags: { [NS]: { bossCycle: { core: "c", permanentExpose: { whenEveryPcHas: "k", transition: "oath-show" } } } } }).permanentExpose.transition === "oath-show");

  // 2. isCyclePc
  const nox = (on = true, disabled = false) => ({ effects: { contents: on ? [{ disabled, flags: { [NS]: { noxServant: true } } }] : [] } });
  const pcC = (name, servant, extra = {}) => ({ side: "party",
    actorDoc: { name, flags: extra.aFlags ?? {}, system: { props: { npc_rank: extra.rank ?? "" } }, ...nox(servant, extra.disabled) },
    tokenDoc: { flags: { [NS]: extra.tFlags ?? {} }, actor: extra.tokenActor ?? null } });
  ok("isCyclePc: a party PC", isCyclePc(pcC("Hina", false)) === true);
  ok("isCyclePc: guest / bdObject / persistent summon / isSummon / isPhantasm / summonedBy / npc_rank / enemy → no", [
    pcC("g", false, { aFlags: { [NS]: { bdGuest: true } } }), pcC("o", false, { aFlags: { [NS]: { bdObject: true } } }),
    pcC("p", false, { aFlags: { [NS]: { isPersistentSummon: true } } }), pcC("s", false, { tFlags: { isSummon: true } }),
    pcC("f", false, { tFlags: { isPhantasm: true } }), pcC("b", false, { tFlags: { summonedBy: "X" } }), pcC("r", false, { rank: "elite" }),
    { ...pcC("e", false), side: "enemy" }, { side: "party", actorDoc: null },
  ].every((c) => isCyclePc(c) === false));

  // 3. everyPcHas
  const four = (n) => ["Hina", "Keren", "Blanche", "Zarg"].map((nm, i) => pcC(nm, i < n));
  ok("everyPcHas: 3 of 4 → false", everyPcHas(four(3), "noxServant") === false);
  ok("everyPcHas: 4 of 4 → true", everyPcHas(four(4), "noxServant") === true);
  ok("everyPcHas: a guest without the flag does not block", everyPcHas([...four(4), pcC("Kalina", false, { aFlags: { [NS]: { bdGuest: true } } })], "noxServant") === true);
  ok("everyPcHas: a disabled AE does not count", everyPcHas([...four(3).slice(0, 3), pcC("Zarg", true, { disabled: true })], "noxServant") === false);
  ok("everyPcHas: the flag on the token's actor counts", everyPcHas([...four(3).slice(0, 3), pcC("Zarg", false, { tokenActor: nox(true) })], "noxServant") === true);
  ok("everyPcHas: zero PCs → false; no key → false", everyPcHas([], "noxServant") === false && everyPcHas(four(4), "") === false && hasFlaggedEffect(nox(true), null) === false);

  // 4. oathGain
  ok("oathGain: 1237×0.5 → 618, 1500 → 750, 0 → 0, negative / NaN → 0",
    oathGain(1237, 0.5) === 618 && oathGain(1500, 0.5) === 750 && oathGain(0, 0.5) === 0 && oathGain(-40, 0.5) === 0 && oathGain(NaN, 0.5) === 0 && oathGain(1000, NaN) === 0);

  // 5. permanentDue
  const cfgP = { ...D, roundLabel: "Crystal Round", permanentExpose: { whenEveryPcHas: "noxServant", coreGainFraction: 0.5, transition: null } };
  ok("permanentDue: active + 4/4 → true", permanentDue({ phase: "active" }, cfgP, four(4)) === true);
  ok("permanentDue: false when already permanent / phase ≠ active / no permanentExpose / 3 of 4",
    permanentDue({ phase: "active", permanent: true }, cfgP, four(4)) === false
    && ["falling", "down", "exposed"].every((p) => permanentDue({ phase: p }, cfgP, four(4)) === false)
    && permanentDue({ phase: "active" }, D, four(4)) === false && permanentDue({ phase: "active" }, cfgP, four(3)) === false);

  // 6. the phase machine once permanent
  let pb = atRoundBoundary({ phase: "down", cycle: 2, exposedLeft: 0, permanent: true }, cfgP);
  ok("permanent: down → expose, exposedLeft 0, labelled", pb.act === "expose" && pb.state.phase === "exposed" && pb.state.exposedLeft === 0 && pb.state.permanent === true && pb.label === "Crystal Round", pb);
  const acts = [];
  for (let i = 0; i < 10; i++) { pb = atRoundBoundary(pb.state, cfgP); acts.push(pb.act); }
  ok("permanent: exposed → stay 10 times, never return, cycle unchanged", acts.every((a) => a === "stay") && pb.state.cycle === 2 && pb.state.phase === "exposed" && pb.label === "Crystal Round", { acts, st: pb.state });

  // 7. the state round-trip (readState side; the writeState side is proven by the pendingBeat runs below)
  {
    const oath = { bossHp: 1237, gain: 618, coreHpBefore: 1800, coreMaxBefore: 2500, round: 3, stageBefore: 1 };
    const st = readState({ effects: { contents: [{ flags: { [NS]: { bossCycleState: { phase: "active", cycle: 0, exposedLeft: 0, permanent: true, oath, ascTickRound: 4, ascended: false } } } }] } });
    ok("readState keeps permanent, oath, ascTickRound, ascended", st.permanent === true && JSON.stringify(st.oath) === JSON.stringify(oath) && st.ascTickRound === 4 && st.ascended === false, st);
    const legacy = readState({ effects: { contents: [{ flags: { [NS]: { bossCycleState: { phase: "down", cycle: 1, exposedLeft: 0 } } } }] } });
    ok("an old state (no new fields) reads permanent false, oath null, ascTickRound null, ascended false", legacy.permanent === false && legacy.oath === null && legacy.ascTickRound === null && legacy.ascended === false, legacy);
  }
  ok("ascensionCheck is a no-op stub (B11)", (await ascensionCheck({}, {})) === null);

  // 8-10. pendingBeat drives the Oath with fakes
  const trail = [];
  let eid = 0;
  const mk = (id, name, props, effects = []) => {
    const a = { id, uuid: `Actor.${id}`, name, flags: {}, system: { props: { ...props } }, effects: { contents: effects } };
    a.update = async (u, o) => { trail.push(["update", name, u, o ?? null]); for (const [k, v] of Object.entries(u)) if (k.startsWith("system.props.")) a.system.props[k.slice(13)] = v; };
    a.createEmbeddedDocuments = async (_t, arr) => { for (const d of arr) { trail.push(["oop-on", name]); a.effects.contents.push({ ...d, id: `o${++eid}`, update: async () => {} }); } };
    a.deleteEmbeddedDocuments = async (_t, ids) => { trail.push(["delete", name]); a.effects.contents = a.effects.contents.filter((e) => !ids.includes(e.id)); };
    return a;
  };
  const stAe = (state) => {
    const ae = { id: `st${++eid}`, flags: { [NS]: { bossCycleState: state } } };
    ae.update = async (u) => { const v = u[`flags.${NS}.bossCycleState`]; trail.push(["state", v.phase, v.permanent, v.oath ? { ...v.oath } : null, v]); ae.flags[NS].bossCycleState = v; };
    return ae;
  };
  const setup = ({ servants = 4, dragonHp = 1237, coreHp = 1800, coreMax = 2500, state = { phase: "active", cycle: 0, exposedLeft: 0 } } = {}) => {
    trail.length = 0;
    const dragon = mk("DRG3", "Dragon", { current_hp: dragonHp, max_hp: 5000 });
    dragon.flags = { [NS]: { bossCycle: { core: "CRY3", clearStatusesOnDown: false, roundLabel: "Crystal Round",
      permanentExpose: { whenEveryPcHas: "noxServant", coreGainFraction: 0.5 } } } };
    const core = mk("CRY3", "Crystal", { current_hp: coreHp, max_hp: coreMax }, [stAe(state), { ...outOfPlayEffectData(), id: `o${++eid}` }]);
    const pcs = ["Hina", "Keren", "Blanche", "Zarg"].map((nm, i) => ({ side: "party", turnsRemaining: 1, tokenDoc: { id: `T${nm}`, flags: {} },
      actorDoc: mk(`PC${i}`, nm, { current_hp: 1, max_hp: 1, npc_rank: "" }, i < servants ? [{ id: `nx${i}`, flags: { [NS]: { noxServant: true } } }] : []) }));
    const director = { ctx: {}, dCombat: { round: 3, scene: { id: "SCN" }, combatants: [
      { side: "enemy", actorDoc: dragon, tokenDoc: { id: "TD3", actorId: null }, turnsRemaining: 1 },
      { side: "enemy", actorDoc: core, tokenDoc: { id: "TC3", flags: { [NS]: { bossCycleCore: true, bossCycleOf: "DRG3" } } } },
      ...pcs,
    ] } };
    return { dragon, core, director, pcs };
  };
  const mute = async (fn) => { const qw = console.warn, ql = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = qw; console.log = ql; } };
  const run = (d, where = "turn_end") => mute(() => BossCycle.pendingBeat(d, where));
  const tag = (x) => x[0] === "update" ? `update ${x[1]}` : x[0] === "state" ? `state ${x[1]}${x[2] ? "+perm" : ""}` : `${x[0]} ${x[1]}`;

  // 8. 4 of 4
  let S = setup();
  let res = await run(S.director);
  const tags = trail.map(tag);
  const iRec = tags.indexOf("state active+perm"), iCore = tags.indexOf("update Crystal"), iDrg = tags.indexOf("update Dragon");
  const iFall = tags.indexOf("state falling+perm"), iDown = tags.indexOf("state down+perm");
  ok("Oath: record → core → dragon → falling → down (in that order)", iRec === 0 && iRec < iCore && iCore < iDrg && iDrg < iFall && iFall < iDown, tags);
  const rec = trail[iRec]?.[3];
  ok("Oath: the record = { bossHp 1237, gain 618, before 1800/2500, round 3 }", rec && rec.bossHp === 1237 && rec.gain === 618 && rec.coreHpBefore === 1800 && rec.coreMaxBefore === 2500 && rec.round === 3, rec);
  ok("Oath: core update is absolute { max_hp 3118, current_hp 2418 }", JSON.stringify(trail[iCore]?.[2]) === JSON.stringify({ "system.props.max_hp": 3118, "system.props.current_hp": 2418 }), trail[iCore]);
  ok("Oath: dragon to HP 0 with fuReactionTriggersHandled", trail[iDrg]?.[2]["system.props.current_hp"] === 0 && trail[iDrg]?.[3]?.fuReactionTriggersHandled === true, trail[iDrg]);
  ok("Oath: the ordinary fall cut the round (every turnsRemaining 0)", res?.cut === true && S.director.dCombat.combatants.every((c) => !c.turnsRemaining), { res });
  ok("Oath: boss out of play, core in play", tags.includes("oop-on Dragon") && tags.includes("delete Crystal"), tags);
  const downWrite = trail[iDown]?.[4];
  ok("writeState round-trip: the {...st, phase} fall writes keep permanent + oath (+ reserved fields)",
    downWrite?.permanent === true && downWrite?.oath?.gain === 618 && "ascTickRound" in downWrite && downWrite.ascended === false, downWrite);
  ok("Oath: isPermanentExposed true after", isPermanentExposed(S.director) === true && readState(S.core).phase === "down");
  // the boundaries after: expose, then stay forever (B11 seam called, no-op), never a return
  const bActs = [];
  await mute(async () => {
    for (let i = 0; i < 4; i++) {
      trail.length = 0;
      const r = await BossCycle.roundBoundary(S.director);
      bActs.push([readState(S.core).phase, r?.label ?? null, trail.some((x) => x[0] !== "state" && !(x[0] === "update" && x[1] === "Dragon" && "system.props.zero_power_value" in x[2])), readState(S.core).permanent]);
    }
  });
  ok("Oath: 4 boundaries → exposed + permanent, labelled, no other write (no return), dragon stays 0",
    bActs.every(([p, l, other, perm]) => p === "exposed" && l === "Crystal Round" && !other && perm) && S.dragon.system.props.current_hp === 0 && readState(S.core).cycle === 0, bActs);
  // a second pendingBeat after the Oath: nothing (not due again, no fall in exposed)
  trail.length = 0;
  res = await run(S.director);
  ok("Oath: a later pendingBeat does nothing", res === null && trail.length === 0, trail.map(tag));

  // 8 control: 3 of 4
  S = setup({ servants: 3 });
  res = await run(S.director);
  ok("control 3 of 4: no write at all, phase active, null", res === null && trail.length === 0 && readState(S.core).phase === "active" && readState(S.core).permanent === false
    && S.core.system.props.current_hp === 1800 && S.dragon.system.props.current_hp === 1237 && isPermanentExposed(S.director) === false, trail.map(tag));

  // 9. replay after F5: record written, phase falling, core already gained → same absolute values, no second record
  const oath0 = { bossHp: 1237, gain: 618, coreHpBefore: 1800, coreMaxBefore: 2500, round: 3, stageBefore: 1 };
  S = setup({ dragonHp: 0, coreHp: 2418, coreMax: 3118, state: { phase: "falling", cycle: 0, exposedLeft: 0, permanent: true, oath: oath0 } });
  res = await run(S.director);
  ok("replay (core already gained): no core write, no new record, core 2418/3118, the fall replays",
    !trail.some((x) => x[0] === "update" && x[1] === "Crystal") && !trail.some((x) => x[0] === "state" && x[1] === "active")
    && S.core.system.props.current_hp === 2418 && S.core.system.props.max_hp === 3118 && readState(S.core).phase === "down"
    && JSON.stringify(readState(S.core).oath) === JSON.stringify(oath0) && res?.cut === true, trail.map(tag));
  // 9b. F5 between the record and the writes: the replay applies the RECORDED numbers (not a recompute from 900 HP)
  S = setup({ dragonHp: 900, coreHp: 1800, coreMax: 2500, state: { phase: "active", cycle: 0, exposedLeft: 0, permanent: true, oath: oath0 } });
  res = await run(S.director);
  ok("replay (record only): core → 2418/3118 from the record, dragon → 0, no new record",
    S.core.system.props.current_hp === 2418 && S.core.system.props.max_hp === 3118 && S.dragon.system.props.current_hp === 0
    && JSON.stringify(readState(S.core).oath) === JSON.stringify(oath0) && !trail.some((x) => x[0] === "state" && x[1] === "active") && res?.cut === true, trail.map(tag));

  // 10. the dragon already at 0 (he and the last Servant fell in one action): gain 0, the fall still plays
  S = setup({ dragonHp: 0 });
  res = await run(S.director);
  ok("dragon at 0: gain 0, core unchanged, no HP write, the fall plays",
    readState(S.core).oath?.gain === 0 && S.core.system.props.current_hp === 1800 && S.core.system.props.max_hp === 2500
    && !trail.some((x) => x[0] === "update") && readState(S.core).permanent === true && readState(S.core).phase === "down" && res?.cut === true, trail.map(tag));

  // a boss with NO permanentExpose and every PC flagged: today's behaviour (no Oath, no fall while he stands)
  S = setup();
  delete S.dragon.flags[NS].bossCycle.permanentExpose;
  res = await run(S.director);
  ok("control: no permanentExpose setting → nothing happens even at 4/4", res === null && trail.length === 0, trail.map(tag));

  // ── B11: the Ascension ──
  const P = { permanent: true, phase: "exposed", cycle: 0, exposedLeft: 0 };
  ok("ASCENSION_TEXT exact", ASCENSION_TEXT === "The heroes succumb to the power of the dragon king. Now their soul is bound to their servitude, for eternity." && ASCENSION_ZP === 6);
  let t = ascensionTickFor({ ...P, permanent: false }, 2, 3);
  ok("tick: no Oath → unchanged, no ascend", t.zp === 2 && t.ascend === false && t.state.ascTickRound === undefined, t);
  t = ascensionTickFor({ ...P, ascTickRound: null, ascended: false }, 4, 3);
  ok("tick: Oath, 4 @ round 3 → 5, ascTickRound 3", t.zp === 5 && t.state.ascTickRound === 3 && !t.ascend, t);
  const t2 = ascensionTickFor(t.state, t.zp, 3);
  ok("tick: same round again → once only", t2.zp === 5 && t2.state === t.state && !t2.ascend, t2);
  const t3 = ascensionTickFor(t.state, 5, 4);
  ok("tick: 5 @ round 4 → 6 + ascend", t3.zp === 6 && t3.ascend === true && t3.state.ascTickRound === 4, t3);
  ok("tick: ended / freeRound / ascended → no-op",
    [ascensionTickFor(P, 4, 3, { ended: true }), ascensionTickFor(P, 4, 3, { freeRound: true }), ascensionTickFor({ ...P, ascended: true }, 4, 3)].every((x) => x.zp === 4 && !x.ascend));
  ok("tick: never above 6", ascensionTickFor(P, 6, 9).zp === 6 && ascensionTickFor(P, 9, 9).zp === 6);
  ok("shouldAscend truth table", shouldAscend(P, 6) && shouldAscend(P, 7) && !shouldAscend(P, 5) && !shouldAscend({ ...P, permanent: false }, 6)
    && !shouldAscend({ ...P, ascended: true }, 6) && !shouldAscend(P, 6, true));
  ok("state round-trip: ascTickRound / ascended survive readState",
    (() => { const r = readState({ effects: { contents: [{ flags: { [NS]: { bossCycleState: { ...P, ascTickRound: 5, ascended: true } } } }] } }); return r.ascTickRound === 5 && r.ascended === true; })());

  // the rule with fakes: ZP + stay boundaries
  const rig = (zp, { round = 3 } = {}) => {
    const R = setup({ state: { ...P } });
    R.dragon.system.props.zero_power_value = zp;
    R.director.dCombat.round = round; R.endCalls = 0;
    R.director.dCombat.end = () => { R.endCalls++; R.director.dCombat.ended = true; };
    return R;
  };
  const zpw = () => trail.filter((x) => x[0] === "update" && x[1] === "Dragon" && "system.props.zero_power_value" in x[2]).map((x) => x[2]["system.props.zero_power_value"]);
  let R = rig(2);
  delete R.dragon.flags[NS].bossCycle.permanentExpose;
  R.core.effects.contents[0].flags[NS].bossCycleState.permanent = false;
  await mute(() => ascensionCheck(R.director));
  ok("rule: no Oath (permanent false) → no ZP write, no end", zpw().length === 0 && R.endCalls === 0 && R.dragon.system.props.zero_power_value === 2, trail.map(tag));
  R = rig(4, { round: 3 });
  await mute(() => BossCycle.roundBoundary(R.director));
  ok("rule: boundary @ round 3 → ZP 5, ascTickRound 3, no end", zpw().join() === "5" && readState(R.core).ascTickRound === 3 && R.endCalls === 0 && !R.director.dCombat.outcomeOverride, trail.map(tag));
  await mute(() => BossCycle.roundBoundary(R.director));
  ok("rule: re-entry in the same round → still 5 (once per round)", R.dragon.system.props.zero_power_value === 5 && zpw().join() === "5");
  R.director.dCombat.round = 4;
  await mute(() => BossCycle.roundBoundary(R.director));
  ok("rule: round 4 → 6 → defeat + end once + style",
    R.dragon.system.props.zero_power_value === 6 && R.director.dCombat.outcomeOverride === "defeat" && R.endCalls === 1
    && R.director.ctx.battleEndStyle?.style === "dragon_ascension" && R.director.ctx.battleEndStyle.quiet === true && R.director.ctx.battleEndStyle.text === ASCENSION_TEXT
    && readState(R.core).ascended === true && readState(R.core).ascTickRound === 4, { zp: R.dragon.system.props.zero_power_value, ctx: R.director.ctx });
  R.director.dCombat.ended = false; R.director.dCombat.round = 5; R.director.dCombat.outcomeOverride = null;
  await mute(() => BossCycle.roundBoundary(R.director));
  // fix pass C item 1: ascended but not ended (an F5 between the flag and dc.end()) finishes the loss, never cancels it
  ok("rule: ascended + not ended (F5 mid-Ascension) → no tick, the loss finishes (end again, defeat)",
    R.endCalls === 2 && R.dragon.system.props.zero_power_value === 6 && R.director.dCombat.outcomeOverride === "defeat" && readState(R.core).ascTickRound === 4, { end: R.endCalls });
  R.director.dCombat.round = 6;
  await mute(() => BossCycle.roundBoundary(R.director));
  ok("rule: …and once ended, ascended blocks any repeat (no tick, no third end)", R.endCalls === 2 && R.dragon.system.props.zero_power_value === 6);
  // victory wins the tie: the battle already ended → no tick
  R = rig(5, { round: 7 });
  R.director.dCombat.ended = true;
  await mute(() => BossCycle.roundBoundary(R.director));
  ok("control: dc.ended (Crystal broken) at 5 → no tick, no Ascension, no style", R.dragon.system.props.zero_power_value === 5 && R.endCalls === 0 && readState(R.core).ascended === false && !R.director.ctx.battleEndStyle);
  // a cut-in that throws must not block the loss
  R = rig(5, { round: 8 });
  globalThis.FUCompanion = { api: { cutinBroadcast: async () => { throw new Error("cache miss"); } } };
  await mute(() => BossCycle.roundBoundary(R.director));
  delete globalThis.FUCompanion;
  ok("a failing cut-in does not block the loss", R.endCalls === 1 && R.director.dCombat.outcomeOverride === "defeat");
  // other-source watcher seam (dark): ZP written to 6 → immediate Ascension, once
  R = rig(4, { round: 9 });
  R.dragon.system.props.zero_power_value = 6;
  await mute(() => BossCycle.onActorUpdate(R.director, R.dragon, { system: { props: { zero_power_value: 6 } } }));
  await mute(() => BossCycle.onActorUpdate(R.director, R.dragon, { system: { props: { zero_power_value: 6 } } }));
  ok("onActorUpdate: ZP 6 on the boss with the Oath → one Ascension", R.endCalls === 1 && R.director.dCombat.outcomeOverride === "defeat");
  // ZP reset at conflict start (an Oath boss only)
  R = rig(5);
  R.director.dCombat.scene = null;   // spawnCore returns early
  await mute(() => BossCycle.onConflictStart(R.director));
  ok("conflict start: an Oath boss's ZP resets to 0", R.dragon.system.props.zero_power_value === 0);
  R = rig(5);
  delete R.dragon.flags[NS].bossCycle.permanentExpose; R.director.dCombat.scene = null;
  await mute(() => BossCycle.onConflictStart(R.director));
  ok("control: no permanentExpose → ZP untouched at conflict start", R.dragon.system.props.zero_power_value === 5);

  // ── B10b: the cracks never close (S3), the return conversion (B13), the updateActor watcher ──
  {
    const { stageNeverLower, bossCycleDeps, downedPcs, initBossCycle } = await import("./boss-cycle.js");
    const { crackFloorOf } = await import("../../sealing-crystal/crack-stage.js");
    // S3: 1000/2500 = stage 2; after +gain on both: 1750/3250 = 54% = stage 1 raw
    let S3 = setup({ coreHp: 1000, coreMax: 2500, dragonHp: 1500 });
    await run(S3.director);
    const st3 = readState(S3.core), cp3 = S3.core.system.props;
    ok("S3: the Oath records stageBefore 2 (1000/2500)", st3.oath?.stageBefore === 2 && cp3.current_hp === 1750 && cp3.max_hp === 3250, { oath: st3.oath, cp3 });
    ok("S3: the raw HP fraction alone would read stage 1 (the bug)", hpQuarterStage(cp3.current_hp, cp3.max_hp) === 1);
    ok("S3: BOSS_STAGE (rule.stage) stays 2 after the HP/Max raise", bossStage(S3.director) === 2, bossStage(S3.director));
    ok("S3: crackFloorOf(core) reads 2 off the state AE", crackFloorOf(S3.core) === 2);
    ok("S3: the stage still goes UP (core hit down to 10%) -> 3", (() => { S3.core.system.props.current_hp = 325; return bossStage(S3.director) === 3; })());
    ok("S3: stageNeverLower pure table", stageNeverLower(1, { oath: { stageBefore: 2 } }) === 2 && stageNeverLower(3, { oath: { stageBefore: 2 } }) === 3 && stageNeverLower(1, null) === 1 && stageNeverLower(0, { oath: null }) === 0);
    ok("S3: the core-hp-quarters reader folds the floor in", bossCycleStageReader("core-hp-quarters")({ core: { system: { props: { current_hp: 1750, max_hp: 3250 } } }, state: { oath: { stageBefore: 2 } } }) === 2);
    ok("S3 control: no Oath -> crackFloorOf 0 and the stage is the raw one",
      (() => { const C = setup({ coreHp: 1000, coreMax: 2500, servants: 3 }); return crackFloorOf(C.core) === 0 && bossStage(C.director) === 2 && readState(C.core).oath === null; })());
    ok("S3: an old oath without stageBefore reads 0",
      readState({ effects: { contents: [{ flags: { [NS]: { bossCycleState: { phase: "active", permanent: true, oath: { gain: 1 } } } } }] } }).oath.stageBefore === 0);

    // B13: the return converts the PCs at 0 HP, and only those
    const retRig = (hps) => {
      const R2 = setup({ servants: 0, dragonHp: 0, state: { phase: "exposed", cycle: 0, exposedLeft: 1 } });
      R2.dragon.flags[NS].bossCycle.permanentExpose = { whenEveryPcHas: "noxServant", coreGainFraction: 0.5 };
      R2.pcs.forEach((c, i) => { c.actorDoc.system.props.current_hp = hps[i]; c.tokenDoc.uuid = `Scene.S.Token.${c.tokenDoc.id}`; });
      R2.calls = [];
      bossCycleDeps.emitStaysDown = async (d, actor, payload, set) => {
        R2.calls.push(["emit", actor.name, payload.subjectActorUuid, payload.subjectTokenUuid, set instanceof Set, actor.system.props.current_hp]);
        actor.effects.contents.push({ disabled: false, flags: { [NS]: { noxServant: true } } });
        actor.system.props.current_hp = 1;   // the Servant reaction raises them
      };
      bossCycleDeps.clearStaysDownSettled = (a) => R2.calls.push(["clear", a.name]);
      bossCycleDeps.checkSideWipe = () => { R2.calls.push(["wipe"]); return false; };
      return R2;
    };
    const reset = () => { bossCycleDeps.emitStaysDown = null; bossCycleDeps.clearStaysDownSettled = null; bossCycleDeps.checkSideWipe = null; };
    let R2 = retRig([0, 0, 1, 1]);
    ok("downedPcs: only PCs at HP <= 0", downedPcs(R2.director.dCombat.combatants).map((c) => c.actorDoc.name).join() === "Hina,Keren");
    await mute(() => BossCycle.roundBoundary(R2.director));
    const names = R2.calls.filter((c) => c[0] === "emit").map((c) => c[1]);
    ok("return: the dragon is back at full HP, the cycle moved on", R2.dragon.system.props.current_hp === 5000 && readState(R2.core).phase === "active" && readState(R2.core).cycle === 1);
    ok("return: emitStaysDown for the PCs at 0 only (Hina, Keren), sequential, fresh Set, ids passed, they were at 0 on entry",
      names.join() === "Hina,Keren" && R2.calls.filter((c) => c[0] === "emit").every((c) => c[4] === true && c[5] === 0 && c[2] && c[3]), R2.calls);
    ok("return: order = clear his settled mark, emits, then checkSideWipe last",
      R2.calls[0].join() === "clear,Dragon" && R2.calls.at(-1)[0] === "wipe" && R2.calls.filter((c) => c[0] === "wipe").length === 1, R2.calls);
    ok("return: only 2 of 4 are Servants, so no Oath is due",
      !permanentDue(readState(R2.core), readCycleConfig(R2.dragon), R2.director.dCombat.combatants));
    // everyone at 0 -> everyone a Servant -> the Oath at the next pendingBeat (the first TURN_START)
    R2 = retRig([0, 0, 0, 0]);
    await mute(() => BossCycle.roundBoundary(R2.director));
    ok("return (all 4 at 0): 4 conversions, state active, not yet permanent", R2.calls.filter((c) => c[0] === "emit").length === 4 && readState(R2.core).permanent === false);
    trail.length = 0;
    const cutRes = await run(R2.director, "turn_start");
    const sR = readState(R2.core);
    ok("return making everyone a Servant: the next pendingBeat plays the Oath (permanent, gain 2500 off his full HP, round cut)",
      sR.permanent === true && sR.oath?.bossHp === 5000 && sR.oath?.gain === 2500 && R2.dragon.system.props.current_hp === 0 && cutRes?.cut === true, { sR, cutRes });
    // control: with no PCs at 0 the return converts nobody and calls the wipe check
    R2 = retRig([1, 1, 1, 1]);
    await mute(() => BossCycle.roundBoundary(R2.director));
    ok("control: nobody at 0 -> no emit, wipe check still runs, no Oath", R2.calls.filter((c) => c[0] === "emit").length === 0 && R2.calls.some((c) => c[0] === "wipe") && readState(R2.core).permanent === false);
    // a boss WITHOUT permanentExpose: the return binds nobody (no emit, no clear, no wipe check)
    R2 = retRig([0, 0, 1, 1]);
    delete R2.dragon.flags[NS].bossCycle.permanentExpose;
    await mute(() => BossCycle.roundBoundary(R2.director));
    ok("no permanentExpose: the return conversion does not run", R2.calls.length === 0 && R2.dragon.system.props.current_hp === 5000, R2.calls);
    // a throwing emit does not stop the return or the other PCs
    R2 = retRig([0, 0, 1, 1]);
    const goodEmit = bossCycleDeps.emitStaysDown;
    bossCycleDeps.emitStaysDown = async (d, a, p, s) => { if (a.name === "Hina") throw new Error("boom"); return goodEmit(d, a, p, s); };
    await mute(() => BossCycle.roundBoundary(R2.director));
    ok("a throwing emit for one PC: the others still convert, the return completes", R2.calls.some((c) => c[0] === "emit" && c[1] === "Keren") && readState(R2.core).phase === "active");
    reset();

    // the watcher: an outside ZP write to 6 while permanent
    const hooks = {};
    const prevHooks = globalThis.Hooks;
    globalThis.Hooks = { on: (n, fn) => { (hooks[n] ??= []).push(fn); } };
    initBossCycle();
    const upd = hooks.updateActor?.[0];
    ok("initBossCycle installs an updateActor watcher", typeof upd === "function");
    const withDir = (d, fn) => { globalThis.FUCompanion = { api: { experimental: { battleDirector: { getActiveDirector: () => d } } } }; return fn(); };
    const flush = () => new Promise((r) => setTimeout(r, 20));
    let W = rig(6, { round: 11 });
    W.director.dCombat.started = true;
    await mute(async () => { withDir(W.director, () => upd(W.dragon, { system: { props: { zero_power_value: 6 } } })); await flush(); });
    ok("watcher: ZP 6 written while permanent -> ascends once (defeat, end x1)", W.endCalls === 1 && W.director.dCombat.outcomeOverride === "defeat" && readState(W.core).ascended === true, { end: W.endCalls });
    await mute(async () => { withDir(W.director, () => upd(W.dragon, { system: { props: { zero_power_value: 6 } } })); await flush(); });
    ok("watcher: a second 6 write does not ascend again", W.endCalls === 1);
    W = rig(6, { round: 12 });
    W.director.dCombat.started = true;
    W.core.effects.contents[0].flags[NS].bossCycleState.permanent = false;
    await mute(async () => { withDir(W.director, () => upd(W.dragon, { system: { props: { zero_power_value: 6 } } })); await flush(); });
    ok("control: not permanent -> no ascend", W.endCalls === 0 && !W.director.dCombat.outcomeOverride);
    W = rig(4, { round: 13 });
    W.director.dCombat.started = true;
    await mute(async () => { withDir(W.director, () => upd(W.dragon, { system: { props: { zero_power_value: 5 } } })); await flush(); });
    ok("control: a write to 5 (below 6) -> no ascend", W.endCalls === 0);
    await mute(async () => { withDir(null, () => upd(W.dragon, { system: { props: { zero_power_value: 6 } } })); await flush(); });
    ok("control: no active director -> nothing", W.endCalls === 0);

    // ── Fix pass C (gate 1 area C, 2026-11-21) ──
    const { ascensionLatched, wipeHeldFor, simSeedsZp } = await import("./boss-cycle.js");
    const { bossHoldsSideWipe } = await import("./boss-rules.js");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ASC = { ...P, ascTickRound: 4, ascended: true };
    const fresh = (zp, state, round = 30) => {   // a reloaded director: same world, new dCombat, nothing in memory
      const F = setup({ state: { ...state } });
      F.dragon.system.props.zero_power_value = zp;
      F.director.dCombat.round = round; F.endCalls = 0;
      F.director.dCombat.end = () => { F.endCalls++; F.director.dCombat.ended = true; };
      return F;
    };
    // 1. the F5 latch
    ok("C1 pure: ascensionLatched = ascended && !ended", ascensionLatched({ ascended: true }) && !ascensionLatched({ ascended: true }, true) && !ascensionLatched({ ascended: false }) && !ascensionLatched(null));
    let F = fresh(6, ASC);
    trail.length = 0;
    await mute(() => BossCycle.roundBoundary(F.director));
    ok("C1 resume (boundary): ascended, not ended → the loss finishes once, style set, no ZP write, no state write",
      F.endCalls === 1 && F.director.dCombat.outcomeOverride === "defeat" && F.director.ctx.battleEndStyle?.style === "dragon_ascension"
      && zpw().length === 0 && !trail.some((x) => x[0] === "state"), trail.map(tag));
    for (const where of ["round_start", "turn_start", "turn_end"]) {
      F = fresh(6, ASC);
      trail.length = 0;
      const r = await run(F.director, where);
      ok(`C1 resume (pendingBeat ${where}): the loss finishes, nothing else plays`, F.endCalls === 1 && F.director.dCombat.outcomeOverride === "defeat" && r === null && trail.length === 0, trail.map(tag));
    }
    F = fresh(6, ASC);
    await mute(() => BossCycle.onActorUpdate(F.director, F.dragon, { system: { props: { zero_power_value: 6 } } }));
    ok("C1 resume (watcher): an outside 6 also finishes the latched loss", F.endCalls === 1);
    F = fresh(6, ASC); F.director.dCombat.ended = true;
    await mute(() => BossCycle.roundBoundary(F.director));
    await run(F.director, "turn_start");
    ok("C1 control: ascended AND ended → nothing", F.endCalls === 0 && !F.director.dCombat.outcomeOverride);

    // 2. the watcher race: the hook fires SYNCHRONOUSLY inside the tick's awaited ZP update
    const raceRig = (zp, round) => {
      const X = fresh(zp, P, round);
      X.director.dCombat.started = true;
      X.director.dCombat.combatants[0].tokenDoc.uuid = "Scene.SCN.Token.TD3";   // the cut-in needs his token
      X.order = [];
      X.director.dCombat.end = () => { X.order.push("end"); X.endCalls++; X.director.dCombat.ended = true; };
      const base = X.dragon.update;
      X.dragon.update = async (u, o) => {
        await base(u, o);
        if ("system.props.zero_power_value" in u) { X.order.push(`hook ${u["system.props.zero_power_value"]}`); upd(X.dragon, { system: { props: { zero_power_value: u["system.props.zero_power_value"] } } }); }
      };
      globalThis.FUCompanion = { api: {
        experimental: { battleDirector: { getActiveDirector: () => X.director } },
        cutinBroadcast: async () => { X.order.push("cutin"); await sleep(30); X.order.push("cutin done"); },
      } };
      return X;
    };
    let X = raceRig(5, 31);
    await mute(async () => { await BossCycle.roundBoundary(X.director); X.order.push("boundary returned"); await flush(); await sleep(40); });
    ok("C2 race: the boundary that ticks 5→6 is the one that awaits the loss (hook inside the update stands down)",
      X.order.join(" | ") === "hook 6 | cutin | cutin done | end | boundary returned" && X.endCalls === 1 && readState(X.core).ascended === true && readState(X.core).ascTickRound === 31, X.order);
    // a watcher Ascension in flight (GM wrote 6) when the boundary arrives: the boundary waits for that same loss, no tick
    X = raceRig(6, 32);
    await mute(async () => { upd(X.dragon, { system: { props: { zero_power_value: 6 } } }); await BossCycle.roundBoundary(X.director); X.order.push("boundary returned"); await sleep(40); });
    ok("C2 race: a watcher's Ascension in flight → the boundary awaits it (end before it returns), once, no tick",
      X.order.join(" | ") === "cutin | cutin done | end | boundary returned" && X.endCalls === 1 && readState(X.core).ascTickRound !== 32 && zpw().length === 0, X.order);
    // a state write that throws mid-Ascension still stamps the loss (try/finally)
    X = raceRig(5, 33);
    const ae0 = X.core.effects.contents[0], aeUpd = ae0.update;
    ae0.update = async (u) => { if (u[`flags.${NS}.bossCycleState`]?.ascended) throw new Error("db down"); return aeUpd(u); };
    await mute(() => BossCycle.roundBoundary(X.director));
    ok("C2: a throwing ascended write still ends the battle as a defeat", X.endCalls === 1 && X.director.dCombat.outcomeOverride === "defeat");
    // the guard is released afterwards: a later reloaded latch still works on a new dCombat, and this dc does not deadlock
    await mute(() => BossCycle.roundBoundary(X.director));
    ok("C2: the in-flight guard is released (a later call returns, no second end)", X.endCalls === 1);

    // 3. ROUND_START: the ended-check after the boss boundary (source check: state-handlers is not loadable in Node)
    {
      const fs = await import("node:fs");
      const sh = fs.readFileSync(new URL("../state-handlers.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
      ok("C3 ROUND_START routes an ended battle right after runBossRoundBoundary (before beginPendingRound)",
        /runBossRoundBoundary\(director\)\)\?\.label \?\? null; \}\n\s+catch \(e\) \{ warn\("ROUND_START: boss-rule round boundary threw", e\); \}\n(?:\s*\/\/.*\n)*\s+if \(routeEndedCombat\(director, "ROUND_START"\)\) return;/.test(sh)
        && sh.indexOf('if (routeEndedCombat(director, "ROUND_START")) return;\n    }\n    // Deferred wrap') > 0);
      ok("C4 sideIsWiped consults bossHoldsSideWipe", /&& !bossHoldsSideWipe\(\{ dCombat: dc \}, side\);/.test(sh));
    }

    // 4. USER RULING Q2: every PC down in a Crystal Round → the party's wipe is HELD until the return
    ok("C4 pure: wipeHeldFor holds in down / exposed only, never permanent / ascended",
      wipeHeldFor({ phase: "down" }) && wipeHeldFor({ phase: "exposed", exposedLeft: 1 }) && !wipeHeldFor({ phase: "active" }) && !wipeHeldFor({ phase: "falling" })
      && !wipeHeldFor({ phase: "exposed", permanent: true }) && !wipeHeldFor({ phase: "exposed", ascended: true }) && !wipeHeldFor(null));
    const held = (hps = [0, 0, 0, 0], state = { phase: "exposed", cycle: 0, exposedLeft: 1 }) => {
      const H = setup({ servants: 0, dragonHp: 0, state });
      H.pcs.forEach((c, i) => { c.actorDoc.system.props.current_hp = hps[i]; c.turnsRemaining = 0; c.tokenDoc.uuid = `Scene.S.Token.${c.tokenDoc.id}`; });
      H.director.dCombat.combatants.forEach((c) => { c.turnsRemaining = 0; });
      return H;
    };
    let H = held();
    ok("C4 seam: all 4 PCs down in a Crystal Round → the party's wipe is held (also through a { dCombat } view)",
      bossHoldsSideWipe(H.director, "party") === true && bossHoldsSideWipe({ dCombat: H.director.dCombat }, "party") === true);
    ok("C4 seam: the ENEMY side is never held (a broken core still wins)", (() => { H.core.system.props.current_hp = 0; return bossHoldsSideWipe(H.director, "enemy") === false; })());
    ok("C4 seam: held in the cut round too (down)", bossHoldsSideWipe(held(undefined, { phase: "down", cycle: 0, exposedLeft: 0 }).director, "party") === true);
    ok("C4 controls: no hold when permanent / ascended / active / battle ended / no permanentExpose",
      !bossHoldsSideWipe(held(undefined, { ...P }).director, "party")
      && !bossHoldsSideWipe(held(undefined, { ...P, permanent: false, ascended: true }).director, "party")
      && !bossHoldsSideWipe(held(undefined, { phase: "active", cycle: 1, exposedLeft: 0 }).director, "party")
      && !bossHoldsSideWipe((() => { const h = held(); h.director.dCombat.ended = true; return h.director; })(), "party")
      && !bossHoldsSideWipe((() => { const h = held(); delete h.dragon.flags[NS].bossCycle.permanentExpose; return h.director; })(), "party"));
    // the FSM keeps the rounds passing: TURN_START's beat cuts an empty round instead of "no eligible → end"
    H = held();
    let cutR = await run(H.director, "turn_start");
    ok("C4 FSM: nobody can act in a held Crystal Round → pendingBeat turn_start cuts the round (to ROUND_END)", cutR?.cut === true, cutR);
    H = held(); H.pcs[0].actorDoc.system.props.current_hp = 5; H.pcs[0].turnsRemaining = 1;
    cutR = await run(H.director, "turn_start");
    ok("C4 FSM control: a PC with a turn left → no cut", cutR === null, cutR);
    H = held(undefined, { ...P });
    cutR = await run(H.director, "turn_start");
    ok("C4 FSM control: the Oath's permanent state → no cut", cutR === null, cutR);
    // nextTurn's "nobody has a turn next round → end" respects the hold (DirectorCombat, stubbed world)
    {
      const g0 = globalThis.game, h0 = globalThis.Hooks, f0 = globalThis.foundry;
      globalThis.Hooks = { on() {}, once() {}, callAll() {}, off() {} };
      globalThis.foundry = { utils: { randomID: () => "id" + Math.random().toString(36).slice(2) } };
      globalThis.game = { ...g0, combat: null, items: [], scenes: { contents: [], current: null }, modules: { get: () => ({ api: {} }) }, settings: { get: () => null, set: () => {} } };
      try {
        const { DirectorCombat, DirectorCombatant } = await import("../director-combat.js");
        const quiet = (fn) => { const qw = console.warn, ql = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = qw; console.log = ql; } };
        const mkDc = (Hx) => {
          const dc = new DirectorCombat({ scene: { id: "SCN", name: "Arena" } });
          dc.combatants = Hx.director.dCombat.combatants.map((c, i) => Object.assign(Object.create(DirectorCombatant.prototype), c, {
            id: `c${i}`, name: c.actorDoc.name, actorUuid: c.actorDoc.uuid, turnsPerRound: 1, turnsRemaining: 0, flags: {},
            isDefeatedLive: () => (Number(c.actorDoc.system.props.current_hp) || 0) <= 0,
          }));
          dc._notifyTurnActions = () => {}; dc._effectiveActivation = () => 0; dc.firstSide = "party";
          quiet(() => dc.start()); dc.currentCombatantId = null; dc._turnsTakenThisRound = 1;
          return dc;
        };
        let dcH = mkDc(held());
        let r = quiet(() => dcH.nextTurn());
        ok("C4 FSM: nextTurn with nobody to act, wipe held → the round wraps (deferred), the battle goes on", r.wrappedRound === true && r.ended === false && dcH.pendingRoundWrap === true && !dcH.ended, r);
        quiet(() => dcH.beginPendingRound());
        ok("C4 FSM: …and the next round begins (round + 1)", dcH.round === 1 && !dcH.ended, dcH.round);
        dcH = mkDc(held(undefined, { ...P }));
        r = quiet(() => dcH.nextTurn());
        ok("C4 FSM control: not held (the Oath's permanent state) → nextTurn ends it as before", r.ended === true && dcH.ended === true, r);
      } finally { globalThis.game = g0; globalThis.Hooks = h0; globalThis.foundry = f0; delete globalThis.__fudActiveDCombat; }
    }
    // release on the return: the boundary brings him back, converts all four, THEN the wipe check runs with the hold off
    {
      const R4 = retRig([0, 0, 0, 0]);
      const seen = [];
      bossCycleDeps.checkSideWipe = (d) => { seen.push(bossHoldsSideWipe(d, "party")); return false; };
      ok("C4 release: before the return boundary the wipe is held", bossHoldsSideWipe(R4.director, "party") === true);
      await mute(() => BossCycle.roundBoundary(R4.director));
      ok("C4 release on return: 4 conversions, then the wipe check runs once with the hold OFF (phase active)",
        R4.calls.filter((c) => c[0] === "emit").length === 4 && seen.length === 1 && seen[0] === false && readState(R4.core).phase === "active", { seen, calls: R4.calls });
      trail.length = 0;
      const oathR = await run(R4.director, "turn_start");
      ok("C4 release on return: all 4 Servants → the Oath at the first turn start (round cut)", readState(R4.core).permanent === true && oathR?.cut === true, oathR);
      reset();
      // never forever: from the cut round, the hold lasts exactly until the return
      const R5 = retRig([0, 0, 0, 0]);
      R5.core.effects.contents[0].flags[NS].bossCycleState = { phase: "down", cycle: 0, exposedLeft: 0 };
      bossCycleDeps.emitStaysDown = async () => {};   // the reaction raises nobody: the wipe must then END the battle
      const holds = [bossHoldsSideWipe(R5.director, "party")];
      await mute(() => BossCycle.roundBoundary(R5.director)); holds.push(bossHoldsSideWipe(R5.director, "party"));
      await mute(() => BossCycle.roundBoundary(R5.director)); holds.push(bossHoldsSideWipe(R5.director, "party"));
      ok("C4 never forever: down (held) → exposed (held) → return (released; nobody raised = the wipe ends it)", holds.join() === "true,true,false" && R5.calls.some((c) => c[0] === "wipe"), holds);
      reset();
    }

    // 7. beginPermanent → ascensionCheck (a party > 4 PCs: Zero Power already at 6 at the Oath)
    {
      const S7 = setup();
      S7.dragon.system.props.zero_power_value = 6; S7.endCalls = 0;
      S7.director.dCombat.end = () => { S7.endCalls++; S7.director.dCombat.ended = true; };
      trail.length = 0;
      const r7 = await run(S7.director, "turn_start");
      ok("C7 the Oath with ZP already 6 → the Ascension at once (defeat), no tick, no fall",
        S7.endCalls === 1 && S7.director.dCombat.outcomeOverride === "defeat" && readState(S7.core).ascended === true && readState(S7.core).permanent === true
        && readState(S7.core).ascTickRound === null && zpw().length === 0 && !trail.some((x) => x[0] === "state" && x[1] === "falling") && r7 === null, trail.map(tag));
      const S7c = setup();
      S7c.dragon.system.props.zero_power_value = 4; S7c.endCalls = 0;
      S7c.director.dCombat.end = () => { S7c.endCalls++; };
      const r7c = await run(S7c.director, "turn_start");
      ok("C7 control: the Oath at ZP 4 → no Ascension, no ZP write, the fall plays", S7c.endCalls === 0 && S7c.dragon.system.props.zero_power_value === 4 && r7c?.cut === true && readState(S7c.core).phase === "down");
    }

    // 8. the conflict-start ZP reset spares a sim's seeded boss ZP
    {
      const boss8 = { uuid: "Actor.DRG3", id: "DRG3", name: "Nidhogg" };
      ok("C8 simSeedsZp: no sim / no enemyZp → reset as usual", !simSeedsZp(boss8, { active: false, config: { enemyZp: 6 } }) && !simSeedsZp(boss8, { active: true, config: {} }));
      ok("C8 simSeedsZp: a number seeds every enemy; a map by name (any case) / id / uuid seeds that boss only",
        simSeedsZp(boss8, { active: true, config: { enemyZp: 5 } }) && simSeedsZp(boss8, { active: true, config: { enemyZp: { " nidhogg ": 5 } } })
        && simSeedsZp(boss8, { active: true, config: { enemyZp: { DRG3: 2 } } }) && simSeedsZp(boss8, { active: true, config: { enemyZp: { "Actor.DRG3": 0 } } })
        && !simSeedsZp(boss8, { active: true, config: { enemyZp: { Geist: 6 } } }));
    }
    delete globalThis.FUCompanion; globalThis.Hooks = prevHooks;
  }
}

console.log(`${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
