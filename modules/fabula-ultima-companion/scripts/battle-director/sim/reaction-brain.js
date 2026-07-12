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

// Can the reactor eat this without it mattering? Three ways to be safe, all of
// them things a player would actually check: the element does nothing to me, the
// attack already missed me, or the projected damage is trivial.
function isSafeToTake(ar, reactorActor) {
  const row = rowFor(ar, reactorActor?.uuid);
  if (row && row.hit === false) return { safe: true, why: "it already missed her" };

  const element = actionElement(ar);
  if (element) {
    let aff = "NA";
    try { aff = String(AR.getAffinityForType(reactorActor, element) ?? "NA").toUpperCase(); } catch {}
    if (aff === "IM" || aff === "AB") return { safe: true, why: `she is ${aff} to ${element}` };
    if (aff === "RS") return { safe: true, why: `she resists ${element}` };
  }

  // Projected damage against her specifically, when the card knows it.
  const dmg = row ? numOr(row.damage, 0) : null;
  const max = maxHpOf(reactorActor);
  if (dmg != null && max > 0 && dmg / max <= TUNING.safeDamageFraction) {
    return { safe: true, why: `it would only cost her ${dmg}` };
  }
  return { safe: false, why: null };
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

  const safe = isSafeToTake(ar, reactorActor);
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

  const safe = isSafeToTake(ar, reactorActor);
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

// Zarg: Gadgets. NOT a turn action — an augment he declares ON a normal attack,
// buffing its damage and swapping its element, paid for in IP. So the decision is:
// this shot is about to land, is it worth 2 IP to re-point it at a weakness?
//
// Worth it when the target is VULNERABLE to something he can switch to, or when
// the shot's CURRENT element is being resisted/ignored (swapping to anything
// neutral is a straight gain). Otherwise he keeps the IP — Gadgets is not free.
function gadgetPolicy({ ar, reactorActor }) {
  const ip = numOr(reactorActor?.system?.props?.current_ip, 0);
  if (ip - TUNING.gadgetIpCost < TUNING.gadgetReserveIp) {
    return { decision: "skip", why: `only ${ip} IP left` };
  }

  const landing = rowsOf(ar).filter((r) => r?.hit !== false);
  if (!landing.length) return { decision: "skip", why: "the shot is missing anyway" };

  // Aim at the sturdiest reason to bother: a target that's VU to something.
  for (const r of landing) {
    const target = actorOf(r.actorUuid);
    if (!target) continue;

    const weak = ELEMENTS.find((el) => {
      try { return String(AR.getAffinityForType(target, el) ?? "NA").toUpperCase() === "VU"; }
      catch { return false; }
    });
    if (weak) {
      return {
        decision: "apply",
        why: `re-pointing the shot at ${target.name}'s ${weak} weakness`,
        hint: { label: weak },
      };
    }
  }

  // No weakness anywhere — but if what he's throwing is being shrugged off, almost
  // anything else is an improvement.
  const shrugged = landing.every((r) => ["RS", "IM", "AB"].includes(String(r?.affinity ?? "NA").toUpperCase()));
  if (shrugged) {
    const target = actorOf(landing[0].actorUuid);
    const neutral = ELEMENTS.find((el) => {
      try { return String(AR.getAffinityForType(target, el) ?? "NA").toUpperCase() === "NA"; }
      catch { return false; }
    });
    if (neutral) {
      return { decision: "apply", why: `current element is being shrugged off — switching to ${neutral}`, hint: { label: neutral } };
    }
  }

  return { decision: "skip", why: "no weakness to exploit — saving the IP" };
}

const POLICIES = {
  "protect": protectPolicy,
  "prophetic defender": propheticPolicy,
  "thermokinesis": damageRiderPolicy,
  "for whom the bell tolls": damageRiderPolicy,
  "gadgets": gadgetPolicy,
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
