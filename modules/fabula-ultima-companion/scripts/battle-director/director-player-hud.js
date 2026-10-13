// Battle Director — per-client player resource HUD.
//
// Self-contained: owns its CSS, socketlib channel, and reload gate. Does NOT
// depend on resource-ui-manager.js / OniHud2.
//
// Layout (2026-10-12, "own plate + command drawer"):
//
//   ┌──────┐┌──────┐┌──────┐                      ┌─[ KEREN · TURN ACTION ]──┐
//   │ card ││ card ││ card │                      │  command drawer (turn-ui) │
//   └──────┘└──────┘└──────┘                      ├──────────────────────────┤
//    compact cards: everyone                      │  plate: you              │
//    else, bottom-left                            └──────────────────────────┘
//
//   - The PLATE is this client's own character, parchment, bottom-right,
//     always visible. On your turn the command window (turn-ui.js) opens as a
//     DRAWER out of its top edge, inside the same frame — see openPlateDrawer.
//   - Everyone else is a dark COMPACT CARD (76 px tall) bottom-left. The GM has
//     no plate: every card is compact, and the acting one gets a gold frame
//     (setHudActing); the command window stands alone in the corner.
//   - Clocks (resource-tagged Active Effects) are thin Fabula Ultima rings with
//     the icon always visible, inside the plate / beside the card. Any number
//     is supported, including none; the overflow rules are in plateShelfHTML
//     and cardGridHTML.
//
// Lifecycle:
//   buildDirectorHud(entries, scene)  — called from director-init.js after
//     entrance animations complete. Persists scene flags for reload survival,
//     then broadcasts via socket so every client builds locally. GM builds
//     with full token refs (executeForOthers path); others resolve from
//     actorIds via game.actors.
//
//   destroyDirectorHud(scene)         — called from state-handlers.js
//     Stopped.onEnter. Broadcasts destroy to all clients, then clears flags.
//
// Reload gate: Hooks.on("canvasReady") + Hooks.once("ready") both call
// tryReloadRecovery, which reads scene flags and rebuilds locally if the HUD
// is missing. canvasTearDown destroys local HUD on scene switch; canvasReady
// rebuilds it from flags when the scene is re-entered.

import { log, warn } from "./logger.js";
import { playSfx } from "./director-sfx.js";
import { setPlateCard } from "./drawer-views.js";

const MODULE_ID  = "fabula-ultima-companion";
const ACTION_BUILD   = "FU_DIRECTOR_HUD_BUILD";
const ACTION_DESTROY = "FU_DIRECTOR_HUD_DESTROY";
const ACTION_TURN     = "FU_DIRECTOR_HUD_TURN";       // GM → everyone: who is choosing / acting
const ACTION_TURN_GET = "FU_DIRECTOR_HUD_TURN_GET";   // a (re)built client → GM: the latest one
const FLAG_KEY    = "directorHudKey";
const FLAG_ACTORS = "directorHudActorIds";
const STYLE_ID    = "fu-director-hud-style";

// ── design constants ────────────────────────────────────────────────────────
const TONE = {
  hpA: "#6bd66b", hpB: "#2fbf71",
  mpA: "#5aa8ff", mpB: "#2e7bd6",
  zpA: "#ffd95a", zpB: "#ff9c2e",
  hp50: "#a2e33a", hp25: "#ffb84a", hp10: "#ff5a5a",
};

// ── actor stat paths ──────────────────────────────────────────────────────────
const P_HP_V = "system.props.current_hp";
const P_HP_M = "system.props.max_hp";
const P_MP_V = "system.props.current_mp";
const P_MP_M = "system.props.max_mp";
const P_IP_V = "system.props.current_ip";
const P_IP_M = "system.props.max_ip";
const P_ZP_V = "system.props.zero_power_value";
const ZP_MAX  = 6;
const P_FP    = "system.props.fabula_point";
const P_LEVEL = "system.props.level";
const P_DEF   = "system.props.defense";
const P_MDEF  = "system.props.magic_defense";
const P_ZP_NAME = "system.props.zero_power_name";

// Status icons on the plate's top line: temporary effects only (permanent gear
// and passive effects live in the Party Menu), at most this many before "+N".
const STATUS_MAX = 8;

// One-shot cue when the Take Turn handle becomes yours to press. The glow is
// deliberately quiet, so a player looking at the map or chat would miss it.
const TAKE_READY_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav";
const TAKE_READY_VOL = 0.55;

// ── custom-resource (tagged AE) reading ─────────────────────────────────────
// An Active Effect opts into the HUD by carrying `system.tags` including
// "resource". Display value/cap come from the existing charges flags
// (flags.fabula-ultima-companion.charges / chargesMax). A "points" tag (or a
// blank/zero max) renders as an uncapped running counter instead of a clock.
const RES_TAG        = "resource";
const RES_POINTS_TAG = "points";
const RES_SEG_MAX    = 12;          // beyond this many segments, the ring is one continuous arc
const RES_ACCENT_A   = "#ffb340";   // vivid orange (light)
const RES_ACCENT_B   = "#ff6a00";   // vivid orange (deep)
const RES_GLOW       = "rgba(255,150,40,.6)";

// How many Clocks each surface shows before folding the rest into "+N".
const PLATE_NAMED_MAX = 3;          // 1–3: ring + name + count
const PLATE_RING_MAX  = 12;         // 4–12: rings with a count badge; more → last slot "+N"
const CARD_RING_MAX   = 4;          // 2×2 grid; 5+ → 4th slot "+N"

// Plate / card ring sizes (px, before the HUD scale).
const PLATE_RING_PX = 32;
const CARD_RING_PX  = 30;          // two fit inside the 76 px card

// The floating button column that hangs off the sidebar on the right edge
// (rewind, clocks, combat, AE manager, check requester / roller, EXP). Which of
// them exist depends on the client (the dice roller is a PLAYER button too), so
// the right-edge reserve is measured, not assumed — see rightEdgeReserve.
const RIGHT_EDGE_BUTTON_IDS = [
  "fud-rewindbtn-root", "oni-clock-gm-root", "oni-combatbtn-root", "oni-aem-button-root",
  "oni-creq-button-root", "oni-cr-button-root", "oni-expbtn-root",
];
const RIGHT_EDGE_GAP_PX = 16;
// The bottom line the card row, the plate and a standalone command window sit
// on: this far from the screen bottom. The card row (and a standalone window
// with it) rises above Foundry's Players list / hotbar when those are showing
// under it; the plate never does — see place().
const HUD_BASELINE_PX = 20;

// Retired 2026-10-12: the per-client chip tuning (scale 1.6, x/y offsets…).
// Clocks are now part of the plate and the cards, so there is nothing to
// offset. The API names stay so an old macro does not throw.
const RES_CFG_KEY = "fu-dhud-res-cfg";

// ── per-key registry  { key → { root, plateRoot, cards, plate, offFns } } ───
const byKey = new Map();

let _socket = null;

// Acting actor for the gold card frame; survives a HUD rebuild mid-turn.
let _actingActorId = null;
// The same, from the GM's turn status — for clients that are not composing
// the turn themselves (every player but the acting one).
let _statusActingId = null;

// GM-only preview: build a plate for this actor as if this client owned it,
// so the plate + drawer can be seen and tested from the GM seat.
let _previewPlateActorId = null;

// Turn status, published by the GM at every TURN_START (see publishTurnStatus):
//   { phase: "picking", side, eligibleActorIds }   a side is choosing who acts
//   { phase: "acting", side, actorId, name, img }   someone is taking a turn
// It drives the Take Turn handle's disabled reasons and the acting card's
// frame on clients that are not composing the turn themselves.
let _turnStatus = null;

// The plate's Take Turn handle, armed by the turn picker when this client's
// plate actor may act: { actorId, combatantId, pick() }.
let _takeTurn = null;

// ── helpers ───────────────────────────────────────────────────────────────────
const pick  = (o, p) => { try { return getProperty(o, p); } catch { return undefined; } };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pct   = (v, m) => `${(clamp(v / m, 0, 1) * 100).toFixed(4)}%`;
const nice  = x => new Intl.NumberFormat().format(Math.max(0, Math.floor(Number(x) || 0)));
const esc   = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const pair = (a, vp, mp) => {
  const v = Number(pick(a, vp)), m = Number(pick(a, mp));
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return null;
  return { v, m };
};
const readHP = a => pair(a, P_HP_V, P_HP_M);
/** { v, m } HP of any actor, the way the HUD reads it (the drawer's target rows). */
export const readActorHp = (a) => { try { return readHP(a); } catch { return null; } };
const readMP = a => pair(a, P_MP_V, P_MP_M) ?? { v: 0, m: 1 };
const readIP = a => {
  const v = Number(pick(a, P_IP_V));
  let m   = Number(pick(a, P_IP_M));
  if (!Number.isFinite(m) || m <= 0) m = 6;
  return { v: Number.isFinite(v) ? clamp(v, 0, m) : 0, m };
};
const readZP = a => {
  const v = Number(pick(a, P_ZP_V));
  return { v: Number.isFinite(v) ? Math.max(0, v) : 0, m: ZP_MAX };
};
const readNum = (a, p) => { const n = Number(pick(a, p)); return Number.isFinite(n) ? n : null; };
const numText = n => (n == null ? "–" : nice(n));

// Crisis = at or below half max HP (FU core); KO = 0 HP.
const hpState = hp => (!hp ? "" : hp.v <= 0 ? "ko" : hp.v <= hp.m / 2 ? "crisis" : "");

const stripTags = s => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const lc = s => String(s ?? "").toLowerCase();

