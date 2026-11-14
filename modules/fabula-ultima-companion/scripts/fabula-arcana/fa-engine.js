/**
 * Fabula Arcana — rules engine, AI and match flow (pure; no Foundry calls; node-testable)
 *
 * File: scripts/fabula-arcana/fa-engine.js   (needs fa-catalog.js loaded first)
 *
 * Rules: three-card teams within a 5★ budget; each decision both seats commit one face-down choice
 * (an item, Pass, or Switch). Faster SPD resolves first; equal SPD hits together; element chart ±2;
 * a separate Replacement phase follows a KO; HP tiebreak on a final mutual KO; 20-round cap.
 * Card abilities, AI (Casual heuristic / Skilled one-round lookahead) and every number are the
 * approved mockup's, lifted 1:1 (see fa-catalog.js). The rules code below runs against one match
 * state at a time (`S`); the Match API sets it for each call, so states never leak between matches.
 *
 * Public API: globalThis.FabulaArcana.Engine
 *   .Match.create({ teams:[ids,ids], names?:[a,b] })   → match state (plain JSON-safe object)
 *   .Match.needs(state, seat)                          → this seat must commit in the current phase
 *   .Match.validate(state, seat, choice)               → null | error string
 *   .Match.submit(state, seat, choice)                 → { ok, error?, resolved? }  (resolves when every needed seat committed)
 *   .Match.autoChoice(state, seat)                     → timeout choice (auto-pick highest HP / auto-Pass)
 *   .Match.aiChoice(state, seat, prof)                 → AI choice (public info only; never reads the other commit)
 *   .Match.publicView(state, viewerSeat|null)          → copy with hidden commits masked (null = spectator)
 *   .Series.create(bestOf) / .Series.record(series, result) → Best of 1/3/5 bookkeeping (draws are replayed)
 *   .setRng(fn) / .teamCost(ids) / .isLegalTeam(ids) / .randomTeam() / .IDS / .LEGAL_TEAMS
 *
 * Choices:  opening/replace phase → { replace: rosterIndex }     choose phase → { action, target? }
 *           action ∈ PASS | SWITCH | STRENGTH | GOLEM | REMEDY | SMOKE | SHARD | CAFE
 */
