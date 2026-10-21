// Reaction hand — the "Card" Reaction UI (Party Menu › Config › Graphic).
//
// With Card chosen, a player's reactions on an action card stop being rows of
// Apply/Skip pills on the card and become a hand of cards tucked behind their
// plate: the name band peeks over the plate's top edge, hover raises a card
// with its full text, Use plays it (it flies onto the action card), and one
// Pass — the last slot of the hand — answers every card left. Pass is a toggle:
// pressing it again takes the Skips back while the card is still open.
// Allies' reactions show on THEIR compact cards: the card glows and gets one
// small card per reaction while they decide, then a PASSED / DONE tag.
//
// This is a VIEW over the action card's own reaction pills, not a second
// decision path. The pills stay in the card's DOM (hidden by CSS), they remain
// the single source of truth, and every action here is a click on a pill's own
// control — so targeting, follow-up menus, the GM's ack/revert, the Confirm
// lock and the no-response nets all run exactly as they do for Button mode.
// The one addition the engine needed is "reopen" (taking a Skip back), handled
// in action-card.js next to the existing Apply/Skip intent.
//
// Player clients only: the GM answers from the Battle Desk and keeps the pills.
// Approved mockup: claude.ai/artifact/UJ2LxcUjvGbayKkZ6cbdrx (page "Card game").

import { getClientOption } from "../shared/client-options.js";

const MIRROR_ROOT_ID = "fud-bf-mirror-root";
const STYLE_ID = "fud-rxh-style";
const BODY_CLASS = "fud-rx-hand";
const TAG = "[ReactionHand]";

// Hand geometry, in plate (unscaled) px — matches the mockup.
const CARD_W = 200;
const PASS_W = 96;
const HAND_LEFT = 64;          // first card's left edge, clear of the portrait that stands over 0–56
const HAND_RIGHT = 664;        // the Pass slot's right edge may not pass this
const MAX_STEP = 117;
const PASS_GAP = 6;
const PASS_STAGGER_MS = 120;   // Pass sends one Skip per card, spaced so the host takes them in turn

const reduced = () => {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false; } catch { return false; }
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));

// Skill descriptions are trusted actor data, but they arrive through an HTML
// attribute; parse them inert and keep only text-level markup.
function cleanDesc(html) {
  const body = new DOMParser().parseFromString(String(html ?? ""), "text/html").body;
  body.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button,textarea,select,img,svg,.fud-bf-reaction-tip-foot")
    .forEach((el) => el.remove());
  for (const el of body.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (a.name.startsWith("on") || a.name === "style" || a.name === "href" || a.name === "src") el.removeAttribute(a.name);
  }
  return body.innerHTML;
}

function actorFromUuid(uuid) {
  if (!uuid) return null;
  try { const d = fromUuidSync(uuid); return d?.actor ?? d ?? null; } catch { return null; }
}

// ── who is active ────────────────────────────────────────────────────────────
function myUnit() {
  const u = document.querySelector(".dhud-plate-root .dhud-unit");
  return u?.isConnected ? u : null;
}
function isActive() {
  if (game.user?.isGM) return false;
  if (getClientOption("reactionUi") !== "card") return false;
  return !!myUnit();
}

// ── reading the card's pills ─────────────────────────────────────────────────
function pillState(p) {
  if (p.classList.contains("is-auto")) return "auto";
  if (p.classList.contains("is-gm-set")) return "gm";
  if (p.classList.contains("is-applied")) return "applied";
  if (p.classList.contains("is-skipped")) return "skipped";
  if (p.classList.contains("is-unavailable") || p.dataset.fudReactionMoot === "1") return "off";
  if (p.classList.contains("is-submitting") || p.dataset.fudReactionSubmitting === "1") return "busy";
  if (p.dataset.fudReactionPending === "1") return "live";
  return "off";
}
function readPills(wrapper) {
  const me = game.user?.id ?? "";
  return [...(wrapper?.querySelectorAll(".fud-bf-reaction-pill") ?? [])].map((p) => ({
    el: p,
    key: `${p.dataset.fudReactionKey ?? ""}:${p.dataset.fudReactionCarrier ?? ""}`,
    owner: p.dataset.fudReactionOwner ?? "",
    mine: (p.dataset.fudReactionOwner ?? "") === me,
    reactorUuid: p.dataset.fudReactorUuid ?? "",
    name: p.querySelector(".fud-bf-reaction-name")?.textContent?.trim() || "Reaction",
    icon: p.querySelector("img.fud-bf-reaction-icon")?.getAttribute("src") ?? "",
    desc: p.dataset.fudEquipDesc ?? "",
    reason: p.querySelector(".fud-bf-reaction-reason")?.textContent?.trim()
      || (p.dataset.fudReactionMoot === "1" ? "Target removed" : ""),
    state: pillState(p),
  })).filter((r) => r.state !== "auto");
}

