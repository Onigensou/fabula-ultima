// Ally watch — the other players see an ally's turn menu, live and read-only.
//
// The acting player's client already mirrors its plate drawer to the GMs
// (director-player-hud.js watchPlateForMirror → gm-desk.js Watch). Here the
// same drawer becomes a small structured snapshot (step, cursor, rows, picks,
// the skill card) sent to the OTHER players. Their screens draw:
//   • a "Watching" panel rising out of the acting ally's compact card,
//   • floor rings on the field under the creatures being picked,
//   • a tab on their own plate when they are one of the picks,
//   • the hovered row's cost on the acting ally's MP bar,
//   • a one-line recap above the card once the action is confirmed.
//
// Nothing in it can be used, so it never acts like a control: the panel lets
// the pointer through (only Fold takes clicks) and fades while the pointer is
// over it; it folds itself while this player has a decision of their own; and
// a skill shows only once the acting player's cursor rests on it (SETTLE_MS),
// so fast scrolling moves the highlight without the card flickering.
//
// Approved mockup: claude.ai/artifact/FCCr8xz64J1VovgrTPBDkc (v5, Panel style).
// Per-user switch: Party Menu › Config › Graphic › Ally's turn (client option
// "allyWatch"); a GM never gets it (the Battle Desk has its own Watch).

import { log, warn } from "./logger.js";
import { hudTurnStatus, hudScale, readUnitInfo } from "./director-player-hud.js";
import { getClientOption } from "../shared/client-options.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_SNAP = "FU_ALLY_WATCH";
const STYLE_ID = "faw-style";
const PANEL_ID = "faw-panel";
const RINGS_ID = "faw-rings";

