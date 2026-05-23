// Director Turn Picker — "Take Action" pill UI.
//
// Spawned by TurnStart when the current side has >1 eligible combatant
// (i.e. the side gets to dynamically pick who acts next, per Fabula Ultima
// RAW p. 63 "Dynamic Turn Order"). One pill per eligible combatant, anchored
// to the outer edge of that combatant's token:
//   - enemy combatants  → pill on the LEFT of the token  (screen-outward)
//   - party combatants  → pill on the RIGHT of the token (screen-outward)
//
// Visual style intentionally mirrors `turn-ui.js`'s parchment-blade aesthetic
// so the GM perceives it as part of the same UI family. A small "DIRECTOR"
// pip on the bottom-corner label identifies it.
//
// Returns a Promise resolving with the chosen `DirectorCombatant.id` on
// click, or `null` if the picker is despawned externally (e.g. director
// stopped, manual cancel).

import { log, warn } from "./logger.js";

const STYLE_ID = "fud-turnpicker-style";

// Per-director instance state — keyed by combatId.
const _instances = new Map();

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-pickturn{
      position:fixed; left:0; top:0;
      z-index:var(--z-index-canvas, 0);
      pointer-events:none;
    }
    .fud-pickturn .pill{
      position:absolute; transform-origin:center;
      pointer-events:auto; cursor:pointer; user-select:none;
      display:inline-flex; align-items:center; gap:8px;
      padding:8px 14px;
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase;
      font-size:12px; white-space:nowrap;
      color:var(--fud-ink, #3a3228);
      background:linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      border:2px solid var(--fud-stroke, #5a6a85);
      border-radius:999px;
      box-shadow:0 4px 0 var(--fud-shadow, rgba(24,28,41,.55)), 0 0 0 1px var(--fud-highlight, rgba(255,255,255,.7)) inset;
      text-shadow:0 1px 0 var(--fud-highlight, rgba(255,255,255,.7));
      transition: transform .12s ease-out, filter .12s ease, box-shadow .12s ease, opacity .18s ease;
      opacity:0;
      will-change: transform, filter, box-shadow;
    }
    .fud-pickturn .pill::before{
      content:""; width:8px; height:8px; border-radius:50%;
      background:linear-gradient(180deg, var(--fud-gold-1, #a8c4d8), var(--fud-gold-2, #7a9bb6));
      border:1.5px solid var(--fud-stroke, #5a6a85);
      box-shadow:0 0 0 1px var(--fud-highlight, rgba(255,255,255,.7)) inset;
      flex-shrink:0;
    }
    .fud-pickturn .pill.shown{ opacity:1 }
    .fud-pickturn .pill.side-enemy{ transform:translate(-100%, -50%) }
    .fud-pickturn .pill.side-party{ transform:translate(0, -50%) }
    .fud-pickturn .pill:hover{
      filter:brightness(1.06);
      box-shadow:0 6px 0 var(--fud-shadow, rgba(24,28,41,.55)), 0 0 0 1px var(--fud-highlight, rgba(255,255,255,.7)) inset;
    }
    .fud-pickturn .pill.side-enemy:hover{ transform:translate(-100%, -50%) translateY(-1px) }
    .fud-pickturn .pill.side-party:hover{ transform:translate(0, -50%) translateY(-1px) }
    .fud-pickturn .pill.side-enemy:active{ transform:translate(-100%, -50%) translateY(0) scale(.98) }
    .fud-pickturn .pill.side-party:active{ transform:translate(0, -50%) translateY(0) scale(.98) }
    .fud-pickturn .pill .director-tag{
      margin-left:6px; padding-left:8px;
      color:#5a6a85; opacity:.8; font-weight:900; letter-spacing:.5px; font-size:9px;
      border-left:1px solid rgba(90,106,133,.35);
    }
  `;
  document.head.appendChild(css);
}

// Convert a token's world-coordinate point to client (page) coordinates.
function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// Compute the anchor point in world coords for a token, given which screen
// edge the pill should hug:
//   side === "enemy" → pill anchors at LEFT edge of token  (token.center − w/2 − gap)
//   side === "party" → pill anchors at RIGHT edge of token (token.center + w/2 + gap)
function anchorPointWorld(token, side) {
  if (!token || token.destroyed) return { x: 0, y: 0 };
  try {
    const w = token.w ?? 100;
    const h = token.h ?? 100;
    const c = token.center ?? token.getCenter?.() ?? { x: (token.x ?? 0) + w / 2, y: (token.y ?? 0) + h / 2 };
    const gap = w * 0.18;
    const x = side === "enemy" ? (c.x - w / 2 - gap) : (c.x + w / 2 + gap);
    return { x, y: c.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

// Build the picker DOM root + return its handle. `entries` is an array of
// { combatantId, name, side, token } where `token` is the live canvas Token.
function spawnPicker({ director, entries, onPick }) {
  ensureStyles();

  const root = document.createElement("div");
  root.className = "fud-pickturn";
  root.id = `fud-pickturn-${director.combatId ?? "noid"}`;
  document.body.appendChild(root);

  const records = [];
  for (const e of entries) {
    const pill = document.createElement("div");
    pill.className = `pill side-${e.side}`;
    pill.dataset.combatantId = e.combatantId;
    const label = document.createElement("span");
    label.textContent = "Take Action";
    const tag = document.createElement("span");
    tag.className = "director-tag";
    tag.textContent = e.name ?? "";
    pill.append(label, tag);
    root.appendChild(pill);

    const onClick = (ev) => {
      ev.stopPropagation();
      onPick(e.combatantId);
    };
    pill.addEventListener("click", onClick);
    records.push({ entry: e, pill, onClick });
  }

  function position() {
    for (const r of records) {
      const token = r.entry.token;
      if (!token || token.destroyed) continue;
      const w = anchorPointWorld(token, r.entry.side);
      const c = worldToClient(w.x, w.y);
      r.pill.style.left = `${c.x}px`;
      r.pill.style.top = `${c.y}px`;
    }
  }

  // Initial position + fade-in.
  position();
  requestAnimationFrame(() => {
    for (const r of records) r.pill.classList.add("shown");
  });

  const ticker = PIXI.Ticker.shared;
  let tickErrCount = 0;
  const tickFn = () => {
    try { position(); }
    catch (e) {
      tickErrCount++;
      if (tickErrCount <= 3) warn("Turn picker render threw", e);
      if (tickErrCount > 60) {
        warn("Turn picker render: too many errors, aborting tick");
        try { ticker.remove(tickFn); } catch {}
      }
    }
  };
  ticker.add(tickFn);

  const h1 = director.hooks.on("canvasPan", () => position(), { label: "turn-picker:canvasPan" });
  const h2 = director.hooks.on("updateToken", (doc) => {
    if (records.some((r) => r.entry.token?.document?.id === doc?.id)) position();
  }, { label: "turn-picker:updateToken" });

  function cleanup() {
    try { ticker.remove(tickFn); } catch {}
    for (const r of records) {
      try { r.pill.removeEventListener("click", r.onClick); } catch {}
    }
    try { root.remove(); } catch {}
    // Hooks owned by HookRegistry; director.disposeAll handles them on stop.
    log("Turn picker cleaned up");
  }

  return { cleanup, root };
}

export const TurnPicker = {
  // Show "Take Action" pills for each eligible combatant. Returns a Promise
  // that resolves with the picked combatantId, or null if the picker is
  // despawned externally without a pick.
  show({ director, eligible }) {
    if (!game.user?.isGM) {
      log("Turn picker show skipped — non-GM client (v1 is GM-only)");
      return Promise.resolve(null);
    }
    // Despawn any prior picker for this director (paranoid).
    const prior = _instances.get(director.combatId);
    if (prior) { try { prior.rec.cleanup(); prior.resolve(null); } catch {} }

    const entries = [];
    for (const dc of eligible) {
      const token = canvas?.tokens?.get(dc.tokenId);
      if (!token) {
        warn(`Turn picker: no canvas token for ${dc.name} (tokenId=${dc.tokenId})`);
        continue;
      }
      entries.push({
        combatantId: dc.id,
        name: dc.name,
        side: dc.side,
        token,
      });
    }
    if (entries.length === 0) {
      warn("Turn picker: no eligible entries had a canvas token — auto-resolving null");
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (id) => {
        if (resolved) return;
        resolved = true;
        try { rec.cleanup(); } catch {}
        _instances.delete(director.combatId);
        resolve(id);
      };
      const rec = spawnPicker({
        director,
        entries,
        onPick: (id) => finish(id),
      });
      _instances.set(director.combatId, { rec, resolve: finish });
    });
  },

  despawn({ director }) {
    const inst = _instances.get(director.combatId);
    if (!inst) return;
    try { inst.resolve(null); } catch {}
  },

  despawnAll() {
    for (const inst of _instances.values()) {
      try { inst.resolve(null); } catch {}
    }
    _instances.clear();
  },
};
