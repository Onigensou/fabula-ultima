// ============================================================================
// Party Talk — display, text box, GM speaker picker, talk log
// ----------------------------------------------------------------------------
// Approved mockup: https://claude.ai/artifact/JvoZp7b6DsFTmQGaz1AMRY
// (Glass style, backing 70, Action = narration band, no merging.)
//
// WHERE IT RUNS — talkAllowedHere(): the scene's sceneMode is exploration,
// dungeon or camp, no Battle Director battle is up, and no event is in
// progress on this scene. When that turns false, bubbles fade, the waiting
// line empties (everything is already in the talk log) and the text box closes.
//
// HIDDEN TABS — never held. A line that arrives while document.hidden goes to
// the log only, and bubble timers run on real time, so a tab that slept
// through a bubble drops it on wake (TalkQueue.expire has no dt cap).
//
// WHO TALKS — party players as their own character; the GM as the selected
// token's actor, a picked actor (@name / click the portrait) or the narrator.
// Spectators see bubbles and the log but never get a text box.
//
// Keys live in party-talk-input.js; the pure rules in party-talk-core.js.
// ============================================================================

import {
  MODULE_ID, MODES, MODE_LABEL, LIMIT, LOG_MAX, TALK_SCENE_MODES,
  graphemes, units, langOf, clampUnits, typeMs, parseSlash, toSegments,
  sanitizeLine, faceCrop, resolveFace, NARRATOR_FACE, TalkQueue,
} from "./party-talk-core.js";
import { onTalkMessage, sendTalk, userMayTalk, senderMayTalk } from "./party-talk-net.js";
import { getClientOption } from "../shared/client-options.js";

const TAG = "[ONI][PartyTalk]";
const LAYER_ID = "oni-party-talk";
const STYLE_ID = "oni-party-talk-style";
const SOUND = `modules/${MODULE_ID}/assets/sounds/party-talk-pop.ogg`;
// The file is the mockup's blip at 8× amplitude; 1/8 here plays it at the
// mockup's level (peak 0.05) before Foundry's interface volume.
const SOUND_VOLUME = 0.125;
const TYPING_TTL_MS = 20000;
const GATE_MS = 400;
const PICKER_MAP_MAX = 12;

const S = {
  queue: new TalkQueue(),
  bubbles: new Map(),      // line id -> { line, el, para, segs, total, start, ms, done }
  log: [],
  typing: new Map(),       // userId -> { speaker, until }
  allowed: false,
  promptOpen: false,
  logOpen: false,
  mode: "say",
  speaker: null,
  gmSpeaker: null,         // GM's last picked speaker (used when no token is selected)
  recent: [],              // GM's last 5 picked speakers
  history: [],
  histIdx: -1,
  pick: null,              // { flat: speaker[], idx, fromAt }
};
const D = {};              // DOM refs

// ── gate ───────────────────────────────────────────────────────────────────
const sceneMode = () => canvas?.scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode ?? null;
function battleHere() {
  try {
    const st = canvas?.scene?.getFlag?.(MODULE_ID, "directorState");
    if (st?.dCombat?.started && !st.dCombat.ended && st.dCombat.combatants?.length) return true;
  } catch { /* */ }
  try { return !!globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.(); } catch { return false; }
}
function eventActive() {
  const a = window.oni?.EventSystem?.Flow?.state?.active;
  return !!(a && a.size);
}
export function talkAllowedHere() {
  return TALK_SCENE_MODES.has(sceneMode()) && !battleHere() && !eventActive();
}

// ── speakers ───────────────────────────────────────────────────────────────
function speakerFromActor(actor) {
  if (!actor) return null;
  let flag = null;
  try { flag = actor.getFlag?.(MODULE_ID, "talkPortrait") ?? null; } catch { /* */ }
  return {
    key: `actor:${actor.id}`, actorId: actor.id, name: actor.name ?? "", narrator: false,
    face: resolveFace({ name: actor.name, img: actor.img, flag }),
  };
}
const narrator = () => ({ key: "narrator", actorId: null, name: "GM", narrator: true, face: { ...NARRATOR_FACE } });
function defaultSpeaker() {
  if (game.user?.isGM) {
    const tok = canvas?.tokens?.controlled?.[0];
    if (tok?.actor) return speakerFromActor(tok.actor);
    return S.gmSpeaker ?? narrator();
  }
  return speakerFromActor(game.user?.character);
}

// ── faces ──────────────────────────────────────────────────────────────────
const SIZE_CACHE = new Map();
function faceEl(face, fill = 0.78, faceY = 0.54) {
  const el = document.createElement("span");
  el.className = "pt-face";
  if (!face?.src) return el;
  const img = new Image();
  img.alt = ""; img.decoding = "async"; img.draggable = false;
  const place = (w, h) => {
    const c = faceCrop(face, w, h, fill, faceY);
    img.style.width = `${c.width}%`; img.style.left = `${c.left}%`; img.style.top = `${c.top}%`;
  };
  const known = SIZE_CACHE.get(face.src);
  if (known) place(known[0], known[1]);
  else {
    img.style.visibility = "hidden";
    img.addEventListener("load", () => {
      SIZE_CACHE.set(face.src, [img.naturalWidth, img.naturalHeight]);
      place(img.naturalWidth, img.naturalHeight);
      img.style.visibility = "";
    }, { once: true });
  }
  img.src = face.src;
  el.appendChild(img);
  return el;
}

// ── segments → DOM (whole clusters only, for the typewriter) ───────────────
function renderSegs(el, segs, n) {
  el.replaceChildren();
  let left = n;
  for (const s of segs) {
    if (left <= 0) break;
    const piece = s.g.slice(0, left).join("");
    left -= s.g.length;
    if (s.cls) {
      const sp = document.createElement("span");
      sp.className = `pt-${s.cls}`;
      sp.textContent = piece;
      el.appendChild(sp);
    } else el.appendChild(document.createTextNode(piece));
  }
}
const segsOf = (line) => toSegments(line.text, line.mode, line.speaker.name, { narrator: line.speaker.narrator })
  .map((s) => ({ cls: s.cls, g: graphemes(s.t) }));

