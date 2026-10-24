// scripts/inn-system/innOpen-const.js
// Inn NPC — an actor flagged system.props.isInn. Approaching one shows a 🛏
// Rest button; Rest runs the camp loop in the lobby's linked camp scene,
// Short Rest restores HP/MP and cures ailments on the spot.
// Design: docs/inn-camp-set-out-design.md

export const INN = {
  TAG: "[FU][Inn]",
  MODULE_ID: "fabula-ultima-companion",
  SOCKET_CH: "module.fabula-ultima-companion",
  MSG: {
    REQ:    "FU_INN_REQ",     // client → primary GM { mode, sceneId, innTokenId, userId }
    RESULT: "FU_INN_RESULT",  // primary GM → all    { userId, ok, message }
  },
  // Price per active party member, for Rest and Short Rest alike. Dungeon camp
  // tiles stay free — they never come through here.
  PRICE_PER_MEMBER: 20,
  ANIM_IN_MS: 180,
  ANIM_OUT_MS: 140,
};

export const gp = (obj, path, fallback = undefined) => {
  try { return foundry.utils.getProperty(obj, path) ?? fallback; } catch { return fallback; }
};

export const isInnActor = (actor) => gp(actor, "system.props.isInn", false) === true;

// A GM-hidden token is treated as absent: no proximity button, for GMs too.
export const isTokenHidden = (token) => token?.document?.hidden === true;

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

const zenitOf = (actor) => {
  const n = Number(gp(actor, "system.props.zenit", 0));
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
};

/**
 * Who pays for a night at the inn.
 *
 * Each member holding at least the price pays their own share. A member who
 * can't is covered WHOLE by the party coffer (the database actor's own zenit)
 * — no splitting a share between a member and the coffer. If the coffer can't
 * cover every short member, nobody is charged.
 *
 * @param {Actor[]} members  active party members
 * @param {Actor}   coffer   database actor
 * @returns {{ ok, total, price, own: Actor[], covered: Actor[], cofferNeed, cofferHas, reason }}
 */
export function planCharge(members, coffer, price = INN.PRICE_PER_MEMBER) {
  const own = [], covered = [];
  for (const m of members) (zenitOf(m) >= price ? own : covered).push(m);
  const cofferNeed = covered.length * price;
  const cofferHas  = coffer ? zenitOf(coffer) : 0;
  const ok = members.length > 0 && cofferNeed <= cofferHas;
  let reason = "";
  if (!members.length) reason = "No party members found.";
  else if (!ok) reason = `Not enough zenit — the party coffer needs ${cofferNeed}z to cover ${covered.map(a => a.name).join(", ")}, and holds ${cofferHas}z.`;
  return { ok, total: members.length * price, price, own, covered, cofferNeed, cofferHas, reason };
}

/** Apply a plan from planCharge(). Primary GM only; caller re-plans first. */
export async function applyCharge(plan, coffer) {
  for (const m of plan.own) {
    await m.update({ "system.props.zenit": zenitOf(m) - plan.price });
  }
  if (plan.cofferNeed > 0 && coffer) {
    await coffer.update({ "system.props.zenit": zenitOf(coffer) - plan.cofferNeed });
  }
}
