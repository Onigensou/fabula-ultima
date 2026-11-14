// ============================================================================
// System Message Panel — FU.SystemMessage
//
// The JRPG battle text box: one short line under the turn order, in the
// game's wood / gold-hairline / parchment frame (approved on mockup v2,
// 2026-11-10). For the game reporting what happened ("Rakshasa A draws its
// Mace!"), a boss speaking, narration, and warnings.
//
//   FU.SystemMessage.show("Rakshasa A's resistance to {w:Swords} {up:increased}!")
//   FU.SystemMessage.show({ kind: "speech", speaker: "Rakshasa", text: "…" })
//   await FU.SystemMessage.queue([lineA, lineB], { onShow: (i) => … })
//   FU.SystemMessage.broadcast(lineOrLines)   // every client (incl. this one)
//   FU.SystemMessage.clear()
//   FU.SystemMessage.configure({ widthPct, topPct, enter, … })
//
// Markup: {w:…} name (umber) · {up:…} increase (warm ▲) · {down:…} decrease
// (cool ▼) · {flat:…} muted · {st:Slow} a status, its icon in front (the line
// waits up to 300 ms for icons to load) · {p:The party} the whole party.
// Text is set with textContent — never HTML.
//
// Kinds: system (default) · speech (name plate, italic) · alert (crimson
// hairline + seal) · narration (types letter by letter by default).
// Per-line options: reveal "instant"|"type", advance "auto"|"press", enter,
// hold (ms). Defaults: system-message-rules.js.
//
// show / queue are LOCAL to this client, which is what an animation script
// wants (it already runs on every client). broadcast() is the GM-side call.
// Nothing here gates the battle: a caller may await a line, nobody has to.
// ============================================================================

import { DEFAULTS, parseMarkup, holdMs, typeMs, normalizeMessage } from "./system-message-rules.js";

const NS = "fabula-ultima-companion";
const SOCKET = `module.${NS}`;
const MSG_TYPE = "FU_SYSMSG_SHOW_V1";
const STYLE_ID = "fu-sysmsg-style";
const HOST_ID = "fu-sysmsg-host";
const TAG = "[FU SystemMessage]";
// The dialog system's blip, so letter-by-letter sounds like every other line.
const BLIP_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Cursor1.ogg";
const BLIP_VOL = 0.55;
const BLIP_GAP_MS = 55;
const LEAVE_MS = 280;
const GRACE_MS = 120;   // a line queued this soon after the last one closes keeps the box open

const cfg = { ...DEFAULTS };
const state = { queue: [], running: false, el: null, abort: null };

// ── styles ──────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
#${HOST_ID} {
  --sm-parch-top:#f6f1e6; --sm-parch-bot:#ebe3d0; --sm-ink:#3a3228; --sm-ink-soft:#6b5d4b;
  --sm-gold-1:#d5b67a; --sm-gold-2:#b7935a; --sm-wood-1:#a87649; --sm-wood-2:#8d5f38; --sm-wood-3:#6f4526;
  --sm-accent:#8a4b22; --sm-up:#b4580f; --sm-down:#4c45a8; --sm-alert:#9b2a1f; --sm-party:#7a2e18;
  position:fixed; left:50%; transform:translateX(-50%); z-index:90; pointer-events:none;
  top:calc(var(--sm-top) * 1vh); width:calc(var(--sm-w) * 1vw);
  font-size:calc(var(--sm-fs) / 1920 * 100vw);
}
#${HOST_ID} .sm { position:relative; padding:.32em; border-radius:.7em; opacity:0;
  background:linear-gradient(180deg,var(--sm-wood-1),var(--sm-wood-2) 45%,var(--sm-wood-3));
  box-shadow:0 .9em 2.4em rgba(0,0,0,.55),0 0 0 1px rgba(40,24,10,.9),0 1px 0 rgba(255,236,190,.35) inset; }
#${HOST_ID} .sm .field { position:relative; display:flex; align-items:center; gap:.7em;
  min-height:calc(3.1em * var(--sm-h)); padding:calc(.62em * var(--sm-h)) 1.5em; border-radius:.48em;
  background:linear-gradient(180deg,var(--sm-parch-top),var(--sm-parch-bot));
  box-shadow:0 0 0 1px var(--sm-gold-2),0 0 0 2px rgba(255,248,225,.75) inset,0 .25em .5em rgba(90,60,25,.18) inset; }
#${HOST_ID} .sm .field::before { content:""; position:absolute; inset:.26em; border:1px solid var(--sm-gold-1);
  border-radius:.3em; pointer-events:none; opacity:.85; }
