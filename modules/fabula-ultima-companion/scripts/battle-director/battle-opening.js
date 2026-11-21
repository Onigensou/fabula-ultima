// ============================================================================
// Battle opening — the runtime (every client). The registry and the style contract: battle-opening-styles.js.
//
// GM (director-init.js runDirectorInitInner), when an enemy claims the opening:
//   const run = presentBattleOpening({ key, sceneId, bossTokenId, partyTokenIds, enemyTokenIds, crackOut });
//   shatter.release({ crackOut: key });      // every client: the crack-out instead of the break
//   await run.arrived;                        // camera back at the battle position, party faded in (bounded)
//   ... persist the tokens' alpha, then the usual HUD / BATTLE START ...
//
// Every client:
//   1. its shatter reaches the break and runs crackOutRunner(key)(ctx): the style's crack-out over the frozen glass,
//      then the BLACK COVER goes up (a DOM plate just under the shatter overlay), so the screen stays black when the
//      overlay goes;
//   2. the opening message (sent by the GM with the release) waits for that crack-out (or, where none could play,
//      for the style's crackOutMs), then plays the style's show from the black: style.play(ctx).
// No shatter (the classic curtain) = the cover goes up the moment the message arrives, the show starts at once.
// Every wait is bounded and a failed show falls back to revealing everyone, so the battle start can never hang.
// ============================================================================

import { log, warn } from "./logger.js";
import { shouldRender, hasOtherViewers } from "./presentation-clock.js";
import { battleOpeningStyle } from "./battle-opening-styles.js";

const MODULE_ID = "fabula-ultima-companion";
const MSG = "FU_BATTLE_OPENING";
const COVER_ID = "fud-opening-cover";
const COVER_Z = 99999;          // just under the shatter overlay (100000), over the HUD and Foundry's UI
const CRACKED_FRESH_MS = 30000; // a crack-out this recent counts for an opening message that arrives after it
const FADE_MS = 600, STAGGER_MS = 90;

const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const race = (p, ms) => Promise.race([Promise.resolve(p).catch((e) => { warn("battle-opening: a step threw", e); }), wait(ms).then(() => "timeout")]);

/* ── The black cover (DOM): solid black + a vignette (the dark round a close-up) ── */

let _cover = null;      // { root, solid, vig, level, vignette, anim, watchdog }

function coverEl() {
  if (_cover?.root?.isConnected) return _cover;
  const root = document.createElement("div");
  root.id = COVER_ID;
  Object.assign(root.style, { position: "fixed", inset: "0", zIndex: String(COVER_Z), pointerEvents: "none" });
  const mk = (bg) => { const d = document.createElement("div"); Object.assign(d.style, { position: "absolute", inset: "0", background: bg, opacity: "0" }); return d; };
  const solid = mk("#000");
  const vig = mk("radial-gradient(ellipse 62% 58% at 50% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 38%, rgba(0,0,0,.72) 72%, rgba(0,0,0,.96) 100%)");
  root.append(vig, solid);
  document.body.appendChild(root);
  _cover = { root, solid, vig, level: 0, vignette: 0, anim: 0, watchdog: 0 };
  return _cover;
}

/**
 * The cover, shared by every style. Levels 0..1: `level` = solid black, `vignette` = the dark round the edges (a
 * close-up seen out of the dark). set() is immediate; fadeTo() eases over ms (resolves on arrival).
 */
export const openingCover = {
  set(level = 1, { vignette = null } = {}) {
    const c = coverEl();
    cancelAnimationFrame(c.anim); c.anim = 0;
    c.level = clamp01(level); if (vignette != null) c.vignette = clamp01(vignette);
    c.solid.style.opacity = String(c.level); c.vig.style.opacity = String(c.vignette);
    c.root.style.display = c.level > 0 || c.vignette > 0 ? "" : "none";
  },
  fadeTo(level, ms = 400, { vignette = null } = {}) {
    const c = coverEl();
    cancelAnimationFrame(c.anim);
    const a0 = c.level, v0 = c.vignette, a1 = clamp01(level), v1 = vignette == null ? v0 : clamp01(vignette);
    c.root.style.display = "";
    return new Promise((done) => {
      const t0 = performance.now();
      const step = (now) => {
        const u = Math.min(1, (now - t0) / Math.max(1, ms)), e = u * u * (3 - 2 * u);
        c.level = a0 + (a1 - a0) * e; c.vignette = v0 + (v1 - v0) * e;
        c.solid.style.opacity = c.level.toFixed(4); c.vig.style.opacity = c.vignette.toFixed(4);
        if (u < 1) c.anim = requestAnimationFrame(step);
        else { c.anim = 0; if (c.level <= 0 && c.vignette <= 0) c.root.style.display = "none"; done(); }
      };
      c.anim = requestAnimationFrame(step);
      setTimeout(() => { if (c.anim) { cancelAnimationFrame(c.anim); c.anim = 0; openingCover.set(a1, { vignette: v1 }); done(); } }, ms + 1500);   // a hidden window never runs rAF
    });
  },
  /** Gone for good (the show is over / rescued). */
  drop() {
    if (!_cover) return;
    cancelAnimationFrame(_cover.anim); clearTimeout(_cover.watchdog);
    try { _cover.root.remove(); } catch { /* gone */ }
    _cover = null;
  },
  /** The cover drops by itself after ms whatever happens (a show that died). */
  guard(ms) { const c = coverEl(); clearTimeout(c.watchdog); c.watchdog = setTimeout(() => { warn("battle-opening: cover watchdog"); openingCover.drop(); }, ms); },
  status: () => (_cover ? { level: +_cover.level.toFixed(3), vignette: +_cover.vignette.toFixed(3) } : null),
};
function clamp01(v) { v = Number(v) || 0; return v < 0 ? 0 : v > 1 ? 1 : v; }