// ── sound ──────────────────────────────────────────────────────────────────
function playPop() {
  try {
    const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    AH?.play?.({ src: SOUND, volume: SOUND_VOLUME, autoplay: true, loop: false, channel: "interface" }, false);
  } catch (e) { console.debug(TAG, "pop failed", e); }
}

// ── stack (FLIP so bubbles glide) ──────────────────────────────────────────
function flip(mutate) {
  const els = [...D.col.querySelectorAll(".pt-talk:not(.leave)"), D.pills];
  const before = new Map(els.map((el) => [el, el.getBoundingClientRect().top]));
  mutate();
  for (const [el, top] of before) {
    if (!el.isConnected) continue;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(.16,1,.3,1)" });
  }
}

function showBubble(line) {
  const sp = line.speaker;
  const act = line.mode === "action";
  const el = document.createElement("div");
  el.className = `pt-talk mode-${line.mode} enter`;
  const portrait = act ? faceEl(sp.face, 0.8, 0.52)
    : faceEl(sp.face, sp.face.cut ? 0.62 : 0.8, sp.face.cut ? 0.5 : 0.52);
  portrait.classList.add("pt-portrait", act ? "medal" : sp.face.cut ? "cutout" : "scan");
  const body = document.createElement("div");
  body.className = "pt-body";
  body.innerHTML = `<div class="pt-bg"><i></i></div>`;
  const lines = document.createElement("div");
  lines.className = "pt-lines";
  const para = document.createElement("p");
  para.lang = langOf(line.text);
  lines.appendChild(para);
  body.appendChild(lines);
  el.append(portrait, body);

  const segs = segsOf(line);
  const b = { line, el, para, segs, total: segs.reduce((n, s) => n + s.g.length, 0), start: performance.now(), ms: typeMs(line.text), done: false };
  el.addEventListener("pointerenter", () => S.queue.hold(line.id, true));
  el.addEventListener("pointerleave", () => S.queue.hold(line.id, false));
  el.addEventListener("click", () => retire(line.id));
  el.addEventListener("animationend", (e) => { if (e.animationName === "pt-bIn" || e.animationName === "pt-fade") el.classList.remove("enter"); });
  flip(() => D.col.insertBefore(el, D.pills));
  S.bubbles.set(line.id, b);
  restyle();
  playPop();
}

function retire(id) {
  const b = S.bubbles.get(id);
  if (!b || b.leaving) return;
  b.leaving = true;
  b.el.classList.add("leave");
  setTimeout(() => {
    flip(() => b.el.remove());
    S.bubbles.delete(id);
    S.queue.remove(id);
    for (const line of S.queue.promote(performance.now())) showBubble(line);
    restyle();
    renderPills();
  }, 340);
  restyle();
}

function restyle() {
  const live = [...S.bubbles.values()].filter((b) => !b.leaving);
  live.forEach((b, i) => b.el.classList.toggle("older", i < live.length - 1));
}

function clearAll() {
  S.queue.flush();
  for (const b of S.bubbles.values()) b.el.remove();
  S.bubbles.clear();
  S.typing.clear();
  renderPills();
}

// ── pills: who waits, who types ────────────────────────────────────────────
function renderPills() {
  if (!D.pills) return;
  D.pills.replaceChildren();
  if (!S.allowed) return;
  if (S.queue.waiting.length) {
    const p = document.createElement("span");
    p.className = "pt-pill";
    for (const l of S.queue.waiting.slice(0, 4)) p.appendChild(faceEl(l.speaker.face));
    p.appendChild(document.createTextNode(`+${S.queue.waiting.length}`));
    D.pills.appendChild(p);
  }
  const now = Date.now();
  for (const [uid, t] of S.typing) {
    if (t.until < now) { S.typing.delete(uid); continue; }
    const p = document.createElement("span");
    p.className = "pt-pill";
    const dots = document.createElement("span");
    dots.className = "pt-dots";
    dots.innerHTML = "<i></i><i></i><i></i>";
    p.append(faceEl(t.speaker.face), dots);
    D.pills.appendChild(p);
  }
}

function flashNote(text) {
  const p = document.createElement("span");
  p.className = "pt-pill";
  p.textContent = text;
  D.pills.appendChild(p);
  setTimeout(() => p.remove(), 2000);
}

// ── receiving ──────────────────────────────────────────────────────────────
function receiveLine(raw) {
  const line = sanitizeLine(raw);
  if (!line || !senderMayTalk(line.userId, line.speaker)) return;
  S.typing.delete(line.userId);
  addLog(line);
  if (!S.allowed || document.hidden) { renderPills(); return; }
  const r = S.queue.offer(line, performance.now());
  if (r === "show") showBubble(line);
  else if (r === "log" && line.userId === game.user?.id) flashNote("Too many waiting: saved to the talk log");
  renderPills();
}

function receiveTyping(msg) {
  const userId = String(msg.userId ?? "");
  if (!msg.on) { S.typing.delete(userId); renderPills(); return; }
  const speaker = sanitizeLine({ mode: "say", text: "x", speaker: msg.speaker })?.speaker;
  if (!speaker || !senderMayTalk(userId, speaker)) return;
  S.typing.set(userId, { speaker, until: Date.now() + TYPING_TTL_MS });
  renderPills();
}

// ── talk log ───────────────────────────────────────────────────────────────
function addLog(line) {
  S.log.push(line);
  if (S.log.length > LOG_MAX) S.log.shift();
  if (S.logOpen) renderLog();
}
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};
function renderLog() {
  D.logList.replaceChildren();
  if (!S.log.length) {
    const p = document.createElement("p");
    p.className = "pt-empty";
    p.textContent = "No lines yet this session.";
    D.logList.appendChild(p);
    return;
  }
  for (const line of S.log) {
    const li = document.createElement("li");
    li.className = line.mode;
    const div = document.createElement("div");
    const b = document.createElement("b"); b.textContent = line.speaker.name;
    const em = document.createElement("em"); em.textContent = ago(line.ts);
    const sp = document.createElement("span");
    sp.lang = langOf(line.text);
    renderSegs(sp, segsOf(line), Infinity);
    div.append(b, em, document.createElement("br"), sp);
    li.append(faceEl(line.speaker.face), div);
    D.logList.appendChild(li);
  }
  D.logList.scrollTop = D.logList.scrollHeight;
}
export function toggleLog(force) {
  const open = force ?? !S.logOpen;
  if (open && !S.allowed && !S.logOpen) return false;
  S.logOpen = open;
  D.log.hidden = !open;
  if (open) { closePrompt(); renderLog(); }
  return true;
}

