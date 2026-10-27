// status-cues.js — the token visual cues of the token status plan "G + E"
// (phase 6; approved look in claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX).
//
// In a battle a token shows NO effect icons; a status shows on the token only
// through its own cue (status-classifier.js STATUS_CUES):
//
//   burn      flames rising off the body, warm underlight at the feet   + warm wash
//   blind     smoky black fog over the eyes, wisps curling off (FF9 Darkness)
//   poison    green bubbles rising and popping (Poisoned, Envenomed)  + green wash
//   wet       drops falling from the head and shoulders, ripples at the feet + cool wash
//   paralyze  yellow sparks crackling around the body                 + pale-yellow wash
//   silence   speech bubble beside the head with "…" filling in
//   provoked  throbbing red anger vein at the temple (taunts too)
//   sleep     three Zs drifting up from the head
//
// Everything else draws nothing: the HUD pips, the unit label and the pop text
// carry it (see the fallback rules on the mockup page).
//
// HOW
//   - Particles / marks: one DOM layer per token, docked every frame to the
//     RENDERED sprite rect (unit-anchors.js), the same pattern as brand-mark /
//     aspect-aura. Rebuilt only when the cue set changes or the sprite's size
//     changes by more than 8% (zoom).
//   - Washes: token-tint.js does the body tint (it already composes with the
//     document tint, fades, survives F5 and clones into cinematics); this module
//     registers itself as its status tint provider. An AE with its own
//     tokenTint flag still wins.
//   - Head point: top-centre of the sprite, eyes at 15% of its height. A
//     creature whose head is elsewhere (a quadruped) can carry an actor flag
//     flags.fabula-ultima-companion.cueHead = { x, y } in 0..1 of the sprite
//     as drawn facing right; mirrored tokens flip x.
//   - Hidden during action cinematics with the brand marks
//     ("fuBattleMarksHidden"), and outside battle.
//
// Per client, display only: no socket, no document writes.
//
// Not done (v1): stopping the idle bounce while Paralyzed (the idle API has
// no local pause yet); depth — the layer sits above every sprite, so a back
// unit's flames can draw over a front unit.

import { log, warn } from "./logger.js";
import { cueOf } from "./status-classifier.js";
import { battleActive } from "./battle-focus.js";
import { spriteRect } from "./unit-anchors.js";
import { setStatusTintProvider, syncActorTint } from "./token-tint.js";

const NS = "fabula-ultima-companion";
const ROOT_ID = "fu-status-cue-root";
const STYLE_ID = "fu-status-cue-style";
const REF_H = 250;                 // the sprite height the particle sizes were tuned at
const EYE_Y = 0.15;

// Body washes (multiply, 0..1 strength). One per token: first in this order wins.
const WASH_ORDER = ["burn", "poison", "wet", "paralyze"];
const WASH = {
  burn: { color: "#ffc993", strength: 0.35 },
  poison: { color: "#a6e58a", strength: 0.42 },
  wet: { color: "#a9c9ff", strength: 0.38 },
  paralyze: { color: "#fff0a6", strength: 0.3 },
};

const S = { recs: new Map(), ticker: null, hidden: false };   // tokenId -> { el, sig, w, h }

