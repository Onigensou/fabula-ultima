// ============================================================================
// Polymorph — pure rules (no Foundry). Imported by polymorph-core.js and by
// polymorph-math.test.mjs.
//
// Agreed rules (user, 2026-11-12):
//   • HP AND MP use the same "Form Multiplier" (Dynamax-style ratio):
//       ratio = form max ÷ own max
//       m     = 1 + (ratio − 1) / 2, clamped to [1, 2]
//     Form max = own max × m. The bar keeps its FILL: current is scaled by the
//     same %. On revert only what CHANGED in form carries back (scaled by
//     own max ÷ form max; damage rounds in the player's favour, healing rounds
//     down; full → full, 0 → 0). Transforming can never heal or hurt you.
//   • Duration: until the GM activates a new map, or "your next 3 turns during
//     a conflict". The drink turn does not count. The counter ticks AT MOST
//     ONCE PER ROUND, at the end of the first turn the bearer takes that round,
//     so extra turns and free actions (Acceleration) are pure bonus form
//     actions, and a turn removed by Stop simply is not counted.
//   • The form keeps the PC's own activation count (never the monster's).
// ============================================================================

export const FORM_TURNS_IN_CONFLICT = 3;
export const MULT_MIN = 1;
export const MULT_MAX = 2;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Form Multiplier m for one resource (HP or MP). Bad input → 1 (no change). */
export function formMultiplier(ownMax, formMax) {
  const own = num(ownMax), form = num(formMax);
  if (own <= 0 || form <= 0) return 1;
  const ratio = form / own;
  return clamp(1 + (ratio - 1) / 2, MULT_MIN, MULT_MAX);
}

/**
 * Own pool → form pool. Max = round(ownMax × m). Current keeps the same fill,
 * never reaches 0 from a living value, never exceeds the new max.
 */
export function scaleIntoForm(ownCur, ownMax, m) {
  const oMax = Math.max(0, Math.round(num(ownMax)));
  const oCur = clamp(Math.round(num(ownCur)), 0, oMax);
  const mult = num(m) > 0 ? num(m) : 1;
  const max = Math.max(oMax, Math.round(oMax * mult));
  if (oMax <= 0) return { cur: 0, max };
  let cur = Math.round(oCur * max / oMax);
  if (oCur > 0) cur = Math.max(1, cur);
  return { cur: clamp(cur, 0, max), max };
}

/**
 * Form pool → own pool on revert. Uses the two real maxima (not m) so rounding
 * on the way in cannot drift. Rounded UP (player-friendly); 0 stays 0, a living
 * form never reverts to 0.
 */
export function scaleOutOfForm(formCur, formMax, ownMax, anchor = null) {
  const fMax = num(formMax), oMax = Math.max(0, Math.round(num(ownMax)));
  const fCur = Math.max(0, num(formCur));
  if (fMax <= 0 || oMax <= 0) return clamp(Math.round(fCur), 0, oMax);
  if (fCur <= 0) return 0;
  if (fCur >= fMax) return oMax;
  // Anchored (normal case): carry back only what CHANGED in form, scaled by
  // ownMax/formMax. Damage rounds toward the player (ceil of a negative),
  // healing rounds down — so an untouched form returns the exact value you
  // drank at, and repeated transform/revert can never farm HP.
  if (anchor && Number.isFinite(Number(anchor.ownStart)) && Number.isFinite(Number(anchor.formStart))) {
    const delta = (fCur - num(anchor.formStart)) * oMax / fMax;
    const carried = delta < 0 ? Math.ceil(delta - 1e-9) : Math.floor(delta + 1e-9);
    return clamp(num(anchor.ownStart) + carried, 1, oMax);
  }
  return clamp(Math.ceil(fCur * oMax / fMax - 1e-9), 1, oMax);
}

