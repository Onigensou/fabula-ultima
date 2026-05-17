/**
 * Migration: 2026-05-17-acceleration-ae-flags
 * ---------------------------------------------------------------------------
 * Ships Acceleration's AE-borne reaction config to worlds that don't have it.
 *
 * Acceleration is a Spell that, when cast, applies an ActiveEffect to a
 * target ally. That AE carries the flag namespace the rest of the system
 * reads at runtime:
 *
 *   flags.fabula-ultima-companion.charges          (2)
 *   flags.fabula-ultima-companion.chargesMax       (2)
 *   flags.fabula-ultima-companion.chargeKey        ("bonusAction")
 *   flags.fabula-ultima-companion.bonusActionGrant (in_turn, scene-scoped)
 *   flags.fabula-ultima-companion.reactionConfig   (pre_turn_end → open_action_menu)
 *
 * Those flags were authored locally and were never shipped to origin/main
 * because LevelDB shards don't merge cleanly across forks. This migration
 * replays the same `effect.update()` call a human author would, so worlds
 * pulled from main pick up the design on next boot.
 *
 * MATCHING POLICY: by item name "Acceleration" — UUIDs differ across worlds.
 * AE matched by name "Acceleration" inside the item, or first AE if only one.
 *
 * IDEMPOTENT: compares the current flag block to the canonical target via
 * deep-equal before writing. Safe to re-run.
 *
 * SCOPE: only touches the AE's `flags.fabula-ultima-companion.*` block. Does
 * NOT modify `changes`, `duration`, `transfer`, or other AE fields — those
 * were not in scope for this hand-off (the AE intentionally has no `changes`;
 * Acceleration grants an opportunity, not a stat modifier).
 */

export const key = "2026-05-17-acceleration-ae-flags";
export const description =
  "Backfill Acceleration's AE flags (charges + bonusActionGrant + " +
  "reactionConfig) so worlds without local edits pick up the pre_turn_end " +
  "free-action design.";

const ITEM_NAME = "Acceleration";
const AE_NAME   = "Acceleration";
const MODULE_ID = "fabula-ultima-companion";

// Canonical target state. Normalized through the AE Reactions editor schema —
// no legacy noise fields (ae_target, charge_target, mechanic_id, etc.) that
// the open_action_menu dispatcher ignores.
const TARGET_FLAGS = Object.freeze({
  charges: 2,
  chargesMax: 2,
  chargeKey: "bonusAction",
  bonusActionGrant: {
    condition: "in_turn",
    applicableTypes: ["*"],
    expiry: "scene",
    sourceLabel: "Acceleration",
    casterUuid: null
  },
  reactionConfig: {
    name: "Acceleration",
    reaction_config_table: {
      "0": {
        $deleted: false,
        reaction_trigger: "pre_turn_end",
        reaction_source: "self",
        reaction_damage_type: "",
        reaction_damage_amount: "",
        reaction_debuff_count_target: "",
        reaction_debuff_count_min: "",
        reaction_subject_kind: "",
        reaction_ownership: "",
        reaction_action_intent: "",
        reaction_effect_ref: "accel_freeact",
        reaction_isPassive: false,
        reaction_passive_target: ""
      }
    },
    reaction_effect_table: {
      "0": {
        $deleted: false,
        effect_label: "accel_freeact",
        effect_kind: "open_action_menu",
        grant_resource: "",
        grant_amount: "",
        grant_target: "self",
        ae_template_ref: "",
        ae_duplicate_mode: "replace",
        charge_key: "",
        on_empty: "abort",
        count: "1",
        target_select: "first",
        rebuild_card: true,
        chain_steps: "",
        allowed_types: "Attack,Spell",
        free_mode: true,
        max_mp_cost: "10"
      }
    }
  }
});

// Deep-equal via JSON stringify with sorted keys. Sufficient for plain-data
// flag blocks (no functions, no cycles).
function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function pickFlagSubset(flags, keys) {
  const out = {};
  for (const k of keys) {
    if (flags && Object.prototype.hasOwnProperty.call(flags, k)) {
      out[k] = flags[k];
    }
  }
  return out;
}

function findAccelerationAE(item) {
  const all = item?.effects?.contents ?? [];
  if (!all.length) return null;
  const byName = all.find(e => e?.name === AE_NAME);
  if (byName) return byName;
  if (all.length === 1) return all[0];
  return null; // ambiguous; bail rather than guess
}

export async function migrate(game, log) {
  const items = game.items?.contents ?? [];
  if (!items.length) {
    return { applied: true, summary: "no world items present; nothing to migrate" };
  }

  const candidates = items.filter(it => it.name === ITEM_NAME);
  if (!candidates.length) {
    log(`item "${ITEM_NAME}" not present in this world — recording as applied`);
    return { applied: true, summary: `no "${ITEM_NAME}" item in world; nothing to do` };
  }

  let updated = 0;
  let already = 0;
  let missingAE = 0;

  const targetKeys = Object.keys(TARGET_FLAGS);

  for (const item of candidates) {
    const eff = findAccelerationAE(item);
    if (!eff) {
      log(`item "${item.name}" [${item.id}] has no matching AE — skipping`);
      missingAE++;
      continue;
    }

    const currentFlags = eff?.flags?.[MODULE_ID] ?? {};
    const currentSubset = pickFlagSubset(currentFlags, targetKeys);

    if (deepEqual(currentSubset, TARGET_FLAGS)) {
      log(`item "${item.name}" [${item.id}] AE [${eff.id}]: already up-to-date`);
      already++;
      continue;
    }

    // Foundry's `.update()` deep-merges nested objects. Older Acceleration
    // configs carry legacy fields inside `reactionConfig.reaction_effect_table.0`
    // (ae_target, charge_target, mechanic_id, mechanic_params) that the
    // open_action_menu dispatcher ignores. A plain update would merge those
    // alongside our canonical fields, leaving the noise in place — and
    // failing idempotency on the next run. Unset the noise-prone nested
    // objects first so the subsequent set writes them fresh.
    await eff.unsetFlag(MODULE_ID, "reactionConfig");
    await eff.unsetFlag(MODULE_ID, "bonusActionGrant");

    const update = {};
    for (const k of targetKeys) {
      update[`flags.${MODULE_ID}.${k}`] = TARGET_FLAGS[k];
    }
    await eff.update(update);
    log(`item "${item.name}" [${item.id}] AE [${eff.id}]: updated`);
    updated++;
  }

  const summary =
    `${updated} updated, ${already} already-set, ${missingAE} missing AE ` +
    `(of ${candidates.length} "${ITEM_NAME}" item${candidates.length === 1 ? "" : "s"})`;

  return { applied: true, summary };
}
