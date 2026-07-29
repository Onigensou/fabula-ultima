// Presentation clock — the single place that decides whether anyone is
// actually watching, and how long the director should dwell.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// Chromium fully pauses `requestAnimationFrame` — and with it the PIXI ticker
// Sequencer and every CSS/WAAPI transition draw on — in a hidden or fully
// occluded window. It also clamps `setTimeout` to >=1 s, and to ~1/min after
// five minutes of "intensive throttling".
//
// The Battle Director is one serialized dispatch chain in which every cinematic
// step is awaited, so a backgrounded window does NOT skip the show — it parks
// mid-timeline and unspools the whole backlog the moment the window is shown
// again. That is the "it replays everything when I come back" symptom.
//
// The fix is to stop dwelling while nobody is watching. Damage, Active Effects
// and resource writes are untouched — only the presentation is dropped. Same
// principle the `context.lean` and SimMode paths already use: skip the show,
// never the rules.
//
// ── Dwell vs interval — read before using `pWait` ────────────────────────
//
// `pWait` collapses to zero when hidden. That is correct ONLY for a dwell: a
// pause whose sole purpose is to let a human see something. It is WRONG for:
//
//   - a POLL interval (`while (!ready) await wait(150)`) — collapsing it turns
//     the loop into a busy-spin that pegs a core until its deadline;
//   - a PACING interval that does work each tick (`heartbeatSpan` fires a SFX
//     per iteration) — collapsing it fires that work thousands of times.
//
// Those must keep a real delay; use `interval()` for them, which is honest
// about never collapsing. When the whole loop is pointless while hidden, guard
// the CALLER with `shouldRender()` instead of shortening the wait.

// True when the window is hidden or fully occluded — i.e. nothing this client
// draws can be seen. Defensive against non-browser contexts (tests).
export function isWindowHidden() {
  try { return typeof document !== "undefined" && document.hidden === true; }
  catch { return false; }
}

// The inverse, named for intent at cinematic call sites:
//   if (!shouldRender()) return;   // nobody is watching — skip the whole beat
//
// Deliberately INSTANTANEOUS (no grace period — see isBackgroundedFor below).
// Every caller of this guards work that is rAF/transition-driven and therefore
// cannot progress at all while hidden. Delaying the decision would just park
// the pipeline on a frame that never arrives.
export function shouldRender() {
  return !isWindowHidden();
}

// ── How LONG have we been hidden ─────────────────────────────────────────
//
// `isWindowHidden()` answers instantly, which is right for rAF-driven work but
// wrong for deciding to THROW AWAY a unit of work. On Windows `document.hidden`
// goes true for an ordinary alt-tab to a maximised app, so an instantaneous
// check means glancing away for one second silently eats any animation that
// happens to start in that second — you tab back to damage already applied and
// no cinematic. That is a worse artifact than the stall it avoids.
//
// So callers that DISCARD work require the window to have been continuously
// hidden for a while first. Safe to wait, because the work in question is
// timer-driven and completes while hidden anyway (just clamped).
let _hiddenSince = null;
const _now = () => {
  try { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
  catch { return Date.now(); }
};

(function trackVisibility() {
  try {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    // Loading while already hidden: start the clock NOW rather than assuming we
    // have been hidden a long time. Conservative — errs toward playing.
    _hiddenSince = document.hidden ? _now() : null;
    document.addEventListener("visibilitychange", () => {
      _hiddenSince = document.hidden ? _now() : null;
    });
  } catch { /* non-browser (tests) — stays null, isBackgroundedFor returns false */ }
})();

// True when the window has been hidden continuously for at least `ms`.
// A quick alt-tab never satisfies it, so nothing is discarded over a glance.
export function isBackgroundedFor(ms = 0) {
  if (!isWindowHidden()) return false;
  if (_hiddenSince == null) { _hiddenSince = _now(); }   // self-heal: treat as just-hidden
  return (_now() - _hiddenSince) >= ms;
}

// A presentation DWELL. Real delay while visible; zero while hidden.
// Only ever wrap a pause that exists for a human to see something.
export function pWait(ms) {
  if (isWindowHidden()) return Promise.resolve();
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, n));
}

// ── Who is watching BESIDES me ───────────────────────────────────────────
//
// The dwell rules above are about THIS client's own rendering. They are only
// safe where the pause affects nothing but this screen. A pause is NOT safe to
// collapse when it sits in front of cross-client work — a socket broadcast, or
// a parameter that gets transmitted — because then a hidden GM changes what
// everyone else sees.
//
// The BD surfaces mostly use "executeForOthers(...) first, then await my own
// local render", which IS safe: the broadcast has already left. The exceptions
// are called out at their call sites and gated on this.
//
// True when any OTHER user is connected (a player, or a second GM).
//
// STICKY on purpose. `user.active` drops to false for the seconds a player
// spends reloading or reconnecting, and an instantaneous read during that gap
// would let the host decide it is alone and discard an animation the player was
// about to come back to. So once someone else has been seen, we keep reporting
// "watched" for `stickyMs` after they were last seen. A join is picked up
// immediately (the live check runs first); only the DISAPPEARANCE is damped.
//
// Fail-safe: on any error assume someone IS watching, so we never silently
// strip a cinematic from a live table.
const VIEWER_STICKY_MS = 30000;
let _lastOtherViewerAt = null;

export function hasOtherViewers({ stickyMs = VIEWER_STICKY_MS } = {}) {
  try {
    const me = game?.userId ?? null;
    const live = (game?.users?.contents ?? []).some((u) => u?.active && u?.id !== me);
    if (live) { _lastOtherViewerAt = _now(); return true; }
    // Nobody visible right now — but were they, recently? Then assume a reload.
    if (_lastOtherViewerAt != null && (_now() - _lastOtherViewerAt) < stickyMs) return true;
    return false;
  } catch { return true; }
}

// A real interval that NEVER collapses — for poll loops and paced work loops.
// Exists so those call sites read as a deliberate choice rather than an
// oversight when someone greps for the dwell helper.
export function interval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, n));
}

// ── Why there is no `whenHidden()` here ──────────────────────────────────
//
// An earlier cut of this module exported a promise that resolved the moment the
// window became hidden, so an in-flight wait could be collapsed on a tab-away.
// It was removed on purpose. Collapsing work that has ALREADY STARTED is the
// wrong move: for an animation it applies damage at the tab-away instant rather
// than at the scripted impact frame, and on return you watch a stale cinematic
// play over a state that has moved on.
//
// It also is not needed. A hidden window is not frozen, only unrendered —
// `setTimeout` still fires, merely clamped to ~1 s (measured: a 100 ms timer
// lands at ~1000 ms, and `new Sequence().wait(500).play()` resolves in ~1965 ms).
// So in-flight work completes on its own, a bit slower, and the NEXT unit of
// work is skipped up-front by an `isWindowHidden()` / `shouldRender()` check.
//
// Decide up-front whether to do the work; never abandon it half-done.
