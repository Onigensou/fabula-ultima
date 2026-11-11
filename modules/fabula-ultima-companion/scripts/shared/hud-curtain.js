// ============================================================================
// HUD curtain — hide the battle HUD for a cutscene, and give it back (every
// client). The user (2026-11-11, Nidhogg's fall): "this HUD hiding might be
// used many times in the future", so it is one general primitive, not
// something each show does for itself.
//
//   const tok = hideHud("nidhogg-fall", { fade: 0.45 });   // fades out
//   ...
//   showHud(tok, { fade: 0.5 });                            // fades back, then the hold is gone
//
//   const tok = hideHud("crystal-death", { level: 1 });     // the owner drives it:
//   setHudLevel(tok, 1 - u);                                //   0 = hidden, 1 = shown, every frame
//
// - REF-COUNTED: every hold is its own token; the HUD shows at the LOWEST level
//   of all holds, so two overlapping cutscenes never fight (the first to give
//   its hold back does not bring the HUD back while the other still hides it).
// - WHAT it hides: the battle HUD roots (GM desk, player HUD + plates, round
//   layer, turn order bar, Take Turn picker, NPC strip, status cues, inspect,
//   Soul Tithe counters). Anything else registers itself: registerHudSelector().
//   Hidden = opacity + no pointer events, so nothing is clicked by accident.
// - EVERY CLIENT: { broadcast: true } sends the hold (and its show) to every
//   other client too, under the same key. A show that already plays on every
//   client hides its own HUD locally instead.
// - SAFETY: every hold is let go at battle end (fu-director-stopped) and at a
//   scene change (canvasTearDown), and after maxS (default 120 s), so a show that
//   dies half-way can never leave the HUD gone.
// ============================================================================

const MODULE_ID = "fabula-ultima-companion";
const MSG = "FU_HUD_CURTAIN";
const STYLE_ID = "fud-hud-curtain-style";
const BODY_CLASS = "fud-hud-curtain";
const VAR = "--fud-hud-curtain";
const DEFAULT_MAX_S = 120;

/** The battle HUD's roots (the crystal death's list, plus the turn bar and the Take Turn picker). */
const SELECTORS = new Set([
  "#fud-gm-desk", "[id^='dhud-root-']", "[id^='dhud-plate-']", "#fu-dir-round-layer", "[id^='fud-octopath-']", "[id^='fud-pickturn-']",
  "#fu-npc-strip-root", "#fu-status-cue-root", "#fu-status-pop-root", "#fu-inspect-root", ".fud-crystal-count", ".fud-soul-hp",
]);

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const now = () => (globalThis.performance ?? Date).now() / 1000;

/* ── The holds (pure state; the DOM side reads level()) ─────────────────── */

/**
 * A hold: { key, reason, from, to, t0, dur, manual, releasing, maxAt }. Its level at time s: the fade from `from` to
 * `to` over dur (eased), or `manual` while the owner drives it. A releasing hold is dropped once it reaches 1.
 */
export function makeCurtain({ clock = now } = {}) {
  const holds = new Map();
  let seq = 0;
  const levelOf = (h, s) => (h.manual != null ? h.manual : h.dur <= 0 ? h.to : h.from + (h.to - h.from) * ease((s - h.t0) / h.dur));
  const api = {
    hide(reason = "hide", { fade = 0.45, level = null, key = null, maxS = DEFAULT_MAX_S } = {}) {
      const s = clock(), k = key ?? `${reason}:${++seq}:${Math.random().toString(36).slice(2, 7)}`;
      const old = holds.get(k);
      const from = old ? levelOf(old, s) : 1;
      holds.set(k, { key: k, reason: String(reason), from, to: 0, t0: s, dur: level != null ? 0 : Math.max(0, Number(fade) || 0), manual: level != null ? clamp01(Number(level)) : null, releasing: false, maxAt: s + (Number(maxS) > 0 ? Number(maxS) : DEFAULT_MAX_S) });
      return k;
    },
    /** Give a hold back: it fades up to 1 over `fade`, then it is gone. */
    show(key, { fade = 0.45 } = {}) {
      const h = holds.get(key);
      if (!h) return false;
      const s = clock(), from = levelOf(h, s);
      Object.assign(h, { from, to: 1, t0: s, dur: Math.max(0, Number(fade) || 0), manual: null, releasing: true });
      if (h.dur <= 0) holds.delete(key);
      return true;
    },
    /** The owner drives its hold directly (0 hidden .. 1 shown). */
    set(key, level) { const h = holds.get(key); if (!h) return false; h.manual = clamp01(Number(level)); h.releasing = false; return true; },
    /** Drop every hold at once (battle end, scene change); `reason` limits it to one reason. */
    releaseAll(reason = null) { for (const [k, h] of holds) if (reason == null || h.reason === reason) holds.delete(k); },
    /** The HUD's level now: the lowest hold (1 = shown, no holds). Prunes finished + expired holds. */
    level(s = clock()) {
      let lv = 1;
      for (const [k, h] of holds) {
        if (s >= h.maxAt) { holds.delete(k); continue; }
        const v = clamp01(levelOf(h, s));
        if (h.releasing && (h.dur <= 0 || s >= h.t0 + h.dur)) { holds.delete(k); continue; }
        if (v < lv) lv = v;
      }
      return lv;
    },
    /** True while some hold is still fading (the DOM side keeps animating). */
    moving(s = clock()) { for (const h of holds.values()) if (h.manual == null && h.dur > 0 && s < h.t0 + h.dur) return true; return false; },
    get size() { return holds.size; },
    list() { const s = clock(); return [...holds.values()].map((h) => ({ key: h.key, reason: h.reason, level: +clamp01(levelOf(h, s)).toFixed(3), releasing: h.releasing })); },
  };
  return api;
}