// ── text box ───────────────────────────────────────────────────────────────
function setMode(m) {
  S.mode = m;
  D.chip.dataset.mode = m;
  D.chip.textContent = MODE_LABEL[m];
  D.input.placeholder = m === "shout" ? "Shout…" : m === "think" ? "Think out loud…"
    : m === "action" ? "Describe what you do… e.g. waves at the farmer"
    : game.user?.isGM ? "Type a line, or @ to pick a speaker…" : "Say something to the party…";
}
function renderSpeaker() {
  D.speakerBtn.replaceChildren(faceEl(S.speaker?.face, 0.8, 0.52));
  D.speakAs.hidden = !game.user?.isGM;
  D.speakAs.textContent = `Speaking as ${S.speaker?.name ?? "—"}`;
}
function renderKeys() {
  const gm = !!game.user?.isGM;
  D.keys.innerHTML = `<span><kbd>Enter</kbd> send</span><span><kbd>Esc</kbd> close</span><span><kbd>Tab</kbd> say / shout / think / action</span><span><kbd>↑</kbd> last line</span>`
    + (gm ? `<span><code>@</code> speaker</span>` : `<span><code>/me</code> action</span>`)
    + `<span><code>*waves*</code> inline action</span>`;
}
function updateCount() {
  const n = units(D.input.value);
  D.count.textContent = `${n}/${LIMIT}`;
  D.count.classList.toggle("warn", n > 100);
}
function sendTyping(on) {
  if (!S.speaker) return;
  sendTalk("typing", { userId: game.user.id, on, speaker: S.speaker });
}

export function canTalk() { return S.allowed && userMayTalk(game.user); }
export function isPromptOpen() { return S.promptOpen; }

export function openPrompt(prefill = "") {
  if (S.promptOpen) { D.input.focus(); return true; }
  if (!canTalk()) return false;
  const sp = defaultSpeaker();
  if (!sp) return false;
  if (S.logOpen) toggleLog(false);
  S.speaker = sp;
  S.promptOpen = true;
  S.histIdx = -1;
  D.prompt.hidden = false;
  D.prompt.classList.toggle("gm", !!game.user.isGM);
  D.input.value = prefill;
  setMode("say");
  renderSpeaker();
  renderKeys();
  updateCount();
  setTimeout(() => D.input.focus(), 0);
  sendTyping(true);
  return true;
}

export function closePrompt() {
  if (!S.promptOpen) return;
  closePicker();
  S.promptOpen = false;
  D.prompt.hidden = true;
  sendTyping(false);
  D.input.blur();
}

function submit() {
  const text = clampUnits(D.input.value.trim());
  if (text && !/^@\S*$/.test(text) && S.speaker) {
    S.history.unshift({ text, mode: S.mode });
    if (S.history.length > 20) S.history.pop();
    const line = { id: foundry.utils.randomID(), userId: game.user.id, mode: S.mode, text, ts: Date.now(), speaker: S.speaker };
    sendTalk("line", { line });
  }
  closePrompt();
}

function settleInput() {
  const { mode, rest } = parseSlash(D.input.value);
  if (mode) { setMode(mode); D.input.value = rest; }
  const c = clampUnits(D.input.value);
  if (c !== D.input.value) D.input.value = c;
  updateCount();
  if (game.user?.isGM) {
    const m = D.input.value.match(/^@(\S*)$/);
    if (m) openPicker(m[1], true);
    else if (S.pick?.fromAt) closePicker();
  }
}

// ── GM speaker picker ──────────────────────────────────────────────────────
function pickerGroups(q) {
  const ql = q.toLowerCase();
  const hit = (sp) => !ql || sp.name.toLowerCase().includes(ql);
  const used = new Set();
  const groups = [];
  const add = (title, list, tag = "") => {
    const ks = list.filter((sp) => sp && hit(sp) && !used.has(sp.key));
    ks.forEach((sp) => used.add(sp.key));
    if (ks.length) groups.push({ title, list: ks, tag });
  };
  add("Recent", S.recent);
  add("Selected", (canvas?.tokens?.controlled ?? []).map((t) => speakerFromActor(t.actor)), "token");
  const onMap = [];
  const seen = new Set();
  for (const t of canvas?.tokens?.placeables ?? []) {
    const a = t.actor;
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    onMap.push(speakerFromActor(a));
    if (onMap.length >= PICKER_MAP_MAX) break;
  }
  add("On this map", onMap, "token");
  const partyIds = globalThis.FUCompanion?.api?.Spectator?.partyActorIds?.() ?? [];
  add("Party", partyIds.map((id) => speakerFromActor(game.actors?.get(id))));
  add("Narrator", [narrator()]);
  return groups;
}
function openPicker(q = "", fromAt = false) {
  if (!game.user?.isGM) return;
  const groups = pickerGroups(q);
  const flat = groups.flatMap((g) => g.list);
  S.pick = { flat, idx: 0, fromAt };
  D.picker.replaceChildren();
  if (!flat.length) {
    const h = document.createElement("h5");
    h.textContent = `No one called "${q}"`;
    D.picker.appendChild(h);
  }
  for (const g of groups) {
    const h = document.createElement("h5");
    h.textContent = g.title;
    D.picker.appendChild(h);
    const ul = document.createElement("ul");
    for (const sp of g.list) {
      const li = document.createElement("li");
      li.dataset.key = sp.key;
      li.append(faceEl(sp.face, 0.8, 0.52), document.createTextNode(sp.name));
      if (g.tag) { const s = document.createElement("small"); s.textContent = g.tag; li.appendChild(s); }
      li.addEventListener("pointerdown", (e) => { e.preventDefault(); choose(sp); });
      ul.appendChild(li);
    }
    D.picker.appendChild(ul);
  }
  D.picker.hidden = false;
  markPick();
}
function markPick() {
  const key = S.pick?.flat[S.pick.idx]?.key;
  for (const li of D.picker.querySelectorAll("li")) li.classList.toggle("on", li.dataset.key === key);
  D.picker.querySelector("li.on")?.scrollIntoView?.({ block: "nearest" });
}
function closePicker() { if (D.picker) D.picker.hidden = true; S.pick = null; }
function choose(sp) {
  const fromAt = S.pick?.fromAt;
  S.speaker = sp;
  S.gmSpeaker = sp;
  S.recent = [sp, ...S.recent.filter((x) => x.key !== sp.key)].slice(0, 5);
  if (fromAt) D.input.value = "";
  closePicker();
  renderSpeaker();
  updateCount();
  sendTyping(true);
  D.input.focus();
}

