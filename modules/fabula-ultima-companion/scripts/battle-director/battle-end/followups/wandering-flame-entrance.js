// ⭐ Wandering Flame — bespoke DOM entrance animation.
//
// PLACEHOLDER. The boss plummets from the top of the screen and slams its
// spawn point with a fiery explosion + screenshake. This is intentionally
// hardcoded for one boss so it can ship for tonight's session without
// touching the data container. It is to be folded into a future data-driven
// entrance-animation system (no per-boss hardcoding) once that exists — keep
// it isolated here so the refactor is a delete + re-wire.
//
// Architecture mirrors the director's DOM VFX subsystems (damage-numbers /
// impact-fx): position:fixed elements projected onto each client's screen from
// the token's world center, broadcast over socketlib so every client sees the
// same beat. WAAPI (element.animate) drives the motion; no Sequencer.

import { log, warn } from "../../logger.js";

const MODULE_ID   = "fabula-ultima-companion";
const ACTION_PLAY = "FU_WF_ENTRANCE_PLAY";
const STYLE_ID    = "fud-wf-entrance-style";

// Impact SFX — played on every client at the moment the boss hits the ground.
const IMPACT_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_DOWNC.wav";

let _socket = null;

// Idempotent socket registration. Call once per client on boot `ready`.
export function initWanderingFlameEntrance() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("[WF-entrance] socketlib unavailable — entrance stays local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playEntranceLocal);
    log("[WF-entrance] socket registered");
  } catch (e) { warn("[WF-entrance] init failed", e); }
}

// GM-side entry, invoked by the in-place reinforce init (payload.followup.entrance).
// Renders locally + broadcasts to all other clients. Resolves when the LOCAL
// impact lands so the init can continue (reveal token, build dCombat).
export async function playWanderingFlameEntrance({ tokens = [], scene = null } = {}) {
  const token   = Array.isArray(tokens) ? tokens[0] : tokens;
  const tokenId = token?.id ?? null;
  const sceneId = scene?.id ?? token?.parent?.id ?? canvas?.scene?.id ?? null;
  const src     = String(
    token?.texture?.src ??
    token?.actor?.system?.props?.sprite_battle ??
    ""
  ).trim();
  // Mirror the token's horizontal flip so the falling sprite faces the same way
  // as the placed token (enemy tokens spawn mirrored via texture.scaleX < 0).
  const sx    = Number(token?.texture?.scaleX);
  const flipX = Number.isFinite(sx) ? sx < 0 : false;
  const payload = { sceneId, tokenId, src, flipX };

  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("[WF-entrance] broadcast failed", e); }

  try { await playEntranceLocal(payload); }
  catch (e) { warn("[WF-entrance] local play threw", e); }
}

// ─── Local render (runs on every client) ─────────────────────────────────

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
@keyframes fud-wf-shake {
  0%,100% { transform: translate(0,0); }
  10% { transform: translate(-9px, 7px); }
  20% { transform: translate(8px,-6px); }
  30% { transform: translate(-7px,-8px); }
  40% { transform: translate(7px, 7px); }
  50% { transform: translate(-6px, 5px); }
  60% { transform: translate(6px,-5px); }
  70% { transform: translate(-4px, 4px); }
  80% { transform: translate(4px, 3px); }
  90% { transform: translate(-2px,-2px); }
}
.fud-wf-shake { animation: fud-wf-shake 0.6s cubic-bezier(.36,.07,.19,.97) both; }
.fud-wf-faller {
  position: fixed; z-index: 99990; pointer-events: none;
  transform: translate(-50%, -50%);
  will-change: transform, top;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
  filter: drop-shadow(0 0 20px rgba(255,120,20,0.9));
}
.fud-wf-burst {
  position: fixed; z-index: 99989; pointer-events: none;
  border-radius: 50%;
  background: radial-gradient(circle,
    rgba(255,248,210,1) 0%,
    rgba(255,165,45,0.96) 26%,
    rgba(255,72,0,0.88) 50%,
    rgba(120,20,0,0) 72%);
  mix-blend-mode: screen; opacity: 0;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// World point → client (screen) coords. Mirrors impact-fx / damage-numbers.
function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

function isVideo(src) { return /\.(webm|mp4|m4v|mov)$/i.test(String(src ?? "")); }

// Wait until the media element actually has a decoded first frame, so the fall
// never plays on an empty element. This is the fix for the inconsistent
// "boss just appears at the spot" behavior: on an uncached sprite the WAAPI
// motion ran while the <img>/<video> had no pixels yet, so all you saw was the
// final pop-in. Resolves on ready / error / hard timeout.
function awaitMediaReady(el, isVid, timeoutMs = 2500) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    try {
      if (isVid) {
        if (el.readyState >= 2) return fin(); // HAVE_CURRENT_DATA
        el.addEventListener("loadeddata", fin, { once: true });
        el.addEventListener("canplay",    fin, { once: true });
        el.addEventListener("error",      fin, { once: true });
      } else {
        if (el.complete && el.naturalWidth > 0) return fin();
        if (typeof el.decode === "function") { el.decode().then(fin).catch(fin); }
        el.addEventListener("load",  fin, { once: true });
        el.addEventListener("error", fin, { once: true });
      }
    } catch { return fin(); }
    setTimeout(fin, timeoutMs);
  });
}