const SETTLE_MS = 300;       // the cursor must rest this long before the card changes
const LIST_WINDOW = 7;       // list rows shown around the cursor
const TARGET_WINDOW = 6;     // target rows shown
const TRAIL_MAX = 5;         // "Looked at" chips
const RECAP_MS = 8000;       // the recap pill after a confirm
const TICK_MS = 400;         // re-anchor, rings, auto-fold while something shows
const PANEL_W = 540;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const text = (el) => String(el?.textContent ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

let _socket = null;

// ══ Sender (the acting player's client) ═══════════════════════════════════════
let _sent = { open: false, sig: "" };

/**
 * Called by director-player-hud.js whenever this player's plate drawer changes.
 * Sends a snapshot to the other players while this plate's actor is the party
 * creature taking its turn; a closed (or no longer acting) drawer sends one
 * "closed" message so the watchers let go.
 */
export function publishAllyWatch({ actorId, plateEl, drawer, open, crumb, cost } = {}) {
  try {
    if (game.user?.isGM || !actorId || !plateEl || !drawer) return;
    const st = hudTurnStatus();
    const acting = st?.phase === "acting" && st.side === "party" && String(st.actorId) === String(actorId);
    const snap = acting && open ? snapshotDrawer(plateEl, drawer, crumb) : null;
    if (!snap && !_sent.open) return;
    const payload = snap
      ? { ...snap, actorId: String(actorId), userId: game.user.id, open: true, cost: cost && (cost.mp || cost.hp || cost.ip) ? { mp: Number(cost.mp) || 0, hp: Number(cost.hp) || 0, ip: Number(cost.ip) || 0 } : null }
      : { actorId: String(actorId), userId: game.user.id, open: false };
    const sig = JSON.stringify(payload);
    if (sig === _sent.sig) return;
    _sent = { open: !!snap, sig };
    const to = (game.users?.contents ?? []).filter((u) => u.active && !u.isGM && u.id !== game.user.id).map((u) => u.id);
    if (!to.length) return;
    ensureSocket()?.executeForUsers(ACTION_SNAP, to, { ...payload, at: Date.now() });
  } catch (e) { warn("[AllyWatch] publish failed", e); }
}

// The drawer's newest view (closing views stay a moment, inert) → plain data.
function snapshotDrawer(plateEl, drawer, crumb) {
  const out = { crumb: clip(crumb, 60), step: "other", cmds: null, list: null, targets: null, card: readCard(plateEl) };
  if (plateEl.classList.contains("is-react")) return { ...out, step: "react", card: null };
  const root = [...drawer.children].reverse().find((c) => !c.inert) ?? null;
  if (!root) return out;

  const oct = root.matches(".fud-octopath") ? root : root.querySelector(".fud-octopath");
  if (oct) {
    out.step = "cmd";
    out.cmds = [...oct.querySelectorAll(".blade")].slice(0, 16).map((b) => ({
      label: text(b.querySelector(".label")),
      cur: b.classList.contains("is-cursor"),
      dis: b.matches(".fud-disabled, .is-unavailable, .is-blocked"),
    })).filter((c) => c.label);
    return out;
  }

  const tcols = root.querySelector(".dhv-tcols");
  if (tcols) {
    out.step = "tgt";
    out.targets = [...tcols.querySelectorAll(".dhv-tcol")].map((col) => ({
      label: text(col.querySelector(".dhv-sec")),
      rows: [...col.querySelectorAll(".dhv-trow")].slice(0, 24).map((r) => ({
        uuid: r.dataset.uuid ?? "",
        // .nm = name + " (you)" (the ACTING player's own creature) + status chip
        name: String(r.querySelector(".nm")?.firstChild?.textContent ?? "").replace(/\s*\(you\)\s*$/, "").trim(),
        img: r.querySelector("img.dhv-face")?.getAttribute("src") ?? "",
        hp: text(r.querySelector(".dhv-thp > span")),
        sel: r.classList.contains("is-sel"),
        cur: r.classList.contains("is-cur"),
        excl: r.classList.contains("is-excl"),
      })),
    }));
    return out;
  }

  const list = root.querySelector("[data-dhv-list], .dhv-tiles");
  if (list) {
    out.step = "list";
    const rows = [];
    for (const el of list.children) {
      if (el.classList.contains("dhv-sec")) rows.push({ sec: String(el.firstChild?.textContent ?? "").trim() });
      else if (el.matches(".dhv-row, .dhv-tile")) {
        rows.push({
          name: text(el.querySelector(".nm, .t")),
          icon: el.querySelector(".dhv-ic img")?.getAttribute("src") ?? "",
          chip: clip(text(el.querySelector(".dhv-chip")), 18),
          cur: el.classList.contains("is-cur"),
          dis: el.classList.contains("is-dis"),
        });
      }
      if (rows.length >= 80) break;
    }
    out.list = rows;
  }
  return out;
}

// The flipped portrait card (drawer-views.js setPlateCard) → plain data.
function readCard(plateEl) {
  const pcard = plateEl.querySelector(".dhud-pcard");
  if (!pcard?.classList.contains("is-skill")) return null;
  const face = pcard.querySelector(".dhv-sface");
  if (!face) return null;
  const name = text(face.querySelector(".dhv-sname"));
  if (!name) return null;
  return {
    name,
    kind: clip(text(pcard.querySelector(".dhud-pname")), 40),
    from: text(face.querySelector(".dhv-sfrom")),
    icon: face.querySelector(".dhv-shead .dhv-ic img")?.getAttribute("src") ?? "",
    chips: [...face.querySelectorAll(".dhv-schips .dhv-chip")].slice(0, 8)
      .map((c) => ({ text: clip(text(c), 28), tone: (/\bt-([\w-]+)/.exec(c.className) ?? [])[1] ?? "" })),
    why: clip(text(face.querySelector(".dhv-swhy")), 120),
    body: clip([...face.querySelectorAll(".dhv-sbody p")].map(text).filter(Boolean).join("\n"), 600),
  };
}

// ══ Receiver (every other player) ═════════════════════════════════════════════
const W = {
  snap: null,          // latest open snapshot
  actorId: null,       // whose turn the watch belongs to
  shown: null,         // the settled card (what the panel shows)
  shownKey: null,
  pending: null, pendingKey: null, settleT: null,
  scrolling: false,    // a second card change arrived while one was settling
  trail: [],           // settled cards, oldest first
  folded: false,       // this player's Fold
  ghost: false,        // pointer over the panel
  recap: null, recapT: null,
  tickT: null,
  rings: new Map(),    // tokenUuid → element
};

function enabled() {
  if (game.user?.isGM) return false;
  try { return getClientOption("allyWatch") !== "off"; } catch { return true; }
}

function receive(p) {
  if (!p?.actorId || p.userId === game.user?.id || game.user?.isGM) return;
  if (!p.open) {
    if (W.snap && W.snap.actorId === p.actorId) {
      const recap = recapOf(W.snap);
      W.snap = null;
      if (recap) showRecap(recap);
    }
    render();
    return;
  }
  if (W.actorId !== p.actorId) resetWatch(p.actorId);
  W.snap = p;
  onCard(p.card ?? null);
  render();
}

function resetWatch(actorId = null) {
  clearTimeout(W.settleT);
  Object.assign(W, { snap: null, actorId, shown: null, shownKey: null, pending: null, pendingKey: null, settleT: null, scrolling: false, trail: [] });
}

// A card change waits SETTLE_MS; another change meanwhile marks "scrolling".
const cardKey = (c) => (c ? `${c.name}|${c.from ?? ""}` : "");
function onCard(card) {
  const key = cardKey(card);
  if (key === (W.shownKey ?? "")) {
    clearTimeout(W.settleT);
    W.pending = null; W.pendingKey = null; W.scrolling = false;
    W.shown = card;
    return;
  }
  if (key === W.pendingKey) { W.pending = card; return; }
  W.scrolling = W.pendingKey != null;
  W.pending = card; W.pendingKey = key;
  clearTimeout(W.settleT);
  W.settleT = setTimeout(() => {
    W.shown = W.pending; W.shownKey = W.pendingKey;
    W.pending = null; W.pendingKey = null; W.scrolling = false;
    if (W.shown && W.snap?.step === "list" && !W.trail.some((t) => t.name === W.shown.name)) {
      W.trail.push({ name: W.shown.name, icon: W.shown.icon });
      if (W.trail.length > TRAIL_MAX) W.trail.shift();
    }
    render();
  }, SETTLE_MS);
}

function onTurnStatus(st) {
  const acting = st?.phase === "acting" && st.side === "party" ? String(st.actorId ?? "") : null;
  if (acting !== W.actorId) {
    resetWatch(acting);
    if (!acting) clearRecapSoon();
    else hideRecap();
  }
  render();
}

// ── recap after a confirm ─────────────────────────────────────────────────────
function recapOf(snap) {
  if (snap.step !== "tgt") return null;
  const picked = (snap.targets ?? []).flatMap((c) => c.rows).filter((r) => r.sel).map((r) => r.name);
  const card = W.shown ?? snap.card;
  if (!picked.length || !card) return null;
  return { actorId: snap.actorId, name: card.name, icon: card.icon, targets: picked };
}
function showRecap(r) {
  W.recap = r;
  clearTimeout(W.recapT);
  W.recapT = setTimeout(hideRecap, RECAP_MS);
}
function hideRecap() { clearTimeout(W.recapT); W.recap = null; render(); }
function clearRecapSoon() { if (W.recap) { clearTimeout(W.recapT); W.recapT = setTimeout(hideRecap, 1200); } }

// ── what is on screen ─────────────────────────────────────────────────────────
function watching() {
  if (!enabled() || !W.snap?.open) return false;
  const st = hudTurnStatus();
  return st?.phase === "acting" && st.side === "party" && String(st.actorId) === W.snap.actorId;
}
const myUnit = () => document.querySelector(".dhud-plate-root .dhud-unit");
const allyCard = (actorId) => document.querySelector(`.dhud-root .dhud-card[data-actor-id="${CSS.escape(String(actorId))}"]`);
// This player has a decision of their own: their drawer is out, or their
// reaction hand holds a card.
const busyMyself = () => !!(myUnit()?.classList.contains("is-open") || document.querySelector(".rxh-card:not(.is-leaving)"));

// Every draw goes through here: a drawing fault hides the watch, never the battle.
function render() {
  try { draw(); }
  catch (e) {
    warn("[AllyWatch] draw failed — hiding the watch", e);
    try { document.getElementById(PANEL_ID)?.remove(); document.getElementById(RINGS_ID)?.remove(); W.rings.clear(); } catch { /* */ }
    if (W.tickT) { clearInterval(W.tickT); W.tickT = null; }
  }
}
function draw() {
  const on = watching();
  const panel = on || W.recap ? ensurePanel() : document.getElementById(PANEL_ID);
  if (panel) {
    if (on) paintPanel(panel);
    else if (W.recap && enabled()) paintRecap(panel);
    else { panel.remove(); }
  }
  paintRings(on);
  paintMyTab(on);
  paintAllyCost(on);
  const need = on || !!W.recap || W.rings.size > 0;
  if (need && !W.tickT) W.tickT = setInterval(tick, TICK_MS);
  if (!need && W.tickT) { clearInterval(W.tickT); W.tickT = null; }
}

function tick() {
  try {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      const busy = watching() && busyMyself();
      if (busy !== panel.classList.contains("is-auto")) { render(); return; }
      anchor(panel);
    }
    positionRings();
  } catch (e) { render(); }
}