/* ── The crack-out (asked by the shatter at its break) ── */

let _cracked = null;            // { key, at } the last crack-out that ended on this client
const _crackWaiters = new Set();

/**
 * The function the shatter runs instead of breaking the glass (null for an unknown style: the glass breaks). Runs the
 * style's crack-out (or, without one, a short fade to black over the glass), then puts the black cover up.
 */
export function crackOutRunner(key) {
  const style = battleOpeningStyle(key);
  if (!style) { warn(`battle-opening: crack-out for unknown style "${key}"; the glass breaks`); return null; }
  return async (ctx) => {
    try {
      if (typeof style.crackOut === "function") await race(style.crackOut(ctx), (style.crackOutMs || 4000) + 4000);
      else await defaultCrackOut(ctx);
    } catch (e) { warn(`battle-opening: "${key}" crack-out threw`, e); }
    openingCover.set(1, { vignette: 0 });
    _cracked = { key, at: performance.now() };
    for (const w of [..._crackWaiters]) w(_cracked);
    log(`battle-opening: "${key}" crack-out over (black)`);
  };
}
/** No crack-out of the style's own: the cracked frame fades to black. */
function defaultCrackOut(ctx) {
  const d = document.createElement("div");
  Object.assign(d.style, { position: "absolute", inset: "0", background: "#000", opacity: "0", transition: `opacity ${Math.round(500 * (ctx?.speed || 1))}ms ease-in` });
  ctx?.layer?.appendChild(d);
  requestAnimationFrame(() => { d.style.opacity = "1"; });
  return wait(650 * (ctx?.speed || 1));
}
/** Resolves when this client's crack-out for `key` is over (at once if it just was), or after ms. */
function crackedOut(key, ms) {
  if (_cracked && _cracked.key === key && performance.now() - _cracked.at < CRACKED_FRESH_MS) return Promise.resolve(true);
  return new Promise((resolve) => {
    let t = 0;
    const w = (c) => { if (c.key !== key) return; _crackWaiters.delete(w); clearTimeout(t); resolve(true); };
    _crackWaiters.add(w);
    t = setTimeout(() => { _crackWaiters.delete(w); resolve(false); }, ms);
  });
}

/* ── Token helpers (local) ── */

function placeables(ids) { return (ids ?? []).map((id) => canvas?.tokens?.get?.(id)).filter((t) => t && !t.destroyed); }

