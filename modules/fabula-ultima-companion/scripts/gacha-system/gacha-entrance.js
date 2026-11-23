// ============================================================================
// Gacha System — Walk-up entrance (Hako)
// ----------------------------------------------------------------------------
// Any NPC whose actor carries flags[MODULE_ID].gachaVendor gets a round star
// button in the overhead row, next to Shop, when the party stands at their
// feet. Keyboard players get "Gachapon" in the Confirm menu (window.oni.Interact).
// The button opens the machine on THIS client only (FUCompanion.api.gacha.open).
//
// Range is the shared NPC rule (window.oni.Interact.npcInRange) Talk, Shop,
// Refine and the card duel all use. The pattern is fa-entry.js's ProxButtons.
//
// Who sees it: any party participant. Never the Spectator account (watch-only).
// Gacha is party-wide and only spends from the shared pool, so it is not gated
// on the Main Controller: anyone may walk up and browse.
// ============================================================================

import { GACHA, VENDOR_FLAG, log } from "./gacha-const.js";

const LAYER_ID = "gacha-entrance-layer";
const STYLE_ID = "gacha-entrance-style";
const ANIM_OUT_MS = 140;
// Shop sits on the NPC's centre line; the star docks to its right.
const OFFSET_X = 44, OFFSET_Y = 56;

const isSpectator = () => globalThis.FUCompanion?.api?.Spectator?.isSpectator?.() === true;
const runtime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
const isCampScene = (scene) => scene?.flags?.[GACHA.MODULE_ID]?.oniFabula?.general?.sceneMode === "camp";
const hidden = (t) => t?.document?.hidden === true;
const centerOf = (token, ov = null) => ({
  x: (ov?.x ?? token?.document?.x ?? token?.x ?? 0) + (token?.w ?? 0) / 2,
  y: (ov?.y ?? token?.document?.y ?? token?.y ?? 0) + (token?.h ?? 0) / 2,
});

export const isVendor = (actor) => !!actor?.getFlag?.(GACHA.MODULE_ID, VENDOR_FLAG);

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${LAYER_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 90; }
#${LAYER_ID} .gacha-prox-btn { pointer-events: auto; position: absolute; transform: translate(-50%, -50%) scale(0.75); opacity: 0;
  transition: transform 180ms cubic-bezier(.2,.9,.2,1), opacity 180ms cubic-bezier(.2,.9,.2,1);
  display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 999px;
  background: rgba(20,20,20,0.78); border: 1px solid rgba(255,255,255,0.25); box-shadow: 0 6px 18px rgba(0,0,0,0.35);
  cursor: pointer; user-select: none; font-size: 16px; color: #ffd56a; text-shadow: 0 0 6px rgba(255,200,80,.7); }
#${LAYER_ID} .gacha-prox-btn.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
#${LAYER_ID} .gacha-prox-btn.is-hiding { transform: translate(-50%, -50%) scale(0.75); opacity: 0; transition-duration: ${ANIM_OUT_MS}ms; }
#${LAYER_ID} .gacha-prox-btn:hover { transform: translate(-50%, -50%) scale(1.08); background: rgba(40,30,10,0.88); }
body.fu-gacha-open #${LAYER_ID} { visibility: hidden; }
`;
  document.head.appendChild(s);
}

function layer() {
  injectStyles();
  let el = document.getElementById(LAYER_ID);
  if (!el) { el = document.createElement("div"); el.id = LAYER_ID; document.body.appendChild(el); }
  return el;
}

// tokenId -> { el, state, timer }
const btns = new Map();
let desired = new Set();

function openFrom(tokenId) {
  const api = globalThis.FUCompanion?.api?.gacha;
  if (!api?.open) return;
  api.open({ source: "vendor", tokenId });
}

function show(tokenId) {
  const rec = btns.get(tokenId);
  if (rec) {
    if (rec.state === "hiding") { clearTimeout(rec.timer); rec.state = "shown"; rec.el.classList.remove("is-hiding"); rec.el.classList.add("is-visible"); }
    return;
  }
  const el = document.createElement("div");
  el.className = "gacha-prox-btn";
  el.title = "Gachapon";
  el.innerHTML = `<i class="fas fa-star"></i>`;
  el.dataset.tokenId = tokenId;
  el.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); openFrom(tokenId); });
  layer().appendChild(el);
  const r = { el, state: "showing", timer: null };
  btns.set(tokenId, r);
  requestAnimationFrame(() => { if (btns.get(tokenId) !== r) return; el.classList.add("is-visible"); r.state = "shown"; });
}

function hide(tokenId) {
  const rec = btns.get(tokenId);
  if (!rec || rec.state === "hiding") return;
  rec.state = "hiding"; rec.el.classList.add("is-hiding"); rec.el.classList.remove("is-visible");
  rec.timer = setTimeout(() => { if (desired.has(tokenId)) return; rec.el.remove(); btns.delete(tokenId); }, ANIM_OUT_MS + 20);
}

// Hako's Shop button honours per-actor offsets (shop_icon_offset_x/y), so the
// star docks to the Shop button itself when it is showing, and only falls back
// to its own offset from the token centre when it is not.
const SHOP_LAYER = "fu-shopopen-layer-v1";
function shopAnchor(tokenId) {
  const el = document.querySelector(`#${SHOP_LAYER} .fu-shop-btn[data-token-id="${tokenId}"]`);
  if (!el || el.classList.contains("is-hiding")) return null;
  const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function place() {
  const wt = canvas?.app?.stage?.worldTransform;
  if (!wt) return;
  for (const [id, rec] of btns) {
    const tok = canvas.tokens?.get(id);
    if (!tok) continue;
    const shop = shopAnchor(id);
    if (shop) {
      rec.el.style.left = `${shop.x + OFFSET_X}px`;
      rec.el.style.top  = `${shop.y}px`;
      continue;
    }
    const c = centerOf(tok);
    rec.el.style.left = `${c.x * wt.a + wt.tx + OFFSET_X}px`;
    rec.el.style.top  = `${c.y * wt.d + wt.ty - OFFSET_Y}px`;
  }
}
// Shop repositions on the same pan; run after it.
const placeSoon = () => requestAnimationFrame(place);

