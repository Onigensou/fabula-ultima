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
import { pWait } from "../presentation-clock.js";
import { flashStatusLocal } from "../status-pop.js";

export { passiveCardQueue };

const MODULE_ID  = "fabula-ultima-companion";
const ACTION_KEY = "FU_DIRECTOR_PASSIVE_CARD_SHOW";
const ACTION_TICK = "FU_DIRECTOR_STATUS_TICK_FLASH";   // GM → others: a status's own tick fired

export const PASSIVE_CARD_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/passive_card.wav";

const STYLE_ID   = "fud-passive-card-style-v1";
const ROOT_ID    = "fud-passive-card-root";
const ACTIVE_KEY = "__FUD_PASSIVE_CARD_ACTIVE__";

let _socket = null;

// Presentation dwell — zero while hidden. This gates the card QUEUE drain, so
// on a backgrounded client the queue empties immediately instead of holding
// every pending card for its full enter/hold/exit and flushing them in a burst
// on refocus. The queue's promise contract is unchanged.
const wait = pWait;

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
/* Bravely Default II band (token status plan "G + E", 2026-10-27): a soft
   black band across the actor's waist, no border, one line per passive. The
   feet stay free for the NPC status strip; results pop above the head. */
.fud-passive-card {
  position: absolute; left: 0; top: 0;
  transform: translate(-50%, -50%);
  pointer-events: none;
  display: grid; gap: 3px;
  padding: 5px 36px;
  background: linear-gradient(90deg, rgba(6,5,4,0), rgba(6,5,4,0.84) 16%, rgba(6,5,4,0.84) 84%, rgba(6,5,4,0));
  color: #ffffff;
  font-family: 'Signika', 'Palatino Linotype', serif;
  opacity: 0;
  will-change: transform, opacity;
  white-space: nowrap;
}
.fud-passive-card::before, .fud-passive-card::after {
  content: ""; position: absolute; left: 14%; right: 14%; height: 1px;
  background: linear-gradient(90deg, rgba(226,194,126,0), rgba(226,194,126,0.75), rgba(226,194,126,0));
}
.fud-passive-card::before { top: 0; }
.fud-passive-card::after { bottom: 0; }
.fud-passive-card .fud-pc-row {
  display: flex; align-items: center; gap: 7px;
  font-size: 16px; font-weight: 400; line-height: 1.15;
  letter-spacing: 0.01em;
  text-shadow: 0 1px 0 rgba(0,0,0,0.65), 0 0 6px rgba(0,0,0,0.6);
}
.fud-passive-card .fud-pc-row.is-added { animation: fudPassiveCardLine .3s cubic-bezier(0.22,1,0.36,1) both; }
.fud-passive-card .fud-pc-icon { flex: none; display: inline-flex; font-size: 15px; line-height: 1; }
/* max-width: none — Foundry's global img { max-width: 100% } collapses a large
   icon to 0 px inside this shrink-to-fit row (only tiny GIFs survived). */
