// Battle Director — Passive Card UI subsystem.
//
// Shows a compact floating action-name card anchored to a token when a
// passive ability auto-fires (reaction_passive_mode "on" or "force").
// The card spawns BEFORE the effect applies so players see the trigger
// before it acts (visual-first timing).
//
// Architecture:
//   GM side      — enqueuePassiveCard() enqueues the spec, plays SFX
//                  locally, broadcasts to all other clients, and renders
//                  locally. Returns after the enter animation (~280 ms)
//                  so the caller (firePreAcceptedCandidate) can await it
//                  before calling applyEffectByLabel.
//   Other clients — socket handler plays SFX + renders the card.
//
// SFX: PASSIVE_CARD_SFX_URL is pre-fetched via director-sfx.js's Web
// Audio path (full 200 GET → AudioBuffer) and cached so the first play
// is instant even on a cold browser tab.
//
// CSS / animation — identical to legacy passive-card-ui.js:
//   enter: translate(-62%,0) opacity 0 → translate(-50%,0) opacity 1
//          280 ms cubic-bezier(0.22, 1, 0.36, 1)
//   exit : reverse, 260 ms cubic-bezier(0.4, 0, 1, 1)
//   hold : 1600 ms at peak opacity
//
// Queue: serialised by director-passive-card-queue.js. The next card's
// enter animation starts only after the previous card's enter completes
// so multiple simultaneous passive fires stagger rather than overlap.

import { log, warn } from "../logger.js";
import { playSfx, preloadSfx } from "../director-sfx.js";
import { enqueueCard, setCardDrainFn, passiveCardQueue } from "./director-passive-card-queue.js";

export { passiveCardQueue };

const MODULE_ID  = "fabula-ultima-companion";
const ACTION_KEY = "FU_DIRECTOR_PASSIVE_CARD_SHOW";

export const PASSIVE_CARD_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/passive_card.wav";

const STYLE_ID   = "fud-passive-card-style-v1";
const ROOT_ID    = "fud-passive-card-root";
const ACTIVE_KEY = "__FUD_PASSIVE_CARD_ACTIVE__";

