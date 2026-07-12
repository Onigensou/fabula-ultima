// Reaction Brain — decides the party's REACTIONS, not just its turns.
//
// Most of what makes a real party survive is not what it does on its turn. It is
// Blanche stepping in front of a hit aimed at someone squishier, Hina soaking a
// multi-target spell she happens to be immune to, Keren stacking a damage rider
// onto a blow that is about to land. All of those are REACTIONS: they fire as
// ask-mode pills on the action card, in the reaction window, on somebody ELSE's
// turn.
//
// Before this file the sim answered every reaction with a single blanket boolean,
// and any pill left undecided defaulted to "skip". So Blanche never protected
// anyone — not because her AI chose badly, but because she was never asked. Every
// balance number produced before this landed came from a party that did not
// defend itself.
//
// The decision is fed straight into `recordPillDecision`, the SAME function a
// human click calls, so the mutation pipeline (redirect-subject resolution,
// cost payment, card re-render) runs exactly as it does in play. We choose the
// answer; the engine still does the work.
//
// Policies are keyed by the reaction's carrier name. Anything without a policy
// falls back to the run's `reactions` setting, so the old blanket behaviour is
// still what happens for reactions nobody has written up yet.

import { log, warn } from "../logger.js";
import { SimMode } from "./sim-mode.js";
import { TUNING, ELEMENTS } from "./profiles.js";
import { ActionReaderCore as AR } from "../../action-reader/actionReader-core.js";
import { resolvesVsMagicDefense } from "../snapshot.js";

const norm = (s) => String(s ?? "").trim().toLowerCase();
const numOr = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ── Reading the incoming action ──────────────────────────────────────────────
// `ar` is the frozen action result the card is showing. perTargetResults carries
// the per-target outcome the player can see on that card — hit/miss, projected
// damage, the target's affinity to the element. That is exactly the information a
// human weighs when deciding whether to Protect, so the brain reads the same rows
// rather than re-deriving anything.
function actionElement(ar) {
  return norm(ar?.element ?? ar?.weapon?.damageType ?? "");
}

function rowsOf(ar) {
  return Array.isArray(ar?.perTargetResults) ? ar.perTargetResults : [];
}

function rowFor(ar, actorUuid) {
  if (!actorUuid) return null;
  return rowsOf(ar).find((r) => r?.actorUuid === actorUuid) ?? null;
}

function actorOf(uuidOrDoc) {
  if (!uuidOrDoc) return null;
  if (typeof uuidOrDoc !== "string") return uuidOrDoc;
  return fromUuidSync?.(uuidOrDoc) ?? null;
}

const maxHpOf = (actor) => numOr(actor?.system?.props?.max_hp, 0);
const curHpOf = (actor) => numOr(actor?.system?.props?.current_hp, 0);

// Would this land hard enough to be worth spending a defensive reaction on?
// "Strong" = it takes a serious bite out of the target, or it outright kills them.
function isStrongHit(row, targetActor) {
  if (!row || row.hit === false) return false;
  const dmg = numOr(row.damage, 0);
  if (dmg <= 0) return false;
  if (dmg >= curHpOf(targetActor)) return true;                     // lethal
  const max = maxHpOf(targetActor);
  return max > 0 && dmg / max >= TUNING.strongHitFraction;
}

// Would this attack even LAND on her? An action rolls one accuracy total against
// each target's defence, so if that total is under her defence it cannot hit her —
// which is what "it's lower than her defensive stats" means. Returns null when we
// can't tell (no roll, no defence), and null must never be read as "safe".
function wouldMiss(ar, reactorActor) {
  const total = Number(ar?.roll?.total);
  if (!Number.isFinite(total)) return null;
  if (ar?.canMiss === false) return false;   // an action that can't miss, won't

  const vsMagic = resolvesVsMagicDefense({
    defenseTargetType: ar?.defenseTargetType,
    isSpell: String(ar?.skillType ?? "").toLowerCase() === "spell",
  });
  const p = reactorActor?.system?.props ?? {};
  const def = Number(vsMagic ? (p.magic_defense ?? p.current_mdef) : (p.defense ?? p.current_def));
  if (!Number.isFinite(def)) return null;

  return total < def;
}

