// scripts/battle-director/invoke/invoke-worker.js
// BD-coupled invoke handler. Wires invoke-core into the live action card:
// validates, shows dialogs, pays FP/UP, rebuilds the in-memory actionResult,
// patches the live DOM, and stamps director.ctx.invokeState so downstream
// FSM steps (RESOLVE, reactions) can query whether invoke was used.
//
// Dynamically imported by action-card.js on first invoke click.

import { log, warn } from "../logger.js";
import { freezeActionResult } from "../snapshot.js";
import {
  canPay, payPoint, readActorBonds,
  rerollDice, applyBondBonus,
} from "./invoke-core.js";
import { resultLabelFor, resultClsFor, classifyStudyTierDisplay, patchStudyTierFieldset } from "../action-card.js";

function _getStampedCapability(ar) {
  return ar?.attacker?.invokeCapability ?? "full";
}
import { showTraitHUD, showBondHUD, animateAccTotal } from "./invoke-hud.js";

// ── Ownership gate ────────────────────────────────────────────────────────────

function ensureOwner(actor, ar, what = "this action") {
  const initUid = ar?.initiatorUserId ?? null;
  const allow =
    game.user?.isGM ||
    actor?.isOwner === true ||
    (initUid && game.user?.id === initUid);
  if (!allow) ui.notifications?.warn(`Only the attacker's owner (or GM) can ${what}.`);
  return allow;
}

// ── Recompute actionResult fields after the roll changes ──────────────────────

async function recomputeArAfterInvoke(ar, newRoll) {
  // Study: no per-target/damage surfaces — the check total maps to the
  // encyclopedia tier. Re-derive tier + improved from the new total (a Bond bonus
  // or Trait reroll can cross a tier threshold) so the card + RESOLVE agree.
  if (String(ar.kind ?? "") === "Study") {
    const tier = classifyStudyTierDisplay(newRoll.total, { isCrit: !!newRoll.isCrit, isFumble: !!newRoll.isFumble });
    const previousBest = Number(ar.previousBest) || 0;
    const improved = !newRoll.isFumble && (tier.effective ?? newRoll.total) > previousBest;
    return freezeActionResult({ ...ar, roll: newRoll, tier, improved });
  }

  // Route the recompute through the SAME shared profile pass adjust_accuracy uses
  // (recomputeActionProfile) so EVERY per-target row is fully re-derived — hit AND
  // damage / crit / accuracyBlocked — not just the hit flag. The old hand-rolled pass
  // only flipped `hit`, so a miss→hit target kept the miss row's `damage: 0`: the
  // label flipped but the outcome stayed inert. `ar` already carries the invoke
  // change — Trait's rerolled dice on `roll`, Bond's flat bonus on `invokeCheckBonus`
  // (folded into the total by computeCheck) — so the recompute honors it by
  // construction, and it survives the CONFIRM reaction reconciliation for the same
  // reason (that reconciliation runs this identical recompute off the committed ar).
  const arForRecompute = freezeActionResult({ ...ar, roll: newRoll });
  let perTargetResults = null;
  let roll = newRoll;
  let hitTokenUuids = ar.hitTokenUuids ?? null;
  try {
    const { recomputeActionProfile } = await import("../action-profile.js");
    const delta = await recomputeActionProfile({ ar: arForRecompute, targets: ar.targets ?? null, round: ar.round ?? 0 });
    if (Array.isArray(delta?.perTargetResults) && delta.perTargetResults.length) {
      perTargetResults = delta.perTargetResults;
      if (delta.roll) roll = delta.roll;
      if (Array.isArray(delta.hitTokenUuids)) hitTokenUuids = delta.hitTokenUuids;
    }
  } catch (e) {
    warn("[BD][Invoke] recomputeActionProfile threw — falling back to hit-flip recompute", e);
  }
  // Fallback (recompute unavailable/empty): flip hit from the new total only. Better
  // than a stale result, but damage on a flipped row won't follow — the primary path
  // above is the correct one.
  if (!perTargetResults) {
    perTargetResults = (ar.perTargetResults ?? []).map((r) => {
      const def = r.defense ?? 0;
      const hit = newRoll.isCrit || (!newRoll.isFumble && newRoll.total >= def);
      return { ...r, isCrit: newRoll.isCrit, isFumble: newRoll.isFumble, hit };
    });
  }

  // Headline damage: finalIfHit follows HR (a Trait reroll can change HR).
  let newDamage = ar.damage ?? null;
  if (newDamage && !newDamage.ignoreHR && !newDamage.isHealing && !newDamage.declaresHealing) {
    const base = Number(newDamage.base ?? 0) || 0;
    newDamage = { ...newDamage, finalIfHit: base + (Number(roll?.hr) || 0) };
  }

  return freezeActionResult({ ...ar, roll, damage: newDamage, perTargetResults, hitTokenUuids });
}

