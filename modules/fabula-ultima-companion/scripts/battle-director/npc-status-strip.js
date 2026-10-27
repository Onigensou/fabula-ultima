// npc-status-strip.js — Format A: a status strip under the feet of every actor
// that has no HUD card (NPCs, monsters, allied guests), during a battle.
//
// Token status plan "G + E" (approved 2026-10-27, mockup
// claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX):
//   - debuffs first (red frame), then buffs (green frame), turns numeral
//   - at most 4 tiles; a fifth status turns the last slot into "+N"
//   - Ready abilities as a gold square chip at the end
//   - markers never show on an NPC
//   - hover a tile for its tooltip (status-tip.js); hover the token for the
//     Battle Inspect peek card (unit-inspect), which already has the full list
// It replaces the core token effect icons for NPCs in battle (battle-focus.js).
//
// Per client, read-only: built from the actor's effects on every client, no
// socket, no document writes. DOM overlay kept on the token's feet by one
// canvas ticker, like the passive card.

import { log, warn } from "./logger.js";
import { TIER, isNpcActor } from "./status-classifier.js";
import { rowTier, rowTurns, rowSpent, sortRows, statusTipHTML, foldTipHTML, ensureTipStyles } from "./status-tip.js";
import { battleActive } from "./battle-focus.js";

const ROOT_ID = "fu-npc-strip-root";
const STYLE_ID = "fu-npc-strip-style";
const MAX_TILES = 4;
const FEET_GAP_PX = 2;            // below the token's bottom edge, clear of the NPC HP bar (offsetY −12)

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = { strips: new Map(), ticker: null };   // tokenId -> { el, sig }