// Per-resource tint helpers. A configured AE colour (single hex) becomes the
// ring's dark stop; the light stop + glow are derived from it.
function lightenHex(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const mix = c => Math.round(c + (255 - c) * amt);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Lower-cased `system.tags` array of an Active Effect (the canonical AE tag store
// — same field the Battle Director already reads to count debuffs).
function aeTags(eff) {
  const t = eff?.system?.tags;
  return Array.isArray(t) ? t.map(lc) : [];
}

// Strip the trailing noun so a Clock reads "Brainwave 3/4" not "Brainwave Clock 3/4".
function shortResName(n) {
  const s = String(n ?? "");
  return s.replace(/\s*(clock|gauge|meter|points?)\s*$/i, "").trim() || s;
}

// Every HUD-tagged resource currently on the actor, newest-grant order.
function collectHudResources(actor) {
  const out = [], seen = new Set();
  let effs = [];
  try { effs = Array.from(actor?.allApplicableEffects?.() ?? []); } catch { effs = []; }
  for (const eff of effs) {
    if (!eff) continue;
    const tags = aeTags(eff);
    if (!tags.includes(RES_TAG)) continue;
    const uid = eff.id ?? eff.name;
    if (seen.has(uid)) continue;
    seen.add(uid);
    const f = eff.flags?.[MODULE_ID] ?? {};
    const v    = Number(f.charges);
    const mRaw = Number(f.chargesMax);
    // Per-resource tint (authored in the AE Charges config). Absent → default orange.
    const hex    = typeof f.hudResourceColor === "string" ? f.hudResourceColor.trim() : "";
    const colorB = /^#?[0-9a-f]{6}$/i.test(hex) ? (hex.startsWith("#") ? hex : `#${hex}`) : null;
    out.push({
      uid,
      name:   shortResName(eff.name),
      img:    eff.img ?? eff.icon ?? "",
      v:      Number.isFinite(v) ? Math.max(0, v) : 0,
      m:      Number.isFinite(mRaw) && mRaw > 0 ? mRaw : null,
      points: tags.includes(RES_POINTS_TAG),
      colorA: colorB ? lightenHex(colorB, 0.42) : null,
      colorB,
      glow:   colorB ? hexToRgba(colorB, 0.65) : null,
    });
  }
  return out;
}

const isPoints = r => r.points || !r.m;
const resValueText = r => isPoints(r) ? `✦ ${nice(r.v)}` : `${nice(r.v)} / ${nice(r.m)}`;
const resTip = r => `${r.name}: ${isPoints(r) ? nice(r.v) : `${nice(r.v)} / ${nice(r.m)}`}`;

// An AE update/create/delete belongs to this actor if the effect's parent is the
// actor (actor-direct) or an item owned by the actor (item-granted).
function effBelongsToActor(eff, actorId) {
  const p = eff?.parent;
  if (!p) return false;
  return p.id === actorId || p.parent?.id === actorId;
}

function glideNumber(node, from, to, ms = 420) {
  if (!node) return;
  const t0 = performance.now(), d = to - from;
  function loop(t) {
    const n = Math.min(1, (t - t0) / ms);
    const e = n < 0.5 ? 2 * n * n : 1 - Math.pow(-2 * n + 2, 2) / 2;
    node.textContent = nice(from + d * e);
    if (n < 1) requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function tintHp(fillEl, v, m) {
  const p = Math.max(0, Math.min(1, v / m));
  if      (p <= 0.10) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp10}, #ff7676)`;
  else if (p <= 0.25) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp25}, #ff9a5c)`;
  else if (p <= 0.50) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp50}, #89e14a)`;
  else                fillEl.style.background = `linear-gradient(90deg, ${TONE.hpA}, ${TONE.hpB})`;
}

const dotRow = (m, v) =>
  Array.from({ length: m }, (_, i) => `<i class="${i < v ? "on" : ""}"></i>`).join("");

const flash = el => {
  if (!el) return;
  el.classList.remove("dhud-flash");
  void el.offsetWidth;
  el.classList.add("dhud-flash");
};

// ── Clock ring ────────────────────────────────────────────────────────────────
// A Fabula Ultima style Clock: a THIN segmented ring (stroke ≈ 8.5% of the
// size) so the effect's icon inside stays large and always visible — the
// user's explicit ask. Points resources (Prophecy…) draw one closed ring and
// carry their number in a badge; a Clock past RES_SEG_MAX segments draws one
// continuous arc instead of slivers.
let _ringSeq = 0;
function ringSVG(size, r, { light = false } = {}) {
  const id = `dhr${++_ringSeq}`, c = size / 2;
  const sw = Math.max(2.5, size * 0.085);
  const rad = c - sw / 2 - 0.5;
  const inner = size - 2 * sw - 2;
  const a = r.colorA ?? RES_ACCENT_A, b = r.colorB ?? RES_ACCENT_B, g = r.glow ?? RES_GLOW;
  const at = d => [c + rad * Math.cos(d * Math.PI / 180), c + rad * Math.sin(d * Math.PI / 180)];
  const arc = (a0, a1, on) => {
    const [x0, y0] = at(a0), [x1, y1] = at(a1);
    return `<path${on ? ' class="on"' : ""} d="M${x0.toFixed(2)} ${y0.toFixed(2)} A${rad.toFixed(2)} ${rad.toFixed(2)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" stroke="${on ? `url(#g${id})` : "rgba(255,255,255,.34)"}" stroke-width="${sw.toFixed(2)}" fill="none" stroke-linecap="butt"/>`;
  };
  let segs = "";
  if (isPoints(r)) {
    segs = `<circle class="on" cx="${c}" cy="${c}" r="${rad.toFixed(2)}" stroke="url(#g${id})" stroke-width="${sw.toFixed(2)}" fill="none"/>`;
  } else if (r.m <= RES_SEG_MAX) {
    const gap = r.m > 8 ? 7 : 9;
    for (let i = 0; i < r.m; i++) {
      segs += arc(-90 + (i * 360) / r.m + gap / 2, -90 + ((i + 1) * 360) / r.m - gap / 2, i < r.v);
    }
  } else {
    const f = clamp(r.v / r.m, 0, 1);
    segs = `<circle cx="${c}" cy="${c}" r="${rad.toFixed(2)}" stroke="rgba(255,255,255,.34)" stroke-width="${sw.toFixed(2)}" fill="none"/>`;
    if (f >= 1) segs += `<circle class="on" cx="${c}" cy="${c}" r="${rad.toFixed(2)}" stroke="url(#g${id})" stroke-width="${sw.toFixed(2)}" fill="none"/>`;
    else if (f > 0) segs += arc(-90, -90 + 360 * f, true);
  }
  const mid = r.img
    ? `<image href="${esc(r.img)}" x="${(c - inner / 2).toFixed(2)}" y="${(c - inner / 2).toFixed(2)}" width="${inner.toFixed(2)}" height="${inner.toFixed(2)}" clip-path="url(#c${id})" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-family="Inter, Signika, 'Segoe UI', sans-serif" font-weight="900" font-size="${Math.round(size * .34)}" fill="#fff">${esc(nice(r.v))}</text>`;
  const full = !isPoints(r) && r.v >= r.m;
  return `<svg class="dhud-ring${full ? " is-full" : ""}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="--dhud-ring-glow:${g}" aria-hidden="true">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
    <clipPath id="c${id}"><circle cx="${c}" cy="${c}" r="${(inner / 2).toFixed(2)}"/></clipPath></defs>
    <circle cx="${c}" cy="${c}" r="${c - .5}" fill="rgba(14,9,4,.82)" stroke="${light ? "rgba(122,106,85,.7)" : "rgba(255,170,80,.3)"}"/>
    ${segs}${mid}</svg>`;
}

// The "+N" slot that stands in for the Clocks that did not fit.
function moreRingSVG(size, n) {
  const c = size / 2;
  return `<svg class="dhud-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${c - .5}" fill="rgba(14,9,4,.82)" stroke="rgba(255,170,80,.45)"/>
    <text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-family="Inter, 'Segoe UI', sans-serif" font-weight="800" font-size="${Math.round(size * .36)}" fill="#ffe9a8">+${n}</text></svg>`;
}

// One Clock slot: the ring plus (optionally) a badge, tooltipped with the
// Clock's name and count. `enter` marks a Clock granted since the last render.
function ringSlot(size, r, { badge = null, light = false, enter = false } = {}) {
  const b = badge ? `<b class="dhud-rbadge">${esc(badge)}</b>` : "";
  return `<span class="dhud-rslot${enter ? " dhud-res-enter" : ""}" data-uid="${esc(r.uid)}" data-tooltip="${esc(resTip(r))}">${ringSVG(size, r, { light })}${b}</span>`;
}
function moreSlot(size, rest) {
  const tip = rest.map(resTip).join("<br>");
  return `<span class="dhud-rslot" data-tooltip="${esc(tip)}">${moreRingSVG(size, rest.length)}</span>`;
}

// Plate shelf: none at 0; 1–3 ring + name + count; 4–12 rings + count badge
// (names on hover); more → the last slot is "+N".
function plateShelfHTML(list, fresh) {
  if (!list.length) return "";
  if (list.length <= PLATE_NAMED_MAX) {
    return list.map(r => `<div class="dhud-ritem">${ringSlot(PLATE_RING_PX, r, { light: true, enter: fresh.has(r.uid) })}
      <div><div class="dhud-rn">${esc(r.name)}</div><div class="dhud-rv">${esc(resValueText(r))}</div></div></div>`).join("");
  }
  const shown = list.length > PLATE_RING_MAX ? list.slice(0, PLATE_RING_MAX - 1) : list;
  const rest  = list.slice(shown.length);
  return shown.map(r => ringSlot(PLATE_RING_PX, r, {
    light: true, enter: fresh.has(r.uid),
    badge: isPoints(r) ? `✦${nice(r.v)}` : `${nice(r.v)}/${nice(r.m)}`,
  })).join("") + (rest.length ? moreSlot(PLATE_RING_PX, rest) : "");
}

// Compact-card grid: none at 0; 1–4 in a 2×2 grid; 5+ → the 4th slot is "+N".
// Names and counts on hover; points resources keep their number in a badge.
function cardGridHTML(list, fresh) {
  if (!list.length) return "";
  const shown = list.length > CARD_RING_MAX ? list.slice(0, CARD_RING_MAX - 1) : list;
  const rest  = list.slice(shown.length);
  return shown.map(r => ringSlot(CARD_RING_PX, r, {
    light: true, enter: fresh.has(r.uid), badge: isPoints(r) ? `✦${nice(r.v)}` : null,
  })).join("") + (rest.length ? moreSlot(CARD_RING_PX, rest) : "");
}

// Reconcile one surface's Clocks against the actor. Re-renders only when the
// data changed; a Clock that is new since the last render entrance-animates.
function renderResources(card, actor) {
  const host = card.resHost;
  if (!host) return;
  const list = collectHudResources(actor);
  const sig = JSON.stringify(list);
  if (sig === host._sig) return;
  const prev = host._uids ?? null;
  const fresh = new Set(prev ? list.filter(r => !prev.has(r.uid)).map(r => r.uid) : []);
  host._sig = sig;
  host._uids = new Set(list.map(r => r.uid));
  host.innerHTML = card.kind === "plate" ? plateShelfHTML(list, fresh) : cardGridHTML(list, fresh);
  host.classList.toggle("is-empty", !list.length);
  host.classList.toggle("is-compact", card.kind === "plate" && list.length > PLATE_NAMED_MAX);
  if (prev) flash(host);
}

// ── Status icons (plate top line) ─────────────────────────────────────────────
// The Party Menu's Status rows (party-menu-effects.js), so the hover text is
// the same as on its Status page: name, how long, what it does. Temporary
// effects only, and never a Clock (those have their own rings).
function statusTip(r) {
  const amounts = [...new Set([
    ...r.totals.map(t => t.text),
    ...r.sources.flatMap(s => s.amounts.filter(a => a.active && typeof a.add !== "number").map(a => a.text)),
  ])];
  const desc = clip(stripTags(r.description || r.sources.find(s => s.source?.description)?.source?.description || ""), 220);
  return [
    `<strong>${esc(r.name)}</strong>${r.short ? ` · ${esc(r.short)}` : ""}`,
    r.lifetime?.label ? `<em>${esc(r.lifetime.label)}</em>` : "",
    amounts.length ? esc(amounts.join(" · ")) : "",
    desc ? esc(desc) : "",
  ].filter(Boolean).join("<br>");
}

// Loaded lazily: a static import would pull the Party Menu's module graph
// (party-menu-core → skill-effects …) into every picker that imports this file.
let _effectRowsOf = null, _effectRowsLoad = null;
function loadEffectRows() {
  _effectRowsLoad ??= import("../party-menu/party-menu-effects.js")
    .then(m => { _effectRowsOf = m.effectRowsOf; })
    .catch(e => warn("[DirectorHud] Party Menu effects unavailable — no status icons", e));
  return _effectRowsLoad;
}

function renderStatuses(card, actor) {
  const host = card.statusHost;
  if (!host) return;
  if (!_effectRowsOf) {
    loadEffectRows().then(() => { if (_effectRowsOf && card.el.isConnected) renderStatuses(card, game.actors?.get(actor.id) ?? actor); });
    return;
  }
  let rows = [];
  try {
    rows = _effectRowsOf(actor).filter(r => r.temporary && !r.inactive
      && !r.sources.some(s => aeTags(s.eff).includes(RES_TAG)));
  } catch (e) { warn("[DirectorHud] status rows failed", e); }
  const sig = rows.map(r => `${r.key}:${r.short}:${r.count}`).join("|");
  if (sig === host._sig) return;
  host._sig = sig;
  const shown = rows.length > STATUS_MAX ? rows.slice(0, STATUS_MAX - 1) : rows;
  const rest = rows.slice(shown.length);
  host.innerHTML = shown.map(r => `<span class="dhud-st" data-tooltip="${esc(statusTip(r))}" data-tooltip-direction="UP"><img src="${esc(r.img)}" alt=""></span>`).join("")
    + (rest.length ? `<span class="dhud-st is-more" data-tooltip="${esc(rest.map(statusTip).join("<hr>"))}" data-tooltip-direction="UP">+${rest.length}</span>` : "");
}

// ── CSS injection ─────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.dhud-root, .dhud-plate-root {
  --dhud-hp-a: ${TONE.hpA}; --dhud-hp-b: ${TONE.hpB};
  --dhud-mp-a: ${TONE.mpA}; --dhud-mp-b: ${TONE.mpB};
  --dhud-zp-a: ${TONE.zpA}; --dhud-zp-b: ${TONE.zpB};
  --dhud-parch-top: #f6f1e6; --dhud-parch-bot: #ebe3d0;
  --dhud-ink: #3a3228; --dhud-ink-soft: #6a5d4c;
  --dhud-gold-1: #d5b67a; --dhud-gold-2: #b7935a; --dhud-stroke: #7a6a55;
  --dhud-ip-on: #e8a43a;
  --dhud-ui: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
  position: fixed; pointer-events: none;
}

/* ── Compact cards (everyone but you) ─────────────────────────────────────
   Bottom edge just above Foundry's Players list; placeCards() keeps it there
   as the list grows, and clear of the GM's dev-tools button. */
.dhud-root {
  left: 20px; bottom: ${HUD_BASELINE_PX}px;
  z-index: var(--z-index-canvas, 0);
  display: flex; align-items: flex-end; gap: 10px;
  transform-origin: bottom left;
}
/* Compact cards wear the same parchment as every other battle surface (the
   pickers, turn pills, reaction blades, action card and command window):
   umber stroke, gold hairline, ink text, uppercase Inter labels. They replaced
   the old dark OniHud2 cards, the one surface outside that family. */
.dhud-card {
  pointer-events: auto; position: relative; box-sizing: border-box;
  display: flex; gap: 8px; align-items: center; height: 76px; padding: 7px 9px 7px 78px;
  background: linear-gradient(180deg, var(--dhud-parch-top), var(--dhud-parch-bot));
  border: 2px solid var(--dhud-stroke); border-radius: 12px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 8px 22px rgba(0,0,0,.42);
  color: var(--dhud-ink); font-family: var(--dhud-ui);
  opacity: 0; transform: translateX(-24px);
  transition: opacity 420ms ease, transform 420ms ease, box-shadow 160ms ease;
}
.dhud-card::before {
  content: ""; position: absolute; inset: 4px; pointer-events: none;
  border: 1px solid var(--dhud-gold-1); border-radius: 8px;
}
.dhud-card.dhud-appear { opacity: 1; transform: translateX(0); }
.dhud-card.is-acting {
  border-color: var(--dhud-gold-2);
  box-shadow: 0 0 0 2px var(--dhud-gold-1), 0 0 16px rgba(213,182,122,.75), 0 8px 22px rgba(0,0,0,.42);
}
/* Portrait card (mockup option B, 2026-10-12; Fire Emblem: Three Houses style):
   a framed, slightly tilted portrait that stands on the left end of its frame
   and breaks out over the top edge. Same object on the plate and on every
   compact card; on your turn / the acting card it lifts and glows gold. */
.dhud-pcard {
  position: absolute; z-index: 3; box-sizing: border-box;
  background: linear-gradient(180deg, var(--dhud-parch-top), var(--dhud-parch-bot));
  border: 2px solid var(--dhud-stroke); border-radius: 10px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 10px 20px rgba(0,0,0,.45);
  transform: rotate(-2.5deg); transform-origin: bottom center;
  transition: transform 260ms cubic-bezier(.2,.8,.2,1), box-shadow 260ms ease;
}
.dhud-pcard .art {
  position: relative; width: 100%; height: 100%; box-sizing: border-box; overflow: hidden;
  border: 2px solid var(--dhud-gold-2); border-radius: 7px; background: #d9c9a8;
}
.dhud-pcard img {
  width: 100%; height: 100%; object-fit: cover; object-position: 50% 14%; display: block;
  border: none !important; background: transparent !important; box-shadow: none !important;
}
.dhud-card .dhud-pcard { left: 5px; bottom: 5px; width: 64px; height: 90px; padding: 3px; }
.dhud-card.is-acting .dhud-pcard,
.dhud-unit.is-open .dhud-pcard {
  transform: rotate(-2.5deg) translateY(-6px);
  box-shadow: 0 0 0 2px var(--dhud-gold-1), 0 0 16px rgba(213,182,122,.8), 0 12px 22px rgba(0,0,0,.45);
}

.dhud-card .dhud-cbody {
  width: 140px; flex: none; align-self: stretch;
  display: flex; flex-direction: column; justify-content: space-between;
}
.dhud-card .dhud-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.dhud-card .dhud-name {
  font: 900 11px var(--dhud-ui); letter-spacing: .08em; text-transform: uppercase;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.dhud-ip { display: flex; gap: 3px; flex: none; border-radius: 6px; transition: box-shadow 160ms ease; }
.dhud-ip i { border-radius: 50%; background: rgba(58,50,40,.18); box-shadow: inset 0 0 0 1px rgba(58,50,40,.25); }
.dhud-ip i.on { background: var(--dhud-ip-on); box-shadow: none; }
.dhud-card .dhud-ip i { width: 6px; height: 6px; }
.dhud-card .dhud-ip.is-many { gap: 2px; }
.dhud-card .dhud-ip.is-many i { width: 5px; height: 5px; }
.dhud-card .dhud-hpline {
  display: flex; align-items: baseline; justify-content: space-between;
  line-height: 1; font-variant-numeric: tabular-nums;
}
.dhud-card .dhud-hpline .big { font: 800 15px var(--dhud-ui); }
.dhud-card .dhud-hpline .big .sl { color: var(--dhud-ink-soft); font-weight: 600; margin: 0 1px; }
.dhud-card .dhud-hpline .mp { font: 800 12px var(--dhud-ui); }
.dhud-lbl { font: 900 8.5px var(--dhud-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--dhud-stroke); }
.dhud-card .dhud-hpline .dhud-lbl { margin-right: 3px; }
.dhud-bar {
  position: relative; border-radius: 6px; overflow: hidden;
  background: rgba(58,50,40,.2); border: 1px solid rgba(58,50,40,.28);
  transition: box-shadow 160ms ease;
}
.dhud-fill {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: linear-gradient(90deg, var(--dhud-hp-a), var(--dhud-hp-b));
  transition: width 240ms ease, background 120ms linear;
}
.dhud-mp .dhud-fill { background: linear-gradient(90deg, var(--dhud-mp-a), var(--dhud-mp-b)); }
.dhud-zp .dhud-fill { background: linear-gradient(90deg, var(--dhud-zp-a), var(--dhud-zp-b)); }
.dhud-zp .dhud-fill.dhud-glow { box-shadow: 0 0 8px rgba(255,170,60,.85); }
/* HP / MP / ZP on one label column, so the three bars start and end on the
   same edges (the plate labels its bars the same way). */
.dhud-card .dhud-cbars { display: grid; grid-template-columns: 15px 1fr; align-items: center; gap: 2px 3px; }
.dhud-card .dhud-cbars .dhud-lbl { line-height: 1; }
.dhud-card .dhud-bar { height: 7px; }
.dhud-card .dhud-bar.dhud-mp, .dhud-card .dhud-bar.dhud-zp { height: 5px; }
.dhud-card .dhud-resgrid {
  display: grid; grid-template-rows: repeat(2, ${CARD_RING_PX}px); grid-auto-flow: column;
  grid-auto-columns: ${CARD_RING_PX}px; gap: 2px 4px; align-content: center;
  align-self: stretch; padding-left: 8px; border-left: 1px dashed rgba(122,106,85,.45);
}
.dhud-card .dhud-resgrid.is-empty { display: none; }
.dhud-card .dhud-hpline .dhud-stamp { font-size: 8.5px; line-height: 12px; padding: 0 3px; border-width: 1.5px; letter-spacing: .6px; margin-right: auto; margin-left: 5px; }

/* ── Your plate (+ the command drawer that opens out of it) ───────────────
   Bottom-anchored, so a Clock appearing mid-battle or the drawer opening
   grows it UPWARD and nothing else moves. Right edge clears the sidebar.
   Built from the approved mockup (claude.ai/artifact/SdvijvE7bGB3TP8HzH8Rhq). */
.dhud-plate-root {
  right: calc(var(--fu-sidebar-anchor-right, 0px) + 16px); bottom: ${HUD_BASELINE_PX}px;
  z-index: 70;
  transform-origin: bottom right;
}
.dhud-unit {
  pointer-events: auto; position: relative; box-sizing: border-box;
  /* FIXED: 670 = the open drawer's width (601 px of commands + the 64 px the
     portrait card stands over + frame). Nothing inside may resize it, so the
     plate and its portrait never shift as text or the drawer changes. */
  width: 670px;
  background: linear-gradient(180deg, var(--dhud-parch-top), var(--dhud-parch-bot));
  border: 2px solid var(--dhud-stroke); border-radius: 12px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 10px 26px rgba(0,0,0,.45);
  color: var(--dhud-ink);
  opacity: 0; transform: translateY(12px);
  transition: opacity 420ms ease, transform 420ms ease;
}
.dhud-unit.dhud-appear { opacity: 1; transform: none; }
.dhud-unit::before {
  content: ""; position: absolute; inset: 4px; pointer-events: none;
  border: 1px solid var(--dhud-gold-1); border-radius: 8px;
}

/* Portrait card on the plate: floats (a slow 4 px drift), lifts + glows gold
   while it is interactable (your pick, or the drawer open). The float uses the
   separate translate property so it adds to the tilt and lift. */
.dhud-unit .dhud-pcard {
  left: -96px; bottom: 12px; width: 152px; height: 200px; padding: 6px;
  animation: dhudFloat 2.8s ease-in-out infinite alternate;
}
@keyframes dhudFloat { from { translate: 0 1.5px; } to { translate: 0 -2.5px; } }
.dhud-unit.is-open .dhud-pcard, .dhud-unit.can-take .dhud-pcard {
  transform: rotate(-2.5deg) translateY(-6px);
  box-shadow: 0 0 0 2px var(--dhud-gold-1), 0 0 22px 5px rgba(228,184,100,.88), 0 12px 22px rgba(0,0,0,.45);
}
.dhud-unit.is-ko .dhud-pcard { animation: none; }
.dhud-unit .dhud-pcard .dhud-pname {
  position: absolute; left: 50%; bottom: -12px; transform: translateX(-50%); z-index: 1;
  display: flex; gap: 6px; align-items: center;
  padding: 3px 12px; background: var(--dhud-ink); color: var(--dhud-parch-top);
  border: 2px solid var(--dhud-gold-2); border-radius: 8px;
  font: 800 13px var(--dhud-ui); letter-spacing: .12em; text-transform: uppercase; white-space: nowrap;
}
.dhud-unit .dhud-pname .lv { color: var(--dhud-gold-1); font-size: 11px; }
.dhud-unit .dhud-pname .lv:empty { display: none; }

/* ── Take Turn = the drawer's handle (players) ──
   A tab fused to the plate's top edge: square bottom corners, no gap, no drop
   shadow. It reaches 4 px into the frame (over the stroke and the white rim)
   and sits on the gold inner line. FIXED 240 x 50 (34 as the open tab): a
   long reason truncates, it never resizes the handle. Pressing it pulls the
   drawer out; the handle rides up and becomes the "Turn Action" tab. */
.dhud-take {
  position: absolute; left: 82px; bottom: calc(100% - 4px); z-index: 5;
  display: flex; align-items: center; box-sizing: border-box;
  width: 240px; height: 50px; margin: 0; padding: 0 10px 4px 12px;
  border-radius: 10px 10px 0 0; border-bottom: 0 !important;
  font-family: var(--dhud-ui); line-height: 1; text-align: left;
  pointer-events: auto; cursor: default;
  transition: height 380ms cubic-bezier(.2,.8,.2,1), border-color 260ms ease, color 260ms ease;
}
.dhud-take::before {
  content: ""; position: absolute; inset: 0; border-radius: 8px 8px 0 0;
  background: var(--dhud-ink); opacity: 0; transition: opacity 260ms ease;
}
.dhud-take .face {
  position: relative; width: 100%;
  display: grid; grid-template-columns: 26px minmax(0, 1fr) 48px; align-items: center; column-gap: 8px;
  transition: opacity 200ms ease;
}
.dhud-take .face-tab {
  position: absolute; inset: 0 8px 4px; display: grid; place-items: center; opacity: 0;
  transition: opacity 200ms ease; overflow: hidden; text-overflow: ellipsis;
  font: 800 13px var(--dhud-ui); letter-spacing: .12em; text-transform: uppercase;
  color: var(--dhud-gold-1); white-space: nowrap;
}
.dhud-take .ico { width: 26px; height: 26px; display: grid; place-items: center; }
.dhud-take .ico img {
  width: 26px; height: 26px; border-radius: 50%; object-fit: cover; object-position: 50% 14%;
  border: 1.5px solid rgba(122,106,85,.75) !important; box-sizing: border-box; background: #d9c9a8;
}
.dhud-take .txt { display: grid; min-width: 0; line-height: 1.05; text-align: center; }
.dhud-take .lab, .dhud-take .why { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dhud-take .lab { font: 800 19px var(--dhud-ui); letter-spacing: .12em; text-transform: uppercase; }
.dhud-take .why { font: 700 12px var(--dhud-ui); letter-spacing: .02em; }
.dhud-take .why:empty { display: none; }
.dhud-take .key {
  height: 26px; box-sizing: border-box; display: grid; place-items: center; border-radius: 6px;
  font: 800 12px var(--dhud-ui); letter-spacing: .04em;
}
/* Yours to press: garnet, the glow slowly widens and narrows. The glow is
   clipped at the plate's edge so it only spreads up and sideways. Only the
   glow moves, so it plays for everyone. */
.dhud-take.is-on {
  cursor: pointer; color: #fff3e6;
  background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14);
  border: 2px solid #e2c27e;
  box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 18px 3px rgba(222,66,46,.6);
  clip-path: polygon(-40px -40px, calc(100% + 40px) -40px, calc(100% + 40px) calc(100% - 4px), 100% calc(100% - 4px), 100% 100%, 0 100%, 0 calc(100% - 4px), -40px calc(100% - 4px));
  animation: dhudTakeGlow 3.4s ease-in-out infinite alternate;
}
.dhud-take.is-on .key { background: #fff3e6; color: #741a14; }
.dhud-take.is-on .ico { color: #ffd9a0; }
.dhud-take.is-on .why { display: none; }
.dhud-unit:not(.is-open) .dhud-take.is-on:hover { filter: brightness(1.06); }
.dhud-take.is-on:focus-visible { outline: 3px solid #ffd9a0; outline-offset: -5px; }
/* The moment it becomes yours: one brighter swell, then the slow breathing. */
.dhud-take.is-on.is-arrive { animation: dhudTakeArrive 1.4s ease-out 1, dhudTakeGlow 3.4s ease-in-out 1.4s infinite alternate; }
@keyframes dhudTakeGlow {
  from { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 16px 2px rgba(222,66,46,.55); }
  to   { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 24px 5px rgba(232,72,50,.72); }
}
@keyframes dhudTakeArrive {
  0%   { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 16px 2px rgba(222,66,46,.55); }
  30%  { box-shadow: 0 0 0 1px rgba(255,236,200,.7) inset, 0 0 40px 12px rgba(255,96,64,.95); }
  100% { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 0 16px 2px rgba(222,66,46,.55); }
}
/* Not yours: muted parchment and the reason. */
.dhud-take.is-off {
  color: #8a7d68; background: linear-gradient(180deg, #ece5d5, #ddd3bf);
  border: 2px solid rgba(122,106,85,.6); box-shadow: 0 0 0 1px rgba(255,255,255,.55) inset;
}
.dhud-take.is-off .lab { font-size: 15px; }
.dhud-take.is-off .key { background: rgba(58,50,40,.12); color: #8a7d68; }
.dhud-take.is-off .why { color: #6a5d4c; }
/* Drawer open: the handle shortens into the ink "Turn Action" tab. */
.dhud-unit.is-open .dhud-take {
  height: 34px; border-color: var(--dhud-gold-2); animation: none; box-shadow: none; cursor: default; filter: none;
  color: var(--dhud-gold-1); background: var(--dhud-ink);
}
.dhud-unit.is-open .dhud-take::before { opacity: 1; }
.dhud-unit.is-open .dhud-take .face { opacity: 0; }
.dhud-unit.is-open .dhud-take .face-tab { opacity: 1; transition-delay: 120ms; }
.dhud-unit.no-take .dhud-take { display: none; }

/* ── Drawer: slides out from behind the plate ──
   Its height grows from 0 (grid 0fr -> 1fr) while the command window stays
   pinned to its front edge, so the rows come out of the plate's top like a
   drawer being pulled. The part of the frame the portrait card stands over
   stays empty (padding-left 64). */
.dhud-drawer { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 380ms cubic-bezier(.2,.8,.2,1); }
.dhud-unit.is-open .dhud-drawer { grid-template-rows: 1fr; }
.dhud-unit:not(.is-open) .dhud-drawer { transition-duration: 280ms; transition-timing-function: cubic-bezier(.5,0,.75,0); }
.dhud-dclip { min-height: 0; overflow: hidden; }
.dhud-unit:not(.is-open) .dhud-dclip { visibility: hidden; transition: visibility 0s 280ms; }
.dhud-dbody { padding-left: 64px; }

/* ── The plate: same box open or closed, so nothing on it moves while the
   drawer slides; only the divider line above it fades in. */
.dhud-plate {
  position: relative; z-index: 1; margin: 0 6px; padding: 10px 12px 11px 76px;
  border-top: 2px solid transparent; transition: border-color 260ms ease;
}
.dhud-unit.is-open .dhud-plate { border-top-color: var(--dhud-gold-2); }
.dhud-plate .grow { flex: 1; }
.dhud-plate .dhud-lbl { font-size: 9.5px; }

/* Row 1: status icons | IP pips | Fabula Points */
.dhud-row1 { display: flex; align-items: center; gap: 10px; min-height: 20px; }
.dhud-statuses { display: flex; gap: 4px; min-width: 0; }
.dhud-st {
  width: 20px; height: 20px; flex: none; box-sizing: border-box; border-radius: 50%; overflow: hidden;
  display: grid; place-items: center; border: 1.5px solid rgba(58,50,40,.55); background: #3a3228;
  font: 800 9px var(--dhud-ui); color: var(--dhud-parch-top); pointer-events: auto;
}
.dhud-st img { width: 100%; height: 100%; object-fit: cover; display: block; border: none !important; }
.dhud-plate .dhud-ip { display: flex; gap: 3px; padding: 2px 3px; }
.dhud-plate .dhud-ip i { width: 8px; height: 8px; }
.dhud-ip i.is-cost { background: transparent; box-shadow: inset 0 0 0 2px var(--dhud-ip-on); }
.dhud-fp { display: flex; align-items: baseline; gap: 5px; padding-left: 10px; border-left: 1px solid rgba(122,106,85,.4); }
.dhud-fp b { font: 800 16px var(--dhud-ui); font-variant-numeric: tabular-nums; }
.dhud-fp b::before { content: "✦"; color: var(--dhud-gold-2); margin-right: 3px; font-size: 13px; }

/* Row 2: HP / MP / ZP, each number over its bar. minmax(0, …) so a long Zero
   Power name or a wide number can't widen its column. */
.dhud-row2 { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr) minmax(0, 1.05fr); gap: 14px; margin-top: 3px; }
.dhud-res { min-width: 0; }
.dhud-res .head { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; min-width: 0; }
.dhud-res .num { font: 800 16px var(--dhud-ui); font-variant-numeric: tabular-nums; }
.dhud-res .num .sl { color: var(--dhud-ink-soft); font-weight: 600; margin: 0 1px; }
.dhud-res.hp .num { font-size: 20px; line-height: 1; }
.dhud-res .zname { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dhud-plate .dhud-bar { height: 9px; margin-top: 3px; }
.dhud-plate .dhud-res.hp .dhud-bar { height: 10px; }
.dhud-ready {
  display: none; font: 800 10px var(--dhud-ui); letter-spacing: .1em; text-transform: uppercase;
  color: var(--dhud-ink); padding: 1px 6px; border-radius: 5px; background: linear-gradient(180deg,#ffe58a,#ffb347);
}
.dhud-unit.zp-full .dhud-ready { display: inline-block; }
.dhud-unit.zp-full .dhud-bar.dhud-zp { box-shadow: 0 0 0 2px rgba(255,190,80,.6), 0 0 12px rgba(255,170,60,.8); }
.dhud-unit.zp-full .zname { color: #8a5a18; }
/* Cost link: the drawer's cursor on Spell lights the MP bar, on Item the IP pips. */
.dhud-unit.hint-mp .dhud-bar.dhud-mp { box-shadow: 0 0 0 2px rgba(90,168,255,.55), 0 0 10px rgba(90,168,255,.6); }
.dhud-unit.hint-ip .dhud-row1 .dhud-ip { box-shadow: 0 0 0 2px rgba(232,164,58,.6), 0 0 10px rgba(232,164,58,.55); }

/* Row 3: Clocks | DEF / M.DEF */
.dhud-row3 {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 5px; padding-top: 5px;
  border-top: 1px dashed rgba(122,106,85,.45); min-height: 32px;
}
.dhud-shelf { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
.dhud-shelf.is-compact { gap: 8px; }
.dhud-shelf.is-empty { display: none; }
.dhud-ritem { display: flex; align-items: center; gap: 8px; }
.dhud-rn { font: 900 10px var(--dhud-ui); letter-spacing: .08em; text-transform: uppercase; line-height: 1.3; color: var(--dhud-stroke); }
.dhud-rv { font: 800 14px var(--dhud-ui); font-variant-numeric: tabular-nums; color: var(--dhud-ink); }
.dhud-def { display: flex; gap: 10px; align-items: baseline; margin-left: auto; }
.dhud-def b { font: 800 15px var(--dhud-ui); font-variant-numeric: tabular-nums; }

/* ── Crisis / KO ── a red rubber stamp by the HP number, the number red, and a
   strong red edge on the portrait. The red sits in a layer ABOVE the picture:
   an inset shadow on .art itself is painted under the image. */
.dhud-stamp {
  display: none; align-self: center; font: 900 11px "Cinzel", Georgia, serif; letter-spacing: 1.2px; text-transform: uppercase;
  line-height: 16px; color: #c81010; padding: 0 6px; border: 2px solid rgba(200,16,16,.95);
  border-radius: 4px; background: rgba(255,238,228,.92); transform: rotate(-6deg);
}
.is-crisis .dhud-stamp, .is-ko .dhud-stamp { display: inline-block; }
.is-crisis .dhud-hpnum, .is-ko .dhud-hpnum { color: #b3261e; }
.is-crisis .dhud-pcard .art, .is-ko .dhud-pcard .art { border-color: #c4241a; }
.is-crisis .dhud-pcard .art::after, .is-ko .dhud-pcard .art::after {
  content: ""; position: absolute; inset: 0; border-radius: 5px; pointer-events: none;
  box-shadow: inset 0 0 0 2px rgba(214,36,26,.95), inset 0 0 12px 1px rgba(200,24,16,.5), inset 0 -36px 30px -16px rgba(200,24,16,.62);
}
.dhud-card.is-crisis .dhud-pcard .art::after, .dhud-card.is-ko .dhud-pcard .art::after {
  box-shadow: inset 0 0 0 2px rgba(214,36,26,.95), inset 0 0 8px 1px rgba(200,24,16,.5), inset 0 -18px 16px -8px rgba(200,24,16,.62);
}
.is-ko .dhud-pcard img { filter: grayscale(1) brightness(.85); }

/* ── Bar layers: damage trail (lingers, then shrinks to the new HP) and cost
   preview (the part a hovered spell / recipe would spend). */
.dhud-bar .dhud-trail { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: rgba(232,90,60,.75); }
.dhud-bar .dhud-cost {
  position: absolute; top: 0; bottom: 0; z-index: 2; display: none;
  background: repeating-linear-gradient(135deg, rgba(255,255,255,.75) 0 3px, rgba(255,255,255,.3) 3px 6px);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.9);
}
.dhud-bar .dhud-cost.is-on { display: block; }
.dhud-bar .dhud-cost.is-short { background: repeating-linear-gradient(135deg, rgba(220,40,30,.8) 0 3px, rgba(220,40,30,.35) 3px 6px); }

/* ── Clock rings ──────────────────────────────────────────────────────────── */
.dhud-rslot { position: relative; display: block; flex: none; pointer-events: auto; }
.dhud-ring { display: block; overflow: visible; }
.dhud-ring .on { filter: drop-shadow(0 0 2px var(--dhud-ring-glow)); }
.dhud-ring.is-full .on { filter: drop-shadow(0 0 4px var(--dhud-ring-glow)); }
.dhud-rbadge {
  position: absolute; right: -5px; bottom: -4px; min-width: 18px; height: 16px; padding: 0 4px;
  box-sizing: border-box; border-radius: 8px; display: grid; place-items: center;
  font: 800 10px var(--dhud-ui); white-space: nowrap; font-variant-numeric: tabular-nums;
  color: var(--dhud-parch-top); background: var(--dhud-ink); border: 1.5px solid var(--dhud-gold-1);
}
.dhud-res-enter { animation: dhudResIn .42s ease both; }
@keyframes dhudResIn {
  from { opacity: 0; transform: scale(.6); }
  to   { opacity: 1; transform: scale(1); }
}
.dhud-flash { animation: dhudFlash .35s ease; }
@keyframes dhudFlash {
  0%   { filter: brightness(1.15); }
  100% { filter: brightness(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dhud-card, .dhud-unit { transition: opacity 120ms linear; transform: none; }
  .dhud-res-enter, .dhud-flash { animation: none; }
}
`;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = css;
  document.head.appendChild(st);
}

// ── card / plate DOM builders ─────────────────────────────────────────────────
// Both return the same handle shape so updateCard / renderResources serve both.
function cardHandle(el, kind) {
  return {
    el, kind,
    hpFill: el.querySelector(".dhud-hp .dhud-fill"),
    hpTrail: el.querySelector(".dhud-hp .dhud-trail"),
    mpFill: el.querySelector(".dhud-mp .dhud-fill"),
    zpFill: el.querySelector(".dhud-zp .dhud-fill"),
    hpCur:  el.querySelector(".dhud-hpcur"),
    hpMax:  el.querySelector(".dhud-hpmax"),
    mpNum:  el.querySelector(".dhud-mpnum"),
    mpMax:  el.querySelector(".dhud-mpmax"),
    zpNum:  el.querySelector(".dhud-zpnum"),
    fpNum:  el.querySelector(".dhud-fpnum"),
    defNum: el.querySelector(".dhud-defnum"),
    mdefNum: el.querySelector(".dhud-mdefnum"),
    lvEl:   el.querySelector(".dhud-pname .lv"),
    zName:  el.querySelector(".dhud-zname-text"),
    stamp:  el.querySelector(".dhud-stamp"),
    ipRow:  el.querySelector(".dhud-ip"),
    nameEls: [...el.querySelectorAll(".dhud-name")],
    resHost: el.querySelector(kind === "plate" ? ".dhud-shelf" : ".dhud-resgrid"),
    statusHost: el.querySelector(".dhud-statuses"),
  };
}

// HP bar + damage trail. On a loss the trail keeps the old width for a beat,
// then shrinks to the new one, so a big hit is readable even if you looked
// away; a heal moves both at once.
function setHpBar(card, hp) {
  const f = clamp(hp.v / hp.m, 0, 1);
  const prev = card._hpFrac;
  card._hpFrac = f;
  tintHp(card.hpFill, hp.v, hp.m);
  card.hpFill.style.width = pct(hp.v, hp.m);
  const tr = card.hpTrail;
  if (!tr) return;
  clearTimeout(card._trailT);
  if (prev != null && f < prev) {
    const shown = Math.max(prev, (parseFloat(tr.style.width) || 0) / 100);
    tr.style.transition = "none";
    tr.style.width = `${(shown * 100).toFixed(4)}%`;
    card._trailT = setTimeout(() => {
      tr.style.transition = "width 650ms cubic-bezier(.4,0,.6,1)";
      tr.style.width = pct(hp.v, hp.m);
    }, 550);
  } else {
    tr.style.transition = "none";
    tr.style.width = pct(hp.v, hp.m);
  }
}

// Crisis / KO classes + the stamp's word.
function paintHpState(card, hp) {
  const st = hpState(hp);
  card.el.classList.toggle("is-crisis", st === "crisis");
  card.el.classList.toggle("is-ko", st === "ko");
  if (card.stamp) card.stamp.textContent = st === "ko" ? "KO" : "Crisis";
  return st;
}

function paintExtras(card, actor) {
  if (card.kind !== "plate") return;
  const mp = readMP(actor), zp = readZP(actor);
  if (card.mpMax) card.mpMax.textContent = nice(mp.m);
  if (card.zpNum) card.zpNum.textContent = nice(zp.v);
  card.el.classList.toggle("zp-full", zp.v >= zp.m);
  if (card.fpNum) card.fpNum.textContent = numText(readNum(actor, P_FP));
  if (card.defNum) card.defNum.textContent = numText(readNum(actor, P_DEF));
  if (card.mdefNum) card.mdefNum.textContent = numText(readNum(actor, P_MDEF));
  const lv = readNum(actor, P_LEVEL);
  if (card.lvEl) card.lvEl.textContent = lv == null ? "" : `Lv ${lv}`;
  const zn = String(pick(actor, P_ZP_NAME) ?? "").trim();
  if (card.zName) { card.zName.textContent = zn ? `ZP · ${zn}` : "ZP"; card.zName.title = zn; }
}

function paintStats(card, actor) {
  const hp = readHP(actor), mp = readMP(actor), zp = readZP(actor);
  setHpBar(card, hp); flash(card.hpFill);
  card.mpFill.style.width = pct(mp.v, mp.m); flash(card.mpFill);
  card.zpFill.style.width = pct(zp.v, zp.m); flash(card.zpFill);
  card.zpFill.classList.toggle("dhud-glow", zp.v >= zp.m);
  paintHpState(card, hp);
  paintExtras(card, actor);
  paintCost(card);
}

function makeCompactCard(actor, token) {
  const hp = readHP(actor);
  if (!hp) return null;
  const mp = readMP(actor), ip = readIP(actor);
  const portrait = actor?.img || actor?.prototypeToken?.texture?.src || token?.texture?.src || "";
  const el = document.createElement("div");
  el.className = "dhud-card";
  el.dataset.actorId = actor.id;
  el.innerHTML = `
    <div class="dhud-pcard"><div class="art"><img src="${esc(portrait)}" alt=""></div></div>
    <div class="dhud-cbody">
      <div class="dhud-top"><span class="dhud-name">${esc(token?.name || actor?.name || "—")}</span><span class="dhud-ip${ip.m > 8 ? " is-many" : ""}">${dotRow(ip.m, ip.v)}</span></div>
      <div class="dhud-hpline">
        <span class="big dhud-hpnum"><span class="dhud-hpcur">${nice(hp.v)}</span><span class="sl">/</span><span class="dhud-hpmax">${nice(hp.m)}</span></span>
        <span class="dhud-stamp">Crisis</span>
        <span class="mp"><span class="dhud-lbl">MP</span><span class="dhud-mpnum">${nice(mp.v)}</span></span>
      </div>
      <div class="dhud-cbars">
        <span class="dhud-lbl">HP</span><div class="dhud-bar dhud-hp"><i class="dhud-trail"></i><div class="dhud-fill"></div></div>
        <span class="dhud-lbl">MP</span><div class="dhud-bar dhud-mp"><div class="dhud-fill"></div></div>
        <span class="dhud-lbl">ZP</span><div class="dhud-bar dhud-zp"><div class="dhud-fill"></div></div>
      </div>
    </div>
    <div class="dhud-resgrid is-empty"></div>`;
  requestAnimationFrame(() => el.classList.add("dhud-appear"));
  const card = cardHandle(el, "card");
  paintStats(card, actor);
  renderResources(card, actor);
  return card;
}

function makePlate(actor, token) {
  const hp = readHP(actor);
  if (!hp) return null;
  const mp = readMP(actor), ip = readIP(actor), zp = readZP(actor);
  const portrait = actor?.img || actor?.prototypeToken?.texture?.src || token?.texture?.src || "";
  const name = esc(token?.name || actor?.name || "—");
  const el = document.createElement("div");
  el.className = "dhud-unit no-take";
  el.dataset.actorId = actor.id;
  el.innerHTML = `
    <div class="dhud-take is-off" role="button" tabindex="-1" aria-disabled="true">
      <span class="face"><span class="ico" aria-hidden="true"></span>
        <span class="txt"><span class="lab">Take Turn</span><span class="why"></span></span><span class="key">Enter</span></span>
      <span class="face-tab" aria-hidden="true">Turn Action</span>
    </div>
    <div class="dhud-pcard"><div class="art"><img src="${esc(portrait)}" alt=""></div><span class="dhud-pname"><span class="dhud-name">${name}</span><span class="lv"></span></span></div>
    <div class="dhud-drawer"><div class="dhud-dclip"><div class="dhud-dbody"></div></div></div>
    <div class="dhud-plate">
      <div class="dhud-row1"><div class="dhud-statuses"></div><span class="grow"></span>
        <span class="dhud-lbl">IP</span><span class="dhud-ip">${dotRow(ip.m, ip.v)}</span>
        <span class="dhud-fp"><span class="dhud-lbl">FP</span><b class="dhud-fpnum">–</b></span></div>
      <div class="dhud-row2">
        <div class="dhud-res hp"><div class="head"><span class="dhud-lbl">HP</span>
          <span class="num dhud-hpnum"><span class="dhud-hpcur">${nice(hp.v)}</span><span class="sl">/</span><span class="dhud-hpmax">${nice(hp.m)}</span></span>
          <span class="dhud-stamp">Crisis</span></div>
          <div class="dhud-bar dhud-hp"><i class="dhud-trail"></i><div class="dhud-fill"></div><i class="dhud-cost"></i></div></div>
        <div class="dhud-res mp"><div class="head"><span class="dhud-lbl">MP</span>
          <span class="num"><span class="dhud-mpnum">${nice(mp.v)}</span><span class="sl">/</span><span class="dhud-mpmax">${nice(mp.m)}</span></span></div>
          <div class="dhud-bar dhud-mp"><div class="dhud-fill"></div><i class="dhud-cost"></i></div></div>
        <div class="dhud-res zp"><div class="head"><span class="dhud-lbl zname dhud-zname-text">ZP</span><span class="grow"></span>
          <span class="dhud-ready">Ready</span><span class="num"><span class="dhud-zpnum">${nice(zp.v)}</span><span class="sl">/</span>${ZP_MAX}</span></div>
          <div class="dhud-bar dhud-zp"><div class="dhud-fill"></div></div></div>
      </div>
      <div class="dhud-row3"><div class="dhud-shelf is-empty"></div>
        <span class="dhud-def"><span class="dhud-lbl">DEF</span><b class="dhud-defnum">–</b><span class="dhud-lbl">M.DEF</span><b class="dhud-mdefnum">–</b></span></div>
    </div>`;
  requestAnimationFrame(() => el.classList.add("dhud-appear"));
  const card = cardHandle(el, "plate");
  card.drawer = el.querySelector(".dhud-dbody");
  card.take = el.querySelector(".dhud-take");
  card.budget = el.querySelector(".dhud-take .face-tab");
  card.take.addEventListener("click", (ev) => { ev.stopPropagation(); pressTakeTurn(card); });
  card.take.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); pressTakeTurn(card); }
  });
  paintStats(card, actor);
  renderResources(card, actor);
  renderStatuses(card, actor);
  return card;
}

function updateCard(card, actor) {
  const hp = readHP(actor);
  if (hp) {
    const prev = Number(card.hpCur?.textContent?.replace(/,/g, "")) || 0;
    glideNumber(card.hpCur, prev, hp.v, 420);
    if (card.hpMax) card.hpMax.textContent = nice(hp.m);
    setHpBar(card, hp);
    flash(card.hpFill);
    const before = card.el.classList.contains("is-ko") ? "ko" : "";
    if (paintHpState(card, hp) !== before && card.kind === "plate") paintTake(card);
  }
  const mp = readMP(actor);
  if (mp) {
    const prev = Number(card.mpNum?.textContent?.replace(/,/g, "")) || 0;
    glideNumber(card.mpNum, prev, mp.v, 420);
    card.mpFill.style.width = pct(mp.v, mp.m);
    flash(card.mpFill);
  }
  const zp = readZP(actor);
  if (zp) {
    card.zpFill.style.width = pct(zp.v, zp.m);
    flash(card.zpFill);
    card.zpFill.classList.toggle("dhud-glow", zp.v >= zp.m);
  }
  const ip = readIP(actor);
  if (ip && card.ipRow) {
    card.ipRow.innerHTML = dotRow(ip.m, ip.v);
    if (card.kind === "card") card.ipRow.classList.toggle("is-many", ip.m > 8);
  }
  paintExtras(card, actor);
  paintCost(card);
}

// ── Cost preview ──────────────────────────────────────────────────────────────
// While a skill / spell / recipe row is focused in a picker, the plate marks
// what it would spend: a striped section at the end of the MP (or HP) bar,
// hollow IP pips. Red stripes when there isn't enough. See previewPlateCost.
let _costPreview = null;   // { actorId, mp, hp, ip }

function paintCost(card) {
  if (card.kind !== "plate") return;
  const actor = game.actors?.get(card.el.dataset.actorId);
  const c = _costPreview && _costPreview.actorId === card.el.dataset.actorId ? _costPreview : null;
  for (const [key, read] of [["mp", readMP], ["hp", readHP]]) {
    const el = card.el.querySelector(`.dhud-bar.dhud-${key} .dhud-cost`);
    if (!el) continue;
    const need = Number(c?.[key]) || 0;
    const r = actor ? read(actor) : null;
    if (!need || !r) { el.classList.remove("is-on"); continue; }
    const spend = Math.min(need, Math.max(0, r.v));
    el.style.left = pct(Math.max(0, r.v - spend), r.m);
    el.style.width = pct(Math.max(spend, r.m * 0.012), r.m);
    el.classList.toggle("is-short", need > r.v);
    el.classList.add("is-on");
  }
  const need = Number(c?.ip) || 0;
  const pips = card.ipRow ? [...card.ipRow.children] : [];
  const lit = pips.filter(p => p.classList.contains("on"));
  pips.forEach(p => p.classList.remove("is-cost"));
  if (need > 0) lit.slice(Math.max(0, lit.length - need)).forEach(p => p.classList.add("is-cost"));
}

/**
 * Show (or clear, with null) what a focused picker row would spend, on the
 * plate of `actorId` if this client shows one. Called by the skill and item
 * pickers through list-picker's onFocusRow.
 * @param {string|null} actorId
 * @param {{mp?: number, hp?: number, ip?: number}|null} cost
 */
export function previewPlateCost(actorId, cost) {
  const next = actorId && cost && (cost.mp || cost.hp || cost.ip) ? { actorId: String(actorId), ...cost } : null;
  if (!next && !_costPreview) return;
  _costPreview = next;
  for (const owner of byKey.values()) if (owner.plate) paintCost(owner.plate);
}

// ── Take Turn handle ──────────────────────────────────────────────────────────
// States, from the turn picker (armed) and the GM's turn status:
//   on      your side is choosing and your character can act → press / Enter
//   off     why not: "<Name> is acting" (with their face), "You've acted this
//           round", "Knocked out", "Enemies are acting", "Your turn"
//   open    the drawer is out → the handle is the "Turn Action" tab
function takeState(card) {
  const actorId = card.el.dataset.actorId;
  const actor = game.actors?.get(actorId);
  const ko = hpState(actor ? readHP(actor) : null) === "ko";
  if (_takeTurn && _takeTurn.actorId === actorId) return { on: true };
  if (ko) return { why: "Knocked out" };
  const st = _turnStatus;
  if (!st) return { why: "Waiting for the battle" };
  if (st.phase === "acting") {
    if (st.actorId === actorId) return { why: "Your turn", mine: true };
    if (st.side === "party") {
      const who = game.actors?.get(st.actorId);
      return { why: `${st.name || who?.name || "An ally"} is acting`, face: who?.img || st.img || "" };
    }
    return { why: "Enemies are acting" };
  }
  if (st.side !== "party") return { why: "Enemies are acting" };
  if ((st.eligibleActorIds ?? []).includes(actorId)) return { why: "Your side is choosing" };
  return { why: "You've acted this round" };
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 4l13 8-13 8z" fill="currentColor"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M7 11V8a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/></svg>';

function paintTake(card) {
  const take = card.take;
  if (!take) return;
  // The handle is for players. The GM sees it only on a previewed plate.
  card.el.classList.toggle("no-take", !!game.user?.isGM && !_previewPlateActorId);
  const s = takeState(card);
  const was = take.classList.contains("is-on");
  take.classList.toggle("is-on", !!s.on);
  take.classList.toggle("is-off", !s.on);
  take.setAttribute("aria-disabled", s.on ? "false" : "true");
  take.tabIndex = s.on ? 0 : -1;
  card.el.classList.toggle("can-take", !!s.on && !card.el.classList.contains("is-open"));
  const ico = take.querySelector(".ico");
  const icoHtml = s.on || s.mine ? ICON_PLAY : s.face ? `<img src="${esc(s.face)}" alt="">` : ICON_LOCK;
  if (ico._html !== icoHtml) { ico.innerHTML = icoHtml; ico._html = icoHtml; }
  take.querySelector(".why").textContent = s.on ? "" : (s.why ?? "");
  take.setAttribute("aria-label", s.on ? "Take Turn" : `Take Turn: ${s.why ?? ""}`);
  if (s.on && !was && !card.el.classList.contains("is-open")) {
    take.classList.remove("is-arrive");
    void take.offsetWidth;
    take.classList.add("is-arrive");
    clearTimeout(card._arriveT);
    card._arriveT = setTimeout(() => take.classList.remove("is-arrive"), 1500);
    try { playSfx(TAKE_READY_SFX, TAKE_READY_VOL); } catch { /* */ }
  }
}

function paintAllTakes() {
  for (const owner of byKey.values()) if (owner.plate) paintTake(owner.plate);
}

function pressTakeTurn(card) {
  const t = _takeTurn;
  if (!t || t.actorId !== card.el.dataset.actorId || card.el.classList.contains("is-open")) return;
  _takeTurn = null;
  paintTake(card);
  try { t.pick(); } catch (e) { warn("[DirectorHud] Take Turn pick threw", e); }
}

/**
 * Called by the turn picker when it opens. If one of the pickable combatants
 * is this client's plate actor, the plate's handle becomes its Take Turn
 * button (click / Enter → `pick(combatantId)`), and the caller drops that
 * combatant's pill. Returns { combatantId, release() } or null.
 * @param {Array<{combatantId: string, actorId: string|null}>} entries
 * @param {(combatantId: string) => void} pick
 */
export function armPlateTakeTurn(entries, pick) {
  let plate = null, entry = null;
  for (const owner of byKey.values()) {
    if (!owner.plate?.el?.isConnected) continue;
    const e = (entries ?? []).find(x => x?.actorId && x.actorId === owner.plate.el.dataset.actorId);
    if (e) { plate = owner.plate; entry = e; break; }
  }
  if (!plate || (game.user?.isGM && !_previewPlateActorId)) return null;
  const token = { actorId: entry.actorId, combatantId: entry.combatantId, pick: () => pick(entry.combatantId) };
  _takeTurn = token;
  paintAllTakes();
  return {
    combatantId: entry.combatantId,
    release() { if (_takeTurn === token) { _takeTurn = null; paintAllTakes(); } },
  };
}

// Enter takes the turn while the handle is armed — never while typing (chat,
// sheets) and never with a modifier, so it can't fire by accident.
function onTakeKey(e) {
  if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
  if (!_takeTurn) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
  for (const owner of byKey.values()) {
    const card = owner.plate;
    if (!card || card.el.dataset.actorId !== _takeTurn.actorId || !card.el.isConnected) continue;
    e.preventDefault();
    e.stopImmediatePropagation();
    pressTakeTurn(card);
    return;
  }
}

// Battle over: the next battle starts with no stale "Hina is acting".
function resetTurnState() {
  _turnStatus = null; _statusActingId = null; _takeTurn = null; _costPreview = null;
}

/** Apply a turn status (GM publish or socket). */
function applyTurnStatus(status) {
  _turnStatus = status && typeof status === "object" ? status : null;
  _statusActingId = _turnStatus?.phase === "acting" && _turnStatus.side === "party" ? (_turnStatus.actorId ?? null) : null;
  for (const owner of byKey.values()) paintActing(owner);
  paintAllTakes();
}

/**
 * GM: tell every client who is choosing or acting (TURN_START). Drives the
 * Take Turn handle's reasons and the acting card's frame on player screens.
 * @param {{phase: "picking"|"acting", side: string, eligibleActorIds?: string[], actorId?: string, name?: string, img?: string}|null} status
 */
export function publishTurnStatus(status) {
  if (!game.user?.isGM) return;
  applyTurnStatus(status);
  try { ensureSocket()?.executeForOthers(ACTION_TURN, { status: _turnStatus }); }
  catch (e) { warn("[DirectorHud] turn status broadcast failed", e); }
}

async function fetchTurnStatus() {
  if (game.user?.isGM) return;
  const socket = ensureSocket();
  if (!socket || !game.users?.activeGM) return;
  try {
    const status = await socket.executeAsGM(ACTION_TURN_GET);
    if (status !== undefined) applyTurnStatus(status);
  } catch (e) { warn("[DirectorHud] turn status fetch failed", e); }
}

// Whose plate this client shows: the user's assigned character if it is in the
// party, else a party actor this user EXPLICITLY owns. Explicit, because a
// default ownership grant (every user owns Zarg) would hand everyone the same
// plate. The GM gets none (unless previewing).
function plateActorId(entries) {
  const ids = entries.map(e => e.actor.id);
  if (game.user?.isGM) return ids.includes(_previewPlateActorId) ? _previewPlateActorId : null;
  const ch = game.user?.character?.id;
  if (ch && ids.includes(ch)) return ch;
  const uid = game.user?.id;
  return entries.find(e => (e.actor.ownership?.[uid] ?? 0) >= 3)?.actor.id ?? null;
}

// Is the element actually painted (not display:none / visibility:hidden /
// opacity 0, on itself or an ancestor)?
function isShown(el) {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
  }
  return true;
}

/**
 * Px to keep clear at the right screen edge: the sidebar plus whichever of the
 * floating right-edge buttons this client shows, plus a gap. Shared with
 * turn-ui.js so the plate and a standalone command window line up.
 */
export function rightEdgeReserve() {
  const vw = window.innerWidth;
  let reserve = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fu-sidebar-anchor-right")) || 0;
  for (const id of RIGHT_EDGE_BUTTON_IDS) {
    const el = document.getElementById(id);
    if (!el || !isShown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) reserve = Math.max(reserve, vw - r.left);
  }
  return Math.round(reserve + RIGHT_EDGE_GAP_PX);
}

// ── root scaling ──────────────────────────────────────────────────────────────
// 1 at 1080p, shrinking with the short screen side down to 0.75. Shared with
// turn-ui.js so a standalone command window matches the plate's size.
export function hudScale() {
  const vmin = Math.min(window.innerWidth, window.innerHeight);
  return clamp(vmin / 1080, 0.75, 1.15);
}
function scaleRoots(owner) {
  const s = hudScale().toFixed(4);
  owner.root.style.transform = `scale(${s})`;
  if (owner.plateRoot) owner.plateRoot.style.transform = `scale(${s})`;
}

// ── build / destroy by key ────────────────────────────────────────────────────
function buildLocally(key, entries) {
  destroyLocally(key);
  injectStyles();

  const root = document.createElement("div");
  root.className = "dhud-root";
  root.id = `dhud-root-${key}`;
  document.body.appendChild(root);

  const mine = plateActorId(entries);
  let plateRoot = null;
  if (mine) {
    plateRoot = document.createElement("div");
    plateRoot.className = "dhud-plate-root";
    plateRoot.id = `dhud-plate-${key}`;
    document.body.appendChild(plateRoot);
  }

  const offFns = [];
  const cards  = new Map();
  let plate = null;

  for (const { actor, token } of entries) {
    if (!actor) continue;
    const isMine = actor.id === mine;
    const card = isMine ? makePlate(actor, token) : makeCompactCard(actor, token);
    if (!card) continue;

    const setName = nm => { for (const n of card.nameEls) n.textContent = nm; };

    const h1 = Hooks.on("updateActor", (doc, diff) => {
      if (doc?.id !== actor.id) return;
      if (typeof diff?.name === "string") setName(diff.name);
      const live = game.actors?.get(actor.id);
      if (live) updateCard(card, live);
    });
    const h2 = Hooks.on("updateToken", (tok, chg) => {
      if (tok?.actor?.id !== actor.id) return;
      if (typeof chg?.name === "string") setName(chg.name || tok?.actor?.name);
      if (tok.actor) updateCard(card, tok.actor);
    });

    // Custom resources live on Active Effect charge flags, so they change via
    // the AE hooks (not updateActor). Re-render only the Clocks — kept off
    // updateCard so an HP tick doesn't flash them.
    const onAE = eff => {
      if (!effBelongsToActor(eff, actor.id)) return;
      const live = game.actors?.get(actor.id);
      if (!live) return;
      renderResources(card, live);
      renderStatuses(card, live);
    };
    const h3 = Hooks.on("createActiveEffect", onAE);
    const h4 = Hooks.on("updateActiveEffect", onAE);
    const h5 = Hooks.on("deleteActiveEffect", onAE);
    offFns.push(
      () => Hooks.off("updateActor", h1),
      () => Hooks.off("updateToken", h2),
      () => Hooks.off("createActiveEffect", h3),
      () => Hooks.off("updateActiveEffect", h4),
      () => Hooks.off("deleteActiveEffect", h5),
    );

    if (isMine) { plateRoot.appendChild(card.el); plate = card; }
    else root.appendChild(card.el);
    cards.set(actor.id, card);
  }

  const owner = { root, plateRoot, cards, plate, offFns };
  scaleRoots(owner);
  const onResize = () => scaleRoots(owner);
  window.addEventListener("resize", onResize);
  offFns.push(() => window.removeEventListener("resize", onResize));
  // Keep both rows on ONE bottom line and clear of the UI around them, which
  // moves on its own schedule: the right-edge buttons install late and the
  // sidebar collapses on the battle transition (plate's right edge); the
  // Players list grows with each login and, like the hotbar, is shown on some
  // clients and hidden on others (the baseline); the GM's dev-tools button sits
  // on top of the Players list (the card row's left edge).
  //
  // The plate does NOT follow a raised baseline: measured 2026-10-12, lifting
  // it onto a card row raised over the Players list put the open drawer into
  // the lowest party-side token (Kalina) at 1920x1080 and left 13 px at
  // 1600x900. Where nothing of Foundry's sits under the cards (player clients
  // in battle), both rows are on the same line anyway; the GM's standalone
  // command window has the height to spare, so it does follow the cards.
  let lastPos = "";
  const place = () => {
    const vh = window.innerHeight;
    const right = plateRoot ? rightEdgeReserve() : 0;
    const row = root.getBoundingClientRect();
    const rowLeft = 20, rowRight = rowLeft + Math.max(row.width, 1);
    let bottom = HUD_BASELINE_PX;
    for (const id of ["players", "hotbar"]) {
      const el = document.getElementById(id);
      // Present but faded out counts as absent: on player clients in battle the
      // list and hotbar keep their box while hidden, which raised the card row
      // 50 px above the plate for nothing.
      if (!el || !isShown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right <= rowLeft || r.left >= rowRight) continue;   // not under the row
      bottom = Math.max(bottom, Math.round(vh - r.top + 8));
    }
    const dev = document.getElementById("fud-devtools-btn")?.getBoundingClientRect();
    const rowTop = vh - bottom - Math.max(row.height, 1);
    const left = dev?.width > 0 && dev.bottom > rowTop && dev.top < vh - bottom ? Math.round(dev.right + 10) : rowLeft;
    const pos = `${right}|${bottom}|${left}`;
    if (pos === lastPos) return;
    lastPos = pos;
    if (plateRoot) plateRoot.style.right = `${right}px`;
    root.style.bottom = `${bottom}px`;
    root.style.left = `${left}px`;
  };
  place();
  const placeTimer = setInterval(place, 500);
  offFns.push(() => clearInterval(placeTimer));
  paintActing(owner);
  if (plate) {
    paintTake(plate);
    window.addEventListener("keydown", onTakeKey, true);
    offFns.push(() => window.removeEventListener("keydown", onTakeKey, true));
    // A client that (re)builds mid-battle asks the GM where the turn is.
    if (!_turnStatus) fetchTurnStatus();
  }

  byKey.set(key, owner);
  log(`[DirectorHud] built key=${key} cards=${cards.size} plate=${plate ? mine : "none"}`);
}

function destroyLocally(key) {
  const owner = byKey.get(key);
  if (!owner) {
    document.getElementById(`dhud-root-${key}`)?.remove();
    document.getElementById(`dhud-plate-${key}`)?.remove();
    return;
  }
  for (const fn of owner.offFns) { try { fn(); } catch { /* */ } }
  owner.offFns.length = 0;
  owner.root?.remove();
  owner.plateRoot?.remove();
  owner.cards.clear();
  byKey.delete(key);
  log(`[DirectorHud] destroyed key=${key}`);
}

// ── command drawer (used by turn-ui.js) ───────────────────────────────────────
/**
 * Open the battle command window as a drawer out of this client's plate, when
 * the acting actor IS the plate's actor. Returns null otherwise (no plate on
 * this client, e.g. the GM, or someone else's turn) and the caller places the
 * window on its own.
 *
 * @param {string} actorId     the acting actor
 * @param {object} opts
 * @param {HTMLElement} opts.el         the window root; moved INTO the drawer
 * @param {string} [opts.budgetText]    tab suffix ("Turn Action", "Free Action"…)
 * @returns {{ setHint(label: string|null): void, close(): void } | null}
 */
export function openPlateDrawer(actorId, { el, budgetText = "Turn Action" } = {}) {
  if (!actorId || !el) return null;
  let plate = null;
  for (const owner of byKey.values()) {
    if (owner.plate && owner.plate.el.dataset.actorId === actorId) { plate = owner.plate; break; }
  }
  if (!plate?.el?.isConnected) return null;
  clearTimeout(plate._closeT);
  if (plate._overlay) {
    // A reaction has the drawer: the window waits underneath and shows once
    // the reaction is answered (restoreUnder).
    plate._under = { nodes: [el], wasOpen: true, crumb: esc(budgetText ?? "Turn Action"), card: false };
  } else {
    plate.drawer.replaceChildren(el);
    plate.budget.textContent = budgetText ?? "Turn Action";
    plate._crumb = null;
    plate.el.classList.add("is-open");
    plate.el.classList.remove("is-react");
    setPlateCard(plateHostFor(plate), null);   // the commands show the portrait
    paintTake(plate);
  }
  const setHint = (label) => {
    plate.el.classList.toggle("hint-mp", label === "Spell");
    plate.el.classList.toggle("hint-ip", label === "Item");
  };
  return {
    setHint,
    setCrumb(label) { plate._crumb = label ? String(label) : null; },
    // Slides the drawer back in. The window stays in it (inert) until the
    // slide has finished, so the rows go back behind the plate rather than
    // vanishing first; a new window opening meanwhile simply replaces it.
    // While the turn HOLDS the drawer (a command was picked and its picker is
    // on the way), it stays open with the window inert until the next step
    // replaces it, so the drawer never slides shut between steps.
    close() {
      if (plate._under) plate._under.nodes = plate._under.nodes.filter((n) => n !== el);
      if (el.parentElement !== plate.drawer) return;
      el.inert = true;
      if (isHeld(plate)) return;
      if (plate.drawer.childElementCount > 1) { el.remove(); return; }
      plate.el.classList.remove("is-open");
      setHint(null);
      paintTake(plate);
      clearTimeout(plate._closeT);
      plate._closeT = setTimeout(() => {
        if (el.parentElement === plate.drawer && !plate.el.classList.contains("is-open")) el.remove();
      }, 320);
    },
  };
}

// ── drawer host: the steps after a command live in the drawer ─────────────────
// composeAction HOLDS the drawer for the whole command chain (pick a command →
// its list → targets), so it stays open between steps; drawer-views.js draws
// each step into it (plateDrawerHost). A player's picker that opens with no
// hold (a menu during the action's resolution) may open the drawer for its own
// lifetime (autoOpen). The GM docks only under an explicit hold, i.e. on a
// previewed plate while composing for that actor.
let _hold = null;   // { actorId, n }
function plateFor(actorId) {
  for (const owner of byKey.values()) {
    const p = owner.plate;
    if (p?.el?.isConnected && (!actorId || p.el.dataset.actorId === String(actorId))) return p;
  }
  return null;
}
function isHeld(plate) { return !!_hold && plate?.el?.dataset.actorId === _hold.actorId; }
// A reaction (or a step it led to) took the drawer over what was there; put
// that back, or close the drawer if nothing was.
function restoreUnder(plate) {
  const under = plate._under;
  plate._overlay = null;
  plate._under = null;
  plate.el.classList.remove("is-react");
  const nodes = (under?.nodes ?? []).filter((n) => !n.inert || isHeld(plate));
  if (nodes.length && (under.wasOpen || isHeld(plate))) {
    clearTimeout(plate._closeT);
    plate.drawer.replaceChildren(...nodes);
    plate.budget.innerHTML = under.crumb ?? "Turn Action";
    plate._crumb = under.crumbKey ?? null;
    if (!under.card) setPlateCard(plateHostFor(plate), null);
    plate.el.classList.add("is-open");
    paintTake(plate);
    return true;
  }
  return false;
}
function closeHeld(plate) {
  if (!plate?.el?.isConnected || !plate.el.classList.contains("is-open")) return;
  if (plate._overlay && restoreUnder(plate)) return;
  plate._overlay = null;
  plate._under = null;
  // A live command window still in the drawer closes itself (TurnUI cleanup).
  const live = [...plate.drawer.children].some((c) => !c.inert);
  if (live) return;
  plate.el.classList.remove("is-open", "is-react", "hint-mp", "hint-ip");
  setPlateCard(plateHostFor(plate), null);
  plate._crumb = null;
  paintTake(plate);
  clearTimeout(plate._closeT);
  plate._closeT = setTimeout(() => {
    if (!plate.el.classList.contains("is-open")) plate.drawer.replaceChildren();
  }, 320);
}
/** Keep this actor's drawer open until the returned release() runs. */
export function holdPlateDrawer(actorId) {
  const id = actorId ? String(actorId) : null;
  if (!id || !plateFor(id)) return () => {};
  _hold = _hold?.actorId === id ? { actorId: id, n: _hold.n + 1 } : { actorId: id, n: 1 };
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (_hold?.actorId !== id) return;
    if (--_hold.n > 0) return;
    _hold = null;
    // A short grace: a skill's menus often come one after another (Dread asks
    // "new or existing Phantasm", then "Weak or Shaken"); the drawer should not
    // slide shut and back out between them.
    setTimeout(() => { if (_hold?.actorId !== id) closeHeld(plateFor(id)); }, 600);
  };
}
function plateHostFor(plate) {
  const pcard = plate.el.querySelector(".dhud-pcard");
  const host = {
    actorId: plate.el.dataset.actorId,
    unit: plate.el,
    pcard,
    mount(node, { react = false } = {}) {
      clearTimeout(plate._closeT);
      // A step that follows a reaction (its target pick) becomes the overlay.
      if (plate._overlay) plate._overlay = node;
      plate.drawer.replaceChildren(node);
      plate.el.classList.add("is-open");
      plate.el.classList.toggle("is-react", !!react || !!plate._overlay);
      paintTake(plate);
    },
    // A reaction takes the drawer, open or not, over whatever is in it; the
    // returned unmount() hands it back (or slides it shut).
    mountOverlay(node) {
      clearTimeout(plate._closeT);
      if (!plate._overlay) {
        plate._under = {
          nodes: [...plate.drawer.children],
          wasOpen: plate.el.classList.contains("is-open"),
          crumb: plate.budget.innerHTML,
          crumbKey: plate._crumb,
          card: pcard?.classList.contains("is-skill") ?? false,
        };
      }
      plate._overlay = node;
      plate.drawer.replaceChildren(node);
      plate.el.classList.add("is-open", "is-react");
      paintTake(plate);
      return () => {
        if (plate._overlay !== node) return;
        if (restoreUnder(plate)) return;
        node.inert = true;
        if (isHeld(plate)) return;
        plate.el.classList.remove("is-open", "hint-mp", "hint-ip");
        setPlateCard(host, null);
        paintTake(plate);
        clearTimeout(plate._closeT);
        plate._closeT = setTimeout(() => {
          if (!plate.el.classList.contains("is-open")) plate.drawer.replaceChildren();
        }, 320);
      };
    },
    setCrumb(text) {
      plate._crumb = text ? String(text) : null;
      plate.budget.textContent = plate._crumb ?? "Turn Action";
    },
    // "Spell › Targets": the last list's crumb, then this step.
    pushCrumb(step) {
      const prev = plate._crumb && !/›/.test(plate._crumb) ? plate._crumb : (plate._crumb ?? "").split("›")[0].trim();
      plate.budget.innerHTML = prev ? `<span><span class="dhv-dimc">${esc(prev)} ›</span> ${esc(step)}</span>` : esc(step);
    },
    setCard(entry) { setPlateCard(host, entry); },
    setHint(kind) {
      plate.el.classList.toggle("hint-mp", kind === "mp");
      plate.el.classList.toggle("hint-ip", kind === "ip");
    },
    release: () => {},
  };
  return host;
}
/** The drawer of this actor's plate on this client (a reaction menu), or null. */
export function plateReactionHost(actorId) {
  const plate = actorId ? plateFor(actorId) : null;
  return plate ? plateHostFor(plate) : null;
}
/** The drawer to draw a picker into on this client, or null (use an overlay). */
export function plateDrawerHost({ autoOpen = false } = {}) {
  let plate = _hold ? plateFor(_hold.actorId) : null;
  let release = null;
  if (!plate && autoOpen && !game.user?.isGM) {
    plate = plateFor(null);
    if (plate) release = holdPlateDrawer(plate.el.dataset.actorId);
  }
  if (!plate) return null;
  const host = plateHostFor(plate);
  if (release) host.release = release;
  return host;
}

/**
 * Gold frame on the acting character's compact card (the GM's screen, where
 * every card is compact). Pass null to clear; `onlyIf` clears only when that
 * actor is still the one marked, so a late cleanup can't wipe a newer turn.
 */
export function setHudActing(actorId, { onlyIf } = {}) {
  if (onlyIf !== undefined && _actingActorId !== onlyIf) return;
  _actingActorId = actorId ?? null;
  for (const owner of byKey.values()) paintActing(owner);
}
function paintActing(owner) {
  const acting = _actingActorId ?? _statusActingId;
  for (const [id, card] of owner.cards) {
    if (card.kind === "card") card.el.classList.toggle("is-acting", id === acting);
  }
}

// ── retired chip tuning (API kept so an old macro does not throw) ─────────────
function getResCfg() {
  try { return JSON.parse(window.localStorage?.getItem(RES_CFG_KEY) || "{}"); } catch { return {}; }
}
function retiredResCfg() {
  warn("[DirectorHud] Clock chip tuning is retired — Clocks are now drawn inside the plate and party cards.");
  return getResCfg();
}

// ── socket ────────────────────────────────────────────────────────────────────
function ensureSocket() {
  if (_socket) return _socket;
  const sockMod = game.modules?.get("socketlib");
  if (!sockMod?.active || !window.socketlib) return null;

  const socket = window.socketlib.registerModule(MODULE_ID);

  socket.register(ACTION_BUILD, ({ key, actorIds } = {}) => {
    try {
      const entries = (actorIds ?? [])
        .map(id => ({ actor: game.actors?.get(id), token: null }))
        .filter(e => e.actor);
      buildLocally(key, entries);
    } catch (e) { warn("[DirectorHud] socket BUILD error:", e); }
  });

  socket.register(ACTION_DESTROY, ({ key } = {}) => {
    try { resetTurnState(); destroyLocally(key); }
    catch (e) { warn("[DirectorHud] socket DESTROY error:", e); }
  });

  socket.register(ACTION_TURN, ({ status } = {}) => {
    try { applyTurnStatus(status ?? null); }
    catch (e) { warn("[DirectorHud] socket TURN error:", e); }
  });
  socket.register(ACTION_TURN_GET, () => _turnStatus);

  _socket = socket;
  return _socket;
}

// ── reload gate ───────────────────────────────────────────────────────────────
function tryReloadRecovery(trigger) {
  const key      = canvas?.scene?.getFlag(MODULE_ID, FLAG_KEY);
  const actorIds = canvas?.scene?.getFlag(MODULE_ID, FLAG_ACTORS);
  if (!key || !actorIds?.length) return;
  if (byKey.has(key)) return;
  log(`[DirectorHud] reload-recovery (${trigger}): rebuilding key=${key}`);
  const entries = actorIds
    .map(id => ({ actor: game.actors?.get(id), token: null }))
    .filter(e => e.actor);
  if (entries.length) buildLocally(key, entries);
}

// GM preview: rebuild every open HUD on this client with a plate for actorId
// (null = back to all-compact). Local only; nothing is broadcast or saved.
function previewPlate(actorId = null) {
  _previewPlateActorId = actorId ? String(actorId) : null;
  for (const key of [...byKey.keys()]) {
    const actorIds = canvas?.scene?.getFlag(MODULE_ID, FLAG_ACTORS) ?? [...byKey.get(key).cards.keys()];
    const entries = actorIds.map(id => ({ actor: game.actors?.get(id), token: null })).filter(e => e.actor);
    buildLocally(key, entries);
  }
  return _previewPlateActorId;
}

// ── self-registration (runs on every client via side-effect import) ───────────
Hooks.once("ready", () => {
  ensureSocket();
  tryReloadRecovery("ready");

  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.directorHud = Object.freeze({
    previewPlate,
    // retired chip tuning — kept as harmless no-ops
    getResCfg, setResCfg: retiredResCfg, previewResCfg: () => {},
    getResScale: () => getResCfg().scale, setResScale: retiredResCfg, previewResScale: () => {},
  });
});
Hooks.on("canvasReady",    () => tryReloadRecovery("canvasReady"));
Hooks.on("canvasTearDown", () => {
  for (const key of byKey.keys()) destroyLocally(key);
});

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Does this actor get a resource card?
 *
 * The single definition of "party member" for the HUD, shared by all three
 * build sites (PREP, in-place reinforce, undying resume) so they cannot drift.
 *
 * Two ways to qualify:
 *
 *   1. The actor IS a DB roster member (`member_id_1..4`) — normal play.
 *   2. The actor is a SIM CLONE OF one. The automated-playtest harness clones
 *      the party so a run can never write to the real PCs, and a clone gets a
 *      brand-new actor id — so it matched nothing here and every sim ran with
 *      NO player HUD at all. It failed silently, because buildDirectorHud
 *      returns early on an empty list. `simSourceActorId` is stamped by
 *      cloneParty and points at the actor the clone stands in for.
 *
 * Guests, summons and scene allies still fall through both branches: a guest
 * clone's source is a roster actor, not a party member, so it is excluded here
 * exactly as it is in a real battle. That is the whole reason this is a
 * provenance check rather than a "skip the filter under SimMode" bypass —
 * the latter would hand cards to everything on the party side.
 *
 * @param {Actor} actor
 * @param {Set<string>} partyIds  from dbPartyActorIds(); empty = no filter
 */
export function isHudPartyMember(actor, partyIds) {
  if (!actor) return false;
  if (!partyIds || partyIds.size === 0) return true;   // DB failure → don't blank the HUD
  if (partyIds.has(actor.id)) return true;
  const src = actor.flags?.[MODULE_ID]?.simSourceActorId;
  return !!src && partyIds.has(String(src));
}

/**
 * The db-resolved party roster — actor ids from the game DB's member_id_1..4
 * (the same source the Battle Prompt resolves at PREP). This is what "party
 * member" means for the HUD: mid-battle resume paths (undying revive, WF
 * in-place reinforce) rebuild entries from dCombat's party SIDE, which also
 * carries summons and scene allies — filter those entries against this set so
 * the resource HUD only ever shows the actual party. Returns an empty Set on
 * DB failure; callers should treat empty as "no filter" rather than blank
 * the HUD.
 */
export async function dbPartyActorIds() {
  try {
    const result = await window.FUCompanion?.api?.getCurrentGameDb?.();
    const props = result?.db?.system?.props ?? {};
    const ids = new Set();
    for (let i = 1; i <= 4; i++) {
      const raw = String(props[`member_id_${i}`] ?? "").trim();
      if (raw) ids.add(raw.replace(/^Actor\./i, ""));
    }
    return ids;
  } catch (e) {
    warn("dbPartyActorIds: DB resolve failed — returning empty set", e);
    return new Set();
  }
}

/**
 * Build the player HUD on all clients and write reload-gate scene flags.
 * Call from the GM after entrance animations complete; fire-and-forget is safe.
 *
 * @param {Array<{actor: Actor, token: TokenDocument|null}>} entries  Party members.
 * @param {Scene} scene  The active battle scene (used for flag storage + key).
 */
export async function buildDirectorHud(entries, scene) {
  // An empty list is how this feature disappears WITHOUT an error: every caller
  // filters before calling, so a filter that matches nothing looks identical to
  // "no battle". That is exactly how the sim ran HUD-less and nobody noticed.
  if (!entries?.length) {
    warn("buildDirectorHud: called with no entries — every candidate was filtered out; no HUD will render");
    return;
  }
  if (!scene) return;
  const key      = `director-${scene.id}`;
  const valid    = entries.filter(e => e.actor);
  const actorIds = valid.map(e => e.actor.id);
  if (!actorIds.length) return;

  // Write flags before broadcasting so any client that reloads mid-broadcast
  // will find them on its next canvasReady.
  await Promise.all([
    scene.setFlag(MODULE_ID, FLAG_KEY,    key),
    scene.setFlag(MODULE_ID, FLAG_ACTORS, actorIds),
  ]);

  const socket = ensureSocket();
  if (socket) {
    // GM builds with full token refs (correct token names).
    // Other clients receive actorIds and resolve via game.actors.
    buildLocally(key, valid);
    socket.executeForOthers(ACTION_BUILD, { key, actorIds });
  } else {
    buildLocally(key, valid);
  }
}

/**
 * Destroy the player HUD on all clients and clear reload-gate scene flags.
 * Called from Stopped.onEnter.
 *
 * @param {Scene} scene  The active battle scene.
 */
export async function destroyDirectorHud(scene) {
  if (!scene) return;
  const key = scene.getFlag(MODULE_ID, FLAG_KEY) ?? `director-${scene.id}`;

  const socket = ensureSocket();
  if (socket) {
    await socket.executeForEveryone(ACTION_DESTROY, { key });
  } else {
    resetTurnState();
    destroyLocally(key);
  }

  await Promise.all([
    scene.unsetFlag(MODULE_ID, FLAG_KEY).catch(() => {}),
    scene.unsetFlag(MODULE_ID, FLAG_ACTORS).catch(() => {}),
  ]);
}