// ── the hand on your plate ───────────────────────────────────────────────────
const hand = {
  clip: null,         // .rxh-clip inside the plate unit
  pass: null,         // the Pass slot
  tag: null,          // your own PASSED tag
  cards: new Map(),   // key → { el, state }
  lastPill: new Map(),// key → last pill record seen (to act on it after it left the DOM)
};

function ensureHand(unit) {
  if (hand.clip?.isConnected && hand.clip.parentElement === unit) return;
  hand.clip?.remove();
  hand.cards.clear();
  hand.clip = document.createElement("div");
  hand.clip.className = "rxh-clip";
  hand.pass = document.createElement("button");
  hand.pass.type = "button";
  hand.pass.className = "rxh-pass is-hidden";
  hand.pass.innerHTML = `<span class="rxh-pband"><span class="rxh-pl"><span class="gl">Pass</span><span class="ps"></span></span><span class="k">P</span></span>`;
  hand.pass.addEventListener("click", (ev) => { ev.stopPropagation(); togglePass(); });
  hand.clip.appendChild(hand.pass);
  unit.prepend(hand.clip);
  hand.tag = document.createElement("span");
  hand.tag.className = "rxh-mytag";
  hand.tag.innerHTML = `${CHECK}Passed`;
  unit.appendChild(hand.tag);
}

const CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';

function cardHtml(r, portrait) {
  return `<div class="rxh-face">
      <div class="rxh-name"><span class="nm">${esc(r.name)}</span></div>
      <div class="rxh-art">${portrait ? `<img class="bg" src="${esc(portrait)}" alt="">` : ""}${r.icon ? `<span class="emb"><img src="${esc(r.icon)}" alt=""></span>` : ""}</div>
      <div class="rxh-type">Reaction</div>
      <div class="rxh-text">${cleanDesc(r.desc) || ""}</div>
      <div class="rxh-btns"><button type="button" class="rxh-use"><span class="gl">Use</span></button></div>
    </div><div class="rxh-ribbon"></div>`;
}

function makeCard(r) {
  const el = document.createElement("div");
  el.className = "rxh-card";
  el.dataset.key = r.key;
  const reactor = actorFromUuid(r.reactorUuid);
  const portrait = reactor?.img || myUnit()?.querySelector(".dhud-pcard img")?.getAttribute("src") || "";
  el.innerHTML = cardHtml(r, portrait);
  el.querySelector(".rxh-use").addEventListener("click", (ev) => { ev.stopPropagation(); useCard(r.key); });
  return el;
}

function layoutHand() {
  const inHand = [...hand.cards.values()].filter((c) => !c.leaving);
  const n = inHand.length;
  const step = n > 1 ? Math.min(MAX_STEP, (HAND_RIGHT - HAND_LEFT - CARD_W - PASS_GAP - PASS_W) / (n - 1)) : 0;
  inHand.forEach((c, i) => { c.el.style.left = `${HAND_LEFT + i * step}px`; });
  const last = n ? HAND_LEFT + (n - 1) * step : HAND_LEFT - CARD_W - PASS_GAP;
  hand.pass.style.left = `${last + CARD_W + PASS_GAP}px`;
}

