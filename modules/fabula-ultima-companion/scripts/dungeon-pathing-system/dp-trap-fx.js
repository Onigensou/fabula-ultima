// ============================================================================
// Dungeon Trap — what the players see (every client, local). Approved mockup
// v2, 2026-11-10: https://claude.ai/artifact/EgW2YkyzCqX3PDokaiSLQY
//
//   0 ms        the tile's SFX; the party token wears the shown character's
//               sprite_hurt for ~1 s with a white hit flash (sprite-facing)
//   60 ms +120  one face + −N per member over the token, battle-number style;
//               RESIST / IMMUNE tag above a resisted / immune hit
//   same beat   that member's dungeon HUD row pulses (dp-status-hud pulse)
//
// No screen flash, no ring, no message, no chat card (all removed on review:
// players cross these tiles often). The GM previews the outcome and calls
// play() everywhere (dp-tile-effect-engine.js); the client that stepped on
// the tile has already played impact() itself, so it skips that part.
//
//   DungeonPathing.TrapFx.impact({ tokenId, sfxUrl })
//   DungeonPathing.TrapFx.play({ sceneId, tokenId, sfxUrl, rows, triggerUserId })
// ============================================================================

const TAG = "[DungeonPathing][TrapFx]";
const STYLE_ID = "oni-trap-fx-style";
const DELAY_MS = 60;
const STAGGER_MS = 120;
const LIFETIME_MS = 1150;
// Cascade like a chain hit (director-damage-numbers CASCADE_STEPS), spread
// wider sideways so the faces do not overlap.
const CASCADE = [[-42, -54], [-14, -36], [14, -18], [42, 0]];
const SPREAD_X = 1.6;
const SFX_VOLUME = 0.8;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
.oni-trap-dn { position: fixed; z-index: 99991; pointer-events: none; transform: translate(-50%, -50%); }
.oni-trap-dn-riser { animation: oni-trap-rise ${LIFETIME_MS}ms cubic-bezier(.18,.7,.3,1) forwards, oni-trap-fade ${LIFETIME_MS}ms ease-in forwards; }
.oni-trap-dn-inner { display: flex; flex-direction: column; align-items: center; gap: 2px; animation: oni-trap-pop 240ms cubic-bezier(.2,1.55,.4,1) both; }
.oni-trap-dn-row { display: flex; align-items: center; gap: 6px; }
.oni-trap-dn-face { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; object-position: 50% 12%;
  border: 2px solid #1a1a1a; box-shadow: 0 0 0 1.5px #d5b67a; background: #2a2620; }
.oni-trap-dn-num { font-family: 'Arial Black', 'Segoe UI', system-ui, Arial, sans-serif; font-weight: 900; font-style: italic; line-height: 1;
  transform: skewX(-8deg); color: var(--c, #fff); font-size: var(--s, 32px);
  -webkit-text-stroke: 2.5px #1a1a1a; paint-order: stroke fill;
  text-shadow: 0 3px 0 rgba(0,0,0,.55), 0 0 10px rgba(0,0,0,.3); }
.oni-trap-dn-tag { font-family: 'Bebas Neue', 'Oswald', 'Haettenschweiler', 'Impact', sans-serif; font-weight: 700; font-style: italic;
  letter-spacing: 1.5px; font-size: 16px; line-height: 1.1; color: #fff; padding: 1px 9px 2px; transform: skewX(-9deg);
  text-shadow: 0 2px 0 rgba(0,0,0,.5); box-shadow: 0 2px 0 rgba(0,0,0,.35); background: #3a5b80; }
.oni-trap-dn-tag.is-zero { background: #2a3140; }
@keyframes oni-trap-rise { 0% { transform: translateY(10px); } 16% { transform: translateY(0); } 100% { transform: translateY(-54px); } }
@keyframes oni-trap-fade { 0%, 68% { opacity: 1; } 100% { opacity: 0; } }
@keyframes oni-trap-pop { 0% { transform: scale(.25); } 62% { transform: scale(1.16); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .oni-trap-dn-inner { animation: none; } }
`;
  document.head.appendChild(css);
}

function partyToken(tokenId) {
  if (tokenId) {
    const t = canvas?.tokens?.get(tokenId);
    if (t) return t;
  }
  const st = globalThis.__ONI_DUNGEON_PATHING__?.state;
  const id = st?.partyToken?.id ?? st?.partyTokenId;
  return id ? canvas?.tokens?.get(id) ?? null : null;
}

// Screen point just above the sprite's head.
function headPoint(token) {
  try {
    const meshH = Math.abs(token.mesh?.height || token.h || 100);
    const world = { x: token.center.x, y: token.center.y - meshH / 2 };
    const p = canvas.clientCoordinatesFromCanvas(world);
    return { x: p.x, y: p.y };
  } catch (e) {
    return null;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function spawnNumber(head, r, i) {
  const [dx, dy] = CASCADE[i % CASCADE.length];
  const shown = Number(r.shown) || 0;
  const size = Math.round((30 + Math.min(26, shown / 7)) * (r.resisted ? 0.82 : 1));
  const color = r.resisted ? "#8fb3d9" : r.immune ? "#bcd2e8" : "#ffffff";
  const tag = r.immune ? `<span class="oni-trap-dn-tag is-zero">IMMUNE</span>`
    : r.resisted ? `<span class="oni-trap-dn-tag">RESIST</span>`
    : shown === 0 ? `<span class="oni-trap-dn-tag is-zero">NO DAMAGE</span>` : "";
  const face = r.face ? `<img class="oni-trap-dn-face" alt="" src="${esc(r.face)}">` : "";
  const el = document.createElement("div");
  el.className = "oni-trap-dn";
  el.style.left = `${head.x + dx * SPREAD_X}px`;
  el.style.top = `${head.y - 24 + dy}px`;
  el.innerHTML = `<div class="oni-trap-dn-riser"><div class="oni-trap-dn-inner">${tag}<div class="oni-trap-dn-row">${face}`
    + `<span class="oni-trap-dn-num" style="--s:${size}px;--c:${color}">${shown ? "−" + shown : "0"}</span></div></div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), LIFETIME_MS + 100);
}

function playSfx(src) {
  if (!src) return;
  try {
    const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    AH?.play?.({ src, volume: SFX_VOLUME, autoplay: true, loop: false }, false);
  } catch (e) { console.warn(TAG, "SFX failed", e); }
}

// The hit itself: sound + hurt pose. Played at once on the client that stepped
// on the tile, and from play() everywhere else.
function impact({ tokenId, sfxUrl } = {}) {
  playSfx(sfxUrl);
  const token = partyToken(tokenId);
  if (token) {
    try { globalThis.FUCompanion?.api?.spriteFacing?.flashPose?.(token); }
    catch (e) { console.warn(TAG, "hurt pose failed", e); }
  }
}

function play(payload = {}) {
  const { sceneId, tokenId, sfxUrl, rows = [], triggerUserId } = payload;
  if (sceneId && canvas?.scene?.id !== sceneId) return;
  ensureStyle();
  if (triggerUserId !== game.user?.id) impact({ tokenId, sfxUrl });

  const list = Array.isArray(rows) ? rows : [];
  const token = partyToken(tokenId);
  const head = token ? headPoint(token) : null;
  if (head) list.forEach((r, i) => setTimeout(() => spawnNumber(head, r, i), DELAY_MS + i * STAGGER_MS));
  try { globalThis.DungeonPathing?.StatusHUD?.pulse?.(list, { delay: DELAY_MS, stagger: STAGGER_MS }); }
  catch (e) { console.warn(TAG, "HUD pulse failed", e); }
}

globalThis.DungeonPathing ??= {};
globalThis.DungeonPathing.TrapFx = Object.freeze({ impact, play });
