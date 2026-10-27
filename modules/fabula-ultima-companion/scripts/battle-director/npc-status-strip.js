// npc-status-strip.js — the unit label under the feet of every actor that has
// no HUD card (NPCs, monsters, allied guests, summons), during a battle.
//
// Token status plan "G + E" (approved 2026-10-27, mockup
// claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX). One block per unit, Octopath
// order, docked to the RENDERED sprite's feet (unit-anchors.js):
//
//   [shield][debuffs…][buffs…][Ready]     status strip (wraps past 6 tiles)
//            Goblin Bandit A               name (replaces Foundry's nameplate)
//
//   - EVERY buff and debuff shows, never folded (user rule 2026-10-27: a
//     turn-based battle is a planning game; every modifier that can change the
//     outcome stays visible). Markers never show on an NPC.
//   - Shield (system.props.shield_value > 0) is our own tile with its number
//     and type, replacing Bar Brawl's shield bar (hidden in battle, battle-focus.js).
//   - Names: on by default; key N toggles them per client (core keybinding,
//     editable in Configure Controls); targeting forces them on
//     (fud.actionPickerOpen / fud.actionPickerClose).
//   - Stacked units: front units (lower on screen) keep their spot; a label
//     further back that would overlap one already placed lifts just above it.
//     A label sitting over a unit standing in front dims until either unit is
//     hovered, targeted or controlled.
//   - Tooltips from status-tip.js; hovering the token still opens the Battle
//     Inspect peek card (unit-inspect) with the full sheet.
//
// Per client, read-only: built from the actor on every client, no socket, no
// document writes. One canvas ticker places every block each frame.

import { log, warn } from "./logger.js";
import { TIER, isNpcActor } from "./status-classifier.js";
import { rowTier, rowTurns, rowSpent, sortRows, statusTipHTML, foldTipHTML, ensureTipStyles } from "./status-tip.js";
import { battleActive } from "./battle-focus.js";
import { feetPoint, spriteRect } from "./unit-anchors.js";

const NS = "fabula-ultima-companion";
const ROOT_ID = "fu-npc-strip-root";
const STYLE_ID = "fu-npc-strip-style";
const TILES_PER_ROW = 6;          // wraps beyond this; nothing is ever folded away
const FEET_GAP_PX = 2;            // below the sprite's feet; the NPC HP bar sits above, on the ground shadow
const NAMES_SETTING = "npcNamesShown";
const DIM_OPACITY = 0.5;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const stKey = (r) => esc(String(r.name ?? "").trim().toLowerCase());

const S = { blocks: new Map(), ticker: null, forceNames: false, hover: null };   // tokenId -> { el, sig, keys }

// ── settings + key (registered at init: keybindings must be) ────────────────
Hooks.once("init", () => {
  try {
    game.settings.register(NS, NAMES_SETTING, {
      name: "Show enemy names in battle", scope: "client", config: false, type: Boolean, default: true,
      onChange: () => renderAll(),
    });
    game.keybindings.register(NS, "toggleNpcNames", {
      name: "Toggle enemy names (battle)",
      hint: "Show or hide the names under enemies and other NPCs during a battle. Targeting always shows them.",
      editable: [{ key: "KeyN" }],
      onDown: () => {
        if (!battleActive()) return false;
        const t = document.activeElement;
        if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName ?? ""))) return false;
        game.settings.set(NS, NAMES_SETTING, !namesSetting());
        return true;
      },
    });
  } catch (e) { warn("[NpcStrip] settings/keybinding registration failed", e); }
});

function namesSetting() { try { return game.settings.get(NS, NAMES_SETTING) !== false; } catch { return true; } }
function namesOn() { return S.forceNames || namesSetting(); }