function syncHand(pills, wrapper) {
  const unit = myUnit();
  if (!unit) return;
  ensureHand(unit);
  const mine = pills.filter((r) => r.mine);
  const seen = new Set();
  let dealt = 0;
  for (const r of mine) {
    seen.add(r.key);
    hand.lastPill.set(r.key, r);
    let c = hand.cards.get(r.key);
    if (r.state === "gm") { if (c) leave(c, "sink"); continue; }
    if (r.state === "applied") { if (c) leave(c, "fly", wrapper); continue; }
    if (!c) {
      const el = makeCard(r);
      el.style.setProperty("--d", `${dealt++ * 130}ms`);
      el.classList.add("is-dealt");
      hand.clip.insertBefore(el, hand.pass);
      c = { el, state: null, leaving: false };
      hand.cards.set(r.key, c);
    }
    if (c.state !== r.state) {
      c.el.classList.remove("is-live", "is-busy", "is-off", "is-skipped");
      c.el.classList.add(`is-${r.state}`);
      c.el.querySelector(".rxh-ribbon").textContent = r.state === "off" ? (r.reason || "Can't use") : "";
      c.state = r.state;
    }
  }
  // A pill that left the card (card closed / re-posted without it): fold it away.
  for (const [key, c] of hand.cards) if (!seen.has(key)) leave(c, "sink");

  const cards = [...hand.cards.values()].filter((c) => !c.leaving);
  const live = cards.filter((c) => c.state === "live").length;
  const busy = cards.filter((c) => c.state === "busy").length;
  const skipped = cards.filter((c) => c.state === "skipped").length;
  const passed = live === 0 && busy === 0 && skipped > 0;
  hand.pass.classList.toggle("is-hidden", live + skipped === 0);
  hand.pass.classList.toggle("is-on", passed);
  hand.pass.disabled = busy > 0;
  hand.pass.querySelector(".gl").textContent = passed ? "Passed" : "Pass";
  hand.pass.querySelector(".ps").textContent = passed ? "Take back" : "";
  hand.pass.setAttribute("aria-label", passed ? "Passed. Click to take it back" : "Pass on every reaction left");
  hand.tag.classList.toggle("is-on", passed);
  unit.classList.toggle("rxh-has-hand", cards.length > 0);
  layoutHand();
}

function leave(c, how, wrapper = null) {
  if (c.leaving) return;
  c.leaving = true;
  const key = c.el.dataset.key;
  const done = () => { c.el.remove(); if (hand.cards.get(key) === c) hand.cards.delete(key); };
  if (how === "fly" && wrapper) flyToCard(c.el, wrapper, done);
  else {
    c.el.classList.add("is-leaving");
    setTimeout(done, reduced() ? 340 : 460);
  }
  layoutHand();
}

