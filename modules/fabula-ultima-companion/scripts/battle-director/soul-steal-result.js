// Soul Steal result overlay — shared GM + player render surface.
//
// The loot-roll summary that `roll_loot_table` produces (skill-effects.js)
// used to be a plain GM-only `Dialog`. It is now a broadcastable overlay:
// the GM computes a SERIALIZABLE view-model (item names / imgs / desc / a
// prebuilt stats-strip HTML string — no live doc refs) and:
//   - renders it locally, AND
//   - broadcasts it to EVERY active player via MENU_OPEN kind
//     "soul-steal-result".
//
// Visibility rule (user-locked): the panel shows to everyone, but only the
// GM and the ACTION OWNER can close it. Non-owner spectators get a read-only
// panel with no close affordance; it is torn down for them by a MENU_CLOSE
// broadcast once the GM or owner dismisses it. Closing (GM-local OK or the
// owner's SOUL_STEAL_CLOSED intent) is what unblocks the GM-side RESOLVE.
//
// Lifecycle mirrors the pickers: Map<combatId, record>, despawned by
// boot.stop() / Stopped, or by broadcastMenuClose on the player side.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";

const CSS_ID  = "fud-steal-result-style";
const ROOT_ID = "fud-steal-result-root";

const _overlays = new Map();

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// GM-side helper: the first ACTIVE non-GM user who OWNs `actor` (deterministic
// on multi-owner actors by sorting on user id). Returns null for NPCs / no
// online owner — the caller then treats the panel as GM-only closeable. This
// is the same canonical shape used by action-card.js / state-handlers.js.
export function ownerUserIdForActor(actor) {
  if (!actor) return null;
  const candidates = (game.users?.contents ?? []).filter((u) => {
    if (u.isGM) return false;
    if (!u.active) return false;
    try { return actor.testUserPermission?.(u, "OWNER"); } catch { return false; }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates[0].id;
}

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    #${ROOT_ID} {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.94); opacity: 0;
      z-index: 96; pointer-events: none;
      transition: transform 200ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease-out;
    }
    #${ROOT_ID}.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    #${ROOT_ID}.is-resolving { transform: translate(-50%, -50%) scale(0.96); opacity: 0; transition: transform 180ms ease-out, opacity 180ms ease-out; }
    #${ROOT_ID} .fud-app-card {
      pointer-events: auto; width: 460px; max-width: 94vw; max-height: 80vh; overflow-y: auto;
      padding: 12px 16px 12px;
      border: 2px solid var(--fud-stroke, #7a6a55); border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow: 0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.5) inset;
      color: var(--fud-ink, #3a3228); font-family: "Signika","Inter","Segoe UI",system-ui,sans-serif;
    }
    #${ROOT_ID} .fud-app-title { font-size:14px; font-weight:900; letter-spacing:0.32px; text-transform:uppercase; text-align:center; padding-bottom:7px; border-bottom:2px solid var(--fud-stroke,#7a6a55); margin-bottom:8px; }
    #${ROOT_ID} .fud-steal-header { margin: 2px 0 8px; font-size: 13px; }
    #${ROOT_ID} .fud-steal-body { display: flex; flex-direction: column; gap: 6px; }
    #${ROOT_ID} .fud-steal-option {
      display: grid; grid-template-columns: 56px 1fr; align-items: center; gap: 10px;
      padding: 6px 8px; border-radius: 6px;
      background: rgba(122, 155, 182, 0.10); transition: background 120ms ease;
    }
    #${ROOT_ID} .fud-steal-option:hover { background: rgba(122, 155, 182, 0.22); }
    #${ROOT_ID} .fud-steal-icon {
      width: 52px; height: 52px; border-radius: 6px;
      background-color: rgba(20, 20, 20, 0.08); background-size: cover; background-position: center;
      border: 2px solid #000; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4) inset;
    }
    #${ROOT_ID} .fud-steal-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    #${ROOT_ID} .fud-steal-line { font-size: 13.5px; line-height: 1.25; color: #3a3228; }
    #${ROOT_ID} .fud-steal-line b { font-weight: 800; }
    #${ROOT_ID} .fud-steal-stacked-pill {
      display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 4px;
      font-size: 10px; font-weight: 800; background: rgba(42, 110, 61, 0.18); color: #2a6e3d; vertical-align: 1px;
    }
    #${ROOT_ID} .fud-steal-empty { padding: 6px 8px; border-radius: 6px; background: rgba(90, 106, 133, 0.08); font-size: 12.5px; }
    #${ROOT_ID} .fud-steal-empty b { font-weight: 800; }
    #${ROOT_ID} .fud-app-btn-row { display:flex; gap:8px; margin-top:12px; }
    #${ROOT_ID} .fud-app-btn {
      flex:1; padding:8px 10px; border-radius:8px; border:2px solid var(--fud-stroke,#7a6a55);
      font-weight:800; letter-spacing:0.32px; text-transform:uppercase; font-size:11.5px;
      cursor:pointer; user-select:none; text-align:center;
      background:linear-gradient(180deg, var(--fud-gold-1,#d5b67a), var(--fud-gold-2,#b7935a)); color:#221b14;
      box-shadow:0 3px 0 var(--fud-shadow, rgba(24,28,41,0.55)), 0 0 0 1px rgba(255,255,255,0.5) inset;
      transition:transform 100ms ease, filter 100ms ease;
    }
    #${ROOT_ID} .fud-app-btn:hover { filter:brightness(1.05); transform:translateY(-1px); }
    #${ROOT_ID} .fud-steal-wait { margin-top:10px; text-align:center; font-size:11px; font-weight:700; opacity:0.7; letter-spacing:0.3px; }
  `;
  document.head.appendChild(css);
}

// Render one won item from the SERIALIZABLE view-model (no live doc). The
// stats strip is a prebuilt HTML string produced GM-side; desc + stats ride
// as data-attributes so the shared desc-tooltip can surface them on hover.
function renderItemRow(targetName, won) {
  const tipBody = won.desc ? escapeHtml(won.desc) : "";
  const descAttr = tipBody ? ` data-fud-equip-desc="${tipBody}" data-fud-equip-desc-name="${escapeHtml(won.name)}"` : "";
  const statsAttr = won.statsHtml ? ` data-fud-equip-stats="${escapeHtml(won.statsHtml)}"` : "";
  const stackedTag = won.stacked
    ? `<span class="fud-steal-stacked-pill" title="Added to existing stack">+1</span>`
    : "";
  const iconStyle = won.img ? `background-image:url('${escapeHtml(won.img)}')` : "";
  return `
    <div class="fud-steal-option"${descAttr}${statsAttr}>
      <div class="fud-steal-icon" style="${iconStyle}"></div>
      <div class="fud-steal-text">
        <div class="fud-steal-line">
          Obtain <b>${escapeHtml(won.name)}</b> from <b>${escapeHtml(targetName)}</b>${stackedTag}
        </div>
      </div>
    </div>`;
}

function renderTargetBlock(r) {
  if (r.missed)        return `<div class="fud-steal-empty"><b>Missed</b> — Check failed against <b>${escapeHtml(r.targetName)}</b>.</div>`;
  if (r.alreadyStolen) return `<div class="fud-steal-empty"><b>Already stolen</b> from <b>${escapeHtml(r.targetName)}</b>.</div>`;
  if (r.noTable)       return `<div class="fud-steal-empty"><b>No stealable items</b> on <b>${escapeHtml(r.targetName)}</b>.</div>`;
  if (!r.won?.length)  return `<div class="fud-steal-empty">Stole <b>nothing</b> from <b>${escapeHtml(r.targetName)}</b>.</div>`;
  return r.won.map((w) => renderItemRow(r.targetName, w)).join("");
}

// Show the loot-result overlay on THIS client. `canClose` decides whether an
// OK button is rendered (GM + owner) or the panel is read-only (spectators).
// Returns a Promise that resolves when the panel is dismissed (OK click OR an
// external despawn). `onClose` fires on the OK click BEFORE the local teardown
// (players use it to emit SOUL_STEAL_CLOSED).
export function showSoulStealResultOverlay({ combatId = "default", casterName, viewResults, canClose = false, onClose = null } = {}) {
  ensureStyles();
  const prior = _overlays.get(combatId);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(combatId); }

  const rows = Array.isArray(viewResults) ? viewResults : [];
  const btn = canClose
    ? `<div class="fud-app-btn-row"><div class="fud-app-btn" data-fud-steal-ok role="button" tabindex="0">OK</div></div>`
    : `<div class="fud-steal-wait">Waiting for the actor / GM…</div>`;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="fud-app-card" role="dialog" aria-label="Soul Steal — Results">
      <div class="fud-app-title">Soul Steal — Results</div>
      <div class="fud-steal-header"><b>${escapeHtml(casterName)}</b> performs Soul Steal:</div>
      <div class="fud-steal-body">${rows.map(renderTargetBlock).join("")}</div>
      ${btn}
    </div>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));
  log(`SoulStealResult spawned (canClose=${canClose})`);

  // Bind the shared equipment desc-tooltip so hovering an item surfaces its
  // description + stats. Lazy-import keeps non-UI contexts (harness) clean.
  let detachTooltip = null;
  import("./desc-tooltip.js").then(({ ensureDescTooltipStyles, attachDescTooltip }) => {
    try {
      ensureDescTooltipStyles();
      detachTooltip = attachDescTooltip(root, { isAlive: () => document.body.contains(root) });
    } catch (e) { warn("SoulStealResult: attachDescTooltip threw", e); }
  }).catch(() => {});

  return new Promise((resolve) => {
    let resolved = false;
    let despawnTid = null;

    const teardown = () => {
      try { detachTooltip?.(); } catch {}
      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      despawnTid = setTimeout(() => { try { root.remove(); } catch {} }, 200);
      _overlays.delete(combatId);
    };

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { onClose?.(); } catch (e) { warn("SoulStealResult onClose threw", e); }
      teardown();
      resolve();
    };

    if (canClose) {
      root.addEventListener("click", (ev) => {
        if (ev.target?.closest?.("[data-fud-steal-ok]")) { ev.stopPropagation(); finish(); }
      });
    }

    // External despawn (owner won the race / boot stop / MENU_CLOSE): tear
    // down WITHOUT firing onClose (no self-emit) and resolve the promise.
    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      if (!resolved) { resolved = true; teardown(); resolve(); }
    };
    _overlays.set(combatId, { cleanup, root });
  });
}

export const SoulStealResult = {
  despawn({ combatId = "default" } = {}) {
    const rec = _overlays.get(combatId);
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _overlays.delete(combatId);
  },
  despawnAll() {
    for (const rec of _overlays.values()) { try { rec.cleanup(); } catch {} }
    _overlays.clear();
  },
};

// ─── Player-side handler ──────────────────────────────────────────────
//
// Renders the loot-result panel on a player's client when the GM broadcasts a
// "soul-steal-result" MENU_OPEN. Only the ACTION OWNER (menuSpec.ownerUserId)
// gets an OK button; clicking it emits SOUL_STEAL_CLOSED so the GM's RESOLVE
// await unblocks. Everyone else sees it read-only. A MENU_CLOSE of this kind
// despawns it on all clients.
export function registerPlayerSoulStealHandler(channel, isActiveDirector = () => false) {
  const offOpen = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "soul-steal-result") return;
    // Primary GM renders locally in skill-effects; skip the broadcast copy.
    if (isActiveDirector()) return;
    const canClose = !!menuSpec.ownerUserId && menuSpec.ownerUserId === game.user?.id;
    showSoulStealResultOverlay({
      combatId: menuSpec.combatId ?? "default",
      casterName: menuSpec.casterName,
      viewResults: menuSpec.viewResults,
      canClose,
      onClose: canClose
        ? () => channel.emit({ type: INTENTS.SOUL_STEAL_CLOSED, body: {}, combatId: menuSpec.combatId })
        : null,
    });
  });

  const offClose = channel.onMenuClose((payload) => {
    if (payload?.kind && payload.kind !== "soul-steal-result") return;
    try { SoulStealResult.despawnAll(); } catch {}
  });

  return () => { try { offOpen?.(); } catch {} try { offClose?.(); } catch {} };
}
