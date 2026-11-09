// ============================================================================
// Soul Fragment badge — the fragment's current HP, floating over its sprite.
//
// Current HP is exactly what the next Calling will steal, so it is the number the
// players plan around and it stays on screen. It is plain HP, not Study
// information. Derived per client from the token actor's own props, with no
// socket: the same contract and positioning as lightning-crystal-countdown.js.
// ============================================================================

const FLAG_NS = "fabula-ultima-companion";
const STYLE_ID = "fud-soul-fragment-style";
const TAG = "[FU][SoulFragmentBadge]";

const BADGE_Z_INDEX = 60;
const BADGE_GAP = 4;
const POP_MS = 420;

const _badges = new Map(); // tokenId -> { el, num, value, missingFrames }
let _tickerOn = false;
let _hooksOn = false;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const outline = ["-2px -2px 0 #06140c", "2px -2px 0 #06140c", "-2px 2px 0 #06140c", "2px 2px 0 #06140c"].join(", ");
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.fud-soul-hp {
  position: fixed;
  transform: translate(-50%, -100%);
  z-index: ${BADGE_Z_INDEX};
  pointer-events: none;
  text-align: center;
  font-family: "Signika", "Arial Black", sans-serif;
  font-weight: 800;
  line-height: 1;
}
.fud-soul-hp .num {
  display: inline-block;
  font-size: 26px;
  color: #d8ffe6;
  text-shadow: ${outline}, 0 0 10px rgba(79,191,122,.9);
}
.fud-soul-hp .cap {
  display: block;
  margin-top: 1px;
  font-size: 9px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #b9f0cd;
  text-shadow: ${outline};
}
.fud-soul-hp .num.is-pop { animation: fud-soul-pop ${POP_MS}ms ease-out; }
@keyframes fud-soul-pop {
  0%   { scale: 1; }
  35%  { scale: 1.4; }
  100% { scale: 1; }
}`.trim();
  document.head.appendChild(style);
}

function spriteClientBounds(token) {
  const rect = canvas.app.view.getBoundingClientRect();
  try {
    const b = token.mesh?.getBounds?.();
    if (b && b.width > 0 && b.height > 0) return { left: rect.left + b.x, top: rect.top + b.y, width: b.width };
  } catch { /* fall through */ }
  const tl = new PIXI.Point();
  canvas.stage.worldTransform.apply({ x: token.x, y: token.y }, tl);
  return { left: rect.left + tl.x, top: rect.top + tl.y, width: token.w ?? 100 };
}

function removeBadge(tokenId) {
  const rec = _badges.get(tokenId);
  if (!rec) return;
  try { rec.el.remove(); } catch { /* already gone */ }
  _badges.delete(tokenId);
  if (!_badges.size && _tickerOn) {
    try { PIXI.Ticker.shared.remove(tick); } catch { /* never added */ }
    _tickerOn = false;
  }
}

function tick() {
  for (const [tokenId, rec] of _badges) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) {
      if (++rec.missingFrames > 30) removeBadge(tokenId);
      else rec.el.style.opacity = "0";
      continue;
    }
    rec.missingFrames = 0;
    const b = spriteClientBounds(token);
    rec.el.style.left = `${b.left + b.width / 2}px`;
    rec.el.style.top = `${b.top - BADGE_GAP}px`;
    // hidden with its token while the Soul Tithe show has not revealed it yet (soul-fx)
    const held = globalThis.__FU_SOUL_FX__?.isHeld?.(tokenId) === true;
    rec.el.style.opacity = token.visible === false || held ? "0" : "1";
  }
}

function syncToken(token) {
  const doc = token?.document;
  if (doc?.flags?.[FLAG_NS]?.soulFragment !== true) return;
  const hp = Math.floor(Number(token.actor?.system?.props?.current_hp));
  if (!Number.isFinite(hp) || hp <= 0) { removeBadge(token.id); return; }

  let rec = _badges.get(token.id);
  if (!rec) {
    ensureStyles();
    const el = document.createElement("div");
    el.className = "fud-soul-hp";
    const num = document.createElement("div");
    num.className = "num";
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = "HP";
    el.append(num, cap);
    document.body.appendChild(el);
    rec = { el, num, value: null, missingFrames: 0 };
    _badges.set(token.id, rec);
    if (!_tickerOn) { PIXI.Ticker.shared.add(tick); _tickerOn = true; }
  }
  if (rec.value === hp) return;
  const changed = rec.value != null;
  rec.value = hp;
  rec.num.textContent = String(hp);
  if (changed) {
    rec.num.classList.remove("is-pop");
    void rec.num.offsetWidth;
    rec.num.classList.add("is-pop");
  }
}

function rescan() {
  for (const id of [..._badges.keys()]) removeBadge(id);
  for (const token of canvas?.tokens?.placeables ?? []) syncToken(token);
}

/** Idempotent — called on every client from director-boot's ready hook. */
export function initSoulFragmentBadge() {
  if (_hooksOn) return;
  _hooksOn = true;

  const onActor = (actor) => {
    try { for (const t of actor?.getActiveTokens?.(true) ?? []) syncToken(t); }
    catch (e) { console.warn(TAG, "actor sync threw", e); }
  };
  Hooks.on("updateActor", onActor);
  // An unlinked token's HP arrives as a delta update on some paths.
  Hooks.on("updateActorDelta", (delta) => {
    try { onActor(delta?.parent?.actor ?? null); } catch { /* nothing mounted */ }
  });
  Hooks.on("updateToken", (doc) => {
    try { if (doc?.object) syncToken(doc.object); } catch { /* not drawn yet */ }
  });
  Hooks.on("deleteToken", (doc) => { try { removeBadge(doc?.id); } catch { /* nothing mounted */ } });
  Hooks.on("canvasReady", () => { setTimeout(() => { try { rescan(); } catch (e) { console.warn(TAG, "rescan threw", e); } }, 250); });
  if (canvas?.ready) rescan();
}
