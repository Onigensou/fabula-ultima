// Tests for the Fabula Arcana rules engine + match flow. No game required.
// Run: node scripts/fabula-arcana/fa-engine.test.mjs
// The rule checks are the approved mockup's regression suites (v0.5 Speed, v0.6 Café, Launch Roster v2.4 abilities),
// ported unchanged and run against fa-engine.js through a small compatibility shim.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
for (const f of ["fa-catalog.js", "fa-engine.js"]) vm.runInThisContext(readFileSync(resolve(HERE, f), "utf8"), { filename: f });
const { Catalog, Engine: E } = globalThis.FabulaArcana;

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
// deterministic randomness (mulberry32) so random bench hits / AI noise are reproducible
const seeded = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
E.setRng(seeded(20261114));

// compatibility shim: the mockup suites drive a single global match state
let CUR = null;
const R = {
  CARDS: Catalog.CARDS, CFG: Catalog.CFG, IDS: E.IDS, LEGAL_TEAMS: E.LEGAL_TEAMS, teamCost: E.teamCost, compKey: E.compKey,
  mkPlayer: E._mkPlayer, setS: v => { CUR = v; }, getS: () => CUR,
  resolveRound: ch => E._withState(CUR, () => E._resolveRound(ch)),
  calcAttack: (a, d, c) => E._withState(CUR, () => E._calcAttack(a, d, c)),
  aiChoose: (me, op, prof) => E._withState(CUR, () => E._aiChoose(me, op, prof)),
  aiOpening: (me, prof) => E._aiOpening(me, prof), autoPickMonster: pl => E._autoPickMonster(pl), benchOptions: pl => E._benchOptions(pl),
};
const blankStats = () => ({ acts:[{},{}], switches:[0,0], forced:[0,0], kos:[], aff:{}, zero:{bothSwitch:0,noHpLost:0,healedBack:0} });
const blank = blankStats;

// ===== v0.5 Speed / tiebreak / item timing (mockup sim6) =====
{
  function duel(a, b, opt = {}) {   // two active monsters, benches optionally dead
    const S = { round:3, p:[R.mkPlayer([a,'gorger','sylph']), R.mkPlayer([b,'carlbero','life'])], log:[], result:null, capEnd:false, stats:blankStats() };
    R.setS(S);
    for (const s of [0,1]) { const P=S.p[s]; P.active=0; P.roster[0].attacked=true;
      if (opt.hp && opt.hp[s]!=null) P.roster[0].hp=opt.hp[s];
      if (opt.lastStanding) for (const i of [1,2]) { P.roster[i].ko=true; P.roster[i].hp=0; } }
    return S;
  }
  // --- Speed order ---
  let S = duel('skizzik','carlbero',{hp:[8,2]});               // SPD 4 vs 2, Pyrefly hits 4−1=3 ≥ 2
  let r = R.resolveRound([{action:'PASS'},{action:'PASS'}]);
  ok(r.ev.seq && r.ev.seq[0]===0 && r.ev.denied===1 && S.p[0].roster[0].hp===8, 'SPD 4 lethally hits SPD 2 → slower cannot retaliate');
  S = duel('pyrefly','carlbero');
  r = R.resolveRound([{action:'PASS'},{action:'PASS'}]);
  ok(r.ev.seq && r.ev.seq.length===2 && S.p[0].roster[0].hp<8, 'SPD 4 hits SPD 2 which survives → slower retaliates');
  S = duel('fulgimite','broo');                                  // both SPD 3
  r = R.resolveRound([{action:'PASS'},{action:'PASS'}]);
  ok(!r.ev.seq && r.ev.res[0] && r.ev.res[1], 'both SPD 3 → simultaneous');
  S = duel('fulgimite','broo',{hp:[3,3],lastStanding:true});
  R.resolveRound([{action:'STRENGTH'},{action:'PASS'}]);
  ok(S.result==='DRAW' || S.stats.tiebroken || S.stats.mutualFinal, 'equal-Speed final mutual KO → v0.4 HP tiebreak path (' + S.result + ')');
  S = duel('fulgimite','broo',{hp:[4,3],lastStanding:true});
  R.resolveRound([{action:'STRENGTH'},{action:'STRENGTH'}]);
  ok(S.result==='WIN' && S.stats.tiebroken, 'equal-Speed mutual KO, 4 vs 3 HP → 4-HP side wins');
  S = duel('carlbero','pyrefly',{hp:[3,8]});                    // Carlbero slower, at 3 HP; Pyrefly hits for 4−1=3
  R.resolveRound([{action:'REMEDY'},{action:'PASS'}]);
  ok(S.p[0].roster[0].hp>0, 'Remedy vs faster opponent heals before the faster attack (survives at ' + S.p[0].roster[0].hp + ')');
  S = duel('carlbero','skizzik',{hp:[3,8]});                    // Skizzik 3 vs DEF 1 = 2; with Golem +3 DEF it floors at 1
  R.resolveRound([{action:'GOLEM'},{action:'PASS'}]);
  ok(S.p[0].roster[0].hp===2, 'Golem Fragment vs faster opponent is active before the attack (took 1, not 2)');
  S = duel('carlbero','pyrefly');
  r = R.resolveRound([{action:'SWITCH', target:1},{action:'PASS'}]);
  ok(S.p[0].active===1 && r.ev.res[1] && r.ev.res[1].d.cid==='gorger', 'voluntary Switch vs faster opponent completes before the attack');
  S = duel('skizzik','walrog',{hp:[8,3]});                        // Pyrefly 4 vs Cryo 3 HP: Frost Shell −3 → 1 dmg
  r = R.resolveRound([{action:'PASS'},{action:'PASS'}]);
  ok(S.p[1].roster[0].hp>0 && S.p[1].roster[0].abilityUsed && r.ev.seq.length===2, 'faster hit on Walrog at 3 HP: Thick Skin prevents lethal (HP '+S.p[1].roster[0].hp+'), Walrog retaliates');
  S = duel('skizzik','flame');                                  // Skizzik is Bolt; need a Fire attacker faster than Flame: Pyrefly
  R.CARDS.flame.absorb='fire'; S = duel('pyrefly','flame');   // absorb engine kept for future cards: test it on a temporary absorber
  r = R.resolveRound([{action:'PASS'},{action:'PASS'}]);
  ok(r.ev.res[0].usedAbsorb && r.ev.seq.length===2, 'faster Fire attack on an absorber: absorption first, then it retaliates'); delete R.CARDS.flame.absorb;
}

// ===== v0.6 Café au Lait (mockup sim7) =====
{
  function duel(a, b, o = {}) { const S = { round:3, p:[R.mkPlayer([a,'roo','gigas']), R.mkPlayer([b,'kirin','cryo'])], log:[], result:null, capEnd:false, stats:blank() };
    R.setS(S); for (const s of [0,1]) { const P=S.p[s]; P.active=0; P.roster[0].attacked=true; if (o.hp && o.hp[s]!=null) P.roster[0].hp=o.hp[s]; if (o.last) for (const i of [1,2]) { P.roster[i].ko=true; P.roster[i].hp=0; } } return S; }
  // --- Café au Lait speed rules (cryo SPD2, kirin SPD2, fulgimite SPD3, pyrefly SPD4, gigas SPD1) ---
  let S = duel('cryo','kirin'); let r = R.resolveRound([{action:'CAFE'},{action:'PASS'}]);
  ok(r.ev.seq && r.ev.seq[0]===0, 'SPD 2 + Café vs SPD 2 → the Café side (SPD 3) attacks first');
  S = duel('cryo','fulgimite'); r = R.resolveRound([{action:'CAFE'},{action:'PASS'}]);
  ok(!r.ev.seq, 'SPD 2 + Café vs SPD 3 → tie, simultaneous');
  S = duel('fulgimite','pyrefly'); r = R.resolveRound([{action:'CAFE'},{action:'PASS'}]);
  ok(!r.ev.seq, 'SPD 3 + Café vs SPD 4 → tie, simultaneous');
  S = duel('pyrefly','fulgimite'); r = R.resolveRound([{action:'CAFE'},{action:'PASS'}]);
  ok(r.ev.seq && r.ev.seq[0]===0 && S.p[0].items.CAFE===0 && S.stats.cafe.capped===0, 'SPD 4 + Café → SPD 5 (effects may exceed the printed max of 4), item consumed');
  S = duel('pyrefly','skizzik'); r = R.resolveRound([{action:'CAFE'},{action:'PASS'}]);
  ok(r.ev.seq && r.ev.seq[0]===0, 'SPD 4 mirror: the side with Café au Lait (SPD 5) strikes first');
  S = duel('fulgimite','pyrefly',{hp:[3,3],last:true}); R.resolveRound([{action:'CAFE'},{action:'STRENGTH'}]);
  ok(S.stats.mutualFinal && S.result==='DRAW', 'Café creates an equal-Speed final mutual KO → HP tiebreak (equal HP → draw)');
  S = duel('cryo','kirin'); R.resolveRound([{action:'CAFE'},{action:'PASS'}]); r = R.resolveRound([{action:'PASS'},{action:'PASS'}]);
  ok(!r.ev.seq, 'Café expires: next round both are back to printed SPD 2 (simultaneous)');
}

