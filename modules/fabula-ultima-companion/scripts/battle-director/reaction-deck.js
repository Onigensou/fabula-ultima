// Reaction deck — your ready reactions as a deck beside your portrait, and the
// used-up ones as a SPENT pile (Card Reaction UI, player clients only).
//
// The hand (reaction-hand.js) shows the reactions a window lets you answer;
// the deck is where they wait the rest of the time, so a player can track them.
// A window DRAWS the fitting cards out of the deck into the hand and they go
// back when passed or no longer applicable; a used limited card lands on SPENT
// and hops back onto the deck when it refills. An `on` reaction is the same
// card: when it fires it is drawn, held a moment to read, and plays itself.
// Each ally's compact card gets a tab with their deck count (+ spent in grey);
// their small cards come out of it, and clicking it opens their deck.
//
// What counts (one card per CARRIER: an item, or an AE with a reactionConfig):
//   in the deck  — the carrier has an `ask` or `on` row (force rows never show)
//   SPENT        — its consume_charge (on_empty: abort) charge is empty, its Max
//                  Fires quota is used up, or it is a conflict_start-only row and
//                  the conflict has begun
//   can't pay    — stays in the deck, with a ribbon in the inspect panel
// The Max Fires counter lives on the host's director; the host publishes it
// (FU_RXDECK_FIRES) and answers a late joiner's hello. Everything else is read
// off the actors on this client (a player can read the other PCs' items/AEs —
// measured 2026-10-30: Observer on every PC).
//
// Display only, FAILS QUIET: nothing here decides or blocks a reaction.
// Approved mockup v2: claude.ai/artifact/A6cWr7EbVekVLrB18X4BiV.

import { getClientOption } from "../shared/client-options.js";
import { battleIsSettled, hudScale } from "./director-player-hud.js";
import { faceEl, glowActionCard, HAND_GEOM } from "./reaction-hand.js";

const NS = "fabula-ultima-companion";
const TAG = "[ReactionDeck]";
const STYLE_ID = "fud-rxd-style";
const ACTION_FIRES = "FU_RXDECK_FIRES";
const ACTION_HELLO = "FU_RXDECK_HELLO";
const MIRROR_ROOT_ID = "fud-bf-mirror-root";

// Piles, in plate px (the unit's padding box), left of the portrait.
const CARD_W = 164, CARD_H = 236;
const PILE_W = 72, PILE_H = 104;
const READY_LEFT = -193, SPENT_LEFT = -285, PILE_TOP = -8;
const INSP_W = 878;

// Motion (approved spec, 1x).
const DEAL_MS = 380, BACK_MS = 300, PLAY_MS = 340, REFILL_MS = 460, FADE_MS = 220;
const AUTO_OUT_MS = 180, AUTO_READ_MS = 300, AUTO_IN_MS = 220;   // the user's "Snappy" pick
const PENDING_AFTER_CLOSE_MS = 4000;   // a played limited card reads SPENT until the host confirms
const PENDING_MAX_WAIT_MS = 20000;     // …or this long after its card closed, if the battle never moved
const HELLO_MS = 5000;

