// ============================================================================
// FabulaUltimaCompanion - Dialog System (UI + Listener) - v1
// File: scripts/dialog-system/dialog-ui.js
// - Installs a socket listener on startup (multi-client)
// - Injects CSS once
// - Renders the JRPG speech bubble UI (normal/shout/think)
// - Renders the message box (payload.box): the JRPG square text window at
//   the bottom of the screen, for a speaker with no token here
// - Adds loud console logs so we can verify it loads on every client
//
// Three ways a line is drawn (all typed by runLine below, so they type at
// the same pace, play the same blip and take presses the same way):
//   bubble        over a speaker token (payload.tokenId), with a tail
//   screen bubble payload.screenAnchor and no tokenId: the same bubble, no
//                 tail, bottom of the screen (FU.Dialog.show screen:true)
//   message box   payload.box = { look }: a square window bottom-centre, with
//                 a portrait column, the name and a press arrow. Drawn on every
//                 client of the scene, token or no token.
//                 look "parchment"   the game's parchment (default)
//                      "overPicture" dark see-through, for over a Show Picture
//                 payload.mode still applies: shout = jagged box with a shake,
//                 think = parchment with italic text.
//                 It keeps the bubble's lifecycle: the element's id is the
//                 bubbleId, it leaves the DOM when the line closes, and
//                 control(bubbleId, "complete" | "close") drives it.
//
// Developer font option (payload.font, not in the event editor):
//   "default" | "pixelify" | any CSS font-family string. resolveTextFont()
//   turns it into a CSS value; applyTextFont() sets it as an inline
//   --oni-text-font on the one element drawn, so nothing else changes. It
//   rides the socket payload, so every client draws the same font.
//   (styles/game-font.css: Signika is the default, Pixelify ships.)
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  // Primary message type
  const MSG_TYPE_SHOW = "FU_DIALOG_SHOW_V1";

  // Complete or close a bubble that is already showing, on every client
  const MSG_TYPE_CONTROL = "FU_DIALOG_CONTROL_V1";

  // Optional debug ping (like our test macro)
  const MSG_TYPE_PING = "FU_DIALOG_PING_V1";

  // --- Debug switches ---
  const BOOT_LOG_ALWAYS = true; // always log that this file loaded
  const STORE_KEY = "__FU_DIALOG_UI__";

  // --- UI defaults ---
  const DEFAULT_CPS = 28;

  // Named typing paces a line can ask for (payload.pace) in place of its cps.
  //   slow   a heavy, deliberate voice: each letter takes charMs, and the line
  //          stops for stopMs after each full stop (so "..." trails off).
  const PACES = {
    slow: { charMs: 55, stopMs: 190 }
  };
  const PACE_STOPS = new Set([".", "…"]);
  const HOLD_AFTER_TYPING_MS = 1600;

  // A bubble that waits for a press closes by itself after this long, so an
  // absent player cannot hold the table up. The sender can pass its own.
  const DEFAULT_MAX_WAIT_MS = 30000;
  const OFFSET_Y = 28;
  const BUBBLE_ANCHOR = 0.62;
  const MAX_BUBBLE_WIDTH = 420;
  const MIN_BUBBLE_WIDTH = 420;
  const PORTRAIT_SIZE = 128;
  const PORTRAIT_PULL = -8;

  // Typewriter blip SFX
  const CURSOR_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Cursor1.ogg";
  const SOUND_VOLUME = 0.55;
  const BEEP_GAP_MS = 55;
  const SKIP_WHITESPACE = true;

  // Remote clients playing sound is usually annoying
  const REMOTE_PLAYS_SOUND = false;

  const STYLE_ID = "fu-dialog-speech-style";
  const LAYER_ID = "fu-dialog-speech-layer";

  // The event letterbox (event-rows-media.js draws it; read from the DOM
  // only). While its bottom bar is up the message box sits above it.
  const LETTERBOX_BOTTOM_SELECTOR = "#oni-event-letterbox-layer > .oni-event-letterbox-bar.bottom";
  const LETTERBOX_POLL_MS = 200;

  // ------------------------------------------------------------
  // Pure rules (no DOM): the font option and the message box look.
  // Tested in scripts/dialog-system/message-box.test.mjs.
  // ------------------------------------------------------------

  // Named fonts a line can ask for. "default" = no override (the game font,
  // --oni-text-font from styles/game-font.css).
  const FONT_KEYWORDS = {
    default: null,
    pixelify: "var(--oni-text-font-pixelify)"
  };

  // font option -> a CSS font-family value, or null for "leave it alone".
  // Anything that is not a keyword is taken as a CSS font-family string
  // ('"Cinzel", serif'); characters that could end the declaration are dropped.
  function resolveTextFont(font) {
    if (font === null || font === undefined || typeof font === "object") return null;
    const raw = String(font).trim();
    if (!raw) return null;
    const key = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FONT_KEYWORDS, key)) return FONT_KEYWORDS[key];
    const safe = raw.replace(/[;{}<>\\]/g, "").trim();
    return safe || null;
  }

  // The message box's look. "parchment" and "overPicture" are kept; anything
  // else ("auto") is overPicture while a picture is up, parchment otherwise.
  const BOX_LOOKS = ["parchment", "overPicture"];
  function resolveBoxLook(look, pictureShown = false) {
    if (BOX_LOOKS.includes(look)) return look;
    return pictureShown ? "overPicture" : "parchment";
  }

  // Is a Show Picture up on this client? (event-rows-picture.js adds the
  // API; without it, no.)
  function picturesShown() {
    try { return !!window.oni?.EventSystem?.Pictures?.anyShown?.(); }
    catch (_) { return false; }
  }

  // The font option on one element: an inline --oni-text-font (and the
  // family that reads it), or nothing when the line has no font.
  function applyTextFont(el, font) {
    if (!el?.style) return null;
    const value = resolveTextFont(font);
    if (!value) {
      el.style.removeProperty("--oni-text-font");
      el.style.removeProperty("font-family");
      el.style.removeProperty("font-variant-ligatures");
      return null;
    }
    el.style.setProperty("--oni-text-font", value);
    el.style.setProperty("font-family", "var(--oni-text-font)");
    el.style.setProperty("font-variant-ligatures", "none");
    return value;
  }

  // The event letterbox's bottom bar is up (and not on its way out: going
  // out it is set to height 0 at once, then removed).
  function letterboxUp() {
    const bar = document.querySelector(LETTERBOX_BOTTOM_SELECTOR);
    return !!bar && (parseFloat(bar.style.height) || 0) > 0;
  }

  const reducedMotion = () => {
    try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; }
    catch (_) { return false; }
  };

  const store = (globalThis[STORE_KEY] ??= {
    installed: false,
    handler: null,
    seen: new Set(),
  });

  // Showing bubbles by id, so one can be completed or closed from outside.
  store.bubbles ??= new Map();
  store.pendingControl ??= new Map();

  const boot = (...args) => {
    if (BOOT_LOG_ALWAYS) console.debug("%c[FU Dialog:UI][BOOT]", "color:#7dd3fc", ...args);
  };
  const debug = (...args) => {
    const d = globalThis?.FU?.Dialog?.DEBUG;
    if (d) console.log("%c[FU Dialog:UI]", "color:#7dd3fc", ...args);
  };
  const warn = (...args) => console.warn("%c[FU Dialog:UI]", "color:#fbbf24", ...args);
  const err  = (...args) => console.error("%c[FU Dialog:UI]", "color:#fb7185", ...args);

  boot("dialog-ui.js loaded", {
    moduleId: MODULE_ID,
    channel: SOCKET_CHANNEL,
    user: game?.user?.name,
    userId: game?.user?.id
  });

  const htmlEscape = (v) => {
    const d = document.createElement("div");
    d.textContent = (v ?? "").toString();
    return d.innerHTML;
  };

  function randomID(n = 10) {
    const s = "abcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    while (r.length < n) r += s[(Math.random() * s.length) | 0];
    return r;
  }

  async function waitCanvasReady(timeoutMs = 3000) {
    const start = Date.now();
    while (!canvas?.ready) {
      await new Promise((r) => setTimeout(r, 50));
      if (Date.now() - start > timeoutMs) break;
    }
    return !!canvas?.ready;
  }

  function getTokenOnCanvas(tokenId) {
    return canvas?.tokens?.get?.(tokenId) ?? canvas?.tokens?.placeables?.find?.(t => t?.document?.id === tokenId);
  }

  async function playOneShot(url, volume = 1.0) {
    try {
      if (window.AudioHelper?.play) {
        await AudioHelper.play({ src: url, volume, autoplay: true, loop: false }, true);
        return;
      }
    } catch (_) {}

    try {
      const a = new Audio(url);
      a.volume = volume;
      a.addEventListener("ended", () => a.remove());
      await a.play().catch(() => {});
    } catch (_) {}
  }

  // Hint markup: <b>…</b> is typed out bold in the hint colour; any other tag stays literal text.
  function parseHintMarkup(raw) {
    const segments = [];
    let hint = false;
    for (const part of String(raw ?? "").split(/(<\/?b>)/i)) {
      if (/^<b>$/i.test(part)) { hint = true; continue; }
      if (/^<\/b>$/i.test(part)) { hint = false; continue; }
      if (part) segments.push({ text: part, hint });
    }
    return segments;
  }

  function renderHintSegments(el, segments, count) {
    el.replaceChildren();
    let left = count;
    for (const seg of segments) {
      if (left <= 0) break;
      const piece = seg.text.slice(0, left);
      left -= piece.length;
      if (seg.hint) {
        const b = document.createElement("b");
        b.className = "fu-hint";
        b.textContent = piece;
        el.appendChild(b);
      } else {
        el.appendChild(document.createTextNode(piece));
      }
    }
  }

  function ensureLayerAndStyles() {
    if (!document.getElementById(STYLE_ID)) {
      const css = document.createElement("style");
      css.id = STYLE_ID;
      css.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 100000;
  font-family: var(--oni-text-font, "Signika", sans-serif); font-variant-ligatures: none; }

.fu-bubble { position: absolute; pointer-events: auto; display: flex; align-items: stretch;
  max-width: min(${MAX_BUBBLE_WIDTH}px, 92vw); min-width: ${MIN_BUBBLE_WIDTH}px;
  transform-origin: var(--tail-x, 48px) calc(100% + 14px); }
.fu-enter { animation: fu-grow .18s ease-out both; }
.fu-exit  { animation: fu-shrink .15s ease-in both; }
@keyframes fu-grow   { from { transform: scale(.72); opacity: 0 } to { transform: scale(1); opacity: 1 } }
@keyframes fu-shrink { from { transform: scale(1);   opacity: 1 } to { transform: scale(.72); opacity: 0 } }

/* Portrait column */
.fu-left { border-radius: 18px 0 0 18px; padding: 6px; margin-right: ${PORTRAIT_PULL}px;
  display: flex; align-items: center; justify-content: center; background: transparent; }
.fu-left img { width: ${PORTRAIT_SIZE}px; height: ${PORTRAIT_SIZE}px; object-fit: contain; background: transparent;
  border-radius: 14px; box-shadow: none !important; border: 0 !important; outline: 0 !important; filter: none !important; }

/* ===== Normal (FFT parchment) ======================================= */
.fu-paper { position: relative; flex: 1; background: #e8e0cf; color: #2b261f;
  border-radius: 0 18px 18px 18px; overflow: hidden; box-shadow: 0 6px 10px rgba(0,0,0,.45); }
.fu-bubble:not(.mode-shout):not(.mode-think) .fu-paper::before {
  content:""; position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(1200px 600px at 0% 0%, rgba(255,255,255,.35), transparent 70%),
    radial-gradient(800px 400px at 100% 0%, rgba(255,255,255,.25), transparent 70%),
    radial-gradient(1000px 800px at 50% 120%, rgba(0,0,0,.06), transparent 60%);
  mix-blend-mode: multiply; opacity:.6;
}
.fu-name { font-weight:700; font-size:1.05rem; letter-spacing:.02em; color:#2a1c0f;
  text-shadow:0 1px 0 rgba(255,255,255,.6); margin:12px 16px 6px; }
.fu-text { font-size:1.05rem; line-height:1.5; min-height:2.7em; margin:0 16px 14px; }
.fu-bubble:not(.mode-shout):not(.mode-think) .fu-text { color: var(--oni-text-ink, #5b4f40); }
.fu-hint { font-weight:800; color:#a3231f; }
.fu-tail { position:absolute; bottom:-16px; left:44px; width:0; height:0;
  border-left:14px solid transparent; border-right:14px solid transparent; border-top:16px solid #e8e0cf;
  filter: drop-shadow(0 -2px 0 rgba(0,0,0,.08)); }

/* ===== SHOUT (jagged box, NO TAIL) ================================== */
.mode-shout .fu-paper { background: transparent; border-radius:0; box-shadow:none; overflow:visible; }
.mode-shout .fu-name  { margin:12px 16px 6px; font-weight:700; color:#16120c; text-shadow:none; }
.mode-shout .fu-text  { margin:0 16px 14px; font-weight:700; letter-spacing:.02em; }

.mode-shout .fu-paper { position: relative; }
.mode-shout .fu-paper::before {
  content:""; position:absolute; inset:-8px; z-index:-1; background:#fffdf6;
  clip-path: polygon(
    3% 15%, 8% 5%, 16% 12%, 25% 4%, 33% 12%, 43% 5%, 52% 13%, 62% 6%,
    69% 14%, 78% 8%, 84% 16%, 92% 12%, 96% 22%, 92% 34%, 98% 41%,
    92% 49%, 97% 58%, 90% 66%, 96% 74%, 88% 82%, 92% 90%, 82% 94%,
    75% 88%, 66% 96%, 58% 88%, 49% 96%, 41% 88%, 33% 94%, 26% 86%,
    18% 92%, 12% 84%, 8% 74%, 5% 66%, 8% 57%, 3% 48%, 8% 40%, 2% 30%
  );
  box-shadow: 0 0 0 3px #15110a, 0 10px 16px rgba(0,0,0,.35);
  opacity: 1 !important;
  pointer-events: none;
}
.mode-shout .fu-tail { display:none !important; }

/* ===== THINK (cloud + dotted tail) ================================== */
.mode-think .fu-paper {
  background:#fffdf6; color:#16120c;
  border-radius: 28px; overflow: visible;
  box-shadow: 0 0 0 3px #15110a, 0 8px 14px rgba(0,0,0,.28);
}
.mode-think .fu-name { margin:12px 16px 6px; font-weight:700; color:#16120c; text-shadow:none; }
.mode-think .fu-text { margin:0 16px 14px; }
.mode-think .fu-tail { display:none !important; }

.fu-next { position:absolute; right: 12px; bottom: 4px; font-size: 12px; line-height: 1;
  color: rgba(40,28,16,0.85); opacity: 0; pointer-events: none; }
.fu-bubble.fu-awaiting .fu-next { animation: fu-next-bob 900ms ease-in-out infinite; }
@keyframes fu-next-bob {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(3px); }
}
.fu-think-tail { position:absolute; bottom:-40px; left:0; width: 0; height: 0; pointer-events:none; }
.mode-think .fu-think-tail { display:block; }
.fu-think-tail .dot {
  position:absolute; border-radius:50%;
  background:#fffdf6; box-shadow: 0 0 0 3px #15110a, 0 4px 6px rgba(0,0,0,.2);
}
.fu-think-tail .dot.d1 { width:22px; height:22px; }
.fu-think-tail .dot.d2 { width:16px; height:16px; }
.fu-think-tail .dot.d3 { width:10px; height:10px; }

/* ===== Message box (payload.box): JRPG square text window ===========
   Ported from the approved mockup (user, 2026-11-18). Centred with auto
   margins, so transform stays free for the shout's shake. */
.fu-mbox { position:absolute; left:0; right:0; margin:0 auto; bottom:5vh; box-sizing:border-box;
  width:min(74vw, 900px); display:grid; grid-template-columns:auto 1fr; gap:2%; align-items:start;
  padding:1.2% 1.6%; background:#ece2c6; color:var(--oni-text-ink, #5b4f40);
  border:3px solid #6a4a26; box-shadow:0 0 0 2px #2a1a0a;
  font:500 clamp(11px, 1.55vw, 21px)/1.4 var(--oni-text-font, "Signika", sans-serif);
  font-variant-ligatures:none; cursor:pointer; pointer-events:auto;
  transition:bottom .25s ease-out; }
.fu-mbox.no-portrait { grid-template-columns:1fr; }
.fu-mbox-portrait { display:block; width:clamp(36px, 6.5vw, 92px); aspect-ratio:1; object-fit:cover;
  object-position:50% 12%; background:#d7c9a3; border:2px solid #6a4a26; image-rendering:pixelated; }
.fu-mbox-body { min-width:0; }
.fu-mbox-name { font-weight:700; color:#7a2e18; margin-bottom:2px; }
.fu-mbox-text { white-space:pre-wrap; overflow-wrap:anywhere; min-height:2.8em; }
.fu-mbox-next { position:absolute; right:10px; bottom:6px; font-size:.8em; line-height:1; color:#7a5a30;
  visibility:hidden; pointer-events:none; }
.fu-mbox.fu-awaiting .fu-mbox-next { visibility:visible; animation:fu-mbox-bob .8s ease-in-out infinite alternate; }
@keyframes fu-mbox-bob { from { transform:translateY(0) } to { transform:translateY(3px) } }

.fu-mbox-enter { animation:fu-mbox-in .16s ease-out both; }
.fu-mbox-exit  { animation:fu-mbox-out .15s ease-in both; }
@keyframes fu-mbox-in  { from { opacity:0 } to { opacity:1 } }
@keyframes fu-mbox-out { from { opacity:1 } to { opacity:0 } }

/* Think: parchment, italic text. */
.fu-mbox.mode-think .fu-mbox-text { font-style:italic; }

/* Over a picture: dark and see-through. */
.fu-mbox.look-over { bottom:3vh; width:min(80vw, 980px); background:rgba(10,8,16,.72); color:#f1ead8;
  border:1px solid rgba(220,200,160,.45); box-shadow:none; }
.fu-mbox.look-over .fu-mbox-text { color:#f1ead8; }
.fu-mbox.look-over .fu-mbox-name { color:#f2cf7a; }
.fu-mbox.look-over .fu-mbox-portrait { background:rgba(0,0,0,.35); border-color:rgba(220,200,160,.5); }
.fu-mbox.look-over .fu-mbox-next { color:#e8d7a8; }
.fu-mbox.look-over .fu-hint { color:#ffd76a; }

/* Shout: a jagged bright box that shakes as it appears. */
.fu-mbox.mode-shout { background:#fff6dc; border-color:#8a1e10; padding:2.2% 3%;
  clip-path:polygon(0% 8%, 4% 0%, 9% 9%, 15% 0%, 21% 8%, 28% 0%, 35% 8%, 42% 0%, 49% 9%, 56% 0%, 63% 8%, 70% 0%, 77% 9%, 84% 0%, 91% 8%, 96% 0%, 100% 9%, 98% 50%, 100% 91%, 96% 100%, 91% 92%, 84% 100%, 77% 91%, 70% 100%, 63% 92%, 56% 100%, 49% 91%, 42% 100%, 35% 92%, 28% 100%, 21% 92%, 15% 100%, 9% 91%, 4% 100%, 0% 92%, 2% 50%); }
.fu-mbox.mode-shout .fu-mbox-text { font-weight:700; color:var(--oni-text-ink, #5b4f40); }
.fu-mbox.mode-shout .fu-mbox-name { color:#7a2e18; }
.fu-mbox.mode-shout .fu-mbox-next { color:#7a5a30; }
.fu-mbox.mode-shout.fu-mbox-enter { animation:fu-mbox-shake .26s linear both; }
@keyframes fu-mbox-shake {
  0% { transform:translateX(0) } 15% { transform:translateX(-6px) } 30% { transform:translateX(6px) }
  45% { transform:translateX(-6px) } 60% { transform:translateX(6px) } 80% { transform:translateX(-3px) }
  100% { transform:translateX(0) }
}

/* Above the event letterbox's bottom bar while it is up (after look-over, so it wins). */
.fu-mbox.fu-mbox-letterbox { bottom:13vh; }

@media (prefers-reduced-motion: reduce) {
  .fu-mbox, .fu-mbox-next, .fu-mbox.fu-awaiting .fu-mbox-next { animation:none !important; transition:none !important; }
}
      `;
      document.head.appendChild(css);
      debug("CSS injected", STYLE_ID);
    }

    let layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = LAYER_ID;
      document.body.appendChild(layer);
      debug("Layer created", LAYER_ID);
    }
    return layer;
  }

  // How a line types out: { typeMs, countAt(ms) } where countAt says how many
  // characters show `ms` after the line started. `text` is the plain text
  // (markup already taken out). Without a named pace it is the line's own
  // speed in characters per second, exactly as it always was.
  function linePace(text, { speed = DEFAULT_CPS, pace = null } = {}) {
    const chars = Array.from(String(text ?? ""));
    // Counted in UTF-16 units, as the typewriter slices the string.
    const units = String(text ?? "").length;
    const named = PACES[pace];

    if (!named) {
      const cps = Math.max(1, Number(speed) || DEFAULT_CPS);
      return {
        typeMs: Math.ceil((units / cps) * 1000),
        countAt: (ms) => Math.max(0, Math.min(units, Math.floor((ms * cps) / 1000)))
      };
    }

    // at[i]: when the first i+1 units are showing. A stop holds the letter
    // after it back; nothing waits after the last letter.
    const at = [];
    let t = 0;
    for (const ch of chars) {
      t += named.charMs;
      for (let k = 0; k < ch.length; k += 1) at.push(t);
      if (PACE_STOPS.has(ch)) t += named.stopMs;
    }
    const typeMs = at.length ? at[at.length - 1] : 0;

    return {
      typeMs,
      countAt: (ms) => {
        // The count of entries <= ms (at is sorted).
        let lo = 0, hi = at.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (at[mid] <= ms) lo = mid + 1; else hi = mid;
        }
        return lo;
      }
    };
  }

  // Type one line and handle its presses. Shared by every style of line (a
  // bubble on a token, floating text), so they all type at the same pace, play
  // the same blip and take a press the same way.
  //   box      the element that carries the line (it gets .fu-awaiting, and clicks)
  //   typed    the element the text is typed into
  //   leave()  called once when the line closes; the caller then removes its
  //            element, or leaves it standing
  // Returns { close, dispose, finished }: dispose() from the caller's own
  // cleanup; finished resolves when the line has closed.
  function runLine({ box, typed, payload, remote, id, leave }) {
    let lastBeep = 0;
    function blipMaybe(char) {
      if (SKIP_WHITESPACE && /^\s$/.test(char)) return;
      const now = performance.now();
      if (now - lastBeep < BEEP_GAP_MS) return;
      lastBeep = now;

      if (!remote || REMOTE_PLAYS_SOUND) playOneShot(CURSOR_URL, SOUND_VOLUME);
    }

    const segments = parseHintMarkup(payload.text);
    const full = segments.map(s => s.text).join("");
    // payload.pace ("slow") or the line's own speed in characters per second.
    const pace = linePace(full, { speed: payload.speed, pace: payload.pace });
    const typeMs = pace.typeMs;
    const startedAt = performance.now();

    // waitForInput: the line stays up until someone presses, then closes.
    // controlled: presses are not handled here; whoever runs the dialogue
    // decides, and tells every client through control().
    // holdMs: a line that does not wait closes this long after it is complete
    // (default: as long again as it took to type, plus a hold).
    const waitForInput = payload.waitForInput === true;
    const controlled = payload.controlled === true;
    const maxWaitMs = Number(payload.maxWaitMs) > 0 ? Number(payload.maxWaitMs) : DEFAULT_MAX_WAIT_MS;
    const holdMs = Number(payload.holdMs) > 0 ? Number(payload.holdMs) : null;

    let shown = 0, done = false, closing = false;
    let autoTimer = null, doneTimer = null;

    let resolveFinished;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });

    function scheduleAutoClose() {
      // A remote copy of a waiting bubble leaves the closing to the sender,
      // and only closes by itself if that message never comes.
      const totalMs = waitForInput
        ? maxWaitMs + (remote ? 3000 : 0)
        : (holdMs ?? Math.max(1200, typeMs + HOLD_AFTER_TYPING_MS));
      autoTimer?.clear();
      // Stops counting while the game is paused (pause-screen/pause-clock.js).
      const clock = window.oni?.Pause;
      if (clock) autoTimer = clock.timeout(() => closeLine(), totalMs);
      else { const handle = setTimeout(() => closeLine(), totalMs); autoTimer = { clear: () => clearTimeout(handle) }; }
    }

    function markDone() {
      if (done) return;
      done = true;
      if (doneTimer) clearTimeout(doneTimer);
      doneTimer = null;

      shown = full.length;
      renderHintSegments(typed, segments, full.length);
      if (waitForInput) box.classList.add("fu-awaiting");
      scheduleAutoClose();
    }

    // The clock decides when the line is complete. The frame loop below only
    // draws, so a hidden window (where frames stop) still finishes on time.
    doneTimer = setTimeout(markDone, typeMs);

    function typeTick() {
      if (!box.isConnected || done) return;

      const target = pace.countAt(performance.now() - startedAt);
      if (target > shown) {
        const ch = full.slice(target - 1, target);
        shown = target;
        renderHintSegments(typed, segments, shown);
        blipMaybe(ch);
      }

      if (shown >= full.length) {
        markDone();
        return;
      }
      requestAnimationFrame(typeTick);
    }
    requestAnimationFrame(typeTick);

    function closeLine() {
      if (closing) return;
      closing = true;

      if (!done) markDone();
      autoTimer?.clear();
      autoTimer = null;

      box.classList.remove("fu-awaiting");
      try { leave(); } finally { resolveFinished(); }
    }

    function handleClick() {
      if (game.paused) return; // nothing advances during a pause
      if (controlled) {
        Hooks.callAll("fuDialogBubblePress", { bubbleId: id });
        return;
      }
      (!done) ? markDone() : closeLine();
    }
    box.addEventListener("click", handleClick);

    store.bubbles.set(id, {
      isDone: () => done,
      complete: markDone,
      close: closeLine
    });

    // A control message can beat its bubble here.
    const early = store.pendingControl.get(id);
    if (early) {
      store.pendingControl.delete(id);
      early === "close" ? closeLine() : markDone();
    }

    function dispose() {
      autoTimer?.clear();
      if (doneTimer) clearTimeout(doneTimer);
      store.bubbles.delete(id);
      box.removeEventListener("click", handleClick);
      resolveFinished();
    }

    return { close: closeLine, dispose, finished };
  }

  async function renderBubble(token, payload, { remote = false } = {}) {
    const layer = ensureLayerAndStyles();

    const mode = (payload.mode || "normal");
    const isShout = mode === "shout";
    const isThink = mode === "think";
    // token null = a screen-anchored line (payload.screenAnchor): bottom of the
    // screen, no tail; the portrait column only when there is a picture.
    const onScreen = !token;
    const portraitSrc = onScreen
      ? (payload.portraitSrc || "")
      : (payload.portraitSrc ||
        token.actor?.img ||
        token.document?.texture?.src ||
        token.texture?.src ||
        "icons/svg/mystery-man.svg");

    const id = payload.bubbleId || `fu-bubble-${randomID(8)}`;

    const box = document.createElement("div");
    box.className = "fu-bubble fu-enter";
    if (isShout) box.classList.add("mode-shout");
    if (isThink) box.classList.add("mode-think");
    box.id = id;
    // payload.font: the developer font option, on this bubble only.
    applyTextFont(box, payload.font);

    box.innerHTML = `
      ${portraitSrc ? `<div class="fu-left"><img alt="portrait" src="${htmlEscape(portraitSrc)}"/></div>` : ""}
      <div class="fu-paper">
        <div class="fu-name">${htmlEscape(payload.name || token?.document?.name || "Speaker")}</div>
        <div class="fu-text"><span class="fu-typed"></span></div>
        <div class="fu-next">&#9660;</div>
        <div class="fu-tail"></div>
        <div class="fu-think-tail" style="display:${isThink ? "block" : "none"};">
          <div class="dot d1"></div>
          <div class="dot d2"></div>
          <div class="dot d3"></div>
        </div>
      </div>
    `;
    layer.appendChild(box);
    if (onScreen) {
      const tail = box.querySelector(".fu-tail");
      if (tail) tail.style.display = "none";
      box.style.width = `min(${MAX_BUBBLE_WIDTH}px, 92vw)`;
    }

    function getScreenXY() {
      const gp = token.mesh.getGlobalPosition();
      const h = token.mesh.height ?? (token.w ?? 100);
      return { x: gp.x, y: gp.y - h * BUBBLE_ANCHOR - OFFSET_Y };
    }

    function place() {
      if (!box.isConnected) return;
      const rect = box.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      if (onScreen) {
        box.style.left = `${Math.max(6, (vw - rect.width) / 2)}px`;
        box.style.top = `${Math.max(6, vh - rect.height - Math.round(vh * 0.08))}px`;
        return;
      }
      const { x, y } = getScreenXY();

      let left = x - Math.min(160, rect.width * 0.25);
      let top = y - rect.height;

      left = Math.max(6, Math.min(left, vw - rect.width - 24));
      top = Math.max(6, Math.min(top, vh - rect.height - 6));

      box.style.left = `${left}px`;
      box.style.top = `${top}px`;

      const leftRect = box.querySelector(".fu-left")?.getBoundingClientRect();
      const leftW = leftRect ? leftRect.width : 0;
      const tailX = 44 + leftW;
      box.style.setProperty("--tail-x", `${tailX}px`);

      if (isThink) {
        const paper = box.querySelector(".fu-paper");
        const paperRect = paper.getBoundingClientRect();
        const px = tailX;

        const tail = paper.querySelector(".fu-think-tail");
        const d1 = tail.querySelector(".d1");
        const d2 = tail.querySelector(".d2");
        const d3 = tail.querySelector(".d3");

        d1.style.left = `${Math.max(12, px - paperRect.left - 12)}px`;
        d1.style.top = `-8px`;
        d2.style.left = `${Math.max(6, px - paperRect.left - 26)}px`;
        d2.style.top = `10px`;
        d3.style.left = `${Math.max(0, px - paperRect.left - 34)}px`;
        d3.style.top = `26px`;
      }
    }

    const onPan = () => place();
    const onResize = () => place();
    const onMove = () => place();

    Hooks.on("canvasPan", onPan);
    window.addEventListener("resize", onResize);
    Hooks.on("updateToken", onMove);
    Hooks.on("controlToken", onMove);

    canvas.app.ticker.add(place, undefined, PIXI.UPDATE_PRIORITY.LOW);
    place();

    // Typing, the blip, presses and closing are shared with floating text.
    const line = runLine({
      box,
      typed: box.querySelector(".fu-typed"),
      payload,
      remote,
      id,
      leave: () => {
        box.classList.remove("fu-enter");
        box.classList.add("fu-exit");

        const finish = () => {
          box.removeEventListener("animationend", finish);
          cleanup();
        };
        box.addEventListener("animationend", finish);

        // A hidden window does not run the exit animation; do not wait on it.
        setTimeout(finish, 600);
      }
    });

    const onDelete = (doc) => { if (token && doc.id === token.document.id) line.close(); };
    Hooks.on("preDeleteToken", onDelete);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        line.dispose();

        Hooks.off("canvasPan", onPan);
        window.removeEventListener("resize", onResize);
        Hooks.off("updateToken", onMove);
        Hooks.off("controlToken", onMove);
        Hooks.off("preDeleteToken", onDelete);

        canvas.app.ticker.remove(place);
        box.remove();

        const layer = document.getElementById(LAYER_ID);
        if (layer && !layer.children.length) layer.remove();
      } catch (_) {}
    }
  }

  // The message box (payload.box): a square window at the bottom centre of
  // the screen. Needs no token, so every client of the scene draws it. The
  // sender decides everything (look, portrait, name), so all clients match.
  //   payload.box.look   "parchment" | "overPicture"
  //   payload.portraitSrc  the picture, or empty for no portrait column
  //   payload.name         the speaker's name; empty hides the name line
  function renderMessageBox(payload, { remote = false } = {}) {
    const layer = ensureLayerAndStyles();

    const mode = payload.mode || "normal";
    const look = resolveBoxLook(payload.box?.look, false);
    const id = payload.bubbleId || `fu-bubble-${randomID(8)}`;
    const portraitSrc = String(payload.portraitSrc || "").trim();
    const name = String(payload.name || "").trim();

    const box = document.createElement("div");
    box.className = `fu-mbox fu-mbox-enter ${look === "overPicture" ? "look-over" : "look-parchment"}`;
    if (mode === "shout") box.classList.add("mode-shout");
    if (mode === "think") box.classList.add("mode-think");
    if (!portraitSrc) box.classList.add("no-portrait");
    box.id = id;
    applyTextFont(box, payload.font);

    box.innerHTML = `
      ${portraitSrc ? `<img class="fu-mbox-portrait" alt="" src="${htmlEscape(portraitSrc)}"/>` : ""}
      <div class="fu-mbox-body">
        ${name ? `<div class="fu-mbox-name">${htmlEscape(name)}</div>` : ""}
        <div class="fu-mbox-text"><span class="fu-typed"></span></div>
      </div>
      <div class="fu-mbox-next">&#9660;</div>
    `;

    // A picture that does not load leaves no broken frame: the column goes.
    const img = box.querySelector(".fu-mbox-portrait");
    img?.addEventListener("error", () => {
      img.remove();
      box.classList.add("no-portrait");
    }, { once: true });

    // Above the letterbox while it is up; it can come or go mid-line.
    const syncLetterbox = () => box.classList.toggle("fu-mbox-letterbox", letterboxUp());
    syncLetterbox();
    layer.appendChild(box);
    const letterboxTimer = setInterval(syncLetterbox, LETTERBOX_POLL_MS);

    // Typing, the blip, presses and closing: the same as every other line.
    const line = runLine({
      box,
      typed: box.querySelector(".fu-typed"),
      payload,
      remote,
      id,
      leave: () => {
        if (reducedMotion() || document.visibilityState === "hidden") { cleanup(); return; }
        box.classList.remove("fu-mbox-enter");
        box.classList.add("fu-mbox-exit");

        const finish = () => {
          box.removeEventListener("animationend", finish);
          cleanup();
        };
        box.addEventListener("animationend", finish);
        // A hidden window does not run the exit animation; do not wait on it.
        setTimeout(finish, 600);
      }
    });

    // The box belongs to its scene.
    const onTearDown = () => line.close();
    Hooks.on("canvasTearDown", onTearDown);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        line.dispose();
        clearInterval(letterboxTimer);
        Hooks.off("canvasTearDown", onTearDown);
        box.remove();

        const layerEl = document.getElementById(LAYER_ID);
        if (layerEl && !layerEl.children.length) layerEl.remove();
      } catch (_) {}
    }
  }

  function applyControl(bubbleId, action) {
    const id = String(bubbleId || "");
    if (!id) return false;

    const bubble = store.bubbles.get(id);
    if (!bubble) {
      // Not drawn here yet: keep it for a moment in case the bubble is on its way.
      store.pendingControl.set(id, action);
      setTimeout(() => store.pendingControl.delete(id), 3000);
      return false;
    }

    action === "close" ? bubble.close() : bubble.complete();
    return true;
  }

  // Complete ("complete") or close ("close") a showing bubble here and, by
  // default, on every other client.
  function control(bubbleId, action, { broadcast = true } = {}) {
    const safeAction = action === "close" ? "close" : "complete";
    applyControl(bubbleId, safeAction);

    if (broadcast) {
      try {
        game.socket.emit(SOCKET_CHANNEL, {
          type: MSG_TYPE_CONTROL,
          payload: { bubbleId: String(bubbleId || ""), action: safeAction }
        });
      } catch (e) {
        warn("control broadcast failed", e);
      }
    }
  }

  function installListener() {
    boot("installListener called", { installed: store.installed, channel: SOCKET_CHANNEL });

    if (!game?.socket?.on) {
      err("game.socket.on missing — cannot install listener");
      return;
    }

    // if rerun somehow, remove old handler
    if (store.installed && store.handler) {
      try { game.socket.off(SOCKET_CHANNEL, store.handler); } catch (_) {}
      store.installed = false;
      store.handler = null;
      boot("old handler removed");
    }

    store.handler = async (data) => {
      try {
        debug("SOCKET RECEIVE raw", data);

        if (!data || typeof data !== "object") return;

        // Optional ping debug
        if (data.type === MSG_TYPE_PING) {
          boot("PING received ✅", data.payload);
          return;
        }

        if (data.type === MSG_TYPE_CONTROL) {
          applyControl(data.payload?.bubbleId, data.payload?.action);
          return;
        }

        if (data.type !== MSG_TYPE_SHOW) return;

        const payload = data.payload;
        if (!payload) return;

        if (payload.bubbleId && store.seen.has(payload.bubbleId)) return;
        if (payload.bubbleId) store.seen.add(payload.bubbleId);

        if (!canvas?.ready) await waitCanvasReady(3000);

        if (!canvas?.scene?.id || canvas.scene.id !== payload.sceneId) return;

        // Floating text is not anchored to a speaker token.
        if (payload.mode === "float") {
          await globalThis.FU?.DialogUI?.renderFloat?.(payload, { remote: true });
          return;
        }

        // The message box needs no token: every client of the scene draws it.
        if (payload.box) {
          renderMessageBox(payload, { remote: true });
          return;
        }

        if (payload.screenAnchor && !payload.tokenId) {
          await renderBubble(null, payload, { remote: true });
          return;
        }

        const token = getTokenOnCanvas(payload.tokenId);
        if (!token) return;

        debug("receive SHOW", payload);
        await renderBubble(token, payload, { remote: true });
      } catch (e) {
        warn("socket handler error", e);
      }
    };

    game.socket.on(SOCKET_CHANNEL, store.handler);
    store.installed = true;

    boot("listener installed ✅", { channel: SOCKET_CHANNEL, showType: MSG_TYPE_SHOW, pingType: MSG_TYPE_PING });
  }

  // ✅ Overwrite-proof assignment (prevents other scripts from clobbering this object)
  globalThis.FU = globalThis.FU ?? {};
  globalThis.FU.DialogUI = globalThis.FU.DialogUI ?? {};
  Object.assign(globalThis.FU.DialogUI, {
    MSG_TYPE_SHOW,
    MSG_TYPE_PING,
    MSG_TYPE_CONTROL,
    SOCKET_CHANNEL,
    installListener,
    control,
    // For other styles of line (dialog-float.js): the shared typewriter.
    runLine,
    // How long a line takes to type (Show Text sizes its timeout with it).
    linePace,
    PACES,
    randomID,
    // The developer font option and the message box look (pure; shared with
    // dialog-core.js, dialog-float.js and FU.SystemMessage).
    resolveTextFont,
    applyTextFont,
    resolveBoxLook,
    picturesShown,
    FONT_KEYWORDS,
    BOX_LOOKS,
    isShowing: (bubbleId) => store.bubbles.has(String(bubbleId || "")),
    isDone: (bubbleId) => !!store.bubbles.get(String(bubbleId || ""))?.isDone(),
    renderFromPayload: async (payload, { remote = false } = {}) => {
      if (!canvas?.ready) await waitCanvasReady(3000);

      // Floating text is not anchored to a speaker token (dialog-float.js).
      if (payload?.mode === "float") {
        if (!canvas?.scene?.id || canvas.scene.id !== payload.sceneId) return;
        return globalThis.FU?.DialogUI?.renderFloat?.(payload, { remote });
      }

      if (!canvas?.scene?.id || canvas.scene.id !== payload.sceneId) return;
      if (payload?.box) return renderMessageBox(payload, { remote });
      if (payload?.screenAnchor && !payload?.tokenId) return renderBubble(null, payload, { remote });
      if (!payload?.tokenId) return;

      const token = getTokenOnCanvas(payload.tokenId);
      if (!token) return;

      return renderBubble(token, payload, { remote });
    }
  });

  // Auto-install listener on startup (like our test macro installer)
  Hooks.once("ready", () => {
    boot("Hooks.ready fired → installing listener");
    installListener();
  });

})();