.fud-passive-card .fud-pc-img {
  display: block; flex: none; width: 20px; height: 20px; max-width: none; object-fit: cover; border-radius: 4px;
  border: 1.5px solid #e2c27e; background: #1a140f;
}
.fud-passive-card.enter {
  animation: fudPassiveCardIn var(--fud-pc-in-ms, 280ms) cubic-bezier(0.22,1,0.36,1) forwards;
}
.fud-passive-card.exit {
  animation: fudPassiveCardOut var(--fud-pc-out-ms, 260ms) cubic-bezier(0.4,0,1,1) forwards;
}
@keyframes fudPassiveCardIn {
  0%   { opacity: 0; transform: translate(-62%, -50%); }
  100% { opacity: 1; transform: translate(-50%, -50%); }
}
@keyframes fudPassiveCardOut {
  0%   { opacity: 1; transform: translate(-50%, -50%); }
  100% { opacity: 0; transform: translate(-62%, -50%); }
}
@keyframes fudPassiveCardLine {
  0%   { opacity: 0; transform: translateX(-10px); }
  100% { opacity: 1; transform: none; }
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

  // STACK, don't replace: a second passive on the same token while its card
  // is still up becomes a new line in that card (Bravely Default II's
  // "Revenge / Solar-Powered") and the hold restarts. A card already on its
  // way out is replaced as before.
  const live = getActiveMap().get(tokenUuid);
  if (live && !live.exiting && live.card?.isConnected) {
    const added = buildRow(title, icon);
    added.classList.add("is-added");
    live.card.appendChild(added);
    live.holdUntil = performance.now() + holdMs;
    await wait(enterMs);
    return;
  }
  cleanupExisting(tokenUuid);

  const card = document.createElement("div");
  card.className = "fud-passive-card enter";
  card.style.setProperty("--fud-pc-in-ms", `${enterMs}ms`);
  card.style.setProperty("--fud-pc-out-ms", `${exitMs}ms`);
  card.appendChild(buildRow(title, icon));
  root.appendChild(card);

  // Waist of the token: the feet belong to the NPC status strip.
  const entry = { card, tickerFn: null, runId, dy: 0, exiting: false, holdUntil: 0 };
  const updatePosition = () => {
    if (!card.isConnected || !token || token.destroyed || !canvas?.app?.view) return;
    const rect = canvas.app.view.getBoundingClientRect();
    const globalPos = token.toGlobal(new PIXI.Point(token.w / 2, token.h * WAIST_FRACTION));
    card.style.left = (rect.left + globalPos.x) + "px";
    card.style.top  = (rect.top  + globalPos.y + entry.dy) + "px";
  };
  entry.tickerFn = updatePosition;

  canvas.app.ticker.add(updatePosition);
  updatePosition();
  entry.dy = neighbourOffset(card, tokenUuid);
  updatePosition();
  getActiveMap().set(tokenUuid, entry);

  // Resolve here — queue proceeds to the next card; hold+exit continue in bg.
  await wait(enterMs);

  ;(async () => {
    try {
      // Hold until the last stacked line has had its full hold. pWait returns
      // at once on a hidden tab, so a wait that took no time ends the hold
      // instead of spinning.
      entry.holdUntil = Math.max(entry.holdUntil, performance.now() + holdMs);
      for (;;) {
        const rem = entry.holdUntil - performance.now();
        if (rem <= 0) break;
        const t0 = performance.now();
        await wait(Math.min(rem, 250));
        if (performance.now() - t0 < 5) break;
      }
      entry.exiting = true;
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

const WAIST_FRACTION = 0.58;

function buildRow(title, icon) {
  const row = document.createElement("div");
  row.className = "fud-pc-row";
  const iconEl = document.createElement("span");
  iconEl.className = "fud-pc-icon";
  const iconStr = String(icon ?? "📜");
  // Any file path is a picture — a world-local asset ("worlds/…/x.png") used to
  // fall through to the text branch and print its whole path on the card.
  if (/^(https?:|data:|\/|[\w.-]+\/)/.test(iconStr) || /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(iconStr)) {
    const img = document.createElement("img");
    img.className = "fud-pc-img";
    img.onerror = () => img.remove();   // a broken icon leaves no empty frame
    img.src = iconStr;
    iconEl.appendChild(img);
  } else {
    iconEl.textContent = iconStr;
  }
  const nameEl = document.createElement("span");
  nameEl.className = "fud-pc-name";
  nameEl.textContent = String(title);
  row.appendChild(iconEl);
  row.appendChild(nameEl);
  return row;
}

// Neighbours firing together: a new card never covers one already up; it
// drops just below it. Returns the extra px for this card's top.
function neighbourOffset(card, tokenUuid) {
  let dy = 0;
  const me = card.getBoundingClientRect();
  for (const [uuid, other] of getActiveMap()) {
    if (uuid === tokenUuid || !other?.card?.isConnected || other.exiting) continue;
    const o = other.card.getBoundingClientRect();
    const top = me.top + dy, bottom = me.bottom + dy;
    if (me.left < o.right && me.right > o.left && top < o.bottom && bottom > o.top) dy += (o.bottom - top) + 4;
  }
  return dy;
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

// ── Status tick (token status plan "G + E") ──────────────────────────
//
// A status's own clock tick (Burn at turn start, Regen…) is not a passive:
// it gets no card. The bearer's pip / strip tile flashes on every client
// instead; the damage number already carries the amount.
export function broadcastStatusTick({ casterToken, name } = {}) {
  const tokenUuid = casterToken?.document?.uuid ?? casterToken?.uuid ?? null;
  if (!tokenUuid || !name) return;
  const spec = { tokenUuid, name: String(name) };
  try { _socket?.executeForOthers?.(ACTION_TICK, spec); }
  catch (e) { warn("[BD][PassiveCardUI] tick broadcast failed", e); }
  flashStatusLocal(spec);
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
    _socket.register(ACTION_TICK, (spec) => flashStatusLocal(spec ?? {}));
    log("[BD][PassiveCardUI] socket registered");
  } catch (e) {
    warn("[BD][PassiveCardUI] init failed", e);
  }
}
