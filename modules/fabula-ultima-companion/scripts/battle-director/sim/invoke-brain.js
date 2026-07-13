// Invoke Brain — spends Fabula Points to turn a miss into a hit.
//
// A whiffed turn is the single most expensive thing that happens to a party: a whole
// action gone, and the enemy still standing to take another. Real players spend a
// Fabula Point rather than eat that, and the sim never did — it just shrugged and
// moved on. Wiring this in is the last big "a human would obviously do this" gap.
//
// The two invokes, and the user's ordering:
//
//   BOND  — adds a flat +1..+3 (one point per filled emotion). DETERMINISTIC: if the
//           bonus closes the gap, the miss becomes a hit, guaranteed. So it goes
//           FIRST, and only when it is actually enough.
//
//   TRAIT — rerolls a die. A gamble, so it's the fallback — and only the dice worth
//           rerolling. A die already showing more than half its faces is likely to
//           come back WORSE, so it's left alone; only the low ones are thrown again.
//
// Both cost 1 Fabula Point and run through handleInvokeBond / handleInvokeTrait —
// the exact functions the card's own buttons call, so the reroll, the payment, the
// re-render and the broadcast all happen for real. We only decide.

import { log, warn } from "../logger.js";
import { SimMode } from "./sim-mode.js";
import { canPay, readActorBonds, getInvokeCapability } from "../invoke/invoke-core.js";

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// How far short of hitting are we? Positive = we missed by that much.
// Measured against the target we most want to hit — the hardest one we missed, since
// closing that gap closes the easier ones too.
function shortfall(ar) {
  const rows = Array.isArray(ar?.perTargetResults) ? ar.perTargetResults : [];
  const total = num(ar?.roll?.total, 0);

  const missed = rows.filter((r) => r?.hit === false && Number.isFinite(Number(r?.defense)));
  if (!missed.length) return null;

  // The SMALLEST gap: the cheapest miss to convert. (Fixing the closest one is the
  // best value; a bond of +2 that saves one target is better than nothing.)
  const gaps = missed.map((r) => num(r.defense, 0) - total).filter((g) => g > 0);
  if (!gaps.length) return null;
  return Math.min(...gaps);
}

// Which dice are worth rerolling? Only the ones showing at or below half their faces
// — a d8 sitting on 6 is far more likely to get worse than better.
function lowDice(roll) {
  const dA = num(roll?.dA, 6), dB = num(roll?.dB, 6);
  const rA = num(roll?.rA, 0), rB = num(roll?.rB, 0);
  const lowA = rA <= Math.floor(dA / 2);
  const lowB = rB <= Math.floor(dB / 2);
  if (lowA && lowB) return { choice: "AB", desc: `both dice are low (${rA}/${dA}, ${rB}/${dB})` };
  if (lowA) return { choice: "A", desc: `only die A is worth rerolling (${rA}/${dA})` };
  if (lowB) return { choice: "B", desc: `only die B is worth rerolling (${rB}/${dB})` };
  return null;   // both dice are already good — a reroll would probably make it worse
}

// Decide + execute. Returns true if anything was invoked (the caller re-reads cardAr
// from invokeState.lastAr, exactly as the click handler does).
export async function simInvoke({ director, ar, root, invokeState, attackerActor }) {
  try {
    if (!attackerActor) return false;
    if (getInvokeCapability(attackerActor) !== "full") return false;   // PCs only
    if (!ar?.roll || ar.roll.isFumble) return false;                   // can't invoke on a fumble

    const gap = shortfall(ar);
    if (gap == null) return false;   // nothing missed — nothing to fix

    const worker = await import("../invoke/invoke-worker.js");
    let acted = false;

    // 1. BOND first — it is deterministic, so if it's enough, it IS the answer.
    if (!invokeState.bond && canPay(attackerActor).ok) {
      const best = readActorBonds(attackerActor)
        .filter((b) => b.bonus > 0)
        .sort((a, b) => b.bonus - a.bonus)[0] ?? null;

      if (best && best.bonus >= gap) {
        const ok = await worker.handleInvokeBond({
          director, ar, root, invokeState, prePickedBondIndex: best.index,
        });
        if (ok) {
          SimMode.note("invoke", `${attackerActor.name} invokes Bond "${best.name}" (+${best.bonus}) — missed by ${gap}, so this lands it`);
          acted = true;
        }
      }
    }

    // 2. TRAIT — the gamble, only if we're still short and only on the low dice.
    const liveAr = invokeState.lastAr ?? ar;
    const stillShort = shortfall(liveAr);
    if (stillShort != null && !invokeState.trait && canPay(attackerActor).ok) {
      const pick = lowDice(liveAr.roll);
      if (pick) {
        const ok = await worker.handleInvokeTrait({
          director, ar: liveAr, root, invokeState, prePickedChoice: pick.choice,
        });
        if (ok) {
          SimMode.note("invoke", `${attackerActor.name} invokes Trait, rerolling ${pick.choice} — ${pick.desc}`);
          acted = true;
        }
      } else {
        log(`[SIM] ${attackerActor.name} missed by ${stillShort} but both dice are already high — not rerolling`);
      }
    }

    return acted;
  } catch (e) {
    warn("[SIM] simInvoke threw — confirming without an invoke", e);
    return false;
  }
}