// What does the card actually KNOW about the damage aimed at her? Absence of a row
// is not evidence of harmlessness — she is usually NOT among the targets of the
// action she is thinking about intercepting.
//
// This distinction is the whole bug that produced the Centaur loop: the first
// version defaulted an unknown damage figure to 0, so "we have no idea" read as
// "it's harmless", and Hina cheerfully pulled a PHYSICAL sweep she takes full
// damage from onto herself, survived on the fire rider she absorbs, and kept the
// enemy's "repeat if all targets hit" firing forever. Unknown now fails CLOSED.
function projectedDamage(ar, reactorActor) {
  const row = rowFor(ar, reactorActor?.uuid);
  if (!row) return { known: false };
  if (row.hit === false) return { known: true, missed: true, dmg: 0 };
  const d = Number(row.damage);
  return Number.isFinite(d) ? { known: true, missed: false, dmg: d } : { known: false };
}

function affinityTo(reactorActor, element) {
  if (!element) return null;
  try { return String(AR.getAffinityForType(reactorActor, element) ?? "NA").toUpperCase(); }
  catch { return null; }
}

// Hina's bar (her spec): she only soaks what genuinely cannot hurt her — she
// ABSORBS or is IMMUNE to it, or its accuracy is under her defence so it would
// miss her anyway. Resistance is NOT enough: resisted damage is still damage.
function takesNothingFrom(ar, reactorActor) {
  const proj = projectedDamage(ar, reactorActor);
  if (proj.known && proj.missed) return { safe: true, why: "it already missed her" };

  const aff = affinityTo(reactorActor, actionElement(ar));
  if (aff === "IM" || aff === "AB") return { safe: true, why: `she is ${aff} to ${actionElement(ar)}` };

  const miss = wouldMiss(ar, reactorActor);
  if (miss === true) return { safe: true, why: "its accuracy is under her defence — it can't hit her" };

  if (proj.known && proj.dmg === 0) return { safe: true, why: "it does nothing to her" };

  return { safe: false, why: null };   // unknown → NOT safe
}

// Blanche's bar (her spec) is lower — she is the tank, and she may step in front of
// something she merely RESISTS, or that has already missed her, or that would barely
// scratch her. Still requires positive evidence.
function canTankIt(ar, reactorActor) {
  const strict = takesNothingFrom(ar, reactorActor);
  if (strict.safe) return strict;

  const aff = affinityTo(reactorActor, actionElement(ar));
  if (aff === "RS") return { safe: true, why: `she resists ${actionElement(ar)}` };

  const proj = projectedDamage(ar, reactorActor);
  const max = maxHpOf(reactorActor);
  if (proj.known && max > 0 && proj.dmg / max <= TUNING.safeDamageFraction) {
    return { safe: true, why: `it would only cost her ${proj.dmg}` };
  }

  return { safe: false, why: null };   // unknown → NOT safe
}

// ── The policies ─────────────────────────────────────────────────────────────
// Each returns { decision: "apply"|"skip", why, hint? }. `hint` pre-answers the
// picker the reaction is about to open (WHICH ally to cover), so the sim doesn't
// fall back to blindly taking the first option.

// Blanche: Protect. At most once a round, on a hit that actually hurts, and only
// when she can take it herself without trading one problem for another.
function protectPolicy({ ar, reactorActor, director }) {
  const round = director?.dCombat?.round ?? 0;

  if (SimMode.spent(round, "blanche-protect") >= TUNING.protectPerRound) {
    return { decision: "skip", why: "already protected this round" };
  }

  const safe = canTankIt(ar, reactorActor);
  if (!safe.safe) return { decision: "skip", why: "she'd take the hit badly herself" };

  // Whom is it aimed at? Anyone but her, who is about to get hit hard.
  const victims = rowsOf(ar)
    .filter((r) => r?.actorUuid && r.actorUuid !== reactorActor?.uuid)
    .map((r) => ({ row: r, actor: actorOf(r.actorUuid) }))
    .filter((v) => v.actor && isStrongHit(v.row, v.actor));

  if (!victims.length) return { decision: "skip", why: "nothing worth stepping in front of" };

  // Cover whoever is closest to dying.
  victims.sort((a, b) => (curHpOf(a.actor) - numOr(a.row.damage, 0)) - (curHpOf(b.actor) - numOr(b.row.damage, 0)));
  const pick = victims[0];

  SimMode.spend(round, "blanche-protect");
  return {
    decision: "apply",
    why: `covering ${pick.actor.name} (${numOr(pick.row.damage, 0)} incoming) — ${safe.why}`,
    hint: { actorUuid: pick.actor.uuid, tokenUuid: pick.row.tokenUuid ?? null, label: pick.actor.name },
  };
}