const SMOKE = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><filter id="s" x="0" y="0" width="120" height="120" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="4" seed="11" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0.05  0 0 0 0 0.03  0 0 0 0 0.09  2.6 0 0 0 -0.7"/></filter><rect width="120" height="120" filter="url(#s)"/></svg>`);

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#${ROOT_ID} { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: var(--z-index-canvas, 0); }
.fu-cue { position: absolute; left: 0; top: 0; pointer-events: none; transition: opacity 250ms ease; }
.fu-cue.is-anim-hidden { opacity: 0 !important; }
.fu-cue i, .fu-cue b, .fu-cue svg, .fu-cue span { position: absolute; display: block; }
/* burn */
.fu-cue .fl { width: var(--s); height: calc(var(--s) * 1.5); margin-left: calc(var(--s) * -.5); border-radius: 50% 50% 42% 42% / 66% 66% 34% 34%;
  background: radial-gradient(ellipse at 50% 70%, #fffbe0 0, #ffe06a 20%, #ff9a2a 45%, rgba(255,80,10,.85) 60%, rgba(255,60,0,0) 74%);
  filter: drop-shadow(0 0 4px rgba(255,120,20,.9)); opacity: 0; animation: fuCueFlame 1.1s ease-out infinite; }
.fu-cue .gl { left: 8%; right: 8%; bottom: 1%; height: 13%; border-radius: 50%;
  background: radial-gradient(ellipse, rgba(255,150,40,.7), rgba(255,90,0,0) 70%); animation: fuCueFlick .45s steps(2) infinite alternate; }
@keyframes fuCueFlame { 0% { transform: translateY(0) scale(.7); opacity: 0; } 14% { opacity: 1; } 100% { transform: translateY(var(--rise)) scale(.15); opacity: 0; } }
@keyframes fuCueFlick { to { opacity: .55; } }
/* poison */
.fu-cue .bb { width: var(--s); height: var(--s); margin-left: calc(var(--s) * -.5); border-radius: 50%; border: 1.5px solid rgba(175,255,120,.95);
  background: radial-gradient(circle at 34% 30%, rgba(255,255,255,.9) 0 12%, rgba(120,230,80,.38) 30%, rgba(60,170,40,.16) 70%);
  box-shadow: 0 0 6px rgba(120,255,80,.6); opacity: 0; animation: fuCueBub 2.2s ease-in infinite; }
@keyframes fuCueBub { 0% { transform: translate(0,0) scale(.4); opacity: 0; } 15% { opacity: 1; }
  80% { transform: translate(var(--w), var(--rise)) scale(1); opacity: 1; } 90% { transform: translate(var(--w), var(--rise)) scale(1.45); opacity: .55; }
  100% { transform: translate(var(--w), var(--rise)) scale(1.7); opacity: 0; } }
/* wet */
.fu-cue .dr { width: calc(4px * var(--k)); height: calc(7px * var(--k)); margin-left: calc(-2px * var(--k));
  border-radius: 50% 50% 50% 50% / 65% 65% 35% 35%; background: linear-gradient(#eef8ff, #5fb2ff);
  box-shadow: 0 0 2px rgba(60,140,255,.85); opacity: 0; animation: fuCueDrip 1.4s cubic-bezier(.55,0,1,.6) infinite; }
.fu-cue .rp { bottom: 3%; width: calc(26px * var(--k)); height: calc(8px * var(--k)); margin-left: calc(-13px * var(--k));
  border-radius: 50%; border: 1.5px solid rgba(150,205,255,.85); opacity: 0; animation: fuCueRipple 1.4s ease-out infinite; }
@keyframes fuCueDrip { 0% { transform: translateY(0) scaleY(.5); opacity: 0; } 12% { opacity: 1; transform: translateY(0) scaleY(1); }
  30% { transform: translateY(3px); } 94% { opacity: .95; } 100% { transform: translateY(var(--f)); opacity: 0; } }
@keyframes fuCueRipple { 0% { transform: scale(.3); opacity: 0; } 20% { opacity: .9; } 100% { transform: scale(1.5); opacity: 0; } }
/* paralyze */
.fu-cue .zp { width: calc(18px * var(--k)); height: calc(28px * var(--k)); overflow: visible; opacity: 0; animation: fuCueZap 1.6s steps(1) infinite;
  filter: drop-shadow(0 0 2px #ffe94a) drop-shadow(0 0 6px #ffb800); }
.fu-cue .zp polyline { fill: none; stroke: #fffbd0; stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
@keyframes fuCueZap { 0% { opacity: 0; } 8% { opacity: 1; } 13% { opacity: 0; } 17% { opacity: 1; } 22% { opacity: 0; } 100% { opacity: 0; } }
/* blind */
.fu-cue .bl { width: 0; height: 0; }
.fu-cue .bl .sm { left: calc(-42px * var(--k)); top: calc(-21px * var(--k)); width: calc(84px * var(--k)); height: calc(42px * var(--k));
  background: url("${SMOKE}") 0 0 / calc(120px * var(--k)) calc(120px * var(--k)) repeat;
  -webkit-mask: radial-gradient(ellipse 50% 50% at 50% 50%, #000 32%, rgba(0,0,0,.55) 58%, rgba(0,0,0,0) 78%);
  mask: radial-gradient(ellipse 50% 50% at 50% 50%, #000 32%, rgba(0,0,0,.55) 58%, rgba(0,0,0,0) 78%); filter: blur(1px); animation: fuCueSmoke 6s linear infinite; }
.fu-cue .bl .sm.b2 { opacity: .9; animation: fuCueSmoke2 4.4s linear infinite; }
.fu-cue .bl .core { left: calc(-26px * var(--k)); top: calc(-9px * var(--k)); width: calc(52px * var(--k)); height: calc(18px * var(--k));
  border-radius: 50%; background: rgba(10,6,18,.8); filter: blur(4px); animation: fuCueHaze 3s ease-in-out infinite; }
.fu-cue .bl .wisp { width: calc(16px * var(--k)); height: calc(16px * var(--k)); margin: calc(-8px * var(--k)); border-radius: 50%;
  background: radial-gradient(circle, rgba(16,10,26,.8), rgba(16,10,26,0) 70%); filter: blur(2px); opacity: 0; animation: fuCueWisp 2.8s ease-out infinite; }
@keyframes fuCueSmoke { from { background-position: 0 0; } to { background-position: calc(120px * var(--k)) calc(-40px * var(--k)); } }
@keyframes fuCueSmoke2 { from { background-position: 0 0; } to { background-position: calc(-84px * var(--k)) calc(-28px * var(--k)); } }
@keyframes fuCueHaze { 50% { transform: scale(1.1, 1.08); opacity: .85; } }
@keyframes fuCueWisp { 0% { opacity: 0; transform: translate(0,0) scale(.6); } 25% { opacity: .9; } 100% { opacity: 0; transform: translate(var(--dx), calc(-28px * var(--k))) scale(1.9); } }
/* silence */
.fu-cue .sil { width: calc(40px * var(--k)); height: calc(24px * var(--k)); border-radius: calc(12px * var(--k)); background: #fffdf6; border: 2px solid #3a3228;
  box-shadow: 0 2px 4px rgba(0,0,0,.35); display: flex !important; align-items: center; justify-content: center; gap: calc(4px * var(--k)); animation: fuCueBob 2.2s ease-in-out infinite; }
.fu-cue .sil::before { content: ""; position: absolute; left: 6px; bottom: -9px; border: 6px solid transparent; border-top: 9px solid #3a3228; border-bottom: 0; transform: skewX(28deg); }
.fu-cue .sil::after { content: ""; position: absolute; left: 8px; bottom: -5px; border: 4px solid transparent; border-top: 6px solid #fffdf6; border-bottom: 0; transform: skewX(28deg); }
.fu-cue .sil i { position: static; width: calc(5px * var(--k)); height: calc(5px * var(--k)); border-radius: 50%; background: #3a3228; opacity: .15; animation: fuCueDot 1.5s steps(1) infinite; }
.fu-cue .sil i:nth-child(2) { animation-delay: .25s; } .fu-cue .sil i:nth-child(3) { animation-delay: .5s; }
@keyframes fuCueDot { 0% { opacity: .15; } 20% { opacity: 1; } 85% { opacity: 1; } 100% { opacity: .15; } }
@keyframes fuCueBob { 50% { transform: translateY(-2px); } }
/* provoked */
.fu-cue .vein { width: calc(24px * var(--k)); height: calc(24px * var(--k)); margin: calc(-12px * var(--k)); overflow: visible;
  filter: drop-shadow(0 0 1.5px #fff) drop-shadow(0 1px 1px rgba(0,0,0,.4)); animation: fuCueThrob .9s ease-in-out infinite; }
.fu-cue .vein path { fill: none; stroke: #e8241c; stroke-width: 3.4; stroke-linecap: round; }
@keyframes fuCueThrob { 0%, 100% { transform: scale(1); } 12% { transform: scale(1.28); } 24% { transform: scale(.95); } 36% { transform: scale(1.15); } }
/* sleep */
.fu-cue .zz b { left: 0; top: 0; font: 900 var(--z) "Signika", sans-serif; color: #eef3ff; opacity: 0; animation: fuCueZ 2.4s ease-out infinite;
  text-shadow: 1px 0 0 #34407a, -1px 0 0 #34407a, 0 1px 0 #34407a, 0 -1px 0 #34407a, 0 0 4px rgba(52,64,122,.7); }
@keyframes fuCueZ { 0% { opacity: 0; transform: translate(0,0) rotate(-8deg) scale(.6); } 20% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(26px * var(--k)), calc(-38px * var(--k))) rotate(10deg) scale(1.15); } }
@media (prefers-reduced-motion: reduce) { .fu-cue * { animation-play-state: paused !important; } }
`;
  document.head.appendChild(st);
}

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) { root = document.createElement("div"); root.id = ROOT_ID; document.body.appendChild(root); }
  return root;
}

// Deterministic per token so a rebuild does not reshuffle the particles.
function rng(seed) {
  let s = 7;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const px = (v) => `${Math.round(v)}px`;

/** The cue ids active on an actor (deduped; Poisoned + Envenomed share one). */
export function cuesOf(actor) {
  const out = new Set();
  try {
    for (const e of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (e?.disabled) continue;
      const c = cueOf(e);
      if (c) out.add(c);
    }
  } catch { /* */ }
  return out;
}

function headFrac(token) {
  let x = 0.5, y = EYE_Y;
  try {
    const f = token.actor?.getFlag?.(NS, "cueHead") ?? token.actor?.flags?.[NS]?.cueHead;
    if (f && Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y))) { x = Number(f.x); y = Number(f.y); }
  } catch { /* */ }
  if ((token.mesh?.scale?.x ?? 1) < 0) x = 1 - x;
  return { x, y };
}

function cueHTML(token, cues, w, H) {
  const k = H / REF_H;
  const id = token.id;
  const hd = headFrac(token);
  const hx = w * hd.x, hy = H * hd.y;
  let h = "";
  let r, d;
  if (cues.has("burn")) {
    r = rng(id + "b");
    h += `<i class="gl"></i>`;
    for (let i = 0; i < 10; i++) {
      d = 0.9 + r() * 0.6;
      h += `<i class="fl" style="left:${px(w * (0.22 + r() * 0.56))};bottom:${px(H * (0.06 + r() * 0.5))};--s:${px((13 + r() * 11) * k)};--rise:${px(-74 * k)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("poison")) {
    r = rng(id + "p");
    for (let i = 0; i < 8; i++) {
      d = 1.8 + r() * 0.9;
      h += `<i class="bb" style="left:${px(w * (0.2 + r() * 0.6))};bottom:${px(H * (0.14 + r() * 0.46))};--s:${px((6 + r() * 6) * k)};--w:${px((r() * 14 - 7) * k)};--rise:${px(-50 * k)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("wet")) {
    r = rng(id + "w");
    for (let i = 0; i < 8; i++) {
      d = 1.1 + r() * 0.7;
      const top = H * (hd.y + 0.04 + r() * 0.26);
      h += `<i class="dr" style="left:${px(w * (0.28 + r() * 0.44))};top:${px(top)};--f:${px(H * 0.93 - top)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
    for (let i = 0; i < 2; i++) {
      d = 1.3 + r() * 0.4;
      h += `<i class="rp" style="left:${px(w * (0.35 + r() * 0.3))};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("paralyze")) {
    r = rng(id + "z");
    const pts = ["10,0 3,12 11,14 5,28", "8,0 13,10 5,15 12,28", "11,0 4,9 12,13 3,20 9,28"];
    for (let i = 0; i < 6; i++) {
      d = 1.2 + r() * 1.0;
      h += `<svg class="zp" viewBox="0 0 18 28" style="left:${px(w * (0.08 + r() * 0.72))};top:${px(H * (0.12 + r() * 0.6))};transform:rotate(${Math.round(r() * 70 - 35)}deg);animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"><polyline points="${pts[i % 3]}"/></svg>`;
    }
  }
  if (cues.has("blind")) {
    const wp = [[-24, -4, -10, 0], [22, -6, 12, -0.9], [-8, -12, -6, -1.7], [12, 0, 8, -2.3]];
    h += `<span class="bl" style="left:${px(hx)};top:${px(hy)}"><i class="core"></i><i class="sm"></i><i class="sm b2"></i>`
      + wp.map((p) => `<i class="wisp" style="left:${px(p[0] * k)};top:${px(p[1] * k)};--dx:${px(p[2] * k)};animation-delay:${p[3]}s"></i>`).join("")
      + `</span>`;
  }
  if (cues.has("silence")) h += `<span class="sil" style="left:${px(hx + 12 * k)};top:${px(hy - 50 * k)}"><i></i><i></i><i></i></span>`;
  if (cues.has("provoked")) {
    h += `<svg class="vein" viewBox="0 0 24 24" style="left:${px(hx - w * 0.18)};top:${px(hy - 16 * k)}"><path d="M9 3 Q9 9 3 9"/><path d="M15 3 Q15 9 21 9"/><path d="M9 21 Q9 15 3 15"/><path d="M15 21 Q15 15 21 15"/></svg>`;
  }
  if (cues.has("sleep")) {
    h += `<span class="zz" style="left:${px(hx + 8 * k)};top:${px(hy - 22 * k)}">`
      + [0, 1, 2].map((i) => `<b style="--z:${px((12 + i * 5) * k)};animation-delay:-${(i * 0.8).toFixed(1)}s">Z</b>`).join("")
      + `</span>`;
  }
  return h;
}

function wants(token) { return !!(battleActive() && token?.actor && !token.destroyed); }

function drop(id) { const r = S.recs.get(id); if (r) { r.el.remove(); S.recs.delete(id); } }

/** (Re)build one token's cue layer. */
export function renderCues(token) {
  if (!token) return;
  const cues = wants(token) ? cuesOf(token.actor) : new Set();
  if (!cues.size) { drop(token.id); return; }
  const rect = spriteRect(token);
  if (!rect) return;
  const sig = [...cues].sort().join(",");
  let rec = S.recs.get(token.id);
  if (!rec) {
    const el = document.createElement("div");
    el.className = "fu-cue";
    if (S.hidden) el.classList.add("is-anim-hidden");
    ensureRoot().appendChild(el);
    rec = { el, sig: "", w: 0, h: 0 };
    S.recs.set(token.id, rec);
  }
  if (rec.sig !== sig || Math.abs(rect.height - rec.h) > rec.h * 0.08 || Math.abs(rect.width - rec.w) > rec.w * 0.08) {
    rec.el.style.setProperty("--k", (rect.height / REF_H).toFixed(3));
    rec.el.innerHTML = cueHTML(token, cues, rect.width, rect.height);
    rec.sig = sig; rec.w = rect.width; rec.h = rect.height;
  }
  place(token, rec, rect);
}

function shown(token) {
  return token.visible && token.renderable !== false && (token.mesh?.alpha ?? 1) > 0.05 && (token.mesh?.worldAlpha ?? 1) > 0.05;
}

function place(token, rec, rect = spriteRect(token)) {
  if (!rect || !shown(token)) { rec.el.style.display = "none"; return; }
  rec.el.style.display = "";
  rec.el.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
  rec.el.style.width = `${Math.round(rect.width)}px`;
  rec.el.style.height = `${Math.round(rect.height)}px`;
  // Zoom changed the sprite size enough → rebuild at the new scale.
  if (Math.abs(rect.height - rec.h) > rec.h * 0.08 || Math.abs(rect.width - rec.w) > rec.w * 0.08) renderCues(token);
}

function tick() {
  if (!S.recs.size) return;
  for (const [id, rec] of S.recs) {
    const t = canvas?.tokens?.get(id);
    if (!t) { drop(id); continue; }
    place(t, rec);
  }
}

export function renderAllCues() {
  ensureStyles();
  const live = new Set();
  for (const t of canvas?.tokens?.placeables ?? []) { live.add(t.id); renderCues(t); syncTint(t.actor); }
  for (const id of [...S.recs.keys()]) if (!live.has(id)) drop(id);
}

// Wash: the first cue in WASH_ORDER that the actor carries, in battle only.
function statusTint(actor) {
  if (!battleActive() || !actor) return null;
  const cues = cuesOf(actor);
  for (const c of WASH_ORDER) {
    if (!cues.has(c)) continue;
    const w = WASH[c];
    const col = foundry.utils.Color.from(w.color);
    return { color: [col.r, col.g, col.b], strength: w.strength, mode: "multiply", target: "bearer", applierActorUuid: null };
  }
  return null;
}
function syncTint(actor) { try { if (actor) syncActorTint(actor); } catch (e) { warn("[StatusCues] tint sync failed", e); } }

function setHidden(hidden) {
  S.hidden = !!hidden;
  for (const rec of S.recs.values()) rec.el.classList.toggle("is-anim-hidden", S.hidden);
}

function actorOfEffect(eff) {
  const p = eff?.parent;
  return p?.documentName === "Actor" ? p : p?.parent?.documentName === "Actor" ? p.parent : null;
}

export function initStatusCues() {
  setStatusTintProvider(statusTint);
  const onAE = (eff) => {
    const actor = actorOfEffect(eff);
    if (!actor) return;
    for (const t of actor.getActiveTokens?.(false, false) ?? []) renderCues(t);
    syncTint(actor);
  };
  Hooks.on("createActiveEffect", onAE);
  Hooks.on("updateActiveEffect", onAE);
  Hooks.on("deleteActiveEffect", onAE);
  Hooks.on("createToken", (doc) => setTimeout(() => { renderCues(doc?.object); syncTint(doc?.object?.actor); }, 0));
  Hooks.on("deleteToken", (doc) => drop(doc?.id));
  Hooks.on("canvasTearDown", () => { for (const id of [...S.recs.keys()]) drop(id); });
  Hooks.on("canvasReady", () => {
    if (S.ticker) { try { canvas.app.ticker.remove(S.ticker); } catch { /* */ } }
    S.ticker = tick; canvas.app.ticker.add(S.ticker);
    renderAllCues();
  });
  Hooks.on("fuBattleFocusChanged", () => renderAllCues());
  Hooks.on("fuBattleMarksHidden", (hidden) => setHidden(hidden));
  if (canvas?.ready) { S.ticker = tick; canvas.app.ticker.add(S.ticker); renderAllCues(); }
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.statusCues = { renderAll: renderAllCues, cuesOf, count: () => S.recs.size };
  log("[StatusCues] ready");
}
