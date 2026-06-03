// Director UI surface registry.
//
// A director-owned, queryable model of "what UI is on screen right now."
// Before this, the director's only notion of UI state was implicit — the FSM
// state (CONFIRM ⇒ an action card is up) plus a couple of ctx flags. Concrete
// surfaces (action card, pickers, menus, overlays) were spawned imperatively
// by their own modules and never tracked centrally, so nothing could answer
// "is a reaction menu open?" or "list everything currently displayed."
//
// This module fills that gap with near-zero coupling: a DOM MutationObserver
// auto-registers/unregisters each known surface as its root element enters or
// leaves the document. The picker/card modules are NOT modified — they keep
// appending their root to document.body exactly as before; we just watch for
// it. Two class-toggle overlays that persist in the DOM (round banner, crit
// cut-in) register explicitly from their own modules via registerSurface /
// registerAnimation, since the observer can't see an .active class flip.
//
// The registry is per-client: on the GM it reflects the GM's surfaces (the
// ones the director drives directly); on a player it reflects that player's
// mirrored surfaces. Each entry records which it is (`client`). Observers can
// subscribe to the `fu-director-surface-change` hook; the director exposes the
// query API at FUCompanion.api.experimental.battleDirector.surfaces.

import { log, warn } from "./logger.js";

// surfaceId -> { id, category, kind, client, spawnedAt, meta }
const _surfaces = new Map();
let _seq = 0;

const _client = () => (game.user?.isGM ? "gm" : "player");

function _emit(action, entry) {
  try {
    Hooks.callAll("fu-director-surface-change", {
      action,
      entry: entry ? { ...entry } : null,
      count: _surfaces.size,
    });
  } catch (_e) { /* never let an observer throw into a spawn/despawn path */ }
}

// ── public registration API ──────────────────────────────────────────────

// Register a surface. `id` is optional — supplied for DOM-bound surfaces (so
// the same element is idempotent) or auto-generated otherwise. Returns the id.
export function registerSurface({ id, kind = "unknown", category = "surface", meta = null } = {}) {
  const sid = id ?? `${kind}#${++_seq}`;
  const entry = { id: sid, category, kind, client: _client(), spawnedAt: Date.now(), meta };
  _surfaces.set(sid, entry);
  _emit("register", entry);
  return sid;
}

export function unregisterSurface(id) {
  if (!id) return false;
  const entry = _surfaces.get(id);
  if (!entry) return false;
  _surfaces.delete(id);
  _emit("unregister", entry);
  return true;
}

// Register a transient animation. Same store as surfaces (category:"animation")
// so getActiveSurfaces sees both. If `durationMs` is given it auto-unregisters
// after that window (a safety net; callers may also unregister explicitly).
export function registerAnimation({ id, kind = "anim", durationMs = 0, meta = null } = {}) {
  const sid = registerSurface({ id, kind, category: "animation", meta });
  const ms = Number(durationMs) || 0;
  if (ms > 0) {
    try { setTimeout(() => unregisterSurface(sid), ms + 50); } catch (_e) {}
  }
  return sid;
}

// ── public query API ───────────────────────────────────────────────────────

// All current entries, optionally filtered by category / kind / client.
export function getActiveSurfaces({ category, kind, client } = {}) {
  const out = [];
  for (const e of _surfaces.values()) {
    if (category && e.category !== category) continue;
    if (kind && e.kind !== kind) continue;
    if (client && e.client !== client) continue;
    out.push({ ...e });
  }
  return out;
}

export function hasSurface(kind) {
  for (const e of _surfaces.values()) if (e.kind === kind) return true;
  return false;
}

export function countSurfaces(kind) {
  let n = 0;
  for (const e of _surfaces.values()) if (!kind || e.kind === kind) n += 1;
  return n;
}

// Wipe the registry (battle end / preflight cleanup). The DOM observer also
// unregisters surfaces as their elements are removed, so this is belt-and-
// suspenders for anything torn down without a DOM removal we observed.
export function clearAllSurfaces() {
  const n = _surfaces.size;
  if (!n) return 0;
  _surfaces.clear();
  // Best-effort: drop the binding tag from any tracked elements so a later
  // re-add re-registers cleanly.
  try {
    for (const el of document.querySelectorAll?.("[data-fu-surface-id]") ?? []) {
      delete el.dataset.fuSurfaceId;
    }
  } catch (_e) {}
  _emit("clear", null);
  return n;
}

// ── DOM auto-binding ─────────────────────────────────────────────────────
//
// Each known surface's root element is a DIRECT child of document.body (every
// picker/card does `document.body.appendChild(root)`), so a childList observer
// on body — subtree:false — catches every spawn/despawn cheaply, without ever
// firing on the high-frequency attribute churn elsewhere in the app.

const SURFACE_DEFS = [
  { kind: "action-card",            test: (el) => el.id === "fud-battlefield-card-root" },
  { kind: "action-card-mirror",     test: (el) => el.id === "fud-bf-mirror-root" },
  { kind: "turn-picker",            test: (el) => typeof el.id === "string" && el.id.startsWith("fud-pickturn-") },
  { kind: "turn-ui",                test: (el) => typeof el.id === "string" && el.id.startsWith("fud-octopath-") },
  { kind: "weapon-mode-picker",     test: (el) => el.id === "fud-weapon-mode-picker-root" },
  { kind: "attribute-pair-picker",  test: (el) => el.id === "fud-attribute-pair-picker-root" },
  { kind: "skill-picker",           test: (el) => el.id === "fud-skill-picker-root" },
  { kind: "option-picker",          test: (el) => typeof el.id === "string" && el.id.startsWith("fud-option-picker-root") },
  { kind: "reaction-menu",          test: (el) => typeof el.id === "string" && el.id.startsWith("fud-react-menu-") },
  { kind: "passive-manager",        test: (el) => el.id === "fud-passive-mgr-root" },
  { kind: "target-picker",          test: (el) => !!el.classList?.contains?.("fud-target-banner") },
];

function _matchDef(el) {
  if (!el || el.nodeType !== 1) return null;
  for (const def of SURFACE_DEFS) {
    try { if (def.test(el)) return def; } catch (_e) {}
  }
  return null;
}

function _bindAdded(el) {
  const def = _matchDef(el);
  if (!def) return;
  if (el.dataset?.fuSurfaceId) return; // already tracked (defensive)
  const sid = registerSurface({ kind: def.kind, meta: { domId: el.id || null } });
  try { el.dataset.fuSurfaceId = sid; } catch (_e) { el.__fuSurfaceId = sid; }
}

function _bindRemoved(el) {
  if (el?.nodeType !== 1) return;
  const sid = el.dataset?.fuSurfaceId ?? el.__fuSurfaceId ?? null;
  if (!sid) return;
  unregisterSurface(sid);
  try { delete el.dataset.fuSurfaceId; } catch (_e) {}
  el.__fuSurfaceId = null;
}

let _observer = null;

// Install the DOM observer (idempotent). Call once at boot on every client.
export function initDirectorSurfaces() {
  try {
    if (_observer) return;
    if (!document.body) { warn("director-surfaces: no document.body yet"); return; }
    // Initial scan — catch any surface already present (e.g. a persistent
    // overlay) before the observer attaches.
    for (const el of Array.from(document.body.children)) _bindAdded(el);
    _observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) _bindAdded(n);
        for (const n of m.removedNodes) _bindRemoved(n);
      }
    });
    _observer.observe(document.body, { childList: true, subtree: false });
    log("director-surfaces: DOM observer installed");
  } catch (e) {
    warn("initDirectorSurfaces threw", e);
  }
}
