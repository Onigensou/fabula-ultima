// ============================================================================
// Plasma Field Dash: the game behind the Multiplayer scene mode's first minigame.
//
// GENERATED from the approved mockup (v4.19) by the port script kept with the
// mockup assets (E:\...\9 - Plasma Field Mockup Assets\port). The rules, numbers
// and drawing are the mockup's, line for line; what changed is WHO decides what.
//
// ── Authority ──────────────────────────────────────────────────────────────
// * The primary GM's client is the HOST. It spawns every hazard, plasma charge,
//   shot and monster, runs the CPU runners, assigns places and drives the round
//   flow. Its decisions go out as events (a hazard with its full timeline, a
//   shot with its velocity), so every screen replays them exactly.
// * Each player's client owns ITS runner: movement and every hit it takes are
//   judged there, so a dash timed on your screen counts on your screen. Owners
//   broadcast 20 snapshots a second; everyone else draws that runner ~110 ms
//   behind, interpolated (the usual remote-player delay).
// * Contact between two clients (tackles, slime bonks, charge pickups) is
//   decided by the client that caused it and applied by the one that owns the
//   target. Pickups go through the host so a charge can only be taken once.
// * Nothing is written to the world database during a race.
//
// `env` (built by mg-boot.js): canvas, overlay, roster, myIdx, isHost, isGM,
// asset(), bgm, sfxVol(), musicVol(), isActive(), isTyping(), net, firstClear,
// onResult(), onClose(), showPerf(), playtest.
//
// `env.playtest` (null in story runs) = { quick, timeLimit, practice, startStage }:
// a sandbox run started from the playtest launcher. quick = the short course,
// timeLimit = replay time limits, practice = false skips the practice yard,
// startStage 0-2 starts the race at that stage. Results read "Playtest".
// ============================================================================

