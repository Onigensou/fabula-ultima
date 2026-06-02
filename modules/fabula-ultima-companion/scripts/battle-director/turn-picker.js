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
import { INTENTS } from "./intents.js";

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
//
// `director` is optional. When omitted (player client), this falls back
// to global Hooks.on for canvas-pan/token-move tracking and uses a
// fixed root id since there's no combatId to key against. See
// [[director-player-driven-input]].
function spawnPicker({ director, entries, onPick, combatId }) {
  ensureStyles();

  const rootKey = combatId ?? director?.combatId ?? "noid";
  const root = document.createElement("div");
  root.className = "fud-pickturn";
  root.id = `fud-pickturn-${rootKey}`;
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

  // Position-tracking hooks. GM uses director.hooks (HookRegistry-managed
  // cleanup); player has no director, so register against the global
  // Hooks bus and tear down manually.
  const manualHooks = [];
  const onUpdate = (doc) => {
    if (records.some((r) => r.entry.token?.document?.id === doc?.id)) position();
  };
  const onPan = () => position();
  if (director?.hooks?.on) {
    director.hooks.on("canvasPan", onPan, { label: "turn-picker:canvasPan" });
    director.hooks.on("updateToken", onUpdate, { label: "turn-picker:updateToken" });
  } else {
    const id1 = Hooks.on("canvasPan", onPan);
    const id2 = Hooks.on("updateToken", onUpdate);
    manualHooks.push(() => { try { Hooks.off("canvasPan", id1); } catch {} });
    manualHooks.push(() => { try { Hooks.off("updateToken", id2); } catch {} });
  }

  function cleanup() {
    try { ticker.remove(tickFn); } catch {}
    for (const r of records) {
      try { r.pill.removeEventListener("click", r.onClick); } catch {}
    }
    try { root.remove(); } catch {}
    // Director-owned hooks: HookRegistry.disposeAll handles them on stop.
    // Player-side manual hooks: unbind explicitly.
    for (const fn of manualHooks) { try { fn(); } catch {} }
    log("Turn picker cleaned up");
  }

  return { cleanup, root };
}