function ensurePanel() {
  ensureStyles();
  let el = document.getElementById(PANEL_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = PANEL_ID;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "off");
  el.addEventListener("click", (e) => {
    if (!e.target.closest?.(".faw-fold")) return;
    e.stopPropagation();
    W.folded = !W.folded;
    render();
  });
  document.body.appendChild(el);
  return el;
}

const EYE = '<svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true"><path d="M1 5C3 1.5 11 1.5 13 5C11 8.5 3 8.5 1 5Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="5" r="1.9" fill="currentColor"/></svg>';
const CHEVRON = (down) => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="${down ? "M2 4L6 8L10 4" : "M2 8L6 4L10 8"}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function paintPanel(panel) {
  const s = W.snap;
  const auto = busyMyself();
  const folded = W.folded || auto || s.step === "react";
  const actor = game.actors?.get(s.actorId);
  const who = actor?.name ?? hudTurnStatus()?.name ?? "Ally";
  const player = game.users?.get(s.userId)?.name ?? "A player";
  const crumbs = String(s.crumb ?? "").split("›").map((t) => t.trim()).filter(Boolean);
  const sub = s.step === "react" ? `· <b>${esc(player)}</b> is answering a reaction`
    : auto ? `· <i>folded while you decide</i>`
    : `· <b>${esc(player)}</b> is choosing`;

  let body = "", foot = "";
  if (!folded) {
    if (s.step === "cmd") body = cmdsHTML(s);
    else if (s.step === "list") { body = listHTML(s) + `<div class="faw-sep"></div>` + cardHTML(); foot = footHTML(W.scrolling ? "Scrolling…" : "Browsing"); }
    else if (s.step === "tgt") { body = targetsHTML(s); const n = pickedRows(s).length; foot = footHTML(`${n} picked`); }
    else body = `<div class="faw-other">${esc(player)} is choosing${crumbs.length ? `: <b>${esc(crumbs.join(" › "))}</b>` : "…"}</div>${W.shown ? `<div class="faw-sep"></div>${cardHTML()}` : ""}`;
  }
  panel.className = `faw-panel${folded ? " is-folded" : ""}${auto ? " is-auto" : ""}${W.ghost ? " is-ghost" : ""}`;
  panel.innerHTML = `
    <div class="faw-ph">
      <span class="faw-eye">${EYE}Watching</span>
      <span class="faw-who">${esc(who)}</span><span class="faw-whos">${sub}</span>
      <span class="faw-crumbs">${crumbs.map((c, i) => `${i ? '<span class="sep">›</span>' : ""}<span class="${i === crumbs.length - 1 ? "now" : ""}">${esc(c)}</span>`).join("")}</span>
      <button type="button" class="faw-fold" aria-label="${folded ? "Unfold" : "Fold"} the watch panel">${CHEVRON(!folded)}</button>
    </div>
    ${body ? `<div class="faw-pb">${body}</div>` : ""}${foot}`;
  anchor(panel);
}

function cmdsHTML(s) {
  return `<div class="faw-cmds">${(s.cmds ?? []).map((c) => `<span class="faw-cmd${c.cur ? " is-cur" : ""}${c.dis ? " is-dis" : ""}">${esc(c.label)}</span>`).join("")}</div>`;
}

