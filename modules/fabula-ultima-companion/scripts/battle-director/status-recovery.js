// status-recovery.js — "roll a Check at the start of your turn; on a success the
// status ends" (Stunned, Sleep — user design 2026-11-26).
//
// Data-driven: any Active Effect carrying
//   flags["fabula-ultima-companion"].recoveryCheck = { attr1: "MIG", attr2: "WLP", dl: 10 }
// gets a free, automatic Check for its bearer:
//   - creatures with turns (PCs, monsters, guests, summons with turns): at TURN_START,
//     after the Grappled break-free. A pass deletes the AE and the creature acts
//     normally. A fail leaves it and loses the turn: TURN_START routes the turn_start
//     window to CLEANUP instead of DECLARE (state-handlers.js), so the activation is
//     spent and the status's lifetime (target_turn_end charges) ticks as usual.
//   - turn-less summons (phantasms, Numen, companions: 0 turns a round, they act only
//     through a free_action grant): when that grant is about to run. A fail skips the
//     granted action and spends one charge, since their own turn never comes to tick it.
//
// "No reactions" is NOT here: the status's disable_action "All" change blocks them
// through the shared reaction gate (skill-effects getReactionGate), and blocks every
// action menu while it is on.
//
// No-reapply (`noReapply: true` on the same flags) lives in apply_ae.

import { rollCheck, checkVsThreshold } from "./check.js";
import { log, warn } from "./logger.js";

const NS = "fabula-ultima-companion";
export const RECOVERY_FLAG = "recoveryCheck";
const ATTRS = new Set(["MIG", "DEX", "INS", "WLP"]);

/** The recovery spec on an effect, normalised, else null. */
export function recoveryCheckOf(eff) {
  const rc = eff?.flags?.[NS]?.[RECOVERY_FLAG];
  if (!rc || typeof rc !== "object") return null;
  const a1 = String(rc.attr1 ?? "").trim().toUpperCase();
  const a2 = String(rc.attr2 ?? "").trim().toUpperCase();
  if (!ATTRS.has(a1) || !ATTRS.has(a2)) return null;
  const dl = Math.max(1, Number(rc.dl) || 10);
  return { attr1: a1, attr2: a2, dl };
}

/** Non-disabled effects on `actor` that carry a recovery check. */
export function recoveryStatusesOn(actor) {
  const effects = actor?.effects?.contents ?? (Array.isArray(actor?.effects) ? actor.effects : []);
  return effects.filter((e) => e && !e.disabled && recoveryCheckOf(e));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// One charge off a turn-less summon's status (its own turn never ticks it).
// Mirrors skill-effects chargeTickFor; no charges = left alone.
async function spendCharge(eff) {
  const f = eff.flags?.[NS] ?? {};
  if (f.directorPermanent === true || f.charges == null) return false;
  const next = Number(f.charges) - 1;
  if (next <= 0) { await eff.delete(); return true; }
  const upd = { [`flags.${NS}.charges`]: next };
  if (eff.flags?.statuscounter?.visible === true) upd["flags.statuscounter.value"] = next;
  await eff.update(upd);
  return false;
}

/**
 * Roll every recovery check on `actor`. Returns
 *   { checked, blocked, results: [{ status, success, total, dl, removed }] }
 * `blocked` = at least one status is still on after its check (the creature
 * does not act). `spendOnFail` = a turn-less summon: a failed check spends a charge.
 * `roll` is injectable for tests.
 */
export async function runRecoveryChecks(actor, { name = null, spendOnFail = false, roll = rollCheck, chat = true } = {}) {
  const out = { checked: 0, blocked: false, results: [] };
  const list = recoveryStatusesOn(actor);
  if (!list.length) return out;
  const who = name ?? actor?.name ?? "?";
  for (const eff of list) {
    const spec = recoveryCheckOf(eff);
    const status = String(eff.name ?? "Status");
    let success = false, total = 0, removed = false, check = null;
    try {
      check = await roll({ actor, A1: spec.attr1, A2: spec.attr2 });
      success = !!checkVsThreshold(check, spec.dl).success;
      total = Number(check?.total) || 0;
    } catch (e) {
      warn(`status-recovery: check for ${status} on ${who} threw — counts as a fail`, e);
    }
    try {
      if (success) { await eff.delete(); removed = true; }
      else if (spendOnFail) removed = await spendCharge(eff);
    } catch (e) { warn(`status-recovery: could not update ${status} on ${who}`, e); }
    out.checked++;
    if (!success) out.blocked = true;
    out.results.push({ status, success, total, dl: spec.dl, removed });
    log(`status-recovery: ${who} ${status} — ${spec.attr1}+${spec.attr2} = ${total} vs DL ${spec.dl} → ${success ? "PASS (ends)" : "FAIL"}${!success && removed ? " (last charge spent)" : ""}`);

    if (chat && check && globalThis.ChatMessage?.create) {
      const crit = check.isCrit ? " Critical success!" : check.isFumble ? " Fumble." : "";
      const outcome = success ? `${status} ends.` : (removed ? `${status} wears off, but the turn is lost.` : `Still ${status}.`);
      const content = `<strong>${escapeHtml(status)}</strong> — ${escapeHtml(who)}<br>`
        + `${spec.attr1} (d${check.dA}) + ${spec.attr2} (d${check.dB}) = <strong>${total}</strong> vs DL ${spec.dl}<br>`
        + `<em>${escapeHtml(outcome + crit)}</em>`;
      try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker?.({ actor }) ?? undefined, content }); }
      catch (e) { warn("status-recovery: chat message failed", e); }
    }
  }
  return out;
}
