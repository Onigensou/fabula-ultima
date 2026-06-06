/**
 * Migration: 2026-06-06-burn-status-tick
 * ---------------------------------------------------------------------------
 * Wires the "Burn" common status AE to tick: at the START OF THE BEARER'S
 * TURN it takes 10% of its Max HP as FIRE damage (affinity-aware), then a
 * Burn charge is consumed; at 0 charges the Burn AE removes itself.
 *
 * MECHANICS (all declarative — no per-skill JS):
 *   • Trigger `turn_start` + `reaction_source: "self"` → fires only on the
 *     bearer's own turn (the standalone dispatcher's `restrictTo` + the
 *     turn-actor `sourceActorUuid` scope it to that one creature).
 *   • `reaction_passive_mode: "force"` → engine-mandatory, auto-fires silently
 *     (no menu, not a toggleable passive).
 *   • Effect: `deal_damage` (NEW effect_kind — routes through
 *     FUCompanion.api.applyDamage so Fire VU/RS/IM/AB apply) for
 *     `MAX_HP * 0.1` (floored, per-target resolver = the victim's Max HP).
 *   • Charge consumption is AUTOMATIC: firePreAcceptedCandidate decrements 1
 *     charge after any charge-bearing AE reaction fires and auto-deletes at 0
 *     (skill-effects.js post-fire bookkeeping). So we do NOT add an explicit
 *     consume_charge row — that would double-consume (Burn would vanish in one
 *     tick instead of lasting `charges` turns).
 *   • Stacking = charges. The applying skill sets the count via
 *     `ae_initial_charges` + `ae_duplicate_mode: "add_charges"`; the preset
 *     carries `chargeKey: "burn"` so clones + consume_charge line up, and a
 *     master default of 1 covers a bare application.
 *
 * Definitional fields (chargeKey + reactionConfig) are synced to the master
 * AND every applied copy via the common-AE author helper, so Burns already in
 * play start ticking. The per-instance `charges` count is NOT touched on
 * copies (their current stacks are preserved); only the master gets the
 * default-1 so future bare applications work.
 *
 * Requires the `deal_damage` effect_kind (skill-effects.js). IDEMPOTENT.
 */

import { authorCommonAe } from "./_common-ae-author.js";

export const key = "2026-06-06-burn-status-tick";
export const description =
  "Burn status: at the bearer's turn start, take 10% Max HP as Fire damage " +
  "(affinity-aware), then consume a Burn charge; removed at 0.";

const NS = "fabula-ultima-companion";

const REACTION_CONFIG = {
  reaction_config_table: {
    "0": {
      reaction_trigger: "turn_start",
      reaction_source: "self",
      reaction_effect_ref: "burn_dmg",
      reaction_isPassive: true,
      reaction_passive_mode: "force",
      reaction_passive_target: "self",
    },
  },
  effect_table: {
    // Charge is consumed automatically post-fire (see header) — no consume_charge row.
    "0": {
      effect_label: "burn_dmg",
      effect_kind: "deal_damage",
      damage_element: "fire",
      damage_amount: "MAX_HP * 0.1",
      target_ref: "self",
      damage_verbosity: "full",
    },
  },
};

export async function migrate(game, log) {
  // 1. Definitional fields on the master + every applied copy (so live Burns
  //    start ticking). Does NOT touch per-instance `charges`.
  const r = await authorCommonAe(
    game,
    {
      name: "Burn",
      patch: {
        [`flags.${NS}.chargeKey`]: "burn",
        [`flags.${NS}.reactionConfig`]: REACTION_CONFIG,
      },
      // reactionConfig is object-valued — clear before set so stale rows from a
      // prior shape don't deep-merge in.
      clearFirst: [`flags.${NS}.reactionConfig`],
      syncCopies: true,
    },
    log
  );

  // 2. Master-only default charge of 1 (a bare application = 1 stack; skills
  //    that apply Burn override via ae_initial_charges). Applied copies keep
  //    their current stacks — never clobbered here.
  let masterCharged = 0;
  for (const it of game.items?.contents ?? []) {
    if (it.type !== "activeEffectContainer") continue;
    for (const ae of it.effects?.contents ?? []) {
      if (ae.name !== "Burn") continue;
      if (Number(ae.flags?.[NS]?.charges ?? 0) !== 1) {
        await ae.update({ [`flags.${NS}.charges`]: 1 });
        masterCharged += 1;
      }
    }
  }

  return {
    applied: true,
    summary:
      `Burn tick wired — masters:${r.masters} actorCopies:${r.actorCopies} ` +
      `itemCopies:${r.itemCopies} tokenCopies:${r.tokenCopies} skipped:${r.skipped}; ` +
      `master default-charge set on ${masterCharged}.`,
  };
}