(() => {
  const { CFG, AI_DIFF, AI_STYLE, EL, BEATS, CARDS, ITEMS, ACT_T } = globalThis.FabulaArcana.Catalog;
  let RNG = Math.random;
  let S = null;                       // the match being resolved (set by withState)

  const isLanding = m => !!m && m.cid==='kalina' && !!S && m.land===S.round;
  // Hina's Foretell: the seat whose active card is Hina chooses SECOND and sees the other seat's card.
  // Only in the action step, and only when exactly one side has Hina up front (both = a normal round).
  function foretellSeat(state){
    if (!state || state.phase!=='choose') return null;
    const h=[0,1].filter(s=>{ const pl=state.p[s], m=pl.active==null?null:pl.roster[pl.active]; return !!m && !m.ko && m.hp>0 && m.cid==='hina'; });
    return h.length===1 ? h[0] : null;
  }
  function elMod(a, d){ if (a==='none'||d==='none') return 0; if (BEATS[a]===d) return CFG.ADV; if (BEATS[d]===a) return -CFG.DIS; return 0; }
  const shuffle = a => { a=[...a]; for(let i=a.length-1;i>0;i--){const j=Math.floor(RNG()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
  const N = cid => CARDS[cid].name;
  const IDS = Object.keys(CARDS).filter(k=>!CARDS[k].future);   // launch pool
  function mkPlayer(ids){
    return { roster: ids.map((cid,i)=>({ i, cid, hp:CARDS[cid].hp, ko:false, abilityUsed:false, attacked:false, activeRounds:0 })),
             active:null, items:{STRENGTH:1,GOLEM:1,REMEDY:1,SMOKE:1,SHARD:1,CAFE:1}, pending:false };
  }
  const mon = (pl, idx) => idx==null ? null : pl.roster[idx];
  const living = pl => pl.roster.filter(m=>!m.ko);
  const benchOptions = pl => pl.roster.filter(m => !m.ko && m.i!==pl.active);
  const teamCost = ids => ids.reduce((a,id)=>a+CARDS[id].cost,0);
  const LEGAL_TEAMS = (()=>{ const out=[]; for (let a=0;a<IDS.length;a++) for (let b=a+1;b<IDS.length;b++) for (let c=b+1;c<IDS.length;c++){ const t=[IDS[a],IDS[b],IDS[c]]; if (teamCost(t)<=CFG.BUDGET) out.push(t); } return out; })();
  const randomTeam = () => shuffle(LEGAL_TEAMS[Math.floor(RNG()*LEGAL_TEAMS.length)]);
  const compKey = ids => ids.map(id=>CARDS[id].cost).sort((a,b)=>b-a).join('+');
  // ===================== rules engine (v0.2) =====================
  // ctx: {attItem, defItem, defSwitchedIn}
  function calcAttack(att, def, ctx){
    const A=CARDS[att.cid], D=CARDS[def.cid];
    const ael = ctx.attItem==='SHARD' ? 'none' : A.el;
    // Kalina's Jump landing: ATK and DEF swap for the landing round
    const landA = isLanding(att), landD = isLanding(def);
    let atk = landA ? A.def : A.atk; const parts=[landA ? `${atk} ATK (Jump landing)` : `${A.atk} ATK`];
    if (att.cid==='raubens' && (att.loot||0)>0){ atk+=att.loot; parts.push(`+${att.loot} Bandit King`); }
    if (ctx.attItem==='STRENGTH'){ atk+=CFG.STR; parts.push(`+${CFG.STR} Strength`); }
    if (ctx.attItem==='SHARD'){ atk+=CFG.SHARD; parts.push(`+${CFG.SHARD} Shard`); }
    const pyre = att.cid==='pyrefly' && ((att.burn||{})[def.i]||0)>=CFG.PYRE_N; if (pyre){ atk+=CFG.PYRE_BURST; parts.push(`+${CFG.PYRE_BURST} Funeral Pyre`); }
    const kcharge = att.cid==='kirin' && !!(att.chg && att.chg[S.round]); if (kcharge){ atk+=CFG.KCHARGE; parts.push(`+${CFG.KCHARGE} Lightning Charge`); }
    if (att.cid==='gigas' && D.def>=1){ atk+=1; parts.push('+1 Crushing Blow'); }
    if (att.cid==='manaray' && ITEMS[ctx.defItem]){ atk+=1; parts.push('+1 Mana Catcher'); }
    if (att.cid==='hellhound' && def.hp*2<=D.hp){ atk+=1; parts.push('+1 On the Hunt'); }
    if (att.cid==='roper' && ctx.defSwitchedIn){ atk+=1; parts.push('+1 Entangle'); }
    const howl = att.cid==='wolf' && !!att.howl; if (howl){ atk+=1; parts.push('+1 Howl'); }
    if ((att.charm||0)>=S.round){ atk=Math.max(0,atk-CFG.CHARM); parts.push(`−${CFG.CHARM} Charm`); }
    const head = `${parts.join(' ')} = ${atk} ${EL[ael]}`;
    // absorption ability: checked before damage (fires even if Guard would zero it)
    if (D.absorb && D.absorb===ael && !def.abilityUsed)
      return { dmg:0, heal:CFG.AB_HEAL, aff:'AB', line:`${head} · ${N(def.cid)}'s <b>${D.ab}</b> negates it (+${CFG.AB_HEAL} HP)`, usedAbsorb:true, howl, pyre, kcharge, ael };
    const ddef = landD ? D.atk : D.def;
    let d = Math.max(1, atk - ddef); let line = head + (ddef?` − DEF ${ddef}${landD?' (landing)':''}`:'') + ` = ${d}`;
    const mod = elMod(ael, D.el); let aff = ael==='none' ? 'NONE' : 'N';
    if (mod>0){ d=Math.max(1,d+mod); aff='ADV'; line+=` · <b>Strong</b> vs ${EL[D.el]} +${mod} = ${d}`; }
    if (mod<0){ d=Math.max(1,d+mod); aff='DIS'; line+=` · <b>Weak</b> vs ${EL[D.el]} ${mod} = ${d}`; }
    const red=[]; let r=0;
    if (ctx.defItem==='GOLEM'){
      if (ctx.attItem==='SMOKE') red.push('Golem Fragment pierced by Smoke Bomb'); else { r+=CFG.GOLEM; red.push(`Golem Fragment −${CFG.GOLEM}`); }
      if (def.cid==='carlbero'){ r+=1; red.push('Fortify −1'); }
    }
    if (def.cid==='broo' && ctx.defSwitchedIn){ r+=2; red.push('Soft Landing −2'); }
    if (def.cid==='fulgimite' && ctx.defSwitchedIn){ r+=2; red.push('Evasion −2'); }
    d = Math.max(0, d-r);
    let usedFirst=false;
    let prevented=0;
    if (def.cid==='walrog' && !def.abilityUsed && d>0){ prevented=Math.min(3,d); d=Math.max(0,d-3); usedFirst=true; red.push('Thick Skin −3'); }
    if (def.cid==='salamander' && !def.abilityUsed && ael==='fire' && d>0){ prevented=Math.min(2,d); d=Math.max(0,d-2); usedFirst=true; red.push('Pyrophagy −2'); }
    let usedOwn=false;
    if (att.cid==='scorpion' && !att.abilityUsed && d>=1){ d+=CFG.VENOM; usedOwn=true; red.push(`Venom Sting +${CFG.VENOM}`); }
    let zap=false; if (att.cid==='skizzik' && (att.static||0)>=2 && d>0){ d+=3; zap=true; red.push('Static Buildup +3'); }
    let knife=false; if (att.cid==='roo' && CFG.ROO_BENCH ? (att.walk||0)>=(CFG.ROO_BENCH===2?CFG.ROO_STEPS:3) && !(CFG.ROO_GOLEM && ctx.defItem==='GOLEM') : att.cid==='roo' && (CFG.ROO_MARK ? ((att.marks||{})[def.i]||0)>=2 : (att.steps && att.steps.t===def.i && att.steps.n>=2))){ d+=CFG.KNIFE; knife=true; red.push(`Chef's Knife +${CFG.KNIFE}`); }
    let wire=0; if (def.cid==='obsidrax' && !def.abilityUsed && ael==='bolt' && d>0){ wire=d; d=0; usedFirst=true; red.push('Earthen Wire grounds it'); }
    if (red.length) line += ` · ${red.join(', ')}`;
    return { dmg:d, heal:0, aff, line, usedFirst, usedOwn, howl, pyre, kcharge, zap, knife, wire, ael, prevented, pierced: ctx.defItem==='GOLEM' && ctx.attItem==='SMOKE' };
  }

  function resolveRound(ch){
    const P=S.p, L=[], ev={ enter:[null,null], switched:[false,false], items:[null,null], heal:[0,0], res:[null,null], after:[[],[]], ko:[false,false] };
    // Geist's Blackest Night: the first time he would reach 0 HP (any source, active or benched) he rises at full HP; overflow is lost
    const BN = m => { if (m && m.cid==='geist' && m.hp<=0 && !m.ko && !m.bn){ m.bn=true; m.hp=CARDS.geist.hp; S.stats.bn=(S.stats.bn||0)+1;
      (ev.revive=ev.revive||[]).push({ s: P[0].roster.includes(m)?0:1, i:m.i });
      L.push(['The Blackest Night: Geist rises again at full HP!','g']); } };
    const who = s => (S.names && S.names[s]) || (s===0?'You':'NPC'); const third = s => !!(S.names && S.names[s]) || s===1;
    for (const s of [0,1]) if (P[s].pending){
      P[s].active=ch[s].replace; P[s].pending=false; S.stats.forced[s]++; ev.enter[s]='forced';
      L.push([`${who(s)} send${third(s)?'s':''} in ${N(mon(P[s],P[s].active).cid)}.`,'m']);
    }
    for (const s of [0,1]) if (ch[s].action==='SWITCH'){
      const out=mon(P[s],P[s].active); if (CFG.ROO_BENCH===2 && out.cid==='roo' && out.walk){ out.walk=0; L.push(['Roo leaves the field and loses its steps.','m']); }
      if (out.cid==='kalina' && out.land){ out.land=0; L.push(['Kalina leaves the field; her Jump is cancelled.','m']); } P[s].active=ch[s].target; ev.switched[s]=true; ev.enter[s]='switch'; S.stats.switches[s]++;
      L.push([`${who(s)} switch${third(s)?'es':''} ${N(out.cid)} out for ${N(mon(P[s],P[s].active).cid)}. It skips its attack.`,'m']);
    }
    for (const s of [0,1]) if (ev.switched[s] && mon(P[s],P[s].active).cid==='succubus'){ const t=mon(P[1-s],P[1-s].active); if (t && t.hp>0){ t.charm=S.round+1; S.stats.charm=(S.stats.charm||0)+1; L.push([`Charm: ${N(t.cid)} is Charmed (−${CFG.CHARM} ATK this round and next).`,'m']); } }
    for (const s of [0,1]) if (ev.switched[s] && mon(P[s],P[s].active).cid==='flame'){ const t=mon(P[1-s],P[1-s].active); if (t && t.hp>0){ const b=t.hp; t.hp=Math.max(0,t.hp-CFG.ENTRY); BN(t); (ev.entry=ev.entry||[]).push({s:1-s,amt:b-t.hp}); S.stats.entry=(S.stats.entry||0)+1;
        L.push([`Dynamic Entry: Wandering Flame bursts in, ${b-t.hp} Fire damage to ${N(t.cid)} (${t.hp} HP).`,'']); } }
    for (const s of [0,1]){ const a=ch[s].action; S.stats.acts[s][a]=(S.stats.acts[s][a]||0)+1; if (ITEMS[a]){ P[s].items[a]=0; ev.items[s]=a; } }
    // Raubens' Bandit King: an item used while he is the opposing active card = +1 ATK for the rest of the match (counts this round)
    for (const s of [0,1]) if (ITEMS[ch[s].action]){ const r=mon(P[1-s],P[1-s].active); if (r && r.cid==='raubens' && r.hp>0){ r.loot=(r.loot||0)+1; S.stats.loot=(S.stats.loot||0)+1;
      L.push([`Bandit King: Raubens takes his cut of the ${ITEMS[ch[s].action].t} (+1 ATK, now +${r.loot}).`,'m']); } }
    // Kalina's Jump: a Pass (not on her landing round) = she jumps; she lands NEXT round with ATK and DEF swapped
    for (const s of [0,1]) if (ch[s].action==='PASS'){ const m=mon(P[s],P[s].active); if (m && m.cid==='kalina' && m.land!==S.round){ m.land=S.round+1; S.stats.jump=(S.stats.jump||0)+1;
      L.push(['Kalina Jumps! She lands next round (ATK and DEF swap for that round).','m']); } }
    // Howl / Wind Up timing, per card (CFG.HOWL_NEXT / CFG.WINDUP_NEXT): 0 = armed on the Pass and used by that same round's
    // attack; 1 = armed at the END of the round it Passed, so it powers the NEXT attack (visible for a whole decision; can stack
    // with an item); 2 = ability off (balance sims only). Live rules (2026-11-14 sim): Wolf 0, Rock Golem 1.
    const armNext = m => (m.cid==='wolf' && CFG.HOWL_NEXT===1) || (m.cid==='rgolem' && CFG.WINDUP_NEXT===1);
    for (const s of [0,1]) if (ch[s].action==='PASS' && armNext(mon(P[s],P[s].active))) (ev.passArm=ev.passArm||[]).push(s);
    for (const s of [0,1]) if (ch[s].action==='PASS' && !armNext(mon(P[s],P[s].active))){ const m=mon(P[s],P[s].active); if (m.cid==='wolf' && CFG.HOWL_NEXT!==2 && !m.howl){ m.howl=true; L.push(['Wolf howls: +1 ATK on its attack this round.','m']); }
      if (m.cid==='rgolem' && CFG.WINDUP_NEXT!==2 && !m.windup){ m.windup=true; L.push(['Rock Golem winds up: its next attack will be an Earthquake.','m']); } }
    const startHP=[0,1].map(s=>mon(P[s],P[s].active).hp);
    for (const s of [0,1]) if (ch[s].action==='REMEDY'){
      const m=mon(P[s],P[s].active), amt=CFG.REMEDY, b=m.hp;
      m.hp=Math.min(CARDS[m.cid].hp, m.hp+amt); ev.heal[s]=m.hp-b;
      L.push([`${N(m.cid)} drinks a Remedy: +${ev.heal[s]} HP → ${m.hp}.`,'g']);
    }
    for (const s of [0,1]) if (['STRENGTH','GOLEM','SMOKE','SHARD'].includes(ch[s].action)) L.push([`${who(s)} use${third(s)?'s':''} ${ITEMS[ch[s].action].t}.`,'m']);
    for (const s of [0,1]){ const m=mon(P[s],P[s].active); m.activeRounds++; }
    const preHP=[0,1].map(s=>mon(P[s],P[s].active).hp); // v0.4 tiebreak snapshot (after Remedy, before impact)
    // ---- attack phase (v0.5): equal Speed = simultaneous; otherwise the faster attack fully resolves first ----
    const directHit = (s, amt, src, withActive) => { const pl=P[s]; const c=pl.roster.filter(m=>!m.ko && m.hp>0 && (withActive || m.i!==pl.active)); if (!c.length) return null;
      const m=c[Math.floor(RNG()*c.length)]; return hitOne(s, m, amt, src); };
    const hitOne = (s, m, amt, src) => { const pl=P[s]; m.hp=Math.max(0,m.hp-amt); BN(m); (ev.direct=ev.direct||[]).push({s,i:m.i,amt,src}); S.stats.direct=S.stats.direct||{}; S.stats.direct[src]=(S.stats.direct[src]||0)+1;
      const bench=m.i!==pl.active; L.push([`${src}: ${amt} damage to ${bench?'benched ':''}${N(m.cid)} (${m.hp} HP).`,'']);
      if (m.hp===0 && bench){ m.ko=true; ev.benchKO=(ev.benchKO||0)+1; S.stats.kos.push(m.cid); L.push([`${N(m.cid)} is knocked out on the bench!`,'k']); }
      return m; };
    const calcFor = s => { const o=1-s, a=mon(P[s],P[s].active), d=mon(P[o],P[o].active);
      return { ...calcAttack(a,d,{attItem:ch[s].action, defItem:ch[o].action, defSwitchedIn:ev.switched[o]}), a, d, side:s }; };
    const applyHit = r => {
      if (r.heal){ const b=r.d.hp; r.d.hp=Math.min(CARDS[r.d.cid].hp, r.d.hp+r.heal); r.healed=r.d.hp-b; }
      else { r.d.hp=Math.max(0, r.d.hp-r.dmg); BN(r.d); }
      r.a.attacked=true; if (r.usedOwn) r.a.abilityUsed=true; if (r.howl){ r.a.howl=false; S.stats.howl=(S.stats.howl||0)+1; }
      if (r.a.cid==='pyrefly'){ r.a.burn=r.a.burn||{}; if (r.pyre){ r.a.burn[r.d.i]=0; S.stats.pyre=(S.stats.pyre||0)+1; } else if (r.dmg>0) r.a.burn[r.d.i]=Math.min(CFG.PYRE_N,(r.a.burn[r.d.i]||0)+1); if (r.d.hp===0) delete r.a.burn[r.d.i]; }
      if (r.a.cid==='skizzik' && r.dmg>0){ r.a.static = r.zap ? 0 : Math.min(2,(r.a.static||0)+1); if (r.zap) S.stats.zap=(S.stats.zap||0)+1; }
      if (r.a.cid==='roo' && CFG.ROO_BENCH){ if (r.knife){ r.a.walk=0; r.a.leaving=!!CFG.ROO_LEAVE; S.stats.knife=(S.stats.knife||0)+1; } else if (CFG.ROO_GOLEM && (r.a.walk||0)>=(CFG.ROO_BENCH===2?CFG.ROO_STEPS:3)){ r.a.walk=0; L.push(['Golem Fragment turns the knife aside!','m']); } }
      else if (r.a.cid==='roo'){ if (r.knife){ r.a.steps=null; if (r.a.marks) r.a.marks[r.d.i]=0; r.a.leaving=!!CFG.ROO_LEAVE; S.stats.knife=(S.stats.knife||0)+1; }
        else { if (CFG.ROO_MARK){ r.a.marks=r.a.marks||{}; r.a.marks[r.d.i]=(r.a.marks[r.d.i]||0)+1; }
          const st=r.a.steps; r.a.steps = (st && st.t===r.d.i) ? {t:r.d.i, n:st.n+1} : {t:r.d.i, n:(CFG.ROO_MARK?r.a.marks[r.d.i]:1)}; L.push([`Roo takes a step toward ${N(r.d.cid)} (${r.a.steps.n}/3).`,'m']); } }
      if (r.kcharge){ delete r.a.chg[S.round]; S.stats.kcharge=(S.stats.kcharge||0)+1; }
      if (r.d.cid==='kirin' && r.dmg>0 && r.d.hp>0 && !r.heal){ r.d.chg=r.d.chg||{}; r.d.chg[S.round+1]=true; L.push([`Lightning Charge: Kirin is charged (+${CFG.KCHARGE} ATK next round).`,'m']); }
      if (false && r.a.cid==='sylph' && r.dmg>0 && r.d.hp>0){ r.d.slowRound=S.round+1; S.stats.gust=(S.stats.gust||0)+1; L.push([`Gust: ${N(r.d.cid)} will be −1 SPD next round.`,'m']); }
      if (r.a.cid==='sylph'){ P[r.side].twFrom=S.round+1; P[r.side].twUntil=S.round+CFG.TAILWIND; S.stats.twSet=(S.stats.twSet||0)+1; L.push([`Tailwind: ${CFG.TW_ALL?'your monsters':'your Air monsters'} get +1 SPD for ${CFG.TAILWIND} rounds.`,'m']); }
      if (r.a.cid==='archer') directHit(1-r.side, 1, 'Double Strafe', false);
      if (r.a.cid==='zarg'){ const pl=P[1-r.side]; const b=pl.roster.filter(m=>!m.ko && m.hp>0 && m.i!==pl.active).sort((x,y)=>x.hp-y.hp);
        if (b.length){ const low=b.filter(m=>m.hp===b[0].hp); S.stats.barrage=(S.stats.barrage||0)+1; hitOne(1-r.side, low[Math.floor(RNG()*low.length)], CFG.BARRAGE, 'Barrage'); } }
      if (r.a.cid==='rgolem' && r.a.windup){ r.a.windup=false; S.stats.quake=(S.stats.quake||0)+1; const pl=P[1-r.side]; L.push(['Earthquake!','m']);
        for (const m of pl.roster) if (!m.ko && m.hp>0 && m.i!==pl.active){ m.hp=Math.max(0,m.hp-1); BN(m); (ev.direct=ev.direct||[]).push({s:1-r.side,i:m.i,amt:1,src:'Earthquake'}); L.push([`Earthquake: 1 damage to benched ${N(m.cid)} (${m.hp} HP).`,'']);
          if (m.hp===0){ m.ko=true; ev.benchKO=(ev.benchKO||0)+1; S.stats.kos.push(m.cid); L.push([`${N(m.cid)} is knocked out on the bench!`,'k']); } } }
      if (r.wire) directHit(r.side, r.wire, 'Earthen Wire', true); if (r.usedFirst||r.usedAbsorb) r.d.abilityUsed=true;
      if (r.d.cid==='cryo' && r.usedFirst){ S.stats.frost=S.stats.frost||[0,0]; S.stats.frost[0]++; S.stats.frost[1]+=r.prevented; }
      S.stats.aff[r.aff]=S.stats.aff[r.aff]||[0,0]; S.stats.aff[r.aff][0]++; S.stats.aff[r.aff][1]+=r.dmg;
      L.push([`${N(r.a.cid)}: ${r.line} → ${r.heal?`<b>heals ${r.healed}</b>`:`<b>${r.dmg}</b> damage`} (${N(r.d.cid)} ${r.d.hp} HP).`,'']);
      if (r.undying) L.push(['Undying Flame: Inferex refuses to fall and stays at 1 HP.','g']);
    };
    const afterHit = r => { const s=r.side;
      if ((r.d.cid==='cryo'||r.d.cid==='gorger') && r.d.hp===0 && !r.heal && r.a.hp>0){ const b=r.a.hp; r.a.hp=Math.max(0,r.a.hp-2); BN(r.a); S.stats.cryoX=(S.stats.cryoX||0)+1; ev.after[1-s].push(['burst',b-r.a.hp]); L.push([`${r.d.cid==='cryo'?'Cryo':'Aero'} Explosion: ${N(r.a.cid)} takes ${b-r.a.hp} → ${r.a.hp} HP.`,'k']); }
      if (false && r.a.cid==='gorger' && r.d.hp===0 && r.a.hp>0){ const b=r.a.hp; r.a.hp=Math.min(CARDS.gorger.hp,r.a.hp+2); if (r.a.hp>b){ ev.after[s].push(['heal',r.a.hp-b]); L.push([`Devour: Aero Gorger +${r.a.hp-b} HP → ${r.a.hp}.`,'g']); } }
      if (r.d.cid==='life' && !r.d.abilityUsed && r.dmg>0 && r.d.hp>0 && r.d.hp<=4){ const b=r.d.hp; r.d.hp=Math.min(CARDS.life.hp,r.d.hp+2); r.d.abilityUsed=true; ev.after[1-s].push(['heal',r.d.hp-b]); L.push([`Renewal: Life Gorger +${r.d.hp-b} HP → ${r.d.hp}.`,'g']); }
    };
    const snap = () => [0,1].map(s=>mon(P[s],P[s].active).hp);
    const canAtk=[0,1].map(s=>!ev.switched[s] && mon(P[s],P[s].active).hp>0);
    if (!canAtk[0]&&!canAtk[1]) L.push(['Both sides switched. No attacks this round.','m']);
    const baseSp=[0,1].map(s=>{ const m=mon(P[s],P[s].active); const tw = (CFG.TW_ALL || CARDS[m.cid].el==='air') && P[s].twFrom<=S.round && S.round<=P[s].twUntil ? 1 : 0;
      if (tw){ S.stats.tailwind=(S.stats.tailwind||0)+1; } return Math.min(4, Math.max(1, CARDS[m.cid].spd + tw - (m.slowRound===S.round?1:0))); });
    const sp=[0,1].map(s=>Math.min(4, baseSp[s] + (ch[s].action==='CAFE'?1:0)));   // Café au Lait: +1 SPD this round, cap 4
    for (const s of [0,1]) if (ch[s].action==='CAFE'){ const changed=(Math.sign(baseSp[s]-baseSp[1-s])!==Math.sign(sp[s]-baseSp[1-s])); S.stats.cafe=S.stats.cafe||{used:0,changed:0,capped:0}; S.stats.cafe.used++; if (changed) S.stats.cafe.changed++; if (baseSp[s]>=4) S.stats.cafe.capped++;
      L.push([`${N(mon(P[s],P[s].active).cid)} drinks Café au Lait: SPD ${baseSp[s]} → ${sp[s]}${baseSp[s]>=4?' (already at max)':''}.`,'m']); }
    if (canAtk[0]&&canAtk[1]&&sp[0]!==sp[1]){
      const first=sp[0]>sp[1]?0:1, second=1-first;
      ev.seq=[]; ev.snaps=[];
      L.push([`${N(mon(P[first],P[first].active).cid)} is faster (SPD ${sp[first]} vs ${sp[second]}) and strikes first.`,'m']);
      const r1=calcFor(first); ev.res[first]=r1; applyHit(r1); afterHit(r1); ev.seq.push(first); ev.snaps.push(snap());
      if (mon(P[second],P[second].active).hp>0){ const r2=calcFor(second); ev.res[second]=r2; applyHit(r2); afterHit(r2); ev.seq.push(second); ev.snaps.push(snap()); }
      else { ev.denied=second; S.stats.firstStrike=(S.stats.firstStrike||0)+1; L.push([`${N(mon(P[second],P[second].active).cid)} falls before it can strike back.`,'k']); }
    } else {
      for (const s of [0,1]) if (canAtk[s]) ev.res[s]=calcFor(s);   // computed on the shared pre-impact state
      for (const s of [0,1]) if (ev.res[s]) applyHit(ev.res[s]);
      for (const s of [0,1]) if (ev.res[s]) afterHit(ev.res[s]);
    }
    for (const s of [0,1]){ const r=ev.res[s]; if (r && r.a.cid==='inferex' && r.d.hp===0 && r.a.hp>0 && !r.heal) directHit(1-s, CFG.VORACIOUS, 'Voracious', false); }
    // zero-progress round classification (ChatGPT metric)
    { const z=S.stats.zero; const totalDmg=[0,1].reduce((a,s)=>a+(ev.res[s]?ev.res[s].dmg:0),0);
      const netLoss=[0,1].map(s=>startHP[s]-mon(P[s],P[s].active).hp);
      if (ev.switched[0]&&ev.switched[1]) z.bothSwitch++;
      else if (totalDmg===0) z.noHpLost++;
      else if (netLoss[0]<=0 && netLoss[1]<=0) z.healedBack++; }
    if (CFG.ROO_BENCH) for (const s of [0,1]) for (const m of P[s].roster) if (m.cid==='roo' && !m.ko && m.hp>0 && !m.leaving && (CFG.ROO_BENCH!==2 || m.i===P[s].active)){
      const need = CFG.ROO_BENCH===2 ? CFG.ROO_STEPS : 3; const b=m.walk||0; m.walk=Math.min(need,b+1);
      if (m.walk!==b) L.push([`Roo takes a step (${m.walk}/${need})${m.walk===need?': its next attack draws the knife.':'.'}`,'m']); }
    for (const s of [0,1]){ const m=mon(P[s],P[s].active); if (m && m.leaving){ m.leaving=false; const oppLeft=P[1-s].roster.some(x=>!x.ko && x.hp>0);
        if (oppLeft){ m.hp=0; L.push(['Roo puts the knife away, walks off, and is gone from the duel.','m']); } } }
    for (const s of (ev.passArm||[])){ const m=mon(P[s],P[s].active); if (!m || m.hp<=0) continue;
      if (m.cid==='wolf' && !m.howl){ m.howl=true; L.push(['Wolf howls: its next attack gets +1 ATK.','m']); }
      if (m.cid==='rgolem' && !m.windup){ m.windup=true; L.push(['Rock Golem winds up: its next attack will be an Earthquake.','m']); } }
    // KO
    for (const s of [0,1]){ const m=mon(P[s],P[s].active); if (m.hp<=0 && !m.ko){ m.ko=true; ev.ko[s]=true; S.stats.kos.push(m.cid); L.push([`${N(m.cid)} is knocked out!`,'k']); } }
    const out0=living(P[0]).length===0, out1=living(P[1]).length===0;
    if (out0&&out1){
      S.stats.mutualFinal=true;
      if (preHP[0]!==preHP[1]){ S.result = preHP[0]>preHP[1]?'WIN':'LOSS'; S.tiebreak=preHP; S.stats.tiebroken=true;
        L.push([`Both last monsters fall together. Tiebreak on HP before impact: ${preHP[0]} vs ${preHP[1]} → <b>${preHP[0]>preHP[1]?'You win':'NPC wins'}</b>.`,'m']); }
      else { S.result='DRAW'; L.push([`Both last monsters fall together with equal HP (${preHP[0]}). It's a draw.`,'m']); }
    }
    else if (out0||out1){ S.result = out1?'WIN':'LOSS'; }
    else {
      for (const s of [0,1]) if (mon(P[s],P[s].active).ko) P[s].pending=true;
      if (S.round>=CFG.ROUND_CAP){
        const a=living(P[0]).length, b=living(P[1]).length; S.capEnd=true;
        S.result = a>b?'WIN':a<b?'LOSS':'DRAW';
        L.push([`Round ${CFG.ROUND_CAP} limit: ${a} vs ${b} monsters standing.`,'m']);
      }
    }
    return { L, ev };
  }

  // ===================== NPC AI (public info only, commits before reading the player's pick) =====================
  function est(att, def, attItem='PASS', defItem='PASS', defSwitchedIn=false){ const r=calcAttack(att,def,{attItem,defItem,defSwitchedIn}); return r.dmg - r.heal; }
  function aiChoose(me, op, prof={diff:'casual', style:null}){
    const D=AI_DIFF[prof.diff]||AI_DIFF.casual, ST=AI_STYLE[prof.style]||{};
    const noise=()=>1-D.noise*1.6+RNG()*D.noise*3.2;
    const choice={action:'PASS'};
    let opMon=mon(op,op.active);
    if (!opMon||opMon.ko) opMon=[...living(op)].sort((a,b)=>CARDS[b.cid].atk-CARDS[a.cid].atk)[0];
    // Skilled AI reasons about Speed: a faster monster that KOs first takes no counter-hit
    const faster = m => D.speed && CARDS[m.cid].spd>CARDS[opMon.cid].spd;
    const slower = m => D.speed && CARDS[m.cid].spd<CARDS[opMon.cid].spd;
    const score = m => { const o=est(m,opMon), i=est(opMon,m); return o*1.2 - ((faster(m)&&o>=opMon.hp)?0:i) + m.hp*0.2 + (D.speed?(CARDS[m.cid].spd-CARDS[opMon.cid].spd)*0.4:0); };
    if (me.pending){ let best=null,bs=-1e9; for (const m of benchOptions(me)){ const sc=score(m)*noise(); if (sc>bs){bs=sc;best=m;} } choice.replace=best.i; }
    const my = me.pending ? me.roster[choice.replace] : mon(me,me.active);
    const max=CARDS[my.cid].hp, out=est(my,opMon);
    const killsFirst = faster(my) && out>=opMon.hp;           // incoming damage never lands
    const inc = killsFirst ? 0 : est(opMon,my);
    const incS = killsFirst ? 0 : est(opMon,my, op.items.STRENGTH?'STRENGTH':'PASS');
    const w={ PASS:1 + (killsFirst?2.5:0) };
    if (my.cid==='wolf' && !my.howl) w.PASS+=0.8;
    if (my.cid==='rgolem' && !my.windup) w.PASS+=0.8;
    if (my.cid==='kalina' && my.land!==S.round && my.land!==S.round+1) w.PASS+=1.2;
    const twOn = me.twUntil>=S.round+1;   // Tailwind still up next round
    if (slower(my) && my.hp<=incS) w.PASS*=0.6;                // about to be KO'd with no reply
    if (me.items.STRENGTH){ const outS=est(my,opMon,'STRENGTH'); w.STRENGTH = 0.6 + (opMon.hp>out && opMon.hp<=outS ? 3 : 0) + (my.cid==='fulgimite'?0.6:0) - (out<=0?0.6:0); }
    if (me.items.GOLEM) w.GOLEM = 0.4 + (my.hp<=incS && incS>0 ? 2.4 : 0) + (my.cid==='carlbero'?0.5:0) - (inc<=0?0.4:0);
    if (me.items.REMEDY) w.REMEDY = my.hp>=max-1 ? 0 : 0.3 + (my.hp<=max/2?1.8:0) + (my.hp<=incS && my.hp+CFG.REMEDY>incS ? 1.2 : 0) + (my.cid==='kirin'?0.4:0);
    if (me.items.SMOKE) w.SMOKE = 0.1 + (op.items.GOLEM && opMon.hp<=out+1 && out>0 ? 2 : 0);
    if (me.items.CAFE){ const ms=CARDS[my.cid].spd, os=CARDS[opMon.cid].spd; w.CAFE = 0.2 + (ms<4 && ms+1>os && ms<=os && out>=opMon.hp ? 2.6 : 0) + (ms<4 && ms+1===os && my.hp<=incS ? 0.8 : 0); }
    if (me.items.SHARD){ const outX=est(my,opMon,'SHARD'); w.SHARD = 0.3 + Math.max(0,outX-out)*0.9 + (opMon.hp>out && opMon.hp<=outX ? 2 : 0); }
    if (!me.pending){
      const bench=benchOptions(me);
      if (bench.length){
        let best=null,bs=-1e9;
        for (const m of bench){ const ci=est(opMon,m,'PASS','PASS',true); const sc=(est(m,opMon)*1.0 - ci*1.3 + (ci<m.hp?1:-3))*noise(); if (sc>bs){bs=sc;best=m;} }
        const ci=est(opMon,best,'PASS','PASS',true);
        w.SWITCH = 0.08 + (my.hp<=inc && ci<best.hp ? 1.1 : 0) + Math.max(0,(inc-ci))*0.2 + (out<=0?1.5:0) + Math.max(0, est(best,opMon)-out)*0.15;
        if (best.cid==='flame') w.SWITCH += 0.5;
        if (best.cid==='succubus') w.SWITCH += 0.5;
        if (my.cid==='sylph' && twOn && (CFG.TW_ALL || CARDS[best.cid].el==='air')) w.SWITCH += 0.9;   // set up, then switch
        if (op.active!=null && mon(op,op.active).cid==='roo' && mon(op,op.active).steps && mon(op,op.active).steps.t===my.i && mon(op,op.active).steps.n>=2) w.SWITCH += 3;   // dodge the knife
        choice.target=best.i;
      }
    }
    for (const k of Object.keys(w)) w[k]=Math.max(0,w[k])*(ST[k]||1);
    const keys=Object.keys(w).filter(k=>w[k]>0);
    let pick;
    if (RNG()<D.rand+(ST.rand||0)) pick=keys[Math.floor(RNG()*keys.length)];
    else { const ws=keys.map(k=>w[k]*noise()); let tot=ws.reduce((a,b)=>a+Math.max(0,b),0), r=RNG()*tot; pick=keys[keys.length-1]; for (let i=0;i<keys.length;i++){ r-=Math.max(0,ws[i]); if (r<=0){pick=keys[i];break;} } }
    choice.action=pick; if (pick==='SWITCH'&&choice.target==null) choice.action='PASS';
    if (D.lookahead && S) return lookaheadPick(me, op, D, ST, choice);
    return choice;
  }
  // Skilled AI: one-round lookahead. Plays each of its legal moves against every legal opponent move on a copy of the
  // board (public info only: the opponent's move is unknown, so all are weighed equally) and keeps the best average.
  function legalMoves(pl, replace){
    const out=[{action:'PASS', replace}];
    for (const k of Object.keys(pl.items)) if (pl.items[k]) out.push({action:k, replace});
    if (!pl.pending) for (const m of benchOptions(pl)) out.push({action:'SWITCH', target:m.i});
    return out;
  }
  function boardValue(sm, so){ const hp=pl=>pl.roster.reduce((a,m)=>a+(m.ko?0:m.hp),0), ko=pl=>pl.roster.filter(m=>m.ko).length;
    return hp(sm)-hp(so) + 6*(ko(so)-ko(sm)); }
  function lookaheadPick(me, op, D, ST, fallback){
    const si = S.p[0]===me ? 0 : 1;
    const mine = legalMoves(me, fallback.replace);
    const theirs = legalMoves(op, op.pending ? autoPickMonster(op) : undefined);
    const saved=S, v0=boardValue(me, op);
    let best=fallback, bs=-1e9;
    for (const c of mine){
      let tot=0;
      for (const o of theirs){
        const clone=JSON.parse(JSON.stringify(saved)); clone.log=[]; S=clone;
        try { resolveRound(si===0?[c,o]:[o,c]); } catch(e){}
        const sm=clone.p[si], so=clone.p[1-si];
        let v=boardValue(sm, so)-v0;
        if (clone.result){ const won=(clone.result==='WIN')===(si===0); v += clone.result==='DRAW'?0:(won?60:-60); }
        tot+=v; S=saved;
      }
      let sc = tot/theirs.length;
      if (ITEMS[c.action]) sc -= 0.9;                                  // spending a one-use item has a cost
      sc *= 1; sc += ((ST[c.action]||1)-1)*1.5;                         // play-style bias
      sc += (RNG()-0.5)*D.noise*6;                              // decision noise
      if (sc>bs){ bs=sc; best=c; }
    }
    S=saved;
    return { ...best, replace: fallback.replace };
  }
  // AI holding Hina: it knows the other side's card, so it plays the best one-round answer to THAT card
  function foretellPick(state, si, theirs, prof){
    const D=AI_DIFF[prof.diff]||AI_DIFF.casual, pl=state.p[si];
    const moves=[{action:'PASS'}]; for (const k of Object.keys(pl.items)) if (pl.items[k]) moves.push({action:k});
    for (const m of benchOptions(pl)) moves.push({action:'SWITCH', target:m.i});
    const v0=boardValue(state.p[si], state.p[1-si]); let best=moves[0], bs=-1e9;
    for (const c of moves){ const clone=JSON.parse(JSON.stringify(state)); clone.log=[]; const saved=S; S=clone;
      try { resolveRound(si===0?[c,theirs]:[theirs,c]); } catch(e){} S=saved;
      let v=boardValue(clone.p[si], clone.p[1-si])-v0; if (clone.result){ const won=(clone.result==='WIN')===(si===0); v += clone.result==='DRAW'?0:(won?60:-60); }
      if (ITEMS[c.action]) v-=0.9; v += (RNG()-0.5)*D.noise*6;
      if (v>bs){ bs=v; best=c; } }
    return { action:best.action, target:best.target };
  }
  function aiOpening(me, prof={diff:'casual'}){ const sk=(AI_DIFF[prof.diff]||{}).speed; let best=0,bs=-1e9; for (const m of me.roster){ const c=CARDS[m.cid]; const sc=(c.atk*1.4+c.hp*0.35+c.def+(sk?c.spd*0.6:0))*(0.7+RNG()*0.6); if (sc>bs){bs=sc;best=m.i;} } return best; }
  // v0.5 timeout auto-pick: highest current HP, then highest max HP, then roster order (deterministic)
  function autoPickMonster(pl){ const c=pl.roster.filter(m=>!m.ko && m.i!==pl.active); c.sort((a,b)=>(b.hp-a.hp)||(CARDS[b.cid].hp-CARDS[a.cid].hp)||(a.i-b.i)); return c[0].i; }

  // ===================== match flow (pure state machine) =====================
  const withState = (state, fn) => { const prev = S; S = state; try { return fn(); } finally { S = prev; } };
  const blankStats = () => ({ acts:[{},{}], switches:[0,0], forced:[0,0], kos:[], aff:{}, zero:{ bothSwitch:0, noHpLost:0, healedBack:0 } });
  const isLegalTeam = ids => Array.isArray(ids) && ids.length === CFG.TEAM && new Set(ids).size === ids.length
    && ids.every(id => CARDS[id] && !CARDS[id].retired) && teamCost(ids) <= CFG.BUDGET;

  const Match = {
    create({ teams, names = null } = {}){
      if (!teams || teams.length !== 2) throw new Error('Fabula Arcana: two teams required');
      for (const t of teams) if (!isLegalTeam(t)) throw new Error('Fabula Arcana: illegal team ' + JSON.stringify(t));
      return { v:1, phase:'opening', round:0, p:[mkPlayer(teams[0]), mkPlayer(teams[1])], names,
        commit:[null,null], result:null, capEnd:false, tiebreak:null, stats:blankStats(), log:[] };
    },
    needs(state, seat){
      if (state.phase === 'ended') return false;
      if (state.commit[seat]) return false;
      if (state.phase === 'replace') return !!state.p[seat].pending;
      if (foretellSeat(state) === seat && !state.commit[1 - seat]) return false;   // Foretell: the other side chooses first
      return true;
    },
    validate(state, seat, c){
      if (!c || typeof c !== 'object') return 'no choice';
      if (state.phase === 'ended') return 'match over';
      if (!Match.needs(state, seat)) return 'nothing to choose now';
      const pl = state.p[seat];
      if (state.phase === 'opening'){ const m = pl.roster[c.replace]; return m && !m.ko ? null : 'pick one of your monsters'; }
      if (state.phase === 'replace'){ const m = pl.roster[c.replace]; return m && !m.ko && m.hp > 0 && m.i !== pl.active ? null : 'pick a living benched monster'; }
      if (c.action === 'PASS') return null;
      if (c.action === 'SWITCH'){ const m = pl.roster[c.target]; return m && !m.ko && m.i !== pl.active ? null : 'switch to a living benched monster'; }
      if (ITEMS[c.action]) return pl.items[c.action] ? null : 'item already used';
      return 'unknown action';
    },
    submit(state, seat, c){
      const err = Match.validate(state, seat, c); if (err) return { ok:false, error:err };
      state.commit[seat] = state.phase === 'choose' ? { action:c.action, target: c.action === 'SWITCH' ? c.target : undefined } : { replace:c.replace };
      if ([0,1].some(s => Match.needs(state, s))) return { ok:true };
      return { ok:true, resolved: resolve(state) };
    },
    autoChoice(state, seat){
      const pl = state.p[seat];
      if (state.phase === 'opening' || state.phase === 'replace') return { replace: autoPickMonster(pl) };
      return { action:'PASS' };
    },
    aiChoice(state, seat, prof = { diff:'casual', style:null }){
      return withState(state, () => {
        const me = state.p[seat], op = state.p[1 - seat];
        if (state.phase === 'opening') return { replace: aiOpening(me, prof) };
        if (state.phase === 'replace') return { replace: aiChoose(me, op, prof).replace };
        if (foretellSeat(state) === seat && state.commit[1 - seat]) return foretellPick(state, seat, state.commit[1 - seat], prof);
        const c = aiChoose(me, op, prof); return { action:c.action, target:c.target };
      });
    },
    // Surrender: the conceding seat loses this game at once (any phase except ended).
    concede(state, seat){
      if (state.phase === 'ended') return false;
      state.result = seat === 0 ? 'LOSS' : 'WIN'; state.surrendered = seat; state.phase = 'ended'; state.commit = [null, null];
      state.log.unshift({ head:'SURRENDER', lines:[[`${seatLabel(state, seat)} surrender${third(state, seat)?'s':''}.`, 'k']] });
      return true;
    },
    publicView(state, viewer){
      const v = JSON.parse(JSON.stringify(state));
      const fs = foretellSeat(state);   // the Foretelling seat sees the other side's card
      v.commit = v.commit.map((c, s) => c && s !== viewer && !(viewer === fs && s === 1 - fs) ? { hidden:true } : c);
      return v;
    },
  };

  function resolve(state){
    const C = state.commit; let out;
    if (state.phase === 'opening'){
      for (const s of [0,1]) state.p[s].active = C[s].replace;
      const L = [[`${seatLabel(state,0)} open${third(state,0)?'s':''} with ${N(state.p[0].roster[state.p[0].active].cid)}. ${seatLabel(state,1)} open${third(state,1)?'s':''} with ${N(state.p[1].roster[state.p[1].active].cid)}.`, '']];
      state.log.unshift({ head:'OPENING', lines:L }); state.round = 1; state.phase = 'choose';
      out = { kind:'opening', choices:C, L };
    } else if (state.phase === 'replace'){
      const L = [];
      for (const s of [0,1]) if (state.p[s].pending && C[s]){ const pl = state.p[s]; pl.active = C[s].replace; pl.pending = false; state.stats.forced[s]++;
        L.push([`${seatLabel(state,s)} send${third(state,s)?'s':''} in ${N(pl.roster[pl.active].cid)}.`, 'm']); }
      state.log.unshift({ head:'REPLACEMENT', lines:L }); state.round++; state.phase = 'choose';
      out = { kind:'replace', choices:C, L };
    } else {
      const r = withState(state, () => resolveRound([C[0], C[1]]));
      state.log.unshift({ head:`ROUND ${state.round} · ${seatLabel(state,0)}: ${ACT_T[C[0].action]} · ${seatLabel(state,1)}: ${ACT_T[C[1].action]}`, lines:r.L });
      if (state.result) state.phase = 'ended';
      else if (state.p[0].pending || state.p[1].pending) state.phase = 'replace';
      else { state.round++; state.phase = 'choose'; }
      out = { kind:'round', choices:C, L:r.L, ev:r.ev };
    }
    state.commit = [null, null];
    return out;
  }
  const seatLabel = (state, s) => (state.names && state.names[s]) || (s === 0 ? 'You' : 'NPC');
  const third = (state, s) => !!(state.names && state.names[s]) || s === 1;

  const Series = {
    create(bestOf = 1){ const b = [1,3,5].includes(bestOf) ? bestOf : 1; return { bestOf:b, need:Math.ceil(b/2), wins:[0,0], draws:0, game:0, over:false, winner:null }; },
    record(sr, result){
      if (result === 'WIN') sr.wins[0]++; else if (result === 'LOSS') sr.wins[1]++; else sr.draws++;
      sr.game++;
      if (sr.wins[0] >= sr.need){ sr.over = true; sr.winner = 0; } else if (sr.wins[1] >= sr.need){ sr.over = true; sr.winner = 1; }
      return sr;
    },
  };

  // ===================== seat views (every player sees the board from seat 0) =====================
  // The duel window always draws "you" at the bottom (seat 0). For the player in seat 1 the host mirrors
  // the state and each resolved round: two-sided arrays swap, side numbers flip, WIN/LOSS swap.
  const flip = s => (s === 0 ? 1 : s === 1 ? 0 : s);
  const swap2 = a => (Array.isArray(a) && a.length === 2 ? [a[1], a[0]] : a);
  const flipResult = r => (r === 'WIN' ? 'LOSS' : r === 'LOSS' ? 'WIN' : r);
  const View = {
    // state as seen by `viewer` (0, 1, or null for spectators: seat-0 perspective, both picks hidden)
    forSeat(state, viewer){
      const v = Match.publicView(state, viewer);
      if (viewer !== 1) return v;
      v.p = swap2(v.p); v.commit = swap2(v.commit); v.names = v.names ? swap2(v.names) : v.names;
      v.result = flipResult(v.result); v.tiebreak = v.tiebreak ? swap2(v.tiebreak) : v.tiebreak;
      if (v.surrendered != null) v.surrendered = flip(v.surrendered);
      const st = v.stats || {}; for (const k of ['acts','switches','forced']) if (st[k]) st[k] = swap2(st[k]);
      return v;
    },
    // a resolved step ({ kind, choices, L, ev }) as seen by `viewer`
    resolvedForSeat(res, viewer){
      const r = JSON.parse(JSON.stringify(res));
      if (viewer !== 1) return r;
      r.choices = swap2(r.choices);
      const ev = r.ev; if (!ev) return r;
      for (const k of ['enter','switched','items','heal','res','after','ko']) if (ev[k]) ev[k] = swap2(ev[k]);
      for (const x of ev.res || []) if (x && x.side != null) x.side = flip(x.side);
      if (ev.seq) ev.seq = ev.seq.map(flip);
      if (ev.snaps) ev.snaps = ev.snaps.map(swap2);
      if (ev.denied != null) ev.denied = flip(ev.denied);
      for (const k of ['direct','entry']) for (const x of ev[k] || []) if (x && x.s != null) x.s = flip(x.s);
      return r;
    },
    seriesForSeat(sr, viewer){
      if (!sr) return sr; const s = JSON.parse(JSON.stringify(sr));
      if (viewer === 1){ s.wins = swap2(s.wins); if (s.winner != null) s.winner = flip(s.winner); }
      return s;
    },
  };

  const Engine = Object.freeze({
    Match, Series, View, foretellSeat, IDS, LEGAL_TEAMS, isLegalTeam, teamCost, compKey, randomTeam, elMod,
    setRng(fn){ RNG = typeof fn === 'function' ? fn : Math.random; },
    // low-level hooks for tests and the balance tool (run inside a state)
    _withState: withState, _resolveRound: ch => resolveRound(ch), _calcAttack: (a, d, ctx) => calcAttack(a, d, ctx), _mkPlayer: mkPlayer,
    _aiChoose: (me, op, prof) => aiChoose(me, op, prof), _aiOpening: (me, prof) => aiOpening(me, prof), _autoPickMonster: pl => autoPickMonster(pl), _benchOptions: pl => benchOptions(pl),
  });
  globalThis.FabulaArcana = globalThis.FabulaArcana || {};
  globalThis.FabulaArcana.Engine = Engine;
})();