#${HOST_ID} .sm .text { flex:1; min-width:0; text-align:center; color:var(--sm-ink);
  font:600 1.18em/1.35 "Signika","Inter","Segoe UI",system-ui,sans-serif; letter-spacing:.01em; }
#${HOST_ID} .sm .text .c { opacity:0; } #${HOST_ID} .sm .text .c.on { opacity:1; }
#${HOST_ID} .sm .kw { color:var(--sm-accent); font-weight:800; }
#${HOST_ID} .sm .up { color:var(--sm-up); font-weight:800; }
#${HOST_ID} .sm .up::after { content:" \\25B2"; font-size:.7em; vertical-align:.12em; }
#${HOST_ID} .sm .down { color:var(--sm-down); font-weight:800; }
#${HOST_ID} .sm .down::after { content:" \\25BC"; font-size:.7em; vertical-align:.05em; }
#${HOST_ID} .sm .flat { color:var(--sm-ink-soft); font-weight:700; }
#${HOST_ID} .sm .party { color:var(--sm-party); font-weight:800; }
#${HOST_ID} .sm .ico { width:1.25em; height:1.25em; vertical-align:-.28em; margin-right:.18em; border:0; border-radius:.2em; object-fit:contain; }
#${HOST_ID} .sm .plate { position:absolute; left:1.2em; top:-.95em; z-index:2; padding:.18em .9em .22em; border-radius:.45em;
  background:var(--sm-ink); color:var(--sm-parch-top); border:.12em solid var(--sm-gold-2); box-shadow:0 .18em 0 rgba(41,33,24,.55);
  font:900 .78em/1.2 "Cinzel",Georgia,serif; letter-spacing:.12em; text-transform:uppercase; white-space:nowrap; }
#${HOST_ID} .sm .plate[hidden], #${HOST_ID} .sm .seal[hidden] { display:none; }
#${HOST_ID} .sm.speech .field { padding-top:calc(.85em * var(--sm-h)); }
#${HOST_ID} .sm.speech .text { text-align:left; font-weight:500; font-style:italic; }
#${HOST_ID} .sm.alert .field::before { border-color:var(--sm-alert); border-width:1.5px; }
#${HOST_ID} .sm .seal { flex:none; width:1.7em; height:1.7em; display:grid; place-items:center; border-radius:50%;
  background:radial-gradient(circle at 40% 35%,#c9473a,#7d1d14); color:#fff3df; font:900 1em/1 "Cinzel",Georgia,serif;
  box-shadow:0 0 0 .12em var(--sm-gold-1); }
/* press-to-continue pip: ONLY on a line that waits for the player */
#${HOST_ID} .sm .cue { position:absolute; right:.9em; bottom:.45em; width:.42em; height:.42em; transform:rotate(45deg);
  background:var(--sm-gold-2); opacity:0; }
