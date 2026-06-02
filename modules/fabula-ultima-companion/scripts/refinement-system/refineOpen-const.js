// scripts/refinement-system/refineOpen-const.js

export const REFINEOPEN = {
  TAG: "[FU][RefineOpen]",
  ANIM_IN_MS: 180,
  ANIM_OUT_MS: 140,
};

export const gp = (obj, path, fallback = undefined) => {
  try { return foundry.utils.getProperty(obj, path) ?? fallback; } catch { return fallback; }
};

export const isBlacksmithActor = (actor) =>
  gp(actor, "system.props.isBlacksmith", false) === true;

export const normActorId = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith("Actor.") ? s.slice("Actor.".length) : s;
};

export function getCenterPx(token, overrideXY = null) {
  const doc  = token?.document;
  const baseX = overrideXY?.x ?? doc?.x ?? token?.x ?? 0;
  const baseY = overrideXY?.y ?? doc?.y ?? token?.y ?? 0;
  return { x: baseX + (token?.w ?? 0) / 2, y: baseY + (token?.h ?? 0) / 2 };
}

export function distPxCenters(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