function listHTML(s) {
  const rows = s.list ?? [];
  const at = Math.max(0, rows.findIndex((r) => r.cur));
  const start = Math.max(0, Math.min(at - 3, rows.length - LIST_WINDOW));
  const win = rows.slice(start, start + LIST_WINDOW);
  const scroll = rows.length > LIST_WINDOW
    ? `<i class="faw-track"></i><i class="faw-thumb" style="top:${Math.round((start / (rows.length - LIST_WINDOW)) * 100 * 0.55)}%;height:45%"></i>` : "";
  return `<div class="faw-list">${win.map((r) => r.sec != null
    ? `<div class="faw-sec">${esc(r.sec)}</div>`
    : `<div class="faw-row${r.cur ? " is-cur" : ""}${r.dis ? " is-dis" : ""}">${r.icon ? `<img src="${esc(r.icon)}" alt="">` : "<span></span>"}<span class="nm">${esc(r.name)}</span><span class="c">${esc(r.chip ?? "")}</span></div>`).join("")}${scroll}</div>`;
}

// "Can target you": the card's target chip names creatures or allies, not only
// the caster or the enemy side. A hint, read from the words on the card.
function canTargetMe(card) {
  const t = (card?.chips ?? []).map((c) => c.text).join(" · ");
  return /\b(creatures?|ally|allies)\b/i.test(t) && !/\b(self|enemy|enemies|foes?)\b/i.test(t);
}

function cardHTML() {
  const c = W.shown;
  if (!c) return `<div class="faw-det is-empty">${W.pendingKey ? "…" : ""}</div>`;
  const chips = [
    ...(canTargetMe(c) ? [`<span class="faw-chip you">Can target you</span>`] : []),
    ...(c.chips ?? []).slice(0, 4).map((ch) => `<span class="faw-chip${/mp|ip/.test(ch.tone) ? " cost" : ch.tone === "danger" ? " bad" : ""}">${esc(ch.text)}</span>`),
  ].join("");
  return `<div class="faw-det${W.scrolling ? " is-stale" : ""}">
    <div class="faw-dhead">${c.icon ? `<img src="${esc(c.icon)}" alt="">` : ""}<div style="min-width:0"><div class="faw-dfrom">${esc(c.from || c.kind || "")}</div><div class="faw-dname">${esc(c.name)}</div></div>${W.scrolling ? `<span class="faw-scroll">Scrolling…</span>` : ""}</div>
    ${chips ? `<div class="faw-chips">${chips}</div>` : ""}
    ${c.why ? `<div class="faw-why">${esc(c.why)}</div>` : ""}
    <div class="faw-dbody">${esc(String(c.body ?? "").split("\n")[0] ?? "")}</div>
  </div>`;
}

const pickedRows = (s) => (s.targets ?? []).flatMap((c) => c.rows).filter((r) => r.sel);
function isMine(uuid) {
  const mine = myUnit()?.dataset.actorId;
  if (!mine || !uuid) return false;
  try { return fromUuidSync(uuid)?.actor?.id === mine; } catch { return false; }
}

function targetsHTML(s) {
  const cols = s.targets ?? [];
  // The column the cursor is in (else the first with a pick, else the first).
  const col = cols.find((c) => c.rows.some((r) => r.cur)) ?? cols.find((c) => c.rows.some((r) => r.sel)) ?? cols[0];
  const rows = col?.rows ?? [];
  const at = Math.max(0, rows.findIndex((r) => r.cur));
  const start = Math.max(0, Math.min(at - 2, rows.length - TARGET_WINDOW));
  const win = rows.slice(start, start + TARGET_WINDOW);
  const left = `<div class="faw-list faw-tlist"><div class="faw-sec">${esc(col?.label ?? "Targets")}</div>${win.map((r) => `
    <div class="faw-trow${r.cur && !r.sel ? " is-cur" : ""}${r.excl ? " is-dis" : ""}"><span class="faw-dia${r.sel ? " on" : ""}"></span>${r.img ? `<img src="${esc(r.img)}" alt="">` : "<span></span>"}<span class="nm">${esc(r.name)}${isMine(r.uuid) ? '<span class="you">YOU</span>' : ""}</span><span class="hp">${esc(r.hp)}</span></div>`).join("")}</div>`;
  const c = W.shown ?? s.card;
  const picked = pickedRows(s);
  const sum = picked.length
    ? picked.map((r) => `<div class="faw-pick"><span class="faw-dia on"></span>${esc(r.name)}${isMine(r.uuid) ? '<span class="you">YOU</span>' : ""}</div>`).join("")
    : `<div class="faw-pick none">Nothing picked yet</div>`;
  return `${left}<div class="faw-sep"></div><div class="faw-det">
    ${c ? `<div class="faw-dhead">${c.icon ? `<img src="${esc(c.icon)}" alt="">` : ""}<div style="min-width:0"><div class="faw-dfrom">${esc(c.from || c.kind || "")}</div><div class="faw-dname">${esc(c.name)}</div></div></div>` : ""}
    <div class="faw-picks">${sum}</div></div>`;
}

function footHTML(status) {
  const trail = W.trail.map((t, i) => `${i ? '<span class="faw-tsep">·</span>' : ""}<span class="faw-tr${W.shown?.name === t.name ? " now" : ""}">${t.icon ? `<img src="${esc(t.icon)}" alt="">` : ""}${esc(t.name)}</span>`).join("");
  return `<div class="faw-pf">${trail ? `<span class="faw-lk">Looked at</span>${trail}` : ""}<span class="r">${esc(status)}</span></div>`;
}

function paintRecap(panel) {
  const r = W.recap;
  const who = game.actors?.get(r.actorId)?.name ?? "Ally";
  panel.className = "faw-panel faw-recap";
  panel.innerHTML = `${r.icon ? `<img src="${esc(r.icon)}" alt="">` : ""}<span><b>${esc(who)}</b> · ${esc(r.name)} → ${esc(r.targets.join(", "))}</span><span class="ok" aria-hidden="true">✓</span>`;
  anchor(panel, r.actorId);
}