// Hina: Prophetic Defender. Pull a MULTI-target action onto herself — but only
// when it can't hurt her. Soaking a 3-target spell she is immune to is one of the
// biggest tempo swings the party has.
function propheticPolicy({ ar, reactorActor }) {
  const targets = rowsOf(ar).length || (ar?.targets ?? []).length;
  if (targets < TUNING.propheticMinTargets) {
    return { decision: "skip", why: `only ${targets} target(s) — not worth the redirect` };
  }

  const safe = takesNothingFrom(ar, reactorActor);
  if (!safe.safe) return { decision: "skip", why: "she would actually take damage" };

  return { decision: "apply", why: `soaking a ${targets}-target action — ${safe.why}` };
}

// Keren: Thermokinesis / For Whom the Bell Tolls. Damage riders on HER action.
// Only worth spending when the damage will actually land — pointless against a
// target that resists or ignores the element.
function damageRiderPolicy({ ar, carrierName }) {
  const rows = rowsOf(ar);
  const landing = rows.filter((r) => r?.hit !== false);
  if (!landing.length) return { decision: "skip", why: "nothing is landing" };

  const wasted = landing.every((r) => {
    const aff = String(r?.affinity ?? "NA").toUpperCase();
    return aff === "IM" || aff === "AB" || aff === "RS";
  });
  if (wasted) return { decision: "skip", why: "every target resists or ignores it" };

  return { decision: "apply", why: `${carrierName} — the damage will land` };
}

// ── Element swaps (Gadgets, Thermokinesis) ───────────────────────────────────
// Several augments do the same thing: they let the caster CHOOSE the damage type
// of the action they're riding. That choice is made in a menu that opens after the
// pill is applied — and the sim answers menus with the first option unless a brain
// leaves a hint. So an element-swap augment applied WITHOUT a hint is worse than
// useless: Keren fired Thermokinesis into an Inferex and the menu's first entry was
// Fire, which Inferex ABSORBS. She was healing it.
//
// So: never apply one of these without saying which element, and only apply when
// the swap is a genuine improvement on what the action already does.
const AFF_SCORE = { VU: 3, NA: 1, RS: 0.4, IM: 0, AB: -5 };

function affScore(aff) {
  return AFF_SCORE[String(aff ?? "NA").toUpperCase()] ?? 1;
}

// Best element to switch to against this target, with its affinity.
function bestElementAgainst(target) {
  let best = null;
  for (const el of ELEMENTS) {
    let aff = "NA";
    try { aff = String(AR.getAffinityForType(target, el) ?? "NA").toUpperCase(); } catch {}
    const score = affScore(aff);
    if (!best || score > best.score) best = { element: el, aff, score };
  }
  return best;
}

function elementSwapPolicy({ ar, carrierName }) {
  const landing = rowsOf(ar).filter((r) => r?.hit !== false);
  if (!landing.length) return { decision: "skip", why: "nothing is landing" };

  // Judge against the primary target (the one the action is really aimed at).
  const row = landing[0];
  const target = actorOf(row.actorUuid);
  if (!target) return { decision: "skip", why: "can't resolve the target" };

  // What the action ALREADY does to them — this is the bar to beat. `affinity` on
  // the row is the target's affinity to the action's current element.
  const current = affScore(row.affinity);
  const best = bestElementAgainst(target);

  if (!best || best.score <= current) {
    return { decision: "skip", why: `can't improve on ${String(row.affinity ?? "NA").toUpperCase()} — saving it` };
  }

  return {
    decision: "apply",
    why: `${carrierName} → ${best.element} (${target.name} is ${best.aff}); was ${String(row.affinity ?? "NA").toUpperCase()}`,
    hint: { label: best.element },
  };
}

// Gadgets is an element swap that also costs IP, so it keeps a reserve on top.
function gadgetPolicy(ctx) {
  const ip = numOr(ctx.reactorActor?.system?.props?.current_ip, 0);
  if (ip - TUNING.gadgetIpCost < TUNING.gadgetReserveIp) {
    return { decision: "skip", why: `only ${ip} IP left` };
  }
  return elementSwapPolicy(ctx);
}