// ===== Launch Roster v2.4 abilities (mockup sim9) =====
{
  function duel(t0, t1, o = {}) { const S = { round:3, p:[R.mkPlayer(t0), R.mkPlayer(t1)], log:[], result:null, capEnd:false, stats:blank() };
    R.setS(S); for (const s of [0,1]) { const P=S.p[s]; P.active=0; P.roster[0].attacked=true; if (o.hp && o.hp[s]!=null) P.roster[0].hp=o.hp[s]; } return S; }
  const A = (a) => [a,'kirin','cryo'], B = (b) => [b,'kirin','cryo'];
  const P = {action:'PASS'};
  // ---- ability checks (v2) ----
  let S, r;
  const go = (c0, c1) => { const out = R.resolveRound([c0, c1]); R.getS().round++; return out; };
  const dmg0 = () => r.ev.res[0] && r.ev.res[0].dmg;
  // Skizzik: 3, 3, then third damaging hit +3
  S = duel(A('skizzik'), B('hellhound'), {hp:[30,30]}); const zs=[]; for (let k=0;k<4;k++){ r=go(P,P); zs.push(dmg0()); }
  ok(zs.join(',')==='3,3,6,3', 'Skizzik: Static Buildup 3,3,6 then resets (got '+zs+')');
  // Pyrefly: 2, 2, then Funeral Pyre +4
  S = duel(A('pyrefly'), B('hellhound'), {hp:[30,30]}); const ps=[]; for (let k=0;k<4;k++){ r=go(P,P); ps.push(dmg0()); }
  ok(ps.join(',')==='2,6,2,6', 'Pyrefly: hit 2 burns, next hit Funeral Pyre 2+4 clears it (got '+ps+')');
  S = duel(A('pyrefly'), ['hellhound','roper','kirin'], {hp:[30,30]}); go(P,P); S.p[1].roster[1].hp=30; r=go(P,{action:'SWITCH',target:1}); r=go(P,P);
  ok(dmg0()===5 && S.p[0].roster[0].burn[0]===1 && !S.p[0].roster[0].burn[1], 'Pyrefly: Burn is per target; a switched-in monster starts unburned, the benched one keeps its 2 Burn');
  // Fulgimite Evasion
  S = duel(A('hellhound'), ['salamander','fulgimite','kirin']); r=go(P,{action:'SWITCH',target:1});
  ok(dmg0()===2, 'Fulgimite: Evasion −2 on a voluntary switch-in (4 → 2)');
  // Kirin Lightning Charge (any attack damage)
  S = duel(['skizzik','hellhound','cryo'], B('kirin'), {hp:[30,30]}); S.p[0].roster[1].hp=30; r=go(P,P);
  ok(S.p[1].roster[0].chg && S.p[1].roster[0].chg[S.round], 'Kirin: damaged by an attack → charged for the next round');
  r=go({action:'SWITCH',target:1},P); ok(r.ev.res[1].dmg===5, 'Kirin: charged attack 2+3 = 5');
  r=go(P,P); ok(r.ev.res[1].dmg===2, 'Kirin: not hit last round → uncharged attack 2');
  S = duel(['hellhound','skizzik','cryo'], B('kirin'), {hp:[30,30]}); r=go(P,P); r=go(P,P); ok(r.ev.res[1].dmg===5, 'Kirin: a Dark hit charges it too');
  // Cryo Explosion
  S = duel(A('hellhound'), B('cryo'), {hp:[8,2]}); r=go(P,P);
  ok(S.p[1].roster[0].hp===0 && S.p[0].roster[0].hp===6 && r.ev.denied===1, 'Cryo Gorger: KO\'d by a faster hit → Cryo Explosion 2 to the attacker (8 → 6)');
  // Inferex Voracious
  S = duel(A('inferex'), ['hellhound','kirin','cryo'], {hp:[9,1]}); const before=S.p[1].roster[1].hp+S.p[1].roster[2].hp; r=go(P,P);
  ok(S.p[1].roster[0].hp===0 && S.p[1].roster[1].hp+S.p[1].roster[2].hp===before-3, 'Inferex: KO on the active + survives → Voracious 3 to a random benched enemy');
  S = duel(A('inferex'), ['hellhound','kirin','cryo'], {hp:[1,1]}); r=go(P,P);
  ok(S.p[1].roster[1].hp===10 && S.p[1].roster[2].hp===9, 'Inferex: KO\'d in the same simultaneous exchange → no Voracious');
  // Bandit Archer Double Strafe + multi-KO + Replacement
  S = duel(A('archer'), ['hellhound','kirin','cryo']); r=go(P,{action:'GOLEM'});
  ok(S.p[1].roster[1].hp+S.p[1].roster[2].hp===18, 'Archer: Double Strafe 1 to a bench monster, Golem Fragment does not stop it');
  S = duel(A('archer'), ['gigas','kirin','cryo'], {hp:[8,1]}); S.p[1].roster[1].hp=1; S.p[1].roster[2].hp=1; r=go(P,P);
  const koB=[1,2].filter(i=>S.p[1].roster[i].ko).length;
  ok(S.p[1].roster[0].ko && koB===1 && S.p[1].pending && R.benchOptions(S.p[1]).length===1, 'Archer (faster) KOs the active AND a 1-HP bench monster in one round → only the survivor can replace');
  S = duel(A('archer'), ['gigas','kirin','cryo'], {hp:[8,1]}); S.p[1].roster[1].hp=1; S.p[1].roster[2].ko=true; S.p[1].roster[2].hp=0; r=go(P,P);
  ok(S.result==='WIN' && !S.stats.mutualFinal, 'Bench KO finishing the team = normal win, no HP tiebreak');
  S = duel(A('archer'), ['hellhound','kirin','cryo']); for (const i of [1,2]){ S.p[1].roster[i].ko=true; S.p[1].roster[i].hp=0; } r=go(P,P);
  ok(!(r.ev.direct||[]).length, 'Archer: empty bench → no Double Strafe');
  // Obsidrax Earthen Wire
  S = duel(A('skizzik'), B('obsidrax')); r=go(P,P);
  ok(S.p[1].roster[0].hp===9 && S.p[1].roster[0].abilityUsed && (r.ev.direct||[]).some(d=>d.src==='Earthen Wire' && d.s===0), 'Obsidrax: first Bolt hit grounded (takes 0), damage goes to a random enemy');
  r=go(P,P); ok(S.p[1].roster[0].hp<9, 'Obsidrax: Earthen Wire is once per match');
  // Wandering Flame: Dynamic Entry
  S = duel(A('hellhound'), ['roper','flame','kirin']); r=go(P,{action:'SWITCH',target:1});
  ok(S.p[0].roster[0].hp===6 && r.ev.res[0] && r.ev.res[0].d.cid==='flame', 'Wandering Flame: voluntary switch-in deals 2 to the enemy active, which still attacks');
  S = duel(A('hellhound'), ['roper','flame','kirin'], {hp:[1,11]}); r=go(P,{action:'SWITCH',target:1});
  ok(S.p[0].roster[0].ko && !r.ev.res[0], 'Dynamic Entry KOs a 1-HP active before it can attack');
  S = duel(A('hellhound'), ['roper','flame','kirin'], {hp:[30,1]}); r=go(P,P); S.p[1].pending=true; r=go(P,{replace:1,action:'PASS'});
  ok(S.p[1].active===1 && !(r.ev.entry||[]).length, 'Dynamic Entry does not trigger on a forced replacement');
  // pool
  ok(R.IDS.length===51 && ['obsidrax','roo','walrog','gorger','sylph','succubus','hina','zarg','raubens','geist','kalina','blanche','keren','gryphon','love','jack','jill','hilde','carlbero','brucev','nullis','gardner','hako'].every(k=>R.IDS.includes(k)) && !R.IDS.some(k=>['broo','life'].includes(k)), 'pool = 51 cards (23 + 28 character cards; Bandit Roo retired)');
  // Succubus Charm
  S = duel(A('hellhound'), ['roper','succubus','kirin'], {hp:[30,30]}); S.p[1].roster[1].hp=30; r=go(P,{action:'SWITCH',target:1});
  const c1=dmg0(); r=go(P,P); const c2=dmg0(); r=go(P,P); const c3=dmg0();
  ok(c1===2 && c2===2 && c3===4, 'Succubus: Charm −2 ATK on the switch-in round and the next, then gone (got '+[c1,c2,c3]+')');
  // Sylph Tailwind (set up by attacking, 3 rounds)
  S = duel(['sylph','gorger','kirin'], B('fulgimite'), {hp:[30,30]}); S.p[0].roster[1].hp=30; r=go(P,P);
  ok(r.ev.seq && r.ev.seq[0]===1, 'Tailwind: not up before Sylph attacks (SPD 2 vs 3)');
  r=go(P,P); ok(!r.ev.seq, 'Tailwind: up after Sylph attacked (SPD 3 ties Fulgimite)');
  r=go({action:'SWITCH',target:1},P); r=go(P,P); ok(!r.ev.seq, 'Tailwind carries to the switched-in Air ally (Aero Gorger SPD 3)');
  r=go(P,P); ok(!r.ev.seq, 'Tailwind refreshed by Sylph attacking again (still up)'); r=go(P,P); ok(r.ev.seq && r.ev.seq[0]===1, 'Tailwind expires after 3 rounds');
  S = duel(['sylph','hellhound','kirin'], B('fulgimite'), {hp:[30,30]}); S.p[0].roster[1].hp=30; r=go(P,P); r=go({action:'SWITCH',target:1},P); r=go(P,P);
  ok(!r.ev.seq, 'Tailwind does not speed up non-Air allies (Hellhound 3 vs 3 stays simultaneous)');
  // Roo (per-victim mode checks)
  R.CFG.ROO_BENCH=0;
  S = duel(A('roo'), ['hellhound','kirin','cryo'], {hp:[30,30]}); const rd=[]; for (let k=0;k<3;k++){ r=go(P,P); rd.push(dmg0()); }
  ok(rd[0]===0 && rd[1]===0 && rd[2]>=9999 && S.p[1].roster[0].ko && S.p[0].roster[0].ko, "Roo: 0, 0, then the Knife (9999) on step 3; then Roo walks away (got "+rd.slice(0,2)+")");
  S = duel(A('roo'), ['hellhound','kirin','cryo'], {hp:[30,30]}); S.p[1].roster[1].hp=30; go(P,P); go(P,P); r=go(P,{action:'SWITCH',target:1});
  ok(dmg0()<9999 && S.p[0].roster[0].steps.t===1 && S.p[0].roster[0].steps.n===1 && !S.p[0].roster[0].ko, 'Roo: the victim switches out → steps reset on the new target, no knife');
  S = duel(A('roo'), ['hellhound','kirin','cryo'], {hp:[30,30]}); for (const i of [1,2]){ S.p[1].roster[i].ko=true; S.p[1].roster[i].hp=0; } go(P,P); go(P,P); r=go(P,P);
  ok(S.result==='WIN' && !S.p[0].roster[0].ko, "Roo: a knife on the opponent's last monster wins; Roo doesn't walk away into a draw");
  S = duel(A('scorpion'), B('hellhound')); r=go(P,P); const v1=dmg0(); r=go(P,P); ok(v1===5 && dmg0()===3, 'Bandit Scorpion: Venom Sting +2 once (5 then 3)');
  R.CFG.ROO_BENCH=2;
  S = duel(['hellhound','roo','kirin'], B('cryo'), {hp:[30,30]}); for (let k=0;k<3;k++) go(P,P); ok(!S.p[0].roster[1].walk, 'Roo (field mode): no steps while benched');
  S = duel(A('roo'), ['hellhound','kirin','cryo'], {hp:[30,30]}); const fr=[]; for (let k=0;k<3;k++){ r=go(P,P); fr.push(dmg0()); }
  ok(fr[0]===0 && fr[1]===0 && fr[2]>=9999 && S.p[1].roster[0].ko && S.p[0].roster[0].ko, 'Roo (field mode): 0, 0, knife on its 3rd round on the field, then walks away (got '+fr.slice(0,2)+')');
  S = duel(['roo','hellhound','kirin'], B('cryo'), {hp:[30,30]}); S.p[0].roster[1].hp=30; go(P,P); go({action:'SWITCH',target:1},P);
  ok(!S.p[0].roster[0].walk, 'Roo (field mode): switching out resets its steps');
  go({action:'SWITCH',target:0},P); r=go(P,P); ok(dmg0()<9999, 'Roo (field mode): back on the field it has to walk again (no knife yet)');
  // Rock Golem Wind Up → Earthquake
  S = duel(A('rgolem'), ['hellhound','kirin','cryo'], {hp:[30,30]}); r=go(P,P); const q1=S.p[1].roster[1].hp+S.p[1].roster[2].hp; r=go({action:'GOLEM'},P); const q2=S.p[1].roster[1].hp+S.p[1].roster[2].hp;
  ok(q1===19 && q2===17 && S.p[0].roster[0].windup===false, 'Rock Golem (WINDUP_NEXT=1): a Pass arms Wind Up for the NEXT attack (bench stays 19), the next attack is the Earthquake (17) and clears it (got '+q1+'/'+q2+')');

  S = duel(A('roo'), B('walrog'), {hp:[30,30]}); r=go({action:'STRENGTH'},P);
  ok(dmg0()===0 && !S.p[1].roster[0].abilityUsed, 'Roo: an ordinary attack deals 0 even with Strength, and does not spend Thick Skin');
  // Aero Gorger burst
  S = duel(A('hellhound'), B('gorger'), {hp:[8,2]}); r=go(P,P); ok(S.p[0].roster[0].hp===6, 'Aero Gorger: Aero Explosion 2 to the attacker');

  // ---- items 11-15: Smoke Bomb ignores DEF; Golem Fragment = DEF +3 (11-17: a real DEF, so a hit floors at 1) ----
  S = duel(A('hellhound'), B('rgolem'), {hp:[30,30]}); r=go(P,P); const sm0=dmg0(); r=go({action:'SMOKE'},P); const sm1=dmg0();
  ok(sm0===2 && sm1===4, 'Smoke Bomb: the attack ignores printed DEF (Hellhound 4 vs Rock Golem DEF 2: 2 → 4)');
  S = duel(A('hellhound'), B('wolf'), {hp:[30,30]}); r=go(P,{action:'GOLEM'}); const gg=dmg0(); r=go({action:'SMOKE'},{action:'GOLEM'}).ev; const gs=R.getS().p[1].roster[0].hp;
  ok(gg===1 && gs===30-1-4, 'Golem Fragment: DEF +3 (4 → 1); Smoke Bomb ignores it too (full 4)');
  S = duel(A('scorpion'), B('hellhound'), {hp:[30,30]}); S.p[0].roster[0].abilityUsed=true; r=go(P,{action:'GOLEM'});
  ok(dmg0()===1, 'Golem Fragment no longer blocks a hit to 0 (Scorpion 3 − 3 → 1)');
  S = duel(A('hellhound'), B('kirin'), {hp:[30,30]}); r=go(P,{action:'GOLEM'}); ok(dmg0()===1 && /Golem Fragment \+3/.test(r.ev.res[0].line), 'Golem Fragment stacks with printed DEF (Hellhound 4 − (1 + 3) → 1) and shows in the DEF note');
  // ---- batch 3 (11-15): Gryphon, Love, Jack, Jill, Princess Hilde, Carlbero ----
  S = duel(A('gryphon'), B('hellhound'), {hp:[30,30]}); r=go(P,P); const g1=r.ev.res[1].dmg; r=go(P,{action:'CAFE'}); const g2=r.ev.res[1].dmg;
  ok(g1===1 && g2===3, 'Gryphon Slipstream: +2 DEF vs a slower attacker (Hellhound 4 vs DEF 3 → 1); Café ties SPD 4 → bonus off (4 − 1 = 3) (got '+g1+'/'+g2+')');
  S = duel(A('gryphon'), B('skizzik'), {hp:[30,30]}); r=go(P,P); ok(r.ev.res[1].dmg===2, 'Gryphon Slipstream: no bonus against an equally fast attacker (Skizzik 3 − DEF 1)');
  S = duel(['love','hellhound','cryo'], B('wolf'), {hp:[30,30]}); r=go(P,P); ok(!S.p[0].roster[1].ser && !S.p[0].roster[2].ser, 'Love Serenade: attacking alone buffs nobody');
  r=go({action:'SWITCH',target:1},P); ok(S.p[0].roster[1].ser>=R.getS().round+2 && !S.p[0].roster[2].ser, 'Love Serenade: switching Love out buffs the card coming in (only it)');
  r=go(P,P); ok(dmg0()===6 && r.ev.res[1].dmg===2, 'Love Serenade: the buffed card hits +2 (Hellhound 4+2 = 6) and has +2 DEF (Wolf 3+1 Howl − 2 = 2)');
  S = duel(['hellhound','love','cryo'], B('wolf'), {hp:[30,30]}); r=go({action:'SWITCH',target:1},P); ok(!S.p[0].roster[0].ser && !S.p[0].roster[2].ser, 'Love Serenade: switching Love IN buffs nobody');
  // ---- batch 4 (11-16): Jack Thief Bow, Bruce V, Nullis, Gardner, Rival ----
  S = duel(A('jack'), B('rgolem'), {hp:[30,30]}); r=go(P,P); const tb0=dmg0(); r=go(P,{action:'CAFE'}); const tb1=dmg0();
  ok(tb0===1 && tb1===3, 'Jack Thief Bow: no longer ignores DEF (3 − 2 = 1); +2 ATK in a round the opponent uses an item (5 − 2 = 3) (got '+tb0+'/'+tb1+')');
  S = duel(A('jack'), B('manaray'), {hp:[30,30]}); r=go({action:'STRENGTH'},P); ok(dmg0()===5, 'Jack Thief Bow: his OWN item does not trigger it (3 + 2 Strength = 5)');
  S = duel(A('brucev'), B('rgolem'), {hp:[30,30]}); r=go(P,P); ok(dmg0()===4 && /Teleportation Strike/.test(r.ev.res[0].line), 'Bruce V: ignores 2 DEF (4 vs Rock Golem DEF 2 = 4)');
  S = duel(A('brucev'), B('wolf'), {hp:[30,30]}); r=go(P,{action:'GOLEM'}); ok(dmg0()===3 && /Teleportation Strike/.test(r.ev.res[0].line), "Bruce V: Golem Fragment's +3 is DEF he can pierce (4 − (3 − 2) = 3)");
  S = duel(A('brucev'), B('wolf'), {hp:[30,30]}); r=go(P,P); ok(dmg0()===4 && !/Teleportation Strike/.test(r.ev.res[0].line), 'Bruce V: no Teleportation Strike note against DEF 0 (Wolf: 4)');
  S = duel(A('nullis'), B('roper'), {hp:[30,30]}); r=go(P,P); const ng0=r.ev.res[1].dmg; r=go(P,{action:'STRENGTH'}); const ng1=r.ev.res[1].dmg, ngL=r.ev.res[1].line; r=go(P,{action:'SMOKE'}); const ng2=r.ev.res[1].dmg, ngS=r.ev.res[1].line;
  ok(ng0===2 && ng1===1 && ng2===3 && /Null Guard \+3/.test(ngL) && !/Null Guard/.test(ngS),'Nullis Null Guard: 3 − 1 = 2; vs an item +3 DEF (5 − 4 = 1); Smoke Bomb ignores it (3) (got '+[ng0,ng1,ng2]+')');
  S = duel(A('gardner'), B('roper'), {hp:[30,30]}); r=go(P,P); const ha0=r.ev.res[1].dmg; const haL=r.ev.res[1].line; r=go(P,{action:'STRENGTH'}); const ha1=r.ev.res[1].dmg;
  ok(ha0===1 && /Heavy Armor \+2/.test(haL) && ha1===3, 'Gardner Heavy Armor: +2 DEF when the opponent Passes (3 − 4 → 1); not on an item round (5 − 2 = 3) (got '+ha0+'/'+ha1+')');
  S = duel(A('gardner'), B('brucev'), {hp:[30,30]}); r=go(P,P); ok(r.ev.res[1].dmg===2, 'Bruce V vs Heavy Armor: ignores 2 of the 4 DEF (4 − 2 = 2)');
  S = duel(['gardner','nullis','cryo'], B('roper'), {hp:[30,30]}); S.p[0].roster[1].ko=true; S.p[0].roster[1].hp=0; r=go(P,{action:'STRENGTH'});
  ok(r.ev.res[1].dmg===2 && /Rival \+1/.test(r.ev.res[1].line), 'Rival: Gardner +1 DEF once Nullis has fallen (5 − 3 = 2)');
  S = duel(['nullis','gardner','cryo'], B('roper'), {hp:[30,30]}); r=go(P,{action:'STRENGTH'}); ok(r.ev.res[1].dmg===1 && !/Rival/.test(r.ev.res[1].line), 'Rival: no bonus while Gardner is alive');
  S = duel(['jack','jill','cryo'], B('wolf'), {hp:[30,30]}); S.p[0].roster[1].ko=true; S.p[0].roster[1].hp=0; r=go(P,P); ok(dmg0()===6, 'Twin: Jack +1 ATK once Jill has fallen (3+1, Poison vs Physical +2 = 6)');
  S = duel(A('jill'), B('kirin'), {hp:[6,30]}); r=go(P,P); ok(dmg0()===5 && r.ev.res[1].dmg===3, 'Jill Berserk at half HP: +3 ATK (6 − Kirin DEF 1 = 5) and takes +1 (Kirin 2 → 3)');
  // Royal Grace (GRACE_MODE 4, 11-15): Pass → Regen field; from next round, for 4 rounds, the active card heals 3 at end of round (not Hilde)
  // (a Pass still attacks, so these read the heal events; the bench card's HP shows the field never touches the bench)
  const rgHeal = () => r.ev.grace && r.ev.grace.length===1 && r.ev.grace[0].regen && r.ev.grace[0].end ? r.ev.grace[0].heals[0] : null;
  S = duel(['hilde','kirin','cryo'], B('wolf'), {hp:[14,30]}); S.p[0].roster[1].hp=6; S.p[0].roster[2].hp=5; r=go(P,P); const rg0=r.ev.regen && r.ev.regen.length===1;
  ok(rg0 && !r.ev.grace && S.p[0].rgFrom===R.getS().round, 'Royal Grace: Hilde Passes → Regen raised, no heal on the Pass round (starts next round)');
  r=go({action:'SWITCH',target:1},P); let hh=rgHeal(); ok(hh && hh.i===1 && hh.amt===3 && S.p[0].roster[1].hp===6-r.ev.res[1].dmg+3, 'Royal Grace: the card switched in heals 3 at the end of its switch round');
  let ticks=1; for (let k=0;k<3;k++){ S.p[0].roster[1].hp=6; r=go({action:'GOLEM'},P); hh=rgHeal(); if (hh && hh.i===1 && hh.amt===3) ticks++; }
  ok(ticks===4 && S.p[0].roster[2].hp===5, 'Royal Grace: 4 ticks in all, active card only (bench untouched) (got '+ticks+')');
  S.p[0].roster[1].hp=6; r=go({action:'GOLEM'},P); ok(!r.ev.grace, 'Royal Grace: Regen ends after 4 rounds');
  S = duel(['hilde','kirin','cryo'], B('wolf'), {hp:[8,30]}); r=go(P,P); r=go(P,P);
  ok(!r.ev.grace && S.p[0].rgUntil===R.getS().round-1+4, 'Royal Grace: Hilde never heals herself; Passing again restarts the 4 rounds');
  S = duel(['hilde','kirin','cryo'], B('wolf'), {hp:[14,30]}); S.p[0].roster[1].hp=6; r=go(P,P); S.p[0].roster[0].hp=0; S.p[0].roster[0].ko=true; S.p[0].active=1; r=go({action:'GOLEM'},P); hh=rgHeal();
  ok(hh && hh.i===1 && hh.amt===3, 'Royal Grace: Regen keeps running after Hilde has fallen');
  S = duel(['kirin','hilde','cryo'], B('wolf'), {hp:[5,30]}); r=go(P,P); ok(!r.ev.grace && !r.ev.regen, 'Royal Grace: nothing without a Hilde Pass');
  S = duel(A('carlbero'), B('wolf'), {hp:[30,30]}); r=go(P,{action:'STRENGTH'}); const brd=R.getS().round;
  ok(S.p[1].roster[0].breath===brd+1, 'Stinking Breath: a damaging hit applies the breath for 3 rounds');
  r=go(P,P); ok(r.ev.res[1].dmg===4, 'Stinking Breath: Wolf −1 ATK (3 +1 Howl −1 = 3 − DEF 1 = 2, +2 Weak = 4; 5 without the breath)');
  S = duel(A('hellhound'), B('kirin'), {hp:[30,30]}); S.p[1].roster[0].breath=R.getS().round+1; r=go(P,P); ok(dmg0()===4, 'Stinking Breath: −1 DEF on the target (Hellhound 4 vs Kirin DEF 1−1 = 4)');
  // ---- Blanche + Keren (11-15) ----
  S = duel(['blanche','kirin','cryo'], B('wolf'), {hp:[30,30]}); S.p[0].roster[1].hp=4; S.p[0].roster[2].hp=6; r=go(P,P);
  ok(S.p[0].roster[1].hp===6 && S.p[0].roster[2].hp===6 && r.ev.tips && r.ev.tips[0].i===1, 'Blanche: a Pass heals the lowest-HP benched ally by 2 (4 → 6), the other untouched');
  S = duel(['blanche','kirin','cryo'], B('wolf'), {hp:[30,30]}); r=go({action:'GOLEM'},P); ok(!r.ev.tips, 'Blanche: no heal without a Pass');
  S = duel(['blanche','kirin','cryo'], B('wolf'), {hp:[5,30]}); r=go(P,P); ok(!r.ev.tips && S.p[0].roster[0].hp<5, 'Blanche: never heals herself, and nothing to heal on a full bench');
  S = duel(['hellhound','keren','cryo'], B('wolf'), {hp:[30,30]}); S.p[0].roster[1].hp=12;
  ok(E.foxFire(S, S.p[0].roster[1])===0, 'Keren: Fox Fire starts at +0');
  S.p[0].roster[2].ko=true; S.p[0].roster[2].hp=0; S.p[1].roster[1].ko=true; S.p[1].roster[1].hp=0;
  ok(E.foxFire(S, S.p[0].roster[1])===4, "Keren: +2 per KO on either side, counted from the bench (ally + enemy = +4)");
  S.p[0].active=1; r=go(P,P); ok(dmg0()===5, 'Keren: 1 base + 4 Fox Fire = 5 vs Wolf');
  S.p[1].roster[2].ko=true; S.p[0].roster[0].ko=true; S.p[1].roster[0].ko=true;
  ok(E.foxFire(S, S.p[0].roster[1])===6, 'Keren: Fox Fire caps at +6');
  // ---- character cards (playtest v1) ----
  ok(['hina','zarg','raubens','geist','kalina'].every(k=>R.CARDS[k].cost===3 && R.CARDS[k].character), 'character cards are ★★★ and flagged character');
  // Zarg Barrage: 2 to the benched enemy with the lowest HP
  S = duel(A('zarg'), B('hellhound'), {hp:[30,30]}); S.p[1].roster[1].hp=5; S.p[1].roster[2].hp=9; r=go(P,P);
  ok(S.p[1].roster[1].hp===3 && S.p[1].roster[2].hp===9, 'Zarg: Barrage hits the lowest-HP benched enemy for 2 (5 → 3, the other untouched)');
  S = duel(A('zarg'), B('hellhound'), {hp:[30,30]}); S.p[1].roster[1].hp=1; r=go(P,P);
  ok(S.p[1].roster[1].ko, 'Zarg: Barrage can KO on the bench');
  // Raubens Bandit King: +1 per enemy item while he is active, same round, permanent
  S = duel(A('raubens'), B('wolf'), {hp:[30,30]}); r=go(P,{action:'REMEDY'}); const rb1=dmg0(); r=go(P,P); const rb2=dmg0();
  ok(rb1===4 && rb2===4 && S.p[0].roster[0].loot===1, 'Raubens: an enemy item while he is active = +1 ATK at once and for the rest of the match (4, 4)');
  S = duel(['hellhound','raubens','cryo'], B('wolf'), {hp:[30,30]}); r=go(P,{action:'GOLEM'});
  ok(!S.p[0].roster[1].loot, 'Raubens: items used while he is benched do not count');
  // Geist The Blackest Night: first 0 HP → full HP (overflow lost), second → KO; also on the bench
  S = duel(['geist','kirin','cryo'], B('hellhound'), {hp:[2,30]}); r=go(P,P);
  ok(S.p[0].roster[0].hp===5 && S.p[0].roster[0].bn && !S.p[0].roster[0].ko, 'Geist: first lethal hit → rises at full HP 5, not KO');
  S.p[0].roster[0].hp=1; r=go(P,P); ok(S.p[0].roster[0].ko, 'Geist: second lethal hit → falls for real');
  S = duel(A('zarg'), ['hellhound','geist','cryo'], {hp:[30,30]}); S.p[1].roster[1].hp=1; r=go(P,P);
  ok(S.p[1].roster[1].hp===5 && !S.p[1].roster[1].ko, 'Geist: Blackest Night also saves him on the bench (Barrage)');
  // Geist (11-17): +1 ATK for the rest of the match once he has risen
  S = duel(['geist','kirin','cryo'], B('wolf'), {hp:[30,30]}); r=go(P,P); const gb0=dmg0(); S.p[0].roster[0].bn=true; r=go(P,P);
  ok(gb0===3 && dmg0()===4 && /\+1 Blackest Night/.test(r.ev.res[0].line), 'Geist: +1 ATK after The Blackest Night (3 → 4 vs Wolf) (got '+gb0+'/'+dmg0()+')');
  // Kalina Skyfall Dive (11-17): after her attack she always hops out (commit `hop` = who steps in); Dive Ready → 2 on her next switch-in
  S = duel(['kalina','hellhound','cryo'], B('wolf'), {hp:[30,30]}); r=go({action:'PASS', hop:2},P);   // Kalina SPD 3 > Wolf 2: she strikes first
  ok(dmg0()===2 && S.p[0].active===2 && S.p[0].roster[0].dive && r.ev.hop && r.ev.hop[0].to===2 && r.ev.hop[0].at===1 && r.ev.res[1].d.cid==='cryo',
    'Kalina: hits first (2), hops out to the named card, which takes the Wolf\'s attack; Dive Ready');
  r=go({action:'SWITCH',target:0},P); const dv=(r.ev.dive||[])[0];
  ok(dv && dv.amt===2 && dv.how==='switch' && !S.p[0].roster[0].dive && S.p[1].roster[0].hp===30-2-2-(r.ev.res[0]?r.ev.res[0].dmg:0), 'Kalina: switched back in → Skyfall Dive 2 (ignores DEF), Dive Ready spent');
  r=go(P,P); ok(S.p[0].active!==0 && r.ev.hop && !r.ev.dive, 'Kalina: attacks again and hops out again (no dive while in front)');
  S = duel(['kalina','hellhound','cryo'], B('skizzik'), {hp:[30,30]}); r=go(P,P);   // Skizzik SPD 4 > Kalina 3
  ok(r.ev.res[1].d.cid==='kalina' && r.ev.hop && r.ev.hop[0].at===2 && S.p[0].active!==0, 'Kalina: when slower she takes the hit first, attacks, then hops');
  S = duel(['kalina','hellhound','cryo'], B('wolf'), {hp:[30,30]}); for (const i of [1,2]){ S.p[0].roster[i].ko=true; S.p[0].roster[i].hp=0; } r=go(P,P);
  ok(S.p[0].active===0 && !r.ev.hop && !S.p[0].roster[0].dive, 'Kalina: last card standing → no hop, no Dive Ready');
  S = duel(['kalina','hellhound','cryo'], B('wolf'), {hp:[30,30]}); r=go({action:'SWITCH',target:1},P); ok(!r.ev.hop && !r.ev.dive && !S.p[0].roster[0].dive, 'Kalina: a plain switch out (no attack) gives no Dive Ready');
  S = duel(['kalina','hellhound','cryo'], B('rgolem'), {hp:[30,30]}); r=go({action:'PASS', hop:1},{action:'PASS'});
  ok(S.p[0].active===1, 'Kalina: a hop target that is fine is used (Hellhound)');
  S = duel(['kalina','hellhound','cryo'], B('wolf'), {hp:[30,30]}); S.p[0].roster[1].ko=true; S.p[0].roster[1].hp=0; r=go({action:'PASS', hop:1},P);
  ok(S.p[0].active===2, 'Kalina: a stale hop target (KO\'d) falls back to a living ally');
}