// ── input keys (the text box owns every key while focused) ─────────────────
function onInputKey(e) {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;   // Enter here confirms a Japanese IME conversion
  if (S.pick) {
    const n = S.pick.flat.length;
    if (!n && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); S.pick.idx = (S.pick.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n; markPick(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(S.pick.flat[S.pick.idx]); return; }
    if (e.key === "Escape") { e.preventDefault(); closePicker(); return; }
  }
  if (e.key === "Enter") { e.preventDefault(); submit(); }
  else if (e.key === "Escape") { e.preventDefault(); closePrompt(); }
  else if (e.key === "Tab") {
    e.preventDefault();
    setMode(MODES[(MODES.indexOf(S.mode) + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length]);
  } else if (e.key === "ArrowUp" && S.history.length) {
    e.preventDefault();
    S.histIdx = Math.min(S.history.length - 1, S.histIdx + 1);
    const h = S.history[S.histIdx];
    D.input.value = h.text; setMode(h.mode); updateCount();
  } else if (e.key === "ArrowDown" && S.histIdx >= 0) {
    e.preventDefault();
    S.histIdx--;
    const h = S.history[S.histIdx];
    D.input.value = h ? h.text : "";
    if (h) setMode(h.mode);
    updateCount();
  }
}

// ── options ────────────────────────────────────────────────────────────────
const STYLES = ["glass", "frost", "subtitle", "ribbon", "paper"];
function applyOptions() {
  if (!D.root) return;
  const st = getClientOption("partyTalkStyle") ?? "glass";
  for (const s of STYLES) D.root.classList.toggle(`st-${s}`, s === st);
  const ta = (Number(getClientOption("partyTalkBacking")) || 70) / 100;
  D.root.style.setProperty("--ta", String(ta));
}

// ── loops ──────────────────────────────────────────────────────────────────
function frame() {
  const now = performance.now();
  for (const b of S.bubbles.values()) {
    if (b.done || b.leaving) continue;
    const n = b.ms <= 0 ? b.total : Math.min(b.total, Math.ceil(b.total * (now - b.start) / b.ms));
    renderSegs(b.para, b.segs, n);
    if (n >= b.total) b.done = true;
  }
  for (const id of S.queue.expire(now)) retire(id);
  requestAnimationFrame(frame);
}

function gateTick() {
  const allowed = talkAllowedHere();
  if (allowed !== S.allowed) {
    const was = S.allowed;
    S.allowed = allowed;
    D.root.classList.toggle("pt-off", !allowed);
    if (!allowed && was !== false) { clearAll(); closePrompt(); if (S.logOpen) toggleLog(false); }
  }
  // rAF sleeps in a hidden tab; keep the clock honest from here too.
  for (const id of S.queue.expire(performance.now())) retire(id);
  if (S.typing.size) renderPills();
}

// ── DOM ────────────────────────────────────────────────────────────────────
function build() {
  injectStyles();
  const root = document.createElement("div");
  root.id = LAYER_ID;
  root.className = "pt-off act-band";
  root.innerHTML = `
    <div class="pt-col"><div class="pt-pills"></div></div>
    <div class="pt-prompt" hidden>
      <div class="pt-picker" hidden></div>
      <div class="pt-row">
        <button class="pt-speaker" type="button" tabindex="-1" aria-label="Speaker"></button>
        <button class="pt-chip" type="button" tabindex="-1" data-mode="say">Say</button>
        <input class="pt-input" type="text" autocomplete="off" spellcheck="false" aria-label="Party Talk line">
        <span class="pt-count">0/${LIMIT}</span>
      </div>
      <div class="pt-speakas" hidden></div>
      <div class="pt-keys"></div>
    </div>
    <div class="pt-log" hidden>
      <h3>Talk log <span><kbd>L</kbd> or <kbd>Esc</kbd> to close</span></h3>
      <ol></ol>
    </div>`;
  document.body.appendChild(root);
  Object.assign(D, {
    root,
    col: root.querySelector(".pt-col"),
    pills: root.querySelector(".pt-pills"),
    prompt: root.querySelector(".pt-prompt"),
    picker: root.querySelector(".pt-picker"),
    speakerBtn: root.querySelector(".pt-speaker"),
    chip: root.querySelector(".pt-chip"),
    input: root.querySelector(".pt-input"),
    count: root.querySelector(".pt-count"),
    speakAs: root.querySelector(".pt-speakas"),
    keys: root.querySelector(".pt-keys"),
    log: root.querySelector(".pt-log"),
    logList: root.querySelector(".pt-log ol"),
  });
  D.input.addEventListener("keydown", onInputKey);
  D.input.addEventListener("keyup", (e) => e.stopPropagation());
  D.input.addEventListener("input", (e) => { if (e.isComposing) { updateCount(); return; } settleInput(); });
  D.input.addEventListener("compositionend", settleInput);
  D.input.addEventListener("blur", () => setTimeout(() => {
    if (S.promptOpen && document.activeElement !== D.input && !D.input.value.trim()) closePrompt();
  }, 150));
  D.chip.addEventListener("pointerdown", (e) => e.preventDefault());
  D.chip.addEventListener("click", () => { setMode(MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]); D.input.focus(); });
  D.speakerBtn.addEventListener("pointerdown", (e) => e.preventDefault());
  D.speakerBtn.addEventListener("click", () => {
    if (!game.user?.isGM) return;
    if (D.picker.hidden) openPicker(""); else closePicker();
    D.input.focus();
  });
  document.addEventListener("keydown", (e) => {
    if (S.logOpen && e.key === "Escape") { e.stopPropagation(); e.preventDefault(); toggleLog(false); }
  }, true);
  applyOptions();
}

const u = (n) => `calc(var(--u) * ${n})`;
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
#${LAYER_ID} {
  --u: max(1vw, 10px); --ta: .7;
  --bubble: #fbf3d9; --bubble-hi: #fffaea; --bubble-edge: #4a2e17; --bubble-ink: #3b2412;
  --hud: rgba(16,12,6,.72); --hud-ink: #f3ead8; --gold: #d6b46a;
  position: fixed; inset: 0; pointer-events: none; z-index: 950;
  font-family: "Signika", "Leelawadee UI", "Yu Gothic UI", "Meiryo", "Noto Sans Thai", "Noto Sans JP", system-ui, sans-serif;
}
#${LAYER_ID}.pt-off .pt-col { display: none; }
#${LAYER_ID} kbd { display: inline-block; min-width: 1.6em; padding: 0 .4em; border-radius: 4px; text-align: center; font-family: inherit; font-weight: 700; font-size: .85em; line-height: 1.55;
  background: #ece4d3; color: #1b150b; box-shadow: inset 0 -2px 0 rgba(0,0,0,.35); border: 0; }
