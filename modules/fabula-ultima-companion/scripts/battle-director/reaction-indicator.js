// Token-anchored reaction indicator — Rule 1 stage 2.
//
// Non-interactive dimmed dashed pill rendered on player clients that DON'T
// own a currently-reacting reactor. Tells allies "Player X is deciding on a
// reaction right now" without leaking what the options are.
//
// Visibility ladder (see [[reaction-architecture]] Rule 1):
//   Stage 1 — Candidates enumerated: GM only.
//   Stage 2 — Decision pending: owner sees actionable ReactionMenu,
//             other players see this dimmed indicator over reactor token.
//   Stage 3 — Decision applied: broadcast applied chip (next slice).
//   Stage 4 — Effect resolves: natural Foundry hooks.
//
// API mirrors ReactionMenu's spawn/despawn shape so the standalone
// dispatcher can pair its lifecycle calls 1:1.
//
//   ReactionIndicator.spawn({ token, label, combatId, trigger })
//     - token:    PIXI Token to anchor on (reactor).
//     - label:    pill text (e.g. "Alice reacting…").
//     - combatId: combat id for instance keying.
//     - trigger:  informational, tagged on the root for debugging.
//
//   ReactionIndicator.despawn({ combatId, tokenId })
//   ReactionIndicator.despawnAll()

import { log, warn } from "./logger.js";

const STYLE_ID = "fud-reaction-indicator-style";

const _instances = new Map();

function makeKey(combatId, tokenId) {
  return `${combatId ?? "no-combat"}:${tokenId ?? "no-token"}`;
}

function ensureBaseStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-react-indicator{
      position:fixed; left:0; top:0;
      z-index:var(--z-index-canvas, 0);
      pointer-events:none;
      opacity:0;
      transition:opacity 240ms ease-out;
    }
    .fud-react-indicator.is-visible{ opacity:1; }
    .fud-react-indicator .pill{
      position:absolute; transform:translate(0,-50%);
      display:inline-flex; align-items:center; gap:7px;
      padding:6px 14px;
      color:var(--fud-react-ink, #3a2a22);
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      font-weight:700; letter-spacing:.28px; text-transform:uppercase;
      font-size:11px; white-space:nowrap;
      background:linear-gradient(180deg, rgba(246,241,230,.78), rgba(235,227,208,.78));
      border:2px dashed var(--fud-react-stroke, #5a3a2c);
      border-radius:10px;
      box-shadow:0 2px 0 rgba(41,24,18,.35);
      filter:saturate(0.55) brightness(0.95);
    }
    .fud-react-indicator .pill::before{
      content:""; width:7px; height:7px; border-radius:50%;
      background:linear-gradient(180deg, #d57b5b, #a85738);
      border:1.5px solid var(--fud-react-stroke, #5a3a2c);
      opacity:0.85;
      animation:fud-react-pulse 1.4s ease-in-out infinite;
    }
    @keyframes fud-react-pulse{
      0%, 100% { transform:scale(1.0); opacity:0.85; }
      50%      { transform:scale(1.25); opacity:1.0; }
    }
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

// Match ReactionMenu.worldAnchor so the indicator sits where the owner
// sees the menu — visually consistent across clients.
function worldAnchor(token) {
  if (!token || token.destroyed) return { x: 0, y: 0 };
  try {
    const c = token.center ?? token.getCenter?.() ?? {
      x: (token.x ?? 0) + (token.w ?? 100) / 2,
      y: (token.y ?? 0) + (token.h ?? 100) / 2,
    };
    return {
      x: c.x + (token.w ?? 100) * 0.52,
      y: c.y - (token.h ?? 100) * 0.10,
    };
  } catch (_e) {
    return { x: 0, y: 0 };
  }
}

function spawnInternal({ token, combatId, label, trigger }) {
  ensureBaseStyles();

  const tokenUuid = token.document?.uuid ?? token.uuid ?? null;

  const root = document.createElement("div");
  root.className = "fud-react-indicator";
  root.id = `fud-react-indicator-${combatId ?? "x"}-${token.id ?? "y"}`;
  if (trigger) root.dataset.fudTrigger = String(trigger);
  if (tokenUuid) root.dataset.tokenUuid = tokenUuid;

  const pill = document.createElement("div");
  pill.className = "pill";
  pill.textContent = String(label ?? "Reacting…");
  root.appendChild(pill);

  document.body.appendChild(root);

  function place() {
    if (!document.body.contains(root)) return;
    if (!token || token.destroyed) return;
    const a = worldAnchor(token);
    const ctr = worldToClient(token, a.x, a.y);
    pill.style.left = `${ctr.x}px`;
    pill.style.top  = `${ctr.y}px`;
  }

  place();
  requestAnimationFrame(() => { root.classList.add("is-visible"); });

  // Reposition on canvas pan / token move. Player has no director so we
  // bind on the global Hooks bus and tear down manually.
  const manualHookCleanups = [];
  const onUpdateToken = (doc) => {
    if (doc?.id === token.document?.id) place();
  };
  const onCanvasPan = () => place();
  const hookIdUpdate = Hooks.on("updateToken", onUpdateToken);
  const hookIdPan = Hooks.on("canvasPan", onCanvasPan);
  manualHookCleanups.push(() => { try { Hooks.off("updateToken", hookIdUpdate); } catch {} });
  manualHookCleanups.push(() => { try { Hooks.off("canvasPan", hookIdPan); } catch {} });

  function cleanup() {
    try { root.remove(); } catch {}
    for (const fn of manualHookCleanups) {
      try { fn(); } catch {}
    }
  }

  return { cleanup, root, tokenUuid };
}

export const ReactionIndicator = {
  spawn({ token, combatId, label, trigger } = {}) {
    if (!token) {
      warn("ReactionIndicator.spawn: missing token");
      return null;
    }
    const key = makeKey(combatId, token.id);
    const prior = _instances.get(key);
    if (prior) { try { prior.cleanup(); } catch {} }
    const rec = spawnInternal({ token, combatId, label, trigger });
    _instances.set(key, rec);
    log(`ReactionIndicator: spawned on ${token?.name ?? token.id} for ${trigger ?? "?"}`);
    return rec;
  },

  despawn({ combatId, tokenId, tokenUuid } = {}) {
    // Prefer (combatId, tokenId) when available — exact key match.
    if (tokenId != null) {
      const key = makeKey(combatId, tokenId);
      const rec = _instances.get(key);
      if (rec) {
        try { rec.cleanup(); } catch {}
        _instances.delete(key);
      }
      return;
    }
    // Fallback: tokenUuid-keyed lookup. The player-side close handler
    // only carries tokenUuid (canonical) — placeable id is local.
    if (tokenUuid) {
      for (const [key, rec] of _instances) {
        if (rec?.tokenUuid === tokenUuid) {
          try { rec.cleanup(); } catch {}
          _instances.delete(key);
          return;
        }
      }
    }
  },

  despawnAll() {
    for (const rec of _instances.values()) {
      try { rec.cleanup(); } catch {}
    }
    _instances.clear();
  },
};