// ===== Kalina forced Dive, hop validation, Hako Trusty Supplier (match flow, 11-17) =====
{
  const M = E.Match, P = {action:'PASS'};
  const m = M.create({ teams:[["kalina","wolf","pyrefly"], ["kirin","roper","pyrefly"]] });
  M.submit(m,0,{replace:0}); M.submit(m,1,{replace:0});
  ok(M.validate(m,0,{action:'PASS', hop:0}) && M.validate(m,0,{action:'PASS', hop:7}) && !M.validate(m,0,{action:'PASS', hop:1}), 'hop target must be a living benched card');
  M.submit(m,0,{action:'STRENGTH', hop:1}); ok(m.commit[0].hop===1, 'the commit keeps the hop target');
  // forced replacement with Dive Ready: Kalina lands on the enemy card
  const m2 = M.create({ teams:[["wolf","kalina","pyrefly"], ["kirin","roper","pyrefly"]] });
  M.submit(m2,0,{replace:0}); M.submit(m2,1,{replace:0});
  m2.p[0].roster[1].dive=true; m2.p[0].roster[0].hp=0; m2.p[0].roster[0].ko=true; m2.p[0].pending=true; m2.phase='replace';
  const kh=m2.p[1].roster[0].hp; let res=M.submit(m2,0,{replace:1}).resolved;
  ok(res && res.ev && res.ev.dive && res.ev.dive[0].how==='replace' && m2.p[1].roster[0].hp===kh-2 && !m2.p[0].roster[1].dive && m2.phase==='choose', 'Kalina sent in after a KO with Dive Ready: 2 damage to the enemy card');
  const m3 = M.create({ teams:[["wolf","kalina","pyrefly"], ["kirin","roper","pyrefly"]] });
  M.submit(m3,0,{replace:0}); M.submit(m3,1,{replace:0});
  m3.p[0].roster[1].dive=true; m3.p[0].roster[0].hp=0; m3.p[0].roster[0].ko=true; m3.p[0].pending=true; m3.phase='replace'; m3.p[1].roster[0].hp=2;
  res=M.submit(m3,0,{replace:1}).resolved;
  ok(m3.p[1].roster[0].ko && m3.p[1].pending && m3.phase==='replace' && M.needs(m3,1) && !M.needs(m3,0) && res.ev.dive[0].ko, 'Skyfall Dive can KO on a replacement → the enemy replaces next');
  const v1 = E.View.resolvedForSeat(res, 1); ok(v1.ev.dive[0].s===1 && v1.ev.dive[0].t===0, 'Dive events mirror for seat 1');
  // Hako: restock 1 random used item at the start of a round while she is active and 3+ items are used up
  const h = M.create({ teams:[["hako","wolf","pyrefly"], ["kirin","roper","pyrefly"]] });
  M.submit(h,0,{replace:0}); M.submit(h,1,{replace:0});
  h.p[0].items.STRENGTH=0; h.p[0].items.GOLEM=0;
  res=(M.submit(h,0,P), M.submit(h,1,P)).resolved;
  ok(!res.ev.supply && Object.values(h.p[0].items).filter(Boolean).length===4, 'Hako: only 2 items used up → no restock');
  h.p[0].items.REMEDY=0;
  res=(M.submit(h,0,P), M.submit(h,1,P)).resolved;
  ok(res.ev.supply && res.ev.supply.length===1 && res.ev.supply[0].s===0 && ['STRENGTH','GOLEM','REMEDY'].includes(res.ev.supply[0].k) && Object.values(h.p[0].items).filter(Boolean).length===4,
    'Hako: 3 items used up → one of them (random) comes back as the next round begins');
  ok(E.View.resolvedForSeat(res, 1).ev.supply[0].s===1, 'Hako restock event mirrors for seat 1');
  const h2 = M.create({ teams:[["wolf","hako","pyrefly"], ["kirin","roper","pyrefly"]] });
  M.submit(h2,0,{replace:0}); M.submit(h2,1,{replace:0}); for (const k of ['STRENGTH','GOLEM','REMEDY','SMOKE']) h2.p[0].items[k]=0;
  res=(M.submit(h2,0,P), M.submit(h2,1,P)).resolved; ok(!res.ev.supply, 'Hako: nothing while she waits on the bench');
}