// ── DOM patch ─────────────────────────────────────────────────────────────────
// Targeted in-place update of accuracy, damage and target rows.
// The reaction panel, portraits, and Confirm/Cancel are untouched.

export function patchCardDom(root, newAr, invokeState) {
  const roll = newAr.roll;
  if (!roll) return;

  try {
    // ── Accuracy: die results ────────────────────────────────────────────────
    const dieBlocks = root.querySelectorAll(".fud-bf-acc-row .die-block");
    if (dieBlocks[0]) dieBlocks[0].querySelector(".die-result").textContent = roll.rA;
    if (dieBlocks[1]) dieBlocks[1].querySelector(".die-result").textContent = roll.rB;

    // ── Accuracy: total (animated number roll + bounce) ──────────────────────
    const totalEl = root.querySelector(".fud-bf-acc-row .total");
    if (totalEl) animateAccTotal(totalEl, roll.total);

    // ── Accuracy: checkBonus pill ─────────────────────────────────────────────
    const accRow = root.querySelector(".fud-bf-acc-row");
    if (accRow) {
      let bonusPill = accRow.querySelector(".bonus");
      const cb = Number(roll.checkBonus) || 0;
      if (cb !== 0) {
        if (!bonusPill) {
          bonusPill = document.createElement("span");
          bonusPill.className = "bonus";
          const spacer = accRow.querySelector(".spacer");
          if (spacer) accRow.insertBefore(bonusPill, spacer);
          else accRow.appendChild(bonusPill);
        }
        bonusPill.textContent = cb >= 0 ? `+${cb}` : `${cb}`;
      } else if (bonusPill) {
        bonusPill.remove();
      }
    }

    // ── Accuracy: crit/fumble class + float banner ───────────────────────────
    const accDiv = root.querySelector(".fud-bf-acc");
    if (accDiv) {
      accDiv.classList.toggle("is-crit",   roll.isCrit && !roll.isFumble);
      accDiv.classList.toggle("is-fumble", !!roll.isFumble);

      let banner = accDiv.querySelector(".float-banner");
      if (roll.isCrit && !roll.isFumble) {
        if (!banner) { banner = document.createElement("div"); accDiv.appendChild(banner); }
        banner.className = "float-banner crit";
        banner.innerHTML = `<i class="fa-solid fa-crown"></i>Critical!`;
      } else if (roll.isFumble) {
        if (!banner) { banner = document.createElement("div"); accDiv.appendChild(banner); }
        banner.className = "float-banner fumble";
        banner.innerHTML = `<i class="fa-solid fa-skull"></i>Fumble!`;
      } else if (banner) {
        banner.remove();
      }

      // ── Opportunity note ─────────────────────────────────────────────────
      let opp = accDiv.querySelector(".fud-bf-opportunity");
      const showOpp = !!roll.opportunities && !roll.isFumble;
      if (showOpp && !opp) {
        opp = document.createElement("div");
        opp.className = "fud-bf-opportunity";
        opp.innerHTML = `<i class="fa-solid fa-bolt"></i> Opportunity!`;
        accDiv.appendChild(opp);
      } else if (!showOpp && opp) {
        opp.remove();
      }
    }

    // ── Damage: number + HR pill ─────────────────────────────────────────────
    const dmgNumber = root.querySelector(".fud-bf-dmg-number");
    if (dmgNumber && newAr.damage) {
      const ignoreHR = !!newAr.damage.ignoreHR;
      const shown    = roll.isFumble ? "—" : (newAr.damage.finalIfHit ?? 0);
      const hrPill   = (!ignoreHR && !roll.isFumble) ? `<span class="hr-pill">+HR</span>` : "";
      dmgNumber.innerHTML = `${shown}${hrPill}`;
    }

    // ── Per-target result rows (index-ordered, same order as perTargetResults) ─
    const rows       = root.querySelectorAll(".fud-bf-target-row");
    const ptResults  = newAr.perTargetResults ?? [];
    const hasDmg     = !!newAr.damage;
    rows.forEach((row, i) => {
      const r = ptResults[i];
      if (!r || r.studied === false) return; // keep ??? masking for unstudied targets
      const resultEl = row.querySelector(".t-result");
      if (!resultEl || resultEl.textContent.trim() === "???") return;
      resultEl.className = `t-result ${resultClsFor(r)}`;
      resultEl.innerHTML  = resultLabelFor(r, { hasDamage: hasDmg });
    });

    // ── Invoke button states ──────────────────────────────────────────────────
    if (invokeState.trait) {
      const btn = root.querySelector('[data-fud-invoke="trait"]');
      if (btn) { btn.classList.remove("is-locked"); btn.classList.add("is-resolved"); }
    }
    if (invokeState.bond) {
      const btn = root.querySelector('[data-fud-invoke="bond"]');
      if (btn) { btn.classList.remove("is-locked"); btn.classList.add("is-resolved"); }
    }

    // ── Invoke point counter (FP / UP remaining) ─────────────────────────────
    const counterVal = root.querySelector("[data-fud-invoke-counter] .fud-invoke-count");
    if (counterVal && newAr.attacker?.invokePointCount != null) {
      counterVal.textContent = String(newAr.attacker.invokePointCount);
    }

    // ── Study: repaint the Tier Reached fieldset from the new total ───────────
    // (Study has no damage/per-target surfaces; recomputeArAfterInvoke already
    // re-derived newAr.tier/improved, so this is a pure presentational repaint.)
    if (String(newAr.kind ?? "") === "Study") {
      patchStudyTierFieldset(root, { roll, tier: newAr.tier, previousBest: newAr.previousBest ?? 0, improved: newAr.improved });
    }
  } catch (e) {
    warn("[BD][Invoke] patchCardDom threw", e);
  }
}