// Above the acting ally's compact card; never over this player's own plate.
function anchor(panel, actorId = W.snap?.actorId) {
  const s = hudScale();
  const card = allyCard(actorId);
  const cardR = card?.getBoundingClientRect();
  const rootR = document.querySelector(".dhud-root")?.getBoundingClientRect();
  if (!cardR && !rootR) { panel.style.display = "none"; return; }
  panel.style.display = "";
  const w = (panel.classList.contains("faw-recap") ? panel.offsetWidth : PANEL_W) * s;
  const cardLeft = cardR ? cardR.left : rootR.left;
  const top = cardR ? cardR.top : rootR.top;
  const plateR = document.querySelector(".dhud-plate-root .dhud-pcard")?.getBoundingClientRect();
  const maxRight = plateR ? plateR.left - 12 : window.innerWidth - 12;
  const left = Math.max(8, Math.min(cardLeft, maxRight - w));
  // The acting card's portrait stands ~25 px over the card's top edge.
  const bottom = window.innerHeight - top + 32 * s;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.bottom = `${Math.round(bottom)}px`;
  panel.style.transform = `scale(${s.toFixed(4)})`;
  panel.style.setProperty("--faw-tail", `${Math.round(Math.max(18, Math.min(PANEL_W - 30, (cardLeft - left) / s + 34)))}px`);
}

// ── field rings ───────────────────────────────────────────────────────────────
function paintRings(on) {
  const want = new Map();
  const s = W.snap;
  if (on && s?.step === "tgt") {
    const label = (W.shown ?? s.card)?.name ?? "";
    for (const r of (s.targets ?? []).flatMap((c) => c.rows)) {
      if (!r.uuid || (!r.sel && !r.cur)) continue;
      want.set(r.uuid, { sel: r.sel, label: r.sel ? `${label}${isMine(r.uuid) ? " · You" : ""}` : "" });
    }
  }
  let layer = document.getElementById(RINGS_ID);
  if (!want.size) {
    for (const el of W.rings.values()) el.remove();
    W.rings.clear();
    layer?.remove();
    return;
  }
  ensureStyles();
  if (!layer) { layer = document.createElement("div"); layer.id = RINGS_ID; document.body.appendChild(layer); }
  for (const [uuid, el] of W.rings) if (!want.has(uuid)) { el.remove(); W.rings.delete(uuid); }
  for (const [uuid, w] of want) {
    let el = W.rings.get(uuid);
    if (!el) {
      el = document.createElement("div");
      el.innerHTML = `<i class="ring"></i><span class="tag"></span>`;
      layer.appendChild(el);
      W.rings.set(uuid, el);
    }
    el.className = `faw-ring${w.sel ? " is-pick" : " is-cur"}`;
    const tag = el.querySelector(".tag");
    tag.textContent = w.label;
    tag.hidden = !w.label;
  }
  positionRings();
}

function positionRings() {
  if (!W.rings.size || !canvas?.ready) return;
  let rect;
  try { rect = canvas.app.view.getBoundingClientRect(); } catch { return; }
  const wt = canvas.stage.worldTransform;
  const sc = canvas.stage.scale?.x ?? 1;
  for (const [uuid, el] of W.rings) {
    let t = null;
    try { t = fromUuidSync(uuid)?.object ?? null; } catch { t = null; }
    if (!t || t.destroyed) { el.style.display = "none"; continue; }
    const p = new PIXI.Point();
    wt.apply({ x: t.x + t.w / 2, y: t.y + t.h * 0.94 }, p);
    const w = t.w * sc * 0.95, h = w * 0.3;
    el.style.display = "";
    el.style.left = `${Math.round(rect.left + p.x - w / 2)}px`;
    el.style.top = `${Math.round(rect.top + p.y - h / 2)}px`;
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
  }
}

// ── this player's plate: "Hina picked you · Heal" ─────────────────────────────
function paintMyTab(on) {
  const unit = myUnit();
  let tab = unit?.querySelector(".faw-youtab") ?? document.querySelector(".faw-youtab");
  const s = W.snap;
  const me = on && s?.step === "tgt" ? pickedRows(s).find((r) => isMine(r.uuid)) : null;
  if (!me || !unit) { tab?.remove(); return; }
  ensureStyles();
  if (!tab) { tab = document.createElement("div"); tab.className = "faw-youtab"; tab.setAttribute("role", "status"); unit.appendChild(tab); }
  const who = game.actors?.get(s.actorId)?.name ?? "An ally";
  const what = (W.shown ?? s.card)?.name;
  const html = `<span class="faw-dia on"></span><span><b>${esc(who)}</b> picked you${what ? ` · ${esc(what)}` : ""}</span>`;
  if (tab._h !== html) { tab.innerHTML = html; tab._h = html; }
}

// ── the acting ally's MP bar: what the hovered row would cost ─────────────────
function paintAllyCost(on) {
  for (const el of document.querySelectorAll(".dhud-root .faw-cost")) {
    if (!on || el.closest(".dhud-card")?.dataset.actorId !== W.snap?.actorId) el.remove();
  }
  const s = W.snap;
  const need = on && s?.step === "list" ? Number(s.cost?.mp) || 0 : 0;
  const bar = need ? allyCard(s.actorId)?.querySelector(".dhud-bar.dhud-mp") : null;
  if (!bar) { document.querySelectorAll(".dhud-root .faw-cost").forEach((el) => el.remove()); return; }
  const mp = readUnitInfo(game.actors?.get(s.actorId))?.mp;
  if (!mp) return;
  ensureStyles();
  let el = bar.querySelector(".faw-cost");
  if (!el) { el = document.createElement("i"); el.className = "faw-cost"; bar.appendChild(el); }
  const spend = Math.min(need, Math.max(0, mp.v));
  el.style.left = `${(Math.max(0, mp.v - spend) / mp.m) * 100}%`;
  el.style.width = `${(Math.max(spend, mp.m * 0.012) / mp.m) * 100}%`;
  el.classList.toggle("is-short", need > mp.v);
}

