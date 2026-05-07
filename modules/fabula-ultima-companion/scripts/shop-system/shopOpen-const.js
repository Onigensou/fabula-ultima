// scripts/shop-open/shopopen-const.js

export const SHOPOPEN = {
  TAG: "[FU][ShopOpen]",
  CHANNELS: ["fabula-ultima-companion", "module.fabula-ultima-companion"],

  MSG: {
    OPEN_REQ:   "FU_SHOP_OPEN_REQ_V1",
    OPEN_GRANT: "FU_SHOP_OPEN_GRANT_V1",
    CLOSE_REQ:  "FU_SHOP_CLOSE_REQ_V1",
  },

  // Animation
  ANIM_IN_MS: 180,
  ANIM_OUT_MS: 140,
};

export const gp = (obj, path, fallback = undefined) => {
  try { return getProperty(obj, path) ?? fallback; } catch { return fallback; }
};

export const normActorId = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith("Actor.") ? s.slice("Actor.".length) : s;
};

export const isShopActor = (actor) => gp(actor, "system.props.isShop", false) === true;

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
