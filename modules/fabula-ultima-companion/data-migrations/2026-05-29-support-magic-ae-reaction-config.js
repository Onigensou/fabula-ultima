/**
 * Migration: 2026-05-29-support-magic-ae-reaction-config
 * ---------------------------------------------------------------------------
 * Refactors the Support Magic AE template (and live actor copies) to use the
 * canonical AE-bound reaction pattern:
 *
 *   flags.fabula-ultima-companion.charges        = 1
 *   flags.fabula-ultima-companion.chargesMax     = 1
 *   flags.fabula-ultima-companion.chargeKey      = "support-magic"
 *   flags.fabula-ultima-companion.reactionConfig = {
 *     reaction_config_table: {
 *       "0": {
 *         reaction_trigger:    "creature_performs_check",
 *         reaction_source:     "self",
 *         reaction_isPassive:  true,
 *         reaction_passive_mode: "on",
 *         reaction_effect_ref: ""
 *       }
 *     },
 *     effect_table: {}
 *   }
 *
 * AND drops the legacy `consume_on_check: true` hint that the director
 * never read — passive AE consumption was conceptually broken before.
 *
 * Behavior:
 *   - When the AE's bearer makes a Check, director's
 *     `oni:reactionPhase` bridge sees `creature_performs_check` and
 *     calls `firePassiveTriggers` on the bearer.
 *   - `firePassiveTriggers` walks `actor.effects`, finds AEs with
 *     matching reactionConfig, fires their effect_table (empty for
 *     Support Magic — the AE's `changes` already apply the +BOND_STRENGTH
 *     bonus passively), then decrements charges. At 0, the AE deletes.
 *   - Net effect: Support Magic applied to an ally adds BOND_STRENGTH
 *     to their next Check, then consumes itself.
 *
 * Scope:
 *   1. The Support Magic master item's embedded AE template.
 *   2. Actor-borne Support Magic SKILL ITEMS (their embedded AE
 *      template, which gets stamped when the GM applies the skill).
 *   3. Any LIVE Support Magic AE already applied to an actor.
 *
 * IDEMPOTENT: re-runs no-op when the reactionConfig blob is already
 * present + the legacy flag is already cleared.
 */

export const key = "2026-05-29-support-magic-ae-reaction-config";
export const description =
  "Support Magic AE: add canonical reactionConfig + charges flags for " +
  "AE-bound trigger consume-on-Check; drop legacy consume_on_check hint.";

const SKILL_NAME = "Support Magic";
const AE_NAME    = "Support Magic";
const FLAG_NS    = "fabula-ultima-companion";

const REACTION_CONFIG = {
  reaction_config_table: {
    "0": {
      reaction_trigger: "creature_performs_check",
      reaction_source: "self",
      reaction_isPassive: true,
      reaction_passive_mode: "on",
      reaction_effect_ref: "",
    },
  },
  effect_table: {},
};

function aeNeedsUpdate(ae) {
  const f = ae?.flags?.[FLAG_NS] ?? {};
  if (!f.reactionConfig) return true;
  if (f.charges == null || f.chargesMax == null) return true;
  if (f.consume_on_check === true) return true;  // legacy hint still present
  return false;
}

async function applyAeFlagPatch(ae, ownerLabel, log) {
  if (!aeNeedsUpdate(ae)) {
    log(`  ${ownerLabel} / AE "${ae.name}": already canon`);
    return false;
  }
  try {
    await ae.update({
      [`flags.${FLAG_NS}.charges`]: 1,
      [`flags.${FLAG_NS}.chargesMax`]: 1,
      [`flags.${FLAG_NS}.chargeKey`]: "support-magic",
      [`flags.${FLAG_NS}.reactionConfig`]: REACTION_CONFIG,
      // Clear the legacy hint — never read by the director engine.
      [`flags.${FLAG_NS}.-=consume_on_check`]: null,
    });
    log(`  ${ownerLabel} / AE "${ae.name}": updated`);
    return true;
  } catch (e) {
    log(`  ${ownerLabel} / AE "${ae.name}": update failed: ${e?.message ?? e}`);
    return false;
  }
}

export async function migrate(game, log) {
  let updated = 0;

  // 1. World master items named "Support Magic" → walk embedded AEs.
  for (const item of game.items?.contents ?? []) {
    if (item.name !== SKILL_NAME) continue;
    for (const ae of item.effects?.contents ?? []) {
      if (ae.name !== AE_NAME) continue;
      if (await applyAeFlagPatch(ae, `world master "${item.name}"`, log)) updated += 1;
    }
  }

  // 2. Actor-borne Support Magic SKILL ITEMS' embedded AE templates.
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== SKILL_NAME) continue;
      for (const ae of item.effects?.contents ?? []) {
        if (ae.name !== AE_NAME) continue;
        if (await applyAeFlagPatch(ae, `actor "${actor.name}" / skill "${item.name}"`, log)) updated += 1;
      }
    }
  }

  // 3. LIVE Support Magic AEs already applied to actors (rare — would
  //    only exist if the GM cast Support Magic recently).
  for (const actor of game.actors?.contents ?? []) {
    for (const ae of actor.effects?.contents ?? []) {
      if (ae.name !== AE_NAME) continue;
      if (await applyAeFlagPatch(ae, `actor "${actor.name}" (live AE)`, log)) updated += 1;
    }
  }

  return {
    applied: true,
    summary: `updated ${updated} Support Magic AE(s)`,
  };
}