// ── pointer: fade while over the panel (it never takes the click) ─────────────
function onPointerMove(e) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel || panel.classList.contains("faw-recap")) { W.ghost = false; return; }
  const r = panel.getBoundingClientRect();
  const fold = panel.querySelector(".faw-fold")?.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const onFold = !!fold && e.clientX >= fold.left - 4 && e.clientX <= fold.right + 4 && e.clientY >= fold.top - 4 && e.clientY <= fold.bottom + 4;
  const ghost = inside && !onFold;
  if (ghost === W.ghost) return;
  W.ghost = ghost;
  panel.classList.toggle("is-ghost", ghost);
}

// ── styles ────────────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
/* The Watching panel: information, not a control. Thinner frame and softer
   shadow than the parchment surfaces you click; plain words instead of
   buttons; the pointer goes through it (Fold aside). */
#${PANEL_ID} {
  position: fixed; z-index: 60; width: ${PANEL_W}px; box-sizing: border-box; pointer-events: none;
  transform-origin: bottom left; display: flex; flex-direction: column;
  font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif; color: #3a3228;
  background: linear-gradient(180deg, rgba(246,241,230,.95), rgba(235,227,208,.95));
  border: 1.5px solid rgba(122,106,85,.7); border-radius: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.3);
  transition: opacity 160ms ease; animation: fawIn 220ms ease-out;
}
@keyframes fawIn { from { opacity: 0; } to { opacity: 1; } }
#${PANEL_ID}::before { content: ""; position: absolute; inset: 4px; border: 1px solid rgba(213,182,122,.45); border-radius: 8px; pointer-events: none; }
#${PANEL_ID}::after { content: ""; position: absolute; left: var(--faw-tail, 34px); bottom: -9px; width: 14px; height: 14px; transform: rotate(45deg);
  background: #ebe3d0; border-right: 1.5px solid rgba(122,106,85,.7); border-bottom: 1.5px solid rgba(122,106,85,.7); }
#${PANEL_ID}.is-ghost { opacity: .25; }
#${PANEL_ID} .faw-ph { flex: none; height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 12px; border-bottom: 1px solid rgba(183,147,90,.45); }
#${PANEL_ID}.is-folded .faw-ph { border-bottom: none; height: 36px; }
#${PANEL_ID} .faw-eye { flex: none; display: flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px 0 6px; border-radius: 10px;
  background: rgba(31,90,160,.1); color: #1f5aa0; font: 800 9.5px "Inter", sans-serif; letter-spacing: .14em; text-transform: uppercase;
  animation: fawEye 3.4s ease-in-out infinite alternate; }
@keyframes fawEye { from { box-shadow: 0 0 0 rgba(31,90,160,0); } to { box-shadow: 0 0 10px rgba(31,90,160,.45); } }
#${PANEL_ID} .faw-who { font: 900 12px "Inter", sans-serif; letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
#${PANEL_ID} .faw-whos { font: 600 13px "Inter", sans-serif; color: #6a5d4c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
#${PANEL_ID} .faw-whos b { color: #1f5aa0; }
#${PANEL_ID} .faw-whos i { font-style: normal; color: #9b2f24; }
#${PANEL_ID} .faw-crumbs { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; max-width: 190px; overflow: hidden;
  font: 800 10px "Inter", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #9a8d76; white-space: nowrap; }
#${PANEL_ID} .faw-crumbs .now { color: #3a3228; }
#${PANEL_ID} .faw-crumbs .sep { color: #b7935a; }
#${PANEL_ID} .faw-fold { pointer-events: auto; flex: none; width: 28px; height: 28px; margin: 0 0 0 6px; padding: 0; display: grid; place-items: center;
  border-radius: 7px; border: 1px solid rgba(122,106,85,.5); background: #f6f1e6; color: #6a5d4c; cursor: pointer; line-height: 0; box-shadow: none; }
#${PANEL_ID} .faw-fold:hover { background: #ebe3d0; }
#${PANEL_ID} .faw-pb { display: flex; padding: 8px 12px 0 12px; min-height: 0; }
#${PANEL_ID} .faw-pf { flex: none; height: 30px; display: flex; align-items: center; gap: 6px; padding: 0 14px; border-top: 1px dashed rgba(122,106,85,.3);
  font: 600 12px "Inter", sans-serif; color: #6a5d4c; white-space: nowrap; overflow: hidden; }
#${PANEL_ID} .faw-pf .r { margin-left: auto; padding-left: 8px; }
#${PANEL_ID} .faw-lk { font: 800 9.5px "Inter", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #9a8d76; margin-right: 2px; }
#${PANEL_ID} .faw-tr { display: flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px 0 3px; border-radius: 10px; font: 600 11.5px "Inter", sans-serif;
  color: #6a5d4c; background: rgba(58,50,40,.05); }
#${PANEL_ID} .faw-tr img { width: 15px; height: 15px; border-radius: 4px; border: 0; }
#${PANEL_ID} .faw-tr.now { color: #3a3228; font-weight: 800; background: rgba(183,147,90,.22); }
#${PANEL_ID} .faw-tsep { color: #b7935a; font-size: 10px; }
#${PANEL_ID} .faw-cmds { flex: 1; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); grid-auto-rows: 28px; gap: 4px 6px; padding-bottom: 10px; }
#${PANEL_ID} .faw-cmd { display: flex; align-items: center; padding: 0 8px 0 10px; border-radius: 6px; overflow: hidden; text-overflow: ellipsis;
  font: 700 11px "Inter", sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #7a6a55; white-space: nowrap; }