#${HOST_ID} .sm.wait { pointer-events:auto; cursor:pointer; }
#${HOST_ID} .sm.wait .cue { animation:fu-sm-cue 900ms ease-in-out infinite; }
@keyframes fu-sm-cue { 0%,100% { opacity:.25 } 50% { opacity:1 } }
/* entrances */
#${HOST_ID} .sm[data-enter="slide"] { transform:translateX(-3em); transition:opacity 200ms ease-out, transform 260ms cubic-bezier(.2,.8,.2,1); }
#${HOST_ID} .sm[data-enter="slide"].leaving { transform:translateX(3em); }
#${HOST_ID} .sm[data-enter="drop"] { transform:translateY(-.6em); transition:opacity 180ms ease-out, transform 220ms cubic-bezier(.2,.8,.2,1); }
#${HOST_ID} .sm[data-enter="scale"] { transform:scale(.88); transition:opacity 160ms ease-out, transform 240ms cubic-bezier(.25,1.4,.45,1); }
#${HOST_ID} .sm[data-enter="appear"] { transition:none; }
#${HOST_ID} .sm[data-enter="open"] { transform:scaleX(0); transition:opacity 90ms linear, transform 170ms cubic-bezier(.3,.9,.3,1); }
#${HOST_ID} .sm[data-enter="open"] .field > *, #${HOST_ID} .sm[data-enter="open"] .plate { opacity:0; transition:opacity 120ms ease-out; }
#${HOST_ID} .sm[data-enter="open"].shown .field > *, #${HOST_ID} .sm[data-enter="open"].shown .plate { opacity:1; transition-delay:140ms; }
#${HOST_ID} .sm.shown { opacity:1; transform:none; }
@media (prefers-reduced-motion: reduce) { #${HOST_ID} .sm { transition:none !important; } }
`;
  document.head.appendChild(css);
}

function ensureHost() {
  ensureStyles();
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);
  }
  host.style.setProperty("--sm-w", String(cfg.widthPct));
  host.style.setProperty("--sm-top", String(cfg.topPct));
  host.style.setProperty("--sm-fs", String(cfg.fontPx1080));
  host.style.setProperty("--sm-h", String(cfg.heightScale));
  return host;
}

// ── timing ──────────────────────────────────────────────────────────────
// Real time on purpose, NOT the pause clock dialog lines use. A battle line
// reports something that already happened; frozen by a pause it held the box
// while the battle went on, and the queue then played a minute late (Staging
// World, 2026-11-10). A line that waited too long in the queue is dropped.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastBlip = 0;
function blip(ch) {
  if (/^\s$/.test(ch)) return;
  const now = performance.now();
  if (now - lastBlip < BLIP_GAP_MS) return;
  lastBlip = now;
  try {
    const AH = foundry?.audio?.AudioHelper ?? window.AudioHelper;
    // false = this client only: every client types its own copy
    AH?.play?.({ src: BLIP_URL, volume: BLIP_VOL, autoplay: true, loop: false }, false);
  } catch (e) { /* no sound is fine */ }
}

// ── status icons ({st:Name}) ────────────────────────────────────────────
// By the status's shown name or its id, from the game's own status list.
function statusIcon(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return null;
  for (const s of CONFIG?.statusEffects ?? []) {
    const label = String(game?.i18n?.localize?.(s.name ?? s.label ?? "") ?? s.name ?? "").trim().toLowerCase();
    if (label === key || String(s.id ?? "").toLowerCase() === key) return s.img ?? s.icon ?? null;
  }
  return null;
}

// A line waits (briefly) for its icons, so they never pop in after the text.
const ICON_WAIT_MS = 300;
const _iconReady = new Map();   // src → Promise
function iconsReady(text) {
  const srcs = parseMarkup(text).filter((p) => p.status).map((p) => statusIcon(p.status)).filter(Boolean);
  if (!srcs.length) return Promise.resolve();
  const loads = srcs.map((src) => {
    if (!_iconReady.has(src)) {
      _iconReady.set(src, new Promise((resolve) => {
        const img = new Image();
        img.onload = img.onerror = () => resolve();
        img.src = src;
      }));
    }
    return _iconReady.get(src);
  });
  return Promise.race([Promise.all(loads), sleep(ICON_WAIT_MS)]);
}

// ── one box ─────────────────────────────────────────────────────────────
function buildBox(enter) {
  const el = document.createElement("div");
  el.className = "sm";
  el.dataset.enter = enter;
  el.innerHTML = '<span class="plate" hidden></span><div class="field"><span class="seal" hidden>!</span><div class="text"></div></div><i class="cue"></i>';
  return el;
}

function fillBox(el, msg) {
  el.classList.toggle("speech", msg.kind === "speech");
  el.classList.toggle("alert", msg.kind === "alert");
  el.classList.remove("wait");
  const plate = el.querySelector(".plate");
  plate.hidden = !msg.speaker; plate.textContent = msg.speaker || "";
  el.querySelector(".seal").hidden = msg.kind !== "alert";
  const text = el.querySelector(".text");
  text.textContent = "";
  const chars = [];
  for (const seg of parseMarkup(msg.text)) {
    const holder = seg.cls ? Object.assign(document.createElement("span"), { className: seg.cls }) : text;
    // {st:Name}: the status icon goes in with the line, in front of the name.
    const icon = seg.status ? statusIcon(seg.status) : null;
    if (icon) holder.appendChild(Object.assign(document.createElement("img"), { className: "ico", src: icon, alt: "" }));
    for (const ch of seg.t) {
      const c = document.createElement("span");
      c.className = "c"; c.textContent = ch;
      holder.appendChild(c); chars.push(c);
    }
    if (seg.cls) text.appendChild(holder);
  }
  return chars;
}

// Reveal all at once, or letter by letter on the clock (a hidden window,
// where frames stop, still finishes on time).
function reveal(chars, msg, signal) {
  if (msg.reveal !== "type") { for (const c of chars) c.classList.add("on"); return Promise.resolve(); }
  return new Promise((resolve) => {
    const total = typeMs(msg.text, cfg);
    const start = performance.now();
    let shown = 0;
    const finish = () => { for (const c of chars) c.classList.add("on"); resolve(); };
    const timer = setTimeout(finish, total);
    const tick = () => {
      if (signal.aborted) { clearTimeout(timer); finish(); return; }
      const target = Math.min(chars.length, Math.floor(((performance.now() - start) * cfg.cps) / 1000));
      while (shown < target) { chars[shown].classList.add("on"); blip(chars[shown].textContent); shown++; }
      if (shown < chars.length) requestAnimationFrame(tick);
      else { clearTimeout(timer); resolve(); }
    };
    requestAnimationFrame(tick);
  });
}

function waitLine(el, msg, signal) {
  if (msg.advance === "press") {
    return new Promise((resolve) => {
      el.classList.add("wait");
      const done = () => { el.removeEventListener("click", done); el.classList.remove("wait"); resolve(); };
      el.addEventListener("click", done);
      sleep(cfg.maxWaitMs).then(done);
      signal.onabort = done;
    });
  }
  const ms = msg.hold ?? holdMs(msg.text, cfg);
  return Promise.race([sleep(ms), new Promise((r) => { signal.onabort = r; })]);
}

async function pump() {
  if (state.running) return;
  state.running = true;
  const host = ensureHost();
  try {
    while (state.queue.length) {
      const item = state.queue.shift();
      const msg = item.msg;
      // stale: still waiting long after it was sent — the moment has passed
      if (msg.advance !== "press" && Date.now() - item.at > cfg.maxQueueAgeMs) { item.resolve(); continue; }
      const ctl = { aborted: false, onabort: null };
      state.abort = () => { ctl.aborted = true; try { ctl.onabort?.(); } catch (e) {} };
      await iconsReady(msg.text);
      if (!state.el) {
        state.el = buildBox(msg.enter);
        host.appendChild(state.el);
        void state.el.offsetWidth;                 // start pose, then animate in
      }
      const chars = fillBox(state.el, msg);
      state.el.classList.add("shown");
      try { item.onShow?.(); } catch (e) { console.warn(TAG, "onShow threw", e); }
      await reveal(chars, msg, ctl);
      if (!ctl.aborted) await waitLine(state.el, msg, ctl);
      item.resolve();
      if (!state.queue.length) await new Promise((r) => setTimeout(r, GRACE_MS));
    }
  } catch (e) {
    console.warn(TAG, "pump failed", e);
  } finally {
    const el = state.el;
    state.el = null; state.abort = null; state.running = false;
    if (el) {
      el.classList.add("leaving");
      el.classList.remove("shown", "wait");
      setTimeout(() => el.remove(), el.dataset.enter === "appear" ? 0 : LEAVE_MS);
    }
    if (state.queue.length) pump();                // a line that arrived mid-exit
  }
}

function enqueue(input, onShow) {
  return new Promise((resolve) => {
    state.queue.push({ msg: normalizeMessage(input, cfg), resolve, onShow, at: Date.now() });
    pump();
  });
}

// ── public API ──────────────────────────────────────────────────────────
function show(input) {
  return enqueue(input);
}

// Lines in one box, in order. onShow(i) fires as line i appears — the hook an
// animation uses to play its beat with the line. Resolves when the last closes.
function queue(list, { onShow } = {}) {
  const lines = Array.isArray(list) ? list : [list];
  return Promise.all(lines.map((line, i) => enqueue(line, onShow ? () => onShow(i) : null))).then(() => {});
}

function clear() {
  const pending = state.queue.splice(0);
  for (const it of pending) it.resolve();
  state.abort?.();
}

// Every client, this one included. Lines only — callbacks do not cross the wire.
function broadcast(list) {
  const lines = Array.isArray(list) ? list : [list];
  try { game.socket?.emit(SOCKET, { type: MSG_TYPE, lines }); } catch (e) { console.warn(TAG, "emit failed", e); }
  return queue(lines);
}

function configure(patch = {}) {
  for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) cfg[k] = patch[k];
  if (document.getElementById(HOST_ID)) ensureHost();
  return { ...cfg };
}

Hooks.once("ready", () => {
  game.socket?.on(SOCKET, (data) => {
    if (data?.type !== MSG_TYPE || !Array.isArray(data.lines)) return;
    queue(data.lines);
  });
});
// A scene change takes the box with it.
Hooks.on("canvasTearDown", () => clear());

globalThis.FU = globalThis.FU ?? {};
globalThis.FU.SystemMessage = Object.freeze({ show, queue, broadcast, clear, configure, config: () => ({ ...cfg }) });
