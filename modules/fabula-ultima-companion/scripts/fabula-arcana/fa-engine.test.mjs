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
  S = duel('carlbero','pyrefly',{hp:[3,8]});
  R.resolveRound([{action:'GOLEM'},{action:'PASS'}]);
  ok(S.p[0].roster[0].hp===3, 'Golem Fragment vs faster opponent is active before the attack (took 0)');
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
  ok(r.ev.seq && r.ev.seq[0]===0 && S.p[0].items.CAFE===0 && S.stats.cafe.capped===1, 'SPD 4 + Café stays SPD 4, item consumed');
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
  ok(R.IDS.length===27 && ['obsidrax','roo','walrog','gorger','sylph','succubus','hina','zarg','raubens','geist','kalina'].every(k=>R.IDS.includes(k)) && !R.IDS.some(k=>['broo','carlbero','life'].includes(k)), 'pool = 27 cards (22 + 5 character cards; Bandit Roo retired)');
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
  ok(rd[0]===1 && rd[1]===1 && rd[2]>=9999 && S.p[1].roster[0].ko && S.p[0].roster[0].ko, "Roo: 1, 1, then the Knife (9999) on step 3; then Roo walks away (got "+rd.slice(0,2)+")");
  S = duel(A('roo'), ['hellhound','kirin','cryo'], {hp:[30,30]}); S.p[1].roster[1].hp=30; go(P,P); go(P,P); r=go(P,{action:'SWITCH',target:1});
  ok(dmg0()<9999 && S.p[0].roster[0].steps.t===1 && S.p[0].roster[0].steps.n===1 && !S.p[0].roster[0].ko, 'Roo: the victim switches out → steps reset on the new target, no knife');
  S = duel(A('roo'), ['hellhound','kirin','cryo'], {hp:[30,30]}); for (const i of [1,2]){ S.p[1].roster[i].ko=true; S.p[1].roster[i].hp=0; } go(P,P); go(P,P); r=go(P,P);
  ok(S.result==='WIN' && !S.p[0].roster[0].ko, "Roo: a knife on the opponent's last monster wins; Roo doesn't walk away into a draw");
  S = duel(A('scorpion'), B('hellhound')); r=go(P,P); const v1=dmg0(); r=go(P,P); ok(v1===5 && dmg0()===3, 'Bandit Scorpion: Venom Sting +2 once (5 then 3)');
  R.CFG.ROO_BENCH=2;
  S = duel(['hellhound','roo','kirin'], B('cryo'), {hp:[30,30]}); for (let k=0;k<3;k++) go(P,P); ok(!S.p[0].roster[1].walk, 'Roo (field mode): no steps while benched');
  S = duel(A('roo'), ['hellhound','kirin','cryo'], {hp:[30,30]}); const fr=[]; for (let k=0;k<3;k++){ r=go(P,P); fr.push(dmg0()); }
  ok(fr[0]===1 && fr[1]===1 && fr[2]>=9999 && S.p[1].roster[0].ko && S.p[0].roster[0].ko, 'Roo (field mode): 1, 1, knife on its 3rd round on the field, then walks away (got '+fr.slice(0,2)+')');
  S = duel(['roo','hellhound','kirin'], B('cryo'), {hp:[30,30]}); S.p[0].roster[1].hp=30; go(P,P); go({action:'SWITCH',target:1},P);
  ok(!S.p[0].roster[0].walk, 'Roo (field mode): switching out resets its steps');
  go({action:'SWITCH',target:0},P); r=go(P,P); ok(dmg0()<9999, 'Roo (field mode): back on the field it has to walk again (no knife yet)');
  // Rock Golem Wind Up → Earthquake
  S = duel(A('rgolem'), ['hellhound','kirin','cryo'], {hp:[30,30]}); r=go(P,P); const q1=S.p[1].roster[1].hp+S.p[1].roster[2].hp; r=go({action:'GOLEM'},P); const q2=S.p[1].roster[1].hp+S.p[1].roster[2].hp;
  ok(q1===17 && q2===17 && S.p[0].roster[0].windup===false, 'Rock Golem: Pass arms Wind Up, same-round attack is an Earthquake (19 → 17 bench HP); next non-Pass attack has none (got '+q1+'/'+q2+')');

  // Aero Gorger burst
  S = duel(A('hellhound'), B('gorger'), {hp:[8,2]}); r=go(P,P); ok(S.p[0].roster[0].hp===6, 'Aero Gorger: Aero Explosion 2 to the attacker');

  // ---- character cards (playtest v1) ----
  ok(['hina','zarg','raubens','geist','kalina'].every(k=>R.CARDS[k].cost===3 && R.CARDS[k].character), 'character cards are ★★★ and flagged character');
  // Zarg Barrage: 2 to the benched enemy with the lowest HP
  S = duel(A('zarg'), B('hellhound'), {hp:[30,30]}); S.p[1].roster[1].hp=5; S.p[1].roster[2].hp=9; r=go(P,P);
  ok(S.p[1].roster[1].hp===3 && S.p[1].roster[2].hp===9, 'Zarg: Barrage hits the lowest-HP benched enemy for 2 (5 → 3, the other untouched)');
  S = duel(A('zarg'), B('hellhound'), {hp:[30,30]}); S.p[1].roster[1].hp=2; r=go(P,P);
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
  // Kalina Jump: Pass → attacks normally (ATK 1 / DEF 5), lands next round swapped (ATK 5 / DEF 1), then grounded again
  S = duel(A('kalina'), B('wolf'), {hp:[30,30]}); r=go(P,{action:'STRENGTH'}); const k1=dmg0(), t1=r.ev.res[1].dmg;
  r=go({action:'CAFE'},{action:'SHARD'}); const k2=dmg0(), t2=r.ev.res[1].dmg; r=go(P,P); const k3=dmg0();
  ok(k1===1 && t1===1 && k2===5 && t2===3 && k3===1, 'Kalina: Jump round 1 dmg & DEF 5 (5−5→1), landing ATK 5 & DEF 1 (Shard 4−1=3), jumps again (got '+[k1,t1,k2,t2,k3]+')');
  S = duel(A('kalina'), B('wolf'), {hp:[30,30]}); r=go(P,P); r=go(P,P); ok(S.p[0].roster[0].land===4 && dmg0()===5, 'Kalina: a Pass on the landing round does not jump again');
  S = duel(['kalina','hellhound','cryo'], B('wolf'), {hp:[30,30]}); r=go(P,P); r=go({action:'SWITCH',target:1},P); ok(!S.p[0].roster[0].land, 'Kalina: switching out cancels the landing');
}

// ===== Hina Foretell (match flow) =====
{
  const M = E.Match;
  const m = M.create({ teams:[["hina","pyrefly","wolf"], ["kirin","roper","pyrefly"]] });
  M.submit(m,0,{replace:0}); M.submit(m,1,{replace:0});
  ok(m.phase==='choose' && E.foretellSeat(m)===0 && !M.needs(m,0) && M.needs(m,1), 'Foretell: Hina side waits, the other side chooses first');
  ok(!M.submit(m,0,{action:'PASS'}).ok, 'Foretell: Hina side cannot commit before the opponent');
  M.submit(m,1,{action:'STRENGTH'});
  ok(M.needs(m,0) && M.publicView(m,0).commit[1].action==='STRENGTH', "Foretell: after the opponent commits, Hina's side sees the card");
  ok(M.publicView(m,1).commit[0]===null && M.publicView(m,null).commit[1].hidden, 'Foretell: spectators still see it hidden');
  const c = M.aiChoice(m,0,{diff:'skilled'}); ok(!M.validate(m,0,c), 'Foretell: AI holding Hina answers with a legal move ('+c.action+')');
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

console.log(fails ? fails + " FAILED" : "ALL PASS");
process.exit(fails ? 1 : 0);