const OUT_OF_BATTLE = new Set(["party_rested", "session_started"]);
const BACK_ORDER = ["turn_start", "round_start", "conflict_start"];
const BACK_TEXT = { turn_start: "At the start of your turn", round_start: "Next round", conflict_start: "Next battle" };
const SCOPE_WORD = { round: "round", battle: "battle", target: "target", target_round: "target each round" };
const RES_LABEL = { mp: "MP", hp: "HP", ip: "IP", zp: "ZP", fp: "FP" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let _fxMod = null, _chgMod = null;
const fxMod = () => (_fxMod ??= import("./skill-effects.js").catch(() => null));
const chgMod = () => (_chgMod ??= import("./skill-charges.js").catch(() => null));

// ── state ────────────────────────────────────────────────────────────────────
const D = {
  decks: new Map(),      // actorId → entry[]
  prev: new Map(),       // actorId → Map(carrierUuid → state) — refill detection
  inHand: new Set(),     // carrierUuids in your hand right now
  allyHand: new Map(),   // actorId → Set(carrierUuid) of their small cards out
  pending: new Map(),    // carrierUuid → { until } — played limited card, SPENT until confirmed
  auto: new Set(),       // carrierUuids mid auto-play
  hopping: new Set(),    // carrierUuids mid refill hop
  fires: null,           // host snapshot { round, counts, live }
  ui: null,              // { unit, ready, spent, fly }
  insp: null,            // { who, sel, el }
  counts: new Map(),     // pile/tab element → last count shown (to thump on change)
};

// ── reading a carrier ────────────────────────────────────────────────────────
function modeOf(row) {
  const m = String(row?.reaction_passive_mode ?? "").trim().toLowerCase();
  return ["on", "ask", "off", "force"].includes(m) ? m : "ask";
}
function liveRows(rc) {
  return Object.entries(rc ?? {}).filter(([, r]) => r && typeof r === "object" && r.$deleted !== true);
}
function hasEffects(et) { return Object.values(et ?? {}).some((e) => e && e.$deleted !== true); }

function carriersOf(actor, fx) {
  const out = [];
  for (const item of actor?.items?.contents ?? []) {
    const props = item.system?.props;
    const rc = props?.reaction_config_table;
    if (!rc || typeof rc !== "object") continue;
    try {
      if (fx?.weaponReactionInPlay && !fx.weaponReactionInPlay(item, {}, actor)) continue;
      if (fx?.containerReactionInPlay && !fx.containerReactionInPlay(item, actor, {})) continue;
    } catch { /* fail open */ }
    out.push({ doc: item, rc, et: props.effect_table ?? {}, formulaCarrier: item,
      name: item.name, icon: item.img, desc: props.description ?? "" });
  }
  for (const ae of actor?.appliedEffects ?? []) {
    if (ae.disabled) continue;
    const cfg = ae.flags?.[NS]?.reactionConfig;
    const rc = cfg?.reaction_config_table;
    if (!rc || typeof rc !== "object") continue;
    const et = cfg.effect_table ?? {};
    out.push({ doc: ae, rc, et, formulaCarrier: { name: ae.name, system: { props: { effect_table: et } } },
      name: ae.name, icon: ae.icon ?? ae.img, desc: ae.description ?? "" });
  }
  return out;
}

// "Comes back": the carrier's own auto refill row (Protect: turn_start). A
// conditional refill (Prophetic Defender: even rounds) can't be promised.
function refillText(rc, cardKeys) {
  let best = null, bestCond = null;
  for (const [k, row] of liveRows(rc)) {
    if (cardKeys.has(k)) continue;
    const m = modeOf(row);
    if (m !== "force" && m !== "on") continue;
    const i = BACK_ORDER.indexOf(String(row.reaction_trigger ?? "").trim());
    if (i < 0) continue;
    if (String(row.condition_formula ?? "").trim()) bestCond = bestCond == null ? i : Math.min(bestCond, i);
    else best = best == null ? i : Math.min(best, i);
  }
  if (best == null && bestCond == null) return null;
  if (best == null || (bestCond != null && bestCond < best)) return "Refills later";
  return BACK_TEXT[BACK_ORDER[best]];
}

function firesCount(carrierUuid, rowKey, scope) {
  const f = D.fires;
  if (!f?.live) return 0;
  const bucket = scope === "battle" ? "all" : String(f.round ?? 0);
  return Number(f.counts?.[`${carrierUuid}::${rowKey}::${bucket}`] ?? 0) || 0;
}

function rowStatus(c, key, row, actor, fx, chg, inBattle, back) {
  const trig = String(row.reaction_trigger ?? "").trim();
  if (trig === "conflict_start") {
    return inBattle
      ? { st: "spent", spent: "Once per conflict", back: "Next battle", limit: "Once per conflict" }
      : { st: "ready", limit: "Once per conflict", back: "Next battle" };
  }
  let limit = null, qBack = null;
  const max = fx?.readReactionMaxPerRound?.(row) ?? 0;
  if (max) {
    const scope = fx.readReactionMaxScope(row);
    limit = `${max} per ${SCOPE_WORD[scope] ?? scope}`;
    qBack = scope === "round" ? "Next round" : scope === "battle" ? "Next battle" : null;
    if ((scope === "round" || scope === "battle") && firesCount(c.doc.uuid, key, scope) >= max) {
      return { st: "spent", limit, back: qBack, spent: scope === "round" ? "Used this round" : "Used this battle" };
    }
  }
  const ref = String(row.reaction_effect_ref ?? "").trim();
  let cost = null;
  try { cost = ref && fx?.analyzeChainCost ? fx.analyzeChainCost(c.et, ref, actor, c.formulaCarrier) : null; } catch { cost = null; }
  if (cost?.ok) {
    const ck = Object.keys(cost.chargeDebit ?? {})[0];
    if (ck) {
      const hits = chg?.findOnActor?.(actor, { key: ck }) ?? [];
      const have = hits.reduce((a, h) => a + (Number(h.charges) || 0), 0);
      let label = String(hits[0]?.effect?.name ?? "").replace(/\s+Ready$/i, "").trim();
      if (!label || label === c.name) label = have === 1 ? "charge" : "charges";
      if (have > 0) limit = limit ?? `×${have} ${label}`;
    }
    const chargeShort = (cost.shortfalls ?? []).find((s) => s.kind === "charge");
    if (chargeShort) return { st: "spent", limit, back: back ?? qBack ?? "Refills later", spent: "No charges left" };
    const res = (cost.shortfalls ?? []).filter((s) => s.kind === "resource");
    if (res.length) {
      const s = res[0];
      const lbl = RES_LABEL[s.resource] ?? String(s.resource).toUpperCase();
      return { st: "cantpay", limit, back: back ?? qBack, why: `Need ${s.required} ${lbl}`, have: `${s.current} ${lbl}` };
    }
  }
  return { st: "ready", limit, back: back ?? qBack };
}

async function buildDeck(actor) {
  const [fx, chg] = await Promise.all([fxMod(), chgMod()]);
  const inBattle = !!document.querySelector(".dhud-plate-root .dhud-unit, .dhud-root .dhud-card");
  const out = [];
  for (const c of carriersOf(actor, fx)) {
    const rows = liveRows(c.rc).filter(([, r]) => {
      const m = modeOf(r);
      if (m !== "ask" && m !== "on") return false;
      if (OUT_OF_BATTLE.has(String(r.reaction_trigger ?? "").trim())) return false;
      if (String(r.reaction_responder ?? "").trim().toLowerCase() === "target") return false;
      // An unimplemented shell can never fire (the engine downgrades it).
      if (!String(r.reaction_effect_ref ?? "").trim() && !hasEffects(c.et)) return false;
      return true;
    });
    if (!rows.length) continue;
    const back = refillText(c.rc, new Set(rows.map(([k]) => k)));
    const st = rows.map(([k, r]) => ({ k, r, s: rowStatus(c, k, r, actor, fx, chg, inBattle, back) }));
    const pick = st.find((x) => x.s.st === "ready") ?? st.find((x) => x.s.st === "cantpay") ?? st[0];
    const prim = rows.find(([, r]) => modeOf(r) === "ask") ?? rows[0];
    out.push({
      id: c.doc.uuid, carrierUuid: c.doc.uuid, rowKey: pick.k ?? prim[0],
      actorId: actor.id, reactorUuid: actor.uuid,
      name: c.name, icon: c.icon, desc: c.desc,
      auto: rows.every(([, r]) => modeOf(r) === "on"),
      state: pick.s.st, limit: pick.s.limit ?? null, back: pick.s.back ?? null,
      spent: pick.s.spent ?? null, why: pick.s.why ?? null, have: pick.s.have ?? null,
      limited: st.some((x) => !!x.s.limit || x.s.st === "spent"),
    });
  }
  return out;
}

// ── which state a card SHOWS (hand / pending / auto override the data) ─────
function shownState(e, handSet) {
  if (handSet?.has(e.carrierUuid)) return "hand";
  if (D.pending.has(e.carrierUuid) && e.state !== "spent") return "spent";
  if (D.hopping.has(e.carrierUuid)) return "hop";
  if (D.auto.has(e.carrierUuid)) return "auto";
  return e.state === "spent" ? "spent" : "ready";
}
function tally(actorId) {
  const deck = D.decks.get(actorId) ?? [];
  const hand = actorId === myActorId() ? D.inHand : (D.allyHand.get(actorId) ?? new Set());
  let ready = 0, spent = 0, inHand = 0;
  for (const e of deck) {
    const s = shownState(e, hand);
    if (s === "ready") ready++;
    else if (s === "spent") spent++;
    else if (s === "hand") inHand++;
  }
  return { ready, spent, inHand, total: deck.length };
}

// ── who is active ────────────────────────────────────────────────────────────
function myUnit() {
  const u = document.querySelector(".dhud-plate-root .dhud-unit");
  return u?.isConnected ? u : null;
}
function myActorId() { return myUnit()?.dataset.actorId ?? null; }
function isActive() {
  if (game.user?.isGM) return false;
  if (getClientOption("reactionUi") !== "card") return false;
  return !!myUnit();
}
function allyCards() {
  const me = myActorId();
  return [...document.querySelectorAll(".dhud-root .dhud-card[data-actor-id]")].filter((c) => c.dataset.actorId !== me);
}
function shownActorIds() {
  const ids = new Set();
  const me = myActorId();
  if (me) ids.add(me);
  for (const c of allyCards()) ids.add(c.dataset.actorId);
  return ids;
}

// ── recompute (debounced; on actor / item / AE changes and fire counts) ─────
let _recT = null;
const _dirty = new Set();
function scheduleRecompute(actorId = null) {
  if (actorId) _dirty.add(actorId); else for (const id of shownActorIds()) _dirty.add(id);
  if (_recT) return;
  _recT = setTimeout(() => { _recT = null; recompute().catch((e) => console.warn(TAG, "recompute failed", e)); }, 150);
}
async function recompute() {
  if (!isActive()) { _dirty.clear(); return; }
  const shown = shownActorIds();
  const ids = [..._dirty].filter((id) => shown.has(id));
  _dirty.clear();
  for (const id of ids) {
    const actor = game.actors?.get(id);
    if (!actor) continue;
    const deck = await buildDeck(actor);
    D.decks.set(id, deck);
    const before = D.prev.get(id);
    const now = new Map(deck.map((e) => [e.carrierUuid, e.state]));
    D.prev.set(id, now);
    // A played card the host has now really spent: drop the stand-in.
    for (const e of deck) if (e.state === "spent") D.pending.delete(e.carrierUuid);
    if (before && id === myActorId()) {
      for (const e of deck) {
        if (before.get(e.carrierUuid) === "spent" && e.state !== "spent" && !D.pending.has(e.carrierUuid) && !D.inHand.has(e.carrierUuid)) {
          hopRefill(e).catch(() => {});
        }
      }
    }
  }
  render();
}

// ── piles on your plate ──────────────────────────────────────────────────────
const BACK_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <path d="M50 8 L82 50 L50 92 L18 50 Z" fill="url(#rxd-gG)" stroke="#e2c27e" stroke-width="3"/><path d="M50 22 L71 50 L50 78 L29 50 Z" fill="none" stroke="rgba(255,220,180,.55)" stroke-width="1.5"/>
  <path d="M42 40 h16 v22 h-16 z" fill="#f6f1e6" stroke="#3a3228" stroke-width="2" transform="rotate(-10 50 50)"/><path d="M46 36 h16 v22 h-16 z" fill="#efe5cf" stroke="#3a3228" stroke-width="2" transform="rotate(8 50 50)"/></svg>`;
function backEl() {
  const b = document.createElement("div");
  b.className = "rxd-back";
  b.innerHTML = BACK_SVG;
  return b;
}
function ensureDefs() {
  if (document.getElementById("rxd-defs")) return;
  const d = document.createElement("div");
  d.id = "rxd-defs";
  d.innerHTML = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="rxd-gG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c4473a"/><stop offset=".6" stop-color="#8e2219"/><stop offset="1" stop-color="#741a14"/></linearGradient></defs></svg>';
  document.body.appendChild(d);
}

function makePile(kind) {
  const p = document.createElement("div");
  p.className = `rxd-pile is-${kind} n0`;
  p.setAttribute("role", "button");
  p.title = kind === "ready" ? "Your reactions: click to look through" : "Spent: used up, waiting to come back";
  const lyr = (n) => `<div class="lyr l${n}"></div>`;
  p.innerHTML = `<div class="stk"><div class="slot"></div>${lyr(3)}${lyr(2)}${kind === "ready" ? lyr(1) : '<div class="face"></div>'}</div>
    <div class="cnt">0</div><div class="plq">${kind === "ready" ? "REACTIONS" : "SPENT"}</div>`;
  p.querySelectorAll(".lyr").forEach((l) => l.appendChild(backEl()));
  p.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const me = myActorId();
    if (!me) return;
    if (D.insp?.who === me) { closeInspect(); return; }
    let sel = null;
    if (kind === "spent") {
      const t = tally(me);
      if (t.spent) sel = (D.decks.get(me) ?? []).filter((e) => shownState(e, D.inHand) === "spent").pop()?.carrierUuid ?? null;
    }
    openInspect(me, sel);
  });
  return p;
}

function ensureUi() {
  const unit = myUnit();
  if (!unit) return null;
  if (D.ui?.unit === unit && D.ui.ready.isConnected && D.ui.fly.isConnected) return D.ui;
  D.ui?.ready?.remove(); D.ui?.spent?.remove(); D.ui?.fly?.remove();
  ensureDefs();
  const ready = makePile("ready"), spent = makePile("spent");
  const fly = document.createElement("div");
  fly.className = "rxd-fly";
  unit.append(spent, ready);
  // Flights paint over the hand (it's prepended to the unit) but under the plate.
  const clip = unit.querySelector(":scope > .rxh-clip");
  if (clip) clip.after(fly); else unit.prepend(fly);
  D.ui = { unit, ready, spent, fly };
  D.counts.clear();
  scheduleRecompute();
  hello();
  return D.ui;
}
// The hand's clip can be (re)prepended after the fly layer was placed; keep
// the flights above it.
function keepFlyAboveHand() {
  const ui = D.ui;
  const clip = ui?.unit.querySelector(":scope > .rxh-clip");
  if (clip && ui.fly.previousElementSibling !== clip) clip.after(ui.fly);
}

function setCount(el, n, host) {
  const c = el.querySelector(".cnt, .n");
  if (!c) return;
  const prev = D.counts.get(el);
  if (prev === n) return;
  c.textContent = String(n);
  D.counts.set(el, n);
  if (host) { host.classList.remove("n0", "n1", "n2"); if (n < 3) host.classList.add(`n${n}`); }
  if (prev != null && !reducedMotion()) { c.classList.remove("rxd-thump"); void c.offsetWidth; c.classList.add("rxd-thump"); }
}
function glowPile(pile) {
  const s = pile?.querySelector(".stk") ?? pile;
  if (!s || reducedMotion()) return;
  s.classList.remove("rxd-glow"); void s.offsetWidth; s.classList.add("rxd-glow");
}

function renderPiles() {
  const ui = ensureUi();
  if (!ui) return;
  keepFlyAboveHand();
  const me = myActorId();
  const t = tally(me);
  setCount(ui.ready, t.ready, ui.ready);
  setCount(ui.spent, t.spent, ui.spent);
  ui.ready.title = `Your reactions: ${t.ready} ready${t.inHand ? `, ${t.inHand} in hand` : ""}. Click to look through`;
  const top = (D.decks.get(me) ?? []).filter((e) => shownState(e, D.inHand) === "spent").pop();
  const f = ui.spent.querySelector(".face");
  const want = top?.carrierUuid ?? "";
  if (f && f.dataset.id !== want) {
    f.innerHTML = "";
    if (top) f.appendChild(entryFace(top));
    f.dataset.id = want;
  }
}

function entryFace(e, cls = "") {
  const el = faceEl({ key: e.carrierUuid, rowKey: e.rowKey, carrierUuid: e.carrierUuid, reactorUuid: e.reactorUuid,
    name: e.name, icon: e.icon, desc: e.desc, type: "Reaction" }, cls);
  const rib = el.querySelector(".rxh-ribbon");
  if (rib && e.state === "cantpay") rib.textContent = e.why ?? "Can't pay";
  return el;
}

// ── ally tabs ────────────────────────────────────────────────────────────────
export function deckAllyTab(actorId) {
  if (!isActive()) return null;
  const card = allyCards().find((c) => c.dataset.actorId === actorId);
  if (!card) return null;
  return ensureAllyTab(card);
}
function ensureAllyTab(card) {
  const ctab = card.querySelector(":scope > .dhud-ctab");
  if (!ctab) return null;
  let tab = ctab.querySelector(":scope > .rxd-atab");
  if (tab) return tab;
  tab = document.createElement("span");
  tab.className = "rxd-atab";
  tab.setAttribute("role", "button");
  tab.innerHTML = `<i></i><span class="n">0</span><span class="sp"><i></i><span class="sn">0</span></span>`;
  tab.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const id = card.dataset.actorId;
    if (D.insp?.who === id) closeInspect(); else openInspect(id, null);
  });
  ctab.appendChild(tab);
  return tab;
}
function renderAllyTabs() {
  for (const card of allyCards()) {
    const id = card.dataset.actorId;
    const deck = D.decks.get(id);
    if (!deck) { scheduleRecompute(id); continue; }
    if (!deck.length) { card.classList.remove("rxd-has-tab"); card.querySelector(".rxd-atab")?.remove(); continue; }
    const tab = ensureAllyTab(card);
    if (!tab) continue;
    card.classList.add("rxd-has-tab");
    const t = tally(id);
    setCount(tab, t.ready, null);
    const sp = tab.querySelector(".sp");
    sp.classList.toggle("on", t.spent > 0);
    sp.querySelector(".sn").textContent = String(t.spent);
    const name = game.actors?.get(id)?.name ?? "Ally";
    tab.title = `${name}'s reactions: ${t.ready} ready, ${t.spent} spent. Click to look through`;
    tab.classList.toggle("is-open", D.insp?.who === id);
  }
}

