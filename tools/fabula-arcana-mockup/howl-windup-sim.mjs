// Balance sim used for the 2026-11-14 Howl / Wind Up timing decision (Wolf = same round, Rock Golem = next attack).
// node tools/fabula-arcana-mockup/howl-windup-sim.mjs [games]   (A = same round, B = next attack, OFF = ability off)
// Balance sim: Howl / Wind Up timing. A = now (current rule), B = next attack, OFF = ability disabled (baseline).
// Same seeds per mode (common random numbers). AI vs AI, both casual or both skilled.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const DIR = fileURLToPath(new URL("../../modules/fabula-ultima-companion/scripts/fabula-arcana/", import.meta.url));
globalThis.FabulaArcana = globalThis.FabulaArcana || {};
vm.runInThisContext(fs.readFileSync(DIR + "fa-catalog.js", "utf8"));
vm.runInThisContext(fs.readFileSync(DIR + "fa-engine.js", "utf8"));
const E = globalThis.FabulaArcana.Engine, CAT = globalThis.FabulaArcana.Catalog, CFG = CAT.CFG;
const mul = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const MODES = { A: 0, B: 1, OFF: 2 };
const N = Number(process.argv[2] || 3000);
const LEG = E.LEGAL_TEAMS.filter((t) => t.every((c) => !CAT.CARDS[c].future));
const withCard = (cid) => LEG.filter((t) => t.includes(cid));
const without = (cid) => LEG.filter((t) => !t.includes(cid));

function play(teams, prof, seed, track) {
  const rnd = mul(seed); E.setRng(rnd); const saveRandom = Math.random; Math.random = rnd;   // AI noise too, so modes share seeds
  try {
    const m = E.Match.create({ teams });
    let guard = 0;
    while (m.phase !== "ended" && guard++ < 400) {
      const ch = [null, null];
      for (const s of [0, 1]) if (E.Match.needs(m, s)) ch[s] = E.Match.aiChoice(m, s, prof);
      if (track) track(m, ch);
      for (const s of [0, 1]) if (ch[s]) E.Match.submit(m, s, ch[s]);
    }
    return m;
  } finally { Math.random = saveRandom; }
}

function run(cid, prof, mode, n) {
  // the card under test takes the mode; the other keeps its live rule (Wolf 0 = same round, Rock Golem 1 = next attack)
  if (cid === "wolf") { CFG.HOWL_NEXT = MODES[mode]; CFG.WINDUP_NEXT = 1; } else { CFG.WINDUP_NEXT = MODES[mode]; CFG.HOWL_NEXT = 0; }
  const W = withCard(cid), O = without(cid);
  const out = { win: 0, loss: 0, draw: 0, rounds: 0, fires: 0, stack: 0, passes: 0, armedAtDecision: 0, activeDecisions: 0, lost: 0 };
  for (let g = 0; g < n; g++) {
    const r0 = mul(1000 + g); const tA = W[Math.floor(r0() * W.length)], tB = O[Math.floor(r0() * O.length)];
    const flip = g % 2;   // alternate seats
    const teams = flip ? [tB, tA] : [tA, tB], me = flip ? 1 : 0;
    let prevArmed = false;
    const m = play(teams, prof, 50000 + g, (st, ch) => {
      if (st.phase !== "choose" || !ch[me]) return;
      const pl = st.p[me], a = pl.roster[pl.active]; if (!a || a.cid !== cid) return;
      out.activeDecisions++;
      const armed = cid === "wolf" ? !!a.howl : !!a.windup;
      if (armed) { out.armedAtDecision++; if (["STRENGTH", "SHARD"].includes(ch[me].action)) out.stack++; }
      if (ch[me].action === "PASS") out.passes++;
    });
    const res = m.result; const meWin = (res === "WIN" && me === 0) || (res === "LOSS" && me === 1);
    if (res === "DRAW") out.draw++; else if (meWin) out.win++; else out.loss++;
    out.rounds += m.round;
    out.fires += cid === "wolf" ? (m.stats.howl || 0) : (m.stats.quake || 0);
  }
  return out;
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : "-");
for (const prof of [{ diff: "casual", style: null }, { diff: "skilled", style: null }]) {
  const n = prof.diff === "skilled" ? Math.round(N / 2) : N;
  for (const cid of ["wolf", "rgolem"]) {
    console.log(`\n== ${CAT.CARDS[cid].name} · AI ${prof.diff} · ${n} games per mode (team with it vs a random legal team without it) ==`);
    console.log("mode  win%  loss%  draw%  avgRounds  fires/game  armedAtDecision%  passWhileActive%  item+buff stacks/game");
    for (const mode of ["OFF", "A", "B"]) {
      const o = run(cid, prof, mode, n), g = o.win + o.loss + o.draw;
      console.log(`${mode.padEnd(4)}  ${pct(o.win, g).padStart(4)}  ${pct(o.loss, g).padStart(5)}  ${pct(o.draw, g).padStart(5)}  ${(o.rounds / g).toFixed(2).padStart(9)}  ${(o.fires / g).toFixed(2).padStart(10)}  ${pct(o.armedAtDecision, o.activeDecisions).padStart(16)}  ${pct(o.passes, o.activeDecisions).padStart(16)}  ${(o.stack / g).toFixed(3).padStart(10)}`);
    }
  }
}
CFG.HOWL_NEXT = 0; CFG.WINDUP_NEXT = 1;
