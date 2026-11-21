// Weighted — the equipment keyword (journal ljKBtlzPVvhhmdHW):
//   "You can only perform one attack per turn with this weapon. You cannot
//    perform attacks without HR with this weapon."
//
// Pure rules, no Foundry globals, so the picker (player client), the GM's TARGET
// gate and the NPC autopilot all read the SAME answer off plain snapshot data.
//
// How a weapon is Weighted:
//   - `weighted` in its own `action_keywords` prop (comma/newline list, any case)
//     — carried on the weapon snapshot as `actionKeywords` (PC main/off,
//     Versatile, and the NPC pseudo-weapon all set it), or
//   - `weighted: true` stamped on the weapon snapshot by resolveAttackerWeapon
//     when the wielder carries a `grant_weapon_keywords: weighted` AE change
//     (Titanic Shield: "Your equipped weapon gain Weighted").
//
// "One attack per turn" counts per TURN (the stamp is round + acting combatant,
// see DirectorCombat.addWeightedAttack): an attack on your own turn and a
// Counterattack on an enemy's turn are each their own turn. A Chain strike
// (free_action chain:true) is a continuation of the SAME attack, not a new one,
// so it is exempt from both clauses — the same reading free-actions.js gives it
// for preventFreeAttack.

export const WEIGHTED_KEYWORD = "weighted";
export const WEIGHTED_REASON_ONCE = "Weighted: one attack per turn";
export const WEIGHTED_REASON_HR = "Weighted: needs High Roll";

/** Does a keyword list (string "a, b\nc" or array) contain `weighted`? */
export function keywordListHasWeighted(raw) {
  if (!raw) return false;
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\n]+/);
  return list.some((k) => String(k ?? "").trim().toLowerCase() === WEIGHTED_KEYWORD);
}

/** Is this weapon snapshot (or pseudo-weapon) Weighted? */
export function isWeightedWeapon(w) {
  if (!w || typeof w !== "object") return false;
  return w.weighted === true || keywordListHasWeighted(w.actionKeywords);
}

/** Stable per-weapon identity for the per-turn tally (uuid, else name). */
export function weaponKey(w) {
  const k = String(w?.uuid ?? w?.npcAttackItemUuid ?? "").trim() || String(w?.name ?? "").trim();
  return k || null;
}

/** Per-creature tally key: the token (two unlinked Bandits share an actor id). */
export function weightedActorKey(snapLike) {
  return String(snapLike?.tokenUuid ?? snapLike?.actorId ?? "").trim() || null;
}

/**
 * The weapons an attack mode swings, in pass order — mirrors the TARGET
 * handler's weaponsUsed mapping (state-handlers) so the picker and the gate
 * judge the same list.
 */
export function weaponsForMode(mode, { mainWeapon = null, offWeapon = null, multiAttack = null, virtualAttacks = [] } = {}) {
  const m = String(mode ?? "main");
  if (m.startsWith("virtual:")) {
    const i = Number(m.slice("virtual:".length)) | 0;
    // POSITIONAL into the list handed in — the picker's value indexes the array
    // it was given (compose-action translates to the canonical index only after
    // the pick), and the GM indexes the unfiltered snapshot list the same way.
    const va = (Array.isArray(virtualAttacks) ? virtualAttacks : [])[i] ?? null;
    return va ? [va] : [];
  }
  if (m === "two-weapon-multi") {
    const n = Math.max(2, Math.floor(Number(multiAttack?.count) || 2));
    return mainWeapon ? Array.from({ length: n }, () => mainWeapon) : [];
  }
  if (m === "two-weapon") return [mainWeapon, offWeapon].filter(Boolean);
  if (m === "two-weapon-off-first") return [offWeapon, mainWeapon].filter(Boolean);
  if (m === "off") return offWeapon ? [offWeapon] : [];
  if (m === "npc") return mainWeapon ? [mainWeapon] : [];
  return mainWeapon ? [mainWeapon] : [];
}

/** Does this attack mode drop High Roll? Mirrors action-profile.modeForcesHrZero. */
export function modeDropsHighRoll(mode, multiAttack = null) {
  const m = String(mode ?? "");
  if (!m.startsWith("two-weapon")) return false;
  return !(m === "two-weapon-multi" && !!multiAttack?.keepHr);
}

/**
 * Why the given swing list is illegal under Weighted, or null when it's fine.
 *   weapons  — the weapons this attack swings (one entry per pass)
 *   dropsHr  — the attack mode forces HR = 0 (two-weapon, non-keepHr multi)
 *   grant    — the pending free-action grant, if any (hrAsZero, chain)
 *   usedKeys — weaponKey()s of Weighted weapons already swung this turn
 */
export function weightedBlockReason({ weapons = [], dropsHr = false, grant = null, usedKeys = [] } = {}) {
  if (grant?.chain === true) return null;
  const used = new Set(Array.isArray(usedKeys) ? usedKeys : []);
  const seen = new Set();
  for (const w of weapons) {
    if (!isWeightedWeapon(w)) continue;
    if (dropsHr || grant?.hrAsZero === true) return WEIGHTED_REASON_HR;
    const k = weaponKey(w);
    if (k && (used.has(k) || seen.has(k))) return WEIGHTED_REASON_ONCE;
    if (k) seen.add(k);
  }
  return null;
}

/** weightedBlockReason for one weapon-mode-picker value. */
export function weightedModeBlock(mode, { mainWeapon = null, offWeapon = null, multiAttack = null, virtualAttacks = [], grant = null, usedKeys = [] } = {}) {
  return weightedBlockReason({
    weapons: weaponsForMode(mode, { mainWeapon, offWeapon, multiAttack, virtualAttacks }),
    dropsHr: modeDropsHighRoll(mode, multiAttack),
    grant, usedKeys,
  });
}

/**
 * When EVERY single-attack option (main / off / virtual) is Weighted-blocked,
 * the whole Attack command is unavailable — return the reason for the menu
 * blade's stamp. Multi-strike modes never rescue an otherwise blocked actor
 * (they swing the same weapons and drop HR), so only single swings count.
 * Returns null when at least one option remains, or the actor has no weapons.
 */
export function weightedAttackCommandBlock({ mainWeapon = null, offWeapon = null, virtualAttacks = [], grant = null, usedKeys = [] } = {}) {
  const opts = [];
  if (mainWeapon) opts.push("main");
  if (offWeapon && offWeapon !== mainWeapon) opts.push("off");
  (Array.isArray(virtualAttacks) ? virtualAttacks : []).forEach((_, i) => opts.push(`virtual:${i}`));
  if (!opts.length) return null;
  let reason = null;
  for (const mode of opts) {
    const r = weightedModeBlock(mode, { mainWeapon, offWeapon, virtualAttacks, grant, usedKeys });
    if (!r) return null;
    reason ??= r;
  }
  return reason;
}