// `inspect: false` leaves an open panel alone (the heartbeat must not rebuild
// the tiles under the pointer).
function render({ inspect = true } = {}) {
  if (!isActive()) { teardown(); return; }
  try { renderPiles(); } catch (e) { console.warn(TAG, "piles failed", e); }
  try { renderAllyTabs(); } catch (e) { console.warn(TAG, "ally tabs failed", e); }
  if (inspect && D.insp) { try { renderInspect(); } catch (e) { console.warn(TAG, "inspect failed", e); } }
}

function teardown() {
  if (D.ui) { D.ui.ready.remove(); D.ui.spent.remove(); D.ui.fly.remove(); D.ui = null; }
  document.querySelectorAll(".rxd-atab").forEach((t) => t.remove());
  document.querySelectorAll(".dhud-card.rxd-has-tab").forEach((c) => c.classList.remove("rxd-has-tab"));
  closeInspect();
  D.inHand.clear(); D.allyHand.clear(); D.auto.clear(); D.hopping.clear(); D.counts.clear();
}

// ── inspect panel ────────────────────────────────────────────────────────────
function ensureInspEl() {
  let el = document.getElementById("rxd-insp");
  if (el) return el;
  el = document.createElement("div");
  el.id = "rxd-insp";
  el.className = "rxd-insp";
  el.setAttribute("role", "dialog");
  el.innerHTML = `<div class="box"><div class="hd"><span class="t"></span><span class="sub"></span><button type="button" class="x" aria-label="Close">✕</button></div>
    <div class="bd"><div class="grid"></div><div class="det"></div></div></div><div class="tail"></div>`;
  el.querySelector(".x").addEventListener("click", (ev) => { ev.stopPropagation(); closeInspect(); });
  el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  document.body.appendChild(el);
  return el;
}