#${PANEL_ID} .faw-cmd.is-dis { opacity: .45; }
#${PANEL_ID} .faw-cmd.is-cur, #${PANEL_ID} .faw-row.is-cur { color: #3a3228; font-weight: 800; opacity: 1;
  background: linear-gradient(180deg, #fef5dc, #ebd9a6); box-shadow: 0 0 0 1px rgba(90,62,28,.4) inset; }
#${PANEL_ID} .faw-list { width: 236px; flex: none; position: relative; padding: 0 10px 8px 0; box-sizing: border-box; }
#${PANEL_ID} .faw-tlist { width: 250px; }
#${PANEL_ID} .faw-sec { height: 22px; display: flex; align-items: flex-end; padding: 0 0 2px 4px; box-sizing: border-box; font: 800 9.5px "Inter", sans-serif;
  letter-spacing: .1em; text-transform: uppercase; color: #9a8d76; white-space: nowrap; overflow: hidden; }
#${PANEL_ID} .faw-row { height: 22px; display: grid; grid-template-columns: 18px minmax(0,1fr) auto; align-items: center; column-gap: 7px; padding: 0 6px 0 5px;
  border-radius: 5px; font: 600 12.5px "Inter", sans-serif; white-space: nowrap; color: #5a4e3e; }
#${PANEL_ID} .faw-row img, #${PANEL_ID} .faw-trow img { width: 18px; height: 18px; border-radius: 4px; border: 0; display: block; }
#${PANEL_ID} .faw-row .nm, #${PANEL_ID} .faw-trow .nm { overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .faw-row .c { font: 700 10.5px "Inter", sans-serif; color: #8a7d68; }
#${PANEL_ID} .faw-row.is-dis { opacity: .5; }
#${PANEL_ID} .faw-track { position: absolute; right: 2px; top: 2px; bottom: 10px; width: 3px; border-radius: 2px; background: rgba(122,106,85,.15); }
#${PANEL_ID} .faw-thumb { position: absolute; right: 2px; width: 3px; border-radius: 2px; background: #b7935a; }
#${PANEL_ID} .faw-trow { height: 26px; display: grid; grid-template-columns: 12px 20px minmax(0,1fr) auto; align-items: center; column-gap: 7px; padding: 0 6px 0 4px;
  border-radius: 5px; font: 600 12.5px "Inter", sans-serif; white-space: nowrap; }
#${PANEL_ID} .faw-trow img { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; object-position: 50% 12%; box-shadow: 0 0 0 1.5px #b7935a; }
#${PANEL_ID} .faw-trow .hp { font: 700 11px "Inter", sans-serif; color: #6a5d4c; font-variant-numeric: tabular-nums; }
#${PANEL_ID} .faw-trow.is-cur { box-shadow: inset 0 0 0 1.5px rgba(63,134,216,.75); background: rgba(63,134,216,.08); }
#${PANEL_ID} .faw-trow.is-dis { opacity: .45; }
#${PANEL_ID} .you, .faw-youtab .you { font: 800 9px "Inter", sans-serif; letter-spacing: .1em; color: #1f5aa0; margin-left: 5px; }
#${PANEL_ID} .faw-sep { width: 1px; flex: none; margin: 2px 12px 10px 0; background: linear-gradient(180deg, transparent, #b7935a 15%, #b7935a 85%, transparent); }
#${PANEL_ID} .faw-det { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; transition: opacity 160ms ease; }
#${PANEL_ID} .faw-det.is-stale { opacity: .45; }
#${PANEL_ID} .faw-dhead { display: flex; align-items: center; gap: 9px; }
#${PANEL_ID} .faw-dhead img { width: 36px; height: 36px; border-radius: 8px; border: 0; flex: none; box-shadow: 0 0 0 2px #b7935a, 0 2px 6px rgba(0,0,0,.25); }
#${PANEL_ID} .faw-dname { font: 800 16px/1.1 "Inter", sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .faw-dfrom { font: 800 9px "Inter", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #9a8d76; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .faw-scroll { margin-left: auto; align-self: flex-start; flex: none; font: 800 9.5px/18px "Inter", sans-serif; letter-spacing: .1em; text-transform: uppercase;
  color: #6a5d4c; padding: 0 7px; border-radius: 9px; box-shadow: inset 0 0 0 1px rgba(122,106,85,.5); }
