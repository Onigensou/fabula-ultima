// ============================================================================
// Lightning Crystal countdown — the number floating over each crystal.
//
// The crystal's whole mechanic is "how many turns are left", so that number is
// drawn large, directly above the crystal's RENDERED sprite, on every client.
//
//   - white while there is time, amber at 3 or less, pulsing red at 1
//   - a quick pop every time the number changes
//   - a floating "+N" when a hit buys time
//
// ── Why there is no socket here ─────────────────────────────────────────────
//
// The countdown IS an Active Effect on the crystal (see
// events/lightning-crystal.js), and Foundry replicates Active Effects to every
// client on its own. So each client derives its own badge from
// createActiveEffect / updateActiveEffect / deleteActiveEffect plus a
// canvasReady rescan — nothing to desync, and an F5 mid-battle re-derives the
// right number from the world. Same contract as the Lightning Rod cursor,
// which this file is modelled on (positioning, z-order, visibility rules and
// the boot sweep are all that file's, for that file's reasons).
//
// Self-scoping: the AE only exists while a crystal does, so this costs nothing
// in every other fight and needs no teardown call from the event.
//
// Not a manifest entry on its own account: imported by director-boot.js and
// initialised from its ready hook.
// ============================================================================

const FLAG_NS = "fabula-ultima-companion";
const TAG = "[FU][CrystalCountdown]";
const STYLE_ID = "fud-crystal-countdown-style";