// ===== Hina Foretell (match flow) =====
{
  const M = E.Match;
  const m = M.create({ teams:[["hina","pyrefly","wolf"], ["kirin","roper","pyrefly"]] });
  M.submit(m,0,{replace:0}); M.submit(m,1,{replace:0});
  ok(m.phase==='choose' && E.foretellSeat(m)===0 && M.needs(m,0) && M.needs(m,1), 'Foretell window: both sides choose at the same time (no forced wait)');
  ok(M.publicView(m,0).commit[1]===null, 'Foretell window: nothing to see before the opponent places a card');
  M.submit(m,1,{action:'STRENGTH'});
  ok(M.needs(m,0) && M.publicView(m,0).commit[1].action==='STRENGTH', "Foretell: after the opponent commits, Hina's side sees the card");
  ok(M.publicView(m,1).commit[0]===null && M.publicView(m,null).commit[1].hidden, 'Foretell: spectators still see it hidden');
  const c = M.aiChoice(m,0,{diff:'skilled'}); ok(!M.validate(m,0,c), 'Foretell: AI holding Hina answers with a legal move ('+c.action+')');
  const m3 = M.create({ teams:[["hina","pyrefly","wolf"], ["kirin","roper","pyrefly"]] }); M.submit(m3,0,{replace:0}); M.submit(m3,1,{replace:0});
  ok(M.submit(m3,0,{action:'PASS'}).ok && M.needs(m3,1) && M.publicView(m3,1).commit[0].hidden, 'Foretell window: Hina may play first without looking (her card stays hidden)');
  const m2 = M.create({ teams:[["hina","pyrefly","wolf"], ["hina","pyrefly","wolf"]] }); M.submit(m2,0,{replace:0}); M.submit(m2,1,{replace:0});
  ok(E.foretellSeat(m2)===null && M.needs(m2,0) && M.needs(m2,1), 'Foretell: both sides Foretelling = a normal simultaneous round');
}

