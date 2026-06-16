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
import { resultLabelFor, resultClsFor } from "../action-card.js";

function _getStampedCapability(ar) {
  return ar?.attacker?.invokeCapability ?? "full";
}
import { showTraitHUD, showBondHUD, playTraitOutcomeSfx, animateAccTotal } from "./invoke-hud.js";
import { playCritCutin } from "../director-cutin.js";

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

function recomputeArAfterInvoke(ar, newRoll) {
  // Per-target results: recalculate hit/miss with new total.
  const newPerTarget = (ar.perTargetResults ?? []).map((r) => {
    const def = r.defense ?? 0;
    const hit = newRoll.isCrit || (!newRoll.isFumble && newRoll.total >= def);
    return { ...r, isCrit: newRoll.isCrit, isFumble: newRoll.isFumble, hit };
  });

  // Damage: HR changes on a trait reroll, so finalIfHit changes when HR is used.
  let newDamage = ar.damage ?? null;
  if (newDamage && !newDamage.ignoreHR && !newDamage.isHealing && !newDamage.declaresHealing) {
    const base = Number(newDamage.base ?? 0) || 0;
    newDamage = { ...newDamage, finalIfHit: base + newRoll.hr };
  }

  return freezeActionResult({ ...ar, roll: newRoll, damage: newDamage, perTargetResults: newPerTarget });
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
  } catch (e) {
    warn("[BD][Invoke] patchCardDom threw", e);
  }
}

// ── Main handlers ─────────────────────────────────────────────────────────────

export async function handleInvokeTrait({ director, ar, root, invokeState, prePickedChoice = null }) {
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
  const choice = prePickedChoice ?? await showTraitHUD({ roll: ar.roll, root, tokenUuid });
  if (!choice) return false;

  const spend = await payPoint(attacker);
  if (!spend.ok) {
    ui.notifications?.error(`Could not spend 1 ${spend.label}.`);
    return false;
  }

  const arAfterPay = (spend.cur != null && ar.attacker)
    ? { ...ar, attacker: { ...ar.attacker, invokePointCount: spend.cur } }
    : ar;
  const oldTotal = ar.roll.total;
  const newRoll  = await rerollDice({ roll: ar.roll, choice, actor: attacker });
  const newAr    = recomputeArAfterInvoke(arAfterPay, newRoll);
  playTraitOutcomeSfx(oldTotal, newRoll.total);

  invokeState.trait            = true;
  director.ctx.actionResult    = newAr;
  director.ctx.invokeState     = { ...invokeState };

  patchCardDom(root, newAr, invokeState);
  // Fire crit cut-in if the reroll produced a critical (fire-and-forget).
  if (newAr.roll?.isCrit && !newAr.roll?.isFumble) playCritCutin(newAr);
  log(`[BD][Invoke] Trait — choice:${choice} rA:${ar.roll.rA}→${newRoll.rA} rB:${ar.roll.rB}→${newRoll.rB} total:${ar.roll.total}→${newRoll.total}`);
  return true;
}

export async function handleInvokeBond({ director, ar, root, invokeState, prePickedBondIndex = null }) {
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

  const pickedIndex = prePickedBondIndex ?? await showBondHUD({ bonds: viable, attacker, root, ar, tokenUuid: ar.attacker?.tokenUuid ?? null });
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
  const newAr   = recomputeArAfterInvoke(arAfterPay, newRoll);

  invokeState.bond             = true;
  invokeState.bondInfo         = { index: chosen.index, name: chosen.name, bonus: chosen.bonus };
  director.ctx.actionResult    = newAr;
  director.ctx.invokeState     = { ...invokeState };

  patchCardDom(root, newAr, invokeState);
  log(`[BD][Invoke] Bond — "${chosen.name}" +${chosen.bonus} total:${ar.roll.total}→${newRoll.total}`);
  return true;
}