// On-screen sprite size in WORLD px (pre-zoom), matching Foundry's token
// render. Prefers the live mesh (exact); otherwise reproduces the fit + scale
// math from the document + the texture's native dimensions. Verified against
// the WF probe: native 240×348, "contain" into a 110×110 frame (×0.3161),
// then texture scale ×2.56 → 194.2 × 281.6 (== mesh_width/height).
function spriteWorldSize(token, naturalW, naturalH) {
  const mw = Math.abs(Number(token?.mesh?.width));
  const mh = Math.abs(Number(token?.mesh?.height));
  if (Number.isFinite(mw) && mw > 20 && Number.isFinite(mh) && mh > 20) return { w: mw, h: mh };

  const grid   = canvas?.scene?.grid?.size ?? 100;
  const doc    = token?.document ?? token ?? {};
  const frameW = (Number(doc.width)  || 1) * grid;
  const frameH = (Number(doc.height) || 1) * grid;
  const nW = Number(naturalW) || frameW;
  const nH = Number(naturalH) || frameH;
  const sx = Math.abs(Number(doc.texture?.scaleX) || 1) || 1;
  const sy = Math.abs(Number(doc.texture?.scaleY) || 1) || 1;
  const fit = String(doc.texture?.fit ?? "contain");

  let fs;
  if (fit === "cover")       fs = Math.max(frameW / nW, frameH / nH);
  else if (fit === "width")  fs = frameW / nW;
  else if (fit === "height") fs = frameH / nH;
  else if (fit === "fill")   return { w: frameW * sx, h: frameH * sy };
  else                       fs = Math.min(frameW / nW, frameH / nH); // contain (default)
  return { w: nW * fs * sx, h: nH * fs * sy };
}

// Returns a Promise that resolves at IMPACT (the fall finishing). The
// explosion + screenshake + faller fade-out run after the resolve.
export function playEntranceLocal(opts = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    runEntrance(opts, done).catch((e) => { warn("[WF-entrance] runEntrance threw", e); done(); });
  });
}