// ===== Match flow (pure state machine) =====
{
  const M = E.Match;
  const m = M.create({ teams:[["kirin","roper","pyrefly"], ["hellhound","cryo","gigas"]], names:["Keren","Camp NPC"] });
  ok(m.phase==="opening" && M.needs(m,0) && M.needs(m,1), "new match opens with both seats choosing an opener");
  ok(!!M.validate(m,0,{replace:7}) && !M.validate(m,0,{replace:1}), "opening: only your own monsters can open");
  ok(M.submit(m,0,{replace:1}).ok && !M.needs(m,0) && m.phase==="opening", "first opener is held face down until the other seat commits");
  const v = M.publicView(m, 1);
  ok(v.commit[0] && v.commit[0].hidden && !("replace" in v.commit[0]), "public view hides the other seat's face-down pick");
  ok(M.publicView(m, null).commit[0].hidden && M.publicView(m, 0).commit[0].replace===1, "spectators see it hidden; the owner sees their own");
  const r1 = M.submit(m,1,{replace:2});
  ok(r1.resolved && r1.resolved.kind==="opening" && m.phase==="choose" && m.round===1 && m.p[0].active===1 && m.p[1].active===2, "both openers → reveal → round 1");
  ok(/Keren opens with Roper/.test(m.log[0].lines[0][0]), "logs use the seat names");
  ok(!!M.validate(m,0,{action:"SWITCH",target:1}) && !M.validate(m,0,{action:"SWITCH",target:0}), "switch must target a benched monster");
  M.submit(m,0,{action:"STRENGTH"}); const r2 = M.submit(m,1,{action:"PASS"});
  ok(r2.resolved && r2.resolved.kind==="round" && m.round===2 && m.p[0].items.STRENGTH===0, "a round resolves when both commit; the item is spent");
  ok(!!M.validate(m,0,{action:"STRENGTH"}), "a spent item can't be played again");
  ok(M.autoChoice(m,0).action==="PASS", "timeout in a round = auto-Pass");
  // force a KO → Replacement phase only for the side that lost a monster
  m.p[1].roster[m.p[1].active].hp = 1;
  M.submit(m,0,{action:"PASS"}); M.submit(m,1,{action:"PASS"});
  ok(m.phase==="replace" && m.p[1].pending && M.needs(m,1) && !M.needs(m,0), "KO → separate Replacement phase; only the fallen side chooses");
  const auto = M.autoChoice(m,1); ok(auto.replace!=null && !m.p[1].roster[auto.replace].ko, "replacement timeout auto-picks a living monster (highest HP)");
  const rr = M.submit(m,1,auto); const roundAfter = m.round;
  ok(rr.resolved && rr.resolved.kind==="replace" && m.phase==="choose" && m.p[1].active===auto.replace && !m.p[1].pending, "replacement resolves and play continues");
  // play out with the AI; must end
  let guard = 0; while (m.phase!=="ended" && guard++ < 200) for (const s of [0,1]) if (M.needs(m,s)) M.submit(m,s,M.aiChoice(m,s,{diff:"skilled"}));
  ok(m.phase==="ended" && ["WIN","LOSS","DRAW"].includes(m.result) && roundAfter>=2, "an AI-vs-AI match always ends (" + m.result + " in round " + m.round + ")");
  ok(!M.submit(m,0,{action:"PASS"}).ok, "no choices after the match ends");
  ok(JSON.parse(JSON.stringify(m)).phase==="ended", "match state is plain JSON (safe to send over the socket / save)");
  // same seed → same match (the GM host and a replay agree)
  const play = seed => { E.setRng(seeded(seed)); const x = M.create({ teams:[["skizzik","fulgimite","wolf"],["archer","inferex","salamander"]] }); let g=0;
    while (x.phase!=="ended" && g++<200) for (const s of [0,1]) if (M.needs(x,s)) M.submit(x,s,M.aiChoice(x,s,{diff:"casual"})); return x.result + "@" + x.round + ":" + x.p.map(p=>p.roster.map(q=>q.hp).join(",")).join("|"); };
  ok(play(7)===play(7), "deterministic with a seeded RNG");
  ok(!E.isLegalTeam(["gigas","flame","kirin"]) && E.isLegalTeam(["gigas","kirin"].concat(["pyrefly"])) === false, "team budget enforced (5★ max, exactly 3)");
  ok(E.isLegalTeam(["gigas","pyrefly","wolf"]) && !E.isLegalTeam(["broo","pyrefly","wolf"]), "legal 3+1+1 team; retired cards rejected");
  // series
  const sr = E.Series.create(3); E.Series.record(sr,"LOSS"); E.Series.record(sr,"DRAW"); ok(!sr.over && sr.game===2 && sr.wins[1]===1, "Best of 3: a draw doesn't count");
  E.Series.record(sr,"WIN"); E.Series.record(sr,"WIN"); ok(sr.over && sr.winner===0 && sr.wins.join("-")==="2-1", "Best of 3: first to 2 wins the series");
}