#${LAYER_ID} code { font-family: ui-monospace, Consolas, monospace; font-size: .9em; color: #f0d9a4; background: rgba(255,255,255,.08); padding: 0 .3em; border-radius: 3px; }

.pt-face { position: relative; overflow: hidden; flex: none; display: block; }
.pt-face img { position: absolute; display: block; max-width: none; height: auto; border: 0; }

/* column */
/* 200px floor: the bottom-left HUD (hotbar, round buttons, controller badge) is sized in px, not vw */
#${LAYER_ID} .pt-col { position: absolute; left: ${u(1.6)}; bottom: max(${u(7.4)}, 200px); width: ${u(42)};
  display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-end; gap: ${u(0.9)}; }
.pt-talk { position: relative; pointer-events: auto; display: flex; align-items: center; cursor: pointer; max-width: 100%; }
.pt-portrait { width: ${u(5.6)}; height: ${u(5.6)}; z-index: 2; margin-right: ${u(-1.6)}; align-self: flex-end; filter: drop-shadow(0 ${u(0.2)} ${u(0.3)} rgba(0,0,0,.45)); }
.pt-portrait.cutout { -webkit-mask-image: linear-gradient(to bottom, #000 80%, transparent 100%); mask-image: linear-gradient(to bottom, #000 80%, transparent 100%); }
.pt-portrait.scan { border-radius: 50%; box-shadow: 0 0 0 ${u(0.16)} var(--bubble-edge); background: var(--bubble); filter: none; align-self: center; }
.pt-body { position: relative; min-width: 0; max-width: ${u(34)}; }
.pt-bg { position: absolute; inset: 0; z-index: 0;
  filter: drop-shadow(${u(0.14)} 0 0 var(--bubble-edge)) drop-shadow(${u(-0.14)} 0 0 var(--bubble-edge)) drop-shadow(0 ${u(0.14)} 0 var(--bubble-edge)) drop-shadow(0 ${u(-0.14)} 0 var(--bubble-edge)) drop-shadow(0 ${u(0.35)} ${u(0.45)} rgba(0,0,0,.35)); }
.pt-bg i { position: absolute; inset: 0; display: block; border-radius: ${u(0.9)}; background: linear-gradient(to bottom, var(--bubble-hi), var(--bubble) 60%); }
.pt-lines { position: relative; z-index: 1; padding: ${u(0.55)} ${u(1.1)} ${u(0.6)} ${u(2.3)}; color: var(--bubble-ink);
  font-size: ${u(1.18)}; font-weight: 500; line-height: 1.4; overflow-wrap: break-word; }
.pt-lines p { margin: 0; }
.pt-lines p:lang(th), .pt-log span:lang(th) { line-height: 1.6; }
.pt-lines p:lang(ja), .pt-log span:lang(ja) { line-break: strict; }
.pt-act-inline { font-style: italic; opacity: .78; }
.pt-act-name { font-style: normal; font-family: "Cinzel", "Signika", serif; font-weight: 700; font-size: .9em; letter-spacing: .03em; }

/* modes (Paper shapes; other styles override below) */
.pt-talk.mode-shout .pt-bg i { border-radius: 0;
  clip-path: polygon(2% 14%, 7% 2%, 15% 12%, 24% 1%, 33% 12%, 43% 2%, 52% 13%, 62% 3%, 69% 13%, 78% 4%, 85% 15%, 93% 8%, 97% 24%, 94% 38%, 99% 50%, 94% 62%, 97% 76%, 92% 88%, 85% 98%, 77% 88%, 67% 99%, 58% 88%, 49% 99%, 40% 88%, 31% 98%, 23% 87%, 14% 96%, 8% 85%, 4% 72%, 1% 58%, 3% 44%, 0% 30%); }
.pt-talk.mode-shout .pt-lines { font-weight: 700; padding: ${u(0.9)} ${u(1.6)} ${u(0.95)} ${u(2.6)}; }
.pt-talk.mode-think .pt-bg i { border-radius: 99px; }
.pt-talk.mode-think .pt-lines { font-style: italic; padding-right: ${u(1.4)}; }
.pt-talk.mode-think .pt-lines p:lang(ja) { font-style: normal; }
.pt-talk.mode-action .pt-bg i { background: #efe2bf; border-radius: ${u(0.3)}; }
.pt-talk.mode-action .pt-lines { font-style: italic; color: #5a3d22; }
.pt-talk.mode-action .pt-lines p:lang(ja) { font-style: normal; }

/* GLASS */
#${LAYER_ID}.st-glass .pt-talk .pt-bg { filter: none; }
#${LAYER_ID}.st-glass .pt-talk .pt-bg i { border-radius: 0; clip-path: none;
  background: linear-gradient(90deg, rgba(14,10,6,var(--ta)) 0%, rgba(14,10,6,calc(var(--ta) * .82)) 62%, rgba(14,10,6,0) 100%); }
#${LAYER_ID}.st-glass .pt-talk .pt-bg i::before, #${LAYER_ID}.st-glass .pt-talk .pt-bg i::after { content: ""; position: absolute; left: 0; right: 25%; height: 1px;
  background: linear-gradient(90deg, rgba(255,236,200,.6), rgba(255,236,200,0)); }
#${LAYER_ID}.st-glass .pt-talk .pt-bg i::before { top: 0; } #${LAYER_ID}.st-glass .pt-talk .pt-bg i::after { bottom: 0; }
#${LAYER_ID}.st-glass .pt-talk .pt-lines { color: #fbf5e8; text-shadow: 0 1px 2px rgba(0,0,0,.85); padding: ${u(0.55)} ${u(5)} ${u(0.6)} ${u(2.3)}; font-weight: 500; }
#${LAYER_ID}.st-glass .pt-talk.mode-shout .pt-lines { color: #ffe3a3; font-weight: 700; }
#${LAYER_ID}.st-glass .pt-talk.mode-think .pt-lines { color: #d8d0c2; }
#${LAYER_ID}.st-glass .pt-portrait.scan { box-shadow: 0 0 0 ${u(0.12)} rgba(255,236,200,.7); }
/* FROST */
#${LAYER_ID}.st-frost .pt-talk .pt-bg { filter: drop-shadow(0 ${u(0.3)} ${u(0.4)} rgba(0,0,0,.25)); }
#${LAYER_ID}.st-frost .pt-talk .pt-bg i { background: rgba(251,243,217,var(--ta)); -webkit-backdrop-filter: blur(6px) saturate(1.1); backdrop-filter: blur(6px) saturate(1.1);
  box-shadow: inset 0 0 0 ${u(0.13)} rgba(74,46,23,.6); }
#${LAYER_ID}.st-frost .pt-talk.mode-shout .pt-bg i { box-shadow: none; }
#${LAYER_ID}.st-frost .pt-talk.mode-action .pt-bg i { background: rgba(239,226,191,var(--ta)); }
/* SUBTITLE */
#${LAYER_ID}.st-subtitle .pt-talk .pt-bg { display: none; }
#${LAYER_ID}.st-subtitle .pt-talk .pt-lines { color: #fffaf0; font-weight: 600; padding-left: ${u(2.1)};
  -webkit-text-stroke: ${u(0.2)} #2a1a0c; paint-order: stroke fill; text-shadow: 0 ${u(0.15)} ${u(0.4)} rgba(0,0,0,.6); }
#${LAYER_ID}.st-subtitle .pt-talk.mode-shout .pt-lines { color: #ffe08a; font-weight: 800; font-size: ${u(1.32)}; }
#${LAYER_ID}.st-subtitle .pt-talk.mode-think .pt-lines { color: #e3e8f0; }
#${LAYER_ID}.st-subtitle .pt-talk.mode-action .pt-lines { color: #f2dfb2; }
/* RIBBON */
#${LAYER_ID}.st-ribbon .pt-talk .pt-bg { filter: drop-shadow(0 ${u(0.3)} ${u(0.4)} rgba(0,0,0,.35)); }
#${LAYER_ID}.st-ribbon .pt-talk .pt-bg i { border-radius: 0; clip-path: none; transform: skewX(-14deg); left: ${u(0.6)}; right: ${u(-0.6)};
  background: linear-gradient(180deg, rgba(48,31,16,var(--ta)), rgba(22,14,7,calc(var(--ta) + .1)));
  border-top: ${u(0.12)} solid rgba(214,180,106,.85); border-bottom: ${u(0.12)} solid rgba(214,180,106,.85); }
