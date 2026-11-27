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
 *   .Match.create({ teams:[ids,ids], names?:[a,b], format? })   → match state (plain JSON-safe object)
 *   .Match.needs(state, seat)                          → this seat must commit in the current phase
 *   .Match.validate(state, seat, choice)               → null | error string
 *   .Match.submit(state, seat, choice)                 → { ok, error?, resolved? }  (resolves when every needed seat committed)
 *   .Match.autoChoice(state, seat)                     → timeout choice (auto-pick highest HP / auto-Pass)
 *   .Match.aiChoice(state, seat, prof)                 → AI choice (public info only; never reads the other commit)
 *   .Match.publicView(state, viewerSeat|null)          → copy with hidden commits masked (null = spectator)
 *   .Series.create(bestOf) / .Series.record(series, result) → Best of 1/3/5 bookkeeping (draws are replayed)
 *   .setRng(fn) / .teamCost(ids) / .isLegalTeam(ids, format?) / .randomTeam() / .IDS / .LEGAL_TEAMS
 *   .Format: { STANDARD, CUPS, norm(f), fits(ids, f), allowed(cid, f), legalTeams(ids, f), summary(f), why(owned, f) }
 *     match rules the challenger sets (PvP). mode 'standard' = CFG.BUDGET★ budget · 'open' = no budget ·
 *     'cup' = Constellation: the three cards match a star pattern (pat: three slots, 1/2/3 or 0 = any).
 *     mirror false = a card on both teams clashes (the host strikes it, both re-pick). chars false = no character cards.
 *     No format = STANDARD, so NPC duels, practice, drops and starter gifts are unchanged.
 *
 * Choices:  opening/replace phase → { replace: rosterIndex }     choose phase → { action, target? }
 *           action ∈ PASS | SWITCH | STRENGTH | GOLEM | REMEDY | SMOKE | SHARD | CAFE
 */
