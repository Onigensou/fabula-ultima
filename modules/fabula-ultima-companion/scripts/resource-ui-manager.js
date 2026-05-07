// scripts/resource-ui-manager.js
// Conflict-safe Player Resource HUD (per-combat owner, robust teardown)
(() => {
  // ===== Unique namespace and per-combat registry ===========================
    const HUD_NS      = "OniHud2"; // window[HUD_NS]
  const STYLE_ID    = "oni2-hud-style";
  const FONTLINK_ID = "oni2-hud-fonts";

    // ===== UI scale tuner ==========================================
  // 1.00 = default size
  // 0.90 = slightly smaller
  // 1.10 = slightly bigger
  const HUD_UI_SCALE = 1.00;

  // ===== Portrait scale tuner ====================================
  // This ONLY scales the actor portrait image (not the whole card)
  // 1.00 = default portrait size
  // 0.85 = smaller portraits
  // 1.15 = bigger portraits
  const HUD_PORTRAIT_SCALE = 0.85;

  // NEW: module + socket action keys (to mirror GM → everyone)
  const MODULE_ID    = "fabula-ultima-companion";
  const ACTION_BUILD = "ONIHUD2_BUILD";
  const ACTION_KILL  = "ONIHUD2_DESTROY";

    window[HUD_NS] = window[HUD_NS] || {
    byCombat: new Map(),
    hooks: {},
    socket: null,
    debug: true // flip to false later if too noisy
  };

  // Tiny tagged logger so we can filter easily
  function dlog(...args){
    if (!window[HUD_NS].debug) return;
    console.log("%c[OniHud2 DEBUG]", "color:#9cf;background:#123;padding:2px 6px;border-radius:4px;", ...args);
  }

  // ===== System paths (same as before) ======================================
  const PATH_HP_VAL = "system.props.current_hp";
  const PATH_HP_MAX = "system.props.max_hp";
  const PATH_MP_VAL = "system.props.current_mp";
  const PATH_MP_MAX = "system.props.max_mp";
  const PATH_IP_VAL = "system.props.current_ip";
  const PATH_IP_MAX = "system.props.max_ip";
  const PATH_ZP_VAL = "system.props.zero_power_value";
  const ZP_MAX_CONST = 6;

  // ===== Fonts / palette (same as your approved look) =======================
  const UI_FONT  = "Merriweather";
  const NUM_FONT = "Merriweather";
  const ZP_FONT  = "Merriweather";
  const TONE = {
    text: "#ffffff",
    textDim: "rgba(255,255,255,.86)",
    topRGB: "18,18,20",
    botRGB: "12,12,14",
    opac:   0,
    border: "rgba(255,255,255,0.12)",
    hpA: "#6bd66b", hpB: "#2fbf71",
    mpA: "#5aa8ff", mpB: "#2e7bd6",
    zpA: "#ffd95a", zpB: "#ff9c2e",
    hp50:"#a2e33a", hp25:"#ffb84a", hp10:"#ff5a5a",
    shadow: "0 12px 28px rgba(0,0,0,0.45)",
    tick: "rgba(255,255,255,.12)"
  };

  // ===== helpers ============================================================
  const pick=(o,p)=>{try{return getProperty(o,p);}catch{return undefined;}};
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const pct=(v,m)=>`${(clamp(v/m,0,1)*100).toFixed(4)}%`;
  const nice=x=>new Intl.NumberFormat().format(Math.max(0,Math.floor(Number(x)||0)));
  const stripActorPrefix=id=>id?String(id).replace(/^Actor\./i,"").trim():id;

  const pair=(a,vp,mp,fb=null)=>{const v=Number(pick(a,vp));let m=Number(pick(a,mp));if(!Number.isFinite(m))m=fb;if(!Number.isFinite(v)||!Number.isFinite(m)||m<=0)return null;return{v,m};};
  const readHP=a=>pair(a,PATH_HP_VAL,PATH_HP_MAX);
  const readMP=a=>pair(a,PATH_MP_VAL,PATH_MP_MAX)||{v:0,m:1};
  const readZP=a=>{const v=Number(pick(a,PATH_ZP_VAL));return{v:Number.isFinite(v)?Math.max(0,v):0,m:ZP_MAX_CONST};};
  const readIP=a=>{const v=Number(pick(a,PATH_IP_VAL));let m=Number(pick(a,PATH_IP_MAX));if(!Number.isFinite(m)||m<=0)m=6;return{v:Number.isFinite(v)?clamp(v,0,m):0,m};};

 // ===== Friendly selection (disposition=1), excluding Summons ==============
function pickFriendliesFromCombat(combat){
  const all = combat?.combatants?.contents ?? [];
  const isFriendly = c => {
    const disp = c?.token?.disposition ?? c?.actor?.prototypeToken?.disposition;
    return disp === 1;
  };
  const isNotSummon = c => {
    const flag = (c?.actor) ? getProperty(c.actor, "system.props.isSummon") : false;
    return !Boolean(flag);
  };
  return all
    .filter(c => c?.actor)
    .filter(isFriendly)
    .filter(isNotSummon)
    .map(c => ({ combatant: c, actor: c.actor, token: c.token }));
}

  // ===== fonts & styles =====================================================
  function mountFonts(){
    const families=[
      "family="+encodeURIComponent(`${UI_FONT}:wght@400;600;700;900`),
      "family="+encodeURIComponent(`${NUM_FONT}:wght@400;700;900`),
      "family="+encodeURIComponent(`${ZP_FONT}:wght@400;700`),
      "family=" + encodeURIComponent(`Merriweather:ital,wght@0,400;0,700;1,400;1,700`)
    ].join("&");
    const href=`https://fonts.googleapis.com/css2?${families}&display=swap`;
    let link=document.getElementById(FONTLINK_ID);
    if(!link){link=document.createElement("link");link.id=FONTLINK_ID;link.rel="stylesheet";document.head.appendChild(link);}
    if(link.href!==href) link.href=href;
  }

  function injectStyles(){
  dlog("injectStyles: check style tag", { hasStyle: !!document.getElementById(STYLE_ID) });
    if(document.getElementById(STYLE_ID)) return;
    mountFonts();
    const css=`
.oni2-root{
  --ui-font: "${UI_FONT}", system-ui, sans-serif;
  --num-font: "${NUM_FONT}", "${UI_FONT}", monospace;
  --zp-font:  "${ZP_FONT}", "${UI_FONT}", monospace;

  /* Portrait scale variable (from your tuner) */
  --oni2-portrait-scale: ${HUD_PORTRAIT_SCALE};

  --txt: ${TONE.text};
  --txt-dim: ${TONE.textDim};
  --top: ${TONE.topRGB};
  --bot: ${TONE.botRGB};
  --op: ${TONE.opac};
  --hp-a: ${TONE.hpA}; --hp-b: ${TONE.hpB};
  --mp-a: ${TONE.mpA}; --mp-b: ${TONE.mpB};
  --zp-a: ${TONE.zpA}; --zp-b: ${TONE.zpB};
  --tick: ${TONE.tick};
  position: fixed; left:1.25rem; bottom:6rem;
  z-index: var(--z-index-canvas, 0); /* <= under #hud (z=1) */
  pointer-events:none; display:grid; grid-auto-flow:column; gap:.6rem;
    transform-origin:bottom left; transform: scale(1)
}
.oni2-card{pointer-events:auto; display:inline-flex; align-items:flex-start; gap:.6rem; opacity:0; transform:translateX(-24px); transition:opacity 420ms ease, transform 420ms ease;}
.oni2-card.oni2-appear{opacity:1; transform:translateX(0);}
/* Floaty portrait with no background box */
.oni2-portrait{
  pointer-events:none;
  background: transparent !important;
  filter: drop-shadow(0 18px 32px rgba(0,0,0,.55));
}
.oni2-portrait img{
  display:block; width:auto; height:auto; object-fit:contain;
  max-width:  min(calc(24vmin * var(--oni2-portrait-scale)), calc(360px * var(--oni2-portrait-scale)));
  max-height: min(calc(24vmin * var(--oni2-portrait-scale)), calc(360px * var(--oni2-portrait-scale)));
  background: transparent !important;
  border: none !important; outline: none !important; box-shadow: none !important;
}
/* Translucent panel: 0 opacity background, keep soft shadow for depth */
.oni2-panel{
  position: relative;
  min-width: 22rem; max-width: 28rem;
  /* 0 opacity — fully see-through */
  background: linear-gradient(180deg, rgba(18,18,20,0), rgba(12,12,14,0)) !important; /* <-- --oni2-panel-op: 0 */
  border: none;
  border-radius: .9rem;
  padding: 1rem;
  /* keep soft depth so elements “sit” on the scene */
  box-shadow: 0 12px 28px rgba(0,0,0,0.45);
  backdrop-filter: blur(3px);
  overflow: hidden;
}
.oni2-top{display:flex; align-items:center; gap:.5rem; margin-bottom:.12rem;}
.oni2-name{
  font-family:var(--ui-font); font-size:.95rem; font-weight:700; letter-spacing:.02em; color:#fff; transform:skewX(-8deg);
  text-shadow:
    0 4px 5px rgba(0,0,0,.98),
    0 6px 16px rgba(0,0,0,.65),
    0 0 3px rgba(0,0,0,.85);
  flex:1 1 auto;
}
.oni2-ip{display:flex; gap:6px;} .oni2-ip i{width:12px; height:12px; border-radius:999px; background:rgba(255,255,255,.25); box-shadow:0 0 0 1px rgba(0,0,0,.25) inset;} .oni2-ip i.on{background:#ffb84a;}
.oni2-hpbig{
  position:relative; margin:.05rem 0 .45rem 0;
  font-family:var(--num-font);
  font-size: 2.28rem;     /* <-- --oni2-hp-rem */
  font-style: italic;     /* <-- --oni2-italic-hp */
  font-weight:400; letter-spacing:.5px; color:#fff;
  text-shadow:
    0 4px 6.5px rgba(0,0,0,.95),
    0 6px 20px rgba(0,0,0,.55),
    0 0 3px rgba(0,0,0,.85);
}
.oni2-mpmini{position:absolute; right:.5rem; bottom:.1rem; display:flex; align-items:baseline; gap:.4rem;}
.oni2-mpmini .tag{
  font-weight:700;
  font-size: 0.85rem;   /* ← THIS controls the MP label size */
  color: rgba(255,255,255,.86);
  text-shadow:
    0 3px 4px rgba(0,0,0,.95),
    0 0 3px rgba(0,0,0,.85);
}
.oni2-mpmini .num{
  font-family:var(--num-font);
  font-size: 1.58rem;     /* <-- --oni2-mp-rem */
  font-style: italic;     /* <-- --oni2-italic-mp */
  color:#fff;
  text-shadow:
    0 4px 6.5px rgba(0,0,0,.95),
    0 6px 20px rgba(0,0,0,.55),
    0 0 3px rgba(0,0,0,.85);
}
.oni2-bar{position:relative; height:1rem; border-radius:.6rem; overflow:hidden; border:1px solid rgba(255,255,255,.20); background:linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,.65)); box-shadow:inset 0 0 0 1px rgba(0,0,0,.65);}
.oni2-fill{position:absolute; left:0; top:0; bottom:0; width:0%; background:linear-gradient(90deg, var(--hp-a), var(--hp-b)); transition:width 240ms ease, background 120ms linear;}
.oni2-ticks{position:absolute; inset:0; pointer-events:none; opacity:.25; background-image:repeating-linear-gradient(to right, var(--tick) 0 1px, transparent 1px 12px);}
.oni2-mp{height:.65rem; margin-top:.25rem;} .oni2-mp .oni2-fill{background:linear-gradient(90deg, var(--mp-a), var(--mp-b));}
.oni2-zp{height:.65rem;} .oni2-zp .oni2-fill{background:linear-gradient(90deg, var(--zp-a), var(--zp-b));}
.oni2-zprow{display:flex; align-items:center; gap:.5rem; margin-top:.25rem;}
.oni2-zplabel{
  font-family:var(--zp-font); font-weight:700; letter-spacing:.06em; color:#fff;
  text-shadow:
    0 4px 6.5px rgba(0,0,0,.95),
    0 0 3px rgba(0,0,0,.85);
  user-select:none;
}
.oni2-zp .oni2-fill.oni2-glow{filter:drop-shadow(0 0 6px rgba(80,140,255,.65)) drop-shadow(0 0 12px rgba(80,140,255,.35)); animation:oni2ZpGlow 1.2s ease-in-out infinite alternate;}
@keyframes oni2ZpGlow{0%{box-shadow:0 0 0 rgba(80,140,255,0)}100%{box-shadow:0 0 22px rgba(80,140,255,.55)}}
.oni2-flash{animation:oni2FillFlash .35s ease;} @keyframes oni2FillFlash{0%{filter:brightness(1.15)}100%{filter:brightness(1)}}
`;
    const st=document.createElement("style");
    st.id=STYLE_ID; st.textContent=css; document.head.appendChild(st);
  }

  // ===== DOM build helpers ===================================================
    function scaleRoot(root, count){
    const vmin=Math.min(window.innerWidth, window.innerHeight);
    let base=clamp(vmin/1080, 0.75, 1.15);
    const factor=(count>=4)?0.78:(count===3?0.85:1.00);

    // Master scale multiplier (your tuner)
    root.style.transform=`scale(${(base*factor*HUD_UI_SCALE).toFixed(4)})`;
  }
  const dotRow=(m,v)=>Array.from({length:m},(_,i)=>`<i class="${i<v?'on':''}"></i>`).join("");
  function tintHp(fillEl, v, m){
    const p=Math.max(0,Math.min(1,v/m));
    if(p<=0.10) fillEl.style.background=`linear-gradient(90deg, ${TONE.hp10}, #ff7676)`;
    else if(p<=0.25) fillEl.style.background=`linear-gradient(90deg, ${TONE.hp25}, #ff9a5c)`;
    else if(p<=0.50) fillEl.style.background=`linear-gradient(90deg, ${TONE.hp50}, #89e14a)`;
    else fillEl.style.background=`linear-gradient(90deg, var(--hp-a), var(--hp-b))`;
  }
  function glideNumber(node, from, to, ms=420){
    if(!node) return;
    const t0=performance.now(), d=to-from;
    function loop(t){
      const n=Math.min(1,(t-t0)/ms);
      const e=n<.5?2*n*n:1-Math.pow(-2*n+2,2)/2;
      node.textContent=nice(from + d*e);
      if(n<1) requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  function makeCard(actor, token){
    const card=document.createElement("div"); card.className="oni2-card";
    const portrait=actor?.img || actor?.prototypeToken?.texture?.src || token?.texture?.src || "";
    const hp=readHP(actor); if(!hp) return null;
    const mp=readMP(actor); const zp=readZP(actor); const ip=readIP(actor);

    card.innerHTML=`
      <div class="oni2-portrait"><img src="${portrait}" alt=""></div>
      <div class="oni2-panel">
        <div class="oni2-top">
          <div class="oni2-name">${token?.name || actor?.name || "—"}</div>
          <div class="oni2-ip">${dotRow(ip.m, ip.v)}</div>
        </div>
        <div class="oni2-hpbig">
          <span class="oni2-hpcur">${nice(hp.v)}</span> / <span class="oni2-hpmax">${nice(hp.m)}</span>
          <div class="oni2-mpmini"><span class="tag">MP</span><span class="num">${nice(mp.v)}</span></div>
        </div>
        <div class="oni2-bar oni2-hp"><div class="oni2-fill oni2-hpfill"></div><div class="oni2-ticks"></div></div>
        <div class="oni2-bar oni2-mp"><div class="oni2-fill oni2-mpfill"></div></div>
        <div class="oni2-zprow"><div class="oni2-zplabel">ZP</div>
          <div class="oni2-bar oni2-zp" style="flex:1 1 auto; min-width:6rem;"><div class="oni2-fill oni2-zpfill"></div></div>
        </div>
      </div>
    `;
    requestAnimationFrame(()=>card.classList.add("oni2-appear"));

    const hpFill=card.querySelector(".oni2-hpfill");
    const mpFill=card.querySelector(".oni2-mpfill");
    const zpFill=card.querySelector(".oni2-zpfill");
    const hpCur=card.querySelector(".oni2-hpcur");
    const hpMax=card.querySelector(".oni2-hpmax");
    const mpNum=card.querySelector(".oni2-mpmini .num");
    const ipRow=card.querySelector(".oni2-ip");
    const flash=el=>{el.classList.remove("oni2-flash"); void el.offsetWidth; el.classList.add("oni2-flash");};

    tintHp(hpFill,hp.v,hp.m); hpFill.style.width=pct(hp.v,hp.m); flash(hpFill);
    mpFill.style.width=pct(mp.v,mp.m); flash(mpFill);
    zpFill.style.width=pct(zp.v,zp.m); flash(zpFill);
    zpFill.classList.toggle("oni2-glow", zp.v>=zp.m);

    return { el:card, hpFill, mpFill, zpFill, hpCur, hpMax, mpNum, ipRow };
  }

  function updateCard(card, actor){
    const hp=readHP(actor); if(hp){
      const cur=Number(card.hpCur?.textContent?.replace(/,/g,""))||0;
      glideNumber(card.hpCur, cur, hp.v, 420);
      if(card.hpMax) card.hpMax.textContent=nice(hp.m);
      tintHp(card.hpFill, hp.v, hp.m);
      card.hpFill.style.width=pct(hp.v,hp.m);
      card.hpFill.classList.remove("oni2-flash"); void card.hpFill.offsetWidth; card.hpFill.classList.add("oni2-flash");
    }
    const mp=readMP(actor); if(mp){
      if(card.mpNum){ const o=Number(card.mpNum.textContent?.replace(/,/g,""))||0; glideNumber(card.mpNum,o,mp.v,420); }
      card.mpFill.style.width=pct(mp.v,mp.m);
      card.mpFill.classList.remove("oni2-flash"); void card.mpFill.offsetWidth; card.mpFill.classList.add("oni2-flash");
    }
    const zp=readZP(actor); if(zp){
      card.zpFill.style.width=pct(zp.v,zp.m);
      card.zpFill.classList.remove("oni2-flash"); void card.zpFill.offsetWidth; card.zpFill.classList.add("oni2-flash");
      card.zpFill.classList.toggle("oni2-glow", zp.v>=zp.m);
    }
    const ip=readIP(actor); if(ip && card.ipRow){ card.ipRow.innerHTML=dotRow(ip.m, ip.v); }
  }

  // ===== per-combat owner object ============================================
  function makeOwnerFor(combat){
  dlog("makeOwnerFor: create owner", { combatId: combat?.id });
    const id = combat.id;
    // root per combat
    const root = document.createElement("div");
    root.className = "oni2-root";
    root.id = `oni2-hud-root-${id}`;
    document.body.appendChild(root);

    const state = { root, cards:new Map(), off:[] };

    // scale based on card count
    state.scale = ()=> scaleRoot(root, state.cards.size);

    // live update hook factories (closed over entry.actor.id)
    state.attachActorHooks = (actorId, card, nameSetter) => {
      const h1 = Hooks.on("updateActor", (doc,diff)=>{
        if (doc?.id !== actorId) return;
        if (typeof diff?.name === "string") nameSetter(diff.name);
        const live=game.actors?.get(actorId);
        if (live) updateCard(card, live);
      });
      const h2 = Hooks.on("updateToken", (tok,chg)=>{
        if (stripActorPrefix(tok?.actor?.id) !== stripActorPrefix(actorId)) return;
        if (typeof chg?.name === "string") nameSetter(chg.name || tok?.actor?.name);
        const live=tok.actor; if(live) updateCard(card, live);
      });
      state.off.push(()=>Hooks.off("updateActor",h1), ()=>Hooks.off("updateToken",h2));
    };

    return state;
  }

// ===== build / destroy for a specific combat ==============================
async function buildForCombat(combat){
  try{
    dlog("buildForCombat: enter", { combatId: combat?.id, existingOwners: Array.from(window[HUD_NS].byCombat.keys()) });
    // clean any previous owner for same id just in case
    destroyForCombat(combat);

    injectStyles();
    const owner = makeOwnerFor(combat);
    window[HUD_NS].byCombat.set(combat.id, owner);
    dlog("buildForCombat: owner created", { combatId: combat.id });

    // NEW: pick all Friendly, non-Summon combatants from this combat
    const picks = pickFriendliesFromCombat(combat);
    dlog("buildForCombat: friendlies", picks.map(p=>({ actor:p.actor?.name, token:p.token?.name })));
    if (!picks.length){
      dlog("buildForCombat: no friendly (non-summon) picks, early return");
      return;
    }

    for (const entry of picks){
      const card = makeCard(entry.actor, entry.combatant.token ?? entry.actor?.prototypeToken);
      if (!card){ dlog("buildForCombat: skip card (missing hp?) for actor", entry.actor?.name); continue; }
      const setName = (nm)=>{ const el = card.el.querySelector(".oni2-name"); if (el) el.textContent = nm; };
      owner.root.appendChild(card.el);
      owner.cards.set(entry.actor.id, card);
      owner.attachActorHooks(entry.actor.id, card, setName);
    }
    owner.scale();

    dlog("buildForCombat: success", { combatId: combat.id, cardCount: owner.cards.size, mapSize: window[HUD_NS].byCombat.size });
  }catch(e){
    console.error("[OniHud2 buildForCombat] Error:", e);
  }
}
     function destroyForCombat(combat){
    try{
      dlog("destroyForCombat: enter", { combatId: combat?.id, mapHas: window[HUD_NS].byCombat.has(combat?.id), mapKeys: Array.from(window[HUD_NS].byCombat.keys()) });
      const owner = window[HUD_NS].byCombat.get(combat?.id);
      if (!owner){ dlog("destroyForCombat: no owner found for combat", combat?.id); return; }

      // unhook
      let offCount = 0;
      for (const fn of owner.off){
        try{ fn(); offCount++; }catch(e){ console.warn("[OniHud2 destroy] off error:", e); }
      }
      owner.off.length = 0;

      // remove DOM
      try{
        if (owner.root && owner.root.parentNode){
          owner.root.remove();
          dlog("destroyForCombat: root removed");
        } else {
          dlog("destroyForCombat: root already absent");
        }
      }catch(e){
        console.warn("[OniHud2 destroy] root.remove error:", e);
      }

      owner.cards.clear();
      window[HUD_NS].byCombat.delete(combat.id);

      dlog("destroyForCombat: success", { combatId: combat?.id, offCount, remainingOwners: Array.from(window[HUD_NS].byCombat.keys()) });
    }catch(e){
      console.warn("[OniHud2] destroy error:", e);
    }
  }

    // NEW: allow teardown by combatId even if the Combat doc is already deleted
  function destroyForCombatId(combatId){
    try{
      dlog("destroyForCombatId: enter", { combatId, mapHas: window[HUD_NS].byCombat.has(combatId), mapKeys: Array.from(window[HUD_NS].byCombat.keys()) });
      const owner = window[HUD_NS].byCombat.get(combatId);

      // If we still track it in the map, reuse the normal flow
      if (owner){
        destroyForCombat({ id: combatId });
        return;
      }

      // Fallback: try to remove DOM by known id even if map is gone/out-of-sync
      const rootId = `oni2-hud-root-${combatId}`;
      const rootEl = document.getElementById(rootId);
      if (rootEl){
        try { rootEl.remove(); dlog("destroyForCombatId: removed stray DOM by id", rootId); }
        catch(e){ console.warn("[OniHud2 destroyForCombatId] root.remove error:", e); }
      } else {
        dlog("destroyForCombatId: no DOM element found for", rootId);
      }
    }catch(e){
      console.warn("[OniHud2] destroyForCombatId error:", e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // NEW: socket setup + action handlers (every client runs these)
  // ─────────────────────────────────────────────────────────────
    function ensureSocket(){
    if (window[HUD_NS].socket) {
      dlog("ensureSocket: already have socket");
      return window[HUD_NS].socket;
    }
    const sockMod = game.modules.get("socketlib");
    if (!sockMod?.active || !window.socketlib) {
      dlog("ensureSocket: socketlib NOT available (mod active? ", !!sockMod?.active, ")");
      return null;
    }
    const socket = socketlib.registerModule(MODULE_ID);
    dlog("ensureSocket: socket registered for", MODULE_ID);

    // When any client receives these actions, it builds/tears down locally
    socket.register(ACTION_BUILD, ({ combatId } = {}) => {
      dlog("SOCKET RX:", ACTION_BUILD, { combatId, onUser: game.user?.id });
      try {
        const c = game.combats?.get(combatId) || game.combat;
        if (!c) return dlog("SOCKET RX build: combat not found", combatId);
        buildForCombat(c);
      } catch (e) {
        console.error("[OniHud2 SOCKET RX build] Error:", e);
      }
    });

        socket.register(ACTION_KILL, ({ combatId } = {}) => {
      dlog("SOCKET RX:", ACTION_KILL, { combatId, onUser: game.user?.id });
      try {
        const c = game.combats?.get(combatId) || game.combat;
        if (c && c.id === combatId) {
          destroyForCombat(c);
        } else {
          dlog("SOCKET RX kill: combat not found on this client; using destroyForCombatId");
          destroyForCombatId(combatId);
        }
      } catch (e) {
        console.error("[OniHud2 SOCKET RX kill] Error:", e);
      }
    });

    window[HUD_NS].socket = socket;
    return socket;
  }

  // GM helper to signal all clients, with local fallback if no socketlib
      function broadcastAll(action, payload){
    dlog("broadcastAll:", action, payload, { isGM: game.user?.isGM });
    const socket = ensureSocket();
    if (socket) {
      return socket.executeForEveryone(action, payload);
    }
    dlog("broadcastAll: NO SOCKET, falling back to local only");
    try{
      const id = payload?.combatId;
      const c  = game.combats?.get(id) || game.combat;
      if (action === ACTION_BUILD) {
        if (!c || c.id !== id) return dlog("broadcastAll fallback BUILD: combat not found", id);
        buildForCombat(c);
      } else if (action === ACTION_KILL) {
        if (c && c.id === id) destroyForCombat(c);
        else destroyForCombatId(id); // <-- NEW: tear down even if combat already gone
      }
    }catch(e){
      console.error("[OniHud2 broadcastAll] Error:", e);
    }
  }

  // ===== hook wiring (deduped, socket broadcast) ============================
  // Off existing hooks if reloaded
  if (window[HUD_NS].hooks.combatStart)  Hooks.off("combatStart",  window[HUD_NS].hooks.combatStart);
  if (window[HUD_NS].hooks.combatEnd)    Hooks.off("combatEnd",    window[HUD_NS].hooks.combatEnd);
  if (window[HUD_NS].hooks.deleteCombat) Hooks.off("deleteCombat", window[HUD_NS].hooks.deleteCombat);
  if (window[HUD_NS].hooks.updateCombat) Hooks.off("updateCombat", window[HUD_NS].hooks.updateCombat);

  // Make sure socket is available ASAP
  Hooks.once("ready", () => {
    dlog("Hooks.ready fired; ensureSocket");
    ensureSocket();
  });

  // GM: broadcast build when combat starts
  window[HUD_NS].hooks.combatStart = (combat) => {
    try {
      dlog("HOOK combatStart", { isGM: game.user?.isGM, combatId: combat?.id });
      if (!game.user.isGM) return;
      broadcastAll(ACTION_BUILD, { combatId: combat.id });
    } catch (err) { console.warn("[OniHud2] combatStart:", err); }
  };

  // GM: broadcast destroy when combat ends (explicit end path)
  window[HUD_NS].hooks.combatEnd = (combat) => {
    try {
      dlog("HOOK combatEnd", { isGM: game.user?.isGM, combatId: combat?.id });
      if (!game.user.isGM) return;
      broadcastAll(ACTION_KILL, { combatId: combat.id });
    } catch (err) { console.warn("[OniHud2] combatEnd:", err); }
  };

  // GM: also destroy when combat doc is deleted
  window[HUD_NS].hooks.deleteCombat = (combat) => {
    try {
      dlog("HOOK deleteCombat", { isGM: game.user?.isGM, combatId: combat?.id });
      if (!game.user.isGM) return;
      broadcastAll(ACTION_KILL, { combatId: combat.id });
    } catch (err) { console.warn("[OniHud2] deleteCombat:", err); }
  };

  // GM: some end flows set active:false / started:false via update
  window[HUD_NS].hooks.updateCombat = (combat, changed) => {
    try {
      dlog("HOOK updateCombat", { isGM: game.user?.isGM, combatId: combat?.id, changed });
      if (!game.user.isGM) return;
      const ended =
        (Object.prototype.hasOwnProperty.call(changed, "active")  && changed.active  === false) ||
        (Object.prototype.hasOwnProperty.call(changed, "started") && changed.started === false);
      if (ended) {
        dlog("HOOK updateCombat detected end-state; broadcasting destroy");
        broadcastAll(ACTION_KILL, { combatId: combat.id });
      }
    } catch (err) { console.warn("[OniHud2] updateCombat:", err); }
  };

  Hooks.on("combatStart",  window[HUD_NS].hooks.combatStart);
  Hooks.on("combatEnd",    window[HUD_NS].hooks.combatEnd);
  Hooks.on("deleteCombat", window[HUD_NS].hooks.deleteCombat);
  Hooks.on("updateCombat", window[HUD_NS].hooks.updateCombat);

  // Client-side safety: destroy locally if canvas tears down (scene switch/reload)
    Hooks.on("canvasTearDown", () => {
    dlog("HOOK canvasTearDown: destroying all owners on this client");
    for (const [cid] of window[HUD_NS].byCombat) {
      destroyForCombatId(cid); // <-- tear down by id; doesn’t depend on doc
    }
  });

  // GM: if page reloads while combat is active, rebroadcast a build so all sync
  Hooks.once("canvasReady", () => {
    const c = game.combat ?? game.combats?.active ?? null;
    dlog("HOOK canvasReady", { isGM: game.user?.isGM, haveCombat: !!c, combatId: c?.id, started: c?.started, round: c?.round, active: c?.active });
    if (game.user.isGM && c && (c.started || (c.round ?? 0) > 0) && c.active !== false) {
      dlog("canvasReady: rebroadcast BUILD for active combat");
      broadcastAll(ACTION_BUILD, { combatId: c.id });
    }
  });
})();
