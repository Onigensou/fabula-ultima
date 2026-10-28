// scripts/orbment/orbment-feedback.js
//
// PARTY ANNOUNCEMENT for Orbment Attunement (Orbment v3, P5) — the banner the
// REST of the party sees while a friend is at the Alchemist (the friend sees the
// Alchemist window and his reactions instead). Modelled on the refinement
// spectator banner (refinement-feedback.js): same spot over the play area, same
// parchment card, one card at a time from a queue.
//
//   attuning — "Keren is attuning +6 Psychic Dagger with a Polished Stone…",
//              spinning stone, the attuning sound.
//   result   — the SAME card eases into the result in place (soft swell, the
//              result fades up, the border eases to its tint, a light star
//              sprinkle) with the complete chime, or the SSR fanfare on a
//              Jackpot. A multi-slot attune is ONE card, one row per slot.
//   upgrade  — Zarg's Upgrade, announced when the party wakes (P7).
//
// Every roll is announced (user: "announce every roll, queue logic"). Outcomes
// read only as a border tint — no Better/Worse words. Item names are links: a
// click opens the Item Window (FULinkedText.openItem) for THAT viewer only.
// Hovering a card holds it so there's time to click.
//
// Sender API (operator's client): FUCompanion.api.orbment.feedback
//   .attuning({ actorName, itemName, itemUuid, itemRarity?, grades })
//   .result(attuneResult)              — the object api.orbment.attune returned
//   .cancel({ itemUuid })              — the attune failed; drop its card
//   .announce(payload)                 — show locally AND on every other client
// emit() never echoes to the sender, so the operator never sees their own card.

const TAG = "[Orbment][Feedback]";
const CHANNEL = "module.fabula-ultima-companion";
const MSG = "orbment:feedback";
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const CONTAINER_ID = "oni-orbment-feedback";
const STYLE_ID = "oni-orbment-feedback-styles";
const LINGER_MS = 3200;
const ANIM_MS = 320;
const ATTUNING_SAFETY_MS = 15000;   // drop an "attuning…" card whose result never came

// Same cues as the Alchemist window, so a sound means one thing everywhere.
const SFX = {
  attuning: [`${ASSET}Sound/check_start.wav`, 0.45],
  done:     [`${ASSET}Sound/Saint5.ogg`, 0.6],
  jackpot:  [`${ASSET}Sound/SE_SYS_Gacha_itemget_SSR.ogg`, 0.45],
};
const ORB_IMG = { offensive: `${ASSET}Item%20Icon/rorb.png`, defensive: `${ASSET}Item%20Icon/borb.png`, enhancement: `${ASSET}Item%20Icon/yorb.png` };
const STONE_IMG = { rough: `${ASSET}Item%20Icon/Elemental%20Stone/1000.png`, polished: `${ASSET}Item%20Icon/Crystal.png` };
const EDGE = { better: "#8db47a", sidegrade: "#cdb98f", worse: "#c4938a", new: "#93afd0", upgrade: "#b8865a" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const rarityColor = (r) => {
  const k = String(r ?? "").toLowerCase();
  return k.includes("legendary") ? "#7b2fa8" : k.includes("rare") ? "#b8860b" : k.includes("uncommon") ? "#1f6fb2" : "#3b2a19";
};
function playSfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}