// The played card leaves the hand for the action card: a clone flies from
// where the card is onto the card. A hand card that is NOT raised at that
// moment (the player moved away, or a picker had the drawer while the host
// resolved it) first rises out of the hand the way hover raises it, so it never
// pops straight from behind the plate into the air. `rise: false` for the
// allies' small cards, which have no raised pose.
function flyToCard(fromEl, wrapper, done, { scaleEnd = 0.16, rise = true } = {}) {
  const target = wrapper?.querySelector(".fud-bf-card");
  const from = fromEl.getBoundingClientRect();
  if (!target || !from.width) { done(); return; }
  const to = target.getBoundingClientRect();
  const raised = !rise || fromEl.matches(":hover");
  const clone = fromEl.cloneNode(true);
  clone.classList.add("rxh-flyer");
  clone.classList.remove("is-dealt", "is-leaving");
  Object.assign(clone.style, {
    left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
  });
  document.body.appendChild(clone);
  fromEl.style.visibility = "hidden";
  done();
  const finish = () => { clone.remove(); ringAt(to); };
  if (reduced()) {
    clone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 520, easing: "ease", fill: "forwards" }).finished.then(finish, finish);
    return;
  }
  // Scaled from the bottom edge (the hand's pivot); the end transform puts the
  // card's centre on the action card, a little above its middle.
  const k = from.width / CARD_W;              // the HUD's own scale
  const lift = raised ? 0 : 252 * k;          // the hover raise, in screen px
  const s0 = raised ? 1 : 1.25;
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height * 0.45) - (from.bottom - (from.height * scaleEnd) / 2);
  const frames = [{ transform: "translate(0,0) scale(1) rotate(0deg)", opacity: 1 }];
  if (!raised) frames.push({ transform: `translate(0, ${-lift}px) scale(${s0}) rotate(0deg)`, opacity: 1, offset: 0.2 });
  frames.push(
    { transform: `translate(${dx * 0.18}px, ${-lift - 80 * k}px) scale(${s0 * 1.04}) rotate(-4deg)`, opacity: 1, offset: raised ? 0.26 : 0.38 },
    { opacity: 1, offset: 0.86 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scaleEnd}) rotate(-10deg)`, opacity: 0 },
  );
  clone.animate(frames, { duration: raised ? 720 : 880, easing: "cubic-bezier(.45,.05,.35,1)", fill: "forwards" })
    .finished.then(finish, finish);
}

// Touchdown: a gold ring on the action card where the played card landed.
function ringAt(rect) {
  const ring = document.createElement("div");
  ring.className = "rxh-ring";
  const w = Math.min(rect.width - 24, 260), h = 46;
  Object.assign(ring.style, { left: `${rect.left + (rect.width - w) / 2}px`, top: `${rect.top + rect.height * 0.45 - h / 2}px`, width: `${w}px`, height: `${h}px` });
  document.body.appendChild(ring);
  const kf = reduced()
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [{ transform: "scale(.92)", opacity: 1 }, { transform: "scale(1.14,1.5)", opacity: 0 }];
  ring.animate(kf, { duration: 620, easing: "ease-out", fill: "forwards" }).finished.then(() => ring.remove(), () => ring.remove());
}

// ── acting through the pills ─────────────────────────────────────────────────
function pillFor(key) {
  const w = document.getElementById(MIRROR_ROOT_ID);
  if (!w) return null;
  return [...w.querySelectorAll(".fud-bf-reaction-pill")]
    .find((p) => `${p.dataset.fudReactionKey ?? ""}:${p.dataset.fudReactionCarrier ?? ""}` === key) ?? null;
}
function clickPill(pill, action) {
  const btn = pill?.querySelector(`[data-fud-reaction-action="${action}"]`);
  if (btn) { btn.click(); return true; }
  return false;
}

function useCard(key) {
  const c = hand.cards.get(key);
  if (!c || c.state !== "live") return;
  clickPill(pillFor(key), "apply");
  schedule();
}

function togglePass() {
  if (hand.pass?.disabled) return;
  const cards = [...hand.cards.entries()].filter(([, c]) => !c.leaving);
  const live = cards.filter(([, c]) => c.state === "live");
  if (live.length) {
    live.forEach(([key], i) => setTimeout(() => { clickPill(pillFor(key), "skip"); schedule(); }, i * PASS_STAGGER_MS));
    return;
  }
  // Take it back: one "reopen" per skipped card. The card has no visible
  // control for it; the mirror's delegated handler reads the action off a
  // momentary element inside the pill.
  for (const [key, c] of cards) {
    if (c.state !== "skipped") continue;
    const pill = pillFor(key);
    if (!pill) continue;
    const b = document.createElement("span");
    b.dataset.fudReactionAction = "reopen";
    b.hidden = true;
    pill.appendChild(b);
    b.click();
    b.remove();
  }
}

function onKey(ev) {
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key !== "p" && ev.key !== "P") return;
  const t = ev.target;
  if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? "")) return;
  if (!hand.pass || hand.pass.classList.contains("is-hidden") || !isActive()) return;
  if (myUnit()?.classList.contains("is-open")) return;   // a picker has the drawer
  ev.preventDefault();
  togglePass();
}

// ── allies: glow, small cards, Passed / Done ─────────────────────────────────
const allies = new Map();   // actorId → { minis: Map(key → el), had: bool, applied: bool }

function allyCardFor(actorId) {
  return actorId ? document.querySelector(`.dhud-root .dhud-card[data-actor-id="${CSS.escape(actorId)}"]`) : null;
}

function syncAllies(pills, wrapper) {
  const byActor = new Map();
  for (const r of pills) {
    if (r.mine || !r.reactorUuid || r.state === "off") continue;
    const id = actorFromUuid(r.reactorUuid)?.id;
    if (!id) continue;
    if (!byActor.has(id)) byActor.set(id, []);
    byActor.get(id).push(r);
  }
  for (const id of new Set([...allies.keys(), ...byActor.keys()])) {
    const card = allyCardFor(id);
    const rs = byActor.get(id) ?? [];
    let a = allies.get(id);
    if (!a) { a = { minis: new Map() }; allies.set(id, a); }
    if (!card) continue;
    let box = card.querySelector(":scope > .rxh-minis");
    if (!box) {
      box = document.createElement("div");
      box.className = "rxh-minis";
      card.appendChild(box);
      a.minis.clear();
    }
    let tag = card.querySelector(":scope > .rxh-tag");
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "rxh-tag";
      card.appendChild(tag);
    }
    const pending = rs.filter((r) => r.state === "live" || r.state === "busy");
    const applied = rs.some((r) => r.state === "applied");
    const seen = new Set();
    let dealt = 0;
    for (const r of pending) {
      seen.add(r.key);
      if (a.minis.has(r.key)) continue;
      const m = document.createElement("span");
      m.className = "rxh-mini is-dealt";
      m.style.setProperty("--d", `${200 + dealt++ * 130}ms`);
      if (r.icon) m.innerHTML = `<img src="${esc(r.icon)}" alt="">`;
      box.appendChild(m);
      a.minis.set(r.key, m);
    }
    for (const [key, m] of a.minis) {
      if (seen.has(key)) continue;
      a.minis.delete(key);
      const r = rs.find((x) => x.key === key);
      if (r?.state === "applied" && wrapper) flyToCard(m, wrapper, () => m.remove(), { scaleEnd: 0.7, rise: false });
      else { m.classList.add("is-leaving"); setTimeout(() => m.remove(), reduced() ? 340 : 460); }
    }
    [...a.minis.values()].forEach((m, i) => { m.style.left = `${i * 25}px`; m.style.setProperty("--r", i % 2 ? "6deg" : "-6deg"); });
    const deciding = pending.length > 0;
    const answered = rs.length > 0 && !deciding;
    card.classList.toggle("rxh-deciding", deciding);
    tag.innerHTML = `${CHECK}${applied ? "Done" : "Passed"}`;
    tag.classList.toggle("is-on", answered);
  }
}

function clearAllies() {
  for (const [id, a] of allies) {
    const card = allyCardFor(id);
    card?.classList.remove("rxh-deciding");
    card?.querySelector(":scope > .rxh-tag")?.classList.remove("is-on");
    for (const m of a.minis.values()) { m.classList.add("is-leaving"); setTimeout(() => m.remove(), 460); }
  }
  allies.clear();
}

// ── the loop ─────────────────────────────────────────────────────────────────
let _queued = false;
let _wrapperObs = null;
let _observed = null;
let _closeT = null;

function schedule() {
  if (_queued) return;
  _queued = true;
  requestAnimationFrame(() => { _queued = false; sync(); });
}

function observeWrapper(w) {
  if (_observed === w) return;
  _wrapperObs?.disconnect();
  _observed = w;
  if (!w) return;
  _wrapperObs = new MutationObserver(schedule);
  _wrapperObs.observe(w, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "data-fud-reaction-pending", "data-fud-reaction-submitting", "data-fud-reaction-moot"],
  });
}

function sync() {
  const active = isActive();
  document.body.classList.toggle(BODY_CLASS, active);
  const w = document.getElementById(MIRROR_ROOT_ID);
  observeWrapper(w);
  if (!active) { teardown(); return; }
  if (!w) {
    // The card closed (or is being re-posted): give a re-post a moment to land
    // so the same reactions are not dealt twice, then fold the hand away.
    if (!_closeT) _closeT = setTimeout(() => { _closeT = null; if (!document.getElementById(MIRROR_ROOT_ID)) { syncHand([], null); clearAllies(); } }, 400);
    return;
  }
  clearTimeout(_closeT); _closeT = null;
  const pills = readPills(w);
  try { syncHand(pills, w); } catch (e) { console.warn(TAG, "hand sync failed", e); }
  try { syncAllies(pills, w); } catch (e) { console.warn(TAG, "ally sync failed", e); }
}

function teardown() {
  if (hand.clip) {
    hand.clip.remove();
    hand.tag?.remove();
    hand.clip = hand.pass = hand.tag = null;
    hand.cards.clear();
    document.querySelector(".dhud-plate-root .dhud-unit")?.classList.remove("rxh-has-hand");
  }
  clearAllies();
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS_TEXT;
  document.head.appendChild(st);
}

Hooks.once("ready", () => {
  injectStyles();
  // The mirror card is a direct child of <body>; watch only that level.
  new MutationObserver(schedule).observe(document.body, { childList: true });
  Hooks.on("fuClientOptionChanged", ({ key }) => { if (key === "reactionUi") schedule(); });
  window.addEventListener("keydown", onKey);
  // The HUD rebuilds on its own schedule (resize, roster changes); a slow
  // heartbeat re-attaches the hand and ally marks to whatever is current.
  setInterval(() => { if (document.getElementById(MIRROR_ROOT_ID) || hand.clip) schedule(); }, 1000);
  schedule();
});

const CSS_TEXT = `
/* Card mode: the action card no longer carries the reaction pills. They stay
   in the DOM (the hand acts through them), just not on screen. */
