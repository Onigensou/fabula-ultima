// Fabula Arcana balance report (dev tool; not loaded by Foundry). AI vs AI over random full-budget (5★) teams.
// Run: node scripts/fabula-arcana/fa-balance.mjs [casualGames=3000] [skilledGames=2000] [seed]
// Prints draws / match length / team shapes / roles / per-card win rate (draw = half) and how often each ability fired.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
for (const f of ["fa-catalog.js", "fa-engine.js"]) vm.runInThisContext(readFileSync(resolve(HERE, f), "utf8"), { filename: f });
const { Catalog: { CARDS }, Engine: E } = globalThis.FabulaArcana;
const [NC = 3000, NS = 2000, SEED] = process.argv.slice(2).map(Number);
if (SEED) { let s = SEED; E.setRng(() => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }); }

// log text that proves a repeatable / triggered ability fired; others use the once-per-match abilityUsed flag
const FIRED = { skizzik:/Static Buildup/, pyrefly:/Funeral Pyre/, kirin:/[+][0-9]+ Lightning Charge/, cryo:/Cryo Explosion/, gorger:/Aero Explosion/, inferex:/Voracious/,
  archer:/Double Strafe/, fulgimite:/Evasion/, obsidrax:/Earthen Wire/, manaray:/Mana Catcher/, hellhound:/On the Hunt/, roper:/Entangle/, wolf:/[+]1 Howl/,
  gigas:/Crushing Blow/, flame:/Dynamic Entry/, sylph:/Tailwind:/, succubus:/Charm:/, roo:/Chef.s Knife [+]/, rgolem:/Earthquake!/ };
const FULL = E.LEGAL_TEAMS.filter(t => E.teamCost(t) === 5);
const pick = () => FULL[Math.floor(Math.random() * FULL.length)];
const shape = t => t.map(id => CARDS[id].cost).sort((a, b) => b - a).join("+");

function series(prof, n) {
  const T = { W:0, L:0, D:0, rounds:[], cap:0, card:{}, role:{}, shape:{}, fired:{} };
  const add = (o, k, r) => { (o[k] ||= { g:0, w:0 }).g++; o[k].w += r; };
  for (let g = 0; g < n; g++) {
    const teams = [pick(), pick()], m = E.Match.create({ teams }); let text = "", guard = 0;
    while (m.phase !== "ended" && guard++ < 400) for (const s of [0, 1]) if (E.Match.needs(m, s)) {
      const r = E.Match.submit(m, s, E.Match.aiChoice(m, s, prof)); if (r.resolved && r.resolved.L) text += r.resolved.L.map(x => x[0]).join("\n") + "\n"; }
    const r0 = m.result === "WIN" ? 1 : m.result === "DRAW" ? 0.5 : 0;
    T[m.result[0]]++; T.rounds.push(m.round); if (m.capEnd) T.cap++;
    for (const s of [0, 1]) { const r = s === 0 ? r0 : 1 - r0;
      for (const q of m.p[s].roster) { add(T.card, q.cid, r); add(T.role, CARDS[q.cid].role, r);
        const f = T.fired[q.cid] ||= { g:0, n:0 }; f.g++; if (FIRED[q.cid] ? FIRED[q.cid].test(text) : q.abilityUsed) f.n++; }
      add(T.shape, shape(teams[s]), r); }
  }
  return T;
}
const pc = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + "%";
function report(name, T, n) {
  const r = [...T.rounds].sort((a, b) => a - b);
  console.log(`\n=== ${name} (${n} games, full 5★ teams) ===`);
  console.log(`draws ${pc(T.D, n)} · median rounds ${r[r.length >> 1]} · round cap ${pc(T.cap, n)}`);
  console.log("team shape: " + Object.entries(T.shape).map(([k, v]) => `${k} ${pc(v.w, v.g)}`).join(" · "));
  console.log("role:       " + Object.entries(T.role).sort((a, b) => b[1].w / b[1].g - a[1].w / a[1].g).map(([k, v]) => `${k} ${pc(v.w, v.g)}`).join(" · "));
  for (const [k, v] of Object.entries(T.card).sort((a, b) => b[1].w / b[1].g - a[1].w / a[1].g))
    console.log(`  ${(CARDS[k].name + " " + "★".repeat(CARDS[k].cost)).padEnd(20)} ${CARDS[k].role.padEnd(9)} ${pc(v.w, v.g).padStart(6)}   ability ${pc(T.fired[k].n, T.fired[k].g).padStart(6)}`);
}
report("Casual vs Casual", series({ diff:"casual" }, NC), NC);
report("Skilled vs Skilled", series({ diff:"skilled" }, NS), NS);
