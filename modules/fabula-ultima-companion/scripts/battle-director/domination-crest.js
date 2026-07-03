// Dominance Crest — floating boss emblem showing banked Dominance Point(s).
//
// A small socket-and-gem crest hovering above a boss token's RENDERED sprite:
// one diamond socket per point of cap, dark inset when empty, ignited
// red-orange gem (slow ember pulse) when banked. JRPG boost-pip vibes
// (Octopath boost / FFXIII stagger gem) — players read at a glance whether
// the boss is holding its Domination charge.
//
// VISIBILITY CONTRACT: every BOSS token shows the crest at all times — an
// empty socket advertises "this monster has the Domination mechanic" (it is
// not supposed to be a surprise). The gem lights when the pool AE holds a
// charge; gaining one plays a white GLEAM ignition + a decide-cursor cue.
//
// POSITIONING: token appearance data varies wildly (scale 2.56, off-center
// anchors, Contain fit, mirroring — see Wandering Flame), so the crest
// anchors off `token.mesh.getBounds()` — the actual rendered sprite's
// screen-space rectangle — NOT the token's nominal grid bounds. Centered
// horizontally on the sprite, floating just above its top edge, re-measured
// every frame so pan/zoom/scale/anchor changes all track for free.
//
// Z-ORDER: z-index 60 — above the canvas (#board z0) and token HUD (#hud z1),
// BELOW Foundry app windows (sheets/config start at z~100 and climb), so an
// open character sheet always covers the crest. Probed live 2026-07-02.
//
// Fully AE-replication-driven, like the Domination outline shimmer: the pool
// AE replicates to every client, so each client renders its own crest off
// createActiveEffect / updateActiveEffect / deleteActiveEffect hooks — zero
// socket traffic, F5-safe via the canvasReady rescan. The gain SFX also fires
// per-client from the same replicated update (no broadcast needed).

import { log, warn } from "./logger.js";
import { findDominancePointAe, actorIsBoss, DOMINANCE_POINT_CAP } from "./domination.js";
import { playSfx } from "./director-sfx.js";

const FLAG_NS = "fabula-ultima-companion";
const STYLE_ID = "fud-dominance-crest-style";

// Above canvas/#hud, below Foundry app windows (z >= 100). See header note.
const CREST_Z_INDEX = 60;

export const DOMINANCE_GAIN_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Cursor_Decide1.wav";

const _crests = new Map(); // tokenId -> { el, gems: HTMLElement[], lastCharges, missingFrames }
let _tickerOn = false;
let _hooksOn = false;
let _socket = null;
// Cinematic hide (ANIMATION state). Defaults visible on every fresh module
// load, so a mid-animation F5 can never strand hidden crests.
let _hiddenByAnimation = false;

const ACTION_CREST_VIS = "FU_DOMINANCE_CREST_VIS";

// Local apply — runs on every client (socket handler + GM local call).
export function setCrestsHiddenLocal(hidden) {
  _hiddenByAnimation = !!hidden;
  for (const rec of _crests.values()) {
    try { rec.el.classList.toggle("is-anim-hidden", _hiddenByAnimation); } catch {}
  }
}

// GM-side emit — hide/show the crests on ALL clients while an action
// animation plays. Called from the FSM's ANIMATION state (director-owning GM
// only, so dual-GM setups never double-fire).
export function emitCrestsHidden(hidden) {
  try { setCrestsHiddenLocal(hidden); }
  catch (e) { warn("emitCrestsHidden: local apply threw", e); }
  try { _socket?.executeForOthers?.(ACTION_CREST_VIS, !!hidden); }
  catch (e) { warn("emitCrestsHidden: broadcast failed", e); }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.fud-dom-crest {
  position: fixed; display: flex; gap: 7px; align-items: center;
  transform: translate(-50%, -100%);
  z-index: ${CREST_Z_INDEX}; pointer-events: none;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.55));
  transition: opacity .3s ease;
}
/* JRPG cinematic etiquette — crests fade out while an action animation plays
   (FSM ANIMATION state, broadcast to every client) so they never obstruct the
   cinematic. !important beats the per-frame inline opacity the tracker writes;
   position tracking keeps running so the crest fades back in exactly in place. */
