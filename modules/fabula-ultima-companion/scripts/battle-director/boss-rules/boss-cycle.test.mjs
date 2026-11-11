// Node checks: the Boss Cycle's pure parts (settings, phase machine), the boss-rule seams with and
// without a cycle boss, BOSS_STAGE, the transition / stage registries, and the out-of-play read.
// Run: node boss-cycle.test.mjs
import {
  readCycleConfig, fallsNow, fallVariant, atRoundBoundary, roundEndTriggerFor, skipsSweepFor, holdsEventFor, voidFor,
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

console.log(`${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