async function runEntrance({ sceneId, tokenId, src, flipX = false } = {}, done) {
  if (typeof PIXI === "undefined" || !canvas?.ready) { done(); return; }
  // Only animate on clients currently viewing the boss's scene.
  if (sceneId && canvas.scene?.id !== sceneId) { done(); return; }
  ensureStyle();

  const token = tokenId ? canvas.tokens?.get?.(tokenId) : null;
  let target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const zoom = canvas.stage?.scale?.x ?? 1;
  if (token && !token.destroyed) {
    const c = token.center ?? {
      x: (token.x ?? 0) + (token.w ?? 100) / 2,
      y: (token.y ?? 0) + (token.h ?? 100) / 2,
    };
    target = worldToClient(c.x, c.y);
  }

  const FALL_MS = 640;
  const flipStr = flipX ? " scaleX(-1)" : "";
  const isVid   = isVideo(src);

  const faller = isVid ? document.createElement("video") : document.createElement("img");
  faller.className = "fud-wf-faller";
  if (isVid) { faller.muted = true; faller.autoplay = true; faller.loop = true; faller.playsInline = true; faller.preload = "auto"; }
  faller.style.left    = `${target.x}px`;
  faller.style.opacity = "0"; // hidden until decoded + sized
  if (src) faller.src = src;
  document.body.appendChild(faller);
  try { faller.play?.()?.catch?.(() => {}); } catch {}

  // Don't start the fall until the sprite has real pixels — consistency fix.
  await awaitMediaReady(faller, isVid);
  if (!document.body.contains(faller)) { done(); return; }

  // Size to match the rendered token sprite, now that native dims are known.
  const natW = isVid ? faller.videoWidth  : faller.naturalWidth;
  const natH = isVid ? faller.videoHeight : faller.naturalHeight;
  const size = spriteWorldSize(token, natW, natH);
  const footprintPx = Math.max(48, size.w * zoom);
  const startY = -footprintPx - 40; // start above the top edge

  faller.style.width   = `${footprintPx}px`;
  faller.style.height  = "auto"; // native aspect == the contained sprite's aspect
  faller.style.top     = `${startY}px`;
  faller.style.opacity = "1";

  // Accelerating (ease-in) plummet.
  const anim = faller.animate(
    [
      { top: `${startY}px`,  transform: `translate(-50%,-50%)${flipStr} rotate(-6deg)` },
      { top: `${target.y}px`, transform: `translate(-50%,-50%)${flipStr} rotate(4deg)` },
    ],
    { duration: FALL_MS, easing: "cubic-bezier(0.55,0,1,0.45)", fill: "forwards" }
  );

  const onImpact = () => {
        // Fiery explosion.
        try {
          const burst = document.createElement("div");
          burst.className = "fud-wf-burst";
          const burstPx = footprintPx * 2.4;
          burst.style.left   = `${target.x}px`;
          burst.style.top    = `${target.y}px`;
          burst.style.width  = `${burstPx}px`;
          burst.style.height = `${burstPx}px`;
          document.body.appendChild(burst);
          const b = burst.animate(
            [
              { transform: "translate(-50%,-50%) scale(0.2)", opacity: 0 },
              { transform: "translate(-50%,-50%) scale(0.95)", opacity: 1, offset: 0.25 },
              { transform: "translate(-50%,-50%) scale(1.7)", opacity: 0 },
            ],
            { duration: 640, easing: "ease-out", fill: "forwards" }
          );
          b?.addEventListener?.("finish", () => { try { burst.remove(); } catch {} });
          setTimeout(() => { try { burst.remove(); } catch {} }, 1000);
        } catch (e) { warn("[WF-entrance] burst threw", e); }

        // Screenshake on the canvas board.
        try {
          const board = canvas.app?.view ?? document.getElementById("board");
          if (board) {
            board.classList.remove("fud-wf-shake");
            void board.offsetWidth; // reflow to restart
            board.classList.add("fud-wf-shake");
            setTimeout(() => { try { board.classList.remove("fud-wf-shake"); } catch {} }, 700);
          }
        } catch (e) { warn("[WF-entrance] shake threw", e); }

        // Optional impact SFX (best-effort).
        if (IMPACT_SFX) {
          try { foundry.audio?.AudioHelper?.play?.({ src: IMPACT_SFX, volume: 0.8, autoplay: true, loop: false }, false); }
          catch {}
        }

        // Fade the faller out — the real animated token takes over underneath.
        try {
          const f = faller.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: "forwards" });
          f?.addEventListener?.("finish", () => { try { faller.remove(); } catch {} });
          setTimeout(() => { try { faller.remove(); } catch {} }, 450);
        } catch { try { faller.remove(); } catch {} }

        done();
      };

      let fired = false;
      const fireOnce = () => { if (fired) return; fired = true; onImpact(); };
      anim?.addEventListener?.("finish", fireOnce);
      setTimeout(fireOnce, FALL_MS + 90); // safety net if WAAPI finish doesn't fire
}