#${LAYER_ID}.st-ribbon .pt-talk .pt-lines { color: #f6ecd6; padding: ${u(0.5)} ${u(1.8)} ${u(0.55)} ${u(2.6)}; }
#${LAYER_ID}.st-ribbon .pt-talk.mode-shout .pt-lines { color: #ffd77e; font-weight: 700; }
#${LAYER_ID}.st-ribbon .pt-talk.mode-think .pt-lines { color: #d6ccb8; }
#${LAYER_ID}:is(.st-glass, .st-subtitle, .st-ribbon) .pt-talk.mode-shout.enter .pt-lines { animation: pt-shake .32s .1s; }
@keyframes pt-shake { 20% { transform: translateX(${u(-0.25)}); } 40% { transform: translateX(${u(0.25)}); } 60% { transform: translateX(${u(-0.15)}); } 80% { transform: translateX(${u(0.1)}); } }

/* ACTION: medallion, ◈, gold narration band (every style) */
.pt-talk.mode-action .pt-portrait { width: ${u(3.1)}; height: ${u(3.1)}; border-radius: 50%; margin-right: ${u(-0.8)}; align-self: center; filter: none;
  -webkit-mask-image: none; mask-image: none; background: var(--bubble); box-shadow: 0 0 0 ${u(0.13)} rgba(214,180,106,.95), 0 ${u(0.2)} ${u(0.4)} rgba(0,0,0,.5); }
.pt-talk.mode-action .pt-lines p::before { content: "\\25C8"; font-style: normal; color: var(--gold); margin-right: .45em; }
#${LAYER_ID}.act-band .pt-talk.mode-action .pt-bg { filter: none; }
#${LAYER_ID}.act-band .pt-talk.mode-action .pt-bg i { border-radius: 0; clip-path: none; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; transform: none; left: 0; right: 0; border: 0;
  background: linear-gradient(90deg, rgba(96,68,24,calc(var(--ta) * .95)) 0%, rgba(62,43,14,calc(var(--ta) * .72)) 60%, rgba(62,43,14,0) 100%); }
