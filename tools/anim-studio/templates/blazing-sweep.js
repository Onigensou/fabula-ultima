// =============================================================================
// Centuaros - Blazing Sweep / Fiery Onslaught (AoE crescent sweep). Bespoke,
// parametric via a CFG object so Fiery Onslaught reuses it (more sweeps + fire
// tint + a finishing explosion & screenshake).
// A large glowing crescent swings across the whole scene leaving a motion trail;
// doneHook fires at the apex of the (final) sweep.
// =============================================================================
(async () => {

const CFG = {"moveToCenter":true,"centerX":0.5,"centerY":0.5,"dashMs":240,"dashBackMs":220,"ringRx":0.44,"ringRatio":0.3,"ringDropY":0.06,"bandW":120,"trailSpan":2.6,"taperPow":0.75,"coreColor":16774848,"closeFlash":0.85,"emberEveryMs":16,"emberPerBurst":4,"emberSpread":52,"emberMs":440,"flashAlpha":0.95,"flashMs":110,"fadeMs":180,"betweenMs":70,"endPadMs":140,"totalTimeoutMs":12000,"sfxSweep":"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_SWINGH.wav","sfxSweepVol":0.6,"name":"Blazing Sweep","key":"blazingsweep","color":16769613,"sweeps":1,"sweepMs":300,"explosion":false};
const TAG = "[ONI][Anim][Sweep][" + CFG.name + "]";
const ANIM_KEY = "oni.centuaros." + CFG.key;
const EXPLOSION_URL = "modules/JB2A_DnD5e/Library/Generic/Explosion/Explosion_01_Orange_400x400.webm";

const P = globalThis.__PAYLOAD ?? payload ?? {};
function tokFromUuid(u) { try { const d = fromUuidSync?.(u); return d?.object ?? null; } catch (_) { return null; } }
function resolveSource() {
  for (const c of [P?.casterTokenUuid, P?.sourceTokenUuid, P?.tokenUuid]) { const t = tokFromUuid(c); if (t) return t; }
  return canvas?.tokens?.controlled?.[0] ?? null;
}
function resolveTargets() {
  const out = [];
  const arg = Array.isArray(targets) ? targets : [];
  for (const t of arg) if (t?.center) out.push(t);
  if (!out.length && Array.isArray(globalThis.__TARGETS)) for (const t of globalThis.__TARGETS) if (t?.center) out.push(t);
  return out;
}
const sourceToken  = resolveSource();
const partyTargets = resolveTargets();

const doneHook = "oni.anim." + ANIM_KEY + "." + (foundry?.utils?.randomID?.(8) ?? String(Date.now()));
function onceHook(name, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; Hooks.off(name, h); resolve({ ok: false, timeout: true }); }, timeoutMs);
    const h = (d) => { if (settled) return; settled = true; clearTimeout(timer); Hooks.off(name, h); resolve(d ?? { ok: true }); };
    Hooks.on(name, h);
  });
}
function emitLocal(name, data) { try { Hooks.callAll(name, data); } catch (_) {} }