const log = (...a) => console.debug(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

/** The AE's name. Mirrors events/lightning-crystal.js's COUNTDOWN_AE_NAME. */
const COUNTDOWN_AE_NAME = "Crystal Countdown";

// Above canvas/#hud, below Foundry app windows (z >= 100). Same as the Rod cursor.
const BADGE_Z_INDEX = 60;

/** Gap in screen px between the sprite's top edge and the badge. */
const BADGE_GAP = 4;

/** At or below this the number turns amber; at or below DANGER it pulses red. */
const WARN_AT = 3;
const DANGER_AT = 1;

const FADE_MS = 500;
const POP_MS = 420;
const GAIN_MS = 1500;

const _badges = new Map(); // tokenId -> { el, num, cap, value, missingFrames }
let _tickerOn = false;
let _hooksOn = false;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  // No backticks inside this block — it is a template literal.
  // The outline is an 8-way text-shadow, not -webkit-text-stroke + paint-order:
  // Foundry desktop (Chromium 122) paints the stroke OVER the fill.
  const outline = [
    "-2px -2px 0 #0b0714", "2px -2px 0 #0b0714", "-2px 2px 0 #0b0714", "2px 2px 0 #0b0714",
    "0 -2px 0 #0b0714", "0 2px 0 #0b0714", "-2px 0 0 #0b0714", "2px 0 0 #0b0714",
  ].join(", ");
  const css = `
.fud-crystal-count {
  position: fixed;
  transform: translate(-50%, -100%);
  z-index: ${BADGE_Z_INDEX};
  pointer-events: none;
  transition: opacity ${FADE_MS}ms ease-in-out;
  text-align: center;
  font-family: "Signika", "Arial Black", sans-serif;
  font-weight: 800;
  line-height: 1;
}
.fud-crystal-count .num {
  display: inline-block;
  font-size: 40px;
  color: #f4f1ff;
  text-shadow: ${outline}, 0 0 10px rgba(168,85,247,.9);
  transition: color 300ms ease-in-out;
}
.fud-crystal-count .cap {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #d9ccff;
  text-shadow: ${outline};
}
.fud-crystal-count.is-warn .num { color: #ffc34d; text-shadow: ${outline}, 0 0 10px rgba(255,170,40,.9); }
.fud-crystal-count.is-danger .num {
  color: #ff5a4d;
  text-shadow: ${outline}, 0 0 12px rgba(255,60,40,.95);
  animation: fud-crystal-pulse 900ms ease-in-out infinite;
}
.fud-crystal-count .num.is-pop { animation: fud-crystal-pop ${POP_MS}ms ease-out; }
.fud-crystal-count.is-danger .num.is-pop {
  animation: fud-crystal-pop ${POP_MS}ms ease-out, fud-crystal-pulse 900ms ease-in-out ${POP_MS}ms infinite;
}
.fud-crystal-count .gain {
  position: absolute;
  left: 100%;
  top: 0;
  margin-left: 4px;
  font-size: 24px;
  color: #8ef0a4;
  text-shadow: ${outline};
  white-space: nowrap;
  animation: fud-crystal-gain ${GAIN_MS}ms ease-out forwards;
}
@keyframes fud-crystal-pop {
  0%   { scale: 1; }
  35%  { scale: 1.45; }
  100% { scale: 1; }
}
@keyframes fud-crystal-pulse {
  0%, 100% { scale: 1; }
  50%      { scale: 1.16; }
}
@keyframes fud-crystal-gain {
  0%   { opacity: 0; translate: 0 6px; }
  15%  { opacity: 1; translate: 0 0; }
  70%  { opacity: 1; translate: 0 -14px; }
  100% { opacity: 0; translate: 0 -22px; }
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// The token's RENDERED sprite rectangle in client coordinates — see the Rod
// cursor's helper of the same name for why this is not the grid square.
function spriteClientBounds(token) {
  const rect = canvas.app.view.getBoundingClientRect();
  try {
    const b = token.mesh?.getBounds?.();
    if (b && b.width > 0 && b.height > 0) {
      return { left: rect.left + b.x, top: rect.top + b.y, width: b.width, height: b.height };
    }
  } catch { /* fall through to nominal bounds */ }
  const wt = canvas.stage.worldTransform;
  const tl = new PIXI.Point(); wt.apply({ x: token.x, y: token.y }, tl);
  const br = new PIXI.Point(); wt.apply({ x: token.x + (token.w ?? 100), y: token.y + (token.h ?? 100) }, br);
  return { left: rect.left + tl.x, top: rect.top + tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

export function isCountdownAe(effect) {
  return String(effect?.name ?? "").trim() === COUNTDOWN_AE_NAME;
}

/** The number to show for this actor, or null when it has none to show. */
function countdownOf(actor) {
  try {
    const ae = actor?.effects?.find?.((e) => isCountdownAe(e) && !e.disabled);
    if (!ae) return null;
    const f = ae.flags?.[FLAG_NS] ?? {};
    if (f.crystalSpent === true) return null;
    const n = Number(f.crystalCountdown);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function applyValue(rec, value, { animate = true } = {}) {
  const prev = rec.value;
  rec.value = value;
  rec.num.textContent = String(value);
  rec.cap.textContent = value === 1 ? "turn" : "turns";
  rec.el.classList.toggle("is-warn", value <= WARN_AT && value > DANGER_AT);
  rec.el.classList.toggle("is-danger", value <= DANGER_AT);
  if (!animate || prev == null || prev === value) return;

  // Restart the pop: removing and re-adding the class in one frame does
  // nothing unless the style is flushed in between.
  rec.num.classList.remove("is-pop");
  void rec.num.offsetWidth;
  rec.num.classList.add("is-pop");

  if (value > prev) {
    const gain = document.createElement("div");
    gain.className = "gain";
    gain.textContent = `+${value - prev}`;
    rec.el.appendChild(gain);
    setTimeout(() => { try { gain.remove(); } catch { /* badge gone */ } }, GAIN_MS + 50);
  }
}

function buildBadge(token, value, { fadeIn = true } = {}) {
  ensureStyles();
  const el = document.createElement("div");
  el.className = "fud-crystal-count";
  const num = document.createElement("div");
  num.className = "num";
  const cap = document.createElement("div");
  cap.className = "cap";
  el.append(num, cap);
  if (fadeIn) el.style.opacity = "0";
  document.body.appendChild(el);
  if (fadeIn) void el.offsetWidth;
  const rec = { el, num, cap, value: null, missingFrames: 0 };
  applyValue(rec, value, { animate: false });
  _badges.set(token.id, rec);
  if (!_tickerOn) { PIXI.Ticker.shared.add(badgeTick); _tickerOn = true; }
  return rec;
}

function removeBadge(tokenId) {
  const rec = _badges.get(tokenId);
  if (!rec) return;
  try { rec.el.remove(); } catch { /* already gone */ }
  _badges.delete(tokenId);
  if (!_badges.size && _tickerOn) {
    try { PIXI.Ticker.shared.remove(badgeTick); } catch { /* never added */ }
    _tickerOn = false;
  }
}

function badgeTick() {
  if (!_badges.size) return;
  for (const [tokenId, rec] of _badges) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) {
      // Placeables rebuild across canvas redraws — short grace before drop.
      if (++rec.missingFrames > 30) removeBadge(tokenId);
      else rec.el.style.opacity = "0";
      continue;
    }
    rec.missingFrames = 0;
    const b = spriteClientBounds(token);
    rec.el.style.left = `${b.left + b.width / 2}px`;
    rec.el.style.top = `${b.top - BADGE_GAP}px`;
    // A crystal the viewer cannot see must not be given away by its number.
    rec.el.style.opacity = token.visible === false ? "0" : "1";
  }
}

/** Re-derive the badge across every canvas token of `actor`. */
function syncActorBadge(actor, { fadeIn = true } = {}) {
  if (!actor) return;
  const value = countdownOf(actor);
  let tokens = [];
  try { tokens = actor.getActiveTokens?.(true) ?? []; } catch { /* no canvas */ }
  for (const token of tokens) {
    if (value == null) { removeBadge(token.id); continue; }
    const rec = _badges.get(token.id);
    if (!rec) buildBadge(token, value, { fadeIn });
    else applyValue(rec, value);
  }
}

function rescanCanvas() {
  const wasShown = new Set(_badges.keys());
  for (const rec of _badges.values()) { try { rec.el.remove(); } catch { /* already gone */ } }
  _badges.clear();
  if (_tickerOn) {
    try { PIXI.Ticker.shared.remove(badgeTick); } catch { /* never added */ }
    _tickerOn = false;
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token?.actor) syncActorBadge(token.actor, { fadeIn: !wasShown.has(token.id) });
  }
  log(`rescan — ${_badges.size} badge(s) on ${canvas?.scene?.name ?? "?"}`);
}

/** Exported for manual probing / recovery (FUCompanion console use). */
export function rescanCrystalCountdowns() { rescanCanvas(); }

/** Idempotent — called on every client from director-boot's ready hook. */
export function initLightningCrystalCountdown() {
  if (_hooksOn) return;
  _hooksOn = true;

  const onAeEvent = (effect) => {
    if (isCountdownAe(effect) && effect.parent?.documentName === "Actor") {
      try { syncActorBadge(effect.parent); }
      catch (e) { warn("AE sync threw", e); }
    }
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);

  Hooks.on("deleteToken", (tokenDoc) => {
    try { removeBadge(tokenDoc?.id); } catch { /* nothing mounted */ }
  });

  Hooks.on("canvasReady", () => {
    setTimeout(() => { try { rescanCanvas(); } catch (e) { warn("canvasReady rescan threw", e); } }, 250);
  });

  if (canvas?.ready) rescanCanvas();
  setTimeout(() => { try { rescanCanvas(); } catch (e) { warn("deferred boot rescan threw", e); } }, 3000);

  log("watcher installed");
}