#${LAYER_ID}.act-band .pt-talk.mode-action .pt-bg i::before, #${LAYER_ID}.act-band .pt-talk.mode-action .pt-bg i::after { content: ""; position: absolute; left: 0; right: 30%; height: 1px;
  background: linear-gradient(90deg, rgba(232,196,120,.95), rgba(232,196,120,0)); }
#${LAYER_ID}.act-band .pt-talk.mode-action .pt-bg i::before { top: 0; } #${LAYER_ID}.act-band .pt-talk.mode-action .pt-bg i::after { bottom: 0; }
#${LAYER_ID}.act-band .pt-talk.mode-action .pt-lines { color: #f5e2b2; text-shadow: 0 1px 2px rgba(0,0,0,.85); padding: ${u(0.5)} ${u(5)} ${u(0.55)} ${u(1.6)}; -webkit-text-stroke: 0; }
#${LAYER_ID}.act-band .pt-talk.mode-action .pt-act-name { color: #ffd98a; }

/* enter / leave */
.pt-talk.enter .pt-portrait { animation: pt-pIn .46s cubic-bezier(.16,1,.3,1) both; }
.pt-talk.enter .pt-body { animation: pt-bIn .42s cubic-bezier(.16,1,.3,1) .07s both; }
.pt-talk.mode-action.enter .pt-portrait { animation: pt-fade .5s ease-out both; }
.pt-talk.mode-action.enter .pt-body { animation: pt-fade .5s ease-out .06s both; }
@keyframes pt-pIn { from { opacity: 0; transform: translateX(-40%); } }
@keyframes pt-bIn { from { opacity: 0; transform: translateX(${u(-1)}) scale(.96); } }
@keyframes pt-fade { from { opacity: 0; } }
.pt-talk.leave { animation: pt-out .34s cubic-bezier(.5,0,.75,0) forwards; pointer-events: none; }
@keyframes pt-out { to { opacity: 0; transform: translateX(${u(-2)}); } }
.pt-talk.older { opacity: .8; }

/* pills */
.pt-pills { display: flex; flex-wrap: wrap; gap: ${u(0.5)}; min-height: ${u(2.2)}; align-items: center; padding-left: ${u(0.6)}; }
.pt-pill { display: inline-flex; align-items: center; gap: ${u(0.45)}; padding: ${u(0.2)} ${u(0.7)} ${u(0.2)} ${u(0.25)}; border-radius: 99px;
  background: var(--hud); color: var(--hud-ink); font-size: ${u(0.9)}; font-weight: 600; animation: pt-bIn .3s cubic-bezier(.16,1,.3,1); }
.pt-pill .pt-face { width: ${u(1.8)}; height: ${u(1.8)}; border-radius: 50%; background: var(--bubble); box-shadow: 0 0 0 ${u(0.1)} var(--hud-ink); }
.pt-pill .pt-face + .pt-face { margin-left: ${u(-0.6)}; }
.pt-dots { display: inline-flex; gap: ${u(0.22)}; }
.pt-dots i { width: ${u(0.4)}; height: ${u(0.4)}; border-radius: 50%; background: var(--hud-ink); animation: pt-dot 1s infinite; }
.pt-dots i:nth-child(2) { animation-delay: .15s; } .pt-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes pt-dot { 0%, 60%, 100% { opacity: .25; transform: none; } 30% { opacity: 1; transform: translateY(${u(-0.2)}); } }

/* text box */
#${LAYER_ID} .pt-prompt { position: absolute; left: ${u(1.6)}; bottom: ${u(1.6)}; width: ${u(44)}; pointer-events: auto;
  display: flex; flex-direction: column; gap: ${u(0.45)}; padding: ${u(0.6)} ${u(0.8)} ${u(0.55)}; border-radius: ${u(0.7)};
  background: rgba(18,13,7,.88); box-shadow: 0 0 0 ${u(0.14)} rgba(214,180,106,.55), 0 ${u(0.6)} ${u(1.4)} rgba(0,0,0,.5);
  animation: pt-up .25s cubic-bezier(.16,1,.3,1); }
#${LAYER_ID} .pt-prompt[hidden], #${LAYER_ID} .pt-picker[hidden], #${LAYER_ID} .pt-log[hidden], #${LAYER_ID} .pt-speakas[hidden] { display: none; }
@keyframes pt-up { from { opacity: 0; transform: translateY(${u(1)}); } }
.pt-row { display: flex; align-items: center; gap: ${u(0.7)}; }
.pt-speaker { position: relative; flex: none; border: 0; padding: 0; margin: 0; background: none; cursor: default; border-radius: 50%; display: flex; width: auto; line-height: 0; }
.pt-speaker .pt-face { width: ${u(2.8)}; height: ${u(2.8)}; border-radius: 50%; background: var(--bubble); box-shadow: 0 0 0 ${u(0.14)} var(--gold); }
.pt-prompt.gm .pt-speaker { cursor: pointer; }
.pt-prompt.gm .pt-speaker::after { content: "\\25BE"; position: absolute; right: ${u(-0.5)}; bottom: ${u(-0.4)}; font-size: ${u(0.8)}; line-height: 1; color: var(--gold); }
.pt-chip { flex: none; width: auto; border: 0; margin: 0; border-radius: ${u(0.4)}; padding: ${u(0.3)} ${u(0.65)}; cursor: pointer;
  font-family: inherit; font-weight: 700; font-size: ${u(0.92)}; line-height: 1.2; letter-spacing: .05em; text-transform: uppercase;
  background: var(--bubble); color: var(--bubble-ink); box-shadow: 0 0 0 ${u(0.12)} var(--bubble-edge) inset; }