const scriptSource = String.raw`
const caster = ctx.casterToken;
const cfg = ctx.params.cfg;
const A = ctx.params.assets;

const stage = canvas.stage;
stage.sortableChildren = true;
const ticker = canvas.app.ticker;
const W = canvas.app.renderer.screen.width;
const H = canvas.app.renderer.screen.height;
const WT = stage.worldTransform.clone();
const ZOOM = Math.abs(stage.scale?.x || 1) || 1;
const S2W = (fx, fy) => WT.applyInverse(new PIXI.Point(fx * W, fy * H));
const wLen = (px) => px / ZOOM;
const hPx  = (frac) => wLen(frac * H);
const waitMs = (ms) => new Promise(r => setTimeout(r, Number(ms) || 0));

const spawned = [];
function destroyObj(o) { try { if (o && !o._destroyed) { if (o.parent) o.parent.removeChild(o); o.destroy({ children: true }); } } catch (_) {} }
function cleanupAll() { for (const o of spawned.splice(0)) destroyObj(o); }
let doneFired = false;
function fireDone(res) { if (doneFired) return; doneFired = true; try { Hooks.callAll(ctx.params.doneHook, res || { ok: true }); } catch (_) {} }

const easeInOutCubic = (t) => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);   // snappy: fast start, sharp settle
function tween(fn, dur, ease) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => { const raw = dur>0?Math.min(1,(performance.now()-t0)/dur):1; try{fn(ease?ease(raw):raw,raw);}catch(_){} if(raw>=1){ticker.remove(step);resolve();} };
    ticker.add(step);
  });
}
function screenShake(ms, px) {
  try {
    const view = canvas.app.view;
    if (!document.getElementById("oni-shake-kf")) {
      const st = document.createElement("style"); st.id = "oni-shake-kf";
      st.textContent = "@keyframes oniShake{0%,100%{transform:translate(0,0)}15%{transform:translate(-" + px + "px," + px + "px)}30%{transform:translate(" + px + "px,-" + px + "px)}45%{transform:translate(-" + px + "px,-" + px + "px)}60%{transform:translate(" + px + "px," + px + "px)}75%{transform:translate(-" + px + "px,0)}} .oni-shaking{animation:oniShake 0.42s linear}";
      document.head.appendChild(st);
    }
    view.classList.remove("oni-shaking"); void view.offsetWidth; view.classList.add("oni-shaking");
    setTimeout(() => { try { view.classList.remove("oni-shaking"); } catch(_){} }, ms);
  } catch (_) {}
}
function playSfx(url, vol) {
  if (!url) return;
  try { const a = new Audio(url); a.volume = (vol == null ? 0.6 : vol); a.play().catch(() => {}); } catch (_) {}
}
async function loadVideo(url) {
  const vid = document.createElement("video");
  try { vid.crossOrigin = "anonymous"; } catch (_) {}
  vid.src = url; vid.muted = true; vid.loop = false; vid.playsInline = true; vid.preload = "auto";
  await new Promise((res) => { let done=false; const go=()=>{if(done)return;done=true;res();}; vid.addEventListener("loadeddata",go,{once:true}); vid.addEventListener("error",go,{once:true}); setTimeout(go,1500); });
  return vid;
}

// token sprite clone + hide/restore (caster physically moves to center)
function meshOf(tok) { return tok ? tok.mesh : null; }
function makeSprite(tok, faceSign) {
  const m = meshOf(tok);
  const sp = new PIXI.Sprite(m?.texture ?? PIXI.Texture.WHITE);
  sp.anchor.set(0.5, 0.5);
  sp.width = Math.abs(m?.width ?? (tok?.w ?? 100));
  sp.height = Math.abs(m?.height ?? (tok?.h ?? 100));
  sp.angle = m?.angle ?? 0;
  const sx = Math.sign(m?.scale?.x ?? 1) || 1, sy = Math.sign(m?.scale?.y ?? 1) || 1;
  sp.scale.x = Math.abs(sp.scale.x) * sx * (faceSign || 1);
  sp.scale.y = Math.abs(sp.scale.y) * sy;
  return sp;
}
function makeHider(tok) {
  const m = meshOf(tok); let on=false,tR=true,mR=true;
  const guard = () => { if (!tok) return; tok.renderable = false; if (m) m.renderable = false; };
  return { start(){ if(!tok||on)return; on=true; tR=tok.renderable??true; mR=m?.renderable??true; ticker.add(guard); },
           restore(){ if(!tok||!on)return; ticker.remove(guard); tok.renderable=tR; if(m)m.renderable=mR; try{tok.renderFlags.set({refreshVisibility:true,refreshMesh:true,refreshState:true});}catch(_){} on=false; } };
}

function dotTexture(hex) {
  const s = 64; const cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d");
  const col = "#" + (hex >>> 0).toString(16).padStart(6, "0").slice(-6);
  const grd = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  grd.addColorStop(0, "#ffffff"); grd.addColorStop(0.4, col); grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.beginPath(); g.arc(s/2, s/2, s/2, 0, Math.PI*2); g.fill();
  return PIXI.Texture.from(cv);
}
// A point on the perspective ground-ellipse (wide rx, short ry = tilt).
function ellipsePt(cx, cy, rx, ry, a) { return { x: cx + rx*Math.cos(a), y: cy + ry*Math.sin(a) }; }
// Redraw the sweep as a BLADED SLASH TRAIL following the ellipse: a filled
// ribbon that tapers from a sharp point at the tail to full width at the head,
// with a crisp bright OUTER edge (the cutting edge). The far half of the oval
// (top, sin<0) is dimmed so it reads as receding behind the arena.
//   headA     = leading-edge angle; trailSpan = arc length of the visible trail.
function drawRingSlash(g, cx, cy, rx, ry, headA, trailSpan, bandW, gold, cream, alpha, taperPow, shimmerColor, shimmer) {
  g.clear();
  const steps = Math.max(10, Math.round(trailSpan / (Math.PI*2) * 120));
  const tailA = headA - trailSpan;
  const outer = [], inner = [], dep = [], wt = [];
  for (let i=0;i<=steps;i++){
    const t = i/steps;                         // 0 at tail -> 1 at head
    const a = tailA + trailSpan*t;
    const w = bandW * Math.pow(t, taperPow ?? 0.7);   // taper to a sharp point at the tail
    const inRx = Math.max(1, rx - w), inRy = Math.max(1, ry - w*(ry/rx));
    outer.push(ellipsePt(cx,cy,rx,ry,a));
    inner.push(ellipsePt(cx,cy,inRx,inRy,a));
    dep.push((Math.sin(a)+1)/2); wt.push(t);
  }
  // optional pulsing red fire-glow halo straddling the blade (drawn first = behind)
  if (shimmerColor != null) {
    const sh = 0.5 + 0.5*(shimmer ?? 1);
    for (let i=1;i<=steps;i++){
      const d = (dep[i-1]+dep[i])/2, tt = (wt[i-1]+wt[i])/2;
      const mx = (outer[i-1].x+inner[i-1].x)/2, my = (outer[i-1].y+inner[i-1].y)/2;
      const nx = (outer[i].x+inner[i].x)/2, ny = (outer[i].y+inner[i].y)/2;
      g.lineStyle({ width: bandW*1.7*tt + bandW*0.5, color: shimmerColor, alpha: alpha*(0.10+0.32*sh)*(0.3+0.7*d)*tt, cap: "round", join: "round" });
      g.moveTo(mx, my); g.lineTo(nx, ny);
    }
  }
  // filled gold ribbon (per-quad alpha: depth dimming + fades toward the tail)
  for (let i=1;i<=steps;i++){
    const d = (dep[i-1]+dep[i])/2, tt = (wt[i-1]+wt[i])/2;
    const a = alpha * (0.35 + 0.65*d) * (0.25 + 0.75*tt);
    g.beginFill(gold, a);
    g.moveTo(outer[i-1].x, outer[i-1].y); g.lineTo(outer[i].x, outer[i].y);
    g.lineTo(inner[i].x, inner[i].y); g.lineTo(inner[i-1].x, inner[i-1].y);
    g.closePath(); g.endFill();
  }
  // crisp bright cutting edge along the OUTER arc (sharp, butt/miter — no round cap)
  for (let i=1;i<=steps;i++){
    const d = (dep[i-1]+dep[i])/2, tt = (wt[i-1]+wt[i])/2;
    g.lineStyle({ width: Math.max(1.5, bandW*0.12*tt), color: cream, alpha: alpha*(0.45+0.55*d)*tt, cap: "butt", join: "miter" });
    g.moveTo(outer[i-1].x, outer[i-1].y); g.lineTo(outer[i].x, outer[i].y);
  }
}

let casterHide = null;
try {
  const casterHome = caster ? { x: caster.center.x, y: caster.center.y } : { x: S2W(0.5,0.5).x, y: S2W(0.5,0.5).y };
  const sceneMid = S2W(cfg.centerX ?? 0.5, cfg.centerY ?? 0.5);

  // 1) move Centuaros to the middle of the scene
  casterHide = makeHider(caster);
  let clone = null;
  if (cfg.moveToCenter && caster) {
    casterHide.start();
    clone = makeSprite(caster, (sceneMid.x < casterHome.x) ? -1 : 1);
    clone.x = casterHome.x; clone.y = casterHome.y; clone.zIndex = 9200;
    stage.addChild(clone); spawned.push(clone);
    await tween((p) => { clone.x = casterHome.x + (sceneMid.x-casterHome.x)*p; clone.y = casterHome.y + (sceneMid.y-casterHome.y)*p; }, cfg.dashMs || 340, easeInOutCubic);
    clone.x = sceneMid.x; clone.y = sceneMid.y;
  }
  const casterPos = (cfg.moveToCenter && caster) ? { x: sceneMid.x, y: sceneMid.y } : casterHome;

  // A flattened ground-ring encircling the arena, centered on the caster and
  // dropped slightly so it reads as lying on the floor in perspective.
  const center = { x: casterPos.x, y: casterPos.y };
  const ringCx = center.x, ringCy = center.y + hPx(cfg.ringDropY ?? 0.06);
  const rx = wLen((cfg.ringRx ?? 0.44) * W);
  const ry = rx * (cfg.ringRatio ?? 0.30);
  const bandW = wLen(cfg.bandW ?? 14);
  const gold = cfg.color, cream = cfg.coreColor ?? 0xFFF6C0;
  const aStart = (cfg.startAngle ?? (-Math.PI/2));
  const dotTex = dotTexture(cream);

  async function oneSweep(isFinal) {
    const g = new PIXI.Graphics(); g.zIndex = 8800; g.blendMode = PIXI.BLEND_MODES.ADD;
    stage.addChild(g); spawned.push(g);
    playSfx(cfg.sfxSweep, cfg.sfxSweepVol);   // swing whoosh per sweep
    // bright sweep head travelling around the ring
    const head = new PIXI.Sprite(dotTex);
    head.anchor.set(0.5); head.zIndex = 8810; head.blendMode = PIXI.BLEND_MODES.ADD; head.tint = cream;
    head.width = head.height = bandW * 3.2;
    stage.addChild(head); spawned.push(head);

    let lastEmber = 0;
    await tween((p, raw) => {
      const swept = p * Math.PI * 2;
      const aEnd = aStart + swept;
      // trailSpan: the length of the bladed trail behind the head. Defaults to a
      // partial swoosh; clamp so it never exceeds what has been swept so far.
      const trail = Math.min(cfg.trailSpan ?? 2.4, Math.max(swept, 0.0001));
      const shimmer = Math.sin(performance.now() * (cfg.shimmerSpeed ?? 0.018));
      drawRingSlash(g, ringCx, ringCy, rx, ry, aEnd, trail, bandW, gold, cream, cfg.flashAlpha, cfg.taperPow, cfg.shimmerColor, shimmer);
      const hp = ellipsePt(ringCx, ringCy, rx, ry, aEnd);
      head.x = hp.x; head.y = hp.y;
      head.alpha = 0.5 + 0.5*((Math.sin(aEnd)+1)/2); // dim on the far side
      // spray embers off the sweep head as it whips around the ring
      const now = performance.now();
      if (now - lastEmber > (cfg.emberEveryMs ?? 18)) {
        lastEmber = now;
        const outAng = Math.atan2(hp.y - ringCy, hp.x - ringCx);
        for (let k = 0; k < (cfg.emberPerBurst ?? 3); k++) {
          const sp = new PIXI.Sprite(dotTex);
          sp.anchor.set(0.5); sp.zIndex = 8806; sp.blendMode = PIXI.BLEND_MODES.ADD;
          const rr = Math.random();
          sp.tint = cfg.emberColor2
            ? (rr < 0.34 ? cream : (rr < 0.67 ? gold : cfg.emberColor2))
            : (rr < 0.4 ? cream : gold);
          const sz = bandW * (0.3 + Math.random()*0.6); sp.width = sp.height = sz;
          sp.x = hp.x; sp.y = hp.y;
          stage.addChild(sp); spawned.push(sp);
          const jit = (Math.random()-0.5) * 1.6;
          const spd = wLen(cfg.emberSpread ?? 46) * (0.4 + Math.random());
          const vx = Math.cos(outAng + jit)*spd, vy = Math.sin(outAng + jit)*spd - wLen(24)*Math.random();
          tween((q) => { sp.x = hp.x + vx*q; sp.y = hp.y + vy*q; sp.alpha = 1 - q; sp.scale.set(1 - 0.5*q); }, cfg.emberMs ?? 420, easeOutCubic).then(() => destroyObj(sp));
        }
      }
      if (isFinal && !doneFired && raw >= 0.6) fireDone({ ok: true });
    }, cfg.sweepMs, easeOutQuart);
    destroyObj(head);

    // full ring closes -> flash brighter, then fade out
    await tween((p) => { g.alpha = 1 + Math.sin(p*Math.PI) * (cfg.closeFlash ?? 0.7); }, cfg.flashMs ?? 180, null);
    await tween((p) => { g.alpha = (1 - p); }, cfg.fadeMs, easeOutCubic);
    destroyObj(g);
  }

  for (let s = 0; s < cfg.sweeps; s++) {
    await oneSweep(s === cfg.sweeps - 1);
    if (s < cfg.sweeps - 1) await waitMs(cfg.betweenMs);
  }

  // Fiery Onslaught finisher: explosion + screenshake at center
  if (cfg.explosion) {
    screenShake(cfg.shakeMs, cfg.shakePx);
    playSfx(cfg.sfxExplosion, cfg.sfxExplosionVol);
    const vid = await loadVideo(A.explosion);
    const tex = PIXI.Texture.from(vid);
    const nativeW = tex.width || tex.orig?.width || 400;
    const spr = new PIXI.Sprite(tex);
    spr.anchor.set(0.5); spr.x = center.x; spr.y = center.y; spr.zIndex = cfg.explosionZ ?? 9600;
    spr.scale.set(hPx(cfg.explosionSize) / nativeW);
    stage.addChild(spr); spawned.push(spr);
    try { vid.currentTime = 0; await vid.play(); } catch (_) {}
    await new Promise((res) => { let done=false; const go=()=>{if(done)return;done=true;res();}; vid.addEventListener("ended",go,{once:true}); setTimeout(go, cfg.explosionMaxMs||1500); });
    await tween((p) => { spr.alpha = 1 - p; }, 220, easeOutCubic);
    destroyObj(spr);
    try { vid.pause(); vid.removeAttribute("src"); vid.load(); } catch (_) {}
  }

  fireDone({ ok: true });

  // 3) dash Centuaros back home, restore the real token
  if (cfg.moveToCenter && caster && clone) {
    clone.scale.x = Math.abs(clone.scale.x) * (Math.sign(clone.scale.x)||1) * ((casterHome.x < sceneMid.x) ? -1 : 1);
    await tween((p) => { clone.x = sceneMid.x + (casterHome.x-sceneMid.x)*p; clone.y = sceneMid.y + (casterHome.y-sceneMid.y)*p; }, cfg.dashBackMs || 300, easeInOutCubic);
    destroyObj(clone);
    casterHide.restore();
  }
  await waitMs(cfg.endPadMs);
  cleanupAll();
} catch (err) {
  console.error("[ONI][Pseudo][Sweep]", err);
  fireDone({ ok: false, error: String(err && err.message || err) });
} finally {
  try { casterHide && casterHide.restore(); } catch (_) {}
  cleanupAll();
}
`;

try {
  emitLocal("oni:animationStart", { type: ANIM_KEY, sceneId: canvas.scene?.id ?? null });
  const waitDone = onceHook(doneHook, CFG.totalTimeoutMs || 12000);
  await game.ONI.pseudo.play({
    scriptId: ANIM_KEY,
    scriptSource,
    casterTokenUuid: sourceToken?.document?.uuid ?? null,
    targetTokenUuids: partyTargets.map(t => t.document.uuid),
    params: { doneHook, cfg: CFG, assets: { explosion: EXPLOSION_URL } },
    meta: { source: CFG.name },
  });
  const result = await waitDone;
  if (!result?.ok) console.warn(TAG, "pseudo non-OK / timeout", result);
} catch (err) {
  console.error(TAG, "orchestration crashed", err);
} finally {
  emitLocal("oni:animationEnd", { type: ANIM_KEY, timestamp: Date.now() });
}

})();