// ===== Seat views (seat 1 sees the board mirrored) + surrender =====
{
  const M = E.Match, V = E.View;
  const m = M.create({ teams:[["kirin","roper","pyrefly"], ["hellhound","cryo","gigas"]], names:["Keren","Zarg"] });
  M.submit(m,0,{replace:0}); M.submit(m,1,{replace:0});
  M.submit(m,0,{action:"STRENGTH"});
  const v1 = V.forSeat(m, 1);
  ok(v1.p[0].roster[0].cid==="hellhound" && v1.p[1].roster[0].cid==="kirin" && v1.names[0]==="Zarg", "seat 1's view puts its own team at seat 0");
  ok(v1.commit[1] && v1.commit[1].hidden && !v1.commit[0], "seat 1 sees the opponent's face-down card as hidden, mirrored to the top");
  const r = M.submit(m,1,{action:"PASS"}).resolved; const r1 = V.resolvedForSeat(r, 1);
  ok(r1.choices[0].action==="PASS" && r1.choices[1].action==="STRENGTH", "resolved choices mirror for seat 1");
  ok(r1.ev.res[0] && r1.ev.res[0].side===0 && r1.ev.res[0].a.cid==="hellhound", "attack results mirror and their side flips");
  ok(!r.ev.seq || JSON.stringify(r1.ev.seq)===JSON.stringify(r.ev.seq.map(s=>1-s)), "strike order mirrors");
  ok(V.forSeat(m, 0).p[0].roster[0].cid==="kirin" && V.forSeat(m, null).p[0].roster[0].cid==="kirin", "seat 0 and spectators keep the host's orientation");
  ok(M.concede(m, 1) && m.result==="WIN" && m.phase==="ended" && V.forSeat(m,1).result==="LOSS" && V.forSeat(m,1).surrendered===0, "surrender ends the game; the mirrored view shows the conceder's LOSS");
  const sr = E.Series.create(3); E.Series.record(sr,"WIN"); ok(V.seriesForSeat(sr,1).wins.join("-")==="0-1", "series score mirrors for seat 1");
}

// ---- match rules (format): Standard / Open / Constellation, mirror cards, character cards ----
{
  const F = E.Format, L = E.isLegalTeam;
  ok(L(["wolf","pyrefly","kirin"]) && !L(["gigas","flame","walrog"]), "no format = Standard (5★ budget), as before");
  ok(L(["gigas","flame","walrog"], { mode:"open" }) && !L(["gigas","gigas","flame"], { mode:"open" }), "Open: three bosses legal, duplicates still not");
  const van = { mode:"cup", pat:[1,1,2] };
  ok(L(["wolf","pyrefly","kirin"], van) && L(["kirin","wolf","pyrefly"], van), "Constellation ★·★·★★ fits in any order");
  ok(!L(["wolf","pyrefly","skizzik"], van) && !L(["wolf","kirin","fulgimite"], van), "Constellation rejects the wrong star mix");
  ok(L(["wolf","kirin","gigas"], { mode:"cup", pat:[1,2,0] }) && !L(["gigas","flame","kirin"], { mode:"cup", pat:[1,2,0] }), "an Any slot takes any star count, the fixed slots still bind");
  ok(!F.allowed("gigas", van) && F.allowed("wolf", van), "a card whose stars are in no slot is not allowed");
  ok(!L(["hina","wolf","pyrefly"], { mode:"open", chars:false }) && L(["hina","wolf","pyrefly"], { mode:"open" }), "character cards can be banned");
  ok(JSON.stringify(F.norm(null)) === JSON.stringify({ mode:"standard", pat:[1,1,2], mirror:true, chars:true }), "norm(null) = Standard");
  ok(F.norm({ mode:"bogus", pat:[9,"2"], mirror:0 }).mode === "standard" && F.norm({ mode:"cup", pat:[9,"2",1] }).pat.join() === "0,2,1", "norm cleans junk");
  ok(F.legalTeams(["wolf","pyrefly"], {}).length === 0 && F.why(["wolf","pyrefly","kirin"], {}) === "", "legalTeams / why on owned cards");
  ok(/^needs 3 × ★★$/.test(F.why(["wolf","pyrefly","kirin","fulgimite"], { mode:"cup", pat:[2,2,2] })) && F.why(["wolf","kirin","fulgimite","roper"], { mode:"cup", pat:[2,2,2] }) === "", "why explains a missing star mix");
  ok(F.summary({ mode:"cup", pat:[1,1,1], mirror:false, chars:false }) === "Commoner's Cup (★ · ★ · ★) · No mirror cards · No character cards", "summary names the cup and extras");
  let threw = false; try { E.Match.create({ teams:[["wolf","pyrefly","kirin"],["wolf","skizzik","fulgimite"]], format:{ mirror:false } }); } catch (e) { threw = true; }
  ok(threw, "mirror cards off: Match.create refuses two teams sharing a card");
  const m = E.Match.create({ teams:[["gigas","flame","walrog"],["hina","zarg","keren"]], format:{ mode:"open" } });
  ok(m.format.mode === "open" && m.phase === "opening", "a match keeps its rules");
  threw = false; try { E.Match.create({ teams:[["gigas","flame","walrog"],["wolf","pyrefly","kirin"]] }); } catch (e) { threw = true; }
  ok(threw, "three bosses still illegal without a format");
}