#${PANEL_ID} .faw-chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 40px; overflow: hidden; }
#${PANEL_ID} .faw-chip { font: 700 10.5px/18px "Inter", sans-serif; padding: 0 7px; border-radius: 5px; box-shadow: inset 0 0 0 1px rgba(122,106,85,.45); color: #3a3228; white-space: nowrap; }
#${PANEL_ID} .faw-chip.cost { background: rgba(47,111,192,.12); box-shadow: inset 0 0 0 1px rgba(47,111,192,.45); color: #1f5aa0; }
#${PANEL_ID} .faw-chip.bad { background: rgba(179,38,30,.1); box-shadow: inset 0 0 0 1px rgba(179,38,30,.35); color: #b3261e; }
#${PANEL_ID} .faw-chip.you { background: #1f5aa0; color: #fff; box-shadow: none; }
#${PANEL_ID} .faw-why { font: 700 12px/1.3 "Inter", sans-serif; color: #b3261e; }
#${PANEL_ID} .faw-dbody { font: 400 12.5px/17px "Signika", "Inter", sans-serif; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#${PANEL_ID} .faw-picks { display: flex; flex-direction: column; gap: 3px; }
#${PANEL_ID} .faw-pick { display: flex; align-items: center; gap: 8px; font: 700 13px "Inter", sans-serif; }
#${PANEL_ID} .faw-pick.none { color: #9a8d76; font-weight: 600; }
#${PANEL_ID} .faw-other { flex: 1; font: 600 13px "Inter", sans-serif; color: #6a5d4c; padding: 6px 4px 12px; }
#${PANEL_ID} .faw-other b { color: #3a3228; }
.faw-dia { width: 10px; height: 10px; transform: rotate(45deg); border-radius: 2px; flex: none; box-sizing: border-box; border: 1.5px solid #7a6a55; }
.faw-dia.on { background: #e0a526; border-color: #8a5a18; box-shadow: 0 0 6px rgba(224,165,38,.8); }

/* After the confirm: one line above the card, then gone. */
#${PANEL_ID}.faw-recap { width: auto; height: 38px; flex-direction: row; align-items: center; gap: 8px; padding: 0 14px 0 8px; border-radius: 19px;
  font: 600 14px "Inter", sans-serif; white-space: nowrap; }
#${PANEL_ID}.faw-recap::before { border-radius: 15px; }
#${PANEL_ID}.faw-recap img { width: 24px; height: 24px; border-radius: 6px; border: 0; box-shadow: 0 0 0 1.5px #b7935a; }
#${PANEL_ID}.faw-recap .ok { width: 20px; height: 20px; border-radius: 50%; background: #2c8a45; color: #fff; display: grid; place-items: center; font: 900 12px "Inter", sans-serif; }

/* Field: blue floor rings under the acting player's picks (dashed = their cursor). */
#${RINGS_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 29; }
#${RINGS_ID} .faw-ring { position: fixed; pointer-events: none; }
#${RINGS_ID} .faw-ring .ring { position: absolute; inset: 0; border-radius: 50%; box-sizing: border-box; }
#${RINGS_ID} .faw-ring.is-pick .ring { border: 3px solid #3f86d8; box-shadow: 0 0 12px rgba(63,134,216,.85), inset 0 0 10px rgba(63,134,216,.6); }
#${RINGS_ID} .faw-ring.is-cur .ring { border: 2.5px dashed #9cc6f2; box-shadow: 0 0 8px rgba(63,134,216,.5); }
#${RINGS_ID} .faw-ring .tag { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 2px); white-space: nowrap; height: 20px; padding: 0 8px; border-radius: 10px;
  display: flex; align-items: center; font: 800 10.5px "Inter", sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #3a3228;
  background: linear-gradient(180deg, #f6f1e6, #ebe3d0); border: 1.5px solid #1f5aa0; }
#${RINGS_ID} .faw-ring .tag[hidden] { display: none; }

/* Your plate: a tab when the acting ally picked you (same fused-tab shape as
   the Waiting-on tab, at the right end). Glow-only breathing. */
.faw-youtab { position: absolute; right: 26px; bottom: calc(100% - 4px); z-index: 4; display: flex; align-items: center; gap: 8px; height: 32px;
  padding: 0 14px 2px 10px; box-sizing: border-box; border-radius: 10px 10px 0 0; pointer-events: none;
  background: linear-gradient(180deg, #f6f1e6, #ebe3d0); border: 2px solid #1f5aa0; border-bottom: 0;
  font: 600 13px var(--dhud-ui, "Inter", sans-serif); color: #3a3228; white-space: nowrap; animation: fawYou 3.4s ease-in-out infinite alternate; }
.faw-youtab b { color: #1f5aa0; }
@keyframes fawYou { from { box-shadow: 0 0 6px rgba(31,90,160,.35); } to { box-shadow: 0 0 18px 3px rgba(31,90,160,.6); } }
.dhud-unit.is-open .faw-youtab { display: none; }

/* The acting ally's MP bar: the hovered row's cost. */
.dhud-root .faw-cost { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(135deg, rgba(255,255,255,.8) 0 3px, rgba(255,255,255,.35) 3px 6px); }
.dhud-root .faw-cost.is-short { background: repeating-linear-gradient(135deg, rgba(196,71,58,.9) 0 3px, rgba(196,71,58,.45) 3px 6px); }
`;
  document.head.appendChild(st);
}

// ── socket + boot ─────────────────────────────────────────────────────────────
function ensureSocket() {
  if (_socket) return _socket;
  if (!game.modules?.get("socketlib")?.active || !window.socketlib) return null;
  try {
    _socket = window.socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_SNAP, (p) => { try { receive(p); } catch (e) { warn("[AllyWatch] receive failed", e); } });
  } catch (e) { warn("[AllyWatch] socket registration failed", e); _socket = null; }
  return _socket;
}

Hooks.once("ready", () => {
  ensureSocket();
  if (game.user?.isGM) return;
  Hooks.on("fu-hud-turn-status", (st) => { try { onTurnStatus(st); } catch (e) { warn("[AllyWatch] turn status failed", e); } });
  Hooks.on("fuClientOptionChanged", ({ key } = {}) => { if (key === "allyWatch") render(); });
  Hooks.on("canvasPan", () => { if (W.rings.size) positionRings(); });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.allyWatch = Object.freeze({
    state: () => ({ watching: watching(), step: W.snap?.step ?? null, actorId: W.actorId, shown: W.shown?.name ?? null,
      pending: W.pending?.name ?? null, scrolling: W.scrolling, trail: W.trail.map((t) => t.name), folded: W.folded,
      recap: W.recap, rings: [...W.rings.keys()] }),
    // Test hook: feed a snapshot as if it came over the socket.
    receive: (p) => receive(p),
  });
  log("[AllyWatch] ready");
});
