// ============================================================================
// [ONI][Anim][ZeroPower][Keren] Shrine Bombardment (Pseudo-Only Visuals + Sequencer SFX)
// Foundry VTT v12
//
// UPDATE:
// - Remove wait-chaining between summon attacks (Crysta -> Leilan -> Leichi)
// - Use fixed interval scheduling instead
// - NEW tuning knob: T.summonAttackIntervalMs
// - SFX schedule updated to match new fixed interval timeline
// ============================================================================
(async () => {
  const TAG = "[ONI][Anim][ZeroPower][Keren][ShrineBombardment]";
  const DBG = true;
  // -----------------------------
  // Assets
  // -----------------------------
  const CUTIN_URL =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Cut-in/Keren_Cut-in002.png";
  const OVERDRIVE_SFX =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Overdrive.wav";
  const SHRINE_BG_URL =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Map/Game%20Map/Keren_Map001.png";
  // Summons (visuals)
  const LEICHI_URL =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Leichi/Leichi_Standard.png";
  const LEILAN_URL =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Leilan/Leilan_Standard.png";
  const CRYSTA_URL =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Crysta/Crysta_Battler001.webm";
  const FOXFIRE_URL =
    "https://assets.forge-vtt.com/5faea46cf17c50c47382d836/Fire.png";
  // VFX (visuals)
  const FOXFIRE_IMPACT_VFX =
    "modules/boss-loot-assets-free/artwork/05-spell/homebrew/impact/Explosion_2_Radial_PURPLE_1200x1200.webm";
  const CRYSTA_PIERCE_VFX =
    "modules/JB2A_DnD5e/Library/Generic/Template/Line/Generic/Piercing_Generic01_01_Regular_Orange_1000x400.webm";
  const LEILAN_EXPLODE_VFX =
    "modules/JB2A_DnD5e/Library/Generic/Explosion/Explosion_01_Orange_400x400.webm";
  const LEICHI_EXPLODE_VFX =
    "modules/JB2A_DnD5e/Library/Generic/Explosion/Explosion_05_Regular_Orange_400x400.webm";
  // SFX (Sequencer only)
  const FOXFIRE_IMPACT_SFX =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Explosion1.ogg";
  const CRYSTA_HIT_SFX =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Hit_Piercing.wav";
  const LEICHI_IMPACT_SFX =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Amalthea_Explosion.ogg";
 
  // NEW: Shrine sequence start SFX
  const SHRINE_START_SFX =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Blind.ogg";
// -----------------------------
  // Tuning knobs
  // -----------------------------
  const T = {
    // Intro
    dimFadeInMs: 200,
    dimAlpha: 0.6,
    cutinSlideInMs: 650,
    cutinHoldMs: 850,
    cutinSlideOutMs: 650,
    cutinZ: 99990,
    // Shrine transition
    blackoutFadeInMs: 650,
    blackoutHoldMs: 250,
    blackoutZ: 99990,
    // Shrine staging
    bgZ: 100,
    enemyCloneZ: 200,
    summonZ: 300,
    vfxZ: 500, // above summons
    revealFadeOutMs: 650,
    // Enemy group layout (center of shrine scene)
    centerX: 588,
    centerY: 283,
    spreadStepPx: 58,
    spreadMaxRadiusPx: 240,
    // Summon spawn
    summonSpawnRadiusPx: 380,
    summonFadeInMs: 1000,
    // Fox Fire Explosion
    foxFireMoveMs: 520,
    foxFireIntervalMs: 180,
    foxFireImpactVfxMs: 900,
   
    // ---------------------------------------------------------
    // NEW: Decouple summon attacks from fox fire count.
    // Fox fire phase is treated as a fixed-length "background" phase.
    // Summon attacks will start at a constant time, even if many fox fires exist.
    // ---------------------------------------------------------
    foxFirePhaseFixedMs: 1200,
// Crysta Attack
    crystaMoveMs: 700,
    crystaPierceVfxMs: 900,
    crystaFadeOutMs: 350,
    // Leilan Explosion
    leilanMoveMs: 650,
    leilanExplodeVfxMs: 900,
    // Leichi Explosion + Whiteout
    leichiMoveMs: 650,
    leichiExplodeVfxMs: 1100,
    whiteFadeInMs: 2500,
    whiteHoldMs: 1000,
    whiteFadeOutMs: 650,
    whiteZ: 99999,
    // ---------------------------------------------------------
    // NEW: Fixed interval between summon attacks (Crysta -> Leilan -> Leichi)
    // This replaces "wait for previous attack to finish" chaining.
    // ---------------------------------------------------------
    summonAttackIntervalMs: 350,
    // ---------------------------------------------------------
    // Global VFX scaling knob (affects all VFX sizes)
    // ---------------------------------------------------------
    vfxScaleAll: 2.0,
    // Per-VFX multipliers (explosions boosted)
    vfxScaleFoxFireExplosion: 1.35,
    vfxScaleLeilanExplosion: 1.55,
    vfxScaleLeichiExplosion: 1.65,
    vfxScaleCrystaPierce: 1.15,
    // Fox Fire explosion VFX offset (move to the right)
    foxFireVfxOffsetX: 150,
    foxFireVfxOffsetY: 0,
    // SFX timing tuning knobs (ms)
    sfxOverdriveDelayMs: 0,
        sfxShrineStartDelayMs: 0,
sfxFoxFireImpactOffsetMs: 0,
    sfxCrystaHitOffsetMs: 2500,
    sfxLeichiImpactOffsetMs: 3000,
  };
  // -----------------------------
  // Helpers (caster resolve, emit, etc.)
  // -----------------------------
  const parseTokenIdFromUuid = (uuid) => {
    if (!uuid || typeof uuid !== "string") return null;
    const m = uuid.match(/\.Token\.([A-Za-z0-9]+)$/);
    if (m?.[1]) return m[1];
    if (uuid.length <= 32 && !uuid.includes(".")) return uuid;
    return null;
  };
  const resolveCasterToken = () => {
    const p = globalThis.__PAYLOAD ?? {};
    const idA = p?.casterTokenId;
    const idB = parseTokenIdFromUuid(p?.casterTokenUuid);
    const idC = parseTokenIdFromUuid(p?.attackerUuid);
    const idD = parseTokenIdFromUuid(p?.attackerTokenUuid);
    const idE = parseTokenIdFromUuid(p?.sourceTokenUuid);
    const idF = p?.sourceTokenId;
    const pickId = idA || idB || idC || idD || idE || idF || null;
    const tok =
      (pickId ? canvas.tokens?.get(pickId) : null) ??
      canvas.tokens?.controlled?.[0] ??
      null;
    if (DBG) {
      console.log(TAG, "Payload caster resolve", {
        casterTokenId: idA,
        casterTokenUuid: p?.casterTokenUuid,
        attackerUuid: p?.attackerUuid,
        attackerTokenUuid: p?.attackerTokenUuid,
        sourceTokenUuid: p?.sourceTokenUuid,
        pickId,
        resolvedName: tok?.name ?? null,
        resolvedId: tok?.id ?? null,
      });
    }
    return tok;
  };
  const safeGetDisp = (t) => {
    const d =
      t?.document?.disposition ??
      t?.document?.dispotion ?? // tolerate typo
      t?.actor?.document?.disposition ??
      null;
    return d === -1 ? -1 : 1;
  };
  const isNonHiddenEnemy = (t) =>
    safeGetDisp(t) === -1 && !t?.document?.hidden;
  const detectFoxFireCount = () => {
    const FOXFIRE_ACTOR_UUID = "Actor.VLaGqwrMzpmq0whe";
    const tokens = canvas.tokens?.placeables ?? [];
    let count = 0;
    for (const tok of tokens) {
      if (tok?.document?.hidden) continue;
      const a = tok.actor;
      if (!a) continue;
      const byUuid = a.uuid === FOXFIRE_ACTOR_UUID;
      const byId = a.id && FOXFIRE_ACTOR_UUID.endsWith(a.id);
      const byName = (a.name || "").toLowerCase().includes("fox fire");
      if (byUuid || byId || byName) count++;
    }
    return count;
  };
  // -----------------------------
  // MAIN
  // -----------------------------
  try {
    if (!game.modules.get("sequencer")?.active) {
      ui.notifications.error("Sequencer module is not active (needed for SFX).");
      return;
    }
    if (!canvas?.ready) {
      ui.notifications.warn("Canvas not ready yet.");
      return;
    }
    globalThis.ONI = globalThis.ONI ?? {};
    if (!ONI.emit) {
      ONI.emit = (eventName, payload = {}, options = {}) => {
        const { local = true, world = false } = options;
        if (local) Hooks.callAll(eventName, payload);
        if (world) game.socket.emit("world", { action: eventName, payload });
      };
    }
    const caster = resolveCasterToken();
    if (!caster) {
      ui.notifications.warn("No caster token found (payload missing AND no token selected).");
      return;
    }
    const enemies = (canvas.tokens?.placeables ?? []).filter(isNonHiddenEnemy);
    const foxFireCount = detectFoxFireCount();
    if (DBG) {
      console.log(TAG, "Enemy scan:", enemies.map((t) => t.name));
      console.log(TAG, "Fox Fire count:", foxFireCount);
    }
    ONI.emit(
      "oni:animationStart",
      {
        type: "zeroPower.keren.shrineBombardment",
        sourceTokenId: caster.id,
        targetTokenIds: enemies.map((t) => t.id),
        sceneId: canvas.scene?.id ?? null,
        timestamp: Date.now(),
      },
      { local: true, world: false }
    );
    // ------------------------------------------------------------
    // SFX Schedule (Sequencer only)
    // ------------------------------------------------------------
    const sfx = new Sequence();
    sfx.sound().file(OVERDRIVE_SFX).delay(Math.max(0, T.sfxOverdriveDelayMs)).volume(0.9);
    // Base timeline
    const tIntro =
      T.dimFadeInMs +
      T.cutinSlideInMs +
      T.cutinHoldMs +
      T.cutinSlideOutMs;
    // NEW: play shrine start SFX (Blind) when shrine sequence begins
    sfx.sound().file(SHRINE_START_SFX)
      .delay(Math.max(0, tIntro + Number(T.sfxShrineStartDelayMs || 0)))
      .volume(0.9);
    const tBlackoutToReveal =
      tIntro +
      T.blackoutFadeInMs +
      T.blackoutHoldMs +
      T.revealFadeOutMs;
    // Fox Fire impacts
    const foxStart = tBlackoutToReveal + 120;
    for (let i = 0; i < Math.max(0, foxFireCount); i++) {
      const impactAtBase = foxStart + i * (T.foxFireMoveMs + T.foxFireIntervalMs);
      const impactAt = Math.max(0, impactAtBase + Number(T.sfxFoxFireImpactOffsetMs || 0));
      sfx.sound().file(FOXFIRE_IMPACT_SFX).delay(impactAt).volume(0.95);
    }
    const foxPhaseMs = foxFireCount > 0 ? Number(T.foxFirePhaseFixedMs ?? 0) : 0;
    // NEW: summon interval scheduling (decoupled from fox fire count)
    const summonPhaseStart = foxStart + foxPhaseMs + 120;
    const crystaStart = summonPhaseStart + 0 * T.summonAttackIntervalMs;
    const leilanStart = summonPhaseStart + 1 * T.summonAttackIntervalMs;
    const leichiStart = summonPhaseStart + 2 * T.summonAttackIntervalMs;
    // Crysta impact SFX (at "arrival" time)
    const crystaImpactBase = crystaStart + T.crystaMoveMs;
    const crystaImpactAt = Math.max(0, crystaImpactBase + Number(T.sfxCrystaHitOffsetMs || 0));
    sfx.sound().file(CRYSTA_HIT_SFX).delay(crystaImpactAt).volume(0.95);
    // Leichi impact SFX (at "arrival" time)
    const leichiImpactBase = leichiStart + T.leichiMoveMs;
    const leichiImpactAt = Math.max(0, leichiImpactBase + Number(T.sfxLeichiImpactOffsetMs || 0));
    sfx.sound().file(LEICHI_IMPACT_SFX).delay(leichiImpactAt).volume(0.95);
    sfx.play();
    // ------------------------------------------------------------
    // PSEUDO MASTER (ALL visuals)
    // ------------------------------------------------------------
    const pseudoMaster = `
/* ============================================================================
 * PSEUDO MASTER: Keren Zero Power — Shrine Bombardment
 * UPDATE:
 * - Summon attacks (Crysta -> Leilan -> Leichi) now scheduled by fixed interval
 * - New knob: summonAttackIntervalMs
 * ========================================================================== */
const TAG = "${TAG}[PSEUDO][MASTER]";
const DBG = ${DBG ? "true" : "false"};
if (!canvas?.ready) throw new Error("Canvas not ready (MASTER).");
const wait = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const rand = (a,b) => a + Math.random() * (b-a);
const TAU = Math.PI * 2;
function log(...args){ if (DBG) console.log(TAG, ...args); }
function warn(...args){ if (DBG) console.warn(TAG, ...args); }
function easeInOutCubic(t){
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
}
function animateNumber(setter, from, to, durMs){
  return new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const raw = (performance.now() - start) / Math.max(1, durMs);
      const t = clamp(raw, 0, 1);
      const e = easeInOutCubic(t);
      setter(from + (to - from) * e);
      if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
    };
    canvas.app.ticker.add(tick);
  });
}
function animateXY(obj, from, to, durMs){
  return new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const raw = (performance.now() - start) / Math.max(1, durMs);
      const t = clamp(raw, 0, 1);
      const e = easeInOutCubic(t);
      obj.x = from.x + (to.x - from.x) * e;
      obj.y = from.y + (to.y - from.y) * e;
      if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
    };
    canvas.app.ticker.add(tick);
  });
}
function ensureSortableStage(){
  canvas.stage.sortableChildren = true;
}
globalThis.__ONI_KEREN_ZP__ = globalThis.__ONI_KEREN_ZP__ ?? {};
const S = globalThis.__ONI_KEREN_ZP__;
S.pixi = S.pixi ?? [];
S.dom = S.dom ?? [];
function trackPixi(obj){ S.pixi.push(obj); return obj; }
function trackDom(id){ S.dom.push(id); return id; }
function removeDom(id){ try{ document.getElementById(id)?.remove(); } catch(_){ } }
function cleanupAll(){
  const domIds = (S.dom ?? []).slice();
  S.dom = [];
  for (const id of domIds) removeDom(id);
  const pix = (S.pixi ?? []).slice();
  S.pixi = [];
  for (const it of pix){
    try{ canvas.stage.removeChild(it); } catch(_){}
    try{ it.destroy?.(); } catch(_){}
  }
}
async function createFullScreenOverlay(colorHex, zIndex){
  const w = canvas.app.renderer.screen.width;
  const h = canvas.app.renderer.screen.height;
  const g = new PIXI.Graphics();
  g.beginFill(colorHex, 1);
  g.drawRect(0, 0, w, h);
  g.endFill();
  g.x = 0; g.y = 0;
  g.alpha = 0;
  g.zIndex = Number(zIndex);
  ensureSortableStage();
  canvas.stage.addChild(g);
  canvas.stage.sortChildren();
  trackPixi(g);
  return g;
}
async function createFullScreenBGSprite(url, zIndex){
  const tex = await loadTexture(url);
  const s = new PIXI.Sprite(tex);
  s.anchor.set(0);
  s.x = 0; s.y = 0;
  s.width = canvas.app.renderer.screen.width;
  s.height = canvas.app.renderer.screen.height;
  s.alpha = 1;
  s.zIndex = Number(zIndex);
  ensureSortableStage();
  canvas.stage.addChild(s);
  canvas.stage.sortChildren();
  trackPixi(s);
  return s;
}
async function fadePixiAlpha(obj, fromA, toA, durMs){
  obj.alpha = fromA;
  await animateNumber((v) => obj.alpha = v, fromA, toA, durMs);
}
function createCutinDOM({ url, slideInMs, holdMs, slideOutMs, zIndex }){
  const id = "oni-keren-cutin-" + Date.now() + "-" + Math.floor(Math.random()*100000);
  const wrap = document.createElement("div");
  wrap.id = id;
  Object.assign(wrap.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "100vw",
    height: "100vh",
    zIndex: String(zIndex),
    pointerEvents: "none",
    overflow: "hidden",
  });
  const img = document.createElement("img");
  img.src = url;
  Object.assign(img.style, {
    position: "absolute",
    left: "-120%",
    bottom: "0%",
    height: "92vh",
    width: "auto",
    objectFit: "contain",
    border: "none",
    outline: "none",
    boxShadow: "none",
    background: "transparent",
    display: "block",
    willChange: "left, opacity, transform",
  });
  wrap.appendChild(img);
  document.body.appendChild(wrap);
  trackDom(id);
  return { id, wrap, img, slideInMs, holdMs, slideOutMs };
}
async function runCutinDOM(c){
  const { img, slideInMs, holdMs, slideOutMs, wrap } = c;
  img.style.transition = "left " + slideInMs + "ms ease-out";
  void img.offsetHeight;
  img.style.left = "0%";
  await wait(slideInMs);
  await wait(holdMs);
  img.style.transition = "left " + slideOutMs + "ms ease-in";
  img.style.left = "120%";
  await wait(slideOutMs + 30);
  try{ wrap.remove(); }catch(_){}
}
function spawnMediaDOMAtXY({ url, x, y, w=220, h=220, zIndex=99990, opacity=1 }){
  const id = "oni-keren-media-" + Date.now() + "-" + Math.floor(Math.random()*100000);
  const wrap = document.createElement("div");
  wrap.id = id;
  Object.assign(wrap.style, {
    position: "fixed",
    left: (x - w/2) + "px",
    top: (y - h/2) + "px",
    width: w + "px",
    height: h + "px",
    zIndex: String(zIndex),
    pointerEvents: "none",
    opacity: String(opacity),
    border: "none",
    outline: "none",
    boxShadow: "none",
    background: "transparent",
    willChange: "left, top, opacity, transform",
  });
  const lower = String(url || "").toLowerCase();
  const isWebm = lower.endsWith(".webm");
  let el;
  if (isWebm){
    el = document.createElement("video");
    el.src = url;
    el.autoplay = true;
    el.loop = true;
    el.muted = true;
    el.playsInline = true;
  } else {
    el = document.createElement("img");
    el.src = url;
  }
  Object.assign(el.style, {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    display: "block",
    border: "none",
    outline: "none",
    boxShadow: "none",
    background: "transparent",
  });
  wrap.appendChild(el);
  document.body.appendChild(wrap);
  trackDom(id);
  return { id, wrap, el, w, h };
}
async function moveDomTo(domObj, toXY, durMs){
  const { wrap, w, h } = domObj;
  const from = {
    x: parseFloat(wrap.style.left) + w/2,
    y: parseFloat(wrap.style.top) + h/2
  };
  const to = { x: toXY.x, y: toXY.y };
  await new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const raw = (performance.now() - start) / Math.max(1, durMs);
      const t = clamp(raw, 0, 1);
      const e = easeInOutCubic(t);
      const cx = from.x + (to.x - from.x) * e;
      const cy = from.y + (to.y - from.y) * e;
      wrap.style.left = (cx - w/2) + "px";
      wrap.style.top  = (cy - h/2) + "px";
      if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
    };
    canvas.app.ticker.add(tick);
  });
}
async function fadeDom(domObj, fromA, toA, durMs){
  const { wrap } = domObj;
  wrap.style.opacity = String(fromA);
  await new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const raw = (performance.now() - start) / Math.max(1, durMs);
      const t = clamp(raw, 0, 1);
      const e = easeInOutCubic(t);
      wrap.style.opacity = String(fromA + (toA - fromA) * e);
      if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
    };
    canvas.app.ticker.add(tick);
  });
}
async function createTokenCloneSprite(tokenPlaceable, xy, zIndex, scaleMul=1){
  const src = tokenPlaceable?.document?.texture?.src;
  if (!src) return null;
  const texture = await loadTexture(src);
  const spr = new PIXI.Sprite(texture);
  spr.anchor.set(0.5);
  spr.x = xy.x;
  spr.y = xy.y;
  spr.zIndex = Number(zIndex);
  const mesh = tokenPlaceable.mesh ?? tokenPlaceable.icon ?? null;
  if (mesh?.width && mesh?.height){
    spr.width  = mesh.width  * scaleMul;
    spr.height = mesh.height * scaleMul;
  } else {
    const grid = canvas.grid?.size ?? 100;
    const w = (tokenPlaceable.document.width ?? 1) * grid * scaleMul;
    const h = (tokenPlaceable.document.height ?? 1) * grid * scaleMul;
    spr.width = w;
    spr.height = h;
  }
  ensureSortableStage();
  canvas.stage.addChild(spr);
  canvas.stage.sortChildren();
  trackPixi(spr);
  return spr;
}
function computeEnemySpots(n, center, step, maxR){
  const spots = [];
  const golden = 2.399963229728653;
  for (let i = 0; i < n; i++){
    const rRaw = step * Math.sqrt(i);
    const r = Math.min(maxR, rRaw);
    const a = i * golden;
    spots.push({
      x: center.x + Math.cos(a) * r,
      y: center.y + Math.sin(a) * r
    });
  }
  return spots;
}
function randomOffscreenPoint(center, radius){
  const a = rand(0, TAU);
  return {
    x: center.x + Math.cos(a) * radius,
    y: center.y + Math.sin(a) * radius
  };
}
function vfxSize(baseSize, mul=1){
  const g = Number(ctx.params.vfxScaleAll ?? 1);
  return Math.round(baseSize * g * Number(mul ?? 1));
}
async function playVfxAtXY({ url, x, y, ms, zIndex, baseSize=380, mul=1 }){
  const size = vfxSize(baseSize, mul);
  const v = spawnMediaDOMAtXY({ url, x, y, w: size, h: size, zIndex, opacity: 1 });
  await wait(Math.max(0, ms));
  removeDom(v.id);
}
async function playLineVfx({ url, from, to, ms, zIndex, baseLen=520, baseThick=180, mul=1 }){
  const length = vfxSize(baseLen, mul);
  const thickness = vfxSize(baseThick, mul);
  const cx = (from.x + to.x) / 2;
  const cy = (from.y + to.y) / 2;
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const dom = spawnMediaDOMAtXY({
    url,
    x: cx,
    y: cy,
    w: length,
    h: thickness,
    zIndex,
    opacity: 1
  });
  dom.wrap.style.transformOrigin = "center center";
  dom.wrap.style.transform = "rotate(" + ang + "rad)";
  await wait(Math.max(0, ms));
  removeDom(dom.id);
}
// NEW: schedule helper (fixed-interval orchestration)
function scheduleAt(ms, fn){
  return new Promise((resolve) => {
    setTimeout(async () => {
      try { await fn(); }
      finally { resolve(true); }
    }, Math.max(0, ms));
  });
}
// ======================================================================
// Intro
// ======================================================================
log("=== Intro START ===");
const dimmer = await createFullScreenOverlay(0x000000, 50);
await fadePixiAlpha(dimmer, 0, Number(ctx.params.dimAlpha), Number(ctx.params.dimFadeInMs));
const cutin = createCutinDOM({
  url: String(ctx.params.cutinUrl),
  slideInMs: Number(ctx.params.cutinSlideInMs),
  holdMs: Number(ctx.params.cutinHoldMs),
  slideOutMs: Number(ctx.params.cutinSlideOutMs),
  zIndex: Number(ctx.params.cutinZ),
});
await runCutinDOM(cutin);
log("=== Intro END ===");
// ======================================================================
// Shrine
// ======================================================================
log("=== Shrine START ===");
const black = await createFullScreenOverlay(0x000000, Number(ctx.params.blackoutZ));
await fadePixiAlpha(black, 0, 1, Number(ctx.params.blackoutFadeInMs));
await fadePixiAlpha(dimmer, Number(dimmer.alpha ?? 0), 0, 200);
await createFullScreenBGSprite(String(ctx.params.shrineBgUrl), Number(ctx.params.bgZ));
const enemyUuids = Array.isArray(ctx.params.enemyTokenUuids) ? ctx.params.enemyTokenUuids : [];
const enemySpots = computeEnemySpots(
  enemyUuids.length,
  { x: Number(ctx.params.centerX), y: Number(ctx.params.centerY) },
  Number(ctx.params.spreadStepPx),
  Number(ctx.params.spreadMaxRadiusPx)
);
const n = enemyUuids.length;
const groupScale = clamp(1 - Math.max(0, n - 4) * 0.05, 0.65, 1.0);
for (let i = 0; i < enemyUuids.length; i++){
  const docOrObj = await fromUuid(enemyUuids[i]);
  const placeable =
    (docOrObj?.document && docOrObj?.center) ? docOrObj :
    (docOrObj?.object?.document && docOrObj?.object?.center) ? docOrObj.object :
    (docOrObj?.documentName === "Token" ? (docOrObj.object ?? canvas.tokens?.get(docOrObj.id)) : null);
  if (!placeable){
    warn("Enemy placeable not resolved", enemyUuids[i]);
    continue;
  }
  await createTokenCloneSprite(placeable, enemySpots[i], Number(ctx.params.enemyCloneZ), groupScale);
}
await wait(Number(ctx.params.blackoutHoldMs));
await fadePixiAlpha(black, 1, 0, Number(ctx.params.revealFadeOutMs));
log("Shrine reveal complete");
// ======================================================================
// Spawn summons offscreen
// ======================================================================
const center = { x: Number(ctx.params.centerX), y: Number(ctx.params.centerY) };
const spawnRadius = Number(ctx.params.summonSpawnRadiusPx);
const summonZ = Number(ctx.params.summonZ);
function spawnSummon(url, size){
  const p = randomOffscreenPoint(center, spawnRadius);
  const d = spawnMediaDOMAtXY({ url, x: p.x, y: p.y, w: size, h: size, zIndex: summonZ, opacity: 0 });
  return d;
}
const leichi = spawnSummon(String(ctx.params.leichiUrl), 260);
const leilan = spawnSummon(String(ctx.params.leilanUrl), 260);
const crysta = spawnSummon(String(ctx.params.crystaUrl), 320);
async function spawnFoxFireSprite(){
  const tex = await loadTexture(String(ctx.params.foxFireUrl));
  const spr = new PIXI.Sprite(tex);
  spr.anchor.set(0.5);
  const p = randomOffscreenPoint(center, spawnRadius);
  spr.x = p.x;
  spr.y = p.y;
  spr.zIndex = Number(ctx.params.summonZ);
  spr.alpha = 0;
  spr.width = 110;
  spr.height = 110;
  ensureSortableStage();
  canvas.stage.addChild(spr);
  canvas.stage.sortChildren();
  trackPixi(spr);
  return spr;
}
await Promise.all([
  fadeDom(leichi, 0, 1, Number(ctx.params.summonFadeInMs)),
  fadeDom(leilan, 0, 1, Number(ctx.params.summonFadeInMs)),
  fadeDom(crysta, 0, 1, Number(ctx.params.summonFadeInMs)),
]);
const foxCount = Math.max(0, Number(ctx.params.foxFireCount ?? 0));
const foxFires = [];
for (let i = 0; i < foxCount; i++){
  foxFires.push(await spawnFoxFireSprite());
}
log("Summons spawned", { foxCount });
// ======================================================================
// Fox Fire Explosion (unchanged)
// ======================================================================
log("=== Fox Fire Explosion START ===");
const foxVfxDx = Number(ctx.params.foxFireVfxOffsetX ?? 0);
const foxVfxDy = Number(ctx.params.foxFireVfxOffsetY ?? 0);
// NEW: fixed phase duration (decoupled from fox fire count)
const foxFixedMs = Math.max(0, Number(ctx.params.foxFirePhaseFixedMs ?? 0));
// Schedule each fox fire as a background task.
// We do NOT await them here, so summon attacks can start at a fixed time.
const foxTasks = [];
for (let i = 0; i < foxFires.length; i++){
  const spr = foxFires[i];
  const startAt = i * (Number(ctx.params.foxFireMoveMs) + Number(ctx.params.foxFireIntervalMs));
  foxTasks.push(scheduleAt(startAt, async () => {
    try{
      if (!spr) return;
      const from = { x: spr.x, y: spr.y };
      const to = { x: center.x, y: center.y };
      if ((spr.alpha ?? 0) < 1) await fadePixiAlpha(spr, spr.alpha ?? 0, 1, 120);
      await animateXY(spr, from, to, Number(ctx.params.foxFireMoveMs));
      // Safely remove sprite (it may already be removed during cleanup)
      try{ canvas.stage.removeChild(spr); } catch(_){ }
      try{ spr.destroy?.(); } catch(_){ }
      await playVfxAtXY({
        url: String(ctx.params.foxFireImpactVfx),
        x: center.x + foxVfxDx,
        y: center.y + foxVfxDy,
        ms: Number(ctx.params.foxFireImpactVfxMs),
        zIndex: Number(ctx.params.vfxZ),
        baseSize: 420,
        mul: Number(ctx.params.vfxScaleFoxFireExplosion ?? 1),
      });
    } catch (e){
      // Ignore: likely cleaned up under whiteout
      warn("FoxFire task skipped/ended early", e?.message ?? e);
    }
  }));
}
log("Fox Fire scheduled", { foxCount: foxFires.length, foxFixedMs });
// IMPORTANT: Summon attacks start after a FIXED delay, not after fox fire tasks finish.
await wait(foxFixedMs);
log("=== Fox Fire Explosion END (fixed phase) ===");
// ======================================================================
// Summon Attacks (FIXED INTERVAL SCHEDULER)
// - No more "await previous" chaining.
// - We schedule each attack to BEGIN every summonAttackIntervalMs.
// ======================================================================
const interval = Number(ctx.params.summonAttackIntervalMs ?? 900);
// -- Crysta Attack task
const crystaTask = async () => {
  log("=== Crysta Attack START (scheduled) ===");
  await moveDomTo(crysta, center, Number(ctx.params.crystaMoveMs));
  await playLineVfx({
    url: String(ctx.params.crystaPierceVfx),
    from: { x: crysta.wrap.offsetLeft + crysta.w/2, y: crysta.wrap.offsetTop + crysta.h/2 },
    to: center,
    ms: Number(ctx.params.crystaPierceVfxMs),
    zIndex: Number(ctx.params.vfxZ),
    baseLen: 560,
    baseThick: 220,
    mul: Number(ctx.params.vfxScaleCrystaPierce ?? 1),
  });
  await fadeDom(crysta, 1, 0, Number(ctx.params.crystaFadeOutMs));
  removeDom(crysta.id);
  log("=== Crysta Attack END (scheduled) ===");
};
// -- Leilan Explosion task
const leilanTask = async () => {
  log("=== Leilan Explosion START (scheduled) ===");
  await moveDomTo(leilan, center, Number(ctx.params.leilanMoveMs));
  removeDom(leilan.id);
  await playVfxAtXY({
    url: String(ctx.params.leilanExplodeVfx),
    x: center.x,
    y: center.y,
    ms: Number(ctx.params.leilanExplodeVfxMs),
    zIndex: Number(ctx.params.vfxZ),
    baseSize: 420,
    mul: Number(ctx.params.vfxScaleLeilanExplosion ?? 1),
  });
  log("=== Leilan Explosion END (scheduled) ===");
};
// -- Leichi Explosion task (final)
const leichiTask = async () => {
  log("=== Leichi Explosion START (scheduled) ===");
  await moveDomTo(leichi, center, Number(ctx.params.leichiMoveMs));
  removeDom(leichi.id);
  const white = await createFullScreenOverlay(0xFFFFFF, Number(ctx.params.whiteZ));
  const explodePromise = playVfxAtXY({
    url: String(ctx.params.leichiExplodeVfx),
    x: center.x,
    y: center.y,
    ms: Number(ctx.params.leichiExplodeVfxMs),
    zIndex: Number(ctx.params.vfxZ),
    baseSize: 460,
    mul: Number(ctx.params.vfxScaleLeichiExplosion ?? 1),
  });
  const whiteInPromise = fadePixiAlpha(white, 0, 1, Number(ctx.params.whiteFadeInMs));
  await Promise.all([explodePromise, whiteInPromise]);
  log("Whiteout reached — cleanup under white");
  cleanupAll();
  await wait(Number(ctx.params.whiteHoldMs));
  const white2 = await createFullScreenOverlay(0xFFFFFF, Number(ctx.params.whiteZ));
  white2.alpha = 1;
  await fadePixiAlpha(white2, 1, 0, Number(ctx.params.whiteFadeOutMs));
  try{ canvas.stage.removeChild(white2); } catch(_){}
  try{ white2.destroy?.(); } catch(_){}
  log("=== Leichi Explosion END (scheduled) ===");
};
// Schedule them (fixed intervals)
const start0 = 0;
const start1 = interval;
const start2 = interval * 2;
const p0 = scheduleAt(start0, crystaTask);
const p1 = scheduleAt(start1, leilanTask);
const p2 = scheduleAt(start2, leichiTask);
// IMPORTANT: we still wait for all tasks to finish before ending master
await Promise.all([p0, p1, p2]);
log("MASTER DONE");
return true;
`;
    await (game.ONI?.pseudo?.play?.({
      scriptId: "oni.keren.zeroPower.shrineBombardment.master",
      scriptSource: pseudoMaster,
      casterTokenUuid: caster.document.uuid,
      params: {
        // Intro
        dimFadeInMs: T.dimFadeInMs,
        dimAlpha: T.dimAlpha,
        cutinUrl: CUTIN_URL,
        cutinSlideInMs: T.cutinSlideInMs,
        cutinHoldMs: T.cutinHoldMs,
        cutinSlideOutMs: T.cutinSlideOutMs,
        cutinZ: T.cutinZ,
        // Shrine
        blackoutFadeInMs: T.blackoutFadeInMs,
        blackoutHoldMs: T.blackoutHoldMs,
        blackoutZ: T.blackoutZ,
        shrineBgUrl: SHRINE_BG_URL,
        bgZ: T.bgZ,
        enemyCloneZ: T.enemyCloneZ,
        summonZ: T.summonZ,
        vfxZ: T.vfxZ,
        revealFadeOutMs: T.revealFadeOutMs,
        centerX: T.centerX,
        centerY: T.centerY,
        spreadStepPx: T.spreadStepPx,
        spreadMaxRadiusPx: T.spreadMaxRadiusPx,
        summonSpawnRadiusPx: T.summonSpawnRadiusPx,
        summonFadeInMs: T.summonFadeInMs,
        // NEW interval knob
        summonAttackIntervalMs: T.summonAttackIntervalMs,
        // Enemies + fox fire count
        enemyTokenUuids: enemies.map((t) => t.document.uuid),
        foxFireCount,
        // Summons URLs
        leichiUrl: LEICHI_URL,
        leilanUrl: LEILAN_URL,
        crystaUrl: CRYSTA_URL,
        foxFireUrl: FOXFIRE_URL,
        // Fox fire
        foxFireMoveMs: T.foxFireMoveMs,
        foxFireIntervalMs: T.foxFireIntervalMs,
        foxFireImpactVfx: FOXFIRE_IMPACT_VFX,
        foxFireImpactVfxMs: T.foxFireImpactVfxMs,
       
        foxFirePhaseFixedMs: T.foxFirePhaseFixedMs,
// Crysta
        crystaMoveMs: T.crystaMoveMs,
        crystaPierceVfx: CRYSTA_PIERCE_VFX,
        crystaPierceVfxMs: T.crystaPierceVfxMs,
        crystaFadeOutMs: T.crystaFadeOutMs,
        // Leilan
        leilanMoveMs: T.leilanMoveMs,
        leilanExplodeVfx: LEILAN_EXPLODE_VFX,
        leilanExplodeVfxMs: T.leilanExplodeVfxMs,
        // Leichi + whiteout
        leichiMoveMs: T.leichiMoveMs,
        leichiExplodeVfx: LEICHI_EXPLODE_VFX,
        leichiExplodeVfxMs: T.leichiExplodeVfxMs,
        whiteFadeInMs: T.whiteFadeInMs,
        whiteHoldMs: T.whiteHoldMs,
        whiteFadeOutMs: T.whiteFadeOutMs,
        whiteZ: T.whiteZ,
        // VFX scaling + offsets
        vfxScaleAll: T.vfxScaleAll,
        vfxScaleFoxFireExplosion: T.vfxScaleFoxFireExplosion,
        vfxScaleLeilanExplosion: T.vfxScaleLeilanExplosion,
        vfxScaleLeichiExplosion: T.vfxScaleLeichiExplosion,
        vfxScaleCrystaPierce: T.vfxScaleCrystaPierce,
        foxFireVfxOffsetX: T.foxFireVfxOffsetX,
        foxFireVfxOffsetY: T.foxFireVfxOffsetY,
      },
      meta: { source: "KerenShrineBombardment" },
    }) ?? Promise.resolve());
    ONI.emit(
      "oni:animationEnd",
      {
        type: "zeroPower.keren.shrineBombardment",
        sourceTokenId: caster.id,
        targetTokenIds: enemies.map((t) => t.id),
        sceneId: canvas.scene?.id ?? null,
        timestamp: Date.now(),
      },
      { local: true, world: false }
    );
    if (DBG) console.log(TAG, "END (success)");
  } catch (err) {
    console.error(TAG, "Animation crashed:", err);
    try {
      globalThis.ONI?.emit?.(
        "oni:animationEnd",
        { type: "zeroPower.keren.shrineBombardment", error: true, timestamp: Date.now() },
        { local: true, world: false }
      );
    } catch (_) {}
    ui.notifications.error("Keren Zero Power animation crashed. Check console for details.");
  }
})();