function openInspect(who, sel) {
  const el = ensureInspEl();
  D.insp = { who, sel: sel ?? D.insp?.sel ?? null, el };
  renderInspect();
  requestAnimationFrame(() => el.classList.add("is-on"));
  D.ui?.ready.classList.toggle("is-open", who === myActorId());
  renderAllyTabs();
}
export function closeInspect() {
  if (!D.insp) return;
  const el = D.insp.el;
  D.insp = null;
  el?.classList.remove("is-on");
  D.ui?.ready.classList.remove("is-open");
  document.querySelectorAll(".rxd-atab.is-open").forEach((t) => t.classList.remove("is-open"));
}

function statusOf(e, hand) {
  const s = shownState(e, hand);
  if (s === "spent") return { cls: "sp", line: `Back: ${e.back ?? "later"}` };
  if (s === "hand") return { cls: "hand", line: "In hand now" };
  if (e.state === "cantpay") return { cls: "off", line: e.why ?? "Can't pay" };
  if (e.limit) return { cls: "lim", line: e.limit };
  return { cls: "", line: "Unlimited" };
}

function renderInspect() {
  const I = D.insp;
  if (!I) return;
  const { who, el } = I;
  const deck = D.decks.get(who) ?? [];
  const mine = who === myActorId();
  const hand = mine ? D.inHand : (D.allyHand.get(who) ?? new Set());
  const groups = { hand: [], ready: [], spent: [] };
  for (const e of deck) {
    const s = shownState(e, hand);
    if (s === "hand") groups.hand.push(e);
    else if (s === "spent") groups.spent.push(e);
    else groups.ready.push(e);
  }
  // Limited first (with their limit), then can't pay, then the unlimited ones.
  const rank = (e) => (e.state === "cantpay" ? 1 : e.limit ? 0 : 2);
  groups.ready.sort((a, b) => rank(a) - rank(b));
  const all = [...groups.hand, ...groups.ready, ...groups.spent];
  if (!all.some((e) => e.carrierUuid === I.sel)) I.sel = all[0]?.carrierUuid ?? null;
  const name = game.actors?.get(who)?.name ?? "Your";
  el.querySelector(".t").textContent = mine ? "Your reactions" : `${name}'s reactions`;
  el.querySelector(".sub").textContent = ` · ${groups.ready.length} ready${groups.hand.length ? ` · ${groups.hand.length} in hand` : ""} · ${groups.spent.length} spent`;
  const grid = el.querySelector(".grid");
  grid.innerHTML = "";
  const section = (label, list) => {
    const l = document.createElement("div");
    l.className = "gl";
    l.textContent = `${label} · ${list.length}`;
    const tb = document.createElement("div");
    tb.className = "tiles";
    for (const e of list) tb.appendChild(tileEl(e, hand));
    grid.append(l, tb);
  };
  if (groups.hand.length) section("In hand", groups.hand);
  section("Ready", groups.ready);
  section("Spent", groups.spent);
  if (!deck.length) grid.insertAdjacentHTML("beforeend", '<div class="empty">No reactions to track.</div>');
  renderDetail();
  placeInspect();
}

function tileEl(e, hand) {
  const st = statusOf(e, hand);
  const t = document.createElement("div");
  t.className = `tile ${st.cls}${D.insp?.sel === e.carrierUuid ? " sel" : ""}`;
  t.dataset.id = e.carrierUuid;
  t.innerHTML = `<div class="tf"><div class="ti">${e.icon ? `<img src="${esc(e.icon)}" alt="">` : ""}</div><div class="tt"><div class="tn">${esc(e.name)}</div><div class="ts">${esc(st.line)}</div></div></div>`;
  t.addEventListener("pointerenter", () => {
    if (!D.insp || D.insp.sel === e.carrierUuid) return;
    D.insp.sel = e.carrierUuid;
    D.insp.el.querySelectorAll(".tile.sel").forEach((x) => x.classList.remove("sel"));
    t.classList.add("sel");
    renderDetail();
  });
  return t;
}

function renderDetail() {
  const I = D.insp;
  if (!I) return;
  const d = I.el.querySelector(".det");
  d.innerHTML = "";
  const e = (D.decks.get(I.who) ?? []).find((x) => x.carrierUuid === I.sel);
  if (!e) return;
  const mine = I.who === myActorId();
  const hand = mine ? D.inHand : (D.allyHand.get(I.who) ?? new Set());
  const s = shownState(e, hand);
  const spent = s === "spent";
  const cw = document.createElement("div");
  cw.className = "cw";
  const face = entryFace(e, e.state === "cantpay" && !spent ? "is-off" : "");
  if (spent) face.classList.add("is-spentface");
  cw.appendChild(face);
  d.appendChild(cw);
  const rows = [];
  if (spent) rows.push(["Spent", e.spent ?? "Used", ""], ["Comes back", e.back ?? "Later", ""]);
  else if (s === "hand") rows.push(["Now", "In hand: this window can use it", ""]);
  else if (e.state === "cantpay") rows.push(["Can't pay", `${e.why ?? "Can't pay"}${e.have ? ` (${mine ? "you have" : "has"} ${e.have})` : ""}`, "red"]);
  else if (e.limit) { rows.push(["Limit", e.limit, ""]); if (e.back) rows.push(["Refills", e.back, ""]); }
  else rows.push(["Limit", "None: comes back after every use", ""]);
  if (e.auto) rows.push(["Firing", "On: plays itself when it fits", ""]);
  for (const [k, v, cls] of rows) {
    const w = document.createElement("div");
    w.innerHTML = `<div class="st2">${esc(k)}</div><div class="sv ${cls}">${esc(v)}</div>`;
    d.appendChild(w);
  }
}

// Above your piles (right edges lined up), or above the ally's tab. Scaled
// with the HUD, like everything it describes.
function placeInspect() {
  const I = D.insp;
  if (!I) return;
  const el = I.el, k = hudScale();
  el.style.transform = `scale(${k})`;
  const tail = el.querySelector(".tail");
  const H = el.offsetHeight * k;
  const mine = I.who === myActorId();
  let left, top;
  if (mine && D.ui) {
    const r = D.ui.ready.getBoundingClientRect();
    left = r.right + 2 * k - INSP_W * k;
    top = r.top - 18 * k - H;
    tail.style.left = ""; tail.style.right = "30px";
  } else {
    const tab = allyCards().find((c) => c.dataset.actorId === I.who)?.querySelector(".rxd-atab");
    const r = tab?.getBoundingClientRect() ?? { left: 20, top: window.innerHeight - 120, width: 40 };
    left = Math.max(12, r.left - 140 * k);
    top = r.top - 14 * k - H;
    tail.style.right = ""; tail.style.left = `${(r.left + r.width / 2 - left) / k - 8}px`;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - INSP_W * k - 8));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
}