// ── Main handlers ─────────────────────────────────────────────────────────────

export async function handleInvokeTrait({ director, ar, root, invokeState, prePickedChoice = null, onSelectionChange = null }) {
  if (invokeState.trait) {
    ui.notifications?.warn("Trait already invoked for this action.");
    return false;
  }
  const _cap = _getStampedCapability(ar);
  if (_cap === "none") {
    warn("[BD][Invoke] handleInvokeTrait blocked — actor invokeCapability is 'none'");
    return false;
  }
  if (!ar?.roll) {
    ui.notifications?.warn("No accuracy roll to reroll.");
    return false;
  }
  if (ar.roll.isFumble) {
    ui.notifications?.warn("Invoke Trait cannot be used on a Fumble.");
    return false;
  }

  const attackerUuid = ar.attackerActorRef ?? ar.attacker?.actorUuid ?? null;
  let attacker = null;
  try { attacker = attackerUuid ? await fromUuid(attackerUuid) : null; } catch {}
  if (!attacker) {
    ui.notifications?.error("[BD] Invoke Trait: could not resolve attacker actor.");
    return false;
  }
  if (!ensureOwner(attacker, ar, "Invoke Trait")) return false;

  const chk = canPay(attacker);
  if (!chk.ok) {
    ui.notifications?.warn(`Not enough ${chk.label}s (need 1).`);
    return false;
  }

  const tokenUuid = ar.attacker?.tokenUuid ?? null;
  const choice = prePickedChoice ?? await showTraitHUD({ roll: ar.roll, root, tokenUuid, onSelectionChange });
  if (!choice) return false;

  const spend = await payPoint(attacker);
  if (!spend.ok) {
    ui.notifications?.error(`Could not spend 1 ${spend.label}.`);
    // The HUD was kept open (committing) for the reroll animation — tear it
    // down on this rare post-commit failure so it doesn't linger.
    try { (await import("./invoke-hud.js")).dismissSpectator({ cancelled: true }); } catch {}
    return false;
  }

  const arAfterPay = (spend.cur != null && ar.attacker)
    ? { ...ar, attacker: { ...ar.attacker, invokePointCount: spend.cur } }
    : ar;
  const newRoll  = await rerollDice({ roll: ar.roll, choice, actor: attacker });
  const newAr    = await recomputeArAfterInvoke(arAfterPay, newRoll);

  invokeState.trait            = true;
  // Stamp the result onto the per-card invokeState so the caller can sync its
  // own snapshot (cardAr) — the source of truth for presentation/targeting.
  invokeState.lastAr           = newAr;
  // Only update the SHARED live slot if this card is still the active action;
  // otherwise the director has moved on and writing here would clobber a
  // different action's result. The caller's drift guard normally prevents us
  // reaching here on a mismatch — this is the defence for a drift that happens
  // mid-dialog (while the HUD is open).
  if ((director.ctx.actionResult?._instanceId ?? null) === (ar?._instanceId ?? null)) {
    director.ctx.actionResult  = newAr;
    director.ctx.invokeState   = { ...invokeState };
  } else {
    warn("[BD][Invoke] live actionResult drifted from this card — skipping ctx write-back (trait)");
  }

  // Presentation (reroll animation → card patch → chime → crit cut-in) is owned
  // by the caller (action-card presentTraitReroll), so it can broadcast the one
  // authoritative roll and keep every client's animation in sync. Return the
  // choice so the caller knows which die/dice to animate.
  log(`[BD][Invoke] Trait — choice:${choice} rA:${ar.roll.rA}→${newRoll.rA} rB:${ar.roll.rB}→${newRoll.rB} total:${ar.roll.total}→${newRoll.total}`);
  return choice;
}

