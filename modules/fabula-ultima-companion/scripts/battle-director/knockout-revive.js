// Knockout revive — Auto-Life / Reraise support ("KO'd, then gets back up").
//
// A creature reduced to 0 HP is really knocked out first (KO status, the on-KO
// cleanse, the KO pose), THEN its own `creature_knocked_out` reactions run
// (defeat-reactor emitKnockedOut). One that restores HP is a revive; the KO
// status comes off by itself when HP rises above 0.
//
// Two things must wait for that revive, and both ask here:
//   • the side wipe (state-handlers sideIsWiped) — a downed last member who still
//     holds a revive has not lost yet;
//   • the Soldier/Elite removal (defeat-reactor) — a monster with Reraise must
//     not be deleted before it can rise.
// Both read `holdsKnockoutRevive`, a cheap STRUCTURAL scan (a non-off row on that
// trigger) so the synchronous side-wipe check can call it. Conditions and an
// ask-mode decline are settled by the real dispatch; when the creature is still
// down after it, the defeat reactor marks the revive TRIED for this KO, so it no
// longer holds anything up, and re-runs the side wipe. Getting back above 0 HP
// clears the mark (a later KO may revive again if another source is carried).
//
// Leaf module: no imports, shared by defeat-reactor, defeat-styles callers and
// state-handlers without an import cycle.

export const KNOCKOUT_TRIGGER = "creature_knocked_out";
const NS = "fabula-ultima-companion";

// actor uuid → the revive has been dispatched for the current KO and failed.
const _tried = new Set();

export function markReviveTried(actor) { if (actor?.uuid) _tried.add(actor.uuid); }
export function clearReviveTried(actor) { if (actor?.uuid) _tried.delete(actor.uuid); }

/** Does a reaction blob (item reaction_config_table / AE reactionConfig) hold a live knockout row? */
export function hasKnockoutRow(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 3) return false;
  if (String(node.reaction_trigger ?? "").trim() === KNOCKOUT_TRIGGER && !node.$deleted) {
    return String(node.reaction_passive_mode ?? "").trim().toLowerCase() !== "off";
  }
  return Object.values(node).some((v) => hasKnockoutRow(v, depth + 1));
}

/** True when an Active Effect carries a knockout revive (spared by the on-KO cleanse). */
export function isKnockoutReviveEffect(ae) {
  return hasKnockoutRow(ae?.flags?.[NS]?.reactionConfig);
}

/**
 * Does `actor` still hold an untried revive for its current KO? Items' reaction
 * rows and live Active Effects (appliedEffects, so gear AEs count only when worn).
 */
export function holdsKnockoutRevive(actor) {
  if (!actor || _tried.has(actor.uuid)) return false;
  const list = (c) => (Array.isArray(c) ? c : (c?.contents ?? (c ? Object.values(c) : [])));
  try {
    for (const it of list(actor.items)) if (hasKnockoutRow(it?.system?.props?.reaction_config_table)) return true;
    for (const ae of list(actor.appliedEffects ?? actor.effects)) {
      if (ae?.disabled) continue;
      if (isKnockoutReviveEffect(ae)) return true;
    }
  } catch { return false; }
  return false;
}