// ── Styles + container ─────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${CONTAINER_ID} { position: fixed; top: 56px; left: 0; width: 100%; z-index: 2147483600; pointer-events: none;
  display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.oni-ofb-card { position: relative; pointer-events: auto; width: 100%; box-sizing: border-box; padding: 12px 26px; border-radius: 10px;
  background: linear-gradient(180deg, #f6ebd3 0%, #efdfc3 100%); border: 2px solid #8d5f38;
  box-shadow: 0 0 0 1px #6f4526, 0 8px 24px rgba(0,0,0,0.45); color: #3b2a19; font: 300 18px/1.3 "Signika", sans-serif;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  opacity: 0; transform: translateX(-44px);
  transition: opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms cubic-bezier(.22,.8,.3,1), border-color .6s ease, box-shadow .6s ease; }
.oni-ofb-card.in  { opacity: 1; transform: none; }
.oni-ofb-card.out { opacity: 0; transform: translateX(44px); }
.oni-ofb-card b { font-weight: 700; }
.oni-ofb-line { display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; white-space: nowrap; }
.oni-ofb-line img { width: 26px; height: 26px; image-rendering: pixelated; border: none; }
.oni-ofb-stone { width: 26px; height: 26px; image-rendering: pixelated; border: none; animation: oni-ofb-spin 1.4s cubic-bezier(.4,0,.2,1) infinite; }
.oni-ofb-old { color: #8a6a4a; text-decoration: line-through; }
.oni-ofb-rows { display: flex; flex-direction: column; align-items: center; gap: 2px; animation: oni-ofb-fadeup .5s .08s cubic-bezier(.22,.8,.3,1) both; }
.oni-ofb-link { font: inherit; font-weight: 600; background: none; border: 0; padding: 0 2px; border-radius: 4px; cursor: pointer;
  color: var(--c, #3b2a19); text-decoration: underline dotted; text-underline-offset: 4px; text-decoration-thickness: 1px; }
.oni-ofb-link:hover, .oni-ofb-link:focus-visible { background: rgba(201,164,74,.28); outline: none; }
.oni-ofb-card.morph { animation: oni-ofb-morph .6s cubic-bezier(.22,.8,.3,1) both; }
.oni-ofb-card.jack { background: linear-gradient(100deg,#fff3c4 0%,#f1d77e 40%,#fff9e0 50%,#f1d77e 60%,#e8c766 100%); background-size: 250% 100%;
  animation: oni-ofb-sheen 2.2s linear infinite; border-color: #b8860b; box-shadow: 0 0 0 1px #8a6408, 0 0 26px rgba(255,205,90,.85); }
.oni-ofb-card.jack.morph { animation: oni-ofb-morph .6s cubic-bezier(.22,.8,.3,1) both, oni-ofb-sheen 2.2s linear infinite; }
.oni-ofb-fx { position: absolute; left: 50%; top: 50%; width: 0; height: 0; overflow: visible; pointer-events: none; }
.oni-ofb-spark { position: absolute; line-height: 1; transform: translate(-50%,-50%); animation-name: oni-ofb-spark; animation-fill-mode: both;
  animation-timing-function: cubic-bezier(.15,.7,.3,1); text-shadow: 0 0 6px currentColor, 0 0 12px currentColor; }
@keyframes oni-ofb-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
@keyframes oni-ofb-sheen { from { background-position: 150% 0; } to { background-position: -100% 0; } }
@keyframes oni-ofb-morph { 0% { transform: scale(.985); filter: brightness(1.12); } 45% { transform: scale(1.012); } 100% { transform: none; filter: none; } }
@keyframes oni-ofb-fadeup { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes oni-ofb-spark { 0% { opacity: 0; transform: translate(-50%,-50%) scale(.2) rotate(0); } 15% { opacity: 1; } 70% { opacity: .9; }
  100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1) rotate(var(--rot)); } }
@media (prefers-reduced-motion: reduce) { .oni-ofb-card, .oni-ofb-card * { animation-duration: 1ms !important; animation-iteration-count: 1 !important; } }
`;
  document.head.appendChild(s);
}

// Centre a fixed-fraction banner over the play area, clear of the sidebar —
// the same placement as the refinement / healing banners.
function ensureContainer() {
  injectStyles();
  let el = document.getElementById(CONTAINER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = CONTAINER_ID;
    document.body.appendChild(el);
    // Item links: one delegated handler for every card.
    el.addEventListener("click", (ev) => {
      const link = ev.target.closest?.(".oni-ofb-link");
      if (!link?.dataset.uuid) return;
      ev.preventDefault();
      try { globalThis.FULinkedText?.openItem?.(link.dataset.uuid, { x: ev.clientX - 160, y: ev.clientY + 24 }); }
      catch (e) { console.warn(TAG, "openItem failed", e); }
    });
  }
  const sidebar = document.getElementById("sidebar");
  const r = sidebar?.getBoundingClientRect?.();
  const right = (r && r.width > 0 && r.left > 100) ? r.left : window.innerWidth;
  const width = Math.max(280, Math.min(760, right * 0.6));
  el.style.left = `${Math.round((right - width) / 2)}px`;
  el.style.width = `${Math.round(width)}px`;
  return el;
}

// ── Card HTML ────────────────────────────────────────────────────────────────
function itemLink(p) {
  return `<button type="button" class="oni-ofb-link" data-uuid="${esc(p.itemUuid)}" style="--c:${rarityColor(p.itemRarity)}">${esc(p.itemName)}</button>`;
}
function stonePhrase(grades = []) {
  const set = [...new Set(grades)];
  if (set.length > 1) return "with Rough and Polished Stones";
  const label = set[0] === "polished" ? "Polished" : "Rough";
  return grades.length > 1 ? `with ${label} Stones` : `with a ${label} Stone`;
}
function attuningHtml(p) {
  const g = (p.grades ?? [])[0] === "polished" ? "polished" : "rough";
  return `<div class="oni-ofb-line"><img class="oni-ofb-stone" src="${STONE_IMG[g]}" alt="">
    <span><b>${esc(p.actorName)}</b> is attuning ${itemLink(p)} ${esc(stonePhrase(p.grades))}…</span></div>`;
}
function resultHtml(p) {
  const verb = p.kind === "upgrade" ? `worked through the night on ${esc(p.ownerName ? `${p.ownerName}'s` : "")}` : "attuned";
  const rows = (p.rows ?? []).map((r) => `<div class="oni-ofb-line">
      <span class="oni-ofb-old">${esc(r.old ?? "Empty slot")}</span><span aria-hidden="true">→</span>
      ${r.cat ? `<img src="${ORB_IMG[r.cat] ?? ORB_IMG.enhancement}" alt="">` : ""}<b>${esc(r.now ?? "")}</b></div>`).join("");
  return `<div class="oni-ofb-line"><span><b>${esc(p.actorName)}</b> ${verb} ${itemLink(p)}</span></div>
    <div class="oni-ofb-rows">${rows}</div>`;
}
function applyTint(card, lead) {
  card.classList.toggle("jack", lead === "jackpot");
  if (lead !== "jackpot" && EDGE[lead]) {
    card.style.borderColor = EDGE[lead];
    card.style.boxShadow = `0 0 0 1px ${EDGE[lead]}, 0 8px 24px rgba(0,0,0,0.45)`;
  }
}
function sprinkle(card, jackpot) {
  const GLYPH = ["✦", "★", "✧", "⋆"];
  const COL = jackpot ? ["#ffd36e", "#fff3b0", "#ff9ecb", "#9ad7ff", "#c6a2ff"] : ["#ffd36e", "#fff3b0", "#ffe9a8"];
  const fx = document.createElement("span");
  fx.className = "oni-ofb-fx";
  const n = jackpot ? 26 : 10;
  const spread = Math.min(card.clientWidth * 0.9, jackpot ? 760 : 520);
  for (let k = 0; k < n; k++) {
    const s = document.createElement("span");
    s.className = "oni-ofb-spark";
    s.textContent = GLYPH[k % GLYPH.length];
    s.style.cssText = `left:${((Math.random() - 0.5) * spread).toFixed(0)}px;font-size:${((jackpot ? 11 : 9) + Math.random() * (jackpot ? 12 : 6)).toFixed(0)}px;`
      + `color:${COL[k % COL.length]};--dx:${((Math.random() - 0.5) * 70).toFixed(0)}px;--dy:${(-(18 + Math.random() * (jackpot ? 60 : 36))).toFixed(0)}px;`
      + `--rot:${(Math.random() * 300 - 150).toFixed(0)}deg;animation-duration:${(800 + Math.random() * (jackpot ? 900 : 500)).toFixed(0)}ms;`
      + `animation-delay:${(Math.random() * (jackpot ? 300 : 160)).toFixed(0)}ms`;
    fx.appendChild(s);
  }
  card.appendChild(fx);
  setTimeout(() => fx.remove(), jackpot ? 2200 : 1500);
}

// ── Queue ────────────────────────────────────────────────────────────────────
// Entries: { opId, stage: "attuning" | "result", payload }. The card on screen
// is `_current` ({ entry, card, timer, held }).
const _queue = [];
let _current = null;

function enqueue(entry) {
  // A result for the card already on screen → morph it in place.
  if (entry.stage === "result" && !_current?.dying && _current?.entry.opId && _current.entry.opId === entry.opId && _current.entry.stage === "attuning") {
    morphCurrent(entry);
    return;
  }
  // A result for a still-queued "attuning" card → it replaces that card.
  const i = _queue.findIndex((q) => q.opId && q.opId === entry.opId);
  if (i >= 0 && entry.stage === "result") { _queue[i] = entry; return; }
  _queue.push(entry);
  if (!_current) showNext();
}

function cancel(opId) {
  const i = _queue.findIndex((q) => q.opId === opId);
  if (i >= 0) _queue.splice(i, 1);
  if (_current?.entry.opId === opId) dismissCurrent();
}

function showNext() {
  const entry = _queue.shift();
  if (!entry) { _current = null; return; }
  const container = ensureContainer();
  const card = document.createElement("div");
  card.className = "oni-ofb-card";
  card.innerHTML = entry.stage === "attuning" ? attuningHtml(entry.payload) : resultHtml(entry.payload);
  container.appendChild(card);
  _current = { entry, card, timer: null, held: false };
  card.addEventListener("mouseenter", () => { if (_current?.card === card) { _current.held = true; clearTimeout(_current.timer); } });
  card.addEventListener("mouseleave", () => {
    if (_current?.card !== card) return;
    _current.held = false;
    if (_current.entry.stage === "attuning") _current.timer = setTimeout(() => dismissCurrent(), ATTUNING_SAFETY_MS);
    else armLinger();
  });
  requestAnimationFrame(() => card.classList.add("in"));
  if (entry.stage === "attuning") {
    playSfx("attuning");
    _current.timer = setTimeout(() => dismissCurrent(), ATTUNING_SAFETY_MS);
  } else {
    landResult(card, entry.payload);
    armLinger();
  }
}

function morphCurrent(entry) {
  const cur = _current;
  clearTimeout(cur.timer);
  cur.entry = entry;
  cur.card.innerHTML = resultHtml(entry.payload);
  cur.card.classList.remove("morph");
  void cur.card.offsetWidth;
  cur.card.classList.add("morph");
  landResult(cur.card, entry.payload);
  armLinger();
}

function landResult(card, p) {
  const lead = p.kind === "upgrade" ? "upgrade" : p.lead;
  applyTint(card, lead);
  sprinkle(card, lead === "jackpot");
  playSfx(lead === "jackpot" ? "jackpot" : "done");
}

function armLinger() {
  if (!_current || _current.held || _current.entry.stage !== "result") return;
  clearTimeout(_current.timer);
  _current.timer = setTimeout(() => dismissCurrent(), LINGER_MS);
}

function dismissCurrent() {
  const cur = _current;
  if (!cur) return;
  clearTimeout(cur.timer);
  cur.card.classList.remove("in");
  cur.card.classList.add("out");
  _current = { ...cur, dying: true };
  setTimeout(() => { cur.card.remove(); _current = null; showNext(); }, ANIM_MS);
}

// ── Receive ──────────────────────────────────────────────────────────────────
function receive(msg) {
  const p = msg?.payload ?? {};
  if (p.kind === "cancel") return cancel(p.opId);
  if (p.kind === "attuning") return enqueue({ opId: p.opId, stage: "attuning", payload: p });
  if (p.kind === "result" || p.kind === "upgrade") return enqueue({ opId: p.opId, stage: "result", payload: p });
}

function onSocket(msg) {
  if (msg?.type !== MSG) return;
  try { receive(msg); } catch (e) { console.warn(TAG, "receive failed", e); }
}

// ── Send ─────────────────────────────────────────────────────────────────────
const _lastOp = new Map();   // itemUuid → opId of the attune in flight (sender side)
function emit(payload) {
  try { game.socket.emit(CHANNEL, { type: MSG, payload }); } catch (e) { console.warn(TAG, "emit failed", e); }
}

// Shape an api.orbment.attune result into banner rows.
function rowsFrom(results = []) {
  return results.map((r) => ({ old: r.was?.label ?? null, now: r.now?.label ?? "", cat: r.now?.category ?? null, verdict: r.verdict }));
}

export const feedback = {
  attuning({ actorName, itemName, itemUuid, itemRarity, grades = [] } = {}) {
    const opId = foundry.utils.randomID();
    _lastOp.set(itemUuid, opId);
    emit({ kind: "attuning", opId, actorName, itemName, itemUuid, itemRarity, grades });
    return opId;
  },
  result(res = {}) {
    const opId = _lastOp.get(res.itemUuid) ?? foundry.utils.randomID();
    _lastOp.delete(res.itemUuid);
    emit({ kind: "result", opId, actorName: res.actorName, itemName: res.itemName, itemUuid: res.itemUuid,
      itemRarity: res.itemRarity, rows: rowsFrom(res.results), lead: res.lead });
  },
  cancel({ itemUuid } = {}) {
    const opId = _lastOp.get(itemUuid);
    _lastOp.delete(itemUuid);
    if (opId) emit({ kind: "cancel", opId });
  },
  // Show on THIS client and every other one (e.g. Upgrade at dawn, sent by the GM).
  announce(payload = {}) {
    const p = { opId: foundry.utils.randomID(), ...payload };
    emit(p);
    receive({ payload: p });
  },
  // Local preview for testing: FUCompanion.api.orbment.feedback._test()
  _test() {
    const base = { actorName: "Keren", itemName: "+6 Psychic Dagger", itemUuid: "", itemRarity: "Rare" };
    receive({ payload: { kind: "attuning", opId: "t1", grades: ["polished"], ...base } });
    setTimeout(() => receive({ payload: { kind: "result", opId: "t1", lead: "jackpot", ...base,
      rows: [{ old: "Empty slot", now: "Multi (2)", cat: "offensive" }] } }), 1900);
  },
};

let _installed = false;
export function installFeedback() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
}
