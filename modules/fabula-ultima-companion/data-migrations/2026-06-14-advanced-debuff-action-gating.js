/**
 * Migration: 2026-06-14-advanced-debuff-action-gating
 * ---------------------------------------------------------------------------
 * Wire the homebrew "action-gating" Advanced Debuffs onto the generic engine
 * knob (snapshot.getBlockedActionLabels → Octopath menu grey-out + red stamp +
 * DECLARE backstop). Each debuff = pure data: an AE `changes` marker the BD
 * reads itself (NOT a CSB-applied field), so two debuffs gating different
 * actions compose without clobbering. Mirrors the cannot_be_targeted_by /
 * cannot_target_uuids marker-change precedent.
 *
 *   disable_action      = comma-list of turn-action labels to BLOCK
 *   enable_action_only  = allow ONLY these; block every other gateable action
 *
 * Per the Journal "Advanced Debuff" framework (Keyword Repository), Basic
 * Condition stacking is NOT applied (user decision) — each debuff carries its
 * extra rule only:
 *   Frightened → disable Attack        (Journal: "cannot use the 【Attack】 Action")
 *   Silence    → disable Spell         ("cannot use the 【Spell】 Action")
 *   Confused   → disable Objective     ("cannot use the 【Objective】 Action")
 *   Disarmed   → disable Equipment     ("Disable the 【Equipment】 action")
 *   Berserk    → enable ONLY Attack    ("disable all action except 【Attack】")
 *                + ×2 outgoing damage  ("Increase all damage dealt … by 2 times")
 *
 * Berserk's ×2 reuses the proven outgoing-multiplier rail (Chomp / Cheap Shot):
 * a creature_will_deal_damage / self / force reaction → adjust_damage multiply
 * 2 outgoing, summed per-subject in computeSenderDamageBonuses. It composes
 * MULTIPLICATIVELY with any other outgoing multiply (Berserk ×2 × Chomp ×N) —
 * each is an independent op, not a write to a shared field, so no collision.
 *
 * DURATION (user 2026-06-14): all five last 3 of the AFFECTED creature's turns,
 * decrementing at the END of each of the bearer's turns — `lifetimeMode:
 * "target_turn_end"` (generic; ticked by tickDirectorAEsForBearerTurnEnd at
 * TURN_END, NOT the applier-turn-start tick) + `duration.rounds: 3`.
 *
 * Patches EVERY AE named one of the five across all world items (canonical
 * "Debuff" hub + embedded duplicates) so behaviour is identical whether a skill
 * applies the hub template or its own embedded copy. Drift-safe + idempotent in
 * effect: preserves any unrelated changes, only (re)writes the gating marker
 * (matched by key), Berserk's reactionConfig, and the duration/lifetimeMode.
 *
 * RUN ONCE (NOT manifest-tagged idempotent); patch logic is drift-safe if re-run.
 * Touches co-dev world AEs → delivery = WORLD-DATA PUSH (USER says when).
 */

export const key = "2026-06-14-advanced-debuff-action-gating";
export const description =
  "Wire action-gating Advanced Debuffs (Frightened/Silence/Confused/Disarmed/Berserk) " +
  "onto disable_action / enable_action_only AE-change markers; Berserk also gets a " +
  "creature_will_deal_damage/self/force → adjust_damage ×2 outgoing reaction. No basic-" +
  "condition stacking. Patches every matching AE (Debuff hub + embedded copies).";

const NS = "fabula-ultima-companion";

// All five last 3 of the AFFECTED creature's turns, ticking at the bearer's
// turn-end (see migration header). lifetimeMode lives in the template flags;
// duration.rounds seeds turnsRemaining at apply time.
const LIFETIME_MODE = "target_turn_end";
const DURATION_ROUNDS = 3;

// Marker-change mode mirrors Covered's cannot_be_targeted_by (OVERRIDE/0). The
// BD reads the raw change; CSB applying it to a non-field is harmless.
const CH_MODE = 5;       // CONST.ACTIVE_EFFECT_MODES.OVERRIDE
const CH_PRIORITY = 0;

// name → { gateKey, gateValue, reactionConfig? }
const GATING = {
  Frightened: { gateKey: "disable_action",     gateValue: "Attack" },
  Silence:    { gateKey: "disable_action",     gateValue: "Spell" },
  Confused:   { gateKey: "disable_action",     gateValue: "Objective" },
  Disarmed:   { gateKey: "disable_action",     gateValue: "Equipment" },
  Berserk:    {
    gateKey: "enable_action_only", gateValue: "Attack",
    reactionConfig: {
      reaction_config_table: {
        "0": {
          reaction_trigger: "creature_will_deal_damage",
          reaction_source: "self",
          reaction_passive_mode: "force",
          reaction_effect_ref: "berserk_dmg_x2",
        },
      },
      effect_table: {
        "0": {
          effect_label: "berserk_dmg_x2",
          effect_kind: "adjust_damage",
          damage_operation: "multiply",
          damage_amount: "2",
          damage_stage: "outgoing",
        },
      },
    },
  },
};
const GATE_KEYS = new Set(["disable_action", "enable_action_only"]);

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// Build the AE's desired changes array: keep everything that isn't a stale
// gating marker, then append the one canonical gating change.
function desiredChanges(existingChanges, spec) {
  const kept = (Array.isArray(existingChanges) ? existingChanges : [])
    .filter((c) => !GATE_KEYS.has(String(c?.key)));
  kept.push({ key: spec.gateKey, value: spec.gateValue, mode: CH_MODE, priority: CH_PRIORITY });
  return kept;
}

export async function migrate(game, log = () => {}) {
  let changed = 0;
  let patchedAEs = 0;

  for (const item of (game.items?.contents ?? [])) {
    for (const ae of item.effects) {
      const spec = GATING[String(ae.name).trim()];
      if (!spec) continue;

      const update = {};
      const cur = ae.toObject();

      const wantChanges = desiredChanges(cur.changes, spec);
      if (!deepEqual(cur.changes ?? [], wantChanges)) update.changes = wantChanges;

      if (spec.reactionConfig) {
        const curRc = cur.flags?.[NS]?.reactionConfig ?? null;
        if (!deepEqual(curRc, spec.reactionConfig)) {
          update[`flags.${NS}.reactionConfig`] = spec.reactionConfig;
        }
      }

      // Duration: 3 of the affected creature's turns, ticked at bearer turn-end.
      if (cur.flags?.[NS]?.lifetimeMode !== LIFETIME_MODE) {
        update[`flags.${NS}.lifetimeMode`] = LIFETIME_MODE;
      }
      if (Number(cur.duration?.rounds) !== DURATION_ROUNDS) {
        update["duration.rounds"] = DURATION_ROUNDS;
      }

      if (Object.keys(update).length) {
        await ae.update(update);
        patchedAEs++;
        changed += Object.keys(update).length;
        log(`  [${item.name}] AE "${ae.name}" → ${Object.keys(update).join(", ")}`);
      } else {
        log(`  [${item.name}] AE "${ae.name}" already canonical`);
      }
    }
  }

  return {
    applied: true,
    summary: `Action-gating debuffs wired (AEs patched: ${patchedAEs}, field-writes: ${changed})`,
  };
}