body.${BODY_CLASS} #${MIRROR_ROOT_ID} .fud-bf-reactions-row { display: none !important; }

/* ── the hand: cards tucked behind the plate, name bands peeking ── */
.rxh-clip {
  position: absolute; left: 0; right: -30px; top: -776px; bottom: 0;
  overflow: hidden; z-index: -1; pointer-events: none;
  transition: opacity 220ms ease, transform 260ms ease;
}
.dhud-unit.is-open .rxh-clip { opacity: 0; transform: translateY(60px); }
.dhud-unit.is-open .rxh-clip * { pointer-events: none !important; }
.dhud-unit.rxh-has-hand .dhud-take, .dhud-unit.rxh-has-hand .dhud-wait { display: none !important; }
.rxh-card {
  position: absolute; top: 732px; width: ${CARD_W}px; height: 300px; box-sizing: border-box; padding: 4px;
  border-radius: 12px; background: #3a3228; border: 2px solid #b7935a; box-shadow: 0 10px 24px rgba(0,0,0,.5);
  transform-origin: bottom center; pointer-events: auto;
  transition: transform 220ms cubic-bezier(.2,.8,.2,1), translate 220ms ease, left 340ms cubic-bezier(.3,.7,.3,1), filter 300ms ease;
  font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif; color: #3a3228;
}
/* A raised card reads in front of the action card (z 95), which it can reach
   at smaller window sizes; the plate goes back under it when the hover ends. */