(() => {
  const { CFG, AI_DIFF, AI_STYLE, EL, BEATS, CARDS, ITEMS, ACT_T } = globalThis.FabulaArcana.Catalog;
  let RNG = Math.random;
  let S = null;                       // the match being resolved (set by withState)

  // Keren's Fox Fire stack: every KO'd card in the match except herself (both rosters), × CFG.FOXFIRE, capped
  const foxFire = m => { if (!S || !m || m.cid!=='keren') return 0; let n=0; for (const pl of S.p) for (const x of pl.roster) if (x!==m && x.ko) n++; return Math.min(CFG.FOXFIRE_CAP, n*CFG.FOXFIRE); };
  const sideOf = m => S && S.p ? S.p.findIndex(p=>p.roster.includes(m)) : -1;
  // this round's SPD while a round resolves; printed SPD otherwise (AI estimates)
  const spdNow = m => { const s=sideOf(m); return (S && S._sp && S._spRound===S.round && s>=0 && S.p[s].roster[S.p[s].active]===m) ? S._sp[s] : CARDS[m.cid].spd; };
  const berserk = m => !!m && m.cid==='jill' && m.hp*2 <= CARDS.jill.hp && m.hp>0;
  const twinDown = (m, other) => { const s=sideOf(m); return s>=0 && S.p[s].roster.some(x=>x.cid===other && x.ko); };
  // Geist's Blackest Night: the first time he would reach 0 HP (any source, active or benched) he rises at full HP; overflow is lost.
  // After rising he has +GEIST_BN ATK for the rest of the match (calcAttack).
  function bnCheck(m, ev, L){ if (m && m.cid==='geist' && m.hp<=0 && !m.ko && !m.bn){ m.bn=true; m.hp=CARDS.geist.hp; S.stats.bn=(S.stats.bn||0)+1;
    (ev.revive=ev.revive||[]).push({ s: S.p[0].roster.includes(m)?0:1, i:m.i });
    L.push(['The Blackest Night: Geist rises again at full HP!','g']); } }
  // Kalina's hop target when the commit named none (or a card that is no longer there): the benched ally that takes the least
  // from the enemy's attack this round; with no enemy standing, the healthiest one.
  function hopPick(s, bench){ const o=mon(S.p[1-s],S.p[1-s].active), live=!!o && !o.ko && o.hp>0;
    return [...bench].sort((x,y)=> (live ? est(o,x,'PASS','PASS',true)-est(o,y,'PASS','PASS',true) : 0) || (y.hp-x.hp) || (x.i-y.i))[0].i; }
  // Kalina's Skyfall Dive: switched in (by choice or after a KO) with Dive Ready = CFG.DIVE damage to the enemy active card (ignores DEF and items)
  function diveIn(s, how, ev, L){ const P=S.p, k=mon(P[s],P[s].active); if (!k || k.cid!=='kalina' || !k.dive) return null; k.dive=false;
    const t=mon(P[1-s],P[1-s].active); if (!t || t.ko || t.hp<=0 || P[1-s].pending) return null;
    const b=t.hp; t.hp=Math.max(0,t.hp-CFG.DIVE); const d={ s, i:k.i, t:1-s, ti:t.i, amt:b-t.hp, from:b, how }; (ev.dive=ev.dive||[]).push(d);
    S.stats.dive=(S.stats.dive||0)+1; L.push([`Skyfall Dive: Kalina drops on ${N(t.cid)} for ${d.amt} damage (${t.hp} HP).`,'']);
    bnCheck(t, ev, L); return d; }
  // ===================== hand model v2 (2026-11-25) =====================
  // pl.items holds a COUNT per card key (old states hold 0/1/true, which read the same). The six base items start at 1;
  // created cards (ITEMS[k].created) only arrive through addToHand and leave the hand when their count hits 0.
  // The hand holds at most CFG.HAND_MAX cards; a card created into a full hand fizzles.
  const BASE_ITEMS = Object.keys(ITEMS).filter(k=>!ITEMS[k].created);
  const cnt = (pl, k) => Number(pl && pl.items && pl.items[k]) || 0;
  const handSize = pl => Object.keys(pl.items||{}).reduce((a,k)=>a+cnt(pl,k),0);
  const fxOf = k => (ITEMS[k] && ITEMS[k].fx) || null;
  function addToHand(state, s, k, n=1, src=null, L=null, ev=null){
    const pl=state.p[s]; n=Math.max(1, Math.floor(Number(n)||1));
    if (!ITEMS[k]) return { s, k, n:0, fizzled:n, src };
    const room=Math.max(0,(CFG.HAND_MAX||8)-handSize(pl)), add=Math.min(n,room), fizzled=n-add;
    if (add) pl.items[k]=cnt(pl,k)+add;
    const rec={ s, k, n:add, fizzled, src };
    if (ev) (ev.added=ev.added||[]).push(rec);
    state.stats.added=(state.stats.added||0)+add;
    if (L){ const by = src ? `${src} creates` : `${seatLabel(state,s)} get${third(state,s)?'s':''}`;
      if (add) L.push([`${by} ${ITEMS[k].t}${add>1?` ×${add}`:''}.`,'g']);
      if (fizzled) L.push([`Hand full: ${ITEMS[k].t}${fizzled>1?` ×${fizzled}`:''} fizzles.`,'m']); }
    return rec;
  }
  // a used base item back to 1 (Hako); created cards are never restocked
  function restoreItem(state, s, k){ const pl=state.p[s]; if (!BASE_ITEMS.includes(k) || cnt(pl,k)) return false; pl.items[k]=1; return true; }
  // Hako's Trusty Supplier: at the start of a round, while Hako is the active card and SUPPLY_MIN+ item cards are used up,
  // one of them (random) comes back to the hand.
  function supplyStep(state, L){ const out=[];
    for (const s of [0,1]){ const pl=state.p[s], m=pl.active==null?null:pl.roster[pl.active]; if (!m || m.cid!=='hako' || m.ko || m.hp<=0) continue;
      const spent=BASE_ITEMS.filter(k=>!cnt(pl,k)); if (spent.length<CFG.SUPPLY_MIN) continue;
      const k=spent[Math.floor(RNG()*spent.length)]; restoreItem(state, s, k); state.stats.supply=(state.stats.supply||0)+1; out.push({ s, k });
      L.push([`Trusty Supplier: Hako restocks ${ITEMS[k].t} for ${seatLabel(state,s)}.`,'g']); }
    return out; }
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
             active:null, items:Object.fromEntries(BASE_ITEMS.map(k=>[k,1])), pending:false };
  }
  const mon = (pl, idx) => idx==null ? null : pl.roster[idx];
  const living = pl => pl.roster.filter(m=>!m.ko);
  const benchOptions = pl => pl.roster.filter(m => !m.ko && m.i!==pl.active);
  const teamCost = ids => ids.reduce((a,id)=>a+CARDS[id].cost,0);
  const LEGAL_TEAMS = (()=>{ const out=[]; for (let a=0;a<IDS.length;a++) for (let b=a+1;b<IDS.length;b++) for (let c=b+1;c<IDS.length;c++){ const t=[IDS[a],IDS[b],IDS[c]]; if (teamCost(t)<=CFG.BUDGET) out.push(t); } return out; })();
  const RANDOM_TEAMS = LEGAL_TEAMS.filter(t => !t.some(id => CARDS[id].noRandom));   // noRandom cards (Valley trio) never in a random team
  const randomTeam = () => shuffle(RANDOM_TEAMS[Math.floor(RNG()*RANDOM_TEAMS.length)]);
  const compKey = ids => ids.map(id=>CARDS[id].cost).sort((a,b)=>b-a).join('+');
  // ===================== rules engine (v0.2) =====================
  // ctx: {attItem, defItem, defSwitchedIn}
  // a card's element right now: elEven = its element on even rounds (Deva, 11-27)
  const elOf = m => { const c=CARDS[m.cid]; return (c.elEven && S && S.round%2===0) ? c.elEven : c.el; };
  function calcAttack(att, def, ctx){
    const A={...CARDS[att.cid], el:elOf(att)}, D={...CARDS[def.cid], el:elOf(def)};
    const ael = ctx.attItem==='SHARD' ? 'none' : A.el;
    let atk = A.atk; const parts=[`${A.atk} ATK`];
    if ((att.ser||0)>=S.round){ atk+=CFG.SERENADE; parts.push(`+${CFG.SERENADE} Love Serenade`); }
    { const ba=CFG.BREATH_ATK ?? 1; if ((att.breath||0)>=S.round && ba){ atk=Math.max(0,atk-ba); parts.push(`−${ba} Stinking Breath`); } }
    if (berserk(att)){ atk+=CFG.BERSERK_ATK; parts.push(`+${CFG.BERSERK_ATK} Berserk`); }
    if (att.cid==='jack' && twinDown(att,'jill')){ atk+=CFG.TWIN; parts.push(`+${CFG.TWIN} Twin`); }
    if (att.cid==='jill' && twinDown(att,'jack')){ atk+=CFG.TWIN; parts.push(`+${CFG.TWIN} Twin`); }
    if (att.cid==='keren'){ const ff=foxFire(att); if (ff){ atk+=ff; parts.push(`+${ff} Fox Fire`); } }
    if (att.cid==='geist' && att.bn && CFG.GEIST_BN){ atk+=CFG.GEIST_BN; parts.push(`+${CFG.GEIST_BN} Blackest Night`); }
    if (att.cid==='raubens' && (att.loot||0)>0){ atk+=att.loot; parts.push(`+${att.loot} Bandit King`); }
    if (ctx.attItem==='STRENGTH'){ atk+=CFG.STR+(att.cid==='seigfried'?CFG.DECREE:0); parts.push(`+${CFG.STR} Strength`); }
    if (ctx.attItem==='SHARD'){ atk+=CFG.SHARD+(att.cid==='seigfried'?CFG.DECREE:0); parts.push(`+${CFG.SHARD} Shard`); }
    { const fx=fxOf(ctx.attItem); if (fx && fx.atk){ atk+=fx.atk; parts.push(`+${fx.atk} ${ITEMS[ctx.attItem].t}`); } }   // created cards
    const pyre = att.cid==='pyrefly' && ((att.burn||{})[def.i]||0)>=CFG.PYRE_N; if (pyre){ atk+=CFG.PYRE_BURST; parts.push(`+${CFG.PYRE_BURST} Funeral Pyre`); }
    const kcharge = att.cid==='kirin' && !!(att.chg && att.chg[S.round]); if (kcharge){ atk+=CFG.KCHARGE; parts.push(`+${CFG.KCHARGE} Lightning Charge`); }
    if (att.cid==='gigas' && D.def>=1){ atk+=1; parts.push('+1 Crushing Blow'); }
    if (att.cid==='jack' && ITEMS[ctx.defItem]){ atk+=CFG.THIEF_BOW; parts.push(`+${CFG.THIEF_BOW} Thief Bow`); }
    if (att.cid==='manaray' && ITEMS[ctx.defItem]){ atk+=1; parts.push('+1 Mana Catcher'); }
    if (att.cid==='hellhound' && def.hp*2<=D.hp){ atk+=1; parts.push('+1 On the Hunt'); }
    if (att.cid==='roper' && ctx.defSwitchedIn){ atk+=1; parts.push('+1 Entangle'); }
    const howl = att.cid==='wolf' && !!att.howl; if (howl){ atk+=1; parts.push('+1 Howl'); }
    if ((att.charm||0)>=S.round){ atk=Math.max(0,atk-CFG.CHARM); parts.push(`−${CFG.CHARM} Charm`); }
    if (att.cid==='asura'){ const mk=Math.min(CFG.ASCENSION_MAX,(att.marks||[]).length); if (mk){ atk+=mk; parts.push(`+${mk} Ascension`); } }
    if (att.cid==='deva' && S.round%2===0 && CFG.DISCIPLINE){ atk+=CFG.DISCIPLINE; parts.push(`+${CFG.DISCIPLINE} Celestial Discipline`); }
    const head = `${parts.join(' ')} = ${atk} ${EL[ael]}`;
    // absorption ability: checked before damage (fires even if Guard would zero it)
    if (D.absorb && D.absorb===ael && !def.abilityUsed)
      return { dmg:0, heal:CFG.AB_HEAL, aff:'AB', line:`${head} · ${N(def.cid)}'s <b>${D.ab}</b> negates it (+${CFG.AB_HEAL} HP)`, usedAbsorb:true, howl, pyre, kcharge, ael };
    // Smoke Bomb (11-15): this attack ignores DEF — printed and Golem Fragment's +3
    const smoke = ctx.attItem==='SMOKE', golem = ctx.defItem==='GOLEM';
    const slip = def.cid==='gryphon' && spdNow(att) < spdNow(def);
    const pdef = Math.max(0, Math.max(0, D.def-(def.armorBreak||0)) + (def.cid==='guy' ? Math.min(CFG.TRAVELER_MAX, def.stay||0) : 0) + ((def.lc||0)>=S.round ? CFG.LAST_CALL : 0) + ((def.ser||0)>=S.round ? (CFG.SERENADE_DEF ?? CFG.SERENADE) : 0) - ((def.breath||0)>=S.round ? 1 : 0) + (slip ? CFG.SLIPSTREAM : 0));
    // batch 4 (11-16): Null Guard (opponent used an item), Heavy Armor (opponent Passed), Rival (+1 once the rival ally fell),
    // Bruce V's Teleportation Strike (ignores 2 DEF, Golem Fragment's +3 included). Smoke Bomb still ignores all of it.
    // Golem Fragment (11-17 rule): a real +GOLEM DEF this round, so like any DEF it can only bring a hit down to 1 (no more blocks to 0).
    const nullG = def.cid==='nullis' && ITEMS[ctx.attItem] ? CFG.NULL_GUARD : 0, heavy = def.cid==='gardner' && ctx.attItem==='PASS' ? CFG.HEAVY_ARMOR : 0;
    const rival = (def.cid==='nullis' && twinDown(def,'gardner')) || (def.cid==='gardner' && twinDown(def,'nullis')) ? CFG.RIVAL : 0;
    const gdef = golem ? CFG.GOLEM + (def.cid==='seigfried'?CFG.DECREE:0) : 0;
    const fdef = (fxOf(ctx.defItem)||{}).def || 0;   // a created card's DEF this round (works like Golem Fragment: Smoke ignores it)
    const disc = def.cid==='deva' && S.round%2===1 ? CFG.DISCIPLINE : 0;
    const tdef = pdef + disc + nullG + heavy + rival + gdef + fdef, pierce = att.cid==='brucev' && !smoke ? Math.min(CFG.PIERCE, tdef) : 0;
    const ddef = smoke ? 0 : tdef - pierce;
    const defNotes = smoke ? '' : [disc ? `Celestial Discipline +${disc}` : '', gdef ? `Golem Fragment +${gdef}` : '', fdef ? `${ITEMS[ctx.defItem].t} +${fdef}` : '', nullG ? `Null Guard +${nullG}` : '', heavy ? `Heavy Armor +${heavy}` : '', rival ? `Rival +${rival}` : ''].filter(Boolean).join(', ');
    let d = Math.max(1, atk - ddef); let line = head + (ddef?` − DEF ${ddef}`:'') + (defNotes ? ` (${defNotes})` : '') + (smoke && tdef ? ' · <b>Smoke Bomb</b> ignores DEF' : '') + (pierce ? ` · <b>Teleportation Strike</b> ignores ${pierce} DEF` : '') + (slip && ddef ? ' (Slipstream +' + CFG.SLIPSTREAM + ')' : '') + ` = ${d}`;
    const mod = elMod(ael, D.el); let aff = ael==='none' ? 'NONE' : 'N';
    if (mod>0){ d=Math.max(1,d+mod); aff='ADV'; line+=` · <b>Weak</b>: ${EL[D.el]} takes +${mod} from ${EL[ael]} = ${d}`; }
    if (mod<0){ d=Math.max(1,d+mod); aff='DIS'; line+=` · <b>Resist</b>: ${EL[D.el]} takes −${-mod} from ${EL[ael]} = ${d}`; }
    // Roo (playtest 11-14): its ordinary attacks deal nothing (no min-1 floor, no element bonus); only the knife hurts.
    // Zeroed BEFORE shields so a Roo poke never spends Thick Skin / Pyrophagy / Earthen Wire.
    if (att.cid==='roo' && d>0){ d=0; line+=' · Roo does not hurry: 0'; }
    const red=[]; let r=0; if (berserk(def)){ r-=CFG.BERSERK_TAKE; red.push(`Berserk +${CFG.BERSERK_TAKE} taken`); }
    if (golem && smoke) red.push('Golem Fragment pierced by Smoke Bomb');
    if (def.cid==='broo' && ctx.defSwitchedIn){ r+=2; red.push('Soft Landing −2'); }
    if (def.cid==='fulgimite' && ctx.defSwitchedIn){ r+=2; red.push('Evasion −2'); }
    if (def.cid==='albero'){ const ds=sideOf(def); if (ds>=0 && living(S.p[ds]).length < living(S.p[1-ds]).length){ r+=CFG.ELDER; red.push('Village Elder −'+CFG.ELDER); } }
    if (def.cid==='rakshasa' && CFG.WEAPON_READ && def.readBy===att.cid){ r+=CFG.WEAPON_READ; red.push('Weapon Read −'+CFG.WEAPON_READ); }
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
    // Love Serenade: every benched ally of side s gets +SERENADE ATK/DEF for the next SERENADE_ROUNDS rounds
    const serenade = (s, why) => { const pl=P[s]; const got=[]; for (const m of pl.roster) if (!m.ko && m.hp>0 && m.i!==pl.active){ m.ser=S.round+CFG.SERENADE_ROUNDS; got.push(m.i); }
      if (got.length){ S.stats.ser=(S.stats.ser||0)+1; (ev.serenade=ev.serenade||[]).push({ s, is:got }); L.push([`Love Serenade: ${got.map(i=>N(pl.roster[i].cid)).join(' and ')} get +${CFG.SERENADE} ATK / +${CFG.SERENADE} DEF for ${CFG.SERENADE_ROUNDS} rounds.`,'g']); } };
    const BN = m => bnCheck(m, ev, L);
    // Kalina's Skyfall Dive (11-17): after her attack she hops out (forced while a benched ally lives; the commit's `hop` names who
    // steps in). The card stepping in counts as switched in and takes the enemy's attack if Kalina struck first. She gets Dive Ready.
    const hopIn=[false,false];
    const tryHop = s => { const pl=P[s], k=mon(pl,pl.active), r=ev.res[s];
      if (!r || r.a!==k || k.cid!=='kalina' || k.hp<=0 || k.ko) return; const bench=benchOptions(pl).filter(m=>m.hp>0); if (!bench.length) return;
      const t = bench.some(m=>m.i===ch[s].hop) ? ch[s].hop : hopPick(s, bench);
      k.dive=true; pl.active=t; hopIn[s]=true; S.stats.hop=(S.stats.hop||0)+1; (ev.hop=ev.hop||[]).push({ s, from:k.i, to:t, at: ev.seq ? ev.seq.length : null });
      L.push([`Kalina hops out after her attack; ${N(mon(pl,t).cid)} steps in. Dive Ready.`,'m']); };
    const who = s => (S.names && S.names[s]) || (s===0?'You':'NPC'); const third = s => !!(S.names && S.names[s]) || s===1;
    for (const s of [0,1]) if (P[s].pending){
      P[s].active=ch[s].replace; P[s].pending=false; if (P[s].lastCall){ mon(P[s],P[s].active).lc=S.round+1; P[s].lastCall=false; L.push(['Last Call: the card sent in gets +'+CFG.LAST_CALL+' DEF for 2 rounds.','g']); } S.stats.forced[s]++; ev.enter[s]='forced';
      L.push([`${who(s)} send${third(s)?'s':''} in ${N(mon(P[s],P[s].active).cid)}.`,'m']);
    }
    for (const s of [0,1]) if (ch[s].action==='SWITCH'){
      const out=mon(P[s],P[s].active); if (CFG.ROO_BENCH===2 && out.cid==='roo' && out.walk){ out.walk=0; L.push(['Roo leaves the field and loses its steps.','m']); }
      if (out.cid==='hilde' && (CFG.GRACE_MODE||0)===2 && out.hp>0){ const inc=mon(P[s],ch[s].target); if (inc && inc.hp<CARDS[inc.cid].hp){ const was=inc.hp; inc.hp=Math.min(CARDS[inc.cid].hp, inc.hp+CFG.GRACE_HEAL); S.stats.grace=(S.stats.grace||0)+(inc.hp-was);
        (ev.grace=ev.grace||[]).push({ s, heals:[{ i:inc.i, amt:inc.hp-was }] }); L.push([`Royal Grace: Princess Hilde steps back and tends to ${N(inc.cid)} (+${inc.hp-was} HP).`,'g']); } }
      if (out.cid==='love' && (CFG.SERENADE_MODE||1)===2 && out.hp>0){ const inc=mon(P[s],ch[s].target); if (inc){ inc.ser=S.round+CFG.SERENADE_ROUNDS; S.stats.ser=(S.stats.ser||0)+1;
        (ev.serenade=ev.serenade||[]).push({ s, is:[inc.i] }); L.push([`Love Serenade: Love hands the stage to ${N(inc.cid)} (+${CFG.SERENADE} ATK / +${CFG.SERENADE_DEF ?? CFG.SERENADE} DEF for ${CFG.SERENADE_ROUNDS} rounds).`,'g']); } }
      if (out.cid==='alcina' && out.hp>0 && !out.stew){ out.stew=true; addToHand(S, s, 'STEW', 1, 'Alcina', L, ev); }
      out.stay=0;
      P[s].active=ch[s].target; ev.switched[s]=true; ev.enter[s]='switch'; S.stats.switches[s]++;
      if (P[s].lastCall){ mon(P[s],P[s].active).lc=S.round+1; P[s].lastCall=false; L.push(['Last Call: the card switched in gets +'+CFG.LAST_CALL+' DEF for 2 rounds.','g']); }
      L.push([`${who(s)} switch${third(s)?'es':''} ${N(out.cid)} out for ${N(mon(P[s],P[s].active).cid)}. It skips its attack.`,'m']);
    }
    for (const s of [0,1]) if ((CFG.SERENADE_MODE||1)===1 && ev.switched[s] && mon(P[s],P[s].active).cid==='love') serenade(s, 'entry');
    for (const s of [0,1]) if (ev.switched[s]){ const w=mon(P[s],P[s].active); if (w.cid==='willy' && !w.curio){ w.curio=true; addToHand(S, s, 'LUCKY', 1, 'Willy', L, ev); } }
    for (const s of [0,1]) if (ev.switched[s] && mon(P[s],P[s].active).cid==='succubus'){ const t=mon(P[1-s],P[1-s].active); if (t && t.hp>0){ t.charm=S.round+1; S.stats.charm=(S.stats.charm||0)+1; L.push([`Charm: ${N(t.cid)} is Charmed (−${CFG.CHARM} ATK this round and next).`,'m']); } }
    for (const s of [0,1]) if (ev.switched[s] && mon(P[s],P[s].active).cid==='flame'){ const t=mon(P[1-s],P[1-s].active); if (t && t.hp>0){ const b=t.hp; t.hp=Math.max(0,t.hp-CFG.ENTRY); BN(t); (ev.entry=ev.entry||[]).push({s:1-s,amt:b-t.hp}); S.stats.entry=(S.stats.entry||0)+1;
        L.push([`Dynamic Entry: Wandering Flame bursts in, ${b-t.hp} Fire damage to ${N(t.cid)} (${t.hp} HP).`,'']); } }
    for (const s of [0,1]) if (ev.switched[s]) diveIn(s, 'switch', ev, L);
    for (const s of [0,1]){ const a=ch[s].action; S.stats.acts[s][a]=(S.stats.acts[s][a]||0)+1;
      if (ITEMS[a]){ P[s].items[a]=Math.max(0,cnt(P[s],a)-1); if (ITEMS[a].created && !P[s].items[a]) delete P[s].items[a]; ev.items[s]=a; } }
    // Raubens' Bandit King: an item used while he is the opposing active card = +1 ATK for the rest of the match (counts this round)
    for (const s of [0,1]) if (ITEMS[ch[s].action]){ const r=mon(P[1-s],P[1-s].active); if (r && r.cid==='raubens' && r.hp>0){ r.loot=(r.loot||0)+1; S.stats.loot=(S.stats.loot||0)+1;
      L.push([`Bandit King: Raubens takes his cut of the ${ITEMS[ch[s].action].t} (+1 ATK, now +${r.loot}).`,'m']); } }
    // Howl / Wind Up timing, per card (CFG.HOWL_NEXT / CFG.WINDUP_NEXT): 0 = armed on the Pass and used by that same round's
    // attack; 1 = armed at the END of the round it Passed, so it powers the NEXT attack (visible for a whole decision; can stack
    // with an item); 2 = ability off (balance sims only). Live rules (2026-11-14 sim): Wolf 0, Rock Golem 1.
    const armNext = m => (m.cid==='wolf' && CFG.HOWL_NEXT===1) || (m.cid==='rgolem' && CFG.WINDUP_NEXT===1);
    for (const s of [0,1]) if (ch[s].action==='PASS' && armNext(mon(P[s],P[s].active))) (ev.passArm=ev.passArm||[]).push(s);
    for (const s of [0,1]) if (ch[s].action==='PASS' && !armNext(mon(P[s],P[s].active))){ const m=mon(P[s],P[s].active); if (m.cid==='wolf' && CFG.HOWL_NEXT!==2 && !m.howl){ m.howl=true; L.push(['Wolf howls: +1 ATK on its attack this round.','m']); }
      if (m.cid==='rgolem' && CFG.WINDUP_NEXT!==2 && !m.windup){ m.windup=true; L.push(['Rock Golem winds up: its next attack will be an Earthquake.','m']); } }
    for (const s of [0,1]) if (ch[s].action==='PASS'){ const m=mon(P[s],P[s].active); if (m && m.cid==='rume' && m.hp>0 && !cnt(P[s],'GRAPE')) addToHand(S, s, 'GRAPE', 1, 'Rume', L, ev); }
    for (const s of [0,1]) if (ch[s].action==='PASS'){ const m=mon(P[s],P[s].active); if (m && m.cid==='blanche' && m.hp>0){
      const b=P[s].roster.filter(x=>!x.ko && x.hp>0 && x.i!==P[s].active && x.hp<CARDS[x.cid].hp).sort((x,y)=>(x.hp-y.hp)||((x.hp/CARDS[x.cid].hp)-(y.hp/CARDS[y.cid].hp))||(x.i-y.i));
      if (b.length){ const x=b[0], was=x.hp; x.hp=Math.min(CARDS[x.cid].hp, x.hp+CFG.TIPS_HEAL); S.stats.tips=(S.stats.tips||0)+(x.hp-was);
        (ev.tips=ev.tips||[]).push({ s, i:x.i, amt:x.hp-was }); L.push([`Give me tips or 5 stars: Blanche patches up ${N(x.cid)} (+${x.hp-was} HP → ${x.hp}).`,'g']); } } }
    // Royal Grace, GRACE_MODE 4 (live, 11-15): a Pass raises Regen on Hilde's side, a field like Tailwind. From NEXT round, for
    // REGEN_ROUNDS rounds, the active card heals REGEN at the end of the round (not Hilde herself). Passing again restarts it;
    // it keeps running after Hilde leaves or falls.
    if ((CFG.GRACE_MODE||0)===4) for (const s of [0,1]) if (ch[s].action==='PASS'){ const m=mon(P[s],P[s].active); if (m && m.cid==='hilde' && m.hp>0){
      P[s].rgFrom=S.round+1; P[s].rgUntil=S.round+CFG.REGEN_ROUNDS; S.stats.rgSet=(S.stats.rgSet||0)+1; (ev.regen=ev.regen||[]).push({ s });
      L.push([`Royal Grace: Princess Hilde raises Regen. From next round, the active card heals ${CFG.REGEN} at the end of each round for ${CFG.REGEN_ROUNDS} rounds (not Princess Hilde).`,'g']); } }
    // Royal Grace. GRACE_MODE 0 = Pass heals the team (GRACE_SELF: Hilde too) · 1 = Pass heals the lowest-HP benched ally (random tie)
    //   · 2 = switching Hilde OUT heals the card coming in (done in the switch step)
    for (const s of [0,1]) if (ch[s].action==='PASS' && (CFG.GRACE_MODE||0)===1){ const m=mon(P[s],P[s].active); if (m && m.cid==='hilde' && m.hp>0){
      const b=P[s].roster.filter(x=>!x.ko && x.hp>0 && x!==m && x.hp<CARDS[x.cid].hp); if (b.length){ const lo=Math.min(...b.map(x=>x.hp)); const pool=b.filter(x=>x.hp===lo); const x=pool[Math.floor(RNG()*pool.length)];
        const was=x.hp; x.hp=Math.min(CARDS[x.cid].hp, x.hp+CFG.GRACE_HEAL); S.stats.grace=(S.stats.grace||0)+(x.hp-was);
        (ev.grace=ev.grace||[]).push({ s, heals:[{ i:x.i, amt:x.hp-was }] }); L.push([`Royal Grace: Princess Hilde's prayer heals ${N(x.cid)} +${x.hp-was}.`,'g']); } } }
    for (const s of [0,1]) if (ch[s].action==='PASS' && !(CFG.GRACE_MODE||0)){ const m=mon(P[s],P[s].active); if (m && m.cid==='hilde' && m.hp>0){ const got=[];
      for (const x of P[s].roster) if (!x.ko && x.hp>0 && x.hp<CARDS[x.cid].hp && (CFG.GRACE_SELF || x!==m)){ const was=x.hp; x.hp=Math.min(CARDS[x.cid].hp, x.hp+CFG.GRACE_HEAL); got.push({ i:x.i, amt:x.hp-was }); S.stats.grace=(S.stats.grace||0)+(x.hp-was); }
      if (got.length){ (ev.grace=ev.grace||[]).push({ s, heals:got }); L.push([`Royal Grace: Princess Hilde's prayer heals ${got.map(g=>N(P[s].roster[g.i].cid)+' +'+g.amt).join(', ')}.`,'g']); } } }
    const startHP=[0,1].map(s=>mon(P[s],P[s].active).hp);
    for (const s of [0,1]) if (ch[s].action==='REMEDY'){
      const m=mon(P[s],P[s].active), amt=CFG.REMEDY+(P[s].roster[P[s].active].cid==='seigfried'?CFG.DECREE:0), b=m.hp;
      m.hp=Math.min(CARDS[m.cid].hp, m.hp+amt); ev.heal[s]=m.hp-b;
      L.push([`${N(m.cid)} drinks a Remedy: +${ev.heal[s]} HP → ${m.hp}.`,'g']);
    }
    // created cards: heal before attacks, then a pre-attack hit on the enemy active card (ignores DEF and items; el = element chart)
    for (const s of [0,1]){ const fx=fxOf(ch[s].action); if (!fx || !fx.heal) continue;
      const m=mon(P[s],P[s].active), b=m.hp; m.hp=Math.min(CARDS[m.cid].hp, m.hp+fx.heal); ev.heal[s]=(ev.heal[s]||0)+(m.hp-b);
      L.push([`${N(m.cid)} uses ${ITEMS[ch[s].action].t}: +${m.hp-b} HP → ${m.hp}.`,'g']); }
    for (const s of [0,1]){ const fx=fxOf(ch[s].action); if (!fx || !fx.dmg) continue;
      const t=mon(P[1-s],P[1-s].active); if (!t || t.hp<=0) continue;
      const amt=Math.max(1, (fx.dmg.n||0) + (fx.dmg.el ? elMod(fx.dmg.el, elOf(t)) : 0)), b=t.hp;
      t.hp=Math.max(0,t.hp-amt); BN(t); (ev.direct=ev.direct||[]).push({ s:1-s, i:t.i, amt:b-t.hp, src:ITEMS[ch[s].action].t });
      S.stats.cardDmg=(S.stats.cardDmg||0)+(b-t.hp);
      L.push([`${ITEMS[ch[s].action].t}: ${b-t.hp} ${fx.dmg.el ? EL[fx.dmg.el]+' ' : ''}damage to ${N(t.cid)} (${t.hp} HP).`,'']); }
    for (const s of [0,1]){ const a=ch[s].action, fx=fxOf(a);
      if (['STRENGTH','GOLEM','SMOKE','SHARD'].includes(a) || (fx && !fx.heal && !fx.dmg && !(fx.spd && !fx.atk && !fx.def))) L.push([`${who(s)} use${third(s)?'s':''} ${ITEMS[a].t}.`,'m']); }
    for (const s of [0,1]){ const m=mon(P[s],P[s].active); m.activeRounds++; }
    const preHP=[0,1].map(s=>mon(P[s],P[s].active).hp); // v0.4 tiebreak snapshot (after Remedy, before impact)
    // ---- attack phase (v0.5): equal Speed = simultaneous; otherwise the faster attack fully resolves first ----
    const directHit = (s, amt, src, withActive) => { const pl=P[s]; const c=pl.roster.filter(m=>!m.ko && m.hp>0 && (withActive || m.i!==pl.active)); if (!c.length) return null;
      const m=c[Math.floor(RNG()*c.length)]; return hitOne(s, m, amt, src); };
    const hitOne = (s, m, amt, src) => { const pl=P[s]; m.hp=Math.max(0,m.hp-amt); BN(m); (ev.direct=ev.direct||[]).push({s,i:m.i,amt,src}); S.stats.direct=S.stats.direct||{}; S.stats.direct[src]=(S.stats.direct[src]||0)+1;
      const bench=m.i!==pl.active; L.push([`${src}: ${amt} damage to ${bench?'benched ':''}${N(m.cid)} (${m.hp} HP).`,'']);
      if (m.hp===0 && bench){ m.ko=true; if (m.cid==='thomas') pl.lastCall=true; ev.benchKO=(ev.benchKO||0)+1; S.stats.kos.push(m.cid); L.push([`${N(m.cid)} is knocked out on the bench!`,'k']); }
      return m; };
    const calcFor = s => { const o=1-s, a=mon(P[s],P[s].active), d=mon(P[o],P[o].active);
      return { ...calcAttack(a,d,{attItem:ch[s].action, defItem:ch[o].action, defSwitchedIn:ev.switched[o]||hopIn[o]}), a, d, side:s }; };
    const applyHit = r => {
      if (r.heal){ const b=r.d.hp; r.d.hp=Math.min(CARDS[r.d.cid].hp, r.d.hp+r.heal); r.healed=r.d.hp-b; }
      else { r.d.hp=Math.max(0, r.d.hp-r.dmg); BN(r.d); if (r.d.cid==='wagner' && r.d.hp<=0 && !r.d.laugh){ r.d.hp=1; r.d.laugh=true; S.stats.laugh=(S.stats.laugh||0)+1; L.push(['Hearty Laugh: Wagner laughs it off at 1 HP.','g']); } }
      r.a.attacked=true; if (r.usedOwn) r.a.abilityUsed=true; if (r.howl){ r.a.howl=false; S.stats.howl=(S.stats.howl||0)+1; }
      if (r.a.cid==='pyrefly'){ r.a.burn=r.a.burn||{}; if (r.pyre){ r.a.burn[r.d.i]=0; S.stats.pyre=(S.stats.pyre||0)+1; } else if (r.dmg>0) r.a.burn[r.d.i]=Math.min(CFG.PYRE_N,(r.a.burn[r.d.i]||0)+1); if (r.d.hp===0) delete r.a.burn[r.d.i]; }
      if (r.a.cid==='skizzik' && r.dmg>0){ r.a.static = r.zap ? 0 : Math.min(2,(r.a.static||0)+1); if (r.zap) S.stats.zap=(S.stats.zap||0)+1; }
      if (r.a.cid==='roo' && CFG.ROO_BENCH){ if (r.knife){ r.a.walk=0; r.a.leaving=!!CFG.ROO_LEAVE; S.stats.knife=(S.stats.knife||0)+1; } else if (CFG.ROO_GOLEM && (r.a.walk||0)>=(CFG.ROO_BENCH===2?CFG.ROO_STEPS:3)){ r.a.walk=0; L.push(['Golem Fragment turns the knife aside!','m']); } }
      else if (r.a.cid==='roo'){ if (r.knife){ r.a.steps=null; if (r.a.marks) r.a.marks[r.d.i]=0; r.a.leaving=!!CFG.ROO_LEAVE; S.stats.knife=(S.stats.knife||0)+1; }
        else { if (CFG.ROO_MARK){ r.a.marks=r.a.marks||{}; r.a.marks[r.d.i]=(r.a.marks[r.d.i]||0)+1; }
          const st=r.a.steps; r.a.steps = (st && st.t===r.d.i) ? {t:r.d.i, n:st.n+1} : {t:r.d.i, n:(CFG.ROO_MARK?r.a.marks[r.d.i]:1)}; L.push([`Roo takes a step toward ${N(r.d.cid)} (${r.a.steps.n}/3).`,'m']); } }
      if (r.d.cid==='asura' && r.dmg>0 && !r.heal && r.ael && r.ael!=='none'){ r.d.marks=r.d.marks||[]; if (!r.d.marks.includes(r.ael) && r.d.marks.length<CFG.ASCENSION_MAX){ r.d.marks.push(r.ael); S.stats.ascension=(S.stats.ascension||0)+1; L.push([`Ascension: Asura takes the ${EL[r.ael]} mark (+${r.d.marks.length} ATK).`,'m']); } }
      if (r.d.cid==='rakshasa' && r.dmg>0 && !r.heal && r.d.readBy!==r.a.cid){ r.d.readBy=r.a.cid; S.stats.wread=(S.stats.wread||0)+1; L.push([`Weapon Read: Rakshasa reads ${N(r.a.cid)} (−${CFG.WEAPON_READ} DMG from it).`,'m']); }
      if (r.kcharge){ delete r.a.chg[S.round]; S.stats.kcharge=(S.stats.kcharge||0)+1; }
      if (r.d.cid==='kirin' && r.dmg>0 && r.d.hp>0 && !r.heal){ r.d.chg=r.d.chg||{}; r.d.chg[S.round+1]=true; L.push([`Lightning Charge: Kirin is charged (+${CFG.KCHARGE} ATK next round).`,'m']); }
      if (false && r.a.cid==='sylph' && r.dmg>0 && r.d.hp>0){ r.d.slowRound=S.round+1; S.stats.gust=(S.stats.gust||0)+1; L.push([`Gust: ${N(r.d.cid)} will be −1 SPD next round.`,'m']); }
      if (r.a.cid==='sylph'){ P[r.side].twFrom=S.round+1; P[r.side].twUntil=S.round+CFG.TAILWIND; S.stats.twSet=(S.stats.twSet||0)+1; L.push([`Tailwind: ${CFG.TW_ALL?'your monsters':'your Air monsters'} get +1 SPD for ${CFG.TAILWIND} rounds.`,'m']); }
      if (r.a.cid==='archer') directHit(1-r.side, 1, 'Double Strafe', false);
      if (r.a.cid==='pomme' && r.dmg>0 && !r.heal && !cnt(P[r.side],'APPLE_BOMB')) addToHand(S, r.side, 'APPLE_BOMB', 1, 'Pomme', L, ev);
      if (CFG.ARMOR_BREAK && r.a.cid==='canis' && r.dmg>0 && !r.heal && Math.max(0, CARDS[r.d.cid].def-(r.d.armorBreak||0))>0){ r.d.armorBreak=(r.d.armorBreak||0)+CFG.ARMOR_BREAK; S.stats.abreak=(S.stats.abreak||0)+1; L.push([`Armor Break: ${N(r.d.cid)} loses ${CFG.ARMOR_BREAK} DEF for the match.`,'m']); }
      if (r.a.cid==='roselie'){ const pl=P[1-r.side]; for (const m of pl.roster) if (!m.ko && m.hp>0 && m.i!==pl.active) hitOne(1-r.side, m, Math.max(1, CFG.WILDFIRE + elMod('fire', elOf(m))), 'Wildfire Kiss'); }
      if (r.a.cid==='carlbero' && r.dmg>0 && r.d.hp>0){ r.d.breath=S.round+(CFG.BREATH_ROUNDS-1); S.stats.breath=(S.stats.breath||0)+1; L.push([`Stinking Breath: ${N(r.d.cid)} reeks (−1 ATK, −1 DEF, −1 SPD for ${CFG.BREATH_ROUNDS} rounds).`,'m']); }
      if (r.a.cid==='love' && (CFG.SERENADE_MODE||1)===1) serenade(r.side, 'attack');
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
      if (tw){ S.stats.tailwind=(S.stats.tailwind||0)+1; } return Math.min(CFG.SPD_MAX||5, Math.max(1, CARDS[m.cid].spd + tw - (m.slowRound===S.round?1:0) - ((m.breath||0)>=S.round?1:0))); });
    const sp=[0,1].map(s=>Math.min(CFG.SPD_MAX||5, baseSp[s] + (ch[s].action==='CAFE'?(mon(P[s],P[s].active).cid==='seigfried'?1+CFG.DECREE:1):0) + ((fxOf(ch[s].action)||{}).spd||0)));   // Café au Lait / a created card's SPD: this round, cap SPD_MAX (5)
    S._sp = sp; S._spRound = S.round;   // this round's real SPD (Gryphon's Slipstream reads it)
    for (const s of [0,1]) if (ch[s].action==='CAFE'){ const changed=(Math.sign(baseSp[s]-baseSp[1-s])!==Math.sign(sp[s]-baseSp[1-s])); S.stats.cafe=S.stats.cafe||{used:0,changed:0,capped:0}; S.stats.cafe.used++; if (changed) S.stats.cafe.changed++; if (baseSp[s]>=(CFG.SPD_MAX||5)) S.stats.cafe.capped++;
      L.push([`${N(mon(P[s],P[s].active).cid)} drinks Café au Lait: SPD ${baseSp[s]} → ${sp[s]}${baseSp[s]>=(CFG.SPD_MAX||5)?' (already at max)':''}.`,'m']); }
    if (canAtk[0]&&canAtk[1]&&sp[0]!==sp[1]){
      const first=sp[0]>sp[1]?0:1, second=1-first;
      ev.seq=[]; ev.snaps=[];
      L.push([`${N(mon(P[first],P[first].active).cid)} is faster (SPD ${sp[first]} vs ${sp[second]}) and strikes first.`,'m']);
      const r1=calcFor(first); ev.res[first]=r1; applyHit(r1); afterHit(r1); ev.seq.push(first); ev.snaps.push(snap()); tryHop(first);
      if (mon(P[second],P[second].active).hp>0){ const r2=calcFor(second); ev.res[second]=r2; applyHit(r2); afterHit(r2); ev.seq.push(second); ev.snaps.push(snap()); tryHop(second); }
      else { ev.denied=second; S.stats.firstStrike=(S.stats.firstStrike||0)+1; L.push([`${N(mon(P[second],P[second].active).cid)} falls before it can strike back.`,'k']); }
    } else {
      for (const s of [0,1]) if (canAtk[s]) ev.res[s]=calcFor(s);   // computed on the shared pre-impact state
      for (const s of [0,1]) if (ev.res[s]) applyHit(ev.res[s]);
      for (const s of [0,1]) if (ev.res[s]) afterHit(ev.res[s]);
      for (const s of [0,1]) tryHop(s);
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
    // Royal Grace, GRACE_MODE 4: the Regen tick on the active card (a card at 0 HP is not healed; Hilde is skipped)
    if ((CFG.GRACE_MODE||0)===4) for (const s of [0,1]){ const pl=P[s]; if (!(pl.rgFrom<=S.round && S.round<=pl.rgUntil)) continue; const a=mon(pl,pl.active);
      if (!a || a.ko || a.hp<=0 || a.cid==='hilde' || a.hp>=CARDS[a.cid].hp) continue; const was=a.hp; a.hp=Math.min(CARDS[a.cid].hp, a.hp+CFG.REGEN);
      S.stats.grace=(S.stats.grace||0)+(a.hp-was); (ev.grace=ev.grace||[]).push({ s, heals:[{ i:a.i, amt:a.hp-was }], end:true, regen:true });
      L.push([`Royal Grace: Regen heals ${N(a.cid)} +${a.hp-was}.`,'g']); }
    // Royal Grace, GRACE_MODE 3: at the end of the round, if Princess Hilde is the active card (and still standing), every benched ally heals GRACE_HEAL
    if ((CFG.GRACE_MODE||0)===3) for (const s of [0,1]){ const pl=P[s], h=mon(pl,pl.active); if (!h || h.cid!=='hilde' || h.hp<=0) continue; const got=[];
      for (const x of pl.roster) if (!x.ko && x.hp>0 && x.i!==pl.active && x.hp<CARDS[x.cid].hp){ const was=x.hp; x.hp=Math.min(CARDS[x.cid].hp, x.hp+CFG.GRACE_HEAL); got.push({ i:x.i, amt:x.hp-was }); S.stats.grace=(S.stats.grace||0)+(x.hp-was); }
      if (got.length){ (ev.grace=ev.grace||[]).push({ s, heals:got, end:true }); L.push([`Royal Grace: Princess Hilde's prayer heals ${got.map(g=>N(pl.roster[g.i].cid)+' +'+g.amt).join(', ')}.`,'g']); } }
    for (const s of [0,1]){ const a=mon(P[s],P[s].active); if (a && a.cid==='guy' && a.hp>0) a.stay=(a.stay||0)+1; }
    // KO
    for (const s of [0,1]){ const m=mon(P[s],P[s].active); if (m.hp<=0 && !m.ko){ m.ko=true; if (m.cid==='thomas') P[s].lastCall=true; ev.ko[s]=true; S.stats.kos.push(m.cid); L.push([`${N(m.cid)} is knocked out!`,'k']); } }
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
    const score = m => { const o=est(m,opMon), i=est(opMon,m); return (m.cid==='kalina' && m.dive ? (opMon.hp<=CFG.DIVE ? 8 : CFG.DIVE*0.8) : 0) + (m.cid==='keren' && living(me).length>2 ? -50 : 0) + o*1.2 - ((faster(m)&&o>=opMon.hp)?0:i) + m.hp*0.2 + (D.speed?(CARDS[m.cid].spd-CARDS[opMon.cid].spd)*0.4:0); };
    if (me.pending){ let best=null,bs=-1e9; for (const m of benchOptions(me)){ const sc=score(m)*noise(); if (sc>bs){bs=sc;best=m;} } choice.replace=best.i; }
    const my = me.pending ? me.roster[choice.replace] : mon(me,me.active);
    const max=CARDS[my.cid].hp, out=est(my,opMon);
    const killsFirst = faster(my) && out>=opMon.hp;           // incoming damage never lands
    const inc = killsFirst ? 0 : est(opMon,my);
    const incS = killsFirst ? 0 : est(opMon,my, op.items.STRENGTH?'STRENGTH':'PASS');
    const w={ PASS:1 + (killsFirst?2.5:0) };
    if (my.cid==='wolf' && !my.howl) w.PASS+=0.8;
    if (my.cid==='rgolem' && !my.windup) w.PASS+=0.8;
    if (my.cid==='blanche' && benchOptions(me).some(x=>x.hp<CARDS[x.cid].hp)) w.PASS+=0.8;
    if (my.cid==='rume' && !cnt(me,'GRAPE')) w.PASS+=0.9;
    if (my.cid==='hilde' && (CFG.GRACE_MODE||0)!==2 && (CFG.GRACE_MODE||0)!==3 && me.roster.some(x=>!x.ko && x.hp>0 && x!==my && x.i!==me.active && x.hp<CARDS[x.cid].hp)) w.PASS+=1.0;
    // Royal Grace (mode 4) play pattern: Hilde Passes to raise Regen, then hands off to the best attacker while it runs
    const rgOn = (CFG.GRACE_MODE||0)===4 && me.rgUntil>=S.round+1;
    if ((CFG.GRACE_MODE||0)===4 && my.cid==='hilde' && !rgOn) w.PASS+=1.4;
    const twOn = me.twUntil>=S.round+1;   // Tailwind still up next round
    if (slower(my) && my.hp<=incS) w.PASS*=0.6;                // about to be KO'd with no reply
    if (me.items.STRENGTH){ const outS=est(my,opMon,'STRENGTH'); w.STRENGTH = 0.6 + (opMon.hp>out && opMon.hp<=outS ? 3 : 0) + (my.cid==='fulgimite'?0.6:0) - (out<=0?0.6:0); }
    if (me.items.GOLEM) w.GOLEM = 0.4 + (my.hp<=incS && incS>0 ? 2.4 : 0) + (inc<=0?0.4:0);
    if (me.items.REMEDY) w.REMEDY = my.hp>=max-1 ? 0 : 0.3 + (my.hp<=max/2?1.8:0) + (my.hp<=incS && my.hp+CFG.REMEDY>incS ? 1.2 : 0) + (my.cid==='kirin'?0.4:0);
    if (me.items.SMOKE){ const outK=est(my,opMon,'SMOKE'), dK=(opMon && (CARDS[opMon.cid].def||0)) || 0;
      w.SMOKE = 0.1 + Math.max(0,outK-out)*0.9 + (opMon.hp>out && opMon.hp<=outK ? 2 : 0) + (op.items.GOLEM && opMon.hp<=out+1 && out>0 ? 1.5 : 0) + (dK>=2 ? 0.6 : 0); }
    if (me.items.CAFE){ const ms=CARDS[my.cid].spd, os=CARDS[opMon.cid].spd; const SM=CFG.SPD_MAX||5; w.CAFE = 0.2 + (ms<SM && ms+1>os && ms<=os && out>=opMon.hp ? 2.6 : 0) + (ms<SM && ms+1===os && my.hp<=incS ? 0.8 : 0); }
    if (me.items.SHARD){ const outX=est(my,opMon,'SHARD'); w.SHARD = 0.3 + Math.max(0,outX-out)*0.9 + (opMon.hp>out && opMon.hp<=outX ? 2 : 0); }
    // created cards: weighed from their effect (fx), the same reasons the items above are played for
    for (const k of Object.keys(me.items)){ if (!ITEMS[k] || !ITEMS[k].created || !cnt(me,k)) continue; const fx=ITEMS[k].fx||{}; let v=0.4;
      if (fx.atk){ const o2=est(my,opMon,k); v += Math.max(0,o2-out)*0.6 + (opMon.hp>out && opMon.hp<=o2 ? 3 : 0); }
      if (fx.def) v += (my.hp<=incS && incS>0 ? 1.8 : 0.2);
      if (fx.heal) v += my.hp>=max-1 ? -0.4 : (my.hp<=max/2 ? 1.8 : 0.3) + (my.hp<=incS && my.hp+fx.heal>incS ? 1.2 : 0);
      if (fx.spd){ const ms=CARDS[my.cid].spd, os=CARDS[opMon.cid].spd; v += (ms<=os && ms+fx.spd>os && out>=opMon.hp) ? 2 : 0.1; }
      if (fx.dmg && opMon){ const n=Math.max(1,(fx.dmg.n||0)+(fx.dmg.el?elMod(fx.dmg.el,elOf(opMon)):0)); v += opMon.hp<=n ? 3 : (opMon.hp<=n+out ? 1.6 : 0.7); }
      w[k]=v; }
    if (!me.pending){
      const bench=benchOptions(me);
      if (bench.length){
        let best=null,bs=-1e9;
        for (const m of bench){ const ci=est(opMon,m,'PASS','PASS',true); const sc=(est(m,opMon)*1.0 - ci*1.3 + (ci<m.hp?1:-3))*noise(); if (sc>bs){bs=sc;best=m;} }
        const ci=est(opMon,best,'PASS','PASS',true);
        w.SWITCH = 0.08 + (my.hp<=inc && ci<best.hp ? 1.1 : 0) + Math.max(0,(inc-ci))*0.2 + (out<=0?1.5:0) + Math.max(0, est(best,opMon)-out)*0.15;
        if (best.cid==='flame') w.SWITCH += 0.5;
        if (my.cid==='love' && (CFG.SERENADE_MODE||1)===1 && bench.some(x=>(x.ser||0)>=S.round+1)) w.SWITCH += 1.6;
        // Royal Grace (mode 3) play pattern: a hurt active card retreats behind Princess Hilde; Hilde stays in front while the bench is hurt
        if ((CFG.GRACE_MODE||0)===3){ const h=bench.find(x=>x.cid==='hilde'); if (h && my.cid!=='hilde' && my.hp*2<=CARDS[my.cid].hp && my.hp>inc){ best=h; w.SWITCH += 1.6; }
          if (my.cid==='hilde'){ const hurt=bench.some(x=>CARDS[x.cid].hp-x.hp>=2); if (hurt) w.SWITCH = Math.max(0, w.SWITCH-1.5); else if (my.hp*2<=CARDS.hilde.hp) w.SWITCH += 0.8; } }
        if (my.cid==='love' && (CFG.SERENADE_MODE||1)===2){ best=[...bench].sort((a,b)=>est(b,opMon)-est(a,opMon))[0]; w.SWITCH += 1.4; }
        if (my.cid==='hilde' && (CFG.GRACE_MODE||0)===2){ const hurt=bench.filter(x=>CARDS[x.cid].hp-x.hp>=2).sort((a,b)=>(CARDS[b.cid].hp-b.hp)-(CARDS[a.cid].hp-a.hp)); if (hurt.length){ best=hurt[0]; w.SWITCH += 1.8; } }
        if (rgOn && my.cid==='hilde'){ best=[...bench].sort((a,b)=>est(b,opMon)-est(a,opMon))[0]; w.SWITCH += 1.4; }
        if (best.cid==='love') w.SWITCH += 0.4;
        if (my.cid==='alcina' && !my.stew) w.SWITCH += 0.7;
        if (best.cid==='succubus') w.SWITCH += 0.5;
        // Kalina with Dive Ready on the bench: bring her in to finish a card at DIVE HP or less, or when the front card is about to fall
        { const kd=bench.find(x=>x.cid==='kalina' && x.dive); if (kd){ const lethal=opMon && opMon.hp>0 && opMon.hp<=CFG.DIVE;
          if (lethal || my.hp<=inc){ best=kd; w.SWITCH += lethal?2.5:0.8; } else { w.SWITCH += 0.3; if (est(opMon,kd,'PASS','PASS',true) < est(opMon,best,'PASS','PASS',true)) best=kd; } } }
        // Hako: send her in once SUPPLY_MIN+ items are used up; take her out again once the hand is restocked (4+) or she is about to fall
        { const nIt=BASE_ITEMS.filter(k=>cnt(me,k)).length, used=BASE_ITEMS.length-nIt, need=CFG.SUPPLY_MIN, hk=bench.find(x=>x.cid==='hako');
          if (hk && used>=need && nIt<=BASE_ITEMS.length-need && est(opMon,hk,'PASS','PASS',true)<hk.hp){ best=hk; w.SWITCH += 1.2; }
          if (my.cid==='hako' && (nIt>=4 || my.hp<=inc)){ best=[...bench].sort((a,b)=>est(b,opMon)-est(a,opMon))[0]; w.SWITCH += 1.2; } }
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
  function aiOpening(me, prof={diff:'casual'}){ const sk=(AI_DIFF[prof.diff]||{}).speed; let best=0,bs=-1e9; for (const m of me.roster){ const c=CARDS[m.cid]; const sc=(c.atk*1.4+c.hp*0.35+c.def+(sk?c.spd*0.6:0))*(0.7+RNG()*0.6) - (m.cid==='keren' ? 100 : 0); if (sc>bs){bs=sc;best=m.i;} } return best; }
  // v0.5 timeout auto-pick: highest current HP, then highest max HP, then roster order (deterministic)
  function autoPickMonster(pl){ const c=pl.roster.filter(m=>!m.ko && m.i!==pl.active); c.sort((a,b)=>(b.hp-a.hp)||(CARDS[b.cid].hp-CARDS[a.cid].hp)||(a.i-b.i)); return c[0].i; }

  // ===================== match flow (pure state machine) =====================
  const withState = (state, fn) => { const prev = S; S = state; try { return fn(); } finally { S = prev; } };
  const blankStats = () => ({ acts:[{},{}], switches:[0,0], forced:[0,0], kos:[], aff:{}, zero:{ bothSwitch:0, noHpLost:0, healedBack:0 } });
  // ---- match rules (format) ----
  const FORMAT_STD = Object.freeze({ mode:'standard', pat:Object.freeze([1,1,2]), mirror:true, chars:true });
  const CUPS = Object.freeze([
    { id:'commoner', name:"Commoner's Cup", pat:[1,1,1], sub:'Commons only' },
    { id:'vanguard', name:'Vanguard', pat:[1,1,2], sub:'Two commons + one elite' },
    { id:'elite', name:'Elite Cup', pat:[2,2,2], sub:'Elites only' },
    { id:'bossrush', name:'Boss Rush', pat:[3,3,3], sub:'Three bosses' },
  ]);
  function normFormat(f){
    if (!f || typeof f !== 'object') return { mode:'standard', pat:[...FORMAT_STD.pat], mirror:true, chars:true };
    const mode = ['standard','open','cup'].includes(f.mode) ? f.mode : 'standard';
    const pat = Array.isArray(f.pat) && f.pat.length === CFG.TEAM ? f.pat.map(n => [0,1,2,3].includes(Number(n)) ? Number(n) : 0) : [...FORMAT_STD.pat];
    return { mode, pat, mirror: f.mirror !== false, chars: f.chars !== false };
  }
  const fmtAllowed = (cid, f) => { const c = CARDS[cid]; if (!c) return false; f = normFormat(f);
    if (!f.chars && c.character) return false; if (f.mode === 'cup' && !f.pat.some(p => !p || p === c.cost)) return false; return true; };
  function patFits(ids, pat){ const need={1:0,2:0,3:0}; let any=0; pat.forEach(p => p ? need[p]++ : any++);
    const have={1:0,2:0,3:0}; ids.forEach(id => have[CARDS[id].cost]++); let over=0; for (const k of [1,2,3]) over += Math.max(0, have[k]-need[k]); return over <= any; }
  const fmtFits = (ids, f) => { f = normFormat(f); if (ids.some(id => !fmtAllowed(id, f))) return false;
    if (f.mode === 'standard') return teamCost(ids) <= CFG.BUDGET; if (f.mode === 'cup') return patFits(ids, f.pat); return true; };
  const isLegalTeam = (ids, format) => Array.isArray(ids) && ids.length === CFG.TEAM && new Set(ids).size === ids.length
    && ids.every(id => CARDS[id] && !CARDS[id].retired) && fmtFits(ids, format);
  function legalTeamsFor(ids, f){ const pool = [...new Set(ids)].filter(id => CARDS[id] && !CARDS[id].retired && fmtAllowed(id, f)), out=[];
    for (let a=0;a<pool.length;a++) for (let b=a+1;b<pool.length;b++) for (let c=b+1;c<pool.length;c++){ const t=[pool[a],pool[b],pool[c]]; if (fmtFits(t, f)) out.push(t); } return out; }
  const patText = p => p.map(n => n ? '★'.repeat(n) : 'Any').join(' · ');
  const cupName = p => { const c = CUPS.find(c => c.pat.join() === p.join()); return c ? c.name : 'Custom constellation'; };
  function fmtSummary(f){ f = normFormat(f);
    const bits = [ f.mode==='standard' ? `Standard (${CFG.BUDGET}★ budget)` : f.mode==='open' ? 'Open (no budget)' : `${cupName(f.pat)} (${patText(f.pat)})` ];
    if (!f.mirror) bits.push('No mirror cards'); if (!f.chars) bits.push('No character cards'); return bits.join(' · '); }
  // why these owned cards can't make a team under the rules ('' = they can)
  function fmtWhy(owned, f){ f = normFormat(f); if (legalTeamsFor(owned, f).length) return '';
    if (f.mode === 'cup'){ const by = {}; f.pat.filter(Boolean).forEach(n => by[n] = (by[n]||0)+1);
      const parts = Object.entries(by).map(([n,k]) => `${k} × ${'★'.repeat(+n)}`);
      return `needs ${parts.join(' + ')}${f.pat.includes(0) ? ' + any' : ''}${f.chars ? '' : ', character cards banned'}`; }
    return f.mode === 'standard' ? `needs three cards within ${CFG.BUDGET}★` : 'needs three cards'; }
  const Format = Object.freeze({ STANDARD: FORMAT_STD, CUPS, norm: normFormat, fits: fmtFits, allowed: fmtAllowed, legalTeams: legalTeamsFor, summary: fmtSummary, why: fmtWhy, patText, cupName });

  const Match = {
    create({ teams, names = null, format = null } = {}){
      if (!teams || teams.length !== 2) throw new Error('Fabula Arcana: two teams required');
      const fmt = normFormat(format);
      for (const t of teams) if (!isLegalTeam(t, fmt)) throw new Error('Fabula Arcana: illegal team ' + JSON.stringify(t));
      const shared = teams[0].filter(c => teams[1].includes(c));
      if (!fmt.mirror && shared.length) throw new Error('Fabula Arcana: mirror cards are off but both teams hold ' + shared.join(', '));
      return { v:1, phase:'opening', round:0, p:[mkPlayer(teams[0]), mkPlayer(teams[1])], names, format: fmt,
        commit:[null,null], result:null, capEnd:false, tiebreak:null, stats:blankStats(), log:[] };
    },
    needs(state, seat){
      if (state.phase === 'ended') return false;
      if (state.commit[seat]) return false;
      if (state.phase === 'replace') return !!state.p[seat].pending;
      return true;
    },
    validate(state, seat, c){
      if (!c || typeof c !== 'object') return 'no choice';
      if (state.phase === 'ended') return 'match over';
      if (!Match.needs(state, seat)) return 'nothing to choose now';
      const pl = state.p[seat];
      if (state.phase === 'opening'){ const m = pl.roster[c.replace]; return m && !m.ko ? null : 'pick one of your monsters'; }
      if (state.phase === 'replace'){ const m = pl.roster[c.replace]; return m && !m.ko && m.hp > 0 && m.i !== pl.active ? null : 'pick a living benched monster'; }
      // Kalina's hop target (optional; the engine picks one when it is missing): a living benched card
      if (c.hop != null && c.action !== 'SWITCH'){ const m = pl.roster[c.hop]; if (!(m && !m.ko && m.hp > 0 && m.i !== pl.active)) return 'Kalina hops to a living benched card'; }
      if (c.action === 'PASS') return null;
      if (c.action === 'SWITCH'){ const m = pl.roster[c.target]; return m && !m.ko && m.i !== pl.active ? null : 'switch to a living benched monster'; }
      if (ITEMS[c.action]) return cnt(pl, c.action) ? null : (ITEMS[c.action].created ? 'card not in hand' : 'item already used');
      return 'unknown action';
    },
    submit(state, seat, c){
      const err = Match.validate(state, seat, c); if (err) return { ok:false, error:err };
      state.commit[seat] = state.phase === 'choose' ? { action:c.action, target: c.action === 'SWITCH' ? c.target : undefined, hop: c.action !== 'SWITCH' && c.hop != null ? c.hop : undefined } : { replace:c.replace };
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
      for (const s of [0,1]) if (state.p[s].pending && C[s]){ const pl = state.p[s]; pl.active = C[s].replace; pl.pending = false; state.stats.forced[s]++; if (pl.lastCall){ pl.roster[pl.active].lc = state.round + 2; pl.lastCall = false; L.push(['Last Call: the card sent in gets +'+CFG.LAST_CALL+' DEF for 2 rounds.','g']); }
        L.push([`${seatLabel(state,s)} send${third(state,s)?'s':''} in ${N(pl.roster[pl.active].cid)}.`, 'm']); }
      // Skyfall Dive: Kalina sent in after a KO with Dive Ready lands on the enemy active card (it can KO it: then that side replaces)
      const ev = {};
      withState(state, () => { for (const s of [0,1]) if (C[s]){ const d = diveIn(s, 'replace', ev, L); const op = state.p[1-s], t = d && op.roster[d.ti];
        if (t && t.hp <= 0 && !t.ko){ t.ko = true; d.ko = true; state.stats.kos.push(t.cid); L.push([`${N(t.cid)} is knocked out!`, 'k']);
          if (!living(op).length) state.result = s === 0 ? 'WIN' : 'LOSS'; else op.pending = true; } } });
      state.log.unshift({ head:'REPLACEMENT', lines:L });
      if (state.result) state.phase = 'ended';
      else if (state.p[0].pending || state.p[1].pending) state.phase = 'replace';
      else { state.round++; state.phase = 'choose'; }
      out = { kind:'replace', choices:C, L, ev };
    } else {
      const r = withState(state, () => resolveRound([C[0], C[1]]));
      state.log.unshift({ head:`ROUND ${state.round} · ${seatLabel(state,0)}: ${ACT_T[C[0].action]} · ${seatLabel(state,1)}: ${ACT_T[C[1].action]}`, lines:r.L });
      if (state.result) state.phase = 'ended';
      else if (state.p[0].pending || state.p[1].pending) state.phase = 'replace';
      else { state.round++; state.phase = 'choose'; }
      out = { kind:'round', choices:C, L:r.L, ev:r.ev };
    }
    // Hako's Trusty Supplier fires as the next round begins (lines join the step that just resolved)
    if (state.phase === 'choose'){ const sup = withState(state, () => supplyStep(state, out.L)); if (sup.length){ out.ev = out.ev || {}; out.ev.supply = sup; } }
    if (state.phase === 'choose') withState(state, () => { const ARC=['ARC_SUN','ARC_MOON','ARC_STAR']; for (const s of [0,1]){ const pl=state.p[s], m=pl.active==null?null:pl.roster[pl.active];
      if (!m || m.cid!=='farin' || m.ko || m.hp<=0 || ARC.some(k=>cnt(pl,k))) continue; out.ev = out.ev || {}; addToHand(state, s, ARC[Math.floor(RNG()*3)], 1, 'Farin', out.L, out.ev); } });
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
      for (const k of ['direct','entry','revive','tips','serenade','grace','regen','hop','dive','supply','added']) for (const x of ev[k] || []) if (x && x.s != null) x.s = flip(x.s);
      for (const x of ev.dive || []) if (x && x.t != null) x.t = flip(x.t);
      return r;
    },
    seriesForSeat(sr, viewer){
      if (!sr) return sr; const s = JSON.parse(JSON.stringify(sr));
      if (viewer === 1){ s.wins = swap2(s.wins); if (s.winner != null) s.winner = flip(s.winner); }
      return s;
    },
  };

  // ===================== Hand API (2026-11-25): create a card and add it to a seat's hand =====================
  // Abilities call addToHand at their own timing step (the round's ev.added drives the UI). Outside a round (an event, a
  // GM, a future effect) Hand.add writes a "CARD CREATED" log entry and returns the record for the host to broadcast.
  const Hand = Object.freeze({
    MAX: () => CFG.HAND_MAX || 8,
    keys: () => Object.keys(ITEMS),
    isCreated: k => !!(ITEMS[k] && ITEMS[k].created),
    count: (state, seat, k) => cnt(state.p[seat], k),
    size: (state, seat) => handSize(state.p[seat]),
    // [{ k, n, created }] in registry order (base items first), held cards only
    list: (state, seat) => Object.keys(ITEMS).filter(k=>cnt(state.p[seat],k)).map(k=>({ k, n:cnt(state.p[seat],k), created:!!ITEMS[k].created })),
    add(state, seat, k, { n = 1, source = null } = {}){
      if (!state || !state.p || ![0,1].includes(seat)) return { ok:false, error:'no such seat' };
      if (!ITEMS[k]) return { ok:false, error:`unknown card ${k}` };
      if (state.phase === 'ended') return { ok:false, error:'match over' };
      const L=[]; const rec=addToHand(state, seat, k, n, source, L, null);
      if (L.length) state.log.unshift({ head:'CARD CREATED', lines:L });
      return { ok:true, ...rec, L };
    },
    restore: (state, seat, k) => restoreItem(state, seat, k),
  });

  const Engine = Object.freeze({
    Match, Series, View, Format, Hand, foretellSeat, foxFire: (state, m) => withState(state, () => foxFire(m)), IDS, LEGAL_TEAMS, isLegalTeam, elOf: (state, m) => withState(state, () => elOf(m)), teamCost, compKey, randomTeam, elMod,
    setRng(fn){ RNG = typeof fn === 'function' ? fn : Math.random; },
    // low-level hooks for tests and the balance tool (run inside a state)
    _withState: withState, _resolveRound: ch => resolveRound(ch), _calcAttack: (a, d, ctx) => calcAttack(a, d, ctx), _mkPlayer: mkPlayer,
    _aiChoose: (me, op, prof) => aiChoose(me, op, prof), _aiOpening: (me, prof) => aiOpening(me, prof), _autoPickMonster: pl => autoPickMonster(pl), _benchOptions: pl => benchOptions(pl),
  });
  globalThis.FabulaArcana = globalThis.FabulaArcana || {};
  globalThis.FabulaArcana.Engine = Engine;
})();