// ===== hand model v2 + Hand API (2026-11-25): counts, created cards, cap, effects, AI, Hako, views =====
{
  const M = E.Match, H = E.Hand, I = Catalog.ITEMS;
  const P = { action:"PASS" };
  const fresh = (teams = [["wolf","pyrefly","skizzik"], ["kirin","roper","pyrefly"]]) => {
    const m = M.create({ teams }); M.submit(m, 0, { replace:0 }); M.submit(m, 1, { replace:0 }); return m; };
  const m = fresh();
  ok(H.size(m, 0) === 6 && H.list(m, 0).every((x) => x.n === 1 && !x.created), "hand v2: six base items at 1, nothing created");
  ok(Object.keys(I).filter((k) => !I[k].created).join() === "STRENGTH,GOLEM,REMEDY,SMOKE,SHARD,CAFE", "base items unchanged and listed first");
  let r = H.add(m, 0, "GRAPE", { source:"Rume" });
  ok(r.ok && r.n === 1 && H.count(m, 0, "GRAPE") === 1 && H.size(m, 0) === 7, "Hand.add: Grape Juice arrives");
  ok(m.log[0].head === "CARD CREATED" && /Rume creates Grape Juice/.test(m.log[0].lines[0][0]), "Hand.add writes a CARD CREATED log line");
  r = H.add(m, 0, "STRENGTH", { n:3 });
  ok(r.n === 1 && r.fizzled === 2 && H.count(m, 0, "STRENGTH") === 2 && H.size(m, 0) === 8, "cap 8: one more Strength fits, two fizzle");
  ok(/Hand full/.test(m.log[0].lines.map((l) => l[0]).join(" ")), "a fizzle is logged");
  ok(!H.add(m, 0, "NOPE").ok && !H.add(m, 2, "GRAPE").ok, "unknown card / seat refused");
  ok(M.validate(m, 1, { action:"GRAPE" }) === "card not in hand" && M.validate(m, 0, { action:"GRAPE" }) === null, "validate: only the holder may play it");
  // two Strengths: both can be used, one per round
  M.submit(m, 0, { action:"STRENGTH" }); M.submit(m, 1, P);
  ok(H.count(m, 0, "STRENGTH") === 1 && M.validate(m, 0, { action:"STRENGTH" }) === null, "a duplicate stays playable after the first is used");
  // Grape Juice: +1 ATK and +1 SPD this round, then gone from the hand
  const g = fresh([["wolf","pyrefly","skizzik"], ["kirin","roper","pyrefly"]]);   // Wolf SPD 2 vs Kirin SPD 2
  H.add(g, 0, "GRAPE");
  const hp0 = g.p[1].roster[0].hp;
  const res = (M.submit(g, 0, { action:"GRAPE" }), M.submit(g, 1, P)).resolved;
  ok(res.ev.seq && res.ev.seq[0] === 0, "Grape Juice +1 SPD: Wolf strikes first");
  ok(hp0 - g.p[1].roster[0].hp === E._withState(g, () => E._calcAttack(g.p[0].roster[0], g.p[1].roster[0], { attItem:"PASS", defItem:"PASS" })).dmg + 1, "Grape Juice +1 ATK on that attack");
  ok(!("GRAPE" in g.p[0].items), "a used created card leaves the hand");
  // Lucky Trinket +1 DEF, Moon +2 DEF, Smoke Bomb ignores both
  const d = fresh();
  const base = E._withState(d, () => E._calcAttack(d.p[1].roster[0], d.p[0].roster[0], { attItem:"PASS", defItem:"PASS" })).dmg;
  const moon = E._withState(d, () => E._calcAttack(d.p[1].roster[0], d.p[0].roster[0], { attItem:"PASS", defItem:"ARC_MOON" })).dmg;
  const smoke = E._withState(d, () => E._calcAttack(d.p[1].roster[0], d.p[0].roster[0], { attItem:"SMOKE", defItem:"ARC_MOON" })).dmg;
  ok(moon === Math.max(1, base - 2) && smoke === base, "The Moon +2 DEF this round; Smoke Bomb ignores it");
  // Hearty Stew heals 4 before attacks
  const st = fresh(); st.p[0].roster[0].hp = 3; H.add(st, 0, "STEW");
  const rs = (M.submit(st, 0, { action:"STEW" }), M.submit(st, 1, P)).resolved;
  ok(rs.ev.heal[0] === 4, "Hearty Stew heals 4 before attacks");
  // Apple Bomb: 2 Fire damage before attacks, element chart applies, ignores DEF
  const ab = fresh([["wolf","pyrefly","skizzik"], ["gorger","roper","pyrefly"]]);   // Aero Gorger is Air: Weak to Fire (+2)
  H.add(ab, 0, "APPLE_BOMB"); const gh = ab.p[1].roster[0].hp;
  const ra = (M.submit(ab, 0, { action:"APPLE_BOMB" }), M.submit(ab, 1, P)).resolved;
  const bomb = (ra.ev.direct || []).find((x) => x.src === "Apple Bomb");
  ok(bomb && bomb.amt === 3 && bomb.s === 1, "Apple Bomb: 1 Fire + Weak 2 = 3 to the Air card, before attacks");
  ok(gh - ab.p[1].roster[0].hp >= 3, "the bomb's damage lands on the enemy active card");
  // round abilities can create cards too: ev.added mirrors for seat 1
  const mirrored = E.View.resolvedForSeat({ kind:"round", ev:{ added:[{ s:0, k:"GRAPE", n:1 }] } }, 1);
  ok(mirrored.ev.added[0].s === 1, "ev.added mirrors for seat 1");
  // Hako restocks base items only, never a created card; counts only base items
  const h = M.create({ teams:[["hako","wolf","pyrefly"], ["kirin","roper","pyrefly"]] }); M.submit(h, 0, { replace:0 }); M.submit(h, 1, { replace:0 });
  h.p[1].roster[0].hp = 99;   // Kirin stays up: no replacement step in between
  for (const k of ["STRENGTH","GOLEM"]) { M.submit(h, 0, { action:k }); M.submit(h, 1, P); }
  H.add(h, 0, "LUCKY"); M.submit(h, 0, { action:"LUCKY" }); M.submit(h, 1, P);
  ok(!H.restore(h, 0, "LUCKY") && H.count(h, 0, "LUCKY") === 0, "Hand.restore never brings back a created card");
  M.submit(h, 0, { action:"REMEDY" }); const hr = M.submit(h, 1, P).resolved;
  ok(hr.ev.supply && ["STRENGTH","GOLEM","REMEDY"].includes(hr.ev.supply[0].k), "Hako still restocks at 3 base items used (a created card doesn't count)");
  // AI plays a created card when only it is lethal: Aero Gorger (Air) at 3 HP vs Kirin's 2-damage hit; Apple Bomb = 1 Fire +2 Weak
  const ai = fresh([["gorger","wolf","pyrefly"], ["kirin","roper","pyrefly"]]); ai.p[0].roster[0].hp = 3; ai.p[1].items.STRENGTH = 0; ai.p[1].items.SHARD = 0; H.add(ai, 1, "APPLE_BOMB");   // Strength would be lethal too
  const tally = {}; for (let i = 0; i < 300; i++) { const a = M.aiChoice(ai, 1, { diff:"casual" }).action; tally[a] = (tally[a] || 0) + 1; }
  const top = Object.keys(tally).sort((x, y) => tally[y] - tally[x])[0];
  ok(top === "APPLE_BOMB" && tally.APPLE_BOMB > 100, `casual AI: the lethal card is its top pick (${tally.APPLE_BOMB}/300; casual noise spreads the rest)`);
  let sp = 0; for (let i = 0; i < 20; i++) if (M.aiChoice(ai, 1, { diff:"skilled" }).action === "APPLE_BOMB") sp++;
  ok(sp >= 10, `skilled AI's lookahead finds it too (${sp}/20)`);
  // old saved states (0/1 items, no created keys) still play
  const old = fresh(); old.p[0].items = { STRENGTH:true, GOLEM:0, REMEDY:1, SMOKE:1, SHARD:1, CAFE:1 };
  ok(M.validate(old, 0, { action:"STRENGTH" }) === null && M.validate(old, 0, { action:"GOLEM" }) === "item already used" && H.size(old, 0) === 5, "old 0/1/true hands read the same");
}