.fud-dom-crest.is-anim-hidden { opacity: 0 !important; }
.fud-dom-crest .gem {
  width: 13px; height: 13px; transform: rotate(45deg);
  border: 2px solid #4a3826;
  border-radius: 3px;
  background: radial-gradient(circle at 40% 35%, #2b2118 0%, #161009 80%);
  box-shadow: 0 0 0 1px rgba(0,0,0,.6), inset 0 1px 1px rgba(255,255,255,.08);
  transition: background .3s ease, box-shadow .3s ease;
}
.fud-dom-crest .gem.is-lit {
  border-color: #8a4a1c;
  background: radial-gradient(circle at 38% 32%, #ffe9b0 0%, #ff9034 34%, #e0301a 72%, #7a0e08 100%);
  animation: fud-dom-gem-pulse 2.4s ease-in-out infinite;
}
/* Ignition — a real-gem GLEAM: blooms blinding white (over-brightened +
   desaturated so the base gradient reads as white-hot), oversized with a wide
   white halo, then settles into the ember base color + pulse. */
.fud-dom-crest .gem.is-igniting {
  animation: fud-dom-gem-ignite 1.15s cubic-bezier(.16,1.2,.3,1) 1,
             fud-dom-gem-pulse 2.4s ease-in-out 1.15s infinite;
}
@keyframes fud-dom-gem-pulse {
  0%, 100% { box-shadow: 0 0 5px 1px rgba(255,90,30,.55), 0 0 0 1px rgba(0,0,0,.6); }
  50%      { box-shadow: 0 0 11px 3px rgba(255,140,50,.9), 0 0 0 1px rgba(0,0,0,.6); }
}
@keyframes fud-dom-gem-ignite {
  0% {
    transform: rotate(45deg) scale(3.1);
    filter: brightness(6) saturate(0);
    box-shadow: 0 0 34px 14px rgba(255,255,255,1), 0 0 8px 3px rgba(255,255,255,1);
  }
  45% {
    transform: rotate(45deg) scale(1.7);
    filter: brightness(3.2) saturate(.25);
    box-shadow: 0 0 24px 9px rgba(255,246,224,.95);
  }
  75% {
    filter: brightness(1.5) saturate(.8);
    box-shadow: 0 0 14px 5px rgba(255,170,80,.9);
  }
  100% {
    transform: rotate(45deg) scale(1);
    filter: brightness(1) saturate(1);
    box-shadow: 0 0 5px 1px rgba(255,90,30,.55), 0 0 0 1px rgba(0,0,0,.6);
  }
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// The token's RENDERED sprite rectangle in client (screen) coordinates.
// mesh.getBounds() is renderer-space (post worldTransform), so offsetting by
// the canvas element's own client rect maps it to the page. Accounts for
// scale / anchor / fit-mode / mirroring — everything Token Config can change.
// Falls back to the nominal grid bounds when the mesh isn't available.
function spriteClientBounds(token) {
  const rect = canvas.app.view.getBoundingClientRect();
  try {
    const b = token.mesh?.getBounds?.();
    if (b && b.width > 0 && b.height > 0) {
      return { left: rect.left + b.x, top: rect.top + b.y, width: b.width, height: b.height };
    }
  } catch { /* fall through to nominal bounds */ }
  const wt = canvas.stage.worldTransform;
  const tl = new PIXI.Point(); wt.apply({ x: token.x, y: token.y }, tl);
  const br = new PIXI.Point(); wt.apply({ x: token.x + (token.w ?? 100), y: token.y + (token.h ?? 100) }, br);
  return { left: rect.left + tl.x, top: rect.top + tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

// Pool state. A boss WITHOUT the pool AE still shows an all-empty crest —
// the mechanic is advertised, only the charge is hidden until banked.
function readCharges(actor) {
  const ae = findDominancePointAe(actor);
  if (!ae) return { charges: 0, max: DOMINANCE_POINT_CAP };
  const f = ae.flags?.[FLAG_NS] ?? {};
  return {
    charges: Math.max(0, Number(f.charges ?? 0) || 0),
    max: Math.max(1, Number(f.chargesMax ?? DOMINANCE_POINT_CAP) || 1),
  };
}

function buildCrest(token, pool) {
  ensureStyles();
  const el = document.createElement("div");
  el.className = "fud-dom-crest";
  const gems = [];
  for (let i = 0; i < pool.max; i++) {
    const g = document.createElement("div");
    g.className = "gem";
    el.appendChild(g);
    gems.push(g);
  }
  if (_hiddenByAnimation) el.classList.add("is-anim-hidden");
  document.body.appendChild(el);
  const rec = { el, gems, lastCharges: -1, missingFrames: 0 };
  _crests.set(token.id, rec);
  paintCrest(rec, pool.charges);
  if (!_tickerOn) { PIXI.Ticker.shared.add(crestTick); _tickerOn = true; }
  return rec;
}

function paintCrest(rec, charges) {
  if (rec.lastCharges === charges) return;
  // Gained a point (not the initial paint) → gleam ignition + decide cue.
  const gained = charges > rec.lastCharges && rec.lastCharges >= 0;
  rec.lastCharges = charges;
  rec.gems.forEach((g, i) => {
    const lit = i < charges;
    g.classList.toggle("is-lit", lit);
    g.classList.remove("is-igniting");
    if (lit && gained) {
      void g.offsetWidth; // restart the one-shot ignite animation
      g.classList.add("is-igniting");
    }
  });
  if (gained) {
    try { playSfx(DOMINANCE_GAIN_SFX_URL, 0.8); }
    catch (e) { warn("dominance-crest: gain SFX failed", e); }
  }
}

function dropCrest(tokenId) {
  const rec = _crests.get(tokenId);
  if (!rec) return;
  try { rec.el.remove(); } catch {}
  _crests.delete(tokenId);
  if (!_crests.size && _tickerOn) {
    try { PIXI.Ticker.shared.remove(crestTick); } catch {}
    _tickerOn = false;
  }
}

// Per-token manual offset (canvas pixels at 100% zoom, scaled with the
// current zoom so the crest stays glued to the same spot on the sprite).
// Tuned via the "Dominance Crest Offset" fields injected into Token
// Configuration — set it on the PROTOTYPE token to cover future spawns.
function crestOffset(token) {
  const o = token?.document?.flags?.[FLAG_NS]?.dominanceCrestOffset;
  return { x: Number(o?.x ?? 0) || 0, y: Number(o?.y ?? 0) || 0 };
}

function crestTick() {
  if (!_crests.size) return;
  for (const [tokenId, rec] of _crests) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) {
      // Placeables rebuild across canvas redraws — short grace before drop.
      if (++rec.missingFrames > 30) dropCrest(tokenId);
      else rec.el.style.opacity = "0";
      continue;
    }
    rec.missingFrames = 0;
    const b = spriteClientBounds(token);
    const off = crestOffset(token);
    const zoom = canvas.stage?.scale?.x ?? 1;
    rec.el.style.left = `${b.left + b.width / 2 + off.x * zoom}px`;
    rec.el.style.top = `${b.top - 6 + off.y * zoom}px`;
    // Follow the token's visibility (fog, Escape fade, hidden toggle).
    rec.el.style.opacity = token.visible === false ? "0" : String(token.alpha ?? 1);
  }
}

// Re-derive this actor's crest state on every of its canvas tokens.
// Crest presence = the actor IS a boss (always-visible socket); the pool AE
// only drives how many gems are lit.
function syncActorCrest(actor) {
  if (!actor) return;
  const isBoss = actorIsBoss(actor);
  const pool = readCharges(actor);
  let tokens = [];
  try { tokens = actor.getActiveTokens?.(true) ?? []; } catch {}
  for (const token of tokens) {
    if (!isBoss) { dropCrest(token.id); continue; }
    const rec = _crests.get(token.id) ?? buildCrest(token, pool);
    paintCrest(rec, pool.charges);
  }
}

function rescanCanvas() {
  for (const rec of _crests.values()) { try { rec.el.remove(); } catch {} }
  _crests.clear();
  let bosses = 0;
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (!token?.actor) continue;
    if (actorIsBoss(token.actor)) bosses++;
    syncActorCrest(token.actor);
  }
  log(`dominance-crest: rescan — ${bosses} boss token(s), ${_crests.size} crest(s) on ${canvas?.scene?.name ?? "?"}`);
}

// Exported for manual probing / recovery (FUCompanion console use).
export function rescanDominanceCrests() { rescanCanvas(); }

function isDominancePoolAe(effect) {
  const f = effect?.flags?.[FLAG_NS] ?? {};
  return String(f.chargeKey ?? "").trim().toLowerCase() === "dominance"
    || String(effect?.name ?? "").trim() === "Dominance Point";
}

// ── Token Configuration: "Dominance Crest Offset" tuner ─────────────────────
// Injects an X/Y pixel-offset pair at the end of the Appearance tab, saved via
// Foundry's own form serialization (named flag inputs — no custom submit
// handler). Works on placed-token AND prototype-token configs; tune the
// prototype so every future spawn of that monster inherits the offset.
// Values are canvas pixels at 100% zoom; positive X → right, positive Y → down.
function injectCrestOffsetConfig(app, html) {
  try {
    const tokenDoc = app.token ?? app.object ?? null;
    const cur = tokenDoc?.flags?.[FLAG_NS]?.dominanceCrestOffset ?? {};
    const x = Number(cur.x ?? 0) || 0;
    const y = Number(cur.y ?? 0) || 0;
    const $html = html instanceof jQuery ? html : $(html);
    const tab = $html.find('div.tab[data-tab="appearance"]');
    if (!tab.length || tab.find(".fud-crest-offset").length) return;
    tab.append(`
      <fieldset class="fud-crest-offset">
        <legend>Dominance Crest Offset</legend>
        <div class="form-group slim">
          <label>Offset (Pixels) <span class="units">(+X right, +Y down)</span></label>
          <div class="form-fields">
            <label>X</label>
            <input type="number" step="1" name="flags.${FLAG_NS}.dominanceCrestOffset.x" value="${x}">
            <label>Y</label>
            <input type="number" step="1" name="flags.${FLAG_NS}.dominanceCrestOffset.y" value="${y}">
          </div>
        </div>
        <p class="notes">Nudges the boss Dominance Crest relative to its automatic spot above the sprite. Set on the prototype token to cover future spawns.</p>
      </fieldset>
    `);
    app.setPosition({ height: "auto" });
  } catch (e) {
    warn("dominance-crest: TokenConfig injection failed", e);
  }
}

// Idempotent — called on every client from director-boot's ready hook.
export function initDominationCrest() {
  if (_hooksOn) return;
  _hooksOn = true;
  // Cinematic-hide socket — the FSM's ANIMATION state broadcasts hide/show so
  // crests fade out during action animations on every client.
  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(FLAG_NS);
      _socket.register(ACTION_CREST_VIS, setCrestsHiddenLocal);
    }
  } catch (e) {
    warn("dominance-crest: socket init failed — cinematic hide stays GM-local", e);
  }
  const onAeEvent = (effect) => {
    if (isDominancePoolAe(effect) && effect.parent?.documentName === "Actor") {
      syncActorCrest(effect.parent);
    }
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);
  // Boss token spawned mid-scene (director PREP spawns, summons) → crest up
  // as soon as its placeable exists. The 100ms defer lets the canvas finish
  // drawing the new placeable before the first bounds measure.
  Hooks.on("createToken", (tokenDoc) => {
    if (!tokenDoc?.actor || !actorIsBoss(tokenDoc.actor)) return;
    setTimeout(() => { try { syncActorCrest(tokenDoc.actor); } catch (e) { warn("dominance-crest: createToken sync threw", e); } }, 100);
  });
  Hooks.on("renderTokenConfig", injectCrestOffsetConfig);
  Hooks.on("canvasReady", () => {
    // Defer one tick past the canvasReady storm so token placeables (and any
    // reload-recovery scene switching) settle before the first bounds pass.
    setTimeout(() => { try { rescanCanvas(); } catch (e) { warn("dominance-crest: canvasReady rescan threw", e); } }, 250);
  });
  // Boot-order belt and braces: whichever way this client ordered ready vs the
  // initial canvasReady (plain load, reload-recovery scene hop, F5 mid-battle),
  // a delayed sweep guarantees the always-on sockets appear shortly after load.
  if (canvas?.ready) rescanCanvas();
  setTimeout(() => { try { rescanCanvas(); } catch (e) { warn("dominance-crest: deferred boot rescan threw", e); } }, 3000);
  log("dominance-crest: watcher installed");
}