export const TurnPicker = {
  // Show "Take Action" pills for each eligible combatant. Returns a Promise
  // that resolves with the picked combatantId, or null if the picker is
  // despawned externally without a pick.
  //
  // GM-mode: pass { director, eligible } — eligible is an array of
  // DirectorCombatant-shaped objects (id, name, side, tokenId).
  //
  // Player-mode: pass { eligible, combatId, onPick? } — director is
  // null; the player handler in registerPlayerTurnPickerHandler wires
  // its own onPick to emit TURN_COMBATANT_PICKED over the socket.
  show({ director = null, eligible, combatId = null, onPick = null }) {
    const overlayKey = combatId ?? director?.combatId ?? "no-director";

    // Despawn any prior picker keyed by this combatId.
    const prior = _instances.get(overlayKey);
    if (prior) { try { prior.rec.cleanup(); prior.resolve(null); } catch {} }

    const entries = [];
    for (const dc of eligible) {
      // Accept either a DirectorCombatant (live) or a serialized snap
      // { id|combatantId, name, side, tokenUuid|tokenId }. The player
      // path receives serialized data over the socket.
      const tokenId = dc.tokenId ?? null;
      const tokenUuid = dc.tokenUuid ?? null;
      let token = null;
      if (tokenId) token = canvas?.tokens?.get(tokenId) ?? null;
      if (!token && tokenUuid) {
        try {
          const doc = fromUuidSync?.(tokenUuid);
          token = doc?.object ?? null;
        } catch {}
      }
      if (!token) {
        warn(`Turn picker: no canvas token for ${dc.name} (tokenId=${tokenId}, uuid=${tokenUuid})`);
        continue;
      }
      entries.push({
        combatantId: dc.id ?? dc.combatantId,
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
        _instances.delete(overlayKey);
        resolve(id);
      };
      const rec = spawnPicker({
        director,
        entries,
        combatId: overlayKey,
        // If caller provided its own onPick (player-side: emit intent),
        // use it; otherwise default to finish (GM-side: resolve Promise).
        onPick: (id) => {
          if (typeof onPick === "function") {
            try { onPick(id); } catch (e) { warn("Turn picker onPick threw", e); }
          }
          finish(id);
        },
      });
      _instances.set(overlayKey, { rec, resolve: finish });
    });
  },

  despawn({ director, combatId } = {}) {
    const key = combatId ?? director?.combatId;
    if (!key) return;
    const inst = _instances.get(key);
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

// ─── Player-side handler ──────────────────────────────────────────────
//
// Spawns the turn picker on a player's client when the GM broadcasts a
// "turn-picker" MENU_OPEN. The player only sees pills over combatants
// they OWN — the GM does the ownership filter before broadcasting, so
// the menuSpec.eligible is already pre-filtered for this user.
//
// On click → emits TURN_COMBATANT_PICKED over IntentChannel. GM's
// TURN_START races this against its own local picker click.
export function registerPlayerTurnPickerHandler(channel) {
  const offOpen = channel.onMenuOpen(async (menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "turn-picker") return;
    log(`turn-picker MENU_OPEN received: ${menuSpec.eligible?.length ?? 0} eligible, sceneUuid=${menuSpec.sceneUuid ?? "none"}`);
    if (!Array.isArray(menuSpec.eligible) || !menuSpec.eligible.length) {
      log("turn-picker MENU_OPEN: empty eligible list, skipping");
      return;
    }
    // Switch to the battle scene if we're not there — pills are anchored
    // to canvas tokens. scene.view() only affects this user.
    try {
      if (menuSpec.sceneUuid) {
        const scene = await fromUuid(menuSpec.sceneUuid);
        if (scene && scene.id !== canvas?.scene?.id) {
          log(`turn-picker MENU_OPEN: switching view to ${scene.name}`);
          try { await scene.view(); } catch (e) { warn("scene.view threw", e); }
          // scene.view() returns before canvas is fully rendered with
          // tokens. Wait for canvasReady before spawning pills so
          // canvas.tokens.get() can actually resolve the tokens.
          if (!canvas?.ready) {
            log(`turn-picker MENU_OPEN: waiting for canvasReady`);
            await new Promise((resolve) => {
              const handler = () => { Hooks.off("canvasReady", handler); resolve(); };
              Hooks.once("canvasReady", handler);
              // Safety timeout — don't hang forever if canvas never finishes.
              setTimeout(() => { try { Hooks.off("canvasReady", handler); } catch {} resolve(); }, 5000);
            });
          }
        }
      }
    } catch (e) { warn("turn-picker scene-switch threw", e); }

    log(`turn-picker MENU_OPEN: spawning pills (canvas.ready=${!!canvas?.ready}, scene=${canvas?.scene?.name})`);
    TurnPicker.show({
      director: null,
      combatId: menuSpec.combatId,
      eligible: menuSpec.eligible,
      // Click → emit intent; GM's awaitIntent resolves the FSM picker.
      onPick: (combatantId) => {
        log(`turn-picker: emitting TURN_COMBATANT_PICKED ${combatantId}`);
        channel.emit({
          type: INTENTS.TURN_COMBATANT_PICKED,
          body: { combatantId },
          combatId: menuSpec.combatId,
        });
      },
    });
  });

  const offClose = channel.onMenuClose((payload) => {
    if (payload?.kind && payload.kind !== "turn-picker") return;
    // No reliable combatId on the payload; just despawn anything open.
    // At most one turn-picker is up per client at a time.
    try { TurnPicker.despawnAll(); } catch {}
  });

  return () => { try { offOpen?.(); } catch {} try { offClose?.(); } catch {} };
}