export function createPlasmaField(env) {
  "use strict";
  const TAG = "[FU][Minigame][PlasmaField]";
  const cv = env.canvas, ctx = cv.getContext("2d", { alpha: false });
  const ov = env.overlay;
  let dead = false;
  // round-flow delays run on the game's own clock (not setTimeout): they pause with the game and stay in step with it
  let clk = 0; const laters = [];
  const later = (ms, fn) => { laters.push({ at: clk + ms, fn }); };
  function runLaters(dt){ clk += dt; for (let i = 0; i < laters.length; ){ const l = laters[i]; if (l.at > clk){ i++; continue; } laters.splice(i, 1); if (dead) return; try { l.fn(); } catch (e) { console.error(TAG, e); } } }
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // the backing store is the screen's real size; every draw call still works in the mockup's 960 x 600 units
  let SCALE = 1;
  const baseTf = () => ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  const NET = makeNet();
  // a playtest run (mg-boot's playtest launcher); null in story runs
  const PT = env.playtest || null;
  const QUICK = !!PT?.quick;
  const START_STAGE = Math.max(0, Math.min(2, Number(PT?.startStage) || 0));

  const W = 960, H = 600, SQ = 48, XMIN = 175, XMAX = 785;
  const reduce = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const rnd = (a,b) => a + Math.random()*(b-a);
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const ease = t => t<.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
  const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
  const edist = (p, c) => Math.hypot(p.x - c.x, (p.y - c.y)/0.55);   // ground ellipses are drawn 0.55 tall

  // ---------- movement + stamina (Genshin pattern, scaled to a 60 s race) ----------
  const MOVE = {
    walk: 95,            // px/s at DEX d8 (2 squares/s): can't outrun a strike
    runMul: 1.55,        // hold Z: about 3.1 squares/s
    runCost: 34,         // stamina per second while running: a full bar is ~3 s of running
    dashSpeed: 340, dashMs: 280, iframeMs: 140, dashCd: 520,   // tap X: ~2 squares; untouchable for only 0.14 s at the start, so time it to the strike
    dashCost: 45,        // a full bar is two dashes; dashing with less than this still works but empties you into Winded
    regen: 12, regenDelay: 1500,  // per second, after 1.5 s without spending: ~8 s from empty to full
    windedResume: .5, windedWalk: .85, windedRegen: .75,   // empty bar = Winded until 50%, walking at 85%
  };
  // Attribute effects. Baseline d8; one die step = 2 points. Every attribute set in this party sums to 36,
  // so if each step is worth about the same time, nobody is favoured overall.
  // Attribute effects (d8 baseline; one die step = 2 points). Everyone walks at the same speed.
  const K = { wlpSta: 8, wlpRegen: .06, wlpStun: 80, dexDash: .06, insLead: 80, insIframe: 10, migTackle: .12, migResist: .06 };
  function derive(a){
    return {
      walk: MOVE.walk,
      dashSpeed: MOVE.dashSpeed*(1 + K.dexDash*(a.dex - 8)),     // DEX: dash range d6 -12% / d12 +24%
      maxSta: 100 + K.wlpSta*(a.wlp - 8),                        // WLP: stamina d6 84 / d12 132
      regen:  MOVE.regen*(1 + K.wlpRegen*(a.wlp - 8)),           //      refill d6 -12% / d12 +24%
      stun:   1200 - K.wlpStun*(a.wlp - 8),                      //      shock recovery d6 1.36 s / d12 0.88 s
      lead:   1400 + K.insLead*(a.ins - 8),                      // INS: warning d6 1.24 s / d12 1.72 s
      iframe: MOVE.iframeMs + K.insIframe*(a.ins - 8),           //      dash safe window d6 120 / d12 180 ms
      tackle: 1 + K.migTackle*(a.mig - 8),                       // MIG: tackle power d6 x0.76 / d12 x1.48
      kb:     1 - K.migResist*(a.mig - 8),                       //      weight: knockback and tackles taken d6 x1.12 / d12 x0.76
    };
  }
  const ATTRS = Object.fromEntries(env.roster.map(r => [r.name, r.attrs]));

  // ---------- stages ----------
  const STAGES = [
    { name:"Lightning on the Ground", rule:"Orange warnings mark where lightning will land: big circles, rings, lanes and scattered bursts. Get clear, or dash through as it strikes.", newRule:null, ground:[1500,2300], plasma:false, monsters:false },
    { name:"Plasma Charge", rule:"Lightning still falls, less often.", newRule:"Plasma charges flicker into being all over the field, sometimes right in front of you, and drift. Touch one and you get stamina and a short burst of speed, and every extra charge grabbed while it lasts makes you faster still (use it to drag the strike into someone's path). But a strike locks onto you and follows you for 2 s. Then it stops where it is and lands 0.9 s later. Outrun it, or leave it in someone's path. Grab another while one is following you and it stacks: a bigger strike. Watch the Electro Slimes: they grab charges too (dash into one to bonk it away). Mana Rays glide over the field and every few seconds charge up and discharge around themselves (a ring tightens first; only the discharge hurts), and from the halfway mark an Obsidrax tunnels after whoever is leading: it bursts up in front of them as a wall of obsidian spikes, and lightning that lands near it gets thrown at the leader.", ground:[2000,3000], plasma:true, slimes:true, monsters:false },
    { name:"Monster Gauntlet", rule:"Lightning and plasma, plus the Valley's monsters.", newRule:"Electro Slimes still hop about. On the cliffs: Ampere sprays bubbles that soak you (Wet is slower, and lightning throws you further); Lightning Prism fires staggered beams across the field; One Skizzik picks a runner at random and shadows them along the cliffs: it flashes a lane, then blitzes across in a blur, and a hit throws you clean across to the far edge. Mana Ray glides over the field and pulses a discharge around itself. Kirin gallops ahead of the pack and alternates two attacks, each aimed at a random runner: a huge column of lightning, and a rake of thin columns sweeping across the field with one gap to slip through. Obsidrax tunnels after the leader for the first half, then dives away when a Gigas starts hunting the leader instead: it runs faster than you can, winds up, and body-slams a huge area: anyone caught takes a huge hit. A well-timed dash passes through all of it.", ground:[2600,3600], plasma:true, slimes:true, monsters:true },
  ];
  const POINTS = [4,3,2,1], COUPONS = [10,8,5,2], FABULA = [4,3,2,1];

  // ---------- layout ----------
  let L;
  function mulberry(a){ return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const MON = {
    slime:   { key:"slime",   name:"Electro Slime",   img:"m_slime.png",   h:56  },
    skizzik: { key:"skizzik", name:"Skizzik",         img:"m_skizzik.png", h:84  },
    prism:   { key:"prism",   name:"Lightning Prism", img:"m_prism.png",   h:92  },
    kirin:   { key:"kirin",   name:"Kirin",           img:"m_kirin.png",   h:120 },
    ray:     { key:"ray",     name:"Mana Ray",        img:"m_ray.png",     h:80  },
    ampere:  { key:"ampere",  name:"Ampere",          img:"m_ampere.png",  h:84  },
    gigas:   { key:"gigas",   name:"Gigas",           img:"m_gigas.png",   h:150 },
    obsidrax:{ key:"obsidrax",name:"Obsidrax",        img:"m_obsidrax.png",h:110 },
  };
  const ORDER = ["ampere","prism","ray","prism","ampere","prism","ampere","prism","ampere","prism","ampere","prism"];
  function buildLayout(quick){
    const R = mulberry(17), rr = (a,b) => a + R()*(b-a);
    const LEN = quick ? 1600 : 3500, PLAZA = 300, YARD = 1100;
    const LEN3 = Math.round(LEN*1.03), T2 = 620, B2 = T2 + LEN3, T1 = B2 + PLAZA, B1 = T1 + LEN, T0 = B1 + PLAZA, B0 = T0 + LEN;
    const START_Y = B0 + 90, PT = START_Y + 170, PB = PT + YARD, WORLD_H = PB + 150;
    const T = [T0,T1,T2], B = [B0,B1,B2];
    const obs = [], decor = [];
    function place(y0, y1, n, kinds){
      let tries = 0, made = 0;
      while (made < n && tries++ < n*50){
        const x = rr(XMIN+40, XMAX-40), y = rr(y0, y1);
        if (obs.some(o => Math.hypot(o.x-x, o.y-y) < 130)) continue;
        const k = kinds[Math.floor(R()*kinds.length)];
        obs.push(k === "crystal" ? { x, y, r: 22, kind: k, s: rr(.9,1.2) } : k === "splash" ? { x, y, r: rr(30,42), kind: k, seed: R()*1000 } : { x, y, r: rr(34,48), kind: k });
        made++;
      }
    }
    for (let s = 0; s < 3; s++) place(T[s]+150, B[s]-150, Math.round((B[s]-T[s])/260), ["rock","splash","crystal"]);
    place(PT+140, PB-160, 5, ["rock","splash","crystal"]);
    for (let y = 0; y < WORLD_H; y += 240){
      decor.push({ kind:"wave", x: rr(60,150), y: y + rr(0,120), side:-1, h: rr(160,260), seed: R()*1000 });
      decor.push({ kind:"wave", x: rr(810,900), y: y + rr(0,120), side:1, h: rr(160,260), seed: R()*1000 });
    }
    for (let i = 0; i < WORLD_H/150; i++){ const x = rr(XMIN, XMAX), y = rr(0, WORLD_H); if (!obs.some(o => Math.hypot(o.x-x,o.y-y) < 90)) decor.push({ kind:"pool", x, y, w: rr(40,90) }); }
    for (let i = 0; i < WORLD_H/40; i++) decor.push({ kind:"crack", x: rr(XMIN, XMAX), y: rr(0, WORLD_H), seed: R()*1000 });
    const monsters = [];
    const nm = Math.max(4, Math.round(LEN3/720));
    for (let i = 0; i < nm; i++){ const side = i % 2 ? 1 : -1, y = B2 - 320 - i*(LEN3-480)/nm; monsters.push({ ...MON[ORDER[i % ORDER.length]], x: side < 0 ? XMIN - 70 : XMAX + 70, y, homeY:y, side, homeSide:side, cd: 1000, fire:0, zone:"stage" }); }
    for (const [i, k] of [[0, .3], [1, .7]].entries()){ const side = i ? 1 : -1, y = B1 - (B1 - T1)*k[1]; monsters.push({ ...MON.ray, x: side < 0 ? XMIN - 70 : XMAX + 70, y, homeY:y, side, homeSide:side, cd: 1500, fire:0, zone:"s2" }); }
    monsters.push({ ...MON.ampere, x: XMIN - 70, y: PT + YARD*.45, homeY: PT + YARD*.45, side:-1, homeSide:-1, cd: 1200, fire:0, zone:"yard" });
    const startMarks = [300,420,540,660].map(x => ({ x, y: START_Y }));
    const yardMarks  = [300,420,540,660].map(x => ({ x, y: PB - 50 }));
    const marks = s => s < 2 ? [300,420,540,660].map(x => ({ x, y: T[s] - PLAZA + 70 }))
                             : [{x:410,y:T2-95},{x:550,y:T2-95},{x:330,y:T2-175},{x:630,y:T2-175}];
    return { LEN, PLAZA, T, B, START_Y, PT, PB, WORLD_H, hako:{ x:480, y:T2-175 }, pillars:[{x:480,y:T0-150},{x:480,y:T1-150}], obs, decor, monsters, startMarks, yardMarks, marks, quick };
  }

  // ---------- images ----------
  const NAMES = env.roster.map(r => r.name);
  const imgs = {};
  function load(src){ return new Promise(r => { if (!src) return r(null); const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => r(i); i.onerror = () => r(null); i.src = src; }); }
  function silhouette(img, color, w, h){ const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(img,0,0,w,h); g.globalCompositeOperation = "source-in"; g.fillStyle = color; g.fillRect(0,0,w,h); return c; }
  function stripBakedShadow(img){
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d");
    g.drawImage(img,0,0); let d; try { d = g.getImageData(0,0,c.width,c.height); } catch(e){ return img; }
    const p = d.data, w = c.width;
    for (let y = Math.floor(c.height*0.6); y < c.height; y++) for (let x = 0; x < w; x++){ const i = (y*w+x)*4; if (p[i+3] < 160 && p[i] < 24 && p[i+1] < 24 && p[i+2] < 24) p[i+3] = 0; }
    g.putImageData(d,0,0); return c;
  }

  // ---------- walk animation (the game's own 8-direction art: 5 drawn facing left, 3 mirrored) ----------
  const SLOTS = ["down","downleft","left","upleft","up"];
  const anims = {};
  function vid(src){ const v = document.createElement("video"); v.crossOrigin = "anonymous"; v.src = src; v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = "auto"; try { const pr = v.play && v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch(e){} return v; }
  function slotFor(a){ // a = angle of travel; 0 = right, +90 degrees = down
    switch (((Math.round(a/(Math.PI/4)) % 8) + 8) % 8){
      case 0: return ["left", true];  case 1: return ["downleft", true]; case 2: return ["down", false]; case 3: return ["downleft", false];
      case 4: return ["left", false]; case 5: return ["upleft", false];  case 6: return ["up", false];   default: return ["upleft", true]; }
  }
  function turnToward(p, dx, dy){
    if (Math.hypot(dx, dy) < .15) return;
    const a = Math.atan2(dy, dx);
    if (p.faceAng != null){ const diff = Math.abs(((a - p.faceAng) % (2*Math.PI) + 3*Math.PI) % (2*Math.PI) - Math.PI); if (diff < (22.5 + 8)*Math.PI/180) return; }   // ~8 degree stickiness, like the game
    p.faceAng = Math.round(a/(Math.PI/4))*(Math.PI/4); [p.slot, p.mirror] = slotFor(p.faceAng);
  }
  const frameCanvas = {};
  function frameOf(p){
    const A = anims[p.name]; if (!A) return null;
    const st = A.stand[p.slot] || A.stand.downleft; if (!st) return null;
    const moving = p.state === "walk" || p.state === "run" || p.state === "dash" || p.state === "auto";
    const v = A.walk[p.slot]; let src = st;
    if (moving && v && v.readyState >= 2){ src = v; const rate = p.state === "dash" ? 2.2 : p.state === "run" ? 1.6 : p.winded ? .75 : 1; if (v.playbackRate !== rate) v.playbackRate = rate; if (v.paused) v.play().catch(() => {}); }
    return { src, w: st.width, h: st.height, sil: A.sil[p.slot] || A.sil.downleft };
  }
  function composite(p, f, xray){
    const c = frameCanvas[p.name] || (frameCanvas[p.name] = document.createElement("canvas"));
    if (c.width !== f.w) c.width = f.w; if (c.height !== f.h) c.height = f.h;
    const g = c.getContext("2d"); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.clearRect(0, 0, f.w, f.h); g.drawImage(f.src, 0, 0, f.w, f.h);
    if (xray){ g.globalCompositeOperation = "source-in"; g.fillStyle = "#bfe9ff"; g.fillRect(0, 0, f.w, f.h); return c; }
    if (p.soot > 0){ g.globalCompositeOperation = "source-atop"; g.globalAlpha = p.soot*(p.charred ? .95 : .75); g.fillStyle = "#14101c"; g.fillRect(0, 0, f.w, f.h); }
    if (p.wet > 0){ g.globalCompositeOperation = "source-atop"; g.globalAlpha = .3; g.fillStyle = "#4aa8ff"; g.fillRect(0, 0, f.w, f.h); }
    if (p.inv > 0){ g.globalCompositeOperation = "source-atop"; g.globalAlpha = .45; g.fillStyle = "#bfe9ff"; g.fillRect(0, 0, f.w, f.h); }
    return c;
  }

  // ---------- audio ----------
  let ac = null;
  function audio(){ if (!ac){ try { ac = new (window.AudioContext||window.webkitAudioContext)(); } catch(e){} } return ac; }
  function noise(dur, freq, gain, q=0.8){
    if (!ac) return;
    const n = Math.floor(ac.sampleRate*dur), buf = ac.createBuffer(1, n, ac.sampleRate), ch = buf.getChannelData(0);
    for (let i=0;i<n;i++) ch[i] = (Math.random()*2-1) * Math.pow(1-i/n, 2.2);
    const s = ac.createBufferSource(); s.buffer = buf; const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = freq; f.Q.value = q;
    const g = ac.createGain(); g.gain.value = gain*env.sfxVol(); s.connect(f); f.connect(g); g.connect(ac.destination); s.start();
  }
  function tone(freq, dur, gain=.07, type="square"){
    if (!ac) return; const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(Math.max(.0002, gain*env.sfxVol()), ac.currentTime); g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime+dur); o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime+dur);
  }
  const sfx = {
    thunder: (v=1) => { noise(.6, 900, .4*v); noise(.14, 6000, .2*v); },
    dash: () => noise(.12, 3000, .08, 2),
    pickup: () => { tone(880,.06,.05,"triangle"); setTimeout(()=>tone(1320,.08,.05,"triangle"),60); },
    shot: () => tone(1700, .04, .025, "square"),
    winded: () => tone(180, .3, .05, "sawtooth"),
    dodge: () => { tone(660,.07,.05,"triangle"); setTimeout(()=>tone(990,.09,.05,"triangle"),60); },
    beep: hi => tone(hi?880:440, hi?.35:.15, .07),
    fanfare: () => [523,659,784,1046].forEach((f,i)=>setTimeout(()=>tone(f,.25,.07,"triangle"),i*120)),
    ready: () => tone(784,.12,.05,"triangle"),
    blink: () => { tone(1900, .03, .03, "sine"); setTimeout(() => tone(1500, .03, .025, "sine"), 40); },
    perfect: () => { [1320, 1760, 2640].forEach((fr, i) => setTimeout(() => tone(fr, .12, .05, "triangle"), i*45)); noise(.25, 9000, .06, 1); },
    tackle: () => { noise(.12, 600, .3); tone(140,.12,.06,"square"); },
  };

  // ---------- music ----------
  const music = (() => {
    let cur = null, muted = false;
    const mk = (src, vol, loop) => { if (typeof Audio === "undefined") return null; const a = new Audio(src); a.loop = loop; a.volume = vol; a.preload = "auto"; a.baseVol = vol; return a; };
    const tracks = { main: mk(env.bgm.main, .5, true), victory: mk(env.bgm.victory, .6, false) };
    for (const a of Object.values(tracks)) if (a){ a.baseVol = a.baseVol*env.musicVol(); a.volume = a.baseVol; }
    const play = k => { const a = tracks[k]; if (!a || cur === a) return; if (cur) cur.pause(); cur = a; a.volume = muted ? 0 : a.baseVol; try { a.currentTime = 0; const pr = a.play(); if (pr && pr.catch) pr.catch(() => {}); } catch(e){} };
    return { main: () => play("main"), victory: () => play("victory"), stop: () => { if (cur){ cur.pause(); cur = null; } }, kill: () => { for (const a of Object.values(tracks)) if (a){ a.pause(); a.removeAttribute("src"); a.load(); } cur = null; },
      toggle: () => { muted = !muted; for (const a of Object.values(tracks)) if (a) a.volume = muted ? 0 : a.baseVol; return muted; } };
  })();

  // ---------- state ----------
  let G, keys = {}, picked = 0;
  // CPU personalities: dash timing error (ms), stamina they keep in reserve, how keen they are to haul plasma onto rivals.
  const BOT = {
    Keren:   { tackle:.25, dashErr:[-60,140], runKeep:65, grabby:.15, react:[180,420] },
    Blanche: { tackle:.5, dashErr:[-90,180], runKeep:55, grabby:0,   react:[220,520] },
    Zarg:    { tackle:.9, dashErr:[-50,120], runKeep:70, grabby:.6,  react:[160,380] },
    Hina:    { tackle:.3, dashErr:[-60,140], runKeep:65, grabby:.3,  react:[180,420] },
    Same:    { tackle:.4, dashErr:[-60,140], runKeep:65, grabby:.25, react:[180,420] },
  };
  function newStats(){ return { tackles:0, tackled:0, drained:0, shocks:0, dodges:0, winded:0, plasmaHits:0, groundHits:0, bulletHits:0, pickups:0, runMs:0, lost:0, wins:0, points:0, timeouts:0, places:[] }; }
  function newGame(quick, opts = {}){
    L = buildLayout(quick);
    const meIdx = env.myIdx;
    G = {
      mode:"title", t:0, quick, stage:-1, stageT:0, limit: (PT ? !!PT.timeLimit : opts.replay) ? (quick ? 100000 : 180000) : Infinity, meIdx, replay: !!opts.replay, watchIdx: -1, inputOk: false,
      camY: L.START_Y - 120,
      players: NAMES.map((n,i) => {
        const attrs = (opts.attrs && opts.attrs[i]) || ATTRS[n], d = derive(attrs);
        const r = env.roster[i];
        return { name:n, idx:i, me: i === meIdx, cpu: !!r.cpu, local: i === meIdx || (env.isHost && !!r.cpu), attrs, d, sta:d.maxSta, hp:100, hpMax:100, winded:false, lastSpend:-9999,
          x: L.yardMarks[i].x, y: L.yardMarks[i].y, face:1, slot:"up", mirror:false, faceAng:-Math.PI/2, walkT:0, state:"idle", st:0, soot:0, inv:0, dashT:0, dashCd:0, dashDir:{x:0,y:-1},
          bot: opts.sameBots ? BOT.Same : BOT[n], running:false, finished:false, ready:false, lesson:1, lessonDone:{}, stats:newStats(), pop:null, mark:null };
      }),
      haz:[], orbs:[], shots:[], slimes:[], spikeWalls:[], obsx:null, toast:null, fx:[], perfectT:0, kirin:null, gigas:null, skiz:null, bolts:[], rings:[], puffs:[], flash:0, shakes:0, fade:null, banner:null, text:null, speech:null,
      hako:{ x:L.hako.x, y:L.hako.y, zap:0, next:600, freed:false, perch:1 }, groundNext:900, placeN:0, watching:null, practiceT:0,
    };
    for (const m of L.monsters){ m.cd = rnd(600, 1600); m.fire = 0; m.aim = null; m.rush = null; m.fly = null; m.charge = 0; }
  }
  // the local runner; the GM (who runs none) "is" whoever the camera follows
  const me = () => G.players[G.meIdx] || G.players[G.watchIdx] || leaderAny() || G.players[0];
  function leaderAny(){ return [...G.players].filter(p => p.running || G.mode === "practice").sort((a,b) => a.y - b.y)[0]; }
  const isRunner = () => G.meIdx >= 0 && !!G.players[G.meIdx];
  function practiceLesson(){ const hs = G.players.filter(p => !p.cpu); return hs.length ? Math.max(...hs.map(p => p.lesson || 1)) : 5; }

  // ---------- input ----------
  const KEYMAP = { ArrowUp:"up", ArrowDown:"down", ArrowLeft:"left", ArrowRight:"right", KeyZ:"z", KeyX:"x", KeyR:"r", KeyM:"m" };
  function onKeyDown(e){
    if (!env.isActive() || G?.tutOpen) return;
    const k = KEYMAP[e.code]; if (!k || k === "r") return;
    if (env.isTyping?.(e)) return;
    e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat) return; keys[k] = true;
    if (k === "m"){ const m = music.toggle(); if (G) toast(m ? "Music off (M)" : "Music on (M)", 1200); return; }
    if (!G || !isRunner()) { if (env.isGM && G && /^(left|right)$/.test(k)) cycleWatch(k === "right" ? 1 : -1); return; }
    if (k === "x" && isLive() && G.inputOk) tryDash(me(), inputDir());
    if ((k === "left" || k === "right") && isLive() && me().state === "ko") struggleTap(me(), k);
  }
  function onKeyUp(e){ const k = KEYMAP[e.code]; if (k && keys[k]){ keys[k] = false; if (env.isActive()) { e.preventDefault(); e.stopImmediatePropagation(); } } }
  function onBlur(){ keys = {}; }
  addEventListener("keydown", onKeyDown, true); addEventListener("keyup", onKeyUp, true); addEventListener("blur", onBlur);
  function cycleWatch(d){ const n = G.players.length; G.watchIdx = ((G.watchIdx < 0 ? 0 : G.watchIdx) + d + n) % n; toast("Watching " + G.players[G.watchIdx].name + " (← → to switch)", 1400); }
  function inputDir(){ return { x:(keys.right?1:0) - (keys.left?1:0), y:(keys.down?1:0) - (keys.up?1:0) }; }

  // ---------- rules ----------
  const isLive = () => G.mode === "practice" || G.mode === "play";
  const active = p => (G.mode === "practice" && !p.ready) || (G.mode === "play" && p.running);
  const canAct = p => p.state === "idle" || p.state === "walk" || p.state === "run" || p.state === "dash";
  function feature(){
    if (G.mode === "practice"){ const l = practiceLesson(); return { ground:[1500,2300], plasma: l >= 3, slimes: l >= 3, monsters: l >= 4 }; }
    return STAGES[Math.max(0, G.stage)];
  }
  function lesson(p, n){ if (!p.me || G.mode !== "practice" || p.lessonDone[n]) return; p.lessonDone[n] = true; if (n >= 1) p.lesson = Math.max(p.lesson, n+1); sfx.ready(); }
  function spend(p, amt){ p.sta = Math.max(0, p.sta - amt); p.lastSpend = G.t; if (p.sta <= 0 && !p.winded){ p.winded = true; p.stats.winded++; if (p.me) sfx.winded(); p.pop = { txt:"Winded", good:false, t:0 }; } }
  function tryDash(p, dir){
    if (!active(p) || !(p.state === "idle" || p.state === "walk" || p.state === "run") || p.dashCd > 0 || p.winded || p.sta <= 0) return false;
    const n = Math.hypot(dir.x, dir.y); p.dashDir = n ? { x:dir.x/n, y:dir.y/n } : { x:0, y:-1 };
    spend(p, MOVE.dashCost); p.tackledThisDash = false; p.state = "dash"; p.dashT = MOVE.dashMs; p.inv = p.d.iframe; p.dashCd = MOVE.dashCd; if (p.dashDir.x) p.face = p.dashDir.x > 0 ? 1 : -1;
    if (Math.abs(p.y - G.camY) < 400) sfx.dash();
    if (p.me) lesson(p, 1);
    return true;
  }
  // Hazards. t counts up to dur; your INS decides when you first see a ground strike. Plasma is always visible.
  function finishTop(){ return G.mode === "play" && G.stage >= 0 ? L.T[G.stage] + 6 : -1e9; }
  function keepInside(h){
    const top = finishTop(); if (top < 0) return h;
    if (h.kind === "lane") h.y = Math.max(h.y, top + h.hw);
    else if (h.kind === "column") h.y0 = Math.max(h.y0, top);
    else if (h.kind === "donut") h.y = Math.max(h.y, top + h.r2*.55);
    else if (h.r) h.y = Math.max(h.y, top + h.r*.55);
    return h;
  }
  function addHaz(h){ h.t = 0; keepInside(h); h.id = h.id || NET.nextId(); G.haz.push(h); NET.hazard(h); if (h.wire && h.wx != null) G.fx.push({ kind:"wire", x:h.wx, y:h.wy, tx:h.x, ty:h.y - 30, t:0, life:520 }); return h; }
  function spawnGround(){
    const run = G.players.filter(p => active(p) && p.state !== "auto" && p.state !== "wait" && pendingOn(p) < CATCHUP.cap && G.t >= (p.aimRest ?? 0)); if (!run.length) return;
    const least = Math.min(...run.map(pendingOn)), pool = run.filter(q => pendingOn(q) === least);
    const p = pool[Math.floor(Math.random()*pool.length)], group = NET.nextId();
    const F = feature(); p.aimRest = G.t + (F.ground[0] + F.ground[1])/2*CATCHUP.rest;
    const aimed = h => addHaz({ ...h, aim: p.idx, group });
    const ax = clamp(p.x + rnd(-80,80), XMIN+20, XMAX-20), ay = p.y - rnd(0, 140);
    const r = Math.random();
    if (r < .42) aimed({ kind:"circle", x:ax, y:ay, r: rnd(120, 175), dur: rnd(1950, 2350) });
    else if (r < .62) aimed({ kind:"donut", x:ax, y:ay, r1: rnd(55, 70), r2: rnd(190, 230), dur: rnd(2100, 2400) });
    else if (r < .82) aimed({ kind:"lane", x:480, y: ay, hw: rnd(55, 75), x0: XMIN-20, x1: XMAX+20, dur: rnd(2000, 2300) });
    else { const n = 4 + Math.floor(Math.random()*3); for (let i = 0; i < n; i++) aimed({ kind:"circle", x: clamp(ax + rnd(-170,170), XMIN, XMAX), y: ay + rnd(-140, 120), r: rnd(62, 80), dur: 1900 + i*220, small:true }); }
  }
  function hits(h, p){
    if (h.kind === "circle" || h.kind === "plasma" || h.kind === "slam" || h.kind === "gslam") return edist(p, h) < h.r;
    if (h.kind === "beam" || h.kind === "spikes") return segDist(p, { x:h.x0, y:h.y0 }, { x:h.x1, y:h.y1 }) < h.hw;
    if (h.kind === "column") return Math.abs(p.x - h.x) < h.hw && p.y > h.y0 && p.y < h.y1;
    if (h.kind === "donut"){ const d = edist(p, h); return d > h.r1 && d < h.r2; }
    if (h.kind === "lane") return Math.abs(p.y - h.y) < h.hw && p.x > h.x0 && p.x < h.x1;
    return false;
  }
  function landHaz(h){
    const near = Math.abs(h.y - G.camY) < 420;
    if (h.kind === "lane"){ for (let x = XMIN; x <= XMAX; x += 150) G.bolts.push(bolt(x + rnd(-30,30), h.y, 260)); }
    else if (h.kind === "donut"){ for (let a = 0; a < 6; a++){ const ang = a/6*Math.PI*2; G.bolts.push(bolt(h.x + Math.cos(ang)*(h.r1+h.r2)/2, h.y + Math.sin(ang)*(h.r1+h.r2)/2*.55, 260)); } }
    else if (h.kind === "column"){ for (let y = h.y0 + 60; y < h.y1; y += 140) G.bolts.push(bolt(h.x + rnd(-h.hw*.4, h.hw*.4), y, 320)); }
    else if (h.kind === "spikes"){ G.spikeWalls.push({ x0:h.x0, y0:h.y0, x1:h.x1, y1:h.y1, t:0, life:3000 }); if (near) G.shakes = Math.max(G.shakes, 7); }
    else if (h.kind !== "beam" && h.kind !== "gslam") G.bolts.push(bolt(h.x, h.y, 300));
    if (env.isHost && (h.kind === "circle" || h.kind === "donut" || h.kind === "lane") && !h.wire && (CATCHUP.mercy.earthenWire || !mercy()) && G.obsx && G.obsx.state === "up" && Math.hypot(G.obsx.x - (h.kind === "lane" ? G.obsx.x : h.x), G.obsx.y - h.y) < 230){
      const ld = leader(); if (ld){ addHaz({ kind:"circle", x: ld.x, y: ld.y, r: 82, dur: 950, wire:true, wx: G.obsx.x, wy: G.obsx.y - 40 }); toastTo(ld, "Earthen Wire! The lightning was thrown at you!", 1300); }
    }
    if (env.isHost && (h.kind === "circle" || h.kind === "donut" || h.kind === "lane") && G.kirin && Math.abs(G.kirin.y - h.y) < 650) G.kirin.charge = Math.min(3, (G.kirin.charge || 0) + 1);
    if (env.isHost && (h.kind === "circle" || h.kind === "donut" || h.kind === "lane")) for (const m of L.monsters){
      if (m.zone !== "stage" || G.stage !== 2 || G.mode !== "play") continue; const dy = Math.abs(m.y - h.y);
      if (m.key === "kirin" && dy < 520) m.charge = Math.min(3, (m.charge || 0) + 1);            // Lightning Charge
      if (m.key === "prism" && dy < 320 && G.t > (m.overUntil || 0)){ m.overUntil = G.t + 1500;   // Overcharge
        const near = G.players.filter(p => active(p)).sort((a,b) => dist(a,m) - dist(b,m)).slice(0, 3);
        for (const p of near) shoot(m, Math.atan2(p.y - 30 - (m.y - m.h*.45), p.x - (m.x + m.side*-30)), "fast"); m.fire = 220; }
    }
    G.rings.push({ h, t:0 }); sfx.thunder(near ? (h.small ? .5 : 1) : .15); if (near && !h.small) G.shakes = 6;
    if (h.kind === "plasma" && h.owner && h.owner.local && G.mode === "practice" && !hits(h, h.owner)) lesson(h.owner, 3);
    if (env.isHost && h.kind === "plasma" && h.owner && !h.owner.stats && hits(h, h.owner)){ h.owner.size = Math.min(1.6, (h.owner.size || 1) + .15); h.owner.pop = { txt:"Absorbed!", t:0 }; }   // Electro Slime absorbs bolt
    for (const p of G.players){
      if (!p.local || !active(p) || p.state === "shock" || p.state === "ko" || p.state === "auto" || p.state === "wait" || !hits(h, p)) continue;
      if (p.inv > 0){ p.stats.dodges++; if (p.me){ sfx.dodge(); lesson(p, 2); } perfectFX(p); continue; }
      if (p.grace > 0) continue;
      if (h.kind === "gslam"){ p.stats.crushed = (p.stats.crushed || 0) + 1; const ex = p.x - h.x || 1, ey = p.y - h.y, n = Math.hypot(ex, ey) || 1;
        hurt(p, DMG.gslam, { x:ex/n, y:ey/n + .2 }, SQ*2.2, "Crushed!"); continue; }
      const dx = p.x - h.x, dy = p.y - h.y, d = Math.hypot(dx, dy);
      const dir = h.kind === "column" ? { x: p.x >= h.x ? 1 : -1, y: .25 } : (h.kind === "beam" || h.kind === "spikes") ? beamPush(h, p) : h.kind === "lane" ? { x:0, y: p.y >= h.y ? 1 : -1 } : d > 6 ? { x:dx/d*.6, y:Math.max(.5, dy/d) } : { x:0, y:1 };
      if (h.kind === "plasma" && h.owner && h.owner !== p && h.owner.stats){ if (h.owner.local){ h.owner.stats.plasmaHits++; h.owner.pop = { txt:`Got ${p.name}!`, good:true, t:0 }; lesson(h.owner, 3); } else NET.send("credit", { to: h.owner.idx, victim: p.idx }); }
      p.stats.groundHits++;
      hurt(p, dmgOf(h), dir, SQ*(h.kind === "slam" ? 3 : h.kind === "beam" ? 2 : h.kind === "column" ? (h.thin ? 1.8 : 2.5 + .3*(h.charge || 0)) : h.kind === "spikes" ? 1.6 : 2.5)*(p.wet > 0 ? 1.5 : 1)*(h.stack ? 1 + .2*(h.stack - 1) : 1), h.kind === "plasma" ? "Plasma!" : h.kind === "slam" ? "Slammed!" : h.kind === "column" ? "Railstream!" : h.kind === "spikes" ? "Spiked!" : h.wire ? "Rewired!" : "Shocked");
      if (near) G.flash = Math.max(G.flash, .25);
    }
  }
  function spawnOrbs(){
    const s = G.stage, y0 = G.mode === "practice" ? L.PT + 80 : L.T[s] + 120, y1 = G.mode === "practice" ? L.PB - 140 : L.B[s] - 120;
    const n = Math.round((y1 - y0) / 230);
    for (let i = 0; i < n; i++){ const y = y1 - (i+.5)*(y1-y0)/n + rnd(-50,50); for (let k = 0; k < (Math.random() < .4 ? 2 : 1); k++){ const x = rnd(XMIN+30, XMAX-30); if (!L.obs.some(o => Math.hypot(o.x-x,o.y-y) < o.r + 30)) G.orbs.push({ x, y, bob: Math.random()*7, taken:false }); } }
  }
  function spawnOrbNear(){
    // charges blink into being near a random runner; about a third land close enough to walk into by accident
    const run = G.players.filter(p => active(p) && canAct(p)); if (!run.length) return;
    const p = run[Math.floor(Math.random()*run.length)];
    const ahead = Math.random() < .35 ? rnd(50, 130) : rnd(140, 420);
    const x = clamp(p.x + rnd(-170,170), XMIN+20, XMAX-20), y = p.y - ahead;
    if (L.obs.some(o => Math.hypot(o.x-x, o.y-y) < o.r + 26)) return;
    if (G.mode === "play" && G.stage < 2 && y < L.T[G.stage] + 40) return;
    addOrb({ x, y, cx:x, amp: rnd(50, 110), per: rnd(500, 800), ph: Math.random()*4000, bob: Math.random()*7, taken:false, born:0, life: rnd(9000, 14000) });
  }
  function addOrb(o){ o.id = o.id || NET.nextId(); G.orbs.push(o); NET.orb(o); return o; }
  // host only: grant a charge to a runner (or a slime) and start / stack its following strike
  function pickup(p, o){
    o.taken = true;
    const cur = G.haz.find(h => h.kind === "plasma" && h.owner === p && h.t < h.follow);
    let stack = 1;
    if (cur){ cur.stack++; stack = cur.stack; cur.r = 95*(1 + .3*(cur.stack - 1)); cur.follow = Math.min(cur.follow + 400, cur.t + 2000); cur.dur = cur.follow + 900; NET.send("hazStack", { id: cur.id, stack: cur.stack, r: cur.r, follow: cur.follow, dur: cur.dur }); }
    else addHaz({ kind:"plasma", owner:p, x:p.x, y:p.y, r:95, stack:1, dur:2900, follow:2000, chase:122 });
    NET.send("orbTaken", { id: o.id, by: p.stats ? p.idx : -1, sl: p.stats ? null : p.id, stack });
    if (p.stats && p.local) gotCharge(p, stack);
    if (Math.abs(p.y - G.camY) < 400) sfx.pickup();
  }
  // the runner's own client: stamina, a speed burst, the pop
  function gotCharge(p, stack){
    p.stats.pickups++; p.boostStacks = p.boost > 0 ? Math.min(4, (p.boostStacks || 1) + 1) : 1; p.boost = 2400; p.sta = Math.min(p.d.maxSta, p.sta + 25); if (p.winded && p.sta >= p.d.maxSta*MOVE.windedResume) p.winded = false;
    p.pop = stack > 1 ? { txt:"Charged x" + stack + "!", good:true, t:0 } : { txt:"Charged!", good:true, t:0 };
  }
  function toast(txt, dur = 2600){ G.toast = { txt, t:0, dur }; }
  function toastAll(txt, dur){ toast(txt, dur); NET.send("toast", { txt, dur }); }
  function toastTo(p, txt, dur){ if (!p) return; if (p.me) toast(txt, dur); else if (env.isHost && !p.cpu) NET.send("toast", { txt, dur, to: p.idx }); }
  function segDist(p, a, b){ const vx = b.x - a.x, vy = b.y - a.y, t = clamp(((p.x - a.x)*vx + (p.y - a.y)*vy)/(vx*vx + vy*vy || 1), 0, 1); return Math.hypot(p.x - (a.x + vx*t), p.y - (a.y + vy*t)); }
  function beamPush(h, p){ const vx = h.x1 - h.x0, vy = h.y1 - h.y0, L2 = vx*vx + vy*vy || 1, t = clamp(((p.x - h.x0)*vx + (p.y - h.y0)*vy)/L2, 0, 1); const cx = h.x0 + vx*t, cy = h.y0 + vy*t, dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy); return d > 2 ? { x:dx/d, y:dy/d } : { x:-vy/Math.sqrt(L2), y:vx/Math.sqrt(L2) }; }
  function tackle(p, q){
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, push = SQ*1.2*p.d.tackle*q.d.kb;
    const ux = p.dashDir.x*.7 + dx/d*.3, uy = p.dashDir.y*.7 + dy/d*.3, n = Math.hypot(ux, uy) || 1;
    const hit = { by: p.idx, to: q.idx, tx: ux/n*push, ty: uy/n*push, ms: Math.max(250, 420*p.d.tackle*q.d.kb) };
    if (p.local){ p.dashT = Math.min(p.dashT, 40); p.stats.tackles++; p.pop = { txt:"Tackled " + q.name + "!", good:true, t:0 }; }
    if (q.local) tackled(q, hit); else NET.send("tackle", hit);
    if (Math.abs(p.y - G.camY) < 400){ G.shakes = Math.max(G.shakes, 4); sfx.tackle(); }
  }
  function tackled(q, hit){
    if (!q.local) return;
    q.state = "stagger"; q.st = 0; q.dashT = 0; q.staggerMs = hit.ms;
    q.kb = { fx:q.x, fy:q.y, tx:q.x + hit.tx, ty:q.y + hit.ty };
    q.stats.tackled++; q.pop = { txt:"Tackled!", good:false, t:0 };
  }
  // Danmaku shot types: slow and fast plus two status shots from the Valley kits
  const SHOT = {
    slow:   { sp:110, r:12, col:"#c9a4ff", life:6500 },
    fast:   { sp:310, r:6,  col:"#e6f4ff", life:3000 },
    static: { sp:150, r:10, col:"#ffe36b", life:5000 },   // Electro Slime, Static Shot: Paralyzed (brief freeze, no knockback)
    bubble: { sp:85,  r:15, col:"#8fd8ff", life:7500 },   // Ampere, Bubble Splash: big slow bubbles, Wet (slower, lightning knocks you further)
    bubblet:{ sp:250, r:7,  col:"#bfeaff", life:3500 },   // Ampere, Bubble Beam: a quick stream of small bubbles, Wet + a small push
  };
  function shoot(m, ang, kind, delay = 0){ const T = SHOT[kind], sh = { x:m.x + m.side*-30, y:m.y - m.h*.45, vx:Math.cos(ang)*T.sp, vy:Math.sin(ang)*T.sp, r:T.r, col:T.col, kind, delay, life:T.life }; G.shots.push(sh); NET.send("shot", sh); }
  function shotHit(p, s){
    if (s.kind === "bubble" || s.kind === "bubblet"){
      p.wet = 3500; p.hp = Math.max(0, p.hp - DMG[s.kind]); p.hpFlash = G.t;
      if (p.hp <= 0){ hurt(p, 0, { x:0, y:1 }, 0, "Soaked!"); return; }
      if (s.kind === "bubblet"){ const n = Math.hypot(s.vx, s.vy) || 1; p.state = "stagger"; p.st = 0; p.staggerMs = 250; p.kb = { fx:p.x, fy:p.y, tx:p.x + s.vx/n*SQ*.8, ty:p.y + s.vy/n*SQ*.8 }; p.pop = { txt:"Splash!", good:false, t:0 }; }
      else p.pop = { txt:"Wet!", good:false, t:0 };
      return;
    }
    hurt(p, DMG[s.kind] || 10, { x: s.vx, y: Math.abs(s.vy) + 40 }, SQ*(s.kind === "fast" ? 1.2 : .8), "Hit!");
  }
  function leader(){ return G.players.filter(p => active(p) && canAct(p)).sort((a,b) => a.y - b.y)[0]; }
  function nearestRunner(m, range){ return G.players.filter(p => active(p) && Math.abs(p.y - m.y) < range).sort((a,b) => dist(a,m) - dist(b,m))[0]; }
  function snd(m){ if (Math.abs(m.y - G.camY) < 420) sfx.shot(); }
  function updateMonster(m, dt){
    if ((G.mode === "practice") !== (m.zone === "yard")) return;
    const range = m.key === "kirin" ? 950 : 520;
    if (!G.players.some(p => active(p) && Math.abs(p.y - m.y) < range)) return;
    if (m.fire > 0) m.fire -= dt;
    m.cd -= dt;
    const aimAt = p => Math.atan2(p.y - 30 - (m.y - m.h*.45), p.x - (m.x + m.side*-30));
    if (m.key === "slime" && m.cd <= 0){                       // Static Shot: three slow paralysing globs
      m.cd = rnd(2000, 2600); const p = nearestRunner(m, 520); if (!p) return; const a = aimAt(p);
      for (let i = 0; i < 3; i++) shoot(m, a + (i-1)*.14, "static", i*160); m.fire = 220; snd(m);
    }
    if (m.key === "prism" && m.cd <= 0){                       // Fulgur: staggered horizontal beams at the nearest runner; Overcharge (in landHaz) adds fast shots
      const p = nearestRunner(m, 560); if (!p) return; m.cd = rnd(3800, 4600);
      const ox = m.x + m.side*-36, oy = m.y - m.h*.45;
      for (let i = 0; i < 3; i++){ const tx = p.x + rnd(-45,45), ty = p.y - 20 + rnd(-35,35) - i*26, ang = Math.atan2(ty - oy, tx - ox);
        addHaz({ kind:"beam", x:ox, y:oy, x0:ox, y0:oy, x1:ox + Math.cos(ang)*1400, y1:oy + Math.sin(ang)*1400, hw:22, dur:1350 + i*320 }); }
      m.fire = 260; snd(m);
    }
    if (m.key === "ampere" && m.cd <= 0){                      // alternates Bubble Beam (fast stream) and Bubble Splash (slow ring)
      m.cd = rnd(2400, 3000); const p = nearestRunner(m, 520); if (!p) return; const a = aimAt(p);
      if (m.alt){ const off = Math.random()*Math.PI; for (let i = 0; i < 12; i++) shoot(m, off + i/12*Math.PI*2, "bubble"); }
      else { for (let i = 0; i < 6; i++) shoot(m, a + rnd(-.05, .05), "bubblet", i*90); }
      m.alt = !m.alt; m.fire = 220; snd(m);
    }
    if (m.key === "kirin" && m.cd <= 0){                       // Divine Railstream: ONE wide vertical column on whoever is leading; Lightning Charge widens it
      const p = leader(); if (!p) return; m.cd = rnd(4600, 5600); const ch = m.charge || 0; m.charge = 0;
      addHaz({ kind:"column", x:clamp(p.x + rnd(-20, 20), XMIN + 40, XMAX - 40), y:p.y, y0:p.y - 760, y1:p.y + 340, hw:115 + 25*ch, dur:2000, charge:ch });
      m.fire = 320; snd(m); toastTo(p, ch ? "Kirin's charged Railstream is coming down on you!" : "Kirin is aiming at the leader!", 1600);
    }
    if (m.key === "skizzik"){                                  // Lightning Blitz (Quicken): marks a lane, then charges straight across
      if (!m.rush && m.cd <= 0){ const p = nearestRunner(m, 520); if (!p) return; const ang = Math.atan2(p.y - m.y, p.x - m.x), ex = m.side < 0 ? XMAX + 70 : XMIN - 70, ey = m.y + Math.tan(ang)*(ex - m.x);
        m.rush = { fx:m.x, fy:m.y, tx:ex, ty:clamp(ey, m.y - 300, m.y + 300), t:0, warn:380, hit:new Set() }; m.cd = 1e9; }
      if (m.rush){ const r = m.rush; r.t += dt;
        if (r.t > r.warn){ const len = Math.hypot(r.tx - r.fx, r.ty - r.fy), k = Math.min(1, (r.t - r.warn)/(len/780*1000));
          m.x = r.fx + (r.tx - r.fx)*k; m.y = r.fy + (r.ty - r.fy)*k;
          for (const p of G.players){ if (!active(p) || r.hit.has(p) || !(canAct(p) || p.state === "stagger")) continue;
            if (Math.hypot(p.x - m.x, p.y - m.y) < 40){ r.hit.add(p); if (p.inv > 0){ p.stats.dodges++; perfectFX(p); continue; } if (p.grace > 0) continue;
              p.stats.bulletHits++; shock(p, { x:(r.tx - r.fx)/len, y:(r.ty - r.fy)/len + .3 }, SQ*1.6, "Rammed!"); } }
          if (k >= 1){ m.side = -m.side; m.rush = null; m.cd = rnd(2200, 3000); } } }
    }
    if (m.key === "ray"){                                      // Mana Ray: glides in a wave; every few seconds it charges and discharges AROUND ITSELF (only then is it dangerous)
      if (!m.fly){ m.fly = { x: m.side < 0 ? XMIN : XMAX, y: m.homeY, yy: m.homeY, dir: -m.side, t: 0 }; m.pulse = "idle"; m.pt = rnd(300, 1200); }
      const fl = m.fly; fl.t += dt; fl.x += fl.dir*120*dt/1000;
      if (fl.x < XMIN - 20) fl.dir = 1; if (fl.x > XMAX + 20) fl.dir = -1;
      fl.yy = fl.y + Math.sin(fl.t/380)*70;
      m.pt -= dt;
      if (m.pulse === "idle" && m.pt <= 0){ m.pulse = "charge"; m.pt = 800; }
      else if (m.pulse === "charge" && m.pt <= 0){ m.pulse = "live"; m.pt = 550; m.fire = 300; }
      else if (m.pulse === "live"){ if (m.pt <= 0){ m.pulse = "idle"; m.pt = 1500; } }
    }
    if (m.key === "gigas" && m.cd <= 0){                       // Heavy Bodyslam: a huge, slow warning, then everyone inside is flung out
      const p = nearestRunner(m, 520); if (!p) return; m.cd = rnd(5200, 6200); addHaz({ kind:"slam", x:p.x, y:p.y - 20, r:175, dur:2400 }); m.fire = 300;
    }
  }
  // Stage 2 teacher: Electro Slimes wander the field and grab plasma charges exactly like a runner
  function rayHits(m){   // every client: a live Mana Ray discharge against the runners it owns
    if (m.key !== "ray" || !m.fly) return;
    if (m.pulse !== "live"){ m.hit = null; return; }
    if (!m.hit){ m.hit = new Set(); if (Math.abs(m.fly.yy - G.camY) < 420) sfx.thunder(.45); }
    const fl = m.fly;
    for (const p of G.players){ if (!p.local || !active(p) || m.hit.has(p) || !canAct(p) && p.state !== "stagger") continue;
      if (Math.hypot(p.x - fl.x, (p.y - fl.yy)/0.55) < 95){ m.hit.add(p); if (p.inv > 0){ p.stats.dodges++; perfectFX(p); continue; } if (p.grace > 0) continue;
        const dx = p.x - fl.x || 1, dy = p.y - fl.yy, n = Math.hypot(dx, dy) || 1; p.stats.groundHits++; hurt(p, 18, { x: dx/n, y: dy/n + .2 }, SQ*1.6, "Discharge!"); } }
  }
  function updateObsidrax(dt){
    // Obsidrax hunts the leader in Stage 2: burrows after them, erupts a spike wall across their path (Tectonic Collapse),
    // then surfaces for a while; lightning landing near it is re-thrown onto the leader (Earthen Wire)
    for (const w of G.spikeWalls) w.t += dt; G.spikeWalls = G.spikeWalls.filter(w => w.t < w.life);
    const lead = leader(); if (!lead) return;
    if (!G.obsx){ if (G.stage === 1 ? lead.y > L.B[1] - (L.B[1] - L.T[1])*.5 : G.stageT < 6500) return; G.obsx = { x: lead.x < 480 ? XMAX - 40 : XMIN + 40, y: lead.y + 300, state:"burrow", st:0, dust:0 }; toastAll("Something is tunnelling after the leader…", 2200); }
    const o = G.obsx; o.st += dt;
    if (o.state === "burrow"){
      const tx = clamp(lead.x + rnd(-4, 4), XMIN + 40, XMAX - 40), ty = lead.y - 165, dx = tx - o.x, dy = ty - o.y, d = Math.hypot(dx, dy), sp = 240*dt/1000;   /* faster than a run */
      if (d > 1){ o.x += dx/d*Math.min(sp, d); o.y += dy/d*Math.min(sp, d); }
      o.dust += dt; if (o.dust > 70){ o.dust = 0; G.puffs.push({ x: o.x + rnd(-14, 14), y: o.y + rnd(-4, 4), t: 0, dust: true }); }
      if ((d < 30 && o.st > 1400) || o.st > 6000){
        const ang = rnd(-.25, .25), half = 125, cx = clamp(o.x, XMIN + half - 40, XMAX - half + 40);
        const h = addHaz({ kind:"spikes", x: cx, y: o.y, x0: cx - Math.cos(ang)*half, y0: o.y - Math.sin(ang)*half, x1: cx + Math.cos(ang)*half, y1: o.y + Math.sin(ang)*half, hw: 24, dur: 900 });
        o.state = "warn"; o.st = 0; o.haz = h; o.y = h.y; o.x = cx;
        toastTo(lead, "Obsidrax erupts in your path!", 1400);
      }
    } else if (o.state === "warn"){
      if (o.st > 900){ o.state = "up"; o.st = 0; o.x = clamp(o.x + (Math.random() < .5 ? -150 : 150), XMIN + 30, XMAX - 30); }
    } else if (o.state === "up"){
      if (o.st > 2700){ o.state = "burrow"; o.st = 0; }
    }
  }
  function updateKirin(dt){
    // Kirin gallops on the field ahead of whoever is leading and brings one huge column down on them (Divine Railstream)
    const lead = leader(); if (!lead) return;
    if (!G.kirin){ G.kirin = { x: lead.x, y: lead.y - 520, cd: 3500, charge: 0, fire: 0, t: 0, face: 1 }; toastAll("Kirin gallops ahead of the leader!", 2200); }
    const k = G.kirin; k.t += dt; if (k.fire > 0) k.fire -= dt;
    const ty = Math.max(L.hako.y - 60, lead.y - 250), tx = clamp(lead.x + Math.sin(k.t/900)*120, XMIN + 30, XMAX - 30);   /* ~250 px ahead = on the leader's own screen */
    const vx = (tx - k.x)*Math.min(1, dt/600); k.x += vx; k.y += (ty - k.y)*Math.min(1, dt/(Math.abs(ty - k.y) > 400 ? 220 : 450)); if (Math.abs(vx) > .2) k.face = vx > 0 ? 1 : -1;
    k.cd -= dt;
    if (k.cd <= 0){ const tgt = randomRunner() || lead; k.cd = rnd(4800, 5800)*(mercy() ? CATCHUP.mercy.kirinCd : 1); const ch = k.charge || 0, y0 = tgt.y - 760, y1 = tgt.y + 340;
      if (!k.alt){
        // Pattern A, Railstream: one huge column on a random runner (a heavy hit); Lightning Charge widens it
        k.charge = 0;
        addHaz({ kind:"column", x: clamp(tgt.x + rnd(-20, 20), XMIN + 40, XMAX - 40), y: tgt.y, y0, y1, hw: 115 + 25*ch, dur: 2000, charge: ch });
        toastTo(tgt, ch ? "Kirin's charged Railstream is coming down on you!" : "Kirin is aiming at you!", 1600);
      } else {
        // Pattern B, Thunder Rake: a row of thin columns sweeping across the field one after another, with one gap to slip through
        const n = 6, gap = Math.floor(Math.random()*n), ltr = Math.random() < .5, span = (XMAX - XMIN - 40)/(n - 1);
        for (let i = 0; i < n; i++){ if (i === gap) continue; const order = ltr ? i : n - 1 - i;
          addHaz({ kind:"column", thin:true, x: XMIN + 20 + i*span, y: tgt.y, y0, y1, hw: 30, dur: 1400 + order*230, charge: 0 }); }
        toastTo(tgt, "Kirin rakes the field: find the gap!", 1600);
      }
      k.alt = !k.alt; k.fire = 500; if (Math.abs(k.y - G.camY) < 500) sfx.shot(); }
  }
  function updateSkizzik(dt){
    const lead0 = leader(); if (!lead0) return;
    if (G.skiz && (!G.skiz.target || !active(G.skiz.target) || G.skiz.target.finished || G.skiz.target.state === "ko")) G.skiz.target = randomRunner() || lead0;
    const lead = G.skiz ? G.skiz.target : lead0;
    if (!G.skiz){ G.skiz = { side: lead.x < 480 ? 1 : -1, x: 0, y: lead.y + 120, state:"track", cd: 2600, trail: [] }; G.skiz.x = G.skiz.side < 0 ? XMIN - 60 : XMAX + 60; }
    const z = G.skiz;
    if (z.state === "track"){
      // scurry along its cliff to stay level with the leader
      const dy = (lead.y - 10) - z.y; z.y += clamp(dy, -280*dt/1000, 280*dt/1000); z.x = z.side < 0 ? XMIN - 60 : XMAX + 60; z.cd -= dt;
      if (z.cd <= 0 && Math.abs(dy) < 70){
        const ex = z.side < 0 ? XMAX + 60 : XMIN - 60, ang = Math.atan2(lead.y - z.y, lead.x - z.x), ey = clamp(z.y + Math.tan(ang)*(ex - z.x), z.y - 200, z.y + 200);
        z.rush = { fx:z.x, fy:z.y, tx:ex, ty:ey, t:0, warn:380, hit:new Set() }; z.state = "rush"; z.px = z.x; z.py = z.y;
        NET.send("skizRush", { fx:z.x, fy:z.y, tx:ex, ty:ey, warn:380, side:z.side });
      }
    }
  }
  function stepSkizRush(dt){   // every client
    const z = G.skiz; if (!z) return;
    for (const a of z.trail) a.t += dt; z.trail = z.trail.filter(a => a.t < 260);
    if (z.state !== "rush" || !z.rush) return;
    {
      const r = z.rush; r.t += dt;
      if (r.t > r.warn){
        const len = Math.hypot(r.tx - r.fx, r.ty - r.fy), k = Math.min(1, (r.t - r.warn)/(len/1600*1000));   // ~1600 px/s: a blur
        z.px = z.x; z.py = z.y; z.x = r.fx + (r.tx - r.fx)*k; z.y = r.fy + (r.ty - r.fy)*k;
        z.trail.push({ x:z.x, y:z.y, t:0 });
        const ux = (r.tx - r.fx)/len, uy = (r.ty - r.fy)/len;
        for (const p of G.players){
          if (!p.local || !active(p) || r.hit.has(p) || !(canAct(p) || p.state === "stagger")) continue;
          if (segDist(p, { x:z.px, y:z.py }, { x:z.x, y:z.y }) < 40){ r.hit.add(p);
            if (p.inv > 0){ p.stats.dodges++; perfectFX(p); continue; } if (p.grace > 0) continue;
            // FFXIV-style knockback: thrown straight along the blitz, all the way to the edge (rocks still stop you)
            const edge = ux > 0 ? XMAX : XMIN, far = Math.abs(edge - p.x) + 10;
            p.stats.bulletHits++; p.stats.blitzed = (p.stats.blitzed || 0) + 1;
            hurt(p, DMG.blitz, { x: Math.sign(ux) || 1, y: uy*.25 }, far/(p.d.kb || 1), "Blitzed!"); p.st = 440;   // knockback starts at once, no x-ray pause
            if (Math.abs(p.y - G.camY) < 420){ G.shakes = Math.max(G.shakes, 8); sfx.tackle(); }
          }
        }
        if (k >= 1){ z.side = -z.side; z.state = "track"; z.rush = null; z.cd = rnd(2400, 3400)*(mercy() ? CATCHUP.mercy.skizCd : 1); if (env.isHost) z.target = randomRunner(); }
      }
    }
  }
  function drawSkiz(){
    const z = G.skiz, im = imgs.skizzik; if (!im) return;
    const h = 84, w = im.width/im.height*h;
    if (z.state === "rush" && z.rush.t < z.rush.warn){
      const r = z.rush, k = r.t/r.warn, ang = Math.atan2(r.ty - r.fy, r.tx - r.fx), len = Math.hypot(r.tx - r.fx, r.ty - r.fy);
      ctx.save(); ctx.translate(r.fx, r.fy); ctx.rotate(ang);
      ctx.fillStyle = `rgba(255,140,60,${.15 + .3*k})`; ctx.fillRect(0, -30, len, 60); ctx.strokeStyle = "#ff8a3c"; ctx.lineWidth = 3; ctx.strokeRect(0, -30, len, 60);
      for (let i = 1; i < 8; i++){ const ax = len*i/8; ctx.beginPath(); ctx.moveTo(ax - 14, -14); ctx.lineTo(ax, 0); ctx.lineTo(ax - 14, 14); ctx.stroke(); }
      ctx.restore();
    }
    const faceRight = z.state === "rush" ? z.rush.tx > z.rush.fx : z.side < 0;
    // afterimages
    for (const a of z.trail){ const al = .45*(1 - a.t/260); ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = al; ctx.translate(a.x, a.y); if (faceRight) ctx.scale(-1, 1); ctx.drawImage(im, -w/2, -h, w, h); ctx.restore(); }
    if (z.state === "track"){ ctx.fillStyle = "#1a1824"; ctx.beginPath(); ctx.ellipse(z.x, z.y + 4, 50, 15, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.ellipse(z.x, z.y, w*.35, 8, 0, 0, 7); ctx.fill();
    ctx.save(); ctx.translate(z.x, z.y - (z.state === "track" ? Math.abs(Math.sin(G.t/90))*3 : 0)); if (faceRight) ctx.scale(-1, 1); ctx.drawImage(im, -w/2, -h, w, h); ctx.restore();
  }
  function updateGigas(dt){
    // from the halfway mark of the last stage a Gigas hunts the leader, a little faster than a walk; its body slam knocks you out cold
    const lead = leader();
    if (!G.gigas){ if (!lead) return; const half = L.B[2] - (L.B[2] - L.T[2])*.5; if (lead.y > half) return;
      G.gigas = { x: lead.x < 480 ? XMAX + 40 : XMIN - 40, y: lead.y + 260, state:"chase", st:0, face:1, air:0, retarget:0, target:lead, walk:0 };
      toastAll("A Gigas lumbers in, hunting the leader!", 2600); }
    const g = G.gigas;
    if (g.state === "chase"){
      g.retarget -= dt; if (g.retarget <= 0 || !g.target || !active(g.target)){ g.target = lead; g.retarget = 600; }
      const p = g.target; if (!p) return;
      const dx = p.x - g.x, dy = p.y - g.y, d = Math.hypot(dx, dy), sp = MOVE.walk*(mercy() ? CATCHUP.mercy.gigasSpeed : 1.7)*dt/1000;   // faster than a run: it will catch up (slower under MERCY)
      if (d > 1){ g.x += dx/d*Math.min(sp, d); g.y += dy/d*Math.min(sp, d); if (Math.abs(dx) > 2) g.face = dx > 0 ? 1 : -1; g.walk += dt; }
      if (d < 150 && canAct(p)){ g.state = "leap"; g.st = 0; g.jump = { fx:g.x, fy:g.y, tx:p.x, ty:p.y + 4 }; addHaz({ kind:"gslam", x:p.x, y:p.y + 4, r:190, dur:1100 }); }   // wind-up 0.6 s, then the leap lands at 1.1 s
    } else if (g.state === "leap"){
      g.st += dt; const k = Math.min(1, g.st/1100), e = k < .55 ? 0 : (k - .55)/.45;
      g.x = g.jump.fx + (g.jump.tx - g.jump.fx)*e; g.y = g.jump.fy + (g.jump.ty - g.jump.fy)*e; g.air = k < .55 ? -8*(k/.55) : Math.sin(e*Math.PI)*90;
      if (k >= 1){ g.state = "dazed"; g.st = 0; g.air = 0; if (Math.abs(g.y - G.camY) < 420) G.shakes = 12; }
    } else if (g.state === "dazed"){ g.st += dt; if (g.st > (mercy() ? CATCHUP.mercy.gigasDaze : 1700)){ g.state = "chase"; g.retarget = 0; } }
  }
  function struggleTap(p, k){
    if (k === p.lastTap || p.state !== "ko") return;   // must alternate
    p.lastTap = k; p.wiggle = 120; p.koTaps++; p.stats.struggles = (p.stats.struggles || 0) + 1;
  }
  function drawDpad(cx, cy, u, lit){
    // a PlayStation-style D-pad: four arrow-shaped arms around a recessed centre; up/down dimmed so left/right read as the action
    const arm = (dir, on) => {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(dir); ctx.translate(on ? u*.08 : 0, 0);
      const L = u*1.15, Wd = u*.82, tip = u*.32;
      ctx.beginPath(); ctx.moveTo(tip, 0); ctx.lineTo(tip + u*.32, -Wd/2); ctx.lineTo(L, -Wd/2); ctx.quadraticCurveTo(L + u*.12, -Wd/2, L + u*.12, -Wd/2 + u*.12); ctx.lineTo(L + u*.12, Wd/2 - u*.12); ctx.quadraticCurveTo(L + u*.12, Wd/2, L, Wd/2); ctx.lineTo(tip + u*.32, Wd/2); ctx.closePath();
      const g = ctx.createLinearGradient(0, -Wd/2, 0, Wd/2);
      if (on){ g.addColorStop(0, "#fffbe6"); g.addColorStop(1, "#ffd27a"); } else { g.addColorStop(0, "#d8d5e2"); g.addColorStop(1, "#9c98ad"); }
      ctx.fillStyle = g; ctx.strokeStyle = "#2a2536"; ctx.lineWidth = Math.max(1.5, u*.07); ctx.fill(); ctx.stroke();
      if (on){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.shadowColor = "#ffd27a"; ctx.shadowBlur = u*.6; ctx.fill(); ctx.restore(); }
      ctx.fillStyle = on ? "#7a3a00" : "#3a3448"; const gx = tip + u*.62; ctx.beginPath(); ctx.moveTo(gx + u*.22, 0); ctx.lineTo(gx - u*.12, -u*.2); ctx.lineTo(gx - u*.12, u*.2); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    ctx.save();
    ctx.fillStyle = "rgba(20,16,25,.6)"; ctx.beginPath(); ctx.arc(cx, cy, u*1.55, 0, 7); ctx.fill();
    ctx.globalAlpha = .35; arm(-Math.PI/2, false); arm(Math.PI/2, false); ctx.globalAlpha = 1;
    arm(Math.PI, lit === "left"); arm(0, lit === "right");
    ctx.fillStyle = "#2a2536"; ctx.beginPath(); ctx.arc(cx, cy, u*.34, 0, 7); ctx.fill();
    // tap marks beside the lit arm
    if (lit){ const sx = lit === "left" ? -1 : 1; ctx.strokeStyle = "rgba(255,246,200,.9)"; ctx.lineWidth = Math.max(1.5, u*.08); ctx.lineCap = "round";
      for (const a of [-.5, 0, .5]){ const r0 = u*1.75, r1 = u*2.1; ctx.beginPath(); ctx.moveTo(cx + sx*Math.cos(a)*r0, cy + Math.sin(a)*r0); ctx.lineTo(cx + sx*Math.cos(a)*r1, cy + Math.sin(a)*r1); ctx.stroke(); } }
    ctx.restore();
  }
  function struggleLeft(p){ return p.state === "stagger" ? p.staggerMs - p.st : p.state === "shock" ? (p.stunOverride || 0) - p.st : 0; }
  function perfectFX(p){
    // purely visual: a well-timed dash through a hit gets a flourish
    p.pop = { txt:"Perfect!", good:true, t:0 };
    p.sta = Math.min(p.d.maxSta, p.sta + MOVE.dashCost*.6); p.stats.refunded = (p.stats.refunded || 0) + 1;   // 60% of the dash back
    G.fx.push({ kind:"perfect", p, x:p.x, y:p.y, t:0, life:700, seed:Math.random()*7 });
    if (p.me){ G.perfectT = 420; sfx.perfect(); }
  }
  function updateSlimes(dt){
    const run = G.players.filter(p => active(p)); if (!run.length) return;
    const ys = run.map(p => p.y), lead = Math.min(...ys), back = Math.max(...ys);
    G.slimes = G.slimes.filter(sl => sl.y < back + 520 && !sl.gone);
    let tries = 0;
    while (G.slimes.length < 2 && tries++ < 4){ const y = lead - rnd(250, 600); if (G.mode === "play" && y < L.T[G.stage] + 60) break; if (G.mode === "practice" && y < L.PT + 40) break; G.slimes.push({ id: NET.nextId(), x: rnd(XMIN+40, XMAX-40), y, size:1, face:1, air:0, rest: rnd(200, 600) }); }
    for (const sl of G.slimes){
      if (sl.pop){ sl.pop.t += dt; if (sl.pop.t > 1300) sl.pop = null; }
      if (sl.launch){   // flying through the air, spinning; off the edge = gone
        const L2 = sl.launch; L2.t += dt; const k = Math.min(1, L2.t/L2.dur);
        sl.x = L2.fx + (L2.tx - L2.fx)*k; sl.y = L2.fy + (L2.ty - L2.fy)*k; sl.air = Math.sin(k*Math.PI)*70; sl.rot = L2.spin*k;
        if (k >= 1){ sl.launch = null; sl.air = 0; sl.rot = 0; sl.squash = 170; sl.rest = 900; if (sl.x < XMIN - 10 || sl.x > XMAX + 10) sl.gone = true; }
        continue;
      }
      if (sl.squash > 0) sl.squash -= dt;
      if (!sl.jump){
        sl.rest = (sl.rest ?? rnd(200, 500)) - dt;
        if (sl.rest <= 0){
          // pick where to land: usually right in front of the nearest runner (to block them), sometimes a plasma charge
          sl.ignore = sl.ignore || new Map();
          const p = Math.random() > .6 ? null : G.players.filter(q => active(q) && canAct(q) && (sl.ignore.get(q) || 0) < G.t && Math.hypot(q.x - sl.x, q.y - sl.y) < 380).sort((a,b) => Math.hypot(a.x - sl.x, a.y - sl.y) - Math.hypot(b.x - sl.x, b.y - sl.y))[0];
          const o = G.orbs.find(o => !o.taken && o.born > 250 && Math.hypot(o.x - sl.x, o.y - sl.y) < 220);
          let tx, ty;
          if (sl.script && !sl.script.taken){ tx = sl.script.x; ty = sl.script.y; sl.rest = 0; }
          else if (o && (!p || Math.random() < .35)){ tx = o.x; ty = o.y; }
          else if (p){ tx = p.x + rnd(-25, 25); ty = p.y - 75; }
          else { tx = sl.x + rnd(-120, 120); ty = sl.y + rnd(-80, 80); }
          const dx = tx - sl.x, dy = ty - sl.y, d = Math.hypot(dx, dy) || 1, step = Math.min(d, 65);
          sl.jump = { fx:sl.x, fy:sl.y, tx:clamp(sl.x + dx/d*step, XMIN+20, XMAX-20), ty:sl.y + dy/d*step, t:0, dur:430 };
          if (Math.abs(dx) > 2) sl.face = dx > 0 ? 1 : -1;
        }
      } else {
        const j = sl.jump; j.t += dt; const k = Math.min(1, j.t/j.dur);
        sl.x = j.fx + (j.tx - j.fx)*k; sl.y = j.fy + (j.ty - j.fy)*k; sl.air = Math.sin(k*Math.PI)*30;
        if (k >= 1){
          sl.jump = null; sl.air = 0; sl.rest = rnd(320, 620); sl.squash = 170;
          // landing on a runner squashes them aside (each client judges its own runners)
          for (const p of G.players) if (Math.hypot(p.x - sl.x, p.y - sl.y) < 34*sl.size) (sl.ignore = sl.ignore || new Map()).set(p, G.t + 3500);
          NET.send("slimeLand", { x: sl.x, y: sl.y, size: sl.size }); slimeLand(sl);
        }
      }
      for (const o of G.orbs){ if (o.taken || o.born < 250 || (sl.air || 0) > 12) continue;
        if (Math.hypot(o.x - sl.x, o.y - sl.y) < 28){ pickup(sl, o); sl.pop = { txt:"Bzzt!", t:0 };
          if (!G.slimeTaught && G.mode === "play"){ G.slimeTaught = true; sl.script = null;
            toastAll("The Slime grabbed a Plasma Charge: it gets energy, but a strike now follows it. You can grab them too!", 4200); } } }
      if (!sl.jump && !sl.script) for (const p of G.players) if (Math.hypot(p.x - sl.x, p.y - sl.y) < 26*sl.size) (sl.ignore = sl.ignore || new Map()).set(p, G.t + 2500);
    }
  }
  function slimeLand(sl){   // every client: a slime landed here; squash the runners this client owns
    for (const p of G.players){ if (!p.local || !active(p) || !canAct(p) || p.grace > 0 || p.inv > 0) continue;
      if (Math.hypot(p.x - sl.x, p.y - sl.y) < 34*sl.size){ const ex = p.x - sl.x || 1, ey = p.y - sl.y, n = Math.hypot(ex, ey) || 1;
        p.state = "stagger"; p.st = 0; p.staggerMs = 380; p.kb = { fx:p.x, fy:p.y, tx:p.x + ex/n*SQ*1.2, ty:p.y + ey/n*SQ*1.2 + 10 }; p.pop = { txt:"Squashed!", good:false, t:0 }; p.grace = 900; } }
  }
  function slimeBumps(){   // every client: walking into a slime on the ground bounces you off it
    for (const sl of G.slimes){ if (sl.jump || sl.script || sl.launch || (sl.air || 0) > 4) continue;
      for (const p of G.players){ if (!p.local || !active(p) || !canAct(p) || p.grace > 0 || p.inv > 0) continue;
        if (Math.hypot(p.x - sl.x, p.y - sl.y) < 26*sl.size){ const ex = p.x - sl.x || 1, ey = p.y - sl.y, n = Math.hypot(ex, ey) || 1;
          p.state = "stagger"; p.st = 0; p.staggerMs = 260; p.kb = { fx:p.x, fy:p.y, tx:p.x + ex/n*SQ*.8, ty:p.y + ey/n*SQ*.8 }; p.pop = { txt:"Boing!", good:false, t:0 }; p.grace = 600; } } }
  }
  // damage per hit; the big monster moves (Kirin's column, Gigas, Skizzik) simply hit harder
  const DMG = { spikes:20, wire:18, circle:22, small:14, donut:22, lane:22, plasma:25, slam:30, beam:20, column:45, thin:18, gslam:60, fast:12, slow:10, bubble:6, bubblet:6, blitz:35 };
  function dmgOf(h){
    if (h.kind === "column") return h.thin ? DMG.thin : DMG.column + 5*(h.charge || 0);
    if (h.kind === "plasma") return Math.round(DMG.plasma*(1 + .2*((h.stack || 1) - 1)));
    if (h.kind === "circle" && h.small) return DMG.small;
    return DMG[h.kind] || 20;
  }
  function hurt(p, dmg, dir, kb, label){
    p.hp = Math.max(0, p.hp - dmg); p.hpFlash = G.t; p.stats.dmgTaken = (p.stats.dmgTaken || 0) + dmg;
    shock(p, dir, kb, label);
    if (p.hp <= 0) p.koPending = true;   // knocked out once the hit's own stun ends
  }
  function randomRunner(){ const r = G.players.filter(p => active(p) && !p.finished && p.state !== "ko"); return r[Math.floor(Math.random()*r.length)]; }
  function shock(p, dir, kb, label){
    p.state = "shock"; p.st = 0; p.kbDir = dir; p.kbLen = kb * p.d.kb; p.kb = null; p.stats.shocks++; p.pop = { txt: label, good:false, t:0 }; p.dashT = 0;
  }
  function bolt(x, y, life){
    const pts = []; const cx = x + rnd(-60,60), cy = y - 700, n = 11;
    for (let i=0;i<=n;i++){ const t = i/n; pts.push([ (1-t)*cx + t*x + (i && i<n ? rnd(-26,26) : 0), (1-t)*cy + t*y ]); }
    const forks = []; for (let k=0;k<2;k++){ const i = 3 + Math.floor(Math.random()*6); const [fx,fy] = pts[i]; forks.push([[fx,fy],[fx+rnd(-60,60),fy+rnd(30,80)],[fx+rnd(-90,90),fy+rnd(80,140)]]); }
    return { x, y, pts, forks, life, t:0 };
  }

  // ---------- movement ----------
  function bounds(){
    if (G.mode === "practice") return { ymin: L.PT - 120, ymax: L.PB + 40 };
    if (G.stage < 0) return { ymin: 0, ymax: L.WORLD_H };
    const s = G.stage; return { ymin: 0, ymax: s === 0 ? L.START_Y + 40 : L.B[s] + 120 };
  }
  function collide(p){
    for (const o of L.obs){ const dx = p.x-o.x, dy = p.y-o.y, d = Math.hypot(dx,dy), m = o.r + 14; if (d < m && d > .01){ p.x = o.x + dx/d*m; p.y = o.y + dy/d*m; } }
    for (const pl of L.pillars){ const dx = p.x-pl.x, dy = p.y-pl.y, d = Math.hypot(dx,dy); if (d < 52 && d > .01){ p.x = pl.x + dx/d*52; p.y = pl.y + dy/d*52; } }
    if (G && G.spikeWalls) for (const w of G.spikeWalls){ if (w.t > w.life - 250) continue; const n = 10;
      for (let i = 0; i <= n; i++){ const cx = w.x0 + (w.x1 - w.x0)*i/n, cy = w.y0 + (w.y1 - w.y0)*i/n, dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy); if (d < 30 && d > .01){ p.x = cx + dx/d*30; p.y = cy + dy/d*30; } } }
    { const hx = L.hako.x, hy = L.hako.y + 26, dx = p.x-hx, dy = p.y-hy, d = Math.hypot(dx,dy); if (d < 62 && d > .01){ p.x = hx + dx/d*62; p.y = hy + dy/d*62; } }   /* the root pedestal is solid */
    const b = bounds(); p.x = clamp(p.x, XMIN, XMAX); p.y = clamp(p.y, b.ymin, b.ymax);
  }
  function stepPlayer(p, dt){
    if (!p.local){ stepRemote(p, dt); return; }
    if (p.inv > 0) p.inv -= dt; if (p.dashCd > 0) p.dashCd -= dt; if (p.grace > 0) p.grace -= dt; if (p.wet > 0) p.wet -= dt; if (p.boost > 0){ p.boost -= dt; if (p.boost <= 0) p.boostStacks = 0; }
    if (p.pop){ p.pop.t += dt; if (p.pop.t > 1100) p.pop = null; }
    if (p.soot > 0) p.soot = Math.max(0, p.soot - dt/1600);
    const wind = inLastPlace(p);
    if (wind && !p.windOn){ p.windOn = true; p.pop = { txt:"Second wind!", good:true, t:0 }; } else if (!wind) p.windOn = false;
    if (p.state !== "shock" && G.t - p.lastSpend > MOVE.regenDelay*(wind ? CATCHUP.secondWind.delay : 1) && p.sta < p.d.maxSta){ p.sta = Math.min(p.d.maxSta, p.sta + p.d.regen*(p.winded ? MOVE.windedRegen : 1)*(wind ? CATCHUP.secondWind.regen : 1)*dt/1000); if (p.winded && p.sta >= p.d.maxSta*MOVE.windedResume){ p.winded = false; if (p.me) sfx.ready(); } }
    if (p.state === "ko"){   // out of HP: mash left/right (alternating) to get back up with full HP
      p.st += dt;
      if (p.koTaps >= p.koNeed || p.st > 9000){ p.state = "idle"; p.hp = p.hpMax; p.grace = 1500; p.pop = { txt:"Back up!", good:true, t:0 }; }
      return;
    }
    if (p.state === "stagger"){
      p.st += dt; const t = Math.min(1, p.st/220), e = 1 - Math.pow(1-t,3);
      p.x = p.kb.fx + (p.kb.tx - p.kb.fx)*e; p.y = p.kb.fy + (p.kb.ty - p.kb.fy)*e; collide(p);
      if (p.st > p.staggerMs){ p.state = "idle"; p.kb = null; }
      return;
    }
    if (p.state === "shock"){
      p.st += dt;
      if (p.noKnock){ if (p.st > 560){ p.state = "idle"; p.noKnock = false; } return; }
      if (p.st > 450 && !p.kb){ const d = Math.hypot(p.kbDir.x, p.kbDir.y) || 1; p.soot = 1; p.kb = { fx:p.x, fy:p.y, tx: p.x + p.kbDir.x/d*p.kbLen, ty: p.y + p.kbDir.y/d*p.kbLen }; }
      if (p.kb){ const t = Math.min(1, (p.st-450)/320), e = 1 - Math.pow(1-t,3), y0 = p.y; p.x = p.kb.fx + (p.kb.tx-p.kb.fx)*e; p.y = p.kb.fy + (p.kb.ty-p.kb.fy)*e; collide(p); p.stats.lost += Math.max(0, p.y - y0); }
      if (p.st > (p.stunOverride || Math.max(800, p.d.stun))){ p.kb = null; p.stunOverride = 0;
        if (p.koPending){ p.koPending = false; p.state = "ko"; p.st = 0; p.koTaps = 0; p.koNeed = 24; p.lastTap = null; p.koAt = G.t; p.stats.kos = (p.stats.kos || 0) + 1; p.pop = { txt:"Knocked out!", good:false, t:0 }; }
        else { p.state = "idle"; p.grace = 1000; } }   // 1 s of blinking grace so nobody gets stun-locked
      return;
    }
    if (p.state === "auto" || p.state === "wait"){
      if (!p.mark){ p.state = "wait"; return; }
      const dx = p.mark.x - p.x, dy = p.mark.y - p.y, d = Math.hypot(dx,dy);
      if (d < 3){ p.x = p.mark.x; p.y = p.mark.y; p.state = "wait"; return; }
      const sp = Math.min(d, 170*dt/1000); turnToward(p, dx, dy); p.x += dx/d*sp; p.y += dy/d*sp; p.walkT += dt; return;
    }
    if (p.state === "dash"){
      p.dashT -= dt; const sp = p.d.dashSpeed*dt/1000; turnToward(p, p.dashDir.x, p.dashDir.y); p.x += p.dashDir.x*sp; p.y += p.dashDir.y*sp; collide(p); p.walkT += dt*2;
      if (p.dashT <= 0) p.state = "idle"; return;
    }
    if (!isLive() || !active(p)){ p.state = "idle"; return; }
    let ix = 0, iy = 0, run = false;
    if (p.me && !env.autopilot){ if (G.inputOk){ const d = inputDir(); ix = d.x; iy = d.y; run = !!keys.z; } }
    else { botThink(p); ix = p.ix; iy = p.iy; run = p.wantRun; if (p.wantDash){ p.wantDash = false; if (tryDash(p, { x:p.dashX, y:p.dashY })) return; } }
    const len = Math.hypot(ix,iy);
    if (len > 0){
      const canRun = run && !p.winded && p.sta > 0;
      const sp = p.d.walk * (canRun ? MOVE.runMul : p.winded ? MOVE.windedWalk : 1) * (p.wet > 0 ? .8 : 1) * (p.boost > 0 ? 1 + .15*(p.boostStacks || 1) : 1) * dt/1000;
      if (canRun){ spend(p, MOVE.runCost*dt/1000); p.stats.runMs += dt; if (p.me) lesson(p, 0); }
      turnToward(p, ix, iy); p.x += ix/len*sp; p.y += iy/len*sp; p.walkT += dt*(canRun ? 1.6 : 1); p.state = canRun ? "run" : "walk";
    } else p.state = "idle";
    collide(p);
  }
  // ---------- CPU ----------
  function botThink(p){
    const b = p.bot || BOT.Same; p.ix = 0; p.iy = 0; p.wantRun = false;
    const movedSince = p.sx == null ? 1 : Math.hypot(p.x - p.sx, p.y - p.sy); p.sx = p.x; p.sy = p.y;
    let threat = null;
    for (const h of G.haz){
      const left = h.dur - h.t;
      if (h.kind === "plasma" && h.owner === p && h.t < h.follow){ if (!threat || left < threat.left) threat = { h, left, own:true }; continue; }
      if (h.kind !== "plasma" && h.t < h.dur - p.d.lead) continue;     // I can't see it yet (INS)
      if (hits(h, p) && (!threat || left < threat.left)) threat = { h, left };
    }
    if (!threat) p.noticeAt = null; else if (p.noticeAt == null) p.noticeAt = G.t + rnd(b.react[0], b.react[1]);
    if (threat && G.t >= p.noticeAt){
      const h = threat.h;
      if (threat.own){
        const rival = p.grabMode ? G.players.find(q => q !== p && active(q) && canAct(q) && dist(q,p) < 280) : null;
        if (rival){ p.ix = rival.x - p.x; p.iy = rival.y - p.y; p.wantRun = p.sta > 20; }
        else { p.ix = (480 - p.x)*.002; p.iy = -1; p.wantRun = p.sta > MOVE.dashCost + 5; }
        return;
      }
      let ex = 0, ey = 0, need = 0;
      if (h.kind === "column"){ ex = p.x >= h.x ? 1 : -1; ey = 0; need = h.hw - Math.abs(p.x - h.x) + 10; }
      else if (h.kind === "beam" || h.kind === "spikes"){ const v = beamPush(h, p); ex = v.x; ey = v.y; need = h.hw - segDist(p, { x:h.x0, y:h.y0 }, { x:h.x1, y:h.y1 }) + 10; }
      else if (h.kind === "lane"){ const up = h.hw + (p.y - h.y) + 10, down = h.hw - (p.y - h.y) + 10; if (up <= down){ ey = -1; need = up; } else { ey = 1; need = down; } }
      else if (h.kind === "donut"){ const d = edist(p, h), mid = (h.r1 + h.r2)/2, dx = p.x - h.x || .1, dy = p.y - h.y, n = Math.hypot(dx,dy) || 1;
        if (d < mid){ ex = -dx/n; ey = -dy/n; need = (d - h.r1)*.6 + 8; } else { ex = dx/n; ey = dy/n; need = (h.r2 - d)*.6 + 8; } }
      else { const dx = p.x - h.x || (Math.random()-.5), dy = p.y - h.y, n = Math.hypot(dx,dy) || 1; ex = dx/n; ey = dy/n*.7 - .3; need = (h.r - edist(p, h))*.7 + 10; }
      const left = threat.left/1000;
      const walkOk = need / p.d.walk < left - .1, runOk = need / (p.d.walk*MOVE.runMul) < left - .05 && !p.winded && p.sta > 12;
      p.ix = ex; p.iy = ey;
      if (!walkOk && runOk) p.wantRun = true;
      if (!walkOk && !runOk){
        const err = rnd(b.dashErr[0], b.dashErr[1]);
        if (threat.left <= p.d.iframe - 40 + err && !p.winded && p.sta >= MOVE.dashCost && p.dashCd <= 0){ p.wantDash = true; p.dashX = ex; p.dashY = ey; }
        else p.wantRun = !p.winded && p.sta > 10;
      }
      return;
    }
    for (const s of G.shots){ if (s.delay > 0) continue; const tx = (p.x - s.x)*s.vx + (p.y - 30 - s.y)*s.vy, v2 = s.vx*s.vx + s.vy*s.vy, tt = tx / v2; if (tt < 0 || tt > .35) continue;
      const cx = s.x + s.vx*tt, cy = s.y + s.vy*tt; if (Math.hypot(cx - p.x, cy - (p.y - 30)) < 30){
        if (tt < .22 && Math.random() < .55 && !p.winded && p.sta >= MOVE.dashCost && p.dashCd <= 0){ p.wantDash = true; p.dashX = -s.vy; p.dashY = s.vx; return; }
        p.ix = -s.vy; p.iy = s.vx; return; } }
    if (b.tackle && !p.winded && p.sta >= MOVE.dashCost + 15 && p.dashCd <= 0 && Math.random() < b.tackle*.016){
      const q = G.players.find(q => q !== p && active(q) && canAct(q) && dist(q,p) < 95 && dist(q,p) > 25);
      if (q){ p.wantDash = true; p.dashX = q.x - p.x; p.dashY = q.y - p.y; return; }
    }
    if (G.skiz && G.skiz.state === "rush" && G.skiz.rush.t < G.skiz.rush.warn && !G.skiz.rush.seen?.has(p)){
      const r = G.skiz.rush; (r.seen = r.seen || new Set()).add(p);
      if (segDist(p, { x:r.fx, y:r.fy }, { x:r.tx, y:r.ty }) < 60 && Math.random() < .45 && !p.winded && p.sta > 0 && p.dashCd <= 0){ p.wantDash = true; p.dashX = 0; p.dashY = -1; return; }
    }
    for (const m of L.monsters){ if (m.key !== "ray" || !m.fly || (m.pulse !== "charge" && m.pulse !== "live")) continue;
      const dx = p.x - m.fly.x, dy = p.y - m.fly.yy, d = Math.hypot(dx, dy/0.55);
      if (d < 135 && G.t >= (p.rayNotice ??= G.t + rnd(b.react[0], b.react[1]))){ p.ix = dx/(d || 1); p.iy = dy/(d || 1)*.6; p.wantRun = !p.winded && p.sta > 20; return; }
      if (d >= 135) p.rayNotice = null;
    }
    let ty, tx = 480 + (p.idx - 1.5)*70;
    if (G.mode === "practice"){ ty = p.goReady ? L.PT - 80 : L.PB - 260 + Math.sin(G.t/1500 + p.idx)*200; } else if (G.stage < 2) ty = L.T[G.stage] - 40; else { ty = G.hako.y + 62; tx = G.hako.x + (p.idx - 1.5)*22; }
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx,dy) || 1; p.ix = dx/d; p.iy = dy/d;
    for (const o of L.obs){ const ax = o.x - p.x, ay = o.y - p.y; if (Math.hypot(ax,ay) < o.r + 46 && ay < 10 && Math.abs(ax) < o.r + 30) p.ix += (ax > 0 ? -1 : 1) * 1.1; }
    if (Math.random() < .002) p.grabMode = Math.random() < b.grabby;
    for (const o of G.orbs){ if (o.taken) continue; const ax = o.x - p.x, ay = o.y - p.y; if (Math.hypot(ax, ay) < 70 && ay < 0){ const rivalsNear = G.players.some(q => q !== p && active(q) && dist(q,p) < 240); if (!(p.grabMode && rivalsNear) && p.sta > 40) p.ix += (ax > 0 ? -1 : 1) * 1.2; } }
    let pushRun = false;
    for (const h of G.haz){
      if (h.kind === "plasma" ? h.t < h.follow : h.t < h.dur - p.d.lead) continue;
      const left = (h.dur - h.t)/1000; if (!hits(h, { x:p.x + p.ix*45, y:p.y + p.iy*45 })) continue;
      if (h.kind === "lane"){ const need = p.y - (h.y - h.hw) + 12; if (need/(p.d.walk*MOVE.runMul) < left - .15 && p.sta > 30 && !p.winded){ pushRun = true; } else { p.ix = 0; p.iy = 0; } }
      else { p.ix = p.x < h.x ? -1 : 1; p.iy = -.35; }
      break;
    }
    p.wantRun = pushRun || (!p.winded && p.sta > b.runKeep);
    p.stuck = (movedSince < .3 && p.prevWanted) ? (p.stuck||0) + 16 : 0; p.prevWanted = !!(p.ix || p.iy);
    if (p.stuck > 500) p.ix += (Math.random() < .5 ? -1 : 1) * 2;
  }

  // ---------- round flow ----------
  function setReady(p){ if (p.ready) return; p.ready = true; p.pop = { txt:"Ready!", good:true, t:0 }; sfx.ready(); renderPracticeBar(); if (p.local) NET.send("ready", { i: p.idx }); }
  function resetField(){ G.haz = []; G.orbs = []; G.shots = []; G.slimes = []; G.spikeWalls = []; G.obsx = null; G.kirin = null; G.gigas = null; G.skiz = null; for (const m of L.monsters){ m.aim = null; m.rush = null; m.fly = null; m.charge = 0; m.side = m.homeSide ?? m.side; m.x = m.side < 0 ? XMIN - 70 : XMAX + 70; m.y = m.homeY ?? m.y; m.cd = rnd(600, 1600); } }
  function startPractice(){
    clearOv(); G.mode = "practice"; G.stage = -1; G.practiceT = 0; resetField(); G.groundNext = 800; G.orbsSpawnedForLesson = false;
    G.players.forEach((p,i) => { p.x = L.yardMarks[i].x; p.y = L.yardMarks[i].y; p.state = "idle"; p.ready = false; p.lesson = 1; p.lessonDone = {}; p.botReadyAt = rnd(24000, 34000); p.sta = p.d.maxSta; p.winded = false; p.hp = p.hpMax; p.net = []; });
    renderPracticeBar();
  }
  function renderPracticeBar(){
    if (G.mode !== "practice") return;
    let bar = ov.querySelector(".mg-pbar");
    if (!bar){ bar = document.createElement("div"); bar.className = "ready-bar mg-pbar"; ov.appendChild(bar); }
    const waiting = G.players.filter(p => !p.ready).map(p => p.name);
    if (!isRunner()){
      bar.innerHTML = `<span class="btn ghost" aria-disabled="true">Waiting on: ${waiting.join(", ") || "nobody"}</span>${env.isGM ? ` <button class="btn primary" data-mg="start-race">Start the race now</button>` : ""}`;
      const b = bar.querySelector('[data-mg="start-race"]'); if (b) b.onclick = () => { if (env.isHost) hostFlow("endPractice"); else NET.send("gmStart", {}); };
      return;
    }
    const m = me();
    bar.innerHTML = m.ready ? `<span class="btn" aria-disabled="true">On the starting line. Waiting for: ${waiting.join(", ")}</span>` : `<span class="btn ghost" aria-disabled="true">Walk up onto the starting line when you're ready</span>`;
  }
  // s = the stage the race opens on (a playtest can start at 2 or 3: runners stand on the pillar plaza before it)
  function endPractice(s = START_STAGE, fromPractice = true){
    G.mode = "transition"; if (fromPractice) G.banner = { txt:"Practice over!", t:0, dur:1400 }; resetField(); closeTutorial(); G.inputOk = true;
    later(fromPractice ? 1300 : 0, () => fadeTo(() => {
      const marks = s > 0 ? L.marks(s - 1) : L.startMarks;
      G.players.forEach((p,i) => { p.x = marks[i].x; p.y = marks[i].y; p.state = "idle"; p.soot = 0; p.stats = newStats(); p.sta = p.d.maxSta; p.winded = false; p.net = []; });
      G.camY = (s > 0 ? marks[0].y + 30 : L.START_Y) - 120;
      if (env.isHost) later(500, () => hostFlow("stage", { s }));
    }));
  }
  const SHOW_STAGE_CARDS = false;   /* the per-stage rule cards; switched off (the game explains itself), kept for later */
  function showStageCard(s){
    if (!SHOW_STAGE_CARDS){ G.stage = s; clearOv(); startStage(s); return; }
    G.mode = "card"; G.stage = s; clearOv();
    const st = STAGES[s];
    ov.innerHTML = `<div class="parch card"><div class="eyebrow">Stage ${s+1} of 3</div><h2><b>${st.name}</b></h2>
      <p>${st.rule}</p>${st.newRule ? `<p><span class="new">New rule</span> ${st.newRule}</p>` : ""}
      <p class="ex">First to the ${s < 2 ? "Lightning Pillar" : "plasma ring around Hako"} wins the round. ${G.limit === Infinity ? "No time limit on a first play; the GM can call the round. Replays add a time limit." : "Time limit " + fmt(G.limit) + "; anyone still out when it runs out is brought in with 0 points."} Stamina refills between stages.</p>
      <div class="row"><span class="ex" style="margin-right:auto">In game: all 4 players press Ready.</span><button class="btn primary" id="b-go">Ready</button></div></div>`;
    document.getElementById("b-go").onclick = () => startStage(s);
  }
  function startStage(s){
    clearOv(); G.stage = s; G.mode = "countdown"; G.cd = 2100; G.cdLast = 99; G.placeN = 0; G.stageT = 0; resetField();
    G.groundNext = rnd(900, 1500); G.orbNext = rnd(500, 1200);
    if (s === 1){
      const y0 = L.B[1] - 170;
      if (env.isHost){ const orb = addOrb({ x: 540, y: y0, cx: 540, amp: 0, per: 600, ph: 0, bob: 1, taken:false, born: 9999, life: 30000, lesson:true });
        G.slimes.push({ id: NET.nextId(), x: 330, y: y0 + 30, size:1, face:1, air:0, rest: 500, script: orb }); }
      G.groundNext = 4500; G.orbNext = 3500; G.slimeTaught = false;
    }
    if (G.limit === Infinity && env.isGM){ const d = document.createElement("div"); d.className = "ready-bar"; d.innerHTML = '<button class="btn ghost" data-mg="call">Call the round</button>'; ov.appendChild(d);
      d.querySelector("button").onclick = () => { if (G.mode === "play"){ if (env.isHost) hostCallRound(); else NET.send("gmCall", {}); } }; }
    for (const p of G.players){ p.running = true; p.finished = false; p.state = "idle"; p.mark = null; p.timedOut = false; p.sta = p.d.maxSta; p.winded = false; p.hp = p.hpMax; p.goalSent = false; p.koPending = false; p.grace = 0; p.boost = 0; p.boostStacks = 0; }
  }
  function finish(p, place, time){
    p.running = false; p.finished = true; G.haz = G.haz.filter(h => !(h.owner === p && h.t < h.follow));
    G.placeN = Math.max(G.placeN, place); const pts = POINTS[place-1];
    p.stats.points += pts; p.stats.places[G.stage] = { place, pts, time: time ?? G.stageT, timeout:false };
    if (place === 1){ p.stats.wins++; G.banner = { txt: `${p.name} wins Round ${G.stage+1}!`, t:0, dur:1800 }; sfx.fanfare(); }
    const m = L.marks(G.stage); p.mark = G.stage < 2 ? m[p.idx] : m[place-1]; p.state = "auto";
  }
  function timeUp(order){
    const left = order ? order.map(i => G.players[i]).filter(p => p && p.running) : G.players.filter(p => p.running).sort((a,b) => a.y - b.y);
    G.banner = { txt:"Time's up!", t:0, dur:1500 }; G.flash = .4;
    for (const p of left){
      p.running = false; p.finished = true; const place = ++G.placeN; p.stats.timeouts++;
      p.stats.places[G.stage] = { place, pts:0, time:G.stageT, timeout:true };
      const m = L.marks(G.stage); p.mark = G.stage < 2 ? m[p.idx] : m[place-1]; p.x = p.mark.x; p.y = p.mark.y + 4; p.state = "wait"; p.timedOut = true;
    }
  }
  function roundOver(){ G.mode = "roundEnd"; resetField(); later(1600, () => { if (G.mode === "roundEnd") showRoundResults(); }); }
  function showRoundResults(){
    const s = G.stage;
    const rows = [...G.players].sort((a,b) => a.stats.places[s].place - b.stats.places[s].place).map(p => {
      const r = p.stats.places[s];
      return `<tr class="${r.place===1?"top":""}"><td>${r.place}</td><td>${esc(p.name)}${p.me?" (you)":""}${p.cpu?' <span class="ex">CPU</span>':""}</td><td>${r.timeout ? "Time's up" : fmt(r.time)}</td><td>+${r.pts}</td><td>${p.stats.points}</td></tr>`; }).join("");
    ov.innerHTML = `<div class="parch card"><div class="eyebrow">Round ${s+1} results</div><h2><b>${STAGES[s].name}</b></h2>
      <div class="tw"><table class="res"><tr><th>#</th><th>Player</th><th>Time</th><th>Pts</th><th>Total</th></tr>${rows}</table></div>
      <div class="row">${env.isGM ? `<button class="btn primary" data-mg="next">${s < 2 ? `Next: ${STAGES[s+1].name}` : "Rescue Hako"}</button>` : `<span class="ex mg-auto">The next round starts shortly…</span>`}</div></div>`;
    const nb = ov.querySelector('[data-mg="next"]'); if (nb) nb.onclick = () => { nb.disabled = true; if (env.isHost) hostNext(); else NET.send("gmNext", {}); };
    if (env.isHost){ G.autoNext = G.t + 15000; G.autoNextStage = s; }
  }
  function startFinale(rescuer){
    clearOv(); G.mode = "finale"; G.ft = 0; G.faced = false; G.lastZap = false;
    const champ = G.players[rescuer] || [...G.players].sort((a,b) => a.stats.places[2].place - b.stats.places[2].place)[0];
    G.rescuer = champ; champ.mark = { x: G.hako.x + (champ.x < G.hako.x ? -86 : 86), y: G.hako.y + 70 }; champ.state = "auto";
    music.victory();
  }
  function runFinale(dt){
    G.ft += dt; const h = G.hako, p = G.rescuer, T = G.ft;
    if (T > 1500 && !h.freed){ h.freed = true; h.from = { x:h.x, y:h.y }; sfx.fanfare(); }
    if (h.freed && T < 2300){ const t = clamp((T - 1500)/600, 0, 1); h.perch = 1 - ease(t); h.lift = Math.sin(t*Math.PI)*40;   /* hops down from the cradle */ h.x = h.from.x + ((p.x + (p.x < 480 ? 58 : -58)) - h.from.x)*ease(t); h.y = h.from.y + (p.y + 4 - h.from.y)*ease(t); }
    if (T > 2300 && !G.faced){ h.perch = 0; h.lift = 0;   // the winner turns diagonally down toward Hako; Hako turns to them
      G.faced = true; p.state = "idle"; p.slot = "downleft"; p.mirror = h.x > p.x; p.faceAng = null; h.mirror = p.x > h.x;
    }
    if (T > 2450 && !G.lastZap){   // both jump for joy...
      const ph = (T - 2450)/400; p.lift = Math.abs(Math.sin(ph*Math.PI))*26; h.lift = Math.abs(Math.sin((ph - .15)*Math.PI))*26;
    }
    if (T > 3550 && !G.lastZap){   // ...until a huge bolt lands on them both and the fanfare dies
      G.lastZap = true; p.lift = 0; h.lift = 0; music.stop();
      const mx = (p.x + h.x)/2; for (const ox of [-30, 0, 30]) G.bolts.push(bolt(mx + ox, p.y - 10, 700));
      h.zap = 700; p.state = "shock"; p.st = 0; p.noKnock = true; p.charred = true; G.flash = .95; G.shakes = 16; sfx.thunder(1.6);
    }
    if (G.lastZap){ p.soot = 1; if (Math.random() < .25) G.puffs.push({ x: h.x + rnd(-16, 16), y: h.y - 120, t:0 }); }
    if (G.lastZap && T > 4300 && !G.eyesPopped){ G.eyesPopped = true; sfx.blink(); }
    if (G.eyesPopped && !G.blinkTimes){ G.blinkTimes = [5100, 5700, 5850, 6650]; }
    if (G.blinkTimes) for (const b of G.blinkTimes) if (T > b && !G["bl" + b]){ G["bl" + b] = true; sfx.blink(); }
    if (T > 7400 && G.mode === "finale" && env.isHost && !G.summarySent){ G.summarySent = true; hostFlow("summary", buildSummary()); }
  }
  const TITLES = [
    { key:"plasmaHits", name:"Troublemaker",    fmt:v => `dropped plasma on someone ${v} time${v>1?"s":""}` },
    { key:"dodges",     name:"Untouchable",     fmt:v => `dashed through ${v} strikes` },
    { key:"shocks",     name:"Lightning Rod",   fmt:v => `shocked ${v} times` },
    { key:"winded",     name:"Out of Breath",   fmt:v => `ran out of stamina ${v} time${v>1?"s":""}` },
    { key:"bulletHits", name:"Target Practice", fmt:v => `hit by ${v} monster shot${v>1?"s":""}` },
    { key:"pickups",    name:"Battery",         fmt:v => `grabbed ${v} plasma charge${v>1?"s":""}` },
    { key:"runMs",      name:"Marathoner",      fmt:v => `ran for ${Math.round(v/1000)} s` },
    { key:"tackles",    name:"Linebacker",      fmt:v => `tackled ${v} rival${v>1?"s":""}` },
    { key:"drained",    name:"Ray Bait",        fmt:v => `drained by a Mana Ray ${v} time${v>1?"s":""}` },
    { key:"struggles",  name:"Escape Artist",   fmt:v => `struggled free with ${v} taps` },
    { key:"blitzed",    name:"Skizzik's Ball", fmt:v => `blitzed to the edge ${v} time${v>1?"s":""}` },
    { key:"kos",        name:"Down but Not Out", fmt:v => `knocked out ${v} time${v>1?"s":""} and got back up` },
    { key:"slimeBonks", name:"Slime Golfer",    fmt:v => `bonked ${v} Electro Slime${v>1?"s":""} into the air` },
    { key:"crushed",    name:"Gigas Snack",     fmt:v => `body-slammed by the Gigas ${v} time${v>1?"s":""}` },
    { key:"wins",       name:"Front Runner",    fmt:v => `won ${v} round${v>1?"s":""}` },
  ];
  function assignTitles(){
    const got = new Map(), used = new Set(), cand = [];
    for (const t of TITLES){ const vals = G.players.map(q => q.stats[t.key] || 0), max = Math.max(...vals), avg = vals.reduce((a,b)=>a+b,0)/vals.length || 1;
      for (const p of G.players){ const v = p.stats[t.key] || 0; if (v > 0) cand.push({ t, p, v, rel: v/avg, top: v === max }); } }
    cand.sort((a,b) => (b.top - a.top) || (b.rel - a.rel));
    for (const c of cand){ if (got.has(c.p) || used.has(c.t.name)) continue; got.set(c.p, `${c.t.name} · ${c.t.fmt(c.v)}`); used.add(c.t.name); }
    for (const p of G.players) if (!got.has(p)) got.set(p, "Steady Hands · nothing went wrong");
    return got;
  }
  function buildSummary(){   // host
    const ranked = [...G.players].sort((a,b) => b.stats.points - a.stats.points || (a.stats.shocks || 0) - (b.stats.shocks || 0));
    const titles = assignTitles();
    return { rescuer: G.rescuer?.idx ?? 0, rows: ranked.map((p, i) => ({ i: p.idx, place: i + 1, points: p.stats.points, dodges: p.stats.dodges || 0, shocks: p.stats.shocks || 0, title: titles.get(p), places: p.stats.places.map(r => r ? r.place : null) })) };
  }
  function showSummary(sum){
    G.mode = "summary"; G.summary = sum;
    const first = !G.replay && env.firstClear;
    const rows = sum.rows.map((r, i) => { const p = G.players[r.i];
      return `<tr class="${i===0?"top":""}"><td>${r.place}</td><td>${esc(p.name)}${p.me?" (you)":""}${p.cpu?' <span class="ex">CPU</span>':""}<br><span class="ex title">${esc(r.title)}</span></td><td>${r.points}</td><td>${r.dodges}</td><td>${r.shocks}</td><td>${first ? `${COUPONS[i]} Hako Coupons<br><span class="ex">+${FABULA[i]} Fabula Point${FABULA[i]>1?"s":""}</span>` : PT ? "Playtest" : "Just for fun"}</td></tr>`; }).join("");
    const top = G.players[sum.rows[0].i], resc = G.players[sum.rescuer];
    ov.innerHTML = `<div class="parch card"><div class="eyebrow">Plasma Field Dash · ${PT ? "playtest results" : "final results"}</div><h2><b>${esc(top.name)}</b> takes the crown. <b>${esc(resc.name)}</b> pulled Hako free.</h2>
      <div class="tw"><table class="res"><tr><th>#</th><th>Player</th><th>Pts</th><th>Dodges</th><th>Shocks</th><th>${first ? "First clear" : "Reward"}</th></tr>${rows}</table></div>
      <p class="ex">${first ? "Coupons go to the shared pool. A runner already at maximum Fabula Points passes the excess down to the next place." : PT ? "Playtest run: nothing is saved and no rewards are paid." : "Rewards were paid on the first clear. This one is just for fun."}</p>
      <div class="row">${env.isGM ? '<button class="btn" data-mg="again">Play again</button><button class="btn primary" data-mg="leave">Leave the field</button>' : '<span class="ex">The GM picks what happens next.</span>'}</div></div>`;
    const a = ov.querySelector('[data-mg="again"]'), l = ov.querySelector('[data-mg="leave"]');
    if (a) a.onclick = () => { a.disabled = true; if (env.isHost) hostFlow("again", {}); else NET.send("gmAgain", {}); };
    if (l) l.onclick = () => { l.disabled = true; if (env.isHost) hostFlow("close", {}); else NET.send("gmLeave", {}); };
  }

  // ---------- intro ----------
  function runIntro(dt){
    const I = G.intro || (G.intro = { t:0 }); I.t += dt; const T = I.t;
    const botY = L.START_Y - 120, topY = L.hako.y - 10;
    if (T < 2300){ G.camY = botY; if (!I.a){ I.a = 1; say("Rain hisses on the crystal. Every hair on your arm stands up.", 2200); } }
    else if (T < 8300){ const t = (T-2300)/6000; G.camY = botY + (topY - botY)*ease(t);
      for (const pl of L.pillars) if (!pl.shown && Math.abs(G.camY - pl.y) < 120){ pl.shown = 1; G.bolts.push(bolt(pl.x, pl.y - 310, 360)); sfx.thunder(); G.flash = .25; } }
    else if (T < 11500){ G.camY = topY; if (!I.c){ I.c = 1; G.hako.next = 0; G.speech = { who:"Hako", txt:"Bzzzt! H-hey! Somebody get me out of heeere!", t:0 }; } if (T > 9800 && !I.c2){ I.c2 = 1; G.hako.next = 0; G.flash = .35; } }
    else if (T < 13700){ G.speech = null; G.camY = topY; if (!I.d){ I.d = 1; say("Three stretches of storm lie between you and her. The Lightning Pillars are the only safe ground.", 2100); } }
    else if (!I.e){ I.e = 1; if (env.isHost) hostAfterIntro(); }
  }
  function say(txt, dur){ G.text = { txt, t:0, dur }; }
  function fadeTo(cb){ G.fade = { t:0, cb, done:false }; }

  // ---------- overlays ----------
  function clearOv(){ ov.innerHTML = ""; }
  function fmt(ms){ const s = Math.max(0, Math.ceil(ms/1000)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; }
  function statRow(n){ const a = ATTRS[n], d = derive(a), sg = v => (v > 0 ? "+" : "") + v, pc = v => sg(Math.round((v - 1)*100)) + "%";
    return `<tr><td><b>${n}</b></td><td>d${a.mig} · tackle ${pc(d.tackle)}, knockback x${d.kb.toFixed(2)}</td><td>d${a.dex} · dash ${(d.dashSpeed*MOVE.dashMs/1000/SQ).toFixed(1)} squares</td><td>d${a.ins} · ${(d.lead/1000).toFixed(2)} s, dash ${Math.round(d.iframe)} ms</td><td>d${a.wlp} · ${Math.round(d.maxSta)} stamina, shock ${(d.stun/1000).toFixed(2)} s</td></tr>`; }
  function addSkip(){
    if (!env.isGM) return;
    const d = document.createElement("div"); d.className = "corner";
    d.innerHTML = `<button class="btn ghost" data-mg="skip">Skip cutscene</button>`; ov.appendChild(d);
    d.querySelector("button").onclick = () => { d.remove(); if (env.isHost) hostAfterIntro(); else NET.send("gmSkip", {}); };
  }
  const TUT_PAGES = [
    { img: env.asset("tut1.jpg"), text: "Reach the end of each stage first. Lightning lands where the <em>orange warnings</em> show." },
    { img: env.asset("tut2.jpg"), text: "<em>Walk</em> can't outrun a strike. Hold <kbd>Z</kbd> to <em>run</em>: it just about can, but it drains stamina." },
    { img: env.asset("tut3.jpg"), text: "Tap <kbd>X</kbd> to <em>dash</em>. You're untouchable for a split second, so time it to the strike." },
    { img: env.asset("tut4.jpg"), text: "Stamina is scarce. Empty it and you're <em>Winded</em>: no running or dashing until it refills to the <em>white mark</em>." },
    { img: env.asset("tut5.jpg"), text: "Every hit costs <em>HP</em>. Run out and you're knocked out: mash <em>← →</em> to get back up." },
    { img: env.asset("tut6.jpg"), text: "Dash into another runner to <em>tackle</em> them aside. Higher MIG hits harder." },
    { img: env.asset("tut7.jpg"), text: "Three stages, each a round worth <em>4 / 3 / 2 / 1</em> points. The <em>Lightning Pillars</em> between stages are safe." },
  ];
  const SIGIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="M12 4.2 13.7 10.3 19.8 12 13.7 13.7 12 19.8 10.3 13.7 4.2 12 10.3 10.3z"/></svg>';
  function closeTutorial(){ const v = ov.querySelector(".tutv"); if (v){ v.remove(); } G.tutOpen = false; }
  function showOverview(){
    // the opening rules, as a slide tutorial in the Conflict Event style: one rule per page, each with a shot of it happening
    // (each runner reads it on their own screen while practice is already open behind it)
    G.text = null; G.speech = null; G.tutOpen = true;
    for (const p of TUT_PAGES){ const im = new Image(); im.src = p.img; }
    let page = 0;
    const v = document.createElement("div"); v.className = "tutv";
    v.innerHTML = `<div class="tut" role="dialog" aria-label="Crystal Field Dash">
      <div class="t-head"><span class="t-sigil">${SIGIL}</span><div><small>Plasma Field</small><b>Crystal Field Dash</b></div></div>
      <div class="t-shot"><img src="${TUT_PAGES[0].img}" alt=""></div>
      <p class="t-text">${TUT_PAGES[0].text}</p>
      <div class="t-foot">
        <button type="button" data-prev disabled><kbd>◀</kbd>Back</button>
        <span class="dots">${TUT_PAGES.map((_, i) => `<i class="${i ? "" : "on"}">◆</i>`).join("")}</span>
        <button type="button" data-skip>Skip practice</button>
        <button type="button" data-next class="go"><kbd>Z</kbd><span class="t-next">Next</span></button>
      </div></div>`;
    ov.appendChild(v);
    const flip = d => {
      const next = page + d; if (next < 0) return;
      if (next >= TUT_PAGES.length){ done(false); return; }
      page = next; tone(660, .05, .03, "triangle");
      const box = v.querySelector(".t-shot"), text = v.querySelector(".t-text");
      box.style.setProperty("--dx", (d*36) + "px");
      box.querySelectorAll("img").forEach(old => { old.classList.remove("in"); old.classList.add("out"); setTimeout(() => old.remove(), 380); });
      const img = document.createElement("img"); img.alt = ""; img.src = TUT_PAGES[next].img; img.className = "in"; box.appendChild(img);
      text.classList.add("swap"); setTimeout(() => { text.innerHTML = TUT_PAGES[page].text; text.classList.remove("swap"); }, 160);
      v.querySelectorAll(".dots i").forEach((dot, i) => dot.classList.toggle("on", i === next));
      v.querySelector("[data-prev]").disabled = next === 0;
      v.querySelector(".t-next").textContent = next < TUT_PAGES.length - 1 ? "Next" : "Practice";
    };
    const onKey = ev => {
      if (!document.body.contains(v)) return window.removeEventListener("keydown", onKey, true);
      const act = { KeyZ: () => flip(1), Enter: () => flip(1), ArrowRight: () => flip(1), ArrowLeft: () => flip(-1) }[ev.code];
      if (!act) return; ev.preventDefault(); ev.stopImmediatePropagation(); act();
    };
    const done = skip => {
      window.removeEventListener("keydown", onKey, true); v.remove();
      G.tutOpen = false; G.inputOk = true;
      if (skip && G.mode === "practice"){ const p = me(); if (p && p.local && !p.ready){ setReady(p); p.mark = { x: L.yardMarks[p.idx].x, y: L.PT - 70 }; p.state = "auto"; } }
    };
    v.addEventListener("click", ev => {
      if (ev.target.closest("[data-next]")) return flip(1);
      if (ev.target.closest("[data-prev]")) return flip(-1);
      if (ev.target.closest("[data-skip]")) return done(true);
    });
    window.addEventListener("keydown", onKey, true);
  }

  // ---------- update ----------
  // One frame. Three kinds of work, kept apart on purpose:
  //  * everyone:  visuals, hazard timelines, projectiles, the plasma chase, interpolated remote things;
  //  * host only: anything that spawns or decides (spawns, monsters, slimes, CPU runners, places, round flow);
  //  * local:     the runners this client owns (its player's own runner; the host also owns the CPUs):
  //               their movement, and every hit they take, so a dash timed on your screen is judged on your screen.
  // Strikes are aimed at a random runner still out, so once others finish the last runner would take
  // every strike meant for four. Pacing stretches with fewer runners out (per-runner pressure stays put).
  // ── Catch-up rules: the slowest runner must not take the strikes meant for four ──
  // Ground strikes aim at a runner still out, so each runner has a CAP of strikes on its way at once, and new
  // ones go to whoever has the fewest and is not resting from the last one. Once half the pack is home, MERCY eases the monsters that hunt a runner,
  // and the runner in last place gets a SECOND WIND (faster stamina refill). Tune here.
  const CATCHUP = {
    cap: 2,                 // ground strikes on their way to one runner at once (a burst counts as one)
    rest: 3,                // after a strike is aimed at a runner, they rest this many spawn intervals before the next one
                            // (four runners share the field, so the pack barely notices; a lone runner is no longer every strike's target)
    mercyAt: .5,            // share of the pack home before MERCY starts
    mercy: { kirinCd: 2, skizCd: 2, gigasSpeed: 1.3, gigasDaze: 2600, earthenWire: false },
    secondWind: { regen: 1.35, delay: .6 },   // last place: stamina refills x1.35, and starts refilling after 60% of the usual wait
  };
  function mercy(){ return G.mode === "play" && G.players.filter(p => p.finished).length >= Math.ceil(G.players.length*CATCHUP.mercyAt); }
  function pendingOn(p){ const groups = new Set(); for (const h of G.haz) if (h.aim === p.idx && h.t < h.dur) groups.add(h.group ?? h.id); return groups.size; }
  function inLastPlace(p){
    if (G.mode !== "play" || !p.running || G.players.length < 2) return false;
    return !G.players.some(q => q !== p && q.running && q.y > p.y);
  }
  function update(dt){
    G.t += dt;
    runLaters(dt);
    NET.tick(dt);
    for (const b of G.bolts) b.t += dt; G.bolts = G.bolts.filter(b => b.t < b.life);
    for (const r of G.rings) r.t += dt; G.rings = G.rings.filter(r => r.t < 450);
    for (const e of G.fx) e.t += dt; G.fx = G.fx.filter(e => e.t < e.life); if (G.perfectT > 0) G.perfectT -= dt;
    G.flash = Math.max(0, G.flash - dt/500); if (G.shakes) G.shakes = Math.max(0, G.shakes - dt/40);
    if (G.banner){ G.banner.t += dt; if (G.banner.t > G.banner.dur) G.banner = null; }
    if (G.text){ G.text.t += dt; if (G.text.t > G.text.dur) G.text = null; }
    if (G.fade){ G.fade.t += dt; if (G.fade.t > 350 && !G.fade.done){ G.fade.done = true; G.fade.cb(); } if (G.fade.t > 700) G.fade = null; }
    const h = G.hako;
    if (!h.freed){ h.next -= dt; if (h.next <= 0){ h.next = rnd(900,1700); h.zap = 380; G.bolts.push(bolt(L.hako.x + rnd(-4,4), L.hako.y + 30 - 288, 240)); if (Math.abs(G.camY - h.y) < 400) noise(.25, 2500, .1, 2); } }
    if (h.zap > 0) h.zap -= dt;
    if (G.mode === "intro") runIntro(dt);
    if (G.mode === "countdown"){ G.cd -= dt; const s = Math.ceil(G.cd/700); if (s !== G.cdLast){ G.cdLast = s; sfx.beep(s <= 0); } if (G.cd <= -500) G.mode = "play"; }

    if (isLive()){
      const F = feature();
      if (G.mode === "play") G.stageT += dt; else G.practiceT += dt;
      if (env.isHost){
        G.groundNext -= dt; if (G.groundNext <= 0){ G.groundNext = rnd(F.ground[0], F.ground[1]); spawnGround(); }
        for (const o of L.obs){
          if (o.kind !== "crystal" && o.kind !== "splash") continue;
          if (!G.players.some(p => active(p) && Math.abs(p.y - o.y) < 420)) continue;
          if (o.cd == null) o.cd = rnd(2500, 9000);
          o.cd -= dt; if (o.cd <= 0){ o.cd = rnd(6500, 10500); addHaz({ kind:"circle", x:o.x, y:o.y, r: o.kind === "splash" ? rnd(110, 130) : rnd(90, 110), dur: 1900, src:o }); }
        }
        if (F.plasma){ G.orbNext = (G.orbNext ?? 800) - dt; if (G.orbNext <= 0){ G.orbNext = rnd(700, 1500); if (G.orbs.filter(o => !o.taken).length < 14) spawnOrbNear(); } }
        if (F.monsters) for (const m of L.monsters) updateMonster(m, dt);
        if (F.slimes) updateSlimes(dt);
        if (G.mode === "play" && G.stage === 2){ updateKirin(dt); updateGigas(dt); updateSkizzik(dt);
          if (!G.gigas) updateObsidrax(dt);
          else if (G.obsx){ G.obsx = null; G.spikeWalls = []; toastAll("Obsidrax dives away as the Gigas arrives!", 2000); } }
        if (G.mode === "play" && G.stage === 1){ for (const m of L.monsters) if (m.zone === "s2") updateMonster(m, dt); updateObsidrax(dt); }
      } else {
        for (const w of G.spikeWalls) w.t += dt; G.spikeWalls = G.spikeWalls.filter(w => w.t < w.life);
        for (const sl of G.slimes) if (sl.pop){ sl.pop.t += dt; if (sl.pop.t > 1300) sl.pop = null; }
      }
      stepSkizRush(dt);
      for (const m of L.monsters) rayHits(m);
      slimeBumps();
      // a following strike chases its owner (everyone runs it; the owner's client pins where it stops)
      for (const hz of G.haz) if (hz.kind === "plasma" && hz.owner){
        if (hz.t < hz.follow){ const o = hz.owner, dx = o.x - hz.x, dy = o.y - hz.y, d = Math.hypot(dx,dy), step = hz.chase*dt/1000; if (d > step){ hz.x += dx/d*step; hz.y += dy/d*step; } else { hz.x = o.x; hz.y = o.y; } keepInside(hz); }
        else if (!hz.locked){ hz.locked = true; if (hz.owner.stats ? hz.owner.local : env.isHost) NET.send("hazLock", { id: hz.id, x: Math.round(hz.x), y: Math.round(hz.y) }); }
      }
      for (const o of G.orbs){ if (o.taken) continue; o.born = (o.born ?? 9999) + dt; o.life = (o.life ?? 1e9) - dt; if (o.amp){ o.ph += dt; o.x = clamp(o.cx + Math.sin(o.ph/o.per)*o.amp, XMIN+10, XMAX-10); } if (o.life <= 0) o.taken = true; }
      // touching a charge: the host grants it (first come, first served); a player's client asks
      if (F.plasma) for (const o of G.orbs){ if (o.taken || o.born < 250) continue;
        for (const p of G.players) if (p.local && active(p) && canAct(p) && Math.hypot(p.x - o.x, (p.y - o.y)*.8) < 42){
          if (env.isHost) pickup(p, o); else if (!o.asked || G.t - o.asked > 600){ o.asked = G.t; NET.send("pickup", { id: o.id, i: p.idx }); }
          break; } }
    }
    for (const hz of G.haz) hz.t += dt;
    for (const hz of G.haz.filter(x => x.t >= x.dur)) landHaz(hz);
    G.haz = G.haz.filter(x => x.t < x.dur);
    for (const s of G.shots){
      if (s.delay > 0){ s.delay -= dt; continue; }
      s.x += s.vx*dt/1000; s.y += s.vy*dt/1000; s.life -= dt;
      for (const p of G.players){ if (!p.local || !active(p) || p.state === "shock" || p.state === "ko" || p.state === "auto" || p.state === "wait") continue;
        if (Math.hypot(p.x - s.x, p.y - 30 - s.y) < s.r + 14){
          if (p.inv > 0){ if (!s.grazed){ s.grazed = true; p.stats.dodges++; if (p.me) lesson(p, 4); perfectFX(p); } continue; }
          if (p.grace > 0) continue;
          s.life = 0; p.stats.bulletHits++; shotHit(p, s); break; } }
    }
    G.shots = G.shots.filter(s => s.life > 0 && s.x > 0 && s.x < W && s.y > -100 && s.y < L.WORLD_H);

    for (const p of G.players){
      // one runner's bad state must never stop the frame for everyone else
      try { stepPlayer(p, dt); }
      catch (e){ if (!p._stepErr){ p._stepErr = true; console.error(TAG, "runner " + p.name + " reset after an error", e); } p.state = "idle"; p.kb = null; p.st = 0; p.dashT = 0; }
      if (p.local && p.wiggle > 0) p.wiggle -= dt;
      if (p.state === "ko" && (p.cpu || (p.me && env.autopilot)) && p.local){ p.botTap = (p.botTap ?? 0) - dt; if (p.botTap <= 0){ p.botTap = rnd(120, 230); struggleTap(p, p.lastTap === "left" ? "right" : "left"); } }
    }
    if (isLive()) for (const p of G.players){
      // a dash into an Electro Slime bonks it away (the host moves slimes, so it is asked)
      if (!p.local || p.state !== "dash") continue;
      for (const sl of G.slimes){ if (sl.launch || sl.bonked > G.t || Math.hypot(sl.x - p.x, sl.y - p.y) > 38) continue;
        sl.bonked = G.t + 700; p.stats.slimeBonks = (p.stats.slimeBonks || 0) + 1;
        if (env.isHost) bonkSlime(sl, p.dashDir); else NET.send("bonk", { id: sl.id, dx: p.dashDir.x, dy: p.dashDir.y });
        if (Math.abs(sl.y - G.camY) < 420){ sfx.tackle(); tone(520, .25, .05, "sine"); later(120, () => tone(260, .2, .04, "sine")); } }
    }
    if (isLive()) for (const p of G.players){
      // a dash that runs into another runner is a tackle; head-on, the stronger MIG wins (ties: the lower seat, so both screens agree)
      if (!p.local || p.state !== "dash" || p.tackledThisDash) continue;
      for (const q of G.players){
        if (q === p || !active(q) || !canAct(q) || q.grace > 0) continue;
        if (Math.hypot(q.x - p.x, q.y - p.y) < 34){ p.tackledThisDash = true;
          if (q.state === "dash" && (q.d.tackle > p.d.tackle || (q.d.tackle === p.d.tackle && q.idx < p.idx))) tackle(q, p); else tackle(p, q); break; }
      }
    }

    if (isLive()){
      for (const p of G.players){
        if (!p.local || !active(p)) continue;
        if (env.autopilot && p.me && G.mode === "practice" && G.practiceT > 3000) p.goReady = true;
        if (G.mode === "practice" && !p.ready && p.y < L.PT && (p.state === "walk" || p.state === "run" || p.state === "dash")){ setReady(p); p.mark = { x: L.yardMarks[p.idx].x, y: L.PT - 70 }; p.state = "auto"; }
        if (G.mode === "play" && !p.goalSent){
          const goal = G.stage < 2 ? p.y < L.T[G.stage] : Math.hypot(p.x - h.x, (p.y - h.y)) < 110;
          if (goal){ p.goalSent = true; if (env.isHost) hostGoal(p.idx); else NET.send("goal", { i: p.idx }); }
        }
      }
      if (env.isHost && G.mode === "practice"){
        const humansReady = G.players.filter(p => !p.cpu).every(p => p.ready);
        for (const p of G.players) if (p.cpu && !p.ready && (G.practiceT > p.botReadyAt || (humansReady && G.practiceT > (p.lateReady ||= G.practiceT + rnd(800, 2600))))) p.goReady = true;
        if (G.players.every(p => p.ready) && !G.endSent){ G.endSent = true; hostFlow("endPractice", {}); }
      }
      if (env.isHost && G.mode === "play" && !G.overSent){
        if (G.players.every(p => !p.running)){ G.overSent = true; hostFlow("roundOver", {}); }
        else if (G.stageT >= G.limit) hostCallRound();
      }
    }
    if (env.isHost && G.autoNext && G.t > G.autoNext && G.mode === "roundEnd"){ G.autoNext = 0; hostNext(); }
    if (G.mode === "finale") runFinale(dt);

    const m = me(); let target = G.camY; G.watching = null;
    if (!isRunner() && G.watchIdx < 0 && G.mode === "play"){ const l = leaderAny(); if (l) target = l.y - 60; }
    if (G.mode === "practice" || G.mode === "card" || G.mode === "countdown" || G.mode === "transition" || G.mode === "roundEnd") target = m.y - 60;
    if (G.mode === "play"){
      if (!isRunner() && G.watchIdx < 0){ const l = leaderAny(); target = (l || m).y - 60; }
      else if (m.running) target = m.y - 60;
      else { const run = G.players.filter(p => p.running).sort((a,b) => b.y - a.y); if (run.length){ G.watching = run[0]; target = run[0].y - 60; } else target = m.y - 60; }
    }
    if (G.mode === "finale" || G.mode === "summary") target = G.hako.y - 10;
    if (G.mode !== "intro" && G.mode !== "overview" && G.mode !== "title") G.camY += (target - G.camY) * Math.min(1, dt/220);
    G.camY = clamp(G.camY, H/2, L.WORLD_H - H/2);
  }

  // ---------- drawing ----------
  function drawGround(top){
    const g = ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,"#262433"); g.addColorStop(1,"#22202c");
    ctx.fillStyle = "#0c0b12"; ctx.fillRect(0,0,W,H);
    if (!imgs.ground){ ctx.fillStyle = g; ctx.fillRect(XMIN-40, 0, XMAX-XMIN+80, H); }
    ctx.save(); ctx.translate(0, -top);
    if (imgs.ground){   // ChatGPT ground strip, mirror-tiled up the course so every join matches
      const th = W/imgs.ground.width*imgs.ground.height;
      for (let i = Math.floor(top/th); i*th < top + H; i++){ ctx.save(); if (i % 2){ ctx.translate(0, i*th + th); ctx.scale(1, -1); ctx.drawImage(imgs.ground, 0, 0, W, th); } else ctx.drawImage(imgs.ground, 0, i*th, W, th); ctx.restore(); }
    }
    const band = (y0, y1, col) => { ctx.fillStyle = col; ctx.fillRect(XMIN-40, y0, XMAX-XMIN+80, y1-y0); };
    band(L.PT, L.PB + 150, "rgba(60,70,90,.25)");
    for (let s = 0; s < 2; s++) band(L.T[s] - L.PLAZA, L.T[s], "rgba(80,70,120,.22)");
    band(0, L.T[2], "rgba(110,80,170,.18)");
    ctx.setLineDash([12,8]); ctx.lineWidth = 3;
    for (let s = 0; s < 2; s++){ ctx.strokeStyle = "rgba(255,240,190,.45)"; ctx.beginPath(); ctx.moveTo(XMIN-30, L.T[s]); ctx.lineTo(XMAX+30, L.T[s]); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255,240,190,.3)"; ctx.beginPath(); ctx.moveTo(XMIN-30, L.START_Y - 50); ctx.lineTo(XMAX+30, L.START_Y - 50); ctx.stroke();
    ctx.strokeStyle = G.mode === "practice" ? `rgba(255,240,190,${.5 + .3*Math.sin(G.t/250)})` : "rgba(150,200,255,.35)"; ctx.lineWidth = G.mode === "practice" ? 4 : 3; ctx.beginPath(); ctx.moveTo(XMIN-30, L.PT); ctx.lineTo(XMAX+30, L.PT); ctx.stroke(); ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.font = "600 14px Signika, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "rgba(236,230,246,.5)";
    ctx.fillText("PRACTICE YARD", 480, L.PB + 60); if (G.mode === "practice"){ ctx.fillStyle = "rgba(255,240,190,.85)"; ctx.fillText("▲ WALK UP HERE WHEN READY ▲", 480, L.PT + 22); ctx.fillStyle = "rgba(236,230,246,.5)"; } ctx.fillText("START", 480, L.START_Y + 50);
    for (let s = 0; s < 2; s++) ctx.fillText(`CHECKPOINT ${s+1} · SAFE`, 480, L.T[s] - 14);
    for (const m of L.startMarks.concat(L.yardMarks)){ ctx.strokeStyle = "rgba(255,240,200,.3)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(m.x, m.y, 20, 8, 0, 0, 7); ctx.stroke(); }
    if (!imgs.ground) for (const d of L.decor){
      if (d.y < top - 300 || d.y > top + H + 300) continue;
      if (d.kind === "pool"){ ctx.fillStyle = "rgba(10,10,20,.5)"; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.w, d.w*.38, 0, 0, 7); ctx.fill(); ctx.fillStyle = "rgba(120,130,170,.25)"; ctx.beginPath(); ctx.ellipse(d.x, d.y+2, d.w*.8, d.w*.28, 0, 0, 7); ctx.fill(); ctx.strokeStyle = "rgba(170,160,210,.25)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.w, d.w*.38, 0, 0, 7); ctx.stroke(); }
      if (d.kind === "crack"){ const R = mulberry(d.seed|0); ctx.strokeStyle = "rgba(180,160,255,.14)"; ctx.lineWidth = 1.4; ctx.beginPath(); let x = d.x, y = d.y; ctx.moveTo(x,y); for (let k=0;k<5;k++){ x += (R()-.5)*48; y += (R()-.5)*26; ctx.lineTo(x,y); } ctx.stroke(); }
    }
    ctx.restore();
  }
  function drawWave(d){
    const R = mulberry(d.seed|0), x = d.x, y = d.y, s = d.side, h = d.h;
    ctx.save();
    const g = ctx.createLinearGradient(x, y - h, x, y); g.addColorStop(0, "rgba(210,200,255,.55)"); g.addColorStop(.5, "rgba(130,110,200,.45)"); g.addColorStop(1, "rgba(60,55,90,.7)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - 110, y);
    ctx.quadraticCurveTo(x - 90*s, y - h*1.05, x + 30*s, y - h*.8); ctx.quadraticCurveTo(x + 60*s, y - h*.6, x + 20*s, y - h*.45);
    ctx.quadraticCurveTo(x + 90*s, y - h*.3, x + 110, y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(240,235,255,.35)"; ctx.lineWidth = 1.2;
    for (let i = 0; i < 6; i++){ const a = R(); ctx.beginPath(); ctx.moveTo(x - 80 + a*160, y); ctx.lineTo(x - 60*s + a*80*s, y - h*(.4 + R()*.5)); ctx.stroke(); }
    ctx.restore();
  }
  function drawRock(o){
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(o.x, o.y+o.r*.35, o.r*1.05, o.r*.4, 0, 0, 7); ctx.fill();
    const h = o.r*1.25;
    ctx.fillStyle = "#1f1d29"; ctx.beginPath(); ctx.moveTo(o.x-o.r, o.y+o.r*.2); ctx.lineTo(o.x-o.r*.7, o.y-h); ctx.lineTo(o.x-o.r*.1, o.y-h*1.25); ctx.lineTo(o.x+o.r*.6, o.y-h*.9); ctx.lineTo(o.x+o.r, o.y+o.r*.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#3a3648"; ctx.beginPath(); ctx.moveTo(o.x-o.r*.7, o.y-h); ctx.lineTo(o.x-o.r*.1, o.y-h*1.25); ctx.lineTo(o.x+o.r*.6, o.y-h*.9); ctx.lineTo(o.x+o.r*.1, o.y-h*.7); ctx.closePath(); ctx.fill();
  }
  function drawSplash(o){
    const R = mulberry(o.seed|0);
    if (imgs.lcrystal){ const im = imgs.lcrystal, h = o.r*2.3, w = im.width/im.height*h, flip = (o.seed|0) % 2;
      ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.beginPath(); ctx.ellipse(o.x, o.y + 6, o.r*1.1, o.r*.4, 0, 0, 7); ctx.fill();
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.translate(o.x, o.y + 8); if (flip) ctx.scale(-1, 1); ctx.rotate((R() - .5)*.3); ctx.drawImage(im, -w/2, -h, w, h);
      if (G.haz.some(z => z.src === o)){ ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = .35 + .3*Math.abs(Math.sin(G.t/80)); ctx.drawImage(im, -w/2, -h, w, h); }
      ctx.restore(); return; }
    ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.beginPath(); ctx.ellipse(o.x, o.y+6, o.r*1.1, o.r*.4, 0, 0, 7); ctx.fill();
    for (let i = 0; i < 9; i++){
      const a = -Math.PI/2 + (R()-.5)*1.9, len = o.r*(1.1 + R()*1.2), w = 5 + R()*6;
      const ex = o.x + Math.cos(a)*len*.7, ey = o.y + Math.sin(a)*len;
      ctx.fillStyle = i % 3 ? "rgba(170,150,240,.75)" : "rgba(235,230,255,.8)";
      ctx.beginPath(); ctx.moveTo(o.x - w, o.y); ctx.lineTo(ex, ey); ctx.lineTo(o.x + w, o.y); ctx.closePath(); ctx.fill();
    }
  }
  function drawCrystal(o){
    const s = o.s, x = o.x, y = o.y, glow = .2 + .1*Math.sin(G.t/400);
    if (imgs.lcrystal){ const im = imgs.lcrystal, h = 70*s, w = im.width/im.height*h, hot = G.haz.some(z => z.src === o);
      ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(x, y + 4, w*.4, 8, 0, 0, 7); ctx.fill();
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(im, x - w/2, y + 8 - h, w, h);
      if (hot){ ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = .35 + .3*Math.abs(Math.sin(G.t/80)); ctx.drawImage(im, x - w/2, y + 8 - h, w, h); }
      ctx.restore(); return; }
    for (const [dx,dy,w,hh] of [[-12,0,10,58],[4,2,13,76],[16,4,8,44],[-22,6,7,34]]){
      const bx = x+dx*s, by = y+dy*s, ww = w*s, H2 = hh*s;
      ctx.fillStyle = `rgb(${110+glow*120|0},${80+glow*120|0},${200+glow*55|0})`;
      ctx.beginPath(); ctx.moveTo(bx-ww, by); ctx.lineTo(bx-ww*.8, by-H2*.8); ctx.lineTo(bx, by-H2); ctx.lineTo(bx+ww*.8, by-H2*.8); ctx.lineTo(bx+ww, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.28)"; ctx.beginPath(); ctx.moveTo(bx, by-H2); ctx.lineTo(bx+ww*.8, by-H2*.8); ctx.lineTo(bx+ww*.2, by); ctx.lineTo(bx, by); ctx.closePath(); ctx.fill();
    }
  }
  function drawPillar(pl){
    const x = pl.x, y = pl.y;
    if (imgs.pillar){   // ChatGPT Lightning Pillar sprite
      const im = imgs.pillar, h = 340, w = im.width/im.height*h;
      const rg = ctx.createRadialGradient(x, y, 10, x, y, 150); rg.addColorStop(0, "rgba(120,200,255,.2)"); rg.addColorStop(1, "rgba(120,200,255,0)"); ctx.fillStyle = rg; ctx.beginPath(); ctx.ellipse(x, y, 150, 70, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.ellipse(x, y + 6, w*.46, 20, 0, 0, 7); ctx.fill();
      ctx.drawImage(im, x - w/2, y + 22 - h, w, h);
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = `rgba(160,220,255,${.3 + .2*Math.sin(G.t/300)})`; ctx.beginPath(); ctx.arc(x, y + 22 - h + 14, 14, 0, 7); ctx.fill(); ctx.restore();
      return;
    }
    const rg = ctx.createRadialGradient(x, y, 10, x, y, 150); rg.addColorStop(0,"rgba(120,200,255,.18)"); rg.addColorStop(1,"rgba(120,200,255,0)");
    ctx.fillStyle = rg; ctx.beginPath(); ctx.ellipse(x, y, 150, 70, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.ellipse(x, y+6, 50, 16, 0, 0, 7); ctx.fill();
    const seg = (w, y0, y1, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x-w, y0); ctx.lineTo(x-w*.86, y1); ctx.lineTo(x+w*.86, y1); ctx.lineTo(x+w, y0); ctx.closePath(); ctx.fill(); };
    seg(46, y, y-60, "#3b3a4a"); seg(36, y-60, y-150, "#45435a"); seg(42, y-150, y-170, "#55526c"); seg(28, y-170, y-245, "#4a4860"); seg(34, y-245, y-262, "#5b5876");
    ctx.fillStyle = "#6c6990"; ctx.beginPath(); ctx.moveTo(x-6, y-262); ctx.lineTo(x, y-320); ctx.lineTo(x+6, y-262); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(150,220,255,.5)"; ctx.fillRect(x-30, y-158, 60, 4); ctx.fillRect(x-22, y-252, 44, 3);
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = `rgba(160,220,255,${.25 + .15*Math.sin(G.t/300)})`; ctx.beginPath(); ctx.arc(x, y-320, 10, 0, 7); ctx.fill(); ctx.restore();
  }
  function drawMonster(m){
    const im = imgs[m.key]; if (!im) return;
    const h = m.h, w = im.width/im.height*h;
    let x = m.x, y = m.y, lift = 0; const bob = Math.sin(G.t/350 + (m.homeY || 0))*3;
    if (m.fly){ x = m.fly.x; y = m.fly.yy; lift = 55; }
    if (m.rush && m.rush.t < m.rush.warn){
      const r = m.rush, k = r.t/r.warn, ang = Math.atan2(r.ty - r.fy, r.tx - r.fx), len = Math.hypot(r.tx - r.fx, r.ty - r.fy);
      ctx.save(); ctx.translate(r.fx, r.fy); ctx.rotate(ang);
      ctx.fillStyle = "rgba(255,140,60,.14)"; ctx.fillRect(0, -32, len, 64); ctx.fillStyle = `rgba(255,140,60,${.2 + .25*k})`; ctx.fillRect(0, -32, len*k, 64);
      ctx.strokeStyle = "#ff8a3c"; ctx.lineWidth = 3; ctx.strokeRect(0, -32, len, 64);
      for (let i = 1; i < 7; i++){ const ax = len*i/7; ctx.beginPath(); ctx.moveTo(ax - 14, -14); ctx.lineTo(ax, 0); ctx.lineTo(ax - 14, 14); ctx.stroke(); }
      ctx.restore();
    }
    if (!m.fly && !(m.rush && m.rush.t >= m.rush.warn)){ ctx.fillStyle = "#1a1824"; ctx.beginPath(); ctx.ellipse(m.x, m.y + 4, 60, 18, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.ellipse(x, y, w*.35, 9, 0, 0, 7); ctx.fill();
    if (m.key === "kirin" && m.charge){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(255,240,170,${.25 + .2*m.charge})`; ctx.lineWidth = 2 + m.charge*2; ctx.beginPath(); ctx.ellipse(x, y - h*.5, w*.55, h*.55, 0, 0, 7); ctx.stroke(); ctx.restore(); }
    const rushing = m.rush && m.rush.t >= m.rush.warn;
    const faceRight = m.fly ? m.fly.dir > 0 : rushing ? m.rush.tx > m.rush.fx : m.side < 0;
    if (rushing){ for (let i = 1; i <= 3; i++){ ctx.save(); ctx.globalAlpha = .15*(4-i); const bx = x - (m.rush.tx - m.rush.fx)/Math.hypot(m.rush.tx - m.rush.fx, m.rush.ty - m.rush.fy)*22*i; ctx.translate(bx, y); if (faceRight) ctx.scale(-1, 1); ctx.drawImage(im, -w/2, -h, w, h); ctx.restore(); } }
    ctx.save(); ctx.translate(x, y - bob - lift); if (faceRight) ctx.scale(-1, 1);
    ctx.drawImage(im, -w/2, -h, w, h);
    if (m.fire > 0){ ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = Math.min(1, m.fire/220)*.6; ctx.drawImage(im, -w/2, -h, w, h); }
    ctx.restore();
    if (m.key === "ray" && m.fly && (m.pulse === "charge" || m.pulse === "live")){
      const R = 95, live = m.pulse === "live", k = live ? 1 : 1 - m.pt/800;
      ctx.save();
      if (live){ ctx.fillStyle = `rgba(200,170,255,${.28 + .12*Math.sin(G.t/40)})`; ctx.beginPath(); ctx.ellipse(x, y, R, R*.55, 0, 0, 7); ctx.fill(); ctx.strokeStyle = "#fff6c8"; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(x, y, R, R*.55, 0, 0, 7); ctx.stroke(); ctx.restore(); arcs(x, y - 10, R*.8, 6, .9); }
      else { ctx.strokeStyle = `rgba(200,170,255,${.35 + .55*k})`; ctx.lineWidth = 2 + 2*k; ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.ellipse(x, y, R*(1.5 - .5*k), R*.55*(1.5 - .5*k), 0, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = `rgba(200,170,255,${.12*k})`; ctx.beginPath(); ctx.ellipse(x, y, R, R*.55, 0, 0, 7); ctx.fill(); ctx.restore(); }
    }
    if (false){   /* charge-up: a ring tightening under the ray just before each drop */
      const k = 1 - m.cd/450; ctx.save(); ctx.strokeStyle = `rgba(200,170,255,${.3 + .6*k})`; ctx.lineWidth = 2 + 2*k; ctx.beginPath(); ctx.ellipse(x, y, 95*(1.6 - .6*k), 95*.55*(1.6 - .6*k), 0, 0, 7); ctx.stroke();
      ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = `rgba(200,170,255,${.5*k})`; ctx.beginPath(); ctx.arc(x, y - lift - h*.5, 8 + 10*k, 0, 7); ctx.fill(); ctx.restore(); }
  }
  function drawSpikeWall(w){
    // obsidian spikes with a green venom sheen; they shoot up, then crumble
    const R = mulberry(Math.floor(w.x0*7 + w.y0)), rise = clamp(w.t/160, 0, 1), fade = clamp((w.life - w.t)/300, 0, 1), n = 13;
    ctx.save(); ctx.globalAlpha = fade;
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.moveTo(w.x0, w.y0 + 6); ctx.lineTo(w.x1, w.y1 + 6); ctx.lineWidth = 18; ctx.strokeStyle = "rgba(0,0,0,.3)"; ctx.stroke();
    for (let i = 0; i <= n; i++){
      const cx = w.x0 + (w.x1 - w.x0)*i/n + (R() - .5)*6, cy = w.y0 + (w.y1 - w.y0)*i/n + (R() - .5)*6, hh = (34 + R()*30)*rise, ww = 7 + R()*6, lean = (R() - .5)*10;
      ctx.fillStyle = "#17141f"; ctx.beginPath(); ctx.moveTo(cx - ww, cy); ctx.lineTo(cx + lean, cy - hh); ctx.lineTo(cx + ww, cy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(150,255,120,.35)"; ctx.beginPath(); ctx.moveTo(cx + lean, cy - hh); ctx.lineTo(cx + ww*.5, cy - hh*.2); ctx.lineTo(cx + ww*.15, cy); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  function drawObsidrax(){
    const o = G.obsx, im = imgs.obsidrax;
    if (o.state === "burrow" || o.state === "warn"){
      // a moving mound of broken ground
      ctx.fillStyle = "rgba(60,50,40,.55)"; ctx.beginPath(); ctx.ellipse(o.x, o.y, 38, 14, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = "rgba(150,255,120,.35)"; ctx.lineWidth = 1.5; ctx.beginPath(); for (let i = 0; i < 4; i++){ const a = i*1.6 + G.t/200; ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + Math.cos(a)*24, o.y + Math.sin(a)*9); } ctx.stroke();
      return;
    }
    if (!im) return;
    const OH = 170, rise = clamp(o.st/220, 0, 1), sink = o.st > 2400 ? clamp((2700 - o.st)/300, 0, 1) : 1, h = OH*Math.min(rise, sink), w = im.width/im.height*OH;
    // Earthen Wire aura
    ctx.save(); ctx.strokeStyle = "rgba(180,255,140,.28)"; ctx.lineWidth = 2; ctx.setLineDash([10, 12]); ctx.lineDashOffset = -G.t/30; ctx.beginPath(); ctx.ellipse(o.x, o.y, 230, 230*.55, 0, 0, 7); ctx.stroke(); ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.ellipse(o.x, o.y, w*.35, 10, 0, 0, 7); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.rect(o.x - w, o.y - OH - 30, w*2, OH + 30); ctx.clip();   /* only what has risen out of the ground */
    ctx.translate(o.x, o.y + (OH - h)); if (leader() && leader().x > o.x) ctx.scale(-1, 1); ctx.drawImage(im, -w/2, -OH, w, OH); ctx.restore();
  }
  function drawKirin(){
    const k = G.kirin, im = imgs.kirin; if (!im) return;
    const h = 120, w = im.width/im.height*h, lift = 18 + Math.sin(G.t/260)*4;
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(k.x, k.y, w*.32, 9, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(235,240,255,.55)"; for (let i = -1; i <= 1; i++){ ctx.beginPath(); ctx.ellipse(k.x + i*22, k.y - 6 + Math.sin(G.t/200 + i)*2, 20, 9, 0, 0, 7); ctx.fill(); }
    if (k.charge){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(255,240,170,${.25 + .2*k.charge})`; ctx.lineWidth = 2 + k.charge*2; ctx.beginPath(); ctx.ellipse(k.x, k.y - lift - h*.5, w*.55, h*.55, 0, 0, 7); ctx.stroke(); ctx.restore(); }
    ctx.save(); ctx.translate(k.x, k.y - lift); if (k.face > 0) ctx.scale(-1, 1); ctx.drawImage(im, -w/2, -h, w, h);
    if (k.fire > 0){ ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = Math.min(1, k.fire/300)*.7; ctx.drawImage(im, -w/2, -h, w, h); }
    ctx.restore();
  }
  function drawGigas(){
    const g = G.gigas, im = imgs.gigas; if (!im) return;
    const h = 215, w = im.width/im.height*h, air = g.air || 0;
    const crouch = g.state === "leap" && g.st < 605 ? g.st/605 : 0, sx = 1 + .14*crouch, sy = 1 - .14*crouch, quake = crouch > 0 ? Math.sin(G.t/30)*2*crouch : 0;
    ctx.fillStyle = `rgba(0,0,0,${.45 - Math.max(0, air)/200})`; ctx.beginPath(); ctx.ellipse(g.x, g.y, w*.42*(1 - Math.max(0, air)/160), 13, 0, 0, 7); ctx.fill();
    const stomp = g.state === "chase" ? Math.abs(Math.sin(g.walk/220))*4 : 0;
    ctx.save(); ctx.translate(g.x + quake, g.y - air - stomp); ctx.scale((g.face > 0 ? -1 : 1)*sx, sy); ctx.drawImage(im, -w/2, -h, w, h); ctx.restore();
    if (g.state === "dazed"){ ctx.save(); ctx.fillStyle = "#fff6c8"; for (let i = 0; i < 4; i++){ const a = G.t/140 + i*1.57; ctx.beginPath(); ctx.arc(g.x + Math.cos(a)*30, g.y - h - 6 + Math.sin(a)*8, 4, 0, 7); ctx.fill(); } ctx.restore(); }
  }
  function drawFX(){
    for (const e of G.fx){
      if (e.kind === "wire"){ const k = e.t/e.life; ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(170,255,140,${1 - k})`; ctx.lineWidth = 3; jag([e.x, e.y], [e.tx, e.ty], 14, 9); ctx.restore(); continue; }
      const k = e.t/e.life, cy = e.y - 42;
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const fr = frameOf(e.p); if (fr){ const hgt = 86*(1 + .5*k), wd = fr.w/fr.h*hgt; ctx.globalAlpha = .55*(1 - k); ctx.translate(e.p.x, e.p.y); if (e.p.mirror) ctx.scale(-1, 1); ctx.drawImage(fr.sil, -wd/2, -hgt, wd, hgt); baseTf(); ctx.translate(0, -(G.camY - H/2)); ctx.globalAlpha = 1; }
      for (const [d, col] of [[0, "180,240,255"], [.12, "255,246,200"]]){ const kk = clamp((k - d)/(1 - d), 0, 1), r = 20 + 110*Math.pow(kk, .6); ctx.strokeStyle = `rgba(${col},${1 - kk})`; ctx.lineWidth = 4*(1 - kk) + 1; ctx.beginPath(); ctx.ellipse(e.x, cy, r, r*.75, 0, 0, 7); ctx.stroke(); }
      for (let i = 0; i < 12; i++){ const a = e.seed + i/12*Math.PI*2, r0 = 30 + 90*k, r1 = r0 + 26*(1 - k); ctx.strokeStyle = `rgba(220,250,255,${.9*(1 - k)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(e.x + Math.cos(a)*r0, cy + Math.sin(a)*r0*.75); ctx.lineTo(e.x + Math.cos(a)*r1, cy + Math.sin(a)*r1*.75); ctx.stroke(); }
      for (let i = 0; i < 6; i++){ const a = e.seed*3 + i*1.1, r = 50*k + 20, sx = e.x + Math.cos(a)*r, sy = cy - 8 + Math.sin(a)*r*.7 - 30*k, sz = 6*(1 - k) + 1; ctx.fillStyle = `rgba(255,255,255,${1 - k})`;
        ctx.beginPath(); ctx.moveTo(sx, sy - sz*2); ctx.lineTo(sx + sz*.5, sy); ctx.lineTo(sx, sy + sz*2); ctx.lineTo(sx - sz*.5, sy); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(sx - sz*2, sy); ctx.lineTo(sx, sy + sz*.5); ctx.lineTo(sx + sz*2, sy); ctx.lineTo(sx, sy - sz*.5); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      const up = 30*k; ctx.save(); ctx.globalAlpha = Math.min(1, (1 - k)*2); ctx.font = "italic 700 20px Signika, sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 5; ctx.strokeStyle = "#0b2a3a";
      const gr = ctx.createLinearGradient(0, e.y - 126 - up, 0, e.y - 106 - up); gr.addColorStop(0, "#ffffff"); gr.addColorStop(1, "#7fe0ff"); ctx.fillStyle = gr;
      const sc = 1 + .4*Math.max(0, .15 - k)/.15; ctx.translate(e.x, e.y - 112 - up); ctx.scale(sc, sc); ctx.strokeText("PERFECT!", 0, 0); ctx.fillText("PERFECT!", 0, 0); ctx.restore();
    }
  }
  function drawSlime(sl){
    const im = imgs.slime; if (!im) return;
    const h = 46*sl.size, w = im.width/im.height*h, air = sl.air || 0;
    const sq = sl.squash > 0 ? sl.squash/170 : 0, sx = 1 + .25*sq - .08*(air/30), sy = 1 - .22*sq + .12*(air/30);   // squash on landing, stretch in the air
    ctx.fillStyle = `rgba(0,0,0,${.35 - air/150})`; ctx.beginPath(); ctx.ellipse(sl.x, sl.y, w*.4*(1 - air/90), 7*(1 - air/90), 0, 0, 7); ctx.fill();
    ctx.save(); ctx.translate(sl.x, sl.y - air - (sl.rot ? h/2 : 0)); if (sl.rot) ctx.rotate(sl.rot); ctx.translate(0, sl.rot ? h/2 : 0); ctx.scale((sl.face > 0 ? -1 : 1)*sx, sy); ctx.drawImage(im, -w/2, -h, w, h); ctx.restore();
    if (sl.launch && Math.random() < .5) G.puffs.push({ x: sl.x + rnd(-6, 6), y: sl.y - air - h*.4, t: 300 });
    if (sl.pop){ ctx.save(); ctx.globalAlpha = Math.max(0, 1 - sl.pop.t/1300); ctx.font = "700 13px Signika, sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 4; ctx.strokeStyle = "#14101c"; ctx.fillStyle = "#ffe36b"; const ty = sl.y - air - h - 8 - sl.pop.t*.01; ctx.strokeText(sl.pop.txt, sl.x, ty); ctx.fillText(sl.pop.txt, sl.x, ty); ctx.restore(); }
  }
  function jag(a, b, amp, n=6){ ctx.beginPath(); ctx.moveTo(a[0],a[1]); for (let i=1;i<n;i++){ const t=i/n; ctx.lineTo(a[0]+(b[0]-a[0])*t+rnd(-amp,amp), a[1]+(b[1]-a[1])*t+rnd(-amp,amp)); } ctx.lineTo(b[0],b[1]); ctx.stroke(); }
  function drawBolt(b){
    const a = 1 - b.t/b.life; if (a <= 0) return;
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineJoin = "round"; ctx.lineCap = "round";
    const pass = (w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); b.pts.forEach(([x,y],i)=> i? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.stroke(); for (const f of b.forks){ ctx.lineWidth = w*.5; ctx.beginPath(); f.forEach(([x,y],i)=> i? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.stroke(); } };
    pass(16, `rgba(150,110,255,${.35*a})`); pass(7, `rgba(200,180,255,${.7*a})`); pass(2.5, `rgba(255,255,240,${a})`);
    const rg = ctx.createRadialGradient(b.x,b.y,0,b.x,b.y,70); rg.addColorStop(0,`rgba(255,250,220,${.8*a})`); rg.addColorStop(1,"rgba(180,140,255,0)");
    ctx.fillStyle = rg; ctx.beginPath(); ctx.ellipse(b.x,b.y,70,34,0,0,7); ctx.fill(); ctx.restore();
  }
  function drawHaz(h){
    const lead = isRunner() ? me().d.lead : 1400;
    const shown = h.kind === "plasma" ? h.t : h.t - (h.dur - lead);
    if (shown < 0) return;
    const span = h.kind === "plasma" ? h.dur : lead, k = clamp(shown/span, 0, 1), last = h.dur - h.t < 140, following = h.kind === "plasma" && h.t < h.follow;
    ctx.save(); ctx.globalAlpha = clamp(shown/150, 0, 1);
    const rim = last ? "#fff6c8" : following ? "#7fd8ff" : "#ff8a3c";
    const fill = following ? "rgba(120,200,255," : "rgba(255,140,60,";
    if (h.kind === "circle" || h.kind === "plasma" || h.kind === "slam" || h.kind === "gslam"){
      ctx.fillStyle = fill + ".13)"; ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r, h.r*.55, 0, 0, 7); ctx.fill();
      ctx.fillStyle = fill + (.18 + .22*k) + ")"; ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r*k, h.r*.55*k, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = rim; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r, h.r*.55, 0, 0, 7); ctx.stroke();
      if (following){ ctx.setLineDash([6,6]); ctx.lineDashOffset = -G.t/25; ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r*.7, h.r*.38, 0, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    } else if (h.kind === "donut"){
      ctx.fillStyle = "rgba(255,140,60,.13)"; ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r2, h.r2*.55, 0, 0, 7); ctx.ellipse(h.x, h.y, h.r1, h.r1*.55, 0, 0, 7, true); ctx.fill("evenodd");
      const rr = Math.max(h.r1, h.r2 - (h.r2 - h.r1)*k);
      ctx.fillStyle = `rgba(255,140,60,${.18 + .22*k})`; ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r2, h.r2*.55, 0, 0, 7); ctx.ellipse(h.x, h.y, rr, rr*.55, 0, 0, 7, true); ctx.fill("evenodd");
      ctx.strokeStyle = rim; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r2, h.r2*.55, 0, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r1, h.r1*.55, 0, 0, 7); ctx.stroke();
    } else if (h.kind === "lane"){
      ctx.fillStyle = "rgba(255,140,60,.13)"; ctx.fillRect(h.x0, h.y - h.hw, h.x1 - h.x0, h.hw*2);
      ctx.fillStyle = `rgba(255,140,60,${.18 + .22*k})`; ctx.fillRect(h.x0, h.y - h.hw*k, h.x1 - h.x0, h.hw*2*k);
      ctx.strokeStyle = rim; ctx.lineWidth = 3; ctx.strokeRect(h.x0, h.y - h.hw, h.x1 - h.x0, h.hw*2);
    } else if (h.kind === "column"){
      const top = h.y0, len = h.y1 - h.y0;
      ctx.fillStyle = "rgba(255,140,60,.13)"; ctx.fillRect(h.x - h.hw, top, h.hw*2, len);
      ctx.fillStyle = `rgba(255,140,60,${.18 + .22*k})`; ctx.fillRect(h.x - h.hw, top, h.hw*2, len*k);   // fills from the top down
      ctx.strokeStyle = rim; ctx.lineWidth = 3; ctx.strokeRect(h.x - h.hw, top, h.hw*2, len);
      ctx.lineWidth = 2; for (let i = 1; i < 6; i++){ const yy = top + len*i/6; ctx.beginPath(); ctx.moveTo(h.x - 14, yy - 12); ctx.lineTo(h.x, yy); ctx.lineTo(h.x + 14, yy - 12); ctx.stroke(); }
    } else if (h.kind === "beam" || h.kind === "spikes"){
      const ang = Math.atan2(h.y1 - h.y0, h.x1 - h.x0), len = Math.hypot(h.x1 - h.x0, h.y1 - h.y0);
      ctx.translate(h.x0, h.y0); ctx.rotate(ang);
      ctx.fillStyle = "rgba(255,140,60,.13)"; ctx.fillRect(0, -h.hw, len, h.hw*2);
      ctx.fillStyle = `rgba(255,140,60,${.18 + .22*k})`; ctx.fillRect(0, -h.hw, len*k, h.hw*2);
      ctx.strokeStyle = rim; ctx.lineWidth = 3; ctx.strokeRect(0, -h.hw, len, h.hw*2);
    }
    ctx.restore();
  }
  function drawOrb(o){
    const grow = clamp((o.born ?? 9999)/450, 0, 1), fizz = clamp((o.life ?? 1e9)/800, 0, 1);
    if (grow < 1 && Math.floor(G.t/50)%2) return;   // flickers into being
    ctx.save(); ctx.globalAlpha = Math.min(grow, fizz);
    const y = o.y - 26 + Math.sin(G.t/300 + o.bob)*4;
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(o.x, o.y, 14, 5, 0, 0, 7); ctx.fill();
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    const rg = ctx.createRadialGradient(o.x, y, 2, o.x, y, 32); rg.addColorStop(0,"rgba(230,250,255,.95)"); rg.addColorStop(.4,"rgba(120,200,255,.6)"); rg.addColorStop(1,"rgba(120,160,255,0)");
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(o.x, y, 32, 0, 7); ctx.fill(); ctx.restore(); ctx.strokeStyle = "rgba(150,215,255,.35)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(o.x, o.y, 34, 13, 0, 0, 7); ctx.stroke();
    if (Math.random() < .3){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = "rgba(200,240,255,.7)"; ctx.lineWidth = 1.2; const a = Math.random()*7; jag([o.x, y], [o.x + Math.cos(a)*22, y + Math.sin(a)*22], 4, 3); ctx.restore(); }
    ctx.restore();
  }
  function drawShot(s){
    if (s.delay > 0) return;
    if (s.kind === "bubble" || s.kind === "bubblet"){
      const wob = Math.sin(G.t/120 + s.x*.05)*.08, r = s.r;
      ctx.save(); ctx.fillStyle = "rgba(140,210,255,.22)"; ctx.strokeStyle = "rgba(200,240,255,.85)"; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, r*(1 + wob), r*(1 - wob), 0, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.beginPath(); ctx.arc(s.x - r*.35, s.y - r*.35, r*.22, 0, 7); ctx.fill(); ctx.restore();
      return;
    }
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    const rg = ctx.createRadialGradient(s.x, s.y, 1, s.x, s.y, s.r*2.2); rg.addColorStop(0, "#ffffff"); rg.addColorStop(.35, s.col); rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(s.x, s.y, s.r*2.2, 0, 7); ctx.fill(); ctx.restore();
  }
  function drawSkeleton(x, feetY, h, w){
    ctx.save(); ctx.strokeStyle = "#1a2550"; ctx.fillStyle = "#1a2550"; ctx.lineWidth = Math.max(2, h*.035); ctx.lineCap = "round"; ctx.lineJoin = "round";
    const Y = f => feetY - h*f;
    ctx.beginPath(); ctx.arc(x, Y(.80), h*.12, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(x-h*.045, Y(.80), h*.028, 0, 7); ctx.arc(x+h*.045, Y(.80), h*.028, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x-h*.05, Y(.71)); ctx.lineTo(x+h*.05, Y(.71)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, Y(.66)); ctx.lineTo(x, Y(.36)); ctx.stroke();
    for (const f of [.61,.55,.49]){ ctx.beginPath(); ctx.ellipse(x, Y(f), w*.22, h*.025, 0, Math.PI, 2*Math.PI, true); ctx.stroke(); }
    ctx.beginPath(); ctx.ellipse(x, Y(.35), w*.17, h*.04, 0, 0, Math.PI); ctx.stroke();
    for (const s of [-1,1]){ ctx.beginPath(); ctx.moveTo(x+s*w*.08, Y(.33)); ctx.lineTo(x+s*w*.12, Y(.18)); ctx.lineTo(x+s*w*.12, Y(.03)); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x+s*w*.2, Y(.63)); ctx.lineTo(x+s*w*.36, Y(.52)); ctx.lineTo(x+s*w*.44, Y(.40)); ctx.stroke(); }
    ctx.restore();
  }
  function arcs(x, y, r, n, a){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(220,210,255,${a})`; ctx.lineWidth = 1.6; for (let i=0;i<n;i++){ const t1 = Math.random()*7, t2 = t1 + rnd(.6,1.4); jag([x+Math.cos(t1)*r, y+Math.sin(t1)*r*.9], [x+Math.cos(t2)*r, y+Math.sin(t2)*r*.9], 7); } ctx.restore(); }
  function drawStaminaWheel(p){
    if (p.sta >= p.d.maxSta - .5 && !p.winded) return;
    const x = p.x + 34, y = p.y - 70, r = 13, f = p.sta / p.d.maxSta;
    ctx.save(); ctx.lineWidth = 5; ctx.strokeStyle = "rgba(20,16,25,.7)"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    ctx.strokeStyle = p.winded ? (Math.floor(G.t/200)%2 ? "#ff5d6c" : "#a33") : p.sta < MOVE.dashCost ? "#f2c14e" : "#8fe36b";
    ctx.beginPath(); ctx.arc(x, y, r, -Math.PI/2, -Math.PI/2 + f*Math.PI*2); ctx.stroke();
    const ta = -Math.PI/2 + MOVE.windedResume*Math.PI*2;   /* the Winded recovery point */ ctx.strokeStyle = "#14101c"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x + Math.cos(ta)*(r-6), y + Math.sin(ta)*(r-6)); ctx.lineTo(x + Math.cos(ta)*(r+6), y + Math.sin(ta)*(r+6)); ctx.stroke(); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x + Math.cos(ta)*(r-6), y + Math.sin(ta)*(r-6)); ctx.lineTo(x + Math.cos(ta)*(r+6), y + Math.sin(ta)*(r+6)); ctx.stroke();
    ctx.restore();
  }
  function drawPlayer(p){
    const f = frameOf(p); if (!f) return;
    const hgt = 86, wd = f.w/f.h*hgt, x = p.x, y = p.y - (p.lift || 0);
    ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.ellipse(p.x, p.y, 22, 8, 0, 0, 7); ctx.fill();
    const xray = p.state === "shock" && p.st < 450 && Math.floor(p.st/70)%2 === 0;
    if (p.state === "dash" || p.inv > 0){ for (let i = 1; i <= 3; i++){ ctx.save(); ctx.globalAlpha = .18*(4-i)/3; ctx.translate(x - p.dashDir.x*14*i, y - p.dashDir.y*14*i); if (p.mirror) ctx.scale(-1,1); ctx.drawImage(f.sil, -wd/2, -hgt, wd, hgt); ctx.restore(); } }
    const c = composite(p, f, xray);
    ctx.save(); ctx.translate(x + (p.wiggle > 0 ? (p.lastTap === "left" ? -3 : 3) : 0), y); if (p.mirror) ctx.scale(-1,1);
    if (p.grace > 0 && Math.floor(G.t/90)%2) ctx.globalAlpha = .35;
    if (p.state === "ko") ctx.rotate(-Math.PI/2*.85);   // flat on the ground
    ctx.drawImage(c, -wd/2, -hgt, wd, hgt);
    ctx.restore();
    if (xray) drawSkeleton(x, y, hgt*.95, wd*1.1);
    if (G.mode === "finale" && G.lastZap && p === G.rescuer && p.state !== "shock") googly(x + (p.mirror ? 4 : -4), y - hgt*.8, 5, G.hako.x > p.x ? 1 : -1);
    if (p.state === "shock" && p.st < 450) arcs(x, y-hgt*.5, 34, 3, .9);
    if ((p.state === "shock" && p.st >= 450 && !p.noKnock) || p.state === "stagger" || p.state === "ko"){ ctx.save(); ctx.fillStyle = "#fff6c8"; for (let i = 0; i < 3; i++){ const a = G.t/150 + i*2.1; ctx.beginPath(); ctx.arc(x + Math.cos(a)*16, y - hgt - 4 + Math.sin(a)*5, 3, 0, 7); ctx.fill(); } ctx.restore(); }
    if (p.soot > .3 && Math.random() < .2) G.puffs.push({ x: x + rnd(-10,10), y: y - hgt - 4, t:0 });
    if (p.boost > 0 && (p.state === "walk" || p.state === "run")){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(140,220,255,${.5*Math.min(1, p.boost/600)})`; ctx.lineWidth = 2;
      for (let i = 0; i < 2 + 2*(p.boostStacks || 1); i++){ const ox = rnd(-16, 16), oy = rnd(-70, -10); ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox, y + oy + 26); ctx.stroke(); } ctx.restore(); }
    if (p.me){ ctx.fillStyle = "#f2c14e"; ctx.beginPath(); ctx.moveTo(x, y-hgt-10); ctx.lineTo(x-7, y-hgt-20); ctx.lineTo(x+7, y-hgt-20); ctx.closePath(); ctx.fill(); }
    if (G.mode === "practice" && p.ready){ ctx.fillStyle = "#5fd38a"; ctx.font = "700 13px Signika, sans-serif"; ctx.textAlign = "center"; ctx.fillText("READY", x, y - hgt - (p.me ? 26 : 10)); }
    if (p.me && active(p)) drawStaminaWheel(p);
    if (active(p) && p.state !== "auto" && p.state !== "wait"){   // HP bar under the feet
      const hf = p.hp/p.hpMax, bw = 38;
      ctx.fillStyle = "rgba(20,16,25,.8)"; roundRect(p.x - bw/2 - 1, p.y + 9, bw + 2, 6, 3); ctx.fill();
      ctx.fillStyle = p.hpFlash && G.t - p.hpFlash < 160 ? "#ffffff" : hf > .5 ? "#6fe08a" : hf > .25 ? "#f2c14e" : "#ff5d6c"; roundRect(p.x - bw/2, p.y + 10, Math.max(2, bw*hf), 4, 2); ctx.fill();
    }
    if (p.state === "ko"){
      // big PlayStation-style D-pad with left/right flashing pressed, and a tap meter
      const fr = clamp(p.koTaps/p.koNeed, 0, 1), big = p.me, u = big ? 26 : 9, cy = y - (big ? 150 : 40);
      const lit = Math.floor(G.t/110)%2 ? "right" : "left";
      const pop = big ? 1 + .3*Math.max(0, 1 - (G.t - (p.koAt ?? G.t))/200) : 1;
      ctx.save(); ctx.translate(x, cy); ctx.scale(pop, pop); drawDpad(0, 0, u, lit); ctx.restore();
      const bw = big ? 130 : 40, by = cy + u*1.9;
      ctx.save(); ctx.fillStyle = "rgba(20,16,25,.88)"; roundRect(x - bw/2 - 2, by - 2, bw + 4, big ? 13 : 7, 5); ctx.fill();
      ctx.fillStyle = "#5fd38a"; roundRect(x - bw/2, by, Math.max(2, bw*fr), big ? 9 : 3, 4); ctx.fill();
      if (big){ ctx.font = "italic 700 20px Signika, sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 5; ctx.strokeStyle = "#14101c"; ctx.fillStyle = "#ffb27a"; ctx.strokeText("MASH!", x, by + 34); ctx.fillText("MASH!", x, by + 34); }
      ctx.restore();
    }
  }
  // comic googly eyes on the charred pair: pop in, look at each other, blink
  function googly(cx, cy, r, look){
    const T = G.ft, pop = clamp((T - 4300)/180, 0, 1); if (pop <= 0) return;
    const bl = (G.blinkTimes || []).some(b => T > b && T < b + 130), lid = bl ? 1 : 0;
    const jig = Math.sin(T/55)*.6, dirX = T < 5300 ? look : T < 6100 ? -look : look*.4, dirY = T < 5300 ? .1 : T < 6100 ? -.25 : .35;
    for (const ox of [-r*1.15, r*1.15]){
      const ex = cx + ox, rr = r*pop;
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#14101c"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(ex, cy, rr, 0, 7); ctx.fill(); ctx.stroke();
      if (lid){ ctx.fillStyle = "#14101c"; ctx.beginPath(); ctx.arc(ex, cy, rr + .5, 0, 7); ctx.fill(); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ex - rr*.7, cy); ctx.lineTo(ex + rr*.7, cy); ctx.stroke(); }
      else { ctx.fillStyle = "#14101c"; ctx.beginPath(); ctx.arc(ex + (dirX + jig*.15)*rr*.42, cy + (dirY + Math.cos(T/47)*.08)*rr*.42, rr*.5, 0, 7); ctx.fill(); }
    }
  }
  function drawPedestal(){
    const im = imgs.pedestal; if (!im) return;
    const h = 300, w = im.width/im.height*h, x = L.hako.x, base = L.hako.y + 30;
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.ellipse(x, base - 4, w*.42, 22, 0, 0, 7); ctx.fill();
    ctx.drawImage(im, x - w/2, base - h, w, h);
    const hot = G.hako.zap > 0 && !G.hako.freed;   /* the crystal on top flares when it catches a bolt */
    ctx.save(); ctx.globalCompositeOperation = "lighter"; const cy = base - h + 30, rg = ctx.createRadialGradient(x, cy, 2, x, cy, hot ? 70 : 34);
    rg.addColorStop(0, `rgba(220,200,255,${hot ? .9 : .35 + .15*Math.sin(G.t/300)})`); rg.addColorStop(1, "rgba(160,120,255,0)"); ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, cy, hot ? 70 : 34, 0, 7); ctx.fill(); ctx.restore();
  }
  function drawHako(){
    const h = G.hako, im = imgs.Hako; if (!im) return;
    const S = 96, xray = h.zap > 0 && Math.floor(h.zap/60)%2 === 0, jx = h.zap > 0 ? rnd(-2,2) : 0;
    if (!h.freed){
      const py = h.y - 40 - 111*h.perch;
      ctx.save(); ctx.globalCompositeOperation = "lighter"; const rg = ctx.createRadialGradient(h.x, py, 10, h.x, py, 95); rg.addColorStop(0,"rgba(170,140,255,.3)"); rg.addColorStop(1,"rgba(170,140,255,0)"); ctx.fillStyle = rg; ctx.fillRect(h.x-110,py-110,220,220); ctx.restore();
      arcs(h.x, py, 52 + Math.sin(G.t/330)*3, 4, .55);
    }
    if (h.perch < .5){ ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.ellipse(h.x, h.y, 30, 10, 0, 0, 7); ctx.fill(); }
    const dx = h.x - S/2 + jx, dy = h.y - S*.95 - (h.lift || 0) - 111*(h.perch || 0);
    ctx.save(); if (h.mirror){ ctx.translate(2*h.x, 0); ctx.scale(-1, 1); }
    if (xray){ ctx.drawImage(im.sil, dx, dy, S, S); drawSkeleton(h.x - S*.06 + jx, dy + S*.92, S*.72, S*.42); }
    else { ctx.drawImage(im.img, dx, dy, S, S); if (h.freed && G.lastZap){ ctx.globalAlpha = .95; ctx.drawImage(im.dark, dx, dy, S, S); ctx.globalAlpha = 1; } }
    ctx.restore();
    if (h.zap > 0) arcs(h.x, dy + S*.55, 44, 4, .95);
    if (G.mode === "finale" && G.lastZap && h.zap <= 0){ const fx = h.x + (h.mirror ? 1 : -1)*S*.05; googly(fx, dy + S*.36, 5.5, G.rescuer && G.rescuer.x > h.x ? 1 : -1); }
  }
  function drawWorld(){
    const shake = G.shakes && !reduce ? [rnd(-G.shakes,G.shakes)*.5, rnd(-G.shakes,G.shakes)*.5] : [0,0];
    const top = G.camY - H/2;
    drawGround(top);
    ctx.save(); ctx.translate(shake[0], -top + shake[1]);
    const vis = y => y > top - 260 && y < top + H + 360;
    for (const h of G.haz) if (vis(h.y) || (h.kind === "column" && h.y1 > top && h.y0 < top + H)) drawHaz(h);
    const list = [];
    if (!imgs.ground) for (const d of L.decor) if (d.kind === "wave" && vis(d.y)) list.push({ y: d.y - 400, f: () => drawWave(d) });
    for (const o of L.obs) if (vis(o.y)) list.push({ y:o.y, f: () => o.kind === "rock" ? drawRock(o) : o.kind === "splash" ? drawSplash(o) : drawCrystal(o) });
    for (const pl of L.pillars) if (vis(pl.y)) list.push({ y:pl.y, f: () => drawPillar(pl) });
    for (const o of G.orbs) if (!o.taken && vis(o.y)) list.push({ y:o.y, f: () => drawOrb(o) });
    for (const sl of G.slimes) if (vis(sl.y)) list.push({ y:sl.y, f: () => drawSlime(sl) });
    if (G.kirin && vis(G.kirin.y)) list.push({ y:G.kirin.y, f: drawKirin });
    if (G.gigas && vis(G.gigas.y)) list.push({ y:G.gigas.y, f: drawGigas });
    if (G.skiz && vis(G.skiz.y)) list.push({ y:G.skiz.y, f: drawSkiz });
    for (const w of G.spikeWalls) if (vis(w.y0)) list.push({ y: Math.max(w.y0, w.y1) + 4, f: () => drawSpikeWall(w) });
    if (G.obsx && vis(G.obsx.y)) list.push({ y: G.obsx.y, f: drawObsidrax });
    for (const p of G.players) list.push({ y:p.y, f: () => drawPlayer(p) });
    if (vis(G.hako.y) || vis(L.hako.y)){ list.push({ y: L.hako.y + 30, f: drawPedestal }); list.push({ y: G.hako.y + (G.hako.perch > .01 ? 31 : 0), f: drawHako }); }
    list.sort((a,b) => a.y - b.y).forEach(o => o.f());
    for (const m of L.monsters) if (vis(m.fly ? m.fly.yy : m.y) && ((m.zone === "s2" && G.stage === 1) || (m.zone === "stage" && (G.stage === 2 || G.mode === "intro")) || (m.zone === "yard" && G.mode === "practice" && practiceLesson() >= 4))) drawMonster(m);
    for (const r of G.rings){ const k = r.t/450, h = r.h; ctx.strokeStyle = `rgba(255,240,200,${1-k})`; ctx.lineWidth = 4;
      if (h.kind === "column"){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = `rgba(220,240,255,${.85*(1-k)})`; const ww = h.hw*2*(1 - k*.5); ctx.fillRect(h.x - ww/2, h.y0, ww, h.y1 - h.y0); ctx.restore(); }
      else if (h.kind === "beam"){ ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(220,240,255,${1-k})`; ctx.lineWidth = h.hw*2*(1 - k*.6); ctx.beginPath(); ctx.moveTo(h.x0, h.y0); ctx.lineTo(h.x1, h.y1); ctx.stroke(); ctx.restore(); }
      else if (h.kind === "lane") ctx.strokeRect(h.x0, h.y - h.hw*(1+k*.3), h.x1 - h.x0, h.hw*2*(1+k*.3));
      else { const rr = (h.r2 || h.r)*(.8 + .3*k); ctx.beginPath(); ctx.ellipse(h.x, h.y, rr, rr*.55, 0, 0, 7); ctx.stroke(); } }
    for (const s of G.shots) drawShot(s);
    for (const b of G.bolts) drawBolt(b);
    drawFX();
    for (const s of G.puffs){ s.t += 16; ctx.fillStyle = s.dust ? `rgba(110,95,75,${.45*(1-s.t/700)})` : `rgba(60,55,70,${.5*(1-s.t/700)})`; ctx.beginPath(); ctx.arc(s.x, s.y - s.t*.04, 4 + s.t*.012, 0, 7); ctx.fill(); }
    G.puffs = G.puffs.filter(s => s.t < 700);
    const t = G.t/1000;
    for (let i=0;i<9;i++){ const y = top + ((i*137 + t*12) % (H+200)) - 100, x = (i*211 + Math.sin(t*.3+i)*80) % W; const rg = ctx.createRadialGradient(x,y,0,x,y,170); rg.addColorStop(0,"rgba(150,140,200,.10)"); rg.addColorStop(1,"rgba(150,140,200,0)"); ctx.fillStyle = rg; ctx.fillRect(x-170,y-170,340,340); }
    ctx.restore();
    ctx.save(); ctx.strokeStyle = "rgba(200,210,255,.18)"; ctx.lineWidth = 1; ctx.beginPath();
    const n = reduce ? 30 : 110; for (let i=0;i<n;i++){ const x = (i*97.3 + G.t*.05) % (W+60) - 30, y = (i*61.7 + G.t*.9) % (H+40) - 20; ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 18); } ctx.stroke(); ctx.restore();
    if (G.flash > 0 && !reduce){ ctx.fillStyle = `rgba(240,235,255,${G.flash})`; ctx.fillRect(0,0,W,H); }
    if (G.perfectT > 0){ const a = G.perfectT/420, vg = ctx.createRadialGradient(W/2, H/2, H*.35, W/2, H/2, H*.85); vg.addColorStop(0, "rgba(120,220,255,0)"); vg.addColorStop(1, `rgba(120,220,255,${.35*a})`); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H); }
  }
  function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  function pill(x, y, label, col){
    ctx.font = "600 16px Signika, sans-serif"; const w = ctx.measureText(label).width + 40;
    ctx.fillStyle = "rgba(20,16,25,.85)"; roundRect(x - w/2, y, w, 30, 15); ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; roundRect(x - w/2, y, w, 30, 15); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x - w/2 + 18, y+15, 6, 0, 7); ctx.fill(); ctx.fillStyle = "#ece6f6"; ctx.textAlign = "left"; ctx.fillText(label, x - w/2 + 30, y + 21);
  }
  function stamp(txt, k, size, col){ ctx.save(); ctx.translate(W/2, H/2 - 40); const sc = 1.5 - .5*Math.min(1,k); ctx.scale(sc, sc); ctx.globalAlpha = Math.min(1,k); ctx.font = `700 ${size}px Signika, sans-serif`; ctx.textAlign = "center"; ctx.lineWidth = 9; ctx.strokeStyle = "#3a1e06"; ctx.fillStyle = col; ctx.strokeText(txt, 0, 20); ctx.fillText(txt, 0, 20); ctx.restore(); }
  // ---------- race track: one bar for the whole run, start at the bottom, Hako at the top ----------
  const RUNNER_COL = ["#ff9ec7", "#7fb6ff", "#f2efe6", "#8fe36b"];
  function stageSpan(st){ const y0 = st === 0 ? L.START_Y : L.T[st-1] - L.PLAZA + 70, y1 = st < 2 ? L.T[st] : G.hako.y + 110; return [y0, y1]; }
  function courseLens(){ return [0, 1, 2].map(st => { const [a, b] = stageSpan(st); return a - b; }); }
  function overallProgress(p, lens, total){
    const cur = Math.max(0, G.stage); let done = 0;
    for (let st = 0; st < cur; st++) done += lens[st];
    const [a] = stageSpan(cur), within = p.finished ? lens[cur] : clamp(a - p.y, 0, lens[cur]);
    return (done + within)/total;
  }
  function drawTrack(){
    const x = W - 30, top = 104, bot = H - 34, len = bot - top;
    const lens = courseLens(), total = lens[0] + lens[1] + lens[2];
    ctx.save();
    ctx.fillStyle = "rgba(20,16,25,.82)"; roundRect(x - 11, top - 10, 22, len + 20, 11); ctx.fill();
    ctx.strokeStyle = "#3a2f4d"; ctx.lineWidth = 1.5; roundRect(x - 11, top - 10, 22, len + 20, 11); ctx.stroke();
    let acc = 0;
    for (let st = 0; st < 3; st++){
      const yA = bot - acc/total*len, yB = bot - (acc + lens[st])/total*len;
      ctx.fillStyle = st < G.stage ? "rgba(95,211,138,.5)" : st === G.stage ? "rgba(255,138,60,.6)" : "rgba(155,123,255,.25)";
      ctx.fillRect(x - 5, yB + 1, 10, yA - yB - 2);
      ctx.font = "600 11px Signika, sans-serif"; ctx.textAlign = "right"; ctx.fillStyle = st === G.stage ? "#ffb27a" : "#a99cc0";
      ctx.fillText(String(st + 1), x - 15, (yA + yB)/2 + 4);
      if (st < 2){   // Lightning Pillar checkpoint
        ctx.fillStyle = st < G.stage ? "#5fd38a" : "#9fd8ff"; ctx.strokeStyle = "#14101c"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, yB - 7); ctx.lineTo(x + 7, yB); ctx.lineTo(x, yB + 7); ctx.lineTo(x - 7, yB); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      acc += lens[st];
    }
    // start flag and Hako at the finish
    for (let i = 0; i < 4; i++){ ctx.fillStyle = (i % 2) ? "#14101c" : "#f2efe6"; ctx.fillRect(x - 8 + (i % 2)*8, bot + 3 + Math.floor(i/2)*4, 8, 4); ctx.fillStyle = (i % 2) ? "#f2efe6" : "#14101c"; }
    const hk = imgs.Hako; if (hk){ ctx.save(); ctx.beginPath(); ctx.arc(x, top - 22, 13, 0, 7); ctx.clip(); ctx.drawImage(hk.face, x - 13, top - 35, 26, 26); ctx.restore(); ctx.strokeStyle = "#b48cff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, top - 22, 13, 0, 7); ctx.stroke(); }
    // runners: faces on the bar, nudged left when they bunch up; you're drawn last, on top
    const rs = G.players.map(p => ({ p, f: overallProgress(p, lens, total) })).sort((a, b) => a.f - b.f);
    const lead = rs.filter(r => !r.p.finished || G.stage >= 0).reduce((a, b) => b.f > a.f ? b : a, rs[0]);
    const cols = [];
    for (const r of rs){ r.y = bot - r.f*len; let c = 0; while ((cols[c] || []).some(yy => Math.abs(yy - r.y) < 3)) c++; (cols[c] = cols[c] || []).push(r.y); r.x = x - c*24; }
    rs.sort((a, b) => (a.p.me ? 1 : 0) - (b.p.me ? 1 : 0));
    for (const r of rs){
      const p = r.p, im = imgs[p.name], R = p.me ? 13 : 9;
      if (p.me){ ctx.save(); ctx.shadowColor = "#f2c14e"; ctx.shadowBlur = 10; ctx.fillStyle = "#f2c14e"; ctx.beginPath(); ctx.arc(r.x, r.y, R + 2, 0, 7); ctx.fill(); ctx.restore(); }
      if (im){ ctx.save(); ctx.beginPath(); ctx.arc(r.x, r.y, R, 0, 7); ctx.clip(); ctx.drawImage(im.face, r.x - R, r.y - R, R*2, R*2); ctx.restore(); }
      const hurt = p.state === "shock" || p.state === "stagger";
      ctx.strokeStyle = hurt && Math.floor(G.t/120)%2 ? "#ff5d6c" : p.me ? "#f2c14e" : RUNNER_COL[p.idx]; ctx.lineWidth = p.me ? 3 : 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, R, 0, 7); ctx.stroke();
      if (r === lead && G.mode === "play" && !p.finished){   // leader's crown (and Kirin's favourite target in Stage 3)
        ctx.fillStyle = "#f2c14e"; ctx.beginPath(); ctx.moveTo(r.x - 7, r.y - R - 2); ctx.lineTo(r.x - 7, r.y - R - 9); ctx.lineTo(r.x - 3, r.y - R - 5); ctx.lineTo(r.x, r.y - R - 11); ctx.lineTo(r.x + 3, r.y - R - 5); ctx.lineTo(r.x + 7, r.y - R - 9); ctx.lineTo(r.x + 7, r.y - R - 2); ctx.closePath(); ctx.fill();
      }
      if (p.finished && !p.timedOut){ ctx.fillStyle = "#5fd38a"; ctx.beginPath(); ctx.arc(r.x + R - 2, r.y + R - 2, 5, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }
  // standings for the top-left board: finishers by place, then everyone else by overall progress
  function standings(){
    if (G.stage >= 0 && G.mode !== "practice"){
      const lens = courseLens(), total = lens[0] + lens[1] + lens[2];
      const place = p => p.finished && p.stats.places[G.stage] ? p.stats.places[G.stage].place : null;
      return [...G.players].sort((a, b) => { const pa = place(a), pb = place(b); if (pa != null || pb != null) return (pa ?? 99) - (pb ?? 99); return overallProgress(b, lens, total) - overallProgress(a, lens, total); });
    }
    return [...G.players].sort((a, b) => a.y - b.y);
  }
  const ORD = ["1st", "2nd", "3rd", "4th"], ORD_COL = ["#f2c14e", "#d9dde6", "#d29a62", "#8f86a3"];
  function drawHUD(){
    const live = isLive() || G.mode === "countdown" || G.mode === "roundEnd" || G.mode === "transition";
    if (live){
      const ranked = standings();
      ranked.forEach((p, rank) => {
        // racing-game board: each card eases to its slot; a change of place flashes up/down
        const ty = 10 + rank*40;
        if (p.cardY == null) p.cardY = ty;
        if (p.lastRank != null && p.lastRank !== rank) p.rankFlash = { up: rank < p.lastRank, t: G.t };
        p.lastRank = rank;
        p.cardY += (ty - p.cardY)*.18;
        const x = 10, y = p.cardY, w = 176, hh = 34, fl = p.rankFlash && G.t - p.rankFlash.t < 900 ? 1 - (G.t - p.rankFlash.t)/900 : 0;
        ctx.save();
        ctx.fillStyle = p.me ? "rgba(58,40,20,.9)" : "rgba(20,16,25,.84)"; roundRect(x, y, w, hh, 7); ctx.fill();
        if (fl){ ctx.fillStyle = p.rankFlash.up ? `rgba(95,211,138,${.35*fl})` : `rgba(255,93,108,${.3*fl})`; roundRect(x, y, w, hh, 7); ctx.fill(); }
        ctx.strokeStyle = p.me ? "#c9a44a" : "#3a2f4d"; ctx.lineWidth = p.me ? 2 : 1.2; roundRect(x, y, w, hh, 7); ctx.stroke();
        // place label
        const showPlace = G.stage >= 0 && G.mode !== "practice";
        ctx.textAlign = "center"; ctx.font = "italic 700 13px Signika, sans-serif"; ctx.lineWidth = 3; ctx.strokeStyle = "#14101c"; ctx.fillStyle = showPlace ? ORD_COL[rank] : "#8f86a3";
        const lbl = showPlace ? ORD[rank] : String(rank + 1); ctx.strokeText(lbl, x + 17, y + 22); ctx.fillText(lbl, x + 17, y + 22);
        if (fl){ ctx.fillStyle = p.rankFlash.up ? "#5fd38a" : "#ff5d6c"; ctx.font = "700 9px Signika, sans-serif"; ctx.fillText(p.rankFlash.up ? "▲" : "▼", x + 17, y + 31); }
        // face
        const im = imgs[p.name]; if (im){ ctx.save(); ctx.beginPath(); ctx.arc(x + 48, y + hh/2, 13, 0, 7); ctx.clip(); ctx.drawImage(im.face, x + 35, y + hh/2 - 13, 26, 26); ctx.restore(); }
        ctx.strokeStyle = p.me ? "#f2c14e" : RUNNER_COL[p.idx]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x + 48, y + hh/2, 13, 0, 7); ctx.stroke();
        // name, points, stage progress, stamina
        ctx.textAlign = "left"; ctx.font = "600 11px Signika, sans-serif"; ctx.fillStyle = "#ece6f6"; ctx.fillText(p.name, x + 66, y + 13);
        if (showPlace){ ctx.textAlign = "right"; ctx.fillStyle = "#f2c14e"; ctx.fillText(p.stats.points + " pts", x + w - 7, y + 13); }
        let prog;
        if (G.mode === "practice") prog = clamp((L.PB - p.y)/(L.PB - L.PT), 0, 1);
        else { const st = Math.max(0, G.stage), y0 = st === 0 ? L.START_Y : L.T[st-1] - L.PLAZA + 70, y1 = st < 2 ? L.T[st] : G.hako.y + 110; prog = p.finished ? 1 : clamp((y0 - p.y)/(y0 - y1), 0, 1); }
        const bx = x + 66, bw = w - 74;
        ctx.fillStyle = "#2b2338"; roundRect(bx, y + 15, bw, 4, 2); ctx.fill();
        ctx.fillStyle = p.finished ? (p.timedOut ? "#8a7f99" : "#5fd38a") : (p.state === "shock" || p.state === "stagger") ? "#ff5d6c" : "#9b7bff"; roundRect(bx, y + 15, Math.max(4, bw*prog), 4, 2); ctx.fill();
        const hf = p.hp/p.hpMax; ctx.fillStyle = "#2a1518"; roundRect(bx, y + 21, bw, 5, 2); ctx.fill();
        ctx.fillStyle = p.state === "ko" ? (Math.floor(G.t/150)%2 ? "#ff5d6c" : "#5a2028") : hf > .5 ? "#6fe08a" : hf > .25 ? "#f2c14e" : "#ff5d6c"; roundRect(bx, y + 21, Math.max(3, bw*hf), 5, 2); ctx.fill();
        const sf = p.sta/p.d.maxSta, sw = bw*(p.d.maxSta/132);
        ctx.fillStyle = "#14202a"; roundRect(bx, y + 28, sw, 3, 1.5); ctx.fill();
        ctx.fillStyle = p.winded ? "#ff5d6c" : p.sta < MOVE.dashCost ? "#f2c14e" : "#7fc8ff"; roundRect(bx, y + 28, Math.max(3, sw*sf), 3, 1.5); ctx.fill();
        if (p.cpu){ ctx.font = "700 8px Signika, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#a99cc0"; ctx.fillText("CPU", x + 66 + ctx.measureText(p.name).width*1.4 + 4, y + 13); }
        if (p.pop){ ctx.font = "700 11px Signika, sans-serif"; ctx.fillStyle = p.pop.good ? "#5fd38a" : "#ff5d6c"; ctx.textAlign = "left"; ctx.lineWidth = 3; ctx.strokeStyle = "#14101c"; ctx.strokeText(p.pop.txt, x + w + 6, y + 21); ctx.fillText(p.pop.txt, x + w + 6, y + 21); }
        ctx.restore();
      });
    }
    if (live && G.stage >= 0 && G.mode !== "practice") drawTrack();
    if (isLive()) pill(W/2, 12, G.mode === "practice" ? "Practice" : `Stage ${G.stage+1} · ${STAGES[G.stage].name}`, "#ff8a3c");
    if (G.mode === "play"){
      const inf = G.limit === Infinity, left = inf ? G.stageT : G.limit - G.stageT; ctx.font = "700 22px Signika, sans-serif"; ctx.textAlign = "right"; ctx.lineWidth = 5; ctx.strokeStyle = "#14101c";
      ctx.fillStyle = !inf && left < 30000 ? (Math.floor(G.t/400)%2 ? "#ff5d6c" : "#ffd0d4") : "#f8f0d4"; ctx.strokeText(fmt(left), W-16, 34); ctx.fillText(fmt(left), W-16, 34);
      if (inf){ ctx.font = "600 11px Signika, sans-serif"; ctx.fillStyle = "#a99cc0"; ctx.fillText("NO TIME LIMIT", W-16, 50); }
      if (G.watching && isRunner()){ ctx.font = "600 14px Signika, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#ece6f6"; ctx.fillText(`You're safe. Watching ${G.watching.name}…`, W/2, 62); }
      if (!isRunner()){ ctx.font = "600 13px Signika, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#a99cc0"; ctx.fillText(`Watching ${me().name} · ← → to switch`, W/2, 62); }
    }
    if (G.mode === "practice" && isRunner() && !G.tutOpen){
      const m = me(), x = W - 282, y = H - 194, items = [["Run with Z, dash with X", 1], ["Dash through a strike as it lands", 2], ["Grab plasma, leave it on someone", 3], ["Dash through a monster shot", 4]];
      ctx.fillStyle = "rgba(20,16,25,.85)"; roundRect(x, y, 270, 132, 10); ctx.fill(); ctx.strokeStyle = "#3a2f4d"; ctx.lineWidth = 1.5; roundRect(x, y, 270, 132, 10); ctx.stroke();
      ctx.font = "600 12px Signika, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#a99cc0"; ctx.fillText("PRACTICE · NOTHING COUNTS", x+12, y+18);
      items.forEach(([txt, n], i) => { const done = n === 1 ? (m.lessonDone[0] && m.lessonDone[1]) : m.lessonDone[n], on = m.lesson >= n; ctx.fillStyle = done ? "#5fd38a" : on ? "#ece6f6" : "#6b5f80"; ctx.font = "400 14px Signika, sans-serif"; ctx.fillText(`${done ? "✓" : on ? "›" : "·"} ${txt}`, x+12, y+42+i*22); });
    }
    if (G.toast){ G.toast.t += 16; const a = Math.min(1, G.toast.t/250, (G.toast.dur - G.toast.t)/300);
      if (a <= 0) G.toast = null;
      else { ctx.save(); ctx.globalAlpha = a; ctx.font = "400 17px Signika, sans-serif"; const w = ctx.measureText(G.toast.txt).width + 36, gr = ctx.createLinearGradient(0, H-96, 0, H-56); gr.addColorStop(0, "#f8f0d4"); gr.addColorStop(1, "#ede0b0");
        ctx.fillStyle = gr; roundRect(W/2 - w/2, H-96, w, 40, 10); ctx.fill(); ctx.strokeStyle = "#c9a44a"; ctx.lineWidth = 2; roundRect(W/2 - w/2, H-96, w, 40, 10); ctx.stroke();
        ctx.fillStyle = "#3a1e06"; ctx.textAlign = "center"; ctx.fillText(G.toast.txt, W/2, H-70); ctx.restore(); } }
    if (G.mode === "countdown"){ const s = Math.ceil(G.cd/700); stamp(s > 0 ? String(s) : "GO!", 1, 92, s > 0 ? "#f8f0d4" : "#f2c14e"); }
    if (G.banner){ const k = G.banner.t/220; stamp(G.banner.txt, k, G.banner.txt.length > 14 ? 50 : 70, "#f2c14e"); }
    if (G.text){
      const a = Math.min(1, G.text.t/300, (G.text.dur - G.text.t)/300);
      ctx.fillStyle = `rgba(0,0,0,${.35*a})`; ctx.fillRect(0,0,W,H);
      ctx.save(); ctx.globalAlpha = a; ctx.font = "400 22px Signika, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#f4efe2"; ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 8; wrap(G.text.txt, W/2, H/2 - 10, 640, 30); ctx.restore();
    }
    if (G.speech){
      G.speech.t += 16; const shown = G.speech.txt.slice(0, Math.floor(G.speech.t/28));
      const x = 120, y = H - 150, w = W - 240, h = 118;
      ctx.save(); const gr = ctx.createLinearGradient(0,y,0,y+h); gr.addColorStop(0,"#f8f0d4"); gr.addColorStop(1,"#ede0b0");
      ctx.fillStyle = gr; roundRect(x,y,w,h,12); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#c9a44a"; roundRect(x,y,w,h,12); ctx.stroke(); ctx.strokeStyle = "#7a4e20"; roundRect(x-3,y-3,w+6,h+6,14); ctx.stroke();
      ctx.fillStyle = "#5c3818"; roundRect(x+18, y-16, 86, 30, 8); ctx.fill(); ctx.fillStyle = "#f8f0d4"; ctx.font = "600 16px Signika, sans-serif"; ctx.textAlign = "center"; ctx.fillText(G.speech.who, x+61, y+5);
      ctx.fillStyle = "#3a1e06"; ctx.font = "400 21px Signika, sans-serif"; ctx.textAlign = "left"; wrapL(shown, x+26, y+48, w-52, 28); ctx.restore();
    }
    if (G.fade){ ctx.fillStyle = `rgba(0,0,0,${1 - Math.abs(G.fade.t - 350)/350})`; ctx.fillRect(0,0,W,H); }
    if (NET.hostLost()){ ctx.fillStyle = "rgba(10,8,14,.72)"; ctx.fillRect(0, H/2 - 40, W, 80); ctx.font = "600 20px Signika, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#f8f0d4"; ctx.fillText("Lost contact with the GM. Waiting…", W/2, H/2 + 7); }
    if (env.showPerf && env.showPerf()) drawPerf();
  }
  function wrap(txt, x, y, maxW, lh){ const words = txt.split(" "); let line = "", lines = []; for (const w of words){ const t = line ? line+" "+w : w; if (ctx.measureText(t).width > maxW && line){ lines.push(line); line = w; } else line = t; } lines.push(line); lines.forEach((l,i) => ctx.fillText(l, x, y + (i - (lines.length-1)/2)*lh)); }
  function wrapL(txt, x, y, maxW, lh){ const words = txt.split(" "); let line = "", i = 0; for (const w of words){ const t = line ? line+" "+w : w; if (ctx.measureText(t).width > maxW && line){ ctx.fillText(line, x, y + i*lh); i++; line = w; } else line = t; } ctx.fillText(line, x, y + i*lh); }

  // ==========================================================================
  // Networking (everything below is new; everything above is the mockup)
  // ==========================================================================
  const PULSE = { idle: 0, charge: 1, live: 2 }, PULSE_N = ["idle", "charge", "live"];
  const GST = { chase: 0, leap: 1, dazed: 2 }, GST_N = ["chase", "leap", "dazed"];
  const OST = { burrow: 0, warn: 1, up: 2 }, OST_N = ["burrow", "warn", "up"];
  const OWNER_KEYS = new Set(["points", "places", "wins", "timeouts"]);   // the host keeps these; owners keep the rest
  const INTERP_MS = 110, SNAP_MS = 50, WORLD_MS = 100, DROP_MS = 4500;

  function makeNet(){
    let seq = 0, snapAcc = 0, worldAcc = 0, helloAcc = 0;
    const worldBuf = [], lastSnapAt = new Map(), lastHeard = new Map();
    const tag = (env.myIdx >= 0 ? "p" + env.myIdx : env.isHost ? "h" : "g") + Math.random().toString(36).slice(2, 5);
    return {
      nextId: () => tag + "." + (++seq),
      send: (k, d) => { if (!dead) env.net.send(k, d); },
      hazard(h){ if (env.isHost) env.net.send("haz", packHaz(h)); },
      orb(o){ if (env.isHost) env.net.send("orb", { id:o.id, x:o.x, y:o.y, cx:o.cx, amp:o.amp, per:o.per, ph:o.ph, bob:o.bob, born:o.born, life:o.life, lesson:!!o.lesson }); },
      hostLost: () => !env.isHost && env.net.hostSilentMs() > 4000 && !!G && G.mode !== "summary",
      heard(userId){ lastHeard.set(userId, env.net.hostNow()); },
      heardRecently: (userId, ms = 3500) => env.net.hostNow() - (lastHeard.get(userId) ?? -1e9) < ms,
      snapFrom(i){ lastSnapAt.set(i, env.net.hostNow()); },
      pushWorld(w){ worldBuf.push(w); worldBuf.sort((a, b) => a.t - b.t); while (worldBuf.length > 6) worldBuf.shift(); },
      tick(dt){
        if (!G) return;
        const now = env.net.hostNow(), rt = now - INTERP_MS;
        for (const p of G.players) if (!p.local && p.net && p.net.length) interpRunner(p, rt);
        if (!env.isHost && worldBuf.length) applyWorld(worldBuf, rt);
        snapAcc += dt; if (snapAcc >= SNAP_MS){ snapAcc = 0; for (const p of G.players) if (p.local) sendSnap(p, now); }
        helloAcc += dt; if (helloAcc >= 2000){ helloAcc = 0; env.net.send("hello", { seat: env.myIdx }); }
        if (env.isHost){
          worldAcc += dt; if (worldAcc >= WORLD_MS){ worldAcc = 0; sendWorld(now); }
          // a runner whose player is GONE (no snapshot and not even the background clock ping) is taken
          // over by a CPU so the race goes on; a player who merely tabbed away keeps their seat
          if (isLive() || G.mode === "countdown") for (const p of G.players){
            if (p.cpu || p.local) continue;
            const now2 = env.net.hostNow(), user = env.roster[p.idx].userId;
            const seen = Math.max(lastSnapAt.get(p.idx) ?? 0, G.seatSince ?? 0, user ? (lastHeard.get(user) ?? 0) : 0);
            if (now2 - seen > DROP_MS) hostFlow("takeover", { i: p.idx });
          }
        }
      },
    };
  }
  function packHaz(h){
    const d = { ht: env.net.hostNow() - (h.t || 0) };
    for (const [k, v] of Object.entries(h)){
      if (k === "owner" || k === "src" || k === "t" || k === "locked") continue;
      if (v == null || typeof v === "object" || typeof v === "function") continue;
      d[k] = typeof v === "number" && !Number.isInteger(v) ? Math.round(v*10)/10 : v;
    }
    if (h.owner){ if (h.owner.stats) d.ow = h.owner.idx; else d.os = h.owner.id; }
    if (h.src) d.srcI = L.obs.indexOf(h.src);
    return d;
  }
  function sendSnap(p, now){
    const r = Math.round, o = { i: p.idx, t: now, x: r(p.x*10)/10, y: r(p.y*10)/10, s: p.state, st: r(p.st || 0), sl: SLOTS.indexOf(p.slot), mi: p.mirror ? 1 : 0,
      li: r(p.lift || 0), iv: p.inv > 0 ? 1 : 0, dx: r((p.dashDir?.x || 0)*100), dy: r((p.dashDir?.y || 0)*100), so: r((p.soot || 0)*100), ch: p.charred ? 1 : 0,
      we: p.wet > 0 ? 1 : 0, gr: p.grace > 0 ? 1 : 0, bo: p.boost > 0 ? 1 : 0, bs: p.boostStacks || 0, hp: r(p.hp), sta: r(p.sta), wi: p.winded ? 1 : 0,
      kt: p.koTaps || 0, kn: p.koNeed || 24, lt: p.lastTap || 0, wg: p.wiggle > 0 ? 1 : 0, rd: p.ready ? 1 : 0, ls: p.lesson || 1 };
    if (p.pop && p.pop !== p._popSent){ p._popSent = p.pop; o.pop = p.pop.txt; o.pg = p.pop.good ? 1 : 0; }
    // nothing changed and sent recently: skip (an idle runner costs 2 messages a second, not 20)
    const key = JSON.stringify({ ...o, t: 0 });
    if (!o.pop && key === p._snapKey && now - (p._snapAt ?? -1e9) < 500) return;
    p._snapKey = key; p._snapAt = now;
    if (now - (p._statsAt ?? -1e9) > 1000){ p._statsAt = now; const st = {}; for (const [k, v] of Object.entries(p.stats)) if (!OWNER_KEYS.has(k)) st[k] = v; o.stats = st; }
    env.net.send("snap", o);
  }
  function onSnap(o){
    const p = G?.players[o.i]; if (!p || p.local) return;
    NET.snapFrom(o.i);
    p.net = p.net || []; p.net.push(o); p.net.sort((a, b) => a.t - b.t); if (p.net.length > 12) p.net.splice(0, p.net.length - 12);
    if (o.pop) p.pop = { txt: o.pop, good: !!o.pg, t: 0 };
    if (o.stats) for (const [k, v] of Object.entries(o.stats)) if (!OWNER_KEYS.has(k)) p.stats[k] = v;
    if (G.mode === "practice" && o.rd && !p.ready){ p.ready = true; renderPracticeBar(); }
  }
  function bracket(buf, rt){
    let a = null, b = null;
    for (const s of buf){ if (s.t <= rt) a = s; else { b = s; break; } }
    if (!a) return { a: b, b: b, k: 0 };
    if (!b) return { a, b: a, k: 0 };
    return { a, b, k: clamp((rt - a.t)/((b.t - a.t) || 1), 0, 1) };
  }
  const lerp = (a, b, k) => a + (b - a)*k;
  function interpRunner(p, rt){
    const { a, b, k } = bracket(p.net, rt); if (!a) return;
    p.x = lerp(a.x, b.x, k); p.y = lerp(a.y, b.y, k);
    if (G.mode === "finale" || G.mode === "summary") return;   // the finale script poses everyone itself
    const s = k > .5 ? b : a;
    if (s.s === "ko" && p.state !== "ko") p.koAt = G.t;
    p.state = s.s; p.st = s.st; p.slot = SLOTS[s.sl] || p.slot; p.mirror = !!s.mi; p.lift = s.li;
    p.inv = s.iv ? 100 : 0; p.dashDir = { x: s.dx/100, y: s.dy/100 }; p.soot = s.so/100; p.charred = !!s.ch; p.wet = s.we ? 100 : 0;
    p.grace = s.gr ? 100 : 0; p.boost = s.bo ? 100 : 0; p.boostStacks = s.bs;
    if (s.hp < p.hp) p.hpFlash = G.t;
    p.hp = s.hp; p.sta = s.sta; p.winded = !!s.wi; p.koTaps = s.kt; p.koNeed = s.kn; p.lastTap = s.lt || null; p.wiggle = s.wg ? 100 : 0; p.lesson = s.ls;
    // drop samples nobody will interpolate from again
    while (p.net.length > 2 && p.net[1].t < rt - 200) p.net.shift();
  }
  // a runner changing hands carries only what snapshots carry (no knockback vector, no dash timer):
  // start it clean, with a moment of grace, rather than half-way through someone else's stun
  function adoptRunner(p){
    const moving = p.state === "auto" || p.state === "wait";
    if (!moving) p.state = "idle";
    p.st = 0; p.kb = null; p.kbDir = { x: 0, y: 1 }; p.kbLen = 0; p.dashT = 0; p.koPending = false; p.stunOverride = 0; p.noKnock = false;
    if (!(p.hp > 0)) p.hp = p.hpMax;
    p.grace = Math.max(p.grace || 0, 800); p.inv = 0; p.wiggle = 0;
    if (!p.dashDir) p.dashDir = { x: 0, y: -1 };
  }
  function stepRemote(p, dt){
    if (p.pop){ p.pop.t += dt; if (p.pop.t > 1100) p.pop = null; }
  }
  function sendWorld(now){
    const r = Math.round, z = G.skiz, g = G.gigas, o = G.obsx, k = G.kirin;
    env.net.send("world", { t: now,
      m: L.monsters.map(m => m.fly ? [r(m.fly.x), r(m.fly.yy), m.fly.dir, PULSE[m.pulse] ?? 0, r(m.pt || 0), m.fire > 0 ? 1 : 0] : [null, null, 0, 0, 0, m.fire > 0 ? 1 : 0]),
      k: k ? [r(k.x), r(k.y), k.face, k.fire > 0 ? 1 : 0, k.charge || 0] : null,
      g: g ? [r(g.x), r(g.y), GST[g.state] ?? 0, r(g.st || 0), g.face, r(g.air || 0), r(g.walk || 0)] : null,
      z: z ? [r(z.x), r(z.y), z.side, z.state === "rush" ? 1 : 0] : null,
      o: o ? [r(o.x), r(o.y), OST[o.state] ?? 0, r(o.st || 0)] : null,
      s: G.slimes.map(sl => [sl.id, r(sl.x), r(sl.y), r(sl.air || 0), sl.face, r(sl.size*100), sl.squash > 0 ? r(sl.squash) : 0, r((sl.rot || 0)*100),
        (sl.jump ? 1 : 0) | (sl.script ? 2 : 0) | (sl.launch ? 4 : 0), sl.pop && sl.pop.t < 120 ? sl.pop.txt : 0]),
    });
  }
  function applyWorld(buf, rt){
    const { a, b, k } = bracket(buf, rt); if (!a) return;
    L.monsters.forEach((m, i) => { const A = a.m[i], B = (b.m[i] || A); if (!A) return;
      if (A[0] == null){ m.fly = null; } else { m.fly = m.fly || { y: m.homeY, t: 0 }; m.fly.x = lerp(A[0], B[0] ?? A[0], k); m.fly.yy = lerp(A[1], B[1] ?? A[1], k); m.fly.dir = B[2] || A[2]; }
      const S = k > .5 ? B : A; m.pulse = PULSE_N[S[3]] || "idle"; m.pt = S[4]; m.fire = S[5] ? 200 : 0; });
    if (!b.k) G.kirin = null; else { const A = a.k || b.k, B = b.k; G.kirin = Object.assign(G.kirin || {}, { x: lerp(A[0], B[0], k), y: lerp(A[1], B[1], k), face: B[2], fire: B[3] ? 300 : 0, charge: B[4] }); }
    if (!b.g) G.gigas = null; else { const A = a.g || b.g, B = b.g; G.gigas = Object.assign(G.gigas || {}, { x: lerp(A[0], B[0], k), y: lerp(A[1], B[1], k), state: GST_N[B[2]], st: B[3], face: B[4], air: lerp(A[5], B[5], k), walk: B[6] }); }
    if (!b.o) G.obsx = null; else { const A = a.o || b.o, B = b.o; G.obsx = Object.assign(G.obsx || {}, { x: lerp(A[0], B[0], k), y: lerp(A[1], B[1], k), state: OST_N[B[2]], st: B[3] }); }
    if (!b.z){ if (!(G.skiz && G.skiz.state === "rush")) G.skiz = null; }
    else { const A = a.z || b.z, B = b.z; G.skiz = G.skiz || { trail: [], state: "track" };
      if (G.skiz.state !== "rush"){ G.skiz.x = lerp(A[0], B[0], k); G.skiz.y = lerp(A[1], B[1], k); G.skiz.side = B[2]; G.skiz.state = "track"; } }
    // slimes keep their identity (a following strike may belong to one)
    const prev = new Map(G.slimes.map(sl => [sl.id, sl])), aById = new Map((a.s || []).map(r => [r[0], r])), next = [];
    for (const R of b.s || []){
      const A = aById.get(R[0]) || R, sl = prev.get(R[0]) || { id: R[0], size: 1, face: 1 };
      sl.x = lerp(A[1], R[1], k); sl.y = lerp(A[2], R[2], k); sl.air = lerp(A[3], R[3], k); sl.face = R[4]; sl.size = R[5]/100; sl.squash = R[6]; sl.rot = R[7]/100;
      sl.jump = R[8] & 1 ? true : null; sl.script = R[8] & 2 ? true : null; sl.launch = R[8] & 4 ? true : null;
      if (R[9] && sl._popTxt !== R[9]){ sl._popTxt = R[9]; sl.pop = { txt: R[9], t: 0 }; } else if (!R[9]) sl._popTxt = null;
      next.push(sl);
    }
    G.slimes = next;
  }
  function bonkSlime(sl, dir){   // host
    const d = 240 + rnd(-30, 40);
    sl.launch = { fx:sl.x, fy:sl.y, tx: sl.x + dir.x*d, ty: sl.y + dir.y*d*.8, t:0, dur:620, spin: (dir.x >= 0 ? 1 : -1)*rnd(10, 16) }; sl.jump = null; sl.air = 0;
    sl.pop = { txt:"Boing!", t:0 };
  }

  // ── round flow: the host decides, every screen follows ────────────────────
  function hostFlow(type, data = {}){ if (!env.isHost || dead) return; env.net.send("flow", { type, data }); applyFlow(type, data); }
  // after the opening (or with none): the practice yard, or a playtest with practice off goes straight to the race
  function hostAfterIntro(){ if (PT && PT.practice === false) hostFlow("race", { s: START_STAGE }); else hostFlow("practice", {}); }
  function seats(){
    return G.players.map((p, i) => {
      const user = env.roster[i].userId || null;
      // a dropped player gets their runner back at the next round break, if they are here again
      const back = p.cpu && user && p.cpuBy === "drop" && NET.heardRecently(user);
      return { user, cpu: back ? false : p.cpu };
    });
  }
  function applySeats(list){
    if (!Array.isArray(list)) return;
    let mine = false;   // one runner per player, whatever the seats say
    list.forEach((s, i) => {
      const p = G.players[i]; if (!p) return;
      env.roster[i].userId = s.user; const wasLocal = p.local;
      p.cpu = !!s.cpu; if (!p.cpu) p.cpuBy = null;
      p.me = !mine && !p.cpu && !!s.user && s.user === env.userId; if (p.me) mine = true;
      p.local = p.me || (env.isHost && p.cpu);
      p.bot = p.bot || BOT[p.name] || BOT.Same;
      if (wasLocal !== p.local){ p.net = []; if (p.local) adoptRunner(p); }
    });
    G.meIdx = G.players.findIndex(p => p.me);
    G.seatSince = env.net.hostNow();
  }
  function applyFlow(type, d){
    switch (type){
      case "intro": G.mode = "intro"; G.intro = null; music.main(); addSkip(); break;
      case "practice":
        clearOv(); G.text = null; G.speech = null; G.endSent = false; music.main();
        fadeTo(() => { L.pillars.forEach(p => p.shown = 0); startPractice(); G.camY = L.PB - 200; G.inputOk = false; if (isRunner()) showOverview(); });
        break;
      case "endPractice": endPractice(); break;
      case "race": clearOv(); G.text = null; G.speech = null; G.endSent = true; music.main(); endPractice(d.s ?? START_STAGE, false); break;
      case "seats": applySeats(d.seats); if (!G.tutOpen) G.inputOk = true; renderPracticeBar(); break;
      case "stage": applySeats(d.seats); G.overSent = false; G.nextSent = null; showStageCard(d.s); break;
      case "finish": { const p = G.players[d.i]; if (p && p.running) finish(p, d.place, d.time); break; }
      case "timeUp": timeUp(d.order); break;
      case "roundOver": roundOver(); break;
      case "finale": G.summarySent = false; startFinale(d.rescuer); break;
      case "summary": showSummary(d); if (env.isHost) env.onResult?.(resultOf(d)); break;
      case "again": { const sv = G.players.map(p => ({ cpu: p.cpu, user: env.roster[p.idx].userId })); newGame(QUICK, { replay: true }); applySeats(sv); G.camY = L.PB - 200; clearOv(); if (env.isHost) later(300, () => hostAfterIntro()); break; }
      case "takeover": {
        const p = G.players[d.i]; if (!p || p.cpu) break;
        const wasMe = p.me; p.cpu = true; p.cpuBy = "drop"; p.me = false; p.local = env.isHost; p.bot = p.bot || BOT[p.name] || BOT.Same; p.net = []; p.goalSent = !p.running;
        if (p.local) adoptRunner(p);
        if (wasMe){ G.meIdx = -1; toast("Connection hiccup: a CPU runs for you until the next round.", 4000); }
        else toast(p.name + " lost connection: a CPU runs for them until the next round.", 3000);
        break;
      }
      case "close": env.onClose?.(); break;
    }
  }
  function hostGoal(i){
    const p = G.players[i]; if (!p || !p.running || G.mode !== "play") return;
    hostFlow("finish", { i, place: G.placeN + 1, time: Math.round(G.stageT) });
  }
  function hostCallRound(){
    if (!env.isHost || G.mode !== "play" || G.overSent) return;
    G.overSent = true;
    const order = G.players.filter(p => p.running).sort((a, b) => a.y - b.y).map(p => p.idx);
    if (order.length) hostFlow("timeUp", { order });
    hostFlow("roundOver", {});
  }
  function hostNext(){
    if (!env.isHost || G.mode !== "roundEnd" || G.nextSent === G.stage) return;
    G.nextSent = G.stage; G.autoNext = 0;
    if (G.stage < 2) hostFlow("stage", { s: G.stage + 1, seats: seats() });
    else { const champ = [...G.players].sort((a, b) => (a.stats.places[2]?.place ?? 9) - (b.stats.places[2]?.place ?? 9))[0]; hostFlow("finale", { rescuer: champ.idx }); }
  }
  function resultOf(sum){
    return { replay: !!G.replay, rescuer: env.roster[sum.rescuer]?.actorId ?? null,
      ranking: sum.rows.map(r => ({ actorId: env.roster[r.i].actorId, name: G.players[r.i].name, place: r.place, points: r.points, cpu: !!G.players[r.i].cpu })) };
  }
  // a late (re)joiner gets enough to watch until the next round break
  function syncState(){
    return { mode: G.mode, stage: G.stage, stageT: Math.round(G.stageT), limit: G.limit === Infinity ? 0 : G.limit, replay: !!G.replay, seats: G.players.map(p => ({ user: env.roster[p.idx].userId || null, cpu: p.cpu })),
      pts: G.players.map(p => p.stats.points), places: G.players.map(p => p.stats.places), running: G.players.map(p => !!p.running), fin: G.players.map(p => !!p.finished),
      ready: G.players.map(p => !!p.ready), summary: G.mode === "summary" ? G.summary : null, rescuer: G.rescuer?.idx ?? null };
  }
  function applySync(d){
    newGame(QUICK, { replay: d.replay }); if (d.limit) G.limit = d.limit;
    applySeats(d.seats);
    G.players.forEach((p, i) => { p.stats.points = d.pts[i] || 0; p.stats.places = d.places[i] || []; p.running = d.running[i]; p.finished = d.fin[i]; p.ready = d.ready[i]; });
    G.stage = d.stage; G.stageT = d.stageT; G.inputOk = true;
    if (d.mode === "summary" && d.summary){ G.rescuer = G.players[d.rescuer] || null; showSummary(d.summary); return; }
    if (d.mode === "practice"){ startPractice(); G.inputOk = false; if (isRunner()) showOverview(); return; }
    if (d.stage >= 0){ G.mode = d.mode === "countdown" ? "play" : d.mode; if (G.mode === "intro" || G.mode === "title") G.mode = "play"; }
    else G.mode = "intro";
    G.camY = G.stage >= 0 ? L.T[G.stage] + 300 : L.START_Y - 120;
  }

  // ── messages from other clients ───────────────────────────────────────────
  const GM_ONLY = new Set(["gmStart", "gmCall", "gmNext", "gmAgain", "gmLeave", "gmSkip"]);
  let queue = [], ready = false;
  function handle(k, d, from){
    if (dead) return;
    if (!ready){ queue.push([k, d, from]); return; }
    try { route(k, d, from); } catch (e) { console.error(TAG, "message " + k + " failed", e); }
  }
  const HOST_ONLY = new Set(["flow", "sync", "world", "haz", "hazStack", "orb", "orbTaken", "shot", "toast", "slimeLand", "skizRush"]);
  function route(k, d, from){
    NET.heard(from?.id);
    if (HOST_ONLY.has(k) && from?.id !== env.hostId) return;
    if (GM_ONLY.has(k) && !(env.isHost && from?.isGM)) return;
    switch (k){
      case "snap": return onSnap(d);
      case "world": if (!env.isHost) NET.pushWorld(d); return;
      case "flow": if (!env.isHost) applyFlow(d.type, d.data || {}); return;
      case "sync": if (!env.isHost && d.to === env.userId) applySync(d); return;
      case "haz": {
        if (env.isHost) return;
        const h = { ...d }; delete h.ow; delete h.os; delete h.srcI; delete h.ht;
        h.t = clamp(env.net.hostNow() - d.ht, 0, 450);
        if (d.ow != null) h.owner = G.players[d.ow]; else if (d.os != null) h.owner = G.slimes.find(s => s.id === d.os) || { x: d.x, y: d.y };
        if (d.srcI != null && d.srcI >= 0) h.src = L.obs[d.srcI];
        if (h.kind === "spikes" && G.obsx){ G.obsx.x = h.x; G.obsx.y = h.y; }
        G.haz.push(h);
        if (h.wire && h.wx != null) G.fx.push({ kind:"wire", x:h.wx, y:h.wy, tx:h.x, ty:h.y - 30, t:0, life:520 });
        return;
      }
      case "hazStack": { const h = G.haz.find(z => z.id === d.id); if (h){ h.stack = d.stack; h.r = d.r; h.follow = d.follow; h.dur = d.dur; } return; }
      case "hazLock": { const h = G.haz.find(z => z.id === d.id); if (h){ h.x = d.x; h.y = d.y; h.locked = true; if (h.t < h.follow) h.follow = h.t; } return; }
      case "orb": if (!env.isHost) G.orbs.push({ ...d, taken: false }); return;
      case "orbTaken": {
        const o = G.orbs.find(z => z.id === d.id); if (o) o.taken = true;
        const p = d.by >= 0 ? G.players[d.by] : null;
        if (p && p.local) gotCharge(p, d.stack || 1);
        if (o && Math.abs(o.y - G.camY) < 400) sfx.pickup();
        return;
      }
      case "pickup": { if (!env.isHost) return; const o = G.orbs.find(z => z.id === d.id), p = G.players[d.i]; if (o && !o.taken && p && active(p)) pickup(p, o); return; }
      case "bonk": { if (!env.isHost) return; const sl = G.slimes.find(s => s.id === d.id); if (sl && !sl.launch) bonkSlime(sl, { x: d.dx, y: d.dy }); return; }
      case "goal": if (env.isHost) hostGoal(d.i); return;
      case "ready": { const p = G.players[d.i]; if (p && !p.ready && G.mode === "practice"){ p.ready = true; p.pop = { txt:"Ready!", good:true, t:0 }; renderPracticeBar(); } return; }
      case "tackle": { const q = G.players[d.to]; if (q && q.local && !(q.state === "stagger" && q.st < 300)) tackled(q, d); return; }
      case "credit": { const p = G.players[d.to]; if (p && p.local){ p.stats.plasmaHits++; p.pop = { txt:`Got ${G.players[d.victim]?.name ?? "them"}!`, good:true, t:0 }; lesson(p, 3); } return; }
      case "slimeLand": slimeLand(d); return;
      case "skizRush": {
        if (env.isHost) return;
        const z = G.skiz = G.skiz || { trail: [], state: "track" };
        z.rush = { fx: d.fx, fy: d.fy, tx: d.tx, ty: d.ty, t: 60, warn: d.warn, hit: new Set() };
        z.state = "rush"; z.x = d.fx; z.y = d.fy; z.px = d.fx; z.py = d.fy; z.side = d.side; return;
      }
      case "shot": if (!env.isHost) G.shots.push({ ...d }); return;
      case "toast": if (d.to == null || G.players[d.to]?.me) toast(d.txt, d.dur); return;
      case "gmStart": if (G.mode === "practice" && !G.endSent){ G.endSent = true; hostFlow("endPractice", {}); } return;
      case "gmCall": hostCallRound(); return;
      case "gmNext": hostNext(); return;
      case "gmAgain": if (G.mode === "summary") hostFlow("again", {}); return;
      case "gmLeave": hostFlow("close", {}); return;
      case "gmSkip": if (G.mode === "intro") hostAfterIntro(); return;
      case "hello":
        if (env.isHost && d?.late && from?.id){
          // a (re)joining party member watches now and runs again from the next round break
          const i = env.seatFor?.(from.id) ?? -1, p = G.players[i];
          if (p && p.cpu){ env.roster[i].userId = from.id; p.cpuBy = "drop"; }
          env.net.send("sync", { ...syncState(), to: from.id });
          // practice doesn't count: they can have their runner back right away
          if (p && p.cpu && G.mode === "practice") later(400, () => hostFlow("seats", { seats: seats() }));
        }
        return;
    }
  }

  // ── assets ────────────────────────────────────────────────────────────────
  const isVideoSrc = (src) => /\.(webm|mp4|m4v|ogv)(\?|#|$)/i.test(String(src || ""));
  async function loadAny(src){ if (!src) return null; return (await load(src)) || (await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; })); }
  function portraitOf(name, img){
    const src = name === "Hako" ? stripBakedShadow(img) : img, w = src.width, h = src.height;
    const face = document.createElement("canvas"); face.width = 72; face.height = 72;
    const cw = name === "Hako" ? w*.45 : Math.min(w, h*.36), cx = name === "Hako" ? w*.24 : (w-cw)/2, cy = name === "Hako" ? h*.12 : h*.02;
    face.getContext("2d").drawImage(src, cx, cy, cw, cw, 0, 0, 72, 72);
    return { img: src, sil: silhouette(src, "#bfe9ff", w, h), dark: silhouette(src, "#14101c", w, h), face };
  }
  const FALLBACK = { down: ["down","downleft","left","upleft","up"], downleft: ["downleft","down","left","upleft","up"], left: ["left","downleft","upleft","down","up"], upleft: ["upleft","up","left","downleft","down"], up: ["up","upleft","left","downleft","down"] };
  async function loadAll(){
    await Promise.all(Object.values(MON).map(async m => { imgs[m.key] = await loadAny(env.asset(m.img)); }));
    const hk = await loadAny(env.asset("hako.png")); if (hk) imgs.Hako = portraitOf("Hako", hk);
    [imgs.ground, imgs.pillar, imgs.pedestal, imgs.lcrystal] = await Promise.all(["ground.webp", "pillar.webp", "pedestal.webp", "p_lcrystal.png"].map(f => loadAny(env.asset(f))));
    await Promise.all(env.roster.map(async (r) => {
      const stand = {}, walk = {}, sil = {};
      await Promise.all(SLOTS.map(async sl => {
        const a = r.art?.[sl] || {};
        const im = await loadAny(a.stand); if (im){ stand[sl] = im; sil[sl] = silhouette(im, "#bfe9ff", im.width, im.height); }
        if (a.walk && isVideoSrc(a.walk)){ const v = vid(a.walk); v.onerror = () => { delete walk[sl]; }; walk[sl] = v; }
      }));
      for (const sl of SLOTS) for (const alt of FALLBACK[sl]){ if (!stand[sl] && stand[alt]){ stand[sl] = stand[alt]; sil[sl] = sil[alt]; } if (!walk[sl] && walk[alt] && alt === sl) walk[sl] = walk[alt]; }
      anims[r.name] = { stand, walk, sil };
      const port = (r.portrait && await loadAny(r.portrait)) || stand.downleft || stand.down;
      if (port) imgs[r.name] = portraitOf(r.name, port);
    }));
  }

  // ── loop ──────────────────────────────────────────────────────────────────
  let raf = 0, last = 0, frameNo = 0, errs = 0;
  const perf = { ms: [], dts: [] };
  function idleVideos(){   // only the walk clips drawn this frame keep decoding
    for (const A of Object.values(anims)) for (const v of Object.values(A.walk)){ if (!v) continue;
      if (v._f !== frameNo && !v.paused) v.pause(); }
  }
  const _frameOf = frameOf;
  frameOf = function(p){ const f = _frameOf(p); if (f && f.src && f.src.tagName === "VIDEO") f.src._f = frameNo; return f; };
  function fit(){
    const box = env.stageBox(); if (!box) return;
    const s = Math.min(box.w/W, box.h/H), dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.min(Math.round(W*s*dpr), env.maxBackingWidth?.() || 2400), bh = Math.round(bw*H/W);
    if (cv.width !== bw || cv.height !== bh){ cv.width = bw; cv.height = bh; }
    SCALE = bw/W; env.place(W*s, H*s, s);
  }
  function frame(now){
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, now - (last || now)); last = now; frameNo++;
    const t0 = performance.now();
    try { if (G){ fit(); baseTf(); update(dt); drawWorld(); drawHUD(); idleVideos(); } }
    catch (e){ errs++; if (errs < 6) console.error(TAG, "frame error", e); }
    const ms = performance.now() - t0; perf.ms.push(ms); perf.dts.push(dt); if (perf.ms.length > 240){ perf.ms.shift(); perf.dts.shift(); }
  }
  function pct(arr, q){ if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length*q))]; }
  function perfStats(){ return { frameP95: +pct(perf.dts, .95).toFixed(1), workP95: +pct(perf.ms, .95).toFixed(2), workAvg: +(perf.ms.reduce((a, b) => a + b, 0)/(perf.ms.length || 1)).toFixed(2), errors: errs, fps: +(1000/((perf.dts.reduce((a, b) => a + b, 0)/(perf.dts.length || 1)) || 16.7)).toFixed(0) }; }
  function drawPerf(){
    const s = perfStats(); ctx.save(); ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(W - 210, H - 46, 204, 40); ctx.font = "12px monospace"; ctx.textAlign = "left"; ctx.fillStyle = s.frameP95 > 20 ? "#ff8a8a" : "#9effa8";
    ctx.fillText(`fps ${s.fps}  frame p95 ${s.frameP95} ms`, W - 204, H - 30); ctx.fillText(`work avg ${s.workAvg} p95 ${s.workP95} ms`, W - 204, H - 14); ctx.restore();
  }

  return {
    async load(){ await loadAll(); },
    // first frame: the host opens with the intro (or straight into practice on a replay); others wait for its word
    begin({ intro = "full", replay = false, late = false } = {}){
      newGame(QUICK, { replay }); G.camY = L.START_Y - 120;
      ready = true; const q = queue; queue = []; for (const [k, d, f] of q) handle(k, d, f);
      raf = requestAnimationFrame(t => { last = t; frame(t); });
      if (late) env.net.send("hello", { seat: env.myIdx, late: true });
      if (env.isHost){
        G.seatSince = env.net.hostNow();
        if (intro === "full") hostFlow("intro", {}); else hostAfterIntro();
      }
    },
    handle,
    leave(){ if (env.isHost) hostFlow("close", {}); },
    destroy(){
      dead = true; cancelAnimationFrame(raf); laters.length = 0;
      removeEventListener("keydown", onKeyDown, true); removeEventListener("keyup", onKeyUp, true); removeEventListener("blur", onBlur);
      try { music.kill(); } catch {}
      for (const A of Object.values(anims)) for (const v of Object.values(A.walk)) if (v){ try { v.pause(); v.removeAttribute("src"); v.load(); } catch {} }
      try { ac?.close?.(); } catch {}
    },
    perf: perfStats,
    get G(){ return G; }, get L(){ return L; },
    // A still of the course (ground, rocks, crystals, Hako's cradle): no runners, HUD or rain. It is the
    // background of the Foundry scene the arrival and thank-you events play on, so that scene looks like the game.
    // Logical units (the 960-wide course) times `scale` = scene pixels.
    renderStill({ top = 0, height = 1500, scale = 1.5 } = {}){
      if (!G) newGame(false, {});
      const out = document.createElement("canvas"); out.width = Math.round(W*scale); out.height = Math.round(height*scale);
      const og = out.getContext("2d"), keep = { w: cv.width, h: cv.height, s: SCALE, mode: G.mode };
      G.mode = "still"; cv.width = out.width; cv.height = Math.round(H*scale); SCALE = scale;
      try {
        for (let y0 = top; y0 < top + height; y0 += H){
          baseTf(); ctx.clearRect(0, 0, W, H); drawGround(y0);
          ctx.save(); ctx.translate(0, -y0);
          const list = [];
          for (const o of L.obs) if (o.y > y0 - 200 && o.y < y0 + H + 200) list.push({ y: o.y, f: () => o.kind === "rock" ? drawRock(o) : o.kind === "splash" ? drawSplash(o) : drawCrystal(o) });
          for (const pl of L.pillars) if (pl.y > y0 - 400 && pl.y < y0 + H + 400) list.push({ y: pl.y, f: () => drawPillar(pl) });
          list.push({ y: L.hako.y + 30, f: drawPedestal });
          list.sort((a, b) => a.y - b.y).forEach(o => o.f());
          ctx.restore();
          og.drawImage(cv, 0, Math.round((y0 - top)*scale));
        }
      } finally { cv.width = keep.w; cv.height = keep.h; SCALE = keep.s; G.mode = keep.mode; }
      return out;
    },
    layout: () => ({ hako: { ...L.hako }, marks: L.marks(2), T2: L.T[2], START_Y: L.START_Y }),
    debug: { step(dt){ update(dt); drawWorld(); drawHUD(); }, hostFlow, hostCallRound, hostNext, startStage, applySeats, seats },
  };
}
