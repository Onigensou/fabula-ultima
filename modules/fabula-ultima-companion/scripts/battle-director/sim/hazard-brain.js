// Hazard Brain — the party's awareness of a Conflict Event's moving parts.
//
// Today that means exactly one thing: the Lightning Rod (Valley of the Dragon's
// "Lightning Storm"). See docs/lightning-storm-design.md.
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// The sim's party brains decided targets on two terms — elemental affinity and
// "who is nearly dead" — and nothing else. Against a hazard encounter that made
// the numbers meaningless: a run of Mana Ray x2 + Lightning Prism ended in a TPK
// where the party held the Rod for most of six rounds and simply ate ~30 Bolt a
// round, because no brain ever asked who was holding it. A table would never
// play that way; the very first thing a player does with a status that says
// "hits whoever holds it" is get rid of it.
//
// A balance verdict from a party that ignores the fight's central mechanic is
// not a balance verdict. This restores the missing term.
//
// ── The rules being modelled ────────────────────────────────────────────────
//
//   - One creature holds the Rod (a singleton status).
//   - At the start of its turn the holder takes 30 Bolt and recovers 30 MP.
//     Affinity applies to the damage: VU takes 60, RS 15, AB is HEALED for 30.
//   - Damaging a creature moves the Rod onto it.
//
// That last rule is the whole strategy layer, and it has one subtlety worth
// stating because it is easy to get backwards: the Rod moves on an HP LOSS
// event, so an absorbing creature refuses it only from the element it absorbs.
// Electro Slime (AB bolt) cannot be handed the Rod by a Bolt attack, but an
// earth attack moves it onto the slime perfectly well. Displacement is therefore
// almost always available — the question is only who deserves it.
//
// ── The judgement ───────────────────────────────────────────────────────────
//
// Handing the Rod to an enemy is not automatically good: the holder also gets
// 30 MP, and for an MP-gated monster that is the fight's real currency. Feeding
// Kirin arms Rail Stream; feeding Lightning Prism buys another Fulgur Finis;
// Mana Ray's whole design is that the Rod refills its pool. So the party wants
// the Rod on the creature for whom holding it is WORST, which is the same
// question for an ally and an enemy with the sign flipped — hence one utility
// function, `partyUtilityOfHolding`, used for both.
//
// This is deliberately a heuristic, not a solver. It exists to stop the party
// ignoring the mechanic, not to play it perfectly.

import { SimMode } from "./sim-mode.js";

/** The AE's authored name — must match lightning-storm.js's ROD_AE_NAME. */
export const ROD_RE = /^lightning rod$/i;

/** The strike, before affinity. Mirrors the Rod AE's own `rod_strike` row. */
const ROD_STRIKE_DAMAGE = 30;
const ROD_STRIKE_MP = 30;

/**
 * Damage the strike actually deals to a creature with this Bolt affinity.
 * Negative for AB: an absorber is HEALED, which is why parking the Rod on
 * Electro Slime or Lightning Prism is strictly worse than leaving it nowhere.
 */
const STRIKE_BY_AFFINITY = {
  VU: ROD_STRIKE_DAMAGE * 2,
  NA: ROD_STRIKE_DAMAGE,
  RS: Math.floor(ROD_STRIKE_DAMAGE / 2),
  IM: 0,
  AB: -ROD_STRIKE_DAMAGE,
};