// ===== town NPC cards (2026-11-25, phase 4): one check per ability =====
{
  const M = E.Match, H = E.Hand, C = Catalog.CARDS, CFG = Catalog.CFG;
  const P = { action:"PASS" };
  const fresh = (teams) => { const m = M.create({ teams }); M.submit(m, 0, { replace:0 }); M.submit(m, 1, { replace:0 }); return m; };
  const round = (m, a0, a1 = P) => (M.submit(m, 0, a0), M.submit(m, 1, a1)).resolved;
  ok(['willy','rume','pomme','canis','albero','alcina','wagner','roselie','thomas','seigfried','guy','farin'].every(k => C[k] && C[k].character && E.IDS.includes(k)), "the 12 town NPC cards are in the pool, as character cards");
  ok(['willy'].every(k=>C[k].cost===1) && ['seigfried','farin'].every(k=>C[k].cost===3) && ['rume','pomme','canis','albero','alcina','wagner','roselie','thomas','guy'].every(k=>C[k].cost===2), "stars: Willy ★, Seigfried + Farin ★★★, the rest ★★");
  ok(Object.values(C).filter(c=>!c.future).every(c => !/\b(he|she|his|her|him)\b/i.test(c.txt)), "no gendered pronoun in any card text");
  ok(E.isLegalTeam(["willy","hilde","wolf"]), "Willy ★ fits a deck with Princess Hilde ★★★ + a ★");
  // Willy: first voluntary Switch In → Lucky Trinket, once
  { const m = fresh([["wolf","willy","pyrefly"],["kirin","roper","pyrefly"]]);
    round(m, { action:"SWITCH", target:1 }); const n1 = H.count(m, 0, "LUCKY");
    round(m, { action:"SWITCH", target:0 }); round(m, { action:"SWITCH", target:1 });
    ok(n1 === 1 && H.count(m, 0, "LUCKY") === 1, "Willy: Lucky Trinket on his first Switch In only"); }
  // Rume: Pass → Grape Juice, max 1
  { const m = fresh([["rume","wolf","pyrefly"],["kirin","roper","pyrefly"]]); m.p[1].roster[0].hp = 99;
    round(m, P); const a = H.count(m, 0, "GRAPE"); round(m, P);
    ok(a === 1 && H.count(m, 0, "GRAPE") === 1, "Rume: a Pass makes Grape Juice, max 1 in hand"); }
  // Pomme: damaging attack → Apple Bomb, max 1
  { const m = fresh([["pomme","wolf","pyrefly"],["kirin","roper","pyrefly"]]); m.p[1].roster[0].hp = 99;
    round(m, P); const a = H.count(m, 0, "APPLE_BOMB"); round(m, P);
    ok(a === 1 && H.count(m, 0, "APPLE_BOMB") === 1, "Pomme: her damaging attack makes an Apple Bomb, max 1 in hand"); }
  // Canis: damaging attack → target loses 1 printed DEF, min 0
  { const m = fresh([["canis","wolf","pyrefly"],["roper","wolf","pyrefly"]]); m.p[1].roster[0].hp = 99;   // Roper DEF 1
    round(m, P); const t = m.p[1].roster[0]; const d1 = t.armorBreak; round(m, P);
    const dmg = E._withState(m, () => E._calcAttack(m.p[0].roster[0], t, { attItem:"PASS", defItem:"PASS" })).dmg;
    ok(d1 === 1 && t.armorBreak === 1 && dmg === C.canis.atk, "Canis: Armor Break takes Roper's 1 DEF away, never below 0"); }
  // Albero: −1 from attacks only while his side has fewer cards standing
  { const m = fresh([["albero","wolf","pyrefly"],["kirin","roper","pyrefly"]]); const al = m.p[0].roster[0], k = m.p[1].roster[0];
    const even = E._withState(m, () => E._calcAttack(k, al, { attItem:"PASS", defItem:"PASS" })).dmg;
    m.p[0].roster[2].ko = true; m.p[0].roster[2].hp = 0;
    const behind = E._withState(m, () => E._calcAttack(k, al, { attItem:"PASS", defItem:"PASS" })).dmg;
    ok(behind === Math.max(0, even - CFG.ELDER), `Albero: −${CFG.ELDER} only while behind (${even} → ${behind})`); }
  // Alcina: Switched Out → Hearty Stew, once per match
  { const m = fresh([["alcina","wolf","pyrefly"],["kirin","roper","pyrefly"]]); m.p[1].roster[0].hp = 99;
    round(m, { action:"SWITCH", target:1 }); const a = H.count(m, 0, "STEW");
    round(m, { action:"SWITCH", target:0 }); round(m, { action:"SWITCH", target:1 });
    ok(a === 1 && H.count(m, 0, "STEW") === 1, "Alcina: Hearty Stew when she switches out, once per match"); }
  // Wagner: first KO by an attack → 1 HP, once
  { const m = fresh([["wagner","wolf","pyrefly"],["gigas","roper","pyrefly"]].map((t,i)=>i?["gigas","wolf","pyrefly"]:t)); m.p[0].roster[0].hp = 1;
    round(m, P); const w = m.p[0].roster[0]; const survived = w.hp === 1 && !w.ko && w.laugh;
    round(m, P);
    ok(survived && (w.ko || w.hp === 0), "Wagner: Hearty Laugh keeps him at 1 HP the first time, not the second"); }
  // Roselie: her attack burns every enemy Bench card for 1 Fire (the element chart applies)
  { const m = fresh([["roselie","wolf","pyrefly"],["kirin","gorger","wolf"]]); m.p[1].roster[0].hp = 99;
    const g0 = m.p[1].roster[1].hp, w0 = m.p[1].roster[2].hp; round(m, P);
    ok(g0 - m.p[1].roster[1].hp === 3 && w0 - m.p[1].roster[2].hp === 1, "Roselie: Wildfire Kiss = 1 Fire to each Bench card (Air takes 3: Weak)"); }
  // Thomas: KO'd → the next card in gets +2 DEF for 2 rounds
  { const m = fresh([["thomas","wolf","pyrefly"],["gigas","wolf","pyrefly"]]); m.p[0].roster[0].hp = 1;
    round(m, P); const pend = m.phase === "replace";
    M.submit(m, 0, { replace:1 }); const w = m.p[0].roster[1];
    const def2 = E._withState(m, () => E._calcAttack(m.p[1].roster[0], w, { attItem:"PASS", defItem:"PASS" })).dmg;
    const base = E._withState(m, () => { const s = w.lc; w.lc = 0; const d = E._calcAttack(m.p[1].roster[0], w, { attItem:"PASS", defItem:"PASS" }).dmg; w.lc = s; return d; });
    ok(pend && w.lc >= m.round && def2 === Math.max(1, base - CFG.LAST_CALL), `Thomas: Last Call gives the next card +${CFG.LAST_CALL} DEF (${base} → ${def2})`); }
  // King Seigfried: his items +1
  { const m = fresh([["seigfried","wolf","pyrefly"],["kirin","roper","pyrefly"]]); const s = m.p[0].roster[0], k = m.p[1].roster[0];
    const str = E._withState(m, () => E._calcAttack(s, k, { attItem:"STRENGTH", defItem:"PASS" })).dmg - E._withState(m, () => E._calcAttack(s, k, { attItem:"PASS", defItem:"PASS" })).dmg;
    const gol = E._withState(m, () => E._calcAttack(k, s, { attItem:"PASS", defItem:"PASS" })).dmg - E._withState(m, () => E._calcAttack(k, s, { attItem:"PASS", defItem:"GOLEM" })).dmg;
    s.hp = 2; const res = round(m, { action:"REMEDY" });
    ok(str === CFG.STR + CFG.DECREE && res.ev.heal[0] === CFG.REMEDY + CFG.DECREE, `Royal Decree: Tincture +${str} ATK, Remedy heals ${res.ev.heal[0]} (Golem blocks ${gol})`); }
  // Guy: +1 DEF after a full round as the active card, max +1, reset on leaving
  { const m = fresh([["guy","wolf","pyrefly"],["roper","wolf","pyrefly"]]); const g = m.p[0].roster[0]; m.p[1].roster[0].hp = 99; g.hp = 99;   // Roper: no charge-up to muddle the DEF check
    const d0 = E._withState(m, () => E._calcAttack(m.p[1].roster[0], g, { attItem:"PASS", defItem:"PASS" })).dmg;
    round(m, P); round(m, P);
    const d2 = E._withState(m, () => E._calcAttack(m.p[1].roster[0], g, { attItem:"PASS", defItem:"PASS" })).dmg;
    round(m, { action:"SWITCH", target:1 });
    ok(d2 === Math.max(1, d0 - CFG.TRAVELER_MAX) && g.stay === 0, `Guy: +${CFG.TRAVELER_MAX} DEF max after staying in, reset when he leaves (${d0} → ${d2})`); }
  // Farin: start of round while active → one Arcana, max 1 in hand
  { const m = M.create({ teams:[["farin","wolf","pyrefly"],["kirin","roper","pyrefly"]] }); M.submit(m, 0, { replace:0 }); M.submit(m, 1, { replace:0 });
    const arc = () => ["ARC_SUN","ARC_MOON","ARC_STAR"].reduce((a,k)=>a+H.count(m,0,k),0);
    const a1 = arc(); m.p[1].roster[0].hp = 99; round(m, P); const a2 = arc();
    ok(a1 === 1 && a2 === 1, "Farin: an Arcana at the start of the round, max 1 in hand"); }
}

console.log(fails ? fails + " FAILED" : "ALL PASS");
process.exit(fails ? 1 : 0);