.dhud-plate-root:has(.rxh-card:hover) { z-index: 96; }
.rxh-card:hover { z-index: 10; transform: translateY(-252px) scale(1.25); box-shadow: 0 0 0 2px #d5b67a, 0 18px 40px rgba(0,0,0,.6); }
.rxh-card:has(~ .rxh-card:hover) { translate: -28px 0; }
.rxh-card:hover ~ .rxh-card { translate: 28px 0; }
@keyframes rxhDeal { from { transform: translate(340px, 70px) rotate(16deg); opacity: 0; } 55% { opacity: 1; } to { transform: none; opacity: 1; } }
.rxh-card.is-dealt { animation: rxhDeal 560ms cubic-bezier(.2,.8,.2,1) var(--d, 0ms) backwards; }
.rxh-face {
  position: relative; height: 100%; box-sizing: border-box; border-radius: 8px; overflow: hidden;
  display: flex; flex-direction: column; background: linear-gradient(180deg, #fbf6ea, #efe5cf);
}
.rxh-face::after { content: ""; position: absolute; inset: 3px; border: 1px solid rgba(183,147,90,.55); border-radius: 6px; pointer-events: none; }
.rxh-name {
  flex: none; height: 44px; box-sizing: border-box; padding: 0 10px; display: flex; align-items: center;
  background: #3a3228; color: #f6f1e6; border-bottom: 2px solid #b7935a; font: 800 13px/1.15 "Inter", "Signika", sans-serif;
}
.rxh-name .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rxh-card.is-live .rxh-name {
  background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14); border-bottom-color: #e2c27e;
  box-shadow: inset 0 0 0 1px rgba(255,220,180,.35), 0 0 16px 3px rgba(222,66,46,.6);
}
@keyframes rxhGlow { from { box-shadow: 0 0 10px 2px rgba(222,66,46,.5); } to { box-shadow: 0 0 22px 6px rgba(232,72,50,.78); } }
.rxh-card.is-live::before {
  content: ""; position: absolute; left: -2px; right: -2px; top: -2px; height: 50px; border-radius: 12px 12px 4px 4px;
  pointer-events: none; animation: rxhGlow 3.4s ease-in-out infinite alternate;
}
.rxh-art { position: relative; flex: none; height: 78px; background: #d9c9a8; overflow: hidden; border-bottom: 1px solid rgba(122,106,85,.5); }
.rxh-art .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 18%; border: none; }
.rxh-art .emb { position: absolute; left: 8px; bottom: 8px; width: 40px; height: 40px; border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 2px #b7935a, 0 2px 6px rgba(0,0,0,.35); }
.rxh-art .emb img { width: 100%; height: 100%; object-fit: cover; display: block; border: none; }
.rxh-type { flex: none; padding: 5px 10px 3px; font: 800 9px "Inter", "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #7a6a55; }
.rxh-text {
  flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 0 10px; font: 400 10.5px/14px "Inter", "Signika", sans-serif;
  -webkit-mask-image: linear-gradient(180deg, #000 80%, transparent); mask-image: linear-gradient(180deg, #000 80%, transparent);
}
.rxh-text p { margin: 0 0 4px; }
.rxh-btns { flex: none; display: flex; padding: 7px 8px 8px; }
.rxh-use {
  flex: 1; height: 28px; margin: 0; cursor: pointer; border-radius: 8px; border: 2px solid #e2c27e;
  font: 800 13px "Inter", "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #fff3e6;
  background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14);
  box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 14px 2px rgba(222,66,46,.5); text-shadow: 0 1px 0 rgba(60,8,4,.6);
}
.rxh-card:not(.is-live) .rxh-use { visibility: hidden; }
.rxh-card.is-busy { filter: saturate(.7); }
.rxh-card.is-busy .rxh-name::after { content: "…"; margin-left: 4px; }
.rxh-card.is-off .rxh-face { filter: grayscale(.75); opacity: .75; }
.rxh-ribbon { display: none; }
.rxh-card.is-off .rxh-ribbon {
  display: block; position: absolute; left: -30px; top: 120px; width: 260px; transform: rotate(-14deg); text-align: center; padding: 4px 0;
  background: #b3261e; color: #fff3e6; font: 800 12px "Inter", "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase;
  box-shadow: 0 2px 6px rgba(0,0,0,.35); z-index: 2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rxh-card.is-skipped, .rxh-card.is-skipped:hover { transform: translateY(40px); filter: saturate(.35) brightness(.8); box-shadow: 0 6px 14px rgba(0,0,0,.4); pointer-events: none; }
@keyframes rxhSink { to { transform: translateY(190px) rotate(5deg); opacity: 0; filter: grayscale(1); } }
.rxh-card.is-leaving { animation: rxhSink 420ms cubic-bezier(.5,0,.8,.4) forwards; pointer-events: none; }

/* Pass: the last slot of the hand */
.rxh-pass {
  position: absolute; top: 732px; width: ${PASS_W}px; height: 300px; box-sizing: border-box; padding: 4px; margin: 0;
  display: flex; flex-direction: column; justify-content: flex-start; align-items: stretch;
  border-radius: 12px; background: #3a3228; border: 2px solid #b7935a; box-shadow: 0 10px 24px rgba(0,0,0,.5);
  pointer-events: auto; cursor: pointer; text-align: left;
  transition: left 340ms cubic-bezier(.3,.7,.3,1), transform 160ms ease, opacity 200ms ease;
}
.rxh-pass:hover { transform: translateY(-6px); }
.rxh-pass.is-hidden { opacity: 0; pointer-events: none; }
.rxh-pass:disabled { cursor: wait; opacity: .6; }
.rxh-pband {
  display: flex; align-items: center; gap: 4px; height: 36px; box-sizing: border-box; padding: 0 5px 0 8px; border-radius: 8px;
  background: linear-gradient(180deg, #fbf6ea, #e6dbc2); color: #3a3228; box-shadow: inset 0 0 0 1px rgba(183,147,90,.6);
}
.rxh-pl { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.05; }
.rxh-pass .gl { font: 800 14px "Inter", "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase; }
.rxh-pass .ps { font: 700 9px "Inter", "Signika", sans-serif; letter-spacing: .04em; color: #8a7d68; }
.rxh-pass .ps:empty { display: none; }
.rxh-pass .k { font: 700 10px "Inter", "Signika", sans-serif; padding: 2px 5px; border-radius: 3px; color: #9a8d76; background: rgba(58,50,40,.08); }
.rxh-pass.is-on .rxh-pband { background: linear-gradient(180deg, #4a4034, #2e271f); color: #f6f1e6; box-shadow: inset 0 2px 6px rgba(0,0,0,.6), inset 0 0 0 1px #d5b67a; }
.rxh-pass.is-on .ps { color: #d5b67a; }
.rxh-pass.is-on .k { display: none; }

/* your own PASSED tag, and the allies' */
.rxh-mytag, .rxh-tag {
  position: absolute; z-index: 6; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px 2px 6px; border-radius: 5px;
  background: #3a3228; border: 1.5px solid #b7935a; color: #f6f1e6; font: 800 10px "Inter", "Signika", sans-serif;
  letter-spacing: .12em; text-transform: uppercase; pointer-events: none;
  opacity: 0; transform: scale(1.7); transition: opacity 160ms ease, transform 260ms cubic-bezier(.3,1.6,.5,1);
}
.rxh-mytag { left: 96px; top: -13px; }
.rxh-tag { right: 10px; top: -12px; }
.rxh-mytag.is-on, .rxh-tag.is-on { opacity: 1; transform: none; }

/* allies: glow while deciding, one small card per reaction */
@keyframes rxhAlly {
  from { box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 8px 22px rgba(0,0,0,.42), 0 0 10px 2px rgba(222,66,46,.5); }
  to   { box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 8px 22px rgba(0,0,0,.42), 0 0 26px 8px rgba(232,72,50,.8); }
}
.dhud-card.rxh-deciding { animation: rxhAlly 3.4s ease-in-out infinite alternate; }
.rxh-minis { position: absolute; left: 156px; top: -31px; width: 60px; height: 46px; z-index: -1; pointer-events: none; }
.rxh-mini {
  position: absolute; top: 0; width: 30px; height: 44px; box-sizing: border-box; border-radius: 5px; border: 1.5px solid #e2c27e;
  background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14); box-shadow: 0 2px 6px rgba(0,0,0,.45);
  display: grid; place-items: start center; padding-top: 4px; transform: rotate(var(--r, 0deg)); transition: left 300ms ease;
}
.rxh-mini img { width: 20px; height: 20px; border-radius: 4px; box-shadow: 0 0 0 1px #e2c27e; border: none; }
@keyframes rxhMiniIn { from { transform: translateY(46px) rotate(var(--r, 0deg)); opacity: 0; } to { transform: rotate(var(--r, 0deg)); opacity: 1; } }
.rxh-mini.is-dealt { animation: rxhMiniIn 460ms cubic-bezier(.2,.8,.2,1) var(--d, 0ms) backwards; }
@keyframes rxhMiniOut { 40% { transform: translateY(-6px) rotateY(90deg) rotate(var(--r, 0deg)); } 100% { transform: translateY(46px) rotateY(90deg) rotate(var(--r, 0deg)); opacity: 0; } }
.rxh-mini.is-leaving { animation: rxhMiniOut 440ms ease-in forwards; }

/* in flight, above everything */
.rxh-flyer { position: fixed !important; top: 0; z-index: 10050; margin: 0; pointer-events: none; transform-origin: bottom center; translate: none !important; animation: none !important; }
.rxh-ring { position: fixed; z-index: 10051; pointer-events: none; border: 2px solid #e2c27e; border-radius: 10px; box-shadow: 0 0 18px rgba(226,194,126,.8); }

/* Reduced motion: nothing moves — cards fade in and out, hover raises at once. */
@media (prefers-reduced-motion: reduce) {
  .rxh-card { transition: none; }
  @keyframes rxhFade { from { opacity: 0; } }
  @keyframes rxhOut { to { opacity: 0; } }
  .rxh-card.is-dealt, .rxh-mini.is-dealt { animation: rxhFade 220ms ease var(--d, 0ms) backwards; }
  .rxh-card.is-leaving, .rxh-mini.is-leaving { animation: rxhOut 320ms ease forwards; }
  .rxh-card.is-skipped, .rxh-card.is-skipped:hover { transform: none; }
  .rxh-mytag, .rxh-tag { transform: none !important; }
  .dhud-unit.is-open .rxh-clip { transform: none; }
}
`;