// ── who is "us" on this map ─────────────────────────────────────────────────

async function partyMemberIds() {
  const ids = new Set();
  const rtm = runtime();
  if (rtm?.state?.partyMemberIds?.size) for (const id of rtm.state.partyMemberIds) ids.add(id);
  try {
    const r = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
    if (r?.db?.id) ids.add(r.db.id);
    const props = r?.source?.system?.props ?? r?.db?.system?.props ?? {};
    for (const [k, v] of Object.entries(props)) {
      if (/^member_id_\d+$/i.test(k) && typeof v === "string") { const id = v.trim().replace(/^Actor\./, ""); if (id) ids.add(id); }
    }
  } catch {}
  return ids;
}

const pos = new Map();   // live walking positions, tokenId -> {x,y,ts}
function near(a, b) {
  const I = window.oni?.Interact;
  const ac = centerOf(a, pos.get(a.id)), bc = centerOf(b, pos.get(b.id));
  return I?.npcInRange ? I.npcInRange(a, ac, I.rectOf(b, bc), b) : Math.hypot(ac.x - bc.x, ac.y - bc.y) <= 140;
}

async function scan() {
  try {
    if (!canvas?.ready) return;
    const now = Date.now();
    for (const [id, o] of pos) if (now - o.ts > 800) pos.delete(id);

    const want = new Set();
    if (!isSpectator()) {
      const tokens = (canvas.tokens?.placeables ?? []).filter((t) => t?.actor && !hidden(t));
      const vendors = tokens.filter((t) => isVendor(t.actor));
      if (vendors.length) {
        const party = await partyMemberIds();
        const mine = isCampScene(canvas.scene) && !game.user.isGM
          ? [runtime()?.getFollowToken?.()].filter((t) => t?.actor)
          : tokens.filter((t) => party.has(t.actor.id));
        for (const v of vendors) if (mine.some((m) => m.id !== v.id && near(m, v))) want.add(v.id);
      }
    }
    desired = want;
    for (const id of want) show(id);
    for (const id of [...btns.keys()]) if (!want.has(id)) hide(id);
    place();
    placeSoon();   // Shop may create its button in this same frame
  } catch (e) { console.error("[FU][Gacha] entrance scan", e); }
}

let queued = false;
function queue() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => { queued = false; await scan(); }));
}

// ── GM helper ───────────────────────────────────────────────────────────────

/** Mark (or unmark) an NPC actor as a gacha vendor. GM only. */
export async function setVendor(actorOrUuid, on = true) {
  if (!game.user?.isGM) throw new Error("[FU][Gacha] setVendor is GM only.");
  const actor = typeof actorOrUuid === "string" ? await fromUuid(actorOrUuid) : actorOrUuid;
  if (actor?.documentName !== "Actor") throw new Error("[FU][Gacha] actor not found.");
  return on
    ? actor.setFlag(GACHA.MODULE_ID, VENDOR_FLAG, true)
    : actor.unsetFlag(GACHA.MODULE_ID, VENDOR_FLAG);
}

// ── install ─────────────────────────────────────────────────────────────────

let installed = false;
export function installEntrance() {
  if (installed) return;
  installed = true;

  window.oni?.Interact?.register?.("gacha", window.oni.Interact.tokenButtons?.(btns, {
    label: "Gachapon", icon: "fas fa-star", order: 22,
    run: (tokenId) => openFrom(tokenId),
  }) ?? (() => []));

  Hooks.on("updateToken", (doc, ch) => {
    const moved = "x" in ch || "y" in ch;
    if (!moved && !("hidden" in ch)) return;
    if (moved) pos.set(doc.id, { x: ch.x ?? doc.x, y: ch.y ?? doc.y, ts: Date.now() });
    queue();
  });
  Hooks.on("createToken", queue);
  Hooks.on("deleteToken", queue);
  Hooks.on("updateActor", (a, ch) => { if (ch?.flags?.[GACHA.MODULE_ID]) queue(); });
  Hooks.on("canvasReady", queue);
  Hooks.on("canvasPan", placeSoon);
  window.addEventListener("resize", placeSoon);
  setInterval(queue, 2000);   // party membership / follow token can change without movement
  queue();
  log("Walk-up entrance ready.");
}