// Zarg's other two augments. Barrage (10 MP, creature_performs_action) and Warning
// Shot (free, creature_will_deal_damage) both ride ON his attack — they are not
// things he "casts", which is what he was wrongly doing with his whole turn. The
// pill only appears on his own card when it's eligible, and `available` already
// encodes whether he can pay, so the judgement left to us is simply: is this shot
// worth augmenting? Same test as the other riders — will the damage actually land.
// Warning Shot is an OPENER (user's call): worth it on the first round, after which
// Zarg is better off just putting damage out.
function warningShotPolicy(ctx) {
  const round = ctx.director?.dCombat?.round ?? 0;
  if (!TUNING.warningShotRounds.includes(round)) {
    return { decision: "skip", why: `round ${round} — it's an opener` };
  }
  return damageRiderPolicy(ctx);
}

// Potion Rain turns Zarg's consumable into an area effect — one turn, the whole
// party topped up. Free, and it only ever fires on an item he was already using, so
// there is nothing to weigh: take it.
function potionRainPolicy() {
  return { decision: "apply", why: "spreads the potion across the party" };
}

const POLICIES = {
  // Defensive redirects.
  "protect": protectPolicy,
  "prophetic defender": propheticPolicy,

  // Element swaps — these CHOOSE the damage type, so they must never fire without
  // naming it (see elementSwapPolicy).
  "thermokinesis": elementSwapPolicy,
  "gadgets": gadgetPolicy,

  // Plain damage riders — no choice to make, just "is this worth spending on".
  "for whom the bell tolls": damageRiderPolicy,
  "barrage": damageRiderPolicy,
  "warning shot": warningShotPolicy,

  // Economy.
  "potion rain": potionRainPolicy,
};

// ── Public ───────────────────────────────────────────────────────────────────
// Decide every UNDECIDED (i.e. ask-mode) pill on this card. Auto-fire ("on"/
// "force") and "off" pills are already resolved by the card itself and are not
// ours to touch. Returns [{ rowKey, carrierUuid, decision, hint }].
export function decideReactions({ prePassives, ar, director, decided }) {
  const out = [];
  const fallback = SimMode.config?.reactions === "apply" ? "apply" : "skip";

  for (const p of prePassives ?? []) {
    const key = `${p.rowKey}:${p.carrierUuid}`;
    if (decided?.has(key)) continue;          // auto-fire / off — already settled
    if (p.available === false) continue;      // dimmed: can't pay for it

    const reactorActor = actorOf(p.reactorActorUuid) ?? actorOf(p.carrierUuid);
    const name = norm(p.carrierName);
    const policy = POLICIES[name];

    if (!policy) {
      out.push({ rowKey: p.rowKey, carrierUuid: p.carrierUuid, decision: fallback });
      continue;
    }

    let verdict;
    try {
      verdict = policy({ ar, reactorActor, director, carrierName: p.carrierName });
    } catch (e) {
      warn(`[SIM] reaction-brain: ${p.carrierName} policy threw — skipping it`, e);
      verdict = { decision: "skip", why: "policy error" };
    }

    SimMode.note(
      "reaction",
      `${p.reactorActorName ?? p.carrierName}: ${verdict.decision === "apply" ? "USES" : "holds"} ${p.carrierName}` +
      (verdict.why ? ` — ${verdict.why}` : "")
    );
    out.push({ rowKey: p.rowKey, carrierUuid: p.carrierUuid, decision: verdict.decision, hint: verdict.hint ?? null });
  }

  return out;
}

// Has Blanche already spent her Protect this round? Hina's heal is explicitly
// gated on this — she stays on the offensive while the party still has its
// defensive answer available.
export function protectExhausted(round) {
  return SimMode.spent(round, "blanche-protect") >= TUNING.protectPerRound;
}

// SAFETY NET. The Thermokinesis bug was not really about Thermokinesis: ANY augment
// that opens an element menu will, without a hint, take the menu's first option —
// and if that happens to be Fire and the target absorbs Fire, we heal it. A policy
// per augment fixes the ones we know about; this covers the ones we don't.
//
// Returns the best element to use against the action's primary target, so a picker
// that finds itself looking at a list of elements with no explicit hint has
// something sane to fall back on instead of "whatever is at the top".
export function bestElementForCard(ar) {
  const landing = rowsOf(ar).filter((r) => r?.hit !== false);
  const target = landing.length ? actorOf(landing[0].actorUuid) : null;
  if (!target) return null;
  return bestElementAgainst(target)?.element ?? null;
}