.pt-chip[data-mode="shout"] { font-weight: 800; }
.pt-chip[data-mode="think"] { font-style: italic; border-radius: 99px; }
.pt-chip[data-mode="action"] { font-style: italic; border-radius: ${u(0.15)}; background: #efe2bf; }
#${LAYER_ID} .pt-input { flex: 1; min-width: 0; height: auto; border: 0; outline: 0; box-shadow: none; background: transparent; color: #f6efe0;
  font-family: inherit; font-weight: 500; font-size: ${u(1.25)}; line-height: 1.4; padding: ${u(0.3)} 0; caret-color: var(--gold); }
#${LAYER_ID} .pt-input::placeholder { color: #8d8270; }
.pt-count { flex: none; font-size: ${u(0.85)}; color: #8d8270; font-variant-numeric: tabular-nums; }
.pt-count.warn { color: #e2a24a; }
.pt-keys { display: flex; flex-wrap: wrap; gap: ${u(0.3)} ${u(1)}; color: #a99d86; font-size: ${u(0.85)}; padding-left: ${u(3.5)}; }
.pt-speakas { font-size: ${u(0.85)}; color: var(--gold); padding-left: ${u(3.5)}; margin-top: ${u(-0.2)}; }

/* GM picker */
.pt-picker { position: absolute; left: 0; bottom: calc(100% + ${u(0.6)}); width: ${u(24)}; max-height: ${u(26)}; overflow-y: auto; border-radius: ${u(0.6)};
  background: rgba(18,13,7,.95); box-shadow: 0 0 0 ${u(0.14)} rgba(214,180,106,.55), 0 ${u(0.6)} ${u(1.4)} rgba(0,0,0,.5); }
.pt-picker h5 { margin: 0; padding: ${u(0.45)} ${u(0.9)} ${u(0.2)}; font-size: ${u(0.78)}; letter-spacing: .12em; text-transform: uppercase; color: #8d8270; font-weight: 600; border: 0; }
.pt-picker ul { list-style: none; margin: 0; padding: 0 0 ${u(0.4)}; }
.pt-picker li { display: flex; align-items: center; gap: ${u(0.7)}; padding: ${u(0.35)} ${u(0.9)}; color: #f3ead8; font-size: ${u(1.05)}; cursor: pointer; }
.pt-picker li .pt-face { width: ${u(2.2)}; height: ${u(2.2)}; border-radius: 50%; background: var(--bubble); }
.pt-picker li small { margin-left: auto; color: #8d8270; font-size: .8em; }
.pt-picker li.on { background: rgba(214,180,106,.22); }

/* talk log */
#${LAYER_ID} .pt-log { position: absolute; top: ${u(5)}; left: ${u(1.6)}; bottom: ${u(1.6)}; width: ${u(40)}; pointer-events: auto; display: flex; flex-direction: column;
  border-radius: ${u(0.7)}; background: rgba(18,13,7,.9); box-shadow: 0 0 0 ${u(0.14)} rgba(214,180,106,.4); animation: pt-up .22s cubic-bezier(.16,1,.3,1); }
.pt-log h3 { margin: 0; padding: ${u(1)} ${u(1.3)} ${u(0.6)}; font-family: "Cinzel", "Signika", serif; font-size: ${u(1.25)}; letter-spacing: .08em; color: var(--gold);
  display: flex; justify-content: space-between; align-items: baseline; border: 0; }
.pt-log h3 span { font-family: "Signika", sans-serif; font-size: .7em; color: #a99d86; letter-spacing: 0; font-weight: 500; }
.pt-log ol { list-style: none; margin: 0; padding: 0 ${u(1.1)} ${u(1)}; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: ${u(0.6)}; }
.pt-log li { display: grid; grid-template-columns: ${u(2.6)} 1fr; gap: ${u(0.7)}; align-items: start; color: #efe6d4; font-size: ${u(1.08)}; }
.pt-log li .pt-face { width: ${u(2.6)}; height: ${u(2.6)}; border-radius: 50%; background: var(--bubble); }
.pt-log li b { font-family: "Cinzel", "Signika", serif; color: var(--gold); font-size: .95em; margin-right: ${u(0.5)}; }
.pt-log li em { color: #8d8270; font-style: normal; font-size: .85em; }
.pt-log li.shout span { font-weight: 700; }
.pt-log li.think span { font-style: italic; color: #c9bfae; }
.pt-log li.action span { font-style: italic; color: #e3cf9f; }
.pt-log .pt-empty { color: #8d8270; padding: 0 ${u(1.3)}; margin: 0; }

@media (prefers-reduced-motion: reduce) {
  #${LAYER_ID} *, #${LAYER_ID} *::before, #${LAYER_ID} *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}`;
  document.head.appendChild(css);
}

// ── boot ───────────────────────────────────────────────────────────────────
Hooks.once("ready", () => {
  try {
    build();
    onTalkMessage((msg) => {
      if (msg.kind === "line") receiveLine(msg.line);
      else if (msg.kind === "typing") receiveTyping(msg);
    });
    Hooks.on("fuClientOptionChanged", ({ key } = {}) => { if (String(key).startsWith("partyTalk")) applyOptions(); });
    // A new map starts clean (lines from the last map are in the log).
    Hooks.on("canvasReady", () => { clearAll(); closePrompt(); S.allowed = null; gateTick(); });
    setInterval(gateTick, GATE_MS);
    requestAnimationFrame(frame);
    gateTick();

    window.oni = window.oni || {};
    window.oni.PartyTalk = {
      openPrompt, closePrompt, toggleLog, canTalk, isPromptOpen, talkAllowedHere,
      /** Test/console helper: send a line as this user's default speaker. */
      say(text, mode = "say") {
        if (!canTalk() || !MODES.includes(mode)) return false;
        const speaker = S.speaker ?? defaultSpeaker();
        if (!speaker) return false;
        sendTalk("line", { line: { id: foundry.utils.randomID(), userId: game.user.id, mode, text: clampUnits(String(text)), ts: Date.now(), speaker } });
        return true;
      },
      _state: S,
    };
    console.debug(TAG, "ready");
  } catch (e) {
    console.error(TAG, "failed to start", e);
  }
});
