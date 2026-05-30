// Token-anchored applied chip — Rule 1 stage 3.
//
// Brief, auto-dismissing badge that floats above a reactor's token when
// their reaction APPLIES. Visible to every client (GM + all players)
// so the whole table sees "Alice just used Counterattack" without
// digging through chat logs.
//
// Visibility ladder (see [[reaction-architecture]] Rule 1):
//   Stage 1 — Candidates enumerated: GM only.
//   Stage 2 — Decision pending: owner sees actionable menu, others
//             see dimmed indicator ([[reaction-indicator]]).
//   Stage 3 — Decision applied: this chip, visible to ALL.
//   Stage 4 — Effect resolves: natural Foundry hooks.
//
// Mode policy: chips fire for "ask" (player-picked) and "on" (auto-
// passive). They do NOT fire for "force" mode — engine-mandatory
// reactions per [[force-mode-for-engine-mandatory-reactions]] are
// deliberately invisible.
//
// Lifetime: ~2.5s, then a fade-out. No explicit close from the GM —
// the chip manages its own timer. Multiple chips can stack on the
// same token (consecutive applies queue vertically).
//
// API:
//   ReactionAppliedChip.spawn({ token, label, icon, durationMs })
//     - token:      PIXI Token to anchor on.
//     - label:      reaction display name ("Counterattack").
//     - icon:       optional carrier icon URL.
//     - durationMs: total lifetime; default 2500.
//
//   ReactionAppliedChip.despawnAll()
//     - Sweep every chip on this client (director.stop / scene change).

import { log, warn } from "./logger.js";

const STYLE_ID = "fud-reaction-applied-style";

const _instances = new Set();

function ensureBaseStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-react-applied{
      position:fixed; left:0; top:0;
      z-index:var(--z-index-canvas, 0);
      pointer-events:none;
      transform:translate(-50%,-50%) scale(0.85);
      opacity:0;
      transition:transform 220ms ease-out, opacity 220ms ease-out;
    }
    .fud-react-applied.is-visible{
      transform:translate(-50%,-50%) scale(1.0);
      opacity:1;
    }
    .fud-react-applied.is-fading{
      transform:translate(-50%,-90%) scale(0.95);
      opacity:0;
    }
    .fud-react-applied .chip{
      display:inline-flex; align-items:center; gap:8px;
      padding:7px 14px 7px 10px;
      color:#fff8e8;
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      font-weight:800; letter-spacing:.36px; text-transform:uppercase;
      font-size:12px; white-space:nowrap;
      background:linear-gradient(180deg, #b95535 0%, #843d22 100%);
      border:2px solid #ffe6b8;
      border-radius:9px;
      box-shadow:
        0 0 0 1px rgba(0,0,0,.55) inset,
        0 0 18px rgba(217,128,80,.7),
        0 3px 0 rgba(0,0,0,.45);
      text-shadow:0 1px 0 rgba(0,0,0,.55);
    }
    .fud-react-applied .chip .icon{
      width:18px; height:18px; border-radius:3px;
      border:1px solid rgba(255,230,184,.7);
      object-fit:cover; flex:0 0 auto;
      background:rgba(255,255,255,.18);
    }
    .fud-react-applied .chip .label{ flex:0 0 auto; }
  `;
  document.head.appendChild(css);
}

function worldToClient(token, ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// Anchor above the token center — stacks differently than the menu /
// indicator (which sit right-of-token) so visual surfaces don't collide.
function worldAnchor(token) {
  if (!token || token.destroyed) return { x: 0, y: 0 };
  try {
    const c = token.center ?? token.getCenter?.() ?? {
      x: (token.x ?? 0) + (token.w ?? 100) / 2,
      y: (token.y ?? 0) + (token.h ?? 100) / 2,
    };
    return {
      x: c.x,
      y: c.y - (token.h ?? 100) * 0.62,
    };
  } catch (_e) {
    return { x: 0, y: 0 };
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function spawnInternal({ token, label, icon, durationMs }) {
  ensureBaseStyles();

  const root = document.createElement("div");
  root.className = "fud-react-applied";
  const iconHtml = icon ? `<img class="icon" src="${icon}" alt="" />` : "";
  root.innerHTML = `<div class="chip">${iconHtml}<span class="label">${escapeHtml(label ?? "Reaction")}</span></div>`;

  document.body.appendChild(root);

  function place() {
    if (!document.body.contains(root)) return;
    if (!token || token.destroyed) return;
    const a = worldAnchor(token);
    const ctr = worldToClient(token, a.x, a.y);
    root.style.left = `${ctr.x}px`;
    root.style.top  = `${ctr.y}px`;
  }

  place();
  requestAnimationFrame(() => { root.classList.add("is-visible"); });

  // Reposition on canvas pan / token move. No director ref — global Hooks.
  const onUpdateToken = (doc) => {
    if (doc?.id === token.document?.id) place();
  };
  const onCanvasPan = () => place();
  const hookIdUpdate = Hooks.on("updateToken", onUpdateToken);
  const hookIdPan = Hooks.on("canvasPan", onCanvasPan);

  const total = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 2500;
  const fadeAt = Math.max(0, total - 240);

  const rec = { root, cleanup: null };
  _instances.add(rec);

  const fadeTimer = setTimeout(() => {
    root.classList.add("is-fading");
    root.classList.remove("is-visible");
  }, fadeAt);

  const removeTimer = setTimeout(() => {
    rec.cleanup?.();
  }, total);

  rec.cleanup = () => {
    try { clearTimeout(fadeTimer); } catch {}
    try { clearTimeout(removeTimer); } catch {}
    try { Hooks.off("updateToken", hookIdUpdate); } catch {}
    try { Hooks.off("canvasPan", hookIdPan); } catch {}
    try { root.remove(); } catch {}
    _instances.delete(rec);
  };

  log(`ReactionAppliedChip: spawned "${label}" on ${token?.name ?? token.id}`);
  return rec;
}

export const ReactionAppliedChip = {
  spawn({ token, label, icon, durationMs } = {}) {
    if (!token) {
      warn("ReactionAppliedChip.spawn: missing token");
      return null;
    }
    return spawnInternal({ token, label, icon, durationMs });
  },

  despawnAll() {
    for (const rec of [..._instances]) {
      try { rec.cleanup?.(); } catch {}
    }
    _instances.clear();
  },
};