// Party Menu rows, loaded lazily (same reason as the HUD: a static import pulls
// the Party Menu graph into every importer).
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
.fu-nst { position: absolute; left: 0; top: 0; display: flex; gap: 3px; align-items: center; transform-origin: 50% 0; pointer-events: none; will-change: transform; }
.fu-nst-t { position: relative; flex: none; width: 22px; height: 22px; box-sizing: border-box; border-radius: 5px; pointer-events: auto;
  border: 1.5px solid var(--ac, #8a8a8a); background: #0d0b09; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
.fu-nst-t img { display: block; width: 100%; height: 100%; border: none !important; border-radius: 3.5px; object-fit: cover; }
.fu-nst-t b { position: absolute; right: -2px; bottom: -2px; min-width: 11px; height: 11px; padding: 0 2px; box-sizing: border-box;
  border-radius: 4px 0 3px 0; background: #000; color: #fff; font: 700 8px/11px "Signika", sans-serif; text-align: center; pointer-events: none; }
.fu-nst-t.t-debuff { --ac: #e05050; }
.fu-nst-t.t-buff { --ac: #3fb67c; }
.fu-nst-t.is-more { display: grid; place-items: center; width: auto; min-width: 22px; padding: 0 4px; color: #eee;
  font: 700 10px "Signika", sans-serif; border-style: dashed; --ac: #bbb; }
.fu-nst-t.is-ready { --ac: #e2b34a; border-width: 2px; box-shadow: 0 0 0 1px rgba(255,236,170,.5) inset, 0 0 7px rgba(226,179,74,.8); }
.fu-nst-t.is-ready::after { content: ""; position: absolute; right: -4px; top: -4px; width: 7px; height: 7px; border-radius: 50%; background: #ffd45a; box-shadow: 0 0 4px #ffb800; }
.fu-nst-t.is-spent { --ac: rgba(122,106,85,.6); box-shadow: none; filter: grayscale(1); opacity: .5; }
.fu-nst-t.is-spent::after { display: none; }
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

const stKey = (r) => esc(String(r.name ?? "").trim().toLowerCase());

function stripHTML(rows) {
  const status = rows.filter((r) => r.tier !== TIER.READY);
  const ready = rows.filter((r) => r.tier === TIER.READY);
  const room = status.length > MAX_TILES ? MAX_TILES - 1 : status.length;
  const tile = (r) => `<span class="fu-nst-t t-${r.tier}" data-st="${stKey(r)}" data-tooltip="${esc(statusTipHTML(r, { tier: r.tier }))}" data-tooltip-direction="UP">`
    + `<img src="${esc(r.img)}" alt="">${rowTurns(r) ? `<b>${rowTurns(r)}</b>` : ""}</span>`;
  const rest = status.slice(room);
  return status.slice(0, room).map(tile).join("")
    + (rest.length ? `<span class="fu-nst-t is-more" data-tooltip="${esc(foldTipHTML(rest))}" data-tooltip-direction="UP">+${rest.length}</span>` : "")
    + ready.map((r) => `<span class="fu-nst-t is-ready${rowSpent(r) ? " is-spent" : ""}" data-st="${stKey(r)}" data-tooltip="${esc(statusTipHTML(r, { tier: TIER.READY }))}" data-tooltip-direction="UP"><img src="${esc(r.img)}" alt=""></span>`).join("");
}

function wants(token) {
  return !!(battleActive() && token?.actor && !token.destroyed && isNpcActor(token.actor));
}

function drop(tokenId) {
  const s = S.strips.get(tokenId);
  if (s) { s.el.remove(); S.strips.delete(tokenId); }
}

/** (Re)build one token's strip. */
export function renderStrip(token) {
  if (!token) return;
  if (!wants(token)) { drop(token.id); return; }
  if (!_rowsOf) { loadRows().then(() => { if (_rowsOf) renderStrip(token); }); return; }
  let rows = [];
  try { rows = stripRows(token.actor); } catch (e) { warn("[NpcStrip] rows failed", e); }
  if (!rows.length) { drop(token.id); return; }
  const html = stripHTML(rows);
  let s = S.strips.get(token.id);
  if (!s) {
    const el = document.createElement("div");
    el.className = "fu-nst";
    ensureRoot().appendChild(el);
    s = { el, sig: "" };
    S.strips.set(token.id, s);
  }
  if (s.sig !== html) {
    s.el.innerHTML = html; s.sig = html;
    // New since the last render → flash once (not on the first render).
    const keys = new Set(rows.map((r) => `${r.key}:${rowSpent(r)}`));
    if (s.keys) rows.forEach((r) => { if (!s.keys.has(`${r.key}:${rowSpent(r)}`)) s.el.querySelectorAll(`[data-st="${stKey(r)}"]`).forEach(flashEl); });
    s.keys = keys;
  }
  place(token, s);
}

function flashEl(el) { el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash"); }

// "fuStatusFlash" (status-pop.js): a Burn tick, a Ready spent → flash that tile.
function onStatusFlash({ tokenUuid = null, actorId = null, name = "" } = {}) {
  if (!name) return;
  for (const [id, s] of S.strips) {
    const t = canvas?.tokens?.get(id);
    if (!t) continue;
    if (tokenUuid ? t.document?.uuid !== tokenUuid : t.actor?.id !== actorId) continue;
    s.el.querySelectorAll(`[data-st="${CSS.escape(name)}"]`).forEach(flashEl);
  }
}

export function renderAll() {
  ensureStyles(); ensureTipStyles();
  const live = new Set();
  for (const t of canvas?.tokens?.placeables ?? []) { live.add(t.id); renderStrip(t); }
  for (const id of [...S.strips.keys()]) if (!live.has(id)) drop(id);
}

export function clearAll() { for (const id of [...S.strips.keys()]) drop(id); }

// Feet of the token, in screen px; hidden while the token is (spawn / KO fade / hidden).
function place(token, s) {
  const view = canvas?.app?.view;
  if (!view || token.destroyed) return;
  const shown = token.visible && token.renderable !== false && (token.mesh?.alpha ?? 1) > 0.05 && (token.mesh?.worldAlpha ?? 1) > 0.05;
  if (!shown) { if (s.el.style.display !== "none") s.el.style.display = "none"; return; }
  if (s.el.style.display === "none") s.el.style.display = "";
  const rect = view.getBoundingClientRect();
  const pt = token.toGlobal(new PIXI.Point(token.w / 2, token.h));
  const zoom = Math.min(1.25, Math.max(0.7, canvas.stage?.scale?.x ?? 1));
  s.el.style.transform = `translate(${Math.round(rect.left + pt.x)}px, ${Math.round(rect.top + pt.y + FEET_GAP_PX)}px) translateX(-50%) scale(${zoom.toFixed(3)})`;
}

function tick() {
  if (!S.strips.size) return;
  for (const [id, s] of S.strips) {
    const t = canvas?.tokens?.get(id);
    if (!t) { drop(id); continue; }
    place(t, s);
  }
}

function tokensOfEffect(eff) {
  const p = eff?.parent;
  const actor = p?.documentName === "Actor" ? p : p?.parent?.documentName === "Actor" ? p.parent : null;
  if (!actor) return [];
  try { return actor.getActiveTokens(false, false) ?? []; } catch { return []; }
}

export function initNpcStatusStrip() {
  const onAE = (eff) => { for (const t of tokensOfEffect(eff)) renderStrip(t); };
  Hooks.on("createActiveEffect", onAE);
  Hooks.on("updateActiveEffect", onAE);
  Hooks.on("deleteActiveEffect", onAE);
  Hooks.on("updateActor", (actor) => { for (const t of actor?.getActiveTokens?.(false, false) ?? []) renderStrip(t); });
  Hooks.on("createToken", (doc) => setTimeout(() => renderStrip(doc?.object), 0));
  Hooks.on("updateToken", (doc) => renderStrip(doc?.object));
  Hooks.on("deleteToken", (doc) => drop(doc?.id));
  Hooks.on("canvasTearDown", () => clearAll());
  Hooks.on("canvasReady", () => {
    if (S.ticker) { try { canvas.app.ticker.remove(S.ticker); } catch { /* */ } }
    S.ticker = tick;
    canvas.app.ticker.add(S.ticker);
    renderAll();
  });
  Hooks.on("fuBattleFocusChanged", () => renderAll());
  Hooks.on("fuStatusFlash", onStatusFlash);
  if (canvas?.ready) { S.ticker = tick; canvas.app.ticker.add(S.ticker); renderAll(); }
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.npcStatusStrip = { renderAll, clearAll, count: () => S.strips.size };
  log("[NpcStrip] ready");
}
