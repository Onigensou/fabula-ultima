// ============================================================================
// Camp Activity — Fishing UI (v2, 2026-11-13)
//
// Port of the approved fishing v2 mockup (rounds 1–20). Every number lives in
// fishing-tuning.js (CampSystem.FishingTuning); this file is the screen.
//
// Round flow (owner):
//   Tackle   pick a rod (Plain Rod + any fishing rods carried) and bait (Bare
//            Hook + any material carried — the Cooking concept)
//   Cast     stop the gauge; the cast sets the top rank that can come
//   Lure     fish visit the bait: look → leave, nibble → leave, or nibble →
//            hooked → "!" bubble. Strike (Space / Z / Enter / click) while it
//            is up; striking on the approach ring = Nice / Perfect timing.
//            Camp + dungeon tile: 20 s lure. Map fishing spot: no limit, Esc
//            reels in for a fresh cast.
//   Fight    hold to raise the bar, keep the fish in it; maybe a sunken chest
//   Result   the only place the fish is revealed (silhouette everywhere else)
//
// Socket (CAMP.MSG):
//   GM  → all  FISHING_START       → show()
//   own → all  FISHING_BEGIN       → spectateBegin()  (gauge starts; tackle chosen)
//   own → all  FISHING_CAST        → onCast()
//   own → all  FISHING_LURE        → onLure()         (lure + end animation events)
//   own → all  FISHING_HIT         → onHit()          (fight heartbeat, 50 ms)
//   own → GM   FISHING_RESULT      → resolveRound()
//   GM  → all  FISHING_RESULT      → applyResult()    (with loot / perfect / reveal data)
//   own → GM   FISHING_CONTINUE    → resolveContinue() (between rounds)
//   GM  → all  FISHING_NEXT_ROUND  → beginRound()
//   own → GM   FISHING_PROCEED     → resolveProceed()  (after the last round)
//   GM  → all  FISHING_DONE        → hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][FishingUI]";
  const OVL_ID    = "oni-camp-fish-ovl";     // map-system/fishing-spot.js checks this id
  const STYLE_ID  = "oni-camp-fish-style";
  const FONT_ID   = "oni-camp-fish-fonts";
  const T         = () => CAMP.FishingTuning;

  const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
  const SND_URL = {
    start: "Sound/check_start.wav", slow: "Sound/slowReel.wav", fast: "Sound/fastReel.wav", land: "Sound/Water_Drop.mp3",
    caught: "Sound/emotion_up.wav", lost: "Sound/participant_exit.wav",
    hover: "Sound/BattleCursor_4.wav", tab: "Sound/BattleCursor_1.wav", click: "Sound/switch_mode.wav", back: "Sound/cursor_back2.wav",
    nibble: "Sound/SFX_TINK.wav", bite: "Sound/Soundboard/SE_CATCHA.wav",
    cS1: "Sound/Success_1.wav", cTrait: "Sound/trait_up1.wav", cS4: "Sound/success_4.wav", cB3: "Sound/bond_level_3.wav",
    cCrit: "Sound/Critical_1.wav", cFP: "Sound/Fabula_Point.ogg",
    chestUp: "Sound/Soundboard/Water3.ogg", chestOpen: "Sound/Soundboard/Chest1.ogg", splash: "Sound/Soundboard/Water1.ogg",
    result: "Sound/SE_SYS_Gacha_ResultDef.ogg", resultSSR: "Sound/SE_SYS_Gacha_itemget_SSR.ogg", treasure: "Sound/TreasureGet.ogg",
    drips: "Sound/BGS/Drips.ogg",
  };
  const IMG = { chest: FORGE + "Fish/Chest.png", goldchest: FORGE + "Item%20Icon/Gold_Chest.png" };

  // Cast sounds by level (★ … ★★★★, MAX). Fabula_Point peaks at 0.25, so it plays at full volume.
  const CAST_LEVELS = [["cS1"], ["cTrait"], ["cS4"], ["cB3"], ["cCrit", "cFP"]];
  const CAST_VOL = { cFP: 1 };

  // Rods: the four starter rods are key items carrying flags.<MODULE_ID>.fishingRod = { attr, color }.
  const ROD_DESC = {
    mig: "Adds one MIG stage on top: the bar rises faster and the catch meter fills faster.",
    dex: "Adds one DEX stage on top: a more nimble bar (faster both up and down) and a slower cast gauge.",
    ins: "Adds one INS stage on top: a taller catch bar.",
    wlp: "Adds one WLP stage on top: more reel time and a stronger pull toward rare fish.",
  };
  const ROD_REEL = { mig: 6, dex: 4, ins: 5, wlp: 5 };
  const PLAIN_ROD = { id: "plain", name: "Plain Rod", attr: null, col: "#b98a52", desc: "Your everyday rod. No bonus." };

  // Fight lane geometry (scene px). The rules run in a 300 px lane (T().H); the lane drawn is 220 px.
  const SURF = 128, LANE_TOP = 140, LANE_H = 220;

  // ── module state ──────────────────────────────────────────────────────────
  let root = null, ovl = null, st = {}, raf = 0, held = false, keyH = null, reelLoop = null, waitLoop = null, ambience = null;
  let timers = [], rafs = new Set();
  let rods = [PLAIN_ROD], baits = [], rodI = 0, baitI = 0, focusRow = 0, picker = null;
  let _fitH = null;
  const lastPick = {};   // actorId → { rod, bait } (names), so the next round keeps the tackle

  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const frame = fn => { const id = requestAnimationFrame(ts => { rafs.delete(id); fn(ts); }); rafs.add(id); return id; };
  const q  = s => root?.querySelector(s);
  const $  = id => root?.querySelector("#" + id) ?? null;
  const rod  = () => rods[rodI] ?? PLAIN_ROD;
  const bait = () => baits[baitI] ?? T().BARE_HOOK;
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
  const _preloaded = new Set();
  const preload = src => { if (!src || _preloaded.has(src)) return; _preloaded.add(src); try { const i = new Image(); i.src = src; } catch {} };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── audio ─────────────────────────────────────────────────────────────────
  function sfx(key, vol = .7) {
    const p = SND_URL[key]; if (!p) return;
    try { foundry.audio.AudioHelper.play({ src: FORGE + p, volume: vol, autoplay: true, loop: false }, false); }
    catch { try { const a = new Audio(FORGE + p); a.volume = vol; a.play().catch(() => {}); } catch {} }
  }
  function castSfx(level) { for (const k of CAST_LEVELS[level] ?? []) sfx(k, CAST_VOL[k] ?? .75); }
  function loop(key, vol = .4) {
    const p = SND_URL[key]; if (!p) return null;
    try { const a = new Audio(FORGE + p); a.loop = true; a.volume = vol; a.play().catch(() => {}); return a; } catch { return null; }
  }
  function stop(a) { if (!a) return; try { a.pause(); a.currentTime = 0; } catch {} }

  // ── ownership ─────────────────────────────────────────────────────────────
  function _ownerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const u = game.users?.get(id);
      return lvl === 3 && u && !u.isGM;
    })?.[0] ?? null;
  }
  // A player-owned actor plays on its player's screen; an unowned one on the primary GM's only.
  function _isOwner(actorId) {
    const actor = game.actors?.get(actorId);
    const uid = actor ? _ownerUserId(actor) : null;
    return uid ? uid === game.user?.id : isPrimaryGM();
  }

  // Owner → GM messages. A broadcast never echoes to its sender, so when the
  // owner IS the primary GM the GM side runs here directly.
  function send(type, payload) {
    CAMP.Socket.emit(type, payload);
    if (!isPrimaryGM()) return;
    const M = CAMP.MSG, id = payload?.actorId;
    if (type === M.FISHING_RESULT) CAMP.FishingUI.resolveRound(id, payload);
    else if (type === M.FISHING_CONTINUE) CAMP.FishingUI.resolveContinue(id);
    else if (type === M.FISHING_PROCEED) { CAMP.ActivityResolveUI?.noteProceed?.(id); CAMP.FishingUI.resolveProceed(id); }
    else CAMP.FishingUI.touch(id);
  }
  const lure = (ev, data = {}) => send(CAMP.MSG.FISHING_LURE, { actorId: st.actorId, ev, ...data });

  // ── styles + fonts ────────────────────────────────────────────────────────
  function _injectStyles() {
    if (!document.getElementById(FONT_ID)) {
      const l = document.createElement("link"); l.id = FONT_ID; l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@500;700;800&family=Signika:wght@400;600;700&family=Cinzel:wght@700;900&display=swap";
      document.head.appendChild(l);
    }
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s);
  }

  // ── tackle data ───────────────────────────────────────────────────────────
  function rodSVG(col, reel) { return `<svg viewBox="0 0 56 56"><path d="M10 48 L46 9" stroke="#1a0f06" stroke-width="5" stroke-linecap="round"/><path d="M10 48 L46 9" stroke="${col}" stroke-width="3" stroke-linecap="round"/><path d="M10 48 L18 39" stroke="#3a2414" stroke-width="5" stroke-linecap="round"/><circle cx="19" cy="42" r="${reel}" fill="#e8dcc4" stroke="#3a2a1c" stroke-width="2"/><circle cx="19" cy="42" r="2" fill="#3a2a1c"/><path d="M46 9 Q52 26 44 40" stroke="#f6f1e6" stroke-width="1" fill="none"/><path d="M44 40 q3 4 -1 6" stroke="#f6f1e6" stroke-width="1.5" fill="none"/></svg>`; }
  const NONE_SVG = `<svg viewBox="0 0 56 56"><path d="M30 10 V34 q0 10 -9 10 q-8 0 -8 -8" stroke="#f6f1e6" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M13 36 l-4 -4" stroke="#f6f1e6" stroke-width="3" stroke-linecap="round"/></svg>`;
  const thumb = o => o.img ? `<img src="${esc(o.img)}" alt="">` : o.svg;

  function _loadTackle(actor) {
    rods = [{ ...PLAIN_ROD, svg: rodSVG(PLAIN_ROD.col, 5) }];
    const seenRod = new Set();
    for (const it of actor?.items ?? []) {
      const f = it.getFlag?.(MODULE_ID, "fishingRod") ?? it.flags?.[MODULE_ID]?.fishingRod;
      if (!f || !T().ROD_ATTRS.includes(f.attr) || seenRod.has(it.name)) continue;
      seenRod.add(it.name);
      const col = f.color || "#b98a52";
      rods.push({ id: it.id, name: it.name, attr: f.attr, col, svg: rodSVG(col, ROD_REEL[f.attr] ?? 5), desc: ROD_DESC[f.attr] });
    }
    const describe = globalThis.FUCompanion?.api?.cooking?.describeItem;
    baits = [{ ...T().BARE_HOOK, svg: NONE_SVG, q: "∞" }];
    for (const it of actor?.items ?? []) {
      const p = it.system?.props ?? {};
      if (String(p.item_type ?? "").toLowerCase() !== "material") continue;
      const qty = parseInt(p.item_quantity) || 0;
      if (qty <= 0) continue;
      const d = describe ? describe(it) : { taste: String(p.ingredient_taste ?? "").toLowerCase(), rarity: p.item_rarity };
      const isFish = st.fishNames?.has(it.name) || !!it.flags?.[MODULE_ID]?.fish;
      baits.push({ id: it.id, name: it.name, img: it.img, q: qty, rarity: d.rarity, ...T().baitEffect({ taste: d.taste, rarity: d.rarity, isFish }) });
    }
    for (const b of baits) preload(b.img);
    const last = lastPick[st.actorId] ?? {};
    rodI  = Math.max(0, rods.findIndex(r => r.name === last.rod));
    baitI = Math.max(0, baits.findIndex(b => b.name === last.bait));
  }

  // ── small stat chart (Tackle): names + bars only, bars slide on change ───
  const STATS = [
    { k: "str",  n: "Strength",  lo: 40,  hi: 190, tip: "How fast the bar rises while you hold. Higher MIG raises it, and some rods add more." },
    { k: "reel", n: "Reel",      lo: 4,   hi: 20,  tip: "How fast the catch meter fills while the fish is inside the bar. Higher MIG raises it, and some rods change it." },
    { k: "ctl",  n: "Control",   lo: 0,   hi: 115, tip: "How nimble the bar is. Higher DEX gets it to full speed sooner, and past d8 makes it move faster both up and down." },
    { k: "foc",  n: "Focus",     lo: .6,  hi: 2.6, tip: "How slowly the cast gauge sweeps, so a strong cast is easier to time. Higher DEX slows it down." },
    { k: "grip", n: "Grip",      lo: 20,  hi: 170, tip: "How tall the bar is. Higher INS makes it bigger, and some rods widen or narrow it." },
    { k: "end",  n: "Endurance", lo: 12,  hi: 26,  tip: "How long you can fight before the fish slips the hook. Higher WLP adds time." },
    { k: "dep",  n: "Depth",     lo: -8,  hi: 40,  tip: "How likely a strong cast hooks a bigger, rarer fish. WLP, some rods and some bait raise it." },
    { k: "lure", n: "Lure",      lo: 0,   hi: 40,  tip: "How often a visiting fish takes the hook instead of just looking or nibbling. Any bait helps, and sweet bait helps most." },
    { k: "fort", n: "Fortune",   lo: 0,   hi: 60,  tip: "The chance a sunken chest drifts in during the fight. Raised by salty bait." },
    { k: "calm", n: "Calm",      lo: 1.4, hi: .6,  tip: "How gently the fish fights. Sour bait calms it, and using a fish as bait makes it fiercer." },
  ];
  function statVals(r, b) {
    const d = T().derive(st.stats, r.attr);
    return { str: d.up, reel: d.fill, ctl: (360 - d.ramp) / 360 * 50 + d.agil * 10, foc: 100 / d.gaugeSpeed, grip: d.barH, end: d.timeout,
      dep: (T().stat(st.stats, r.attr, "wlp") - 8) * 1.5 + (b.tierBonus || 0) + (b.step ? 25 : 0),
      lure: (b.id !== "none" ? 10 : 0) + (b.bite || 0), fort: T().chestChance(b) * 100, calm: (1 + (b.diff || 0)) * (b.calm || 1) };
  }
  const score = (s, v) => Math.max(.03, Math.min(1, (v - s.lo) / (s.hi - s.lo)));
  const chartHTML = () => `<div class="f2-chart">${STATS.map(s => `<div class="f2-st" data-tip="${s.k}"><span>${s.n}</span><span class="f2-sb"><i id="f2-sb-${s.k}" style="width:0"></i></span></div>`).join("")}</div><div class="f2-tip" id="f2-tip"></div>`;
  function updateChart() {
    if (!root) return; const cur = statVals(rod(), bait());
    for (const s of STATS) { const e = $("f2-sb-" + s.k); if (e) e.style.width = (score(s, cur[s.k]) * 100) + "%"; }
  }

  // ── overlay ───────────────────────────────────────────────────────────────
  function _fit() {
    const stage = ovl?.querySelector(".f2-stage"); if (!stage) return;
    const s = Math.min(window.innerWidth / 900, window.innerHeight / 600, 1.35);
    stage.style.transform = `scale(${s})`;
  }
  function _actorImg(actor) {
    return actor?.prototypeToken?.texture?.src ?? actor?.img ?? "icons/svg/mystery-man.svg";
  }

  function _build(actor) {
    document.getElementById(OVL_ID)?.remove();
    _injectStyles();
    ovl = document.createElement("div"); ovl.id = OVL_ID;
    const bg = canvas?.scene?.background?.src;
    if (bg) ovl.style.setProperty("--f2-bg", `url("${bg}")`);
    const place = esc(canvas?.scene?.navName || canvas?.scene?.name || "");
    ovl.innerHTML = `<div class="f2-stage"><div class="f2" id="f2">
      <div class="f2-shell">
        <div class="f2-head w"><span class="f2-title">FISHING</span><span class="f2-place">${place}</span><span class="f2-sp"></span>
          <span class="f2-mini" id="f2-mrod"></span><span class="f2-mini" id="f2-mbait"></span><span class="f2-pips" id="f2-pips"></span></div>
        <div class="f2-scene w"><div class="f2-in" id="f2-in">
          <div class="f2-far"></div><div class="f2-water"><div class="f2-caus"></div><div class="f2-rays"></div></div><div class="f2-surf"></div>
          <div id="f2-motes"></div>
          <div class="f2-crys" style="left:58%;height:34px"></div><div class="f2-crys" style="left:61%;height:20px"></div><div class="f2-crys" style="left:92%;height:40px"></div>
          <div class="f2-ledge"></div>
          <div class="f2-angler" id="f2-angler"><img id="f2-aimg" alt="" src="${esc(_actorImg(actor))}"></div>
          <svg class="f2-svg" id="f2-svg"><path id="f2-rod" fill="none" stroke-linecap="round"/><path id="f2-rodc" fill="none" stroke-linecap="round"/><path id="f2-line" fill="none" stroke="rgba(240,250,255,.85)" stroke-width="1"/><path id="f2-line2" fill="none" stroke="rgba(240,250,255,.6)" stroke-width="1"/></svg>
          <div class="f2-bob" id="f2-bob"></div><img class="f2-hook" id="f2-hook" alt="">
          <div id="f2-fx"></div>
        </div></div>
        <div class="f2-cmd w"><span class="f2-msg" id="f2-msg"></span><span class="f2-stats" id="f2-stats"></span><button class="f2-hold" id="f2-hold" type="button" hidden>HOLD</button></div>
      </div></div></div>`;
    document.body.appendChild(ovl);
    root = ovl.querySelector("#f2");
    _fit(); _fitH = () => _fit(); window.addEventListener("resize", _fitH);
    const m = q("#f2-motes");
    for (let i = 0; i < 16; i++) { const d = document.createElement("span"); d.className = "f2-mote" + (i % 4 === 0 ? " v" : ""); d.style.left = (30 + Math.random() * 68) + "%"; d.style.top = (150 + Math.random() * 210) + "px"; d.style.animationDuration = (5 + Math.random() * 5) + "s"; d.style.animationDelay = (-Math.random() * 8) + "s"; m.appendChild(d); }
    q("#f2-aimg").onload = () => drawRod();
    renderPips(); renderStatsLine(); drawRod();
  }

  function _teardown() {
    try { globalThis.ONI?.TreasureRoulette?.UIKit?.tooltip?.hide(); } catch {}
    timers.forEach(clearTimeout); timers = [];
    rafs.forEach(cancelAnimationFrame); rafs.clear(); cancelAnimationFrame(raf); raf = 0;
    held = false; stop(reelLoop); stop(waitLoop); stop(ambience); reelLoop = waitLoop = ambience = null;
    if (keyH) { document.removeEventListener("keydown", keyH, true); document.removeEventListener("keyup", keyH, true); keyH = null; }
    if (_fitH) { window.removeEventListener("resize", _fitH); _fitH = null; }
    ambientStop();
  }

  const msg = h => { const e = q("#f2-msg"); if (e) e.innerHTML = h; };
  function renderMini() {
    const a = q("#f2-mrod"), b = q("#f2-mbait");
    if (a) a.innerHTML = st.owner || st.tackle ? `${st.owner ? rod().svg : st.tackle.rodSvg}${esc(st.owner ? rod().name : st.tackle.rod)}` : "";
    if (b) b.innerHTML = st.owner || st.tackle ? `${st.owner ? thumb(bait()) : st.tackle.baitThumb}${esc(st.owner ? bait().name : st.tackle.bait)}` : "";
    for (const e of [a, b]) if (e) e.style.visibility = e.innerHTML ? "" : "hidden";
  }
  function renderPips() {
    const p = q("#f2-pips"); if (!p) return;
    p.innerHTML = Array.from({ length: st.totalRounds || 1 }, (_, i) => `<span class="f2-pip ${i < (st.round || 1) ? "on" : ""}"></span>`).join("");
  }
  function renderStatsLine() {
    const p = st.stats ?? {}, e = q("#f2-stats");
    if (e) e.innerHTML = `${esc(st.actorName)} · MIG <b>${p.mig}</b> DEX <b>${p.dex}</b> INS <b>${p.ins}</b> WLP <b>${p.wlp}</b>`;
  }

  // ── geometry ──────────────────────────────────────────────────────────────
  function hand() { const img = q("#f2-aimg"); const h = 112, w = img && img.naturalWidth ? img.naturalWidth * h / img.naturalHeight : 84; return { x: 26 + w * .66, y: 12 + h * .5 }; }
  function tip(bend = 0, toward = null) {
    const H0 = hand(); let t = { x: H0.x + 86, y: H0.y - 62 };
    if (toward && bend) { const dx = toward.x - t.x, dy = toward.y - t.y, L = Math.hypot(dx, dy) || 1; t = { x: t.x + dx / L * bend, y: t.y + dy / L * bend }; }
    return t;
  }
  function rodCol() { return st.owner ? rod().col : (st.tackle?.rodCol ?? PLAIN_ROD.col); }
  function drawRod(bend = 0, toward = null) {
    const h = hand(), t = tip(bend, toward), c = { x: h.x + 44, y: h.y - 46 + bend * .6 };
    const r = q("#f2-rod"), rc = q("#f2-rodc"); if (!r) return tip();
    const d = `M${h.x - 10},${h.y + 8} L${h.x},${h.y} Q${c.x},${c.y} ${t.x},${t.y}`;
    r.setAttribute("d", d); r.setAttribute("stroke", "#1a0f06"); r.setAttribute("stroke-width", "4.5");
    rc.setAttribute("d", d); rc.setAttribute("stroke", rodCol()); rc.setAttribute("stroke-width", "2.5");
    return t;
  }
  function line(a, b, sag, id = "#f2-line") { const l = q(id); if (!l) return; if (!a) { l.setAttribute("d", ""); return; } const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + sag; l.setAttribute("d", `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`); }

  function fx(html, x, y, cls, life) { const f = q("#f2-fx"); if (!f) return null; const d = document.createElement("div"); d.className = cls; d.style.left = x + "px"; d.style.top = y + "px"; if (html) d.innerHTML = html; f.appendChild(d); if (life) later(() => d.remove(), life); return d; }
  function splash(x, n = 9, spread = 60, rise = 40) { for (let i = 0; i < n; i++) { const d = fx("", x, SURF, "f2-drop", 650); if (d) { d.style.setProperty("--dx", ((Math.random() - .5) * spread) + "px"); d.style.setProperty("--dy", (-20 - Math.random() * rise) + "px"); } } ring(x); later(() => ring(x), 220); }
  function ring(x) { fx("", x, SURF + 2, "f2-ring", 1500); }
  function bubbles(x, y, n = 3) { for (let i = 0; i < n; i++) { const d = fx("", x + (Math.random() - .5) * 14, y, "f2-bub", 1100); if (d) d.style.setProperty("--dx", ((Math.random() - .5) * 16) + "px"); } }

  let amb = [], ambRaf = 0;
  function spawnAmbient() {
    ambientStop(); const sil = T().silhouette("std");
    for (let i = 0; i < 3; i++) { const e = document.createElement("div"); e.className = "f2-fish amb"; const len = 26 + Math.random() * 20; e.style.width = len + "px"; e.style.height = len / 2 + "px"; e.innerHTML = `<img src="${sil}" alt="">`; q("#f2-in").appendChild(e);
      amb.push({ e, len, x: 240 + Math.random() * 480, y: 175 + Math.random() * 170, vx: (Math.random() < .5 ? -1 : 1) * (14 + Math.random() * 16), ph: Math.random() * 6 }); }
    let last = performance.now();
    const f = ts => { const dt = Math.min(50, ts - last) / 1000; last = ts; for (const a of amb) { a.x += a.vx * dt; if (a.x < 230 || a.x > 790) a.vx *= -1; a.ph += dt; place(a.e, a.x, a.y + Math.sin(a.ph * 1.4) * 4, a.len, a.vx < 0 ? -1 : 1, 0); } ambRaf = requestAnimationFrame(f); };
    ambRaf = requestAnimationFrame(f);
  }
  function ambientStop() { cancelAnimationFrame(ambRaf); ambRaf = 0; amb.forEach(a => a.e.remove()); amb = []; }
  function scatter() { for (const a of amb) a.vx = Math.sign(a.vx || 1) * 160; later(() => amb.forEach(a => a.e.style.opacity = "0"), 700); }
  function place(e, x, y, len, dir, tilt, scale = 1) { e.style.left = (x - len / 2) + "px"; e.style.top = (y - len / 4) + "px"; e.style.transform = `scale(${scale}) scaleX(${dir}) rotate(${tilt}deg)`; }
  function fishEl(sh, len, legend) {
    const e = document.createElement("div"); e.className = "f2-fish" + (legend ? " legend" : ""); e.style.width = len + "px"; e.style.height = len / 2 + "px";
    e.innerHTML = `<img src="${T().silhouette(sh)}" alt="">`; q("#f2-in").appendChild(e); return e;
  }

  // ════════════════════════════ TACKLE (owner) ═════════════════════════════
  function colHTML(kind, i) {
    const list = kind === "rod" ? rods : baits, o = list[i];
    return `<div class="f2-col ${focusRow === (kind === "rod" ? 0 : 1) ? "focus" : ""}" data-row="${kind}">
      <span class="f2-rl">${kind === "rod" ? "ROD" : "BAIT"}</span>
      <span class="f2-car"><button class="f2-arrow" data-step="-1" data-k="${kind}" type="button" aria-label="Previous ${kind}">◀</button>
        <button class="f2-circ" data-open="${kind}" type="button" aria-label="Open ${kind} list"><span class="f2-track" id="f2-track-${kind}"><span class="f2-th">${thumb(o)}</span></span>${kind === "bait" ? `<span class="q" id="f2-q">×${o.q}</span>` : ""}</button>
        <button class="f2-arrow" data-step="1" data-k="${kind}" type="button" aria-label="Next ${kind}">▶</button></span>
      <span class="f2-name" id="f2-name-${kind}">${esc(o.name)}</span></div>`;
  }
  const focusedItem = () => focusRow === 0 ? rod() : bait();
  const helpLine = () => { if (st.phase === "tackle" && !picker) { const o = focusedItem(); msg(`<b>${esc(o.name)}</b> · ${esc(o.desc)}`); } };
  function openTackle() {
    st.phase = "tackle"; q("#f2-veil")?.remove();
    const v = document.createElement("div"); v.className = "f2-veil"; v.id = "f2-veil"; root.appendChild(v);
    renderTackle(); lure("tackle");
  }
  function renderTackle() {
    const v = $("f2-veil"); if (!v) return;
    v.innerHTML = `<div class="f2-win f2-tackle wg"><span class="plate f2-wt">Tackle</span>
      <div class="f2-sel">${colHTML("rod", rodI)}${colHTML("bait", baitI)}</div>
      <div id="f2-chartbox">${chartHTML()}</div>
      <div class="f2-foot"><span class="f2-keys"><span class="key">←→</span> change <span class="key">↑↓</span> switch</span><button class="btn" id="f2-cast" type="button">CAST LINE</button></div></div>`;
    v.querySelectorAll("[data-step]").forEach(b => { b.onclick = () => step(b.dataset.k, +b.dataset.step); b.onmouseenter = () => sfx("hover", .5); });
    v.querySelectorAll("[data-open]").forEach(b => { b.onclick = () => openPicker(b.dataset.open); b.onmouseenter = () => sfx("hover", .5); });
    let lastWheel = 0;
    v.querySelectorAll("[data-row]").forEach(r => { const kind = r.dataset.row, n = kind === "rod" ? 0 : 1;
      r.onmouseenter = () => setFocus(n);
      r.addEventListener("wheel", e => { e.preventDefault(); e.stopPropagation(); const now = performance.now(); if (now - lastWheel < 150) return; const d = Math.sign(e.deltaY || e.deltaX); if (!d) return; lastWheel = now; setFocus(n); step(kind, d); }, { passive: false }); });
    const c = $("f2-cast"); c.onclick = startCast; c.onmouseenter = () => sfx("hover", .5);
    bindTips();
    requestAnimationFrame(() => updateChart()); helpLine();
  }
  function bindTips() {
    const win = q(".f2-tackle"), tp = $("f2-tip"); if (!win || !tp) return;
    const sc = () => win.getBoundingClientRect().width / win.offsetWidth || 1;
    win.querySelectorAll(".f2-st").forEach(row => {
      row.onmouseenter = () => { const s = STATS.find(x => x.k === row.dataset.tip); tp.innerHTML = `<b>${s.n}</b>${s.tip}`;
        const par = tp.offsetParent || win, pr = par.getBoundingClientRect(), rr = row.getBoundingClientRect(), k = sc();
        const left = Math.max(0, Math.min(par.offsetWidth - 250, (rr.left - pr.left) / k - 6)); tp.style.left = left + "px";
        tp.style.setProperty("--ax", (((rr.left - pr.left) / k + 28) - left) + "px");
        tp.style.top = ((rr.top - pr.top) / k - tp.offsetHeight - 10) + "px"; tp.classList.add("on"); };
      row.onmouseleave = () => tp.classList.remove("on");
    });
  }
  function setFocus(n) { if (n === focusRow) return; focusRow = n; root?.querySelectorAll(".f2-col").forEach(r => r.classList.toggle("focus", (r.dataset.row === "rod" ? 0 : 1) === n)); sfx("hover", .5); helpLine(); }
  function animateRow(kind, d) {
    const list = kind === "rod" ? rods : baits, i = kind === "rod" ? rodI : baitI, track = $("f2-track-" + kind), nm = $("f2-name-" + kind);
    if (!track) return;
    const ease = "cubic-bezier(.3,.7,.3,1)", old = track.lastElementChild, nu = document.createElement("span");
    nu.className = "f2-th"; nu.innerHTML = thumb(list[i]); track.appendChild(nu);
    nu.animate([{ transform: `translateX(${d * 100}%)`, opacity: .3 }, { transform: "none", opacity: 1 }], { duration: 260, easing: ease });
    if (old) { const a = old.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-d * 100}%)`, opacity: .2 }], { duration: 260, easing: ease }); a.onfinish = () => old.remove(); }
    if (nm) { nm.textContent = list[i].name; nm.animate([{ transform: `translateX(${d * 18}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 220, easing: ease }); }
    if (kind === "bait") { const qb = $("f2-q"); if (qb) qb.textContent = "×" + list[i].q; }
  }
  function step(kind, d) {
    if (kind === "rod") rodI = (rodI + d + rods.length) % rods.length; else baitI = (baitI + d + baits.length) % baits.length;
    sfx("tab", .6); renderMini(); animateRow(kind, d); updateChart(); helpLine(); lure("tackle");
  }
  function openPicker(kind) {
    sfx("click", .6); picker = kind; const list = kind === "rod" ? rods : baits, cur = kind === "rod" ? rodI : baitI;
    const v = $("f2-veil"); v.innerHTML = `<div class="f2-win f2-picker wg"><span class="plate f2-wt">${kind === "rod" ? "Rods" : "Bait"}</span>
      <div class="f2-grid">${list.map((o, i) => `<button class="f2-cell ${i === cur ? "sel" : ""}" data-i="${i}" type="button"><span class="f2-circ">${thumb(o)}</span><span>${esc(o.name)}${kind === "bait" ? ` ×${o.q}` : ""}</span></button>`).join("")}</div>
      <div class="f2-foot"><span class="f2-keys">Click to choose · <span class="key">ESC</span> back</span><button class="btn ghost" id="f2-back" type="button">BACK</button></div></div>`;
    v.querySelectorAll(".f2-cell").forEach(b => { b.onmouseenter = () => { sfx("hover", .5); const o = list[+b.dataset.i]; msg(`<b>${esc(o.name)}</b> · ${esc(o.desc)}`); };
      b.onclick = () => { if (kind === "rod") rodI = +b.dataset.i; else baitI = +b.dataset.i; sfx("click", .6); picker = null; renderMini(); renderTackle(); lure("tackle"); }; });
    $("f2-back").onclick = () => { sfx("back", .6); picker = null; renderTackle(); };
  }

  // ── input ─────────────────────────────────────────────────────────────────
  const KEYS = new Set(["Space", "KeyZ", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
  function bindKeys() {
    keyH = e => {
      if (!root || !st.owner) return;
      if (e.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      const k = e.code, down = e.type === "keydown";
      if (!KEYS.has(k)) return;
      const eat = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (st.phase === "tackle") {
        eat(); if (!down) return;
        if (picker) { if (k === "Escape") { sfx("back", .6); picker = null; renderTackle(); } return; }
        if (k === "ArrowLeft" || k === "ArrowRight") step(focusRow === 0 ? "rod" : "bait", k === "ArrowLeft" ? -1 : 1);
        else if (k === "ArrowUp" || k === "ArrowDown") setFocus(1 - focusRow);
        else if (k === "Space" || k === "Enter") startCast();
        return;
      }
      if (st.phase === "lure") {
        if (k === "Space" || k === "KeyZ" || k === "Enter") { eat(); if (down && !e.repeat) strikePress(); }
        else if (k === "Escape" && !st.lureEnd) { eat(); if (down) reelIn(); }
        return;
      }
      if (k !== "Space") return;
      eat();
      if (st.phase === "cast" && down) { if (!e.repeat) lockCast(); return; }
      if (st.phase === "battle") { if (e.repeat) return; setHeld(down); }
    };
    document.addEventListener("keydown", keyH, true); document.addEventListener("keyup", keyH, true);
  }
  function bindHold() {
    const b = q("#f2-hold");
    b.addEventListener("pointerdown", e => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); if (st.phase === "cast") lockCast(); else if (st.phase === "lure") strikePress(); else setHeld(true); });
    q("#f2-in").addEventListener("pointerdown", e => { if (st.phase === "lure") { e.preventDefault(); strikePress(); } });
    b.addEventListener("pointerup", () => setHeld(false)); b.addEventListener("pointercancel", () => setHeld(false));
  }
  function setHeld(v) { if (st.phase !== "battle") return; if (v && !held) st.heldMs = 0; held = v; q("#f2-hold")?.classList.toggle("held", v); }

  // ════════════════════════════ CAST ════════════════════════════════════════
  function gaugeHTML(marks) {
    return `<div class="f2-gauge w"><div class="f2-gtrack"><div class="f2-gsweet"></div><div class="f2-gfill" id="f2-gfill"></div></div></div><div class="f2-gnum" id="f2-gnum">0</div>
      ${marks.map(([v, l]) => `<span class="f2-tick" style="left:250px;top:${21 + (100 - v) / 100 * 226}px"><i>${l}</i> ${Math.round(v)}</span>`).join("")}`;
  }
  function runGauge(speed) {
    let v = 0, dir = 1, last = performance.now();
    const f = ts => { const dt = Math.min(50, ts - last) / 1000; last = ts; v += dir * speed * dt; if (v >= 100) { v = 100; dir = -1; } if (v <= 0) { v = 0; dir = 1; }
      const gf = $("f2-gfill"), gn = $("f2-gnum"); if (gf) { gf.style.height = v.toFixed(1) + "%"; gf.classList.toggle("perfect", v >= 97); } if (gn) { gn.textContent = Math.round(v); gn.classList.toggle("perfect", v >= 97); }
      st.gv = v; raf = requestAnimationFrame(f); };
    raf = requestAnimationFrame(f);
  }
  function startCast() {
    if (st.phase !== "tackle") return;
    sfx("click", .6); $("f2-veil")?.remove(); picker = null; st.phase = "cast";
    if (bait().id !== "none" && !(bait().q > 0)) baitI = 0;   // ran out on the last cast
    lastPick[st.actorId] = { rod: rod().name, bait: bait().name };
    const d = T().derive(st.stats, rod().attr); st.d = d; st.bait = bait(); st.rod = rod();
    const [t2, t3, t4] = T().thresholds(st.stats, rod().attr);
    const marks = [[t2, "★★"], [t3, "★★★"], [Math.min(99, t4), "★★★★"]];
    clearLure();
    const g = document.createElement("div"); g.id = "f2-gwrap"; g.innerHTML = gaugeHTML(marks); q("#f2-fx").appendChild(g);
    const hb = q("#f2-hold"); hb.hidden = false; hb.textContent = "CAST";
    renderMini();
    msg(`Press <span class="f2-key">SPACE</span> to cast. Higher means farther, and bigger fish.`);
    send(CAMP.MSG.FISHING_BEGIN, { actorId: st.actorId, round: st.round, gaugeSpeed: d.gaugeSpeed, marks,
      tackle: { rod: rod().name, rodCol: rod().col, rodSvg: rod().svg, bait: bait().name, baitThumb: thumb(bait()) } });
    runGauge(d.gaugeSpeed);
  }
  function lockCast() {
    if (st.phase !== "cast") return; cancelAnimationFrame(raf); raf = 0; st.phase = "flying";
    const str = Math.round(st.gv ?? 0); st.str = str;
    const level = T().castLevel(str, st.stats, st.rod.attr, st.bait);
    const lx = 300 + str / 100 * 380; st.lx = lx;
    _consumeBait();
    send(CAMP.MSG.FISHING_CAST, { actorId: st.actorId, strength: str, perfect: str >= 97, lx, level });
    castVisual(str, level, lx, () => beginWait());
  }
  function castVisual(str, level, lx, done) {
    cancelAnimationFrame(raf);
    const gn = $("f2-gnum"); if (gn) { gn.textContent = str >= 97 ? "MAX" : str; gn.classList.toggle("perfect", str >= 97); }
    const gf = $("f2-gfill"); if (gf) gf.style.height = str + "%";
    castSfx(level);
    q("#f2-angler").className = "f2-angler cast"; q("#f2-hold").hidden = true;
    msg(str >= 97 ? "A perfect cast!" : `Cast power ${str}.`);
    const t0 = tip(), bob = q("#f2-bob"); bob.className = "f2-bob on"; const dur = 650, start = performance.now();
    const f = ts => { const k = Math.min(1, (ts - start) / dur); const x = t0.x + (lx - t0.x) * k, y = t0.y + (SURF - t0.y) * k - Math.sin(k * Math.PI) * 90;
      bob.style.left = x + "px"; bob.style.top = y + "px"; line(t0, { x, y }, 10 * (1 - k)); drawRod();
      if (k < 1) { raf = requestAnimationFrame(f); return; }
      later(() => $("f2-gwrap")?.remove(), 300);
      sfx("land", .8); splash(lx, 7); bob.className = "f2-bob on float"; done?.(); };
    raf = requestAnimationFrame(f);
  }
  async function _consumeBait() {
    const b = st.bait; if (!b || b.id === "none") return;
    b.q = Math.max(0, (Number(b.q) || 0) - 1);
    try {
      const item = game.actors?.get(st.actorId)?.items?.get(b.id);
      if (!item) return;
      const qty = parseInt(item.system?.props?.item_quantity) || 0;
      if (qty > 1) await item.update({ "system.props.item_quantity": String(qty - 1) });
      else await item.delete();
    } catch (e) { console.warn(TAG, "bait not consumed", e); }
  }

  // ════════════════════════════ LURE ════════════════════════════════════════
  // Visitors one at a time; patterns look / nibble / hook, plus long empty gaps.
  // Striking before the "!" spooks the visitor (the lure goes on). No narration:
  // one static control hint, the scene tells the rest.
  const lureOk = id => root && st.phase === "lure" && st.lureId === id;
  const lateL = (fn, ms) => { const id = st.lureId; later(() => { if (lureOk(id)) fn(); }, ms); };
  function tween(ms, fn, done) { const id = st.lureId, t0 = performance.now(); const f = ts => { if (!lureOk(id)) return; const k = Math.min(1, (ts - t0) / ms); fn(k); if (k < 1) frame(f); else done && done(); }; frame(f); }
  const hookSrc = b => b?.img || ("data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M9 1 V10 q0 4 -4 4 q-3 0 -3 -3' stroke='#e8eef8' stroke-width='1.6' fill='none'/></svg>`));

  function waitVisual(hookY, img, lim) {
    st.phase = "lure"; st.lureId = (st.lureId || 0) + 1; q("#f2-angler").className = "f2-angler wait";
    stop(waitLoop); waitLoop = loop("slow", .35);
    const lx = st.lx, hook = q("#f2-hook"); st.hookY = hookY;
    hook.src = img; hook.className = "f2-hook on";
    msg(lim ? "Strike when you see <b>!</b>" : `Strike when you see <b>!</b> · <span class="f2-key">ESC</span> reels in`);
    const start = performance.now(), t0 = tip(), id = st.lureId;
    const sink = ts => { if (st.lureId !== id) return; const k = Math.min(1, (ts - start) / 900); const y = SURF + (hookY - SURF) * k; hook.style.left = lx + "px"; hook.style.top = y + "px"; line(t0, { x: lx, y: SURF }, 14); line({ x: lx, y: SURF + 4 }, { x: lx, y }, 0, "#f2-line2"); if (k < 1) raf = requestAnimationFrame(sink); };
    raf = requestAnimationFrame(sink);
    st.lureLim = lim; st.lureEnd = lim ? performance.now() + 900 + lim * 1000 : 0;
    lureHud();
  }
  function beginWait() {
    const hookY = SURF + 70 + Math.random() * 60;
    st.v = null;
    waitVisual(hookY, hookSrc(st.bait), st.lureLimit);
    const hb = q("#f2-hold"); hb.hidden = false; hb.textContent = "STRIKE";
    lure("wait", { hookY, lim: st.lureLimit, img: hookSrc(st.bait) });
    _startVisitorBeat();
    lateL(visit, 900 + T().gapMs(true, st.str, st.bait));
  }
  // Spectators see the visitor through a 10 Hz position beat.
  function _startVisitorBeat() {
    const id = st.lureId;
    const beat = () => {
      if (!lureOk(id)) return;
      const v = st.v;
      if (v && v.state !== "gone" && v.e?.isConnected) {
        lure("v", { x: Math.round(v.x), y: Math.round(v.y), len: v.len, dir: v.dir, sh: v.fish?.sh, legend: v.tier === 3,
          tilt: parseFloat(/rotate\(([-\d.]+)/.exec(v.e.style.transform)?.[1] ?? 0) || 0, op: Number(v.e.style.opacity || 1) });
        st._vSent = true;
      } else if (st._vSent) { lure("v0"); st._vSent = false; }
      later(beat, 100);
    };
    beat();
  }
  function lureHud() {
    q("#f2-lhud")?.remove();
    const h = fx(`<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="5"/><circle id="f2-larc" cx="20" cy="20" r="16" fill="none" stroke="#9fd8ff" stroke-width="5" stroke-dasharray="100.5" transform="rotate(-90 20 20)" stroke-linecap="round"/></svg>
      <div><div class="nm">LURE</div><div class="tm" id="f2-ltm">${st.lureLim ? st.lureLim.toFixed(1) + " s" : "No limit"}</div>${st.lureLim ? "" : `<div class="rin">ESC reel in</div>`}</div>`, 0, 0, "f2-hud lure w");
    h.style.left = "auto"; h.style.top = "10px"; h.id = "f2-lhud";
    if (!st.lureLim) return;
    const id = st.lureId;
    const f = () => { if (!root || st.lureId !== id || st.phase !== "lure") return; const rem = Math.max(0, (st.lureEnd - performance.now()) / 1000), shown = Math.min(st.lureLim, rem);
      const tm = $("f2-ltm"), a = $("f2-larc"); if (tm) { tm.textContent = shown.toFixed(1) + " s"; tm.classList.toggle("urgent", shown < 5); }
      if (a) { a.setAttribute("stroke-dashoffset", (100.5 * (1 - shown / st.lureLim)).toFixed(1)); a.setAttribute("stroke", shown < 5 ? "#ff7a6a" : "#9fd8ff"); }
      if (st.owner && rem <= 0 && !(st.v && st.v.state === "hooked")) { lureOut(); return; }
      frame(f); };
    frame(f);
  }
  const timeUp = () => st.lureEnd && performance.now() >= st.lureEnd;
  function clearLure() {
    ["#f2-lhud", "#f2-bang"].forEach(s => q(s)?.remove());
    if (st.v?.e) st.v.e.remove(); st.v = null;
    const hook = q("#f2-hook"); if (hook) hook.className = "f2-hook";
    const bob = q("#f2-bob"); if (bob) bob.className = "f2-bob";
    line(null); line(null, null, 0, "#f2-line2"); drawRod();
    const a = q("#f2-angler"); if (a) a.className = "f2-angler";
    stop(waitLoop); waitLoop = null;
  }
  function lureOut() {
    const v = st.v; if (v && v.state !== "gone") swimOff(v, 700);
    st.lureId++; st.phase = "end"; stop(waitLoop); waitLoop = null; q("#f2-lhud")?.remove(); q("#f2-bang")?.remove(); q("#f2-hold").hidden = true;
    q("#f2-angler").className = "f2-angler lose"; st.fish = null;
    lure("out");
    later(() => send(CAMP.MSG.FISHING_RESULT, { actorId: st.actorId, fishName: null }), 900);
  }
  function reelIn() {   // unlimited lure only: pull the line in and cast again
    if (st.lureEnd) return; const v = st.v; if (v && v.state !== "gone") swimOff(v, 500);
    st.lureId++; sfx("back", .6); clearLure();
    st.phase = "tackle"; startCast();
  }
  function visit() {
    if (timeUp()) return;
    const tier = T().visitorTier(T().tierOf(st.str, st.stats, st.rod.attr, st.bait));
    const { fish, tier: t } = T().pickFish(st.fishPools, tier, st.bait);
    if (!fish) { lateL(visit, T().gapMs(false, st.str, st.bait)); return; }
    const len = T().fishLen(t, fish.sz);
    const kind = Math.random() < T().hookP(t, st.str, st.bait) ? "hook" : Math.random() < .45 ? "look" : "nibble";
    const e = fishEl(fish.sh, len, t === 3);
    const fromLeft = Math.random() < (st.lx > 520 ? .8 : .2), dir = fromLeft ? 1 : -1, sx = st.lx - dir * (240 + Math.random() * 60), sy = st.hookY + (Math.random() - .5) * 60;
    const tx = st.lx - dir * len * .42, ty = st.hookY;
    const v = st.v = { tier: t, fish, len, kind, e, dir, x: sx, y: sy, state: "come" };
    tween(1300 + Math.random() * 500, k => { const ek = 1 - Math.pow(1 - k, 2); v.x = sx + (tx - sx) * ek; v.y = sy + (ty - sy) * ek + Math.sin(k * 9) * 2; place(e, v.x, v.y, len, dir, 0); }, () => {
      if (v.state !== "come") return; v.state = "near";
      if (kind === "look") lookAround(v);
      else nibbles(v, 1 + Math.floor(Math.random() * 3));
    });
  }
  function lookAround(v) {
    const x0 = v.x, y0 = v.y; tween(1000 + Math.random() * 900, k => { v.x = x0 + Math.sin(k * Math.PI * 2) * 10; v.y = y0 - Math.sin(k * Math.PI) * 8; place(v.e, v.x, v.y, v.len, v.dir, Math.sin(k * Math.PI * 3) * 6); }, () => leave(v));
  }
  function nibbleVisual() {
    const bob = q("#f2-bob"); if (!bob) return;
    bob.className = "f2-bob on dip"; sfx("nibble", .55);
    later(() => { if (bob && st.phase === "lure" && !q("#f2-bang")) bob.className = "f2-bob on float"; }, 650);
  }
  function nibbles(v, n) {
    const one = () => { if (v.state !== "near") return; n--; place(v.e, v.x + v.dir * 5, v.y, v.len, v.dir, 0); later(() => { if (v.state === "near") place(v.e, v.x, v.y, v.len, v.dir, 0); }, 160);
      nibbleVisual(); lure("nib");
      if (n > 0) lateL(one, 650 + Math.random() * 700);
      else lateL(() => { if (v.state !== "near") return; if (v.kind === "hook") hooked(v); else leave(v); }, 600 + Math.random() * 500); };
    one();
  }
  function bangVisual() {
    sfx("bite", .8); q("#f2-bob").className = "f2-bob on under"; splash(st.lx, 5, 40, 24);
    q("#f2-bang")?.remove();
    const b = fx(`<b>!</b><i></i>`, st.lx + 8, SURF - 14, "f2-bang"); b.id = "f2-bang";
    // approach ring: constant-speed shrink, meets the bubble edge at HIT_T, keeps going through it and fades out
    const ringEl = b.querySelector("i"), hit = T().HIT_T / T().HOOK_WIN, gone = Math.min(1, (T().HIT_T + 220) / T().HOOK_WIN);
    const startS = 2.6, rate = (startS - 1) / T().HIT_T;
    ringEl.animate([{ transform: `scale(${startS})`, opacity: .4 }, { transform: "scale(1)", opacity: 1, offset: hit }, { transform: `scale(${(1 - rate * 220).toFixed(3)})`, opacity: 0, offset: gone }, { transform: "scale(.3)", opacity: 0 }], { duration: T().HOOK_WIN, easing: "linear", fill: "forwards" });
  }
  function hooked(v) {
    v.state = "hooked"; bangVisual(); lure("hook");
    v.hookT0 = performance.now();
    const x0 = v.x; tween(T().HOOK_WIN, k => { place(v.e, x0 + Math.sin(k * 40) * 3, v.y + Math.sin(k * 31) * 2, v.len, v.dir, Math.sin(k * 47) * 12); }, () => {
      if (v.state !== "hooked") return;
      $("f2-bang")?.remove(); q("#f2-bob").className = "f2-bob on float"; lure("unhook");
      v.state = "leaving"; swimOff(v, 600); after(v);
    });
  }
  function leave(v) { if (v.state === "gone" || v.state === "leaving") return; v.state = "leaving"; swimOff(v, 900 + Math.random() * 400); after(v); }
  function after(v) { lateL(() => { if (st.v === v) st.v = null; if (timeUp()) { lureOut(); return; } lateL(visit, T().gapMs(false, st.str, st.bait)); }, 700); }
  function swimOff(v, ms) {
    const e = v.e, x0 = v.x, y0 = v.y, out = -v.dir, tx = x0 + out * 300, ty = y0 + (Math.random() - .5) * 50, t0 = performance.now();
    const f = ts => { const k = Math.min(1, (ts - t0) / ms), ek = k * k; v.x = x0 + (tx - x0) * ek; v.y = y0 + (ty - y0) * ek; place(e, v.x, v.y, v.len, out, 0); e.style.opacity = String(.82 * (1 - k)); if (k < 1) frame(f); else { e.remove(); v.state = "gone"; } };
    frame(f);
  }
  function strikeVisual(adv) {
    $("f2-bang")?.remove(); q("#f2-lhud")?.remove(); q("#f2-hold").hidden = true;
    stop(waitLoop); waitLoop = null; sfx("click", .6); scatter();
    if (adv) { sfx(adv.snd, .8); fx("", st.lx + 8, SURF - 14 - 19, "f2-advfx " + adv.key, 600); fx(esc(adv.label), st.lx + 8, SURF - 40, "f2-advtx " + adv.key, 950); }
    q("#f2-bob").className = "f2-bob"; splash(st.lx, 8); q("#f2-hook").className = "f2-hook"; line(null, null, 0, "#f2-line2");
  }
  function strikePress() {
    const v = st.v;
    if (v && v.state === "hooked") {                  // confirmed → fight
      const off = performance.now() - v.hookT0 - T().HIT_T, adv = T().strikeTiming(off); st.adv = adv;
      v.state = "struck"; st.lureId++; st.phase = "bite"; st.tier = v.tier; st.fish = v.fish; st.len = v.len; st.fe = v.e; st.fe.style.opacity = "";
      if (st._vSent) { lure("v", { x: Math.round(v.x), y: Math.round(v.y), len: v.len, dir: v.dir, sh: v.fish?.sh, legend: v.tier === 3, tilt: 0, op: 1 }); }
      preload(v.fish?.img);   // the result window reveals it: have it ready
      strikeVisual(adv); lure("strike", { adv: adv?.key ?? null, img: v.fish?.img ?? null });
      later(startBattle, adv ? 750 : 450); return;
    }
    if (v && (v.state === "come" || v.state === "near")) {  // too soon: the fish bolts, the lure goes on
      v.state = "leaving"; sfx("back", .5); bubbles(v.x, v.y, 4); q("#f2-bob").className = "f2-bob on float";
      swimOff(v, 420); after(v); return;
    }
    // nothing there: a small twitch of the line, no penalty
    const bob = q("#f2-bob"); bob.className = "f2-bob on dip"; later(() => { if (st.phase === "lure") bob.className = "f2-bob on float"; }, 350);
  }

  // ════════════════════════════ FIGHT ═══════════════════════════════════════
  function reelSVG(col) { return `<svg viewBox="0 0 72 72" class="f2-reel" id="f2-reel">
    <path d="M70 66 L34 30" stroke="#1a0f06" stroke-width="9" stroke-linecap="round"/><path d="M70 66 L44 40" stroke="#6a4a2a" stroke-width="7" stroke-linecap="round"/>
    <path d="M68 64 L50 46" stroke="#b08a5a" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 3"/>
    <path d="M40 36 L10 6" stroke="#1a0f06" stroke-width="5" stroke-linecap="round"/><path d="M40 36 L10 6" stroke="${col}" stroke-width="3" stroke-linecap="round"/>
    <rect x="36" y="38" width="10" height="5" rx="1" transform="rotate(45 41 40)" fill="#3a4258"/>
    <circle cx="33" cy="48" r="15" fill="#2a3246" stroke="#e8eef8" stroke-width="2"/>
    <g id="f2-spool"><circle cx="33" cy="48" r="11" fill="#7f90b2"/><circle cx="33" cy="48" r="8.6" fill="none" stroke="#e8e0c8" stroke-width="3.4" stroke-dasharray="5 2.6"/>
      <path d="M33 37.6 L33 41.5" stroke="#ff6a55" stroke-width="2.4" stroke-linecap="round"/></g>
    <circle cx="33" cy="48" r="4.2" fill="#3a4258" stroke="#e8eef8" stroke-width="1"/>
    <g id="f2-crank"><path d="M33 54 L33 33" stroke="#e8eef8" stroke-width="3" stroke-linecap="round"/><circle cx="33" cy="32" r="3.8" fill="#ffd66b" stroke="#3a2a1c" stroke-width="1.2"/>
      <circle cx="33" cy="55" r="2.2" fill="#9fb0d0"/></g>
    <circle cx="33" cy="48" r="1.8" fill="#e8eef8"/></svg>`; }

  // Lane, meter, reel and HUD — owner and spectators draw the same thing.
  function battleVisual({ tier, barH, timeout, advKey }) {
    const K = LANE_H / T().H, lx = st.lx;
    const lane = fx(`<div class="f2-zone" id="f2-zone"></div><div class="f2-chest" id="f2-chest"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="3"/><circle id="f2-carc" cx="22" cy="22" r="19" fill="none" stroke="#ffd66b" stroke-width="3" stroke-dasharray="119.4" stroke-dashoffset="119.4" transform="rotate(-90 22 22)"/></svg><div class="bob"><img class="base" src="${IMG.chest}" alt=""><img class="tint" src="${IMG.chest}" alt=""><img class="shade" src="${IMG.chest}" alt=""></div></div>`, lx - 40, LANE_TOP - 6, "f2-lane");
    lane.id = "f2-lane"; lane.style.height = (LANE_H + 12) + "px";
    $("f2-zone").style.height = (barH * K) + "px"; $("f2-chest").style.left = "38px";
    const meter = fx(`<div class="f2-mtrack"><div class="f2-mhalf"></div><div class="f2-mfill" id="f2-mfill"></div></div>`, lx + 46, LANE_TOP - 6, "f2-meter w"); meter.id = "f2-meter"; meter.style.height = (LANE_H + 12 - 60) + "px";
    const rl = document.createElement("div"); rl.innerHTML = reelSVG(rodCol()); const reel = rl.firstElementChild; reel.style.left = (lx + 20) + "px"; reel.style.top = (LANE_TOP + LANE_H - 84) + "px"; q("#f2-fx").appendChild(reel);
    const adv = advKey ? T().TIMING.find(t => t.key === advKey) : null;
    const hud = fx(`<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="5"/><circle id="f2-tarc" cx="20" cy="20" r="16" fill="none" stroke="#ffd66b" stroke-width="5" stroke-dasharray="100.5" transform="rotate(-90 20 20)" stroke-linecap="round"/></svg>
      <div><div class="nm">??? <span class="st">${"★".repeat(tier + 1)}<i>${"★".repeat(3 - tier)}</i></span>${adv ? `<span class="adv ${adv.key}">${adv.tag}</span>` : ""}</div><div class="tm" id="f2-tm">${timeout.toFixed(1)} s</div></div>`, 0, 0, "f2-hud w");
    hud.style.left = "auto"; hud.style.top = "10px"; hud.id = "f2-hud";
    q("#f2-angler").className = "f2-angler reel"; stop(reelLoop); reelLoop = loop("fast", .4);
    ambientStop();
  }
  // One frame of drawing from a fight state (owner tick + spectator lerp share it).
  function drawFight(ts, s, K = LANE_H / T().H) {
    const fy = LANE_TOP + s.y * K, wig = Math.sin(ts / 1000 * 9) * (st.len > 50 ? 2 : 4), fxp = st.lx + wig, tilt = Math.max(-35, Math.min(35, s.vel / 200 * 35)) * (s.dir || 1);
    const fe = st.fe; if (fe) { fe.classList.toggle("lit", s.inZone); place(fe, fxp - (s.dir || 1) * st.len * .1, fy, st.len, s.dir || 1, -tilt); }
    const z = $("f2-zone"); if (z) { z.style.top = (6 + s.barY * K) + "px"; z.classList.toggle("in", s.inZone); }
    const mf = $("f2-mfill"); if (mf) { mf.style.height = s.hp.toFixed(1) + "%"; mf.style.background = T().meterColor(s.hp); }
    const tm = $("f2-tm"); if (tm) { tm.textContent = s.rem.toFixed(1) + " s"; tm.classList.toggle("urgent", s.rem < 5); }
    const ta = $("f2-tarc"); if (ta) { ta.setAttribute("stroke-dashoffset", (100.5 * (1 - s.rem / s.timeout)).toFixed(1)); ta.setAttribute("stroke", s.rem < 5 ? "#ff7a6a" : "#ffd66b"); }
    $("f2-crank")?.setAttribute("transform", `rotate(${(s.crankA || 0).toFixed(1)} 33 48)`);
    $("f2-spool")?.setAttribute("transform", `rotate(${(s.spoolA || 0).toFixed(1)} 33 48)`);
    const rl = $("f2-reel"); if (rl) rl.style.transform = s.running ? `translate(${(Math.random() - .5) * 2.4}px,${(Math.random() - .5) * 2.4}px)` : "";
    const c = $("f2-chest");
    if (c) {
      if (s.chestOn && !c.classList.contains("on")) { c.className = "f2-chest on"; later(() => c.classList.add("revealed"), 60); sfx("chestUp", .5); bubbles(st.lx, LANE_TOP + s.chestY * K - 20, 3); }
      if (s.chestOn) { c.style.top = (6 + s.chestY * K) + "px"; $("f2-carc")?.setAttribute("stroke-dashoffset", (119.4 * (1 - s.chestP / 100)).toFixed(1)); if (Math.random() < .015) bubbles(st.lx + (Math.random() - .5) * 10, LANE_TOP + s.chestY * K - 10, 1); }
      if (s.chestGot && !c.classList.contains("got")) {
        c.classList.add("on", "got"); sfx("chestOpen", .7);
        if (!$("f2-chesthud")) { const ch = fx(`<img src="${IMG.chest}" alt="">Chest secured`, 0, 0, "f2-chesthud w"); ch.style.left = "auto"; ch.style.top = "72px"; ch.id = "f2-chesthud"; }
      }
    }
    const mouth = { x: fxp + (s.dir || 1) * st.len * .32, y: fy }; const t = drawRod(s.held ? 22 : 10, mouth); line(t, mouth, s.held ? 2 : 10);
  }

  function startBattle() {
    if (!root) return; st.phase = "battle";
    const d = st.d, tier = st.tier, fp = T().fightProfile(tier, st.bait);
    const now = performance.now();
    Object.assign(st, { cruise: fp.cruise, burst: fp.burst, bmin: fp.bmin, bmax: fp.bmax,
      y: T().H * .35, vel: 0, burstEnd: 0, barY: T().H / 2 - d.barH / 2, hp: T().START_HP + (st.adv ? st.adv.hp : 0), heldMs: 0, t0: now, last: now, perfect: true, dir: 1, crankA: 0, crankV: 0, spoolA: 0,
      // _forceChest / _forceChestPattern: test hooks (staging runs), never set by the game.
      chestWill: !!CAMP.FishingUI._forceChest || Math.random() < T().chestChance(st.bait), chestOn: false, chestP: 0, chestGot: false, chestY: 0 });
    st.vel = st.cruise; st.next = st.t0 + st.bmin + Math.random() * (st.bmax - st.bmin); st.hp0 = st.hp;
    st.chestPat = st.chestWill ? T().rollChestPattern(Math.random, CAMP.FishingUI._forceChestPattern ?? null) : null;
    st.chestAt = st.chestPat?.at ? st.chestPat.at[0] + Math.random() * (st.chestPat.at[1] - st.chestPat.at[0]) : null;
    battleVisual({ tier, barH: d.barH, timeout: d.timeout, advKey: st.adv?.key });
    const hb = q("#f2-hold"); hb.hidden = false; hb.textContent = "HOLD TO REEL";
    msg(`Hold <span class="f2-key">SPACE</span> to raise the bar. Keep the fish inside it.`);
    held = false; st.lastBeat = 0; raf = requestAnimationFrame(tick);
  }
  function tick(ts) {
    if (!root || st.phase !== "battle") return; const d = st.d, H = T().H, dt = Math.min(50, ts - st.last) / 1000; st.last = ts;
    if (st.burstEnd > 0) { st.y += st.vel * dt; if (ts >= st.burstEnd) { st.burstEnd = 0; st.vel = Math.sign(st.vel) * st.cruise; st.next = ts + st.bmin + Math.random() * (st.bmax - st.bmin); } }
    else { st.y += st.vel * dt; if (ts >= st.next) { st.burstEnd = ts + T().BURST_MS; st.vel = (Math.random() < .5 ? 1 : -1) * (st.burst + st.hp / 100 * 30); st.dir = Math.random() < .5 ? 1 : -1; bubbles(st.lx, LANE_TOP + st.y * LANE_H / H, 4); } }
    if (st.y < 14) { st.y = 14; st.vel = Math.abs(st.vel); } if (st.y > H - 14) { st.y = H - 14; st.vel = -Math.abs(st.vel); }
    if (held) { st.heldMs += dt * 1000; const r = d.ramp > 0 ? Math.min(1, st.heldMs / d.ramp) : 1; st.barY -= d.up * r * dt; } else { st.barY += d.down * dt; st.heldMs = 0; }
    st.barY = Math.max(0, Math.min(H - d.barH, st.barY));
    // Reel, modelled on a real one: hand speed with the DEX ramp; spool ×3; anti-reverse; drag pays line out on sinks and runs.
    const GEAR = 3, HAND = 792, rampF = d.ramp > 0 ? Math.min(1, st.heldMs / d.ramp) : 1;
    const running = st.burstEnd > 0 && st.vel > 0;
    const atBottom = st.barY >= H - d.barH - .5;
    const target = held ? HAND * rampF * (running ? .65 : 1) : 0;
    st.crankV += (target - st.crankV) * Math.min(1, dt * (held ? 9 : 45));
    if (!held && st.crankV < 40) st.crankV = 0;
    st.crankA += st.crankV * dt;
    let drag = 0;
    if (!held && !atBottom) drag = -d.down * 6;
    if (running) drag -= held ? 1500 : 1100;
    st.spoolA += (st.crankV * GEAR + drag) * dt;
    const inZone = st.y >= st.barY && st.y <= st.barY + d.barH; if (!inZone) st.perfect = false;
    st.hp = inZone ? Math.min(100, st.hp + d.fill * dt) : Math.max(0, st.hp - T().DRAIN * dt);
    // chest pattern trigger: early = clock; mid / late = share of the REMAINING meter
    const CP = st.chestPat;
    if (st.chestWill && !st.chestOn && !st.chestGot && CP) {
      const due = CP.at ? ts >= st.t0 + st.chestAt : (st.hp >= st.hp0 + CP.p * (100 - st.hp0) || ts >= st.t0 + CP.maxT);
      if (due && st.hp > T().CHEST_SAFE) st.chestWill = false;
      else if (due) { st.chestOn = true; let cy, n = 0; do { cy = 30 + Math.random() * (H - 60); n++; } while ((Math.abs(cy - st.y) < CP.dist[0] || Math.abs(cy - st.y) > CP.dist[1]) && n < 60);
        st.chestY = cy; st.chestV = CP.drift ? (Math.random() < .5 ? -1 : 1) * CP.drift : 0;
        const c = $("f2-chest"); if (c) { c.dataset.pat = CP.id; c.dataset.t = Math.round(ts - st.t0); c.dataset.hp = Math.round(st.hp); } }
    }
    if (st.chestOn && st.chestV) { st.chestY += st.chestV * dt; if (st.chestY < 30 || st.chestY > H - 30) { st.chestV *= -1; st.chestY = Math.max(30, Math.min(H - 30, st.chestY)); } }
    if (st.chestOn) { const over = st.chestY >= st.barY && st.chestY <= st.barY + d.barH; st.chestP = over ? Math.min(100, st.chestP + CP.rate * dt) : Math.max(0, st.chestP - CP.decay * dt);
      if (st.chestP >= 100) { st.chestOn = false; st.chestGot = true; } }
    const rem = Math.max(0, d.timeout - (ts - st.t0) / 1000);
    const s = { y: st.y, vel: st.vel, dir: st.dir, barY: st.barY, inZone, hp: st.hp, rem, timeout: d.timeout, crankA: st.crankA, spoolA: st.spoolA, running, held,
      chestOn: st.chestOn, chestY: st.chestY, chestP: st.chestP, chestGot: st.chestGot };
    drawFight(ts, s);
    if (ts - st.lastBeat >= 50) { st.lastBeat = ts; send(CAMP.MSG.FISHING_HIT, { actorId: st.actorId, ...s, barH: d.barH, tier: st.tier, len: st.len, sh: st.fish?.sh, lx: st.lx, adv: st.adv?.key ?? null }); }
    if (st.hp >= 100) { end(true); return; } if (st.hp <= 0 || rem <= 0) { end(false); return; }
    raf = requestAnimationFrame(tick);
  }

  // ── end: yank → silhouette leaps out → splash fills the screen → flash → result ──
  function end(won) {
    cancelAnimationFrame(raf); raf = 0; held = false; st.phase = "end"; stop(reelLoop); reelLoop = null; q("#f2-hold").hidden = true;
    ["#f2-lane", "#f2-meter", "#f2-hud", "#f2-chesthud", "#f2-reel"].forEach(s => q(s)?.remove());
    const fe = st.fe; if (!fe) return;
    const sx = parseFloat(fe.style.left) + st.len / 2, sy = parseFloat(fe.style.top) + st.len / 4;
    if (st.owner) lure("end", { won });
    if (won) {
      q("#f2-angler").className = "f2-angler yank"; sfx("caught", .75);
      const ax = Math.min(560, Math.max(360, sx - 60)), ay = 34, start = performance.now(), dur = 720; let out = false;
      const f = ts => {
        const k = Math.min(1, (ts - start) / dur), e = 1 - Math.pow(1 - k, 2.2);
        const x = sx + (ax - sx) * e, y = sy + (ay - sy) * e - Math.sin(k * Math.PI) * 30;
        place(fe, x, y, st.len, -1, e * -400, 1 + e * 1.6);
        const t = drawRod(18 * (1 - k), { x, y }); line(t, { x, y }, 2);
        if (!out && y < SURF) { out = true; fe.classList.add("air"); splash(x, 16, 140, 90); sfx("splash", .85); }
        if (k < 1) { raf = requestAnimationFrame(f); return; }
        splashFill(x, y);
      };
      raf = requestAnimationFrame(f);
    } else {
      sfx("lost", .8); line(null); drawRod(); q("#f2-angler").className = "f2-angler lose";
      const start = performance.now(), dir = sx > 500 ? 1 : -1;
      const f = ts => { const k = Math.min(1, (ts - start) / 800); place(fe, sx + dir * k * 260, sy + k * 40, st.len, dir, 0); fe.style.opacity = String(1 - k); if (k < 1) { raf = requestAnimationFrame(f); return; } fe.remove();
        if (st.owner) send(CAMP.MSG.FISHING_RESULT, { actorId: st.actorId, fishName: null, chest: false, escaped: true, shape: st.fish?.sh ?? "std", len: st.len, chestLost: !!st.chestGot }); };
      raf = requestAnimationFrame(f);
    }
  }
  function splashFill(x, y) {
    const rr = root.getBoundingClientRect(), ir = q("#f2-in").getBoundingClientRect(), s = rr.width / 900;
    const ox = x + (ir.left - rr.left) / s, oy = y + (ir.top - rr.top) / s;
    const c = document.createElement("canvas"); c.className = "f2-fxc"; c.width = 900; c.height = 600; root.appendChild(c); const g = c.getContext("2d");
    const P = []; for (let i = 0; i < 170; i++) { const a = Math.random() * Math.PI * 2, v = 260 + Math.random() * 900; P.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, r: 3 + Math.random() * 13, l: .5 + Math.random() * .5 }); }
    const t0 = performance.now(); let flashed = false, last = t0;
    const f = ts => {
      const t = (ts - t0) / 1000, dt = Math.min(.05, (ts - last) / 1000); last = ts; g.clearRect(0, 0, 900, 600);
      const R = Math.max(0, (t - .05)) * 2900; if (R > 0) { const grd = g.createRadialGradient(ox, oy, R * .6, ox, oy, R); grd.addColorStop(0, `rgba(150,225,245,${Math.min(.95, t * 3.6)})`); grd.addColorStop(.85, `rgba(200,245,255,${Math.min(.9, t * 3.2)})`); grd.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grd; g.beginPath(); g.arc(ox, oy, R, 0, Math.PI * 2); g.fill(); }
      for (const p of P) { p.vy += 1100 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        g.fillStyle = `rgba(215,248,255,${p.l})`; g.beginPath(); g.ellipse(p.x, p.y, p.r, p.r * 1.25, Math.atan2(p.vy, p.vx), 0, Math.PI * 2); g.fill();
        g.fillStyle = "rgba(255,255,255,.9)"; g.beginPath(); g.arc(p.x - p.r * .3, p.y - p.r * .35, p.r * .28, 0, Math.PI * 2); g.fill(); }
      for (let i = 0; i < 3; i++) { const rr2 = (t - i * .06) * 900; if (rr2 > 0) { g.strokeStyle = `rgba(255,255,255,${Math.max(0, .8 - t * 1.5)})`; g.lineWidth = 6 - i * 1.5; g.beginPath(); g.arc(ox, oy, rr2, 0, Math.PI * 2); g.stroke(); } }
      if (!flashed && t >= .5) { flashed = true; const fl = document.createElement("div"); fl.className = "f2-flash"; root.appendChild(fl); later(() => fl.remove(), 480);
        st.fe?.remove(); line(null); drawRod();
        if (st.owner) send(CAMP.MSG.FISHING_RESULT, { actorId: st.actorId, fishName: st.fish.name, chest: st.chestGot, perfect: st.perfect && st.tier < 3, tier: st.tier }); }
      if (t < .62) { raf = requestAnimationFrame(f); return; }
      c.remove();
    };
    raf = requestAnimationFrame(f);
  }

  // ════════════════════════════ RESULT ══════════════════════════════════════
  function bindItemTip(el, detail) {
    const kit = globalThis.ONI?.TreasureRoulette?.UIKit; if (!el || !detail || !kit?.tooltip) return; el.classList.add("f2-hastip");
    el.addEventListener("mouseenter", () => kit.tooltip.show(el, detail)); el.addEventListener("mouseleave", () => kit.tooltip.hide());
  }
  function showResult(round, fishName, catches, x) {
    if (!root) return; st.phase = "result"; cancelAnimationFrame(raf); raf = 0;
    q("#f2-veil")?.remove(); clearLure(); q("#f2-gwrap")?.remove();
    ["#f2-lane", "#f2-meter", "#f2-hud", "#f2-chesthud", "#f2-reel"].forEach(s => q(s)?.remove());
    if (st.fe?.isConnected) st.fe.remove();
    const v = document.createElement("div"); v.className = "f2-veil"; v.id = "f2-veil";
    const last = round >= (st.totalRounds || 1);
    const trip = (st.totalRounds || 1) > 1 && last && catches?.length
      ? `<div class="f2-lost">This trip: ${catches.map(esc).join(", ")}</div>` : "";
    const btn = `<button class="btn" id="f2-go" type="button" ${st.owner ? "" : "hidden"}>CONTINUE</button>`;
    let html;
    if (fishName) {
      const tier = Math.max(0, Math.min(3, Number(x.tier) || 0));
      let loot = "";
      if (x.loot) {
        const ic = x.loot.img || (x.loot.cat === "Treasure" ? IMG.goldchest : IMG.chest);
        loot = `<div class="f2-loot" id="f2-lootrow"><img src="${esc(ic)}" alt=""><div><div class="c">${esc(String(x.loot.cat).toUpperCase())} · CHEST</div><div class="i">${esc(x.loot.name)}</div></div></div>`;
        later(() => sfx("treasure", .7), 700);
      }
      html = `<div class="f2-win f2-result wg"><span class="plate f2-wt">Caught!</span><div class="f2-slot" id="f2-fslot"><img src="${esc(x.img || "icons/svg/item-bag.svg")}" alt=""></div><div class="f2-rn">${esc(fishName)}</div>
        <div class="f2-tags"><span class="f2-tg r">${"★".repeat(tier + 1)} ${T().RANK[tier]}</span>${x.cost ? `<span class="f2-tg">${esc(x.cost)} z</span>` : ""}${x.isNew ? `<span class="f2-tg new">NEW!</span>` : ""}${x.bonus ? `<span class="f2-tg perf">PERFECT +1</span>` : ""}</div>
        ${loot}${trip}${btn}</div>`;
      later(() => sfx(tier === 3 ? "resultSSR" : "result", .75), 200);
    } else if (x.escaped) {
      const len = Number(x.len) || 40;
      html = `<div class="f2-win f2-result wg"><span class="plate f2-wt">Got away</span><div class="f2-slot lost" style="display:flex;align-items:center;justify-content:center"><img src="${T().silhouette(x.shape)}" alt="" style="width:${Math.round(45 + Math.max(0, Math.min(1, (len - 24) / 44)) * 55)}%;height:auto;margin:auto;filter:brightness(0) drop-shadow(0 0 1px #f3e6c4) drop-shadow(0 0 4px rgba(243,230,196,.55))"></div>
        <div class="f2-lost">${x.chestLost ? "It slipped the hook, and the chest sank with it." : "It slipped the hook and vanished into the deep."}</div>${trip}${btn}</div>`;
    } else {
      html = `<div class="f2-win f2-result wg"><span class="plate f2-wt">No catch</span><div class="f2-lost">Nothing took the hook in time. Bait makes fish take it more often, and a stronger cast brings the first one sooner.</div>${trip}${btn}</div>`;
    }
    v.innerHTML = html; root.appendChild(v);
    if (fishName) { bindItemTip($("f2-fslot"), x.fishTip); if (x.loot) bindItemTip($("f2-lootrow"), x.loot.tip ?? { kind: "text", name: x.loot.name, img: x.loot.img || IMG.chest }); }
    q("#f2-hold").hidden = true;
    msg(st.owner ? (fishName ? "Landed." : "Round over.") : `${esc(st.actorName)}${fishName ? " landed a fish." : "'s round is over."}`);
    const g = $("f2-go");
    if (g && st.owner) {
      g.onmouseenter = () => sfx("hover", .5);
      g.onclick = () => { sfx("click", .6); g.disabled = true;
        send(last ? CAMP.MSG.FISHING_PROCEED : CAMP.MSG.FISHING_CONTINUE, { actorId: st.actorId }); };
    }
  }

  // ════════════════════════════ SPECTATORS ══════════════════════════════════
  function specBegin(p) {
    st.phase = "cast"; q("#f2-veil")?.remove(); clearLure(); q("#f2-gwrap")?.remove();
    if (p?.tackle) { st.tackle = p.tackle; renderMini(); }
    const g = document.createElement("div"); g.id = "f2-gwrap"; g.innerHTML = gaugeHTML(p?.marks ?? []); q("#f2-fx").appendChild(g);
    msg(`${esc(st.actorName)} is casting…`);
    cancelAnimationFrame(raf); runGauge(Number(p?.gaugeSpeed) || 120);
  }
  function specLure(p) {
    switch (p.ev) {
      case "tackle": if (st.phase !== "tackle" && st.phase !== "result") break;
        if (st.phase === "tackle") msg(`${esc(st.actorName)} is choosing tackle…`); break;
      case "wait": st.lx ??= 500; waitVisual(Number(p.hookY) || SURF + 100, p.img, Number(p.lim) || 0); break;
      case "v": {
        if (!st.v?.e?.isConnected || st.v.sh !== p.sh || st.v.len !== p.len) { st.v?.e?.remove(); st.v = { e: fishEl(p.sh, p.len, p.legend), sh: p.sh, len: p.len }; st.v.e.classList.add("spec"); }
        place(st.v.e, p.x, p.y, p.len, p.dir, p.tilt || 0); st.v.e.style.opacity = String(.82 * (p.op ?? 1)); st.v.x = p.x; st.v.y = p.y; st.v.dir = p.dir; break;
      }
      case "v0": st.v?.e?.remove(); st.v = null; break;
      case "nib": nibbleVisual(); break;
      case "hook": bangVisual(); break;
      case "unhook": $("f2-bang")?.remove(); { const b = q("#f2-bob"); if (b) b.className = "f2-bob on float"; } break;
      case "strike": {
        const adv = p.adv ? T().TIMING.find(t => t.key === p.adv) : null;
        preload(p.img);
        st.phase = "bite"; st.fe = st.v?.e ?? null; if (st.fe) { st.fe.classList.remove("spec"); st.fe.style.opacity = ""; st.len = st.v.len; }
        st.v = null; strikeVisual(adv); break;
      }
      case "out": st.phase = "end"; stop(waitLoop); waitLoop = null; q("#f2-lhud")?.remove(); q("#f2-bang")?.remove(); { const a = q("#f2-angler"); if (a) a.className = "f2-angler lose"; } break;
      case "end": if (st.phase === "battle") { st.phase = "end"; end(!!p.won); } break;
    }
  }
  let _spec = null;
  function specHit(p) {
    if (st.phase !== "battle") {
      st.phase = "battle"; st.lx = Number(p.lx) || st.lx || 500; st.len = Number(p.len) || st.len || 40; st.tier = Number(p.tier) || 0;
      if (!st.fe?.isConnected) st.fe = fishEl(p.sh, st.len, st.tier === 3);
      battleVisual({ tier: st.tier, barH: Number(p.barH) || 60, timeout: Number(p.timeout) || 17, advKey: p.adv });
      msg(`${esc(st.actorName)} is reeling in!`);
      _spec = { cur: { ...p }, tgt: p, last: performance.now(), recv: performance.now() };
      const f = ts => {
        if (!root || st.phase !== "battle" || !_spec) return;
        const dt = Math.min(50, ts - _spec.last) / 1000; _spec.last = ts; const k = Math.min(1, dt * 20), c = _spec.cur, t = _spec.tgt;
        for (const key of ["y", "barY", "hp", "chestY", "chestP", "crankA", "spoolA"]) c[key] = (c[key] ?? t[key] ?? 0) + ((t[key] ?? 0) - (c[key] ?? 0)) * k;
        Object.assign(c, { vel: t.vel, dir: t.dir, inZone: t.inZone, running: t.running, held: t.held, chestOn: t.chestOn, chestGot: t.chestGot, timeout: t.timeout,
          rem: Math.max(0, (t.rem ?? 0) - (ts - _spec.recv) / 1000) });
        drawFight(ts, c);
        raf = requestAnimationFrame(f);
      };
      cancelAnimationFrame(raf); raf = requestAnimationFrame(f);
      return;
    }
    if (_spec) { _spec.tgt = p; _spec.recv = performance.now(); }
  }

  // ════════════════════════════ PUBLIC API ══════════════════════════════════
  CAMP.FishingUI ??= {};
  CAMP.FishingUI.roundResolvers    ??= {};
  CAMP.FishingUI.proceedResolvers  ??= {};
  CAMP.FishingUI.continueResolvers ??= {};
  CAMP.FishingUI.roundTouch        ??= {};

  Object.assign(CAMP.FishingUI, {
    // GM broadcasts FISHING_START → every client in the audience calls show().
    show(actorId, actorName, broadcastStats, options = {}) {
      _teardown();
      const actor = game.actors?.get(actorId);
      const owner = _isOwner(actorId);
      const p = actor?.system?.props ?? {};
      const stats = owner && actor
        ? { mig: parseInt(p.mig_current) || 8, dex: parseInt(p.dex_current) || 8, ins: parseInt(p.ins_current) || 8, wlp: parseInt(p.wlp_current) || 8 }
        : { mig: broadcastStats?.mig ?? 8, dex: broadcastStats?.dex ?? 8, ins: broadcastStats?.ins ?? 8, wlp: broadcastStats?.wlp ?? 8 };
      st = { actorId, actorName, owner, stats, round: 1, totalRounds: Math.max(1, Number(options.totalRounds) || 1),
        fishPools: Array.isArray(options.fishPools) ? options.fishPools : [[], [], [], []],
        fishNames: new Set(options.fishNames ?? []), lureLimit: Math.max(0, Number(options.lureLimit ?? 20) || 0), phase: "idle" };
      _build(actor);
      ambience = loop("drips", .35);
      sfx("start", .7);
      spawnAmbient();
      if (owner) { _loadTackle(actor); renderMini(); bindKeys(); bindHold(); openTackle(); }
      else { renderMini(); st.phase = "tackle"; msg(`${esc(actorName)} is choosing tackle…`); }
    },

    // The owner pressed CAST LINE (any round, any recast).
    spectateBegin(payload) {
      if (isPrimaryGM()) this.touch(payload?.actorId);
      if (st.owner || !root || payload?.actorId !== st.actorId) return;
      specBegin(payload);
    },

    // GM broadcasts FISHING_NEXT_ROUND → back to the tackle (owner) or the wait line (spectators).
    beginRound(actorId, round, totalRounds) {
      if (!root || actorId !== st.actorId) return;
      st.round = round ?? st.round + 1; st.totalRounds = totalRounds ?? st.totalRounds;
      q("#f2-veil")?.remove(); clearLure(); renderPips();
      st.fe?.remove(); st.fe = null; st.fish = null; st.adv = null; st.chestGot = false;
      spawnAmbient();
      if (st.owner) { _loadTackle(game.actors?.get(actorId)); renderMini(); openTackle(); }
      else { st.phase = "tackle"; msg(`${esc(st.actorName)} is choosing tackle…`); }
    },

    onCast(payload) {
      if (isPrimaryGM()) this.touch(payload?.actorId);
      if (st.owner || !root || payload?.actorId !== st.actorId) return;
      st.phase = "flying"; st.lx = Number(payload.lx) || 500;
      castVisual(Number(payload.strength) || 0, Number(payload.level) || 0, st.lx, null);
    },

    onLure(payload) {
      if (isPrimaryGM()) this.touch(payload?.actorId);
      if (st.owner || !root || payload?.actorId !== st.actorId) return;
      specLure(payload);
    },

    onHit(payload) {
      if (isPrimaryGM()) this.touch(payload?.actorId);
      if (st.owner || !root || payload?.actorId !== st.actorId) return;
      specHit(payload);
    },

    // GM broadcasts FISHING_RESULT → everyone sees the result window.
    applyResult(actorId, round, fishName, catches, extra = {}) {
      if (!root || actorId !== st.actorId) return;
      const go = () => showResult(round, fishName, catches, extra ?? {});
      // Spectators may still be mid-splash; let the flash land first.
      if (!st.owner && fishName && st.phase === "end") later(go, 650); else go();
    },

    // ── GM side ──
    touch(actorId) { const f = this.roundTouch?.[actorId]; if (typeof f === "function") f(); },
    resolveRound(actorId, result) {
      const r = this.roundResolvers?.[actorId]; if (!r) return;
      delete this.roundResolvers[actorId]; r(result ?? { fishName: null });
    },
    resolveContinue(actorId) {
      const r = this.continueResolvers?.[actorId]; if (!r) return;
      delete this.continueResolvers[actorId]; r();
    },
    resolveProceed(actorId) {
      const r = this.proceedResolvers?.[actorId]; if (!r) return;
      delete this.proceedResolvers[actorId]; r();
    },

    hide() {
      const o = document.getElementById(OVL_ID);
      _teardown();
      if (!o) return;
      o.classList.add("f2-out");
      setTimeout(() => { o.remove(); if (ovl === o) { ovl = null; root = null; st = {}; } }, 320);
    },
  });

  // ── CSS (generated from the approved mockup; every rule scoped to the overlay) ──
  const CSS = `#oni-camp-fish-ovl{/* blue minigame windows */
  --ff-1:#3561c9; --ff-2:#1a3487; --ff-3:#0c1a52; --ff-rim:#eef3ff; --ff-in:#08103a; --gold:#ffd66b; --bad:#ff7a6a;
  /* game window kit (FU.SystemMessage) — Tackle menu only */
  --sm-parch-top:#f6f1e6; --sm-parch-bot:#ebe3d0; --sm-ink:#3a3228; --sm-ink-soft:#6b5d4b;
  --sm-gold-1:#d5b67a; --sm-gold-2:#b7935a; --sm-wood-1:#a87649; --sm-wood-2:#8d5f38; --sm-wood-3:#6f4526; --sm-accent:#8a4b22;
  --f-blue:"M PLUS Rounded 1c","Segoe UI",system-ui,sans-serif;
  --f-ui:"Signika","Inter","Segoe UI",system-ui,sans-serif;
  --f-plate:"Cinzel",Georgia,serif;
  --f-doc:"Alegreya Sans","Segoe UI",system-ui,sans-serif;}
#oni-camp-fish-ovl .w{position:relative;border-radius:9px;border:2px solid var(--ff-rim);color:#fff;
  background:linear-gradient(180deg,var(--ff-1) 0%,var(--ff-2) 45%,var(--ff-3) 100%);
  box-shadow:inset 0 0 0 2px var(--ff-in),inset 0 0 0 3px rgba(255,255,255,.18),0 6px 18px rgba(0,0,0,.55);
  text-shadow:0 1px 0 #000,0 0 2px rgba(0,0,0,.6)}
#oni-camp-fish-ovl .f2-btn{padding:8px 26px;border-radius:9px;border:2px solid #fff;background:linear-gradient(180deg,#ffd66b,#e09a1c);color:#3a2000;font:800 14px var(--f-blue);letter-spacing:.08em;cursor:pointer;text-shadow:none;box-shadow:0 3px 0 #7a4a00}
#oni-camp-fish-ovl .f2-btn:hover{filter:brightness(1.08)}
#oni-camp-fish-ovl .f2-key{display:inline-block;padding:1px 8px;margin:0 2px;border-radius:5px;border:1px solid #fff;border-bottom-width:3px;background:#0c1a52;font:800 12px var(--f-blue);text-shadow:none}
#oni-camp-fish-ovl .wg{position:relative;border:5px solid transparent;border-radius:11px;color:var(--sm-ink);
  background:linear-gradient(180deg,var(--sm-parch-top),var(--sm-parch-bot)) padding-box,linear-gradient(180deg,var(--sm-wood-1),var(--sm-wood-2) 45%,var(--sm-wood-3)) border-box;
  box-shadow:0 6px 18px rgba(0,0,0,.5)}
#oni-camp-fish-ovl .wg::before{content:"";position:absolute;inset:3px;border:1px solid var(--sm-gold-1);border-radius:6px;pointer-events:none;opacity:.85}
#oni-camp-fish-ovl .plate{display:inline-block;padding:3px 12px 4px;border-radius:7px;background:var(--sm-ink);color:var(--sm-parch-top);border:2px solid var(--sm-gold-2);
  box-shadow:0 3px 0 rgba(41,33,24,.55);font:900 13px/1.2 var(--f-plate);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
#oni-camp-fish-ovl .btn{padding:7px 24px;border-radius:9px;border:2px solid var(--sm-gold-2);cursor:pointer;font:900 13px var(--f-plate);letter-spacing:.1em;
  background:linear-gradient(180deg,var(--sm-wood-1),var(--sm-wood-3));color:var(--sm-parch-top);box-shadow:0 3px 0 #4a2c14,inset 0 1px 0 rgba(255,230,190,.35)}
#oni-camp-fish-ovl .btn:hover{filter:brightness(1.1)}
#oni-camp-fish-ovl .btn.ghost{background:transparent;color:var(--sm-ink);box-shadow:none}
#oni-camp-fish-ovl .key{display:inline-block;padding:0 7px;margin:0 2px;border-radius:5px;border:1px solid var(--sm-gold-2);border-bottom-width:3px;background:#fffaf0;font:700 11px var(--f-ui);color:var(--sm-ink)}
#oni-camp-fish-ovl .f2{position:absolute;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(3,8,18,.55);font-family:var(--f-blue);user-select:none;-webkit-user-select:none;animation:fsh-f2in .35s ease}
@keyframes f2in{from{opacity:0}}
#oni-camp-fish-ovl .f2-shell{width:820px;display:flex;flex-direction:column;gap:6px}
#oni-camp-fish-ovl .f2-head{display:flex;align-items:center;gap:12px;padding:6px 14px;flex:none}
#oni-camp-fish-ovl .f2-title{font:800 18px var(--f-blue);letter-spacing:.06em}
#oni-camp-fish-ovl .f2-place{font:500 13px var(--f-blue);color:#cfe0ff}
#oni-camp-fish-ovl .f2-sp{flex:1}
#oni-camp-fish-ovl .f2-mini{flex:none;width:156px;display:flex;align-items:center;gap:6px;font:700 12px var(--f-blue);color:#dfe8ff;padding:2px 10px 2px 3px;border-radius:999px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.35);overflow:hidden;white-space:nowrap}
#oni-camp-fish-ovl .f2-mini img,#oni-camp-fish-ovl .f2-mini svg{width:22px;height:22px;flex:none;border-radius:50%;background:#0a1640;image-rendering:pixelated;object-fit:contain}
#oni-camp-fish-ovl .f2-pips{display:flex;gap:5px}
#oni-camp-fish-ovl .f2-pip{width:10px;height:10px;border-radius:50%;border:2px solid #fff}
#oni-camp-fish-ovl .f2-pip.on{background:var(--gold);border-color:#fff3c4}
#oni-camp-fish-ovl .f2-scene{height:378px;padding:0;overflow:hidden;flex:none}
#oni-camp-fish-ovl .f2-in{position:absolute;inset:3px;border-radius:6px;overflow:hidden;background:#04121e;text-shadow:none}
#oni-camp-fish-ovl .f2-far{position:absolute;left:0;right:0;top:0;height:130px;background:var(--f2-bg,none) 50% 34%/118% auto no-repeat;filter:saturate(1.1) brightness(.72)}
#oni-camp-fish-ovl .f2-far::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,6,30,.35),rgba(10,40,60,.15) 70%,rgba(80,220,230,.25))}
#oni-camp-fish-ovl .f2-water{position:absolute;left:0;right:0;top:128px;bottom:0;overflow:hidden;background:linear-gradient(180deg,rgba(40,190,200,.92) 0%,rgba(14,110,140,.95) 18%,#0a4d6e 45%,#062a45 75%,#041a2e)}
#oni-camp-fish-ovl .f2-caus{position:absolute;inset:-40px;opacity:.09;mix-blend-mode:screen;filter:blur(2px);
  background:radial-gradient(circle at 20% 30%,transparent 0 14px,rgba(200,255,255,.9) 15px 16px,transparent 17px) 0 0/58px 46px,radial-gradient(circle at 70% 60%,transparent 0 10px,rgba(200,255,255,.8) 11px 12px,transparent 13px) 0 0/44px 38px;
  animation:fsh-caus 7s linear infinite;-webkit-mask-image:linear-gradient(180deg,#000,transparent 55%);mask-image:linear-gradient(180deg,#000,transparent 55%)}
@keyframes caus{to{transform:translate(58px,46px)}}
#oni-camp-fish-ovl .f2-rays{position:absolute;inset:0;background:repeating-linear-gradient(100deg,rgba(170,255,250,.08) 0 26px,transparent 26px 80px);-webkit-mask-image:linear-gradient(180deg,#000,transparent 80%);mask-image:linear-gradient(180deg,#000,transparent 80%);animation:fsh-rays 10s ease-in-out infinite alternate}
@keyframes rays{from{transform:translateX(-30px)}to{transform:translateX(30px)}}
#oni-camp-fish-ovl .f2-surf{position:absolute;left:0;right:0;top:124px;height:8px;background:linear-gradient(180deg,rgba(220,255,255,0),rgba(220,255,255,.75) 45%,rgba(120,230,240,0));filter:blur(.4px)}
#oni-camp-fish-ovl .f2-mote{position:absolute;width:3px;height:3px;border-radius:50%;background:#bff;box-shadow:0 0 6px #8ff;animation:fsh-mote linear infinite;opacity:0}
#oni-camp-fish-ovl .f2-mote.v{background:#e2c6ff;box-shadow:0 0 6px #b58cff}
@keyframes mote{0%{opacity:0;transform:translateY(0)}20%{opacity:.85}100%{opacity:0;transform:translateY(-110px)}}
#oni-camp-fish-ovl .f2-crys{position:absolute;bottom:0;width:22px;background:linear-gradient(180deg,#d6b8ff,#7a4fd0 60%,#3a1f78);clip-path:polygon(50% 0,100% 30%,85% 100%,15% 100%,0 30%);opacity:.75;filter:drop-shadow(0 0 8px rgba(181,140,255,.8))}
#oni-camp-fish-ovl .f2-ledge{position:absolute;left:0;top:118px;width:210px;bottom:0;
  background:radial-gradient(40px 26px at 30% 22%,rgba(255,255,255,.10),transparent 70%),radial-gradient(60px 30px at 62% 48%,rgba(181,140,255,.16),transparent 70%),radial-gradient(50px 24px at 22% 70%,rgba(0,0,0,.25),transparent 70%),linear-gradient(180deg,#6a6078 0,#463c58 26%,#2a2238 60%,#17121f);
  clip-path:polygon(0 4px,72% 0,82% 3%,90% 14%,86% 30%,95% 48%,84% 66%,90% 84%,78% 100%,0 100%)}
#oni-camp-fish-ovl .f2-ledge::before{content:"";position:absolute;left:0;top:0;width:78%;height:7px;background:linear-gradient(90deg,#4b6a3a,#6a8a46 60%,transparent);opacity:.85}
#oni-camp-fish-ovl .f2-angler{position:absolute;left:26px;top:12px;height:112px;transform:scaleX(-1);transform-origin:50% 100%;z-index:5}
#oni-camp-fish-ovl .f2-angler img{height:100%;width:auto;display:block}
#oni-camp-fish-ovl .f2-angler.cast{animation:fsh-a-cast .5s ease}
#oni-camp-fish-ovl .f2-angler.wait{animation:fsh-a-wait 3s ease-in-out infinite}
#oni-camp-fish-ovl .f2-angler.reel{animation:fsh-a-reel .6s ease-in-out infinite}
#oni-camp-fish-ovl .f2-angler.yank{animation:fsh-a-yank .9s cubic-bezier(.3,.7,.3,1)}
#oni-camp-fish-ovl .f2-angler.lose{animation:fsh-a-lose .7s ease forwards}
@keyframes a-cast{25%{transform:scaleX(-1) translateY(-6px) rotate(8deg)}60%{transform:scaleX(-1) translateY(2px) rotate(-5deg)}}
@keyframes a-wait{50%{transform:scaleX(-1) translateY(2px) rotate(-2deg)}}
@keyframes a-reel{50%{transform:scaleX(-1) translateX(-2px) rotate(4deg)}}
@keyframes a-yank{12%{transform:scaleX(-1) translateX(-8px) rotate(14deg)}35%{transform:scaleX(-1) translateY(-22px) rotate(-6deg)}55%{transform:scaleX(-1)}72%{transform:scaleX(-1) translateY(-10px)}86%{transform:scaleX(-1)}}
@keyframes a-lose{to{transform:scaleX(-1) translateY(6px) rotate(14deg);opacity:.8}}
#oni-camp-fish-ovl .f2-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6}
#oni-camp-fish-ovl .f2-bob{position:absolute;width:12px;height:14px;margin:-7px 0 0 -6px;z-index:7;display:none}
#oni-camp-fish-ovl .f2-bob::before{content:"";position:absolute;inset:0;border-radius:50% 50% 45% 45%;background:linear-gradient(180deg,#fff 0 40%,#ff4d3d 41%);box-shadow:0 0 6px rgba(255,90,70,.7)}
#oni-camp-fish-ovl .f2-bob.on{display:block}
#oni-camp-fish-ovl .f2-bob.float{animation:fsh-bob 1.4s ease-in-out infinite}
#oni-camp-fish-ovl .f2-bob.dip{animation:fsh-dip .32s ease-in-out 2}
@keyframes bob{50%{transform:translateY(-3px)}}
@keyframes dip{50%{transform:translateY(8px)}}
#oni-camp-fish-ovl .f2-hook{position:absolute;width:16px;height:16px;margin:-4px 0 0 -8px;z-index:7;display:none;image-rendering:pixelated}
#oni-camp-fish-ovl .f2-hook.on{display:block}
#oni-camp-fish-ovl .f2-ring{position:absolute;width:44px;height:10px;margin:-5px 0 0 -22px;border:1.5px solid rgba(220,255,255,.75);border-radius:50%;z-index:6;animation:fsh-ring 1.4s ease-out forwards;pointer-events:none}
@keyframes ring{from{transform:scale(.25);opacity:.9}to{transform:scale(1.9);opacity:0}}
#oni-camp-fish-ovl .f2-drop{position:absolute;width:5px;height:5px;border-radius:50%;background:#dff;z-index:8;animation:fsh-drop .6s ease-out forwards;pointer-events:none}
@keyframes drop{to{transform:translate(var(--dx),var(--dy));opacity:0}}
#oni-camp-fish-ovl .f2-bub{position:absolute;width:6px;height:6px;border-radius:50%;border:1px solid rgba(220,255,255,.8);z-index:6;animation:fsh-bub 1.1s ease-out forwards;pointer-events:none}
@keyframes bub{to{transform:translate(var(--dx),-50px);opacity:0}}
#oni-camp-fish-ovl .f2-fish{position:absolute;z-index:6;transform-origin:50% 50%;pointer-events:none;will-change:transform,left,top;opacity:.82}
#oni-camp-fish-ovl .f2-fish img{display:block;width:100%;height:100%;image-rendering:pixelated;filter:blur(.3px)}
#oni-camp-fish-ovl .f2-fish.amb{opacity:.34}
#oni-camp-fish-ovl .f2-fish.lit img{filter:blur(.3px) drop-shadow(0 0 2px rgba(220,255,240,.9)) drop-shadow(0 0 6px rgba(140,255,200,.6))}
#oni-camp-fish-ovl .f2-fish.legend img{filter:blur(.3px) drop-shadow(0 0 5px rgba(255,214,107,.85))}
#oni-camp-fish-ovl .f2-fish.air{opacity:.95;z-index:12}
#oni-camp-fish-ovl .f2-fish.air img{filter:drop-shadow(0 0 3px rgba(255,255,255,.85))}
#oni-camp-fish-ovl .f2-marks{position:absolute;display:flex;gap:3px;transform:translateX(-50%);z-index:9}
#oni-camp-fish-ovl .f2-mark{width:24px;height:36px;display:grid;place-items:center;border-radius:6px;border:2px solid #fff;font:800 24px var(--f-blue);color:#fff;
  background:linear-gradient(180deg,#ff5a4a,#c41e1e);box-shadow:0 0 12px rgba(255,90,70,.8);animation:fsh-mk .28s ease backwards;text-shadow:0 1px 0 #600}
#oni-camp-fish-ovl .f2-mark:nth-child(2){animation-delay:.07s}
#oni-camp-fish-ovl .f2-mark:nth-child(3){animation-delay:.14s}
@keyframes mk{from{transform:translateY(-10px) scale(1.6);opacity:0}}
#oni-camp-fish-ovl .f2-bob.under{animation:fsh-under .5s ease-in-out infinite}
@keyframes under{0%,100%{transform:translateY(10px)}50%{transform:translateY(14px) translateX(2px)}}
#oni-camp-fish-ovl .f2-bang{position:absolute;z-index:11;pointer-events:none;transform:translate(-50%,-100%)}
#oni-camp-fish-ovl .f2-bang b{position:relative;display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:#fff;color:#e0331f;font:900 28px/1 var(--f-blue);
  border:2px solid #0b1640;box-shadow:0 3px 0 rgba(0,0,0,.35);text-shadow:none;animation:fsh-bangPop .3s cubic-bezier(.3,1.7,.5,1),fsh-bangWob .5s ease-in-out .3s infinite}
#oni-camp-fish-ovl .f2-bang b::after{content:"";position:absolute;left:9px;bottom:-9px;border-left:5px solid transparent;border-right:7px solid transparent;border-top:11px solid #fff;filter:drop-shadow(0 2px 0 #0b1640)}
@keyframes bangPop{from{transform:scale(.2) translateY(14px);opacity:0}}
@keyframes bangWob{50%{transform:rotate(-7deg) scale(1.06)}}
#oni-camp-fish-ovl .f2-bang i{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:3px solid rgba(255,214,107,.95);box-sizing:border-box}
#oni-camp-fish-ovl .f2-bang i.zone{border-color:#fff;box-shadow:0 0 10px 2px rgba(255,214,107,.9)}
#oni-camp-fish-ovl .f2-advfx{position:absolute;z-index:12;pointer-events:none;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:4px solid #ffd66b;animation:fsh-advRing .55s ease-out forwards}
@keyframes advRing{from{transform:scale(1);opacity:1}to{transform:scale(3.4);opacity:0}}
#oni-camp-fish-ovl .f2-advtx{position:absolute;z-index:12;pointer-events:none;transform:translate(-50%,-100%);font:900 15px var(--f-blue);letter-spacing:.08em;color:#ffe9a8;white-space:nowrap;text-shadow:0 2px 0 #7a4a00,0 0 8px rgba(255,214,107,.9);animation:fsh-advTx .9s ease-out forwards}
@keyframes advTx{0%{transform:translate(-50%,-60%) scale(.6);opacity:0}20%{transform:translate(-50%,-100%) scale(1.1);opacity:1}100%{transform:translate(-50%,-160%);opacity:0}}
#oni-camp-fish-ovl .f2-advfx.nice{border-color:#bfe6ff;border-width:3px;animation-duration:.45s}
#oni-camp-fish-ovl .f2-advtx.nice{font-size:13px;color:#e6f6ff;text-shadow:0 2px 0 #1a4a7a,0 0 7px rgba(140,210,255,.85)}
#oni-camp-fish-ovl .f2-hud .adv.nice{background:linear-gradient(180deg,#e6f6ff,#7fbbe8);color:#0b2a4a}
#oni-camp-fish-ovl .f2-hud .adv{display:inline-block;margin-left:6px;padding:0 6px;border-radius:5px;background:linear-gradient(180deg,#fff3a0,#e0a82a);color:#3a2000;font:800 9px var(--f-blue);letter-spacing:.08em;text-shadow:none;vertical-align:2px}
#oni-camp-fish-ovl .f2-hud.lure .nm{font:800 11px var(--f-blue);letter-spacing:.14em;color:#b8c8f0}
#oni-camp-fish-ovl .f2-hud .rin{font:700 10px var(--f-blue);color:#c4d3f5}
#oni-camp-fish-ovl .f2-gauge{position:absolute;left:214px;top:18px;width:30px;height:232px;padding:3px;z-index:8;border-radius:16px}
#oni-camp-fish-ovl .f2-gtrack{position:relative;width:100%;height:100%;border-radius:12px;background:#050a26;overflow:hidden;box-shadow:inset 0 2px 4px rgba(0,0,0,.8)}
#oni-camp-fish-ovl .f2-gfill{position:absolute;left:0;right:0;bottom:0;border-radius:12px;background:linear-gradient(0deg,#1c7cff,#7fe6ff);will-change:height}
#oni-camp-fish-ovl .f2-gfill.perfect{background:linear-gradient(0deg,#ff9a1c,#fff3a0);box-shadow:0 0 12px #ffd66b}
#oni-camp-fish-ovl .f2-gsweet{position:absolute;left:0;right:0;top:0;height:3%;background:rgba(255,214,107,.45);border-bottom:1px solid #fff3c4;z-index:1}
#oni-camp-fish-ovl .f2-tick{position:absolute;transform:translateY(-50%);font:800 11px var(--f-blue);color:#fff;white-space:nowrap;text-shadow:0 1px 2px #000,0 0 3px #000}
#oni-camp-fish-ovl .f2-tick i{font-style:normal;color:var(--gold)}
#oni-camp-fish-ovl .f2-gnum{position:absolute;left:206px;top:256px;width:46px;text-align:center;font:800 15px var(--f-blue);z-index:8;color:#fff;text-shadow:0 1px 2px #000}
#oni-camp-fish-ovl .f2-gnum.perfect{color:var(--gold)}
#oni-camp-fish-ovl .f2-lane{position:absolute;width:80px;z-index:5;border-radius:14px;border:2px solid var(--ff-rim);overflow:hidden;
  background:linear-gradient(90deg,rgba(255,255,255,.12),rgba(255,255,255,0) 30%,rgba(0,8,30,.22)),rgba(4,24,52,.26);
  box-shadow:inset 0 0 0 2px rgba(8,16,58,.85),inset 0 0 16px rgba(0,0,0,.35),0 4px 14px rgba(0,0,0,.45);animation:fsh-f2in .3s ease}
#oni-camp-fish-ovl .f2-lane::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:6px;background:repeating-linear-gradient(180deg,transparent 0 21px,rgba(255,255,255,.28) 21px 22px)}
#oni-camp-fish-ovl .f2-zone{position:absolute;left:4px;right:4px;border-radius:8px;will-change:top;background:linear-gradient(90deg,rgba(110,220,100,.34),rgba(190,255,170,.52) 50%,rgba(110,220,100,.34));border:2px solid rgba(210,255,190,.85);box-shadow:0 0 10px rgba(140,255,140,.3)}
#oni-camp-fish-ovl .f2-zone.in{background:linear-gradient(90deg,rgba(130,240,110,.5),rgba(220,255,200,.72) 50%,rgba(130,240,110,.5));box-shadow:0 0 18px rgba(160,255,160,.7);border-color:#fff}
#oni-camp-fish-ovl .f2-chest{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;z-index:4;display:none}
#oni-camp-fish-ovl .f2-chest.on{display:block;animation:fsh-ch-sink 1s ease-out both}
@keyframes ch-sink{from{opacity:0;transform:translateY(-26px)}to{opacity:1;transform:none}}
#oni-camp-fish-ovl .f2-chest .bob{position:absolute;inset:0;animation:fsh-ch-bob 2.6s ease-in-out infinite}
@keyframes ch-bob{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-3px) rotate(3deg)}}
#oni-camp-fish-ovl .f2-chest .bob img{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}
#oni-camp-fish-ovl .f2-chest .base{filter:brightness(.82) saturate(.7)}
#oni-camp-fish-ovl .f2-chest .tint{filter:brightness(0) invert(1) sepia(1) hue-rotate(165deg) saturate(4);opacity:.34;mix-blend-mode:multiply}
#oni-camp-fish-ovl .f2-chest .shade{filter:brightness(0);opacity:.85;transition:opacity .8s ease .9s}
#oni-camp-fish-ovl .f2-chest.revealed .shade{opacity:0}
#oni-camp-fish-ovl .f2-chest svg{position:absolute;inset:-6px;width:46px;height:46px;opacity:0;transition:opacity .4s ease 1.5s}
#oni-camp-fish-ovl .f2-chest.revealed svg{opacity:1}
#oni-camp-fish-ovl .f2-chest.on.got{animation:fsh-ch-got .7s ease forwards}
@keyframes ch-got{to{transform:translateY(-40px) scale(1.2);opacity:0}}
#oni-camp-fish-ovl .f2-meter{position:absolute;width:24px;z-index:8;border-radius:12px;padding:3px}
#oni-camp-fish-ovl .f2-mtrack{position:relative;width:100%;height:100%;border-radius:9px;background:#050a26;overflow:hidden}
#oni-camp-fish-ovl .f2-mfill{position:absolute;left:0;right:0;bottom:0;border-radius:9px;will-change:height}
#oni-camp-fish-ovl .f2-mhalf{position:absolute;left:0;right:0;top:50%;border-top:1px dashed rgba(255,255,255,.3);z-index:1}
#oni-camp-fish-ovl .f2-reel{position:absolute;width:84px;height:84px;z-index:9;pointer-events:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.55));animation:fsh-f2in .3s ease}
#oni-camp-fish-ovl .f2-hud{position:absolute;right:10px;top:10px;width:196px;padding:7px 10px;z-index:9;display:flex;gap:10px;align-items:center}
#oni-camp-fish-ovl .f2-hud svg{width:42px;height:42px;flex:none}
#oni-camp-fish-ovl .f2-hud .nm{font:800 14px var(--f-blue)}
#oni-camp-fish-ovl .f2-hud .st{color:var(--gold);letter-spacing:1px;font-size:13px}
#oni-camp-fish-ovl .f2-hud .st i{font-style:normal;color:#56608a}
#oni-camp-fish-ovl .f2-hud .tm{font:800 13px var(--f-blue);color:#ffe9a8}
#oni-camp-fish-ovl .f2-hud .tm.urgent{color:var(--bad)}
#oni-camp-fish-ovl .f2-chesthud{position:absolute;right:10px;top:72px;padding:4px 10px 4px 6px;z-index:9;display:flex;gap:6px;align-items:center;font:700 12px var(--f-blue)}
#oni-camp-fish-ovl .f2-chesthud img{width:24px;height:24px;image-rendering:pixelated}
#oni-camp-fish-ovl .f2-cmd{display:flex;align-items:center;gap:12px;padding:0 14px;height:62px;flex:none}
#oni-camp-fish-ovl .f2-msg{font:700 15px/1.3 var(--f-blue);flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#oni-camp-fish-ovl .f2-msg b{color:var(--gold)}
#oni-camp-fish-ovl .f2-stats{flex:none;white-space:nowrap;font:500 11px var(--f-blue);color:#c4d3f5}
#oni-camp-fish-ovl .f2-stats b{color:#fff}
#oni-camp-fish-ovl .f2-hold{flex:none;padding:7px 18px;border-radius:8px;border:2px solid #fff;background:linear-gradient(180deg,#3fb6ff,#1a5fc9);font:800 13px var(--f-blue);color:#fff;cursor:pointer;touch-action:none;text-shadow:0 1px 0 #0a2a6a}
#oni-camp-fish-ovl .f2-hold.held{background:linear-gradient(180deg,#8ae0ff,#3a8ae9)}
#oni-camp-fish-ovl .f2-veil{position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(2,8,24,.35)}
#oni-camp-fish-ovl .f2-win{display:flex;flex-direction:column;gap:12px}
#oni-camp-fish-ovl .f2-tackle{width:500px;padding:22px 20px 14px;font-family:var(--f-ui)}
#oni-camp-fish-ovl .f2-tackle > *,#oni-camp-fish-ovl .f2-picker > *{position:relative;z-index:2}
#oni-camp-fish-ovl .f2-wt{position:absolute!important;left:16px;top:-14px;z-index:3!important}
#oni-camp-fish-ovl .f2-sel{display:grid;grid-template-columns:1fr 1fr;gap:10px}
#oni-camp-fish-ovl .f2-col{display:flex;flex-direction:column;align-items:center;gap:6px}
#oni-camp-fish-ovl .f2-rl{font:700 11px var(--f-ui);letter-spacing:.16em;color:var(--sm-ink-soft)}
#oni-camp-fish-ovl .f2-col.focus .f2-rl{color:var(--sm-accent)}
#oni-camp-fish-ovl .f2-car{display:flex;align-items:center;gap:8px}
#oni-camp-fish-ovl .f2-arrow{width:24px;height:24px;border-radius:50%;border:2px solid var(--sm-gold-2);background:var(--sm-ink);color:var(--sm-parch-top);display:grid;place-items:center;cursor:pointer;font:700 10px var(--f-ui);padding:0;opacity:.55;transition:opacity .15s}
#oni-camp-fish-ovl .f2-col.focus .f2-arrow,#oni-camp-fish-ovl .f2-arrow:hover{opacity:1}
#oni-camp-fish-ovl .f2-circ{position:relative;width:88px;height:88px;border-radius:50%;padding:0;cursor:pointer;border:3px solid var(--sm-gold-2);
  background:radial-gradient(circle at 50% 35%,#5a4330,#2a1d12 72%);box-shadow:0 0 0 2px var(--sm-wood-3),0 3px 0 rgba(41,33,24,.4);display:grid;place-items:center;overflow:hidden;transition:box-shadow .2s}
#oni-camp-fish-ovl .f2-col.focus .f2-circ{box-shadow:0 0 0 2px var(--sm-wood-3),0 0 0 5px rgba(213,182,122,.55),0 3px 0 rgba(41,33,24,.4)}
#oni-camp-fish-ovl .f2-circ img{width:52px;height:52px;image-rendering:pixelated;object-fit:contain}
#oni-camp-fish-ovl .f2-circ svg{width:64px;height:64px}
#oni-camp-fish-ovl .f2-track{position:absolute;inset:0;border-radius:50%;overflow:hidden}
#oni-camp-fish-ovl .f2-th{position:absolute;inset:0;display:grid;place-items:center}
#oni-camp-fish-ovl .f2-circ .q{position:absolute;right:8px;bottom:6px;font:700 10px var(--f-ui);background:var(--sm-ink);color:var(--sm-parch-top);border:1px solid var(--sm-gold-1);border-radius:6px;padding:0 4px;z-index:2}
#oni-camp-fish-ovl .f2-name{font:700 15px var(--f-ui);text-align:center;width:200px;height:1.35em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#oni-camp-fish-ovl .f2-chart{border-top:1px solid var(--sm-gold-1);padding-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:5px 18px}
#oni-camp-fish-ovl .f2-st{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:8px}
#oni-camp-fish-ovl .f2-st span{font:600 10px var(--f-ui);letter-spacing:.06em;color:var(--sm-ink-soft);text-transform:uppercase}
#oni-camp-fish-ovl .f2-sb{height:6px;border-radius:3px;background:#dbd0b8;overflow:hidden}
#oni-camp-fish-ovl .f2-sb i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--sm-gold-2),var(--sm-accent));transition:width .35s cubic-bezier(.3,.7,.3,1)}
#oni-camp-fish-ovl .f2-radar{border-top:1px solid var(--sm-gold-1);padding-top:6px;display:flex;justify-content:center}
#oni-camp-fish-ovl .f2-radar svg{width:260px;height:150px;overflow:visible}
#oni-camp-fish-ovl .f2-radar text{font:600 8px var(--f-ui);fill:var(--sm-ink-soft);letter-spacing:.06em;text-transform:uppercase}
#oni-camp-fish-ovl .f2-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
#oni-camp-fish-ovl .f2-keys{font:400 11px var(--f-ui);color:var(--sm-ink-soft)}
#oni-camp-fish-ovl .f2-picker{width:500px;padding:22px 18px 14px;font-family:var(--f-ui)}
#oni-camp-fish-ovl .f2-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px}
#oni-camp-fish-ovl .f2-cell{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 2px;border-radius:10px;border:0;background:transparent;cursor:pointer}
#oni-camp-fish-ovl .f2-cell:hover,#oni-camp-fish-ovl .f2-cell.sel{background:rgba(183,147,90,.2)}
#oni-camp-fish-ovl .f2-cell .f2-circ{width:56px;height:56px;pointer-events:none}
#oni-camp-fish-ovl .f2-cell .f2-circ img{width:32px;height:32px}
#oni-camp-fish-ovl .f2-cell .f2-circ svg{width:42px;height:42px}
#oni-camp-fish-ovl .f2-cell span{font:700 11px var(--f-ui);text-align:center;line-height:1.2;color:var(--sm-ink)}
#oni-camp-fish-ovl .f2-st{cursor:help;border-radius:4px;padding:1px 2px}
#oni-camp-fish-ovl .f2-st:hover{background:rgba(183,147,90,.16)}
#oni-camp-fish-ovl .f2-st:hover span:first-child{color:var(--sm-accent)}
#oni-camp-fish-ovl .f2-tip{position:absolute;z-index:10;max-width:250px;padding:7px 10px;border-radius:7px;background:var(--sm-ink);color:var(--sm-parch-top);border:1px solid var(--sm-gold-2);
  box-shadow:0 4px 12px rgba(0,0,0,.35);font:400 12px/1.35 var(--f-ui);pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .12s,transform .12s}
#oni-camp-fish-ovl .f2-tip.on{opacity:1;transform:none}
#oni-camp-fish-ovl .f2-tip b{display:block;font:900 11px var(--f-plate);letter-spacing:.1em;color:var(--sm-gold-1);margin-bottom:2px;text-transform:uppercase}
#oni-camp-fish-ovl .f2-tip::after{content:"";position:absolute;left:var(--ax,24px);bottom:-6px;width:10px;height:10px;background:var(--sm-ink);border-right:1px solid var(--sm-gold-2);border-bottom:1px solid var(--sm-gold-2);transform:rotate(45deg)}
#oni-camp-fish-ovl .f2-hastip{cursor:help;transition:box-shadow .15s,filter .15s}
#oni-camp-fish-ovl .f2-slot.f2-hastip:hover{filter:brightness(1.08);box-shadow:0 0 0 2px var(--sm-wood-3),0 0 0 5px rgba(213,182,122,.6),0 0 22px rgba(255,214,107,.5)!important}
#oni-camp-fish-ovl .f2-loot.f2-hastip{border-radius:8px;padding:8px 6px 4px}
#oni-camp-fish-ovl .f2-loot.f2-hastip:hover{background:rgba(183,147,90,.16)}
#oni-camp-fish-ovl .f2-result.wg{color:var(--sm-ink);text-shadow:none;padding:24px 18px 16px;font-family:var(--f-ui)}
#oni-camp-fish-ovl .f2-result.wg > *{position:relative;z-index:2}
#oni-camp-fish-ovl .f2-result.wg .f2-slot{border:3px solid var(--sm-gold-2);background:radial-gradient(circle at 50% 35%,#5a4330,#2a1d12 72%);box-shadow:0 0 0 2px var(--sm-wood-3),0 0 22px rgba(255,214,107,.45)}
#oni-camp-fish-ovl .f2-result.wg .f2-slot.lost img{filter:brightness(0);opacity:.75}
#oni-camp-fish-ovl .f2-result.wg .f2-rn{font:900 20px var(--f-plate);letter-spacing:.04em}
#oni-camp-fish-ovl .f2-result.wg .f2-tg{font:700 11px var(--f-ui);border:1px solid var(--sm-gold-2);background:#fffaf0;color:var(--sm-ink)}
#oni-camp-fish-ovl .f2-result.wg .f2-tg.r{color:#b4580f}
#oni-camp-fish-ovl .f2-result.wg .f2-tg.new{background:radial-gradient(circle at 40% 35%,#c9473a,#7d1d14);color:var(--sm-parch-top);border-color:var(--sm-gold-1);font-family:var(--f-plate);font-weight:900;letter-spacing:.08em}
#oni-camp-fish-ovl .f2-result.wg .f2-tg.perf{background:linear-gradient(180deg,#fff1b0,#e0b04a)}
#oni-camp-fish-ovl .f2-result.wg .f2-loot{border-top:1px solid var(--sm-gold-1)}
#oni-camp-fish-ovl .f2-result.wg .f2-loot .c{font:700 10px var(--f-ui);color:var(--sm-ink-soft)}
#oni-camp-fish-ovl .f2-result.wg .f2-loot .i{font:700 15px var(--f-ui);color:var(--sm-accent)}
#oni-camp-fish-ovl .f2-result.wg .f2-lost{font:400 13px var(--f-ui);color:var(--sm-ink-soft)}
#oni-camp-fish-ovl .f2-fxc{position:absolute;inset:0;width:900px;height:600px;z-index:60;pointer-events:none}
#oni-camp-fish-ovl .f2-flash{position:absolute;inset:0;z-index:70;background:#fff;pointer-events:none;animation:fsh-flash .45s ease-out forwards}
@keyframes flash{0%{opacity:0}18%{opacity:1}100%{opacity:0}}
#oni-camp-fish-ovl .f2-result{width:380px;padding:14px 16px;align-items:center;text-align:center;animation:fsh-pop .35s cubic-bezier(.3,1.4,.5,1)}
@keyframes pop{from{transform:scale(.85);opacity:0}}
#oni-camp-fish-ovl .f2-rh{font:800 14px var(--f-blue);letter-spacing:.2em;color:var(--gold)}
#oni-camp-fish-ovl .f2-slot{width:96px;height:96px;padding:6px;border-radius:10px;border:2px solid #fff;background:linear-gradient(180deg,#0a1238,#1a2c78);box-shadow:inset 0 0 0 2px #050a26,0 0 18px rgba(127,230,255,.4)}
#oni-camp-fish-ovl .f2-slot img{width:100%;height:100%;border-radius:5px;display:block;animation:fsh-rv .7s ease}
#oni-camp-fish-ovl .f2-slot.lost img{image-rendering:pixelated;object-fit:contain;filter:brightness(0) drop-shadow(0 0 1px #7fe6ff);animation:none;opacity:.8}
@keyframes rv{0%{filter:brightness(4);transform:scale(.6)}100%{filter:none;transform:none}}
#oni-camp-fish-ovl .f2-rn{font:800 20px var(--f-blue)}
#oni-camp-fish-ovl .f2-tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}
#oni-camp-fish-ovl .f2-tg{font:800 11px var(--f-blue);padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.6);background:rgba(0,0,0,.25)}
#oni-camp-fish-ovl .f2-tg.new{background:#e0331f;border-color:#fff}
#oni-camp-fish-ovl .f2-tg.perf{background:linear-gradient(180deg,#fff3a0,#e0a82a);color:#3a2000;text-shadow:none;border-color:#fff}
#oni-camp-fish-ovl .f2-loot{display:flex;align-items:center;gap:10px;width:100%;justify-content:center;border-top:1px solid rgba(255,255,255,.25);padding-top:8px}
#oni-camp-fish-ovl .f2-loot img{width:40px;height:40px;image-rendering:pixelated}
#oni-camp-fish-ovl .f2-loot .c{font:700 10px var(--f-blue);letter-spacing:.12em;color:#b8c8f0;text-align:left}
#oni-camp-fish-ovl .f2-loot .i{font:800 15px var(--f-blue);text-align:left}
#oni-camp-fish-ovl .f2-lost{font:500 13px var(--f-blue);color:#c4d3f5}
#${OVL_ID}{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(3,8,18,.55);animation:fsh-f2in .35s ease}
#${OVL_ID}.f2-out{transition:opacity .3s;opacity:0}
#${OVL_ID} .f2-stage{position:relative;width:900px;height:600px;flex:none;transform-origin:50% 50%}
#${OVL_ID} .f2{background:transparent;color:#fff;line-height:1.5}
#${OVL_ID} *{box-sizing:border-box}
#${OVL_ID} [hidden]{display:none!important}
#${OVL_ID} button{width:auto;height:auto;min-width:0;line-height:normal;margin:0;font-family:inherit}
#${OVL_ID} img{border:0;max-width:none}
#${OVL_ID} .f2-fish.spec{transition:left .1s linear,top .1s linear}
@media (prefers-reduced-motion:reduce){#${OVL_ID} *,#${OVL_ID} *::before,#${OVL_ID} *::after{animation-duration:.01ms!important;animation-iteration-count:1!important}}
`;

  console.debug(TAG, "Fishing UI v2 loaded.");
})();