function propNum(actorDoc, key) {
  const v = Number(actorDoc?.system?.props?.[key]);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Is this creature's MP worth anything to it?
 *
 * A creature with no MP-costing action banks the Rod's 30 MP and does nothing
 * with it (the design doc calls this out for the anti-synergy HP wall, where it
 * is explicitly fine). Only charge the gift against creatures that can spend it.
 */
function usesMp(actorDoc) {
  for (const item of actorDoc?.items ?? []) {
    const cost = String(item?.system?.props?.cost ?? "");
    if (/\d/.test(cost) && /\bmp\b/i.test(cost)) return true;
  }
  return false;
}

/**
 * What the MP gift is worth to the holder, in damage-equivalent points.
 *
 * Measured as the FRACTION of their pool it refills, not the raw 30. What
 * decides whether the gift matters is whether it buys another cast, and that is
 * a question about pool size: 30 MP is Mana Ray's entire tank (three Volt
 * Stingers) and a quarter of Lightning Prism's. Pricing it as a flat 30 for both
 * made a 30-MP monster look like a safe place to park the Rod, which is the
 * exact opposite of that monster's design.
 */
const MP_REFILL_WEIGHT = 0.4;   // a full pool refill ≈ 40 damage of enablement

function mpGiftValueTo(actorDoc) {
  if (!usesMp(actorDoc)) return 0;
  const maxMp = propNum(actorDoc, "max_mp");
  if (maxMp <= 0) return 0;
  const headroom = maxMp - propNum(actorDoc, "current_mp");
  const gifted = Math.max(0, Math.min(ROD_STRIKE_MP, headroom));
  return (gifted / maxMp) * 100 * MP_REFILL_WEIGHT;
}

/**
 * How good is it FOR THE PARTY that `dc` is the one holding the Rod?
 *
 * Positive = the party is happy. The two sides are the same calculation with
 * opposite signs, which is what lets one comparison decide both "should we move
 * it?" and "onto whom?".
 *
 * Damage is counted in absolute points (a flat 30 is worth the same whoever eats
 * it) and the MP gift as a fraction of pool — see mpGiftValueTo for why the two
 * are measured differently.
 */
export function partyUtilityOfHolding(api, dc, { isAlly }) {
  const actorDoc = dc?.actorDoc ?? null;
  if (!actorDoc) return 0;

  const aff = api.affinityOf(dc, "bolt");
  const strike = STRIKE_BY_AFFINITY[aff] ?? ROD_STRIKE_DAMAGE;

  let value = strike - mpGiftValueTo(actorDoc);

  // A strike that KILLS is worth far more than its damage against an enemy, and
  // is a catastrophe on an ally — a downed PC stops acting, and action economy is
  // what actually decides these fights.
  const currentHp = propNum(actorDoc, "current_hp");
  if (strike > 0 && currentHp > 0 && strike >= currentHp) {
    value += isAlly ? -120 : 60;
  }

  return isAlly ? -value : value;
}

/** The combatant currently holding the Rod, searched across a list. */
function holderAmong(api, dcs) {
  return (dcs ?? []).find((dc) => api.hasAe(dc, ROD_RE)) ?? null;
}

/** True when this battle has a Rod in play at all (i.e. the Storm is armed). */
export function rodInPlay(api) {
  return Boolean(holderAmong(api, api.alliesAll?.() ?? []) || holderAmong(api, api.foes?.() ?? []));
}

/**
 * When an ALLY holds the Rod, the enemy the party should hit to shift it.
 * Returns null when the party is not holding it (or the Storm is not running),
 * leaving the normal focus rules untouched.
 *
 * ⚠ There is deliberately NO "only if the enemy is a better holder" gate.
 * Scoring this dungeon's roster showed every single enemy rates WORSE than any
 * PC — they variously absorb Bolt (Slime, Prism, Skizzik: the strike heals them)
 * or run tiny MP pools the gift refills outright (Mana Ray, Kirin). A
 * strictly-better test would therefore never fire once, and the party would sit
 * on the Rod exactly as it did in the run that prompted this file.
 *
 * The asymmetry the score cannot see is that holding it is a RECURRING cost —
 * ~30 Bolt at the top of every one of that PC's turns, for the rest of the fight
 * — while the enemy's heal-and-MP is a one-off on a creature the party is
 * actively killing, and the Rod dies with its holder. So: always get it off the
 * party, and let the score decide only WHO receives it.
 */
export function rodDisplacementTarget(api) {
  const carrier = holderAmong(api, api.alliesAll?.() ?? []);
  if (!carrier) return null;

  const foes = api.foes?.() ?? [];
  if (!foes.length) return null;

  const ranked = foes
    .map((f) => ({ foe: f, score: partyUtilityOfHolding(api, f, { isAlly: false }) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  return {
    target: best.foe,
    carrier,
    score: Math.round(best.score),
    keepScore: Math.round(partyUtilityOfHolding(api, carrier, { isAlly: true })),
  };
}

/**
 * Narrate the decision. Kept here rather than at the call site so the transcript
 * wording stays with the reasoning that produced it — the journal is how a "the
 * AI won't do X" report gets diagnosed, and a bare target swap with no stated
 * cause is exactly the kind of entry that wastes an hour.
 */
export function noteDisplacement({ target, carrier, score, keepScore }) {
  SimMode.note(
    "hazard",
    `Lightning Rod is on ${carrier.name} — party hits ${target.name} to shift it ` +
    `(holder value ${keepScore} → ${score})`
  );
}