/** Fade tokens in on THIS client (visual only; the GM persists alpha 1 afterwards), staggered top to bottom. */
export function fadeInTokens(tokens, { ms = FADE_MS, stagger = STAGGER_MS } = {}) {
  const list = [...(tokens ?? [])].filter((t) => t && !t.destroyed).sort((a, b) => (a.document?.y ?? 0) - (b.document?.y ?? 0));
  return Promise.all(list.map((p, i) => new Promise((resolve) => {
    setTimeout(() => {
      const t0 = performance.now();
      const tick = (now) => {
        const u = Math.min(1, (now - t0) / ms);
        if (!p.destroyed) { try { p.alpha = u; } catch { /* gone */ } try { if (p.mesh) p.mesh.alpha = u; } catch { /* gone */ } }
        if (u < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
      setTimeout(() => { if (!p.destroyed) { try { p.alpha = 1; } catch { /* */ } try { if (p.mesh) p.mesh.alpha = 1; } catch { /* */ } } resolve(); }, ms + 1500);
    }, i * stagger);
  })));
}
function revealNow(tokens) {
  for (const p of tokens ?? []) { if (!p || p.destroyed) continue; try { p.alpha = 1; } catch { /* */ } try { if (p.mesh) p.mesh.alpha = 1; } catch { /* */ } }
}

/* ── The show on this client ── */

const _runs = new Map();        // spec.id -> { arrived, done }

/**
 * Play the opening on THIS client. spec: { id, key, sceneId, bossTokenId, partyTokenIds, enemyTokenIds, crackOut }.
 * -> { arrived, done } (promises; resolve at once where nothing is drawn).
 */
export function playBattleOpeningLocal(spec) {
  const none = { arrived: Promise.resolve(false), done: Promise.resolve(false) };
  try {
    if (!spec?.key) return none;
    if (spec.id && _runs.has(spec.id)) return _runs.get(spec.id);
    const style = battleOpeningStyle(spec.key);
    if (!style || !canvas?.ready || (spec.sceneId && canvas.scene?.id !== spec.sceneId) || !shouldRender()) return none;
    const span = Math.max(1000, Number(style.spanMs(spec)) || 0);
    // no crack-out coming (classic curtain): black now
    if (!spec.crackOut) openingCover.set(1, { vignette: 0 });
    openingCover.guard((style.crackOutMs || 0) + span + 30000);
    let arrivedOk, doneOk;
    const arrived = new Promise((r) => { arrivedOk = r; }), done = new Promise((r) => { doneOk = r; });
    const run = { arrived, done };
    if (spec.id) _runs.set(spec.id, run);
    (async () => {
      if (spec.crackOut) {
        const ok = await crackedOut(spec.key, (style.crackOutMs || 0) + 6000);
        if (!ok) { warn(`battle-opening: no crack-out seen here; starting "${spec.key}" on black`); openingCover.set(1, { vignette: 0 }); }
      }
      const boss = spec.bossTokenId ? canvas.tokens.get(spec.bossTokenId) ?? null : null;
      const enemies = placeables(spec.enemyTokenIds);
      const party = placeables(spec.partyTokenIds);
      const others = enemies.filter((t) => t !== boss);
      const ctx = { spec, scene: canvas.scene, boss, party, others, cover: openingCover, fadeIn: fadeInTokens };
      let show = null;
      try { show = style.play(ctx) ?? null; } catch (e) { warn(`battle-opening: "${spec.key}" could not start`, e); }
      const a = show ? await race(show.arrived, span + 8000) : "failed";
      if (a === "timeout" || a === "failed" || a === false) {
        // rescued: everyone shown, the cover gone (the style's own finish puts its camera back)
        warn(`battle-opening: "${spec.key}" did not arrive (${a}); revealing everyone`);
        try { show?.cancel?.(); } catch { /* */ }
        revealNow([...party, ...enemies]);
        openingCover.drop();
      }
      arrivedOk(true);
      if (show?.done) await race(show.done, 15000);
      openingCover.drop();
      doneOk(true);
      if (spec.id) setTimeout(() => _runs.delete(spec.id), 60000);
    })().catch((e) => { warn("battle-opening: run failed", e); openingCover.drop(); revealNow(placeables([...(spec.partyTokenIds ?? []), ...(spec.enemyTokenIds ?? [])])); arrivedOk(false); doneOk(false); });
    return run;
  } catch (e) {
    warn("battle-opening: play failed", e);
    openingCover.drop();
    return none;
  }
}

/**
 * GM: start the opening on every client. Returns { arrived, done, spanMs } — arrived resolves once the camera is back
 * at the battle position and the party has faded in HERE (or, where the GM draws nothing, after the style's span),
 * always within the bound. Never throws.
 */
export function presentBattleOpening(spec) {
  const style = battleOpeningStyle(spec?.key);
  if (!style) return null;
  const full = { ...spec, id: spec.id ?? foundry.utils.randomID() };
  const span = Math.max(1000, Number(style.spanMs(full)) || 0) + (full.crackOut ? (style.crackOutMs || 0) : 0);
  try { game.socket?.emit?.(`module.${MODULE_ID}`, { type: MSG, spec: full }); } catch (e) { warn("battle-opening: broadcast failed", e); }
  let local;
  if (shouldRender()) local = playBattleOpeningLocal(full);
  else {
    // nothing drawn here: hold for the span when someone else watches, else carry straight on
    const w = hasOtherViewers() ? wait(span) : Promise.resolve();
    local = { arrived: w, done: w };
  }
  const bound = span + 15000;
  log(`battle-opening: "${full.key}" presented (span ${span} ms)`);
  return { id: full.id, spanMs: span, arrived: race(local.arrived, bound), done: race(local.done, bound + 15000) };
}

let _hooked = false;
export function initBattleOpening() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  game.socket?.on?.(`module.${MODULE_ID}`, (m) => { if (m?.type === MSG) playBattleOpeningLocal(m.spec); });
  globalThis.__FU_BATTLE_OPENING__ = { play: playBattleOpeningLocal, present: presentBattleOpening, cover: openingCover, crackOutRunner, runs: () => [..._runs.keys()], cracked: () => _cracked };
}