let _socket = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Client-side styles ───────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${ROOT_ID} {
  position: fixed; left: 0; top: 0;
  pointer-events: none; z-index: 100000;
}
.fud-passive-card {
  position: absolute; left: 0; top: 0;
  transform: translate(-50%, 0);
  pointer-events: none;
  padding: 7px 12px;
  border: 2px solid rgba(255, 220, 140, 0.9);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(44,35,27,0.95), rgba(24,19,15,0.95));
  box-shadow: 0 6px 16px rgba(0,0,0,0.35), 0 0 12px rgba(255,210,120,0.18);
  color: #fff2cf;
  font-family: 'Signika', 'Palatino Linotype', serif;
  opacity: 0;
  will-change: transform, opacity;
  white-space: nowrap;
}
.fud-passive-card .fud-pc-row {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 13px; font-weight: 400; line-height: 1;
  letter-spacing: 0.01em;
  text-shadow: 0 1px 0 rgba(0,0,0,0.45);
}
.fud-passive-card .fud-pc-icon { font-size: 13px; line-height: 1; }
.fud-passive-card.enter {
  animation: fudPassiveCardIn var(--fud-pc-in-ms, 280ms) cubic-bezier(0.22,1,0.36,1) forwards;
}
.fud-passive-card.exit {
  animation: fudPassiveCardOut var(--fud-pc-out-ms, 260ms) cubic-bezier(0.4,0,1,1) forwards;
}
@keyframes fudPassiveCardIn {
  0%   { opacity: 0; transform: translate(-62%, 0); }
  100% { opacity: 1; transform: translate(-50%, 0); }
}
@keyframes fudPassiveCardOut {
  0%   { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-62%, 0); }
}
  `.trim();
  document.head.appendChild(style);
}

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

function getActiveMap() {
  globalThis[ACTIVE_KEY] ??= new Map();
  return globalThis[ACTIVE_KEY];
}

function cleanupExisting(tokenUuid) {
  const map = getActiveMap();
  const existing = map.get(tokenUuid);
  if (!existing) return;
  try {
    if (existing.tickerFn && canvas?.app?.ticker) {
      canvas.app.ticker.remove(existing.tickerFn);
    }
  } catch (_) {}
  try { existing.card?.remove?.(); } catch (_) {}
  map.delete(tokenUuid);
}

// ── Per-client card renderer ─────────────────────────────────────────
//
// Resolves after the enter animation (enterMs ms). Hold + exit run as a
// fire-and-forget async IIFE so the queue can proceed to the next entry.

async function renderCardLocal(spec) {
  const {
    title        = "Passive",
    tokenUuid,
    icon         = "📜",
    holdMs       = 1600,
    enterMs      = 280,
    exitMs       = 260,
    exitBufferMs = 40,
    runId,
  } = spec;

  if (!canvas?.app?.view || !canvas?.tokens) {
    warn("[BD][PassiveCardUI] canvas not ready, skipping card for", title);
    return;
  }

  let token = null;
  try {
    const doc = await fromUuid(tokenUuid);
    token = doc?.object ?? null;
  } catch (e) {
    warn("[BD][PassiveCardUI] fromUuid failed for", tokenUuid, e);
    return;
  }
  if (!token || token.destroyed) {
    warn("[BD][PassiveCardUI] token not on canvas:", tokenUuid);
    return;
  }

  ensureStyles();
  const root = ensureRoot();
  cleanupExisting(tokenUuid);

  const card = document.createElement("div");
  card.className = "fud-passive-card enter";
  card.style.setProperty("--fud-pc-in-ms", `${enterMs}ms`);
  card.style.setProperty("--fud-pc-out-ms", `${exitMs}ms`);

  const row = document.createElement("div");
  row.className = "fud-pc-row";

  const iconEl = document.createElement("span");
  iconEl.className = "fud-pc-icon";
  const iconStr = String(icon ?? "📜");
  if (iconStr.startsWith("http") || iconStr.startsWith("modules/") || iconStr.startsWith("icons/")) {
    const img = document.createElement("img");
    img.src = iconStr;
    img.style.cssText =
      "width:16px;height:16px;border:none;object-fit:contain;vertical-align:middle;border-radius:3px;";
    iconEl.appendChild(img);
  } else {
    iconEl.textContent = iconStr;
  }

  const nameEl = document.createElement("span");
  nameEl.className = "fud-pc-name";
  nameEl.textContent = String(title);

  row.appendChild(iconEl);
  row.appendChild(nameEl);
  card.appendChild(row);
  root.appendChild(card);

  const updatePosition = () => {
    if (!card.isConnected || !token || token.destroyed || !canvas?.app?.view) return;
    const rect = canvas.app.view.getBoundingClientRect();
    const globalPos = token.toGlobal(new PIXI.Point(token.w / 2, token.h));
    card.style.left = (rect.left + globalPos.x) + "px";
    card.style.top  = (rect.top  + globalPos.y + 8) + "px";
  };

  canvas.app.ticker.add(updatePosition);
  updatePosition();
  getActiveMap().set(tokenUuid, { card, tickerFn: updatePosition, runId });

  // Resolve here — queue proceeds to the next card; hold+exit continue in bg.
  await wait(enterMs);

  ;(async () => {
    try {
      await wait(holdMs);
      card.classList.remove("enter");
      card.classList.add("exit");
      await wait(exitMs + Math.max(40, exitBufferMs));
    } finally {
      try { canvas.app.ticker.remove(updatePosition); } catch (_) {}
      try { card.remove(); } catch (_) {}
      const cur = getActiveMap().get(tokenUuid);
      if (cur?.runId === runId) getActiveMap().delete(tokenUuid);
    }
  })();
}

// ── GM-side API ──────────────────────────────────────────────────────
//
// Called from firePreAcceptedCandidate (skill-effects.js) for auto-fire
// passive rows (mode "on" / "force"). Resolves after the enter animation
// so the caller applies the effect while the card is visibly displayed.

export async function enqueuePassiveCard({ title, casterToken, icon, holdMs } = {}) {
  if (!casterToken) {
    warn("[BD][PassiveCardUI] enqueuePassiveCard: no casterToken");
    return;
  }

  // Accept both TokenDocument and canvas Token placeable.
  const tokenUuid = casterToken?.document?.uuid ?? casterToken?.uuid ?? null;
  if (!tokenUuid) {
    warn("[BD][PassiveCardUI] enqueuePassiveCard: could not resolve tokenUuid");
    return;
  }

  const safeIcon = (() => {
    const s = String(icon ?? "📜");
    return /['"<>\n\r]/.test(s) ? "📜" : s;
  })();

  const spec = {
    title:        String(title ?? "Passive"),
    tokenUuid,
    icon:         safeIcon,
    holdMs:       Number(holdMs ?? 1600),
    enterMs:      280,
    exitMs:       260,
    exitBufferMs: 40,
    runId:        foundry.utils.randomID(),
  };

  log(`[BD][PassiveCardUI] enqueue: "${spec.title}" on ${tokenUuid}`);
  await enqueueCard(spec);
}

// ── Boot / socket registration ───────────────────────────────────────
//
// Call once on the `ready` hook (all clients). Registers the socket
// action handler that renders cards on every connected client and warms
// the passive card audio cache.

export function initPassiveCardUi() {
  // Warm the SFX cache at boot so first-play has no fetch latency.
  // Deferred 4 s to match the director's own preloadDirectorSfx schedule.
  setTimeout(() => preloadSfx([PASSIVE_CARD_SFX_URL]).catch(() => {}), 4000);

  // Drain fn for the GM's local queue path:
  //   1. Play SFX on the GM client.
  //   2. Broadcast card spec to all other clients via socket.
  //   3. Render card locally on the GM — resolves after enter animation.
  setCardDrainFn(async (spec) => {
    playSfx(PASSIVE_CARD_SFX_URL, 0.3);
    try {
      _socket?.executeForOthers?.(ACTION_KEY, spec);
    } catch (e) {
      warn("[BD][PassiveCardUI] executeForOthers failed", e);
    }
    await renderCardLocal(spec);
  });

  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("[BD][PassiveCardUI] socketlib unavailable — passive cards are local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    // Handler on every non-GM client: play SFX + render the card.
    _socket.register(ACTION_KEY, async (spec) => {
      playSfx(PASSIVE_CARD_SFX_URL, 0.3);
      await renderCardLocal(spec);
    });
    log("[BD][PassiveCardUI] socket registered");
  } catch (e) {
    warn("[BD][PassiveCardUI] init failed", e);
  }
}
