// scripts/shop-open/shopopen-const.js

export const SHOPOPEN = {
  TAG: "[FU][ShopOpen]",
  CHANNELS: ["fabula-ultima-companion", "module.fabula-ultima-companion"],

  MSG: {
    OPEN_REQ:    "FU_SHOP_OPEN_REQ_V1",
    OPEN_GRANT:  "FU_SHOP_OPEN_GRANT_V1",
    CLOSE_REQ:   "FU_SHOP_CLOSE_REQ_V1",
    BUY_REQ:     "FU_SHOP_BUY_REQ_V1",
    BUY_RESULT:  "FU_SHOP_BUY_RESULT_V1",
    SELL_REQ:    "FU_SHOP_SELL_REQ_V1",
    SELL_RESULT: "FU_SHOP_SELL_RESULT_V1",

    // Ephemeral "who's browsing what" — any client → all clients, no GM involved.
    PRESENCE_ENTER:  "FU_SHOP_PRESENCE_ENTER_V1",
    PRESENCE_LEAVE:  "FU_SHOP_PRESENCE_LEAVE_V1",
    PRESENCE_SELECT: "FU_SHOP_PRESENCE_SELECT_V1",
  },

  // Animation
  ANIM_IN_MS: 180,
  ANIM_OUT_MS: 140,
};

export const gp = (obj, path, fallback = undefined) => {
  try { return foundry.utils.getProperty(obj, path) ?? fallback; } catch { return fallback; }
};

export const normActorId = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith("Actor.") ? s.slice("Actor.".length) : s;
};

export const isShopActor = (actor) => gp(actor, "system.props.isShop", false) === true;

// A GM-hidden token is treated as absent: no proximity button, for GMs too.
// (Buttons are DOM overlays, so they don't inherit the token's canvas visibility.)
export const isTokenHidden = (token) => token?.document?.hidden === true;

export const ownershipObserver = () => {
  const lvl = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER;
  return Number.isFinite(lvl) ? lvl : 2;
};

export const ownershipNone = () => {
  const lvl = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE;
  return Number.isFinite(lvl) ? lvl : 0;
};

// Authoritative center in px (document-based). Optional override is {x,y} (doc coords).
export function getCenterPx(token, overrideXY = null) {
  const doc = token?.document;
  const baseX = overrideXY?.x ?? doc?.x ?? token?.x ?? 0;
  const baseY = overrideXY?.y ?? doc?.y ?? token?.y ?? 0;
  const w = token?.w ?? 0;
  const h = token?.h ?? 0;
  return { x: baseX + (w / 2), y: baseY + (h / 2) };
}

export function distPxCenters(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Tint a Foundry user colour for use as a row background (same treatment the
// camp system's activity select uses for other players' picks).
export function hexToRgba(hex, alpha) {
  const h = String(hex ?? "").replace("#", "");
  if (h.length < 6) return `rgba(138,96,48,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