// ── flights ──────────────────────────────────────────────────────────────────
// Deals, returns and refills travel BEHIND the plate and portrait (the fly
// layer sits with the hand, under the plate); a card being PLAYED travels over
// everything (a fixed layer on <body>).
const tf = (r) => `translate(${r.x}px, ${r.y}px) scale(${r.w / CARD_W})`;
function topLayer() {
  let l = document.getElementById("rxd-fly-top");
  if (!l) { l = document.createElement("div"); l.id = "rxd-fly-top"; document.body.appendChild(l); }
  return l;
}
function unitK(unit) {
  const r = unit.getBoundingClientRect();
  return unit.offsetWidth ? r.width / unit.offsetWidth : hudScale();
}
// Viewport rect → the fly layer's px (the unit's padding box, unscaled).
function toLocal(vr) {
  const ui = D.ui;
  const o = ui.fly.getBoundingClientRect(), k = unitK(ui.unit);
  return { x: (vr.left - o.left) / k, y: (vr.top - o.top) / k, w: vr.width / k, h: vr.height / k };
}
function toViewport(lr) {
  const ui = D.ui;
  const o = ui.fly.getBoundingClientRect(), k = unitK(ui.unit);
  return { x: o.left + lr.x * k, y: o.top + lr.y * k, w: lr.w * k, h: lr.h * k };
}
const vpRect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
const pileLocal = (kind) => ({ x: kind === "spent" ? SPENT_LEFT : READY_LEFT, y: PILE_TOP, w: PILE_W, h: PILE_H });

function cleanFace(el) {
  const f = el.cloneNode(true);
  f.classList.remove("is-held", "is-incoming", "is-away", "is-leaving", "is-hidden", "is-dealt");
  f.removeAttribute("style");
  return f;
}
function makeFlyer(face) {
  const f = document.createElement("div");
  f.className = "rxd-flyer";
  const flip = document.createElement("div");
  flip.className = "rxd-flip";
  const front = document.createElement("div");
  front.className = "rxd-side front";
  front.appendChild(face);
  const back = document.createElement("div");
  back.className = "rxd-side back";
  back.appendChild(backEl());
  flip.append(front, back);
  f.appendChild(flip);
  return { f, flip };
}
/**
 * One card's flight. `from`/`to` are rects in the layer's px. flip: "in"
 * (back → face), "out" (face → back) or null. Reduced motion: a fade in place
 * (at `to` when arriving, at `from` when leaving).
 */
async function fly(layer, face, from, to, { dur, flip = null, arc = 0, easing = "cubic-bezier(.2,.9,.3,1)", fadeEnd = false, rm = "to", cls = "" } = {}) {
  if (!layer?.isConnected) return;
  const { f, flip: fl } = makeFlyer(face);
  if (cls) f.classList.add(cls);
  layer.appendChild(f);
  try {
    if (reducedMotion()) {
      const at = rm === "from" ? from : to;
      f.style.transform = tf(at);
      fl.style.transform = rm === "from" || flip !== "out" ? "none" : "rotateY(180deg)";
      const frames = rm === "from" ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }];
      await f.animate(frames, { duration: FADE_MS, easing: "ease", fill: "both" }).finished.catch(() => {});
      return;
    }
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - arc, w: (from.w + to.w) / 2 };
    f.style.transform = tf(to);
    if (flip === "in") fl.animate([{ transform: "rotateY(180deg)" }, { transform: "rotateY(0deg)" }], { duration: dur * 0.55, easing: "ease-out", fill: "both" });
    if (flip === "out") fl.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(180deg)" }], { duration: dur * 0.5, delay: dur * 0.4, easing: "ease-in", fill: "both" });
    await f.animate([
      { transform: tf(from), opacity: 1 },
      { transform: tf(mid), opacity: 1, offset: 0.5 },
      { transform: tf(to), opacity: fadeEnd ? 0 : 1 },
    ], { duration: dur, easing, fill: "both" }).finished.catch(() => {});
  } finally {
    f.remove();
  }
}

/** Deal `el` (a hand card / the Pass card, laid out and hidden) out of the deck. */
export async function deckDeal(el, delayMs = 0) {
  if (delayMs) await wait(delayMs);
  const ui = D.ui;
  if (!ui || !el?.isConnected || el.classList.contains("is-away")) return;
  keepFlyAboveHand();
  const to = toLocal(el.getBoundingClientRect());
  glowPile(ui.ready);
  await fly(ui.fly, cleanFace(el), pileLocal("ready"), to, { dur: DEAL_MS, flip: "in", arc: 70 });
}

/** Send `el` back into the deck (from where it stands now). */
export async function deckReturn(el) {
  const ui = D.ui;
  if (!ui || !el?.isConnected) return;
  keepFlyAboveHand();
  const from = toLocal(el.getBoundingClientRect());
  await fly(ui.fly, cleanFace(el), from, pileLocal("ready"), { dur: BACK_MS, flip: "out", arc: 40, easing: "cubic-bezier(.5,0,.7,.4)", rm: "from" });
  glowPile(ui.ready);
}

/**
 * Play `el` over everything: into the action card when one is up, else into
 * your plate. Lands (glow) on SPENT when limited, back on the deck otherwise.
 */
export async function deckPlay(el, { carrierUuid = null } = {}) {
  if (!el?.isConnected) return;
  const from = vpRect(el);
  const face = cleanFace(el);
  const e = carrierUuid ? (D.decks.get(myActorId()) ?? []).find((x) => x.carrierUuid === carrierUuid) : null;
  if (e?.limited) { D.pending.set(carrierUuid, { until: null }); render(); }
  el.style.visibility = "hidden";
  await fly(topLayer(), face, from, playTarget(), { dur: PLAY_MS, arc: 60, easing: "cubic-bezier(.4,0,.6,1)", fadeEnd: true, rm: "from" });
  const card = document.querySelector(`#${MIRROR_ROOT_ID} .fud-bf-card`);
  if (card) glowActionCard(document.getElementById(MIRROR_ROOT_ID));
  if (D.ui) glowPile(e?.limited ? D.ui.spent : D.ui.ready);
}
function playTarget() {
  const card = document.querySelector(`#${MIRROR_ROOT_ID} .fud-bf-card`);
  const r = card?.getBoundingClientRect();
  if (r && r.width > 0) return { x: r.left + r.width / 2 - 41, y: r.top + r.height / 2 - 70, w: 82, h: 118 };
  // No action card (a standalone window, an auto passive): into your plate.
  const u = myUnit()?.getBoundingClientRect();
  if (u) return { x: u.left + 120, y: u.top - 10, w: 60, h: 86 };
  return { x: window.innerWidth / 2 - 41, y: window.innerHeight / 2 - 70, w: 82, h: 118 };
}

/** The hand tells the deck which of your carriers are in it right now. */
export function deckSetHand(carriers) {
  const next = new Set(carriers ?? []);
  const grew = [...next].some((c) => !D.inHand.has(c));
  const same = next.size === D.inHand.size && !grew;
  if (same) return;
  D.inHand = next;
  // A window drew cards: an open inspect panel would cover the action card.
  if (grew) closeInspect();
  render();
}
export function deckSetAllyHand(actorId, carriers) {
  const next = new Set(carriers ?? []);
  const prev = D.allyHand.get(actorId) ?? new Set();
  if (next.size === prev.size && [...next].every((c) => prev.has(c))) return;
  if ([...next].some((c) => !prev.has(c))) closeInspect();
  if (next.size) D.allyHand.set(actorId, next); else D.allyHand.delete(actorId);
  render();
}

// ── refill: SPENT → deck hop with a gold glow ────────────────────────────────
async function hopRefill(e) {
  const ui = D.ui;
  if (!ui) return;
  D.hopping.add(e.carrierUuid);
  render();
  try {
    glowPile(ui.spent);
    await fly(ui.fly, entryFace(e), pileLocal("spent"), pileLocal("ready"), { dur: REFILL_MS, flip: "out", arc: 90, easing: "cubic-bezier(.3,.7,.3,1)", cls: "is-refill" });
  } finally {
    D.hopping.delete(e.carrierUuid);
    render();
    if (D.ui) glowPile(D.ui.ready);
  }
}