export async function handleInvokeBond({ director, ar, root, invokeState, prePickedBondIndex = null, onSelectionChange = null }) {
  if (invokeState.bond) {
    ui.notifications?.warn("Bond already invoked for this action.");
    return false;
  }
  const _cap = _getStampedCapability(ar);
  if (_cap !== "full") {
    warn("[BD][Invoke] handleInvokeBond blocked — actor invokeCapability is not 'full'");
    return false;
  }
  if (!ar?.roll) {
    ui.notifications?.warn("No accuracy roll to modify.");
    return false;
  }
  if (ar.roll.isFumble) {
    ui.notifications?.warn("Invoke Bond cannot be used on a Fumble.");
    return false;
  }

  const attackerUuid = ar.attackerActorRef ?? ar.attacker?.actorUuid ?? null;
  let attacker = null;
  try { attacker = attackerUuid ? await fromUuid(attackerUuid) : null; } catch {}
  if (!attacker) {
    ui.notifications?.error("[BD] Invoke Bond: could not resolve attacker actor.");
    return false;
  }
  if (!ensureOwner(attacker, ar, "Invoke Bond")) return false;

  const chk = canPay(attacker);
  if (!chk.ok) {
    ui.notifications?.warn(`Not enough ${chk.label}s (need 1).`);
    return false;
  }

  const bonds  = readActorBonds(attacker);
  const viable = bonds.filter((b) => b.bonus > 0);
  if (!viable.length) {
    ui.notifications?.warn("No eligible Bonds (all bonds need at least 1 filled emotion).");
    return false;
  }

  const pickedIndex = prePickedBondIndex ?? await showBondHUD({ bonds: viable, attacker, root, ar, tokenUuid: ar.attacker?.tokenUuid ?? null, onSelectionChange });
  if (pickedIndex == null) return false;
  const chosen = viable.find((b) => b.index === pickedIndex) ?? viable[0];

  const spend = await payPoint(attacker);
  if (!spend.ok) {
    ui.notifications?.error(`Could not spend 1 ${spend.label}.`);
    return false;
  }

  const arAfterPay = (spend.cur != null && ar.attacker)
    ? { ...ar, attacker: { ...ar.attacker, invokePointCount: spend.cur } }
    : ar;
  const newRoll = applyBondBonus({ roll: ar.roll, bonus: chosen.bonus });
  // Persist the flat Bond bonus on the actionResult so the shared recompute folds it
  // into the total (computeCheck ignores roll.checkBonus) — this is what lets an
  // invoked Bond survive the CONFIRM reaction reconciliation, mirroring adjust_accuracy.
  // Cumulative in case a Bond is invoked across multiple cards (defensive; ≤1/action).
  const arWithInvoke = { ...arAfterPay, invokeCheckBonus: (Number(ar.invokeCheckBonus) || 0) + Number(chosen.bonus || 0) };
  const newAr   = await recomputeArAfterInvoke(arWithInvoke, newRoll);

  invokeState.bond             = true;
  invokeState.bondInfo         = { index: chosen.index, name: chosen.name, bonus: chosen.bonus };
  // See handleInvokeTrait: stamp the per-card snapshot, guard the shared slot.
  invokeState.lastAr           = newAr;
  if ((director.ctx.actionResult?._instanceId ?? null) === (ar?._instanceId ?? null)) {
    director.ctx.actionResult  = newAr;
    director.ctx.invokeState   = { ...invokeState };
  } else {
    warn("[BD][Invoke] live actionResult drifted from this card — skipping ctx write-back (bond)");
  }

  patchCardDom(root, newAr, invokeState);
  log(`[BD][Invoke] Bond — "${chosen.name}" +${chosen.bonus} total:${ar.roll.total}→${newRoll.total}`);
  return true;
}