// ── Conflict turn counter ────────────────────────────────────────────────────
// State: { turnsLeft, countFromRound, lastTickRound }
//   countFromRound — first round whose turn may tick. Set at transform time:
//     the current round if the bearer has NOT yet ended a turn this round and it
//     is not the bearer's own turn (an ally gave the potion before they acted);
//     otherwise the next round (the drink turn does not count).
//   lastTickRound  — guards "at most once per round".

/** Counter for a form that starts during a conflict. */
export function newConflictCounter({ round, bearerActedOrActing, turns = FORM_TURNS_IN_CONFLICT } = {}) {
  const r = Math.trunc(num(round));
  return {
    turnsLeft: Math.max(1, Math.trunc(num(turns)) || FORM_TURNS_IN_CONFLICT),
    countFromRound: bearerActedOrActing ? r + 1 : r,
    lastTickRound: null,
  };
}

/** Counter for a form that starts outside a conflict: it only gets one if a
 *  conflict begins without a map change (the map change normally ends it). */
export function counterOnConflictStart({ round }) {
  return newConflictCounter({ round, bearerActedOrActing: false });
}

/**
 * The bearer just ENDED a turn in `round`. Returns { counter, ticked, expired }.
 * Never mutates the input.
 */
export function tickOnTurnEnd(counter, round) {
  const r = Math.trunc(num(round));
  if (!counter) return { counter, ticked: false, expired: false };
  const c = { ...counter };
  if (r < num(c.countFromRound) || c.lastTickRound === r) {
    return { counter: c, ticked: false, expired: c.turnsLeft <= 0 };
  }
  c.turnsLeft = Math.max(0, num(c.turnsLeft) - 1);
  c.lastTickRound = r;
  return { counter: c, ticked: true, expired: c.turnsLeft <= 0 };
}

// ── Stat mapping ─────────────────────────────────────────────────────────────

/** NPC affinity select value → PC label value. "-" / blank / unknown → "NA". */
export function normalizeAffinity(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return (s === "VU" || s === "RS" || s === "IM" || s === "AB") ? s : "NA";
}

export const AFFINITY_KEYS = Object.freeze([
  "affinity_1", "affinity_2", "affinity_3", "affinity_4", "affinity_5",
  "affinity_6", "affinity_7", "affinity_8", "affinity_9",
]);
export const ATTR_KEYS = Object.freeze(["dex", "ins", "mig", "wlp"]);

/**
 * Read what the form brings, from a monster actor's (derived) props.
 * DEF/MDEF are carried as offsets over the form's DEX/INS die so the PC sheet
 * formula (DEX + bonus_defense, INS + bonus_magic_defense) lands on the
 * monster's numbers, and a DEX/INS status on the bearer still moves them.
 */
export function readFormProfile(props = {}) {
  const p = props ?? {};
  const attrs = {};
  for (const a of ATTR_KEYS) attrs[a] = num(p[`${a}_base`]) || num(p[`${a}_current`]) || 8;
  const dexCur = num(p.dex_current) || attrs.dex;
  const insCur = num(p.ins_current) || attrs.ins;
  const affinities = {};
  for (const k of AFFINITY_KEYS) affinities[k] = normalizeAffinity(p[k]);
  return {
    attrs,
    defOffset: num(p.defense) - dexCur,
    mdefOffset: num(p.magic_defense) - insCur,
    affinities,
    maxHp: num(p.max_hp),
    maxMp: num(p.max_mp),
    species: String(p.species ?? "").trim(),
  };
}

/** Traversal tags: authored list on the monster + its species, lower-case, unique. */
export function formTags(authored, species) {
  const out = new Set();
  const list = Array.isArray(authored) ? authored : String(authored ?? "").split(/[,;]/);
  for (const t of list) { const s = String(t ?? "").trim().toLowerCase(); if (s) out.add(s); }
  const sp = String(species ?? "").trim().toLowerCase();
  if (sp) out.add(sp);
  return [...out];
}