// Party Menu rows, loaded lazily (same reason as the HUD).
let _rowsOf = null, _rowsLoad = null;
function loadRows() {
  _rowsLoad ??= import("../party-menu/party-menu-effects.js")
    .then((m) => { _rowsOf = m.effectRowsOf; })
    .catch((e) => warn("[NpcStrip] Party Menu effects unavailable", e));
  return _rowsLoad;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#${ROOT_ID} { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: var(--z-index-canvas, 0); }
.fu-nlab { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; gap: 2px;
  transform-origin: 50% 0; pointer-events: none; will-change: transform, opacity; transition: opacity 180ms ease; }
.fu-nlab.is-dim { opacity: ${DIM_OPACITY}; }
.fu-nst { display: flex; flex-wrap: wrap; justify-content: center; gap: 3px; align-items: center; max-width: ${TILES_PER_ROW * 25}px; }
.fu-nst:empty { display: none; }
.fu-nname { font: 600 15px "Signika", sans-serif; color: #fff; letter-spacing: .03em; white-space: nowrap; line-height: 1.1;
  -webkit-text-stroke: 2px rgba(14,10,8,.92); paint-order: stroke fill;
  text-shadow: 0 0 1px #000, 0 1px 2px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.6); }
.fu-nst-t { position: relative; flex: none; width: 22px; height: 22px; box-sizing: border-box; border-radius: 5px; pointer-events: auto;
  border: 1.5px solid var(--ac, #8a8a8a); background: #0d0b09; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
.fu-nst-t img { display: block; width: 100%; height: 100%; max-width: none; border: none !important; border-radius: 3.5px; object-fit: cover; }
.fu-nst-t b { position: absolute; right: -2px; bottom: -2px; min-width: 11px; height: 11px; padding: 0 2px; box-sizing: border-box;
  border-radius: 4px 0 3px 0; background: #000; color: #fff; font: 700 8px/11px "Signika", sans-serif; text-align: center; pointer-events: none; }
.fu-nst-t.t-debuff { --ac: #e05050; }
.fu-nst-t.t-buff { --ac: #3fb67c; }
.fu-nst-t.is-ready { --ac: #e2b34a; border-width: 2px; box-shadow: 0 0 0 1px rgba(255,236,170,.5) inset, 0 0 7px rgba(226,179,74,.8); }
.fu-nst-t.is-ready::after { content: ""; position: absolute; right: -4px; top: -4px; width: 7px; height: 7px; border-radius: 50%; background: #ffd45a; box-shadow: 0 0 4px #ffb800; }
.fu-nst-t.is-spent { --ac: rgba(122,106,85,.6); box-shadow: none; filter: grayscale(1); opacity: .5; }
.fu-nst-t.is-spent::after { display: none; }
.fu-nst-t.is-shield { width: auto; min-width: 22px; padding: 0 5px 0 3px; display: inline-flex; align-items: center; gap: 2px;
  --ac: #cfe3ff; background: linear-gradient(180deg, #2a3a52, #141c28); color: #eef5ff; font: 800 11px "Signika", sans-serif; }
.fu-nst-t.is-shield.is-magic { --ac: #e2c8ff; background: linear-gradient(180deg, #3e2a56, #1c1428); }
.fu-nst-t.is-shield svg { width: 13px; height: 13px; flex: none; }
.fu-nst-t.is-flash { animation: fuNstFlash .9s ease-out; }
@keyframes fuNstFlash { 0% { box-shadow: 0 0 0 0 rgba(255,196,70,1); } 100% { box-shadow: 0 0 0 10px rgba(255,196,70,0); } }
`;
  document.head.appendChild(st);
}

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) { root = document.createElement("div"); root.id = ROOT_ID; document.body.appendChild(root); }
  return root;
}

/** Rows the strip shows for one actor: debuffs, buffs, Ready (no markers, no gear passives). */
function stripRows(actor) {
  return sortRows(_rowsOf(actor)
    .filter((r) => !r.inactive && r.lifetime?.kind !== "item")
    .map((r) => Object.assign(r, { tier: rowTier(r) }))
    .filter((r) => r.tier === TIER.DEBUFF || r.tier === TIER.BUFF || r.tier === TIER.READY));
}

const SHIELD_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2 2.6 3.1v4.1c0 3.4 2.3 6 5.4 7.6 3.1-1.6 5.4-4.2 5.4-7.6V3.1z" fill="currentColor" opacity=".9"/><path d="M8 3 4.3 4.3v2.9c0 2.3 1.5 4.2 3.7 5.5z" fill="#fff" opacity=".35"/></svg>`;

function shieldHTML(actor) {
  const p = actor?.system?.props ?? {};
  const v = Math.round(Number(p.shield_value) || 0);
  if (v <= 0) return "";
  const type = String(p.shield_type ?? "").trim();
  const magic = /magic/i.test(type);
  const tip = `<div class="fu-st-tip t-buff"><div class="th fold"><div><strong>Shield ${v}</strong><small>${esc(type || "Shield")}</small></div></div>`
    + `<div class="tb"><div class="desc">Absorbs ${magic ? "magical" : "incoming"} damage before Hit Points are lost.</div></div></div>`;
  return `<span class="fu-nst-t is-shield${magic ? " is-magic" : ""}" data-st="shield" data-tooltip="${esc(tip)}" data-tooltip-direction="UP">${SHIELD_SVG}${v}</span>`;
}

function stripHTML(actor, rows) {
  const status = rows.filter((r) => r.tier !== TIER.READY);
  const ready = rows.filter((r) => r.tier === TIER.READY);
  const tile = (r) => `<span class="fu-nst-t t-${r.tier}" data-st="${stKey(r)}" data-tooltip="${esc(statusTipHTML(r, { tier: r.tier }))}" data-tooltip-direction="UP">`
    + `<img src="${esc(r.img)}" alt="">${rowTurns(r) ? `<b>${rowTurns(r)}</b>` : ""}</span>`;
  return shieldHTML(actor)
    + status.map(tile).join("")
    + ready.map((r) => `<span class="fu-nst-t is-ready${rowSpent(r) ? " is-spent" : ""}" data-st="${stKey(r)}" data-tooltip="${esc(statusTipHTML(r, { tier: TIER.READY }))}" data-tooltip-direction="UP"><img src="${esc(r.img)}" alt=""></span>`).join("");
}

function wants(token) {
  return !!(battleActive() && token?.actor && !token.destroyed && isNpcActor(token.actor));
}

function drop(tokenId) {
  const s = S.blocks.get(tokenId);
  if (s) { s.el.remove(); S.blocks.delete(tokenId); }
}

/** (Re)build one token's label block. */
export function renderStrip(token) {
  if (!token) return;
  if (!wants(token)) { drop(token.id); return; }
  if (!_rowsOf) { loadRows().then(() => { if (_rowsOf) renderStrip(token); }); return; }
  let rows = [];
  try { rows = stripRows(token.actor); } catch (e) { warn("[NpcStrip] rows failed", e); }
  const strip = stripHTML(token.actor, rows);
  const name = namesOn() ? `<div class="fu-nname">${esc(token.document?.name ?? token.name ?? "")}</div>` : "";
  if (!strip && !name) { drop(token.id); return; }
  const html = `<div class="fu-nst">${strip}</div>${name}`;
  let s = S.blocks.get(token.id);
  if (!s) {
    const el = document.createElement("div");
    el.className = "fu-nlab";
    ensureRoot().appendChild(el);
    s = { el, sig: "", keys: null };
    S.blocks.set(token.id, s);
  }
  if (s.sig !== html) {
    s.el.innerHTML = html; s.sig = html;
    // New since the last render → flash once (not on the first render).
    const keys = new Set(rows.map((r) => `${r.key}:${rowSpent(r)}`));
    if (s.keys) rows.forEach((r) => { if (!s.keys.has(`${r.key}:${rowSpent(r)}`)) s.el.querySelectorAll(`[data-st="${stKey(r)}"]`).forEach(flashEl); });
    s.keys = keys;
  }
  layout();
}

export function renderAll() {
  ensureStyles(); ensureTipStyles();
  const live = new Set();
  for (const t of canvas?.tokens?.placeables ?? []) { live.add(t.id); renderStrip(t); }
  for (const id of [...S.blocks.keys()]) if (!live.has(id)) drop(id);
}

export function clearAll() { for (const id of [...S.blocks.keys()]) drop(id); }

// Live tuning (per client, remembered in localStorage):
//   FUCompanion.api.npcStatusStrip.tune({ dy: 2, scale: 1 })
const TUNE_KEY = "fu-npc-strip-tune";
const TUNE = { dy: FEET_GAP_PX, scale: 1 };
try { const saved = JSON.parse(localStorage.getItem(TUNE_KEY) ?? "{}"); for (const k of ["dy", "scale"]) if (Number.isFinite(Number(saved[k]))) TUNE[k] = Number(saved[k]); } catch { /* */ }
export function tune(patch = null) {
  if (patch && typeof patch === "object") {
    for (const k of ["dy", "scale"]) if (Number.isFinite(Number(patch[k]))) TUNE[k] = Number(patch[k]);
    try { localStorage.setItem(TUNE_KEY, JSON.stringify(TUNE)); } catch { /* */ }
    layout();
  }
  return { ...TUNE };
}

function shown(token) {
  return token.visible && token.renderable !== false && (token.mesh?.alpha ?? 1) > 0.05 && (token.mesh?.worldAlpha ?? 1) > 0.05;
}

// Place every block under its sprite's feet, then resolve overlaps: front
// units (feet lower on screen) first; a block further back that would overlap
// one already placed lifts just above it. Then dim any block sitting over a
// unit that stands in front of it.
function layout() {
  if (!S.blocks.size) return;
  const zoom = Math.min(1.25, Math.max(0.7, canvas?.stage?.scale?.x ?? 1)) * TUNE.scale;
  const items = [];
  for (const [id, s] of S.blocks) {
    const t = canvas?.tokens?.get(id);
    if (!t) { drop(id); continue; }
    if (!shown(t)) { if (s.el.style.display !== "none") s.el.style.display = "none"; continue; }
    if (s.el.style.display === "none") s.el.style.display = "";
    const f = feetPoint(t);
    if (!f) continue;
    const w = s.el.offsetWidth * zoom, h = s.el.offsetHeight * zoom;
    items.push({ id, t, s, fx: f.x, fy: f.y, w, h });
  }
  items.sort((a, b) => b.fy - a.fy);
  const placed = [];
  for (const it of items) {
    const x = it.fx - it.w / 2;
    let y = it.fy + TUNE.dy;
    for (let guard = 0; guard < 6; guard++) {
      const hit = placed.find((p) => x < p.x + p.w && x + it.w > p.x && y < p.y + p.h && y + it.h > p.y);
      if (!hit) break;
      y = hit.y - it.h - 3;
    }
    placed.push({ x, y, w: it.w, h: it.h, id: it.id });
    it.s.el.style.transform = `translate(${Math.round(it.fx)}px, ${Math.round(y)}px) translateX(-50%) scale(${zoom.toFixed(3)})`;
    it.y = y;
  }
  // Dim over a front unit, unless this unit or that one is in focus.
  const focused = (t) => !!t && (t.id === S.hover || t.controlled || t.isTargeted);
  for (const it of items) {
    let dim = false;
    if (!focused(it.t)) {
      for (const o of canvas.tokens.placeables) {
        if (o.id === it.id || !shown(o)) continue;
        const r = spriteRect(o);
        if (!r || r.bottom <= it.fy + 1) continue;            // only units standing in front
        const x = it.fx - it.w / 2;
        if (x < r.left + r.width && x + it.w > r.left && it.y < r.bottom - 6 && it.y + it.h > r.top) {
          if (!focused(o)) { dim = true; break; }
        }
      }
    }
    it.s.el.classList.toggle("is-dim", dim);
  }
}

function flashEl(el) { el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash"); }

// "fuStatusFlash" (status-pop.js): a Burn tick, a Ready spent → flash that tile.
function onStatusFlash({ tokenUuid = null, actorId = null, name = "" } = {}) {
  if (!name) return;
  for (const [id, s] of S.blocks) {
    const t = canvas?.tokens?.get(id);
    if (!t) continue;
    if (tokenUuid ? t.document?.uuid !== tokenUuid : t.actor?.id !== actorId) continue;
    s.el.querySelectorAll(`[data-st="${CSS.escape(name)}"]`).forEach(flashEl);
  }
}

function tokensOfEffect(eff) {
  const p = eff?.parent;
  const actor = p?.documentName === "Actor" ? p : p?.parent?.documentName === "Actor" ? p.parent : null;
  if (!actor) return [];
  try { return actor.getActiveTokens(false, false) ?? []; } catch { return []; }
}

function startTicker() {
  if (S.ticker) { try { canvas.app.ticker.remove(S.ticker); } catch { /* */ } }
  S.ticker = layout;
  canvas.app.ticker.add(S.ticker);
}

export function initNpcStatusStrip() {
  const onAE = (eff) => { for (const t of tokensOfEffect(eff)) renderStrip(t); };
  Hooks.on("createActiveEffect", onAE);
  Hooks.on("updateActiveEffect", onAE);
  Hooks.on("deleteActiveEffect", onAE);
  Hooks.on("updateActor", (actor) => { for (const t of actor?.getActiveTokens?.(false, false) ?? []) renderStrip(t); });
  Hooks.on("createToken", (doc) => setTimeout(() => renderStrip(doc?.object), 0));
  Hooks.on("updateToken", (doc, change) => { if ("name" in (change ?? {}) || "hidden" in (change ?? {}) || "actorData" in (change ?? {}) || "delta" in (change ?? {})) renderStrip(doc?.object); });
  Hooks.on("deleteToken", (doc) => drop(doc?.id));
  Hooks.on("hoverToken", (token, hovered) => { S.hover = hovered ? token?.id : (S.hover === token?.id ? null : S.hover); });
  Hooks.on("canvasTearDown", () => clearAll());
  Hooks.on("canvasReady", () => { startTicker(); renderAll(); });
  Hooks.on("fuBattleFocusChanged", () => renderAll());
  Hooks.on("fuStatusFlash", onStatusFlash);
  // Targeting always shows names, whatever the toggle says.
  Hooks.on("fud.actionPickerOpen", () => { S.forceNames = true; renderAll(); });
  Hooks.on("fud.actionPickerClose", () => { S.forceNames = false; renderAll(); });
  if (canvas?.ready) { startTicker(); renderAll(); }
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.npcStatusStrip = {
    renderAll, clearAll, tune, count: () => S.blocks.size,
    namesShown: () => namesOn(), setNames: (on) => game.settings.set(NS, NAMES_SETTING, !!on),
  };
  log("[NpcStrip] ready");
}
