// Tests for the Battle Grade v2 maths. No game required.
// Run: node scripts/battle-director/battle-grade/grade-core.test.mjs
import * as C from "./grade-core.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? "  " + JSON.stringify(detail) : ""}`);
  if (!ok) fail++;
};

// ── fixtures ────────────────────────────────────────────────────────────────
const PC = (key, extra = {}) => ({ key, side: "party", name: key[0].toUpperCase() + key.slice(1), level: 45, maxHp: 100, recipient: true, ...extra });
const EN = (key, extra = {}) => ({ key, side: "enemy", name: "E-" + key, level: 45, rank: "soldier", activation: 1, maxHp: 120, ...extra });
const roster = (...cs) => Object.fromEntries(cs.map((c) => [c.key, c]));
const party4 = [PC("keren"), PC("blanche"), PC("zarg"), PC("hina")];
const three = [EN("e1"), EN("e2"), EN("e3")];
const act = (a, r = 1, ak = "Attack", tg = []) => ({ k: "act", r, a, ak, tg });
const dmg = (a, t, v, r = 1, extra = {}) => ({ k: "dmg", r, a, t, v, ...extra });
const row = (attacker, affinity = "Normal", mode = "Damage", extra = {}) => ({ attacker, attack_target: "x", apply_mode: mode, value_type: "HP", value: "10", affinity, efficiency: "100%", ...extra });

// ── Par / Threat ────────────────────────────────────────────────────────────
check("par: 3 soldiers, 4 PCs = 2", C.computePar(three, 4) === 2);
check("par: champion(5) + 2 soldiers, 4 PCs = 3", C.computePar([EN("b", { rank: "champion", activation: 5 }), EN("s1"), EN("s2")], 4) === 3);
check("par: champion with activation 1 still counts 2", C.unitsOf({ rank: "champion", activation: 1 }) === 2);
check("par: elite = 2 units", C.unitsOf({ rank: "elite" }) === 2);
check("threat: even", C.computeThreat(three, 45) === "even");
check("threat: trivial at 10+ below", C.computeThreat([EN("s", { level: 30 })], 45) === "trivial");
check("threat: hard at 5+ above", C.computeThreat([EN("s", { level: 50 })], 45) === "hard");
check("threat: any elite = hard", C.computeThreat([EN("s"), EN("el", { rank: "elite" })], 45) === "hard");
check("threat: champion = boss (even if low level)", C.computeThreat([EN("b", { rank: "champion", level: 10 })], 45) === "boss");

// ── a clean S fight ─────────────────────────────────────────────────────────
function cleanFight() {
  const R = roster(...party4, ...three);
  const events = [];
  for (const p of ["keren", "blanche", "zarg", "hina"]) events.push(act(p, 1), act(p, 2));
  events.push(dmg("keren", "e1", 120, 1, { c: true, di: "i1" }), dmg("zarg", "e2", 120, 2), dmg("blanche", "e3", 120, 2));
  events.push({ k: "kill", r: 2, a: "keren", t: "e1" }, { k: "kill", r: 2, a: "blanche", t: "e3" });
  events.push({ k: "hit", r: 1, a: "e1", t: "zarg" }, dmg("e1", "zarg", 20, 1));
  events.push({ k: "ae", r: 1, a: "blanche", t: "e2", buff: false }, { k: "ae", r: 1, a: "hina", t: "keren", buff: true });
  events.push({ k: "ae", r: 1, a: "hina", t: "zarg", buff: true }, { k: "ae", r: 2, a: "hina", t: "blanche", buff: true });
  const rows = [row("Keren", "Vulnerable"), row("Keren", "Vulnerable"), row("Zarg", "Vulnerable"), row("Blanche", "Vulnerable", "Damage", { efficiency: "125%" }), row("Keren", "Vulnerable")];
  return C.computeGrade({ roster: R, events, rows, rounds: 2 });
}
const S = cleanFight();
check("clean fight: tempo full under Par", S.gauges.tempo === 25, S.gauges);
check("clean fight: exploit near full", S.gauges.exploit >= 20, S.gauges);
check("clean fight: precision full", S.gauges.precision === 15);
check("clean fight: grade S", S.letter === "S", { score: S.score, g: S.gauges });
check("clean fight: board +", S.boardDelta >= 1, { d: S.boardDelta, stars: S.stars });

// ── KO blocks S, trivial caps at B ──────────────────────────────────────────
check("letter: 95 with a KO = A", C.letterOf(95, { kos: 1, threat: "even" }) === "A");
check("letter: 95 trivial = B", C.letterOf(95, { kos: 0, threat: "trivial" }) === "B");
check("letter: 92 even = S", C.letterOf(92, { kos: 0, threat: "even" }) === "S");
check("letter: 75 = B", C.letterOf(75) === "B");
check("letter: 10 = F", C.letterOf(10) === "F");