// ── `on` reactions: drawn, held to read, then they play themselves ──────────
async function autoPlay(spec, { slow = 1 } = {}) {
  if (!isActive() || !spec?.tokenUuid) return;
  let actorId = null;
  try { actorId = fromUuidSync(spec.tokenUuid)?.actor?.id ?? null; } catch { /* */ }
  if (!actorId) return;
  // Only an `on` row plays its card. A `force` row on the same carrier (Protect's
  // turn-start refill) is bookkeeping: a refill shows as the SPENT → deck hop,
  // which recompute() starts on its own. A host that doesn't send the mode yet
  // still can't match a card that has no `on` row.
  if (spec.mode != null && String(spec.mode) !== "on") return;
  const title = String(spec.title ?? "").trim();
  const deck = D.decks.get(actorId) ?? [];
  const e = deck.find((x) => x.name === title && (x.auto || spec.mode === "on"));
  if (!e) return;
  if (actorId !== myActorId()) {
    // An ally's: their tab shows it fired.
    const tab = deckAllyTab(actorId);
    if (tab && !reducedMotion()) { tab.classList.remove("rxd-fired"); void tab.offsetWidth; tab.classList.add("rxd-fired"); }
    return;
  }
  const ui = D.ui;
  if (!ui || D.auto.has(e.carrierUuid) || D.inHand.has(e.carrierUuid)) return;
  D.auto.add(e.carrierUuid);
  render();
  try {
    const { CLIP_TOP, CARD_TOP, HAND_LEFT } = HAND_GEOM;
    const read = { x: HAND_LEFT, y: -CLIP_TOP + CARD_TOP, w: CARD_W, h: CARD_H };
    const face = entryFace(e, "is-live");
    if (reducedMotion()) {
      const { f } = makeFlyer(face);
      f.style.transform = tf(toViewport(read));
      topLayer().appendChild(f);
      await f.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
        { duration: AUTO_OUT_MS + AUTO_READ_MS + AUTO_IN_MS, fill: "both" }).finished.catch(() => {});
      f.remove();
      return;
    }
    // 1) out of the deck, behind the portrait and plate, into the first hand slot
    await fly(ui.fly, face, pileLocal("ready"), read, { dur: AUTO_OUT_MS * slow, flip: "in", easing: "cubic-bezier(.15,.85,.3,1)" });
    // 2) above everything: hold to read, then into its target
    const at = toViewport(read), lift = { ...at, y: at.y - 16 * unitK(ui.unit) };
    const { f } = makeFlyer(entryFace(e, "is-live"));
    f.classList.add("is-read");
    topLayer().appendChild(f);
    f.style.transform = tf(at);
    const total = (AUTO_READ_MS + AUTO_IN_MS) * slow;
    await f.animate([
      { transform: tf(at), opacity: 1 },
      { transform: tf(lift), opacity: 1, offset: AUTO_READ_MS / (AUTO_READ_MS + AUTO_IN_MS), easing: "cubic-bezier(.55,0,.8,.3)" },
      { transform: tf(playTarget()), opacity: 0.15 },
    ], { duration: total, easing: "linear", fill: "both" }).finished.catch(() => {});
    f.remove();
    if (document.querySelector(`#${MIRROR_ROOT_ID} .fud-bf-card`)) glowActionCard(document.getElementById(MIRROR_ROOT_ID));
  } finally {
    D.auto.delete(e.carrierUuid);
    render();
  }
}

// ── Max Fires: the host publishes its counter ────────────────────────────────
let _socket = null;
function ensureSocket() {
  if (_socket) return _socket;
  if (!game.modules?.get("socketlib")?.active || !window.socketlib) return null;
  try {
    _socket = window.socketlib.registerModule(NS);
    _socket.register(ACTION_FIRES, (snap) => {
      if (game.user?.isGM) return;
      D.fires = snap ?? null;
      scheduleRecompute();
    });
    _socket.register(ACTION_HELLO, () => { if (game.user?.isGM) publishFires(true); });
  } catch (e) { console.warn(TAG, "socket registration failed", e); _socket = null; }
  return _socket;
}
function hostDirector() {
  try { return globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.() ?? null; } catch { return null; }
}
function firesSnapshot() {
  const d = hostDirector();
  if (!d) return { live: false, round: 0, counts: {} };
  const round = d?.dCombat?.round ?? 0;
  const counts = {};
  const m = d._reactionRoundCounts;
  if (m instanceof Map) {
    for (const [k, n] of m) {
      const bucket = k.slice(k.lastIndexOf("::") + 2);
      if (bucket === "all" || bucket === String(round)) counts[k] = n;
    }
  }
  return { live: true, round, counts };
}
let _lastSig = "";
function publishFires(force = false) {
  if (!game.user?.isGM) return;
  const snap = firesSnapshot();
  // A GM with no director answers nothing (another GM may be the host).
  if (!snap.live && (force || !_lastSig)) return;
  const sig = JSON.stringify(snap);
  if (!force && sig === _lastSig) return;
  _lastSig = snap.live ? sig : "";
  try { ensureSocket()?.executeForOthers(ACTION_FIRES, snap); } catch (e) { console.warn(TAG, "publish failed", e); }
}
let _helloAt = 0;
function hello() {
  if (Date.now() - _helloAt < HELLO_MS) return;
  _helloAt = Date.now();
  try { ensureSocket()?.executeForOthers(ACTION_HELLO, { userId: game.user?.id }); } catch { /* */ }
}

// ── boot ─────────────────────────────────────────────────────────────────────
function actorIdOf(doc) {
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc.id;
  const p = doc.parent;
  if (p?.documentName === "Actor") return p.id;
  if (p?.parent?.documentName === "Actor") return p.parent.id;
  return null;
}
function onDocChange(doc) {
  const id = actorIdOf(doc);
  if (id && D.decks.size && shownActorIds().has(id)) scheduleRecompute(id);
}

function onKey(ev) {
  if (ev.key !== "Escape" || !D.insp) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  closeInspect();
}
function onPointerDown(ev) {
  if (!D.insp) return;
  const t = ev.target;
  if (t?.closest?.("#rxd-insp, .rxd-pile, .rxd-atab")) return;
  closeInspect();
}

function tick() {
  if (!isActive()) { if (D.ui || D.insp) teardown(); return; }
  ensureUi();
  // A played limited card reads SPENT until the host confirms it. The charge is
  // spent in RESOLVE, and the host can sit in CONFIRM for seconds after the
  // player's card closed (~6 s live), then animate before it writes (~12 s from
  // close to write for Protect). So the short wait only starts once the battle
  // has moved since the close and settled again; if it never moves (a cancelled
  // action) the card gives up after PENDING_MAX_WAIT_MS.
  const cardUp = !!document.getElementById(MIRROR_ROOT_ID);
  const settled = battleIsSettled();
  const now = Date.now();
  for (const [c, p] of D.pending) {
    if (cardUp) { p.closedAt = null; p.moved = false; p.until = null; continue; }
    p.closedAt ??= now;
    if (!settled) { p.moved = true; p.until = null; continue; }
    if (p.until == null) p.until = p.moved ? now + PENDING_AFTER_CLOSE_MS : p.closedAt + PENDING_MAX_WAIT_MS;
    if (now > p.until) { D.pending.delete(c); scheduleRecompute(myActorId()); }
  }
  for (const id of shownActorIds()) if (!D.decks.has(id)) scheduleRecompute(id);
  render({ inspect: false });
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS_TEXT;
  document.head.appendChild(st);
}