/* ── This client's curtain + the DOM ────────────────────────────────────── */

const _curtain = makeCurtain();
// At most ONE animation frame and ONE watchdog timer pending at any time. (The first version re-armed both on every
// apply(), and setHudLevel() applies every frame: a 1.5 s hold piled up 15-21 frames and 64-151 timers — data-0b's
// leak audit, 2026-11-12.)
let _raf = 0, _timer = 0, _lastFrame = 0, _applied = null;

function css() {
  const sel = [...SELECTORS].join(", ");
  return `body.${BODY_CLASS} :is(${sel}) { opacity: var(${VAR}, 1) !important; pointer-events: none !important; }`;
}
function ensureStyle() {
  if (typeof document === "undefined") return;
  let st = document.getElementById(STYLE_ID);
  if (!st) { st = document.createElement("style"); st.id = STYLE_ID; document.head.appendChild(st); }
  const text = css();
  if (st.textContent !== text) st.textContent = text;
}
/** Put the current level on the page; returns it. */
function render() {
  const lv = _curtain.level();
  if (typeof document === "undefined") return lv;
  if (_curtain.size === 0 || lv >= 0.999) {
    if (_applied !== null) { document.body.classList.remove(BODY_CLASS); document.body.style.removeProperty(VAR); _applied = null; }
  } else {
    ensureStyle();
    if (_applied === null) document.body.classList.add(BODY_CLASS);
    const v = lv.toFixed(3);
    if (_applied !== v) { document.body.style.setProperty(VAR, v); _applied = v; }
  }
  return lv;
}
/** Render now, and keep a frame coming while a hold is fading or the HUD is down; stop everything once it is not. */
function apply() {
  const lv = render();
  if (_curtain.size && (_curtain.moving() || lv < 0.999)) schedule();
  else stop();
}
function onFrame() { _raf = 0; _lastFrame = Date.now(); apply(); }
function schedule() {
  if (typeof requestAnimationFrame === "undefined") return;
  if (!_raf) _raf = requestAnimationFrame(onFrame);
  // a hidden tab gets no animation frames: the level is still right on the next visible frame, but a release must not
  // wait for one. One watchdog at a time; it steps in only when no frame has come for a while.
  if (!_timer) {
    _timer = setTimeout(() => {
      _timer = 0;
      if (_raf && Date.now() - _lastFrame > 200) { cancelAnimationFrame(_raf); _raf = 0; apply(); }
      else if (_raf) schedule();
    }, 250);
  }
}
function stop() {
  if (_raf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(_raf);
  if (_timer) clearTimeout(_timer);
  _raf = 0; _timer = 0;
}
/** Rigs: pending work (want at most 1 frame + 1 timer). */
export const hudCurtainPending = () => ({ raf: _raf ? 1 : 0, timer: _timer ? 1 : 0 });

function emit(payload) {
  try { game.socket?.emit?.(`module.${MODULE_ID}`, { type: MSG, ...payload }); } catch { /* offline */ }
}

/** Hide the HUD on this client (and every client with broadcast). Returns the hold's token. */
export function hideHud(reason, { fade = 0.45, level = null, broadcast = false, maxS = DEFAULT_MAX_S } = {}) {
  const key = _curtain.hide(reason, { fade, level, maxS });
  if (broadcast) emit({ op: "hide", key, reason, fade, level, maxS });
  apply();
  return key;
}
/** Give a hold back (fades in over `fade`). */
export function showHud(token, { fade = 0.45, broadcast = false } = {}) {
  if (!token) return false;
  const ok = _curtain.show(token, { fade });
  if (broadcast) emit({ op: "show", key: token, fade });
  apply();
  return ok;
}
/** The hold's owner drives it this frame (0 hidden .. 1 shown). Local only. */
export function setHudLevel(token, level) {
  const ok = _curtain.set(token, level);
  apply();
  return ok;
}
/** Let every hold go now (safety). */
export function releaseHud({ reason = null, broadcast = false } = {}) {
  _curtain.releaseAll(reason);
  if (broadcast) emit({ op: "release", reason });
  apply();
}
/** One more HUD root to hide (a CSS selector), for panels added later. */
export function registerHudSelector(sel) {
  if (!sel || SELECTORS.has(sel)) return;
  SELECTORS.add(String(sel));
  if (typeof document !== "undefined" && document.getElementById(STYLE_ID)) ensureStyle();
}
export const hudCurtainStatus = () => ({ level: +_curtain.level().toFixed(3), holds: _curtain.list(), selectors: [...SELECTORS] });

let _hooked = false;
export function initHudCurtain() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  game.socket?.on?.(`module.${MODULE_ID}`, (m) => {
    if (m?.type !== MSG) return;
    try {
      if (m.op === "hide") { _curtain.hide(m.reason, { fade: m.fade, level: m.level, key: m.key, maxS: m.maxS }); apply(); }
      else if (m.op === "show") { _curtain.show(m.key, { fade: m.fade }); apply(); }
      else if (m.op === "release") releaseHud({ reason: m.reason ?? null });
    } catch (e) { console.warn("[hud-curtain] message failed", e); }
  });
  Hooks.on("fu-director-stopped", () => releaseHud());
  Hooks.on("canvasTearDown", () => releaseHud());
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.hudCurtain = { hide: hideHud, show: showHud, set: setHudLevel, release: releaseHud, register: registerHudSelector, status: hudCurtainStatus };
}