// ── Guard drains with hits ──────────────────────────────────────────────────
function hitFight(hits) {
  const R = roster(...party4, ...three);
  const events = [act("keren"), dmg("keren", "e1", 50)];
  for (let i = 0; i < hits; i++) events.push({ k: "hit", r: 1, a: "e2", t: "zarg" }, dmg("e2", "zarg", 15));
  return C.computeGrade({ roster: R, events, rows: [], rounds: 2 });
}
const g0 = hitFight(0).gauges.guard, g3 = hitFight(3).gauges.guard, g6 = hitFight(6).gauges.guard;
check("guard: more hits taken → lower Guard", g0 > g3 && g3 > g6, { g0, g3, g6 });
check("guard: every expected hit landing costs the hit weight", g0 - hitFight(6).gauges.guard >= C.G.HITS_WEIGHT, { g0, g6 });

// ── ✦ / ✗ and the board ─────────────────────────────────────────────────────
const mk = C.marks({ tempo: 10, exploit: 24, precision: 6, guard: 24, teamwork: 2 });
check("marks: ✦ on exploit + guard", mk.stars.exploit && mk.stars.guard && mk.starCount === 2);
check("marks: ✗ on tempo + precision", mk.crosses.tempo && mk.crosses.precision && mk.crossCount === 2);
check("marks: teamwork never gets ✗", mk.crosses.teamwork === false);
check("board: 4 ✦ → +2", C.boardDelta({ starCount: 4, crossCount: 0, kos: 0, threat: "even" }) === 2);
check("board: 2 ✦ → 0", C.boardDelta({ starCount: 2, crossCount: 0, kos: 0, threat: "even" }) === 0);
check("board: 1 ✗ → −1", C.boardDelta({ starCount: 1, crossCount: 1, kos: 0, threat: "even" }) === -1);
check("board: KO → −2 each", C.boardDelta({ starCount: 5, crossCount: 0, kos: 1, threat: "even" }) === 1);
check("board: trivial → 0", C.boardDelta({ starCount: 5, crossCount: 0, kos: 0, threat: "trivial" }) === 0);
check("board: clamps 0..10", C.applyBoard(9, 5) === 10 && C.applyBoard(1, -4) === 0);
check("perks: 2→0 3→5 6→10 9→10 10→15", [2, 3, 6, 9, 10].map(C.perkPct).join() === "0,5,10,10,15");
check("next perk from 4 = 6 (+10%)", C.nextPerk(4)?.at === 6 && C.nextPerk(10) === null);

// ── MVP: burst vs attrition ─────────────────────────────────────────────────
function mvpFight(pressureHp) {
  const R = roster(...party4, ...three);
  const ev = [];
  for (const p of ["keren", "blanche", "zarg", "hina"]) ev.push(act(p));
  ev.push(dmg("keren", "e1", 300), dmg("zarg", "e2", 200), dmg("blanche", "e3", 150), dmg("hina", "e3", 20));
  ev.push(dmg("e1", "zarg", pressureHp), { k: "heal", r: 1, a: "hina", t: "zarg", v: pressureHp, cr: true }, { k: "heal", r: 1, a: "hina", t: "keren", v: 60, cr: true });
  ev.push({ k: "ae", r: 1, a: "hina", t: "keren", buff: true });
  return C.computeGrade({ roster: R, events: ev, rows: [], rounds: 3 });
}
check("MVP: low pressure → damage dealer", mvpFight(20).mvp === "keren", mvpFight(20).mvpScores);
check("MVP: high pressure → healer", mvpFight(380).mvp === "hina", mvpFight(380).mvpScores);
check("MVP: guests (recipient:false) never win", (() => {
  const R = roster(PC("kalina", { recipient: false }), PC("keren"), EN("e1"));
  return C.computeGrade({ roster: R, events: [act("kalina"), dmg("kalina", "e1", 999), act("keren"), dmg("keren", "e1", 1)], rows: [], rounds: 1 }).mvp === "keren";
})());

// ── Titles ──────────────────────────────────────────────────────────────────
const t = S.titles;
check("titles: everyone gets one", ["keren", "blanche", "zarg", "hina"].every((k) => t[k]), t);
check("titles: all different", new Set(Object.values(t)).size === 4, t);
check("titles: labels exist", Object.values(t).every((id) => C.TITLE_LABEL[id]));

// ── Prize bag ───────────────────────────────────────────────────────────────
let seed = 7; const rng = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
let st = { bag: [], last: null }; const seen = [];
for (let i = 0; i < 4; i++) { const d = C.drawPrize(st, { rng }); seen.push(d.prize); st = d.state; }
check("bag: one pass pays each prize once", new Set(seen).size === 4, seen);
const next = C.drawPrize(st, { rng });
check("bag: refill never repeats the last prize", next.prize !== seen[3], { last: seen[3], next: next.prize });
const noFp = C.drawPrize({ bag: ["fp", "zp"], last: null }, { eligible: (p) => p !== "fp", rng });
check("bag: capped prize is skipped and stays in the bag", noFp.prize === "zp" && noFp.state.bag.includes("fp"), noFp);
const none = C.drawPrize({ bag: [], last: null }, { eligible: () => false, rng });
check("bag: nothing eligible → null, no loop", none.prize === null);
check("zenit prize: floor 250", C.zenitPrize(1200) === 250 && C.zenitPrize(4000) === 400);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