Hooks.once("ready", () => {
  ensureSocket();
  if (game.user?.isGM) {
    Hooks.on("fuReactionFireCounted", () => setTimeout(() => publishFires(), 50));
    setInterval(() => publishFires(), 2000);
    return;
  }
  injectStyles();
  for (const h of ["updateActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(h, onDocChange);
  }
  Hooks.on("fuClientOptionChanged", ({ key } = {}) => { if (key === "reactionUi") tick(); });
  Hooks.on("fuPassiveCardShown", (spec) => { autoPlay(spec).catch((e) => console.warn(TAG, "auto-play failed", e)); });
  Hooks.on("updateCombat", () => scheduleRecompute());
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("resize", () => { if (D.insp) placeInspect(); });
  setInterval(tick, 1000);
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.reactionDeck = Object.freeze({
    state: () => ({
      active: isActive(), me: myActorId(),
      decks: Object.fromEntries([...D.decks].map(([id, d]) => [id, d.map((e) => ({ name: e.name, state: e.state, limit: e.limit, back: e.back, spent: e.spent, why: e.why, auto: e.auto }))])),
      tally: Object.fromEntries([...shownActorIds()].map((id) => [id, tally(id)])),
      inHand: [...D.inHand], pending: [...D.pending.keys()], fires: D.fires, inspect: D.insp?.who ?? null,
    }),
    recompute: () => { scheduleRecompute(); },
    // Test hooks: play an `on` card as if its passive badge fired; set a fire snapshot.
    autoPlay: (spec, opts) => autoPlay(spec, opts),
    setFires: (snap) => { D.fires = snap; scheduleRecompute(); },
    open: (actorId) => openInspect(actorId ?? myActorId(), null),
    close: () => closeInspect(),
  });
});

const CSS_TEXT = `
/* ── the deck + SPENT piles, left of the portrait (inside the plate, so they
   scale with it). Behind everything else on the plate: flights pass over them. */
.rxd-back { position: absolute; inset: 0; border-radius: 12px; border: 2px solid #b7935a; overflow: hidden; box-sizing: border-box;
  background: repeating-linear-gradient(45deg, rgba(226,194,126,.07) 0 2px, transparent 2px 10px), radial-gradient(circle at 50% 44%, #574a3b, #2e271f 72%);
  box-shadow: 0 10px 24px rgba(0,0,0,.5); }
.rxd-back::before { content: ""; position: absolute; inset: 7px; border: 1.5px solid rgba(226,194,126,.6); border-radius: 8px; }
.rxd-back::after { content: ""; position: absolute; inset: 13px; border: 1px solid rgba(226,194,126,.25); border-radius: 6px; }
.rxd-back svg { position: absolute; left: 50%; top: 50%; width: 86px; height: 86px; transform: translate(-50%, -50%); }

.rxd-pile { position: absolute; top: ${PILE_TOP}px; width: ${PILE_W}px; height: ${PILE_H}px; z-index: -2; cursor: pointer; pointer-events: auto;
  font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif; }
.rxd-pile.is-ready { left: ${READY_LEFT}px; }
.rxd-pile.is-spent { left: ${SPENT_LEFT}px; }
.rxd-pile .lyr { position: absolute; width: ${CARD_W}px; height: ${CARD_H}px; transform-origin: 0 0; transform: scale(${PILE_W / CARD_W}); }
.rxd-pile .lyr.l1 { left: 0; top: 0; } .rxd-pile .lyr.l2 { left: 3px; top: 3px; } .rxd-pile .lyr.l3 { left: 6px; top: 6px; }
.rxd-pile.n1 .l2, .rxd-pile.n1 .l3, .rxd-pile.n2 .l3, .rxd-pile.n0 .l2, .rxd-pile.n0 .l3 { display: none; }
.rxd-pile .face { position: absolute; left: 0; top: 0; width: ${CARD_W}px; height: ${CARD_H}px; transform-origin: 0 0; transform: scale(${PILE_W / CARD_W}); }
.rxd-pile .face .rxh-card { position: relative; top: 0; left: 0; pointer-events: none; }
.rxd-pile.is-spent .face { filter: grayscale(.75) brightness(.8); }
.rxd-pile .slot { position: absolute; inset: 0; border: 1.5px dashed rgba(226,194,126,.55); border-radius: 7px; background: rgba(46,39,31,.35); display: none; }
.rxd-pile.n0 .slot { display: block; } .rxd-pile.n0 .lyr, .rxd-pile.n0 .face { display: none; }
.rxd-pile .cnt { position: absolute; right: -9px; top: -9px; min-width: 28px; height: 28px; padding: 0 6px; box-sizing: border-box; border-radius: 14px; display: grid; place-items: center;
  background: #3a3228; border: 2px solid #b7935a; color: #f6f1e6; font: 800 15px "Inter", "Signika", sans-serif; box-shadow: 0 2px 6px rgba(0,0,0,.45); z-index: 3; }
.rxd-pile.is-ready .cnt { background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14); border-color: #e2c27e; }
.rxd-pile .plq { position: absolute; left: 50%; bottom: -16px; transform: translateX(-50%); padding: 2px 8px; border-radius: 5px; background: #3a3228; border: 1.5px solid #b7935a;
  color: #f6f1e6; font: 800 9.5px "Inter", "Signika", sans-serif; letter-spacing: .14em; white-space: nowrap; z-index: 3; }
.rxd-pile .stk { position: absolute; inset: 0; transition: transform 180ms cubic-bezier(.2,.8,.2,1), filter 180ms; }
.rxd-pile:hover .stk { transform: translateY(-5px); filter: drop-shadow(0 0 8px rgba(226,194,126,.7)); }
.rxd-pile.is-open .stk { transform: translateY(-5px); filter: drop-shadow(0 0 10px rgba(226,194,126,.9)); }
@keyframes rxdThump { 0% { transform: scale(1); } 35% { transform: scale(1.28); } 100% { transform: scale(1); } }
.rxd-thump { animation: rxdThump 320ms cubic-bezier(.3,1.6,.5,1); }
@keyframes rxdPileGlow { 0% { filter: drop-shadow(0 0 0 rgba(226,194,126,0)); } 30% { filter: drop-shadow(0 0 14px rgba(226,194,126,1)); } 100% { filter: drop-shadow(0 0 0 rgba(226,194,126,0)); } }
.rxd-pile .stk.rxd-glow { animation: rxdPileGlow 700ms ease-out; }

/* flights */
.rxd-fly { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: -1; pointer-events: none; overflow: visible; }
#rxd-fly-top { position: fixed; inset: 0; pointer-events: none; z-index: 120; }
.rxd-flyer { position: absolute; left: 0; top: 0; width: ${CARD_W}px; height: ${CARD_H}px; transform-origin: 0 0; perspective: 900px; will-change: transform, opacity; pointer-events: none; }
.rxd-flip { position: absolute; inset: 0; transform-style: preserve-3d; }
.rxd-side { position: absolute; inset: 0; backface-visibility: hidden; -webkit-backface-visibility: hidden; }
.rxd-side.back { transform: rotateY(180deg); }
.rxd-side .rxh-card, .rxd-side .rxh-pass { position: relative !important; top: 0 !important; left: 0 !important; transform: none !important; translate: none !important; animation: none !important; visibility: visible !important; opacity: 1 !important; }
.rxd-flyer.is-read .rxh-card { box-shadow: 0 0 0 2px #e2c27e, 0 0 26px 6px rgba(226,194,126,.7), 0 14px 30px rgba(0,0,0,.55); }
.rxd-flyer.is-refill .rxd-side { filter: drop-shadow(0 0 12px rgba(226,194,126,.95)); }

/* the hand: a card on its way in (the flight shows it) / back in the deck */
.rxh-card.is-incoming, .rxh-pass.is-incoming { visibility: hidden; transition: none; }
.rxh-card.is-away { display: none; }

/* ── ally tab: a segment of their status tab — deck count, spent in grey ── */
.dhud-card.rxd-has-tab .dhud-ctab { display: flex; }
.rxd-atab { position: relative; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 4px 0 6px; margin-left: 2px; box-sizing: border-box;
  border-left: 1px solid rgba(122,106,85,.5); border-radius: 0 5px 5px 0; font: 800 11px "Inter", "Signika", sans-serif; color: #3a3228;
  cursor: pointer; pointer-events: auto; transition: box-shadow 140ms, background 140ms; }
.dhud-card:not(.has-statuses) .rxd-atab { border-left: 0; margin-left: 0; padding-left: 2px; border-radius: 5px; }
.rxd-atab:hover, .rxd-atab.is-open { box-shadow: 0 0 0 2px #e2c27e; background: rgba(226,194,126,.2); border-radius: 5px; }
.rxd-atab i { width: 10px; height: 14px; border-radius: 2px; background: #3a3228; border: 1.2px solid #b7935a; display: block; position: relative; flex: none; box-sizing: border-box; }
.rxd-atab i::after { content: ""; position: absolute; left: 2px; top: 3px; width: 3px; height: 3px; transform: rotate(45deg); background: #c4473a; }
.rxd-atab .n { display: inline-block; }
.rxd-atab .sp { display: none; align-items: center; gap: 3px; margin-left: 3px; padding-left: 5px; border-left: 1px solid #cdbf9f; color: #8a7d68; }
.rxd-atab .sp.on { display: inline-flex; }
.rxd-atab .sp i { background: #8a7d68; border-color: #a99d86; }
.rxd-atab .sp i::after { background: #d9d1c0; }
@keyframes rxdFired { 0% { box-shadow: 0 0 0 0 rgba(226,194,126,0); } 30% { box-shadow: 0 0 0 3px rgba(226,194,126,1), 0 0 14px 4px rgba(226,194,126,.8); } 100% { box-shadow: 0 0 0 0 rgba(226,194,126,0); } }
.rxd-atab.rxd-fired { animation: rxdFired 700ms ease-out; }
/* their small cards come up out of the tab, and drop back into it */
.rxd-atab .rxh-minis { left: 50%; top: auto; bottom: calc(100% + 5px); width: 80px; height: 52px; margin-left: -40px; overflow: hidden; z-index: 1; }
.rxd-atab .rxh-mini { top: 6px; }
@keyframes rxdMiniUp { from { transform: translateY(52px) rotate(var(--r, 0deg)); } 70% { transform: translateY(-4px) rotate(var(--r, 0deg)); } to { transform: rotate(var(--r, 0deg)); } }
@keyframes rxdMiniDown { to { transform: translateY(52px) rotate(var(--r, 0deg)); } }
.rxd-atab .rxh-mini.is-dealt { animation: rxdMiniUp 340ms cubic-bezier(.2,.9,.3,1) var(--d, 0ms) backwards; }
.rxd-atab .rxh-mini.is-leaving { animation: rxdMiniDown 260ms ease-in forwards; }

/* ── inspect panel ── */
.rxd-insp { position: fixed; left: 0; top: 0; width: ${INSP_W}px; z-index: 110; opacity: 0; pointer-events: none; transform-origin: 0 0;
  translate: 0 14px; transition: opacity 160ms ease, translate 220ms cubic-bezier(.2,.8,.2,1);
  font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif; }
.rxd-insp.is-on { opacity: 1; translate: 0 0; pointer-events: auto; }
.rxd-insp .box { background: linear-gradient(180deg, #fbf6ea, #efe5cf); border: 2px solid #b7935a; border-radius: 12px; box-shadow: 0 18px 44px rgba(0,0,0,.6); overflow: hidden; color: #3a3228; }
.rxd-insp .hd { height: 36px; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 12px; background: #3a3228; color: #f6f1e6; border-bottom: 2px solid #b7935a; font: 800 13px "Inter", "Signika", sans-serif; }
.rxd-insp .hd .sub { color: #cdbf9f; font-weight: 600; font-size: 12px; }
.rxd-insp .hd .x { all: unset; margin-left: auto; cursor: pointer; color: #cdbf9f; font-size: 16px; padding: 0 6px; line-height: 1; }
.rxd-insp .hd .x:hover { color: #fff3e6; }
.rxd-insp .bd { display: flex; gap: 16px; padding: 12px 14px 14px; }
.rxd-insp .grid { flex: 1; min-width: 0; max-height: 460px; overflow-y: auto; }
.rxd-insp .gl { font: 800 9.5px "Inter", "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #8a7d68; margin: 2px 0 6px; display: flex; gap: 8px; align-items: center; }
.rxd-insp .gl::after { content: ""; flex: 1; height: 1px; background: rgba(183,147,90,.45); }
.rxd-insp .empty { font: 600 12px "Inter", sans-serif; color: #8a7d68; padding: 8px 0; }
.rxd-insp .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-bottom: 12px; }
.rxd-insp .tile { position: relative; height: 54px; box-sizing: border-box; border-radius: 8px; border: 2px solid #b7935a; background: #3a3228; padding: 2px; cursor: default; transition: transform 140ms, box-shadow 140ms; }
.rxd-insp .tile .tf { height: 100%; box-sizing: border-box; border-radius: 5px; background: linear-gradient(180deg, #fbf6ea, #efe5cf); display: flex; align-items: center; gap: 7px; padding: 0 7px 0 5px; overflow: hidden; }
.rxd-insp .tile .ti { width: 36px; height: 36px; flex: none; border-radius: 7px; overflow: hidden; background: #2e271f; box-shadow: 0 0 0 2px #b7935a; }
.rxd-insp .tile .ti img { width: 100%; height: 100%; object-fit: cover; display: block; border: none; }
.rxd-insp .tile .tt { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rxd-insp .tile .tn { font: 700 12px/14px "Inter", "Signika", sans-serif; color: #3a3228; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rxd-insp .tile .ts { font: 800 8.5px "Inter", "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #8a7d68; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rxd-insp .tile.lim .ts { color: #8e2219; }
.rxd-insp .tile.off .ts { color: #b3261e; }
.rxd-insp .tile.off .ti, .rxd-insp .tile.off .tn { filter: grayscale(.6); opacity: .75; }
.rxd-insp .tile.hand { border-color: #e2c27e; }
.rxd-insp .tile.hand .tf { background: linear-gradient(180deg, #fff7e8, #f3e2c4); }
.rxd-insp .tile.hand .ts { color: #8e2219; }
.rxd-insp .tile.sp { border-color: #8a7d68; }
.rxd-insp .tile.sp .tf { background: linear-gradient(180deg, #e7dfcd, #d8cdb5); }
.rxd-insp .tile.sp .ti, .rxd-insp .tile.sp .tn { filter: grayscale(.8); opacity: .7; }
.rxd-insp .tile.sp .ts { color: #5d5243; }
.rxd-insp .tile:hover, .rxd-insp .tile.sel { transform: translateY(-2px); box-shadow: 0 0 0 2px #e2c27e, 0 6px 14px rgba(0,0,0,.3); }
.rxd-insp .det { width: 200px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.rxd-insp .det .cw { position: relative; width: ${CARD_W}px; height: ${CARD_H}px; margin: 0 auto; }
.rxd-insp .det .cw .rxh-card { position: relative; top: 0; left: 0; pointer-events: none; }
.rxd-insp .det .cw .rxh-card.is-spentface { filter: grayscale(.75) brightness(.85); }
.rxd-insp .det .st2 { font: 800 9.5px "Inter", "Signika", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #8a7d68; }
.rxd-insp .det .sv { font: 600 12px/15px "Inter", "Signika", sans-serif; color: #3a3228; margin-top: 1px; }
.rxd-insp .det .sv.red { color: #b3261e; }
.rxd-insp .tail { position: absolute; bottom: -9px; width: 16px; height: 16px; background: #efe5cf; border-right: 2px solid #b7935a; border-bottom: 2px solid #b7935a; transform: rotate(45deg); }

/* Reduced motion: flights are fades (in code); nothing else moves either. */
@media (prefers-reduced-motion: reduce) {
  .rxd-pile .stk, .rxd-insp, .rxd-atab { transition: none; }
  .rxd-pile:hover .stk, .rxd-pile.is-open .stk { transform: none; }
  .rxd-insp { translate: none; }
  .rxd-atab .rxh-mini.is-dealt { animation: rxhFade 220ms ease var(--d, 0ms) backwards; }
  .rxd-atab .rxh-mini.is-leaving { animation: rxhOut 240ms ease forwards; }
}
`;
